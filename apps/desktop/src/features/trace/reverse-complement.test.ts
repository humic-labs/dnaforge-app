// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { reverseComplementTrace } from './reverse-complement';
import type { TraceData } from './types';

function fixture(): TraceData {
  return {
    channels: {
      A: [10, 100, 10, 0, 0, 0],
      C: [0, 0, 0, 10, 100, 10],
      G: [10, 10, 100, 0, 0, 0],
      T: [0, 0, 0, 100, 10, 10],
    },
    peakPositions: [1, 2, 4],
    baseOrder: 'GATC',
    maxValue: 100,
  };
}

describe('reverseComplementTrace', () => {
  it('swaps A↔T and C↔G channels and reverses each sample stream', () => {
    const t = fixture();
    const rc = reverseComplementTrace(t);
    expect(rc.channels.T).toEqual([...t.channels.A].reverse());
    expect(rc.channels.A).toEqual([...t.channels.T].reverse());
    expect(rc.channels.G).toEqual([...t.channels.C].reverse());
    expect(rc.channels.C).toEqual([...t.channels.G].reverse());
  });

  it('mirrors and reverses peak positions', () => {
    expect(reverseComplementTrace(fixture()).peakPositions).toEqual([1, 3, 4]);
  });

  it('complements baseOrder character-wise', () => {
    expect(reverseComplementTrace(fixture()).baseOrder).toBe('CTAG');
    expect(reverseComplementTrace({ ...fixture(), baseOrder: 'ACGT' }).baseOrder).toBe('TGCA');
  });

  it('preserves maxValue', () => {
    expect(reverseComplementTrace(fixture()).maxValue).toBe(100);
  });

  it('round-trips: RC(RC(t)) is structurally equal to t', () => {
    const t = fixture();
    const back = reverseComplementTrace(reverseComplementTrace(t));
    expect(back.channels.A).toEqual(t.channels.A);
    expect(back.channels.C).toEqual(t.channels.C);
    expect(back.channels.G).toEqual(t.channels.G);
    expect(back.channels.T).toEqual(t.channels.T);
    expect(back.peakPositions).toEqual(t.peakPositions);
    expect(back.baseOrder).toBe(t.baseOrder);
    expect(back.maxValue).toBe(t.maxValue);
  });

  it('does not mutate the input', () => {
    const t = fixture();
    const aBefore = [...t.channels.A];
    const peaksBefore = [...t.peakPositions];
    const baseOrderBefore = t.baseOrder;
    reverseComplementTrace(t);
    expect(t.channels.A).toEqual(aBefore);
    expect(t.peakPositions).toEqual(peaksBefore);
    expect(t.baseOrder).toBe(baseOrderBefore);
  });

  it('handles unequal channel lengths by using the longest as totalSamples', () => {
    const t: TraceData = {
      channels: {
        A: [0, 0, 0, 0, 100],
        C: [0, 0, 0, 100],
        G: [],
        T: [0, 100],
      },
      peakPositions: [4],
      baseOrder: 'GATC',
      maxValue: 100,
    };
    const rc = reverseComplementTrace(t);
    expect(rc.peakPositions).toEqual([0]);
  });

  it('handles an empty trace (no peaks, no samples)', () => {
    const empty: TraceData = {
      channels: { A: [], C: [], G: [], T: [] },
      peakPositions: [],
      baseOrder: 'GATC',
      maxValue: 0,
    };
    const rc = reverseComplementTrace(empty);
    expect(rc.peakPositions).toEqual([]);
    expect(rc.channels.A).toEqual([]);
    expect(rc.baseOrder).toBe('CTAG');
  });

  it('round-trip preserves a non-uniform peak spacing across multiple inversions', () => {
    const t: TraceData = {
      channels: {
        A: new Array(20).fill(0).map((_, i) => (i % 5 === 0 ? 100 : 0)),
        C: new Array(20).fill(0),
        G: new Array(20).fill(0),
        T: new Array(20).fill(0),
      },
      peakPositions: [0, 5, 10, 15],
      baseOrder: 'GATC',
      maxValue: 100,
    };
    const back = reverseComplementTrace(reverseComplementTrace(t));
    expect(back.peakPositions).toEqual(t.peakPositions);
    expect(back.channels.A).toEqual(t.channels.A);
  });
});
