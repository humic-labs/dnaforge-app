/** @vitest-environment node */
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformBridge } from '../../platform';

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
vi.mock('../../platform', () => ({ platform: () => state.bridge }));
vi.mock('../../main/ipc/database', async (importActual) => ({
  ...(await importActual<object>()),
  getDb: () => state.db,
}));
vi.mock('../../lib/analytics', async (importActual) => ({
  ...(await importActual<object>()),
  trackRendererEvent: vi.fn(),
}));

import { createTestDb } from '../../main/__tests__/test-db';
import { ensureSchema } from '../../main/schema';
import { registerDatabaseHandlers } from '../../main/ipc/database';
import { createClient } from '../../shared/ipc-contract';
import { dbContract } from '../../shared/ipc/db.contract';
import { createLimsBridgeForDb } from '../../main/__tests__/lims-bridge-for-db';
import { registerLimsIpcHandlers } from '../../main/lims';
import { workspaceMutationCapabilities } from '../../main/ipc/workspace-mutation-capability';
import {
  acquireWorkspaceMutationShared,
  workspaceMutationRootIdentity,
} from '../../main/workspace-sync-mutation-lease';
import { discoverWorkspaceArtifacts } from '../../main/workspace-artifact-discovery';
import { reconcileMountedWorkspaceRoot } from '../../services/mounted-workspace-reconcile';
import { registerNotebookEntityAdapter } from './notebook-adapter';
import { buildNotebookPackageMetadata } from '../notebook-package';
import { serializeNotebookMarkdown } from '../notebook-markdown-codec';

const sender = Object.assign(new EventEmitter(), { id: 81429 });
let root: string;
const title = 'Relocated notebook';
const id = 'relocation-workspace::portable-notebook';
const content = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

async function writeNotebook(packageRoot: string, body: string): Promise<void> {
  const metadata = buildNotebookPackageMetadata({
    id: 'portable-notebook',
    title,
    markdownFileName: `${title}.md`,
  });
  const serialized = serializeNotebookMarkdown({ identity: metadata, content: content(body) });
  await mkdir(join(packageRoot, '.forge'), { recursive: true });
  await writeFile(join(packageRoot, '.forge/notebook.json'), JSON.stringify(metadata));
  await writeFile(join(packageRoot, `${title}.md`), serialized.markdown);
  for (const payload of serialized.payloads) {
    const path = join(packageRoot, payload.relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, payload.content);
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'waypoint-notebook-relocation-'));
  state.db = createTestDb();
  ensureSchema(state.db, ':memory:');
  state.db
    .prepare('INSERT INTO workspaces(id,name,path,repo_uuid,created_at) VALUES(7,?,?,?,1)')
    .run('Relocation regression fixture', root, 'relocation-workspace');
  state.handlers.clear();
  registerDatabaseHandlers(() => state.db!);
  registerLimsIpcHandlers();
  const invoke = async (channel: string, ...args: unknown[]) => {
    const handler = state.handlers.get(channel);
    if (!handler) throw new Error(`Missing production handler ${channel}`);
    return handler({ sender }, ...args);
  };
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
    lims: {
      ...lims,
      registerEntity: (...args: unknown[]) => invoke('lims:registerEntity', ...args),
      updateEntity: (...args: unknown[]) => invoke('lims:updateEntity', ...args),
      archiveEntity: (...args: unknown[]) => invoke('lims:archiveEntity', ...args),
    },
  } as unknown as PlatformBridge;
  registerNotebookEntityAdapter();
  await writeNotebook(join(root, title), 'Saved notebook content');
});

