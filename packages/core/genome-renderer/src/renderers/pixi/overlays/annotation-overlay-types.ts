import type { AnnotationDrawAuditSnapshot } from './annotation-draw-audit';
import type {
  AnnotationDebugLayoutSnapshot,
  AnnotationPresentationDebugSnapshot,
} from './annotation-presentation-debug';
import type { AnnotationFrameRenderMode } from './annotation-render-mode';
import type { AnnotationVisualGroup } from './annotation-presentation-owners';
import type {
  CompiledBroadSurfacePixiDiagnosticsV2,
  CompiledBroadSurfacePixiReadinessDiagnosticsV2,
} from '../overview/compiled-broad-surface-pixi-presenter';
import type { BroadSurfaceIsoformModeV2 } from '../overview/bounded-annotation-broad-surface';
import {
  PREPACKED_ANNOTATION_INTERACTION_INDEX_V2,
  type PrepackedAnnotationFeatureLookupIndexV2,
} from '../overview/prepacked-annotation-interaction-index-v2';
import type {
  PrepackedAnnotationSceneMetadata,
  PrepackedAnnotationSceneOwnerSnapshot,
  PrepackedAnnotationSceneStatus,
} from '../overview/prepacked-annotation-scene';
import type { AnnotationPolicyProjectionTableV1 } from '../overview/annotation-policy-projection-v1';
import { TRUSTED_MAIN_COMPILED_BROAD_ANNOTATION_INTERACTION_VALIDATION_V1 } from '../overview/compiled-broad-annotation-interaction-binary-v1';

