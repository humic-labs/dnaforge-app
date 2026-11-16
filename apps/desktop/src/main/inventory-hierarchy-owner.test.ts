// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  inventoryStackItems,
  inventoryWellId,
  type InventoryHierarchyChoices,
} from '@waypoint/domain-services';
import type { InventoryApplyHierarchyRequest } from '../shared/inventory-command';
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
const scope = { project: 'hierarchy-project', inventoryId: 'hierarchy-inventory' };
const agent = { kind: 'agent' as const, identityId: 'hierarchy-agent' };
const columns = [
  'source_id',
  'name',
  'layout_kind',
  'positions',
  'rows',
  'columns',
  'capacity',
  'parent_kind',
  'parent_key',
  'slot',
];
const rows = [
  ['plate-top', 'Top plate', 'fixed-well', '', '1', '2', '', 'source', 'stack', '2'],
  ['box', 'Tube box', 'removable-tube', '', '2', '2', '', 'source', 'shelf', 'Box'],
  ['plate-bottom', 'Bottom plate', 'fixed-well', '', '1', '2', '', 'source', 'stack', '1'],
  ['stack', 'Plate stack', 'stack', '', '', '', '2', 'source', 'shelf', 'Stack'],
  ['shelf', 'Shelf', 'named', '["Box","Stack"]', '', '', '', 'source', 'freezer', 'S1'],
  ['freezer', 'Custom freezer', 'named', '["S1","S2"]', '', '', '', 'root', '', ''],
];
const text = (records = rows) =>
  '\uFEFF' +
  [columns, ...records]
    .map((row) => row.map((value) => `"${value.replaceAll('"', '""')}"`).join(','))
    .join('\r\n') +
  '\r\n';
const choices: InventoryHierarchyChoices = {
  namespace: 'Synthetic physical source',
  delimiter: ',',
  parents: [],
  skips: [],
};
const input = (sourceText = text(), options = choices) => ({
  ...scope,
  format: 'hierarchy-v1',
  sourceText,
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
    actor: () => 'native:hierarchy-fixture',
    profileKey: 'a'.repeat(64),
    now: () => 1_700_000_000_000,
  });
  owner.initialize();
}
function request(
  operationId = 'import-once',
  sourceText = text(),
  options = choices
): InventoryApplyHierarchyRequest {
  const preview = owner.previewHierarchy(input(sourceText, options), { principal: agent });
  expect(preview.kind).toBe('ready');
  if (preview.kind !== 'ready') throw new Error(JSON.stringify(preview));
  return {
    ...scope,
    kind: 'import-hierarchy',
    operationId,
    expectedRevision: preview.target.revision,
    sourceText,
    options: preview.options,
    expectedPlanDigest: preview.planDigest,
  };
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dnaforge-inventory-hierarchy-'));
  dbPath = join(root, 'inventory.sqlite');
  db = openFileTestDb(dbPath);
  ensureSchema(db, dbPath);
  const project = join(root, 'project');
  mkdirSync(project);
  db.prepare(
    'INSERT INTO workspaces(id,name,path,repo_uuid,access_mode,created_at) VALUES(41,?,?,?,?,1)'
  ).run('Hierarchy', project, scope.project, 'writable');
  rememberOriginalDefaultProject(db, 41);
  startOwner();
});
afterEach(() => {
  if (db.open) db.close();
  rmSync(root, { recursive: true, force: true });
});

