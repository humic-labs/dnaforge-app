import {
  PLASMID_SCHEMA_FIELD_DEFINITIONS,
  SEQUENCE_SCHEMA_V1_FIELD_DEFINITIONS,
} from './sequence-entity-schema';
import { parseWorkTime } from '@waypoint/scientific-objects';
import type {
  EntitySchemaFieldSnapshot,
  ProjectableEntitySchemaRevisionSnapshot,
} from './entity-schema';
import type { ScientificAcceptedDocumentRevision } from '@waypoint/domain-services';
import type { ProjectableRelationshipSchemaRevisionSnapshot } from './relationship-schema';
import type { GeneticCodeSpec } from '@waypoint/sequence-utils';
import {
  normalizeProteinSequence,
  proteinSequenceValidationError,
} from '@waypoint/sequence-utils/protein-sequence';

export const LIMS_GIT_EXPORT_RELATIVE_PATH = '.waypoint/lims';
import type {
  ProviderObjectClass,
  ProviderObjectReferenceProvider,
} from './provider-object-reference';

import type { LimsEntityKind, LimsRelationshipTypeDefinition } from './lims-kinds';
export {
  LIMS_ENTITY_KINDS,
  type LimsEntityKind,
  type LimsRelationshipTypeDefinition,
} from './lims-kinds';

export const LIMS_REGISTRATION_STATUSES = [
  'tracked',
  'registered',
  'drifted',
  'unresolved',
] as const;
export type LimsRegistrationStatus = (typeof LIMS_REGISTRATION_STATUSES)[number];

export function recordRegistrationStatus(
  status: LimsRegistrationStatus,
  incomplete: boolean
): LimsRegistrationStatus {
  return incomplete && status === 'registered' ? 'unresolved' : status;
}

export function registrationStatusLabel(status: LimsRegistrationStatus): string {
  return status === 'drifted' ? 'edited' : status;
}

export type LimsSchemaKind = 'entity' | 'relationship_type';
export const LIMS_FIELD_TYPES = [
  'text',
  'long_text',
  'number',
  'boolean',
  'enum',
  'date',
  'datetime',
  'dna_sequence',
  'rna_sequence',
  'protein_sequence',
  'quantity',
  'record_relationship',
  'attachment_reference',
  'formula_result',
  'string_array',
  'genetic_code',
] as const;
export type LimsFieldType = (typeof LIMS_FIELD_TYPES)[number];

export function isLimsFieldType(value: string): value is LimsFieldType {
  return (LIMS_FIELD_TYPES as readonly string[]).includes(value);
}

export type DnaSequenceTopology = 'linear' | 'circular';
export type DnaSequenceSourceFormat = 'gb' | 'genbank' | 'fasta' | 'snapgene' | 'unknown';

export type InlineDnaSequenceRef = {
  mode: 'inline';
  bases: string;
  topology: 'linear';
  length: number;
  contentHash?: string;
};

export type FileDnaSequenceRef = {
  mode: 'file';

  documentId: string;

  acceptedRevisionId?: string;
  relPath: string;
  workspaceId?: number | null;
  topology: DnaSequenceTopology;
  length: number;

  geneticCode?: GeneticCodeSpec;

  contentHash: string;
  fileContentHash?: string;
  normalizedSequenceHash?: string;
  sourceFormat: DnaSequenceSourceFormat;
  sequenceId?: number | null;
  sizeBytes?: number | null;
  modifiedAt?: number | null;
};

export type UnresolvedDnaSequenceRef = {
  mode: 'unresolved';
};

export type DnaSequenceRef = InlineDnaSequenceRef | FileDnaSequenceRef | UnresolvedDnaSequenceRef;

export type AminoAcidSequenceSourceFormat = 'fasta' | 'unknown';

export type InlineAminoAcidSequenceRef = {
  mode: 'inline';
  bases: string;
  length: number;
  contentHash?: string;
};

export type FileAminoAcidSequenceRef = {
  mode: 'file';
  relPath: string;
  workspaceId?: number | null;
  length: number;

  contentHash: string;
  fileContentHash?: string;
  normalizedSequenceHash?: string;
  sourceFormat: AminoAcidSequenceSourceFormat;
  sequenceId?: number | null;
  sizeBytes?: number | null;
  modifiedAt?: number | null;
};

export type UnresolvedAminoAcidSequenceRef = {
  mode: 'unresolved';
};

export type AminoAcidSequenceRef =
  | InlineAminoAcidSequenceRef
  | FileAminoAcidSequenceRef
  | UnresolvedAminoAcidSequenceRef;

export type RnaSequenceRef =
  | {
      mode: 'inline';
      bases: string;
      topology: DnaSequenceTopology;
      length: number;
      contentHash?: string;
    }
  | {
      mode: 'file';
      documentId?: string;
      acceptedRevisionId?: string;
      relPath: string;
      workspaceId?: number | null;
      topology: DnaSequenceTopology;
      length: number;
      contentHash: string;
      fileContentHash?: string;
      normalizedSequenceHash?: string;
      sourceFormat: DnaSequenceSourceFormat;
      sequenceId?: number | null;
      sizeBytes?: number | null;
      modifiedAt?: number | null;
    }
  | { mode: 'unresolved' };

export type ProteinSequenceRef =
  | {
      mode: 'inline';
      aminoAcids: string;
      length: number;
      contentHash?: string;
    }
  | {
      mode: 'file';
      representation: 'portable';
      relPath: string;
      length: number;
      contentHash: string;
      sourceFormat: 'fasta' | 'genbank' | 'pdb' | 'mmcif' | 'unknown';
    }
  | { mode: 'unresolved' };

export type LimsQuantityValue = {
  lexical: string;
  value: number | null;
  unit: string;
  compatibility: 'compatible' | 'unrecognized' | 'incompatible';
};

export type LimsRecordRelationshipValue = {
  relationType: string;
  label: string;
} & (
  | { origin?: never; sourceTargetId: string; destinationEntityId: string; resolution: 'exact' }
  | {
      origin?: never;
      sourceTargetId: string;
      destinationEntityId: null;
      resolution: 'source_broken';
    }
  | { origin: 'native'; sourceTargetId?: never; destinationEntityId: string; resolution: 'exact' }
);

export type LimsAttachmentReferenceValue = {
  sha256: string;
  logicalName: string;
  relativePath: string;
  mediaType?: string;
};

export type LimsFormulaResultValue = {
  formula: string;
  sourceValue: string | number | boolean | null;
  calculatedValue?: string | number | boolean | null;
  compatibility: 'supported' | 'unsupported';
  stale: boolean;
};

export interface LimsFieldDefinition {
  key: string;
  label: string;
  type: LimsFieldType;
  required?: boolean;
  suggested?: boolean;
  enumOptions?: readonly string[];
  maxLength?: number;
  minValue?: number;
  maxValue?: number;
  minDate?: string;
  maxDate?: string;
  agenda?: { role: 'milestone' | 'deadline' | 'observation'; zone?: string };
  description?: string;

  requireResolved?: boolean;

  intrinsic?: 'sequence.length' | 'sequence.topology' | 'sequence.geneticCode';

  readOnly?: boolean;
}

export function requireSupportedLimsFieldDefinitions(
  fields: readonly EntitySchemaFieldSnapshot[]
): LimsFieldDefinition[] {
  return fields.map((field) => {
    if (!isLimsFieldType(field.type))
      throw new Error(
        `UNSUPPORTED_SCHEMA_FIELD_TYPE: This version cannot edit the field type ${field.type}.`
      );
    return { ...field, type: field.type };
  });
}

export interface LimsBuiltinSchemaDefinition {
  kind: LimsSchemaKind;
  name: string;

  baseKind?: string;

  version?: number;
  displayName: string;
  description: string;
  builtin: boolean;
  fields: readonly LimsFieldDefinition[];
  relationship?: LimsRelationshipTypeDefinition;
}

export interface LimsSchemaDefinitionView {
  schemaId: string;
  currentRevisionId: string;
  entityKind: string;
  baseKind: string;
  displayName: string;

  description: string | null;
  version: number;
  builtin: boolean;
  fields: LimsFieldDefinition[];
}

export interface LimsSchemaRow {
  id: string;
  kind: LimsSchemaKind;
  name: string;
  display_name: string;
  description: string | null;
  fields: string;
  current_revision_id: string | null;
  version: number;
  builtin: number;
  workspace_id: number | null;
  actor: string | null;
  event_seq: number | null;
  tombstone: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

export interface LimsSchemaRevisionRow {
  id: string;
  schema_id: string;
  version: number;
  fields: string;
  actor: string | null;
  workspace_id: number | null;
  event_seq: number | null;
  tombstone: number;
  created_at: number;
  archived_at: number | null;
}

export interface LimsEntityRow {
  id: string;
  kind: LimsEntityKind | string;
  schema_id: string | null;
  schema_revision_id: string;
  name: string;
  registry_id?: string | null;
  fields: string;
  registration_status: LimsRegistrationStatus;
  domain_status: string | null;
  workspace_id: number | null;
  actor: string | null;
  event_seq: number | null;
  tombstone: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

export interface LimsLinkRow {
  id: string;
  from_entity_id: string;
  to_entity_id: string;
  type: string;
  payload: string;
  workspace_id: number | null;
  actor: string | null;
  event_seq: number | null;
  tombstone: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

export interface LimsAuditRow {
  id: string;
  event_seq: number;
  schema_version: number | null;
  idempotency_key: string | null;
  operation_id: string | null;
  event_type: string;
  subject_table: string | null;
  subject_id: string | null;
  batch_id: string | null;
  actor: string | null;
  actor_client_id: string | null;
  actor_user_id: string | null;
  workspace_id: number | null;
  before: string | null;
  after: string | null;
  payload: string | null;
  prev_hash: string | null;
  hash: string | null;
  tombstone: number;
  created_at: number;
}

export interface LimsContentPin {
  entityId: string;
  field: string;
  relPath: string;
  contentHash: string;
  commit: string;
  ref: string;
  repoPath?: string;
}

export interface LimsEntity {
  id: string;
  kind: string;
  schemaId: string | null;
  schemaRevisionId: string;
  name: string;

  registryId: string | null;
  fields: Record<string, unknown>;
  registrationStatus: LimsRegistrationStatus;
  domainStatus: string | null;

