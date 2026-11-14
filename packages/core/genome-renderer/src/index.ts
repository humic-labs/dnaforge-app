export type {
  Feature,
  AnnotationCodonCarrierPagePublication,
  AnnotationFlatPresentationSnapshot,
  AnnotationFullBodyResidentPagePublication,
  AnnotationPresentationPage,
  AnnotationResidentPagePublication,
  AnnotationResidentPagePublicationApplyResult,
  AnnotationPresentationSnapshot,
  AnnotationPresentationSnapshotApplyResult,
  AnnotationPresentationSnapshotRejectionReason,
  AnnotationSearchFocus,
  AnnotationChangeDecoration,
  LinearSequencePresentation,
  Primer,
  PrimerHandleDragPreview,
  Genome,
  GenomeOrf,
  GenomeOrfIdentity,
  BackboneSegment,
  BackboneBoundaryHandle,
  RenderState,
  LODTier,
  SequenceWindow,
  GenomeTileRendererCompactAnnotationGlyph,
  GenomeTileRendererCompactAnnotationGlyphGeometry,
  GenomeTileRendererAnnotationGlyph,
  GenomeTileRendererAnnotationGlyphPayload,
  GenomeTileRendererLengthState,
  GenomeTileRendererMode,
  GenomeTileRendererScene,
  GenomeTileRendererSequencePayload,
  GenomeTileRendererSlot,
  GenomeTileRendererSlotPayload,
  GenomeTileRendererTrack,
  GenomeTileRendererTrackKind,
  GenomeTileRendererViewport,
} from './types';
export { genomeFeatures } from './types';
export {
  findAnnotationTrackIdentity,
  resolveAnnotationTrackIdentity,
  type AnnotationTrackIdentityResolution,
} from './annotation-track-identity';
export {
  annotationCodonCarrierSignature,
  isAnnotationCodonCarrier,
} from './annotation-codon-carrier';
export {
  AnnotationResidentPageStore,
  estimateAnnotationPresentationPageBytes,
  type AnnotationResidentPageIdentity,
  type AnnotationResidentPageRecord,
  type AnnotationResidentPageSelection,
  type AnnotationResidentPageStoreApplyResult,
  type AnnotationResidentPageStoreOptions,
  type AnnotationResidentPageStoreRejectionReason,
  type AnnotationResidentPageStoreTelemetryEvent,
} from './annotation-resident-page-store';

export { PixiStadiumRenderer } from './renderers/pixi/stadium-renderer';
export {
  PIXI_LINEAR_RENDERER_COLD_GESTURE_SNAPSHOT_V1,
  PIXI_LINEAR_RENDERER_OPERATION_SNAPSHOT_V1,
  PixiLinearRenderer,
  type PixiLinearRendererContentOperation,
  type PixiLinearRendererColdGestureSnapshot,
  type PixiLinearRendererLaneScreenSnapshot,
  type PixiLinearRendererOperationSnapshot,
  type PixiLinearTrackColdGestureSnapshot,
} from './renderers/pixi/linear-renderer';
export { IndexedPixiLinearRenderer } from './renderers/pixi/indexed-linear-renderer';
export { IndexedAnnotationOverlay } from './renderers/pixi/overlays/annotation-overlay';
export {
  PILEUP_MAX_COLUMN_BARS,
  PILEUP_READ_DENSITY_SUPERSAMPLE_X,
  pileupDensitySampleColumnCount,
} from './renderers/pixi/linear-tracks/pileup-density-sampling';
export {
  COVERAGE_GPU_ATLAS_CONTRACT,
  COVERAGE_GPU_ATLAS_MAX_CHROMOSOMES,
  buildCoverageGpuAtlas,
  coverageGpuAtlasChromosomeAt,
  coverageGpuAtlasEligible,
  coverageGpuAtlasMipLevel,
  coverageGpuAtlasLogColorFill,
  sampleCoverageGpuAtlas,
  sampleCoverageGpuAtlasSmoothed,
  type BuildCoverageGpuAtlasInput,
  type CoverageGpuAtlasLayerInput,
} from './renderers/pixi/linear-tracks/coverage-gpu-atlas';

