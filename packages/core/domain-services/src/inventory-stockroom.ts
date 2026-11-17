import {
  addInventoryAmounts,
  compareInventoryAmounts,
  normalizeInventoryAmount,
  subtractInventoryAmounts,
  type InventoryAmount,
  type InventoryCanonicalAmount,
} from './inventory-amount';
import { inventoryRecordIdExists, type InventoryIdentityState } from './inventory-identity';
import { inventoryStockAvailabilityFacts } from './inventory-reservations';
import type {
  InventoryCommand,
  InventoryErrorCode,
  InventoryExecutionContext,
  InventoryPrincipal,
  InventoryState,
} from './inventory-types';
import type {
  InventoryArrivalAllocation,
  InventoryArrivalAllocationBalance,
  InventoryExpectedDelivery,
  InventoryExpectedDeliveryProgress,
  InventoryReorderAssessmentResult,
  InventoryReorderRule,
  InventoryStockroomProjection,
} from './inventory-stockroom-types';

type Failure = { readonly ok: false; readonly code: InventoryErrorCode; readonly message: string };
type StockroomState = InventoryIdentityState & Pick<InventoryState, 'lastRecordedAt'>;
export interface InventoryStockroomDraft extends Omit<
  InventoryIdentityState,
  'expectedDeliveries' | 'arrivalAllocations' | 'reorderRules'
> {
  readonly expectedDeliveries: Record<string, InventoryExpectedDelivery>;
  readonly arrivalAllocations: Record<string, InventoryArrivalAllocation>;
  readonly reorderRules: Record<string, InventoryReorderRule>;
}
const refusal = (code: InventoryErrorCode, message: string): Failure => ({
  ok: false,
  code,
  message,
});
const order = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const zero = (unit: InventoryCanonicalAmount['unit']): InventoryCanonicalAmount => ({
  value: '0',
  unit,
});
function sum(
  values: readonly InventoryAmount[],
  unit: InventoryCanonicalAmount['unit']
): InventoryCanonicalAmount {
  const result = addInventoryAmounts(values, unit);
  if (result.kind !== 'added')
    throw new TypeError(
      'Commercial allocation amounts must share the original measurement dimension.'
    );
  return result.quantity;
}
function remaining(
  quantity: InventoryCanonicalAmount,
  allocated: InventoryCanonicalAmount
): InventoryCanonicalAmount {
  const result = subtractInventoryAmounts(quantity, allocated);
  if (result.kind === 'non-positive') return { ...quantity };
  if (result.kind !== 'remaining')
    throw new TypeError('Active commercial allocations cannot exceed their original known amount.');
  return result.quantity;
}
function exceeds(quantity: InventoryCanonicalAmount, limit: InventoryCanonicalAmount): boolean {
  const result = compareInventoryAmounts(quantity, limit);
  if (result.kind !== 'compared')
    throw new TypeError(
      'Commercial allocation amounts must share the original measurement dimension.'
    );
  return result.order > 0;
}
function activeAllocations(state: Pick<InventoryState, 'arrivalAllocations'>) {
  return Object.values(state.arrivalAllocations).filter(
    (allocation) => allocation.lifecycle.kind === 'active'
  );
}

export function inventoryExpectedDeliveryProgress(
  state: Pick<InventoryState, 'expectedDeliveries' | 'arrivalAllocations'>,
  lineId: string
): InventoryExpectedDeliveryProgress | null {
  const line = Object.hasOwn(state.expectedDeliveries, lineId)
    ? state.expectedDeliveries[lineId]
    : undefined;
  if (!line) return null;
  const allocations = activeAllocations(state)
    .filter((allocation) => allocation.lineId === line.id)
    .sort((a, b) => order(a.id, b.id));
  const allocated = sum(
    allocations.map((allocation) => allocation.quantity),
    line.expectation.quantity.unit
  );
  const remainder = remaining(line.expectation.quantity, allocated);
  return {
    line: structuredClone(line),
    allocated,
    remaining: remainder,
    progress:
      allocated.value === '0'
        ? 'none-received'
        : remainder.value === '0'
          ? 'fully-received'
          : 'partly-received',
    allocationIds: allocations.map((allocation) => allocation.id),
  };
}

