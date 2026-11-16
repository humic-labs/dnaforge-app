// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  INVENTORY_RECEIVE_TABLE_COLUMNS,
  type InventoryReceiveTableFields,
  type InventorySourceRevisionChoices,
  type InventoryTableChoices,
  type InventoryCommand,
} from '@waypoint/domain-services';
import type { InventoryAcknowledgeSourceRequest } from '../shared/inventory-command';
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
const scope = { project: 'source-project', inventoryId: 'source-inventory' };
const agent = { kind: 'agent' as const, identityId: 'source-agent' };
const original: InventoryReceiveTableFields = {
  source_id: '0007',
  name: 'Source tube, alpha',
  material_key: 'sample',
  quantity_kind: 'known',
  quantity: '80',
  unit: 'uL',
  quality: 'usable',
  vessel_kind: 'new',
  vessel_key: '',
  location_key: 'rack',
  slot: 'A',
};
const revised: InventoryReceiveTableFields = {
  ...original,
  name: 'Revised external name',
  quantity: '90',
  quality: 'quarantined',
  slot: 'C',
};
const text = (fields: readonly InventoryReceiveTableFields[]) =>
  '\uFEFF' +
  [
    INVENTORY_RECEIVE_TABLE_COLUMNS,
    ...fields.map((row) => INVENTORY_RECEIVE_TABLE_COLUMNS.map((column) => row[column])),
  ]
    .map((row) => row.map((value) => `"${value.replaceAll('"', '""')}"`).join(','))
    .join('\r\n') +
  '\r\n';
