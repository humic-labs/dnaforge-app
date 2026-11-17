import { describe, expect, it } from 'vitest';
import { applyInventoryCommandBatch } from './inventory-state';
import {
  createInventoryState,
  type InventoryCommand,
  type InventoryState,
} from './inventory-types';
import { parseInventoryCommand, parseInventoryState } from './inventory-validation';
import { inventoryStockValidity } from './inventory-validity';

const principal = { kind: 'local-profile' as const, profileKey: 'validity-migration' };
function accept(
  state: InventoryState,
  at: number,
  commands: readonly InventoryCommand[]
): InventoryState {
  const result = applyInventoryCommandBatch(
    state,
    { expectedRevision: state.revision, commands },
    { at, principal, authority: principal }
  );
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.state;
}
function base(): InventoryState {
  return accept(createInventoryState(), 100, [
    { kind: 'create-vessel', id: 'a-vessel', name: 'Original', placement: { kind: 'unplaced' } },
    { kind: 'create-vessel', id: 'b-vessel', name: 'Aliquot', placement: { kind: 'unplaced' } },
    {
      kind: 'create-lot',
      id: 'lot',
      materialId: 'material',
      name: 'Batch',
      origin: { kind: 'received', supplier: 'Synthetic', lotNumber: '1' },
    },
    { kind: 'manage-lot', lotId: 'lot', reason: 'Local controls' },
    { kind: 'assess-lot', lotId: 'lot', assessment: 'released', reason: 'Local release' },
    {
      kind: 'receive-lot-stock',
      id: 'a',
      vesselId: 'a-vessel',
      lotId: 'lot',
      quantity: { kind: 'known', value: '100', unit: 'uL' },
      quality: 'usable',
    },
  ]);
}
function recorded(): InventoryState {
  let state = accept(base(), 100, [
    {
      kind: 'record-stock-opening',
      id: 'opening',
      stockId: 'a',
      value: 'opened',
      observedAt: 90,
      source: null,
      reason: 'Opening observed',
    },
    {
      kind: 'record-validity-decision',
      id: 'policy',
      owner: { kind: 'stock', stockId: 'a' },
      rule: { kind: 'after-opening', openingStockId: 'a', elapsedMs: 100 },
      sourceText: 'Synthetic elapsed limit\n100 milliseconds',
      sourcePrecision: 'elapsed-duration',
      source: null,
      reason: 'Explicit interpretation',
    },
  ]);
  state = accept(state, 110, [
    {
      kind: 'transfer',
      sourceStockId: 'a',
      quantity: { value: '20', unit: 'uL' },
      destination: { kind: 'new-stock', stockId: 'b', vesselId: 'b-vessel' },
      reason: 'Aliquot',
    },
  ]);
  return accept(state, 120, [
    {
      kind: 'correct-stock-opening',
      id: 'opening-next',
      stockId: 'a',
      supersedesId: 'opening',
      value: 'opened',
      observedAt: 115,
      source: null,
      reason: 'Correct reported time',
    },
    {
      kind: 'correct-validity-decision',
      id: 'policy-next',
      supersedesId: 'policy',
      rule: { kind: 'after-opening', openingStockId: 'a', elapsedMs: 101 },
      sourceText: 'Revised synthetic limit',
      sourcePrecision: 'elapsed-duration',
      source: null,
      reason: 'Correct interpretation',
    },
  ]);
}

