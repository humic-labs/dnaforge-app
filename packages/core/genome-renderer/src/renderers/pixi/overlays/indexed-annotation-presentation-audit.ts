import type { Feature, RenderState } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import type { UnifiedLayout } from '../shared/track-layout';
import type { AnnotationFrameRenderMode } from './annotation-render-mode';
import {
  buildAnnotationDrawAudit,
  recordAnnotationDrawAuditDecision,
  type AnnotationDrawAuditDecision,
  type AnnotationDrawAuditSnapshot,
} from './annotation-draw-audit';
import { isWebGLDiagnosticsEnabled } from '../../../diagnostics-gate';
import { RETAINED_TRANSCRIPT_KEY_CACHE_MIN_FEATURES } from './indexed-annotation-retained-source-window';
import { featurePixelWidth, type OverlayLayoutHost } from './indexed-annotation-layout';
import { compiledBroadSurfaceRequirementOwnsCamera } from './annotation-compiled-broad-address';
import {
  buildAnnotationPresentationDebug,
  type AnnotationPresentationDebugSnapshot,
} from './annotation-presentation-debug';
import {
  appendAnnotationOwnerAuditFrame,
  annotationOwnerAuditFrameFromPresentation,
  sampleFineViewPrewarmForOwnerAudit,
  type AnnotationOwnerAuditRing,
} from './annotation-owner-audit';

import type { CompiledBroadSurfaceRequirementV1 } from './indexed-compiled-broad-requirement';

export type PresentationAuditHost = {
  presentationVisible: boolean;
  genomeLength: number;
  lastDrawAudit: AnnotationDrawAuditSnapshot | null;
  prebuiltRasterEligibleForLastFrame: boolean;
  prebuiltRasterContractForLastFrame: { artifactLayerTypes: readonly string[] };
  lastDrawnFeatureCount: number;
  lastImmediateDrawnLayerTypes: Set<string>;
  lastImmediateTranscriptDrawnCount: number;
  lastFrameDoubleDraw: boolean;
  retainedLinearBinCount: number;
  prepackedAnnotationSceneVisiblePartitionCount: number;
  prepackedAnnotationSceneVisibleInstanceCount: number;
  compiledBroadSurfacePlanStatus: string;
  prepackedAnnotationSceneFinePendingReason: string | null;
  prepackedAnnotationSceneStatus: string;
  graphics: { visible: boolean };
  sidecarRaster: { isPresenting: boolean; visibleTrackTypes: readonly string[] };
  genomeWideTextureCacheLayer: {
    runtimeTexturePresenting?: boolean;
    prebuiltTexturePresenting?: boolean;
  } | null;
  retainedLinearFeatureLayer: { isPresenting: boolean } | null;
  retainedLinearTranscriptLayer: { isPresenting: boolean; retainedBlockCount: number } | null;
  tilePyramidVectorCompositor: {
    visibleLayerCount: number;
    isPresenting: boolean;
    presentingBlockCount: number;
    coverageLevel: number | null;
    visibleTileFirst: number | null;
    visibleTileLast: number | null;
    expectedVisibleTileCount: number;
    builtVisibleTileCount: number;
    missingVisibleTileCount: number;
    coverageComplete: boolean;
  } | null;
  rttGlyphTilePyramidCompositor: { isPresenting: boolean; visibleLayerCount: number } | null;
  prepackedAnnotationSceneResidents: { size: number };
  prepackedAnnotationSceneLastCompleteOwnerKeys: readonly string[];
  prepackedAnnotationSceneReplacementCandidates: {
    readonly size: number;
    values(): Iterable<{
      input?: { viewportDetail?: { coverageStartBp?: number; coverageEndBp?: number } | null };
      viewportDetailPresentationAdmitted?: boolean;
      layer?: {
        hide?(): void;
        areFineViewsPrewarmed?(startBp: number, endBp: number): boolean;
      };
    }>;
  };
  compiledBroadSurfaceLastPresentationCamera: { themeMode?: RenderState['themeMode'] } | null;
  prepackedAnnotationSceneOwnerMetadata: { themeMode?: RenderState['themeMode'] } | null;
  compiledBroadSurfaceLastCameraRequest: {
    viewportStartBp: number;
    viewportEndBp: number;
    viewportCssWidthPx: number;
    devicePixelRatio: number;
  } | null;
  compiledBroadSurfaceRequirement: CompiledBroadSurfaceRequirementV1 | null;
  annotationLayerTypesForPresentation(): string[];
  compiledBroadSurfacePresentingLayerTypes(): string[];
  prepackedAnnotationScenePresentingResidents(): Array<{ metadata: { trackType: string } }>;
  compiledBroadSurfaceOwnerForTrack(trackType: string): {
    presenter: {
      isPresenting: boolean;
      missingCellCount: number;
      holdingLastGood: boolean;
    };
    manifest: unknown;
    provenance: unknown;
  } | null;
  compiledBroadSurfaceProvenanceIsCurrent(manifest: unknown, provenance: unknown): boolean;
  buildPresentationDebugSnapshot(): AnnotationPresentationDebugSnapshot;
};

