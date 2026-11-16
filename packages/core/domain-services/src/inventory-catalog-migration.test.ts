import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  applyInventoryCommandBatch,
  createInventoryState,
  inventoryCatalogProjection,
  parseInventoryCommandBatch,
  parseInventoryState,
} from './inventory';

const V7_REQUEST =
  '{"expectedRevision":0,"commands":[{"kind":"define-physical-type","id":"tube-v1","typeId":"tube","name":"Tube","description":"","fields":[],"sources":[],"definition":{"kind":"vessel","mobility":"movable","limits":{"capacity":{"kind":"known","value":"200","unit":"uL"},"deadVolume":{"kind":"known","value":"0","unit":"uL"}},"geometry":{"external":{"width":{"kind":"unknown"},"height":{"kind":"unknown"},"depth":{"kind":"unknown"}},"usable":{"width":{"kind":"unknown"},"height":{"kind":"unknown"},"depth":{"kind":"unknown"}}}}},{"kind":"define-equipment-recipe","id":"recipe-v1","recipeId":"recipe","name":"Recipe","description":"","model":{"manufacturer":"Custom","model":"Tube","partNumber":null,"region":null,"revision":null},"components":[{"key":"root","parentKey":null,"positionId":null,"name":"Tube","typeVersionId":"tube-v1"}],"sources":[]},{"kind":"instantiate-equipment-recipe","recipeVersionId":"recipe-v1","name":"Tube","components":[{"key":"root","id":"tube","metadata":{}}],"destination":{"kind":"unplaced"},"reason":"Install"},{"kind":"receive-stock","id":"stock","vesselId":"tube","materialId":"material","quantity":{"kind":"known","value":"100","unit":"uL"},"quality":"usable"},{"kind":"reserve-quantity","id":"hold","stockId":"stock","quantity":{"value":"40","unit":"uL"},"deadline":null,"purpose":"Experiment"}]}';
const V7_SNAPSHOT = `{
  "schema":"dnaforge.inventory.v7","revision":1,"lastRecordedAt":10,
  "typeVersions":{"tube-v1":{"id":"tube-v1","typeId":"tube","version":1,"name":"Tube","description":"","fields":[],"sources":[],"definition":{"kind":"vessel","mobility":"movable","limits":{"capacity":{"kind":"known","value":"200","unit":"uL"},"deadVolume":{"kind":"known","value":"0","unit":"uL"}},"geometry":{"external":{"width":{"kind":"unknown"},"height":{"kind":"unknown"},"depth":{"kind":"unknown"}},"usable":{"width":{"kind":"unknown"},"height":{"kind":"unknown"},"depth":{"kind":"unknown"}}}},"publishedAt":10,"publishedBy":{"kind":"agent","identityId":"alice"}}},
  "recipeVersions":{"recipe-v1":{"id":"recipe-v1","recipeId":"recipe","version":1,"name":"Recipe","description":"","model":{"manufacturer":"Custom","model":"Tube","partNumber":null,"region":null,"revision":null},"components":[{"key":"root","parentKey":null,"positionId":null,"name":"Tube","typeVersionId":"tube-v1"}],"sources":[],"publishedAt":10,"publishedBy":{"kind":"agent","identityId":"alice"}}},
  "fitEvidence":{},"storage":{},
  "vessels":{"tube":{"kind":"movable","id":"tube","name":"Tube","placement":{"kind":"unplaced"},"lifecycle":"active","limits":{"capacity":{"kind":"known","value":"200","unit":"uL"},"deadVolume":{"kind":"known","value":"0","unit":"uL"}},"custody":{"kind":"available"},"configuration":{"revision":1,"typeVersionId":"tube-v1","metadata":{},"geometryOverride":null,"orientation":{"kind":"unknown"},"unavailablePositions":{},"recipe":{"recipeVersionId":"recipe-v1","componentKey":"root"}}}},
  "stocks":{"stock":{"id":"stock","vesselId":"tube","source":{"kind":"unattributed","rootStockId":"stock"},"materialId":"material","quantity":{"kind":"known","value":"100","unit":"uL"},"quality":"usable","composition":{"kind":"unknown"}}},
  "lots":{},"reservations":{"hold":{"kind":"quantity","id":"hold","stockId":"stock","holder":{"kind":"agent","identityId":"alice"},"purpose":"Experiment","createdAt":10,"deadline":null,"lifecycle":{"kind":"active"},"quantity":{"value":"40","unit":"uL"},"remaining":{"value":"40","unit":"uL"}}}
}`;
const context = {
  at: 10,
  principal: { kind: 'agent' as const, identityId: 'alice' },
  authority: { kind: 'local-profile' as const, profileKey: 'profile' },
};

