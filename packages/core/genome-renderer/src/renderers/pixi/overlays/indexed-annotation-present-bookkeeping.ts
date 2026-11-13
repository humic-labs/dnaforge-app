import type { Feature, RenderState } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import type { RetainedOverlayCameraState, RetainedOverlayFallbackReason } from './overlay-track';
import type { RetainedOverviewAnnotationStyle } from './annotation-lod-policy';
import type { AnnotationDrawAuditSnapshot } from './annotation-draw-audit';
import type { OverviewBin } from './annotation-overview-cache';
import {
  GraphicsPrimitiveSink,
  type FeaturePrimitiveSink,
} from '../overview/feature-primitive-sink';
import { linearViewerRenderContract } from '../overview/viewer-render-contract';
import { retainedOverviewAnnotationStyle } from '../overview/retained-overview-style';
import { OVERVIEW_GLYPH_TILE_MIN_VISIBLE_BP } from './indexed-annotation-body-owner';

export type PresentBookkeepingHost = {
  presentationVisible: boolean;
  renderCallCount: number;
  geometryRebuildCount: number;
  geometryCacheHitCount: number;
  lastRenderMode: string;
  lastRenderKey: string;
  lastRenderKeyParts: unknown;
  lastGeometryRebuildReasons: unknown[];
  lastDrawAudit: AnnotationDrawAuditSnapshot | null;
  lastOverviewAggregationEnabled: boolean;
  lastOverviewAggregationCacheHit: boolean;
  lastOverviewPassthroughFeatureCount: number;
  lastOverviewDensityAtlasBinBp: number;
  lastOverviewDensityAtlasLevelCount: number;
  lastOverviewDensityAtlasEstimatedBinCount: number;
  lastOverviewDensityAtlasWasCoarsened: boolean;
  lastOverviewDensityAtlasBudgetExceeded: boolean;
  lastOverviewLodCompressionBlend: number;
  lastOverviewLodFullShapeBlend: number;
  lastOverviewCacheMs: number;
  lastOverviewImmediateBlendMs: number;
  lastDrawnFeatureCount: number;
  lastImmediateTranscriptDrawnCount: number;
  lastImmediateDrawnLayerTypes: Set<string>;
  retainedDrawStateClean: boolean;
  immediateDrawStateClearedForRetained: boolean;
  retainedOverviewMode: string;
  retainedOverviewStyle: RetainedOverviewAnnotationStyle | string;
  retainedOverviewCameraUpdates: number;
  retainedOverviewFallbackRenders: number;
  retainedOverviewFallbackReason: unknown;
  retainedOverviewVisibleInstanceCount: number;
  retainedOverviewHitBins: unknown[];
  retainedOverviewPassthroughDrawn: boolean;
  prebuiltRasterEligibleForLastFrame: boolean;
  genomeLength: number;
  features: Feature[];
  graphics: unknown;
  genomeWideTextureCacheLayer: {
    hasPrebuilt(): boolean;
    compositePrebuilt(contract: unknown): boolean;
  } | null;
  retainedOverviewLayer: { hide(): void } | null;
  retainedLinearFeatureLayer: { hide(): void } | null;
  retainedLinearTranscriptLayer: { hide(): void } | null;
  resetImmediateDrawStats(): void;
  resetAllPresentersToHidden(): void;
  hideAllPresentationSurfaces(): void;
  clearDrawState(): void;
  clearDecorationCache(): void;
  clearImmediateStateForCompiledAnnotationOwner(): void;
  beginDrawAuditIfDiagnosticsEnabled(
    path: PathMapper,
    state: RenderState,
    featuresToRender: readonly Feature[],
    useOverviewAggregation: boolean,
    overviewCache: {
      binBp: number;
      bins: OverviewBin[];
      passthroughFeatures: Feature[];
      diagnostics: {
        inputFeatureCount: number;
        skippedMinVisibleFeatureCount: number;
        aggregateWideFeatureCount: number;
        aggregatedFeatureCount: number;
        binContributionCount: number;
      };
    } | null
  ): AnnotationDrawAuditSnapshot | null;
  renderInteractionOutlines(path: PathMapper, state: RenderState): void;
  renderImmediateFeature(
    sink: FeaturePrimitiveSink,
    feature: Feature,
    path: PathMapper,
    state: RenderState,
    useOverviewAggregation: boolean,
    forceTinyFeatureShapes: boolean,
    alphaScale: number
  ): void;
  finalizeCompiledAnnotationBodyPresent(
    camera: RetainedOverlayCameraState,
    style: RetainedOverviewAnnotationStyle
  ): void;
};

