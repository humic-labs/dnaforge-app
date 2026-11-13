import { withUserMessage } from '@waypoint/user-messages';
import { computeChecksum } from '@waypoint/sequence-utils';
import { parseFasta } from '@waypoint/plasmid-viewer/parsers';
import * as XLSX from 'xlsx';
import { parseTextSequenceFileAsAnnotated } from '../parse-sequence-file';
import { parseIdtOligoNotation } from '../primer-artifacts/oligo-modifications';
import { buildInlineRnaSequenceRef } from './rna-sequence';
import {
  buildInlineProteinSequenceRef,
  normalizeProteinSequence,
  proteinSequenceValidationError,
} from './protein-sequence-value';
import {
  isRegisterableOpenSequenceKind,
  type RegisterableOpenSequenceKind,
} from './open-sequence-kind';
import { detectHeaderRow } from './header-detection';
import { boundedSheetRange, triageWorkbook } from './workbook-triage';
import { accessionKeysForEntityFields } from './accession-identity';
import {
  extractGenotypeRelationships,
  extractSourceRelationships,
  type ExtractedEdge,
} from './genotype-grammar';
import {
  attachStubsToPlan,
  buildProvisionalStubRecords,
  collectUnresolvedEndpoints,
} from './import-stub-plan';
import {
  classifyLimsEntityFieldIssues,
  deriveImportedSequenceName,
  DNA_SEQUENCE_MAX_INLINE_BASES,
  LIMS_BUILTIN_ENTITY_SCHEMAS,
  limsKindRequiresResolvedSequence,
  normalizeInlineDnaSequenceRef,
  type DnaSequenceSourceFormat,
  type LimsApplyImportBatchInput,
  type LimsApplyImportBatchResult,
  type LimsEntity,
  type LimsEntityKind,
  type LimsImportColumnMappingMode,
  type LimsImportColumnMappingOverride,
  type LimsImportPlan,
  type LimsImportPlanColumn,
  type LimsImportPlanDetectedKind,
  type LimsImportPlanMappingConfidence,
  type LimsImportPlanRecord,
  type LimsImportLinkPreview,
  type LimsImportOracleResult,
  type LimsImportRecord,
  type LimsImportUnresolvedLink,
  type LimsQueryEntitiesInput,
  type LimsFieldDefinition,
  type SheetDisposition,
} from '../lims';
import {
  MANAGED_SEQUENCE_CONTENT_FIELD,
  readManagedSequenceContentSummary,
} from '../managed-sequence-document';

export type LimsSourceKind = 'csv' | 'tsv' | 'xlsx' | 'genbank' | 'fasta';

export interface InspectLimsSourceInput {
  fileName: string;
  sourcePath?: string;
  text?: string;
  arrayBuffer?: ArrayBuffer;

  sheetName?: string;

  headerRowOverride?: number;

  hasHeader?: boolean;
}

export interface InspectLimsSourceResult {
  sourceKind: LimsSourceKind;
  sourceName: string;
  recordCount: number;
  columns: string[];
  tainted: true;
  warnings: string[];

  sheetDispositions?: SheetDisposition[];

  selectedSheet?: string;
}

export interface DryRunLimsImportInput extends InspectLimsSourceInput {
  importFamily?: string;
  externalRowKeyColumn?: string;
  defaultKind?: LimsEntityKind;

  forcedKind?: string;
  columnMappings?: readonly LimsImportColumnMappingOverride[];
  schemaFields?: readonly LimsFieldDefinition[];
  schemaRevisionId?: string;
}

export interface DryRunLimsImportResult extends InspectLimsSourceResult {
  records: LimsImportRecord[];
  oracle: LimsImportOracleResult;
}

export interface LimsImportPlannerDependencies {
  queryEntities(input: LimsQueryEntitiesInput): Promise<LimsEntity[]>;
  applyBatch(
    input: LimsApplyImportBatchInput,
    mutationToken?: string
  ): Promise<LimsApplyImportBatchResult>;
}

type DelimitedRow = {
  rowNumber: number;
  values: Record<string, string>;
};

const DNA_TEXT = /^[ACGTRYSWKMBDHVN\s*]+$/i;
const NUCLEIC_ACID_TEXT = /^[ACGTURYSWKMBDHVN\s*]+$/i;

function isOligoKind(kind: string): kind is 'oligo' | 'rna_oligo' {
  return kind === 'oligo' || kind === 'rna_oligo';
}

export interface LimsImportMappingTargetOption {
  value: string;
  label: string;
  group: 'record' | 'oligo' | 'strain' | 'link';
}

export const SEQUENCE_FILE_REGISTRATION_KIND_REQUIRED_ERROR =
  'Choose the DNA sequence import type.';

const SEQUENCE_FILE_REGISTRATION_KIND_INCOMPATIBLE_ERROR =
  'Sequence files must be imported as DNA sequences.';

const SEQUENCE_FILE_DEFAULT_KIND: RegisterableOpenSequenceKind = 'sequence';

export const LIMS_IMPORT_MAPPING_TARGET_OPTIONS: readonly LimsImportMappingTargetOption[] = [
  { value: 'entity.name', label: 'Record name', group: 'record' },
  { value: 'entity.kind', label: 'Record type', group: 'record' },
  { value: 'fields.sequence', label: 'DNA / oligo sequence', group: 'record' },
  { value: 'fields.notes', label: 'Notes', group: 'record' },
  { value: 'fields.use', label: 'Oligo use', group: 'oligo' },
  { value: 'fields.status', label: 'Oligo status', group: 'oligo' },
  { value: 'fields.purification', label: 'Purification', group: 'oligo' },
  { value: 'fields.scale', label: 'Scale', group: 'oligo' },
  { value: 'fields.vendor', label: 'Vendor', group: 'oligo' },
  { value: 'fields.catalogNumber', label: 'Catalog number', group: 'oligo' },
  { value: 'fields.genotypeCanonical', label: 'Strain genotype', group: 'strain' },
  { value: 'fields.organismName', label: 'Organism name', group: 'strain' },
  { value: 'fields.markers', label: 'Strain markers', group: 'strain' },
  { value: 'links.associated_with.target', label: 'Associated target', group: 'link' },
  { value: 'links.associated_with.orientation', label: 'Target orientation', group: 'link' },
  { value: 'links.associated_with.bindingStart', label: 'Binding start', group: 'link' },
  { value: 'links.associated_with.bindingEnd', label: 'Binding end', group: 'link' },
  { value: 'links.references.parent_genome', label: 'Parent genome', group: 'link' },
  {
    value: 'links.has_genome.hypothesis_supplied',
    label: 'Genome hypothesis',
    group: 'link',
  },
  { value: 'links.has_genome.WGS_verified', label: 'Verified WGS genome', group: 'link' },
  { value: 'links.carried_by.plasmid', label: 'Carried plasmid', group: 'link' },
  { value: 'links.derives_from.parent_strain', label: 'Parent strain (lineage)', group: 'link' },
  { value: 'fields.source', label: 'Source / provenance', group: 'record' },
];

export function inspectLimsSource(input: InspectLimsSourceInput): InspectLimsSourceResult {
  const text = input.text ?? '';
  const sourceKind = detectSourceKind(input.fileName, text);
  if (sourceKind === 'xlsx') {
    const parsed = parseWorkbook(input);
    return {
      sourceKind,
      sourceName: input.fileName,
      recordCount: parsed.rows.length,
      columns: parsed.headers,
      tainted: true,
      warnings: parsed.warnings,
      sheetDispositions: parsed.sheetDispositions,
      selectedSheet: parsed.selectedSheet,
    };
  }
  if (sourceKind === 'csv' || sourceKind === 'tsv') {
    const parsed = parseDelimited(text, resolveDelimiter(text, sourceKind), input.hasHeader);
    return {
      sourceKind,
      sourceName: input.fileName,
      recordCount: parsed.rows.length,
      columns: parsed.headers,
      tainted: true,
      warnings: parsed.warnings,
    };
  }
  return {
    sourceKind,
    sourceName: input.fileName,
    recordCount:
      sourceKind === 'genbank' || sourceKind === 'fasta'
        ? countSequenceRecords(text, sourceKind)
        : text.trim()
          ? 1
          : 0,
    columns: [],
    tainted: true,
    warnings: [],
  };
}

export async function dryRunLimsImport(
  input: DryRunLimsImportInput,
  dependencies: LimsImportPlannerDependencies
): Promise<DryRunLimsImportResult> {
  const inspected = inspectLimsSource(input);
  let records: LimsImportRecord[] = [];

  if (inspected.sourceKind === 'csv' || inspected.sourceKind === 'tsv') {
    records = await recordsFromDelimitedSource(input, inspected.sourceKind);
  } else if (inspected.sourceKind === 'xlsx') {
    records = await recordsFromWorkbookSource(input);
  } else {
    records = await recordsFromSequenceSource(input, inspected.sourceKind);
  }

  if (input.externalRowKeyColumn !== undefined) {
    if (
      !['csv', 'tsv', 'xlsx'].includes(inspected.sourceKind) ||
      !inspected.columns.includes(input.externalRowKeyColumn)
    )
      throw new Error('The selected spreadsheet stable-key column is missing.');
    const keyColumn = input.externalRowKeyColumn;
    const keys = new Set<string>();
    records = records.map((record) => {
      const value = record.source[keyColumn];
      if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value)))
        throw new Error('Every spreadsheet row needs a nonempty stable key.');
      const key = String(value);
      if (!key || key.trim() !== key)
        throw new Error(
          'Every spreadsheet row needs a nonempty stable key without surrounding whitespace.'
        );
      if (keys.has(key))
        throw withUserMessage(
          new Error(`Spreadsheet row key is duplicated: ${key}`),
          'registry.duplicateRowKey'
        );
      keys.add(key);
      return { ...record, externalRowId: key };
    });
  }
  records = await markDuplicates(records, dependencies);
  const oracle = evaluateImportAccuracyOracle(input.fileName, inspected.sourceKind, records);
  return {
    ...inspected,
    records,
    oracle,
  };
}

function batchNamesOfRecords(
  records: readonly { accepted: boolean; entity: { name: string } }[]
): Set<string> {
  return new Set(
    records
      .filter((record) => record.accepted)
      .map((record) => record.entity.name.trim().toLowerCase())
      .filter((name) => name.length > 0)
  );
}

export async function createLimsImportPlan(
  input: DryRunLimsImportInput,
  dependencies: LimsImportPlannerDependencies
): Promise<LimsImportPlan> {
  const preview = await dryRunLimsImport(input, dependencies);

  const batchNames = batchNamesOfRecords(preview.records);
  const records = await Promise.all(
    preview.records.map((record) => importPlanRecord(record, batchNames, dependencies))
  );
  return {
    id: `import-plan:${preview.sourceKind}:${preview.sourceName}:${records.length}`,
    sourceName: preview.sourceName,
    sourceKind: preview.sourceKind,
    detectedKind: detectImportPlanKind(preview.sourceKind, records),
    columns: createImportPlanColumns(
      preview.columns,
      input.columnMappings,
      [],
      input.forcedKind,
      input.schemaFields
    ),
    records,
    aggregateWarnings: preview.warnings,
    defaultKind: input.defaultKind,
    forcedKind: input.forcedKind,
    schemaFields: input.schemaFields,
    schemaRevisionId: input.schemaRevisionId,
    importFamily: input.importFamily,
    canApply: canApplyImportPlan(records),
    oracle: preview.oracle,
    sheetDispositions: preview.sheetDispositions,
    selectedSheet: preview.selectedSheet,
  };
}

