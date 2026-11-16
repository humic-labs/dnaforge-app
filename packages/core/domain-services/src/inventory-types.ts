import type {
  InventoryObservation,
  InventoryObservationCommand,
} from './inventory-observation-types';
export type * from './inventory-observation-types';
import type { InventoryTableBinding } from './inventory-table-types';
import type {
  InventoryPhysicalConfiguration,
  InventoryPhysicalTypeVersion,
  InventoryEquipmentRecipeVersion,
  InventoryFitEvidence,
  InventoryPhysicalProjection,
  InventoryConfigurationCommand,
} from './inventory-configuration-types';
export type * from './inventory-configuration-types';
import type {
  InventoryTemperatureClaim,
  InventoryEquipmentSetpoint,
  InventoryStorageRequirement,
  InventoryTemperatureCommand,
  InventoryThermalContext,
} from './inventory-temperature-types';
export type * from './inventory-temperature-types';
import type {
  InventoryComposition,
  InventoryConcentration,
  InventoryConcentrationUnit,
} from './inventory-concentration';

export type {
  InventoryComposition,
  InventoryConcentration,
  InventoryConcentrationUnit,
  InventoryCanonicalConcentrationUnit,
  InventoryRational,
} from './inventory-concentration';

export const INVENTORY_SCHEMA = 'dnaforge.inventory.v15' as const;
export const INVENTORY_STOCKTAKE_SCHEMA = 'dnaforge.inventory.v14' as const;
export const INVENTORY_RECEIVE_TABLE_SCHEMA = 'dnaforge.inventory.v13' as const;
export const INVENTORY_ADOPTION_SCHEMA = 'dnaforge.inventory.v12' as const;
export const INVENTORY_THERMAL_CONTEXT_SCHEMA = 'dnaforge.inventory.v11' as const;
export const INVENTORY_TEMPERATURE_SCHEMA = 'dnaforge.inventory.v10' as const;
export const INVENTORY_ITEM_CODE_SCHEMA = 'dnaforge.inventory.v9' as const;
export const INVENTORY_CATALOG_SCHEMA = 'dnaforge.inventory.v8' as const;
export const INVENTORY_CONFIGURATION_SCHEMA = 'dnaforge.inventory.v7' as const;
export const INVENTORY_CUSTODY_SCHEMA = 'dnaforge.inventory.v6' as const;
export const INVENTORY_RESERVATION_SCHEMA = 'dnaforge.inventory.v5' as const;
export const INVENTORY_COMPOSITION_SCHEMA = 'dnaforge.inventory.v4' as const;
export const INVENTORY_MATERIAL_SCHEMA = 'dnaforge.inventory.v3' as const;
export const INVENTORY_LAYOUT_SCHEMA = 'dnaforge.inventory.v2' as const;
export const INVENTORY_DECIMAL_PATTERN = '^(?:0|[1-9]\\d*)(?:\\.\\d+)?$';
export const LEGACY_INVENTORY_SCHEMA = 'dnaforge.inventory.v1' as const;
export const INVENTORY_VOLUME_UNITS = ['L', 'mL', 'uL', 'nL'] as const;
export const MAX_INVENTORY_BATCH_COMMANDS = 256;
export const MAX_INVENTORY_STORAGE_SLOTS = 10_000;
export const INVENTORY_ITEM_CODE_NAMESPACE_PATTERN = '^[a-z][a-z0-9._:-]{0,63}$(?![\\s\\S])';
export const INVENTORY_ITEM_CODE_VALUE_PATTERN =
  '^[\\x20-\\x7E]*[\\x21-\\x7E][\\x20-\\x7E]*$(?![\\s\\S])';

export type InventoryVolumeUnit = (typeof INVENTORY_VOLUME_UNITS)[number];
export type InventoryQuality = 'usable' | 'quarantined';
export type InventoryMixing = 'unknown' | 'homogeneous';
export type InventoryConcentrationInput =
  | InventoryConcentration
  | { readonly kind: 'unknown' }
  | {
      readonly kind: 'known';
      readonly value: string;
      readonly unit: InventoryConcentrationUnit;
    };
export type InventoryCompositionInput =
  | { readonly kind: 'unknown' }
  | {
      readonly kind: 'homogeneous';
      readonly analytes: Readonly<Record<string, InventoryConcentrationInput>>;
    };

