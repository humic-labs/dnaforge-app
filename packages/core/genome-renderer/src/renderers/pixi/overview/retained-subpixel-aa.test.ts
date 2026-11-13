import { describe, expect, it } from 'vitest';
import {
  compositeOverBackground,
  retainedSubpixelAlphaScale,
  retainedSubpixelOpacityCompositeStyle,
  retainedSubpixelOpacityPolicy,
} from './retained-subpixel-aa';

describe('retained subpixel antialiasing', () => {
  it('does not widen or fade contiguous quantitative fills', () => {
    expect(retainedSubpixelOpacityPolicy('continuous-fill')).toEqual({
      minWidthPx: 0,
      alphaGamma: 1,
      minAlphaScale: 1,
    });
    expect(
      retainedSubpixelAlphaScale(0.001, retainedSubpixelOpacityPolicy('continuous-fill'))
    ).toBe(1);
  });

  it('keeps true zero invisible and ramps subpixel features monotonically', () => {
    expect(retainedSubpixelAlphaScale(0)).toBe(0);
    expect(retainedSubpixelAlphaScale(Number.NaN)).toBe(0);
    expect(retainedSubpixelAlphaScale(0.001)).toBeCloseTo(0.001 ** 0.22, 6);
    expect(retainedSubpixelAlphaScale(0.01)).toBeCloseTo(0.01 ** 0.22, 6);
    expect(retainedSubpixelAlphaScale(0.1)).toBeCloseTo(0.1 ** 0.22, 6);
    expect(retainedSubpixelAlphaScale(0.45)).toBeGreaterThan(0.83);
    expect(retainedSubpixelAlphaScale(0.75)).toBeGreaterThan(0.9);
    expect(retainedSubpixelAlphaScale(1)).toBe(1);
    expect(retainedSubpixelAlphaScale(3)).toBe(1);
  });

  it('uses nonlinear opacity only, leaving source RGB unchanged at subpixel widths', () => {
    const color: [number, number, number] = [0x1d / 255, 0x4e / 255, 0xd8 / 255];
    const tiny = retainedSubpixelOpacityCompositeStyle(color, 0.85, 0.001);
    const linearTinyAlpha = 0.85 * 0.001;

    expect(tiny.rgb).toEqual(color);
    expect(tiny.alpha).toBeGreaterThan(linearTinyAlpha * 200);
    expect(tiny.alpha).toBeLessThan(0.25);
  });

  it('keeps neutral-background opacity blends on the original hue line', () => {
    const color: [number, number, number] = [0x1d / 255, 0x4e / 255, 0xd8 / 255];
    const background: [number, number, number] = [1, 1, 1];
    const base = retainedSubpixelOpacityCompositeStyle(color, 0.85, 4);
    const tiny = retainedSubpixelOpacityCompositeStyle(color, 0.85, 0.001);

    expect(hueDegrees(compositeOverBackground(tiny, background))).toBeCloseTo(
      hueDegrees(compositeOverBackground(base, background)),
      8
    );
  });
});

function hueDegrees([r, g, b]: [number, number, number]): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return 0;
  let hue = 0;
  if (max === r) {
    hue = ((g - b) / delta + (g < b ? 6 : 0)) * 60;
  } else if (max === g) {
    hue = ((b - r) / delta + 2) * 60;
  } else {
    hue = ((r - g) / delta + 4) * 60;
  }
  return hue;
}
