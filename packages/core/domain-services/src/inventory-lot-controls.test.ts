import { describe, expect, it } from 'vitest';
import {
  adoptInventoryState,
  applyInventoryCommandBatch,
  createInventoryState,
  inventoryAvailability,
  inventoryStockEligibility,
  parseInventoryState,
  projectLegacyInventoryLotConstraints,
  type InventoryCommand,
  type InventoryExecutionContext,
  type InventoryState,
} from './inventory';

const context: InventoryExecutionContext = {
  at: 100,
  principal: { kind: 'agent', identityId: 'scientist' },
  authority: { kind: 'local-profile', profileKey: 'profile' },
};
const volume = (value: string) => ({ value, unit: 'uL' as const });
const created = (id: string): InventoryCommand => ({
  kind: 'create-lot',
  id,
  materialId: 'material',
  name: id,
  origin: { kind: 'received', supplier: 'Supplier', lotNumber: id },
});
const manage = (lotId = 'lot-a'): InventoryCommand => ({
  kind: 'manage-lot',
  lotId,
  reason: 'Track local lot assessment',
});
const assess = (
  assessment: 'released' | 'quarantined' | 'rejected',
  lotId = 'lot-a'
): InventoryCommand => ({
  kind: 'assess-lot',
  lotId,
  assessment,
  reason: 'Local review of retained evidence',
});
const recall = (id = 'recall-a', lotId = 'lot-a'): InventoryCommand => ({
  kind: 'record-lot-recall',
  id,
  lotId,
  observedAt: null,
  source: null,
  reason: 'Supplier recall notification',
});
const use = (stockId = 'stock-a'): InventoryCommand => ({
  kind: 'consume',
  stockId,
  quantity: volume('1'),
  reason: 'Experiment',
});
const hold = (stockId = 'stock-a'): InventoryCommand => ({
  kind: 'reserve-quantity',
  id: 'hold',
  stockId,
  quantity: volume('10'),
  deadline: null,
  purpose: 'Experiment',
});

function apply(state: InventoryState, ...commands: InventoryCommand[]): InventoryState {
  const result = applyInventoryCommandBatch(
    state,
    { expectedRevision: state.revision, commands },
    context
  );
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  expect(parseInventoryState(result.state)).toEqual(result.state);
  return result.state;
}

function refused(state: InventoryState, code: string, ...commands: InventoryCommand[]): void {
  const before = structuredClone(state);
  expect(
    applyInventoryCommandBatch(state, { expectedRevision: state.revision, commands }, context)
  ).toMatchObject({ ok: false, code });
  expect(state).toEqual(before);
}

function fixture(released = false): InventoryState {
  return apply(
    createInventoryState(),
    ...['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id) => ({
      kind: 'create-vessel' as const,
      id,
      name: id,
      placement: { kind: 'unplaced' as const },
    })),
    created('lot-a'),
    created('lot-b'),
    manage(),
    manage('lot-b'),
    ...(released ? [assess('released'), assess('released', 'lot-b')] : []),
    {
      kind: 'receive-lot-stock',
      id: 'stock-a',
      vesselId: 'a',
      lotId: 'lot-a',
      quantity: { kind: 'known', ...volume('100') },
      quality: 'usable',
    },
    {
      kind: 'receive-lot-stock',
      id: 'stock-b',
      vesselId: 'b',
      lotId: 'lot-b',
      quantity: { kind: 'known', ...volume('100') },
      quality: 'usable',
    }
  );
}

function aliquot(vesselId = 'c', stockId = 'aliquot', sourceStockId = 'stock-a'): InventoryCommand {
  return {
    kind: 'transfer',
    sourceStockId,
    quantity: volume('10'),
    destination: { kind: 'new-stock', vesselId, stockId },
    reason: 'Prepare aliquot',
  };
}