export interface InventoryVolume {
  readonly value: string;
  readonly unit: InventoryVolumeUnit;
}

export type InventoryQuantity =
  | { readonly kind: 'unknown' }
  | ({ readonly kind: 'known' } & InventoryVolume);

export interface InventoryLocatedPlacement {
  readonly kind: 'located';
  readonly storageId: string;
  readonly slotId: string;
}

export type InventoryStoragePlacement = { readonly kind: 'root' } | InventoryLocatedPlacement;

export type InventoryVesselPlacement = { readonly kind: 'unplaced' } | InventoryLocatedPlacement;
export type InventoryPlacement = InventoryStoragePlacement | InventoryVesselPlacement;
export type InventoryCustodyDestination =
  | InventoryPlacement
  | { readonly kind: 'stack-top'; readonly stackId: string };

export interface InventoryLocationPathEntry {
  readonly item: InventoryPhysicalItem;
  readonly name: string;
  readonly position: string | null;
}

export interface InventoryLocationObservation {
  readonly observedAt: number;
  readonly placement: InventoryPlacement;
  readonly path: readonly InventoryLocationPathEntry[];
  readonly custodyRoot: InventoryPhysicalItem | null;
  readonly relativePath: readonly InventoryLocationPathEntry[];
  readonly relativeAt: number | null;
}

export type InventoryCustody =
  | { readonly kind: 'available' }
  | {
      readonly kind: 'checked-out';
      readonly reason: string;
      readonly holder: InventoryRecordedPrincipal;
      readonly at: number;
      readonly dueAt: number | null;
      readonly lastKnown: InventoryLocationObservation;
    }
  | {
      readonly kind: 'in-transit';
      readonly reason: string;
      readonly holder: InventoryRecordedPrincipal;
      readonly at: number;
      readonly destination: InventoryCustodyDestination;
      readonly lastKnown: InventoryLocationObservation;
    }
  | {
      readonly kind: 'missing';
      readonly holder: InventoryRecordedPrincipal | null;
      readonly reportedBy: InventoryRecordedPrincipal;
      readonly at: number;
      readonly reason: string;
      readonly lastKnown: InventoryLocationObservation;
    };

export interface InventoryEffectiveCustody {
  readonly root: InventoryPhysicalItem | null;
  readonly state: InventoryCustody;
  readonly inherited: boolean;
}

export interface InventoryItemCustody extends InventoryEffectiveCustody {
  readonly item: InventoryPhysicalItem;
  readonly placement: InventoryPlacement;
  readonly lastKnown: InventoryLocationObservation | null;
  readonly overdue: boolean;
  readonly blockers: readonly InventoryAvailabilityBlocker[];
  readonly actions: {
    readonly checkout: boolean;
    readonly startTransit: boolean;
    readonly return: boolean;
    readonly reportMissing: boolean;
    readonly locate: boolean;
  };
}

export type InventoryLayout =
  | { readonly kind: 'named'; readonly slots: readonly string[] }
  | { readonly kind: 'grid'; readonly rows: number; readonly columns: number }
  | { readonly kind: 'removable-tube'; readonly rows: number; readonly columns: number }
  | { readonly kind: 'fixed-well'; readonly rows: number; readonly columns: number }
  | { readonly kind: 'stack'; readonly capacity: number; readonly removal: 'top-only' };

export interface InventoryPhysicalItem {
  readonly kind: 'storage' | 'vessel';
  readonly id: string;
}

export interface InventoryStorage {
  readonly configuration: InventoryPhysicalConfiguration;
  readonly id: string;
  readonly name: string;
  readonly layout: InventoryLayout;
  readonly placement: InventoryStoragePlacement;
  readonly lifecycle: 'active' | 'disposed';
  readonly custody: InventoryCustody;
}

export interface InventoryVesselLimits {
  readonly capacity: InventoryQuantity;
  readonly deadVolume: InventoryQuantity;
}

