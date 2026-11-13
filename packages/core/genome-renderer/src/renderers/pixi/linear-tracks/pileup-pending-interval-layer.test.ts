// @vitest-environment jsdom

import { Container } from 'pixi.js';
import { describe, expect, it } from 'vitest';

import { webglThemeForMode } from '../shared/theme';
import type { PathMapper } from '../shared/path-types';
import {
  PENDING_INTERVAL_BAND_HEIGHT_PX,
  PileupPendingIntervalLayer,
  packPendingReferenceIntervals,
  uncoveredPendingReferenceIntervals,
} from './pileup-pending-interval-layer';

function mapper(viewStartBp: number, pixelsPerBp = 2): PathMapper {
  return {
    viewStartBp,
    viewEndBp: viewStartBp + 400,
    pixelsPerBp,
    bpLeftX: (bp: number) => (bp - viewStartBp) * pixelsPerBp,
  } as PathMapper;
}

describe('pileup pending reference intervals', () => {
  it('splits skeletons around loaded histogram/read ranges without merging adjacent pending tiles', () => {
    expect(
      uncoveredPendingReferenceIntervals(
        [
          { startBp: 0, endBp: 100, state: 'pending' },
          { startBp: 100, endBp: 200, state: 'pending' },
          { startBp: 200, endBp: 300, state: 'empty' },
        ],
        [
          { startBp: 20, endBp: 80 },
          { startBp: 140, endBp: 300 },
        ]
      )
    ).toEqual([
      { startBp: 0, endBp: 20, state: 'pending' },
      { startBp: 80, endBp: 100, state: 'pending' },
      { startBp: 100, endBp: 140, state: 'pending' },
    ]);
  });

  it.each(['light', 'dark'] as const)(
    'draws a narrow blue signal-loading rail with a slow %s pulse',
    (mode) => {
      const layer = new PileupPendingIntervalLayer(new Container());
      const input = {
        intervals: [{ startBp: 100, endBp: 300, state: 'pending' as const }],
        pathMapper: mapper(50),
        viewportWidthPx: 800,
        viewportHeightPx: 500,
        bandTopPx: 50,
        bandHeightPx: 4,
        appearance: 'signal-pending' as const,
        theme: webglThemeForMode(mode),
      };
      layer.paint({ ...input, nowMs: 0 });
      const first = layer.diagnostics();
      expect(first).toMatchObject({
        appearance: 'signal-pending',
        bandTopPx: 50,
        bandHeightPx: 4,
        visible: true,
        motionPhase: 0,
      });
      expect(first.loadingColors).toEqual(
        mode === 'dark' ? { base: 0x24445e, pulse: 0x63b8ed } : { base: 0xc9e6f8, pulse: 0x2b91d1 }
      );
      layer.paint({ ...input, pathMapper: mapper(100), nowMs: 500 });
      expect(layer.diagnostics()).toMatchObject({
        geometryBuildCount: 1,
        bufferUploadCount: 1,
        motionPhase: 0.25,
        projectedIntervalsPx: [{ left: 0, right: 400 }],
      });
      layer.paint({ ...input, intervals: [], nowMs: 600 });
      expect(layer.hasMotion()).toBe(false);
      expect(layer.diagnostics().visible).toBe(false);
      layer.destroy();
    }
  );

  it('packs only pending tiles and keeps adjacent tiles as separate genome pieces', () => {
    const packed = packPendingReferenceIntervals([
      { startBp: 100, endBp: 200, state: 'pending' },
      { startBp: 200, endBp: 300, state: 'pending' },
      { startBp: 300, endBp: 500, state: 'empty' },
    ]);

    expect(packed.intervals).toEqual([
      { startBp: 100, endBp: 200 },
      { startBp: 200, endBp: 300 },
    ]);
    expect(packed.instanceData).toHaveLength(8);
  });

  it('moves with the pileup camera without rebuilding interval geometry', () => {
    const parent = new Container();
    const layer = new PileupPendingIntervalLayer(parent);
    const intervals = [
      { startBp: 100, endBp: 200, state: 'pending' as const },
      { startBp: 250, endBp: 300, state: 'pending' as const },
      { startBp: 300, endBp: 400, state: 'empty' as const },
    ];

    layer.paint({
      intervals,
      pathMapper: mapper(50),
      viewportWidthPx: 800,
      viewportHeightPx: 500,
      bandTopPx: 410,
      theme: webglThemeForMode('light'),
      nowMs: 0,
    });
    expect(layer.diagnostics()).toMatchObject({
      pendingIntervalCount: 2,
      geometryBuildCount: 1,
      bandTopPx: 410,
      bandHeightPx: PENDING_INTERVAL_BAND_HEIGHT_PX,
      projectedIntervalsPx: [
        { left: 100, right: 300 },
        { left: 400, right: 500 },
      ],
      visible: true,
    });

    layer.paint({
      intervals,
      pathMapper: mapper(100),
      viewportWidthPx: 800,
      viewportHeightPx: 500,
      bandTopPx: 410,
      theme: webglThemeForMode('light'),
      nowMs: 275,
    });
    expect(layer.diagnostics()).toMatchObject({
      pendingIntervalCount: 2,
      geometryBuildCount: 1,
      projectedIntervalsPx: [
        { left: 0, right: 200 },
        { left: 300, right: 400 },
      ],
      visible: true,
    });
    expect(layer.diagnostics().motionPhase).toBeGreaterThan(0);
    layer.destroy();
  });

  it('does not animate or draw an authoritative empty interval', () => {
    const parent = new Container();
    const layer = new PileupPendingIntervalLayer(parent);
    layer.paint({
      intervals: [{ startBp: 100, endBp: 200, state: 'empty' }],
      pathMapper: mapper(0),
      viewportWidthPx: 800,
      viewportHeightPx: 500,
      bandTopPx: 410,
      theme: webglThemeForMode('dark'),
      nowMs: 100,
    });
    expect(layer.diagnostics()).toMatchObject({
      pendingIntervalCount: 0,
      geometryBuildCount: 0,
      projectedIntervalsPx: [],
      visible: false,
    });
    expect(layer.hasMotion()).toBe(false);
    layer.destroy();
  });
});