export type AnnotationOverlayDebugSnapshot = {
  straightLabelCount: number;
  straightLabelAlphas: number[];
  straightLabelResolutions: number[];
  curvedGlyphCount: number;
  curvedGlyphRotations: number[];
  curvedGlyphFontSizes: number[];
  curvedGlyphScales: number[];
  curvedGlyphResolutions: number[];
  curvedGlyphPositions: Array<{ x: number; y: number }>;
  overviewBinDrawCount: number;
  retainedLinearDataBuilds: number;
  retainedLinearBinCount: number;
  retainedLinearTranscriptBuilds: number;
  retainedLinearTranscriptPacks: number;
  residentAnnotationPageCount: number;
  residentAnnotationPageBytes: number;
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
  retainedLinearTranscriptBlockCount: number;
  retainedLinearTranscriptStaleHolds: number;
  retainedLinearTranscriptLastBuildCause: string;
  retainedTranscriptDecorationBuilds: number;
  prebuiltGenomeWideTextureLoaded: boolean;
  prebuiltGenomeWideTextureContractMatch: boolean;
  prebuiltGenomeWideTextureSourceMatch: boolean;
  prebuiltGenomeWideTexturePlacementMatch: boolean;
  prebuiltGenomeWideTextureSourceFingerprint: string | null;
  prebuiltGenomeWideTexturePlacementFingerprint: string | null;
  prebuiltGenomeWideTextureLayerTypes: string[];
  prebuiltGenomeWideTextureWidthPx: number;
  prebuiltGenomeWideTextureResolution: number;
  prebuiltGenomeWideComposites: number;
  compiledBroadSurfacePlanStatus: CompiledBroadSurfacePlanStatusV2;
  compiledBroadSurfaceDiagnostics: CompiledBroadSurfacePixiDiagnosticsV2 | null;
  compiledBroadSurfaceProvenanceValid: boolean;
  compiledBroadSurfaceProvenanceManifestFingerprint: string | null;
  compiledBroadSurfaceProvenanceSourceFingerprint: string | null;
  compiledBroadSurfaceProvenancePlacementFingerprint: string | null;
  compiledBroadSurfaceProvenancePrepackedOwnerKey: string | null;
  compiledBroadSurfaceProvenancePrepackedArtifactKey: string | null;
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
  retainedTranscriptDecorationsDrawn: boolean;
  retainedLinearSourceWindowStartBp: number | null;
  retainedLinearSourceWindowEndBp: number | null;
  retainedLinearSourceWindowFeatureCount: number;
  retainedLinearSourceWindowFeatureSamples: Array<{
    id: number;
    type: string;
    start: number;
    end: number;
    lane: number;
    cdsLane: number | null;
    exonCount: number;
    cdsCount: number;
    outlineOnly: boolean;
    laneEnvelopeResolved: boolean;
  }>;
  lastInteractionOutlineCommandCount: number;
  annotationSearchFocusMaskDrawCount: number;
  annotationSearchFocusPrimitiveDrawCount: number;
  annotationSearchFocusResolvedTrackId: string | null;
  annotationSearchFocusResolvedCanonicalIdentity: string | null;
  annotationSearchFocusPresentationLane: number | null;
  featureCount: number;
  drawnFeatureCount: number;
  immediateDrawnLayerTypes: string[];
  hitRecords: number;
  renderCalls: number;
  geometryRebuilds: number;
  geometryCacheHits: number;
  lastRenderMode: AnnotationFrameRenderMode;
  lastGeometryRebuildReasons: string[];
  overviewAggregationEnabled: boolean;
  overviewAggregationCacheHit: boolean;
  overviewPassthroughFeatureCount: number;
  overviewDensityAtlasBinBp: number;
  overviewDensityAtlasSampleScreenPx: number;
  overviewDensityAtlasLevelCount: number;
  overviewDensityAtlasEstimatedBinCount: number;
  overviewDensityAtlasWasCoarsened: boolean;
  overviewDensityAtlasBudgetExceeded: boolean;
  overviewLodCompressionBlend: number;
  overviewLodFullShapeBlend: number;
  overviewCacheMs: number;
  overviewImmediateBlendMs: number;
  annotationLodBackend: string | null;
  annotationPresentationStyleId: string | null;
  annotationLodContractViolation: string | null;
  annotationPresentationOwnerViolations: string[];
  layoutInvariantViolations: string[];
  annotationPresentationLayerTypes: string[];
  annotationPresentationOwners: AnnotationPresentationDebugSnapshot['annotationPresentationOwners'];
  runtimeGenomeWideTextureVisible: boolean;
  prebuiltGenomeWideTextureVisible: boolean;
  compiledBroadRasterVisible: boolean;
  sidecarTrackRasterVisible: boolean;
  sidecarTrackRasterLayerTypes: string[];
  rasterOwnerCount: number;
  prebuiltGenomeWideTextureEligible: boolean;
  retainedLinearVisibleMeshCount: number;
  tilePyramidVectorVisibleLayerCount: number;
  tilePyramidVectorPresentingBlockCount: number;
  tilePyramidVectorCoverageLevel: number | null;
  tilePyramidVectorVisibleTileFirst: number | null;
  tilePyramidVectorVisibleTileLast: number | null;
  tilePyramidVectorExpectedVisibleTileCount: number;
  tilePyramidVectorBuiltVisibleTileCount: number;
  tilePyramidVectorMissingVisibleTileCount: number;
  tilePyramidVectorCoverageComplete: boolean;
  overviewGlyphTilesPresenting: boolean;
  overviewGlyphTilesDrawLevel: number | null;
  overviewGlyphTilesTargetLevel: number | null;
  overviewGlyphTilesPresentingTileCount: number;
  overviewGlyphTilesBuildCount: number;
  overviewGlyphTilesCompositeCount: number;
  prepackedAnnotationSceneLoaded: boolean;
  prepackedAnnotationSceneOwner: PrepackedAnnotationSceneOwnerSnapshot;
  prepackedAnnotationSceneStatus: PrepackedAnnotationSceneStatus;
  prepackedAnnotationSceneLayerCreates: number;
  prepackedAnnotationSceneLayerDestroys: number;
  prepackedAnnotationSceneRetiredLayerCount: number;
  prepackedAnnotationSceneGpuPreparations: number;
  prepackedAnnotationSceneResidentGeneration: number;
  prepackedAnnotationSceneResidentOwnerCount: number;
  prepackedAnnotationScenePreparedOwnerKeys: string[];
  compiledBroadAnnotationInteractionResidentGeneration: number;
  compiledBroadAnnotationInteractionPreparedOwnerKeys: string[];
  prepackedAnnotationSceneVisibleResidentOwnerKeys: string[];
  prepackedAnnotationSceneGpuPrepared: boolean;
  prepackedAnnotationSceneCameraUpdates: number;
  prepackedAnnotationSceneVisiblePartitionCount: number;
  prepackedAnnotationSceneVisibleInstanceCount: number;
  prepackedAnnotationScenePresentationLayouts: Array<{
    ownerKey: string;
    trackType: string;
    screenAnchorYCssPx: number;
    viewportWidthCssPx: number;
    viewportHeightCssPx: number;
  }>;
  prepackedAnnotationSceneStartupBuilds: number;
  prepackedAnnotationInteractionReady: boolean;
  prepackedAnnotationInteractionSchema: typeof PREPACKED_ANNOTATION_INTERACTION_INDEX_V2 | null;
  prepackedAnnotationInteractionFeatureCount: number;
  prepackedAnnotationInteractionPrimitiveCount: number;
  prepackedAnnotationInteractionVisualCouplingValidated: boolean;
  prepackedAnnotationInteractionCouplingValidationCount: number;
  prepackedAnnotationInteractionCouplingPrimitiveScanCardinality: number;
  prepackedAnnotationTrustedV4AdmissionCount: number;
  prepackedAnnotationDirectFineIndexValidationCount: number;
  prepackedAnnotationDirectFineIndexRecordScanCardinality: number;
  prepackedAnnotationTrustedV4LayerAdmission: boolean;
  prepackedAnnotationTrustedDirectBankLayerAdmission: boolean;
  prepackedAnnotationTrustedLayerAdmissionRoutes: Array<'v4-artifact' | 'viewport-detail-packet'>;
  prepackedAnnotationInteractionQueries: number;
  prepackedAnnotationInteractionLastVisitedNodes: number;
  prepackedAnnotationInteractionMaxVisitedNodes: number;
  prepackedAnnotationInteractionLastPrimitiveCandidates: number;
  prepackedAnnotationInteractionP99Ms: number;
  prepackedAnnotationInteractionMaxMs: number;
  layout: AnnotationDebugLayoutSnapshot | null;
  drawAudit: AnnotationDrawAuditSnapshot | null;
};