interface InventoryVesselFacts {
  readonly configuration: InventoryPhysicalConfiguration;
  readonly limits: InventoryVesselLimits;
  readonly id: string;
  readonly name: string;
  readonly placement: InventoryVesselPlacement;
  readonly lifecycle: 'active' | 'disposed';
}
export type InventoryVessel = InventoryVesselFacts &
  (
    | { readonly kind: 'movable'; readonly custody: InventoryCustody }
    | { readonly kind: 'fixed-well' }
  );

export type InventoryStockSource =
  | { readonly kind: 'unattributed'; readonly rootStockId: string }
  | { readonly kind: 'lot'; readonly lotId: string };

export interface InventorySourceIdentity {
  readonly stockId: string;
  readonly materialId: string;
  readonly source: InventoryStockSource;
  readonly composition: InventoryComposition;
}

export interface InventoryContribution extends InventorySourceIdentity {
  readonly quantity: InventoryVolume;
}

export type InventoryLotOrigin =
  | { readonly kind: 'received'; readonly supplier: string; readonly lotNumber: string }
  | {
      readonly kind: 'prepared';
      readonly inputs: readonly InventorySourceIdentity[];
      readonly method: string;
    }
  | { readonly kind: 'pooled'; readonly inputs: readonly InventoryContribution[] }
  | {
      readonly kind: 'diluted';
      readonly sample: InventoryContribution;
      readonly diluent: InventoryContribution;
    };

export interface InventoryLot {
  readonly id: string;
  readonly materialId: string;
  readonly name: string;
  readonly origin: InventoryLotOrigin;
}

export interface InventoryStock {
  readonly id: string;
  readonly vesselId: string;
  readonly source: InventoryStockSource;
  readonly materialId: string;
  readonly quantity: InventoryQuantity;
  readonly quality: InventoryQuality;
  readonly composition: InventoryComposition;
}

export interface InventoryState {
  readonly observations: Readonly<Record<string, InventoryObservation>>;
  readonly tableBindings: Readonly<Record<string, InventoryTableBinding>>;
  readonly origin: InventoryOrigin;
  readonly thermalContexts: Readonly<Record<string, InventoryThermalContext>>;
  readonly temperatureClaims: Readonly<Record<string, InventoryTemperatureClaim>>;
  readonly equipmentSetpoints: Readonly<Record<string, InventoryEquipmentSetpoint>>;
  readonly storageRequirements: Readonly<Record<string, InventoryStorageRequirement>>;
  readonly itemCodes: Readonly<Record<string, InventoryItemCode>>;
  readonly typeVersions: Readonly<Record<string, InventoryPhysicalTypeVersion>>;
  readonly recipeVersions: Readonly<Record<string, InventoryEquipmentRecipeVersion>>;
  readonly fitEvidence: Readonly<Record<string, InventoryFitEvidence>>;
  readonly schema: typeof INVENTORY_SCHEMA;
  readonly revision: number;
  readonly lastRecordedAt: number;
  readonly storage: Readonly<Record<string, InventoryStorage>>;
  readonly vessels: Readonly<Record<string, InventoryVessel>>;
  readonly stocks: Readonly<Record<string, InventoryStock>>;
  readonly lots: Readonly<Record<string, InventoryLot>>;
  readonly reservations: Readonly<Record<string, InventoryReservation>>;
}

export type InventoryPrincipal =
  | { readonly kind: 'local-profile'; readonly profileKey: string }
  | { readonly kind: 'agent'; readonly identityId: string };

export interface InventoryAdoptionSource {
  readonly archiveSha256: string;
  readonly projectId: string;
  readonly inventoryId: string;
  readonly revision: number;
}
export type InventoryRecordedPrincipal =
  | InventoryPrincipal
  | {
      readonly kind: 'imported';
      readonly source: InventoryAdoptionSource;
      readonly principal: InventoryPrincipal;
    };
export type InventoryRecordedAuthority =
  | InventoryAuthority
  | {
      readonly kind: 'imported';
      readonly source: InventoryAdoptionSource;
      readonly authority: InventoryAuthority;
    };
export type InventoryOrigin =
  | { readonly kind: 'native' }
  | {
      readonly kind: 'archive-adoption';
      readonly source: InventoryAdoptionSource;
      readonly at: number;
      readonly by: InventoryPrincipal;
    };

