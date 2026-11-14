import {
  INVENTORY_SCHEMA,
  INVENTORY_VOLUME_UNITS,
  MAX_INVENTORY_BATCH_COMMANDS,
  MAX_INVENTORY_STORAGE_SLOTS,
  type InventoryCommand,
  type InventoryCommandBatch,
  type InventoryLocatedPlacement,
  type InventoryQuality,
  type InventoryQuantity,
  type InventoryState,
  type InventoryStock,
  type InventoryStorage,
  type InventoryStoragePlacement,
  type InventoryVessel,
  type InventoryVesselPlacement,
  type InventoryVolume,
  type InventoryVolumeUnit,
} from './inventory';
import { normalizeInventoryVolume } from './inventory-volume';

export class InventoryValidationError extends TypeError {
  readonly code = 'INVALID_INVENTORY_INPUT';

  constructor(message: string) {
    super(message);
    this.name = 'InventoryValidationError';
  }
}

function invalid(message: string): never {
  throw new InventoryValidationError(message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid(`${label} requires an object.`);
  return value as Record<string, unknown>;
}

function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const row = object(value, label);
  if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key)))
    return invalid(`${label} requires exactly these fields: ${keys.join(', ')}.`);
  return row;
}

function text(value: unknown, label: string, maxLength = 512): string {
  if (
    typeof value !== 'string' ||
    value.length > maxLength ||
    value.trim().length === 0 ||
    value.includes('\0')
  )
    return invalid(`${label} requires non-empty text with at most ${maxLength} characters.`);
  return value;
}

function identifier(value: unknown, label: string): string {
  const id = text(value, label);
  if (id.trim() !== id) return invalid(`${label} cannot have surrounding whitespace.`);
  return id;
}

function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    return invalid('An inventory revision requires a non-negative safe integer.');
  return value;
}

function quality(value: unknown): InventoryQuality {
  if (value !== 'usable' && value !== 'quarantined')
    return invalid('Stock quality must be usable or quarantined.');
  return value;
}

function slots(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_INVENTORY_STORAGE_SLOTS)
    return invalid(`Storage requires at most ${MAX_INVENTORY_STORAGE_SLOTS} named slots.`);
  const names = value.map((slot) => identifier(slot, 'Slot identifier'));
  if (new Set(names).size !== names.length)
    return invalid('A storage location cannot repeat a slot identifier.');
  return names;
}

function located(value: unknown): InventoryLocatedPlacement {
  const row = exact(value, ['kind', 'storageId', 'slotId'], 'Located placement');
  if (row.kind !== 'located') return invalid('A located placement requires kind located.');
  return {
    kind: 'located',
    storageId: identifier(row.storageId, 'Parent storage identifier'),
    slotId: identifier(row.slotId, 'Slot identifier'),
  };
}

function storagePlacement(value: unknown): InventoryStoragePlacement {
  const row = object(value, 'Storage placement');
  if (row.kind === 'root') {
    exact(row, ['kind'], 'Root placement');
    return { kind: 'root' };
  }
  return located(row);
}

function vesselPlacement(value: unknown): InventoryVesselPlacement {
  const row = object(value, 'Vessel placement');
  if (row.kind === 'unplaced') {
    exact(row, ['kind'], 'Unplaced vessel');
    return { kind: 'unplaced' };
  }
  return located(row);
}

function volume(value: unknown, hasKind = false): InventoryVolume {
  const row = exact(value, hasKind ? ['kind', 'value', 'unit'] : ['value', 'unit'], 'Volume');
  if (
    typeof row.unit !== 'string' ||
    !(INVENTORY_VOLUME_UNITS as readonly string[]).includes(row.unit) ||
    typeof row.value !== 'string'
  )
    return invalid('Volume requires a decimal string and one supported unit: L, mL, uL, nL.');
  const parsed = { value: row.value, unit: row.unit as InventoryVolumeUnit };
  try {
    normalizeInventoryVolume(parsed);
  } catch (error) {
    return invalid(error instanceof Error ? error.message : 'Invalid inventory volume.');
  }
  return parsed;
}

