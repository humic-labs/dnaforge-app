import {
  inventoryPhysicalProjection,
  inventoryPhysicalPositionUnavailable,
} from './inventory-configuration';
import { inventoryReservationPlacementFailure } from './inventory-reservation-placement';
import { inventoryCommandWithdrawals } from './inventory-materials';
import { inventoryCustodyAccess, inventoryItemCustody } from './inventory-custody';
import { inventoryItemContains } from './inventory-placement';
export { inventoryItemContains } from './inventory-placement';
import type {
  InventoryAvailability,
  InventoryAvailabilityBlocker,
  InventoryCommand,
  InventoryErrorCode,
  InventoryExecutionContext,
  InventoryPhysicalItem,
  InventoryPrincipal,
  InventoryQuantity,
  InventoryReservation,
  InventoryReservationCommand,
  InventoryState,
  InventoryStockAvailability,
  InventoryVolume,
  InventoryWithdrawal,
} from './inventory-types';
import {
  addInventoryVolumes,
  compareInventoryVolumes,
  normalizeInventoryVolume,
  subtractInventoryVolume,
} from './inventory-volume';

type ReservationState = Pick<
  InventoryState,
  | 'stocks'
  | 'vessels'
  | 'storage'
  | 'lots'
  | 'reservations'
  | 'lastRecordedAt'
  | 'typeVersions'
  | 'recipeVersions'
  | 'fitEvidence'
  | 'itemCodes'
>;
export interface InventoryReservationDraft extends Omit<ReservationState, 'reservations'> {
  readonly reservations: Record<string, InventoryReservation>;
}
type Failure = { readonly ok: false; readonly code: InventoryErrorCode; readonly message: string };
const refuse = (code: InventoryErrorCode, message: string): Failure => ({
  ok: false,
  code,
  message,
});
const zero = (): InventoryVolume => ({ value: '0', unit: 'uL' });

function samePrincipal(first: InventoryPrincipal, second: InventoryPrincipal | undefined): boolean {
  if (!second || first.kind !== second.kind) return false;
  return first.kind === 'agent'
    ? second.kind === 'agent' && first.identityId === second.identityId
    : second.kind === 'local-profile' && first.profileKey === second.profileKey;
}

function due(reservation: InventoryReservation, at: number): boolean {
  return reservation.deadline !== null && at >= reservation.deadline;
}

function overlap(
  state: ReservationState,
  first: InventoryPhysicalItem,
  second: InventoryPhysicalItem
): boolean {
  return inventoryItemContains(state, first, second) || inventoryItemContains(state, second, first);
}

function stockTarget(state: ReservationState, stockId: string): InventoryPhysicalItem | undefined {
  const stock = state.stocks[stockId];
  return stock ? { kind: 'vessel', id: stock.vesselId } : undefined;
}

function target(
  state: ReservationState,
  reservation: InventoryReservation
): InventoryPhysicalItem | undefined {
  return reservation.kind === 'item' ? reservation.item : stockTarget(state, reservation.stockId);
}

function positive(value: InventoryVolume): boolean {
  return normalizeInventoryVolume(value).value !== '0';
}

function remainder(available: InventoryVolume, amount: InventoryVolume): InventoryVolume {
  if (amount.value === '0') return { ...available };
  const result = subtractInventoryVolume(available, amount);
  return result.kind === 'remaining' ? result.quantity : zero();
}

