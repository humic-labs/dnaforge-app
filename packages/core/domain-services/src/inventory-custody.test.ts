import { describe, expect, it } from 'vitest';
import {
  applyInventoryCommandBatch,
  createInventoryState,
  inventoryAvailability,
  inventoryEffectiveCustody,
  inventoryStackItems,
  inventoryWellId,
  parseInventoryCommandBatch,
  parseInventoryState,
  type InventoryCommand,
  type InventoryExecutionContext,
  type InventoryPhysicalItem,
  type InventoryPrincipal,
  type InventoryState,
} from './inventory';
const alice: InventoryPrincipal = { kind: 'agent', identityId: 'alice' };
const bob: InventoryPrincipal = { kind: 'agent', identityId: 'bob' };
const profile: InventoryPrincipal = { kind: 'local-profile', profileKey: 'profile' };
const context = (principal: InventoryPrincipal = alice, at = 10): InventoryExecutionContext => ({
  at,
  principal,
  authority: { kind: 'local-profile', profileKey: 'profile' },
});
const volume = (value: string) => ({ value, unit: 'uL' as const });
const tube: InventoryPhysicalItem = { kind: 'vessel', id: 'a' };
const box: InventoryPhysicalItem = { kind: 'storage', id: 'box' };
function apply(
  state: InventoryState,
  commands: InventoryCommand[],
  actor = context()
): InventoryState {
  const result = applyInventoryCommandBatch(
    state,
    { expectedRevision: state.revision, commands },
    actor
  );
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  expect(parseInventoryState(result.state)).toEqual(result.state);
  return result.state;
}
function fixture(): InventoryState {
  return apply(createInventoryState(), [
    {
      kind: 'create-storage',
      id: 'freezer',
      name: 'Freezer',
      slots: ['shelf'],
      placement: { kind: 'root' },
    },
    {
      kind: 'create-storage',
      id: 'box',
      name: 'Box',
      slots: ['A', 'B', 'C'],
      placement: { kind: 'located', storageId: 'freezer', slotId: 'shelf' },
    },
    ...['a', 'b', 'c', 'd'].map((id) => ({
      kind: 'create-vessel' as const,
      id,
      name: `Tube ${id}`,
      placement:
        id === 'a' || id === 'b'
          ? { kind: 'located' as const, storageId: 'box', slotId: id === 'a' ? 'A' : 'B' }
          : { kind: 'unplaced' as const },
    })),
    ...['a', 'b'].map((id) => ({
      kind: 'receive-stock' as const,
      id: `stock-${id}`,
      vesselId: id,
      materialId: 'dna',
      quantity: { kind: 'known' as const, ...volume('100') },
      quality: 'usable' as const,
    })),
  ]);
}
const checkout = (item = tube, dueAt: number | null = null): InventoryCommand => ({
  kind: 'checkout-item',
  item,
  dueAt,
  reason: 'Working experiment',
});
const missing = (item = tube): InventoryCommand => ({
  kind: 'report-item-missing',
  item,
  reason: 'Observed absent',
});
const consume = (value = '1'): InventoryCommand => ({
  kind: 'consume',
  stockId: 'stock-a',
  quantity: volume(value),
  reason: 'Experiment',
});
function refuses(
  state: InventoryState,
  commands: InventoryCommand[],
  code: string,
  actor = context()
): void {
  const bytes = JSON.stringify(state);
  expect(
    applyInventoryCommandBatch(state, { expectedRevision: state.revision, commands }, actor)
  ).toMatchObject({ ok: false, code });
  expect(JSON.stringify(state)).toBe(bytes);
}

