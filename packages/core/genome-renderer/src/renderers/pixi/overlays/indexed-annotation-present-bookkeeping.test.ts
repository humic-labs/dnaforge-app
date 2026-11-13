import { describe, expect, it } from 'vitest';
import type { AnnotationDrawAuditSnapshot } from './annotation-draw-audit';
import {
  hideAllPresentationSurfaces,
  resetRenderStats,
  retainedOverviewFallback,
  setPresentationVisible,
  type PresentBookkeepingHost,
} from './indexed-annotation-present-bookkeeping';

function bookkeepingHost(overrides: Partial<PresentBookkeepingHost> = {}): PresentBookkeepingHost {
  const host: PresentBookkeepingHost = {
    presentationVisible: true,
    renderCallCount: 2,
    geometryRebuildCount: 1,
    geometryCacheHitCount: 1,
    lastRenderMode: 'retained',
    lastRenderKey: 'k',
    lastRenderKeyParts: { zoom: '1' },
    lastGeometryRebuildReasons: ['zoom'],
    lastDrawAudit: { id: 'audit' } as unknown as AnnotationDrawAuditSnapshot,
    lastOverviewAggregationEnabled: true,
    lastOverviewAggregationCacheHit: true,
    lastOverviewPassthroughFeatureCount: 3,
    lastOverviewDensityAtlasBinBp: 10,
    lastOverviewDensityAtlasLevelCount: 2,
    lastOverviewDensityAtlasEstimatedBinCount: 4,
    lastOverviewDensityAtlasWasCoarsened: true,
    lastOverviewDensityAtlasBudgetExceeded: true,
    lastOverviewLodCompressionBlend: 0.4,
    lastOverviewLodFullShapeBlend: 0.6,
    lastOverviewCacheMs: 5,
    lastOverviewImmediateBlendMs: 2,
    lastDrawnFeatureCount: 9,
    lastImmediateTranscriptDrawnCount: 2,
    lastImmediateDrawnLayerTypes: new Set(['mRNA']),
    retainedDrawStateClean: false,
    immediateDrawStateClearedForRetained: false,
    retainedOverviewMode: 'retained',
    retainedOverviewStyle: 'retained',
    retainedOverviewCameraUpdates: 0,
    retainedOverviewFallbackRenders: 0,
    retainedOverviewFallbackReason: null,
    retainedOverviewVisibleInstanceCount: 4,
    retainedOverviewHitBins: [1],
    retainedOverviewPassthroughDrawn: true,
    prebuiltRasterEligibleForLastFrame: false,
    genomeLength: 1000,
    features: [],
    graphics: {},
    genomeWideTextureCacheLayer: null,
    retainedOverviewLayer: { hide() {} },
    retainedLinearFeatureLayer: { hide() {} },
    retainedLinearTranscriptLayer: { hide() {} },
    resetImmediateDrawStats() {},
    resetAllPresentersToHidden() {},
    hideAllPresentationSurfaces() {},
    clearDrawState() {},
    clearDecorationCache() {},
    clearImmediateStateForCompiledAnnotationOwner() {},
    beginDrawAuditIfDiagnosticsEnabled() {
      return null;
    },
    renderInteractionOutlines() {},
    renderImmediateFeature() {},
    finalizeCompiledAnnotationBodyPresent() {},
    ...overrides,
  };
  return host;
}

describe('indexed annotation present bookkeeping', () => {
  it('hides presentation surfaces when visibility turns off', () => {
    let hidden = 0;
    const host = bookkeepingHost({
      presentationVisible: true,
      lastDrawAudit: { id: 'stale' } as unknown as AnnotationDrawAuditSnapshot,
      hideAllPresentationSurfaces() {
        hidden += 1;
      },
    });
    setPresentationVisible(host, false);
    expect(host.presentationVisible).toBe(false);
    expect(hidden).toBe(1);
    expect(host.lastDrawAudit).toBeNull();
    setPresentationVisible(host, false);
    expect(hidden).toBe(1);
  });

  it('records a retained-overview fallback and hides retained layers', () => {
    const hidden: string[] = [];
    let presentersHidden = 0;
    let decorationsCleared = 0;
    const host = bookkeepingHost({
      retainedOverviewLayer: {
        hide() {
          hidden.push('overview');
        },
      },
      retainedLinearFeatureLayer: {
        hide() {
          hidden.push('feature');
        },
      },
      retainedLinearTranscriptLayer: {
        hide() {
          hidden.push('transcript');
        },
      },
      resetAllPresentersToHidden() {
        presentersHidden += 1;
      },
      clearDecorationCache() {
        decorationsCleared += 1;
      },
    });
    expect(retainedOverviewFallback(host, 'unsupported-mode')).toBe(false);
    expect(host.retainedOverviewMode).toBe('fallback');
    expect(host.retainedOverviewFallbackRenders).toBe(1);
    expect(host.retainedOverviewFallbackReason).toBe('unsupported-mode');
    expect(host.retainedDrawStateClean).toBe(false);
    expect(hidden).toEqual(['overview', 'feature', 'transcript']);
    expect(presentersHidden).toBe(1);
    expect(decorationsCleared).toBe(1);
  });

  it('resets render stats and hides retained surfaces for a hidden present', () => {
    let cleared = 0;
    const host = bookkeepingHost({
      resetImmediateDrawStats() {
        host.lastDrawnFeatureCount = 0;
        host.lastImmediateTranscriptDrawnCount = 0;
        host.lastImmediateDrawnLayerTypes.clear();
      },
      resetAllPresentersToHidden() {},
      clearDrawState() {
        cleared += 1;
      },
    });
    resetRenderStats(host);
    expect(host.renderCallCount).toBe(0);
    expect(host.lastRenderMode).toBe('none');
    expect(host.lastRenderKeyParts).toBeNull();
    expect(host.lastDrawAudit).toBeNull();
    expect(host.lastDrawnFeatureCount).toBe(0);

    hideAllPresentationSurfaces(host);
    expect(cleared).toBe(1);
    expect(host.retainedDrawStateClean).toBe(true);
    expect(host.immediateDrawStateClearedForRetained).toBe(true);
    expect(host.retainedOverviewMode).toBe('inactive');
    expect(host.retainedOverviewVisibleInstanceCount).toBe(0);
    expect(host.retainedOverviewHitBins).toEqual([]);
  });
});
