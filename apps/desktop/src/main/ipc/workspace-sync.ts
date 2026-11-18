import { ensureWorkspaceSyncAcceptedPaths } from '../workspace-sync-membership';
import type { WorkspaceSyncSelectionUpdate } from '../../shared/workspace-sync-selection';
import { handleGroup, mainIpc, sendRendererIpc } from '../../shared/ipc-contract';
import { organizationRegistryContract } from '../../shared/ipc/organization-registry.contract';
import { scientificRecoveryContract } from '../../shared/ipc/scientific-recovery.contract';
import {
  parseOrganizationRegistryRecordDetailsRequest,
  parseOrganizationRegistryRecordSyncEntityId,
  parseOrganizationRegistrySavedRecordResolutionRequest,
  parseOrganizationRegistryClaimPreparationRequest,
  parseOrganizationRegistryClaimRequest,
  parseOrganizationRegistryConfigurationRequest,
  parseOrganizationRegistryConflictResolutionRequest,
  parseOrganizationRegistryMutationRequest,
} from '../../shared/org-registry-sync';
import type { OrganizationRegistryActionHandlers } from '../org-registry-actions';

import {
  parseRemoteWorkspaceId,
  parseWorkspaceSyncConflictResolution,
  parseWorkspaceSyncEnabled,
  parseWorkspaceSyncEnableOptions,
  parseWorkspaceSyncSelectionUpdate,
  parseWorkspaceSyncHistoryOptions,
  parseWorkspaceSyncCreateOrganizationRequest,
  parseWorkspaceSyncUpdateOrganizationRequest,
  parseWorkspaceSyncInviteId,
  parseWorkspaceSyncInviteRequest,
  parseWorkspaceSyncOrgId,
  parseWorkspaceSyncOrgInviteRequest,
  parseWorkspaceSyncOrgRoleChangeRequest,
  parseWorkspaceSyncSetOrganizationProvisioningGroupRoleRequest,
  parseWorkspaceSyncResolveMergeRequest,
  parseWorkspaceSyncSetAccessRequest,
  parseWorkspaceSyncSubscribeStatusRequest,
  parseWorkspaceSyncSubscriptionId,
  parseWorkspaceUuid,
  workspaceSyncNotImplemented,
  type WorkspaceSyncAccessListingResult,
  type WorkspaceSyncCopyShareLinkResult,
  type WorkspaceSyncDeleteCloudCopyResult,
  type WorkspaceSyncEnableOptions,
  type WorkspaceSyncForceSyncResult,
  type WorkspaceSyncCreateOrganizationRequest,
  type WorkspaceSyncCreateOrganizationResult,
  type WorkspaceSyncDeleteOrganizationResult,
  type WorkspaceSyncUpdateOrganizationRequest,
  type WorkspaceSyncUpdateOrganizationResult,
  type WorkspaceSyncInviteRequest,
  type WorkspaceSyncInviteResult,
  type WorkspaceSyncMergeConflictResult,
  type WorkspaceSyncOrgDirectoryResult,
  type WorkspaceSyncOrganizationAuditResult,
  type WorkspaceSyncOrganizationProvisioningStatusResult,
  type WorkspaceSyncOpenOrganizationProvisioningPortalResult,
  type WorkspaceSyncSetOrganizationProvisioningGroupRoleRequest,
  type WorkspaceSyncSetOrganizationProvisioningGroupRoleResult,
  type WorkspaceSyncOrgInviteRequest,
  type WorkspaceSyncOrgInviteResult,
  type WorkspaceSyncOrgMemberMutationResult,
  type WorkspaceSyncOrgRole,
  type WorkspaceSyncTransferOrganizationOwnershipResult,
  type WorkspaceSyncOpenProjectResult,
  type WorkspaceSyncScientificRecoveryResult,
  type WorkspaceSyncReconcileResult,
  type WorkspaceSyncResolveMergeRequest,
  type WorkspaceSyncOrganizationsResult,
  type WorkspaceSyncProjectSummary,
  type WorkspaceSyncHistoryOptions,
  type WorkspaceSyncVersionHistory,
  type WorkspaceSyncResolveConflictResult,
  type WorkspaceSyncRevokeInviteResult,
  type WorkspaceSyncSetAccessRequest,
  type WorkspaceSyncSetAccessResult,
  type WorkspaceSyncSetEnabledResult,
  type WorkspaceSyncUploadPreviewResult,
} from '../../shared/workspace-sync-ipc';
import {
  createWorkspaceSyncStatusPublisher,
  type WorkspaceSyncStatusPublisher,
} from '../workspace-sync-status';
import { copyWorkspaceSyncShareLink } from '../workspace-sync-share';
import { listWorkspaceSyncProjects, openWorkspaceSyncProject } from '../workspace-sync-projects';
import { listWorkspaceSyncHistory } from '../workspace-sync-history';
import { resolveWorkspaceSyncConflict } from '../workspace-sync-conflicts';
import { getWorkspaceScopedDirtyState } from '../workspace-sync-dirty-state';
import {
  previewWorkspaceSyncUpload,
  WorkspaceSyncSnapshotError,
} from '../workspace-sync-snapshotter';
import { getAuthState } from '../auth/controller';
import { resolveHeadCommitSync } from '../workspace-git';
import { getDb } from './database';
import { managedRootDir } from './workspace-git';
import { recoverScientificCloudDrafts } from '../scientific-cloud-recovery-actions';
import { cloudSyncContract } from '../../shared/ipc/cloud-sync.contract';

