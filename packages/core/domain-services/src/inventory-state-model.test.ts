import { describe, expect, it } from 'vitest';
import {
  applyInventoryCommandBatch,
  createInventoryState,
  type InventoryCommand,
  type InventoryQuantity,
  type InventoryState,
} from './inventory';

const quantities: readonly InventoryQuantity[] = [
  { kind: 'unknown' },
  ...['0', '1', '2'].map((value) => ({ kind: 'known' as const, value, unit: 'uL' as const })),
];

function seed(): InventoryState {
  const result = applyInventoryCommandBatch(createInventoryState(), {
    expectedRevision: 0,
    commands: [
      {
        kind: 'create-storage',
        id: 'rack',
        name: 'Rack',
        slots: ['A', 'B'],
        placement: { kind: 'root' },
      },
      { kind: 'create-storage', id: 'box', name: 'Box', slots: ['1'], placement: { kind: 'root' } },
      { kind: 'create-vessel', id: 'tube', name: 'Tube', placement: { kind: 'unplaced' } },
      {
        kind: 'receive-stock',
        id: 'stock',
        vesselId: 'tube',
        materialId: 'synthetic',
        quantity: { kind: 'unknown' },
        quality: 'usable',
      },
    ],
  });
  if (!result.ok) throw new Error(result.message);
  return result.state;
}

const commands: readonly InventoryCommand[] = [
  { kind: 'move-storage', id: 'rack', placement: { kind: 'root' } },
  {
    kind: 'move-storage',
    id: 'rack',
    placement: { kind: 'located', storageId: 'box', slotId: '1' },
  },
  {
    kind: 'move-storage',
    id: 'rack',
    placement: { kind: 'located', storageId: 'rack', slotId: 'A' },
  },
  { kind: 'move-storage', id: 'box', placement: { kind: 'root' } },
  {
    kind: 'move-storage',
    id: 'box',
    placement: { kind: 'located', storageId: 'rack', slotId: 'A' },
  },
  {
    kind: 'move-storage',
    id: 'box',
    placement: { kind: 'located', storageId: 'rack', slotId: 'B' },
  },
  {
    kind: 'move-storage',
    id: 'box',
    placement: { kind: 'located', storageId: 'box', slotId: '1' },
  },
  { kind: 'move-vessel', id: 'tube', placement: { kind: 'unplaced' } },
  {
    kind: 'move-vessel',
    id: 'tube',
    placement: { kind: 'located', storageId: 'rack', slotId: 'A' },
  },
  {
    kind: 'move-vessel',
    id: 'tube',
    placement: { kind: 'located', storageId: 'rack', slotId: 'B' },
  },
  {
    kind: 'move-vessel',
    id: 'tube',
    placement: { kind: 'located', storageId: 'box', slotId: '1' },
  },
  { kind: 'set-quality', stockId: 'stock', quality: 'quarantined', reason: 'Inspection' },
  { kind: 'set-quality', stockId: 'stock', quality: 'usable', reason: 'Inspection' },
  ...quantities.map(
    (quantity): InventoryCommand => ({
      kind: 'reconcile',
      stockId: 'stock',
      quantity,
      reason: 'Measured',
    })
  ),
  ...['0', '1', '2'].map(
    (value): InventoryCommand => ({
      kind: 'consume',
      stockId: 'stock',
      quantity: { value, unit: 'uL' },
      reason: 'Experiment',
    })
  ),
  {
    kind: 'consume',
    stockId: 'stock',
    quantity: { value: '1000', unit: 'nL' },
    reason: 'Experiment',
  },
  { kind: 'dispose-vessel', id: 'tube', reason: 'Discarded' },
];

function domainKey(state: InventoryState): string {
  const { revision: _, ...domain } = state;
  return JSON.stringify(domain);
}

function assertInvariants(state: InventoryState): void {
  const occupied = new Set<string>();
  for (const item of [...Object.values(state.storage), ...Object.values(state.vessels)]) {
    if (item.placement.kind !== 'located') continue;
    const position = `${item.placement.storageId}/${item.placement.slotId}`;
    expect(occupied.has(position), `duplicate placement at ${position}`).toBe(false);
    occupied.add(position);
    expect(state.storage[item.placement.storageId].slots).toContain(item.placement.slotId);
  }
  for (const storage of Object.values(state.storage)) {
    const ancestors = new Set([storage.id]);
    let placement = storage.placement;
    while (placement.kind === 'located') {
      expect(ancestors.has(placement.storageId), 'containment cycle').toBe(false);
      ancestors.add(placement.storageId);
      placement = state.storage[placement.storageId].placement;
    }
  }
  const vessel = state.vessels.tube;
  if (vessel.lifecycle === 'disposed') expect(vessel.placement).toEqual({ kind: 'unplaced' });
  const quantity = state.stocks.stock.quantity;
  if (quantity.kind === 'known') {
    expect(quantity.unit).toBe('uL');
    expect(['0', '1', '2']).toContain(quantity.value);
    expect(BigInt(quantity.value) >= 0n).toBe(true);
  } else {
    expect(quantity).toEqual({ kind: 'unknown' });
    expect(quantity).not.toEqual({ kind: 'known', value: '0', unit: 'uL' });
  }
}