export function buildPresentationDebugSnapshot(
  host: PresentationAuditHost
): AnnotationPresentationDebugSnapshot {
  const compiledBroadRasterLayerTypes = host.compiledBroadSurfacePresentingLayerTypes();
  const compiledBroadRasterVisible =
    host.presentationVisible && compiledBroadRasterLayerTypes.length > 0;
  const sidecarTrackRasterVisible = host.presentationVisible && host.sidecarRaster.isPresenting;
  const sidecarTrackRasterLayerTypes = [
    ...(compiledBroadRasterVisible ? compiledBroadRasterLayerTypes : []),
    ...host.sidecarRaster.visibleTrackTypes,
  ].filter((layerType, index, layerTypes) => layerTypes.indexOf(layerType) === index);
  const requestedLayerTypes = host.annotationLayerTypesForPresentation();
  const presentingPrepackedLayerTypes = host
    .prepackedAnnotationScenePresentingResidents()
    .map(({ metadata }) => metadata.trackType);
  const prepackedSetPresenting = presentingPrepackedLayerTypes.length > 0;
  return buildAnnotationPresentationDebug({
    requestedLayerTypes,
    renderSetLayerTypes: host.lastDrawAudit?.renderSetLayerTypes ?? null,
    presentationVisible: host.presentationVisible,
    genomeLength: host.genomeLength,
    lastDrawAuditRange: host.lastDrawAudit
      ? {
          viewStartBp: host.lastDrawAudit.viewStartBp,
          viewEndBp: host.lastDrawAudit.viewEndBp,
        }
      : null,
    runtimeGenomeWideTextureVisible:
      host.genomeWideTextureCacheLayer?.runtimeTexturePresenting ?? false,
    prebuiltGenomeWideTextureVisible:
      host.genomeWideTextureCacheLayer?.prebuiltTexturePresenting ?? false,
    prebuiltGenomeWideTextureEligible: host.prebuiltRasterEligibleForLastFrame,
    prebuiltGenomeWideTextureLayerTypes: host.prebuiltRasterContractForLastFrame.artifactLayerTypes,
    compiledBroadRasterVisible,
    compiledBroadRasterLayerTypes,
    compiledBroadRasterCoverageComplete: compiledBroadRasterLayerTypes.every((trackType) => {
      const owner = host.compiledBroadSurfaceOwnerForTrack(trackType);
      return Boolean(
        owner &&
        owner.presenter.isPresenting &&
        host.compiledBroadSurfaceProvenanceIsCurrent(owner.manifest, owner.provenance) &&
        (owner.presenter.missingCellCount === 0 || owner.presenter.holdingLastGood)
      );
    }),
    sidecarTrackRasterVisible,
    sidecarTrackRasterLayerTypes,
    sidecarTrackRasterCoverageComplete: sidecarTrackRasterVisible,
    retainedLinearVisibleMeshCount: host.retainedLinearFeatureLayer?.isPresenting
      ? host.retainedLinearBinCount
      : 0,
    retainedTranscriptVisibleBlockCount: host.retainedLinearTranscriptLayer?.isPresenting
      ? host.retainedLinearTranscriptLayer.retainedBlockCount
      : 0,
    tilePyramidVectorVisibleLayerCount: host.tilePyramidVectorCompositor?.visibleLayerCount ?? 0,
    tilePyramidVectorPresenting: host.tilePyramidVectorCompositor?.isPresenting ?? false,
    tilePyramidVectorPresentingBlockCount:
      host.tilePyramidVectorCompositor?.presentingBlockCount ?? 0,
    tilePyramidVectorCoverageLevel: host.tilePyramidVectorCompositor?.coverageLevel ?? null,
    tilePyramidVectorVisibleTileFirst: host.tilePyramidVectorCompositor?.visibleTileFirst ?? null,
    tilePyramidVectorVisibleTileLast: host.tilePyramidVectorCompositor?.visibleTileLast ?? null,
    tilePyramidVectorExpectedVisibleTileCount:
      host.tilePyramidVectorCompositor?.expectedVisibleTileCount ?? 0,
    tilePyramidVectorBuiltVisibleTileCount:
      host.tilePyramidVectorCompositor?.builtVisibleTileCount ?? 0,
    tilePyramidVectorMissingVisibleTileCount:
      host.tilePyramidVectorCompositor?.missingVisibleTileCount ?? 0,
    tilePyramidVectorCoverageComplete: host.tilePyramidVectorCompositor?.coverageComplete ?? false,
    overviewGlyphTilesPresenting: host.rttGlyphTilePyramidCompositor?.isPresenting ?? false,
    overviewGlyphTilesVisibleTileCount: host.rttGlyphTilePyramidCompositor?.visibleLayerCount ?? 0,
    overviewGlyphTilesCoverageComplete: host.rttGlyphTilePyramidCompositor?.isPresenting ?? false,
    prepackedTranscriptPresenting: prepackedSetPresenting,
    prepackedTranscriptLayerTypes: presentingPrepackedLayerTypes,
    prepackedTranscriptSubmittedPartitionCount: host.prepackedAnnotationSceneVisiblePartitionCount,
    prepackedTranscriptSubmittedInstanceCount: host.prepackedAnnotationSceneVisibleInstanceCount,
    immediateGraphicsVisible: host.graphics.visible,
    lastDrawnFeatureCount: host.lastDrawnFeatureCount,
    immediateDrawnLayerTypes: [...host.lastImmediateDrawnLayerTypes].sort((a, b) =>
      a.localeCompare(b)
    ),
  });
}

