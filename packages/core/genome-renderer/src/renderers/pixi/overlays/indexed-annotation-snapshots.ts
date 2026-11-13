import type { Feature } from '../../../types';
import type { UnifiedLayout } from '../shared/track-layout';
import type {
  CompiledBroadSurfaceAdmissionProvenanceV1,
  CompiledBroadSurfaceManifestV2,
} from '../overview/bounded-annotation-broad-surface';
import type { CompiledBroadSurfacePixiPresenterV2 } from '../overview/compiled-broad-surface-pixi-presenter';
import type {
  PrepackedAnnotationSceneMetadata,
  PrepackedAnnotationSceneOwnerSnapshot,
  PrepackedAnnotationSceneStatus,
} from '../overview/prepacked-annotation-scene';
import type { AnnotationPolicyGpuRuntimeV1 } from '../overview/annotation-policy-gpu-instances-v1';
import type { PrebuiltAnnotationRasterContractMatch } from '../overview/prebuilt-annotation-raster-contract';
import { getRetainedLinearTranscriptPackDebugSnapshot } from '../overview/retained-linear-transcript-layer';
import { PREPACKED_ANNOTATION_INTERACTION_INDEX_V2 } from '../overview/prepacked-annotation-interaction-index-v2';
import {
  isOutlineOnlyFeature,
  normalizeAnnotationLayerTypes as annotationFeatureNormalizeLayerTypes,
} from './annotation-feature-semantics';
import { visualGroupsForLayerTypes } from './annotation-presentation-owners';
import {
  annotationDebugLayoutSnapshot,
  type AnnotationPresentationDebugSnapshot,
} from './annotation-presentation-debug';
import type { AnnotationDrawAuditSnapshot } from './annotation-draw-audit';
import type {
  CompiledBroadSurfaceSteadyRosterV2,
  CompiledBroadSurfaceTrackOwnerV2,
} from './indexed-compiled-broad-frame';
import {
  ANNOTATION_OVERLAY_COLD_GESTURE_SNAPSHOT_V1,
  type AnnotationColdGestureOwnerId,
  type AnnotationOverlayColdGestureSnapshot,
  type AnnotationOverlayDebugSnapshot,
} from './annotation-overlay-types';

const EMPTY_COLD_GESTURE_STRING_VALUES = Object.freeze([]) as readonly string[];
const EMPTY_COLD_GESTURE_NUMBER_VALUES = Object.freeze([]) as readonly number[];

export type AnnotationSnapshotResident = {
  ownerKey: string;
  policyGeneration?: number;
  viewportDetailPresentationAdmitted?: boolean;
  visiblePartitionCount?: number;
  visibleInstanceCount?: number;
  metadata: Pick<
    PrepackedAnnotationSceneMetadata,
    'trackType' | 'artifactKey' | 'genomeIdentity' | 'genomeLengthBp'
  > &
    Partial<PrepackedAnnotationSceneMetadata>;
  input?: {
    gpuReadyScene?: { featureIndices?: ArrayLike<number> } | null;
    viewportDetail?: {
      coverageStartBp?: number | null;
      coverageEndBp?: number | null;
      handoffStartBp?: number | null;
      handoffEndBp?: number | null;
    } | null;
    interactionIndex?: {
      featureCount: number;
      primitiveCount: number;
    } | null;
  };
  layer?: {
    isGpuPrepared?: boolean;
    isPresenting?: boolean;
    getSubmissionDebug?(): {
      activeMode: string | null;
      hiddenByIsoformMembershipInstanceCount: number;
      hiddenByLaneCapInstanceCount: number;
    };
    getPresentationLayoutDebug?(): {
      screenAnchorYCssPx: number;
      viewportWidthCssPx: number;
      viewportHeightCssPx: number;
    };
    getAdmissionValidationDebug?(): {
      trustedV4Admission: boolean;
      trustedDetailPacketAdmission: boolean;
      directFineIndexValidationCount: number;
      directFineIndexRecordScanCardinality: number;
    };
  };
};

export type AnnotationSnapshotMap<T> = {
  readonly size: number;
  get(key: string): T | undefined;
  has(key: string): boolean;
  keys(): Iterable<string>;
  values(): Iterable<T>;
};

export type AnnotationSnapshotHost = {
  compiledBroadSurfaceManifest: CompiledBroadSurfaceManifestV2 | null;
  compiledBroadSurfaceProvenance: CompiledBroadSurfaceAdmissionProvenanceV1 | null;
  compiledBroadSurfacePresenter: CompiledBroadSurfacePixiPresenterV2 | null;
  compiledBroadSurfaceTrackOwners: { values(): Iterable<CompiledBroadSurfaceTrackOwnerV2> };
  compiledBroadSurfacePresentingLayerTypes(): string[];
  compiledBroadSurfaceOwnerForTrack(trackType: string): CompiledBroadSurfaceTrackOwnerV2 | null;
  compiledBroadSurfaceProvenanceIsCurrent(
    manifest: CompiledBroadSurfaceManifestV2 | null,
    provenance: CompiledBroadSurfaceAdmissionProvenanceV1 | null
  ): boolean;
  annotationLayerTypesForPresentation(): string[];
  annotationRequestedLayerTypes: readonly string[];
  prepackedAnnotationSceneLastCompleteOwnerKeys: ReadonlyArray<string>;
  prepackedAnnotationSceneResidents: AnnotationSnapshotMap<AnnotationSnapshotResident>;
  requestedPrepackedAnnotationSceneResidentForTrack(
    trackType: string
  ): AnnotationSnapshotResident | null;
  prepackedAnnotationScenePresentingResidents(): AnnotationSnapshotResident[];
  prepackedAnnotationPolicyGeneration: number;
  prebuiltRasterContractForLastFrame: PrebuiltAnnotationRasterContractMatch;
  presentationVisible: boolean;
  genomeWideTextureCacheLayer: {
    runtimeTexturePresenting?: boolean;
    prebuiltTexturePresenting?: boolean;
    prebuiltCompositeCount?: number;
    prebuiltWidthPx?: number;
    prebuiltResolution?: number;
    hasPrebuilt(): boolean;
  } | null;
  prebuiltRasterEligibleForLastFrame: boolean;
  rttGlyphTilePyramidCompositor: {
    isPresenting?: boolean;
    visibleLayerCount?: number;
    presentingTileCount?: number;
    buildCount?: number;
    compositeCount?: number;
    drawLevel?: number | null;
    targetLevel?: number | null;
  } | null;
  tilePyramidVectorCompositor: {
    isPresenting?: boolean;
    visibleLayerCount?: number;
    presentingBlockCount?: number;
    coverageComplete?: boolean;
  } | null;
  retainedLinearTranscriptLayer: { isPresenting?: boolean } | null;
  retainedLinearTranscriptBlockCount: number;
  retainedLinearFeatureLayer: { isPresenting?: boolean } | null;
  retainedLinearBinCount: number;
  graphics: { visible: boolean };
  lastDrawnFeatureCount: number;
  lastImmediateDrawnLayerTypes: ReadonlySet<string>;
  prepackedAnnotationSceneOwnerMetadata: PrepackedAnnotationSceneMetadata | null;
  prepackedAnnotationRuntimePolicy: AnnotationPolicyGpuRuntimeV1 | null;
  compiledBroadAnnotationInteractionResidentGeneration: number;
  prepackedAnnotationSceneOwnerGeneration: number;
  compiledBroadSurfaceSteadyRoster: Pick<
    CompiledBroadSurfaceSteadyRosterV2,
    'isoformMode' | 'laneLimit'
  > | null;
  currentGenomeIdentity: string;
  genomeLength: number;
  currentAnnotationSourceFingerprint: string | null;
  currentAnnotationPlacementFingerprint: string | null;
  compiledBroadSurfacePlanStatus: AnnotationOverlayDebugSnapshot['compiledBroadSurfacePlanStatus'];
  compiledBroadAnnotationInteractionResidents: Pick<AnnotationSnapshotMap<unknown>, 'has' | 'keys'>;
  prepackedAnnotationSceneOwnerKey: string | null;
  prepackedAnnotationSceneResidentGeneration: number;
  prepackedAnnotationSceneLayer: {
    isGpuPrepared?: boolean;
    getAdmissionValidationDebug(): {
      trustedV4Admission: boolean;
      trustedDetailPacketAdmission: boolean;
      directFineIndexValidationCount: number;
      directFineIndexRecordScanCardinality: number;
    };
  } | null;
  prepackedAnnotationSceneInput: object | null;
  prepackedAnnotationSceneStatus: PrepackedAnnotationSceneStatus;
  prepackedAnnotationSceneLayerCreates: number;
  prepackedAnnotationSceneLayerDestroys: number;
  prepackedAnnotationSceneGpuPreparations: number;
  prepackedAnnotationSceneVisiblePartitionCount: number;
  prepackedAnnotationSceneVisibleInstanceCount: number;
  prepackedAnnotationSceneStartupBuilds: number;
  retainedLinearDataBuilds: number;
  retainedLinearTranscriptBuilds: number;
  retainedTranscriptDecorationBuilds: number;
  buildPresentationDebugSnapshot(): AnnotationPresentationDebugSnapshot;
  getPrepackedAnnotationSceneOwnerSnapshot(): PrepackedAnnotationSceneOwnerSnapshot;
  labelIndex: number;
  labelPool: ReadonlyArray<{ alpha: number; resolution: number }>;
  curvedLabels: {
    destroy?(): void;
    reset?(): void;
    activeCount?: number;
    activeRotations?: number[];
    activeFontSizes?: number[];
    activeScales?: number[];
    activeResolutions?: number[];
    activePositions?: Array<{ x: number; y: number }>;
  };
  overviewBinDrawCount: number;
  annotationResidentPageStore: {
    residentPageCount: number;
    residentByteCount: number;
  } | null;
  residentAnnotationPageSnapshotApplies: number;
  residentAnnotationPageFlatGraphSkips: number;
  residentAnnotationViewportSelectionStatus: 'unavailable' | 'ready' | 'incomplete';
  residentAnnotationViewportSelectionQueries: number;
  residentAnnotationViewportSelectedPageCount: number;
  residentAnnotationViewportSelectedFeatureCount: number;
  residentAnnotationViewportExpectedPageCount: number;
  residentAnnotationViewportMissingPageCount: number;
  residentAnnotationViewportCoverageComplete: boolean;
  residentAnnotationViewportProducerCoverageComplete: boolean;
  retainedLinearTranscriptStaleHolds: number;
  retainedLinearTranscriptLastBuildCause: string;
  compiledBroadSurfaceRgbaAdmissions: number;
  compiledBroadSurfaceGpuPreuploads: number;
  compiledBroadSurfaceExplicitRgbaCopyBytes: number;
  compiledBroadSurfaceGpuPreuploadedBytes: number;
  compiledBroadSurfacePostPresentGpuUploads: number;
  compiledBroadSurfacePostPresentGpuUploadBytes: number;
  compiledBroadSurfacePlanDerivationCount: number;
  compiledBroadSurfaceCameraContractCreateCount: number;
  compiledBroadSurfaceFastCameraMailboxCreateCount: number;
  compiledBroadSurfaceGpuPreuploadFailures: number;
  retainedLinearTranscriptVisibleFeatureCount: number;
  lastRetainedTranscriptDecorationsDrawn: boolean;
  retainedLinearSourceWindow: {
    startBp: number;
    endBp: number;
    features: Feature[];
  } | null;
  featureEnvelope(feature: Feature): unknown;
  lastInteractionOutlineCommandCount: number;
  annotationSearchFocusMaskDrawCount: number;
  annotationSearchFocusPrimitiveDrawCount: number;
  annotationSearchFocusResolvedTrackId: string | null;
  annotationSearchFocusResolvedCanonicalIdentity: string | null;
  annotationSearchFocusPresentationLane: number | null;
  features: ReadonlyArray<Pick<Feature, 'type'>>;
  hitCache: { length: number };
  renderCallCount: number;
  geometryRebuildCount: number;
  geometryCacheHitCount: number;
  lastRenderMode: AnnotationOverlayDebugSnapshot['lastRenderMode'];
  lastGeometryRebuildReasons: string[];
  lastOverviewAggregationEnabled: boolean;
  lastOverviewAggregationCacheHit: boolean;
  lastOverviewPassthroughFeatureCount: number;
  lastOverviewDensityAtlasBinBp: number;
  lastOverviewDensityAtlasSampleScreenPx: number;
  lastOverviewDensityAtlasLevelCount: number;
  lastOverviewDensityAtlasEstimatedBinCount: number;
  lastOverviewDensityAtlasWasCoarsened: boolean;
  lastOverviewDensityAtlasBudgetExceeded: boolean;
  lastOverviewLodCompressionBlend: number;
  lastOverviewLodFullShapeBlend: number;
  lastOverviewCacheMs: number;
  lastOverviewImmediateBlendMs: number;
  retiredPrepackedAnnotationSceneLayers: { readonly size: number };
  prepackedAnnotationSceneCameraUpdates: number;
  prepackedAnnotationInteractionCouplingValidationCount: number;
  prepackedAnnotationInteractionCouplingPrimitiveScanCardinality: number;
  prepackedAnnotationTrustedV4AdmissionCount: number;
  prepackedAnnotationInteractionQueries: number;
  prepackedAnnotationInteractionLastVisitedNodes: number;
  prepackedAnnotationInteractionMaxVisitedNodes: number;
  prepackedAnnotationInteractionLastPrimitiveCandidates: number;
  prepackedAnnotationInteractionP99Ms(): number;
  prepackedAnnotationInteractionMaxMs: number;
  _layout: UnifiedLayout | null;
  maxAnnotationLane: number;
  maxCdsLane: number;
  lastDrawAudit: AnnotationDrawAuditSnapshot | null;
};

