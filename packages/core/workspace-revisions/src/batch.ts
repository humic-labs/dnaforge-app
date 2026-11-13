import { canonicalize } from './canonical-json';
import { makeRevisionGraph, requireGraphData, type RevisionGraphData } from './graph';
import type { OperationId, RefName, WorkspaceVersionId } from './identity';
import { deepFreeze } from './immutable';
import { canonicalMutation, mutationState } from './mutation-request';
import { defineWorkspaceVersion, immutableRecordWrite } from './records';
import {
  defineCanonicalRequest,
  defineReceipt,
  graphWithReceipt,
  type CanonicalRequest,
  type ReceiptReplayInput,
} from './receipt';
import { isCanonicalRecordWithinByteLimit } from './record-budgets';
import { applyWorkspaceMutation } from './reduce';
import { getResourceStateRecord } from './resource-state';
import type {
  ApplyMutationResult,
  ImmutableRecordWrite,
  MutationEffects,
  RevisionGraph,
  WorkspaceMutation,
} from './types';
import { isValidCanonicalText } from './unicode';

export interface ApplyBatchInput {
  readonly graph: RevisionGraph;
  readonly refName: RefName;
  readonly expectedHead: WorkspaceVersionId | null;
  readonly operationId: OperationId;

  readonly mutations: readonly WorkspaceMutation[];

  readonly validation?: BatchValidation;
}

export interface BatchValidation {
  readonly version: string;
  readonly validate: (candidate: {
    readonly graph: RevisionGraph;
    readonly head: WorkspaceVersionId | null;
  }) => string | null;
}

export function applyWorkspaceBatch(input: ApplyBatchInput): ApplyMutationResult {
  return deepFreeze(reduceBatch(input));
}