export interface InventoryItemCode {
  readonly id: string;
  readonly namespace: string;
  readonly value: string;
  readonly item: InventoryPhysicalItem;
  readonly assignedAt: number;
  readonly assignedBy: InventoryRecordedPrincipal;
  readonly reason: string;
  readonly lifecycle:
    | { readonly kind: 'active' }
    | {
        readonly kind: 'retired';
        readonly at: number;
        readonly by: InventoryRecordedPrincipal;
        readonly reason: string;
      };
}
export interface InventoryItemCodeQuery {
  readonly namespace: string | null;
  readonly value: string;
}
export type InventoryItemCodeResolution =
  | { readonly kind: 'invalid'; readonly message: string }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'resolved'; readonly match: InventoryItemCode }
  | { readonly kind: 'retired'; readonly match: InventoryItemCode }
  | { readonly kind: 'ambiguous'; readonly matches: readonly InventoryItemCode[] };
export type InventoryItemCodeCommand =
  | {
      readonly kind: 'attach-item-code';
      readonly id: string;
      readonly namespace: string;
      readonly value: string;
      readonly item: InventoryPhysicalItem;
      readonly reason: string;
    }
  | { readonly kind: 'retire-item-code'; readonly codeId: string; readonly reason: string };

export interface InventoryAuthority {
  readonly kind: 'local-profile';
  readonly profileKey: string;
}

export interface InventoryExecutionContext {
  readonly at: number;
  readonly principal: InventoryPrincipal;
  readonly authority: InventoryAuthority;
}

export type InventoryReservationLifecycle =
  | { readonly kind: 'active' }
  | { readonly kind: 'fulfilled'; readonly at: number }
  | { readonly kind: 'released'; readonly at: number; readonly reason: string }
  | {
      readonly kind: 'cancelled';
      readonly at: number;
      readonly reason: string;
      readonly authority: InventoryRecordedAuthority;
    }
  | { readonly kind: 'expired'; readonly at: number };

interface InventoryReservationFacts {
  readonly id: string;
  readonly holder: InventoryRecordedPrincipal;
  readonly purpose: string;
  readonly createdAt: number;
  readonly deadline: number | null;
  readonly lifecycle: InventoryReservationLifecycle;
}

export type InventoryReservation = InventoryReservationFacts &
  (
    | {
        readonly kind: 'quantity';
        readonly stockId: string;
        readonly quantity: InventoryVolume;
        readonly remaining: InventoryVolume;
      }
    | { readonly kind: 'item'; readonly item: InventoryPhysicalItem }
  );

export type InventoryAvailabilityBlocker =
  | { readonly code: 'POSITION_UNAVAILABLE'; readonly item: InventoryPhysicalItem }
  | {
      readonly code: 'ITEM_CHECKED_OUT';
      readonly item: InventoryPhysicalItem;
      readonly holder: InventoryRecordedPrincipal;
    }
  | { readonly code: 'ITEM_IN_TRANSIT'; readonly item: InventoryPhysicalItem }
  | { readonly code: 'ITEM_MISSING'; readonly item: InventoryPhysicalItem }
  | { readonly code: 'QUANTITY_UNKNOWN' }
  | { readonly code: 'STOCK_QUARANTINED' }
  | { readonly code: 'VESSEL_DISPOSED' }
  | { readonly code: 'ALLOCATION_SHORTFALL' }
  | { readonly code: 'EXPIRY_PENDING' }
  | { readonly code: 'ITEM_RESERVED'; readonly reservationIds: readonly string[] };

export interface InventoryStockAvailability {
  readonly stockId: string;
  readonly onHand: InventoryQuantity;
  readonly held: InventoryVolume;
  readonly unreserved: InventoryQuantity;
  readonly mine: InventoryVolume;
  readonly deadVolume: InventoryQuantity;
  readonly blockers: readonly InventoryAvailabilityBlocker[];
  readonly reservationIds: readonly string[];
}

export interface InventoryReservationAvailability {
  readonly reservation: InventoryReservation;
  readonly mine: boolean;
  readonly overdue: boolean;
  readonly blockers: readonly InventoryAvailabilityBlocker[];
  readonly actions: {
    readonly release: boolean;
    readonly cancel: boolean;
    readonly expire: boolean;
    readonly fulfill: boolean;
  };
}

