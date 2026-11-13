import type { RevisionGraphData, WorkspaceVersionRecord } from './graph';
import type { ResourceId, WorkspaceVersionId } from './identity';
import type { Conflict, ImmutableRecordWrite, WorkspaceResourceSlotView } from './types';
import type { ResourceStateRecord } from './resource-state';
import {
  emptyWorkspaceIndexes,
  immutableWorkspaceIndexWrites,
  listWorkspaceResourcesInIndexes,
  updateWorkspaceResourceIndexes,
  type WorkspaceIndexes,
  type WorkspaceIndexError,
} from './workspace-index';

export interface ComposedSlots {
  readonly slots: readonly WorkspaceResourceSlotView[];
  readonly conflicts: readonly Conflict[];
}

type DimensionResult<Value> =
  | { readonly kind: 'resolved'; readonly value: Value }
  | { readonly kind: 'conflict' };

export function maximalCommonAncestors(
  data: RevisionGraphData,
  leftId: WorkspaceVersionId,
  rightId: WorkspaceVersionId
): readonly WorkspaceVersionId[] {
  const leftAncestors = collectWorkspaceAncestors(data, leftId);
  const rightAncestors = collectWorkspaceAncestors(data, rightId);
  const common = new Set([...leftAncestors].filter((candidate) => rightAncestors.has(candidate)));
  const nonMaximal = new Set<WorkspaceVersionId>();
  for (const versionId of common) {
    const version = data.workspaceVersions.get(versionId);
    if (!version) continue;
    for (const parentId of version.view.parentIds) {
      if (common.has(parentId)) nonMaximal.add(parentId);
    }
  }
  return Object.freeze(
    [...common].filter((candidate) => !nonMaximal.has(candidate)).sort(deterministicCompare)
  );
}

function collectWorkspaceAncestors(
  data: RevisionGraphData,
  startId: WorkspaceVersionId
): ReadonlySet<WorkspaceVersionId> {
  const ancestors = new Set<WorkspaceVersionId>();
  const pending = [startId];
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (!candidate || ancestors.has(candidate)) continue;
    ancestors.add(candidate);
    const version = data.workspaceVersions.get(candidate);
    if (version) pending.push(...version.view.parentIds);
  }
  return ancestors;
}

export function composeWorkspaceSlots(
  base: WorkspaceVersionRecord,
  left: WorkspaceVersionRecord,
  right: WorkspaceVersionRecord
): ComposedSlots {
  const baseByResource = slotsByResource(listWorkspaceResourcesInIndexes(base.indexes));
  const leftByResource = slotsByResource(listWorkspaceResourcesInIndexes(left.indexes));
  const rightByResource = slotsByResource(listWorkspaceResourcesInIndexes(right.indexes));
  const resourceIds = [
    ...new Set([...baseByResource.keys(), ...leftByResource.keys(), ...rightByResource.keys()]),
  ].sort(deterministicCompare);
  const slots: WorkspaceResourceSlotView[] = [];
  const conflicts: Conflict[] = [];

  for (const resourceId of resourceIds) {
    const resolution = composeResource(
      resourceId,
      baseByResource.get(resourceId) ?? null,
      leftByResource.get(resourceId) ?? null,
      rightByResource.get(resourceId) ?? null
    );
    conflicts.push(...resolution.conflicts);
    if (resolution.slot) slots.push(resolution.slot);
  }
  conflicts.sort(compareConflicts);
  return { slots: Object.freeze(slots), conflicts: Object.freeze(conflicts) };
}