const table: InventoryTableChoices = {
  namespace: 'external:register:stable',
  delimiter: ',',
  materials: [{ key: 'sample', materialId: 'source-material' }],
  locations: [{ key: 'rack', target: { kind: 'storage', storageId: 'rack' } }],
  vessels: [],
  skips: [],
};
const choices = (selectedTable = table): InventorySourceRevisionChoices => ({
  table: selectedTable,
  acknowledgements: [],
});
const input = (fields = [revised], options = choices(), target = scope) => ({
  ...target,
  format: 'receive-v1',
  sourceText: text(fields),
  options,
});
const raw = () => ({
  states: db.prepare('SELECT * FROM inventory_state ORDER BY inventory_id').all(),
  journal: db.prepare('SELECT * FROM inventory_journal ORDER BY inventory_id,revision').all(),
  changes: db.prepare('SELECT total_changes() AS count').get(),
});
const physical = (state: NonNullable<ReturnType<typeof owner.inspect>>) => {
  const { revision: _revision, lastRecordedAt: _clock, tableBindings: _bindings, ...facts } = state;
  return facts;
};
function startOwner() {
  owner = createNativeInventoryOwner({
    db: () => db,
    projectAuthority: createRegisteredProjectAuthority({ db: () => db }),
    actor: () => 'native:source-fixture',
    profileKey: 'a'.repeat(64),
    now: () => now,
  });
  owner.initialize();
}
function execute(operationId: string, commands: readonly InventoryCommand[]) {
  const result = owner.execute(
    { ...scope, operationId, expectedRevision: owner.inspect(scope)?.revision ?? 0, commands },
    undefined,
    { principal: agent }
  );
  expect(result.status).toBe('committed');
  return result;
}
function receive(longHistory = false) {
  if (longHistory)
    for (let index = 0; index < 101; index++)
      execute(`prior:${index}`, [
        {
          kind: 'create-vessel',
          id: `prior:${index}`,
          name: `Prior empty vessel ${index}`,
          placement: { kind: 'unplaced' },
        },
      ]);
  const preview = owner.previewTable(
    { ...scope, format: 'receive-v1', sourceText: text([original]), options: table },
    { principal: agent }
  );
  if (preview.kind !== 'ready') throw new Error(JSON.stringify(preview));
  expect(
    owner.applyTable(
      {
        ...scope,
        kind: 'receive-table',
        operationId: 'receive-original',
        expectedRevision: preview.target.revision,
        sourceText: text([original]),
        options: preview.options,
        expectedPlanDigest: preview.planDigest,
      },
      undefined,
      { principal: agent }
    ).status
  ).toBe('committed');
  const binding = Object.values(owner.inspect(scope)!.tableBindings).find(
    (row) => row.sourceId === '0007'
  )!;
  execute('use-and-move', [
    {
      kind: 'consume',
      stockId: binding.stockId,
      quantity: { value: '10', unit: 'uL' },
      reason: 'Synthetic later use',
    },
    {
      kind: 'move-vessel',
      id: binding.vesselId,
      placement: { kind: 'located', storageId: 'rack', slotId: 'B' },
    },
    {
      kind: 'reserve-quantity',
      id: 'hold',
      stockId: binding.stockId,
      quantity: { value: '60', unit: 'uL' },
      deadline: null,
      purpose: 'Synthetic hold must not change during source acknowledgement',
    },
    {
      kind: 'record-inventory-observation',
      namespace: 'source-observation',
      observationId: 'observed',
      subject: { kind: 'stock', stockId: binding.stockId },
      observedAt: null,
      fact: { kind: 'quantity', quantity: { kind: 'known', value: '70', unit: 'uL' } },
      reason: 'Synthetic record-only measurement remains independent',
    },
  ]);
  const otherSource = text([
    { ...original, source_id: '0008', name: 'Other source stock', quantity: '0' },
  ]);
  const other = owner.previewTable({
    ...scope,
    format: 'receive-v1',
    sourceText: otherSource,
    options: table,
  });
  if (other.kind !== 'ready') throw new Error(JSON.stringify(other));
  expect(
    owner.applyTable({
      ...scope,
      kind: 'receive-table',
      operationId: 'receive-other-row',
      expectedRevision: other.target.revision,
      sourceText: otherSource,
      options: other.options,
      expectedPlanDigest: other.planDigest,
    }).status
  ).toBe('committed');
  return binding;
}
function request(
  operationId: string,
  fields = [revised],
  selectedTable = table,
  target = scope
): InventoryAcknowledgeSourceRequest {
  const compared = owner.previewSourceRevision(input(fields, choices(selectedTable), target), {
    principal: agent,
  });
  expect(compared.kind).toBe('needs-acknowledgement');
  const acknowledgements = compared.rows
    .filter((row) => row.kind === 'needs-acknowledgement')
    .map((row) => ({
      sourceId: row.sourceId!,
      expectedPreviousRowSha256: row.previousRowSha256!,
      reason: `Reviewed revised external source ${row.sourceId}`,
    }));
  const preview = owner.previewSourceRevision(
    input(fields, { table: selectedTable, acknowledgements }, target),
    { principal: agent }
  );
  if (preview.kind !== 'ready') throw new Error(JSON.stringify(preview));
  return {
    ...target,
    kind: 'acknowledge-table-source',
    operationId,
    expectedRevision: preview.target.revision,
    sourceText: text(fields),
    options: preview.options,
    expectedPlanDigest: preview.planDigest,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dnaforge-inventory-source-'));
  dbPath = join(root, 'inventory.sqlite');
  db = openFileTestDb(dbPath);
  ensureSchema(db, dbPath);
  const path = join(root, 'project');
  mkdirSync(path);
  db.prepare(
    'INSERT INTO workspaces(id,name,path,repo_uuid,access_mode,created_at) VALUES(41,?,?,?,?,1)'
  ).run('Source', path, scope.project, 'writable');
  rememberOriginalDefaultProject(db, 41);
  db.prepare(
    "INSERT INTO lims_schema(id,kind,name,display_name,fields,current_revision_id,created_at,updated_at) VALUES('schema','entity','fixture','Fixture','{}','schema-v1',1,1)"
  ).run();
  db.prepare(
    "INSERT INTO lims_schema_revision(id,schema_id,version,fields,created_at) VALUES('schema-v1','schema',1,'{}',1)"
  ).run();
  for (const id of ['source-material', 'destination-material']) {
    db.prepare(
      "INSERT INTO lims_entity(id,kind,schema_id,schema_revision_id,name,fields,workspace_id,registration_status,created_at,updated_at) VALUES(?,'record','schema','schema-v1',?,'{}',41,'registered',1,1)"
    ).run(id, id);
    db.prepare(
      "INSERT INTO catalog_entities(id,type,name,locator,storage_type,status,created_at,updated_at) VALUES(?,'record',?,?,'database','active',1,1)"
    ).run(id, id, `entity://lims/${id}`);
    db.prepare(
      "INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,file_kind,status,created_at,updated_at) VALUES(?,?,41,?,'record','current',1,1)"
    ).run(`${id}-file`, id, join(path, `${id}.forge.json`));
  }
  now = 1_700_000_000_000;
  startOwner();
  execute('destinations', [
    {
      kind: 'create-storage',
      id: 'rack',
      name: 'Rack',
      slots: ['A', 'B', 'C'],
      placement: { kind: 'root' },
    },
    {
      kind: 'create-vessel',
      id: 'occupied',
      name: 'Occupied C',
      placement: { kind: 'located', storageId: 'rack', slotId: 'C' },
    },
  ]);
});
afterEach(() => {
  if (db.open) db.close();
  rmSync(root, { recursive: true, force: true });
});