export type {
  OverlayTrack,
  OverlayPosition,
  OverlayHitResult,
  RetainedOverlayCameraState,
  RetainedOverlayDebugSnapshot,
  RetainedOverlayFallbackReason,
  RetainedOverlayRenderMode,
  RetainedOverlayTrack,
} from './renderers/pixi/overlays/overlay-track';
export { isRetainedOverlayTrack } from './renderers/pixi/overlays/overlay-track';
export { OverlayRegistry } from './renderers/pixi/overlays/overlay-registry';
export {
  ANNOTATION_OVERLAY_COLD_GESTURE_SNAPSHOT_V1,
  COMPILED_BROAD_ANNOTATION_INTERACTION_AUTHORITY_SNAPSHOT_V1,
  COMPILED_BROAD_SURFACE_DEMAND_LEASE_V1,
  COMPILED_BROAD_SURFACE_DEMAND_V2,
  COMPILED_BROAD_SURFACE_REQUIREMENT_V1,
  AnnotationOverlay,
  type AnnotationColdGestureOwnerId,
  type AnnotationOverlayColdGestureSnapshot,
  type PrepackedAnnotationFinePreparationResult,
  type CompiledBroadSurfaceCellDemandAddressV2,
  type CompiledBroadAnnotationInteractionAuthoritySnapshotV1,
  type CompiledBroadAnnotationInteractionLoadInputV1,
  type CompiledBroadSurfaceDemandStatusV2,
  type CompiledBroadSurfaceDemandV2,
  type CompiledBroadSurfacePlanStatusV2,
  type CompiledBroadSurfaceRequirementV1,
  type CompiledBroadSurfaceSourcePlacementAuthorityV1,
  type CompiledBroadSurfaceRgbaCellAdmissionInputV2,
  type CompiledBroadSurfaceRgbaCellAdmissionResultV2,
  type CompiledBroadSurfaceResidentLeaseReconcileResultV1,
  type CompiledBroadSurfaceRuntimeDiagnosticsV2,
  type CompiledBroadSurfaceTextureCellAdmissionInputV2,
  type CompiledBroadSurfaceTransparentCellAdmissionInputV2,
} from './renderers/pixi/overlays/annotation-overlay';
export { SequenceAnnotationOverlay } from './renderers/pixi/overlays/sequence-annotation-overlay';
export { PrimerOverlay } from './renderers/pixi/overlays/primer-overlay';
export {
  ANNOTATION_PREBUILT_RASTER_MESH_FILL_KNEE_FRACTION,
  ANNOTATION_PREBUILT_RASTER_MIN_TEXELS_PER_DEVICE_PX,
  GENOME_WIDE_ANNOTATION_RASTER_EXACT_MIN_VISIBLE_FRACTION,
  annotationPrebuiltRasterEligibility,
  isGenomeWideRasterAnnotationOwner,
  type AnnotationPrebuiltRasterEligibility,
  type AnnotationPrebuiltRasterEligibilityInput,
  type AnnotationPrebuiltRasterEligibilityReason,
} from './renderers/pixi/overlays/annotation-lod-ownership';
export {
  PREBUILT_ANNOTATION_RASTER_LANE_ARTIFACT_V1,
  PREBUILT_ANNOTATION_RASTER_LANE_PROJECTION_V1,
  PREBUILT_ANNOTATION_RASTER_PRESENTATION_V1,
  PREBUILT_ANNOTATION_RASTER_SOURCE_PLACEMENT_V1,
  PREBUILT_ANNOTATION_RASTERIZER_V1,
  isPrebuiltAnnotationRasterPresentationReceiptV1,
  isPrebuiltAnnotationRasterLaneProjectionV1,
  matchPrebuiltAnnotationRasterPresentation,
  prebuiltAnnotationRasterPresentationArtifactKeyV1,
  type ActiveAnnotationRasterPresentationContract,
  type PrebuiltAnnotationRasterContractMatch,
  type PrebuiltAnnotationRasterLaneProjectionV1,
  type PrebuiltAnnotationRasterPresentationIdentityV1,
  type PrebuiltAnnotationRasterPresentationReceiptV1,
} from './renderers/pixi/overview/prebuilt-annotation-raster-contract';
export type { PrebuiltGenomeWideTextureMeta } from './renderers/pixi/overview/genome-wide-texture-cache-layer';
export {
  COMPILED_BROAD_SURFACE_ADMISSION_PROVENANCE_V1,
  COMPILED_BROAD_SURFACE_MAX_FINITE_LANE_LIMIT_V2,
  type CompiledBroadSurfaceAdmissionProvenanceV1,
  type CompiledBroadSurfaceManifestV2,
} from './renderers/pixi/overview/bounded-annotation-broad-surface';
export {
  COMPILED_BROAD_SURFACE_FRAGMENT_SHADER_V2,
  COMPILED_BROAD_SURFACE_PIXI_PRESENTER_V2,
  COMPILED_BROAD_SURFACE_VERTEX_SHADER_V2,
  STAGED_COMPILED_BROAD_SURFACE_PIXI_PRESENTATION_V2,
  CompiledBroadSurfacePixiPresenterV2,
  createCompiledBroadSurfaceRgbaTextureV2,
  type CompiledBroadSurfaceCellAdmissionResultV2,
  type CompiledBroadSurfaceDecodedCellTextureV2,
  type CompiledBroadSurfacePixiCameraV2,
  type CompiledBroadSurfacePixiDiagnosticsV2,
  type CompiledBroadSurfacePresentedQuadDiagnosticsV2,
  type CompiledBroadSurfaceRgbaTextureV2,
  type CompiledBroadSurfaceStageResultV2,
  type CompiledBroadSurfaceTransparentCellV2,
  type StagedCompiledBroadSurfacePixiPresentationV2,
} from './renderers/pixi/overview/compiled-broad-surface-pixi-presenter';