describe('custody and physical access', () => {
  it('detaches checkout, snapshots location and keeps overdue owned use available', () => {
    const state = apply(fixture(), [checkout(tube, 20)]);
    expect(state.vessels.a.placement).toEqual({ kind: 'unplaced' });
    expect(inventoryEffectiveCustody(state, tube).state).toMatchObject({
      kind: 'checked-out',
      holder: alice,
      reason: 'Working experiment',
      at: 10,
      dueAt: 20,
      lastKnown: {
        observedAt: 10,
        placement: { kind: 'located', storageId: 'box', slotId: 'A' },
        path: [
          { name: 'Freezer' },
          { name: 'Box', position: 'shelf' },
          { name: 'Tube a', position: 'A' },
        ],
        relativePath: [],
        relativeAt: null,
      },
    });
    expect(inventoryAvailability(state, alice, 20).items.a).toMatchObject({
      overdue: true,
      actions: { return: true },
      blockers: [],
    });
    expect(apply(state, [consume()], context(alice, 20)).stocks['stock-a'].quantity).toMatchObject({
      value: '99',
    });
    refuses(state, [consume()], 'ITEM_CHECKED_OUT', context(bob));
    refuses(state, [consume()], 'ITEM_CHECKED_OUT', context(profile));
    expect(
      apply(state, [
        {
          kind: 'move-vessel',
          id: 'c',
          placement: { kind: 'located', storageId: 'box', slotId: 'A' },
        },
      ]).vessels.c.placement
    ).toMatchObject({ slotId: 'A' });
  });
  it('revalidates return occupancy and permits explicit profile recovery', () => {
    const state = apply(fixture(), [
      checkout(),
      {
        kind: 'move-vessel',
        id: 'c',
        placement: { kind: 'located', storageId: 'box', slotId: 'A' },
      },
    ]);
    const returning: InventoryCommand = {
      kind: 'return-item',
      item: tube,
      destination: { kind: 'located', storageId: 'box', slotId: 'A' },
      reason: 'Return',
    };
    refuses(state, [returning], 'CUSTODY_NOT_OWNED', context(bob));
    refuses(state, [returning], 'SLOT_OCCUPIED');
    const after = apply(
      state,
      [{ ...returning, destination: { kind: 'located', storageId: 'box', slotId: 'C' } }],
      context(profile)
    );
    expect(inventoryEffectiveCustody(after, tube).state.kind).toBe('available');
  });
  it('uses transit destination as a plan and blocks physical debit and credit', () => {
    const state = apply(fixture(), [
      {
        kind: 'start-item-transit',
        item: tube,
        destination: { kind: 'located', storageId: 'box', slotId: 'B' },
        reason: 'Ship',
      },
    ]);
    refuses(state, [consume()], 'ITEM_IN_TRANSIT');
    refuses(
      state,
      [
        {
          kind: 'transfer',
          sourceStockId: 'stock-b',
          quantity: volume('1'),
          destination: { kind: 'existing-stock', stockId: 'stock-a' },
          reason: 'Credit',
        },
      ],
      'ITEM_IN_TRANSIT'
    );
    refuses(
      state,
      [
        {
          kind: 'return-item',
          item: tube,
          destination: { kind: 'located', storageId: 'box', slotId: 'B' },
          reason: 'Arrive',
        },
      ],
      'SLOT_OCCUPIED'
    );
    expect(
      apply(state, [
        {
          kind: 'return-item',
          item: tube,
          destination: { kind: 'located', storageId: 'box', slotId: 'A' },
          reason: 'Arrive',
        },
      ]).vessels.a.placement
    ).toMatchObject({ slotId: 'A' });
  });
  it('keeps original observation and holder through transit, foreign missing report and explicit locate', () => {
    const checked = apply(fixture(), [checkout()]);
    const prior = inventoryEffectiveCustody(checked, tube).state;
    if (prior.kind !== 'checked-out') throw new Error('Expected checkout');
    const shipped = apply(
      checked,
      [
        {
          kind: 'start-item-transit',
          item: tube,
          destination: { kind: 'unplaced' },
          reason: 'Ship',
        },
      ],
      context(alice, 20)
    );
    const state = apply(shipped, [missing()], context(bob, 30));
    expect(inventoryEffectiveCustody(state, tube).state).toMatchObject({
      kind: 'missing',
      holder: alice,
      reportedBy: bob,
      at: 30,
      lastKnown: prior.lastKnown,
    });
    refuses(state, [consume()], 'ITEM_MISSING', context(alice, 30));
    const located = apply(
      state,
      [
        {
          kind: 'locate-item',
          item: tube,
          destination: { kind: 'located', storageId: 'box', slotId: 'A' },
          reason: 'Found',
        },
      ],
      context(bob, 40)
    );
    expect(inventoryEffectiveCustody(located, tube).state.kind).toBe('available');
    expect(inventoryEffectiveCustody(state, tube).state).toMatchObject({
      holder: alice,
      reportedBy: bob,
    });
  });
  it('keeps historical names and path facts immutable when ancestors change', () => {
    const state = apply(fixture(), [checkout()]);
    const before = inventoryEffectiveCustody(state, tube).state;
    const renamed = JSON.parse(JSON.stringify(state)) as InventoryState;
    Object.assign(renamed.storage.freezer, { name: 'New freezer name' });
    Object.assign(renamed.storage.box, { name: 'Moved box', placement: { kind: 'root' } });
    expect(inventoryEffectiveCustody(parseInventoryState(renamed), tube).state).toEqual(before);
  });
});