export interface WorkspaceSyncActionHandlers extends OrganizationRegistryActionHandlers {
  setEnabled(
    workspaceUuid: string,
    enabled: boolean,
    options?: WorkspaceSyncEnableOptions
  ): Promise<WorkspaceSyncSetEnabledResult>;
  forceSync(workspaceUuid: string): Promise<WorkspaceSyncForceSyncResult>;

  listOrganizations(): Promise<WorkspaceSyncOrganizationsResult>;
  createOrganization(
    request: WorkspaceSyncCreateOrganizationRequest
  ): Promise<WorkspaceSyncCreateOrganizationResult>;
  updateOrganization(
    orgId: string,
    request: WorkspaceSyncUpdateOrganizationRequest
  ): Promise<WorkspaceSyncUpdateOrganizationResult>;
  deleteOrganization(orgId: string): Promise<WorkspaceSyncDeleteOrganizationResult>;
  listOrganizationDirectory(orgId: string): Promise<WorkspaceSyncOrgDirectoryResult>;
  getOrganizationProvisioningStatus(
    orgId: string
  ): Promise<WorkspaceSyncOrganizationProvisioningStatusResult>;
  openOrganizationProvisioningPortal(
    orgId: string
  ): Promise<WorkspaceSyncOpenOrganizationProvisioningPortalResult>;
  setOrganizationProvisioningGroupRole(
    orgId: string,
    request: WorkspaceSyncSetOrganizationProvisioningGroupRoleRequest
  ): Promise<WorkspaceSyncSetOrganizationProvisioningGroupRoleResult>;
  listOrganizationAudit(
    orgId: string,
    type?: string
  ): Promise<WorkspaceSyncOrganizationAuditResult>;
  inviteOrganizationMember(
    orgId: string,
    request: WorkspaceSyncOrgInviteRequest
  ): Promise<WorkspaceSyncOrgInviteResult>;
  resendOrganizationInvite(orgId: string, inviteId: string): Promise<WorkspaceSyncOrgInviteResult>;
  revokeOrganizationInvite(
    orgId: string,
    inviteId: string
  ): Promise<WorkspaceSyncRevokeInviteResult>;
  changeOrganizationMemberRole(
    orgId: string,
    accountId: string,
    roleId: WorkspaceSyncOrgRole
  ): Promise<WorkspaceSyncOrgMemberMutationResult>;
  removeOrganizationMember(
    orgId: string,
    accountId: string
  ): Promise<WorkspaceSyncOrgMemberMutationResult>;
  transferOrganizationOwnership(
    orgId: string,
    accountId: string
  ): Promise<WorkspaceSyncTransferOrganizationOwnershipResult>;
  listAccess(workspaceUuid: string): Promise<WorkspaceSyncAccessListingResult>;
  setAccess(
    workspaceUuid: string,
    request: WorkspaceSyncSetAccessRequest
  ): Promise<WorkspaceSyncSetAccessResult>;
  inviteCollaborator(
    workspaceUuid: string,
    request: WorkspaceSyncInviteRequest
  ): Promise<WorkspaceSyncInviteResult>;
  revokeInvite(workspaceUuid: string, inviteId: string): Promise<WorkspaceSyncRevokeInviteResult>;
  resendInvite(workspaceUuid: string, inviteId: string): Promise<WorkspaceSyncInviteResult>;

