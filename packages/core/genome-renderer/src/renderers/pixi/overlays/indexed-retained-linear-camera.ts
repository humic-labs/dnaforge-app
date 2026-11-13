import type { Feature, RenderState } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import type { RetainedOverlayCameraState } from './overlay-track';
import {
  retainedOverviewAnnotationStyle,
  retainedOverviewAnnotationsEnabled,
} from '../overview/retained-overview-style';
import { planLinearImmediateAnnotationRender } from './linear-lod-policy';
import { isGenomeWideRasterAnnotationOwner } from './annotation-lod-ownership';
import type { AnnotationPrebuiltRasterEligibility } from './annotation-lod-ownership';
import type { RetainedOverviewAnnotationStyle } from './annotation-lod-policy';
import type { OverviewAggregationCache } from './annotation-overview-cache';
import {
  GraphicsPrimitiveSink,
  type FeaturePrimitiveSink,
} from '../overview/feature-primitive-sink';
import type {
  AnnotationDrawAuditDecision,
  AnnotationDrawAuditSnapshot,
} from './annotation-draw-audit';

export const RETAINED_OVERVIEW_BUILD_ONCE_MIN_VISIBLE_BP = 512_000;

export type RetainedLinearCameraHost = {
  compiledBroadSurfaceOwnedLastFrame: boolean;
  prebuiltRasterEligibleForLastFrame: boolean;
  features: Feature[];
  retainedLinearFullSetMeshResident: boolean;
  retainedLinearTranscriptBlockCount: number;
  genomeWideTextureCacheLayer: unknown;
  renderCallCount: number;
  lastRenderMode: string;
  lastRenderKey: string;
  lastRenderKeyParts: unknown;
  lastGeometryRebuildReasons: unknown[];
  lastOverviewAggregationEnabled: boolean;
  lastOverviewPassthroughFeatureCount: number;
  overviewBinDrawCount: number;
  lastOverviewDensityAtlasBinBp: number;
  lastOverviewDensityAtlasLevelCount: number;
  lastOverviewDensityAtlasEstimatedBinCount: number;
  lastOverviewDensityAtlasWasCoarsened: boolean;
  lastOverviewDensityAtlasBudgetExceeded: boolean;
  lastDrawAudit: AnnotationDrawAuditSnapshot | null;
  pixiRenderer: unknown;
  retainedLinearTranscriptLayer: unknown;
  genomeLength: number;
  lastGenomeWideContext: { path: PathMapper; state: RenderState } | null;
  retainedDrawStateClean: boolean;
  immediateDrawStateClearedForRetained: boolean;
  graphics: { visible: boolean };
  lastDrawnFeatureCount: number;
  labelIndex: number;
  labelPool: Array<{ visible: boolean }>;
  retainedOverviewFallback(reason: string): boolean;
  resetAllPresentersToHidden(preserveCommittedCompiledBroadSurface?: boolean): void;
  hideCompiledBroadPresenters?(): void;
  prebuiltRasterEligibility(
    camera: RetainedOverlayCameraState
  ): AnnotationPrebuiltRasterEligibility;
  presentExclusiveAnnotationBodyFrame(
    camera: RetainedOverlayCameraState,
    style: RetainedOverviewAnnotationStyle,
    prebuiltRasterEligibility: AnnotationPrebuiltRasterEligibility,
    priorFrameHadCompleteBroadOwnership: boolean
  ): boolean;
  activeResidentPublicationOwnsAnnotationBodyFallback(): boolean;
  selectResidentAnnotationFeaturesForViewport(
    viewStartBp: number,
    viewEndBp: number,
    annotationSearchFocus?: RenderState['annotationSearchFocus']
  ): { status: string; features: Feature[] } | null;
  retainedLinearSourceFeaturesForViewport(path: PathMapper): Feature[];
  featuresInRange(viewStartBp: number, viewEndBp: number): Feature[];
  hasFeaturesInRange(viewStartBp: number, viewEndBp: number): boolean;
  presentEmptyRetainedLinearViewport(
    camera: RetainedOverlayCameraState,
    style: RetainedOverviewAnnotationStyle,
    overviewVisibleBp: number,
    prebuiltLayer: unknown
  ): boolean;
  resetImmediateDrawStats(): void;
  beginDrawAudit(
    path: PathMapper,
    state: RenderState,
    features: readonly Feature[],
    useOverviewAggregation: boolean,
    forcedStyle: null
  ): AnnotationDrawAuditSnapshot;
  syncRetainedLinearOverviewLayers(
    path: PathMapper,
    state: RenderState,
    sourceShapeCache: OverviewAggregationCache,
    retainedFeatures: readonly Feature[]
  ): Set<Feature> | null;
  clearDrawState(): void;
  renderImmediateFeature(
    sink: FeaturePrimitiveSink,
    feature: Feature,
    path: PathMapper,
    state: RenderState,
    useOverviewAggregation: boolean,
    forceTinyFeatureShapes: boolean
  ): AnnotationDrawAuditDecision;
  recordDrawAuditDecision(
    audit: AnnotationDrawAuditSnapshot,
    feature: Feature,
    decision: AnnotationDrawAuditDecision,
    path: PathMapper
  ): void;
  renderRetainedTranscriptDecorations(
    batchedTranscriptSet: Set<Feature> | null,
    path: PathMapper,
    state: RenderState,
    retainedFeatures: readonly Feature[]
  ): void;
  renderResidentAnnotationLabels(
    features: readonly Feature[],
    path: PathMapper,
    state: RenderState
  ): void;
  finalizeRetainedImmediateLinearFrame(
    camera: RetainedOverlayCameraState,
    style: RetainedOverviewAnnotationStyle
  ): boolean;
};

