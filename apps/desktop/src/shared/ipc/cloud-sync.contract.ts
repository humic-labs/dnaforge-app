import type { WorkspaceSyncSelectionUpdate } from '../workspace-sync-selection';
import type {
  WorkspaceSyncAccessListingResult,
  WorkspaceSyncConflictResolution,
  WorkspaceSyncCopyShareLinkResult,
  WorkspaceSyncCreateOrganizationRequest,
  WorkspaceSyncCreateOrganizationResult,
  WorkspaceSyncDeleteCloudCopyResult,
  WorkspaceSyncDeleteOrganizationResult,
  WorkspaceSyncEnableOptions,
  WorkspaceSyncForceSyncResult,
  WorkspaceSyncInviteRequest,
  WorkspaceSyncInviteResult,
  WorkspaceSyncMergeConflictResult,
  WorkspaceSyncOpenOrganizationProvisioningPortalResult,
  WorkspaceSyncOpenProjectResult,
  WorkspaceSyncOrgDirectoryResult,
  WorkspaceSyncOrgInviteRequest,
  WorkspaceSyncOrgInviteResult,
  WorkspaceSyncOrgMemberMutationResult,
  WorkspaceSyncOrganizationAuditResult,
  WorkspaceSyncOrganizationProvisioningStatusResult,
  WorkspaceSyncOrganizationsResult,
  WorkspaceSyncProjectSummary,
  WorkspaceSyncReconcileResult,
  WorkspaceSyncResolveConflictResult,
  WorkspaceSyncResolveMergeRequest,
  WorkspaceSyncRevokeInviteResult,
  WorkspaceSyncSetAccessRequest,
  WorkspaceSyncSetAccessResult,
  WorkspaceSyncSetEnabledResult,
  WorkspaceSyncSetOrganizationProvisioningGroupRoleRequest,
  WorkspaceSyncSetOrganizationProvisioningGroupRoleResult,
  WorkspaceSyncTransferOrganizationOwnershipResult,
  WorkspaceSyncUpdateOrganizationRequest,
  WorkspaceSyncUpdateOrganizationResult,
  WorkspaceSyncUploadPreviewResult,
  WorkspaceSyncOrgRole,
} from '../workspace-sync-ipc';
import type {
  OrganizationDeletionImpactResult,
  OrganizationRegistryConfigurationRequest,
  OrganizationRegistryConfigurationResult,
  OrganizationRegistryConflictResolutionRequest,
  OrganizationRegistryConflictResolutionResult,
  OrganizationRegistryMutationRequest,
  OrganizationRegistryMutationResult,
  OrganizationRegistryReadResult,
  OrganizationRegistrySyncHealthResult,
  OrganizationRegistrySyncResult,
} from '../org-registry-sync';
import type { WorkspaceSyncStatus } from '../cloud-sync-status';
import { defineGroup, invoke } from './contract';