describe('bounded inventory state exploration', () => {
  it('exhausts the fixed-object graph while preserving placement, quantity and rejection invariants', () => {
    const initial = seed();
    const queue = [{ state: initial, path: [] as number[] }];
    const seen = new Set([domainKey(initial)]);
    const rejectionCounts: Record<string, number> = {};
    const witnesses: Record<string, readonly number[]> = {};
    let accepted = 0;
    let rejected = 0;
    let greatestDepth = 0;

    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const { state, path } = queue[cursor];
      assertInvariants(state);
      const original = JSON.stringify(state);
      for (const [commandIndex, command] of commands.entries()) {
        const result = applyInventoryCommandBatch(state, {
          expectedRevision: state.revision,
          commands: [command],
        });
        expect(JSON.stringify(state)).toBe(original);
        if (!result.ok) {
          rejected += 1;
          rejectionCounts[result.code] = (rejectionCounts[result.code] ?? 0) + 1;
          witnesses[result.code] ??= [...path, commandIndex];
          continue;
        }
        accepted += 1;
        expect(result.state.revision).toBe(state.revision + 1);
        assertInvariants(result.state);
        if (command.kind === 'dispose-vessel') {
          expect(result.state.stocks.stock).toEqual(state.stocks.stock);
        }
        if (command.kind === 'consume') {
          const before = state.stocks.stock.quantity;
          const after = result.state.stocks.stock.quantity;
          expect(state.stocks.stock.quality).toBe('usable');
          expect(state.vessels.tube.lifecycle).toBe('active');
          expect(before.kind).toBe('known');
          expect(after.kind).toBe('known');
          if (before.kind === 'known' && after.kind === 'known') {
            const debit = command.quantity.unit === 'nL' ? 1 : Number(command.quantity.value);
            expect(Number(after.value)).toBe(Number(before.value) - debit);
          }
        }
        const key = domainKey(result.state);
        if (!seen.has(key)) {
          seen.add(key);
          const nextPath = [...path, commandIndex];
          greatestDepth = Math.max(greatestDepth, nextPath.length);
          queue.push({ state: result.state, path: nextPath });
        }
      }
    }

    expect(seen.size).toBe(136);
    expect(accepted + rejected).toBe(seen.size * commands.length);
    expect(Object.keys(rejectionCounts).sort()).toEqual([
      'CONTAINMENT_CYCLE',
      'INSUFFICIENT_QUANTITY',
      'INVALID_QUANTITY',
      'QUANTITY_UNKNOWN',
      'SLOT_OCCUPIED',
      'STOCK_QUARANTINED',
      'VESSEL_DISPOSED',
    ]);
    for (const quantity of quantities) {
      expect(
        queue.some(
          ({ state }) => JSON.stringify(state.stocks.stock.quantity) === JSON.stringify(quantity)
        )
      ).toBe(true);
    }
    expect(
      queue.some(
        ({ state }) =>
          state.vessels.tube.lifecycle === 'disposed' &&
          state.stocks.stock.quantity.kind === 'unknown'
      )
    ).toBe(true);
    expect(
      queue.some(
        ({ state }) =>
          state.vessels.tube.lifecycle === 'disposed' &&
          state.stocks.stock.quality === 'quarantined'
      )
    ).toBe(true);
    console.info(
      JSON.stringify({
        model: 'fixed-object inventory graph; revision omitted from state identity',
        bounds: {
          storage: { rack: ['A', 'B'], box: ['1'] },
          vessels: 1,
          stocks: 1,
          quantityMicroLiters: ['unknown', '0', '1', '2'],
          commands: commands.length,
        },
        states: seen.size,
        acceptedEdges: accepted,
        rejectedEdges: rejected,
        greatestShortestPath: greatestDepth,
        rejectionCounts,
        rejectionWitnesses: Object.fromEntries(
          Object.entries(witnesses).map(([code, path]) => [
            code,
            path.map((index) => commands[index]),
          ])
        ),
      })
    );
  });

  it('distinguishes unknown from measured zero and rolls back a rejected batch', () => {
    const unknown = seed();
    const consume: InventoryCommand = {
      kind: 'consume',
      stockId: 'stock',
      quantity: { value: '1', unit: 'uL' },
      reason: 'Experiment',
    };
    expect(
      applyInventoryCommandBatch(unknown, {
        expectedRevision: unknown.revision,
        commands: [consume],
      })
    ).toMatchObject({ ok: false, code: 'QUANTITY_UNKNOWN' });
    const zero = applyInventoryCommandBatch(unknown, {
      expectedRevision: unknown.revision,
      commands: [
        {
          kind: 'reconcile',
          stockId: 'stock',
          quantity: { kind: 'known', value: '0', unit: 'uL' },
          reason: 'Measured',
        },
      ],
    });
    if (!zero.ok) throw new Error(zero.message);
    expect(
      applyInventoryCommandBatch(zero.state, {
        expectedRevision: zero.state.revision,
        commands: [consume],
      })
    ).toMatchObject({ ok: false, code: 'INSUFFICIENT_QUANTITY' });
    const before = JSON.stringify(unknown);
    expect(
      applyInventoryCommandBatch(unknown, {
        expectedRevision: unknown.revision,
        commands: [
          {
            kind: 'move-vessel',
            id: 'tube',
            placement: { kind: 'located', storageId: 'rack', slotId: 'A' },
          },
          consume,
        ],
      })
    ).toMatchObject({ ok: false, code: 'QUANTITY_UNKNOWN' });
    expect(JSON.stringify(unknown)).toBe(before);
    expect(
      applyInventoryCommandBatch(unknown, {
        expectedRevision: unknown.revision - 1,
        commands: [consume],
      })
    ).toMatchObject({ ok: false, code: 'REVISION_CONFLICT' });
  });
});
