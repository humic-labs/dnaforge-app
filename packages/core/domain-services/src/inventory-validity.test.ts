import { describe, expect, it } from 'vitest';
import {
  adoptInventoryState,
  applyInventoryCommandBatch,
  createInventoryState,
  inventoryAvailability,
  inventoryStockValidity,
  inventoryValidityFamilyHead,
  parseInventoryState,
  type InventoryCommand,
  type InventoryExecutionContext,
  type InventoryState,
  type InventoryValidityRule,
} from './inventory';

const actor = { kind: 'agent' as const, identityId: 'scientist' };
const context = (at: number): InventoryExecutionContext => ({
  at,
  principal: actor,
  authority: { kind: 'local-profile', profileKey: 'profile' },
});
const volume = (value: string) => ({ value, unit: 'uL' as const });
function apply(state: InventoryState, at: number, ...commands: InventoryCommand[]): InventoryState {
  const result = applyInventoryCommandBatch(
    state,
    { expectedRevision: state.revision, commands },
    context(at)
  );
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  expect(parseInventoryState(result.state)).toEqual(result.state);
  return result.state;
}
function refused(
  state: InventoryState,
  at: number,
  code: string,
  ...commands: InventoryCommand[]
): void {
  const before = structuredClone(state);
  expect(
    applyInventoryCommandBatch(state, { expectedRevision: state.revision, commands }, context(at))
  ).toMatchObject({ ok: false, code });
  expect(state).toEqual(before);
}
function fixture(): InventoryState {
  return apply(
    createInventoryState(),
    100,
    {
      kind: 'create-lot',
      id: 'lot',
      name: 'Lot',
      materialId: 'material',
      origin: { kind: 'received', supplier: 'Supplier', lotNumber: '1' },
    },
    ...['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({
      kind: 'create-vessel' as const,
      id,
      name: id,
      placement: { kind: 'unplaced' as const },
    })),
    ...['a', 'b'].map((id) => ({
      kind: 'receive-lot-stock' as const,
      id: `stock-${id}`,
      vesselId: id,
      lotId: 'lot',
      quantity: { kind: 'known' as const, ...volume('100') },
      quality: 'usable' as const,
    }))
  );
}
function rule(value: InventoryValidityRule, id = 'policy', stockId = 'stock-a'): InventoryCommand {
  return {
    kind: 'record-validity-decision',
    id,
    owner: { kind: 'stock', stockId },
    rule: value,
    sourceText: 'Retained supplier wording',
    sourcePrecision: 'unknown',
    source: null,
    reason: 'Explicit local interpretation',
  };
}
function correction(
  supersedesId: string,
  value: InventoryValidityRule,
  id = 'corrected-policy'
): InventoryCommand {
  return {
    kind: 'correct-validity-decision',
    id,
    supersedesId,
    rule: value,
    sourceText: 'Corrected interpretation of retained wording',
    sourcePrecision: 'unknown',
    source: null,
    reason: 'Correct the named policy family',
  };
}
function opening(
  value: 'sealed' | 'opened',
  observedAt: number | null,
  id = 'opening',
  stockId = 'stock-a'
): InventoryCommand {
  return {
    kind: 'record-stock-opening',
    id,
    stockId,
    value,
    observedAt,
    source: null,
    reason: 'Actual container observation',
  };
}
function use(stockId = 'stock-a'): Extract<InventoryCommand, { kind: 'consume' }> {
  return { kind: 'consume', stockId, quantity: volume('1'), reason: 'Experiment' };
}
function transfer(
  stockId = 'child',
  vesselId = 'c'
): Extract<InventoryCommand, { kind: 'transfer' }> {
  return {
    kind: 'transfer',
    sourceStockId: 'stock-a',
    quantity: volume('10'),
    destination: { kind: 'new-stock', stockId, vesselId },
    reason: 'Aliquot material',
  };
}
const reserve = (): Extract<InventoryCommand, { kind: 'reserve-quantity' }> => ({
  kind: 'reserve-quantity',
  id: 'hold',
  stockId: 'stock-a',
  quantity: volume('5'),
  deadline: null,
  purpose: 'Planned use',
});

