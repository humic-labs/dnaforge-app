import type { InventoryMaterialDialog } from './InventoryMaterialForm';
import type { InventoryCompositionDialog } from './InventoryCompositionForm';
import type { InventoryReservationDialog } from './InventoryReservations';
import type { InventoryCustodyDialog } from './InventoryCustodyForm';
import type { InventoryPhysicalDialogKind } from './inventory-physical-view';
import {
  inventoryStoragePositions,
  inventoryStackItems,
  type InventoryCommand,
  type InventoryAvailabilityBlocker,
  type InventoryItemCustody,
  type InventoryLocationPathEntry,
  type InventoryConcentration,
  type InventoryConcentrationUnit,
  type InventoryLocatedPlacement,
  type InventoryState,
  type InventoryStorage,
  type InventoryVessel,
} from '@waypoint/domain-services';

export type InventorySelection =
  | { kind: 'all' }
  | { kind: 'unplaced' }
  | { kind: 'disposed' }
  | { kind: 'location'; id: string };

export type InventoryItem = { kind: 'storage' | 'vessel'; id: string };

export type InventoryDialog =
  | InventoryMaterialDialog
  | InventoryCompositionDialog
  | InventoryReservationDialog
  | InventoryCustodyDialog
  | InventoryPhysicalDialogKind
  | { kind: 'none' }
  | { kind: 'container'; placement?: InventoryLocatedPlacement; typeVersionId?: string }
  | { kind: 'location'; parentId?: string; typeVersionId?: string }
  | { kind: 'receive'; placement?: InventoryLocatedPlacement; vesselId?: string }
  | { kind: 'move'; item: InventoryItem }
  | { kind: 'use'; stockId: string }
  | { kind: 'reconcile'; stockId: string }
  | { kind: 'quality'; stockId: string; quality: 'usable' | 'quarantined' }
  | { kind: 'dispose'; item: InventoryItem };

export function inventoryConcentrationUnitLabel(unit: InventoryConcentrationUnit): string {
  return unit.replace('ug', 'µg').replace('uL', 'µL').replace('uM', 'µM');
}

export function inventoryConcentrationLabel(concentration: InventoryConcentration): string {
  if (concentration.kind === 'unknown') {
    return concentration.reason === 'missing-input'
      ? 'Unknown · missing input measurement'
      : concentration.reason === 'incompatible-units'
        ? 'Unknown · incompatible measurement units'
        : 'Unmeasured';
  }
  const amount =
    concentration.denominator === '1'
      ? concentration.numerator
      : `${concentration.numerator}/${concentration.denominator}`;
  return `${amount} ${inventoryConcentrationUnitLabel(concentration.unit)}`;
}

export function inventoryOccupant(
  state: InventoryState,
  storageId: string,
  position: string
): InventoryStorage | InventoryVessel | undefined {
  return [...Object.values(state.storage), ...Object.values(state.vessels)].find(
    (item) =>
      item.placement.kind === 'located' &&
      item.placement.storageId === storageId &&
      item.placement.slotId === position
  );
}

export function locationPath(state: InventoryState, id: string): string {
  const names: string[] = [];
  const visited = new Set<string>();
  let current = state.storage[id];
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    names.unshift(current.name);
    if (current.placement.kind !== 'located') break;
    names.unshift(current.placement.slotId);
    current = state.storage[current.placement.storageId];
  }
  return names.join(' / ');
}

export function inventoryLocationPathLabel(path: readonly InventoryLocationPathEntry[]): string {
  return path
    .flatMap((entry) => (entry.position === null ? [entry.name] : [entry.position, entry.name]))
    .join(' / ');
}

export function inventoryBlockerLabel(blocker: InventoryAvailabilityBlocker): string {
  const labels: Record<InventoryAvailabilityBlocker['code'], string> = {
    QUANTITY_UNKNOWN: 'Recorded quantity is unknown',
    STOCK_QUARANTINED: 'This stock is quarantined',
    VESSEL_DISPOSED: 'This container has been disposed',
    ALLOCATION_SHORTFALL: 'Reservations exceed recorded stock',
    ITEM_RESERVED: 'This item is reserved',
    EXPIRY_PENDING: 'Past deadline; still allocated until released or expired',
    ITEM_CHECKED_OUT: 'This item is checked out to another holder',
    ITEM_IN_TRANSIT: 'This item is in transit',
    ITEM_MISSING: 'The current location of this item is unknown',
    POSITION_UNAVAILABLE: 'This position is marked unavailable',
  };
  return labels[blocker.code];
}

export function inventoryCustodyLabel(custody: InventoryItemCustody | undefined): string {
  return custody
    ? {
        available: 'Available',
        'checked-out': 'Checked out',
        'in-transit': 'In transit',
        missing: 'Missing',
      }[custody.state.kind]
    : 'Custody unavailable';
}

export function vesselLocation(
  state: InventoryState,
  vessel: InventoryVessel,
  custody?: InventoryItemCustody
): string {
  if (custody?.state.kind === 'missing') return 'Location unknown';
  if (custody && custody.state.kind !== 'available') return inventoryCustodyLabel(custody);
  return vessel.placement.kind === 'located'
    ? `${locationPath(state, vessel.placement.storageId)} / ${vessel.placement.slotId}`
    : 'Unplaced';
}

export function stockInSelection(
  state: InventoryState,
  vessel: InventoryVessel,
  selection: InventorySelection
): boolean {
  if (selection.kind === 'disposed') return vessel.lifecycle === 'disposed';
  if (vessel.lifecycle === 'disposed') return false;
  if (selection.kind === 'all') return true;
  if (selection.kind === 'unplaced') return vessel.placement.kind === 'unplaced';
  let placement = vessel.placement;
  const visited = new Set<string>();
  while (placement.kind === 'located' && !visited.has(placement.storageId)) {
    if (placement.storageId === selection.id) return true;
    visited.add(placement.storageId);
    const parent = state.storage[placement.storageId];
    if (!parent || parent.placement.kind !== 'located') break;
    placement = parent.placement;
  }
  return false;
}

