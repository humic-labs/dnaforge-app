// @vitest-environment node

import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
}));

import { createTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { createNativeFileDocuments } from './native-file-documents';
import { relinkWorkspaceRoot } from './workspace-root-recovery';
import { MANAGED_WORKSPACE_MARKER } from '../shared/workspace-git-types';
import { NativeDocumentDispatcher } from './native-document-dispatcher';
import { registerCatalogEntityInDb } from './catalog-entity-registration';
import { bindCatalogEntityFileInDb } from './catalog-file-binding';
import { legacyFileDraftFingerprint } from '../shared/file-document-legacy-recovery';
import { fileDocumentAgentRequestSchema } from '../shared/file-document';

let db: Database.Database;
let directory: string;
let root: string;
let profile: string;
let writable: string[];
const createOwner = () =>
  createNativeFileDocuments({
    db: () => db,
    workspaceRoots: () => [root],
    writableWorkspaceRoots: () => writable,
    profileDirectory: () => profile,
  });
const inspectOperation = {
  kind: 'inspect' as const,
  offset: 0,
  limit: 2000,
  rowOffset: 0,
  rowLimit: 20,
  columnOffset: 0,
  columnLimit: 20,
};

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'native-file-documents-')));
  root = join(directory, 'project');
  profile = join(directory, 'profile');
  await mkdir(root);
  db = createTestDb();
  ensureSchema(db, ':memory:');
  db.prepare('INSERT INTO workspaces(id,name,path,created_at) VALUES(7,?,?,1)').run(
    'File project',
    root
  );
  writable = [root];
});
afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

