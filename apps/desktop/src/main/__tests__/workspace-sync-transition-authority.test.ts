import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '1.0.0') },
  dialog: { showErrorBox: vi.fn() },
}));

import { createFileTestDb } from './test-db';
import { ensureSchema } from '../schema';
import {
  acknowledgeWorkspaceSyncUpload,
  cancelResolvedWorkspaceSyncConflicts,
  claimNextWorkspaceSyncJob,
  enqueueWorkspaceSyncJob,
  getWorkspaceSyncQueueJob,
  markWorkspaceSyncJobFailed,
} from '../workspace-sync-queue';

describe('workspace sync transition authority', () => {
  let file: ReturnType<typeof createFileTestDb>;

  beforeEach(() => {
    file = createFileTestDb('sync-authority');
    ensureSchema(file.db, file.dbPath);
    file.db
      .prepare(
        `INSERT INTO workspace_sync_device (id, device_id, created_at, updated_at) VALUES (1, 'device', 1, 1)`
      )
      .run();
    file.db
      .prepare(
        `INSERT INTO workspaces (id, name, path, created_at) VALUES (1, 'Fixture', '/tmp/sync-authority', 1)`
      )
      .run();
    file.db
      .prepare(
        `INSERT INTO workspace_sync_bindings (workspace_id, workspace_uuid, owner_account_id, enabled, created_at, updated_at) VALUES (1, 'workspace', 'account', 1, 1, 1)`
      )
      .run();
  });

  afterEach(() => file.cleanup());

  function claim() {
    enqueueWorkspaceSyncJob(file.db, {
      id: 'upload',
      workspaceId: 1,
      operation: 'upload',
      nowMs: 1,
    });
    const job = claimNextWorkspaceSyncJob(file.db, {
      activeAccountId: 'account',
      deviceId: 'device',
      nowMs: 100,
    });
    if (!job) throw new Error('Expected an upload lease.');
    return job;
  }

  it('keeps runtime queue updates inside the queue command owner', () => {
    const main = join(__dirname, '..');
    function sources(directory: string): string[] {
      return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        if (entry.name === '__tests__' || entry.name === '__fixtures__') return [];
        const path = join(directory, entry.name);
        return entry.isDirectory()
          ? sources(path)
          : entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
            ? [path]
            : [];
      });
    }
    const otherWriters = sources(main).filter(
      (path) =>
        path !== join(main, 'workspace-sync-queue.ts') &&
        /UPDATE\s+workspace_sync_queue\b/i.test(readFileSync(path, 'utf8'))
    );
    expect(otherWriters.map((path) => relative(main, path))).toEqual([]);
  });

  it.each([
    { label: 'device', deviceId: 'other-device' },
    { label: 'lease clock', lockedAt: 99 },
    { label: 'attempt', attemptCount: 2 },
    { label: 'accepted operation', acceptedOperationId: 'superseded' },
  ])('refuses acknowledgement with a stale $label', (stale) => {
    const job = claim();
    expect(() =>
      acknowledgeWorkspaceSyncUpload(file.db, {
        job: { ...job, ...stale },
        deviceId: stale.deviceId ?? 'device',
        nowMs: 200,
      })
    ).toThrow('lease changed');
    expect(getWorkspaceSyncQueueJob(file.db, job.id)).toEqual(job);
  });

  it('rolls back acknowledgement with its caller transaction', () => {
    const job = claim();
    const binding = file.db.prepare('SELECT * FROM workspace_sync_bindings').get();
    expect(() =>
      file.db.transaction(() => {
        acknowledgeWorkspaceSyncUpload(file.db, { job, deviceId: 'device', nowMs: 200 });
        file.db.prepare('UPDATE workspace_sync_bindings SET enabled = 0').run();
        throw new Error('Controlled caller rollback');
      })()
    ).toThrow('Controlled caller rollback');
    expect(getWorkspaceSyncQueueJob(file.db, job.id)).toEqual(job);
    expect(file.db.prepare('SELECT * FROM workspace_sync_bindings').get()).toEqual(binding);
  });

  it('refuses acknowledgement after the claimed job has failed', () => {
    const job = claim();
    const failed = markWorkspaceSyncJobFailed(file.db, {
      id: job.id,
      nowMs: 150,
      retryable: false,
      retryDelayMs: 0,
      maxAttempts: 1,
      errorCode: 'CONFLICT',
      errorMessage: 'Changed remote',
    });
    expect(() =>
      acknowledgeWorkspaceSyncUpload(file.db, { job, deviceId: 'device', nowMs: 200 })
    ).toThrow('lease changed');
    expect(getWorkspaceSyncQueueJob(file.db, job.id)).toEqual(failed);
  });

  it('refuses a changed conflict snapshot without committing earlier cancellations', () => {
    for (const id of ['first', 'second']) {
      enqueueWorkspaceSyncJob(file.db, { id, workspaceId: 1, operation: 'refresh', nowMs: 1 });
      markWorkspaceSyncJobFailed(file.db, {
        id,
        nowMs: 2,
        retryable: false,
        retryDelayMs: 0,
        maxAttempts: 1,
        errorCode: 'CONFLICT',
        errorMessage: 'Current conflict',
      });
    }
    const before = file.db.prepare('SELECT * FROM workspace_sync_queue ORDER BY id').all();
    expect(() =>
      file.db.transaction(() =>
        cancelResolvedWorkspaceSyncConflicts(
          file.db,
          [
            { id: 'first', error_code: 'CONFLICT', error_message: 'Current conflict' },
            { id: 'second', error_code: 'CONFLICT', error_message: 'Stale conflict' },
          ],
          'CONFLICT_RESOLVED_KEEP_LOCAL',
          200
        )
      )()
    ).toThrow('pending sync conflict changed');
    expect(file.db.prepare('SELECT * FROM workspace_sync_queue ORDER BY id').all()).toEqual(before);
  });
});