describe('managed lot assessment and independent recalls', () => {
  it('records physical receipt while unassessed and blocks all use admissions with the same reasons', () => {
    const state = fixture();
    expect(state.stocks['stock-a'].quantity).toEqual({ kind: 'known', ...volume('100') });
    expect(inventoryStockEligibility(state, 'stock-a', context.at)).toMatchObject({
      coverage: 'managed',
      lotConstraints: { knowledge: 'recorded', lotIds: ['lot-a'] },
      blockers: [{ code: 'LOT_NOT_RELEASED', lotId: 'lot-a', assessment: 'unassessed' }],
    });
    for (const command of [
      use(),
      aliquot(),
      hold(),
      {
        kind: 'reserve-item' as const,
        id: 'physical-hold',
        item: { kind: 'vessel' as const, id: 'a' },
        deadline: null,
        purpose: 'Use item',
      },
    ])
      refused(state, 'LOT_NOT_RELEASED', command);
    expect(
      inventoryAvailability(state, context.principal, context.at).stocks['stock-a']
    ).toMatchObject({
      onHand: { kind: 'known', ...volume('100') },
      unreserved: { kind: 'known', ...volume('100') },
      blockers: [{ code: 'LOT_NOT_RELEASED', lotId: 'lot-a', assessment: 'unassessed' }],
    });
    const observed = apply(
      state,
      {
        kind: 'reconcile',
        stockId: 'stock-a',
        quantity: { kind: 'known', ...volume('90') },
        reason: 'Measured possession',
      },
      { kind: 'move-vessel', id: 'a', placement: { kind: 'unplaced' } },
      {
        kind: 'set-quality',
        stockId: 'stock-a',
        quality: 'quarantined',
        reason: 'Independent container hold',
      },
      { kind: 'dispose-vessel', id: 'a', reason: 'Discard held material' }
    );
    expect(observed.stocks['stock-a'].lotConstraints).toEqual(
      state.stocks['stock-a'].lotConstraints
    );
  });

  it('makes management one-way and requires distinct local assessment decisions', () => {
    let state = apply(createInventoryState(), created('lot-a'));
    refused(state, 'LOT_MANAGEMENT_REQUIRED', assess('released'));
    for (const command of [
      manage(),
      assess('released'),
      recall(),
      { kind: 'withdraw-lot-recall', recallId: 'recall-a', reason: 'Withdraw' } as const,
    ])
      expect(
        applyInventoryCommandBatch(state, { expectedRevision: state.revision, commands: [command] })
      ).toMatchObject({ ok: false, code: 'CONTEXT_REQUIRED' });
    state = apply(state, manage(), assess('released'));
    refused(state, 'LOT_ALREADY_MANAGED', manage());
    refused(state, 'LOT_ASSESSMENT_UNCHANGED', assess('released'));
    state = apply(state, assess('rejected'), assess('quarantined'), assess('released'));
    expect(state.lots['lot-a'].controls).toMatchObject({
      kind: 'managed',
      assessment: { value: 'released', at: 100, by: context.principal },
    });
  });

  it('keeps stock quarantine, lot quarantine and multiple recalls independent', () => {
    let state = apply(
      fixture(true),
      {
        kind: 'set-quality',
        stockId: 'stock-a',
        quality: 'quarantined',
        reason: 'Container contamination',
      },
      assess('quarantined'),
      recall('first'),
      recall('second'),
      assess('released')
    );
    expect(inventoryStockEligibility(state, 'stock-a', context.at)?.blockers).toEqual([
      { code: 'STOCK_QUARANTINED' },
      { code: 'LOT_RECALLED', lotId: 'lot-a', recallIds: ['first', 'second'] },
    ]);
    state = apply(state, {
      kind: 'withdraw-lot-recall',
      recallId: 'first',
      reason: 'First notice superseded',
    });
    refused(state, 'LOT_RECALLED', use());
    state = apply(state, {
      kind: 'withdraw-lot-recall',
      recallId: 'second',
      reason: 'Supplier resolved remaining notice',
    });
    refused(state, 'STOCK_QUARANTINED', use());
    refused(state, 'LOT_RECALL_NOT_ACTIVE', {
      kind: 'withdraw-lot-recall',
      recallId: 'second',
      reason: 'Repeat withdrawal',
    });
    state = apply(
      state,
      {
        kind: 'set-quality',
        stockId: 'stock-a',
        quality: 'usable',
        reason: 'Resolved container hold',
      },
      assess('quarantined')
    );
    refused(state, 'LOT_NOT_RELEASED', use());
  });

  it('records recall facts during custody/quantity holds and refuses later fulfillment atomically', () => {
    let state = apply(fixture(true), hold(), {
      kind: 'checkout-item',
      item: { kind: 'vessel', id: 'a' },
      dueAt: null,
      reason: 'Experiment bench',
    });
    state = apply(state, recall());
    expect(state.reservations.hold.lifecycle).toEqual({ kind: 'active' });
    refused(state, 'LOT_RECALLED', {
      kind: 'fulfill-reservations',
      claims: [{ reservationId: 'hold', quantity: volume('10') }],
      withdrawal: {
        kind: 'consume',
        stockId: 'stock-a',
        quantity: volume('10'),
        reason: 'Use held stock',
      },
    });
    expect(
      inventoryAvailability(state, context.principal, context.at).reservations.hold.actions.fulfill
    ).toBe(false);
  });

  it('records recalls for legacy lots and shares the global inventory identifier namespace', () => {
    const state = apply(
      createInventoryState(),
      created('untracked'),
      recall('notice', 'untracked')
    );
    refused(state, 'ID_ALREADY_EXISTS', created('notice'));
    refused(state, 'ID_ALREADY_EXISTS', recall('untracked', 'untracked'));
    refused(state, 'OBSERVATION_TIME_FUTURE', {
      kind: 'record-lot-recall',
      id: 'future',
      lotId: 'untracked',
      observedAt: 101,
      source: null,
      reason: 'Future notice',
    });
    refused(state, 'LOT_RECALL_NOT_FOUND', {
      kind: 'withdraw-lot-recall',
      recallId: 'missing',
      reason: 'Unknown notice',
    });
  });
});

