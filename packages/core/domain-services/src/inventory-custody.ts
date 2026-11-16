import { inventoryPrincipalMatchesActor } from './inventory-attribution';
import { inventoryReservationPlacementFailure } from './inventory-reservation-placement';
import type {
  InventoryCommand,
  InventoryCustody,
  InventoryCustodyCommand,
  InventoryEffectiveCustody,
  InventoryErrorCode,
  InventoryExecutionContext,
  InventoryItemCustody,
  InventoryLocationObservation,
  InventoryLocationPathEntry,
  InventoryPhysicalItem,
  InventoryPrincipal,
  InventoryState,
  InventoryStorage,
  InventoryVessel,
  InventoryAvailabilityBlocker,
} from './inventory-types';
import {
  detachInventoryItem,
  inventoryDestinationPlacement,
  inventoryItemContains,
  inventoryPhysicalRecord,
  inventoryRemovalFailure,
  placeInventoryItem,
  type InventoryPlacementDraft,
} from './inventory-placement';

type CustodyState = Pick<
  InventoryState,
  'storage' | 'vessels' | 'stocks' | 'reservations' | 'lastRecordedAt'
>;
export interface InventoryCustodyDraft extends InventoryPlacementDraft {
  readonly lastRecordedAt: number;
  readonly stocks: InventoryState['stocks'];
  readonly reservations: InventoryState['reservations'];
}
type Failure = { readonly ok: false; readonly code: InventoryErrorCode; readonly message: string };
const refuse = (code: InventoryErrorCode, message: string): Failure => ({
  ok: false,
  code,
  message,
});
const recordFor = (state: CustodyState, item: InventoryPhysicalItem) =>
  item.kind === 'storage' ? state.storage[item.id] : state.vessels[item.id];

export function inventoryEffectiveCustody(
  state: CustodyState,
  item: InventoryPhysicalItem
): InventoryEffectiveCustody {
  const visited = new Set<string>();
  let cursor = item;
  while (!visited.has(cursor.id)) {
    visited.add(cursor.id);
    const record = recordFor(state, cursor);
    if (!record) throw new TypeError('The physical inventory item does not exist.');
    if ('custody' in record && record.custody.kind !== 'available')
      return {
        root: { ...cursor },
        state: structuredClone(record.custody),
        inherited: cursor.kind !== item.kind || cursor.id !== item.id,
      };
    if (record.placement.kind !== 'located')
      return { root: null, state: { kind: 'available' }, inherited: false };
    cursor = { kind: 'storage', id: record.placement.storageId };
  }
  throw new TypeError('Custody containment must not contain a cycle.');
}

export function inventoryCustodyAccess(
  state: CustodyState,
  item: InventoryPhysicalItem,
  principal?: InventoryPrincipal
): Failure | null {
  const effective = inventoryEffectiveCustody(state, item);
  switch (effective.state.kind) {
    case 'available':
      return null;
    case 'checked-out':
      return inventoryPrincipalMatchesActor(effective.state.holder, principal)
        ? null
        : refuse('ITEM_CHECKED_OUT', 'The item is checked out to another holder.');
    case 'in-transit':
      return refuse('ITEM_IN_TRANSIT', 'Items in transit cannot be used physically.');
    case 'missing':
      return refuse('ITEM_MISSING', 'Locate this missing item before physical use.');
  }
}

function reservationConflicts(
  state: CustodyState,
  item: InventoryPhysicalItem,
  principal: InventoryPrincipal | undefined
): string[] {
  return Object.values(state.reservations)
    .filter((reservation) => {
      if (
        reservation.lifecycle.kind !== 'active' ||
        inventoryPrincipalMatchesActor(reservation.holder, principal)
      )
        return false;
      if (reservation.kind === 'item')
        return (
          inventoryItemContains(state, item, reservation.item) ||
          inventoryItemContains(state, reservation.item, item)
        );
      const stock = state.stocks[reservation.stockId];
      return stock && inventoryItemContains(state, item, { kind: 'vessel', id: stock.vesselId });
    })
    .map((reservation) => reservation.id);
}

