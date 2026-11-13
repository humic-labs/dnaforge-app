import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type Database from 'better-sqlite3';
import { createTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { registerLimsEntityInDb } from './lims';
import {
  buildSequencePackageDocument,
  sequencePackagePaths,
  serializeSequencePackageDocument,
} from '../db/sequence-package';
import { SEQUENCE_PACKAGE_METADATA_TRANSACTION_NAME } from '../db/sequence-package-contract';
import { MANAGED_SEQUENCE_DOCUMENT_FIELD } from '../shared/managed-sequence-document';
import { createNativeSequenceDocumentResolver } from './native-sequence-document-resolver';
import * as boundedRead from './ipc/bounded-file-read';
import { createNativeSequenceWorkingCopies } from './native-sequence-working-copies';
import * as sequenceSave from './sequence-document-save';
import * as primerBindings from './native-rich-paste-primer-bindings';

vi.mock('electron', () => ({ app: { getPath: vi.fn(), getVersion: () => 'test' } }));

let db: Database.Database;
let root: string;
let workspaceId: number;
let roots: string[];
let resolve: ReturnType<typeof createNativeSequenceDocumentResolver>;
const target = { operationId: 'operation-a', targetDocumentId: 'document-a' };

beforeEach(async () => {
  db = createTestDb();
  ensureSchema(db, ':memory:');
  root = await realpath(await mkdtemp(join(tmpdir(), 'native-document-resolver-')));
  workspaceId = Number(
    db
      .prepare(`INSERT INTO workspaces (name,path,created_at,last_opened_at) VALUES ('Test',?,1,1)`)
      .run(root).lastInsertRowid
  );
  roots = [root];
  resolve = createNativeSequenceDocumentResolver({ db: () => db, workspaceRoots: () => roots });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.restoreAllMocks();
  db.close();
  await rm(root, { recursive: true, force: true });
});

it('refuses a workspace that was moved to trash without being archived', async () => {
  await loose();
  db.prepare('UPDATE workspaces SET trashed_at=2 WHERE id=?').run(workspaceId);
  await expect(resolve(target)).rejects.toThrow(/active owning workspace/i);
});

async function loose(path = join(root, 'ordinary.gb')) {
  await writeFile(path, 'ordinary file bytes');
  catalog(path);
  return path;
}

function catalog(path: string, fileKind = 'genbank') {
  db.prepare(
    `INSERT INTO catalog_entities
    (id,type,name,locator,storage_type,workspace_id,created_at,updated_at)
    VALUES (?, 'sequence','Test',?,'file',?,1,1)`
  ).run(target.targetDocumentId, path, workspaceId);
  db.prepare(
    `INSERT INTO catalog_entity_files
    (id,entity_id,workspace_id,path,file_kind,created_at,updated_at)
    VALUES ('file-a',?,?,?,?,1,1)`
  ).run(target.targetDocumentId, workspaceId, path, fileKind);
}

async function managed(documentId = target.targetDocumentId) {
  const packageRoot = join(root, 'Package');
  const paths = sequencePackagePaths(packageRoot, { productFile: 'original.gb' });
  await mkdir(paths.metaDir, { recursive: true });
  const document = buildSequencePackageDocument({
    id: documentId,
    name: 'Package',
    product: { file: basename(paths.productPath) },
  });
  await writeFile(paths.metaPath, serializeSequencePackageDocument(document));
  await writeFile(paths.productPath, 'product bytes');
  catalog(paths.metaPath, 'waypoint-sequence');
  registerLimsEntityInDb(db, {
    id: target.targetDocumentId,
    kind: 'sequence',
    name: 'Package',
    workspaceId,
    actor: 'test',
    fields: {
      [MANAGED_SEQUENCE_DOCUMENT_FIELD]: {
        kind: 'managed-sequence',
        packageId: target.targetDocumentId,
        packageRoot,
      },
    },
  });
  return paths;
}

describe('native managed-package working-copy binding', () => {
  const inspect = {
    kind: 'inspect' as const,
    start: 0,
    limit: 1000,
    annotationOffset: 0,
    annotationLimit: 50,
  };
  const owner = (captureWorkspace = () => () => {}) =>
    createNativeSequenceWorkingCopies({
      db: () => db,
      workspaceRoots: () => roots,
      writableWorkspaceRoots: () => roots,
      profileDirectory: () => join(root, 'native-profile'),
      captureWorkspace,
    });

  it('admits primer settlement after a captured write under its own fenced sequence identity update', async () => {
    const paths = await managed();
    await writeFile(
      paths.productPath,
      await readFile(
        new URL('../../../../test-fixtures/sequences/circular/pUC19.gb', import.meta.url)
      )
    );
    const before = await readFile(paths.productPath);
    const settlement = vi
      .spyOn(primerBindings, 'persistRichPastePrimerBindingsInMain')
      .mockImplementation(async (input, options) => {
        options.assertCurrent();
        expect(input.targetDocumentId).toBe(target.targetDocumentId);
        expect(input.targetSequenceId).toBeGreaterThan(0);
        throw new Error('Native primer settlement reached after fenced identity');
      });
    const current = owner();
    try {
      const initial = await current.execute({
        documentId: target.targetDocumentId,
        operation: inspect,
        projection: 'document',
      });
      const edited = await current.execute({
        documentId: target.targetDocumentId,
        expectedVersion: initial.version,
        operation: {
          kind: 'client-command',
          command: {
            method: 'dispatchEdit',
            action: {
              type: 'INSERT_FRAGMENT',
              fragment: {
                sequence: 'AT',
                annotations: [],
                primerBindings: [
                  { primerId: 'pending-native-primer', start: 0, end: 2, strand: 1 },
                ],
              },
            },
          },
        },
        projection: 'document',
      });
      await expect(
        current.execute({
          documentId: target.targetDocumentId,
          expectedVersion: edited.version,
          operation: { kind: 'save', message: 'Fenced primer settlement' },
          projection: 'document',
        })
      ).rejects.toThrow('Native primer settlement reached after fenced identity');
      expect(settlement).toHaveBeenCalledOnce();
      expect(await readFile(paths.productPath)).not.toEqual(before);
      expect(current.model.getState().isDirty(target.targetDocumentId)).toBe(true);
      expect(
        current.model.getState().captureForSave(target.targetDocumentId)?.pendingPrimerBindings
      ).toHaveLength(1);
    } finally {
      await current.close();
    }
  });

  it.each([
    'view replacement',
    'path',
    'kind',
    'reference',
    'archived',
    'viewer',
    'package identity',
    'database',
    'workspace identity',
  ] as const)('rechecks captured Save resource authority after %s', async (change) => {
    const admittedDatabase = db;
    let replacementDatabase: Database.Database | undefined;
    const paths = await managed();
    await writeFile(
      paths.productPath,
      await readFile(
        new URL('../../../../test-fixtures/sequences/circular/pUC19.gb', import.meta.url)
      )
    );
    const before = await readFile(paths.productPath);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = sequenceSave.saveSequenceDocumentWithLineage;
    vi.spyOn(sequenceSave, 'saveSequenceDocumentWithLineage').mockImplementation(
      async (input, dependencies) => {
        entered.resolve();
        await release.promise;
        return original(input, dependencies);
      }
    );
    const current = owner();
    try {
      const initial = await current.execute({
        documentId: target.targetDocumentId,
        operation: inspect,
        projection: 'document',
      });
      const edited = await current.execute({
        documentId: target.targetDocumentId,
        expectedVersion: initial.version,
        operation: { kind: 'replace-bases', start: 0, end: 0, bases: 'AT', expectedBases: '' },
        projection: 'document',
      });
      const capture = await current.execute({
        documentId: target.targetDocumentId,
        expectedVersion: edited.version,
        operation: { kind: 'capture-save', message: 'Captured resource authority' },
        projection: 'document',
      });
      if (!capture.captureId) throw new Error('Missing captured Save');
      await entered.promise;
      roots = [];
      if (change === 'path')
        db.prepare('UPDATE catalog_entity_files SET path=? WHERE entity_id=?').run(
          join(root, 'replacement.gb'),
          target.targetDocumentId
        );
      if (change === 'kind')
        db.prepare("UPDATE catalog_entity_files SET file_kind='genbank' WHERE entity_id=?").run(
          target.targetDocumentId
        );
      if (change === 'reference')
        db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=?").run(workspaceId);
      if (change === 'archived')
        db.prepare('UPDATE workspaces SET archived_at=2 WHERE id=?').run(workspaceId);
      if (change === 'viewer') {
        const uuid = '972e56b6-c03a-4ec7-a209-8f90b1836f5a';
        db.prepare('UPDATE workspaces SET repo_uuid=? WHERE id=?').run(uuid, workspaceId);
        db.prepare(
          "INSERT INTO workspace_sync_bindings(workspace_id,workspace_uuid,access_role,enabled,owner_account_id,created_at,updated_at) VALUES (?,?,'viewer',1,'test-account',1,1)"
        ).run(workspaceId, uuid);
      }
      if (change === 'package identity') {
        const metadata = JSON.parse(await readFile(paths.metaPath, 'utf8'));
        metadata.id = 'replacement-package-identity';
        await writeFile(paths.metaPath, serializeSequencePackageDocument(metadata));
      }
      if (change === 'database') {
        replacementDatabase = createTestDb();
        ensureSchema(replacementDatabase, ':memory:');
        db = replacementDatabase;
      }
      if (change === 'workspace identity') {
        db.prepare('UPDATE workspaces SET path=? WHERE id=?').run(root + '-previous', workspaceId);
        const replacementId = Number(
          db
            .prepare(
              "INSERT INTO workspaces(name,path,created_at,last_opened_at) VALUES ('Replacement',?,1,1)"
            )
            .run(root).lastInsertRowid
        );
        db.prepare('UPDATE catalog_entity_files SET workspace_id=? WHERE entity_id=?').run(
          replacementId,
          target.targetDocumentId
        );
      }
      release.resolve();
      const publication = current.execute({
        documentId: target.targetDocumentId,
        operation: { kind: 'publish-save', captureId: capture.captureId },
        projection: 'document',
      });
      if (change === 'view replacement') {
        await expect(publication).resolves.toMatchObject({ saved: true, dirty: false });
        expect(await readFile(paths.productPath)).not.toEqual(before);
      } else {
        await expect(publication).rejects.toThrow();
        expect(await readFile(paths.productPath)).toEqual(before);
        expect(current.model.getState().isDirty(target.targetDocumentId)).toBe(true);
      }
      await expect(
        current.execute({
          documentId: target.targetDocumentId,
          expectedVersion: edited.version,
          operation: { kind: 'capture-save', message: 'Unenrolled new Save' },
        })
      ).rejects.toThrow();
    } finally {
      release.resolve();
      await current.close();
      if (replacementDatabase) {
        db = admittedDatabase;
        replacementDatabase.close();
      }
    }
  });

  it('offers native sequence reconnect only for a current enrolled catalog binding', async () => {
    const current = owner();
    try {
      await expect(current.available(target.targetDocumentId)).resolves.toBe(false);
      await loose();
      await expect(current.available(target.targetDocumentId)).resolves.toBe(true);
      roots = [];
      await expect(current.available(target.targetDocumentId)).resolves.toBe(false);
      await expect(
        current.execute({ documentId: target.targetDocumentId, operation: inspect })
      ).rejects.toThrow(/enrolled/i);
      roots = [root];
      await expect(current.available(target.targetDocumentId)).resolves.toBe(true);
    } finally {
      await current.close();
    }
  });

  it('recognizes a native reconnect through an enrolled workspace alias without reading sequence bytes', async () => {
    await loose();
    const alias = root + '-alias';
    await symlink(root, alias);
    roots = [alias];
    const current = owner();
    try {
      await expect(current.available(target.targetDocumentId)).resolves.toBe(true);
    } finally {
      await current.close();
      await rm(alias);
    }
  });

  it('reloads an archived managed sequence read-only and rejects writes without changing its bytes', async () => {
    const paths = await managed();
    const product = await readFile(
      new URL('../../../../test-fixtures/sequences/circular/pUC19.gb', import.meta.url)
    );
    await writeFile(paths.productPath, product);
    const current = owner();
    try {
      const active = await current.execute({
        documentId: target.targetDocumentId,
        operation: inspect,
        projection: 'document',
      });
      expect(active.readOnly).toBe(false);
      const document = JSON.parse(await readFile(paths.metaPath, 'utf8'));
      document.entity.lifecycle = { archived: true, archivedAt: 2 };
      await writeFile(paths.metaPath, serializeSequencePackageDocument(document));
      const metadata = await readFile(paths.metaPath);
      db.prepare("UPDATE catalog_entities SET status='archived' WHERE id=?").run(
        target.targetDocumentId
      );
      db.prepare('UPDATE lims_entity SET tombstone=1,archived_at=2 WHERE id=?').run(
        target.targetDocumentId
      );
      const archived = await current.execute({
        documentId: target.targetDocumentId,
        operation: inspect,
        projection: 'document',
      });
      expect(archived).toMatchObject({ ready: true, readOnly: true, length: 2686 });
      await expect(
        current.execute({
          documentId: target.targetDocumentId,
          expectedVersion: archived.version,
          operation: {
            kind: 'replace-bases',
            start: 0,
            end: 1,
            bases: 'A',
            expectedBases: archived.copy!.sequence.sequence.slice(0, 1),
          },
          projection: 'document',
        })
      ).rejects.toThrow();
      expect(await readFile(paths.productPath)).toEqual(product);
      expect(await readFile(paths.metaPath)).toEqual(metadata);
    } finally {
      await current.close();
    }
  });

  it.each(['metadata', 'package root'] as const)(
    'inspects, edits and undoes a managed product with a %s binding without a view',
    async (binding) => {
      const paths = await managed();
      const catalogPath = binding === 'metadata' ? paths.metaPath : paths.root;
      db.prepare('UPDATE catalog_entity_files SET path=? WHERE id=?').run(catalogPath, 'file-a');
      await writeFile(
        paths.productPath,
        await readFile(
          new URL('../../../../test-fixtures/sequences/circular/pUC19.gb', import.meta.url)
        )
      );
      const current = owner();
      try {
        const initial = await current.execute({
          documentId: target.targetDocumentId,
          operation: inspect,
          projection: 'document',
        });
        expect(initial).toMatchObject({
          documentId: target.targetDocumentId,
          path: paths.productPath,
          workspaceRoot: root,
          ready: true,
          readOnly: false,
          length: 2686,
        });
        const first = initial.copy!.sequence.sequence[0];
        const changed = await current.execute({
          documentId: target.targetDocumentId,
          expectedVersion: initial.version,
          operation: {
            kind: 'replace-bases',
            start: 0,
            end: 1,
            bases: first === 'A' ? 'C' : 'A',
            expectedBases: first,
          },
          projection: 'document',
        });
        expect(changed.dirty).toBe(true);
        expect(changed.copy!.sequence.sequence).not.toBe(initial.copy!.sequence.sequence);
        const undone = await current.execute({
          documentId: target.targetDocumentId,
          expectedVersion: changed.version,
          operation: { kind: 'undo' },
          projection: 'document',
        });
        expect(undone.copy!.sequence.sequence).toBe(initial.copy!.sequence.sequence);
        expect(
          db.prepare('SELECT path FROM catalog_entity_files WHERE id=?').get('file-a')
        ).toEqual({
          path: catalogPath,
        });
      } finally {
        await current.close();
      }
    }
  );

  it.each(['path', 'kind'] as const)(
    'refuses a changed catalog %s after resolving the managed product',
    async (changed) => {
      const paths = await managed();
      let rebound = false;
      const current = owner(() => () => {
        if (rebound) return;
        rebound = true;
        if (changed === 'path')
          db.prepare('UPDATE catalog_entity_files SET path=? WHERE id=?').run(
            join(root, 'different-metadata.json'),
            'file-a'
          );
        else
          db.prepare('UPDATE catalog_entity_files SET file_kind=? WHERE id=?').run(
            'genbank',
            'file-a'
          );
      });
      try {
        await expect(
          current.execute({ documentId: target.targetDocumentId, operation: inspect })
        ).rejects.toThrow(/owner changed/i);
        expect(await readFile(paths.productPath, 'utf8')).toBe('product bytes');
      } finally {
        await current.close();
      }
    }
  );
});

describe('native sequence document lookup without a view', () => {
  it.each(['root', 'metadata'] as const)(
    'resolves a finalized construct through its current %s package binding without rewriting it',
    async (binding) => {
      const paths = await managed();
      db.prepare("UPDATE catalog_entities SET type='construct' WHERE id=?").run(
        target.targetDocumentId
      );
      db.prepare('UPDATE catalog_entity_files SET path=? WHERE entity_id=?').run(
        binding === 'root' ? paths.root : paths.metaPath,
        target.targetDocumentId
      );
      const before = db.prepare('SELECT total_changes() AS count').get();
      expect(await resolve(target)).toEqual({
        documentId: target.targetDocumentId,
        workspaceRoot: root,
        sourcePath: paths.productPath,
      });
      expect(db.prepare('SELECT total_changes() AS count').get()).toEqual(before);
    }
  );

  it('refuses a construct without an authoritative sequence package binding', async () => {
    await loose();
    db.prepare("UPDATE catalog_entities SET type='construct' WHERE id=?").run(
      target.targetDocumentId
    );
    await expect(resolve(target)).rejects.toThrow(/sequence document/i);
  });

  it.each(['alias', 'physical'] as const)(
    'keeps an explicitly enrolled workspace alias usable with a %s file binding',
    async (binding) => {
      const path = await loose();
      const alias = join(root, 'workspace-alias');
      await symlink(root, alias, 'dir');
      db.prepare('UPDATE workspaces SET path=? WHERE id=?').run(alias, workspaceId);
      if (binding === 'alias') {
        db.prepare('UPDATE catalog_entity_files SET path=? WHERE id=?').run(
          join(alias, basename(path)),
          'file-a'
        );
      }
      roots = [alias];
      expect(await resolve(target)).toEqual({
        documentId: target.targetDocumentId,
        workspaceRoot: root,
        sourcePath: path,
      });
    }
  );

  it('follows the current package binding after its folder moves while the older projection remains', async () => {
    const paths = await managed();
    const moved = join(root, 'Renamed package');
    await rename(paths.root, moved);
    const current = sequencePackagePaths(moved, { productFile: 'original.gb' });
    db.prepare('UPDATE catalog_entity_files SET path=? WHERE id=?').run(current.metaPath, 'file-a');
    expect((await resolve(target)).sourcePath).toBe(current.productPath);
  });

  it('resolves the current catalog binding after a rename, without changing any database row', async () => {
    const oldPath = await loose();
    const newPath = join(root, 'renamed.gb');
    await rename(oldPath, newPath);
    db.prepare('UPDATE catalog_entity_files SET path=? WHERE id=?').run(newPath, 'file-a');
    const before = db.prepare('SELECT total_changes() AS count').get();
    expect(await resolve(target)).toEqual({
      documentId: target.targetDocumentId,
      workspaceRoot: root,
      sourcePath: newPath,
    });
    expect(db.prepare('SELECT total_changes() AS count').get()).toEqual(before);
  });

  it('does not treat a historically known workspace as an enrolled workspace', async () => {
    await loose();
    roots = [];
    await expect(resolve(target)).rejects.toThrow(/enrolled/i);
  });

  it('requires explicit enrollment of a nested owning workspace', async () => {
    const nested = join(root, 'Nested workspace');
    await mkdir(nested);
    const path = await loose(join(nested, 'ordinary.gb'));
    db.prepare('UPDATE workspaces SET path=? WHERE id=?').run(nested, workspaceId);
    const before = db.prepare('SELECT total_changes() AS count').get();

    await expect(resolve(target)).rejects.toThrow(/enrolled/i);
    expect(await readFile(path, 'utf8')).toBe('ordinary file bytes');
    expect(db.prepare('SELECT total_changes() AS count').get()).toEqual(before);

    roots = [root, nested];
    expect(await resolve(target)).toEqual({
      documentId: target.targetDocumentId,
      workspaceRoot: nested,
      sourcePath: path,
    });
    expect(db.prepare('SELECT total_changes() AS count').get()).toEqual(before);
  });

  it('refuses an old catalog file after its enrolled workspace alias is retargeted', async () => {
    const path = await loose();
    const alias = join(root, 'workspace-alias');
    await symlink(root, alias, 'dir');
    db.prepare('UPDATE workspaces SET path=? WHERE id=?').run(alias, workspaceId);
    roots = [alias];
    expect((await resolve(target)).sourcePath).toBe(path);

    const replacement = join(root, 'Replacement workspace');
    await mkdir(replacement);
    const decoy = join(replacement, basename(path));
    await writeFile(decoy, 'another physical document');
    await rm(alias);
    await symlink(replacement, alias, 'dir');
    const before = db.prepare('SELECT total_changes() AS count').get();

    await expect(resolve(target)).rejects.toThrow(/owning workspace/i);
    expect(await readFile(path, 'utf8')).toBe('ordinary file bytes');
    expect(await readFile(decoy, 'utf8')).toBe('another physical document');
    expect(db.prepare('SELECT total_changes() AS count').get()).toEqual(before);
  });

  it('rejects a second current binding without changing either file or the original binding', async () => {
    const path = await loose();
    const other = join(root, 'another.gb');
    await writeFile(other, 'another current file');
    const before = db.prepare('SELECT total_changes() AS count').get();
    const bindingsBefore = db.prepare('SELECT * FROM catalog_entity_files ORDER BY id').all();
    const insert = db.prepare(
      `INSERT INTO catalog_entity_files
      (id,entity_id,workspace_id,path,file_kind,created_at,updated_at)
      VALUES (?,?,?,?,?,1,1)`
    );

    expect(() =>
      insert.run('file-b', target.targetDocumentId, workspaceId, other, 'genbank')
    ).toThrow(/UNIQUE constraint failed: catalog_entity_files.entity_id/);
    expect(await resolve(target)).toEqual({
      documentId: target.targetDocumentId,
      workspaceRoot: root,
      sourcePath: path,
    });
    expect(await readFile(path, 'utf8')).toBe('ordinary file bytes');
    expect(await readFile(other, 'utf8')).toBe('another current file');
    expect(db.prepare('SELECT * FROM catalog_entity_files ORDER BY id').all()).toEqual(
      bindingsBefore
    );
    expect(db.prepare('SELECT total_changes() AS count').get()).toEqual(before);
  });

  it('refuses an archived workspace even when its root is still enrolled', async () => {
    await loose();
    db.prepare('UPDATE workspaces SET archived_at=1 WHERE id=?').run(workspaceId);
    await expect(resolve(target)).rejects.toThrow(/workspace/i);
  });

  it('refuses archived, missing and stale catalog sources', async () => {
    await expect(resolve(target)).rejects.toThrow(/document/i);
    const path = await loose();
    db.prepare("UPDATE catalog_entities SET status='archived'").run();
    await expect(resolve(target)).rejects.toThrow(/document/i);
    db.prepare("UPDATE catalog_entities SET status='active'").run();
    db.prepare("UPDATE catalog_entity_files SET status='missing'").run();
    await expect(resolve(target)).rejects.toThrow(/current/i);
    db.prepare("UPDATE catalog_entity_files SET status='current'").run();
    await rm(path);
    await expect(resolve(target)).rejects.toThrow();
  });

  it('refuses a catalog path redirected through a symbolic link', async () => {
    const path = await loose();
    const other = join(root, 'other.gb');
    await rename(path, other);
    await symlink(other, path);
    await expect(resolve(target)).rejects.toThrow(/symbolic/i);
  });

  it('resolves a managed package through its metadata identity without rewriting metadata', async () => {
    const paths = await managed();
    const before = await readFile(paths.metaPath, 'utf8');
    expect(await resolve(target)).toEqual({
      documentId: target.targetDocumentId,
      workspaceRoot: root,
      sourcePath: paths.productPath,
    });
    expect(await readFile(paths.metaPath, 'utf8')).toBe(before);
  });

  it.each(['sequence', 'construct'] as const)(
    'resolves the current %s package-root catalog binding used by reconciliation',
    async (type) => {
      const paths = await managed();
      db.prepare('UPDATE catalog_entities SET type=? WHERE id=?').run(
        type,
        target.targetDocumentId
      );
      db.prepare('UPDATE catalog_entity_files SET path=? WHERE id=?').run(paths.root, 'file-a');

      expect(await resolve(target)).toEqual({
        documentId: target.targetDocumentId,
        workspaceRoot: root,
        sourcePath: paths.productPath,
      });
    }
  );

  it('refuses a construct catalog record without a managed package binding', async () => {
    await loose();
    db.prepare('UPDATE catalog_entities SET type=? WHERE id=?').run(
      'construct',
      target.targetDocumentId
    );
    await expect(resolve(target)).rejects.toThrow(/matching package binding/i);
  });

  it('uses the canonical package product resolver after a product rename', async () => {
    const paths = await managed();
    const moved = join(paths.root, 'renamed.gb');
    await rename(paths.productPath, moved);
    expect((await resolve(target)).sourcePath).toBe(moved);
    await writeFile(join(paths.root, 'another.gb'), 'other bytes');
    await expect(resolve(target)).rejects.toThrow(/ambiguous/i);
  });

  it('refuses a replaced package with another identity', async () => {
    await managed('another-document');
    await expect(resolve(target)).rejects.toThrow(/identity/i);
  });

  it('requires package migration before native editing and leaves the old format untouched', async () => {
    const paths = await managed();
    const old = JSON.parse(await readFile(paths.metaPath, 'utf8'));
    old.formatVersion = 5;
    const bytes = JSON.stringify(old);
    await writeFile(paths.metaPath, bytes);
    await expect(resolve(target)).rejects.toThrow(/migration/i);
    expect(await readFile(paths.metaPath, 'utf8')).toBe(bytes);
  });

  it('refuses an unfinished package metadata transaction without performing recovery', async () => {
    const paths = await managed();
    const pending = join(paths.metaDir, SEQUENCE_PACKAGE_METADATA_TRANSACTION_NAME);
    await writeFile(pending, 'interrupted metadata edit');
    await expect(resolve(target)).rejects.toThrow(/recovery/i);
    expect(await readFile(pending, 'utf8')).toBe('interrupted metadata edit');
  });

  it('does not fall back to loose-file lookup for an invalid managed locator', async () => {
    await managed();
    db.prepare('UPDATE lims_entity SET fields=? WHERE id=?').run(
      JSON.stringify({
        [MANAGED_SEQUENCE_DOCUMENT_FIELD]: { kind: 'managed-sequence', packageId: 'wrong' },
      }),
      target.targetDocumentId
    );
    await expect(resolve(target)).rejects.toThrow(/locator/i);
  });

  it('refuses a package metadata path redirected through a symbolic link', async () => {
    const paths = await managed();
    const moved = join(root, 'metadata.json');
    await rename(paths.metaPath, moved);
    await symlink(moved, paths.metaPath);
    await expect(resolve(target)).rejects.toThrow(/symbolic/i);
  });
});

describe('concurrent package metadata snapshots', () => {
  it('resolves a fresh complete marker after a publication finishes', async () => {
    const paths = await managed();
    const read = vi.spyOn(boundedRead, 'readFileBoundedFromHandle');
    read.mockRejectedValueOnce(new boundedRead.BoundedFileChangedError(paths.metaPath));

    await expect(resolve(target)).resolves.toMatchObject({
      documentId: target.targetDocumentId,
      sourcePath: paths.productPath,
      workspaceRoot: root,
    });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('refuses continued marker churn after three bounded attempts', async () => {
    const paths = await managed();
    const error = new boundedRead.BoundedFileChangedError(paths.metaPath);
    const read = vi.spyOn(boundedRead, 'readFileBoundedFromHandle').mockRejectedValue(error);

    await expect(resolve(target)).rejects.toBe(error);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('keeps size-limit failures final without retrying', async () => {
    const paths = await managed();
    const error = new boundedRead.BoundedFileReadLimitError(
      5 * 1024 * 1024,
      4 * 1024 * 1024,
      paths.metaPath
    );
    const read = vi.spyOn(boundedRead, 'readFileBoundedFromHandle').mockRejectedValue(error);

    await expect(resolve(target)).rejects.toBe(error);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('refuses a different document identity after reopening a changed marker', async () => {
    const paths = await managed();
    const read = vi.spyOn(boundedRead, 'readFileBoundedFromHandle');
    read.mockImplementationOnce(async () => {
      const marker = JSON.parse(await readFile(paths.metaPath, 'utf8'));
      marker.id = 'different-document';
      await writeFile(paths.metaPath, JSON.stringify(marker));
      throw new boundedRead.BoundedFileChangedError(paths.metaPath);
    });

    await expect(resolve(target)).rejects.toThrow('does not match the target document identity');
    expect(read).toHaveBeenCalledTimes(2);
  });
});
