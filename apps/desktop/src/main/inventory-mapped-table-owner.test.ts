// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { inventoryWellId, type InventoryMappedTableChoices } from '@waypoint/domain-services';
import type { InventoryApplyMappedTableRequest } from '../shared/inventory-command';
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
const scope = { project: 'mapped-project', inventoryId: 'mapped-inventory' };
const agent = { kind: 'agent' as const, identityId: 'mapped-agent' };
const sourceText = readFileSync(
  new URL('../../../../test-fixtures/lims-import/walkthrough/primers-messy.csv', import.meta.url),
  'utf8'
).replaceAll('\n', '\r\n');
const ids = ['MP001', 'MP002', 'MP003'];
const choices: InventoryMappedTableChoices = {
  namespace: 'Synthetic explicit primer register',
  delimiter: ',',
  columns: { sourceId: 'Primer ID', plate: 'Plate', well: 'Well' },
  materials: ids.map((sourceId, index) => ({ sourceId, materialId: `mapped-primer-${index + 1}` })),
  plates: [
    {
      sourcePlate: 'Plate-7',
      storageId: 'plate-7',
      positions: [
        { sourceWell: 'A01', position: 'A1' },
        { sourceWell: 'A02', position: 'A2' },
      ],
    },
    {
      sourcePlate: 'Plate-8',
      storageId: 'plate-8',
      positions: [{ sourceWell: 'B01', position: 'B1' }],
    },
  ],
  quantity: { kind: 'unknown', reason: 'This register contains no measured volume' },
  qualities: ids.map((sourceId, index) => ({
    sourceId,
    quality: index === 1 ? ('quarantined' as const) : ('usable' as const),
    reason: 'Explicit inventory quality decision, independent from source QC label',
  })),
  evidenceOnlyColumns: sourceText
    .split('\r\n')[0]
    .split(',')
    .filter((column) => !['Primer ID', 'Plate', 'Well'].includes(column))
    .map((column) => ({
      column,
      reason: 'Retain the original scientific or supplier field as evidence only',
    })),
  skips: [],
};
const input = (text = sourceText, options = choices, target = scope) => ({
  ...target,
  format: 'mapped-plate-v1',
  sourceText: text,
  options,
});
const raw = () => ({
  states: db.prepare('SELECT * FROM inventory_state ORDER BY inventory_id').all(),
  history: db.prepare('SELECT * FROM inventory_journal ORDER BY inventory_id,revision').all(),
  changes: db.prepare('SELECT total_changes() AS count').get(),
});
function start() {
  owner = createNativeInventoryOwner({
    db: () => db,
    projectAuthority: createRegisteredProjectAuthority({ db: () => db }),
    actor: () => 'native:mapped-fixture',
    profileKey: 'a'.repeat(64),
    now: () => 1_700_000_000_000,
  });
  owner.initialize();
}
function request(text = sourceText, operationId = 'mapped-once'): InventoryApplyMappedTableRequest {
  const preview = owner.previewMappedTable(input(text), { principal: agent });
  expect(preview.kind).toBe('ready');
  if (preview.kind !== 'ready') throw new Error(JSON.stringify(preview));
  return {
    ...scope,
    kind: 'receive-mapped-table',
    operationId,
    expectedRevision: preview.target.revision,
    sourceText: text,
    options: preview.options,
    expectedPlanDigest: preview.planDigest,
  };
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dnaforge-inventory-mapped-'));
  dbPath = join(root, 'inventory.sqlite');
  db = openFileTestDb(dbPath);
  ensureSchema(db, dbPath);
  const projectPath = join(root, 'project');
  mkdirSync(projectPath);
  db.prepare(
    'INSERT INTO workspaces(id,name,path,repo_uuid,access_mode,created_at) VALUES(41,?,?,?,?,1)'
  ).run('Mapped', projectPath, scope.project, 'writable');
  rememberOriginalDefaultProject(db, 41);
  db.prepare(
    "INSERT INTO lims_schema(id,kind,name,display_name,fields,current_revision_id,created_at,updated_at) VALUES('schema','entity','fixture','Fixture','{}','schema-v1',1,1)"
  ).run();
  db.prepare(
    "INSERT INTO lims_schema_revision(id,schema_id,version,fields,created_at) VALUES('schema-v1','schema',1,'{}',1)"
  ).run();
  for (const [index, sourceId] of ids.entries()) {
    const id = `mapped-primer-${index + 1}`;
    db.prepare(
      "INSERT INTO lims_entity(id,kind,schema_id,schema_revision_id,name,fields,workspace_id,registration_status,created_at,updated_at) VALUES(?,'record','schema','schema-v1',?,'{}',41,'registered',1,1)"
    ).run(id, sourceId);
    db.prepare(
      "INSERT INTO catalog_entities(id,type,name,locator,storage_type,status,created_at,updated_at) VALUES(?,'record',?,?,'database','active',1,1)"
    ).run(id, sourceId, `entity://lims/${id}`);
    db.prepare(
      "INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,file_kind,status,created_at,updated_at) VALUES(?,?,41,?,'record','current',1,1)"
    ).run(`${id}-file`, id, join(projectPath, `${id}.forge.json`));
  }
  start();
  expect(
    owner.execute({
      ...scope,
      operationId: 'plates',
      expectedRevision: 0,
      commands: ['plate-7', 'plate-8'].map((id) => ({
        kind: 'create-layout-storage',
        id,
        name: id,
        layout: { kind: 'fixed-well', rows: 2, columns: 2 },
        placement: { kind: 'root' },
      })),
    }).status
  ).toBe('committed');
});
afterEach(() => {
  if (db.open) db.close();
  rmSync(root, { recursive: true, force: true });
});

