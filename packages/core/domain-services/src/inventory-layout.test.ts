import { describe, expect, it } from 'vitest';
import {
  applyInventoryCommandBatch,
  createInventoryState,
  inventoryCommandJsonSchema,
  inventoryStackItems,
  inventoryStoragePositions,
  inventoryWellId,
  parseInventoryCommand,
  parseInventoryState,
  type InventoryCommand,
  type InventoryLayout,
  type InventoryState,
} from './inventory';

function apply(state: InventoryState, commands: readonly InventoryCommand[]): InventoryState {
  const result = applyInventoryCommandBatch(state, { expectedRevision: state.revision, commands });
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  expect(parseInventoryState(JSON.parse(JSON.stringify(result.state)))).toEqual(result.state);
  return result.state;
}

function create(id: string, layout: InventoryLayout): InventoryCommand {
  return { kind: 'create-layout-storage', id, name: id, layout, placement: { kind: 'root' } };
}

function plate(id: string, rows = 1, columns = 2): InventoryCommand {
  return create(id, { kind: 'fixed-well', rows, columns });
}

function stack(id: string, capacity = 2): InventoryCommand {
  return create(id, { kind: 'stack', capacity, removal: 'top-only' });
}

function push(stackId: string, id: string): InventoryCommand {
  return { kind: 'push-stack', stackId, item: { kind: 'storage', id } };
}

function refused(state: InventoryState, commands: readonly InventoryCommand[], code: string): void {
  const before = JSON.stringify(state);
  expect(
    applyInventoryCommandBatch(state, { expectedRevision: state.revision, commands })
  ).toMatchObject({ ok: false, code });
  expect(JSON.stringify(state)).toBe(before);
}

describe('inventory layout positions', () => {
  it('resolves named and generated grid positions through one public function', () => {
    const state = apply(createInventoryState(), [
      create('cabinet', { kind: 'named', slots: ['upper-left', 'lower-right'] }),
      create('grid', { kind: 'grid', rows: 27, columns: 2 }),
    ]);
    expect(inventoryStoragePositions(state.storage.cabinet)).toEqual(['upper-left', 'lower-right']);
    const positions = inventoryStoragePositions(state.storage.grid);
    expect(positions.slice(0, 4)).toEqual(['A1', 'A2', 'B1', 'B2']);
    expect(positions.slice(-4)).toEqual(['Z1', 'Z2', 'AA1', 'AA2']);
  });

  it.each([
    { kind: 'grid', rows: 0, columns: 12 },
    { kind: 'grid', rows: 100, columns: 101 },
    { kind: 'fixed-well', rows: 8.5, columns: 12 },
    { kind: 'stack', capacity: 0, removal: 'top-only' },
    { kind: 'stack', capacity: 2, access: 'top-only' },
    { kind: 'stack', capacity: 2, removal: 'arbitrary' },
  ])('refuses unsupported or unbounded layout configuration: %s', (layout) => {
    expect(() =>
      parseInventoryCommand({
        kind: 'create-layout-storage',
        id: 'holder',
        name: 'Holder',
        layout,
        placement: { kind: 'root' },
      })
    ).toThrow();
  });

  it('allows removable tubes and refuses storage nodes in the same rack positions', () => {
    let state = apply(createInventoryState(), [
      create('rack', { kind: 'removable-tube', rows: 2, columns: 2 }),
      {
        kind: 'create-vessel',
        id: 'tube',
        name: 'Tube',
        placement: { kind: 'located', storageId: 'rack', slotId: 'A1' },
      },
      create('box', { kind: 'named', slots: [] }),
    ]);
    refused(
      state,
      [
        {
          kind: 'move-storage',
          id: 'box',
          placement: { kind: 'located', storageId: 'rack', slotId: 'A2' },
        },
      ],
      'INCOMPATIBLE_LAYOUT'
    );
    state = apply(state, [{ kind: 'move-vessel', id: 'tube', placement: { kind: 'unplaced' } }]);
    expect(state.vessels.tube.placement).toEqual({ kind: 'unplaced' });
    expect(Object.keys(state.vessels)).toEqual(['tube']);
  });
});

