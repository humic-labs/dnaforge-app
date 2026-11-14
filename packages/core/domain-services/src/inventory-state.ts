import {
  type InventoryCommand,
  type InventoryCommandBatch,
  type InventoryErrorCode,
  type InventoryExecutionContext,
  type InventoryLayout,
  type InventoryLot,
  type InventoryPhysicalItem,
  type InventoryReservation,
  type InventoryState,
  type InventoryStock,
  type InventoryStorage,
  type InventoryStoragePlacement,
  type InventoryTransition,
  type InventoryVessel,
  type InventoryVesselPlacement,
} from './inventory-types';
import {
  inventoryStackItems,
  inventoryStoragePositions,
  inventoryWellId,
} from './inventory-layout';
import { normalizeInventoryQuantity } from './inventory-volume';
import {
  applyInventoryMaterialCommand,
  inventoryCapacityFailure,
  inventoryWithdrawalResult,
  unknownInventoryVesselLimits,
} from './inventory-materials';
import {
  InventoryValidationError,
  parseInventoryCommandBatch,
  parseInventoryExecutionContext,
} from './inventory-validation';
import {
  applyInventoryReservationCommand,
  inventoryReservationGuard,
  prepareInventoryFulfillment,
} from './inventory-reservations';

type Failure = Extract<InventoryTransition, { ok: false }>;
type Placement = InventoryStoragePlacement | InventoryVesselPlacement;
type PhysicalRecord = InventoryStorage | InventoryVessel;
interface Draft {
  lastRecordedAt: number;
  storage: Record<string, InventoryStorage>;
  vessels: Record<string, InventoryVessel>;
  stocks: Record<string, InventoryStock>;
  lots: Record<string, InventoryLot>;
  reservations: Record<string, InventoryReservation>;
}

function failure(code: InventoryErrorCode, message: string): Failure {
  return { ok: false, code, message };
}

function hasId(state: Draft, id: string): boolean {
  return [state.storage, state.vessels, state.stocks, state.lots, state.reservations].some((rows) =>
    Object.hasOwn(rows, id)
  );
}