it('preserves the full mapped source and explicit interpretation through one receipt, later use, replay and reopen', () => {
  const before = raw();
  const blocked = owner.previewMappedTable(
    input(sourceText, {
      ...choices,
      columns: { sourceId: '', plate: '', well: '' },
      materials: [],
      plates: [],
      qualities: [],
      evidenceOnlyColumns: [],
    })
  );
  expect(blocked.kind).toBe('blocked');
  expect(blocked.headers).toHaveLength(13);
  expect(raw()).toEqual(before);
  const accepted = request();
  const receipt = owner.applyMappedTable(accepted, undefined, { principal: agent });
  expect(receipt).toMatchObject({
    status: 'committed',
    revision: 2,
    context: { principal: agent },
  });
  const imported = owner.inspect(scope)!;
  const bindings = Object.values(imported.tableBindings);
  expect(bindings).toHaveLength(3);
  expect(bindings.map((binding) => imported.stocks[binding.stockId].quantity)).toEqual([
    { kind: 'unknown' },
    { kind: 'unknown' },
    { kind: 'unknown' },
  ]);
  const first = bindings.find((value) => value.sourceId === 'MP001')!;
  expect(first.vesselId).toBe(inventoryWellId('plate-7', 'A1'));
  expect(
    imported.stocks[bindings.find((value) => value.sourceId === 'MP002')!.stockId].quality
  ).toBe('quarantined');
  expect(
    imported.stocks[bindings.find((value) => value.sourceId === 'MP003')!.stockId].quality
  ).toBe('usable');
  expect(owner.history(scope).at(-1)!.request).toEqual(accepted);
  expect(owner.applyMappedTable(accepted)).toEqual(receipt);
  expect(owner.applyMappedTable({ ...accepted, sourceText: sourceText + '\r\n' })).toMatchObject({
    status: 'rejected',
    code: 'INVENTORY_OPERATION_CONFLICT',
  });
  expect(
    owner.execute({
      ...scope,
      operationId: 'measured-and-used',
      expectedRevision: 2,
      commands: [
        {
          kind: 'reconcile',
          stockId: first.stockId,
          quantity: { kind: 'known', value: '10', unit: 'uL' },
          reason: 'Later actual measurement',
        },
        {
          kind: 'consume',
          stockId: first.stockId,
          quantity: { value: '2', unit: 'uL' },
          reason: 'Later actual use',
        },
      ],
    }).status
  ).toBe('committed');
  const state = owner.inspect(scope)!;
  expect(state.stocks[first.stockId].quantity).toEqual({ kind: 'known', value: '8', unit: 'uL' });
  const lines = sourceText.trimEnd().split('\r\n');
  const reordered = [lines[0], ...lines.slice(1).reverse()].join('\r\n') + '\r\n';
  expect(owner.previewMappedTable(input(reordered)).kind).toBe('no-change');
  const effects = raw();
  expect(
    owner.previewMappedTable(
      input(sourceText.replace('M13 forward control', 'Revised evidence only'))
    ).kind
  ).toBe('no-change');
  expect(raw()).toEqual(effects);
  const artifact = owner.exportSnapshot({ ...scope, format: 'native-v1' });
  const saved = JSON.parse(artifact.sourceText)
    .content.history.map((row: { requestJson: string }) => JSON.parse(row.requestJson))
    .find((row: { operationId: string }) => row.operationId === accepted.operationId);
  expect(saved).toEqual(accepted);
  db.close();
  db = openFileTestDb(dbPath);
  start();
  expect(owner.inspect(scope)).toEqual(state);
  expect(owner.replay(scope)).toEqual({ state, acceptedOperations: state.revision });
  expect(owner.applyMappedTable(accepted)).toEqual(receipt);
  expect(owner.exportSnapshot({ ...scope, format: 'native-v1' }).sourceText).toBe(
    artifact.sourceText
  );
});