describe('explicit opening and action-specific validity', () => {
  it('does not invent an opening gate without a dependent policy', () => {
    let state = fixture();
    expect(state.stocks['stock-a'].opening).toEqual({ kind: 'unobserved', observationId: null });
    expect(inventoryStockValidity(state, 'stock-a', 100)).toMatchObject({
      coverage: 'legacy-untracked',
      state: 'legacy-untracked',
      reserve: { kind: 'allowed' },
      withdraw: { kind: 'allowed' },
    });
    state = apply(
      state,
      100,
      opening('sealed', 90),
      rule({ kind: 'absolute', deadlineAt: 500 }),
      use()
    );
    expect(inventoryAvailability(state, actor, 400).stocks['stock-a'].actions.withdraw.kind).toBe(
      'allowed'
    );
  });

  it('reserves observed sealed stock but requires opening before use in the same atomic batch', () => {
    let state = apply(
      fixture(),
      100,
      opening('sealed', 90),
      rule({ kind: 'after-opening', openingStockId: 'stock-a', elapsedMs: 1000 })
    );
    const stock = inventoryAvailability(state, actor, 100).stocks['stock-a'];
    expect(stock.actions.reserve).toEqual({ kind: 'allowed' });
    expect(stock.actions.withdraw).toMatchObject({
      kind: 'blocked',
      blockers: [{ code: 'OPENING_REQUIRED' }],
    });
    expect(stock.blockers).toEqual(
      stock.actions.withdraw.kind === 'blocked' ? stock.actions.withdraw.blockers : []
    );
    state = apply(state, 100, reserve());
    refused(state, 101, 'OPENING_REQUIRED', use());
    state = apply(state, 101, opening('opened', 95, 'first-open'), use());
    expect(inventoryStockValidity(state, 'stock-a', 101)?.effectiveDeadlineAt).toBe(1095);
    expect(state.openingObservations['first-open']).toMatchObject({
      kind: 'opening',
      supersedesId: 'opening',
      observedAt: 95,
      at: 101,
    });
  });

  it('admits a false opened report as corrected-unobserved without clearing history or relative constraints', () => {
    let state = apply(
      fixture(),
      100,
      opening('opened', 90),
      rule({ kind: 'after-opening', openingStockId: 'stock-a', elapsedMs: 1000 })
    );
    state = apply(state, 110, transfer());
    state = apply(state, 120, {
      kind: 'correct-stock-opening',
      id: 'unknown-status',
      stockId: 'stock-a',
      supersedesId: 'opening',
      value: 'unobserved',
      observedAt: null,
      source: null,
      reason: 'The original opening report was unreliable',
    });
    expect(state.stocks['stock-a'].opening).toEqual({
      kind: 'unobserved',
      observationId: 'unknown-status',
    });
    expect(state.openingObservations.opening.value).toBe('opened');
    expect(state.openingObservations['unknown-status']).toMatchObject({
      value: 'unobserved',
      observedAt: null,
      supersedesId: 'opening',
    });
    refused(state, 120, 'VALIDITY_UNRESOLVED', use('child'));
    refused(state, 120, 'OPENING_ALREADY_RECORDED', opening('sealed', 120, 'reseal'));
    state = apply(state, 160, opening('opened', 150, 'later-open'));
    refused(state, 160, 'VALIDITY_CHRONOLOGY_CONFLICT', use('child'));
    expect(state.stocks.child.inheritedValidity).toEqual([
      { rootId: 'policy', openingNoLaterThan: 110 },
    ]);
  });

  it('keeps unknown opening time distinct and pins corrections to the exact current head', () => {
    let state = apply(
      fixture(),
      100,
      opening('opened', null),
      rule({ kind: 'after-opening', openingStockId: 'stock-a', elapsedMs: 1000 })
    );
    refused(state, 100, 'OPENING_TIME_UNKNOWN', reserve());
    state = apply(state, 100, {
      kind: 'correct-stock-opening',
      id: 'known-time',
      stockId: 'stock-a',
      supersedesId: 'opening',
      value: 'opened',
      observedAt: 90,
      source: null,
      reason: 'Recovered actual opening time',
    });
    refused(state, 100, 'OPENING_STALE_HEAD', {
      kind: 'correct-stock-opening',
      id: 'stale',
      stockId: 'stock-a',
      supersedesId: 'opening',
      value: 'opened',
      observedAt: 95,
      source: null,
      reason: 'Stale correction',
    });
    refused(state, 100, 'OPENING_ALREADY_RECORDED', opening('opened', 95, 'repeat'));
    refused(state, 100, 'OBSERVATION_TIME_FUTURE', opening('opened', 101, 'future', 'stock-b'));
  });

  it('expires exactly at the cutoff and rechecks reservation fulfillment without changing held stock', () => {
    const state = apply(fixture(), 100, rule({ kind: 'absolute', deadlineAt: 500 }), reserve());
    expect(inventoryAvailability(state, actor, 499).stocks['stock-a']).toMatchObject({
      validity: { effectiveDeadlineAt: 500, nextBoundaryAt: 500 },
      actions: { reserve: { kind: 'allowed' }, withdraw: { kind: 'allowed' } },
    });
    expect(
      inventoryAvailability(state, actor, 500).stocks['stock-a'].validity.nextBoundaryAt
    ).toBeNull();
    for (const command of [
      use(),
      transfer(),
      { ...reserve(), id: 'late-hold' },
      {
        kind: 'fulfill-reservations' as const,
        claims: [{ reservationId: 'hold', quantity: volume('1') }],
        withdrawal: use(),
      },
    ])
      refused(state, 500, 'MATERIAL_EXPIRED', command);
    expect(state.reservations.hold.lifecycle).toEqual({ kind: 'active' });
  });
});

