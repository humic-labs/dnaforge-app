// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { detectMixedCall } from './iupac';
import type { TraceData } from './types';

function singleSample(values: {
  A: number;
  C: number;
  G: number;
  T: number;
}): TraceData['channels'] {
  return {
    A: [values.A],
    C: [values.C],
    G: [values.G],
    T: [values.T],
  };
}

describe('detectMixedCall', () => {
  it('returns the dominant base unambiguously when one channel dominates', () => {
    expect(detectMixedCall(singleSample({ A: 1000, C: 0, G: 0, T: 0 }), 0)).toEqual({
      dominant: 'A',
      secondary: [],
      iupacCode: 'A',
    });
  });

  it('returns Y for a 50/50 C+T mix at the default threshold', () => {
    const result = detectMixedCall(singleSample({ A: 0, C: 500, G: 0, T: 500 }), 0);
    expect(result.iupacCode).toBe('Y');
    expect(new Set([result.dominant, ...result.secondary])).toEqual(new Set(['C', 'T']));
  });

  it('returns each two-way IUPAC code (R, Y, S, W, K, M)', () => {
    expect(detectMixedCall(singleSample({ A: 500, C: 0, G: 500, T: 0 }), 0).iupacCode).toBe('R');
    expect(detectMixedCall(singleSample({ A: 0, C: 500, G: 0, T: 500 }), 0).iupacCode).toBe('Y');
    expect(detectMixedCall(singleSample({ A: 0, C: 500, G: 500, T: 0 }), 0).iupacCode).toBe('S');
    expect(detectMixedCall(singleSample({ A: 500, C: 0, G: 0, T: 500 }), 0).iupacCode).toBe('W');
    expect(detectMixedCall(singleSample({ A: 0, C: 0, G: 500, T: 500 }), 0).iupacCode).toBe('K');
    expect(detectMixedCall(singleSample({ A: 500, C: 500, G: 0, T: 0 }), 0).iupacCode).toBe('M');
  });

  it('returns each three-way IUPAC code (B, D, H, V)', () => {
    expect(detectMixedCall(singleSample({ A: 0, C: 500, G: 500, T: 500 }), 0).iupacCode).toBe('B');
    expect(detectMixedCall(singleSample({ A: 500, C: 0, G: 500, T: 500 }), 0).iupacCode).toBe('D');
    expect(detectMixedCall(singleSample({ A: 500, C: 500, G: 0, T: 500 }), 0).iupacCode).toBe('H');
    expect(detectMixedCall(singleSample({ A: 500, C: 500, G: 500, T: 0 }), 0).iupacCode).toBe('V');
  });

  it('returns N when all four channels clear the threshold', () => {
    const result = detectMixedCall(singleSample({ A: 500, C: 500, G: 500, T: 500 }), 0);
    expect(result.iupacCode).toBe('N');
    expect(result.dominant).toBe('A');
    expect(result.secondary).toEqual(['C', 'G', 'T']);
  });

  it('does not call a secondary base below the threshold', () => {
    const result = detectMixedCall(singleSample({ A: 1000, C: 400, G: 0, T: 0 }), 0);
    expect(result.iupacCode).toBe('A');
    expect(result.secondary).toEqual([]);
  });

  it('respects a custom threshold', () => {
    const channels = singleSample({ A: 1000, C: 400, G: 0, T: 0 });
    expect(detectMixedCall(channels, 0, 0.3).iupacCode).toBe('M');
    expect(detectMixedCall(channels, 0, 0.5).iupacCode).toBe('A');
  });

  it('treats a secondary at exactly the threshold as a co-call', () => {
    expect(detectMixedCall(singleSample({ A: 1000, C: 500, G: 0, T: 0 }), 0, 0.5).iupacCode).toBe(
      'M'
    );
  });

  it('linearly interpolates amplitudes for fractional sample indices', () => {
    const channels: TraceData['channels'] = {
      A: [0, 1000],
      C: [500, 500],
      G: [0, 0],
      T: [0, 0],
    };
    expect(detectMixedCall(channels, 0.5).iupacCode).toBe('M');
  });

  it('returns N when there is no signal at the sample (all zero amplitudes)', () => {
    expect(detectMixedCall(singleSample({ A: 0, C: 0, G: 0, T: 0 }), 0).iupacCode).toBe('N');
  });

  it('treats negative amplitudes as their absolute value (signed int16 baseline noise)', () => {
    expect(detectMixedCall(singleSample({ A: -1000, C: 0, G: 0, T: 0 }), 0).iupacCode).toBe('A');
  });

  it('breaks amplitude ties deterministically by alphabetical base', () => {
    const channels = singleSample({ A: 500, C: 500, G: 0, T: 0 });
    const result = detectMixedCall(channels, 0);
    expect(result.dominant).toBe('A');
    expect(result.iupacCode).toBe('M');
  });

  it('rejects out-of-range threshold', () => {
    const channels = singleSample({ A: 100, C: 0, G: 0, T: 0 });
    expect(() => detectMixedCall(channels, 0, -0.1)).toThrow();
    expect(() => detectMixedCall(channels, 0, 1.1)).toThrow();
    expect(() => detectMixedCall(channels, 0, NaN)).toThrow();
  });

  it('rejects negative or non-finite sample index', () => {
    const channels = singleSample({ A: 100, C: 0, G: 0, T: 0 });
    expect(() => detectMixedCall(channels, -1)).toThrow();
    expect(() => detectMixedCall(channels, NaN)).toThrow();
  });
});
