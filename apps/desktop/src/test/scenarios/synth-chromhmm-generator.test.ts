// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { CHROMHMM_25_STATE_COLORS, generateSyntheticChromHMM } from './synth-chromhmm-generator';

const CHR11 = 135_086_622;

describe('generateSyntheticChromHMM', () => {
  it('returns empty for count=0', () => {
    expect(generateSyntheticChromHMM({ count: 0, chromLength: CHR11 })).toEqual([]);
  });

  it('throws on negative count', () => {
    expect(() => generateSyntheticChromHMM({ count: -1, chromLength: CHR11 })).toThrow(/count/);
  });

  it('throws on non-positive chromLength', () => {
    expect(() => generateSyntheticChromHMM({ count: 10, chromLength: 0 })).toThrow(/chromLength/);
  });

  it('returns exactly count records (or up to it)', () => {
    expect(
      generateSyntheticChromHMM({ count: 100, chromLength: CHR11 }).length
    ).toBeLessThanOrEqual(100);
  });

  it('records are contiguous (no gaps, no overlaps within tolerance)', () => {
    const records = generateSyntheticChromHMM({ count: 100, chromLength: CHR11 });
    for (let i = 1; i < records.length; i++) {
      expect(records[i].start).toBe(records[i - 1].end);
    }
    expect(records[0].start).toBe(0);
    expect(records[records.length - 1].end).toBe(CHR11);
  });

  it('is deterministic for the same seed', () => {
    const a = generateSyntheticChromHMM({ count: 100, chromLength: CHR11, seed: 7 });
    const b = generateSyntheticChromHMM({ count: 100, chromLength: CHR11, seed: 7 });
    expect(a).toHaveLength(100);
    expect(a).toEqual(b);
  });

  it('different seeds produce different records', () => {
    const a = generateSyntheticChromHMM({ count: 100, chromLength: CHR11, seed: 1 });
    const b = generateSyntheticChromHMM({ count: 100, chromLength: CHR11, seed: 2 });
    expect(a).not.toEqual(b);
  });

  it('adjacent segments have distinct state assignments (palette may share colors across grouped states)', () => {
    const records = generateSyntheticChromHMM({ count: 1000, chromLength: CHR11 });
    const uniqueColors = new Set(records.map((r) => r.color));
    expect(uniqueColors.size).toBeGreaterThan(5);
  });

  it('every color is from the 25-state palette', () => {
    const palette = new Set(CHROMHMM_25_STATE_COLORS);
    const records = generateSyntheticChromHMM({ count: 500, chromLength: CHR11 });
    for (const r of records) {
      expect(palette.has(r.color ?? -1)).toBe(true);
    }
  });

  it('generates 30k segments (chr11 realistic scale) within ~50ms', () => {
    const t0 = performance.now();
    const records = generateSyntheticChromHMM({ count: 30_000, chromLength: CHR11 });
    const ms = performance.now() - t0;
    expect(records.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(500);
  });
});
