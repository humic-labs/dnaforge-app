// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => tmpdir(), getVersion: () => 'test' },
  dialog: { showErrorBox: vi.fn() },
}));

import { createTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { createNativeNotebookWorkingCopies } from './native-notebook-working-copies';
import { bindCatalogEntityFileInDb } from './catalog-file-binding';
import { parseNotebookPackageDocument, notebookPackagePaths } from '../db/notebook-package';
import { readCanonicalNotebookPackage } from '../db/notebook-package-migration';
import { canonicalNotebookJson } from '../db/notebook-markdown-codec';
import { createWorkspaceFileRelocator } from './workspace-file-relocation';
import { NativeDocumentDispatcher } from './native-document-dispatcher';
import { createNativeFileDocuments } from './native-file-documents';
import { nativeNotebookDocumentAdapter } from './native-notebook-document-adapter';
import { replaceNotebookProjectionFromFileInMain } from './notebook-projection-authority';
import { notebookProjectionFingerprint } from '../shared/notebook-projection';
import { readNotebookPublicationInDb } from './notebook-publication';
import {
  buildSequencePackageDocument,
  sequencePackagePaths,
  serializeSequencePackageDocument,
} from '../db/sequence-package';

let directory: string, root: string, profile: string, db: Database.Database;
vi.mock('./ipc/database', () => ({ getDb: () => db }));
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'native-notebook-legacy-')));
  root = join(directory, 'project');
  profile = join(directory, 'profile');
  await mkdir(root);
  db = createTestDb();
  ensureSchema(db, ':memory:');
  db.prepare('INSERT INTO workspaces(id,name,path,created_at)VALUES(7,?,?,1)').run(
    'Notebook project',
    root
  );
});
afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});
const owner = () => {
  const options = {
    db: () => db,
    workspaceRoots: () => [root],
    writableWorkspaceRoots: () => [root],
    profileDirectory: () => profile,
    captureWorkspace: () => () => {},
  };
  const relocation = createWorkspaceFileRelocator({
    db: options.db,
    fileDocuments: () => documents,
  });
  const notebook = createNativeNotebookWorkingCopies({
    ...options,
    relocateEntityFile: (input) => relocation.relocateEntityFile(input),
  });
  const documents = new NativeDocumentDispatcher({
    db: options.db,
    workspaceRoots: options.workspaceRoots,
    ordinary: createNativeFileDocuments(options),
    adapters: [nativeNotebookDocumentAdapter(notebook)],
  });
  return notebook;
};