it('recovers true previous source beyond one history page and refuses changed authority, revision, evidence and oversized requests without effects', () => {
  const binding = receive(true);
  expect(
    owner.history(scope).some((entry) => entry.request.operationId === 'receive-original')
  ).toBe(false);
  const before = raw();
  const compared = owner.previewSourceRevision(input(), { principal: agent });
  expect(compared).toMatchObject({ kind: 'needs-acknowledgement', principal: agent });
  expect(compared.rows[0].previousFields).toEqual(original);
  expect(compared.rows[0].revisedFields).toEqual(revised);
  expect(compared.rows[0].actual?.stock.quantity).toEqual({
    kind: 'known',
    value: '70',
    unit: 'uL',
  });
  expect(compared.rows[0].actual?.vessel.placement).toEqual({
    kind: 'located',
    storageId: 'rack',
    slotId: 'B',
  });
  expect(raw()).toEqual(before);
  const selected = request('source-once');
  expect(selected.options.preimages).toEqual([{ sourceId: '0007', fields: original }]);
  expect(
    owner.previewSourceRevision(
      input([revised], {
        table,
        acknowledgements: [
          { sourceId: '0007', expectedPreviousRowSha256: binding.rowSha256, reason: '' },
        ],
      })
    ).kind
  ).toBe('blocked');
  expect(() =>
    withAgentProjectScope({ kind: 'project-roots', roots: [] }, () =>
      owner.previewSourceRevision(input())
    )
  ).toThrow('PROJECT_ACCESS_DENIED');
  expect(raw()).toEqual(before);
  expect(
    owner.acknowledgeSource({ ...selected, sourceText: 'x'.repeat(NATIVE_DOCUMENT_MAX_BODY_BYTES) })
  ).toMatchObject({ status: 'rejected', code: 'INVENTORY_SOURCE_REVISION_TOO_LARGE' });
  expect(
    owner.acknowledgeSource({
      ...selected,
      options: {
        ...selected.options,
        preimages: [{ sourceId: '0007', fields: { ...original, quantity: '999' } }],
      },
    })
  ).toMatchObject({ status: 'rejected', code: 'INVENTORY_SOURCE_REVISION_PLAN_CHANGED' });
  expect(raw()).toEqual(before);
  db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=41").run();
  const readOnly = raw();
  expect(owner.previewSourceRevision(input()).kind).toBe('needs-acknowledgement');
  expect(() => owner.acknowledgeSource(selected)).toThrow('PROJECT_ACCESS_DENIED');
  expect(raw()).toEqual(readOnly);
  db.prepare("UPDATE workspaces SET access_mode='writable' WHERE id=41").run();
  execute('concurrent-use', [
    {
      kind: 'consume',
      stockId: binding.stockId,
      quantity: { value: '1', unit: 'uL' },
      reason: 'Synthetic concurrent use invalidates source preview',
    },
  ]);
  const later = raw();
  expect(owner.acknowledgeSource(selected)).toMatchObject({
    status: 'rejected',
    code: 'REVISION_CONFLICT',
  });
  expect(raw()).toEqual(later);
});

it('appends source revisions without physical change and preserves original retries, rollback history and later consumption after reopen', () => {
  const binding = receive();
  const before = owner.inspect(scope)!;
  const selected = request('acknowledge-once');
  const receipt = owner.acknowledgeSource(selected, undefined, { principal: agent });
  expect(receipt).toMatchObject({ status: 'committed', context: { principal: agent } });
  const accepted = owner.inspect(scope)!;
  expect(physical(accepted)).toEqual(physical(before));
  const changed = Object.values(accepted.tableBindings).find((row) => row.sourceId === '0007')!;
  expect(changed.rowSha256).toBe(binding.rowSha256);
  expect(changed.destination).toEqual(binding.destination);
  expect(changed.sourceRevisions).toHaveLength(1);
  expect(changed.sourceRevisions[0]).toMatchObject({
    previousRowSha256: binding.rowSha256,
    fields: revised,
    by: agent,
  });
  expect(
    owner.previewTable(
      { ...scope, format: 'receive-v1', sourceText: text([revised]), options: table },
      { principal: agent }
    ).kind
  ).toBe('no-change');
  execute('after-source-use', [
    {
      kind: 'consume',
      stockId: binding.stockId,
      quantity: { value: '1', unit: 'uL' },
      reason: 'Synthetic later use must not be replenished by source',
    },
  ]);
  expect(
    owner.previewTable({
      ...scope,
      format: 'receive-v1',
      sourceText: text([revised]),
      options: table,
    }).kind
  ).toBe('no-change');
  const rollback = request('acknowledge-rollback', [original]);
  expect(owner.acknowledgeSource(rollback).status).toBe('committed');
  expect(
    Object.values(owner.inspect(scope)!.tableBindings).find((row) => row.sourceId === '0007')!
      .sourceRevisions
  ).toHaveLength(2);
  expect(owner.inspect(scope)!.stocks[binding.stockId].quantity.value).toBe('69');
  now = Number.NaN;
  expect(owner.acknowledgeSource(selected)).toEqual(receipt);
  expect(
    owner.acknowledgeSource({ ...selected, sourceText: selected.sourceText + '\n' })
  ).toMatchObject({ status: 'rejected', code: 'INVENTORY_OPERATION_CONFLICT' });
  now = 1_700_000_000_000;
  const state = owner.inspect(scope)!;
  const history = owner.history({ ...scope, limit: 1000 });
  const artifact = owner.exportSnapshot({ ...scope, format: 'native-v1' });
  db.close();
  db = openFileTestDb(dbPath);
  startOwner();
  expect(owner.inspect(scope)).toEqual(state);
  expect(owner.history({ ...scope, limit: 1000 })).toEqual(history);
  expect(owner.replay(scope)).toEqual({ state, acceptedOperations: state.revision });
  expect(owner.acknowledgeSource(selected)).toEqual(receipt);
  expect(owner.exportSnapshot({ ...scope, format: 'native-v1' }).sourceText).toBe(
    artifact.sourceText
  );
});