export async function attachProvisionalStubsToImportPlan(
  plan: LimsImportPlan,
  dependencies: LimsImportPlannerDependencies
): Promise<LimsImportPlan> {
  const asRecords: LimsImportRecord[] = plan.records.map((record) => ({
    id: record.id,
    action: 'register_entity',
    accepted: record.accepted && record.action === 'create',
    entity: record.entityDraft,
    links: record.proposedLinks,
    sourceRow: record.sourceRow,
    source: record.source,
    duplicateOf: record.duplicateCandidates[0]?.entityId ?? null,
    unresolvedLinks: record.unresolvedLinks,
    errors: blockingImportRecordErrors(record),
    warnings: record.warnings,
  }));
  const stubbable = asRecords.map((record) => ({
    ...record,
    unresolvedLinks: (record.unresolvedLinks ?? []).filter(
      (link) => link.severity === 'provisional_stub'
    ),
  }));
  const endpoints = collectUnresolvedEndpoints(stubbable);
  if (endpoints.length === 0) return plan;

  const stubs = buildProvisionalStubRecords(endpoints).map((stub) =>
    stub.entity.kind === 'strain'
      ? {
          ...stub,
          entity: {
            ...stub.entity,
            fields: { ...stub.entity.fields, genotypeCanonical: 'unknown (provisional stub)' },
          },
        }
      : stub
  );
  const combined = attachStubsToPlan(asRecords, stubs);
  const batchNames = batchNamesOfRecords(combined);
  const planRecords = await Promise.all(
    combined.map((record) => importPlanRecord(record, batchNames, dependencies))
  );
  return { ...plan, records: planRecords, canApply: canApplyImportPlan(planRecords) };
}

export interface LimsImportFileProvenance {
  managedRelPath: string;

  workspaceRootPath: string;
}

export async function applyAcceptedLimsImportPlan(
  plan: LimsImportPlan,
  options: {
    actor?: string | null;
    batchId?: string;
    fileProvenance?: LimsImportFileProvenance;
    mutationToken?: string;
  } = {},
  dependencies: LimsImportPlannerDependencies
): Promise<LimsApplyImportBatchResult> {
  if (!plan.canApply) {
    throw new Error('Cannot apply LIMS import plan with errors or unresolved accepted links.');
  }

  const batchMemberNames = new Set(
    plan.records
      .filter((record) => record.accepted && record.action === 'create')
      .map((record) => record.entityDraft.name.trim().toLowerCase())
      .filter((name) => name.length > 0)
  );
  const linkApplies = (link: LimsImportLinkPreview): boolean => {
    if (link.suggested) return false;
    if (isResolvedImportLink(link)) return true;
    const from = link.fromEntityLookup?.name.trim().toLowerCase();
    const to = link.toEntityLookup?.name.trim().toLowerCase();
    const fromOk = !link.fromEntityLookup || (from != null && batchMemberNames.has(from));
    const toOk = !link.toEntityLookup || (to != null && batchMemberNames.has(to));
    return fromOk && toOk;
  };
  const request: LimsApplyImportBatchInput = {
    batchId: options.batchId,
    sourceName: plan.sourceName,
    sourceKind: plan.sourceKind,
    records: plan.records.map((record) => ({
      id: record.id,
      action: 'register_entity',
      accepted: record.accepted && record.action === 'create',
      entity: record.entityDraft,
      links: record.proposedLinks.filter(linkApplies),
      sourceRow: record.sourceRow,

      source: options.fileProvenance
        ? { ...record.source, ...options.fileProvenance }
        : record.source,
      duplicateOf: record.duplicateCandidates[0]?.entityId ?? null,
      duplicateName: record.duplicateCandidates[0]?.name ?? null,
      duplicateReason: record.duplicateCandidates[0]?.reason ?? null,
      unresolvedLinks: record.unresolvedLinks,
      errors: blockingImportRecordErrors(record),
    })),
    actor: options.actor,
    oracle: plan.oracle,
  };
  return dependencies.applyBatch(request, options.mutationToken);
}

export function setImportRecordAccepted(
  preview: DryRunLimsImportResult,
  recordId: string,
  accepted: boolean
): DryRunLimsImportResult {
  const records = preview.records.map((record) =>
    record.id === recordId ? { ...record, accepted } : record
  );
  return {
    ...preview,
    records,
    oracle: evaluateImportAccuracyOracle(preview.sourceName, preview.sourceKind, records),
  };
}

export function setImportPlanRecordAccepted(
  plan: LimsImportPlan,
  recordId: string,
  accepted: boolean
): LimsImportPlan {
  const records: LimsImportPlanRecord[] = plan.records.map((record) =>
    record.id === recordId ? { ...record, accepted, action: accepted ? 'create' : 'skip' } : record
  );
  return {
    ...plan,
    records,
    canApply: canApplyImportPlan(records),
    oracle: evaluateImportAccuracyOracle(
      plan.sourceName,
      plan.sourceKind === 'mixed' ? 'csv' : plan.sourceKind,
      records.map(importRecordFromPlanRecord)
    ),
  };
}

export function setImportPlanRecordsAccepted(
  plan: LimsImportPlan,
  recordIds: readonly string[],
  accepted: boolean
): LimsImportPlan {
  const targets = new Set(recordIds);
  const records: LimsImportPlanRecord[] = plan.records.map((record) =>
    targets.has(record.id) ? { ...record, accepted, action: accepted ? 'create' : 'skip' } : record
  );
  return {
    ...plan,
    records,
    canApply: canApplyImportPlan(records),
    oracle: evaluateImportAccuracyOracle(
      plan.sourceName,
      plan.sourceKind === 'mixed' ? 'csv' : plan.sourceKind,
      records.map(importRecordFromPlanRecord)
    ),
  };
}

export async function applyImportPlanColumnMappings(
  plan: LimsImportPlan,
  mappings: readonly LimsImportColumnMappingOverride[],
  defaultConfidence: LimsImportPlanMappingConfidence = 'user_overridden',
  dependencies: LimsImportPlannerDependencies
): Promise<LimsImportPlan> {
  const columns = createImportPlanColumns(
    plan.columns.map((column) => column.sourceColumn),
    mappings.map((mapping) => ({
      ...mapping,
      confidence: mapping.confidence ?? defaultConfidence,
    })),
    plan.columns,
    plan.forcedKind,
    plan.schemaFields
  );
  return rematerializeImportPlan(plan, columns, dependencies);
}

export async function applyImportPlanRecordKind(
  plan: LimsImportPlan,
  recordId: string,
  kind: RegisterableOpenSequenceKind,
  dependencies: LimsImportPlannerDependencies
): Promise<LimsImportPlan> {
  if (!isRegisterableOpenSequenceKind(kind)) {
    throw new Error(SEQUENCE_FILE_REGISTRATION_KIND_INCOMPATIBLE_ERROR);
  }
  const records = plan.records.map((record) => {
    if (record.id !== recordId) return importRecordFromPlanRecord(record);

    const errors = record.errors.filter(
      (error) => error !== SEQUENCE_FILE_REGISTRATION_KIND_REQUIRED_ERROR
    );
    return importRecordFromPlanRecord({
      ...record,
      accepted: errors.length === 0,
      action: errors.length === 0 ? 'create' : 'skip',
      requiresRegistrationKind: false,
      errors,
      entityDraft: {
        ...record.entityDraft,
        kind,
      },
    });
  });
  const deduped = await markDuplicates(records, dependencies);
  const planRecords = await Promise.all(
    deduped.map((record) => importPlanRecord(record, undefined, dependencies))
  );
  return {
    ...plan,
    records: planRecords,
    detectedKind: detectImportPlanKind(
      plan.sourceKind === 'mixed' ? 'csv' : plan.sourceKind,
      planRecords
    ),
    canApply: canApplyImportPlan(planRecords),
    oracle: evaluateImportAccuracyOracle(
      plan.sourceName,
      plan.sourceKind === 'mixed' ? 'csv' : plan.sourceKind,
      planRecords.map(importRecordFromPlanRecord)
    ),
  };
}

export interface LimsAgentImportPlanContext {
  sourceName: string;
  sourceKind: LimsImportPlan['sourceKind'];
  detectedKind: LimsImportPlanDetectedKind;
  columns: Array<{
    sourceColumn: string;
    mappedField?: string;
    mappingMode: LimsImportColumnMappingMode;
    sampleValues: string[];
  }>;
  targetOptions: readonly LimsImportMappingTargetOption[];
}

export function describeLimsImportPlanForAgent(plan: LimsImportPlan): LimsAgentImportPlanContext {
  return {
    sourceName: plan.sourceName,
    sourceKind: plan.sourceKind,
    detectedKind: plan.detectedKind,
    columns: plan.columns.map((column) => ({
      sourceColumn: column.sourceColumn,
      mappedField: column.mappedField,
      mappingMode: column.mappingMode,
      sampleValues: sampleValuesForSourceColumn(plan, column.sourceColumn, 5),
    })),
    targetOptions: LIMS_IMPORT_MAPPING_TARGET_OPTIONS,
  };
}

async function recordsFromDelimitedSource(
  input: DryRunLimsImportInput,
  sourceKind: 'csv' | 'tsv'
): Promise<LimsImportRecord[]> {
  const parsed = parseDelimited(
    input.text ?? '',
    resolveDelimiter(input.text ?? '', sourceKind),
    input.hasHeader,
    input.externalRowKeyColumn
  );
  const columns = createImportPlanColumns(
    parsed.headers,
    input.columnMappings,
    [],
    input.forcedKind,
    input.schemaFields
  );
  return recordsFromRows(input, parsed.rows, columns);
}

async function recordsFromWorkbookSource(
  input: DryRunLimsImportInput
): Promise<LimsImportRecord[]> {
  const parsed = parseWorkbook(input, input.externalRowKeyColumn);
  const columns = createImportPlanColumns(
    parsed.headers,
    input.columnMappings,
    [],
    input.forcedKind,
    input.schemaFields
  );
  return recordsFromRows(input, parsed.rows, columns);
}

const LINEAGE_LINK_TYPES: ReadonlySet<string> = new Set(['derives_from', 'has_part', 'part_of']);

const HANGING_RELATIONSHIP_LINK_TYPES: ReadonlySet<string> = new Set(['carried_by']);

async function importPlanRecord(
  record: LimsImportRecord,
  batchNames: ReadonlySet<string> | undefined,
  dependencies: LimsImportPlannerDependencies
): Promise<LimsImportPlanRecord> {
  const { links, unresolvedLinks } = await resolveImportPlanLinks(
    record.links ?? [],
    batchNames,
    dependencies
  );
  const duplicateCandidates = record.duplicateOf
    ? [
        {
          entityId: record.duplicateOf,
          name: record.duplicateName ?? record.duplicateOf,
          reason:
            record.duplicateReason ??
            'Existing registry record has the same name or sequence identity.',
        },
      ]
    : [];
  return {
    id: record.id,
    sourceRow: record.sourceRow,
    externalRowId: record.externalRowId,
    sequenceNotation: record.sequenceNotation,
    accepted: record.accepted,
    action: record.accepted ? 'create' : 'skip',
    entityDraft: record.entity,
    requiresRegistrationKind: record.requiresRegistrationKind,
    suggestedKind: record.suggestedKind,
    kindEvidence: record.kindEvidence,
    duplicateCandidates,
    proposedLinks: links,
    unresolvedLinks,
    errors: record.errors ?? [],
    warnings: record.warnings ?? [],
    source: record.source,
  };
}

