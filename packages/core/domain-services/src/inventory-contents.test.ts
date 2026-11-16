import { describe, expect, it } from 'vitest';
import {
  adoptInventoryState,
  applyInventoryCommandBatch,
  createInventoryState,
  inventoryAvailability,
  inventoryPrincipalMatchesActor,
  inventoryTableSha256,
  inventoryTableBindingKey,
  inventoryVesselContents,
  inventoryVesselContentsProjection,
  inventoryWellId,
  parseInventoryCommandBatch,
  parseInventoryExecutionContext,
  parseInventoryState,
  type InventoryCommand,
  type InventoryExecutionContext,
  type InventoryState,
} from './inventory';

const context: InventoryExecutionContext = {
  at: 1000,
  principal: { kind: 'agent', identityId: 'local-inventory-actor' },
  authority: { kind: 'local-profile', profileKey: 'a'.repeat(64) },
};
const reason = 'Explicit physical contents declaration';
function execute(state: InventoryState, commands: readonly InventoryCommand[], actor = context) {
  return applyInventoryCommandBatch(
    state,
    { expectedRevision: state.revision, commands },
    { ...actor, at: Math.max(actor.at, state.lastRecordedAt + 1) }
  );
}
function apply(state: InventoryState, commands: readonly InventoryCommand[], actor = context) {
  const result = execute(state, commands, actor);
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return parseInventoryState(result.state);
}
function fixture(): InventoryState {
  return apply(createInventoryState(), [
    {
      kind: 'create-storage',
      id: 'rack',
      name: 'Rack',
      slots: ['A', 'B'],
      placement: { kind: 'root' },
    },
    ...['source', 'water', 'target'].map(
      (id): InventoryCommand => ({
        kind: 'create-vessel',
        id,
        name: id,
        placement: { kind: 'unplaced' },
      })
    ),
    {
      kind: 'receive-stock',
      id: 'sample',
      vesselId: 'source',
      materialId: 'material',
      quantity: { kind: 'known', value: '10', unit: 'uL' },
      quality: 'usable',
    },
    {
      kind: 'receive-stock',
      id: 'diluent',
      vesselId: 'water',
      materialId: 'water-material',
      quantity: { kind: 'known', value: '10', unit: 'uL' },
      quality: 'usable',
    },
    {
      kind: 'create-lot',
      id: 'lot',
      materialId: 'material',
      name: 'Lot',
      origin: { kind: 'received', supplier: 'Synthetic', lotNumber: 'one' },
    },
    {
      kind: 'create-layout-storage',
      id: 'plate',
      name: 'Plate',
      layout: { kind: 'fixed-well', rows: 1, columns: 2 },
      placement: { kind: 'root' },
    },
  ]);
}
const unresolved = (
  knowledge: 'unobserved' | 'unidentified',
  state = fixture(),
  vesselId = 'target'
) => apply(state, [{ kind: 'record-vessel-contents', vesselId, knowledge, reason }]);
const identify = (quantity: 'unknown' | 'zero' = 'unknown'): InventoryCommand => ({
  kind: 'identify-vessel-stock',
  id: 'existing-contents',
  vesselId: 'target',
  materialId: 'material',
  quantity:
    quantity === 'unknown' ? { kind: 'unknown' } : { kind: 'known', value: '0', unit: 'uL' },
  quality: 'quarantined',
  reason: 'Identified existing material without receiving a physical delivery',
});
const admissions: readonly InventoryCommand[] = [
  {
    kind: 'receive-stock',
    id: 'received',
    vesselId: 'target',
    materialId: 'material',
    quantity: { kind: 'unknown' },
    quality: 'usable',
  },
  {
    kind: 'receive-lot-stock',
    id: 'received',
    vesselId: 'target',
    lotId: 'lot',
    quantity: { kind: 'unknown' },
    quality: 'usable',
  },
  {
    kind: 'transfer',
    sourceStockId: 'sample',
    destination: { kind: 'new-stock', stockId: 'received', vesselId: 'target' },
    quantity: { value: '1', unit: 'uL' },
    reason,
  },
  {
    kind: 'pool',
    lotId: 'product-lot',
    stockId: 'received',
    vesselId: 'target',
    materialId: 'product',
    name: 'Product',
    inputs: [
      { stockId: 'sample', quantity: { value: '1', unit: 'uL' } },
      { stockId: 'diluent', quantity: { value: '1', unit: 'uL' } },
    ],
    reason,
  },
  {
    kind: 'dilute',
    lotId: 'product-lot',
    stockId: 'received',
    vesselId: 'target',
    materialId: 'product',
    name: 'Product',
    sample: { stockId: 'sample', quantity: { value: '1', unit: 'uL' } },
    diluent: { stockId: 'diluent', quantity: { value: '1', unit: 'uL' } },
    reason,
  },
];