export function inventoryItemCustody(
  state: CustodyState,
  item: InventoryPhysicalItem,
  principal: InventoryPrincipal | undefined,
  at: number
): InventoryItemCustody {
  const record = recordFor(state, item);
  if (!record) throw new TypeError('The physical inventory item does not exist.');
  const effective = inventoryEffectiveCustody(state, item);
  const custody = effective.state;
  const blockers: InventoryAvailabilityBlocker[] = [];
  const owner =
    custody.kind === 'checked-out' || custody.kind === 'in-transit'
      ? inventoryPrincipalMatchesActor(custody.holder, principal)
      : false;
  if (custody.kind === 'checked-out' && !owner)
    blockers.push({
      code: 'ITEM_CHECKED_OUT',
      item: effective.root!,
      holder: { ...custody.holder },
    });
  if (custody.kind === 'in-transit')
    blockers.push({ code: 'ITEM_IN_TRANSIT', item: effective.root! });
  if (custody.kind === 'missing') blockers.push({ code: 'ITEM_MISSING', item: effective.root! });
  const movable =
    !('kind' in record && record.kind === 'fixed-well') && record.lifecycle === 'active';
  const accessible = custody.kind === 'available' || (custody.kind === 'checked-out' && owner);
  const conflicts = reservationConflicts(state, item, principal);
  const departure =
    movable &&
    accessible &&
    conflicts.length === 0 &&
    inventoryRemovalFailure(state, item, record, true) === null;
  return {
    ...effective,
    item: { ...item },
    placement: { ...record.placement },
    lastKnown: custody.kind === 'available' ? null : observation(state, item),
    overdue: custody.kind === 'checked-out' && custody.dueAt !== null && at >= custody.dueAt,
    blockers,
    actions: {
      checkout: departure && (custody.kind === 'available' || effective.inherited),
      startTransit: departure,
      return:
        movable &&
        (custody.kind === 'checked-out' || custody.kind === 'in-transit') &&
        (owner || principal?.kind === 'local-profile'),
      reportMissing: movable && (custody.kind !== 'missing' || effective.inherited),
      locate: movable && custody.kind === 'missing',
    },
  };
}

function physicalPath(
  state: CustodyState,
  item: InventoryPhysicalItem
): InventoryLocationPathEntry[] {
  const path: InventoryLocationPathEntry[] = [];
  let cursor = item;
  const visited = new Set<string>();
  while (!visited.has(cursor.id)) {
    visited.add(cursor.id);
    const record = recordFor(state, cursor);
    if (!record) throw new TypeError('The last-known location path is incomplete.');
    path.unshift({
      item: { ...cursor },
      name: record.name,
      position: record.placement.kind === 'located' ? record.placement.slotId : null,
    });
    if (record.placement.kind !== 'located') return path;
    cursor = { kind: 'storage', id: record.placement.storageId };
  }
  throw new TypeError('A last-known location path cannot contain a cycle.');
}

export function inventoryCurrentLocationPath(
  state: CustodyState,
  item: InventoryPhysicalItem
): readonly InventoryLocationPathEntry[] | null {
  const record = recordFor(state, item);
  if (!record) throw new TypeError('The physical inventory item does not exist.');
  if (
    record.placement.kind === 'unplaced' ||
    inventoryEffectiveCustody(state, item).state.kind !== 'available'
  )
    return null;
  return physicalPath(state, item);
}

function observation(
  state: CustodyState,
  item: InventoryPhysicalItem,
  at?: number
): InventoryLocationObservation {
  const effective = inventoryEffectiveCustody(state, item);
  const record = recordFor(state, item)!;
  if (effective.state.kind === 'available') {
    if (at === undefined) throw new TypeError('A new physical observation requires accepted time.');
    return {
      observedAt: at,
      placement: { ...record.placement },
      path: physicalPath(state, item),
      custodyRoot: null,
      relativePath: [],
      relativeAt: null,
    };
  }
  const snapshot = structuredClone(effective.state.lastKnown);
  if (!effective.inherited) return snapshot;
  const path = physicalPath(state, item);
  const rootIndex = path.findIndex(
    (entry) => entry.item.kind === effective.root!.kind && entry.item.id === effective.root!.id
  );
  return {
    ...snapshot,
    placement: { ...record.placement },
    custodyRoot: snapshot.custodyRoot ?? effective.root,
    relativePath: [...snapshot.relativePath, ...path.slice(rootIndex + 1)],
    relativeAt: at ?? null,
  };
}

function setCustody(
  state: InventoryCustodyDraft,
  item: InventoryPhysicalItem,
  custody: InventoryCustody
): void {
  if (item.kind === 'storage') state.storage[item.id] = { ...state.storage[item.id], custody };
  else {
    const record = state.vessels[item.id];
    if (record.kind !== 'movable')
      throw new TypeError('A permanent well inherits custody from its plate.');
    state.vessels[item.id] = { ...record, custody };
  }
}

