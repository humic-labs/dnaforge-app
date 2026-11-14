import type { InventoryPhysicalItem, InventoryState, InventoryStorage } from './inventory-types';

function rowLabel(index: number): string {
  let value = index + 1;
  let label = '';
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

export function inventoryStoragePositions(storage: InventoryStorage): readonly string[] {
  const layout = storage.layout;
  if (layout.kind === 'named') return [...layout.slots];
  if (layout.kind === 'stack')
    return Array.from({ length: layout.capacity }, (_, index) => String(index + 1));
  return Array.from({ length: layout.rows }, (_, row) =>
    Array.from({ length: layout.columns }, (_, column) => `${rowLabel(row)}${column + 1}`)
  ).flat();
}

export function inventoryWellId(plateId: string, position: string): string {
  return `well:${plateId}#${position}`;
}

export function inventoryStackItems(
  state: Pick<InventoryState, 'storage' | 'vessels'>,
  stackId: string
): readonly InventoryPhysicalItem[] {
  const stack = state.storage[stackId];
  if (!stack || stack.layout.kind !== 'stack')
    throw new TypeError('The requested storage location is not an ordered stack.');
  const children: { item: InventoryPhysicalItem; position: number }[] = [];
  for (const storage of Object.values(state.storage)) {
    if (storage.placement.kind === 'located' && storage.placement.storageId === stackId)
      children.push({
        item: { kind: 'storage', id: storage.id },
        position: Number(storage.placement.slotId),
      });
  }
  for (const vessel of Object.values(state.vessels)) {
    if (vessel.placement.kind === 'located' && vessel.placement.storageId === stackId)
      children.push({
        item: { kind: 'vessel', id: vessel.id },
        position: Number(vessel.placement.slotId),
      });
  }
  return children.sort((first, second) => first.position - second.position).map(({ item }) => item);
}