export function inventoryArrivalAllocationBalance(
  state: Pick<InventoryState, 'arrivals' | 'arrivalAllocations'>,
  arrivalId: string,
  componentKey: string
): InventoryArrivalAllocationBalance | null {
  const arrival = Object.hasOwn(state.arrivals, arrivalId) ? state.arrivals[arrivalId] : undefined;
  const component = arrival?.components.find((item) => item.key === componentKey);
  if (
    !component ||
    component.choice.kind !== 'identified' ||
    component.receivedQuantity?.kind !== 'known'
  )
    return null;
  const received = normalizeInventoryAmount(component.receivedQuantity);
  const allocations = activeAllocations(state)
    .filter(
      (allocation) => allocation.arrivalId === arrivalId && allocation.componentKey === componentKey
    )
    .sort((a, b) => order(a.id, b.id));
  const allocated = sum(
    allocations.map((allocation) => allocation.quantity),
    received.unit
  );
  return {
    arrivalId,
    componentKey,
    materialId: component.choice.materialId,
    received,
    allocated,
    unmatched: remaining(received, allocated),
    allocationIds: allocations.map((allocation) => allocation.id),
  };
}

export function applyInventoryStockroomCommand(
  state: InventoryStockroomDraft,
  command: InventoryCommand,
  context?: InventoryExecutionContext
): Failure | null | undefined {
  if (
    ![
      'record-expected-delivery',
      'allocate-arrival',
      'withdraw-arrival-allocation',
      'close-expected-delivery-remainder',
      'reopen-expected-delivery',
      'record-reorder-rule',
      'retire-reorder-rule',
    ].includes(command.kind)
  )
    return undefined;
  if (!context)
    return refusal(
      'CONTEXT_REQUIRED',
      'Stockroom facts require trusted native actor and recording time.'
    );
  if (command.kind === 'record-expected-delivery') {
    if (inventoryRecordIdExists(state, command.id))
      return refusal('ID_ALREADY_EXISTS', 'That inventory identifier already exists.');
    const quantity = normalizeInventoryAmount(command.quantity);
    if (quantity.value === '0')
      return refusal('INVALID_QUANTITY', 'An expected delivery requires a positive amount.');
    state.expectedDeliveries[command.id] = {
      id: command.id,
      name: command.name,
      supplier: command.supplier,
      externalReference: structuredClone(command.externalReference),
      expectation: { materialId: command.materialId, quantity },
      at: context.at,
      by: { ...context.principal },
      reason: command.reason,
      lifecycle: { kind: 'open' },
    };
    return null;
  }
  if (command.kind === 'record-reorder-rule') {
    if (inventoryRecordIdExists(state, command.id))
      return refusal('ID_ALREADY_EXISTS', 'That inventory identifier already exists.');
    const threshold = normalizeInventoryAmount(command.threshold);
    if (threshold.value === '0')
      return refusal(
        'INVALID_QUANTITY',
        'A reorder threshold must be positive; retire a rule to disable it.'
      );
    state.reorderRules[command.id] = {
      id: command.id,
      name: command.name,
      materialId: command.materialId,
      threshold,
      validityBasis: command.validityBasis,
      actionBasis: command.actionBasis,
      at: context.at,
      by: { ...context.principal },
      reason: command.reason,
      lifecycle: { kind: 'active' },
    };
    return null;
  }
  if (command.kind === 'retire-reorder-rule') {
    const rule = Object.hasOwn(state.reorderRules, command.ruleId)
      ? state.reorderRules[command.ruleId]
      : undefined;
    if (!rule) return refusal('REORDER_RULE_NOT_FOUND', 'The reorder rule does not exist.');
    if (rule.lifecycle.kind !== 'active')
      return refusal('REORDER_RULE_NOT_ACTIVE', 'Only an active reorder rule can be retired.');
    state.reorderRules[rule.id] = {
      ...rule,
      lifecycle: {
        kind: 'retired',
        at: context.at,
        by: { ...context.principal },
        reason: command.reason,
      },
    };
    return null;
  }
  if (command.kind === 'withdraw-arrival-allocation') {
    const allocation = Object.hasOwn(state.arrivalAllocations, command.allocationId)
      ? state.arrivalAllocations[command.allocationId]
      : undefined;
    if (!allocation)
      return refusal(
        'ARRIVAL_ALLOCATION_NOT_FOUND',
        'The commercial receipt allocation does not exist.'
      );
    if (allocation.lifecycle.kind !== 'active')
      return refusal(
        'ARRIVAL_ALLOCATION_NOT_ACTIVE',
        'Only an active commercial allocation can be withdrawn.'
      );
    const line = state.expectedDeliveries[allocation.lineId];
    if (!line)
      return refusal('EXPECTED_DELIVERY_NOT_FOUND', 'The expected delivery does not exist.');
    if (line.lifecycle.kind !== 'open')
      return refusal(
        'EXPECTED_DELIVERY_CLOSED',
        'Reopen the expected delivery before correcting its allocations.'
      );
    state.arrivalAllocations[allocation.id] = {
      ...allocation,
      lifecycle: {
        kind: 'withdrawn',
        at: context.at,
        by: { ...context.principal },
        reason: command.reason,
      },
    };
    return null;
  }
  if (
    command.kind === 'allocate-arrival' ||
    command.kind === 'close-expected-delivery-remainder' ||
    command.kind === 'reopen-expected-delivery'
  ) {
    const line = Object.hasOwn(state.expectedDeliveries, command.lineId)
      ? state.expectedDeliveries[command.lineId]
      : undefined;
    if (!line)
      return refusal('EXPECTED_DELIVERY_NOT_FOUND', 'The expected delivery does not exist.');
    if (command.kind === 'reopen-expected-delivery') {
      if (line.lifecycle.kind !== 'remainder-closed')
        return refusal(
          'EXPECTED_DELIVERY_NOT_CLOSED',
          'Only a closed expected delivery can be reopened.'
        );
      state.expectedDeliveries[line.id] = { ...line, lifecycle: { kind: 'open' } };
      return null;
    }
    if (line.lifecycle.kind !== 'open')
      return refusal(
        'EXPECTED_DELIVERY_CLOSED',
        'Reopen the expected delivery before changing its commercial matching.'
      );
    const progress = inventoryExpectedDeliveryProgress(state, line.id)!;
    if (command.kind === 'close-expected-delivery-remainder') {
      if (progress.remaining.value === '0')
        return refusal(
          'EXPECTED_DELIVERY_NO_REMAINDER',
          'A fully received expectation has no unreceived remainder to close.'
        );
      state.expectedDeliveries[line.id] = {
        ...line,
        lifecycle: {
          kind: 'remainder-closed',
          remainingAtClose: progress.remaining,
          at: context.at,
          by: { ...context.principal },
          reason: command.reason,
        },
      };
      return null;
    }
    if (inventoryRecordIdExists(state, command.id))
      return refusal('ID_ALREADY_EXISTS', 'That inventory identifier already exists.');
    const arrival = Object.hasOwn(state.arrivals, command.arrivalId)
      ? state.arrivals[command.arrivalId]
      : undefined;
    if (!arrival) return refusal('ARRIVAL_NOT_FOUND', 'The actual arrival does not exist.');
    const component = arrival.components.find((item) => item.key === command.componentKey);
    if (!component)
      return refusal(
        'ARRIVAL_COMPONENT_NOT_FOUND',
        'The original arrival component does not exist.'
      );
    const balance = inventoryArrivalAllocationBalance(state, arrival.id, command.componentKey);
    if (!balance)
      return refusal(
        'ARRIVAL_COMPONENT_NOT_ALLOCATABLE',
        'Commercial matching requires an identified original component with a known received amount.'
      );
    if (balance.materialId !== line.expectation.materialId)
      return refusal(
        'ALLOCATION_MATERIAL_MISMATCH',
        'Expected delivery and original receipt must identify the same scientific material.'
      );
    const quantity = normalizeInventoryAmount(command.quantity);
    if (quantity.value === '0')
      return refusal('INVALID_QUANTITY', 'An allocation requires a positive amount.');
    if (quantity.unit !== balance.received.unit || quantity.unit !== line.expectation.quantity.unit)
      return refusal(
        'QUANTITY_DIMENSION_MISMATCH',
        'An allocation must use the original received and expected measurement dimension.'
      );
    if (exceeds(quantity, balance.unmatched))
      return refusal(
        'ALLOCATION_EXCEEDS_RECEIPT',
        'Active allocations across all expected deliveries cannot exceed the original received amount.'
      );
    if (exceeds(quantity, progress.remaining))
      return refusal(
        'ALLOCATION_EXCEEDS_EXPECTATION',
        'Allocate at most the expected remainder; leave actual excess receipt unmatched.'
      );
    state.arrivalAllocations[command.id] = {
      id: command.id,
      lineId: line.id,
      arrivalId: arrival.id,
      componentKey: component.key,
      quantity,
      at: context.at,
      by: { ...context.principal },
      reason: command.reason,
      lifecycle: { kind: 'active' },
    };
    return null;
  }
  return undefined;
}

