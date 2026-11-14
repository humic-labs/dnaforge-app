import { INVENTORY_DECIMAL_PATTERN, type InventoryVolume } from './inventory-types';
import { normalizeInventoryVolume } from './inventory-volume';

export const INVENTORY_CONCENTRATION_UNITS = [
  'ng/uL',
  'ug/mL',
  'mg/mL',
  'g/L',
  'ng/mL',
  'pg/uL',
  'M',
  'mM',
  'uM',
  'nM',
  'nmol/uL',
  'pmol/uL',
] as const;
export type InventoryConcentrationUnit = (typeof INVENTORY_CONCENTRATION_UNITS)[number];
export type InventoryCanonicalConcentrationUnit = 'ng/uL' | 'nmol/uL';
export interface InventoryRational {
  readonly numerator: string;
  readonly denominator: string;
}
export type InventoryConcentration =
  | {
      readonly kind: 'unknown';
      readonly reason: 'unmeasured' | 'missing-input' | 'incompatible-units';
    }
  | ({
      readonly kind: 'known';
      readonly unit: InventoryCanonicalConcentrationUnit;
    } & InventoryRational);
export type InventoryComposition =
  | { readonly kind: 'unknown' }
  | {
      readonly kind: 'homogeneous';
      readonly analytes: Readonly<Record<string, InventoryConcentration>>;
    };
export interface InventoryCompositionContribution {
  readonly quantity: InventoryVolume;
  readonly composition: InventoryComposition;
}

const UNIT_SCALE: Readonly<
  Record<InventoryConcentrationUnit, readonly [InventoryCanonicalConcentrationUnit, bigint, bigint]>
> = {
  'ng/uL': ['ng/uL', 1n, 1n],
  'ug/mL': ['ng/uL', 1n, 1n],
  'mg/mL': ['ng/uL', 1000n, 1n],
  'g/L': ['ng/uL', 1000n, 1n],
  'ng/mL': ['ng/uL', 1n, 1000n],
  'pg/uL': ['ng/uL', 1n, 1000n],
  M: ['nmol/uL', 1000n, 1n],
  mM: ['nmol/uL', 1n, 1n],
  uM: ['nmol/uL', 1n, 1000n],
  nM: ['nmol/uL', 1n, 1000000n],
  'nmol/uL': ['nmol/uL', 1n, 1n],
  'pmol/uL': ['nmol/uL', 1n, 1000n],
};
const DECIMAL = new RegExp(INVENTORY_DECIMAL_PATTERN, 'u');
const INTEGER = /^(?:0|[1-9]\d*)$/u;
const MAX_RATIONAL_DIGITS = 256;

function rational(numerator: bigint, denominator: bigint, bounded = true): InventoryRational {
  if (numerator < 0n || denominator <= 0n)
    throw new TypeError(
      'A concentration requires a non-negative numerator and positive denominator.'
    );
  let a = numerator;
  let b = denominator;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  const value = {
    numerator: (numerator / a).toString(),
    denominator: (denominator / a).toString(),
  };
  if (
    bounded &&
    (value.numerator.length > MAX_RATIONAL_DIGITS || value.denominator.length > MAX_RATIONAL_DIGITS)
  )
    throw new TypeError('The exact concentration exceeds the supported rational range.');
  return value;
}

function decimal(value: string): InventoryRational {
  if (typeof value !== 'string' || value.length > 128 || !DECIMAL.test(value))
    throw new TypeError('Concentration requires a non-negative decimal value.');
  const [whole, fraction = ''] = value.split('.');
  return rational(BigInt(whole + fraction), 10n ** BigInt(fraction.length));
}

function multiply(first: InventoryRational, second: InventoryRational): InventoryRational {
  return rational(
    BigInt(first.numerator) * BigInt(second.numerator),
    BigInt(first.denominator) * BigInt(second.denominator),
    false
  );
}

function add(first: InventoryRational, second: InventoryRational): InventoryRational {
  return rational(
    BigInt(first.numerator) * BigInt(second.denominator) +
      BigInt(second.numerator) * BigInt(first.denominator),
    BigInt(first.denominator) * BigInt(second.denominator),
    false
  );
}