export type { PathMapper, Pos2, Pos3 } from './renderers/pixi/shared/path-mapper';
export { LinearPathMapper, StadiumPathMapper } from './renderers/pixi/shared/path-mapper';
export {
  ASSEMBLY_PRIMER_HANDLE_METRICS,
  ASSEMBLY_PRIMER_HANDLE_VISUAL_CONTRACT_ID,
  assemblyPrimerHandleContainsPoint,
  assemblyPrimerHandleGeometry,
  assemblyPrimerHandleVisualForMode,
  type AssemblyPrimerHandleGeometry,
  type AssemblyPrimerHandlePoint,
  type AssemblyPrimerHandleVisual,
} from './renderers/pixi/shared/assembly-primer-handle-visual';

export type {
  UnifiedLayout,
  UnifiedLayoutInputs,
  OverlaySlot,
} from './renderers/pixi/shared/track-layout';
export { computeUnifiedLayout } from './renderers/pixi/shared/track-layout';
export { TRACK_STACK_END_CONTROL_HEIGHT_PX } from './track-stack-layout-contract';

export { setupInteraction } from './renderers/pixi/interaction';
export type { InteractionHandle, ShiftClickRangeResolverInput } from './renderers/pixi/interaction';
export type {
  BackbonePartHitPayload,
  BackbonePartReorderPreview,
  BackboneBoundaryHandleHitPayload,
  CodonHitPayload,
  CutSiteHitPayload,
  FeatureHitPayload,
  OrfHitPayload,
  PileupColumnHitPayload,
  PrimerHandleHitPayload,
  ReadHitPayload,
  WebGLHitTarget,
} from './renderers/pixi/shared/hit-targets';
export { readHitIdentityKey } from './renderers/pixi/shared/hit-targets';
export {
  applySelectionAction,
  buildSelectionRange,
  shiftSelectionRange,
} from './renderers/pixi/selection-state';
export type {
  SelectionAction,
  SelectionFeature,
  SelectionFeatureIdentity,
} from './renderers/pixi/selection-state';
export { recordWebGLSelectionDebug } from './renderers/pixi/selection-debug';
export type { WebGLSelectionDebugEntry } from './renderers/pixi/selection-debug';
export {
  log as perfLog,
  mark as perfMark,
  time as perfTime,
  timeAsync as perfTimeAsync,
  start as perfStart,
  end as perfEnd,
} from './perf-log';

export { isWebGLDiagnosticsEnabled } from './diagnostics-gate';

