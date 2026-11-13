import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  sender: null as (EventEmitter & { id: number }) | null,
  calls: [] as string[],
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      state.handlers.set(channel, handler),
  },
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('../../platform', () => ({
  platform: () => ({
    db: new Proxy(
      {},
      {
        get:
          (_target, key) =>
          (...args: unknown[]) => {
            const channel = `db:${String(key)}`;
            state.calls.push(channel);
            const handler = state.handlers.get(channel);
            if (!handler) throw new Error(`Missing native handler: ${channel}`);
            return handler({ sender: state.sender }, ...args);
          },
      }
    ),
  }),
}));

import { createTestDb } from './test-db';
import { ensureSchema } from '../schema';
import { registerDatabaseHandlers } from '../ipc/database';
import { ensureSequenceIdentity } from '../../db/sequence-identity';
import {
  linkCatalogEntities,
  recordCatalogEvent,
  updateCatalogEntityMetadata,
  writeCatalogWorkspacePlacement,
  deleteCatalogWorkspacePlacement,
} from '../../db/workspace-catalog';
import { restoreProviderBinding } from '../../db/catalog-provider-bindings';

let db: Database.Database;
let root: string;
beforeEach(() => {
  db = createTestDb();
  ensureSchema(db, ':memory:');
  root = realpathSync(mkdtempSync(join(tmpdir(), 'catalog-ipc-authority-')));
  mkdirSync(join(root, '.forge'));
  db.prepare('INSERT INTO workspaces(id,name,path,created_at) VALUES(7,?,?,1)').run('Owner', root);
  state.handlers.clear();
  state.calls.length = 0;
  state.sender = Object.assign(new EventEmitter(), { id: 43619 });
  registerDatabaseHandlers(() => db);
  for (const id of ['a', 'b'])
    db.prepare(
      `INSERT INTO catalog_entities(id,type,name,locator,storage_type,workspace_id,created_at,updated_at) VALUES(?,'record',?,?,'database',7,1,1)`
    ).run(id, id, `entity://record/${id}`);
  writeFileSync(
    join(root, '.forge', 'catalog.json'),
    JSON.stringify({
      schema: 'dnaforge.native-workspace-manifest.v2',
      entities: ['a', 'b'].map((id) => ({
        id,
        type: 'record',
        name: id,
        placement: {
          kind: 'catalog-record',
          parentRelativePath: '',
          displayName: id,
          catalogType: 'record',
          presentationKind: 'record',
        },
        ...(id === 'a'
          ? {
              sourceIdentities: [
                {
                  provider: 'benchling',
                  stableObjectId: 'ent_EXACT001',
                  objectClass: 'registry_entity',
                  bindingKind: 'observed',
                },
              ],
            }
          : {}),
      })),
      links: [],
    })
  );
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('catalog typed native IPC boundary', () => {
  it('runs actual renderer association/provider/placement adapters through the native database handlers', async () => {
    const link = await linkCatalogEntities({
      sourceEntityId: 'a',
      targetEntityId: 'b',
      relation: 'references',
      confidence: 'confirmed',
    });
    const event = await recordCatalogEvent({
      id: 'edit-a',
      entityId: 'a',
      eventType: 'edited',
      createdAt: 10,
    });
    await updateCatalogEntityMetadata('a', { description: 'Native owner accepted' });
    const placement = await writeCatalogWorkspacePlacement({
      entityId: 'a',
      workspaceId: 7,
      parentRelativePath: '',
      displayName: 'a',
      presentationKind: 'record',
    });
    await restoreProviderBinding({
      provider: 'benchling',
      stableObjectId: 'ent_EXACT001',
      objectClass: 'registry_entity',
      entityId: 'a',
      bindingKind: 'observed',
      evidence: { source: '.forge/catalog.json' },
    });
    expect(link.source_entity_id).toBe('a');
    expect(event.entity_id).toBe('a');
    expect(placement.workspace_id).toBe(7);
    expect(db.prepare('SELECT entity_id FROM catalog_provider_bindings').get()).toEqual({
      entity_id: 'a',
    });
    expect(state.calls).toEqual([
      'db:linkCatalogEntities',
      'db:recordCatalogEvent',
      'db:updateCatalogEntityPresentation',
      'db:writeCatalogWorkspacePlacement',
      'db:restoreCatalogProviderBinding',
    ]);
  });

  it('surfaces native source/owner refusals without a partial renderer write', async () => {
    await expect(
      writeCatalogWorkspacePlacement({
        entityId: 'a',
        workspaceId: 8,
        parentRelativePath: '',
        displayName: 'a',
        presentationKind: 'record',
      })
    ).rejects.toThrow(/owner|workspace/i);
    await expect(
      restoreProviderBinding({
        provider: 'benchling',
        stableObjectId: 'ent_FORGED01',
        objectClass: 'registry_entity',
        entityId: 'a',
        bindingKind: 'observed',
        evidence: { source: '.forge/catalog.json' },
      })
    ).rejects.toThrow(/source|identity/i);
    expect(db.prepare('SELECT COUNT(*) AS count FROM catalog_workspace_placements').get()).toEqual({
      count: 0,
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM catalog_provider_bindings').get()).toEqual({
      count: 0,
    });
    await expect(deleteCatalogWorkspacePlacement('a')).resolves.toBe(false);
  });

  it('rejects raw SQL writes to every migrated identity and association projection', async () => {
    await linkCatalogEntities({ sourceEntityId: 'a', targetEntityId: 'b', relation: 'references' });
    await recordCatalogEvent({ id: 'event-a', entityId: 'a', eventType: 'edited', createdAt: 10 });
    await writeCatalogWorkspacePlacement({
      entityId: 'a',
      workspaceId: 7,
      parentRelativePath: '',
      displayName: 'a',
      presentationKind: 'record',
    });
    await restoreProviderBinding({
      provider: 'benchling',
      stableObjectId: 'ent_EXACT001',
      objectClass: 'registry_entity',
      entityId: 'a',
      bindingKind: 'observed',
      evidence: { source: '.forge/catalog.json' },
    });
    db.prepare(
      "INSERT INTO indexed_files(id,workspace_id,path,name,extension,indexed_at) VALUES(10,7,?,'cache.fa','fa',1)"
    ).run(join(root, 'cache.fa'));
    db.prepare(
      "INSERT INTO sequences(id,file_id,document_id,name,length,circular) VALUES(24,10,'cache-document','Cache',8,0)"
    ).run();
    const tables = [
      'catalog_entities',
      'catalog_entity_links',
      'catalog_entity_events',
      'catalog_provider_bindings',
      'catalog_workspace_placements',
      'indexed_files',
      'sequences',
    ];
    const snapshot = () =>
      Object.fromEntries(
        tables.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()])
      );
    const before = snapshot();
    for (const sql of [
      "UPDATE catalog_entities SET metadata='{}' WHERE id='a'",
      "UPDATE catalog_entity_links SET confidence='rejected' WHERE source_entity_id='a'",
      "UPDATE catalog_entity_events SET entity_id='b' WHERE id='event-a'",
      "UPDATE catalog_provider_bindings SET entity_id='b' WHERE entity_id='a'",
      "UPDATE catalog_workspace_placements SET workspace_id=8 WHERE entity_id='a'",
      'UPDATE indexed_files SET workspace_id=8 WHERE id=10',
      "UPDATE sequences SET document_id='forged' WHERE id=24",
    ])
      await expect(async () =>
        state.handlers.get('db:execute')!({ sender: state.sender }, sql)
      ).rejects.toThrow(/NATIVE_COMMAND|ENTITY_IDENTITY/);
    expect(snapshot()).toEqual(before);
  });

  it('rebuilds the sequence index from native bytes and propagates a false project claim', async () => {
    const path = join(root, 'actual.fa');
    writeFileSync(path, '>Actual\nACGTACGT\n');
    db.prepare(
      `INSERT INTO catalog_entities(id,type,name,locator,storage_type,workspace_id,created_at,updated_at) VALUES('sequence-a','sequence','Actual',?,'file',7,1,1)`
    ).run(`file://${path}`);
    db.prepare(
      `INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,file_kind,created_at,updated_at) VALUES('actual-file','sequence-a',7,?,'fasta',1,1)`
    ).run(path);
    expect(
      await ensureSequenceIdentity('sequence-a', path, 'Forged renderer name', 999, true, root)
    ).toBeGreaterThan(0);
    expect(db.prepare('SELECT name,length,circular FROM sequences').get()).toEqual({
      name: 'Actual',
      length: 8,
      circular: 0,
    });
    await expect(
      ensureSequenceIdentity('sequence-a', path, 'Renderer', 8, false, '/wrong-project')
    ).rejects.toThrow(/owner|project/i);
    expect(state.calls).toEqual(['db:ensureSequenceIndex', 'db:ensureSequenceIndex']);
  });
});
