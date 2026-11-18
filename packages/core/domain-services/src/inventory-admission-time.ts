import type { InventoryState } from './inventory-types';
import { inventoryStockValidity } from './inventory-validity';

export function inventoryOrganizationAdmissionBoundary(
  before: InventoryState,
  after: InventoryState,
  asOf: number
): number | null {
  if (!Number.isSafeInteger(asOf) || asOf < before.lastRecordedAt || asOf < after.lastRecordedAt)
    throw new TypeError(
      'Admission time must be a safe timestamp at or after both inventory clocks.'
    );
  let next: number | null = null;
  const boundary = (at: number | null) => {
    if (at !== null && at > asOf) next = next === null ? at : Math.min(next, at);
  };
  for (const state of [before, after]) {
    for (const stock of Object.values(state.stocks))
      boundary(inventoryStockValidity(state, stock.id, asOf)!.nextBoundaryAt);
    for (const reservation of Object.values(state.reservations))
      if (reservation.lifecycle.kind === 'active') boundary(reservation.deadline);
    for (const item of [...Object.values(state.storage), ...Object.values(state.vessels)])
      if ('custody' in item && item.custody.kind === 'checked-out') boundary(item.custody.dueAt);
  }
  return next;
}