export type AnnotationSnapshotSources = {
  retained: Pick<
    AnnotationSnapshotHost,
    | 'presentationVisible'
    | 'prebuiltRasterContractForLastFrame'
    | 'genomeWideTextureCacheLayer'
    | 'prebuiltRasterEligibleForLastFrame'
    | 'retainedLinearTranscriptLayer'
    | 'retainedLinearTranscriptBlockCount'
    | 'retainedLinearFeatureLayer'
    | 'retainedLinearBinCount'
    | 'lastDrawnFeatureCount'
    | 'lastImmediateDrawnLayerTypes'
    | 'retainedLinearDataBuilds'
    | 'retainedLinearTranscriptBuilds'
    | 'overviewBinDrawCount'
    | 'retainedLinearTranscriptStaleHolds'
    | 'retainedLinearTranscriptLastBuildCause'
    | 'retainedLinearTranscriptVisibleFeatureCount'
    | 'lastRetainedTranscriptDecorationsDrawn'
    | 'retainedLinearSourceWindow'
    | 'renderCallCount'
    | 'geometryRebuildCount'
    | 'geometryCacheHitCount'
    | 'lastRenderMode'
    | 'lastGeometryRebuildReasons'
    | 'lastOverviewAggregationEnabled'
    | 'lastOverviewAggregationCacheHit'
    | 'lastOverviewPassthroughFeatureCount'
    | 'lastOverviewDensityAtlasBinBp'
    | 'lastOverviewDensityAtlasSampleScreenPx'
    | 'lastOverviewDensityAtlasLevelCount'
    | 'lastOverviewDensityAtlasEstimatedBinCount'
    | 'lastOverviewDensityAtlasWasCoarsened'
    | 'lastOverviewDensityAtlasBudgetExceeded'
    | 'lastOverviewLodCompressionBlend'
    | 'lastOverviewLodFullShapeBlend'
    | 'lastOverviewCacheMs'
    | 'lastOverviewImmediateBlendMs'
    | 'lastDrawAudit'
    | 'buildPresentationDebugSnapshot'
  >;
  prepacked: Pick<
    AnnotationSnapshotHost,
    | 'prepackedAnnotationSceneLastCompleteOwnerKeys'
    | 'prepackedAnnotationSceneResidents'
    | 'prepackedAnnotationPolicyGeneration'
    | 'prepackedAnnotationSceneOwnerMetadata'
    | 'prepackedAnnotationRuntimePolicy'
    | 'prepackedAnnotationSceneOwnerGeneration'
    | 'prepackedAnnotationSceneOwnerKey'
    | 'prepackedAnnotationSceneResidentGeneration'
    | 'prepackedAnnotationSceneLayer'
    | 'prepackedAnnotationSceneInput'
    | 'prepackedAnnotationSceneStatus'
    | 'prepackedAnnotationSceneLayerCreates'
    | 'prepackedAnnotationSceneLayerDestroys'
    | 'prepackedAnnotationSceneGpuPreparations'
    | 'prepackedAnnotationSceneVisiblePartitionCount'
    | 'prepackedAnnotationSceneVisibleInstanceCount'
    | 'prepackedAnnotationSceneStartupBuilds'
    | 'retiredPrepackedAnnotationSceneLayers'
    | 'prepackedAnnotationSceneCameraUpdates'
    | 'prepackedAnnotationInteractionCouplingValidationCount'
    | 'prepackedAnnotationInteractionCouplingPrimitiveScanCardinality'
    | 'prepackedAnnotationTrustedV4AdmissionCount'
  >;
  compiled: Pick<
    AnnotationSnapshotHost,
    | 'compiledBroadSurfaceManifest'
    | 'compiledBroadSurfaceProvenance'
    | 'compiledBroadSurfacePresenter'
    | 'compiledBroadSurfaceTrackOwners'
    | 'compiledBroadSurfacePresentingLayerTypes'
    | 'compiledBroadSurfaceOwnerForTrack'
    | 'compiledBroadSurfaceProvenanceIsCurrent'
    | 'compiledBroadAnnotationInteractionResidentGeneration'
    | 'compiledBroadSurfaceSteadyRoster'
    | 'compiledBroadSurfacePlanStatus'
    | 'compiledBroadAnnotationInteractionResidents'
    | 'compiledBroadSurfaceRgbaAdmissions'
    | 'compiledBroadSurfaceGpuPreuploads'
    | 'compiledBroadSurfaceExplicitRgbaCopyBytes'
    | 'compiledBroadSurfaceGpuPreuploadedBytes'
    | 'compiledBroadSurfacePostPresentGpuUploads'
    | 'compiledBroadSurfacePostPresentGpuUploadBytes'
    | 'compiledBroadSurfacePlanDerivationCount'
    | 'compiledBroadSurfaceCameraContractCreateCount'
    | 'compiledBroadSurfaceFastCameraMailboxCreateCount'
    | 'compiledBroadSurfaceGpuPreuploadFailures'
    | 'requestedPrepackedAnnotationSceneResidentForTrack'
  >;
  layout: Pick<
    AnnotationSnapshotHost,
    'genomeLength' | 'features' | '_layout' | 'maxAnnotationLane' | 'maxCdsLane'
  >;
  searchFocus: Pick<
    AnnotationSnapshotHost,
    | 'annotationSearchFocusMaskDrawCount'
    | 'annotationSearchFocusPrimitiveDrawCount'
    | 'annotationSearchFocusResolvedTrackId'
    | 'annotationSearchFocusResolvedCanonicalIdentity'
    | 'annotationSearchFocusPresentationLane'
  >;
  hits: Pick<
    AnnotationSnapshotHost,
    | 'hitCache'
    | 'prepackedAnnotationInteractionQueries'
    | 'prepackedAnnotationInteractionLastVisitedNodes'
    | 'prepackedAnnotationInteractionMaxVisitedNodes'
    | 'prepackedAnnotationInteractionLastPrimitiveCandidates'
    | 'prepackedAnnotationInteractionP99Ms'
    | 'prepackedAnnotationInteractionMaxMs'
  >;
  outlines: Pick<AnnotationSnapshotHost, 'lastInteractionOutlineCommandCount'>;
  residentPages: Pick<
    AnnotationSnapshotHost,
    | 'annotationResidentPageStore'
    | 'residentAnnotationPageSnapshotApplies'
    | 'residentAnnotationPageFlatGraphSkips'
    | 'residentAnnotationViewportSelectionStatus'
    | 'residentAnnotationViewportSelectionQueries'
    | 'residentAnnotationViewportSelectedPageCount'
    | 'residentAnnotationViewportSelectedFeatureCount'
    | 'residentAnnotationViewportExpectedPageCount'
    | 'residentAnnotationViewportMissingPageCount'
    | 'residentAnnotationViewportCoverageComplete'
    | 'residentAnnotationViewportProducerCoverageComplete'
  >;
  tilePyramid: {
    vector: AnnotationSnapshotHost['tilePyramidVectorCompositor'];
    rtt: AnnotationSnapshotHost['rttGlyphTilePyramidCompositor'];
  };
  leftover: Pick<
    AnnotationSnapshotHost,
    | 'currentGenomeIdentity'
    | 'currentAnnotationSourceFingerprint'
    | 'currentAnnotationPlacementFingerprint'
    | 'annotationRequestedLayerTypes'
    | 'annotationLayerTypesForPresentation'
    | 'graphics'
    | 'labelIndex'
    | 'labelPool'
    | 'curvedLabels'
    | 'retainedTranscriptDecorationBuilds'
    | 'featureEnvelope'
    | 'prepackedAnnotationScenePresentingResidents'
    | 'getPrepackedAnnotationSceneOwnerSnapshot'
  >;
};

