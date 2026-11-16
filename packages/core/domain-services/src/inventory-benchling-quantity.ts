import {
  JsonNumberLexeme,
  parseUniqueJsonWithNumberLexemes,
  UNIQUE_JSON_NUMBER_LIMIT_MESSAGE,
  type ExactJsonValue,
} from '@waypoint/scientific-objects/unique-json';
import type {
  InventoryBenchlingField,
  InventoryBenchlingObservedField,
} from './inventory-benchling-types';

export type InventoryBenchlingQuantitySourceField = 'quantity' | 'volume';

export type InventoryBenchlingQuantityAmount =
  | { readonly kind: 'omitted' }
  | { readonly kind: 'null' }
  | { readonly kind: 'number'; readonly lexeme: string }
  | { readonly kind: 'other'; readonly jsonText: string };

export type InventoryBenchlingQuantityUnits =
  | { readonly kind: 'omitted' }
  | { readonly kind: 'null' }
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'other'; readonly jsonText: string };

export interface InventoryBenchlingQuantityFacts {
  readonly amount: InventoryBenchlingQuantityAmount;
  readonly units: InventoryBenchlingQuantityUnits;
}

type QuantityIssueCode =
  | 'QUANTITY_JSON_INVALID'
  | 'QUANTITY_SHAPE_INVALID'
  | 'QUANTITY_SOURCE_LIMIT'
  | 'QUANTITY_VALUE_TYPE'
  | 'QUANTITY_UNITS_TYPE'
  | 'QUANTITY_VALUE_UNRESOLVED'
  | 'QUANTITY_UNITS_UNRESOLVED'
  | 'QUANTITY_UNIT_UNSUPPORTED'
  | 'QUANTITY_NEGATIVE'
  | 'QUANTITY_RANGE_UNSUPPORTED';

export type InventoryBenchlingQuantityInterpretation = {
  readonly sourceField: InventoryBenchlingQuantitySourceField;
} & (
  | { readonly kind: 'omitted' | 'null' | 'conflict' }
  | {
      readonly kind: 'invalid' | 'unsupported';
      readonly facts: InventoryBenchlingQuantityFacts | null;
      readonly code: QuantityIssueCode;
      readonly message: string;
    }
  | {
      readonly kind: 'unresolved';
      readonly facts: InventoryBenchlingQuantityFacts;
      readonly code: QuantityIssueCode;
      readonly message: string;
    }
  | {
      readonly kind: 'volume';
      readonly facts: {
        readonly amount: Extract<InventoryBenchlingQuantityAmount, { kind: 'number' }>;
        readonly units: Extract<InventoryBenchlingQuantityUnits, { kind: 'text' }>;
      };
      readonly quantity: { readonly kind: 'known'; readonly value: string; readonly unit: 'uL' };
    }
);

const MAX_SOURCE_BYTES = 4096;
const MAX_CANONICAL_LENGTH = 128;
const UNIT_EXPONENT = { L: 6, mL: 3, uL: 0, nL: -3, pL: -6 } as const;

function exactJson(value: ExactJsonValue): string {
  if (value instanceof JsonNumberLexeme) return value.lexeme;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(exactJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${exactJson(value[key])}`)
    .join(',')}}`;
}

function quantityFacts(value: { [key: string]: ExactJsonValue }): InventoryBenchlingQuantityFacts {
  const amount: InventoryBenchlingQuantityAmount = !Object.hasOwn(value, 'value')
    ? { kind: 'omitted' }
    : value.value === null
      ? { kind: 'null' }
      : value.value instanceof JsonNumberLexeme
        ? { kind: 'number', lexeme: value.value.lexeme }
        : { kind: 'other', jsonText: exactJson(value.value) };
  const units: InventoryBenchlingQuantityUnits = !Object.hasOwn(value, 'units')
    ? { kind: 'omitted' }
    : value.units === null
      ? { kind: 'null' }
      : typeof value.units === 'string'
        ? { kind: 'text', value: value.units }
        : { kind: 'other', jsonText: exactJson(value.units) };
  return { amount, units };
}

function canonicalVolume(
  lexeme: string,
  unitExponent: number
): { kind: 'volume'; value: string } | { kind: 'negative' | 'range' } {
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?)(\d+))?$/u.exec(lexeme)!;
  const fraction = match[3] ?? '';
  const coefficient = `${match[2]}${fraction}`.replace(/^0+/u, '');
  if (!coefficient) return { kind: 'volume', value: '0' };
  if (match[1]) return { kind: 'negative' };
  const exponentDigits = (match[5] ?? '').replace(/^0+/u, '');
  if (exponentDigits.length > 4) return { kind: 'range' };
  let exponent = 0;
  for (const digit of exponentDigits) exponent = exponent * 10 + digit.charCodeAt(0) - 48;
  if (match[4] === '-') exponent = -exponent;
  const significant = coefficient.replace(/0+$/u, '');
  const decimalPower =
    exponent - fraction.length + coefficient.length - significant.length + unitExponent;
  const point = significant.length + decimalPower;
  const length =
    point >= significant.length
      ? point
      : point > 0
        ? significant.length + 1
        : 2 - point + significant.length;
  if (length > MAX_CANONICAL_LENGTH) return { kind: 'range' };
  const value =
    point >= significant.length
      ? significant + '0'.repeat(point - significant.length)
      : point > 0
        ? `${significant.slice(0, point)}.${significant.slice(point)}`
        : `0.${'0'.repeat(-point)}${significant}`;
  return { kind: 'volume', value };
}

