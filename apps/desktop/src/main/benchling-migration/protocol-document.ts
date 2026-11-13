import type { JSONContent } from '@tiptap/core';
import { isBenchlingLocalExportProvenanceUrn } from './source-identity';
import type {
  RelationshipEvidence,
  RelationshipEvidenceKind,
} from '../../shared/benchling-migration';
import type { ProtocolRunDocument } from './protocol-run-projection';

export const PROTOCOL_DOCUMENT_SCHEMA = 'dnaforge.protocol.v1' as const;

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const SAFE_KEY = /^[A-Za-z][A-Za-z0-9_-]*$/;
const EVIDENCE_KINDS = new Set<RelationshipEvidenceKind>([
  'stable_id',
  'url',
  'registry_id',
  'archive_path',
  'attachment_hash',
  'alias',
  'name',
  'timestamp',
  'source_type',
  'sequence_identity',
]);

export type ProtocolSlotValueType =
  | { kind: 'text' | 'number' | 'boolean' | 'date' }
  | { kind: 'quantity'; unitDimension: string | null; preferredUnit: string | null }
  | { kind: 'record'; recordKinds: string[] }
  | { kind: 'attachment'; mediaTypes: string[] }
  | { kind: 'dna_sequence' | 'rna_sequence' | 'protein_sequence' };

export type ProtocolSlotDeclaration = {
  key: string;
  label: string;
  required: boolean;
  description: string | null;
  valueType: ProtocolSlotValueType;
};

export type ProtocolStep = {
  id: string;
  sourceStepId: string;
  ordinal: number;
  title: string;
  content: JSONContent;
};

export type ProtocolLink =
  | {
      id: string;
      relation: string;
      state: 'live_local';
      sourceTargetId: string;
      destinationTargetId: string;
      label: string | null;
      evidence: RelationshipEvidence[];
    }
  | {
      id: string;
      relation: string;
      state: 'external';
      url: string;
      label: string | null;
      evidence: RelationshipEvidence[];
    }
  | {
      id: string;
      relation: string;
      state: 'source_broken';
      sourceTargetId: string | null;
      label: string | null;
      evidence: RelationshipEvidence[];
    };

export type ProtocolDocument = {
  schema: typeof PROTOCOL_DOCUMENT_SCHEMA;
  kind: 'protocol';
  id: string;
  title: string;
  editable: true;
  overview: JSONContent;
  steps: ProtocolStep[];
  inputs: ProtocolSlotDeclaration[];
  outputs: ProtocolSlotDeclaration[];
  links: ProtocolLink[];
  version: {
    sourceVersionId: string;
    pinnedVersionHash: string;
    immutable: true;
    importedAt: string;
  };
  provenance: {
    immutableSource: true;
    provider: 'benchling';
    sourceObjectId: string;
    stableSourceId: string;
    sourceUrl: string;
    sourceSchemaId: string | null;
    sourceCreatedAt: string | null;
    sourceModifiedAt: string | null;
    capturedAt: string;
  };
};

export function protocolRunPin(document: ProtocolDocument): ProtocolRunDocument['protocol'] {
  assertProtocolDocument(document);
  return {
    sourceId: document.provenance.stableSourceId,
    destinationId: document.id,
    name: document.title,
    pinnedVersionId: document.version.sourceVersionId,
    pinnedVersionHash: document.version.pinnedVersionHash,
  };
}

export function serializeProtocolDocument(document: ProtocolDocument): string {
  assertProtocolDocument(document);
  return `${stableJson(document)}\n`;
}

export function parseProtocolDocument(text: string): ProtocolDocument {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Protocol document is not valid JSON.');
  }
  assertProtocolDocument(value);
  return value;
}

