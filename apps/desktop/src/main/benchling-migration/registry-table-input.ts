import { createHash } from 'node:crypto';
import path from 'node:path';

import type { SourceObject, SourceRelationship } from '../../shared/benchling-migration';
import {
  LIMS_FIELD_TYPES,
  classifyLimsEntityFieldIssues,
  type LimsFieldDefinition,
  type LimsFieldType,
} from '../../shared/lims';
import {
  isExactProviderStableId,
  providerObjectClassForStableId,
} from '../../shared/provider-object-reference';
import { isSafeWorkspaceRelativePath } from '../../shared/path-boundary';
import { parseUniqueJson } from '../../shared/unique-json';
import { localBundleProvenanceUrn } from './native-export-decoder';
import {
  readNativeExportArchiveEntries,
  type ValidatedNativeExportArchive,
} from './native-export-archive';

export const REGISTRY_TABLE_MAX_ENTRY_BYTES = 16 * 1024 * 1024;
export const REGISTRY_TABLE_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_ROWS = 20_000;
const SCHEMA = 'benchling.registry-schema.v1';

type RegistryField = Readonly<{
  sourceFieldId: string;
  definition: LimsFieldDefinition;
  rules?: Record<string, unknown>;
}>;

export type RegistrySchemaDefinition = Readonly<{
  sourceSchemaId: string;
  sourceRevisionId: string;
  sourceRevisionNumber?: number | string;
  name: string;
  displayName: string;
  fields: readonly RegistryField[];
}>;

type RegistryTableSchema = RegistrySchemaDefinition &
  Readonly<{
    recordPaths: readonly string[];
    sourcePath: string;
    sourceSha256: string;
    original: Record<string, unknown>;
  }>;

export type RegistryTableRow = Readonly<{
  entryPath: string;
  sourceObject: SourceObject;
}>;

export async function readLocalRegistryTableRows(
  archive: ValidatedNativeExportArchive
): Promise<readonly RegistryTableRow[]> {
  const tableOwners = await readLocalRegistryTableSchemas(archive);
  if (tableOwners.size === 0) return [];
  const tableBytes = await readNativeExportArchiveEntries(
    archive,
    [...tableOwners.keys()],
    REGISTRY_TABLE_MAX_ENTRY_BYTES,
    REGISTRY_TABLE_MAX_TOTAL_BYTES
  );
  return registryRowsFromTables(archive, tableOwners, tableBytes);
}

export async function readLocalRegistryTableSchemas(
  archive: ValidatedNativeExportArchive
): Promise<ReadonlyMap<string, RegistryTableSchema>> {
  const schemaPaths = archive.entries
    .filter(
      (entry) => !entry.isDirectory && /(^|\/)(schema|[^/]+\.schema)\.json$/iu.test(entry.path)
    )
    .map((entry) => entry.path);
  if (schemaPaths.length === 0) return new Map();
  const schemaBytes = await readNativeExportArchiveEntries(
    archive,
    schemaPaths,
    REGISTRY_TABLE_MAX_ENTRY_BYTES,
    REGISTRY_TABLE_MAX_TOTAL_BYTES
  );
  const tableOwners = new Map<string, RegistryTableSchema>();
  for (const [sourcePath, bytes] of schemaBytes) {
    const text = decodeText(bytes);
    let raw: unknown;
    try {
      raw = parseRegistryJson(text);
    } catch (error) {
      if (!text.includes(SCHEMA)) continue;
      throw error;
    }
    if (!isRecord(raw) || raw.schema !== SCHEMA) continue;
    const schema = parseSchema(raw, sourcePath, digest(bytes));
    for (const tablePath of schema.recordPaths) {
      if (!isSafeWorkspaceRelativePath(tablePath) || !/\.(csv|tsv|json|jsonl)$/iu.test(tablePath)) {
        throw new Error(`Registry schema names an unsupported table path: ${tablePath}`);
      }
      if (tableOwners.has(tablePath))
        throw new Error(`Registry table has multiple schema mappings: ${tablePath}`);
      tableOwners.set(tablePath, schema);
    }
  }
  return tableOwners;
}