describe('native notebook legacy package boundary', () => {
  it('inserts a managed file reference with the package identity and the declared product hash', async () => {
    const native = owner();
    const created = await native.create({
      title: 'Notes',
      workspaceRoot: root,
      requestId: 'source-notes',
    });
    const entityId = 'notebook-source';
    const objectUuid = '85a8fc9f-2839-40b3-84de-317d3c504cce';
    const packageRoot = join(root, 'Archived document');
    const paths = sequencePackagePaths(packageRoot, { productFile: 'original.gb' });
    const document = buildSequencePackageDocument({
      id: entityId,
      name: 'Archived document',
      product: { file: 'original.gb' },
    });
    const bytes = Buffer.from('fixture contents');
    await mkdir(paths.metaDir, { recursive: true });
    await writeFile(paths.metaPath, serializeSequencePackageDocument(document));
    await writeFile(paths.productPath, bytes);
    db.prepare(
      "INSERT INTO catalog_entities(id,type,name,locator,storage_type,workspace_id,created_at,updated_at) VALUES (?,'sequence','Archived document',?,'file',7,1,1)"
    ).run(entityId, packageRoot);
    db.prepare(
      "INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,file_kind,object_uuid,created_at,updated_at) VALUES ('source-file',?,7,?,'waypoint-sequence',?,1,1)"
    ).run(entityId, packageRoot, objectUuid);
    await native.execute({
      documentId: created.documentId,
      expectedRevision: created.revision,
      operation: {
        kind: 'insert',
        index: created.blockCount,
        source: { kind: 'entity', type: 'sequence', entityId },
      },
    });
    const result = await native.execute({
      documentId: created.documentId,
      operation: { kind: 'inspect', limit: 50 },
    });
    expect(result.blocks?.at(-1)?.block.content?.[0]?.attrs).toMatchObject({
      entityId,
      objectUuid,
      path: 'Archived document',
      contentHash: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
    });
    await native.close();
  });

  it('does not claim settlement for a different project or package location', async () => {
    const native = owner();
    const created = await native.create({
      title: 'Bound report',
      workspaceRoot: root,
      requestId: 'bound-report',
    });
    const input = {
      documentId: created.documentId,
      workspaceRoot: root,
      path: created.path,
      title: created.title,
      content: (
        db.prepare('SELECT content FROM pages WHERE id=?').get(created.documentId) as {
          content: string;
        }
      ).content,
      canonicalFingerprint: created.publication?.canonicalFingerprint ?? '',
    };
    expect(readNotebookPublicationInDb(db, input).status).toBe('settled');
    expect(
      readNotebookPublicationInDb(db, { ...input, workspaceRoot: join(directory, 'other') }).status
    ).toBe('pending');
    expect(readNotebookPublicationInDb(db, { ...input, path: join(root, 'other') }).status).toBe(
      'pending'
    );
    await native.close();
  });
  it('resolves a closed historical conflict only after preserving the exact file and application versions', async () => {
    const native = owner();
    const created = await native.create({
      title: 'Historical report',
      workspaceRoot: root,
      requestId: 'historical-report',
    });
    const application = JSON.stringify({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { indent: 0 },
          content: [{ type: 'text', text: 'Edited and saved inside DNAForge.' }],
        },
      ],
    });
    db.prepare('UPDATE pages SET content=? WHERE id=?').run(application, created.documentId);
    db.prepare(
      'UPDATE entity_projection_sources SET synchronized_fingerprint=? WHERE entity_id=?'
    ).run('7eddda4a53767ba8', created.documentId);
    const markdown =
      '# Historical report\n\nEdited and saved inside DNAForge.\n\n**Updated from an external Markdown editor.**\n';
    const path = notebookPackagePaths(created.path).markdownPath;
    await writeFile(path, markdown);
    const inspected = await native.executePublic({
      pageId: created.documentId,
      operation: { kind: 'inspect-conflict' },
    } as never);
    const comparison = inspected.conflict as {
      token: string;
      fileText: string;
      applicationText: string;
    };
    expect(comparison.fileText).toContain('Updated from an external Markdown editor.');
    expect(comparison.applicationText).toContain('Edited and saved inside DNAForge.');
    const result = await native.executePublic({
      pageId: created.documentId,
      requestId: 'resolve-original',
      operation: { kind: 'resolve-conflict', token: comparison.token, choice: 'file' },
    } as never);
    expect(result.resolved).toBe(true);
    const retained = result.retainedPath as string;
    expect(JSON.parse(await readFile(join(retained, 'application.json'), 'utf8')).content).toBe(
      application
    );
    expect(await readFile(join(retained, 'package', 'Historical report.md'), 'utf8')).toBe(
      markdown
    );
    expect(
      (
        db.prepare('SELECT content FROM pages WHERE id=?').get(created.documentId) as {
          content: string;
        }
      ).content
    ).toContain('Updated from an external Markdown editor.');
    expect(await readFile(path, 'utf8')).toBe(markdown);
    const reopened = await native.execute({
      documentId: created.documentId,
      operation: { kind: 'inspect-copy' },
    });
    expect(JSON.stringify(reopened.copy.content)).toContain(
      'Updated from an external Markdown editor.'
    );
    expect(reopened.publication).toMatchObject({ status: 'settled' });
    await native.close();
  });

  it('refuses a stale conflict decision without changing either real version', async () => {
    const native = owner();
    const created = await native.create({
      title: 'Changed comparison',
      workspaceRoot: root,
      requestId: 'changed-comparison',
    });
    const inspected = await native.executePublic({
      pageId: created.documentId,
      operation: { kind: 'inspect-conflict' },
    } as never);
    const token = (inspected.conflict as { token: string }).token;
    const path = notebookPackagePaths(created.path).markdownPath;
    const newer = '# Changed comparison\n\nNewer external edit.\n';
    await writeFile(path, newer);
    const before = db.prepare('SELECT content FROM pages WHERE id=?').get(created.documentId);
    await expect(
      native.executePublic({
        pageId: created.documentId,
        operation: { kind: 'resolve-conflict', token, choice: 'file' },
      } as never)
    ).rejects.toMatchObject({ code: 'NOTEBOOK_CONFLICT_CHANGED' });
    expect(await readFile(path, 'utf8')).toBe(newer);
    expect(db.prepare('SELECT content FROM pages WHERE id=?').get(created.documentId)).toEqual(
      before
    );
    await native.close();
  });

  it('settles a newly created closed notebook before any renderer reconciliation', async () => {
    const native = owner();
    const created = await native.create({
      title: 'Closed publication',
      workspaceRoot: root,
      requestId: 'closed-publication',
    });
    const row = db
      .prepare('SELECT title,content FROM pages WHERE id=?')
      .get(created.documentId) as { title: string; content: string };
    expect(
      db
        .prepare('SELECT synchronized_fingerprint FROM entity_projection_sources WHERE entity_id=?')
        .get(created.documentId)
    ).toEqual({
      synchronized_fingerprint: notebookProjectionFingerprint(row.title, row.content),
    });
    await native.close();
  });

  it('retains a saved-source projection failure and retries settlement without rewriting the source', async () => {
    const native = owner();
    let state = await native.create({
      title: 'Pending publication',
      workspaceRoot: root,
      requestId: 'pending-publication',
    });
    state = await native.execute({
      documentId: state.documentId,
      expectedRevision: state.revision,
      operation: {
        kind: 'splice-blocks',
        index: 0,
        deleteCount: 1,
        blocks: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Saved before projection failure.' }],
          },
        ],
      },
    });
    db.exec(
      "CREATE TRIGGER refuse_notebook_projection BEFORE UPDATE ON pages BEGIN SELECT RAISE(ABORT, 'injected projection refusal'); END"
    );
    const failed = await native.executePublic({
      pageId: state.documentId,
      expectedRevision: state.revision,
      operation: { kind: 'save' },
    });
    const markdownPath = notebookPackagePaths(state.path).markdownPath;
    const published = await readFile(markdownPath, 'utf8');
    expect(published).toContain('Saved before projection failure.');
    expect(failed.saved).toBe(false);
    expect(failed.publication).toMatchObject({ status: 'pending' });
    db.exec('DROP TRIGGER refuse_notebook_projection');
    const retry = await native.executePublic({
      pageId: state.documentId,
      expectedRevision: failed.revision as string,
      operation: { kind: 'save' },
    });
    expect(retry.publication).toMatchObject({ status: 'settled' });
    expect(retry.saved).toBe(true);
    expect(await readFile(markdownPath, 'utf8')).toBe(published);
    const row = db.prepare('SELECT title,content FROM pages WHERE id=?').get(state.documentId) as {
      title: string;
      content: string;
    };
    expect(row.content).toContain('Saved before projection failure.');
    expect(
      db
        .prepare('SELECT synchronized_fingerprint FROM entity_projection_sources WHERE entity_id=?')
        .get(state.documentId)
    ).toEqual({ synchronized_fingerprint: notebookProjectionFingerprint(row.title, row.content) });
    await native.close();
  });

  it('advances the synchronized baseline with native saves and renames before outside edits', async () => {
    const native = owner();
    let state = await native.create({
      title: 'Saved report',
      workspaceRoot: root,
      requestId: 'saved-baseline',
    });
    const projectedFingerprint = () => {
      const row = db
        .prepare('SELECT title,content FROM pages WHERE id=?')
        .get(state.documentId) as { title: string; content: string };
      return notebookProjectionFingerprint(row.title, row.content);
    };
    const source = await readCanonicalNotebookPackage(
      {
        readTextFile: (path) => readFile(path, 'utf8'),
        exists: (path) =>
          access(path).then(
            () => true,
            () => false
          ),
      },
      state.path
    );
    await replaceNotebookProjectionFromFileInMain(db, {
      pageId: state.documentId,
      workspaceRoot: root,
      sourcePath: notebookPackagePaths(state.path).metaPath,
      sourceFingerprint: notebookProjectionFingerprint(source.parsed.title, source.parsed.content),
      expectedProjectionFingerprint: projectedFingerprint(),
    });
    state = await native.execute({
      documentId: state.documentId,
      expectedRevision: state.revision,
      operation: {
        kind: 'splice-blocks',
        index: state.blockCount,
        deleteCount: 0,
        blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'Human addition' }] }],
      },
    });
    state = await native.execute({
      documentId: state.documentId,
      expectedRevision: state.revision,
      operation: { kind: 'save' },
    });
    const receipt = () =>
      db
        .prepare(
          'SELECT relative_path,synchronized_fingerprint FROM entity_projection_sources WHERE entity_id=? ORDER BY synchronized_at DESC LIMIT 1'
        )
        .get(state.documentId);
    expect(receipt()).toMatchObject({
      synchronized_fingerprint: projectedFingerprint(),
    });
    state = await native.execute({
      documentId: state.documentId,
      expectedRevision: state.revision,
      operation: { kind: 'rename', title: 'Renamed saved report' },
    });
    expect(receipt()).toMatchObject({
      relative_path: 'Renamed saved report/.forge/notebook.json',
      synchronized_fingerprint: projectedFingerprint(),
    });
    expect(state.warnings ?? []).toEqual([]);
    await native.close();
  });
  it('renames an externally rewritten markerless notebook and reopens its existing identity', async () => {
    const native = owner();
    const created = await native.create({
      title: 'External report',
      workspaceRoot: root,
      requestId: 'markerless-rename-create',
    });
    await writeFile(
      notebookPackagePaths(created.path).markdownPath,
      '# External report\n\nOutside **revision**.\n'
    );
    const reloaded = await native.execute({
      documentId: created.documentId,
      expectedRevision: created.revision,
      operation: { kind: 'reload' },
    });
    const renamed = await native.execute({
      documentId: created.documentId,
      expectedRevision: reloaded.revision,
      operation: { kind: 'rename', title: 'Renamed external report' },
    });
    expect(renamed.documentId).toBe(created.documentId);
    expect(renamed.title).toBe('Renamed external report');
    const paths = notebookPackagePaths(renamed.path);
    expect(JSON.parse(await readFile(paths.metaPath, 'utf8')).authority.path).toBe(
      'Renamed external report.md'
    );
    expect(await readFile(paths.markdownPath, 'utf8')).toContain('Outside **revision**.');
    await native.close();
    const restarted = owner();
    const reopened = await restarted.execute({
      documentId: created.documentId,
      operation: { kind: 'inspect-copy' },
    });
    expect(reopened.documentId).toBe(created.documentId);
    expect(reopened.path).toBe(renamed.path);
    expect(JSON.stringify(reopened.copy.content)).toContain('revision');
    await restarted.close();
  });
  it('renames through the shared native relocation service and reopens the same identity', async () => {
    const native = owner();
    const created = await native.create({
      title: 'Before native rename',
      workspaceRoot: root,
      requestId: 'native-relocation-create',
    });
    const renamed = await native.execute({
      documentId: created.documentId,
      expectedRevision: created.revision,
      operation: { kind: 'rename', title: 'After native rename' },
    });
    expect(renamed.path).toBe(join(root, 'After native rename'));
    expect(renamed.title).toBe('After native rename');
    expect(renamed.dirty).toBe(false);
    await expect(access(created.path)).rejects.toMatchObject({ code: 'ENOENT' });
    const disk = await readFile(notebookPackagePaths(renamed.path).markdownPath, 'utf8');
    expect(disk).toContain('After native rename');
    expect(
      db
        .prepare("SELECT path FROM catalog_entity_files WHERE entity_id=? AND status='current'")
        .all(created.documentId)
    ).toEqual([{ path: renamed.path }]);
    await native.close();
    const restarted = owner();
    const reopened = await restarted.execute({
      documentId: created.documentId,
      operation: { kind: 'inspect-copy' },
    });
    expect(reopened.documentId).toBe(created.documentId);
    expect(reopened.path).toBe(renamed.path);
    expect(reopened.title).toBe('After native rename');
    expect(reopened.dirty).toBe(false);
    await restarted.close();
  });
  it.each(['flat', 'v1'] as const)(
    'edits and saves the unchanged old %s fixture without a mounted view or another serializer',
    async (kind) => {
      const fixtures = new URL('../db/__fixtures__/notebook-packages/', import.meta.url),
        path = join(root, kind === 'flat' ? 'legacy-flat.wpnote.json' : 'v1-rich-notebook');
      await cp(
        new URL(kind === 'flat' ? 'legacy-flat.wpnote.json' : 'v1-rich-notebook', fixtures),
        path,
        { recursive: kind === 'v1' }
      );
      const originalPath = kind === 'flat' ? path : notebookPackagePaths(path).metaPath,
        original = await readFile(originalPath, 'utf8'),
        legacy = parseNotebookPackageDocument(original),
        id = 'ws7::' + legacy.id;
      db.prepare(
        'INSERT INTO catalog_entities(id,type,name,locator,storage_type,status,workspace_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)'
      ).run(id, 'notebook', legacy.title, 'entity://page/' + id, 'database', 'active', 7, 1, 1);
      db.prepare('INSERT INTO pages(id,title,content,created_at,updated_at)VALUES(?,?,?,?,?)').run(
        id,
        legacy.title,
        JSON.stringify(legacy.content),
        1,
        1
      );
      bindCatalogEntityFileInDb(db, {
        entityId: id,
        path,
        workspaceRoot: root,
        fileKind: 'waypoint-notebook',
        status: 'current',
      });
      const native = owner();
      let state = await native.execute({ documentId: id, operation: { kind: 'inspect-copy' } });
      const before = state.copy.content;
      state = await native.execute({
        documentId: id,
        expectedRevision: state.revision,
        operation: {
          kind: 'splice-blocks',
          index: state.blockCount,
          deleteCount: 0,
          blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'Native legacy edit' }] }],
        },
      });
      state = await native.execute({
        documentId: id,
        expectedRevision: state.revision,
        operation: { kind: 'save' },
      });
      expect(state.dirty).toBe(false);
      expect(state.documentId).toBe(id);
      expect(state.warnings).toEqual([]);
      const disk = await readCanonicalNotebookPackage(
        {
          readTextFile: (path) => readFile(path, 'utf8'),
          exists: async (path) => {
            try {
              await access(path);
              return true;
            } catch {
              return false;
            }
          },
        },
        state.path
      );
      expect(disk.metadata.id).toBe(legacy.id);
      expect(disk.metadata.formatVersion).toBe(2);
      expect(disk.parsed.content.content?.at(-1)?.content?.[0].text).toBe('Native legacy edit');
      expect(canonicalNotebookJson(disk.parsed.content.content?.slice(0, -1))).toBe(
        canonicalNotebookJson(before.content)
      );
      if (kind === 'flat') expect(await readFile(path + '.legacy', 'utf8')).toBe(original);
      else
        expect(await readFile(join(state.path, 'assets', 'model.pdb'), 'utf8')).toBe(
          await readFile(new URL('v1-rich-notebook/assets/model.pdb', fixtures), 'utf8')
        );
      expect(
        db
          .prepare("SELECT path FROM catalog_entity_files WHERE entity_id=? AND status='current'")
          .all(id)
      ).toEqual([{ path: state.path }]);
      await native.close();
      const reopened = await owner().execute({
        documentId: id,
        operation: { kind: 'inspect-copy' },
      });
      expect(reopened.copy.content).toEqual(state.copy.content);
    }
  );
  it('reuses a retained same-input creation receipt and rejects a changed input for the same identity', async () => {
    const native = owner(),
      input = {
        requestId: 'stable-create-job',
        operation: {
          kind: 'create' as const,
          title: 'Idempotent notebook',
          destinationProject: root,
        },
      };
    const first = await native.executePublic(input),
      second = await native.executePublic(input);
    expect(second.pageId).toBe(first.pageId);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM catalog_entities WHERE type='notebook'").get()
    ).toEqual({ count: 1 });
    await native.close();
    const restarted = owner();
    const replayed = await restarted.executePublic(input);
    expect(replayed.pageId).toBe(first.pageId);
    await expect(
      restarted.executePublic({ ...input, operation: { ...input.operation, title: 'Different' } })
    ).rejects.toMatchObject({ code: 'NOTEBOOK_REQUEST_ID_REUSED', stateChanged: false });
  });
  it('creates a human-selected package in its exact folder with contextual catalog and existing project memory', async () => {
    const folder = join(root, 'Selected folder');
    await mkdir(folder);
    const native = owner();
    const created = await native.create({
      title: 'Display title',
      workspaceRoot: root,
      requestId: 'human-context-create',
      context: {
        workspaceRoot: root,
        parentPath: folder,
        targetPath: folder,
        targetKind: 'folder',
        artifactFileName: 'Selected name.wpnote.json',
      },
    });
    expect(created.path).toBe(join(folder, 'Selected name'));
    expect(created.title).toBe('Display title');
    expect(
      db
        .prepare('SELECT relation FROM catalog_entity_links WHERE source_entity_id=?')
        .all(created.documentId)
    ).toEqual([{ relation: 'created_in' }]);
    const events = await readFile(
      join(root, '.waypoint', 'project-memory', 'events.jsonl'),
      'utf8'
    );
    expect(events).toContain('artifact_created');
    expect(events).toContain(created.documentId);
    await native.close();
  });
});