  reconcile(workspaceUuid: string): Promise<WorkspaceSyncReconcileResult>;
  getMergeConflict(workspaceUuid: string): Promise<WorkspaceSyncMergeConflictResult>;
  resolveMergeConflict(
    workspaceUuid: string,
    request: WorkspaceSyncResolveMergeRequest
  ): Promise<WorkspaceSyncReconcileResult>;
  copyShareLink(workspaceUuid: string): Promise<WorkspaceSyncCopyShareLinkResult>;
  listSyncedProjects(): Promise<WorkspaceSyncProjectSummary[]>;
  listWorkspaceHistory(
    remoteWorkspaceId: string,
    options?: WorkspaceSyncHistoryOptions
  ): Promise<WorkspaceSyncVersionHistory>;
  openSyncedProject(remoteWorkspaceId: string): Promise<WorkspaceSyncOpenProjectResult>;
  recoverScientificDrafts(
    workspaceUuid: string,
    candidateId: string
  ): Promise<WorkspaceSyncScientificRecoveryResult>;
  resolveConflict(
    workspaceUuid: string,
    resolution: 'keep_local' | 'use_remote'
  ): Promise<WorkspaceSyncResolveConflictResult>;
  deleteCloudCopy(workspaceUuid: string): Promise<WorkspaceSyncDeleteCloudCopyResult>;
  updateSelection(
    workspaceUuid: string,
    request: WorkspaceSyncSelectionUpdate,
    options?: WorkspaceSyncEnableOptions
  ): Promise<WorkspaceSyncUploadPreviewResult>;
  previewUpload(
    workspaceUuid: string,
    options?: WorkspaceSyncEnableOptions
  ): Promise<WorkspaceSyncUploadPreviewResult>;
}

export interface RegisterWorkspaceSyncHandlersDeps {
  statusPublisher?: WorkspaceSyncStatusPublisher;
  actions?: Partial<WorkspaceSyncActionHandlers>;
}

