import type {
  InventoryRunValueAttribution,
  InventoryRunValueAttributionWithdrawal,
} from './inventory-run-value-attribution-types';
import { parseInventoryRunValueSnapshot } from './inventory-run-value-attribution-value';
import { validateInventoryRunValueAttributions } from './inventory-run-value-attribution-validation';
import type { InventoryPlatePlanObservation } from './inventory-plate-plan-observation-types';
import { validateInventoryPlatePlanObservations } from './inventory-plate-plan-observation-validation';
import type { InventoryPlatePlanVersion } from './inventory-plate-plan-types';
import { parseInventoryPlatePlanDefinition } from './inventory-plate-plan-definition';
import {
  validateInventoryPlatePlanVersion,
  validateInventoryPlatePlans,
} from './inventory-plate-plan-validation';
import type {
  InventoryScientificCitation,
  InventoryScientificCitationWithdrawal,
} from './inventory-scientific-citation-types';
import { validateInventoryScientificCitations } from './inventory-scientific-citation-validation';
import type { InventoryScientificWork } from './inventory-scientific-types';
import { validateInventoryScientificState } from './inventory-scientific-validation';
import { validateInventoryStockroomState } from './inventory-stockroom-validation';
import type {
  InventoryExpectedDelivery,
  InventoryArrivalAllocation,
  InventoryReorderRule,
} from './inventory-stockroom-types';
import { validateInventoryArrivalState } from './inventory-arrival-record-validation';
import type { InventoryArrival } from './inventory-arrival-types';
import { inventoryIdentityMaps } from './inventory-identity';
import { emptyInventoryStockValidity, emptyInventoryLotValidity } from './inventory-validity';
import { validateInventoryValidityState } from './inventory-validity-validation';
import type {
  InventoryOpeningState,
  InventoryOpeningObservation,
  InventoryValidityFact,
  InventoryValidityManagement,
  InventoryInheritedValidity,
  InventoryValidityOwner,
  InventoryValidityRule,
} from './inventory-validity-types';
import { projectLegacyInventoryLotConstraints } from './inventory-lot-controls';
import type {
  InventoryLotConstraints,
  InventoryLotControls,
  InventoryLotRecall,
} from './inventory-lot-controls-types';
import {
  INVENTORY_AMOUNT_UNITS,
  inventoryAmountUnitDefinition,
  normalizeInventoryAmount,
  compareInventoryAmounts,
  type InventoryAmount,
  type InventoryCanonicalAmount,
} from './inventory-amount';
import { normalizeInventoryQuantity } from './inventory-quantity';
import type { InventoryHierarchyBinding } from './inventory-hierarchy-types';
import type { InventoryVesselBinding } from './inventory-vessel-binding-types';
import type { InventoryContentsKnowledge } from './inventory-contents-types';
import { inventoryObservationKey } from './inventory-observation-identity';
import type {
  InventoryObservation,
  InventoryObservationInput,
} from './inventory-observation-types';
import {
  inventoryReceiveTableFieldIssues,
  inventoryReceiveTableRowSha256,
} from './inventory-receive-source';
import type { InventoryTableSourceRevision } from './inventory-source-revision-types';
import { inventoryTableBindingKey } from './inventory-table-binding';
import type { InventoryTableBinding } from './inventory-table-types';
import { inventoryHasImportedAttribution } from './inventory-attribution';
import { validateInventoryPhysicalState } from './inventory-configuration';
import { validateInventoryItemCodes } from './inventory-item-codes';
import { validateInventoryTemperatureState } from './inventory-storage-conditions';
import {
  normalizeInventoryTemperature,
  normalizeInventoryTemperatureRange,
} from './inventory-temperature';
import {
  INVENTORY_TEMPERATURE_DECIMAL_PATTERN,
  type InventoryTemperatureClaim,
  type InventoryEquipmentSetpoint,
  type InventoryStorageRequirement,
  type InventoryThermalContext,
} from './inventory-temperature-types';
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
  INVENTORY_PLATE_PLAN_OBSERVATION_SCHEMA,
  INVENTORY_PLATE_PLAN_SCHEMA,
  INVENTORY_CITATION_SCHEMA,
  INVENTORY_RUN_CONTEXT_SCHEMA,
  INVENTORY_NOTEBOOK_CONTEXT_SCHEMA,
  INVENTORY_STOCKROOM_SCHEMA,
  INVENTORY_ARRIVAL_SCHEMA,
  INVENTORY_VALIDITY_SCHEMA,
  INVENTORY_LOT_CONTROLS_SCHEMA,
  INVENTORY_AMOUNTS_SCHEMA,
  INVENTORY_HIERARCHY_SCHEMA,
  INVENTORY_CONTENTS_SCHEMA,
  INVENTORY_SOURCE_REVISION_SCHEMA,
  INVENTORY_STOCKTAKE_SCHEMA,
  INVENTORY_RECEIVE_TABLE_SCHEMA,
  INVENTORY_ADOPTION_SCHEMA,
  INVENTORY_THERMAL_CONTEXT_SCHEMA,
  INVENTORY_TEMPERATURE_SCHEMA,
  INVENTORY_ITEM_CODE_SCHEMA,
  INVENTORY_CATALOG_SCHEMA,
  INVENTORY_ITEM_CODE_NAMESPACE_PATTERN,
  INVENTORY_ITEM_CODE_VALUE_PATTERN,
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
  type InventoryAdoptionSource,
  type InventoryCommand,
  type InventoryItemCode,
  type InventoryItemCodeQuery,
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
  type InventoryQuantityInput,
  type InventoryVolumeQuantity,
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

const nullValue: Codec<null> = {
  schema: { type: 'null' },
  parse(value) {
    return value === null ? null : invalid('Expected an explicit null value.');
  },
};
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
const adoptionSource = fields('Inventory archive source', {
  archiveSha256: text('Archive SHA-256', 71, true, '^sha256:[a-f0-9]{64}$'),
  projectId: text('Archive project identifier', 4096, true),
  inventoryId: text('Archive inventory identifier', 256, true),
  revision: integer('Archive source revision', 1, Number.MAX_SAFE_INTEGER),
});
const recordedPrincipal = union('Inventory recorded attribution', [
  principal,
  fields('Imported inventory attribution', {
    kind: literal('imported'),
    source: adoptionSource,
    principal,
  }),
]);
const recordedAuthority = union('Inventory recorded authority', [
  authority,
  fields('Imported inventory authority', {
    kind: literal('imported'),
    source: adoptionSource,
    authority,
  }),
]);
const inventoryOrigin = union('Inventory origin', [
  fields('Native inventory origin', { kind: literal('native') }),
  fields('Archive-adopted inventory origin', {
    kind: literal('archive-adoption'),
    source: adoptionSource,
    at: timestamp,
    by: principal,
  }),
]);

export function parseInventoryAdoptionSource(value: unknown): InventoryAdoptionSource {
  return adoptionSource.parse(value);
}

