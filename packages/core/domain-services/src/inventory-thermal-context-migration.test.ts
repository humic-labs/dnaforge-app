import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  applyInventoryCommandBatch,
  parseInventoryCommandBatch,
  parseInventoryState,
  inventoryStorageConditionsProjection,
} from './inventory';

const V10_BASE = `{"schema":"dnaforge.inventory.v10","revision":1,"lastRecordedAt":10,"typeVersions":{"tube-v1":{"id":"tube-v1","typeId":"tube","version":1,"name":"Tube","description":"","fields":[],"sources":[],"definition":{"kind":"vessel","mobility":"movable","limits":{"capacity":{"kind":"known","value":"200","unit":"uL"},"deadVolume":{"kind":"known","value":"0","unit":"uL"}},"geometry":{"external":{"width":{"kind":"unknown"},"height":{"kind":"unknown"},"depth":{"kind":"unknown"}},"usable":{"width":{"kind":"unknown"},"height":{"kind":"unknown"},"depth":{"kind":"unknown"}}}},"publishedAt":10,"publishedBy":{"kind":"agent","identityId":"alice"},"selection":{"kind":"retired","at":10,"by":{"kind":"agent","identityId":"alice"},"reason":"Stop new selections"}}},"recipeVersions":{"recipe-v1":{"id":"recipe-v1","recipeId":"recipe","version":1,"name":"Recipe","description":"","model":{"manufacturer":"Custom","model":"Tube","partNumber":null,"region":null,"revision":null},"components":[{"key":"root","parentKey":null,"positionId":null,"name":"Tube","typeVersionId":"tube-v1"}],"sources":[],"publishedAt":10,"publishedBy":{"kind":"agent","identityId":"alice"},"selection":{"kind":"retired","at":10,"by":{"kind":"agent","identityId":"alice"},"reason":"Stop new selections"}}},"fitEvidence":{},"storage":{},"vessels":{"tube":{"kind":"movable","id":"tube","name":"Tube","placement":{"kind":"unplaced"},"lifecycle":"active","limits":{"capacity":{"kind":"known","value":"200","unit":"uL"},"deadVolume":{"kind":"known","value":"0","unit":"uL"}},"custody":{"kind":"available"},"configuration":{"revision":1,"typeVersionId":"tube-v1","metadata":{},"geometryOverride":null,"orientation":{"kind":"unknown"},"unavailablePositions":{},"recipe":{"recipeVersionId":"recipe-v1","componentKey":"root"}}}},"stocks":{"stock":{"id":"stock","vesselId":"tube","source":{"kind":"unattributed","rootStockId":"stock"},"materialId":"material","quantity":{"kind":"known","value":"100","unit":"uL"},"quality":"usable","composition":{"kind":"unknown"}}},"lots":{},"reservations":{"hold":{"kind":"quantity","id":"hold","stockId":"stock","holder":{"kind":"agent","identityId":"alice"},"purpose":"Experiment","createdAt":10,"deadline":null,"lifecycle":{"kind":"active"},"quantity":{"value":"40","unit":"uL"},"remaining":{"value":"40","unit":"uL"}}},"itemCodes":{"code":{"id":"code","namespace":"lab","value":" 000123 ","item":{"kind":"vessel","id":"tube"},"assignedAt":10,"assignedBy":{"kind":"agent","identityId":"alice"},"reason":"Existing physical label","lifecycle":{"kind":"active"}}},"temperatureClaims":{},"equipmentSetpoints":{},"storageRequirements":{}}`;
const V10_REQUEST = `{"expectedRevision":1,"commands":[{"kind":"record-equipment-setpoint","item":{"kind":"vessel","id":"tube"},"value":{"kind":"known","temperature":{"value":"-80.000","unit":"C"}},"observedAt":null,"source":null,"reason":"Explicit inventory fact"},{"kind":"record-storage-requirement","target":{"kind":"stock","id":"stock"},"value":{"kind":"specified","range":{"minimum":{"value":"-85","unit":"C"},"maximum":{"value":"-75","unit":"C"}}},"observedAt":null,"source":null,"reason":"Explicit inventory fact"},{"kind":"record-temperature-claim","id":"specified","subject":{"kind":"type-version","versionId":"tube-v1"},"assertion":{"kind":"specified-setpoint-range","range":{"minimum":{"value":"-90","unit":"C"},"maximum":{"value":"-60","unit":"C"}}},"observedAt":null,"source":null,"reason":"Explicit inventory fact"},{"kind":"record-temperature-claim","id":"qualified","subject":{"kind":"installed","item":{"kind":"vessel","id":"tube"},"configurationRevision":1},"assertion":{"kind":"qualified-envelope","range":{"minimum":{"value":"-82","unit":"C"},"maximum":{"value":"-78","unit":"C"}},"atSetpoint":{"value":"-80","unit":"C"},"assumptions":"Declared old physical arrangement"},"observedAt":null,"source":null,"reason":"Explicit inventory fact"}]}`;
const V10_SNAPSHOT = `{"schema":"dnaforge.inventory.v10","revision":2,"lastRecordedAt":11,"typeVersions":{"tube-v1":{"id":"tube-v1","typeId":"tube","version":1,"name":"Tube","description":"","fields":[],"sources":[],"definition":{"kind":"vessel","mobility":"movable","limits":{"capacity":{"kind":"known","value":"200","unit":"uL"},"deadVolume":{"kind":"known","value":"0","unit":"uL"}},"geometry":{"external":{"width":{"kind":"unknown"},"height":{"kind":"unknown"},"depth":{"kind":"unknown"}},"usable":{"width":{"kind":"unknown"},"height":{"kind":"unknown"},"depth":{"kind":"unknown"}}}},"publishedAt":10,"publishedBy":{"kind":"agent","identityId":"alice"},"selection":{"kind":"retired","at":10,"by":{"kind":"agent","identityId":"alice"},"reason":"Stop new selections"}}},"recipeVersions":{"recipe-v1":{"id":"recipe-v1","recipeId":"recipe","version":1,"name":"Recipe","description":"","model":{"manufacturer":"Custom","model":"Tube","partNumber":null,"region":null,"revision":null},"components":[{"key":"root","parentKey":null,"positionId":null,"name":"Tube","typeVersionId":"tube-v1"}],"sources":[],"publishedAt":10,"publishedBy":{"kind":"agent","identityId":"alice"},"selection":{"kind":"retired","at":10,"by":{"kind":"agent","identityId":"alice"},"reason":"Stop new selections"}}},"fitEvidence":{},"storage":{},"vessels":{"tube":{"kind":"movable","id":"tube","name":"Tube","placement":{"kind":"unplaced"},"lifecycle":"active","limits":{"capacity":{"kind":"known","value":"200","unit":"uL"},"deadVolume":{"kind":"known","value":"0","unit":"uL"}},"custody":{"kind":"available"},"configuration":{"revision":1,"typeVersionId":"tube-v1","metadata":{},"geometryOverride":null,"orientation":{"kind":"unknown"},"unavailablePositions":{},"recipe":{"recipeVersionId":"recipe-v1","componentKey":"root"}}}},"stocks":{"stock":{"id":"stock","vesselId":"tube","source":{"kind":"unattributed","rootStockId":"stock"},"materialId":"material","quantity":{"kind":"known","value":"100","unit":"uL"},"quality":"usable","composition":{"kind":"unknown"}}},"lots":{},"reservations":{"hold":{"kind":"quantity","id":"hold","stockId":"stock","holder":{"kind":"agent","identityId":"alice"},"purpose":"Experiment","createdAt":10,"deadline":null,"lifecycle":{"kind":"active"},"quantity":{"value":"40","unit":"uL"},"remaining":{"value":"40","unit":"uL"}}},"itemCodes":{"code":{"id":"code","namespace":"lab","value":" 000123 ","item":{"kind":"vessel","id":"tube"},"assignedAt":10,"assignedBy":{"kind":"agent","identityId":"alice"},"reason":"Existing physical label","lifecycle":{"kind":"active"}}},"temperatureClaims":{"specified":{"id":"specified","subject":{"kind":"type-version","versionId":"tube-v1"},"assertion":{"kind":"specified-setpoint-range","range":{"minimum":{"value":"-90","unit":"C"},"maximum":{"value":"-60","unit":"C"}}},"observedAt":null,"source":null,"reason":"Explicit inventory fact","at":11,"by":{"kind":"agent","identityId":"alice"},"lifecycle":{"kind":"active"},"installation":null},"qualified":{"id":"qualified","subject":{"kind":"installed","item":{"kind":"vessel","id":"tube"},"configurationRevision":1},"assertion":{"kind":"qualified-envelope","range":{"minimum":{"value":"-82","unit":"C"},"maximum":{"value":"-78","unit":"C"}},"atSetpoint":{"value":"-80","unit":"C"},"assumptions":"Declared old physical arrangement"},"observedAt":null,"source":null,"reason":"Explicit inventory fact","at":11,"by":{"kind":"agent","identityId":"alice"},"lifecycle":{"kind":"active"},"installation":[{"item":{"kind":"vessel","id":"tube"},"configurationRevision":1,"typeVersionId":"tube-v1","geometry":{"external":{"width":{"kind":"unknown"},"height":{"kind":"unknown"},"depth":{"kind":"unknown"}},"usable":{"width":{"kind":"unknown"},"height":{"kind":"unknown"},"depth":{"kind":"unknown"}}},"orientation":{"kind":"unknown"},"unavailablePositionIds":[],"layout":null,"limits":{"capacity":{"kind":"known","value":"200","unit":"uL"},"deadVolume":{"kind":"known","value":"0","unit":"uL"}},"placement":{"kind":"root"},"lifecycle":"active"}]}},"equipmentSetpoints":{"vessel:tube":{"item":{"kind":"vessel","id":"tube"},"value":{"kind":"known","temperature":{"value":"-80","unit":"C"}},"observedAt":null,"source":null,"reason":"Explicit inventory fact","at":11,"by":{"kind":"agent","identityId":"alice"}}},"storageRequirements":{"stock:stock":{"target":{"kind":"stock","id":"stock"},"value":{"kind":"specified","range":{"minimum":{"value":"-85","unit":"C"},"maximum":{"value":"-75","unit":"C"}}},"observedAt":null,"source":null,"reason":"Explicit inventory fact","at":11,"by":{"kind":"agent","identityId":"alice"}}}}`;
const V10_REQUEST_SHA256 = 'd4995923f36c60aa0b117c533b3b42c4afe894ad80689a4fee71726c1914a38d';
const actor = {
  at: 11,
  principal: { kind: 'agent' as const, identityId: 'alice' },
  authority: { kind: 'local-profile' as const, profileKey: 'profile' },
};

