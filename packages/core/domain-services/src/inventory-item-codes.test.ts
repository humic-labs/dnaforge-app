import { describe, expect, it } from 'vitest';
import {
  applyInventoryCommandBatch,
  createInventoryState,
  inventoryCurrentLocationPath,
  inventoryResolveItemCode,
  inventoryWellId,
  parseInventoryCommand,
  parseInventoryItemCodeQuery,
  parseInventoryState,
  type InventoryCommand,
  type InventoryPhysicalItem,
  type InventoryState,
} from './inventory';

const actor = {
  at: 10,
  principal: { kind: 'agent' as const, identityId: 'alice' },
  authority: { kind: 'local-profile' as const, profileKey: 'profile' },
};
const tube: InventoryPhysicalItem = { kind: 'vessel', id: 'tube' };
const empty: InventoryPhysicalItem = { kind: 'vessel', id: 'empty' };
function attach(
  id: string,
  value = '00123',
  namespace = 'lab:freezer-1',
  item = tube
): InventoryCommand {
  return {
    kind: 'attach-item-code',
    id,
    namespace,
    value,
    item,
    reason: 'Attach existing label identity',
  };
}
function retire(codeId: string): InventoryCommand {
  return { kind: 'retire-item-code', codeId, reason: 'Label no longer in service' };
}
function apply(state: InventoryState, ...commands: InventoryCommand[]): InventoryState {
  const result = applyInventoryCommandBatch(
    state,
    { expectedRevision: state.revision, commands },
    { ...actor, at: state.lastRecordedAt + 1 }
  );
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  expect(parseInventoryState(result.state)).toEqual(result.state);
  return result.state;
}
function refused(state: InventoryState, code: string, ...commands: InventoryCommand[]): void {
  const before = JSON.stringify(state);
  expect(
    applyInventoryCommandBatch(
      state,
      { expectedRevision: state.revision, commands },
      { ...actor, at: state.lastRecordedAt + 1 }
    )
  ).toMatchObject({ ok: false, code });
  expect(JSON.stringify(state)).toBe(before);
}
function fixture(): InventoryState {
  return apply(
    createInventoryState(),
    {
      kind: 'create-storage',
      id: 'freezer',
      name: 'Freezer',
      slots: ['A', 'B'],
      placement: { kind: 'root' },
    },
    {
      kind: 'create-vessel',
      id: 'tube',
      name: 'Tube',
      placement: { kind: 'located', storageId: 'freezer', slotId: 'A' },
    },
    {
      kind: 'create-vessel',
      id: 'empty',
      name: 'Empty',
      placement: { kind: 'located', storageId: 'freezer', slotId: 'B' },
    },
    {
      kind: 'receive-stock',
      id: 'stock',
      vesselId: 'tube',
      materialId: 'material',
      quantity: { kind: 'known', value: '100', unit: 'uL' },
      quality: 'usable',
    },
    {
      kind: 'reserve-quantity',
      id: 'hold',
      stockId: 'stock',
      quantity: { value: '40', unit: 'uL' },
      deadline: null,
      purpose: 'Preserved allocation',
    }
  );
}

