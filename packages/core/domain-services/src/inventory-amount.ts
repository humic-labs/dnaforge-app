import { INVENTORY_DECIMAL_PATTERN } from './inventory-types';

export type InventoryAmountDimension = 'volume' | 'mass' | 'amount-of-substance' | 'count';
export type InventoryCanonicalAmountUnit = 'uL' | 'ng' | 'nmol' | 'item';
export interface InventoryAmountUnitDefinition {
  readonly dimension: InventoryAmountDimension;
  readonly canonicalUnit: InventoryCanonicalAmountUnit;
  readonly exponent: number;
}
const unit = (
  dimension: InventoryAmountDimension,
  canonicalUnit: InventoryCanonicalAmountUnit,
  exponent: number
): InventoryAmountUnitDefinition => Object.freeze({ dimension, canonicalUnit, exponent });
const DEFINITIONS = Object.freeze({
  L: unit('volume', 'uL', 6),
  mL: unit('volume', 'uL', 3),
  uL: unit('volume', 'uL', 0),
  nL: unit('volume', 'uL', -3),
  pL: unit('volume', 'uL', -6),
  kg: unit('mass', 'ng', 12),
  g: unit('mass', 'ng', 9),
  mg: unit('mass', 'ng', 6),
  ug: unit('mass', 'ng', 3),
  ng: unit('mass', 'ng', 0),
  pg: unit('mass', 'ng', -3),
  mol: unit('amount-of-substance', 'nmol', 9),
  mmol: unit('amount-of-substance', 'nmol', 6),
  umol: unit('amount-of-substance', 'nmol', 3),
  nmol: unit('amount-of-substance', 'nmol', 0),
  pmol: unit('amount-of-substance', 'nmol', -3),
  fmol: unit('amount-of-substance', 'nmol', -6),
  item: unit('count', 'item', 0),
});
export type InventoryAmountUnit = keyof typeof DEFINITIONS;
export const INVENTORY_AMOUNT_UNITS: readonly InventoryAmountUnit[] = Object.freeze(
  Object.keys(DEFINITIONS) as InventoryAmountUnit[]
);
export const MAX_INVENTORY_AMOUNT_DECIMAL_LENGTH = 128;
export const MAX_INVENTORY_AMOUNT_SUM_INPUTS = 10_000;
export interface InventoryAmount {
  readonly value: string;
  readonly unit: InventoryAmountUnit;
}
export interface InventoryCanonicalAmount {
  readonly value: string;
  readonly unit: InventoryCanonicalAmountUnit;
}
export interface InventoryAmountMismatch {
  readonly kind: 'incompatible';
  readonly leftDimension: InventoryAmountDimension;
  readonly rightDimension: InventoryAmountDimension;
}
interface DecimalAmount {
  coefficient: bigint;
  scale: number;
  definition: InventoryAmountUnitDefinition;
}
const DECIMAL = new RegExp(INVENTORY_DECIMAL_PATTERN, 'u');

