// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { buildColumnGridMapping } from './interpolation';

describe('buildColumnGridMapping', () => {
  it('maps every called peak center exactly to its sample at frac=0.5', () => {
    const mapping = buildColumnGridMapping([10, 20, 30], [0, 1, 2], 3);
    expect(mapping.sampleAtColumnX(0, 0.5)).toBe(10);
    expect(mapping.sampleAtColumnX(1, 0.5)).toBe(20);
    expect(mapping.sampleAtColumnX(2, 0.5)).toBe(30);
  });

  it('linearly interpolates between consecutive peaks', () => {
    const mapping = buildColumnGridMapping([10, 20], [0, 1], 2);
    expect(mapping.sampleAtColumnX(0, 0.75)).toBeCloseTo(12.5);
    expect(mapping.sampleAtColumnX(1, 0.0)).toBeCloseTo(15);
  });

  it('is continuous across column boundaries (right edge of c == left edge of c+1)', () => {
    const mapping = buildColumnGridMapping([10, 20, 30], [0, 1, 2], 3);
    expect(mapping.sampleAtColumnX(0, 1.0)).toBeCloseTo(15);
    expect(mapping.sampleAtColumnX(1, 0.0)).toBeCloseTo(15);
    expect(mapping.sampleAtColumnX(1, 1.0)).toBeCloseTo(25);
    expect(mapping.sampleAtColumnX(2, 0.0)).toBeCloseTo(25);
  });

  it('returns null for columns outside the read footprint', () => {
    const mapping = buildColumnGridMapping([10, 20], [2, 3], 6);
    expect(mapping.sampleAtColumnX(0, 0.5)).toBeNull();
    expect(mapping.sampleAtColumnX(1, 0.5)).toBeNull();
    expect(mapping.sampleAtColumnX(4, 0.5)).toBeNull();
    expect(mapping.sampleAtColumnX(5, 0.5)).toBeNull();
  });

  it('returns null for gap columns inside the read footprint', () => {
    const mapping = buildColumnGridMapping([10, 30], [0, 3], 4);
    expect(mapping.sampleAtColumnX(0, 0.5)).toBe(10);
    expect(mapping.sampleAtColumnX(1, 0.5)).toBeNull();
    expect(mapping.sampleAtColumnX(2, 0.5)).toBeNull();
    expect(mapping.sampleAtColumnX(3, 0.5)).toBe(30);
  });

  it('clamps frac<0.5 at the first peak (no extrapolation off the left edge)', () => {
    const mapping = buildColumnGridMapping([10, 20], [0, 1], 2);
    expect(mapping.sampleAtColumnX(0, 0.0)).toBe(10);
    expect(mapping.sampleAtColumnX(0, 0.25)).toBe(10);
  });

  it('clamps frac>0.5 at the last peak (no extrapolation off the right edge)', () => {
    const mapping = buildColumnGridMapping([10, 20], [0, 1], 2);
    expect(mapping.sampleAtColumnX(1, 0.75)).toBe(20);
    expect(mapping.sampleAtColumnX(1, 1.0)).toBe(20);
  });

  it('returns null for invalid inputs (NaN, out-of-range column)', () => {
    const mapping = buildColumnGridMapping([10, 20], [0, 1], 2);
    expect(mapping.sampleAtColumnX(-1, 0.5)).toBeNull();
    expect(mapping.sampleAtColumnX(2, 0.5)).toBeNull();
    expect(mapping.sampleAtColumnX(0, NaN)).toBeNull();
    expect(mapping.sampleAtColumnX(NaN, 0.5)).toBeNull();
  });

  it('handles an empty read (returns null for every column)', () => {
    const mapping = buildColumnGridMapping([], [], 5);
    expect(mapping.sampleAtColumnX(0, 0.5)).toBeNull();
    expect(mapping.sampleAtColumnX(4, 0.5)).toBeNull();
  });

  it('rejects mismatched array lengths', () => {
    expect(() => buildColumnGridMapping([10, 20], [0], 2)).toThrow(/same length/);
  });

  it('rejects non-monotonic baseToColumn', () => {
    expect(() => buildColumnGridMapping([10, 20, 30], [0, 2, 1], 3)).toThrow(/non-decreasing/);
  });

  it('rejects negative or non-finite totalColumns', () => {
    expect(() => buildColumnGridMapping([], [], -1)).toThrow();
    expect(() => buildColumnGridMapping([], [], NaN)).toThrow();
  });

  it('preserves out-of-phase signal: lookup is strictly monotonic between peaks (no snap)', () => {
    const mapping = buildColumnGridMapping([10, 20, 30], [0, 1, 2], 3);

    const samples: number[] = [];
    for (let f = 0.5; f <= 1.0 + 1e-9; f += 0.1) {
      const s = mapping.sampleAtColumnX(0, f);
      expect(s).not.toBeNull();
      samples.push(s as number);
    }
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeGreaterThan(samples[i - 1]);
    }
    expect(samples[0]).toBe(10);
    expect(samples[samples.length - 1]).toBeCloseTo(15);
  });

  it('handles non-uniform peak spacing (real Sanger data is not evenly spaced)', () => {
    const mapping = buildColumnGridMapping([5, 30, 35], [0, 1, 2], 3);
    expect(mapping.sampleAtColumnX(0, 0.5)).toBe(5);
    expect(mapping.sampleAtColumnX(0, 1.0)).toBeCloseTo(17.5);
    expect(mapping.sampleAtColumnX(1, 0.5)).toBe(30);
    expect(mapping.sampleAtColumnX(1, 1.0)).toBeCloseTo(32.5);
  });
});