describe('aggregate custody and reservations', () => {
  it('requires explicit child splits and retains root history plus relative membership', () => {
    const state = apply(fixture(), [checkout(box)]);
    expect(inventoryAvailability(state, alice, 10).items.a).toMatchObject({
      root: box,
      inherited: true,
      lastKnown: {
        path: [{ name: 'Freezer' }, { name: 'Box' }],
        relativePath: [{ name: 'Tube a', position: 'A' }],
        relativeAt: null,
      },
    });
    refuses(
      state,
      [{ kind: 'move-vessel', id: 'a', placement: { kind: 'unplaced' } }],
      'CUSTODY_TRANSITION_REQUIRED'
    );
    const unrelated = apply(
      state,
      [
        {
          kind: 'create-vessel',
          id: 'unrelated',
          name: 'Unrelated tube',
          placement: { kind: 'unplaced' },
        },
      ],
      context(alice, 15)
    );
    expect(inventoryAvailability(unrelated, alice, 15).items.a.lastKnown).toEqual(
      inventoryAvailability(state, alice, 10).items.a.lastKnown
    );
    const split = apply(state, [checkout(tube)], context(alice, 20));
    expect(inventoryEffectiveCustody(split, tube)).toMatchObject({
      root: tube,
      inherited: false,
      state: {
        lastKnown: {
          observedAt: 10,
          relativeAt: 20,
          relativePath: [{ item: tube, position: 'A' }],
        },
      },
    });
  });
  it('preserves foreign allocations on missing truth and prevents recovery into a conflicting booking', () => {
    let state = apply(fixture(), [
      {
        kind: 'reserve-quantity',
        id: 'hold',
        stockId: 'stock-a',
        quantity: volume('40'),
        deadline: null,
        purpose: 'Alice experiment',
      },
    ]);
    refuses(state, [checkout(box)], 'RESERVATION_CONFLICT', context(bob));
    expect(inventoryAvailability(state, bob, 10).items.box.actions.checkout).toBe(false);
    expect(apply(state, [consume('60')], context(bob)).stocks['stock-a'].quantity).toMatchObject({
      value: '40',
    });
    state = apply(
      state,
      [
        {
          kind: 'create-storage',
          id: 'booked',
          name: 'Booked',
          slots: ['A'],
          placement: { kind: 'root' },
        },
        {
          kind: 'reserve-item',
          id: 'booking',
          item: { kind: 'storage', id: 'booked' },
          deadline: null,
          purpose: 'Bob use',
        },
        missing(),
      ],
      context(bob)
    );
    refuses(
      state,
      [
        {
          kind: 'locate-item',
          item: tube,
          destination: { kind: 'located', storageId: 'booked', slotId: 'A' },
          reason: 'Found',
        },
      ],
      'RESERVATION_CONFLICT',
      context(bob)
    );
    expect(state.reservations.hold.lifecycle.kind).toBe('active');
    expect(
      apply(
        state,
        [
          {
            kind: 'reconcile',
            stockId: 'stock-a',
            quantity: { kind: 'known', ...volume('20') },
            reason: 'Measurement',
          },
        ],
        context(bob)
      ).stocks['stock-a'].quantity
    ).toMatchObject({ value: '20' });
  });
  it('moves plate custody as one aggregate while permanent wells only inherit', () => {
    const plate = { kind: 'storage' as const, id: 'plate' };
    const well = { kind: 'vessel' as const, id: inventoryWellId('plate', 'A1') };
    const state = apply(fixture(), [
      {
        kind: 'create-layout-storage',
        id: 'plate',
        name: 'Plate',
        layout: { kind: 'fixed-well', rows: 1, columns: 2 },
        placement: { kind: 'root' },
      },
    ]);
    refuses(state, [checkout(well)], 'FIXED_WELL_IMMUTABLE');
    const checked = apply(state, [checkout(plate)]);
    expect(checked.vessels[well.id]).not.toHaveProperty('custody');
    expect(inventoryEffectiveCustody(checked, well)).toMatchObject({
      root: plate,
      inherited: true,
    });
  });
});

