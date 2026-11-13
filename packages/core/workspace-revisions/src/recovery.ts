import { canonicalize } from './canonical-json';
import {
  makeRevisionGraph,
  requireGraphData,
  type RecoveryCandidateRecord,
  type RevisionGraphData,
} from './graph';
import { hashCanonicalRecord } from './hash';
import type { CanonicalJson, RecoveryCandidateId, WorkspaceVersionId } from './identity';
import type {
  CaptureRecoveryResult,
  ImmutableRecordWrite,
  RecoveryCandidateInput,
  RecoveryError,
  RecoveryInput,
  RecoveryPayload,
} from './types';
import { defineCanonicalRequest, defineReceipt } from './receipt';
import { isCanonicalRecordWithinByteLimit } from './record-budgets';
import { isValidCanonicalText } from './unicode';
import { deepFreeze } from './immutable';

const MAX_RECOVERY_PAYLOADS = 512;

export function captureRecoveryCandidate(input: RecoveryInput): CaptureRecoveryResult {
  return deepFreeze(reduceRecoveryCandidate(input));
}

function reduceRecoveryCandidate(input: RecoveryInput): CaptureRecoveryResult {
  const data = requireGraphData(input.graph);
  if (input.candidate.workspaceId !== data.workspaceId) {
    return rejected(input, { kind: 'workspace-mismatch' });
  }
  if (!isValidExpiry(input.candidate.expiresAtEpochMs)) {
    return rejected(input, { kind: 'invalid-expiry' });
  }
  if (
    input.candidate.kind === 'invalid-working-state' &&
    !validateInvalidWorkingState(input.candidate)
  ) {
    return rejected(input, { kind: 'invalid-payload' });
  }

  const candidateBody = canonicalCandidate(input.candidate);
  const request = defineCanonicalRequest(
    Object.freeze({
      formatVersion: 1,
      workspaceId: data.workspaceId,
      candidate: candidateBody,
    })
  );
  const priorReceipt = data.operationReceipts.get(input.operationId);
  if (priorReceipt) {
    if (priorReceipt.requestCanonicalJson === request.canonicalJson) {
      return { kind: 'replay', graph: input.graph, original: priorReceipt.replay };
    }
    return rejected(input, {
      kind: 'operation-id-reused',
      operationId: input.operationId,
    });
  }
  if (!validateCandidateReferences(input.candidate, data)) {
    return rejected(input, { kind: 'invalid-recovery-reference' });
  }

  const canonicalJson = mustCanonicalize({
    formatVersion: 1,
    operationId: input.operationId,
    candidate: candidateBody,
  });
  if (!isCanonicalRecordWithinByteLimit('recovery-candidate', canonicalJson)) {
    return rejected(input, { kind: 'invalid-payload' });
  }
  const id: RecoveryCandidateId = hashCanonicalRecord('recovery-candidate', canonicalJson);
  const view = Object.freeze({
    id,
    workspaceId: data.workspaceId,
    operationId: input.operationId,
    status:
      input.candidate.kind === 'invalid-working-state'
        ? ('invalid' as const)
        : ('valid-unaccepted' as const),
  });
  const candidateRecord: RecoveryCandidateRecord = Object.freeze({ view, canonicalJson });
  const candidateWrite: ImmutableRecordWrite = Object.freeze({
    kind: 'recovery-candidate',
    id,
    canonicalJson,
  });
  const receipt = defineReceipt(input.operationId, request, {
    outcome: 'recovery-candidate',
    candidate: view,
    recordWrites: [candidateWrite],
  });
  const replay = receipt.record.replay;
  if (replay.outcome !== 'recovery-candidate') {
    throw new Error('Recovery receipt hydrated the wrong outcome.');
  }
  const recoveryCandidates = data.recoveryCandidates.set(id, candidateRecord).index;
  const operationReceipts = data.operationReceipts.set(input.operationId, receipt.record).index;
  const graph = makeRevisionGraph({
    ...data,
    recoveryCandidates,
    operationReceipts,
  });
  return {
    kind: 'captured',
    graph,
    candidate: view,
    recordWrites: replay.recordWrites,
  };
}