describe('explicit vessel contents knowledge', () => {
  it('declares ordinary new vessels and permanent wells without invented stamps', () => {
    const state = fixture();
    expect(state.vessels.target.contentsKnowledge).toEqual({ kind: 'recorded' });
    expect(state.vessels[inventoryWellId('plate', 'A1')].contentsKnowledge).toEqual({
      kind: 'recorded',
    });
    expect(inventoryVesselContents(state, 'target')).toEqual({ kind: 'declared-empty' });
    expect(inventoryVesselContents(state, 'source')).toEqual({
      kind: 'identified',
      stockId: 'sample',
    });
    expect(inventoryVesselContents(state, 'missing')).toBeNull();
    expect(
      inventoryVesselContents({ ...state, vessels: { ...state.vessels } }, 'constructor')
    ).toBeNull();
  });

  it.each(['unobserved', 'unidentified'] as const)(
    'records %s with trusted reason, actor and time without stock',
    (knowledge) => {
      const state = unresolved(knowledge);
      expect(inventoryVesselContents(state, 'target')).toEqual({
        kind: knowledge,
        reason,
        at: state.lastRecordedAt,
        by: context.principal,
      });
      expect(Object.values(state.stocks).some((stock) => stock.vesselId === 'target')).toBe(false);
      expect(
        inventoryAvailability(state, context.principal, state.lastRecordedAt).vesselContents.target
      ).toEqual(inventoryVesselContents(state, 'target'));
      expect(inventoryVesselContentsProjection(state).target).toEqual(
        inventoryVesselContents(state, 'target')
      );
    }
  );

  for (const knowledge of ['unobserved', 'unidentified'] as const) {
    it.each(admissions)(
      `refuses ordinary $kind into ${knowledge} contents without any debit or stock`,
      (command) => {
        const state = unresolved(knowledge);
        const before = JSON.stringify(state);
        expect(execute(state, [command])).toMatchObject({
          ok: false,
          code: 'VESSEL_CONTENTS_UNRESOLVED',
        });
        expect(JSON.stringify(state)).toBe(before);
      }
    );
  }

  it.each(['unknown', 'zero'] as const)(
    'identifies existing contents with %s quantity, independently of emptiness',
    (quantity) => {
      const state = unresolved('unidentified');
      const identified = apply(state, [identify(quantity)]);
      expect(identified.vessels.target.contentsKnowledge).toEqual({ kind: 'recorded' });
      expect(inventoryVesselContents(identified, 'target')).toEqual({
        kind: 'identified',
        stockId: 'existing-contents',
      });
      expect(identified.stocks['existing-contents']).toMatchObject({
        source: { kind: 'unattributed', rootStockId: 'existing-contents' },
        materialId: 'material',
        quality: 'quarantined',
        composition: { kind: 'unknown' },
      });
      expect(identified.stocks.sample).toEqual(state.stocks.sample);
    }
  );

  it('requires an unresolved declaration before identifying existing material', () => {
    expect(execute(fixture(), [identify()])).toMatchObject({
      ok: false,
      code: 'VESSEL_CONTENTS_RECORDED',
    });
  });

  it('keeps unknown amount distinct from unidentified contents', () => {
    const state = apply(unresolved('unobserved'), [
      { ...identify(), quality: 'usable' } as InventoryCommand,
    ]);
    expect(inventoryVesselContents(state, 'target')).toEqual({
      kind: 'identified',
      stockId: 'existing-contents',
    });
    expect(
      execute(state, [
        {
          kind: 'consume',
          stockId: 'existing-contents',
          quantity: { value: '1', unit: 'uL' },
          reason,
        },
      ])
    ).toMatchObject({ ok: false, code: 'QUANTITY_UNKNOWN' });
  });

  it('corrects unresolved knowledge without replacing physical source identity', () => {
    const binding = {
      namespace: 'foreign',
      sourceId: 'container-one',
      rowSha256: inventoryTableSha256('original physical facts'),
      vesselId: 'target',
      origin: { kind: 'movable' as const, placement: { kind: 'unplaced' as const } },
    };
    const state = parseInventoryState({
      ...fixture(),
      vesselBindings: { [inventoryTableBindingKey(binding.namespace, binding.sourceId)]: binding },
    });
    const unobserved = unresolved('unobserved', state);
    const unidentified = unresolved('unidentified', unobserved);
    expect(unidentified.vessels.target.contentsKnowledge).toMatchObject({
      kind: 'unidentified',
      at: unidentified.lastRecordedAt,
    });
    expect(unidentified.lastRecordedAt).toBeGreaterThan(unobserved.lastRecordedAt);
    const identified = apply(unidentified, [identify()]);
    expect(identified.vesselBindings).toEqual(state.vesselBindings);
    expect(Object.keys(identified.vessels)).toEqual(Object.keys(state.vessels));
  });

  it.each(['unobserved', 'unidentified'] as const)(
    'requires an explicit empty declaration before receiving into %s',
    (knowledge) => {
      const state = unresolved(knowledge);
      const declared = apply(state, [{ kind: 'declare-vessel-empty', vesselId: 'target', reason }]);
      expect(inventoryVesselContents(declared, 'target')).toEqual({ kind: 'declared-empty' });
      const received = apply(declared, [admissions[0]]);
      expect(inventoryVesselContents(received, 'target')).toEqual({
        kind: 'identified',
        stockId: 'received',
      });
    }
  );

  it('never erases a tracked stock, including known zero, through a knowledge change', () => {
    const state = apply(unresolved('unobserved'), [identify('zero')]);
    for (const command of [
      { kind: 'record-vessel-contents', vesselId: 'target', knowledge: 'unobserved', reason },
      { kind: 'record-vessel-contents', vesselId: 'target', knowledge: 'unidentified', reason },
      { kind: 'declare-vessel-empty', vesselId: 'target', reason },
      { kind: 'record-vessels-contents', vesselIds: ['target'], knowledge: 'unobserved', reason },
    ] as const)
      expect(execute(state, [command])).toMatchObject({ ok: false, code: 'STOCK_ALREADY_PRESENT' });
    expect(inventoryVesselContents(state, 'target')?.kind).toBe('identified');
  });

  it('requires a trusted context and strict caller fields for knowledge and identification', () => {
    const state = unresolved('unobserved');
    for (const command of [
      { kind: 'record-vessel-contents', vesselId: 'target', knowledge: 'unidentified', reason },
      { kind: 'declare-vessel-empty', vesselId: 'target', reason },
      { kind: 'record-vessels-contents', vesselIds: ['target'], knowledge: 'unidentified', reason },
      identify(),
    ] as const) {
      expect(
        applyInventoryCommandBatch(state, { expectedRevision: state.revision, commands: [command] })
      ).toMatchObject({ ok: false, code: 'CONTEXT_REQUIRED' });
      expect(() =>
        parseInventoryCommandBatch({
          expectedRevision: state.revision,
          commands: [{ ...command, by: context.principal }],
        })
      ).toThrow();
    }
  });

  it('preserves unknown contents through movement, checkout/return, labeling and disposal', () => {
    const state = unresolved('unidentified');
    const moved = apply(state, [
      {
        kind: 'move-vessel',
        id: 'target',
        placement: { kind: 'located', storageId: 'rack', slotId: 'A' },
      },
    ]);
    const checked = apply(moved, [
      { kind: 'checkout-item', item: { kind: 'vessel', id: 'target' }, dueAt: null, reason },
    ]);
    const returned = apply(checked, [
      {
        kind: 'return-item',
        item: { kind: 'vessel', id: 'target' },
        destination: { kind: 'located', storageId: 'rack', slotId: 'B' },
        reason,
      },
    ]);
    const missing = apply(returned, [
      { kind: 'report-item-missing', item: { kind: 'vessel', id: 'target' }, reason },
    ]);
    const located = apply(missing, [
      {
        kind: 'locate-item',
        item: { kind: 'vessel', id: 'target' },
        destination: { kind: 'located', storageId: 'rack', slotId: 'A' },
        reason,
      },
    ]);
    const labeled = apply(located, [
      {
        kind: 'attach-item-code',
        id: 'label',
        namespace: 'synthetic',
        value: 'unknown-1',
        item: { kind: 'vessel', id: 'target' },
        reason,
      },
    ]);
    const discarded = apply(labeled, [{ kind: 'dispose-vessel', id: 'target', reason }]);
    expect(discarded.vessels.target.contentsKnowledge).toEqual(
      state.vessels.target.contentsKnowledge
    );
    expect(inventoryVesselContents(discarded, 'target')?.kind).toBe('unidentified');
    expect(
      execute(discarded, [{ kind: 'declare-vessel-empty', vesselId: 'target', reason }])
    ).toMatchObject({ ok: false, code: 'VESSEL_DISPOSED' });
  });

  it('preserves compatible tracked-stock transfer behavior', () => {
    let state = apply(fixture(), [admissions[2]]);
    state = apply(state, [
      {
        kind: 'transfer',
        sourceStockId: 'sample',
        destination: { kind: 'existing-stock', stockId: 'received' },
        quantity: { value: '1', unit: 'uL' },
        reason,
        mixing: 'unknown',
      },
    ]);
    expect(state.stocks.sample.quantity).toMatchObject({ value: '8' });
    expect(state.stocks.received.quantity).toMatchObject({ value: '2' });
    expect(inventoryVesselContents(state, 'target')).toEqual({
      kind: 'identified',
      stockId: 'received',
    });
  });

  it('reuses capacity and reservation guards when identifying', () => {
    let state = unresolved('unobserved');
    state = apply(state, [
      {
        kind: 'set-vessel-limits',
        vesselId: 'target',
        limits: {
          capacity: { kind: 'known', value: '1', unit: 'uL' },
          deadVolume: { kind: 'unknown' },
        },
        reason,
      },
    ]);
    expect(
      execute(state, [
        { ...identify(), quantity: { kind: 'known', value: '2', unit: 'uL' } } as InventoryCommand,
      ])
    ).toMatchObject({ ok: false, code: 'CAPACITY_EXCEEDED' });
    const other: InventoryExecutionContext = {
      ...context,
      principal: { kind: 'agent', identityId: 'other' },
    };
    state = apply(
      state,
      [
        {
          kind: 'reserve-item',
          id: 'hold',
          item: { kind: 'vessel', id: 'target' },
          purpose: 'Held for other scientist',
          deadline: null,
        },
      ],
      other
    );
    expect(execute(state, [identify()])).toMatchObject({ ok: false, code: 'ITEM_RESERVED' });
  });

  it('requires current custody access for identifying and recording unresolved contents', () => {
    const other: InventoryExecutionContext = {
      ...context,
      principal: { kind: 'agent', identityId: 'other' },
    };
    const state = apply(
      unresolved('unobserved'),
      [{ kind: 'checkout-item', item: { kind: 'vessel', id: 'target' }, dueAt: null, reason }],
      other
    );
    for (const command of [
      identify(),
      { kind: 'record-vessel-contents', vesselId: 'target', knowledge: 'unidentified', reason },
      { kind: 'declare-vessel-empty', vesselId: 'target', reason },
      {
        kind: 'record-vessels-contents',
        vesselIds: [inventoryWellId('plate', 'A1'), 'target'],
        knowledge: 'unidentified',
        reason,
      },
    ] as const)
      expect(execute(state, [command])).toMatchObject({ ok: false, code: 'ITEM_CHECKED_OUT' });
  });

  it('keeps imported knowledge stamps as foreign evidence, never native acting identity', () => {
    const state = unresolved('unidentified');
    const adopted = adoptInventoryState(
      null,
      state,
      {
        source: {
          archiveSha256: inventoryTableSha256('synthetic archive'),
          projectId: 'source',
          inventoryId: 'source',
          revision: state.revision,
        },
        materialBindings: { material: 'material-copy', 'water-material': 'water-copy' },
      },
      { ...context, at: 2000 }
    );
    if (!adopted.ok) throw new Error(adopted.message);
    const contents = adopted.state.vessels.target.contentsKnowledge;
    if (contents.kind === 'recorded') throw new Error('Expected imported unresolved contents.');
    expect(contents.by).toMatchObject({ kind: 'imported', principal: context.principal });
    expect(inventoryPrincipalMatchesActor(contents.by, context.principal)).toBe(false);
    expect(() => parseInventoryExecutionContext({ ...context, principal: contents.by })).toThrow();
    expect(parseInventoryState(JSON.parse(JSON.stringify(adopted.state)))).toEqual(adopted.state);
    const again = adoptInventoryState(
      null,
      adopted.state,
      {
        source: {
          archiveSha256: inventoryTableSha256('next synthetic archive'),
          projectId: 'middle',
          inventoryId: 'middle',
          revision: adopted.state.revision,
        },
        materialBindings: { 'material-copy': 'final-material', 'water-copy': 'final-water' },
      },
      { ...context, at: 3000 }
    );
    if (!again.ok) throw new Error(again.message);
    expect(again.state.vessels.target.contentsKnowledge).toEqual(contents);
  });

  it('requires explicit current facts, bounded timestamps and no unresolved/stock contradiction', () => {
    const state = unresolved('unobserved');
    const changed = (contentsKnowledge: unknown) => ({
      ...state,
      vessels: { ...state.vessels, target: { ...state.vessels.target, contentsKnowledge } },
    });
    expect(() =>
      parseInventoryState(
        changed({ kind: 'unobserved', reason, at: state.lastRecordedAt + 1, by: context.principal })
      )
    ).toThrow('recorded inventory clock');
    expect(() =>
      parseInventoryState(changed({ kind: 'recorded', at: state.lastRecordedAt }))
    ).toThrow();
    expect(() => parseInventoryState(changed(undefined))).toThrow();
    const invalid = {
      ...state,
      stocks: { ...state.stocks, sample: { ...state.stocks.sample, vesselId: 'target' } },
    };
    expect(() => parseInventoryState(invalid)).toThrow('recorded vessel contents knowledge');
  });
});

