import type { InventoryLot, InventoryStock } from './inventory-types';

export function inventoryPlanStock(stock: InventoryStock) {
  const { incidentReviewRootIds, ...legacy } = stock;
  return incidentReviewRootIds.length ? stock : legacy;
}

export function inventoryPlanLot(lot: InventoryLot) {
  const { incidentReviewRootIds, ...legacy } = lot;
  return incidentReviewRootIds.length ? lot : legacy;
}