export {
  ACTIVE_COMPILED_BROAD_SURFACE_SNAPSHOT_V2,
  ACTIVE_PIXI_LINEAR_RENDERER_OPERATION_SNAPSHOT_V1,
  ACTIVE_WEBGL_COLD_GESTURE_SNAPSHOT_V1,
  activateActivePrepackedAnnotationScene,
  admitActiveCompiledBroadSurfaceSourcePlacementAuthority,
  admitActiveCompiledBroadSurfaceRgbaCell,
  admitActiveCompiledBroadSurfaceTransparentCell,
  clearActiveCompiledBroadSurfaceManifest,
  clearActiveCompiledBroadSurfaceRequirement,
  clearActivePrepackedAnnotationScene,
  clearWebGLTrace,
  getWebGLTrace,
  isWebGLTraceActive,
  loadActivePrepackedAnnotationScene,
  loadActiveCompiledBroadSurfaceManifest,
  prepareActivePrepackedAnnotationScene,
  requireActiveCompiledBroadSurface,
  recordWebGLTrace,
  registerWebGLInstance,
  scheduleWebGLPostPresentWorkForRenderer,
  startWebGLTrace,
  stopWebGLTrace,
  unregisterWebGLInstance,
  snapshotWebGLState,
  snapshotActiveAnnotationPolicyReadiness,
  snapshotActivePixiLinearRendererOperations,
  snapshotActiveWebGLColdGesture,
  snapshotActivePrepackedAnnotationSceneOwner,
  snapshotActiveCompiledBroadSurfaceDemand,
  snapshotActiveCompiledBroadSurfaceDiagnostics,
} from './webgl-registry';
export type {
  ActiveAnnotationPolicyReadinessSnapshotV1,
  ActiveCompiledBroadSurfaceDemandSnapshotV2,
  ActiveCompiledBroadSurfaceDiagnosticsSnapshotV2,
  ActivePixiLinearRendererOperationSnapshot,
  ActiveWebGLColdGestureSnapshot,
  WebGLPostPresentWorkDropReason,
  WebGLPostPresentWorkScheduleResult,
} from './webgl-registry';
export type {
  PrepackedAnnotationSceneLoadInput,
  PrepackedAnnotationSceneBuildOptions,
  PrepackedAnnotationIsoformMode,
  PrepackedAnnotationSceneMetadata,
  PrepackedAnnotationSceneOwnerSnapshot,
  PrepackedAnnotationSceneStatus,
  PrepackedAnnotationSceneArtifactKeyInput,
} from './renderers/pixi/overview/prepacked-annotation-scene';
export { PREPACKED_TRANSCRIPT_FINE_PREWARM_MAX_SPAN_BP } from './renderers/pixi/overview/partitioned-instanced-transcript-layer';
export {
  PrepackedAnnotationSceneCompileError,
  compilePrepackedAnnotationScene,
  type CompilePrepackedAnnotationSceneInput,
  type PrepackedAnnotationSceneCompileErrorCode,
} from './renderers/pixi/overview/compile-prepacked-annotation-scene';
export {
  ANNOTATION_POLICY_ABSENT_LANE,
  ANNOTATION_POLICY_FEATURE_RECORD_BYTES,
  ANNOTATION_POLICY_PROJECTION_V1,
  buildAnnotationPolicyProjectionTableV1,
  decodeAnnotationPolicyProjectionFeatureV1,
  projectAnnotationPolicyV1,
  validateAnnotationPolicyProjectionTableV1,
  visitAnnotationPolicyProjectionV1,
  type AnnotationPolicyIsoformModeV1,
  type AnnotationPolicyProjectionFeatureInputV1,
  type AnnotationPolicyProjectionFeatureV1,
  type AnnotationPolicyProjectionTableV1,
  type AnnotationPolicyRuntimeProjectionInputV1,
  type BuildAnnotationPolicyProjectionTableV1Input,
  type ProjectedAnnotationPolicyFeatureV1,
  type ProjectedAnnotationPolicyV1,
} from './renderers/pixi/overview/annotation-policy-projection-v1';
export {
  ANNOTATION_POLICY_GPU_ABSENT_LANE,
  ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT,
  ANNOTATION_POLICY_GPU_INSTANCES_V1,
  ANNOTATION_POLICY_GPU_MAX_EXACT_LANE,
  annotationPolicyLaneCenterOffsetPxV1,
  buildAnnotationPolicyGpuInstanceDataV1,
  resolveAnnotationPolicyGpuInstanceV1,
  validateAnnotationPolicyGpuInstanceDataV1,
  type AnnotationPolicyGpuRuntimeV1,
  type ResolvedAnnotationPolicyGpuInstanceV1,
} from './renderers/pixi/overview/annotation-policy-gpu-instances-v1';
export {
  ANNOTATION_POLICY_DIRECT_SUBMISSION_BANK_V1,
  assertAnnotationPolicyDirectSubmissionBankV1,
  buildAnnotationPolicyDirectFineTileBankFromValidatedStreamsV1,
  buildAnnotationPolicyDirectFineTileBankV1,
  buildAnnotationPolicyDirectSubmissionBankFromProjectionV1,
  buildAnnotationPolicyDirectSubmissionBankV1,
  directFineTileInstanceCountForLaneLimitV1,
  directSubmissionInstanceCountForLaneLimitV1,
  planAnnotationPolicyDirectSubmissionV1,
  type AnnotationPolicyDirectFineTileBankV1,
  type AnnotationPolicyDirectCompiledFineTileBankV1,
  type AnnotationPolicyDirectCompiledSubmissionBankV1,
  type AnnotationPolicyDirectCompiledSubmissionModeBankV1,
  type AnnotationPolicyDirectSubmissionBankV1,
  type AnnotationPolicyDirectSubmissionModeBankV1,
  type AnnotationPolicyDirectSubmissionModeV1,
  type AnnotationPolicyDirectSubmissionPartitionV1,
  type AnnotationPolicyDirectSubmissionPlanV1,
} from './renderers/pixi/overview/annotation-policy-direct-submission-bank-v1';
export {
  ANNOTATION_POLICY_DIRECT_FINE_INDEX_V1,
  assertAnnotationPolicyDirectFineIndexV1,
  buildAnnotationPolicyDirectFineIndexV1,
  materializeAnnotationPolicyDirectFineTileV1,
  type AnnotationPolicyDirectFineIndexV1,
} from './renderers/pixi/overview/annotation-policy-direct-fine-index-v1';
export {
  PARTITIONED_TRANSCRIPT_SCENE_BINARY_V3,
  TRUSTED_MAIN_PARTITIONED_TRANSCRIPT_SCENE_VALIDATION_V3,
  packGpuReadyPartitionedTranscriptSceneBinaryV3,
  packPartitionedTranscriptSceneBinaryV3,
  unpackTrustedMainValidatedPartitionedTranscriptSceneBinaryV3,
  unpackPartitionedTranscriptSceneBinaryV3,
  validatePartitionedTranscriptSceneBinaryV3,
  type PackedGpuReadyPartitionedTranscriptSceneBinaryV3,
  type PackedPartitionedTranscriptSceneBinaryV3,
  type PackGpuReadyPartitionedTranscriptSceneBinaryV3Input,
  type PackPartitionedTranscriptSceneBinaryV3Input,
  type PartitionedTranscriptSceneBinaryManifestV3,
  type TrustedMainPartitionedTranscriptSceneDecodeWorkV3,
  type TrustedMainUnpackedPartitionedTranscriptSceneBinaryV3,
  type UnpackedPartitionedTranscriptSceneBinaryV3,
} from './renderers/pixi/overview/partitioned-transcript-scene-binary-v3';
export {
  PARTITIONED_TRANSCRIPT_SCENE_BINARY_V4,
  packGpuReadyPartitionedTranscriptSceneBinaryV4,
  resealPartitionedTranscriptSceneBinaryDatasetContractV4,
  unpackPartitionedTranscriptSceneBinaryV4,
  validatePartitionedTranscriptSceneBinaryV4,
  type AnnotationPolicyDirectFineIndicesV1,
  type PackedPartitionedTranscriptSceneBinaryV4,
  type PackGpuReadyPartitionedTranscriptSceneBinaryV4Input,
  type PartitionedTranscriptSceneBinarySha256V4,
  type PartitionedTranscriptSceneBinaryManifestV4,
  type UnpackedPartitionedTranscriptSceneBinaryV4,
} from './renderers/pixi/overview/partitioned-transcript-scene-binary-v4';
export {
  PARTITIONED_TRANSCRIPT_SCENE_RANGE_CATALOG_V1,
  assertPartitionedTranscriptSceneRangeCatalogV1,
  buildPartitionedTranscriptSceneRangeCatalogV1,
  resealPartitionedTranscriptSceneRangeCatalogV1,
  type AuthenticatedTranscriptSceneRangeV1,
  type PartitionedTranscriptSceneModePartitionRangeV1,
  type PartitionedTranscriptSceneModeRangeCatalogV1,
  type PartitionedTranscriptSceneRangeCatalogV1,
} from './renderers/pixi/overview/partitioned-transcript-scene-range-catalog-v1';
export {
  PARTITIONED_TRANSCRIPT_SCENE_DETAIL_PACKET_V1,
  bindPartitionedTranscriptSceneDetailInteractionV1,
  bindTrustedPartitionedTranscriptSceneDetailInteractionV1,
  packPartitionedTranscriptSceneDetailPacketV1,
  planPartitionedTranscriptSceneDetailPartitionsV1,
  isTrustedPartitionedTranscriptSceneDetailPacketAdmissionV1,
  isTrustedPartitionedTranscriptSceneDetailInteractionAdmissionV1,
  slicePartitionedTranscriptSceneDetailRolesV1,
  unpackPartitionedTranscriptSceneDetailPacketV1,
  type PackedPartitionedTranscriptSceneDetailPacketV1,
  type PartitionedTranscriptSceneDetailPacketManifestV1,
  type PartitionedTranscriptSceneRangeReaderV1,
  type TrustedPartitionedTranscriptSceneDetailPacketAdmissionBindingV1,
  type TrustedPartitionedTranscriptSceneDetailPacketAdmissionV1,
  type TrustedPartitionedTranscriptSceneDetailInteractionAdmissionV1,
  type TrustedPartitionedTranscriptSceneDetailInteractionBindingV1,
  type UnpackedPartitionedTranscriptSceneDetailPacketV1,
} from './renderers/pixi/overview/partitioned-transcript-scene-detail-packet-v1';
export {
  TRANSCRIPT_PAGE_LANE_STEP_PX,
  TranscriptPageBundleCompileError,
  compileResidentAnnotationPageBundle,
  compileTranscriptPageBundle,
  type CompiledTranscriptPageBundle,
  type CompileResidentAnnotationPageBundleInput,
  type CompileTranscriptPageBundleInput,
  type TranscriptPageBundleCompileErrorCode,
} from './renderers/pixi/overview/compile-transcript-page-bundle';
export {
  RESIDENT_ANNOTATION_PAGE_SEMANTIC_OWNER,
  ResidentAnnotationPageGpuBank,
  type CompileResidentAnnotationPageArtifactOptions,
  type ResidentAnnotationPageCpuArtifact,
  type ResidentAnnotationPageGpuBankDebugSnapshot,
  type ResidentAnnotationPageGpuBankOptions,
  type ResidentAnnotationPageGpuPageDebug,
  type ResidentAnnotationPageGpuPrepareRenderer,
  type ResidentAnnotationPageGpuPrepareResult,
  type ResidentAnnotationPageGpuTelemetryEvent,
  type ResidentAnnotationPageGpuVariant,
} from './renderers/pixi/overview/resident-annotation-page-gpu-bank';
export {
  PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
  PREPACKED_ANNOTATION_INTERACTION_TOKEN,
  PREPACKED_ANNOTATION_LANE_TOKEN,
  PREPACKED_ANNOTATION_MAPPER_TOKEN,
  PREPACKED_ANNOTATION_MIN_VISIBLE_BP,
  PREPACKED_ANNOTATION_PARTITION_SPAN_BP,
  PREPACKED_ANNOTATION_BAR_HEIGHT_PX,
  prepackedAnnotationSceneArtifactKey,
  PREPACKED_ANNOTATION_VIEWPORT_DETAIL_V1,
} from './renderers/pixi/overview/prepacked-annotation-scene';
export type {
  WebGLInstanceHandle,
  WebGLInstanceSnapshot,
  WebGLFatalFrameCircuitSnapshot,
  WebGLSnapshot,
  WebGLTraceDump,
  WebGLTraceEntry,
  WebGLTraceState,
  ActivePrepackedAnnotationSceneOwnerSnapshot,
} from './webgl-registry';

