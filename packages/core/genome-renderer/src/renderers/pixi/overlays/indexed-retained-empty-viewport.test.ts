import { describe, expect, it } from 'vitest';
import type { RenderState } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import { OVERVIEW_GLYPH_TILE_MIN_VISIBLE_BP } from './indexed-annotation-body-owner';
import {
  presentEmptyRetainedLinearViewport,
  type EmptyRetainedViewportHost,
} from './indexed-retained-empty-viewport';
import type { RetainedOverlayCameraState } from './overlay-track';

function camera(viewStartBp = 0, viewEndBp = 800): RetainedOverlayCameraState {
  return {
    path: { viewStartBp, viewEndBp } as PathMapper,
    state: {
      morph: 0,
      viewOffset: 0,
      zoom: 1,
      width: 800,
      height: 400,
      selectedIds: new Set(),
      hoveredId: null,
      highlightRange: null,
      cursorPosition: null,
    } as RenderState,
    yOffset: 0,
    height: 200,
  };
}

function emptyHost(
  overrides: Partial<EmptyRetainedViewportHost> = {}
): EmptyRetainedViewportHost & { hidden: string[]; fallbacks: string[] } {
  const host: EmptyRetainedViewportHost & { hidden: string[]; fallbacks: string[] } = {
    hidden: [],
    fallbacks: [],
    renderCallCount: 0,
    lastRenderMode: 'none',
    lastRenderKey: 'stale',
    lastRenderKeyParts: { zoom: '1' },
    lastGeometryRebuildReasons: ['zoom'],
    retainedDrawStateClean: false,
    retainedLinearFeatureLayer: {
      hide() {
        host.hidden.push('feature');
      },
    },
    retainedLinearTranscriptLayer: {
      hide() {
        host.hidden.push('transcript');
      },
    },
    retainedLinearBinCount: 4,
    retainedOverviewMode: 'inactive',
    retainedOverviewStyle: 'full-shapes',
    retainedOverviewCameraUpdates: 0,
    retainedOverviewFallbackReason: 'stale',
    retainedOverviewInstanceCount: 3,
    retainedOverviewVisibleInstanceCount: 2,
    retainedOverviewHitBins: [1],
    retainedOverviewPassthroughDrawn: true,
    lastOverviewAggregationEnabled: true,
    lastOverviewPassthroughFeatureCount: 5,
    lastOverviewDensityAtlasBinBp: 8,
    lastOverviewDensityAtlasLevelCount: 2,
    lastOverviewDensityAtlasEstimatedBinCount: 9,
    lastOverviewDensityAtlasWasCoarsened: true,
    lastOverviewDensityAtlasBudgetExceeded: true,
    lastDrawAudit: { id: 'old' } as never,
    retainedOverviewFallback(reason) {
      host.fallbacks.push(reason);
      return false;
    },
    clearDrawState() {
      host.hidden.push('draw');
    },
    resetImmediateDrawStats() {
      host.hidden.push('stats');
    },
    beginDrawAuditIfDiagnosticsEnabled() {
      return { id: 'audit' } as never;
    },
    renderRetainedTranscriptDecorations() {
      host.hidden.push('decorations');
    },
    renderInteractionOutlines() {
      host.hidden.push('outlines');
    },
    noteAnnotationBodyFrameOwner(owner) {
      host.hidden.push(owner);
    },
    ...overrides,
  };
  return host;
}

describe('indexed retained empty viewport', () => {
  it('presents an empty retained frame and hides both linear layers', () => {
    const host = emptyHost();
    expect(presentEmptyRetainedLinearViewport(host, camera(), 'retained', 800, null)).toBe(true);
    expect(host.renderCallCount).toBe(1);
    expect(host.lastRenderMode).toBe('retained');
    expect(host.lastRenderKey).toBe('');
    expect(host.retainedDrawStateClean).toBe(true);
    expect(host.retainedLinearBinCount).toBe(0);
    expect(host.retainedOverviewFallbackReason).toBeNull();
    expect(host.retainedOverviewCameraUpdates).toBe(1);
    expect(host.lastDrawAudit).toEqual({ id: 'audit' });
    expect(host.hidden).toEqual([
      'draw',
      'feature',
      'transcript',
      'stats',
      'decorations',
      'outlines',
      'none',
    ]);
    expect(host.fallbacks).toEqual([]);
  });

  it('falls back to dirty-data when a prebuilt raster owns a wide overview viewport', () => {
    const host = emptyHost();
    expect(
      presentEmptyRetainedLinearViewport(
        host,
        camera(),
        'retained',
        OVERVIEW_GLYPH_TILE_MIN_VISIBLE_BP + 1,
        { hasPrebuilt: () => true }
      )
    ).toBe(false);
    expect(host.fallbacks).toEqual(['dirty-data']);
    expect(host.hidden).toEqual([]);
    expect(host.renderCallCount).toBe(0);

    expect(
      presentEmptyRetainedLinearViewport(
        emptyHost(),
        camera(),
        'retained',
        OVERVIEW_GLYPH_TILE_MIN_VISIBLE_BP,
        { hasPrebuilt: () => true }
      )
    ).toBe(true);
  });
});
