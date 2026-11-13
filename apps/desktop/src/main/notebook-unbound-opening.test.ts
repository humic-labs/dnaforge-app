import type Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  db: null as Database.Database | null,
  bridge: null as ReturnType<typeof createBridgeFixture> | null,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      state.handlers.set(channel, handler),
  },
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) =>
      state.handlers.get(channel)!({ sender }, ...args),
  },
  app: { getPath: () => '/tmp', getVersion: () => 'test', exit: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('../platform', () => ({ platform: () => state.bridge }));
vi.mock('./ipc/database', async (importActual) => ({
  ...(await importActual<object>()),
  getDb: () => state.db,
}));
vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('../lib/analytics', async (importActual) => ({
  ...(await importActual<object>()),
  trackRendererEvent: vi.fn(),
}));

import { createFileTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { registerDatabaseHandlers } from './ipc/database';
import { createClient } from '../shared/ipc-contract';
import { dbContract } from '../shared/ipc/db.contract';
import { publishNotebookPackageV2InMain } from './notebook-package-authority';
import {
  buildNotebookPackageDocument,
  notebookPackagePaths,
  serializeNotebookPackageDocument,
} from '../db/notebook-package';
import { resolveArtifactFile } from '../db/workspace-artifacts';
import { openWorkspaceDocument } from '../features/page/open-workspace-document';
import { usePageStore } from '../features/page/store';
import { useCanvasStore } from '../features/canvas/store';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { requireNotebookCommitFingerprint } from '../features/page/embeds/table/notebook-observation';
import { notebookProjectionFingerprint } from '../shared/notebook-projection';

const sender = Object.assign(new EventEmitter(), { id: 366118 });
let fixture: ReturnType<typeof createFileTestDb>;
let root: string;
const id = 'loose-compatible-notebook';
const content = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Existing loose notebook' }] }],
};

beforeEach(async () => {
  fixture = createFileTestDb('unbound-notebook-open');
  state.db = fixture.db;
  ensureSchema(state.db, fixture.dbPath);
  root = join(fixture.tmpDir, 'outside-projects');
  await mkdir(root);
  state.handlers.clear();
  registerDatabaseHandlers(() => state.db!);
  state.bridge = createBridgeFixture(state.handlers);
  useWorkspaceStore.setState({ folders: [], selectedPath: null });
  usePageStore.setState({
    initialized: true,
    pages: {},
    pageList: [],
    dirtyIds: new Set(),
    listLoaded: true,
  });
  useCanvasStore.setState({
    panels: { main: { id: 'main', tabs: [], activeTabId: null } },
    focusedPanelId: 'main',
    layout: { type: 'panel', panelId: 'main' },
  });
});

function createBridgeFixture(handlers: Map<string, (...args: unknown[]) => unknown>) {
  return {
    db: {
      ...createClient(dbContract),
      select: async (sql: string, parameters?: unknown[]) =>
        handlers.get('db:select')!({ sender }, sql, parameters),
    },
    fs: {
      exists: async (path: string) =>
        access(path).then(
          () => true,
          () => false
        ),
      readTextFile: (path: string) => readFile(path, 'utf8'),
      stat: async (path: string) => {
        const value = await stat(path);
        return { mtime: value.mtimeMs, size: value.size };
      },
      readDir: async (path: string) =>
        (await readdir(path, { withFileTypes: true })).map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile(),
        })),
      recoverNotebookPackageRenameIfNeededInMain: async () => null,
    },
  };
}

afterEach(() => fixture.cleanup());

async function seedDatabaseOnlyNotebook(): Promise<void> {
  await state.bridge!.db.mutateLegacyNotebookPage({
    operation: 'create',
    id,
    title: 'Historical notebook',
    content,
    updatedAt: Date.now(),
    expectedProjectionFingerprint: null,
  });
  expect(await usePageStore.getState().refreshNewPages()).toBe(1);
}