export { translateCDS, translateDnaCodon } from './biology/translation';
export { recomputeCds, type RecomputedCds } from './biology/recomputed-cds';
export { compareProjectedCodons } from './biology/codon-mutations';
export {
  projectCodonColumns,
  projectIntronColumns,
} from './renderers/pixi/shared/project-codon-columns';
export type { CodonInfo, IntronInfo, CodonMutationInfo } from './biology/translation';
export { findCutSites } from './biology/restriction-sites';
export type { CutSite } from './biology/restriction-sites';
export {
  PRIMER_COLOR,
  PRIMER_RENDER_ID_OFFSET,
  primerIndexFromRenderId,
  primerRenderIdAt,
} from './primer-render-conventions';
export { computeCodonEdges } from './biology/codon-edges';
export { getCodonFillColor, getAATextColor } from './biology/aa-colors';

export { getStadiumDimensions } from './geometry/stadium';
export {
  assignFeatureLanes,
  assignFeatureLanesByType,
  type AssignFeatureLanesByTypeOptions,
  type AssignFeatureLanesByTypeResult,
} from './geometry/lane-assignment';
export {
  AnnotationTrackLayoutInputError,
  computeAnnotationTrackLayoutPlan,
  type AnnotationTrackHitBand,
  type AnnotationTrackLayoutDescriptor,
  type AnnotationTrackLayoutEntry,
  type AnnotationTrackLayoutInputErrorCode,
  type AnnotationTrackLayoutPlan,
  type AnnotationTrackLayoutPlanInput,
} from './geometry/annotation-track-layout-plan';
export {
  ANNOTATION_CANONICAL_IDENTITY_V2,
  annotationCanonicalIdentityV2,
  type AnnotationCanonicalDirectionV2,
  type AnnotationCanonicalIdentityV2Input,
} from './geometry/annotation-canonical-identity-v2';
export { computeSegmentCount, shouldRenderSequence } from './geometry/lod';
export {
  materializeGenomeDataSourceRange,
  rendererGenomeToInMemoryManifest,
} from './data-source-adapter';
export type {
  MaterializeGenomeDataSourceRangeInput,
  MaterializedGenomeDataSourceRange,
} from './data-source-adapter';
export {
  DARK_RNA_FAMILY_COLORS,
  DEFAULT_FEATURE_COLOR,
  FEATURE_TYPE_COLORS,
  TRANSCRIPT_COLORS,
  annotationTypeAccentColor,
  annotationTypeBadgeStyle,
  featureTypeColor,
  isNonCodingTranscriptType,
  isTranscriptSourceType,
  rnaAccentColorForMode,
  rnaCanonicalSourceColor,
  rnaColorFamilyForType,
  transcriptColorForMode,
  type AnnotationTypeBadgeStyle,
  type RnaColorFamily,
  type TranscriptColorRole,
} from './feature-colors';

