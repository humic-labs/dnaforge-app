import { describe, expect, it } from 'vitest';

import { acenChevronSide, bpToChromosomeScaleX, chromosomeScaleXToBp } from './cytoband-coords';

describe('bpToChromosomeScaleX', () => {
  const CHR11_LENGTH = 135_086_622;
  const STRIP_WIDTH = 800;

  it('maps bp 0 to x 0', () => {
    expect(bpToChromosomeScaleX(0, CHR11_LENGTH, STRIP_WIDTH)).toBe(0);
  });

  it('maps full chromosome length to viewport width', () => {
    expect(bpToChromosomeScaleX(CHR11_LENGTH, CHR11_LENGTH, STRIP_WIDTH)).toBe(STRIP_WIDTH);
  });

  it('maps midpoint to half width', () => {
    const halfWidth = STRIP_WIDTH / 2;
    expect(bpToChromosomeScaleX(CHR11_LENGTH / 2, CHR11_LENGTH, STRIP_WIDTH)).toBeCloseTo(
      halfWidth,
      6
    );
  });

  it('is linear in bp', () => {
    const a = bpToChromosomeScaleX(10_000_000, CHR11_LENGTH, STRIP_WIDTH);
    const b = bpToChromosomeScaleX(20_000_000, CHR11_LENGTH, STRIP_WIDTH);
    const c = bpToChromosomeScaleX(30_000_000, CHR11_LENGTH, STRIP_WIDTH);
    expect(b - a).toBeCloseTo(c - b, 6);
  });

  it('scales with viewport width', () => {
    const at800 = bpToChromosomeScaleX(50_000_000, CHR11_LENGTH, 800);
    const at1600 = bpToChromosomeScaleX(50_000_000, CHR11_LENGTH, 1600);
    expect(at1600).toBeCloseTo(at800 * 2, 6);
  });

  it('handles values beyond chromosome length without clamping (caller responsibility)', () => {
    const overshoot = bpToChromosomeScaleX(CHR11_LENGTH * 1.5, CHR11_LENGTH, STRIP_WIDTH);
    expect(overshoot).toBeCloseTo(STRIP_WIDTH * 1.5, 6);
  });
});

describe('chromosomeScaleXToBp (inverse of bpToChromosomeScaleX)', () => {
  const CHR11_LENGTH = 135_086_622;
  const STRIP_WIDTH = 800;

  it('maps x 0 to bp 0', () => {
    expect(chromosomeScaleXToBp(0, CHR11_LENGTH, STRIP_WIDTH)).toBe(0);
  });

  it('maps x widthPx to chromosome length', () => {
    expect(chromosomeScaleXToBp(STRIP_WIDTH, CHR11_LENGTH, STRIP_WIDTH)).toBe(CHR11_LENGTH);
  });

  it('roundtrips with bpToChromosomeScaleX', () => {
    const bp = 51_300_000;
    const x = bpToChromosomeScaleX(bp, CHR11_LENGTH, STRIP_WIDTH);
    expect(chromosomeScaleXToBp(x, CHR11_LENGTH, STRIP_WIDTH)).toBeCloseTo(bp, 0);
  });

  it('returns 0 safely when widthPx is 0 (defensive)', () => {
    expect(chromosomeScaleXToBp(123, CHR11_LENGTH, 0)).toBe(0);
  });
});

describe('acenChevronSide (centromere notched chevron direction)', () => {
  const CHR11_PREFIX = [
    { stain: 'gpos50' },
    { stain: 'acen' },
    { stain: 'acen' },
    { stain: 'gneg' },
  ];

  it('returns "left" for the first acen in a run (prev is non-acen)', () => {
    expect(acenChevronSide(CHR11_PREFIX, 1)).toBe('left');
  });

  it('returns "right" for the second acen in a run (prev is acen)', () => {
    expect(acenChevronSide(CHR11_PREFIX, 2)).toBe('right');
  });

  it('returns "left" when there is no previous band (acen at index 0)', () => {
    const bandsStartingWithAcen = [{ stain: 'acen' }, { stain: 'acen' }];
    expect(acenChevronSide(bandsStartingWithAcen, 0)).toBe('left');
    expect(acenChevronSide(bandsStartingWithAcen, 1)).toBe('right');
  });

  it('handles a 3-band acen run by chaining left, right, right', () => {
    const threeAcen = [
      { stain: 'gpos75' },
      { stain: 'acen' },
      { stain: 'acen' },
      { stain: 'acen' },
      { stain: 'gneg' },
    ];
    expect(acenChevronSide(threeAcen, 1)).toBe('left');
    expect(acenChevronSide(threeAcen, 2)).toBe('right');
    expect(acenChevronSide(threeAcen, 3)).toBe('right');
  });
});
