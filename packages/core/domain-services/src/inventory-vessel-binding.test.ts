import { describe, expect, it } from 'vitest';
import {
  adoptInventoryState,
  applyInventoryCommandBatch,
  createInventoryArchive,
  createInventoryState,
  inventoryImportPreview,
  inventoryTableBindingKey,
  inventoryTableSha256,
  inventoryWellId,
  parseInventoryArchive,
  parseInventoryState,
  type InventoryArchiveRuntime,
  type InventoryCommand,
  type InventoryState,
  type InventoryVesselBinding,
} from './inventory';

const context = {
  at: 1000,
  principal: { kind: 'agent' as const, identityId: 'synthetic-vessel-importer' },
  authority: { kind: 'local-profile' as const, profileKey: 'a'.repeat(64) },
};
const namespace = 'benchling:synthetic:vessels';
const hash = inventoryTableSha256('synthetic physical source projection');
const key = (sourceId: string, sourceNamespace = namespace) =>
  inventoryTableBindingKey(sourceNamespace, sourceId);
const movable = (sourceId = 'con_tube'): InventoryVesselBinding => ({
  namespace,
  sourceId,
  rowSha256: hash,
  vesselId: 'tube',
  origin: { kind: 'movable', placement: { kind: 'located', storageId: 'shelf', slotId: 'A' } },
});
const permanent = (position = 'A1'): InventoryVesselBinding => ({
  namespace,
  sourceId: 'con_well',
  rowSha256: hash,
  vesselId: inventoryWellId('plate', position),
  origin: { kind: 'fixed-well', storageId: 'plate', position },
});
function apply(state: InventoryState, commands: readonly InventoryCommand[]): InventoryState {
  const result = applyInventoryCommandBatch(
    state,
    { expectedRevision: state.revision, commands },
    { ...context, at: Math.max(context.at, state.lastRecordedAt + 1) }
  );
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return parseInventoryState(result.state);
}
function fixture(): InventoryState {
  return apply(createInventoryState(), [
    {
      kind: 'create-storage',
      id: 'shelf',
      name: 'Shelf',
      slots: ['A', 'B'],
      placement: { kind: 'root' },
    },
    {
      kind: 'create-vessel',
      id: 'tube',
      name: 'Empty tube',
      placement: { kind: 'located', storageId: 'shelf', slotId: 'A' },
    },
    {
      kind: 'create-layout-storage',
      id: 'plate',
      name: 'Permanent plate',
      layout: { kind: 'fixed-well', rows: 1, columns: 2 },
      placement: { kind: 'root' },
    },
    {
      kind: 'create-layout-storage',
      id: 'matrix',
      name: 'Removable plate',
      layout: { kind: 'removable-tube', rows: 1, columns: 2 },
      placement: { kind: 'root' },
    },
  ]);
}
function bind(
  state = fixture(),
  bindings: readonly InventoryVesselBinding[] = [movable(), permanent()]
): InventoryState {
  return parseInventoryState({
    ...state,
    vesselBindings: Object.fromEntries(
      bindings.map((binding) => [key(binding.sourceId, binding.namespace), binding])
    ),
  });
}

