import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { JSONContent } from '@tiptap/core';
import { createFileTestDb } from '../../main/__tests__/test-db';
import { ensureSchema } from '../../main/schema';
import { ensureWorkspaceOwnerInDb } from '../../main/catalog-projection-commands';
import { registerCatalogEntityInDb } from '../../main/catalog-entity-registration';
import { bindCatalogEntityFileInDb } from '../../main/catalog-file-binding';
import { publishNotebookPackageV2InMain } from '../../main/notebook-package-authority';
import { replaceNotebookProjectionFromFileInMain } from '../../main/notebook-projection-authority';
import { notebookPackagePaths } from '../notebook-package';
import { settlePublishedNotebookProjection } from './notebook-adapter';
import { notebookProjectionFingerprint } from '../../shared/notebook-projection';

const state = vi.hoisted(() => ({ db: null as Database.Database | null }));
vi.mock('../../platform', () => ({
  platform: () => ({
    db: {
      select: async (sql: string, parameters: unknown[] = []) =>
        state.db!.prepare(sql).all(...parameters),
      execute: async (sql: string, parameters: unknown[] = []) =>
        state.db!.prepare(sql).run(...parameters),
      replaceNotebookProjection: async (
        input: Parameters<typeof replaceNotebookProjectionFromFileInMain>[1]
      ) => replaceNotebookProjectionFromFileInMain(state.db!, input),
    },
  }),
}));
vi.mock('../workspace-catalog', () => ({
  resolveWorkspaceId: async () => 1,
  resolveWorkspaceScope: async () => 'receipt-scope',
}));

let fixture: ReturnType<typeof createFileTestDb>;
let input: Parameters<typeof settlePublishedNotebookProjection>[0];
let markdownPath: string;
const content: JSONContent = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'canonical receipt body' }] }],
};
function projection() {
  return state.db!.prepare('SELECT title,content FROM pages WHERE id=?').get(input.pageId);
}
function receipts() {
  return state.db!.prepare('SELECT synchronized_fingerprint FROM entity_projection_sources').all();
}
function seed(title = input.title) {
  state
    .db!.prepare('INSERT INTO pages(id,title,content,created_at,updated_at) VALUES(?,?,?,1,1)')
    .run(input.pageId, title, JSON.stringify(content));
}

describe('notebook projection commit receipt through real files and SQLite', () => {
  beforeEach(async () => {
    fixture = createFileTestDb('notebook-commit-receipt');
    state.db = fixture.db;
    ensureSchema(state.db, fixture.dbPath);
    const workspaceRoot = join(realpathSync(fixture.tmpDir), 'workspace');
    const packageRoot = join(workspaceRoot, 'Book');
    mkdirSync(packageRoot, { recursive: true });
    const workspaceId = ensureWorkspaceOwnerInDb(state.db, workspaceRoot);
    state.db
      .prepare('UPDATE workspaces SET repo_uuid=? WHERE id=?')
      .run('receipt-scope', workspaceId);
    const published = await publishNotebookPackageV2InMain({
      workspaceRoot,
      packageRoot,
      id: 'private-page',
      title: 'Private title',
      content,
      sourceShape: 'new-package',
    });
    input = {
      pageId: 'receipt-scope::private-page',
      title: 'Private title',
      content,
      workspaceRoot,
      artifact: {
        path: packageRoot,
        fileKind: 'waypoint-notebook',
        authorityFingerprint: published.canonicalFingerprint,
      },
    };
    markdownPath = notebookPackagePaths(packageRoot).markdownPath;
    registerCatalogEntityInDb(state.db, {
      id: input.pageId,
      type: 'notebook',
      name: input.title,
      locator: `entity://page/${input.pageId}`,
      storageType: 'file',
      workspaceRoot,
    });
    bindCatalogEntityFileInDb(state.db, {
      entityId: input.pageId,
      path: packageRoot,
      fileKind: 'waypoint-notebook',
      workspaceRoot,
    });
  });
  afterEach(() => fixture.cleanup());

  it('returns true only after the actual matching projection and synchronization record exist', async () => {
    seed();
    expect(await settlePublishedNotebookProjection(input)).toBe(true);
    expect(projection()).toEqual({ title: input.title, content: JSON.stringify(content) });
    expect(receipts()).toEqual([
      { synchronized_fingerprint: notebookProjectionFingerprint(input.title, content) },
    ]);
  });

  it.each(['absent', 'different'] as const)(
    'atomically refreshes a %s projection from the actual canonical publication',
    async (mode) => {
      if (mode === 'different') seed('different title');
      expect(await settlePublishedNotebookProjection(input)).toBe(true);
      expect(projection()).toEqual({ title: input.title, content: JSON.stringify(content) });
      expect(receipts()).toEqual([
        { synchronized_fingerprint: notebookProjectionFingerprint(input.title, content) },
      ]);
    }
  );

  it('requires an explicit native publication acknowledgement even when old matching bytes exist', async () => {
    seed();
    const before = projection();
    expect(
      await settlePublishedNotebookProjection({
        ...input,
        artifact: { ...input.artifact!, authorityFingerprint: undefined },
      })
    ).toBe(false);
    expect(projection()).toEqual(before);
    expect(receipts()).toEqual([]);
  });

  it('refuses a supplied publication claim whose candidate differs from actual canonical source', async () => {
    seed();
    const before = projection();
    const markdown = readFileSync(markdownPath);
    await expect(
      settlePublishedNotebookProjection({
        ...input,
        title: 'divergent candidate',
        artifact: { ...input.artifact!, authorityFingerprint: 'forged-publication-claim' },
      })
    ).rejects.toThrow('source changed');
    expect(projection()).toEqual(before);
    expect(receipts()).toEqual([]);
    expect(readFileSync(markdownPath)).toEqual(markdown);
  });

  it('preserves a concurrent projection instead of issuing a stale commit receipt', async () => {
    seed('concurrent projection');
    const before = projection();
    await expect(
      settlePublishedNotebookProjection({
        ...input,
        expectedProjectionFingerprint: notebookProjectionFingerprint(
          'previous projection',
          content
        ),
      })
    ).rejects.toThrow('projection changed');
    expect(projection()).toEqual(before);
    expect(receipts()).toEqual([]);
  });

  it('rolls back the actual projection when its equality receipt cannot commit', async () => {
    seed('prior projection');
    const before = projection();
    const markdown = readFileSync(markdownPath);
    state.db!.exec(
      "CREATE TRIGGER refuse_notebook_receipt BEFORE INSERT ON entity_projection_sources BEGIN SELECT RAISE(ABORT, 'controlled receipt failure'); END"
    );
    await expect(settlePublishedNotebookProjection(input)).rejects.toThrow(
      'controlled receipt failure'
    );
    expect(projection()).toEqual(before);
    expect(receipts()).toEqual([]);
    expect(readFileSync(markdownPath)).toEqual(markdown);
  });
});
