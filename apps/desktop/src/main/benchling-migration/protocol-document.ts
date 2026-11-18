import { assertProtocolDocumentStructure } from '@waypoint/domain-services/protocol-package';
import type { JSONContent } from '@tiptap/core';
import { isBenchlingLocalExportProvenanceUrn } from './source-identity';
import type { RelationshipEvidence } from '../../shared/benchling-migration';
import type { ProtocolRunDocument } from './protocol-run-projection';

export const PROTOCOL_DOCUMENT_SCHEMA = 'dnaforge.protocol.v1' as const;

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
  if (!Array.isArray((value as ProtocolDocument | null)?.links))
    throw new Error('Protocol links must be an array.');
  assertProtocolDocumentStructure(value);
  assertProvenance((value as ProtocolDocument).provenance);
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