describe('profile-owned files independent of views', () => {
  it('keeps a bound plain-text report with its ordinary native document owner', async () => {
    const path = join(root, 'report.txt');
    const content = 'Report content\n';
    await writeFile(path, content);
    const entity = registerCatalogEntityInDb(db, {
      type: 'report',
      name: 'Report',
      locator: `file://${path}`,
      storageType: 'file',
      workspaceRoot: root,
    });
    bindCatalogEntityFileInDb(db, {
      entityId: entity.id,
      path,
      fileKind: 'text',
      workspaceRoot: root,
    });
    const owner = createOwner();
    const dispatcher = new NativeDocumentDispatcher({
      ordinary: owner,
      db: () => db,
      adapters: [],
    });
    try {
      const initial = await dispatcher.execute({
        target: { path },
        projection: 'document',
        operation: inspectOperation,
      });
      expect(initial).toMatchObject({ path, type: 'text', content });
      const selected = await dispatcher.execute({
        target: { documentId: entity.id },
        projection: 'document',
        operation: inspectOperation,
      });
      expect(selected).toMatchObject({
        documentId: initial.documentId,
        path,
        type: 'text',
        content,
      });
      const loaded = await dispatcher.execute({
        target: { documentId: initial.documentId },
        projection: 'document',
        expectedRevision: initial.revision,
        operation: { kind: 'reload' },
      });
      expect(loaded).toMatchObject({
        documentId: initial.documentId,
        type: 'text',
        content,
        dirty: false,
      });
      expect(await readFile(path, 'utf8')).toBe(content);
    } finally {
      await owner.close();
    }
  });

  it('keeps a bound molecular report under its scientific owner boundary', async () => {
    const path = join(root, 'report.molview.json');
    const content = '{}\n';
    await writeFile(path, content);
    const entity = registerCatalogEntityInDb(db, {
      type: 'report',
      name: 'Molecular report',
      locator: `file://${path}`,
      storageType: 'file',
      workspaceRoot: root,
    });
    bindCatalogEntityFileInDb(db, {
      entityId: entity.id,
      path,
      fileKind: 'dnaforge-molecular-document',
      workspaceRoot: root,
    });
    const owner = createOwner();
    const dispatcher = new NativeDocumentDispatcher({
      ordinary: owner,
      db: () => db,
      adapters: [],
    });
    try {
      const initial = await dispatcher.execute({ target: { path }, operation: inspectOperation });
      expect(initial).toMatchObject({ documentId: entity.id, kind: 'scientific', readOnly: true });
      await expect(
        dispatcher.execute({
          target: { documentId: entity.id },
          expectedRevision: initial.revision,
          operation: { kind: 'reload' },
        })
      ).rejects.toThrow('DOCUMENT_OPERATION_UNSUPPORTED');
      expect(await readFile(path, 'utf8')).toBe(content);
    } finally {
      await owner.close();
    }
  });

  it('inspects, reloads and reopens scientific working files without accepting raw edits', async () => {
    const path = join(root, 'derivative.entity.json');
    const content = JSON.stringify({
      schema: 'waypoint.entity.v1',
      id: 'native-planned-derivative',
      kind: 'strain',
      name: 'Unaccepted working derivative',
      fields: { genotypeCanonical: 'MATa his3Δ1 leu2Δ0 met15Δ0 ura3Δ0' },
    });
    await writeFile(path, content);
    const owner = createOwner();
    const dispatcher = new NativeDocumentDispatcher({
      ordinary: owner,
      db: () => db,
      adapters: [],
    });
    const initial = await dispatcher.execute({
      target: { path },
      projection: 'document',
      operation: inspectOperation,
    });
    const loaded = await dispatcher.execute({
      target: { documentId: initial.documentId },
      projection: 'document',
      expectedRevision: initial.revision,
      operation: { kind: 'reload' },
    });
    expect(loaded).toMatchObject({ type: 'text', content, readOnly: true, dirty: false });
    await expect(
      dispatcher.execute({
        target: { documentId: loaded.documentId },
        expectedRevision: loaded.revision,
        operation: { kind: 'replace-text', from: 0, to: 0, text: 'refused' },
      })
    ).rejects.toThrow('READ_ONLY_FILE');
    await owner.close();
    const restartedOwner = createOwner();
    const restarted = new NativeDocumentDispatcher({
      ordinary: restartedOwner,
      db: () => db,
      adapters: [],
    });
    const reopened = await restarted.execute({
      target: { path },
      projection: 'document',
      operation: inspectOperation,
    });
    expect(reopened).toMatchObject({ documentId: loaded.documentId, content, readOnly: true });
    expect(
      await restarted.execute({
        target: { documentId: loaded.documentId },
        projection: 'document',
        operation: inspectOperation,
      })
    ).toMatchObject({ documentId: loaded.documentId, content, readOnly: true });
    expect(await readFile(path, 'utf8')).toBe(content);
    await restartedOwner.close();
  });

  it('opens, edits, saves and reopens an ordinary file through the general document boundary', async () => {
    const path = join(root, 'lifecycle.py');
    await writeFile(path, '\uFEFFalpha\r\n');
    const owner = createOwner(),
      dispatcher = new NativeDocumentDispatcher({ ordinary: owner, db: () => db, adapters: [] });
    const initial = await dispatcher.execute({ target: { path }, operation: inspectOperation });
    expect(initial.lifecycle?.edit).toMatchObject({
      availability: 'native',
      commands: ['replace-string', 'replace-text'],
    });
    expect(initial.lifecycle?.history.commands).toEqual(['undo', 'redo']);
    expect(initial.lifecycle?.save.commands).toEqual(['save']);
    const changed = await dispatcher.execute({
      target: { documentId: initial.documentId },
      expectedRevision: initial.revision,
      operation: { kind: 'replace-text', from: 1, to: 6, text: 'beta' },
    });
    const saved = await dispatcher.execute({
      target: { documentId: initial.documentId },
      expectedRevision: changed.revision,
      operation: { kind: 'save' },
    });
    expect(saved.dirty).toBe(false);
    expect(await readFile(path, 'utf8')).toBe('\uFEFFbeta\r\n');
    await owner.close();
    const reopenedOwner = createOwner(),
      reopenedDispatcher = new NativeDocumentDispatcher({
        ordinary: reopenedOwner,
        db: () => db,
        adapters: [],
      });
    writable = [];
    const reopened = await reopenedDispatcher.execute({
      target: { documentId: initial.documentId },
      operation: inspectOperation,
    });
    expect(reopened.documentId).toBe(initial.documentId);
    expect(reopened.text).toBe('\uFEFFbeta\n');
    expect(reopened.readOnly).toBe(true);
    expect(reopened.lifecycle?.edit).toMatchObject({ availability: 'read-only', commands: [] });
    expect(reopened.lifecycle?.save).toMatchObject({ availability: 'read-only', commands: [] });
    await expect(
      reopenedDispatcher.execute({
        target: { documentId: initial.documentId },
        expectedRevision: reopened.revision,
        operation: { kind: 'replace-text', from: 0, to: 0, text: 'refused' },
      })
    ).rejects.toThrow('READ_ONLY_FILE');
    expect(await readFile(path, 'utf8')).toBe('\uFEFFbeta\r\n');
    await reopenedOwner.close();
  });

  it('resolves qualified paths and keeps exact bytes and identity after restart and a closed-file move', async () => {
    const path = join(root, 'closed.py'),
      destination = join(root, 'moved.py');
    await writeFile(path, '\uFEFFalpha\r\n');
    const owner = createOwner();
    const initial = await owner.execute({
      target: { path: 'File project/closed.py' },
      operation: inspectOperation,
    });
    const changed = await owner.execute({
      target: { documentId: initial.documentId },
      expectedRevision: initial.revision,
      operation: { kind: 'replace-text', from: 1, to: 6, text: 'beta' },
    });
    await owner.execute({
      target: { documentId: initial.documentId },
      expectedRevision: changed.revision,
      operation: { kind: 'save' },
    });
    await owner.close();
    const restarted = createOwner();
    const closed = await restarted.execute({
      target: { documentId: initial.documentId },
      operation: inspectOperation,
    });
    expect(closed.text).toBe('\uFEFFbeta\n');
    await restarted.close();
    const mover = createOwner();
    await mover.withCleanPaths([path, destination], async () => {
      await rename(path, destination);
      await mover.relocate(path, destination);
    });
    const relocated = await createOwner().execute({
      target: { documentId: initial.documentId },
      operation: inspectOperation,
    });
    expect(relocated.documentId).toBe(initial.documentId);
    expect(relocated.path).toBe(destination);
    expect(await readFile(destination, 'utf8')).toBe('\uFEFFbeta\r\n');
  });

  it('retains old recovery before acknowledging migration and protects dirty closed drafts', async () => {
    const path = join(root, 'recovery.txt');
    await writeFile(path, 'accepted');
    await mkdir(join(profile, 'IndexedDB'), { recursive: true });
    const owner = createOwner();
    await expect(owner.execute({ target: { path }, operation: inspectOperation })).rejects.toThrow(
      'LEGACY_FILE_DRAFT_MIGRATION_REQUIRED'
    );
    owner.beginLegacyMigration();
    const receipt = await owner.retainLegacyDraft({
      kind: 'text',
      path,
      baseline: legacyFileDraftFingerprint('accepted'),
      payload: 'retained draft',
    });
    await owner.completeLegacyMigration([]);
    const pending = await owner.execute({
      target: { documentId: receipt.documentId },
      operation: inspectOperation,
    });
    expect(pending.recoveryId).toBe(receipt.recoveryId);
    expect(await readFile(path, 'utf8')).toBe('accepted');
    const restored = await owner.execute({
      target: { documentId: receipt.documentId },
      expectedRevision: pending.revision,
      operation: { kind: 'restore-recovery', recoveryId: receipt.recoveryId },
    });
    expect(restored.dirty).toBe(true);
    await owner.close();
    await expect(createOwner().assertClean(root)).rejects.toThrow('DIRTY_FILE_DRAFT');
    expect(await readFile(path, 'utf8')).toBe('accepted');
  });

  it('rechecks live read-only enrollment and rejects private UI requests at the public boundary', async () => {
    const path = join(root, 'access.txt');
    await writeFile(path, 'accepted');
    const owner = createOwner();
    const initial = await owner.execute({ target: { path }, operation: inspectOperation });
    writable = [];
    const readonly = await owner.execute({
      target: { documentId: initial.documentId },
      operation: inspectOperation,
    });
    expect(readonly.readOnly).toBe(true);
    await expect(
      owner.execute({
        target: { documentId: initial.documentId },
        expectedRevision: readonly.revision,
        operation: { kind: 'replace-text', from: 0, to: 0, text: 'refused' },
      })
    ).rejects.toThrow('READ_ONLY_FILE');
    expect(
      fileDocumentAgentRequestSchema.safeParse({
        target: { path },
        operation: { kind: 'text-transaction', changes: [] },
      }).success
    ).toBe(false);
    expect(
      fileDocumentAgentRequestSchema.safeParse({
        target: { path },
        operation: { kind: 'inspect' },
        projection: 'document',
      }).success
    ).toBe(false);
    expect(await readFile(path, 'utf8')).toBe('accepted');
  });
});