export interface InventoryAvailability {
  readonly physical: InventoryPhysicalProjection;
  readonly items: Readonly<Record<string, InventoryItemCustody>>;
  readonly stocks: Readonly<Record<string, InventoryStockAvailability>>;
  readonly reservations: Readonly<Record<string, InventoryReservationAvailability>>;
}

export interface InventoryWithdrawal {
  readonly stockId: string;
  readonly quantity: InventoryVolume;
}

export interface InventoryLegacyTransferCommand {
  readonly kind: 'transfer';
  readonly sourceStockId: string;
  readonly quantity: InventoryVolume;
  readonly destination:
    | { readonly kind: 'new-stock'; readonly stockId: string; readonly vesselId: string }
    | { readonly kind: 'existing-stock'; readonly stockId: string };
  readonly reason: string;
}

export interface InventoryLegacyPoolCommand {
  readonly kind: 'pool';
  readonly lotId: string;
  readonly stockId: string;
  readonly vesselId: string;
  readonly materialId: string;
  readonly name: string;
  readonly inputs: readonly InventoryWithdrawal[];
  readonly reason: string;
}

export interface InventoryLegacyDiluteCommand {
  readonly kind: 'dilute';
  readonly lotId: string;
  readonly stockId: string;
  readonly vesselId: string;
  readonly materialId: string;
  readonly name: string;
  readonly sample: InventoryWithdrawal;
  readonly diluent: InventoryWithdrawal;
  readonly reason: string;
}

export type InventoryMaterialCommand =
  | {
      readonly kind: 'create-lot';
      readonly id: string;
      readonly materialId: string;
      readonly name: string;
      readonly origin:
        | { readonly kind: 'received'; readonly supplier: string; readonly lotNumber: string }
        | {
            readonly kind: 'prepared';
            readonly sourceStockIds: readonly string[];
            readonly method: string;
          };
    }
  | {
      readonly kind: 'receive-lot-stock';
      readonly id: string;
      readonly vesselId: string;
      readonly lotId: string;
      readonly quantity: InventoryQuantity;
      readonly quality: InventoryQuality;
    }
  | {
      readonly kind: 'associate-stock-lot';
      readonly stockId: string;
      readonly lotId: string;
      readonly reason: string;
    }
  | {
      readonly kind: 'set-vessel-limits';
      readonly vesselId: string;
      readonly limits: InventoryVesselLimits;
      readonly reason: string;
    }
  | {
      readonly kind: 'record-composition';
      readonly stockId: string;
      readonly composition: InventoryCompositionInput;
      readonly reason: string;
    }
  | InventoryLegacyTransferCommand
  | (Omit<InventoryLegacyTransferCommand, 'destination'> & {
      readonly destination: { readonly kind: 'existing-stock'; readonly stockId: string };
      readonly mixing: InventoryMixing;
    })
  | InventoryLegacyPoolCommand
  | (InventoryLegacyPoolCommand & { readonly mixing: InventoryMixing })
  | InventoryLegacyDiluteCommand
  | (InventoryLegacyDiluteCommand & { readonly mixing: InventoryMixing });

export type InventoryCommand =
  | InventoryObservationCommand
  | InventoryTemperatureCommand
  | InventoryItemCodeCommand
  | InventoryConfigurationCommand
  | InventoryCustodyCommand
  | InventoryReservationCommand
  | InventoryMaterialCommand
  | {
      readonly kind: 'create-storage';
      readonly id: string;
      readonly name: string;
      readonly slots: readonly string[];
      readonly placement: InventoryStoragePlacement;
    }
  | {
      readonly kind: 'create-layout-storage';
      readonly id: string;
      readonly name: string;
      readonly layout: InventoryLayout;
      readonly placement: InventoryStoragePlacement;
    }
  | {
      readonly kind: 'create-vessel';
      readonly id: string;
      readonly name: string;
      readonly placement: InventoryVesselPlacement;
    }
  | ({ readonly kind: 'receive-stock' } & Omit<InventoryStock, 'source' | 'composition'>)
  | {
      readonly kind: 'move-storage';
      readonly id: string;
      readonly placement: InventoryStoragePlacement;
    }
  | {
      readonly kind: 'move-vessel';
      readonly id: string;
      readonly placement: InventoryVesselPlacement;
    }
  | {
      readonly kind: 'consume';
      readonly stockId: string;
      readonly quantity: InventoryVolume;
      readonly reason: string;
    }
  | {
      readonly kind: 'reconcile';
      readonly stockId: string;
      readonly quantity: InventoryQuantity;
      readonly reason: string;
    }
  | {
      readonly kind: 'set-quality';
      readonly stockId: string;
      readonly quality: InventoryQuality;
      readonly reason: string;
    }
  | { readonly kind: 'dispose-vessel'; readonly id: string; readonly reason: string }
  | { readonly kind: 'dispose-plate'; readonly id: string; readonly reason: string }
  | { readonly kind: 'push-stack'; readonly stackId: string; readonly item: InventoryPhysicalItem }
  | {
      readonly kind: 'pop-stack';
      readonly stackId: string;
      readonly item: InventoryPhysicalItem;
      readonly destination: InventoryStoragePlacement | InventoryVesselPlacement;
    };

