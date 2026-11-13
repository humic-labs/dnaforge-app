import { canonicalize } from './canonical-json';
import { decodeCanonicalRecord } from './codec-record';
import type { CanonicalImportError, DecodedCanonicalRecord } from './codec-types';
import type {
  OperationReceiptRecord,
  RecoveryCandidateRecord,
  WorkspaceVersionRecord,
} from './graph';
import { hashCanonicalRecord } from './hash';
import {
  parseOperationId,
  parseRecoveryCandidateId,
  parseRefName,
  parseResourceId,
  parseResourceRevisionId,
  parseResourceStateHash,
  parseWorkspacePathRootId,
  parseWorkspaceResourceRootId,
  parseWorkspaceVersionId,
  type OperationId,
  type RecoveryCandidateId,
  type Result,
  type WorkspaceId,
  type WorkspaceVersionId,
} from './identity';
import { deepFreeze } from './immutable';
import type {
  Conflict,
  ImmutableRecordKind,
  ImmutableRecordWrite,
  MutationEffects,
  MutationError,
  RecoveryError,
  WorkspaceVersionView,
} from './types';
import { parseWorkspacePath } from './path';
import { hydrateReceiptReplay, type ReceiptReplayInput } from './receipt';
import { isValidCanonicalText } from './unicode';

export function decodeOperationReceipt(
  decoded: DecodedCanonicalRecord,
  context: {
    readonly workspaceId: WorkspaceId;
    readonly workspaceVersions: ReadonlyMap<WorkspaceVersionId, WorkspaceVersionRecord>;
    readonly recoveryCandidates: ReadonlyMap<RecoveryCandidateId, RecoveryCandidateRecord>;
    readonly availableRecordKeys: ReadonlySet<string>;
  }
): Result<OperationReceiptRecord, CanonicalImportError> {
  const body = decoded.body;
  if (
    !hasExactKeys(body, ['formatVersion', 'operationId', 'request', 'result']) ||
    body.formatVersion !== 2 ||
    typeof body.operationId !== 'string' ||
    !isPlainRecord(body.request) ||
    !isPlainRecord(body.result) ||
    'operationId' in body.request ||
    body.request.workspaceId !== context.workspaceId
  ) {
    return invalidBody('operation-receipt');
  }
  const operationId = parseOperationId(body.operationId);
  const requestCanonical = canonicalize(body.request);
  if (!operationId.ok || !requestCanonical.ok) {
    return invalidBody('operation-receipt');
  }
  const replayInput = decodeReplay(body.result, operationId.value, context);
  if (!replayInput) return invalidBody('operation-receipt');
  const id = hashCanonicalRecord('operation-receipt', decoded.canonicalJson);
  const write: ImmutableRecordWrite = Object.freeze({
    kind: 'operation-receipt',
    id,
    canonicalJson: decoded.canonicalJson,
  });
  const replay = hydrateReceiptReplay(operationId.value, replayInput, write);
  return {
    ok: true,
    value: Object.freeze({
      operationId: operationId.value,
      requestCanonicalJson: requestCanonical.value,
      replay,
      write,
    }),
  };
}

