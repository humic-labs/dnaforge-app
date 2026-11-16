import type { InventoryTableSha256 } from './inventory-table-types';
import type { InventoryVesselPlacement } from './inventory-types';

export interface InventoryVesselBinding {
  readonly namespace: string;
  readonly sourceId: string;
  readonly rowSha256: InventoryTableSha256;
  readonly vesselId: string;
  readonly origin:
    | { readonly kind: 'movable'; readonly placement: InventoryVesselPlacement }
    | { readonly kind: 'fixed-well'; readonly storageId: string; readonly position: string };
}