export const cloudSyncContract = defineGroup('cloudSync', {
  getStatus: invoke<[workspaceUuid: string], WorkspaceSyncStatus>(),
  setEnabled: invoke<
    [workspaceUuid: string, enabled: boolean, options?: WorkspaceSyncEnableOptions],
    WorkspaceSyncSetEnabledResult
  >(),
  listOrganizations: invoke<[], WorkspaceSyncOrganizationsResult>(),
  createOrganization: invoke<
    [request: WorkspaceSyncCreateOrganizationRequest],
    WorkspaceSyncCreateOrganizationResult
  >(),
  updateOrganization: invoke<
    [orgId: string, request: WorkspaceSyncUpdateOrganizationRequest],
    WorkspaceSyncUpdateOrganizationResult
  >(),
  deleteOrganization: invoke<[orgId: string], WorkspaceSyncDeleteOrganizationResult>(),
  listOrganizationDirectory: invoke<[orgId: string], WorkspaceSyncOrgDirectoryResult>(),
  getOrganizationProvisioningStatus: invoke<
    [orgId: string],
    WorkspaceSyncOrganizationProvisioningStatusResult
  >(),
  openOrganizationProvisioningPortal: invoke<
    [orgId: string],
    WorkspaceSyncOpenOrganizationProvisioningPortalResult
  >(),
  setOrganizationProvisioningGroupRole: invoke<
    [orgId: string, request: WorkspaceSyncSetOrganizationProvisioningGroupRoleRequest],
    WorkspaceSyncSetOrganizationProvisioningGroupRoleResult
  >(),
  listOrganizationAudit: invoke<
    [orgId: string, type?: string],
    WorkspaceSyncOrganizationAuditResult
  >(),
  inviteOrganizationMember: invoke<
    [orgId: string, request: WorkspaceSyncOrgInviteRequest],
    WorkspaceSyncOrgInviteResult
  >(),
  resendOrganizationInvite: invoke<
    [orgId: string, inviteId: string],
    WorkspaceSyncOrgInviteResult
  >(),
  revokeOrganizationInvite: invoke<
    [orgId: string, inviteId: string],
    WorkspaceSyncRevokeInviteResult
  >(),
  removeOrganizationMember: invoke<
    [orgId: string, accountId: string],
    WorkspaceSyncOrgMemberMutationResult
  >(),
  transferOrganizationOwnership: invoke<
    [orgId: string, accountId: string],
    WorkspaceSyncTransferOrganizationOwnershipResult
  >(),
  getOrganizationRegistry: invoke<[orgId: string], OrganizationRegistryReadResult>(),
  syncOrganizationRegistry: invoke<[orgId: string], OrganizationRegistrySyncResult>(),
  mutateOrganizationRegistry: invoke<
    [orgId: string, request: OrganizationRegistryMutationRequest],
    OrganizationRegistryMutationResult
  >(),
  configureOrganizationRegistry: invoke<
    [orgId: string, request: OrganizationRegistryConfigurationRequest],
    OrganizationRegistryConfigurationResult
  >(),
  getOrganizationRegistrySyncHealth: invoke<
    [orgId: string],
    OrganizationRegistrySyncHealthResult
  >(),
  getOrganizationDeletionImpact: invoke<[orgId: string], OrganizationDeletionImpactResult>(),
  resolveOrganizationRegistryConflict: invoke<
    [orgId: string, request: OrganizationRegistryConflictResolutionRequest],
    OrganizationRegistryConflictResolutionResult
  >(),
  listAccess: invoke<[workspaceUuid: string], WorkspaceSyncAccessListingResult>(),
  setAccess: invoke<
    [workspaceUuid: string, request: WorkspaceSyncSetAccessRequest],
    WorkspaceSyncSetAccessResult
  >(),
  inviteCollaborator: invoke<
    [workspaceUuid: string, request: WorkspaceSyncInviteRequest],
    WorkspaceSyncInviteResult
  >(),
  revokeInvite: invoke<
    [workspaceUuid: string, inviteId: string],
    WorkspaceSyncRevokeInviteResult
  >(),
  resendInvite: invoke<[workspaceUuid: string, inviteId: string], WorkspaceSyncInviteResult>(),
  reconcile: invoke<[workspaceUuid: string], WorkspaceSyncReconcileResult>(),
  getMergeConflict: invoke<[workspaceUuid: string], WorkspaceSyncMergeConflictResult>(),
  resolveMergeConflict: invoke<
    [workspaceUuid: string, request: WorkspaceSyncResolveMergeRequest],
    WorkspaceSyncReconcileResult
  >(),
  forceSync: invoke<[workspaceUuid: string], WorkspaceSyncForceSyncResult>(),
  copyShareLink: invoke<[workspaceUuid: string], WorkspaceSyncCopyShareLinkResult>(),
  listSyncedProjects: invoke<[], WorkspaceSyncProjectSummary[]>(),
  openSyncedProject: invoke<[remoteWorkspaceId: string], WorkspaceSyncOpenProjectResult>(),
  resolveConflict: invoke<
    [workspaceUuid: string, resolution: WorkspaceSyncConflictResolution],
    WorkspaceSyncResolveConflictResult
  >(),
  deleteCloudCopy: invoke<[workspaceUuid: string], WorkspaceSyncDeleteCloudCopyResult>(),
  updateSelection: invoke<
    [
      workspaceUuid: string,
      request: WorkspaceSyncSelectionUpdate,
      options?: WorkspaceSyncEnableOptions,
    ],
    WorkspaceSyncUploadPreviewResult
  >(),
  previewUpload: invoke<
    [workspaceUuid: string, options?: WorkspaceSyncEnableOptions],
    WorkspaceSyncUploadPreviewResult
  >(),
  changeOrganizationMemberRole: invoke<
    [orgId: string, accountId: string, request: { roleId: WorkspaceSyncOrgRole }],
    WorkspaceSyncOrgMemberMutationResult
  >(),
});