describe('opening and expiry snapshot integrity', () => {
  it('upcasts actual v19 fields without changing lot controls, ancestry, recall map or clock', () => {
    const state = base();
    const {
      expectedDeliveries: _expected,
      arrivalAllocations: _allocations,
      reorderRules: _rules,
      arrivals: _arrivals,
      openingObservations: _openings,
      validityFacts: _facts,
      ...rest
    } = state;
    const previous = {
      ...rest,
      schema: 'dnaforge.inventory.v19',
      stocks: Object.fromEntries(
        Object.entries(state.stocks).map(
          ([
            id,
            { opening: _opening, validity: _validity, inheritedValidity: _inherited, ...stock },
          ]) => [id, stock]
        )
      ),
      lots: Object.fromEntries(
        Object.entries(state.lots).map(
          ([id, { validity: _validity, inheritedValidity: _inherited, ...lot }]) => [id, lot]
        )
      ),
    };
    const before = JSON.stringify(previous),
      parsed = parseInventoryState(previous);
    expect(parsed.lots.lot.controls).toEqual(state.lots.lot.controls);
    expect(parsed.stocks.a.lotConstraints).toEqual(state.stocks.a.lotConstraints);
    expect(parsed.lotRecalls).toEqual(state.lotRecalls);
    expect(parsed.lastRecordedAt).toBe(state.lastRecordedAt);
    expect(parsed.stocks.a.opening).toEqual({ kind: 'unobserved', observationId: null });
    expect(parsed.stocks.a.validity).toEqual({ kind: 'legacy-untracked' });
    expect(parsed.openingObservations).toEqual({});
    expect(parsed.validityFacts).toEqual({});
    expect(JSON.stringify(previous)).toBe(before);
  });

  it('retains contradictory corrections as evidence while blocking the inherited material', () => {
    const state = recorded();
    expect(parseInventoryState(state)).toEqual(state);
    expect(state.stocks.b.inheritedValidity).toEqual([
      { rootId: 'policy', openingNoLaterThan: 110 },
    ]);
    expect(inventoryStockValidity(state, 'b', 120)?.withdraw).toMatchObject({
      kind: 'blocked',
      blockers: [expect.objectContaining({ code: 'VALIDITY_CHRONOLOGY_CONFLICT' })],
    });
    const corrected = accept(state, 121, [
      {
        kind: 'correct-stock-opening',
        id: 'opening-unknown',
        stockId: 'a',
        supersedesId: 'opening-next',
        value: 'unobserved',
        observedAt: null,
        source: null,
        reason: 'Previous observation was unreliable',
      },
    ]);
    expect(parseInventoryState(corrected).stocks.a.opening).toEqual({
      kind: 'unobserved',
      observationId: 'opening-unknown',
    });
    expect(Object.keys(corrected.openingObservations)).toHaveLength(3);
    expect(corrected.stocks.b.inheritedValidity).toEqual(state.stocks.b.inheritedValidity);
  });

  it('rejects stale opening heads, forks and cross-owner successors', () => {
    const state = recorded();
    expect(() =>
      parseInventoryState({
        ...state,
        stocks: {
          ...state.stocks,
          a: { ...state.stocks.a, opening: { kind: 'opened-observed', observationId: 'opening' } },
        },
      })
    ).toThrow(/current same-owner/);
    const successor = state.openingObservations['opening-next'];
    expect(() =>
      parseInventoryState({
        ...state,
        openingObservations: { ...state.openingObservations, fork: { ...successor, id: 'fork' } },
      })
    ).toThrow(/fork/);
    expect(() =>
      parseInventoryState({
        ...state,
        openingObservations: {
          ...state.openingObservations,
          'opening-next': { ...successor, stockId: 'b' },
        },
      })
    ).toThrow(/same-family/);
  });

  it('rejects policy forks, owner changes and hidden families', () => {
    const state = recorded(),
      next = state.validityFacts['policy-next'];
    expect(() =>
      parseInventoryState({
        ...state,
        validityFacts: { ...state.validityFacts, fork: { ...next, id: 'fork' } },
      })
    ).toThrow(/fork/);
    expect(() =>
      parseInventoryState({
        ...state,
        validityFacts: {
          ...state.validityFacts,
          'policy-next': { ...next, owner: { kind: 'stock', stockId: 'b' } },
        },
      })
    ).toThrow(/original owner/);
    expect(() =>
      parseInventoryState({
        ...state,
        stocks: {
          ...state.stocks,
          a: { ...state.stocks.a, validity: { kind: 'legacy-untracked' } },
        },
      })
    ).toThrow(/every exact owned/);
  });

  it.each([{ bound: null }, { bound: 99 }, { bound: 121 }])(
    'rejects unproven physical bounds $bound',
    ({ bound }) => {
      const state = recorded();
      expect(() =>
        parseInventoryState({
          ...state,
          stocks: {
            ...state.stocks,
            b: {
              ...state.stocks.b,
              inheritedValidity: [{ rootId: 'policy', openingNoLaterThan: bound }],
            },
          },
        })
      ).toThrow();
    }
  );

  it('keeps calendar precision distinct from explicit UTC and refuses submitted native attribution', () => {
    const command = {
      kind: 'record-validity-decision',
      id: 'month-policy',
      owner: { kind: 'lot', lotId: 'lot' },
      rule: { kind: 'absolute', deadlineAt: 200 },
      sourceText: '2027-07',
      sourcePrecision: 'month',
      source: null,
      reason: 'Explicit cutoff interpretation',
    };
    expect(parseInventoryCommand(command)).toEqual(command);
    expect(() => parseInventoryCommand({ ...command, at: 100, by: principal })).toThrow();
    expect(() =>
      parseInventoryCommand({
        ...command,
        rule: { kind: 'after-opening', openingStockId: 'a', elapsedMs: 0 },
      })
    ).toThrow();
    expect(() =>
      parseInventoryCommand({
        ...command,
        rule: { kind: 'unresolved', rawText: 'Duplicate source' },
      })
    ).toThrow();
  });
});
