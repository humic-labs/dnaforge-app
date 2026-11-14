import { describe, expect, it } from 'vitest';
import {
  applyInventoryCommandBatch,
  createInventoryState,
  parseInventoryCommandBatch,
  parseInventoryState,
  type InventoryState,
} from './inventory';

const V1_SEED =
  '{"expectedRevision":0,"commands":[{"kind":"create-storage","id":"freezer","name":"Freezer","slots":["shelf"],"placement":{"kind":"root"}},{"kind":"create-storage","id":"box","name":"Box","slots":["A1"],"placement":{"kind":"located","storageId":"freezer","slotId":"shelf"}},{"kind":"create-vessel","id":"tube","name":"Tube","placement":{"kind":"located","storageId":"box","slotId":"A1"}},{"kind":"receive-stock","id":"stock","vesselId":"tube","materialId":"material","quantity":{"kind":"known","value":"100","unit":"uL"},"quality":"usable"}]}';
const V1_CONSUME =
  '{"expectedRevision":1,"commands":[{"kind":"consume","stockId":"stock","quantity":{"value":"20","unit":"uL"},"reason":"PCR"}]}';
const V1_SNAPSHOT =
  '{"schema":"dnaforge.inventory.v1","revision":2,"storage":{"freezer":{"id":"freezer","name":"Freezer","slots":["shelf"],"placement":{"kind":"root"}},"box":{"id":"box","name":"Box","slots":["A1"],"placement":{"kind":"located","storageId":"freezer","slotId":"shelf"}}},"vessels":{"tube":{"id":"tube","name":"Tube","placement":{"kind":"located","storageId":"box","slotId":"A1"},"lifecycle":"active"}},"stocks":{"stock":{"id":"stock","vesselId":"tube","materialId":"material","quantity":{"kind":"known","value":"80","unit":"uL"},"quality":"usable"}}}';

describe('frozen inventory v1 compatibility', () => {
  it('preserves exact legacy parsed request shapes without adding layout or vessel defaults', () => {
    expect(JSON.stringify(parseInventoryCommandBatch(JSON.parse(V1_SEED)))).toBe(V1_SEED);
    expect(JSON.stringify(parseInventoryCommandBatch(JSON.parse(V1_CONSUME)))).toBe(V1_CONSUME);
  });

  it('upcasts a frozen snapshot without changing its source bytes or inventory revision', () => {
    const raw = JSON.parse(V1_SNAPSHOT) as unknown;
    const state = parseInventoryState(raw);
    expect(JSON.stringify(raw)).toBe(V1_SNAPSHOT);
    expect(state.schema).toBe('dnaforge.inventory.v4');
    expect(state.revision).toBe(2);
    expect(state.storage.box.layout).toEqual({ kind: 'named', slots: ['A1'] });
    expect(state.storage.box.lifecycle).toBe('active');
    expect(state.vessels.tube.kind).toBe('movable');
    expect(state.stocks.stock.quantity).toEqual({ kind: 'known', value: '80', unit: 'uL' });
  });

  it('replays frozen v1 commands to the same canonical state as the migrated snapshot', () => {
    let state: InventoryState = createInventoryState();
    for (const raw of [V1_SEED, V1_CONSUME]) {
      const result = applyInventoryCommandBatch(state, parseInventoryCommandBatch(JSON.parse(raw)));
      if (!result.ok) throw new Error(result.message);
      state = result.state;
    }
    expect(state).toEqual(parseInventoryState(JSON.parse(V1_SNAPSHOT)));
    expect(parseInventoryState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });
});