async function resolveImportPlanLinks(
  links: readonly LimsImportLinkPreview[],
  batchNames: ReadonlySet<string> | undefined,
  dependencies: LimsImportPlannerDependencies
): Promise<{
  links: LimsImportLinkPreview[];
  unresolvedLinks: LimsImportUnresolvedLink[];
}> {
  const resolved: LimsImportLinkPreview[] = [];
  const unresolvedLinks: LimsImportUnresolvedLink[] = [];
  for (const link of links) {
    const from = link.fromEntityLookup
      ? await resolveImportEndpoint(
          link.type,
          'source',
          link.fromEntityLookup,
          batchNames,
          link.suggested,
          dependencies
        )
      : { id: link.fromEntityId ?? null, unresolved: null };
    const to = link.toEntityLookup
      ? await resolveImportEndpoint(
          link.type,
          'target',
          link.toEntityLookup,
          batchNames,
          link.suggested,
          dependencies
        )
      : { id: link.toEntityId ?? null, unresolved: null };

    if (from.unresolved) unresolvedLinks.push(from.unresolved);
    if (to.unresolved) unresolvedLinks.push(to.unresolved);
    resolved.push({
      ...link,
      fromEntityId: from.id ?? link.fromEntityId,
      fromEntityLookup: from.id ? undefined : link.fromEntityLookup,
      toEntityId: to.id ?? link.toEntityId,
      toEntityLookup: to.id ? undefined : link.toEntityLookup,
    });
  }
  return { links: resolved, unresolvedLinks };
}

async function resolveImportEndpoint(
  type: string,
  role: 'source' | 'target',
  lookup: { kind?: string; name: string },
  batchNames: ReadonlySet<string> | undefined,
  suggested: boolean | undefined,
  dependencies: LimsImportPlannerDependencies
): Promise<{ id: string | null; unresolved: LimsImportUnresolvedLink | null }> {
  if (batchNames && batchNames.has(lookup.name.trim().toLowerCase())) {
    return { id: null, unresolved: null };
  }

  const candidates = await dependencies.queryEntities({
    kind: lookup.kind,
    nameLike: lookup.name,
    limit: 200,
  });
  const exact = candidates.filter(
    (candidate) => candidate.name.trim().toLowerCase() === lookup.name.trim().toLowerCase()
  );
  if (exact.length === 1) return { id: exact[0].id, unresolved: null };

  if (suggested) return { id: null, unresolved: null };
  const typeLabel = importRelationshipLabel(type);

  const severity =
    type === 'associated_with'
      ? 'advisory'
      : exact.length >= 2
        ? 'ambiguous'
        : LINEAGE_LINK_TYPES.has(type) && exact.length === 0
          ? 'provisional_stub'
          : HANGING_RELATIONSHIP_LINK_TYPES.has(type)
            ? 'advisory'
            : 'blocking';
  return {
    id: null,
    unresolved: {
      label: lookup.name,
      kind: lookup.kind,
      type,
      severity,
      ...(exact.length >= 2 ? { candidateEntityIds: exact.map((e) => e.id) } : {}),
      reason:
        exact.length === 0
          ? `No exact registry match for ${typeLabel} ${role}.`
          : `${exact.length} registry records share the name "${lookup.name}" — pick one to connect the ${typeLabel} ${role}.`,
    },
  };
}

function importRelationshipLabel(type: string): string {
  if (type === 'associated_with') return 'associated';
  return type.replace(/[_-]+/g, ' ');
}

function detectImportPlanKind(
  sourceKind: LimsSourceKind,
  records: readonly LimsImportPlanRecord[]
): LimsImportPlanDetectedKind {
  if (sourceKind === 'genbank' || sourceKind === 'fasta') return 'sequence_file';
  if (records.length > 0 && records.every((record) => record.entityDraft.kind === 'strain')) {
    return 'strain_table';
  }
  if (records.length > 0 && records.every((record) => isOligoKind(record.entityDraft.kind))) {
    return 'primer_table';
  }
  return 'mixed_table';
}

function createImportPlanColumns(
  columns: readonly string[],
  overrides: readonly LimsImportColumnMappingOverride[] | undefined,
  previousColumns: readonly LimsImportPlanColumn[] = [],
  forcedKind?: string,
  schemaFields?: readonly LimsFieldDefinition[]
): LimsImportPlanColumn[] {
  const previousByKey = new Map(
    previousColumns.map((column) => [normalizeSourceColumnKey(column.sourceColumn), column])
  );
  const overrideByKey = new Map(
    (overrides ?? []).map((override) => [normalizeSourceColumnKey(override.sourceColumn), override])
  );
  const planColumns = columns.map((sourceColumn) => {
    const key = normalizeSourceColumnKey(sourceColumn);
    const previous = previousByKey.get(key);
    const deterministicMappedField = mappedFieldForColumn(sourceColumn, forcedKind);
    const override = overrideByKey.get(key);
    const requestedMappedField =
      override && override.mappingMode !== 'source_only' && override.mappingMode !== 'ignored'
        ? override.mappedField
        : override
          ? undefined
          : (previous?.mappedField ?? deterministicMappedField);
    const unsupportedMappedField =
      requestedMappedField && !isSupportedImportMappingTarget(requestedMappedField, schemaFields)
        ? requestedMappedField
        : undefined;
    const mappedField = unsupportedMappedField ? undefined : requestedMappedField;
    const mappingMode: LimsImportColumnMappingMode = unsupportedMappedField
      ? 'source_only'
      : (override?.mappingMode ??
        (mappedField ? 'mapped' : previous?.mappingMode === 'ignored' ? 'ignored' : 'source_only'));
    return {
      sourceColumn,
      mappedField: mappingMode === 'mapped' ? mappedField : undefined,
      mappingMode,
      confidence:
        override?.confidence ??
        (override ? 'user_overridden' : undefined) ??
        previous?.confidence ??
        (deterministicMappedField ? 'deterministic' : 'user_overridden'),
      warnings: unsupportedMappedField
        ? [`Unsupported mapping target "${unsupportedMappedField}" was ignored.`]
        : [],
    };
  });

  const claimedBy = new Map<string, { sourceColumn: string; userOverridden: boolean }>();
  for (const column of planColumns) {
    if (column.mappingMode !== 'mapped' || !column.mappedField) continue;
    const isUserOverride = column.confidence === 'user_overridden';
    const existing = claimedBy.get(column.mappedField);
    if (!existing) {
      claimedBy.set(column.mappedField, {
        sourceColumn: column.sourceColumn,
        userOverridden: isUserOverride,
      });
      continue;
    }
    if (existing.userOverridden || isUserOverride) continue;
    column.warnings = [
      ...column.warnings,
      `Both "${existing.sourceColumn}" and "${column.sourceColumn}" map to ${importMappingTargetLabel(
        column.mappedField
      )}; keeping "${existing.sourceColumn}".`,
    ];
    column.mappingMode = 'source_only';
    column.mappedField = undefined;
  }
  return planColumns;
}

function isSupportedImportMappingTarget(
  value: string,
  schemaFields?: readonly LimsFieldDefinition[]
): boolean {
  if (LIMS_IMPORT_MAPPING_TARGET_OPTIONS.some((option) => option.value === value)) return true;

  if (value.startsWith('fields.')) {
    const key = value.slice('fields.'.length);
    if (schemaFields?.some((field) => field.key === key)) return true;
    return LIMS_BUILTIN_ENTITY_SCHEMAS.some((schema) =>
      schema.fields.some((field) => field.key === key)
    );
  }
  return false;
}

function importMappingTargetLabel(value: string): string {
  return (
    LIMS_IMPORT_MAPPING_TARGET_OPTIONS.find((option) => option.value === value)?.label ?? value
  );
}

function mappedFieldForColumn(sourceColumn: string, forcedKind?: string): string | undefined {
  const lower = normalizeSourceColumnKey(sourceColumn);
  if (
    [
      'name',
      'strain',
      'strain name',
      'strain id',
      'plasmid name',
      'primer name',
      'primer id',
      'oligo name',
      'sequence name',
      'id',
    ].includes(lower)
  ) {
    return 'entity.name';
  }
  if (['kind', 'type', 'entity type'].includes(lower)) return 'entity.kind';
  if (['sequence', 'seq', 'oligo sequence', 'primer sequence'].includes(lower)) {
    return 'fields.sequence';
  }
  if (['notes', 'description', 'purpose'].includes(lower)) return 'fields.notes';
  if (['target', 'template', 'template name', 'target name'].includes(lower)) {
    return 'links.associated_with.target';
  }
  if (['direction', 'orientation', 'strand'].includes(lower)) {
    return 'links.associated_with.orientation';
  }
  if (['genotype', 'genotype canonical', 'genotype_canonical'].includes(lower)) {
    return 'fields.genotypeCanonical';
  }
  if (['organism', 'organism name', 'host organism'].includes(lower)) {
    return forcedKind === 'protein' ? 'fields.organism' : 'fields.organismName';
  }
  if (forcedKind === 'protein' && ['source cds', 'source orf', 'cds', 'orf'].includes(lower)) {
    return 'fields.sourceCds';
  }

  if (
    [
      'parent strain',
      'parent_strain',
      'parent strain name',
      'derives from',
      'derived from',
    ].includes(lower)
  ) {
    return 'links.derives_from.parent_strain';
  }
  if (['source', 'origin', 'provenance'].includes(lower)) return 'fields.source';
  if (['parent genome', 'parent_genome', 'parent', 'parent genome name'].includes(lower)) {
    return 'links.references.parent_genome';
  }
  if (
    [
      'supplied hypothesis genome',
      'hypothesis genome',
      'genome hypothesis',
      'predicted genome',
      'predicted/hypothesis genome',
    ].includes(lower)
  ) {
    return 'links.has_genome.hypothesis_supplied';
  }
  if (['verified wgs genome', 'wgs genome', 'verified genome', 'wgs'].includes(lower)) {
    return 'links.has_genome.WGS_verified';
  }
  if (['plasmid carried', 'carried plasmid', 'plasmid'].includes(lower)) {
    return 'links.carried_by.plasmid';
  }
  if (['status', 'purification', 'scale', 'vendor', 'catalog number', 'catalog#'].includes(lower)) {
    return `fields.${lower.replace(/[#\s]+/g, '')}`;
  }
  return undefined;
}

export function canApplyImportPlan(records: readonly LimsImportPlanRecord[]): boolean {
  return records.some((record) => record.accepted && record.action === 'create')
    ? records
        .filter((record) => record.accepted && record.action === 'create')
        .every(
          (record) =>
            blockingImportRecordErrors(record) === undefined &&
            record.duplicateCandidates.length === 0 &&
            !record.requiresRegistrationKind
        )
    : false;
}

export async function resolveImportPlanLink(
  plan: LimsImportPlan,
  input: { recordId: string; linkIndex: number; endpoint: 'source' | 'target'; entityId: string },
  dependencies: LimsImportPlannerDependencies
): Promise<LimsImportPlan> {
  const record = plan.records.find((entry) => entry.id === input.recordId);
  const link = record?.proposedLinks[input.linkIndex];
  if (!record || !link || !Number.isSafeInteger(input.linkIndex) || input.linkIndex < 0)
    throw new Error('IMPORT_LINK_NOT_FOUND: Choose an exact link from this review.');
  const lookup = input.endpoint === 'source' ? link.fromEntityLookup : link.toEntityLookup;
  if (!lookup) throw new Error('IMPORT_LINK_ALREADY_RESOLVED: This endpoint is already exact.');
  const candidates = await dependencies.queryEntities({
    id: input.entityId,
    kind: lookup.kind,
    limit: 1,
  });
  const entity = candidates.find((entry) => entry.id === input.entityId);
  if (!entity || entity.name.trim().toLowerCase() !== lookup.name.trim().toLowerCase())
    throw new Error('IMPORT_LINK_TARGET_UNAVAILABLE: Choose a current exact candidate.');
  const links = record.proposedLinks.map((entry, index) =>
    index !== input.linkIndex
      ? entry
      : {
          ...entry,
          ...(input.endpoint === 'source'
            ? { fromEntityId: entity.id, fromEntityLookup: undefined }
            : { toEntityId: entity.id, toEntityLookup: undefined }),
        }
  );
  const resolved = await resolveImportPlanLinks(
    links,
    batchNamesOfRecords(plan.records.map(importRecordFromPlanRecord)),
    dependencies
  );
  const records = plan.records.map((entry) =>
    entry.id === record.id
      ? { ...entry, proposedLinks: resolved.links, unresolvedLinks: resolved.unresolvedLinks }
      : entry
  );
  return { ...plan, records, canApply: canApplyImportPlan(records) };
}

