import { Container, Graphics, Renderer, Text } from 'pixi.js';
import type { Feature, RenderState } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import type { UnifiedLayout } from '../shared/track-layout';
import type {
  RetainedOverlayCameraState,
  RetainedOverlayFallbackReason,
  RetainedOverlayRenderMode,
} from './overlay-track';
import type { RetainedOverviewAnnotationStyle } from './annotation-lod-policy';
import { OVERVIEW_DENSITY_ATLAS_SAMPLE_SCREEN_PX } from './annotation-lod-policy';
import type { StadiumRetainedCameraHost } from './indexed-annotation-retained-stadium-camera';
import { updateRetainedStadiumCamera } from './indexed-annotation-retained-stadium-camera';
import {
  reserveAnnotationPillBounds,
  type RetainedDrawHost,
} from './indexed-annotation-retained-draw';
import { pillLabelTextStyle, targetPillLabelTextResolution } from '../shared/label-pill';
import type {
  BeginDrawAuditHost,
  PresentationAuditHost,
} from './indexed-annotation-presentation-audit';
import type { TilePyramidCompositeHost } from './indexed-tile-pyramid-controller';
import type { PrebuiltTexturePolicyHost } from './indexed-prepacked-prebuilt-texture-policy';
import {
  AnnotationOverviewCacheManager,
  type AnnotationOverviewCacheContext,
} from './annotation-overview-cache';
import type { LabelOccupancyRecord } from '../shared/label-occupancy';
import type { CurvedLabelRenderer } from '../shared/curved-label';
import type {
  AnnotationDrawAuditDecision,
  AnnotationDrawAuditSnapshot,
} from './annotation-draw-audit';
import type { OverviewAggregationCache, OverviewBin } from './annotation-overview-cache';
import type { AnnotationPrebuiltRasterEligibility } from './annotation-lod-ownership';
import type { PrebuiltAnnotationRasterContractMatch } from '../overview/prebuilt-annotation-raster-contract';
import type { AnnotationPolicyGpuRuntimeV1 } from '../overview/annotation-policy-gpu-instances-v1';
import type {
  GenomeWideTextureCompositeArgs,
  PrebuiltGenomeWideTextureMeta,
} from '../overview/genome-wide-texture-cache-layer';
import type { GenomeWideTextureCacheLayer } from '../overview/genome-wide-texture-cache-layer';
import type { RetainedOverviewAnnotationLayer } from '../overview/retained-overview-layer';
import type { RetainedLinearFeatureLayer } from '../overview/retained-linear-feature-layer';
import type { RetainedLinearTranscriptLayer } from '../overview/retained-linear-transcript-layer';
import type { FeaturePrimitiveSink } from '../overview/feature-primitive-sink';
import {
  emptyAnnotationBodyPresenterEligibility,
  type AnnotationBodyFrameOwnerKind,
  type AnnotationBodyPresenterEligibility,
} from './annotation-body-presentation-authority';
import type { AnnotationRenderKeyParts } from './indexed-annotation-layout';
import type { OverlayPresenterCollaborators } from './indexed-annotation-overlay-collaborators';
import type { PrepackedAnnotationSceneStatus } from '../overview/prepacked-annotation-scene';
import {
  auditAnnotationDraw as auditAnnotationDrawFn,
  beginDrawAudit as beginDrawAuditFn,
  beginDrawAuditIfDiagnosticsEnabled as beginDrawAuditIfDiagnosticsEnabledFn,
  buildPresentationDebugSnapshot as buildPresentationDebugSnapshotFn,
  renderSetLayerTypesForAudit as renderSetLayerTypesForAuditFn,
} from './indexed-annotation-presentation-audit';
import { renderRetainedTranscriptDecorations as renderRetainedTranscriptDecorationsFn } from './indexed-annotation-retained-draw';
import {
  getColor as annotationFeatureGetColor,
  isOutlineOnlyFeature as annotationFeatureIsOutlineOnly,
  isSplicedFeature as annotationFeatureIsSpliced,
  isTranscript as annotationFeatureIsTranscript,
  normalizeAnnotationLayerTypes,
} from './annotation-feature-semantics';
import type { AnnotationFrameRenderMode } from './annotation-render-mode';
import {
  buildAndExtractGenomeWideTexturePng as buildAndExtractGenomeWideTexturePngFn,
  forceMeshOverview as forceMeshOverviewFn,
  prebuiltRasterEligibility as prebuiltRasterEligibilityFn,
  prebuiltRasterTexelsPerDevicePx as prebuiltRasterTexelsPerDevicePxFn,
} from './indexed-prebuilt-raster-eligibility';
import {
  buildGenomeWideCompositeArgs as buildGenomeWideCompositeArgsFn,
  buildRetainedData as buildRetainedDataFn,
  clearPrebuiltGenomeWideTexture as clearPrebuiltGenomeWideTextureFn,
  destroyAnnotationOverlay as destroyAnnotationOverlayFn,
  ensureGenomeWideTextureCacheLayer as ensureGenomeWideTextureCacheLayerFn,
  ensureRetainedLinearFeatureLayer as ensureRetainedLinearFeatureLayerFn,
  ensureRetainedLinearTranscriptLayer as ensureRetainedLinearTranscriptLayerFn,
  ensureRetainedOverviewLayer as ensureRetainedOverviewLayerFn,
  isPrebuiltGenomeWideTextureLoaded as isPrebuiltGenomeWideTextureLoadedFn,
  loadPrebuiltGenomeWideTexture as loadPrebuiltGenomeWideTextureFn,
  overviewCacheContext as overviewCacheContextFn,
  setRenderer as setRendererFn,
} from './indexed-annotation-lifecycle';
import {
  hashRetainedLinearTranscriptFeatureKey as hashRetainedLinearTranscriptFeatureKeyFn,
  retainedLinearSourceFeaturesForViewport as retainedLinearSourceFeaturesForViewportFn,
  type RetainedLinearSourceWindow,
} from './indexed-annotation-retained-source-window';
import { syncRetainedLinearOverviewLayers as syncRetainedLinearOverviewLayersFn } from './indexed-retained-linear-sync';
import { updateRetainedLinearCameraInner as updateRetainedLinearCameraInnerFn } from './indexed-retained-linear-camera';
import { presentEmptyRetainedLinearViewport as presentEmptyRetainedLinearViewportFn } from './indexed-retained-empty-viewport';
import { resetRetainedOverviewDebug as resetRetainedOverviewDebugFn } from './indexed-retained-overview-reset';
import { runInvariantGuardAfterRetainedSync as runInvariantGuardAfterRetainedSyncFn } from './indexed-annotation-invariant-guard';
import {
  hideCompiledBroadPresenters as hideCompiledBroadPresentersFn,
  resetAllPresentersToHidden as resetAllPresentersToHiddenFn,
} from './indexed-annotation-clear-draw-state';
import {
  clearImmediateStateForCompiledAnnotationOwner as clearImmediateStateForCompiledAnnotationOwnerFn,
  finalizeCompiledAnnotationBodyPresent as finalizeCompiledAnnotationBodyPresentFn,
  hideAllPresentationSurfaces as hideAllPresentationSurfacesFn,
  renderHiddenPresentation as renderHiddenPresentationFn,
  renderImmediateShapesForLodTransition as renderImmediateShapesForLodTransitionFn,
  resetImmediateDrawStats as resetImmediateDrawStatsFn,
  resetRenderStats as resetRenderStatsFn,
  retainedOverviewFallback as retainedOverviewFallbackFn,
  sealCompiledBroadPresentedFrame as sealCompiledBroadPresentedFrameFn,
  setPresentationVisible as setPresentationVisibleFn,
  tryPresentPrebuiltRasterBody as tryPresentPrebuiltRasterBodyFn,
} from './indexed-annotation-present-bookkeeping';

const NO_PREBUILT_RASTER_CONTRACT_MATCH: PrebuiltAnnotationRasterContractMatch = Object.freeze({
  contractMatch: false,
  sourceMatch: false,
  placementMatch: false,
  artifactLayerTypes: Object.freeze([]),
  artifactSourceFingerprint: null,
  artifactPlacementFingerprint: null,
});

type DrawAuditOverviewCache = {
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
};