describe('stable cumulative lot constraints', () => {
  it.each(['0', '10'])(
    'unions distinct source and destination histories when destination has %s volume',
    (balance) => {
      let state = apply(
        fixture(true),
        created('common'),
        manage('common'),
        assess('released', 'common'),
        {
          kind: 'associate-stock-lot',
          stockId: 'stock-a',
          lotId: 'common',
          reason: 'Verified common preparation',
        },
        {
          kind: 'associate-stock-lot',
          stockId: 'stock-b',
          lotId: 'common',
          reason: 'Verified common preparation',
        },
        {
          kind: 'reconcile',
          stockId: 'stock-b',
          quantity: { kind: 'known', ...volume(balance) },
          reason: 'Measured destination amount',
        },
        {
          kind: 'transfer',
          sourceStockId: 'stock-a',
          quantity: volume('1'),
          destination: { kind: 'existing-stock', stockId: 'stock-b' },
          reason: 'Combine compatible current attribution',
        }
      );
      expect(state.stocks['stock-b'].lotConstraints).toEqual({
        knowledge: 'recorded',
        lotIds: ['common', 'lot-a', 'lot-b'],
      });
      state = apply(state, recall());
      refused(state, 'LOT_RECALLED', use('stock-b'));
    }
  );

  it('carries original restrictions through aliquots, prepared lots, pools and dilutions', () => {
    let state = apply(
      fixture(true),
      aliquot(),
      {
        kind: 'create-lot',
        id: 'prepared',
        materialId: 'material',
        name: 'Preparation',
        origin: {
          kind: 'prepared',
          sourceStockIds: ['stock-a', 'stock-b'],
          method: 'Explicit preparation',
        },
      },
      {
        kind: 'receive-lot-stock',
        id: 'preparation',
        vesselId: 'd',
        lotId: 'prepared',
        quantity: { kind: 'known', ...volume('20') },
        quality: 'usable',
      },
      {
        kind: 'pool',
        lotId: 'pool-lot',
        stockId: 'pooled',
        vesselId: 'e',
        materialId: 'material',
        name: 'Pool',
        inputs: [
          { stockId: 'stock-a', quantity: volume('5') },
          { stockId: 'stock-b', quantity: volume('5') },
        ],
        reason: 'Pool components',
      },
      {
        kind: 'dilute',
        lotId: 'dilution-lot',
        stockId: 'diluted',
        vesselId: 'f',
        materialId: 'material',
        name: 'Dilution',
        sample: { stockId: 'stock-a', quantity: volume('5') },
        diluent: { stockId: 'stock-b', quantity: volume('5') },
        reason: 'Tracked dilution',
      }
    );
    expect(state.lots.prepared.lotConstraints).toEqual({
      knowledge: 'recorded',
      lotIds: ['lot-a', 'lot-b', 'prepared'],
    });
    state = apply(state, recall(), {
      kind: 'associate-stock-lot',
      stockId: 'aliquot',
      lotId: 'lot-b',
      reason: 'Revised attribution',
    });
    expect(state.stocks.aliquot.source).toEqual({ kind: 'lot', lotId: 'lot-b' });
    expect(state.stocks.aliquot.lotConstraints.lotIds).toEqual(['lot-a', 'lot-b']);
    for (const id of ['stock-a', 'aliquot', 'preparation', 'pooled', 'diluted']) {
      expect(inventoryStockEligibility(state, id, context.at)?.blockers).toContainEqual({
        code: 'LOT_RECALLED',
        lotId: 'lot-a',
        recallIds: ['recall-a'],
      });
      refused(state, 'LOT_RECALLED', use(id));
    }
    expect(inventoryStockEligibility(state, 'stock-b', context.at)?.blockers).toEqual([]);
    state = apply(state, {
      kind: 'reconcile',
      stockId: 'aliquot',
      quantity: { kind: 'known', ...volume('0') },
      reason: 'Recorded depletion',
    });
    expect(state.stocks.aliquot.lotConstraints.lotIds).toEqual(['lot-a', 'lot-b']);
  });

  it('keeps pourback finite and does not rewrite earlier sibling or preparation ancestry', () => {
    let state = apply(
      fixture(true),
      aliquot('c', 'sibling'),
      {
        kind: 'create-lot',
        id: 'before',
        materialId: 'material',
        name: 'Earlier preparation',
        origin: { kind: 'prepared', sourceStockIds: ['stock-a'], method: 'Earlier input snapshot' },
      },
      {
        kind: 'associate-stock-lot',
        stockId: 'stock-a',
        lotId: 'lot-b',
        reason: 'Later attribution',
      },
      aliquot('d', 'later'),
      {
        kind: 'transfer',
        sourceStockId: 'later',
        quantity: volume('10'),
        destination: { kind: 'existing-stock', stockId: 'stock-a' },
        reason: 'Pour back aliquot',
      }
    );
    expect(state.stocks['stock-a'].lotConstraints.lotIds).toEqual(['lot-a', 'lot-b']);
    expect(state.stocks.later.lotConstraints.lotIds).toEqual(['lot-a', 'lot-b']);
    expect(state.stocks.sibling.lotConstraints.lotIds).toEqual(['lot-a']);
    expect(state.lots.before.lotConstraints.lotIds).toEqual(['before', 'lot-a']);
    state = apply(state, recall('later-recall', 'lot-b'));
    refused(state, 'LOT_RECALLED', use());
    expect(inventoryStockEligibility(state, 'sibling', context.at)?.blockers).toEqual([]);
    expect(state.stocks.later.quantity).toEqual({ kind: 'known', ...volume('0') });
  });

  it('preserves inherited partial knowledge in new physical derivations', () => {
    const legacy = projectLegacyInventoryLotConstraints(fixture(true));
    const state = apply(legacy, aliquot(), {
      kind: 'create-lot',
      id: 'derived',
      materialId: 'material',
      name: 'Derived',
      origin: { kind: 'prepared', sourceStockIds: ['aliquot'], method: 'Preparation' },
    });
    expect(state.stocks.aliquot.lotConstraints).toEqual({
      knowledge: 'legacy-partial',
      lotIds: ['lot-a'],
    });
    expect(state.lots.derived.lotConstraints).toEqual({
      knowledge: 'legacy-partial',
      lotIds: ['derived', 'lot-a'],
    });
  });

  it('refuses merging into a recalled destination and rolls back an earlier same-batch reservation', () => {
    const state = apply(fixture(true), aliquot(), recall('destination-recall', 'lot-a'));
    refused(state, 'LOT_RECALLED', hold('stock-b'), {
      kind: 'transfer',
      sourceStockId: 'stock-b',
      quantity: volume('1'),
      destination: { kind: 'existing-stock', stockId: 'aliquot' },
      reason: 'Attempted merge into recalled material',
    });
  });
});

