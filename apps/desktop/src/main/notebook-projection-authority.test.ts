import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import type { JSONContent } from '@tiptap/core';
import { createFileTestDb } from './__tests__/test-db';

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
}));
vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));

import { ensureSchema } from './schema';
import { publishNotebookPackageV2InMain } from './__tests__/publish-notebook-fixture';
import { withRendererEntitySql } from './renderer-entity-sql';
import {
  buildNotebookPackageDocument,
  notebookPackagePaths,
  serializeNotebookPackageDocument,
} from '../db/notebook-package';
import {
  deleteNotebookPageInMain,
  mutateLegacyNotebookPageInDb,
  replaceNotebookProjectionFromFileInMain,
} from './notebook-projection-authority';
import { settleEntityProjectionSourceInMain } from './entity-projection-receipts';
import { notebookProjectionFingerprint } from '../shared/notebook-projection';
import { notebookPayloadPathsFromMarkdown } from '../db/notebook-markdown-codec';

let fixture: ReturnType<typeof createFileTestDb>;
let db: Database.Database;
let workspaceRoot: string;
let packageRoot: string;
const pageId = 'project-uuid::native-notebook';
const document: JSONContent = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'canonical file body' }] }],
};

function sourceKey() {
  return {
    adapterKind: 'notebook',
    entityId: pageId,
    workspaceKey: 'scope:project-uuid',
    relativePath: 'Lab notes/.forge/notebook.json',
    projectionVersion: 1,
  };
}

function project(
  title = 'Lab notes',
  content = document,
  expected = notebookProjectionFingerprint('Lab notes', document)
) {
  return replaceNotebookProjectionFromFileInMain(db, {
    pageId,
    workspaceRoot,
    sourcePath: notebookPackagePaths(packageRoot).metaPath,
    sourceFingerprint: notebookProjectionFingerprint(title, content),
    expectedProjectionFingerprint: expected,
  });
}

beforeEach(async () => {
  fixture = createFileTestDb('notebook-projection-authority');
  db = fixture.db;
  ensureSchema(db, fixture.dbPath);
  workspaceRoot = await mkdtemp(join(tmpdir(), 'fixture-native-notebook-'));
  packageRoot = join(workspaceRoot, 'Lab notes');
  await mkdir(packageRoot);
  await publishNotebookPackageV2InMain({
    packageRoot,
    workspaceRoot,
    id: 'native-notebook',
    title: 'Lab notes',
    content: document,
    sourceShape: 'new-package',
  });
  db.prepare('INSERT INTO workspaces(id,name,path,repo_uuid,created_at) VALUES(7,?,?,?,1)').run(
    'Project',
    workspaceRoot,
    'project-uuid'
  );
  db.prepare(
    `INSERT INTO catalog_entities(id,type,name,locator,storage_type,workspace_id,created_at,updated_at)
     VALUES(?,'notebook','Lab notes',?,'file',7,1,1)`
  ).run(pageId, `entity://page/${pageId}`);
  db.prepare(
    `INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,file_kind,status,created_at,updated_at)
     VALUES('notebook-file',?,7,?,'waypoint-notebook','current',1,1)`
  ).run(pageId, packageRoot);
  db.prepare('INSERT INTO pages(id,title,content,created_at,updated_at) VALUES(?,?,?,1,1)').run(
    pageId,
    'Lab notes',
    JSON.stringify(document)
  );
});

