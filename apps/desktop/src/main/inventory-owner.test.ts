import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INVENTORY_SCHEMA,
  createInventoryState,
  inventoryEquipmentCatalog,
  inventoryEquipmentCatalogUpdatePreview,
  type InventoryCommand,
} from '@waypoint/domain-services';

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
const profileKey = 'a'.repeat(64);
let now = 1_700_000_000_000;

function startOwner() {
  owner = createNativeInventoryOwner({
    db: () => db,
    projectAuthority: createRegisteredProjectAuthority({ db: () => db }),
    actor: () => actor,
    profileKey,
    now: () => now,
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
  now = 1_700_000_000_000;
  startOwner();
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('durable native inventory commands', () => {
  it('records stable native profile context and a nondecreasing accepted clock through reopen', () => {
    createFixture();
    const first = owner.operation({ ...scope(), operationId: 'receive' });
    expect(first).toMatchObject({
      recordedAt: now,
      context: {
        version: 6,
        principal: { kind: 'local-profile', profileKey },
        authority: { kind: 'local-profile', profileKey },
      },
    });
    expect(owner.inspect(scope())?.lastRecordedAt).toBe(now);
    const before = owner.inspect(scope());
    expect(owner.availability(scope())).toMatchObject({
      projectId: 'inventory-project',
      inventoryId: scope().inventoryId,
      revision: 1,
      asOf: now,
      principal: { kind: 'local-profile', profileKey },
      stocks: { stock: { onHand: { kind: 'known', value: '100', unit: 'uL' } } },
    });
    expect(owner.inspect(scope())).toEqual(before);
    db.close();
    db = openFileTestDb(dbPath);
    now -= 1_000;
    actor = 'native:restarted-instance';
    startOwner();
    const next = execute('clock-after-restart', 1, [
      { kind: 'set-quality', stockId: 'stock', quality: 'quarantined', reason: 'Incoming check' },
    ]);
    expect(next).toMatchObject({
      status: 'committed',
      actor,
      recordedAt: 1_700_000_000_000,
      context: first?.context,
    });
    expect(owner.replay(scope())).toEqual({ state: owner.inspect(scope()), acceptedOperations: 2 });
  });

  it('reads frozen v1 SQLite state and exact receipts without rewriting them, then accepts new commands', () => {
    const stateJson =
      '{"schema":"dnaforge.inventory.v1","revision":1,"storage":{"legacy-freezer":{"id":"legacy-freezer","name":"Legacy freezer","slots":["A1"],"placement":{"kind":"root"}}},"vessels":{"legacy-tube":{"id":"legacy-tube","name":"Legacy tube","placement":{"kind":"located","storageId":"legacy-freezer","slotId":"A1"},"lifecycle":"active"}},"stocks":{"legacy-stock":{"id":"legacy-stock","vesselId":"legacy-tube","materialId":"synthetic-material","quantity":{"kind":"known","value":"100","unit":"uL"},"quality":"usable"}}}';
    const requestJson =
      '{"commands":[{"id":"legacy-freezer","kind":"create-storage","name":"Legacy freezer","placement":{"kind":"root"},"slots":["A1"]},{"id":"legacy-tube","kind":"create-vessel","name":"Legacy tube","placement":{"kind":"located","slotId":"A1","storageId":"legacy-freezer"}},{"id":"legacy-stock","kind":"receive-stock","materialId":"synthetic-material","quality":"usable","quantity":{"kind":"known","unit":"uL","value":"100"},"vesselId":"legacy-tube"}],"expectedRevision":0,"inventoryId":"legacy-inventory","operationId":"legacy-receive","project":"inventory-project"}';
    const receipt = {
      status: 'committed',
      inventoryId: 'legacy-inventory',
      operationId: 'legacy-receive',
      revision: 1,
      actor: 'native:historical-instance',
      recordedAt: 1_700_000_000_000,
      requestDigest: 'sha256:28fd37501f765f0da612a189e25130c4274962b8d5c65ac7c8628534a15d68dd',
    };
    const receiptJson = JSON.stringify(receipt);
    db.prepare(
      'INSERT INTO inventory_state(inventory_id,project_id,revision,state_json) VALUES(?,?,?,?)'
    ).run('legacy-inventory', 'inventory-project', 1, stateJson);
    db.prepare(
      'INSERT INTO inventory_journal(inventory_id,operation_id,revision,request_json,receipt_json) VALUES(?,?,?,?,?)'
    ).run('legacy-inventory', 'legacy-receive', 1, requestJson, receiptJson);
    db.close();
    db = openFileTestDb(dbPath);
    startOwner();
    const scope = { project: 'inventory-project', inventoryId: 'legacy-inventory' };
    const read = owner.inspect(scope)!;
    expect(read.schema).toBe(INVENTORY_SCHEMA);
    expect(read.storage['legacy-freezer'].layout).toEqual({ kind: 'named', slots: ['A1'] });
    expect(owner.replay(scope)).toEqual({ state: read, acceptedOperations: 1 });
    expect(owner.execute(JSON.parse(requestJson))).toEqual(receipt);
    expect(owner.operation({ ...scope, operationId: 'legacy-receive' })).toEqual(receipt);
    expect(
      db
        .prepare('SELECT revision,state_json FROM inventory_state WHERE inventory_id=?')
        .get(scope.inventoryId)
    ).toEqual({ revision: 1, state_json: stateJson });
    expect(
      db
        .prepare('SELECT request_json,receipt_json FROM inventory_journal WHERE inventory_id=?')
        .get(scope.inventoryId)
    ).toEqual({ request_json: requestJson, receipt_json: receiptJson });
    expect(
      owner.execute({
        ...scope,
        operationId: 'new-use',
        expectedRevision: 1,
        commands: [
          {
            kind: 'consume',
            stockId: 'legacy-stock',
            quantity: { value: '1', unit: 'uL' },
            reason: 'New use',
          },
        ],
      })
    ).toMatchObject({ status: 'committed', revision: 2 });
    expect(owner.inspect(scope)?.stocks['legacy-stock'].quantity).toEqual({
      kind: 'known',
      value: '99',
      unit: 'uL',
    });
    expect(owner.replay(scope)?.acceptedOperations).toBe(2);
    expect(owner.operation({ ...scope, operationId: 'legacy-receive' })).toEqual(receipt);
  });

  it('publishes committed changes with saved receipts and trusted actors, without replay events', () => {
    const notifications: Array<unknown> = [];
    const unsubscribe = owner.subscribe((event) => {
      expect(owner.operation({ ...scope(), operationId: event.operationId })).not.toBeNull();
      expect(owner.inspect(scope())?.revision).toBe(event.revision);
      notifications.push(event);
    });
    const request = {
      ...scope(),
      operationId: 'human-create',
      expectedRevision: 0,
      commands: [
        { kind: 'create-vessel', id: 'tube', name: 'Tube', placement: { kind: 'unplaced' } },
      ],
    };
    const receipt = owner.execute(request, () => {}, { actor: 'human:desktop:7' });
    expect(receipt).toMatchObject({ status: 'committed', actor: 'human:desktop:7' });
    expect(notifications).toHaveLength(1);
    expect(
      owner.execute(request, () => {}, {
        actor: 'agent:another-identity',
        principal: { kind: 'agent', identityId: 'another-identity' },
      })
    ).toEqual(receipt);
    expect(notifications).toHaveLength(1);
    unsubscribe();
    expect(owner.projects()[0].defaultInventoryId).toBe(
      `inventory:${owner.projects()[0].projectId}`
    );
    expect(owner.materials({ project: scope().project, query: 'synthetic-material' })).toEqual({
      items: [
        { id: 'synthetic-material', name: 'Synthetic material', kind: 'record', registryId: null },
      ],
      nextCursor: null,
    });
  });

  it('recovers original receipts before consulting an unavailable native clock', () => {
    createFixture();
    const original = owner.history(scope())[0];
    const before = owner.inspect(scope());
    now = Number.NaN;
    expect(owner.execute(original.request)).toEqual(original.receipt);
    expect(() =>
      execute('invalid-clock', 1, [
        { kind: 'consume', stockId: 'stock', quantity: { value: '1', unit: 'uL' }, reason: 'Use' },
      ])
    ).toThrow('INVENTORY_CLOCK_UNAVAILABLE');
    expect(owner.inspect(scope())).toEqual(before);
    expect(owner.operation({ ...scope(), operationId: 'invalid-clock' })).toBeNull();
  });

  it('admits scientific output references inside atomic reservation fulfillment', () => {
    createFixture();
    expect(
      execute('prepare-reserved-pool', 1, [
        { kind: 'create-vessel', id: 'other-tube', name: 'Other', placement: { kind: 'unplaced' } },
        { kind: 'create-vessel', id: 'pool-tube', name: 'Pool', placement: { kind: 'unplaced' } },
        {
          kind: 'receive-stock',
          id: 'other-stock',
          vesselId: 'other-tube',
          materialId: 'synthetic-material',
          quantity: { kind: 'known', value: '100', unit: 'uL' },
          quality: 'usable',
        },
        {
          kind: 'reserve-quantity',
          id: 'pool-hold',
          stockId: 'stock',
          quantity: { value: '5', unit: 'uL' },
          deadline: null,
          purpose: 'Pool preparation',
        },
      ])
    ).toMatchObject({ status: 'committed', revision: 2 });
    const before = owner.inspect(scope());
    expect(
      execute('unadmitted-pool', 2, [
        {
          kind: 'fulfill-reservations',
          claims: [{ reservationId: 'pool-hold', quantity: { value: '5', unit: 'uL' } }],
          withdrawal: {
            kind: 'pool',
            lotId: 'pool-lot',
            stockId: 'pool-stock',
            vesselId: 'pool-tube',
            materialId: 'unadmitted-material',
            name: 'Pool',
            inputs: [
              { stockId: 'stock', quantity: { value: '5', unit: 'uL' } },
              { stockId: 'other-stock', quantity: { value: '5', unit: 'uL' } },
            ],
            mixing: 'unknown',
            reason: 'Prepare pool',
          },
        },
      ])
    ).toMatchObject({ status: 'rejected', code: 'INVENTORY_MATERIAL_UNAVAILABLE' });
    expect(owner.inspect(scope())).toEqual(before);
    expect(owner.operation({ ...scope(), operationId: 'unadmitted-pool' })).toBeNull();
  });

  it('preserves exact aliquot accounting and lot attribution through receipt retry and SQLite reopen', () => {
    createFixture();
    const commands: InventoryCommand[] = [
      {
        kind: 'create-lot',
        id: 'supplier-lot',
        name: 'Supplier batch',
        materialId: 'synthetic-material',
        origin: { kind: 'received', supplier: 'Supplier', lotNumber: 'A123' },
      },
      {
        kind: 'associate-stock-lot',
        stockId: 'stock',
        lotId: 'supplier-lot',
        reason: 'Verified supplier label',
      },
      {
        kind: 'create-vessel',
        id: 'aliquot-tube',
        name: 'Aliquot tube',
        placement: { kind: 'unplaced' },
      },
      {
        kind: 'transfer',
        sourceStockId: 'stock',
        quantity: { value: '20', unit: 'uL' },
        destination: { kind: 'new-stock', stockId: 'aliquot', vesselId: 'aliquot-tube' },
        reason: 'Prepare aliquot',
      },
    ];
    const receipt = execute('aliquot', 1, commands);
    expect(receipt).toMatchObject({ status: 'committed', revision: 2 });
    expect(execute('aliquot', 1, commands)).toEqual(receipt);
    const before = owner.inspect(scope())!;
    expect(before.stocks.stock.quantity).toMatchObject({ value: '80' });
    expect(before.stocks.aliquot).toMatchObject({
      quantity: { value: '20' },
      source: { kind: 'lot', lotId: 'supplier-lot' },
    });
    db.close();
    db = openFileTestDb(dbPath);
    startOwner();
    expect(owner.inspect(scope())).toEqual(before);
    expect(owner.replay(scope())).toEqual({ state: before, acceptedOperations: 2 });
    expect(execute('aliquot', 1, commands)).toEqual(receipt);
  });

  it('rejects new lot and mixture material references outside the selected project without partial effects', () => {
    createFixture();
    const before = owner.inspect(scope());
    for (const command of [
      {
        kind: 'create-lot',
        id: 'bad-lot',
        name: 'Missing material',
        materialId: 'missing-material',
        origin: { kind: 'received', supplier: 'Supplier', lotNumber: 'X' },
      },
      {
        kind: 'pool',
        lotId: 'bad-pool',
        stockId: 'output',
        vesselId: 'tube',
        materialId: 'missing-material',
        name: 'Pool',
        inputs: [
          { stockId: 'stock', quantity: { value: '1', unit: 'uL' } },
          { stockId: 'other', quantity: { value: '1', unit: 'uL' } },
        ],
        reason: 'Pool',
      },
    ] satisfies InventoryCommand[]) {
      expect(execute(`denied-${command.kind}`, 1, [command])).toMatchObject({
        status: 'rejected',
        code: 'INVENTORY_MATERIAL_UNAVAILABLE',
      });
      expect(owner.inspect(scope())).toEqual(before);
      expect(owner.operation({ ...scope(), operationId: `denied-${command.kind}` })).toBeNull();
    }
  });

  it('preserves an exact derived concentration, its input facts and its receipt across SQLite reopen', () => {
    createFixture();
    db.prepare(
      `INSERT INTO lims_entity (id,kind,schema_id,schema_revision_id,name,fields,workspace_id,registration_status,created_at,updated_at) VALUES('water-material','record','material-schema','material-schema-v1','Water','{}',41,'registered',1,1)`
    ).run();
    const commands: InventoryCommand[] = [
      {
        kind: 'record-composition',
        stockId: 'stock',
        composition: {
          kind: 'homogeneous',
          analytes: { 'synthetic-material': { kind: 'known', value: '1', unit: 'ng/uL' } },
        },
        reason: 'Measured source',
      },
      {
        kind: 'create-vessel',
        id: 'water-tube',
        name: 'Water tube',
        placement: { kind: 'unplaced' },
      },
      {
        kind: 'receive-stock',
        id: 'water',
        vesselId: 'water-tube',
        materialId: 'water-material',
        quantity: { kind: 'known', value: '100', unit: 'uL' },
        quality: 'usable',
      },
      {
        kind: 'record-composition',
        stockId: 'water',
        composition: {
          kind: 'homogeneous',
          analytes: { 'synthetic-material': { kind: 'known', value: '0', unit: 'ng/uL' } },
        },
        reason: 'Explicit analyte-free diluent measurement',
      },
      {
        kind: 'create-vessel',
        id: 'dilution-tube',
        name: 'Dilution tube',
        placement: { kind: 'unplaced' },
      },
      {
        kind: 'dilute',
        lotId: 'dilution',
        stockId: 'diluted',
        vesselId: 'dilution-tube',
        materialId: 'synthetic-material',
        name: 'One-third concentration',
        sample: { stockId: 'stock', quantity: { value: '1', unit: 'uL' } },
        diluent: { stockId: 'water', quantity: { value: '2', unit: 'uL' } },
        mixing: 'homogeneous',
        reason: 'Prepare homogeneous mixture',
      },
    ];
    const receipt = execute('exact-dilution', 1, commands);
    expect(receipt).toMatchObject({ status: 'committed', revision: 2 });
    const expected = owner.inspect(scope())!;
    expect(expected.stocks.diluted.quantity).toMatchObject({ value: '3' });
    expect(expected.stocks.diluted.composition).toEqual({
      kind: 'homogeneous',
      analytes: {
        'synthetic-material': { kind: 'known', unit: 'ng/uL', numerator: '1', denominator: '3' },
      },
    });
    expect(execute('exact-dilution', 1, commands)).toEqual(receipt);
    db.close();
    db = openFileTestDb(dbPath);
    startOwner();
    expect(owner.inspect(scope())).toEqual(expected);
    expect(owner.replay(scope())).toEqual({ state: expected, acceptedOperations: 2 });
    expect(execute('exact-dilution', 1, commands)).toEqual(receipt);
    const recorded = expected.lots.dilution.origin;
    expect(
      execute('new-measurement', 2, [
        {
          kind: 'record-composition',
          stockId: 'stock',
          composition: {
            kind: 'homogeneous',
            analytes: { 'synthetic-material': { kind: 'known', value: '9', unit: 'ng/uL' } },
          },
          reason: 'New measurement',
        },
      ])
    ).toMatchObject({ status: 'committed' });
    expect(owner.inspect(scope())!.lots.dilution.origin).toEqual(recorded);
  });

  it('refuses concentration analytes outside the admitted project without state or receipt changes', () => {
    createFixture();
    const before = owner.inspect(scope());
    expect(
      execute('unavailable-analyte', 1, [
        {
          kind: 'record-composition',
          stockId: 'stock',
          composition: {
            kind: 'homogeneous',
            analytes: { 'unavailable-material': { kind: 'known', value: '1', unit: 'ng/uL' } },
          },
          reason: 'Invalid external reference',
        },
      ])
    ).toMatchObject({ status: 'rejected', code: 'INVENTORY_MATERIAL_UNAVAILABLE' });
    expect(owner.inspect(scope())).toEqual(before);
    expect(owner.operation({ ...scope(), operationId: 'unavailable-analyte' })).toBeNull();
  });

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
      () => owner.storageConditions({ ...scope(), project: 'Other', freshnessMaxAgeMs: null }),
      () =>
        owner.resolveItemCode({
          ...scope(),
          project: 'Other',
          query: { namespace: null, value: 'synthetic-material' },
        }),
      () =>
        owner.catalogUpdatePreview({
          ...scope(),
          project: 'Other',
          catalogEntryId: inventoryEquipmentCatalog()[0].id,
        }),
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
    expect(() =>
      withAgentProjectScope({ kind: 'project-roots', roots: [otherPath] }, () =>
        owner.storageConditions({ ...scope(), freshnessMaxAgeMs: null })
      )
    ).toThrow('PROJECT_ACCESS_DENIED');
    expect(() =>
      withAgentProjectScope({ kind: 'project-roots', roots: [otherPath] }, () =>
        owner.resolveItemCode({ ...scope(), query: { namespace: null, value: '001' } })
      )
    ).toThrow('PROJECT_ACCESS_DENIED');
    expect(() =>
      withAgentProjectScope({ kind: 'project-roots', roots: [otherPath] }, () =>
        owner.catalogUpdatePreview({
          ...scope(),
          catalogEntryId: inventoryEquipmentCatalog()[0].id,
        })
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

  it('previews catalog updates for an absent inventory without database writes or change events', () => {
    const entry = inventoryEquipmentCatalog()[0];
    const request = { ...scope(), inventoryId: 'absent', catalogEntryId: entry.id };
    const changed = vi.fn();
    owner.subscribe(changed);
    const before = db.prepare('SELECT total_changes() AS n').get();
    const preview = owner.catalogUpdatePreview(request);
    expect(preview).toEqual(inventoryEquipmentCatalogUpdatePreview(createInventoryState(), entry));
    expect(preview.revision).toBe(0);
    expect(preview.definitions.every((row) => row.status === 'new')).toBe(true);
    expect(
      owner.inspect({ project: request.project, inventoryId: request.inventoryId })
    ).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM inventory_state').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM inventory_journal').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    expect(changed).not.toHaveBeenCalled();
    Object.assign(preview.model, { region: 'Caller draft' });
    expect(owner.catalogUpdatePreview(request).model).toEqual(entry.model);
  });

  it('reads empty storage conditions without creating inventory, journal rows or events', () => {
    const changed = vi.fn();
    owner.subscribe(changed);
    const request = { ...scope(), inventoryId: 'absent', freshnessMaxAgeMs: null };
    const changes = db.prepare('SELECT total_changes() AS n').get();
    expect(owner.storageConditions(request)).toEqual({
      projectId: 'inventory-project',
      inventoryId: 'absent',
      revision: 0,
      asOf: now,
      principal: { kind: 'local-profile', profileKey },
      freshnessMaxAgeMs: null,
      equipment: {},
      stocks: {},
    });
    expect(
      owner.inspect({ project: request.project, inventoryId: request.inventoryId })
    ).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM inventory_state').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM inventory_journal').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
    expect(changed).not.toHaveBeenCalled();
    const { freshnessMaxAgeMs: _policy, ...missingPolicy } = request;
    for (const invalid of [
      missingPolicy,
      ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '100'].map((freshnessMaxAgeMs) => ({
        ...request,
        freshnessMaxAgeMs,
      })),
      { ...request, asOf: 0 },
      { ...request, principal: { kind: 'agent', identityId: 'other' } },
    ])
      expect(() => owner.storageConditions(invalid)).toThrow();
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
  });

  it('projects saved temperature facts with trusted context, read-only scope and exact reopen parity', () => {
    createFixture();
    const reportedAt = now - 10_000;
    const request = {
      ...scope(),
      operationId: 'temperature-facts',
      expectedRevision: 1,
      commands: [
        {
          kind: 'record-thermal-context',
          item: { kind: 'storage', id: 'freezer' },
          value: { kind: 'self' },
          observedAt: null,
          source: null,
          reason: 'Explicit fixture temperature control boundary',
        },
        {
          kind: 'move-vessel',
          id: 'tube',
          placement: { kind: 'located', storageId: 'box', slotId: 'A1' },
        },
        {
          kind: 'record-equipment-setpoint',
          item: { kind: 'storage', id: 'freezer' },
          value: { kind: 'known', temperature: { value: '-80.00', unit: 'C' } },
          observedAt: reportedAt,
          source: null,
          reason: 'Operator report',
        },
        {
          kind: 'record-storage-requirement',
          target: { kind: 'stock', id: 'stock' },
          value: {
            kind: 'specified',
            range: {
              minimum: { value: '-85', unit: 'C' },
              maximum: { value: '-75', unit: 'C' },
            },
          },
          observedAt: null,
          source: null,
          reason: 'Formulation requirement',
        },
      ],
    };
    const receipt = owner.execute(request);
    expect(receipt).toMatchObject({ status: 'committed', revision: 2, recordedAt: now });
    const scopeRead = { ...scope(), freshnessMaxAgeMs: 10_000 };
    const conditions = owner.storageConditions(scopeRead);
    expect(conditions).toMatchObject({
      projectId: 'inventory-project',
      inventoryId: 'inventory-fixture',
      revision: 2,
      asOf: now,
      principal: { kind: 'local-profile', profileKey },
      equipment: {
        'storage:freezer': {
          setpoint: {
            observedAt: reportedAt,
            at: now,
            by: { kind: 'local-profile', profileKey },
          },
          setpointFreshness: { state: 'fresh', ageMs: 10_000 },
        },
      },
      stocks: {
        stock: {
          requirement: { setting: { observedAt: null, at: now } },
          environment: { kind: 'known', item: { kind: 'storage', id: 'freezer' } },
          capability: { state: 'unknown' },
          reportedTarget: { state: 'supported' },
          qualifiedSupport: { state: 'unknown' },
        },
      },
    });
    const before = {
      state: db.prepare('SELECT * FROM inventory_state').all(),
      journal: db.prepare('SELECT * FROM inventory_journal').all(),
    };
    db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=41").run();
    const changes = db.prepare('SELECT total_changes() AS n').get();
    expect(owner.storageConditions(scopeRead)).toEqual(conditions);
    expect(
      owner.storageConditions(scopeRead, { principal: { kind: 'agent', identityId: 'read-agent' } })
    ).toEqual({ ...conditions, principal: { kind: 'agent', identityId: 'read-agent' } });
    Object.assign(conditions.stocks.stock.reportedTarget, { state: 'incompatible' });
    expect(owner.storageConditions(scopeRead).stocks.stock.reportedTarget.state).toBe('supported');
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
    expect(db.prepare('SELECT * FROM inventory_state').all()).toEqual(before.state);
    expect(db.prepare('SELECT * FROM inventory_journal').all()).toEqual(before.journal);
    const saved = owner.storageConditions(scopeRead);
    db.close();
    db = openFileTestDb(dbPath);
    now -= 5_000;
    startOwner();
    expect(owner.storageConditions(scopeRead)).toEqual(saved);
    expect(owner.replay(scope())).toEqual({ state: owner.inspect(scope()), acceptedOperations: 2 });
    expect(owner.operation({ ...scope(), operationId: request.operationId })).toEqual(receipt);
    expect(db.prepare('SELECT * FROM inventory_state').all()).toEqual(before.state);
    expect(db.prepare('SELECT * FROM inventory_journal').all()).toEqual(before.journal);
    now = Number.NaN;
    expect(() => owner.storageConditions(scopeRead)).toThrow('INVENTORY_CLOCK_UNAVAILABLE');
  });

  it('previews current persisted catalog conflicts without changing saved state or history', () => {
    createFixture();
    const entry = inventoryEquipmentCatalog()[0];
    const first = entry.definitions[0];
    if (first.kind !== 'define-physical-type') throw new Error('Expected physical type.');
    expect(
      execute('local-definition', 1, [{ ...first, name: 'Local physical definition' }])
    ).toMatchObject({ status: 'committed', revision: 2 });
    const before = {
      state: db.prepare('SELECT * FROM inventory_state').all(),
      history: db.prepare('SELECT * FROM inventory_journal').all(),
      changes: db.prepare('SELECT total_changes() AS n').get(),
    };
    const preview = owner.catalogUpdatePreview({ ...scope(), catalogEntryId: entry.id });
    expect(preview.revision).toBe(2);
    expect(preview.canApply).toBe(false);
    expect(preview.conflictCount).toBe(1);
    expect(preview.definitions[0].status).toBe('conflicting');
    expect(owner.inspect(scope())?.stocks.stock.quantity).toEqual({
      kind: 'known',
      value: '100',
      unit: 'uL',
    });
    expect(db.prepare('SELECT * FROM inventory_state').all()).toEqual(before.state);
    expect(db.prepare('SELECT * FROM inventory_journal').all()).toEqual(before.history);
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before.changes);
  });

  it('refuses unknown catalog entries and malformed preview requests without creating inventory', () => {
    const request = { ...scope(), catalogEntryId: inventoryEquipmentCatalog()[0].id };
    const before = db.prepare('SELECT total_changes() AS n').get();
    expect(() =>
      owner.catalogUpdatePreview({ ...request, catalogEntryId: 'unknown-entry' })
    ).toThrow('INVENTORY_CATALOG_ENTRY_NOT_FOUND');
    for (const input of [
      { ...request, catalogEntryId: '' },
      { ...request, catalogEntryId: 'x'.repeat(257) },
      { ...request, commands: [] },
      { project: request.project, catalogEntryId: request.catalogEntryId },
    ])
      expect(() => owner.catalogUpdatePreview(input)).toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM inventory_state').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM inventory_journal').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
  });

  it('resolves absent-inventory item codes without seeding rows, events or scientific fallback', () => {
    const changed = vi.fn();
    owner.subscribe(changed);
    const before = db.prepare('SELECT total_changes() AS n').get();
    const result = owner.resolveItemCode({
      ...scope(),
      inventoryId: 'absent',
      query: { namespace: null, value: 'synthetic-material' },
    });
    expect(result).toEqual({
      projectId: 'inventory-project',
      inventoryId: 'absent',
      revision: 0,
      asOf: now,
      principal: { kind: 'local-profile', profileKey },
      resolution: { kind: 'not-found' },
      targets: [],
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM inventory_state').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM inventory_journal').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    expect(changed).not.toHaveBeenCalled();
  });

  it('returns typed invalid code queries and rejects unknown request fields without normalization', () => {
    const before = db.prepare('SELECT total_changes() AS n').get();
    for (const query of [
      { namespace: 'Uppercase', value: '001a' },
      { namespace: null, value: '' },
      { namespace: null, value: '   ' },
      { namespace: null, value: '001a\r\n' },
      { namespace: null, value: '001a\t' },
      { namespace: null, value: '001é' },
      { namespace: null, value: '0'.repeat(513) },
    ]) {
      expect(owner.resolveItemCode({ ...scope(), query })).toMatchObject({
        resolution: { kind: 'invalid', message: expect.any(String) },
        targets: [],
        revision: 0,
      });
    }
    for (const query of [
      { namespace: null, value: '001a', extra: true },
      { value: '001a' },
      { namespace: null, value: 1 },
    ])
      expect(() => owner.resolveItemCode({ ...scope(), query })).toThrow();
    expect(() =>
      owner.resolveItemCode({
        ...scope(),
        query: { namespace: null, value: '001a' },
        commands: [],
      })
    ).toThrow();
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
  });

  it('returns bounded exact-code target facts and availability from one admitted snapshot', () => {
    createFixture();
    expect(
      execute('code-fixture', 1, [
        {
          kind: 'move-vessel',
          id: 'tube',
          placement: { kind: 'located', storageId: 'box', slotId: 'A1' },
        },
        {
          kind: 'attach-item-code',
          id: 'tube-code',
          namespace: 'lab',
          value: ' 001a ',
          item: { kind: 'vessel', id: 'tube' },
          reason: 'Existing physical tube code.',
        },
        {
          kind: 'attach-item-code',
          id: 'freezer-code',
          namespace: 'equipment',
          value: 'https://example.invalid/code',
          item: { kind: 'storage', id: 'freezer' },
          reason: 'Existing physical equipment code, treated only as text.',
        },
        {
          kind: 'create-vessel',
          id: 'other-tube',
          name: 'Other tube',
          placement: { kind: 'unplaced' },
        },
        {
          kind: 'receive-stock',
          id: 'other-stock',
          vesselId: 'other-tube',
          materialId: 'synthetic-material',
          quantity: { kind: 'known', value: '5', unit: 'uL' },
          quality: 'usable',
        },
      ])
    ).toMatchObject({ status: 'committed', revision: 2 });
    const state = owner.inspect(scope())!;
    const invocation = { principal: { kind: 'agent' as const, identityId: 'code-reader' } };
    now += 1000;
    const availability = owner.availability(scope(), invocation)!;
    const before = db.prepare('SELECT total_changes() AS n').get();
    const changed = vi.fn();
    owner.subscribe(changed);
    const lookup = owner.resolveItemCode(
      {
        ...scope(),
        query: { namespace: 'lab', value: ' 001a ' },
      },
      invocation
    );
    expect(lookup).toMatchObject({
      projectId: 'inventory-project',
      inventoryId: scope().inventoryId,
      revision: 2,
      asOf: now,
      principal: invocation.principal,
      resolution: { kind: 'resolved', match: { id: 'tube-code', value: ' 001a ' } },
    });
    expect(lookup.targets).toEqual([
      {
        item: { kind: 'vessel', id: 'tube' },
        record: state.vessels.tube,
        custody: availability.items.tube,
        physical: availability.physical.items.tube,
        currentLocationPath: [
          { item: { kind: 'storage', id: 'freezer' }, name: 'Freezer', position: null },
          { item: { kind: 'storage', id: 'box' }, name: 'Box', position: 'top' },
          { item: { kind: 'vessel', id: 'tube' }, name: 'Tube', position: 'A1' },
        ],
        stocks: [{ stock: state.stocks.stock, availability: availability.stocks.stock }],
      },
    ]);
    const freezer = owner.resolveItemCode({
      ...scope(),
      query: { namespace: 'equipment', value: 'https://example.invalid/code' },
    });
    expect(freezer.targets[0].stocks.map((row) => row.stock.id)).toEqual(['stock']);
    for (const value of ['001a', ' 001A ', 'synthetic-material'])
      expect(
        owner.resolveItemCode({ ...scope(), query: { namespace: null, value } }).resolution
      ).toEqual({ kind: 'not-found' });
    Object.assign(lookup.targets[0].record, { name: 'Caller draft' });
    expect(owner.inspect(scope())).toEqual(state);
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    expect(changed).not.toHaveBeenCalled();
  });

  it('retains retired namespace ambiguity and missing-item facts without changing stock', () => {
    createFixture();
    expect(
      execute('code-history', 1, [
        {
          kind: 'attach-item-code',
          id: 'active-code',
          namespace: 'lab',
          value: '001',
          item: { kind: 'vessel', id: 'tube' },
          reason: 'Existing tube code.',
        },
        {
          kind: 'attach-item-code',
          id: 'retired-code',
          namespace: 'site',
          value: '001',
          item: { kind: 'vessel', id: 'tube' },
          reason: 'Older tube code.',
        },
        { kind: 'retire-item-code', codeId: 'retired-code', reason: 'Retain reserved old code.' },
        {
          kind: 'report-item-missing',
          item: { kind: 'vessel', id: 'tube' },
          reason: 'Reported missing.',
        },
      ])
    ).toMatchObject({ status: 'committed', revision: 2 });
    const before = owner.inspect(scope());
    const changes = db.prepare('SELECT total_changes() AS n').get();
    const ambiguous = owner.resolveItemCode({
      ...scope(),
      query: { namespace: null, value: '001' },
    });
    expect(ambiguous.resolution).toMatchObject({
      kind: 'ambiguous',
      matches: [
        expect.objectContaining({ id: 'active-code', lifecycle: { kind: 'active' } }),
        expect.objectContaining({
          id: 'retired-code',
          lifecycle: expect.objectContaining({ kind: 'retired' }),
        }),
      ],
    });
    expect(ambiguous.targets).toHaveLength(1);
    expect(ambiguous.targets[0]).toMatchObject({
      item: { kind: 'vessel', id: 'tube' },
      record: { lifecycle: 'active' },
      custody: { state: { kind: 'missing' }, lastKnown: expect.any(Object) },
      currentLocationPath: null,
      stocks: [{ stock: { quantity: { kind: 'known', value: '100', unit: 'uL' } } }],
    });
    const retired = owner.resolveItemCode({
      ...scope(),
      query: { namespace: 'site', value: '001' },
    });
    expect(retired.resolution).toMatchObject({ kind: 'retired', match: { id: 'retired-code' } });
    expect(retired.targets).toEqual(ambiguous.targets);
    db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=41").run();
    expect(
      owner.resolveItemCode({
        ...scope(),
        query: { namespace: 'lab', value: '001' },
      }).resolution
    ).toMatchObject({ kind: 'resolved', match: { id: 'active-code' } });
    expect(owner.inspect(scope())).toEqual(before);
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual({
      n: (changes as { n: number }).n + 1,
    });
  });

  it('prepares the exact scoped label as a detached zero-write snapshot for humans and agents', async () => {
    createFixture();
    expect(
      execute('label-code', 1, [
        {
          kind: 'attach-item-code',
          id: 'label-code',
          namespace: 'lab',
          value: ' 00a^FNC1^029\\x00 ',
          item: { kind: 'vessel', id: 'tube' },
          reason: 'Existing exact alias.',
        },
        {
          kind: 'report-item-missing',
          item: { kind: 'vessel', id: 'tube' },
          reason: 'Location is unknown.',
        },
      ])
    ).toMatchObject({ status: 'committed', revision: 2 });
    const state = owner.inspect(scope())!;
    const history = owner.history(scope());
    const rows = db.prepare('SELECT * FROM inventory_state').all();
    const journal = db.prepare('SELECT * FROM inventory_journal').all();
    const changes = db.prepare('SELECT total_changes() AS n').get();
    const changed = vi.fn();
    owner.subscribe(changed);
    const request = { ...scope(), codeId: 'label-code', mediaProfileId: 'qr-80x50-300dpi' };
    const human = await owner.prepareLabel(request);
    const invocation = { principal: { kind: 'agent' as const, identityId: 'label-reader' } };
    const agent = await owner.prepareLabel(request, invocation);
    expect(human).toMatchObject({
      schema: 'dnaforge.inventory-label-artifact.v1',
      projectId: 'inventory-project',
      inventoryId: scope().inventoryId,
      sourceRevision: 2,
      asOf: now,
      principal: { kind: 'local-profile', profileKey },
      binding: state.itemCodes['label-code'],
      target: {
        item: { kind: 'vessel', id: 'tube' },
        record: state.vessels.tube,
        custody: { state: { kind: 'missing' } },
        currentLocationPath: null,
        stocks: [{ stock: state.stocks.stock }],
      },
      rendered: {
        template: 'dnaforge.inventory-label.qr.v1',
        spec: {
          scope: { projectId: 'inventory-project', inventoryId: scope().inventoryId },
          sourceRevision: 2,
          binding: {
            id: 'label-code',
            namespace: 'lab',
            value: ' 00a^FNC1^029\\x00 ',
            item: { kind: 'vessel', id: 'tube' },
          },
        },
      },
    });
    expect(agent.principal).toEqual(invocation.principal);
    expect(agent.rendered).toEqual(human.rendered);
    expect(agent.svgSha256).toBe(
      `sha256:${createHash('sha256').update(human.rendered.svg, 'utf8').digest('hex')}`
    );
    Object.assign(agent.target.record, { name: 'Caller draft' });
    Object.assign(agent.binding, { value: 'Caller replacement' });
    expect(owner.inspect(scope())).toEqual(state);
    expect(owner.history(scope())).toEqual(history);
    expect(db.prepare('SELECT * FROM inventory_state').all()).toEqual(rows);
    expect(db.prepare('SELECT * FROM inventory_journal').all()).toEqual(journal);
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
    expect(changed).not.toHaveBeenCalled();
    const retained = structuredClone(human);
    expect(
      execute('retire-label-code', 2, [
        { kind: 'retire-item-code', codeId: 'label-code', reason: 'No new labels.' },
      ])
    ).toMatchObject({ status: 'committed', revision: 3 });
    await expect(owner.prepareLabel(request)).rejects.toThrow('INVENTORY_ITEM_CODE_RETIRED');
    expect(human).toEqual(retained);
  });

  it('renders full-length binding identifiers and retains names outside the ASCII symbol template', async () => {
    const codeId = 'c'.repeat(512);
    expect(
      execute('long-label-identity', 0, [
        { kind: 'create-vessel', id: 'tube', name: '试管 α', placement: { kind: 'unplaced' } },
        {
          kind: 'attach-item-code',
          id: codeId,
          namespace: 'lab',
          value: '001a',
          item: { kind: 'vessel', id: 'tube' },
          reason: 'Existing alias with a full binding identifier.',
        },
      ])
    ).toMatchObject({ status: 'committed', revision: 1 });
    const changes = db.prepare('SELECT total_changes() AS n').get();
    const label = await owner.prepareLabel({
      ...scope(),
      codeId,
      mediaProfileId: 'qr-50x30-300dpi',
    });
    expect(label.binding.id).toBe(codeId);
    expect(label.rendered.spec.binding.id).toBe(codeId);
    expect(label.target.record.name).toBe('试管 α');
    expect(label.rendered.humanText.map((row) => row.text)).toEqual(['lab', '001a', 'vessel:tube']);
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
  });

  it('refuses unknown, retired, disposed and overflowing label requests without inventory effects', async () => {
    createFixture();
    expect(
      execute('label-refusals', 1, [
        { kind: 'create-vessel', id: 'empty', name: 'Empty', placement: { kind: 'unplaced' } },
        {
          kind: 'attach-item-code',
          id: 'disposed-code',
          namespace: 'lab',
          value: 'EMPTY',
          item: { kind: 'vessel', id: 'empty' },
          reason: 'Existing code.',
        },
        { kind: 'dispose-vessel', id: 'empty', reason: 'Disposed empty tube.' },
        {
          kind: 'attach-item-code',
          id: 'retired-code',
          namespace: 'lab',
          value: 'OLD',
          item: { kind: 'vessel', id: 'tube' },
          reason: 'Old code.',
        },
        { kind: 'retire-item-code', codeId: 'retired-code', reason: 'Retired code.' },
        {
          kind: 'attach-item-code',
          id: 'long-code',
          namespace: 'lab',
          value: 'a'.repeat(512),
          item: { kind: 'vessel', id: 'tube' },
          reason: 'Existing long code.',
        },
      ])
    ).toMatchObject({ status: 'committed', revision: 2 });
    const state = owner.inspect(scope());
    const history = owner.history(scope());
    const changes = db.prepare('SELECT total_changes() AS n').get();
    const changed = vi.fn();
    owner.subscribe(changed);
    const request = { ...scope(), mediaProfileId: 'qr-50x30-300dpi' };
    for (const [codeId, code] of [
      ['unknown', 'INVENTORY_ITEM_CODE_NOT_FOUND'],
      ['retired-code', 'INVENTORY_ITEM_CODE_RETIRED'],
      ['disposed-code', 'INVENTORY_LABEL_TARGET_DISPOSED'],
      ['long-code', 'INVENTORY_LABEL_LAYOUT_OVERFLOW'],
    ])
      await expect(owner.prepareLabel({ ...request, codeId })).rejects.toThrow(code);
    await expect(
      owner.prepareLabel({ ...request, inventoryId: 'absent-inventory', codeId: 'unknown' })
    ).rejects.toThrow('INVENTORY_ITEM_CODE_NOT_FOUND');
    for (const invalid of [
      { ...request, codeId: 'long-code', mediaProfileId: 'printer-auto' },
      { ...request, codeId: 'long-code', templateId: 'anything' },
      { ...request, codeId: 'long-code', value: 'replacement' },
      { ...request, codeId: 'long-code', asOf: 0 },
      { ...request, codeId: 'x'.repeat(513) },
    ])
      await expect(owner.prepareLabel(invalid)).rejects.toThrow();
    await expect(
      withAgentProjectScope({ kind: 'project-roots', roots: [] }, () =>
        owner.prepareLabel({ ...request, codeId: 'retired-code' })
      )
    ).rejects.toThrow('PROJECT_ACCESS_DENIED');
    expect(owner.inspect(scope())).toEqual(state);
    expect(owner.history(scope())).toEqual(history);
    expect(owner.inspect({ ...scope(), inventoryId: 'absent-inventory' })).toBeNull();
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
    expect(changed).not.toHaveBeenCalled();
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
