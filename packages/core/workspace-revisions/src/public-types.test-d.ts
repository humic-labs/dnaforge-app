import type {
  ApplyMutationResult,
  CaptureRecoveryResult,
  MemberId,
  ResourceLocator,
  ResourceId,
  ResourcePath,
  ResourceRevisionId,
  ResourceState,
  MergeResult,
  WorkspaceId,
  WorkspaceLocator,
  WorkspacePath,
  WorkspaceVersionId,
} from './index';

declare const rawString: string;
declare const resourceId: ResourceId;
declare const memberId: MemberId;
declare const workspacePath: WorkspacePath;
declare const resourcePath: ResourcePath;
declare const workspaceId: WorkspaceId;
declare const workspaceVersionId: WorkspaceVersionId;
declare const resourceRevisionId: ResourceRevisionId;

// @ts-expect-error Raw strings must cross a validating identity boundary.
const _workspaceFromString: WorkspaceId = rawString;
// @ts-expect-error Stable identity kinds are not interchangeable.
const _workspaceFromResource: WorkspaceId = resourceId;
// @ts-expect-error Member IDs are not resource IDs.
const _resourceFromMember: ResourceId = memberId;
// @ts-expect-error Raw strings must cross a validating path boundary.
const _pathFromString: WorkspacePath = rawString;
// @ts-expect-error Workspace paths and resource-relative paths are distinct.
const _workspaceFromResourcePath: WorkspacePath = resourcePath;
// @ts-expect-error Resource-relative paths and workspace paths are distinct.
const _resourceFromWorkspacePath: ResourcePath = workspacePath;
// @ts-expect-error ResourceState is constructible only through defineResourceState.
const _stateFromRawObject: ResourceState = { layout: 'file' };

const _workspaceLocator: WorkspaceLocator = {
  workspaceId,
  versionId: workspaceVersionId,
};
const _resourceLocator: ResourceLocator = {
  workspaceId,
  resourceId,
  revisionId: resourceRevisionId,
};
const _workspaceWithResourceRevision: WorkspaceLocator = {
  workspaceId,
  // @ts-expect-error A workspace locator cannot substitute a resource revision.
  versionId: resourceRevisionId,
};
// @ts-expect-error Resource lookup always requires stable resource identity.
const _resourceWithoutResourceId: ResourceLocator = { workspaceId };
const _resourceLocatorWithPath: ResourceLocator = {
  workspaceId,
  resourceId,
  // @ts-expect-error Filesystem paths are projection hints, not locator identity.
  path: workspacePath,
};

declare const mutationResult: ApplyMutationResult;
if (mutationResult.kind !== 'changed') {
  // @ts-expect-error Non-accepted mutation results cannot publish.
  mutationResult.publication;
  // @ts-expect-error Non-accepted mutation results cannot advance a ref.
  mutationResult.refAdvance;
}

declare const recoveryResult: CaptureRecoveryResult;
// @ts-expect-error Recovery candidates cannot publish accepted state.
recoveryResult.publication;
// @ts-expect-error Recovery candidates cannot advance an accepted ref.
recoveryResult.refAdvance;

declare const mergeResult: MergeResult;
if (mergeResult.kind !== 'changed') {
  // @ts-expect-error Non-accepted merge results cannot publish.
  mergeResult.publication;
  // @ts-expect-error Non-accepted merge results cannot advance a ref.
  mergeResult.refAdvance;
}