  workspaceId: number | null;
  actor: string | null;
  eventSeq: number | null;
  tombstone: boolean;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface LimsLink {
  id: string;
  fromEntityId: string;
  toEntityId: string;
  type: string;
  payload: Record<string, unknown>;
  workspaceId: number | null;
  actor: string | null;
  eventSeq: number | null;
  tombstone: boolean;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface LimsRegisterEntityInput {
  id?: string;
  kind: LimsEntityKind | string;
  name: string;
  fields: Record<string, unknown>;
  registrationStatus?: LimsRegistrationStatus;
  domainStatus?: string | null;
  schemaRevisionId?: string;

  schemaSnapshot?: ProjectableEntitySchemaRevisionSnapshot;

  workspaceId?: number | null;
  actor?: string | null;
  batchId?: string | null;

  createdAt?: number;

  initialState?: { updatedAt: number; archived: boolean; archivedAt: number | null };
  failAfterEntityInsert?: boolean;
}

export type LimsRecordRelationshipTargetQuery = {
  entityId: string;
  search?: string;
  offset?: number;
};
export type LimsRecordRelationshipTarget = {
  id: string;
  name: string;
  registryId: string | null;
  kind: string;
};
export type LimsRecordRelationshipTargetPage = {
  targets: LimsRecordRelationshipTarget[];
  hasMore: boolean;
};

export interface LimsUpdateEntityInput {
  id: string;

  expectedEventSeq?: number;

  operationId?: string;
  name?: string;
  fields?: Record<string, unknown>;

  relationshipTargets?: Record<string, string | null>;

  replaceFields?: boolean;

  projectionSchema?: {
    kind: string;
    schemaRevisionId: string;
    schemaSnapshot: ProjectableEntitySchemaRevisionSnapshot;
  };
  registrationStatus?: LimsRegistrationStatus;
  domainStatus?: string | null;

  workspaceId?: number | null;
  actor?: string | null;
  batchId?: string | null;
}

export interface LimsEntityActionInput {
  id: string;
  actor?: string | null;
  expectedEventSeq?: number;
  operationId?: string;
}

export interface LimsRevertEntityResult {
  reverted: boolean;
  entity: LimsEntity;

  reason?: 'no-prior-edit';
}

export const LIMS_ENTITY_STATE_EVENT_TYPES = [
  'entity_registered',
  'entity_updated',
  'entity_reverted',
  'entity_archived',
  'entity_restored',
  'entity_tombstoned',
  'entity_registry_id_assigned',
] as const;

export type LimsEntityStateEventType = (typeof LIMS_ENTITY_STATE_EVENT_TYPES)[number];

export interface LimsEntityHistoryInput {
  entityId: string;
}

export interface LimsFieldChange {
  label: string;
  field: string;
  kind: 'added' | 'changed' | 'removed';

  before?: string;

  after?: string;

  description?:
    | 'Schema changed'
    | 'Sequence changed'
    | 'Imported metadata updated'
    | 'Saved molecular result changed'
    | 'Metadata value updated';
}

export interface LimsEntityHistoryEntry {
  eventSeq: number;
  eventType: LimsEntityStateEventType;

  label: string;
  actor: string | null;

  at: number;

  changes: LimsFieldChange[];
}

export interface LimsPendingRefCandidate {
  id: string;
  name: string;
  kind: string;
}

export interface LimsPendingRef {
  key: string;
  referrerEntityId: string;
  referrerName: string;
  type: string;
  targetKind: string | null;
  targetName: string;
  normalizedTargetName: string;
  targetProviderIdentity?: LimsImportUnresolvedLink['targetProviderIdentity'];
  sourceBatchId: string;

  status: 'open' | 'draft' | 'ambiguous' | 'resolved' | 'dismissed';

  candidateEntityIds: string[];
  candidates: LimsPendingRefCandidate[];
}

export interface LimsPendingRefActionInput {
  key: string;
  actor?: string | null;
}
export interface LimsConfirmPendingRefInput extends LimsPendingRefActionInput {
  targetEntityId: string;
}
export interface LimsRejectPendingRefCandidateInput extends LimsPendingRefActionInput {
  rejectedEntityId: string;
}

export interface LimsLinkEntitiesInput {
  id?: string;
  fromEntityId: string;
  toEntityId: string;
  type: string;
  payload?: Record<string, unknown>;
  actor?: string | null;
  workspaceId?: number | null;
  batchId?: string | null;
}

export interface LimsReplaceOutgoingRelationshipsInput {
  entityId: string;
  expectedEventSeq?: number;
  operationId?: string;
  schemaSnapshots?: readonly ProjectableRelationshipSchemaRevisionSnapshot[];
  relationships: ReadonlyArray<{
    toEntityId: string;
    type: string;
    payload?: Record<string, unknown>;
  }>;
  actor?: string | null;
  workspaceId?: number | null;
}

export interface LimsReplaceOutgoingRelationshipsResult {
  active: LimsLink[];
  tombstoned: number;
}

export type LimsGenomeConfidence =
  | 'genotype_parent_reference'
  | 'hypothesis_supplied'
  | 'hypothesis_from_genotype_projection'
  | 'partially_verified'
  | 'WGS_verified';

export type LimsGenotypeEdit =
  | {
      kind: 'deletion';
      token: string;
      target: { type: 'feature'; name: string } | { type: 'range'; start: number; end: number };
    }
  | {
      kind: 'marker_replacement';
      token: string;
      target: { type: 'feature'; name: string };
      markerName: string;
    }
  | {
      kind: 'insertion';
      token: string;
      position: number;
      bases: string;
    }
  | {
      kind: 'substitution';
      token: string;
      position: number;
      refBase?: string;
      altBase: string;
    };

export interface LimsParsedGenotype {
  genotype: string;
  edits: LimsGenotypeEdit[];
  errors: string[];
}

export interface LimsProjectGenomeFromGenotypeInput {
  strainEntityId: string;
  parentGenomeEntityId: string;
  hypothesisGenomeId?: string;
  hypothesisGenomeName?: string;
  markerGenomeEntityIds?: Record<string, string>;
  outputPath?: string;
  actor?: string | null;
  batchId?: string | null;
}

export interface LimsProjectGenomeFromGenotypeResult {
  strain: LimsEntity;
  parentGenome: LimsEntity;
  hypothesisGenome: LimsEntity;
  hasGenomeLink: LimsLink;
  derivesFromLink: LimsLink;
  parsed: LimsParsedGenotype;
  outputPath: string;
  parentLength: number;
  hypothesisLength: number;
  appliedEditCount: number;
}

export interface LimsRecordStrainParentGenomeInput {
  strainEntityId: string;
  parentGenomeEntityId: string;
  actor?: string | null;
  batchId?: string | null;
}

export interface LimsRecordStrainParentGenomeResult {
  link: LimsLink;
  gap: LimsGenomeGapSummary;
}

export interface LimsAttachGenomeHypothesisInput {
  strainEntityId: string;
  hypothesisGenomeEntityId: string;
  parentGenomeEntityId?: string;
  method?: string;
  actor?: string | null;
  batchId?: string | null;
}

export interface LimsAttachGenomeHypothesisResult {
  hasGenomeLink: LimsLink;
  derivesFromLink?: LimsLink;
  parentReferenceLink?: LimsLink;
  gap: LimsGenomeGapSummary;
}

export interface LimsAttachVerifiedGenomeInput {
  strainEntityId: string;
  verifiedGenomeEntityId: string;
  hypothesisGenomeEntityId?: string;
  method?: string;
  coverage?: number;
  actor?: string | null;
  batchId?: string | null;
}

export interface LimsSequenceDifference {
  position: number;
  hypothesisBase: string;
  verifiedBase: string;
}

export interface LimsGenomeGapSummary {
  status: 'no_hypothesis' | 'no_verified' | 'unresolved' | 'match' | 'mismatch';
  hypothesisGenomeId?: string;
  verifiedGenomeId?: string;
  hypothesisLength?: number;
  verifiedLength?: number;
  lengthDelta?: number;
  mismatchCount?: number;
  firstDifferences?: LimsSequenceDifference[];
  message: string;
}

export interface LimsAttachVerifiedGenomeResult {
  hasGenomeLink: LimsLink;
  verifiedByLink?: LimsLink;
  gap: LimsGenomeGapSummary;
}

export interface LimsStrainGenomeSummaryInput {
  strainEntityId: string;
}

export interface LimsStrainGenomeSummary {
  strain: LimsEntity;
  parentGenome: LimsEntity | null;
  hypothesisGenome: LimsEntity | null;
  verifiedGenome: LimsEntity | null;
  parentLink: LimsLink | null;
  hypothesisLink: LimsLink | null;
  verifiedLink: LimsLink | null;
  gap: LimsGenomeGapSummary;
}

export interface LimsStrainGenomeSummariesInput {
  strainEntityIds: string[];
}

export interface LimsStrainGenomeSummariesResult {
  summaries: Record<string, LimsStrainGenomeSummary>;
}

export type LimsRegistryRepresentationKind =
  | 'record_file'
  | 'primer'
  | 'file_sequence'
  | 'protein_sequence'
  | 'track_view'
  | 'molecular_document'
  | 'inline_sequence'
  | 'genome_assembly'
  | 'strain_evidence'
  | 'organism_record'
  | 'notebook'
  | 'unresolved'
  | 'none';

export const LIMS_REGISTRY_SORTS = [
  'name_asc',
  'name_desc',
  'updated_desc',
  'updated_asc',
  'kind_asc',
  'kind_desc',
  'status_asc',
  'status_desc',
  'registry_id_asc',
  'registry_id_desc',
] as const;
export type LimsRegistrySort = (typeof LIMS_REGISTRY_SORTS)[number];

export type LimsRegistrySortColumn = 'name' | 'kind' | 'status' | 'registry_id' | 'updated';

export interface LimsIdScheme {
  kind: string;
  prefix: string;
  padWidth: number;
  nextSeq: number;
  enabled: boolean;
  updatedAt: number;
}

export interface LimsSetIdSchemeInput {
  kind: string;
  prefix?: string;
  padWidth?: number;
  enabled?: boolean;
  actor?: string | null;
}

export interface LimsBackfillRegistryIdsInput {
  kind?: string;
  actor?: string | null;
}

export interface LimsBackfillRegistryIdsResult {
  assigned: number;
  byKind: Record<string, number>;
}

export const LIMS_ID_SCHEME_MAX_PAD_WIDTH = 12;

export const LIMS_DEFAULT_ID_SCHEMES: Record<LimsEntityKind, { prefix: string; padWidth: number }> =
  {
    sequence: { prefix: 'dna', padWidth: 6 },
    oligo: { prefix: 'o', padWidth: 6 },
    rna_oligo: { prefix: 'ro', padWidth: 6 },
    plasmid: { prefix: 'p', padWidth: 6 },
    genome: { prefix: 'g', padWidth: 6 },
    chromosome: { prefix: 'chr', padWidth: 6 },
    strain: { prefix: 's', padWidth: 6 },
    organism: { prefix: 'org', padWidth: 6 },
    protein: { prefix: 'aa', padWidth: 6 },
    dna_sequence: { prefix: 'dna', padWidth: 6 },
    rna_sequence: { prefix: 'rna', padWidth: 6 },
    guide_rna: { prefix: 'grna', padWidth: 6 },
    allele: { prefix: 'al', padWidth: 6 },
    locus: { prefix: 'loc', padWidth: 6 },
    part: { prefix: 'pt', padWidth: 6 },
    fragment: { prefix: 'fr', padWidth: 6 },
    marker: { prefix: 'mk', padWidth: 6 },
    external_ref: { prefix: 'ext', padWidth: 6 },
    notebook: { prefix: 'nb', padWidth: 6 },
    'track-view': { prefix: 'tv', padWidth: 6 },
    'molecular-document': { prefix: 'mv', padWidth: 6 },
  };

export function formatRegistryId(prefix: string, padWidth: number, seq: number): string {
  const width = Math.max(0, Math.min(padWidth, LIMS_ID_SCHEME_MAX_PAD_WIDTH));
  return `${prefix}${String(seq).padStart(width, '0')}`;
}

const GENERIC_SEQUENCE_NAME_RE =
  /^(?:sequence|seq|untitled|unnamed|export(?:ed)?|no[-_ ]?name|new[-_ ]?sequence|scaffold|contig)[-_ ]?\d*[-_ ]?$/i;

export function isGenericSequenceName(name: string | null | undefined): boolean {
  const n = name?.trim();
  if (!n) return true;
  if (GENERIC_SEQUENCE_NAME_RE.test(n)) return true;
  if (/^\d+$/.test(n)) return true;
  return false;
}

const SEQUENCE_FILE_EXT_RE = /\.(?:gb|gbk|gbff|genbank|fa|fasta|fna|ffn|dna|seq|txt)$/i;

function locusIsTruncationOf(locus: string, stem: string): boolean {
  if (stem.length <= locus.length || !stem.startsWith(locus)) return false;
  return /[A-Za-z0-9]/.test(stem.charAt(locus.length));
}

export function deriveImportedSequenceName(
  parsedName: string | null | undefined,
  fileName: string
): string {
  const parsed = parsedName?.trim();
  const stem = (fileName ?? '').trim().replace(SEQUENCE_FILE_EXT_RE, '').trim();
  if (parsed && !isGenericSequenceName(parsed)) {
    if (stem && locusIsTruncationOf(parsed, stem)) return stem;
    return parsed;
  }
  if (stem && !isGenericSequenceName(stem)) return stem;
  return parsed || stem || (fileName ?? '').trim() || 'Sequence';
}

export type LimsRegistryOpenTarget =
  | {
      kind: 'record_file';
      entityId: string;
      entityKind: string;
      label: string;
      workspaceId: number;
      artifactRelativePath: string;
    }
  | {
      kind: 'primer';
      entityId: string;
      entityKind: string;
      label: string;
      workspaceId: number | null;
      artifactRelativePath: string;
    }
  | {
      kind: 'molecular_document';
      entityId: string;
      entityKind: string;
      label: string;
    }
  | {
      kind: 'track_view';
      entityId: string;
      entityKind: string;
      label: string;
    }
  | {
      kind: 'managed_sequence';
      entityId: string;
      entityKind: string;
      label: string;
      registrationStatus: LimsRegistrationStatus;
      document: import('./managed-sequence-document').ManagedSequenceDocumentRef;
    }
  | {
      kind: 'sequence_file';
      entityId: string;
      entityKind: string;
      label: string;
      documentId: string;
      registrationStatus: LimsRegistrationStatus;
      sequence: Pick<
        FileDnaSequenceRef,
        | 'topology'
        | 'length'
        | 'contentHash'
        | 'fileContentHash'
        | 'normalizedSequenceHash'
        | 'sourceFormat'
        | 'sequenceId'
        | 'sizeBytes'
        | 'modifiedAt'
      >;
      source?: string;
    }
  | {
      kind: 'protein_sequence';
      entityId: string;
      entityKind: string;
      label: string;

      filePath?: string;
      registrationStatus: LimsRegistrationStatus;
    }
  | {
      kind: 'notebook';
      entityId: string;
      entityKind: string;
      label: string;
      filePath?: string;
    }
  | {
      kind: 'record_detail';
      entityId: string;
      entityKind: string;
      label: string;
      reason:
        | 'inline_sequence'
        | 'strain_evidence'
        | 'organism_record'
        | 'unresolved_sequence'
        | 'no_primary_representation';
      inlineSequence?: Pick<InlineDnaSequenceRef, 'length' | 'topology' | 'contentHash'>;
    }
  | {
      kind: 'missing_entity';
      entityId: string;
      label: string;
      reason: 'not_found';
    };

export interface LimsRegistrySummary {
  id: string;
  workspaceId?: number | null;
  kind: string;

  schemaSnapshot: ProjectableEntitySchemaRevisionSnapshot;

  fieldValues: Record<string, unknown>;
  schemaDisplayName?: string;
  eventSeq?: number | null;
  name: string;
  registryId: string | null;
  registrationStatus: LimsRegistrationStatus;
  domainStatus: string | null;

  organism?: { speciesTaxid: string; speciesName: string } | null;
  representation: {
    kind: LimsRegistryRepresentationKind;
    label: string;
    canOpen: boolean;
    openTarget?: LimsRegistryOpenTarget;
  };
  summary: string;
  evidenceSummary?: {
    confidenceLabel: string;
    gapStatus: LimsGenomeGapSummary['status'];
    gapMessage: string;
    parentGenomeName?: string;
    hypothesisGenomeName?: string;
    verifiedGenomeName?: string;
  };
  sequenceSummary?: {
    topology?: DnaSequenceTopology;
    length?: number;
    sourceFormat?: DnaSequenceSourceFormat;
    inlineBases?: string;
    contentHash?: string;
    fileContentHash?: string;
    normalizedSequenceHash?: string;
  };
  linkSummary: {
    outgoingCount: number;
    incomingCount: number;
    notable: Array<{ type: string; label: string; entityId: string }>;
  };
  searchableText: string;
  updatedAt: number;

  archived: boolean;
}

export interface LimsRegistryDateFilter {
  schemaId: string;
  fieldKey: string;
  mode: 'on' | 'before' | 'after' | 'missing' | 'unresolved';
  value?: string;
}

export interface LimsQueryRegistrySummariesInput {
  workspaceIds?: readonly number[];

  search?: string;

  nameLike?: string;

  sequenceLike?: string;

  registryIdLike?: string;

  kind?: string;

  kinds?: string[];

  registrationStatus?: LimsRegistrationStatus;

  registrationStatuses?: LimsRegistrationStatus[];

  speciesTaxids?: string[];
  domainStatus?: string | null;
  representationKind?: LimsRegistryRepresentationKind;

  updatedAfter?: number;
  updatedBefore?: number;
  updatedOn?: number;
  dateFilters?: readonly LimsRegistryDateFilter[];
  dateSort?: { schemaId: string; fieldKey: string; direction: 'asc' | 'desc' };
  sort?: LimsRegistrySort;
  limit?: number;
  offset?: number;
  includeArchived?: boolean;

  ids?: readonly string[];
}

export interface LimsRegistrySummaryPage {
  eventSeq?: number;
  summaries: LimsRegistrySummary[];
  totalCount: number;
  limit: number;
  offset: number;

  availableOrganisms?: { speciesTaxid: string; speciesName: string; count: number }[];

  availableProjects?: { workspaceId: number; name: string; count: number }[];
}

export interface LimsRegistryPreviewInput {
  entityId: string;
}

export interface LimsRegistryLinkedEntitySummary {
  link: LimsLink;
  entity: Pick<LimsEntity, 'id' | 'kind' | 'name' | 'registrationStatus' | 'domainStatus'>;
  summary: LimsRegistrySummary;
}

export interface LimsRegistryPreview {
  entity: LimsEntity;
  summary: LimsRegistrySummary;

  classificationEligible?: boolean;

  acceptedScientificOwner?: boolean;
  savedLifecycleAuthority?: 'sequence_package';
  schemaSnapshot: ProjectableEntitySchemaRevisionSnapshot;
  outgoingLinks: LimsRegistryLinkedEntitySummary[];
  incomingLinks: LimsRegistryLinkedEntitySummary[];
  strainGenomeSummary?: LimsStrainGenomeSummary;
  nativeRecord?: {
    schemaSnapshot: ProjectableEntitySchemaRevisionSnapshot;
    scientificAuthority?: ScientificStrainEditAuthority;
  };
  originalSource?: import('./benchling-migration-raw-source').ExternalProviderSourceRequest;
}

export interface ScientificStrainEditAuthority {
  readonly workspaceRoot: string;
  readonly workspaceId: number;
  readonly artifactPath: string;
  readonly revision: ScientificAcceptedDocumentRevision;
}

export interface LimsSeedDemoDatasetInput {
  actor?: string | null;
  outputDir?: string;

  reset?: boolean;
}

export interface LimsSeedDemoDatasetAssetSource {
  role: string;
  path: string;
  used: boolean;
}

export interface LimsSeedDemoDatasetResult {
  batchId: string;
  insertedEntities: number;
  existingEntities: number;
  insertedLinks: number;
  existingLinks: number;
  entities: LimsEntity[];
  strainSummary: LimsStrainGenomeSummary;
  assetSources: LimsSeedDemoDatasetAssetSource[];
}

export interface LimsSeedMockDemoInput {
  actor?: string | null;

  reset?: boolean;

  resetScope?: 'all' | 'dev-seed';
}

export interface LimsSeedStarterRegistryInput {
  actor?: string | null;

  reset?: boolean;
}

export interface LimsResetRegistryResult {
  cleared: true;
  entityCount: 0;
}

export interface LimsSeedStarterRegistryResult {
  batchId: string;
  insertedEntities: number;
  existingEntities: number;
  insertedLinks: number;
  strainIds: string[];
  genomeIds: string[];
  oligoIds: string[];
}

export interface LimsSeedMockDemoResult {
  batchId: string;
  insertedOligos: number;
  existingOligos: number;

  plasmidId: string;

  genomeId: string;
  heroOligoIds: string[];
  insertedLinks: number;
}

export interface LimsSeedPracticeDemoInput {
  actor?: string | null;

  reset?: boolean;

  resetScope?: 'all' | 'dev-seed';
}

export interface LimsSeedPracticeDemoResult {
  batchId: string;
  insertedPlasmids: number;
  insertedOligos: number;

  insertedGenomeEntities: number;
  existingEntities: number;

  sampleEntityId: string | null;
}

export interface LimsDefineSchemaInput {
  id?: string;
  kind: LimsSchemaKind;
  name: string;

  baseKind?: string;
  displayName: string;
  description?: string | null;
  fields: readonly LimsFieldDefinition[];
  builtin?: boolean;
  actor?: string | null;
  workspaceId?: number | null;

  existingPolicy?: 'reuse' | 'reject';
}

export interface LimsRefineSchemaInput {
  schemaId: string;

  expectedRevisionId?: string;
  fields: readonly LimsFieldDefinition[];
  description?: string | null;
  actor?: string | null;
  workspaceId?: number | null;
}

export interface LimsQueryEntitiesInput {
  id?: string;
  kind?: string;

  workspaceId?: number;

  sequenceDocumentId?: string;
  nameLike?: string;
  registrationStatus?: LimsRegistrationStatus;
  includeArchived?: boolean;
  fieldEquals?: Record<string, unknown>;
  limit?: number;
}

export interface LimsRegistrationBadgeInput {
  documentId: string;
}

export interface LimsRegistrationBadgeCandidate {
  entity: LimsEntity;
  sequence: Pick<FileDnaSequenceRef, 'sizeBytes' | 'modifiedAt' | 'contentHash'>;
}

export interface LimsPrimerUnionRow {
  id: string;
  source: 'lims' | 'legacy_primers';

  origin: string | null;
  name: string;
  sequence: string;
  length: number;
  catalogNumber: string | null;
  limsEntityId: string | null;
  legacyPrimerId: string | null;
  status: string | null;
  notes: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface LimsImportLinkPreview {
  type: string;
  fromEntityId?: string;
  fromEntityLookup?: {
    kind?: string;
    name: string;
  };
  toEntityId?: string;
  toEntityLookup?: {
    kind?: string;
    name: string;
  };

  suggested?: boolean;
  payload: Record<string, unknown>;
}

export type LimsImportPlanSourceKind = 'csv' | 'tsv' | 'xlsx' | 'genbank' | 'fasta' | 'mixed';
export type LimsImportPlanDetectedKind =
  | 'sequence_file'
  | 'primer_table'
  | 'strain_table'
  | 'mixed_table';
export type LimsImportPlanAction = 'create' | 'skip';
export type LimsImportPlanMappingConfidence =
  | 'deterministic'
  | 'agent_suggested'
  | 'user_overridden'
  | 'learned';
export type LimsImportColumnMappingMode = 'mapped' | 'source_only' | 'ignored';

export interface LimsImportColumnMappingOverride {
  sourceColumn: string;
  mappedField?: string;
  mappingMode?: LimsImportColumnMappingMode;
  confidence?: LimsImportPlanMappingConfidence;
}

export interface LimsImportPlanColumn {
  sourceColumn: string;
  mappedField?: string;
  mappingMode: LimsImportColumnMappingMode;
  confidence: LimsImportPlanMappingConfidence;
  warnings: string[];
}

export interface LimsImportDuplicateCandidate {
  entityId: string;
  name: string;
  reason: string;
}

export interface LimsImportUnresolvedLink {
  label: string;
  kind?: string;
  type?: string;

  targetProviderIdentity?: {
    provider: ProviderObjectReferenceProvider;
    stableObjectId: string;
    objectClass: ProviderObjectClass;
  };

  severity: 'advisory' | 'blocking' | 'provisional_stub' | 'ambiguous';

  candidateEntityIds?: string[];
  reason: string;
}

export interface LimsImportPlanRecord {
  id: string;
  sourceRow?: number;

  externalRowId?: string;

  sequenceNotation?: string;
  accepted: boolean;
  action: LimsImportPlanAction;
  entityDraft: LimsRegisterEntityInput;
  requiresRegistrationKind?: boolean;

  suggestedKind?: LimsEntityKind;
  kindEvidence?: string;
  duplicateCandidates: LimsImportDuplicateCandidate[];
  duplicateDecision?: { kind: 'skip' } | { kind: 'reuse'; entityId: string };
  proposedLinks: LimsImportLinkPreview[];
  unresolvedLinks: LimsImportUnresolvedLink[];
  errors: string[];
  warnings: string[];
  source: Record<string, unknown>;
}

export type SheetVerdict =
  | 'entity-table'
  | 'possible-table'
  | 'metadata-notes'
  | 'low-density'
  | 'empty'
  | 'leftover-region';

export const SHEET_VERDICTS: readonly SheetVerdict[] = [
  'entity-table',
  'possible-table',
  'metadata-notes',
  'low-density',
  'empty',
  'leftover-region',
] as const;

export interface SheetDisposition {
  sheetName: string;
  verdict: SheetVerdict;

  score: number;

  rowCount: number;

  headerRowIndex?: number;
  reason?: string;
}

export interface ImportableSheet {
  sheetName: string;
  verdict: Extract<SheetVerdict, 'entity-table' | 'possible-table'>;
  rowCount: number;
}

export function listImportableSheets(
  dispositions: SheetDisposition[] | undefined
): ImportableSheet[] {
  if (!dispositions) return [];
  const importable: ImportableSheet[] = [];
  for (const d of dispositions) {
    if (d.verdict === 'entity-table' || d.verdict === 'possible-table') {
      importable.push({ sheetName: d.sheetName, verdict: d.verdict, rowCount: d.rowCount });
    }
  }
  return importable;
}

export interface LimsImportPlan {
  importFamily?: string;
  review?: { id: string; revision: string };
  schemaFields?: readonly LimsFieldDefinition[];
  schemaRevisionId?: string;
  id: string;
  sourceName: string;
  sourceKind: LimsImportPlanSourceKind;
  detectedKind: LimsImportPlanDetectedKind;
  columns: LimsImportPlanColumn[];
  records: LimsImportPlanRecord[];
  aggregateWarnings: string[];
  defaultKind?: LimsEntityKind;

  forcedKind?: string;
  canApply: boolean;
  oracle: LimsImportOracleResult;

  sheetDispositions?: SheetDisposition[];

  selectedSheet?: string;
}

export interface LimsSourceMetadata {
  schemaVersion: 1;
  origin:
    | {
        type: 'file_import';
        sourceName: string;
        sourceKind: LimsImportPlanSourceKind;
      }
    | {
        type: 'connector';
        connectorType: string;
        connectionId?: string;
        sourceName?: string;
        sourceId?: string;
      }
    | {
        type: 'manual';
      };
  importRecordId?: string;
  row?: {
    index?: number;
    id?: string;
    sheetName?: string;
  };
  values: Record<string, unknown>;

  entries?: Array<{
    label: string;
    value: string;
    position: number;
  }>;
}

export interface LimsImportRecord {
  id: string;
  action: 'register_entity';
  accepted: boolean;
  entity: LimsRegisterEntityInput;
  requiresRegistrationKind?: boolean;

  suggestedKind?: LimsEntityKind;
  kindEvidence?: string;
  links?: LimsImportLinkPreview[];
  unresolvedLinks?: LimsImportUnresolvedLink[];
  sourceRow?: number;

  externalRowId?: string;

  sequenceNotation?: string;
  source: Record<string, unknown>;
  duplicateOf?: string | null;
  duplicateName?: string | null;
  duplicateReason?: string | null;
  errors?: string[];

  warnings?: string[];
}

export interface LimsImportOracleResult {
  ok: boolean;
  source: string;
  invariants: Array<{
    id: string;
    ok: boolean;
    message: string;
    recordId?: string;
  }>;
}

export interface LimsApplyImportBatchInput {
  batchId?: string;
  sourceName: string;
  sourceKind: 'csv' | 'tsv' | 'xlsx' | 'genbank' | 'fasta' | 'mixed';
  records: readonly LimsImportRecord[];
  actor?: string | null;
  oracle?: LimsImportOracleResult;
}

export interface LimsApplyImportBatchResult {
  batchId: string;
  insertedEntities: number;
  insertedLinks: number;
  skipped: number;
  insertedEntityIds: Array<{ recordId: string; entityId: string }>;
  insertedLinkIds: Array<{ recordId: string; linkId: string }>;
  skippedRecordIds: string[];
  unresolvedLinks: Array<{ recordId: string; link: LimsImportUnresolvedLink }>;
  errors: Array<{ recordId: string; reason: string }>;
}

export interface LimsUndoImportBatchInput {
  batchId: string;
  actor?: string | null;
}

export interface LimsUndoImportBatchResult {
  batchId: string;
  tombstonedEntities: number;
  tombstonedLinks: number;
  skippedEntities: number;
  skippedLinks: number;
}

export interface LimsTelemetryInput {
  eventType: 'badge_consulted' | 'import_accuracy_evaluated' | 'register_consulted';
  subjectTable?: string | null;
  subjectId?: string | null;
  payload?: Record<string, unknown>;
  actor?: string | null;
  workspaceId?: number | null;
}

export const DNA_SEQUENCE_MAX_INLINE_BASES = 1000;

export const LIMS_OLIGO_USES = [
  'primer',
  'probe',
  'sgRNA',
  'gBlock',
  'ultramer',
  'sequencing',
  'mutagenesis',
  'other',
] as const;

function oligoSchemaFields(sequenceType: 'dna_sequence' | 'rna_sequence'): LimsFieldDefinition[] {
  return [
    {
      key: 'sequence',
      label: 'Sequence',
      type: sequenceType,
      required: true,

      requireResolved: true,
      maxLength: DNA_SEQUENCE_MAX_INLINE_BASES,
    },
    {
      key: 'use',
      label: 'Use',
      type: 'enum',
      suggested: true,
      enumOptions: [...LIMS_OLIGO_USES],
    },
    {
      key: 'status',
      label: 'Status',
      type: 'enum',
      suggested: true,
      enumOptions: ['designed', 'ordered', 'received', 'verified', 'archived'],
    },
    { key: 'purification', label: 'Purification', type: 'text', suggested: true },
    { key: 'scale', label: 'Scale', type: 'text', suggested: true },
    { key: 'modifications', label: 'Modifications', type: 'text', suggested: true },
    { key: 'vendor', label: 'Vendor', type: 'text', suggested: true },
    { key: 'catalogNumber', label: 'Catalog number', type: 'text', suggested: true },
    { key: 'notes', label: 'Notes', type: 'long_text', suggested: true },
  ];
}

export const LIMS_BUILTIN_ENTITY_SCHEMAS: readonly LimsBuiltinSchemaDefinition[] = [
  {
    kind: 'entity',
    name: 'sequence',
    version: 1,
    displayName: 'DNA sequence',
    description: 'A managed DNA sequence package.',
    builtin: true,
    fields: SEQUENCE_SCHEMA_V1_FIELD_DEFINITIONS.map((field) => ({ ...field })),
  },
  {
    kind: 'entity',
    name: 'oligo',
    displayName: 'DNA Oligo',
    description: 'System of record for DNA oligos. Primer is a use, not a separate type.',
    builtin: true,
    fields: oligoSchemaFields('dna_sequence'),
  },
  {
    kind: 'entity',
    name: 'rna_oligo',
    displayName: 'RNA Oligo',
    description: 'System of record for RNA oligos. Primer is a use, not a separate type.',
    builtin: true,
    fields: oligoSchemaFields('rna_sequence'),
  },
  {
    kind: 'entity',
    name: 'plasmid',
    baseKind: 'sequence',
    version: 2,
    displayName: 'Plasmid',
    description: 'A user-configurable sequence-backed plasmid record.',
    builtin: true,
    fields: PLASMID_SCHEMA_FIELD_DEFINITIONS.map((field) => ({ ...field })),
  },
  {
    kind: 'entity',
    name: 'genome',
    displayName: 'Genome',
    description: 'Genome identity. Sequence may be unresolved before import or evidence linking.',
    builtin: true,
    fields: [
      { key: 'sequence', label: 'Sequence', type: 'dna_sequence', suggested: true },
      {
        key: 'assemblyLevel',
        label: 'Assembly level',
        type: 'enum',
        suggested: true,
        enumOptions: ['complete_genome', 'chromosome', 'scaffold', 'contig', 'unknown'],
      },
      {
        key: 'source',
        label: 'Source',
        type: 'enum',
        suggested: true,
        enumOptions: [
          'reference',
          'WGS',
          'resequenced',
          'computational_projection',
          'predicted_in_silico',
          'other',
        ],
      },
      { key: 'accessions', label: 'Accessions', type: 'string_array', suggested: true },

      { key: 'species', label: 'Species (scientific name)', type: 'text', suggested: true },
      { key: 'speciesTaxid', label: 'Species NCBI taxid', type: 'text', suggested: true },
      { key: 'notes', label: 'Notes', type: 'long_text', suggested: true },
    ],
  },
  {
    kind: 'entity',
    name: 'chromosome',
    displayName: 'Chromosome',
    description:
      'A single chromosome/molecule of a genome assembly (NCBI: a sequence record, distinct from the assembly). A chromosome IS a DNA molecule, so it MUST carry a resolved sequence (file-backed or inline) — never a bare identity record.',
    builtin: true,
    fields: [
      {
        key: 'sequence',
        label: 'Sequence',
        type: 'dna_sequence',
        required: true,
        requireResolved: true,
      },
      {
        key: 'moleculeType',
        label: 'Molecule type',
        type: 'enum',
        suggested: true,
        enumOptions: ['chromosome', 'mitochondrion', 'chloroplast', 'plasmid'],
      },
      { key: 'accessions', label: 'Accessions', type: 'string_array', suggested: true },

      { key: 'species', label: 'Species (scientific name)', type: 'text', suggested: true },
      { key: 'speciesTaxid', label: 'Species NCBI taxid', type: 'text', suggested: true },
      { key: 'notes', label: 'Notes', type: 'long_text', suggested: true },
    ],
  },
  {
    kind: 'entity',
    name: 'strain',
    displayName: 'Strain',
    description:
      'Strain identity — the lab unit of work. Carries its species (the organism is a field on the strain, not a separate entity), genotype, and lineage (derives_from).',
    builtin: true,
    fields: [
      { key: 'genotypeCanonical', label: 'Canonical genotype', type: 'long_text', required: true },
      { key: 'species', label: 'Species (scientific name)', type: 'text', suggested: true },
      { key: 'speciesTaxid', label: 'Species NCBI taxid', type: 'text', suggested: true },
      { key: 'biosafety', label: 'Biosafety', type: 'text', suggested: true },
      { key: 'markers', label: 'Markers or traits', type: 'string_array', suggested: true },
      { key: 'growthConditions', label: 'Growth conditions', type: 'long_text', suggested: true },
      { key: 'source', label: 'Source', type: 'text', suggested: true },

      { key: 'accessions', label: 'Accessions', type: 'string_array', suggested: true },
      { key: 'notes', label: 'Notes', type: 'long_text', suggested: true },
    ],
  },
  {
    kind: 'entity',
    name: 'organism',
    displayName: 'Organism',
    description: 'Lightweight taxonomy concept referenced by links.',
    builtin: true,
    fields: [
      { key: 'taxid', label: 'NCBI taxid', type: 'text', required: true },
      { key: 'scientificName', label: 'Scientific name', type: 'text', required: true },
      { key: 'rank', label: 'Rank', type: 'text', suggested: true },
      { key: 'commonName', label: 'Common name', type: 'text', suggested: true },
      { key: 'lineageString', label: 'Lineage', type: 'long_text', suggested: true },
    ],
  },
  {
    kind: 'entity',
    name: 'protein',
    displayName: 'Protein',
    description:
      'Registered amino-acid sequence, minted from a CDS/ORF translation or imported ' +
      'directly. A protein IS an amino-acid sequence, so it MUST carry a resolved sequence.',
    builtin: true,
    fields: [
      {
        key: 'sequence',
        label: 'Sequence',
        type: 'protein_sequence',
        required: true,
        requireResolved: true,
      },
      { key: 'sourceCds', label: 'Source CDS/ORF', type: 'text', suggested: true },
      { key: 'organism', label: 'Organism', type: 'text', suggested: true },
      { key: 'notes', label: 'Notes', type: 'long_text', suggested: true },
    ],
  },
  {
    kind: 'entity',
    name: 'dna_sequence',
    displayName: 'DNA sequence',
    description:
      'A resolved DNA molecule whose biological role has not been asserted as plasmid, chromosome, part, or fragment.',
    builtin: true,
    fields: [
      {
        key: 'sequence',
        label: 'Sequence',
        type: 'dna_sequence',
        required: true,
        requireResolved: true,
      },
      { key: 'source', label: 'Source', type: 'text', suggested: true },
      { key: 'notes', label: 'Notes', type: 'long_text', suggested: true },
    ],
  },
  {
    kind: 'entity',
    name: 'rna_sequence',
    displayName: 'RNA sequence',
    description:
      'A resolved RNA molecule whose biological role has not been asserted as a guide RNA or another specialized RNA type.',
    builtin: true,
    fields: [
      {
        key: 'sequence',
        label: 'Sequence',
        type: 'rna_sequence',
        required: true,
        requireResolved: true,
      },
      { key: 'source', label: 'Source', type: 'text', suggested: true },
      { key: 'notes', label: 'Notes', type: 'long_text', suggested: true },
    ],
  },

  {
    kind: 'entity',
    name: 'guide_rna',
    displayName: 'Guide RNA',
    description: 'A CRISPR guide RNA; targets a locus/sequence via a targets link.',
    builtin: true,
    fields: [
      { key: 'spacer', label: 'Spacer sequence', type: 'text', suggested: true },
      { key: 'pam', label: 'PAM', type: 'text', suggested: true },
      { key: 'accessions', label: 'Accessions', type: 'string_array', suggested: true },
      { key: 'notes', label: 'Notes', type: 'long_text', suggested: true },
    ],
  },
  {
    kind: 'entity',
    name: 'allele',
    displayName: 'Allele',
    description: 'A genotype allele / variant referenced by strains and constructs.',
    builtin: true,
    fields: [
      { key: 'gene', label: 'Gene', type: 'text', suggested: true },
      { key: 'notes', label: 'Notes', type: 'long_text', suggested: true },
    ],
  },
  {
    kind: 'entity',
    name: 'locus',
    displayName: 'Locus',
    description: 'A genomic locus / target site.',
    builtin: true,
    fields: [
      { key: 'coordinates', label: 'Coordinates', type: 'text', suggested: true },
      { key: 'accessions', label: 'Accessions', type: 'string_array', suggested: true },
      { key: 'notes', label: 'Notes', type: 'long_text', suggested: true },
    ],
  },
  {
    kind: 'entity',
    name: 'part',
    displayName: 'Part',
    description: 'A reusable DNA part (promoter, RBS, terminator, CDS, etc.).',
    builtin: true,
    fields: [
      { key: 'partType', label: 'Part type', type: 'text', suggested: true },
      { key: 'sequence', label: 'Sequence', type: 'dna_sequence', suggested: true },
      { key: 'notes', label: 'Notes', type: 'long_text', suggested: true },
    ],
  },
  {
    kind: 'entity',
    name: 'fragment',
    displayName: 'Fragment',
    description: 'A DNA fragment (PCR product, gBlock, digest) — often a build intermediate.',
    builtin: true,
    fields: [
      { key: 'sequence', label: 'Sequence', type: 'dna_sequence', suggested: true },
      { key: 'notes', label: 'Notes', type: 'long_text', suggested: true },
    ],
  },
  {
    kind: 'entity',
    name: 'marker',
    displayName: 'Marker',
    description: 'A selectable / auxotrophic marker (kanMX, URA3, ampR, …).',
    builtin: true,
    fields: [
      { key: 'selection', label: 'Selection', type: 'text', suggested: true },
      { key: 'notes', label: 'Notes', type: 'long_text', suggested: true },
    ],
  },
  {
    kind: 'entity',
    name: 'external_ref',
    displayName: 'External reference',
    description:
      'An external accession/vendor reference (Addgene, ATCC, GenBank) as a first-class node.',
    builtin: true,
    fields: [
      { key: 'accessions', label: 'Accessions', type: 'string_array', suggested: true },
      { key: 'url', label: 'URL', type: 'text', suggested: true },
      { key: 'notes', label: 'Notes', type: 'long_text', suggested: true },
    ],
  },
  {
    kind: 'entity',
    name: 'notebook',
    displayName: 'Notebook entry',
    description:
      'A lab notebook entry backed by a workspace notebook package. The file is truth; this row is the registry face of the same entity.',
    builtin: true,
    fields: [
      { key: 'packagePath', label: 'Package path', type: 'text', suggested: true },
      { key: 'notes', label: 'Notes', type: 'long_text', suggested: true },
    ],
  },
  {
    kind: 'entity',
    name: 'track-view',
    displayName: 'Track view',
    description:
      'A saved genome Track view backed by a portable file. The file is authoritative and this row is its Registry projection.',
    builtin: true,
    fields: [
      { key: 'referenceAssemblyId', label: 'Reference assembly', type: 'text', required: true },
      { key: 'referenceName', label: 'Reference name', type: 'text', required: true },
      { key: 'trackCount', label: 'Track count', type: 'number', required: true },
      { key: 'artifactFingerprint', label: 'Artifact fingerprint', type: 'text', required: true },
    ],
  },
  {
    kind: 'entity',
    name: 'molecular-document',
    displayName: 'Molecular visualization',
    description:
      'A file-backed molecular visualization with exact saved results and pinned coordinates. The file is authoritative.',
    builtin: true,
    fields: [
      { key: 'currentReferenceId', label: 'Current result', type: 'text', required: true },
      { key: 'revisionCount', label: 'Saved results', type: 'number', required: true },
      { key: 'sourceCount', label: 'Pinned structures', type: 'number', required: true },
      { key: 'artifactFingerprint', label: 'Artifact fingerprint', type: 'text', required: true },
    ],
  },
] as const;

export const LIMS_BUILTIN_RELATIONSHIP_SCHEMAS: readonly LimsBuiltinSchemaDefinition[] = [
  relationshipSchema({
    name: 'derives_from',
    displayName: 'Derives from',
    inverseName: 'derived_into',
    cardinality: 'many_to_many',
    directional: true,
    description: 'Lineage relationship between a derived entity and its parent.',
    ontologyMapping: 'RO:0001000',
  }),
  relationshipSchema({
    name: 'has_part',
    displayName: 'Has part',
    inverseName: 'part_of',
    cardinality: 'many_to_many',
    directional: true,
    description: 'Part-whole relationship.',
    ontologyMapping: 'BFO',
  }),
  relationshipSchema({
    name: 'variant_of',
    displayName: 'Variant of',
    inverseName: 'has_variant',
    cardinality: 'many_to_many',
    directional: true,
    description: 'Variant relationship to a reference entity.',
  }),
  relationshipSchema({
    name: 'encodes',
    displayName: 'Encodes',
    inverseName: 'encoded_by',
    cardinality: 'many_to_many',
    directional: true,
    description: 'Sequence entity encodes a product or feature.',
  }),
  relationshipSchema({
    name: 'verified_by',
    displayName: 'Verified by',
    inverseName: 'verifies',
    cardinality: 'many_to_many',
    directional: true,
    description: 'Entity is verified by another entity or evidence object.',
  }),
  relationshipSchema({
    name: 'carried_by',
    displayName: 'Carried by',
    inverseName: 'carries',
    fromKindHint: 'plasmid',
    toKindHint: 'strain',
    cardinality: 'many_to_many',
    directional: true,
    description: 'Plasmid is carried by a strain.',
  }),
  relationshipSchema({
    name: 'associated_with',
    displayName: 'Associated with',
    inverseName: 'associated_with',
    fromKindHint: 'any',
    toKindHint: 'any',
    cardinality: 'many_to_many',
    directional: true,
    description:
      'Minimally prescriptive user or import association between registered records; does not assert a reaction outcome.',
  }),
  relationshipSchema({
    name: 'amplifies',
    displayName: 'Amplifies',
    inverseName: 'amplified_by',
    fromKindHint: 'oligo',
    cardinality: 'many_to_many',
    directional: true,
    description:
      'PCR or reaction evidence that an oligo or primer pair amplified a target or product.',
  }),
  relationshipSchema({
    name: 'assembled_from',
    displayName: 'Assembled from',
    inverseName: 'assembled_into',
    cardinality: 'many_to_many',
    directional: true,
    description: 'Entity was assembled from one or more inputs.',
  }),
  relationshipSchema({
    name: 'references',
    displayName: 'References',
    inverseName: 'referenced_by',
    cardinality: 'many_to_many',
    directional: true,
    description: 'Loose reference to another entity.',
  }),
  relationshipSchema({
    name: 'has_genome',
    displayName: 'Has genome',
    inverseName: 'genome_of',
    fromKindHint: 'strain',
    toKindHint: 'genome',
    cardinality: 'one_to_many',
    directional: true,
    description: 'Strain has a genome with confidence stored on the link payload.',
  }),

  relationshipSchema({
    name: 'same_as',
    displayName: 'Same as',
    inverseName: 'same_as',
    cardinality: 'many_to_many',
    directional: false,
    description: 'Two records are the same real-world entity (reconciliation identity link).',
  }),
  relationshipSchema({
    name: 'targets',
    displayName: 'Targets',
    inverseName: 'targeted_by',
    cardinality: 'many_to_many',
    directional: true,
    description: 'A guide RNA / oligo targets a locus or sequence.',
  }),
  relationshipSchema({
    name: 'has_marker',
    displayName: 'Has marker',
    inverseName: 'marker_of',
    cardinality: 'many_to_many',
    directional: true,
    description: 'An entity carries a selectable / auxotrophic marker.',
  }),
  relationshipSchema({
    name: 'primer_pair',
    displayName: 'Primer pair',
    inverseName: 'primer_pair',
    cardinality: 'many_to_many',
    directional: false,
    description: 'Two oligos used together as a forward/reverse primer pair.',
  }),
  relationshipSchema({
    name: 'composed_of',
    displayName: 'Composed of',
    inverseName: 'component_of',
    cardinality: 'many_to_many',
    directional: true,
    description: 'A construct is composed of parts/fragments (assembly composition).',
  }),
  relationshipSchema({
    name: 'located_in',
    displayName: 'Located in',
    inverseName: 'location_of',
    cardinality: 'many_to_many',
    directional: true,
    description: 'An entity is located in a locus / plate / container.',
  }),
] as const;

export const LIMS_BUILTIN_SCHEMAS = [
  ...LIMS_BUILTIN_ENTITY_SCHEMAS,
  ...LIMS_BUILTIN_RELATIONSHIP_SCHEMAS,
] as const;

export function formatLimsRelationshipType(type: string): string {
  if (type === 'associated_with') return 'associated with';
  return type.replace(/[_-]+/g, ' ');
}

function relationshipSchema(
  definition: Omit<LimsRelationshipTypeDefinition, 'builtin'> & { builtin?: boolean }
): LimsBuiltinSchemaDefinition {
  return {
    kind: 'relationship_type',
    name: definition.name,
    displayName: definition.displayName,
    description: definition.description,
    builtin: definition.builtin ?? true,
    fields: [
      { key: 'confidence', label: 'Confidence', type: 'text', suggested: true },
      { key: 'method', label: 'Method', type: 'text', suggested: true },
      { key: 'notes', label: 'Notes', type: 'long_text', suggested: true },
    ],
    relationship: {
      builtin: definition.builtin ?? true,
      ...definition,
    },
  };
}

export function limsSchemaFieldsJson(schema: LimsBuiltinSchemaDefinition): string {
  return serializeLimsSchemaDefinition({
    fields: schema.fields,
    relationship: schema.relationship,
    baseKind: schema.baseKind ?? schema.name,
  });
}

export function serializeLimsSchemaDefinition(input: {
  fields: readonly LimsFieldDefinition[];
  relationship?: LimsRelationshipTypeDefinition;
  baseKind?: string;
}): string {
  return JSON.stringify({
    fields: input.fields,
    relationship: input.relationship,
    baseKind: input.baseKind,
  });
}

export function parseLimsSchemaFields(value: string): {
  fields: LimsFieldDefinition[];
  relationship?: LimsRelationshipTypeDefinition;
  baseKind?: string;
} {
  const parsed = JSON.parse(value) as {
    fields?: LimsFieldDefinition[];
    relationship?: LimsRelationshipTypeDefinition;
    baseKind?: unknown;
  };
  return {
    fields: Array.isArray(parsed.fields) ? parsed.fields : [],
    relationship: parsed.relationship,
    baseKind:
      typeof parsed.baseKind === 'string' && parsed.baseKind.trim().length > 0
        ? parsed.baseKind
        : undefined,
  };
}

export function limsEntityFromRow(row: LimsEntityRow): LimsEntity {
  return {
    id: row.id,
    kind: row.kind,
    schemaId: row.schema_id,
    schemaRevisionId: row.schema_revision_id,
    name: row.name,
    registryId: row.registry_id ?? null,
    fields: parseJsonObject(row.fields),
    registrationStatus: row.registration_status,
    domainStatus: row.domain_status,
    workspaceId: row.workspace_id,
    actor: row.actor,
    eventSeq: row.event_seq,
    tombstone: row.tombstone === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

export function limsLinkFromRow(row: LimsLinkRow): LimsLink {
  return {
    id: row.id,
    fromEntityId: row.from_entity_id,
    toEntityId: row.to_entity_id,
    type: row.type,
    payload: parseJsonObject(row.payload),
    workspaceId: row.workspace_id,
    actor: row.actor,
    eventSeq: row.event_seq,
    tombstone: row.tombstone === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

export interface LimsEntityFieldIssues {
  malformed: string[];

  incomplete: string[];
}

export function classifyLimsEntityFieldIssues(
  kind: string,
  fields: Record<string, unknown>,
  fieldDefs: readonly LimsFieldDefinition[],
  baseKind?: string
): LimsEntityFieldIssues {
  const malformed: string[] = [];
  const incomplete: string[] = [];
  for (const field of fieldDefs) {
    const value = fields[field.key];
    if (isMissing(value)) {
      if (field.required) incomplete.push(`${field.key} is required`);
      continue;
    }
    if (field.type === 'dna_sequence') {
      const ref = value as Partial<DnaSequenceRef>;
      if (ref?.mode === 'unresolved') {
        if (field.requireResolved) incomplete.push(`${field.key} has no resolved sequence yet`);
        continue;
      }
    }
    const typeError = validateFieldValue(kind, field, value);
    if (typeError) malformed.push(typeError);
  }

  if (baseKind === 'sequence' && !fieldDefs.some((field) => field.type === 'dna_sequence')) {
    const managedDocument = fields._managedSequenceDocument;
    const managedByPackage = isPlainRecord(managedDocument);
    const legacySequence = fields.sequence;
    if (!managedByPackage && isMissing(legacySequence)) {
      incomplete.push('sequence has no resolved sequence yet');
    } else if (!managedByPackage) {
      const ref = legacySequence as Partial<DnaSequenceRef>;
      if (ref?.mode === 'unresolved') {
        incomplete.push('sequence has no resolved sequence yet');
      } else {
        const typeError = validateDnaSequenceRef(
          kind,
          {
            key: 'sequence',
            requireResolved: true,
          },
          legacySequence
        );
        if (typeError) malformed.push(typeError);
      }
    }
  }
  return { malformed, incomplete };
}

export function validateLimsEntityFields(
  kind: string,
  fields: Record<string, unknown>,
  fieldDefs: readonly LimsFieldDefinition[],
  baseKind?: string
): string[] {
  const { malformed, incomplete } = classifyLimsEntityFieldIssues(
    kind,
    fields,
    fieldDefs,
    baseKind
  );
  return [...malformed, ...incomplete];
}

function validateFieldValue(
  kind: string,
  field: LimsFieldDefinition,
  value: unknown
): string | null {
  switch (field.type) {
    case 'text':
    case 'long_text': {
      if (typeof value !== 'string') return `${field.key} must be a string`;
      return field.maxLength !== undefined && value.length > field.maxLength
        ? `${field.key} exceeds ${field.maxLength} characters`
        : null;
    }
    case 'date':
      return validateDateField(field, value);
    case 'datetime':
      try {
        if (parseWorkTime(value).kind !== 'timed') return `${field.key} requires a date and time`;
        return null;
      } catch {
        return `${field.key} requires a valid date, time and named zone`;
      }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return `${field.key} must be a finite number`;
      }
      if (field.minValue !== undefined && value < field.minValue) {
        return `${field.key} must be at least ${field.minValue}`;
      }
      if (field.maxValue !== undefined && value > field.maxValue) {
        return `${field.key} must be at most ${field.maxValue}`;
      }
      return null;
    }
    case 'boolean':
      return typeof value === 'boolean' ? null : `${field.key} must be a boolean`;
    case 'string_array':
      return Array.isArray(value) && value.every((v) => typeof v === 'string')
        ? null
        : `${field.key} must be an array of strings`;
    case 'enum':
      if (typeof value !== 'string') return `${field.key} must be a string`;
      return field.enumOptions && !field.enumOptions.includes(value)
        ? `${field.key} must be one of ${field.enumOptions.join(', ')}`
        : null;
    case 'dna_sequence':
      return validateDnaSequenceRef(kind, field, value);
    case 'rna_sequence':
      return validateRnaSequenceRef(kind, field, value);
    case 'protein_sequence':
      return isPlainRecord(value) && ('aminoAcids' in value || value.representation === 'portable')
        ? validateProteinSequenceRef(kind, field, value)
        : validateAminoAcidSequenceRef(kind, field, value);
    case 'quantity':
      return validateQuantityValue(field, value);
    case 'record_relationship':
      return validateRecordRelationshipValue(field, value);
    case 'attachment_reference':
      return validateAttachmentReferenceValue(field, value);
    case 'formula_result':
      return validateFormulaResultValue(field, value);
    case 'genetic_code':
      return (typeof value === 'number' && Number.isInteger(value) && value > 0) ||
        (isPlainRecord(value) && typeof value.id === 'string')
        ? null
        : `${field.key} must be a genetic code`;
  }
}

function validateDateField(field: LimsFieldDefinition, value: unknown): string | null {
  if (typeof value !== 'string') return `${field.key} must be a string`;

  if (field.minDate === undefined && field.maxDate === undefined) return null;
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return `${field.key} must be a valid date`;
  if (field.minDate !== undefined && epoch < Date.parse(field.minDate)) {
    return `${field.key} must be on or after ${field.minDate}`;
  }
  if (field.maxDate !== undefined && epoch > Date.parse(field.maxDate)) {
    return `${field.key} must be on or before ${field.maxDate}`;
  }
  return null;
}

function validateAcceptedSequencePin(
  key: string,
  ref: { acceptedRevisionId?: unknown; documentId?: unknown; workspaceId?: unknown }
): string | null {
  if (ref.acceptedRevisionId === undefined) return null;
  if (
    typeof ref.acceptedRevisionId !== 'string' ||
    !/^rr_[0-9a-f]{64}$/u.test(ref.acceptedRevisionId)
  )
    return `${key}.acceptedRevisionId must identify an accepted resource revision`;
  if (typeof ref.documentId !== 'string' || ref.documentId.length === 0)
    return `${key}.documentId must identify its accepted sequence`;
  if (
    typeof ref.workspaceId !== 'number' ||
    !Number.isSafeInteger(ref.workspaceId) ||
    ref.workspaceId <= 0
  )
    return `${key}.workspaceId must identify its accepted workspace`;
  return null;
}

export function validateDnaSequenceRef(
  kind: string,
  field: Pick<LimsFieldDefinition, 'key' | 'maxLength' | 'requireResolved'>,
  value: unknown
): string | null {
  if (!value || typeof value !== 'object') return `${field.key} must be a dna_sequence reference`;
  const ref = value as Partial<DnaSequenceRef>;
  if (ref.mode === 'file') {
    const acceptedError = validateAcceptedSequencePin(field.key, ref);
    if (acceptedError) return acceptedError;
  }
  if (ref.mode === 'unresolved') {
    return field.requireResolved
      ? `${field.key} must reference an actual DNA sequence (a ${kind} cannot have an unresolved sequence)`
      : null;
  }
  if (ref.mode === 'inline') {
    if (typeof ref.bases !== 'string') return `${field.key}.bases must be a string`;
    if (ref.topology !== 'linear') return `${field.key}.topology must be linear for inline DNA`;
    const cleaned = ref.bases.replace(/\s/g, '').toUpperCase();
    if (!/^[ACGTURYSWKMBDHVN]+$/.test(cleaned)) {
      return `${field.key}.bases contains invalid DNA characters`;
    }
    if (typeof ref.length !== 'number' || ref.length !== cleaned.length) {
      return `${field.key}.length must match bases length`;
    }
    const cap = field.maxLength ?? (kind === 'oligo' ? DNA_SEQUENCE_MAX_INLINE_BASES : undefined);
    if (cap && cleaned.length > cap) return `${field.key}.bases exceeds ${cap} bp`;
    return null;
  }
  if (ref.mode === 'file') {
    const portablePathBase = (ref as { pathBase?: unknown }).pathBase;
    if (portablePathBase !== undefined) {
      if (portablePathBase !== 'workspace') {
        return `${field.key}.pathBase must be workspace`;
      }
      return validatePortableSequenceFileRef(field.key, ref);
    }
    if (typeof ref.relPath !== 'string' || ref.relPath.trim() === '') {
      return `${field.key}.relPath is required`;
    }

    if (kind === 'dna_sequence' && !isAbsoluteResolvedReferencePath(ref.relPath)) {
      return `${field.key}.relPath must be a resolved absolute path`;
    }
    if (ref.topology !== 'linear' && ref.topology !== 'circular') {
      return `${field.key}.topology must be linear or circular`;
    }
    if (!Number.isSafeInteger(ref.length) || (ref.length as number) < 0) {
      return `${field.key}.length is invalid`;
    }
    if (!isSupportedContentHash(ref.contentHash)) {
      return `${field.key}.contentHash must be a sha256 or git object hash`;
    }
    if (ref.fileContentHash !== undefined && !isSupportedContentHash(ref.fileContentHash)) {
      return `${field.key}.fileContentHash must be a sha256 or git object hash`;
    }
    if (
      ref.normalizedSequenceHash !== undefined &&
      (typeof ref.normalizedSequenceHash !== 'string' ||
        !ref.normalizedSequenceHash.startsWith('sha256:'))
    ) {
      return `${field.key}.normalizedSequenceHash must be a sha256 hash`;
    }
    return null;
  }
  return `${field.key}.mode must be inline, file, or unresolved`;
}

export function validateAminoAcidSequenceRef(
  kind: string,
  field: Pick<LimsFieldDefinition, 'key' | 'maxLength' | 'requireResolved'>,
  value: unknown
): string | null {
  if (!value || typeof value !== 'object')
    return `${field.key} must be a protein_sequence reference`;
  const ref = value as Partial<AminoAcidSequenceRef>;
  if (ref.mode === 'unresolved') {
    return field.requireResolved
      ? `${field.key} must reference an actual amino-acid sequence (a ${kind} cannot have an unresolved sequence)`
      : null;
  }
  if (ref.mode === 'inline') {
    if (typeof ref.bases !== 'string') return `${field.key}.bases must be a string`;
    const cleaned = normalizeProteinSequence(ref.bases);
    if (proteinSequenceValidationError(cleaned)) {
      return `${field.key}.bases contains invalid amino-acid characters`;
    }
    if (typeof ref.length !== 'number' || ref.length !== cleaned.length) {
      return `${field.key}.length must match bases length`;
    }
    if (field.maxLength && cleaned.length > field.maxLength) {
      return `${field.key}.bases exceeds ${field.maxLength} residues`;
    }
    return null;
  }
  if (ref.mode === 'file') {
    if (typeof ref.relPath !== 'string' || ref.relPath.trim() === '') {
      return `${field.key}.relPath is required`;
    }
    if (typeof ref.length !== 'number' || ref.length < 0) {
      return `${field.key}.length is invalid`;
    }
    if (!isSupportedContentHash(ref.contentHash)) {
      return `${field.key}.contentHash must be a sha256 or git object hash`;
    }
    if (ref.fileContentHash !== undefined && !isSupportedContentHash(ref.fileContentHash)) {
      return `${field.key}.fileContentHash must be a sha256 or git object hash`;
    }
    if (
      ref.normalizedSequenceHash !== undefined &&
      (typeof ref.normalizedSequenceHash !== 'string' ||
        !ref.normalizedSequenceHash.startsWith('sha256:'))
    ) {
      return `${field.key}.normalizedSequenceHash must be a sha256 hash`;
    }
    return null;
  }
  return `${field.key}.mode must be inline, file, or unresolved`;
}

export function validateRnaSequenceRef(
  kind: string,
  field: Pick<LimsFieldDefinition, 'key' | 'maxLength' | 'requireResolved'>,
  value: unknown
): string | null {
  if (!value || typeof value !== 'object') return `${field.key} must be an rna_sequence reference`;
  const ref = value as Partial<RnaSequenceRef>;
  if (ref.mode === 'file') {
    const acceptedError = validateAcceptedSequencePin(field.key, ref);
    if (acceptedError) return acceptedError;
  }
  if (ref.mode === 'unresolved') {
    return field.requireResolved
      ? `${field.key} must reference an actual RNA sequence (a ${kind} cannot have an unresolved sequence)`
      : null;
  }
  if (ref.mode === 'inline') {
    if (typeof ref.bases !== 'string') return `${field.key}.bases must be a string`;
    const cleaned = ref.bases.replace(/\s/g, '').toUpperCase();
    if (!/^[ACGURYSWKMBDHVN]+$/.test(cleaned)) {
      return `${field.key}.bases contains invalid RNA characters`;
    }
    if (ref.topology !== 'linear' && ref.topology !== 'circular') {
      return `${field.key}.topology must be linear or circular`;
    }
    if (ref.length !== cleaned.length) return `${field.key}.length must match bases length`;
    if (field.maxLength !== undefined && cleaned.length > field.maxLength) {
      return `${field.key}.bases exceeds ${field.maxLength} nt`;
    }
    if (ref.contentHash !== undefined && !isSupportedContentHash(ref.contentHash)) {
      return `${field.key}.contentHash must be a sha256 or git object hash`;
    }
    return null;
  }
  if (ref.mode === 'file') {
    const portablePathBase = (ref as { pathBase?: unknown }).pathBase;
    if (portablePathBase !== undefined) {
      if (portablePathBase !== 'workspace') {
        return `${field.key}.pathBase must be workspace`;
      }
      return validatePortableSequenceFileRef(field.key, ref);
    }
    if (typeof ref.relPath !== 'string' || ref.relPath.trim() === '') {
      return `${field.key}.relPath is required`;
    }

    if (kind === 'rna_sequence' && !isAbsoluteResolvedReferencePath(ref.relPath)) {
      return `${field.key}.relPath must be a resolved absolute path`;
    }
    if (ref.topology !== 'linear' && ref.topology !== 'circular') {
      return `${field.key}.topology must be linear or circular`;
    }
    if (!Number.isSafeInteger(ref.length) || (ref.length as number) < 0) {
      return `${field.key}.length is invalid`;
    }
    if (!isSupportedContentHash(ref.contentHash)) {
      return `${field.key}.contentHash must be a sha256 or git object hash`;
    }
    if (ref.fileContentHash !== undefined && !isSupportedContentHash(ref.fileContentHash)) {
      return `${field.key}.fileContentHash must be a sha256 or git object hash`;
    }
    if (
      ref.normalizedSequenceHash !== undefined &&
      (typeof ref.normalizedSequenceHash !== 'string' ||
        !ref.normalizedSequenceHash.startsWith('sha256:'))
    ) {
      return `${field.key}.normalizedSequenceHash must be a sha256 hash`;
    }
    return null;
  }
  return `${field.key}.mode must be inline, file, or unresolved`;
}

export function validateProteinSequenceRef(
  kind: string,
  field: Pick<LimsFieldDefinition, 'key' | 'maxLength' | 'requireResolved'>,
  value: unknown
): string | null {
  if (!value || typeof value !== 'object') {
    return `${field.key} must be a protein_sequence reference`;
  }
  const ref = value as Partial<ProteinSequenceRef>;
  if (ref.mode === 'unresolved') {
    return field.requireResolved
      ? `${field.key} must reference an actual protein sequence (a ${kind} cannot have an unresolved sequence)`
      : null;
  }
  if (ref.mode === 'inline') {
    if (typeof ref.aminoAcids !== 'string') {
      return `${field.key}.aminoAcids must be a string`;
    }
    const cleaned = normalizeProteinSequence(ref.aminoAcids);
    if (proteinSequenceValidationError(cleaned)) {
      return `${field.key}.aminoAcids contains nonstandard residues`;
    }
    if (ref.length !== cleaned.length) return `${field.key}.length must match amino-acid length`;
    if (field.maxLength !== undefined && cleaned.length > field.maxLength) {
      return `${field.key}.aminoAcids exceeds ${field.maxLength} residues`;
    }
    if (ref.contentHash !== undefined && !isSupportedContentHash(ref.contentHash)) {
      return `${field.key}.contentHash must be a sha256 or git object hash`;
    }
    return null;
  }
  if (ref.mode === 'file') {
    if (ref.representation !== 'portable') {
      return `${field.key}.representation must be portable`;
    }
    if (!['fasta', 'genbank', 'pdb', 'mmcif', 'unknown'].includes(String(ref.sourceFormat))) {
      return `${field.key}.sourceFormat is invalid`;
    }
    return validatePortableSequenceFileRef(field.key, ref);
  }
  return `${field.key}.mode must be inline, file, or unresolved`;
}

function validatePortableSequenceFileRef(
  key: string,
  ref: {
    relPath?: unknown;
    length?: unknown;
    contentHash?: unknown;
    fileContentHash?: unknown;
    normalizedSequenceHash?: unknown;
  }
): string | null {
  if (typeof ref.relPath !== 'string' || !isSafeRelativeReferencePath(ref.relPath)) {
    return `${key}.relPath must be a safe workspace-relative path`;
  }
  if (!Number.isSafeInteger(ref.length) || (ref.length as number) < 0) {
    return `${key}.length is invalid`;
  }
  if (!isSupportedContentHash(ref.contentHash)) {
    return `${key}.contentHash must be a sha256 or git object hash`;
  }
  if (ref.fileContentHash !== undefined && !isSupportedContentHash(ref.fileContentHash)) {
    return `${key}.fileContentHash must be a sha256 or git object hash`;
  }
  if (
    ref.normalizedSequenceHash !== undefined &&
    (typeof ref.normalizedSequenceHash !== 'string' ||
      !ref.normalizedSequenceHash.startsWith('sha256:'))
  ) {
    return `${key}.normalizedSequenceHash must be a sha256 hash`;
  }
  return null;
}

function validateQuantityValue(field: LimsFieldDefinition, value: unknown): string | null {
  if (!isPlainRecord(value)) return `${field.key} must be a structured quantity`;
  if (typeof value.lexical !== 'string' || value.lexical.trim() === '') {
    return `${field.key}.lexical is required`;
  }
  if (typeof value.unit !== 'string' || value.unit.trim() === '') {
    return `${field.key}.unit is required`;
  }
  if (value.value !== null && (typeof value.value !== 'number' || !Number.isFinite(value.value))) {
    return `${field.key}.value must be finite or null`;
  }
  if (!['compatible', 'unrecognized', 'incompatible'].includes(String(value.compatibility))) {
    return `${field.key}.compatibility is invalid`;
  }
  return null;
}

function validateRecordRelationshipValue(
  field: LimsFieldDefinition,
  value: unknown
): string | null {
  if (!isPlainRecord(value)) return `${field.key} must be a record relationship`;
  for (const key of ['relationType', 'label'] as const) {
    if (typeof value[key] !== 'string' || value[key].trim() === '') {
      return `${field.key}.${key} is required`;
    }
  }
  if (value.origin === 'native') {
    if (
      'sourceTargetId' in value ||
      value.resolution !== 'exact' ||
      typeof value.destinationEntityId !== 'string' ||
      !value.destinationEntityId.trim()
    )
      return `${field.key} has an invalid native relationship`;
    return null;
  }
  if ('origin' in value || typeof value.sourceTargetId !== 'string' || !value.sourceTargetId.trim())
    return `${field.key}.sourceTargetId is required for a source relationship`;
  if (value.resolution !== 'exact' && value.resolution !== 'source_broken') {
    return `${field.key}.resolution must be exact or source_broken`;
  }
  if (
    value.resolution === 'exact' &&
    (typeof value.destinationEntityId !== 'string' || value.destinationEntityId.trim() === '')
  ) {
    return `${field.key}.destinationEntityId is required for an exact relationship`;
  }
  if (value.resolution === 'source_broken' && value.destinationEntityId !== null) {
    return `${field.key}.destinationEntityId must be null for a source-broken relationship`;
  }
  return null;
}

function validateAttachmentReferenceValue(
  field: LimsFieldDefinition,
  value: unknown
): string | null {
  if (!isPlainRecord(value)) return `${field.key} must be an attachment reference`;
  if (typeof value.sha256 !== 'string' || !/^sha256:[0-9a-f]{64}$/i.test(value.sha256)) {
    return `${field.key}.sha256 must be a sha256 hash`;
  }
  if (
    typeof value.logicalName !== 'string' ||
    value.logicalName.trim() === '' ||
    /[\\/\0\r\n]/.test(value.logicalName)
  ) {
    return `${field.key}.logicalName must be a logical filename`;
  }
  if (typeof value.relativePath !== 'string' || !isSafeRelativeReferencePath(value.relativePath)) {
    return `${field.key}.relativePath must be a safe workspace-relative path`;
  }
  if (value.mediaType !== undefined && typeof value.mediaType !== 'string') {
    return `${field.key}.mediaType must be text`;
  }
  return null;
}

function validateFormulaResultValue(field: LimsFieldDefinition, value: unknown): string | null {
  if (!isPlainRecord(value)) return `${field.key} must be a formula result`;
  if (typeof value.formula !== 'string' || !value.formula.startsWith('=')) {
    return `${field.key}.formula must begin with =`;
  }
  if (value.compatibility !== 'supported' && value.compatibility !== 'unsupported') {
    return `${field.key}.compatibility is invalid`;
  }
  if (typeof value.stale !== 'boolean') return `${field.key}.stale must be a boolean`;
  if (value.compatibility === 'supported' && value.stale) {
    return `${field.key} cannot mark a supported formula stale`;
  }
  if (!isFormulaScalar(value.sourceValue)) return `${field.key}.sourceValue is invalid`;
  if (value.calculatedValue !== undefined && !isFormulaScalar(value.calculatedValue)) {
    return `${field.key}.calculatedValue is invalid`;
  }
  return null;
}

function isFormulaScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function isSafeRelativeReferencePath(value: string): boolean {
  if (value.trim() === '' || value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) return false;
  return !value
    .split(/[\\/]/)
    .some((segment) => segment === '' || segment === '.' || segment === '..');
}

function isAbsoluteResolvedReferencePath(value: string): boolean {
  if (value.trim() === '' || value.includes('\0')) return false;
  const portable = value.replace(/\\/g, '/');
  if (!portable.startsWith('/') && !/^[A-Za-z]:\//.test(portable)) return false;
  return portable
    .replace(/^[A-Za-z]:/, '')
    .split('/')
    .filter(Boolean)
    .every((segment) => segment !== '.' && segment !== '..');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isSupportedContentHash(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (/^sha256:[0-9a-f]{64}$/i.test(value) || /^git:[0-9a-f]{40,64}$/i.test(value))
  );
}

export function limsKindRequiresResolvedSequence(kind: string): boolean {
  const schema = LIMS_BUILTIN_ENTITY_SCHEMAS.find((s) => s.name === kind);
  return Boolean(
    schema?.baseKind === 'sequence' ||
    schema?.fields.some(
      (f) =>
        (f.type === 'dna_sequence' || f.type === 'rna_sequence' || f.type === 'protein_sequence') &&
        f.requireResolved === true
    )
  );
}

export function normalizeInlineDnaSequenceRef(bases: string): InlineDnaSequenceRef {
  const cleaned = bases.replace(/\s/g, '');
  return {
    mode: 'inline',
    bases: cleaned,
    topology: 'linear',
    length: cleaned.length,
  };
}

export function normalizeInlineAminoAcidSequenceRef(bases: string): InlineAminoAcidSequenceRef {
  const cleaned = bases.replace(/\s/g, '').toUpperCase();
  return {
    mode: 'inline',
    bases: cleaned,
    length: cleaned.length,
  };
}

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value || '{}') as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}
