// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { inventoryWellId, type InventoryStocktakeChoices } from '@waypoint/domain-services';
import type { InventoryApplyStocktakeRequest } from '../shared/inventory-command';
import { NATIVE_DOCUMENT_MAX_BODY_BYTES } from '../shared/native-document-transport';

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
let now: number;
const scope = { project: 'stocktake-project', inventoryId: 'stocktake-inventory' };
const agent = { kind: 'agent' as const, identityId: 'stocktake-agent' };
const columns = [
  'observation_id',
  'subject_key',
  'observed_at',
  'quantity_kind',
  'quantity',
  'unit',
  'presence',
  'location_key',
  'slot',
  'reason',
];
type Row = string[];
const quantity = (id: string, value: string): Row => [
  id,
  'sample',
  'unknown',
  'known',
  value,
  'uL',
  'not-observed',
  '',
  '',
  `Synthetic quantity observation ${id}`,
];
const presence = (id: string, value: 'missing' | 'found', subject = 'tube'): Row => [
  id,
  subject,
  'unknown',
  'not-observed',
  '',
  '',
  value,
  value === 'found' ? 'rack' : '',
  value === 'found' ? 'B' : '',
  `Synthetic ${value} observation ${id}`,
];
const text = (rows: readonly Row[]) =>
  '\uFEFF' +
  [columns, ...rows]
    .map((row) => row.map((value) => `"${value.replaceAll('"', '""')}"`).join(','))
    .join('\r\n') +
  '\r\n';
