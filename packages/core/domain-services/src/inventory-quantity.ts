import { inventoryAmountUnitDefinition, normalizeInventoryAmount } from './inventory-amount';
import type {
  InventoryQuantity,
  InventoryQuantityInput,
  InventoryVolumeQuantity,
} from './inventory-types';
import { normalizeInventoryVolume } from './inventory-volume';

export function normalizeInventoryQuantity(quantity: InventoryQuantityInput): InventoryQuantity {
  if (quantity.kind === 'known') return { kind: 'known', ...normalizeInventoryAmount(quantity) };
  return {
    kind: 'unknown',
    unit: 'unit' in quantity ? inventoryAmountUnitDefinition(quantity.unit).canonicalUnit : 'uL',
  };
}
export function normalizeInventoryVolumeQuantity(
  quantity: InventoryVolumeQuantity
): InventoryVolumeQuantity {
  return quantity.kind === 'unknown'
    ? { kind: 'unknown' }
    : { kind: 'known', ...normalizeInventoryVolume(quantity) };
}