export function validateInventoryConcentration(value: InventoryConcentration): void {
  if (value.kind === 'unknown') {
    if (!['unmeasured', 'missing-input', 'incompatible-units'].includes(value.reason))
      throw new TypeError('Unknown concentration requires an explicit supported reason.');
    return;
  }
  if (value.kind !== 'known') throw new TypeError('Unsupported concentration knowledge state.');
  if (
    !['ng/uL', 'nmol/uL'].includes(value.unit) ||
    !INTEGER.test(value.numerator) ||
    !INTEGER.test(value.denominator) ||
    value.numerator.length > MAX_RATIONAL_DIGITS ||
    value.denominator.length > MAX_RATIONAL_DIGITS
  )
    throw new TypeError(
      'Stored concentration requires supported units and bounded exact integers.'
    );
  const normalized = rational(BigInt(value.numerator), BigInt(value.denominator));
  if (value.numerator !== normalized.numerator || value.denominator !== normalized.denominator)
    throw new TypeError('Stored concentration requires a reduced canonical ratio.');
}

export function validateInventoryComposition(value: InventoryComposition): void {
  if (value.kind === 'unknown') return;
  if (
    value.kind !== 'homogeneous' ||
    !value.analytes ||
    typeof value.analytes !== 'object' ||
    Array.isArray(value.analytes)
  )
    throw new TypeError('Composition requires an explicit supported mixing state and analyte map.');
  const entries = Object.entries(value.analytes);
  if (entries.length > 256)
    throw new TypeError('A composition supports at most256 tracked analytes.');
  for (const [id, concentration] of entries) {
    if (!id.trim() || id.trim() !== id || id.length > 512 || id.includes('\0'))
      throw new TypeError('An analyte requires a valid material identifier.');
    validateInventoryConcentration(concentration);
  }
}

export function normalizeInventoryConcentration(input: {
  readonly value: string;
  readonly unit: InventoryConcentrationUnit;
}): InventoryConcentration {
  if (!Object.hasOwn(UNIT_SCALE, input.unit))
    throw new TypeError('Unsupported concentration unit.');
  const [unit, numerator, denominator] = UNIT_SCALE[input.unit];
  const amount = multiply(decimal(input.value), rational(numerator, denominator));
  return { kind: 'known', unit, ...rational(BigInt(amount.numerator), BigInt(amount.denominator)) };
}

export function inventoryConcentrationFor(
  composition: InventoryComposition,
  analyteId: string
): InventoryConcentration {
  return composition.kind === 'homogeneous' && Object.hasOwn(composition.analytes, analyteId)
    ? composition.analytes[analyteId]
    : { kind: 'unknown', reason: 'unmeasured' };
}

export function mixInventoryCompositions(
  contributions: readonly InventoryCompositionContribution[],
  outputMixing: 'homogeneous' | 'unknown'
): InventoryComposition {
  if (outputMixing !== 'homogeneous' && outputMixing !== 'unknown')
    throw new TypeError('An explicit output mixing state is required.');
  if (contributions.length < 2 || contributions.length > 256)
    throw new TypeError('Mixing requires two to256 bounded contributions.');
  for (const contribution of contributions) validateInventoryComposition(contribution.composition);
  const volumes = contributions.map((input) =>
    decimal(normalizeInventoryVolume(input.quantity).value)
  );
  if (volumes.some((volume) => volume.numerator === '0'))
    throw new TypeError('Every concentration contribution requires positive volume.');
  if (
    outputMixing === 'unknown' ||
    contributions.some((input) => input.composition.kind === 'unknown')
  )
    return { kind: 'unknown' };
  const ids = new Set(
    contributions.flatMap((input) =>
      input.composition.kind === 'homogeneous' ? Object.keys(input.composition.analytes) : []
    )
  );
  if (ids.size > 256) throw new TypeError('A mixture supports at most256 tracked analytes.');
  const total = volumes.reduce(add, { numerator: '0', denominator: '1' });
  const analytes: Record<string, InventoryConcentration> = Object.create(null);
  for (const id of ids) {
    const values = contributions.map((input) => inventoryConcentrationFor(input.composition, id));
    for (const value of values) validateInventoryConcentration(value);
    if (values.some((value) => value.kind === 'unknown')) {
      analytes[id] = { kind: 'unknown', reason: 'missing-input' };
      continue;
    }
    const known = values as readonly Extract<InventoryConcentration, { kind: 'known' }>[];
    if (known.some((value) => value.unit !== known[0].unit)) {
      analytes[id] = { kind: 'unknown', reason: 'incompatible-units' };
      continue;
    }
    const mass = known
      .map((value, index) => multiply(value, volumes[index]))
      .reduce(add, { numerator: '0', denominator: '1' });
    const average = multiply(
      mass,
      rational(BigInt(total.denominator), BigInt(total.numerator), false)
    );
    analytes[id] = {
      kind: 'known',
      unit: known[0].unit,
      ...rational(BigInt(average.numerator), BigInt(average.denominator)),
    };
  }
  return { kind: 'homogeneous', analytes };
}