export function assertProtocolDocument(value: unknown): asserts value is ProtocolDocument {
  const document = requireRecord(value, 'Protocol document must be an object.');
  if (document.schema !== PROTOCOL_DOCUMENT_SCHEMA || document.kind !== 'protocol') {
    throw new Error('Unsupported protocol document schema.');
  }
  requireText(document.id, 'Protocol ID');
  requireText(document.title, 'Protocol title');
  if (document.editable !== true) {
    throw new Error('Imported protocol documents must be editable.');
  }
  assertTipTapDocument(document.overview, 'Protocol overview');

  const steps = requireArray(document.steps, 'Protocol steps must be an array.');
  if (steps.length === 0) throw new Error('Protocol requires at least one ordered step.');
  const stepIds = new Set<string>();
  const sourceStepIds = new Set<string>();
  steps.forEach((value, index) => {
    const step = requireRecord(value, `Protocol step ${index + 1} must be an object.`);
    const id = requireText(step.id, `Protocol step ${index + 1} ID`);
    const sourceStepId = requireText(
      step.sourceStepId,
      `Protocol step ${index + 1} source step ID`
    );
    if (stepIds.has(id) || sourceStepIds.has(sourceStepId)) {
      throw new Error('Protocol step identities must be unique.');
    }
    stepIds.add(id);
    sourceStepIds.add(sourceStepId);
    if (step.ordinal !== index + 1) {
      throw new Error('Protocol step ordinals must be contiguous and match document order.');
    }
    requireText(step.title, `Protocol step ${index + 1} title`);
    assertTipTapDocument(step.content, `Protocol step ${index + 1} content`);
  });

  assertSlotDeclarations(document.inputs, 'inputs');
  assertSlotDeclarations(document.outputs, 'outputs');
  assertLinks(document.links);

  const version = requireRecord(document.version, 'Protocol version must be an object.');
  requireText(version.sourceVersionId, 'Protocol source version ID');
  const pinnedVersionHash = requireText(version.pinnedVersionHash, 'Protocol version hash');
  if (!SHA256.test(pinnedVersionHash)) {
    throw new Error('Protocol version hash must be a sha256 digest.');
  }
  if (version.immutable !== true) {
    throw new Error('Imported protocol source version must be immutable.');
  }
  requiredTimestamp(version.importedAt, 'Protocol version importedAt');
  assertProvenance(document.provenance);
}

function assertSlotDeclarations(value: unknown, direction: 'inputs' | 'outputs'): void {
  const slots = requireArray(value, `Protocol ${direction} must be an array.`);
  const keys = new Set<string>();
  slots.forEach((entry, index) => {
    const slot = requireRecord(entry, `Protocol ${direction} ${index + 1} must be an object.`);
    const key = requireText(slot.key, `Protocol ${direction} ${index + 1} key`);
    if (!SAFE_KEY.test(key))
      throw new Error(`Protocol ${direction} ${index + 1} key is not portable.`);
    if (keys.has(key)) throw new Error(`Duplicate protocol ${direction} key: ${key}.`);
    keys.add(key);
    requireText(slot.label, `Protocol ${direction} ${index + 1} label`);
    if (typeof slot.required !== 'boolean') {
      throw new Error(`Protocol ${direction} ${index + 1} required must be boolean.`);
    }
    assertNullableText(slot.description, `Protocol ${direction} ${index + 1} description`);
    assertSlotValueType(slot.valueType, `Protocol ${direction} ${index + 1} value type`);
  });
}

function assertSlotValueType(value: unknown, label: string): void {
  const valueType = requireRecord(value, `${label} must be an object.`);
  const kind = requireText(valueType.kind, `${label} kind`);
  if (
    [
      'text',
      'number',
      'boolean',
      'date',
      'dna_sequence',
      'rna_sequence',
      'protein_sequence',
    ].includes(kind)
  ) {
    return;
  }
  if (kind === 'quantity') {
    assertNullableText(valueType.unitDimension, `${label} unit dimension`);
    assertNullableText(valueType.preferredUnit, `${label} preferred unit`);
    return;
  }
  if (kind === 'record') {
    const recordKinds = requireArray(
      valueType.recordKinds,
      `${label} record kinds must be an array.`
    );
    if (recordKinds.length === 0) throw new Error(`${label} requires at least one record kind.`);
    recordKinds.forEach((recordKind, index) =>
      requireText(recordKind, `${label} record kind ${index + 1}`)
    );
    return;
  }
  if (kind === 'attachment') {
    const mediaTypes = requireArray(valueType.mediaTypes, `${label} media types must be an array.`);
    mediaTypes.forEach((mediaType, index) =>
      requireText(mediaType, `${label} media type ${index + 1}`)
    );
    return;
  }
  throw new Error(`Unsupported ${label} kind "${kind}".`);
}

