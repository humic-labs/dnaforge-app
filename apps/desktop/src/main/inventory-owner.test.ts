import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InventoryCommand } from '@waypoint/domain-services';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: () => '/tmp', getVersion: () => '1.0.0', exit: vi.fn() },
}));

import { openFileTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { rememberOriginalDefaultProject } from './original-default-project';
import {
  createRegisteredProjectAuthority,
  withAgentProjectScope,
} from './registered-project-authority';
import { createNativeInventoryOwner } from './inventory-owner';

let root: string;
let dbPath: string;
let db: Database.Database;
let owner: ReturnType<typeof createNativeInventoryOwner>;
let actor = 'native:fixture-instance';

function startOwner() {
  owner = createNativeInventoryOwner({
    db: () => db,
    projectAuthority: createRegisteredProjectAuthority({ db: () => db }),
    actor: () => actor,
    now: () => 1_700_000_000_000,
  });
  owner.initialize();
}

const scope = () => ({ project: 'Fixture inventory project', inventoryId: 'inventory-fixture' });

const execute = (
  operationId: string,
  expectedRevision: number,
  commands: readonly InventoryCommand[]
) => owner.execute({ ...scope(), operationId, expectedRevision, commands });

function createFixture() {
  const commands: InventoryCommand[] = [
    {
      kind: 'create-storage',
      id: 'freezer',
      name: 'Freezer',
      slots: ['top', 'bottom'],
      placement: { kind: 'root' },
    },
    {
      kind: 'create-storage',
      id: 'box',
      name: 'Box',
      slots: ['A1', 'A2'],
      placement: { kind: 'located', storageId: 'freezer', slotId: 'top' },
    },
    { kind: 'create-vessel', id: 'tube', name: 'Tube', placement: { kind: 'unplaced' } },
    {
      kind: 'receive-stock',
      id: 'stock',
      vesselId: 'tube',
      materialId: 'synthetic-material',
      quantity: { kind: 'known', value: '100', unit: 'uL' },
      quality: 'usable',
    },
  ];
  expect(execute('receive', 0, commands)).toMatchObject({ status: 'committed', revision: 1 });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dnaforge-inventory-owner-'));
  dbPath = join(root, 'inventory.sqlite');
  db = openFileTestDb(dbPath);
  ensureSchema(db, dbPath);
  const projectPath = join(root, 'project');
  mkdirSync(projectPath);
  db.prepare(
    `INSERT INTO workspaces (id,name,path,repo_uuid,access_mode,created_at)
     VALUES(41,'Fixture inventory project',?,'inventory-project','writable',1)`
  ).run(projectPath);
  rememberOriginalDefaultProject(db, 41);
  db.prepare(
    `INSERT INTO lims_schema (id,kind,name,display_name,fields,current_revision_id,created_at,updated_at)
     VALUES('material-schema','entity','fixture-material','Fixture material','{}','material-schema-v1',1,1)`
  ).run();
  db.prepare(
    `INSERT INTO lims_schema_revision(id,schema_id,version,fields,created_at)
     VALUES('material-schema-v1','material-schema',1,'{}',1)`
  ).run();
  db.prepare(
    `INSERT INTO lims_entity (id,kind,schema_id,schema_revision_id,name,fields,workspace_id,registration_status,created_at,updated_at)
     VALUES('synthetic-material','record','material-schema','material-schema-v1','Synthetic material','{}',41,'registered',1,1)`
  ).run();
  actor = 'native:fixture-instance';
  startOwner();
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('durable native inventory commands', () => {
  it('keeps quantities, placement, immutable receipts and replay after reopening', () => {
    createFixture();
    expect(
      execute('place', 1, [
        {
          kind: 'move-vessel',
          id: 'tube',
          placement: { kind: 'located', storageId: 'box', slotId: 'A1' },
        },
      ])
    ).toMatchObject({ status: 'committed', revision: 2 });
    expect(
      execute('move', 2, [
        {
          kind: 'move-vessel',
          id: 'tube',
          placement: { kind: 'located', storageId: 'box', slotId: 'A2' },
        },
      ])
    ).toMatchObject({ status: 'committed', revision: 3 });
    const consume: InventoryCommand = {
      kind: 'consume',
      stockId: 'stock',
      quantity: { value: '20', unit: 'uL' },
      reason: 'Experiment',
    };
    const receipt = execute('consume', 3, [consume]);
    expect(receipt).toMatchObject({
      status: 'committed',
      revision: 4,
      actor,
      recordedAt: 1_700_000_000_000,
    });
    db.close();
    db = openFileTestDb(dbPath);
    startOwner();
    actor = 'native:restarted-instance';
    expect(execute('consume', 3, [consume])).toEqual(receipt);
    const state = owner.inspect(scope());
    expect(state?.stocks.stock.quantity).toEqual({ kind: 'known', value: '80', unit: 'uL' });
    expect(state?.vessels.tube.placement).toEqual({
      kind: 'located',
      storageId: 'box',
      slotId: 'A2',
    });
    expect(owner.operation({ ...scope(), operationId: 'consume' })).toEqual(receipt);
    expect(owner.history(scope())).toHaveLength(4);
    expect(owner.history({ ...scope(), afterRevision: 2, limit: 1 })[0].receipt.operationId).toBe(
      'move'
    );
    expect(owner.replay(scope())).toEqual({ state, acceptedOperations: 4 });
  });

  it('rejects changed request reuse and stale competing moves without receipts', () => {
    createFixture();
    expect(
      execute('receive', 0, [
        { kind: 'create-vessel', id: 'other', name: 'Other', placement: { kind: 'unplaced' } },
      ])
    ).toMatchObject({ status: 'rejected', code: 'INVENTORY_OPERATION_CONFLICT' });
    const first = execute('first-move', 1, [
      {
        kind: 'move-vessel',
        id: 'tube',
        placement: { kind: 'located', storageId: 'box', slotId: 'A1' },
      },
    ]);
    expect(first.status).toBe('committed');
    expect(
      execute('stale-move', 1, [
        {
          kind: 'move-vessel',
          id: 'tube',
          placement: { kind: 'located', storageId: 'box', slotId: 'A2' },
        },
      ])
    ).toMatchObject({ status: 'rejected', code: 'REVISION_CONFLICT' });
    expect(owner.inspect(scope())?.vessels.tube.placement).toMatchObject({ slotId: 'A1' });
    expect(owner.operation({ ...scope(), operationId: 'stale-move' })).toBeNull();
    expect(owner.history(scope())).toHaveLength(2);
  });

  it('rolls back an entire invalid batch, occupied positions and cycles', () => {
    createFixture();
    expect(
      execute('invalid-batch', 1, [
        {
          kind: 'create-vessel',
          id: 'second',
          name: 'Second',
          placement: { kind: 'located', storageId: 'box', slotId: 'A1' },
        },
        {
          kind: 'move-vessel',
          id: 'tube',
          placement: { kind: 'located', storageId: 'box', slotId: 'A1' },
        },
      ])
    ).toMatchObject({ status: 'rejected', code: 'SLOT_OCCUPIED' });
    expect(owner.inspect(scope())?.vessels.second).toBeUndefined();
    expect(
      execute('cycle', 1, [
        {
          kind: 'move-storage',
          id: 'freezer',
          placement: { kind: 'located', storageId: 'box', slotId: 'A1' },
        },
      ])
    ).toMatchObject({ status: 'rejected', code: 'CONTAINMENT_CYCLE' });
    expect(owner.inspect(scope())?.revision).toBe(1);
    expect(owner.history(scope())).toHaveLength(1);
  });

  it('never leaves state or a receipt when the journal write fails', () => {
    createFixture();
    const before = owner.inspect(scope());
    db.exec(`CREATE TRIGGER fail_inventory_journal BEFORE INSERT ON inventory_journal
      BEGIN SELECT RAISE(ABORT,'injected journal failure'); END`);
    expect(() =>
      execute('fault', 1, [
        {
          kind: 'consume',
          stockId: 'stock',
          quantity: { value: '20', unit: 'uL' },
          reason: 'Experiment',
        },
      ])
    ).toThrow('injected journal failure');
    expect(owner.inspect(scope())).toEqual(before);
    expect(owner.operation({ ...scope(), operationId: 'fault' })).toBeNull();
    expect(owner.history(scope())).toHaveLength(1);
  });

  it('rolls back when native instance authority disappears after the journal write', () => {
    createFixture();
    const before = owner.inspect(scope());
    expect(() =>
      owner.execute(
        {
          ...scope(),
          operationId: 'revoked',
          expectedRevision: 1,
          commands: [
            {
              kind: 'consume',
              stockId: 'stock',
              quantity: { value: '20', unit: 'uL' },
              reason: 'Experiment',
            },
          ],
        },
        () => {
          if (db.prepare("SELECT 1 FROM inventory_journal WHERE operation_id='revoked'").get())
            throw new Error('NATIVE_DOCUMENT_OWNER_CHANGED');
        }
      )
    ).toThrow('NATIVE_DOCUMENT_OWNER_CHANGED');
    expect(owner.inspect(scope())).toEqual(before);
    expect(owner.operation({ ...scope(), operationId: 'revoked' })).toBeNull();
  });

  it('rechecks project write authority before committing the state and receipt', () => {
    createFixture();
    const before = owner.inspect(scope());
    db.exec(`CREATE TRIGGER revoke_inventory_project AFTER INSERT ON inventory_journal
      BEGIN UPDATE workspaces SET access_mode='reference' WHERE id=41; END`);
    expect(() =>
      execute('project-revoked', 1, [
        {
          kind: 'consume',
          stockId: 'stock',
          quantity: { value: '20', unit: 'uL' },
          reason: 'Experiment',
        },
      ])
    ).toThrow('PROJECT_ACCESS_CHANGED');
    expect(owner.inspect(scope())).toEqual(before);
    expect(owner.operation({ ...scope(), operationId: 'project-revoked' })).toBeNull();
    expect(db.prepare('SELECT access_mode FROM workspaces WHERE id=41').get()).toEqual({
      access_mode: 'writable',
    });
  });

  it('refuses missing, archived and differently scoped scientific references', () => {
    createFixture();
    execute('empty-vessel', 1, [
      { kind: 'create-vessel', id: 'second', name: 'Second', placement: { kind: 'unplaced' } },
    ]);
    const receive = (materialId: string): InventoryCommand => ({
      kind: 'receive-stock',
      id: 'other-stock',
      vesselId: 'second',
      materialId,
      quantity: { kind: 'unknown' },
      quality: 'usable',
    });
    expect(execute('missing-record', 2, [receive('missing')])).toMatchObject({
      status: 'rejected',
      code: 'INVENTORY_MATERIAL_UNAVAILABLE',
    });
    db.prepare("UPDATE lims_entity SET archived_at=1 WHERE id='synthetic-material'").run();
    expect(execute('archived-record', 2, [receive('synthetic-material')])).toMatchObject({
      status: 'rejected',
      code: 'INVENTORY_MATERIAL_UNAVAILABLE',
    });
    db.prepare(
      "UPDATE lims_entity SET archived_at=NULL,workspace_id=NULL WHERE id='synthetic-material'"
    ).run();
    expect(execute('historical-null-owner', 2, [receive('synthetic-material')])).toMatchObject({
      status: 'committed',
      revision: 3,
    });
  });

  it('uses saved file ownership instead of the registry origin workspace column', () => {
    createFixture();
    execute('empty-vessel', 1, [
      { kind: 'create-vessel', id: 'second', name: 'Second', placement: { kind: 'unplaced' } },
    ]);
    const otherPath = join(root, 'other');
    mkdirSync(otherPath);
    db.prepare(
      "INSERT INTO workspaces(id,name,path,repo_uuid,access_mode,created_at) VALUES(42,'Other',?,'other-project','writable',1)"
    ).run(otherPath);
    db.prepare(
      `INSERT INTO catalog_entities(id,type,name,locator,storage_type,status,created_at,updated_at)
      VALUES('synthetic-material','record','Synthetic material','entity://lims/synthetic-material','database','active',1,1)`
    ).run();
    db.prepare(
      `INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,file_kind,status,created_at,updated_at)
      VALUES('actual-saved-file','synthetic-material',42,?,'record','current',1,1)`
    ).run(join(otherPath, 'material.forge.json'));
    const receive: InventoryCommand = {
      kind: 'receive-stock',
      id: 'other-stock',
      vesselId: 'second',
      materialId: 'synthetic-material',
      quantity: { kind: 'unknown' },
      quality: 'usable',
    };
    expect(execute('outside-saved-owner', 2, [receive])).toMatchObject({
      status: 'rejected',
      code: 'INVENTORY_MATERIAL_UNAVAILABLE',
    });
    db.prepare(
      "UPDATE catalog_entity_files SET workspace_id=41 WHERE id='actual-saved-file'"
    ).run();
    db.prepare("UPDATE lims_entity SET workspace_id=42 WHERE id='synthetic-material'").run();
    expect(execute('saved-owner-with-other-origin', 2, [receive])).toMatchObject({
      status: 'committed',
      revision: 3,
    });
  });

  it('denies another project, excluded agent scope and readonly retries', () => {
    createFixture();
    const otherPath = join(root, 'other');
    mkdirSync(otherPath);
    db.prepare(
      "INSERT INTO workspaces(id,name,path,repo_uuid,access_mode,created_at) VALUES(42,'Other',?,'other-project','writable',1)"
    ).run(otherPath);
    for (const operation of [
      () => owner.inspect({ ...scope(), project: 'Other' }),
      () => owner.history({ ...scope(), project: 'Other' }),
      () => owner.operation({ ...scope(), project: 'Other', operationId: 'receive' }),
      () =>
        owner.execute({
          ...scope(),
          project: 'Other',
          operationId: 'takeover',
          expectedRevision: 1,
          commands: [
            {
              kind: 'create-vessel',
              id: 'second',
              name: 'Second',
              placement: { kind: 'unplaced' },
            },
          ],
        }),
    ])
      expect(operation).toThrow('PROJECT_ACCESS_DENIED');
    expect(() =>
      withAgentProjectScope({ kind: 'project-roots', roots: [otherPath] }, () =>
        owner.inspect(scope())
      )
    ).toThrow('PROJECT_ACCESS_DENIED');
    db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=41").run();
    expect(() =>
      execute('receive', 0, [
        { kind: 'create-vessel', id: 'second', name: 'Second', placement: { kind: 'unplaced' } },
      ])
    ).toThrow('PROJECT_ACCESS_DENIED');
  });

  it('keeps unknown balances distinct, refuses held/disposed use and preserves exact decimals', () => {
    createFixture();
    expect(
      execute('unknown', 1, [
        {
          kind: 'reconcile',
          stockId: 'stock',
          quantity: { kind: 'unknown' },
          reason: 'Unmeasured',
        },
      ])
    ).toMatchObject({ status: 'committed' });
    const consume: InventoryCommand = {
      kind: 'consume',
      stockId: 'stock',
      quantity: { value: '0.1', unit: 'uL' },
      reason: 'Experiment',
    };
    expect(execute('unknown-use', 2, [consume])).toMatchObject({
      status: 'rejected',
      code: 'QUANTITY_UNKNOWN',
    });
    expect(
      execute('measured', 2, [
        {
          kind: 'reconcile',
          stockId: 'stock',
          quantity: { kind: 'known', value: '0.3', unit: 'uL' },
          reason: 'Measured',
        },
      ])
    ).toMatchObject({ status: 'committed' });
    expect(execute('exact-use', 3, [consume, consume])).toMatchObject({ status: 'committed' });
    expect(owner.inspect(scope())?.stocks.stock.quantity).toEqual({
      kind: 'known',
      value: '0.1',
      unit: 'uL',
    });
    execute('held', 4, [
      { kind: 'set-quality', stockId: 'stock', quality: 'quarantined', reason: 'Review' },
    ]);
    expect(execute('held-use', 5, [consume])).toMatchObject({
      status: 'rejected',
      code: 'STOCK_QUARANTINED',
    });
    execute('disposed', 5, [{ kind: 'dispose-vessel', id: 'tube', reason: 'Discarded' }]);
    expect(execute('disposed-use', 6, [consume])).toMatchObject({
      status: 'rejected',
      code: 'VESSEL_DISPOSED',
    });
  });

  it('does not create absent inventories during inspection and fails closed on invalid persisted bytes', () => {
    const missing = { ...scope(), inventoryId: 'absent' };
    expect(owner.inspect(missing)).toBeNull();
    expect(owner.history(missing)).toEqual([]);
    expect(owner.operation({ ...missing, operationId: 'absent' })).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM inventory_state').get()).toEqual({ n: 0 });
    createFixture();
    db.prepare('UPDATE inventory_state SET state_json=?').run('{broken');
    expect(() => owner.inspect(scope())).toThrow('INVENTORY_DATA_INVALID');
  });

  it('detects a changed journal payload and a projection divergent from accepted history', () => {
    createFixture();
    const before = owner.inspect(scope())!;
    db.prepare('UPDATE inventory_state SET state_json=?').run(
      JSON.stringify({ ...before, storage: {} })
    );
    expect(() => owner.replay(scope())).toThrow('INVENTORY_DATA_INVALID');
    db.prepare('UPDATE inventory_state SET state_json=?').run(JSON.stringify(before));
    db.prepare('UPDATE inventory_journal SET request_json=?').run('{}');
    expect(() => owner.history(scope())).toThrow('INVENTORY_DATA_INVALID');
  });
});
