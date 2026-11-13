/** @vitest-environment node */
import type Database from 'better-sqlite3';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileTestDb, openFileTestDb } from '../main/__tests__/test-db';

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '1.0.0') },
}));
vi.mock('../main/analytics', () => ({ trackEvent: vi.fn() }));
let db: Database.Database;
vi.mock('../platform', () => ({
  platform: () => ({
    fs: {
      readTextFile: (path: string) => readFile(path, 'utf8'),
    },
    db: {
      replaceNotebookProjection: (
        input: Parameters<typeof replaceNotebookProjectionFromFileInMain>[1]
      ) => replaceNotebookProjectionFromFileInMain(db, input),
      settleEntityProjectionSource: (
        input: Parameters<typeof settleEntityProjectionSourceInMain>[1]
      ) => settleEntityProjectionSourceInMain(db, input),
      select: async (sql: string, params: unknown[] = []) => db.prepare(sql).all(...params),
      execute: async (sql: string, params: unknown[] = []) => db.prepare(sql).run(...params),
    },
  }),
}));
const artifacts = vi.hoisted(() => ({ resolve: vi.fn(), publish: vi.fn() }));
vi.mock('../db/workspace-artifacts', () => ({
  planWorkspaceArtifactRepair: async () => ({ kind: 'no-op' }),
  applyAcceptedWorkspaceArtifactRepair: vi.fn(),
  resolveArtifactFile: artifacts.resolve,
  artifactStemFromFileName: (name: string) => name,
  renameNotebookArtifactFile: vi.fn(),
  resolveNotebookArtifactWorkspaceOwner: async () => ({
    status: 'bound',
    workspaceRoot: root,
  }),
  writeNotebookArtifactSnapshot: artifacts.publish,
  trashNotebookArtifactForPage: vi.fn(),
}));
vi.mock('../db/workspace-catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db/workspace-catalog')>()),
  resolveWorkspaceId: async () => 7,
  resolveWorkspaceScope: async () => 'ws7',
  getCurrentCatalogFileForEntity: async (id: string) =>
    db.prepare("SELECT * FROM catalog_entity_files WHERE entity_id=? AND status='current'").get(id),
}));
vi.mock('./workspace-mutation-transaction', () => ({
  withRendererWorkspaceMutation: async (
    _root: string,
    operation: (token: string) => Promise<unknown>
  ) => operation('borrowed-open-token'),
}));

import { ensureSchema } from '../main/schema';
import { replaceNotebookProjectionFromFileInMain } from '../main/notebook-projection-authority';
import { settleEntityProjectionSourceInMain } from '../main/entity-projection-receipts';
import { publishNotebookPackageV2InMain } from '../main/notebook-package-authority';
import { notebookPackagePaths } from '../db/notebook-package';
import { reconcileEntityFile } from '../db/entity-substrate/adapter';
import { notebookEntityAdapter } from '../db/entity-substrate/notebook-adapter';
import { NOTEBOOK_PACKAGE_SCHEMA } from '../db/notebook-package';
import { scopedProjectionId } from '../shared/workspace-scoped-identity';
import { useToastStore } from '../stores/toast-store';
import { withWorkspaceArtifactOpen } from './workspace-artifact-open';
import { usePageStore } from '../features/page/store';

let root: string;
let path: string;
const pageId = scopedProjectionId('ws7', 'portable-notebook-id');
const content = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
const document = (text: string) => ({
  schema: NOTEBOOK_PACKAGE_SCHEMA,
  kind: 'notebook' as const,
  id: 'portable-notebook-id',
  title: 'Content convergence',
  content: content(text),
  updatedAt: '2026-10-01T00:00:00.000Z',
  storage: { type: 'database' as const, table: 'pages' as const, id: 'portable-notebook-id' },
});
const ctx = { workspaceId: 7, workspaceScope: 'ws7' };