describe('frozen v7 catalog lifecycle migration', () => {
  it('upcasts selection state only without changing input, revision, recorded clock or installed facts', () => {
    const input = JSON.parse(V7_SNAPSHOT),
      bytes = JSON.stringify(input),
      state = parseInventoryState(input);
    expect(JSON.stringify(input)).toBe(bytes);
    expect(state.schema).toBe('dnaforge.inventory.v14');
    expect(state.revision).toBe(1);
    expect(state.lastRecordedAt).toBe(10);
    expect(state.typeVersions['tube-v1'].selection).toEqual({ kind: 'available' });
    expect(state.recipeVersions['recipe-v1'].selection).toEqual({ kind: 'available' });
    for (const key of ['storage', 'vessels', 'stocks', 'reservations', 'fitEvidence'] as const)
      expect(state[key]).toEqual(input[key]);
    expect(parseInventoryState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it('preserves frozen request bytes and their digest while replaying to the upcast snapshot', () => {
    const batch = parseInventoryCommandBatch(JSON.parse(V7_REQUEST)),
      parsedBytes = JSON.stringify(batch);
    expect(parsedBytes).toBe(V7_REQUEST);
    expect(createHash('sha256').update(parsedBytes).digest('hex')).toBe(
      createHash('sha256').update(V7_REQUEST).digest('hex')
    );
    const replay = applyInventoryCommandBatch(createInventoryState(), batch, context);
    expect(replay.ok && replay.state).toEqual(parseInventoryState(JSON.parse(V7_SNAPSHOT)));
  });

  it('round trips retired state and replays explicit restoration without changing installed facts', () => {
    const state = parseInventoryState(JSON.parse(V7_SNAPSHOT));
    const retired = applyInventoryCommandBatch(
      state,
      {
        expectedRevision: 1,
        commands: [
          {
            kind: 'retire-catalog-version',
            target: { kind: 'recipe-version', versionId: 'recipe-v1' },
            reason: 'Retired source configuration',
          },
        ],
      },
      { ...context, at: 11 }
    );
    if (!retired.ok) throw new Error(retired.message);
    const reopened = parseInventoryState(JSON.parse(JSON.stringify(retired.state)));
    expect(inventoryCatalogProjection(reopened)).toEqual(inventoryCatalogProjection(retired.state));
    const restored = applyInventoryCommandBatch(
      reopened,
      {
        expectedRevision: 2,
        commands: [
          {
            kind: 'restore-catalog-version',
            target: { kind: 'recipe-version', versionId: 'recipe-v1' },
            reason: 'Explicitly restore exact content',
          },
        ],
      },
      { ...context, at: 12 }
    );
    if (!restored.ok) throw new Error(restored.message);
    expect(restored.state.recipeVersions).toEqual(state.recipeVersions);
    expect(restored.state.vessels).toEqual(state.vessels);
    expect(restored.state.stocks).toEqual(state.stocks);
    expect(restored.state.reservations).toEqual(state.reservations);
  });

  it('requires explicit v8 selection variants and rejects impossible retirement timestamps', () => {
    const state = parseInventoryState(JSON.parse(V7_SNAPSHOT)),
      missing = JSON.parse(JSON.stringify(state));
    delete missing.typeVersions['tube-v1'].selection;
    expect(() => parseInventoryState(missing)).toThrow();
    for (const selection of [
      { kind: 'available', retired: false },
      { kind: 'retired', at: 9, by: context.principal, reason: 'Before publication' },
      { kind: 'retired', at: 11, by: context.principal, reason: 'After clock floor' },
    ]) {
      const invalid = JSON.parse(JSON.stringify(state));
      invalid.typeVersions['tube-v1'].selection = selection;
      expect(() => parseInventoryState(invalid)).toThrow();
    }
  });
});