it('previews without writes and imports shuffled parents, wells and explicit stack ordinals in one durable operation', () => {
  const before = raw();
  const preview = owner.previewHierarchy(input(), { principal: agent });
  expect(preview.kind).toBe('ready');
  expect(raw()).toEqual(before);
  expect(owner.inspect(scope)).toBeNull();
  const accepted = request();
  const receipt = owner.applyHierarchy(accepted, undefined, { principal: agent });
  expect(receipt).toMatchObject({
    status: 'committed',
    revision: 1,
    context: { principal: agent },
  });
  const state = owner.inspect(scope)!;
  const bindings = Object.values(state.hierarchyBindings);
  expect(bindings).toHaveLength(6);
  const id = (sourceId: string) => bindings.find((value) => value.sourceId === sourceId)!.storageId;
  expect(inventoryStackItems(state, id('stack')).map((item) => item.id)).toEqual([
    id('plate-bottom'),
    id('plate-top'),
  ]);
  expect(state.vessels[inventoryWellId(id('plate-bottom'), 'A1')]).toMatchObject({
    kind: 'fixed-well',
  });
  expect(state.vessels[inventoryWellId(id('plate-top'), 'A2')]).toMatchObject({
    kind: 'fixed-well',
  });
  expect(owner.history(scope)).toHaveLength(1);
  expect(owner.applyHierarchy(accepted)).toEqual(receipt);
  expect(
    owner.applyHierarchy({ ...accepted, sourceText: accepted.sourceText + '\n' })
  ).toMatchObject({ status: 'rejected', code: 'INVENTORY_OPERATION_CONFLICT' });
  expect(owner.previewHierarchy(input(text([...rows].reverse()))).kind).toBe('no-change');
  expect(
    owner.execute({
      ...scope,
      operationId: 'move-later',
      expectedRevision: 1,
      commands: [{ kind: 'move-storage', id: id('box'), placement: { kind: 'root' } }],
    })
  ).toMatchObject({ status: 'committed' });
  const afterMove = owner.inspect(scope)!;
  expect(owner.previewHierarchy(input()).kind).toBe('no-change');
  expect(
    owner.previewHierarchy(
      input(
        text(
          rows.map((row) =>
            row[0] === 'box' ? [...row.slice(0, 1), 'Changed box', ...row.slice(2)] : row
          )
        )
      )
    ).kind
  ).toBe('blocked');
  expect(owner.inspect(scope)).toEqual(afterMove);
  db.close();
  db = openFileTestDb(dbPath);
  startOwner();
  expect(owner.inspect(scope)).toEqual(afterMove);
  expect(owner.replay(scope)).toEqual({ state: afterMove, acceptedOperations: 2 });
  expect(owner.applyHierarchy(accepted)).toEqual(receipt);
  const artifact = owner.exportSnapshot({ ...scope, format: 'native-v1' });
  const target = { ...scope, inventoryId: 'adopted' };
  const plan = owner.previewImport({
    ...target,
    sourceText: artifact.sourceText,
    options: { bindings: [] },
  });
  expect(plan.kind).toBe('ready');
  if (plan.kind !== 'ready') throw new Error(JSON.stringify(plan));
  expect(
    owner.applyImport({
      ...target,
      kind: 'adopt-archive',
      operationId: 'adopt-hierarchy',
      expectedRevision: 0,
      sourceText: artifact.sourceText,
      options: plan.options,
      expectedPlanDigest: plan.planDigest,
    })
  ).toMatchObject({ status: 'committed' });
  const adopted = owner.inspect(target)!;
  expect(adopted.hierarchyBindings).toEqual(afterMove.hierarchyBindings);
  expect(owner.previewHierarchy({ ...input(), ...target }).kind).toBe('no-change');
  expect(owner.replay(target)).toEqual({ state: adopted, acceptedOperations: 1 });
});

it('refuses stale, invalid and oversized proposals without partially creating physical records', () => {
  const accepted = request();
  expect(
    owner.execute({
      ...scope,
      operationId: 'unrelated',
      expectedRevision: 0,
      commands: [
        {
          kind: 'create-storage',
          id: 'existing',
          name: 'Existing',
          slots: ['A'],
          placement: { kind: 'root' },
        },
      ],
    })
  ).toMatchObject({ status: 'committed' });
  const before = raw();
  expect(owner.applyHierarchy(accepted)).toMatchObject({
    status: 'rejected',
    code: 'REVISION_CONFLICT',
  });
  expect(raw()).toEqual(before);
  const duplicate = text([
    ['first', 'First', 'named', '["A"]', '', '', '', 'existing', 'external', 'A'],
    ['last', 'Last', 'named', '["A"]', '', '', '', 'existing', 'external', 'A'],
  ]);
  expect(
    owner.previewHierarchy(
      input(duplicate, { ...choices, parents: [{ key: 'external', storageId: 'existing' }] })
    ).kind
  ).toBe('blocked');
  expect(raw()).toEqual(before);
  const cycle = text([
    ['a', 'A', 'named', '["A"]', '', '', '', 'source', 'b', 'A'],
    ['b', 'B', 'named', '["A"]', '', '', '', 'source', 'a', 'A'],
  ]);
  expect(owner.previewHierarchy(input(cycle)).kind).toBe('blocked');
  expect(raw()).toEqual(before);
  const fresh = request('fresh');
  expect(
    owner.applyHierarchy({
      ...fresh,
      sourceText: fresh.sourceText + ' '.repeat(NATIVE_DOCUMENT_MAX_BODY_BYTES),
    })
  ).toMatchObject({ status: 'rejected', code: 'INVENTORY_HIERARCHY_TOO_LARGE' });
  expect(raw()).toEqual(before);
});

it('keeps preview read-only and enforces present project authority before acceptance', () => {
  const accepted = request();
  db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=41").run();
  const before = raw();
  expect(owner.previewHierarchy(input()).kind).toBe('ready');
  expect(raw()).toEqual(before);
  expect(() => owner.applyHierarchy(accepted)).toThrow(/PROJECT_ACCESS_DENIED/);
  expect(raw()).toEqual(before);
  db.prepare("UPDATE workspaces SET access_mode='writable' WHERE id=41").run();
  expect(() =>
    withAgentProjectScope({ kind: 'project-roots', roots: [join(root, 'foreign')] }, () =>
      owner.previewHierarchy(input())
    )
  ).toThrow();
  const beforeOwnerChange = raw();
  expect(() =>
    owner.applyHierarchy(accepted, () => {
      throw new Error('OWNER_CHANGED');
    })
  ).toThrow('OWNER_CHANGED');
  expect(raw()).toEqual(beforeOwnerChange);
});