afterEach(async () => {
  fixture.cleanup();
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe('notebook native projection authority', () => {
  it('derives a matching native projection and equality receipt from real canonical files', async () => {
    const row = await project();
    expect(row).toMatchObject({
      id: pageId,
      title: 'Lab notes',
      content: JSON.stringify(document),
      created_at: 1,
    });
    expect(
      db
        .prepare(
          'SELECT adapter_kind,entity_id,workspace_key,relative_path,projection_version,synchronized_fingerprint FROM entity_projection_sources'
        )
        .all()
    ).toEqual([
      {
        adapter_kind: 'notebook',
        entity_id: pageId,
        workspace_key: 'scope:project-uuid',
        relative_path: 'Lab notes/.forge/notebook.json',
        projection_version: 1,
        synchronized_fingerprint: notebookProjectionFingerprint('Lab notes', document),
      },
    ]);
  });

  it('refuses to settle a file/projection mismatch and retains the last proven equal state', async () => {
    await project();
    const before = db.prepare('SELECT * FROM entity_projection_sources').all();
    db.prepare('UPDATE pages SET title=? WHERE id=?').run('unpublished projection', pageId);
    await expect(
      settleEntityProjectionSourceInMain(db, {
        key: sourceKey(),
        fingerprint: notebookProjectionFingerprint('unpublished projection', document),
      })
    ).rejects.toThrow('canonical file');
    await expect(
      settleEntityProjectionSourceInMain(db, {
        key: sourceKey(),
        fingerprint: notebookProjectionFingerprint('Lab notes', document),
      })
    ).rejects.toThrow('differs');
    expect(db.prepare('SELECT * FROM entity_projection_sources').all()).toEqual(before);
  });

  it('rejects stale source and stale projection claims without changing either authority', async () => {
    const markdownPath = notebookPackagePaths(packageRoot).markdownPath;
    const before = await readFile(markdownPath, 'utf8');
    await expect(project('stale source')).rejects.toThrow('source changed');
    db.prepare('UPDATE pages SET title=? WHERE id=?').run('concurrent projection edit', pageId);
    await expect(project()).rejects.toThrow('projection changed');
    expect(await readFile(markdownPath, 'utf8')).toBe(before);
    expect(db.prepare('SELECT * FROM entity_projection_sources').all()).toEqual([]);
  });

  it.each([
    { adapterKind: 'not-registered' },
    { projectionVersion: 99 },
    { entityId: 'other-project::native-notebook' },
    { workspaceKey: 'scope:other-project' },
    { relativePath: '../Lab notes/.forge/notebook.json' },
  ])('refuses a forged source key %j', async (patch) => {
    await expect(
      settleEntityProjectionSourceInMain(db, {
        key: { ...sourceKey(), ...patch },
        fingerprint: notebookProjectionFingerprint('Lab notes', document),
      })
    ).rejects.toThrow();
    expect(db.prepare('SELECT * FROM entity_projection_sources').all()).toEqual([]);
  });

  it('uses the actual Markdown title rather than stale metadata or timestamps', async () => {
    const paths = notebookPackagePaths(packageRoot);
    const markdown = await readFile(paths.markdownPath, 'utf8');
    await writeFile(paths.markdownPath, markdown.replace('# Lab notes', '# Edited in Markdown'));
    const row = await project('Edited in Markdown');
    expect(row.title).toBe('Edited in Markdown');
    expect(JSON.parse(await readFile(paths.metaPath, 'utf8')).title).toBe('Lab notes');
  });

  it('reads rich table payloads through the canonical codec and refuses altered payload bytes', async () => {
    const table = {
      type: 'doc',
      content: [
        {
          type: 'embed',
          attrs: {
            type: 'table',
            refId: 'table-1',
            data: { rows: 1, cols: 1, cells: { A1: { value: 'measured' } } },
          },
        },
      ],
    };
    const paths = notebookPackagePaths(packageRoot);
    await publishNotebookPackageV2InMain({
      packageRoot,
      workspaceRoot,
      id: 'native-notebook',
      title: 'Lab notes',
      content: table,
      sourceShape: 'v2-package',
      existingMetadataRaw: await readFile(paths.metaPath, 'utf8'),
    });
    await project('Lab notes', table);
    expect(
      (db.prepare('SELECT content FROM pages WHERE id=?').get(pageId) as { content: string })
        .content
    ).toBe(JSON.stringify(table));
    const before = db.prepare('SELECT * FROM entity_projection_sources').all();
    const [payload] = notebookPayloadPathsFromMarkdown(await readFile(paths.markdownPath, 'utf8'));
    await writeFile(join(packageRoot, payload), '{"tampered":true}');
    await expect(
      settleEntityProjectionSourceInMain(db, {
        key: sourceKey(),
        fingerprint: notebookProjectionFingerprint('Lab notes', table),
      })
    ).rejects.toThrow();
    expect(db.prepare('SELECT * FROM entity_projection_sources').all()).toEqual(before);
  });

  it('keeps valid legacy notebook files readable without authoring a second legacy format', async () => {
    const path = join(workspaceRoot, 'Legacy.wpnote.json');
    await writeFile(
      path,
      serializeNotebookPackageDocument(
        buildNotebookPackageDocument({
          id: 'native-notebook',
          title: 'Legacy title',
          content: document,
        })
      )
    );
    db.prepare('UPDATE catalog_entity_files SET path=? WHERE entity_id=?').run(path, pageId);
    const row = await replaceNotebookProjectionFromFileInMain(db, {
      pageId,
      workspaceRoot,
      sourcePath: path,
      sourceFingerprint: notebookProjectionFingerprint('Legacy title', document),
      expectedProjectionFingerprint: notebookProjectionFingerprint('Lab notes', document),
    });
    expect(row.title).toBe('Legacy title');
  });

  it('refuses a future notebook package without reinterpreting it as legacy content', async () => {
    const path = notebookPackagePaths(packageRoot).metaPath;
    const metadata = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...metadata, formatVersion: 99, content: document }));
    await expect(project()).rejects.toThrow('newer');
    expect(db.prepare('SELECT * FROM entity_projection_sources').all()).toEqual([]);
  });

  it('retains file bytes and old projection when SQLite refuses publication', async () => {
    await project();
    const paths = notebookPackagePaths(packageRoot);
    const changed = {
      ...document,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'new file edit' }] }],
    };
    await publishNotebookPackageV2InMain({
      packageRoot,
      workspaceRoot,
      id: 'native-notebook',
      title: 'Lab notes',
      content: changed,
      sourceShape: 'v2-package',
      existingMetadataRaw: await readFile(paths.metaPath, 'utf8'),
    });
    const publishedBytes = await readFile(paths.markdownPath, 'utf8');
    const before = db.prepare('SELECT * FROM entity_projection_sources').all();
    db.exec(
      "CREATE TEMP TRIGGER reject_notebook_projection BEFORE UPDATE ON pages BEGIN SELECT RAISE(ABORT,'injected publication failure'); END;"
    );
    await expect(project('Lab notes', changed)).rejects.toThrow('injected publication failure');
    expect(
      (db.prepare('SELECT content FROM pages WHERE id=?').get(pageId) as { content: string })
        .content
    ).toBe(JSON.stringify(document));
    expect(await readFile(paths.markdownPath, 'utf8')).toBe(publishedBytes);
    expect(db.prepare('SELECT * FROM entity_projection_sources').all()).toEqual(before);
  });

  it('keeps the database-only legacy route usable while refusing every file-backed identity', () => {
    const legacy = mutateLegacyNotebookPageInDb(db, {
      operation: 'create',
      id: 'legacy-page',
      title: 'Legacy notes',
      content: document,
      updatedAt: 10,
      expectedProjectionFingerprint: null,
    });
    expect(legacy?.title).toBe('Legacy notes');
    expect(
      mutateLegacyNotebookPageInDb(db, {
        operation: 'upsert',
        id: 'legacy-page',
        title: 'Legacy renamed',
        content: document,
        updatedAt: 20,
        expectedProjectionFingerprint: notebookProjectionFingerprint('Legacy notes', document),
      })?.title
    ).toBe('Legacy renamed');
    expect(() => mutateLegacyNotebookPageInDb(db, { operation: 'delete', id: pageId })).toThrow(
      'package authority'
    );
    db.prepare("UPDATE catalog_entity_files SET status='historical' WHERE entity_id=?").run(pageId);
    expect(() => mutateLegacyNotebookPageInDb(db, { operation: 'delete', id: pageId })).toThrow(
      'package authority'
    );
    const saved = db.prepare('SELECT * FROM pages WHERE id=?').get('legacy-page');
    expect(() =>
      mutateLegacyNotebookPageInDb(db, { operation: 'delete', id: 'legacy-page' })
    ).toThrow(/only saved copy/);
    expect(db.prepare('SELECT * FROM pages WHERE id=?').get('legacy-page')).toEqual(saved);
    expect(mutateLegacyNotebookPageInDb(db, { operation: 'delete', id: 'absent' })).toBeNull();
  });

  it('deletes a notebook by retiring its package, projection and receipt together', async () => {
    await project();
    expect(await deleteNotebookPageInMain(db, pageId)).toBe(true);
    expect(db.prepare('SELECT * FROM pages WHERE id=?').get(pageId)).toBeUndefined();
    expect(db.prepare('SELECT * FROM entity_projection_sources').all()).toEqual([]);
    expect(
      db.prepare('SELECT status FROM catalog_entity_files WHERE entity_id=?').get(pageId)
    ).toEqual({ status: 'historical' });
    await expect(access(packageRoot)).rejects.toThrow();
    expect(await readdir(join(workspaceRoot, '.waypoint', 'trash'))).toHaveLength(1);
  });

  it('refuses file deletion from a reference project and retains both file and projection', async () => {
    db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=7").run();
    await expect(deleteNotebookPageInMain(db, pageId)).rejects.toThrow('WORKSPACE_READ_ONLY');
    await expect(access(packageRoot)).resolves.toBeUndefined();
    expect(db.prepare('SELECT id FROM pages WHERE id=?').get(pageId)).toEqual({ id: pageId });
  });

  it('refuses raw renderer changes to a file-backed notebook projection', async () => {
    const before = await readFile(notebookPackagePaths(packageRoot).markdownPath, 'utf8');
    expect(() =>
      withRendererEntitySql(db, 'UPDATE pages SET title = ? WHERE id = ?', () =>
        db.prepare('UPDATE pages SET title = ? WHERE id = ?').run('forged title', pageId)
      )
    ).toThrow('ENTITY_IDENTITY_REQUIRES_NATIVE_COMMAND');
    expect(
      (db.prepare('SELECT title FROM pages WHERE id = ?').get(pageId) as { title: string }).title
    ).toBe('Lab notes');
    expect(await readFile(notebookPackagePaths(packageRoot).markdownPath, 'utf8')).toBe(before);
  });

  it('refuses raw renderer equality receipts even when the claimed fingerprint looks valid', () => {
    const sql = `INSERT INTO entity_projection_sources
      (adapter_kind,entity_id,workspace_key,relative_path,projection_version,synchronized_fingerprint,synchronized_at)
      VALUES('notebook',?,'scope:project-uuid',?,1,'0000000000000000',1)`;
    expect(() =>
      withRendererEntitySql(db, sql, () =>
        db.prepare(sql).run(pageId, 'Lab notes/.forge/notebook.json')
      )
    ).toThrow('ENTITY_IDENTITY_REQUIRES_NATIVE_COMMAND');
    expect(db.prepare('SELECT * FROM entity_projection_sources').all()).toEqual([]);
  });
});
