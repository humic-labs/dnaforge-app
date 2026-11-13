import {
  makeRevisionGraph,
  requireGraphData,
  type RevisionGraphData,
  type WorkspaceVersionRecord,
} from './graph';
import type { OperationId, RefName, WorkspaceVersionId } from './identity';
import { deepFreeze } from './immutable';
import type {
  ApplyMutationResult,
  Conflict,
  ImmutableRecordWrite,
  MutationEffects,
  NonEmpty,
  RevisionGraph,
} from './types';
import {
  buildMergedIndexes,
  compareConflicts,
  composeWorkspaceSlots,
  maximalCommonAncestors,
} from './merge-structure';
import { defineWorkspaceVersion, immutableRecordWrite } from './records';
import {
  defineCanonicalRequest,
  defineReceipt,
  graphWithReceipt,
  type CanonicalRequest,
} from './receipt';
import { isValidCanonicalText } from './unicode';

export interface MergeInput {
  readonly graph: RevisionGraph;
  readonly refName: RefName;
  readonly expectedHead: WorkspaceVersionId;
  readonly operationId: OperationId;
  readonly leftVersionId: WorkspaceVersionId;
  readonly rightVersionId: WorkspaceVersionId;
}

export type MergeResult =
  | Extract<
      ApplyMutationResult,
      {
        readonly kind: 'changed' | 'replay' | 'conflict' | 'rejected';
      }
    >
  | {
      readonly kind: 'no-op';
      readonly graph: RevisionGraph;
      readonly head: WorkspaceVersionId;
      readonly reason: 'sources-already-converged';
      readonly recordWrites: NonEmpty<ImmutableRecordWrite>;
    };

export function mergeWorkspaceVersions(input: MergeInput): MergeResult {
  return deepFreeze(reduceMerge(input));
}

function reduceMerge(input: MergeInput): MergeResult {
  const data = requireGraphData(input.graph);
  if (!isValidCanonicalText(input.refName)) {
    return {
      kind: 'rejected',
      graph: input.graph,
      error: { kind: 'invalid-mutation', reason: 'invalid ref name' },
      recordWrites: [],
    };
  }
  const request = canonicalMergeRequest(input, data);
  const priorReceipt = data.operationReceipts.get(input.operationId);
  if (priorReceipt) {
    if (priorReceipt.requestCanonicalJson === request.canonicalJson) {
      return { kind: 'replay', graph: input.graph, original: priorReceipt.replay };
    }
    return {
      kind: 'rejected',
      graph: input.graph,
      error: { kind: 'operation-id-reused', operationId: input.operationId },
      recordWrites: [],
    };
  }

  if (!data.refs.has(input.refName)) {
    return rejectMerge(input, data, request, `unknown ref: ${input.refName}`);
  }
  const acceptedHead = data.refs.get(input.refName) ?? null;
  if (acceptedHead !== input.expectedHead) {
    return conflictMerge(input, data, request, [
      { kind: 'ref-head-mismatch', expected: input.expectedHead, actual: acceptedHead },
    ]);
  }

  const left = data.workspaceVersions.get(input.leftVersionId);
  const right = data.workspaceVersions.get(input.rightVersionId);
  if (!left || !right) {
    return rejectMerge(input, data, request, 'merge references an unknown workspace version');
  }
  if (acceptedHead !== left.view.id && acceptedHead !== right.view.id) {
    return rejectMerge(input, data, request, 'accepted head must be one of the merge sources');
  }
  if (left.view.id === right.view.id) return noOpMerge(input, data, request, left.view.id);
  if (isWorkspaceAncestor(data, left.view.id, right.view.id)) {
    return acceptedHead === right.view.id
      ? noOpMerge(input, data, request, right.view.id)
      : fastForwardMerge(input, data, request, right);
  }
  if (isWorkspaceAncestor(data, right.view.id, left.view.id)) {
    return acceptedHead === left.view.id
      ? noOpMerge(input, data, request, left.view.id)
      : fastForwardMerge(input, data, request, left);
  }

  const mergeBases = maximalCommonAncestors(data, left.view.id, right.view.id);
  if (mergeBases.length === 0) {
    return rejectMerge(input, data, request, 'merge sources have no common ancestor');
  }
  if (mergeBases.length > 1) {
    return rejectMerge(input, data, request, 'merge sources have ambiguous maximal merge bases');
  }
  const baseId = mergeBases[0];
  if (!baseId) throw new Error('Unique merge-base resolution returned no base.');
  const base = data.workspaceVersions.get(baseId);
  if (!base) throw new Error('Resolved merge base is missing from the revision graph.');

  const composed = composeWorkspaceSlots(base, left, right);
  if (composed.conflicts.length > 0) {
    return conflictMerge(input, data, request, composed.conflicts);
  }
  const built = buildMergedIndexes(composed.slots, data);
  if (!built.ok) {
    if (built.error.kind === 'path-conflict') {
      return conflictMerge(input, data, request, [
        { kind: 'path-conflict', paths: built.error.paths },
      ]);
    }
    const reason =
      built.error.kind === 'invalid-materialized-path'
        ? `invalid materialized path: ${built.error.error.kind}`
        : built.error.reason;
    return rejectMerge(input, data, request, reason);
  }

  const version = defineWorkspaceVersion({
    workspaceId: data.workspaceId,
    parentIds: [left.view.id, right.view.id],
    indexes: built.value.indexes,
  });
  return acceptMerge(input, data, request, version, built.value.writes);
}

