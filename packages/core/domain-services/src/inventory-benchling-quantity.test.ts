import { describe, expect, it, vi } from 'vitest';
import type {
  InventoryBenchlingField,
  InventoryBenchlingObservedField,
} from './inventory-benchling-types';
import { interpretInventoryBenchlingQuantity } from './inventory-benchling-quantity';
import { normalizeInventoryVolume } from './inventory-volume';

const present = (jsonText: string): InventoryBenchlingObservedField => ({
  responseId: 'source-response',
  pointer: '/quantity',
  kind: 'present',
  jsonText,
});
const interpret = (jsonText: string, sourceField: 'quantity' | 'volume' = 'quantity') =>
  interpretInventoryBenchlingQuantity({ sourceField, field: present(jsonText) });
const amount = (lexeme: string, units = 'uL') =>
  interpret(`{"value":${lexeme},"units":${JSON.stringify(units)}}`);

describe('exact Benchling source quantity interpretation', () => {
  it.each(['quantity', 'volume'] as const)(
    'requires the selected %s field explicitly',
    (sourceField) => {
      expect(interpret('{"value":2,"units":"uL"}', sourceField)).toMatchObject({
        sourceField,
        kind: 'volume',
        quantity: { kind: 'known', value: '2', unit: 'uL' },
      });
    }
  );

  it('refuses an undeclared field choice', () => {
    expect(() =>
      interpretInventoryBenchlingQuantity({
        sourceField: undefined as never,
        field: present('{"value":2,"units":"uL"}'),
      })
    ).toThrow('Choose quantity or volume explicitly.');
  });

  it.each([
    { kind: 'omitted', responseId: 'source-response', pointer: '/quantity' } as const,
    { kind: 'null', responseId: 'source-response', pointer: '/quantity' } as const,
  ])('keeps an entire $kind quantity distinct from zero', (field) => {
    expect(interpretInventoryBenchlingQuantity({ sourceField: 'quantity', field })).toEqual({
      sourceField: 'quantity',
      kind: field.kind,
    });
  });

  it('does not choose a conflict alternative or reinterpret its observation order', () => {
    const field: InventoryBenchlingField = {
      kind: 'conflict',
      alternatives: [{ kind: 'present', jsonText: '{"value":2,"units":"uL"}' }, { kind: 'null' }],
      observations: [],
    };
    expect(interpretInventoryBenchlingQuantity({ sourceField: 'volume', field })).toEqual({
      sourceField: 'volume',
      kind: 'conflict',
    });
    expect(
      interpretInventoryBenchlingQuantity({
        sourceField: 'volume',
        field: { ...field, alternatives: [...field.alternatives].reverse() },
      })
    ).toEqual({ sourceField: 'volume', kind: 'conflict' });
  });

  it.each([
    ['0', 'uL', '0'],
    ['-0', 'uL', '0'],
    ['-0.000e999999999999999999999', 'mL', '0'],
    ['0e-999999999999999999999', 'pL', '0'],
    ['1.2300', 'uL', '1.23'],
    ['1.2300e+2', 'uL', '123'],
    ['1.2300E-2', 'uL', '0.0123'],
    ['0.00012e+2', 'uL', '0.012'],
    ['10.2500', 'uL', '10.25'],
    ['0.10000000000000001', 'uL', '0.10000000000000001'],
    ['9007199254740993', 'uL', '9007199254740993'],
    ['9007199254740993e-3', 'uL', '9007199254740.993'],
    ['1.2300', 'L', '1230000'],
    ['0.000001', 'L', '1'],
    ['1.2300', 'mL', '1230'],
    ['1.2300', 'nL', '0.00123'],
    ['1.2300', 'pL', '0.00000123'],
    ['1000000', 'pL', '1'],
    ['1.00e-3', 'nL', '0.000001'],
    ['10e+00000000000000000000002', 'uL', '1000'],
  ])('normalizes exact %s %s as %s uL', (lexeme, units, value) => {
    const result = amount(lexeme, units);
    expect(result).toEqual({
      sourceField: 'quantity',
      kind: 'volume',
      facts: {
        amount: { kind: 'number', lexeme },
        units: { kind: 'text', value: units },
      },
      quantity: { kind: 'known', value, unit: 'uL' },
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('never converts a source amount or exponent through Number', () => {
    const original = globalThis.Number;
    vi.stubGlobal(
      'Number',
      new Proxy(original, {
        apply() {
          throw new Error('Number conversion attempted.');
        },
      })
    );
    try {
      expect(amount('9007199254740993e-3')).toMatchObject({
        kind: 'volume',
        quantity: { value: '9007199254740.993' },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('matches the existing exact decimal volume contract in every existing unit', () => {
    for (const unit of ['L', 'mL', 'uL', 'nL'] as const)
      for (const value of ['0', '1', '0.00120', '12345678901234567890.001', '999.999999']) {
        expect(amount(value, unit)).toMatchObject({
          kind: 'volume',
          quantity: { kind: 'known', ...normalizeInventoryVolume({ value, unit }) },
        });
      }
  });

  it.each(['-1', '-1e-400', '-0.00000000000000000001', '-9007199254740993e99999'])(
    'refuses mathematically negative %s without floating underflow',
    (lexeme) => {
      expect(amount(lexeme)).toMatchObject({
        kind: 'invalid',
        code: 'QUANTITY_NEGATIVE',
        facts: { amount: { kind: 'number', lexeme } },
      });
    }
  );

  it.each([
    ['{}', 'omitted', 'omitted'],
    ['{"value":null,"units":null}', 'null', 'null'],
    ['{"value":null,"units":"uL"}', 'null', 'text'],
    ['{"units":"uL"}', 'omitted', 'text'],
    ['{"value":0}', 'number', 'omitted'],
    ['{"value":0,"units":null}', 'number', 'null'],
  ])('retains incomplete amount/unit facts in %s', (jsonText, valueKind, unitsKind) => {
    const result = interpret(jsonText);
    expect(result).toMatchObject({
      kind: 'unresolved',
      facts: { amount: { kind: valueKind }, units: { kind: unitsKind } },
    });
    expect(result).not.toHaveProperty('quantity');
  });

  it.each([
    'mg',
    'cells',
    'items',
    'mol',
    'gal (US)',
    'unknown',
    '',
    'ul',
    'µL',
    'μL',
    '__proto__',
  ])('retains unsupported source dimension/unit %j without inventing volume', (units) => {
    expect(amount('0', units)).toMatchObject({
      kind: 'unsupported',
      code: 'QUANTITY_UNIT_UNSUPPORTED',
      facts: { amount: { kind: 'number', lexeme: '0' }, units: { kind: 'text', value: units } },
    });
  });

  it('does not assume deprecated volume is volumetric', () => {
    expect(interpret('{"value":1.2300,"units":"mg"}', 'volume')).toMatchObject({
      sourceField: 'volume',
      kind: 'unsupported',
      code: 'QUANTITY_UNIT_UNSUPPORTED',
      facts: {
        amount: { kind: 'number', lexeme: '1.2300' },
        units: { kind: 'text', value: 'mg' },
      },
    });
  });

  it.each(['"1.2300"', 'true', '[]', '{"nested":9007199254740993}'])(
    'keeps nonnumeric amount %s as invalid exact source evidence',
    (raw) => {
      expect(interpret(`{"value":${raw},"units":"uL"}`)).toMatchObject({
        kind: 'invalid',
        code: 'QUANTITY_VALUE_TYPE',
        facts: { amount: { kind: 'other', jsonText: raw }, units: { kind: 'text', value: 'uL' } },
      });
    }
  );

  it.each(['1.2300', 'false', '[]', '{"nested":1e400}'])(
    'keeps nontext units %s as invalid exact source evidence',
    (raw) => {
      expect(interpret(`{"value":2,"units":${raw}}`)).toMatchObject({
        kind: 'invalid',
        code: 'QUANTITY_UNITS_TYPE',
        facts: { amount: { kind: 'number', lexeme: '2' }, units: { kind: 'other', jsonText: raw } },
      });
    }
  );

  it.each([
    '',
    '{',
    '{"value":1,"value":2,"units":"uL"}',
    '{"value":1,"\\u0076alue":2,"units":"uL"}',
    '{"value":NaN,"units":"uL"}',
    '{"value":Infinity,"units":"uL"}',
    '{"value":01,"units":"uL"}',
    '{"value":1e,"units":"uL"}',
  ])('refuses invalid or duplicate-key JSON %j', (jsonText) => {
    expect(interpret(jsonText)).toMatchObject({
      kind: 'invalid',
      code: 'QUANTITY_JSON_INVALID',
      facts: null,
    });
  });

  it.each(['null', '[]', '1', '"quantity"'])('refuses nonobject source field %s', (raw) => {
    expect(interpret(raw)).toMatchObject({
      kind: 'invalid',
      code: 'QUANTITY_SHAPE_INVALID',
      facts: null,
    });
  });

  it('refuses excessive depth and numeric token allocations', () => {
    expect(interpret(`{"value":${'['.repeat(9)}1${']'.repeat(9)},"units":"uL"}`)).toMatchObject({
      kind: 'invalid',
      code: 'QUANTITY_JSON_INVALID',
    });
    expect(
      interpret(`{"value":1,"units":"uL","extra":[${Array(32).fill('0').join(',')}]}`)
    ).toMatchObject({ kind: 'unsupported', code: 'QUANTITY_SOURCE_LIMIT', facts: null });
  });

  it('bounds UTF-8 bytes before parsing a large source token or multibyte field', () => {
    for (const jsonText of [
      `{"value":1e${'9'.repeat(100000)},"units":"uL"}`,
      JSON.stringify({ value: 1, units: 'uL', evidence: '雪'.repeat(2000) }),
    ])
      expect(interpret(jsonText)).toMatchObject({
        kind: 'unsupported',
        code: 'QUANTITY_SOURCE_LIMIT',
        facts: null,
      });
  });

  it.each(['1e400', '1e-400', '1e9999', '1e-9999', `1e${'9'.repeat(1000)}`])(
    'bounds exact exponent %s before decimal expansion',
    (lexeme) => {
      expect(amount(lexeme)).toMatchObject({
        kind: 'unsupported',
        code: 'QUANTITY_RANGE_UNSUPPORTED',
        facts: { amount: { kind: 'number', lexeme } },
      });
    }
  );

  it('admits exactly the canonical range and refuses the adjacent values', () => {
    expect(amount('1e127')).toMatchObject({
      kind: 'volume',
      quantity: { value: `1${'0'.repeat(127)}` },
    });
    expect(amount('1e128')).toMatchObject({
      kind: 'unsupported',
      code: 'QUANTITY_RANGE_UNSUPPORTED',
    });
    expect(amount('1e-126')).toMatchObject({
      kind: 'volume',
      quantity: { value: `0.${'0'.repeat(125)}1` },
    });
    expect(amount('1e-127')).toMatchObject({
      kind: 'unsupported',
      code: 'QUANTITY_RANGE_UNSUPPORTED',
    });
    expect(amount('1e122', 'L')).toMatchObject({ kind: 'unsupported' });
    expect(amount('1e-120', 'pL')).toMatchObject({
      kind: 'volume',
      quantity: { value: `0.${'0'.repeat(125)}1` },
    });
  });

  it('allows exact cancellation inside a bounded long mantissa', () => {
    expect(amount(`0.${'0'.repeat(2000)}1e2001`)).toMatchObject({
      kind: 'volume',
      quantity: { value: '1' },
    });
  });
});