export interface InventoryCommandBatch {
  readonly expectedRevision: number;
  readonly commands: readonly InventoryCommand[];
}

export type InventoryWithdrawalCommand = Extract<
  | InventoryMaterialCommand
  | {
      readonly kind: 'consume';
      readonly stockId: string;
      readonly quantity: InventoryVolume;
      readonly reason: string;
    },
  { readonly kind: 'transfer' | 'pool' | 'dilute' | 'consume' }
>;

export type InventoryReservationCommand =
  | {
      readonly kind: 'reserve-quantity';
      readonly id: string;
      readonly stockId: string;
      readonly quantity: InventoryVolume;
      readonly deadline: number | null;
      readonly purpose: string;
    }
  | {
      readonly kind: 'reserve-item';
      readonly id: string;
      readonly item: InventoryPhysicalItem;
      readonly deadline: number | null;
      readonly purpose: string;
    }
  | {
      readonly kind: 'release-reservation';
      readonly reservationId: string;
      readonly reason: string;
    }
  | { readonly kind: 'cancel-reservation'; readonly reservationId: string; readonly reason: string }
  | { readonly kind: 'expire-reservations'; readonly ids: readonly string[] }
  | {
      readonly kind: 'fulfill-reservations';
      readonly claims: readonly {
        readonly reservationId: string;
        readonly quantity: InventoryVolume;
      }[];
      readonly withdrawal: InventoryWithdrawalCommand;
    };

export type InventoryCustodyCommand =
  | {
      readonly kind: 'checkout-item';
      readonly item: InventoryPhysicalItem;
      readonly dueAt: number | null;
      readonly reason: string;
    }
  | {
      readonly kind: 'start-item-transit';
      readonly item: InventoryPhysicalItem;
      readonly destination: InventoryCustodyDestination;
      readonly reason: string;
    }
  | {
      readonly kind: 'return-item';
      readonly item: InventoryPhysicalItem;
      readonly destination: InventoryCustodyDestination;
      readonly reason: string;
    }
  | {
      readonly kind: 'report-item-missing';
      readonly item: InventoryPhysicalItem;
      readonly reason: string;
    }
  | {
      readonly kind: 'locate-item';
      readonly item: InventoryPhysicalItem;
      readonly destination: InventoryCustodyDestination;
      readonly reason: string;
    };

