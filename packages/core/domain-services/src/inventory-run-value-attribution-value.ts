import {
  inventoryTableCanonicalJson as canonical,
  inventoryTableSha256,
} from './inventory-table-binding';
import { inventoryPlatePlanText } from './inventory-plate-plan-definition';
import type {
  InventoryRunValueCollection,
  InventoryRunValueSnapshot,
} from './inventory-run-value-attribution-types';

export function inventoryRunValueJson(value: unknown, depth = 0): unknown {
  if (depth > 64) throw new TypeError('Run row JSON exceeds the supported nesting depth.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value))
    return Array.from(value, (row) => inventoryRunValueJson(row, depth + 1));
  if (
    value &&
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  )
    return Object.fromEntries(
      Object.entries(value).map(([key, row]) => [key, inventoryRunValueJson(row, depth + 1)])
    );
  throw new TypeError('Run rows must preserve complete finite JSON values.');
}
export function inventoryRunValueCollection(
  value: unknown
): asserts value is InventoryRunValueCollection {
  if (value !== 'inputs' && value !== 'outputs' && value !== 'measurements')
    throw new TypeError('Choose a supported saved Run value collection.');
}
export function parseInventoryRunValueSnapshot(value: unknown): InventoryRunValueSnapshot {
  const row = inventoryRunValueJson(value);
  if (!row || typeof row !== 'object' || Array.isArray(row))
    throw new TypeError('The saved Run value requires its complete raw slot row.');
  const raw = row as Record<string, unknown>;
  if (
    typeof raw.key !== 'string' ||
    raw.key.length > 1024 ||
    !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(raw.key)
  )
    throw new TypeError('A new attribution requires an exact portable slot key.');
  inventoryPlatePlanText(raw.label, 17 * 1024 * 1024, 'saved slot label');
  if (/[\r\n]/u.test(raw.label as string))
    throw new TypeError('A saved slot label must be single-line text.');
  if (!raw.value || typeof raw.value !== 'object' || Array.isArray(raw.value))
    throw new TypeError('A saved Run value requires its typed value object.');
  const typed = raw.value as Record<string, unknown>;
  if (typed.type === 'text') {
    if (
      typeof typed.value !== 'string' ||
      typed.value.includes('\0') ||
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        new TextEncoder().encode(typed.value)
      ) !== typed.value
    )
      throw new TypeError('The saved text value is unsupported for attribution.');
  } else if (typed.type === 'number') {
    if (
      typeof typed.value !== 'number' ||
      !Number.isFinite(typed.value) ||
      (Number.isInteger(typed.value) && !Number.isSafeInteger(typed.value))
    )
      throw new TypeError('The saved number requires finite safe precision.');
  } else if (typed.type === 'boolean') {
    if (typeof typed.value !== 'boolean')
      throw new TypeError('The saved boolean requires an actual boolean.');
  } else if (typed.type === 'date') {
    if (
      typeof typed.value !== 'string' ||
      !Number.isFinite(Date.parse(typed.value)) ||
      new Date(Date.parse(typed.value)).toISOString() !== typed.value
    )
      throw new TypeError('The saved date requires a canonical UTC ISO timestamp.');
  } else
    throw new TypeError('This saved Run value type is read only and cannot be attributed here.');
  if (raw.recordedAt !== undefined) {
    inventoryPlatePlanText(raw.recordedAt, 1024, 'saved recording timestamp');
    if (
      !Number.isFinite(Date.parse(raw.recordedAt as string)) ||
      /[\r\n]/u.test(raw.recordedAt as string)
    )
      throw new TypeError('The saved recording timestamp is invalid.');
  }
  return raw as InventoryRunValueSnapshot;
}
export function inventoryRunValueRowSha256(collection: InventoryRunValueCollection, row: unknown) {
  inventoryRunValueCollection(collection);
  return inventoryTableSha256(
    canonical({ schema: 'dnaforge.run-value-row.v1', collection, row: inventoryRunValueJson(row) })
  );
}