const defaultActions: WorkspaceSyncActionHandlers = {
  setEnabled: async () => workspaceSyncNotImplemented('setEnabled'),
  forceSync: async () => workspaceSyncNotImplemented('forceSync'),
  listOrganizations: async () => workspaceSyncNotImplemented('listOrganizations'),
  createOrganization: async () => workspaceSyncNotImplemented('createOrganization'),
  updateOrganization: async () => workspaceSyncNotImplemented('updateOrganization'),
  deleteOrganization: async () => workspaceSyncNotImplemented('deleteOrganization'),
  listOrganizationDirectory: async () => workspaceSyncNotImplemented('listOrganizationDirectory'),
  getOrganizationProvisioningStatus: async () =>
    workspaceSyncNotImplemented('getOrganizationProvisioningStatus'),
  openOrganizationProvisioningPortal: async () =>
    workspaceSyncNotImplemented('openOrganizationProvisioningPortal'),
  setOrganizationProvisioningGroupRole: async () =>
    workspaceSyncNotImplemented('setOrganizationProvisioningGroupRole'),
  listOrganizationAudit: async () => workspaceSyncNotImplemented('listOrganizationAudit'),
  inviteOrganizationMember: async () => workspaceSyncNotImplemented('inviteOrganizationMember'),
  resendOrganizationInvite: async () => workspaceSyncNotImplemented('resendOrganizationInvite'),
  revokeOrganizationInvite: async () => workspaceSyncNotImplemented('revokeOrganizationInvite'),
  changeOrganizationMemberRole: async () =>
    workspaceSyncNotImplemented('changeOrganizationMemberRole'),
  removeOrganizationMember: async () => workspaceSyncNotImplemented('removeOrganizationMember'),
  transferOrganizationOwnership: async () =>
    workspaceSyncNotImplemented('transferOrganizationOwnership'),
  prepareOrganizationRegistryClaim: async () =>
    workspaceSyncNotImplemented('prepareOrganizationRegistryClaim'),
  claimOrganizationRegistryEntity: async () =>
    workspaceSyncNotImplemented('claimOrganizationRegistryEntity'),
  listCachedOrganizationRegistries: async () =>
    workspaceSyncNotImplemented('listCachedOrganizationRegistries'),
  getOrganizationRegistry: async () => workspaceSyncNotImplemented('getOrganizationRegistry'),
  getOrganizationRegistryRecordSyncStatus: async () =>
    workspaceSyncNotImplemented('getOrganizationRegistryRecordSyncStatus'),
  getOrganizationRegistrySavedRecordReview: async () =>
    workspaceSyncNotImplemented('getOrganizationRegistrySavedRecordReview'),
  resolveOrganizationRegistrySavedRecord: async () =>
    workspaceSyncNotImplemented('resolveOrganizationRegistrySavedRecord'),
  getOrganizationRegistryRecordDetails: async () =>
    workspaceSyncNotImplemented('getOrganizationRegistryRecordDetails'),
  syncOrganizationRegistry: async () => workspaceSyncNotImplemented('syncOrganizationRegistry'),
  mutateOrganizationRegistry: async () => workspaceSyncNotImplemented('mutateOrganizationRegistry'),
  configureOrganizationRegistry: async () =>
    workspaceSyncNotImplemented('configureOrganizationRegistry'),
  getOrganizationRegistrySyncHealth: async () =>
    workspaceSyncNotImplemented('getOrganizationRegistrySyncHealth'),
  getOrganizationDeletionImpact: async () =>
    workspaceSyncNotImplemented('getOrganizationDeletionImpact'),
  resolveOrganizationRegistryConflict: async () =>
    workspaceSyncNotImplemented('resolveOrganizationRegistryConflict'),
  listAccess: async () => workspaceSyncNotImplemented('listAccess'),
  setAccess: async () => workspaceSyncNotImplemented('setAccess'),
  inviteCollaborator: async () => workspaceSyncNotImplemented('inviteCollaborator'),
  revokeInvite: async () => workspaceSyncNotImplemented('revokeInvite'),
  resendInvite: async () => workspaceSyncNotImplemented('resendInvite'),
  reconcile: async () => workspaceSyncNotImplemented('reconcile'),
  getMergeConflict: async () => workspaceSyncNotImplemented('getMergeConflict'),
  resolveMergeConflict: async () => workspaceSyncNotImplemented('resolveMergeConflict'),
  copyShareLink: async (workspaceUuid) => copyWorkspaceSyncShareLink(getDb(), { workspaceUuid }),
  listSyncedProjects: async () => listWorkspaceSyncProjects(),
  listWorkspaceHistory: async (remoteWorkspaceId, options) =>
    listWorkspaceSyncHistory(remoteWorkspaceId, options),
  openSyncedProject: async (remoteWorkspaceId) =>
    openWorkspaceSyncProject(getDb(), {
      remoteWorkspaceId,
      managedRootDir: managedRootDir(),
    }),
  recoverScientificDrafts: (workspaceUuid, candidateId) =>
    recoverScientificCloudDrafts(getDb(), {
      workspaceUuid,
      candidateId,
    }),
  resolveConflict: async (workspaceUuid, resolution) =>
    resolveWorkspaceSyncConflict(getDb(), {
      workspaceUuid,
      resolution,
      managedRootDir: managedRootDir(),
    }),
  deleteCloudCopy: async () => workspaceSyncNotImplemented('deleteCloudCopy'),
  updateSelection: async () => workspaceSyncNotImplemented('updateSelection'),
  previewUpload: async (workspaceUuid, options) => {
    try {
      const auth = getAuthState();
      if (auth.status !== 'signed-in')
        return {
          ok: false as const,
          code: 'INVALID_REQUEST' as const,
          message: 'Sign in to preview cloud sync.',
        };
      const { createDesktopSyncClient } = await import('../desktop-sync-client');
      const { readWorkspaceSyncPreviewPolicy } = await import('../workspace-sync-storage-policy');
      const client = createDesktopSyncClient();
      await hydrateSelectionOwnership(workspaceUuid, client, auth.session.accountId);
      const storagePolicy = await readWorkspaceSyncPreviewPolicy(
        getDb(),
        client,
        workspaceUuid,
        auth.session.accountId,
        options
      );
      const preview = await previewWorkspaceSyncUpload(getDb(), { workspaceUuid, storagePolicy });
      return {
        ok: true as const,
        workspaceUuid: preview.workspaceUuid,
        includedFiles: preview.includedFiles,
        includedFileCount: preview.includedFileCount,
        includedBytes: preview.includedBytes,
        excludedSummary: preview.statusExcludedSummary,
        excludedFiles: preview.excludedFiles,
        selection: preview.selection,
        limits: preview.limits,
      };
    } catch (error) {
      const message =
        error instanceof WorkspaceSyncSnapshotError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Could not preview cloud backup contents.';
      return { ok: false as const, code: 'INVALID_REQUEST' as const, message };
    }
  },
};

