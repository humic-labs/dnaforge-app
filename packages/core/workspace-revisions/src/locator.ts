import {
  inspectResourceRevision,
  inspectWorkspaceResource,
  inspectWorkspaceVersion,
  requireGraphData,
  type ResourceRevisionView,
} from './graph';
import {
  parseResourceId,
  parseResourceRevisionId,
  parseWorkspaceId,
  parseWorkspaceVersionId,
  type RefName,
  type Result,
  type WorkspaceVersionId,
} from './identity';
import type {
  ResourceLocator,
  RevisionGraph,
  WorkspaceLocator,
  WorkspaceVersionView,
} from './types';
import { deepFreeze } from './immutable';

export type LocatorParseError =
  | { readonly kind: 'invalid-workspace-id' }
  | { readonly kind: 'invalid-resource-id' }
  | { readonly kind: 'invalid-workspace-version-id' }
  | { readonly kind: 'invalid-resource-revision-id' };

export type LocatorResolutionError =
  | { readonly kind: 'workspace-mismatch' }
  | { readonly kind: 'unknown-ref'; readonly refName: RefName }
  | { readonly kind: 'empty-ref'; readonly refName: RefName }
  | { readonly kind: 'unknown-workspace-version'; readonly versionId: WorkspaceVersionId }
  | { readonly kind: 'unknown-resource' }
  | { readonly kind: 'unknown-resource-revision' }
  | { readonly kind: 'resource-revision-mismatch' };

export interface ResolvedResourceLocator {
  readonly revision: ResourceRevisionView;
  readonly workspaceVersionId: WorkspaceVersionId | null;
}

export function parseWorkspaceLocator(input: {
  readonly workspaceId: string;
  readonly versionId?: string;
}): Result<WorkspaceLocator, LocatorParseError> {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (!workspaceId.ok) return { ok: false, error: { kind: 'invalid-workspace-id' } };
  if (input.versionId === undefined) {
    return { ok: true, value: deepFreeze({ workspaceId: workspaceId.value }) };
  }
  const versionId = parseWorkspaceVersionId(input.versionId);
  return versionId.ok
    ? {
        ok: true,
        value: deepFreeze({ workspaceId: workspaceId.value, versionId: versionId.value }),
      }
    : { ok: false, error: { kind: 'invalid-workspace-version-id' } };
}

export function parseResourceLocator(input: {
  readonly workspaceId: string;
  readonly resourceId: string;
  readonly revisionId?: string;
}): Result<ResourceLocator, LocatorParseError> {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (!workspaceId.ok) return { ok: false, error: { kind: 'invalid-workspace-id' } };
  const resourceId = parseResourceId(input.resourceId);
  if (!resourceId.ok) return { ok: false, error: { kind: 'invalid-resource-id' } };
  if (input.revisionId === undefined) {
    return {
      ok: true,
      value: deepFreeze({ workspaceId: workspaceId.value, resourceId: resourceId.value }),
    };
  }
  const revisionId = parseResourceRevisionId(input.revisionId);
  return revisionId.ok
    ? {
        ok: true,
        value: deepFreeze({
          workspaceId: workspaceId.value,
          resourceId: resourceId.value,
          revisionId: revisionId.value,
        }),
      }
    : { ok: false, error: { kind: 'invalid-resource-revision-id' } };
}

export function resolveWorkspaceLocator(input: {
  readonly graph: RevisionGraph;
  readonly locator: WorkspaceLocator;
  readonly acceptedRef: RefName;
}): Result<WorkspaceVersionView, LocatorResolutionError> {
  const data = requireGraphData(input.graph);
  if (data.workspaceId !== input.locator.workspaceId) {
    return { ok: false, error: { kind: 'workspace-mismatch' } };
  }
  let versionId = input.locator.versionId;
  if (versionId === undefined) {
    if (!data.refs.has(input.acceptedRef)) {
      return { ok: false, error: { kind: 'unknown-ref', refName: input.acceptedRef } };
    }
    versionId = data.refs.get(input.acceptedRef) ?? undefined;
    if (versionId === undefined) {
      return { ok: false, error: { kind: 'empty-ref', refName: input.acceptedRef } };
    }
  }
  const version = inspectWorkspaceVersion(input.graph, versionId);
  return version.ok
    ? { ok: true, value: version.value }
    : { ok: false, error: { kind: 'unknown-workspace-version', versionId } };
}

export function resolveResourceLocator(input: {
  readonly graph: RevisionGraph;
  readonly locator: ResourceLocator;
  readonly acceptedRef: RefName;
}): Result<ResolvedResourceLocator, LocatorResolutionError> {
  const data = requireGraphData(input.graph);
  if (data.workspaceId !== input.locator.workspaceId) {
    return { ok: false, error: { kind: 'workspace-mismatch' } };
  }
  if (input.locator.revisionId !== undefined) {
    const revision = inspectResourceRevision(input.graph, input.locator.revisionId);
    if (!revision.ok) return { ok: false, error: { kind: 'unknown-resource-revision' } };
    if (revision.value.resourceId !== input.locator.resourceId) {
      return { ok: false, error: { kind: 'resource-revision-mismatch' } };
    }
    return {
      ok: true,
      value: deepFreeze({ revision: revision.value, workspaceVersionId: null }),
    };
  }
  const workspace = resolveWorkspaceLocator({
    graph: input.graph,
    locator: { workspaceId: input.locator.workspaceId },
    acceptedRef: input.acceptedRef,
  });
  if (!workspace.ok) return workspace;
  const slot = inspectWorkspaceResource(input.graph, workspace.value.id, input.locator.resourceId);
  if (!slot.ok) return { ok: false, error: { kind: 'unknown-resource' } };
  const revision = inspectResourceRevision(input.graph, slot.value.revisionId);
  if (!revision.ok) return { ok: false, error: { kind: 'unknown-resource-revision' } };
  return {
    ok: true,
    value: deepFreeze({ revision: revision.value, workspaceVersionId: workspace.value.id }),
  };
}
