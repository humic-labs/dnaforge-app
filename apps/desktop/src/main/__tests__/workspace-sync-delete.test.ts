import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '1.0.0'), isPackaged: false, getPath: vi.fn(() => '/tmp') },
  dialog: { showErrorBox: vi.fn() },
  shell: { openExternal: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(value)),
    decryptString: vi.fn((value: Buffer) => value.toString('utf8')),
  },
}));

vi.mock('@sentry/electron/main', () => ({
  captureMessage: vi.fn(),
}));

vi.mock('../auth/auth-config', () => ({
  getWebBaseUrl: vi.fn(() => 'https://web.test'),
  getAuthChannel: vi.fn(() => 'dev'),
  getRedirectScheme: vi.fn(() => 'dnaforge-dev'),
}));

import { ensureSchema } from '../schema';
import {
  deleteWorkspaceSyncCloudCopy,
  type WorkspaceSyncDeleteClient,
} from '../workspace-sync-delete';
import { readWorkspaceSyncStatus } from '../workspace-sync-status';
import { createTestDb } from './test-db';
import { markWorkspaceSyncJobFailed } from '../workspace-sync-queue';
import {
  readPendingWorkspaceSyncRendererRefresh,
  recordPendingWorkspaceSyncRendererRefresh,
} from '../workspace-sync-renderer-refresh-pending';
import {
  __resetWorkspaceSyncObservationForTests,
  bindWorkspaceSyncObservationSink,
  type WorkspaceSyncObservation,
} from '../workspace-sync-observation';

const REMOTE_WORKSPACE_ID = '8a4d99e9-2347-4d04-a447-d3070f7a7f9a';
const REMOTE_VERSION_ID = '54a53fed-2b63-44c8-a26e-b0fb7e1788d2';
const HASH = 'a'.repeat(64);