describe('permanent plate wells', () => {
  it('creates deterministic permanent wells and moves their plate without changing well or stock identity', () => {
    let state = apply(createInventoryState(), [
      create('freezer', { kind: 'named', slots: ['shelf-1'] }),
      plate('plate', 2, 3),
      {
        kind: 'receive-stock',
        id: 'stock',
        vesselId: inventoryWellId('plate', 'B2'),
        materialId: 'material',
        quantity: { kind: 'known', value: '10', unit: 'uL' },
        quality: 'usable',
      },
    ]);
    const wellId = inventoryWellId('plate', 'B2');
    const beforeWell = state.vessels[wellId];
    const beforeStock = state.stocks.stock;
    expect(Object.keys(state.vessels)).toEqual(
      ['A1', 'A2', 'A3', 'B1', 'B2', 'B3'].map((position) => inventoryWellId('plate', position))
    );
    state = apply(state, [
      {
        kind: 'move-storage',
        id: 'plate',
        placement: { kind: 'located', storageId: 'freezer', slotId: 'shelf-1' },
      },
    ]);
    expect(state.vessels[wellId]).toEqual(beforeWell);
    expect(state.stocks.stock).toEqual(beforeStock);
    expect(state.vessels[wellId].placement).toEqual({
      kind: 'located',
      storageId: 'plate',
      slotId: 'B2',
    });
  });

  it('refuses individual well relocation, disposal, or replacement', () => {
    const state = apply(createInventoryState(), [plate('plate')]);
    const wellId = inventoryWellId('plate', 'A1');
    refused(
      state,
      [{ kind: 'move-vessel', id: wellId, placement: { kind: 'unplaced' } }],
      'FIXED_WELL_IMMUTABLE'
    );
    refused(
      state,
      [{ kind: 'dispose-vessel', id: wellId, reason: 'Discard' }],
      'FIXED_WELL_IMMUTABLE'
    );
    refused(
      state,
      [
        {
          kind: 'create-vessel',
          id: 'intruder',
          name: 'Tube',
          placement: { kind: 'located', storageId: 'plate', slotId: 'A1' },
        },
      ],
      'FIXED_WELL_IMMUTABLE'
    );
  });

  it('rejects a permanent-well identity collision without leaving a partial plate', () => {
    const state = apply(createInventoryState(), [
      {
        kind: 'create-vessel',
        id: inventoryWellId('plate', 'A2'),
        name: 'Existing object',
        placement: { kind: 'unplaced' },
      },
    ]);
    refused(state, [plate('plate')], 'ID_ALREADY_EXISTS');
    expect(state.storage.plate).toBeUndefined();
    expect(state.vessels[inventoryWellId('plate', 'A1')]).toBeUndefined();
  });

  it('disposes a plate and all wells together, releases the plate position, and retains known contents', () => {
    let state = apply(createInventoryState(), [
      create('freezer', { kind: 'named', slots: ['shelf'] }),
      plate('plate'),
      {
        kind: 'move-storage',
        id: 'plate',
        placement: { kind: 'located', storageId: 'freezer', slotId: 'shelf' },
      },
      {
        kind: 'receive-stock',
        id: 'stock',
        vesselId: inventoryWellId('plate', 'A1'),
        materialId: 'material',
        quantity: { kind: 'known', value: '10', unit: 'uL' },
        quality: 'quarantined',
      },
    ]);
    state = apply(state, [{ kind: 'dispose-plate', id: 'plate', reason: 'Contaminated' }]);
    expect(state.storage.plate).toMatchObject({
      lifecycle: 'disposed',
      placement: { kind: 'root' },
    });
    for (const well of Object.values(state.vessels)) {
      expect(well.lifecycle).toBe('disposed');
      expect(well.placement.kind).toBe('located');
    }
    expect(state.stocks.stock.quantity).toEqual({ kind: 'known', value: '10', unit: 'uL' });
    refused(
      state,
      [{ kind: 'move-storage', id: 'plate', placement: { kind: 'root' } }],
      'STORAGE_DISPOSED'
    );
    refused(
      state,
      [{ kind: 'consume', stockId: 'stock', quantity: { value: '1', unit: 'uL' }, reason: 'PCR' }],
      'VESSEL_DISPOSED'
    );
    expect(
      apply(state, [
        {
          kind: 'create-vessel',
          id: 'replacement',
          name: 'Tube',
          placement: { kind: 'located', storageId: 'freezer', slotId: 'shelf' },
        },
      ]).vessels.replacement.lifecycle
    ).toBe('active');
  });

  it('can fill deterministic wells even when the owning plate uses the longest admitted identifier', () => {
    const id = 'p'.repeat(512);
    const state = apply(createInventoryState(), [
      plate(id, 1, 1),
      {
        kind: 'receive-stock',
        id: 'stock',
        vesselId: inventoryWellId(id, 'A1'),
        materialId: 'material',
        quantity: { kind: 'unknown' },
        quality: 'usable',
      },
    ]);
    expect(state.stocks.stock.vesselId).toBe(inventoryWellId(id, 'A1'));
  });
});