function snapshotReads(sources: AnnotationSnapshotSources): AnnotationSnapshotHost {
  const {
    retained,
    prepacked,
    compiled,
    layout,
    searchFocus,
    hits,
    outlines,
    residentPages,
    tilePyramid,
    leftover,
  } = sources;
  return {
    get compiledBroadSurfaceManifest() {
      return compiled.compiledBroadSurfaceManifest;
    },
    get compiledBroadSurfaceProvenance() {
      return compiled.compiledBroadSurfaceProvenance;
    },
    get compiledBroadSurfacePresenter() {
      return compiled.compiledBroadSurfacePresenter;
    },
    get compiledBroadSurfaceTrackOwners() {
      return compiled.compiledBroadSurfaceTrackOwners;
    },
    compiledBroadSurfacePresentingLayerTypes: () =>
      compiled.compiledBroadSurfacePresentingLayerTypes(),
    compiledBroadSurfaceOwnerForTrack: (trackType) =>
      compiled.compiledBroadSurfaceOwnerForTrack(trackType) as ReturnType<
        AnnotationSnapshotHost['compiledBroadSurfaceOwnerForTrack']
      >,
    compiledBroadSurfaceProvenanceIsCurrent: (manifest, provenance) =>
      compiled.compiledBroadSurfaceProvenanceIsCurrent(manifest, provenance),
    annotationLayerTypesForPresentation: () => leftover.annotationLayerTypesForPresentation(),
    get annotationRequestedLayerTypes() {
      return leftover.annotationRequestedLayerTypes;
    },
    get prepackedAnnotationSceneLastCompleteOwnerKeys() {
      return prepacked.prepackedAnnotationSceneLastCompleteOwnerKeys;
    },
    get prepackedAnnotationSceneResidents() {
      return prepacked.prepackedAnnotationSceneResidents as AnnotationSnapshotHost['prepackedAnnotationSceneResidents'];
    },
    requestedPrepackedAnnotationSceneResidentForTrack: (trackType) =>
      compiled.requestedPrepackedAnnotationSceneResidentForTrack(trackType) as ReturnType<
        AnnotationSnapshotHost['requestedPrepackedAnnotationSceneResidentForTrack']
      >,
    prepackedAnnotationScenePresentingResidents: () =>
      leftover.prepackedAnnotationScenePresentingResidents() as ReturnType<
        AnnotationSnapshotHost['prepackedAnnotationScenePresentingResidents']
      >,
    get prepackedAnnotationPolicyGeneration() {
      return prepacked.prepackedAnnotationPolicyGeneration;
    },
    get prebuiltRasterContractForLastFrame() {
      return retained.prebuiltRasterContractForLastFrame;
    },
    get presentationVisible() {
      return retained.presentationVisible;
    },
    get genomeWideTextureCacheLayer() {
      return retained.genomeWideTextureCacheLayer;
    },
    get prebuiltRasterEligibleForLastFrame() {
      return retained.prebuiltRasterEligibleForLastFrame;
    },
    get rttGlyphTilePyramidCompositor() {
      return tilePyramid.rtt;
    },
    get tilePyramidVectorCompositor() {
      return tilePyramid.vector;
    },
    get retainedLinearTranscriptLayer() {
      return retained.retainedLinearTranscriptLayer;
    },
    get retainedLinearTranscriptBlockCount() {
      return retained.retainedLinearTranscriptBlockCount;
    },
    get retainedLinearFeatureLayer() {
      return retained.retainedLinearFeatureLayer;
    },
    get retainedLinearBinCount() {
      return retained.retainedLinearBinCount;
    },
    get graphics() {
      return leftover.graphics;
    },
    get lastDrawnFeatureCount() {
      return retained.lastDrawnFeatureCount;
    },
    get lastImmediateDrawnLayerTypes() {
      return retained.lastImmediateDrawnLayerTypes;
    },
    get prepackedAnnotationSceneOwnerMetadata() {
      return prepacked.prepackedAnnotationSceneOwnerMetadata;
    },
    get prepackedAnnotationRuntimePolicy() {
      return prepacked.prepackedAnnotationRuntimePolicy;
    },
    get compiledBroadAnnotationInteractionResidentGeneration() {
      return compiled.compiledBroadAnnotationInteractionResidentGeneration;
    },
    get prepackedAnnotationSceneOwnerGeneration() {
      return prepacked.prepackedAnnotationSceneOwnerGeneration;
    },
    get compiledBroadSurfaceSteadyRoster() {
      return compiled.compiledBroadSurfaceSteadyRoster;
    },
    get currentGenomeIdentity() {
      return leftover.currentGenomeIdentity;
    },
    get genomeLength() {
      return layout.genomeLength;
    },
    get currentAnnotationSourceFingerprint() {
      return leftover.currentAnnotationSourceFingerprint;
    },
    get currentAnnotationPlacementFingerprint() {
      return leftover.currentAnnotationPlacementFingerprint;
    },
    get compiledBroadSurfacePlanStatus() {
      return compiled.compiledBroadSurfacePlanStatus;
    },
    get compiledBroadAnnotationInteractionResidents() {
      return compiled.compiledBroadAnnotationInteractionResidents;
    },
    get prepackedAnnotationSceneOwnerKey() {
      return prepacked.prepackedAnnotationSceneOwnerKey;
    },
    get prepackedAnnotationSceneResidentGeneration() {
      return prepacked.prepackedAnnotationSceneResidentGeneration;
    },
    get prepackedAnnotationSceneLayer() {
      return prepacked.prepackedAnnotationSceneLayer;
    },
    get prepackedAnnotationSceneInput() {
      return prepacked.prepackedAnnotationSceneInput;
    },
    get prepackedAnnotationSceneStatus() {
      return prepacked.prepackedAnnotationSceneStatus;
    },
    get prepackedAnnotationSceneLayerCreates() {
      return prepacked.prepackedAnnotationSceneLayerCreates;
    },
    get prepackedAnnotationSceneLayerDestroys() {
      return prepacked.prepackedAnnotationSceneLayerDestroys;
    },
    get prepackedAnnotationSceneGpuPreparations() {
      return prepacked.prepackedAnnotationSceneGpuPreparations;
    },
    get prepackedAnnotationSceneVisiblePartitionCount() {
      return prepacked.prepackedAnnotationSceneVisiblePartitionCount;
    },
    get prepackedAnnotationSceneVisibleInstanceCount() {
      return prepacked.prepackedAnnotationSceneVisibleInstanceCount;
    },
    get prepackedAnnotationSceneStartupBuilds() {
      return prepacked.prepackedAnnotationSceneStartupBuilds;
    },
    get retainedLinearDataBuilds() {
      return retained.retainedLinearDataBuilds;
    },
    get retainedLinearTranscriptBuilds() {
      return retained.retainedLinearTranscriptBuilds;
    },
    get retainedTranscriptDecorationBuilds() {
      return leftover.retainedTranscriptDecorationBuilds;
    },
    buildPresentationDebugSnapshot: () => retained.buildPresentationDebugSnapshot(),
    getPrepackedAnnotationSceneOwnerSnapshot: () =>
      leftover.getPrepackedAnnotationSceneOwnerSnapshot(),
    get labelIndex() {
      return leftover.labelIndex;
    },
    get labelPool() {
      return leftover.labelPool;
    },
    get curvedLabels() {
      return leftover.curvedLabels;
    },
    get overviewBinDrawCount() {
      return retained.overviewBinDrawCount;
    },
    get annotationResidentPageStore() {
      return residentPages.annotationResidentPageStore;
    },
    get residentAnnotationPageSnapshotApplies() {
      return residentPages.residentAnnotationPageSnapshotApplies;
    },
    get residentAnnotationPageFlatGraphSkips() {
      return residentPages.residentAnnotationPageFlatGraphSkips;
    },
    get residentAnnotationViewportSelectionStatus() {
      return residentPages.residentAnnotationViewportSelectionStatus;
    },
    get residentAnnotationViewportSelectionQueries() {
      return residentPages.residentAnnotationViewportSelectionQueries;
    },
    get residentAnnotationViewportSelectedPageCount() {
      return residentPages.residentAnnotationViewportSelectedPageCount;
    },
    get residentAnnotationViewportSelectedFeatureCount() {
      return residentPages.residentAnnotationViewportSelectedFeatureCount;
    },
    get residentAnnotationViewportExpectedPageCount() {
      return residentPages.residentAnnotationViewportExpectedPageCount;
    },
    get residentAnnotationViewportMissingPageCount() {
      return residentPages.residentAnnotationViewportMissingPageCount;
    },
    get residentAnnotationViewportCoverageComplete() {
      return residentPages.residentAnnotationViewportCoverageComplete;
    },
    get residentAnnotationViewportProducerCoverageComplete() {
      return residentPages.residentAnnotationViewportProducerCoverageComplete;
    },
    get retainedLinearTranscriptStaleHolds() {
      return retained.retainedLinearTranscriptStaleHolds;
    },
    get retainedLinearTranscriptLastBuildCause() {
      return retained.retainedLinearTranscriptLastBuildCause;
    },
    get compiledBroadSurfaceRgbaAdmissions() {
      return compiled.compiledBroadSurfaceRgbaAdmissions;
    },
    get compiledBroadSurfaceGpuPreuploads() {
      return compiled.compiledBroadSurfaceGpuPreuploads;
    },
    get compiledBroadSurfaceExplicitRgbaCopyBytes() {
      return compiled.compiledBroadSurfaceExplicitRgbaCopyBytes;
    },
    get compiledBroadSurfaceGpuPreuploadedBytes() {
      return compiled.compiledBroadSurfaceGpuPreuploadedBytes;
    },
    get compiledBroadSurfacePostPresentGpuUploads() {
      return compiled.compiledBroadSurfacePostPresentGpuUploads;
    },
    get compiledBroadSurfacePostPresentGpuUploadBytes() {
      return compiled.compiledBroadSurfacePostPresentGpuUploadBytes;
    },
    get compiledBroadSurfacePlanDerivationCount() {
      return compiled.compiledBroadSurfacePlanDerivationCount;
    },
    get compiledBroadSurfaceCameraContractCreateCount() {
      return compiled.compiledBroadSurfaceCameraContractCreateCount;
    },
    get compiledBroadSurfaceFastCameraMailboxCreateCount() {
      return compiled.compiledBroadSurfaceFastCameraMailboxCreateCount;
    },
    get compiledBroadSurfaceGpuPreuploadFailures() {
      return compiled.compiledBroadSurfaceGpuPreuploadFailures;
    },
    get retainedLinearTranscriptVisibleFeatureCount() {
      return retained.retainedLinearTranscriptVisibleFeatureCount;
    },
    get lastRetainedTranscriptDecorationsDrawn() {
      return retained.lastRetainedTranscriptDecorationsDrawn;
    },
    get retainedLinearSourceWindow() {
      return retained.retainedLinearSourceWindow;
    },
    featureEnvelope: (feature) => leftover.featureEnvelope(feature),
    get lastInteractionOutlineCommandCount() {
      return outlines.lastInteractionOutlineCommandCount;
    },
    get annotationSearchFocusMaskDrawCount() {
      return searchFocus.annotationSearchFocusMaskDrawCount;
    },
    get annotationSearchFocusPrimitiveDrawCount() {
      return searchFocus.annotationSearchFocusPrimitiveDrawCount;
    },
    get annotationSearchFocusResolvedTrackId() {
      return searchFocus.annotationSearchFocusResolvedTrackId;
    },
    get annotationSearchFocusResolvedCanonicalIdentity() {
      return searchFocus.annotationSearchFocusResolvedCanonicalIdentity;
    },
    get annotationSearchFocusPresentationLane() {
      return searchFocus.annotationSearchFocusPresentationLane;
    },
    get features() {
      return layout.features;
    },
    get hitCache() {
      return hits.hitCache;
    },
    get renderCallCount() {
      return retained.renderCallCount;
    },
    get geometryRebuildCount() {
      return retained.geometryRebuildCount;
    },
    get geometryCacheHitCount() {
      return retained.geometryCacheHitCount;
    },
    get lastRenderMode() {
      return retained.lastRenderMode;
    },
    get lastGeometryRebuildReasons() {
      return retained.lastGeometryRebuildReasons;
    },
    get lastOverviewAggregationEnabled() {
      return retained.lastOverviewAggregationEnabled;
    },
    get lastOverviewAggregationCacheHit() {
      return retained.lastOverviewAggregationCacheHit;
    },
    get lastOverviewPassthroughFeatureCount() {
      return retained.lastOverviewPassthroughFeatureCount;
    },
    get lastOverviewDensityAtlasBinBp() {
      return retained.lastOverviewDensityAtlasBinBp;
    },
    get lastOverviewDensityAtlasSampleScreenPx() {
      return retained.lastOverviewDensityAtlasSampleScreenPx;
    },
    get lastOverviewDensityAtlasLevelCount() {
      return retained.lastOverviewDensityAtlasLevelCount;
    },
    get lastOverviewDensityAtlasEstimatedBinCount() {
      return retained.lastOverviewDensityAtlasEstimatedBinCount;
    },
    get lastOverviewDensityAtlasWasCoarsened() {
      return retained.lastOverviewDensityAtlasWasCoarsened;
    },
    get lastOverviewDensityAtlasBudgetExceeded() {
      return retained.lastOverviewDensityAtlasBudgetExceeded;
    },
    get lastOverviewLodCompressionBlend() {
      return retained.lastOverviewLodCompressionBlend;
    },
    get lastOverviewLodFullShapeBlend() {
      return retained.lastOverviewLodFullShapeBlend;
    },
    get lastOverviewCacheMs() {
      return retained.lastOverviewCacheMs;
    },
    get lastOverviewImmediateBlendMs() {
      return retained.lastOverviewImmediateBlendMs;
    },
    get retiredPrepackedAnnotationSceneLayers() {
      return prepacked.retiredPrepackedAnnotationSceneLayers;
    },
    get prepackedAnnotationSceneCameraUpdates() {
      return prepacked.prepackedAnnotationSceneCameraUpdates;
    },
    get prepackedAnnotationInteractionCouplingValidationCount() {
      return prepacked.prepackedAnnotationInteractionCouplingValidationCount;
    },
    get prepackedAnnotationInteractionCouplingPrimitiveScanCardinality() {
      return prepacked.prepackedAnnotationInteractionCouplingPrimitiveScanCardinality;
    },
    get prepackedAnnotationTrustedV4AdmissionCount() {
      return prepacked.prepackedAnnotationTrustedV4AdmissionCount;
    },
    get prepackedAnnotationInteractionQueries() {
      return hits.prepackedAnnotationInteractionQueries;
    },
    get prepackedAnnotationInteractionLastVisitedNodes() {
      return hits.prepackedAnnotationInteractionLastVisitedNodes;
    },
    get prepackedAnnotationInteractionMaxVisitedNodes() {
      return hits.prepackedAnnotationInteractionMaxVisitedNodes;
    },
    get prepackedAnnotationInteractionLastPrimitiveCandidates() {
      return hits.prepackedAnnotationInteractionLastPrimitiveCandidates;
    },
    prepackedAnnotationInteractionP99Ms: () => hits.prepackedAnnotationInteractionP99Ms(),
    get prepackedAnnotationInteractionMaxMs() {
      return hits.prepackedAnnotationInteractionMaxMs;
    },
    get _layout() {
      return layout._layout;
    },
    get maxAnnotationLane() {
      return layout.maxAnnotationLane;
    },
    get maxCdsLane() {
      return layout.maxCdsLane;
    },
    get lastDrawAudit() {
      return retained.lastDrawAudit;
    },
  };
}

