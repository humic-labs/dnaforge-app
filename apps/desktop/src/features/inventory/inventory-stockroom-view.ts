import type { InventoryStockroomSnapshot } from '../../shared/inventory-client';
import type { InventoryData } from './inventory-controller';

export function inventoryStockroomSnapshot(data: InventoryData): InventoryStockroomSnapshot | null {
  const snapshot = data.stockroom;
  return snapshot &&
    snapshot.projectId === data.project.projectId &&
    snapshot.inventoryId === data.project.defaultInventoryId &&
    snapshot.revision === data.state.revision
    ? snapshot
    : null;
}
export const inventoryReorderActionLabel = {
  reserve: 'Suitable for reservation',
  withdraw: 'Ready for withdrawal',
} as const;
export const inventoryReorderValidityLabel = {
  'current-recorded-rules': 'Current recorded rules; untracked validity may be included',
  'confirmed-current-validity': 'Confirmed current validity for the selected action',
} as const;