it('refuses stale material fingerprints, stale revisions and late occupied wells without partial stock', () => {
  const fingerprint = request();
  db.prepare(
    "UPDATE catalog_entity_files SET updated_at=2 WHERE entity_id='mapped-primer-1'"
  ).run();
  const before = raw();
  expect(owner.applyMappedTable(fingerprint)).toMatchObject({
    status: 'rejected',
    code: 'INVENTORY_MAPPED_TABLE_PLAN_CHANGED',
  });
  expect(raw()).toEqual(before);
  const fresh = request();
  expect(
    owner.execute({
      ...scope,
      operationId: 'occupy-late-well',
      expectedRevision: 1,
      commands: [
        {
          kind: 'receive-stock',
          id: 'occupant',
          vesselId: inventoryWellId('plate-8', 'B1'),
          materialId: 'mapped-primer-3',
          quantity: { kind: 'unknown' },
          quality: 'usable',
        },
      ],
    }).status
  ).toBe('committed');
  const occupied = raw();
  expect(owner.applyMappedTable(fresh)).toMatchObject({
    status: 'rejected',
    code: 'REVISION_CONFLICT',
  });
  expect(owner.previewMappedTable(input()).kind).toBe('blocked');
  expect(raw()).toEqual(occupied);
  const absent = { project: scope.project, inventoryId: 'absent-mapped' };
  const missing = owner.previewMappedTable(input(sourceText, choices, absent));
  expect(missing.kind).toBe('blocked');
  expect(owner.inspect(absent)).toBeNull();
});

it('replays mapped rows in nested archives and recovers their normalized source preimages without current-stock reconstruction', () => {
  const accepted = request();
  owner.applyMappedTable(accepted, undefined, { principal: agent });
  const preview = owner.previewMappedTable(input());
  expect(preview.normalizedSourceText).toBeTypeOf('string');
  expect(preview.innerPreview?.options).not.toBeNull();
  const normalized = preview.normalizedSourceText!;
  const inner = preview.innerPreview!.options!;
  const table = {
    ...inner,
    materials: inner.materials.map(({ key, materialId }) => ({ key, materialId })),
  };
  const artifact = owner.exportSnapshot({ ...scope, format: 'native-v1' });
  const target = { project: scope.project, inventoryId: 'adopted-mapped' };
  const bindings = choices.materials.map((material) => ({
    sourceMaterialId: material.materialId,
    destinationMaterialId: material.materialId,
  }));
  const adoption = owner.previewImport({
    ...target,
    sourceText: artifact.sourceText,
    options: { bindings },
  });
  expect(adoption.kind).toBe('ready');
  if (adoption.kind !== 'ready') throw new Error(JSON.stringify(adoption));
  expect(
    owner.applyImport({
      ...target,
      kind: 'adopt-archive',
      operationId: 'adopt',
      expectedRevision: 0,
      sourceText: artifact.sourceText,
      options: adoption.options,
      expectedPlanDigest: adoption.planDigest,
    }).status
  ).toBe('committed');
  const state = owner.inspect(target)!;
  expect(owner.previewMappedTable(input(sourceText, choices, target)).kind).toBe('no-change');
  const acknowledgement = owner.previewSourceRevision({
    ...target,
    format: 'receive-v1',
    sourceText: normalized.replace(
      '"MP001","","MP001","unknown","","","usable",',
      '"MP001","","MP001","unknown","","","quarantined",'
    ),
    options: { table, acknowledgements: [] },
  });
  expect(acknowledgement.kind).toBe('needs-acknowledgement');
  expect(
    acknowledgement.rows.find((row) => row.sourceId === 'MP001')!.previousFields
  ).toMatchObject({
    source_id: 'MP001',
    quantity_kind: 'unknown',
    quality: 'usable',
    vessel_kind: 'existing',
  });
  expect(owner.inspect(target)).toEqual(state);
  expect(() =>
    withAgentProjectScope({ kind: 'project-roots', roots: [join(root, 'foreign')] }, () =>
      owner.previewMappedTable(input())
    )
  ).toThrow(/PROJECT_ACCESS_DENIED/);
  const tooLarge = {
    ...accepted,
    operationId: 'too-large',
    expectedRevision: owner.inspect(scope)!.revision,
    sourceText: sourceText + ' '.repeat(NATIVE_DOCUMENT_MAX_BODY_BYTES),
  };
  const effects = raw();
  expect(owner.applyMappedTable(tooLarge)).toMatchObject({
    status: 'rejected',
    code: 'INVENTORY_MAPPED_TABLE_TOO_LARGE',
  });
  expect(raw()).toEqual(effects);
});
