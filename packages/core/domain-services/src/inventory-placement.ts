import { inventoryPlacementCompatibility } from './inventory-configuration';
import type {
  InventoryErrorCode,
  InventoryPhysicalItem,
  InventoryPlacement,
  InventoryState,
  InventoryStorage,
  InventoryStoragePlacement,
  InventoryVessel,
  InventoryVesselPlacement,
  InventoryCustodyDestination,
} from './inventory-types';
import { inventoryStackItems, inventoryStoragePositions } from './inventory-layout';

type Failure = { readonly ok: false; readonly code: InventoryErrorCode; readonly message: string };
type Placement = InventoryPlacement;
type PhysicalRecord = InventoryStorage | InventoryVessel;
export interface InventoryPlacementDraft {
  readonly typeVersions?: InventoryState['typeVersions'];
  readonly recipeVersions?: InventoryState['recipeVersions'];
  readonly fitEvidence?: InventoryState['fitEvidence'];
  readonly storage: Record<string, InventoryStorage>;
  readonly vessels: Record<string, InventoryVessel>;
}
const failure = (code: InventoryErrorCode, message: string): Failure => ({
  ok: false,
  code,
  message,
});

export function inventoryPhysicalRecord(
  state: InventoryPlacementDraft,
  item: InventoryPhysicalItem
): PhysicalRecord | Failure {
  const record = item.kind === 'storage' ? state.storage[item.id] : state.vessels[item.id];
  if (!record)
    return failure(
      item.kind === 'storage' ? 'STORAGE_NOT_FOUND' : 'VESSEL_NOT_FOUND',
      'The physical inventory item does not exist.'
    );
  if (record.lifecycle === 'disposed')
    return failure(
      item.kind === 'storage' ? 'STORAGE_DISPOSED' : 'VESSEL_DISPOSED',
      'Disposed inventory cannot be moved or changed.'
    );
  if ('kind' in record && record.kind === 'fixed-well')
    return failure(
      'FIXED_WELL_IMMUTABLE',
      'A permanent well cannot be moved or disposed independently of its plate.'
    );
  return record;
}

export function inventoryRemovalFailure(
  state: InventoryPlacementDraft,
  item: InventoryPhysicalItem,
  record: PhysicalRecord,
  explicitStack: boolean
): Failure | null {
  if (record.placement.kind !== 'located') return null;
  const parent = state.storage[record.placement.storageId];
  if (!parent) return failure('STORAGE_NOT_FOUND', 'The current storage location does not exist.');
  if (parent.layout.kind !== 'stack') return null;
  if (!explicitStack)
    return failure(
      'STACK_OPERATION_REQUIRED',
      'Use an explicit stack operation to retrieve this item.'
    );
  const top = inventoryStackItems(state, parent.id).at(-1);
  if (!top || top.kind !== item.kind || top.id !== item.id)
    return failure('STACK_TOP_REQUIRED', 'Only the top item can be removed from this stack.');
  return null;
}

export function inventoryPlacementFailure(
  state: InventoryPlacementDraft,
  moving: InventoryPhysicalItem,
  placement: Placement,
  context: 'ordinary' | 'stack' | 'fixed-well' = 'ordinary',
  checkOccupancy = true
): Failure | null {
  if (
    (moving.kind === 'storage' && placement.kind === 'unplaced') ||
    (moving.kind === 'vessel' && placement.kind === 'root')
  )
    return failure('INVALID_PLACEMENT', 'The destination placement does not match this item type.');
  if (placement.kind !== 'located') return null;
  const parent = state.storage[placement.storageId];
  if (!parent)
    return failure('STORAGE_NOT_FOUND', 'The destination storage location does not exist.');
  if (parent.lifecycle === 'disposed')
    return failure('STORAGE_DISPOSED', 'The destination storage location has been disposed.');
  if (parent.layout.kind === 'stack' && context !== 'stack')
    return failure(
      'STACK_OPERATION_REQUIRED',
      'Use an explicit push operation to place an item in a stack.'
    );
  if (parent.layout.kind === 'fixed-well' && context !== 'fixed-well')
    return failure('FIXED_WELL_IMMUTABLE', 'A fixed-well plate contains only its permanent wells.');
  if (parent.layout.kind === 'removable-tube' && moving.kind !== 'vessel')
    return failure('INCOMPATIBLE_LAYOUT', 'A removable-tube layout accepts only movable vessels.');
  if (!inventoryStoragePositions(parent).includes(placement.slotId))
    return failure(
      'INVALID_PLACEMENT',
      'The destination position does not exist in that storage location.'
    );
  let ancestor: InventoryStorage | undefined = parent;
  while (ancestor) {
    if (ancestor.id === moving.id)
      return failure(
        'CONTAINMENT_CYCLE',
        'A storage location cannot contain itself or its ancestor.'
      );
    ancestor =
      ancestor.placement.kind === 'located'
        ? state.storage[ancestor.placement.storageId]
        : undefined;
  }
  const samePosition = (item: PhysicalRecord): boolean =>
    item.id !== moving.id &&
    item.placement.kind === 'located' &&
    item.placement.storageId === placement.storageId &&
    item.placement.slotId === placement.slotId;
  if (
    checkOccupancy &&
    [...Object.values(state.storage), ...Object.values(state.vessels)].some(samePosition)
  )
    return failure('SLOT_OCCUPIED', 'The destination position is occupied.');
  if (checkOccupancy && state.typeVersions && state.recipeVersions && state.fitEvidence) {
    const fit = inventoryPlacementCompatibility(
      {
        storage: state.storage,
        vessels: state.vessels,
        typeVersions: state.typeVersions,
        recipeVersions: state.recipeVersions,
        fitEvidence: state.fitEvidence,
      },
      moving,
      placement.storageId,
      placement.slotId,
      !(moving.kind === 'storage' ? state.storage[moving.id] : state.vessels[moving.id])
    );
    if (fit.logical === 'incompatible' || fit.fit === 'incompatible')
      return failure('INCOMPATIBLE_LAYOUT', fit.reasons.join(', '));
  }
  return null;
}

