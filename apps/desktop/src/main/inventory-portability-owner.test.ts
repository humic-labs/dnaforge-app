// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { type InventoryCommand } from '@waypoint/domain-services';
import type { InventoryApplyImportRequest } from '../shared/inventory-command';

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
const source = { project: 'source-project', inventoryId: 'source-inventory' };
const target = { project: 'destination-project', inventoryId: 'destination-inventory' };
const agent = { kind: 'agent' as const, identityId: 'same-agent' };
const importOptions = {
  bindings: [
    { sourceMaterialId: 'source-material', destinationMaterialId: 'destination-material' },
  ],
};

function startOwner() {
  owner = createNativeInventoryOwner({
    db: () => db,
    projectAuthority: createRegisteredProjectAuthority({ db: () => db }),
    actor: () => 'native:portability-fixture',
    profileKey: 'a'.repeat(64),
    now: () => now,
  });
  owner.initialize();
}
function sourceCommit(operationId: string, commands: readonly InventoryCommand[]) {
  const result = owner.execute(
    {
      ...source,
      operationId,
      expectedRevision: owner.inspect(source)?.revision ?? 0,
      commands,
    },
    undefined,
    { principal: agent }
  );
  expect(result).toMatchObject({ status: 'committed' });
  return result;
}
function sourceFixture(extraHistory = 0) {
  sourceCommit('receive', [
    { kind: 'create-vessel', id: 'tube', name: 'Source tube', placement: { kind: 'unplaced' } },
    {
      kind: 'receive-stock',
      id: 'stock',
      vesselId: 'tube',
      materialId: 'source-material',
      quantity: { kind: 'known', value: '100', unit: 'uL' },
      quality: 'usable',
    },
    {
      kind: 'attach-item-code',
      id: 'physical-code',
      namespace: 'source',
      value: ' 0012 ',
      item: { kind: 'vessel', id: 'tube' },
      reason: 'Synthetic exact alias',
    },
  ]);
  sourceCommit('hold-and-custody', [
    {
      kind: 'reserve-quantity',
      id: 'hold',
      stockId: 'stock',
      quantity: { value: '30', unit: 'uL' },
      deadline: null,
      purpose: 'Synthetic foreign responsibility',
    },
    {
      kind: 'checkout-item',
      item: { kind: 'vessel', id: 'tube' },
      dueAt: null,
      reason: 'Synthetic source custody',
    },
  ]);
  for (let i = 0; i < extraHistory; i++)
    sourceCommit(`observed-quality-${i}`, [
      {
        kind: 'set-quality',
        stockId: 'stock',
        quality: i % 2 ? 'usable' : 'quarantined',
        reason: 'Synthetic accepted history beyond one page',
      },
    ]);
  return owner.exportSnapshot({ ...source, format: 'native-v1' });
}
function readyRequest(sourceText: string, operationId = 'adopt'): InventoryApplyImportRequest {
  const preview = owner.previewImport({ ...target, sourceText, options: importOptions });
  expect(preview.kind).toBe('ready');
  if (preview.kind !== 'ready') throw new Error(JSON.stringify(preview));
  return {
    kind: 'adopt-archive',
    ...target,
    operationId,
    expectedRevision: 0,
    sourceText,
    options: preview.options,
    expectedPlanDigest: preview.planDigest,
  };
}
const raw = () => ({
  state: db.prepare('SELECT * FROM inventory_state ORDER BY inventory_id').all(),
  journal: db.prepare('SELECT * FROM inventory_journal ORDER BY inventory_id,revision').all(),
  changes: db.prepare('SELECT total_changes() AS count').get(),
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dnaforge-inventory-portability-'));
  dbPath = join(root, 'inventory.sqlite');
  db = openFileTestDb(dbPath);
  ensureSchema(db, dbPath);
  for (const [id, projectId, materialId] of [
    [41, source.project, 'source-material'],
    [42, target.project, 'destination-material'],
  ] as const) {
    const path = join(root, projectId);
    mkdirSync(path);
    db.prepare(
      'INSERT INTO workspaces(id,name,path,repo_uuid,access_mode,created_at) VALUES(?,?,?,?,?,1)'
    ).run(id, projectId, path, projectId, 'writable');
    if (id === 41) rememberOriginalDefaultProject(db, id);
    if (id === 41) {
      db.prepare(
        "INSERT INTO lims_schema(id,kind,name,display_name,fields,current_revision_id,created_at,updated_at) VALUES('schema','entity','fixture','Fixture','{}','schema-v1',1,1)"
      ).run();
      db.prepare(
        "INSERT INTO lims_schema_revision(id,schema_id,version,fields,created_at) VALUES('schema-v1','schema',1,'{}',1)"
      ).run();
    }
    db.prepare(
      "INSERT INTO lims_entity(id,kind,schema_id,schema_revision_id,name,fields,workspace_id,registration_status,created_at,updated_at) VALUES(?,'record','schema','schema-v1',?,'{}',?,'registered',1,1)"
    ).run(materialId, materialId, id);
    db.prepare(
      "INSERT INTO catalog_entities(id,type,name,locator,storage_type,status,created_at,updated_at) VALUES(?,'record',?,?,'database','active',1,1)"
    ).run(materialId, materialId, `entity://lims/${materialId}`);
    db.prepare(
      "INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,file_kind,status,created_at,updated_at) VALUES(?,?,?,?,'record','current',1,1)"
    ).run(`${materialId}-file`, materialId, id, join(path, 'material.forge.json'));
  }
  now = 1_700_000_000_000;
  startOwner();
});
afterEach(() => {
  if (db.open) db.close();
  rmSync(root, { recursive: true, force: true });
});