describe('workspace root recovery native identities', () => {
  it('retains a catalog-bound ordinary document ID before path reopen and after restart', async () => {
    const oldRoot = root,
      movedRoot = `${root}-moved`,
      path = join(root, 'bound.txt');
    const contents = 'Retained original contents.\n';
    const uuid = '11111111-2222-4333-8444-555555555555';
    await mkdir(join(root, '.git'));
    await writeFile(
      join(root, MANAGED_WORKSPACE_MARKER),
      JSON.stringify({ schema: 1, workspaceUuid: uuid })
    );
    await writeFile(path, contents);
    db.prepare('UPDATE workspaces SET repo_uuid=? WHERE id=7').run(uuid);
    const entity = registerCatalogEntityInDb(db, {
      type: 'file',
      name: 'Bound',
      locator: `file://${path}`,
      storageType: 'file',
      workspaceRoot: root,
    });
    bindCatalogEntityFileInDb(db, {
      entityId: entity.id,
      path,
      fileKind: 'text',
      workspaceRoot: root,
    });
    const owner = createOwner(),
      dispatcher = new NativeDocumentDispatcher({ ordinary: owner, db: () => db, adapters: [] });
    await owner.completeLegacyMigration([]);
    const initial = await dispatcher.execute({
      target: { path },
      projection: 'document',
      operation: inspectOperation,
    });
    expect(initial.documentId).toBe(entity.id);
    await expect(dispatcher.rootRelinkBlocker(root)).resolves.toBeNull();
    await rename(root, movedRoot);
    await dispatcher.withCleanPaths([root, movedRoot], async () => {
      expect(await dispatcher.rootRelinkBlocker(root)).toBeNull();
      expect(relinkWorkspaceRoot(db, { repoPath: root, selectedPath: movedRoot })).toEqual({
        status: 'relinked',
        workspaceId: 7,
        repoPath: movedRoot,
      });
    });
    root = movedRoot;
    writable = [root];
    const target = { documentId: initial.documentId };
    expect(
      await dispatcher.execute({ target, projection: 'document', operation: inspectOperation })
    ).toMatchObject({ documentId: entity.id, path: join(root, 'bound.txt'), content: contents });
    await owner.close();
    const reopenedOwner = createOwner(),
      reopened = new NativeDocumentDispatcher({
        ordinary: reopenedOwner,
        db: () => db,
        adapters: [],
      });
    try {
      expect(
        await reopened.execute({ target, projection: 'document', operation: inspectOperation })
      ).toMatchObject({ documentId: entity.id, path: join(root, 'bound.txt'), content: contents });
      expect(await readFile(join(root, 'bound.txt'), 'utf8')).toBe(contents);
      expect(db.prepare('SELECT path FROM workspaces WHERE id=7').get()).toEqual({ path: root });
    } finally {
      await reopenedOwner.close();
    }
  });

  it('binds a newly opened managed ordinary file before root recovery and retains its ID after restart', async () => {
    const oldRoot = root,
      movedRoot = `${root}-moved`,
      path = join(root, 'bound.txt');
    const contents = 'Retained original contents.\n';
    const uuid = '11111111-2222-4333-8444-555555555555';
    await mkdir(join(root, '.git'));
    await writeFile(
      join(root, MANAGED_WORKSPACE_MARKER),
      JSON.stringify({ schema: 1, workspaceUuid: uuid })
    );
    await writeFile(path, contents);
    db.prepare('UPDATE workspaces SET repo_uuid=? WHERE id=7').run(uuid);
    const owner = createOwner(),
      dispatcher = new NativeDocumentDispatcher({ ordinary: owner, db: () => db, adapters: [] });
    await owner.completeLegacyMigration([]);
    const initial = await dispatcher.execute({
      target: { path },
      projection: 'document',
      operation: inspectOperation,
    });
    expect(initial.documentId).not.toMatch(/^file-document:/);
    await expect(dispatcher.rootRelinkBlocker(root)).resolves.toBeNull();
    await rename(root, movedRoot);
    await dispatcher.withCleanPaths([root, movedRoot], async () => {
      expect(await dispatcher.rootRelinkBlocker(root)).toBeNull();
      expect(relinkWorkspaceRoot(db, { repoPath: root, selectedPath: movedRoot })).toEqual({
        status: 'relinked',
        workspaceId: 7,
        repoPath: movedRoot,
      });
    });
    root = movedRoot;
    writable = [root];
    const target = { documentId: initial.documentId };
    expect(
      await dispatcher.execute({ target, projection: 'document', operation: inspectOperation })
    ).toMatchObject({
      documentId: initial.documentId,
      path: join(root, 'bound.txt'),
      content: contents,
    });
    await owner.close();
    const reopenedOwner = createOwner(),
      reopened = new NativeDocumentDispatcher({
        ordinary: reopenedOwner,
        db: () => db,
        adapters: [],
      });
    try {
      expect(
        await reopened.execute({ target, projection: 'document', operation: inspectOperation })
      ).toMatchObject({
        documentId: initial.documentId,
        path: join(root, 'bound.txt'),
        content: contents,
      });
      expect(await readFile(join(root, 'bound.txt'), 'utf8')).toBe(contents);
      expect(db.prepare('SELECT path FROM workspaces WHERE id=7').get()).toEqual({ path: root });
    } finally {
      await reopenedOwner.close();
    }
  });

  it('refuses unbound retained file identities, including after their owner restarts', async () => {
    const path = join(root, 'unbound.txt');
    await writeFile(path, 'Retained clean file.\n');
    const owner = createOwner();
    const initial = await owner.execute({
      target: { path },
      projection: 'document',
      operation: inspectOperation,
    });
    expect(initial.documentId).toMatch(/^file-document:/);
    await expect(owner.rootRelinkBlocker(root)).resolves.toBe('unbound-file-document');
    await owner.close();
    const reopened = createOwner();
    try {
      await expect(reopened.rootRelinkBlocker(root)).resolves.toBe('unbound-file-document');
      expect(
        (
          await reopened.execute({
            target: { documentId: initial.documentId },
            projection: 'document',
            operation: inspectOperation,
          })
        ).content
      ).toBe('Retained clean file.\n');
      expect(db.prepare('SELECT path FROM workspaces WHERE id=7').get()).toEqual({ path: root });
    } finally {
      await reopened.close();
    }
  });

  it('refuses scientific documents before changing their root or recovery state', async () => {
    const path = join(root, 'retained.dnaforge-molecular-document.json');
    const bytes = '{}';
    await writeFile(path, bytes);
    const entity = registerCatalogEntityInDb(db, {
      type: 'protein',
      name: 'Retained protein',
      locator: `file://${path}`,
      storageType: 'file',
      workspaceRoot: root,
    });
    bindCatalogEntityFileInDb(db, {
      entityId: entity.id,
      path,
      fileKind: 'dnaforge-molecular-document',
      workspaceRoot: root,
    });
    const owner = createOwner(),
      dispatcher = new NativeDocumentDispatcher({ ordinary: owner, db: () => db, adapters: [] });
    try {
      await expect(dispatcher.rootRelinkBlocker(root)).resolves.toBe('scientific-document');
      expect(db.prepare('SELECT path FROM workspaces WHERE id=7').get()).toEqual({ path: root });
      expect(await readFile(path, 'utf8')).toBe(bytes);
    } finally {
      await owner.close();
    }
  });
});
