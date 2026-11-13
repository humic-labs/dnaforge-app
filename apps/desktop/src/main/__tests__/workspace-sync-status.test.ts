import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '1.0.0') },
}));

import { migrateLegacyWorkspaceSyncRendererRefresh } from '../workspace-sync-renderer-refresh-pending';
import { ensureSchema } from '../schema';
import {
  createWorkspaceSyncStatusPublisher,
  readWorkspaceSyncStatus,
  recordWorkspaceSyncAutomaticMergeResult,
  type WorkspaceSyncStatusDeps,
} from '../workspace-sync-status';
import { createTestDb } from './test-db';

describe('workspace sync main-process status model', () => {
  let db: Database.Database;
  let dirtyByWorkspace: NonNullable<
    WorkspaceSyncStatusDeps['getDirtyByWorkspace']
  > extends () => infer T
    ? T
    : never;
  let activeAccountId: string | null;

  beforeEach(() => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    dirtyByWorkspace = {};
    activeAccountId = 'account-a';
    seedSyncWorkspace(db, {
      workspaceId: 1,
      workspaceUuid: 'workspace-a',
      accountId: 'account-a',
      remoteWorkspaceId: 'remote-a',
      lastAckedLocalHeadSha: 'head-a',
    });
  });

  it('derives plain synced only from a bound clean workspace with matching local head', () => {
    expect(readWorkspaceSyncStatus(db, statusInput())).toMatchObject({
      workspaceUuid: 'workspace-a',
      syncAxis: 'idle_synced',
      bufferAxis: 'clean',
      canDisplayPlainSynced: true,
      blockers: [],
    });

    dirtyByWorkspace = {
      'workspace-a': { dirtySequenceDocumentIds: ['sequence-document-edited'] },
    };

    expect(readWorkspaceSyncStatus(db, statusInput())).toMatchObject({
      syncAxis: 'dirty_pending',
      bufferAxis: 'unsaved',
      canDisplayPlainSynced: false,
      blockers: expect.arrayContaining(['dirty_buffers']),
    });
  });

  it('keeps a managed workspace local-only until the user creates a sync binding', () => {
    db.prepare(`DELETE FROM workspace_sync_bindings WHERE workspace_id = 1`).run();

    expect(readWorkspaceSyncStatus(db, statusInput())).toMatchObject({
      workspaceUuid: 'workspace-a',
      syncAxis: 'local_only',
      canDisplayPlainSynced: false,
      blockers: expect.arrayContaining(['sync_disabled', 'missing_remote_binding']),
    });
  });

  it('uses durable queue and restore-lock state before claiming a workspace is synced', () => {
    seedQueue(db, {
      id: 'queue-a',
      workspaceId: 1,
      status: 'pending',
      operation: 'upload',
      errorCode: null,
      errorMessage: null,
    });

    expect(readWorkspaceSyncStatus(db, statusInput())).toMatchObject({
      syncAxis: 'queued',
      canDisplayPlainSynced: false,
      blockers: expect.arrayContaining(['queued_work']),
    });

    db.prepare(`DELETE FROM workspace_sync_queue`).run();
    db.prepare(
      `INSERT INTO workspace_sync_restore_locks (
        workspace_id, lock_id, status, started_at, expires_at
      ) VALUES (1, 'restore-a', 'restoring', 90, 5000)`
    ).run();

    expect(readWorkspaceSyncStatus(db, statusInput())).toMatchObject({
      syncAxis: 'restoring',
      canDisplayPlainSynced: false,
    });
  });

  it('loads the persisted exclusion summary and fails closed when it is missing or invalid', () => {
    const withoutOverride = statusInput();
    delete withoutOverride.getExcludedSummary;

    expect(readWorkspaceSyncStatus(db, withoutOverride)).toMatchObject({
      syncAxis: 'dirty_pending',
      canDisplayPlainSynced: false,
      blockers: expect.arrayContaining(['excluded_authoritative_state']),
    });

    seedLatestVersion(
      db,
      JSON.stringify({
        unsupportedCount: 0,
        privateRawDataCount: 0,
        referencePointerCount: 0,
        fileTooLargeCount: 0,
        bundleTooLargeCount: 0,
      })
    );
    expect(readWorkspaceSyncStatus(db, withoutOverride)).toMatchObject({
      syncAxis: 'idle_synced',
      canDisplayPlainSynced: true,
      blockers: [],
    });

    db.prepare(
      `UPDATE workspace_sync_versions SET excluded_summary_json = '{invalid' WHERE workspace_id = 1`
    ).run();
    expect(readWorkspaceSyncStatus(db, withoutOverride)).toMatchObject({
      syncAxis: 'dirty_pending',
      canDisplayPlainSynced: false,
      blockers: expect.arrayContaining(['excluded_authoritative_state']),
    });
  });

  it('maps account mismatch, retryable failures, conflicts, and terminal failures', () => {
    activeAccountId = 'account-b';
    expect(readWorkspaceSyncStatus(db, statusInput())).toMatchObject({
      syncAxis: 'auth_paused',
      blockers: expect.arrayContaining(['auth_unavailable']),
    });

    activeAccountId = 'account-a';
    seedQueue(db, {
      id: 'queue-retry',
      workspaceId: 1,
      status: 'retry_wait',
      operation: 'upload',
      errorCode: 'NETWORK',
      errorMessage: 'offline',
    });
    expect(readWorkspaceSyncStatus(db, statusInput())).toMatchObject({
      syncAxis: 'offline_retry',
      blockers: expect.arrayContaining(['offline_retry', 'queued_work']),
    });

    db.prepare(`DELETE FROM workspace_sync_queue`).run();
    seedQueue(db, {
      id: 'queue-rollout-paused',
      workspaceId: 1,
      status: 'retry_wait',
      operation: 'refresh',
      errorCode: 'FEATURE_DISABLED',
      errorMessage: 'rollout paused',
    });
    expect(readWorkspaceSyncStatus(db, statusInput())).toMatchObject({
      syncAxis: 'service_paused',
      blockers: expect.arrayContaining(['service_paused', 'queued_work']),
    });

    db.prepare(`DELETE FROM workspace_sync_queue`).run();
    seedQueue(db, {
      id: 'queue-conflict',
      workspaceId: 1,
      status: 'failed',
      operation: 'upload',
      errorCode: 'CONFLICT',
      errorMessage: 'remote changed',
    });
    expect(readWorkspaceSyncStatus(db, statusInput())).toMatchObject({
      syncAxis: 'conflict',
      blockers: expect.arrayContaining(['conflict']),
    });

    db.prepare(`DELETE FROM workspace_sync_queue`).run();
    seedQueue(db, {
      id: 'queue-quota',
      workspaceId: 1,
      status: 'failed',
      operation: 'upload',
      errorCode: 'QUOTA_EXCEEDED',
      errorMessage: 'quota exceeded',
    });
    expect(readWorkspaceSyncStatus(db, statusInput())).toMatchObject({
      syncAxis: 'terminal_error',
      terminalErrorCode: 'QUOTA_EXCEEDED',
      terminalErrorMessage: 'quota exceeded',
      blockers: expect.arrayContaining(['terminal_error']),
    });

    db.prepare(`DELETE FROM workspace_sync_queue`).run();
    seedQueue(db, {
      id: 'queue-recovery',
      workspaceId: 1,
      status: 'failed',
      operation: 'refresh',
      errorCode: 'REPLICA_RECOVERY_REQUIRED',
      errorMessage: 'interrupted pull needs repair',
    });
    expect(readWorkspaceSyncStatus(db, statusInput())).toMatchObject({
      syncAxis: 'terminal_error',
      terminalErrorCode: 'REPLICA_RECOVERY_REQUIRED',
      terminalErrorMessage: 'interrupted pull needs repair',
      blockers: expect.arrayContaining(['terminal_error']),
    });

    db.prepare(`DELETE FROM workspace_sync_queue`).run();
    seedQueue(db, {
      id: 'queue-renderer-refresh',
      workspaceId: 1,
      status: 'failed',
      operation: 'refresh',
      errorCode: 'RENDERER_REFRESH_PENDING',
      errorMessage: '{"version":1,"notice":{"changedPaths":["secret-path"]}}',
    });
    migrateLegacyWorkspaceSyncRendererRefresh(db);
    expect(readWorkspaceSyncStatus(db, statusInput())).toMatchObject({
      syncAxis: 'terminal_error',
      terminalErrorCode: 'RENDERER_DELIVERY_INVALID',
      terminalErrorMessage: 'Pending renderer refresh notice is invalid.',
      blockers: expect.arrayContaining(['terminal_error']),
    });
  });

  it.each(['status read', 'second subscriber'])(
    'keeps an unread transition for existing subscribers after a %s',
    (reader) => {
      let offline = true;
      const publisher = createWorkspaceSyncStatusPublisher(db, {
        ...statusInput(),
        isOffline: () => offline,
      });
      const listener = vi.fn();
      publisher.subscribe('workspace-a', listener);
      expect(listener.mock.calls[0][0].status.syncAxis).toBe('offline_retry');

      offline = false;
      if (reader === 'status read') {
        expect(publisher.getStatus('workspace-a').syncAxis).toBe('idle_synced');
      } else {
        const other = vi.fn();
        publisher.subscribe('workspace-a', other);
        expect(other.mock.calls[0][0].status.syncAxis).toBe('idle_synced');
      }
      publisher.invalidate('workspace-a', 'queue_changed');

      expect(listener).toHaveBeenCalledTimes(2);
      expect(listener.mock.calls[1][0].status).toMatchObject({
        syncAxis: 'idle_synced',
        canDisplayPlainSynced: true,
        blockers: [],
      });
      publisher.invalidate('workspace-a', 'queue_changed');
      expect(listener).toHaveBeenCalledTimes(2);
    }
  );

  it('publishes stable workspace-scoped subscription events only when status changes', () => {
    const publisher = createWorkspaceSyncStatusPublisher(db, {
      ...statusInput(),
      nowMs: () => 1000,
    });
    const listener = vi.fn();

    const unsubscribe = publisher.subscribe('workspace-a', listener);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toMatchObject({
      workspaceUuid: 'workspace-a',
      reason: 'subscribe',
      sequence: 1,
      emittedAt: 1000,
      status: { syncAxis: 'idle_synced', canDisplayPlainSynced: true },
    });

    seedQueue(db, {
      id: 'queue-a',
      workspaceId: 1,
      status: 'pending',
      operation: 'upload',
      errorCode: null,
      errorMessage: null,
    });
    publisher.invalidate('workspace-a', 'queue_changed');

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[1][0]).toMatchObject({
      workspaceUuid: 'workspace-a',
      reason: 'queue_changed',
      sequence: 2,
      status: { syncAxis: 'queued', canDisplayPlainSynced: false },
    });

    publisher.invalidate('workspace-b', 'queue_changed');
    publisher.invalidate('workspace-a', 'queue_changed');
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    db.prepare(`DELETE FROM workspace_sync_queue`).run();
    publisher.invalidate('workspace-a', 'queue_changed');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('shows why the automatic merge of a conflict failed until a later attempt succeeds ', () => {
    recordWorkspaceSyncAutomaticMergeResult(
      db,
      'workspace-a',
      { ok: false, code: 'INVALID_REQUEST', message: 'stale failure' },
      50
    );
    expect(readWorkspaceSyncStatus(db, statusInput()).automaticMerge).toBeUndefined();

    seedQueue(db, {
      id: 'queue-conflict',
      workspaceId: 1,
      status: 'failed',
      operation: 'upload',
      errorCode: 'SYNC_CONFLICT',
      errorMessage: 'remote changed',
    });
    const message = `Workspace manifest is not restorable: ${'files[4].kind does not match relativePath; '.repeat(40)}`;
    recordWorkspaceSyncAutomaticMergeResult(
      db,
      'workspace-a',
      { ok: false, code: 'INVALID_REQUEST', message },
      200
    );
    const failed = readWorkspaceSyncStatus(db, statusInput());
    expect(failed).toMatchObject({
      syncAxis: 'conflict',
      automaticMerge: {
        outcome: 'failed',
        message: message.slice(0, 1_000),
        failedAt: new Date(200).toISOString(),
      },
    });

    db.prepare(
      `INSERT INTO workspace_sync_merge_conflicts (
         id, workspace_id, workspace_uuid, remote_version_id, status, conflicts_json,
         payload_json, created_at, updated_at
       ) VALUES ('merge-conflict-a', 1, 'workspace-a', 'remote-v2', 'open', '[]', '{}', 300, 300)`
    ).run();
    recordWorkspaceSyncAutomaticMergeResult(
      db,
      'workspace-a',
      { ok: true, outcome: 'no_remote_change' },
      300
    );
    expect(readWorkspaceSyncStatus(db, statusInput()).automaticMerge).toEqual({
      outcome: 'conflicts',
      conflictId: 'merge-conflict-a',
    });
  });

  function statusInput(): WorkspaceSyncStatusDeps & { workspaceUuid: string } {
    return {
      workspaceUuid: 'workspace-a',
      getActiveAccountId: () => activeAccountId,
      getDirtyByWorkspace: () => dirtyByWorkspace,
      getCurrentLocalHeadSha: () => 'head-a',
      getExcludedSummary: () => null,
      isOffline: () => false,
      nowMs: () => 100,
    };
  }
});