export function updateRetainedLinearCameraInner(
  host: RetainedLinearCameraHost,
  camera: RetainedOverlayCameraState
): boolean {
  const priorFrameHadCompleteBroadOwnership = host.compiledBroadSurfaceOwnedLastFrame;
  host.compiledBroadSurfaceOwnedLastFrame = false;
  const style = retainedOverviewAnnotationStyle();
  if (!retainedOverviewAnnotationsEnabled()) {
    return host.retainedOverviewFallback('disabled');
  }
  if (style !== 'retained') {
    return host.retainedOverviewFallback('unsupported-visual-state');
  }

  host.resetAllPresentersToHidden(priorFrameHadCompleteBroadOwnership);
  const prebuiltRasterEligibility = host.prebuiltRasterEligibility(camera);
  host.prebuiltRasterEligibleForLastFrame = prebuiltRasterEligibility.eligible;
  const codingDetailSelection = camera.path.cdsZoomPresentation?.bandProgress
    ? host.selectResidentAnnotationFeaturesForViewport(
        camera.path.viewStartBp,
        camera.path.viewEndBp,
        camera.state.annotationSearchFocus
      )
    : null;
  const hasCodingDetail = codingDetailSelection?.status === 'ready';

  if (
    !hasCodingDetail &&
    host.presentExclusiveAnnotationBodyFrame(
      camera,
      style,
      prebuiltRasterEligibility,
      priorFrameHadCompleteBroadOwnership
    )
  ) {
    const residentSelection = host.selectResidentAnnotationFeaturesForViewport(
      camera.path.viewStartBp,
      camera.path.viewEndBp,
      camera.state.annotationSearchFocus
    );
    const labelFeatures =
      residentSelection?.status === 'ready'
        ? residentSelection.features
        : host.featuresInRange(camera.path.viewStartBp, camera.path.viewEndBp);
    host.renderResidentAnnotationLabels(labelFeatures, camera.path, camera.state);
    return true;
  }

  host.hideCompiledBroadPresenters?.();

  const overviewVisibleBp = camera.path.viewEndBp - camera.path.viewStartBp;

  const residentSelection = hasCodingDetail
    ? codingDetailSelection
    : host.features.length === 0 && host.activeResidentPublicationOwnsAnnotationBodyFallback()
      ? host.selectResidentAnnotationFeaturesForViewport(
          camera.path.viewStartBp,
          camera.path.viewEndBp,
          camera.state.annotationSearchFocus
        )
      : null;
  const residentFeatures =
    residentSelection?.status === 'ready' ? residentSelection.features : null;

  const immediatePlan = planLinearImmediateAnnotationRender(camera.path.pixelsPerBp);
  const retainedFeatures =
    residentFeatures ??
    (overviewVisibleBp > RETAINED_OVERVIEW_BUILD_ONCE_MIN_VISIBLE_BP ||
    host.retainedLinearFullSetMeshResident
      ? host.features
      : host.retainedLinearSourceFeaturesForViewport(camera.path));
  let visibleFeaturesCache: readonly Feature[] | null = null;
  const getVisibleFeatures = (): readonly Feature[] =>
    (visibleFeaturesCache ??=
      residentFeatures === null
        ? host.featuresInRange(camera.path.viewStartBp, camera.path.viewEndBp)
        : residentFeatures.filter(
            (feature) =>
              feature.start < camera.path.viewEndBp && feature.end > camera.path.viewStartBp
          ));
  const viewportHasMaterializedFeatures =
    residentFeatures !== null
      ? true
      : host.hasFeaturesInRange(camera.path.viewStartBp, camera.path.viewEndBp);
  const prebuiltLayer = host.genomeWideTextureCacheLayer;

  if (!viewportHasMaterializedFeatures && host.retainedLinearTranscriptBlockCount === 0) {
    return host.presentEmptyRetainedLinearViewport(camera, style, overviewVisibleBp, prebuiltLayer);
  }

  const sourceShapeCache: OverviewAggregationCache = {
    key: 'linear-source-shaped-full-shapes',
    binBp: 0,
    atlasLevelCount: 0,
    bins: [],
    passthroughFeatures: retainedFeatures as Feature[],
    diagnostics: {
      inputFeatureCount: retainedFeatures.length,
      skippedMinVisibleFeatureCount: 0,
      passthroughFeatureCount: retainedFeatures.length,
      aggregateWideFeatureCount: 0,
      aggregatedFeatureCount: 0,
      binContributionCount: 0,
    },
  };
  host.renderCallCount += 1;
  host.lastRenderMode = 'retained';
  host.lastRenderKey = '';
  host.lastRenderKeyParts = null;
  host.lastGeometryRebuildReasons = [];
  host.resetImmediateDrawStats();
  host.lastOverviewAggregationEnabled = false;
  host.lastOverviewPassthroughFeatureCount = retainedFeatures.length;
  host.overviewBinDrawCount = 0;
  host.lastOverviewDensityAtlasBinBp = 0;
  host.lastOverviewDensityAtlasLevelCount = 0;
  host.lastOverviewDensityAtlasEstimatedBinCount = 0;
  host.lastOverviewDensityAtlasWasCoarsened = false;
  host.lastOverviewDensityAtlasBudgetExceeded = false;
  const drawAudit = host.beginDrawAudit(camera.path, camera.state, retainedFeatures, false, null);
  host.lastDrawAudit = drawAudit;
  const batchedTranscriptSet = host.syncRetainedLinearOverviewLayers(
    camera.path,
    camera.state,
    sourceShapeCache,
    retainedFeatures
  );
  if (
    host.pixiRenderer !== null &&
    host.retainedLinearTranscriptLayer !== null &&
    host.retainedLinearTranscriptBlockCount > 0 &&
    isGenomeWideRasterAnnotationOwner({
      genomeLength: host.genomeLength,
      viewStartBp: camera.path.viewStartBp,
      viewEndBp: camera.path.viewEndBp,
    })
  ) {
    host.lastGenomeWideContext = { path: camera.path, state: camera.state };
  }
  const overviewMeshCoversFullSet =
    retainedFeatures === host.features &&
    batchedTranscriptSet !== null &&
    batchedTranscriptSet.size >= host.features.length;
  const allVisibleFeaturesBatched =
    overviewMeshCoversFullSet ||
    (batchedTranscriptSet !== null &&
      getVisibleFeatures().every((feature) => batchedTranscriptSet.has(feature)));
  if (allVisibleFeaturesBatched) {
    if (!host.retainedDrawStateClean) {
      host.clearDrawState();
      host.retainedDrawStateClean = true;
    }
    host.immediateDrawStateClearedForRetained = true;
    drawAudit.decisions['skipped-batched-transcript'] += batchedTranscriptSet?.size ?? 0;
  } else {
    host.clearDrawState();
    host.retainedDrawStateClean = false;
    host.immediateDrawStateClearedForRetained = true;
    host.graphics.visible = true;
    const sink: FeaturePrimitiveSink = new GraphicsPrimitiveSink(
      host.graphics as never,
      camera.path
    );
    for (const feature of getVisibleFeatures()) {
      if (batchedTranscriptSet?.has(feature)) {
        host.recordDrawAuditDecision(drawAudit, feature, 'skipped-batched-transcript', camera.path);
        continue;
      }
      const decision = host.renderImmediateFeature(
        sink,
        feature,
        camera.path,
        camera.state,
        false,
        immediatePlan.forceTinyFeatureShapes
      );
      host.recordDrawAuditDecision(drawAudit, feature, decision, camera.path);
    }
  }
  host.renderRetainedTranscriptDecorations(
    batchedTranscriptSet,
    camera.path,
    camera.state,
    retainedFeatures
  );
  drawAudit.drawnFeatureCount = host.lastDrawnFeatureCount;
  for (let i = host.labelIndex; i < host.labelPool.length; i++) {
    host.labelPool[i].visible = false;
  }
  return host.finalizeRetainedImmediateLinearFrame(camera, style);
}
