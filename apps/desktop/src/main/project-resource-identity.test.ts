// @vitest-environment node

import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import {
  ensureProjectResourceIdentityInMain,
  readProjectResourceIdentityInMain,
} from './project-filesystem-authority';
import { writeWorkspaceTextFileAtomicInMain } from './primer-artifact-files';
import { syncDirectory } from './fs-durability';
import { MANAGED_WORKSPACE_MARKER } from '../shared/workspace-git-types';

const electronPaths = vi.hoisted(() => ({ home: '', userData: '' }));
vi.mock('electron', () => ({
  app: { getPath: (name: keyof typeof electronPaths) => electronPaths[name] },
}));

describe('portable project identity for table references', () => {
  let root: string;
  let managedRootDir: string;
  let db: Database.Database;
  let index = 0;
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'table-project-identity-')));
    electronPaths.home = join(root, 'home');
    electronPaths.userData = join(root, 'user-data');
    managedRootDir = join(electronPaths.userData, 'managed-workspaces');
    await mkdir(electronPaths.home);
    await mkdir(managedRootDir, { recursive: true });
    db = createTestDb();
    ensureSchema(db, ':memory:');
  });
  afterAll(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  async function project() {
    const path = join(electronPaths.home, `project-${++index}`);
    await mkdir(path);
    await writeFile(join(path, 'Original.txt'), 'Exact original bytes\r\n');
    const row = db
      .prepare('INSERT INTO workspaces(name,path,created_at,access_mode) VALUES(?,?,1,?)')
      .run(`Project ${index}`, path, 'writable');
    return { path, id: Number(row.lastInsertRowid), marker: join(path, '.forge', 'project.json') };
  }
  const deps = () => ({ db, managedRootDir, protectedAppDataRoot: electronPaths.userData });
  async function unchanged(p: Awaited<ReturnType<typeof project>>) {
    expect(await readFile(join(p.path, 'Original.txt'), 'utf8')).toBe('Exact original bytes\r\n');
    expect(db.prepare('SELECT repo_uuid FROM workspaces WHERE id=?').get(p.id)).toEqual({
      repo_uuid: null,
    });
    await expect(access(join(p.path, '.git'))).rejects.toThrow();
  }

  it('assigns a durable UUID once without moving, initializing Git or rekeying the project', async () => {
    const p = await project();
    const first = await ensureProjectResourceIdentityInMain({ workspaceRoot: p.path }, deps());
    expect(first).toMatchObject({ workspaceRoot: p.path, workspaceId: p.id, source: 'marker' });
    expect(first.projectId).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
    );
    const original = await readFile(p.marker, 'utf8');
    const inode = (await stat(p.marker)).ino;
    expect(JSON.parse(original)).toMatchObject({
      schema: 'dnaforge.project-identity.v1',
      id: first.projectId,
    });
    expect(await ensureProjectResourceIdentityInMain({ workspaceRoot: p.path }, deps())).toEqual(
      first
    );
    expect(await readFile(p.marker, 'utf8')).toBe(original);
    expect((await stat(p.marker)).ino).toBe(inode);
    await unchanged(p);
  });

  it('returns one verified winner under concurrent identity creation', async () => {
    const p = await project();
    const replies = await Promise.all(
      Array.from({ length: 6 }, () =>
        ensureProjectResourceIdentityInMain({ workspaceRoot: p.path }, deps())
      )
    );
    expect(new Set(replies.map((reply) => reply.projectId)).size).toBe(1);
    expect(JSON.parse(await readFile(p.marker, 'utf8')).id).toBe(replies[0].projectId);
    await unchanged(p);
  });

  it('reads an unmarked registered project without creating or enrolling anything', async () => {
    const p = await project();
    expect(await readProjectResourceIdentityInMain({ workspaceRoot: p.path }, deps())).toBeNull();
    await expect(access(join(p.path, '.forge'))).rejects.toThrow();
    await unchanged(p);
  });

  it('opens an existing identity in a reference-only project without rewriting it', async () => {
    const p = await project();
    const identity = await ensureProjectResourceIdentityInMain({ workspaceRoot: p.path }, deps());
    const before = await readFile(p.marker, 'utf8');
    const inode = (await stat(p.marker)).ino;
    db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=?").run(p.id);
    expect(await readProjectResourceIdentityInMain({ workspaceRoot: p.path }, deps())).toEqual(
      identity
    );
    expect(await readFile(p.marker, 'utf8')).toBe(before);
    expect((await stat(p.marker)).ino).toBe(inode);
    await unchanged(p);
  });

  it('uses a verified managed project UUID without creating another identity', async () => {
    const id = '6b0f2c47-5f0e-4d1e-9a3b-0d3c1a2b5099';
    const path = join(managedRootDir, id, 'repo');
    await mkdir(join(path, '.git'), { recursive: true });
    await writeFile(
      join(path, MANAGED_WORKSPACE_MARKER),
      JSON.stringify({ schema: 1, workspaceUuid: id })
    );
    db.prepare(
      'INSERT INTO workspaces(name,path,repo_uuid,created_at,access_mode) VALUES(?,?,?,1,?)'
    ).run('Managed identity', path, id, 'writable');
    expect(
      await ensureProjectResourceIdentityInMain({ workspaceRoot: path }, deps())
    ).toMatchObject({ projectId: id, source: 'managed' });
    await expect(access(join(path, '.forge', 'project.json'))).rejects.toThrow();
  });

  it('refuses an unregistered root or a content subdirectory without enrolling it', async () => {
    const p = await project();
    const child = join(p.path, 'nested');
    const unknown = join(electronPaths.home, `unregistered-${++index}`);
    await mkdir(child);
    await mkdir(unknown);
    const count = db.prepare('SELECT COUNT(*) AS n FROM workspaces').get();
    for (const path of [child, unknown]) {
      await expect(
        ensureProjectResourceIdentityInMain({ workspaceRoot: path }, deps())
      ).rejects.toThrow();
      await expect(access(join(path, '.forge', 'project.json'))).rejects.toThrow();
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM workspaces').get()).toEqual(count);
    await unchanged(p);
  });

  it.each(['readonly', 'archived', 'trashed'])(
    'refuses %s ownership before creating a marker',
    async (state) => {
      const p = await project();
      if (state === 'readonly')
        db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=?").run(p.id);
      if (state === 'archived')
        db.prepare('UPDATE workspaces SET archived_at=1 WHERE id=?').run(p.id);
      if (state === 'trashed')
        db.prepare('UPDATE workspaces SET trashed_at=1 WHERE id=?').run(p.id);
      await expect(
        ensureProjectResourceIdentityInMain({ workspaceRoot: p.path }, deps())
      ).rejects.toThrow();
      await expect(access(p.marker)).rejects.toThrow();
      await unchanged(p);
    }
  );

  it('preserves malformed or unsupported identity bytes without replacing them', async () => {
    for (const body of ['{broken', '{"schema":"dnaforge.project-identity.v999","id":"retained"}']) {
      const p = await project();
      await mkdir(join(p.path, '.forge'));
      await writeFile(p.marker, body);
      await expect(
        ensureProjectResourceIdentityInMain({ workspaceRoot: p.path }, deps())
      ).rejects.toThrow();
      expect(await readFile(p.marker, 'utf8')).toBe(body);
      await unchanged(p);
    }
  });

  it('refuses a linked marker or marker directory without modifying its target', async () => {
    const target = join(root, 'external-identity.json');
    const original =
      '{"schema":"dnaforge.project-identity.v1","id":"6b0f2c47-5f0e-4d1e-9a3b-0d3c1a2b5098"}';
    await writeFile(target, original);
    const p = await project();
    await mkdir(join(p.path, '.forge'));
    await symlink(target, p.marker);
    await expect(
      ensureProjectResourceIdentityInMain({ workspaceRoot: p.path }, deps())
    ).rejects.toThrow();
    const elsewhere = join(root, 'external-forge');
    await mkdir(elsewhere);
    const q = await project();
    await symlink(elsewhere, join(q.path, '.forge'), 'dir');
    await expect(
      ensureProjectResourceIdentityInMain({ workspaceRoot: q.path }, deps())
    ).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe(original);
    await expect(access(join(elsewhere, 'project.json'))).rejects.toThrow();
  });

  it('rechecks writable ownership at the actual publication boundary', async () => {
    const p = await project();
    const writeAtomic: typeof writeWorkspaceTextFileAtomicInMain = async (input, options) => {
      db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=?").run(p.id);
      return writeWorkspaceTextFileAtomicInMain(input, options);
    };
    await expect(
      ensureProjectResourceIdentityInMain({ workspaceRoot: p.path }, { ...deps(), writeAtomic })
    ).rejects.toThrow();
    await expect(access(p.marker)).rejects.toThrow();
    await unchanged(p);
  });

  it('retains a published UUID after uncertain durability and acknowledges only a successful exact retry', async () => {
    const p = await project();
    let allowed = false;
    const directorySync: typeof syncDirectory = async (path) => {
      if (!allowed) throw new Error('Controlled directory flush failure');
      await syncDirectory(path);
    };
    await expect(
      ensureProjectResourceIdentityInMain(
        { workspaceRoot: p.path },
        { ...deps(), syncDirectory: directorySync }
      )
    ).rejects.toThrow();
    const published = await readFile(p.marker, 'utf8');
    const id = JSON.parse(published).id;
    const inode = (await stat(p.marker)).ino;
    allowed = true;
    const reply = await ensureProjectResourceIdentityInMain(
      { workspaceRoot: p.path },
      { ...deps(), syncDirectory: directorySync }
    );
    expect(reply.projectId).toBe(id);
    expect(await readFile(p.marker, 'utf8')).toBe(published);
    expect((await stat(p.marker)).ino).toBe(inode);
    await unchanged(p);
  });
});