export const ANNOTATION_OVERLAY_COLD_GESTURE_SNAPSHOT_V1 =
  'annotation-overlay-cold-gesture-snapshot.v1' as const;

export interface CompiledBroadSurfaceSourcePlacementAuthorityV1 {
  readonly genomeIdentity: string;
  readonly genomeLengthBp: number;
  readonly sourceFingerprint: string;
  readonly placementFingerprint: string;
}

export interface CompiledBroadSurfaceCellDemandAddressV2 {
  readonly cellId: string;
  readonly isoformMode: BroadSurfaceIsoformModeV2;
  readonly level: number;
  readonly tileX: number;
  readonly laneSlabIndex: number;
}

export type CompiledBroadSurfacePlanStatusV2 =
  | 'not-loaded'
  | 'broad-presenting'
  | 'broad-holding-last-good'
  | 'broad-cells-missing'
  | 'broad-artifact-required'
  | 'detail-required'
  | 'rejected';

export type { CompiledBroadSurfaceResidentLeaseReconcileResultV1 } from './indexed-compiled-broad-owner-lifecycle';

export type AnnotationPresentationPolicyCommitDispositionV1 = Readonly<
  | {
      status: 'committed';
      policyGeneration: number;
    }
  | {
      status: 'deferred';
      reason: 'selected-raster-roster-incomplete';
    }
  | {
      status: 'rejected';
      reason: 'annotation-policy-commit-rejected';
    }
>;