it('exports one exact raw snapshot and complete history beyond public pagination without writes', () => {
  const artifact = sourceFixture(101);
  const original = raw();
  const changed = vi.fn();
  owner.subscribe(changed);
  const repeated = owner.exportSnapshot({ ...source, format: 'native-v1' });
  expect(repeated).toEqual(artifact);
  const file = JSON.parse(artifact.sourceText);
  expect(file.content.history).toHaveLength(103);
  expect(file.content.state.json).toBe(
    (original.state as { inventory_id: string; state_json: string }[]).find(
      (row) => row.inventory_id === source.inventoryId
    )!.state_json
  );
  expect(
    file.content.history.map((row: { requestJson: string; receiptJson: string }) => [
      row.requestJson,
      row.receiptJson,
    ])
  ).toEqual(
    (original.journal as { inventory_id: string; request_json: string; receipt_json: string }[])
      .filter((row) => row.inventory_id === source.inventoryId)
      .map((row) => [row.request_json, row.receipt_json])
  );
  expect(artifact.sourceText).not.toContain(root);
  expect(raw()).toEqual(original);
  expect(changed).not.toHaveBeenCalled();
  expect(() =>
    withAgentProjectScope({ kind: 'project-roots', roots: [] }, () =>
      owner.exportSnapshot({ ...source, format: 'native-v1' })
    )
  ).toThrow('PROJECT_ACCESS_DENIED');
});

it('previews without writes, preserves read-only authority and rejects corrupt source and stale bindings', () => {
  const artifact = sourceFixture();
  const before = raw();
  db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=42").run();
  const readOnly = raw();
  const preview = owner.previewImport(
    { ...target, sourceText: artifact.sourceText, options: importOptions },
    { principal: agent }
  );
  expect(preview).toMatchObject({ kind: 'ready', principal: agent, sourceHistoryEntries: 2 });
  expect(raw()).toEqual(readOnly);
  expect(owner.inspect(target)).toBeNull();
  expect(() => owner.applyImport(readyRequest(artifact.sourceText))).toThrow(
    'PROJECT_ACCESS_DENIED'
  );
  const malformed = artifact.sourceText.replace('"schema":', '"schema":"duplicate","schema":');
  expect(
    owner.previewImport({ ...target, sourceText: malformed, options: importOptions })
  ).toMatchObject({ kind: 'blocked', source: null });
  expect(raw()).toEqual(readOnly);
  db.prepare("UPDATE workspaces SET access_mode='writable' WHERE id=42").run();
  const request = readyRequest(artifact.sourceText);
  db.prepare(
    "UPDATE lims_entity SET name='Changed accepted material' WHERE id='destination-material'"
  ).run();
  const stale = raw();
  expect(owner.applyImport(request)).toMatchObject({
    status: 'rejected',
    code: 'INVENTORY_IMPORT_PLAN_CHANGED',
  });
  expect(raw()).toEqual(stale);
  expect(before.state).toEqual(stale.state);
});

