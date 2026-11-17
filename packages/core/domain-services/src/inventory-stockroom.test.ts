import { describe, expect, it } from 'vitest';
import { applyInventoryArrival, inventoryArrivalPreview } from './inventory-arrivals';
import { inventoryStockroomProjection } from './inventory-stockroom';
import { applyInventoryCommandBatch } from './inventory-state';
import { inventoryAvailability } from './inventory-reservations';
import { adoptInventoryState } from './inventory-adoption';
import { inventoryTableSha256 } from './inventory-table-binding';
import type { InventoryCommand, InventoryState } from './inventory-types';
import type { InventoryArrivalChoices, InventoryArrivalSource } from './inventory-arrival-types';
import type { InventoryStockroomCommand } from './inventory-stockroom-types';

const principal = { kind: 'local-profile' as const, profileKey: 'stockroom-profile' };
const context = { at: 100, principal, authority: principal };
function apply(
  state: InventoryState,
  commands: readonly InventoryCommand[],
  at = 100
): InventoryState {
  const result = applyInventoryCommandBatch(
    state,
    { expectedRevision: state.revision, commands },
    { ...context, at }
  );
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.state;
}
function refused(state: InventoryState, commands: readonly InventoryCommand[], code?: string) {
  const before = JSON.stringify(state),
    result = applyInventoryCommandBatch(
      state,
      { expectedRevision: state.revision, commands },
      context
    );
  expect(result.ok).toBe(false);
  if (code && !result.ok) expect(result.code).toBe(code);
  expect(JSON.stringify(state)).toBe(before);
}
function fixture(unknown = false, value = '1', unit: 'mg' | 'ng' = 'mg') {
  const source: InventoryArrivalSource = {
    schema: 'dnaforge.inventory-arrival-source.v1',
    identity: { namespace: 'stockroom', arrivalId: 'delivery' },
    supplier: null,
    observedAt: 90,
    observationReason: 'Actual synthetic receipt',
    scope: { kind: 'selected-components', reason: 'Selected observed components' },
    documents: [],
    packages: [],
    components: [
      {
        key: 'known',
        packageKey: null,
        label: 'Known amount',
        productCode: null,
        componentBatch: null,
      },
      ...(unknown
        ? [
            {
              key: 'unknown',
              packageKey: null,
              label: 'Unknown amount',
              productCode: null,
              componentBatch: null,
            },
          ]
        : []),
    ],
    claims: [],
  };
  const options: InventoryArrivalChoices = {
    components: source.components.map((component) => ({
      componentKey: component.key,
      kind: 'identified' as const,
      materialId: 'material',
      lot: { kind: 'unattributed' as const, reason: 'Supplier batch unknown' },
      quantity:
        component.key === 'unknown'
          ? { kind: 'unknown' as const, unit: 'mg' as const }
          : { kind: 'known' as const, value, unit },
      quantityBasis:
        component.key === 'unknown'
          ? { kind: 'unknown' as const, reason: 'Amount not measured' }
          : { kind: 'measurement' as const, reason: 'Actual receiving measurement' },
      stockQuality: { value: 'usable' as const, reason: 'Stock local assessment' },
      vessel: { name: component.label, placement: { kind: 'unplaced' as const } },
    })),
  };
  const sourceText = JSON.stringify(source),
    target = { projectId: 'project', inventoryId: 'inventory', present: false, revision: 0 };
  const preview = inventoryArrivalPreview(null, {
    target,
    sourceText,
    options,
    bindings: options.components.map((choice) => ({
      kind: 'admitted' as const,
      key: choice.componentKey,
      materialId: 'material',
      fingerprint: inventoryTableSha256('scientific material'),
    })),
    asOf: 100,
    principal,
    authority: principal,
    maxBytes: 17 * 1024 * 1024,
  });
  if (preview.kind !== 'ready') throw new Error(JSON.stringify(preview));
  const result = applyInventoryArrival(
    null,
    { target, sourceText, options: preview.options, expectedPlanDigest: preview.planDigest },
    context,
    17 * 1024 * 1024
  );
  if (!result.ok) throw new Error(result.message);
  return {
    state: result.state,
    arrivalId: preview.arrival.id,
    stockId: preview.arrival.components.find((component) => component.key === 'known')!.target
      .stockId!,
    unknownId:
      preview.arrival.components.find((component) => component.key === 'unknown')?.target.stockId ??
      null,
  };
}
const line = (
  id = 'line',
  value = '2',
  unit: 'mg' | 'ng' | 'uL' | 'item' = 'mg',
  materialId = 'material'
): InventoryStockroomCommand => ({
  kind: 'record-expected-delivery',
  id,
  name: id,
  supplier: null,
  externalReference: null,
  materialId,
  quantity: { value, unit },
  reason: 'Local expectation, no vendor order',
});
const allocate = (
  arrivalId: string,
  id = 'allocation',
  value = '1',
  lineId = 'line',
  componentKey = 'known',
  unit: 'mg' | 'ng' | 'uL' = 'mg'
): InventoryStockroomCommand => ({
  kind: 'allocate-arrival',
  id,
  lineId,
  arrivalId,
  componentKey,
  quantity: { value, unit },
  reason: 'Explicit original receipt matching',
});
const rule = (
  id = 'rule',
  value = '0.75',
  basis: 'reserve' | 'withdraw' = 'withdraw',
  validity: 'current-recorded-rules' | 'confirmed-current-validity' = 'current-recorded-rules'
): InventoryStockroomCommand => ({
  kind: 'record-reorder-rule',
  id,
  name: id,
  materialId: 'material',
  threshold: { value, unit: 'mg' },
  actionBasis: basis,
  validityBasis: validity,
  reason: 'Explicit current stock threshold',
});
function assessment(state: InventoryState, id = 'rule', asOf = 100) {
  const result = inventoryStockroomProjection(state, principal, asOf).reorderRules[id];
  if (result.kind !== 'ready') throw new Error(JSON.stringify(result));
  return result.assessment;
}