function choices(
  rows: readonly Row[],
  choice: 'record-only' | 'apply' = 'apply'
): InventoryStocktakeChoices {
  const keys = [...new Set(rows.map((row) => row[1]))];
  return {
    namespace: 'Synthetic stocktake collection',
    delimiter: ',',
    subjects: keys.map((key) => ({
      key,
      subject:
        key === 'sample'
          ? { kind: 'stock', stockId: 'sample' }
          : {
              kind: 'item',
              item: {
                kind: 'vessel',
                id: key === 'well' ? inventoryWellId('plate', 'A1') : 'tube',
              },
            },
    })),
    locations: rows.some((row) => row[7] === 'rack')
      ? [{ key: 'rack', target: { kind: 'storage', storageId: 'rack' } }]
      : [],
    decisions: rows.map((row) => ({
      observationId: row[0],
      choice:
        choice === 'record-only'
          ? { kind: 'record-only' }
          : { kind: 'apply', reason: `Explicit correction ${row[0]}` },
    })),
  };
}
const input = (rows: readonly Row[], options = choices(rows)) => ({
  ...scope,
  format: 'stocktake-v1',
  sourceText: text(rows),
  options,
});
const raw = () => ({
  states: db.prepare('SELECT * FROM inventory_state ORDER BY inventory_id').all(),
  history: db.prepare('SELECT * FROM inventory_journal ORDER BY inventory_id,revision').all(),
  changes: db.prepare('SELECT total_changes() AS count').get(),
});
function startOwner() {
  owner = createNativeInventoryOwner({
    db: () => db,
    projectAuthority: createRegisteredProjectAuthority({ db: () => db }),
    actor: () => 'native:stocktake-fixture',
    profileKey: 'a'.repeat(64),
    now: () => now,
  });
  owner.initialize();
}
function request(
  rows: readonly Row[],
  operationId: string,
  options = choices(rows)
): InventoryApplyStocktakeRequest {
  const preview = owner.previewStocktake(input(rows, options), { principal: agent });
  expect(preview.kind).toBe('ready');
  if (preview.kind !== 'ready') throw new Error(JSON.stringify(preview));
  return {
    kind: 'apply-stocktake',
    ...scope,
    operationId,
    expectedRevision: preview.target.revision,
    sourceText: text(rows),
    options: preview.options,
    expectedPlanDigest: preview.planDigest,
  };
}
function commit(rows: readonly Row[], operationId: string, options = choices(rows)) {
  const selected = request(rows, operationId, options);
  const receipt = owner.applyStocktake(selected, undefined, { principal: agent });
  expect(receipt).toMatchObject({ status: 'committed', context: { principal: agent } });
  return { request: selected, receipt };
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dnaforge-inventory-stocktake-'));
  dbPath = join(root, 'inventory.sqlite');
  db = openFileTestDb(dbPath);
  ensureSchema(db, dbPath);
  const path = join(root, 'project');
  mkdirSync(path);
  db.prepare(
    'INSERT INTO workspaces(id,name,path,repo_uuid,access_mode,created_at) VALUES(41,?,?,?,?,1)'
  ).run('Stocktake', path, scope.project, 'writable');
  rememberOriginalDefaultProject(db, 41);
  db.prepare(
    "INSERT INTO lims_schema(id,kind,name,display_name,fields,current_revision_id,created_at,updated_at) VALUES('schema','entity','fixture','Fixture','{}','schema-v1',1,1)"
  ).run();
  db.prepare(
    "INSERT INTO lims_schema_revision(id,schema_id,version,fields,created_at) VALUES('schema-v1','schema',1,'{}',1)"
  ).run();
  db.prepare(
    "INSERT INTO lims_entity(id,kind,schema_id,schema_revision_id,name,fields,workspace_id,registration_status,created_at,updated_at) VALUES('stocktake-material','record','schema','schema-v1','Stocktake material','{}',41,'registered',1,1)"
  ).run();
  db.prepare(
    "INSERT INTO catalog_entities(id,type,name,locator,storage_type,status,created_at,updated_at) VALUES('stocktake-material','record','Stocktake material','entity://lims/stocktake-material','database','active',1,1)"
  ).run();
  db.prepare(
    "INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,file_kind,status,created_at,updated_at) VALUES('material-file','stocktake-material',41,?,'record','current',1,1)"
  ).run(join(path, 'material.forge.json'));
  now = 1_700_000_000_000;
  startOwner();
  expect(
    owner.execute(
      {
        ...scope,
        operationId: 'setup',
        expectedRevision: 0,
        commands: [
          {
            kind: 'create-storage',
            id: 'rack',
            name: 'Rack',
            slots: ['A', 'B'],
            placement: { kind: 'root' },
          },
          {
            kind: 'create-vessel',
            id: 'tube',
            name: 'Tube',
            placement: { kind: 'located', storageId: 'rack', slotId: 'A' },
          },
          {
            kind: 'receive-stock',
            id: 'sample',
            vesselId: 'tube',
            materialId: 'stocktake-material',
            quantity: { kind: 'known', value: '100', unit: 'uL' },
            quality: 'usable',
          },
          {
            kind: 'reserve-quantity',
            id: 'hold',
            stockId: 'sample',
            quantity: { value: '70', unit: 'uL' },
            deadline: null,
            purpose: 'Synthetic reservation retained through observations',
          },
          {
            kind: 'checkout-item',
            item: { kind: 'vessel', id: 'tube' },
            dueAt: null,
            reason: 'Synthetic existing custody',
          },
          {
            kind: 'create-layout-storage',
            id: 'plate',
            name: 'Plate',
            layout: { kind: 'fixed-well', rows: 1, columns: 1 },
            placement: { kind: 'root' },
          },
        ],
      },
      undefined,
      { principal: agent }
    )
  ).toMatchObject({ status: 'committed', revision: 1 });
});
afterEach(() => {
  if (db.open) db.close();
  rmSync(root, { recursive: true, force: true });
});