export async function resolveImportPlanDuplicate(
  plan: LimsImportPlan,
  input: { recordId: string; entityId: string | null },
  dependencies: LimsImportPlannerDependencies
): Promise<LimsImportPlan> {
  const record = plan.records.find((entry) => entry.id === input.recordId);
  if (!record || record.duplicateCandidates.length === 0)
    throw new Error('IMPORT_DUPLICATE_NOT_FOUND: Choose a duplicate record from this review.');
  if (input.entityId !== null) {
    if (!record.duplicateCandidates.some((entry) => entry.entityId === input.entityId))
      throw new Error('IMPORT_DUPLICATE_TARGET_INVALID: Choose a candidate from this review.');
    const candidates = await dependencies.queryEntities({
      id: input.entityId,
      kind: record.entityDraft.kind,
      limit: 1,
    });
    if (!candidates.some((entry) => entry.id === input.entityId))
      throw new Error('IMPORT_DUPLICATE_TARGET_UNAVAILABLE: The chosen record is unavailable.');
  }
  const records = plan.records.map(
    (entry): LimsImportPlanRecord =>
      entry.id === record.id
        ? {
            ...entry,
            accepted: false,
            action: 'skip',
            duplicateDecision:
              input.entityId === null
                ? { kind: 'skip' }
                : { kind: 'reuse', entityId: input.entityId },
          }
        : entry
  );
  return { ...plan, records, canApply: canApplyImportPlan(records) };
}

function importRecordFromPlanRecord(record: LimsImportPlanRecord): LimsImportRecord {
  return {
    id: record.id,
    action: 'register_entity',
    accepted: record.accepted && record.action === 'create',
    entity: record.entityDraft,
    requiresRegistrationKind: record.requiresRegistrationKind,
    links: record.proposedLinks.filter(isResolvedImportLink),
    sourceRow: record.sourceRow,
    externalRowId: record.externalRowId,
    sequenceNotation: record.sequenceNotation,
    source: record.source,
    duplicateOf: record.duplicateCandidates[0]?.entityId ?? null,
    duplicateReason: record.duplicateCandidates[0]?.reason ?? null,
    unresolvedLinks: record.unresolvedLinks,
    errors: blockingImportRecordErrors(record),
    warnings: record.warnings,
  };
}

function blockingImportRecordErrors(record: LimsImportPlanRecord): string[] | undefined {
  const blockingUnresolved = record.unresolvedLinks.filter(isBlockingUnresolvedLink);
  const errors = [
    ...record.errors,
    ...blockingUnresolved.map(
      (link) => `${link.kind ? `${link.kind} ` : ''}${link.label}: ${link.reason}`
    ),
  ];
  return errors.length > 0 ? errors : undefined;
}

function isBlockingUnresolvedLink(link: LimsImportUnresolvedLink): boolean {
  return link.severity === 'blocking';
}

function isResolvedImportLink(link: LimsImportLinkPreview): boolean {
  return !link.fromEntityLookup && !link.toEntityLookup;
}

async function rematerializeImportPlan(
  plan: LimsImportPlan,
  columns: readonly LimsImportPlanColumn[],
  dependencies: LimsImportPlannerDependencies
): Promise<LimsImportPlan> {
  const rows: DelimitedRow[] = plan.records.map((record, index) => ({
    rowNumber: record.sourceRow ?? index + 1,
    values: normalizeSourceValues(record.source),
  }));
  const records = await markDuplicates(
    await recordsFromRows(
      {
        fileName: plan.sourceName,
        defaultKind: plan.defaultKind,

        forcedKind: plan.forcedKind,
        schemaFields: plan.schemaFields,
        schemaRevisionId: plan.schemaRevisionId,
        importFamily: plan.importFamily,
      },
      rows,
      columns
    ),
    dependencies
  );
  const previousById = new Map(plan.records.map((record) => [record.id, record]));
  const planRecords = await Promise.all(
    records.map((record) => importPlanRecord(record, undefined, dependencies))
  );
  const restoredRecords = planRecords.map((record) => {
    const previous = previousById.get(record.id);
    if (!previous || previous.accepted || !isExplicitUserSkippedRecord(previous)) return record;
    return { ...record, accepted: false, action: 'skip' as const };
  });
  return {
    ...plan,
    columns: [...columns],
    records: restoredRecords,
    detectedKind: detectImportPlanKind(
      plan.sourceKind === 'mixed' ? 'csv' : plan.sourceKind,
      restoredRecords
    ),
    canApply: canApplyImportPlan(restoredRecords),
    oracle: evaluateImportAccuracyOracle(
      plan.sourceName,
      plan.sourceKind === 'mixed' ? 'csv' : plan.sourceKind,
      restoredRecords.map(importRecordFromPlanRecord)
    ),
  };
}

function isExplicitUserSkippedRecord(record: LimsImportPlanRecord): boolean {
  return (
    record.action === 'skip' &&
    !record.accepted &&
    record.errors.length === 0 &&
    record.duplicateCandidates.length === 0 &&
    record.unresolvedLinks.every((link) => !isBlockingUnresolvedLink(link))
  );
}

function normalizeSourceValues(source: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).map(([key, value]) => [
      normalizeSourceColumnKey(key),
      typeof value === 'string' ? value : value == null ? '' : String(value),
    ])
  );
}

function sampleValuesForSourceColumn(
  plan: LimsImportPlan,
  sourceColumn: string,
  limit: number
): string[] {
  const key = normalizeSourceColumnKey(sourceColumn);
  const seen = new Set<string>();
  const samples: string[] = [];
  for (const record of plan.records) {
    const value = normalizeSourceValues(record.source)[key]?.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    samples.push(value);
    if (samples.length >= limit) break;
  }
  return samples;
}

const IMPORT_INLINE_SEQUENCE_CEILING = 50_000;

async function buildImportSequenceField(
  kind: string,
  rawSequence: string
): Promise<{
  field: Record<string, unknown>;
  resolved: boolean;
  error?: string;
  warnings: string[];
}> {
  if (kind === 'protein') {
    const aminoAcids = normalizeProteinSequence(rawSequence);
    if (!aminoAcids) {
      return { field: { mode: 'unresolved' }, resolved: false, warnings: [] };
    }
    const validationError = proteinSequenceValidationError(aminoAcids);
    if (validationError) {
      return {
        field: { mode: 'unresolved' },
        resolved: false,
        error: validationError,
        warnings: [],
      };
    }
    if (aminoAcids.length > IMPORT_INLINE_SEQUENCE_CEILING) {
      return {
        field: { mode: 'unresolved' },
        resolved: false,
        warnings: [
          `Sequence is ${aminoAcids.length.toLocaleString()} residues, above the ${IMPORT_INLINE_SEQUENCE_CEILING.toLocaleString()} residue inline limit. ` +
            'The raw value is kept in source metadata; import it from a protein FASTA file to resolve.',
        ],
      };
    }
    return {
      field: await buildInlineProteinSequenceRef(aminoAcids),
      resolved: true,
      warnings: [],
    };
  }
  const orderType = kind === 'rna_oligo' ? 'rna' : 'dna';
  const parsedOligo = isOligoKind(kind) ? parseIdtOligoNotation(rawSequence, { orderType }) : null;
  const cleaned = parsedOligo ? parsedOligo.bases : rawSequence.replace(/[\s*]/g, '').toUpperCase();
  if (!cleaned) {
    return { field: { mode: 'unresolved' }, resolved: false, warnings: [] };
  }
  if (parsedOligo?.errors.length) {
    return {
      field: { mode: 'unresolved' },
      resolved: false,
      error: parsedOligo.errors.join('; '),
      warnings: [],
    };
  }
  if (!parsedOligo && !DNA_TEXT.test(cleaned)) {
    return {
      field: { mode: 'unresolved' },
      resolved: false,
      error: 'Sequence contains invalid DNA characters',
      warnings: [],
    };
  }
  const cap = isOligoKind(kind) ? DNA_SEQUENCE_MAX_INLINE_BASES : IMPORT_INLINE_SEQUENCE_CEILING;
  if (cleaned.length > cap) {
    return {
      field: { mode: 'unresolved' },
      resolved: false,
      warnings: [
        `Sequence is ${cleaned.length.toLocaleString()} bp, above the ${cap.toLocaleString()} bp inline limit. ` +
          'The raw value is kept in source metadata; import it from a sequence file to resolve.',
      ],
    };
  }
  const warnings: string[] = [];
  if (kind === 'plasmid') {
    warnings.push(
      'Stored the pasted sequence inline as linear. Import a circular sequence file to preserve plasmid topology and annotations.'
    );
  }
  return {
    field:
      kind === 'rna_oligo'
        ? await buildInlineRnaSequenceRef(cleaned)
        : {
            ...normalizeInlineDnaSequenceRef(cleaned),
            contentHash: await computeChecksum(cleaned),
          },
    resolved: true,
    warnings,
  };
}

async function recordsFromRows(
  input: DryRunLimsImportInput,
  rows: readonly DelimitedRow[],
  columns: readonly LimsImportPlanColumn[]
): Promise<LimsImportRecord[]> {
  const records: LimsImportRecord[] = [];
  for (const row of rows) {
    const kind =
      input.forcedKind ??
      normalizeKind(readMapped(row, columns, ['entity.kind'])) ??
      inferKindFromMappedRow(row, columns) ??
      input.defaultKind ??
      'oligo';
    const name = readMapped(row, columns, ['entity.name']);
    const sequence = readMapped(row, columns, ['fields.sequence']);
    const errors: string[] = [];
    const warnings: string[] = [];

    const requiresResolvedSequence = limsKindRequiresResolvedSequence(kind);

    if (!name) errors.push('Missing name');

    const fields: Record<string, unknown> = {};
    let sequenceResolved = true;
    if (sequence) {
      const built = await buildImportSequenceField(
        input.schemaFields?.find((field) => field.key === 'sequence')?.type === 'protein_sequence'
          ? 'protein'
          : (input.importFamily ?? kind),
        sequence
      );
      fields.sequence = built.field;
      sequenceResolved = built.resolved;

      if (built.error) errors.push(built.error);
      warnings.push(...built.warnings);
    } else if (requiresResolvedSequence || kind === 'genome' || kind === 'plasmid') {
      fields.sequence = { mode: 'unresolved' };
      sequenceResolved = false;
      if (requiresResolvedSequence) {
        warnings.push('No sequence yet — imported and flagged unresolved.');
      }
    }

    const schema = LIMS_BUILTIN_ENTITY_SCHEMAS.find((entry) => entry.name === kind);
    const resolvedSchemaFields = input.schemaFields ?? schema?.fields;
    const schemaFieldByKey = new Map(
      (resolvedSchemaFields ?? []).map((field) => [field.key, field])
    );
    for (const column of columns) {
      if (column.mappingMode !== 'mapped' || !column.mappedField?.startsWith('fields.')) continue;
      const key = column.mappedField.slice('fields.'.length);
      if (key === 'sequence') continue;
      const raw = readMapped(row, columns, [column.mappedField]);
      if (raw == null || raw === '') continue;
      const type = schemaFieldByKey.get(key)?.type;
      if (type === 'string_array') {
        fields[key] = raw
          .split(/[;,]/)
          .map((part) => part.trim())
          .filter(Boolean);
      } else if (type === 'number') {
        const parsed = Number(raw);
        fields[key] = Number.isFinite(parsed) ? parsed : raw;
      } else {
        fields[key] = raw;
      }
    }
    const target = readMapped(row, columns, ['links.associated_with.target']);
    const strand = normalizeStrand(readMapped(row, columns, ['links.associated_with.orientation']));
    const bindingStart = numberOrNull(
      readMapped(row, columns, ['links.associated_with.bindingStart'])
    );
    const bindingEnd = numberOrNull(readMapped(row, columns, ['links.associated_with.bindingEnd']));
    const links = buildDelimitedLinks(row, input.importFamily ?? kind, {
      columns,
      target,
      strand,
      bindingStart,
      bindingEnd,
    });

    const schemaFields = resolvedSchemaFields;
    let incompleteRequired: string[] = [];
    if (schemaFields) {
      const { malformed, incomplete } = classifyLimsEntityFieldIssues(kind, fields, schemaFields);
      errors.push(...malformed);

      incompleteRequired = incomplete;
      warnings.push(...incomplete);
    }

    records.push({
      id: `row-${row.rowNumber}`,
      action: 'register_entity',
      accepted: errors.length === 0,
      entity: {
        kind,
        name: name || `Imported row ${row.rowNumber}`,
        fields,
        registrationStatus:
          sequenceResolved && incompleteRequired.length === 0 ? 'registered' : 'unresolved',
        actor: 'local-user',
        ...(input.schemaRevisionId ? { schemaRevisionId: input.schemaRevisionId } : {}),
      },
      links,
      sourceRow: row.rowNumber,
      ...(isOligoKind(kind) && sequence ? { sequenceNotation: sequence.trim() } : {}),
      source: sourceValuesForRecord(row, columns),
      errors: errors.length > 0 ? errors : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
    });
  }
  return records;
}

