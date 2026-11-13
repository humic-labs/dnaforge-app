import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Feature, RenderState } from '../../../types';
import { getLabelOccupancyRecords, resetLabelOccupancy } from '../shared/label-occupancy';
import {
  decorationCacheKeyFor,
  renderAnnotationOverlayFrame,
  renderRetainedTranscriptDecorations,
  replayAnnotationLabelOccupancy,
  reserveAnnotationPillBounds,
  type RetainedDrawHost,
} from './indexed-annotation-retained-draw';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

function feature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: 1,
    type: 'gene',
    start: 10,
    end: 40,
    direction: 'forward',
    color: 0x3366ff,
    lane: 0,
    displayName: 'gene',
    ...overrides,
  };
}

function state(overrides: Partial<RenderState> = {}): RenderState {
  return {
    morph: 0,
    viewOffset: 0,
    zoom: 1,
    width: 800,
    height: 400,
    themeMode: 'light',
    selectedIds: new Set(),
    hoveredId: null,
    viewportRange: null,
    highlightRange: null,
    cursorPosition: null,
    hoveredCutSiteId: null,
    perfPanelVisible: false,
    ...overrides,
  };
}

function graphics(overrides: Record<string, unknown> = {}) {
  return {
    visible: true,
    position: { x: 7 },
    clear() {
      this.visible = false;
    },
    setStrokeStyle() {},
    moveTo() {},
    lineTo() {},
    roundRect() {},
    stroke() {},
    ...overrides,
  };
}

function host(overrides: Partial<RetainedDrawHost> = {}): RetainedDrawHost {
  const decorationGraphics = graphics();
  return {
    genomeLength: 1000,
    features: [feature()],
    featuresInRange: () => [feature()],
    featureWindowIndex: { candidatesForPath: (_path, features) => features },
    featureOffset: () => 0,
    scaledBarHeight: () => 8,
    graphics: graphics() as never,
    retainedTranscriptDecorationGraphics: decorationGraphics as never,
    curvedLabels: { reset() {} },
    labelPool: [],
    labelIndex: 0,
    hitCache: [],
    outlineCache: { clear() {} },
    labelOccupancyCache: [],
    decorationCacheKey: 'chev|bn:1|fs:k|ppb:0.01|th:light|layout:no-layout|h:400|bh:8',
    decorationCacheAnchorViewStartBp: 0,
    decorationCacheAnchorPpb: 0.01,
    decorationCacheBuiltLoBp: -100,
    decorationCacheBuiltHiBp: 2000,
    retainedLinearTranscriptKey: 'k',
    retainedLinearTranscriptLayoutKey: (s) => `no-layout|h:${s.height}`,
    lastRetainedTranscriptDecorationsDrawn: true,
    retainedTranscriptDecorationBuilds: 3,
    immediateDrawStateClearedForRetained: false,
    retainedDrawStateClean: false,
    renderCallCount: 0,
    geometryRebuildCount: 0,
    geometryCacheHitCount: 0,
    lastRenderMode: 'none',
    lastRenderKey: '',
    lastRenderKeyParts: null,
    lastGeometryRebuildReasons: [],
    lastDrawAudit: null,
    drawAuditFrameId: 0,
    lastDrawnFeatureCount: 0,
    lastOverviewImmediateBlendMs: 0,
    lastOverviewAggregationCacheHit: false,
    lastOverviewAggregationEnabled: false,
    lastOverviewPassthroughFeatureCount: 0,
    lastOverviewCacheMs: 0,
    lastOverviewLodCompressionBlend: 0,
    lastOverviewLodFullShapeBlend: 1,
    lastOverviewDensityAtlasSampleScreenPx: 0.25,
    lastOverviewDensityAtlasBinBp: 0,
    lastOverviewDensityAtlasLevelCount: 0,
    lastOverviewDensityAtlasEstimatedBinCount: 0,
    lastOverviewDensityAtlasWasCoarsened: false,
    lastOverviewDensityAtlasBudgetExceeded: false,
    overviewBinDrawCount: 0,
    retainedOverviewHitBins: [],
    retainedOverviewLayer: null,
    overviewCache: {
      getOverviewAggregationCache: () => null,
      mergedDensityAtlasDiagnostics: () => ({
        estimatedBinCount: 0,
        wasCoarsened: false,
        budgetExceeded: false,
      }),
      lastCacheHit: false,
    },
    overviewCacheContext: () => ({}) as never,
    resetAllPresentersToHidden() {},
    clearDecorationCache() {},
    resetImmediateDrawStats() {},
    renderKeyParts: () => ({}),
    renderKeyFromParts: () => '',
    renderKeyChangeReasons: () => [],
    beginDrawAudit: () =>
      ({
        decisions: {},
        overview: {},
      }) as never,
    recordDrawAuditDecision() {},
    renderImmediateFeature: () => 'drawn',
    renderInteractionOutlines() {},
    drawRetainedTranscriptIntronConnectors() {},
    ...overrides,
  };
}