function stockAvailability(
  state: ReservationState,
  stockId: string,
  principal: InventoryPrincipal | undefined
): InventoryStockAvailability {
  const stock = state.stocks[stockId];
  const vessel = state.vessels[stock.vesselId];
  const item = { kind: 'vessel' as const, id: stock.vesselId };
  const related = Object.values(state.reservations).filter((reservation) =>
    reservation.kind === 'quantity'
      ? reservation.stockId === stockId
      : inventoryItemContains(state, reservation.item, item)
  );
  const active = related.filter((reservation) => reservation.lifecycle.kind === 'active');
  const quantities = active.filter((reservation) => reservation.kind === 'quantity');
  const held = addInventoryVolumes(quantities.map((reservation) => reservation.remaining));
  const mine = addInventoryVolumes(
    quantities
      .filter((reservation) => samePrincipal(reservation.holder, principal))
      .map((reservation) => reservation.remaining)
  );
  const blockers: InventoryAvailabilityBlocker[] = [];
  if (inventoryPhysicalPositionUnavailable(state, item))
    blockers.push({ code: 'POSITION_UNAVAILABLE', item });
  blockers.push(...inventoryItemCustody(state, item, principal, state.lastRecordedAt).blockers);
  if (stock.quantity.kind === 'unknown') blockers.push({ code: 'QUANTITY_UNKNOWN' });
  if (stock.quality !== 'usable') blockers.push({ code: 'STOCK_QUARANTINED' });
  if (vessel.lifecycle !== 'active') blockers.push({ code: 'VESSEL_DISPOSED' });
  const itemHolds = active.filter(
    (reservation) => reservation.kind === 'item' && !samePrincipal(reservation.holder, principal)
  );
  if (itemHolds.length)
    blockers.push({
      code: 'ITEM_RESERVED',
      reservationIds: itemHolds.map((reservation) => reservation.id),
    });
  let unreserved: InventoryQuantity = { kind: 'unknown' };
  if (stock.quantity.kind === 'known') {
    const usable =
      vessel.limits.deadVolume.kind === 'known'
        ? remainder(stock.quantity, vessel.limits.deadVolume)
        : stock.quantity;
    if (compareInventoryVolumes(held, usable) > 0) blockers.push({ code: 'ALLOCATION_SHORTFALL' });
    unreserved = { kind: 'known', ...remainder(usable, held) };
  }
  return {
    stockId,
    onHand: { ...stock.quantity },
    held,
    unreserved,
    mine,
    deadVolume: { ...vessel.limits.deadVolume },
    blockers,
    reservationIds: related.map((reservation) => reservation.id),
  };
}

export function inventoryAvailability(
  state: ReservationState,
  principal: InventoryPrincipal,
  at: number
): InventoryAvailability {
  if (!Number.isSafeInteger(at) || at < state.lastRecordedAt)
    throw new TypeError(
      'Availability time must be a safe timestamp at or after the recorded clock floor.'
    );
  const stocks: Record<string, InventoryStockAvailability> = Object.create(null);
  for (const id of Object.keys(state.stocks)) stocks[id] = stockAvailability(state, id, principal);
  const reservations: Record<string, InventoryAvailability['reservations'][string]> =
    Object.create(null);
  for (const reservation of Object.values(state.reservations)) {
    const active = reservation.lifecycle.kind === 'active';
    const mine = samePrincipal(reservation.holder, principal);
    const overdue = active && due(reservation, at);
    const related =
      reservation.kind === 'quantity'
        ? [stocks[reservation.stockId]]
        : Object.values(stocks).filter((stock) => stock.reservationIds.includes(reservation.id));
    const blockers = related.flatMap((stock) => stock?.blockers ?? []);
    if (overdue) blockers.push({ code: 'EXPIRY_PENDING' });
    const usable = related.some(
      (stock) =>
        stock &&
        stock.blockers.length === 0 &&
        ((stock.unreserved.kind === 'known' && positive(stock.unreserved)) || positive(stock.mine))
    );
    reservations[reservation.id] = {
      reservation: structuredClone(reservation),
      mine,
      overdue,
      blockers,
      actions: {
        release: active && mine,
        cancel: active && principal.kind === 'local-profile',
        expire: overdue,
        fulfill:
          active &&
          mine &&
          !overdue &&
          (reservation.kind === 'quantity' ? blockers.length === 0 : usable),
      },
    };
  }
  const items: Record<string, InventoryAvailability['items'][string]> = Object.create(null);
  for (const item of [
    ...Object.keys(state.storage).map((id) => ({ kind: 'storage' as const, id })),
    ...Object.keys(state.vessels).map((id) => ({ kind: 'vessel' as const, id })),
  ])
    items[item.id] = inventoryItemCustody(state, item, principal, at);
  return { stocks, reservations, items, physical: inventoryPhysicalProjection(state) };
}

function itemConflict(
  state: ReservationState,
  item: InventoryPhysicalItem,
  principal: InventoryPrincipal | undefined,
  includeQuantity = false
): InventoryReservation[] {
  return Object.values(state.reservations).filter((reservation) => {
    if (
      reservation.lifecycle.kind !== 'active' ||
      samePrincipal(reservation.holder, principal) ||
      (!includeQuantity && reservation.kind !== 'item')
    )
      return false;
    const heldTarget = target(state, reservation);
    return heldTarget !== undefined && overlap(state, heldTarget, item);
  });
}