export { emptyTimings, totalMs, formatTimings } from './renderers/pixi/shared/timing';
export type { SubsystemTimings } from './renderers/pixi/shared/timing';
export type {
  FrameCameraContract,
  FrameContractDiagnostics,
  FrameEnvelope,
  FrameLayoutContract,
  FrameRenderMode,
  SemanticLodPhase,
} from './renderers/pixi/shared/frame-contract';
export {
  webglThemeColorToCss,
  webglThemeForMode,
  type WebGLRenderTheme,
  type WebGLThemeMode,
} from './renderers/pixi/shared/theme';
export {
  isAnnotationColorRoleKeyV1,
  resolveAnnotationRoleColorV1,
  type AnnotationColorRoleKeyV1,
  type AnnotationRolePaletteOverridesV1,
} from './annotation-role-palette';
export {
  DEFAULT_STADIUM_CAMERA_TUNING,
  type StadiumCameraTuning,
} from './renderers/pixi/shared/stadium-camera';

export type { LayoutModel } from './renderers/pixi/shared/layout-model';

export type {
  ComputeTracksLayoutOptions,
  Track,
  TrackContentHeightResolver,
  TrackDataShape,
  TrackDrawPolicy,
  TrackFamily,
  TrackInteractionSpec,
  TrackLayout,
  TrackLayoutEntry,
  TrackPresentationMetadata,
  TrackPresentationDrag,
  TrackSizingProfile,
  TrackSource,
  TrackType,
  TrackTypeDefinition,
  TrackTypeRegistry,
} from './tracks';
export {
  TrackLayoutInputError,
  computeTracksLayout,
  layoutMemoKey,
  CYTOBAND_BAND_HEIGHT_PX,
  CYTOBAND_LABEL_BOTTOM_GUTTER_PX,
  CYTOBAND_LABEL_FONT_SIZE_PX,
  CYTOBAND_LABEL_LINE_HEIGHT_PX,
  CYTOBAND_LABEL_TOP_GAP_PX,
  CYTOBAND_REQUIRED_TRACK_HEIGHT_PX,
  CYTOBAND_VERTICAL_CONTRACT_TOKEN,
  computeCytobandVerticalLayout,
  BUILTIN_TRACK_TYPES,
  BUILTIN_TRACK_TYPE_DEFINITIONS,
  CUT_SITE_TYPE,
  CYTOBAND_TYPE,
  GENERIC_INTERVAL_TYPE,
  IMPORTED_TRANSCRIPT_TYPE,
  ORF_TYPE,
  PEAK_TYPE,
  PILEUP_TYPE,
  PRIMER_TYPE,
  QUANTITATIVE_TYPE,
  REPEAT_TYPE,
  SEQUENCE_COMPOSITE_TYPE,
  VARIANT_TYPE,
  createTrackTypeRegistry,
  defaultBuiltinRegistry,
} from './tracks';
export type { CytobandVerticalLayout } from './tracks';

