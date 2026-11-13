import type { CanonicalImportError } from './codec-types';
import type { RevisionGraphData } from './graph';
import type { ResourceRevisionId, Result, WorkspaceVersionId } from './identity';
import {
  buildMergedIndexes,
  composeWorkspaceSlots,
  maximalCommonAncestors,
} from './merge-structure';
import {
  listWorkspaceResourcesInIndexes,
  workspaceMaterializedPathRoot,
  workspaceResourceRoot,
} from './workspace-index';

export function validateImportedHistory(
  data: RevisionGraphData
): Result<true, CanonicalImportError> {
  const rootByResource = new Map<import('./identity').ResourceId, ResourceRevisionId>();
  for (const revision of data.resourceRevisions.values()) {
    if (revision.view.parentIds.length !== 0) continue;
    const prior = rootByResource.get(revision.view.resourceId);
    if (prior && prior !== revision.view.id) {
      const revisionIds: readonly [string, string] =
        deterministicCompare(prior, revision.view.id) <= 0
          ? [prior, revision.view.id]
          : [revision.view.id, prior];
      return {
        ok: false,
        error: {
          kind: 'duplicate-resource-root',
          resourceId: revision.view.resourceId,
          revisionIds,
        },
      };
    }
    rootByResource.set(revision.view.resourceId, revision.view.id);
  }

  for (const version of data.workspaceVersions.values()) {
    const slots = listWorkspaceResourcesInIndexes(version.indexes);
    if (version.view.parentIds.length === 0) {
      if (slots.some((slot) => rootByResource.get(slot.resourceId) !== slot.revisionId)) {
        return invalidWorkspaceTransition(version.view.id);
      }
      continue;
    }
    if (version.view.parentIds.length === 1) {
      const parentId = version.view.parentIds[0];
      const parent = parentId ? data.workspaceVersions.get(parentId) : undefined;
      if (!parent) return invalidWorkspaceTransition(version.view.id);
      const parentSlots = new Map(
        listWorkspaceResourcesInIndexes(parent.indexes).map((slot) => [slot.resourceId, slot])
      );
      const valid = slots.every((slot) => {
        const prior = parentSlots.get(slot.resourceId);
        return prior
          ? prior.revisionId === slot.revisionId ||
              isResourceAncestor(data, prior.revisionId, slot.revisionId)
          : rootByResource.get(slot.resourceId) === slot.revisionId;
      });
      if (!valid) return invalidWorkspaceTransition(version.view.id);
      continue;
    }

    const leftId = version.view.parentIds[0];
    const rightId = version.view.parentIds[1];
    if (!leftId || !rightId) return invalidWorkspaceMerge(version.view.id);
    const bases = maximalCommonAncestors(data, leftId, rightId);
    const baseId = bases.length === 1 ? bases[0] : undefined;
    const base = baseId ? data.workspaceVersions.get(baseId) : undefined;
    const left = data.workspaceVersions.get(leftId);
    const right = data.workspaceVersions.get(rightId);
    if (!base || !left || !right) return invalidWorkspaceMerge(version.view.id);
    const composed = composeWorkspaceSlots(base, left, right);
    if (composed.conflicts.length > 0) return invalidWorkspaceMerge(version.view.id);
    const rebuilt = buildMergedIndexes(composed.slots, data);
    if (
      !rebuilt.ok ||
      workspaceResourceRoot(rebuilt.value.indexes) !== version.view.resourceRoot ||
      workspaceMaterializedPathRoot(rebuilt.value.indexes) !== version.view.materializedPathRoot ||
      rebuilt.value.indexes.resources.size !== version.view.resourceCount ||
      rebuilt.value.indexes.materializedPaths.size !== version.view.materializedPathCount
    ) {
      return invalidWorkspaceMerge(version.view.id);
    }
  }
  return { ok: true, value: true };
}

function isResourceAncestor(
  data: RevisionGraphData,
  ancestorId: ResourceRevisionId,
  descendantId: ResourceRevisionId
): boolean {
  const pending = [descendantId];
  const seen = new Set<ResourceRevisionId>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || seen.has(current)) continue;
    if (current === ancestorId) return true;
    seen.add(current);
    const revision = data.resourceRevisions.get(current);
    if (revision) pending.push(...revision.view.parentIds);
  }
  return false;
}

function invalidWorkspaceTransition(
  versionId: WorkspaceVersionId
): Result<never, CanonicalImportError> {
  return { ok: false, error: { kind: 'invalid-workspace-transition', versionId } };
}

function invalidWorkspaceMerge(versionId: WorkspaceVersionId): Result<never, CanonicalImportError> {
  return { ok: false, error: { kind: 'invalid-workspace-merge', versionId } };
}

function deterministicCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