export function applyInventoryCustodyCommand(
  state: InventoryCustodyDraft,
  command: InventoryCommand,
  context?: InventoryExecutionContext
): Failure | null | undefined {
  if (
    ![
      'checkout-item',
      'start-item-transit',
      'return-item',
      'report-item-missing',
      'locate-item',
    ].includes(command.kind)
  )
    return undefined;
  if (!context)
    return refuse('CONTEXT_REQUIRED', 'Custody commands require trusted actor and clock context.');
  const custodyCommand = command as InventoryCustodyCommand;
  const record = inventoryPhysicalRecord(state, custodyCommand.item);
  if ('ok' in record) return record;
  const effective = inventoryEffectiveCustody(state, custodyCommand.item);
  const current = effective.state;
  const owner =
    current.kind === 'checked-out' || current.kind === 'in-transit'
      ? inventoryPrincipalMatchesActor(current.holder, context.principal)
      : false;
  const recover =
    context.principal.kind === 'local-profile' &&
    context.principal.profileKey === context.authority.profileKey;
  if (custodyCommand.kind === 'return-item' || custodyCommand.kind === 'locate-item') {
    if (
      custodyCommand.kind === 'locate-item'
        ? current.kind !== 'missing'
        : current.kind !== 'checked-out' && current.kind !== 'in-transit'
    )
      return refuse(
        'CUSTODY_STATE_CONFLICT',
        'This custody transition does not match the current item state.'
      );
    if (custodyCommand.kind === 'return-item' && !owner && !recover)
      return refuse(
        'CUSTODY_NOT_OWNED',
        'Only the current holder or explicit local profile recovery may return this item.'
      );
    const detached = detachInventoryItem(state, custodyCommand.item, true);
    if (detached) return detached;
    const destination = inventoryDestinationPlacement(
      state,
      custodyCommand.item,
      custodyCommand.destination
    );
    if ('ok' in destination) return destination;
    if (destination.kind === 'located') {
      const invalid = inventoryCustodyAccess(
        state,
        { kind: 'storage', id: destination.storageId },
        context.principal
      );
      if (invalid) return invalid;
      const conflicts = reservationConflicts(
        state,
        { kind: 'storage', id: destination.storageId },
        context.principal
      ).filter((id) => {
        const reservation = state.reservations[id];
        return (
          reservation.kind === 'item' &&
          inventoryItemContains(state, reservation.item, {
            kind: 'storage',
            id: destination.storageId,
          })
        );
      });
      if (conflicts.length)
        return refuse('ITEM_RESERVED', 'The destination storage is reserved by another holder.');
    }
    const placementConflict = inventoryReservationPlacementFailure(
      state,
      [custodyCommand.item],
      destination.kind === 'located' ? [{ kind: 'storage', id: destination.storageId }] : []
    );
    if (placementConflict) return placementConflict;
    setCustody(state, custodyCommand.item, { kind: 'available' });
    placeInventoryItem(
      state,
      custodyCommand.item,
      recordFor(state, custodyCommand.item)!,
      destination
    );
    return null;
  }
  const lastKnown = observation(state, custodyCommand.item, context.at);
  if (custodyCommand.kind === 'report-item-missing') {
    if (current.kind === 'missing' && !effective.inherited)
      return refuse('CUSTODY_STATE_CONFLICT', 'This item is already recorded missing.');
    const detached = detachInventoryItem(state, custodyCommand.item, true);
    if (detached) return detached;
    const holder = current.kind === 'available' ? null : current.holder;
    setCustody(state, custodyCommand.item, {
      kind: 'missing',
      holder: holder ? { ...holder } : null,
      reportedBy: { ...context.principal },
      at: context.at,
      reason: custodyCommand.reason,
      lastKnown,
    });
    return null;
  }
  if (current.kind !== 'available' && !(current.kind === 'checked-out' && owner))
    return refuse(
      current.kind === 'checked-out' ? 'CUSTODY_NOT_OWNED' : 'CUSTODY_STATE_CONFLICT',
      'This item cannot depart from its current custody state.'
    );
  if (
    custodyCommand.kind === 'checkout-item' &&
    current.kind === 'checked-out' &&
    !effective.inherited
  )
    return refuse('CUSTODY_STATE_CONFLICT', 'This item is already checked out.');
  if (reservationConflicts(state, custodyCommand.item, context.principal).length)
    return refuse(
      'RESERVATION_CONFLICT',
      'Departure would make another holder’s active reservation inaccessible.'
    );
  if (
    custodyCommand.kind === 'checkout-item' &&
    custodyCommand.dueAt !== null &&
    custodyCommand.dueAt <= context.at
  )
    return refuse(
      'INVALID_INVENTORY_INPUT',
      'A new checkout due time must be later than checkout.'
    );
  if (custodyCommand.kind === 'start-item-transit') {
    const planned = inventoryDestinationPlacement(
      state,
      custodyCommand.item,
      custodyCommand.destination,
      true
    );
    if ('ok' in planned) return planned;
  }
  const detached = detachInventoryItem(state, custodyCommand.item);
  if (detached) return detached;
  setCustody(
    state,
    custodyCommand.item,
    custodyCommand.kind === 'checkout-item'
      ? {
          kind: 'checked-out',
          reason: custodyCommand.reason,
          holder: { ...context.principal },
          at: context.at,
          dueAt: custodyCommand.dueAt,
          lastKnown,
        }
      : {
          kind: 'in-transit',
          reason: custodyCommand.reason,
          holder: { ...context.principal },
          at: context.at,
          destination: structuredClone(custodyCommand.destination),
          lastKnown,
        }
  );
  return null;
}