export function auditAnnotationDraw(host: PresentationAuditHost, state: RenderState): void {
  if (!isWebGLDiagnosticsEnabled()) {
    host.lastFrameDoubleDraw = false;
    return;
  }

  const g = globalThis as typeof globalThis & {
    __dna708OwnerAudit?: AnnotationOwnerAuditRing;
  };
  const ring = g.__dna708OwnerAudit;
  if (!ring || ring.enabled !== true) {
    host.lastFrameDoubleDraw = false;
    return;
  }

  const immediateOn = host.graphics.visible && host.lastImmediateTranscriptDrawnCount > 0;
  const firstReplacementCandidate =
    Array.from(host.prepackedAnnotationSceneReplacementCandidates.values())[0] ?? null;
  const replacementDetail = firstReplacementCandidate?.input?.viewportDetail ?? null;
  const cameraStartBp = host.lastDrawAudit?.viewStartBp ?? Number.NaN;
  const cameraEndBp = host.lastDrawAudit?.viewEndBp ?? Number.NaN;
  const frame = annotationOwnerAuditFrameFromPresentation(host.buildPresentationDebugSnapshot(), {
    presentedAtMs: performance.now(),
    themeMode:
      host.compiledBroadSurfaceLastPresentationCamera?.themeMode ??
      host.prepackedAnnotationSceneOwnerMetadata?.themeMode ??
      'light',
    hoveredFeatureId: state.hoveredId,
    immediatePresenting: immediateOn,
    immediateDrawnCount: host.lastDrawnFeatureCount,
    immediateTranscriptDrawnCount: host.lastImmediateTranscriptDrawnCount,
    cameraStartBp,
    cameraEndBp,
    compiledBroadCameraOwned:
      host.compiledBroadSurfaceLastCameraRequest && host.compiledBroadSurfaceRequirement
        ? compiledBroadSurfaceRequirementOwnsCamera({
            requirement: host.compiledBroadSurfaceRequirement,
            ...host.compiledBroadSurfaceLastCameraRequest,
          })
        : null,
    compiledBroadPlanStatus: host.compiledBroadSurfacePlanStatus,
    prepackedFinePendingReason: host.prepackedAnnotationSceneFinePendingReason,
    prepackedSceneStatus: host.prepackedAnnotationSceneStatus,
    prepackedResidentOwnerCount: host.prepackedAnnotationSceneResidents.size,
    prepackedLastCompleteOwnerCount: host.prepackedAnnotationSceneLastCompleteOwnerKeys.length,
    prepackedReplacementCandidateCount: host.prepackedAnnotationSceneReplacementCandidates.size,
    prepackedReplacementCoverageStartBp: replacementDetail?.coverageStartBp ?? null,
    prepackedReplacementCoverageEndBp: replacementDetail?.coverageEndBp ?? null,
    prepackedReplacementPresentationAdmitted:
      firstReplacementCandidate?.viewportDetailPresentationAdmitted ?? null,
    prepackedReplacementFineViewsPrewarmed: firstReplacementCandidate
      ? sampleFineViewPrewarmForOwnerAudit({
          cameraStartBp,
          cameraEndBp,
          genomeLengthBp: host.genomeLength,
          sample: (startBp, endBp) =>
            firstReplacementCandidate.layer?.areFineViewsPrewarmed?.(startBp, endBp) === true,
        })
      : null,
  });
  appendAnnotationOwnerAuditFrame(ring, frame);

  if (frame.doubleDraw && !host.lastFrameDoubleDraw) {
    ring.violations = (ring.violations ?? 0) + 1;
    // eslint-disable-next-line no-console
    console.error(
      `[ DOUBLE-DRAW] multiple annotation owners presenting simultaneously: ` +
        `${frame.presenting.join(' + ')} (${frame.ownerViolations.join('; ')}). ` +
        `The live transcript mesh must be the single owner or yield entirely to the ` +
        `vector compositor/raster overview — never both. This is the ` +
        `"features not cleared" / multiple-sources-of-truth regression.`
    );
  }
  host.lastFrameDoubleDraw = frame.doubleDraw;
}

