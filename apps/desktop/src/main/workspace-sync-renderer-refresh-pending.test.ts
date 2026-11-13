import { userMessage } from '@waypoint/user-messages';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { claimNextWorkspaceSyncJob, enqueueWorkspaceSyncJob } from './workspace-sync-queue';
import { readWorkspaceSyncStatus } from './workspace-sync-status';
import { describeWorkspaceSyncDisplay } from '../features/auth/workspace-sync-display';
import { createFileTestDb, openFileTestDb } from './__tests__/test-db';
import { createTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import {
  markWorkspaceSyncRendererRefreshSucceeded,
  readPendingWorkspaceSyncRendererRefresh,
  recordPendingWorkspaceSyncRendererRefresh,
  recordWorkspaceSyncRendererRefreshFailure,
  workspaceSyncUploadBlockedSql,
} from './workspace-sync-renderer-refresh-pending';

const NOTICE = {
  workspaceUuid: 'workspace-a',
  workspaceRoot: '/managed/workspace-a/repo',
  remoteVersionId: 'remote-version-b',
  changedPaths: ['/managed/workspace-a/repo/design.gb'],
  deletedPaths: ['/managed/workspace-a/repo/old.gb'],
  affectedNotebookIds: ['notebook-a'],
  affectedDesignIds: [],
  deletedDesignIds: [],
};

describe('durable renderer refresh pending state', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    db.prepare(
      `INSERT INTO workspaces (id, name, path, repo_uuid, created_at, last_opened_at)
       VALUES (1, 'Project A', '/managed/workspace-a/repo', 'workspace-a', 1, 1)`
    ).run();
    db.exec(
      `INSERT INTO workspace_sync_bindings (workspace_id, workspace_uuid, owner_account_id, remote_workspace_id, enabled, remote_latest_version_id, last_acked_local_head_sha, created_at, updated_at) VALUES (1, 'workspace-a', 'account-a', 'remote-a', 1, 'remote-version-b', 'head-b', 1, 1)`
    );
  });

  afterEach(() => db.close());

  it('stores pending delivery independently of generic queue error cleanup', () => {
    const id = recordPendingWorkspaceSyncRendererRefresh(db, {
      workspaceId: 1,
      localHeadSha: 'head-b',
      notice: NOTICE,
      nowMs: 100,
    });
    db.exec(`DELETE FROM workspace_sync_queue`);
    expect(readPendingWorkspaceSyncRendererRefresh(db, 1)?.notice).toEqual(NOTICE);
    expect(
      db
        .prepare(
          `SELECT state, last_error_code, payload_json FROM workspace_sync_renderer_deliveries WHERE id = ?`
        )
        .get(id)
    ).toEqual({
      state: 'pending',
      last_error_code: null,
      payload_json: JSON.stringify({ version: 1, notice: NOTICE }),
    });
  });

  it('upgrades the exact legacy replay payload once before queue cleanup', () => {
    const payload = JSON.stringify({ version: 1, notice: NOTICE });
    db.prepare(
      `INSERT INTO workspace_sync_queue (id, workspace_id, operation, status, base_remote_version_id, local_head_sha, error_code, error_message, created_at, updated_at) VALUES ('legacy', 1, 'refresh', 'failed', 'remote-version-b', 'head-b', 'RENDERER_REFRESH_PENDING', ?, 10, 20)`
    ).run(payload);
    db.exec(`DROP TABLE workspace_sync_renderer_deliveries`);
    db.pragma('user_version = 33');
    ensureSchema(db, ':memory:');
    ensureSchema(db, ':memory:');
    expect(
      db.prepare(`SELECT id, payload_json FROM workspace_sync_renderer_deliveries`).all()
    ).toEqual([{ id: 'legacy', payload_json: payload }]);
    expect(db.prepare(`SELECT id FROM workspace_sync_queue`).all()).toEqual([]);
  });

  it('round-trips the exact committed notice and settles only after acknowledgement', () => {
    const jobId = recordPendingWorkspaceSyncRendererRefresh(db, {
      workspaceId: 1,
      localHeadSha: 'head-b',
      notice: NOTICE,
      nowMs: 100,
    });

    expect(readPendingWorkspaceSyncRendererRefresh(db, 1)).toEqual({
      deliveryId: jobId,
      ownerAccountId: 'account-a',
      remoteWorkspaceId: 'remote-a',
      localHeadSha: 'head-b',
      payloadJson: JSON.stringify({ version: 1, notice: NOTICE }),
      workspaceId: 1,
      notice: NOTICE,
    });
    expect(
      db
        .prepare(
          `SELECT state, last_error_code FROM workspace_sync_renderer_deliveries WHERE id = ?`
        )
        .get(jobId)
    ).toEqual({ state: 'pending', last_error_code: null });

    markWorkspaceSyncRendererRefreshSucceeded(db, {
      delivery: readPendingWorkspaceSyncRendererRefresh(db, 1)!,
      nowMs: 200,
    });

    expect(readPendingWorkspaceSyncRendererRefresh(db, 1)).toBeNull();
    expect(
      db
        .prepare(
          `SELECT state, last_error_code FROM workspace_sync_renderer_deliveries WHERE id = ?`
        )
        .get(jobId)
    ).toEqual({ state: 'succeeded', last_error_code: null });
  });

  it('fails closed when the durable payload cannot be parsed', () => {
    const jobId = recordPendingWorkspaceSyncRendererRefresh(db, {
      workspaceId: 1,
      localHeadSha: 'head-b',
      notice: NOTICE,
      nowMs: 100,
    });
    db.prepare(
      `UPDATE workspace_sync_renderer_deliveries SET payload_json = '{not-json' WHERE id = ?`
    ).run(jobId);

    expect(() => readPendingWorkspaceSyncRendererRefresh(db, 1)).toThrow(/unreadable/i);
  });
  it.each([
    null,
    '{not-json',
    JSON.stringify({ version: 2, notice: NOTICE }),
    JSON.stringify({ version: 1, notice: { ...NOTICE, changedPaths: ['/outside'] } }),
  ])('retains malformed legacy instructions across repeated upgrades: %s', (payload) => {
    db.prepare(
      `INSERT INTO workspace_sync_queue (id, workspace_id, operation, status, error_code, error_message, created_at, updated_at) VALUES ('legacy', 1, 'refresh', 'failed', 'RENDERER_REFRESH_PENDING', ?, 10, 20)`
    ).run(payload);
    ensureSchema(db, ':memory:');
    ensureSchema(db, ':memory:');
    db.exec(`DELETE FROM workspace_sync_queue`);
    expect(
      db.prepare(`SELECT payload_json, state FROM workspace_sync_renderer_deliveries`).all()
    ).toEqual([{ payload_json: payload, state: 'needs_attention' }]);
    expect(blocked()).toBe(true);
    expect(() => readPendingWorkspaceSyncRendererRefresh(db, 1)).toThrow();
  });

  it('rolls the accepted binding and delivery back together if the apply transaction fails', () => {
    expect(() =>
      db.transaction(() => {
        db.exec(`UPDATE workspace_sync_bindings SET remote_latest_version_id = 'remote-version-c'`);
        recordPendingWorkspaceSyncRendererRefresh(db, {
          workspaceId: 1,
          localHeadSha: 'head-b',
          notice: { ...NOTICE, remoteVersionId: 'remote-version-c' },
          nowMs: 100,
        });
        throw new Error('injected commit failure');
      })()
    ).toThrow('injected commit failure');
    expect(
      db.prepare(`SELECT remote_latest_version_id FROM workspace_sync_bindings`).get()
    ).toEqual({ remote_latest_version_id: 'remote-version-b' });
    expect(readPendingWorkspaceSyncRendererRefresh(db, 1)).toBeNull();
  });

  it.each([
    'owner_account_id',
    'remote_workspace_id',
    'remote_latest_version_id',
    'last_acked_local_head_sha',
  ])('rejects an acknowledgement after the binding %s changes', (column) => {
    record();
    const delivery = readPendingWorkspaceSyncRendererRefresh(db, 1)!;
    db.exec(`UPDATE workspace_sync_bindings SET ${column} = 'different'`);
    expect(() => markWorkspaceSyncRendererRefreshSucceeded(db, { delivery, nowMs: 200 })).toThrow(
      /binding/
    );
    expect(blocked()).toBe(true);
  });

  it('rejects wrong workspace, altered payload, and stale acknowledgement identities', () => {
    record();
    const delivery = readPendingWorkspaceSyncRendererRefresh(db, 1)!;
    for (const altered of [
      { ...delivery, workspaceId: 2 },
      { ...delivery, payloadJson: '{}' },
      { ...delivery, notice: { ...NOTICE, remoteVersionId: 'wrong' } },
    ]) {
      expect(() =>
        markWorkspaceSyncRendererRefreshSucceeded(db, { delivery: altered, nowMs: 200 })
      ).toThrow(/acknowledgement/);
      expect(blocked()).toBe(true);
    }
  });

  it('keeps diagnostics separate, permits repeated acknowledgement, and never reopens completed delivery', () => {
    const id = record();
    const delivery = readPendingWorkspaceSyncRendererRefresh(db, 1)!;
    recordWorkspaceSyncRendererRefreshFailure(db, {
      workspaceId: 1,
      deliveryId: id,
      error: new Error('renderer unavailable'),
      nowMs: 150,
    });
    expect(readPendingWorkspaceSyncRendererRefresh(db, 1)).toEqual(delivery);
    markWorkspaceSyncRendererRefreshSucceeded(db, { delivery, nowMs: 200 });
    markWorkspaceSyncRendererRefreshSucceeded(db, { delivery, nowMs: 210 });
    expect(record()).toBe(id);
    expect(readPendingWorkspaceSyncRendererRefresh(db, 1)).toBeNull();
    expect(blocked()).toBe(false);
  });

  it('shows pending screen work separately from a delivery error through the real status/display boundary', () => {
    record();
    const statusInput = {
      workspaceUuid: 'workspace-a',
      getActiveAccountId: () => 'account-a',
      getCurrentLocalHeadSha: () => 'head-b',
      getExcludedSummary: () => ({}),
    };
    const pending = readWorkspaceSyncStatus(db, statusInput);
    expect(pending).toMatchObject({
      syncAxis: 'refreshing',
      terminalErrorCode: null,
      terminalErrorMessage: null,
      canDisplayPlainSynced: false,
    });
    expect(describeWorkspaceSyncDisplay({ signedIn: true, status: pending })).toMatchObject({
      label: 'Refreshing desktop',
      canForceSync: false,
      canDeleteCloudCopy: false,
    });
    recordWorkspaceSyncRendererRefreshFailure(db, {
      workspaceId: 1,
      error: new Error('renderer unavailable'),
      nowMs: 150,
    });
    expect(readWorkspaceSyncStatus(db, statusInput)).toMatchObject({
      syncAxis: 'terminal_error',
      terminalErrorMessage: 'renderer unavailable',
    });
    expect(
      describeWorkspaceSyncDisplay({
        signedIn: true,
        status: readWorkspaceSyncStatus(db, statusInput),
      })
    ).toMatchObject({
      label: 'Desktop refresh needs attention',
      detail: userMessage('copy.incoming-changes-are-saved-the-desktop-must-finish-refreshing-bef'),
      canForceSync: false,
      canCopyShareLink: false,
      canDeleteCloudCopy: false,
    });
    db.exec(`DELETE FROM workspace_sync_queue`);
    expect(readWorkspaceSyncStatus(db, statusInput).canDisplayPlainSynced).toBe(false);
    const delivery = readPendingWorkspaceSyncRendererRefresh(db, 1)!;
    markWorkspaceSyncRendererRefreshSucceeded(db, { delivery, nowMs: 200 });
    expect(readWorkspaceSyncStatus(db, statusInput).canDisplayPlainSynced).toBe(true);
  });

  it('blocks every queue claim for the affected workspace while another account-matching workspace proceeds', () => {
    record();
    db.exec(`INSERT INTO workspaces (id, name, path, repo_uuid, created_at) VALUES (2, 'B', '/managed/b', 'workspace-b', 1);
      INSERT INTO workspace_sync_bindings (workspace_id, workspace_uuid, owner_account_id, remote_workspace_id, enabled, created_at, updated_at)
      VALUES (2, 'workspace-b', 'account-a', 'remote-b', 1, 1, 1)`);
    enqueueWorkspaceSyncJob(db, { id: 'upload-a', workspaceId: 1, operation: 'upload', nowMs: 1 });
    enqueueWorkspaceSyncJob(db, { id: 'upload-b', workspaceId: 2, operation: 'upload', nowMs: 2 });
    db.exec(
      `INSERT INTO workspace_sync_device (id, device_id, created_at, updated_at) VALUES (1, 'device-a', 1, 1)`
    );
    const claim = { activeAccountId: 'account-a', deviceId: 'device-a', nowMs: 300 };
    expect(claimNextWorkspaceSyncJob(db, { ...claim, jobId: 'upload-a' })).toBeNull();
    expect(
      claimNextWorkspaceSyncJob(db, { ...claim, activeAccountId: 'another-account' })
    ).toBeNull();
    expect(claimNextWorkspaceSyncJob(db, claim)?.id).toBe('upload-b');
    markWorkspaceSyncRendererRefreshSucceeded(db, {
      delivery: readPendingWorkspaceSyncRendererRefresh(db, 1)!,
      nowMs: 400,
    });
    expect(claimNextWorkspaceSyncJob(db, { ...claim, jobId: 'upload-a' })?.id).toBe('upload-a');
  });

  it('retains a committed delivery across a real database close and reopen', () => {
    const file = createFileTestDb('renderer-delivery');
    let reopened: Database.Database | undefined;
    try {
      ensureSchema(file.db, file.dbPath);
      file.db
        .exec(`INSERT INTO workspaces (id, name, path, repo_uuid, created_at) VALUES (1, 'A', '/managed/workspace-a/repo', 'workspace-a', 1);
        INSERT INTO workspace_sync_bindings (workspace_id, workspace_uuid, owner_account_id, remote_workspace_id, enabled, remote_latest_version_id, last_acked_local_head_sha, created_at, updated_at)
        VALUES (1, 'workspace-a', 'account-a', 'remote-a', 1, 'remote-version-b', 'head-b', 1, 1)`);
      recordPendingWorkspaceSyncRendererRefresh(file.db, {
        workspaceId: 1,
        localHeadSha: 'head-b',
        notice: NOTICE,
        nowMs: 100,
      });
      const before = readPendingWorkspaceSyncRendererRefresh(file.db, 1)!;
      file.db.close();
      reopened = openFileTestDb(file.dbPath);
      ensureSchema(reopened, file.dbPath);
      expect(readPendingWorkspaceSyncRendererRefresh(reopened, 1)).toEqual(before);
      markWorkspaceSyncRendererRefreshSucceeded(reopened, { delivery: before, nowMs: 200 });
      expect(readPendingWorkspaceSyncRendererRefresh(reopened, 1)).toBeNull();
    } finally {
      reopened?.close();
      file.cleanup();
    }
  });

  function record() {
    return recordPendingWorkspaceSyncRendererRefresh(db, {
      workspaceId: 1,
      localHeadSha: 'head-b',
      notice: NOTICE,
      nowMs: 100,
    });
  }
  function blocked() {
    return Boolean(
      (
        db
          .prepare(
            `SELECT ${workspaceSyncUploadBlockedSql('b.workspace_id')} AS blocked FROM workspace_sync_bindings b WHERE b.workspace_id = 1`
          )
          .get() as { blocked: number }
      ).blocked
    );
  }
});