function registryRowsFromTables(
  archive: ValidatedNativeExportArchive,
  tableOwners: ReadonlyMap<string, RegistryTableSchema>,
  tableBytes: ReadonlyMap<string, Uint8Array>
): readonly RegistryTableRow[] {
  const result: RegistryTableRow[] = [];
  for (const [entryPath, bytes] of tableBytes) {
    const schema = tableOwners.get(entryPath);
    if (!schema) throw new Error('Registry table lost its schema mapping.');
    const rows = parseRegistryTable(decodeText(bytes), path.posix.extname(entryPath).toLowerCase());
    const entrySha256 = digest(bytes);
    for (const [index, row] of rows.entries()) {
      const id = textCell(row, ['objectid', 'benchlingid', 'entityid', 'id']);
      if (
        !isExactProviderStableId(id) ||
        providerObjectClassForStableId(id) !== 'registry_entity'
      ) {
        throw new Error(
          `Registry table ${entryPath}, row ${index + 1} has no supported exact registry object ID.`
        );
      }
      const name = textCell(row, ['name', 'displayname', 'label']);
      if (!name) throw new Error(`Registry record ${id} has no name.`);
      const registryId = textCell(row, ['registryid', 'registryidentifier']);
      const fields: Record<string, unknown> = {};
      const mappedColumns = new Set<string>();
      const relationships: SourceRelationship[] = [];
      const relationshipFields: Array<{
        fieldKey: string;
        sourceRelationshipId: string;
        sourceTargetId: string;
      }> = [];
      for (const field of schema.fields) {
        const value = mappedCell(row, field, mappedColumns);
        if (value === null || value === undefined || value === '') continue;
        if (field.definition.type === 'record_relationship') {
          if (!isExactProviderStableId(value) || providerObjectClassForStableId(value) === null) {
            throw new Error(
              `Registry record ${id}, field ${field.definition.key} requires an exact target ID.`
            );
          }
          const relationshipId = `registry:${id}:${field.sourceFieldId}`;
          relationships.push({
            id: relationshipId,
            sourceObjectId: id,
            targetSourceId: value,
            relationType: field.definition.key,
            direction: 'outbound',
            evidence: [{ kind: 'stable_id', value, sourcePath: entryPath }],
          });
          relationshipFields.push({
            fieldKey: field.definition.key,
            sourceRelationshipId: relationshipId,
            sourceTargetId: value,
          });
          continue;
        }
        fields[field.definition.key] = convertRegistryCell(value, field.definition);
      }
      const issues = classifyLimsEntityFieldIssues(
        schema.name,
        fields,
        schema.fields.map((field) => field.definition)
      );
      if (issues.malformed.length)
        throw new Error(`Registry record ${id}: ${issues.malformed.join('; ')}`);
      result.push({
        entryPath,
        sourceObject: {
          id,
          stableId: id,
          sourceType: 'registry_record',
          schemaId: schema.sourceSchemaId,
          name,
          ...(registryId ? { registryId } : {}),
          aliases: [],
          sourceUrl: localBundleProvenanceUrn(archive.sha256, id),
          sourcePath: entryPath,
          attachmentHashes: [],
          memberships: [],
          relationships,
          metadata: {
            nativeExport: {
              decoderVersion: 'benchling-registry-table.v1',
              contentFamily: 'registry',
              archiveSha256: archive.sha256,
              entryPath,
              entrySha256,
              entrySizeBytes: bytes.byteLength,
              identityMethod: 'explicit_registry_row_id',
              sourceUrlMethod: 'local_export_provenance_urn',
              registryData: {
                sourceRow: {
                  entryPath,
                  entrySha256,
                  row: index + 1,
                  schemaPath: schema.sourcePath,
                  schemaSha256: schema.sourceSha256,
                },
                originalSchema: schema.original,
              },
              localBundleProvenance: {
                schema: 'dnaforge.benchling.local-native-export-authority.v1',
                logicalFilename: archive.logicalFilename,
                sha256: archive.sha256,
              },
            },
            benchlingRegistry: {
              version: 1,
              inputAuthority: 'dnaforge_normalized_input',
              schemaRevision: {
                sourceSchemaId: schema.sourceSchemaId,
                sourceRevisionId: schema.sourceRevisionId,
                ...(schema.sourceRevisionNumber === undefined
                  ? {}
                  : { sourceRevisionNumber: schema.sourceRevisionNumber }),
                name: schema.name,
                displayName: schema.displayName,
                fields: schema.fields,
              },
              fieldValues: fields,
              relationshipFields,
              sourceSchemaDefinition: Object.fromEntries(
                Object.entries(schema.original).filter(([key]) => key !== 'recordPaths')
              ),
              incomplete: issues.incomplete,
            },
          },
          content: { fieldValues: fields, originalRow: row },
        },
      });
      if (result.length > MAX_ROWS) throw new Error(`Registry import exceeds ${MAX_ROWS} rows.`);
    }
  }
  return result;
}

