import { createHash } from 'node:crypto';
import { reviewedTableRowId } from './reviewed-table-source';
import {
  parseRegistryTableMappingDecision,
  type RegistryTableMappingDecision,
  type RegistryTableReviewCandidate,
} from '../../shared/benchling-registry-table-review';
import type { SourceRelationship } from '../../shared/benchling-migration';
import { classifyLimsEntityFieldIssues } from '../../shared/lims';
import {
  isExactProviderStableId,
  providerObjectClassForStableId,
} from '../../shared/provider-object-reference';
import { localBundleProvenanceUrn } from './native-export-decoder';
import {
  readNativeExportArchiveEntries,
  readNativeExportArchiveEntryPreview,
  type ValidatedNativeExportArchive,
} from './native-export-archive';
import {
  parseRegistryDelimitedTable,
  readLocalRegistryTableSchemas,
  REGISTRY_TABLE_MAX_ENTRY_BYTES,
  REGISTRY_TABLE_MAX_TOTAL_BYTES,
  convertRegistryCell,
  type RegistryTableRow,
} from './registry-table-input';

export async function surveyRegistryTableReviews(
  archive: ValidatedNativeExportArchive
): Promise<readonly RegistryTableReviewCandidate[]> {
  const schemas = await readLocalRegistryTableSchemas(archive);
  const paths = archive.entries
    .filter(
      (entry) => !entry.isDirectory && /\.(csv|tsv)$/iu.test(entry.path) && !schemas.has(entry.path)
    )
    .map((entry) => entry.path)
    .sort();
  if (paths.length === 0) return [];
  if (paths.length > 100)
    throw new Error('Registry table review supports at most 100 tables per ZIP.');
  let captureBytes = 0;
  let previewBytes = 0;
  const candidates: RegistryTableReviewCandidate[] = [];
  for (const entryPath of paths) {
    const entry = archive.entries.find((entry) => entry.path === entryPath)!;
    const canCapture =
      entry.uncompressedSize <= REGISTRY_TABLE_MAX_ENTRY_BYTES &&
      captureBytes + entry.uncompressedSize <= REGISTRY_TABLE_MAX_TOTAL_BYTES;
    const preview = await readNativeExportArchiveEntryPreview(
      archive,
      entryPath,
      canCapture ? Math.max(1, entry.uncompressedSize) : 1
    );
    const bytes = preview.bytes;
    const source = {
      archiveSha256: archive.sha256.replace(/^sha256:/u, ''),
      entryPath,
      entrySha256: preview.evidence.sha256.replace(/^sha256:/u, ''),
      entrySizeBytes: preview.evidence.actualSize,
    };
    if (!canCapture) {
      candidates.push({
        ...source,
        status: 'unavailable',
        reason:
          'This table exceeds the record-conversion size limit. Keep it in the original ZIP, or split it into smaller exports.',
      });
      continue;
    }
    captureBytes += bytes.byteLength;
    try {
      const table = parseRegistryDelimitedTable(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        /\.tsv$/iu.test(entryPath) ? '\t' : ','
      );
      const previewRows = table.rows
        .slice(0, 3)
        .map((row) => row.map((cell) => (cell.length > 160 ? `${cell.slice(0, 159)}…` : cell)));
      const headers = table.headers.map((header) =>
        header.length > 512 ? `${header.slice(0, 511)}…` : header
      );
      previewBytes += Buffer.byteLength(JSON.stringify({ headers, previewRows }));
      if (previewBytes > 1024 * 1024)
        throw new Error(
          'This export exceeds the table preview limit. Keep this table in the original ZIP, or import it separately.'
        );
      candidates.push({
        ...source,
        status: 'ready',
        headers,
        headersSha256: createHash('sha256').update(JSON.stringify(table.headers)).digest('hex'),
        rowCount: table.rows.length,
        previewRows,
      });
    } catch (error) {
      candidates.push({
        ...source,
        status: 'unavailable',
        reason: error instanceof Error ? error.message : 'This table could not be read.',
      });
    }
  }
  return candidates;
}

