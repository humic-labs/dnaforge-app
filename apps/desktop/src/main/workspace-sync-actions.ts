import { cancelWorkspaceSyncUploadsBeforeStart } from './workspace-sync-queue';
import { userMessage, type UserMessage } from '@waypoint/user-messages';
import type Database from 'better-sqlite3';
import { publishWorkspaceSyncEnablementTelemetry } from './workspace-sync-enablement-telemetry';
import { parseDesktopSyncClaimResponse } from '@waypoint/share-bundle/protocol';

import {
  workspaceSyncNotImplemented,
  type WorkspaceSyncActionError,
  type WorkspaceSyncEnableOptions,
  type WorkspaceSyncForceSyncResult,
  type WorkspaceSyncMergeConflictView,
  type WorkspaceSyncReconcileResult,
  type WorkspaceSyncResolveMergeRequest,
  type WorkspaceSyncSetEnabledResult,
} from '../shared/workspace-sync-ipc';
import {
  changeWorkspaceSyncOrganizationMemberRole,
  createWorkspaceSyncOrganization,
  deleteWorkspaceSyncOrganization,
  inviteWorkspaceSyncCollaborator,
  inviteWorkspaceSyncOrganizationMember,
  resendWorkspaceSyncOrganizationInvite,
  getWorkspaceSyncOrganizationProvisioningStatus,
  listWorkspaceSyncAccess,
  listWorkspaceSyncOrganizationAudit,
  listWorkspaceSyncOrganizationDirectory,
  listWorkspaceSyncOrganizations,
  removeWorkspaceSyncOrganizationMember,
  openWorkspaceSyncOrganizationProvisioningPortal,
  setWorkspaceSyncOrganizationProvisioningGroupRole,
  resendWorkspaceSyncInvite,
  revokeWorkspaceSyncInvite,
  revokeWorkspaceSyncOrganizationInvite,
  setWorkspaceSyncAccess,
  transferWorkspaceSyncOrganizationOwnership,
  updateWorkspaceSyncOrganization,
  type WorkspaceSyncAccessActionDeps,
} from './workspace-sync-access';
import { getActiveStoredSession, type StoredSession } from './auth/session-store';
import { createDesktopSyncClient, type DesktopSyncClient } from './desktop-sync-client';
import type { WorkspaceSyncActionHandlers } from './ipc/workspace-sync';
import {
  ensureWorkspaceSyncBinding,
  type WorkspaceSyncClaimClient,
  type WorkspaceSyncClaimRequest,
  type WorkspaceSyncClaimResponse,
} from './workspace-sync-binding';
import {
  readOrCreateWorkspaceSyncDeviceId,
  type WorkspaceSyncRuntime,
} from './workspace-sync-runtime';
import type { WorkspaceSyncStatusPublisher } from './workspace-sync-status';
import { copyWorkspaceSyncShareLink } from './workspace-sync-share';
import { deleteWorkspaceSyncCloudCopy } from './workspace-sync-delete';
import { listWorkspaceSyncProjects, openWorkspaceSyncProject } from './workspace-sync-projects';
import {
  resolveWorkspaceSyncConflict,
  type ResolveWorkspaceSyncConflictInput,
} from './workspace-sync-conflicts';
import { managedRootDir } from './ipc/workspace-git';
import {
  createOrganizationRegistryActionHandlers,
  type OrganizationRegistryActionDeps,
} from './org-registry-actions';

export interface WorkspaceSyncActionRuntime {
  ensureWatchingWorkspace(workspaceUuid: string): Promise<unknown>;
  stopWatchingWorkspace(workspaceUuid: string): void;
  pauseWorkspace(workspaceUuid: string): void;
  resumeWorkspace(workspaceUuid: string): void;
  flushWorkspace(
    workspaceUuid: string,
    options?: { force?: boolean }
  ): Promise<{ status: string; errorCode?: string }>;
  waitForIdle(workspaceUuid?: string): Promise<void>;
  resumeCommittedRendererRefresh?(workspaceUuid: string): Promise<void>;
}

