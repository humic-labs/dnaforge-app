import { validateInventoryPhysicalState } from './inventory-configuration';
import {
  parseMetadataFieldDefinitions,
  metadataFieldDefinitionsJsonSchema,
  validateMetadataValues,
} from './metadata-fields';
import {
  emptyInventoryPhysicalConfiguration,
  normalizeInventoryDimension,
  normalizeInventoryGeometry,
} from './inventory-geometry';
import type {
  InventoryPhysicalConfiguration,
  InventoryPhysicalTypeVersion,
  InventoryEquipmentRecipeVersion,
  InventoryFitEvidence,
} from './inventory-configuration-types';
import {
  INVENTORY_SCHEMA,
  INVENTORY_CONFIGURATION_SCHEMA,
  INVENTORY_CUSTODY_SCHEMA,
  INVENTORY_RESERVATION_SCHEMA,
  INVENTORY_COMPOSITION_SCHEMA,
  INVENTORY_MATERIAL_SCHEMA,
  INVENTORY_LAYOUT_SCHEMA,
  INVENTORY_DECIMAL_PATTERN,
  LEGACY_INVENTORY_SCHEMA,
  INVENTORY_VOLUME_UNITS,
  MAX_INVENTORY_BATCH_COMMANDS,
  MAX_INVENTORY_STORAGE_SLOTS,
  type InventoryCommand,
  type InventoryCommandBatch,
  type InventoryComposition,
  type InventoryCompositionInput,
  type InventoryConcentration,
  type InventoryConcentrationInput,
  type InventoryExecutionContext,
  type InventoryCustody,
  type InventoryLayout,
  type InventoryLot,
  type InventoryQuantity,
  type InventoryReservation,
  type InventoryWithdrawalCommand,
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
import { compareInventoryVolumes, normalizeInventoryVolume } from './inventory-volume';
import { unknownInventoryVesselLimits } from './inventory-materials';
import {
  INVENTORY_CONCENTRATION_UNITS,
  normalizeInventoryConcentration,
  validateInventoryComposition,
  validateInventoryConcentration,
} from './inventory-concentration';

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

function text(label: string, maxLength = 512, trim = false, pattern = '\\S'): Codec<string> {
  return {
    schema: { type: 'string', minLength: 1, maxLength, pattern },
    parse(value) {
      if (
        typeof value !== 'string' ||
        value.length > maxLength ||
        !value.trim() ||
        value.includes('\0') ||
        !new RegExp(pattern, 'u').test(value)
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
const reservationItem = union('Reserved physical item', [
  fields('Reserved storage item', { kind: literal('storage'), id }),
  fields('Reserved vessel item', { kind: literal('vessel'), id: vesselId }),
]);
const timestamp = integer('Inventory timestamp', 0, Number.MAX_SAFE_INTEGER);
const deadline: Codec<number | null> = {
  schema: { anyOf: [timestamp.schema, { type: 'null' }] },
  parse(value) {
    return value === null ? null : timestamp.parse(value);
  },
};
const authority = fields('Inventory profile authority', {
  kind: literal('local-profile'),
  profileKey: id,
});
const principal = union('Inventory acting principal', [
  authority,
  fields('Inventory agent principal', { kind: literal('agent'), identityId: id }),
]);
const executionContext: Codec<InventoryExecutionContext> = checked(
  fields('Inventory execution context', {
    at: timestamp,
    principal,
    authority,
  }),
  (value) => {
    if (
      value.principal.kind === 'local-profile' &&
      value.principal.profileKey !== value.authority.profileKey
    )
      invalid('A local profile principal must match its profile authority.');
  }
);

export function parseInventoryExecutionContext(value: unknown): InventoryExecutionContext {
  return executionContext.parse(value);
}
const custodyDestination = union('Custody destination', [
  root,
  unplaced,
  located,
  fields('Stack top destination', { kind: literal('stack-top'), stackId: id }),
]);
function nullable<T>(codec: Codec<T>): Codec<T | null> {
  return {
    schema: { anyOf: [codec.schema, { type: 'null' }] },
    parse: (value) => (value === null ? null : codec.parse(value)),
  };
}
const locationPathEntry = fields('Observed location path entry', {
  item: reservationItem,
  name,
  position: nullable(slot),
});
const locationObservation = fields('Last-known location observation', {
  observedAt: timestamp,
  placement: union('Observed placement', [root, unplaced, located]),
  path: array(locationPathEntry, MAX_INVENTORY_STORAGE_SLOTS, 1),
  custodyRoot: nullable(reservationItem),
  relativePath: array(locationPathEntry, MAX_INVENTORY_STORAGE_SLOTS),
  relativeAt: deadline,
});
const custodyRecord: Codec<InventoryCustody> = union('Item custody', [
  fields('Available item custody', { kind: literal('available') }),
  fields('Checked-out item custody', {
    kind: literal('checked-out'),
    reason,
    holder: principal,
    at: timestamp,
    dueAt: deadline,
    lastKnown: locationObservation,
  }),
  fields('In-transit item custody', {
    kind: literal('in-transit'),
    reason,
    holder: principal,
    at: timestamp,
    destination: custodyDestination,
    lastKnown: locationObservation,
  }),
  fields('Missing item custody', {
    kind: literal('missing'),
    holder: nullable(principal),
    reportedBy: principal,
    at: timestamp,
    reason,
    lastKnown: locationObservation,
  }),
]);
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
  value: checked(text('Decimal volume', 128, false, INVENTORY_DECIMAL_PATTERN), (value) => {
    if (!new RegExp(INVENTORY_DECIMAL_PATTERN, 'u').test(value))
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

const concentrationReason = union('Unknown concentration reason', [
  literal('unmeasured'),
  literal('missing-input'),
  literal('incompatible-units'),
]);
const storedConcentration: Codec<InventoryConcentration> = checked(
  union('Concentration fact', [
    fields('Unknown concentration fact', { kind: literal('unknown'), reason: concentrationReason }),
    fields('Known concentration fact', {
      kind: literal('known'),
      unit: union('Canonical concentration unit', [literal('ng/uL'), literal('nmol/uL')]),
      numerator: text('Concentration numerator', 256, true, '^(?:0|[1-9]\\d*)$'),
      denominator: text('Concentration denominator', 256, true, '^[1-9]\\d*$'),
    }),
  ]),
  (value) => {
    try {
      validateInventoryConcentration(value);
    } catch (error) {
      invalid(error instanceof Error ? error.message : 'Invalid concentration fact.');
    }
  }
);
const concentrationInput: Codec<InventoryConcentrationInput> = union('Concentration measurement', [
  fields('Unknown concentration measurement', { kind: literal('unknown') }),
  storedConcentration,
  checked(
    fields('Known concentration measurement', {
      kind: literal('known'),
      value: text('Concentration value', 128, true, INVENTORY_DECIMAL_PATTERN),
      unit: union(
        'Concentration unit',
        INVENTORY_CONCENTRATION_UNITS.map((value) => literal(value))
      ),
    }),
    (value) => {
      try {
        normalizeInventoryConcentration(value);
      } catch (error) {
        invalid(error instanceof Error ? error.message : 'Invalid concentration measurement.');
      }
    }
  ),
]);

function analytes<T>(concentration: Codec<T>): Codec<Readonly<Record<string, T>>> {
  return {
    schema: {
      type: 'object',
      maxProperties: 256,
      propertyNames: id.schema,
      additionalProperties: concentration.schema,
    },
    parse(value) {
      const entries = Object.entries(object(value, 'Composition analytes'));
      if (entries.length > 256) invalid('A composition supports at most 256 tracked analytes.');
      const result: Record<string, T> = Object.create(null);
      for (const [key, input] of entries) result[id.parse(key)] = concentration.parse(input);
      return result;
    },
  };
}

const storedComposition: Codec<InventoryComposition> = checked(
  union('Composition fact', [
    fields('Unknown composition', { kind: literal('unknown') }),
    fields('Homogeneous composition', {
      kind: literal('homogeneous'),
      analytes: analytes(storedConcentration),
    }),
  ]),
  (value) => {
    try {
      validateInventoryComposition(value);
    } catch (error) {
      invalid(error instanceof Error ? error.message : 'Invalid composition fact.');
    }
  }
);
const compositionInput: Codec<InventoryCompositionInput> = union('Composition measurement', [
  fields('Unknown composition measurement', { kind: literal('unknown') }),
  fields('Homogeneous composition measurement', {
    kind: literal('homogeneous'),
    analytes: analytes(concentrationInput),
  }),
]);
const mixing = union('Output mixing', [literal('unknown'), literal('homogeneous')]);

const stockSource = union('Stock provenance', [
  fields('Unattributed stock root', { kind: literal('unattributed'), rootStockId: id }),
  fields('Stock lot', { kind: literal('lot'), lotId: id }),
]);
const previousSourceIdentityFields = { stockId: id, materialId: id, source: stockSource };
const sourceIdentityFields = { ...previousSourceIdentityFields, composition: storedComposition };
const sourceIdentity = fields('Source identity', sourceIdentityFields);
const contribution = fields('Material contribution', { ...sourceIdentityFields, quantity: volume });
const receivedOrigin = fields('Received lot origin', {
  kind: literal('received'),
  supplier: text('Supplier'),
  lotNumber: text('Supplier lot number'),
});
const preparedOriginInput = fields('Preparation origin', {
  kind: literal('prepared'),
  sourceStockIds: array(id, MAX_INVENTORY_BATCH_COMMANDS, 0, true),
  method: text('Preparation method', 2000),
});
const lotOrigin = union('Lot origin', [
  receivedOrigin,
  fields('Prepared lot origin', {
    kind: literal('prepared'),
    inputs: array(sourceIdentity, MAX_INVENTORY_BATCH_COMMANDS),
    method: text('Preparation method', 2000),
  }),
  fields('Pooled lot origin', {
    kind: literal('pooled'),
    inputs: array(contribution, MAX_INVENTORY_BATCH_COMMANDS, 2),
  }),
  fields('Diluted lot origin', {
    kind: literal('diluted'),
    sample: contribution,
    diluent: contribution,
  }),
]);
const lotRecord = fields('Lot record', { id, materialId: id, name, origin: lotOrigin });
const previousSourceIdentity = fields('Previous source identity', previousSourceIdentityFields);
const previousContribution = fields('Previous material contribution', {
  ...previousSourceIdentityFields,
  quantity: volume,
});
const previousLotRecord = fields('Previous lot record', {
  id,
  materialId: id,
  name,
  origin: union('Previous lot origin', [
    receivedOrigin,
    fields('Previous prepared lot origin', {
      kind: literal('prepared'),
      inputs: array(previousSourceIdentity, MAX_INVENTORY_BATCH_COMMANDS),
      method: text('Preparation method', 2000),
    }),
    fields('Previous pooled lot origin', {
      kind: literal('pooled'),
      inputs: array(previousContribution, MAX_INVENTORY_BATCH_COMMANDS, 2),
    }),
    fields('Previous diluted lot origin', {
      kind: literal('diluted'),
      sample: previousContribution,
      diluent: previousContribution,
    }),
  ]),
});
const limits = fields('Container limits', { capacity: quantity, deadVolume: quantity });
const storedLimits = fields('Stored container limits', {
  capacity: storedQuantity,
  deadVolume: storedQuantity,
});
const withdrawal = fields('Material withdrawal', { stockId: id, quantity: volume });
const derivedOutput = { lotId: id, stockId: id, vesselId, materialId: id, name, reason };
const transferFields = {
  kind: literal('transfer'),
  sourceStockId: id,
  quantity: volume,
  destination: union('Transfer destination', [
    fields('New destination stock', { kind: literal('new-stock'), stockId: id, vesselId }),
    fields('Existing destination stock', { kind: literal('existing-stock'), stockId: id }),
  ]),
  reason,
};
const poolFields = {
  kind: literal('pool'),
  ...derivedOutput,
  inputs: array(withdrawal, MAX_INVENTORY_BATCH_COMMANDS, 2),
};
const diluteFields = {
  kind: literal('dilute'),
  ...derivedOutput,
  sample: withdrawal,
  diluent: withdrawal,
};
const transferCommand = union('Transfer command', [
  fields('Legacy transfer command', transferFields),
  fields('Mixed transfer command', {
    ...transferFields,
    destination: fields('Existing destination stock', {
      kind: literal('existing-stock'),
      stockId: id,
    }),
    mixing,
  }),
]);
const poolCommand = union('Pool command', [
  fields('Legacy pool command', poolFields),
  fields('Mixed pool command', { ...poolFields, mixing }),
]);
const diluteCommand = union('Dilution command', [
  fields('Legacy dilution command', diluteFields),
  fields('Mixed dilution command', { ...diluteFields, mixing }),
]);
const consumeCommand = fields('Consume command', {
  kind: literal('consume'),
  stockId: id,
  quantity: volume,
  reason,
});
const withdrawalCommand: Codec<InventoryWithdrawalCommand> = union('Reservation withdrawal', [
  consumeCommand,
  transferCommand,
  poolCommand,
  diluteCommand,
]);

function stringMap<T>(codec: Codec<T>, maximum = 10000): Codec<Readonly<Record<string, T>>> {
  return {
    schema: { type: 'object', maxProperties: maximum, additionalProperties: codec.schema },
    parse(value) {
      const rows = Object.entries(object(value, 'Inventory configuration map'));
      if (rows.length > maximum) invalid('Configuration map is too large.');
      const result: Record<string, T> = Object.create(null);
      for (const [key, input] of rows) result[id.parse(key)] = codec.parse(input);
      return result;
    },
  };
}
const description: Codec<string> = {
  schema: { type: 'string', maxLength: 2000 },
  parse(value) {
    if (typeof value !== 'string' || value.length > 2000 || value.includes('\0'))
      return invalid('Description requires bounded text.');
    return value;
  },
};
const metadataFields = {
  schema: metadataFieldDefinitionsJsonSchema(),
  parse(value: unknown) {
    try {
      return parseMetadataFieldDefinitions(value);
    } catch (error) {
      return invalid(error instanceof Error ? error.message : 'Invalid metadata fields.');
    }
  },
};
const metadataValue: Codec<import('./inventory-configuration-types').InventoryMetadataValue> = {
  schema: {
    oneOf: [
      { type: 'string' },
      { type: 'number' },
      { type: 'boolean' },
      { type: 'null' },
      { type: 'array', items: { type: 'string' } },
    ],
  },
  parse(value) {
    if (
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      (typeof value === 'string' && value.length <= 10000)
    )
      return value as string | number | boolean | null;
    if (
      Array.isArray(value) &&
      value.length <= 1000 &&
      value.every((item) => typeof item === 'string' && item.length <= 10000)
    )
      return [...value];
    return invalid('Metadata requires bounded scalar values or text lists.');
  },
};
const metadata = stringMap(metadataValue, 256);
const dimension = checked(
  union('Physical dimension', [
    fields('Unknown dimension', { kind: literal('unknown') }),
    fields('Known dimension', {
      kind: literal('known'),
      value: text('Dimension decimal', 128, true, INVENTORY_DECIMAL_PATTERN),
      unit: union('Length unit', [literal('mm'), literal('cm'), literal('in')]),
    }),
  ]),
  (value) => {
    try {
      normalizeInventoryDimension(value);
    } catch (error) {
      invalid(error instanceof Error ? error.message : 'Invalid dimension.');
    }
  }
);
const physicalDimensions = fields('Physical dimensions', {
  width: dimension,
  height: dimension,
  depth: dimension,
});
const geometry = fields('Physical geometry', {
  external: physicalDimensions,
  usable: physicalDimensions,
});
const turn: Codec<0 | 1 | 2 | 3> = {
  schema: { type: 'integer', enum: [0, 1, 2, 3] },
  parse(value) {
    return integer('Quarter turns', 0, 3).parse(value) as 0 | 1 | 2 | 3;
  },
};
const orientation = union('Physical mounting orientation', [
  fields('Unknown orientation', { kind: literal('unknown') }),
  fields('Known upright orientation', { kind: literal('known'), quarterTurns: turn }),
]);
const childPolicy = union('Allowed child policy', [
  fields('Any legal child', { kind: literal('any-legal') }),
  fields('No children', { kind: literal('none') }),
  fields('Selected child types', { kind: literal('types'), typeIds: array(id, 256, 1, true) }),
]);
const positionRule = union('Physical position policy', [
  fields('Unavailable position', { kind: literal('unavailable'), reason }),
  fields('Available position', {
    kind: literal('available'),
    childPolicy: nullable(childPolicy),
    usable: nullable(physicalDimensions),
  }),
]);
const sourceReference = fields('Source reference', {
  url: text('Source URL', 4000, true, '^https?://'),
  title: name,
  locator: text('Source page or section', 2000),
  readAt: text('Source read date', 10, true, '^\\d{4}-\\d{2}-\\d{2}$'),
  documentRevision: nullable(text('Source document revision')),
  sha256: nullable(text('Source hash', 64, true, '^[a-f0-9]{64}$')),
});
const physicalDefinition = union('Physical type definition', [
  fields('Storage type definition', {
    kind: literal('storage'),
    layout,
    childPolicy,
    positionRules: stringMap(positionRule),
    geometry,
  }),
  fields('Vessel type definition', {
    kind: literal('vessel'),
    mobility: union('Vessel mobility', [literal('movable'), literal('fixed-well')]),
    limits,
    geometry,
  }),
]);
const recipeComponent = fields('Recipe component', {
  key: id,
  parentKey: nullable(id),
  positionId: nullable(slot),
  name,
  typeVersionId: id,
});
const equipmentModel = fields('Equipment model identity', {
  manufacturer: name,
  model: name,
  partNumber: nullable(name),
  region: nullable(name),
  revision: nullable(name),
});
const fitSubject = union('Fit subject pin', [
  fields('Physical type fit subject', { kind: literal('type-version'), versionId: id }),
  fields('Installed fit subject', {
    kind: literal('installed'),
    item: reservationItem,
    configurationRevision: revision,
  }),
]);
const fitFacts = {
  id,
  parent: fitSubject,
  child: fitSubject,
  positionId: nullable(slot),
  orientations: array(turn, 4, 1, true),
  result: union('Fit assertion', [literal('compatible'), literal('incompatible')]),
  basis: union('Fit evidence basis', [
    literal('manufacturer-supported'),
    literal('locally-verified'),
  ]),
  source: nullable(sourceReference),
  reason,
};
const configurationRecord: Codec<InventoryPhysicalConfiguration> = fields(
  'Installed physical configuration',
  {
    revision,
    typeVersionId: nullable(id),
    metadata,
    geometryOverride: nullable(
      fields('Recorded local geometry', {
        geometry,
        source: nullable(sourceReference),
        at: timestamp,
        by: principal,
        reason,
      })
    ),
    orientation,
    unavailablePositions: stringMap(reason),
    recipe: nullable(fields('Installed recipe pin', { recipeVersionId: id, componentKey: id })),
  }
);
const catalogTarget = union('Catalog version target', [
  fields('Physical type version target', { kind: literal('type-version'), versionId: id }),
  fields('Equipment recipe version target', { kind: literal('recipe-version'), versionId: id }),
]);
const catalogSelection = union('Catalog selection state', [
  fields('Available catalog version', { kind: literal('available') }),
  fields('Retired catalog version', {
    kind: literal('retired'),
    at: timestamp,
    by: principal,
    reason,
  }),
]);
const typeVersionFields = {
  id,
  typeId: id,
  version: integer('Physical type version', 1, Number.MAX_SAFE_INTEGER),
  name,
  description,
  fields: metadataFields,
  sources: array(sourceReference, 256),
  definition: physicalDefinition,
  publishedAt: timestamp,
  publishedBy: principal,
};
const previousTypeVersionRecord = fields('V7 physical type version', typeVersionFields);
const typeVersionRecord: Codec<InventoryPhysicalTypeVersion> = fields('Physical type version', {
  ...typeVersionFields,
  selection: catalogSelection,
});
const recipeVersionFields = {
  id,
  recipeId: id,
  version: integer('Recipe version', 1, Number.MAX_SAFE_INTEGER),
  name,
  description,
  model: equipmentModel,
  components: array(recipeComponent, 10000, 1),
  sources: array(sourceReference, 256),
  publishedAt: timestamp,
  publishedBy: principal,
};
const previousRecipeVersionRecord = fields('V7 equipment recipe version', recipeVersionFields);
const recipeVersionRecord: Codec<InventoryEquipmentRecipeVersion> = fields(
  'Equipment recipe version',
  {
    ...recipeVersionFields,
    selection: catalogSelection,
  }
);
const fitEvidenceRecord: Codec<InventoryFitEvidence> = fields('Fit evidence', {
  ...fitFacts,
  at: timestamp,
  by: principal,
});
const commands = {
  'retire-catalog-version': fields('Retire catalog version command', {
    kind: literal('retire-catalog-version'),
    target: catalogTarget,
    reason,
  }),
  'restore-catalog-version': fields('Restore catalog version command', {
    kind: literal('restore-catalog-version'),
    target: catalogTarget,
    reason,
  }),
  'create-lot': fields('Create lot command', {
    kind: literal('create-lot'),
    id,
    materialId: id,
    name,
    origin: union('New lot origin', [receivedOrigin, preparedOriginInput]),
  }),
  'receive-lot-stock': fields('Receive lot stock command', {
    kind: literal('receive-lot-stock'),
    id,
    vesselId,
    lotId: id,
    quantity,
    quality,
  }),
  'associate-stock-lot': fields('Attribute stock command', {
    kind: literal('associate-stock-lot'),
    stockId: id,
    lotId: id,
    reason,
  }),
  'set-vessel-limits': fields('Container limits command', {
    kind: literal('set-vessel-limits'),
    vesselId,
    limits,
    reason,
  }),
  'record-composition': fields('Record composition command', {
    kind: literal('record-composition'),
    stockId: id,
    composition: compositionInput,
    reason,
  }),
  transfer: transferCommand,
  pool: poolCommand,
  dilute: diluteCommand,
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
  consume: consumeCommand,
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
  'reserve-quantity': fields('Reserve quantity command', {
    kind: literal('reserve-quantity'),
    id,
    stockId: id,
    quantity: volume,
    deadline,
    purpose: reason,
  }),
  'reserve-item': fields('Reserve item command', {
    kind: literal('reserve-item'),
    id,
    item: reservationItem,
    deadline,
    purpose: reason,
  }),
  'release-reservation': fields('Release reservation command', {
    kind: literal('release-reservation'),
    reservationId: id,
    reason,
  }),
  'cancel-reservation': fields('Cancel reservation command', {
    kind: literal('cancel-reservation'),
    reservationId: id,
    reason,
  }),
  'expire-reservations': fields('Expire reservations command', {
    kind: literal('expire-reservations'),
    ids: array(id, MAX_INVENTORY_BATCH_COMMANDS, 1, true),
  }),
  'fulfill-reservations': fields('Fulfill reservations command', {
    kind: literal('fulfill-reservations'),
    claims: array(
      fields('Reservation fulfillment claim', { reservationId: id, quantity: volume }),
      MAX_INVENTORY_BATCH_COMMANDS,
      1
    ),
    withdrawal: withdrawalCommand,
  }),
  'checkout-item': fields('Checkout item command', {
    kind: literal('checkout-item'),
    item: reservationItem,
    dueAt: deadline,
    reason,
  }),
  'start-item-transit': fields('Start item transit command', {
    kind: literal('start-item-transit'),
    item: reservationItem,
    destination: custodyDestination,
    reason,
  }),
  'return-item': fields('Return item command', {
    kind: literal('return-item'),
    item: reservationItem,
    destination: custodyDestination,
    reason,
  }),
  'report-item-missing': fields('Report missing item command', {
    kind: literal('report-item-missing'),
    item: reservationItem,
    reason,
  }),
  'locate-item': fields('Locate item command', {
    kind: literal('locate-item'),
    item: reservationItem,
    destination: custodyDestination,
    reason,
  }),
  'define-physical-type': fields('Define physical type command', {
    kind: literal('define-physical-type'),
    id,
    typeId: id,
    name,
    description,
    fields: metadataFields,
    sources: array(sourceReference, 256),
    definition: physicalDefinition,
  }),
  'define-equipment-recipe': fields('Define equipment recipe command', {
    kind: literal('define-equipment-recipe'),
    id,
    recipeId: id,
    name,
    description,
    model: equipmentModel,
    components: array(recipeComponent, 10000, 1),
    sources: array(sourceReference, 256),
  }),
  'instantiate-physical-type': fields('Instantiate physical type command', {
    kind: literal('instantiate-physical-type'),
    typeVersionId: id,
    id,
    name,
    destination: custodyDestination,
    metadata,
    reason,
  }),
  'instantiate-equipment-recipe': fields('Instantiate equipment recipe command', {
    kind: literal('instantiate-equipment-recipe'),
    recipeVersionId: id,
    name,
    components: array(fields('Actual component binding', { key: id, id, metadata }), 10000, 1),
    destination: custodyDestination,
    reason,
  }),
  'configure-item': fields('Configure installed item command', {
    kind: literal('configure-item'),
    item: reservationItem,
    typeVersionId: nullable(id),
    metadata,
    orientation,
    unavailablePositions: stringMap(reason),
    reason,
  }),
  'record-item-geometry': fields('Record installed geometry command', {
    kind: literal('record-item-geometry'),
    item: reservationItem,
    geometry,
    source: nullable(sourceReference),
    reason,
  }),
  'reconfigure-storage': fields('Reconfigure installed layout command', {
    kind: literal('reconfigure-storage'),
    storageId: id,
    layout,
    reason,
  }),
  'record-fit-evidence': fields('Record scoped fit assertion command', {
    kind: literal('record-fit-evidence'),
    ...fitFacts,
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
  schema: {
    oneOf: Object.values(commands).flatMap((codec) =>
      Array.isArray(codec.schema.oneOf) ? codec.schema.oneOf : [codec.schema]
    ),
  },
  parse: parseInventoryCommand,
};
const batchCodec = fields('Inventory command batch', {
  expectedRevision: revision,
  commands: array(commandCodec, MAX_INVENTORY_BATCH_COMMANDS, 1),
});

export function parseInventoryCommandBatch(value: unknown): InventoryCommandBatch {
  return batchCodec.parse(value);
}

const previousStockRecord = fields('Stock record', {
  id,
  vesselId,
  materialId: id,
  quantity: storedQuantity,
  quality,
});
const materialStockFields = {
  id,
  vesselId,
  materialId: id,
  quantity: storedQuantity,
  quality,
  source: stockSource,
};
const materialStockRecord = fields('Previous stock record', materialStockFields);
const stockRecord = fields('Stock record', {
  ...materialStockFields,
  composition: storedComposition,
});
const reservationVolume = checked(volume, (value) => {
  const normalized = normalizeInventoryVolume(value);
  if (normalized.value !== value.value || normalized.unit !== value.unit)
    invalid('Stored reservation volumes require canonical uL decimal values.');
});
const reservationFacts = {
  id,
  holder: principal,
  purpose: reason,
  createdAt: timestamp,
  deadline,
  lifecycle: union('Reservation lifecycle', [
    fields('Active reservation', { kind: literal('active') }),
    fields('Fulfilled reservation', { kind: literal('fulfilled'), at: timestamp }),
    fields('Released reservation', { kind: literal('released'), at: timestamp, reason }),
    fields('Cancelled reservation', {
      kind: literal('cancelled'),
      at: timestamp,
      reason,
      authority,
    }),
    fields('Expired reservation', { kind: literal('expired'), at: timestamp }),
  ]),
};
const reservationRecord: Codec<InventoryReservation> = union('Reservation record', [
  fields('Quantity reservation record', {
    ...reservationFacts,
    kind: literal('quantity'),
    stockId: id,
    quantity: reservationVolume,
    remaining: reservationVolume,
  }),
  fields('Item reservation record', {
    ...reservationFacts,
    kind: literal('item'),
    item: reservationItem,
  }),
]);

const storageFields = { id, name, layout, placement: storagePlacement, lifecycle };
const previousStorageRecord = fields('Previous storage record', storageFields);
const custodyStorageRecord = fields('Previous custody storage record', {
  ...storageFields,
  custody: custodyRecord,
});
const storageRecord = fields('Storage record', {
  ...storageFields,
  custody: custodyRecord,
  configuration: configurationRecord,
});
const previousVesselRecord = union('Vessel record', [
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
const materialVesselRecord = union('Vessel record', [
  fields('Movable vessel record', {
    kind: literal('movable'),
    id,
    name,
    placement: vesselPlacement,
    lifecycle,
    limits: storedLimits,
  }),
  fields('Permanent well record', {
    kind: literal('fixed-well'),
    id: text('Permanent well identifier', 1024, true),
    name,
    placement: located,
    lifecycle,
    limits: storedLimits,
  }),
]);

const custodyVesselRecord = union('Vessel record', [
  fields('Movable vessel record', {
    kind: literal('movable'),
    id,
    name,
    placement: vesselPlacement,
    lifecycle,
    limits: storedLimits,
    custody: custodyRecord,
  }),
  fields('Permanent well record', {
    kind: literal('fixed-well'),
    id: text('Permanent well identifier', 1024, true),
    name,
    placement: located,
    lifecycle,
    limits: storedLimits,
  }),
]);

const vesselRecord = union('Vessel record', [
  fields('Movable vessel record', {
    kind: literal('movable'),
    id,
    name,
    placement: vesselPlacement,
    lifecycle,
    limits: storedLimits,
    configuration: configurationRecord,
    custody: custodyRecord,
  }),
  fields('Permanent well record', {
    kind: literal('fixed-well'),
    id: text('Permanent well identifier', 1024, true),
    name,
    placement: located,
    lifecycle,
    limits: storedLimits,
    configuration: configurationRecord,
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
  for (const rows of [
    state.storage,
    state.vessels,
    state.stocks,
    state.lots,
    state.reservations,
    state.typeVersions,
    state.recipeVersions,
    state.fitEvidence,
  ]) {
    for (const identifier of Object.keys(rows)) {
      if (allIds.has(identifier)) invalid('Inventory record identifiers must be distinct.');
      allIds.add(identifier);
    }
  }
  const occupied = new Map<string, Set<string>>();
  for (const item of [...Object.values(state.storage), ...Object.values(state.vessels)]) {
    if ('custody' in item && item.custody.kind !== 'available') {
      const custody = item.custody;
      if (item.placement.kind === 'located')
        invalid('A non-available custody root requires neutral placement.');
      if (custody.at > state.lastRecordedAt || custody.lastKnown.observedAt > custody.at)
        invalid('Custody observations cannot exceed accepted inventory time.');
      if (custody.kind === 'checked-out' && custody.dueAt !== null && custody.dueAt <= custody.at)
        invalid('A checkout due time must follow its accepted checkout.');
      const observation = custody.lastKnown;
      if (
        observation.relativeAt !== null &&
        (observation.relativeAt < observation.observedAt || observation.relativeAt > custody.at)
      )
        invalid('Relative location time must be inside the recorded observation lifetime.');
      if (
        (observation.relativePath.length === 0) !== (observation.relativeAt === null) ||
        (observation.relativePath.length === 0) !== (observation.custodyRoot === null)
      )
        invalid('Inherited location observations require relative path and time together.');
    }
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
  for (const vessel of Object.values(state.vessels)) {
    const { capacity, deadVolume } = vessel.limits;
    if (
      capacity.kind === 'known' &&
      deadVolume.kind === 'known' &&
      compareInventoryVolumes(deadVolume, capacity) > 0
    )
      invalid('Dead volume cannot exceed known capacity.');
  }
  function validateSource(value: { materialId: string; source: InventoryStock['source'] }): void {
    if (value.source.kind === 'lot') {
      const lot = state.lots[value.source.lotId];
      if (!lot || lot.materialId !== value.materialId)
        invalid('A stock lot must identify the same material.');
    } else {
      const root = state.stocks[value.source.rootStockId];
      if (!root || root.materialId !== value.materialId)
        invalid('An unattributed stock requires its original material root.');
    }
  }
  for (const lot of Object.values(state.lots)) {
    const origin = lot.origin;
    const inputs =
      origin.kind === 'received'
        ? []
        : origin.kind === 'diluted'
          ? [origin.sample, origin.diluent]
          : origin.inputs;
    if (new Set(inputs.map((input) => input.stockId)).size !== inputs.length)
      invalid('Lot contributions must identify distinct stocks.');
    for (const input of inputs) {
      if (
        !state.stocks[input.stockId] ||
        state.stocks[input.stockId].materialId !== input.materialId
      )
        invalid('Lot provenance requires an existing source material.');
      validateSource(input);
      if ('quantity' in input) {
        const quantity = volume.parse(input.quantity);
        const normalized = normalizeInventoryVolume(quantity);
        if (
          normalized.value !== quantity.value ||
          normalized.unit !== quantity.unit ||
          normalized.value === '0'
        )
          invalid('Recorded contributions require positive canonical volumes.');
      }
    }
  }
  const dependents = new Map<string, string[]>();
  const dependencies = new Map<string, number>();
  for (const lot of Object.values(state.lots)) {
    const origin = lot.origin;
    const inputs =
      origin.kind === 'received'
        ? []
        : origin.kind === 'diluted'
          ? [origin.sample, origin.diluent]
          : origin.inputs;
    const parents = new Set(
      inputs.flatMap((input) => (input.source.kind === 'lot' ? [input.source.lotId] : []))
    );
    dependencies.set(lot.id, parents.size);
    for (const parent of parents)
      dependents.set(parent, [...(dependents.get(parent) ?? []), lot.id]);
  }
  const ready = [...dependencies].filter(([, count]) => count === 0).map(([id]) => id);
  for (let index = 0; index < ready.length; index++) {
    for (const child of dependents.get(ready[index]) ?? []) {
      const count = dependencies.get(child)! - 1;
      dependencies.set(child, count);
      if (count === 0) ready.push(child);
    }
  }
  if (ready.length !== dependencies.size) invalid('Lot provenance must not contain a cycle.');
  const stockVessels = new Set<string>();
  for (const stock of Object.values(state.stocks)) {
    if (!Object.hasOwn(state.vessels, stock.vesselId))
      invalid('Every stock must reference an existing vessel.');
    if (stockVessels.has(stock.vesselId)) invalid('This version supports one stock per vessel.');
    stockVessels.add(stock.vesselId);
    validateSource(stock);
    const capacity = state.vessels[stock.vesselId].limits.capacity;
    if (
      stock.quantity.kind === 'known' &&
      capacity.kind === 'known' &&
      compareInventoryVolumes(stock.quantity, capacity) > 0
    )
      invalid('A recorded quantity cannot exceed known container capacity.');
  }
  for (const reservation of Object.values(state.reservations)) {
    if (
      reservation.createdAt > state.lastRecordedAt ||
      (reservation.deadline !== null && reservation.deadline <= reservation.createdAt)
    )
      invalid('Reservation timestamps must follow creation and the recorded clock floor.');
    if (reservation.lifecycle.kind !== 'active') {
      if (
        reservation.lifecycle.at < reservation.createdAt ||
        reservation.lifecycle.at > state.lastRecordedAt
      )
        invalid('Terminal reservation timestamps must be inside the recorded lifetime.');
      if (
        reservation.lifecycle.kind === 'expired' &&
        (reservation.deadline === null || reservation.lifecycle.at < reservation.deadline)
      )
        invalid('Expired reservations require a reached deadline.');
    }
    if (reservation.kind === 'quantity') {
      if (!state.stocks[reservation.stockId])
        invalid('A quantity reservation requires an existing stock.');
      if (
        reservation.quantity.value === '0' ||
        compareInventoryVolumes(reservation.remaining, reservation.quantity) > 0
      )
        invalid(
          'A reservation requires positive original quantity and a bounded remaining quantity.'
        );
      if (
        (reservation.lifecycle.kind === 'active' && reservation.remaining.value === '0') ||
        (reservation.lifecycle.kind === 'fulfilled' && reservation.remaining.value !== '0')
      )
        invalid('Reservation remaining quantity must match its lifecycle.');
    } else if (
      !(reservation.item.kind === 'storage'
        ? state.storage[reservation.item.id]
        : state.vessels[reservation.item.id])
    )
      invalid('An item reservation requires an existing physical item.');
  }
}

export function parseInventoryState(value: unknown): InventoryState {
  const row = object(value, 'Inventory state');
  const current = row.schema === INVENTORY_SCHEMA;
  const configuration = current || row.schema === INVENTORY_CONFIGURATION_SCHEMA;
  const custody = configuration || row.schema === INVENTORY_CUSTODY_SCHEMA;
  const reservation = custody || row.schema === INVENTORY_RESERVATION_SCHEMA;
  const composition = reservation || row.schema === INVENTORY_COMPOSITION_SCHEMA;
  const material = composition || row.schema === INVENTORY_MATERIAL_SCHEMA;
  const shape = fields('Inventory state', {
    schema: union('Inventory schema', [
      literal(INVENTORY_SCHEMA),
      literal(INVENTORY_CONFIGURATION_SCHEMA),
      literal(INVENTORY_CUSTODY_SCHEMA),
      literal(INVENTORY_RESERVATION_SCHEMA),
      literal(INVENTORY_COMPOSITION_SCHEMA),
      literal(INVENTORY_MATERIAL_SCHEMA),
      literal(INVENTORY_LAYOUT_SCHEMA),
      literal(LEGACY_INVENTORY_SCHEMA),
    ]),
    revision,
    ...(configuration
      ? {
          typeVersions: { schema: { type: 'object' }, parse: (input: unknown) => input },
          recipeVersions: { schema: { type: 'object' }, parse: (input: unknown) => input },
          fitEvidence: { schema: { type: 'object' }, parse: (input: unknown) => input },
        }
      : {}),
    ...(reservation
      ? {
          lastRecordedAt: timestamp,
          reservations: { schema: { type: 'object' }, parse: (input: unknown) => input },
        }
      : {}),
    storage: { schema: { type: 'object' }, parse: (input: unknown) => input },
    vessels: { schema: { type: 'object' }, parse: (input: unknown) => input },
    stocks: { schema: { type: 'object' }, parse: (input: unknown) => input },
    ...(material ? { lots: { schema: { type: 'object' }, parse: (input: unknown) => input } } : {}),
  }).parse(row);
  const legacy = shape.schema === LEGACY_INVENTORY_SCHEMA;
  const storage = records(shape.storage, (raw): InventoryStorage => {
    if (configuration) return storageRecord.parse(raw);
    if (custody)
      return {
        ...custodyStorageRecord.parse(raw),
        configuration: emptyInventoryPhysicalConfiguration(),
      };
    if (!legacy)
      return {
        ...previousStorageRecord.parse(raw),
        custody: { kind: 'available' },
        configuration: emptyInventoryPhysicalConfiguration(),
      };
    const item = legacyStorage.parse(raw);
    return {
      id: item.id,
      name: item.name,
      layout: { kind: 'named', slots: item.slots },
      placement: item.placement,
      lifecycle: 'active',
      custody: { kind: 'available' },
      configuration: emptyInventoryPhysicalConfiguration(),
    };
  });
  const vessels = records(shape.vessels, (raw): InventoryVessel => {
    if (configuration) return vesselRecord.parse(raw);
    if (custody)
      return {
        ...custodyVesselRecord.parse(raw),
        configuration: emptyInventoryPhysicalConfiguration(),
      };
    const vessel = material
      ? materialVesselRecord.parse(raw)
      : {
          ...(legacy
            ? { kind: 'movable' as const, ...legacyVessel.parse(raw) }
            : previousVesselRecord.parse(raw)),
          limits: unknownInventoryVesselLimits(),
        };
    return vessel.kind === 'movable'
      ? {
          ...vessel,
          custody: { kind: 'available' },
          configuration: emptyInventoryPhysicalConfiguration(),
        }
      : { ...vessel, configuration: emptyInventoryPhysicalConfiguration() };
  });
  const state: InventoryState = {
    schema: INVENTORY_SCHEMA,
    typeVersions: configuration
      ? records(shape.typeVersions, (raw) =>
          current
            ? typeVersionRecord.parse(raw)
            : {
                ...previousTypeVersionRecord.parse(raw),
                selection: { kind: 'available' as const },
              }
        )
      : (Object.create(null) as Record<string, InventoryPhysicalTypeVersion>),
    recipeVersions: configuration
      ? records(shape.recipeVersions, (raw) =>
          current
            ? recipeVersionRecord.parse(raw)
            : {
                ...previousRecipeVersionRecord.parse(raw),
                selection: { kind: 'available' as const },
              }
        )
      : (Object.create(null) as Record<string, InventoryEquipmentRecipeVersion>),
    fitEvidence: configuration
      ? records(shape.fitEvidence, (raw) => fitEvidenceRecord.parse(raw))
      : (Object.create(null) as Record<string, InventoryFitEvidence>),
    revision: shape.revision,
    lastRecordedAt: reservation ? timestamp.parse(shape.lastRecordedAt) : 0,
    reservations: reservation
      ? records(shape.reservations, (raw) => reservationRecord.parse(raw))
      : (Object.create(null) as Record<string, InventoryReservation>),
    storage,
    vessels,
    stocks: records(shape.stocks, (raw): InventoryStock => {
      if (composition) return stockRecord.parse(raw);
      if (material) return { ...materialStockRecord.parse(raw), composition: { kind: 'unknown' } };
      const stock = previousStockRecord.parse(raw);
      return {
        ...stock,
        source: { kind: 'unattributed', rootStockId: stock.id },
        composition: { kind: 'unknown' },
      };
    }),
    lots: material
      ? records(shape.lots, (raw): InventoryLot => {
          if (composition) return lotRecord.parse(raw);
          const lot = previousLotRecord.parse(raw);
          const { origin } = lot;
          const unknown = { kind: 'unknown' as const };
          if (origin.kind === 'received') return { ...lot, origin };
          if (origin.kind === 'diluted')
            return {
              ...lot,
              origin: {
                kind: 'diluted',
                sample: { ...origin.sample, composition: { ...unknown } },
                diluent: { ...origin.diluent, composition: { ...unknown } },
              },
            };
          if (origin.kind === 'pooled')
            return {
              ...lot,
              origin: {
                kind: 'pooled',
                inputs: origin.inputs.map((input) => ({ ...input, composition: { ...unknown } })),
              },
            };
          return {
            ...lot,
            origin: {
              kind: 'prepared',
              method: origin.method,
              inputs: origin.inputs.map((input) => ({ ...input, composition: { ...unknown } })),
            },
          };
        })
      : (Object.create(null) as Record<string, InventoryLot>),
  };
  validateState(state);
  try {
    validateInventoryPhysicalState(state);
  } catch (error) {
    invalid(error instanceof Error ? error.message : 'Invalid physical configuration.');
  }
  return state;
}
