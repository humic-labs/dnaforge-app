import {
  INVENTORY_VOLUME_UNITS,
  type InventoryQuantity,
  type InventoryVolume,
} from './inventory-types';
import {
  addInventoryAmounts,
  compareInventoryAmounts,
  normalizeInventoryAmount,
  subtractInventoryAmounts,
  type InventoryCanonicalAmount,
} from './inventory-amount';

function volumeInput(value: InventoryVolume): InventoryVolume {
  if (!value || !INVENTORY_VOLUME_UNITS.some((unit) => unit === value.unit))
    throw new TypeError('Volume requires a non-negative decimal string and a supported unit.');
  return value;
}
function volumeOutput(value: InventoryCanonicalAmount): InventoryVolume {
  if (value.unit !== 'uL') throw new TypeError('A volume result requires canonical microliters.');
  return { value: value.value, unit: 'uL' };
}
export function normalizeInventoryVolume(quantity: InventoryVolume): InventoryVolume {
  return volumeOutput(normalizeInventoryAmount(volumeInput(quantity)));
}
export function normalizeInventoryQuantity(quantity: InventoryQuantity): InventoryQuantity {
  return quantity.kind === 'unknown'
    ? { kind: 'unknown' }
    : { kind: 'known', ...normalizeInventoryVolume(quantity) };
}
export function subtractInventoryVolume(
  available: InventoryVolume,
  consumed: InventoryVolume
):
  | { readonly kind: 'remaining'; readonly quantity: InventoryVolume }
  | { readonly kind: 'non-positive' }
  | { readonly kind: 'insufficient' } {
  const result = subtractInventoryAmounts(volumeInput(available), volumeInput(consumed));
  if (result.kind === 'incompatible')
    throw new TypeError('Volume arithmetic requires compatible units.');
  return result.kind === 'remaining'
    ? { kind: 'remaining', quantity: volumeOutput(result.quantity) }
    : result;
}
export function compareInventoryVolumes(
  first: InventoryVolume,
  second: InventoryVolume
): -1 | 0 | 1 {
  const result = compareInventoryAmounts(volumeInput(first), volumeInput(second));
  if (result.kind === 'incompatible')
    throw new TypeError('Volume arithmetic requires compatible units.');
  return result.order;
}
export function addInventoryVolumes(values: readonly InventoryVolume[]): InventoryVolume {
  const result = addInventoryAmounts(values.map(volumeInput), 'uL');
  if (result.kind === 'incompatible')
    throw new TypeError('Volume arithmetic requires compatible units.');
  return volumeOutput(result.quantity);
}