function decodeReplay(
  body: Readonly<Record<string, unknown>>,
  operationId: OperationId,
  context: {
    readonly workspaceId: WorkspaceId;
    readonly workspaceVersions: ReadonlyMap<WorkspaceVersionId, WorkspaceVersionRecord>;
    readonly recoveryCandidates: ReadonlyMap<RecoveryCandidateId, RecoveryCandidateRecord>;
    readonly availableRecordKeys: ReadonlySet<string>;
  }
): ReceiptReplayInput | null {
  const recordWrites = decodeReceiptRecordWrites(body.recordWrites, context.availableRecordKeys);
  if (!recordWrites) return null;
  switch (body.outcome) {
    case 'changed': {
      if (
        !hasExactKeys(body, ['outcome', 'version', 'effects', 'refAdvance', 'recordWrites']) ||
        !isPlainRecord(body.version) ||
        !isPlainRecord(body.effects) ||
        !isPlainRecord(body.refAdvance)
      ) {
        return null;
      }
      const version = decodeReceiptVersion(body.version, context.workspaceVersions);
      const effects = decodeMutationEffects(body.effects);
      const refAdvance = decodeRefAdvance(
        body.refAdvance,
        context.workspaceId,
        version?.id ?? null
      );
      return version && effects && refAdvance
        ? deepFreeze({ outcome: body.outcome, version, effects, refAdvance, recordWrites })
        : null;
    }
    case 'no-op': {
      if (!hasExactKeys(body, ['outcome', 'head', 'reason', 'recordWrites'])) return null;
      const head = decodeNullableVersionId(body.head);
      if (
        head === undefined ||
        (head !== null && !context.workspaceVersions.has(head)) ||
        (body.reason !== 'state-unchanged' &&
          body.reason !== 'already-at-destination' &&
          body.reason !== 'membership-already-absent' &&
          body.reason !== 'sources-already-converged')
      ) {
        return null;
      }
      return deepFreeze({ outcome: body.outcome, head, reason: body.reason, recordWrites });
    }
    case 'conflict': {
      if (
        !hasExactKeys(body, ['outcome', 'conflicts', 'recordWrites']) ||
        !Array.isArray(body.conflicts)
      ) {
        return null;
      }
      const conflicts = body.conflicts.map(decodeConflict);
      const first = conflicts[0];
      if (!first || conflicts.some((conflict) => conflict === null)) return null;
      return deepFreeze({
        outcome: body.outcome,
        conflicts: [first, ...conflicts.slice(1)] as import('./types').NonEmpty<Conflict>,
        recordWrites,
      });
    }
    case 'rejected': {
      if (!hasExactKeys(body, ['outcome', 'error', 'recordWrites']) || !isPlainRecord(body.error)) {
        return null;
      }
      const error = decodeReplayError(body.error);
      return error ? deepFreeze({ outcome: body.outcome, error, recordWrites }) : null;
    }
    case 'recovery-candidate': {
      if (
        !hasExactKeys(body, ['outcome', 'candidate', 'recordWrites']) ||
        !isPlainRecord(body.candidate)
      ) {
        return null;
      }
      const candidate = decodeReceiptCandidate(body.candidate, operationId, context);
      return candidate ? deepFreeze({ outcome: body.outcome, candidate, recordWrites }) : null;
    }
    default:
      return null;
  }
}

function decodeReceiptVersion(
  value: Readonly<Record<string, unknown>>,
  versions: ReadonlyMap<WorkspaceVersionId, WorkspaceVersionRecord>
): WorkspaceVersionView | null {
  if (typeof value.id !== 'string') return null;
  const id = parseWorkspaceVersionId(value.id);
  if (!id.ok) return null;
  const record = versions.get(id.value);
  if (!record) return null;
  const actual = canonicalize(value);
  const expected = canonicalize(record.view);
  return actual.ok && expected.ok && actual.value === expected.value ? record.view : null;
}

function decodeReceiptRecordWrites(
  value: unknown,
  availableRecordKeys: ReadonlySet<string>
): readonly ImmutableRecordWrite[] | null {
  if (!Array.isArray(value)) return null;
  const writes: ImmutableRecordWrite[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (
      !isPlainRecord(candidate) ||
      !hasExactKeys(candidate, ['kind', 'id', 'canonicalJson']) ||
      !isImmutableRecordKind(candidate.kind) ||
      candidate.kind === 'operation-receipt' ||
      typeof candidate.id !== 'string' ||
      typeof candidate.canonicalJson !== 'string'
    ) {
      return null;
    }
    const key = `${candidate.kind}:${candidate.id}`;
    if (seen.has(key) || !availableRecordKeys.has(key)) return null;
    seen.add(key);
    const decoded = decodeCanonicalRecord({
      kind: candidate.kind,
      id: candidate.id,
      canonicalJson: candidate.canonicalJson,
    });
    if (!decoded.ok) return null;
    const write = decodedRecordWrite(decoded.value);
    if (!write) return null;
    writes.push(write);
  }
  return Object.freeze(writes);
}