function linearPath(viewStartBp = 0, viewEndBp = 800, pixelsPerBp = 1) {
  return {
    isArcMode: false,
    viewStartBp,
    viewEndBp,
    pixelsPerBp,
    featurePolygonAt: () => [0, 0, 10, 0, 10, 8, 0, 8],
    featureLabelPosAt: (bp: number) => ({ x: bp * pixelsPerBp, y: 10 }),
  } as never;
}

describe('indexed retained-draw presenter', () => {
  it('lives outside annotation-overlay.ts', () => {
    const source = overlaySource();
    expect(source).not.toContain(
      'Skip redraw if nothing that affects feature geometry changed. hoveredId'
    );
    expect(source).not.toContain(
      'Raster pixels are not evidence that a CPU interaction index matches'
    );
    expect(source).not.toContain(
      ' PERF — TRANSLATION CACHE. Build the chevron/connector tessellation'
    );
    expect(source).not.toContain('function renderAnnotationOverlayFrame(');
    expect(source).not.toContain('function renderRetainedTranscriptDecorations(');
    expect(source).not.toContain('function replayAnnotationLabelOccupancy(');
    expect(source).not.toContain('function reserveAnnotationPillBounds(');
  });

  it('replays cached occupancy with force so cache-hit frames keep the same reservations', () => {
    const renderState = state();
    resetLabelOccupancy(renderState);
    const occupancyHost = host({
      labelOccupancyCache: [
        { xMin: 10, xMax: 40, yMin: 2, yMax: 10, kind: 'gene', featureId: 1, text: 'g' },
      ],
    });
    replayAnnotationLabelOccupancy(occupancyHost, renderState);
    expect(getLabelOccupancyRecords(renderState)).toEqual([
      { xMin: 10, xMax: 40, yMin: 2, yMax: 10, kind: 'gene', featureId: 1, text: 'g' },
    ]);
  });

  it('reserves a pill and records occupancy only when the reservation succeeds', () => {
    const renderState = state();
    resetLabelOccupancy(renderState);
    const occupancyHost = host({ labelOccupancyCache: [] });
    const reserved = reserveAnnotationPillBounds(
      occupancyHost,
      renderState,
      linearPath(),
      10,
      20,
      0,
      4,
      { kind: 'gene', featureId: 1, text: 'g' }
    );
    expect(reserved).toBe(true);
    expect(occupancyHost.labelOccupancyCache).toHaveLength(1);
    expect(
      reserveAnnotationPillBounds(occupancyHost, renderState, linearPath(), 10, 0, 0, 4, {
        kind: 'gene',
      })
    ).toBe(false);
  });

  it('hides decorations and drops the cache when the batched set is empty', () => {
    const drawHost = host();
    const g = drawHost.retainedTranscriptDecorationGraphics;
    renderRetainedTranscriptDecorations(drawHost, new Set(), linearPath(), state());
    expect(g.visible).toBe(false);
    expect(g.position.x).toBe(0);
    expect(drawHost.decorationCacheKey).toBe('');
    expect(drawHost.lastRetainedTranscriptDecorationsDrawn).toBe(false);
    expect(drawHost.retainedTranscriptDecorationBuilds).toBe(3);
  });

  it('keeps the decoration cache key independent of pan translation', () => {
    const drawHost = host();
    const key = decorationCacheKeyFor(drawHost, new Set([feature()]), 0.01, state());
    expect(key).toContain('chev');
    expect(key).toContain('bn:1');
    expect(key).toContain('fs:k');
    expect(key).toContain('ppb:0.01');
    expect(key).not.toContain('viewStart');
  });

  it('replays occupancy and outlines on a cache-hit render frame', () => {
    let outlined = 0;
    const drawHost = host({
      lastRenderKey: 'same',
      renderKeyParts: () => ({ k: '1' }),
      renderKeyFromParts: () => 'same',
      labelOccupancyCache: [
        { xMin: 1, xMax: 2, yMin: 3, yMax: 4, kind: 'gene', featureId: 1, text: 'g' },
      ],
      renderInteractionOutlines() {
        outlined += 1;
      },
    });
    const renderState = state();
    resetLabelOccupancy(renderState);
    renderAnnotationOverlayFrame(drawHost, linearPath(), renderState);
    expect(getLabelOccupancyRecords(renderState)).toHaveLength(1);
    expect(outlined).toBe(1);
    expect(drawHost.lastRenderMode).toBe('cache-hit');
  });
});
