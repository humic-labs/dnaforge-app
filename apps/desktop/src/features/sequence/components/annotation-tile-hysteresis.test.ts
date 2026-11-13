// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { DEFAULT_HYSTERESIS_BP_PER_MS, decideHysteresis } from './annotation-tile-hysteresis';

describe('annotation-tile zoom hysteresis (Phase 3 Slice 2b)', () => {
  it('fires when there is no prior sample (first camera-change)', () => {
    const decision = decideHysteresis({
      previous: null,
      current: { visibleBp: 1_000_000, timestampMs: 0 },
    });
    expect(decision).toEqual({ kind: 'fire', reason: 'no-prior-sample' });
  });

  it('fires when zoom velocity is well below the budget', () => {
    const decision = decideHysteresis({
      previous: { visibleBp: 1_000_000, timestampMs: 0 },
      current: { visibleBp: 2_000_000, timestampMs: 100 },
    });
    expect(decision.kind).toBe('fire');
    if (decision.kind !== 'fire') throw new Error('narrowing');
    expect(decision.reason).toBe('below-threshold');
  });

  it('waits when zoom velocity exceeds the budget (rapid wheel-zoom)', () => {
    const decision = decideHysteresis({
      previous: { visibleBp: 1_000_000, timestampMs: 0 },
      current: { visibleBp: 101_000_000, timestampMs: 100 },
    });
    expect(decision.kind).toBe('wait');
    if (decision.kind !== 'wait') throw new Error('narrowing');
    expect(decision.velocityBpPerMs).toBe(1_000_000);
    expect(decision.maxBpPerMs).toBe(DEFAULT_HYSTERESIS_BP_PER_MS);
    expect(decision.reason).toBe('above-threshold');
  });

  it('is symmetric: zooming IN at high velocity also waits', () => {
    const decision = decideHysteresis({
      previous: { visibleBp: 101_000_000, timestampMs: 0 },
      current: { visibleBp: 1_000_000, timestampMs: 100 },
    });
    expect(decision.kind).toBe('wait');
  });

  it('uses the absolute value of the delta (no negative velocity)', () => {
    const fast = decideHysteresis({
      previous: { visibleBp: 50_000_000, timestampMs: 0 },
      current: { visibleBp: 0, timestampMs: 100 },
    });
    expect(fast.kind).toBe('wait');
    if (fast.kind !== 'wait') throw new Error('narrowing');
    expect(fast.velocityBpPerMs).toBeGreaterThan(0);
  });

  it('respects a custom maxBpPerMs threshold', () => {
    const aboveStrict = decideHysteresis({
      previous: { visibleBp: 0, timestampMs: 0 },
      current: { visibleBp: 10_000_000, timestampMs: 100 },
      maxBpPerMs: 50_000,
    });
    expect(aboveStrict.kind).toBe('wait');

    const belowLoose = decideHysteresis({
      previous: { visibleBp: 0, timestampMs: 0 },
      current: { visibleBp: 10_000_000, timestampMs: 100 },
      maxBpPerMs: 200_000,
    });
    expect(belowLoose.kind).toBe('fire');
  });

  it('disables hysteresis when maxBpPerMs is Infinity', () => {
    const decision = decideHysteresis({
      previous: { visibleBp: 0, timestampMs: 0 },
      current: { visibleBp: 100_000_000, timestampMs: 100 },
      maxBpPerMs: Number.POSITIVE_INFINITY,
    });
    expect(decision.kind).toBe('fire');
  });

  it('disables hysteresis when maxBpPerMs is 0 or negative (defensive)', () => {
    const zero = decideHysteresis({
      previous: { visibleBp: 0, timestampMs: 0 },
      current: { visibleBp: 1_000_000, timestampMs: 100 },
      maxBpPerMs: 0,
    });
    expect(zero.kind).toBe('fire');

    const negative = decideHysteresis({
      previous: { visibleBp: 0, timestampMs: 0 },
      current: { visibleBp: 1_000_000, timestampMs: 100 },
      maxBpPerMs: -5,
    });
    expect(negative.kind).toBe('fire');
  });

  it('falls through to firing on bogus timestamps (clock skew / replay)', () => {
    const sameTs = decideHysteresis({
      previous: { visibleBp: 0, timestampMs: 100 },
      current: { visibleBp: 1_000_000, timestampMs: 100 },
    });
    expect(sameTs.kind).toBe('fire');

    const backwards = decideHysteresis({
      previous: { visibleBp: 0, timestampMs: 100 },
      current: { visibleBp: 1_000_000, timestampMs: 50 },
    });
    expect(backwards.kind).toBe('fire');
  });

  it('budget edge case: velocity exactly equal to threshold fires (not waits)', () => {
    const decision = decideHysteresis({
      previous: { visibleBp: 0, timestampMs: 0 },
      current: { visibleBp: 5_000_000, timestampMs: 100 },
      maxBpPerMs: 50_000,
    });
    expect(decision.kind).toBe('fire');
  });
});
