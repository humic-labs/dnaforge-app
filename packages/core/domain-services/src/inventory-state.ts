import {
  MAX_INVENTORY_BATCH_COMMANDS,
  type InventoryCommand,
  type InventoryCommandBatch,
  type InventoryErrorCode,
  type InventoryState,
  type InventoryStock,
  type InventoryStorage,
  type InventoryStoragePlacement,
  type InventoryTransition,
  type InventoryVessel,
  type InventoryVesselPlacement,
} from './inventory';
import { normalizeInventoryQuantity, subtractInventoryVolume } from './inventory-volume';
import { InventoryValidationError, parseInventoryCommandBatch } from './inventory-validation';

type Failure = Extract<InventoryTransition, { ok: false }>;
interface Draft {
  storage: Record<string, InventoryStorage>;
  vessels: Record<string, InventoryVessel>;
  stocks: Record<string, InventoryStock>;
}

function failure(code: InventoryErrorCode, message: string): Failure {
  return { ok: false, code, message };
}

function hasId(state: Draft, id: string): boolean {
  return [state.storage, state.vessels, state.stocks].some((rows) => Object.hasOwn(rows, id));
}

function placementFailure(
  state: Draft,
  movingId: string,
  placement: InventoryStoragePlacement | InventoryVesselPlacement
): Failure | null {
  if (placement.kind !== 'located') return null;
  const parent = state.storage[placement.storageId];
  if (!parent)
    return failure('STORAGE_NOT_FOUND', 'The destination storage location does not exist.');
  if (!parent.slots.includes(placement.slotId))
    return failure(
      'INVALID_PLACEMENT',
      'The destination slot does not exist in that storage location.'
    );
  let ancestor: InventoryStorage | undefined = parent;
  while (ancestor) {
    if (ancestor.id === movingId)
      return failure(
        'CONTAINMENT_CYCLE',
        'A storage location cannot contain itself or its ancestor.'
      );
    ancestor =
      ancestor.placement.kind === 'located'
        ? state.storage[ancestor.placement.storageId]
        : undefined;
  }
  const samePosition = (item: InventoryStorage | InventoryVessel): boolean =>
    item.id !== movingId &&
    item.placement.kind === 'located' &&
    item.placement.storageId === placement.storageId &&
    item.placement.slotId === placement.slotId;
  if ([...Object.values(state.storage), ...Object.values(state.vessels)].some(samePosition))
    return failure('SLOT_OCCUPIED', 'The destination slot is occupied.');
  return null;
}

function stockVessel(state: Draft, stock: InventoryStock): InventoryVessel | Failure {
  const vessel = state.vessels[stock.vesselId];
  if (!vessel) return failure('VESSEL_NOT_FOUND', 'The stock vessel does not exist.');
  return vessel.lifecycle === 'disposed'
    ? failure('VESSEL_DISPOSED', 'Disposed vessels cannot be used or changed.')
    : vessel;
}

function applyCommand(state: Draft, command: InventoryCommand): Failure | null {
  switch (command.kind) {
    case 'create-storage': {
      if (hasId(state, command.id))
        return failure('ID_ALREADY_EXISTS', 'That inventory identifier already exists.');
      const invalid = placementFailure(state, command.id, command.placement);
      if (invalid) return invalid;
      state.storage[command.id] = {
        id: command.id,
        name: command.name,
        slots: [...command.slots],
        placement: { ...command.placement },
      };
      return null;
    }
    case 'create-vessel': {
      if (hasId(state, command.id))
        return failure('ID_ALREADY_EXISTS', 'That inventory identifier already exists.');
      const invalid = placementFailure(state, command.id, command.placement);
      if (invalid) return invalid;
      state.vessels[command.id] = {
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
      state.stocks[command.id] = {
        id: command.id,
        vesselId: command.vesselId,
        materialId: command.materialId,
        quantity: normalizeInventoryQuantity(command.quantity),
        quality: command.quality,
      };
      return null;
    }
    case 'move-storage': {
      const item = state.storage[command.id];
      if (!item) return failure('STORAGE_NOT_FOUND', 'The storage location does not exist.');
      const invalid = placementFailure(state, item.id, command.placement);
      if (invalid) return invalid;
      state.storage[item.id] = { ...item, placement: { ...command.placement } };
      return null;
    }
    case 'move-vessel': {
      const item = state.vessels[command.id];
      if (!item) return failure('VESSEL_NOT_FOUND', 'The vessel does not exist.');
      if (item.lifecycle === 'disposed')
        return failure('VESSEL_DISPOSED', 'Disposed vessels cannot be moved.');
      const invalid = placementFailure(state, item.id, command.placement);
      if (invalid) return invalid;
      state.vessels[item.id] = { ...item, placement: { ...command.placement } };
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
        state.stocks[stock.id] = {
          ...stock,
          quantity: normalizeInventoryQuantity(command.quantity),
        };
        return null;
      }
      if (stock.quality === 'quarantined')
        return failure('STOCK_QUARANTINED', 'Quarantined stock must be released before use.');
      if (stock.quantity.kind === 'unknown')
        return failure(
          'QUANTITY_UNKNOWN',
          'Measure and reconcile an unknown stock quantity before use.'
        );
      const result = subtractInventoryVolume(stock.quantity, command.quantity);
      if (result.kind === 'non-positive')
        return failure('INVALID_QUANTITY', 'Consumption requires a positive volume.');
      if (result.kind === 'insufficient')
        return failure('INSUFFICIENT_QUANTITY', 'The stock does not contain the requested volume.');
      state.stocks[stock.id] = { ...stock, quantity: { kind: 'known', ...result.quantity } };
      return null;
    }
    case 'dispose-vessel': {
      const vessel = state.vessels[command.id];
      if (!vessel) return failure('VESSEL_NOT_FOUND', 'The vessel does not exist.');
      if (vessel.lifecycle === 'disposed')
        return failure('VESSEL_DISPOSED', 'The vessel has already been disposed.');
      state.vessels[vessel.id] = {
        ...vessel,
        lifecycle: 'disposed',
        placement: { kind: 'unplaced' },
      };
      return null;
    }
  }
}

export function applyInventoryCommandBatch(
  state: InventoryState,
  batch: InventoryCommandBatch
): InventoryTransition {
  try {
    batch = parseInventoryCommandBatch(batch);
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
  if (batch.commands.length === 0 || batch.commands.length > MAX_INVENTORY_BATCH_COMMANDS)
    return failure(
      'INVALID_INVENTORY_INPUT',
      'An inventory batch requires a bounded, non-empty command list.'
    );
  const draft: Draft = {
    storage: Object.assign(Object.create(null) as Record<string, InventoryStorage>, state.storage),
    vessels: Object.assign(Object.create(null) as Record<string, InventoryVessel>, state.vessels),
    stocks: Object.assign(Object.create(null) as Record<string, InventoryStock>, state.stocks),
  };
  try {
    for (const command of batch.commands) {
      const invalid = applyCommand(draft, command);
      if (invalid) return invalid;
    }
  } catch (error) {
    if (error instanceof TypeError) return failure('INVALID_QUANTITY', error.message);
    throw error;
  }
  return { ok: true, state: { ...state, revision: state.revision + 1, ...draft } };
}