function seedSyncWorkspace(
  db: Database.Database,
  input: {
    workspaceId: number;
    workspaceUuid: string;
    accountId: string;
    remoteWorkspaceId: string | null;
    lastAckedLocalHeadSha: string | null;
  }
): void {
  db.prepare(
    `INSERT INTO workspaces (id, name, path, repo_uuid, created_at, last_opened_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    input.workspaceId,
    input.workspaceUuid,
    `/managed/${input.workspaceUuid}/repo`,
    input.workspaceUuid,
    1,
    1
  );
  db.prepare(
    `INSERT INTO workspace_sync_bindings (
      workspace_id, workspace_uuid, owner_account_id, remote_workspace_id,
      enabled, last_acked_local_head_sha, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 1, ?, 1, 1)`
  ).run(
    input.workspaceId,
    input.workspaceUuid,
    input.accountId,
    input.remoteWorkspaceId,
    input.lastAckedLocalHeadSha
  );
}

function seedQueue(
  db: Database.Database,
  input: {
    id: string;
    workspaceId: number;
    operation: string;
    status: string;
    errorCode: string | null;
    errorMessage: string | null;
  }
): void {
  db.prepare(
    `INSERT INTO workspace_sync_queue (
      id, workspace_id, operation, status, error_code, error_message, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 100, 100)`
  ).run(
    input.id,
    input.workspaceId,
    input.operation,
    input.status,
    input.errorCode,
    input.errorMessage
  );
}

function seedLatestVersion(db: Database.Database, excludedSummaryJson: string): void {
  db.prepare(
    `INSERT INTO workspace_sync_versions (
       id, workspace_id, remote_version_id, version_number, content_sha256,
       local_head_sha, file_count, size_bytes, excluded_summary_json,
       status, is_latest, created_at, updated_at
     ) VALUES (
       'version-a', 1, 'version-a', 1, ?, 'head-a', 1, 100, ?, 'ready', 1, 1, 1
     )`
  ).run('a'.repeat(64), excludedSummaryJson);
}
