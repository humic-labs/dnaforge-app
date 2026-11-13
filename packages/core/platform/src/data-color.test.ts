import { describe, expect, it } from 'vitest';
import { compileDataColors, dataColor } from './data-color';

describe('data color mapping', () => {
  it('maps arbitrary producer objects and target shapes without rewriting the input', () => {
    const records = Object.freeze([
      Object.freeze({ observation: { values: new Float64Array([2, 8]) }, sample: 'first' }),
      Object.freeze({ observation: { values: new Float64Array([8, 2]) }, sample: 'second' }),
    ]);
    const targets = [
      { inputIndex: 0, target: { owner: 'sequence-one', identity: 'feature-7' } },
      { inputIndex: 1, target: { owner: 'sequence-two', identity: 'feature-7' } },
      { inputIndex: 0, target: { owner: 'track-three', identity: 'interval-2' } },
    ];
    const before = structuredClone(records);
    const result = compileDataColors({
      records,
      bindings: targets,
      targetKey: (target) => JSON.stringify([target.owner, target.identity]),
      color: ({ observation }) =>
        dataColor(observation.values[1] / observation.values[0], {
          kind: 'continuous',
          domain: [0, 5],
          colors: ['#000000', '#ffffff'],
          missingColor: '#999999',
          transform: 'linear',
        }),
    });
    expect(result.map(({ color }) => color)).toEqual(['#cccccc', '#0d0d0d', '#cccccc']);
    expect(result[0].target).toBe(targets[0].target);
    expect(result.map(({ inputIndex }) => inputIndex)).toEqual([0, 1, 0]);
    expect(records).toEqual(before);
  });

  it('accepts caller-defined mappings over non-scalar inputs', () => {
    const records = [new Set(['selected', 'verified']), new Set(['selected'])];
    expect(
      compileDataColors({
        records,
        bindings: [
          { inputIndex: 0, target: 'target-a' },
          { inputIndex: 1, target: 'target-b' },
        ],
        targetKey: (target) => target,
        color: (flags) => (flags.has('verified') ? '#123456' : '#abcdef'),
      }).map(({ color }) => color)
    ).toEqual(['#123456', '#abcdef']);
  });

  it('filters observations explicitly and rejects conflicting target bindings', () => {
    const options = {
      records: [{ replicate: 'a' }, { replicate: 'b' }],
      bindings: [
        { inputIndex: 0, target: 7 },
        { inputIndex: 1, target: 7 },
      ],
      targetKey: (target: number) => target,
      color: () => '#123456',
    };
    expect(() => compileDataColors(options)).toThrow(/multiple observations/i);
    expect(compileDataColors({ ...options, filter: (record) => record.replicate === 'b' })).toEqual(
      [{ inputIndex: 1, target: 7, color: '#123456' }]
    );
  });

  it('rejects invalid bindings and colors without returning a partial layer', () => {
    const options = {
      records: [{}],
      bindings: [{ inputIndex: 0, target: 'one' }],
      targetKey: (target: string) => target,
      color: () => '#123456',
    };
    for (const inputIndex of [-1, 1, 0.5, NaN]) {
      expect(() =>
        compileDataColors({ ...options, bindings: [{ inputIndex, target: 'one' }] })
      ).toThrow(/outside the supplied data/i);
    }
    expect(() => compileDataColors({ ...options, color: () => 'unmapped' })).toThrow(/hex/i);
  });

  it('keeps missing values, false and zero distinct and looks up categories safely', () => {
    const scale = {
      kind: 'categorical' as const,
      colors: { false: '#112233', 0: '#445566' },
      missingColor: '#999999',
    };
    expect(dataColor(false, scale)).toBe('#112233');
    expect(dataColor(0, scale)).toBe('#445566');
    for (const value of [null, undefined, '', 'toString', 'not-supplied']) {
      expect(dataColor(value, scale)).toBe('#999999');
    }
  });

  it('retains numeric scale interpolation and log10 behavior', () => {
    const scale = {
      kind: 'continuous' as const,
      domain: [1, 100],
      colors: ['#000000', '#ffffff'],
      missingColor: '#999999',
      transform: 'log10' as const,
    };
    expect(dataColor(10, scale)).toBe('#808080');
    expect(dataColor('10', scale)).toBe('#808080');
    expect(dataColor(null, scale)).toBe('#999999');
    expect(() => dataColor(0, scale)).toThrow(/log10/i);
    expect(() => dataColor(false, scale)).toThrow(/nonnumeric/i);
  });

  it('renders quantized scales consistently for numeric and imported text values', () => {
    const scale = {
      kind: 'continuous' as const,
      domain: [0, 1],
      colors: ['#000000', '#ffffff'],
      missingColor: '#999999',
      transform: 'linear' as const,
      quantization: 2,
    };
    expect(dataColor(0.3, scale)).toBe('#808080');
    expect(dataColor('0.3', scale)).toBe('#808080');
    expect(dataColor(0, scale)).toBe('#000000');
    expect(dataColor(1, scale)).toBe('#ffffff');
    expect(() => dataColor(0.3, { ...scale, quantization: 0 })).toThrow(/color steps/i);
  });
});