describe('ordered stack transitions', () => {
  it('derives bottom-to-top order solely from contiguous child placements', () => {
    let state = apply(createInventoryState(), [
      stack('stack'),
      plate('bottom'),
      plate('top'),
      push('stack', 'bottom'),
      push('stack', 'top'),
    ]);
    expect(inventoryStackItems(state, 'stack')).toEqual([
      { kind: 'storage', id: 'bottom' },
      { kind: 'storage', id: 'top' },
    ]);
    expect(state.storage.bottom.placement).toMatchObject({ slotId: '1' });
    expect(state.storage.top.placement).toMatchObject({ slotId: '2' });
    refused(
      state,
      [
        {
          kind: 'pop-stack',
          stackId: 'stack',
          item: { kind: 'storage', id: 'bottom' },
          destination: { kind: 'root' },
        },
      ],
      'STACK_TOP_REQUIRED'
    );
    refused(
      state,
      [{ kind: 'dispose-plate', id: 'bottom', reason: 'Discard' }],
      'STACK_TOP_REQUIRED'
    );
    refused(
      state,
      [{ kind: 'move-storage', id: 'top', placement: { kind: 'root' } }],
      'STACK_OPERATION_REQUIRED'
    );
    state = apply(state, [
      {
        kind: 'pop-stack',
        stackId: 'stack',
        item: { kind: 'storage', id: 'top' },
        destination: { kind: 'root' },
      },
    ]);
    expect(inventoryStackItems(state, 'stack')).toEqual([{ kind: 'storage', id: 'bottom' }]);
    expect(state.storage.top.placement).toEqual({ kind: 'root' });
  });

  it('refuses overflow and ordinary insertion without changing the source or stack', () => {
    const state = apply(createInventoryState(), [
      stack('stack', 1),
      plate('first'),
      plate('second'),
      push('stack', 'first'),
    ]);
    refused(state, [push('stack', 'second')], 'STACK_FULL');
    refused(
      state,
      [
        {
          kind: 'move-storage',
          id: 'second',
          placement: { kind: 'located', storageId: 'stack', slotId: '1' },
        },
      ],
      'STACK_OPERATION_REQUIRED'
    );
    expect(state.storage.second.placement).toEqual({ kind: 'root' });
  });

  it('moves a source top directly to another stack atomically and refuses an inaccessible source', () => {
    let state = apply(createInventoryState(), [
      stack('source'),
      stack('destination'),
      plate('bottom'),
      plate('top'),
      push('source', 'bottom'),
      push('source', 'top'),
    ]);
    refused(state, [push('destination', 'bottom')], 'STACK_TOP_REQUIRED');
    state = apply(state, [push('destination', 'top')]);
    expect(inventoryStackItems(state, 'source')).toEqual([{ kind: 'storage', id: 'bottom' }]);
    expect(inventoryStackItems(state, 'destination')).toEqual([{ kind: 'storage', id: 'top' }]);
    refused(
      state,
      [
        {
          kind: 'pop-stack',
          stackId: 'destination',
          item: { kind: 'storage', id: 'top' },
          destination: { kind: 'located', storageId: 'source', slotId: '2' },
        },
      ],
      'STACK_OPERATION_REQUIRED'
    );
  });

  it('retains stack order when retrieval has an occupied destination', () => {
    const state = apply(createInventoryState(), [
      stack('stack'),
      plate('plate'),
      create('shelf', { kind: 'named', slots: ['occupied'] }),
      {
        kind: 'create-vessel',
        id: 'tube',
        name: 'Tube',
        placement: { kind: 'located', storageId: 'shelf', slotId: 'occupied' },
      },
      push('stack', 'plate'),
    ]);
    refused(
      state,
      [
        {
          kind: 'pop-stack',
          stackId: 'stack',
          item: { kind: 'storage', id: 'plate' },
          destination: { kind: 'located', storageId: 'shelf', slotId: 'occupied' },
        },
      ],
      'SLOT_OCCUPIED'
    );
    expect(inventoryStackItems(state, 'stack')).toEqual([{ kind: 'storage', id: 'plate' }]);
  });

  it('refuses stack containment cycles and rolls back an earlier push in the same batch', () => {
    const state = apply(createInventoryState(), [stack('parent'), stack('child')]);
    refused(state, [push('parent', 'child'), push('child', 'parent')], 'CONTAINMENT_CYCLE');
    expect(inventoryStackItems(state, 'parent')).toEqual([]);
    expect(inventoryStackItems(state, 'child')).toEqual([]);
  });

  it('constrains retrieval order without claiming that quantity recording verifies physical access', () => {
    let state = apply(createInventoryState(), [
      stack('stack'),
      plate('bottom'),
      plate('top'),
      {
        kind: 'receive-stock',
        id: 'stock',
        vesselId: inventoryWellId('bottom', 'A1'),
        materialId: 'material',
        quantity: { kind: 'known', value: '2', unit: 'uL' },
        quality: 'usable',
      },
      push('stack', 'bottom'),
      push('stack', 'top'),
    ]);
    state = apply(state, [
      {
        kind: 'consume',
        stockId: 'stock',
        quantity: { value: '1', unit: 'uL' },
        reason: 'Record completed experiment',
      },
    ]);
    expect(state.stocks.stock.quantity).toEqual({ kind: 'known', value: '1', unit: 'uL' });
    refused(
      state,
      [
        {
          kind: 'pop-stack',
          stackId: 'stack',
          item: { kind: 'storage', id: 'bottom' },
          destination: { kind: 'root' },
        },
      ],
      'STACK_TOP_REQUIRED'
    );
  });
});