function coldGestureRequestedRoster(
  host: AnnotationSnapshotHost,
  requestedLayerTypes: readonly string[]
): {
  lastCompleteLayerTypes: string[];
  requestedCompiledRosterComplete: boolean;
  requestedLayerM_RNAOnly: boolean;
  prepackedRequestedResidents: Array<AnnotationSnapshotResident | null>;
  prepackedRequestedResidentCount: number;
  requestedResidentTracks: ReadonlyArray<{
    trackType: string;
    ownerKey: string | null;
    prepared: boolean;
    admitted: boolean;
    payloadFeatureCount: number;
    visiblePartitionCount: number;
    visibleInstanceCount: number;
    presenting: boolean;
    activeMode: string | null;
    hiddenByIsoformMembershipInstanceCount: number;
    hiddenByLaneCapInstanceCount: number;
    coverageStartBp: number | null;
    coverageEndBp: number | null;
  }>;
  prepackedRequestedResidentRosterReady: boolean;
  prepackedRequestedSingleResident: AnnotationSnapshotResident | null;
} {
  const lastCompleteLayerTypes = host.prepackedAnnotationSceneLastCompleteOwnerKeys.flatMap(
    (ownerKey) => {
      const resident = host.prepackedAnnotationSceneResidents.get(ownerKey);
      return resident ? [resident.metadata.trackType] : [];
    }
  );
  const requestedCompiledRosterComplete = requestedLayerTypes.every((trackType) => {
    const owner = host.compiledBroadSurfaceOwnerForTrack(trackType);
    return Boolean(
      owner &&
      owner.presenter.isPresenting &&
      host.compiledBroadSurfaceProvenanceIsCurrent(owner.manifest, owner.provenance) &&
      owner.presenter.missingCellCount === 0
    );
  });
  const prepackedRequestedResidents = requestedLayerTypes.map((trackType) =>
    host.requestedPrepackedAnnotationSceneResidentForTrack(trackType)
  );
  const prepackedRequestedResidentCount = prepackedRequestedResidents.filter(
    (resident): resident is AnnotationSnapshotResident => resident !== null
  ).length;
  const requestedResidentTracks = requestedLayerTypes.map((trackType, index) => {
    const resident = prepackedRequestedResidents[index];
    const submission = resident?.layer?.getSubmissionDebug?.();
    return Object.freeze({
      trackType,
      ownerKey: resident?.ownerKey ?? null,
      prepared: resident?.layer?.isGpuPrepared ?? false,
      admitted: resident?.viewportDetailPresentationAdmitted ?? false,
      payloadFeatureCount: resident?.input?.gpuReadyScene?.featureIndices?.length ?? 0,
      visiblePartitionCount: resident?.visiblePartitionCount ?? 0,
      visibleInstanceCount: resident?.visibleInstanceCount ?? 0,
      presenting: resident?.layer?.isPresenting ?? false,
      activeMode: submission?.activeMode ?? null,
      hiddenByIsoformMembershipInstanceCount:
        submission?.hiddenByIsoformMembershipInstanceCount ?? 0,
      hiddenByLaneCapInstanceCount: submission?.hiddenByLaneCapInstanceCount ?? 0,
      coverageStartBp: resident?.input?.viewportDetail?.coverageStartBp ?? null,
      coverageEndBp: resident?.input?.viewportDetail?.coverageEndBp ?? null,
    });
  });
  const prepackedRequestedResidentRosterReady =
    requestedLayerTypes.length > 0 &&
    prepackedRequestedResidentCount === requestedLayerTypes.length &&
    prepackedRequestedResidents.every(
      (resident) =>
        resident !== null &&
        resident.layer?.isGpuPrepared === true &&
        resident.policyGeneration === host.prepackedAnnotationPolicyGeneration
    );
  return {
    lastCompleteLayerTypes,
    requestedCompiledRosterComplete,
    requestedLayerM_RNAOnly:
      host.annotationRequestedLayerTypes.length === 1 &&
      host.annotationRequestedLayerTypes[0] === 'mRNA',
    prepackedRequestedResidents,
    prepackedRequestedResidentCount,
    requestedResidentTracks,
    prepackedRequestedResidentRosterReady,
    prepackedRequestedSingleResident:
      prepackedRequestedResidentRosterReady && prepackedRequestedResidents.length === 1
        ? prepackedRequestedResidents[0]
        : null,
  };
}

function coldGestureActiveIdentity(args: {
  host: AnnotationSnapshotHost;
  soleOwnerCount: number;
  soleOwnerLayerTypes: readonly string[];
  compiledBroadRasterVisible: boolean;
  prepackedVisible: boolean;
  prepackedPresentingResidents: ReturnType<
    AnnotationSnapshotHost['prepackedAnnotationScenePresentingResidents']
  >;
  runtimePolicy: AnnotationSnapshotHost['prepackedAnnotationRuntimePolicy'];
}): {
  activeSingleTrackType: string | null;
  activeOwnerKey: string | null;
  activeArtifactKey: string | null;
  activeOwnerGeneration: number;
  activeRuntimePolicy:
    | AnnotationSnapshotHost['prepackedAnnotationRuntimePolicy']
    | {
        isoformMode: string;
        laneLimit: number | null;
      };
} {
  const activeSingleTrackType =
    args.soleOwnerCount === 1 && args.soleOwnerLayerTypes.length === 1
      ? args.soleOwnerLayerTypes[0]
      : null;
  const activeCompiledOwner =
    activeSingleTrackType === null
      ? null
      : args.host.compiledBroadSurfaceOwnerForTrack(activeSingleTrackType);
  const activePrepackedResident =
    args.prepackedPresentingResidents.length === 1 ? args.prepackedPresentingResidents[0] : null;
  return {
    activeSingleTrackType,
    activeOwnerKey: args.compiledBroadRasterVisible
      ? (activeCompiledOwner?.provenance.prepackedOwnerKey ?? null)
      : args.prepackedVisible
        ? (activePrepackedResident?.ownerKey ?? null)
        : null,
    activeArtifactKey: args.compiledBroadRasterVisible
      ? (activeCompiledOwner?.provenance.prepackedArtifactKey ?? null)
      : args.prepackedVisible
        ? (activePrepackedResident?.metadata.artifactKey ?? null)
        : null,
    activeOwnerGeneration: args.compiledBroadRasterVisible
      ? args.host.compiledBroadAnnotationInteractionResidentGeneration
      : args.prepackedVisible
        ? args.host.prepackedAnnotationSceneOwnerGeneration
        : 0,
    activeRuntimePolicy:
      args.compiledBroadRasterVisible && args.host.compiledBroadSurfaceSteadyRoster
        ? {
            isoformMode: args.host.compiledBroadSurfaceSteadyRoster.isoformMode,
            laneLimit: args.host.compiledBroadSurfaceSteadyRoster.laneLimit,
          }
        : args.runtimePolicy,
  };
}

function compiledBroadColdReads(host: AnnotationSnapshotHost): {
  compiledBroadLoadedOwners: CompiledBroadSurfaceTrackOwnerV2[];
  compiledBroadRasterLayerTypes: readonly string[];
  compiledBroadPrimaryOwner: CompiledBroadSurfaceTrackOwnerV2 | null;
  compiledBroadPresenter: CompiledBroadSurfaceTrackOwnerV2['presenter'] | null;
  compiledBroadProvenance: CompiledBroadSurfaceTrackOwnerV2['provenance'] | null;
  compiledBroadCold: ReturnType<
    CompiledBroadSurfaceTrackOwnerV2['presenter']['getColdGestureSnapshot']
  > | null;
  compiledBroadRasterVisible: boolean;
  compiledBroadRasterProvenanceValid: boolean;
} {
  const compiledBroadLoadedOwners = [
    host.compiledBroadSurfaceManifest &&
    host.compiledBroadSurfaceProvenance &&
    host.compiledBroadSurfacePresenter
      ? {
          manifest: host.compiledBroadSurfaceManifest,
          provenance: host.compiledBroadSurfaceProvenance,
          presenter: host.compiledBroadSurfacePresenter,
        }
      : null,
    ...host.compiledBroadSurfaceTrackOwners.values(),
  ].filter((owner): owner is CompiledBroadSurfaceTrackOwnerV2 => owner !== null);
  const compiledBroadPrimaryOwner =
    compiledBroadLoadedOwners.find(
      ({ presenter }) => presenter === host.compiledBroadSurfacePresenter
    ) ??
    compiledBroadLoadedOwners[0] ??
    null;
  const compiledBroadRasterLayerTypes = host.compiledBroadSurfacePresentingLayerTypes();
  return {
    compiledBroadLoadedOwners,
    compiledBroadRasterLayerTypes,
    compiledBroadPrimaryOwner,
    compiledBroadPresenter: compiledBroadPrimaryOwner?.presenter ?? null,
    compiledBroadProvenance: compiledBroadPrimaryOwner?.provenance ?? null,
    compiledBroadCold: compiledBroadPrimaryOwner?.presenter?.getColdGestureSnapshot() ?? null,
    compiledBroadRasterVisible:
      host.presentationVisible && compiledBroadRasterLayerTypes.length > 0,
    compiledBroadRasterProvenanceValid:
      compiledBroadLoadedOwners.length > 0 &&
      compiledBroadLoadedOwners.every(({ manifest, provenance }) =>
        host.compiledBroadSurfaceProvenanceIsCurrent(manifest, provenance)
      ),
  };
}

function coldGestureSurfaceVisibility(
  host: AnnotationSnapshotHost,
  compiledBroadRasterVisible: boolean
): {
  runtimeGenomeWideTextureVisible: boolean;
  legacyPrebuiltRasterVisible: boolean;
  prebuiltRasterVisible: boolean;
  rasterOwnerCount: number;
  overviewGlyphTilesVisible: boolean;
  overviewGlyphTilesCoverageComplete: boolean;
  compiledVectorVisible: boolean;
  compiledVectorCoverageComplete: boolean;
  prepackedPresentingResidents: ReturnType<
    AnnotationSnapshotHost['prepackedAnnotationScenePresentingResidents']
  >;
  prepackedSubmittedPartitionCount: number;
  prepackedSubmittedInstanceCount: number;
  prepackedVisible: boolean;
  retainedTranscriptVisible: boolean;
  retainedSourceShapeVisible: boolean;
  retainedVisible: boolean;
  immediateLiveVisible: boolean;
  soleOwnerCount: number;
} {
  const runtimeGenomeWideTextureVisible =
    host.presentationVisible &&
    (host.genomeWideTextureCacheLayer?.runtimeTexturePresenting ?? false);
  const legacyPrebuiltRasterVisible =
    host.presentationVisible &&
    (host.genomeWideTextureCacheLayer?.prebuiltTexturePresenting ?? false);
  const prebuiltRasterVisible = legacyPrebuiltRasterVisible || compiledBroadRasterVisible;
  const rasterOwnerCount = Number(legacyPrebuiltRasterVisible) + Number(compiledBroadRasterVisible);
  const overviewGlyphTilesVisible =
    host.presentationVisible &&
    (host.rttGlyphTilePyramidCompositor?.isPresenting ?? false) &&
    (host.rttGlyphTilePyramidCompositor?.visibleLayerCount ?? 0) > 0;
  const compiledVectorVisible =
    host.presentationVisible &&
    (host.tilePyramidVectorCompositor?.isPresenting ?? false) &&
    (host.tilePyramidVectorCompositor?.visibleLayerCount ?? 0) > 0 &&
    (host.tilePyramidVectorCompositor?.presentingBlockCount ?? 0) > 0;
  const prepackedPresentingResidents = host.prepackedAnnotationScenePresentingResidents();
  const prepackedPresenting = host.presentationVisible && prepackedPresentingResidents.length > 0;
  const prepackedSubmittedPartitionCount = prepackedPresenting
    ? prepackedPresentingResidents.reduce(
        (count, resident) => count + (resident.visiblePartitionCount ?? 0),
        0
      )
    : 0;
  const prepackedSubmittedInstanceCount = prepackedPresenting
    ? prepackedPresentingResidents.reduce(
        (count, resident) => count + (resident.visibleInstanceCount ?? 0),
        0
      )
    : 0;
  const prepackedVisible =
    prepackedPresenting &&
    prepackedSubmittedPartitionCount > 0 &&
    prepackedSubmittedInstanceCount > 0;
  const retainedTranscriptVisible =
    host.presentationVisible &&
    (host.retainedLinearTranscriptLayer?.isPresenting ?? false) &&
    host.retainedLinearTranscriptBlockCount > 0;
  const retainedSourceShapeVisible =
    host.presentationVisible &&
    (host.retainedLinearFeatureLayer?.isPresenting ?? false) &&
    host.retainedLinearBinCount > 0;
  const retainedVisible = retainedTranscriptVisible || retainedSourceShapeVisible;
  const immediateLiveVisible =
    host.presentationVisible && host.graphics.visible && host.lastDrawnFeatureCount > 0;
  return {
    runtimeGenomeWideTextureVisible,
    legacyPrebuiltRasterVisible,
    prebuiltRasterVisible,
    rasterOwnerCount,
    overviewGlyphTilesVisible,
    overviewGlyphTilesCoverageComplete: overviewGlyphTilesVisible,
    compiledVectorVisible,
    compiledVectorCoverageComplete:
      compiledVectorVisible && (host.tilePyramidVectorCompositor?.coverageComplete ?? false),
    prepackedPresentingResidents,
    prepackedSubmittedPartitionCount,
    prepackedSubmittedInstanceCount,
    prepackedVisible,
    retainedTranscriptVisible,
    retainedSourceShapeVisible,
    retainedVisible,
    immediateLiveVisible,
    soleOwnerCount:
      rasterOwnerCount +
      Number(overviewGlyphTilesVisible) +
      Number(compiledVectorVisible) +
      Number(prepackedVisible) +
      Number(retainedVisible) +
      Number(immediateLiveVisible),
  };
}

