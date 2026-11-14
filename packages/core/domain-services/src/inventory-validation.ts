import {
  INVENTORY_SCHEMA,
  LEGACY_INVENTORY_SCHEMA,
  INVENTORY_VOLUME_UNITS,
  MAX_INVENTORY_BATCH_COMMANDS,
  MAX_INVENTORY_STORAGE_SLOTS,
  type InventoryCommand,
  type InventoryCommandBatch,
  type InventoryLayout,
  type InventoryQuantity,
  type InventoryState,
  type InventoryStock,
  type InventoryStorage,
  type InventoryVessel,
  type InventoryVolume,
} from './inventory-types';
import {
  inventoryStackItems,
  inventoryStoragePositions,
  inventoryWellId,
} from './inventory-layout';
import { normalizeInventoryVolume } from './inventory-volume';

export class InventoryValidationError extends TypeError {
  readonly code = 'INVALID_INVENTORY_INPUT';

  constructor(message: string) {
    super(message);
    this.name = 'InventoryValidationError';
  }
}

type JsonSchema = Readonly<Record<string, unknown>>;
interface Codec<T> {
  readonly schema: JsonSchema;
  parse(value: unknown): T;
}
type ParsedFields<T extends Record<string, Codec<unknown>>> = {
  [K in keyof T]: T[K] extends Codec<infer V> ? V : never;
};

function invalid(message: string): never {
  throw new InventoryValidationError(message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid(`${label} requires an object.`);
  return value as Record<string, unknown>;
}

function fields<T extends Record<string, Codec<unknown>>>(
  label: string,
  properties: T
): Codec<ParsedFields<T>> {
  const keys = Object.keys(properties);
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: keys,
      properties: Object.fromEntries(keys.map((key) => [key, properties[key].schema])),
    },
    parse(value) {
      const row = object(value, label);
      if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key)))
        return invalid(`${label} requires exactly these fields: ${keys.join(', ')}.`);
      return Object.fromEntries(
        keys.map((key) => [key, properties[key].parse(row[key])])
      ) as ParsedFields<T>;
    },
  };
}

function literal<const T extends string>(value: T): Codec<T> {
  return {
    schema: { type: 'string', const: value },
    parse(input) {
      if (input !== value) return invalid(`Expected ${value}.`);
      return value;
    },
  };
}

function text(label: string, maxLength = 512, trim = false): Codec<string> {
  return {
    schema: { type: 'string', minLength: 1, maxLength, pattern: '\\S' },
    parse(value) {
      if (
        typeof value !== 'string' ||
        value.length > maxLength ||
        !value.trim() ||
        value.includes('\0')
      )
        return invalid(`${label} requires non-empty text with at most ${maxLength} characters.`);
      if (trim && value.trim() !== value)
        return invalid(`${label} cannot have surrounding whitespace.`);
      return value;
    },
  };
}

function integer(label: string, minimum: number, maximum: number): Codec<number> {
  return {
    schema: { type: 'integer', minimum, maximum },
    parse(value) {
      if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < minimum ||
        value > maximum
      )
        return invalid(`${label} requires a safe integer from ${minimum} to ${maximum}.`);
      return value;
    },
  };
}

function array<T>(
  element: Codec<T>,
  maximum: number,
  minimum = 0,
  unique = false
): Codec<readonly T[]> {
  return {
    schema: {
      type: 'array',
      items: element.schema,
      minItems: minimum,
      maxItems: maximum,
      ...(unique ? { uniqueItems: true } : {}),
    },
    parse(value) {
      if (!Array.isArray(value) || value.length < minimum || value.length > maximum)
        return invalid(`An inventory list requires ${minimum} to ${maximum} items.`);
      const result = value.map((item) => element.parse(item));
      if (unique && new Set(result).size !== result.length)
        return invalid('Inventory identifiers cannot repeat within this list.');
      return result;
    },
  };
}

function union<const T extends readonly Codec<unknown>[]>(
  label: string,
  variants: T
): Codec<T[number] extends Codec<infer V> ? V : never> {
  return {
    schema: { oneOf: variants.map((variant) => variant.schema) },
    parse(value) {
      for (const variant of variants) {
        try {
          return variant.parse(value) as T[number] extends Codec<infer V> ? V : never;
        } catch (error) {
          if (!(error instanceof InventoryValidationError)) throw error;
        }
      }
      return invalid(`${label} requires one supported variant.`);
    },
  };
}