export function setPresentationVisible(host: PresentBookkeepingHost, visible: boolean): void {
  if (host.presentationVisible === visible) return;
  host.presentationVisible = visible;
  if (!visible) {
    host.hideAllPresentationSurfaces();
    host.lastDrawAudit = null;
  }
}

export function resetRenderStats(host: PresentBookkeepingHost): void {
  host.renderCallCount = 0;
  host.geometryRebuildCount = 0;
  host.geometryCacheHitCount = 0;
  host.lastRenderMode = 'none';
  host.lastRenderKeyParts = null;
  host.lastGeometryRebuildReasons = [];
  host.lastDrawAudit = null;
  host.resetImmediateDrawStats();
  host.lastOverviewAggregationEnabled = false;
  host.lastOverviewAggregationCacheHit = false;
  host.lastOverviewPassthroughFeatureCount = 0;
  host.lastOverviewDensityAtlasBinBp = 0;
  host.lastOverviewDensityAtlasLevelCount = 0;
  host.lastOverviewDensityAtlasEstimatedBinCount = 0;
  host.lastOverviewDensityAtlasWasCoarsened = false;
  host.lastOverviewDensityAtlasBudgetExceeded = false;
  host.lastOverviewLodCompressionBlend = 0;
  host.lastOverviewLodFullShapeBlend = 1;
  host.lastOverviewCacheMs = 0;
  host.lastOverviewImmediateBlendMs = 0;
}

export function resetImmediateDrawStats(host: PresentBookkeepingHost): void {
  host.lastDrawnFeatureCount = 0;
  host.lastImmediateTranscriptDrawnCount = 0;
  host.lastImmediateDrawnLayerTypes.clear();
}

export function hideAllPresentationSurfaces(host: PresentBookkeepingHost): void {
  host.resetAllPresentersToHidden();
  host.retainedOverviewLayer?.hide();
  host.retainedLinearFeatureLayer?.hide();
  host.retainedLinearTranscriptLayer?.hide();
  host.clearDrawState();
  host.retainedDrawStateClean = true;
  host.immediateDrawStateClearedForRetained = true;
  host.resetImmediateDrawStats();
  host.lastOverviewAggregationEnabled = false;
  host.lastOverviewPassthroughFeatureCount = 0;
  host.retainedOverviewMode = 'inactive';
  host.retainedOverviewVisibleInstanceCount = 0;
  host.retainedOverviewHitBins = [];
  host.retainedOverviewPassthroughDrawn = false;
}

export function renderHiddenPresentation(
  host: PresentBookkeepingHost,
  camera: RetainedOverlayCameraState
): boolean {
  host.hideAllPresentationSurfaces();
  host.renderCallCount += 1;
  host.lastRenderMode = 'retained';
  host.lastRenderKey = '';
  host.lastRenderKeyParts = null;
  host.lastGeometryRebuildReasons = [];
  host.lastDrawAudit = host.beginDrawAuditIfDiagnosticsEnabled(
    camera.path,
    camera.state,
    [],
    false,
    null
  );
  host.renderInteractionOutlines(camera.path, camera.state);
  return true;
}

export function retainedOverviewFallback(
  host: PresentBookkeepingHost,
  reason: RetainedOverlayFallbackReason
): false {
  host.retainedOverviewMode = 'fallback';
  host.retainedOverviewFallbackRenders += 1;
  host.retainedOverviewFallbackReason = reason;
  host.retainedOverviewStyle = retainedOverviewAnnotationStyle();
  host.retainedOverviewVisibleInstanceCount = 0;
  host.lastOverviewLodCompressionBlend = 0;
  host.lastOverviewLodFullShapeBlend = 1;
  host.lastOverviewCacheMs = 0;
  host.lastOverviewImmediateBlendMs = 0;
  host.retainedOverviewHitBins = [];
  host.retainedOverviewPassthroughDrawn = false;
  host.retainedDrawStateClean = false;
  host.resetAllPresentersToHidden();
  host.retainedOverviewLayer?.hide();
  host.retainedLinearFeatureLayer?.hide();
  host.retainedLinearTranscriptLayer?.hide();
  host.clearDecorationCache();
  return false;
}

