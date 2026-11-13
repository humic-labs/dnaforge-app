import { EventEmitter } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      state.handlers.set(channel, handler),
  },
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
  dialog: { showErrorBox: vi.fn() },
}));

import { createTestDb } from './test-db';
import { ensureSchema } from '../schema';
import { registerDatabaseHandlers } from '../ipc/database';
import { registerCatalogEntityInDb } from '../catalog-entity-registration';
import { bindCatalogEntityFileInDb } from '../catalog-file-binding';
import {
  buildSequencePackageDocument,
  serializeSequencePackageDocument,
  SEQUENCE_PACKAGE_FILE_KIND,
} from '../../db/sequence-package';
import {
  acquireWorkspaceSyncMutationLease,
  workspaceMutationRootIdentity,
} from '../workspace-sync-mutation-lease';
import type { CatalogFileBindingRequest } from '../../shared/catalog-binding';

describe('native legacy sequence package binding adoption', () => {
  let db: Database.Database;
  let root: string;
  let packageRoot: string;
  let marker: string;
  let product: string;
  const sender = Object.assign(new EventEmitter(), { id: 366170 });
  const targetId = 'canonical-package';
  const priorId = 'legacy-owner';
  const snapshot = () =>
    ['catalog_entity_files', 'catalog_entity_events', 'catalog_entity_links'].map((table) =>
      db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()
    );
  const bytes = () => [readFileSync(marker), readFileSync(product)];
  const request = (): CatalogFileBindingRequest => ({
    entityId: targetId,
    path: packageRoot,
    workspaceRoot: root,
    fileKind: SEQUENCE_PACKAGE_FILE_KIND,
    status: 'current',
  });
  const invoke = async (method: string, input: unknown) => {
    const handler = state.handlers.get(`db:${method}`);
    if (!handler) throw new Error(`Missing native command ${method}`);
    return handler({ sender }, input);
  };
  const source = (options: { id?: string; designId?: string; versionId?: string } = {}) => {
    writeFileSync(
      marker,
      serializeSequencePackageDocument(
        buildSequencePackageDocument({
          id: options.id ?? targetId,
          name: 'Canonical package',
          product: { file: 'product.gb' },
          ...(options.designId
            ? {
                assembly: {
                  accepted: {
                    designId: options.designId,
                    acceptedAssemblyVersionId: options.versionId ?? targetId,
                  },
                },
              }
            : {}),
        })
      )
    );
  };
  const setup = (kind: 'file' | 'design' | 'sequence' = 'file') => {
    source(kind === 'design' ? { designId: priorId } : {});
    registerCatalogEntityInDb(db, {
      id: priorId,
      type: kind,
      name: 'Legacy owner',
      locator: `entity://${kind}/${priorId}`,
      storageType: kind === 'design' ? 'localStorage' : 'file',
      workspaceRoot: root,
    });
    registerCatalogEntityInDb(db, {
      id: targetId,
      type: 'sequence',
      name: 'Canonical package',
      locator: `entity://sequence/${targetId}`,
      storageType: 'file',
      workspaceRoot: root,
    });
    return bindCatalogEntityFileInDb(db, {
      entityId: priorId,
      path: packageRoot,
      workspaceRoot: root,
      fileKind: kind === 'file' ? 'file' : 'waypoint-plasmid',
    });
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'native-legacy-package-')));
    packageRoot = join(root, 'Package');
    mkdirSync(join(packageRoot, '.forge'), { recursive: true });
    marker = join(packageRoot, '.forge', 'plasmid.json');
    product = join(packageRoot, 'product.gb');
    writeFileSync(
      product,
      'LOCUS       PRODUCT  8 bp    DNA     circular SYN\nORIGIN\n        1 acgtacgt\n//\n'
    );
    db = createTestDb();
    ensureSchema(db, ':memory:');
    db.prepare('INSERT INTO workspaces(id,name,path,created_at) VALUES(7,?,?,1)').run(
      'Owner',
      root
    );
    state.handlers.clear();
    registerDatabaseHandlers(() => db);
  });
  afterEach(() => {
    sender.removeAllListeners();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('adopts a generic directory from canonical marker identity while preserving physical UUID and old binding history', async () => {
    const before = setup();
    const sourceBytes = bytes();
    await expect(invoke('bindCatalogEntityFile', request())).resolves.toMatchObject({
      id: before.id,
      object_uuid: before.object_uuid,
      entity_id: targetId,
      workspace_id: 7,
      path: packageRoot,
      file_kind: SEQUENCE_PACKAGE_FILE_KIND,
    });
    const event = db
      .prepare('SELECT entity_id,event_type,payload FROM catalog_entity_events WHERE entity_id=?')
      .get(priorId) as { entity_id: string; event_type: string; payload: string };
    expect(event.event_type).toBe('file_historical');
    expect(JSON.parse(event.payload)).toMatchObject({
      previousBinding: { entity_id: priorId, object_uuid: before.object_uuid },
      replacementEntityId: targetId,
      reason: 'canonical-sequence-package-adoption',
    });
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM catalog_entity_files WHERE path=?').get(packageRoot)
    ).toEqual({ count: 1 });
    expect(bytes()).toEqual(sourceBytes);
  });

  it('adopts an exact accepted design and its version with atomic produces lineage', async () => {
    setup('design');
    const sourceBytes = bytes();
    await invoke('bindCatalogEntityFile', request());
    expect(
      db
        .prepare(
          'SELECT source_entity_id,relation,target_entity_id,confidence FROM catalog_entity_links'
        )
        .all()
    ).toEqual([
      {
        source_entity_id: priorId,
        relation: 'produces',
        target_entity_id: targetId,
        confidence: 'confirmed',
      },
    ]);
    expect(bytes()).toEqual(sourceBytes);
    expect(db.prepare('SELECT status FROM catalog_entities WHERE id=?').get(priorId)).toEqual({
      status: 'active',
    });
  });

  it.each(['file', 'design'] as const)(
    'repairs a reference-project %s projection without changing project bytes',
    async (kind) => {
      setup(kind);
      db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=7").run();
      const sourceBytes = bytes();
      await expect(invoke('bindCatalogEntityFile', request())).resolves.toMatchObject({
        entity_id: targetId,
      });
      expect(bytes()).toEqual(sourceBytes);
      if (kind === 'design') {
        const exact = {
          sourceEntityId: priorId,
          relation: 'produces',
          targetEntityId: targetId,
          confidence: 'confirmed',
          evidence: {
            source: 'sequence-package-root-binding-migration',
            packageId: targetId,
            packageRoot,
          },
        };
        const before = snapshot();
        await expect(invoke('linkCatalogEntities', exact)).resolves.toMatchObject({
          source_entity_id: priorId,
          target_entity_id: targetId,
        });
        expect(snapshot()).toEqual(before);
        await expect(
          invoke('linkCatalogEntities', {
            ...exact,
            evidence: { ...exact.evidence, changed: true },
          })
        ).rejects.toThrow(/WORKSPACE_READ_ONLY/);
        expect(snapshot()).toEqual(before);
        expect(bytes()).toEqual(sourceBytes);
      }
    }
  );

  it.each([
    'marker-id',
    'design-id',
    'accepted-version',
    'unrelated-scientific',
    'missing-marker',
    'marker-symlink',
    'symlink-product',
    'other-owner',
    'inactive-owner',
  ] as const)('refuses %s without partial catalog mutation', async (problem) => {
    setup(
      problem === 'unrelated-scientific'
        ? 'sequence'
        : ['design-id', 'accepted-version'].includes(problem)
          ? 'design'
          : 'file'
    );
    if (problem === 'marker-id') source({ id: 'another-package' });
    if (problem === 'design-id') source({ designId: 'another-design' });
    if (problem === 'accepted-version') source({ designId: priorId, versionId: 'another-version' });
    if (problem === 'missing-marker') rmSync(marker);
    if (problem === 'marker-symlink') {
      const outside = join(root, 'outside-marker.json');
      writeFileSync(outside, readFileSync(marker));
      rmSync(marker);
      symlinkSync(outside, marker);
    }
    if (problem === 'symlink-product') {
      const outside = join(root, 'outside.gb');
      writeFileSync(outside, readFileSync(product));
      rmSync(product);
      symlinkSync(outside, product);
    }
    if (problem === 'other-owner') {
      db.prepare('INSERT INTO workspaces(id,name,path,created_at) VALUES(8,?,?,1)').run(
        'Other',
        join(root, 'Other')
      );
      db.prepare('UPDATE catalog_entities SET workspace_id=8 WHERE id=?').run(priorId);
    }
    if (problem === 'inactive-owner')
      db.prepare('UPDATE workspaces SET archived_at=1 WHERE id=7').run();
    const before = snapshot();
    await expect(invoke('bindCatalogEntityFile', request())).rejects.toThrow();
    expect(snapshot()).toEqual(before);
  });

  it('refuses a same-project path-owner substitution queued behind the native lease', async () => {
    setup();
    registerCatalogEntityInDb(db, {
      id: 'substituted-owner',
      type: 'file',
      name: 'Substituted',
      locator: 'entity://file/substituted-owner',
      storageType: 'file',
      workspaceRoot: root,
    });
    const release = await acquireWorkspaceSyncMutationLease(root);
    const pending = invoke('bindCatalogEntityFile', request());
    await Promise.resolve();
    db.prepare('UPDATE catalog_entity_files SET entity_id=? WHERE path=?').run(
      'substituted-owner',
      packageRoot
    );
    const before = snapshot();
    release();
    await expect(pending).rejects.toThrow(/authority changed while waiting/);
    expect(snapshot()).toEqual(before);
  });

  it('rechecks package marker identity after the queued native lease', async () => {
    setup();
    const release = await acquireWorkspaceSyncMutationLease(root);
    const pending = invoke('bindCatalogEntityFile', request());
    await Promise.resolve();
    source({ id: 'substituted-marker' });
    const before = snapshot();
    release();
    await expect(pending).rejects.toThrow(/marker identity/);
    expect(snapshot()).toEqual(before);
  });

  it('accepts an actual macOS root alias for the same owner and refuses duplicate registered owner identities', async ({
    skip,
  }) => {
    if (process.platform !== 'darwin' || !root.startsWith('/private/var/')) skip();
    const before = setup();
    const aliasRoot = root.slice('/private'.length);
    const aliasPackage = packageRoot.slice('/private'.length);
    expect(workspaceMutationRootIdentity(aliasRoot)).toBe(workspaceMutationRootIdentity(root));
    await expect(
      invoke('bindCatalogEntityFile', {
        ...request(),
        workspaceRoot: aliasRoot,
        path: aliasPackage,
      })
    ).resolves.toMatchObject({
      id: before.id,
      object_uuid: before.object_uuid,
      entity_id: targetId,
      path: packageRoot,
    });
    db.prepare('INSERT INTO workspaces(id,name,path,created_at) VALUES(8,?,?,1)').run(
      'Different registered owner',
      aliasRoot
    );
    const current = snapshot();
    await expect(
      invoke('bindCatalogEntityFile', {
        ...request(),
        workspaceRoot: aliasRoot,
        path: aliasPackage,
      })
    ).rejects.toThrow(/unique canonical project owner/);
    expect(snapshot()).toEqual(current);
  });

  it('rolls back binding retirement and lineage if the atomic database commit fails', async () => {
    setup('design');
    db.exec(
      "CREATE TEMP TRIGGER refuse_lineage BEFORE INSERT ON catalog_entity_links BEGIN SELECT RAISE(ABORT,'fixture-lineage-refusal'); END"
    );
    const before = snapshot();
    await expect(invoke('bindCatalogEntityFile', request())).rejects.toThrow(
      'fixture-lineage-refusal'
    );
    expect(snapshot()).toEqual(before);
  });
});
