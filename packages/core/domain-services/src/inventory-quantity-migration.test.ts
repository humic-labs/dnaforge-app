import { describe, expect, it } from 'vitest';
import { createInventoryState, INVENTORY_SCHEMA } from './inventory-types';
import { parseInventoryCommandBatch, parseInventoryState } from './inventory-validation';
import { emptyInventoryPhysicalConfiguration } from './inventory-geometry';
import { inventoryTableBindingKey, inventoryTableSha256 } from './inventory-table-binding';
import { inventoryObservationKey } from './inventory-observation-identity';
import { normalizeInventoryQuantity } from './inventory-quantity';
import { emptyInventoryStockValidity } from './inventory-validity';

const principal = { kind: 'local-profile' as const, profileKey: 'a'.repeat(64) };
function fixture(
  quantity: unknown = { kind: 'unknown', unit: 'uL' },
  schema = INVENTORY_SCHEMA as string
) {
  const vessel = (id: string) => ({
    kind: 'movable' as const,
    id,
    name: id,
    placement: { kind: 'unplaced' as const },
    lifecycle: 'active' as const,
    custody: { kind: 'available' as const },
    contentsKnowledge: { kind: 'recorded' as const },
    limits: { capacity: { kind: 'unknown' as const }, deadVolume: { kind: 'unknown' as const } },
    configuration: emptyInventoryPhysicalConfiguration(),
  });
  const {
    expectedDeliveries,
    arrivalAllocations,
    reorderRules,
    arrivals,
    lotRecalls,
    openingObservations,
    validityFacts,
    ...legacyBase
  } = createInventoryState();
  const state = {
    ...(schema === INVENTORY_SCHEMA
      ? {
          ...legacyBase,
          expectedDeliveries,
          arrivalAllocations,
          reorderRules,
          arrivals,
          lotRecalls,
          openingObservations,
          validityFacts,
        }
      : legacyBase),
    schema,
    lastRecordedAt: 100,
    revision: 1,
    vessels: {
      tube: vessel('tube'),
      unobserved: {
        ...vessel('unobserved'),
        contentsKnowledge: {
          kind: 'unobserved' as const,
          at: 1,
          by: principal,
          reason: 'Contents were not observed',
        },
      },
    },
    stocks: {
      stock: {
        ...(schema === INVENTORY_SCHEMA
          ? {
              ...emptyInventoryStockValidity(),
              lotConstraints: { knowledge: 'recorded' as const, lotIds: [] },
            }
          : {}),
        id: 'stock',
        vesselId: 'tube',
        materialId: 'material',
        source: { kind: 'unattributed' as const, rootStockId: 'stock' },
        quantity,
        quality: 'usable' as const,
        composition: { kind: 'unknown' as const },
      },
    },
    vesselBindings: {
      [inventoryTableBindingKey('source', 'tube')]: {
        namespace: 'source',
        sourceId: 'tube',
        rowSha256: inventoryTableSha256('physical source'),
        vesselId: 'tube',
        origin: { kind: 'movable' as const, placement: { kind: 'unplaced' as const } },
      },
    },
  };
  return state;
}