describe('frozen v10 explicit thermal-context migration', () => {
  it('adds empty relationships without fabricated actor/time or alteration of prior facts and bytes', () => {
    const input = JSON.parse(V10_SNAPSHOT),
      original = JSON.stringify(input),
      state = parseInventoryState(input);
    expect(state.schema).toBe('dnaforge.inventory.v12');
    expect(state.thermalContexts).toEqual({});
    expect(state.revision).toBe(2);
    expect(state.lastRecordedAt).toBe(11);
    for (const key of [
      'itemCodes',
      'equipmentSetpoints',
      'storageRequirements',
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
    expect(state.temperatureClaims.specified).toEqual(input.temperatureClaims.specified);
    expect(state.temperatureClaims.qualified.installation).toEqual(
      input.temperatureClaims.qualified.installation.map((entry: object) => ({
        ...entry,
        thermalRelationship: null,
      }))
    );
    expect(state.temperatureClaims.qualified.assertion).not.toHaveProperty('scope');
    expect(JSON.stringify(input)).toBe(original);
    expect(parseInventoryState(JSON.parse(JSON.stringify(state)))).toEqual(state);
    const projection = inventoryStorageConditionsProjection(state, {
      asOf: 100,
      freshnessMaxAgeMs: null,
    });
    expect(projection.stocks.stock.environment).toEqual({
      kind: 'unknown',
      reason: 'no-thermal-context',
    });
    expect(projection.stocks.stock.qualifiedSupport.state).toBe('unknown');
  });
  it('replays the actual old qualification command shape to exactly the state-only upcast snapshot', () => {
    const batch = parseInventoryCommandBatch(JSON.parse(V10_REQUEST));
    expect(JSON.stringify(batch)).toBe(V10_REQUEST);
    expect(createHash('sha256').update(JSON.stringify(batch)).digest('hex')).toBe(
      V10_REQUEST_SHA256
    );
    const replay = applyInventoryCommandBatch(
      parseInventoryState(JSON.parse(V10_BASE)),
      batch,
      actor
    );
    if (!replay.ok) throw new Error(replay.message);
    expect(replay.state).toEqual(parseInventoryState(JSON.parse(V10_SNAPSHOT)));
    expect(
      replay.state.temperatureClaims.qualified.installation![0].thermalRelationship
    ).toBeNull();
  });
  it('requires an explicit relationship and a new scoped qualification before claiming thermal support', () => {
    const state = parseInventoryState(JSON.parse(V10_SNAPSHOT));
    const related = applyInventoryCommandBatch(
      state,
      {
        expectedRevision: 2,
        commands: [
          {
            kind: 'record-thermal-context',
            item: { kind: 'vessel', id: 'tube' },
            value: { kind: 'self' },
            observedAt: null,
            source: null,
            reason: 'Select own thermal environment',
          },
        ],
      },
      { ...actor, at: 12 }
    );
    if (!related.ok) throw new Error(related.message);
    let projection = inventoryStorageConditionsProjection(related.state, {
      asOf: 100,
      freshnessMaxAgeMs: null,
    });
    expect(projection.stocks.stock.reportedTarget.state).toBe('supported');
    expect(projection.stocks.stock.qualifiedSupport.state).toBe('unknown');
    expect(
      projection.equipment['vessel:tube'].claims.find((entry) => entry.claim.id === 'qualified')
        ?.applicability
    ).toBe('configuration-changed');
    const old = related.state.temperatureClaims.qualified;
    const accepted = applyInventoryCommandBatch(
      related.state,
      {
        expectedRevision: 3,
        commands: [
          {
            kind: 'record-temperature-claim',
            id: 'qualified-v11',
            subject: old.subject,
            assertion: {
              ...old.assertion,
              kind: 'qualified-envelope',
              scope: 'physical-and-thermal-arrangement',
              range: { minimum: { value: '-82', unit: 'C' }, maximum: { value: '-78', unit: 'C' } },
              atSetpoint: { value: '-80', unit: 'C' },
              assumptions: 'Declared physical and thermal arrangement',
            },
            observedAt: null,
            source: null,
            reason: 'Record explicit new scope',
          },
        ],
      },
      { ...actor, at: 13 }
    );
    if (!accepted.ok) throw new Error(accepted.message);
    projection = inventoryStorageConditionsProjection(accepted.state, {
      asOf: 100,
      freshnessMaxAgeMs: null,
    });
    expect(projection.stocks.stock.qualifiedSupport.state).toBe('supported');
    expect(accepted.state.temperatureClaims.qualified).toEqual(old);
    const reopened = parseInventoryState(JSON.parse(JSON.stringify(accepted.state)));
    expect(
      inventoryStorageConditionsProjection(reopened, { asOf: 100, freshnessMaxAgeMs: null })
    ).toEqual(projection);
  });
  it('refuses missing canonical relationship state and inconsistent saved qualification coverage', () => {
    const state = parseInventoryState(JSON.parse(V10_SNAPSHOT));
    const missing = { ...state } as Record<string, unknown>;
    delete missing.thermalContexts;
    expect(() => parseInventoryState(missing)).toThrow();
    const invalid = JSON.parse(JSON.stringify(state));
    invalid.temperatureClaims.qualified.installation[0].thermalRelationship = 'inherit';
    expect(() => parseInventoryState(invalid)).toThrow();
    const fabricated = JSON.parse(V10_SNAPSHOT);
    fabricated.thermalContexts = {};
    expect(() => parseInventoryState(fabricated)).toThrow();
  });
});