function validateCandidateReferences(
  candidate: RecoveryCandidateInput,
  data: RevisionGraphData
): boolean {
  if (candidate.kind === 'invalid-working-state') {
    if (candidate.baseRevisionId === null) return true;
    const base = data.resourceRevisions.get(candidate.baseRevisionId);
    return (
      base !== undefined &&
      (candidate.claimedResourceId === null || base.view.resourceId === candidate.claimedResourceId)
    );
  }
  if (
    candidate.baseVersionId === candidate.candidateVersionId ||
    candidate.candidateVersionId === candidate.acceptedVersionId ||
    !data.workspaceVersions.has(candidate.baseVersionId) ||
    !data.workspaceVersions.has(candidate.candidateVersionId) ||
    !data.workspaceVersions.has(candidate.acceptedVersionId) ||
    ![...data.refs.values()].includes(candidate.acceptedVersionId) ||
    [...data.refs.values()].includes(candidate.candidateVersionId)
  ) {
    return false;
  }
  return (
    isWorkspaceAncestor(data, candidate.baseVersionId, candidate.candidateVersionId) &&
    isWorkspaceAncestor(data, candidate.baseVersionId, candidate.acceptedVersionId)
  );
}

function isWorkspaceAncestor(
  data: RevisionGraphData,
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
    const version = data.workspaceVersions.get(current);
    if (!version) return false;
    pending.push(...version.view.parentIds);
  }
  return false;
}

function validateInvalidWorkingState(
  candidate: Extract<RecoveryCandidateInput, { readonly kind: 'invalid-working-state' }>
): boolean {
  if (
    candidate.payloads.length === 0 ||
    candidate.payloads.length > MAX_RECOVERY_PAYLOADS ||
    !isValidText(candidate.failure.code) ||
    candidate.payloads.some((payload) => !isValidPayload(payload))
  ) {
    return false;
  }
  const roles = new Set<string>();
  for (const payload of candidate.payloads) {
    if (roles.has(payload.role)) return false;
    roles.add(payload.role);
  }
  return true;
}

function isValidPayload(payload: RecoveryPayload): boolean {
  return (
    (payload.role === 'observed-bytes' || payload.role === 'supporting-file') &&
    isValidText(payload.mediaType) &&
    /^sha256:[0-9a-f]{64}$/u.test(payload.blob.hash) &&
    Number.isSafeInteger(payload.blob.byteLength) &&
    payload.blob.byteLength >= 0
  );
}

function canonicalCandidate(candidate: RecoveryCandidateInput): Readonly<object> {
  if (candidate.kind === 'invalid-working-state') {
    return Object.freeze({
      kind: candidate.kind,
      workspaceId: candidate.workspaceId,
      claimedResourceId: candidate.claimedResourceId,
      baseRevisionId: candidate.baseRevisionId,
      observedPath: candidate.observedPath,
      payloads: Object.freeze(
        candidate.payloads
          .map((payload) =>
            Object.freeze({
              role: payload.role,
              mediaType: payload.mediaType,
              blob: Object.freeze({
                hash: payload.blob.hash,
                byteLength: payload.blob.byteLength,
              }),
            })
          )
          .sort((left, right) => deterministicCompare(left.role, right.role))
      ),
      failure: Object.freeze({ kind: candidate.failure.kind, code: candidate.failure.code }),
      expiresAtEpochMs: candidate.expiresAtEpochMs,
    });
  }
  return Object.freeze({
    kind: candidate.kind,
    workspaceId: candidate.workspaceId,
    baseVersionId: candidate.baseVersionId,
    candidateVersionId: candidate.candidateVersionId,
    acceptedVersionId: candidate.acceptedVersionId,
    expiresAtEpochMs: candidate.expiresAtEpochMs,
  });
}

function rejected(input: RecoveryInput, error: RecoveryError): CaptureRecoveryResult {
  return { kind: 'rejected', graph: input.graph, error };
}

function isValidExpiry(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isValidText(value: string): boolean {
  return isValidCanonicalText(value);
}

function mustCanonicalize(value: unknown): CanonicalJson {
  const result = canonicalize(value);
  if (!result.ok) throw new Error(`Internal recovery record failed: ${result.error.kind}`);
  return result.value;
}

function deterministicCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