export type { Chromosome } from './chromosome';

export type { Assembly, AssemblyChromosomePlacement, AssemblyLocus } from './assembly';
export type { AssemblySegment } from './assembly-layout';
export {
  buildAssembly,
  globalBpToChrom,
  chromLocalBpToGlobal,
  placementForChrom,
  placementsInGlobalRange,
  globalRangeToSegments,
} from './assembly-layout';

export {
  TILE_PX,
  BASE_BIN_BP,
  LEVEL_FACTOR,
  binBp,
  CONTINUOUS_QUANTITATIVE_SAMPLES_PER_PIXEL,
  quantitativeSourceBasesPerSpan,
  type QuantitativeColumnSemantics,
  tileSpanBp,
  tileIndex,
  tileGlobalStart,
  tileGlobalEnd,
  maxLevelForLength,
  bpPerPx,
  baseLevelForBpPerPx,
  pickLevel,
  visibleTiles,
  maxLevelForAssembly,
  PREFETCH_MARGIN_TILES,
  type Viewport,
  type VisibleTile,
  tileKeyString,
  parseTileKey,
  levelInRange,
  type TileSource,
  type TileData,
  type TileKey,
  type TileFetchContext,
  TileCache,
  type TileEntry,
  type TileEntryState,
  TileCoordinator,
  type CoordinatorOptions,
  tileRoutePath,
  httpTileTransport,
  TileTransportDeadlineError,
  SIDECAR_SESSION_HEADER,
  type TileTransport,
  type TileRouteKind,
  type TileFetchPurpose,
  type TileTransportPriority,
  createAssemblyCoverageTileSource,
  createCoverageTileSource,
  createAlignmentTileSource,
  createAnnotationTileSource,
  maxBoundedForegroundCoverageLevel,
  maxFineLevel,
  maxAlternateGuideLevel,
  maxReadAlignmentLevel,
  FINE_BIN_BP_MAX,
  BOUNDED_FOREGROUND_COVERAGE_MAX_BP,
  READ_ALIGNMENT_BIN_BP_MAX,
  type AlignmentFileSource,
  type AnnotationFileSource,
} from './engine';