type StockFacts = ReturnType<typeof inventoryStockAvailabilityFacts>;
function reorderAssessment(
  state: StockroomState,
  rule: InventoryReorderRule,
  asOf: number,
  facts: (stockId: string) => StockFacts
): InventoryReorderAssessmentResult {
  if (rule.lifecycle.kind === 'retired') return { kind: 'retired', rule: structuredClone(rule) };
  let knownUnreserved = zero(rule.threshold.unit),
    knownUnreservedKind: 'exact' | 'at-least' = 'exact',
    unrepresentable = false,
    nextBoundaryAt: number | null = null;
  const knownIncludedStockIds: string[] = [],
    unknownIncludedStockIds: string[] = [],
    excluded: {
      stockId: string;
      blockers: StockFacts['availability']['blockers'];
      coverageReason: 'validity-not-confirmed' | null;
    }[] = [],
    incompatibleStockIds: string[] = [],
    legacyOrMixedValidityStockIds: string[] = [];
  try {
    for (const stock of Object.values(state.stocks).sort((a, b) => order(a.id, b.id))) {
      if (stock.materialId !== rule.materialId) continue;
      if (stock.quantity.unit !== rule.threshold.unit) {
        incompatibleStockIds.push(stock.id);
        continue;
      }
      const observed = facts(stock.id),
        validity = observed.availability.validity,
        admission = observed.operational[rule.actionBasis];
      if (validity.nextBoundaryAt !== null && validity.nextBoundaryAt > asOf)
        nextBoundaryAt =
          nextBoundaryAt === null
            ? validity.nextBoundaryAt
            : Math.min(nextBoundaryAt, validity.nextBoundaryAt);
      if (validity.coverage !== 'managed') legacyOrMixedValidityStockIds.push(stock.id);
      const coverageReason =
        rule.validityBasis === 'confirmed-current-validity' &&
        (validity.coverage !== 'managed' || validity[rule.actionBasis].kind !== 'allowed')
          ? ('validity-not-confirmed' as const)
          : null;
      if (admission.kind === 'blocked' || coverageReason !== null) {
        excluded.push({
          stockId: stock.id,
          blockers: admission.kind === 'blocked' ? admission.blockers : [],
          coverageReason,
        });
        continue;
      }
      const available = observed.availability.unreserved;
      if (available.kind === 'unknown') {
        unknownIncludedStockIds.push(stock.id);
        continue;
      }
      knownIncludedStockIds.push(stock.id);
      if (knownUnreservedKind === 'at-least') {
        const comparison = compareInventoryAmounts(available, knownUnreserved);
        if (comparison.kind === 'compared' && comparison.order > 0)
          knownUnreserved = normalizeInventoryAmount(available);
        continue;
      }
      try {
        knownUnreserved = sum([knownUnreserved, available], rule.threshold.unit);
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        const comparison = compareInventoryAmounts(available, knownUnreserved);
        if (comparison.kind === 'compared' && comparison.order > 0)
          knownUnreserved = normalizeInventoryAmount(available);
        knownUnreservedKind = 'at-least';
        unrepresentable = true;
      }
    }
    const enough = compareInventoryAmounts(knownUnreserved, rule.threshold);
    if (enough.kind !== 'compared')
      throw new TypeError('Reorder totals must share the configured measurement dimension.');
    if (unrepresentable && enough.order < 0)
      return {
        kind: 'unavailable',
        rule: structuredClone(rule),
        code: 'REORDER_TOTAL_UNREPRESENTABLE',
        message:
          'The exact aggregate cannot be represented and its known lower bound does not prove the threshold. No low-stock conclusion was made.',
      };
    return {
      kind: 'ready',
      assessment: {
        rule: structuredClone(rule),
        knownUnreserved,
        knownUnreservedKind,
        conclusion:
          enough.order >= 0
            ? 'adequate'
            : unknownIncludedStockIds.length
              ? 'needs-measurement'
              : 'low',
        knownIncludedStockIds,
        unknownIncludedStockIds,
        excluded,
        incompatibleStockIds,
        legacyOrMixedValidityStockIds,
        nextBoundaryAt,
      },
    };
  } catch (error) {
    return {
      kind: 'unavailable',
      rule: structuredClone(rule),
      code: 'REORDER_PROJECTION_UNAVAILABLE',
      message:
        error instanceof Error ? error.message : 'The reorder projection could not be verified.',
    };
  }
}