export interface WorkspaceSyncActionDeps {
  onRegistryChanged?: OrganizationRegistryActionDeps['onRegistryChanged'];
  runtime: WorkspaceSyncActionRuntime;
  statusPublisher?: Pick<WorkspaceSyncStatusPublisher, 'invalidate'>;
  getActiveSession?: () => Promise<StoredSession | null>;
  claimClient?: WorkspaceSyncClaimClient;
  createClaimClient?: (deviceId: string) => WorkspaceSyncClaimClient;
  nowMs?: () => number;
  scientificReplica?: ResolveWorkspaceSyncConflictInput['scientificReplica'];

  accessClient?: WorkspaceSyncAccessActionDeps['client'];

  openExternal?: (url: string) => Promise<void>;

  reconcile?: {
    run(workspaceUuid: string): Promise<WorkspaceSyncReconcileResult>;
    read(workspaceUuid: string): WorkspaceSyncMergeConflictView | null;
    resolve(
      workspaceUuid: string,
      request: WorkspaceSyncResolveMergeRequest
    ): Promise<WorkspaceSyncReconcileResult>;
  };
}

interface WorkspaceSyncActionBindingRow {
  workspace_id: number;
  workspace_uuid: string;
  owner_account_id: string;
  owner_org_id: string | null;
  remote_workspace_id: string | null;
  enabled: number;
}

const UPLOAD_NOT_COMPLETE = new Set(['retry_wait', 'failed']);
const WATCHER_START_WARNING = userMessage('sync.backupNotStarted');

