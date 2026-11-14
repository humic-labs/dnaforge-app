import {
  inventoryStoragePositions,
  inventoryStackItems,
  type InventoryCommand,
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
  | { kind: 'none' }
  | { kind: 'location'; parentId?: string }
  | { kind: 'receive'; placement?: InventoryLocatedPlacement; vesselId?: string }
  | { kind: 'move'; item: InventoryItem }
  | { kind: 'use'; stockId: string }
  | { kind: 'reconcile'; stockId: string }
  | { kind: 'quality'; stockId: string; quality: 'usable' | 'quarantined' }
  | { kind: 'dispose'; item: InventoryItem };

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
    current = state.storage[current.placement.storageId];
  }
  return names.join(' / ');
}

export function vesselLocation(state: InventoryState, vessel: InventoryVessel): string {
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
