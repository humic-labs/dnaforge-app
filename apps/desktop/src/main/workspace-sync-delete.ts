import { cancelWorkspaceSyncJobsForDeletedCloudCopy } from './workspace-sync-queue';
import type Database from 'better-sqlite3';

import {
  type WorkspaceSyncActionError,
  type WorkspaceSyncDeleteCloudCopyResult,
} from '../shared/workspace-sync-ipc';
import {
  DesktopSyncClientError,
  createDesktopSyncClient,
  type DesktopSyncClient,
} from './desktop-sync-client';
import { readWorkspaceSyncRendererDeliveryStatus } from './workspace-sync-renderer-refresh-pending';
import { observeWorkspaceSync, workspaceSyncErrorCode } from './workspace-sync-observation';

export interface DesktopSyncCloudDeleteResponse {
  status: 'deleted';
  workspaceId: string;
  localSync: {
    shouldPause: true;
    clearRemoteBinding: true;
  };
  shares: {
    revoked: number;
    alreadyInactive: number;
  };
  storage: {
    objectsRemoved: number;
  };
  versions: {
    readyDeleted: number;
    rowsRemoved: number;
  };
  quota: {
    releasedBytes: number;
  };
}

export interface WorkspaceSyncDeleteRequest {
  remoteWorkspaceId: string;
  ownerAccountId: string;
}

export interface WorkspaceSyncDeleteClient {
  deleteCloudCopy(request: WorkspaceSyncDeleteRequest): Promise<DesktopSyncCloudDeleteResponse>;
}

export interface DeleteWorkspaceSyncCloudCopyInput {
  workspaceUuid: string;
  runtime: WorkspaceSyncDeleteRuntime;
  client?: WorkspaceSyncDeleteClient;
  nowMs?: () => number;
}

export interface WorkspaceSyncDeleteRuntime {
  pauseWorkspace(workspaceUuid: string): void;
  resumeWorkspace(workspaceUuid: string): void;
  stopWatchingWorkspace(workspaceUuid: string): void;
  waitForIdle(workspaceUuid?: string): Promise<void>;
}

interface DeleteContextRow {
  workspace_id: number;
  workspace_uuid: string;
  owner_account_id: string;
  remote_workspace_id: string | null;
  enabled: number;
}

export async function deleteWorkspaceSyncCloudCopy(
  db: Database.Database,
  input: DeleteWorkspaceSyncCloudCopyInput
): Promise<WorkspaceSyncDeleteCloudCopyResult> {
  const failed = (error_code: string, message: string) => {
    observeWorkspaceSync({ sync_operation: 'delete_remote', sync_outcome: 'failed', error_code });
    return actionError(message);
  };
  try {
    const context = selectDeleteContext(db, input.workspaceUuid);
    if (!context) return failed('not_configured', 'Workspace sync is not set up for this project.');
    if (!context.remote_workspace_id) {
      return failed('not_found', 'This project does not have a cloud copy to remove.');
    }

    input.runtime.pauseWorkspace(input.workspaceUuid);
    try {
      await input.runtime.waitForIdle(input.workspaceUuid);
      if (readWorkspaceSyncRendererDeliveryStatus(db, context.workspace_id).pendingCount > 0) {
        return failed(
          'renderer_delivery_pending',
          'The desktop must finish applying incoming changes before removing the cloud copy.'
        );
      }
      const response = await (input.client ?? createWorkspaceSyncDeleteClient()).deleteCloudCopy({
        remoteWorkspaceId: context.remote_workspace_id,
        ownerAccountId: context.owner_account_id,
      });
      if (response.status !== 'deleted' || response.workspaceId !== context.remote_workspace_id) {
        return failed('bad_response', 'Cloud delete response did not match the bound workspace.');
      }

      detachLocalCloudBinding(db, {
        workspaceId: context.workspace_id,
        nowMs: input.nowMs?.() ?? Date.now(),
      });
      input.runtime.stopWatchingWorkspace(input.workspaceUuid);
      observeWorkspaceSync({ sync_operation: 'delete_remote', sync_outcome: 'deleted' });

      return {
        ok: true,
        remoteWorkspaceId: context.remote_workspace_id,
        sharesRevoked: response.shares.revoked,
        objectsRemoved: response.storage.objectsRemoved,
        readyVersionsDeleted: response.versions.readyDeleted,
        rowsRemoved: response.versions.rowsRemoved,
      };
    } finally {
      input.runtime.resumeWorkspace(input.workspaceUuid);
    }
  } catch (error) {
    return failed(workspaceSyncErrorCode(error), messageFromError(error));
  }
}

export function createWorkspaceSyncDeleteClient(
  client: DesktopSyncClient = createDesktopSyncClient()
): WorkspaceSyncDeleteClient {
  return {
    deleteCloudCopy: (request) =>
      client.requestJson<DesktopSyncCloudDeleteResponse>(
        `/api/desktop-sync/workspaces/${encodeURIComponent(request.remoteWorkspaceId)}`,
        { method: 'DELETE', expectedAccountId: request.ownerAccountId }
      ),
  };
}

function selectDeleteContext(
  db: Database.Database,
  workspaceUuid: string
): DeleteContextRow | null {
  const row = db
    .prepare(
      `SELECT workspace_id, workspace_uuid, owner_account_id, remote_workspace_id, enabled
       FROM workspace_sync_bindings
       WHERE workspace_uuid = ?
       LIMIT 1`
    )
    .get(workspaceUuid) as DeleteContextRow | undefined;
  return row ?? null;
}

function detachLocalCloudBinding(
  db: Database.Database,
  input: { workspaceId: number; nowMs: number }
): void {
  db.transaction(() => {
    db.prepare(
      `DELETE FROM workspace_sync_upload_snapshots
       WHERE job_id IN (
         SELECT id FROM workspace_sync_queue WHERE workspace_id = @workspaceId
       )`
    ).run(input);

    cancelWorkspaceSyncJobsForDeletedCloudCopy(db, input);

    db.prepare(
      `UPDATE workspace_sync_versions
       SET status = 'deleted',
           is_latest = 0,
           deleted_at = @nowMs,
           updated_at = @nowMs
       WHERE workspace_id = @workspaceId
         AND status = 'ready'`
    ).run(input);

    db.prepare(
      `UPDATE workspace_sync_versions
       SET is_latest = 0,
           updated_at = @nowMs
       WHERE workspace_id = @workspaceId
         AND is_latest = 1`
    ).run(input);

    db.prepare(
      `UPDATE workspace_sync_bindings
       SET remote_workspace_id = NULL,
           enabled = 0,
           remote_latest_version_id = NULL,
           remote_latest_version_number = NULL,
           remote_latest_content_sha256 = NULL,
           last_acked_local_head_sha = NULL,
           updated_at = @nowMs
       WHERE workspace_id = @workspaceId`
    ).run(input);
  })();
}

function messageFromError(error: unknown): string {
  if (error instanceof DesktopSyncClientError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Unable to remove the cloud copy.';
}

function actionError(message: string): WorkspaceSyncActionError {
  return {
    ok: false,
    code: 'INVALID_REQUEST',
    message,
  };
}
