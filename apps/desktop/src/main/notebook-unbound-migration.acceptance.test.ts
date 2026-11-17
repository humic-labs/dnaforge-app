/** @vitest-environment node */
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformBridge } from '../platform';

const state = vi.hoisted(() => ({
  db: null as Database.Database | null,
  bridge: null as PlatformBridge | null,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) =>
      state.handlers.get(channel)!({ sender }, ...args),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      state.handlers.set(channel, handler);
    }),
  },
  app: { getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '1.0.0'), exit: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('../platform', () => ({ platform: () => state.bridge }));
vi.mock('./ipc/database', async (importActual) => ({
  ...(await importActual<object>()),
  getDb: () => state.db,
}));
vi.mock('../lib/analytics', async (importActual) => ({
  ...(await importActual<object>()),
  trackRendererEvent: vi.fn(),
}));

import { createTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { registerDatabaseHandlers } from './ipc/database';
import { createClient } from '../shared/ipc-contract';
import { dbContract } from '../shared/ipc/db.contract';
import { createLimsBridgeForDb } from './__tests__/lims-bridge-for-db';
import { registerLimsIpcHandlers } from './lims';
import { workspaceMutationCapabilities } from './ipc/workspace-mutation-capability';
import {
  acquireWorkspaceMutationShared,
  workspaceMutationRootIdentity,
} from './workspace-sync-mutation-lease';
import { discoverWorkspaceArtifacts } from './workspace-artifact-discovery';
import { reconcileMountedWorkspaceRoot } from '../services/mounted-workspace-reconcile';
import { registerNotebookEntityAdapter } from '../db/entity-substrate/notebook-adapter';
import { notebookPackagePaths } from '../db/notebook-package';
import { createNativeNotebookWorkingCopies } from './native-notebook-working-copies';
import { readCanonicalNotebookPackage } from '../db/notebook-package-migration';
import { reconcileWorkspaceRoot } from '../services/workspace-reconcile';
import { canonicalNotebookJson } from '../db/notebook-markdown-codec';
import { registerNotebookOwnerHandlers } from './ipc/notebook';
import { notebookContract } from '../shared/ipc/notebook.contract';
import { createRegisteredProjectAuthority } from './registered-project-authority';
import type { MarkdownNotebookImporter } from './markdown-notebook-import';
import type { WebContents } from 'electron';
import { bindCatalogEntityToFile, registerCatalogEntity } from '../db/workspace-catalog';

const sender = Object.assign(new EventEmitter(), { id: 527411, isDestroyed: () => false });
let root: string;
const title = 'Legacy migration notebook';
const id = 'ws7::portable-notebook';
let native: ReturnType<typeof createNativeNotebookWorkingCopies>;
let legacyPath: string;
let original: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'unbound-notebook-migration-')));
  state.db = createTestDb();
  ensureSchema(state.db, ':memory:');
  state.db
    .prepare('INSERT INTO workspaces(id,name,path,created_at) VALUES(7,?,?,1)')
    .run('Unbound notebook migration', root);
  state.handlers.clear();
  registerDatabaseHandlers(() => state.db!);
  registerLimsIpcHandlers();
  const invoke = async (channel: string, ...args: unknown[]) => {
    const handler = state.handlers.get(channel);
    if (!handler) throw new Error(`Missing production handler ${channel}`);
    return handler({ sender }, ...args);
  };
  const registeredProjects = createRegisteredProjectAuthority({ db: () => state.db! });
  native = createNativeNotebookWorkingCopies({
    db: () => state.db!,
    workspaceRoots: () => [root],
    writableWorkspaceRoots: () => [root],
    profileDirectory: () => join(root, '.profile'),
    captureWorkspace: (root, mutating) => registeredProjects.capture(root, mutating),
    registeredProjects,
    relocateEntityFile: async () => {
      throw new Error('Unexpected relocation');
    },
  });
  registerNotebookOwnerHandlers(
    native,
    () => sender as unknown as WebContents,
    {} as MarkdownNotebookImporter,
    async () => {}
  );
  const lims = createLimsBridgeForDb(state.db);
  state.bridge = {
    runtime: 'electron',
    db: {
      ...createClient(dbContract),
      select: (sql: string, params?: unknown[]) => invoke('db:select', sql, params),
      execute: (sql: string, params?: unknown[]) => invoke('db:execute', sql, params),
      bindCatalogEntityFile: (request: unknown, token?: string) =>
        invoke('db:bindCatalogEntityFile', request, token),
    },
    fs: {
      recoverNotebookPackageRenameIfNeededInMain: async () => null,
      exists: async (path: string) =>
        stat(path).then(
          () => true,
          () => false
        ),
      readTextFile: (path: string) => readFile(path, 'utf8'),
      stat: async (path: string) => {
        const result = await stat(path);
        return { size: result.size, mtime: result.mtimeMs };
      },
      readDir: async (path: string) =>
        (await readdir(path, { withFileTypes: true })).map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile(),
          isSymbolicLink: entry.isSymbolicLink(),
        })),
      beginWorkspaceMutation: async (workspaceRoot: string, parentToken?: string) => {
        const rootIdentity = workspaceMutationRootIdentity(workspaceRoot);
        if (parentToken) {
          const token = workspaceMutationCapabilities.issueReentry(
            parentToken,
            sender.id,
            rootIdentity
          );
          if (!token) throw new Error('Invalid fixture mutation reentry');
          return token;
        }
        const release = await acquireWorkspaceMutationShared(workspaceRoot);
        return workspaceMutationCapabilities.issue(sender.id, rootIdentity, release);
      },
      endWorkspaceMutation: async (token: string) => {
        workspaceMutationCapabilities.release(token, sender.id);
      },
    },
    workspace: { discoverArtifacts: discoverWorkspaceArtifacts },
    notebook: createClient(notebookContract),
    lims: {
      ...lims,
      registerEntity: (...args: unknown[]) => invoke('lims:registerEntity', ...args),
      updateEntity: (...args: unknown[]) => invoke('lims:updateEntity', ...args),
      archiveEntity: (...args: unknown[]) => invoke('lims:archiveEntity', ...args),
    },
  } as unknown as PlatformBridge;
  registerNotebookEntityAdapter();
  legacyPath = join(root, title + '.wpnote.json');
  original = JSON.stringify({
    schema: 'waypoint.notebook.v1',
    kind: 'notebook',
    id: 'portable-notebook',
    title,
    content: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Retained notebook content. ' },
            {
              type: 'text',
              text: 'Reference sequence',
              marks: [{ type: 'link', attrs: { href: 'entity://sequence/linked-sequence' } }],
            },
          ],
        },
      ],
    },
    storage: { type: 'database', table: 'pages', id: 'portable-notebook' },
    updatedAt: '2026-08-20T12:00:00.000Z',
  });
  await writeFile(legacyPath, original);
  expect(state.db.prepare('SELECT * FROM pages').all()).toEqual([]);
  expect(state.db.prepare('SELECT * FROM catalog_entities').all()).toEqual([]);
  expect(state.db.prepare('SELECT * FROM catalog_entity_files').all()).toEqual([]);
});

