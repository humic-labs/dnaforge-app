// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { InventoryApplyTableRequest } from '../shared/inventory-command';
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
const scope = { project: 'receive-project', inventoryId: 'receive-inventory' };
const agent = { kind: 'agent' as const, identityId: 'table-agent' };
const columns = [
  'source_id',
  'name',
  'material_key',
  'quantity_kind',
  'quantity',
  'unit',
  'quality',
  'vessel_kind',
  'vessel_key',
  'location_key',
  'slot',
];
const rows = [
  [
    '001',
    'Source "tube",\nfirst',
    'm1',
    'known',
    '12.500',
    'uL',
    'usable',
    'new',
    '',
    'rack',
    'A1',
  ],
  ['002', '', 'm1', 'unknown', '', '', 'quarantined', 'existing', 'empty', '', ''],
  ['003', 'Known zero', 'm1', 'known', '0', 'uL', 'usable', 'new', '', 'rack', 'A2'],
];
const text = (data = rows) =>
  '\uFEFF' +
  [columns, ...data]
    .map((row) => row.map((value) => `"${value.replaceAll('"', '""')}"`).join(','))
    .join('\r\n') +
  '\r\n';
const options = {
  namespace: 'Synthetic receiving source',
  delimiter: ',' as const,
  materials: [{ key: 'm1', materialId: 'receive-material' }],
  locations: [{ key: 'rack', target: { kind: 'storage' as const, storageId: 'rack' } }],
  vessels: [{ key: 'empty', vesselId: 'empty' }],
  skips: [],
};
const input = (sourceText = text()) => ({ ...scope, format: 'receive-v1', sourceText, options });
const raw = () => ({
  states: db.prepare('SELECT * FROM inventory_state ORDER BY inventory_id').all(),
  history: db.prepare('SELECT * FROM inventory_journal ORDER BY inventory_id,revision').all(),
  changes: db.prepare('SELECT total_changes() AS count').get(),
});
function startOwner() {
  owner = createNativeInventoryOwner({
    db: () => db,
    projectAuthority: createRegisteredProjectAuthority({ db: () => db }),
    actor: () => 'native:table-fixture',
    profileKey: 'a'.repeat(64),
    now: () => now,
  });
  owner.initialize();
}
function readyRequest(
  sourceText = text(),
  operationId = 'receive-table'
): InventoryApplyTableRequest {
  const preview = owner.previewTable(input(sourceText), { principal: agent });
  expect(preview.kind).toBe('ready');
  if (preview.kind !== 'ready') throw new Error(JSON.stringify(preview));
  return {
    kind: 'receive-table',
    ...scope,
    operationId,
    expectedRevision: preview.target.revision,
    sourceText,
    options: preview.options,
    expectedPlanDigest: preview.planDigest,
  };
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dnaforge-inventory-table-'));
  dbPath = join(root, 'inventory.sqlite');
  db = openFileTestDb(dbPath);
  ensureSchema(db, dbPath);
  const path = join(root, 'project');
  mkdirSync(path);
  db.prepare(
    'INSERT INTO workspaces(id,name,path,repo_uuid,access_mode,created_at) VALUES(41,?,?,?,?,1)'
  ).run('Receiving', path, scope.project, 'writable');
  rememberOriginalDefaultProject(db, 41);
  db.prepare(
    "INSERT INTO lims_schema(id,kind,name,display_name,fields,current_revision_id,created_at,updated_at) VALUES('schema','entity','fixture','Fixture','{}','schema-v1',1,1)"
  ).run();
  db.prepare(
    "INSERT INTO lims_schema_revision(id,schema_id,version,fields,created_at) VALUES('schema-v1','schema',1,'{}',1)"
  ).run();
  db.prepare(
    "INSERT INTO lims_entity(id,kind,schema_id,schema_revision_id,name,fields,workspace_id,registration_status,created_at,updated_at) VALUES('receive-material','record','schema','schema-v1','Receive material','{}',41,'registered',1,1)"
  ).run();
  db.prepare(
    "INSERT INTO catalog_entities(id,type,name,locator,storage_type,status,created_at,updated_at) VALUES('receive-material','record','Receive material','entity://lims/receive-material','database','active',1,1)"
  ).run();
  db.prepare(
    "INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,file_kind,status,created_at,updated_at) VALUES('material-file','receive-material',41,?,'record','current',1,1)"
  ).run(join(path, 'material.forge.json'));
  now = 1_700_000_000_000;
  startOwner();
  expect(
    owner.execute({
      ...scope,
      operationId: 'setup',
      expectedRevision: 0,
      commands: [
        {
          kind: 'create-storage',
          id: 'rack',
          name: 'Rack',
          slots: ['A1', 'A2'],
          placement: { kind: 'root' },
        },
        {
          kind: 'create-vessel',
          id: 'empty',
          name: 'Existing empty vessel',
          placement: { kind: 'unplaced' },
        },
      ],
    })
  ).toMatchObject({ status: 'committed', revision: 1 });
});
afterEach(() => {
  if (db.open) db.close();
  rmSync(root, { recursive: true, force: true });
});