describe('physical item code bindings', () => {
  it('binds storage and empty/stocked movable containers with trusted provenance only', () => {
    const before = fixture(),
      state = apply(
        before,
        attach('tube-code'),
        attach('empty-code', 'EMPTY', 'lab', empty),
        attach('freezer-code', 'FREEZER', 'lab', { kind: 'storage', id: 'freezer' })
      );
    expect(state.itemCodes['tube-code']).toEqual({
      id: 'tube-code',
      namespace: 'lab:freezer-1',
      value: '00123',
      item: tube,
      assignedAt: 2,
      assignedBy: actor.principal,
      reason: 'Attach existing label identity',
      lifecycle: { kind: 'active' },
    });
    expect(state.stocks).toEqual(before.stocks);
    expect(state.storage).toEqual(before.storage);
    expect(state.vessels).toEqual(before.vessels);
    expect(state.reservations).toEqual(before.reservations);
  });

  it('reserves exact tuples across active and retired history without reassignment or duplicate no-ops', () => {
    let state = apply(fixture(), attach('code'));
    refused(state, 'ITEM_CODE_ALREADY_ASSIGNED', attach('duplicate'));
    refused(state, 'ITEM_CODE_CONFLICT', attach('other-target', '00123', 'lab:freezer-1', empty));
    state = apply(state, retire('code'));
    refused(state, 'ITEM_CODE_ALREADY_ASSIGNED', attach('new-after-retirement'));
    refused(state, 'ITEM_CODE_CONFLICT', attach('reuse', '00123', 'lab:freezer-1', empty));
    refused(state, 'ITEM_CODE_RETIRED', retire('code'));
    expect(state.itemCodes.code.item).toEqual(tube);
    expect(state.itemCodes.code.lifecycle).toEqual({
      kind: 'retired',
      at: 3,
      by: actor.principal,
      reason: 'Label no longer in service',
    });
    expect(
      parseInventoryCommand({ kind: 'retire-item-code', codeId: 'code', reason: 'Retire' })
    ).toEqual({ kind: 'retire-item-code', codeId: 'code', reason: 'Retire' });
    expect(() =>
      parseInventoryCommand({ kind: 'restore-item-code', codeId: 'code', reason: 'Restore' })
    ).toThrow();
  });

  it('keeps case, leading zeros and surrounding spaces exact and never treats URLs as navigation', () => {
    let state = fixture();
    for (const [index, value] of [
      '00123',
      '123',
      'ABC',
      'abc',
      ' ABC ',
      'https://example.invalid/label',
    ].entries())
      state = apply(state, attach(`code-${index}`, value, 'lab'));
    for (const [index, value] of [
      '00123',
      '123',
      'ABC',
      'abc',
      ' ABC ',
      'https://example.invalid/label',
    ].entries())
      expect(inventoryResolveItemCode(state, { namespace: 'lab', value })).toMatchObject({
        kind: 'resolved',
        match: { id: `code-${index}`, value },
      });
    expect(inventoryResolveItemCode(state, { namespace: 'lab', value: 'Abc' })).toEqual({
      kind: 'not-found',
    });
    expect(parseInventoryItemCodeQuery({ namespace: null, value: ' ABC ' })).toEqual({
      namespace: null,
      value: ' ABC ',
    });
  });

  it('reports namespace ambiguity including retired bindings even when targets are identical', () => {
    const state = apply(
      fixture(),
      attach('a', '00123', 'a'),
      attach('b', '00123', 'b'),
      retire('a')
    );
    expect(inventoryResolveItemCode(state, { namespace: null, value: '00123' })).toMatchObject({
      kind: 'ambiguous',
      matches: [
        { id: 'a', lifecycle: { kind: 'retired' } },
        { id: 'b', lifecycle: { kind: 'active' } },
      ],
    });
    expect(inventoryResolveItemCode(state, { namespace: 'a', value: '00123' })).toMatchObject({
      kind: 'retired',
      match: { id: 'a' },
    });
    expect(inventoryResolveItemCode(state, { namespace: 'b', value: '00123' })).toMatchObject({
      kind: 'resolved',
      match: { id: 'b' },
    });
  });
});

