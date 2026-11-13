// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { generateSyntheticCcre } from './synth-ccre-generator';

const CHR11 = 135_086_622;

describe('generateSyntheticCcre', () => {
  it('returns an empty array for count=0', () => {
    expect(generateSyntheticCcre({ count: 0, chromLength: CHR11 })).toEqual([]);
  });

  it('throws on negative count', () => {
    expect(() => generateSyntheticCcre({ count: -1, chromLength: CHR11 })).toThrow(/count/);
  });

  it('throws on non-positive chromLength', () => {
    expect(() => generateSyntheticCcre({ count: 10, chromLength: 0 })).toThrow(/chromLength/);
  });

  it('throws on invalid width range', () => {
    expect(() =>
      generateSyntheticCcre({ count: 10, chromLength: CHR11, minWidthBp: 500, maxWidthBp: 100 })
    ).toThrow(/width/);
  });

  it('returns exactly count records', () => {
    expect(generateSyntheticCcre({ count: 1000, chromLength: CHR11 })).toHaveLength(1000);
  });

  it('is deterministic for the same seed', () => {
    const a = generateSyntheticCcre({ count: 100, chromLength: CHR11, seed: 7 });
    const b = generateSyntheticCcre({ count: 100, chromLength: CHR11, seed: 7 });
    expect(a).toHaveLength(100);
    expect(a).toEqual(b);
  });

  it('produces different records for different seeds', () => {
    const a = generateSyntheticCcre({ count: 100, chromLength: CHR11, seed: 1 });
    const b = generateSyntheticCcre({ count: 100, chromLength: CHR11, seed: 2 });
    const anyDiff = a.some((r, i) => r.start !== b[i].start);
    expect(anyDiff).toBe(true);
  });

  it('records are sorted by start', () => {
    const records = generateSyntheticCcre({ count: 10_000, chromLength: CHR11, seed: 3 });
    for (let i = 1; i < records.length; i++) {
      expect(records[i].start).toBeGreaterThanOrEqual(records[i - 1].start);
    }
  });

  it('records are within [0, chromLength]', () => {
    const records = generateSyntheticCcre({ count: 1000, chromLength: CHR11 });
    for (const r of records) {
      expect(r.start).toBeGreaterThanOrEqual(0);
      expect(r.end).toBeLessThanOrEqual(CHR11);
      expect(r.end).toBeGreaterThan(r.start);
    }
  });

  it('records have widths in [minWidthBp, maxWidthBp]', () => {
    const records = generateSyntheticCcre({
      count: 1000,
      chromLength: CHR11,
      minWidthBp: 150,
      maxWidthBp: 350,
    });
    for (const r of records) {
      const width = r.end - r.start;
      expect(width).toBeGreaterThanOrEqual(150);
      expect(width).toBeLessThanOrEqual(350);
    }
  });

  it('records carry one of the 5 cCRE class colors', () => {
    const palette = new Set([0xff0000, 0xffa500, 0xffff00, 0x0000ff, 0x00ff00]);
    const records = generateSyntheticCcre({ count: 100, chromLength: CHR11 });
    for (const r of records) {
      expect(palette.has(r.color ?? -1)).toBe(true);
    }
  });

  it('generates 1M records within ~500ms', () => {
    const t0 = performance.now();
    const records = generateSyntheticCcre({ count: 1_000_000, chromLength: CHR11 });
    const ms = performance.now() - t0;
    expect(records).toHaveLength(1_000_000);
    expect(ms).toBeLessThan(2000);
  });
});