export function createWorkspaceSyncActionHandlers(
  db: Database.Database,
  deps: WorkspaceSyncActionDeps
): Partial<WorkspaceSyncActionHandlers> {
  const accessDeps: WorkspaceSyncAccessActionDeps = {
    client: deps.accessClient,
    getActiveSession: deps.getActiveSession,
    nowMs: deps.nowMs,
    invalidateStatus: (workspaceUuid, reason) =>
      deps.statusPublisher?.invalidate(workspaceUuid, reason),
    openExternal: deps.openExternal,
  };
  const organizationRegistryActions = createOrganizationRegistryActionHandlers(db, {
    onRegistryChanged: deps.onRegistryChanged,
    getActiveSession: deps.getActiveSession,
    nowMs: deps.nowMs,
  });
  return {
    ...organizationRegistryActions,
    setEnabled: (workspaceUuid, enabled, options) =>
      setWorkspaceSyncEnabled(db, workspaceUuid, enabled, deps, options),
    forceSync: (workspaceUuid) => forceWorkspaceSync(db, workspaceUuid, deps),
    listOrganizations: () => listWorkspaceSyncOrganizations(accessDeps),
    createOrganization: (request) => createWorkspaceSyncOrganization(request, accessDeps),
    updateOrganization: (orgId, request) =>
      updateWorkspaceSyncOrganization(orgId, request, accessDeps),
    deleteOrganization: (orgId) => deleteWorkspaceSyncOrganization(orgId, accessDeps),
    listOrganizationDirectory: (orgId) => listWorkspaceSyncOrganizationDirectory(orgId, accessDeps),
    getOrganizationProvisioningStatus: (orgId) =>
      getWorkspaceSyncOrganizationProvisioningStatus(orgId, accessDeps),
    openOrganizationProvisioningPortal: (orgId) =>
      openWorkspaceSyncOrganizationProvisioningPortal(orgId, accessDeps),
    setOrganizationProvisioningGroupRole: (orgId, request) =>
      setWorkspaceSyncOrganizationProvisioningGroupRole(orgId, request, accessDeps),
    listOrganizationAudit: (orgId, type) =>
      listWorkspaceSyncOrganizationAudit(orgId, type, accessDeps),
    inviteOrganizationMember: (orgId, request) =>
      inviteWorkspaceSyncOrganizationMember(orgId, request, accessDeps),
    resendOrganizationInvite: (orgId, inviteId) =>
      resendWorkspaceSyncOrganizationInvite(orgId, inviteId, accessDeps),
    revokeOrganizationInvite: (orgId, inviteId) =>
      revokeWorkspaceSyncOrganizationInvite(orgId, inviteId, accessDeps),
    changeOrganizationMemberRole: (orgId, accountId, roleId) =>
      changeWorkspaceSyncOrganizationMemberRole(orgId, accountId, roleId, accessDeps),
    removeOrganizationMember: (orgId, accountId) =>
      removeWorkspaceSyncOrganizationMember(orgId, accountId, accessDeps),
    transferOrganizationOwnership: (orgId, accountId) =>
      transferWorkspaceSyncOrganizationOwnership(orgId, accountId, accessDeps),
    listAccess: (workspaceUuid) => listWorkspaceSyncAccess(db, workspaceUuid, accessDeps),
    setAccess: (workspaceUuid, request) =>
      setWorkspaceSyncAccess(db, workspaceUuid, request, accessDeps),
    inviteCollaborator: (workspaceUuid, request) =>
      inviteWorkspaceSyncCollaborator(db, workspaceUuid, request, accessDeps),
    revokeInvite: (workspaceUuid, inviteId) =>
      revokeWorkspaceSyncInvite(db, workspaceUuid, inviteId, accessDeps),
    resendInvite: (workspaceUuid, inviteId) =>
      resendWorkspaceSyncInvite(db, workspaceUuid, inviteId, accessDeps),
    reconcile: (workspaceUuid) =>
      deps.reconcile
        ? deps.reconcile.run(workspaceUuid)
        : Promise.resolve(workspaceSyncNotImplemented('reconcile')),
    getMergeConflict: async (workspaceUuid) =>
      deps.reconcile
        ? { ok: true, conflict: deps.reconcile.read(workspaceUuid) }
        : workspaceSyncNotImplemented('getMergeConflict'),
    resolveMergeConflict: (workspaceUuid, request) =>
      deps.reconcile
        ? deps.reconcile.resolve(workspaceUuid, request)
        : Promise.resolve(workspaceSyncNotImplemented('resolveMergeConflict')),

    copyShareLink: (workspaceUuid) =>
      copyWorkspaceSyncShareLink(db, {
        workspaceUuid,
        syncBeforeShare: async (context) => {
          const result = await forceWorkspaceSync(db, context.workspaceUuid, deps);
          if (!result.ok) {
            throw new Error(result.message);
          }
        },
      }),
    deleteCloudCopy: async (workspaceUuid) => {
      const result = await deleteWorkspaceSyncCloudCopy(db, {
        workspaceUuid,
        runtime: deps.runtime,
      });
      if (result.ok) deps.statusPublisher?.invalidate(workspaceUuid, 'binding_changed');
      return result;
    },
    listSyncedProjects: () => listWorkspaceSyncProjects(),
    openSyncedProject: async (remoteWorkspaceId) => {
      const result = await openWorkspaceSyncProject(db, {
        remoteWorkspaceId,
        managedRootDir: managedRootDir(),
        withReplacementSourceQuiesced: (workspaceUuid, operation) =>
          withWorkspaceSyncReplacementSourceQuiesced(
            deps.runtime,
            workspaceUuid,
            operation,
            workspaceSyncActionFailed
          ),
      });
      if (result.ok && result.workspaceUuid) {
        const warning = await ensureWorkspaceWatcherAfterAction(deps.runtime, result.workspaceUuid);
        deps.statusPublisher?.invalidate(result.workspaceUuid, 'binding_changed');
        return warning ? { ...result, warnings: [...(result.warnings ?? []), warning] } : result;
      }
      return result;
    },
    resolveConflict: async (workspaceUuid, resolution) => {
      const result = await resolveWorkspaceSyncConflict(db, {
        workspaceUuid,
        resolution,
        managedRootDir: managedRootDir(),
        scientificReplica: deps.scientificReplica,
        resumeScientificReplica: (sourceWorkspaceUuid) => {
          if (!deps.runtime.resumeCommittedRendererRefresh)
            throw new Error('Scientific replica refresh requires its native runtime owner.');
          return deps.runtime.resumeCommittedRendererRefresh(sourceWorkspaceUuid);
        },
        withReplacementSourceQuiesced: (sourceWorkspaceUuid, operation) =>
          withWorkspaceSyncReplacementSourceQuiesced(
            deps.runtime,
            sourceWorkspaceUuid,
            operation,
            workspaceSyncActionFailed
          ),
      });
      if (result.ok && result.workspaceUuid) {
        const warning = await ensureWorkspaceWatcherAfterAction(deps.runtime, result.workspaceUuid);
        deps.statusPublisher?.invalidate(result.workspaceUuid, 'binding_changed');
        return warning ? { ...result, warnings: [...(result.warnings ?? []), warning] } : result;
      }
      return result;
    },
  };
}

