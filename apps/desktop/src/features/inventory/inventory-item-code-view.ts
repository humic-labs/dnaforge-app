import type { InventoryItemCodeLookupSnapshot } from '../../shared/inventory-client';
import type { InventoryItem } from './inventory-view';

export type InventoryItemCodeDialog =
  | { kind: 'item-code-lookup'; expected?: InventoryItem }
  | { kind: 'item-code-attach'; item: InventoryItem }
  | { kind: 'item-code-retire'; codeId: string };

export function isInventoryItemCodeDialog(dialog: {
  kind: string;
}): dialog is InventoryItemCodeDialog {
  return ['item-code-lookup', 'item-code-attach', 'item-code-retire'].includes(dialog.kind);
}

export function inventoryExpectedItemCode(
  lookup: InventoryItemCodeLookupSnapshot,
  expected: { projectId: string; inventoryId: string; item: InventoryItem }
): boolean | null {
  if (lookup.resolution.kind !== 'resolved' && lookup.resolution.kind !== 'retired') return null;
  return (
    lookup.projectId === expected.projectId &&
    lookup.inventoryId === expected.inventoryId &&
    lookup.resolution.match.item.kind === expected.item.kind &&
    lookup.resolution.match.item.id === expected.item.id
  );
}
