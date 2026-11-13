import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { createTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import {
  WORKSPACE_SYNC_ACCESS_REMOVED_CODE,
  isAccessRemovedError,
  markWorkspaceSyncAccessRemoved,
  readWorkspaceSyncAccessBinding,
  updateWorkspaceSyncAccessRecord,
} from './workspace-sync-access-record';
import { enqueueWorkspaceSyncJob } from './workspace-sync-queue';

function clientError(code: string): Error {
  return Object.assign(new Error(code), { name: 'DesktopSyncClientError', code });
}

describe('workspace sync access ', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    db.prepare(
      `INSERT INTO workspaces (id, name, path, repo_uuid, created_at, last_opened_at)
       VALUES (1, 'Shared A', '/managed/workspace-a/repo', 'workspace-a', 1, 1)`
    ).run();
    db.prepare(
      `INSERT INTO workspace_sync_bindings (
         workspace_id, workspace_uuid, owner_account_id, remote_owner_account_id, remote_workspace_id,
         enabled, access_role, access_source, shared_with_others, created_at, updated_at
       ) VALUES (1, 'workspace-a', 'account-me', 'account-owner', 'remote-a', 1, 'editor', 'direct', 1, 1, 1)`
    ).run();
  });

  it('reads the binding with its access record', () => {
    expect(readWorkspaceSyncAccessBinding(db, 'workspace-a')).toMatchObject({
      workspace_id: 1,
      owner_account_id: 'account-me',
      remote_workspace_id: 'remote-a',
      enabled: 1,
      access_role: 'editor',
      access_source: 'direct',
      shared_with_others: 1,
      detached_reason: null,
    });
    expect(readWorkspaceSyncAccessBinding(db, 'missing')).toBeNull();
  });

  it('recognizes only a server refusal as access removal', () => {
    expect(isAccessRemovedError(clientError('FORBIDDEN'))).toBe(true);
    expect(isAccessRemovedError(clientError('NOT_FOUND'))).toBe(true);
    expect(isAccessRemovedError(clientError('NETWORK'))).toBe(false);
    expect(isAccessRemovedError(clientError('CONFLICT'))).toBe(false);
    expect(isAccessRemovedError(new Error('FORBIDDEN'))).toBe(false);
  });

  it('detaches the binding once, keeps the row, and parks unsent uploads', () => {
    enqueueWorkspaceSyncJob(db, {
      id: 'job-upload',
      workspaceId: 1,
      operation: 'upload',
      localHeadSha: 'head-b',
      nowMs: 10,
    });

    expect(markWorkspaceSyncAccessRemoved(db, { workspaceId: 1, nowMs: 20 })).toBe(true);
    expect(readWorkspaceSyncAccessBinding(db, 'workspace-a')).toMatchObject({
      enabled: 0,
      detached_reason: 'access_removed',
      access_role: 'editor',
    });
    const job = db
      .prepare(
        `SELECT status, error_code, error_message, next_attempt_at, locked_by_device_id
         FROM workspace_sync_queue WHERE id = ?`
      )
      .get('job-upload') as {
      status: string;
      error_code: string | null;
      error_message: string | null;
      next_attempt_at: number | null;
      locked_by_device_id: string | null;
    };
    expect(job.status).toBe('blocked');
    expect(job.error_code).toBe(WORKSPACE_SYNC_ACCESS_REMOVED_CODE);
    expect(job.error_message).toContain('kept on this computer');
    expect(job.next_attempt_at).toBeNull();
    expect(job.locked_by_device_id).toBeNull();

    expect(markWorkspaceSyncAccessRemoved(db, { workspaceId: 1, nowMs: 30 })).toBe(false);
  });

  it('records the role the server last reported and reports whether anything changed', () => {
    expect(
      updateWorkspaceSyncAccessRecord(db, {
        workspaceId: 1,
        role: 'editor',
        source: 'direct',
        nowMs: 40,
      })
    ).toBe(false);
    expect(
      updateWorkspaceSyncAccessRecord(db, {
        workspaceId: 1,
        role: 'viewer',
        source: 'org_audience',
        sharedWithOthers: false,
        nowMs: 41,
      })
    ).toBe(true);
    expect(readWorkspaceSyncAccessBinding(db, 'workspace-a')).toMatchObject({
      access_role: 'viewer',
      access_source: 'org_audience',
      shared_with_others: 0,
    });
  });
});
