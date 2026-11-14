export const INVENTORY_SCHEMA = 'dnaforge.inventory.v3' as const;
export const INVENTORY_LAYOUT_SCHEMA = 'dnaforge.inventory.v2' as const;
export const INVENTORY_DECIMAL_PATTERN = '^(?:0|[1-9]\\d*)(?:\\.\\d+)?$';
export const LEGACY_INVENTORY_SCHEMA = 'dnaforge.inventory.v1' as const;
export const INVENTORY_VOLUME_UNITS = ['L', 'mL', 'uL', 'nL'] as const;
export const MAX_INVENTORY_BATCH_COMMANDS = 256;
export const MAX_INVENTORY_STORAGE_SLOTS = 10_000;

export type InventoryVolumeUnit = (typeof INVENTORY_VOLUME_UNITS)[number];
export type InventoryQuality = 'usable' | 'quarantined';

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
  readonly id: string;
  readonly name: string;
  readonly layout: InventoryLayout;
  readonly placement: InventoryStoragePlacement;
  readonly lifecycle: 'active' | 'disposed';
}

export interface InventoryVesselLimits {
  readonly capacity: InventoryQuantity;
  readonly deadVolume: InventoryQuantity;
}

export interface InventoryVessel {
  readonly kind: 'movable' | 'fixed-well';
  readonly limits: InventoryVesselLimits;
  readonly id: string;
  readonly name: string;
  readonly placement: InventoryVesselPlacement;
  readonly lifecycle: 'active' | 'disposed';
}

export type InventoryStockSource =
  | { readonly kind: 'unattributed'; readonly rootStockId: string }
  | { readonly kind: 'lot'; readonly lotId: string };

export interface InventorySourceIdentity {
  readonly stockId: string;
  readonly materialId: string;
  readonly source: InventoryStockSource;
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
}

export interface InventoryState {
  readonly schema: typeof INVENTORY_SCHEMA;
  readonly revision: number;
  readonly storage: Readonly<Record<string, InventoryStorage>>;
  readonly vessels: Readonly<Record<string, InventoryVessel>>;
  readonly stocks: Readonly<Record<string, InventoryStock>>;
  readonly lots: Readonly<Record<string, InventoryLot>>;
}

export interface InventoryWithdrawal {
  readonly stockId: string;
  readonly quantity: InventoryVolume;
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
      readonly kind: 'transfer';
      readonly sourceStockId: string;
      readonly quantity: InventoryVolume;
      readonly destination:
        | { readonly kind: 'new-stock'; readonly stockId: string; readonly vesselId: string }
        | { readonly kind: 'existing-stock'; readonly stockId: string };
      readonly reason: string;
    }
  | {
      readonly kind: 'pool';
      readonly lotId: string;
      readonly stockId: string;
      readonly vesselId: string;
      readonly materialId: string;
      readonly name: string;
      readonly inputs: readonly InventoryWithdrawal[];
      readonly reason: string;
    }
  | {
      readonly kind: 'dilute';
      readonly lotId: string;
      readonly stockId: string;
      readonly vesselId: string;
      readonly materialId: string;
      readonly name: string;
      readonly sample: InventoryWithdrawal;
      readonly diluent: InventoryWithdrawal;
      readonly reason: string;
    };

export type InventoryCommand =
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
  | ({ readonly kind: 'receive-stock' } & Omit<InventoryStock, 'source'>)
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
  | 'DEAD_VOLUME_REQUIRED';

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
    revision: 0,
    storage: Object.create(null) as Record<string, InventoryStorage>,
    vessels: Object.create(null) as Record<string, InventoryVessel>,
    stocks: Object.create(null) as Record<string, InventoryStock>,
    lots: Object.create(null) as Record<string, InventoryLot>,
  };
}