function composeResource(
  resourceId: ResourceId,
  base: WorkspaceResourceSlotView | null,
  left: WorkspaceResourceSlotView | null,
  right: WorkspaceResourceSlotView | null
): { readonly slot: WorkspaceResourceSlotView | null; readonly conflicts: readonly Conflict[] } {
  if (sameSlot(left, right)) return { slot: left, conflicts: [] };
  if (sameSlot(left, base)) return { slot: right, conflicts: [] };
  if (sameSlot(right, base)) return { slot: left, conflicts: [] };

  if (base === null) return resourceConflict(resourceId, 'identity-conflict');
  if (left === null || right === null) {
    return resourceConflict(resourceId, 'membership-remove-edit');
  }
  if (left.tombstone !== right.tombstone) {
    const live = left.tombstone ? right : left;
    if (live.revisionId !== base.revisionId) return resourceConflict(resourceId, 'delete-edit');
    if (live.path !== base.path) return resourceConflict(resourceId, 'move-delete');
    return resourceConflict(resourceId, 'identity-conflict');
  }
  if (left.tombstone && right.tombstone) return resourceConflict(resourceId, 'edit-edit');

  const revision = resolveDimension(base.revisionId, left.revisionId, right.revisionId);
  const path = resolveDimension(base.path, left.path, right.path);
  const conflicts: Conflict[] = [];
  if (revision.kind === 'conflict') {
    conflicts.push({ kind: 'resource-conflict', resourceId, reason: 'edit-edit' });
  }
  if (path.kind === 'conflict') {
    conflicts.push({ kind: 'resource-conflict', resourceId, reason: 'rename-rename' });
  }
  if (conflicts.length > 0) {
    conflicts.sort(compareConflicts);
    return { slot: null, conflicts };
  }
  if (revision.kind !== 'resolved' || path.kind !== 'resolved' || path.value === null) {
    throw new Error('Resolved live resource must have a revision and a path.');
  }
  return {
    slot: Object.freeze({
      resourceId,
      revisionId: revision.value,
      path: path.value,
      lastPath: path.value,
      tombstone: false,
    }),
    conflicts: [],
  };
}

export function resolveDimension<Value>(
  base: Value,
  left: Value,
  right: Value
): DimensionResult<Value> {
  if (left === right) return { kind: 'resolved', value: left };
  if (left === base) return { kind: 'resolved', value: right };
  if (right === base) return { kind: 'resolved', value: left };
  return { kind: 'conflict' };
}

function resourceConflict(
  resourceId: ResourceId,
  reason: Extract<Conflict, { readonly kind: 'resource-conflict' }>['reason']
): { readonly slot: null; readonly conflicts: readonly Conflict[] } {
  return {
    slot: null,
    conflicts: [{ kind: 'resource-conflict', resourceId, reason }],
  };
}

function sameSlot(
  left: WorkspaceResourceSlotView | null,
  right: WorkspaceResourceSlotView | null
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.resourceId === right.resourceId &&
      left.revisionId === right.revisionId &&
      left.path === right.path &&
      left.lastPath === right.lastPath &&
      left.tombstone === right.tombstone)
  );
}

function slotsByResource(
  slots: readonly WorkspaceResourceSlotView[]
): ReadonlyMap<ResourceId, WorkspaceResourceSlotView> {
  return new Map(slots.map((slot) => [slot.resourceId, slot]));
}

export function buildMergedIndexes(
  slots: readonly WorkspaceResourceSlotView[],
  data: RevisionGraphData
):
  | {
      readonly ok: true;
      readonly value: {
        readonly indexes: WorkspaceIndexes;
        readonly writes: readonly ImmutableRecordWrite[];
      };
    }
  | { readonly ok: false; readonly error: WorkspaceIndexError } {
  let indexes = emptyWorkspaceIndexes();
  const writes: ImmutableRecordWrite[] = [];
  for (const slot of [...slots].sort((left, right) =>
    deterministicCompare(left.resourceId, right.resourceId)
  )) {
    const updated = updateWorkspaceResourceIndexes({
      indexes,
      resourceId: slot.resourceId,
      nextSlot: slot,
      previousState: null,
      nextState: stateForSlot(data, slot),
    });
    if (!updated.ok) return updated;
    indexes = updated.value.indexes;
    writes.push(...immutableWorkspaceIndexWrites(updated.value.writes));
  }
  return { ok: true, value: Object.freeze({ indexes, writes: Object.freeze(writes) }) };
}

function stateForSlot(
  data: RevisionGraphData,
  slot: WorkspaceResourceSlotView
): ResourceStateRecord | null {
  if (slot.tombstone || slot.path === null) return null;
  const revision = data.resourceRevisions.get(slot.revisionId);
  if (!revision || revision.view.stateHash === null) {
    throw new Error('Merged live slot references an invalid resource revision.');
  }
  const state = data.resourceStates.get(revision.view.stateHash);
  if (!state) throw new Error('Merged resource revision references a missing resource state.');
  return state;
}

export function compareConflicts(left: Conflict, right: Conflict): number {
  return deterministicCompare(conflictKey(left), conflictKey(right));
}

function conflictKey(conflict: Conflict): string {
  switch (conflict.kind) {
    case 'resource-conflict':
      return `0:${conflict.resourceId}:${conflict.reason}`;
    case 'path-conflict':
      return `1:${conflict.paths.join('\u0000')}`;
    case 'ref-head-mismatch':
      return `2:${conflict.expected ?? ''}:${conflict.actual ?? ''}`;
  }
}

function deterministicCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