describe('lifetime vessel source identity', () => {
  it('represents empty movable vessels and permanent wells without creating stock', () => {
    const state = bind();
    expect(state.schema).toBe('dnaforge.inventory.v17');
    expect(state.vesselBindings[key('con_tube')]).toEqual(movable());
    expect(state.vesselBindings[key('con_well')]).toEqual(permanent());
    expect(Object.keys(state.stocks)).toEqual([]);
    expect(parseInventoryState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it('receives zero stock later into the already bound vessel without replacing its identity', () => {
    const state = bind();
    const received = apply(state, [
      {
        kind: 'receive-stock',
        id: 'stock',
        vesselId: 'tube',
        materialId: 'material',
        quantity: { kind: 'known', value: '0', unit: 'uL' },
        quality: 'usable',
      },
    ]);
    expect(received.vesselBindings).toEqual(state.vesselBindings);
    expect(Object.keys(received.vessels)).toEqual(Object.keys(state.vessels));
    expect(received.stocks.stock).toMatchObject({
      vesselId: 'tube',
      quantity: { kind: 'known', value: '0', unit: 'uL' },
    });
  });

  it('keeps the original physical source after a move, label retirement and disposal', () => {
    const state = bind();
    const moved = apply(state, [
      {
        kind: 'move-vessel',
        id: 'tube',
        placement: { kind: 'located', storageId: 'shelf', slotId: 'B' },
      },
      {
        kind: 'attach-item-code',
        id: 'label',
        namespace: 'synthetic',
        value: '0001',
        item: { kind: 'vessel', id: 'tube' },
        reason: 'Physical label',
      },
    ]);
    const disposed = apply(moved, [
      { kind: 'retire-item-code', codeId: 'label', reason: 'Replace unreadable label' },
      { kind: 'dispose-vessel', id: 'tube', reason: 'Empty tube discarded' },
      { kind: 'dispose-plate', id: 'plate', reason: 'Unused plate discarded' },
    ]);
    expect(disposed.vesselBindings).toEqual(state.vesselBindings);
    expect(disposed.vessels.tube.lifecycle).toBe('disposed');
    expect(disposed.storage.plate.lifecycle).toBe('disposed');
    expect(disposed.itemCodes.label.lifecycle.kind).toBe('retired');
    expect(state.vessels.tube.placement).toMatchObject({ slotId: 'A' });
    expect(moved.vessels.tube.placement).toMatchObject({ slotId: 'B' });
    expect(parseInventoryState(JSON.parse(JSON.stringify(disposed)))).toEqual(disposed);
  });

  it('preserves source correlation after an atomic command refusal', () => {
    const state = bind();
    const before = JSON.stringify(state);
    expect(
      applyInventoryCommandBatch(
        state,
        {
          expectedRevision: state.revision,
          commands: [
            { kind: 'move-vessel', id: 'tube', placement: { kind: 'unplaced' } },
            {
              kind: 'receive-stock',
              id: 'bad-stock',
              vesselId: 'unknown',
              materialId: 'material',
              quantity: { kind: 'unknown' },
              quality: 'usable',
            },
          ],
        },
        context
      )
    ).toMatchObject({ ok: false, code: 'VESSEL_NOT_FOUND' });
    expect(JSON.stringify(state)).toBe(before);
  });

  it('requires the current binding map and its exact source tuple key', () => {
    const state = bind();
    const { vesselBindings: _bindings, ...missing } = state;
    expect(() => parseInventoryState(missing)).toThrow();
    expect(() => parseInventoryState({ ...state, vesselBindings: { forged: movable() } })).toThrow(
      'exact source namespace'
    );
  });

  it('refuses another source identity for the same vessel even in a different namespace', () => {
    for (const other of [movable('other-container'), { ...movable(), namespace: 'other-system' }])
      expect(() => bind(fixture(), [movable(), other])).toThrow('distinct vessel');
    expect(() =>
      bind(fixture(), [permanent(), { ...permanent(), sourceId: 'other-well' }])
    ).toThrow('distinct vessel');
  });

  it.each([
    { ...movable(), vesselId: 'unknown' },
    { ...movable(), vesselId: inventoryWellId('plate', 'A1') },
    { ...permanent(), vesselId: 'tube' },
  ])('requires the existing vessel and original kind in %j', (binding) => {
    expect(() => bind(fixture(), [binding])).toThrow('existing vessel of its original kind');
  });

  it.each([
    { kind: 'movable', placement: { kind: 'located', storageId: 'unknown', slotId: 'A' } },
    { kind: 'movable', placement: { kind: 'located', storageId: 'shelf', slotId: 'unknown' } },
    { kind: 'movable', placement: { kind: 'located', storageId: 'plate', slotId: 'A1' } },
  ])('validates the saved movable origin without comparing current placement: %j', (origin) => {
    expect(() => bind(fixture(), [{ ...movable(), origin } as InventoryVesselBinding])).toThrow();
  });

  it.each([
    { kind: 'fixed-well', storageId: 'unknown', position: 'A1' },
    { kind: 'fixed-well', storageId: 'matrix', position: 'A1' },
    { kind: 'fixed-well', storageId: 'plate', position: 'A2' },
    { kind: 'fixed-well', storageId: 'plate', position: 'A01' },
    { kind: 'fixed-well', storageId: 'plate', position: 'B1' },
  ])('requires permanent plate identity and exact position: %j', (origin) => {
    expect(() => bind(fixture(), [{ ...permanent(), origin } as InventoryVesselBinding])).toThrow(
      'original plate and exact position'
    );
  });

  it.each([
    { ...movable(), rowSha256: 'sha256:wrong' },
    { ...movable(), namespace: '\0namespace' },
    { ...movable(), sourceId: '' },
    { ...movable(), origin: { kind: 'movable' } },
    { ...movable(), unused: 'field' },
  ])('refuses malformed or extra source binding facts: %j', (binding) => {
    expect(() => bind(fixture(), [binding as InventoryVesselBinding])).toThrow();
  });
});

describe('vessel source schema compatibility', () => {
  it('upcasts actual v16 shape while preserving hierarchy, stock source bindings and source bytes', () => {
    let state = apply(bind(), [
      {
        kind: 'receive-stock',
        id: 'stock',
        vesselId: 'tube',
        materialId: 'material',
        quantity: { kind: 'unknown' },
        quality: 'usable',
      },
    ]);
    state = parseInventoryState({
      ...state,
      hierarchyBindings: {
        [key('plt_fixed')]: {
          namespace,
          sourceId: 'plt_fixed',
          rowSha256: hash,
          storageId: 'plate',
          destination: { kind: 'root' },
        },
      },
      tableBindings: {
        [key('stock-source')]: {
          namespace,
          sourceId: 'stock-source',
          rowSha256: hash,
          stockId: 'stock',
          vesselId: 'tube',
          materialId: 'material',
          destination: { kind: 'existing-vessel' },
          sourceRevisions: [],
        },
      },
    });
    const { vesselBindings: _bindings, ...previous } = state;
    const raw = {
      ...previous,
      schema: 'dnaforge.inventory.v16',
      vessels: Object.fromEntries(
        Object.entries(previous.vessels).map(
          ([id, { contentsKnowledge: _knowledge, ...vessel }]) => [id, vessel]
        )
      ),
    };
    const before = JSON.stringify(raw);
    const upcast = parseInventoryState(raw);
    expect(upcast.vesselBindings).toEqual({});
    expect(upcast.hierarchyBindings).toEqual(state.hierarchyBindings);
    expect(upcast.tableBindings).toEqual(state.tableBindings);
    expect(upcast.stocks).toEqual(state.stocks);
    expect(upcast.revision).toBe(state.revision);
    expect(JSON.stringify(raw)).toBe(before);
  });

  it('retains all original physical IDs and baselines when adopting empty source vessels', () => {
    const state = bind();
    const result = adoptInventoryState(
      null,
      state,
      {
        source: {
          archiveSha256: hash,
          projectId: 'source-project',
          inventoryId: 'source-inventory',
          revision: state.revision,
        },
        materialBindings: {},
      },
      { ...context, at: 2000 }
    );
    if (!result.ok) throw new Error(result.message);
    expect(result.state.vesselBindings).toEqual(state.vesselBindings);
    expect(Object.keys(result.state.vessels)).toEqual(Object.keys(state.vessels));
    expect(Object.keys(result.state.stocks)).toEqual([]);
    expect(parseInventoryState(JSON.parse(JSON.stringify(result.state)))).toEqual(result.state);
  });

  it('retains the map through the generic archive format and reports its import record IDs', () => {
    const state = bind();
    const runtime: InventoryArchiveRuntime = {
      maxBytes: 17 * 1024 * 1024,
      sha256: inventoryTableSha256,
      replayJournal: () => state,
    };
    const artifact = createInventoryArchive(
      {
        projectId: 'source-project',
        inventoryId: 'source-inventory',
        state: { revision: state.revision, json: JSON.stringify(state) },
        history: [
          {
            operationId: 'fixture-operation',
            revision: 1,
            requestJson: '{"fixture":"source binding owner"}',
            receiptJson: '{"fixture":"accepted source binding"}',
          },
        ],
      },
      runtime
    );
    const archive = parseInventoryArchive(artifact.sourceText, runtime);
    expect(archive.state?.vesselBindings).toEqual(state.vesselBindings);
    const preview = inventoryImportPreview(
      archive,
      {
        target: {
          projectId: 'destination',
          inventoryId: 'destination',
          present: false,
          revision: 0,
        },
        options: { bindings: [] },
        bindings: [],
        asOf: 2000,
      },
      runtime
    );
    expect(preview.kind).toBe('ready');
    expect(preview.records.find((group) => group.kind === 'vesselBindings')).toEqual({
      kind: 'vesselBindings',
      ids: Object.keys(state.vesselBindings).sort(),
    });
  });
});