export function inventoryCustodyGuard(
  state: CustodyState,
  command: InventoryCommand,
  context?: InventoryExecutionContext
): Failure | null {
  const moving: InventoryPhysicalItem[] = [];
  const access: InventoryPhysicalItem[] = [];
  let destination: InventoryPhysicalItem | null = null;
  const stockItem = (id: string) =>
    state.stocks[id] ? { kind: 'vessel' as const, id: state.stocks[id].vesselId } : null;
  const addStock = (id: string) => {
    const item = stockItem(id);
    if (item) access.push(item);
  };
  switch (command.kind) {
    case 'consume':
      addStock(command.stockId);
      break;
    case 'transfer':
      addStock(command.sourceStockId);
      if (command.destination.kind === 'new-stock')
        access.push({ kind: 'vessel', id: command.destination.vesselId });
      else addStock(command.destination.stockId);
      break;
    case 'pool':
      for (const input of command.inputs) addStock(input.stockId);
      access.push({ kind: 'vessel', id: command.vesselId });
      break;
    case 'dilute':
      addStock(command.sample.stockId);
      addStock(command.diluent.stockId);
      access.push({ kind: 'vessel', id: command.vesselId });
      break;
    case 'receive-stock':
    case 'receive-lot-stock':
      access.push({ kind: 'vessel', id: command.vesselId });
      break;
    case 'move-storage':
      moving.push({ kind: 'storage', id: command.id });
      if (command.placement.kind === 'located')
        destination = { kind: 'storage', id: command.placement.storageId };
      break;
    case 'move-vessel':
      moving.push({ kind: 'vessel', id: command.id });
      if (command.placement.kind === 'located')
        destination = { kind: 'storage', id: command.placement.storageId };
      break;
    case 'push-stack':
      moving.push(command.item);
      destination = { kind: 'storage', id: command.stackId };
      break;
    case 'pop-stack':
      moving.push(command.item);
      if (command.destination.kind === 'located')
        destination = { kind: 'storage', id: command.destination.storageId };
      break;
    case 'dispose-plate':
      access.push({ kind: 'storage', id: command.id });
      break;
    case 'dispose-vessel':
      access.push({ kind: 'vessel', id: command.id });
      break;
    case 'create-storage':
    case 'create-layout-storage':
    case 'create-vessel':
      if (command.placement.kind === 'located')
        access.push({ kind: 'storage', id: command.placement.storageId });
      break;
  }
  if (destination) access.push(destination);
  access.push(...moving);
  for (const item of access) {
    if (!recordFor(state, item)) continue;
    const invalid = inventoryCustodyAccess(state, item, context?.principal);
    if (invalid) return invalid;
  }
  for (const item of moving) {
    if (!recordFor(state, item)) continue;
    const source = inventoryEffectiveCustody(state, item);
    const target =
      destination && recordFor(state, destination)
        ? inventoryEffectiveCustody(state, destination)
        : { root: null };
    if (source.root?.id !== target.root?.id || (source.root !== null && !source.inherited))
      return refuse(
        'CUSTODY_TRANSITION_REQUIRED',
        'Use an explicit custody command to move across custody boundaries.'
      );
  }
  return null;
}
