import { describe, expect, it } from 'vitest';
import {
  applyInventoryCommandBatch,
  createInventoryState,
  parseInventoryCommandBatch,
  parseInventoryState,
} from './inventory';

const V4_COMMANDS =
  '{"expectedRevision":0,"commands":[{"kind":"create-vessel","id":"a","name":"A","placement":{"kind":"unplaced"}},{"kind":"create-vessel","id":"b","name":"B","placement":{"kind":"unplaced"}},{"kind":"receive-stock","id":"stock","vesselId":"a","materialId":"dna","quantity":{"kind":"known","value":"100","unit":"uL"},"quality":"usable"},{"kind":"record-composition","stockId":"stock","composition":{"kind":"homogeneous","analytes":{"dna":{"kind":"known","unit":"ng/uL","numerator":"1","denominator":"3"}}},"reason":"Measured composition"},{"kind":"create-lot","id":"prep","materialId":"product","name":"Product","origin":{"kind":"prepared","sourceStockIds":["stock"],"method":"Preparation"}},{"kind":"receive-lot-stock","id":"product-stock","vesselId":"b","lotId":"prep","quantity":{"kind":"unknown"},"quality":"usable"}]}';
const V4_SNAPSHOT = `{
  "schema":"dnaforge.inventory.v4","revision":1,"storage":{},
  "vessels":{
    "a":{"kind":"movable","id":"a","name":"A","placement":{"kind":"unplaced"},"lifecycle":"active","limits":{"capacity":{"kind":"unknown"},"deadVolume":{"kind":"unknown"}}},
    "b":{"kind":"movable","id":"b","name":"B","placement":{"kind":"unplaced"},"lifecycle":"active","limits":{"capacity":{"kind":"unknown"},"deadVolume":{"kind":"unknown"}}}
  },
  "stocks":{
    "stock":{"id":"stock","vesselId":"a","source":{"kind":"unattributed","rootStockId":"stock"},"materialId":"dna","quantity":{"kind":"known","value":"100","unit":"uL"},"quality":"usable","composition":{"kind":"homogeneous","analytes":{"dna":{"kind":"known","unit":"ng/uL","numerator":"1","denominator":"3"}}}},
    "product-stock":{"id":"product-stock","vesselId":"b","source":{"kind":"lot","lotId":"prep"},"materialId":"product","quantity":{"kind":"unknown"},"quality":"usable","composition":{"kind":"unknown"}}
  },
  "lots":{
    "prep":{"id":"prep","materialId":"product","name":"Product","origin":{"kind":"prepared","inputs":[{"stockId":"stock","materialId":"dna","source":{"kind":"unattributed","rootStockId":"stock"},"composition":{"kind":"homogeneous","analytes":{"dna":{"kind":"known","unit":"ng/uL","numerator":"1","denominator":"3"}}}}],"method":"Preparation"}}
  }
}`;
const actor = {
  at: 100,
  principal: { kind: 'agent' as const, identityId: 'alice' },
  authority: { kind: 'local-profile' as const, profileKey: 'profile' },
};

describe('frozen inventory v4 reservation migration', () => {
  it('upcasts exact composition and immutable source facts without changing bytes, revision or clock history', () => {
    const raw = JSON.parse(V4_SNAPSHOT);
    const bytes = JSON.stringify(raw);
    const state = parseInventoryState(raw);
    expect(JSON.stringify(raw)).toBe(bytes);
    expect(state.schema).toBe('dnaforge.inventory.v15');
    expect(state.revision).toBe(1);
    expect(state.lastRecordedAt).toBe(0);
    expect(state.reservations).toEqual({});
    expect(state.stocks.stock.composition).toEqual(raw.stocks.stock.composition);
    expect(state.lots.prep.origin).toEqual(raw.lots.prep.origin);
    expect(parseInventoryState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it('preserves frozen v4 parsed request bytes and replays without a new receipt context', () => {
    const batch = parseInventoryCommandBatch(JSON.parse(V4_COMMANDS));
    expect(JSON.stringify(batch)).toBe(V4_COMMANDS);
    const result = applyInventoryCommandBatch(createInventoryState(), batch);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.state).toEqual(parseInventoryState(JSON.parse(V4_SNAPSHOT)));
    expect(result.state.lastRecordedAt).toBe(0);
  });

  it('adds contextual reservations after migration without changing prior scientific snapshots', () => {
    const before = parseInventoryState(JSON.parse(V4_SNAPSHOT));
    const result = applyInventoryCommandBatch(
      before,
      {
        expectedRevision: 1,
        commands: [
          {
            kind: 'reserve-quantity',
            id: 'hold',
            stockId: 'stock',
            quantity: { value: '40', unit: 'uL' },
            deadline: 200,
            purpose: 'Experiment',
          },
        ],
      },
      actor
    );
    if (!result.ok) throw new Error(result.message);
    expect(result.state.lastRecordedAt).toBe(100);
    expect(result.state.lots).toEqual(before.lots);
    expect(parseInventoryState(JSON.parse(JSON.stringify(result.state)))).toEqual(result.state);
    const legacyAfter = applyInventoryCommandBatch(result.state, {
      expectedRevision: 2,
      commands: [
        {
          kind: 'consume',
          stockId: 'stock',
          quantity: { value: '1', unit: 'uL' },
          reason: 'Legacy call',
        },
      ],
    });
    expect(legacyAfter.ok && legacyAfter.state.lastRecordedAt).toBe(100);
  });

  it('requires v5 clock and reservation fields and rejects inconsistent persisted lifecycles', () => {
    const before = parseInventoryState(JSON.parse(V4_SNAPSHOT));
    const result = applyInventoryCommandBatch(
      before,
      {
        expectedRevision: 1,
        commands: [
          {
            kind: 'reserve-quantity',
            id: 'hold',
            stockId: 'stock',
            quantity: { value: '40', unit: 'uL' },
            deadline: 200,
            purpose: 'Experiment',
          },
        ],
      },
      actor
    );
    if (!result.ok) throw new Error(result.message);
    for (const key of ['lastRecordedAt', 'reservations']) {
      const raw = JSON.parse(JSON.stringify(result.state));
      delete raw[key];
      expect(() => parseInventoryState(raw)).toThrow();
    }
    for (const mutate of [
      (raw: any) => {
        raw.reservations.hold.remaining.value = '41';
      },
      (raw: any) => {
        raw.reservations.hold.lifecycle = { kind: 'fulfilled', at: 100 };
      },
      (raw: any) => {
        raw.reservations.hold.lifecycle = { kind: 'expired', at: 100 };
      },
      (raw: any) => {
        raw.reservations.hold.createdAt = 101;
      },
    ]) {
      const raw = JSON.parse(JSON.stringify(result.state));
      mutate(raw);
      expect(() => parseInventoryState(raw)).toThrow();
    }
  });
});
