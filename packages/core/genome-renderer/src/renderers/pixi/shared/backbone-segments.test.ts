import { describe, expect, it } from 'vitest';
import type { RenderState } from '../../../types';
import { normalizeBackboneSegmentRanges } from './backbone-segments';
import { webglAnnotationColorForMode } from './theme';

function createState(themeMode: RenderState['themeMode']): RenderState {
  return {
    morph: 0,
    viewOffset: 0,
    zoom: 1,
    width: 800,
    height: 200,
    themeMode,
    selectedIds: new Set(),
    hoveredId: null,
    viewportRange: null,
    highlightRange: null,
    residueLinkRange: null,
    cursorPosition: null,
    hoveredCutSiteId: null,
    perfPanelVisible: false,
  };
}

describe('normalizeBackboneSegmentRanges', () => {
  it('preserves theme-stable assembly provenance colors in dark mode', () => {
    const color = 0x8bb680;
    const ranges = normalizeBackboneSegmentRanges(
      [{ start: 10, end: 30, color, alpha: 0.72, themeStableColor: true }],
      100,
      createState('dark')
    );

    expect(ranges).toHaveLength(1);
    expect(ranges[0].color).toBe(color);
    expect(ranges[0].alpha).toBe(0.72);
  });

  it('keeps app-authored assembly provenance fully opaque for WebGL backbones', () => {
    const color = 0x3b82f6;
    const ranges = normalizeBackboneSegmentRanges(
      [{ start: 10, end: 30, color, alpha: 1, themeStableColor: true }],
      100,
      createState('dark')
    );

    expect(ranges).toEqual([{ start: 10, end: 30, color, strokeWidth: 4.5, alpha: 1 }]);
  });

  it('continues to dark-adapt ordinary renderer-owned segment colors', () => {
    const color = 0x8bb680;
    const ranges = normalizeBackboneSegmentRanges(
      [{ start: 10, end: 30, color }],
      100,
      createState('dark')
    );

    expect(ranges[0].color).toBe(webglAnnotationColorForMode(color, 'dark'));
    expect(ranges[0].color).not.toBe(color);
    expect(ranges[0].alpha).toBe(0.95);
  });

  it('carries app-authored stroke width and alpha through wrapped provenance ranges', () => {
    const ranges = normalizeBackboneSegmentRanges(
      [{ start: 90, end: 10, color: 0x123456, strokeWidth: 3, alpha: 0.61 }],
      100,
      createState('light')
    );

    expect(ranges).toEqual([
      { start: 90, end: 100, color: 0x123456, strokeWidth: 3, alpha: 0.61 },
      { start: 0, end: 10, color: 0x123456, strokeWidth: 3, alpha: 0.61 },
    ]);
  });
});
