import type { InventoryState } from './inventory-types';

const recordMaps = [
  'storage',
  'vessels',
  'stocks',
  'lots',
  'reservations',
  'typeVersions',
  'recipeVersions',
  'fitEvidence',
  'itemCodes',
  'temperatureClaims',
  'lotRecalls',
  'openingObservations',
  'validityFacts',
  'arrivals',
] as const;

export type InventoryIdentityState = Pick<InventoryState, (typeof recordMaps)[number]>;

export function inventoryRecordIdExists(state: InventoryIdentityState, id: string): boolean {
  return recordMaps.some((key) => Object.hasOwn(state[key], id));
}

export function inventoryIdentityMaps(
  state: InventoryIdentityState
): readonly Readonly<Record<string, unknown>>[] {
  return recordMaps.map((key) => state[key]);
}