function itemRecord(state: Draft, item: InventoryPhysicalItem): PhysicalRecord | Failure {
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

function removalFailure(
  state: Draft,
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

function placementFailure(
  state: Draft,
  moving: InventoryPhysicalItem,
  placement: Placement,
  context: 'ordinary' | 'stack' | 'fixed-well' = 'ordinary'
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
  if ([...Object.values(state.storage), ...Object.values(state.vessels)].some(samePosition))
    return failure('SLOT_OCCUPIED', 'The destination position is occupied.');
  return null;
}

function placeItem(
  state: Draft,
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

function createStorage(
  state: Draft,
  command: {
    readonly id: string;
    readonly name: string;
    readonly layout: InventoryLayout;
    readonly placement: InventoryStoragePlacement;
  }
): Failure | null {
  if (hasId(state, command.id))
    return failure('ID_ALREADY_EXISTS', 'That inventory identifier already exists.');
  const invalid = placementFailure(state, { kind: 'storage', id: command.id }, command.placement);
  if (invalid) return invalid;
  const storage: InventoryStorage = {
    id: command.id,
    name: command.name,
    layout:
      command.layout.kind === 'named'
        ? { kind: 'named', slots: [...command.layout.slots] }
        : { ...command.layout },
    placement: { ...command.placement },
    lifecycle: 'active',
  };
  state.storage[storage.id] = storage;
  if (storage.layout.kind === 'fixed-well') {
    for (const position of inventoryStoragePositions(storage)) {
      const id = inventoryWellId(storage.id, position);
      if (hasId(state, id))
        return failure('ID_ALREADY_EXISTS', 'A permanent well identifier already exists.');
      state.vessels[id] = {
        kind: 'fixed-well',
        limits: unknownInventoryVesselLimits(),
        id,
        name: position,
        placement: { kind: 'located', storageId: storage.id, slotId: position },
        lifecycle: 'active',
      };
    }
  }
  return null;
}

function stockVessel(state: Draft, stock: InventoryStock): InventoryVessel | Failure {
  const vessel = state.vessels[stock.vesselId];
  if (!vessel) return failure('VESSEL_NOT_FOUND', 'The stock vessel does not exist.');
  return vessel.lifecycle === 'disposed'
    ? failure('VESSEL_DISPOSED', 'Disposed vessels cannot be used or changed.')
    : vessel;
}

function applyCommand(
  state: Draft,
  command: InventoryCommand,
  context?: InventoryExecutionContext
): Failure | null {
  const reservation = applyInventoryReservationCommand(state, command, context);
  if (reservation !== undefined) return reservation;
  if (command.kind === 'fulfill-reservations') {
    const invalid = prepareInventoryFulfillment(state, command, context);
    return invalid ?? applyCommand(state, command.withdrawal, context);
  }
  const reserved = inventoryReservationGuard(state, command, context);
  if (reserved) return reserved;
  const material = applyInventoryMaterialCommand(state, command);
  if (material !== undefined) return material;
  switch (command.kind) {
    case 'create-storage':
      return createStorage(state, { ...command, layout: { kind: 'named', slots: command.slots } });
    case 'create-layout-storage':
      return createStorage(state, command);
    case 'create-vessel': {
      if (hasId(state, command.id))
        return failure('ID_ALREADY_EXISTS', 'That inventory identifier already exists.');
      const invalid = placementFailure(
        state,
        { kind: 'vessel', id: command.id },
        command.placement
      );
      if (invalid) return invalid;
      state.vessels[command.id] = {
        kind: 'movable',
        limits: unknownInventoryVesselLimits(),
        id: command.id,
        name: command.name,
        placement: { ...command.placement },
        lifecycle: 'active',
      };
      return null;
    }
    case 'receive-stock': {
      if (hasId(state, command.id))
        return failure('ID_ALREADY_EXISTS', 'That inventory identifier already exists.');
      const vessel = state.vessels[command.vesselId];
      if (!vessel) return failure('VESSEL_NOT_FOUND', 'The receiving vessel does not exist.');
      if (vessel.lifecycle === 'disposed')
        return failure('VESSEL_DISPOSED', 'Stock cannot be received into a disposed vessel.');
      if (Object.values(state.stocks).some((stock) => stock.vesselId === vessel.id))
        return failure('STOCK_ALREADY_PRESENT', 'This version supports one stock per vessel.');
      const quantity = normalizeInventoryQuantity(command.quantity);
      const capacity = inventoryCapacityFailure(vessel, quantity);
      if (capacity) return capacity;
      state.stocks[command.id] = {
        id: command.id,
        source: { kind: 'unattributed', rootStockId: command.id },
        vesselId: command.vesselId,
        materialId: command.materialId,
        quantity,
        quality: command.quality,
        composition: { kind: 'unknown' },
      };
      return null;
    }
    case 'move-storage':
    case 'move-vessel': {
      const item: InventoryPhysicalItem = {
        kind: command.kind === 'move-storage' ? 'storage' : 'vessel',
        id: command.id,
      };
      const record = itemRecord(state, item);
      if ('ok' in record) return record;
      const removal = removalFailure(state, item, record, false);
      if (removal) return removal;
      const invalid = placementFailure(state, item, command.placement);
      if (invalid) return invalid;
      placeItem(state, item, record, command.placement);
      return null;
    }
    case 'consume':
    case 'reconcile':
    case 'set-quality': {
      const stock = state.stocks[command.stockId];
      if (!stock) return failure('STOCK_NOT_FOUND', 'The physical stock does not exist.');
      const vessel = stockVessel(state, stock);
      if ('ok' in vessel) return vessel;
      if (command.kind === 'set-quality') {
        state.stocks[stock.id] = { ...stock, quality: command.quality };
        return null;
      }
      if (command.kind === 'reconcile') {
        const capacity = inventoryCapacityFailure(vessel, command.quantity);
        if (capacity) return capacity;
        state.stocks[stock.id] = {
          ...stock,
          quantity: normalizeInventoryQuantity(command.quantity),
        };
        return null;
      }
      const result = inventoryWithdrawalResult(stock, vessel, command.quantity);
      if ('ok' in result) return result;
      state.stocks[stock.id] = { ...stock, quantity: result.quantity };
      return null;
    }
    case 'dispose-vessel': {
      const item: InventoryPhysicalItem = { kind: 'vessel', id: command.id };
      const record = itemRecord(state, item);
      if ('ok' in record) return record;
      const removal = removalFailure(state, item, record, true);
      if (removal) return removal;
      state.vessels[record.id] = {
        ...(record as InventoryVessel),
        lifecycle: 'disposed',
        placement: { kind: 'unplaced' },
      };
      return null;
    }
    case 'dispose-plate': {
      const item: InventoryPhysicalItem = { kind: 'storage', id: command.id };
      const record = itemRecord(state, item);
      if ('ok' in record) return record;
      const plate = record as InventoryStorage;
      if (plate.layout.kind !== 'fixed-well')
        return failure('INCOMPATIBLE_LAYOUT', 'Whole-plate disposal requires a fixed-well plate.');
      const removal = removalFailure(state, item, plate, true);
      if (removal) return removal;
      state.storage[plate.id] = { ...plate, lifecycle: 'disposed', placement: { kind: 'root' } };
      for (const position of inventoryStoragePositions(plate)) {
        const well = state.vessels[inventoryWellId(plate.id, position)];
        state.vessels[well.id] = { ...well, lifecycle: 'disposed' };
      }
      return null;
    }
    case 'push-stack': {
      const stack = state.storage[command.stackId];
      if (!stack) return failure('STORAGE_NOT_FOUND', 'The target stack does not exist.');
      if (stack.lifecycle === 'disposed')
        return failure('STORAGE_DISPOSED', 'The target stack has been disposed.');
      if (stack.layout.kind !== 'stack')
        return failure('INCOMPATIBLE_LAYOUT', 'The target location is not an ordered stack.');
      const record = itemRecord(state, command.item);
      if ('ok' in record) return record;
      if (record.placement.kind === 'located' && record.placement.storageId === stack.id)
        return failure('INVALID_PLACEMENT', 'That item is already in the target stack.');
      const removal = removalFailure(state, command.item, record, true);
      if (removal) return removal;
      const items = inventoryStackItems(state, stack.id);
      if (items.length >= stack.layout.capacity)
        return failure('STACK_FULL', 'The ordered stack has reached its capacity.');
      const placement: InventoryStoragePlacement = {
        kind: 'located',
        storageId: stack.id,
        slotId: String(items.length + 1),
      };
      const invalid = placementFailure(state, command.item, placement, 'stack');
      if (invalid) return invalid;
      placeItem(state, command.item, record, placement);
      return null;
    }
    case 'pop-stack': {
      const stack = state.storage[command.stackId];
      if (!stack) return failure('STORAGE_NOT_FOUND', 'The source stack does not exist.');
      if (stack.layout.kind !== 'stack')
        return failure('INCOMPATIBLE_LAYOUT', 'The source location is not an ordered stack.');
      const record = itemRecord(state, command.item);
      if ('ok' in record) return record;
      const top = inventoryStackItems(state, stack.id).at(-1);
      if (!top || top.kind !== command.item.kind || top.id !== command.item.id)
        return failure(
          'STACK_TOP_REQUIRED',
          'The requested item is not the top item of this stack.'
        );
      const invalid = placementFailure(state, command.item, command.destination);
      if (invalid) return invalid;
      placeItem(state, command.item, record, command.destination);
      return null;
    }
    default:
      return failure('INVALID_INVENTORY_INPUT', 'Unsupported inventory command.');
  }
}

export function applyInventoryCommandBatch(
  state: InventoryState,
  batch: InventoryCommandBatch,
  context?: InventoryExecutionContext
): InventoryTransition {
  try {
    batch = parseInventoryCommandBatch(batch);
    if (context !== undefined) context = parseInventoryExecutionContext(context);
  } catch (error) {
    if (error instanceof InventoryValidationError)
      return failure('INVALID_INVENTORY_INPUT', error.message);
    throw error;
  }
  if (state.revision !== batch.expectedRevision)
    return failure(
      'REVISION_CONFLICT',
      'The inventory changed. Inspect it before submitting another command.'
    );
  if (state.revision === Number.MAX_SAFE_INTEGER)
    return failure('REVISION_EXHAUSTED', 'The inventory revision cannot advance safely.');
  if (context && context.at < state.lastRecordedAt)
    return failure('CLOCK_REGRESSION', 'The trusted timestamp precedes the inventory clock floor.');
  const draft: Draft = {
    lastRecordedAt: context?.at ?? state.lastRecordedAt,
    storage: Object.assign(Object.create(null) as Record<string, InventoryStorage>, state.storage),
    vessels: Object.assign(Object.create(null) as Record<string, InventoryVessel>, state.vessels),
    stocks: Object.assign(Object.create(null) as Record<string, InventoryStock>, state.stocks),
    lots: Object.assign(Object.create(null) as Record<string, InventoryLot>, state.lots),
    reservations: Object.assign(
      Object.create(null) as Record<string, InventoryReservation>,
      state.reservations
    ),
  };
  try {
    for (const command of batch.commands) {
      const invalid = applyCommand(draft, command, context);
      if (invalid) return invalid;
    }
  } catch (error) {
    if (error instanceof TypeError) return failure('INVALID_QUANTITY', error.message);
    throw error;
  }
  return { ok: true, state: { ...state, revision: state.revision + 1, ...draft } };
}