export type RetainedLinearOverlayGlue = {
  container: Container;
  graphics: Graphics;
  retainedTranscriptDecorationGraphics: Graphics;
  annotationSearchFocusGraphics: Graphics;
  interactionGraphics: Graphics;
  tilePyramid: {
    hide(): void;
    destroy(): void;
    vector: PresentationAuditHost['tilePyramidVectorCompositor'];
    rtt: PresentationAuditHost['rttGlyphTilePyramidCompositor'];
  };
  sidecarRaster: PresentationAuditHost['sidecarRaster'] & { hide(): void; destroy(): void };
  curvedLabels: { destroy(): void; reset(): void };
  labelPool: Text[];
  labelIndex: number;
  features: Feature[];
  genomeLength: number;
  currentGenomeIdentity: string | null;
  currentAnnotationSourceFingerprint: string | null;
  currentAnnotationPlacementFingerprint: string | null;
  _layout: UnifiedLayout | null;
  maxAnnotationLane: number;
  maxCdsLane: number;
  overviewCache: StadiumRetainedCameraHost['overviewCache'] &
    RetainedDrawHost['overviewCache'] & { invalidate(): void };
  overviewCacheContext(): AnnotationOverviewCacheContext;
  featureWindowIndex: RetainedDrawHost['featureWindowIndex'];
  hitCache: RetainedDrawHost['hitCache'];
  outlineCache: RetainedDrawHost['outlineCache'];
  labelOccupancyCache: LabelOccupancyRecord[];
  drawAuditFrameId: number;
  renderKeyParts(state: RenderState): Record<string, string>;
  renderKeyFromParts(parts: Record<string, string>): string;
  renderKeyChangeReasons(next: Record<string, string>): string[];
  drawRetainedTranscriptIntronConnectors(
    g: Graphics,
    feature: Feature,
    path: PathMapper,
    state: RenderState,
    alpha: number,
    clipRange?: { lo: number; hi: number }
  ): void;
  renderSetLayerTypesForAudit(featuresToRender: readonly Feature[]): string[];
  auditAnnotationDraw(state: RenderState): void;
  compiledBroadSurfaceOwnedLastFrame: boolean;
  compiledBroadSurfacePresenter: { hide(): void } | null;
  compiledBroadSurfaceCandidatePresenter: { hide(): void } | null;
  compiledBroadSurfaceTrackOwners: Map<string, { presenter: { hide(): void } }>;
  compiledBroadSurfaceTrackCandidateOwners: Map<string, { presenter: { hide(): void } }>;
  compiledBroadAnnotationInteractionResidentGeneration: number;
  compiledBroadAnnotationInteractionResidents: Map<string, unknown>;
  prepackedAnnotationSceneResidents: Map<
    string,
    {
      layer: { hide(): void };
      policyTrackLaneMaxima?: Record<'canonical' | 'expanded', number> | null;
    }
  >;
  prepackedAnnotationSceneReplacementCandidates: Map<
    string,
    {
      layer: {
        hide(): void;
        areFineViewsPrewarmed?(startBp: number, endBp: number): boolean;
      };
      input?: { viewportDetail?: { coverageStartBp?: number; coverageEndBp?: number } | null };
      viewportDetailPresentationAdmitted?: boolean;
    }
  >;
  prepackedAnnotationPolicyGeneration: number;
  prepackedAnnotationRuntimePolicy: AnnotationPolicyGpuRuntimeV1 | null;
  prepackedAnnotationSceneOwnerKey: string | null;
  updatePrepackedAnnotationPolicy(policy: AnnotationPolicyGpuRuntimeV1): boolean;
  prepackedAnnotationSceneVisiblePartitionCount: number;
  prepackedAnnotationSceneVisibleInstanceCount: number;
  prepackedAnnotationSceneFinePendingReason: string | null;
  prepackedAnnotationSceneStatus: string;
  prepackedAnnotationSceneLastCompleteOwnerKeys: readonly string[];
  prepackedAnnotationSceneOwnerMetadata: { themeMode?: RenderState['themeMode'] } | null;
  compiledBroadSurfacePlanStatus: string;
  compiledBroadSurfaceLastPresentationCamera: PresentationAuditHost['compiledBroadSurfaceLastPresentationCamera'];
  compiledBroadSurfaceLastCameraRequest: PresentationAuditHost['compiledBroadSurfaceLastCameraRequest'];
  compiledBroadSurfaceRequirement: PresentationAuditHost['compiledBroadSurfaceRequirement'];
  compiledBroadSurfacePresentingLayerTypes(): string[];
  prepackedAnnotationScenePresentingResidents(): Array<{ metadata: { trackType: string } }>;
  compiledBroadSurfaceOwnerForTrack(
    trackType: string
  ): ReturnType<PresentationAuditHost['compiledBroadSurfaceOwnerForTrack']>;
  compiledBroadSurfaceProvenanceIsCurrent(manifest: unknown, provenance: unknown): boolean;
  buildPresentationDebugSnapshot(): ReturnType<
    PresentationAuditHost['buildPresentationDebugSnapshot']
  >;
  retiredPrepackedAnnotationSceneLayers: Map<{ destroy(): void }, number>;
  prepackedAnnotationSceneLayerDestroys: number;
  annotationBodyFrameOwner: AnnotationBodyFrameOwnerKind;
  annotationBodyFrameEligibility: AnnotationBodyPresenterEligibility;
  annotationSearchFocusResolvedTrackId: string | null;
  annotationSearchFocusResolvedCanonicalIdentity: string | null;
  annotationSearchFocusPresentationLane: number | null;
  decorationCacheKey: string;
  decorationCacheAnchorViewStartBp: number;
  decorationCacheAnchorPpb: number;
  decorationCacheBuiltLoBp: number;
  decorationCacheBuiltHiBp: number;
  retainedTranscriptDecorationBuilds: number;
  disposePrepackedAnnotationScene(status: string, recordOwnerChange?: boolean): void;
  resetTilePyramid(): void;
  applyAnnotationPresentationPolicy(policy: AnnotationPolicyGpuRuntimeV1): boolean | 'deferred';
  clearCompiledBroadSurfaceRequirement(): void;
  releaseRetiredGpuResourcesAfterPresent(force?: boolean): void;
  featureOffset(feature: Feature): number;
  featureEnvelope(feature: Feature): { centerOffset: number } | null;
  scaledBarHeight(): number;
  cdsDetailProgress(): number;
  retainedLinearTranscriptFeatureKey(features: readonly Feature[]): string;
  retainedLinearTranscriptLayoutKey(state: RenderState): string;
  annotationLayerTypesForPresentation(): string[];
  clearDrawState(): void;
  clearDecorationCache(): void;
  beginDrawAudit(
    path: PathMapper,
    state: RenderState,
    featuresToRender: readonly Feature[],
    useOverviewAggregation: boolean,
    overviewCache: DrawAuditOverviewCache | null
  ): AnnotationDrawAuditSnapshot;
  beginDrawAuditIfDiagnosticsEnabled(
    path: PathMapper,
    state: RenderState,
    featuresToRender: readonly Feature[],
    useOverviewAggregation: boolean,
    overviewCache: DrawAuditOverviewCache | null
  ): AnnotationDrawAuditSnapshot | null;
  renderInteractionOutlines(path: PathMapper, state: RenderState): void;
  renderImmediateFeature(
    sink: FeaturePrimitiveSink,
    feature: Feature,
    path: PathMapper,
    state: RenderState,
    useOverviewAggregation: boolean,
    forceTinyFeatureShapes?: boolean,
    alphaScale?: number
  ): AnnotationDrawAuditDecision;
  renderRetainedTranscriptDecorations(
    batchedTranscriptSet: Set<Feature> | null,
    path: PathMapper,
    state: RenderState,
    retainedFeatures?: readonly Feature[]
  ): void;
  renderResidentFeatureLabels(
    features: readonly Feature[],
    path: PathMapper,
    state: RenderState
  ): void;
  recordDrawAuditDecision(
    audit: AnnotationDrawAuditSnapshot,
    feature: Feature,
    decision: AnnotationDrawAuditDecision,
    path: PathMapper
  ): void;
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
  featuresInRange(viewStartBp: number, viewEndBp: number): Feature[];
  hasFeaturesInRange(viewStartBp: number, viewEndBp: number): boolean;
  noteAnnotationBodyFrameOwner(owner: AnnotationBodyFrameOwnerKind): void;
};

const EMPTY_COMPILED_OWNERS = new Map<string, { presenter: { hide(): void } }>();
const EMPTY_PREPACKED_RESIDENTS = new Map<string, { layer: { hide(): void } }>();
const EMPTY_RETIRED_LAYERS = new Map<{ destroy(): void }, number>();
const EMPTY_INTERACTION_RESIDENTS = new Map<string, unknown>();

