import { promises as fs } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from './test-db';
import { existsSync } from 'node:fs';
import { validateWorkspacePathInMain } from '../primer-artifact-files';
import { findCurrentFilesByFilename } from '../../db/find-current-files-by-filename';
import { ensureSchema } from '../schema';
import { bindCatalogEntityFileInDb } from '../catalog-file-binding';
import { catalogSequenceIdForPath } from '../catalog-package-identity';
import { markCatalogFileMissing } from '../../db/workspace-catalog';
import { registerCatalogEntityInDb } from '../catalog-entity-registration';
import type { CatalogEntityRegistrationRequest } from '../../shared/catalog-registration';
import type { CatalogFileBindingRequest } from '../../shared/catalog-binding';
import {
  buildSequencePackageDocument,
  serializeSequencePackageDocument,
} from '../../db/sequence-package';
import { reconcileSequencePackageCatalogEntity } from '../../services/sequence-package-catalog-reconcile';
import { serializeGenBank } from '@waypoint/sequence-utils';

const bridge = vi.hoisted(() => ({
  db: null as Database.Database | null,
  afterFileRead: null as (() => void) | null,
}));

vi.mock('../../platform', () => ({
  platform: () => ({
    fs: {
      readTextFile: (path: string) => fs.readFile(path, 'utf8'),
      exists: async (path: string) => existsSync(path),
      validateWorkspacePath: validateWorkspacePathInMain,
    },
    db: {
      registerCatalogEntity: async (input: CatalogEntityRegistrationRequest) => {
        if (!bridge.db) throw new Error('Test database is not open.');
        return registerCatalogEntityInDb(bridge.db, input);
      },
      bindCatalogEntityFile: async (input: CatalogFileBindingRequest) => {
        if (!bridge.db) throw new Error('Test database is not open.');
        return bindCatalogEntityFileInDb(bridge.db, input);
      },
      select: async (sql: string, params: unknown[] = []) => {
        if (!bridge.db) throw new Error('Test database is not open.');
        const rows = bridge.db.prepare(sql).all(...params);
        if (bridge.afterFileRead && sql.includes('FROM catalog_entity_files')) {
          const afterRead = bridge.afterFileRead;
          bridge.afterFileRead = null;
          afterRead();
        }
        return rows;
      },
      execute: async (sql: string, params: unknown[] = []) => {
        if (!bridge.db) throw new Error('Test database is not open.');
        const result = bridge.db.prepare(sql).run(...params);
        return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
      },
      setCatalogFileState: async (
        path: string,
        state: 'missing' | 'historical',
        reason: string
      ) => {
        if (!bridge.db) throw new Error('Test database is not open.');
        const afterRead = bridge.afterFileRead;
        bridge.afterFileRead = null;
        afterRead?.();
        const { setCatalogFileStateInDb } = await import('../catalog-projection-commands');
        return setCatalogFileStateInDb(bridge.db, path, state, reason);
      },
    },
  }),
}));

const NOW = 1_700_000_000_000;

