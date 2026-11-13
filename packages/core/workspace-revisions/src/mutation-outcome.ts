import { makeRevisionGraph, type ResourceRevisionRecord, type RevisionGraphData } from './graph';
import type { WorkspaceVersionId } from './identity';
import type {
  ApplyMutationResult,
  Conflict,
  ImmutableRecordWrite,
  MutationEffects,
  WorkspaceResourceSlotView,
} from './types';
import type { ApplyMutationInput } from './mutation-types';
import { defineWorkspaceVersion, immutableRecordWrite } from './records';
import { defineReceipt, graphWithReceipt, type CanonicalRequest } from './receipt';
import type { ResourceStateRecord } from './resource-state';
import {
  emptyWorkspaceIndexes,
  immutableWorkspaceIndexWrites,
  inspectWorkspaceResourceInIndexes,
  updateWorkspaceResourceIndexes,
  type WorkspaceIndexes,
} from './workspace-index';

export function acceptVersion(
  input: ApplyMutationInput,
  data: RevisionGraphData,
  request: CanonicalRequest,
  acceptedHead: WorkspaceVersionId | null,
  resourceId: import('./identity').ResourceId,
  nextSlot: WorkspaceResourceSlotView | null,
  effects: MutationEffects,
  created: {
    readonly state: ResourceStateRecord | null;
    readonly revision: ResourceRevisionRecord | null;
  }
): ApplyMutationResult {
  const priorIndexes = indexesAt(data, acceptedHead);
  const previousSlot = inspectWorkspaceResourceInIndexes(priorIndexes, resourceId) ?? null;
  const indexUpdate = updateWorkspaceResourceIndexes({
    indexes: priorIndexes,
    resourceId,
    nextSlot,
    previousState: stateForSlot(data, previousSlot),
    nextState: stateForSlot(data, nextSlot),
  });
  if (!indexUpdate.ok) {
    if (indexUpdate.error.kind === 'path-conflict') {
      return conflictMutation(input, data, request, {
        kind: 'path-conflict',
        paths: indexUpdate.error.paths,
      });
    }
    const reason =
      indexUpdate.error.kind === 'invalid-materialized-path'
        ? `invalid materialized path: ${indexUpdate.error.error.kind}`
        : indexUpdate.error.reason;
    return rejectMutation(input, data, request, reason);
  }
  const version = defineWorkspaceVersion({
    workspaceId: data.workspaceId,
    parentIds: acceptedHead === null ? [] : [acceptedHead],
    indexes: indexUpdate.value.indexes,
  });
  const refAdvance = Object.freeze({
    workspaceId: data.workspaceId,
    refName: input.refName,
    expected: input.expectedHead,
    next: version.view.id,
  });
  const revisionWrite = created.revision
    ? immutableRecordWrite('resource-revision', created.revision)
    : null;
  const stateWrite = created.state ? immutableRecordWrite('resource-state', created.state) : null;
  const versionWrite = immutableRecordWrite('workspace-version', version);
  const preReceiptWrites: ImmutableRecordWrite[] = [
    ...(stateWrite ? [stateWrite] : []),
    ...(revisionWrite ? [revisionWrite] : []),
    ...immutableWorkspaceIndexWrites(indexUpdate.value.writes),
    versionWrite,
  ];
  const receipt = defineReceipt(input.operationId, request, {
    outcome: 'changed',
    version: version.view,
    effects,
    refAdvance,
    recordWrites: preReceiptWrites,
  });
  const refs = new Map(data.refs);
  refs.set(input.refName, version.view.id);
  const workspaceVersions = data.workspaceVersions.set(version.view.id, version).index;
  const operationReceipts = data.operationReceipts.set(input.operationId, receipt.record).index;
  const nextGraph = makeRevisionGraph({
    ...data,
    refs,
    workspaceVersions,
    operationReceipts,
  });

  const replay = receipt.record.replay;
  if (replay.outcome !== 'changed') throw new Error('Changed receipt hydrated the wrong outcome.');

  return {
    kind: 'changed',
    graph: nextGraph,
    version: version.view,
    effects,
    publication: replay.publication,
  };
}