function checked<T>(codec: Codec<T>, validate: (value: T) => void): Codec<T> {
  return {
    schema: codec.schema,
    parse(value) {
      const result = codec.parse(value);
      validate(result);
      return result;
    },
  };
}

const id = text('Inventory identifier', 512, true);
const vesselId = text('Vessel identifier', 1_024, true);
const name = text('Inventory name');
const reason = text('Inventory change reason', 2_000);
const slot = text('Slot identifier', 512, true);
const slots = array(slot, MAX_INVENTORY_STORAGE_SLOTS, 0, true);
const revision = integer('Inventory revision', 0, Number.MAX_SAFE_INTEGER);
const quality = union('Stock quality', [literal('usable'), literal('quarantined')]);
const lifecycle = union('Inventory lifecycle', [literal('active'), literal('disposed')]);
const located = fields('Located placement', {
  kind: literal('located'),
  storageId: id,
  slotId: slot,
});
const root = fields('Root placement', { kind: literal('root') });
const unplaced = fields('Unplaced vessel', { kind: literal('unplaced') });
const storagePlacement = union('Storage placement', [root, located]);
const vesselPlacement = union('Vessel placement', [unplaced, located]);
const destination = union('Stack destination', [root, unplaced, located]);
const physicalItem = fields('Physical inventory item', {
  kind: union('Physical item kind', [literal('storage'), literal('vessel')]),
  id,
});
const dimensions = {
  rows: integer('Layout rows', 1, MAX_INVENTORY_STORAGE_SLOTS),
  columns: integer('Layout columns', 1, MAX_INVENTORY_STORAGE_SLOTS),
};
function grid<const T extends 'grid' | 'fixed-well' | 'removable-tube'>(kind: T) {
  return checked(fields('Grid layout', { kind: literal(kind), ...dimensions }), (value) => {
    if (value.rows * value.columns > MAX_INVENTORY_STORAGE_SLOTS)
      invalid(`A layout supports at most ${MAX_INVENTORY_STORAGE_SLOTS} positions.`);
  });
}
const layout: Codec<InventoryLayout> = union('Inventory layout', [
  fields('Named layout', { kind: literal('named'), slots }),
  grid('grid'),
  grid('removable-tube'),
  grid('fixed-well'),
  fields('Ordered stack layout', {
    kind: literal('stack'),
    capacity: integer('Stack capacity', 1, MAX_INVENTORY_STORAGE_SLOTS),
    removal: literal('top-only'),
  }),
]);
const volumeFields = {
  value: checked(text('Decimal volume', 128), (value) => {
    if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value))
      invalid('Volume requires a non-negative decimal string.');
  }),
  unit: union(
    'Volume unit',
    INVENTORY_VOLUME_UNITS.map((value) => literal(value))
  ),
};
function validateVolume(value: InventoryVolume): void {
  try {
    normalizeInventoryVolume(value);
  } catch (error) {
    invalid(error instanceof Error ? error.message : 'Invalid inventory volume.');
  }
}
const volume: Codec<InventoryVolume> = checked(fields('Volume', volumeFields), validateVolume);
const quantity: Codec<InventoryQuantity> = union('Stock quantity', [
  fields('Unknown quantity', { kind: literal('unknown') }),
  checked(fields('Known quantity', { kind: literal('known'), ...volumeFields }), validateVolume),
]);
const storedQuantity = checked(quantity, (value) => {
  if (value.kind === 'unknown') return;
  const normalized = normalizeInventoryVolume(value);
  if (value.unit !== normalized.unit || value.value !== normalized.value)
    invalid('Stored inventory quantities require canonical uL decimal values.');
});