function edgeToLinkPreview(edge: ExtractedEdge): LimsImportLinkPreview {
  const lookup = { kind: edge.toLookup.kind, name: edge.toLookup.name };
  const payload = { confidence: edge.confidence, sourceSpan: edge.sourceSpan };
  return edge.fromRole === 'other'
    ? { type: edge.type, fromEntityLookup: lookup, suggested: true, payload }
    : { type: edge.type, toEntityLookup: lookup, suggested: true, payload };
}

function buildDelimitedLinks(
  row: DelimitedRow,
  kind: string,
  oligo: {
    columns: readonly LimsImportPlanColumn[];
    target: string | null;
    strand: 'forward' | 'reverse' | null;
    bindingStart: number | null;
    bindingEnd: number | null;
  }
): LimsImportLinkPreview[] | undefined {
  const links: LimsImportLinkPreview[] = [];
  if (isOligoKind(kind) && oligo.target) {
    links.push({
      type: 'associated_with',
      toEntityLookup: { kind: 'plasmid', name: oligo.target },
      payload: {
        role: 'intended_target',
        orientation: oligo.strand,
        bindingStart: oligo.bindingStart,
        bindingEnd: oligo.bindingEnd,
        sourceColumn: sourceColumnForMappedField(oligo.columns, 'links.associated_with.target'),
      },
    });
  }
  if (kind === 'strain') {
    const parentGenome = readMapped(row, oligo.columns, ['links.references.parent_genome']);
    const hypothesisGenome = readMapped(row, oligo.columns, [
      'links.has_genome.hypothesis_supplied',
    ]);
    const verifiedGenome = readMapped(row, oligo.columns, ['links.has_genome.WGS_verified']);
    const plasmidCarried = readMapped(row, oligo.columns, ['links.carried_by.plasmid']);
    if (parentGenome) {
      links.push({
        type: 'references',
        toEntityLookup: { kind: 'genome', name: parentGenome },
        payload: {
          role: 'parent_genome',
          confidence: 'genotype_parent_reference',
          sourceColumn: sourceColumnForMappedField(oligo.columns, 'links.references.parent_genome'),
        },
      });
    }
    if (hypothesisGenome) {
      links.push({
        type: 'has_genome',
        toEntityLookup: { kind: 'genome', name: hypothesisGenome },
        payload: {
          confidence: 'hypothesis_supplied',
          method: 'supplied_genome_hypothesis',
          sourceColumn: sourceColumnForMappedField(
            oligo.columns,
            'links.has_genome.hypothesis_supplied'
          ),
        },
      });
    }
    if (verifiedGenome) {
      links.push({
        type: 'has_genome',
        toEntityLookup: { kind: 'genome', name: verifiedGenome },
        payload: {
          confidence: 'WGS_verified',
          method: 'WGS',
          sourceColumn: sourceColumnForMappedField(oligo.columns, 'links.has_genome.WGS_verified'),
        },
      });
    }
    if (plasmidCarried) {
      links.push({
        type: 'carried_by',
        fromEntityLookup: { kind: 'plasmid', name: plasmidCarried },
        payload: {
          role: 'carried_plasmid',
          sourceColumn: sourceColumnForMappedField(oligo.columns, 'links.carried_by.plasmid'),
        },
      });
    }

    const parentStrain = readMapped(row, oligo.columns, ['links.derives_from.parent_strain']);
    const selfName = readMapped(row, oligo.columns, ['entity.name']) ?? '';
    if (parentStrain && parentStrain.trim().toLowerCase() !== selfName.trim().toLowerCase()) {
      links.push({
        type: 'derives_from',
        toEntityLookup: { kind: 'strain', name: parentStrain },
        payload: {
          role: 'parent_strain',
          sourceColumn: sourceColumnForMappedField(
            oligo.columns,
            'links.derives_from.parent_strain'
          ),
        },
      });
    }

    const genotypeText = readMapped(row, oligo.columns, ['fields.genotypeCanonical']);
    const sourceText = readMapped(row, oligo.columns, ['fields.source']);
    const grammarEdges: ExtractedEdge[] = [
      ...(genotypeText ? extractGenotypeRelationships(genotypeText, selfName) : []),
      ...(sourceText ? extractSourceRelationships(sourceText) : []),
    ];
    for (const edge of grammarEdges) {
      links.push(edgeToLinkPreview(edge));
    }
  }
  return links.length > 0 ? links : undefined;
}

async function recordsFromSequenceSource(
  input: DryRunLimsImportInput,
  sourceKind: 'genbank' | 'fasta'
): Promise<LimsImportRecord[]> {
  if (input.forcedKind === 'protein' || input.importFamily === 'protein') {
    return sourceKind === 'fasta'
      ? recordsFromProteinFasta(input)
      : [
          {
            id: 'protein-file-1',
            action: 'register_entity',
            accepted: false,
            entity: {
              kind: 'protein',
              name: input.fileName,
              fields: { sequence: { mode: 'unresolved' } },
              registrationStatus: 'unresolved',
              actor: 'local-user',
            },
            source: { fileName: input.fileName },
            errors: [
              'Protein import accepts amino-acid FASTA, CSV, TSV, or Excel files. GenBank is a nucleic-acid format.',
            ],
          },
        ];
  }
  const text = input.text ?? '';
  try {
    const parserStem = input.fileName.replace(/\.[^.]*$/, '') || input.fileName;
    const parserFileName = `${parserStem}.${sourceKind === 'genbank' ? 'gb' : 'fasta'}`;
    const parsed = parseTextSequenceFileAsAnnotated(text, parserFileName);
    const fileContentHash = await computeChecksum(text);
    const normalizedSequenceHash = await computeChecksum(parsed.sequence.sequence.toUpperCase());

    const explicitKind =
      (isRegisterableOpenSequenceKind(input.forcedKind) ? input.forcedKind : undefined) ??
      (isRegisterableOpenSequenceKind(input.defaultKind) ? input.defaultKind : undefined);
    const kind: RegisterableOpenSequenceKind = explicitKind ?? SEQUENCE_FILE_DEFAULT_KIND;
    const requiresRegistrationKind = false;
    const sourceFormat: DnaSequenceSourceFormat = sourceKind === 'genbank' ? 'gb' : 'fasta';

    const recordCount = countSequenceRecords(text, sourceKind);
    if (recordCount > 1) {
      const formatLabel = sourceKind === 'genbank' ? 'GenBank' : 'FASTA';
      return [
        {
          id: 'sequence-file-1',
          action: 'register_entity',
          accepted: false,
          requiresRegistrationKind,
          entity: {
            kind,
            name: deriveImportedSequenceName(parsed.sequence.name, input.fileName),
            fields: { sequence: { mode: 'unresolved' } },
            registrationStatus: 'unresolved',
            actor: 'local-user',
          },
          source: {
            fileName: input.fileName,
            length: parsed.sequence.length,
            circular: parsed.sequence.circular,
            recordCount,
          },
          errors: [
            `"${input.fileName}" contains ${recordCount} sequences. Multi-record ${formatLabel} ` +
              `registration isn't supported yet — split it into single-sequence files, or import ` +
              `them individually. (Nothing was registered.)`,
          ],
        },
      ];
    }
    const durableSourcePath = input.sourcePath?.trim();

    const kindSelectionErrors =
      explicitKind || (!input.forcedKind && !input.defaultKind)
        ? []
        : [SEQUENCE_FILE_REGISTRATION_KIND_INCOMPATIBLE_ERROR];
    if (!durableSourcePath) {
      const hasContent = text.trim().length > 0 && parsed.sequence.length > 0;
      if (hasContent) {
        return [
          {
            id: 'sequence-file-1',
            action: 'register_entity',
            accepted: kindSelectionErrors.length === 0 && !requiresRegistrationKind,
            requiresRegistrationKind,
            entity: {
              kind,
              name: deriveImportedSequenceName(parsed.sequence.name, input.fileName),
              fields: {
                sequence: { mode: 'unresolved' },
                notes: parsed.sequence.description,
              },
              registrationStatus: 'unresolved',
              actor: 'local-user',
            },
            errors: kindSelectionErrors.length > 0 ? kindSelectionErrors : undefined,
            source: {
              fileName: input.fileName,
              length: parsed.sequence.length,
              circular: parsed.sequence.circular,
              fileContentHash,
              normalizedSequenceHash,
              sourceFileContentHash: fileContentHash,
              sourceRecordIndex: 0,
              sourceRecordCount: recordCount,
              recordCount,
            },
          },
        ];
      }

      return [
        {
          id: 'sequence-file-1',
          action: 'register_entity',
          accepted: false,
          requiresRegistrationKind,
          entity: {
            kind,
            name: deriveImportedSequenceName(parsed.sequence.name, input.fileName),
            fields: { sequence: { mode: 'unresolved' } },
            registrationStatus: 'unresolved',
            actor: 'local-user',
          },
          source: {
            fileName: input.fileName,
            length: parsed.sequence.length,
            circular: parsed.sequence.circular,
          },
          errors: [
            ...kindSelectionErrors,
            'Sequence file import requires a durable source path or managed copy before registration.',
          ],
        },
      ];
    }
    return [
      {
        id: 'sequence-file-1',
        action: 'register_entity',
        accepted: kindSelectionErrors.length === 0 && !requiresRegistrationKind,
        requiresRegistrationKind,
        entity: {
          kind,
          name: deriveImportedSequenceName(parsed.sequence.name, input.fileName),
          fields: {
            sequence: {
              mode: 'file',
              relPath: durableSourcePath,
              topology: parsed.sequence.circular ? 'circular' : 'linear',
              length: parsed.sequence.length,
              contentHash: fileContentHash,
              fileContentHash,
              normalizedSequenceHash,
              sourceFormat,
            },
            notes: parsed.sequence.description,
          },
          registrationStatus: 'registered',
          actor: 'local-user',
        },
        errors: kindSelectionErrors.length > 0 ? kindSelectionErrors : undefined,
        source: {
          fileName: input.fileName,
          length: parsed.sequence.length,
          circular: parsed.sequence.circular,
          fileContentHash,
          normalizedSequenceHash,
          sourceFileContentHash: fileContentHash,
          sourceRecordIndex: 0,
          sourceRecordCount: recordCount,
          recordCount,
        },
      },
    ];
  } catch (err) {
    return [
      {
        id: 'sequence-file-1',
        action: 'register_entity',
        accepted: false,
        entity: {
          kind: input.defaultKind ?? SEQUENCE_FILE_DEFAULT_KIND,
          name: input.fileName,
          fields: { sequence: { mode: 'unresolved' } },
          registrationStatus: 'unresolved',
          actor: 'local-user',
        },
        source: { fileName: input.fileName },
        errors: [err instanceof Error ? err.message : String(err)],
      },
    ];
  }
}