export function detachInventoryItem(
  state: InventoryPlacementDraft,
  item: InventoryPhysicalItem,
  reported = false
): Failure | null {
  const record = inventoryPhysicalRecord(state, item);
  if ('ok' in record) return record;
  const parent =
    record.placement.kind === 'located' ? state.storage[record.placement.storageId] : undefined;
  const ordered = parent?.layout.kind === 'stack' ? inventoryStackItems(state, parent.id) : [];
  if (!reported) {
    const invalid = inventoryRemovalFailure(state, item, record, true);
    if (invalid) return invalid;
  }
  placeInventoryItem(
    state,
    item,
    record,
    item.kind === 'storage' ? { kind: 'root' } : { kind: 'unplaced' }
  );
  if (reported && parent?.layout.kind === 'stack') {
    const remaining = ordered.filter((child) => child.kind !== item.kind || child.id !== item.id);
    for (const [index, child] of remaining.entries()) {
      const row = child.kind === 'storage' ? state.storage[child.id] : state.vessels[child.id];
      placeInventoryItem(state, child, row, {
        kind: 'located',
        storageId: parent.id,
        slotId: String(index + 1),
      });
    }
  }
  return null;
}

export function inventoryDestinationPlacement(
  state: InventoryPlacementDraft,
  item: InventoryPhysicalItem,
  destination: InventoryCustodyDestination,
  plan = false
): Placement | Failure {
  let placement: Placement;
  if (destination.kind === 'stack-top') {
    const stack = state.storage[destination.stackId];
    if (!stack) return failure('STORAGE_NOT_FOUND', 'The destination stack does not exist.');
    if (stack.layout.kind !== 'stack')
      return failure('INCOMPATIBLE_LAYOUT', 'The destination is not an ordered stack.');
    const size = inventoryStackItems(state, stack.id).length;
    if (!plan && size >= stack.layout.capacity)
      return failure('STACK_FULL', 'The destination stack is full.');
    placement = { kind: 'located', storageId: stack.id, slotId: String(plan ? 1 : size + 1) };
  } else placement = destination;
  const invalid = inventoryPlacementFailure(
    state,
    item,
    placement,
    destination.kind === 'stack-top' ? 'stack' : 'ordinary',
    !plan
  );
  return invalid ?? placement;
}

export function placeInventoryItem(
  state: InventoryPlacementDraft,
  item: InventoryPhysicalItem,
  record: PhysicalRecord,
  placement: Placement
): void {
  if (item.kind === 'storage')
    state.storage[item.id] = {
      ...(record as InventoryStorage),
      placement: { ...placement } as InventoryStoragePlacement,
    };
  else
    state.vessels[item.id] = {
      ...(record as InventoryVessel),
      placement: { ...placement } as InventoryVesselPlacement,
    };
}

export function inventoryItemContains(
  state: Pick<InventoryState, 'storage' | 'vessels'>,
  container: InventoryPhysicalItem,
  item: InventoryPhysicalItem
): boolean {
  if (container.kind === item.kind && container.id === item.id) return true;
  if (container.kind !== 'storage') return false;
  let record = item.kind === 'storage' ? state.storage[item.id] : state.vessels[item.id];
  const visited = new Set<string>();
  while (record?.placement.kind === 'located') {
    if (record.placement.storageId === container.id) return true;
    if (visited.has(record.placement.storageId)) return false;
    visited.add(record.placement.storageId);
    record = state.storage[record.placement.storageId];
  }
  return false;
}
