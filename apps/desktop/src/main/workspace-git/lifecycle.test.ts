import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import { acquireWorkspaceMutationShared } from '../workspace-sync-mutation-lease';
import { MAX_MANAGED_WORKSPACE_NAME_LENGTH } from '../../shared/workspace-git-types';
import { renameManagedWorkspace, transitionManagedWorkspaceLifecycle } from './lifecycle';

describe('managed workspace lifecycle transitions', () => {
  let db: Database.Database;
  let root: string;
  let repoPath: string;

  beforeEach(() => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    root = mkdtempSync(join(tmpdir(), 'workspace-lifecycle-'));
    repoPath = join(root, 'workspace-a');
    mkdirSync(repoPath);
    db.prepare(
      `INSERT INTO workspaces (id, name, path, repo_uuid, created_at, last_opened_at)
       VALUES (1, 'Workspace A', ?, 'workspace-a', 1, 1)`
    ).run(repoPath);
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it.each(['database', 'file', 'nested'] as const)(
    'refuses project Trash while its %s entity stays addressable and still permits archive and restore',
    async (kind) => {
      if (kind === 'database')
        db.prepare(
          "INSERT INTO primers(id,name,sequence,length,workspace_id,created_at,updated_at) VALUES('retained','Retained','A',1,1,1,1)"
        ).run();
      if (kind === 'file') {
        writeFileSync(join(repoPath, 'arbitrary.log'), 'saved');
        db.prepare(
          "INSERT INTO catalog_entities(id,type,name,locator,storage_type,status,workspace_id,created_at,updated_at) VALUES('registered','file','Raw',?,'file','active',1,1,1)"
        ).run('file://' + join(repoPath, 'arbitrary.log'));
      }
      if (kind === 'nested') {
        const nested = join(repoPath, 'Ordinary', 'Child', '.forge');
        mkdirSync(nested, { recursive: true });
        writeFileSync(join(nested, 'notebook.json'), 'saved');
      }
      await expect(
        transitionManagedWorkspaceLifecycle(db, { action: 'trash-by-path', repoPath })
      ).rejects.toThrow('SAVED_ENTITY_CONTENT');
      expect(lifecycleRow(db)).toEqual({ archived_at: null, trashed_at: null });
      await expect(
        transitionManagedWorkspaceLifecycle(db, { action: 'archive-by-path', repoPath })
      ).resolves.toEqual({ changed: 1 });
      await expect(
        transitionManagedWorkspaceLifecycle(db, { action: 'trash-by-path', repoPath })
      ).rejects.toThrow('SAVED_ENTITY_CONTENT');
      await expect(
        transitionManagedWorkspaceLifecycle(db, { action: 'restore-archive-by-path', repoPath })
      ).resolves.toEqual({ changed: 1 });
      if (kind === 'file')
        expect(readFileSync(join(repoPath, 'arbitrary.log'), 'utf8')).toBe('saved');
    }
  );

  it('owns archive, trash, and restore state changes in main', async () => {
    await expect(
      transitionManagedWorkspaceLifecycle(db, { action: 'archive-by-path', repoPath }, 100)
    ).resolves.toEqual({ changed: 1 });
    expect(lifecycleRow(db)).toEqual({ archived_at: 100, trashed_at: null });

    await expect(
      transitionManagedWorkspaceLifecycle(db, { action: 'trash-by-path', repoPath }, 200)
    ).resolves.toEqual({ changed: 1 });
    expect(lifecycleRow(db)).toEqual({ archived_at: null, trashed_at: 200 });

    await expect(
      transitionManagedWorkspaceLifecycle(db, {
        action: 'restore-trash-by-uuid',
        repoUuid: 'workspace-a',
      })
    ).resolves.toEqual({ changed: 1 });
    expect(lifecycleRow(db)).toEqual({ archived_at: null, trashed_at: null });

    await transitionManagedWorkspaceLifecycle(
      db,
      { action: 'archive-by-uuid', repoUuid: 'workspace-a' },
      300
    );
    await expect(
      transitionManagedWorkspaceLifecycle(db, {
        action: 'restore-archive-by-uuid',
        repoUuid: 'workspace-a',
      })
    ).resolves.toEqual({ changed: 1 });
    expect(lifecycleRow(db)).toEqual({ archived_at: null, trashed_at: null });
  });

  it('archives registered local roots and refuses unknown and archive-while-trashed requests', async () => {
    db.prepare(
      `INSERT INTO workspaces (id, name, path, created_at, last_opened_at)
       VALUES (2, 'External', '/external/workspace', 1, 1)`
    ).run();

    await expect(
      transitionManagedWorkspaceLifecycle(db, {
        action: 'archive-by-uuid',
        repoUuid: 'missing',
      })
    ).resolves.toEqual({ changed: 0 });
    await expect(
      transitionManagedWorkspaceLifecycle(db, {
        action: 'archive-by-path',
        repoPath: '/external/workspace',
      })
    ).resolves.toEqual({ changed: 1 });

    await transitionManagedWorkspaceLifecycle(db, { action: 'trash-by-path', repoPath }, 200);
    await expect(
      transitionManagedWorkspaceLifecycle(db, { action: 'archive-by-path', repoPath }, 300)
    ).resolves.toEqual({ changed: 0 });
    expect(lifecycleRow(db)).toEqual({ archived_at: null, trashed_at: 200 });
  });

  it('renames a managed workspace and leaves its path alone', async () => {
    await expect(
      renameManagedWorkspace(db, { repoPath, name: '  Lab Notebook  ' })
    ).resolves.toEqual({ changed: 1 });
    expect(db.prepare(`SELECT name, path FROM workspaces WHERE id = 1`).get()).toEqual({
      name: 'Lab Notebook',
      path: repoPath,
    });
  });

  it('refuses empty, oversized, non-managed, and trashed renames', async () => {
    await expect(renameManagedWorkspace(db, { repoPath, name: '   ' })).rejects.toThrow(/empty/);
    await expect(
      renameManagedWorkspace(db, {
        repoPath,
        name: 'x'.repeat(MAX_MANAGED_WORKSPACE_NAME_LENGTH + 1),
      })
    ).rejects.toThrow(/longer/);

    db.prepare(
      `INSERT INTO workspaces (id, name, path, created_at, last_opened_at)
       VALUES (2, 'External', '/external/workspace', 1, 1)`
    ).run();
    await expect(
      renameManagedWorkspace(db, { repoPath: '/external/workspace', name: 'Renamed' })
    ).resolves.toEqual({ changed: 0 });

    await transitionManagedWorkspaceLifecycle(db, { action: 'trash-by-path', repoPath }, 200);
    await expect(renameManagedWorkspace(db, { repoPath, name: 'Renamed' })).resolves.toEqual({
      changed: 0,
    });
    expect(db.prepare(`SELECT name FROM workspaces WHERE id = 1`).get()).toEqual({
      name: 'Workspace A',
    });
  });

  it('waits for an in-flight workspace mutation before changing lifecycle state', async () => {
    const releaseMutation = await acquireWorkspaceMutationShared(repoPath);
    let settled = false;
    const transition = transitionManagedWorkspaceLifecycle(
      db,
      { action: 'archive-by-uuid', repoUuid: 'workspace-a' },
      100
    ).then((result) => {
      settled = true;
      return result;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(lifecycleRow(db)).toEqual({ archived_at: null, trashed_at: null });

    releaseMutation();
    await expect(transition).resolves.toEqual({ changed: 1 });
    expect(lifecycleRow(db)).toEqual({ archived_at: 100, trashed_at: null });
  });
});

function lifecycleRow(db: Database.Database): {
  archived_at: number | null;
  trashed_at: number | null;
} {
  return db.prepare(`SELECT archived_at, trashed_at FROM workspaces WHERE id = 1`).get() as {
    archived_at: number | null;
    trashed_at: number | null;
  };
}