it('previews without writes and rechecks authority, target revision and encoded transport at acceptance', () => {
  const rows = [quantity('001', '20')];
  const before = raw();
  const preview = owner.previewStocktake(input(rows), { principal: agent });
  expect(preview).toMatchObject({
    kind: 'ready',
    principal: agent,
    target: { revision: 1, present: true },
  });
  expect(preview.rows[0].after?.availability).toMatchObject({
    held: { value: '70', unit: 'uL' },
    blockers: expect.arrayContaining([{ code: 'ALLOCATION_SHORTFALL' }]),
  });
  expect(raw()).toEqual(before);
  expect(
    owner.previewStocktake(input(rows, { ...choices(rows), subjects: [], decisions: [] }))
  ).toMatchObject({ kind: 'blocked' });
  expect(() =>
    withAgentProjectScope({ kind: 'project-roots', roots: [] }, () =>
      owner.previewStocktake(input(rows))
    )
  ).toThrow('PROJECT_ACCESS_DENIED');
  expect(raw()).toEqual(before);
  const selected = request(rows, 'observe-once');
  expect(
    owner.applyStocktake({ ...selected, sourceText: 'x'.repeat(NATIVE_DOCUMENT_MAX_BODY_BYTES) })
  ).toMatchObject({ status: 'rejected', code: 'INVENTORY_STOCKTAKE_TOO_LARGE' });
  expect(raw()).toEqual(before);
  db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=41").run();
  const readOnly = raw();
  expect(owner.previewStocktake(input(rows))).toMatchObject({ kind: 'ready' });
  expect(() => owner.applyStocktake(selected)).toThrow('PROJECT_ACCESS_DENIED');
  expect(raw()).toEqual(readOnly);
  db.prepare("UPDATE workspaces SET access_mode='writable' WHERE id=41").run();
  owner.execute({
    ...scope,
    operationId: 'concurrent-change',
    expectedRevision: 1,
    commands: [
      { kind: 'create-vessel', id: 'later', name: 'Later', placement: { kind: 'unplaced' } },
    ],
  });
  const later = raw();
  expect(owner.applyStocktake(selected)).toMatchObject({
    status: 'rejected',
    code: 'REVISION_CONFLICT',
  });
  expect(raw()).toEqual(later);
});

