// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
import { createWorkspaceFileRelocator } from './workspace-file-relocation';
import { NativeDocumentDispatcher } from './native-document-dispatcher';
import { createNativeFileDocuments } from './native-file-documents';
import { nativeNotebookDocumentAdapter } from './native-notebook-document-adapter';
import { MolecularDocumentLibrary } from './molecular-document-library';
import { molecularDocumentFixture } from '../test/fixtures/molecular-documents';
import { runWorkspaceFileTrash } from './workspace-file-trash';
import { bindCatalogEntityFileInDb } from './catalog-file-binding';
import {
  molecularDocumentCatalogId,
  molecularDocumentReferenceFor,
  molecularDocumentReferenceFromHref,
} from '../shared/molecular-document-reference';

let directory: string, root: string, otherRoot: string, profile: string, db: Database.Database;
vi.mock('./ipc/database', () => ({ getDb: () => db }));

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'native-notebook-file-insertion-')));
  root = join(directory, 'project');
  otherRoot = join(directory, 'other-project');
  profile = join(directory, 'profile');
  await mkdir(root);
  await mkdir(otherRoot);
  db = createTestDb();
  ensureSchema(db, ':memory:');
  for (const [id, path] of [
    [7, root],
    [8, otherRoot],
  ] as const)
    db.prepare('INSERT INTO workspaces(id,name,path,created_at)VALUES(?,?,?,1)').run(
      id,
      `Project ${id}`,
      path
    );
});

afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

function notebookOwner() {
  const options = {
    db: () => db,
    workspaceRoots: () => [root, otherRoot],
    writableWorkspaceRoots: () => [root, otherRoot],
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
}

async function source() {
  const path = join(root, 'Saved result.dnaforge-molecular.json');
  const saved = await new MolecularDocumentLibrary().save({
    document: await molecularDocumentFixture(),
    destination: { workspaceRoot: root, path },
    expectedRevision: null,
  });
  const reference = await molecularDocumentReferenceFor('ws7', saved.document);
  const id = molecularDocumentCatalogId(reference);
  db.prepare(
    "INSERT INTO catalog_entities(id,type,name,locator,storage_type,status,workspace_id,created_at,updated_at) VALUES(?,'molecular-document',?,?,'file','active',7,1,1)"
  ).run(id, saved.document.name, `entity://molecular-document/${id}`);
  bindCatalogEntityFileInDb(db, {
    entityId: id,
    path,
    workspaceRoot: root,
    fileKind: 'molecular-document',
    status: 'current',
  });
  const inspected = await runWorkspaceFileTrash({ kind: 'inspect', workspaceRoot: root, path });
  if (inspected.kind !== 'inspect') throw new Error('Public source inspection did not complete.');
  return { path, reference, inspection: inspected.source, bytes: await readFile(path) };
}

describe('native notebook inspected molecular file insertion', () => {
  it('accepts the public workspace-files revision and inserts the exact saved molecular chip', async () => {
    const native = notebookOwner();
    const state = await native.create({
      title: 'Research notes',
      workspaceRoot: root,
      requestId: 'inspected-source-notebook',
    });
    const file = await source();
    await native.execute({
      documentId: state.documentId,
      expectedRevision: state.revision,
      operation: {
        kind: 'insert',
        index: state.blockCount,
        source: { kind: 'file', path: file.path, expectedRevision: file.inspection.revision },
      },
    });
    const after = await native.execute({
      documentId: state.documentId,
      operation: { kind: 'inspect', limit: 50 },
    });
    expect(after.blockCount).toBe(state.blockCount + 1);
    const paragraph = after.blocks!.at(-1)!.block;
    expect(paragraph.type).toBe('paragraph');
    const chip = paragraph.content![0];
    expect(chip.type).toBe('mention');
    expect(molecularDocumentReferenceFromHref(chip.attrs!.referenceUri)).toEqual(file.reference);
    expect(await readFile(file.path)).toEqual(file.bytes);
  });

  it('refuses a molecular file changed after public inspection without changing the notebook', async () => {
    const native = notebookOwner();
    const state = await native.create({
      title: 'Research notes',
      workspaceRoot: root,
      requestId: 'inspected-source-notebook',
    });
    const file = await source();
    await writeFile(file.path, Buffer.concat([file.bytes, Buffer.from('\n')]));
    await expect(
      native.execute({
        documentId: state.documentId,
        expectedRevision: state.revision,
        operation: {
          kind: 'insert',
          index: state.blockCount,
          source: { kind: 'file', path: file.path, expectedRevision: file.inspection.revision },
        },
      })
    ).rejects.toThrow(/Inspect this source file again|source file changed/);
    const after = await native.execute({
      documentId: state.documentId,
      operation: { kind: 'inspect' },
    });
    expect(after.revision).toBe(state.revision);
    expect(after.blockCount).toBe(state.blockCount);
  });

  it('refuses an inspected file in another project without changing the notebook', async () => {
    const native = notebookOwner();
    const state = await native.create({
      title: 'Research notes',
      workspaceRoot: root,
      requestId: 'inspected-source-notebook',
    });
    const file = await source();
    const foreignPath = join(otherRoot, 'Saved result.dnaforge-molecular.json');
    await writeFile(foreignPath, file.bytes);
    const inspected = await runWorkspaceFileTrash({
      kind: 'inspect',
      workspaceRoot: otherRoot,
      path: foreignPath,
    });
    if (inspected.kind !== 'inspect')
      throw new Error('Public foreign inspection did not complete.');
    await expect(
      native.execute({
        documentId: state.documentId,
        expectedRevision: state.revision,
        operation: {
          kind: 'insert',
          index: state.blockCount,
          source: { kind: 'file', path: foreignPath, expectedRevision: inspected.source.revision },
        },
      })
    ).rejects.toThrow('ordinary source file inside the notebook project');
    const after = await native.execute({
      documentId: state.documentId,
      operation: { kind: 'inspect' },
    });
    expect(after.revision).toBe(state.revision);
    expect(after.blockCount).toBe(state.blockCount);
  });
});
