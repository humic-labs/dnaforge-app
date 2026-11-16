import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  applyInventoryCommandBatch,
  createInventoryState,
  parseInventoryCommandBatch,
  parseInventoryState,
  type InventoryState,
} from './inventory';

const V3_SEED =
  '{"expectedRevision":0,"commands":[{"kind":"create-vessel","id":"a","name":"a","placement":{"kind":"unplaced"}},{"kind":"create-vessel","id":"b","name":"b","placement":{"kind":"unplaced"}},{"kind":"create-vessel","id":"c","name":"c","placement":{"kind":"unplaced"}},{"kind":"create-vessel","id":"d","name":"d","placement":{"kind":"unplaced"}},{"kind":"create-vessel","id":"e","name":"e","placement":{"kind":"unplaced"}},{"kind":"create-vessel","id":"f","name":"f","placement":{"kind":"unplaced"}},{"kind":"receive-stock","id":"sa","vesselId":"a","materialId":"dna","quantity":{"kind":"known","value":"100","unit":"uL"},"quality":"usable"},{"kind":"receive-stock","id":"sb","vesselId":"b","materialId":"dna","quantity":{"kind":"known","value":"100","unit":"uL"},"quality":"usable"}]}';
const V3_DERIVE =
  '{"expectedRevision":1,"commands":[{"kind":"create-lot","id":"prep","materialId":"dna","name":"Preparation","origin":{"kind":"prepared","sourceStockIds":["sa","sb"],"method":"Preparation"}},{"kind":"receive-lot-stock","id":"prepared","vesselId":"c","lotId":"prep","quantity":{"kind":"unknown"},"quality":"usable"},{"kind":"transfer","sourceStockId":"sa","quantity":{"value":"10","unit":"uL"},"destination":{"kind":"new-stock","stockId":"aliquot","vesselId":"d"},"reason":"Aliquot"},{"kind":"transfer","sourceStockId":"aliquot","quantity":{"value":"1","unit":"uL"},"destination":{"kind":"existing-stock","stockId":"sa"},"reason":"Return aliquot"},{"kind":"pool","lotId":"pool","stockId":"pooled","vesselId":"e","materialId":"dna","name":"Pool","reason":"Pool","inputs":[{"stockId":"sa","quantity":{"value":"5","unit":"uL"}},{"stockId":"sb","quantity":{"value":"15","unit":"uL"}}]},{"kind":"dilute","lotId":"dilution","stockId":"diluted","vesselId":"f","materialId":"dna","name":"Dilution","reason":"Dilute","sample":{"stockId":"sa","quantity":{"value":"1","unit":"uL"}},"diluent":{"stockId":"sb","quantity":{"value":"2","unit":"uL"}}}]}';