function canonicalMergeRequest(input: MergeInput, data: RevisionGraphData): CanonicalRequest {
  const sourceVersionIds = [input.leftVersionId, input.rightVersionId].sort(deterministicCompare);
  return defineCanonicalRequest({
    formatVersion: 1,
    kind: 'merge-workspace-versions',
    workspaceId: data.workspaceId,
    refName: input.refName,
    expectedHead: input.expectedHead,
    sourceVersionIds,
  });
}

function noOpMerge(
  input: MergeInput,
  data: RevisionGraphData,
  request: CanonicalRequest,
  head: WorkspaceVersionId
): MergeResult {
  const receipt = defineReceipt(input.operationId, request, {
    outcome: 'no-op',
    head,
    reason: 'sources-already-converged',
    recordWrites: [],
  });
  const replay = receipt.record.replay;
  if (replay.outcome !== 'no-op') throw new Error('No-op receipt hydrated the wrong outcome.');
  return {
    kind: 'no-op',
    graph: graphWithReceipt(data, receipt.record),
    head,
    reason: 'sources-already-converged',
    recordWrites: replay.recordWrites,
  };
}

function fastForwardMerge(
  input: MergeInput,
  data: RevisionGraphData,
  request: CanonicalRequest,
  version: WorkspaceVersionRecord
): MergeResult {
  return acceptMerge(input, data, request, version, []);
}

function acceptMerge(
  input: MergeInput,
  data: RevisionGraphData,
  request: CanonicalRequest,
  version: WorkspaceVersionRecord,
  indexWrites: readonly ImmutableRecordWrite[]
): MergeResult {
  const created = !data.workspaceVersions.has(version.view.id);
  const effects: MutationEffects = {
    resourceState: 'none',
    resourceRevision: 'reused',
    workspaceVersion: created ? 'created' : 'reused',
  };
  const refAdvance = Object.freeze({
    workspaceId: data.workspaceId,
    refName: input.refName,
    expected: input.expectedHead,
    next: version.view.id,
  });
  const versionWrite = created ? immutableRecordWrite('workspace-version', version) : null;
  const preReceiptWrites = versionWrite ? [...indexWrites, versionWrite] : [];
  const receipt = defineReceipt(input.operationId, request, {
    outcome: 'changed',
    version: version.view,
    effects,
    refAdvance,
    recordWrites: preReceiptWrites,
  });
  const workspaceVersions = data.workspaceVersions.set(version.view.id, version).index;
  const operationReceipts = data.operationReceipts.set(input.operationId, receipt.record).index;
  const refs = new Map(data.refs);
  refs.set(input.refName, version.view.id);
  const graph = makeRevisionGraph({
    ...data,
    refs,
    workspaceVersions,
    operationReceipts,
  });
  const replay = receipt.record.replay;
  if (replay.outcome !== 'changed') throw new Error('Changed receipt hydrated the wrong outcome.');
  return {
    kind: 'changed',
    graph,
    version: version.view,
    effects,
    publication: replay.publication,
  };
}

function conflictMerge(
  input: MergeInput,
  data: RevisionGraphData,
  request: CanonicalRequest,
  conflicts: readonly Conflict[]
): MergeResult {
  const sorted = [...conflicts].sort(compareConflicts);
  const first = sorted[0];
  if (!first) throw new Error('A conflict result requires at least one conflict.');
  const nonEmpty: NonEmpty<Conflict> = [first, ...sorted.slice(1)];
  const receipt = defineReceipt(input.operationId, request, {
    outcome: 'conflict',
    conflicts: nonEmpty,
    recordWrites: [],
  });
  const replay = receipt.record.replay;
  if (replay.outcome !== 'conflict') {
    throw new Error('Conflict receipt hydrated the wrong outcome.');
  }
  return {
    kind: 'conflict',
    graph: graphWithReceipt(data, receipt.record),
    conflicts: nonEmpty,
    recordWrites: replay.recordWrites,
  };
}

function rejectMerge(
  input: MergeInput,
  data: RevisionGraphData,
  request: CanonicalRequest,
  reason: string
): MergeResult {
  const error = { kind: 'invalid-mutation' as const, reason };
  const receipt = defineReceipt(input.operationId, request, {
    outcome: 'rejected',
    error,
    recordWrites: [],
  });
  const replay = receipt.record.replay;
  if (replay.outcome !== 'rejected') {
    throw new Error('Rejected receipt hydrated the wrong outcome.');
  }
  return {
    kind: 'rejected',
    graph: graphWithReceipt(data, receipt.record),
    error,
    recordWrites: replay.recordWrites,
  };
}

function isWorkspaceAncestor(
  data: RevisionGraphData,
  ancestor: WorkspaceVersionId,
  descendant: WorkspaceVersionId
): boolean {
  const pending = [descendant];
  const visited = new Set<WorkspaceVersionId>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current)) continue;
    if (current === ancestor) return true;
    visited.add(current);
    const record = data.workspaceVersions.get(current);
    if (record) pending.push(...record.view.parentIds);
  }
  return false;
}

function deterministicCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
