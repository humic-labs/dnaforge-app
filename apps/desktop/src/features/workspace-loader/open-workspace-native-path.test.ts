import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../main/__tests__/test-db';
import { ensureSchema } from '../../main/schema';
import { ensureWorkspaceOwnerInDb } from '../../main/catalog-projection-commands';
import { resolveProjectRootInMain } from '../../main/project-filesystem-authority';
import type { FilesystemStat } from '../../shared/filesystem-stat';

const native = vi.hoisted(() => ({
  stat: vi.fn(),
  owner: vi.fn(),
  resolveRoot: vi.fn(),
  tempRoot: '',
  db: null as Database.Database | null,
}));

vi.mock('../../utils/environment', () => ({
  isDesktopRuntime: () => true,
  isElectron: () => true,
  isBrowserOnly: () => false,
  isHostedBrowserRuntime: () => false,
}));
vi.mock('../../platform', () => ({
  platform: () => ({
    fs: { stat: native.stat },
    db: { ensureWorkspaceOwner: (...args: unknown[]) => native.owner(...args) },
    workspace: { resolveProjectRoot: (...args: unknown[]) => native.resolveRoot(...args) },
  }),
}));

import { openWorkspaceFromSource } from './open-workspace-from-source';
import { useWorkspaceStore } from '../../stores/workspaceStore';

let canonical = '';
let alias = '';
function directory(canonicalPath: string): FilesystemStat {
  return {
    canonicalPath,
    size: 0,
    isDirectory: true,
    isFile: false,
    mtime: 0,
    ctime: 0,
    mtimeNs: '0',
    ctimeNs: '0',
  };
}

