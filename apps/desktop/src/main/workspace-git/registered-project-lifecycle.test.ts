import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import { ensureWorkspaceOwnerInDb } from '../catalog-projection-commands';
import { transitionManagedWorkspaceLifecycle } from './lifecycle';

let db: Database.Database;
let root: string;
let repoPath: string;

beforeEach(() => {
  db = createTestDb();
  ensureSchema(db, ':memory:');
  root = mkdtempSync(join(tmpdir(), 'registered-project-lifecycle-'));
  repoPath = join(root, 'Track views');
  mkdirSync(repoPath);
  writeFileSync(join(repoPath, 'experiment.txt'), 'Keep these scientific results.\n');
  ensureWorkspaceOwnerInDb(db, repoPath, 'writable', { name: 'Track views', recordOpen: true });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

it('archives and trashes a registered project without Git and restores the same owner by path', async () => {
  const before = db.prepare('SELECT * FROM workspaces WHERE path = ?').get(repoPath) as {
    id: number;
    repo_uuid: null;
  };
  expect(before.repo_uuid).toBeNull();
  await expect(
    transitionManagedWorkspaceLifecycle(db, { action: 'archive-by-path', repoPath }, 100)
  ).resolves.toEqual({ changed: 1 });
  expect(db.prepare('SELECT archived_at FROM workspaces WHERE id = ?').get(before.id)).toEqual({
    archived_at: 100,
  });
  await expect(
    transitionManagedWorkspaceLifecycle(db, { action: 'restore-archive-by-path', repoPath })
  ).resolves.toEqual({ changed: 1 });
  await expect(
    transitionManagedWorkspaceLifecycle(db, { action: 'trash-by-path', repoPath }, 200)
  ).resolves.toEqual({ changed: 1 });
  expect(
    db.prepare('SELECT archived_at, trashed_at FROM workspaces WHERE id = ?').get(before.id)
  ).toEqual({
    archived_at: null,
    trashed_at: 200,
  });
  await expect(
    transitionManagedWorkspaceLifecycle(db, { action: 'restore-trash-by-path', repoPath })
  ).resolves.toEqual({ changed: 1 });
  expect(db.prepare('SELECT * FROM workspaces WHERE path = ?').get(repoPath)).toEqual(before);
  expect(readFileSync(join(repoPath, 'experiment.txt'), 'utf8')).toBe(
    'Keep these scientific results.\n'
  );
});

it('does not register an unknown path or attach a repository identity during a lifecycle command', async () => {
  await expect(
    transitionManagedWorkspaceLifecycle(db, {
      action: 'trash-by-path',
      repoPath: join(root, 'unknown'),
    })
  ).resolves.toEqual({ changed: 0 });
  expect(db.prepare('SELECT path, repo_uuid FROM workspaces').all()).toEqual([
    { path: repoPath, repo_uuid: null },
  ]);
});
