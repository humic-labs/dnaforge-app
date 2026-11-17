import type { InventoryValidityRule } from '@waypoint/domain-services';
import { inventoryObservationTime } from './inventory-temperature-view';

export const INVENTORY_ELAPSED_UNITS = {
  millisecond: { label: 'Milliseconds', factor: 1n },
  second: { label: 'Seconds', factor: 1000n },
  minute: { label: 'Minutes', factor: 60000n },
  hour: { label: 'Hours', factor: 3600000n },
  day: { label: 'Days (24 hours each)', factor: 86400000n },
} as const;
export type InventoryElapsedUnit = keyof typeof INVENTORY_ELAPSED_UNITS;

export function inventoryElapsedMilliseconds(value: string, unit: InventoryElapsedUnit): number {
  if (!/^\d{1,16}$/.test(value)) throw new Error('Enter a positive whole elapsed duration.');
  const elapsed = BigInt(value) * INVENTORY_ELAPSED_UNITS[unit].factor;
  if (elapsed <= 0n || elapsed > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('Elapsed duration exceeds the supported exact range.');
  return Number(elapsed);
}

export function inventoryValidityInstant(text: string): number {
  return inventoryObservationTime('known', text)!;
}

export function inventoryValidityRuleLabel(rule: InventoryValidityRule): string {
  if (rule.kind === 'unresolved') return 'Unresolved interpretation';
  if (rule.kind === 'not-required') return 'No cutoff required for this rule';
  if (rule.kind === 'absolute') return `Cutoff ${new Date(rule.deadlineAt).toISOString()}`;
  return `${rule.elapsedMs} elapsed milliseconds after first opening of stock ${rule.openingStockId}`;
}