const V3_SNAPSHOT = `{
  "schema":"dnaforge.inventory.v3","revision":2,"storage":{},
  "vessels":{
    "a":{"kind":"movable","id":"a","name":"a","placement":{"kind":"unplaced"},"lifecycle":"active","limits":{"capacity":{"kind":"unknown"},"deadVolume":{"kind":"unknown"}}},
    "b":{"kind":"movable","id":"b","name":"b","placement":{"kind":"unplaced"},"lifecycle":"active","limits":{"capacity":{"kind":"unknown"},"deadVolume":{"kind":"unknown"}}},
    "c":{"kind":"movable","id":"c","name":"c","placement":{"kind":"unplaced"},"lifecycle":"active","limits":{"capacity":{"kind":"unknown"},"deadVolume":{"kind":"unknown"}}},
    "d":{"kind":"movable","id":"d","name":"d","placement":{"kind":"unplaced"},"lifecycle":"active","limits":{"capacity":{"kind":"unknown"},"deadVolume":{"kind":"unknown"}}},
    "e":{"kind":"movable","id":"e","name":"e","placement":{"kind":"unplaced"},"lifecycle":"active","limits":{"capacity":{"kind":"unknown"},"deadVolume":{"kind":"unknown"}}},
    "f":{"kind":"movable","id":"f","name":"f","placement":{"kind":"unplaced"},"lifecycle":"active","limits":{"capacity":{"kind":"unknown"},"deadVolume":{"kind":"unknown"}}}
  },
  "stocks":{
    "sa":{"id":"sa","vesselId":"a","materialId":"dna","quantity":{"kind":"known","value":"85","unit":"uL"},"quality":"usable","source":{"kind":"unattributed","rootStockId":"sa"}},
    "sb":{"id":"sb","vesselId":"b","materialId":"dna","quantity":{"kind":"known","value":"83","unit":"uL"},"quality":"usable","source":{"kind":"unattributed","rootStockId":"sb"}},
    "prepared":{"id":"prepared","vesselId":"c","materialId":"dna","quantity":{"kind":"unknown"},"quality":"usable","source":{"kind":"lot","lotId":"prep"}},
    "aliquot":{"id":"aliquot","vesselId":"d","materialId":"dna","quantity":{"kind":"known","value":"9","unit":"uL"},"quality":"usable","source":{"kind":"unattributed","rootStockId":"sa"}},
    "pooled":{"id":"pooled","vesselId":"e","materialId":"dna","quantity":{"kind":"known","value":"20","unit":"uL"},"quality":"usable","source":{"kind":"lot","lotId":"pool"}},
    "diluted":{"id":"diluted","vesselId":"f","materialId":"dna","quantity":{"kind":"known","value":"3","unit":"uL"},"quality":"usable","source":{"kind":"lot","lotId":"dilution"}}
  },
  "lots":{
    "prep":{"id":"prep","materialId":"dna","name":"Preparation","origin":{"kind":"prepared","inputs":[{"stockId":"sa","materialId":"dna","source":{"kind":"unattributed","rootStockId":"sa"}},{"stockId":"sb","materialId":"dna","source":{"kind":"unattributed","rootStockId":"sb"}}],"method":"Preparation"}},
    "pool":{"id":"pool","materialId":"dna","name":"Pool","origin":{"kind":"pooled","inputs":[{"stockId":"sa","materialId":"dna","source":{"kind":"unattributed","rootStockId":"sa"},"quantity":{"value":"5","unit":"uL"}},{"stockId":"sb","materialId":"dna","source":{"kind":"unattributed","rootStockId":"sb"},"quantity":{"value":"15","unit":"uL"}}]}},
    "dilution":{"id":"dilution","materialId":"dna","name":"Dilution","origin":{"kind":"diluted","sample":{"stockId":"sa","materialId":"dna","source":{"kind":"unattributed","rootStockId":"sa"},"quantity":{"value":"1","unit":"uL"}},"diluent":{"stockId":"sb","materialId":"dna","source":{"kind":"unattributed","rootStockId":"sb"},"quantity":{"value":"2","unit":"uL"}}}}
  }
}`;

describe('frozen inventory v3 composition migration', () => {
  it('preserves every legacy request shape and its digest without adding mixing or composition', () => {
    for (const frozen of [V3_SEED, V3_DERIVE]) {
      const parsed = JSON.stringify(parseInventoryCommandBatch(JSON.parse(frozen)));
      expect(parsed).toBe(frozen);
      expect(createHash('sha256').update(parsed).digest('hex')).toBe(
        createHash('sha256').update(frozen).digest('hex')
      );
    }
  });

  it('upcasts old stocks, prepared identities and contribution snapshots without mutating input or revision', () => {
    const raw = JSON.parse(V3_SNAPSHOT);
    const before = JSON.stringify(raw);
    const state = parseInventoryState(raw);
    expect(JSON.stringify(raw)).toBe(before);
    expect(state.schema).toBe('dnaforge.inventory.v14');
    expect(state.revision).toBe(2);
    for (const stock of Object.values(state.stocks))
      expect(stock.composition).toEqual({ kind: 'unknown' });
    for (const lot of Object.values(state.lots)) {
      const { origin } = lot;
      const inputs =
        origin.kind === 'received'
          ? []
          : origin.kind === 'diluted'
            ? [origin.sample, origin.diluent]
            : origin.inputs;
      for (const input of inputs) expect(input.composition).toEqual({ kind: 'unknown' });
    }
    expect(parseInventoryState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it('replays all frozen legacy material commands to the same v4 state as the v3 snapshot', () => {
    let state: InventoryState = createInventoryState();
    for (const frozen of [V3_SEED, V3_DERIVE]) {
      const result = applyInventoryCommandBatch(
        state,
        parseInventoryCommandBatch(JSON.parse(frozen))
      );
      if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
      state = result.state;
    }
    expect(state).toEqual(parseInventoryState(JSON.parse(V3_SNAPSHOT)));
  });

  it('requires canonical composition on v4 stocks and each immutable source snapshot', () => {
    const state = parseInventoryState(JSON.parse(V3_SNAPSHOT));
    const missingStock = JSON.parse(JSON.stringify(state));
    delete missingStock.stocks.sa.composition;
    expect(() => parseInventoryState(missingStock)).toThrow();
    for (const lotId of ['prep', 'pool', 'dilution']) {
      const missingSource = JSON.parse(JSON.stringify(state));
      const { origin } = missingSource.lots[lotId];
      delete (origin.kind === 'diluted' ? origin.sample : origin.inputs[0]).composition;
      expect(() => parseInventoryState(missingSource)).toThrow();
    }
  });
});