function decodedRecordWrite(record: DecodedCanonicalRecord): ImmutableRecordWrite | null {
  const common = { canonicalJson: record.canonicalJson };
  switch (record.kind) {
    case 'resource-state': {
      const id = parseResourceStateHash(record.id);
      return id.ok ? Object.freeze({ ...common, kind: record.kind, id: id.value }) : null;
    }
    case 'resource-revision': {
      const id = parseResourceRevisionId(record.id);
      return id.ok ? Object.freeze({ ...common, kind: record.kind, id: id.value }) : null;
    }
    case 'workspace-version': {
      const id = parseWorkspaceVersionId(record.id);
      return id.ok ? Object.freeze({ ...common, kind: record.kind, id: id.value }) : null;
    }
    case 'recovery-candidate': {
      const id = parseRecoveryCandidateId(record.id);
      return id.ok ? Object.freeze({ ...common, kind: record.kind, id: id.value }) : null;
    }
    case 'workspace-resource-map-node': {
      const id = parseWorkspaceResourceRootId(record.id);
      return id.ok ? Object.freeze({ ...common, kind: record.kind, id: id.value }) : null;
    }
    case 'workspace-path-map-node': {
      const id = parseWorkspacePathRootId(record.id);
      return id.ok ? Object.freeze({ ...common, kind: record.kind, id: id.value }) : null;
    }
    case 'operation-receipt':
      return null;
  }
}

function decodeMutationEffects(value: Readonly<Record<string, unknown>>): MutationEffects | null {
  if (
    !hasExactKeys(value, ['resourceState', 'resourceRevision', 'workspaceVersion']) ||
    (value.resourceState !== 'created' &&
      value.resourceState !== 'reused' &&
      value.resourceState !== 'none') ||
    (value.resourceRevision !== 'created' &&
      value.resourceRevision !== 'reused' &&
      value.resourceRevision !== 'none') ||
    (value.workspaceVersion !== 'created' && value.workspaceVersion !== 'reused')
  ) {
    return null;
  }
  return Object.freeze({
    resourceState: value.resourceState,
    resourceRevision: value.resourceRevision,
    workspaceVersion: value.workspaceVersion,
  });
}

function decodeRefAdvance(
  value: Readonly<Record<string, unknown>>,
  workspaceId: WorkspaceId,
  versionId: WorkspaceVersionId | null
): import('./types').RefAdvance | null {
  if (
    !hasExactKeys(value, ['workspaceId', 'refName', 'expected', 'next']) ||
    value.workspaceId !== workspaceId ||
    typeof value.refName !== 'string' ||
    typeof value.next !== 'string'
  ) {
    return null;
  }
  const refName = parseRefName(value.refName);
  const expected = decodeNullableVersionId(value.expected);
  const next = parseWorkspaceVersionId(value.next);
  return refName.ok && expected !== undefined && next.ok && next.value === versionId
    ? Object.freeze({ workspaceId, refName: refName.value, expected, next: next.value })
    : null;
}

function decodeNullableVersionId(value: unknown): WorkspaceVersionId | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const parsed = parseWorkspaceVersionId(value);
  return parsed.ok ? parsed.value : undefined;
}

