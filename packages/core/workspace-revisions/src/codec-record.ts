import { parseStrictCanonicalJson } from './canonical-json';
import type {
  CanonicalRecordError,
  DecodedCanonicalRecord,
  ImmutableReplayClassification,
  OpaqueCanonicalRecord,
} from './codec-types';
import { hashCanonicalRecord } from './hash';
import type { Result } from './identity';
import type { ImmutableRecordKind } from './types';
import { isCanonicalRecordWithinByteLimit } from './record-budgets';
import { decodeWorkspaceIndexNode } from './workspace-index';

export function classifyImmutableReplay(
  existing: OpaqueCanonicalRecord,
  incoming: OpaqueCanonicalRecord
): ImmutableReplayClassification {
  if (existing.id !== incoming.id) return { kind: 'new' };
  if (existing.kind === incoming.kind && existing.canonicalJson === incoming.canonicalJson) {
    return { kind: 'replay' };
  }
  return { kind: 'corrupt', id: existing.id };
}

export function decodeCanonicalRecord(
  input: unknown
): Result<DecodedCanonicalRecord, CanonicalRecordError> {
  if (
    !isPlainRecord(input) ||
    !isImmutableRecordKind(input.kind) ||
    typeof input.id !== 'string' ||
    typeof input.canonicalJson !== 'string'
  ) {
    return { ok: false, error: { kind: 'invalid-record-envelope' } };
  }
  if (!isCanonicalRecordWithinByteLimit(input.kind, input.canonicalJson)) {
    return { ok: false, error: { kind: 'record-too-large', recordKind: input.kind } };
  }
  const canonical = parseStrictCanonicalJson(input.canonicalJson);
  if (!canonical.ok) {
    return { ok: false, error: { kind: 'invalid-canonical-json', recordKind: input.kind } };
  }
  const body: unknown = JSON.parse(canonical.value);
  if (!isPlainRecord(body) || !Number.isSafeInteger(body.formatVersion)) {
    return { ok: false, error: { kind: 'invalid-record-body', recordKind: input.kind } };
  }
  if (typeof body.formatVersion !== 'number') {
    return { ok: false, error: { kind: 'invalid-record-body', recordKind: input.kind } };
  }
  const expectedFormatVersion =
    input.kind === 'workspace-version' || input.kind === 'operation-receipt' ? 2 : 1;
  if (body.formatVersion > expectedFormatVersion) {
    return {
      ok: false,
      error: {
        kind: 'unsupported-future-format',
        recordKind: input.kind,
        version: body.formatVersion,
      },
    };
  }
  if (body.formatVersion !== expectedFormatVersion) {
    return { ok: false, error: { kind: 'invalid-record-body', recordKind: input.kind } };
  }
  if (isWorkspaceIndexRecordKind(input.kind)) {
    const decodedNode = decodeWorkspaceIndexNode(input.kind, input.id, canonical.value);
    if (!decodedNode.ok) return immutableMismatch(input.kind, input.id);
  } else if (input.id !== hashCanonicalRecord(input.kind, canonical.value)) {
    return immutableMismatch(input.kind, input.id);
  }
  return {
    ok: true,
    value: { kind: input.kind, id: input.id, canonicalJson: canonical.value, body },
  };
}

function immutableMismatch(
  recordKind: ImmutableRecordKind,
  id: string
): Result<never, CanonicalRecordError> {
  return { ok: false, error: { kind: 'immutable-record-mismatch', recordKind, id } };
}

function isImmutableRecordKind(value: unknown): value is ImmutableRecordKind {
  return (
    value === 'resource-state' ||
    value === 'resource-revision' ||
    value === 'workspace-resource-map-node' ||
    value === 'workspace-path-map-node' ||
    value === 'workspace-version' ||
    value === 'operation-receipt' ||
    value === 'recovery-candidate'
  );
}

function isWorkspaceIndexRecordKind(
  value: ImmutableRecordKind
): value is 'workspace-resource-map-node' | 'workspace-path-map-node' {
  return value === 'workspace-resource-map-node' || value === 'workspace-path-map-node';
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