async function recordsFromProteinFasta(input: DryRunLimsImportInput): Promise<LimsImportRecord[]> {
  const text = input.text ?? '';
  try {
    const records = parseFasta(text);
    return Promise.all(
      records.map(async (record, index): Promise<LimsImportRecord> => {
        const aminoAcids = normalizeProteinSequence(record.sequence);
        const validationError = proteinSequenceValidationError(aminoAcids);
        const tooLong = aminoAcids.length > IMPORT_INLINE_SEQUENCE_CEILING;
        const errors = [
          ...(validationError ? [validationError] : []),
          ...(tooLong
            ? [
                `Sequence is ${aminoAcids.length.toLocaleString()} residues, above the ${IMPORT_INLINE_SEQUENCE_CEILING.toLocaleString()} residue inline limit.`,
              ]
            : []),
        ];
        return {
          id: `protein-file-${index + 1}`,
          action: 'register_entity',
          accepted: errors.length === 0,
          entity: {
            kind: input.forcedKind ?? 'protein',
            name: record.name.trim() || `Protein ${index + 1}`,
            fields: {
              sequence:
                errors.length === 0
                  ? await buildInlineProteinSequenceRef(aminoAcids)
                  : { mode: 'unresolved' },
              ...(record.description ? { notes: record.description } : {}),
            },
            registrationStatus: errors.length === 0 ? 'registered' : 'unresolved',
            actor: 'local-user',
          },
          source: {
            fileName: input.fileName,
            recordIndex: index,
            fastaName: record.name,
            length: aminoAcids.length,
          },
          ...(errors.length > 0 ? { errors } : {}),
        };
      })
    );
  } catch (err) {
    return [
      {
        id: 'protein-file-1',
        action: 'register_entity',
        accepted: false,
        entity: {
          kind: input.forcedKind ?? 'protein',
          name: input.fileName,
          fields: { sequence: { mode: 'unresolved' } },
          registrationStatus: 'unresolved',
          actor: 'local-user',
        },
        source: { fileName: input.fileName },
        errors: [err instanceof Error ? err.message : String(err)],
      },
    ];
  }
}

const DEDUP_FETCH_CEILING = 50_000;

async function markDuplicates(
  records: LimsImportRecord[],
  dependencies: LimsImportPlannerDependencies
): Promise<LimsImportRecord[]> {
  const indexByKind = new Map<string, ExistingEntityIndex>();
  for (const record of records) {
    const kind = record.entity.kind;
    if (indexByKind.has(kind)) continue;
    const existing = await dependencies.queryEntities({ kind, limit: DEDUP_FETCH_CEILING });
    if (existing.length >= DEDUP_FETCH_CEILING) {
      console.warn(
        `[lims-import] ${kind} has >= ${DEDUP_FETCH_CEILING} entities; duplicate preview may miss some.`
      );
    }
    indexByKind.set(kind, buildExistingEntityIndex(existing));
  }

  const seenContent = new Map<string, LimsImportRecord>();
  const seenNames = new Map<string, LimsImportRecord>();
  const result: LimsImportRecord[] = [];
  for (const record of records) {
    const index = indexByKind.get(record.entity.kind);
    const kind = record.entity.kind;
    const name = record.entity.name.trim().toLowerCase();
    const baseWarnings = record.warnings ?? [];
    const warnings = [...baseWarnings];

    const nameMatch = index && name ? (index.byName.get(name) ?? null) : null;
    const seqMatch = index ? firstSeqContentMatch(record, index) : null;
    const accMatch = index
      ? firstAccessionMatch(accessionKeysForEntityFields(record.entity.fields), index)
      : null;

    if (seqMatch?.matchType === 'file' && !record.externalRowId) {
      result.push({
        ...record,
        duplicateOf: seqMatch.entity.id,
        duplicateName: seqMatch.entity.name,
        duplicateReason: seqMatch.reason,
        accepted: false,
      });
      continue;
    }

    const contentKeys = inBatchContentKeys(record);
    const collidingContentKey = contentKeys.find((key) => seenContent.has(key));
    if (collidingContentKey) {
      const prior = seenContent.get(collidingContentKey)!;
      result.push({
        ...record,
        duplicateOf: prior.id,
        duplicateName: prior.entity.name,
        duplicateReason: inBatchDuplicateReason(collidingContentKey),
        accepted: false,
      });
      continue;
    }
    for (const key of contentKeys) if (!seenContent.has(key)) seenContent.set(key, record);

    if (seqMatch) {
      warnings.push(`An existing ${kind} ("${seqMatch.entity.name}") already has this sequence.`);
    }
    if (nameMatch) {
      warnings.push(`A ${kind} named "${record.entity.name}" already exists in the registry.`);
    }
    if (accMatch) {
      warnings.push(`An existing ${kind} ("${accMatch.name}") shares an external accession.`);
    }

    const nameKey = name ? `name:${kind}:${name}` : '';
    if (nameKey && seenNames.has(nameKey)) {
      warnings.push('Another row in this import has the same name.');
    }
    if (nameKey && !seenNames.has(nameKey)) seenNames.set(nameKey, record);

    result.push(warnings.length > baseWarnings.length ? { ...record, warnings } : record);
  }
  return result;
}

function inBatchContentKeys(record: LimsImportRecord): string[] {
  if (record.externalRowId !== undefined) return [`external-row:${record.externalRowId}`];
  const kind = record.entity.kind;
  const keys: string[] = [];
  const seq = record.entity.fields.sequence as SequenceRefShape | undefined;

  if (seq?.mode === 'inline' && seq.bases) {
    if (kind === 'oligo' || kind === 'rna_oligo') {
      const exactNotation = exactImportedOligoNotation(record, seq.bases, kind);
      if (exactNotation) keys.push(`oligo:${kind}:${exactNotation}`);
    } else {
      keys.push(`inline:${kind}:${seq.bases}`);
    }
  }
  if (seq?.mode === 'inline' && seq.aminoAcids) {
    keys.push(`inline:${kind}:${seq.aminoAcids}`);
  }
  if (seq?.mode === 'file') {
    const fileHash = seq.fileContentHash ?? seq.contentHash;
    if (fileHash) keys.push(`file:${fileHash}`);
    if (seq.normalizedSequenceHash) keys.push(`norm:${seq.normalizedSequenceHash}`);
  }
  const source = record.source as
    | { fileContentHash?: string; normalizedSequenceHash?: string }
    | undefined;
  if (isContentHash(source?.fileContentHash)) keys.push(`file:${source!.fileContentHash}`);
  if (isContentHash(source?.normalizedSequenceHash))
    keys.push(`norm:${source!.normalizedSequenceHash}`);
  return keys;
}

function exactImportedOligoNotation(
  record: LimsImportRecord,
  naturalBases: string,
  kind: 'oligo' | 'rna_oligo'
): string | null {
  if (!record.sequenceNotation?.trim()) return null;
  const orderType = kind === 'rna_oligo' ? 'rna' : 'dna';
  const notation = record.sequenceNotation.trim().replace(/\s+/g, '');
  const parsed = parseIdtOligoNotation(notation, { orderType });
  if (parsed.errors.length === 0 && parsed.bases.toUpperCase() === naturalBases.toUpperCase()) {
    return notation;
  }
  return null;
}

function inBatchDuplicateReason(key: string): string {
  if (key.startsWith('name:')) return 'Another row in this import has the same name.';
  if (key.startsWith('oligo:')) {
    return 'Another row in this import has the same exact oligo order notation.';
  }
  if (key.startsWith('inline:')) return 'Another row in this import has the same inline sequence.';
  if (key.startsWith('file:')) return 'Another row in this import has the same file-byte hash.';
  return 'Another row in this import has the same normalized sequence hash.';
}

interface ExistingEntityIndex {
  byName: Map<string, LimsEntity>;
  bySeq: Map<string, { entity: LimsEntity; reason: string }>;

  byAccession: Map<string, LimsEntity>;
}

type SequenceRefShape = {
  mode?: string;
  bases?: string;
  aminoAcids?: string;
  contentHash?: string;
  fileContentHash?: string;
  normalizedSequenceHash?: string;
};

type SequenceSourceIdentityShape = {
  sourceFileContentHash?: unknown;
  sourceRecordIndex?: unknown;
  sourceRecordCount?: unknown;
};

function exactSourceRecordKey(source: SequenceSourceIdentityShape): string | null {
  const hash = source.sourceFileContentHash;
  const recordIndex = source.sourceRecordIndex;
  const recordCount = source.sourceRecordCount;
  if (!isContentHash(hash)) return null;
  if (typeof recordIndex !== 'number' || typeof recordCount !== 'number') return null;
  if (!Number.isInteger(recordIndex) || !Number.isInteger(recordCount)) return null;
  if (recordIndex < 0 || recordCount < 1 || recordIndex >= recordCount) return null;
  return `source-file:${hash}:${recordIndex}/${recordCount}`;
}

function exactSourceRecordKeyForEntity(entity: LimsEntity): string | null {
  const metadata = entity.fields.sourceMetadata;
  if (
    metadata === null ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata) ||
    !('values' in metadata)
  ) {
    return null;
  }
  const values = metadata.values;
  if (values === null || typeof values !== 'object' || Array.isArray(values)) return null;
  return exactSourceRecordKey({
    sourceFileContentHash:
      'sourceFileContentHash' in values ? values.sourceFileContentHash : undefined,
    sourceRecordIndex: 'sourceRecordIndex' in values ? values.sourceRecordIndex : undefined,
    sourceRecordCount: 'sourceRecordCount' in values ? values.sourceRecordCount : undefined,
  });
}

function buildExistingEntityIndex(existing: readonly LimsEntity[]): ExistingEntityIndex {
  const byName = new Map<string, LimsEntity>();
  const bySeq = new Map<string, { entity: LimsEntity; reason: string }>();
  const byAccession = new Map<string, LimsEntity>();
  for (const entity of existing) {
    const name = entity.name.trim().toLowerCase();
    if (name && !byName.has(name)) byName.set(name, entity);
    for (const key of accessionKeysForEntityFields(entity.fields)) {
      if (!byAccession.has(key)) byAccession.set(key, entity);
    }
    const seq = entity.fields.sequence as SequenceRefShape | undefined;
    const managedSequence = readManagedSequenceContentSummary(
      entity.fields[MANAGED_SEQUENCE_CONTENT_FIELD]
    );
    if (seq?.mode === 'inline' && seq.bases) {
      addSeqKey(bySeq, `inline:${seq.bases}`, entity, 'the same inline sequence');
    }
    if (seq?.mode === 'inline' && seq.aminoAcids) {
      addSeqKey(bySeq, `inline:${seq.aminoAcids}`, entity, 'the same inline sequence');
    }
    if (seq?.mode === 'file') {
      const fileHash = seq.fileContentHash ?? seq.contentHash;
      if (fileHash) addSeqKey(bySeq, `file:${fileHash}`, entity, 'the same file-byte hash');
      if (seq.normalizedSequenceHash) {
        addSeqKey(
          bySeq,
          `norm:${seq.normalizedSequenceHash}`,
          entity,
          'the same normalized sequence hash'
        );
      }
    }
    if (managedSequence?.fileContentHash) {
      addSeqKey(
        bySeq,
        `file:${managedSequence.fileContentHash}`,
        entity,
        'the same managed package file-byte hash'
      );
    }
    if (managedSequence?.normalizedSequenceHash) {
      addSeqKey(
        bySeq,
        `norm:${managedSequence.normalizedSequenceHash}`,
        entity,
        'the same managed package normalized sequence hash'
      );
    }
    const sourceRecordKey = exactSourceRecordKeyForEntity(entity);
    if (sourceRecordKey) {
      addSeqKey(bySeq, sourceRecordKey, entity, 'the same original source-file record');
    }
  }
  return { byName, bySeq, byAccession };
}

