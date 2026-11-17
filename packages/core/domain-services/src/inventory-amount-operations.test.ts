import { describe, expect, it } from 'vitest';
import {
  applyInventoryCommandBatch,
  createInventoryState,
  inventoryAvailability,
  parseInventoryState,
  type InventoryCommand,
  type InventoryExecutionContext,
  type InventoryQuantityInput,
  type InventoryState,
} from './inventory';
import type { InventoryAmount } from './inventory-amount';

const context: InventoryExecutionContext = {
  at: 10,
  principal: { kind: 'agent', identityId: 'scientist' },
  authority: { kind: 'local-profile', profileKey: 'profile' },
};
const bases = [
  {
    name: 'mass',
    received: { value: '2', unit: 'ug' },
    whole: { value: '2000', unit: 'ng' },
    part: { value: '500', unit: 'ng' },
    alternatePart: { value: '0.5', unit: 'ug' },
    rest: '1500',
  },
  {
    name: 'molar amount',
    received: { value: '2', unit: 'umol' },
    whole: { value: '2000', unit: 'nmol' },
    part: { value: '500', unit: 'nmol' },
    alternatePart: { value: '0.5', unit: 'umol' },
    rest: '1500',
  },
  {
    name: 'count',
    received: { value: '8', unit: 'item' },
    whole: { value: '8', unit: 'item' },
    part: { value: '2', unit: 'item' },
    alternatePart: { value: '2.0', unit: 'item' },
    rest: '6',
  },
] as const;

function apply(state: InventoryState, ...commands: InventoryCommand[]): InventoryState {
  const result = applyInventoryCommandBatch(
    state,
    { expectedRevision: state.revision, commands },
    context
  );
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  expect(parseInventoryState(result.state)).toEqual(result.state);
  return result.state;
}

function fixture(quantity: InventoryQuantityInput): InventoryState {
  return apply(
    createInventoryState(),
    ...['a', 'b', 'c'].map((id) => ({
      kind: 'create-vessel' as const,
      id,
      name: id,
      placement: { kind: 'unplaced' as const },
    })),
    {
      kind: 'set-vessel-limits',
      vesselId: 'a',
      limits: {
        capacity: { kind: 'known', value: '1', unit: 'uL' },
        deadVolume: { kind: 'known', value: '1', unit: 'uL' },
      },
      reason: 'Measured volume constraints',
    },
    {
      kind: 'set-vessel-limits',
      vesselId: 'b',
      limits: {
        capacity: { kind: 'known', value: '1', unit: 'uL' },
        deadVolume: { kind: 'known', value: '1', unit: 'uL' },
      },
      reason: 'Measured destination volume constraints',
    },
    {
      kind: 'receive-stock',
      id: 'stock',
      vesselId: 'a',
      materialId: 'material',
      quantity,
      quality: 'usable',
    }
  );
}

function reserve(quantity: InventoryAmount): InventoryCommand {
  return {
    kind: 'reserve-quantity',
    id: 'hold',
    stockId: 'stock',
    quantity,
    purpose: 'Planned use',
    deadline: null,
  };
}

function consume(quantity: InventoryAmount): Extract<InventoryCommand, { kind: 'consume' }> {
  return { kind: 'consume', stockId: 'stock', quantity, reason: 'Measured use' };
}

function transfer(quantity: InventoryAmount): InventoryCommand {
  return {
    kind: 'transfer',
    sourceStockId: 'stock',
    quantity,
    destination: { kind: 'new-stock', stockId: 'aliquot', vesselId: 'b' },
    reason: 'Split stock',
  };
}

function refused(state: InventoryState, code: string, ...commands: InventoryCommand[]): void {
  const before = structuredClone(state);
  expect(
    applyInventoryCommandBatch(state, { expectedRevision: state.revision, commands }, context)
  ).toMatchObject({ ok: false, code });
  expect(state).toEqual(before);
}