const commands = {
  'create-storage': fields('Create storage command', {
    kind: literal('create-storage'),
    id,
    name,
    slots,
    placement: storagePlacement,
  }),
  'create-layout-storage': fields('Create layout storage command', {
    kind: literal('create-layout-storage'),
    id,
    name,
    layout,
    placement: storagePlacement,
  }),
  'create-vessel': fields('Create vessel command', {
    kind: literal('create-vessel'),
    id,
    name,
    placement: vesselPlacement,
  }),
  'receive-stock': fields('Receive stock command', {
    kind: literal('receive-stock'),
    id,
    vesselId,
    materialId: id,
    quantity,
    quality,
  }),
  'move-storage': fields('Move storage command', {
    kind: literal('move-storage'),
    id,
    placement: storagePlacement,
  }),
  'move-vessel': fields('Move vessel command', {
    kind: literal('move-vessel'),
    id,
    placement: vesselPlacement,
  }),
  consume: fields('Consume command', {
    kind: literal('consume'),
    stockId: id,
    quantity: volume,
    reason,
  }),
  reconcile: fields('Reconcile command', {
    kind: literal('reconcile'),
    stockId: id,
    quantity,
    reason,
  }),
  'set-quality': fields('Quality command', {
    kind: literal('set-quality'),
    stockId: id,
    quality,
    reason,
  }),
  'dispose-vessel': fields('Disposal command', { kind: literal('dispose-vessel'), id, reason }),
  'dispose-plate': fields('Plate disposal command', { kind: literal('dispose-plate'), id, reason }),
  'push-stack': fields('Stack push command', {
    kind: literal('push-stack'),
    stackId: id,
    item: physicalItem,
  }),
  'pop-stack': fields('Stack pop command', {
    kind: literal('pop-stack'),
    stackId: id,
    item: physicalItem,
    destination,
  }),
} satisfies {
  [K in InventoryCommand['kind']]: Codec<Extract<InventoryCommand, { readonly kind: K }>>;
};

export function inventoryCommandJsonSchema(): JsonSchema {
  return structuredClone(commandCodec.schema);
}

export function parseInventoryCommand(value: unknown): InventoryCommand {
  const row = object(value, 'Inventory command');
  if (typeof row.kind !== 'string' || !Object.hasOwn(commands, row.kind))
    return invalid('Unsupported inventory command.');
  return commands[row.kind as keyof typeof commands].parse(row);
}

const commandCodec = {
  schema: { oneOf: Object.values(commands).map((codec) => codec.schema) },
  parse: parseInventoryCommand,
};
const batchCodec = fields('Inventory command batch', {
  expectedRevision: revision,
  commands: array(commandCodec, MAX_INVENTORY_BATCH_COMMANDS, 1),
});

export function parseInventoryCommandBatch(value: unknown): InventoryCommandBatch {
  return batchCodec.parse(value);
}