describe('declared quantity basis migration', () => {
  it.each(['uL', 'ng', 'nmol', 'item'] as const)(
    'retains explicit canonical basis %s even when amount is unknown',
    (unit) => {
      const state = parseInventoryState(fixture({ kind: 'unknown', unit }));
      expect(state.schema).toBe(INVENTORY_SCHEMA);
      expect(state.stocks.stock.quantity).toEqual({ kind: 'unknown', unit });
      expect(parseInventoryState(state)).toEqual(state);
      expect(state.vessels.tube.limits).toEqual({
        capacity: { kind: 'unknown' },
        deadVolume: { kind: 'unknown' },
      });
    }
  );
  it('upcasts the established v17 volume basis without inventing amounts, contents or actors', () => {
    const previous = fixture({ kind: 'unknown' }, 'dnaforge.inventory.v17');
    const before = JSON.stringify(previous);
    const state = parseInventoryState(previous);
    expect(state.stocks.stock.quantity).toEqual({ kind: 'unknown', unit: 'uL' });
    expect(state.vesselBindings).toEqual(previous.vesselBindings);
    expect(state.vessels.unobserved.contentsKnowledge).toEqual(
      previous.vessels.unobserved.contentsKnowledge
    );
    expect(state.lastRecordedAt).toBe(previous.lastRecordedAt);
    expect(state.revision).toBe(previous.revision);
    expect(JSON.stringify(previous)).toBe(before);
  });
  it('migrates old unknown-volume observations without changing observation or recording facts', () => {
    const previous = fixture({ kind: 'unknown' }, 'dnaforge.inventory.v17');
    const key = inventoryObservationKey('stocktake', 'observation');
    const fact = {
      namespace: 'stocktake',
      observationId: 'observation',
      subject: { kind: 'stock', stockId: 'stock' },
      observedAt: null,
      fact: { kind: 'quantity', quantity: { kind: 'unknown' } },
      reason: 'Source amount omitted',
      at: 90,
      by: principal,
      application: { kind: 'unapplied' },
    };
    const state = parseInventoryState({ ...previous, observations: { [key]: fact } });
    expect(state.observations[key]).toEqual({
      ...fact,
      fact: { kind: 'quantity', quantity: { kind: 'unknown', unit: 'uL' } },
    });
  });
  it('requires canonical declared units in current stored quantities', () => {
    for (const quantity of [
      { kind: 'unknown' },
      { kind: 'unknown', unit: 'mg' },
      { kind: 'known', unit: 'mg', value: '1' },
      { kind: 'known', unit: 'item', value: '0.5' },
    ])
      expect(() => parseInventoryState(fixture(quantity))).toThrow();
    expect(
      parseInventoryState(fixture({ kind: 'known', unit: 'ng', value: '1000000' })).stocks.stock
        .quantity
    ).toEqual({ kind: 'known', unit: 'ng', value: '1000000' });
  });
  it('does not reinterpret legacy stored volume schemas as mass or count storage', () => {
    for (const quantity of [
      { kind: 'known', unit: 'ng', value: '1' },
      { kind: 'unknown', unit: 'item' },
    ])
      expect(() => parseInventoryState(fixture(quantity, 'dnaforge.inventory.v17'))).toThrow();
    const reservation = {
      id: 'claim',
      kind: 'quantity',
      stockId: 'stock',
      holder: principal,
      purpose: 'Original hold',
      createdAt: 1,
      deadline: null,
      lifecycle: { kind: 'fulfilled', at: 50 },
      quantity: { value: '1', unit: 'ng' },
      remaining: { value: '0', unit: 'ng' },
    };
    expect(() =>
      parseInventoryState({
        ...fixture({ kind: 'unknown' }, 'dnaforge.inventory.v17'),
        reservations: { claim: reservation },
      })
    ).toThrow();
  });
  it('retains another-dimension observations as unapplied evidence but refuses a forged applied claim', () => {
    const key = inventoryObservationKey('measurement', 'volume-observation');
    const observation = {
      namespace: 'measurement',
      observationId: 'volume-observation',
      subject: { kind: 'stock', stockId: 'stock' },
      observedAt: 50,
      fact: { kind: 'quantity', quantity: { kind: 'known', value: '5', unit: 'uL' } },
      reason: 'A different measured dimension',
      at: 90,
      by: principal,
      application: { kind: 'unapplied' },
    };
    const state = {
      ...fixture({ kind: 'known', value: '1000', unit: 'ng' }),
      observations: { [key]: observation },
    };
    expect(parseInventoryState(state).observations[key].application.kind).toBe('unapplied');
    expect(() =>
      parseInventoryState({
        ...state,
        observations: {
          [key]: {
            ...observation,
            application: {
              kind: 'applied',
              reason: 'Cannot claim a conversion',
              at: 100,
              by: principal,
            },
          },
        },
      })
    ).toThrow(/balance basis/);
  });
  it('keeps quantity reservation basis consistent with its stock for active and terminal claims', () => {
    for (const lifecycle of [{ kind: 'active' }, { kind: 'fulfilled', at: 50 }]) {
      const reservation = {
        id: 'claim',
        kind: 'quantity',
        stockId: 'stock',
        holder: principal,
        purpose: 'A hold',
        createdAt: 1,
        deadline: null,
        lifecycle,
        quantity: { value: '1', unit: 'uL' },
        remaining: { value: lifecycle.kind === 'active' ? '1' : '0', unit: 'uL' },
      };
      expect(() =>
        parseInventoryState({
          ...fixture({ kind: 'known', unit: 'ng', value: '1000' }),
          reservations: { claim: reservation },
        })
      ).toThrow(/balance basis/);
    }
  });
  it('keeps accepted legacy unknown and compatible-prefix request values intact until mutation', () => {
    for (const quantity of [
      { kind: 'unknown' },
      { kind: 'unknown', unit: 'mg' },
      { kind: 'known', unit: 'mg', value: '1.2500' },
    ]) {
      const input = {
        expectedRevision: 0,
        commands: [
          {
            kind: 'receive-stock',
            id: 'new-stock',
            vesselId: 'tube',
            materialId: 'material',
            quantity,
            quality: 'usable',
          },
        ],
      };
      expect(parseInventoryCommandBatch(input)).toEqual(input);
    }
    expect(normalizeInventoryQuantity({ kind: 'unknown' })).toEqual({
      kind: 'unknown',
      unit: 'uL',
    });
    expect(normalizeInventoryQuantity({ kind: 'unknown', unit: 'mg' })).toEqual({
      kind: 'unknown',
      unit: 'ng',
    });
    expect(normalizeInventoryQuantity({ kind: 'known', unit: 'mg', value: '1.25' })).toEqual({
      kind: 'known',
      unit: 'ng',
      value: '1250000',
    });
  });
  it('keeps physical limits and mixture contributions volume-specific', () => {
    expect(() =>
      parseInventoryCommandBatch({
        expectedRevision: 0,
        commands: [
          {
            kind: 'set-vessel-limits',
            vesselId: 'tube',
            limits: {
              capacity: { kind: 'known', unit: 'mg', value: '1' },
              deadVolume: { kind: 'unknown' },
            },
            reason: 'Wrong physical dimension',
          },
        ],
      })
    ).toThrow();
    expect(() =>
      parseInventoryCommandBatch({
        expectedRevision: 0,
        commands: [
          {
            kind: 'pool',
            lotId: 'lot',
            stockId: 'result',
            vesselId: 'destination',
            materialId: 'material',
            name: 'Pool',
            inputs: [
              { stockId: 'stock', quantity: { value: '1', unit: 'mg' } },
              { stockId: 'other', quantity: { value: '1', unit: 'mg' } },
            ],
            mixing: 'homogeneous',
            reason: 'Wrong mixture dimension',
          },
        ],
      })
    ).toThrow();
  });
});