export function clearImmediateStateForCompiledAnnotationOwner(host: PresentBookkeepingHost): void {
  host.clearDecorationCache();
  if (!host.retainedDrawStateClean) {
    host.clearDrawState();
    host.retainedDrawStateClean = true;
  }
  host.immediateDrawStateClearedForRetained = true;
  host.resetImmediateDrawStats();
}

export function sealCompiledBroadPresentedFrame(
  host: PresentBookkeepingHost,
  camera: RetainedOverlayCameraState,
  options: { clearImmediate: boolean }
): true {
  host.prebuiltRasterEligibleForLastFrame = true;
  host.lastDrawAudit = host.beginDrawAuditIfDiagnosticsEnabled(
    camera.path,
    camera.state,
    [],
    false,
    null
  );
  if (options.clearImmediate) host.clearImmediateStateForCompiledAnnotationOwner();
  host.renderCallCount += 1;
  host.lastRenderMode = 'retained';
  host.lastRenderKey = '';
  host.lastRenderKeyParts = null;
  host.lastGeometryRebuildReasons = [];
  host.retainedOverviewMode = 'retained';
  host.retainedOverviewStyle = 'retained';
  host.retainedOverviewCameraUpdates += 1;
  host.retainedOverviewFallbackReason = null;
  host.renderInteractionOutlines(camera.path, camera.state);
  return true;
}

export function finalizeCompiledAnnotationBodyPresent(
  host: PresentBookkeepingHost,
  camera: RetainedOverlayCameraState,
  style: RetainedOverviewAnnotationStyle
): void {
  host.clearImmediateStateForCompiledAnnotationOwner();
  host.renderCallCount += 1;
  host.lastRenderMode = 'retained';
  host.lastRenderKey = '';
  host.lastRenderKeyParts = null;
  host.lastGeometryRebuildReasons = [];
  host.retainedOverviewMode = 'retained';
  host.retainedOverviewStyle = style;
  host.retainedOverviewCameraUpdates += 1;
  host.retainedOverviewFallbackReason = null;
  host.renderInteractionOutlines(camera.path, camera.state);
}

export function tryPresentPrebuiltRasterBody(
  host: PresentBookkeepingHost,
  camera: RetainedOverlayCameraState,
  style: RetainedOverviewAnnotationStyle,
  prebuiltRasterEligibility: { eligible: boolean }
): boolean {
  const prebuiltLayer = host.genomeWideTextureCacheLayer;
  if (!prebuiltLayer?.hasPrebuilt() || host.genomeLength <= 0) return false;
  const overviewVisibleBp = camera.path.viewEndBp - camera.path.viewStartBp;
  const rasterOwnsOverview =
    prebuiltRasterEligibility.eligible && overviewVisibleBp > OVERVIEW_GLYPH_TILE_MIN_VISIBLE_BP;
  if (
    !rasterOwnsOverview ||
    !prebuiltLayer.compositePrebuilt(linearViewerRenderContract(camera.path))
  ) {
    return false;
  }
  host.resetImmediateDrawStats();
  host.lastDrawAudit = host.beginDrawAuditIfDiagnosticsEnabled(
    camera.path,
    camera.state,
    [],
    false,
    null
  );
  host.finalizeCompiledAnnotationBodyPresent(camera, style);
  return true;
}

export function renderImmediateShapesForLodTransition(
  host: PresentBookkeepingHost,
  path: PathMapper,
  state: RenderState,
  passthroughFeatures: Feature[],
  fullShapeBlend: number
): void {
  const passthroughIds = new Set(passthroughFeatures.map((feature) => feature.id));
  host.clearDrawState();
  host.immediateDrawStateClearedForRetained = true;
  host.resetImmediateDrawStats();
  const sink: FeaturePrimitiveSink = new GraphicsPrimitiveSink(host.graphics as never, path);

  if (fullShapeBlend > 0.001) {
    for (const feature of host.features) {
      if (passthroughIds.has(feature.id)) continue;
      host.renderImmediateFeature(sink, feature, path, state, false, false, fullShapeBlend);
    }
  }

  for (const feature of passthroughFeatures) {
    host.renderImmediateFeature(sink, feature, path, state, false, false, 1);
  }

  host.retainedOverviewPassthroughDrawn = passthroughFeatures.length > 0 || fullShapeBlend > 0.001;
}