export function interpretInventoryBenchlingQuantity({
  sourceField,
  field,
}: {
  readonly sourceField: InventoryBenchlingQuantitySourceField;
  readonly field: InventoryBenchlingField | InventoryBenchlingObservedField;
}): InventoryBenchlingQuantityInterpretation {
  if (sourceField !== 'quantity' && sourceField !== 'volume')
    throw new TypeError('Choose quantity or volume explicitly.');
  if (field.kind === 'omitted' || field.kind === 'null' || field.kind === 'conflict')
    return { sourceField, kind: field.kind };
  if (
    field.jsonText.length > MAX_SOURCE_BYTES ||
    new TextEncoder().encode(field.jsonText).byteLength > MAX_SOURCE_BYTES
  )
    return {
      sourceField,
      kind: 'unsupported',
      facts: null,
      code: 'QUANTITY_SOURCE_LIMIT',
      message: 'The selected quantity field exceeds the supported 4096-byte interpretation limit.',
    };
  let value: ExactJsonValue;
  try {
    value = parseUniqueJsonWithNumberLexemes(field.jsonText, {
      maxDepth: 8,
      maxNumbers: 32,
    }).value;
  } catch (error) {
    const limited = error instanceof Error && error.message === UNIQUE_JSON_NUMBER_LIMIT_MESSAGE;
    return {
      sourceField,
      kind: limited ? 'unsupported' : 'invalid',
      facts: null,
      code: limited ? 'QUANTITY_SOURCE_LIMIT' : 'QUANTITY_JSON_INVALID',
      message: limited
        ? 'The selected quantity field exceeds the supported 32 numeric tokens.'
        : 'The selected quantity field requires valid unique-key JSON within the supported depth.',
    };
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value instanceof JsonNumberLexeme
  )
    return {
      sourceField,
      kind: 'invalid',
      facts: null,
      code: 'QUANTITY_SHAPE_INVALID',
      message: 'The selected quantity field must be an object with separate value and units facts.',
    };
  const facts = quantityFacts(value);
  if (facts.amount.kind === 'other' || facts.units.kind === 'other')
    return {
      sourceField,
      kind: 'invalid',
      facts,
      code: facts.amount.kind === 'other' ? 'QUANTITY_VALUE_TYPE' : 'QUANTITY_UNITS_TYPE',
      message:
        facts.amount.kind === 'other'
          ? 'A source amount must be a JSON number, explicit null or omitted.'
          : 'Source units must be a string, explicit null or omitted.',
    };
  if (facts.amount.kind !== 'number' || facts.units.kind !== 'text')
    return {
      sourceField,
      kind: 'unresolved',
      facts,
      code:
        facts.amount.kind !== 'number' ? 'QUANTITY_VALUE_UNRESOLVED' : 'QUANTITY_UNITS_UNRESOLVED',
      message:
        facts.amount.kind !== 'number'
          ? 'An omitted or null source amount is not a known zero.'
          : 'An omitted or null unit does not establish a volume dimension.',
    };
  const units = facts.units.value;
  if (!Object.hasOwn(UNIT_EXPONENT, units))
    return {
      sourceField,
      kind: 'unsupported',
      facts,
      code: 'QUANTITY_UNIT_UNSUPPORTED',
      message:
        'This source unit is not one of the supported exact volume units L, mL, uL, nL or pL.',
    };
  const normalized = canonicalVolume(
    facts.amount.lexeme,
    UNIT_EXPONENT[units as keyof typeof UNIT_EXPONENT]
  );
  if (normalized.kind !== 'volume')
    return {
      sourceField,
      kind: normalized.kind === 'negative' ? 'invalid' : 'unsupported',
      facts,
      code: normalized.kind === 'negative' ? 'QUANTITY_NEGATIVE' : 'QUANTITY_RANGE_UNSUPPORTED',
      message:
        normalized.kind === 'negative'
          ? 'A negative source amount cannot become inventory volume.'
          : 'The exact source volume exceeds the supported 128-character canonical decimal range.',
    };
  return {
    sourceField,
    kind: 'volume',
    facts: { amount: facts.amount, units: facts.units },
    quantity: { kind: 'known', value: normalized.value, unit: 'uL' },
  };
}