it('finds nested archived source preimages and preserves mapped identities and foreign revision actors after adoption', () => {
  const binding = receive();
  const originalArchive = owner.exportSnapshot({ ...scope, format: 'native-v1' });
  const target = { ...scope, inventoryId: 'adopted-original' };
  const importedTable = {
    ...table,
    materials: [{ key: 'sample', materialId: 'destination-material' }],
  };
  const importPreview = owner.previewImport({
    ...target,
    sourceText: originalArchive.sourceText,
    options: {
      bindings: [
        { sourceMaterialId: 'source-material', destinationMaterialId: 'destination-material' },
      ],
    },
  });
  if (importPreview.kind !== 'ready') throw new Error(JSON.stringify(importPreview));
  expect(
    owner.applyImport({
      ...target,
      kind: 'adopt-archive',
      operationId: 'adopt-original',
      expectedRevision: 0,
      sourceText: originalArchive.sourceText,
      options: importPreview.options,
      expectedPlanDigest: importPreview.planDigest,
    }).status
  ).toBe('committed');
  const preview = owner.previewSourceRevision(input([revised], choices(importedTable), target));
  expect(preview.rows[0].previousFields).toEqual(original);
  const selected = request('ack-nested-original', [revised], importedTable, target);
  const before = owner.inspect(target)!;
  expect(owner.acknowledgeSource(selected, undefined, { principal: agent }).status).toBe(
    'committed'
  );
  expect(physical(owner.inspect(target)!)).toEqual(physical(before));
  expect(owner.inspect(target)!.stocks[binding.stockId].materialId).toBe('destination-material');
  const artifact = owner.exportSnapshot({ ...target, format: 'native-v1' });
  const again = { ...scope, inventoryId: 'readopted-revision' };
  const importAgain = owner.previewImport({
    ...again,
    sourceText: artifact.sourceText,
    options: {
      bindings: [
        { sourceMaterialId: 'destination-material', destinationMaterialId: 'destination-material' },
      ],
    },
  });
  if (importAgain.kind !== 'ready') throw new Error(JSON.stringify(importAgain));
  expect(
    owner.applyImport({
      ...again,
      kind: 'adopt-archive',
      operationId: 'readopt',
      expectedRevision: 0,
      sourceText: artifact.sourceText,
      options: importAgain.options,
      expectedPlanDigest: importAgain.planDigest,
    }).status
  ).toBe('committed');
  const adopted = owner.inspect(again)!;
  expect(
    Object.values(adopted.tableBindings).find((row) => row.sourceId === '0007')!.sourceRevisions[0]
      .by.kind
  ).toBe('imported');
  expect(
    owner.previewTable({
      ...again,
      format: 'receive-v1',
      sourceText: text([revised]),
      options: importedTable,
    }).kind
  ).toBe('no-change');
  expect(owner.replay(again)).toEqual({ state: adopted, acceptedOperations: 1 });
  db.prepare("UPDATE lims_entity SET archived_at=1 WHERE id='destination-material'").run();
  const rollback = request('metadata-with-archived-science', [original], importedTable, again);
  expect(owner.acknowledgeSource(rollback).status).toBe('committed');
  expect(owner.inspect(again)!.stocks[binding.stockId]).toEqual(adopted.stocks[binding.stockId]);
});