function locationTarget(placement: {
  readonly kind: string;
  readonly storageId?: string;
}): InventoryPhysicalItem[] {
  return placement.kind === 'located' && placement.storageId
    ? [{ kind: 'storage', id: placement.storageId }]
    : [];
}

export function inventoryReservationGuard(
  state: ReservationState,
  command: InventoryCommand,
  context?: InventoryExecutionContext
): Failure | null {
  for (const input of inventoryCommandWithdrawals(command)) {
    if (!state.stocks[input.stockId]) continue;
    const facts = stockAvailability(state, input.stockId, context?.principal);
    if (facts.blockers.some((blocker) => blocker.code === 'ALLOCATION_SHORTFALL'))
      return refuse(
        'ALLOCATION_SHORTFALL',
        'Recorded quantity is below its held allocations. Resolve the holds before withdrawing.'
      );
    const itemHold = facts.blockers.find((blocker) => blocker.code === 'ITEM_RESERVED');
    if (itemHold) return refuse('ITEM_RESERVED', 'Another holder has reserved this physical item.');
    if (
      facts.held.value !== '0' &&
      facts.unreserved.kind === 'known' &&
      compareInventoryVolumes(input.quantity, facts.unreserved) > 0
    )
      return refuse(
        'QUANTITY_RESERVED',
        'The withdrawal exceeds unreserved usable quantity. Claim owned reservations explicitly.'
      );
  }
  let items: InventoryPhysicalItem[] = [];
  let locations: InventoryPhysicalItem[] = [];
  let disposal = false;
  switch (command.kind) {
    case 'move-storage':
      items = [{ kind: 'storage', id: command.id }];
      locations = locationTarget(command.placement);
      break;
    case 'move-vessel':
      items = [{ kind: 'vessel', id: command.id }];
      locations = locationTarget(command.placement);
      break;
    case 'dispose-plate':
      items = [{ kind: 'storage', id: command.id }];
      disposal = true;
      break;
    case 'dispose-vessel':
      items = [{ kind: 'vessel', id: command.id }];
      disposal = true;
      break;
    case 'push-stack':
      items = [command.item];
      locations = [{ kind: 'storage', id: command.stackId }];
      break;
    case 'pop-stack':
      items = [command.item];
      locations = locationTarget(command.destination);
      break;
    case 'create-vessel':
    case 'create-storage':
    case 'create-layout-storage':
      locations = locationTarget(command.placement);
      break;
    case 'receive-stock':
    case 'receive-lot-stock':
    case 'pool':
    case 'dilute':
      items = [{ kind: 'vessel', id: command.vesselId }];
      break;
    case 'transfer': {
      const destination =
        command.destination.kind === 'new-stock'
          ? { kind: 'vessel' as const, id: command.destination.vesselId }
          : stockTarget(state, command.destination.stockId);
      items = destination ? [destination] : [];
      break;
    }
  }
  if (items.some((item) => itemConflict(state, item, context?.principal, disposal).length))
    return refuse('ITEM_RESERVED', 'Another holder has reserved this item or an overlapping item.');
  if (
    locations.some((location) =>
      Object.values(state.reservations).some(
        (reservation) =>
          reservation.kind === 'item' &&
          reservation.lifecycle.kind === 'active' &&
          !samePrincipal(reservation.holder, context?.principal) &&
          inventoryItemContains(state, reservation.item, location)
      )
    )
  )
    return refuse('ITEM_RESERVED', 'Another holder has reserved the destination storage location.');
  if (['move-storage', 'move-vessel', 'push-stack', 'pop-stack'].includes(command.kind))
    return inventoryReservationPlacementFailure(state, items, locations);
  return null;
}

