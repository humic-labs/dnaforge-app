import type {
  InventoryPhysicalItem,
  InventoryPrincipal,
  InventoryState,
  InventoryTransition,
} from './inventory-types';
import { inventoryItemContains } from './inventory-placement';

type State = Pick<InventoryState, 'storage' | 'vessels' | 'stocks' | 'reservations'>;
function sameHolder(first: InventoryPrincipal, second: InventoryPrincipal): boolean {
  return first.kind === 'agent'
    ? second.kind === 'agent' && first.identityId === second.identityId
    : second.kind === 'local-profile' && first.profileKey === second.profileKey;
}
export function inventoryReservationPlacementFailure(
  state: State,
  moving: readonly InventoryPhysicalItem[],
  destinations: readonly InventoryPhysicalItem[]
): Extract<InventoryTransition, { ok: false }> | null {
  const active = Object.values(state.reservations).filter(
    (reservation) => reservation.lifecycle.kind === 'active'
  );
  for (const booking of active) {
    if (
      booking.kind !== 'item' ||
      !destinations.some((destination) => inventoryItemContains(state, booking.item, destination))
    )
      continue;
    if (
      active.some((reservation) => {
        if (reservation.kind !== 'quantity' || sameHolder(reservation.holder, booking.holder))
          return false;
        const stock = state.stocks[reservation.stockId];
        return (
          stock &&
          moving.some((item) =>
            inventoryItemContains(state, item, { kind: 'vessel', id: stock.vesselId })
          )
        );
      })
    )
      return {
        ok: false,
        code: 'RESERVATION_CONFLICT',
        message: 'The move would place another holder’s allocated stock inside this item booking.',
      };
  }
  return null;
}
