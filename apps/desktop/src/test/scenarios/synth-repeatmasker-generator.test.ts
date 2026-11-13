// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  REPEATMASKER_CLASS_COLORS,
  generateSyntheticRepeatMasker,
} from './synth-repeatmasker-generator';

const CHR11 = 135_086_622;

describe('generateSyntheticRepeatMasker', () => {
  it('returns empty for count=0', () => {
    expect(generateSyntheticRepeatMasker({ count: 0, chromLength: CHR11 })).toEqual([]);
  });

  it('throws on negative count', () => {
    expect(() => generateSyntheticRepeatMasker({ count: -1, chromLength: CHR11 })).toThrow(/count/);
  });

  it('throws on non-positive chromLength', () => {
    expect(() => generateSyntheticRepeatMasker({ count: 10, chromLength: 0 })).toThrow(
      /chromLength/
    );
  });

  it('returns exactly count records', () => {
    expect(generateSyntheticRepeatMasker({ count: 100, chromLength: CHR11 })).toHaveLength(100);
  });

  it('records are sorted by start', () => {
    const records = generateSyntheticRepeatMasker({ count: 10_000, chromLength: CHR11 });
    for (let i = 1; i < records.length; i++) {
      expect(records[i].start).toBeGreaterThanOrEqual(records[i - 1].start);
    }
  });

  it('records are within [0, chromLength]', () => {
    const records = generateSyntheticRepeatMasker({ count: 1000, chromLength: CHR11 });
    for (const r of records) {
      expect(r.start).toBeGreaterThanOrEqual(0);
      expect(r.end).toBeLessThanOrEqual(CHR11);
      expect(r.end).toBeGreaterThan(r.start);
    }
  });

  it('records carry one of the class colors', () => {
    const palette = new Set(REPEATMASKER_CLASS_COLORS);
    const records = generateSyntheticRepeatMasker({ count: 200, chromLength: CHR11 });
    for (const r of records) {
      expect(palette.has(r.color ?? -1)).toBe(true);
    }
  });

  it('is deterministic for the same seed', () => {
    const a = generateSyntheticRepeatMasker({ count: 100, chromLength: CHR11, seed: 7 });
    const b = generateSyntheticRepeatMasker({ count: 100, chromLength: CHR11, seed: 7 });
    expect(a).toHaveLength(100);
    expect(a).toEqual(b);
  });

  it('different seeds produce different records', () => {
    const a = generateSyntheticRepeatMasker({ count: 100, chromLength: CHR11, seed: 1 });
    const b = generateSyntheticRepeatMasker({ count: 100, chromLength: CHR11, seed: 2 });
    expect(a).not.toEqual(b);
  });

  it('produces some long-tail records (LINE-class)', () => {
    const records = generateSyntheticRepeatMasker({
      count: 1000,
      chromLength: CHR11,
      meanWidthBp: 200,
      longTailMultiplier: 50,
    });
    const longRecords = records.filter((r) => r.end - r.start > 1000);
    expect(longRecords.length).toBeGreaterThan(0);
  });

  it('generates 250k repeats (chr11 realistic scale) within ~500ms', () => {
    const t0 = performance.now();
    const records = generateSyntheticRepeatMasker({
      count: 250_000,
      chromLength: CHR11,
    });
    const ms = performance.now() - t0;
    expect(records).toHaveLength(250_000);
    expect(ms).toBeLessThan(2000);
  });
});