function quantity(value: unknown, canonical = false): InventoryQuantity {
  const row = object(value, 'Stock quantity');
  if (row.kind === 'unknown') {
    exact(row, ['kind'], 'Unknown quantity');
    return { kind: 'unknown' };
  }
  if (row.kind !== 'known') return invalid('Stock quantity must be explicitly known or unknown.');
  const parsed = volume(row, true);
  const normalized = normalizeInventoryVolume(parsed);
  if (canonical && (parsed.unit !== normalized.unit || parsed.value !== normalized.value))
    return invalid('Stored inventory quantities require canonical uL decimal values.');
  return { kind: 'known', ...parsed };
}

export function parseInventoryCommand(value: unknown): InventoryCommand {
  const row = object(value, 'Inventory command');
  switch (row.kind) {
    case 'create-storage': {
      exact(row, ['kind', 'id', 'name', 'slots', 'placement'], 'Create storage command');
      return {
        kind: 'create-storage',
        id: identifier(row.id, 'Storage identifier'),
        name: text(row.name, 'Storage name'),
        slots: slots(row.slots),
        placement: storagePlacement(row.placement),
      };
    }
    case 'create-vessel': {
      exact(row, ['kind', 'id', 'name', 'placement'], 'Create vessel command');
      return {
        kind: 'create-vessel',
        id: identifier(row.id, 'Vessel identifier'),
        name: text(row.name, 'Vessel name'),
        placement: vesselPlacement(row.placement),
      };
    }
    case 'receive-stock': {
      exact(
        row,
        ['kind', 'id', 'vesselId', 'materialId', 'quantity', 'quality'],
        'Receive stock command'
      );
      return {
        kind: 'receive-stock',
        id: identifier(row.id, 'Stock identifier'),
        vesselId: identifier(row.vesselId, 'Vessel identifier'),
        materialId: identifier(row.materialId, 'Material identifier'),
        quantity: quantity(row.quantity),
        quality: quality(row.quality),
      };
    }
    case 'move-storage': {
      exact(row, ['kind', 'id', 'placement'], 'Move storage command');
      return {
        kind: 'move-storage',
        id: identifier(row.id, 'Storage identifier'),
        placement: storagePlacement(row.placement),
      };
    }
    case 'move-vessel': {
      exact(row, ['kind', 'id', 'placement'], 'Move vessel command');
      return {
        kind: 'move-vessel',
        id: identifier(row.id, 'Vessel identifier'),
        placement: vesselPlacement(row.placement),
      };
    }
    case 'consume': {
      exact(row, ['kind', 'stockId', 'quantity', 'reason'], 'Consume command');
      return {
        kind: 'consume',
        stockId: identifier(row.stockId, 'Stock identifier'),
        quantity: volume(row.quantity),
        reason: text(row.reason, 'Consumption reason', 2_000),
      };
    }
    case 'reconcile': {
      exact(row, ['kind', 'stockId', 'quantity', 'reason'], 'Reconcile command');
      return {
        kind: 'reconcile',
        stockId: identifier(row.stockId, 'Stock identifier'),
        quantity: quantity(row.quantity),
        reason: text(row.reason, 'Reconciliation reason', 2_000),
      };
    }
    case 'set-quality': {
      exact(row, ['kind', 'stockId', 'quality', 'reason'], 'Quality command');
      return {
        kind: 'set-quality',
        stockId: identifier(row.stockId, 'Stock identifier'),
        quality: quality(row.quality),
        reason: text(row.reason, 'Quality reason', 2_000),
      };
    }
    case 'dispose-vessel': {
      exact(row, ['kind', 'id', 'reason'], 'Disposal command');
      return {
        kind: 'dispose-vessel',
        id: identifier(row.id, 'Vessel identifier'),
        reason: text(row.reason, 'Disposal reason', 2_000),
      };
    }
    default:
      return invalid('Unsupported inventory command.');
  }
}

export function parseInventoryCommandBatch(value: unknown): InventoryCommandBatch {
  const row = exact(value, ['expectedRevision', 'commands'], 'Inventory command batch');
  if (
    !Array.isArray(row.commands) ||
    row.commands.length === 0 ||
    row.commands.length > MAX_INVENTORY_BATCH_COMMANDS
  )
    return invalid(`An inventory batch requires 1 to ${MAX_INVENTORY_BATCH_COMMANDS} commands.`);
  return {
    expectedRevision: revision(row.expectedRevision),
    commands: row.commands.map(parseInventoryCommand),
  };
}