function parseSchema(
  raw: Record<string, unknown>,
  sourcePath: string,
  sourceSha256: string
): RegistryTableSchema {
  const definition = parseRegistrySchemaDefinition(raw);
  if (definition.fields.length === 0)
    throw new Error('A normalized registry table schema requires at least one field.');
  return {
    ...definition,
    recordPaths: textArray(raw.recordPaths, 'record paths'),
    sourcePath,
    sourceSha256,
    original: raw,
  };
}

export function parseRegistrySchemaDefinition(
  raw: Record<string, unknown>
): RegistrySchemaDefinition {
  if (!Array.isArray(raw.fields) || raw.fields.length > 1_000)
    throw new Error('Registry schema must have at most 1000 fields.');
  const keys = new Set<string>();
  const sourceIds = new Set<string>();
  const fields = raw.fields.map((value): RegistryField => {
    if (!isRecord(value) || !isRecord(value.definition))
      throw new Error('Registry field definition is invalid.');
    const sourceFieldId = requiredText(value.sourceFieldId, 'field ID');
    const rawDefinition = value.definition;
    const key = requiredText(rawDefinition.key, 'field key');
    if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(key) || keys.has(key) || sourceIds.has(sourceFieldId))
      throw new Error(`Registry field identity is invalid or duplicated: ${key}`);
    keys.add(key);
    sourceIds.add(sourceFieldId);
    if (!isFieldType(rawDefinition.type))
      throw new Error(
        `Registry field ${key} has unsupported type ${String(rawDefinition.type)}. Original schema remains in the ZIP.`
      );
    const definition: LimsFieldDefinition = {
      key,
      label: requiredText(rawDefinition.label, 'field label'),
      type: rawDefinition.type,
    };
    for (const flag of ['required', 'suggested', 'requireResolved'] as const) {
      if (rawDefinition[flag] !== undefined) {
        if (typeof rawDefinition[flag] !== 'boolean')
          throw new Error(`Registry field ${key} has invalid ${flag}.`);
        definition[flag] = rawDefinition[flag];
      }
    }
    for (const constraint of ['maxLength', 'minValue', 'maxValue'] as const) {
      const value = rawDefinition[constraint];
      if (value !== undefined) {
        if (typeof value !== 'number' || !Number.isFinite(value))
          throw new Error(`Registry field ${key} has invalid ${constraint}.`);
        definition[constraint] = value;
      }
    }
    for (const constraint of ['minDate', 'maxDate', 'description'] as const) {
      if (rawDefinition[constraint] !== undefined)
        definition[constraint] = requiredText(rawDefinition[constraint], constraint);
    }
    if (rawDefinition.enumOptions !== undefined)
      definition.enumOptions = textArray(rawDefinition.enumOptions, 'enum options');
    if (definition.type === 'enum' && !definition.enumOptions?.length)
      throw new Error(`Registry enum ${key} has no options.`);
    if (
      definition.minValue !== undefined &&
      definition.maxValue !== undefined &&
      definition.minValue > definition.maxValue
    )
      throw new Error(`Registry field ${key} has inverted limits.`);
    if (value.rules !== undefined && !isRecord(value.rules))
      throw new Error(`Registry field ${key} has invalid source rules.`);
    return { sourceFieldId, definition, ...(isRecord(value.rules) ? { rules: value.rules } : {}) };
  });
  const revisionNumber = raw.sourceRevisionNumber;
  if (
    revisionNumber !== undefined &&
    typeof revisionNumber !== 'number' &&
    typeof revisionNumber !== 'string'
  )
    throw new Error('Registry schema revision number is invalid.');
  return {
    sourceSchemaId: requiredText(raw.sourceSchemaId, 'schema ID'),
    sourceRevisionId: requiredText(raw.sourceRevisionId, 'schema revision ID'),
    ...(revisionNumber === undefined ? {} : { sourceRevisionNumber: revisionNumber }),
    name: requiredText(raw.name, 'schema name'),
    displayName: requiredText(raw.displayName, 'schema display name'),
    fields,
  };
}

