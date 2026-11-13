// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { CHIPSEQ_DEFAULT_COLOR, generateSyntheticChipSeq } from './synth-chipseq-generator';

const CHR11 = 135_086_622;

describe('generateSyntheticChipSeq', () => {
  it('returns empty for count=0', () => {
    expect(generateSyntheticChipSeq({ count: 0, chromLength: CHR11 })).toEqual([]);
  });

  it('throws on negative count', () => {
    expect(() => generateSyntheticChipSeq({ count: -1, chromLength: CHR11 })).toThrow(/count/);
  });

  it('throws on non-positive chromLength', () => {
    expect(() => generateSyntheticChipSeq({ count: 10, chromLength: 0 })).toThrow(/chromLength/);
  });

  it('returns exactly count records', () => {
    expect(generateSyntheticChipSeq({ count: 100, chromLength: CHR11 })).toHaveLength(100);
  });

  it('records are sorted by start', () => {
    const records = generateSyntheticChipSeq({ count: 3000, chromLength: CHR11 });
    for (let i = 1; i < records.length; i++) {
      expect(records[i].start).toBeGreaterThanOrEqual(records[i - 1].start);
    }
  });

  it('records use the default color', () => {
    const records = generateSyntheticChipSeq({ count: 100, chromLength: CHR11 });
    for (const r of records) {
      expect(r.color).toBe(CHIPSEQ_DEFAULT_COLOR);
    }
  });

  it('respects a custom color', () => {
    const records = generateSyntheticChipSeq({
      count: 100,
      chromLength: CHR11,
      color: 0x123456,
    });
    expect(records.every((r) => r.color === 0x123456)).toBe(true);
  });

  it('is deterministic for the same seed', () => {
    const a = generateSyntheticChipSeq({ count: 100, chromLength: CHR11, seed: 7 });
    const b = generateSyntheticChipSeq({ count: 100, chromLength: CHR11, seed: 7 });
    expect(a).toHaveLength(100);
    expect(a).toEqual(b);
  });

  it('different seeds produce different records', () => {
    const a = generateSyntheticChipSeq({ count: 100, chromLength: CHR11, seed: 1 });
    const b = generateSyntheticChipSeq({ count: 100, chromLength: CHR11, seed: 2 });
    expect(a).not.toEqual(b);
  });

  it('peaks cluster (some genomic regions have many; others have few)', () => {
    const records = generateSyntheticChipSeq({ count: 3000, chromLength: CHR11 });
    const bins = new Array(100).fill(0);
    for (const r of records) {
      bins[Math.min(99, Math.floor(r.start / (CHR11 / 100)))]++;
    }
    const mean = records.length / 100;
    const variance = bins.reduce((s, n) => s + (n - mean) ** 2, 0) / 100;
    const stdDev = Math.sqrt(variance);
    expect(stdDev).toBeGreaterThan(5);
  });

  it('generates 3k peaks (chr11 realistic scale) within ~50ms', () => {
    const t0 = performance.now();
    const records = generateSyntheticChipSeq({ count: 3000, chromLength: CHR11 });
    const ms = performance.now() - t0;
    expect(records).toHaveLength(3000);
    expect(ms).toBeLessThan(500);
  });
});
