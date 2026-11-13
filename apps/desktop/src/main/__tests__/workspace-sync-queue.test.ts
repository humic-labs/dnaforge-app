import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '1.0.0') },
}));

import { ensureSchema } from '../schema';
import {
  claimNextWorkspaceSyncJob,
  enqueueWorkspaceSyncJob,
  isForceRetryableWorkspaceSyncFailure,
  markWorkspaceSyncJobFailed,
  markWorkspaceSyncJobSucceeded,
  recoverWorkspaceSyncQueue,
  requeueWorkspaceSyncJob,
} from '../workspace-sync-queue';
import { createTestDb } from './test-db';

describe('workspace sync queue reducer', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    seedSyncWorkspace(db, { workspaceId: 1, workspaceUuid: 'workspace-a', accountId: 'account-a' });
  });

  it('retains native accepted identity for automatic retry and rotates it for a failed upload retry', () => {
    const first = enqueueWorkspaceSyncJob(db, {
      id: 'queue-a',
      workspaceId: 1,
      operation: 'upload',
      idempotencyKey: 'same-native-request',
      nowMs: 100,
    });
    expect(first.acceptedOperationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(first.acceptedOperationStartedAt).toBe(100);
    markWorkspaceSyncJobFailed(db, {
      id: first.id,
      nowMs: 200,
      retryable: true,
      retryDelayMs: 10,
      maxAttempts: 3,
      errorCode: 'NETWORK',
      errorMessage: 'offline',
    });
    const automatic = requeueWorkspaceSyncJob(db, { id: first.id, nowMs: 300 });
    expect(automatic).toMatchObject({
      acceptedOperationId: first.acceptedOperationId,
      acceptedOperationStartedAt: 100,
      id: first.id,
      createdAt: 100,
    });
    markWorkspaceSyncJobFailed(db, {
      id: first.id,
      nowMs: 400,
      retryable: false,
      retryDelayMs: 0,
      maxAttempts: 3,
      errorCode: 'VALIDATION',
      errorMessage: 'refused',
    });
    const retry = requeueWorkspaceSyncJob(db, {
      id: first.id,
      nowMs: 500,
      resetAttemptCount: true,
    });
    expect(retry.acceptedOperationId).not.toBe(first.acceptedOperationId);
    expect(retry).toMatchObject({
      acceptedOperationStartedAt: 500,
      id: first.id,
      createdAt: 100,
      idempotencyKey: first.idempotencyKey,
    });
    const diagnostic = enqueueWorkspaceSyncJob(db, {
      id: 'diagnostic',
      workspaceId: 1,
      operation: 'refresh',
      nowMs: 600,
    });
    expect(diagnostic).toMatchObject({
      acceptedOperationId: null,
      acceptedOperationStartedAt: null,
    });
    markWorkspaceSyncJobFailed(db, {
      id: diagnostic.id,
      nowMs: 700,
      retryable: false,
      retryDelayMs: 0,
      maxAttempts: 1,
      errorCode: 'PACKAGE_RECOVERY_REQUIRED',
      errorMessage: 'diagnostic',
    });
    expect(markWorkspaceSyncJobSucceeded(db, { id: diagnostic.id, nowMs: 800 })).toMatchObject({
      status: 'succeeded',
    });
  });

  it('refuses a failure callback from the previously accepted native upload operation', () => {
    const first = enqueueWorkspaceSyncJob(db, {
      id: 'queue-a',
      workspaceId: 1,
      operation: 'upload',
      nowMs: 100,
    });
    markWorkspaceSyncJobFailed(db, {
      id: first.id,
      nowMs: 100,
      retryable: false,
      retryDelayMs: 0,
      maxAttempts: 1,
      errorCode: 'VALIDATION',
      errorMessage: 'old refusal',
    });
    const retry = requeueWorkspaceSyncJob(db, {
      id: first.id,
      nowMs: 100,
      resetAttemptCount: true,
    });
    expect(retry.acceptedOperationId).not.toBe(first.acceptedOperationId);
    expect(
      claimNextWorkspaceSyncJob(db, { ...claimInput('account-a', 100), jobId: first.id })
    ).toMatchObject({ status: 'running', acceptedOperationId: retry.acceptedOperationId });
    const stale = markWorkspaceSyncJobFailed(db, {
      id: first.id,
      expectedStatus: 'running',
      expectedAcceptedOperationId: first.acceptedOperationId,
      nowMs: 100,
      retryable: false,
      retryDelayMs: 0,
      maxAttempts: 1,
      errorCode: 'VALIDATION',
      errorMessage: 'late old refusal',
    });
    expect(stale).toMatchObject({
      status: 'running',
      acceptedOperationId: retry.acceptedOperationId,
      errorCode: null,
    });
  });

  it('collapses duplicate enqueue attempts by idempotency key', () => {
    const first = enqueueWorkspaceSyncJob(db, {
      id: 'queue-a',
      workspaceId: 1,
      operation: 'upload',
      idempotencyKey: 'upload:workspace-a:head-a',
      localHeadSha: 'head-a',
      bundleContentSha256: sha('a'),
      nowMs: 100,
    });
    const second = enqueueWorkspaceSyncJob(db, {
      id: 'queue-b',
      workspaceId: 1,
      operation: 'upload',
      idempotencyKey: 'upload:workspace-a:head-a',
      localHeadSha: 'head-a',
      bundleContentSha256: sha('a'),
      nowMs: 200,
    });

    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(100);
    expect(second.updatedAt).toBe(100);
    expect(queueCount(db)).toBe(1);
  });

  it('pauses jobs for the wrong active account and unpauses them when that owner is active', () => {
    enqueueWorkspaceSyncJob(db, {
      id: 'queue-a',
      workspaceId: 1,
      operation: 'upload',
      idempotencyKey: 'upload:workspace-a:head-a',
      localHeadSha: 'head-a',
      nowMs: 100,
    });

    expect(
      recoverWorkspaceSyncQueue(db, {
        activeAccountId: 'account-b',
        deviceId: 'device-a',
        nowMs: 200,
        staleLockMs: 500,
      })
    ).toMatchObject({ accountBlocked: 1, accountUnblocked: 0 });
    expect(claimNextWorkspaceSyncJob(db, claimInput('account-b', 210))).toBeNull();
    expect(queueStatus(db, 'queue-a')).toBe('blocked');

    expect(
      recoverWorkspaceSyncQueue(db, {
        activeAccountId: 'account-a',
        deviceId: 'device-a',
        nowMs: 300,
        staleLockMs: 500,
      })
    ).toMatchObject({ accountBlocked: 0, accountUnblocked: 1 });

    const claimed = claimNextWorkspaceSyncJob(db, claimInput('account-a', 310));
    expect(claimed).toMatchObject({
      id: 'queue-a',
      status: 'running',
      lockedByDeviceId: 'device-a',
      attemptCount: 1,
    });
  });

  it('recovers stale running locks on restart before claiming due work', () => {
    enqueueWorkspaceSyncJob(db, {
      id: 'queue-a',
      workspaceId: 1,
      operation: 'upload',
      idempotencyKey: 'upload:workspace-a:head-a',
      localHeadSha: 'head-a',
      nowMs: 100,
    });
    expect(claimNextWorkspaceSyncJob(db, claimInput('account-a', 110))).toMatchObject({
      status: 'running',
      lockedByDeviceId: 'device-a',
    });

    expect(
      recoverWorkspaceSyncQueue(db, {
        activeAccountId: 'account-a',
        deviceId: 'device-a',
        nowMs: 1000,
        staleLockMs: 500,
        excludedJobIds: ['queue-a'],
      })
    ).toMatchObject({ staleReclaimed: 0 });
    expect(queueStatus(db, 'queue-a')).toBe('running');

    expect(
      recoverWorkspaceSyncQueue(db, {
        activeAccountId: 'account-a',
        deviceId: 'device-a',
        nowMs: 1000,
        staleLockMs: 500,
      })
    ).toMatchObject({ staleReclaimed: 1 });

    expect(queueStatus(db, 'queue-a')).toBe('retry_wait');
    const reclaimed = claimNextWorkspaceSyncJob(db, claimInput('account-a', 1001));
    expect(reclaimed).toMatchObject({
      id: 'queue-a',
      status: 'running',
      attemptCount: 2,
      lockedAt: 1001,
    });
  });

  it('schedules retryable failures and leaves terminal failures unclaimable', () => {
    enqueueWorkspaceSyncJob(db, {
      id: 'queue-a',
      workspaceId: 1,
      operation: 'upload',
      idempotencyKey: 'upload:workspace-a:head-a',
      localHeadSha: 'head-a',
      nowMs: 100,
    });
    expect(claimNextWorkspaceSyncJob(db, claimInput('account-a', 110))).toMatchObject({
      attemptCount: 1,
    });

    expect(
      markWorkspaceSyncJobFailed(db, {
        id: 'queue-a',
        nowMs: 120,
        retryable: true,
        retryDelayMs: 1000,
        maxAttempts: 3,
        errorCode: 'NETWORK',
        errorMessage: 'offline',
      })
    ).toMatchObject({
      status: 'retry_wait',
      nextAttemptAt: 1120,
      errorCode: 'NETWORK',
    });
    expect(claimNextWorkspaceSyncJob(db, claimInput('account-a', 1119))).toBeNull();
    expect(claimNextWorkspaceSyncJob(db, claimInput('account-a', 1120))).toMatchObject({
      attemptCount: 2,
      status: 'running',
    });

    expect(
      markWorkspaceSyncJobFailed(db, {
        id: 'queue-a',
        nowMs: 1130,
        retryable: false,
        retryDelayMs: 1000,
        maxAttempts: 3,
        errorCode: 'CONFLICT',
        errorMessage: 'remote changed',
      })
    ).toMatchObject({
      status: 'failed',
      nextAttemptAt: null,
      lockedByDeviceId: null,
    });
    expect(claimNextWorkspaceSyncJob(db, claimInput('account-a', 2130))).toBeNull();
  });

  it('keeps an account-change failure retryable past the attempt budget so the owner can resume it ', async () => {
    enqueueWorkspaceSyncJob(db, {
      id: 'queue-acct',
      workspaceId: 1,
      operation: 'upload',
      idempotencyKey: 'upload:workspace-a:head-acct',
      localHeadSha: 'head-acct',
      nowMs: 100,
    });
    expect(claimNextWorkspaceSyncJob(db, claimInput('account-a', 110))).toMatchObject({
      id: 'queue-acct',
      attemptCount: 1,
    });

    const paused = markWorkspaceSyncJobFailed(db, {
      id: 'queue-acct',
      nowMs: 120,
      retryable: true,
      retryDelayMs: 1000,
      maxAttempts: 1,
      errorCode: 'ACCOUNT_CHANGED',
      errorMessage: 'The signed-in account changed before this sync request was sent.',
    });

    expect(paused).toMatchObject({ status: 'retry_wait', errorCode: 'ACCOUNT_CHANGED' });
    expect(isForceRetryableWorkspaceSyncFailure(paused)).toBe(true);
  });

  it('does not overwrite a terminal state changed while a running request was in flight', () => {
    for (const id of ['queue-failure', 'queue-success']) {
      enqueueWorkspaceSyncJob(db, {
        id,
        workspaceId: 1,
        operation: 'upload',
        idempotencyKey: `upload:workspace-a:${id}`,
        localHeadSha: id,
        nowMs: id === 'queue-failure' ? 100 : 200,
      });
      expect(
        claimNextWorkspaceSyncJob(db, { ...claimInput('account-a', 210), jobId: id })
      ).toMatchObject({
        id,
        status: 'running',
      });
      db.prepare(
        `UPDATE workspace_sync_queue
         SET status = 'canceled', error_code = 'CLOUD_COPY_DELETED', updated_at = 220
         WHERE id = ?`
      ).run(id);
    }

    expect(
      markWorkspaceSyncJobFailed(db, {
        id: 'queue-failure',
        expectedStatus: 'running',
        nowMs: 230,
        retryable: true,
        retryDelayMs: 1000,
        maxAttempts: 3,
        errorCode: 'NETWORK',
        errorMessage: 'late response',
      })
    ).toMatchObject({ status: 'canceled', errorCode: 'CLOUD_COPY_DELETED' });
    expect(
      markWorkspaceSyncJobSucceeded(db, {
        id: 'queue-success',
        expectedStatus: 'running',
        nowMs: 230,
      })
    ).toMatchObject({ status: 'canceled', errorCode: 'CLOUD_COPY_DELETED' });
  });

  it('reactivates only a sync-disabled upload with the same immutable idempotency key', () => {
    const input = {
      id: 'queue-a',
      workspaceId: 1,
      operation: 'upload' as const,
      idempotencyKey: 'upload:workspace-a:base-a:head-a:content-a',
      localHeadSha: 'head-a',
      nowMs: 100,
    };
    enqueueWorkspaceSyncJob(db, input);
    db.prepare(
      `UPDATE workspace_sync_queue
       SET status = 'canceled', error_code = 'SYNC_DISABLED', updated_at = 110
       WHERE id = 'queue-a'`
    ).run();

    expect(enqueueWorkspaceSyncJob(db, { ...input, id: 'ignored', nowMs: 120 })).toMatchObject({
      id: 'queue-a',
      status: 'pending',
      errorCode: null,
      nextAttemptAt: 120,
    });
  });

  it('does not claim uploads while a workspace has a failed recovery quarantine', () => {
    enqueueWorkspaceSyncJob(db, {
      id: 'upload-a',
      workspaceId: 1,
      operation: 'upload',
      idempotencyKey: 'upload:workspace-a:head-a',
      localHeadSha: 'head-a',
      nowMs: 100,
    });
    enqueueWorkspaceSyncJob(db, {
      id: 'recovery-a',
      workspaceId: 1,
      operation: 'refresh',
      idempotencyKey: 'replica-recovery:workspace-a',
      nowMs: 110,
    });
    markWorkspaceSyncJobFailed(db, {
      id: 'recovery-a',
      nowMs: 120,
      retryable: false,
      retryDelayMs: 0,
      maxAttempts: 1,
      errorCode: 'REPLICA_RECOVERY_REQUIRED',
      errorMessage: 'repair required',
    });

    expect(claimNextWorkspaceSyncJob(db, claimInput('account-a', 130))).toBeNull();
    expect(queueStatus(db, 'upload-a')).toBe('pending');
  });

  it('keeps NETWORK failures retryable past the attempt budget', () => {
    enqueueWorkspaceSyncJob(db, {
      id: 'queue-a',
      workspaceId: 1,
      operation: 'upload',
      idempotencyKey: 'upload:workspace-a:head-a',
      localHeadSha: 'head-a',
      nowMs: 100,
    });

    let nowMs = 110;
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      expect(claimNextWorkspaceSyncJob(db, claimInput('account-a', nowMs))).toMatchObject({
        attemptCount: attempt,
        status: 'running',
      });
      expect(
        markWorkspaceSyncJobFailed(db, {
          id: 'queue-a',
          nowMs,
          retryable: true,
          retryDelayMs: 1000,
          maxAttempts: 3,
          errorCode: 'NETWORK',
          errorMessage: 'offline',
        })
      ).toMatchObject({
        status: 'retry_wait',
        errorCode: 'NETWORK',
      });
      nowMs += 1000;
    }

    expect(claimNextWorkspaceSyncJob(db, claimInput('account-a', nowMs))).toMatchObject({
      attemptCount: 7,
      status: 'running',
    });
  });

  it('requeues a failed job for immediate claim and can reset the attempt budget', () => {
    enqueueWorkspaceSyncJob(db, {
      id: 'queue-a',
      workspaceId: 1,
      operation: 'upload',
      idempotencyKey: 'upload:workspace-a:head-a',
      localHeadSha: 'head-a',
      nowMs: 100,
    });
    claimNextWorkspaceSyncJob(db, claimInput('account-a', 110));
    markWorkspaceSyncJobFailed(db, {
      id: 'queue-a',
      nowMs: 120,
      retryable: false,
      retryDelayMs: 1000,
      maxAttempts: 1,
      errorCode: 'VALIDATION',
      errorMessage: 'bad bundle',
    });
    expect(queueStatus(db, 'queue-a')).toBe('failed');

    expect(
      requeueWorkspaceSyncJob(db, { id: 'queue-a', nowMs: 500, resetAttemptCount: true })
    ).toMatchObject({
      status: 'pending',
      attemptCount: 0,
      nextAttemptAt: 500,
      errorCode: null,
    });
    expect(claimNextWorkspaceSyncJob(db, claimInput('account-a', 500))).toMatchObject({
      id: 'queue-a',
      status: 'running',
      attemptCount: 1,
    });
  });

  it('does not let a newer upload overtake an older retry for the same workspace', () => {
    enqueueWorkspaceSyncJob(db, {
      id: 'queue-older',
      workspaceId: 1,
      operation: 'upload',
      idempotencyKey: 'upload:workspace-a:base-a:head-a:content-a',
      baseRemoteVersionId: 'base-a',
      localHeadSha: 'head-a',
      nowMs: 100,
    });
    expect(claimNextWorkspaceSyncJob(db, claimInput('account-a', 110))).toMatchObject({
      id: 'queue-older',
      status: 'running',
    });
    markWorkspaceSyncJobFailed(db, {
      id: 'queue-older',
      nowMs: 120,
      retryable: true,
      retryDelayMs: 1_000,
      maxAttempts: 3,
      errorCode: 'NETWORK',
      errorMessage: 'response lost',
    });
    enqueueWorkspaceSyncJob(db, {
      id: 'queue-newer',
      workspaceId: 1,
      operation: 'upload',
      idempotencyKey: 'upload:workspace-a:base-a:head-b:content-b',
      baseRemoteVersionId: 'base-a',
      localHeadSha: 'head-b',
      nowMs: 200,
    });

    expect(claimNextWorkspaceSyncJob(db, claimInput('account-a', 200))).toBeNull();
    expect(queueStatus(db, 'queue-newer')).toBe('pending');

    expect(claimNextWorkspaceSyncJob(db, claimInput('account-a', 1120))).toMatchObject({
      id: 'queue-older',
      status: 'running',
    });
    markWorkspaceSyncJobSucceeded(db, { id: 'queue-older', nowMs: 1130 });
    expect(claimNextWorkspaceSyncJob(db, claimInput('account-a', 1131))).toMatchObject({
      id: 'queue-newer',
      status: 'running',
    });
  });

  it('does not claim work while a restore lock is active and ignores terminal jobs', () => {
    enqueueWorkspaceSyncJob(db, {
      id: 'queue-a',
      workspaceId: 1,
      operation: 'upload',
      idempotencyKey: 'upload:workspace-a:head-a',
      localHeadSha: 'head-a',
      nowMs: 100,
    });
    db.prepare(
      `INSERT INTO workspace_sync_restore_locks (
        workspace_id, lock_id, status, started_at, expires_at
      ) VALUES (1, 'restore-a', 'restoring', 105, 1000)`
    ).run();

    expect(claimNextWorkspaceSyncJob(db, claimInput('account-a', 110))).toBeNull();

    db.prepare(
      `UPDATE workspace_sync_restore_locks SET status = 'completed', completed_at = 120`
    ).run();
    const claimed = claimNextWorkspaceSyncJob(db, claimInput('account-a', 130));
    expect(claimed).toMatchObject({ id: 'queue-a', status: 'running' });
    expect(markWorkspaceSyncJobSucceeded(db, { id: 'queue-a', nowMs: 140 })).toMatchObject({
      status: 'succeeded',
      lockedAt: null,
      lockedByDeviceId: null,
    });
    expect(claimNextWorkspaceSyncJob(db, claimInput('account-a', 150))).toBeNull();
  });
});

function seedSyncWorkspace(
  db: Database.Database,
  input: { workspaceId: number; workspaceUuid: string; accountId: string }
): void {
  db.prepare(
    `INSERT INTO workspace_sync_device (id, device_id, created_at, updated_at)
     VALUES (1, 'device-a', 1, 1)`
  ).run();
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
      enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 1, 1, 1)`
  ).run(input.workspaceId, input.workspaceUuid, input.accountId, `remote-${input.workspaceUuid}`);
}

function claimInput(activeAccountId: string, nowMs: number) {
  return {
    activeAccountId,
    deviceId: 'device-a',
    nowMs,
  };
}

function queueStatus(db: Database.Database, id: string): string {
  return (
    db.prepare(`SELECT status FROM workspace_sync_queue WHERE id = ?`).get(id) as { status: string }
  ).status;
}

function queueCount(db: Database.Database): number {
  return (
    db.prepare(`SELECT COUNT(*) AS count FROM workspace_sync_queue`).get() as { count: number }
  ).count;
}

function sha(char: string): string {
  return char.repeat(64);
}
