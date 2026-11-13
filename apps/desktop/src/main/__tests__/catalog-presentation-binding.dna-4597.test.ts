import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
import { acquireWorkspaceSyncMutationLease } from '../workspace-sync-mutation-lease';
import type { CatalogFileBindingRequest } from '../../shared/catalog-binding';

describe(' catalog presentation binding', () => {
  let db: Database.Database;
  let root: string;
  let packageRoot: string;
  let marker: string;
  let product: string;
  const sender = Object.assign(new EventEmitter(), { id: 366170 });
  const targetId = 'canonical-package';
  const priorId = 'legacy-owner';
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

  it.each(['previous-owner', 'next-owner', 'binding'] as const)(
    ' preserves package adoption across queued %s presentation updates',
    async (changed) => {
      const original = setup();
      const sourceBytes = bytes();
      const release = await acquireWorkspaceSyncMutationLease(root);
      const pending = invoke('bindCatalogEntityFile', request());
      await Promise.resolve();
      try {
        if (changed === 'binding') {
          db.prepare('UPDATE catalog_entity_files SET updated_at=updated_at+1 WHERE path=?').run(
            packageRoot
          );
        } else {
          db.prepare('UPDATE catalog_entities SET name=?,updated_at=updated_at+1 WHERE id=?').run(
            'Updated presentation',
            changed === 'previous-owner' ? priorId : targetId
          );
        }
      } finally {
        release();
      }
      await expect(pending).resolves.toMatchObject({
        id: original.id,
        object_uuid: original.object_uuid,
        entity_id: targetId,
        workspace_id: 7,
        path: packageRoot,
        file_kind: SEQUENCE_PACKAGE_FILE_KIND,
      });
      expect(bytes()).toEqual(sourceBytes);
      expect(
        db.prepare('SELECT entity_id FROM catalog_entity_files WHERE path=?').get(packageRoot)
      ).toEqual({ entity_id: targetId });
    }
  );
});
