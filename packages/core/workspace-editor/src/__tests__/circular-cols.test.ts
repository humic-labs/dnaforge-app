import { describe, it, expect } from 'vitest';
import {
  biologicalColumn,
  effectiveEnd,
  rangeIntersectsViewport,
  isCrossCycleDrag,
} from '../utils/circular-cols';

describe('biologicalColumn', () => {
  it('passes columns already in [0, N) through unchanged', () => {
    expect(biologicalColumn(0, 100)).toBe(0);
    expect(biologicalColumn(50, 100)).toBe(50);
    expect(biologicalColumn(99, 100)).toBe(99);
  });

  it('wraps columns >= N by modulo', () => {
    expect(biologicalColumn(100, 100)).toBe(0);
    expect(biologicalColumn(150, 100)).toBe(50);
    expect(biologicalColumn(250, 100)).toBe(50);
    expect(biologicalColumn(200, 100)).toBe(0);
  });

  it('wraps negative columns up into [0, N) — not naive %', () => {
    expect(biologicalColumn(-1, 100)).toBe(99);
    expect(biologicalColumn(-50, 100)).toBe(50);
    expect(biologicalColumn(-100, 100)).toBe(0);
    expect(biologicalColumn(-101, 100)).toBe(99);
  });

  it('handles a sequence with columnCount=1', () => {
    expect(biologicalColumn(0, 1)).toBe(0);
    expect(biologicalColumn(7, 1)).toBe(0);
    expect(biologicalColumn(-3, 1)).toBe(0);
  });
});

describe('effectiveEnd', () => {
  it('returns end unchanged for linear sequences', () => {
    expect(effectiveEnd(100, 200, 1000, false)).toBe(200);
    expect(effectiveEnd(100, 50, 1000, false)).toBe(50);
  });

  it('returns end unchanged for circular non-spanning ranges', () => {
    expect(effectiveEnd(100, 200, 1000, true)).toBe(200);
    expect(effectiveEnd(0, 0, 1000, true)).toBe(0);
    expect(effectiveEnd(999, 999, 1000, true)).toBe(999);
  });

  it('shifts end by columnCount when circular range spans origin', () => {
    expect(effectiveEnd(3298, 677, 3412, true)).toBe(677 + 3412);
    expect(effectiveEnd(900, 100, 1000, true)).toBe(1100);
  });

  it('edge case: end === start - 1 (circular)', () => {
    expect(effectiveEnd(500, 499, 1000, true)).toBe(1499);
  });
});

describe('rangeIntersectsViewport', () => {
  it('linear: natural overlap', () => {
    expect(rangeIntersectsViewport(100, 200, 150, 250, 1000, false)).toBe(true);
    expect(rangeIntersectsViewport(0, 1000, 500, 600, 1000, false)).toBe(true);
  });

  it('linear: no overlap', () => {
    expect(rangeIntersectsViewport(100, 200, 300, 400, 1000, false)).toBe(false);
    expect(rangeIntersectsViewport(300, 400, 100, 200, 1000, false)).toBe(false);
  });

  it('linear: edge touching counts as overlap', () => {
    expect(rangeIntersectsViewport(100, 200, 200, 300, 1000, false)).toBe(true);
    expect(rangeIntersectsViewport(200, 300, 100, 200, 1000, false)).toBe(true);
  });

  it('circular: origin-spanning range in straddle viewport', () => {
    expect(rangeIntersectsViewport(900, 100, 950, 1050, 1000, true)).toBe(true);
  });

  it('circular: origin-spanning range not in non-straddle viewport', () => {
    expect(rangeIntersectsViewport(900, 100, 300, 400, 1000, true)).toBe(false);
  });

  it('circular: natural range in wrap-buffer viewport', () => {
    expect(rangeIntersectsViewport(10, 20, 1005, 1020, 1000, true)).toBe(true);
  });

  it('circular: natural range in negative-viewport (pre-origin wrap buffer)', () => {
    expect(rangeIntersectsViewport(990, 995, -20, -5, 1000, true)).toBe(true);
  });
});

describe('isCrossCycleDrag', () => {
  it('same cycle: both in [0, N)', () => {
    expect(isCrossCycleDrag(100, 500, 1000)).toBe(false);
    expect(isCrossCycleDrag(0, 999, 1000)).toBe(false);
  });

  it('same cycle: both negative', () => {
    expect(isCrossCycleDrag(-500, -100, 1000)).toBe(false);
  });

  it('crossed origin: anchor pre-origin, current post-origin', () => {
    expect(isCrossCycleDrag(950, 1050, 1000)).toBe(true);
  });

  it('crossed origin: anchor post-origin, current pre-origin (backward drag)', () => {
    expect(isCrossCycleDrag(50, -50, 1000)).toBe(true);
  });

  it('boundary: virtual col exactly equal to columnCount', () => {
    expect(isCrossCycleDrag(999, 1000, 1000)).toBe(true);
  });
});