it('previews exact source and explicit bindings without writes under current read-only authority', () => {
  const before = raw();
  const preview = owner.previewTable(input(), { principal: agent });
  expect(preview).toMatchObject({
    kind: 'ready',
    principal: agent,
    target: { revision: 1, present: true },
  });
  expect(preview.rows.map((row) => row.sourceId)).toEqual(['001', '002', '003']);
  expect(preview.commands).toHaveLength(5);
  expect(raw()).toEqual(before);
  expect(
    owner.previewTable({
      ...input(),
      options: { ...options, materials: [], locations: [], vessels: [] },
    })
  ).toMatchObject({ kind: 'blocked' });
  expect(raw()).toEqual(before);
  expect(() =>
    withAgentProjectScope({ kind: 'project-roots', roots: [] }, () => owner.previewTable(input()))
  ).toThrow('PROJECT_ACCESS_DENIED');
  expect(raw()).toEqual(before);
  const request = readyRequest();
  db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=41").run();
  const readOnly = raw();
  expect(owner.previewTable(input())).toMatchObject({ kind: 'ready' });
  expect(() => owner.applyTable(request)).toThrow('PROJECT_ACCESS_DENIED');
  expect(raw()).toEqual(readOnly);
});

it('revalidates revision, scientific file provenance and encoded transport before any effects', () => {
  const request = readyRequest();
  db.prepare(
    "UPDATE catalog_entity_files SET path=path||'.changed' WHERE id='material-file'"
  ).run();
  const before = raw();
  expect(owner.applyTable(request)).toMatchObject({
    status: 'rejected',
    code: 'INVENTORY_TABLE_PLAN_CHANGED',
  });
  expect(raw()).toEqual(before);
  expect(
    owner.applyTable({ ...request, sourceText: 'x'.repeat(NATIVE_DOCUMENT_MAX_BODY_BYTES) })
  ).toMatchObject({ status: 'rejected', code: 'INVENTORY_TABLE_TOO_LARGE' });
  expect(raw()).toEqual(before);
  const current = readyRequest();
  owner.execute({
    ...scope,
    operationId: 'after-preview',
    expectedRevision: 1,
    commands: [
      { kind: 'create-vessel', id: 'later', name: 'Later', placement: { kind: 'unplaced' } },
    ],
  });
  const after = raw();
  expect(owner.applyTable(current)).toMatchObject({
    status: 'rejected',
    code: 'REVISION_CONFLICT',
  });
  expect(raw()).toEqual(after);
  const invalid = rows.map((row, index) =>
    index === 2 ? [...row.slice(0, 10), 'not-a-slot'] : row
  );
  expect(owner.previewTable(input(text(invalid)))).toMatchObject({ kind: 'blocked' });
  expect(raw()).toEqual(after);
});

