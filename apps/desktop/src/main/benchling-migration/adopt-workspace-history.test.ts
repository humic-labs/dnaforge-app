import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../__tests__/test-db';
import { acquireWorkspaceSyncMutationLease } from '../workspace-sync-mutation-lease';
import { commitAllIfDirty, initManagedRepo } from '../workspace-git';
import { MigrationStore } from './store';
import {
  acquireEligibleMigrationWorkspace,
  adoptWorkspaceHistory,
  isVisibleMigrationHistoryRun,
} from './adopt-workspace-history';

describe('adopt workspace history', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture(repoUuid: string | null = null) {
    const workspacePath = await mkdtemp(join(tmpdir(), 'dnaforge-adopt-workspace-'));
    roots.push(workspacePath);
    const db = createTestDb();
    db.exec(`
      CREATE TABLE workspaces (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        repo_uuid TEXT,
        archived_at INTEGER,
        trashed_at INTEGER
      )
    `);
    db.prepare(
      'INSERT INTO workspaces (id, name, path, repo_uuid, archived_at, trashed_at) VALUES (1, ?, ?, ?, NULL, NULL)'
    ).run('Caspian', workspacePath, repoUuid);
    return { db, workspacePath };
  }

  it('creates one silent adopted owner in an ordinary non-Git workspace', async () => {
    const { db, workspacePath } = await fixture(null);
    const acquired = await acquireEligibleMigrationWorkspace(db, 1);
    expect(acquired.binding).toMatchObject({
      workspaceDbId: 1,
      repoUuid: null,
      projectionScopeId: 'ws1',
      workspacePath,
      durability: { kind: 'local_filesystem' },
    });
    const migrationDb = createTestDb();
    const migrationStore = new MigrationStore(migrationDb);
    const openStore = () => migrationStore;

    const first = await adoptWorkspaceHistory({
      binding: acquired.binding,
      now: () => '2026-08-29T20:00:00.000Z',
      openStore,
    });
    const second = await adoptWorkspaceHistory({
      binding: acquired.binding,
      now: () => '2026-08-29T21:00:00.000Z',
      openStore,
    });
    acquired.release();

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      state: 'unlocked',
      workspaceDbId: 1,
      repoUuid: null,
      projectionScopeId: 'ws1',
      workspaceOrigin: { kind: 'adopted_existing', workspaceDbId: 1 },
      baseline: {
        kind: 'adopted_workspace',
        adoptedAt: '2026-08-29T20:00:00.000Z',
        existingManifestSha256: null,
      },
    });
    expect(isVisibleMigrationHistoryRun(first)).toBe(false);

    expect(migrationStore.getRun()).toEqual(first);
    const rebuiltDb = createTestDb();
    const rebuiltStore = new MigrationStore(rebuiltDb);
    const rebuilt = await adoptWorkspaceHistory({
      binding: acquired.binding,
      now: () => '2026-08-29T20:00:00.000Z',
      openStore: () => rebuiltStore,
    });
    expect(rebuilt.projectionScopeId).toBe(first.projectionScopeId);
    expect(rebuilt.id).not.toBe(first.id);
    rebuiltStore.close();
    rebuiltDb.close();
    migrationStore.close();
    migrationDb.close();
    db.close();
  });

  it('fails fast while sync owns the canonical workspace root', async () => {
    const { db, workspacePath } = await fixture();
    const releaseSync = await acquireWorkspaceSyncMutationLease(workspacePath);
    await expect(acquireEligibleMigrationWorkspace(db, 1)).rejects.toThrow('workspace_busy');
    releaseSync();
    db.close();
  });

  it('keeps a null repository identity for a valid managed Git workspace', async () => {
    const { db, workspacePath } = await fixture(null);
    await initManagedRepo(workspacePath);
    await writeFile(join(workspacePath, 'existing.gb'), 'LOCUS       existing\nORIGIN\n//\n');
    const headCommit = await commitAllIfDirty(workspacePath, 'Initialize existing workspace');

    const acquired = await acquireEligibleMigrationWorkspace(db, 1);
    expect(acquired.binding).toEqual({
      workspaceDbId: 1,
      repoUuid: null,
      projectionScopeId: 'ws1',
      workspacePath,
      displayName: 'Caspian',
      durability: { kind: 'managed_git', headCommit },
    });

    const migrationDb = createTestDb();
    const migrationStore = new MigrationStore(migrationDb);
    const run = await adoptWorkspaceHistory({
      binding: acquired.binding,
      now: () => '2026-08-29T20:00:00.000Z',
      openStore: () => migrationStore,
    });
    acquired.release();

    expect(run.repoUuid).toBeNull();
    expect(run.projectionScopeId).toBe('ws1');
    migrationStore.close();
    migrationDb.close();
    db.close();
  });

  it('rejects a stale row whose directory disappeared', async () => {
    const { db, workspacePath } = await fixture();
    await rm(workspacePath, { recursive: true, force: true });
    await mkdir(join(workspacePath, '..'), { recursive: true });
    await expect(acquireEligibleMigrationWorkspace(db, 1)).rejects.toThrow('workspace_unavailable');
    db.close();
  });
});