afterEach(async () => {
  workspaceMutationCapabilities.releaseOwner(sender.id);
  await native?.close();
  state.db?.close();
  state.db = null;
  state.bridge = null;
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function expectCurrentNotebook(packageRoot = join(root, title)): Promise<void> {
  const row = state
    .db!.prepare(
      "SELECT entity_id,path,workspace_id,file_kind FROM catalog_entity_files WHERE status='current' AND entity_id=?"
    )
    .get(id) as { path: string };
  expect(row).toEqual({
    entity_id: id,
    path: packageRoot,
    workspace_id: 7,
    file_kind: 'waypoint-notebook',
  });
  const disk = await readCanonicalNotebookPackage(
    {
      readTextFile: (path) => readFile(path, 'utf8'),
      exists: async (path) =>
        stat(path).then(
          () => true,
          () => false
        ),
    },
    row.path
  );
  expect(disk.metadata).toMatchObject({ id: 'portable-notebook', formatVersion: 2 });
  expect(canonicalNotebookJson(disk.parsed.content)).toContain('entity://sequence/linked-sequence');
  expect(await readFile(notebookPackagePaths(row.path).markdownPath, 'utf8')).toContain(
    'Retained notebook content.'
  );
  expect(await readFile(legacyPath + '.legacy', 'utf8')).toBe(original);
  await expect(stat(legacyPath)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(
    state.db!.prepare("SELECT id,workspace_id FROM catalog_entities WHERE type='notebook'").all()
  ).toEqual([{ id, workspace_id: 7 }]);
}

describe('unbound legacy notebook automatic project migration', () => {
  it('discovers an unbound flat artifact through ordinary catalog reconciliation before native migration', async () => {
    const reconciled = await reconcileWorkspaceRoot(root, { catalogSource: 'working-tree' });
    expect(reconciled.errors).toEqual([]);
    expect(
      state
        .db!.prepare(
          'SELECT entity_id,path,workspace_id,status FROM catalog_entity_files WHERE entity_id=?'
        )
        .all(id)
    ).toEqual([{ entity_id: id, path: legacyPath, workspace_id: 7, status: 'current' }]);
    const migration = await native.migrateLegacyProjectFiles(root);
    expect(migration.issues).toEqual([]);
    expect(migration.migrated).toBe(1);
    await expectCurrentNotebook();
  });
  it('automatically migrates the newly cataloged flat notebook during mounted project reconciliation', async () => {
    const reconciled = await reconcileMountedWorkspaceRoot(root, { catalogSource: 'working-tree' });
    expect(reconciled.result.errors).toEqual([]);
    expect(reconciled.entityResult.errors).toEqual([]);
    await expectCurrentNotebook();
  });

  it('migrates an unbound flat notebook beneath the ordinary cataloged project folder', async () => {
    const folder = await registerCatalogEntity({
      type: 'folder',
      name: 'Unbound notebook migration',
      locator: `file://${root}`,
      storageType: 'file',
      workspaceRoot: root,
      metadata: {
        discoveredFrom: 'workspace-store',
        path: root,
        relativePath: '',
        fileKind: 'folder',
      },
    });
    await bindCatalogEntityToFile({
      entityId: folder.id,
      path: root,
      workspaceRoot: root,
      fileKind: 'folder',
      status: 'current',
    });
    const before = state
      .db!.prepare(
        'SELECT entity_id,path,workspace_id,file_kind,status FROM catalog_entity_files WHERE entity_id=?'
      )
      .get(folder.id);
    const reconciled = await reconcileMountedWorkspaceRoot(root, { catalogSource: 'working-tree' });
    expect(reconciled.result.errors).toEqual([]);
    expect(reconciled.entityResult.errors).toEqual([]);
    await expectCurrentNotebook();
    expect(
      state
        .db!.prepare(
          'SELECT entity_id,path,workspace_id,file_kind,status FROM catalog_entity_files WHERE entity_id=?'
        )
        .get(folder.id)
    ).toEqual(before);
  });

  it('keeps a foreign scientific document reservation while choosing a free notebook destination', async () => {
    const reconciled = await reconcileWorkspaceRoot(root, { catalogSource: 'working-tree' });
    expect(reconciled.errors).toEqual([]);
    const protectedPath = join(root, title);
    const sequence = await registerCatalogEntity({
      id: 'foreign-sequence-reservation',
      type: 'sequence',
      name: 'Reserved sequence',
      locator: 'entity://sequence/foreign-sequence-reservation',
      storageType: 'file',
      workspaceRoot: root,
    });
    await bindCatalogEntityToFile({
      entityId: sequence.id,
      path: protectedPath,
      workspaceRoot: root,
      fileKind: 'waypoint-sequence',
      status: 'current',
    });
    const before = state
      .db!.prepare('SELECT * FROM catalog_entity_files WHERE entity_id=?')
      .all(sequence.id);
    const migration = await state.bridge!.notebook.migrateLegacyProjectFiles({
      workspaceRoot: root,
    });
    expect(migration.issues).toEqual([]);
    expect(migration.migrated).toBe(1);
    await expectCurrentNotebook(join(root, `${title} (2)`));
    await expect(stat(protectedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      state.db!.prepare('SELECT * FROM catalog_entity_files WHERE entity_id=?').all(sequence.id)
    ).toEqual(before);
  });
});
