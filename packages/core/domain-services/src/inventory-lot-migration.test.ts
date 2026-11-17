import { describe, expect, it } from 'vitest';
import { applyInventoryCommandBatch } from './inventory-state';
import {
  createInventoryState,
  INVENTORY_SCHEMA,
  type InventoryCommand,
  type InventoryState,
} from './inventory-types';
import { parseInventoryCommand, parseInventoryState } from './inventory-validation';

const context = {
  at: 10,
  principal: { kind: 'local-profile' as const, profileKey: 'lot-migration' },
  authority: { kind: 'local-profile' as const, profileKey: 'lot-migration' },
};
function accepted(state: InventoryState, commands: readonly InventoryCommand[]): InventoryState {
  const result = applyInventoryCommandBatch(
    state,
    { expectedRevision: state.revision, commands },
    context
  );
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.state;
}
function source(): InventoryState {
  return accepted(createInventoryState(), [
    { kind: 'create-vessel', id: 'vessel', name: 'Source', placement: { kind: 'unplaced' } },
    ...['a', 'b'].map((id) => ({
      kind: 'create-lot' as const,
      id,
      materialId: 'material',
      name: id,
      origin: { kind: 'received' as const, supplier: 'Supplier', lotNumber: id },
    })),
    {
      kind: 'receive-lot-stock',
      id: 'stock',
      vesselId: 'vessel',
      lotId: 'a',
      quantity: { kind: 'unknown', unit: 'ng' },
      quality: 'usable',
    },
    { kind: 'associate-stock-lot', stockId: 'stock', lotId: 'b', reason: 'Updated association' },
    {
      kind: 'create-lot',
      id: 'prepared',
      materialId: 'material',
      name: 'Preparation',
      origin: { kind: 'prepared', sourceStockIds: ['stock'], method: 'Recorded preparation' },
    },
  ]);
}
function legacy(state: InventoryState): unknown {
  const {
    arrivals: _arrivals,
    lotRecalls: _recalls,
    openingObservations: _openingObservations,
    validityFacts: _validityFacts,
    ...rest
  } = state;
  return {
    ...rest,
    schema: 'dnaforge.inventory.v18',
    stocks: Object.fromEntries(
      Object.entries(state.stocks).map(
        ([
          id,
          {
            lotConstraints: _constraints,
            opening: _opening,
            validity: _validity,
            inheritedValidity: _inheritedValidity,
            ...stock
          },
        ]) => [id, stock]
      )
    ),
    lots: Object.fromEntries(
      Object.entries(state.lots).map(
        ([
          id,
          {
            controls: _controls,
            lotConstraints: _constraints,
            validity: _validity,
            inheritedValidity: _inheritedValidity,
            ...lot
          },
        ]) => [id, lot]
      )
    ),
  };
}