describe('legacy projection and archive authority', () => {
  it('projects only immutable captured ancestry, ignoring accumulated history and mutable root attribution', () => {
    const state = apply(
      fixture(true),
      {
        kind: 'create-lot',
        id: 'snapshot',
        materialId: 'material',
        name: 'Snapshot',
        origin: { kind: 'prepared', sourceStockIds: ['stock-a'], method: 'Captured input' },
      },
      {
        kind: 'associate-stock-lot',
        stockId: 'stock-a',
        lotId: 'lot-b',
        reason: 'Later reassociation',
      }
    );
    const before = structuredClone(state);
    const projected = projectLegacyInventoryLotConstraints(state);
    expect(state).toEqual(before);
    expect(projected.stocks['stock-a'].lotConstraints).toEqual({
      knowledge: 'legacy-partial',
      lotIds: ['lot-b'],
    });
    expect(projected.lots.snapshot.lotConstraints).toEqual({
      knowledge: 'legacy-partial',
      lotIds: ['lot-a', 'snapshot'],
    });
    expect(projectLegacyInventoryLotConstraints(projected)).toEqual(projected);
  });

  it('makes V1 post-entry projection converge with a pure v18 final-snapshot upcast', () => {
    const commands: InventoryCommand[] = [
      { kind: 'create-vessel', id: 'v', name: 'Vessel', placement: { kind: 'unplaced' } },
      created('old'),
      created('new'),
      {
        kind: 'receive-lot-stock',
        id: 'stock',
        vesselId: 'v',
        lotId: 'old',
        quantity: { kind: 'known', ...volume('5') },
        quality: 'usable',
      },
      {
        kind: 'associate-stock-lot',
        stockId: 'stock',
        lotId: 'new',
        reason: 'Historical reassociation',
      },
    ];
    let replay = createInventoryState();
    for (const command of commands)
      replay = projectLegacyInventoryLotConstraints(apply(replay, command));
    const raw = structuredClone(apply(createInventoryState(), ...commands)) as unknown as Record<
      string,
      unknown
    >;
    raw.schema = 'dnaforge.inventory.v18';
    raw.revision = replay.revision;
    delete raw.lotRecalls;
    delete raw.openingObservations;
    delete raw.validityFacts;
    for (const lot of Object.values(raw.lots as Record<string, Record<string, unknown>>)) {
      delete lot.controls;
      delete lot.lotConstraints;
      delete lot.validity;
      delete lot.inheritedValidity;
    }
    for (const stock of Object.values(raw.stocks as Record<string, Record<string, unknown>>)) {
      delete stock.lotConstraints;
      delete stock.opening;
      delete stock.validity;
      delete stock.inheritedValidity;
    }
    expect(parseInventoryState(raw)).toEqual(replay);
    expect(replay.stocks.stock.lotConstraints).toEqual({
      knowledge: 'legacy-partial',
      lotIds: ['new'],
    });
  });

  it('retains foreign holds and recall while requiring a new local assessment for imported release', () => {
    const sourceState = apply(fixture(true), recall());
    const adopted = adoptInventoryState(
      null,
      sourceState,
      {
        source: {
          archiveSha256: `sha256:${'a'.repeat(64)}`,
          projectId: 'source',
          inventoryId: 'inventory',
          revision: sourceState.revision,
        },
        materialBindings: { material: 'material' },
      },
      context
    );
    if (!adopted.ok) throw new Error(`${adopted.code}: ${adopted.message}`);
    let state = adopted.state;
    expect(inventoryStockEligibility(state, 'stock-a', context.at)?.blockers).toEqual([
      { code: 'LOT_ASSESSMENT_IMPORTED', lotId: 'lot-a' },
      { code: 'LOT_RECALLED', lotId: 'lot-a', recallIds: ['recall-a'] },
    ]);
    state = apply(state, assess('released'));
    refused(state, 'LOT_RECALLED', use());
    state = apply(state, {
      kind: 'withdraw-lot-recall',
      recallId: 'recall-a',
      reason: 'Explicit local recall withdrawal',
    });
    expect(inventoryStockEligibility(state, 'stock-a', context.at)?.blockers).toEqual([]);
    expect(state.lotRecalls['recall-a'].by.kind).toBe('imported');
  });
});
