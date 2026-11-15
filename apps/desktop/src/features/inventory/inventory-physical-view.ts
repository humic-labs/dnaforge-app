import type { InventoryDimension } from '@waypoint/domain-services';
import type { InventoryItem } from './inventory-view';

export type InventoryPhysicalDialogKind =
  | { kind: 'setup' }
  | { kind: 'physical-type'; versionId?: string }
  | { kind: 'equipment-recipe'; versionId?: string }
  | { kind: 'install-recipe'; versionId: string }
  | { kind: 'install-catalog'; catalogId: string }
  | { kind: 'physical-configuration'; item: InventoryItem }
  | { kind: 'physical-geometry'; item: InventoryItem }
  | { kind: 'physical-fit'; item: InventoryItem };

export function isInventoryPhysicalDialog(dialog: {
  kind: string;
}): dialog is InventoryPhysicalDialogKind {
  return [
    'setup',
    'physical-type',
    'equipment-recipe',
    'install-recipe',
    'install-catalog',
    'physical-configuration',
    'physical-geometry',
    'physical-fit',
  ].includes(dialog.kind);
}

export function inventoryDimensionLabel(value: InventoryDimension): string {
  return value.kind === 'unknown' ? 'Unknown' : `${value.value} ${value.unit}`;
}

export function inventoryFitReason(reason: string): string {
  const reasons: Readonly<Record<string, string>> = {
    ITEM_NOT_FOUND: 'The physical item is unavailable',
    POSITION_UNAVAILABLE: 'This position is marked unavailable',
    CHILD_TYPE_NOT_ALLOWED: 'This child type is not allowed here',
    GEOMETRY_EXCEEDED: 'Recorded dimensions exceed the usable space',
    CONFLICTING_FIT_EVIDENCE: 'The applicable fit evidence conflicts',
    SCOPED_INCOMPATIBILITY: 'Applicable evidence records an incompatible fit',
    FIT_NOT_ESTABLISHED: 'Fit is not established for this arrangement',
  };
  return reasons[reason] ?? reason;
}