export function parseRegistryTable(text: string, extension: string): Record<string, unknown>[] {
  if (extension === '.csv' || extension === '.tsv')
    return parseDelimitedRows(text, extension === '.tsv' ? '\t' : ',');
  const parsed: unknown =
    extension === '.jsonl'
      ? text
          .split(/\r?\n/u)
          .filter((line) => line.trim())
          .map((line) => parseRegistryJson(line))
      : parseRegistryJson(text);
  const rows = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.records)
      ? parsed.records
      : [parsed];
  if (rows.length > MAX_ROWS || !rows.every(isRecord))
    throw new Error('Registry table contains invalid rows.');
  return rows;
}

function parseDelimitedRows(text: string, delimiter: string): Record<string, unknown>[] {
  const parsed = parseRegistryDelimitedTable(text, delimiter);
  const headers = parsed.headers.map((value) => value.trim());
  if (headers.some((header) => !normalizeColumn(header)))
    throw new Error('Registry table has an empty header.');
  if (new Set(headers.map(normalizeColumn)).size !== headers.length)
    throw new Error('Registry table has duplicate or ambiguous headers.');
  return parsed.rows.map((values) =>
    Object.fromEntries(headers.map((header, column) => [header, values[column]]))
  );
}

export function parseRegistryDelimitedTable(
  text: string,
  delimiter: string
): { headers: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let state: 'plain' | 'quoted' | 'closed' = 'plain';
  const finishCell = (): void => {
    if (row.length >= 1000) throw new Error('Registry table exceeds 1000 columns.');
    row.push(cell);
    cell = '';
    state = 'plain';
  };
  const finishRow = (): void => {
    const explicit = row.length > 0 || cell !== '' || state === 'closed';
    finishCell();
    if (explicit) rows.push(row);
    row = [];
    if (rows.length > MAX_ROWS + 1) throw new Error('Registry table has too many rows.');
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (state === 'quoted') {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else state = 'closed';
      } else cell += char;
    } else if (char === delimiter) finishCell();
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      finishRow();
    } else if (char === '"' && state === 'plain' && cell === '') state = 'quoted';
    else {
      if (state === 'closed' || char === '"')
        throw new Error('Registry table has invalid CSV quoting.');
      cell += char;
    }
  }
  if (state === 'quoted') throw new Error('Registry table has an unterminated quoted cell.');
  if (cell !== '' || row.length || state === 'closed') finishRow();
  const headers = rows
    .shift()
    ?.map((value, index) => (index === 0 ? value.replace(/^\uFEFF/u, '') : value));
  if (!headers?.length) throw new Error('Registry table has an empty header.');
  rows.forEach((values, index) => {
    if (values.length !== headers.length)
      throw new Error(
        `Registry table row ${index + 1} has ${values.length} cells; expected ${headers.length}.`
      );
  });
  return { headers, rows };
}

