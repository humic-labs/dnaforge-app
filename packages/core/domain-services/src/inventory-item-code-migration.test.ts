import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  applyInventoryCommandBatch,
  inventoryResolveItemCode,
  parseInventoryCommandBatch,
  parseInventoryState,
} from './inventory';

const V8_SNAPSHOT = `{"schema":"dnaforge.inventory.v8","revision":1,"lastRecordedAt":10,"typeVersions":{"tube-v1":{"id":"tube-v1","typeId":"tube","version":1,"name":"Tube","description":"","fields":[],"sources":[],"definition":{"kind":"vessel","mobility":"movable","limits":{"capacity":{"kind":"known","value":"200","unit":"uL"},"deadVolume":{"kind":"known","value":"0","unit":"uL"}},"geometry":{"external":{"width":{"kind":"unknown"},"height":{"kind":"unknown"},"depth":{"kind":"unknown"}},"usable":{"width":{"kind":"unknown"},"height":{"kind":"unknown"},"depth":{"kind":"unknown"}}}},"publishedAt":10,"publishedBy":{"kind":"agent","identityId":"alice"},"selection":{"kind":"retired","at":10,"by":{"kind":"agent","identityId":"alice"},"reason":"Stop new selections"}}},"recipeVersions":{"recipe-v1":{"id":"recipe-v1","recipeId":"recipe","version":1,"name":"Recipe","description":"","model":{"manufacturer":"Custom","model":"Tube","partNumber":null,"region":null,"revision":null},"components":[{"key":"root","parentKey":null,"positionId":null,"name":"Tube","typeVersionId":"tube-v1"}],"sources":[],"publishedAt":10,"publishedBy":{"kind":"agent","identityId":"alice"},"selection":{"kind":"retired","at":10,"by":{"kind":"agent","identityId":"alice"},"reason":"Stop new selections"}}},"fitEvidence":{},"storage":{},"vessels":{"tube":{"kind":"movable","id":"tube","name":"Tube","placement":{"kind":"unplaced"},"lifecycle":"active","limits":{"capacity":{"kind":"known","value":"200","unit":"uL"},"deadVolume":{"kind":"known","value":"0","unit":"uL"}},"custody":{"kind":"available"},"configuration":{"revision":1,"typeVersionId":"tube-v1","metadata":{},"geometryOverride":null,"orientation":{"kind":"unknown"},"unavailablePositions":{},"recipe":{"recipeVersionId":"recipe-v1","componentKey":"root"}}}},"stocks":{"stock":{"id":"stock","vesselId":"tube","source":{"kind":"unattributed","rootStockId":"stock"},"materialId":"material","quantity":{"kind":"known","value":"100","unit":"uL"},"quality":"usable","composition":{"kind":"unknown"}}},"lots":{},"reservations":{"hold":{"kind":"quantity","id":"hold","stockId":"stock","holder":{"kind":"agent","identityId":"alice"},"purpose":"Experiment","createdAt":10,"deadline":null,"lifecycle":{"kind":"active"},"quantity":{"value":"40","unit":"uL"},"remaining":{"value":"40","unit":"uL"}}}}`;
const V8_REQUEST =
  '{"expectedRevision":1,"commands":[{"kind":"restore-catalog-version","target":{"kind":"type-version","versionId":"tube-v1"},"reason":"Explicit restore"}]}';

const actor = {
  at: 11,
  principal: { kind: 'agent' as const, identityId: 'alice' },
  authority: { kind: 'local-profile' as const, profileKey: 'profile' },
};