it('receives once, recovers original receipts and treats reordered source separately from current stock', () => {
  const request = readyRequest();
  now += 1000;
  const receipt = owner.applyTable(request, undefined, { principal: agent });
  expect(receipt).toMatchObject({
    status: 'committed',
    revision: 2,
    recordedAt: now,
    context: { principal: agent },
  });
  const accepted = raw();
  const state = owner.inspect(scope)!;
  expect(Object.keys(state.tableBindings)).toHaveLength(3);
  const binding = Object.values(state.tableBindings).find((row) => row.sourceId === '001')!;
  expect(state.stocks[binding.stockId].quantity).toEqual({
    kind: 'known',
    value: '12.5',
    unit: 'uL',
  });
  expect(Object.values(state.stocks).map((stock) => stock.quantity)).toContainEqual({
    kind: 'unknown',
  });
  expect(Object.values(state.stocks).map((stock) => stock.quantity)).toContainEqual({
    kind: 'known',
    value: '0',
    unit: 'uL',
  });
  expect(owner.history(scope)[1].request).toEqual(request);
  expect(owner.applyTable(request)).toEqual(receipt);
  expect(raw()).toEqual(accepted);
  expect(owner.applyTable({ ...request, sourceText: request.sourceText + '\r\n' })).toMatchObject({
    status: 'rejected',
    code: 'INVENTORY_OPERATION_CONFLICT',
  });
  expect(raw()).toEqual(accepted);
  expect(owner.previewTable(input(text([...rows].reverse())))).toMatchObject({ kind: 'no-change' });
  expect(raw()).toEqual(accepted);
  expect(
    owner.execute({
      ...scope,
      operationId: 'later-use',
      expectedRevision: 2,
      commands: [
        {
          kind: 'consume',
          stockId: binding.stockId,
          quantity: { value: '2.5', unit: 'uL' },
          reason: 'Synthetic later use',
        },
        { kind: 'move-vessel', id: binding.vesselId, placement: { kind: 'unplaced' } },
      ],
    })
  ).toMatchObject({ status: 'committed', revision: 3 });
  const used = raw();
  expect(owner.previewTable(input())).toMatchObject({ kind: 'no-change' });
  const changed = rows.map((row, index) =>
    index === 0 ? row.map((value, field) => (field === 4 ? '99' : value)) : row
  );
  expect(owner.previewTable(input(text(changed)))).toMatchObject({ kind: 'blocked' });
  expect(raw()).toEqual(used);
  expect(owner.operation({ ...scope, operationId: request.operationId })).toEqual(receipt);
  db.close();
  db = openFileTestDb(dbPath);
  startOwner();
  expect(owner.operation({ ...scope, operationId: request.operationId })).toEqual(receipt);
  expect(owner.applyTable(request)).toEqual(receipt);
  expect(owner.replay(scope)).toEqual({ state: owner.inspect(scope), acceptedOperations: 3 });
});

it('archives mixed history and adopts lifetime row bindings without deriving replacement physical identities', () => {
  const request = readyRequest();
  owner.applyTable(request, undefined, { principal: agent });
  const artifact = owner.exportSnapshot({ ...scope, format: 'native-v1' });
  const destination = { ...scope, inventoryId: 'adopted-table-inventory' };
  const preview = owner.previewImport({
    ...destination,
    sourceText: artifact.sourceText,
    options: {
      bindings: [
        { sourceMaterialId: 'receive-material', destinationMaterialId: 'receive-material' },
      ],
    },
  });
  expect(preview.kind).toBe('ready');
  if (preview.kind !== 'ready') throw new Error(JSON.stringify(preview));
  expect(
    owner.applyImport({
      kind: 'adopt-archive',
      ...destination,
      operationId: 'adopt-table',
      expectedRevision: 0,
      sourceText: artifact.sourceText,
      options: preview.options,
      expectedPlanDigest: preview.planDigest,
    })
  ).toMatchObject({ status: 'committed', revision: 1 });
  expect(owner.inspect(destination)!.tableBindings).toEqual(owner.inspect(scope)!.tableBindings);
  expect(owner.previewTable({ ...input(), ...destination })).toMatchObject({ kind: 'no-change' });
  const nested = owner.exportSnapshot({ ...destination, format: 'native-v1' });
  expect(nested.sourceText).toContain('receive-table');
  expect(nested.sourceText).toContain('Synthetic receiving source');
  expect(owner.replay(destination)).toEqual({
    state: owner.inspect(destination),
    acceptedOperations: 1,
  });
});