function mappedCell(
  row: Record<string, unknown>,
  field: RegistryField,
  mappedColumns: Set<string>
): unknown {
  const columns = new Set(
    [field.definition.key, field.definition.label, field.sourceFieldId].map(normalizeColumn)
  );
  const matches = Object.entries(row).filter(([key]) => columns.has(normalizeColumn(key)));
  if (matches.length > 1)
    throw new Error(`Registry field ${field.definition.key} maps to multiple columns.`);
  const column = matches[0]?.[0];
  if (column !== undefined) {
    if (mappedColumns.has(column))
      throw new Error(`Registry column ${column} maps to multiple fields.`);
    mappedColumns.add(column);
  }
  return matches[0]?.[1];
}

function textCell(row: Record<string, unknown>, aliases: readonly string[]): string | null {
  const matches = Object.entries(row).filter(([key]) => aliases.includes(normalizeColumn(key)));
  if (matches.length > 1)
    throw new Error(
      `Registry table has ambiguous identity/name columns: ${matches.map(([key]) => key).join(', ')}`
    );
  const value = matches[0]?.[1];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function convertRegistryCell(value: unknown, field: LimsFieldDefinition): unknown {
  if (field.type === 'number') {
    if (typeof value === 'number') return checkedNumber(String(value));
    if (
      typeof value !== 'string' ||
      !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(value.trim())
    )
      throw new Error(`Registry field ${field.key} has an invalid number.`);
    return checkedNumber(value.trim());
  }
  if (field.type === 'boolean' && typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new Error(`Registry field ${field.key} requires true or false.`);
  }
  if (field.type === 'date' && !isCalendarDate(value))
    throw new Error(`Registry field ${field.key} requires an ISO date.`);
  if (
    [
      'string_array',
      'quantity',
      'formula_result',
      'attachment_reference',
      'dna_sequence',
      'rna_sequence',
      'protein_sequence',
    ].includes(field.type)
  ) {
    const parsed = typeof value === 'string' ? parseRegistryJson(value) : value;
    if (
      field.type === 'attachment_reference' ||
      (['dna_sequence', 'rna_sequence', 'protein_sequence'].includes(field.type) &&
        (!isRecord(parsed) || parsed.mode !== 'inline'))
    ) {
      throw new Error(
        `Registry field ${field.key} requires a verified source attachment; native file references are not accepted from source data.`
      );
    }
    return parsed;
  }
  return value;
}

function parseRegistryJson(text: string): unknown {
  return parseUniqueJson(text, { numberReader: checkedNumber });
}

function checkedNumber(text: string): number {
  const value = Number(text);
  if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
    throw new Error('Registry number exceeds the supported precision or range.');
  if (value === 0 && /[1-9]/u.test(text.split(/[eE]/u)[0] ?? ''))
    throw new Error('Registry number would underflow to zero.');
  if (decimalIdentity(text) !== decimalIdentity(String(value)))
    throw new Error('Registry number would lose decimal precision.');
  return value;
}

function decimalIdentity(text: string): string {
  const [mantissa = '', exponent = '0'] = text.toLowerCase().split('e');
  const unsigned = mantissa.replace(/^[+-]/u, '');
  const fractionLength = unsigned.includes('.') ? unsigned.length - unsigned.indexOf('.') - 1 : 0;
  const digits = unsigned.replace('.', '').replace(/^0+/u, '');
  if (!digits) return '0';
  const significant = digits.replace(/0+$/u, '');
  return `${mantissa.startsWith('-') ? '-' : ''}${significant}e${Number(exponent) - fractionLength + digits.length - significant.length}`;
}

function isCalendarDate(value: unknown): boolean {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)?$/u.test(value)
  )
    return false;
  const date = new Date(value);
  return (
    Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 19) ===
      (value.length === 10 ? `${value}T00:00:00` : value.slice(0, 19))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isFieldType(value: unknown): value is LimsFieldType {
  return LIMS_FIELD_TYPES.some((type) => type === value);
}
function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Registry ${label} is missing.`);
  return value.trim();
}
function textArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.length)
    throw new Error(`Registry ${label} must be non-empty.`);
  const result = value.map((item) => requiredText(item, label));
  if (new Set(result).size !== result.length)
    throw new Error(`Registry ${label} contains duplicates.`);
  return result;
}
function normalizeColumn(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, '');
}
function digest(value: Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
function decodeText(value: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(value);
}