describe('frozen v8 item-code migration', () => {
  it('adds empty codes without writes, revision/clock changes or restoring retired catalog selections', () => {
    const input = JSON.parse(V8_SNAPSHOT),
      before = JSON.stringify(input),
      state = parseInventoryState(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(state.schema).toBe('dnaforge.inventory.v16');
    expect(state.itemCodes).toEqual({});
    expect(state.revision).toBe(1);
    expect(state.lastRecordedAt).toBe(10);
    for (const key of [
      'typeVersions',
      'recipeVersions',
      'storage',
      'vessels',
      'stocks',
      'reservations',
      'fitEvidence',
    ] as const)
      expect(state[key]).toEqual(input[key]);
    expect(inventoryResolveItemCode(state, { namespace: null, value: 'tube' })).toEqual({
      kind: 'not-found',
    });
    expect(parseInventoryState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it('keeps historical v8 request bytes and digest exact while replaying its contextual command', () => {
    const state = parseInventoryState(JSON.parse(V8_SNAPSHOT)),
      batch = parseInventoryCommandBatch(JSON.parse(V8_REQUEST));
    expect(JSON.stringify(batch)).toBe(V8_REQUEST);
    expect(createHash('sha256').update(JSON.stringify(batch)).digest('hex')).toBe(
      createHash('sha256').update(V8_REQUEST).digest('hex')
    );
    const result = applyInventoryCommandBatch(state, batch, actor);
    if (!result.ok) throw new Error(result.message);
    expect(result.state.typeVersions['tube-v1'].selection).toEqual({ kind: 'available' });
    expect(result.state.recipeVersions['recipe-v1'].selection.kind).toBe('retired');
    expect(result.state.vessels).toEqual(state.vessels);
    expect(result.state.itemCodes).toEqual({});
  });

  it('round trips immutable assignment and terminal retirement without altering installed facts', () => {
    const state = parseInventoryState(JSON.parse(V8_SNAPSHOT));
    const assigned = applyInventoryCommandBatch(
      state,
      {
        expectedRevision: 1,
        commands: [
          {
            kind: 'attach-item-code',
            id: 'code',
            namespace: 'lab',
            value: ' 00123 ',
            item: { kind: 'vessel', id: 'tube' },
            reason: 'Bind existing label',
          },
        ],
      },
      actor
    );
    if (!assigned.ok) throw new Error(assigned.message);
    const retired = applyInventoryCommandBatch(
      assigned.state,
      {
        expectedRevision: 2,
        commands: [{ kind: 'retire-item-code', codeId: 'code', reason: 'Retire physical label' }],
      },
      { ...actor, at: 12 }
    );
    if (!retired.ok) throw new Error(retired.message);
    const reopened = parseInventoryState(JSON.parse(JSON.stringify(retired.state)));
    expect(reopened).toEqual(retired.state);
    expect(
      inventoryResolveItemCode(reopened, { namespace: 'lab', value: ' 00123 ' })
    ).toMatchObject({
      kind: 'retired',
      match: { item: { kind: 'vessel', id: 'tube' }, value: ' 00123 ' },
    });
    expect(reopened.vessels).toEqual(state.vessels);
    expect(reopened.stocks).toEqual(state.stocks);
    expect(reopened.reservations).toEqual(state.reservations);
  });

  it('requires explicit canonical code state and refuses invalid saved tuple/target/time facts', () => {
    const state = parseInventoryState(JSON.parse(V8_SNAPSHOT));
    const attached = applyInventoryCommandBatch(
      state,
      {
        expectedRevision: 1,
        commands: [
          {
            kind: 'attach-item-code',
            id: 'code',
            namespace: 'lab',
            value: '00123',
            item: { kind: 'vessel', id: 'tube' },
            reason: 'Bind',
          },
        ],
      },
      actor
    );
    if (!attached.ok) throw new Error(attached.message);
    const missing = JSON.parse(JSON.stringify(attached.state));
    delete missing.itemCodes;
    expect(() => parseInventoryState(missing)).toThrow();
    const code = attached.state.itemCodes.code;
    for (const invalid of [
      { ...code, item: { ...code.item, id: 'missing' } },
      { ...code, assignedAt: 12 },
      {
        ...code,
        lifecycle: { kind: 'retired', at: 10, by: actor.principal, reason: 'Before assignment' },
      },
      { ...code, value: '00123\n' },
      { ...code, id: 'stock' },
    ])
      expect(() =>
        parseInventoryState({ ...attached.state, itemCodes: { [invalid.id]: invalid } })
      ).toThrow();
    expect(() =>
      parseInventoryState({
        ...attached.state,
        itemCodes: {
          code,
          other: {
            ...code,
            id: 'other',
            lifecycle: { kind: 'retired', at: 11, by: actor.principal, reason: 'Old binding' },
          },
        },
      })
    ).toThrow();
  });
});
