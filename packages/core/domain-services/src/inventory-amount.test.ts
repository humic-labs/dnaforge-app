import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  addInventoryAmounts,
  compareInventoryAmounts,
  INVENTORY_AMOUNT_UNITS,
  inventoryAmountUnitDefinition,
  normalizeInventoryAmount,
  subtractInventoryAmounts,
  type InventoryAmount,
} from './inventory-amount';
import {
  addInventoryVolumes,
  compareInventoryVolumes,
  normalizeInventoryVolume,
  subtractInventoryVolume,
} from './inventory-volume';

describe('exact dimensioned inventory amounts', () => {
  it.each([
    [
      { value: '1.2300', unit: 'mL' },
      { value: '1230', unit: 'uL' },
    ],
    [
      { value: '1', unit: 'pL' },
      { value: '0.000001', unit: 'uL' },
    ],
    [
      { value: '1.2500', unit: 'mg' },
      { value: '1250000', unit: 'ng' },
    ],
    [
      { value: '1', unit: 'kg' },
      { value: '1000000000000', unit: 'ng' },
    ],
    [
      { value: '0.1', unit: 'pg' },
      { value: '0.0001', unit: 'ng' },
    ],
    [
      { value: '1.25', unit: 'umol' },
      { value: '1250', unit: 'nmol' },
    ],
    [
      { value: '1', unit: 'fmol' },
      { value: '0.000001', unit: 'nmol' },
    ],
    [
      { value: '9007199254740993', unit: 'item' },
      { value: '9007199254740993', unit: 'item' },
    ],
    [
      { value: '42.000', unit: 'item' },
      { value: '42', unit: 'item' },
    ],
  ] satisfies [InventoryAmount, InventoryAmount][])(
    'normalizes %j without floating-point conversion',
    (input, expected) => {
      expect(normalizeInventoryAmount(input)).toEqual(expected);
      expect(normalizeInventoryAmount(expected)).toEqual(expected);
    }
  );
  it.each(INVENTORY_AMOUNT_UNITS)('preserves the dimension of known zero in %s', (unit) => {
    const result = normalizeInventoryAmount({ value: '0.000', unit });
    expect(result).toEqual({ value: '0', unit: inventoryAmountUnitDefinition(unit).canonicalUnit });
    expect(inventoryAmountUnitDefinition(result.unit).dimension).toBe(
      inventoryAmountUnitDefinition(unit).dimension
    );
  });
  it.each([
    [
      { value: '1', unit: 'mg' },
      { value: '1', unit: 'mL' },
    ],
    [
      { value: '0', unit: 'ng' },
      { value: '0', unit: 'nmol' },
    ],
    [
      { value: '1', unit: 'item' },
      { value: '1', unit: 'uL' },
    ],
  ] satisfies [InventoryAmount, InventoryAmount][])(
    'refuses implicit conversion between %j and %j',
    (left, right) => {
      expect(compareInventoryAmounts(left, right).kind).toBe('incompatible');
      expect(subtractInventoryAmounts(left, right).kind).toBe('incompatible');
      expect(addInventoryAmounts([left, right], left.unit).kind).toBe('incompatible');
    }
  );
  it('conserves exact mass and compares compatible prefixes', () => {
    const remaining = subtractInventoryAmounts(
      { value: '1', unit: 'mg' },
      { value: '125', unit: 'ug' }
    );
    expect(remaining).toEqual({ kind: 'remaining', quantity: { value: '875000', unit: 'ng' } });
    if (remaining.kind !== 'remaining') throw new Error('Expected exact subtraction.');
    expect(addInventoryAmounts([remaining.quantity, { value: '125', unit: 'ug' }], 'mg')).toEqual({
      kind: 'added',
      quantity: { value: '1000000', unit: 'ng' },
    });
    expect(
      compareInventoryAmounts({ value: '1', unit: 'mg' }, { value: '1000', unit: 'ug' })
    ).toEqual({ kind: 'compared', order: 0 });
  });
  it('subtracts whole counts beyond the safe integer range without rounding', () => {
    expect(
      subtractInventoryAmounts(
        { value: '9007199254740993', unit: 'item' },
        { value: '2', unit: 'item' }
      )
    ).toEqual({ kind: 'remaining', quantity: { value: '9007199254740991', unit: 'item' } });
    expect(
      subtractInventoryAmounts({ value: '2', unit: 'item' }, { value: '3', unit: 'item' })
    ).toEqual({ kind: 'insufficient' });
    expect(
      subtractInventoryAmounts({ value: '2', unit: 'item' }, { value: '0', unit: 'item' })
    ).toEqual({ kind: 'non-positive' });
  });
  it.each(['0.5', '1.0001', '9007199254740993.5'])('refuses fractional item count %s', (value) => {
    expect(() => normalizeInventoryAmount({ value, unit: 'item' })).toThrow(/whole number/);
  });
  it('requires an explicit dimension for empty sums and rejects unsupported assay/activity units', () => {
    expect(addInventoryAmounts([], 'mg')).toEqual({
      kind: 'added',
      quantity: { value: '0', unit: 'ng' },
    });
    expect(addInventoryAmounts([], 'item')).toEqual({
      kind: 'added',
      quantity: { value: '0', unit: 'item' },
    });
    for (const unit of ['U', 'IU', 'cells', '__proto__'])
      expect(() => normalizeInventoryAmount({ value: '1', unit } as any)).toThrow(
        /supported explicit unit/
      );
  });
  it('rejects malformed, excessive and rounded-number inputs before using them', () => {
    for (const value of [1, NaN, Infinity, '-1', '1e3', '01', '', '9'.repeat(129)])
      expect(() => normalizeInventoryAmount({ value, unit: 'ng' } as any)).toThrow();
    expect(() => normalizeInventoryAmount({ value: '9'.repeat(128), unit: 'kg' })).toThrow(
      /supported decimal range/
    );
    expect(() =>
      addInventoryAmounts(
        [
          { value: '9'.repeat(128), unit: 'ng' },
          { value: '1', unit: 'ng' },
        ],
        'ng'
      )
    ).toThrow(/supported decimal range/);
    expect(() =>
      addInventoryAmounts(
        Array.from({ length: 10001 }, () => ({ value: '0', unit: 'ng' })),
        'ng'
      )
    ).toThrow(/input count/);
  });
  it('keeps unit definitions immutable to callers', () => {
    expect(Object.isFrozen(INVENTORY_AMOUNT_UNITS)).toBe(true);
    expect(Object.isFrozen(inventoryAmountUnitDefinition('mg'))).toBe(true);
    expect(() => {
      (inventoryAmountUnitDefinition('mg') as any).dimension = 'volume';
    }).toThrow();
  });
  it('matches the established volume API across mixed prefixes and decimal scales', () => {
    const inputs = [
      { value: '1.25', unit: 'mL' },
      { value: '0.000001', unit: 'L' },
      { value: '1234.5', unit: 'nL' },
    ] as const;
    for (const amount of inputs)
      expect(normalizeInventoryAmount(amount)).toEqual(normalizeInventoryVolume(amount));
    expect(addInventoryAmounts(inputs, 'uL')).toEqual({
      kind: 'added',
      quantity: addInventoryVolumes(inputs),
    });
    for (const first of inputs)
      for (const second of inputs) {
        expect(compareInventoryAmounts(first, second)).toEqual({
          kind: 'compared',
          order: compareInventoryVolumes(first, second),
        });
        expect(subtractInventoryAmounts(first, second)).toEqual(
          subtractInventoryVolume(first, second)
        );
      }
    expect(() => normalizeInventoryVolume({ value: '1', unit: 'mg' } as any)).toThrow();
  });
});

it('preserves the recorded legacy volume normalization, comparison, subtraction and summation behavior', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('./__tests__/fixtures/inventory-volume-legacy.json', import.meta.url),
      'utf8'
    )
  ) as { schema: string; cases: { operation: string; args: unknown[]; result: unknown }[] };
  expect(fixture.schema).toBe('dnaforge.inventory-volume-regressions.v1');
  const operations = {
    normalizeInventoryVolume,
    compareInventoryVolumes,
    subtractInventoryVolume,
    addInventoryVolumes,
  };
  for (const item of fixture.cases) {
    expect(Object.hasOwn(operations, item.operation)).toBe(true);
    let result: unknown;
    try {
      result = {
        kind: 'returned',
        value: (
          operations[item.operation as keyof typeof operations] as (...args: any[]) => unknown
        )(...item.args),
      };
    } catch (error) {
      result = { kind: 'threw', name: error instanceof Error ? error.name : typeof error };
    }
    expect(result, `${item.operation} ${JSON.stringify(item.args)}`).toEqual(item.result);
  }
});