function decodeConflict(value: unknown): Conflict | null {
  if (!isPlainRecord(value) || typeof value.kind !== 'string') return null;
  if (value.kind === 'ref-head-mismatch') {
    if (!hasExactKeys(value, ['kind', 'expected', 'actual'])) return null;
    const expected = decodeNullableVersionId(value.expected);
    const actual = decodeNullableVersionId(value.actual);
    return expected !== undefined && actual !== undefined
      ? Object.freeze({ kind: value.kind, expected, actual })
      : null;
  }
  if (value.kind === 'resource-conflict') {
    if (
      !hasExactKeys(value, ['kind', 'resourceId', 'reason']) ||
      typeof value.resourceId !== 'string' ||
      (value.reason !== 'edit-edit' &&
        value.reason !== 'rename-rename' &&
        value.reason !== 'delete-edit' &&
        value.reason !== 'move-delete' &&
        value.reason !== 'membership-remove-edit' &&
        value.reason !== 'identity-conflict')
    ) {
      return null;
    }
    const resourceId = parseResourceId(value.resourceId);
    return resourceId.ok
      ? Object.freeze({ kind: value.kind, resourceId: resourceId.value, reason: value.reason })
      : null;
  }
  if (value.kind === 'path-conflict') {
    if (!hasExactKeys(value, ['kind', 'paths']) || !Array.isArray(value.paths)) return null;
    const paths = value.paths.map((path) =>
      typeof path === 'string' ? parseWorkspacePath(path) : { ok: false as const }
    );
    const first = paths[0];
    return first?.ok && paths.every((path) => path.ok)
      ? Object.freeze({
          kind: value.kind,
          paths: [
            first.value,
            ...paths.slice(1).map((path) => path.value),
          ] as import('./types').NonEmpty<import('./identity').WorkspacePath>,
        })
      : null;
  }
  return null;
}

function decodeReplayError(
  value: Readonly<Record<string, unknown>>
): MutationError | RecoveryError | null {
  if (value.kind === 'operation-id-reused' && typeof value.operationId === 'string') {
    const operationId = parseOperationId(value.operationId);
    return hasExactKeys(value, ['kind', 'operationId']) && operationId.ok
      ? Object.freeze({ kind: value.kind, operationId: operationId.value })
      : null;
  }
  if (value.kind === 'invalid-mutation' && typeof value.reason === 'string') {
    return hasExactKeys(value, ['kind', 'reason']) && isValidCanonicalText(value.reason)
      ? Object.freeze({ kind: value.kind, reason: value.reason })
      : null;
  }
  if (
    value.kind === 'workspace-mismatch' ||
    value.kind === 'invalid-expiry' ||
    value.kind === 'invalid-payload' ||
    value.kind === 'invalid-recovery-reference'
  ) {
    return hasExactKeys(value, ['kind']) ? Object.freeze({ kind: value.kind }) : null;
  }
  return null;
}

function decodeReceiptCandidate(
  value: Readonly<Record<string, unknown>>,
  operationId: OperationId,
  context: {
    readonly workspaceId: WorkspaceId;
    readonly recoveryCandidates: ReadonlyMap<RecoveryCandidateId, RecoveryCandidateRecord>;
  }
): import('./types').RecoveryCandidateView | null {
  if (typeof value.id !== 'string') return null;
  const id = parseRecoveryCandidateId(value.id);
  if (!id.ok) return null;
  const record = context.recoveryCandidates.get(id.value);
  if (
    !record ||
    record.view.operationId !== operationId ||
    record.view.workspaceId !== context.workspaceId
  ) {
    return null;
  }
  const actual = canonicalize(value);
  const expected = canonicalize(record.view);
  return actual.ok && expected.ok && actual.value === expected.value ? record.view : null;
}

function invalidBody(recordKind: ImmutableRecordKind): Result<never, CanonicalImportError> {
  return { ok: false, error: { kind: 'invalid-record-body', recordKind } };
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[]
): boolean {
  const actual = Object.keys(value).sort(deterministicCompare);
  const sortedExpected = [...expected].sort(deterministicCompare);
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isImmutableRecordKind(value: unknown): value is ImmutableRecordKind {
  return (
    value === 'resource-state' ||
    value === 'resource-revision' ||
    value === 'workspace-version' ||
    value === 'operation-receipt' ||
    value === 'recovery-candidate' ||
    value === 'workspace-resource-map-node' ||
    value === 'workspace-path-map-node'
  );
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deterministicCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
