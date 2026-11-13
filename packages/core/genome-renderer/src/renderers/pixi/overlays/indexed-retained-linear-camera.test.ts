import { afterEach, describe, expect, it } from 'vitest';
import type { Feature, RenderState } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import type { AnnotationPrebuiltRasterEligibility } from './annotation-lod-ownership';
import {
  updateRetainedLinearCameraInner,
  type RetainedLinearCameraHost,
} from './indexed-retained-linear-camera';
import type { RetainedOverlayCameraState } from './overlay-track';

type OverviewGlobal = typeof globalThis & {
  __WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS?: boolean;
  __WAYPOINT_WEBGL_OVERVIEW_ANNOTATION_STYLE?: string;
};

const ineligible: AnnotationPrebuiltRasterEligibility = {
  eligible: false,
  reason: 'unavailable',
  genomeFraction: 0,
  fillKneeSatisfied: false,
  physicalSamplingSatisfied: false,
};

afterEach(() => {
  delete (globalThis as OverviewGlobal).__WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS;
  delete (globalThis as OverviewGlobal).__WAYPOINT_WEBGL_OVERVIEW_ANNOTATION_STYLE;
});

function camera(viewStartBp = 0, viewEndBp = 800): RetainedOverlayCameraState {
  return {
    path: { viewStartBp, viewEndBp, pixelsPerBp: 1 } as PathMapper,
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

function cameraHost(
  overrides: Partial<RetainedLinearCameraHost> = {}
): RetainedLinearCameraHost & { calls: string[] } {
  const host: RetainedLinearCameraHost & { calls: string[] } = {
    calls: [],
    compiledBroadSurfaceOwnedLastFrame: true,
    prebuiltRasterEligibleForLastFrame: false,
    features: [],
    retainedLinearFullSetMeshResident: false,
    retainedLinearTranscriptBlockCount: 0,
    genomeWideTextureCacheLayer: null,
    renderCallCount: 0,
    lastRenderMode: 'none',
    lastRenderKey: '',
    lastRenderKeyParts: null,
    lastGeometryRebuildReasons: [],
    lastOverviewAggregationEnabled: false,
    lastOverviewPassthroughFeatureCount: 0,
    overviewBinDrawCount: 0,
    lastOverviewDensityAtlasBinBp: 0,
    lastOverviewDensityAtlasLevelCount: 0,
    lastOverviewDensityAtlasEstimatedBinCount: 0,
    lastOverviewDensityAtlasWasCoarsened: false,
    lastOverviewDensityAtlasBudgetExceeded: false,
    lastDrawAudit: null,
    pixiRenderer: null,
    retainedLinearTranscriptLayer: null,
    genomeLength: 10_000,
    lastGenomeWideContext: null,
    retainedDrawStateClean: true,
    immediateDrawStateClearedForRetained: false,
    graphics: { visible: false },
    lastDrawnFeatureCount: 0,
    labelIndex: 0,
    labelPool: [],
    retainedOverviewFallback(reason) {
      host.calls.push(`fallback:${reason}`);
      return false;
    },
    resetAllPresentersToHidden() {
      host.calls.push('hide');
    },
    prebuiltRasterEligibility() {
      host.calls.push('eligibility');
      return ineligible;
    },
    presentExclusiveAnnotationBodyFrame() {
      host.calls.push('exclusive');
      return false;
    },
    activeResidentPublicationOwnsAnnotationBodyFallback: () => false,
    selectResidentAnnotationFeaturesForViewport() {
      host.calls.push('resident');
      return null;
    },
    retainedLinearSourceFeaturesForViewport() {
      host.calls.push('source-window');
      return [];
    },
    featuresInRange() {
      return [];
    },
    hasFeaturesInRange() {
      return false;
    },
    presentEmptyRetainedLinearViewport() {
      host.calls.push('empty');
      return true;
    },
    resetImmediateDrawStats() {},
    beginDrawAudit() {
      return { decisions: {} } as never;
    },
    syncRetainedLinearOverviewLayers() {
      host.calls.push('sync');
      return null;
    },
    clearDrawState() {},
    renderImmediateFeature() {
      return 'drawn';
    },
    recordDrawAuditDecision() {},
    renderRetainedTranscriptDecorations() {},
    renderResidentAnnotationLabels() {
      host.calls.push('labels');
    },
    finalizeRetainedImmediateLinearFrame() {
      host.calls.push('finalize');
      return true;
    },
    ...overrides,
  };
  return host;
}

describe('indexed retained linear camera', () => {
  it('lets an exclusive body owner win after the default-deny hide', () => {
    const host = cameraHost({
      presentExclusiveAnnotationBodyFrame() {
        host.calls.push('exclusive');
        return true;
      },
    });
    expect(updateRetainedLinearCameraInner(host, camera())).toBe(true);
    expect(host.compiledBroadSurfaceOwnedLastFrame).toBe(false);
    expect(host.prebuiltRasterEligibleForLastFrame).toBe(false);
    expect(host.calls).toEqual(['hide', 'eligibility', 'exclusive', 'resident', 'labels']);
  });

  it('falls back when retained overview is disabled and presents empty when the viewport has no geometry', () => {
    (globalThis as OverviewGlobal).__WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS = false;
    const disabled = cameraHost();
    expect(updateRetainedLinearCameraInner(disabled, camera())).toBe(false);
    expect(disabled.calls).toEqual(['fallback:disabled']);

    delete (globalThis as OverviewGlobal).__WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS;
    const empty = cameraHost();
    expect(updateRetainedLinearCameraInner(empty, camera())).toBe(true);
    expect(empty.calls).toEqual(['hide', 'eligibility', 'exclusive', 'source-window', 'empty']);

    const featured = cameraHost({
      features: [
        {
          id: 1,
          type: 'gene',
          start: 0,
          end: 10,
          direction: 'forward',
          color: 0,
          lane: 0,
          displayName: 'g',
        } satisfies Feature,
      ],
      hasFeaturesInRange: () => true,
      featuresInRange: () => [],
      retainedLinearTranscriptBlockCount: 2,
      syncRetainedLinearOverviewLayers() {
        featured.calls.push('sync');
        return new Set();
      },
    });
    expect(updateRetainedLinearCameraInner(featured, camera())).toBe(true);
    expect(featured.calls).toContain('sync');
    expect(featured.calls).toContain('finalize');
    expect(featured.calls).not.toContain('empty');
  });
});
