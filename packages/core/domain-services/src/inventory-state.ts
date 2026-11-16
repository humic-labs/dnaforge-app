import { applyInventoryObservationCommand } from './inventory-observations';
import {
  applyInventoryConfigurationCommand,
  inventoryRecordIdExists,
  inventoryConfigurationAccess,
} from './inventory-configuration';
import { emptyInventoryPhysicalConfiguration } from './inventory-geometry';
import {
  inventoryPhysicalRecord,
  inventoryRemovalFailure,
  inventoryPlacementFailure,
  placeInventoryItem,
} from './inventory-placement';
import { applyInventoryCustodyCommand, inventoryCustodyGuard } from './inventory-custody';
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
import { applyInventoryItemCodeCommand } from './inventory-item-codes';
import { applyInventoryTemperatureCommand } from './inventory-storage-conditions';
import { applyInventoryContentsCommand, inventoryVesselStockAdmission } from './inventory-contents';

type Failure = Extract<InventoryTransition, { ok: false }>;
interface Draft {
  vesselBindings: InventoryState['vesselBindings'];
  hierarchyBindings: InventoryState['hierarchyBindings'];
  observations: Record<string, InventoryState['observations'][string]>;
  origin: InventoryState['origin'];
  tableBindings: InventoryState['tableBindings'];
  thermalContexts: Record<string, InventoryState['thermalContexts'][string]>;
  temperatureClaims: Record<string, InventoryState['temperatureClaims'][string]>;
  equipmentSetpoints: Record<string, InventoryState['equipmentSetpoints'][string]>;
  storageRequirements: Record<string, InventoryState['storageRequirements'][string]>;
  itemCodes: Record<string, InventoryState['itemCodes'][string]>;
  typeVersions: Record<string, InventoryState['typeVersions'][string]>;
  recipeVersions: Record<string, InventoryState['recipeVersions'][string]>;
  fitEvidence: Record<string, InventoryState['fitEvidence'][string]>;
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
  return inventoryRecordIdExists(state, id);
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
  const invalid = inventoryPlacementFailure(
    state,
    { kind: 'storage', id: command.id },
    command.placement
  );
  if (invalid) return invalid;
  const storage: InventoryStorage = {
    custody: { kind: 'available' },
    id: command.id,
    name: command.name,
    layout:
      command.layout.kind === 'named'
        ? { kind: 'named', slots: [...command.layout.slots] }
        : { ...command.layout },
    placement: { ...command.placement },
    lifecycle: 'active',
    configuration: emptyInventoryPhysicalConfiguration(),
  };
  state.storage[storage.id] = storage;
  if (storage.layout.kind === 'fixed-well') {
    for (const position of inventoryStoragePositions(storage)) {
      const id = inventoryWellId(storage.id, position);
      if (hasId(state, id))
        return failure('ID_ALREADY_EXISTS', 'A permanent well identifier already exists.');
      state.vessels[id] = {
        contentsKnowledge: { kind: 'recorded' },
        kind: 'fixed-well',
        limits: unknownInventoryVesselLimits(),
        id,
        name: position,
        placement: { kind: 'located', storageId: storage.id, slotId: position },
        lifecycle: 'active',
        configuration: emptyInventoryPhysicalConfiguration(),
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
  const observation = applyInventoryObservationCommand(state, command, context, (inner) =>
    applyCommand(state, inner, context)
  );
  if (observation !== undefined) return observation;
  const temperature = applyInventoryTemperatureCommand(state, command, context);
  if (temperature !== undefined) return temperature;
  const itemCode = applyInventoryItemCodeCommand(state, command, context);
  if (itemCode !== undefined) return itemCode;
  const configuration = applyInventoryConfigurationCommand(state, command, context, (inner) =>
    applyCommand(state, inner, context)
  );
  if (configuration !== undefined) return configuration;
  const custody = applyInventoryCustodyCommand(state, command, context);
  if (custody !== undefined) return custody;
  const reservation = applyInventoryReservationCommand(state, command, context);
  if (reservation !== undefined) return reservation;
  if (command.kind === 'fulfill-reservations') {
    const invalid = prepareInventoryFulfillment(state, command, context);
    return invalid ?? applyCommand(state, command.withdrawal, context);
  }
  const configurationAccess = inventoryConfigurationAccess(state, command);
  if (configurationAccess) return configurationAccess;
  const physical = inventoryCustodyGuard(state, command, context);
  if (physical) return physical;
  const reserved = inventoryReservationGuard(state, command, context);
  if (reserved) return reserved;
  const contents = applyInventoryContentsCommand(state, command, context);
  if (contents !== undefined) return contents;
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
      const invalid = inventoryPlacementFailure(
        state,
        { kind: 'vessel', id: command.id },
        command.placement
      );
      if (invalid) return invalid;
      state.vessels[command.id] = {
        contentsKnowledge: { kind: 'recorded' },
        kind: 'movable',
        custody: { kind: 'available' },
        limits: unknownInventoryVesselLimits(),
        id: command.id,
        name: command.name,
        placement: { ...command.placement },
        lifecycle: 'active',
        configuration: emptyInventoryPhysicalConfiguration(),
      };
      return null;
    }
    case 'receive-stock':
    case 'identify-vessel-stock': {
      if (command.kind === 'identify-vessel-stock' && !context)
        return failure(
          'CONTEXT_REQUIRED',
          'Identifying existing contents requires a trusted actor and clock.'
        );
      if (hasId(state, command.id))
        return failure('ID_ALREADY_EXISTS', 'That inventory identifier already exists.');
      const vessel = inventoryVesselStockAdmission(
        state,
        command.vesselId,
        command.kind === 'identify-vessel-stock' ? 'identify' : 'receive'
      );
      if ('ok' in vessel) return vessel;
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
      if (command.kind === 'identify-vessel-stock')
        state.vessels[vessel.id] = { ...vessel, contentsKnowledge: { kind: 'recorded' } };
      return null;
    }
    case 'move-storage':
    case 'move-vessel': {
      const item: InventoryPhysicalItem = {
        kind: command.kind === 'move-storage' ? 'storage' : 'vessel',
        id: command.id,
      };
      const record = inventoryPhysicalRecord(state, item);
      if ('ok' in record) return record;
      const removal = inventoryRemovalFailure(state, item, record, false);
      if (removal) return removal;
      const invalid = inventoryPlacementFailure(state, item, command.placement);
      if (invalid) return invalid;
      placeInventoryItem(state, item, record, command.placement);
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
      const record = inventoryPhysicalRecord(state, item);
      if ('ok' in record) return record;
      const removal = inventoryRemovalFailure(state, item, record, true);
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
      const record = inventoryPhysicalRecord(state, item);
      if ('ok' in record) return record;
      const plate = record as InventoryStorage;
      if (plate.layout.kind !== 'fixed-well')
        return failure('INCOMPATIBLE_LAYOUT', 'Whole-plate disposal requires a fixed-well plate.');
      const removal = inventoryRemovalFailure(state, item, plate, true);
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
      const record = inventoryPhysicalRecord(state, command.item);
      if ('ok' in record) return record;
      if (record.placement.kind === 'located' && record.placement.storageId === stack.id)
        return failure('INVALID_PLACEMENT', 'That item is already in the target stack.');
      const removal = inventoryRemovalFailure(state, command.item, record, true);
      if (removal) return removal;
      const items = inventoryStackItems(state, stack.id);
      if (items.length >= stack.layout.capacity)
        return failure('STACK_FULL', 'The ordered stack has reached its capacity.');
      const placement: InventoryStoragePlacement = {
        kind: 'located',
        storageId: stack.id,
        slotId: String(items.length + 1),
      };
      const invalid = inventoryPlacementFailure(state, command.item, placement, 'stack');
      if (invalid) return invalid;
      placeInventoryItem(state, command.item, record, placement);
      return null;
    }
    case 'pop-stack': {
      const stack = state.storage[command.stackId];
      if (!stack) return failure('STORAGE_NOT_FOUND', 'The source stack does not exist.');
      if (stack.layout.kind !== 'stack')
        return failure('INCOMPATIBLE_LAYOUT', 'The source location is not an ordered stack.');
      const record = inventoryPhysicalRecord(state, command.item);
      if ('ok' in record) return record;
      const top = inventoryStackItems(state, stack.id).at(-1);
      if (!top || top.kind !== command.item.kind || top.id !== command.item.id)
        return failure(
          'STACK_TOP_REQUIRED',
          'The requested item is not the top item of this stack.'
        );
      const invalid = inventoryPlacementFailure(state, command.item, command.destination);
      if (invalid) return invalid;
      placeInventoryItem(state, command.item, record, command.destination);
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
    vesselBindings: state.vesselBindings,
    hierarchyBindings: state.hierarchyBindings,
    origin: state.origin,
    observations: Object.assign(Object.create(null), state.observations),
    tableBindings: state.tableBindings,
    thermalContexts: Object.assign(Object.create(null), state.thermalContexts),
    temperatureClaims: Object.assign(Object.create(null), state.temperatureClaims),
    equipmentSetpoints: Object.assign(Object.create(null), state.equipmentSetpoints),
    storageRequirements: Object.assign(Object.create(null), state.storageRequirements),
    itemCodes: Object.assign(Object.create(null), state.itemCodes),
    typeVersions: Object.assign(Object.create(null), state.typeVersions),
    recipeVersions: Object.assign(Object.create(null), state.recipeVersions),
    fitEvidence: Object.assign(Object.create(null), state.fitEvidence),
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