type ColdGestureSoleOwner = {
  soleOwnerId: AnnotationColdGestureOwnerId | null;
  soleOwnerRole: 'floor' | 'exact' | 'live' | null;
  soleOwnerLayerTypes: readonly string[];
  soleOwnerCoverageComplete: boolean;
};

function resolveColdGestureSoleOwner(args: {
  soleOwnerCount: number;
  compiledBroadRasterVisible: boolean;
  legacyPrebuiltRasterVisible: boolean;
  compiledBroadRasterLayerTypes: readonly string[];
  rasterLayers: readonly string[];
  compiledBroadRasterProvenanceValid: boolean;
  requestedCompiledRosterComplete: boolean;
  prebuiltRasterEligibleForLastFrame: boolean;
  prebuiltRasterContractMatch: boolean;
  legacyPrebuiltRasterArtifactM_RNAOnly: boolean;
  overviewGlyphTilesVisible: boolean;
  requestedLayerTypes: readonly string[];
  overviewGlyphTilesCoverageComplete: boolean;
  compiledVectorVisible: boolean;
  compiledVectorCoverageComplete: boolean;
  prepackedVisible: boolean;
  prepackedPresentingResidents: readonly AnnotationSnapshotResident[];
  prepackedAnnotationPolicyGeneration: number;
  prepackedSubmittedPartitionCount: number;
  prepackedSubmittedInstanceCount: number;
  retainedVisible: boolean;
  retainedTranscriptVisible: boolean;
  retainedSourceShapeVisible: boolean;
  immediateLiveVisible: boolean;
  lastImmediateDrawnLayerTypes: ReadonlySet<string>;
}): ColdGestureSoleOwner {
  if (args.soleOwnerCount !== 1) {
    return {
      soleOwnerId: null,
      soleOwnerRole: null,
      soleOwnerLayerTypes: EMPTY_COLD_GESTURE_STRING_VALUES,
      soleOwnerCoverageComplete: false,
    };
  }
  if (args.compiledBroadRasterVisible || args.legacyPrebuiltRasterVisible) {
    return {
      soleOwnerId: args.compiledBroadRasterVisible
        ? 'compiled-broad-raster-surface'
        : 'compiled-raster-surface',
      soleOwnerRole: args.compiledBroadRasterVisible
        ? 'exact'
        : args.prebuiltRasterEligibleForLastFrame
          ? 'exact'
          : 'floor',
      soleOwnerLayerTypes: args.compiledBroadRasterVisible
        ? args.compiledBroadRasterLayerTypes
        : args.rasterLayers,
      soleOwnerCoverageComplete: args.compiledBroadRasterVisible
        ? args.compiledBroadRasterProvenanceValid && args.requestedCompiledRosterComplete
        : args.prebuiltRasterContractMatch && args.legacyPrebuiltRasterArtifactM_RNAOnly,
    };
  }
  if (args.overviewGlyphTilesVisible) {
    return {
      soleOwnerId: 'overview-glyph-tile-surface',
      soleOwnerRole: 'exact',
      soleOwnerLayerTypes: args.requestedLayerTypes,
      soleOwnerCoverageComplete: args.overviewGlyphTilesCoverageComplete,
    };
  }
  if (args.compiledVectorVisible) {
    return {
      soleOwnerId: 'compiled-vector-surface',
      soleOwnerRole: 'exact',
      soleOwnerLayerTypes: args.requestedLayerTypes,
      soleOwnerCoverageComplete: args.compiledVectorCoverageComplete,
    };
  }
  if (args.prepackedVisible) {
    return {
      soleOwnerId: 'prepacked-partitioned-vector-surface',
      soleOwnerRole: 'exact',
      soleOwnerLayerTypes: annotationFeatureNormalizeLayerTypes(
        args.prepackedPresentingResidents.map(
          ({ metadata: residentMetadata }) => residentMetadata.trackType
        )
      ),
      soleOwnerCoverageComplete:
        args.prepackedPresentingResidents.every(
          (resident) =>
            resident.layer?.isGpuPrepared === true &&
            resident.policyGeneration === args.prepackedAnnotationPolicyGeneration
        ) &&
        args.prepackedSubmittedPartitionCount > 0 &&
        args.prepackedSubmittedInstanceCount > 0,
    };
  }
  if (args.retainedVisible) {
    return {
      soleOwnerId: 'active-segment-retained-surface',
      soleOwnerRole: 'exact',
      soleOwnerLayerTypes: args.requestedLayerTypes,
      soleOwnerCoverageComplete: args.retainedTranscriptVisible && !args.retainedSourceShapeVisible,
    };
  }
  if (args.immediateLiveVisible) {
    return {
      soleOwnerId: 'single-chrom-live-surface',
      soleOwnerRole: 'live',
      soleOwnerLayerTypes: annotationFeatureNormalizeLayerTypes([
        ...args.lastImmediateDrawnLayerTypes,
      ]),
      soleOwnerCoverageComplete:
        args.lastImmediateDrawnLayerTypes.size === 1 &&
        args.lastImmediateDrawnLayerTypes.has('mRNA'),
    };
  }
  return {
    soleOwnerId: null,
    soleOwnerRole: null,
    soleOwnerLayerTypes: EMPTY_COLD_GESTURE_STRING_VALUES,
    soleOwnerCoverageComplete: false,
  };
}

function coldGestureSoleOwnerContractValid(args: {
  requestedLayerTypes: readonly string[];
  soleOwnerLayerTypes: readonly string[];
  soleOwnerCount: number;
  soleOwnerRole: ColdGestureSoleOwner['soleOwnerRole'];
  soleOwnerCoverageComplete: boolean;
  runtimeGenomeWideTextureVisible: boolean;
}): boolean {
  return (
    args.requestedLayerTypes.length > 0 &&
    args.requestedLayerTypes.length === args.soleOwnerLayerTypes.length &&
    args.requestedLayerTypes.every(
      (trackType, index) => args.soleOwnerLayerTypes[index] === trackType
    ) &&
    args.soleOwnerCount === 1 &&
    args.soleOwnerRole !== 'floor' &&
    args.soleOwnerCoverageComplete &&
    !args.runtimeGenomeWideTextureVisible
  );
}

function coldGesturePrebuiltRasterSnapshotFields(args: {
  host: AnnotationSnapshotHost;
  rasterOwnerCount: number;
  compiledBroadRasterVisible: boolean;
  compiledBroadRasterProvenanceValid: boolean;
  compiledBroadLoadedOwners: CompiledBroadSurfaceTrackOwnerV2[];
  compiledBroadProvenance: CompiledBroadSurfaceTrackOwnerV2['provenance'] | null;
  compiledBroadPresenter: CompiledBroadSurfaceTrackOwnerV2['presenter'] | null;
  prebuiltRasterVisible: boolean;
  legacyPrebuiltRasterVisible: boolean;
  prebuiltRasterArtifactM_RNAOnly: boolean;
}): Pick<
  AnnotationOverlayColdGestureSnapshot,
  | 'prebuiltRasterLoaded'
  | 'prebuiltRasterVisible'
  | 'legacyPrebuiltRasterVisible'
  | 'rasterOwnerCount'
  | 'prebuiltRasterEligible'
  | 'prebuiltRasterContractMatch'
  | 'prebuiltRasterSourceMatch'
  | 'prebuiltRasterPlacementMatch'
  | 'prebuiltRasterArtifactM_RNAOnly'
  | 'prebuiltRasterSourceFingerprint'
  | 'prebuiltRasterPlacementFingerprint'
  | 'prebuiltRasterCompositeCount'
> {
  const compiledMatch = args.compiledBroadRasterProvenanceValid;
  const legacy = args.host.prebuiltRasterContractForLastFrame;
  return {
    prebuiltRasterLoaded:
      (args.host.genomeWideTextureCacheLayer?.hasPrebuilt() ?? false) ||
      (args.compiledBroadLoadedOwners.length > 0 && compiledMatch),
    prebuiltRasterVisible: args.prebuiltRasterVisible,
    legacyPrebuiltRasterVisible: args.legacyPrebuiltRasterVisible,
    rasterOwnerCount: args.rasterOwnerCount,
    prebuiltRasterEligible:
      args.host.prebuiltRasterEligibleForLastFrame || args.compiledBroadRasterVisible,
    prebuiltRasterContractMatch:
      args.rasterOwnerCount === 1 &&
      (args.compiledBroadRasterVisible ? compiledMatch : legacy.contractMatch),
    prebuiltRasterSourceMatch:
      args.rasterOwnerCount === 1 &&
      (args.compiledBroadRasterVisible ? compiledMatch : legacy.sourceMatch),
    prebuiltRasterPlacementMatch:
      args.rasterOwnerCount === 1 &&
      (args.compiledBroadRasterVisible ? compiledMatch : legacy.placementMatch),
    prebuiltRasterArtifactM_RNAOnly: args.prebuiltRasterArtifactM_RNAOnly,
    prebuiltRasterSourceFingerprint:
      args.compiledBroadRasterVisible && args.rasterOwnerCount === 1
        ? (args.compiledBroadProvenance?.sourceFingerprint ?? null)
        : legacy.artifactSourceFingerprint,
    prebuiltRasterPlacementFingerprint:
      args.compiledBroadRasterVisible && args.rasterOwnerCount === 1
        ? (args.compiledBroadProvenance?.placementFingerprint ?? null)
        : legacy.artifactPlacementFingerprint,
    prebuiltRasterCompositeCount:
      (args.host.genomeWideTextureCacheLayer?.prebuiltCompositeCount ?? 0) +
      (args.compiledBroadPresenter?.atomicCommitCount ?? 0),
  };
}

function coldGestureCompiledBroadSnapshotFields(args: {
  host: AnnotationSnapshotHost;
  compiledBroadLoadedOwners: CompiledBroadSurfaceTrackOwnerV2[];
  compiledBroadRasterVisible: boolean;
  compiledBroadRasterProvenanceValid: boolean;
  compiledBroadProvenance: CompiledBroadSurfaceTrackOwnerV2['provenance'] | null;
  compiledBroadPresenter: CompiledBroadSurfaceTrackOwnerV2['presenter'] | null;
  compiledBroadCold: ReturnType<
    CompiledBroadSurfaceTrackOwnerV2['presenter']['getColdGestureSnapshot']
  > | null;
  compiledBroadInteractionRequestedOwnerKey: string | null;
}): Pick<
  AnnotationOverlayColdGestureSnapshot,
  | 'compiledBroadRasterLoaded'
  | 'compiledBroadRasterVisible'
  | 'compiledBroadRasterProvenanceValid'
  | 'compiledBroadRasterProvenanceManifestFingerprint'
  | 'compiledBroadRasterProvenanceSourceFingerprint'
  | 'compiledBroadRasterProvenancePlacementFingerprint'
  | 'compiledBroadRasterProvenancePrepackedOwnerKey'
  | 'compiledBroadRasterProvenancePrepackedArtifactKey'
  | 'compiledBroadRasterHoldingLastGood'
  | 'compiledBroadRasterPlanStatus'
  | 'compiledBroadRasterResidentCellCount'
  | 'compiledBroadRasterSubmittedCellCount'
  | 'compiledBroadRasterMissingCellCount'
  | 'compiledBroadRasterActiveLevelIds'
  | 'compiledBroadRasterActiveMipWeights'
  | 'compiledBroadRasterActiveResidentCellIds'
  | 'compiledBroadRasterSubmittedCellIds'
  | 'compiledBroadRasterVectorSubmissionCount'
  | 'compiledBroadRasterRuntimeCellCompileCount'
  | 'compiledBroadRasterRuntimeDurableWriteCount'
  | 'compiledBroadInteractionResidentGeneration'
  | 'compiledBroadInteractionRequestedOwnerPresent'
  | 'compiledBroadRasterMeshCreationCount'
  | 'compiledBroadRasterShaderCreationCount'
  | 'compiledBroadRasterGeometryCreationCount'