export function applyInventoryReservationCommand(
  state: InventoryReservationDraft,
  command: InventoryCommand,
  context?: InventoryExecutionContext
): Failure | null | undefined {
  if (
    ![
      'reserve-quantity',
      'reserve-item',
      'release-reservation',
      'cancel-reservation',
      'expire-reservations',
    ].includes(command.kind)
  )
    return undefined;
  if (!context)
    return refuse(
      'CONTEXT_REQUIRED',
      'Reservation commands require a trusted actor and clock context.'
    );
  if (command.kind === 'reserve-quantity' || command.kind === 'reserve-item') {
    if (
      [
        state.reservations,
        state.storage,
        state.vessels,
        state.stocks,
        state.lots,
        state.typeVersions,
        state.recipeVersions,
        state.fitEvidence,
        state.itemCodes,
      ].some((rows) => Object.hasOwn(rows, command.id))
    )
      return refuse('ID_ALREADY_EXISTS', 'That inventory identifier already exists.');
    if (command.deadline !== null && command.deadline <= context.at)
      return refuse(
        'INVALID_INVENTORY_INPUT',
        'A new reservation deadline must be later than its creation time.'
      );
    let reservation: InventoryReservation;
    const facts = {
      id: command.id,
      holder: { ...context.principal },
      purpose: command.purpose,
      createdAt: context.at,
      deadline: command.deadline,
      lifecycle: { kind: 'active' as const },
    };
    if (command.kind === 'reserve-quantity') {
      const stock = state.stocks[command.stockId];
      if (!stock) return refuse('STOCK_NOT_FOUND', 'The reserved stock does not exist.');
      const quantity = normalizeInventoryVolume(command.quantity);
      if (!positive(quantity))
        return refuse('INVALID_QUANTITY', 'A quantity reservation requires positive volume.');
      const available = stockAvailability(state, stock.id, context.principal);
      const blocker = available.blockers[0];
      if (blocker)
        return refuse(blocker.code, 'The stock is blocked from a new quantity reservation.');
      if (available.unreserved.kind !== 'known')
        return refuse('QUANTITY_UNKNOWN', 'Measure the stock before reserving quantity.');
      if (compareInventoryVolumes(quantity, available.unreserved) > 0)
        return refuse(
          'QUANTITY_RESERVED',
          'The requested reservation exceeds unreserved usable quantity.'
        );
      reservation = {
        ...facts,
        kind: 'quantity',
        stockId: stock.id,
        quantity,
        remaining: { ...quantity },
      };
    } else {
      const item =
        command.item.kind === 'storage'
          ? state.storage[command.item.id]
          : state.vessels[command.item.id];
      if (!item)
        return refuse(
          command.item.kind === 'storage' ? 'STORAGE_NOT_FOUND' : 'VESSEL_NOT_FOUND',
          'The reserved item does not exist.'
        );
      const physical = inventoryCustodyAccess(state, command.item, context.principal);
      if (physical) return physical;
      if (item.lifecycle !== 'active')
        return refuse(
          command.item.kind === 'storage' ? 'STORAGE_DISPOSED' : 'VESSEL_DISPOSED',
          'Disposed items cannot be reserved.'
        );
      if (itemConflict(state, command.item, context.principal, true).length)
        return refuse('RESERVATION_CONFLICT', 'Another holder has an overlapping reservation.');
      reservation = { ...facts, kind: 'item', item: { ...command.item } };
    }
    state.reservations[reservation.id] = reservation;
    return null;
  }
  if (command.kind === 'expire-reservations') {
    for (const id of command.ids) {
      const reservation = state.reservations[id];
      if (!reservation)
        return refuse('RESERVATION_NOT_FOUND', 'A reservation to expire does not exist.');
      if (reservation.lifecycle.kind !== 'active')
        return refuse('RESERVATION_NOT_ACTIVE', 'Only active reservations can expire.');
      if (!due(reservation, context.at))
        return refuse(
          'INVALID_INVENTORY_INPUT',
          'A reservation cannot expire before its recorded deadline.'
        );
      state.reservations[id] = { ...reservation, lifecycle: { kind: 'expired', at: context.at } };
    }
    return null;
  }
  if (command.kind === 'release-reservation' || command.kind === 'cancel-reservation') {
    const reservation = state.reservations[command.reservationId];
    if (!reservation) return refuse('RESERVATION_NOT_FOUND', 'The reservation does not exist.');
    if (reservation.lifecycle.kind !== 'active')
      return refuse(
        'RESERVATION_NOT_ACTIVE',
        'Only active reservations can be released or cancelled.'
      );
    if (
      command.kind === 'release-reservation' &&
      !samePrincipal(reservation.holder, context.principal)
    )
      return refuse('RESERVATION_NOT_OWNED', 'Only the reservation holder can release it.');
    if (
      command.kind === 'cancel-reservation' &&
      (context.principal.kind !== 'local-profile' ||
        context.principal.profileKey !== context.authority.profileKey)
    )
      return refuse(
        'AUTHORITY_REQUIRED',
        'Cancellation requires the explicit local profile authority.'
      );
    state.reservations[reservation.id] = {
      ...reservation,
      lifecycle:
        command.kind === 'release-reservation'
          ? { kind: 'released', at: context.at, reason: command.reason }
          : {
              kind: 'cancelled',
              at: context.at,
              reason: command.reason,
              authority: { ...context.authority },
            },
    };
    return null;
  }
  return undefined;
}