it('adopts once through the existing journal, keeps same-ID source agents foreign and replays after reopen', () => {
  const artifact = sourceFixture();
  const sourceBefore = owner.inspect(source);
  const request = readyRequest(artifact.sourceText);
  const events: unknown[] = [];
  owner.subscribe((event) => events.push(event));
  const receipt = owner.applyImport(request, undefined, { principal: agent });
  expect(receipt).toMatchObject({ status: 'committed', revision: 1 });
  const imported = owner.inspect(target)!;
  expect(imported.origin).toMatchObject({ kind: 'archive-adoption', by: agent });
  expect(imported.stocks.stock).toMatchObject({
    materialId: 'destination-material',
    quantity: { kind: 'known', value: '100', unit: 'uL' },
  });
  expect(imported.itemCodes['physical-code'].value).toBe(' 0012 ');
  expect(imported.reservations.hold.holder).toMatchObject({ kind: 'imported', principal: agent });
  expect(imported.vessels.tube.custody).toMatchObject({
    kind: 'checked-out',
    holder: { kind: 'imported', principal: agent },
  });
  const rejected = owner.execute(
    {
      ...target,
      operationId: 'steal-hold',
      expectedRevision: 1,
      commands: [
        {
          kind: 'release-reservation',
          reservationId: 'hold',
          reason: 'Same agent ID is not imported ownership',
        },
      ],
    },
    undefined,
    { principal: agent }
  );
  expect(rejected).toMatchObject({ status: 'rejected', code: 'RESERVATION_NOT_OWNED' });
  expect(owner.inspect(target)).toEqual(imported);
  expect(owner.history(target)).toHaveLength(1);
  expect(owner.history(target)[0].request).toEqual(request);
  expect(owner.replay(target)).toEqual({ state: imported, acceptedOperations: 1 });
  expect(
    owner.execute({
      ...target,
      operationId: 'observe-quality',
      expectedRevision: 1,
      commands: [
        {
          kind: 'set-quality',
          stockId: 'stock',
          quality: 'quarantined',
          reason: 'Truthful destination observation',
        },
      ],
    })
  ).toMatchObject({ status: 'committed', revision: 2 });
  const final = owner.inspect(target);
  const history = owner.history(target);
  expect(owner.applyImport(request)).toEqual(receipt);
  expect(
    owner.applyImport({ ...request, operationId: 'duplicate-adoption', expectedRevision: 2 })
  ).toMatchObject({ status: 'rejected' });
  expect(owner.applyImport({ ...request, sourceText: artifact.sourceText + '\n' })).toMatchObject({
    status: 'rejected',
    code: 'INVENTORY_OPERATION_CONFLICT',
  });
  expect(owner.inspect(source)).toEqual(sourceBefore);
  const reexported = owner.exportSnapshot({ ...target, format: 'native-v1' });
  const retainedRequest = JSON.parse(
    JSON.parse(reexported.sourceText).content.history[0].requestJson
  );
  expect(retainedRequest.sourceText).toBe(artifact.sourceText);
  expect(events).toHaveLength(2);
  db.close();
  db = openFileTestDb(dbPath);
  startOwner();
  expect(owner.inspect(target)).toEqual(final);
  expect(owner.history(target)).toEqual(history);
  expect(owner.replay(target)).toEqual({ state: final, acceptedOperations: 2 });
  expect(owner.applyImport(request)).toEqual(receipt);
});

it('never imports a future recorded clock or writes on source/plan refusal', () => {
  const artifact = sourceFixture();
  now -= 1_000;
  const before = raw();
  const preview = owner.previewImport({
    ...target,
    sourceText: artifact.sourceText,
    options: importOptions,
  });
  expect(preview).toMatchObject({ kind: 'blocked' });
  expect(
    preview.kind === 'blocked' && preview.issues.some((issue) => issue.code.includes('CLOCK'))
  ).toBe(true);
  expect(raw()).toEqual(before);
  expect(owner.inspect(target)).toBeNull();
});