const stockRecord = fields('Stock record', {
  id,
  vesselId,
  materialId: id,
  quantity: storedQuantity,
  quality,
});
const storageRecord = fields('Storage record', {
  id,
  name,
  layout,
  placement: storagePlacement,
  lifecycle,
});
const vesselRecord = union('Vessel record', [
  fields('Movable vessel record', {
    kind: literal('movable'),
    id,
    name,
    placement: vesselPlacement,
    lifecycle,
  }),
  fields('Permanent well record', {
    kind: literal('fixed-well'),
    id: text('Permanent well identifier', 1_024, true),
    name,
    placement: located,
    lifecycle,
  }),
]);
const legacyStorage = fields('Legacy storage record', {
  id,
  name,
  slots,
  placement: storagePlacement,
});
const legacyVessel = fields('Legacy vessel record', {
  id,
  name,
  placement: vesselPlacement,
  lifecycle,
});

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
  const positionsById = new Map(
    Object.values(state.storage).map((storage) => [
      storage.id,
      new Set(inventoryStoragePositions(storage)),
    ])
  );
  const allIds = new Set<string>();
  for (const rows of [state.storage, state.vessels, state.stocks]) {
    for (const identifier of Object.keys(rows)) {
      if (allIds.has(identifier)) invalid('Inventory record identifiers must be distinct.');
      allIds.add(identifier);
    }
  }
  const occupied = new Map<string, Set<string>>();
  for (const item of [...Object.values(state.storage), ...Object.values(state.vessels)]) {
    const isWell = 'kind' in item && item.kind === 'fixed-well';
    if (
      'layout' in item &&
      item.lifecycle === 'disposed' &&
      (item.layout.kind !== 'fixed-well' || item.placement.kind !== 'root')
    )
      invalid('A disposed plate must be a root record with its permanent wells retained.');
    if (
      'kind' in item &&
      item.lifecycle === 'disposed' &&
      !isWell &&
      item.placement.kind !== 'unplaced'
    )
      invalid('A disposed movable vessel cannot occupy a storage slot.');
    if (isWell && item.placement.kind !== 'located')
      invalid('A permanent well must remain attached to its plate.');
    if (item.placement.kind !== 'located') continue;
    const parent = state.storage[item.placement.storageId];
    if (!parent || !positionsById.get(parent.id)?.has(item.placement.slotId))
      invalid('Every placement must name an existing storage location and position.');
    if (parent.lifecycle === 'disposed' && !(isWell && item.lifecycle === 'disposed'))
      invalid('A disposed storage location cannot hold active objects.');
    if (parent.layout.kind === 'fixed-well') {
      if (
        !isWell ||
        item.id !== inventoryWellId(parent.id, item.placement.slotId) ||
        item.lifecycle !== parent.lifecycle
      )
        invalid('A fixed-well plate can contain only its permanent wells with the same lifecycle.');
    } else if (isWell) {
      invalid('A permanent well cannot leave its owning plate.');
    }
    if (parent.layout.kind === 'removable-tube' && !('kind' in item && item.kind === 'movable'))
      invalid('A removable-tube layout accepts only movable vessels.');
    const positions = occupied.get(parent.id) ?? new Set<string>();
    if (positions.has(item.placement.slotId))
      invalid('An inventory position cannot have two occupants.');
    positions.add(item.placement.slotId);
    occupied.set(parent.id, positions);
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
    if (location.layout.kind === 'fixed-well') {
      for (const position of inventoryStoragePositions(location)) {
        const well = state.vessels[inventoryWellId(location.id, position)];
        if (
          !well ||
          well.kind !== 'fixed-well' ||
          well.placement.kind !== 'located' ||
          well.placement.storageId !== location.id ||
          well.placement.slotId !== position ||
          well.lifecycle !== location.lifecycle
        )
          invalid('Every fixed plate position requires its permanent well.');
      }
    }
    if (location.layout.kind === 'stack') {
      const items = inventoryStackItems(state, location.id);
      for (const [index, item] of items.entries()) {
        const child = item.kind === 'storage' ? state.storage[item.id] : state.vessels[item.id];
        if (child.placement.kind !== 'located' || child.placement.slotId !== String(index + 1))
          invalid('An ordered stack requires a contiguous bottom-to-top occupied prefix.');
      }
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
  const row = object(value, 'Inventory state');
  const shape = fields('Inventory state', {
    schema: union('Inventory schema', [
      literal(INVENTORY_SCHEMA),
      literal(LEGACY_INVENTORY_SCHEMA),
    ]),
    revision,
    storage: { schema: { type: 'object' }, parse: (input: unknown) => input },
    vessels: { schema: { type: 'object' }, parse: (input: unknown) => input },
    stocks: { schema: { type: 'object' }, parse: (input: unknown) => input },
  }).parse(row);
  const legacy = shape.schema === LEGACY_INVENTORY_SCHEMA;
  const storage = records(shape.storage, (raw): InventoryStorage => {
    if (!legacy) return storageRecord.parse(raw);
    const item = legacyStorage.parse(raw);
    return {
      id: item.id,
      name: item.name,
      layout: { kind: 'named', slots: item.slots },
      placement: item.placement,
      lifecycle: 'active',
    };
  });
  const vessels = records(
    shape.vessels,
    (raw): InventoryVessel =>
      legacy ? { kind: 'movable', ...legacyVessel.parse(raw) } : vesselRecord.parse(raw)
  );
  const state: InventoryState = {
    schema: INVENTORY_SCHEMA,
    revision: shape.revision,
    storage,
    vessels,
    stocks: records(shape.stocks, (raw): InventoryStock => stockRecord.parse(raw)),
  };
  validateState(state);
  return state;
}