const itemCodeNamespace = text(
  'Item code namespace',
  64,
  false,
  INVENTORY_ITEM_CODE_NAMESPACE_PATTERN
);
const itemCodeValue = text('Exact item code value', 512, false, INVENTORY_ITEM_CODE_VALUE_PATTERN);
const itemCodeQuery: Codec<InventoryItemCodeQuery> = fields('Item code query', {
  namespace: nullable(itemCodeNamespace),
  value: itemCodeValue,
});
const itemCodeRecord: Codec<InventoryItemCode> = fields('Physical item code', {
  id,
  namespace: itemCodeNamespace,
  value: itemCodeValue,
  item: reservationItem,
  assignedAt: timestamp,
  assignedBy: recordedPrincipal,
  reason,
  lifecycle: union('Item code lifecycle', [
    fields('Active item code', { kind: literal('active') }),
    fields('Retired item code', {
      kind: literal('retired'),
      at: timestamp,
      by: recordedPrincipal,
      reason,
    }),
  ]),
});
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
    holder: recordedPrincipal,
    at: timestamp,
    dueAt: deadline,
    lastKnown: locationObservation,
  }),
  fields('In-transit item custody', {
    kind: literal('in-transit'),
    reason,
    holder: recordedPrincipal,
    at: timestamp,
    destination: custodyDestination,
    lastKnown: locationObservation,
  }),
  fields('Missing item custody', {
    kind: literal('missing'),
    holder: nullable(recordedPrincipal),
    reportedBy: recordedPrincipal,
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
const volumeQuantity: Codec<InventoryVolumeQuantity> = union('Stock quantity', [
  fields('Unknown quantity', { kind: literal('unknown') }),
  checked(fields('Known quantity', { kind: literal('known'), ...volumeFields }), validateVolume),
]);
const storedVolumeQuantity = checked(volumeQuantity, (value) => {
  if (value.kind === 'unknown') return;
  const normalized = normalizeInventoryVolume(value);
  if (value.unit !== normalized.unit || value.value !== normalized.value)
    invalid('Stored inventory quantities require canonical uL decimal values.');
});

const amountFields = {
  value: volumeFields.value,
  unit: union(
    'Amount unit',
    INVENTORY_AMOUNT_UNITS.map((unit) => literal(unit))
  ),
};
const amount: Codec<InventoryAmount> = checked(fields('Amount', amountFields), (value) => {
  try {
    normalizeInventoryAmount(value);
  } catch (error) {
    invalid(error instanceof Error ? error.message : 'Invalid amount.');
  }
});
const quantity: Codec<InventoryQuantityInput> = union('Stock quantity input', [
  fields('Legacy unknown volume amount', { kind: literal('unknown') }),
  fields('Unknown amount in a declared unit', {
    kind: literal('unknown'),
    unit: amountFields.unit,
  }),
  checked(fields('Known stock quantity', { kind: literal('known'), ...amountFields }), (value) => {
    try {
      normalizeInventoryAmount(value);
    } catch (error) {
      invalid(error instanceof Error ? error.message : 'Invalid stock quantity.');
    }
  }),
]);
const storedQuantity: Codec<InventoryQuantity> = checked(
  union('Canonical stock quantity', [
    fields('Unknown stock balance', {
      kind: literal('unknown'),
      unit: union(
        'Canonical balance unit',
        ['uL', 'ng', 'nmol', 'item'].map((unit) => literal(unit as 'uL' | 'ng' | 'nmol' | 'item'))
      ),
    }),
    fields('Known stock balance', {
      kind: literal('known'),
      value: volumeFields.value,
      unit: union(
        'Canonical balance unit',
        ['uL', 'ng', 'nmol', 'item'].map((unit) => literal(unit as 'uL' | 'ng' | 'nmol' | 'item'))
      ),
    }),
  ]),
  (value) => {
    const normalized = normalizeInventoryQuantity(value);
    if (
      normalized.unit !== value.unit ||
      (value.kind === 'known' && (normalized.kind !== 'known' || normalized.value !== value.value))
    )
      invalid('Stored stock quantities require their canonical declared unit and exact amount.');
  }
);
const storedAmount: Codec<InventoryCanonicalAmount> = checked(
  fields('Canonical amount', {
    value: volumeFields.value,
    unit: union(
      'Canonical amount unit',
      ['uL', 'ng', 'nmol', 'item'].map((unit) => literal(unit as 'uL' | 'ng' | 'nmol' | 'item'))
    ),
  }),
  (value) => {
    const normalized = normalizeInventoryAmount(value);
    if (normalized.unit !== value.unit || normalized.value !== value.value)
      invalid('Stored amounts require canonical units and exact decimal values.');
  }
);

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
const sortedIds = checked(array(id, Number.MAX_SAFE_INTEGER, 1), (value) => {
  if (value.some((key, index) => index > 0 && key <= value[index - 1]))
    invalid('Fact root identifiers must be sorted and distinct.');
});
const openingState: Codec<InventoryOpeningState> = union('Stock opening knowledge', [
  fields('Unobserved opening without fact', {
    kind: literal('unobserved'),
    observationId: nullValue,
  }),
  fields('Corrected unobserved opening', { kind: literal('unobserved'), observationId: id }),
  fields('Observed sealed stock', { kind: literal('sealed-observed'), observationId: id }),
  fields('Observed opened stock', { kind: literal('opened-observed'), observationId: id }),
]);
const validityManagement: Codec<InventoryValidityManagement> = union('Validity management', [
  fields('Untracked validity', { kind: literal('legacy-untracked') }),
  fields('Managed validity', { kind: literal('managed'), rootIds: sortedIds }),
]);
const inheritedValidity = checked(
  array(
    fields('Inherited validity family', { rootId: id, openingNoLaterThan: deadline }),
    Number.MAX_SAFE_INTEGER
  ),
  (value) => {
    if (value.some((ref, index) => index > 0 && ref.rootId <= value[index - 1].rootId))
      invalid('Inherited validity roots must be sorted and distinct.');
  }
);
const validityOwner: Codec<InventoryValidityOwner> = union('Validity decision owner', [
  fields('Stock validity owner', { kind: literal('stock'), stockId: id }),
  fields('Lot validity owner', { kind: literal('lot'), lotId: id }),
]);
const validityRule: Codec<InventoryValidityRule> = union('Validity interpretation', [
  fields('Unresolved expiry interpretation', { kind: literal('unresolved') }),
  fields('No required expiry policy', { kind: literal('not-required') }),
  fields('Explicit expiry instant', { kind: literal('absolute'), deadlineAt: timestamp }),
  fields('Explicit elapsed limit after opening', {
    kind: literal('after-opening'),
    openingStockId: id,
    elapsedMs: integer('Elapsed duration', 1, Number.MAX_SAFE_INTEGER),
  }),
]);
const lotConstraints: Codec<InventoryLotConstraints> = checked(
  fields('Lot constraint owners', {
    knowledge: union('Lot constraint knowledge', [literal('recorded'), literal('legacy-partial')]),
    lotIds: array(id, Number.MAX_SAFE_INTEGER),
  }),
  (value) => {
    if (value.lotIds.some((key, index) => index > 0 && key <= value.lotIds[index - 1]))
      invalid('Lot constraint identifiers must be sorted and distinct.');
  }
);
const lotControls: Codec<InventoryLotControls> = union('Lot quality controls', [
  fields('Legacy lot policy', { kind: literal('legacy-untracked') }),
  fields('Managed lot quality', {
    kind: literal('managed'),
    assessment: fields('Local lot assessment', {
      value: union('Lot assessment', [
        literal('unassessed'),
        literal('released'),
        literal('quarantined'),
        literal('rejected'),
      ]),
      at: timestamp,
      by: recordedPrincipal,
      reason,
    }),
  }),
]);
const compositionLotRecord = fields('Previous composed lot record', {
  id,
  materialId: id,
  name,
  origin: lotOrigin,
});
const controlledLotRecord = fields('Previous controlled lot record', {
  id,
  materialId: id,
  name,
  origin: lotOrigin,
  controls: lotControls,
  lotConstraints,
});
const previousSourceIdentity = fields('Previous source identity', previousSourceIdentityFields);
const previousContribution = fields('Previous material contribution', {
  ...previousSourceIdentityFields,
  quantity: volume,
});
const lotRecord = fields('Lot record', {
  id,
  materialId: id,
  name,
  origin: lotOrigin,
  controls: lotControls,
  lotConstraints,
  validity: validityManagement,
  inheritedValidity,
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
const limits = fields('Container limits', { capacity: volumeQuantity, deadVolume: volumeQuantity });
const storedLimits = fields('Stored container limits', {
  capacity: storedVolumeQuantity,
  deadVolume: storedVolumeQuantity,
});
const withdrawal = fields('Material withdrawal', { stockId: id, quantity: volume });
const derivedOutput = { lotId: id, stockId: id, vesselId, materialId: id, name, reason };
const transferFields = {
  kind: literal('transfer'),
  sourceStockId: id,
  quantity: amount,
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
  quantity: amount,
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
const sha256: Codec<InventoryArrival['sourceSha256']> = text(
  'Arrival SHA-256',
  71,
  false,
  '^sha256:[a-f0-9]{64}$'
) as Codec<InventoryArrival['sourceSha256']>;
const arrivalKey = text('Exact arrival source key', 1024);
const arrivalLabel = text('Arrival source text', 1024);
const arrivalLargeText: Codec<string> = {
  schema: { type: 'string', maxLength: 17 * 1024 * 1024 },
  parse(value) {
    if (typeof value !== 'string' || value.length > 17 * 1024 * 1024 || value.includes('\0'))
      return invalid('Retained arrival text must fit the inline limit without null characters.');
    return value;
  },
};
const arrivalNullableText = nullable(text('Arrival source identifier', 4096));
const arrivalPackage = fields('Received package', {
  key: arrivalKey,
  label: arrivalLabel,
  productCode: arrivalNullableText,
  packagingBatch: arrivalNullableText,
});
const arrivalSourceComponentFields = {
  key: arrivalKey,
  packageKey: nullable(arrivalKey),
  label: arrivalLabel,
  productCode: arrivalNullableText,
  componentBatch: arrivalNullableText,
};
const arrivalQuantityBasis = union('Original received quantity basis', [
  fields('Measured receiving quantity', { kind: literal('measurement'), reason }),
  fields('Supplier declared receiving quantity', {
    kind: literal('supplier-declared'),
    claimKey: arrivalKey,
    reason,
  }),
  fields('Unknown receiving quantity', { kind: literal('unknown'), reason }),
]);
const arrivalVessel = fields('Original received vessel', { name, placement: vesselPlacement });
const arrivalComponentChoice = union('Original component disposition', [
  fields('Identified received component', {
    componentKey: arrivalKey,
    kind: literal('identified'),
    materialId: id,
    lot: union('Original received lot choice', [
      fields('Selected existing lot', { kind: literal('existing'), lotId: id, reason }),
      fields('Unattributed received material', { kind: literal('unattributed'), reason }),
      fields('Created managed received lot', {
        kind: literal('new'),
        lotKey: arrivalKey,
        name,
        supplier: name,
        lotNumber: text('Supplier lot number', 4096),
        managementReason: reason,
      }),
    ]),
    quantity: storedQuantity,
    quantityBasis: arrivalQuantityBasis,
    stockQuality: fields('Initial stock quality', { value: quality, reason }),
    vessel: arrivalVessel,
  }),
  fields('Unidentified received physical contents', {
    componentKey: arrivalKey,
    kind: literal('unidentified-physical'),
    vessel: arrivalVessel,
    reason,
  }),
  fields('Unobserved received physical contents', {
    componentKey: arrivalKey,
    kind: literal('unobserved-physical'),
    vessel: arrivalVessel,
    reason,
  }),
  fields('Observed missing delivery component', {
    componentKey: arrivalKey,
    kind: literal('observed-missing'),
    reason,
  }),
  fields('Evidence only delivery component', {
    componentKey: arrivalKey,
    kind: literal('evidence-only'),
    reason,
  }),
]);
const arrivalSelection = fields('Pinned supplier document selection', {
  documentKey: arrivalKey,
  expectedSha256: sha256,
  locator: union('Document selection locator', [
    fields('UTF8 byte selection', {
      kind: literal('utf8-byte-range'),
      startByte: integer('UTF8 selection start', 0, Number.MAX_SAFE_INTEGER),
      endByte: integer('UTF8 selection end', 1, Number.MAX_SAFE_INTEGER),
    }),
    fields('JSON source pointer', { kind: literal('json-pointer'), pointer: arrivalLargeText }),
    fields('Operator cited PDF region', {
      kind: literal('pdf-region'),
      page1Based: integer('PDF page', 1, Number.MAX_SAFE_INTEGER),
      description: reason,
    }),
  ]),
  verbatim: arrivalLargeText,
});
const arrivalClaim = fields('Recorded supplier claim', {
  key: arrivalKey,
  subject: union('Supplier claim subject', [
    fields('Delivery claim subject', { kind: literal('delivery') }),
    fields('Package claim subject', { kind: literal('package'), packageKey: arrivalKey }),
    fields('Component claim subject', { kind: literal('component'), componentKey: arrivalKey }),
  ]),
  selection: arrivalSelection,
  claim: union('Supplier claim interpretation', [
    fields('Supplier QC claim', { kind: literal('supplier-qc'), resultText: arrivalLargeText }),
    fields('Supplier quantity claim', {
      kind: literal('quantity'),
      valueLexeme: text('Source numeric lexeme', 4096),
      unitText: text('Source quantity unit', 4096),
    }),
    fields('Supplier identifier claim', {
      kind: literal('identifier'),
      role: union('Supplier identifier role', [
        literal('product'),
        literal('packaging-batch'),
        literal('component-batch'),
      ]),
      value: text('Source identifier value', 4096),
    }),
    fields('Supplier date or condition claim', {
      kind: literal('date-or-condition'),
      text: arrivalLargeText,
    }),
  ]),
  verification: union('Selection verification', [
    literal('exact-text-selection'),
    literal('operator-cited-pdf-region'),
  ]),
});
const arrivalRecord: Codec<InventoryArrival> = fields('Immutable arrival record', {
  id,
  identity: fields('Physical delivery identity', {
    namespace: text('Arrival namespace', 64, true, '^[a-z][a-z0-9._:-]{0,63}$'),
    arrivalId: arrivalKey,
  }),
  sourceSha256: sha256,
  admissionSha256: sha256,
  supplier: nullable(arrivalLabel),
  observedAt: deadline,
  observationReason: reason,
  scope: fields('Observed delivery scope', {
    kind: union('Delivery scope', [
      literal('selected-components'),
      literal('complete-listed-manifest'),
    ]),
    reason,
  }),
  documents: array(
    fields('Retained supplier document metadata', {
      key: arrivalKey,
      mediaType: union('Supplier document media', [
        literal('text/plain'),
        literal('text/csv'),
        literal('application/json'),
        literal('application/pdf'),
      ]),
      reference: nullable(sourceReference),
      coverage: union('Document coverage', [
        fields('Full retained original', { kind: literal('full') }),
        fields('Retained document excerpt', { kind: literal('excerpt'), reason }),
      ]),
      sha256,
      byteLength: integer('Retained byte length', 0, Number.MAX_SAFE_INTEGER),
    }),
    Number.MAX_SAFE_INTEGER
  ),
  packages: array(arrivalPackage, Number.MAX_SAFE_INTEGER),
  claims: array(arrivalClaim, Number.MAX_SAFE_INTEGER),
  components: array(
    fields('Original received component', {
      ...arrivalSourceComponentFields,
      choice: arrivalComponentChoice,
      target: fields('Original component physical targets', {
        componentKey: arrivalKey,
        lotId: nullable(id),
        stockId: nullable(id),
        vesselId: nullable(id),
      }),
      receivedQuantity: nullable(storedQuantity),
    }),
    Number.MAX_SAFE_INTEGER,
    1
  ),
  at: timestamp,
  by: recordedPrincipal,
});
const stockroomRecorded = { id, at: timestamp, by: recordedPrincipal, reason };
const expectedDeliveryRecord: Codec<InventoryExpectedDelivery> = fields(
  'Expected delivery statement',
  {
    ...stockroomRecorded,
    name,
    supplier: nullable(name),
    externalReference: nullable(sourceReference),
    expectation: fields('Expected material amount', { materialId: id, quantity: storedAmount }),
    lifecycle: union('Expectation remainder lifecycle', [
      fields('Open expectation', { kind: literal('open') }),
      fields('Closed unmatched remainder', {
        kind: literal('remainder-closed'),
        remainingAtClose: storedAmount,
        at: timestamp,
        by: recordedPrincipal,
        reason,
      }),
    ]),
  }
);
const arrivalAllocationRecord: Codec<InventoryArrivalAllocation> = fields(
  'Original arrival amount allocation',
  {
    ...stockroomRecorded,
    lineId: id,
    arrivalId: id,
    componentKey: arrivalKey,
    quantity: storedAmount,
    lifecycle: union('Arrival allocation lifecycle', [
      fields('Active original receipt allocation', { kind: literal('active') }),
      fields('Withdrawn receipt allocation', {
        kind: literal('withdrawn'),
        at: timestamp,
        by: recordedPrincipal,
        reason,
      }),
    ]),
  }
);
const reorderValidityBasis = union('Reorder validity coverage', [
  literal('current-recorded-rules'),
  literal('confirmed-current-validity'),
]);
const reorderActionBasis = union('Reorder action policy', [
  literal('reserve'),
  literal('withdraw'),
]);
const reorderRuleRecord: Codec<InventoryReorderRule> = fields('Reorder threshold rule', {
  ...stockroomRecorded,
  name,
  materialId: id,
  threshold: storedAmount,
  validityBasis: reorderValidityBasis,
  actionBasis: reorderActionBasis,
  lifecycle: union('Reorder rule lifecycle', [
    fields('Active reorder rule', { kind: literal('active') }),
    fields('Retired reorder rule', {
      kind: literal('retired'),
      at: timestamp,
      by: recordedPrincipal,
      reason,
    }),
  ]),
});
const openingInputFields = { id, stockId: id, source: nullable(sourceReference), reason };
const openingRecordedFields = { ...openingInputFields, at: timestamp, by: recordedPrincipal };
const openingObservationRecord: Codec<InventoryOpeningObservation> = union('Opening fact', [
  fields('Initial opening observation', {
    ...openingRecordedFields,
    kind: literal('initial'),
    value: union('Initial opening value', [literal('sealed'), literal('opened')]),
    observedAt: deadline,
    supersedesId: nullValue,
  }),
  fields('First opening observation', {
    ...openingRecordedFields,
    kind: literal('opening'),
    value: literal('opened'),
    observedAt: deadline,
    supersedesId: id,
  }),
  fields('Corrected first opening', {
    ...openingRecordedFields,
    kind: literal('correction'),
    value: literal('opened'),
    observedAt: deadline,
    supersedesId: id,
  }),
  fields('Correction admitting unknown opening', {
    ...openingRecordedFields,
    kind: literal('correction'),
    value: literal('unobserved'),
    observedAt: nullValue,
    supersedesId: id,
  }),
]);
const validityDecisionFields = {
  rule: validityRule,
  sourceText: {
    schema: { type: 'string', minLength: 0, maxLength: 65_536 },
    parse(value: unknown) {
      if (typeof value !== 'string' || value.length > 65_536 || value.includes('\0'))
        return invalid(
          'Expiry source text must be at most 65,536 characters without null characters.'
        );
      return value;
    },
  },
  sourcePrecision: union('Printed source precision', [
    literal('unknown'),
    literal('year'),
    literal('month'),
    literal('date'),
    literal('instant'),
    literal('elapsed-duration'),
  ]),
  source: nullable(sourceReference),
  reason,
};
const validityFactRecord: Codec<InventoryValidityFact> = fields('Validity interpretation fact', {
  ...validityDecisionFields,
  id,
  rootId: id,
  supersedesId: nullable(id),
  owner: validityOwner,
  at: timestamp,
  by: recordedPrincipal,
});
const lotRecallRecord: Codec<InventoryLotRecall> = fields('Lot recall', {
  id,
  lotId: id,
  observedAt: deadline,
  source: nullable(sourceReference),
  reason,
  at: timestamp,
  by: recordedPrincipal,
  lifecycle: union('Lot recall lifecycle', [
    fields('Active lot recall', { kind: literal('active') }),
    fields('Withdrawn lot recall', {
      kind: literal('withdrawn'),
      at: timestamp,
      by: recordedPrincipal,
      reason,
    }),
  ]),
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
        by: recordedPrincipal,
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
    by: recordedPrincipal,
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
  publishedBy: recordedPrincipal,
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
  publishedBy: recordedPrincipal,
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
  by: recordedPrincipal,
});
const temperature = checked(
  fields('Exact Celsius temperature', {
    value: text('Signed temperature decimal', 128, true, INVENTORY_TEMPERATURE_DECIMAL_PATTERN),
    unit: literal('C'),
  }),
  (value) => {
    try {
      normalizeInventoryTemperature(value);
    } catch (error) {
      invalid(error instanceof Error ? error.message : 'Invalid temperature.');
    }
  }
);
const temperatureRange = checked(
  fields('Inclusive temperature range', {
    minimum: temperature,
    maximum: temperature,
  }),
  (value) => {
    try {
      normalizeInventoryTemperatureRange(value);
    } catch (error) {
      invalid(error instanceof Error ? error.message : 'Invalid temperature range.');
    }
  }
);
const temperatureKnowledge = union('Reported temperature knowledge', [
  fields('Unknown reported target', { kind: literal('unknown') }),
  fields('Known reported target', { kind: literal('known'), temperature }),
]);
const specifiedSetpointRange = fields('Specified setpoint range', {
  kind: literal('specified-setpoint-range'),
  range: temperatureRange,
});
const legacyQualifiedEnvelopeFields = {
  kind: literal('qualified-envelope'),
  range: temperatureRange,
  atSetpoint: temperature,
  assumptions: reason,
};
const legacyQualifiedEnvelope = fields(
  'Legacy installed qualified envelope',
  legacyQualifiedEnvelopeFields
);
const previousTemperatureAssertion = union('V10 temperature source assertion', [
  specifiedSetpointRange,
  legacyQualifiedEnvelope,
]);
const temperatureAssertion = union('Temperature source assertion', [
  specifiedSetpointRange,
  legacyQualifiedEnvelope,
  fields('Physical and thermal arrangement qualified envelope', {
    ...legacyQualifiedEnvelopeFields,
    scope: literal('physical-and-thermal-arrangement'),
  }),
]);
const temperatureClaimFacts = {
  id,
  subject: fitSubject,
  assertion: temperatureAssertion,
  observedAt: deadline,
  source: nullable(sourceReference),
  reason,
};
const setpointFacts = {
  item: reservationItem,
  value: temperatureKnowledge,
  observedAt: deadline,
  source: nullable(sourceReference),
  reason,
};
const thermalContextFacts = {
  item: reservationItem,
  value: union('Thermal context relationship', [
    fields('Inherit surrounding thermal context', { kind: literal('inherit') }),
    fields('Use own thermal context', { kind: literal('self') }),
    fields('Unknown thermal context relationship', { kind: literal('unknown') }),
  ]),
  observedAt: deadline,
  source: nullable(sourceReference),
  reason,
};
const thermalContextRecord: Codec<InventoryThermalContext> = fields('Recorded thermal context', {
  ...thermalContextFacts,
  at: timestamp,
  by: recordedPrincipal,
});
const storageRequirementTarget = fields('Storage requirement target', {
  kind: union('Storage requirement target kind', [literal('stock'), literal('lot')]),
  id,
});
const storageRequirementValue = union('Storage requirement override', [
  fields('Inherit lot requirement', { kind: literal('inherit') }),
  fields('Unknown storage requirement', { kind: literal('unknown') }),
  fields('Specified storage requirement', { kind: literal('specified'), range: temperatureRange }),
]);
const storageRequirementFacts = {
  target: storageRequirementTarget,
  value: storageRequirementValue,
  observedAt: deadline,
  source: nullable(sourceReference),
  reason,
};
const temperatureInstallationFields = {
  item: reservationItem,
  configurationRevision: revision,
  typeVersionId: nullable(id),
  geometry,
  orientation,
  unavailablePositionIds: array(slot, MAX_INVENTORY_STORAGE_SLOTS, 0, true),
  layout: nullable(layout),
  limits: nullable(limits),
  placement: union('Qualified relative placement', [root, located]),
  lifecycle,
};
const thermalRelationship = union('Thermal relationship kind', [
  literal('inherit'),
  literal('self'),
  literal('unknown'),
]);
const temperatureClaimFields = {
  ...temperatureClaimFacts,
  at: timestamp,
  by: recordedPrincipal,
  lifecycle: union('Temperature claim lifecycle', [
    fields('Active temperature claim', { kind: literal('active') }),
    fields('Withdrawn temperature claim', {
      kind: literal('withdrawn'),
      at: timestamp,
      by: recordedPrincipal,
      reason,
    }),
  ]),
};
const previousTemperatureClaimRecord = fields('V10 temperature claim', {
  ...temperatureClaimFields,
  assertion: previousTemperatureAssertion,
  installation: nullable(
    array(
      fields('V10 qualified physical installation entry', temperatureInstallationFields),
      Number.MAX_SAFE_INTEGER,
      1
    )
  ),
});
const temperatureClaimRecord: Codec<InventoryTemperatureClaim> = fields('Temperature claim', {
  ...temperatureClaimFields,
  installation: nullable(
    array(
      fields('Qualified physical installation entry', {
        ...temperatureInstallationFields,
        thermalRelationship: nullable(thermalRelationship),
      }),
      Number.MAX_SAFE_INTEGER,
      1
    )
  ),
});
const setpointRecord: Codec<InventoryEquipmentSetpoint> = fields('Reported equipment setpoint', {
  ...setpointFacts,
  at: timestamp,
  by: recordedPrincipal,
});
const storageRequirementRecord: Codec<InventoryStorageRequirement> = fields(
  'Recorded storage requirement',
  {
    ...storageRequirementFacts,
    at: timestamp,
    by: recordedPrincipal,
  }
);
function temperatureFactMap<T>(codec: Codec<T>, value: unknown): Readonly<Record<string, T>> {
  const rows = Object.entries(object(value, 'Temperature fact map'));
  const result: Record<string, T> = Object.create(null);
  for (const [key, input] of rows)
    result[text('Temperature fact key', 1100, true).parse(key)] = codec.parse(input);
  return result;
}
const observationSubject = union('Observation subject', [
  fields('Observed stock', { kind: literal('stock'), stockId: id }),
  fields('Observed physical item', { kind: literal('item'), item: reservationItem }),
]);
const observationFact = <Q extends InventoryQuantityInput>(quantityCodec: Codec<Q>) =>
  union('Observation fact', [
    fields('Quantity observation', { kind: literal('quantity'), quantity: quantityCodec }),
    fields('Missing observation', { kind: literal('presence'), value: literal('missing') }),
    fields('Found observation', {
      kind: literal('presence'),
      value: literal('found'),
      destination: custodyDestination,
    }),
  ]);
const observationFacts = {
  namespace: text('Observation namespace', 256),
  observationId: text('Observation identity', 256),
  subject: observationSubject,
  observedAt: nullable(timestamp),
  fact: observationFact(quantity),
  reason,
};
const validateObservationSubject = (value: InventoryObservationInput) => {
  if ((value.subject.kind === 'stock') !== (value.fact.kind === 'quantity'))
    invalid('Stock observations measure quantity; item observations record presence.');
};
const observationRecordFor = <Q extends InventoryQuantityInput>(quantityCodec: Codec<Q>) =>
  checked(
    fields('Recorded inventory observation', {
      ...observationFacts,
      fact: observationFact(quantityCodec),
      at: timestamp,
      by: recordedPrincipal,
      application: union('Observation application', [
        fields('Unapplied observation', { kind: literal('unapplied') }),
        fields('Applied observation', {
          kind: literal('applied'),
          reason,
          at: timestamp,
          by: recordedPrincipal,
        }),
      ]),
    }),
    validateObservationSubject
  );
const observationRecord = observationRecordFor(storedQuantity);
const previousObservationRecord = observationRecordFor(storedVolumeQuantity);
function observations(value: unknown, current: boolean): Record<string, InventoryObservation> {
  const result = Object.create(null) as Record<string, InventoryObservation>;
  for (const [key, raw] of Object.entries(object(value, 'Inventory observations'))) {
    const parsed = current ? observationRecord.parse(raw) : previousObservationRecord.parse(raw);
    const observation: InventoryObservation =
      parsed.fact.kind === 'quantity'
        ? {
            ...parsed,
            fact: { kind: 'quantity', quantity: normalizeInventoryQuantity(parsed.fact.quantity) },
          }
        : { ...parsed, fact: parsed.fact };
    if (key !== inventoryObservationKey(observation.namespace, observation.observationId))
      invalid('An observation key must match its exact namespace and identity.');
    result[key] = observation;
  }
  return result;
}
const commands = {
  'record-inventory-observation': checked(
    fields('Record inventory observation command', {
      kind: literal('record-inventory-observation'),
      ...observationFacts,
    }),
    validateObservationSubject
  ),
  'apply-inventory-observation': fields('Apply recorded inventory observation command', {
    kind: literal('apply-inventory-observation'),
    observationKey: text('Observation key', 71, false, '^sha256:[a-f0-9]{64}$'),
    reason,
  }),
  'record-thermal-context': fields('Record explicit thermal context command', {
    kind: literal('record-thermal-context'),
    ...thermalContextFacts,
  }),
  'record-temperature-claim': checked(
    fields('Record scoped temperature claim command', {
      kind: literal('record-temperature-claim'),
      ...temperatureClaimFacts,
    }),
    (value) => {
      if (value.assertion.kind === 'qualified-envelope' && value.subject.kind !== 'installed')
        invalid('A qualification must identify an exact installed configuration.');
    }
  ),
  'withdraw-temperature-claim': fields('Withdraw temperature claim command', {
    kind: literal('withdraw-temperature-claim'),
    claimId: id,
    reason,
  }),
  'record-equipment-setpoint': fields('Record operator-reported equipment setpoint command', {
    kind: literal('record-equipment-setpoint'),
    ...setpointFacts,
  }),
  'record-storage-requirement': checked(
    fields('Record formulation storage requirement command', {
      kind: literal('record-storage-requirement'),
      ...storageRequirementFacts,
    }),
    (value) => {
      if (value.target.kind === 'lot' && value.value.kind === 'inherit')
        invalid('Only a stock can inherit a lot storage requirement.');
    }
  ),
  'attach-item-code': fields('Attach physical item code command', {
    kind: literal('attach-item-code'),
    id,
    namespace: itemCodeNamespace,
    value: itemCodeValue,
    item: reservationItem,
    reason,
  }),
  'retire-item-code': fields('Retire physical item code command', {
    kind: literal('retire-item-code'),
    codeId: id,
    reason,
  }),
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
  'record-expected-delivery': fields('Record expected delivery command', {
    kind: literal('record-expected-delivery'),
    id,
    name,
    supplier: nullable(name),
    externalReference: nullable(sourceReference),
    materialId: id,
    quantity: amount,
    reason,
  }),
  'allocate-arrival': fields('Allocate original arrival amount command', {
    kind: literal('allocate-arrival'),
    id,
    lineId: id,
    arrivalId: id,
    componentKey: arrivalKey,
    quantity: amount,
    reason,
  }),
  'withdraw-arrival-allocation': fields('Withdraw arrival matching command', {
    kind: literal('withdraw-arrival-allocation'),
    allocationId: id,
    reason,
  }),
  'close-expected-delivery-remainder': fields('Close unmatched expectation command', {
    kind: literal('close-expected-delivery-remainder'),
    lineId: id,
    reason,
  }),
  'reopen-expected-delivery': fields('Reopen expected delivery command', {
    kind: literal('reopen-expected-delivery'),
    lineId: id,
    reason,
  }),
  'record-reorder-rule': fields('Record reorder rule command', {
    kind: literal('record-reorder-rule'),
    id,
    name,
    materialId: id,
    threshold: amount,
    validityBasis: reorderValidityBasis,
    actionBasis: reorderActionBasis,
    reason,
  }),
  'retire-reorder-rule': fields('Retire reorder rule command', {
    kind: literal('retire-reorder-rule'),
    ruleId: id,
    reason,
  }),
  'record-stock-opening': fields('Record stock opening command', {
    ...openingInputFields,
    kind: literal('record-stock-opening'),
    value: union('Recorded opening value', [literal('sealed'), literal('opened')]),
    observedAt: deadline,
  }),
  'correct-stock-opening': union('Correct stock opening command', [
    fields('Correct first opening command', {
      ...openingInputFields,
      kind: literal('correct-stock-opening'),
      supersedesId: id,
      value: literal('opened'),
      observedAt: deadline,
    }),
    fields('Admit opening knowledge unknown command', {
      ...openingInputFields,
      kind: literal('correct-stock-opening'),
      supersedesId: id,
      value: literal('unobserved'),
      observedAt: nullValue,
    }),
  ]),
  'record-validity-decision': fields('Record validity interpretation command', {
    ...validityDecisionFields,
    kind: literal('record-validity-decision'),
    id,
    owner: validityOwner,
  }),
  'correct-validity-decision': fields('Correct validity interpretation command', {
    ...validityDecisionFields,
    kind: literal('correct-validity-decision'),
    id,
    supersedesId: id,
  }),
  'manage-lot': fields('Manage lot command', { kind: literal('manage-lot'), lotId: id, reason }),
  'assess-lot': fields('Assess lot command', {
    kind: literal('assess-lot'),
    lotId: id,
    assessment: union('Lot assessment decision', [
      literal('released'),
      literal('quarantined'),
      literal('rejected'),
    ]),
    reason,
  }),
  'record-lot-recall': fields('Record lot recall command', {
    kind: literal('record-lot-recall'),
    id,
    lotId: id,
    observedAt: deadline,
    source: nullable(sourceReference),
    reason,
  }),
  'withdraw-lot-recall': fields('Withdraw lot recall command', {
    kind: literal('withdraw-lot-recall'),
    recallId: id,
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
  'record-vessel-contents': fields('Record unresolved vessel contents command', {
    kind: literal('record-vessel-contents'),
    vesselId,
    knowledge: union('Unresolved contents knowledge', [
      literal('unobserved'),
      literal('unidentified'),
    ]),
    reason,
  }),
  'record-vessels-contents': fields('Record unresolved vessel contents batch command', {
    kind: literal('record-vessels-contents'),
    vesselIds: array(vesselId, MAX_INVENTORY_STORAGE_SLOTS, 1, true),
    knowledge: union('Unresolved contents knowledge', [
      literal('unobserved'),
      literal('unidentified'),
    ]),
    reason,
  }),
  'declare-vessel-empty': fields('Declare vessel empty command', {
    kind: literal('declare-vessel-empty'),
    vesselId,
    reason,
  }),
  'identify-vessel-stock': fields('Identify existing vessel contents command', {
    kind: literal('identify-vessel-stock'),
    id,
    vesselId,
    materialId: id,
    quantity,
    quality,
    reason,
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
    quantity: amount,
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
      fields('Reservation fulfillment claim', { reservationId: id, quantity: amount }),
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

export function parseInventoryItemCodeQuery(value: unknown): InventoryItemCodeQuery {
  return itemCodeQuery.parse(value);
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
  quantity: storedVolumeQuantity,
  quality,
});
const materialStockFields = {
  id,
  vesselId,
  materialId: id,
  quantity: storedVolumeQuantity,
  quality,
  source: stockSource,
};
const materialStockRecord = fields('Previous stock record', materialStockFields);
const previousCompositionStockRecord = fields('Previous composition stock record', {
  ...materialStockFields,
  composition: storedComposition,
});
const amountStockRecord = fields('Previous amount stock record', {
  ...materialStockFields,
  quantity: storedQuantity,
  composition: storedComposition,
});
const controlledStockRecord = fields('Previous controlled stock record', {
  ...materialStockFields,
  quantity: storedQuantity,
  composition: storedComposition,
  lotConstraints,
});
const stockRecord = fields('Stock record', {
  ...materialStockFields,
  quantity: storedQuantity,
  composition: storedComposition,
  lotConstraints,
  opening: openingState,
  validity: validityManagement,
  inheritedValidity,
});
const scientificVesselSnapshot = fields('Scientific transfer vessel observation', {
  id: vesselId,
  kind: union('Observed vessel kind', [literal('movable'), literal('fixed-well')]),
  name,
  placement: vesselPlacement,
});
const scientificTransferRecord = fields('Scientific transfer observation', {
  kind: literal('transfer'),
  sourceStockId: id,
  quantity: storedAmount,
  destination: fields('New scientific aliquot', {
    kind: literal('new-stock'),
    stockId: id,
    vesselId,
  }),
  reason,
});
const scientificWorkRecord: Codec<InventoryScientificWork> = fields('Scientific work observation', {
  id,
  identity: fields('Stable scientific work identity', {
    namespace: arrivalKey,
    workId: arrivalKey,
  }),
  intentSha256: sha256,
  context: union('Saved scientific context', [
    fields('Saved notebook scientific context', {
      kind: literal('notebook-page'),
      projectId: id,
      workspaceScope: id,
      pageId: id,
      source: fields('Native observed saved notebook source', {
        kind: literal('native-observed-saved-source'),
        sha256,
        fileObjectUuid: id,
        title: text('Saved notebook source title', 17 * 1024 * 1024),
      }),
    }),
    fields('Saved protocol run scientific context', {
      kind: literal('protocol-run'),
      projectId: id,
      workspaceScope: id,
      entityId: id,
      source: fields('Native observed saved protocol run source', {
        kind: literal('native-observed-saved-source'),
        sha256,
        fileObjectUuid: id,
        title: text('Saved protocol run source title', 17 * 1024 * 1024),
      }),
    }),
  ]),
  observation: fields('Completed manual observation', {
    kind: literal('completed-manual-transfer'),
  }),
  transfer: scientificTransferRecord,
  effects: fields('Scientific transfer effects', {
    source: fields('Source stock observation', {
      before: stockRecord,
      after: stockRecord,
      vessel: scientificVesselSnapshot,
    }),
    destination: fields('Destination stock observation', {
      before: nullValue,
      after: stockRecord,
      vessel: scientificVesselSnapshot,
    }),
  }),
  at: timestamp,
  by: recordedPrincipal,
  reason,
});
const platePlanVersionRecord: Codec<InventoryPlatePlanVersion> = fields(
  'Reusable plate plan version',
  {
    id,
    identity: fields('Plate plan family identity', { namespace: arrivalKey, planId: arrivalKey }),
    definitionSha256: sha256,
    definition: { schema: { type: 'object' }, parse: parseInventoryPlatePlanDefinition },
    at: timestamp,
    by: recordedPrincipal,
    reason,
  }
);

export function parseInventoryPlatePlanVersion(value: unknown): InventoryPlatePlanVersion {
  const version = platePlanVersionRecord.parse(value);
  try {
    validateInventoryPlatePlanVersion(version);
  } catch (error) {
    invalid(error instanceof Error ? error.message : 'Invalid plate plan version.');
  }
  return version;
}
export function parseInventoryRecordedPrincipal(value: unknown) {
  return recordedPrincipal.parse(value);
}
export function parseInventoryStorage(value: unknown) {
  return storageRecord.parse(value);
}
export function parseInventoryStock(value: unknown) {
  return stockRecord.parse(value);
}
export function parseInventoryVessel(value: unknown) {
  return vesselRecord.parse(value);
}

const scientificCitationContext = fields('Saved scientific citation context', {
  kind: union('Scientific citation source kind', [
    literal('notebook-page'),
    literal('protocol-run'),
  ]),
  projectId: id,
  workspaceScope: id,
  entityId: id,
  source: fields('Native observed saved citation source', {
    kind: literal('native-observed-saved-source'),
    sha256,
    fileObjectUuid: id,
    title: text('Saved citation source title', 17 * 1024 * 1024),
  }),
});
const scientificCitationRecord: Codec<InventoryScientificCitation> = fields('Scientific citation', {
  id,
  identity: fields('Stable scientific citation identity', {
    namespace: arrivalKey,
    citationId: arrivalKey,
  }),
  intentSha256: sha256,
  workId: id,
  workIntentSha256: sha256,
  reinstates: union('Scientific citation predecessor', [
    nullValue,
    fields('Withdrawn citation predecessor', {
      citationId: id,
      citationIntentSha256: sha256,
      withdrawalId: id,
      withdrawalIntentSha256: sha256,
    }),
  ]),
  context: scientificCitationContext,
  at: timestamp,
  by: recordedPrincipal,
  reason,
});
const scientificCitationWithdrawalRecord: Codec<InventoryScientificCitationWithdrawal> = fields(
  'Scientific citation withdrawal',
  {
    id,
    identity: fields('Stable citation withdrawal identity', {
      namespace: arrivalKey,
      withdrawalId: arrivalKey,
    }),
    intentSha256: sha256,
    citationId: id,
    citationIntentSha256: sha256,
    workId: id,
    workIntentSha256: sha256,
    at: timestamp,
    by: recordedPrincipal,
    reason,
  }
);

const runValueAttributionRecord: Codec<InventoryRunValueAttribution> = fields(
  'Saved Run value attribution',
  {
    id,
    identity: fields('Run value attribution identity', {
      namespace: arrivalKey,
      attributionId: arrivalKey,
    }),
    intentSha256: sha256,
    runValue: fields('Exact saved Run value', {
      entityId: id,
      sourceSha256: sha256,
      collection: union('Run value collection', [
        literal('inputs'),
        literal('outputs'),
        literal('measurements'),
      ]),
      key: arrivalKey,
      rowSha256: sha256,
    }),
    physical: fields('Recorded physical subject', {
      observationId: id,
      observationIntentSha256: sha256,
      subject: union('Plate-plan observation subject', [
        fields('Recorded source stock', { kind: literal('source-stock'), stockId: id }),
        fields('Recorded output action', {
          kind: literal('output-action'),
          actionId: arrivalKey,
          stockId: id,
        }),
      ]),
    }),
    predecessor: union('Run value attribution predecessor', [
      nullValue,
      fields('Withdrawn Run value attribution', {
        attributionId: id,
        attributionIntentSha256: sha256,
        withdrawalId: id,
        withdrawalIntentSha256: sha256,
      }),
    ]),
    source: fields('Native observed saved Run value source', {
      kind: literal('native-observed-saved-source'),
      projectId: id,
      workspaceScope: id,
      fileObjectUuid: id,
      title: text('Saved Run source title', 17 * 1024 * 1024),
    }),
    valueSnapshot: { schema: { type: 'object' }, parse: parseInventoryRunValueSnapshot },
    origin: union('Saved Run value origin', [
      fields('Local actual value', { kind: literal('local-actual') }),
      fields('Frozen declaration value', {
        kind: literal('frozen-declaration'),
        definitionSha256: sha256,
      }),
    ]),
    at: timestamp,
    by: recordedPrincipal,
    reason,
  }
);
const runValueAttributionWithdrawalRecord: Codec<InventoryRunValueAttributionWithdrawal> = fields(
  'Run value attribution withdrawal',
  {
    id,
    identity: fields('Run value attribution withdrawal identity', {
      namespace: arrivalKey,
      withdrawalId: arrivalKey,
    }),
    intentSha256: sha256,
    attributionId: id,
    attributionIntentSha256: sha256,
    at: timestamp,
    by: recordedPrincipal,
    reason,
  }
);
export function parseInventoryRunValueAttribution(value: unknown): InventoryRunValueAttribution {
  return runValueAttributionRecord.parse(value);
}
export function parseInventoryRunValueAttributionWithdrawal(
  value: unknown
): InventoryRunValueAttributionWithdrawal {
  return runValueAttributionWithdrawalRecord.parse(value);
}

const platePlanObservationRecord: Codec<InventoryPlatePlanObservation> = fields(
  'Completed manual plate-plan observation',
  {
    id,
    identity: fields('Plate-plan occurrence identity', {
      namespace: arrivalKey,
      observationId: arrivalKey,
    }),
    intentSha256: sha256,
    context: scientificCitationContext,
    observation: fields('Whole completed manual plate-plan report', {
      kind: literal('reported-completed-manual-plate-plan'),
    }),
    binding: fields('Exact plate-plan occurrence binding', {
      versionId: id,
      definitionSha256: sha256,
      destinationPlateId: id,
      sources: array(
        fields('Plate-plan source role binding', {
          sourceSlotKey: text('Logical source role key', 512),
          stockId: id,
        }),
        MAX_INVENTORY_BATCH_COMMANDS,
        1
      ),
    }),
    plate: fields('Recorded plate logical geometry and placement', {
      id,
      name,
      layout: fields('Recorded fixed-well logical geometry', {
        kind: literal('fixed-well'),
        rows: integer('Recorded plate rows', 1, MAX_INVENTORY_STORAGE_SLOTS),
        columns: integer('Recorded plate columns', 1, MAX_INVENTORY_STORAGE_SLOTS),
      }),
      placement: storagePlacement,
    }),
    actions: array(
      fields('Completed plan action', {
        actionId: text('Logical action key', 512),
        ordinal: integer('Action ordinal', 1, MAX_INVENTORY_BATCH_COMMANDS),
        sourceSlotKey: text('Logical source role key', 512),
        transfer: scientificTransferRecord,
      }),
      MAX_INVENTORY_BATCH_COMMANDS,
      1
    ),
    effects: fields('Whole plate-plan batch effects', {
      sources: array(
        fields('Grouped original and final source facts', {
          sourceSlotKeys: array(
            text('Logical source role key', 512),
            MAX_INVENTORY_BATCH_COMMANDS,
            1,
            true
          ),
          before: stockRecord,
          after: stockRecord,
          vessel: scientificVesselSnapshot,
        }),
        MAX_INVENTORY_BATCH_COMMANDS,
        1
      ),
      destinations: array(
        fields('Resulting plan aliquot facts', {
          actionId: text('Logical action key', 512),
          before: nullValue,
          after: stockRecord,
          vessel: scientificVesselSnapshot,
        }),
        MAX_INVENTORY_BATCH_COMMANDS,
        1
      ),
    }),
    at: timestamp,
    by: recordedPrincipal,
    reason,
  }
);
export function parseInventoryPlatePlanObservation(value: unknown): InventoryPlatePlanObservation {
  return platePlanObservationRecord.parse(value);
}

export function parseInventoryScientificCitation(value: unknown): InventoryScientificCitation {
  return scientificCitationRecord.parse(value);
}
export function parseInventoryScientificCitationWithdrawal(
  value: unknown
): InventoryScientificCitationWithdrawal {
  return scientificCitationWithdrawalRecord.parse(value);
}

const reservationVolume = checked(volume, (value) => {
  const normalized = normalizeInventoryVolume(value);
  if (normalized.value !== value.value || normalized.unit !== value.unit)
    invalid('Stored reservation volumes require canonical uL decimal values.');
});
const reservationFacts = {
  id,
  holder: recordedPrincipal,
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
      authority: recordedAuthority,
    }),
    fields('Expired reservation', { kind: literal('expired'), at: timestamp }),
  ]),
};
const reservationRecordFor = <Q extends InventoryAmount>(quantityCodec: Codec<Q>) =>
  union('Reservation record', [
    fields('Quantity reservation record', {
      ...reservationFacts,
      kind: literal('quantity'),
      stockId: id,
      quantity: quantityCodec,
      remaining: quantityCodec,
    }),
    fields('Item reservation record', {
      ...reservationFacts,
      kind: literal('item'),
      item: reservationItem,
    }),
  ]);

const reservationRecord = reservationRecordFor(storedAmount);
const previousReservationRecord = reservationRecordFor(reservationVolume);

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

const configuredVesselRecord = union('Vessel record', [
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

const contentsKnowledgeRecord: Codec<InventoryContentsKnowledge> = union(
  'Vessel contents knowledge',
  [
    fields('Recorded vessel contents declaration', { kind: literal('recorded') }),
    fields('Unobserved vessel contents', {
      kind: literal('unobserved'),
      reason,
      at: timestamp,
      by: recordedPrincipal,
    }),
    fields('Unidentified vessel contents', {
      kind: literal('unidentified'),
      reason,
      at: timestamp,
      by: recordedPrincipal,
    }),
  ]
);
const vesselRecord: Pick<Codec<InventoryVessel>, 'parse'> = {
  parse(input) {
    const { contentsKnowledge, ...facts } = object(input, 'Vessel record');
    return {
      ...configuredVesselRecord.parse(facts),
      contentsKnowledge: contentsKnowledgeRecord.parse(contentsKnowledge),
    };
  },
};

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
  for (const binding of Object.values(state.vesselBindings)) {
    const vessel = Object.hasOwn(state.vessels, binding.vesselId)
      ? state.vessels[binding.vesselId]
      : null;
    if (!vessel || vessel.kind !== binding.origin.kind)
      invalid('A vessel binding must reference an existing vessel of its original kind.');
    if (binding.origin.kind === 'movable') {
      const placement = binding.origin.placement;
      if (placement.kind === 'located') {
        const storage = Object.hasOwn(state.storage, placement.storageId)
          ? state.storage[placement.storageId]
          : null;
        if (!storage || !positionsById.get(storage.id)!.has(placement.slotId))
          invalid('An original movable vessel destination requires an existing storage position.');
        if (storage.layout.kind === 'fixed-well')
          invalid('A movable vessel source cannot originate in a permanent-well position.');
      }
    } else {
      const storage = Object.hasOwn(state.storage, binding.origin.storageId)
        ? state.storage[binding.origin.storageId]
        : null;
      if (
        !storage ||
        storage.layout.kind !== 'fixed-well' ||
        !positionsById.get(storage.id)!.has(binding.origin.position) ||
        binding.vesselId !== inventoryWellId(storage.id, binding.origin.position)
      )
        invalid('A permanent vessel source must identify its original plate and exact position.');
    }
  }
  const allIds = new Set<string>();
  for (const rows of inventoryIdentityMaps(state)) {
    for (const identifier of Object.keys(rows)) {
      if (allIds.has(identifier)) invalid('Inventory record identifiers must be distinct.');
      allIds.add(identifier);
    }
  }
  for (const row of [...Object.values(state.stocks), ...Object.values(state.lots)]) {
    for (const lotId of row.lotConstraints.lotIds)
      if (!Object.hasOwn(state.lots, lotId))
        invalid('Lot constraint owners must reference existing lots.');
    const ownLot = 'controls' in row ? row.id : row.source.kind === 'lot' ? row.source.lotId : null;
    if (ownLot !== null && !row.lotConstraints.lotIds.includes(ownLot))
      invalid('Lot constraints must retain the current source owner.');
    if (!('controls' in row) && row.source.kind === 'lot') {
      const sourceLot = state.lots[row.source.lotId];
      if (
        sourceLot &&
        (sourceLot.lotConstraints.lotIds.some((key) => !row.lotConstraints.lotIds.includes(key)) ||
          (sourceLot.lotConstraints.knowledge === 'legacy-partial' &&
            row.lotConstraints.knowledge === 'recorded'))
      )
        invalid('Stock constraints must retain its source lot restrictions and uncertainty.');
    }

    if (
      'controls' in row &&
      row.controls.kind === 'managed' &&
      row.controls.assessment.at > state.lastRecordedAt
    )
      invalid('Lot assessment cannot exceed the recorded inventory clock.');
  }
  for (const [key, recall] of Object.entries(state.lotRecalls)) {
    if (key !== recall.id || !Object.hasOwn(state.lots, recall.lotId))
      invalid('Lot recalls require their exact identity and existing lot.');
    if (
      recall.at > state.lastRecordedAt ||
      (recall.observedAt !== null && recall.observedAt > recall.at)
    )
      invalid('Recall observations must be inside their recorded lifetime.');
    if (
      recall.lifecycle.kind === 'withdrawn' &&
      (recall.lifecycle.at < recall.at || recall.lifecycle.at > state.lastRecordedAt)
    )
      invalid('Recall withdrawal must follow recording inside the inventory clock.');
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
    if (
      vessel.contentsKnowledge.kind !== 'recorded' &&
      vessel.contentsKnowledge.at > state.lastRecordedAt
    )
      invalid('Contents knowledge cannot exceed the recorded inventory clock.');
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
  for (const lot of Object.values(state.lots)) {
    const origin = lot.origin;
    const inputs =
      origin.kind === 'received'
        ? []
        : origin.kind === 'diluted'
          ? [origin.sample, origin.diluent]
          : origin.inputs;
    for (const input of inputs) {
      if (input.source.kind === 'lot') {
        const inherited = state.lots[input.source.lotId].lotConstraints;
        if (
          inherited.lotIds.some((key) => !lot.lotConstraints.lotIds.includes(key)) ||
          (inherited.knowledge === 'legacy-partial' && lot.lotConstraints.knowledge === 'recorded')
        )
          invalid('Derived lots must retain immutable input lot restrictions and uncertainty.');
      }
    }
  }

  const stockVessels = new Set<string>();
  for (const stock of Object.values(state.stocks)) {
    if (!Object.hasOwn(state.vessels, stock.vesselId))
      invalid('Every stock must reference an existing vessel.');
    if (state.vessels[stock.vesselId].contentsKnowledge.kind !== 'recorded')
      invalid('An identified stock requires recorded vessel contents knowledge.');
    if (stockVessels.has(stock.vesselId)) invalid('This version supports one stock per vessel.');
    stockVessels.add(stock.vesselId);
    validateSource(stock);
    const capacity = state.vessels[stock.vesselId].limits.capacity;
    if (
      stock.quantity.kind === 'known' &&
      stock.quantity.unit === 'uL' &&
      capacity.kind === 'known' &&
      compareInventoryVolumes({ value: stock.quantity.value, unit: 'uL' }, capacity) > 0
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
      const comparison = compareInventoryAmounts(reservation.remaining, reservation.quantity);
      if (
        reservation.quantity.value === '0' ||
        comparison.kind === 'incompatible' ||
        comparison.order > 0
      )
        invalid(
          'A reservation requires positive original quantity and a bounded remaining quantity.'
        );
      if (reservation.remaining.unit !== state.stocks[reservation.stockId].quantity.unit)
        invalid('Quantity reservations must match the stock balance basis.');
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

const tableDestination = union('Table source destination', [
  fields('New vessel source destination', {
    kind: literal('new-vessel'),
    placement: vesselPlacement,
  }),
  fields('Existing vessel source destination', { kind: literal('existing-vessel') }),
]);
const tableRowHash = text('Table row hash', 71, false, '^sha256:[a-f0-9]{64}$') as Codec<
  InventoryTableBinding['rowSha256']
>;
const sourceFields: Codec<InventoryTableSourceRevision['fields']> = {
  schema: { type: 'object' },
  parse(input) {
    const issues = inventoryReceiveTableFieldIssues(input);
    if (issues.length) return invalid(issues[0].message);
    return { ...(input as InventoryTableSourceRevision['fields']) };
  },
};
const tableSourceRevision: Codec<InventoryTableSourceRevision> = fields(
  'Accepted table source revision',
  {
    previousRowSha256: tableRowHash,
    rowSha256: tableRowHash,
    fields: sourceFields,
    destination: tableDestination,
    reason,
    at: timestamp,
    by: recordedPrincipal,
  }
);
const tableBindingProperties = {
  namespace: text('Table source namespace', 256),
  sourceId: text('Table source identity', 256),
  rowSha256: tableRowHash,
  stockId: id,
  vesselId,
  materialId: id,
  destination: tableDestination,
};
const previousTableBindingRecord = fields('Previous table source binding', tableBindingProperties);
const tableBindingRecord: Codec<InventoryTableBinding> = fields('Table source binding', {
  ...tableBindingProperties,
  sourceRevisions: array(tableSourceRevision, Number.MAX_SAFE_INTEGER),
});

function tableBindings(
  value: unknown,
  sourceRevisions: boolean
): Record<string, InventoryTableBinding> {
  const result = Object.create(null) as Record<string, InventoryTableBinding>;
  for (const [key, raw] of Object.entries(object(value, 'Table source bindings'))) {
    const binding = sourceRevisions
      ? tableBindingRecord.parse(raw)
      : { ...previousTableBindingRecord.parse(raw), sourceRevisions: [] };
    if (key !== inventoryTableBindingKey(binding.namespace, binding.sourceId))
      invalid('A table binding key must match its exact source namespace and identity.');
    let previousHash = binding.rowSha256;
    for (const revision of binding.sourceRevisions) {
      if (
        revision.previousRowSha256 !== previousHash ||
        revision.rowSha256 !== inventoryReceiveTableRowSha256(revision.fields) ||
        revision.fields.source_id !== binding.sourceId
      )
        invalid(
          'A source revision must preserve source identity and its verified previous-hash chain.'
        );
      if (
        revision.destination.kind !== binding.destination.kind ||
        (revision.fields.vessel_kind === 'new') !== (revision.destination.kind === 'new-vessel')
      )
        invalid('A source revision cannot change its bound vessel kind.');
      if (
        revision.destination.kind === 'new-vessel' &&
        ((revision.destination.placement.kind === 'unplaced' && revision.fields.slot !== '') ||
          (revision.destination.placement.kind === 'located' &&
            revision.fields.slot !== revision.destination.placement.slotId))
      )
        invalid('An accepted source slot must match its saved destination decision.');
      previousHash = revision.rowSha256;
    }
    result[key] = binding;
  }
  return result;
}

const hierarchyBindingRecord: Codec<InventoryHierarchyBinding> = fields(
  'Hierarchy source binding',
  {
    namespace: text('Hierarchy source namespace', 256),
    sourceId: text('Hierarchy source identity', 256),
    rowSha256: tableRowHash,
    storageId: id,
    destination: storagePlacement,
  }
);
function hierarchyBindings(value: unknown): Record<string, InventoryHierarchyBinding> {
  const result = Object.create(null) as Record<string, InventoryHierarchyBinding>;
  const physicalIds = new Set<string>();
  for (const [key, raw] of Object.entries(object(value, 'Hierarchy source bindings'))) {
    const binding = hierarchyBindingRecord.parse(raw);
    if (key !== inventoryTableBindingKey(binding.namespace, binding.sourceId))
      invalid('A hierarchy binding key must match its exact source namespace and identity.');
    if (physicalIds.has(binding.storageId))
      invalid('Each hierarchy source must bind a distinct storage record.');
    physicalIds.add(binding.storageId);
    result[key] = binding;
  }
  return result;
}

const vesselBindingRecord: Codec<InventoryVesselBinding> = fields('Vessel source binding', {
  namespace: text('Vessel source namespace', 256),
  sourceId: text('Vessel source identity', 256),
  rowSha256: tableRowHash,
  vesselId,
  origin: union('Original vessel source destination', [
    fields('Movable vessel source origin', {
      kind: literal('movable'),
      placement: vesselPlacement,
    }),
    fields('Permanent well source origin', {
      kind: literal('fixed-well'),
      storageId: id,
      position: slot,
    }),
  ]),
});
function vesselBindings(value: unknown): Record<string, InventoryVesselBinding> {
  const result = Object.create(null) as Record<string, InventoryVesselBinding>;
  const physicalIds = new Set<string>();
  for (const [key, raw] of Object.entries(object(value, 'Vessel source bindings'))) {
    const binding = vesselBindingRecord.parse(raw);
    if (key !== inventoryTableBindingKey(binding.namespace, binding.sourceId))
      invalid('A vessel binding key must match its exact source namespace and identity.');
    if (physicalIds.has(binding.vesselId))
      invalid('Each vessel source must bind a distinct vessel record.');
    physicalIds.add(binding.vesselId);
    result[key] = binding;
  }
  return result;
}

export function parseInventoryScientificWork(value: unknown): InventoryScientificWork {
  return scientificWorkRecord.parse(value);
}

export function parseInventoryState(value: unknown): InventoryState {
  const row = object(value, 'Inventory state');
  const current = row.schema === INVENTORY_SCHEMA;
  const platePlanObservationRecords =
    current || row.schema === INVENTORY_PLATE_PLAN_OBSERVATION_SCHEMA;
  const platePlanRecords =
    platePlanObservationRecords || row.schema === INVENTORY_PLATE_PLAN_SCHEMA;
  const citationRecords = platePlanRecords || row.schema === INVENTORY_CITATION_SCHEMA;
  const runContextRecords = citationRecords || row.schema === INVENTORY_RUN_CONTEXT_SCHEMA;
  const scientificRecords = runContextRecords || row.schema === INVENTORY_NOTEBOOK_CONTEXT_SCHEMA;
  const stockroomRecords = scientificRecords || row.schema === INVENTORY_STOCKROOM_SCHEMA;
  const arrivalRecords = stockroomRecords || row.schema === INVENTORY_ARRIVAL_SCHEMA;
  const validityRecords = arrivalRecords || row.schema === INVENTORY_VALIDITY_SCHEMA;
  const controlled = validityRecords || row.schema === INVENTORY_LOT_CONTROLS_SCHEMA;
  const amounts = controlled || row.schema === INVENTORY_AMOUNTS_SCHEMA;
  const contents = amounts || row.schema === INVENTORY_CONTENTS_SCHEMA;
  const hierarchySources = contents || row.schema === INVENTORY_HIERARCHY_SCHEMA;
  const sourceRevisions = hierarchySources || row.schema === INVENTORY_SOURCE_REVISION_SCHEMA;
  const observationRecords = sourceRevisions || row.schema === INVENTORY_STOCKTAKE_SCHEMA;
  const tableSources = observationRecords || row.schema === INVENTORY_RECEIVE_TABLE_SCHEMA;
  const archiveAttribution = tableSources || row.schema === INVENTORY_ADOPTION_SCHEMA;
  const thermalContexts = archiveAttribution || row.schema === INVENTORY_THERMAL_CONTEXT_SCHEMA;
  const temperature = thermalContexts || row.schema === INVENTORY_TEMPERATURE_SCHEMA;
  const itemCodes = temperature || row.schema === INVENTORY_ITEM_CODE_SCHEMA;
  const catalog = itemCodes || row.schema === INVENTORY_CATALOG_SCHEMA;
  const configuration = catalog || row.schema === INVENTORY_CONFIGURATION_SCHEMA;
  const custody = configuration || row.schema === INVENTORY_CUSTODY_SCHEMA;
  const reservation = custody || row.schema === INVENTORY_RESERVATION_SCHEMA;
  const composition = reservation || row.schema === INVENTORY_COMPOSITION_SCHEMA;
  const material = composition || row.schema === INVENTORY_MATERIAL_SCHEMA;
  const shape = fields('Inventory state', {
    schema: union('Inventory schema', [
      literal(INVENTORY_SCHEMA),
      literal(INVENTORY_PLATE_PLAN_OBSERVATION_SCHEMA),
      literal(INVENTORY_PLATE_PLAN_SCHEMA),
      literal(INVENTORY_CITATION_SCHEMA),
      literal(INVENTORY_RUN_CONTEXT_SCHEMA),
      literal(INVENTORY_NOTEBOOK_CONTEXT_SCHEMA),
      literal(INVENTORY_STOCKROOM_SCHEMA),
      literal(INVENTORY_ARRIVAL_SCHEMA),
      literal(INVENTORY_VALIDITY_SCHEMA),
      literal(INVENTORY_LOT_CONTROLS_SCHEMA),
      literal(INVENTORY_AMOUNTS_SCHEMA),
      literal(INVENTORY_CONTENTS_SCHEMA),
      literal(INVENTORY_HIERARCHY_SCHEMA),
      literal(INVENTORY_SOURCE_REVISION_SCHEMA),
      literal(INVENTORY_STOCKTAKE_SCHEMA),
      literal(INVENTORY_RECEIVE_TABLE_SCHEMA),
      literal(INVENTORY_ADOPTION_SCHEMA),
      literal(INVENTORY_THERMAL_CONTEXT_SCHEMA),
      literal(INVENTORY_TEMPERATURE_SCHEMA),
      literal(INVENTORY_ITEM_CODE_SCHEMA),
      literal(INVENTORY_CATALOG_SCHEMA),
      literal(INVENTORY_CONFIGURATION_SCHEMA),
      literal(INVENTORY_CUSTODY_SCHEMA),
      literal(INVENTORY_RESERVATION_SCHEMA),
      literal(INVENTORY_COMPOSITION_SCHEMA),
      literal(INVENTORY_MATERIAL_SCHEMA),
      literal(INVENTORY_LAYOUT_SCHEMA),
      literal(LEGACY_INVENTORY_SCHEMA),
    ]),
    revision,
    ...(current
      ? {
          runValueAttributions: { schema: { type: 'object' }, parse: (input: unknown) => input },
          runValueAttributionWithdrawals: {
            schema: { type: 'object' },
            parse: (input: unknown) => input,
          },
        }
      : {}),
    ...(platePlanObservationRecords
      ? { platePlanObservations: { schema: { type: 'object' }, parse: (input: unknown) => input } }
      : {}),
    ...(platePlanRecords
      ? { platePlanVersions: { schema: { type: 'object' }, parse: (input: unknown) => input } }
      : {}),
    ...(citationRecords
      ? {
          scientificCitations: { schema: { type: 'object' }, parse: (input: unknown) => input },
          scientificCitationWithdrawals: {
            schema: { type: 'object' },
            parse: (input: unknown) => input,
          },
        }
      : {}),
    ...(scientificRecords
      ? { scientificWorks: { schema: { type: 'object' }, parse: (input: unknown) => input } }
      : {}),
    ...(stockroomRecords
      ? {
          expectedDeliveries: { schema: { type: 'object' }, parse: (input: unknown) => input },
          arrivalAllocations: { schema: { type: 'object' }, parse: (input: unknown) => input },
          reorderRules: { schema: { type: 'object' }, parse: (input: unknown) => input },
        }
      : {}),
    ...(arrivalRecords
      ? { arrivals: { schema: { type: 'object' }, parse: (input: unknown) => input } }
      : {}),
    ...(validityRecords
      ? {
          openingObservations: { schema: { type: 'object' }, parse: (input: unknown) => input },
          validityFacts: { schema: { type: 'object' }, parse: (input: unknown) => input },
        }
      : {}),
    ...(controlled
      ? { lotRecalls: { schema: { type: 'object' }, parse: (input: unknown) => input } }
      : {}),
    ...(contents
      ? { vesselBindings: { schema: { type: 'object' }, parse: (input: unknown) => input } }
      : {}),
    ...(hierarchySources
      ? { hierarchyBindings: { schema: { type: 'object' }, parse: (input: unknown) => input } }
      : {}),
    ...(archiveAttribution ? { origin: inventoryOrigin } : {}),
    ...(observationRecords
      ? { observations: { schema: { type: 'object' }, parse: (input: unknown) => input } }
      : {}),
    ...(tableSources
      ? { tableBindings: { schema: { type: 'object' }, parse: (input: unknown) => input } }
      : {}),
    ...(thermalContexts
      ? { thermalContexts: { schema: { type: 'object' }, parse: (input: unknown) => input } }
      : {}),
    ...(temperature
      ? {
          temperatureClaims: { schema: { type: 'object' }, parse: (input: unknown) => input },
          equipmentSetpoints: { schema: { type: 'object' }, parse: (input: unknown) => input },
          storageRequirements: { schema: { type: 'object' }, parse: (input: unknown) => input },
        }
      : {}),
    ...(itemCodes
      ? { itemCodes: { schema: { type: 'object' }, parse: (input: unknown) => input } }
      : {}),
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
    if (contents) return vesselRecord.parse(raw);
    if (configuration)
      return { ...configuredVesselRecord.parse(raw), contentsKnowledge: { kind: 'recorded' } };
    if (custody)
      return {
        ...custodyVesselRecord.parse(raw),
        contentsKnowledge: { kind: 'recorded' },
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
          contentsKnowledge: { kind: 'recorded' },
          custody: { kind: 'available' },
          configuration: emptyInventoryPhysicalConfiguration(),
        }
      : {
          ...vessel,
          contentsKnowledge: { kind: 'recorded' },
          configuration: emptyInventoryPhysicalConfiguration(),
        };
  });
  let state: InventoryState = {
    schema: INVENTORY_SCHEMA,
    runValueAttributions: current
      ? records(shape.runValueAttributions, parseInventoryRunValueAttribution)
      : Object.create(null),
    runValueAttributionWithdrawals: current
      ? records(shape.runValueAttributionWithdrawals, parseInventoryRunValueAttributionWithdrawal)
      : Object.create(null),
    platePlanObservations: platePlanObservationRecords
      ? records(shape.platePlanObservations, parseInventoryPlatePlanObservation)
      : Object.create(null),
    platePlanVersions: platePlanRecords
      ? records(shape.platePlanVersions, parseInventoryPlatePlanVersion)
      : Object.create(null),
    scientificCitations: citationRecords
      ? records(shape.scientificCitations, (raw) => scientificCitationRecord.parse(raw))
      : Object.create(null),
    scientificCitationWithdrawals: citationRecords
      ? records(shape.scientificCitationWithdrawals, (raw) =>
          scientificCitationWithdrawalRecord.parse(raw)
        )
      : Object.create(null),
    scientificWorks: scientificRecords
      ? records(shape.scientificWorks, (raw) => {
          const work = scientificWorkRecord.parse(raw);
          if (!runContextRecords && work.context.kind !== 'notebook-page')
            invalid('Inventory v23 scientific work supports notebook context only.');
          return work;
        })
      : Object.create(null),
    expectedDeliveries: stockroomRecords
      ? records(shape.expectedDeliveries, (raw) => expectedDeliveryRecord.parse(raw))
      : Object.create(null),
    arrivalAllocations: stockroomRecords
      ? records(shape.arrivalAllocations, (raw) => arrivalAllocationRecord.parse(raw))
      : Object.create(null),
    reorderRules: stockroomRecords
      ? records(shape.reorderRules, (raw) => reorderRuleRecord.parse(raw))
      : Object.create(null),
    arrivals: arrivalRecords
      ? records(shape.arrivals, (raw) => arrivalRecord.parse(raw))
      : Object.create(null),
    openingObservations: validityRecords
      ? records(shape.openingObservations, (raw) => openingObservationRecord.parse(raw))
      : Object.create(null),
    validityFacts: validityRecords
      ? records(shape.validityFacts, (raw) => validityFactRecord.parse(raw))
      : Object.create(null),
    lotRecalls: controlled
      ? records(shape.lotRecalls, (raw) => lotRecallRecord.parse(raw))
      : Object.create(null),
    vesselBindings: contents ? vesselBindings(shape.vesselBindings) : Object.create(null),
    hierarchyBindings: hierarchySources
      ? hierarchyBindings(shape.hierarchyBindings)
      : Object.create(null),
    origin: archiveAttribution ? inventoryOrigin.parse(shape.origin) : { kind: 'native' },
    observations: observationRecords
      ? observations(shape.observations, amounts)
      : Object.create(null),
    tableBindings: tableSources
      ? tableBindings(shape.tableBindings, sourceRevisions)
      : Object.create(null),
    thermalContexts: thermalContexts
      ? temperatureFactMap(thermalContextRecord, shape.thermalContexts)
      : Object.create(null),
    temperatureClaims: temperature
      ? records(shape.temperatureClaims, (raw): InventoryTemperatureClaim => {
          if (thermalContexts) return temperatureClaimRecord.parse(raw);
          const claim = previousTemperatureClaimRecord.parse(raw);
          return {
            ...claim,
            installation:
              claim.installation?.map((entry) => ({ ...entry, thermalRelationship: null })) ?? null,
          };
        })
      : Object.create(null),
    equipmentSetpoints: temperature
      ? temperatureFactMap(setpointRecord, shape.equipmentSetpoints)
      : Object.create(null),
    storageRequirements: temperature
      ? temperatureFactMap(storageRequirementRecord, shape.storageRequirements)
      : Object.create(null),
    itemCodes: itemCodes
      ? records(shape.itemCodes, (raw) => itemCodeRecord.parse(raw))
      : (Object.create(null) as Record<string, InventoryItemCode>),
    typeVersions: configuration
      ? records(shape.typeVersions, (raw) =>
          catalog
            ? typeVersionRecord.parse(raw)
            : {
                ...previousTypeVersionRecord.parse(raw),
                selection: { kind: 'available' as const },
              }
        )
      : (Object.create(null) as Record<string, InventoryPhysicalTypeVersion>),
    recipeVersions: configuration
      ? records(shape.recipeVersions, (raw) =>
          catalog
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
      ? records(shape.reservations, (raw): InventoryReservation => {
          const parsed = amounts
            ? reservationRecord.parse(raw)
            : previousReservationRecord.parse(raw);
          return parsed.kind === 'quantity'
            ? {
                ...parsed,
                quantity: normalizeInventoryAmount(parsed.quantity),
                remaining: normalizeInventoryAmount(parsed.remaining),
              }
            : parsed;
        })
      : (Object.create(null) as Record<string, InventoryReservation>),
    storage,
    vessels,
    stocks: records(shape.stocks, (raw): InventoryStock => {
      if (validityRecords) return stockRecord.parse(raw);
      if (controlled)
        return { ...controlledStockRecord.parse(raw), ...emptyInventoryStockValidity() };
      const constraints: InventoryLotConstraints = { knowledge: 'legacy-partial', lotIds: [] };
      if (amounts)
        return {
          ...amountStockRecord.parse(raw),
          ...emptyInventoryStockValidity(),
          lotConstraints: constraints,
        };
      if (composition) {
        const stock = previousCompositionStockRecord.parse(raw);
        return {
          ...stock,
          quantity: normalizeInventoryQuantity(stock.quantity),
          ...emptyInventoryStockValidity(),
          lotConstraints: constraints,
        };
      }
      if (material) {
        const stock = materialStockRecord.parse(raw);
        return {
          ...stock,
          quantity: normalizeInventoryQuantity(stock.quantity),
          composition: { kind: 'unknown' },
          ...emptyInventoryStockValidity(),
          lotConstraints: constraints,
        };
      }
      const stock = previousStockRecord.parse(raw);
      return {
        ...stock,
        source: { kind: 'unattributed', rootStockId: stock.id },
        quantity: normalizeInventoryQuantity(stock.quantity),
        composition: { kind: 'unknown' },
        ...emptyInventoryStockValidity(),
        lotConstraints: constraints,
      };
    }),
    lots: material
      ? records(shape.lots, (raw): InventoryLot => {
          if (validityRecords) return lotRecord.parse(raw);
          if (controlled)
            return { ...controlledLotRecord.parse(raw), ...emptyInventoryLotValidity() };
          const legacy = ((): Omit<
            InventoryLot,
            'controls' | 'lotConstraints' | 'validity' | 'inheritedValidity'
          > => {
            if (composition) return compositionLotRecord.parse(raw);
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
          })();
          return {
            ...legacy,
            ...emptyInventoryLotValidity(),
            controls: { kind: 'legacy-untracked' },
            lotConstraints: { knowledge: 'legacy-partial', lotIds: [] },
          };
        })
      : (Object.create(null) as Record<string, InventoryLot>),
  };
  if (!controlled) {
    try {
      state = projectLegacyInventoryLotConstraints(state);
    } catch (error) {
      invalid(error instanceof Error ? error.message : 'Invalid legacy lot ancestry.');
    }
  }
  if (!archiveAttribution && inventoryHasImportedAttribution(state))
    invalid('Legacy inventory schemas cannot contain imported attribution.');
  if (state.origin.kind === 'archive-adoption' && state.origin.at > state.lastRecordedAt)
    invalid('Inventory adoption cannot exceed the recorded clock.');
  for (const observation of Object.values(state.observations)) {
    if (
      observation.at > state.lastRecordedAt ||
      (observation.observedAt !== null && observation.observedAt > observation.at)
    )
      invalid('Observation times must be inside their recorded lifetime.');
    if (
      observation.application.kind === 'applied' &&
      (observation.application.at < observation.at ||
        observation.application.at > state.lastRecordedAt)
    )
      invalid('Observation application must be inside its recorded lifetime.');
    const subject = observation.subject;
    if (
      subject.kind === 'stock'
        ? !Object.hasOwn(state.stocks, subject.stockId)
        : !Object.hasOwn(
            subject.item.kind === 'storage' ? state.storage : state.vessels,
            subject.item.id
          )
    )
      invalid('An observation requires an existing inventory subject.');
    if (
      observation.application.kind === 'applied' &&
      observation.fact.kind === 'quantity' &&
      subject.kind === 'stock' &&
      observation.fact.quantity.unit !== state.stocks[subject.stockId].quantity.unit
    )
      invalid('An applied quantity observation must match the stock balance basis.');
    if (observation.fact.kind === 'presence' && observation.fact.value === 'found') {
      const destination = observation.fact.destination;
      if (destination.kind === 'located' && !Object.hasOwn(state.storage, destination.storageId))
        invalid('An observed destination must reference existing storage.');
      if (destination.kind === 'stack-top' && !Object.hasOwn(state.storage, destination.stackId))
        invalid('An observed stack must reference existing storage.');
    }
  }
  for (const binding of Object.values(state.hierarchyBindings)) {
    if (!Object.hasOwn(state.storage, binding.storageId))
      invalid('A hierarchy binding must reference existing storage.');
    if (
      binding.destination.kind === 'located' &&
      !Object.hasOwn(state.storage, binding.destination.storageId)
    )
      invalid('An original hierarchy destination must reference existing storage.');
  }
  for (const binding of Object.values(state.tableBindings)) {
    let previousAt = 0;
    for (const revision of binding.sourceRevisions) {
      if (revision.at < previousAt || revision.at > state.lastRecordedAt)
        invalid('Source revision times must preserve their recorded lifetime.');
      previousAt = revision.at;
      if (
        revision.destination.kind === 'new-vessel' &&
        revision.destination.placement.kind === 'located' &&
        !Object.hasOwn(state.storage, revision.destination.placement.storageId)
      )
        invalid('An accepted source destination must reference existing storage.');
    }

    const stock = Object.hasOwn(state.stocks, binding.stockId)
      ? state.stocks[binding.stockId]
      : null;
    if (!stock || stock.vesselId !== binding.vesselId || stock.materialId !== binding.materialId)
      invalid('A table binding must reference its existing stock, vessel and scientific material.');
    if (
      binding.destination.kind === 'new-vessel' &&
      binding.destination.placement.kind === 'located' &&
      !Object.hasOwn(state.storage, binding.destination.placement.storageId)
    )
      invalid('An original table destination must reference existing storage.');
  }
  validateState(state);
  try {
    validateInventoryScientificState(state);
    validateInventoryScientificCitations(state);
    validateInventoryPlatePlans(state);
    validateInventoryPlatePlanObservations(state);
    validateInventoryRunValueAttributions(state);
    validateInventoryStockroomState(state);
    validateInventoryArrivalState(state);
    validateInventoryValidityState(state);
    validateInventoryItemCodes(state);
    validateInventoryTemperatureState(state);
    validateInventoryPhysicalState(state);
  } catch (error) {
    invalid(error instanceof Error ? error.message : 'Invalid physical configuration.');
  }
  return state;
}
