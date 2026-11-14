export const INVENTORY_SCHEMA = 'dnaforge.inventory.v1' as const;
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

export interface InventoryStorage {
  readonly id: string;
  readonly name: string;
  readonly slots: readonly string[];
  readonly placement: InventoryStoragePlacement;
}

export interface InventoryVessel {
  readonly id: string;
  readonly name: string;
  readonly placement: InventoryVesselPlacement;
  readonly lifecycle: 'active' | 'disposed';
}

export interface InventoryStock {
  readonly id: string;
  readonly vesselId: string;
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
}

export type InventoryCommand =
  | {
      readonly kind: 'create-storage';
      readonly id: string;
      readonly name: string;
      readonly slots: readonly string[];
      readonly placement: InventoryStoragePlacement;
    }
  | {
      readonly kind: 'create-vessel';
      readonly id: string;
      readonly name: string;
      readonly placement: InventoryVesselPlacement;
    }
  | ({ readonly kind: 'receive-stock' } & InventoryStock)
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
  | { readonly kind: 'dispose-vessel'; readonly id: string; readonly reason: string };

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
  | 'STOCK_ALREADY_PRESENT'
  | 'STOCK_QUARANTINED'
  | 'QUANTITY_UNKNOWN'
  | 'INVALID_QUANTITY'
  | 'INSUFFICIENT_QUANTITY';

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
  };
}

export { applyInventoryCommandBatch } from './inventory-state';
export {
  InventoryValidationError,
  parseInventoryCommand,
  parseInventoryCommandBatch,
  parseInventoryState,
} from './inventory-validation';