afterEach(async () => {
  workspaceMutationCapabilities.releaseOwner(sender.id);
  state.db?.close();
  state.db = null;
  state.bridge = null;
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('notebook external relocation through production mount reconciliation', () => {
  it('retains the last validated Registry location when rebinding the moved package fails', async () => {
    const initial = await reconcileMountedWorkspaceRoot(root);
    expect(initial.entityResult.errors).toEqual([]);
    const [before] = await state.bridge!.lims.queryEntities({ id });
    const receipts = state.db!.prepare('SELECT * FROM entity_projection_sources').all();
    const movedRoot = join(root, 'experiments', title);
    await mkdir(dirname(movedRoot));
    await rename(join(root, title), movedRoot);
    state.db!.exec(`CREATE TEMP TRIGGER reject_notebook_rebinding
      BEFORE INSERT ON catalog_entity_files
      WHEN NEW.entity_id = '${id}'
      BEGIN SELECT RAISE(ABORT, 'injected notebook binding failure'); END;`);

    const moved = await reconcileMountedWorkspaceRoot(root);
    expect(moved.result.errors).toEqual([
      { path: movedRoot, message: 'injected notebook binding failure' },
    ]);
    expect(moved.entityResult.errors).toEqual([
      {
        path: join(movedRoot, '.forge/notebook.json'),
        message: 'binding: injected notebook binding failure',
      },
      {
        path: join(movedRoot, '.forge/notebook.json'),
        message: 'Entity projection source does not match its exact current file binding.',
      },
    ]);
    const [after] = await state.bridge!.lims.queryEntities({ id });
    expect(after).toEqual(before);
    expect(state.db!.prepare('SELECT * FROM entity_projection_sources').all()).toEqual(receipts);
  });

  it.each([false, true])(
    'refreshes the validated current location while retaining identity and divergent content=%s',
    async (divergent) => {
      const initial = await reconcileMountedWorkspaceRoot(root);
      expect(initial.result.errors).toEqual([]);
      expect(initial.entityResult).toMatchObject({
        scanned: 1,
        reconciled: 1,
        conflicts: 0,
        errors: [],
      });
      const [before] = await state.bridge!.lims.queryEntities({ id });
      expect(before.fields.packagePath).toBe(join(root, title));
      if (divergent) {
        state
          .db!.prepare('UPDATE pages SET content = ? WHERE id = ?')
          .run(JSON.stringify(content('Retained unsaved application content')), id);
      }
      const pageBefore = state.db!.prepare('SELECT * FROM pages WHERE id = ?').get(id);
      const movedRoot = join(root, 'experiments', title);
      await mkdir(dirname(movedRoot));
      await rename(join(root, title), movedRoot);
      const metadataBytes = await readFile(join(movedRoot, '.forge/notebook.json'), 'utf8');
      const markdownBytes = await readFile(join(movedRoot, `${title}.md`), 'utf8');

      const moved = await reconcileMountedWorkspaceRoot(root);
      expect(moved.result.errors).toEqual([]);
      expect(moved.entityResult).toMatchObject({
        scanned: 1,
        conflicts: divergent ? 1 : 0,
        errors: [],
      });
      expect(
        state
          .db!.prepare("SELECT entity_id, path FROM catalog_entity_files WHERE status='current'")
          .all()
      ).toEqual([{ entity_id: id, path: movedRoot }]);
      const [after] = await state.bridge!.lims.queryEntities({ id });
      expect(after).toMatchObject({
        id: before.id,
        registryId: before.registryId,
        fields: { packagePath: movedRoot },
      });
      expect(state.db!.prepare('SELECT * FROM pages WHERE id = ?').get(id)).toEqual(pageBefore);
      expect(await readFile(join(movedRoot, '.forge/notebook.json'), 'utf8')).toBe(metadataBytes);
      expect(await readFile(join(movedRoot, `${title}.md`), 'utf8')).toBe(markdownBytes);

      const archived = await createLimsBridgeForDb(state.db!).archiveEntity({ id });
      await reconcileMountedWorkspaceRoot(root);
      expect(await state.bridge!.lims.queryEntities({ id })).toEqual([]);
      expect(
        (await state.bridge!.lims.queryEntities({ id, includeArchived: true }))[0]
      ).toMatchObject({
        registryId: before.registryId,
        tombstone: true,
        archivedAt: archived.archivedAt,
        fields: { packagePath: movedRoot },
      });
    }
  );
});