export function idleRetainedLinearOverlayGlue(): RetainedLinearOverlayGlue {
  const children: unknown[] = [];
  return {
    container: {
      children,
      addChildAt() {},
      removeChild() {},
      destroy() {},
    } as unknown as Container,
    graphics: { visible: false, destroy() {}, clear() {} } as unknown as Graphics,
    retainedTranscriptDecorationGraphics: {
      visible: false,
      destroy() {},
      position: { x: 0 },
    } as unknown as Graphics,
    annotationSearchFocusGraphics: { destroy() {}, clear() {} } as unknown as Graphics,
    interactionGraphics: { destroy() {}, clear() {} } as unknown as Graphics,
    tilePyramid: { hide() {}, destroy() {}, vector: null, rtt: null },
    sidecarRaster: { hide() {}, destroy() {}, isPresenting: false, visibleTrackTypes: [] },
    curvedLabels: { destroy() {}, reset() {} },
    labelPool: [],
    labelIndex: 0,
    features: [],
    genomeLength: 0,
    currentGenomeIdentity: '',
    currentAnnotationSourceFingerprint: null,
    currentAnnotationPlacementFingerprint: null,
    _layout: null,
    maxAnnotationLane: 0,
    maxCdsLane: -1,
    overviewCache: {
      invalidate() {},
      lastCacheHit: false,
      getRetainedOverviewBodyCache() {
        return null;
      },
      retainedDensityAtlasDiagnostics() {
        return { estimatedBinCount: 0, wasCoarsened: false, budgetExceeded: false };
      },
      getOverviewAggregationCache() {
        return null;
      },
      mergedDensityAtlasDiagnostics() {
        return { estimatedBinCount: 0, wasCoarsened: false, budgetExceeded: false };
      },
    },
    overviewCacheContext() {
      return {
        features: [],
        genomeLength: 0,
        layout: null,
        maxAnnotationLane: 0,
        maxCdsLane: -1,
        minAggregateFeaturePixels: 0,
        getEndBp: () => 0,
        getOffset: () => 0,
        getHalfHeight: () => 0,
        getColor: () => 0,
        getAlpha: () => 1,
        shouldPassThrough: () => false,
      };
    },
    featureWindowIndex: {
      candidatesForPath() {
        return [];
      },
    },
    hitCache: { length: 0 },
    outlineCache: { clear() {} },
    labelOccupancyCache: [],
    drawAuditFrameId: 0,
    renderKeyParts() {
      return {};
    },
    renderKeyFromParts() {
      return '';
    },
    renderKeyChangeReasons() {
      return [];
    },
    drawRetainedTranscriptIntronConnectors() {},
    renderSetLayerTypesForAudit() {
      return [];
    },
    auditAnnotationDraw() {},
    compiledBroadSurfaceOwnedLastFrame: false,
    compiledBroadSurfacePresenter: null,
    compiledBroadSurfaceCandidatePresenter: null,
    compiledBroadSurfaceTrackOwners: EMPTY_COMPILED_OWNERS,
    compiledBroadSurfaceTrackCandidateOwners: EMPTY_COMPILED_OWNERS,
    compiledBroadAnnotationInteractionResidentGeneration: 0,
    compiledBroadAnnotationInteractionResidents: EMPTY_INTERACTION_RESIDENTS,
    prepackedAnnotationSceneResidents: EMPTY_PREPACKED_RESIDENTS,
    prepackedAnnotationSceneReplacementCandidates: EMPTY_PREPACKED_RESIDENTS,
    prepackedAnnotationPolicyGeneration: 0,
    prepackedAnnotationRuntimePolicy: null,
    prepackedAnnotationSceneOwnerKey: null,
    updatePrepackedAnnotationPolicy() {
      return false;
    },
    prepackedAnnotationSceneVisiblePartitionCount: 0,
    prepackedAnnotationSceneVisibleInstanceCount: 0,
    prepackedAnnotationSceneFinePendingReason: null,
    prepackedAnnotationSceneStatus: 'not-loaded',
    prepackedAnnotationSceneLastCompleteOwnerKeys: Object.freeze([]),
    prepackedAnnotationSceneOwnerMetadata: null,
    compiledBroadSurfacePlanStatus: 'not-loaded',
    compiledBroadSurfaceLastPresentationCamera: null,
    compiledBroadSurfaceLastCameraRequest: null,
    compiledBroadSurfaceRequirement: null,
    compiledBroadSurfacePresentingLayerTypes() {
      return [];
    },
    prepackedAnnotationScenePresentingResidents() {
      return [];
    },
    compiledBroadSurfaceOwnerForTrack() {
      return null;
    },
    compiledBroadSurfaceProvenanceIsCurrent() {
      return false;
    },
    buildPresentationDebugSnapshot() {
      return {} as ReturnType<PresentationAuditHost['buildPresentationDebugSnapshot']>;
    },

    retiredPrepackedAnnotationSceneLayers: EMPTY_RETIRED_LAYERS,
    prepackedAnnotationSceneLayerDestroys: 0,
    annotationBodyFrameOwner: 'none',
    annotationBodyFrameEligibility: emptyAnnotationBodyPresenterEligibility(),
    annotationSearchFocusResolvedTrackId: null,
    annotationSearchFocusResolvedCanonicalIdentity: null,
    annotationSearchFocusPresentationLane: null,
    decorationCacheKey: '',
    decorationCacheAnchorViewStartBp: 0,
    decorationCacheAnchorPpb: 0,
    decorationCacheBuiltLoBp: 0,
    decorationCacheBuiltHiBp: 0,
    retainedTranscriptDecorationBuilds: 0,
    disposePrepackedAnnotationScene() {},
    resetTilePyramid() {},
    applyAnnotationPresentationPolicy() {
      return false;
    },
    clearCompiledBroadSurfaceRequirement() {},
    releaseRetiredGpuResourcesAfterPresent() {},
    featureOffset() {
      return 0;
    },
    featureEnvelope() {
      return { centerOffset: 0 };
    },
    scaledBarHeight() {
      return 8;
    },
    cdsDetailProgress() {
      return 0;
    },
    retainedLinearTranscriptFeatureKey() {
      return '';
    },
    retainedLinearTranscriptLayoutKey() {
      return '';
    },
    annotationLayerTypesForPresentation() {
      return [];
    },
    clearDrawState() {},
    clearDecorationCache() {},
    beginDrawAudit() {
      return {} as AnnotationDrawAuditSnapshot;
    },
    beginDrawAuditIfDiagnosticsEnabled() {
      return null;
    },
    renderInteractionOutlines() {},
    renderImmediateFeature() {
      return 'skipped-viewport';
    },
    renderRetainedTranscriptDecorations() {},
    renderResidentFeatureLabels() {},
    recordDrawAuditDecision() {},
    presentExclusiveAnnotationBodyFrame() {
      return false;
    },
    activeResidentPublicationOwnsAnnotationBodyFallback() {
      return false;
    },
    selectResidentAnnotationFeaturesForViewport() {
      return null;
    },
    featuresInRange() {
      return [];
    },
    hasFeaturesInRange() {
      return false;
    },
    noteAnnotationBodyFrameOwner() {},
  };
}