it('rejects corrupted gaps, detached permanent wells, and divergent plate lifecycle on readback', () => {
  const state = apply(createInventoryState(), [
    stack('stack'),
    plate('plate'),
    push('stack', 'plate'),
  ]);
  const gap = JSON.parse(JSON.stringify(state)) as InventoryState;
  Object.assign(gap.storage.plate, {
    placement: { kind: 'located', storageId: 'stack', slotId: '2' },
  });
  expect(() => parseInventoryState(gap)).toThrow();
  const missing = JSON.parse(JSON.stringify(state)) as InventoryState;
  Reflect.deleteProperty(missing.vessels, inventoryWellId('plate', 'A1'));
  expect(() => parseInventoryState(missing)).toThrow();
  const detached = JSON.parse(JSON.stringify(state)) as InventoryState;
  Object.assign(detached.vessels[inventoryWellId('plate', 'A1')], {
    placement: { kind: 'unplaced' },
  });
  expect(() => parseInventoryState(detached)).toThrow();
  const divergent = JSON.parse(JSON.stringify(state)) as InventoryState;
  Object.assign(divergent.vessels[inventoryWellId('plate', 'A1')], { lifecycle: 'disposed' });
  expect(() => parseInventoryState(divergent)).toThrow();
});

it('exports the same strict command variants used by the parser as machine-readable schema', () => {
  const schema = inventoryCommandJsonSchema();
  const variants = schema.oneOf as readonly {
    properties: { kind: { const: string } };
    required: readonly string[];
    additionalProperties: boolean;
  }[];
  expect(variants.map((variant) => variant.properties.kind.const)).toEqual([
    'create-lot',
    'receive-lot-stock',
    'associate-stock-lot',
    'set-vessel-limits',
    'transfer',
    'pool',
    'dilute',
    'create-storage',
    'create-layout-storage',
    'create-vessel',
    'receive-stock',
    'move-storage',
    'move-vessel',
    'consume',
    'reconcile',
    'set-quality',
    'dispose-vessel',
    'dispose-plate',
    'push-stack',
    'pop-stack',
  ]);
  for (const variant of variants) {
    expect(variant.additionalProperties).toBe(false);
    expect(variant.required).toContain('kind');
  }
  Reflect.deleteProperty(schema, 'oneOf');
  expect(inventoryCommandJsonSchema().oneOf).toBeDefined();
});