let defaultStatusPublisher: WorkspaceSyncStatusPublisher | null = null;

export function registerWorkspaceSyncHandlers(deps: RegisterWorkspaceSyncHandlersDeps = {}): void {
  const statusPublisher = deps.statusPublisher ?? getDefaultStatusPublisher();
  const actions = { ...defaultActions, ...deps.actions };
  const subscriptions = new Map<string, () => void>();

  mainIpc.handle('cloudSync:subscribeStatus', async (event, request: unknown) => {
    const parsed = parseWorkspaceSyncSubscribeStatusRequest(request);
    subscriptions.get(parsed.subscriptionId)?.();
    const unsubscribe = statusPublisher.subscribe(parsed.workspaceUuid, (statusEvent) => {
      sendRendererIpc(event.sender, 'cloudSync:statusChanged', statusEvent);
    });
    subscriptions.set(parsed.subscriptionId, unsubscribe);
    return { ok: true, subscriptionId: parsed.subscriptionId };
  });

  mainIpc.handle('cloudSync:unsubscribeStatus', async (_event, subscriptionId: unknown) => {
    const parsedSubscriptionId = parseWorkspaceSyncSubscriptionId(subscriptionId);
    subscriptions.get(parsedSubscriptionId)?.();
    subscriptions.delete(parsedSubscriptionId);
    return { ok: true };
  });

  mainIpc.handle(
    'cloudSync:listWorkspaceHistory',
    async (_event, remoteWorkspaceId: unknown, options: unknown) =>
      actions.listWorkspaceHistory(
        parseRemoteWorkspaceId(remoteWorkspaceId),
        parseWorkspaceSyncHistoryOptions(options)
      )
  );
  handleGroup(scientificRecoveryContract, {
    recoverScientificDrafts: async (_event, workspaceUuid, candidateId) =>
      actions.recoverScientificDrafts(
        parseWorkspaceUuid(workspaceUuid),
        parseRemoteWorkspaceId(candidateId, 'candidateId')
      ),
  });
  handleGroup(cloudSyncContract, {
    getStatus: async (_event, workspaceUuid: unknown) =>
      statusPublisher.getStatus(parseWorkspaceUuid(workspaceUuid)),
    setEnabled: async (_event, workspaceUuid: unknown, enabled: unknown, options: unknown) =>
      actions.setEnabled(
        parseWorkspaceUuid(workspaceUuid),
        parseWorkspaceSyncEnabled(enabled),
        parseWorkspaceSyncEnableOptions(options)
      ),
    listOrganizations: async () => actions.listOrganizations(),
    createOrganization: async (_event, request: unknown) =>
      actions.createOrganization(parseWorkspaceSyncCreateOrganizationRequest(request)),
    updateOrganization: async (_event, orgId: unknown, request: unknown) =>
      actions.updateOrganization(
        parseWorkspaceSyncOrgId(orgId),
        parseWorkspaceSyncUpdateOrganizationRequest(request)
      ),
    deleteOrganization: async (_event, orgId: unknown) =>
      actions.deleteOrganization(parseWorkspaceSyncOrgId(orgId)),
    listOrganizationDirectory: async (_event, orgId: unknown) =>
      actions.listOrganizationDirectory(parseWorkspaceSyncOrgId(orgId)),
    getOrganizationProvisioningStatus: async (_event, orgId: unknown) =>
      actions.getOrganizationProvisioningStatus(parseWorkspaceSyncOrgId(orgId)),
    openOrganizationProvisioningPortal: async (_event, orgId: unknown) =>
      actions.openOrganizationProvisioningPortal(parseWorkspaceSyncOrgId(orgId)),
    setOrganizationProvisioningGroupRole: async (_event, orgId: unknown, request: unknown) =>
      actions.setOrganizationProvisioningGroupRole(
        parseWorkspaceSyncOrgId(orgId),
        parseWorkspaceSyncSetOrganizationProvisioningGroupRoleRequest(request)
      ),
    listOrganizationAudit: async (_event, orgId: unknown, type: unknown) =>
      actions.listOrganizationAudit(
        parseWorkspaceSyncOrgId(orgId),
        typeof type === 'string' && type.trim() ? type : undefined
      ),
    inviteOrganizationMember: async (_event, orgId: unknown, request: unknown) =>
      actions.inviteOrganizationMember(
        parseWorkspaceSyncOrgId(orgId),
        parseWorkspaceSyncOrgInviteRequest(request)
      ),
    resendOrganizationInvite: async (_event, orgId: unknown, inviteId: unknown) =>
      actions.resendOrganizationInvite(
        parseWorkspaceSyncOrgId(orgId),
        parseWorkspaceSyncInviteId(inviteId)
      ),
    revokeOrganizationInvite: async (_event, orgId: unknown, inviteId: unknown) =>
      actions.revokeOrganizationInvite(
        parseWorkspaceSyncOrgId(orgId),
        parseWorkspaceSyncInviteId(inviteId)
      ),
    removeOrganizationMember: async (_event, orgId: unknown, accountId: unknown) =>
      actions.removeOrganizationMember(
        parseWorkspaceSyncOrgId(orgId),
        parseWorkspaceSyncOrgId(accountId, 'accountId')
      ),
    transferOrganizationOwnership: async (_event, orgId: unknown, accountId: unknown) =>
      actions.transferOrganizationOwnership(
        parseWorkspaceSyncOrgId(orgId),
        parseWorkspaceSyncOrgId(accountId, 'accountId')
      ),
    getOrganizationRegistry: async (_event, orgId: unknown) =>
      actions.getOrganizationRegistry(parseWorkspaceSyncOrgId(orgId)),
    syncOrganizationRegistry: async (_event, orgId: unknown) =>
      actions.syncOrganizationRegistry(parseWorkspaceSyncOrgId(orgId)),
    mutateOrganizationRegistry: async (_event, orgId: unknown, request: unknown) =>
      actions.mutateOrganizationRegistry(
        parseWorkspaceSyncOrgId(orgId),
        parseOrganizationRegistryMutationRequest(request)
      ),
    configureOrganizationRegistry: async (_event, orgId: unknown, request: unknown) =>
      actions.configureOrganizationRegistry(
        parseWorkspaceSyncOrgId(orgId),
        parseOrganizationRegistryConfigurationRequest(request)
      ),
    getOrganizationRegistrySyncHealth: async (_event, orgId: unknown) =>
      actions.getOrganizationRegistrySyncHealth(parseWorkspaceSyncOrgId(orgId)),
    getOrganizationDeletionImpact: async (_event, orgId: unknown) =>
      actions.getOrganizationDeletionImpact(parseWorkspaceSyncOrgId(orgId)),
    resolveOrganizationRegistryConflict: async (_event, orgId: unknown, request: unknown) =>
      actions.resolveOrganizationRegistryConflict(
        parseWorkspaceSyncOrgId(orgId),
        parseOrganizationRegistryConflictResolutionRequest(request)
      ),
    listAccess: async (_event, workspaceUuid: unknown) =>
      actions.listAccess(parseWorkspaceUuid(workspaceUuid)),
    setAccess: async (_event, workspaceUuid: unknown, request: unknown) =>
      actions.setAccess(
        parseWorkspaceUuid(workspaceUuid),
        parseWorkspaceSyncSetAccessRequest(request)
      ),
    inviteCollaborator: async (_event, workspaceUuid: unknown, request: unknown) =>
      actions.inviteCollaborator(
        parseWorkspaceUuid(workspaceUuid),
        parseWorkspaceSyncInviteRequest(request)
      ),
    revokeInvite: async (_event, workspaceUuid: unknown, inviteId: unknown) =>
      actions.revokeInvite(parseWorkspaceUuid(workspaceUuid), parseWorkspaceSyncInviteId(inviteId)),
    resendInvite: async (_event, workspaceUuid: unknown, inviteId: unknown) =>
      actions.resendInvite(parseWorkspaceUuid(workspaceUuid), parseWorkspaceSyncInviteId(inviteId)),
    reconcile: async (_event, workspaceUuid: unknown) =>
      actions.reconcile(parseWorkspaceUuid(workspaceUuid)),
    getMergeConflict: async (_event, workspaceUuid: unknown) =>
      actions.getMergeConflict(parseWorkspaceUuid(workspaceUuid)),
    resolveMergeConflict: async (_event, workspaceUuid: unknown, request: unknown) =>
      actions.resolveMergeConflict(
        parseWorkspaceUuid(workspaceUuid),
        parseWorkspaceSyncResolveMergeRequest(request)
      ),
    forceSync: async (_event, workspaceUuid: unknown) =>
      actions.forceSync(parseWorkspaceUuid(workspaceUuid)),
    copyShareLink: async (_event, workspaceUuid: unknown) =>
      actions.copyShareLink(parseWorkspaceUuid(workspaceUuid)),
    listSyncedProjects: async () => actions.listSyncedProjects(),
    openSyncedProject: async (_event, remoteWorkspaceId: unknown) =>
      actions.openSyncedProject(parseRemoteWorkspaceId(remoteWorkspaceId)),
    resolveConflict: async (_event, workspaceUuid: unknown, resolution: unknown) =>
      actions.resolveConflict(
        parseWorkspaceUuid(workspaceUuid),
        parseWorkspaceSyncConflictResolution(resolution)
      ),
    deleteCloudCopy: async (_event, workspaceUuid: unknown) =>
      actions.deleteCloudCopy(parseWorkspaceUuid(workspaceUuid)),
    updateSelection: async (_event, workspaceUuid: unknown, request: unknown, options?: unknown) =>
      actions.updateSelection(
        parseWorkspaceUuid(workspaceUuid),
        parseWorkspaceSyncSelectionUpdate(request),
        parseWorkspaceSyncEnableOptions(options)
      ),
    previewUpload: async (_event, workspaceUuid: unknown, options?: unknown) =>
      actions.previewUpload(
        parseWorkspaceUuid(workspaceUuid),
        parseWorkspaceSyncEnableOptions(options)
      ),
    changeOrganizationMemberRole: async (
      _event,
      orgId: unknown,
      accountId: unknown,
      request: unknown
    ) =>
      actions.changeOrganizationMemberRole(
        parseWorkspaceSyncOrgId(orgId),
        parseWorkspaceSyncOrgId(accountId, 'accountId'),
        parseWorkspaceSyncOrgRoleChangeRequest(request).roleId
      ),
  });

  handleGroup(organizationRegistryContract, {
    prepareOrganizationRegistryClaim: async (_event, orgId: unknown, request: unknown) =>
      actions.prepareOrganizationRegistryClaim(
        parseWorkspaceSyncOrgId(orgId),
        parseOrganizationRegistryClaimPreparationRequest(request)
      ),
    claimOrganizationRegistryEntity: async (_event, orgId: unknown, request: unknown) =>
      actions.claimOrganizationRegistryEntity(
        parseWorkspaceSyncOrgId(orgId),
        parseOrganizationRegistryClaimRequest(request)
      ),
    getOrganizationRegistryRecordSyncStatus: async (_event, entityId: unknown) =>
      actions.getOrganizationRegistryRecordSyncStatus(
        parseOrganizationRegistryRecordSyncEntityId(entityId)
      ),
    getOrganizationRegistrySavedRecordReview: async (_event, orgId: unknown, entityId: unknown) =>
      actions.getOrganizationRegistrySavedRecordReview(
        parseWorkspaceSyncOrgId(orgId),
        parseOrganizationRegistryRecordSyncEntityId(entityId)
      ),
    resolveOrganizationRegistrySavedRecord: async (_event, orgId: unknown, request: unknown) =>
      actions.resolveOrganizationRegistrySavedRecord(
        parseWorkspaceSyncOrgId(orgId),
        parseOrganizationRegistrySavedRecordResolutionRequest(request)
      ),
    getOrganizationRegistryRecordDetails: async (_event, orgId: unknown, request: unknown) =>
      actions.getOrganizationRegistryRecordDetails(
        parseWorkspaceSyncOrgId(orgId),
        parseOrganizationRegistryRecordDetailsRequest(request)
      ),
    listCachedOrganizationRegistries: async () => actions.listCachedOrganizationRegistries(),
  });
}