export function prepareInventoryFulfillment(
  state: InventoryReservationDraft,
  command: Extract<InventoryReservationCommand, { kind: 'fulfill-reservations' }>,
  context?: InventoryExecutionContext
): Failure | null {
  if (!context)
    return refuse(
      'CONTEXT_REQUIRED',
      'Reservation fulfillment requires a trusted actor and clock context.'
    );
  if (new Set(command.claims.map((claim) => claim.reservationId)).size !== command.claims.length)
    return refuse(
      'INVALID_RESERVATION_CLAIM',
      'Each fulfillment claim must identify a distinct reservation.'
    );
  const debits = new Map<string, InventoryVolume>();
  for (const input of inventoryCommandWithdrawals(command.withdrawal))
    debits.set(
      input.stockId,
      addInventoryVolumes([debits.get(input.stockId) ?? zero(), input.quantity])
    );
  for (const stockId of debits.keys()) {
    if (
      state.stocks[stockId] &&
      stockAvailability(state, stockId, context.principal).blockers.some(
        (blocker) => blocker.code === 'ALLOCATION_SHORTFALL'
      )
    )
      return refuse(
        'ALLOCATION_SHORTFALL',
        'Recorded quantity is below held allocations. Resolve the shortfall before fulfilling.'
      );
  }
  const claimed = new Map<string, InventoryVolume>();
  const updates = new Map<string, InventoryReservation>();
  for (const claim of command.claims) {
    const reservation = state.reservations[claim.reservationId];
    if (!reservation)
      return refuse('RESERVATION_NOT_FOUND', 'A claimed reservation does not exist.');
    if (reservation.lifecycle.kind !== 'active')
      return refuse('RESERVATION_NOT_ACTIVE', 'Only active reservations can be fulfilled.');
    if (!samePrincipal(reservation.holder, context.principal))
      return refuse('RESERVATION_NOT_OWNED', 'A claim must belong to the acting holder.');
    if (due(reservation, context.at))
      return refuse(
        'EXPIRY_PENDING',
        'A reservation past its deadline cannot be fulfilled. Release or expire it explicitly.'
      );
    const quantity = normalizeInventoryVolume(claim.quantity);
    if (!positive(quantity))
      return refuse('INVALID_RESERVATION_CLAIM', 'A fulfillment claim requires positive volume.');
    if (reservation.kind === 'quantity') {
      const debit = debits.get(reservation.stockId);
      const total = addInventoryVolumes([claimed.get(reservation.stockId) ?? zero(), quantity]);
      if (
        !debit ||
        compareInventoryVolumes(total, debit) > 0 ||
        compareInventoryVolumes(quantity, reservation.remaining) > 0
      )
        return refuse(
          'INVALID_RESERVATION_CLAIM',
          'Quantity claims must match a debited stock and cannot exceed its debit or reserved remainder.'
        );
      claimed.set(reservation.stockId, total);
      const remaining = remainder(reservation.remaining, quantity);
      updates.set(reservation.id, {
        ...reservation,
        remaining,
        lifecycle:
          remaining.value === '0' ? { kind: 'fulfilled', at: context.at } : { kind: 'active' },
      });
    } else {
      const covered = [...debits].filter(([stockId]) => {
        const item = stockTarget(state, stockId);
        return item !== undefined && inventoryItemContains(state, reservation.item, item);
      });
      const total = addInventoryVolumes(covered.map(([, amount]) => amount));
      if (!covered.length || compareInventoryVolumes(total, quantity) !== 0)
        return refuse(
          'INVALID_RESERVATION_CLAIM',
          'An item claim must equal the exact withdrawal volume covered by its physical item.'
        );
      updates.set(reservation.id, {
        ...reservation,
        lifecycle: { kind: 'fulfilled', at: context.at },
      });
    }
  }
  for (const [id, reservation] of updates) state.reservations[id] = reservation;
  return null;
}
