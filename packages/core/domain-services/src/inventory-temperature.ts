import {
  INVENTORY_TEMPERATURE_DECIMAL_PATTERN,
  type InventoryTemperature,
  type InventoryTemperatureRange,
  type InventoryTemperatureFreshness,
} from './inventory-temperature-types';

function decimal(value: string): { value: bigint; scale: number } {
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  return { value: BigInt(whole + fraction) * (negative ? -1n : 1n), scale: fraction.length };
}
function compare(a: { value: bigint; scale: number }, b: { value: bigint; scale: number }): number {
  const scale = Math.max(a.scale, b.scale);
  const first = a.value * 10n ** BigInt(scale - a.scale);
  const second = b.value * 10n ** BigInt(scale - b.scale);
  return first < second ? -1 : first > second ? 1 : 0;
}
export function normalizeInventoryTemperature(input: InventoryTemperature): InventoryTemperature {
  if (
    !input ||
    input.unit !== 'C' ||
    typeof input.value !== 'string' ||
    input.value.length > 128 ||
    !new RegExp(INVENTORY_TEMPERATURE_DECIMAL_PATTERN, 'u').test(input.value)
  )
    throw new TypeError('Temperature requires a bounded signed exact decimal in degrees Celsius.');
  let { value, scale } = decimal(input.value);
  if (compare({ value, scale }, { value: -27315n, scale: 2 }) < 0)
    throw new TypeError('Temperature cannot be below absolute zero (-273.15 °C).');
  while (scale > 0 && value % 10n === 0n) {
    value /= 10n;
    scale--;
  }
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0');
  return {
    value: `${negative ? '-' : ''}${scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits}`,
    unit: 'C',
  };
}
export function compareInventoryTemperatures(
  first: InventoryTemperature,
  second: InventoryTemperature
): number {
  return compare(
    decimal(normalizeInventoryTemperature(first).value),
    decimal(normalizeInventoryTemperature(second).value)
  );
}
export function normalizeInventoryTemperatureRange(
  input: InventoryTemperatureRange
): InventoryTemperatureRange {
  const minimum = normalizeInventoryTemperature(input.minimum);
  const maximum = normalizeInventoryTemperature(input.maximum);
  if (compareInventoryTemperatures(minimum, maximum) > 0)
    throw new TypeError('A temperature range minimum cannot exceed its maximum.');
  return { minimum, maximum };
}
export function inventoryTemperatureFreshness(
  observedAt: number | null,
  asOf: number,
  maxAgeMs: number | null
): InventoryTemperatureFreshness {
  if (
    !Number.isSafeInteger(asOf) ||
    asOf < 0 ||
    (maxAgeMs !== null && (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0))
  )
    throw new TypeError(
      'Temperature freshness requires an explicit safe timestamp and null or non-negative safe maximum age.'
    );
  if (observedAt === null)
    return { state: 'unknown', observedAt, ageMs: null, reason: 'time-unknown' };
  if (!Number.isSafeInteger(observedAt) || observedAt < 0)
    throw new TypeError('Observation time must be null or a safe timestamp.');
  const ageMs = asOf - observedAt;
  if (ageMs < 0) return { state: 'unknown', observedAt, ageMs, reason: 'future-observation' };
  if (maxAgeMs === null) return { state: 'unknown', observedAt, ageMs, reason: 'no-policy' };
  return ageMs <= maxAgeMs
    ? { state: 'fresh', observedAt, ageMs, reason: 'within-policy' }
    : { state: 'stale', observedAt, ageMs, reason: 'exceeds-policy' };
}
