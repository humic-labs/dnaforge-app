import { describe, expect, it } from 'vitest';
import {
  MIN_RULER_TICK_SPACING_PX,
  computeTickStep,
  enumerateCircularRulerTickBps,
  generateTickPositions,
} from './ruler-utils';

describe('ruler utils', () => {
  it('never returns tick spacing below ten bases', () => {
    expect(computeTickStep(20)).toBe(10);
    expect(computeTickStep(2)).toBe(10);
    expect(computeTickStep(0.25)).toBe(10);
  });

  it('spaces ticks far enough apart for their labels on a narrow ruler', () => {
    const span = 2_000;
    expect(computeTickStep(span, 2_000)).toBe(100);
    for (const widthPx of [1_200, 900, 600, 300, 150]) {
      const step = computeTickStep(span, widthPx);
      expect((step / span) * widthPx).toBeGreaterThanOrEqual(MIN_RULER_TICK_SPACING_PX);
    }
    expect(computeTickStep(span, 600)).toBeGreaterThan(computeTickStep(span, 1_200));
  });

  it('generates ten-base ticks at nucleotide zoom', () => {
    expect(generateTickPositions(10.2, 33.8, computeTickStep(23.6))).toEqual([20, 30]);
  });
});

describe('enumerateCircularRulerTickBps  ① — ruler origin re-index)', () => {
  const GEN_LEN = 4_641_652;
  const STEP = 500_000;

  it('only emits absolute multiples of step (phase-stable labels everywhere)', () => {
    for (const centerBp of [0, 100_000, 2_000_000, 4_600_000, GEN_LEN - 1, GEN_LEN + 50_000]) {
      const ticks = enumerateCircularRulerTickBps(centerBp, 2_000_000, GEN_LEN, STEP, true);
      for (const bp of ticks) {
        expect(bp % STEP).toBe(0);
        expect(bp).toBeGreaterThanOrEqual(0);
        expect(bp).toBeLessThan(GEN_LEN);
      }
    }
  });

  it('labels the post-origin half from the absolute origin base, not raw % genLen', () => {
    const ticks = enumerateCircularRulerTickBps(GEN_LEN - 1_000, 2_000_000, GEN_LEN, STEP, true);

    expect(ticks).toContain(0);
    expect(ticks).toContain(500_000);
    const preFixDrift = ((5_000_000 % GEN_LEN) + GEN_LEN) % GEN_LEN;
    expect(preFixDrift % STEP).not.toBe(0);
    expect(ticks).not.toContain(preFixDrift);
    expect(ticks).not.toContain(((5_500_000 % GEN_LEN) + GEN_LEN) % GEN_LEN);
  });

  it('emits every step exactly once when the whole genome is visible', () => {
    const ticks = enumerateCircularRulerTickBps(GEN_LEN / 2, GEN_LEN, GEN_LEN, STEP, true);
    const expected = generateTickPositions(0, GEN_LEN - 1, STEP);
    expect(ticks).toEqual(expected);
    expect(ticks).not.toContain(GEN_LEN);
    expect(new Set(ticks).size).toBe(ticks.length);
  });

  it('does not wrap for linear (non-circular) genomes — clamps to [0, genLen]', () => {
    const ticks = enumerateCircularRulerTickBps(50_000, 400_000, 1_000_000, 100_000, false);
    for (const bp of ticks) {
      expect(bp % 100_000).toBe(0);
      expect(bp).toBeGreaterThanOrEqual(0);
      expect(bp).toBeLessThan(1_000_000);
    }
    expect(ticks).toContain(0);
    expect(ticks).toContain(100_000);
    expect(ticks).toContain(200_000);
  });

  it('returns nothing for degenerate inputs', () => {
    expect(enumerateCircularRulerTickBps(0, 0, GEN_LEN, STEP, true)).toEqual([]);
    expect(enumerateCircularRulerTickBps(0, 1000, 0, STEP, true)).toEqual([]);
    expect(enumerateCircularRulerTickBps(0, 1000, GEN_LEN, 0, true)).toEqual([]);
  });
});