function assertLinks(value: unknown): void {
  const links = requireArray(value, 'Protocol links must be an array.');
  const ids = new Set<string>();
  links.forEach((entry, index) => {
    const link = requireRecord(entry, `Protocol link ${index + 1} must be an object.`);
    const id = requireText(link.id, `Protocol link ${index + 1} ID`);
    if (ids.has(id)) throw new Error(`Duplicate protocol link ID: ${id}.`);
    ids.add(id);
    requireText(link.relation, `Protocol link ${index + 1} relation`);
    assertNullableText(link.label, `Protocol link ${index + 1} label`);
    assertEvidence(link.evidence, `Protocol link ${index + 1}`);
    if (link.state === 'live_local') {
      requireText(link.sourceTargetId, `Protocol link ${index + 1} source target ID`);
      requireText(link.destinationTargetId, `Protocol link ${index + 1} destination target ID`);
      return;
    }
    if (link.state === 'external') {
      safeExternalUrl(link.url, `Protocol link ${index + 1} URL`);
      return;
    }
    if (link.state === 'source_broken') {
      assertNullableText(link.sourceTargetId, `Protocol link ${index + 1} source target ID`);
      return;
    }
    throw new Error(
      `Protocol link ${index + 1} must already be live-local, external, or source-broken.`
    );
  });
}

function assertEvidence(value: unknown, label: string): void {
  const evidence = requireArray(value, `${label} evidence must be an array.`);
  if (evidence.length === 0) throw new Error(`${label} requires relationship evidence.`);
  evidence.forEach((entry, index) => {
    const item = requireRecord(entry, `${label} evidence ${index + 1} must be an object.`);
    if (!EVIDENCE_KINDS.has(item.kind as RelationshipEvidenceKind)) {
      throw new Error(`${label} evidence ${index + 1} has an unsupported kind.`);
    }
    requireText(item.value, `${label} evidence ${index + 1} value`);
    if (item.sourcePath !== undefined) {
      requireText(item.sourcePath, `${label} evidence ${index + 1} source path`);
    }
  });
}

function assertTipTapDocument(value: unknown, label: string): void {
  const document = requireRecord(value, `${label} must be a TipTap document.`);
  if (document.type !== 'doc' || !Array.isArray(document.content)) {
    throw new Error(`${label} must be a TipTap doc with ordered content.`);
  }
}

function assertProvenance(value: unknown): void {
  const provenance = requireRecord(value, 'Protocol provenance must be an object.');
  if (provenance.immutableSource !== true || provenance.provider !== 'benchling') {
    throw new Error('Protocol provenance must identify an immutable Benchling source.');
  }
  requireText(provenance.sourceObjectId, 'Protocol source object ID');
  requireText(provenance.stableSourceId, 'Protocol stable source ID');
  const sourceUrl = requireText(provenance.sourceUrl, 'Protocol source URL');
  if (!isBenchlingLocalExportProvenanceUrn(sourceUrl)) {
    const parsed = new URL(sourceUrl);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error(
        'Protocol source URL must be credential-free HTTPS without query or fragment.'
      );
    }
  }
  assertNullableText(provenance.sourceSchemaId, 'Protocol source schema ID');
  assertNullableTimestamp(provenance.sourceCreatedAt, 'Protocol source createdAt');
  assertNullableTimestamp(provenance.sourceModifiedAt, 'Protocol source modifiedAt');
  requiredTimestamp(provenance.capturedAt, 'Protocol capturedAt');
}

function safeExternalUrl(value: unknown, label: string): string {
  const text = requireText(value, label);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`${label} must be an absolute URL.`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(`${label} must use credential-free HTTP or HTTPS.`);
  }
  return parsed.toString();
}

function assertNullableText(value: unknown, label: string): void {
  if (value !== null && (typeof value !== 'string' || !value.trim())) {
    throw new Error(`${label} must be non-empty text or null.`);
  }
}

function assertNullableTimestamp(value: unknown, label: string): void {
  if (value !== null) requiredTimestamp(value, label);
}

function requiredTimestamp(value: unknown, label: string): string {
  const text = requireText(value, label);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${label} must be an ISO timestamp.`);
  return new Date(text).toISOString();
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

function requireArray(value: unknown, message: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(message);
  return value;
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value), null, 2);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)])
  );
}