describe.each(bases)(
  '$name balance operations',
  ({ received, whole, part, alternatePart, rest }) => {
    it('conserves the declared basis through exact aliquot, recombination, and complete use', () => {
      let state = fixture({ kind: 'known', ...received });
      expect(state.stocks.stock.quantity).toEqual({ kind: 'known', ...whole });
      state = apply(state, transfer(alternatePart));
      expect(state.stocks.stock.quantity).toEqual({ kind: 'known', value: rest, unit: whole.unit });
      expect(state.stocks.aliquot.quantity).toEqual({ kind: 'known', ...part });
      expect(state.stocks.aliquot.source).toEqual({ kind: 'unattributed', rootStockId: 'stock' });
      state = apply(state, {
        kind: 'transfer',
        sourceStockId: 'aliquot',
        quantity: alternatePart,
        destination: { kind: 'existing-stock', stockId: 'stock' },
        reason: 'Return unused stock',
      });
      expect(state.stocks.stock.quantity).toEqual({ kind: 'known', ...whole });
      expect(state.stocks.aliquot.quantity).toEqual({
        kind: 'known',
        value: '0',
        unit: whole.unit,
      });
      state = apply(state, consume(received));
      expect(state.stocks.stock.quantity).toEqual({ kind: 'known', value: '0', unit: whole.unit });
      expect(
        inventoryAvailability(state, context.principal, context.at).stocks.stock
      ).toMatchObject({
        held: { value: '0', unit: whole.unit },
        mine: { value: '0', unit: whole.unit },
        unreserved: { kind: 'known', value: '0', unit: whole.unit },
        blockers: [],
      });
    });

    it('holds and fulfills exact quantities without treating physical dead volume as that basis', () => {
      let state = apply(fixture({ kind: 'known', ...received }), reserve(alternatePart));
      expect(
        inventoryAvailability(state, context.principal, context.at).stocks.stock
      ).toMatchObject({
        held: part,
        mine: part,
        unreserved: { kind: 'known', value: rest, unit: whole.unit },
        blockers: [],
      });
      refused(state, 'QUANTITY_RESERVED', consume(whole));
      state = apply(state, {
        kind: 'fulfill-reservations',
        claims: [{ reservationId: 'hold', quantity: alternatePart }],
        withdrawal: consume(part),
      });
      expect(state.reservations.hold).toMatchObject({
        quantity: part,
        remaining: { value: '0', unit: whole.unit },
        lifecycle: { kind: 'fulfilled', at: 10 },
      });
      expect(state.stocks.stock.quantity).toEqual({ kind: 'known', value: rest, unit: whole.unit });
    });

    it('keeps an unknown amount and zero holds in the declared basis without making it usable', () => {
      const state = fixture({ kind: 'unknown', unit: received.unit });
      expect(
        inventoryAvailability(state, context.principal, context.at).stocks.stock
      ).toMatchObject({
        onHand: { kind: 'unknown', unit: whole.unit },
        held: { value: '0', unit: whole.unit },
        mine: { value: '0', unit: whole.unit },
        unreserved: { kind: 'unknown', unit: whole.unit },
        blockers: [{ code: 'QUANTITY_UNKNOWN' }],
      });
      refused(state, 'QUANTITY_UNKNOWN', consume(part));
      refused(state, 'QUANTITY_UNKNOWN', reserve(part));
    });

    it('refuses incompatible use, transfer, reservation, and fulfillment atomically', () => {
      const state = fixture({ kind: 'known', ...received });
      const volume = { value: '1', unit: 'uL' } as const;
      refused(state, 'QUANTITY_DIMENSION_MISMATCH', consume(volume));
      refused(state, 'QUANTITY_DIMENSION_MISMATCH', transfer(volume));
      refused(state, 'QUANTITY_DIMENSION_MISMATCH', reserve(volume));
      const held = apply(state, reserve(part));
      refused(held, 'QUANTITY_DIMENSION_MISMATCH', {
        kind: 'fulfill-reservations',
        claims: [{ reservationId: 'hold', quantity: volume }],
        withdrawal: consume(part),
      });
      refused(state, 'QUANTITY_DIMENSION_MISMATCH', reserve(part), consume(volume));
    });

    it.each(['pool', 'dilute'] as const)(
      'refuses %s of non-volume stocks before withdrawing',
      (kind) => {
        const state = fixture({ kind: 'known', ...received });
        const common = {
          lotId: 'derived-lot',
          stockId: 'derived',
          vesselId: 'c',
          materialId: 'material',
          name: 'Derived stock',
          reason: 'Requested preparation',
        };
        const input = { stockId: 'stock', quantity: { value: '1', unit: 'uL' as const } };
        const other = { stockId: 'missing', quantity: { value: '1', unit: 'uL' as const } };
        const command: Extract<InventoryCommand, { kind: 'pool' | 'dilute' }> =
          kind === 'pool'
            ? { kind, ...common, inputs: [input, other] }
            : { kind, ...common, sample: input, diluent: other };
        refused(state, 'MIXING_REQUIRES_VOLUME', command);
        const held = apply(state, reserve(part));
        refused(held, 'MIXING_REQUIRES_VOLUME', {
          kind: 'fulfill-reservations',
          claims: [{ reservationId: 'hold', quantity: part }],
          withdrawal: command,
        });
      }
    );

    it('fulfills a physical item reservation using the exact non-volume withdrawal amount', () => {
      let state = apply(fixture({ kind: 'known', ...received }), {
        kind: 'reserve-item',
        id: 'item-hold',
        item: { kind: 'vessel', id: 'a' },
        deadline: null,
        purpose: 'Exclusive physical use',
      });
      refused(state, 'QUANTITY_DIMENSION_MISMATCH', {
        kind: 'fulfill-reservations',
        claims: [{ reservationId: 'item-hold', quantity: { value: '1', unit: 'uL' } }],
        withdrawal: consume(part),
      });
      state = apply(state, {
        kind: 'fulfill-reservations',
        claims: [{ reservationId: 'item-hold', quantity: alternatePart }],
        withdrawal: consume(part),
      });
      expect(state.reservations['item-hold'].lifecycle).toEqual({ kind: 'fulfilled', at: 10 });
      expect(state.stocks.stock.quantity).toEqual({ kind: 'known', value: rest, unit: whole.unit });
    });
  }
);

