import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../__tests__/test-db';
import { resolveProjectRootInMain } from '../project-filesystem-authority';
import { ensureSchema } from '../schema';
import { assertSafePath, getAllowedRoots } from './path-allowlist';

const electronPaths = vi.hoisted(() => ({ home: '', userData: '' }));
vi.mock('electron', () => ({
  app: { getPath: (name: keyof typeof electronPaths) => electronPaths[name] },
}));

describe('opened project path admission', () => {
  let root: string;
  let db: Database.Database;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'project-path-admission-')));
    electronPaths.home = join(root, 'home');
    electronPaths.userData = join(root, 'user-data');
    await mkdir(electronPaths.home);
    await mkdir(electronPaths.userData);
    db = createTestDb();
    ensureSchema(db, ':memory:');
  });

  afterAll(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  it('admits the opened canonical project without admitting siblings or symlink escapes', async () => {
    const project = join(root, 'Project');
    const sibling = join(root, 'Project-other');
    const alias = join(root, 'project-alias');
    await mkdir(project);
    await mkdir(sibling);
    const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
    await symlink(project, alias, symlinkType);
    await symlink(sibling, join(project, 'escape'), symlinkType);

    await expect(assertSafePath(project)).rejects.toThrow('Path access denied');
    await resolveProjectRootInMain(
      { path: alias },
      { db, managedRootDir: join(electronPaths.userData, 'managed-workspaces') }
    );

    expect(getAllowedRoots()).toContain(project);
    expect(getAllowedRoots()).not.toContain(root);
    await expect(assertSafePath(project)).resolves.toBe(project);
    await expect(assertSafePath(join(alias, 'new', 'sequence.fa'))).resolves.toBe(
      join(project, 'new', 'sequence.fa')
    );
    await expect(assertSafePath(sibling)).rejects.toThrow('Path access denied');
    await expect(assertSafePath(join(project, 'escape', 'sequence.fa'))).rejects.toThrow(
      'Path access denied'
    );
  });

  it('does not admit a project when opening its archived owner is refused', async () => {
    const project = join(root, 'Archived');
    await mkdir(project);
    db.prepare('INSERT INTO workspaces(name,path,created_at,archived_at) VALUES(?,?,1,1)').run(
      'Archived',
      project
    );

    await expect(
      resolveProjectRootInMain(
        { path: project },
        { db, managedRootDir: join(electronPaths.userData, 'managed-workspaces') }
      )
    ).rejects.toThrow('Restore the owning project');
    expect(getAllowedRoots()).not.toContain(project);
    await expect(assertSafePath(project)).rejects.toThrow('Path access denied');
  });
});