export type CompiledBroadSurfaceRuntimeDiagnosticsV2 = CompiledBroadSurfacePixiDiagnosticsV2 &
  Readonly<{
    provenanceValid: boolean;
    provenanceManifestFingerprint: string | null;
    provenanceSourceFingerprint: string | null;
    provenancePlacementFingerprint: string | null;
    provenancePrepackedOwnerKey: string | null;
    provenancePrepackedArtifactKey: string | null;
    legacyRasterVisible: boolean;
    compiledRasterVisible: boolean;
    rasterOwnerCount: number;
    rgbaAdmissionCount: number;
    gpuPreuploadCount: number;
    explicitRgbaCopyBytes: number;
    gpuPreuploadedBytes: number;
    postPresentGpuUploadCount: number;
    postPresentGpuUploadBytes: number;
    gpuPreuploadFailureCount: number;
    planDerivationCount: number;
    cameraContractCreateCount: number;
    fastCameraMailboxCreateCount: number;
  }>;

export type CompiledBroadSurfaceRuntimeReadinessDiagnosticsV2 =
  CompiledBroadSurfacePixiReadinessDiagnosticsV2 &
    Readonly<{
      provenanceValid: boolean;
      provenanceManifestFingerprint: string | null;
      provenanceSourceFingerprint: string | null;
      provenancePlacementFingerprint: string | null;
      provenancePrepackedOwnerKey: string | null;
      provenancePrepackedArtifactKey: string | null;
      legacyRasterVisible: boolean;
      compiledRasterVisible: boolean;
      rasterOwnerCount: number;
      gpuPreuploadFailureCount: number;
    }>;

export const ANNOTATION_OVERLAY_POLICY_READINESS_SNAPSHOT_V1 =
  'annotation-overlay-policy-readiness-snapshot.v1' as const;

export interface AnnotationOverlayPolicyReadinessSnapshotV1 {
  readonly contract: typeof ANNOTATION_OVERLAY_POLICY_READINESS_SNAPSHOT_V1;
  readonly annotationPresentationOwnerViolations: readonly string[];
  readonly annotationPresentationLayerTypes: readonly string[];
  readonly annotationPresentationOwners: AnnotationPresentationDebugSnapshot['annotationPresentationOwners'];
  readonly prebuiltGenomeWideTextureLoaded: boolean;
  readonly prebuiltGenomeWideTextureContractMatch: boolean;
  readonly prebuiltGenomeWideTextureSourceMatch: boolean;
  readonly prebuiltGenomeWideTexturePlacementMatch: boolean;
  readonly prebuiltGenomeWideTexturePlacementFingerprint: string | null;
  readonly prebuiltGenomeWideTextureLayerTypes: readonly string[];
  readonly prebuiltGenomeWideTextureVisible: boolean;
  readonly prebuiltGenomeWideTextureEligible: boolean;
  readonly compiledBroad: CompiledBroadSurfaceRuntimeReadinessDiagnosticsV2 | null;
}

export type AnnotationColdGestureOwnerId =
  | 'compiled-raster-surface'
  | 'compiled-broad-raster-surface'
  | 'overview-glyph-tile-surface'
  | 'compiled-vector-surface'
  | 'prepacked-partitioned-vector-surface'
  | 'active-segment-retained-surface'
  | 'single-chrom-live-surface';

export interface AnnotationSearchFocusPresentationSnapshot {
  readonly annotationSearchFocusResolvedTrackId: string | null;
  readonly annotationSearchFocusResolvedCanonicalIdentity: string | null;
  readonly annotationSearchFocusPresentationLane: number | null;
}

export const COMPILED_BROAD_ANNOTATION_INTERACTION_AUTHORITY_SNAPSHOT_V1 =
  'compiled-broad-annotation-interaction-authority-snapshot.v1' as const;

export interface CompiledBroadAnnotationInteractionAuthoritySnapshotV1 {
  readonly contract: typeof COMPILED_BROAD_ANNOTATION_INTERACTION_AUTHORITY_SNAPSHOT_V1;
  readonly residentGeneration: number;
  readonly preparedOwnerKeys: readonly string[];
}