function storageRecord(value: unknown): InventoryStorage {
  const row = exact(value, ['id', 'name', 'slots', 'placement'], 'Storage record');
  return {
    id: identifier(row.id, 'Storage identifier'),
    name: text(row.name, 'Storage name'),
    slots: slots(row.slots),
    placement: storagePlacement(row.placement),
  };
}

function vesselRecord(value: unknown): InventoryVessel {
  const row = exact(value, ['id', 'name', 'placement', 'lifecycle'], 'Vessel record');
  if (row.lifecycle !== 'active' && row.lifecycle !== 'disposed')
    return invalid('Vessel lifecycle must be active or disposed.');
  return {
    id: identifier(row.id, 'Vessel identifier'),
    name: text(row.name, 'Vessel name'),
    placement: vesselPlacement(row.placement),
    lifecycle: row.lifecycle,
  };
}

function stockRecord(value: unknown): InventoryStock {
  const row = exact(value, ['id', 'vesselId', 'materialId', 'quantity', 'quality'], 'Stock record');
  return {
    id: identifier(row.id, 'Stock identifier'),
    vesselId: identifier(row.vesselId, 'Vessel identifier'),
    materialId: identifier(row.materialId, 'Material identifier'),
    quantity: quantity(row.quantity, true),
    quality: quality(row.quality),
  };
}

function records<T extends { readonly id: string }>(
  value: unknown,
  parse: (record: unknown) => T
): Record<string, T> {
  const parsed = Object.create(null) as Record<string, T>;
  for (const [key, raw] of Object.entries(object(value, 'Inventory records'))) {
    const row = parse(raw);
    if (row.id !== key) return invalid('An inventory map key must match its record identifier.');
    parsed[key] = row;
  }
  return parsed;
}

function validateState(state: InventoryState): void {
  const allIds = new Set<string>();
  for (const rows of [state.storage, state.vessels, state.stocks]) {
    for (const id of Object.keys(rows)) {
      if (allIds.has(id)) invalid('Inventory record identifiers must be distinct.');
      allIds.add(id);
    }
  }
  const occupied = new Map<string, Set<string>>();
  for (const item of [...Object.values(state.storage), ...Object.values(state.vessels)]) {
    if ('lifecycle' in item && item.lifecycle === 'disposed' && item.placement.kind !== 'unplaced')
      invalid('A disposed vessel cannot occupy a storage slot.');
    if (item.placement.kind !== 'located') continue;
    const parent = state.storage[item.placement.storageId];
    if (!parent || !parent.slots.includes(item.placement.slotId))
      invalid('Every placement must name an existing storage location and slot.');
    const slots = occupied.get(parent.id) ?? new Set<string>();
    if (slots.has(item.placement.slotId)) invalid('An inventory slot cannot have two occupants.');
    slots.add(item.placement.slotId);
    occupied.set(parent.id, slots);
  }
  for (const location of Object.values(state.storage)) {
    const visited = new Set<string>();
    let ancestor: InventoryStorage | undefined = location;
    while (ancestor) {
      if (visited.has(ancestor.id)) invalid('Storage containment must not contain a cycle.');
      visited.add(ancestor.id);
      ancestor =
        ancestor.placement.kind === 'located'
          ? state.storage[ancestor.placement.storageId]
          : undefined;
    }
  }
  const stockVessels = new Set<string>();
  for (const stock of Object.values(state.stocks)) {
    if (!Object.hasOwn(state.vessels, stock.vesselId))
      invalid('Every stock must reference an existing vessel.');
    if (stockVessels.has(stock.vesselId)) invalid('This version supports one stock per vessel.');
    stockVessels.add(stock.vesselId);
  }
}

export function parseInventoryState(value: unknown): InventoryState {
  const row = exact(
    value,
    ['schema', 'revision', 'storage', 'vessels', 'stocks'],
    'Inventory state'
  );
  if (row.schema !== INVENTORY_SCHEMA) return invalid('Unsupported inventory state schema.');
  const state: InventoryState = {
    schema: INVENTORY_SCHEMA,
    revision: revision(row.revision),
    storage: records(row.storage, storageRecord),
    vessels: records(row.vessels, vesselRecord),
    stocks: records(row.stocks, stockRecord),
  };
  validateState(state);
  return state;
}