export {
  annotationSidecarRasterEligibility,
  type AnnotationSidecarRasterEligibility,
  type AnnotationSidecarRasterEligibilityInput,
  type AnnotationSidecarRasterEligibilityReason,
} from './renderers/pixi/overview/annotation-sidecar-raster-eligibility';
export {
  annotationSidecarRasterCameraUsesRaster,
  AnnotationSidecarRasterPresenter,
  type AnnotationSidecarRasterCamera,
  type AnnotationSidecarRasterChromosome,
  type AnnotationSidecarRasterExternalSources,
  type AnnotationSidecarRasterPresenterSources,
  type AnnotationSidecarRasterTile,
  type AnnotationSidecarRasterTileFetchRequest,
  type AnnotationSidecarRasterTileLane,
} from './renderers/pixi/overview/annotation-sidecar-raster-presenter';
export {
  createAnnotationSidecarRasterFetcher,
  type AnnotationSidecarRasterFetcherOptions,
} from './renderers/pixi/overview/annotation-sidecar-raster-fetch';

export type {
  BpRange,
  TrackMountArgs,
  TrackMeasureContentArgs,
  TrackPaintArgs,
  TrackHitArgs,
  TrackHoverArgs,
  TrackHitResult,
  PixiLinearTrackRenderer,
  TrackReadPresentationSnapshot,
} from './renderers/pixi/linear-tracks';

export { PixiCytobandTrackRenderer } from './renderers/pixi/linear-tracks';

export {
  PixiAnnotationTrackRenderer,
  PixiTranscriptTrackRenderer,
  PixiQuantitativeTrackRenderer,
  PixiVariantTrackRenderer,
  PixiSequenceReadTrackRenderer,
  SEQUENCE_READ_TRACK_TYPE,
  buildImportedTranscriptGlyphBlocks,
  buildQuantitativeTrackVertices,
  computeAnnotationDrawOps,
  type AnnotationDrawOp,
  type AnnotationTrackData,
  type BpToX,
  type ImportedTranscriptGlyphBuild,
  type PixiAnnotationTrackRendererOptions,
  type PixiTranscriptTrackRendererOptions,
  type PixiQuantitativeTrackRendererOptions,
  type QuantitativeRenderableRecord,
  type QuantitativeRenderMode,
  type QuantitativeTrackData,
  type QuantitativeTrackVertices,
  type PixiVariantTrackRendererOptions,
  type VariantTrackData,
  type VariantTrackDiagnostics,
  type SequenceReadTrackData,
  type TranscriptTrackData,
} from './renderers/pixi/linear-tracks';

export type { AnnotationRecord, VariantRecord } from './renderers/pixi/linear-tracks';

export {
  PixiPileupTrackRenderer,
  pileupExactReadPreparationEligible,
  pileupExactReadZoomAlpha,
} from './renderers/pixi/linear-tracks/pileup-track-renderer';
export { PENDING_INTERVAL_BAND_HEIGHT_PX } from './renderers/pixi/linear-tracks/pileup-pending-interval-layer';
export type {
  PixiPileupTrackRendererOptions,
  PileupTrackDiagnostics,
  PileupReadAggregateSource,
} from './renderers/pixi/linear-tracks/pileup-track-renderer';
export {
  PILEUP_READ_BODY_COLOR_BY_THEME,
  PILEUP_READ_QUALITY_MAX_SCORE,
  PILEUP_READ_QUALITY_STOPS,
  pileupReadQualityColorNumber,
  pileupReadQualityCss,
  pileupReadQualityGradientCss,
  pileupReadQualityRgb,
  type PileupReadQualityRgb,
  type PileupReadQualityTheme,
} from './renderers/pixi/linear-tracks/pileup-read-quality-palette';
export {
  PersistentRowLayout,
  pileupReadPlacementKey,
} from './renderers/pixi/linear-tracks/pileup-row-layout';
export type { PileupRowLayout } from './renderers/pixi/linear-tracks/pileup-row-layout';

export { decideTrackLod } from './renderers/pixi/lod/lod-policy';
export type { TrackLod, TrackLodOptions } from './renderers/pixi/lod/lod-policy';
export type { PileupRowAssignment } from './renderers/pixi/linear-tracks/pileup-row-layout';

export {
  ANNOTATION_CATALOG_TRACK_TYPE_PREFIX,
  annotationCatalogTrackType,
  createAnnotationCatalogTrackRenderers,
  type AnnotationCatalogCamera,
  type AnnotationCatalogGeneSpan,
  type AnnotationCatalogTrackData,
  type AnnotationCatalogTrackDiagnostics,
} from './renderers/pixi/linear-tracks/annotation-catalog';
export {
  TRANSCRIPTION_UNIT_GENE_PALETTE,
  catalogKindColor,
  type AnnotationCatalogRendererDiagnostics,
  type AnnotationCatalogRowLayout,
} from './renderers/pixi/linear-tracks/annotation-catalog';