async function ensureWorkspaceWatcherAfterAction(
  runtime: WorkspaceSyncActionRuntime,
  workspaceUuid: string
): Promise<UserMessage | null> {
  try {
    await runtime.ensureWatchingWorkspace(workspaceUuid);
    return null;
  } catch (error) {
    console.warn(
      `[workspace-sync] Could not start watching ${workspaceUuid} after a successful action:`,
      error instanceof Error ? error.message : String(error)
    );
    return WATCHER_START_WARNING;
  }
}

export async function withWorkspaceSyncReplacementSourceQuiesced<T>(
  runtime: WorkspaceSyncActionRuntime,
  workspaceUuid: string,
  operation: () => Promise<T>,
  shouldRestoreSource: (result: unknown) => boolean = () => true
): Promise<T> {
  let restoreSource = true;
  let outcome: { kind: 'returned'; value: T } | { kind: 'threw'; error: unknown } | null = null;
  runtime.pauseWorkspace(workspaceUuid);
  runtime.stopWatchingWorkspace(workspaceUuid);
  try {
    await runtime.waitForIdle(workspaceUuid);

    runtime.stopWatchingWorkspace(workspaceUuid);
    const result = await operation();
    restoreSource = shouldRestoreSource(result);
    outcome = { kind: 'returned', value: result };
  } catch (error) {
    outcome = { kind: 'threw', error };
  } finally {
    runtime.resumeWorkspace(workspaceUuid);
  }
  if (restoreSource) {
    try {
      await runtime.ensureWatchingWorkspace(workspaceUuid);
    } catch (error) {
      console.warn(
        `[workspace-sync] Could not restore watching after replacement for ${workspaceUuid}:`,
        error instanceof Error ? error.message : String(error)
      );
      throw new Error(WATCHER_START_WARNING, { cause: error });
    }
  }
  if (outcome === null) {
    throw new Error('Workspace replacement finished without an operation outcome.');
  }
  if (outcome.kind === 'threw') throw outcome.error;
  return outcome.value;
}

function workspaceSyncActionFailed(result: unknown): boolean {
  return typeof result !== 'object' || result === null || !('ok' in result) || result.ok !== true;
}