export function destinationCommands(
  state: InventoryState,
  item: InventoryItem,
  destination: InventoryLocatedPlacement | null
): InventoryCommand[] {
  const current = item.kind === 'storage' ? state.storage[item.id] : state.vessels[item.id];
  if (destination && state.storage[destination.storageId]?.layout.kind === 'stack')
    return [{ kind: 'push-stack', stackId: destination.storageId, item }];
  const placement =
    destination ??
    (item.kind === 'storage' ? { kind: 'root' as const } : { kind: 'unplaced' as const });
  if (
    current.placement.kind === 'located' &&
    state.storage[current.placement.storageId]?.layout.kind === 'stack'
  )
    return [
      { kind: 'pop-stack', stackId: current.placement.storageId, item, destination: placement },
    ];
  return item.kind === 'storage'
    ? [{ kind: 'move-storage', id: item.id, placement: placement as InventoryStorage['placement'] }]
    : [{ kind: 'move-vessel', id: item.id, placement: placement as InventoryVessel['placement'] }];
}

export function destinationPositions(
  state: InventoryState,
  storage: InventoryStorage,
  movingId?: string
): readonly string[] {
  if (storage.layout.kind === 'stack')
    return inventoryStackItems(state, storage.id).length < storage.layout.capacity ? ['top'] : [];
  return inventoryStoragePositions(storage).filter((position) => {
    const occupant = inventoryOccupant(state, storage.id, position);
    return !occupant || occupant.id === movingId;
  });
}

export function historyLabel(command: InventoryCommand, state: InventoryState): string {
  switch (command.kind) {
    case 'define-physical-type':
      return `Published type ${command.name}`;
    case 'define-equipment-recipe':
      return `Published equipment recipe ${command.name}`;
    case 'instantiate-physical-type':
      return `Added typed item ${command.name}`;
    case 'instantiate-equipment-recipe':
      return `Added equipment ${command.name}`;
    case 'configure-item':
      return 'Updated installed arrangement';
    case 'reconfigure-storage':
      return 'Updated installed layout';
    case 'record-item-geometry':
      return 'Recorded installed dimensions';
    case 'record-fit-evidence':
      return 'Recorded fit evidence';
    case 'checkout-item':
      return 'Checked out item';
    case 'start-item-transit':
      return 'Started item transfer';
    case 'return-item':
      return 'Recorded item return or arrival';
    case 'report-item-missing':
      return 'Reported item missing';
    case 'locate-item':
      return 'Recorded item location';
    case 'reserve-quantity':
      return `Reserved ${command.quantity.value} ${command.quantity.unit === 'uL' ? 'µL' : command.quantity.unit} for ${command.purpose}`;
    case 'reserve-item':
      return `Reserved item for ${command.purpose}`;
    case 'release-reservation':
      return 'Released reservation';
    case 'cancel-reservation':
      return 'Cancelled reservation';
    case 'expire-reservations':
      return 'Recorded reservation expiry';
    case 'fulfill-reservations':
      return `Fulfilled reservation · ${historyLabel(command.withdrawal, state)}`;
    case 'create-lot':
      return `Added batch ${command.name}`;
    case 'receive-lot-stock':
      return `Received batch ${state.lots[command.lotId]?.name ?? command.lotId}`;
    case 'associate-stock-lot':
      return `Attributed stock to ${state.lots[command.lotId]?.name ?? command.lotId}`;
    case 'set-vessel-limits':
      return `Recorded container limits for ${state.vessels[command.vesselId]?.name ?? command.vesselId}`;
    case 'record-composition':
      return command.composition.kind === 'unknown'
        ? 'Marked composition unknown'
        : 'Recorded homogeneous composition';
    case 'transfer':
      return `Transferred ${command.quantity.value} ${command.quantity.unit === 'uL' ? 'µL' : command.quantity.unit}`;
    case 'pool':
      return `Pooled stocks into ${command.name}`;
    case 'dilute':
      return `Diluted stock into ${command.name}`;
    case 'create-storage':
    case 'create-layout-storage':
      return `Added location ${command.name}`;
    case 'create-vessel':
      return `Added container ${command.name}`;
    case 'receive-stock':
      return `Received stock in ${state.vessels[command.vesselId]?.name ?? 'container'}`;
    case 'move-storage':
      return `Moved ${state.storage[command.id]?.name ?? 'location'}`;
    case 'move-vessel':
      return `Moved ${state.vessels[command.id]?.name ?? 'container'}`;
    case 'consume':
      return `Used ${command.quantity.value} ${command.quantity.unit === 'uL' ? 'µL' : command.quantity.unit}`;
    case 'reconcile':
      return command.quantity.kind === 'unknown'
        ? 'Marked quantity unknown'
        : `Recorded ${command.quantity.value} ${command.quantity.unit === 'uL' ? 'µL' : command.quantity.unit}`;
    case 'set-quality':
      return command.quality === 'quarantined' ? 'Quarantined stock' : 'Released stock';
    case 'dispose-vessel':
      return `Disposed ${state.vessels[command.id]?.name ?? 'container'}`;
    case 'dispose-plate':
      return `Disposed plate ${state.storage[command.id]?.name ?? ''}`;
    case 'push-stack':
      return `Placed on top of ${state.storage[command.stackId]?.name ?? 'stack'}`;
    case 'pop-stack':
      return `Removed from ${state.storage[command.stackId]?.name ?? 'stack'}`;
  }
}
