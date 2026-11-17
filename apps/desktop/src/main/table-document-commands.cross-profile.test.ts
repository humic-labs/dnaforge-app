// @vitest-environment node

import { randomUUID } from 'node:crypto';
import { cp, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type Database from 'better-sqlite3';
import type { JSONContent } from '@tiptap/core';
import { afterEach, expect, it, vi } from 'vitest';
import { tableCommandFixture, identityTestPaths } from './__tests__/table-command-fixture';
import { createNativeNotebookWorkingCopies } from './native-notebook-working-copies';
import type { NativeNotebookWorkingCopyOwner } from './notebook-document-owner';
import { createWorkspaceFileRelocator } from './workspace-file-relocation';
import { NativeDocumentDispatcher } from './native-document-dispatcher';
import { nativeNotebookDocumentAdapter } from './native-notebook-document-adapter';
import { NativeTableDocumentCommands } from './table-document-commands';
import { publishTablePackageInMain, readTablePackageInMain } from './table-package';
import { readCanonicalNotebookPackage } from '../db/notebook-package-migration';
import { registerCatalogEntityInDb } from './catalog-entity-registration';
import { bindCatalogEntityFileInDb } from './catalog-file-binding';
import { ensureWorkspaceOwnerInDb } from './catalog-projection-commands';
import { settleNotebookPublicationInMain } from './notebook-publication';
import { notebookProjectionFingerprint } from '../shared/notebook-projection';
import { notebookPackagePaths } from '../db/notebook-package';
import {
  scopedProjectionId,
  stripWorkspaceScope,
  workspaceScopeKey,
} from '../shared/workspace-scoped-identity';
import { notebookTableReference, tableDocumentKey } from '../shared/table-document-reference';

let activeDb: Database.Database;
vi.mock('./ipc/database', () => ({ getDb: () => activeDb }));
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: {
    getPath: (name: 'home' | 'userData') => identityTestPaths[name],
    getVersion: () => 'test',
  },
  dialog: { showErrorBox: vi.fn() },
}));

const fixtures: Awaited<ReturnType<typeof tableCommandFixture>>[] = [];
const owners: NativeNotebookWorkingCopyOwner[] = [];
afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.close()));
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

function nativeProfile(fixture: Awaited<ReturnType<typeof tableCommandFixture>>) {
  activeDb = fixture.db;
  let tables: NativeTableDocumentCommands;
  let documents: NativeDocumentDispatcher;
  const relocation = createWorkspaceFileRelocator({
    db: fixture.options.db,
    fileDocuments: () => documents,
  });
  const notebooks = createNativeNotebookWorkingCopies({
    db: fixture.options.db,
    workspaceRoots: fixture.options.workspaceRoots,
    writableWorkspaceRoots: fixture.options.writableWorkspaceRoots,
    captureWorkspace: fixture.options.captureWorkspace,
    profileDirectory: () => join(fixture.userData, 'native-notebooks'),
    tableDocuments: () => tables,
    relocateEntityFile: (input) => relocation.relocateEntityFile(input),
  });
  documents = new NativeDocumentDispatcher({
    db: fixture.options.db,
    workspaceRoots: fixture.options.workspaceRoots,
    ordinary: fixture.files,
    adapters: [nativeNotebookDocumentAdapter(notebooks)],
  });
  owners.push(notebooks);
  fixture.options.notebookTables = notebooks.tableTransitions;
  tables = new NativeTableDocumentCommands(fixture.options);
  return { notebooks, tables };
}

async function canonicalNotebook(packageRoot: string) {
  return readCanonicalNotebookPackage(
    {
      readTextFile: (path) => readFile(path, 'utf8'),
      exists: async (path) => {
        try {
          await readFile(path);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          return false;
        }
      },
    },
    packageRoot
  );
}