describe('bounded bulk contents initialization', () => {
  it('initializes all384 permanent wells in one command without making any stock', () => {
    const state = apply(createInventoryState(), [
      {
        kind: 'create-layout-storage',
        id: 'large-plate',
        name: '384well plate',
        layout: { kind: 'fixed-well', rows: 16, columns: 24 },
        placement: { kind: 'root' },
      },
    ]);
    const ids = Object.keys(state.vessels);
    expect(ids).toHaveLength(384);
    const result = apply(state, [
      {
        kind: 'record-vessels-contents',
        vesselIds: ids,
        knowledge: 'unobserved',
        reason: 'Selected capture omitted well contents',
      },
    ]);
    expect(result.revision).toBe(state.revision + 1);
    expect(
      Object.values(inventoryVesselContentsProjection(result)).every(
        (contents) => contents.kind === 'unobserved'
      )
    ).toBe(true);
    expect(Object.keys(result.stocks)).toEqual([]);
  });

  it('refuses a late occupied target without changing any earlier vessel', () => {
    const state = fixture();
    const bytes = JSON.stringify(state);
    expect(
      execute(state, [
        {
          kind: 'record-vessels-contents',
          vesselIds: ['target', inventoryWellId('plate', 'A1'), 'source'],
          knowledge: 'unidentified',
          reason,
        },
      ])
    ).toMatchObject({ ok: false, code: 'STOCK_ALREADY_PRESENT' });
    expect(JSON.stringify(state)).toBe(bytes);
  });

  it.each([[], ['target', 'target'], Array(10001).fill('target')])(
    'refuses empty, duplicate or excess targets',
    (vesselIds) => {
      expect(
        execute(fixture(), [
          { kind: 'record-vessels-contents', vesselIds, knowledge: 'unobserved', reason },
        ])
      ).toMatchObject({ ok: false, code: 'INVALID_INVENTORY_INPUT' });
    }
  );
});