export class RetainedLinearPresenter
  implements
    StadiumRetainedCameraHost,
    RetainedDrawHost,
    BeginDrawAuditHost,
    TilePyramidCompositeHost,
    PrebuiltTexturePolicyHost,
    PresentationAuditHost
{
  presentationVisible = true;
  pixiRenderer: Renderer | null = null;
  retainedOverviewLayer: RetainedOverviewAnnotationLayer | null = null;
  retainedLinearFeatureLayer: RetainedLinearFeatureLayer | null = null;
  retainedLinearTranscriptLayer: RetainedLinearTranscriptLayer | null = null;
  genomeWideTextureCacheLayer: GenomeWideTextureCacheLayer | null = null;
  retainedLinearTranscriptKey = '';
  readonly retainedLinearTranscriptFeatureKeyCache = new WeakMap<readonly Feature[], string>();
  retainedLinearTranscriptFeatureSet: Set<Feature> | null = null;
  retainedLinearTranscriptMembershipNeedsRebind = false;
  retainedLinearFullSetMeshResident = false;
  retainedLinearSourceWindow: RetainedLinearSourceWindow | null = null;
  retainedLinearDataBuilds = 0;
  retainedLinearBinCount = 0;
  retainedLinearTranscriptBuilds = 0;
  retainedLinearTranscriptBlockCount = 0;
  retainedLinearTranscriptPrevKeyParts: string[] | null = null;
  retainedLinearTranscriptLastBuildCause = '';
  retainedLinearTranscriptStaleHolds = 0;
  retainedLinearTranscriptVisibleFeatureCount = 0;
  retainedOverviewHitBins: OverviewBin[] = [];
  retainedOverviewMode: RetainedOverlayRenderMode = 'inactive';
  retainedOverviewDataBuilds = 0;
  retainedOverviewCameraUpdates = 0;
  retainedOverviewInteractionUpdates = 0;
  retainedOverviewFallbackRenders = 0;
  retainedOverviewFallbackReason: RetainedOverlayFallbackReason | null = null;
  retainedOverviewStyle: RetainedOverviewAnnotationStyle = 'retained';
  retainedOverviewInstanceCount = 0;
  retainedOverviewVisibleInstanceCount = 0;
  retainedOverviewPassthroughDrawn = false;
  immediateDrawStateClearedForRetained = false;
  retainedDrawStateClean = false;
  lastRetainedTranscriptDecorationsDrawn = false;
  prebuiltRasterEligibleForLastFrame = false;
  prebuiltRasterContractForLastFrame: PrebuiltAnnotationRasterContractMatch =
    NO_PREBUILT_RASTER_CONTRACT_MATCH;
  lastGenomeWideContext: { path: PathMapper; state: RenderState } | null = null;
  renderCallCount = 0;
  geometryRebuildCount = 0;
  geometryCacheHitCount = 0;
  lastRenderMode: AnnotationFrameRenderMode = 'none';
  lastRenderKey = '';
  lastRenderKeyParts: AnnotationRenderKeyParts | null = null;
  lastGeometryRebuildReasons: string[] = [];
  lastDrawAudit: AnnotationDrawAuditSnapshot | null = null;
  lastFrameDoubleDraw = false;
  lastDrawnFeatureCount = 0;
  lastImmediateTranscriptDrawnCount = 0;
  readonly lastImmediateDrawnLayerTypes = new Set<string>();
  lastOverviewAggregationEnabled = false;
  lastOverviewAggregationCacheHit = false;
  lastOverviewPassthroughFeatureCount = 0;
  lastOverviewDensityAtlasBinBp = 0;
  lastOverviewDensityAtlasSampleScreenPx = OVERVIEW_DENSITY_ATLAS_SAMPLE_SCREEN_PX;
  lastOverviewDensityAtlasLevelCount = 0;
  lastOverviewDensityAtlasEstimatedBinCount = 0;
  lastOverviewDensityAtlasWasCoarsened = false;
  lastOverviewDensityAtlasBudgetExceeded = false;
  lastOverviewLodCompressionBlend = 0;
  lastOverviewLodFullShapeBlend = 1;
  lastOverviewCacheMs = 0;
  lastOverviewImmediateBlendMs = 0;
  overviewBinDrawCount = 0;
  readonly graphics = new Graphics();
  readonly retainedTranscriptDecorationGraphics = new Graphics();
  curvedLabels: Pick<CurvedLabelRenderer, 'destroy' | 'reset'> = {
    destroy() {},
    reset() {},
  };
  labelPool: Text[] = [];
  labelIndex = 0;
  readonly overviewCache = new AnnotationOverviewCacheManager();
  drawAuditFrameId = 0;
  decorationCacheKey = '';
  decorationCacheAnchorViewStartBp = 0;
  decorationCacheAnchorPpb = 0;
  decorationCacheBuiltLoBp = 0;
  decorationCacheBuiltHiBp = 0;
  retainedTranscriptDecorationBuilds = 0;
  labelOccupancyCache: LabelOccupancyRecord[] = [];

  private overlay: RetainedLinearOverlayGlue = idleRetainedLinearOverlayGlue();

  constructor() {}
  attach(collaborators: OverlayPresenterCollaborators): void {
    this.overlay = {
      get container() {
        return collaborators.container;
      },
      get graphics() {
        return collaborators.retained.graphics;
      },
      get retainedTranscriptDecorationGraphics() {
        return collaborators.retained.retainedTranscriptDecorationGraphics;
      },
      get annotationSearchFocusGraphics() {
        return collaborators.searchFocus.annotationSearchFocusGraphics;
      },
      get interactionGraphics() {
        return collaborators.outlines.interactionGraphics;
      },
      get tilePyramid() {
        return collaborators.tilePyramid;
      },
      get sidecarRaster() {
        return collaborators.sidecarRaster;
      },
      get curvedLabels() {
        return collaborators.retained.curvedLabels;
      },
      get labelPool() {
        return collaborators.retained.labelPool;
      },
      get labelIndex() {
        return collaborators.retained.labelIndex;
      },
      set labelIndex(value) {
        collaborators.retained.labelIndex = value;
      },
      get features() {
        return collaborators.layout.features;
      },
      get genomeLength() {
        return collaborators.layout.genomeLength;
      },
      set genomeLength(value) {
        collaborators.layout.genomeLength = value;
      },
      get currentGenomeIdentity() {
        return collaborators.layout.currentGenomeIdentity;
      },
      get currentAnnotationSourceFingerprint() {
        return collaborators.layout.currentAnnotationSourceFingerprint;
      },
      get currentAnnotationPlacementFingerprint() {
        return collaborators.layout.currentAnnotationPlacementFingerprint;
      },
      get _layout() {
        return collaborators.layout._layout;
      },
      get maxAnnotationLane() {
        return collaborators.layout.maxAnnotationLane;
      },
      get maxCdsLane() {
        return collaborators.layout.maxCdsLane;
      },
      get overviewCache() {
        return collaborators.retained.overviewCache as RetainedLinearOverlayGlue['overviewCache'];
      },
      overviewCacheContext: () => collaborators.retained.overviewCacheContext(),
      get featureWindowIndex() {
        return collaborators.layout.featureWindowIndex as RetainedDrawHost['featureWindowIndex'];
      },
      get hitCache() {
        return collaborators.hits.hitCache;
      },
      get outlineCache() {
        return collaborators.immediateDraw.outlineCache;
      },
      get labelOccupancyCache() {
        return collaborators.retained
          .labelOccupancyCache as RetainedDrawHost['labelOccupancyCache'];
      },
      set labelOccupancyCache(value) {
        collaborators.retained.labelOccupancyCache = value;
      },
      get drawAuditFrameId() {
        return collaborators.retained.drawAuditFrameId;
      },
      set drawAuditFrameId(value) {
        collaborators.retained.drawAuditFrameId = value;
      },
      renderKeyParts: (state) => collaborators.layout.renderKeyParts(state),
      renderKeyFromParts: (parts) => collaborators.layout.renderKeyFromParts(parts),
      renderKeyChangeReasons: (next) => collaborators.layout.renderKeyChangeReasons(next),
      drawRetainedTranscriptIntronConnectors: (g, feature, path, state, alpha, clipRange) =>
        collaborators.immediateDraw.drawRetainedTranscriptIntronConnectors(
          g,
          feature,
          path,
          state,
          alpha,
          clipRange
        ),
      renderSetLayerTypesForAudit: (featuresToRender) =>
        collaborators.retained.renderSetLayerTypesForAudit(featuresToRender),
      auditAnnotationDraw: (state) => collaborators.retained.auditAnnotationDraw(state),
      get compiledBroadSurfaceOwnedLastFrame() {
        return collaborators.compiledBroad.compiledBroadSurfaceOwnedLastFrame;
      },
      set compiledBroadSurfaceOwnedLastFrame(value) {
        collaborators.compiledBroad.compiledBroadSurfaceOwnedLastFrame = value;
      },
      get compiledBroadSurfacePresenter() {
        return collaborators.compiledBroad.compiledBroadSurfacePresenter;
      },
      get compiledBroadSurfaceCandidatePresenter() {
        return collaborators.compiledBroad.compiledBroadSurfaceCandidatePresenter;
      },
      get compiledBroadSurfaceTrackOwners() {
        return collaborators.compiledBroad.compiledBroadSurfaceTrackOwners;
      },
      get compiledBroadSurfaceTrackCandidateOwners() {
        return collaborators.compiledBroad.compiledBroadSurfaceTrackCandidateOwners;
      },
      get compiledBroadAnnotationInteractionResidentGeneration() {
        return collaborators.compiledBroad.compiledBroadAnnotationInteractionResidentGeneration;
      },
      get compiledBroadAnnotationInteractionResidents() {
        return collaborators.compiledBroad.compiledBroadAnnotationInteractionResidents;
      },
      get prepackedAnnotationSceneResidents() {
        return collaborators.prepacked.prepackedAnnotationSceneResidents;
      },
      get prepackedAnnotationSceneReplacementCandidates() {
        return collaborators.prepacked.prepackedAnnotationSceneReplacementCandidates;
      },
      get prepackedAnnotationPolicyGeneration() {
        return collaborators.prepacked.prepackedAnnotationPolicyGeneration;
      },
      get prepackedAnnotationRuntimePolicy() {
        return collaborators.prepacked.prepackedAnnotationRuntimePolicy;
      },
      get prepackedAnnotationSceneOwnerKey() {
        return collaborators.prepacked.prepackedAnnotationSceneOwnerKey;
      },
      updatePrepackedAnnotationPolicy: (policy) =>
        collaborators.prepacked.updatePrepackedAnnotationPolicy(policy),
      get prepackedAnnotationSceneVisiblePartitionCount() {
        return collaborators.prepacked.prepackedAnnotationSceneVisiblePartitionCount;
      },
      get prepackedAnnotationSceneVisibleInstanceCount() {
        return collaborators.prepacked.prepackedAnnotationSceneVisibleInstanceCount;
      },
      get prepackedAnnotationSceneFinePendingReason() {
        return collaborators.prepacked.prepackedAnnotationSceneFinePendingReason;
      },
      get prepackedAnnotationSceneStatus() {
        return collaborators.prepacked.prepackedAnnotationSceneStatus;
      },
      get prepackedAnnotationSceneLastCompleteOwnerKeys() {
        return collaborators.prepacked.prepackedAnnotationSceneLastCompleteOwnerKeys;
      },
      get prepackedAnnotationSceneOwnerMetadata() {
        return collaborators.prepacked.prepackedAnnotationSceneOwnerMetadata;
      },
      get compiledBroadSurfacePlanStatus() {
        return collaborators.compiledBroad.compiledBroadSurfacePlanStatus;
      },
      get compiledBroadSurfaceLastPresentationCamera() {
        return collaborators.compiledBroad.compiledBroadSurfaceLastPresentationCamera;
      },
      get compiledBroadSurfaceLastCameraRequest() {
        return collaborators.compiledBroad.compiledBroadSurfaceLastCameraRequest;
      },
      get compiledBroadSurfaceRequirement() {
        return collaborators.compiledBroad.compiledBroadSurfaceRequirement;
      },
      compiledBroadSurfacePresentingLayerTypes: () =>
        collaborators.compiledBroad.compiledBroadSurfacePresentingLayerTypes(),
      prepackedAnnotationScenePresentingResidents: () =>
        collaborators.prepacked.prepackedAnnotationScenePresentingResidents(),
      compiledBroadSurfaceOwnerForTrack: (trackType) =>
        collaborators.compiledBroad.compiledBroadSurfaceOwnerForTrack(trackType),
      compiledBroadSurfaceProvenanceIsCurrent: (manifest, provenance) =>
        collaborators.compiledBroad.compiledBroadSurfaceProvenanceIsCurrent(
          manifest as never,
          provenance as never
        ),
      buildPresentationDebugSnapshot: () => collaborators.retained.buildPresentationDebugSnapshot(),
      get retiredPrepackedAnnotationSceneLayers() {
        return collaborators.prepacked.retiredPrepackedAnnotationSceneLayers;
      },
      get prepackedAnnotationSceneLayerDestroys() {
        return collaborators.prepacked.prepackedAnnotationSceneLayerDestroys;
      },
      set prepackedAnnotationSceneLayerDestroys(value) {
        collaborators.prepacked.prepackedAnnotationSceneLayerDestroys = value;
      },
      get annotationBodyFrameOwner() {
        return collaborators.bodyFrame.annotationBodyFrameOwner;
      },
      set annotationBodyFrameOwner(value) {
        collaborators.bodyFrame.annotationBodyFrameOwner = value;
      },
      get annotationBodyFrameEligibility() {
        return collaborators.bodyFrame.annotationBodyFrameEligibility;
      },
      set annotationBodyFrameEligibility(value) {
        collaborators.bodyFrame.annotationBodyFrameEligibility = value;
      },
      get annotationSearchFocusResolvedTrackId() {
        return collaborators.searchFocus.annotationSearchFocusResolvedTrackId;
      },
      set annotationSearchFocusResolvedTrackId(value) {
        collaborators.searchFocus.annotationSearchFocusResolvedTrackId = value;
      },
      get annotationSearchFocusResolvedCanonicalIdentity() {
        return collaborators.searchFocus.annotationSearchFocusResolvedCanonicalIdentity;
      },
      set annotationSearchFocusResolvedCanonicalIdentity(value) {
        collaborators.searchFocus.annotationSearchFocusResolvedCanonicalIdentity = value;
      },
      get annotationSearchFocusPresentationLane() {
        return collaborators.searchFocus.annotationSearchFocusPresentationLane;
      },
      set annotationSearchFocusPresentationLane(value) {
        collaborators.searchFocus.annotationSearchFocusPresentationLane = value;
      },
      get decorationCacheKey() {
        return collaborators.retained.decorationCacheKey;
      },
      set decorationCacheKey(value) {
        collaborators.retained.decorationCacheKey = value;
      },
      get decorationCacheAnchorViewStartBp() {
        return collaborators.retained.decorationCacheAnchorViewStartBp;
      },
      set decorationCacheAnchorViewStartBp(value) {
        collaborators.retained.decorationCacheAnchorViewStartBp = value;
      },
      get decorationCacheAnchorPpb() {
        return collaborators.retained.decorationCacheAnchorPpb;
      },
      set decorationCacheAnchorPpb(value) {
        collaborators.retained.decorationCacheAnchorPpb = value;
      },
      get decorationCacheBuiltLoBp() {
        return collaborators.retained.decorationCacheBuiltLoBp;
      },
      set decorationCacheBuiltLoBp(value) {
        collaborators.retained.decorationCacheBuiltLoBp = value;
      },
      get decorationCacheBuiltHiBp() {
        return collaborators.retained.decorationCacheBuiltHiBp;
      },
      set decorationCacheBuiltHiBp(value) {
        collaborators.retained.decorationCacheBuiltHiBp = value;
      },
      get retainedTranscriptDecorationBuilds() {
        return collaborators.retained.retainedTranscriptDecorationBuilds;
      },
      set retainedTranscriptDecorationBuilds(value) {
        collaborators.retained.retainedTranscriptDecorationBuilds = value;
      },
      disposePrepackedAnnotationScene: (status, recordOwnerChange) =>
        collaborators.prepacked.dispose(
          status as PrepackedAnnotationSceneStatus,
          recordOwnerChange
        ),
      resetTilePyramid: () => collaborators.tilePyramid.resetTilePyramid(),
      applyAnnotationPresentationPolicy: (policy) =>
        collaborators.prepacked.applyAnnotationPresentationPolicy(policy),
      clearCompiledBroadSurfaceRequirement: () =>
        collaborators.layout.clearCompiledBroadSurfaceRequirement(),
      releaseRetiredGpuResourcesAfterPresent: (force) =>
        collaborators.prepacked.releaseRetiredGpuResourcesAfterPresent(force),
      featureOffset: (feature) => collaborators.layout.featureOffset(feature),
      featureEnvelope: (feature) => collaborators.layout.featureEnvelope(feature),
      scaledBarHeight: () => collaborators.layout.scaledBarHeight(),
      cdsDetailProgress: () => collaborators.layout.cdsDetailProgress(),
      retainedLinearTranscriptFeatureKey: (features) =>
        collaborators.layout.retainedLinearTranscriptFeatureKey(features),
      retainedLinearTranscriptLayoutKey: (state) =>
        collaborators.layout.retainedLinearTranscriptLayoutKey(state),
      annotationLayerTypesForPresentation: () =>
        collaborators.layout.annotationLayerTypesForPresentation(),
      clearDrawState: () => collaborators.layout.clearDrawState(),
      clearDecorationCache: () => collaborators.retained.clearDecorationCache(),
      beginDrawAudit: (path, state, featuresToRender, useOverviewAggregation, overviewCache) =>
        collaborators.retained.beginDrawAudit(
          path,
          state,
          featuresToRender,
          useOverviewAggregation,
          overviewCache
        ),
      beginDrawAuditIfDiagnosticsEnabled: (
        path,
        state,
        featuresToRender,
        useOverviewAggregation,
        overviewCache
      ) =>
        collaborators.retained.beginDrawAuditIfDiagnosticsEnabled(
          path,
          state,
          featuresToRender,
          useOverviewAggregation,
          overviewCache
        ),
      renderInteractionOutlines: (path, state) =>
        collaborators.outlines.renderInteractionOutlines(path, state),
      renderImmediateFeature: (
        sink,
        feature,
        path,
        state,
        useOverviewAggregation,
        forceTinyFeatureShapes,
        alphaScale
      ) =>
        collaborators.immediateDraw.renderImmediateFeature(
          sink,
          feature,
          path,
          state,
          useOverviewAggregation,
          forceTinyFeatureShapes,
          alphaScale
        ),
      renderRetainedTranscriptDecorations: (batchedTranscriptSet, path, state, retainedFeatures) =>
        collaborators.retained.renderRetainedTranscriptDecorations(
          batchedTranscriptSet,
          path,
          state,
          retainedFeatures
        ),
      renderResidentFeatureLabels: (features, path, state) =>
        collaborators.immediateDraw.renderResidentFeatureLabels(features, path, state),
      recordDrawAuditDecision: (audit, feature, decision, path) =>
        collaborators.layout.recordDrawAuditDecision(audit, feature, decision, path),
      presentExclusiveAnnotationBodyFrame: (
        camera,
        style,
        prebuiltRasterEligibility,
        priorFrameHadCompleteBroadOwnership
      ) =>
        collaborators.bodyFrame.presentExclusiveAnnotationBodyFrame(
          camera,
          style,
          prebuiltRasterEligibility,
          priorFrameHadCompleteBroadOwnership
        ),
      activeResidentPublicationOwnsAnnotationBodyFallback: () =>
        collaborators.residentPages.activeResidentPublicationOwnsAnnotationBodyFallback(),
      selectResidentAnnotationFeaturesForViewport: (
        viewStartBp,
        viewEndBp,
        annotationSearchFocus = null
      ) => {
        const selected = collaborators.residentPages.selectResidentAnnotationFeaturesForViewport(
          viewStartBp,
          viewEndBp,
          annotationSearchFocus
        );
        return {
          status: selected.status,
          features: selected.features as Feature[],
        };
      },
      featuresInRange: (viewStartBp, viewEndBp) =>
        collaborators.layout.featuresInRange(viewStartBp, viewEndBp),
      hasFeaturesInRange: (viewStartBp, viewEndBp) =>
        collaborators.layout.hasFeaturesInRange(viewStartBp, viewEndBp),
      noteAnnotationBodyFrameOwner: (owner) =>
        collaborators.bodyFrame.noteAnnotationBodyFrameOwner(owner),
    } as RetainedLinearOverlayGlue;
  }

  get container() {
    return this.overlay.container;
  }
  get annotationSearchFocusGraphics() {
    return this.overlay.annotationSearchFocusGraphics;
  }
  get interactionGraphics() {
    return this.overlay.interactionGraphics;
  }
  get tilePyramid() {
    return this.overlay.tilePyramid;
  }
  get sidecarRaster() {
    return this.overlay.sidecarRaster;
  }
  get features() {
    return this.overlay.features;
  }
  get genomeLength() {
    return this.overlay.genomeLength;
  }
  set genomeLength(value) {
    this.overlay.genomeLength = value;
  }
  get currentGenomeIdentity() {
    return this.overlay.currentGenomeIdentity;
  }
  get currentAnnotationSourceFingerprint() {
    return this.overlay.currentAnnotationSourceFingerprint;
  }
  get currentAnnotationPlacementFingerprint() {
    return this.overlay.currentAnnotationPlacementFingerprint;
  }
  get _layout() {
    return this.overlay._layout;
  }
  get maxAnnotationLane() {
    return this.overlay.maxAnnotationLane;
  }
  get maxCdsLane() {
    return this.overlay.maxCdsLane;
  }
  get compiledBroadSurfaceOwnedLastFrame() {
    return this.overlay.compiledBroadSurfaceOwnedLastFrame;
  }
  set compiledBroadSurfaceOwnedLastFrame(value) {
    this.overlay.compiledBroadSurfaceOwnedLastFrame = value;
  }
  get compiledBroadSurfacePresenter() {
    return this.overlay.compiledBroadSurfacePresenter;
  }
  get compiledBroadSurfaceCandidatePresenter() {
    return this.overlay.compiledBroadSurfaceCandidatePresenter;
  }
  get compiledBroadSurfaceTrackOwners() {
    return this.overlay.compiledBroadSurfaceTrackOwners;
  }
  get compiledBroadSurfaceTrackCandidateOwners() {
    return this.overlay.compiledBroadSurfaceTrackCandidateOwners;
  }
  get compiledBroadAnnotationInteractionResidentGeneration() {
    return this.overlay.compiledBroadAnnotationInteractionResidentGeneration;
  }
  get compiledBroadAnnotationInteractionResidents() {
    return this.overlay.compiledBroadAnnotationInteractionResidents;
  }
  get prepackedAnnotationSceneResidents() {
    return this.overlay.prepackedAnnotationSceneResidents;
  }
  get prepackedAnnotationSceneReplacementCandidates() {
    return this.overlay.prepackedAnnotationSceneReplacementCandidates;
  }
  get prepackedAnnotationPolicyGeneration() {
    return this.overlay.prepackedAnnotationPolicyGeneration;
  }
  get prepackedAnnotationRuntimePolicy() {
    return this.overlay.prepackedAnnotationRuntimePolicy;
  }
  get prepackedAnnotationSceneOwnerKey() {
    return this.overlay.prepackedAnnotationSceneOwnerKey;
  }
  updatePrepackedAnnotationPolicy(policy: AnnotationPolicyGpuRuntimeV1): boolean {
    return this.overlay.updatePrepackedAnnotationPolicy(policy);
  }
  get prepackedAnnotationSceneVisiblePartitionCount() {
    return this.overlay.prepackedAnnotationSceneVisiblePartitionCount;
  }
  get prepackedAnnotationSceneVisibleInstanceCount() {
    return this.overlay.prepackedAnnotationSceneVisibleInstanceCount;
  }
  get prepackedAnnotationSceneFinePendingReason() {
    return this.overlay.prepackedAnnotationSceneFinePendingReason;
  }
  get prepackedAnnotationSceneStatus() {
    return this.overlay.prepackedAnnotationSceneStatus;
  }
  get prepackedAnnotationSceneLastCompleteOwnerKeys() {
    return this.overlay.prepackedAnnotationSceneLastCompleteOwnerKeys;
  }
  get prepackedAnnotationSceneOwnerMetadata() {
    return this.overlay.prepackedAnnotationSceneOwnerMetadata;
  }
  get compiledBroadSurfacePlanStatus() {
    return this.overlay.compiledBroadSurfacePlanStatus;
  }
  get compiledBroadSurfaceLastPresentationCamera() {
    return this.overlay.compiledBroadSurfaceLastPresentationCamera;
  }
  get compiledBroadSurfaceLastCameraRequest() {
    return this.overlay.compiledBroadSurfaceLastCameraRequest;
  }
  get compiledBroadSurfaceRequirement() {
    return this.overlay.compiledBroadSurfaceRequirement;
  }
  get tilePyramidVectorCompositor() {
    return this.tilePyramid.vector;
  }
  get rttGlyphTilePyramidCompositor() {
    return this.tilePyramid.rtt;
  }
  compiledBroadSurfacePresentingLayerTypes(): string[] {
    return this.overlay.compiledBroadSurfacePresentingLayerTypes();
  }
  prepackedAnnotationScenePresentingResidents(): Array<{ metadata: { trackType: string } }> {
    return this.overlay.prepackedAnnotationScenePresentingResidents();
  }
  compiledBroadSurfaceOwnerForTrack(
    trackType: string
  ): ReturnType<PresentationAuditHost['compiledBroadSurfaceOwnerForTrack']> {
    return this.overlay.compiledBroadSurfaceOwnerForTrack(trackType);
  }
  compiledBroadSurfaceProvenanceIsCurrent(manifest: unknown, provenance: unknown): boolean {
    return this.overlay.compiledBroadSurfaceProvenanceIsCurrent(manifest, provenance);
  }
  auditAnnotationDraw(state: RenderState): void {
    auditAnnotationDrawFn(this as never, state);
  }
  buildPresentationDebugSnapshot(): ReturnType<
    PresentationAuditHost['buildPresentationDebugSnapshot']
  > {
    return buildPresentationDebugSnapshotFn(this as never);
  }
  get retiredPrepackedAnnotationSceneLayers() {
    return this.overlay.retiredPrepackedAnnotationSceneLayers;
  }
  get prepackedAnnotationSceneLayerDestroys() {
    return this.overlay.prepackedAnnotationSceneLayerDestroys;
  }
  set prepackedAnnotationSceneLayerDestroys(value) {
    this.overlay.prepackedAnnotationSceneLayerDestroys = value;
  }
  get annotationBodyFrameOwner() {
    return this.overlay.annotationBodyFrameOwner;
  }
  set annotationBodyFrameOwner(value) {
    this.overlay.annotationBodyFrameOwner = value;
  }
  get annotationBodyFrameEligibility() {
    return this.overlay.annotationBodyFrameEligibility;
  }
  set annotationBodyFrameEligibility(value) {
    this.overlay.annotationBodyFrameEligibility = value;
  }
  get annotationSearchFocusResolvedTrackId() {
    return this.overlay.annotationSearchFocusResolvedTrackId;
  }
  set annotationSearchFocusResolvedTrackId(value) {
    this.overlay.annotationSearchFocusResolvedTrackId = value;
  }
  get annotationSearchFocusResolvedCanonicalIdentity() {
    return this.overlay.annotationSearchFocusResolvedCanonicalIdentity;
  }
  set annotationSearchFocusResolvedCanonicalIdentity(value) {
    this.overlay.annotationSearchFocusResolvedCanonicalIdentity = value;
  }
  get annotationSearchFocusPresentationLane() {
    return this.overlay.annotationSearchFocusPresentationLane;
  }
  set annotationSearchFocusPresentationLane(value) {
    this.overlay.annotationSearchFocusPresentationLane = value;
  }
  get featureWindowIndex() {
    return this.overlay.featureWindowIndex;
  }
  get hitCache() {
    return this.overlay.hitCache;
  }
  get outlineCache() {
    return this.overlay.outlineCache;
  }

  disposePrepackedAnnotationScene(status: string, recordOwnerChange?: boolean): void {
    this.overlay.disposePrepackedAnnotationScene(status, recordOwnerChange);
  }
  resetTilePyramid(): void {
    this.overlay.resetTilePyramid();
  }
  applyAnnotationPresentationPolicy(policy: AnnotationPolicyGpuRuntimeV1): boolean | 'deferred' {
    return this.overlay.applyAnnotationPresentationPolicy(policy);
  }
  clearCompiledBroadSurfaceRequirement(): void {
    this.overlay.clearCompiledBroadSurfaceRequirement();
  }
  releaseRetiredGpuResourcesAfterPresent(force?: boolean): void {
    this.overlay.releaseRetiredGpuResourcesAfterPresent(force);
  }
  featureOffset(feature: Feature): number {
    return this.overlay.featureOffset(feature);
  }
  featureEnvelope(feature: Feature): { centerOffset: number } | null {
    return this.overlay.featureEnvelope(feature);
  }
  scaledBarHeight(): number {
    return this.overlay.scaledBarHeight();
  }
  cdsDetailProgress(): number {
    return this.overlay.cdsDetailProgress();
  }
  retainedLinearTranscriptFeatureKey(features: readonly Feature[]): string {
    return this.overlay.retainedLinearTranscriptFeatureKey(features);
  }
  retainedLinearTranscriptLayoutKey(state: RenderState): string {
    return this.overlay.retainedLinearTranscriptLayoutKey(state);
  }
  annotationLayerTypesForPresentation(): string[] {
    return this.overlay.annotationLayerTypesForPresentation();
  }
  clearDrawState(): void {
    this.overlay.clearDrawState();
  }
  clearDecorationCache(): void {
    this.retainedTranscriptDecorationGraphics.clear();
    this.retainedTranscriptDecorationGraphics.position.x = 0;
    this.decorationCacheKey = '';
  }

  acquireLabel(): Text {
    let t: Text;
    if (this.labelIndex < this.labelPool.length) {
      t = this.labelPool[this.labelIndex];
      t.visible = true;
    } else {
      t = new Text({
        text: '',
        style: pillLabelTextStyle(0xffffff),
        resolution: targetPillLabelTextResolution(),
      });
      this.overlay.container.addChild(t);
      this.labelPool.push(t);
    }
    this.labelIndex++;
    return t;
  }

  reservePillBounds(
    state: RenderState,
    path: PathMapper,
    startBp: number,
    widthPx: number,
    offset: number,
    halfHeight: number,
    record: { kind: string; featureId?: number; text?: string },
    force = false
  ): boolean {
    return reserveAnnotationPillBounds(
      this,
      state,
      path,
      startBp,
      widthPx,
      offset,
      halfHeight,
      record,
      force
    );
  }
  beginDrawAudit(
    path: PathMapper,
    state: RenderState,
    featuresToRender: readonly Feature[],
    useOverviewAggregation: boolean,
    overviewCache: DrawAuditOverviewCache | null
  ): AnnotationDrawAuditSnapshot {
    return beginDrawAuditFn(
      this as never,
      path,
      state,
      featuresToRender,
      useOverviewAggregation,
      overviewCache
    );
  }
  beginDrawAuditIfDiagnosticsEnabled(
    path: PathMapper,
    state: RenderState,
    featuresToRender: readonly Feature[],
    useOverviewAggregation: boolean,
    overviewCache: DrawAuditOverviewCache | null
  ): AnnotationDrawAuditSnapshot | null {
    return beginDrawAuditIfDiagnosticsEnabledFn(
      this as never,
      path,
      state,
      featuresToRender,
      useOverviewAggregation,
      overviewCache
    );
  }
  renderInteractionOutlines(path: PathMapper, state: RenderState): void {
    this.overlay.renderInteractionOutlines(path, state);
  }
  renderImmediateFeature(
    sink: FeaturePrimitiveSink,
    feature: Feature,
    path: PathMapper,
    state: RenderState,
    useOverviewAggregation: boolean,
    forceTinyFeatureShapes = false,
    alphaScale = 1
  ): AnnotationDrawAuditDecision {
    return this.overlay.renderImmediateFeature(
      sink,
      feature,
      path,
      state,
      useOverviewAggregation,
      forceTinyFeatureShapes,
      alphaScale
    );
  }
  renderRetainedTranscriptDecorations(
    batchedTranscriptSet: Set<Feature> | null,
    path: PathMapper,
    state: RenderState,
    retainedFeatures?: readonly Feature[]
  ): void {
    renderRetainedTranscriptDecorationsFn(
      this as never,
      batchedTranscriptSet,
      path,
      state,
      retainedFeatures ?? this.overlay.features
    );
  }
  renderResidentAnnotationLabels(
    features: readonly Feature[],
    path: PathMapper,
    state: RenderState
  ): void {
    this.labelIndex = 0;
    this.curvedLabels.reset();
    this.labelOccupancyCache = [];
    this.overlay.renderResidentFeatureLabels(features, path, state);
    for (let index = this.labelIndex; index < this.labelPool.length; index += 1) {
      this.labelPool[index].visible = false;
    }
  }
  recordDrawAuditDecision(
    audit: AnnotationDrawAuditSnapshot,
    feature: Feature,
    decision: AnnotationDrawAuditDecision,
    path: PathMapper
  ): void {
    this.overlay.recordDrawAuditDecision(audit, feature, decision, path);
  }
  presentExclusiveAnnotationBodyFrame(
    camera: RetainedOverlayCameraState,
    style: RetainedOverviewAnnotationStyle,
    prebuiltRasterEligibility: AnnotationPrebuiltRasterEligibility,
    priorFrameHadCompleteBroadOwnership: boolean
  ): boolean {
    return this.overlay.presentExclusiveAnnotationBodyFrame(
      camera,
      style,
      prebuiltRasterEligibility,
      priorFrameHadCompleteBroadOwnership
    );
  }
  activeResidentPublicationOwnsAnnotationBodyFallback(): boolean {
    return this.overlay.activeResidentPublicationOwnsAnnotationBodyFallback();
  }
  selectResidentAnnotationFeaturesForViewport(
    viewStartBp: number,
    viewEndBp: number,
    annotationSearchFocus: RenderState['annotationSearchFocus'] = null
  ): { status: string; features: Feature[] } | null {
    return this.overlay.selectResidentAnnotationFeaturesForViewport(
      viewStartBp,
      viewEndBp,
      annotationSearchFocus
    );
  }
  featuresInRange(viewStartBp: number, viewEndBp: number): Feature[] {
    return this.overlay.featuresInRange(viewStartBp, viewEndBp);
  }
  hasFeaturesInRange(viewStartBp: number, viewEndBp: number): boolean {
    return this.overlay.hasFeaturesInRange(viewStartBp, viewEndBp);
  }
  noteAnnotationBodyFrameOwner(owner: AnnotationBodyFrameOwnerKind): void {
    this.overlay.noteAnnotationBodyFrameOwner(owner);
  }
  renderKeyParts(state: RenderState): Record<string, string> {
    return this.overlay.renderKeyParts(state);
  }
  renderKeyFromParts(parts: Record<string, string>): string {
    return this.overlay.renderKeyFromParts(parts);
  }
  renderKeyChangeReasons(next: Record<string, string>): string[] {
    return this.overlay.renderKeyChangeReasons(next);
  }
  drawRetainedTranscriptIntronConnectors(
    g: Graphics,
    feature: Feature,
    path: PathMapper,
    state: RenderState,
    alpha: number,
    clipRange?: { lo: number; hi: number }
  ): void {
    this.overlay.drawRetainedTranscriptIntronConnectors(g, feature, path, state, alpha, clipRange);
  }
  renderSetLayerTypesForAudit(featuresToRender: readonly Feature[]): string[] {
    return renderSetLayerTypesForAuditFn(
      { annotationLayerTypesForPresentation: () => this.annotationLayerTypesForPresentation() },
      featuresToRender,
      normalizeAnnotationLayerTypes
    );
  }

  ensureRetainedOverviewLayer(): RetainedOverviewAnnotationLayer {
    return ensureRetainedOverviewLayerFn(this);
  }
  ensureRetainedLinearFeatureLayer(): RetainedLinearFeatureLayer {
    return ensureRetainedLinearFeatureLayerFn(this);
  }
  ensureRetainedLinearTranscriptLayer(): RetainedLinearTranscriptLayer {
    return ensureRetainedLinearTranscriptLayerFn(this);
  }
  ensureGenomeWideTextureCacheLayer(): GenomeWideTextureCacheLayer {
    return ensureGenomeWideTextureCacheLayerFn(this);
  }
  setRenderer(renderer: Renderer | null): void {
    setRendererFn(this, renderer);
  }
  buildRetainedData(): void {
    buildRetainedDataFn(this, NO_PREBUILT_RASTER_CONTRACT_MATCH);
  }
  buildGenomeWideCompositeArgs(
    path: PathMapper,
    state: RenderState
  ): GenomeWideTextureCompositeArgs | null {
    return buildGenomeWideCompositeArgsFn(this, path, state);
  }
  loadPrebuiltGenomeWideTexture(image: ImageBitmap, meta: PrebuiltGenomeWideTextureMeta): void {
    loadPrebuiltGenomeWideTextureFn(this, image, meta, NO_PREBUILT_RASTER_CONTRACT_MATCH);
  }
  clearPrebuiltGenomeWideTexture(): void {
    clearPrebuiltGenomeWideTextureFn(this, NO_PREBUILT_RASTER_CONTRACT_MATCH);
  }
  isPrebuiltGenomeWideTextureLoaded(): boolean {
    return isPrebuiltGenomeWideTextureLoadedFn(this);
  }
  forceMeshOverview(): boolean {
    return forceMeshOverviewFn();
  }
  prebuiltRasterTexelsPerDevicePx(camera: RetainedOverlayCameraState): number {
    return prebuiltRasterTexelsPerDevicePxFn(this, camera);
  }
  prebuiltRasterEligibility(
    camera: RetainedOverlayCameraState
  ): AnnotationPrebuiltRasterEligibility {
    return prebuiltRasterEligibilityFn(this, camera);
  }
  buildAndExtractGenomeWideTexturePng(): ReturnType<typeof buildAndExtractGenomeWideTexturePngFn> {
    return buildAndExtractGenomeWideTexturePngFn(this);
  }
  setPresentationVisible(visible: boolean): void {
    setPresentationVisibleFn(this, visible);
  }
  resetRenderStats(): void {
    resetRenderStatsFn(this);
  }
  resetImmediateDrawStats(): void {
    resetImmediateDrawStatsFn(this);
  }
  resetRetainedOverviewDebug(opts: { preserveTranscriptMesh?: boolean } = {}): void {
    resetRetainedOverviewDebugFn(this, opts);
  }
  retainedOverviewFallback(reason: RetainedOverlayFallbackReason): false {
    return retainedOverviewFallbackFn(this, reason);
  }
  clearImmediateStateForCompiledAnnotationOwner(): void {
    clearImmediateStateForCompiledAnnotationOwnerFn(this);
  }
  resetAllPresentersToHidden(preserveCommittedCompiledBroadSurface = false): void {
    resetAllPresentersToHiddenFn(this, {
      preserveCommittedCompiledBroadSurface,
    });
  }
  hideCompiledBroadPresenters(): void {
    hideCompiledBroadPresentersFn(this);
  }
  hideAllPresentationSurfaces(): void {
    hideAllPresentationSurfacesFn(this);
  }
  renderHiddenPresentation(camera: RetainedOverlayCameraState): boolean {
    return renderHiddenPresentationFn(this, camera);
  }
  renderImmediateShapesForLodTransition(
    path: PathMapper,
    state: RenderState,
    passthroughFeatures: Feature[],
    fullShapeBlend: number
  ): void {
    renderImmediateShapesForLodTransitionFn(this, path, state, passthroughFeatures, fullShapeBlend);
  }
  syncRetainedLinearOverviewLayers(
    path: PathMapper,
    state: RenderState,
    overviewCache: OverviewAggregationCache,
    featuresToRender: readonly Feature[]
  ): Set<Feature> | null {
    return syncRetainedLinearOverviewLayersFn(this, path, state, overviewCache, featuresToRender);
  }
  runInvariantGuardAfterRetainedSync(
    transcripts: Feature[],
    blockCount: number,
    transcriptKey: string,
    path: PathMapper
  ): void {
    runInvariantGuardAfterRetainedSyncFn(this, transcripts, blockCount, transcriptKey, path);
  }
  presentEmptyRetainedLinearViewport(
    camera: RetainedOverlayCameraState,
    style: RetainedOverviewAnnotationStyle,
    overviewVisibleBp: number,
    prebuiltLayer: GenomeWideTextureCacheLayer | null | undefined
  ): boolean {
    return presentEmptyRetainedLinearViewportFn(
      this,
      camera,
      style,
      overviewVisibleBp,
      prebuiltLayer
    );
  }
  updateRetainedLinearCameraInner(camera: RetainedOverlayCameraState): boolean {
    return updateRetainedLinearCameraInnerFn(this, camera);
  }
  updateRetainedLinearCamera(camera: RetainedOverlayCameraState): boolean {
    const handled = this.updateRetainedLinearCameraInner(camera);
    if (
      (globalThis as unknown as { __DNA708_FORCE_DOUBLE_DRAW?: boolean })
        .__DNA708_FORCE_DOUBLE_DRAW === true
    ) {
      this.ensureRetainedLinearTranscriptLayer().forcePresentForTest();
    }
    this.overlay.auditAnnotationDraw(camera.state);
    return handled;
  }
  updateRetainedCamera(camera: RetainedOverlayCameraState): boolean {
    return updateRetainedStadiumCamera(this, camera);
  }
  overviewCacheContext(): AnnotationOverviewCacheContext {
    return overviewCacheContextFn(
      {
        features: this.overlay.features,
        genomeLength: this.overlay.genomeLength,
        _layout: this.overlay._layout,
        maxAnnotationLane: this.overlay.maxAnnotationLane,
        maxCdsLane: this.overlay.maxCdsLane,
        featureOffset: (feature) => this.overlay.featureOffset(feature),
        scaledBarHeight: () => this.overlay.scaledBarHeight(),
      },
      annotationFeatureGetColor,
      annotationFeatureIsOutlineOnly,
      annotationFeatureIsSpliced,
      annotationFeatureIsTranscript
    );
  }
  sealCompiledBroadPresentedFrame(
    camera: RetainedOverlayCameraState,
    options: { clearImmediate: boolean }
  ): true {
    return sealCompiledBroadPresentedFrameFn(this, camera, options);
  }
  finalizeCompiledAnnotationBodyPresent(
    camera: RetainedOverlayCameraState,
    style: RetainedOverviewAnnotationStyle
  ): void {
    finalizeCompiledAnnotationBodyPresentFn(this, camera, style);
  }
  tryPresentPrebuiltRasterBody(
    camera: RetainedOverlayCameraState,
    style: RetainedOverviewAnnotationStyle,
    prebuiltRasterEligibility: AnnotationPrebuiltRasterEligibility
  ): boolean {
    return tryPresentPrebuiltRasterBodyFn(this, camera, style, prebuiltRasterEligibility);
  }
  hashRetainedLinearTranscriptFeatureKey(featuresToRender: readonly Feature[]): string {
    return hashRetainedLinearTranscriptFeatureKeyFn(this, featuresToRender);
  }
  retainedLinearSourceFeaturesForViewport(path: PathMapper): Feature[] {
    return retainedLinearSourceFeaturesForViewportFn(this, path);
  }
  finalizeRetainedImmediateLinearFrame(
    camera: RetainedOverlayCameraState,
    style: RetainedOverviewAnnotationStyle
  ): boolean {
    this.retainedOverviewMode = 'retained';
    this.retainedOverviewStyle = style;
    this.retainedOverviewCameraUpdates += 1;
    this.retainedOverviewFallbackReason = null;
    this.retainedOverviewInstanceCount = this.retainedLinearTranscriptBlockCount;
    this.retainedOverviewVisibleInstanceCount =
      this.retainedLinearTranscriptBlockCount + this.lastDrawnFeatureCount;
    this.retainedOverviewHitBins = [];
    this.retainedOverviewPassthroughDrawn =
      this.retainedLinearTranscriptBlockCount > 0 || this.lastDrawnFeatureCount > 0;
    this.renderInteractionOutlines(camera.path, camera.state);
    this.noteAnnotationBodyFrameOwner('retained-immediate');
    return true;
  }
  destroy(): void {
    destroyAnnotationOverlayFn(this);
  }
}

declare module './indexed-annotation-overlay-collaborators' {
  interface OverlayRetainedCollaborator extends RetainedLinearPresenter {}
}
