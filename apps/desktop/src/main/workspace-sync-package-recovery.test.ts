import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { createTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import {
  createPackageScratchRecoveryCallbacks,
  WORKSPACE_SYNC_PACKAGE_RECOVERY_REQUIRED_CODE,
} from './workspace-sync-package-recovery';

describe('package scratch recovery quarantine', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    db.prepare(
      `INSERT INTO workspaces (id, name, path, repo_uuid, created_at, last_opened_at)
       VALUES (1, 'Project A', '/managed/workspace-a', 'workspace-a', 1, 1)`
    ).run();
    db.prepare(
      `INSERT INTO workspace_sync_bindings (
         workspace_id, workspace_uuid, owner_account_id, remote_workspace_id,
         enabled, created_at, updated_at
       ) VALUES (1, 'workspace-a', 'account-a', '11111111-1111-4111-8111-111111111111', 1, 1, 1)`
    ).run();
  });

  it('survives restart-shaped callback recreation and clears only after a coherent retry', async () => {
    let nowMs = 100;
    const first = createPackageScratchRecoveryCallbacks(
      db,
      '/managed/workspace-a',
      '/managed/workspace-a/pUC19',
      () => nowMs
    );
    await first?.markRequired('interrupted package replacement');

    expect(db.prepare(`SELECT status, error_code FROM workspace_sync_queue LIMIT 1`).get()).toEqual(
      { status: 'failed', error_code: WORKSPACE_SYNC_PACKAGE_RECOVERY_REQUIRED_CODE }
    );

    nowMs = 200;
    const afterRestart = createPackageScratchRecoveryCallbacks(
      db,
      '/managed/workspace-a',
      '/managed/workspace-a/pUC19',
      () => nowMs
    );
    await afterRestart?.clear();

    expect(
      db.prepare(`SELECT status, error_code, updated_at FROM workspace_sync_queue LIMIT 1`).get()
    ).toEqual({ status: 'succeeded', error_code: null, updated_at: 200 });
  });
});
