import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  applyInventoryCommandBatch,
  parseInventoryCommandBatch,
  parseInventoryState,
  inventoryStorageConditionsProjection,
} from './inventory';

const V9_SNAPSHOT = `{"schema":"dnaforge.inventory.v9","revision":1,"lastRecordedAt":10,"typeVersions":{"tube-v1":{"id":"tube-v1","typeId":"tube","version":1,"name":"Tube","description":"","fields":[],"sources":[],"definition":{"kind":"vessel","mobility":"movable","limits":{"capacity":{"kind":"known","value":"200","unit":"uL"},"deadVolume":{"kind":"known","value":"0","unit":"uL"}},"geometry":{"external":{"width":{"kind":"unknown"},"height":{"kind":"unknown"},"depth":{"kind":"unknown"}},"usable":{"width":{"kind":"unknown"},"height":{"kind":"unknown"},"depth":{"kind":"unknown"}}}},"publishedAt":10,"publishedBy":{"kind":"agent","identityId":"alice"},"selection":{"kind":"retired","at":10,"by":{"kind":"agent","identityId":"alice"},"reason":"Stop new selections"}}},"recipeVersions":{"recipe-v1":{"id":"recipe-v1","recipeId":"recipe","version":1,"name":"Recipe","description":"","model":{"manufacturer":"Custom","model":"Tube","partNumber":null,"region":null,"revision":null},"components":[{"key":"root","parentKey":null,"positionId":null,"name":"Tube","typeVersionId":"tube-v1"}],"sources":[],"publishedAt":10,"publishedBy":{"kind":"agent","identityId":"alice"},"selection":{"kind":"retired","at":10,"by":{"kind":"agent","identityId":"alice"},"reason":"Stop new selections"}}},"fitEvidence":{},"storage":{},"vessels":{"tube":{"kind":"movable","id":"tube","name":"Tube","placement":{"kind":"unplaced"},"lifecycle":"active","limits":{"capacity":{"kind":"known","value":"200","unit":"uL"},"deadVolume":{"kind":"known","value":"0","unit":"uL"}},"custody":{"kind":"available"},"configuration":{"revision":1,"typeVersionId":"tube-v1","metadata":{},"geometryOverride":null,"orientation":{"kind":"unknown"},"unavailablePositions":{},"recipe":{"recipeVersionId":"recipe-v1","componentKey":"root"}}}},"stocks":{"stock":{"id":"stock","vesselId":"tube","source":{"kind":"unattributed","rootStockId":"stock"},"materialId":"material","quantity":{"kind":"known","value":"100","unit":"uL"},"quality":"usable","composition":{"kind":"unknown"}}},"lots":{},"reservations":{"hold":{"kind":"quantity","id":"hold","stockId":"stock","holder":{"kind":"agent","identityId":"alice"},"purpose":"Experiment","createdAt":10,"deadline":null,"lifecycle":{"kind":"active"},"quantity":{"value":"40","unit":"uL"},"remaining":{"value":"40","unit":"uL"}}},"itemCodes":{"code":{"id":"code","namespace":"lab","value":" 000123 ","item":{"kind":"vessel","id":"tube"},"assignedAt":10,"assignedBy":{"kind":"agent","identityId":"alice"},"reason":"Existing physical label","lifecycle":{"kind":"active"}}}}`;
const V9_REQUEST =
  '{"expectedRevision":1,"commands":[{"kind":"retire-item-code","codeId":"code","reason":"Replace physical label"}]}';
const actor = {
  at: 11,
  principal: { kind: 'agent' as const, identityId: 'alice' },
  authority: { kind: 'local-profile' as const, profileKey: 'profile' },
};

describe('frozen v9 temperature migration', () => {
  it('adds only empty temperature maps without writes, revision/clock changes or loss of existing pins and code bytes', () => {
    const input = JSON.parse(V9_SNAPSHOT),
      bytes = JSON.stringify(input),
      state = parseInventoryState(input);
    expect(JSON.stringify(input)).toBe(bytes);
    expect(state.schema).toBe('dnaforge.inventory.v15');
    expect(state.revision).toBe(1);
    expect(state.lastRecordedAt).toBe(10);
    for (const key of ['temperatureClaims', 'equipmentSetpoints', 'storageRequirements'] as const)
      expect(state[key]).toEqual({});
    for (const key of [
      'itemCodes',
      'typeVersions',
      'recipeVersions',
      'fitEvidence',
      'storage',
      'vessels',
      'stocks',
      'lots',
      'reservations',
    ] as const)
      expect(state[key]).toEqual(input[key]);
    expect(parseInventoryState(JSON.parse(JSON.stringify(state)))).toEqual(state);
    const projected = inventoryStorageConditionsProjection(state, {
      asOf: 100,
      freshnessMaxAgeMs: null,
    });
    expect(projected.stocks.stock.requirement.value).toEqual({ kind: 'unknown' });
    expect(projected.stocks.stock.capability.state).toBe('unknown');
    expect(JSON.stringify(input)).toBe(bytes);
  });
  it('preserves original v9 request bytes/digest and replays its terminal transition under trusted context', () => {
    const batch = parseInventoryCommandBatch(JSON.parse(V9_REQUEST));
    expect(JSON.stringify(batch)).toBe(V9_REQUEST);
    expect(createHash('sha256').update(JSON.stringify(batch)).digest('hex')).toBe(
      createHash('sha256').update(V9_REQUEST).digest('hex')
    );
    const state = parseInventoryState(JSON.parse(V9_SNAPSHOT));
    const result = applyInventoryCommandBatch(state, batch, actor);
    if (!result.ok) throw new Error(result.message);
    expect(result.state.itemCodes.code.lifecycle).toEqual({
      kind: 'retired',
      at: 11,
      by: actor.principal,
      reason: 'Replace physical label',
    });
    expect(result.state.stocks).toEqual(state.stocks);
    expect(result.state.reservations).toEqual(state.reservations);
    expect(result.state.equipmentSetpoints).toEqual({});
  });
  it('requires all explicit v10 maps and recorded claim scope without borrowing commit time for unknown observations', () => {
    const state = parseInventoryState(JSON.parse(V9_SNAPSHOT));
    for (const key of ['temperatureClaims', 'equipmentSetpoints', 'storageRequirements']) {
      const incomplete = { ...state } as Record<string, unknown>;
      delete incomplete[key];
      expect(() => parseInventoryState(incomplete)).toThrow();
    }
    const batch = parseInventoryCommandBatch({
      expectedRevision: 1,
      commands: [
        {
          kind: 'record-equipment-setpoint',
          item: { kind: 'vessel', id: 'tube' },
          value: { kind: 'known', temperature: { value: '-80.000', unit: 'C' } },
          observedAt: null,
          source: null,
          reason: 'Operator report',
        },
      ],
    });
    expect((batch.commands[0] as { value: unknown }).value).toEqual({
      kind: 'known',
      temperature: { value: '-80.000', unit: 'C' },
    });
    const result = applyInventoryCommandBatch(state, batch, actor);
    if (!result.ok) throw new Error(result.message);
    expect(result.state.equipmentSetpoints['vessel:tube']).toMatchObject({
      observedAt: null,
      at: 11,
      by: actor.principal,
      value: { kind: 'known', temperature: { value: '-80', unit: 'C' } },
    });
    expect(parseInventoryState(JSON.parse(JSON.stringify(result.state)))).toEqual(result.state);
  });
});