describe('workspace sync cloud delete action', () => {
  let db: Database.Database;
  let deleteCloudCopy: ReturnType<typeof vi.fn>;
  let client: WorkspaceSyncDeleteClient;
  let runtime: {
    pauseWorkspace: ReturnType<typeof vi.fn>;
    resumeWorkspace: ReturnType<typeof vi.fn>;
    stopWatchingWorkspace: ReturnType<typeof vi.fn>;
    waitForIdle: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    deleteCloudCopy = vi.fn(async () => ({
      status: 'deleted' as const,
      workspaceId: REMOTE_WORKSPACE_ID,
      localSync: { shouldPause: true, clearRemoteBinding: true },
      shares: { revoked: 1, alreadyInactive: 0 },
      storage: { objectsRemoved: 1 },
      versions: { readyDeleted: 1, rowsRemoved: 0 },
      quota: { releasedBytes: 512 },
    }));
    client = { deleteCloudCopy };
    runtime = {
      pauseWorkspace: vi.fn(),
      resumeWorkspace: vi.fn(),
      stopWatchingWorkspace: vi.fn(),
      waitForIdle: vi.fn(async () => undefined),
    };
    seedSyncedWorkspace(db);
  });

  it('deletes the remote cloud copy, disables local sync, clears the remote binding, and cancels queued work', async () => {
    await expect(
      deleteWorkspaceSyncCloudCopy(db, {
        workspaceUuid: 'workspace-a',
        runtime,
        client,
        nowMs: () => 2000,
      })
    ).resolves.toMatchObject({
      ok: true,
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      sharesRevoked: 1,
      objectsRemoved: 1,
      readyVersionsDeleted: 1,
    });

    expect(deleteCloudCopy).toHaveBeenCalledWith({
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      ownerAccountId: 'account-a',
    });
    expect(runtime.pauseWorkspace).toHaveBeenCalledWith('workspace-a');
    expect(runtime.waitForIdle).toHaveBeenCalledWith('workspace-a');
    expect(runtime.stopWatchingWorkspace).toHaveBeenCalledWith('workspace-a');
    expect(runtime.resumeWorkspace).toHaveBeenCalledWith('workspace-a');
    expect(bindingRow(db)).toMatchObject({
      remote_workspace_id: null,
      enabled: 0,
      remote_latest_version_id: null,
      remote_latest_version_number: null,
      remote_latest_content_sha256: null,
      last_acked_local_head_sha: null,
    });
    expect(versionRow(db)).toMatchObject({
      status: 'deleted',
      is_latest: 0,
      deleted_at: 2000,
    });
    expect(queueRow(db, 'upload-a')).toMatchObject({
      status: 'canceled',
      error_code: 'CLOUD_COPY_DELETED',
    });
    expect(
      markWorkspaceSyncJobFailed(db, {
        id: 'upload-a',
        expectedStatus: 'running',
        nowMs: 2100,
        retryable: true,
        retryDelayMs: 1000,
        maxAttempts: 3,
        errorCode: 'NETWORK',
        errorMessage: 'late response',
      })
    ).toMatchObject({ status: 'canceled', errorCode: 'CLOUD_COPY_DELETED' });

    const status = readWorkspaceSyncStatus(db, {
      workspaceUuid: 'workspace-a',
      getActiveAccountId: () => 'account-a',
      getCurrentLocalHeadSha: () => 'head-a',
      nowMs: () => 2000,
    });
    expect(status.syncAxis).toBe('local_only');
    expect(status.blockers).toContain('missing_remote_binding');
  });

  it.each([false, true])(
    'preserves pending delivery and its binding when removing the cloud copy (commits while waiting: %s)',
    async (commitsWhileWaiting) => {
      const recordDelivery = () =>
        recordPendingWorkspaceSyncRendererRefresh(db, {
          workspaceId: 1,
          localHeadSha: 'head-a',
          nowMs: 100,
          notice: {
            workspaceUuid: 'workspace-a',
            workspaceRoot: '/managed/workspace-a/repo',
            remoteVersionId: REMOTE_VERSION_ID,
            changedPaths: [],
            deletedPaths: [],
            affectedNotebookIds: [],
            affectedDesignIds: [],
            deletedDesignIds: [],
          },
        });
      if (commitsWhileWaiting) {
        runtime.waitForIdle.mockImplementationOnce(async () => {
          recordDelivery();
        });
      } else {
        recordDelivery();
      }
      const bindingBefore = bindingRow(db);
      await expect(
        deleteWorkspaceSyncCloudCopy(db, { workspaceUuid: 'workspace-a', runtime, client })
      ).resolves.toMatchObject({ ok: false, message: expect.stringContaining('desktop') });
      expect(deleteCloudCopy).not.toHaveBeenCalled();
      expect(bindingRow(db)).toEqual(bindingBefore);
      expect(readPendingWorkspaceSyncRendererRefresh(db, 1)).not.toBeNull();
      expect(runtime.stopWatchingWorkspace).not.toHaveBeenCalled();
      expect(runtime.resumeWorkspace).toHaveBeenCalledWith('workspace-a');
    }
  );

  it('reports cloud-copy deletion outcomes with closed codes', async () => {
    const observations: WorkspaceSyncObservation[] = [];
    bindWorkspaceSyncObservationSink((observation) => observations.push(observation));
    try {
      await deleteWorkspaceSyncCloudCopy(db, {
        workspaceUuid: 'workspace-missing',
        runtime,
        client,
        nowMs: () => 2000,
      });
      await deleteWorkspaceSyncCloudCopy(db, {
        workspaceUuid: 'workspace-a',
        runtime,
        client,
        nowMs: () => 2000,
      });
      expect(observations).toEqual([
        {
          feature_area: 'workspace',
          sync_operation: 'delete_remote',
          sync_outcome: 'failed',
          error_code: 'not_configured',
        },
        { feature_area: 'workspace', sync_operation: 'delete_remote', sync_outcome: 'deleted' },
      ]);
    } finally {
      __resetWorkspaceSyncObservationForTests();
    }
  });

  it('fails closed without mutating local state when the server delete fails', async () => {
    deleteCloudCopy.mockRejectedValueOnce(new Error('server refused delete'));

    await expect(
      deleteWorkspaceSyncCloudCopy(db, {
        workspaceUuid: 'workspace-a',
        runtime,
        client,
        nowMs: () => 2000,
      })
    ).resolves.toMatchObject({
      ok: false,
      code: 'INVALID_REQUEST',
      message: 'server refused delete',
    });

    expect(bindingRow(db)).toMatchObject({
      remote_workspace_id: REMOTE_WORKSPACE_ID,
      enabled: 1,
    });
    expect(queueRow(db, 'upload-a')).toMatchObject({ status: 'pending' });
    expect(runtime.pauseWorkspace).toHaveBeenCalledWith('workspace-a');
    expect(runtime.stopWatchingWorkspace).not.toHaveBeenCalled();
    expect(runtime.resumeWorkspace).toHaveBeenCalledWith('workspace-a');
  });

  it('waits for an active upload to settle before asking the server to delete', async () => {
    let releaseIdle: (() => void) | undefined;
    runtime.waitForIdle.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseIdle = resolve;
        })
    );

    const deleting = deleteWorkspaceSyncCloudCopy(db, {
      workspaceUuid: 'workspace-a',
      runtime,
      client,
      nowMs: () => 2000,
    });
    await Promise.resolve();
    expect(deleteCloudCopy).not.toHaveBeenCalled();

    releaseIdle?.();
    await expect(deleting).resolves.toMatchObject({ ok: true });
    expect(deleteCloudCopy).toHaveBeenCalledOnce();
  });
});

