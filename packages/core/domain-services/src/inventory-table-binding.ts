import { defineBlob } from '@waypoint/workspace-revisions';
import type {
  InventoryTableBinding,
  InventoryTableSha256,
  InventoryTableTarget,
} from './inventory-table-types';

export function inventoryTableSha256(text: string): InventoryTableSha256 {
  return defineBlob(new TextEncoder().encode(text)).hash;
}

export function inventoryTableCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('Table plan values must be JSON values.');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(inventoryTableCanonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${inventoryTableCanonicalJson((value as Record<string, unknown>)[key])}`
    )
    .join(',')}}`;
}

export function inventoryTableBindingKey(
  namespace: string,
  sourceId: string
): InventoryTableSha256 {
  return inventoryTableSha256(JSON.stringify([namespace, sourceId]));
}

export function inventoryTableRecordIds(
  target: Pick<InventoryTableTarget, 'projectId' | 'inventoryId'>,
  namespace: string,
  sourceId: string
): { readonly stockId: string; readonly vesselId: string } {
  const hash = inventoryTableSha256(
    JSON.stringify([
      'dnaforge.inventory-receive-table.v1',
      target.projectId,
      target.inventoryId,
      namespace,
      sourceId,
    ])
  ).slice(7);
  return { stockId: `table-stock:${hash}`, vesselId: `table-vessel:${hash}` };
}

export function inventoryTableSourceBaseline(
  binding: InventoryTableBinding
): Pick<InventoryTableBinding, 'rowSha256' | 'destination'> {
  return binding.sourceRevisions.at(-1) ?? binding;
}
