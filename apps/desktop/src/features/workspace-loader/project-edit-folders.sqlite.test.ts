import type Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestDb } from '../../main/__tests__/test-db';
import { listProjectEditFolders, projectPathIsReadOnly } from './project-edit-folders';
let db: Database.Database;
const select = vi.fn(async (sql: string) => db.prepare(sql).all());
vi.mock('../../platform', () => ({
  platform: () => ({ db: { select: (sql: string) => select(sql) } }),
}));
beforeEach(() => {
  db = createTestDb();
  db.exec(`CREATE TABLE workspaces (id INTEGER PRIMARY KEY, name TEXT, path TEXT, access_mode TEXT, archived_at INTEGER, trashed_at INTEGER, repo_uuid TEXT, origin_path TEXT);
    CREATE TABLE workspace_sync_restore_locks (workspace_id INTEGER, status TEXT);
    CREATE TABLE workspace_sync_bindings (workspace_id INTEGER, workspace_uuid TEXT, access_role TEXT);`);
  select.mockClear();
});
afterEach(() => db.close());
it('reads role authority with a constant portable query set for shared, legacy-null and private projects without per-project IPC', async () => {
  const insert = db.prepare(
    'INSERT INTO workspaces (id, name, path, repo_uuid) VALUES (?, ?, ?, ?)'
  );
  insert.run(1, 'Shared', '/shared', 'shared-a');
  insert.run(2, 'Legacy', '/legacy', 'legacy-id');
  insert.run(3, 'Private', '/private', 'private-id');
  db.exec(
    "INSERT INTO workspace_sync_bindings VALUES (1, 'shared-a', 'viewer'), (2, 'legacy-id', NULL)"
  );
  const folders = await listProjectEditFolders();
  expect(select).toHaveBeenCalledTimes(3);
  expect(folders.map((folder) => folder.sharedEditAccess)).toEqual([
    { kind: 'ready', role: 'viewer' },
    { kind: 'ready', role: 'owner' },
    { kind: 'ready', role: null },
  ]);
  expect(projectPathIsReadOnly('/shared/package', folders)).toBe(true);
  expect(projectPathIsReadOnly('/legacy/package', folders)).toBe(false);
  expect(projectPathIsReadOnly('/private/package', folders)).toBe(false);
  select.mockClear();
  expect(
    projectPathIsReadOnly(
      '/shared/package',
      await listProjectEditFolders({ includeSharedAccess: false })
    )
  ).toBe(false);
  expect(select).toHaveBeenCalledTimes(2);
});
it('does not use a different binding identity or invalid role to enable editing', async () => {
  db.exec(
    "INSERT INTO workspaces (id, path, repo_uuid) VALUES (1, '/wrong', 'project-a'), (2, '/invalid', 'project-b'); INSERT INTO workspace_sync_bindings VALUES (1, 'different', 'editor'), (2, 'project-b', 'unknown')"
  );
  const folders = await listProjectEditFolders();
  expect(folders.every((folder) => folder.sharedEditAccess?.kind === 'unavailable')).toBe(true);
  expect(projectPathIsReadOnly('/wrong/package', folders)).toBe(true);
  expect(projectPathIsReadOnly('/invalid/package', folders)).toBe(true);
});