export function inventoryStockroomProjection(
  state: StockroomState,
  principal: InventoryPrincipal,
  asOf: number
): InventoryStockroomProjection {
  if (!Number.isSafeInteger(asOf) || asOf < state.lastRecordedAt)
    throw new TypeError(
      'Stockroom observation time must be a safe timestamp at or after recorded inventory time.'
    );
  const expectedDeliveries: Record<string, InventoryExpectedDeliveryProgress> = Object.create(null);
  for (const line of Object.values(state.expectedDeliveries).sort((a, b) => order(a.id, b.id)))
    expectedDeliveries[line.id] = inventoryExpectedDeliveryProgress(state, line.id)!;
  const arrivalComponents: InventoryArrivalAllocationBalance[] = [];
  for (const arrival of Object.values(state.arrivals).sort((a, b) => order(a.id, b.id)))
    for (const component of [...arrival.components].sort((a, b) => order(a.key, b.key))) {
      const balance = inventoryArrivalAllocationBalance(state, arrival.id, component.key);
      if (balance) arrivalComponents.push(balance);
    }
  const stockFacts = new Map<string, StockFacts>();
  const facts = (stockId: string) => {
    const saved = stockFacts.get(stockId);
    if (saved) return saved;
    const result = inventoryStockAvailabilityFacts(state, stockId, principal, asOf);
    stockFacts.set(stockId, result);
    return result;
  };
  const reorderRules: Record<string, InventoryReorderAssessmentResult> = Object.create(null);
  for (const rule of Object.values(state.reorderRules).sort((a, b) => order(a.id, b.id)))
    reorderRules[rule.id] = reorderAssessment(state, rule, asOf, facts);
  return { expectedDeliveries, arrivalComponents, reorderRules };
}