describe('measurement dimensions and composition', () => {
  it('preserves exact partial allocations and derives a same-basis shortfall after reconciliation', () => {
    let state = apply(
      fixture({ kind: 'known', value: '2', unit: 'ug' }),
      reserve({ value: '0.5', unit: 'ug' }),
      {
        kind: 'fulfill-reservations',
        claims: [{ reservationId: 'hold', quantity: { value: '0.125', unit: 'ug' } }],
        withdrawal: consume({ value: '125', unit: 'ng' }),
      }
    );
    expect(state.reservations.hold).toMatchObject({
      quantity: { value: '500', unit: 'ng' },
      remaining: { value: '375', unit: 'ng' },
      lifecycle: { kind: 'active' },
    });
    expect(inventoryAvailability(state, context.principal, context.at).stocks.stock).toMatchObject({
      onHand: { kind: 'known', value: '1875', unit: 'ng' },
      held: { value: '375', unit: 'ng' },
      unreserved: { kind: 'known', value: '1500', unit: 'ng' },
    });
    state = apply(state, {
      kind: 'reconcile',
      stockId: 'stock',
      quantity: { kind: 'known', value: '100', unit: 'ng' },
      reason: 'Measured balance below outstanding allocation',
    });
    expect(inventoryAvailability(state, context.principal, context.at).stocks.stock).toMatchObject({
      held: { value: '375', unit: 'ng' },
      unreserved: { kind: 'known', value: '0', unit: 'ng' },
      blockers: [{ code: 'ALLOCATION_SHORTFALL' }],
    });
    refused(state, 'ALLOCATION_SHORTFALL', consume({ value: '1', unit: 'ng' }));
    refused(state, 'ALLOCATION_SHORTFALL', {
      kind: 'fulfill-reservations',
      claims: [{ reservationId: 'hold', quantity: { value: '1', unit: 'ng' } }],
      withdrawal: consume({ value: '1', unit: 'ng' }),
    });
  });

  it('rolls back reservation fulfillment when its later destination is unresolved', () => {
    const state = apply(
      fixture({ kind: 'known', value: '2', unit: 'ug' }),
      reserve({ value: '500', unit: 'ng' }),
      {
        kind: 'record-vessel-contents',
        vesselId: 'b',
        knowledge: 'unobserved',
        reason: 'Destination contents have not been checked',
      }
    );
    refused(state, 'VESSEL_CONTENTS_UNRESOLVED', {
      kind: 'fulfill-reservations',
      claims: [{ reservationId: 'hold', quantity: { value: '500', unit: 'ng' } }],
      withdrawal: {
        kind: 'transfer',
        sourceStockId: 'stock',
        quantity: { value: '0.5', unit: 'ug' },
        destination: { kind: 'new-stock', stockId: 'aliquot', vesselId: 'b' },
        reason: 'Reserved transfer',
      },
    });
  });

  it('does not admit fractional counts or a zero withdrawal as inventory use', () => {
    const state = fixture({ kind: 'known', value: '8', unit: 'item' });
    refused(state, 'INVALID_INVENTORY_INPUT', consume({ value: '0.5', unit: 'item' }));
    refused(state, 'INVALID_INVENTORY_INPUT', reserve({ value: '0.5', unit: 'item' }));
    refused(state, 'INVALID_QUANTITY', consume({ value: '0', unit: 'item' }));
    refused(state, 'INSUFFICIENT_QUANTITY', consume({ value: '9', unit: 'item' }));
  });

  it('preserves aliquot composition and refuses non-volume homogeneous recombination', () => {
    let state = apply(fixture({ kind: 'known', value: '2', unit: 'ug' }), {
      kind: 'record-composition',
      stockId: 'stock',
      reason: 'Independent concentration measurement',
      composition: {
        kind: 'homogeneous',
        analytes: { dna: { kind: 'known', value: '2', unit: 'ng/uL' } },
      },
    });
    state = apply(state, transfer({ value: '500', unit: 'ng' }));
    expect(state.stocks.aliquot.composition).toEqual(state.stocks.stock.composition);
    const recombine = {
      kind: 'transfer' as const,
      sourceStockId: 'aliquot',
      quantity: { value: '500', unit: 'ng' } as const,
      destination: { kind: 'existing-stock' as const, stockId: 'stock' },
      reason: 'Return measured aliquot',
    };
    refused(state, 'MIXING_REQUIRES_VOLUME', { ...recombine, mixing: 'homogeneous' });
    state = apply(state, { ...recombine, mixing: 'unknown' });
    expect(state.stocks.stock.quantity).toEqual({ kind: 'known', value: '2000', unit: 'ng' });
    expect(state.stocks.stock.composition).toEqual({ kind: 'unknown' });
  });

  it('refuses adding mass into a same-lot destination with a volume basis', () => {
    const state = apply(
      fixture({ kind: 'known', value: '2', unit: 'ug' }),
      {
        kind: 'create-lot',
        id: 'lot',
        materialId: 'material',
        name: 'Received lot',
        origin: { kind: 'received', supplier: 'Supplier', lotNumber: '1' },
      },
      { kind: 'associate-stock-lot', stockId: 'stock', lotId: 'lot', reason: 'Verified source' },
      {
        kind: 'receive-lot-stock',
        id: 'other',
        vesselId: 'b',
        lotId: 'lot',
        quantity: { kind: 'known', value: '0.5', unit: 'uL' },
        quality: 'usable',
      }
    );
    refused(state, 'QUANTITY_DIMENSION_MISMATCH', {
      kind: 'transfer',
      sourceStockId: 'stock',
      quantity: { value: '1', unit: 'ug' },
      destination: { kind: 'existing-stock', stockId: 'other' },
      reason: 'Attempted incompatible addition',
    });
  });

  it('keeps volume capacity and dead-volume enforcement active for volume balances', () => {
    const state = fixture({ kind: 'known', value: '1', unit: 'uL' });
    refused(state, 'DEAD_VOLUME_REQUIRED', consume({ value: '1', unit: 'nL' }));
    expect(
      inventoryAvailability(state, context.principal, context.at).stocks.stock.unreserved
    ).toEqual({
      kind: 'known',
      value: '0',
      unit: 'uL',
    });
    refused(state, 'CAPACITY_EXCEEDED', {
      kind: 'reconcile',
      stockId: 'stock',
      quantity: { kind: 'known', value: '2', unit: 'uL' },
      reason: 'Measured larger balance',
    });
  });
});
