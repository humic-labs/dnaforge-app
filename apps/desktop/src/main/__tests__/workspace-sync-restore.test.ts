import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildNotebookPackageMetadata,
  buildNotebookPackageDocument,
  serializeNotebookPackageMetadata,
  serializeNotebookPackageDocument,
} from '../../db/notebook-package';
import { serializeNotebookMarkdown } from '../../db/notebook-markdown-codec';
import { registerLimsEntityInDb } from '../lims';
import { materializeLimsGitReadableExportInDb } from '../lims-git-export';
import { ensureSchema } from '../schema';
import { prepareWorkspaceSyncProjection } from '../workspace-sync-projection';
import { rehydrateWorkspaceSyncState, upsertNotebookCatalog } from '../workspace-sync-restore';
import { bindCatalogEntityFileInDb } from '../catalog-file-binding';
import { createTestDb } from './test-db';
import { notebookProjectionFingerprint } from '../../shared/notebook-projection';
import { scopedProjectionId } from '../../shared/workspace-scoped-identity';

const scopedId = (embeddedId: string) => scopedProjectionId('ws1', embeddedId);

function writeV2NotebookPackage(packageRoot: string, title: string, id: string): void {
  const canonical = serializeNotebookMarkdown({
    identity: { id, title, formatVersion: 2 },
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
  });
  mkdirSync(join(packageRoot, '.forge', 'blocks'), { recursive: true });
  writeFileSync(join(packageRoot, `${title}.md`), canonical.markdown, 'utf8');
  writeFileSync(
    join(packageRoot, '.forge', 'notebook.json'),
    serializeNotebookPackageMetadata(
      buildNotebookPackageMetadata({
        id,
        title,
        markdownFileName: `${title}.md`,
        updatedAt: '2026-08-25T00:00:00.000Z',
      })
    ),
    'utf8'
  );
  for (const payload of canonical.payloads) {
    const payloadPath = join(packageRoot, payload.relativePath);
    mkdirSync(join(payloadPath, '..'), { recursive: true });
    writeFileSync(payloadPath, payload.content, 'utf8');
  }
}

function seedNotebookProjection(
  db: Database.Database,
  workspaceRoot: string,
  title: string,
  portableId: string
): { packageRoot: string; projectionId: string } {
  const projectionId = scopedId(portableId);
  const packageRoot = join(workspaceRoot, title);
  db.prepare(
    `INSERT INTO pages (id, title, content, created_at, updated_at)
     VALUES (?, ?, ?, 1, 1)`
  ).run(
    projectionId,
    title,
    JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [] }] })
  );
  db.prepare(
    `INSERT INTO catalog_entities
     (id, type, name, locator, storage_type, status, workspace_id, metadata, created_at, updated_at)
     VALUES (?, 'notebook', ?, ?, 'file', 'active', 1, NULL, 1, 1)`
  ).run(projectionId, title, `entity://page/${projectionId}`);
  db.prepare(
    `INSERT INTO catalog_entity_files
     (id, entity_id, workspace_id, path, relative_path, file_kind, content_hash, size_bytes,
      modified_at, status, last_seen_at, missing_since, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?, 'waypoint-notebook', NULL, 0, 1,
             'current', 1, NULL, 1, 1)`
  ).run(`file-${projectionId}`, projectionId, packageRoot, title);
  return { packageRoot, projectionId };
}