function reduceBatch(input: ApplyBatchInput): ApplyMutationResult {
  const original = requireGraphData(input.graph);
  if (!isValidCanonicalText(input.refName)) return unadmitted(input, 'invalid ref name');
  if (input.validation && !isValidCanonicalText(input.validation.version))
    return unadmitted(input, 'invalid validation version');
  for (const mutation of input.mutations) {
    const state = mutationState(mutation);
    if (state && !getResourceStateRecord(state))
      return unadmitted(input, 'unrecognized resource state');
  }
  const body = {
    formatVersion: 1,
    kind: 'workspace-batch',
    workspaceId: original.workspaceId,
    refName: input.refName,
    expectedHead: input.expectedHead,
    mutations: input.mutations.map(canonicalMutation),
    ...(input.validation ? { validationVersion: input.validation.version } : {}),
  };
  const canonical = canonicalize(body);
  if (!canonical.ok) return unadmitted(input, 'batch request exceeds canonical limits');
  const request = defineCanonicalRequest(body);
  const previous = original.operationReceipts.get(input.operationId);
  if (previous) {
    return previous.requestCanonicalJson === request.canonicalJson
      ? { kind: 'replay', graph: input.graph, original: previous.replay }
      : {
          kind: 'rejected',
          graph: input.graph,
          error: { kind: 'operation-id-reused', operationId: input.operationId },
          recordWrites: [],
        };
  }
  if (input.mutations.length === 0) return reject(input, original, request, 'batch is empty');
  const seen = new Set<string>();
  for (const mutation of input.mutations) {
    if (seen.has(mutation.resourceId))
      return reject(input, original, request, 'batch requires one final mutation per resource');
    seen.add(mutation.resourceId);
  }
  if (!original.refs.has(input.refName))
    return reject(input, original, request, `unknown ref: ${input.refName}`);
  const head = original.refs.get(input.refName) ?? null;
  if (head !== input.expectedHead) {
    const conflicts = [
      { kind: 'ref-head-mismatch' as const, expected: input.expectedHead, actual: head },
    ] as const;
    const receipt = defineReceipt(input.operationId, request, {
      outcome: 'conflict',
      conflicts,
      recordWrites: [],
    });
    const replay = receipt.record.replay;
    if (replay.outcome !== 'conflict') throw new Error('Batch conflict receipt mismatch.');
    return {
      kind: 'conflict',
      graph: graphWithReceipt(original, receipt.record),
      conflicts,
      recordWrites: replay.recordWrites,
    };
  }

  let candidate = input.graph;
  let candidateHead = head;
  const writes = new Map<string, ImmutableRecordWrite>();
  const effects: { -readonly [K in keyof MutationEffects]: MutationEffects[K] } = {
    resourceState: 'none',
    resourceRevision: 'none',
    workspaceVersion: 'reused',
  };
  for (const mutation of input.mutations) {
    const result = applyWorkspaceMutation({
      graph: candidate,
      refName: input.refName,
      expectedHead: candidateHead,
      operationId: input.operationId,
      mutation,
    });
    if (result.kind === 'rejected')
      return reject(
        input,
        original,
        request,
        result.error.kind === 'invalid-mutation'
          ? result.error.reason
          : 'unexpected operation receipt'
      );
    if (result.kind === 'conflict') {
      const receipt = defineReceipt(input.operationId, request, {
        outcome: 'conflict',
        conflicts: result.conflicts,
        recordWrites: [],
      });
      const replay = receipt.record.replay;
      if (replay.outcome !== 'conflict') throw new Error('Batch conflict receipt mismatch.');
      return {
        kind: 'conflict',
        graph: graphWithReceipt(original, receipt.record),
        conflicts: result.conflicts,
        recordWrites: replay.recordWrites,
      };
    }
    if (result.kind === 'replay')
      throw new Error('Temporary batch receipt leaked between mutations.');
    if (result.kind === 'changed') {
      candidateHead = result.version.id;
      for (const write of result.publication.recordWrites) {
        if (write.kind !== 'workspace-version' && write.kind !== 'operation-receipt')
          writes.set(write.id, write);
      }
      if (result.effects.resourceState === 'created' || effects.resourceState === 'none')
        effects.resourceState = result.effects.resourceState;
      if (result.effects.resourceRevision === 'created' || effects.resourceRevision === 'none')
        effects.resourceRevision = result.effects.resourceRevision;
      effects.workspaceVersion = 'created';
    }
    candidate = makeRevisionGraph({
      ...requireGraphData(result.graph),
      operationReceipts: original.operationReceipts,
    });
  }

  const invalid = input.validation?.validate({ graph: candidate, head: candidateHead });
  if (invalid !== undefined && invalid !== null) {
    if (!isValidCanonicalText(invalid))
      throw new TypeError('Batch validator returned an invalid rejection reason.');
    return reject(input, original, request, invalid);
  }

  if (candidateHead === head) {
    const receipt = defineReceipt(input.operationId, request, {
      outcome: 'no-op',
      head,
      reason: 'state-unchanged',
      recordWrites: [],
    });
    const replay = receipt.record.replay;
    if (replay.outcome !== 'no-op') throw new Error('Batch no-op receipt mismatch.');
    return {
      kind: 'no-op',
      graph: graphWithReceipt(original, receipt.record),
      head,
      reason: 'state-unchanged',
      recordWrites: replay.recordWrites,
    };
  }
  const candidateData = requireGraphData(candidate);
  const candidateVersion = candidateHead
    ? candidateData.workspaceVersions.get(candidateHead)
    : undefined;
  if (!candidateVersion) throw new Error('Batch candidate version missing.');
  const version = defineWorkspaceVersion({
    workspaceId: original.workspaceId,
    parentIds: head ? [head] : [],
    indexes: candidateVersion.indexes,
  });
  writes.set(version.view.id, immutableRecordWrite('workspace-version', version));
  const replayInput: ReceiptReplayInput = {
    outcome: 'changed',
    version: version.view,
    effects,
    refAdvance: {
      workspaceId: original.workspaceId,
      refName: input.refName,
      expected: head,
      next: version.view.id,
    },
    recordWrites: [...writes.values()],
  };
  const receiptBytes = canonicalize({
    formatVersion: 2,
    operationId: input.operationId,
    request: body,
    result: replayInput,
  });
  if (
    !receiptBytes.ok ||
    !isCanonicalRecordWithinByteLimit('operation-receipt', receiptBytes.value)
  ) {
    return reject(input, original, request, 'batch publication exceeds canonical receipt limits');
  }
  const receipt = defineReceipt(input.operationId, request, replayInput);
  const replay = receipt.record.replay;
  if (replay.outcome !== 'changed') throw new Error('Batch changed receipt mismatch.');
  const refs = new Map(original.refs);
  refs.set(input.refName, version.view.id);
  const graph = makeRevisionGraph({
    ...original,
    refs,
    resourceStates: candidateData.resourceStates,
    resourceRevisions: candidateData.resourceRevisions,
    workspaceVersions: original.workspaceVersions.set(version.view.id, version).index,
    operationReceipts: original.operationReceipts.set(input.operationId, receipt.record).index,
  });
  return {
    kind: 'changed',
    graph,
    version: version.view,
    effects,
    publication: replay.publication,
  };
}

function reject(
  input: ApplyBatchInput,
  data: RevisionGraphData,
  request: CanonicalRequest,
  reason: string
): ApplyMutationResult {
  const error = { kind: 'invalid-mutation' as const, reason };
  const receipt = defineReceipt(input.operationId, request, {
    outcome: 'rejected',
    error,
    recordWrites: [],
  });
  const replay = receipt.record.replay;
  if (replay.outcome !== 'rejected') throw new Error('Batch rejected receipt mismatch.');
  return {
    kind: 'rejected',
    graph: graphWithReceipt(data, receipt.record),
    error,
    recordWrites: replay.recordWrites,
  };
}

function unadmitted(input: ApplyBatchInput, reason: string): ApplyMutationResult {
  return {
    kind: 'rejected',
    graph: input.graph,
    error: { kind: 'invalid-mutation', reason },
    recordWrites: [],
  };
}