describe('catalog identity across loose-file conversion (real SQLite)', () => {
  let root: string;
  let db: Database.Database;
  let loosePath: string;
  let packageRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fixture-identity-'));
    loosePath = join(root, 'clone.fasta');
    packageRoot = join(root, 'clone');
    await fs.mkdir(join(packageRoot, '.forge'), { recursive: true });
    await fs.writeFile(
      join(packageRoot, '.forge', 'plasmid.json'),
      serializeSequencePackageDocument(
        buildSequencePackageDocument({
          id: 'clone-entity',
          name: 'clone',
          product: { file: 'clone.gb' },
        })
      )
    );
    await fs.writeFile(
      join(packageRoot, 'clone.gb'),
      serializeGenBank({
        id: 'clone-entity',
        name: 'clone',
        sequence: 'ACGT',
        length: 4,
        circular: false,
        annotations: [],
        description: '',
      })
    );
    db = createTestDb();
    bridge.db = db;
    bridge.afterFileRead = null;
    db.pragma('foreign_keys = ON');
    ensureSchema(db, ':memory:');
    db.prepare(
      `INSERT INTO workspaces (id, name, path, created_at) VALUES (1, 'W', ?, ${NOW})`
    ).run(root);
    db.prepare(
      `INSERT INTO catalog_entities (id, type, name, locator, storage_type, status, workspace_id, created_at, updated_at)
       VALUES ('clone-entity', 'sequence', 'clone', ?, 'file', 'active', 1, ${NOW}, ${NOW})`
    ).run(`file://${loosePath}`);
    bindCatalogEntityFileInDb(db, {
      entityId: 'clone-entity',
      path: loosePath,
      fileKind: 'fasta',
      workspaceRoot: root,
      objectUuid: 'clone-object',
    });
  });
  afterEach(async () => {
    bridge.db = null;
    bridge.afterFileRead = null;
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const rowAt = (path: string) =>
    db.prepare('SELECT status, object_uuid FROM catalog_entity_files WHERE path = ?').get(path) as {
      status: string;
      object_uuid: string | null;
    };

  const bindPackage = () =>
    bindCatalogEntityFileInDb(db, {
      entityId: 'clone-entity',
      path: packageRoot,
      fileKind: 'waypoint-sequence',
      workspaceRoot: root,
      supersedesMovedPath: loosePath,
    });

  it('finds the loose file identity that conversion should keep', () => {
    expect(catalogSequenceIdForPath(db, loosePath)).toBe('clone-entity');
    expect(catalogSequenceIdForPath(db, join(root, 'unknown.fasta'))).toBeUndefined();
  });

  it('moves the object identity to the package once the loose file is gone', () => {
    const bound = bindPackage();

    expect(bound.object_uuid).toBe('clone-object');
    expect(rowAt(loosePath)).toEqual({ status: 'historical', object_uuid: null });
  });

  it('reconstructs the converted package through strict native owners and frees the old locator', async () => {
    await expect(
      reconcileSequencePackageCatalogEntity({
        metaPath: join(packageRoot, '.forge', 'plasmid.json'),
        workspaceRoot: root,
      })
    ).resolves.toEqual({ entityId: 'clone-entity', name: 'clone', packageRoot });

    expect(rowAt(packageRoot)).toEqual({ status: 'current', object_uuid: 'clone-object' });
    expect(rowAt(loosePath)).toEqual({ status: 'historical', object_uuid: null });
    expect(
      db.prepare('SELECT locator FROM catalog_entities WHERE id=?').get('clone-entity')
    ).toEqual({
      locator: 'entity://sequence/clone-entity',
    });
    expect(
      registerCatalogEntityInDb(db, {
        id: 'independent-file',
        type: 'sequence',
        name: 'Independent file',
        locator: `file://${loosePath}`,
        storageType: 'file',
        workspaceRoot: root,
      }).id
    ).toBe('independent-file');
  });

  it.each([false, true])(
    'retains the object across a package move and return (already missing: %s)',
    async (markedMissing) => {
      const reconcile = (directory: string) =>
        reconcileSequencePackageCatalogEntity({
          metaPath: join(directory, '.forge', 'plasmid.json'),
          workspaceRoot: root,
        });
      const destination = join(root, 'renamed');
      await reconcile(packageRoot);
      await fs.rename(packageRoot, destination);
      if (markedMissing) await markCatalogFileMissing(packageRoot, 'workspace-reconcile');
      await reconcile(destination);
      expect(rowAt(destination)).toEqual({ status: 'current', object_uuid: 'clone-object' });
      expect(rowAt(packageRoot)).toEqual({ status: 'historical', object_uuid: null });
      await fs.rename(destination, packageRoot);
      await reconcile(packageRoot);
      expect(rowAt(destination)).toEqual({ status: 'historical', object_uuid: null });
      expect(rowAt(packageRoot)).toEqual({ status: 'current', object_uuid: 'clone-object' });
    }
  );

  it('finds the actual primary filename of a relocated package for a legacy reference', async () => {
    const renamed = join(root, 'renamed-directory');
    await fs.rename(packageRoot, renamed);
    await reconcileSequencePackageCatalogEntity({
      metaPath: join(renamed, '.forge', 'plasmid.json'),
      workspaceRoot: root,
    });
    const expected = {
      path: 'renamed-directory/clone.gb',
      objectUuid: 'clone-object',
      entityId: 'clone-entity',
    };
    const originalPath = 'before/clone.gb';
    expect(await findCurrentFilesByFilename(originalPath, root)).toMatchObject([expected]);
    db.prepare('UPDATE catalog_entities SET metadata=NULL WHERE id=?').run('clone-entity');
    expect(await findCurrentFilesByFilename(originalPath, root)).toMatchObject([expected]);
    const loose = join(root, 'clone.gb');
    await fs.copyFile(join(renamed, 'clone.gb'), loose);
    registerCatalogEntityInDb(db, {
      id: 'independent',
      type: 'sequence',
      name: 'Copy',
      locator: 'file://' + loose,
      storageType: 'file',
      workspaceRoot: root,
    });
    bindCatalogEntityFileInDb(db, {
      entityId: 'independent',
      workspaceRoot: root,
      path: loose,
      fileKind: 'genbank',
      objectUuid: 'other-object',
    });
    expect(
      (await findCurrentFilesByFilename(originalPath, root)).map((file) => file.objectUuid).sort()
    ).toEqual(['clone-object', 'other-object']);
    await fs.unlink(join(renamed, 'clone.gb'));
    expect(
      (await findCurrentFilesByFilename(originalPath, root)).map((file) => file.objectUuid)
    ).toEqual(['other-object']);
  });

  it('assigns a separate object to a package copy while the original directory exists', async () => {
    const reconcile = (directory: string) =>
      reconcileSequencePackageCatalogEntity({
        metaPath: join(directory, '.forge', 'plasmid.json'),
        workspaceRoot: root,
      });
    await reconcile(packageRoot);
    const copy = join(root, 'copy');
    await fs.cp(packageRoot, copy, { recursive: true });
    await reconcile(copy);
    expect(rowAt(copy).object_uuid).not.toBe('clone-object');
    expect(rowAt(packageRoot).object_uuid).toBe('clone-object');
  });

  it('refuses a mismatching package marker without moving catalog identity or history', async () => {
    await fs.writeFile(
      join(packageRoot, '.forge', 'plasmid.json'),
      serializeSequencePackageDocument(
        buildSequencePackageDocument({
          id: 'different-entity',
          name: 'Other source',
          product: { file: 'clone.gb' },
        })
      )
    );
    const before = ['catalog_entities', 'catalog_entity_files', 'catalog_entity_events'].map(
      (table) => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()
    );
    expect(bindPackage).toThrow(
      'Sequence package marker identity does not match its catalog entity.'
    );
    expect(
      ['catalog_entities', 'catalog_entity_files', 'catalog_entity_events'].map((table) =>
        db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()
      )
    ).toEqual(before);
  });

  it('rolls back the locator handoff when the package binding cannot be published', () => {
    db.exec(`CREATE TRIGGER refuse_package_binding BEFORE INSERT ON catalog_entity_files
      WHEN NEW.file_kind='waypoint-sequence'
      BEGIN SELECT RAISE(ABORT, 'package binding refused'); END`);
    const before = ['catalog_entities', 'catalog_entity_files', 'catalog_entity_events'].map(
      (table) => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()
    );

    expect(bindPackage).toThrow('package binding refused');
    expect(
      ['catalog_entities', 'catalog_entity_files', 'catalog_entity_events'].map((table) =>
        db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()
      )
    ).toEqual(before);
  });

  it('keeps identities apart while the loose file still exists', async () => {
    await writeFile(loosePath, '>clone\nACGT\n');

    const bound = bindPackage();

    expect(bound.object_uuid).not.toBe('clone-object');
    expect(rowAt(loosePath)).toEqual({ status: 'historical', object_uuid: 'clone-object' });
  });

  it('keeps the converted loose-file binding historical after missing-file reconciliation', async () => {
    bindPackage();

    await expect(markCatalogFileMissing(loosePath, 'workspace-reconcile')).resolves.toMatchObject({
      status: 'historical',
    });

    expect(rowAt(loosePath)).toEqual({ status: 'historical', object_uuid: null });
    expect(rowAt(packageRoot)).toEqual({ status: 'current', object_uuid: 'clone-object' });
    expect(
      db.prepare("SELECT id FROM catalog_entity_events WHERE event_type='file_missing'").all()
    ).toEqual([]);
  });

  it('preserves conversion accepted after a stale missing-file read', async () => {
    bridge.afterFileRead = bindPackage;

    await expect(markCatalogFileMissing(loosePath, 'workspace-reconcile')).resolves.toMatchObject({
      status: 'historical',
    });

    expect(rowAt(loosePath)).toEqual({ status: 'historical', object_uuid: null });
    expect(rowAt(packageRoot)).toEqual({ status: 'current', object_uuid: 'clone-object' });
    expect(
      db.prepare("SELECT id FROM catalog_entity_events WHERE event_type='file_missing'").all()
    ).toEqual([]);
  });

  it('marks a genuinely missing current binding once', async () => {
    await expect(markCatalogFileMissing(loosePath, 'workspace-reconcile')).resolves.toMatchObject({
      status: 'missing',
    });
    await markCatalogFileMissing(loosePath, 'workspace-reconcile');

    expect(rowAt(loosePath)).toEqual({ status: 'missing', object_uuid: 'clone-object' });
    expect(
      db
        .prepare("SELECT entity_id FROM catalog_entity_events WHERE event_type='file_missing'")
        .all()
    ).toEqual([{ entity_id: 'clone-entity' }]);
  });

  it('never reuses a project-scoped identity', () => {
    db.prepare(
      `INSERT INTO catalog_entities (id, type, name, locator, storage_type, status, workspace_id, created_at, updated_at)
       VALUES ('scope::native', 'sequence', 'n', 'file:///n', 'file', 'active', 1, ${NOW}, ${NOW})`
    ).run();
    const nativePath = join(root, 'native.gb');
    bindCatalogEntityFileInDb(db, {
      entityId: 'scope::native',
      path: nativePath,
      fileKind: 'genbank',
      workspaceRoot: root,
    });

    expect(catalogSequenceIdForPath(db, nativePath)).toBeUndefined();
  });
});
