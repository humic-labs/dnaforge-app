import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  parseSequencePackageDocument,
  sequencePackagePaths,
  SEQUENCE_PACKAGE_FILE_KIND,
} from '../../db/sequence-package';
import { getCatalogEntityForFilePath } from '../../db/workspace-catalog';
import { createFileTestDb, openFileTestDb } from '../../main/__tests__/test-db';
import { registerCatalogEntityInDb } from '../../main/catalog-entity-registration';
import { bindCatalogEntityFileInDb } from '../../main/catalog-file-binding';
import { createNativeSequenceDocumentResolver } from '../../main/native-sequence-document-resolver';
import { ensureSchema } from '../../main/schema';
import { convertTreeToPlasmidPackages } from '../../main/workspace-git/convert-tree-to-packages';
import { resolveSequenceDocumentIdForSource } from './sequence-document-repository';

const select = vi.hoisted(() => vi.fn());
vi.mock('../../platform', () => ({
  platform: () => ({
    db: { select },
    fs: {
      exists: async (path: string) => existsSync(path),
      readTextFile: async (path: string) => readFileSync(path, 'utf8'),
    },
  }),
}));
vi.mock('electron', () => ({ app: { getPath: vi.fn(), getVersion: () => 'test' } }));

it('reopens a migrated file through its declared product and persisted native catalog identity', async () => {
  const profile = createFileTestDb('sequence-source-identity');
  let db = profile.db;
  try {
    ensureSchema(db, profile.dbPath);
    const root = join(realpathSync(profile.tmpDir), 'project');
    mkdirSync(root);
    const original = join(root, 'pUC19.gb');
    copyFileSync(
      join(__dirname, '../../../../../test-fixtures/sequences/circular/pUC19.gb'),
      original
    );
    const migrated = await convertTreeToPlasmidPackages(root);
    expect(migrated.converted).toBe(1);
    expect(existsSync(original)).toBe(false);
    const packageRoot = join(root, 'pUC19');
    const marker = sequencePackagePaths(packageRoot).metaPath;
    const document = parseSequencePackageDocument(readFileSync(marker, 'utf8'));
    const product = sequencePackagePaths(packageRoot, {
      productFile: document.product.file,
    }).productPath;
    const sibling = join(packageRoot, 'other.gb');
    writeFileSync(sibling, 'unregistered sibling');

    db.prepare(
      "INSERT INTO workspaces (name,path,created_at,last_opened_at) VALUES ('Project',?,1,1)"
    ).run(root);
    registerCatalogEntityInDb(db, {
      id: document.id,
      type: 'sequence',
      name: document.name,
      locator: 'entity://sequence/' + document.id,
      storageType: 'file',
      workspaceRoot: root,
    });
    const binding = bindCatalogEntityFileInDb(db, {
      entityId: document.id,
      path: packageRoot,
      workspaceRoot: root,
      fileKind: SEQUENCE_PACKAGE_FILE_KIND,
      status: 'current',
    });
    db.close();
    db = openFileTestDb(profile.dbPath);
    select.mockImplementation(async (sql: string, params: (string | number | null)[]) =>
      db.prepare(sql).all(...params)
    );
    expect(await getCatalogEntityForFilePath(product)).toBeNull();
    const reopen = createNativeSequenceDocumentResolver({
      db: () => db,
      workspaceRoots: () => [root],
    });
    for (const path of [packageRoot, marker]) {
      db.prepare('UPDATE catalog_entity_files SET path=? WHERE id=?').run(path, binding.id);
      const id = await resolveSequenceDocumentIdForSource(product);
      expect(id).toBe(document.id);
      if (!id) throw new Error('The current product has no document identity.');
      expect(await reopen({ operationId: 'reopen', targetDocumentId: id })).toEqual({
        documentId: document.id,
        workspaceRoot: root,
        sourcePath: product,
      });
      expect(await resolveSequenceDocumentIdForSource(sibling)).toBeNull();
      expect(await resolveSequenceDocumentIdForSource(original)).toBeNull();
    }
    const loose = join(root, 'loose.gb');
    writeFileSync(loose, 'loose file');
    const looseEntity = registerCatalogEntityInDb(db, {
      id: 'loose-record',
      type: 'sequence',
      name: 'Loose',
      locator: 'file://' + loose,
      storageType: 'file',
      workspaceRoot: root,
    });
    bindCatalogEntityFileInDb(db, {
      entityId: looseEntity.id,
      path: loose,
      fileKind: 'genbank',
      workspaceRoot: root,
    });
    expect(await resolveSequenceDocumentIdForSource(loose)).toBe(looseEntity.id);
    db.prepare("UPDATE catalog_entity_files SET status='historical' WHERE id=?").run(binding.id);
    expect(await resolveSequenceDocumentIdForSource(product)).toBeNull();
  } finally {
    if (db.open) db.close();
    profile.cleanup();
  }
});