it.each(['before-cutover', 'after-cutover'] as const)(
  'recovers a copied project in a fresh native profile after %s without reusing the old notebook scope',
  async (phase) => {
    const original = await tableCommandFixture();
    fixtures.push(original);
    const first = nativeProfile(original);
    let source = await first.notebooks.create({
      title: 'Portable notebook',
      workspaceRoot: original.workspaceRoot,
      requestId: randomUUID(),
    });
    const sourceDocumentId = source.documentId;
    const blockId = 'portable-source-table';
    const originalBlock: JSONContent = {
      type: 'embed',
      attrs: {
        type: 'table',
        version: 1,
        refId: blockId,
        data: {
          name: 'Portable table',
          rows: 1,
          cols: 2,
          cells: [
            [
              {
                value: 'original profile data',
                type: 'text',
                format: { bold: true },
              },
              { value: '=6+8', type: 'formula' },
            ],
          ],
          retained: { futureField: ['exact', { keep: true }] },
        },
      },
    };
    source = await first.notebooks.execute({
      documentId: sourceDocumentId,
      expectedRevision: source.revision,
      operation: {
        kind: 'splice-blocks',
        index: 0,
        deleteCount: source.blockCount,
        blocks: [originalBlock],
      },
    });
    source = await first.notebooks.execute({
      documentId: sourceDocumentId,
      expectedRevision: source.revision,
      operation: { kind: 'save' },
    });
    const legacyReference = notebookTableReference(sourceDocumentId, blockId);
    const promotionId = randomUUID();
    const destination = {
      workspaceRoot: original.workspaceRoot,
      packageRoot: join(original.workspaceRoot, 'Portable table'),
    };
    original.options.io = {
      publishPackage: async (input, dependencies) => {
        if (phase === 'after-cutover' && input.head.status === 'active')
          throw new Error('interrupted after source cutover before activation');
        const published = await publishTablePackageInMain(input, dependencies);
        if (phase === 'before-cutover' && input.head.status === 'pending-promotion')
          throw new Error('interrupted after staging before source cutover');
        return published;
      },
    };
    const attempt = await first.tables
      .execute({
        kind: 'promote',
        requestId: promotionId,
        source: legacyReference,
        expectedRevision: source.revision,
        destination,
      })
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      );
    if ('value' in attempt) expect(attempt.value.kind).toBe('promotion-pending');
    const pending = await readTablePackageInMain(destination);
    expect(pending.head.status).toBe('pending-promotion');
    expect(pending.head.promotionId).toBe(promotionId);
    const sourceBeforeCopy = await canonicalNotebook(source.path);
    expect(sourceBeforeCopy.parsed.content.content?.[0].attrs?.type).toBe(
      phase === 'before-cutover' ? 'table' : 'table-reference'
    );
    const intentPath = join('.forge', 'table-transitions', `${promotionId}.json`);
    const originalIntentBytes = await readFile(join(original.workspaceRoot, intentPath));
    await first.notebooks.close();

    const fresh = await tableCommandFixture();
    fixtures.push(fresh);
    const copiedRoot = join(fresh.home, 'Copied project');
    await cp(original.workspaceRoot, copiedRoot, { recursive: true });
    const workspaceId = ensureWorkspaceOwnerInDb(fresh.db, copiedRoot, 'writable', {
      name: 'Copied project',
    });
    expect(workspaceId).not.toBe(
      (
        original.db
          .prepare('SELECT id FROM workspaces WHERE path=?')
          .get(original.workspaceRoot) as {
          id: number;
        }
      ).id
    );
    fresh.roots.splice(0, fresh.roots.length, copiedRoot);
    const copiedSourcePath = join(copiedRoot, relative(original.workspaceRoot, source.path));
    const copiedSource = await canonicalNotebook(copiedSourcePath);
    const portableNotebookId = stripWorkspaceScope(sourceDocumentId);
    expect(copiedSource.metadata.id).toBe(portableNotebookId);
    const currentDocumentId = scopedProjectionId(
      workspaceScopeKey(null, workspaceId),
      copiedSource.metadata.id
    );
    expect(currentDocumentId).not.toBe(sourceDocumentId);
    const entity = registerCatalogEntityInDb(fresh.db, {
      id: currentDocumentId,
      type: 'notebook',
      name: copiedSource.parsed.title,
      locator: `entity://page/${currentDocumentId}`,
      storageType: 'database',
      workspaceRoot: copiedRoot,
      metadata: { backingStore: 'pages' },
    });
    bindCatalogEntityFileInDb(fresh.db, {
      entityId: entity.id,
      path: copiedSourcePath,
      fileKind: 'waypoint-notebook',
      workspaceRoot: copiedRoot,
      status: 'current',
    });
    expect(
      fresh.db.prepare('SELECT id FROM catalog_entities WHERE id=?').get(sourceDocumentId)
    ).toBeUndefined();
    await settleNotebookPublicationInMain(fresh.db, {
      pageId: currentDocumentId,
      workspaceRoot: copiedRoot,
      sourcePath: notebookPackagePaths(copiedSourcePath).metaPath,
      sourceFingerprint: notebookProjectionFingerprint(
        copiedSource.parsed.title,
        copiedSource.parsed.content
      ),
      expectedProjectionFingerprint: null,
    });
    const second = nativeProfile(fresh);
    const freshInspection = await second.notebooks.execute({
      documentId: currentDocumentId,
      operation: { kind: 'inspect-copy' },
    });
    expect(freshInspection.copy.content).toEqual(sourceBeforeCopy.parsed.content);
    if (phase === 'after-cutover') expect(freshInspection.readOnly).toBe(true);
    expect(freshInspection.publication?.status).toBe('settled');
    await expect(
      second.notebooks.execute({
        documentId: sourceDocumentId,
        operation: { kind: 'inspect-copy' },
      })
    ).rejects.toThrow();

    const recovered = await second.tables.execute({
      kind: 'recover-promotion',
      requestId: randomUUID(),
      workspaceRoot: copiedRoot,
      promotionId,
    });
    expect(recovered.kind).toBe('promoted');
    if (recovered.kind !== 'promoted') throw new Error('The portable transition did not settle.');
    const copiedDestination = {
      workspaceRoot: copiedRoot,
      packageRoot: join(copiedRoot, 'Portable table'),
    };
    const active = await readTablePackageInMain(copiedDestination);
    expect(active.head.id).toBe(pending.head.id);
    expect(active.head.status).toBe('active');
    expect(active.snapshotText).toBe(pending.snapshotText);
    expect(active.head.aliases).toEqual(pending.head.aliases);
    expect(active.head.aliases[0]).toMatchObject({
      notebookId: portableNotebookId,
      blockId,
      legacyReference,
    });
    const after = await second.notebooks.execute({
      documentId: currentDocumentId,
      operation: { kind: 'inspect-copy' },
    });
    expect(after).toMatchObject({
      documentId: currentDocumentId,
      dirty: false,
      saving: false,
    });
    const placement = after.copy.content.content?.[0];
    expect(placement?.attrs?.type).toBe('table-reference');
    expect(tableDocumentKey(placement?.attrs?.data.reference)).toBe(
      tableDocumentKey(recovered.table.reference)
    );
    expect(await readFile(join(copiedRoot, intentPath))).toEqual(originalIntentBytes);
    expect((await readTablePackageInMain(destination)).headText).toBe(pending.headText);
    expect((await canonicalNotebook(source.path)).markdown).toBe(sourceBeforeCopy.markdown);
  }
);
