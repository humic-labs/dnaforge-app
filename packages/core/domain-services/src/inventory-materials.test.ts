import { describe, expect, it } from 'vitest';
import {
  applyInventoryCommandBatch,
  createInventoryState,
  parseInventoryState,
  type InventoryCommand,
  type InventoryState,
  inventoryCommandJsonSchema,
} from './inventory';

function apply(state: InventoryState, ...commands: InventoryCommand[]): InventoryState {
  const result = applyInventoryCommandBatch(state, { expectedRevision: state.revision, commands });
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  expect(parseInventoryState(result.state)).toEqual(result.state);
  return result.state;
}

function fixture(): InventoryState {
  let state = createInventoryState();
  state = apply(
    state,
    ...['a', 'b', 'c', 'd'].map((id) => ({
      kind: 'create-vessel' as const,
      id,
      name: id,
      placement: { kind: 'unplaced' as const },
    }))
  );
  return apply(
    state,
    {
      kind: 'receive-stock',
      id: 'stock-a',
      vesselId: 'a',
      materialId: 'dna',
      quantity: { kind: 'known', value: '100', unit: 'uL' },
      quality: 'usable',
    },
    {
      kind: 'receive-stock',
      id: 'stock-b',
      vesselId: 'b',
      materialId: 'dna',
      quantity: { kind: 'known', value: '0.1', unit: 'mL' },
      quality: 'usable',
    }
  );
}

function transfer(sourceStockId = 'stock-a', destinationStockId = 'stock-c'): InventoryCommand {
  return {
    kind: 'transfer',
    sourceStockId,
    quantity: { value: '20', unit: 'uL' },
    destination: { kind: 'new-stock', stockId: destinationStockId, vesselId: 'c' },
    reason: 'Aliquot for experiment',
  };
}

function refused(state: InventoryState, command: InventoryCommand, code: string): void {
  const before = JSON.stringify(state);
  expect(
    applyInventoryCommandBatch(state, { expectedRevision: state.revision, commands: [command] })
  ).toMatchObject({ ok: false, code });
  expect(JSON.stringify(state)).toBe(before);
}