export type InventoryErrorCode =
  | 'INVALID_INVENTORY_INPUT'
  | 'REVISION_CONFLICT'
  | 'REVISION_EXHAUSTED'
  | 'ID_ALREADY_EXISTS'
  | 'STORAGE_NOT_FOUND'
  | 'VESSEL_NOT_FOUND'
  | 'STOCK_NOT_FOUND'
  | 'INVALID_PLACEMENT'
  | 'SLOT_OCCUPIED'
  | 'CONTAINMENT_CYCLE'
  | 'VESSEL_DISPOSED'
  | 'STORAGE_DISPOSED'
  | 'FIXED_WELL_IMMUTABLE'
  | 'INCOMPATIBLE_LAYOUT'
  | 'STACK_OPERATION_REQUIRED'
  | 'STACK_FULL'
  | 'STACK_TOP_REQUIRED'
  | 'STOCK_ALREADY_PRESENT'
  | 'STOCK_QUARANTINED'
  | 'QUANTITY_UNKNOWN'
  | 'INVALID_QUANTITY'
  | 'INSUFFICIENT_QUANTITY'
  | 'LOT_NOT_FOUND'
  | 'INCOMPATIBLE_PROVENANCE'
  | 'CAPACITY_EXCEEDED'
  | 'DEAD_VOLUME_REQUIRED'
  | 'CONTEXT_REQUIRED'
  | 'CLOCK_REGRESSION'
  | 'RESERVATION_NOT_FOUND'
  | 'RESERVATION_NOT_ACTIVE'
  | 'RESERVATION_NOT_OWNED'
  | 'RESERVATION_CONFLICT'
  | 'EXPIRY_PENDING'
  | 'ALLOCATION_SHORTFALL'
  | 'QUANTITY_RESERVED'
  | 'ITEM_RESERVED'
  | 'INVALID_RESERVATION_CLAIM'
  | 'AUTHORITY_REQUIRED'
  | 'ITEM_CHECKED_OUT'
  | 'ITEM_IN_TRANSIT'
  | 'ITEM_MISSING'
  | 'CUSTODY_STATE_CONFLICT'
  | 'CUSTODY_NOT_OWNED'
  | 'CUSTODY_TRANSITION_REQUIRED'
  | 'CATALOG_VERSION_RETIRED'
  | 'CATALOG_DEPENDENCY_RETIRED'
  | 'INVALID_CATALOG_TRANSITION'
  | 'ITEM_CODE_NOT_FOUND'
  | 'ITEM_CODE_ALREADY_ASSIGNED'
  | 'ITEM_CODE_CONFLICT'
  | 'ITEM_CODE_RETIRED'
  | 'TEMPERATURE_CLAIM_NOT_FOUND'
  | 'TEMPERATURE_CLAIM_WITHDRAWN'
  | 'TEMPERATURE_SCOPE_CONFLICT'
  | 'IMPORT_TARGET_PRESENT'
  | 'IMPORT_SOURCE_CLOCK_FUTURE'
  | 'IMPORT_BINDING_MISSING'
  | 'IMPORT_BINDING_UNUSED'
  | 'IMPORT_BINDING_COLLISION'
  | 'IMPORT_SOURCE_INVALID'
  | 'OBSERVATION_NOT_FOUND'
  | 'OBSERVATION_ALREADY_EXISTS'
  | 'OBSERVATION_ALREADY_APPLIED'
  | 'OBSERVATION_TIME_FUTURE'
  | 'POSITION_UNAVAILABLE';

export type InventoryTransition =
  | { readonly ok: true; readonly state: InventoryState }
  | {
      readonly ok: false;
      readonly code: InventoryErrorCode;
      readonly message: string;
    };

export function createInventoryState(): InventoryState {
  return {
    schema: INVENTORY_SCHEMA,
    observations: Object.create(null) as Record<string, InventoryObservation>,
    origin: { kind: 'native' },
    tableBindings: Object.create(null) as Record<string, InventoryTableBinding>,
    revision: 0,
    thermalContexts: Object.create(null) as Record<string, InventoryThermalContext>,
    temperatureClaims: Object.create(null) as Record<string, InventoryTemperatureClaim>,
    equipmentSetpoints: Object.create(null) as Record<string, InventoryEquipmentSetpoint>,
    storageRequirements: Object.create(null) as Record<string, InventoryStorageRequirement>,
    itemCodes: Object.create(null) as Record<string, InventoryItemCode>,
    typeVersions: Object.create(null) as Record<string, InventoryPhysicalTypeVersion>,
    recipeVersions: Object.create(null) as Record<string, InventoryEquipmentRecipeVersion>,
    fitEvidence: Object.create(null) as Record<string, InventoryFitEvidence>,
    lastRecordedAt: 0,
    storage: Object.create(null) as Record<string, InventoryStorage>,
    vessels: Object.create(null) as Record<string, InventoryVessel>,
    stocks: Object.create(null) as Record<string, InventoryStock>,
    lots: Object.create(null) as Record<string, InventoryLot>,
    reservations: Object.create(null) as Record<string, InventoryReservation>,
  };
}