export interface AnnotationOverlayColdGestureSnapshot {
  readonly contract: typeof ANNOTATION_OVERLAY_COLD_GESTURE_SNAPSHOT_V1;
  readonly genomeIdentity: string;
  readonly genomeLengthBp: number;
  readonly presentationVisible: boolean;
  readonly requestedLayerTypes: readonly string[];
  readonly lastCompleteLayerTypes: readonly string[];
  readonly requestedResidentTracks: readonly Readonly<{
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
  }>[];
  readonly requestedLayerM_RNAOnly: boolean;
  readonly soleOwnerCount: number;
  readonly soleOwnerId: AnnotationColdGestureOwnerId | null;
  readonly soleOwnerRole: 'floor' | 'exact' | 'live' | null;
  readonly soleOwnerLayerTypes: readonly string[];
  readonly soleOwnerVisualGroups: readonly AnnotationVisualGroup[];
  readonly soleOwnerCoverageComplete: boolean;
  readonly soleOwnerContractValid: boolean;
  readonly activeOwnerKey: string | null;
  readonly activeOwnerGeneration: number;
  readonly activeArtifactKey: string | null;
  readonly activeSourceIdentity: string | null;
  readonly activeTrackType: string | null;
  readonly activeRuntimeIsoformMode: string | null;
  readonly activeRuntimeLaneLimit: number | null;
  readonly activePolicyGeneration: number;
  readonly activeSourceFingerprint: string | null;
  readonly activePlacementFingerprint: string | null;
  readonly runtimeGenomeWideTextureVisible: boolean;
  readonly prebuiltRasterLoaded: boolean;
  readonly prebuiltRasterVisible: boolean;
  readonly prebuiltRasterEligible: boolean;
  readonly prebuiltRasterContractMatch: boolean;
  readonly prebuiltRasterSourceMatch: boolean;
  readonly prebuiltRasterPlacementMatch: boolean;
  readonly prebuiltRasterArtifactM_RNAOnly: boolean;
  readonly prebuiltRasterSourceFingerprint: string | null;
  readonly prebuiltRasterPlacementFingerprint: string | null;
  readonly prebuiltRasterCompositeCount: number;
  readonly legacyPrebuiltRasterVisible: boolean;
  readonly rasterOwnerCount: number;
  readonly compiledBroadRasterLoaded: boolean;
  readonly compiledBroadRasterVisible: boolean;
  readonly compiledBroadRasterProvenanceValid: boolean;
  readonly compiledBroadRasterProvenanceManifestFingerprint: string | null;
  readonly compiledBroadRasterProvenanceSourceFingerprint: string | null;
  readonly compiledBroadRasterProvenancePlacementFingerprint: string | null;
  readonly compiledBroadRasterProvenancePrepackedOwnerKey: string | null;
  readonly compiledBroadRasterProvenancePrepackedArtifactKey: string | null;
  readonly compiledBroadRasterHoldingLastGood: boolean;
  readonly compiledBroadRasterPlanStatus: CompiledBroadSurfacePlanStatusV2;
  readonly compiledBroadRasterResidentCellCount: number;
  readonly compiledBroadRasterSubmittedCellCount: number;
  readonly compiledBroadRasterMissingCellCount: number;
  readonly compiledBroadRasterActiveLevelIds: readonly string[];
  readonly compiledBroadRasterActiveMipWeights: readonly number[];
  readonly compiledBroadRasterActiveResidentCellIds: readonly string[];
  readonly compiledBroadRasterSubmittedCellIds: readonly string[];
  readonly compiledBroadRasterVectorSubmissionCount: 0;
  readonly compiledBroadRasterRuntimeCellCompileCount: 0;
  readonly compiledBroadRasterRuntimeDurableWriteCount: 0;
  readonly compiledBroadInteractionResidentGeneration: number;
  readonly compiledBroadInteractionRequestedOwnerPresent: boolean;
  readonly compiledBroadRasterMeshCreationCount: number;
  readonly compiledBroadRasterShaderCreationCount: number;
  readonly compiledBroadRasterGeometryCreationCount: number;
  readonly overviewGlyphTilesVisible: boolean;
  readonly overviewGlyphTilesCoverageComplete: boolean;
  readonly overviewGlyphTilesBuildCount: number;
  readonly overviewGlyphTilesCompositeCount: number;
  readonly compiledVectorVisible: boolean;
  readonly compiledVectorCoverageComplete: boolean;
  readonly retainedTranscriptVisible: boolean;
  readonly retainedSourceShapeVisible: boolean;
  readonly immediateLiveVisible: boolean;
  readonly prepackedOwnerKey: string | null;
  readonly prepackedOwnerGeneration: number;
  readonly prepackedResidentRosterGeneration: number;
  readonly prepackedRequestedResidentCount: number;
  readonly prepackedRequestedResidentRosterReady: boolean;
  readonly prepackedRequestedSingleResidentOwnerKey: string | null;
  readonly prepackedRequestedSingleResidentArtifactKey: string | null;
  readonly prepackedRequestedSingleResidentCoverageStartBp: number | null;
  readonly prepackedRequestedSingleResidentCoverageEndBp: number | null;
  readonly prepackedRequestedSingleResidentHandoffStartBp: number | null;
  readonly prepackedRequestedSingleResidentHandoffEndBp: number | null;
  readonly prepackedRequestedSingleResidentPresentationAdmitted: boolean | null;
  readonly prepackedLoaded: boolean;
  readonly prepackedStatus: PrepackedAnnotationSceneStatus;
  readonly prepackedGpuPrepared: boolean;
  readonly prepackedMetadataGenomeIdentity: string | null;
  readonly prepackedMetadataGenomeLengthBp: number | null;
  readonly prepackedMetadataPartitionSpanBp: number | null;
  readonly prepackedMetadataArtifactKey: string | null;
  readonly prepackedMetadataThemeMode: string | null;
  readonly prepackedMetadataTrackType: string | null;
  readonly prepackedMetadataAnnotationBarHeightPx: number | null;
  readonly prepackedMetadataLaneAlgorithmToken: string | null;
  readonly prepackedMetadataMapperContractToken: string | null;
  readonly prepackedMetadataGeometryContractToken: string | null;
  readonly prepackedMetadataInteractionContractToken: string | null;
  readonly prepackedRuntimeIsoformMode: string | null;
  readonly prepackedRuntimeLaneLimit: number | null;
  readonly prepackedPolicyGeneration: number;
  readonly prepackedSubmittedPartitionCount: number;
  readonly prepackedSubmittedInstanceCount: number;
  readonly prepackedSceneLayerCreates: number;
  readonly prepackedSceneLayerDestroys: number;
  readonly prepackedSceneGpuPreparations: number;
  readonly prepackedSceneVisiblePartitionCount: number;
  readonly prepackedSceneVisibleInstanceCount: number;
  readonly prepackedSceneStartupBuilds: number;
  readonly retainedLinearDataBuilds: number;
  readonly retainedLinearTranscriptBuilds: number;
  readonly retainedLinearTranscriptPacks: number;
  readonly retainedTranscriptDecorationBuilds: number;
}

export interface CompiledBroadAnnotationInteractionLoadInputV1 {
  readonly validationMarker: typeof TRUSTED_MAIN_COMPILED_BROAD_ANNOTATION_INTERACTION_VALIDATION_V1;
  readonly ownerKey: string;
  readonly sourceFingerprint: string;
  readonly interactionPayloadSha256: string;
  readonly sourceScene: Readonly<{
    byteCount: number;
    payloadSha256: string;
    contractSha256: string;
  }>;
  readonly metadata: PrepackedAnnotationSceneMetadata;
  readonly policyProjection: AnnotationPolicyProjectionTableV1;
  readonly featureLookup: PrepackedAnnotationFeatureLookupIndexV2;
}