it('rejects unsupported raw characters and boundaries without semantic framing or normalization', () => {
  const state = fixture();
  for (const value of [
    '',
    '   ',
    'ABC\n',
    'ABC\r',
    'ABC\r\n',
    'A\tB',
    'A\0B',
    'A\x7fB',
    'café',
    '🧪',
    'A'.repeat(513),
  ]) {
    expect(inventoryResolveItemCode(state, { namespace: 'lab', value })).toMatchObject({
      kind: 'invalid',
    });
    refused(state, 'INVALID_INVENTORY_INPUT', attach('invalid', value, 'lab'));
  }
  for (const namespace of ['', 'LAB', ' lab', 'lab ', 'lab\n', '1lab', 'é', 'a'.repeat(65)]) {
    expect(inventoryResolveItemCode(state, { namespace, value: 'ABC' })).toMatchObject({
      kind: 'invalid',
    });
    refused(state, 'INVALID_INVENTORY_INPUT', attach('invalid', 'ABC', namespace));
  }
  const accepted = apply(state, attach('maximum', 'X'.repeat(512), 'a'.repeat(64)));
  expect(
    inventoryResolveItemCode(accepted, { namespace: 'a'.repeat(64), value: 'X'.repeat(512) }).kind
  ).toBe('resolved');
  for (const query of [
    null,
    [],
    'ABC',
    {},
    { value: 'ABC' },
    { namespace: null, value: 123 },
    { namespace: null, value: 'ABC', materialId: 'material' },
  ])
    expect(inventoryResolveItemCode(state, query)).toMatchObject({ kind: 'invalid' });
});

it('never falls back to material search or changes state on lookup and returns detached bindings', () => {
  const state = apply(fixture(), attach('code')),
    before = JSON.stringify(state);
  expect(inventoryResolveItemCode(state, { namespace: null, value: 'material' })).toEqual({
    kind: 'not-found',
  });
  expect(
    inventoryResolveItemCode(createInventoryState(), { namespace: null, value: '00123' })
  ).toEqual({ kind: 'not-found' });
  const result = inventoryResolveItemCode(state, { namespace: null, value: '00123' });
  if (result.kind !== 'resolved') throw new Error('Fixture');
  (result.match.item as { id: string }).id = 'caller-edited';
  (result.match as { value: string }).value = 'caller-edited';
  expect(JSON.stringify(state)).toBe(before);
});

it('keeps codes identifiable after missing custody or disposal without changing material or holds', () => {
  const bound = apply(
    fixture(),
    attach('missing-code'),
    attach('disposed-code', 'EMPTY', 'lab', empty)
  );
  const state = apply(
    bound,
    { kind: 'report-item-missing', item: tube, reason: 'Truthful missing observation' },
    { kind: 'dispose-vessel', id: 'empty', reason: 'Disposed empty item' }
  );
  const before = JSON.stringify(state);
  expect(inventoryResolveItemCode(state, { namespace: 'lab:freezer-1', value: '00123' }).kind).toBe(
    'resolved'
  );
  expect(inventoryResolveItemCode(state, { namespace: 'lab', value: 'EMPTY' }).kind).toBe(
    'resolved'
  );
  expect(state.vessels.tube).toMatchObject({ custody: { kind: 'missing' } });
  expect(state.vessels.empty.lifecycle).toBe('disposed');
  expect(state.stocks).toEqual(bound.stocks);
  expect(state.reservations).toEqual(bound.reservations);
  expect(inventoryCurrentLocationPath(state, tube)).toBeNull();
  expect(inventoryCurrentLocationPath(state, empty)).toBeNull();
  expect(JSON.stringify(state)).toBe(before);
  refused(state, 'VESSEL_DISPOSED', attach('new-disposed', 'NEW', 'lab', empty));
});

it('uses one current-path owner while preserving immutable last-known location facts', () => {
  const state = fixture();
  expect(inventoryCurrentLocationPath(state, tube)).toEqual([
    { item: { kind: 'storage', id: 'freezer' }, name: 'Freezer', position: null },
    { item: tube, name: 'Tube', position: 'A' },
  ]);
  const checkedOut = apply(state, {
    kind: 'checkout-item',
    item: { kind: 'storage', id: 'freezer' },
    dueAt: null,
    reason: 'Checkout aggregate',
  });
  expect(inventoryCurrentLocationPath(checkedOut, tube)).toBeNull();
  expect(inventoryCurrentLocationPath(checkedOut, { kind: 'storage', id: 'freezer' })).toBeNull();
  const unplaced = apply(state, {
    kind: 'create-vessel',
    id: 'unplaced',
    name: 'Unplaced',
    placement: { kind: 'unplaced' },
  });
  expect(inventoryCurrentLocationPath(unplaced, { kind: 'vessel', id: 'unplaced' })).toBeNull();
});

