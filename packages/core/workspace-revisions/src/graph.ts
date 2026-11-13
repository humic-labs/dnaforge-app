import type {
  RefName,
  OperationId,
  ResourceId,
  ResourceRevisionId,
  ResourceStateHash,
  Result,
  WorkspaceId,
  WorkspaceVersionId,
} from './identity';
import { brandValidated } from './identity';
import type { RevisionGraph, WorkspaceVersionView, WorkspaceResourceSlotView } from './types';
import type { ResourceRevisionView } from './graph-records';
export type { ResourceRevisionView } from './graph-records';
import { isValidCanonicalText } from './unicode';
import {
  inspectWorkspaceResourceInIndexes,
  listWorkspaceResourcesInIndexes,
} from './workspace-index';
import { deepFreeze } from './immutable';
import { emptyRevisionHistoryIndexes, type RevisionHistoryIndexes } from './graph-history';
import type { ResourceStateRecord } from './resource-state';

export type ResourceStateView = ResourceStateRecord;

export interface CreateGraphInput {
  readonly workspaceId: WorkspaceId;
  readonly acceptedRef: RefName;
}

export type UnknownObjectError =
  | { readonly kind: 'unknown-workspace-version'; readonly id: WorkspaceVersionId }
  | { readonly kind: 'unknown-resource-revision'; readonly id: ResourceRevisionId };

export function inspectResourceState(
  graph: RevisionGraph,
  hash: ResourceStateHash
): Result<
  ResourceStateView,
  { readonly kind: 'unknown-resource-state'; readonly hash: ResourceStateHash }
> {
  const record = requireGraphData(graph).resourceStates.get(hash);
  return deepFreeze(
    record
      ? { ok: true, value: record }
      : { ok: false, error: { kind: 'unknown-resource-state', hash } }
  );
}

export type {
  OperationReceiptRecord,
  RecoveryCandidateRecord,
  ResourceRevisionRecord,
  WorkspaceVersionRecord,
} from './graph-records';

export interface RevisionGraphData extends RevisionHistoryIndexes {
  readonly workspaceId: WorkspaceId;
  readonly refs: ReadonlyMap<RefName, WorkspaceVersionId | null>;
}

const graphData = new WeakMap<Readonly<object>, RevisionGraphData>();

export function createRevisionGraph(input: CreateGraphInput): RevisionGraph {
  if (!isValidRefName(input.acceptedRef)) {
    throw new TypeError('acceptedRef must be a nonempty NFC string without control characters.');
  }
  return makeRevisionGraph({
    ...emptyRevisionHistoryIndexes(),
    workspaceId: input.workspaceId,
    refs: new Map([[input.acceptedRef, null]]),
  });
}

export function inspectWorkspaceVersion(
  graph: RevisionGraph,
  id: WorkspaceVersionId
): Result<WorkspaceVersionView, UnknownObjectError> {
  const record = requireGraphData(graph).workspaceVersions.get(id);
  return deepFreeze(
    record
      ? { ok: true, value: record.view }
      : { ok: false, error: { kind: 'unknown-workspace-version', id } }
  );
}

export function hasOperationReceipt(graph: RevisionGraph, operationId: OperationId): boolean {
  return requireGraphData(graph).operationReceipts.has(operationId);
}

export function inspectResourceRevision(
  graph: RevisionGraph,
  id: ResourceRevisionId
): Result<ResourceRevisionView, UnknownObjectError> {
  const record = requireGraphData(graph).resourceRevisions.get(id);
  return deepFreeze(
    record
      ? { ok: true, value: record.view }
      : { ok: false, error: { kind: 'unknown-resource-revision', id } }
  );
}

export function inspectWorkspaceResource(
  graph: RevisionGraph,
  versionId: WorkspaceVersionId,
  resourceId: ResourceId
): Result<
  WorkspaceResourceSlotView,
  UnknownObjectError | { readonly kind: 'unknown-resource'; readonly id: ResourceId }
> {
  const version = requireGraphData(graph).workspaceVersions.get(versionId);
  if (!version) {
    return deepFreeze({ ok: false, error: { kind: 'unknown-workspace-version', id: versionId } });
  }
  const slot = inspectWorkspaceResourceInIndexes(version.indexes, resourceId);
  return deepFreeze(
    slot
      ? { ok: true, value: slot }
      : { ok: false, error: { kind: 'unknown-resource', id: resourceId } }
  );
}

export function listWorkspaceResources(
  graph: RevisionGraph,
  versionId: WorkspaceVersionId
): Result<readonly WorkspaceResourceSlotView[], UnknownObjectError> {
  const version = requireGraphData(graph).workspaceVersions.get(versionId);
  return deepFreeze(
    version
      ? { ok: true, value: listWorkspaceResourcesInIndexes(version.indexes) }
      : { ok: false, error: { kind: 'unknown-workspace-version', id: versionId } }
  );
}

export function requireGraphData(graph: RevisionGraph): RevisionGraphData {
  const data = graphData.get(graph);
  if (!data) throw new TypeError('RevisionGraph was not created by this package.');
  return data;
}

export function makeRevisionGraph(data: RevisionGraphData): RevisionGraph {
  const graph = brandValidated<Readonly<object>, 'RevisionGraph'>(
    Object.freeze({ workspaceId: data.workspaceId })
  );
  graphData.set(graph, data);
  return graph;
}

function isValidRefName(value: string): boolean {
  return isValidCanonicalText(value);
}