describe('notebook opening keeps competing content across SQLite reload', () => {
  let fixture: ReturnType<typeof createFileTestDb>;
  beforeEach(async () => {
    fixture = createFileTestDb('notebook-open-common-base');
    db = fixture.db;
    ensureSchema(db, fixture.dbPath);
    useToastStore.setState({ toasts: [] });
    root = join(fixture.tmpDir, 'project');
    await mkdir(root);
    path = join(root, 'Content convergence', '.forge', 'notebook.json');
    db.prepare('INSERT INTO workspaces(id,name,path,created_at) VALUES(7,?,?,1)').run(
      'Project',
      root
    );
    db.prepare(
      `INSERT INTO catalog_entities(id,type,name,locator,storage_type,workspace_id,created_at,updated_at)
      VALUES(?,'notebook','Content convergence',?,'file',7,1,1)`
    ).run(pageId, `entity://page/${pageId}`);
    db.prepare(
      `INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,file_kind,status,created_at,updated_at)
      VALUES('notebook-binding',?,7,?,'waypoint-notebook','current',1,1)`
    ).run(pageId, join(root, 'Content convergence'));
    await publishNotebookPackageV2InMain({
      packageRoot: join(root, 'Content convergence'),
      workspaceRoot: root,
      id: 'portable-notebook-id',
      title: 'Content convergence',
      content: content('base'),
      sourceShape: 'new-package',
    });
    artifacts.publish.mockImplementation(async (input) => {
      const packageRoot = join(root, 'Content convergence');
      const published = await publishNotebookPackageV2InMain({
        packageRoot,
        workspaceRoot: root,
        id: 'portable-notebook-id',
        title: input.title,
        content: input.content,
        sourceShape: 'v2-package',
        existingMetadataRaw: await readFile(notebookPackagePaths(packageRoot).metaPath, 'utf8'),
        expectedCanonicalFingerprint: input.expectedCanonicalFingerprint,
        expectedProjectionContent: input.expectedProjectionContent,
      });
      return {
        path: packageRoot,
        name: 'Content convergence',
        fileKind: 'waypoint-notebook',
        sizeBytes: published.markdownBytes,
        authorityFingerprint: published.canonicalFingerprint,
      };
    });
    const fileAdapter = {
      ...notebookEntityAdapter,
      parseSource: undefined,
      parse: (bytes: string) => JSON.parse(bytes),
    };
    await reconcileEntityFile(fileAdapter, JSON.stringify(document('base')), path, 100, {
      ...ctx,
      workspaceRoot: root,
    });
    db.close();
    db = openFileTestDb(fixture.dbPath);
    usePageStore.setState({
      initialized: true,
      listLoaded: true,
      pages: {
        [pageId]: {
          id: pageId,
          title: 'Content convergence',
          content: content('base'),
          date: null,
          createdAt: new Date(100),
          updatedAt: new Date(100),
        },
      },
      pageList: [],
      dirtyIds: new Set(),
    });
  });
  afterEach(() => {
    if (db.open && db !== fixture.db) db.close();
    fixture.cleanup();
  });

  async function resolveSavedFile(text: string) {
    const packageRoot = join(root, 'Content convergence');
    const published = await publishNotebookPackageV2InMain({
      packageRoot,
      workspaceRoot: root,
      id: 'portable-notebook-id',
      title: 'Content convergence',
      content: content(text),
      sourceShape: 'v2-package',
      existingMetadataRaw: await readFile(notebookPackagePaths(packageRoot).metaPath, 'utf8'),
    });
    artifacts.resolve.mockResolvedValue({
      entity: { id: pageId },
      artifact: { ...document(text), raw: document(text) },
      repaired: false,
      authorityFingerprint: published.canonicalFingerprint,
      sourceFingerprints: [],
    });
  }
  const projectedContent = () =>
    (db.prepare('SELECT content FROM pages WHERE id = ?').get(pageId) as { content: string })
      .content;
  const consumer = () =>
    vi.fn(async (resolved) => {
      db.prepare('UPDATE pages SET content = ? WHERE id = ?').run(
        JSON.stringify(resolved.artifact.content),
        pageId
      );
    });

  it('rejects a restored-tab/open consumer before it can overwrite genuine divergent edits', async () => {
    db.prepare('UPDATE pages SET content = ? WHERE id = ?').run(
      JSON.stringify(content('app edit')),
      pageId
    );
    await resolveSavedFile('file edit');
    const consume = consumer();

    await expect(
      withWorkspaceArtifactOpen({ path, workspaceRoot: root, consume })
    ).rejects.toMatchObject({ code: 'NOTEBOOK_EXTERNAL_CONFLICT' });
    expect(consume).not.toHaveBeenCalled();
    expect(projectedContent()).toContain('app edit');
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({
        message: expect.stringMatching(
          /Content convergence.*differs from the application copy.*Both versions are retained/
        ),
      }),
    ]);
  });

  it('accepts a file-only change, then detects the next concurrent edit against that durable base', async () => {
    await resolveSavedFile('file-only edit');
    await withWorkspaceArtifactOpen({ path, workspaceRoot: root, consume: consumer() });
    expect(projectedContent()).toContain('file-only edit');
    db.prepare('UPDATE pages SET content = ? WHERE id = ?').run(
      JSON.stringify(content('next app edit')),
      pageId
    );
    await resolveSavedFile('next file edit');

    await expect(
      withWorkspaceArtifactOpen({ path, workspaceRoot: root, consume: consumer() })
    ).rejects.toMatchObject({ code: 'NOTEBOOK_EXTERNAL_CONFLICT' });
    expect(projectedContent()).toContain('next app edit');
  });

  it('settles a successful product save before the next file-only edit arrives', async () => {
    await usePageStore.getState().savePage(pageId, content('product saved revision'));
    expect(projectedContent()).toContain('product saved revision');
    db.close();
    db = openFileTestDb(fixture.dbPath);
    await resolveSavedFile('external edit after product save');
    await expect(
      withWorkspaceArtifactOpen({ path, workspaceRoot: root, consume: consumer() })
    ).resolves.toBeUndefined();
    expect(projectedContent()).toContain('external edit after product save');
  });

  it('uses the saved version only after the user explicitly chooses Reload', async () => {
    db.prepare('UPDATE pages SET content = ? WHERE id = ?').run(
      JSON.stringify(content('app edit')),
      pageId
    );
    await resolveSavedFile('file edit');
    await withWorkspaceArtifactOpen({
      path,
      workspaceRoot: root,
      consume: consumer(),
      notebookConflictResolution: 'use-file',
    });
    expect(projectedContent()).toContain('file edit');
    db.prepare('UPDATE pages SET content = ? WHERE id = ?').run(
      JSON.stringify(content('later app edit')),
      pageId
    );
    await resolveSavedFile('later file edit');
    await expect(
      withWorkspaceArtifactOpen({ path, workspaceRoot: root, consume: consumer() })
    ).rejects.toMatchObject({ code: 'NOTEBOOK_EXTERNAL_CONFLICT' });
  });
});