export function noOpMutation(
  input: ApplyMutationInput,
  data: RevisionGraphData,
  request: CanonicalRequest,
  head: WorkspaceVersionId | null,
  reason: Extract<ApplyMutationResult, { readonly kind: 'no-op' }>['reason']
): ApplyMutationResult {
  const receipt = defineReceipt(input.operationId, request, {
    outcome: 'no-op',
    head,
    reason,
    recordWrites: [],
  });
  const replay = receipt.record.replay;
  if (replay.outcome !== 'no-op') throw new Error('No-op receipt hydrated the wrong outcome.');
  return {
    kind: 'no-op',
    graph: graphWithReceipt(data, receipt.record),
    head,
    reason,
    recordWrites: replay.recordWrites,
  };
}

export function conflictMutation(
  input: ApplyMutationInput,
  data: RevisionGraphData,
  request: CanonicalRequest,
  conflict: Conflict
): ApplyMutationResult {
  const receipt = defineReceipt(input.operationId, request, {
    outcome: 'conflict',
    conflicts: [conflict],
    recordWrites: [],
  });
  const replay = receipt.record.replay;
  if (replay.outcome !== 'conflict')
    throw new Error('Conflict receipt hydrated the wrong outcome.');
  return {
    kind: 'conflict',
    graph: graphWithReceipt(data, receipt.record),
    conflicts: [conflict],
    recordWrites: replay.recordWrites,
  };
}

export function rejectMutation(
  input: ApplyMutationInput,
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
  if (replay.outcome !== 'rejected')
    throw new Error('Rejected receipt hydrated the wrong outcome.');
  return {
    kind: 'rejected',
    graph: graphWithReceipt(data, receipt.record),
    error,
    recordWrites: replay.recordWrites,
  };
}

export function dataWithObjects(
  data: RevisionGraphData,
  state: ResourceStateRecord,
  revision: ResourceRevisionRecord
): RevisionGraphData {
  const resourceStates = data.resourceStates.set(state.hash, state).index;
  const resourceRevisions = data.resourceRevisions.set(revision.view.id, revision).index;
  return { ...data, resourceStates, resourceRevisions };
}

export function dataWithRevisionAndOptionalState(
  data: RevisionGraphData,
  revision: ResourceRevisionRecord,
  state: ResourceStateRecord | null
): RevisionGraphData {
  const resourceStates = state
    ? data.resourceStates.set(state.hash, state).index
    : data.resourceStates;
  const resourceRevisions = data.resourceRevisions.set(revision.view.id, revision).index;
  return { ...data, resourceStates, resourceRevisions };
}

function indexesAt(data: RevisionGraphData, head: WorkspaceVersionId | null): WorkspaceIndexes {
  if (head === null) return emptyWorkspaceIndexes();
  const version = data.workspaceVersions.get(head);
  if (!version) throw new Error('Accepted ref points to a missing workspace version.');
  return version.indexes;
}

export function slotAt(
  data: RevisionGraphData,
  head: WorkspaceVersionId | null,
  resourceId: import('./identity').ResourceId
): WorkspaceResourceSlotView | undefined {
  return inspectWorkspaceResourceInIndexes(indexesAt(data, head), resourceId);
}

export function activeSlotAt(
  data: RevisionGraphData,
  head: WorkspaceVersionId | null,
  resourceId: import('./identity').ResourceId
): WorkspaceResourceSlotView | undefined {
  const slot = slotAt(data, head, resourceId);
  return slot && !slot.tombstone && slot.path !== null ? slot : undefined;
}

function stateForSlot(
  data: RevisionGraphData,
  slot: WorkspaceResourceSlotView | null
): ResourceStateRecord | null {
  if (!slot || slot.tombstone || slot.path === null) return null;
  const revision = data.resourceRevisions.get(slot.revisionId);
  if (!revision || revision.view.stateHash === null) {
    throw new Error('Active workspace slot references an invalid resource revision.');
  }
  const state = data.resourceStates.get(revision.view.stateHash);
  if (!state) throw new Error('Resource revision references a missing resource state.');
  return state;
}