> {
  const provenance = args.compiledBroadProvenance;
  const presenter = args.compiledBroadPresenter;
  const cold = args.compiledBroadCold;
  return {
    compiledBroadRasterLoaded:
      args.compiledBroadLoadedOwners.length > 0 && args.compiledBroadRasterProvenanceValid,
    compiledBroadRasterVisible: args.compiledBroadRasterVisible,
    compiledBroadRasterProvenanceValid: args.compiledBroadRasterProvenanceValid,
    compiledBroadRasterProvenanceManifestFingerprint: provenance?.manifestFingerprint ?? null,
    compiledBroadRasterProvenanceSourceFingerprint: provenance?.sourceFingerprint ?? null,
    compiledBroadRasterProvenancePlacementFingerprint: provenance?.placementFingerprint ?? null,
    compiledBroadRasterProvenancePrepackedOwnerKey: provenance?.prepackedOwnerKey ?? null,
    compiledBroadRasterProvenancePrepackedArtifactKey: provenance?.prepackedArtifactKey ?? null,
    compiledBroadRasterHoldingLastGood: presenter?.holdingLastGood ?? false,
    compiledBroadRasterPlanStatus: args.host.compiledBroadSurfacePlanStatus,
    compiledBroadRasterResidentCellCount: presenter?.residentCellCount ?? 0,
    compiledBroadRasterSubmittedCellCount: presenter?.submittedCellCount ?? 0,
    compiledBroadRasterMissingCellCount: presenter?.missingCellCount ?? 0,
    compiledBroadRasterActiveLevelIds: cold?.activeLevelIds ?? EMPTY_COLD_GESTURE_STRING_VALUES,
    compiledBroadRasterActiveMipWeights: cold?.activeMipWeights ?? EMPTY_COLD_GESTURE_NUMBER_VALUES,
    compiledBroadRasterActiveResidentCellIds:
      cold?.activeResidentCellIds ?? EMPTY_COLD_GESTURE_STRING_VALUES,
    compiledBroadRasterSubmittedCellIds: cold?.submittedCellIds ?? EMPTY_COLD_GESTURE_STRING_VALUES,
    compiledBroadRasterVectorSubmissionCount: 0,
    compiledBroadRasterRuntimeCellCompileCount: cold?.runtimeCellCompileCount ?? 0,
    compiledBroadRasterRuntimeDurableWriteCount: cold?.runtimeDurableWriteCount ?? 0,
    compiledBroadInteractionResidentGeneration:
      args.host.compiledBroadAnnotationInteractionResidentGeneration,
    compiledBroadInteractionRequestedOwnerPresent:
      args.compiledBroadInteractionRequestedOwnerKey !== null &&
      args.host.compiledBroadAnnotationInteractionResidents.has(
        args.compiledBroadInteractionRequestedOwnerKey
      ),
    compiledBroadRasterMeshCreationCount: presenter?.meshCreationCount ?? 0,
    compiledBroadRasterShaderCreationCount: presenter?.shaderCreationCount ?? 0,
    compiledBroadRasterGeometryCreationCount: presenter?.geometryCreationCount ?? 0,
  };
}

function coldGesturePrepackedSnapshotFields(args: {
  host: AnnotationSnapshotHost;
  metadata: AnnotationSnapshotHost['prepackedAnnotationSceneOwnerMetadata'];
  runtimePolicy: AnnotationSnapshotHost['prepackedAnnotationRuntimePolicy'];
  prepackedRequestedResidentCount: number;
  prepackedRequestedResidentRosterReady: boolean;
  prepackedRequestedSingleResident: AnnotationSnapshotResident | null;
  prepackedSubmittedPartitionCount: number;
  prepackedSubmittedInstanceCount: number;
}): Pick<
  AnnotationOverlayColdGestureSnapshot,
  | 'prepackedOwnerKey'
  | 'prepackedOwnerGeneration'
  | 'prepackedResidentRosterGeneration'
  | 'prepackedRequestedResidentCount'
  | 'prepackedRequestedResidentRosterReady'
  | 'prepackedRequestedSingleResidentOwnerKey'
  | 'prepackedRequestedSingleResidentArtifactKey'
  | 'prepackedRequestedSingleResidentCoverageStartBp'
  | 'prepackedRequestedSingleResidentCoverageEndBp'
  | 'prepackedRequestedSingleResidentHandoffStartBp'
  | 'prepackedRequestedSingleResidentHandoffEndBp'
  | 'prepackedRequestedSingleResidentPresentationAdmitted'
  | 'prepackedLoaded'
  | 'prepackedStatus'
  | 'prepackedGpuPrepared'
  | 'prepackedMetadataGenomeIdentity'
  | 'prepackedMetadataGenomeLengthBp'
  | 'prepackedMetadataPartitionSpanBp'
  | 'prepackedMetadataArtifactKey'
  | 'prepackedMetadataThemeMode'
  | 'prepackedMetadataTrackType'
  | 'prepackedMetadataAnnotationBarHeightPx'
  | 'prepackedMetadataLaneAlgorithmToken'
  | 'prepackedMetadataMapperContractToken'
  | 'prepackedMetadataGeometryContractToken'
  | 'prepackedMetadataInteractionContractToken'
  | 'prepackedRuntimeIsoformMode'
  | 'prepackedRuntimeLaneLimit'
  | 'prepackedPolicyGeneration'
  | 'prepackedSubmittedPartitionCount'
  | 'prepackedSubmittedInstanceCount'
  | 'prepackedSceneLayerCreates'
  | 'prepackedSceneLayerDestroys'
  | 'prepackedSceneGpuPreparations'
  | 'prepackedSceneVisiblePartitionCount'
  | 'prepackedSceneVisibleInstanceCount'
  | 'prepackedSceneStartupBuilds'
> {
  const { host, metadata, runtimePolicy, prepackedRequestedSingleResident: resident } = args;
  return {
    prepackedOwnerKey: host.prepackedAnnotationSceneOwnerKey,
    prepackedOwnerGeneration: host.prepackedAnnotationSceneOwnerGeneration,
    prepackedResidentRosterGeneration: host.prepackedAnnotationSceneResidentGeneration,
    prepackedRequestedResidentCount: args.prepackedRequestedResidentCount,
    prepackedRequestedResidentRosterReady: args.prepackedRequestedResidentRosterReady,
    prepackedRequestedSingleResidentOwnerKey: resident?.ownerKey ?? null,
    prepackedRequestedSingleResidentArtifactKey: resident?.metadata.artifactKey ?? null,
    prepackedRequestedSingleResidentCoverageStartBp:
      resident?.input?.viewportDetail?.coverageStartBp ?? null,
    prepackedRequestedSingleResidentCoverageEndBp:
      resident?.input?.viewportDetail?.coverageEndBp ?? null,
    prepackedRequestedSingleResidentHandoffStartBp:
      resident?.input?.viewportDetail?.handoffStartBp ?? null,
    prepackedRequestedSingleResidentHandoffEndBp:
      resident?.input?.viewportDetail?.handoffEndBp ?? null,
    prepackedRequestedSingleResidentPresentationAdmitted:
      resident?.viewportDetailPresentationAdmitted ?? null,
    prepackedLoaded:
      host.prepackedAnnotationSceneLayer !== null &&
      host.prepackedAnnotationSceneInput !== null &&
      host.prepackedAnnotationSceneOwnerKey !== null,
    prepackedStatus: host.prepackedAnnotationSceneStatus,
    prepackedGpuPrepared: host.prepackedAnnotationSceneLayer?.isGpuPrepared ?? false,
    prepackedMetadataGenomeIdentity: metadata?.genomeIdentity ?? null,
    prepackedMetadataGenomeLengthBp: metadata?.genomeLengthBp ?? null,
    prepackedMetadataPartitionSpanBp: metadata?.partitionSpanBp ?? null,
    prepackedMetadataArtifactKey: metadata?.artifactKey ?? null,
    prepackedMetadataThemeMode: metadata?.themeMode ?? null,
    prepackedMetadataTrackType: metadata?.trackType ?? null,
    prepackedMetadataAnnotationBarHeightPx: metadata?.annotationBarHeightPx ?? null,
    prepackedMetadataLaneAlgorithmToken: metadata?.laneAlgorithmToken ?? null,
    prepackedMetadataMapperContractToken: metadata?.mapperContractToken ?? null,
    prepackedMetadataGeometryContractToken: metadata?.geometryContractToken ?? null,
    prepackedMetadataInteractionContractToken: metadata?.interactionContractToken ?? null,
    prepackedRuntimeIsoformMode: runtimePolicy?.isoformMode ?? null,
    prepackedRuntimeLaneLimit: runtimePolicy?.laneLimit ?? null,
    prepackedPolicyGeneration: host.prepackedAnnotationPolicyGeneration,
    prepackedSubmittedPartitionCount: args.prepackedSubmittedPartitionCount,
    prepackedSubmittedInstanceCount: args.prepackedSubmittedInstanceCount,
    prepackedSceneLayerCreates: host.prepackedAnnotationSceneLayerCreates,
    prepackedSceneLayerDestroys: host.prepackedAnnotationSceneLayerDestroys,
    prepackedSceneGpuPreparations: host.prepackedAnnotationSceneGpuPreparations,
    prepackedSceneVisiblePartitionCount: host.prepackedAnnotationSceneVisiblePartitionCount,
    prepackedSceneVisibleInstanceCount: host.prepackedAnnotationSceneVisibleInstanceCount,
    prepackedSceneStartupBuilds: host.prepackedAnnotationSceneStartupBuilds,
  };
}