it('compacts missing middle ordinals while physical checkout remains top-only', () => {
  let state = apply(fixture(), [
    {
      kind: 'create-layout-storage',
      id: 'stack',
      name: 'Stack',
      layout: { kind: 'stack', capacity: 3, removal: 'top-only' },
      placement: { kind: 'root' },
    },
  ]);
  for (const id of ['a', 'b', 'c'])
    state = apply(state, [{ kind: 'push-stack', stackId: 'stack', item: { kind: 'vessel', id } }]);
  refuses(state, [checkout()], 'STACK_TOP_REQUIRED');
  expect(inventoryAvailability(state, alice, 10).items.a.actions.checkout).toBe(false);
  expect(inventoryAvailability(state, alice, 10).stocks['stock-a'].blockers).toEqual([]);
  const absent = apply(state, [missing({ kind: 'vessel', id: 'b' })]);
  expect(inventoryStackItems(absent, 'stack').map((item) => item.id)).toEqual(['a', 'c']);
  expect(absent.vessels.c.placement).toMatchObject({ slotId: '2' });
  expect(inventoryEffectiveCustody(absent, { kind: 'vessel', id: 'b' }).state).toMatchObject({
    lastKnown: { placement: { slotId: '2' } },
  });
  const top = apply(absent, [checkout({ kind: 'vessel', id: 'c' }), checkout()]);
  expect(inventoryStackItems(top, 'stack')).toEqual([]);
  const returned = apply(top, [
    {
      kind: 'return-item',
      item: tube,
      destination: { kind: 'stack-top', stackId: 'stack' },
      reason: 'Return',
    },
  ]);
  expect(inventoryStackItems(returned, 'stack')).toEqual([tube]);
});
it('returns an inherited child to the same stack top after removing its old ordinal', () => {
  let state = apply(fixture(), [
    {
      kind: 'create-layout-storage',
      id: 'stack',
      name: 'Stack',
      layout: { kind: 'stack', capacity: 2, removal: 'top-only' },
      placement: { kind: 'root' },
    },
  ]);
  for (const id of ['a', 'b'])
    state = apply(state, [{ kind: 'push-stack', stackId: 'stack', item: { kind: 'vessel', id } }]);
  state = apply(state, [checkout({ kind: 'storage', id: 'stack' })]);
  const returned = apply(state, [
    {
      kind: 'return-item',
      item: tube,
      destination: { kind: 'stack-top', stackId: 'stack' },
      reason: 'Reposition observed tube',
    },
  ]);
  expect(inventoryStackItems(returned, 'stack').map((item) => item.id)).toEqual(['b', 'a']);
});
it('upcasts frozen v5 request and snapshot facts without changing clock, revision or holds', () => {
  const snapshot =
    '{"schema":"dnaforge.inventory.v5","revision":2,"lastRecordedAt":10,"storage":{},"vessels":{"a":{"kind":"movable","id":"a","name":"A","placement":{"kind":"unplaced"},"lifecycle":"active","limits":{"capacity":{"kind":"unknown"},"deadVolume":{"kind":"unknown"}}}},"stocks":{"stock":{"id":"stock","vesselId":"a","source":{"kind":"unattributed","rootStockId":"stock"},"materialId":"dna","quantity":{"kind":"known","value":"100","unit":"uL"},"quality":"usable","composition":{"kind":"unknown"}}},"lots":{},"reservations":{"hold":{"id":"hold","holder":{"kind":"agent","identityId":"alice"},"purpose":"Experiment","createdAt":10,"deadline":null,"lifecycle":{"kind":"active"},"kind":"quantity","stockId":"stock","quantity":{"value":"40","unit":"uL"},"remaining":{"value":"40","unit":"uL"}}}}';
  const request =
    '{"expectedRevision":1,"commands":[{"kind":"reserve-quantity","id":"hold","stockId":"stock","quantity":{"value":"40","unit":"uL"},"deadline":null,"purpose":"Experiment"}]}';
  expect(JSON.stringify(parseInventoryCommandBatch(JSON.parse(request)))).toBe(request);
  const raw = JSON.parse(snapshot);
  const state = parseInventoryState(raw);
  expect(JSON.stringify(raw)).toBe(snapshot);
  expect(state.revision).toBe(2);
  expect(state.lastRecordedAt).toBe(10);
  expect(state.reservations).toEqual(raw.reservations);
  expect(inventoryEffectiveCustody(state, tube).state).toEqual({ kind: 'available' });
  expect(parseInventoryState(JSON.parse(JSON.stringify(state)))).toEqual(state);
});