describe('lot control state compatibility', () => {
  it('derives only provable legacy owners without inventing erased associations or changing input', () => {
    const state = source();
    expect(state.stocks.stock.lotConstraints.lotIds).toEqual(['a', 'b']);
    const old = legacy(state);
    const original = JSON.stringify(old);
    const parsed = parseInventoryState(old);
    expect(parsed.schema).toBe(INVENTORY_SCHEMA);
    expect(parsed.stocks.stock.lotConstraints).toEqual({
      knowledge: 'legacy-partial',
      lotIds: ['b'],
    });
    expect(parsed.lots.prepared.lotConstraints).toEqual({
      knowledge: 'legacy-partial',
      lotIds: ['b', 'prepared'],
    });
    expect(parsed.lots.a.controls).toEqual({ kind: 'legacy-untracked' });
    expect(parsed.lotRecalls).toEqual({});
    expect(parsed.stocks.stock.quantity).toEqual({ kind: 'unknown', unit: 'ng' });
    expect(JSON.stringify(old)).toBe(original);
  });

  it('preserves current constraints without projecting away earlier associations', () => {
    const state = source();
    expect(parseInventoryState(state)).toEqual(state);
    expect(state.lots.prepared.lotConstraints).toEqual({
      knowledge: 'recorded',
      lotIds: ['a', 'b', 'prepared'],
    });
  });

  it.each([
    { lotIds: ['b', 'a'] },
    { lotIds: ['a', 'a', 'b'] },
    { lotIds: ['a'] },
    { lotIds: ['a', 'b', 'missing'] },
  ])('refuses invalid canonical owners %j', ({ lotIds }) => {
    const state = source();
    expect(() =>
      parseInventoryState({
        ...state,
        stocks: {
          ...state.stocks,
          stock: { ...state.stocks.stock, lotConstraints: { knowledge: 'recorded', lotIds } },
        },
      })
    ).toThrow();
  });

  it('does not promote partial source knowledge or erase immutable preparation owners', () => {
    const state = parseInventoryState(legacy(source()));
    const received = accepted(state, [
      {
        kind: 'create-vessel',
        id: 'second-vessel',
        name: 'Second',
        placement: { kind: 'unplaced' },
      },
      {
        kind: 'receive-lot-stock',
        id: 'second-stock',
        vesselId: 'second-vessel',
        lotId: 'prepared',
        quantity: { kind: 'known', value: '2', unit: 'mg' },
        quality: 'usable',
      },
    ]);
    expect(received.stocks['second-stock'].lotConstraints.knowledge).toBe('legacy-partial');
    expect(() =>
      parseInventoryState({
        ...received,
        stocks: {
          ...received.stocks,
          'second-stock': {
            ...received.stocks['second-stock'],
            lotConstraints: { knowledge: 'recorded', lotIds: ['b', 'prepared'] },
          },
        },
      })
    ).toThrow();
    expect(() =>
      parseInventoryState({
        ...state,
        lots: {
          ...state.lots,
          prepared: {
            ...state.lots.prepared,
            lotConstraints: { knowledge: 'legacy-partial', lotIds: ['prepared'] },
          },
        },
      })
    ).toThrow();
  });

  it('rejects forged local assessment and recall clocks and cross-kind identifiers', () => {
    const state = accepted(source(), [
      { kind: 'manage-lot', lotId: 'a', reason: 'Begin local controls' },
      {
        kind: 'record-lot-recall',
        id: 'recall',
        lotId: 'a',
        observedAt: null,
        source: null,
        reason: 'Supplier notice',
      },
    ]);
    const lot = state.lots.a;
    const controls = lot.controls;
    if (controls.kind !== 'managed') throw new Error('Managed lot required');
    expect(() =>
      parseInventoryState({
        ...state,
        lots: {
          ...state.lots,
          a: {
            ...lot,
            controls: { ...controls, assessment: { ...controls.assessment, at: 11 } },
          },
        },
      })
    ).toThrow();
    for (const changes of [
      { at: 11 },
      { observedAt: 11 },
      { id: 'stock' },
      { lifecycle: { kind: 'withdrawn', at: 9, by: context.principal, reason: 'Correction' } },
    ])
      expect(() =>
        parseInventoryState({
          ...state,
          lotRecalls: { recall: { ...state.lotRecalls.recall, ...changes } },
        })
      ).toThrow();
    expect(() =>
      parseInventoryState({
        ...state,
        lotRecalls: { stock: { ...state.lotRecalls.recall, id: 'stock' } },
      })
    ).toThrow(/identifiers must be distinct/);
    expect(parseInventoryState(state)).toEqual(state);
  });

  it('retains exact old command input and rejects native attribution in new control commands', () => {
    const old = {
      kind: 'receive-stock',
      id: 's',
      vesselId: 'v',
      materialId: 'm',
      quantity: { kind: 'unknown' },
      quality: 'usable',
    };
    expect(parseInventoryCommand(old)).toEqual(old);
    const command = {
      kind: 'assess-lot',
      lotId: 'a',
      assessment: 'released',
      reason: 'Local decision',
    };
    expect(parseInventoryCommand(command)).toEqual(command);
    expect(() => parseInventoryCommand({ ...command, at: 10, by: context.principal })).toThrow();
    expect(() =>
      parseInventoryState({ ...(legacy(source()) as object), lotRecalls: {} })
    ).toThrow();
  });
});
