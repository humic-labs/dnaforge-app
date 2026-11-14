import {
  INVENTORY_DECIMAL_PATTERN,
  type InventoryQuantity,
  type InventoryVolume,
  type InventoryVolumeUnit,
} from './inventory-types';

const UNIT_EXPONENT: Readonly<Record<InventoryVolumeUnit, number>> = {
  L: 6,
  mL: 3,
  uL: 0,
  nL: -3,
};
const DECIMAL = new RegExp(INVENTORY_DECIMAL_PATTERN, 'u');

interface DecimalVolume {
  readonly coefficient: bigint;
  readonly scale: number;
}

function decimalVolume(quantity: InventoryVolume): DecimalVolume {
  if (
    typeof quantity.value !== 'string' ||
    quantity.value.length > 128 ||
    !DECIMAL.test(quantity.value) ||
    !Object.hasOwn(UNIT_EXPONENT, quantity.unit)
  )
    throw new TypeError('Volume requires a non-negative decimal string and a supported unit.');
  const [whole, fraction = ''] = quantity.value.split('.');
  const scale = fraction.length - UNIT_EXPONENT[quantity.unit];
  const coefficient = BigInt(`${whole}${fraction}`);
  return scale < 0
    ? { coefficient: coefficient * 10n ** BigInt(-scale), scale: 0 }
    : { coefficient, scale };
}

function renderDecimal({ coefficient, scale }: DecimalVolume): string {
  if (coefficient === 0n) return '0';
  const digits = coefficient.toString().padStart(scale + 1, '0');
  if (scale === 0) return digits;
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/u, '');
}

export function normalizeInventoryVolume(quantity: InventoryVolume): InventoryVolume {
  const value = renderDecimal(decimalVolume(quantity));
  if (value.length > 128)
    throw new TypeError('The normalized volume exceeds the supported decimal range.');
  return { value, unit: 'uL' };
}

export function normalizeInventoryQuantity(quantity: InventoryQuantity): InventoryQuantity {
  return quantity.kind === 'unknown'
    ? { kind: 'unknown' }
    : { kind: 'known', ...normalizeInventoryVolume(quantity) };
}

export function subtractInventoryVolume(
  available: InventoryVolume,
  consumed: InventoryVolume
):
  | { readonly kind: 'remaining'; readonly quantity: InventoryVolume }
  | { readonly kind: 'non-positive' }
  | { readonly kind: 'insufficient' } {
  const source = decimalVolume(available);
  const requested = decimalVolume(consumed);
  if (requested.coefficient === 0n) return { kind: 'non-positive' };
  const scale = Math.max(source.scale, requested.scale);
  const remaining =
    source.coefficient * 10n ** BigInt(scale - source.scale) -
    requested.coefficient * 10n ** BigInt(scale - requested.scale);
  return remaining < 0n
    ? { kind: 'insufficient' }
    : {
        kind: 'remaining',
        quantity: normalizeInventoryVolume({
          value: renderDecimal({ coefficient: remaining, scale }),
          unit: 'uL',
        }),
      };
}

export function compareInventoryVolumes(
  first: InventoryVolume,
  second: InventoryVolume
): -1 | 0 | 1 {
  const left = decimalVolume(first);
  const right = decimalVolume(second);
  const scale = Math.max(left.scale, right.scale);
  const a = left.coefficient * 10n ** BigInt(scale - left.scale);
  const b = right.coefficient * 10n ** BigInt(scale - right.scale);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function addInventoryVolumes(values: readonly InventoryVolume[]): InventoryVolume {
  const parsed = values.map(decimalVolume);
  const scale = Math.max(0, ...parsed.map((value) => value.scale));
  const coefficient = parsed.reduce(
    (sum, value) => sum + value.coefficient * 10n ** BigInt(scale - value.scale),
    0n
  );
  return normalizeInventoryVolume({ value: renderDecimal({ coefficient, scale }), unit: 'uL' });
}
