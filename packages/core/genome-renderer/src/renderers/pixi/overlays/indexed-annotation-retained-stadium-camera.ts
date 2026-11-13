import type { Feature, RenderState } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import type { RetainedOverlayCameraState, RetainedOverlayFallbackReason } from './overlay-track';
import {
  retainedOverviewAnnotationStyle,
  retainedOverviewAnnotationsEnabled,
  stadiumRetainedCameraParams,
} from '../overview/retained-overview-style';
import {
  OVERVIEW_DENSITY_ATLAS_SAMPLE_SCREEN_PX,
  OVERVIEW_LOD_COMPRESSED_PIXELS_PER_BP,
  planRetainedAnnotationRender,
  type RetainedOverviewAnnotationStyle,
} from './annotation-lod-policy';
import type {
  OverviewAggregationCache,
  RetainedOverviewBodyCache,
} from './annotation-overview-cache';
import type { PrebuiltAnnotationRasterContractMatch } from '../overview/prebuilt-annotation-raster-contract';

const NO_PREBUILT_RASTER_CONTRACT_MATCH: PrebuiltAnnotationRasterContractMatch = Object.freeze({
  contractMatch: false,
  sourceMatch: false,
  placementMatch: false,
  artifactLayerTypes: Object.freeze([]),
  artifactSourceFingerprint: null,
  artifactPlacementFingerprint: null,
});

export type StadiumRetainedCameraHost = {
  prebuiltRasterEligibleForLastFrame: boolean;
  prebuiltRasterContractForLastFrame: PrebuiltAnnotationRasterContractMatch;
  presentationVisible: boolean;
  compiledBroadSurfaceOwnedLastFrame: boolean;
  retainedLinearFeatureLayer: { hide(): void } | null;
  retainedLinearTranscriptLayer: { hide(): void } | null;
  _layout: unknown;
  genomeLength: number;
  features: Feature[];
  lastOverviewCacheMs: number;
  lastOverviewImmediateBlendMs: number;
  lastOverviewLodCompressionBlend: number;
  lastOverviewLodFullShapeBlend: number;
  lastOverviewDensityAtlasBinBp: number;
  lastOverviewDensityAtlasSampleScreenPx: number;
  lastOverviewDensityAtlasLevelCount: number;
  lastOverviewDensityAtlasEstimatedBinCount: number;
  lastOverviewDensityAtlasWasCoarsened: boolean;
  lastOverviewDensityAtlasBudgetExceeded: boolean;
  lastOverviewAggregationCacheHit: boolean;
  lastOverviewAggregationEnabled: boolean;
  lastOverviewPassthroughFeatureCount: number;
  overviewBinDrawCount: number;
  retainedOverviewDataBuilds: number;
  retainedOverviewMode: string;
  retainedOverviewStyle: RetainedOverviewAnnotationStyle;
  retainedOverviewCameraUpdates: number;
  retainedOverviewFallbackReason: RetainedOverlayFallbackReason | null;
  retainedOverviewInstanceCount: number;
  retainedOverviewVisibleInstanceCount: number;
  retainedOverviewHitBins: OverviewAggregationCache['bins'];
  renderCallCount: number;
  lastRenderMode: string;
  lastRenderKey: string;
  lastRenderKeyParts: unknown;
  lastGeometryRebuildReasons: unknown[];
  overviewCache: {
    lastCacheHit: boolean;
    getRetainedOverviewBodyCache(
      input: { pixelsPerBp: number },
      context: unknown
    ): RetainedOverviewBodyCache | null;
    retainedDensityAtlasDiagnostics(): {
      estimatedBinCount: number;
      wasCoarsened: boolean;
      budgetExceeded: boolean;
    };
  };
  renderHiddenPresentation(camera: RetainedOverlayCameraState): boolean;
  updateRetainedLinearCamera(camera: RetainedOverlayCameraState): boolean;
  resetAllPresentersToHidden(): void;
  retainedOverviewFallback(reason: RetainedOverlayFallbackReason): boolean;
  overviewCacheContext(): unknown;
  ensureRetainedOverviewLayer(): {
    syncData(
      key: string,
      bins: OverviewAggregationCache['bins'],
      style: RetainedOverviewAnnotationStyle,
      themeMode: RenderState['themeMode']
    ): boolean;
    updateCamera(camera: unknown): void;
    setAlpha(alpha: number): void;
    retainedInstanceCount: number;
  };
  renderImmediateShapesForLodTransition(
    path: PathMapper,
    state: RenderState,
    features: Feature[],
    alpha: number
  ): void;
  renderInteractionOutlines(path: PathMapper, state: RenderState): void;
};