describe('workspace sync restore rehydrate (A2)', () => {
  let db: Database.Database;
  let workspaceRoot: string;

  beforeEach(() => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    workspaceRoot = mkdtempSync(join(tmpdir(), 'dnaforge-sync-rehydrate-'));
    db.prepare(
      `INSERT INTO workspaces (id, name, path, created_at, last_opened_at)
       VALUES (1, 'Restored', ?, 1, 1)`
    ).run(workspaceRoot);
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
    db.close();
  });

  it('rehydrates pages + catalog exclusively from canonical v2 Markdown', () => {
    const packageRoot = join(workspaceRoot, 'Lab notes');
    mkdirSync(join(packageRoot, '.forge', 'blocks'), { recursive: true });
    mkdirSync(join(packageRoot, 'assets'), { recursive: true });
    const authoritativeUpdatedAt = '2026-08-25T19:42:17.456Z';
    const document = buildNotebookPackageDocument({
      id: 'page-restored-1',
      title: 'STALE JSON TITLE',
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'STALE JSON CONTENT' }] }],
      },
      updatedAt: authoritativeUpdatedAt,
    });
    const notebookPath = join(packageRoot, '.forge', 'notebook.json');
    const metadata = buildNotebookPackageMetadata({
      id: document.id,
      title: document.title,
      markdownFileName: 'Lab notes.md',
      updatedAt: authoritativeUpdatedAt,
    });
    const metadataBytes = serializeNotebookPackageMetadata(metadata);
    writeFileSync(notebookPath, metadataBytes, 'utf8');
    const canonical = serializeNotebookMarkdown({
      identity: { id: document.id, title: 'Lab notes', formatVersion: 2 },
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello from cloud' }] }],
      },
    });
    writeFileSync(join(packageRoot, 'Lab notes.md'), canonical.markdown, 'utf8');
    for (const payload of canonical.payloads) {
      const payloadPath = join(packageRoot, payload.relativePath);
      mkdirSync(join(payloadPath, '..'), { recursive: true });
      writeFileSync(payloadPath, payload.content, 'utf8');
    }

    const result = rehydrateWorkspaceSyncState(db, {
      workspaceId: 1,
      workspaceRoot,
      nowMs: 1000,
    });

    expect(result.notebooksRestored).toBe(1);
    expect(
      db
        .prepare(`SELECT title, content, updated_at FROM pages WHERE id = ?`)
        .get(scopedId('page-restored-1'))
    ).toMatchObject({
      title: 'Lab notes',
      updated_at: Date.parse(authoritativeUpdatedAt),
    });
    const page = db
      .prepare(`SELECT content FROM pages WHERE id = ?`)
      .get(scopedId('page-restored-1')) as {
      content: string;
    };
    expect(page.content).toContain('hello from cloud');
    expect(page.content).not.toContain('STALE JSON CONTENT');
    expect(
      db
        .prepare('SELECT synchronized_fingerprint FROM entity_projection_sources WHERE entity_id=?')
        .get(scopedId('page-restored-1'))
    ).toEqual({
      synchronized_fingerprint: notebookProjectionFingerprint('Lab notes', page.content),
    });

    expect(
      db
        .prepare(`SELECT path, file_kind, status FROM catalog_entity_files WHERE entity_id = ?`)
        .get(scopedId('page-restored-1'))
    ).toMatchObject({
      path: packageRoot,
      file_kind: 'waypoint-notebook',
      status: 'current',
    });

    prepareWorkspaceSyncProjection(db, { workspaceId: 1, workspaceRoot });
    expect(readFileSync(notebookPath, 'utf8')).toBe(metadataBytes);
    expect(readFileSync(join(packageRoot, 'Lab notes.md'), 'utf8')).toBe(canonical.markdown);
  });

  it('rejects orphan marked Markdown before changing an existing replica projection', () => {
    const { packageRoot, projectionId } = seedNotebookProjection(
      db,
      workspaceRoot,
      'Existing notebook',
      'page-existing'
    );
    const canonical = serializeNotebookMarkdown({
      identity: { id: 'page-existing', title: 'Existing notebook', formatVersion: 2 },
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
    });
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, 'Existing notebook.md'), canonical.markdown, 'utf8');

    expect(() =>
      rehydrateWorkspaceSyncState(db, {
        workspaceId: 1,
        workspaceRoot,
        nowMs: 2000,
        strict: true,
      })
    ).toThrow('missing package metadata');

    expect(db.prepare(`SELECT title FROM pages WHERE id = ?`).get(projectionId)).toEqual({
      title: 'Existing notebook',
    });
    expect(
      db.prepare(`SELECT status FROM catalog_entity_files WHERE entity_id = ?`).get(projectionId)
    ).toEqual({ status: 'current' });
  });

  it.each(['v2', 'legacy'] as const)(
    'rejects a nested %s notebook authority before changing replica projections',
    (nestedShape) => {
      const { projectionId } = seedNotebookProjection(
        db,
        workspaceRoot,
        'Preserved notebook',
        'page-preserved'
      );
      const outerRoot = join(workspaceRoot, 'Outer');
      writeV2NotebookPackage(outerRoot, 'Outer', 'outer-page');
      if (nestedShape === 'v2') {
        writeV2NotebookPackage(join(outerRoot, 'Inner'), 'Inner', 'inner-page');
      } else {
        writeFileSync(
          join(outerRoot, 'old.wpnote.json'),
          JSON.stringify({
            schema: 'waypoint.notebook.v1',
            kind: 'notebook',
            id: 'inner-page',
            title: 'Inner',
            content: { type: 'doc', content: [] },
            updatedAt: '2026-08-25T00:00:00.000Z',
            storage: { type: 'database', table: 'pages', id: 'inner-page' },
          }),
          'utf8'
        );
      }

      expect(() =>
        rehydrateWorkspaceSyncState(db, {
          workspaceId: 1,
          workspaceRoot,
          nowMs: 2000,
          strict: true,
        })
      ).toThrow('nested inside another notebook package');
      expect(db.prepare(`SELECT title FROM pages WHERE id = ?`).get(projectionId)).toEqual({
        title: 'Preserved notebook',
      });
    }
  );

  it('rehydrates legacy .wpnote.json notebooks', () => {
    const legacyPath = join(workspaceRoot, 'Old.wpnote.json');
    writeFileSync(
      legacyPath,
      JSON.stringify({
        schema: 'waypoint.notebook.v1',
        kind: 'notebook',
        id: 'page-legacy-1',
        title: 'Old',
        content: { type: 'doc', content: [] },
        updatedAt: new Date().toISOString(),
        storage: { type: 'database', table: 'pages', id: 'page-legacy-1' },
      }),
      'utf8'
    );

    const result = rehydrateWorkspaceSyncState(db, {
      workspaceId: 1,
      workspaceRoot,
      nowMs: 2000,
    });

    expect(result.notebooksRestored).toBe(1);
    expect(
      db.prepare(`SELECT id FROM pages WHERE id = ?`).get(scopedId('page-legacy-1'))
    ).toBeTruthy();
  });

  it.each([
    ['missing', undefined, '1970-01-01T00:00:00.000Z'],
    ['malformed', 'not-a-timestamp', '1970-01-01T00:00:00.000Z'],
    ['timezone-less', '2026-08-25T19:42:17.456', '2026-08-25T19:42:17.456Z'],
    ['offset-bearing', '2026-08-25T19:42:17.456+05:00', '2026-08-25T14:42:17.456Z'],
  ])(
    'normalizes a %s legacy notebook timestamp deterministically during strict restore',
    (_case, updatedAt, canonicalUpdatedAt) => {
      const packageRoot = join(workspaceRoot, `Legacy timestamp ${_case}`);
      mkdirSync(join(packageRoot, '.forge'), { recursive: true });
      const document: Record<string, unknown> = {
        schema: 'waypoint.notebook.v1',
        kind: 'notebook',
        id: `page-legacy-timestamp-${_case}`,
        title: `Legacy timestamp ${_case}`,
        content: { type: 'doc', content: [] },
        storage: {
          type: 'database',
          table: 'pages',
          id: `page-legacy-timestamp-${_case}`,
        },
      };
      if (updatedAt !== undefined) document.updatedAt = updatedAt;
      writeFileSync(
        join(packageRoot, '.forge', 'notebook.json'),
        `${JSON.stringify(document)}\n`,
        'utf8'
      );

      expect(
        rehydrateWorkspaceSyncState(db, {
          workspaceId: 1,
          workspaceRoot,
          nowMs: 2_000,
          strict: true,
        })
      ).toMatchObject({ notebooksRestored: 1 });
      expect(
        db
          .prepare(`SELECT updated_at FROM pages WHERE id = ?`)
          .get(scopedId(`page-legacy-timestamp-${_case}`))
      ).toMatchObject({ updated_at: Date.parse(canonicalUpdatedAt) });
    }
  );

  it('never follows symlinked notebook paths outside the restored workspace', () => {
    const outsideRoot = mkdtempSync(join(tmpdir(), 'dnaforge-sync-rehydrate-outside-'));
    try {
      const outsidePackage = join(outsideRoot, 'Outside notebook');
      mkdirSync(join(outsidePackage, '.forge'), { recursive: true });
      const outsideDocument = buildNotebookPackageDocument({
        id: 'page-outside-1',
        title: 'Outside notebook',
        content: { type: 'doc', content: [] },
      });
      writeFileSync(
        join(outsidePackage, '.forge', 'notebook.json'),
        serializeNotebookPackageDocument(outsideDocument),
        'utf8'
      );

      symlinkSync(outsidePackage, join(workspaceRoot, 'linked-package'), 'dir');
      const linkedForgePackage = join(workspaceRoot, 'linked-forge-package');
      mkdirSync(linkedForgePackage, { recursive: true });
      symlinkSync(join(outsidePackage, '.forge'), join(linkedForgePackage, '.forge'), 'dir');
      symlinkSync(workspaceRoot, join(workspaceRoot, 'cycle'), 'dir');

      expect(
        rehydrateWorkspaceSyncState(db, {
          workspaceId: 1,
          workspaceRoot,
          nowMs: 2000,
          strict: true,
        })
      ).toMatchObject({ notebooksRestored: 0 });
      expect(
        db.prepare(`SELECT id FROM pages WHERE id = ?`).get(scopedId('page-outside-1'))
      ).toBeUndefined();
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it('does not rewrite a legacy notebook while preparing a sync snapshot', () => {
    const pageId = scopedId('page-legacy-migration');
    const legacyPath = join(workspaceRoot, 'Migrated.wpnote.json');
    const packageRoot = join(workspaceRoot, 'Migrated');
    writeFileSync(
      legacyPath,
      JSON.stringify({
        schema: 'waypoint.notebook.v1',
        kind: 'notebook',
        id: pageId,
        title: 'Migrated',
        content: { type: 'doc', content: [] },
        updatedAt: new Date(1).toISOString(),
        storage: { type: 'database', table: 'pages', id: pageId },
      }),
      'utf8'
    );
    db.prepare(
      `INSERT INTO pages (id, title, content, created_at, updated_at)
       VALUES (?, 'Migrated', ?, 1, 1)`
    ).run(pageId, JSON.stringify({ type: 'doc', content: [] }));
    db.prepare(
      `INSERT INTO catalog_entities
       (id, type, name, locator, storage_type, status, workspace_id, metadata, created_at, updated_at)
       VALUES (?, 'notebook', 'Migrated', ?, 'file', 'active', 1, NULL, 1, 1)`
    ).run(pageId, `entity://page/${pageId}`);
    db.prepare(
      `INSERT INTO catalog_entity_files
       (id, entity_id, workspace_id, path, relative_path, file_kind, content_hash, size_bytes,
        modified_at, status, last_seen_at, missing_since, created_at, updated_at)
       VALUES (?, ?, 1, ?, 'Migrated.wpnote.json', 'waypoint-notebook', NULL, 0, 1,
               'current', 1, NULL, 1, 1)`
    ).run(`file-${pageId}`, pageId, legacyPath);

    expect(() =>
      prepareWorkspaceSyncProjection(db, { workspaceId: 1, workspaceRoot })
    ).not.toThrow();
    expect(existsSync(legacyPath)).toBe(true);
    expect(existsSync(join(packageRoot, '.forge', 'notebook.json'))).toBe(false);
    expect(
      db
        .prepare(`SELECT path, relative_path FROM catalog_entity_files WHERE id = ?`)
        .get(`file-${pageId}`)
    ).toEqual({ path: legacyPath, relative_path: 'Migrated.wpnote.json' });
    expect(() =>
      rehydrateWorkspaceSyncState(db, {
        workspaceId: 1,
        workspaceRoot,
        nowMs: 2000,
        strict: true,
      })
    ).not.toThrow();
  });

  it('does not touch an unrelated folder or legacy notebook during sync preparation', () => {
    const pageId = scopedId('page-legacy-collision');
    const legacyPath = join(workspaceRoot, 'Migrated.wpnote.json');
    const occupiedRoot = join(workspaceRoot, 'Migrated');
    mkdirSync(join(occupiedRoot, '.forge'), { recursive: true });
    writeFileSync(join(occupiedRoot, '.forge', 'notebook.json'), 'sentinel metadata', 'utf8');
    writeFileSync(join(occupiedRoot, 'Migrated.md'), 'sentinel markdown', 'utf8');
    writeFileSync(
      legacyPath,
      JSON.stringify({
        schema: 'waypoint.notebook.v1',
        kind: 'notebook',
        id: pageId,
        title: 'Migrated',
        content: { type: 'doc', content: [] },
        updatedAt: new Date(1).toISOString(),
        storage: { type: 'database', table: 'pages', id: pageId },
      }),
      'utf8'
    );
    db.prepare(
      `INSERT INTO pages (id, title, content, created_at, updated_at)
       VALUES (?, 'Migrated', ?, 1, 1)`
    ).run(pageId, JSON.stringify({ type: 'doc', content: [] }));
    db.prepare(
      `INSERT INTO catalog_entities
       (id, type, name, locator, storage_type, status, workspace_id, metadata, created_at, updated_at)
       VALUES (?, 'notebook', 'Migrated', ?, 'file', 'active', 1, NULL, 1, 1)`
    ).run(pageId, `entity://page/${pageId}`);
    db.prepare(
      `INSERT INTO catalog_entity_files
       (id, entity_id, workspace_id, path, relative_path, file_kind, content_hash, size_bytes,
        modified_at, status, last_seen_at, missing_since, created_at, updated_at)
       VALUES (?, ?, 1, ?, 'Migrated.wpnote.json', 'waypoint-notebook', NULL, 0, 1,
               'current', 1, NULL, 1, 1)`
    ).run(`file-${pageId}`, pageId, legacyPath);

    expect(() =>
      prepareWorkspaceSyncProjection(db, { workspaceId: 1, workspaceRoot })
    ).not.toThrow();

    const binding = db
      .prepare(`SELECT path, relative_path FROM catalog_entity_files WHERE id = ?`)
      .get(`file-${pageId}`) as { path: string; relative_path: string };
    expect(binding.path).toBe(legacyPath);
    expect(binding.relative_path).toBe('Migrated.wpnote.json');
    expect(readFileSync(join(occupiedRoot, '.forge', 'notebook.json'), 'utf8')).toBe(
      'sentinel metadata'
    );
    expect(readFileSync(join(occupiedRoot, 'Migrated.md'), 'utf8')).toBe('sentinel markdown');
    expect(existsSync(legacyPath)).toBe(true);
  });

  it('keeps sync preparation free of notebook package reservations', () => {
    const candidate = join(workspaceRoot, 'Raced');
    expect(prepareWorkspaceSyncProjection(db, { workspaceId: 1, workspaceRoot })).toMatchObject({
      notebooksMirrored: 0,
    });
    expect(existsSync(candidate)).toBe(false);
  });

  it('removes stale SQLite notebook projections when the remote package was deleted', () => {
    const packageRoot = join(workspaceRoot, 'Deleted remotely');
    mkdirSync(join(packageRoot, '.forge'), { recursive: true });
    const document = buildNotebookPackageDocument({
      id: 'page-deleted-remotely',
      title: 'Deleted remotely',
      content: { type: 'doc', content: [] },
    });
    writeFileSync(
      join(packageRoot, '.forge', 'notebook.json'),
      serializeNotebookPackageDocument(document),
      'utf8'
    );
    rehydrateWorkspaceSyncState(db, { workspaceId: 1, workspaceRoot, nowMs: 1000 });
    const projectionId = scopedId(document.id);

    rmSync(packageRoot, { recursive: true, force: true });
    rehydrateWorkspaceSyncState(db, { workspaceId: 1, workspaceRoot, nowMs: 2000 });

    expect(db.prepare(`SELECT id FROM pages WHERE id = ?`).get(projectionId)).toBeUndefined();
    expect(
      db
        .prepare(`SELECT status, missing_since FROM catalog_entity_files WHERE entity_id = ?`)
        .get(projectionId)
    ).toMatchObject({ status: 'missing', missing_since: 2000 });
    expect(
      db.prepare(`SELECT status FROM catalog_entities WHERE id = ?`).get(projectionId)
    ).toMatchObject({ status: 'missing' });
    expect(
      prepareWorkspaceSyncProjection(db, { workspaceId: 1, workspaceRoot }).notebooksMirrored
    ).toBe(0);
    expect(existsSync(packageRoot)).toBe(false);
  });

  it('keeps a Windows replica pull converging after the project scan respells the notebook folder', () => {
    const repoUuid = '012810a4-2179-4892-946f-8673c42478b3';
    const windowsRoot = `C:\\Users\\user\\managed-workspaces\\${repoUuid}\\repo`;
    db.prepare(
      `INSERT INTO workspaces (id, name, path, repo_uuid, created_at, last_opened_at)
       VALUES (2, 'Shared', ?, ?, 1, 1)`
    ).run(windowsRoot, repoUuid);
    const document = buildNotebookPackageDocument({
      id: 'page-large-attachments',
      title: 'Large attachments',
      content: { type: 'doc', content: [] },
    });
    const projectionId = scopedProjectionId(repoUuid, document.id);
    const rebuildFromPulledFiles = (nowMs: number) =>
      upsertNotebookCatalog(db, {
        workspaceId: 2,
        workspaceRoot: windowsRoot,
        packageRoot: win32.join(windowsRoot, 'Large attachments'),
        document,
        projectionId,
        nowMs,
      });

    rebuildFromPulledFiles(1);
    bindCatalogEntityFileInDb(db, {
      entityId: projectionId,
      path: `${windowsRoot}/Large attachments`,
      workspaceRoot: windowsRoot,
      fileKind: 'waypoint-notebook',
      status: 'current',
    });

    expect(() => rebuildFromPulledFiles(2)).not.toThrow();
    expect(
      db
        .prepare(`SELECT path FROM catalog_entity_files WHERE entity_id = ? AND status = 'current'`)
        .all(projectionId)
    ).toEqual([{ path: `${windowsRoot}/Large attachments` }]);
  });

  it('reuses the earlier record when a pulled notebook returns to a folder it used before', () => {
    const packageRoot = join(workspaceRoot, 'Large attachments');
    writeV2NotebookPackage(packageRoot, 'Large attachments', 'page-returning');
    const projectionId = scopedId('page-returning');
    rehydrateWorkspaceSyncState(db, { workspaceId: 1, workspaceRoot, nowMs: 1, strict: true });
    bindCatalogEntityFileInDb(db, {
      entityId: projectionId,
      path: join(workspaceRoot, 'Moved'),
      workspaceRoot,
      fileKind: 'waypoint-notebook',
      status: 'current',
    });

    expect(() =>
      rehydrateWorkspaceSyncState(db, { workspaceId: 1, workspaceRoot, nowMs: 2, strict: true })
    ).not.toThrow();
    expect(
      db
        .prepare(
          `SELECT path, status FROM catalog_entity_files WHERE entity_id = ? ORDER BY path ASC`
        )
        .all(projectionId)
    ).toEqual([
      { path: packageRoot, status: 'current' },
      { path: join(workspaceRoot, 'Moved'), status: 'historical' },
    ]);
  });

  it('does not follow a notebook package symlink during sync preparation', () => {
    const outsideRoot = mkdtempSync(join(tmpdir(), 'dnaforge-sync-notebook-escape-'));
    try {
      const pageId = scopedId('page-symlink-escape');
      const packageRoot = join(workspaceRoot, 'Escaped notebook');
      symlinkSync(outsideRoot, packageRoot, 'dir');
      db.prepare(
        `INSERT INTO pages (id, title, content, created_at, updated_at)
         VALUES (?, 'Escaped notebook', ?, 1, 1)`
      ).run(pageId, JSON.stringify({ type: 'doc', content: [] }));
      db.prepare(
        `INSERT INTO catalog_entities
         (id, type, name, locator, storage_type, status, workspace_id, metadata, created_at, updated_at)
         VALUES (?, 'notebook', 'Escaped notebook', ?, 'file', 'active', 1, NULL, 1, 1)`
      ).run(pageId, `entity://page/${pageId}`);
      db.prepare(
        `INSERT INTO catalog_entity_files
         (id, entity_id, workspace_id, path, relative_path, file_kind, content_hash, size_bytes,
          modified_at, status, last_seen_at, missing_since, created_at, updated_at)
         VALUES (?, ?, 1, ?, 'Escaped notebook', 'waypoint-notebook', NULL, 0, 1,
                 'current', 1, NULL, 1, 1)`
      ).run(`file-${pageId}`, pageId, packageRoot);

      expect(() =>
        prepareWorkspaceSyncProjection(db, { workspaceId: 1, workspaceRoot })
      ).not.toThrow();
      expect(existsSync(join(outsideRoot, '.forge', 'notebook.json'))).toBe(false);
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it('does not touch legacy LIMS paths while projecting sync content', () => {
    const outsideRoot = mkdtempSync(join(tmpdir(), 'dnaforge-sync-lims-escape-'));
    try {
      symlinkSync(outsideRoot, join(workspaceRoot, '.waypoint'), 'dir');

      expect(prepareWorkspaceSyncProjection(db, { workspaceId: 1, workspaceRoot })).toMatchObject({
        limsAppendedEvents: 0,
        limsLogFiles: [],
      });
      expect(existsSync(join(outsideRoot, 'lims'))).toBe(false);
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it('keeps a historical installation-global LIMS export inert while restoring project files', () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'dnaforge-sync-lims-src-'));
    const otherSourceRoot = mkdtempSync(join(tmpdir(), 'dnaforge-sync-lims-other-'));
    try {
      const sourceDb = createTestDb();
      ensureSchema(sourceDb, ':memory:');
      sourceDb
        .prepare(
          `INSERT INTO workspaces (id, name, path, created_at, last_opened_at)
           VALUES (7, 'Source', ?, 1, 1), (8, 'Other source', ?, 1, 1)`
        )
        .run(sourceRoot, otherSourceRoot);
      registerLimsEntityInDb(sourceDb, {
        kind: 'oligo',
        name: 'Source primer',
        workspaceId: 7,
        fields: {
          sequence: { mode: 'inline', bases: 'ATGCATGCATGCATGC', topology: 'linear', length: 16 },
          use: 'primer',
        },
      });
      registerLimsEntityInDb(sourceDb, {
        kind: 'oligo',
        name: 'Other project primer',
        workspaceId: 8,
        fields: {
          sequence: { mode: 'inline', bases: 'GCTAGCTAGCTAGCTA', topology: 'linear', length: 16 },
          use: 'primer',
        },
      });
      const historicalGlobal = registerLimsEntityInDb(sourceDb, {
        kind: 'oligo',
        name: 'Installation-global primer',
        workspaceId: 8,
        fields: {
          sequence: { mode: 'inline', bases: 'TTTTAAAACCCCGGGG', topology: 'linear', length: 16 },
          use: 'primer',
        },
      });
      sourceDb
        .prepare('UPDATE lims_entity SET workspace_id = NULL WHERE id = ?')
        .run(historicalGlobal.id);
      materializeLimsGitReadableExportInDb(sourceDb, { workspaceRoot: sourceRoot });

      const srcLog = join(sourceRoot, '.waypoint', 'lims');
      const destLog = join(workspaceRoot, '.waypoint', 'lims');
      mkdirSync(join(destLog, 'log'), { recursive: true });
      mkdirSync(join(destLog, 'sheets'), { recursive: true });
      for (const name of ['manifest.json', 'sheets/oligos.csv']) {
        const from = join(srcLog, name);
        const to = join(destLog, name);
        writeFileSync(to, readFileSync(from, 'utf8'), 'utf8');
      }
      const logNames = readdirSync(join(srcLog, 'log')).filter((n) => n.endsWith('.jsonl'));
      for (const name of logNames) {
        writeFileSync(
          join(destLog, 'log', name),
          readFileSync(join(srcLog, 'log', name), 'utf8'),
          'utf8'
        );
      }
      sourceDb.close();

      const result = rehydrateWorkspaceSyncState(db, {
        workspaceId: 1,
        workspaceRoot,
        nowMs: 3000,
      });

      expect(result.lims).toBeNull();
      expect(result.legacyLimsIgnored).toBe(true);
      expect(db.prepare(`SELECT COUNT(*) AS count FROM lims_audit`).get()).toEqual({ count: 0 });
      expect(db.prepare(`SELECT COUNT(*) AS count FROM lims_entity`).get()).toEqual({ count: 0 });
      expect(readdirSync(join(workspaceRoot, '.waypoint', 'lims', 'log'))).not.toEqual([]);
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
      rmSync(otherSourceRoot, { recursive: true, force: true });
    }
  });
});