function isContentHash(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('sha256:');
}

function firstSeqContentMatch(
  record: LimsImportRecord,
  index: ExistingEntityIndex
): { entity: LimsEntity; reason: string; matchType: 'file' | 'sequence' } | null {
  const seq = record.entity.fields.sequence as SequenceRefShape | undefined;
  const source = record.source as
    | { fileContentHash?: string; normalizedSequenceHash?: string }
    | undefined;
  const srcFileHash = isContentHash(source?.fileContentHash) ? source.fileContentHash : undefined;
  const sourceRecordKey = exactSourceRecordKey({
    sourceFileContentHash:
      typeof record.source.sourceFileContentHash === 'string'
        ? record.source.sourceFileContentHash
        : srcFileHash,
    sourceRecordIndex:
      record.source.sourceRecordIndex ?? (record.source.recordCount === 1 ? 0 : undefined),
    sourceRecordCount: record.source.sourceRecordCount ?? record.source.recordCount,
  });
  if (seq?.mode === 'inline' && seq.bases) {
    const hit = index.bySeq.get(`inline:${seq.bases}`);
    return hit ? { ...hit, matchType: 'sequence' } : null;
  }
  if (seq?.mode === 'inline' && seq.aminoAcids) {
    const hit = index.bySeq.get(`inline:${seq.aminoAcids}`);
    return hit ? { ...hit, matchType: 'sequence' } : null;
  }
  if (seq?.mode === 'file') {
    const fileHash = seq.fileContentHash ?? seq.contentHash;
    if (fileHash) {
      const hit = index.bySeq.get(`file:${fileHash}`);
      if (hit) return { ...hit, matchType: 'file' };
    }
    if (sourceRecordKey) {
      const hit = index.bySeq.get(sourceRecordKey);
      if (hit) return { ...hit, matchType: 'file' };
    }
    if (seq.normalizedSequenceHash) {
      const hit = index.bySeq.get(`norm:${seq.normalizedSequenceHash}`);
      if (hit) return { ...hit, matchType: 'sequence' };
    }
  }

  if (srcFileHash) {
    const hit = index.bySeq.get(`file:${srcFileHash}`);
    if (hit) return { ...hit, matchType: 'file' };
  }
  if (sourceRecordKey) {
    const hit = index.bySeq.get(sourceRecordKey);
    if (hit) return { ...hit, matchType: 'file' };
  }
  const srcNormHash = isContentHash(source?.normalizedSequenceHash)
    ? source!.normalizedSequenceHash
    : undefined;
  if (srcNormHash) {
    const hit = index.bySeq.get(`norm:${srcNormHash}`);
    if (hit) return { ...hit, matchType: 'sequence' };
  }
  return null;
}

function firstAccessionMatch(
  recordAccessionKeys: readonly string[],
  index: ExistingEntityIndex
): LimsEntity | null {
  for (const key of recordAccessionKeys) {
    const entity = index.byAccession.get(key);
    if (entity) return entity;
  }
  return null;
}

function addSeqKey(
  bySeq: Map<string, { entity: LimsEntity; reason: string }>,
  key: string,
  entity: LimsEntity,
  detail: string
): void {
  if (!bySeq.has(key)) {
    bySeq.set(key, { entity, reason: `Existing registry record has ${detail}.` });
  }
}

export function evaluateImportAccuracyOracle(
  sourceName: string,
  sourceKind: LimsSourceKind,
  records: readonly LimsImportRecord[]
): LimsImportOracleResult {
  const invariants: LimsImportOracleResult['invariants'] = [];
  for (const record of records) {
    if (record.errors && record.errors.length > 0) {
      invariants.push({
        id: 'record-valid',
        ok: false,
        recordId: record.id,
        message: record.errors.join('; '),
      });
      continue;
    }
    invariants.push({
      id: 'name-mapped',
      ok: record.entity.name.trim().length > 0,
      recordId: record.id,
      message: 'Name column maps to entity name.',
    });
    const seq = record.entity.fields.sequence as { mode?: string; bases?: string } | undefined;
    if (isOligoKind(record.entity.kind)) {
      invariants.push({
        id: 'inline-sequence-mapped',
        ok: seq?.mode === 'inline' && Boolean(seq.bases),
        recordId: record.id,
        message:
          record.entity.kind === 'rna_oligo'
            ? 'RNA oligo sequence maps to an inline rna_sequence field.'
            : 'DNA oligo sequence maps to an inline dna_sequence field.',
      });
    }
    for (const link of record.links ?? []) {
      invariants.push({
        id: 'orientation-preserved-on-link',
        ok: 'orientation' in link.payload,
        recordId: record.id,
        message: 'Primer direction is preserved on the association payload.',
      });
      invariants.push({
        id: 'target-link-created',
        ok: Boolean(link.toEntityId || link.toEntityLookup),
        recordId: record.id,
        message: 'Template or target column becomes a neutral associated-with link target.',
      });
    }
  }
  return {
    ok: invariants.every((invariant) => invariant.ok),
    source: `${sourceKind}:${sourceName}`,
    invariants,
  };
}

export const WORKBOOK_EXTENSIONS = ['.xlsx', '.xls', '.xlsm'] as const;

export function isWorkbookFileName(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return WORKBOOK_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function detectSourceKind(fileName: string, text: string): LimsSourceKind {
  const lower = fileName.toLowerCase();

  if (lower.endsWith('.xlsx') || lower.endsWith('.xls') || lower.endsWith('.xlsm')) return 'xlsx';

  if (/^\s*LOCUS\s+/m.test(text)) return 'genbank';
  if (/^\s*>/.test(text)) return 'fasta';
  if (lower.endsWith('.tsv') || lower.endsWith('.tab')) return 'tsv';
  if (lower.endsWith('.gb') || lower.endsWith('.gbk') || lower.endsWith('.genbank')) {
    return 'genbank';
  }
  if (
    lower.endsWith('.fa') ||
    lower.endsWith('.fasta') ||
    lower.endsWith('.fna') ||
    lower.endsWith('.faa')
  )
    return 'fasta';
  return text.split(/\r?\n/)[0]?.includes('\t') ? 'tsv' : 'csv';
}

function countSequenceRecords(text: string, sourceKind: 'genbank' | 'fasta'): number {
  const pattern = sourceKind === 'genbank' ? /^LOCUS\s/gm : /^>/gm;
  const matches = text.match(pattern);
  if (matches) return matches.length;
  return text.trim() ? 1 : 0;
}

function rowHasRecognizedHeaderTokens(cells: readonly string[]): boolean {
  return cells.some((cell) => {
    const key = normalizeSourceColumnKey(cell);
    return (
      key.length > 0 &&
      (Boolean(mappedFieldForColumn(key)) || ['kind', 'type', 'entity type'].includes(key))
    );
  });
}

export interface WorkbookSheetPreview {
  headers: string[];

  rows: string[][];

  sampledRows: number;
}

export function buildWorkbookSheetPreviews(
  arrayBuffer: ArrayBuffer,
  sheetNames: readonly string[],
  opts: { maxRows?: number; maxCols?: number } = {}
): Record<string, WorkbookSheetPreview> {
  const maxRows = opts.maxRows ?? 5;
  const maxCols = opts.maxCols ?? 8;
  const out: Record<string, WorkbookSheetPreview> = {};
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array' });
  } catch {
    return out;
  }
  for (const name of sheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const { range } = boundedSheetRange(sheet, { maxRows: maxRows + 25, maxCols: maxCols + 4 });
    const matrix = XLSX.utils
      .sheet_to_json<Array<string | number | boolean | null>>(sheet, {
        header: 1,
        defval: '',
        raw: false,
        ...(range ? { range } : {}),
      })
      .map((row) => row.map((cell) => normalizeCell(String(cell ?? ''))));
    const detection = detectHeaderRow(matrix);
    const headerRowCells = matrix[detection.headerRowIndex] ?? [];

    const treatAsHeader =
      detection.mode === 'detected' || rowHasRecognizedHeaderTokens(headerRowCells);
    const dataStart = treatAsHeader ? detection.headerRowIndex + 1 : detection.headerRowIndex;
    const dataRows = matrix.slice(dataStart).filter((row) => row.some((cell) => cell !== ''));
    const width = Math.min(
      maxCols,
      Math.max(headerRowCells.length, ...dataRows.slice(0, maxRows).map((r) => r.length), 1)
    );
    const headers = treatAsHeader
      ? (detection.mode === 'detected' ? detection.headers : headerRowCells).slice(0, width)
      : Array.from({ length: width }, (_v, i) => `Column ${i + 1}`);
    out[name] = {
      headers,
      rows: dataRows.slice(0, maxRows).map((row) => {
        const trimmed = row.slice(0, width);
        while (trimmed.length < width) trimmed.push('');
        return trimmed;
      }),
      sampledRows: dataRows.length,
    };
  }
  return out;
}

