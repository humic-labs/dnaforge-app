import { describe, expect, it } from 'vitest';
import {
  inventoryConcentrationFor,
  mixInventoryCompositions,
  normalizeInventoryConcentration,
  validateInventoryConcentration,
  type InventoryComposition,
  type InventoryConcentration,
  type InventoryConcentrationUnit,
} from './inventory-concentration';

const measured = (
  value: string,
  unit: InventoryConcentrationUnit = 'ng/uL'
): InventoryComposition => ({
  kind: 'homogeneous',
  analytes: { dna: normalizeInventoryConcentration({ value, unit }) },
});
const contribution = (composition: InventoryComposition, value = '1') => ({
  composition,
  quantity: { value, unit: 'uL' as const },
});

describe('exact concentration facts', () => {
  it('normalizes compatible mass and molar units without crossing dimensions', () => {
    expect(normalizeInventoryConcentration({ value: '1', unit: 'mg/mL' })).toEqual({
      kind: 'known',
      unit: 'ng/uL',
      numerator: '1000',
      denominator: '1',
    });
    expect(normalizeInventoryConcentration({ value: '1', unit: 'ug/mL' })).toEqual(
      normalizeInventoryConcentration({ value: '1', unit: 'ng/uL' })
    );
    expect(normalizeInventoryConcentration({ value: '1', unit: 'uM' })).toEqual({
      kind: 'known',
      unit: 'nmol/uL',
      numerator: '1',
      denominator: '1000',
    });
    expect(normalizeInventoryConcentration({ value: '1000', unit: 'nM' })).toEqual(
      normalizeInventoryConcentration({ value: '1', unit: 'uM' })
    );
  });

  it('retains one-third exactly after dilution with explicitly measured zero analyte', () => {
    const result = mixInventoryCompositions(
      [contribution(measured('1')), contribution(measured('0'), '2')],
      'homogeneous'
    );
    expect(inventoryConcentrationFor(result, 'dna')).toEqual({
      kind: 'known',
      unit: 'ng/uL',
      numerator: '1',
      denominator: '3',
    });
  });

  it('does not assume an unmeasured diluent contains zero analyte', () => {
    const result = mixInventoryCompositions(
      [contribution(measured('1')), contribution({ kind: 'homogeneous', analytes: {} }, '2')],
      'homogeneous'
    );
    expect(inventoryConcentrationFor(result, 'dna')).toEqual({
      kind: 'unknown',
      reason: 'missing-input',
    });
  });

  it('requires explicit output homogeneity and retains unknown source composition', () => {
    expect(
      mixInventoryCompositions(
        [contribution(measured('1')), contribution(measured('0'))],
        'unknown'
      )
    ).toEqual({ kind: 'unknown' });
    expect(
      mixInventoryCompositions(
        [contribution(measured('1')), contribution({ kind: 'unknown' })],
        'homogeneous'
      )
    ).toEqual({ kind: 'unknown' });
  });

  it('rejects missing or unsupported output mixing states', () => {
    for (const outputMixing of [undefined, null, '', 'mixed'])
      expect(() =>
        mixInventoryCompositions(
          [contribution(measured('1')), contribution(measured('0'))],
          outputMixing as 'homogeneous'
        )
      ).toThrow();
  });

  it('rejects unsupported saved knowledge states and unknown reasons', () => {
    for (const value of [
      { kind: 'unknown', reason: 'assumed' },
      { kind: 'unknown' },
      { kind: 'estimated', unit: 'ng/uL', numerator: '1', denominator: '1' },
    ])
      expect(() => validateInventoryConcentration(value as InventoryConcentration)).toThrow();
  });

  it('rejects unsupported input composition states', () => {
    const invalid = { kind: 'estimated', analytes: {} } as unknown as InventoryComposition;
    expect(() =>
      mixInventoryCompositions([contribution(invalid), contribution(invalid)], 'homogeneous')
    ).toThrow();
  });

  it('does not convert between molar and mass units without molecular weight', () => {
    const result = mixInventoryCompositions(
      [contribution(measured('1')), contribution(measured('1', 'uM'))],
      'homogeneous'
    );
    expect(inventoryConcentrationFor(result, 'dna')).toEqual({
      kind: 'unknown',
      reason: 'incompatible-units',
    });
  });

  it('weights exact compatible concentrations using mixed input volume units', () => {
    const result = mixInventoryCompositions(
      [
        contribution(measured('2'), '1'),
        { composition: measured('8'), quantity: { value: '0.003', unit: 'mL' } },
      ],
      'homogeneous'
    );
    expect(inventoryConcentrationFor(result, 'dna')).toEqual({
      kind: 'known',
      unit: 'ng/uL',
      numerator: '13',
      denominator: '2',
    });
  });

  it('retains a supported concentration when equal large-volume inputs are mixed', () => {
    const value = '9'.repeat(128);
    const source = measured(value);
    const result = mixInventoryCompositions(
      [contribution(source, value), contribution(source, value)],
      'homogeneous'
    );
    expect(inventoryConcentrationFor(result, 'dna')).toEqual(
      inventoryConcentrationFor(source, 'dna')
    );
  });

  it('cancels an oversized exact volume total before bounding the final concentration', () => {
    const source = measured('1');
    const inputs = [
      ...Array.from({ length: 255 }, () => contribution(source, '9'.repeat(128))),
      contribution(source, `0.${'0'.repeat(125)}1`),
    ];
    expect(
      inventoryConcentrationFor(mixInventoryCompositions(inputs, 'homogeneous'), 'dna')
    ).toEqual(inventoryConcentrationFor(source, 'dna'));
  });

  it('does not make exact mixture support depend on contribution order', () => {
    const p = 10n ** 255n + 1n;
    const q = p + 2n;
    const source = (numerator: bigint, denominator: bigint): InventoryComposition => ({
      kind: 'homogeneous',
      analytes: {
        dna: {
          kind: 'known',
          unit: 'ng/uL',
          numerator: numerator.toString(),
          denominator: denominator.toString(),
        },
      },
    });
    const a = contribution(source(1n, p));
    const b = contribution(source(1n, q));
    const complementA = contribution(source(p - 1n, p));
    const complementB = contribution(source(q - 1n, q));
    const expected = {
      kind: 'known',
      unit: 'ng/uL',
      numerator: '1',
      denominator: '2',
    };
    for (const inputs of [
      [a, b, complementA, complementB],
      [a, complementA, b, complementB],
    ])
      expect(
        inventoryConcentrationFor(mixInventoryCompositions(inputs, 'homogeneous'), 'dna')
      ).toEqual(expected);
  });

  it('rejects a final concentration whose reduced ratio exceeds the supported range', () => {
    const p = 10n ** 255n + 1n;
    const q = p + 2n;
    const inputs = [p, q].map((denominator) =>
      contribution({
        kind: 'homogeneous',
        analytes: {
          dna: {
            kind: 'known',
            unit: 'ng/uL',
            numerator: '1',
            denominator: denominator.toString(),
          },
        },
      })
    );
    expect(() => mixInventoryCompositions(inputs, 'homogeneous')).toThrow();
  });

  it('rejects noncanonical saved ratios, zero denominators and unsupported decimal forms', () => {
    for (const [numerator, denominator] of [
      ['2', '4'],
      ['1', '0'],
      ['-1', '1'],
      ['01', '1'],
      ['9'.repeat(257), '1'],
    ])
      expect(() =>
        validateInventoryConcentration({ kind: 'known', unit: 'ng/uL', numerator, denominator })
      ).toThrow();
    for (const value of ['-1', '1e3', '', 'NaN'])
      expect(() => normalizeInventoryConcentration({ value, unit: 'ng/uL' })).toThrow();
  });
});