describe('original receipt matching and expected delivery lifecycle', () => {
  it('records expectations without stock and allocates the ORIGINAL amount after current stock was consumed', () => {
    const current = fixture();
    let state = apply(current.state, [
      {
        kind: 'consume',
        stockId: current.stockId,
        quantity: { value: '0.25', unit: 'mg' },
        reason: 'Already used actual material',
      },
    ]);
    const beforeStocks = structuredClone(state.stocks),
      beforeVessels = structuredClone(state.vessels);
    state = apply(state, [line(), allocate(current.arrivalId)]);
    const report = inventoryStockroomProjection(state, principal, 100);
    expect(report.expectedDeliveries.line).toMatchObject({
      allocated: { value: '1000000', unit: 'ng' },
      remaining: { value: '1000000', unit: 'ng' },
      progress: 'partly-received',
    });
    expect(report.arrivalComponents[0]).toMatchObject({
      received: { value: '1000000', unit: 'ng' },
      allocated: { value: '1000000', unit: 'ng' },
      unmatched: { value: '0', unit: 'ng' },
    });
    expect(state.stocks).toEqual(beforeStocks);
    expect(state.vessels).toEqual(beforeVessels);
    state = apply(state, [
      {
        kind: 'consume',
        stockId: current.stockId,
        quantity: { value: '0.1', unit: 'mg' },
        reason: 'Further actual use',
      },
      {
        kind: 'dispose-vessel',
        id: state.stocks[current.stockId].vesselId,
        reason: 'Physical disposal',
      },
    ]);
    expect(inventoryStockroomProjection(state, principal, 100).expectedDeliveries.line).toEqual(
      report.expectedDeliveries.line
    );
  });
  it('caps allocations across ALL active lines against immutable received quantity', () => {
    const current = fixture();
    let state = apply(current.state, [
      line('first'),
      line('second'),
      allocate(current.arrivalId, 'first-match', '0.6', 'first'),
    ]);
    refused(
      state,
      [allocate(current.arrivalId, 'second-match', '0.5', 'second')],
      'ALLOCATION_EXCEEDS_RECEIPT'
    );
    state = apply(state, [allocate(current.arrivalId, 'second-match', '0.4', 'second')]);
    expect(
      inventoryStockroomProjection(state, principal, 100).arrivalComponents[0].unmatched
    ).toEqual({ value: '0', unit: 'ng' });
  });
  it('keeps real over-delivery unmatched rather than clipping it or silently expanding expectation', () => {
    const current = fixture();
    const state = apply(current.state, [line('line', '0.25')]);
    refused(
      state,
      [allocate(current.arrivalId, 'oversized', '0.5')],
      'ALLOCATION_EXCEEDS_EXPECTATION'
    );
    const matched = apply(state, [allocate(current.arrivalId, 'match', '0.25')]);
    const report = inventoryStockroomProjection(matched, principal, 100);
    expect(report.expectedDeliveries.line.progress).toBe('fully-received');
    expect(report.arrivalComponents[0].unmatched).toEqual({ value: '750000', unit: 'ng' });
    expect(matched.stocks).toEqual(current.state.stocks);
  });
  it('requires reopening a closed remainder before correcting matching and never changes physical quantities', () => {
    const current = fixture();
    let state = apply(current.state, [
      line(),
      allocate(current.arrivalId),
      {
        kind: 'close-expected-delivery-remainder',
        lineId: 'line',
        reason: 'Cancel unreceived remainder',
      },
    ]);
    const originalStocks = structuredClone(state.stocks);
    expect(state.expectedDeliveries.line.lifecycle).toMatchObject({
      kind: 'remainder-closed',
      remainingAtClose: { value: '1000000', unit: 'ng' },
    });
    refused(
      state,
      [{ kind: 'withdraw-arrival-allocation', allocationId: 'allocation', reason: 'Correction' }],
      'EXPECTED_DELIVERY_CLOSED'
    );
    refused(state, [allocate(current.arrivalId, 'fresh')], 'EXPECTED_DELIVERY_CLOSED');
    state = apply(state, [
      { kind: 'reopen-expected-delivery', lineId: 'line', reason: 'Correct commercial match' },
      {
        kind: 'withdraw-arrival-allocation',
        allocationId: 'allocation',
        reason: 'Wrong expectation selected',
      },
      {
        kind: 'close-expected-delivery-remainder',
        lineId: 'line',
        reason: 'Cancel corrected whole remainder',
      },
    ]);
    expect(state.expectedDeliveries.line.lifecycle).toMatchObject({
      kind: 'remainder-closed',
      remainingAtClose: { value: '2000000', unit: 'ng' },
    });
    expect(state.arrivalAllocations.allocation.lifecycle.kind).toBe('withdrawn');
    expect(
      inventoryStockroomProjection(state, principal, 100).expectedDeliveries.line.progress
    ).toBe('none-received');
    expect(state.stocks).toEqual(originalStocks);
  });
  it('refuses unknown, mismatched, nonpositive and fractional matching without side effects', () => {
    const current = fixture(true),
      state = apply(current.state, [
        line(),
        line('other', '2', 'mg', 'other-material'),
        line('volume', '1', 'uL'),
      ]);
    refused(
      state,
      [allocate(current.arrivalId, 'unknown', '1', 'line', 'unknown')],
      'ARRIVAL_COMPONENT_NOT_ALLOCATABLE'
    );
    refused(
      state,
      [allocate(current.arrivalId, 'other-material', '1', 'other')],
      'ALLOCATION_MATERIAL_MISMATCH'
    );
    refused(
      state,
      [allocate(current.arrivalId, 'wrong-dimension', '1', 'volume', 'known', 'uL')],
      'QUANTITY_DIMENSION_MISMATCH'
    );
    refused(state, [allocate(current.arrivalId, 'zero', '0')], 'INVALID_QUANTITY');
    refused(state, [line('fractional', '1.5', 'item')]);
  });
  it('rolls back an earlier new expectation when a later allocation fails', () => {
    const current = fixture();
    refused(
      current.state,
      [line('early'), allocate(current.arrivalId, 'later', '3', 'early')],
      'ALLOCATION_EXCEEDS_RECEIPT'
    );
    expect(current.state.expectedDeliveries).toEqual({});
  });
  it('preserves matched original facts and material mapping through adoption', () => {
    const current = fixture();
    const state = apply(current.state, [line(), allocate(current.arrivalId), rule()]);
    const adopted = adoptInventoryState(
      null,
      state,
      {
        source: {
          archiveSha256: inventoryTableSha256('archive'),
          projectId: 'project',
          inventoryId: 'inventory',
          revision: state.revision,
        },
        materialBindings: { material: 'mapped-material' },
      },
      { at: 200, principal, authority: principal }
    );
    if (!adopted.ok) throw new Error(adopted.message);
    const report = inventoryStockroomProjection(adopted.state, principal, 200);
    expect(report.expectedDeliveries.line.line.expectation.materialId).toBe('mapped-material');
    expect(report.expectedDeliveries.line.allocated).toEqual({ value: '1000000', unit: 'ng' });
    expect(report.expectedDeliveries.line.line.by.kind).toBe('imported');
    expect(adopted.state.arrivalAllocations.allocation.by.kind).toBe('imported');
    expect(report.arrivalComponents[0].materialId).toBe('mapped-material');
    expect(assessment(adopted.state, 'rule', 200).rule.materialId).toBe('mapped-material');
  });
});