export function updateRetainedStadiumCamera(
  host: StadiumRetainedCameraHost,
  camera: RetainedOverlayCameraState
): boolean {
  host.prebuiltRasterEligibleForLastFrame = false;
  host.prebuiltRasterContractForLastFrame = NO_PREBUILT_RASTER_CONTRACT_MATCH;
  if (!host.presentationVisible) {
    return host.renderHiddenPresentation(camera);
  }
  if (!camera.path.isArcMode) {
    return host.updateRetainedLinearCamera(camera);
  }

  host.compiledBroadSurfaceOwnedLastFrame = false;
  host.resetAllPresentersToHidden();
  host.retainedLinearFeatureLayer?.hide();
  host.retainedLinearTranscriptLayer?.hide();

  const style = retainedOverviewAnnotationStyle();
  const plan = planRetainedAnnotationRender({
    enabled: retainedOverviewAnnotationsEnabled(),
    style,
    hasLayout: Boolean(host._layout),
    genomeLength: host.genomeLength,
    featureCount: host.features.length,
    isArcMode: camera.path.isArcMode,
    pixelsPerBp: camera.path.pixelsPerBp,
  });
  if (plan.kind === 'fallback') {
    return host.retainedOverviewFallback(plan.reason);
  }

  const retainedCamera = stadiumRetainedCameraParams(camera.path);
  if (!retainedCamera) {
    return host.retainedOverviewFallback('unsupported-mode');
  }

  const compressionBlend = plan.compressionBlend;
  const fullShapeBlend = plan.fullShapeBlend;
  const cacheContext = host.overviewCacheContext();
  host.lastOverviewCacheMs = 0;
  host.lastOverviewImmediateBlendMs = 0;
  host.lastOverviewLodCompressionBlend = compressionBlend;
  host.lastOverviewLodFullShapeBlend = fullShapeBlend;

  const retainedCacheStart = performance.now();
  const retainedCache = host.overviewCache.getRetainedOverviewBodyCache(
    {
      pixelsPerBp: Math.min(camera.path.pixelsPerBp, OVERVIEW_LOD_COMPRESSED_PIXELS_PER_BP),
    },
    cacheContext
  );
  host.lastOverviewCacheMs = performance.now() - retainedCacheStart;
  if (!retainedCache) {
    return host.retainedOverviewFallback('budget-exceeded');
  }
  const retainedAtlasDiagnostics = host.overviewCache.retainedDensityAtlasDiagnostics();
  host.lastOverviewDensityAtlasBinBp = retainedCache.binBp;
  host.lastOverviewDensityAtlasSampleScreenPx = OVERVIEW_DENSITY_ATLAS_SAMPLE_SCREEN_PX;
  host.lastOverviewDensityAtlasLevelCount = retainedCache.atlasLevelCount;
  host.lastOverviewDensityAtlasEstimatedBinCount = retainedAtlasDiagnostics.estimatedBinCount;
  host.lastOverviewDensityAtlasWasCoarsened = retainedAtlasDiagnostics.wasCoarsened;
  host.lastOverviewDensityAtlasBudgetExceeded = retainedAtlasDiagnostics.budgetExceeded;
  host.lastOverviewAggregationCacheHit = host.overviewCache.lastCacheHit;

  const layer = host.ensureRetainedOverviewLayer();
  if (
    layer.syncData(
      `${retainedCache.key}|style:${plan.style}|theme:${camera.state.themeMode ?? 'light'}`,
      retainedCache.bins,
      plan.style,
      camera.state.themeMode
    )
  ) {
    host.retainedOverviewDataBuilds += 1;
  }
  layer.updateCamera(retainedCamera);
  layer.setAlpha(compressionBlend);
  const retainedBlendStart = performance.now();
  host.renderImmediateShapesForLodTransition(
    camera.path,
    camera.state,
    retainedCache.passthroughFeatures,
    0
  );
  host.lastOverviewImmediateBlendMs = performance.now() - retainedBlendStart;

  host.renderCallCount += 1;
  host.lastRenderMode = 'retained';
  host.lastRenderKey = '';
  host.lastRenderKeyParts = null;
  host.lastGeometryRebuildReasons = [];
  host.lastOverviewAggregationEnabled = true;
  host.lastOverviewPassthroughFeatureCount = retainedCache.passthroughFeatures.length;
  host.overviewBinDrawCount = retainedCache.bins.length;
  host.retainedOverviewMode = 'retained';
  host.retainedOverviewStyle = plan.style;
  host.retainedOverviewCameraUpdates += 1;
  host.retainedOverviewFallbackReason = null;
  host.retainedOverviewInstanceCount = layer.retainedInstanceCount;
  host.retainedOverviewVisibleInstanceCount = layer.retainedInstanceCount;
  host.retainedOverviewHitBins = retainedCache.bins;
  host.renderInteractionOutlines(camera.path, camera.state);
  return true;
}