export async function setWorkspaceSyncEnabled(
  db: Database.Database,
  workspaceUuid: string,
  enabled: boolean,
  deps: WorkspaceSyncActionDeps,
  options: WorkspaceSyncEnableOptions = {}
): Promise<WorkspaceSyncSetEnabledResult> {
  if (!enabled) {
    const binding = readActionBinding(db, workspaceUuid);
    if (!binding) return actionError('Workspace sync is not set up for this project.');
    deps.runtime.pauseWorkspace(workspaceUuid);
    deps.runtime.stopWatchingWorkspace(workspaceUuid);
    try {
      cancelWorkspaceSyncUploadsBeforeStart(db, binding.workspace_id, deps.nowMs?.() ?? Date.now());
      await deps.runtime.waitForIdle(workspaceUuid);
      const disabled = disableWorkspaceSync(db, workspaceUuid, deps.nowMs?.() ?? Date.now());
      deps.statusPublisher?.invalidate(workspaceUuid, 'binding_changed');
      if (!disabled) return actionError('Workspace sync is not set up for this project.');
      return { ok: true };
    } finally {
      deps.runtime.resumeWorkspace(workspaceUuid);
    }
  }

  const session = await activeSession(deps);
  if (!session) return actionError('Sign in before enabling desktop sync.');

  try {
    const deviceId = readOrCreateWorkspaceSyncDeviceId(db, { nowMs: deps.nowMs });

    const ownerOrgId = options.owner?.kind === 'org' ? options.owner.orgId : null;
    await ensureWorkspaceSyncBinding(db, {
      workspaceUuid,
      ownerAccountId: session.accountId,
      ownerOrgId,
      nowMs: deps.nowMs?.() ?? Date.now(),
      claimClient:
        deps.claimClient ??
        deps.createClaimClient?.(deviceId) ??
        createWorkspaceSyncClaimClient(deviceId),
    });
    publishWorkspaceSyncEnablementTelemetry(db);
    db.prepare(
      `UPDATE workspace_sync_bindings
       SET access_role = COALESCE(access_role, @role),
           access_source = COALESCE(access_source, @source),
           shared_with_others = CASE WHEN @orgOwned = 1 THEN 1 ELSE shared_with_others END,
           detached_reason = NULL
       WHERE workspace_uuid = @workspaceUuid`
    ).run({
      workspaceUuid,

      role: ownerOrgId ? 'manager' : 'owner',
      source: ownerOrgId ? 'direct' : 'owner',
      orgOwned: ownerOrgId ? 1 : 0,
    });

    deps.statusPublisher?.invalidate(workspaceUuid, 'binding_changed');
    await deps.runtime.ensureWatchingWorkspace(workspaceUuid);

    const upload = await deps.runtime.flushWorkspace(workspaceUuid);
    deps.statusPublisher?.invalidate(workspaceUuid, 'queue_changed');
    return resultFromUpload(upload, 'Sync was enabled, but the initial upload did not complete');
  } catch (error) {
    deps.statusPublisher?.invalidate(workspaceUuid, 'binding_changed');
    return actionError(messageFromError(error));
  }
}

export async function forceWorkspaceSync(
  db: Database.Database,
  workspaceUuid: string,
  deps: WorkspaceSyncActionDeps
): Promise<WorkspaceSyncForceSyncResult> {
  const session = await activeSession(deps);
  if (!session) return actionError('Sign in before syncing this project.');

  const binding = readActionBinding(db, workspaceUuid);
  if (!binding) return actionError('Workspace sync is not set up for this project.');
  if (binding.enabled !== 1) return actionError('Turn on auto sync before syncing this project.');
  if (!binding.remote_workspace_id) {
    return actionError('This project has not been connected to cloud sync yet.');
  }
  if (binding.owner_account_id !== session.accountId) {
    return actionError('This project is bound to a different signed-in account.');
  }

  try {
    await deps.runtime.ensureWatchingWorkspace(workspaceUuid);
    const upload = await deps.runtime.flushWorkspace(workspaceUuid, { force: true });
    deps.statusPublisher?.invalidate(workspaceUuid, 'queue_changed');
    return resultFromUpload(upload, 'Sync upload did not complete');
  } catch (error) {
    deps.statusPublisher?.invalidate(workspaceUuid, 'queue_changed');
    return actionError(messageFromError(error));
  }
}