function seedSyncedWorkspace(db: Database.Database): void {
  db.prepare(
    `INSERT INTO workspaces (id, name, path, repo_uuid, created_at, last_opened_at)
     VALUES (1, 'Project A', '/managed/workspace-a/repo', 'workspace-a', 1, 1)`
  ).run();
  db.prepare(
    `INSERT INTO workspace_sync_bindings (
      workspace_id, workspace_uuid, owner_account_id, remote_workspace_id,
      enabled, remote_latest_version_id, remote_latest_version_number,
      remote_latest_content_sha256, last_acked_local_head_sha, created_at, updated_at
    ) VALUES (1, 'workspace-a', 'account-a', ?, 1, ?, 2, ?, 'head-a', 1, 1)`
  ).run(REMOTE_WORKSPACE_ID, REMOTE_VERSION_ID, HASH);
  db.prepare(
    `INSERT INTO workspace_sync_versions (
      id, workspace_id, remote_version_id, version_number, content_sha256,
      local_head_sha, file_count, size_bytes, status, is_latest, created_at, updated_at
    ) VALUES (?, 1, ?, 2, ?, 'head-a', 1, 512, 'ready', 1, 1, 1)`
  ).run(REMOTE_VERSION_ID, REMOTE_VERSION_ID, HASH);
  db.prepare(
    `INSERT INTO workspace_sync_queue (
      id, workspace_id, operation, status, idempotency_key, base_remote_version_id,
      local_head_sha, attempt_count, created_at, updated_at
    ) VALUES (
      'upload-a', 1, 'upload', 'pending', 'upload:workspace-a', ?, 'head-b', 0, 1, 1
    )`
  ).run(REMOTE_VERSION_ID);
}

function bindingRow(db: Database.Database): Record<string, unknown> {
  return db.prepare(`SELECT * FROM workspace_sync_bindings WHERE workspace_id = 1`).get() as Record<
    string,
    unknown
  >;
}

function versionRow(db: Database.Database): Record<string, unknown> {
  return db.prepare(`SELECT * FROM workspace_sync_versions WHERE workspace_id = 1`).get() as Record<
    string,
    unknown
  >;
}

function queueRow(db: Database.Database, id: string): Record<string, unknown> {
  return db.prepare(`SELECT * FROM workspace_sync_queue WHERE id = ?`).get(id) as Record<
    string,
    unknown
  >;
}
