import type { InventoryState } from './inventory-types';
import {
  addInventoryAmounts,
  compareInventoryAmounts,
  subtractInventoryAmounts,
  type InventoryCanonicalAmount,
} from './inventory-amount';

function invalid(message: string): never {
  throw new TypeError(message);
}
function within(
  amount: InventoryCanonicalAmount,
  limit: InventoryCanonicalAmount,
  message: string
): void {
  const compared = compareInventoryAmounts(amount, limit);
  if (compared.kind !== 'compared' || compared.order > 0) invalid(message);
}

export function validateInventoryStockroomState(state: InventoryState): void {
  const activeLines = new Map<string, InventoryCanonicalAmount[]>();
  const activeComponents = new Map<string, InventoryCanonicalAmount[]>();
  const componentKey = (arrivalId: string, key: string) => JSON.stringify([arrivalId, key]);
  const recorded = (row: { readonly at: number }) => {
    if (row.at > state.lastRecordedAt)
      invalid('Stockroom facts cannot exceed the recorded inventory clock.');
  };
  for (const [key, line] of Object.entries(state.expectedDeliveries)) {
    if (key !== line.id || line.expectation.quantity.value === '0')
      invalid('Expected delivery statements require their exact ID and a positive known amount.');
    recorded(line);
    if (line.lifecycle.kind === 'remainder-closed') {
      if (
        line.lifecycle.at < line.at ||
        line.lifecycle.at > state.lastRecordedAt ||
        line.lifecycle.remainingAtClose.value === '0'
      )
        invalid(
          'Closing an expectation requires a positive remainder and valid native recording time.'
        );
      within(
        line.lifecycle.remainingAtClose,
        line.expectation.quantity,
        'Closed expectation remainder must retain its original measurement dimension and limit.'
      );
    }
  }
  for (const [key, allocation] of Object.entries(state.arrivalAllocations)) {
    if (key !== allocation.id || allocation.quantity.value === '0')
      invalid('Arrival allocations require their exact ID and a positive amount.');
    recorded(allocation);
    const line = state.expectedDeliveries[allocation.lineId];
    const arrival = state.arrivals[allocation.arrivalId];
    const component = arrival?.components.find((row) => row.key === allocation.componentKey);
    if (
      !line ||
      !arrival ||
      !component ||
      component.choice.kind !== 'identified' ||
      component.receivedQuantity?.kind !== 'known'
    )
      invalid(
        'Arrival allocations require an expected line and originally identified known received amount.'
      );
    if (component.choice.materialId !== line.expectation.materialId)
      invalid('Allocation material identity must match its original component and expectation.');
    if (allocation.at < line.at || allocation.at < arrival.at)
      invalid('An allocation cannot precede its original arrival or expectation.');
    within(
      allocation.quantity,
      line.expectation.quantity,
      'An individual allocation cannot exceed or change the expected amount dimension.'
    );
    within(
      allocation.quantity,
      component.receivedQuantity,
      'An individual allocation cannot exceed or change the originally received amount dimension.'
    );
    if (allocation.lifecycle.kind === 'withdrawn') {
      if (allocation.lifecycle.at < allocation.at || allocation.lifecycle.at > state.lastRecordedAt)
        invalid('Allocation withdrawal must follow recording inside the native clock.');
      if (line.lifecycle.kind === 'remainder-closed' && allocation.lifecycle.at > line.lifecycle.at)
        invalid('A closed expectation cannot hide a later matching correction.');
    } else {
      if (line.lifecycle.kind === 'remainder-closed' && allocation.at > line.lifecycle.at)
        invalid('A closed expectation cannot accept a later allocation.');
      const lineAmounts = activeLines.get(line.id) ?? [];
      lineAmounts.push(allocation.quantity);
      activeLines.set(line.id, lineAmounts);
      const componentId = componentKey(arrival.id, component.key);
      const componentAmounts = activeComponents.get(componentId) ?? [];
      componentAmounts.push(allocation.quantity);
      activeComponents.set(componentId, componentAmounts);
    }
  }
  for (const line of Object.values(state.expectedDeliveries)) {
    const sum = addInventoryAmounts(activeLines.get(line.id) ?? [], line.expectation.quantity.unit);
    if (sum.kind !== 'added') invalid('Expected allocations cannot mix measurement dimensions.');
    within(
      sum.quantity,
      line.expectation.quantity,
      'Active allocations cannot exceed the expected amount.'
    );
    if (line.lifecycle.kind === 'remainder-closed') {
      const remaining = subtractInventoryAmounts(line.expectation.quantity, sum.quantity);
      if (remaining.kind === 'non-positive') {
        if (
          line.lifecycle.remainingAtClose.value !== line.expectation.quantity.value ||
          line.lifecycle.remainingAtClose.unit !== line.expectation.quantity.unit
        )
          invalid(
            'Canceled remainder must match the immutable expectation and active allocations.'
          );
      } else if (
        remaining.kind !== 'remaining' ||
        remaining.quantity.value !== line.lifecycle.remainingAtClose.value ||
        remaining.quantity.unit !== line.lifecycle.remainingAtClose.unit
      )
        invalid('Canceled remainder must match the immutable expectation and active allocations.');
    }
  }
  for (const arrival of Object.values(state.arrivals)) {
    for (const component of arrival.components) {
      const amounts = activeComponents.get(componentKey(arrival.id, component.key));
      if (!amounts) continue;
      if (component.receivedQuantity?.kind !== 'known')
        invalid('Only originally known received amounts can be allocated.');
      const sum = addInventoryAmounts(amounts, component.receivedQuantity.unit);
      if (sum.kind !== 'added') invalid('Receipt allocations cannot mix measurement dimensions.');
      within(
        sum.quantity,
        component.receivedQuantity,
        'Active allocations across all lines cannot exceed the original received amount.'
      );
    }
  }
  for (const [key, rule] of Object.entries(state.reorderRules)) {
    if (key !== rule.id) invalid('Reorder rule keys must retain their exact identity.');
    recorded(rule);
    if (
      rule.lifecycle.kind === 'retired' &&
      (rule.lifecycle.at < rule.at || rule.lifecycle.at > state.lastRecordedAt)
    )
      invalid('Reorder retirement must follow recording inside the native clock.');
  }
}
