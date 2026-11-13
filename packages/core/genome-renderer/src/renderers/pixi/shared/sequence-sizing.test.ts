import { describe, expect, it } from 'vitest';
import {
  MAX_SEQUENCE_FONT_SIZE,
  MIN_SEQUENCE_FONT_SIZE,
  stableRasterSize,
} from './sequence-sizing';

describe('stableRasterSize  ③ — glyph crispness ladder)', () => {
  it('never upscales: raster size is always >= the display font size', () => {
    for (let f = MIN_SEQUENCE_FONT_SIZE; f <= MAX_SEQUENCE_FONT_SIZE; f += 0.25) {
      expect(stableRasterSize(f)).toBeGreaterThanOrEqual(f - 1e-9);
    }
  });

  it('bounds the GPU downscale to [1/sqrt2, 1] (the crispness win over pow-2)', () => {
    const MIN_SCALE = 1 / Math.SQRT2 - 1e-9;
    for (let f = MIN_SEQUENCE_FONT_SIZE; f <= MAX_SEQUENCE_FONT_SIZE; f += 0.25) {
      const scale = f / stableRasterSize(f);
      expect(scale).toBeGreaterThanOrEqual(MIN_SCALE);
      expect(scale).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('crisps the worst case: 22px max-zoom glyph now downscales to ~0.97 (was 0.69)', () => {
    const scale = MAX_SEQUENCE_FONT_SIZE / stableRasterSize(MAX_SEQUENCE_FONT_SIZE);
    expect(scale).toBeGreaterThan(0.95);
  });

  it('is monotonic and quantized (stable within a ladder bucket → no jitter)', () => {
    let prev = 0;
    for (let f = MIN_SEQUENCE_FONT_SIZE; f <= MAX_SEQUENCE_FONT_SIZE; f += 0.1) {
      const r = stableRasterSize(f);
      expect(r).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = r;
    }
    expect(stableRasterSize(20)).toBe(stableRasterSize(21));
    expect(stableRasterSize(20)).toBe(stableRasterSize(22));
  });
});