describe('confirmed historical database-only notebook saves', () => {
  it('confirms the exact native committed row without adding a file or project owner', async () => {
    await seedDatabaseOnlyNotebook();
    const changed = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Confirmed legacy edit' }] }],
    };
    const fingerprint = await usePageStore.getState().savePage(id, changed);
    expect(requireNotebookCommitFingerprint(fingerprint)).toBe(
      notebookProjectionFingerprint('Historical notebook', changed)
    );
    expect(state.db!.prepare('SELECT id,title,content FROM pages WHERE id=?').get(id)).toEqual({
      id,
      title: 'Historical notebook',
      content: JSON.stringify(changed),
    });
    expect(usePageStore.getState().pages[id]?.content).toEqual(changed);
    expect(state.db!.prepare('SELECT * FROM workspaces').all()).toEqual([]);
    expect(state.db!.prepare('SELECT * FROM catalog_entities').all()).toEqual([]);
    expect(state.db!.prepare('SELECT * FROM entity_projection_sources').all()).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  });

  it('retains the dirty editor and refuses confirmation when native legacy commit acknowledgement is missing', async () => {
    await seedDatabaseOnlyNotebook();
    const previous = usePageStore.getState().pages[id];
    const rows = state.db!.prepare('SELECT * FROM pages WHERE id=?').all(id);
    usePageStore.getState().setDirty(id, true);
    vi.spyOn(state.bridge!.db, 'mutateLegacyNotebookPage').mockResolvedValueOnce(null);
    await expect(
      usePageStore.getState().savePage(id, { type: 'doc', content: [] })
    ).rejects.toThrow(/legacy.*confirmed/i);
    expect(usePageStore.getState().pages[id]).toBe(previous);
    expect(usePageStore.getState().dirtyIds.has(id)).toBe(true);
    expect(state.db!.prepare('SELECT * FROM pages WHERE id=?').all(id)).toEqual(rows);
  });
});

describe('read-only compatibility for notebooks outside projects', () => {
  it.each(['package', 'legacy'] as const)(
    'opens an existing %s through the actual product handler without granting a workspace owner',
    async (kind) => {
      const path = kind === 'legacy' ? join(root, 'Loose.wpnote.json') : join(root, 'Loose');
      if (kind === 'legacy')
        await writeFile(
          path,
          serializeNotebookPackageDocument(
            buildNotebookPackageDocument({ id, title: 'Loose', content })
          )
        );
      else
        await publishNotebookPackageV2InMain({
          workspaceRoot: root,
          packageRoot: path,
          id,
          title: 'Loose',
          content,
          sourceShape: 'new-package',
        });
      const authorityPath = kind === 'legacy' ? path : notebookPackagePaths(path).markdownPath;
      const before = await readFile(authorityPath, 'utf8');
      const resolved = await resolveArtifactFile({ path, workspaceRoot: null });
      expect(resolved.entity).toMatchObject({ id, workspace_id: null });
      expect(
        state
          .db!.prepare('SELECT workspace_id,path FROM catalog_entity_files WHERE entity_id=?')
          .get(id)
      ).toEqual({ workspace_id: null, path });
      const opened = await openWorkspaceDocument({
        target: { kind: 'file', path, tabType: 'page' },
        label: 'Loose',
      });
      expect(opened).toMatchObject({ status: 'presented', tabType: 'page', content: 'ready' });
      expect(useCanvasStore.getState().panels.main.tabs).toMatchObject([
        { type: 'page', entityId: id },
      ]);
      expect(usePageStore.getState().pages[id]?.content).toEqual(content);
      expect(state.db!.prepare('SELECT * FROM workspaces').all()).toEqual([]);
      expect(
        state.db!.prepare('SELECT workspace_key,entity_id FROM entity_projection_sources').all()
      ).toEqual([{ workspace_key: 'unbound', entity_id: id }]);
      await expect(
        usePageStore.getState().savePage(id, { type: 'doc', content: [] })
      ).rejects.toThrow('PAGE_WORKSPACE_OWNER_INVALID');
      expect(await readFile(authorityPath, 'utf8')).toBe(before);
      expect(
        (state.db!.prepare('SELECT content FROM pages WHERE id=?').get(id) as { content: string })
          .content
      ).toBe(JSON.stringify(content));
    }
  );
});