export function inventoryAmountUnitDefinition(
  value: InventoryAmountUnit
): InventoryAmountUnitDefinition {
  if (typeof value !== 'string' || !Object.hasOwn(DEFINITIONS, value))
    throw new TypeError('Amount requires a supported explicit unit.');
  return DEFINITIONS[value];
}
function decimalAmount(value: InventoryAmount): DecimalAmount {
  if (
    !value ||
    typeof value.value !== 'string' ||
    value.value.length > MAX_INVENTORY_AMOUNT_DECIMAL_LENGTH ||
    !DECIMAL.test(value.value)
  )
    throw new TypeError('Amount requires a bounded non-negative decimal string.');
  const definition = inventoryAmountUnitDefinition(value.unit);
  const [whole, fraction = ''] = value.value.split('.');
  const coefficient = BigInt(whole + fraction);
  const scale = fraction.length - definition.exponent;
  if (definition.dimension === 'count' && scale > 0 && coefficient % 10n ** BigInt(scale) !== 0n)
    throw new TypeError('An item count requires a whole number.');
  return scale < 0
    ? { coefficient: coefficient * 10n ** BigInt(-scale), scale: 0, definition }
    : { coefficient, scale, definition };
}
function rendered(coefficient: bigint, scale: number): string {
  if (coefficient === 0n) return '0';
  const digits = coefficient.toString().padStart(scale + 1, '0');
  return scale === 0
    ? digits
    : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/u, '');
}
function canonical(
  coefficient: bigint,
  scale: number,
  unit: InventoryCanonicalAmountUnit
): InventoryCanonicalAmount {
  const value = rendered(coefficient, scale);
  if (value.length > MAX_INVENTORY_AMOUNT_DECIMAL_LENGTH)
    throw new TypeError('The normalized amount exceeds the supported decimal range.');
  return { value, unit };
}
function mismatch(
  left: InventoryAmountUnitDefinition,
  right: InventoryAmountUnitDefinition
): InventoryAmountMismatch | null {
  return left.dimension === right.dimension
    ? null
    : { kind: 'incompatible', leftDimension: left.dimension, rightDimension: right.dimension };
}
export function normalizeInventoryAmount(value: InventoryAmount): InventoryCanonicalAmount {
  const parsed = decimalAmount(value);
  return canonical(parsed.coefficient, parsed.scale, parsed.definition.canonicalUnit);
}
export function compareInventoryAmounts(
  first: InventoryAmount,
  second: InventoryAmount
): InventoryAmountMismatch | { readonly kind: 'compared'; readonly order: -1 | 0 | 1 } {
  const left = decimalAmount(first);
  const right = decimalAmount(second);
  const incompatible = mismatch(left.definition, right.definition);
  if (incompatible) return incompatible;
  const scale = Math.max(left.scale, right.scale);
  const a = left.coefficient * 10n ** BigInt(scale - left.scale);
  const b = right.coefficient * 10n ** BigInt(scale - right.scale);
  return { kind: 'compared', order: a < b ? -1 : a > b ? 1 : 0 };
}
export function subtractInventoryAmounts(
  available: InventoryAmount,
  requested: InventoryAmount
):
  | InventoryAmountMismatch
  | { readonly kind: 'remaining'; readonly quantity: InventoryCanonicalAmount }
  | { readonly kind: 'non-positive' }
  | { readonly kind: 'insufficient' } {
  const source = decimalAmount(available);
  const consumed = decimalAmount(requested);
  const incompatible = mismatch(source.definition, consumed.definition);
  if (incompatible) return incompatible;
  if (consumed.coefficient === 0n) return { kind: 'non-positive' };
  const scale = Math.max(source.scale, consumed.scale);
  const remaining =
    source.coefficient * 10n ** BigInt(scale - source.scale) -
    consumed.coefficient * 10n ** BigInt(scale - consumed.scale);
  return remaining < 0n
    ? { kind: 'insufficient' }
    : { kind: 'remaining', quantity: canonical(remaining, scale, source.definition.canonicalUnit) };
}
export function addInventoryAmounts(
  values: readonly InventoryAmount[],
  targetUnit: InventoryAmountUnit
):
  | InventoryAmountMismatch
  | { readonly kind: 'added'; readonly quantity: InventoryCanonicalAmount } {
  if (!Array.isArray(values) || values.length > MAX_INVENTORY_AMOUNT_SUM_INPUTS)
    throw new TypeError('The amount sum exceeds the supported input count.');
  const target = inventoryAmountUnitDefinition(targetUnit);
  let coefficient = 0n;
  let scale = 0;
  for (const value of values) {
    const parsed = decimalAmount(value);
    const incompatible = mismatch(target, parsed.definition);
    if (incompatible) return incompatible;
    const nextScale = Math.max(scale, parsed.scale);
    coefficient =
      coefficient * 10n ** BigInt(nextScale - scale) +
      parsed.coefficient * 10n ** BigInt(nextScale - parsed.scale);
    scale = nextScale;
  }
  return { kind: 'added', quantity: canonical(coefficient, scale, target.canonicalUnit) };
}