export type BeginDrawAuditHost = {
  drawAuditFrameId: number;
  lastRenderMode: AnnotationFrameRenderMode;
  features: { readonly length: number };
  renderSetLayerTypesForAudit(featuresToRender: readonly Feature[]): readonly string[];
  maxAnnotationLane: number;
  maxCdsLane: number;
  _layout: UnifiedLayout | null;
  lastOverviewAggregationCacheHit: boolean;
  lastOverviewDensityAtlasBudgetExceeded: boolean;
};

export function beginDrawAuditIfDiagnosticsEnabled(
  host: BeginDrawAuditHost,
  path: PathMapper,
  state: RenderState,
  featuresToRender: readonly Feature[],
  useOverviewAggregation: boolean,
  overviewCache: Parameters<typeof beginDrawAudit>[5]
): AnnotationDrawAuditSnapshot | null {
  if (!isWebGLDiagnosticsEnabled()) return null;
  return beginDrawAudit(host, path, state, featuresToRender, useOverviewAggregation, overviewCache);
}

export function renderSetLayerTypesForAudit(
  host: {
    annotationLayerTypesForPresentation(): string[];
  },
  featuresToRender: readonly Feature[],
  normalizeAnnotationLayerTypes: (types: string[]) => string[]
): string[] {
  if (featuresToRender.length === 0) return [];
  if (featuresToRender.length < RETAINED_TRANSCRIPT_KEY_CACHE_MIN_FEATURES) {
    return normalizeAnnotationLayerTypes(
      featuresToRender.map((feature) => feature.annotationTrackId ?? feature.type)
    );
  }
  return host.annotationLayerTypesForPresentation();
}

export function recordDrawAuditDecision(
  host: OverlayLayoutHost,
  audit: AnnotationDrawAuditSnapshot,
  feature: Feature,
  decision: AnnotationDrawAuditDecision,
  path: PathMapper
): void {
  recordAnnotationDrawAuditDecision(audit, {
    id: feature.id,
    type: feature.type,
    start: feature.start,
    end: feature.end,
    lane: feature.lane,
    cdsLane: feature.cdsLane ?? null,
    pixelWidth: featurePixelWidth(host, feature, path),
    decision,
  });
}

export function beginDrawAudit(
  host: BeginDrawAuditHost,
  path: PathMapper,
  state: RenderState,
  featuresToRender: readonly Feature[],
  useOverviewAggregation: boolean,
  overviewCache: {
    binBp: number;
    bins: { readonly length: number };
    passthroughFeatures: { readonly length: number };
    diagnostics: {
      inputFeatureCount: number;
      skippedMinVisibleFeatureCount: number;
      aggregateWideFeatureCount: number;
      aggregatedFeatureCount: number;
      binContributionCount: number;
    };
  } | null
): AnnotationDrawAuditSnapshot {
  return buildAnnotationDrawAudit({
    frameId: ++host.drawAuditFrameId,
    renderMode: host.lastRenderMode,
    path,
    state,
    featureCount: host.features.length,
    renderSetFeatureCount: featuresToRender.length,
    renderSetLayerTypes: host.renderSetLayerTypesForAudit(featuresToRender),
    maxAnnotationLane: host.maxAnnotationLane,
    maxCdsLane: host.maxCdsLane,
    layout: host._layout,
    overviewAggregationEnabled: useOverviewAggregation,
    overviewCache: overviewCache
      ? {
          binBp: overviewCache.binBp,
          binCount: overviewCache.bins.length,
          passthroughFeatureCount: overviewCache.passthroughFeatures.length,
          diagnostics: overviewCache.diagnostics,
        }
      : null,
    overviewCacheHit: host.lastOverviewAggregationCacheHit,
    overviewBudgetExceeded: host.lastOverviewDensityAtlasBudgetExceeded,
  });
}
