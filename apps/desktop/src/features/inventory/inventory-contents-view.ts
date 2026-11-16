import type { InventoryVesselContents } from '@waypoint/domain-services';

export function inventoryContentsLabel(
  contents: InventoryVesselContents | null | undefined
): string {
  return contents
    ? {
        'declared-empty': 'Declared empty',
        identified: 'Identified contents',
        unobserved: 'Contents unobserved',
        unidentified: 'Unidentified material',
      }[contents.kind]
    : 'Contents unavailable';
}
