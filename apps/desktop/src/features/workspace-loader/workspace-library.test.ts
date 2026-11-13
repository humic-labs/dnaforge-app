import { beforeEach, describe, expect, it } from 'vitest';
import { clearMockData } from '../../test/platform-mocks';
import { initializeTestSchema } from '../../test/initializeTestSchema';
import { platform } from '../../platform';
import {
  archiveWorkspace,
  archiveWorkspaceByPath,
  listWorkspaceLibrary,
  renameWorkspaceByPath,
  restoreWorkspace,
  trashWorkspaceByPath,
  restoreFromTrash,
  trashDaysRemaining,
  TRASH_RETENTION_MS,
} from './workspace-library';

async function seedManagedWorkspace(uuid: string, name: string, lastOpened: number): Promise<void> {
  await platform().db.execute(
    `INSERT INTO workspaces (name, path, repo_uuid, origin_path, created_at, last_opened_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [name, `/managed/${uuid}/repo`, uuid, `/Users/me/${name}`, 1, lastOpened]
  );
}

describe('workspace library', () => {
  beforeEach(async () => {
    clearMockData();
    await initializeTestSchema();
  });

  it('lists registered writable projects newest-opened first regardless of Git tracking', async () => {
    await seedManagedWorkspace('uuid-a', 'lab-a', 100);
    await seedManagedWorkspace('uuid-b', 'lab-b', 200);
    await platform().db.execute(
      `INSERT INTO workspaces (name, path, created_at, last_opened_at) VALUES (?, ?, ?, ?)`,
      ['legacy', '/Users/me/legacy', 1, 300]
    );

    const { active, archived } = await listWorkspaceLibrary();
    expect(archived).toHaveLength(0);
    expect(active.map((w) => w.name)).toEqual(['legacy', 'lab-b', 'lab-a']);
    expect(active[1]).toMatchObject({
      repoUuid: 'uuid-b',
      repoPath: '/managed/uuid-b/repo',
      originPath: '/Users/me/lab-b',
    });
  });

  it('retains reference access when exposing active projects for startup restoration', async () => {
    await seedManagedWorkspace('reference', 'Reference project', 100);
    await platform().db.execute('UPDATE workspaces SET access_mode = ? WHERE repo_uuid = ?', [
      'reference',
      'reference',
    ]);
    expect((await listWorkspaceLibrary()).active[0]).toMatchObject({ access: 'reference' });
  });

  it('normalizes Unix-second timestamps before sorting and exposing library rows', async () => {
    await platform().db.execute(
      `INSERT INTO workspaces
         (name, path, repo_uuid, origin_path, created_at, last_opened_at, archived_at, trashed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'seconds',
        '/managed/uuid-seconds/repo',
        'uuid-seconds',
        '/Users/me/seconds',
        1_785_000_000,
        1_787_000_000,
        1_786_000_000,
        null,
      ]
    );
    await platform().db.execute(
      `INSERT INTO workspaces
         (name, path, repo_uuid, origin_path, created_at, last_opened_at, archived_at, trashed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'seconds-trash',
        '/managed/uuid-seconds-trash/repo',
        'uuid-seconds-trash',
        '/Users/me/seconds-trash',
        1_785_000_000,
        1_787_000_000,
        null,
        1_786_000_000,
      ]
    );
    await seedManagedWorkspace('uuid-ms', 'milliseconds', 1_786_000_000_000);

    const { active, archived, trashed } = await listWorkspaceLibrary();

    expect(active.map((workspace) => workspace.repoUuid)).toEqual(['uuid-ms']);
    expect(archived[0].lastOpenedAt).toBe(1_787_000_000_000);
    expect(trashed[0].trashedAt).toBe(1_786_000_000_000);
    const [stored, storedTrash] = await platform().db.select<
      Array<{
        repo_uuid: string;
        created_at: number;
        last_opened_at: number;
        archived_at: number;
        trashed_at: number | null;
      }>
    >(
      `SELECT repo_uuid, created_at, last_opened_at, archived_at, trashed_at
         FROM workspaces WHERE repo_uuid IN (?, ?) ORDER BY repo_uuid`,
      ['uuid-seconds', 'uuid-seconds-trash']
    );
    expect(stored).toMatchObject({
      repo_uuid: 'uuid-seconds',
      created_at: 1_785_000_000_000,
      last_opened_at: 1_787_000_000_000,
      archived_at: 1_786_000_000_000,
      trashed_at: null,
    });
    expect(storedTrash).toMatchObject({
      repo_uuid: 'uuid-seconds-trash',
      created_at: 1_785_000_000_000,
      last_opened_at: 1_787_000_000_000,
      archived_at: null,
      trashed_at: 1_786_000_000_000,
    });
  });

  it('hides restoring and failed cloud-restore shells until completion', async () => {
    await seedManagedWorkspace('uuid-a', 'lab-a', 100);
    const [workspace] = await platform().db.select<Array<{ id: number }>>(
      `SELECT id FROM workspaces WHERE repo_uuid = ?`,
      ['uuid-a']
    );
    expect(workspace).toBeDefined();
    await platform().db.execute(
      `INSERT INTO workspace_sync_restore_locks (
        workspace_id, lock_id, source_remote_version_id, status, started_at, expires_at
      ) VALUES (?, ?, ?, 'restoring', ?, ?)`,
      [workspace!.id, 'lock-a', 'version-a', 100, 200]
    );

    let library = await listWorkspaceLibrary();
    expect(library.active).toEqual([]);
    expect(library.archived).toEqual([]);
    expect(library.trashed).toEqual([]);

    await platform().db.execute(
      `UPDATE workspace_sync_restore_locks SET status = 'failed' WHERE workspace_id = ?`,
      [workspace!.id]
    );
    library = await listWorkspaceLibrary();
    expect(library.active).toEqual([]);
    expect(library.archived).toEqual([]);
    expect(library.trashed).toEqual([]);
  });

  it('archive soft-hides (restorable); the managed copy row is never deleted', async () => {
    await seedManagedWorkspace('uuid-a', 'lab-a', 100);

    expect(await archiveWorkspace('uuid-a')).toBe(1);
    let lib = await listWorkspaceLibrary();
    expect(lib.active).toHaveLength(0);
    expect(lib.archived.map((w) => w.repoUuid)).toEqual(['uuid-a']);
    expect(lib.archived[0].archivedAt).toBeTypeOf('number');

    expect(await restoreWorkspace('uuid-a')).toBe(1);
    lib = await listWorkspaceLibrary();
    expect(lib.active.map((w) => w.repoUuid)).toEqual(['uuid-a']);
    expect(lib.archived).toHaveLength(0);
  });

  it('renames a managed workspace by mounted repo path; the path never changes', async () => {
    await seedManagedWorkspace('uuid-a', 'lab-a', 100);
    expect(await renameWorkspaceByPath('/managed/uuid-a/repo', '  Lab Notebook ')).toBe(1);
    const library = await listWorkspaceLibrary();
    expect(library.active.map((entry) => [entry.name, entry.repoPath])).toEqual([
      ['Lab Notebook', '/managed/uuid-a/repo'],
    ]);
  });

  it('renameWorkspaceByPath reports 0 rows for a NON-managed workspace', async () => {
    await platform().db.execute(
      `INSERT INTO workspaces (name, path, created_at, last_opened_at) VALUES (?, ?, ?, ?)`,
      ['legacy', '/Users/me/legacy', 1, 300]
    );
    expect(await renameWorkspaceByPath('/Users/me/legacy', 'Renamed')).toBe(0);
  });

  it('archives a managed workspace by mounted repo path', async () => {
    await seedManagedWorkspace('uuid-a', 'lab-a', 100);

    expect(await archiveWorkspaceByPath('/managed/uuid-a/repo')).toBe(1);

    const lib = await listWorkspaceLibrary();
    expect(lib.active).toHaveLength(0);
    expect(lib.archived.map((w) => w.repoUuid)).toEqual(['uuid-a']);
    expect(lib.archived[0].archivedAt).toBeTypeOf('number');
  });

  it('archiveWorkspaceByPath archives a registered local workspace without deleting it', async () => {
    await platform().db.execute(
      `INSERT INTO workspaces (name, path, created_at, last_opened_at) VALUES (?, ?, ?, ?)`,
      ['legacy', '/Users/me/legacy', 1, 300]
    );

    const changed = await archiveWorkspaceByPath('/Users/me/legacy');
    expect(changed).toBe(1);

    const lib = await listWorkspaceLibrary();
    expect(lib.active).toHaveLength(0);
    expect(lib.archived).toHaveLength(1);
  });

  it('archiveWorkspace / restoreWorkspace report 0 rows for an unknown uuid', async () => {
    expect(await archiveWorkspace('does-not-exist')).toBe(0);
    expect(await restoreWorkspace('does-not-exist')).toBe(0);
  });

  it('trash moves a managed workspace to the Trash bucket; restoreFromTrash brings it back', async () => {
    await seedManagedWorkspace('uuid-a', 'lab-a', 100);

    expect(await trashWorkspaceByPath('/managed/uuid-a/repo')).toBe(1);
    let lib = await listWorkspaceLibrary();
    expect(lib.active).toHaveLength(0);
    expect(lib.archived).toHaveLength(0);
    expect(lib.trashed.map((w) => w.repoUuid)).toEqual(['uuid-a']);
    expect(lib.trashed[0].trashedAt).toBeTypeOf('number');

    expect(await restoreFromTrash('uuid-a')).toBe(1);
    lib = await listWorkspaceLibrary();
    expect(lib.active.map((w) => w.repoUuid)).toEqual(['uuid-a']);
    expect(lib.trashed).toHaveLength(0);
  });

  it('trashing an archived workspace clears the archive flag (trash wins, single state)', async () => {
    await seedManagedWorkspace('uuid-a', 'lab-a', 100);
    await archiveWorkspace('uuid-a');
    expect((await listWorkspaceLibrary()).archived).toHaveLength(1);

    expect(await trashWorkspaceByPath('/managed/uuid-a/repo')).toBe(1);
    const lib = await listWorkspaceLibrary();
    expect(lib.archived).toHaveLength(0);
    expect(lib.trashed.map((w) => w.repoUuid)).toEqual(['uuid-a']);
    expect(lib.trashed[0].archivedAt).toBeNull();
  });

  it('cannot archive a trashed workspace (it is pending deletion — restore first)', async () => {
    await seedManagedWorkspace('uuid-a', 'lab-a', 100);
    await trashWorkspaceByPath('/managed/uuid-a/repo');

    expect(await archiveWorkspaceByPath('/managed/uuid-a/repo')).toBe(0);
    const lib = await listWorkspaceLibrary();
    expect(lib.archived).toHaveLength(0);
    expect(lib.trashed).toHaveLength(1);
  });

  it('trashWorkspaceByPath preserves a registered local workspace in the Trash library', async () => {
    await platform().db.execute(
      `INSERT INTO workspaces (name, path, created_at, last_opened_at) VALUES (?, ?, ?, ?)`,
      ['legacy', '/Users/me/legacy', 1, 300]
    );
    expect(await trashWorkspaceByPath('/Users/me/legacy')).toBe(1);
    expect((await listWorkspaceLibrary()).trashed).toEqual([
      expect.objectContaining({ repoPath: '/Users/me/legacy', repoUuid: null }),
    ]);
  });

  it('trashDaysRemaining counts down from the retention window', () => {
    const now = 1_000_000_000_000;
    expect(trashDaysRemaining(null, now)).toBe(Infinity);
    expect(trashDaysRemaining(now, now)).toBe(30);
    expect(trashDaysRemaining(now - (TRASH_RETENTION_MS - 24 * 60 * 60 * 1000), now)).toBe(1);
    expect(trashDaysRemaining(now - TRASH_RETENTION_MS, now)).toBe(0);
  });
});
