/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import {
  clampWebglMapZoom,
  formatWebglMapZoom,
  webglMapSliderValueToZoom,
  webglMapZoomToDisplaySliderPercent,
  webglMapZoomToSliderValue,
} from '../SequenceMapPaneControls';

describe('SequenceMapPaneControls zoom normalization', () => {
  it('formats map zoom as a percentage of the maximum zoom, not the zoomed-out baseline', () => {
    expect(formatWebglMapZoom(0.5)).toBe('0.01%');
    expect(formatWebglMapZoom(1000)).toBe('20%');
    expect(formatWebglMapZoom(5000)).toBe('100%');
  });

  it('does not report 100 percent until the actual maximum zoom is reached', () => {
    expect(formatWebglMapZoom(4999)).not.toBe('100%');
    expect(formatWebglMapZoom(4999)).toBe('99.9%');
    expect(webglMapZoomToDisplaySliderPercent(4999)).toBeLessThan(100);
    expect(webglMapZoomToDisplaySliderPercent(5000)).toBe(100);
  });

  it('round-trips the log slider against the true min and max bounds', () => {
    expect(webglMapSliderValueToZoom(0)).toBeCloseTo(0.5, 6);
    expect(webglMapSliderValueToZoom(1)).toBeCloseTo(5000, 6);
    expect(webglMapZoomToSliderValue(0.5)).toBe(0);
    expect(webglMapZoomToSliderValue(5000)).toBe(1);
  });

  it('normalizes against renderer-provided zoom bounds instead of the static fallback', () => {
    const rendererBounds = { min: 0.5, max: 185 };

    expect(clampWebglMapZoom(5000, rendererBounds)).toBe(185);
    expect(formatWebglMapZoom(185, rendererBounds)).toBe('100%');
    expect(webglMapZoomToDisplaySliderPercent(185, rendererBounds)).toBe(100);
    expect(webglMapZoomToSliderValue(185, rendererBounds)).toBe(1);
    expect(webglMapSliderValueToZoom(1, rendererBounds)).toBeCloseTo(185, 6);
    expect(formatWebglMapZoom(184, rendererBounds)).not.toBe('100%');
  });
});

describe('formatWebglMapZoom — the 100% boundary is scale-free ', () => {
  const magnitudes = [0.05, 1, 23.404497903820584, 1000, 250_000];

  it.each(magnitudes)('reads 99.9%% at 0.999 x max = %p', (max) => {
    expect(formatWebglMapZoom(max * 0.999, { min: max / 1e4, max })).toBe('99.9%');
  });

  it.each(magnitudes)('reads 100%% exactly at max = %p', (max) => {
    expect(formatWebglMapZoom(max, { min: max / 1e4, max })).toBe('100%');
  });

  it.each(magnitudes)('does NOT claim 100%% just short of max = %p', (max) => {
    expect(formatWebglMapZoom(max * 0.9998, { min: max / 1e4, max })).toBe('99.9%');
  });

  it.each(magnitudes)('slider percent matches the same rule at max = %p', (max) => {
    expect(webglMapZoomToDisplaySliderPercent(max, { min: max / 1e4, max })).toBe(100);
    expect(webglMapZoomToDisplaySliderPercent(max * 0.9998, { min: max / 1e4, max })).toBeLessThan(
      100
    );
  });
});