it('rejects nonexistent and fixed-well targets while allowing their actual plate identity', () => {
  const state = apply(fixture(), {
    kind: 'create-layout-storage',
    id: 'plate',
    name: 'Plate',
    layout: { kind: 'fixed-well', rows: 1, columns: 1 },
    placement: { kind: 'root' },
  });
  refused(
    state,
    'VESSEL_NOT_FOUND',
    attach('absent', 'ABSENT', 'lab', { kind: 'vessel', id: 'missing' })
  );
  refused(
    state,
    'STORAGE_NOT_FOUND',
    attach('absent', 'ABSENT', 'lab', { kind: 'storage', id: 'tube' })
  );
  refused(
    state,
    'FIXED_WELL_IMMUTABLE',
    attach('well-code', 'WELL', 'lab', { kind: 'vessel', id: inventoryWellId('plate', 'A1') })
  );
  const bound = apply(
    state,
    attach('plate-code', 'PLATE', 'lab', { kind: 'storage', id: 'plate' })
  );
  const disposed = apply(bound, {
    kind: 'dispose-plate',
    id: 'plate',
    reason: 'Retire empty physical plate',
  });
  refused(
    disposed,
    'STORAGE_DISPOSED',
    attach('new-plate-code', 'NEW', 'lab', { kind: 'storage', id: 'plate' })
  );
  expect(inventoryResolveItemCode(disposed, { namespace: 'lab', value: 'PLATE' }).kind).toBe(
    'resolved'
  );
});

it('extends inventory identity uniqueness to stock, reservations and all physical creation', () => {
  const state = apply(fixture(), attach('code'));
  refused(state, 'ID_ALREADY_EXISTS', attach('stock', 'OTHER'));
  refused(state, 'ID_ALREADY_EXISTS', {
    kind: 'create-vessel',
    id: 'code',
    name: 'Collision',
    placement: { kind: 'unplaced' },
  });
  refused(state, 'ID_ALREADY_EXISTS', {
    kind: 'reserve-quantity',
    id: 'code',
    stockId: 'stock',
    quantity: { value: '1', unit: 'uL' },
    deadline: null,
    purpose: 'Collision',
  });
  refused(state, 'ID_ALREADY_EXISTS', {
    kind: 'transfer',
    sourceStockId: 'stock',
    quantity: { value: '5', unit: 'uL' },
    destination: { kind: 'new-stock', stockId: 'code', vesselId: 'empty' },
    reason: 'Collision',
  });
});

it('requires trusted context, immutable input fields and atomic batch refusal', () => {
  const state = fixture(),
    command = attach('code');
  expect(
    applyInventoryCommandBatch(state, { expectedRevision: state.revision, commands: [command] })
  ).toMatchObject({ ok: false, code: 'CONTEXT_REQUIRED' });
  expect(
    applyInventoryCommandBatch(
      state,
      { expectedRevision: state.revision, commands: [command] },
      { ...actor, at: 0 }
    )
  ).toMatchObject({ ok: false, code: 'CLOCK_REGRESSION' });
  expect(() =>
    parseInventoryCommand({ ...command, assignedAt: 1, assignedBy: actor.principal })
  ).toThrow();
  expect(() => parseInventoryCommand({ ...command, reason: '' })).toThrow();
  refused(
    state,
    'ITEM_CODE_CONFLICT',
    command,
    attach('conflict', '00123', 'lab:freezer-1', empty)
  );
  refused(state, 'ITEM_CODE_RETIRED', command, retire('code'), retire('code'));
  refused(state, 'ITEM_CODE_NOT_FOUND', retire('missing'));
});