export async function readReviewedRegistryTableRows({
  archive,
  decisions,
  actionId,
}: {
  archive: ValidatedNativeExportArchive;
  decisions: readonly RegistryTableMappingDecision[];
  actionId: string;
}): Promise<readonly RegistryTableRow[]> {
  const candidates = await surveyRegistryTableReviews(archive);
  const byPath = new Map<string, RegistryTableMappingDecision>();
  for (const raw of decisions) {
    const decision = parseRegistryTableMappingDecision(raw);
    if (decision.source.archiveSha256 !== archive.sha256.replace(/^sha256:/u, ''))
      throw new Error('Registry table review does not match this ZIP. Select the ZIP again.');
    if (byPath.has(decision.source.entryPath))
      throw new Error('Registry table has duplicate reviewed mappings.');
    byPath.set(decision.source.entryPath, decision);
  }
  if (byPath.size !== candidates.length)
    throw new Error('Review every registry table before importing.');
  const selected: Array<{
    candidate: Extract<RegistryTableReviewCandidate, { status: 'ready' }>;
    decision: RegistryTableMappingDecision & {
      outcome: Extract<RegistryTableMappingDecision['outcome'], { kind: 'records' }>;
    };
  }> = [];
  for (const candidate of candidates) {
    const decision = byPath.get(candidate.entryPath);
    if (
      !decision ||
      decision.source.entrySha256 !== candidate.entrySha256 ||
      decision.source.entrySizeBytes !== candidate.entrySizeBytes
    )
      throw new Error('Registry table source changed after review. Select the ZIP again.');
    if (decision.outcome.kind === 'source_only') continue;
    if (candidate.status !== 'ready')
      throw new Error('This registry table can only be retained as source.');
    if (
      decision.outcome.headersSha256 !== candidate.headersSha256 ||
      decision.outcome.rowCount !== candidate.rowCount ||
      decision.outcome.columns.length !== candidate.headers.length
    )
      throw new Error('Registry table columns or rows changed after review.');
    selected.push({ candidate, decision: { ...decision, outcome: decision.outcome } });
  }
  if (!selected.length) return [];
  const entries = await readNativeExportArchiveEntries(
    archive,
    selected.map(({ candidate }) => candidate.entryPath),
    REGISTRY_TABLE_MAX_ENTRY_BYTES,
    REGISTRY_TABLE_MAX_TOTAL_BYTES
  );
  const result: RegistryTableRow[] = [];
  const identities = new Set<string>();
  let resultBytes = 0;
  for (const { candidate, decision } of selected) {
    const bytes = entries.get(candidate.entryPath);
    if (
      !bytes ||
      digest(bytes) !== candidate.entrySha256 ||
      bytes.byteLength !== candidate.entrySizeBytes
    )
      throw new Error('Registry table changed while reading its reviewed rows.');
    const table = parseRegistryDelimitedTable(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      /\.tsv$/iu.test(candidate.entryPath) ? '\t' : ','
    );
    const fields = decision.outcome.columns.flatMap((column, index) =>
      column.kind === 'field'
        ? [
            {
              sourceFieldId: `column-${index + 1}`,
              definition: { key: `column_${index + 1}`, label: column.label, type: column.type },
            },
          ]
        : []
    );
    const schema = {
      sourceSchemaId: `local-table-schema-${digest(candidate.entryPath).slice(0, 24)}`,
      sourceRevisionId: `local-table-revision-${digest(JSON.stringify(fields)).slice(0, 24)}`,
      name: 'reviewed_table_record',
      displayName:
        candidate.entryPath
          .split('/')
          .pop()
          ?.replace(/\.(csv|tsv)$/iu, '') || 'Imported record',
      fields,
    };
    const nameIndex = decision.outcome.columns.findIndex((column) => column.kind === 'name');
    const providerIndex = decision.outcome.columns.findIndex(
      (column) => column.kind === 'provider_id'
    );
    for (const [index, cells] of table.rows.entries()) {
      const rowOrdinal = index + 1;
      const name = cells[nameIndex]?.trim();
      if (!name) throw new Error(`Registry table row ${rowOrdinal} has no Name value.`);
      const id =
        providerIndex < 0
          ? reviewedTableRowId(candidate.entryPath, candidate.entrySha256, rowOrdinal)
          : cells[providerIndex].trim();
      if (
        providerIndex >= 0 &&
        (!isExactProviderStableId(id) || providerObjectClassForStableId(id) !== 'registry_entity')
      )
        throw new Error(
          `Registry table row ${rowOrdinal} does not contain a valid Benchling registry ID.`
        );
      if (identities.has(id))
        throw new Error('Registry table rows contain duplicate record identities.');
      identities.add(id);
      const fieldValues: Record<string, unknown> = {};
      const relationships: SourceRelationship[] = [];
      const relationshipFields: Array<{
        fieldKey: string;
        sourceRelationshipId: string;
        sourceTargetId: string;
      }> = [];
      for (const [columnIndex, column] of decision.outcome.columns.entries()) {
        if (column.kind !== 'field') continue;
        const value = cells[columnIndex];
        const key = `column_${columnIndex + 1}`;
        if (value === '' && column.type !== 'text' && column.type !== 'long_text') {
          fieldValues[key] = null;
          continue;
        }
        if (column.type === 'record_relationship') {
          const target = value.trim();
          if (!isExactProviderStableId(target) || providerObjectClassForStableId(target) === null)
            throw new Error(
              `Registry table row ${rowOrdinal}, column ${columnIndex + 1} requires an exact Benchling target ID.`
            );
          const relationshipId = `registry:${id}:column-${columnIndex + 1}`;
          relationships.push({
            id: relationshipId,
            sourceObjectId: id,
            targetSourceId: target,
            relationType: key,
            direction: 'outbound',
            evidence: [{ kind: 'stable_id', value: target, sourcePath: candidate.entryPath }],
          });
          relationshipFields.push({
            fieldKey: key,
            sourceRelationshipId: relationshipId,
            sourceTargetId: target,
          });
        } else
          fieldValues[key] = convertRegistryCell(value, {
            key,
            label: column.label,
            type: column.type,
          });
      }
      const issues = classifyLimsEntityFieldIssues(
        schema.name,
        fieldValues,
        fields.map(({ definition }) => definition)
      );
      if (issues.malformed.length)
        throw new Error(`Registry table row ${rowOrdinal}: ${issues.malformed.join('; ')}`);
      const row: RegistryTableRow = {
        entryPath: candidate.entryPath,
        sourceObject: {
          id,
          stableId: id,
          sourceType: 'registry_record',
          schemaId: schema.sourceSchemaId,
          name,
          aliases: [],
          sourceUrl: localBundleProvenanceUrn(archive.sha256, id),
          sourcePath: candidate.entryPath,
          attachmentHashes: [],
          memberships: [],
          relationships,
          metadata: {
            nativeExport: {
              decoderVersion: 'benchling-reviewed-table.v1',
              contentFamily: 'registry',
              archiveSha256: archive.sha256,
              entryPath: candidate.entryPath,
              entrySha256: candidate.entrySha256,
              entrySizeBytes: candidate.entrySizeBytes,
              identityMethod:
                providerIndex < 0 ? 'reviewed_local_table_row' : 'explicit_registry_row_id',
              sourceUrlMethod: 'local_export_provenance_urn',
              localBundleProvenance: {
                schema: 'dnaforge.benchling.local-native-export-authority.v1',
                logicalFilename: archive.logicalFilename,
                sha256: archive.sha256,
              },
            },
            benchlingRegistry: {
              version: 1,
              inputAuthority: 'reviewed_local_table',
              schemaRevision: schema,
              fieldValues,
              relationshipFields,
              reviewedTable: { actionId, rowOrdinal, headers: table.headers, cells, decision },
              sourceSchemaDefinition: schema,
              incomplete: issues.incomplete,
            },
          },
          content: { fieldValues, originalRow: { headers: table.headers, cells } },
        },
      };
      resultBytes += Buffer.byteLength(JSON.stringify(row));
      if (resultBytes > 64 * 1024 * 1024 || result.length >= 20000)
        throw new Error(
          'Reviewed registry records exceed the import size limit. Split this table into smaller exports.'
        );
      result.push(row);
    }
  }
  return result;
}

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
