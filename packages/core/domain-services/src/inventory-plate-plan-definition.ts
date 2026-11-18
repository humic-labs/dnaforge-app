import { normalizeInventoryAmount } from './inventory-amount';
import { inventoryStoragePositions } from './inventory-layout';
import { MAX_INVENTORY_BATCH_COMMANDS, MAX_INVENTORY_STORAGE_SLOTS } from './inventory-types';
import type {
  InventoryPlatePlanDefinition,
  InventoryPlatePlanVolume,
} from './inventory-plate-plan-types';
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new TypeError(`Supply exactly ${keys.join(', ')}.`);
}
export function inventoryPlatePlanText(value: unknown, max: number, field: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    value.includes('\0') ||
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      new TextEncoder().encode(value)
    ) !== value
  )
    throw new TypeError(`Supply valid exact ${field} text of at most ${max} characters.`);
  return value;
}
export function parseInventoryPlatePlanVolume(
  value: unknown,
  positive = true
): InventoryPlatePlanVolume {
  exact(value, ['value', 'unit']);
  if (value.unit !== 'uL' || typeof value.value !== 'string')
    throw new TypeError('Plate-plan volume must use exact canonical uL.');
  const normalized = normalizeInventoryAmount({ value: value.value, unit: 'uL' });
  if (normalized.value !== value.value || (positive && normalized.value === '0'))
    throw new TypeError(
      positive
        ? 'Plate-plan demand requires a positive canonical uL decimal.'
        : 'Plate-plan balance requires a nonnegative canonical uL decimal.'
    );
  return { value: value.value, unit: 'uL' };
}
export function parseInventoryPlatePlanDefinition(value: unknown): InventoryPlatePlanDefinition {
  exact(value, ['schema', 'title', 'layout', 'sourceSlots', 'transfers']);
  if (value.schema !== 'dnaforge.inventory-plate-plan-definition.v1')
    throw new TypeError('Unsupported plate-plan definition schema.');
  const title = inventoryPlatePlanText(value.title, 200, 'plan title');
  exact(value.layout, ['kind', 'rows', 'columns']);
  const { rows, columns } = value.layout;
  if (
    value.layout.kind !== 'fixed-well' ||
    !Number.isSafeInteger(rows) ||
    !Number.isSafeInteger(columns) ||
    Number(rows) < 1 ||
    Number(columns) < 1 ||
    Number(rows) * Number(columns) > MAX_INVENTORY_STORAGE_SLOTS
  )
    throw new TypeError('Plate-plan layout requires a bounded positive fixed-well grid.');
  const layout = { kind: 'fixed-well' as const, rows: rows as number, columns: columns as number };
  if (
    !Array.isArray(value.sourceSlots) ||
    value.sourceSlots.length < 1 ||
    value.sourceSlots.length > MAX_INVENTORY_BATCH_COMMANDS ||
    !Array.isArray(value.transfers) ||
    value.transfers.length < 1 ||
    value.transfers.length > MAX_INVENTORY_BATCH_COMMANDS
  )
    throw new TypeError('Supply one to 256 source roles and transfers.');
  const keys = new Set<string>();
  const sourceSlots = value.sourceSlots.map((row: unknown) => {
    exact(row, ['key', 'label']);
    const key = inventoryPlatePlanText(row.key, 512, 'source-role key');
    if (keys.has(key)) throw new TypeError('Source-role keys must be unique.');
    keys.add(key);
    return { key, label: inventoryPlatePlanText(row.label, 200, 'source-role label') };
  });
  const positions = new Set(inventoryStoragePositions({ layout })),
    destinations = new Set<string>(),
    actions = new Set<string>(),
    used = new Set<string>();
  const transfers = value.transfers.map((row: unknown) => {
    exact(row, ['actionId', 'sourceSlotKey', 'destinationPosition', 'quantity', 'label']);
    const actionId = inventoryPlatePlanText(row.actionId, 512, 'action ID'),
      sourceSlotKey = inventoryPlatePlanText(row.sourceSlotKey, 512, 'source-role key'),
      destinationPosition = inventoryPlatePlanText(
        row.destinationPosition,
        512,
        'destination position'
      );
    if (
      actions.has(actionId) ||
      destinations.has(destinationPosition) ||
      !positions.has(destinationPosition) ||
      !keys.has(sourceSlotKey)
    )
      throw new TypeError(
        'Actions and destinations must be unique, canonical and bound to declared roles.'
      );
    actions.add(actionId);
    destinations.add(destinationPosition);
    used.add(sourceSlotKey);
    return {
      actionId,
      sourceSlotKey,
      destinationPosition,
      quantity: parseInventoryPlatePlanVolume(row.quantity),
      label: inventoryPlatePlanText(row.label, 200, 'action label'),
    };
  });
  if (used.size !== keys.size) throw new TypeError('Every declared source role must be used.');
  return {
    schema: 'dnaforge.inventory-plate-plan-definition.v1',
    title,
    layout,
    sourceSlots,
    transfers,
  };
}