describe('explicit material lineage and conserved volumes', () => {
  it('preserves exact amount and root identity when splitting and recombining an aliquot', () => {
    let state = apply(fixture(), transfer());
    expect(state.stocks['stock-a'].quantity).toEqual({ kind: 'known', value: '80', unit: 'uL' });
    expect(state.stocks['stock-c'].source).toEqual({
      kind: 'unattributed',
      rootStockId: 'stock-a',
    });
    state = apply(state, {
      kind: 'transfer',
      sourceStockId: 'stock-c',
      quantity: { value: '20000', unit: 'nL' },
      destination: { kind: 'existing-stock', stockId: 'stock-a' },
      reason: 'Return unused aliquot',
    });
    expect(state.stocks['stock-a'].quantity).toEqual({ kind: 'known', value: '100', unit: 'uL' });
    expect(state.stocks['stock-c'].quantity).toEqual({ kind: 'known', value: '0', unit: 'uL' });
  });

  it('refuses combining independently unattributed stocks of the same material', () => {
    refused(
      fixture(),
      {
        kind: 'transfer',
        sourceStockId: 'stock-a',
        quantity: { value: '1', unit: 'uL' },
        destination: { kind: 'existing-stock', stockId: 'stock-b' },
        reason: 'Combine',
      },
      'INCOMPATIBLE_PROVENANCE'
    );
  });

  it('does not retroactively attribute aliquots when their root is assigned a lot', () => {
    const state = apply(
      fixture(),
      transfer(),
      {
        kind: 'create-lot',
        id: 'lot-a',
        materialId: 'dna',
        name: 'Received DNA',
        origin: { kind: 'received', supplier: 'Supplier', lotNumber: '123' },
      },
      { kind: 'associate-stock-lot', stockId: 'stock-a', lotId: 'lot-a', reason: 'Verified label' }
    );
    expect(state.stocks['stock-c'].source).toEqual({
      kind: 'unattributed',
      rootStockId: 'stock-a',
    });
    refused(
      state,
      {
        kind: 'transfer',
        sourceStockId: 'stock-c',
        quantity: { value: '1', unit: 'uL' },
        destination: { kind: 'existing-stock', stockId: 'stock-a' },
        reason: 'Combine',
      },
      'INCOMPATIBLE_PROVENANCE'
    );
  });

  it('receives known lot stock and snapshots preparation source identity without withdrawing volume', () => {
    let state = apply(fixture(), {
      kind: 'create-lot',
      id: 'prep',
      materialId: 'product',
      name: 'Prepared product',
      origin: { kind: 'prepared', sourceStockIds: ['stock-a'], method: 'Synthesis' },
    });
    expect(state.stocks['stock-a'].quantity).toMatchObject({ value: '100' });
    state = apply(state, {
      kind: 'receive-lot-stock',
      id: 'product-stock',
      vesselId: 'c',
      lotId: 'prep',
      quantity: { kind: 'unknown' },
      quality: 'usable',
    });
    expect(state.stocks['product-stock']).toMatchObject({
      materialId: 'product',
      source: { kind: 'lot', lotId: 'prep' },
      quantity: { kind: 'unknown' },
    });
    expect(state.lots.prep.origin).toEqual({
      kind: 'prepared',
      method: 'Synthesis',
      inputs: [
        {
          stockId: 'stock-a',
          materialId: 'dna',
          source: { kind: 'unattributed', rootStockId: 'stock-a' },
          composition: { kind: 'unknown' },
        },
      ],
    });
  });

  it('pools exact mixed-unit inputs into an explicit derived lot', () => {
    const state = apply(fixture(), {
      kind: 'pool',
      lotId: 'pool',
      stockId: 'pooled',
      vesselId: 'c',
      materialId: 'dna',
      name: 'Pooled DNA',
      inputs: [
        { stockId: 'stock-a', quantity: { value: '12.5', unit: 'uL' } },
        { stockId: 'stock-b', quantity: { value: '7500', unit: 'nL' } },
      ],
      reason: 'Pool preparations',
    });
    expect(state.stocks.pooled.quantity).toEqual({ kind: 'known', value: '20', unit: 'uL' });
    expect(state.stocks['stock-a'].quantity).toMatchObject({ value: '87.5' });
    expect(state.stocks['stock-b'].quantity).toMatchObject({ value: '92.5' });
    expect(state.lots.pool.origin).toMatchObject({
      kind: 'pooled',
      inputs: [
        { source: { rootStockId: 'stock-a' }, quantity: { value: '12.5', unit: 'uL' } },
        { source: { rootStockId: 'stock-b' }, quantity: { value: '7.5', unit: 'uL' } },
      ],
    });
  });

  it('requires a tracked diluent and retains each contribution’s material identity', () => {
    let state = apply(fixture(), {
      kind: 'receive-stock',
      id: 'water',
      vesselId: 'd',
      materialId: 'water',
      quantity: { kind: 'known', value: '1', unit: 'mL' },
      quality: 'usable',
    });
    state = apply(state, {
      kind: 'dilute',
      lotId: 'dilution',
      stockId: 'diluted',
      vesselId: 'c',
      materialId: 'diluted-dna',
      name: 'DNA in water',
      sample: { stockId: 'stock-a', quantity: { value: '10', unit: 'uL' } },
      diluent: { stockId: 'water', quantity: { value: '90', unit: 'uL' } },
      reason: 'Prepare working solution',
    });
    expect(state.stocks.diluted.quantity).toMatchObject({ value: '100' });
    expect(state.stocks.water.quantity).toMatchObject({ value: '910' });
    expect(state.lots.dilution.origin).toMatchObject({
      kind: 'diluted',
      sample: { materialId: 'dna' },
      diluent: { materialId: 'water' },
    });
  });

  it('refuses duplicate sources without debiting anything', () => {
    refused(
      fixture(),
      {
        kind: 'pool',
        lotId: 'lot',
        stockId: 'out',
        vesselId: 'c',
        materialId: 'dna',
        name: 'Pool',
        inputs: [
          { stockId: 'stock-a', quantity: { value: '5', unit: 'uL' } },
          { stockId: 'stock-a', quantity: { value: '5', unit: 'uL' } },
        ],
        reason: 'Pool',
      },
      'INVALID_INVENTORY_INPUT'
    );
  });

  it('refuses source dead-volume violations and destination capacity overflow atomically', () => {
    let state = apply(fixture(), {
      kind: 'set-vessel-limits',
      vesselId: 'a',
      limits: {
        capacity: { kind: 'known', value: '100', unit: 'uL' },
        deadVolume: { kind: 'known', value: '90', unit: 'uL' },
      },
      reason: 'Verified tube specs',
    });
    refused(state, transfer(), 'DEAD_VOLUME_REQUIRED');
    state = apply(state, {
      kind: 'set-vessel-limits',
      vesselId: 'c',
      limits: {
        capacity: { kind: 'known', value: '5', unit: 'uL' },
        deadVolume: { kind: 'unknown' },
      },
      reason: 'Verified destination capacity',
    });
    refused(
      state,
      { ...transfer(), quantity: { value: '10', unit: 'uL' } } as InventoryCommand,
      'CAPACITY_EXCEEDED'
    );
  });

  it('enforces limits during old receive, consume and measurement commands too', () => {
    const state = apply(fixture(), {
      kind: 'set-vessel-limits',
      vesselId: 'a',
      limits: {
        capacity: { kind: 'known', value: '100', unit: 'uL' },
        deadVolume: { kind: 'known', value: '90', unit: 'uL' },
      },
      reason: 'Verified specs',
    });
    refused(
      state,
      {
        kind: 'consume',
        stockId: 'stock-a',
        quantity: { value: '20', unit: 'uL' },
        reason: 'Experiment',
      },
      'DEAD_VOLUME_REQUIRED'
    );
    refused(
      state,
      {
        kind: 'reconcile',
        stockId: 'stock-a',
        quantity: { kind: 'known', value: '101', unit: 'uL' },
        reason: 'Measurement',
      },
      'CAPACITY_EXCEEDED'
    );
  });

  it('rolls back an earlier accepted debit when a later command fails', () => {
    const state = fixture();
    const bytes = JSON.stringify(state);
    expect(
      applyInventoryCommandBatch(state, {
        expectedRevision: state.revision,
        commands: [
          transfer(),
          {
            kind: 'consume',
            stockId: 'stock-b',
            quantity: { value: '101', unit: 'uL' },
            reason: 'Too much',
          },
        ],
      })
    ).toMatchObject({ ok: false, code: 'INSUFFICIENT_QUANTITY' });
    expect(JSON.stringify(state)).toBe(bytes);
  });

  it('migrates a frozen v2 snapshot to separate unattributed roots without changing source bytes', () => {
    const snapshot =
      '{"schema":"dnaforge.inventory.v2","revision":3,"storage":{},"vessels":{"a":{"kind":"movable","id":"a","name":"A","placement":{"kind":"unplaced"},"lifecycle":"active"}},"stocks":{"x":{"id":"x","vesselId":"a","materialId":"dna","quantity":{"kind":"known","value":"7","unit":"uL"},"quality":"usable"}}}';
    const input = JSON.parse(snapshot);
    const state = parseInventoryState(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(state.revision).toBe(3);
    expect(state.stocks.x.source).toEqual({ kind: 'unattributed', rootStockId: 'x' });
    expect(state.vessels.a.limits).toEqual({
      capacity: { kind: 'unknown' },
      deadVolume: { kind: 'unknown' },
    });
    expect(state.lots).toEqual({});
  });

  it('refuses cyclic saved lot provenance without following mutable stock attribution', () => {
    const state = apply(
      fixture(),
      ...['first', 'second'].map((id) => ({
        kind: 'create-lot' as const,
        id,
        materialId: 'dna',
        name: id,
        origin: { kind: 'received' as const, supplier: 'Supplier', lotNumber: id },
      }))
    );
    const raw = JSON.parse(JSON.stringify(state));
    for (const [id, parent] of [
      ['first', 'second'],
      ['second', 'first'],
    ])
      raw.lots[id].origin = {
        kind: 'prepared',
        method: 'Recorded process',
        inputs: [
          {
            stockId: 'stock-a',
            materialId: 'dna',
            source: { kind: 'lot', lotId: parent },
            composition: { kind: 'unknown' },
          },
        ],
      };
    expect(() => parseInventoryState(raw)).toThrow(/cycle/);
  });

  it('publishes the same decimal constraint used by the command parser', () => {
    const schema = inventoryCommandJsonSchema();
    expect(JSON.stringify(schema)).toContain('(?:0|[1-9]');
  });
});