export function createWorkspaceSyncClaimClient(
  deviceId: string,
  client: DesktopSyncClient = createDesktopSyncClient()
): WorkspaceSyncClaimClient {
  return {
    supportsScientificHistory: true,
    claimWorkspace: async (request) => claimWorkspace(client, deviceId, request),
  };
}

async function claimWorkspace(
  client: DesktopSyncClient,
  deviceId: string,
  request: WorkspaceSyncClaimRequest
): Promise<WorkspaceSyncClaimResponse> {
  const rawResponse = await client.requestJson<unknown>('/api/desktop-sync/workspaces/claim', {
    method: 'POST',
    expectedAccountId: request.ownerAccountId,
    idempotencyKey: `claim:${request.clientWorkspaceId}:${request.ownerOrgId ?? request.ownerAccountId}`,
    body: {
      clientWorkspaceId: request.clientWorkspaceId,
      displayName: request.displayName,
      deviceId,
      owner: request.ownerOrgId ? { kind: 'org', orgId: request.ownerOrgId } : { kind: 'personal' },
      ...(request.scientificHistoryFormat
        ? { scientificHistoryFormat: request.scientificHistoryFormat }
        : {}),
    },
  });
  const response = parseDesktopSyncClaimResponse(rawResponse);
  if (response.clientWorkspaceId !== request.clientWorkspaceId) {
    throw new Error('Workspace claim response does not match the requested workspace.');
  }

  return {
    remoteWorkspaceId: response.workspaceId,
    clientWorkspaceId: response.clientWorkspaceId,
    claimedByAccountId: response.claimedBy.accountId,
    owner: response.owner,
    remoteLatestVersionId: null,
    remoteLatestVersionNumber: null,
    remoteLatestContentSha256: null,
    ...(response.scientificHistoryFormats
      ? { scientificHistoryFormats: response.scientificHistoryFormats }
      : {}),
  };
}

function disableWorkspaceSync(
  db: Database.Database,
  workspaceUuid: string,
  nowMs: number
): boolean {
  return db.transaction(() => {
    const binding = readActionBinding(db, workspaceUuid);
    if (!binding) return false;
    db.prepare(
      `UPDATE workspace_sync_bindings
       SET enabled = 0,
           updated_at = ?
       WHERE workspace_uuid = ?`
    ).run(nowMs, workspaceUuid);
    cancelWorkspaceSyncUploadsBeforeStart(db, binding.workspace_id, nowMs);
    return true;
  })();
}

function readActionBinding(
  db: Database.Database,
  workspaceUuid: string
): WorkspaceSyncActionBindingRow | null {
  const row = db
    .prepare(
      `SELECT workspace_id, workspace_uuid, owner_account_id, owner_org_id,
              remote_workspace_id, enabled
       FROM workspace_sync_bindings
       WHERE workspace_uuid = ?
       LIMIT 1`
    )
    .get(workspaceUuid) as WorkspaceSyncActionBindingRow | undefined;
  return row ?? null;
}

async function activeSession(deps: WorkspaceSyncActionDeps): Promise<StoredSession | null> {
  return deps.getActiveSession ? deps.getActiveSession() : getActiveStoredSession();
}

function resultFromUpload(
  upload: { status: string; errorCode?: string },
  prefix: string
): WorkspaceSyncSetEnabledResult {
  if (upload.status === 'retry_wait' && upload.errorCode === 'IN_PROGRESS') {
    return actionError('Sync is still in progress. DNAForge will retry automatically.');
  }
  if (UPLOAD_NOT_COMPLETE.has(upload.status)) {
    return actionError(`${prefix}: ${upload.errorCode ?? upload.status}.`);
  }
  return { ok: true };
}

function actionError(message: string): WorkspaceSyncActionError {
  return { ok: false, code: 'INVALID_REQUEST', message };
}

function messageFromError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Desktop sync action failed.';
}

export type { WorkspaceSyncRuntime };