function parseWorkbook(
  input: InspectLimsSourceInput,
  externalRowKeyColumn?: string
): {
  headers: string[];
  rows: DelimitedRow[];
  warnings: string[];
  sheetDispositions?: SheetDisposition[];
  selectedSheet?: string;
} {
  if (!input.arrayBuffer) {
    return {
      headers: [],
      rows: [],
      warnings: ['Excel source has no workbook bytes.'],
    };
  }

  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(new Uint8Array(input.arrayBuffer), { type: 'array' });
  } catch (err) {
    return {
      headers: [],
      rows: [],
      warnings: [err instanceof Error ? err.message : String(err)],
    };
  }
  if (workbook.SheetNames.length === 0) {
    return { headers: [], rows: [], warnings: ['Excel workbook has no worksheets.'] };
  }

  const triage = triageWorkbook(workbook);

  const selectedSheet =
    (input.sheetName && workbook.SheetNames.includes(input.sheetName) ? input.sheetName : '') ||
    triage.entitySheetNames[0] ||
    workbook.SheetNames[0];

  const sheet = workbook.Sheets[selectedSheet];

  const importBounds = boundedSheetRange(sheet, { maxRows: 100_000, maxCols: 512 });
  const matrix = XLSX.utils.sheet_to_json<Array<string | number | boolean | null>>(sheet, {
    header: 1,
    defval: '',
    raw: false,
    ...(importBounds.range ? { range: importBounds.range } : {}),
  });
  const normalized = matrix.map((row) => row.map((cell) => normalizeCell(String(cell ?? ''))));
  if (!normalized.some((row) => row.some(Boolean))) {
    return {
      headers: [],
      rows: [],
      warnings: [`Worksheet "${selectedSheet}" is empty.`],
      sheetDispositions: triage.sheets,
      selectedSheet,
    };
  }

  const detection = detectHeaderRow(normalized, { headerRowOverride: input.headerRowOverride });

  const effective =
    detection.mode === 'synthesized' &&
    input.headerRowOverride == null &&
    rowHasRecognizedHeaderTokens(normalized[detection.headerRowIndex] ?? [])
      ? {
          headerRowIndex: detection.headerRowIndex,
          mode: 'detected' as const,
          headers: normalized[detection.headerRowIndex] ?? [],
          titleRowsAbove: detection.headerRowIndex,
          sideBySide: detection.sideBySide,
        }
      : detection;

  const lastCol = effective.sideBySide
    ? effective.sideBySide.primaryCols[1]
    : Number.POSITIVE_INFINITY;
  const headers = (
    effective.mode === 'detected' ? effective.headers.map(normalizeHeader) : effective.headers
  ).filter((_header, colIndex) => colIndex <= lastCol);

  const dataStart =
    effective.mode === 'synthesized' ? effective.headerRowIndex : effective.headerRowIndex + 1;
  const rows = normalized
    .slice(dataStart)
    .map((values, index) => {
      const row: Record<string, string> = {};
      headers.forEach((header, colIndex) => {
        const key = normalizeSourceColumnKey(header);
        row[key] =
          externalRowKeyColumn !== undefined &&
          key === normalizeSourceColumnKey(externalRowKeyColumn)
            ? String(matrix[dataStart + index]?.[colIndex] ?? '')
            : (values[colIndex] ?? '');
      });
      return { rowNumber: dataStart + index + 1, values: row };
    })
    .filter((row) => Object.values(row.values).some((value) => value.trim().length > 0));

  const warnings: string[] = [];
  if (importBounds.clippedRows > 0 || importBounds.clippedCols > 0) {
    const parts: string[] = [];
    if (importBounds.clippedRows > 0) parts.push(`${importBounds.clippedRows} row(s)`);
    if (importBounds.clippedCols > 0) parts.push(`${importBounds.clippedCols} column(s)`);
    warnings.push(
      `Worksheet "${selectedSheet}" exceeds the import cap; ${parts.join(' and ')} beyond it were ` +
        `NOT imported. Split the file to import the rest.`
    );
  }
  if (workbook.SheetNames.length > 1) {
    warnings.push(
      `Parsed worksheet "${selectedSheet}" of ${workbook.SheetNames.length} ` +
        `(${triage.entitySheetNames.length} entity table(s) detected).`
    );
  }
  if (effective.mode === 'synthesized') {
    warnings.push('No header row detected; inferred column labels.');
  } else if (effective.titleRowsAbove > 0) {
    warnings.push(
      `Header found on row ${effective.headerRowIndex + 1} (below ${effective.titleRowsAbove} title/blank row(s)).`
    );
  }
  if (effective.sideBySide) {
    warnings.push(
      'Side-by-side tables detected; parsed the left table only — the rest is flagged as leftover.'
    );
  }

  return { headers, rows, warnings, sheetDispositions: triage.sheets, selectedSheet };
}

function resolveDelimiter(text: string, sourceKind: 'csv' | 'tsv'): ',' | '\t' | ';' {
  if (sourceKind === 'tsv') return '\t';
  const header = text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '';
  const commas = (header.match(/,/g) ?? []).length;
  const semis = (header.match(/;/g) ?? []).length;
  return semis > commas ? ';' : ',';
}

function parseDelimited(
  text: string,
  delimiter: ',' | '\t' | ';',
  hasHeaderOverride?: boolean,
  externalRowKeyColumn?: string
): {
  headers: string[];
  rows: DelimitedRow[];
  warnings: string[];
} {
  const rawRows = tokenizeDelimitedText(text, delimiter).filter((cells) =>
    cells.some((cell) => normalizeCell(cell).length > 0)
  );
  const allRows = rawRows.map((cells) => cells.map(normalizeCell));
  if (allRows.length === 0) return { headers: [], rows: [], warnings: ['Empty source'] };
  const firstRow = allRows[0];

  const headerless =
    hasHeaderOverride === undefined ? shouldTreatAsHeaderlessTable(firstRow) : !hasHeaderOverride;
  const rawHeaders = headerless ? inferHeaderlessHeaders(firstRow) : firstRow.map(normalizeHeader);
  const dataRows = headerless ? allRows : allRows.slice(1);

  const maxCols = dataRows.reduce((m, cells) => Math.max(m, cells.length), rawHeaders.length);
  const paddedHeaders = rawHeaders.slice();
  for (let i = rawHeaders.length; i < maxCols; i += 1) paddedHeaders.push(`Column ${i + 1}`);

  const headers = disambiguateHeaders(paddedHeaders);
  const warnings: string[] = [];
  if (headerless) {
    warnings.push(
      hasHeaderOverride === false
        ? 'Treating the first row as data (no header); inferred column labels.'
        : 'No header row detected; inferred primer table columns.'
    );
  }
  const collapsed =
    paddedHeaders.length - new Set(paddedHeaders.map(normalizeSourceColumnKey)).size;
  if (collapsed > 0) {
    warnings.push(
      `${collapsed} duplicate or blank column header${
        collapsed === 1 ? ' was' : 's were'
      } disambiguated so no column was silently dropped.`
    );
  }
  const rows = dataRows.map((cells, index) => {
    const row: Record<string, string> = {};
    headers.forEach((header, colIndex) => {
      const key = normalizeSourceColumnKey(header);
      row[key] =
        externalRowKeyColumn !== undefined && key === normalizeSourceColumnKey(externalRowKeyColumn)
          ? (rawRows[index + (headerless ? 0 : 1)]?.[colIndex] ?? '')
          : (cells[colIndex] ?? '');
    });
    return { rowNumber: index + (headerless ? 1 : 2), values: row };
  });
  return { headers, rows, warnings };
}

function disambiguateHeaders(headers: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((header) => {
    const key = normalizeSourceColumnKey(header);
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n === 1) return header;
    return `${header.trim() || 'Column'} (${n})`;
  });
}

function tokenizeDelimitedText(text: string, delimiter: ',' | '\t' | ';'): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      started = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
      started = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      if (started || field.length > 0 || row.length > 0) {
        row.push(field);
        rows.push(row);
      }
      row = [];
      field = '';
      started = false;
    } else {
      field += ch;
      started = true;
    }
  }
  if (started || field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function normalizeCell(value: string): string {
  return value.replace(/^\uFEFF/, '').trim();
}

function normalizeHeader(value: string): string {
  return normalizeCell(value);
}

function normalizeSourceColumnKey(value: string): string {
  return normalizeHeader(value).toLowerCase();
}

function shouldTreatAsHeaderlessTable(cells: readonly string[]): boolean {
  const nonempty = cells.map(normalizeCell).filter(Boolean);
  if (nonempty.length < 2) return false;

  const recognizedHeaderCount = nonempty.filter((cell) => {
    const key = normalizeSourceColumnKey(cell);
    return Boolean(mappedFieldForColumn(key)) || ['kind', 'type', 'entity type'].includes(key);
  }).length;
  if (recognizedHeaderCount > 0) return false;

  return inferHeaderlessHeaders(nonempty).some((header, index) => {
    return (
      normalizeSourceColumnKey(header) === 'sequence' && looksLikeDnaSequenceCell(nonempty[index])
    );
  });
}

function inferHeaderlessHeaders(cells: readonly string[]): string[] {
  const normalized = cells.map(normalizeCell);
  const labels = headerlessLabelSequence(normalized);

  let cursor = 0;
  return normalized.map((value, index) => {
    if (value.length === 0) return `Column ${index + 1}`;
    const label = labels[cursor] ?? `Column ${index + 1}`;
    cursor++;
    return label;
  });
}

function headerlessLabelSequence(cells: readonly string[]): string[] {
  const nonempty = cells.filter((cell) => cell.length > 0);
  const dnaIndex = nonempty.findIndex(looksLikeDnaSequenceCell);
  const firstCellLooksLikeWell = looksLikeWellPosition(nonempty[0] ?? '');
  if (firstCellLooksLikeWell && dnaIndex >= 2) {
    return ['Well', 'Name', 'Sequence', 'Notes', 'Target'];
  }
  if (dnaIndex === 1) {
    return ['Name', 'Sequence', 'Notes', 'Target', 'Direction'];
  }
  if (dnaIndex > 1) {
    return ['Name', 'Notes', 'Sequence', 'Target', 'Direction'];
  }
  return ['Name', 'Sequence', 'Notes', 'Target', 'Direction'];
}

function looksLikeDnaSequenceCell(value: string): boolean {
  const cleaned = normalizeCell(value).replace(/[\s*]/g, '');
  return cleaned.length >= 10 && NUCLEIC_ACID_TEXT.test(cleaned);
}

function looksLikeWellPosition(value: string): boolean {
  return /^[A-P](?:0?[1-9]|1[0-9]|2[0-4])$/i.test(normalizeCell(value));
}

function readMapped(
  row: DelimitedRow,
  columns: readonly LimsImportPlanColumn[],
  mappedFields: readonly string[]
): string | null {
  const wanted = new Set(mappedFields);
  for (const column of columns) {
    if (column.mappingMode !== 'mapped' || !column.mappedField || !wanted.has(column.mappedField)) {
      continue;
    }
    const value = row.values[normalizeSourceColumnKey(column.sourceColumn)];
    if (value && value.trim()) return value.trim();
  }
  return null;
}

function normalizeKind(value: string | null): LimsEntityKind | null {
  if (!value) return null;
  const lower = value.trim().toLowerCase();
  if (lower === 'primer') return 'oligo';
  if (
    lower === 'oligo' ||
    lower === 'plasmid' ||
    lower === 'genome' ||
    lower === 'strain' ||
    lower === 'organism'
  ) {
    return lower;
  }
  return null;
}

function inferKindFromMappedRow(
  row: DelimitedRow,
  columns: readonly LimsImportPlanColumn[]
): LimsEntityKind | null {
  if (
    readMapped(row, columns, [
      'fields.genotypeCanonical',
      'links.references.parent_genome',
      'links.has_genome.hypothesis_supplied',
      'links.has_genome.WGS_verified',
    ])
  ) {
    return 'strain';
  }
  return null;
}

function sourceValuesForRecord(
  row: DelimitedRow,
  columns: readonly LimsImportPlanColumn[]
): Record<string, string> {
  const source: Record<string, string> = {};
  for (const column of columns) {
    if (column.mappingMode === 'ignored') continue;
    source[column.sourceColumn] = row.values[normalizeSourceColumnKey(column.sourceColumn)] ?? '';
  }
  return source;
}

function sourceColumnForMappedField(
  columns: readonly LimsImportPlanColumn[],
  mappedField: string
): string | undefined {
  return columns.find(
    (column) => column.mappingMode === 'mapped' && column.mappedField === mappedField
  )?.sourceColumn;
}

const STRAND_REVERSE = new Set(['reverse', 'rev', 'r', '-1', '-', 'minus', 'antisense', '3', "3'"]);
const STRAND_FORWARD = new Set(['forward', 'fwd', 'f', '1', '+1', '+', 'plus', 'sense', '5', "5'"]);
function normalizeStrand(value: string | null): 'forward' | 'reverse' | null {
  if (!value) return null;
  const lower = value.trim().toLowerCase();
  if (lower === '') return null;
  if (STRAND_REVERSE.has(lower)) return 'reverse';
  if (STRAND_FORWARD.has(lower)) return 'forward';

  return null;
}

function numberOrNull(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export type ApplyAcceptedLimsImportPlanOperation = (
  plan: Parameters<typeof applyAcceptedLimsImportPlan>[0],
  options?: Parameters<typeof applyAcceptedLimsImportPlan>[1]
) => ReturnType<typeof applyAcceptedLimsImportPlan>;