export function getColdGestureSnapshot(
  sources: AnnotationSnapshotSources
): AnnotationOverlayColdGestureSnapshot {
  const host = snapshotReads(sources);
  const {
    compiledBroadLoadedOwners,
    compiledBroadRasterLayerTypes,
    compiledBroadPresenter,
    compiledBroadProvenance,
    compiledBroadCold,
    compiledBroadRasterVisible,
    compiledBroadRasterProvenanceValid,
  } = compiledBroadColdReads(host);
  const requestedLayerTypes = host.annotationLayerTypesForPresentation();
  const {
    lastCompleteLayerTypes,
    requestedCompiledRosterComplete,
    requestedLayerM_RNAOnly,
    requestedResidentTracks,
    prepackedRequestedResidentCount,
    prepackedRequestedResidentRosterReady,
    prepackedRequestedSingleResident,
  } = coldGestureRequestedRoster(host, requestedLayerTypes);
  const rasterLayers = host.prebuiltRasterContractForLastFrame.artifactLayerTypes;
  const compiledBroadInteractionRequestedOwnerKey =
    compiledBroadProvenance?.prepackedOwnerKey ?? null;
  const legacyPrebuiltRasterArtifactM_RNAOnly =
    rasterLayers.length === 1 && rasterLayers[0] === 'mRNA';
  const compiledBroadRasterArtifactM_RNAOnly =
    compiledBroadRasterProvenanceValid && requestedLayerM_RNAOnly;
  const {
    runtimeGenomeWideTextureVisible,
    legacyPrebuiltRasterVisible,
    prebuiltRasterVisible,
    rasterOwnerCount,
    overviewGlyphTilesVisible,
    overviewGlyphTilesCoverageComplete,
    compiledVectorVisible,
    compiledVectorCoverageComplete,
    prepackedPresentingResidents,
    prepackedSubmittedPartitionCount,
    prepackedSubmittedInstanceCount,
    prepackedVisible,
    retainedTranscriptVisible,
    retainedSourceShapeVisible,
    retainedVisible,
    immediateLiveVisible,
    soleOwnerCount,
  } = coldGestureSurfaceVisibility(host, compiledBroadRasterVisible);
  const prebuiltRasterArtifactM_RNAOnly =
    rasterOwnerCount === 1 &&
    (compiledBroadRasterVisible
      ? compiledBroadRasterArtifactM_RNAOnly
      : legacyPrebuiltRasterArtifactM_RNAOnly);
  const { soleOwnerId, soleOwnerRole, soleOwnerLayerTypes, soleOwnerCoverageComplete } =
    resolveColdGestureSoleOwner({
      soleOwnerCount,
      compiledBroadRasterVisible,
      legacyPrebuiltRasterVisible,
      compiledBroadRasterLayerTypes,
      rasterLayers,
      compiledBroadRasterProvenanceValid,
      requestedCompiledRosterComplete,
      prebuiltRasterEligibleForLastFrame: host.prebuiltRasterEligibleForLastFrame,
      prebuiltRasterContractMatch: host.prebuiltRasterContractForLastFrame.contractMatch,
      legacyPrebuiltRasterArtifactM_RNAOnly,
      overviewGlyphTilesVisible,
      requestedLayerTypes,
      overviewGlyphTilesCoverageComplete,
      compiledVectorVisible,
      compiledVectorCoverageComplete,
      prepackedVisible,
      prepackedPresentingResidents,
      prepackedAnnotationPolicyGeneration: host.prepackedAnnotationPolicyGeneration,
      prepackedSubmittedPartitionCount,
      prepackedSubmittedInstanceCount,
      retainedVisible,
      retainedTranscriptVisible,
      retainedSourceShapeVisible,
      immediateLiveVisible,
      lastImmediateDrawnLayerTypes: host.lastImmediateDrawnLayerTypes,
    });
  const metadata = host.prepackedAnnotationSceneOwnerMetadata;
  const runtimePolicy = host.prepackedAnnotationRuntimePolicy;
  const packReceipt = getRetainedLinearTranscriptPackDebugSnapshot();
  const soleOwnerContractValid = coldGestureSoleOwnerContractValid({
    requestedLayerTypes,
    soleOwnerLayerTypes,
    soleOwnerCount,
    soleOwnerRole,
    soleOwnerCoverageComplete,
    runtimeGenomeWideTextureVisible,
  });
  const activeIdentity = coldGestureActiveIdentity({
    host,
    soleOwnerCount,
    soleOwnerLayerTypes,
    compiledBroadRasterVisible,
    prepackedVisible,
    prepackedPresentingResidents,
    runtimePolicy,
  });
  const {
    activeSingleTrackType,
    activeOwnerKey,
    activeArtifactKey,
    activeOwnerGeneration,
    activeRuntimePolicy,
  } = activeIdentity;

  return {
    contract: ANNOTATION_OVERLAY_COLD_GESTURE_SNAPSHOT_V1,
    genomeIdentity: host.currentGenomeIdentity,
    genomeLengthBp: host.genomeLength,
    presentationVisible: host.presentationVisible,
    requestedLayerTypes,
    lastCompleteLayerTypes,
    requestedResidentTracks,
    requestedLayerM_RNAOnly,
    soleOwnerCount,
    soleOwnerId,
    soleOwnerRole,
    soleOwnerLayerTypes,
    soleOwnerVisualGroups: visualGroupsForLayerTypes(soleOwnerLayerTypes),
    soleOwnerCoverageComplete,
    soleOwnerContractValid,
    activeOwnerKey,
    activeOwnerGeneration,
    activeArtifactKey,
    activeSourceIdentity: activeOwnerKey === null ? null : host.currentGenomeIdentity,
    activeTrackType: activeSingleTrackType,
    activeRuntimeIsoformMode: activeRuntimePolicy?.isoformMode ?? null,
    activeRuntimeLaneLimit: activeRuntimePolicy?.laneLimit ?? null,
    activePolicyGeneration: host.prepackedAnnotationPolicyGeneration,
    activeSourceFingerprint:
      activeOwnerKey !== null ? host.currentAnnotationSourceFingerprint : null,
    activePlacementFingerprint:
      activeOwnerKey !== null ? host.currentAnnotationPlacementFingerprint : null,
    runtimeGenomeWideTextureVisible,
    ...coldGesturePrebuiltRasterSnapshotFields({
      host,
      rasterOwnerCount,
      compiledBroadRasterVisible,
      compiledBroadRasterProvenanceValid,
      compiledBroadLoadedOwners,
      compiledBroadProvenance,
      compiledBroadPresenter,
      prebuiltRasterVisible,
      legacyPrebuiltRasterVisible,
      prebuiltRasterArtifactM_RNAOnly,
    }),
    ...coldGestureCompiledBroadSnapshotFields({
      host,
      compiledBroadLoadedOwners,
      compiledBroadRasterVisible,
      compiledBroadRasterProvenanceValid,
      compiledBroadProvenance,
      compiledBroadPresenter,
      compiledBroadCold,
      compiledBroadInteractionRequestedOwnerKey,
    }),
    overviewGlyphTilesVisible,
    overviewGlyphTilesCoverageComplete,
    overviewGlyphTilesBuildCount: host.rttGlyphTilePyramidCompositor?.buildCount ?? 0,
    overviewGlyphTilesCompositeCount: host.rttGlyphTilePyramidCompositor?.compositeCount ?? 0,
    compiledVectorVisible,
    compiledVectorCoverageComplete,
    retainedTranscriptVisible,
    retainedSourceShapeVisible,
    immediateLiveVisible,
    ...coldGesturePrepackedSnapshotFields({
      host,
      metadata,
      runtimePolicy,
      prepackedRequestedResidentCount,
      prepackedRequestedResidentRosterReady,
      prepackedRequestedSingleResident,
      prepackedSubmittedPartitionCount,
      prepackedSubmittedInstanceCount,
    }),
    retainedLinearDataBuilds: host.retainedLinearDataBuilds,
    retainedLinearTranscriptBuilds: host.retainedLinearTranscriptBuilds,
    retainedLinearTranscriptPacks: packReceipt.count,
    retainedTranscriptDecorationBuilds: host.retainedTranscriptDecorationBuilds,
  };
}