describe('frozen stock policy families and live lot owners', () => {
  it.each(['absolute', 'not-required', 'unresolved'] as const)(
    'captures %s families in preparation metadata and binds physical receipt time',
    (kind) => {
      let state = apply(
        fixture(),
        100,
        rule(kind === 'absolute' ? { kind, deadlineAt: 1000 } : { kind }),
        {
          kind: 'create-lot',
          id: 'prepared',
          name: 'Preparation',
          materialId: 'material',
          origin: { kind: 'prepared', sourceStockIds: ['stock-a'], method: 'Recorded preparation' },
        }
      );
      expect(state.lots.prepared.inheritedValidity).toEqual([
        { rootId: 'policy', openingNoLaterThan: null },
      ]);
      state = apply(state, 110, {
        kind: 'receive-lot-stock',
        id: 'prepared-stock',
        vesselId: 'c',
        lotId: 'prepared',
        quantity: { kind: 'known', ...volume('20') },
        quality: 'usable',
      });
      expect(state.stocks['prepared-stock'].inheritedValidity).toEqual([
        { rootId: 'policy', openingNoLaterThan: 110 },
      ]);
      state = apply(
        state,
        120,
        opening('opened', 90),
        correction('policy', { kind: 'after-opening', openingStockId: 'stock-a', elapsedMs: 1000 })
      );
      expect(inventoryStockValidity(state, 'prepared-stock', 120)?.effectiveDeadlineAt).toBe(1090);
    }
  );

  it('keeps earlier children isolated from unrelated later parent policies and prevents opening-clock reset', () => {
    let state = apply(fixture(), 100, rule({ kind: 'absolute', deadlineAt: 1000 }));
    state = apply(state, 110, transfer());
    state = apply(
      state,
      120,
      rule({ kind: 'absolute', deadlineAt: 130 }, 'later-parent-policy'),
      opening('opened', 90),
      correction('policy', { kind: 'after-opening', openingStockId: 'stock-a', elapsedMs: 1000 }),
      opening('opened', 115, 'child-open', 'child')
    );
    expect(inventoryStockValidity(state, 'child', 140)?.effectiveDeadlineAt).toBe(1090);
    expect(state.stocks.child.inheritedValidity).toEqual([
      { rootId: 'policy', openingNoLaterThan: 110 },
    ]);
    refused(state, 140, 'MATERIAL_EXPIRED', use());
  });

  it.each(['pool', 'dilute'] as const)('retains all source family kinds in %s output', (kind) => {
    const shared = {
      lotId: 'output-lot',
      stockId: 'output',
      vesselId: 'c',
      materialId: 'material',
      name: 'Output',
      reason: 'Prepare material',
    };
    const a = { stockId: 'stock-a', quantity: volume('5') };
    const b = { stockId: 'stock-b', quantity: volume('5') };
    const state = apply(
      apply(
        fixture(),
        100,
        rule({ kind: 'not-required' }),
        rule({ kind: 'absolute', deadlineAt: 500 }, 'second', 'stock-b')
      ),
      110,
      kind === 'pool'
        ? { kind, ...shared, inputs: [a, b] }
        : { kind, ...shared, sample: a, diluent: b }
    );
    expect(state.stocks.output.inheritedValidity).toEqual([
      { rootId: 'policy', openingNoLaterThan: 110 },
      { rootId: 'second', openingNoLaterThan: 110 },
    ]);
    expect(state.lots['output-lot'].inheritedValidity).toEqual(
      state.stocks.output.inheritedValidity
    );
  });

  it('unions pourback and known-zero destination families with the earliest physical bound', () => {
    let state = apply(
      fixture(),
      100,
      rule({ kind: 'not-required' }),
      rule({ kind: 'absolute', deadlineAt: 1000 }, 'destination', 'stock-b')
    );
    state = apply(state, 110, transfer());
    state = apply(
      state,
      120,
      {
        kind: 'transfer',
        sourceStockId: 'child',
        quantity: volume('10'),
        destination: { kind: 'existing-stock', stockId: 'stock-a' },
        reason: 'Pour back',
      },
      {
        kind: 'reconcile',
        stockId: 'stock-b',
        quantity: { kind: 'known', ...volume('0') },
        reason: 'Measured zero',
      }
    );
    state = apply(state, 130, {
      kind: 'transfer',
      sourceStockId: 'stock-a',
      quantity: volume('1'),
      destination: { kind: 'existing-stock', stockId: 'stock-b' },
      reason: 'Add to tracked zero stock',
    });
    expect(state.stocks['stock-a'].inheritedValidity).toEqual([
      { rootId: 'policy', openingNoLaterThan: 110 },
    ]);
    expect(state.stocks['stock-b'].inheritedValidity).toEqual([
      { rootId: 'destination', openingNoLaterThan: 130 },
      { rootId: 'policy', openingNoLaterThan: 110 },
    ]);
  });

  it('applies a later learned lot absolute cutoff without relying on mutable parent stock', () => {
    let state = apply(fixture(), 110, transfer());
    state = apply(state, 120, {
      kind: 'record-validity-decision',
      id: 'lot-cutoff',
      owner: { kind: 'lot', lotId: 'lot' },
      rule: { kind: 'absolute', deadlineAt: 150 },
      sourceText: '2026-11',
      sourcePrecision: 'month',
      source: null,
      reason: 'Explicit interpretation as selected instant; printed precision retained',
    });
    expect(state.validityFacts['lot-cutoff'].sourcePrecision).toBe('month');
    refused(state, 150, 'MATERIAL_EXPIRED', use('child'));
  });
});