describe('native-time reorder reports', () => {
  it('changes adequate to low only after actual use, never because an expected delivery was recorded', () => {
    const current = fixture();
    let state = apply(current.state, [rule()]);
    expect(assessment(state).conclusion).toBe('adequate');
    state = apply(state, [
      {
        kind: 'consume',
        stockId: current.stockId,
        quantity: { value: '0.3', unit: 'mg' },
        reason: 'Actual consumption',
      },
    ]);
    const before = assessment(state);
    expect(before).toMatchObject({
      knownUnreserved: { value: '700000', unit: 'ng' },
      conclusion: 'low',
    });
    state = apply(state, [line('incoming', '1000')]);
    expect(assessment(state)).toEqual(before);
    expect(state.stocks[current.stockId].quantity).toEqual({
      kind: 'known',
      value: '700000',
      unit: 'ng',
    });
  });
  it('proves adequate from a known nonnegative lower bound, otherwise retains eligible unknown as needs measurement', () => {
    const current = fixture(true),
      state = apply(current.state, [rule('enough', '0.5'), rule('uncertain', '2')]);
    expect(assessment(state, 'enough')).toMatchObject({
      conclusion: 'adequate',
      knownUnreserved: { value: '1000000', unit: 'ng' },
      unknownIncludedStockIds: [current.unknownId],
    });
    expect(assessment(state, 'uncertain').conclusion).toBe('needs-measurement');
    expect(
      inventoryAvailability(state, principal, 100).stocks[current.unknownId!].actions.withdraw.kind
    ).toBe('blocked');
  });
  it('excludes operationally blocked unknown stock instead of calling every unknown potentially usable', () => {
    const current = fixture(true);
    const state = apply(current.state, [
      rule('rule', '2'),
      {
        kind: 'set-quality',
        stockId: current.unknownId!,
        quality: 'quarantined',
        reason: 'Independent stock hold',
      },
    ]);
    const report = assessment(state);
    expect(report.conclusion).toBe('low');
    expect(report.unknownIncludedStockIds).toEqual([]);
    expect(report.excluded).toEqual([
      {
        stockId: current.unknownId,
        blockers: [{ code: 'STOCK_QUARANTINED' }],
        coverageReason: null,
      },
    ]);
  });
  it('distinguishes explicitly reservable sealed stock from withdrawal-ready stock under confirmed validity', () => {
    const current = fixture();
    const state = apply(current.state, [
      {
        kind: 'record-validity-decision',
        id: 'relative',
        owner: { kind: 'stock', stockId: current.stockId },
        rule: { kind: 'after-opening', openingStockId: current.stockId, elapsedMs: 1000 },
        sourceText: 'Explicit relative limit',
        sourcePrecision: 'elapsed-duration',
        source: null,
        reason: 'Local validity interpretation',
      },
      {
        kind: 'record-stock-opening',
        id: 'sealed',
        stockId: current.stockId,
        value: 'sealed',
        observedAt: 90,
        source: null,
        reason: 'Observed sealed',
      },
      rule('reserve', '0.75', 'reserve', 'confirmed-current-validity'),
      rule('withdraw', '0.75', 'withdraw', 'confirmed-current-validity'),
    ]);
    expect(assessment(state, 'reserve').conclusion).toBe('adequate');
    expect(assessment(state, 'withdraw').conclusion).toBe('low');
    expect(assessment(state, 'reserve').knownIncludedStockIds).toEqual([current.stockId]);
    expect(assessment(state, 'withdraw').excluded[0].blockers[0].code).toBe('OPENING_REQUIRED');
    expect(
      inventoryAvailability(state, principal, 100).stocks[current.stockId].validity.state
    ).toBe('unresolved');
  });
  it('discloses legacy coverage separately and never labels it confirmed current validity', () => {
    const current = fixture();
    const state = apply(current.state, [
      rule('legacy', '0.75', 'withdraw', 'current-recorded-rules'),
      rule('strict', '0.75', 'withdraw', 'confirmed-current-validity'),
    ]);
    expect(assessment(state, 'legacy')).toMatchObject({
      conclusion: 'adequate',
      legacyOrMixedValidityStockIds: [current.stockId],
    });
    expect(assessment(state, 'strict')).toMatchObject({
      conclusion: 'low',
      knownUnreserved: { value: '0', unit: 'ng' },
      excluded: [
        { stockId: current.stockId, blockers: [], coverageReason: 'validity-not-confirmed' },
      ],
    });
  });
  it('subtracts active holds including own holds while commercial matching does not reserve twice', () => {
    const current = fixture();
    const state = apply(current.state, [
      line(),
      allocate(current.arrivalId),
      rule('rule', '0.75'),
      {
        kind: 'reserve-quantity',
        id: 'hold',
        stockId: current.stockId,
        quantity: { value: '0.6', unit: 'mg' },
        purpose: 'Actual hold',
        deadline: null,
      },
    ]);
    expect(assessment(state)).toMatchObject({
      knownUnreserved: { value: '400000', unit: 'ng' },
      conclusion: 'low',
    });
    expect(state.stocks[current.stockId].quantity).toEqual({
      kind: 'known',
      value: '1000000',
      unit: 'ng',
    });
  });
  it('refreshes at exact native deadline without persisting a low or expired flag', () => {
    const current = fixture();
    const state = apply(current.state, [
      rule(),
      {
        kind: 'record-validity-decision',
        id: 'expiry',
        owner: { kind: 'stock', stockId: current.stockId },
        rule: { kind: 'absolute', deadlineAt: 200 },
        sourceText: 'Explicit cutoff',
        sourcePrecision: 'instant',
        source: null,
        reason: 'Local expiry interpretation',
      },
    ]);
    const saved = JSON.stringify(state);
    expect(assessment(state, 'rule', 199)).toMatchObject({
      conclusion: 'adequate',
      nextBoundaryAt: 200,
    });
    expect(assessment(state, 'rule', 200)).toMatchObject({
      conclusion: 'low',
      excluded: [
        {
          stockId: current.stockId,
          blockers: [expect.objectContaining({ code: 'MATERIAL_EXPIRED' })],
          coverageReason: null,
        },
      ],
    });
    expect(JSON.stringify(state)).toBe(saved);
  });
  it('keeps compatible units explicit and retires a rule without changing physical amounts', () => {
    const current = fixture();
    let state = apply(current.state, [
      rule(),
      {
        kind: 'create-vessel',
        id: 'volume-vessel',
        name: 'Different dimension',
        placement: { kind: 'unplaced' },
      },
      {
        kind: 'receive-stock',
        id: 'volume-stock',
        vesselId: 'volume-vessel',
        materialId: 'material',
        quantity: { kind: 'known', value: '1', unit: 'uL' },
        quality: 'usable',
      },
    ]);
    expect(assessment(state).incompatibleStockIds).toEqual(['volume-stock']);
    const stocks = structuredClone(state.stocks);
    state = apply(state, [
      { kind: 'retire-reorder-rule', ruleId: 'rule', reason: 'Replace threshold' },
    ]);
    expect(inventoryStockroomProjection(state, principal, 100).reorderRules.rule.kind).toBe(
      'retired'
    );
    expect(state.stocks).toEqual(stocks);
    refused(state, [rule('zero', '0')], 'INVALID_QUANTITY');
  });
  it('retains a proven adequate representable lower bound when an exact total exceeds decimal output bounds', () => {
    const amount = '9'.repeat(128),
      current = fixture(false, amount, 'ng');
    const state = apply(current.state, [
      rule('rule', '1'),
      {
        kind: 'create-vessel',
        id: 'second-vessel',
        name: 'Secondlargeamount',
        placement: { kind: 'unplaced' },
      },
      {
        kind: 'receive-stock',
        id: 'second-stock',
        vesselId: 'second-vessel',
        materialId: 'material',
        quantity: { kind: 'known', value: amount, unit: 'ng' },
        quality: 'usable',
      },
    ]);
    expect(assessment(state)).toMatchObject({
      conclusion: 'adequate',
      knownUnreserved: { value: amount, unit: 'ng' },
      knownUnreservedKind: 'at-least',
    });
  });
});