describe('native project root identity', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    native.tempRoot = await realpath(await mkdtemp(join(tmpdir(), 'project-root-authority-')));
    canonical = join(native.tempRoot, 'canonical');
    alias = join(native.tempRoot, 'alias');
    await mkdir(canonical);
    await mkdir(join(native.tempRoot, 'managed-workspaces'));
    await symlink(canonical, alias);
    native.db = createTestDb();
    ensureSchema(native.db, ':memory:');
    native.owner.mockImplementation(async (root, access, discovery) =>
      ensureWorkspaceOwnerInDb(native.db!, root, access, discovery)
    );
    native.resolveRoot.mockImplementation((request) =>
      resolveProjectRootInMain(request, {
        db: native.db!,
        managedRootDir: join(native.tempRoot, 'managed-workspaces'),
      })
    );
    native.stat.mockImplementation(async (path: string) => directory(await realpath(path)));
  });
  afterEach(async () => {
    useWorkspaceStore.getState().clearWorkspace();
    native.db?.close();
    await rm(native.tempRoot, { recursive: true, force: true });
  });

  it('registers and mounts one native canonical root for an alias and a direct reopen', async () => {
    await openWorkspaceFromSource({ kind: 'local-folder', path: `${alias}/` }, { inPlace: true });
    expect(native.stat).toHaveBeenCalledWith(alias);
    expect(native.owner).toHaveBeenLastCalledWith(canonical, undefined, {
      name: 'canonical',
      recordOpen: true,
    });
    expect(useWorkspaceStore.getState().selectedPath).toBe(canonical);

    await openWorkspaceFromSource({ kind: 'local-folder', path: canonical }, { inPlace: true });
    expect(useWorkspaceStore.getState().folders.map((folder) => folder.path)).toEqual([canonical]);
    expect(native.owner.mock.calls.every(([root]) => root === canonical)).toBe(true);
    expect(native.db!.prepare('SELECT path FROM workspaces').all()).toEqual([{ path: canonical }]);
  });

  it('does not promote a canonical reference when its alias is reopened writable', async () => {
    await openWorkspaceFromSource(
      { kind: 'local-folder', path: canonical, pinned: true },
      { inPlace: true }
    );
    await openWorkspaceFromSource({ kind: 'local-folder', path: alias }, { inPlace: true });
    expect(useWorkspaceStore.getState().folders).toEqual([
      expect.objectContaining({ path: canonical, pinned: true }),
    ]);
    expect(native.db!.prepare('SELECT path,access_mode FROM workspaces').all()).toEqual([
      { path: canonical, access_mode: 'reference' },
    ]);
  });

  it.each(['direct', 'alias'] as const)(
    'uses the native project identity and name for an unnamed %s reopen of its repo folder',
    async (route) => {
      const uuid = randomUUID();
      const root = join(native.tempRoot, 'managed-workspaces', uuid, 'repo');
      await mkdir(join(root, '.git'), { recursive: true });
      await writeFile(
        join(root, '.dnaforge-workspace.json'),
        JSON.stringify({ schema: 1, workspaceUuid: uuid, originPath: null, importedAt: 1 })
      );
      await rm(alias);
      await symlink(root, alias);
      const originalId = ensureWorkspaceOwnerInDb(native.db!, root, 'writable', {
        name: 'Sundew localization',
        recordOpen: true,
      });
      native.db!.prepare('UPDATE workspaces SET repo_uuid = ? WHERE id = ?').run(uuid, originalId);
      native.stat.mockResolvedValue(directory(root));

      await openWorkspaceFromSource(
        { kind: 'local-folder', path: route === 'direct' ? root : alias },
        { inPlace: true }
      );

      expect(useWorkspaceStore.getState().folders).toEqual([
        expect.objectContaining({ path: root, name: 'Sundew localization' }),
      ]);
      expect(useWorkspaceStore.getState().selectedPath).toBe(root);
      expect(native.db!.prepare('SELECT id, name, path, repo_uuid FROM workspaces').all()).toEqual([
        { id: originalId, name: 'Sundew localization', path: root, repo_uuid: uuid },
      ]);
    }
  );

  it.each(['managed-store', 'container', 'forged-repo', 'content-folder', 'forged-alias'] as const)(
    'refuses %s as a project without registering or mounting it',
    async (kind) => {
      const managedStore = join(native.tempRoot, 'managed-workspaces');
      const uuid = randomUUID();
      const root = join(managedStore, uuid, 'repo');
      const content = join(root, 'Experiments');
      await mkdir(content, { recursive: true });
      await mkdir(join(root, '.git'));
      await writeFile(
        join(root, '.dnaforge-workspace.json'),
        JSON.stringify({ schema: 1, workspaceUuid: uuid, originPath: null, importedAt: 1 })
      );
      const originalId = ensureWorkspaceOwnerInDb(native.db!, root, 'writable', {
        name: 'Sundew localization',
        recordOpen: true,
      });
      native.db!.prepare('UPDATE workspaces SET repo_uuid = ? WHERE id = ?').run(uuid, originalId);
      const forgedUuid = randomUUID();
      const forged = join(managedStore, forgedUuid, 'repo');
      await mkdir(join(forged, '.git'), { recursive: true });
      await writeFile(
        join(forged, '.dnaforge-workspace.json'),
        JSON.stringify({ schema: 1, workspaceUuid: forgedUuid, originPath: null, importedAt: 1 })
      );
      await rm(alias);
      await symlink(forged, alias);
      const attempted = {
        'managed-store': managedStore,
        container: dirname(root),
        'forged-repo': forged,
        'content-folder': content,
        'forged-alias': alias,
      }[kind];
      const before = native.db!.prepare('SELECT * FROM workspaces').all();
      useWorkspaceStore.getState().addFolder('/fixture/current', 'Current project');
      useWorkspaceStore.getState().setSelectedPath('/fixture/current');
      const mounted = useWorkspaceStore.getState().folders;

      await expect(
        openWorkspaceFromSource({ kind: 'local-folder', path: attempted }, { inPlace: true })
      ).rejects.toThrow(/PROJECT_ROOT_INVALID/);

      expect(native.db!.prepare('SELECT * FROM workspaces').all()).toEqual(before);
      expect(useWorkspaceStore.getState().folders).toBe(mounted);
      expect(useWorkspaceStore.getState().selectedPath).toBe('/fixture/current');
    }
  );

  it('preserves the current collection and selection when native path resolution refuses', async () => {
    useWorkspaceStore.getState().addFolder('/fixture/current');
    useWorkspaceStore.getState().setSelectedPath('/fixture/current');
    const before = useWorkspaceStore.getState().folders;
    native.stat.mockRejectedValueOnce(
      Object.assign(new Error('Controlled refusal'), { code: 'EACCES' })
    );

    await expect(
      openWorkspaceFromSource({ kind: 'local-folder', path: alias }, { inPlace: true })
    ).rejects.toThrow('Controlled refusal');

    expect(native.owner).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().folders).toBe(before);
    expect(useWorkspaceStore.getState().selectedPath).toBe('/fixture/current');
  });

  it('rejects a native file before registering or mounting it as a project', async () => {
    native.stat.mockResolvedValueOnce({
      ...directory(canonical),
      isDirectory: false,
      isFile: true,
    });
    await expect(
      openWorkspaceFromSource({ kind: 'local-folder', path: alias }, { inPlace: true })
    ).rejects.toThrow('Project root must be a directory');
    expect(native.owner).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().folders).toEqual([]);
  });
});
