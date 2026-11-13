import type { CanonicalImportError, DecodedCanonicalRecord } from './codec-types';
import type {
  RecoveryCandidateRecord,
  ResourceRevisionRecord,
  WorkspaceVersionRecord,
} from './graph';
import {
  parseBlobHash,
  parseOperationId,
  parseRecoveryCandidateId,
  parseResourceId,
  parseResourceRevisionId,
  parseWorkspaceVersionId,
  type Result,
  type WorkspaceId,
  type WorkspaceVersionId,
} from './identity';
import type { ImmutableRecordKind } from './types';
import { parseWorkspacePath } from './path';
import { isValidCanonicalText } from './unicode';

export function decodeRecoveryCandidate(
  decoded: DecodedCanonicalRecord,
  context: {
    readonly workspaceId: WorkspaceId;
    readonly resourceRevisions: ReadonlyMap<string, ResourceRevisionRecord>;
    readonly workspaceVersions: ReadonlyMap<string, WorkspaceVersionRecord>;
  }
): Result<RecoveryCandidateRecord, CanonicalImportError> {
  const body = decoded.body;
  if (
    !hasExactKeys(body, ['formatVersion', 'operationId', 'candidate']) ||
    typeof body.operationId !== 'string' ||
    !isPlainRecord(body.candidate)
  ) {
    return invalidBody('recovery-candidate');
  }
  const operationId = parseOperationId(body.operationId);
  const id = parseRecoveryCandidateId(decoded.id);
  if (!operationId.ok || !id.ok) return invalidBody('recovery-candidate');
  const status = validateRecoveryCandidateBody(body.candidate, context);
  if (!status) return invalidBody('recovery-candidate');
  return {
    ok: true,
    value: Object.freeze({
      canonicalJson: decoded.canonicalJson,
      view: Object.freeze({
        id: id.value,
        workspaceId: context.workspaceId,
        operationId: operationId.value,
        status,
      }),
    }),
  };
}

function validateRecoveryCandidateBody(
  candidate: Readonly<Record<string, unknown>>,
  context: {
    readonly workspaceId: WorkspaceId;
    readonly resourceRevisions: ReadonlyMap<string, ResourceRevisionRecord>;
    readonly workspaceVersions: ReadonlyMap<string, WorkspaceVersionRecord>;
  }
): 'invalid' | 'valid-unaccepted' | null {
  if (
    candidate.workspaceId !== context.workspaceId ||
    typeof candidate.expiresAtEpochMs !== 'number' ||
    !Number.isSafeInteger(candidate.expiresAtEpochMs) ||
    candidate.expiresAtEpochMs < 0
  ) {
    return null;
  }
  if (candidate.kind === 'invalid-working-state') {
    if (
      !hasExactKeys(candidate, [
        'kind',
        'workspaceId',
        'claimedResourceId',
        'baseRevisionId',
        'observedPath',
        'payloads',
        'failure',
        'expiresAtEpochMs',
      ]) ||
      (candidate.claimedResourceId !== null && typeof candidate.claimedResourceId !== 'string') ||
      (candidate.baseRevisionId !== null && typeof candidate.baseRevisionId !== 'string') ||
      typeof candidate.observedPath !== 'string' ||
      !Array.isArray(candidate.payloads) ||
      candidate.payloads.length === 0 ||
      !candidate.payloads.every(isRecoveryPayload) ||
      !hasUniqueSortedRecoveryRoles(candidate.payloads) ||
      !isRecoveryFailure(candidate.failure) ||
      !parseWorkspacePath(candidate.observedPath).ok
    ) {
      return null;
    }
    const resourceId =
      candidate.claimedResourceId === null
        ? { ok: true as const, value: null }
        : parseResourceId(candidate.claimedResourceId);
    const revisionId =
      candidate.baseRevisionId === null
        ? { ok: true as const, value: null }
        : parseResourceRevisionId(candidate.baseRevisionId);
    if (!resourceId.ok || !revisionId.ok) return null;
    if (revisionId.value !== null) {
      const revision = context.resourceRevisions.get(revisionId.value);
      if (
        !revision ||
        (resourceId.value !== null && revision.view.resourceId !== resourceId.value)
      ) {
        return null;
      }
    }
    return 'invalid';
  }
  if (
    candidate.kind !== 'divergent-workspace' ||
    !hasExactKeys(candidate, [
      'kind',
      'workspaceId',
      'baseVersionId',
      'candidateVersionId',
      'acceptedVersionId',
      'expiresAtEpochMs',
    ]) ||
    typeof candidate.baseVersionId !== 'string' ||
    typeof candidate.candidateVersionId !== 'string' ||
    typeof candidate.acceptedVersionId !== 'string'
  ) {
    return null;
  }
  const base = parseWorkspaceVersionId(candidate.baseVersionId);
  const proposed = parseWorkspaceVersionId(candidate.candidateVersionId);
  const accepted = parseWorkspaceVersionId(candidate.acceptedVersionId);
  if (!base.ok || !proposed.ok || !accepted.ok) return null;
  if (
    base.value === proposed.value ||
    proposed.value === accepted.value ||
    !context.workspaceVersions.has(base.value) ||
    !context.workspaceVersions.has(proposed.value) ||
    !context.workspaceVersions.has(accepted.value) ||
    !isWorkspaceAncestor(context.workspaceVersions, base.value, proposed.value) ||
    !isWorkspaceAncestor(context.workspaceVersions, base.value, accepted.value)
  ) {
    return null;
  }
  return 'valid-unaccepted';
}

function hasUniqueSortedRecoveryRoles(payloads: readonly unknown[]): boolean {
  let priorRole: string | null = null;
  for (const payload of payloads) {
    if (!isPlainRecord(payload) || typeof payload.role !== 'string') return false;
    if (priorRole !== null && deterministicCompare(priorRole, payload.role) >= 0) return false;
    priorRole = payload.role;
  }
  return true;
}

function isRecoveryPayload(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ['role', 'mediaType', 'blob']) &&
    (value.role === 'observed-bytes' || value.role === 'supporting-file') &&
    typeof value.mediaType === 'string' &&
    isValidText(value.mediaType) &&
    decodeBlob(value.blob) !== null
  );
}

function isRecoveryFailure(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ['kind', 'code']) &&
    (value.kind === 'parse-failed' ||
      value.kind === 'identity-conflict' ||
      value.kind === 'materialization-conflict') &&
    typeof value.code === 'string' &&
    isValidText(value.code)
  );
}

function isWorkspaceAncestor(
  versions: ReadonlyMap<string, WorkspaceVersionRecord>,
  ancestorId: WorkspaceVersionId,
  descendantId: WorkspaceVersionId
): boolean {
  const pending = [descendantId];
  const seen = new Set<WorkspaceVersionId>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || seen.has(current)) continue;
    if (current === ancestorId) return true;
    seen.add(current);
    const version = versions.get(current);
    if (!version) return false;
    pending.push(...version.view.parentIds);
  }
  return false;
}

function decodeBlob(
  value: unknown
): { readonly hash: import('./identity').BlobHash; readonly byteLength: number } | null {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['hash', 'byteLength']) ||
    typeof value.hash !== 'string' ||
    typeof value.byteLength !== 'number' ||
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength < 0
  ) {
    return null;
  }
  const hash = parseBlobHash(value.hash);
  return hash.ok ? Object.freeze({ hash: hash.value, byteLength: value.byteLength }) : null;
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

function isValidText(value: string): boolean {
  return isValidCanonicalText(value);
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deterministicCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