it('records and applies independent observations once while preserving holds and custody through archive and reopen', () => {
  const original = owner.inspect(scope)!;
  const measured = commit([quantity('001', '20')], 'measure-below-hold');
  const afterMeasurement = owner.inspect(scope)!;
  expect(afterMeasurement.stocks.sample.quantity).toEqual({
    kind: 'known',
    value: '20',
    unit: 'uL',
  });
  expect(afterMeasurement.reservations).toEqual(original.reservations);
  expect(afterMeasurement.vessels.tube.custody).toEqual(original.vessels.tube.custody);
  expect(owner.availability(scope, { principal: agent })?.stocks.sample.blockers).toContainEqual({
    code: 'ALLOCATION_SHORTFALL',
  });
  commit([presence('002', 'missing')], 'report-missing');
  const missing = owner.inspect(scope)!;
  expect(missing.vessels.tube.custody.kind).toBe('missing');
  expect(missing.stocks.sample).toEqual(afterMeasurement.stocks.sample);
  expect(missing.reservations).toEqual(original.reservations);
  commit([presence('003', 'found')], 'locate-found');
  const found = owner.inspect(scope)!;
  expect(found.vessels.tube.custody).toEqual({ kind: 'available' });
  expect(found.vessels.tube.placement).toEqual({ kind: 'located', storageId: 'rack', slotId: 'B' });
  expect(found.stocks.sample).toEqual(afterMeasurement.stocks.sample);
  expect(found.reservations).toEqual(original.reservations);
  const laterRows = [quantity('004', '80')];
  const recorded = commit(laterRows, 'record-only', choices(laterRows, 'record-only'));
  expect(owner.inspect(scope)!.stocks.sample).toEqual(afterMeasurement.stocks.sample);
  const pending = Object.values(owner.inspect(scope)!.observations).find(
    (row) => row.observationId === '004'
  )!;
  expect(pending.application).toEqual({ kind: 'unapplied' });
  const toApply = request(laterRows, 'apply-recorded');
  expect(owner.previewStocktake(input(laterRows)).commands).toHaveLength(1);
  expect(owner.applyStocktake(toApply, undefined, { principal: agent })).toMatchObject({
    status: 'committed',
  });
  expect(owner.inspect(scope)!.stocks.sample.quantity).toEqual({
    kind: 'known',
    value: '80',
    unit: 'uL',
  });
  expect(
    owner.execute(
      {
        ...scope,
        operationId: 'later-use',
        expectedRevision: owner.inspect(scope)!.revision,
        commands: [
          {
            kind: 'consume',
            stockId: 'sample',
            quantity: { value: '5', unit: 'uL' },
            reason: 'Synthetic later consumption',
          },
        ],
      },
      undefined,
      { principal: agent }
    )
  ).toMatchObject({ status: 'committed' });
  const used = owner.inspect(scope)!;
  expect(used.stocks.sample.quantity).toEqual({ kind: 'known', value: '75', unit: 'uL' });
  const unchanged = raw();
  expect(owner.previewStocktake(input(laterRows))).toMatchObject({ kind: 'no-change' });
  expect(owner.previewStocktake(input([quantity('001', '21')]))).toMatchObject({ kind: 'blocked' });
  expect(
    owner.applyStocktake({
      ...toApply,
      operationId: 'repeat-observation',
      expectedRevision: used.revision,
    })
  ).toMatchObject({ status: 'rejected', code: 'INVENTORY_STOCKTAKE_NO_CHANGES' });
  expect(
    owner.applyStocktake({ ...measured.request, sourceText: measured.request.sourceText + '\n' })
  ).toMatchObject({ status: 'rejected', code: 'INVENTORY_OPERATION_CONFLICT' });
  now += 10_000;
  expect(owner.applyStocktake(recorded.request)).toEqual(recorded.receipt);
  expect(raw()).toEqual(unchanged);
  const artifact = owner.exportSnapshot({ ...scope, format: 'native-v1' });
  const destination = { ...scope, inventoryId: 'adopted-stocktake' };
  const adoption = owner.previewImport({
    ...destination,
    sourceText: artifact.sourceText,
    options: {
      bindings: [
        { sourceMaterialId: 'stocktake-material', destinationMaterialId: 'stocktake-material' },
      ],
    },
  });
  expect(adoption.kind).toBe('ready');
  if (adoption.kind !== 'ready') throw new Error(JSON.stringify(adoption));
  expect(
    owner.applyImport({
      kind: 'adopt-archive',
      ...destination,
      operationId: 'adopt-observations',
      expectedRevision: 0,
      sourceText: artifact.sourceText,
      options: adoption.options,
      expectedPlanDigest: adoption.planDigest,
    })
  ).toMatchObject({ status: 'committed' });
  const adopted = owner.inspect(destination)!;
  for (const [key, observation] of Object.entries(adopted.observations)) {
    expect(observation.by.kind).toBe('imported');
    expect(observation.subject).toEqual(used.observations[key].subject);
    expect(observation.fact).toEqual(used.observations[key].fact);
    if (observation.application.kind === 'applied')
      expect(observation.application.by.kind).toBe('imported');
  }
  expect(owner.previewStocktake({ ...input(laterRows), ...destination })).toMatchObject({
    kind: 'no-change',
  });
  const history = owner.history(scope);
  db.close();
  db = openFileTestDb(dbPath);
  startOwner();
  expect(owner.inspect(scope)).toEqual(used);
  expect(owner.history(scope)).toEqual(history);
  expect(owner.applyStocktake(measured.request)).toEqual(measured.receipt);
  expect(owner.applyStocktake(recorded.request)).toEqual(recorded.receipt);
  expect(owner.replay(scope)).toEqual({ state: used, acceptedOperations: used.revision });
  expect(owner.replay(destination)).toEqual({ state: adopted, acceptedOperations: 1 });
  expect(owner.exportSnapshot({ ...scope, format: 'native-v1' }).sourceText).toBe(
    artifact.sourceText
  );
});

it('refuses a late permanent-well custody correction without recording earlier valid observations', () => {
  const rows = [quantity('001', '20'), presence('002', 'missing', 'well')];
  const before = raw();
  const preview = owner.previewStocktake(input(rows), { principal: agent });
  expect(preview.kind).toBe('blocked');
  expect(
    owner.applyStocktake({
      kind: 'apply-stocktake',
      ...scope,
      operationId: 'invalid-atomic-stocktake',
      expectedRevision: 1,
      sourceText: text(rows),
      options: choices(rows),
      expectedPlanDigest: `sha256:${'0'.repeat(64)}`,
    })
  ).toMatchObject({ status: 'rejected' });
  expect(owner.operation({ ...scope, operationId: 'invalid-atomic-stocktake' })).toBeNull();
  expect(raw()).toEqual(before);
  expect(owner.inspect(scope)!.observations).toEqual({});
});