export function getDebugSnapshot(
  sources: AnnotationSnapshotSources
): AnnotationOverlayDebugSnapshot {
  const host = snapshotReads(sources);
  const presentation = host.buildPresentationDebugSnapshot();
  const presentingPrepackedResidents = host.prepackedAnnotationScenePresentingResidents();
  const activatedPrepackedResident = host.prepackedAnnotationSceneOwnerKey
    ? (host.prepackedAnnotationSceneResidents.get(host.prepackedAnnotationSceneOwnerKey) ?? null)
    : null;
  const diagnosticPrepackedResidents =
    presentingPrepackedResidents.length > 0
      ? presentingPrepackedResidents
      : activatedPrepackedResident
        ? [activatedPrepackedResident]
        : [];
  const diagnosticPrepackedInteractionReady =
    diagnosticPrepackedResidents.length > 0 &&
    diagnosticPrepackedResidents.every(({ input }) => input?.interactionIndex != null);
  const sourceWindowFeatureSamples =
    host.retainedLinearSourceWindow?.features.slice(0, 8).map((feature) => ({
      id: feature.id,
      type: feature.type,
      start: feature.start,
      end: feature.end,
      lane: feature.lane,
      cdsLane: feature.cdsLane ?? null,
      exonCount: feature.exons?.length ?? 0,
      cdsCount: feature.cds?.length ?? 0,
      outlineOnly: isOutlineOnlyFeature(feature),
      laneEnvelopeResolved: host.featureEnvelope(feature) !== null,
    })) ?? [];
  return {
    straightLabelCount: host.labelIndex,
    straightLabelAlphas: host.labelPool.slice(0, host.labelIndex).map((label) => label.alpha),
    straightLabelResolutions: host.labelPool
      .slice(0, host.labelIndex)
      .map((label) => label.resolution),
    curvedGlyphCount: host.curvedLabels.activeCount ?? 0,
    curvedGlyphRotations: host.curvedLabels.activeRotations ?? [],
    curvedGlyphFontSizes: host.curvedLabels.activeFontSizes ?? [],
    curvedGlyphScales: host.curvedLabels.activeScales ?? [],
    curvedGlyphResolutions: host.curvedLabels.activeResolutions ?? [],
    curvedGlyphPositions: host.curvedLabels.activePositions ?? [],
    overviewBinDrawCount: host.overviewBinDrawCount,
    retainedLinearDataBuilds: host.retainedLinearDataBuilds,
    retainedLinearBinCount: host.retainedLinearBinCount,
    retainedLinearTranscriptBuilds: host.retainedLinearTranscriptBuilds,
    retainedLinearTranscriptPacks: getRetainedLinearTranscriptPackDebugSnapshot().count,
    residentAnnotationPageCount: host.annotationResidentPageStore?.residentPageCount ?? 0,
    residentAnnotationPageBytes: host.annotationResidentPageStore?.residentByteCount ?? 0,
    residentAnnotationPageSnapshotApplies: host.residentAnnotationPageSnapshotApplies,
    residentAnnotationPageFlatGraphSkips: host.residentAnnotationPageFlatGraphSkips,
    residentAnnotationViewportSelectionStatus: host.residentAnnotationViewportSelectionStatus,
    residentAnnotationViewportSelectionQueries: host.residentAnnotationViewportSelectionQueries,
    residentAnnotationViewportSelectedPageCount: host.residentAnnotationViewportSelectedPageCount,
    residentAnnotationViewportSelectedFeatureCount:
      host.residentAnnotationViewportSelectedFeatureCount,
    residentAnnotationViewportExpectedPageCount: host.residentAnnotationViewportExpectedPageCount,
    residentAnnotationViewportMissingPageCount: host.residentAnnotationViewportMissingPageCount,
    residentAnnotationViewportCoverageComplete: host.residentAnnotationViewportCoverageComplete,
    residentAnnotationViewportProducerCoverageComplete:
      host.residentAnnotationViewportProducerCoverageComplete,
    retainedLinearTranscriptBlockCount: host.retainedLinearTranscriptBlockCount,
    retainedLinearTranscriptStaleHolds: host.retainedLinearTranscriptStaleHolds,
    retainedLinearTranscriptLastBuildCause: host.retainedLinearTranscriptLastBuildCause,
    retainedTranscriptDecorationBuilds: host.retainedTranscriptDecorationBuilds,
    prebuiltGenomeWideTextureLoaded: host.genomeWideTextureCacheLayer?.hasPrebuilt() ?? false,
    prebuiltGenomeWideTextureContractMatch: host.prebuiltRasterContractForLastFrame.contractMatch,
    prebuiltGenomeWideTextureSourceMatch: host.prebuiltRasterContractForLastFrame.sourceMatch,
    prebuiltGenomeWideTexturePlacementMatch: host.prebuiltRasterContractForLastFrame.placementMatch,
    prebuiltGenomeWideTextureSourceFingerprint:
      host.prebuiltRasterContractForLastFrame.artifactSourceFingerprint,
    prebuiltGenomeWideTexturePlacementFingerprint:
      host.prebuiltRasterContractForLastFrame.artifactPlacementFingerprint,
    prebuiltGenomeWideTextureLayerTypes: [
      ...host.prebuiltRasterContractForLastFrame.artifactLayerTypes,
    ],
    prebuiltGenomeWideTextureWidthPx: host.genomeWideTextureCacheLayer?.prebuiltWidthPx ?? 0,
    prebuiltGenomeWideTextureResolution: host.genomeWideTextureCacheLayer?.prebuiltResolution ?? 1,
    prebuiltGenomeWideComposites: host.genomeWideTextureCacheLayer?.prebuiltCompositeCount ?? 0,
    compiledBroadSurfacePlanStatus: host.compiledBroadSurfacePlanStatus,
    compiledBroadSurfaceDiagnostics: host.compiledBroadSurfacePresenter?.diagnostics() ?? null,
    compiledBroadSurfaceProvenanceValid: host.compiledBroadSurfaceProvenanceIsCurrent(
      host.compiledBroadSurfaceManifest,
      host.compiledBroadSurfaceProvenance
    ),
    compiledBroadSurfaceProvenanceManifestFingerprint:
      host.compiledBroadSurfaceProvenance?.manifestFingerprint ?? null,
    compiledBroadSurfaceProvenanceSourceFingerprint:
      host.compiledBroadSurfaceProvenance?.sourceFingerprint ?? null,
    compiledBroadSurfaceProvenancePlacementFingerprint:
      host.compiledBroadSurfaceProvenance?.placementFingerprint ?? null,
    compiledBroadSurfaceProvenancePrepackedOwnerKey:
      host.compiledBroadSurfaceProvenance?.prepackedOwnerKey ?? null,
    compiledBroadSurfaceProvenancePrepackedArtifactKey:
      host.compiledBroadSurfaceProvenance?.prepackedArtifactKey ?? null,
    compiledBroadSurfaceRgbaAdmissions: host.compiledBroadSurfaceRgbaAdmissions,
    compiledBroadSurfaceGpuPreuploads: host.compiledBroadSurfaceGpuPreuploads,
    compiledBroadSurfaceExplicitRgbaCopyBytes: host.compiledBroadSurfaceExplicitRgbaCopyBytes,
    compiledBroadSurfaceGpuPreuploadedBytes: host.compiledBroadSurfaceGpuPreuploadedBytes,
    compiledBroadSurfacePostPresentGpuUploads: host.compiledBroadSurfacePostPresentGpuUploads,
    compiledBroadSurfacePostPresentGpuUploadBytes:
      host.compiledBroadSurfacePostPresentGpuUploadBytes,
    compiledBroadSurfacePlanDerivationCount: host.compiledBroadSurfacePlanDerivationCount,
    compiledBroadSurfaceCameraContractCreateCount:
      host.compiledBroadSurfaceCameraContractCreateCount,
    compiledBroadSurfaceFastCameraMailboxCreateCount:
      host.compiledBroadSurfaceFastCameraMailboxCreateCount,
    compiledBroadSurfaceGpuPreuploadFailures: host.compiledBroadSurfaceGpuPreuploadFailures,
    retainedLinearTranscriptVisibleFeatureCount: host.retainedLinearTranscriptVisibleFeatureCount,
    retainedTranscriptDecorationsDrawn: host.lastRetainedTranscriptDecorationsDrawn,
    retainedLinearSourceWindowStartBp: host.retainedLinearSourceWindow?.startBp ?? null,
    retainedLinearSourceWindowEndBp: host.retainedLinearSourceWindow?.endBp ?? null,
    retainedLinearSourceWindowFeatureCount: host.retainedLinearSourceWindow?.features.length ?? 0,
    retainedLinearSourceWindowFeatureSamples: sourceWindowFeatureSamples,
    lastInteractionOutlineCommandCount: host.lastInteractionOutlineCommandCount,
    annotationSearchFocusMaskDrawCount: host.annotationSearchFocusMaskDrawCount,
    annotationSearchFocusPrimitiveDrawCount: host.annotationSearchFocusPrimitiveDrawCount,
    annotationSearchFocusResolvedTrackId: host.annotationSearchFocusResolvedTrackId,
    annotationSearchFocusResolvedCanonicalIdentity:
      host.annotationSearchFocusResolvedCanonicalIdentity,
    annotationSearchFocusPresentationLane: host.annotationSearchFocusPresentationLane,
    featureCount: host.features.length,
    drawnFeatureCount: host.lastDrawnFeatureCount,
    immediateDrawnLayerTypes: [...host.lastImmediateDrawnLayerTypes].sort((a, b) =>
      a.localeCompare(b)
    ),
    hitRecords: host.hitCache.length,
    renderCalls: host.renderCallCount,
    geometryRebuilds: host.geometryRebuildCount,
    geometryCacheHits: host.geometryCacheHitCount,
    lastRenderMode: host.lastRenderMode,
    lastGeometryRebuildReasons: host.lastGeometryRebuildReasons,
    overviewAggregationEnabled: host.lastOverviewAggregationEnabled,
    overviewAggregationCacheHit: host.lastOverviewAggregationCacheHit,
    overviewPassthroughFeatureCount: host.lastOverviewPassthroughFeatureCount,
    overviewDensityAtlasBinBp: host.lastOverviewDensityAtlasBinBp,
    overviewDensityAtlasSampleScreenPx: host.lastOverviewDensityAtlasSampleScreenPx,
    overviewDensityAtlasLevelCount: host.lastOverviewDensityAtlasLevelCount,
    overviewDensityAtlasEstimatedBinCount: host.lastOverviewDensityAtlasEstimatedBinCount,
    overviewDensityAtlasWasCoarsened: host.lastOverviewDensityAtlasWasCoarsened,
    overviewDensityAtlasBudgetExceeded: host.lastOverviewDensityAtlasBudgetExceeded,
    overviewLodCompressionBlend: host.lastOverviewLodCompressionBlend,
    overviewLodFullShapeBlend: host.lastOverviewLodFullShapeBlend,
    overviewCacheMs: host.lastOverviewCacheMs,
    overviewImmediateBlendMs: host.lastOverviewImmediateBlendMs,
    ...presentation,
    overviewGlyphTilesPresenting: host.rttGlyphTilePyramidCompositor?.isPresenting ?? false,
    overviewGlyphTilesDrawLevel: host.rttGlyphTilePyramidCompositor?.drawLevel ?? null,
    overviewGlyphTilesTargetLevel: host.rttGlyphTilePyramidCompositor?.targetLevel ?? null,
    overviewGlyphTilesPresentingTileCount:
      host.rttGlyphTilePyramidCompositor?.presentingTileCount ?? 0,
    overviewGlyphTilesBuildCount: host.rttGlyphTilePyramidCompositor?.buildCount ?? 0,
    overviewGlyphTilesCompositeCount: host.rttGlyphTilePyramidCompositor?.compositeCount ?? 0,
    prepackedAnnotationSceneLoaded: host.prepackedAnnotationSceneLayer !== null,
    prepackedAnnotationSceneOwner: host.getPrepackedAnnotationSceneOwnerSnapshot(),
    prepackedAnnotationSceneStatus: host.prepackedAnnotationSceneStatus,
    prepackedAnnotationSceneLayerCreates: host.prepackedAnnotationSceneLayerCreates,
    prepackedAnnotationSceneLayerDestroys: host.prepackedAnnotationSceneLayerDestroys,
    prepackedAnnotationSceneRetiredLayerCount: host.retiredPrepackedAnnotationSceneLayers.size,
    prepackedAnnotationSceneGpuPreparations: host.prepackedAnnotationSceneGpuPreparations,
    prepackedAnnotationSceneResidentGeneration: host.prepackedAnnotationSceneResidentGeneration,
    prepackedAnnotationSceneResidentOwnerCount: host.prepackedAnnotationSceneResidents.size,
    prepackedAnnotationScenePreparedOwnerKeys: [
      ...host.prepackedAnnotationSceneResidents.keys(),
    ].sort((left, right) => left.localeCompare(right)),
    compiledBroadAnnotationInteractionResidentGeneration:
      host.compiledBroadAnnotationInteractionResidentGeneration,
    compiledBroadAnnotationInteractionPreparedOwnerKeys: [
      ...host.compiledBroadAnnotationInteractionResidents.keys(),
    ].sort((left, right) => left.localeCompare(right)),
    prepackedAnnotationSceneVisibleResidentOwnerKeys: [
      ...host.prepackedAnnotationSceneResidents.values(),
    ]
      .filter(({ layer }) => layer?.isPresenting)
      .map(({ ownerKey }) => ownerKey)
      .sort((left, right) => left.localeCompare(right)),
    prepackedAnnotationSceneGpuPrepared:
      diagnosticPrepackedResidents.length > 0 &&
      diagnosticPrepackedResidents.every(({ layer }) => layer?.isGpuPrepared === true),
    prepackedAnnotationSceneCameraUpdates: host.prepackedAnnotationSceneCameraUpdates,
    prepackedAnnotationSceneVisiblePartitionCount:
      host.prepackedAnnotationSceneVisiblePartitionCount,
    prepackedAnnotationSceneVisibleInstanceCount: host.prepackedAnnotationSceneVisibleInstanceCount,
    prepackedAnnotationScenePresentationLayouts: [
      ...host.prepackedAnnotationSceneResidents.values(),
    ]
      .filter(({ layer }) => layer?.isPresenting)
      .map(({ ownerKey, metadata, layer }) => ({
        ownerKey,
        trackType: metadata.trackType,
        ...(layer?.getPresentationLayoutDebug?.() ?? {
          screenAnchorYCssPx: 0,
          viewportWidthCssPx: 0,
          viewportHeightCssPx: 0,
        }),
      }))
      .sort((left, right) => left.trackType.localeCompare(right.trackType)),
    prepackedAnnotationSceneStartupBuilds: host.prepackedAnnotationSceneStartupBuilds,
    prepackedAnnotationInteractionReady: diagnosticPrepackedInteractionReady,
    prepackedAnnotationInteractionSchema: diagnosticPrepackedInteractionReady
      ? PREPACKED_ANNOTATION_INTERACTION_INDEX_V2
      : null,
    prepackedAnnotationInteractionFeatureCount: diagnosticPrepackedResidents.reduce(
      (count, resident) => count + (resident.input?.interactionIndex?.featureCount ?? 0),
      0
    ),
    prepackedAnnotationInteractionPrimitiveCount: diagnosticPrepackedResidents.reduce(
      (count, resident) => count + (resident.input?.interactionIndex?.primitiveCount ?? 0),
      0
    ),
    prepackedAnnotationInteractionVisualCouplingValidated: diagnosticPrepackedInteractionReady,
    prepackedAnnotationInteractionCouplingValidationCount:
      host.prepackedAnnotationInteractionCouplingValidationCount,
    prepackedAnnotationInteractionCouplingPrimitiveScanCardinality:
      host.prepackedAnnotationInteractionCouplingPrimitiveScanCardinality,
    prepackedAnnotationTrustedV4AdmissionCount: host.prepackedAnnotationTrustedV4AdmissionCount,
    prepackedAnnotationDirectFineIndexValidationCount:
      host.prepackedAnnotationSceneLayer?.getAdmissionValidationDebug()
        .directFineIndexValidationCount ?? 0,
    prepackedAnnotationDirectFineIndexRecordScanCardinality:
      host.prepackedAnnotationSceneLayer?.getAdmissionValidationDebug()
        .directFineIndexRecordScanCardinality ?? 0,
    prepackedAnnotationTrustedV4LayerAdmission:
      diagnosticPrepackedResidents.length > 0 &&
      diagnosticPrepackedResidents.every(
        ({ layer }) => layer?.getAdmissionValidationDebug?.()?.trustedV4Admission === true
      ),
    prepackedAnnotationTrustedDirectBankLayerAdmission:
      diagnosticPrepackedResidents.length > 0 &&
      diagnosticPrepackedResidents.every(({ layer }) => {
        const admission = layer?.getAdmissionValidationDebug?.();
        return Boolean(admission?.trustedV4Admission || admission?.trustedDetailPacketAdmission);
      }),
    prepackedAnnotationTrustedLayerAdmissionRoutes: [
      ...new Set(
        diagnosticPrepackedResidents.flatMap(({ layer }) => {
          const admission = layer?.getAdmissionValidationDebug?.();
          return [
            ...(admission?.trustedV4Admission ? (['v4-artifact'] as const) : []),
            ...(admission?.trustedDetailPacketAdmission
              ? (['viewport-detail-packet'] as const)
              : []),
          ];
        })
      ),
    ],
    prepackedAnnotationInteractionQueries: host.prepackedAnnotationInteractionQueries,
    prepackedAnnotationInteractionLastVisitedNodes:
      host.prepackedAnnotationInteractionLastVisitedNodes,
    prepackedAnnotationInteractionMaxVisitedNodes:
      host.prepackedAnnotationInteractionMaxVisitedNodes,
    prepackedAnnotationInteractionLastPrimitiveCandidates:
      host.prepackedAnnotationInteractionLastPrimitiveCandidates,
    prepackedAnnotationInteractionP99Ms: host.prepackedAnnotationInteractionP99Ms(),
    prepackedAnnotationInteractionMaxMs: host.prepackedAnnotationInteractionMaxMs,
    layout: annotationDebugLayoutSnapshot(host._layout, host.maxAnnotationLane, host.maxCdsLane),
    drawAudit: host.lastDrawAudit,
  };
}
