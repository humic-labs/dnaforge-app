import { describe, expect, it } from 'vitest';
import {
  applyInventoryCommandBatch,
  createInventoryState,
  inventoryAvailability,
  inventoryWellId,
  parseInventoryCommand,
  parseInventoryState,
  type InventoryCommand,
  type InventoryExecutionContext,
  type InventoryPrincipal,
  type InventoryState,
  type InventoryWithdrawalCommand,
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

function apply(
  state: InventoryState,
  commands: readonly InventoryCommand[],
  actor: InventoryExecutionContext = context()
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
      id: 'box',
      name: 'Box',
      slots: ['A', 'B', 'C'],
      placement: { kind: 'root' },
    },
    ...['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({
      kind: 'create-vessel' as const,
      id,
      name: id,
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
function reserve(
  id = 'hold',
  stockId = 'stock-a',
  value = '40',
  deadline: number | null = null
): InventoryCommand {
  return {
    kind: 'reserve-quantity',
    id,
    stockId,
    quantity: volume(value),
    deadline,
    purpose: 'Planned experiment',
  };
}
function item(
  id = 'booking',
  target: { kind: 'storage' | 'vessel'; id: string } = { kind: 'storage', id: 'box' },
  deadline: number | null = null
): InventoryCommand {
  return { kind: 'reserve-item', id, item: target, deadline, purpose: 'Planned item use' };
}
function consume(value: string, stockId = 'stock-a'): InventoryWithdrawalCommand {
  return { kind: 'consume', stockId, quantity: volume(value), reason: 'Experiment' };
}
function fulfill(
  withdrawal: InventoryWithdrawalCommand,
  claims = [{ reservationId: 'hold', quantity: volume('40') }]
): InventoryCommand {
  return { kind: 'fulfill-reservations', claims, withdrawal };
}
function refuses(
  state: InventoryState,
  commands: readonly InventoryCommand[],
  code: string,
  actor: InventoryExecutionContext = context()
): void {
  const before = JSON.stringify(state);
  expect(
    applyInventoryCommandBatch(state, { expectedRevision: state.revision, commands }, actor)
  ).toMatchObject({ ok: false, code });
  expect(JSON.stringify(state)).toBe(before);
}
function transfer(value = '40'): InventoryWithdrawalCommand {
  return {
    kind: 'transfer',
    sourceStockId: 'stock-a',
    quantity: volume(value),
    destination: { kind: 'new-stock', stockId: 'aliquot', vesselId: 'c' },
    reason: 'Prepare aliquot',
  };
}
function derived(kind: 'pool' | 'dilute'): InventoryWithdrawalCommand {
  const common = {
    lotId: 'derived-lot',
    stockId: 'derived',
    vesselId: 'c',
    materialId: 'dna',
    name: 'Derived stock',
    reason: 'Prepare',
    mixing: 'homogeneous' as const,
  };
  const a = { stockId: 'stock-a', quantity: volume('40') };
  const b = { stockId: 'stock-b', quantity: volume('10') };
  return kind === 'pool'
    ? { kind, ...common, inputs: [a, b] }
    : { kind, ...common, sample: a, diluent: b };
}

describe('exact quantity allocations', () => {
  it('holds quantity without debiting on-hand and derives owner-specific availability', () => {
    const state = apply(fixture(), [reserve()]);
    const availability = inventoryAvailability(state, alice, 10);
    expect(availability.stocks['stock-a']).toMatchObject({
      onHand: { kind: 'known', ...volume('100') },
      held: volume('40'),
      unreserved: { kind: 'known', ...volume('60') },
      mine: volume('40'),
      blockers: [],
      reservationIds: ['hold'],
    });
    expect(inventoryAvailability(state, bob, 10).stocks['stock-a'].mine).toEqual(volume('0'));
    expect(availability.reservations.hold).toMatchObject({
      mine: true,
      overdue: false,
      actions: { release: true, cancel: false, expire: false, fulfill: true },
    });
    expect(state.stocks['stock-a'].quantity).toEqual({ kind: 'known', ...volume('100') });
    refuses(state, [consume('61')], 'QUANTITY_RESERVED');
    expect(apply(state, [consume('60')]).stocks['stock-a'].quantity).toEqual({
      kind: 'known',
      ...volume('40'),
    });
  });
  it('protects known dead volume and competing allocations exactly across unit scales', () => {
    let state = apply(fixture(), [
      {
        kind: 'set-vessel-limits',
        vesselId: 'a',
        limits: {
          capacity: { kind: 'known', ...volume('100') },
          deadVolume: { kind: 'known', ...volume('10') },
        },
        reason: 'Tube specification',
      },
      reserve('first', 'stock-a', '40'),
    ]);
    state = apply(
      state,
      [
        {
          kind: 'reserve-quantity',
          id: 'second',
          stockId: 'stock-a',
          quantity: { value: '0.05', unit: 'mL' },
          deadline: null,
          purpose: 'Second experiment',
        },
      ],
      context(bob)
    );
    expect(inventoryAvailability(state, alice, 10).stocks['stock-a']).toMatchObject({
      held: volume('90'),
      unreserved: { kind: 'known', ...volume('0') },
      mine: volume('40'),
      deadVolume: { kind: 'known', ...volume('10') },
    });
    refuses(state, [reserve('third', 'stock-a', '0.001')], 'QUANTITY_RESERVED');
    refuses(state, [consume('0.001')], 'QUANTITY_RESERVED');
  });
  it('serializes finite competing holder requests against an independent integer budget', () => {
    for (const amounts of [
      [30, 40, 50],
      [99, 1, 1],
      [60, 60, 40],
      [25, 25, 25, 25, 1],
    ]) {
      let state = fixture();
      let held = 0;
      for (const [index, amount] of amounts.entries()) {
        const result = applyInventoryCommandBatch(
          state,
          {
            expectedRevision: state.revision,
            commands: [reserve(`r-${index}`, 'stock-a', String(amount))],
          },
          context(index % 2 === 0 ? alice : bob)
        );
        expect(result.ok).toBe(held + amount <= 100);
        if (result.ok) {
          state = result.state;
          held += amount;
        }
        expect(inventoryAvailability(state, alice, 10).stocks['stock-a'].held).toEqual(
          volume(String(held))
        );
      }
    }
  });
  it('keeps truthful reconciliation and holds when measured quantity reveals a shortfall', () => {
    const state = apply(fixture(), [
      reserve(),
      {
        kind: 'reconcile',
        stockId: 'stock-a',
        quantity: { kind: 'known', ...volume('20') },
        reason: 'Measured loss',
      },
    ]);
    expect(state.reservations.hold.lifecycle.kind).toBe('active');
    expect(inventoryAvailability(state, alice, 10).stocks['stock-a']).toMatchObject({
      held: volume('40'),
      unreserved: { kind: 'known', ...volume('0') },
      blockers: [{ code: 'ALLOCATION_SHORTFALL' }],
    });
    refuses(state, [consume('1')], 'ALLOCATION_SHORTFALL');
    refuses(
      state,
      [fulfill(consume('1'), [{ reservationId: 'hold', quantity: volume('1') }])],
      'ALLOCATION_SHORTFALL'
    );
    const released = apply(state, [
      { kind: 'release-reservation', reservationId: 'hold', reason: 'Adjust experiment' },
    ]);
    expect(apply(released, [consume('20')]).stocks['stock-a'].quantity).toMatchObject({
      value: '0',
    });
    expect(inventoryAvailability(released, alice, 10).stocks['stock-a'].reservationIds).toEqual([
      'hold',
    ]);
  });
  it('refuses unknown, quarantined and zero quantities without inventing an allocation', () => {
    const unknown = apply(fixture(), [
      {
        kind: 'reconcile',
        stockId: 'stock-a',
        quantity: { kind: 'unknown' },
        reason: 'Needs measurement',
      },
    ]);
    refuses(unknown, [reserve()], 'QUANTITY_UNKNOWN');
    const quarantined = apply(fixture(), [
      { kind: 'set-quality', stockId: 'stock-a', quality: 'quarantined', reason: 'QC' },
    ]);
    refuses(quarantined, [reserve()], 'STOCK_QUARANTINED');
    refuses(fixture(), [reserve('zero', 'stock-a', '0')], 'INVALID_QUANTITY');
  });
  it('keeps holds through quarantine and owner disposal while refusing another holder disposal', () => {
    const state = apply(fixture(), [reserve()]);
    refuses(
      state,
      [{ kind: 'dispose-vessel', id: 'a', reason: 'Discard' }],
      'ITEM_RESERVED',
      context(bob)
    );
    const quarantined = apply(state, [
      { kind: 'set-quality', stockId: 'stock-a', quality: 'quarantined', reason: 'QC' },
    ]);
    expect(quarantined.reservations.hold).toEqual(state.reservations.hold);
    refuses(quarantined, [fulfill(consume('40'))], 'STOCK_QUARANTINED');
    const disposed = apply(state, [{ kind: 'dispose-vessel', id: 'a', reason: 'Discard' }]);
    expect(disposed.reservations.hold).toEqual(state.reservations.hold);
    expect(inventoryAvailability(disposed, alice, 10).reservations.hold.actions).toMatchObject({
      release: true,
      fulfill: false,
    });
  });
});

describe('trusted clock and reservation lifecycle', () => {
  it('requires trusted context for new commands and preserves legacy replay floor zero', () => {
    const legacy = applyInventoryCommandBatch(createInventoryState(), {
      expectedRevision: 0,
      commands: [
        { kind: 'create-vessel', id: 'legacy', name: 'Legacy', placement: { kind: 'unplaced' } },
      ],
    });
    expect(legacy.ok && legacy.state.lastRecordedAt).toBe(0);
    const state = fixture();
    for (const command of [
      reserve(),
      item(),
      { kind: 'release-reservation', reservationId: 'x', reason: 'Release' },
      { kind: 'cancel-reservation', reservationId: 'x', reason: 'Cancel' },
      { kind: 'expire-reservations', ids: ['x'] },
      fulfill(consume('1')),
    ] as InventoryCommand[])
      expect(
        applyInventoryCommandBatch(state, { expectedRevision: state.revision, commands: [command] })
      ).toMatchObject({ ok: false, code: 'CONTEXT_REQUIRED' });
  });
  it('advances contextual acceptance monotonically and rolls back clock movement on refusal', () => {
    const state = apply(fixture(), [reserve()], context(alice, 100));
    expect(state.lastRecordedAt).toBe(100);
    refuses(state, [consume('1')], 'CLOCK_REGRESSION', context(alice, 99));
    expect(apply(state, [consume('1')], context(alice, 100)).lastRecordedAt).toBe(100);
    refuses(state, [consume('1000')], 'QUANTITY_RESERVED', context(alice, 200));
    expect(state.lastRecordedAt).toBe(100);
    expect(() => inventoryAvailability(state, alice, 99)).toThrow();
  });
  it('keeps overdue budget held, leaves free quantity usable and permits explicit owner release', () => {
    const state = apply(fixture(), [reserve('hold', 'stock-a', '40', 20)]);
    expect(inventoryAvailability(state, alice, 19).reservations.hold.actions.fulfill).toBe(true);
    const due = inventoryAvailability(state, alice, 20);
    expect(due.reservations.hold).toMatchObject({
      overdue: true,
      blockers: [{ code: 'EXPIRY_PENDING' }],
      actions: { release: true, expire: true, fulfill: false },
    });
    expect(due.stocks['stock-a']).toMatchObject({
      held: volume('40'),
      unreserved: { kind: 'known', ...volume('60') },
      blockers: [],
    });
    refuses(state, [fulfill(consume('40'))], 'EXPIRY_PENDING', context(alice, 20));
    expect(
      apply(state, [reserve('free', 'stock-a', '60')], context(bob, 20)).reservations.free.lifecycle
        .kind
    ).toBe('active');
    expect(
      apply(state, [consume('60')], context(bob, 20)).stocks['stock-a'].quantity
    ).toMatchObject({ value: '40' });
    const released = apply(
      state,
      [{ kind: 'release-reservation', reservationId: 'hold', reason: 'Cancel plan' }],
      context(alice, 20)
    );
    expect(released.reservations.hold.lifecycle).toEqual({
      kind: 'released',
      at: 20,
      reason: 'Cancel plan',
    });
  });
  it('records expiry at the deadline and allows expire plus replacement atomically', () => {
    const state = apply(fixture(), [reserve('hold', 'stock-a', '100', 20)]);
    refuses(
      state,
      [{ kind: 'expire-reservations', ids: ['hold'] }],
      'INVALID_INVENTORY_INPUT',
      context(bob, 19)
    );
    const expired = apply(
      state,
      [{ kind: 'expire-reservations', ids: ['hold'] }, reserve('replacement', 'stock-a', '100')],
      context(bob, 20)
    );
    expect(expired.reservations.hold.lifecycle).toEqual({ kind: 'expired', at: 20 });
    expect(expired.reservations.replacement.holder).toEqual(bob);
    refuses(expired, [fulfill(consume('1'))], 'RESERVATION_NOT_ACTIVE', context(alice, 20));
    expect(parseInventoryState(JSON.parse(JSON.stringify(expired)))).toEqual(expired);
  });
  it('keeps no-expiry holds active and restricts release and cancellation to their authorities', () => {
    const state = apply(fixture(), [reserve()]);
    expect(
      inventoryAvailability(state, alice, Number.MAX_SAFE_INTEGER).reservations.hold.overdue
    ).toBe(false);
    refuses(
      state,
      [{ kind: 'expire-reservations', ids: ['hold'] }],
      'INVALID_INVENTORY_INPUT',
      context(bob, 100)
    );
    refuses(
      state,
      [{ kind: 'release-reservation', reservationId: 'hold', reason: 'Release' }],
      'RESERVATION_NOT_OWNED',
      context(bob)
    );
    refuses(
      state,
      [{ kind: 'cancel-reservation', reservationId: 'hold', reason: 'Override' }],
      'AUTHORITY_REQUIRED'
    );
    const cancelled = apply(
      state,
      [{ kind: 'cancel-reservation', reservationId: 'hold', reason: 'Local override' }],
      context(profile)
    );
    expect(cancelled.reservations.hold.lifecycle).toEqual({
      kind: 'cancelled',
      at: 10,
      reason: 'Local override',
      authority: { kind: 'local-profile', profileKey: 'profile' },
    });
    refuses(state, [consume('1')], 'INVALID_INVENTORY_INPUT', {
      ...context(profile),
      authority: { kind: 'local-profile', profileKey: 'other' },
    });
  });
});

describe('atomic explicit allocation fulfillment', () => {
  it('partially fulfills a hold and combines its claim with free unreserved stock', () => {
    const state = apply(fixture(), [reserve()]);
    const after = apply(state, [
      fulfill(consume('70'), [{ reservationId: 'hold', quantity: volume('20') }]),
    ]);
    expect(after.stocks['stock-a'].quantity).toMatchObject({ value: '30' });
    expect(after.reservations.hold).toMatchObject({
      remaining: volume('20'),
      lifecycle: { kind: 'active' },
    });
    expect(inventoryAvailability(after, alice, 10).stocks['stock-a'].unreserved).toEqual({
      kind: 'known',
      ...volume('10'),
    });
    const final = apply(after, [
      fulfill(consume('20'), [{ reservationId: 'hold', quantity: volume('20') }]),
    ]);
    expect(final.reservations.hold.lifecycle).toEqual({ kind: 'fulfilled', at: 10 });
    refuses(
      state,
      [fulfill(consume('81'), [{ reservationId: 'hold', quantity: volume('20') }])],
      'QUANTITY_RESERVED'
    );
  });
  it.each(['transfer', 'pool', 'dilute'] as const)(
    'fulfills %s stock, lineage and claims with ordinary unclaimed input',
    (kind) => {
      const state = apply(fixture(), [reserve()]);
      const after = apply(state, [fulfill(kind === 'transfer' ? transfer() : derived(kind))]);
      expect(after.reservations.hold.lifecycle).toEqual({ kind: 'fulfilled', at: 10 });
      expect(after.stocks['stock-a'].quantity).toMatchObject({ value: '60' });
      expect(after.stocks[kind === 'transfer' ? 'aliquot' : 'derived'].quantity).toMatchObject({
        value: kind === 'transfer' ? '40' : '50',
      });
      if (kind !== 'transfer') {
        expect(after.stocks['stock-b'].quantity).toMatchObject({ value: '90' });
        expect(after.lots['derived-lot'].origin.kind).toBe(kind === 'pool' ? 'pooled' : 'diluted');
      }
    }
  );
  it.each(['transfer', 'pool', 'dilute'] as const)(
    'rolls back fulfilled %s claims, stock and lineage on destination refusal',
    (kind) => {
      const state = apply(fixture(), [
        reserve(),
        {
          kind: 'set-vessel-limits',
          vesselId: 'c',
          limits: { capacity: { kind: 'known', ...volume('1') }, deadVolume: { kind: 'unknown' } },
          reason: 'Small destination',
        },
      ]);
      refuses(
        state,
        [fulfill(kind === 'transfer' ? transfer() : derived(kind))],
        'CAPACITY_EXCEEDED'
      );
    }
  );
  it('refuses mismatched, excessive, duplicate and foreign claims without consuming a hold', () => {
    const state = apply(fixture(), [reserve()]);
    refuses(state, [fulfill(consume('40', 'stock-b'))], 'INVALID_RESERVATION_CLAIM');
    refuses(state, [fulfill(consume('39'))], 'INVALID_RESERVATION_CLAIM');
    refuses(
      state,
      [fulfill(consume('50'), [{ reservationId: 'hold', quantity: volume('41') }])],
      'INVALID_RESERVATION_CLAIM'
    );
    refuses(
      state,
      [
        fulfill(consume('40'), [
          { reservationId: 'hold', quantity: volume('20') },
          { reservationId: 'hold', quantity: volume('20') },
        ]),
      ],
      'INVALID_RESERVATION_CLAIM'
    );
    refuses(state, [fulfill(consume('40'))], 'RESERVATION_NOT_OWNED', context(bob));
    refuses(
      state,
      [fulfill(consume('40'), [{ reservationId: 'hold', quantity: volume('0') }])],
      'INVALID_RESERVATION_CLAIM'
    );
  });
  it('rolls back earlier accepted commands and clock movement when later fulfillment fails', () => {
    const state = apply(fixture(), [reserve()]);
    refuses(
      state,
      [consume('1', 'stock-b'), fulfill(consume('39'))],
      'INVALID_RESERVATION_CLAIM',
      context(alice, 100)
    );
  });
});

describe('logical physical-item holds', () => {
  it('prevents moving another holder allocation into an owned booking while permitting unrelated moves', () => {
    const allocated = apply(fixture(), [reserve()]);
    const state = apply(
      allocated,
      [
        {
          kind: 'create-storage',
          id: 'reserved-box',
          name: 'Reserved box',
          slots: ['A', 'B'],
          placement: { kind: 'root' },
        },
        item('other-booking', { kind: 'storage', id: 'reserved-box' }),
      ],
      context(bob)
    );
    refuses(
      state,
      [
        {
          kind: 'move-vessel',
          id: 'a',
          placement: { kind: 'located', storageId: 'reserved-box', slotId: 'A' },
        },
      ],
      'RESERVATION_CONFLICT',
      context(bob)
    );
    refuses(
      state,
      [
        {
          kind: 'move-storage',
          id: 'box',
          placement: { kind: 'located', storageId: 'reserved-box', slotId: 'A' },
        },
      ],
      'RESERVATION_CONFLICT',
      context(bob)
    );
    expect(
      apply(
        state,
        [
          {
            kind: 'move-vessel',
            id: 'c',
            placement: { kind: 'located', storageId: 'reserved-box', slotId: 'B' },
          },
        ],
        context(bob)
      ).vessels.c.placement
    ).toMatchObject({ storageId: 'reserved-box', slotId: 'B' });
    const free = apply(
      state,
      [
        {
          kind: 'create-storage',
          id: 'free-box',
          name: 'Free box',
          slots: ['A'],
          placement: { kind: 'root' },
        },
      ],
      context(bob)
    );
    expect(
      apply(
        free,
        [
          {
            kind: 'move-vessel',
            id: 'a',
            placement: { kind: 'located', storageId: 'free-box', slotId: 'A' },
          },
        ],
        context(bob)
      ).vessels.a.placement
    ).toMatchObject({ storageId: 'free-box' });
  });
  it('conflicts across ancestors and descendants while leaving unrelated slots usable', () => {
    const state = apply(fixture(), [item('tube-booking', { kind: 'vessel', id: 'a' })]);
    refuses(state, [item('box-booking')], 'RESERVATION_CONFLICT', context(bob));
    refuses(state, [consume('1')], 'ITEM_RESERVED', context(bob));
    refuses(state, [reserve('quantity')], 'ITEM_RESERVED', context(bob));
    refuses(
      state,
      [{ kind: 'move-storage', id: 'box', placement: { kind: 'root' } }],
      'ITEM_RESERVED',
      context(bob)
    );
    expect(
      apply(
        state,
        [
          {
            kind: 'move-vessel',
            id: 'c',
            placement: { kind: 'located', storageId: 'box', slotId: 'C' },
          },
        ],
        context(bob)
      ).vessels.c.placement
    ).toMatchObject({ slotId: 'C' });
    const boxed = apply(fixture(), [item()]);
    refuses(
      boxed,
      [item('tube', { kind: 'vessel', id: 'a' })],
      'RESERVATION_CONFLICT',
      context(bob)
    );
    refuses(
      boxed,
      [
        {
          kind: 'move-vessel',
          id: 'c',
          placement: { kind: 'located', storageId: 'box', slotId: 'C' },
        },
      ],
      'ITEM_RESERVED',
      context(bob)
    );
    expect(apply(boxed, [consume('1')]).reservations.booking.lifecycle.kind).toBe('active');
  });
  it('permits logical fixed-well holds and protects their containing plate from disposal', () => {
    const state = apply(fixture(), [
      {
        kind: 'create-layout-storage',
        id: 'plate',
        name: 'Plate',
        layout: { kind: 'fixed-well', rows: 1, columns: 2 },
        placement: { kind: 'root' },
      },
      item('well', { kind: 'vessel', id: inventoryWellId('plate', 'A1') }),
    ]);
    refuses(
      state,
      [item('plate-hold', { kind: 'storage', id: 'plate' })],
      'RESERVATION_CONFLICT',
      context(bob)
    );
    refuses(
      state,
      [{ kind: 'dispose-plate', id: 'plate', reason: 'Discard' }],
      'ITEM_RESERVED',
      context(bob)
    );
    const disposed = apply(state, [{ kind: 'dispose-plate', id: 'plate', reason: 'Discard' }]);
    expect(disposed.reservations.well.lifecycle.kind).toBe('active');
    expect(disposed.vessels[inventoryWellId('plate', 'A1')].lifecycle).toBe('disposed');
  });
  it('prevents an item booking from hiding another holder quantity allocation', () => {
    const state = apply(fixture(), [reserve()]);
    refuses(state, [item()], 'RESERVATION_CONFLICT', context(bob));
    expect(apply(state, [item()]).reservations.booking.lifecycle.kind).toBe('active');
  });
  it('fulfills overlapping item and quantity claims independently without double credit', () => {
    const state = apply(fixture(), [reserve(), item()]);
    const claims = [
      { reservationId: 'hold', quantity: volume('40') },
      { reservationId: 'booking', quantity: volume('50') },
    ];
    const after = apply(state, [fulfill(derived('pool'), claims)]);
    expect(after.reservations.hold.lifecycle.kind).toBe('fulfilled');
    expect(after.reservations.booking.lifecycle.kind).toBe('fulfilled');
    expect(after.stocks['stock-a'].quantity).toMatchObject({ value: '60' });
    refuses(
      state,
      [fulfill(derived('pool'), [{ reservationId: 'booking', quantity: volume('49') }])],
      'INVALID_RESERVATION_CLAIM'
    );
    const fullyHeld = apply(fixture(), [reserve('all', 'stock-a', '100'), item()]);
    refuses(
      fullyHeld,
      [fulfill(consume('1'), [{ reservationId: 'booking', quantity: volume('1') }])],
      'QUANTITY_RESERVED'
    );
  });
  it('permits ordinary owner use without silently completing an item booking', () => {
    const state = apply(fixture(), [item('booking', { kind: 'storage', id: 'box' }, 20)]);
    const after = apply(state, [consume('10')], context(alice, 20));
    expect(after.reservations.booking.lifecycle.kind).toBe('active');
    expect(inventoryAvailability(after, alice, 20).reservations.booking.actions).toMatchObject({
      release: true,
      expire: true,
      fulfill: false,
    });
    refuses(
      state,
      [fulfill(consume('10'), [{ reservationId: 'booking', quantity: volume('10') }])],
      'EXPIRY_PENDING',
      context(alice, 20)
    );
  });
});

it('keeps new requests strict, nonrecursive and capable of permanent well identifiers', () => {
  const longWellId = inventoryWellId('p'.repeat(512), 'A1');
  expect(
    parseInventoryCommand(item('well-booking', { kind: 'vessel', id: longWellId }))
  ).toMatchObject({ item: { id: longWellId } });
  expect(() => parseInventoryCommand({ ...reserve(), holder: alice })).toThrow();
  expect(() => parseInventoryCommand({ ...reserve(), deadline: undefined })).toThrow();
  expect(() =>
    parseInventoryCommand({
      kind: 'fulfill-reservations',
      claims: [{ reservationId: 'hold', quantity: volume('1') }],
      withdrawal: fulfill(consume('1')),
    })
  ).toThrow();
  expect(() => parseInventoryCommand({ kind: 'expire-reservations', ids: ['a', 'a'] })).toThrow();
});