describe('validity authority and atomic fact recording', () => {
  it('requires local interpretation after adoption without fabricating a local opening event', () => {
    const source = apply(
      fixture(),
      100,
      opening('opened', 90),
      rule({ kind: 'after-opening', openingStockId: 'stock-a', elapsedMs: 1000 })
    );
    const adopted = adoptInventoryState(
      null,
      source,
      {
        source: {
          archiveSha256: `sha256:${'a'.repeat(64)}`,
          projectId: 'source',
          inventoryId: 'inventory',
          revision: source.revision,
        },
        materialBindings: { material: 'material' },
      },
      context(150)
    );
    if (!adopted.ok) throw new Error(`${adopted.code}: ${adopted.message}`);
    refused(adopted.state, 150, 'VALIDITY_ASSESSMENT_IMPORTED', use());
    const state = apply(
      adopted.state,
      150,
      correction('policy', { kind: 'after-opening', openingStockId: 'stock-a', elapsedMs: 1000 })
    );
    expect(inventoryStockValidity(state, 'stock-a', 150)?.withdraw.kind).toBe('allowed');
    expect(Object.keys(state.openingObservations)).toEqual(['opening']);
    expect(state.openingObservations.opening.by.kind).toBe('imported');
  });

  it('pins family heads and rolls back policy correction and claims on a later failure', () => {
    let state = apply(fixture(), 100, rule({ kind: 'not-required' }), reserve(), {
      kind: 'record-vessel-contents',
      vesselId: 'c',
      knowledge: 'unobserved',
      reason: 'Destination not checked',
    });
    refused(
      state,
      110,
      'VESSEL_CONTENTS_UNRESOLVED',
      correction('policy', { kind: 'absolute', deadlineAt: 1000 }),
      {
        kind: 'fulfill-reservations',
        claims: [{ reservationId: 'hold', quantity: volume('1') }],
        withdrawal: { ...transfer(), quantity: volume('1') },
      }
    );
    expect(inventoryValidityFamilyHead(state, 'policy')?.id).toBe('policy');
    state = apply(state, 110, correction('policy', { kind: 'absolute', deadlineAt: 1000 }));
    refused(
      state,
      110,
      'VALIDITY_STALE_HEAD',
      correction('policy', { kind: 'not-required' }, 'stale')
    );
    refused(
      state,
      110,
      'ID_ALREADY_EXISTS',
      rule({ kind: 'not-required' }, 'opening', 'stock-b'),
      opening('opened', 100, 'opening')
    );
  });
});