export function getDefaultStatusPublisher(): WorkspaceSyncStatusPublisher {
  defaultStatusPublisher ??= createWorkspaceSyncStatusPublisher(getDb(), {
    getActiveAccountId: () => {
      const authState = getAuthState();
      return authState.status === 'signed-in' ? authState.session.accountId : null;
    },
    getDirtyByWorkspace: () => getWorkspaceScopedDirtyState(getDb()),
    getCurrentLocalHeadSha: (workspace) => resolveHeadCommitSync(workspace.path),
  });
  return defaultStatusPublisher;
}

async function hydrateSelectionOwnership(
  workspaceUuid: string,
  client: import('../desktop-sync-client').DesktopSyncClient,
  accountId: string
): Promise<void> {
  const { createWorkspaceSyncProjectsClient } = await import('../workspace-sync-projects');
  await ensureWorkspaceSyncAcceptedPaths(
    getDb(),
    workspaceUuid,
    async (remoteId, versionId, ownerAccountId) => {
      if (ownerAccountId !== accountId)
        throw new Error('This project belongs to a different signed-in account.');
      await client.assertAccount?.(accountId);
      const paths = await createWorkspaceSyncProjectsClient(client).readVersionPaths!(
        remoteId,
        versionId
      );
      await client.assertAccount?.(accountId);
      return paths;
    }
  );
}
