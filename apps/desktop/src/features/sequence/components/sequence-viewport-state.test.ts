// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  buildSequenceViewportPatch,
  navigationCenterBpFromRangeOrPosition,
  resolveMapOnlyNucleotideZoom,
  resolveMapOnlyRangeFitZoom,
  normalizeSequenceViewportCenterBp,
  normalizeSequenceViewportZoomLevel,
  viewportCenterBpFromRange,
} from './sequence-viewport-state';

describe('sequence viewport tab state', () => {
  it('normalizes the persisted 1-indexed center into the sequence bounds', () => {
    expect(normalizeSequenceViewportCenterBp(42, 100)).toBe(42);
    expect(normalizeSequenceViewportCenterBp(0, 100)).toBe(1);
    expect(normalizeSequenceViewportCenterBp(120, 100)).toBe(100);
    expect(normalizeSequenceViewportCenterBp(Number.NaN, 100)).toBeNull();
    expect(normalizeSequenceViewportCenterBp(42, 0)).toBeNull();
  });

  it('preserves the extended wrapped zoom range and caps persisted values at 120%', () => {
    expect(normalizeSequenceViewportZoomLevel(75)).toBe(75);
    expect(normalizeSequenceViewportZoomLevel(0)).toBe(0.2);
    expect(normalizeSequenceViewportZoomLevel(117.5)).toBe(117.5);
    expect(normalizeSequenceViewportZoomLevel(500)).toBe(120);
    expect(normalizeSequenceViewportZoomLevel('75')).toBeNull();
  });

  it('converts viewport ranges into the 1-indexed biological center used for tab restore', () => {
    expect(viewportCenterBpFromRange({ start: 20, end: 40 }, 100)).toBe(31);
    expect(viewportCenterBpFromRange({ start: 90, end: 10, wraps: true }, 100)).toBe(1);
  });

  it('prefers the range midpoint for programmatic annotation navigation', () => {
    expect(
      navigationCenterBpFromRangeOrPosition(
        { position: 703, range: { start: 702, end: 1499 } },
        5000
      )
    ).toBe(1101);
  });

  it('zooms the map to nucleotide scale only when the sequence canvas is hidden', () => {
    expect(
      resolveMapOnlyNucleotideZoom({
        mapVisible: true,
        sequenceVisible: false,
        zoomBounds: { min: 1, max: 46.9 },
      })
    ).toBe(46.9);
    expect(
      resolveMapOnlyNucleotideZoom({
        mapVisible: true,
        sequenceVisible: true,
        zoomBounds: { min: 1, max: 46.9 },
      })
    ).toBeNull();
    expect(
      resolveMapOnlyNucleotideZoom({
        mapVisible: false,
        sequenceVisible: false,
        zoomBounds: { min: 1, max: 46.9 },
      })
    ).toBeNull();
    expect(
      resolveMapOnlyNucleotideZoom({
        mapVisible: true,
        sequenceVisible: false,
        zoomBounds: null,
      })
    ).toBeNull();
  });

  it('fits a complete map-only navigation range with breathing room', () => {
    const zoom = resolveMapOnlyRangeFitZoom({
      mapVisible: true,
      sequenceVisible: false,
      sequenceLength: 802,
      range: { start: 0, end: 379 },
      zoomBounds: { min: 1, max: 7.35 },
    });

    expect(zoom).toBeCloseTo(802 / 475);
    expect(802 / zoom!).toBeGreaterThanOrEqual(380);
  });

  it('fits a wrapping range and leaves point or split-view navigation unchanged', () => {
    expect(
      resolveMapOnlyRangeFitZoom({
        mapVisible: true,
        sequenceVisible: false,
        sequenceLength: 802,
        range: { start: 700, end: 99, wraps: true },
        zoomBounds: { min: 1, max: 7.35 },
      })
    ).toBeCloseTo(802 / (202 * 1.25));
    expect(
      resolveMapOnlyRangeFitZoom({
        mapVisible: true,
        sequenceVisible: false,
        sequenceLength: 802,
        range: null,
        zoomBounds: { min: 1, max: 7.35 },
      })
    ).toBeNull();
    expect(
      resolveMapOnlyRangeFitZoom({
        mapVisible: true,
        sequenceVisible: true,
        sequenceLength: 802,
        range: { start: 0, end: 379 },
        zoomBounds: { min: 1, max: 7.35 },
      })
    ).toBeNull();
  });

  it('falls back to the 1-indexed scroll position when no range is available', () => {
    expect(navigationCenterBpFromRangeOrPosition({ position: 703 }, 5000)).toBe(703);
  });

  it('builds a compact viewState patch for per-tab position and zoom persistence', () => {
    expect(buildSequenceViewportPatch({ centerBp: 42, zoomLevel: 75 }, 100)).toEqual({
      sequenceViewportCenterBp: 42,
      sequenceViewportZoomLevel: 75,
    });
  });
});
