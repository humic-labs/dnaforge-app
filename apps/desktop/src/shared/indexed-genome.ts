import type {
  ReferenceContentIdentity,
  ReferenceVersionIdentity,
} from './reference-content-identity';
import type { VariantFileGeneration } from '@waypoint/api-client/models';
import type { Annotation } from '@waypoint/sequence-utils';
import type {
  AdmittedTrackSource,
  GenomeAssembly,
  PrepackedAnnotationSearchMatchV1,
  PrepackedProteinSearchMatchV1,
  ResolvedAnnotation,
} from '@waypoint/genome-data';
import type { AlignedReadSourceGenerationV1 } from './aligned-read-source-generation';
import {
  PREBUILT_ANNOTATION_RASTER_LANE_ARTIFACT_V1,
  PREBUILT_ANNOTATION_RASTER_LANE_PROJECTION_V1,
  PREBUILT_ANNOTATION_RASTER_PRESENTATION_V1,
  PREBUILT_ANNOTATION_RASTER_SOURCE_PLACEMENT_V1,
  PREBUILT_ANNOTATION_RASTERIZER_V1,
  PREPACKED_ANNOTATION_BAR_HEIGHT_PX,
  PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
  PREPACKED_ANNOTATION_INTERACTION_TOKEN,
  PREPACKED_ANNOTATION_LANE_TOKEN,
  PREPACKED_ANNOTATION_MAPPER_TOKEN,
  BROAD_SURFACE_LANE_ROW_CSS_HEIGHT_PX_V2,
  BROAD_SURFACE_LANE_SLAB_ROW_COUNT_V2,
  COMPILED_BROAD_SURFACE_MAX_FINITE_LANE_LIMIT_V2,
  BROAD_SURFACE_PREFETCH_RING_V2,
  BROAD_SURFACE_TILE_CONTENT_WIDTH_PX_V2,
  BROAD_SURFACE_X_FILTER_GUARD_PX_V2,
  buildCompiledBroadSurfaceManifestV2,
  prepackedAnnotationSceneArtifactKey,
  prebuiltAnnotationRasterPresentationArtifactKeyV1,
  type AnnotationSceneDatasetContractV1,
  type BroadSurfaceIsoformModeV2,
  type CompiledBroadAnnotationInteractionBinaryManifestV1,
  type CompiledBroadSurfaceManifestV2,
  type PartitionedTranscriptSceneBinaryManifestV4,
  type PartitionedTranscriptSceneDetailPacketManifestV1,
  type PartitionedTranscriptSceneRoleSidecarV1,
  type PrebuiltAnnotationRasterLaneProjectionV1,
  type PrebuiltAnnotationRasterPresentationIdentityV1,
  type PrebuiltAnnotationRasterPresentationReceiptV1,
} from '@waypoint/genome-renderer/pure';

export const INDEXED_GENOME_SOURCE_UNAVAILABLE_ERROR_CODE =
  'INDEXED_GENOME_SOURCE_UNAVAILABLE' as const;

export const INDEXED_GENOME_INVALID_SEQUENCE_ERROR_CODE =
  'INDEXED_GENOME_INVALID_SEQUENCE' as const;

export const ASSEMBLY_COMPILED_BROAD_RASTER_CONFIG_V2 =
  'assembly-compiled-broad-raster-config.v2:finite64' as const;
export const ASSEMBLY_COMPILED_BROAD_RASTER_FINEST_SPAN_BP_V1 = 16_000_000 as const;
export const ASSEMBLY_COMPILED_BROAD_RASTER_DEVICE_PIXEL_RATIO_V1 = 2 as const;
export const ASSEMBLY_COMPILED_BROAD_RASTER_CANONICAL_VIEWPORT_CSS_WIDTH_PX_V1 = 1_200 as const;
export const ASSEMBLY_COMPILED_BROAD_RASTER_CANONICAL_VIEWPORT_DEVICE_PIXEL_RATIO_V1 = 2 as const;
export const ASSEMBLY_COMPILED_BROAD_RASTER_ROW_TEXTURE_STRIDE_PX_V1 = 32 as const;
export const ASSEMBLY_COMPILED_BROAD_RASTER_ROW_TAIL_GUTTER_PX_V1 = 4 as const;
export const ASSEMBLY_COMPILED_BROAD_RASTER_MAX_MAGNIFICATION_X_V1 = 1.75 as const;

export function assemblyCompiledBroadRasterFinestSpanBpV1(genomeLengthBp: number): number {
  if (!Number.isSafeInteger(genomeLengthBp) || genomeLengthBp <= 0) {
    throw new Error('Assembly compiled broad raster requires a positive safe genome length.');
  }
  const canonicalViewportPhysicalWidthPx =
    ASSEMBLY_COMPILED_BROAD_RASTER_CANONICAL_VIEWPORT_CSS_WIDTH_PX_V1 *
    ASSEMBLY_COMPILED_BROAD_RASTER_CANONICAL_VIEWPORT_DEVICE_PIXEL_RATIO_V1;
  const canonicalWholeGenomeFinestSpanBp = Math.max(
    1,
    Number(
      (BigInt(genomeLengthBp) * BigInt(BROAD_SURFACE_TILE_CONTENT_WIDTH_PX_V2)) /
        BigInt(canonicalViewportPhysicalWidthPx)
    )
  );
  return Math.min(
    ASSEMBLY_COMPILED_BROAD_RASTER_FINEST_SPAN_BP_V1,
    canonicalWholeGenomeFinestSpanBp
  );
}

export interface IndexedGenomeManifest {
  chrom: string;
  fastaPath: string;
  faiPath: string;
  gziPath?: string | null;
  gffPath?: string | null;
  tbiPath?: string | null;
  length?: number;
  circular?: boolean;
  workspaceRootPaths?: string[];
}

export interface AssemblyOverviewChromInput {
  chrom: string;
  sourcePath?: string | null;
  manifest?: IndexedGenomeManifest | null;
  length: number;
}

export interface AssemblyOverviewChromResult {
  chrom: string;
  features: ResolvedAnnotation[];
  layerTypes: string[];
  cacheState: 'hit' | 'miss';
}

export interface AssemblyOverviewRequest {
  chromosomes: AssemblyOverviewChromInput[];
  workspaceRoot: string;
}

export interface AssemblyOverviewResult {
  byChrom: Record<string, AssemblyOverviewChromResult>;
  hits: number;
  misses: number;
}

export interface AssemblyOverviewTextureLayout {
  widthPx: number;
  heightPx: number;
  resolution: number;
  spineOffsetPx: number;
  genomeLength: number;
  maxAnnotationLane: number;
  maxCdsLane: number;
  layerTypes: string[];
}

export interface AssemblyOverviewTextureManifest extends AssemblyOverviewTextureLayout {
  version: number;
  assemblyId: string;
  fingerprint: string;
  cacheContractToken: string;
  sourceBuildFingerprint: string;
  placementSignature: string;
  textureFile: string;
}

export interface AssemblyTextureReadRequest {
  assemblyId: string;
  chromosomes: AssemblyOverviewChromInput[];
  workspaceRoot: string;
}

export interface AssemblyOverviewTextureReadResult {
  pngBase64: string;
  manifest: AssemblyOverviewTextureManifest;
}

export interface AssemblyTextureWriteRequest extends AssemblyTextureReadRequest {
  pngBase64: string;
  layout: AssemblyOverviewTextureLayout;
}

export interface AssemblyTextureWriteResult {
  fingerprint: string;
  pngPath: string;
  manifestPath: string;
}

export const ASSEMBLY_ANNOTATION_RASTER_MANIFEST_V2 = 2 as const;
export const ASSEMBLY_ANNOTATION_RASTER_VARIANT_V2 =
  'prepacked-annotation-raster-variant.v2' as const;
export const ASSEMBLY_ANNOTATION_RASTERIZER_TOKEN_V2 =
  'prepacked-annotation-rasterizer.track-local.v2' as const;
export const ASSEMBLY_ANNOTATION_RASTER_LANE_STEP_PX_V2 = 16 as const;
export const ASSEMBLY_ANNOTATION_RASTER_PROJECTION_ARTIFACT_V1 =
  'annotation-raster-lane-projection-artifact.v1' as const;
export const ASSEMBLY_ANNOTATION_RASTER_LANE_COMPLETE_SOURCE_V1 =
  'annotation-raster-lane-complete-source.v1' as const;

export interface AssemblyAnnotationRasterVariantV2 {
  readonly contract: typeof ASSEMBLY_ANNOTATION_RASTER_VARIANT_V2;
  readonly trackType: 'mRNA';
  readonly isoformMode: 'canonical' | 'expanded';
  readonly themeMode: 'light' | 'dark';
  readonly laneArtifactContract: typeof PREBUILT_ANNOTATION_RASTER_LANE_ARTIFACT_V1;
  readonly laneLimit: null;
  readonly annotationBarHeightPx: typeof PREPACKED_ANNOTATION_BAR_HEIGHT_PX;
  readonly laneStepPx: typeof ASSEMBLY_ANNOTATION_RASTER_LANE_STEP_PX_V2;
  readonly laneAlgorithmToken: typeof PREPACKED_ANNOTATION_LANE_TOKEN;
  readonly mapperContractToken: typeof PREPACKED_ANNOTATION_MAPPER_TOKEN;
  readonly geometryContractToken: typeof PREPACKED_ANNOTATION_GEOMETRY_TOKEN;
  readonly rasterizerContractToken: typeof ASSEMBLY_ANNOTATION_RASTERIZER_TOKEN_V2;
}

export function createAssemblyAnnotationRasterVariantV2(input: {
  isoformMode: AssemblyAnnotationRasterVariantV2['isoformMode'];
  themeMode: AssemblyAnnotationRasterVariantV2['themeMode'];
}): AssemblyAnnotationRasterVariantV2 {
  return {
    contract: ASSEMBLY_ANNOTATION_RASTER_VARIANT_V2,
    trackType: 'mRNA',
    isoformMode: input.isoformMode,
    themeMode: input.themeMode,
    laneArtifactContract: PREBUILT_ANNOTATION_RASTER_LANE_ARTIFACT_V1,
    laneLimit: null,
    annotationBarHeightPx: PREPACKED_ANNOTATION_BAR_HEIGHT_PX,
    laneStepPx: ASSEMBLY_ANNOTATION_RASTER_LANE_STEP_PX_V2,
    laneAlgorithmToken: PREPACKED_ANNOTATION_LANE_TOKEN,
    mapperContractToken: PREPACKED_ANNOTATION_MAPPER_TOKEN,
    geometryContractToken: PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
    rasterizerContractToken: ASSEMBLY_ANNOTATION_RASTERIZER_TOKEN_V2,
  };
}

export function isAssemblyAnnotationRasterVariantV2(
  value: unknown
): value is AssemblyAnnotationRasterVariantV2 {
  if (!isExactRecord(value, ASSEMBLY_ANNOTATION_RASTER_VARIANT_FIELDS_V2)) return false;
  return (
    value.contract === ASSEMBLY_ANNOTATION_RASTER_VARIANT_V2 &&
    value.trackType === 'mRNA' &&
    (value.isoformMode === 'canonical' || value.isoformMode === 'expanded') &&
    (value.themeMode === 'light' || value.themeMode === 'dark') &&
    value.laneArtifactContract === PREBUILT_ANNOTATION_RASTER_LANE_ARTIFACT_V1 &&
    value.laneLimit === null &&
    value.annotationBarHeightPx === PREPACKED_ANNOTATION_BAR_HEIGHT_PX &&
    value.laneStepPx === ASSEMBLY_ANNOTATION_RASTER_LANE_STEP_PX_V2 &&
    value.laneAlgorithmToken === PREPACKED_ANNOTATION_LANE_TOKEN &&
    value.mapperContractToken === PREPACKED_ANNOTATION_MAPPER_TOKEN &&
    value.geometryContractToken === PREPACKED_ANNOTATION_GEOMETRY_TOKEN &&
    value.rasterizerContractToken === ASSEMBLY_ANNOTATION_RASTERIZER_TOKEN_V2
  );
}

export function assemblyAnnotationRasterVariantKeyV2(value: unknown): string | null {
  if (!isAssemblyAnnotationRasterVariantV2(value)) return null;
  return framedContractKey([
    value.contract,
    value.trackType,
    value.isoformMode,
    value.themeMode,
    value.laneArtifactContract,
    value.laneAlgorithmToken,
    value.mapperContractToken,
    value.geometryContractToken,
    value.rasterizerContractToken,
    String(value.annotationBarHeightPx),
    String(value.laneStepPx),
  ]);
}

export interface AssemblyAnnotationRasterReadRequestV2 extends AssemblyTextureReadRequest {
  datasetContract: AnnotationSceneDatasetContractV1;
  genomeIdentity: string;
  trackType: 'mRNA';
  isoformMode: AssemblyAnnotationRasterVariantV2['isoformMode'];
  themeMode: AssemblyAnnotationRasterVariantV2['themeMode'];
  laneLimit: number | null;
}

export interface AssemblyAnnotationRasterManifestV2 extends AssemblyOverviewTextureLayout {
  version: typeof ASSEMBLY_ANNOTATION_RASTER_MANIFEST_V2;
  assemblyId: string;
  fingerprint: string;
  cacheContractToken: string;
  sourceBuildFingerprint: string;
  placementSignature: string;
  rasterVariantKey: string;
  rasterVariant: AssemblyAnnotationRasterVariantV2;
  textureFile: string;
  annotationTrackBaseOffsetPx: 0;
  sourceFingerprint: string;
  placementFingerprint: string;
  semanticReceipt: PrebuiltAnnotationRasterPresentationReceiptV1;
  laneProjection: PrebuiltAnnotationRasterLaneProjectionV1;
  projectionContract?: typeof ASSEMBLY_ANNOTATION_RASTER_PROJECTION_ARTIFACT_V1;
  projectionArtifactKey?: string;
  sourceArtifact?: AssemblyAnnotationRasterLaneCompleteSourceV1;
  textureSha256?: string;
  textureByteLength?: number;
}

export interface AssemblyAnnotationRasterLaneCompleteSourceV1 {
  contract: typeof ASSEMBLY_ANNOTATION_RASTER_LANE_COMPLETE_SOURCE_V1;
  manifestFile: string;
  manifestSha256: string;
  textureFile: string;
  textureSha256: string;
  textureByteLength: number;
  fingerprint: string;
  sourceBuildFingerprint: string;
  placementSignatureSha256: string;
  rasterVariantKey: string;
}

export interface AssemblyAnnotationRasterReadResultV2 {
  pngBase64: string;
  manifest: AssemblyAnnotationRasterManifestV2;
}

export function assemblyAnnotationRasterSemanticReceiptV1(input: {
  genomeIdentity: string;
  genomeLengthBp: number;
  sourceFingerprint: string;
  placementFingerprint: string;
  rasterVariant: AssemblyAnnotationRasterVariantV2;
  layerTypes: readonly string[];
  maxAnnotationLane: number;
  maxCdsLane: number;
}): PrebuiltAnnotationRasterPresentationReceiptV1 {
  const identity: PrebuiltAnnotationRasterPresentationIdentityV1 = {
    contract: PREBUILT_ANNOTATION_RASTER_PRESENTATION_V1,
    sourceValidationContract: PREBUILT_ANNOTATION_RASTER_SOURCE_PLACEMENT_V1,
    genomeIdentity: input.genomeIdentity,
    genomeLengthBp: input.genomeLengthBp,
    sourceFingerprint: input.sourceFingerprint,
    placementFingerprint: input.placementFingerprint,
    trackType: 'mRNA',
    isoformMode: input.rasterVariant.isoformMode,
    laneLimit: null,
    layerTypes: input.layerTypes,
    maxAnnotationLane: input.maxAnnotationLane,
    maxCdsLane: input.maxCdsLane,
    themeMode: input.rasterVariant.themeMode,
    laneArtifactContract: PREBUILT_ANNOTATION_RASTER_LANE_ARTIFACT_V1,
    annotationBarHeightPx: PREPACKED_ANNOTATION_BAR_HEIGHT_PX,
    laneStepPx: ASSEMBLY_ANNOTATION_RASTER_LANE_STEP_PX_V2,
    laneAlgorithmToken: PREPACKED_ANNOTATION_LANE_TOKEN,
    mapperContractToken: PREPACKED_ANNOTATION_MAPPER_TOKEN,
    geometryContractToken: PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
    rasterizerContractToken: PREBUILT_ANNOTATION_RASTERIZER_V1,
  };
  return {
    ...identity,
    artifactKey: prebuiltAnnotationRasterPresentationArtifactKeyV1(identity),
  };
}

export function assemblyAnnotationRasterLaneProjectionV1(input: {
  laneLimit: number | null;
  sourceHeightPx: number;
  sourceSpineOffsetPx: number;
  sourceMaxAnnotationLane: number;
}): PrebuiltAnnotationRasterLaneProjectionV1 {
  const presentedHeightPx =
    input.laneLimit === null
      ? input.sourceHeightPx
      : input.laneLimit * ASSEMBLY_ANNOTATION_RASTER_LANE_STEP_PX_V2;
  return {
    contract: PREBUILT_ANNOTATION_RASTER_LANE_PROJECTION_V1,
    laneLimit: input.laneLimit,
    sourceHeightPx: input.sourceHeightPx,
    sourceSpineOffsetPx: input.sourceSpineOffsetPx,
    sourceMaxAnnotationLane: input.sourceMaxAnnotationLane,
    presentedHeightPx,
    presentedSpineOffsetPx: presentedHeightPx - 1,
  };
}

const ASSEMBLY_ANNOTATION_RASTER_VARIANT_FIELDS_V2 = [
  'contract',
  'trackType',
  'isoformMode',
  'themeMode',
  'laneArtifactContract',
  'laneLimit',
  'annotationBarHeightPx',
  'laneStepPx',
  'laneAlgorithmToken',
  'mapperContractToken',
  'geometryContractToken',
  'rasterizerContractToken',
] as const;

function isExactRecord(
  value: unknown,
  fields: readonly string[]
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === fields.length &&
    fields.every((field) => Object.prototype.hasOwnProperty.call(value, field))
  );
}

function framedContractKey(parts: readonly string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join('');
}

export const ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT = 'assembly-annotation-scene-ipc.v4' as const;
export const ASSEMBLY_ANNOTATION_SCENE_RESOURCE_SCHEME = 'waypoint-annotation-scene' as const;
export const ASSEMBLY_ANNOTATION_SCENE_RESOURCE_HOST = 'artifact' as const;

export interface AssemblyAnnotationScenePlacementContract {
  chrom: string;
  length: number;
  annotationCoverage: 'sourced' | 'unsourced';
}

export interface AssemblyAnnotationSceneScopeContract {
  kind: 'complete-assembly' | 'viewport-subset';
  placements: AssemblyAnnotationScenePlacementContract[];
}

export function assemblyAnnotationSceneScopeMatchesChromosomes(
  scope: unknown,
  chromosomes: unknown
): scope is AssemblyAnnotationSceneScopeContract {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope) || !Array.isArray(chromosomes)) {
    return false;
  }
  const record = scope as Record<string, unknown>;
  if (
    (record.kind !== 'complete-assembly' && record.kind !== 'viewport-subset') ||
    !Array.isArray(record.placements) ||
    record.placements.length === 0 ||
    record.placements.length !== chromosomes.length
  ) {
    return false;
  }
  const chromosomeNames = new Set<string>();
  let totalLength = 0;
  for (let index = 0; index < chromosomes.length; index += 1) {
    const chromosomeValue = chromosomes[index];
    const placementValue = record.placements[index];
    if (
      !chromosomeValue ||
      typeof chromosomeValue !== 'object' ||
      Array.isArray(chromosomeValue) ||
      !placementValue ||
      typeof placementValue !== 'object' ||
      Array.isArray(placementValue)
    ) {
      return false;
    }
    const chromosome = chromosomeValue as Record<string, unknown>;
    const placement = placementValue as Record<string, unknown>;
    if (
      typeof chromosome.chrom !== 'string' ||
      chromosomeNames.has(chromosome.chrom) ||
      typeof chromosome.length !== 'number' ||
      !Number.isSafeInteger(chromosome.length) ||
      chromosome.length <= 0 ||
      placement.chrom !== chromosome.chrom ||
      placement.length !== chromosome.length ||
      (placement.annotationCoverage !== 'sourced' && placement.annotationCoverage !== 'unsourced')
    ) {
      return false;
    }
    const sourcePath = chromosome.sourcePath;
    const hasSource = typeof sourcePath === 'string' && sourcePath.trim().length > 0;
    if (
      (placement.annotationCoverage === 'sourced' && !hasSource) ||
      (placement.annotationCoverage === 'unsourced' && sourcePath != null)
    ) {
      return false;
    }
    chromosomeNames.add(chromosome.chrom);
    totalLength += chromosome.length;
    if (!Number.isSafeInteger(totalLength)) return false;
  }
  return true;
}

export function assemblyAnnotationSceneScopeForRequest(
  kind: AssemblyAnnotationSceneScopeContract['kind'],
  chromosomes: readonly AssemblyOverviewChromInput[]
): AssemblyAnnotationSceneScopeContract {
  return {
    kind,
    placements: chromosomes.map((chromosome) => ({
      chrom: chromosome.chrom,
      length: chromosome.length,
      annotationCoverage: chromosome.sourcePath == null ? 'unsourced' : 'sourced',
    })),
  };
}

export interface AssemblyAnnotationSceneSourceRequest extends AssemblyTextureReadRequest {
  scope: AssemblyAnnotationSceneScopeContract;
  datasetVersion?: string;
  expectedAssetGeneration?: AssemblyReferenceAssetGenerationV1;
}

export interface AssemblyAnnotationSceneReadRequest extends AssemblyAnnotationSceneSourceRequest {
  ipcContractVersion: typeof ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT;
  datasetContract: AnnotationSceneDatasetContractV1;
  artifact: AssemblyAnnotationSceneArtifactContract;
  requestedPolicy: AssemblyAnnotationRuntimePolicy;
}

export interface AssemblyAnnotationRuntimePolicy {
  isoformMode: 'canonical' | 'expanded';
  laneLimit: number | null;
}

export interface AssemblyAnnotationSceneArtifactContract {
  artifactKey: string;
  themeMode: 'light' | 'dark';
  trackType: string;
  partitionSpanBp: number;
  annotationBarHeightPx: number;
  laneAlgorithmToken: typeof PREPACKED_ANNOTATION_LANE_TOKEN;
  mapperContractToken: typeof PREPACKED_ANNOTATION_MAPPER_TOKEN;
  geometryContractToken: typeof PREPACKED_ANNOTATION_GEOMETRY_TOKEN;
  interactionContractToken: typeof PREPACKED_ANNOTATION_INTERACTION_TOKEN;
}

export async function buildAssemblyCompiledBroadRasterSurfaceManifestV1(input: {
  readonly sceneManifest: PartitionedTranscriptSceneBinaryManifestV4;
  readonly artifact: AssemblyAnnotationSceneArtifactContract;
}) {
  const { sceneManifest, artifact } = input;
  if (
    !sceneManifest?.assemblyContract ||
    !sceneManifest.directContract ||
    !artifact?.artifactKey ||
    !artifact.trackType?.trim()
  ) {
    throw new Error('assembly broad raster requires an exact track-local V4 scene');
  }
  const canonicalSourceLaneRows = sceneManifest.directContract.canonical.maxTrackLane + 1;
  const expandedSourceLaneRows = sceneManifest.directContract.expanded.maxTrackLane + 1;
  if (canonicalSourceLaneRows <= 0 || expandedSourceLaneRows <= 0) {
    throw new Error('assembly broad raster scene has no presentable lane bank');
  }
  const canonicalLaneRows = Math.min(
    canonicalSourceLaneRows,
    COMPILED_BROAD_SURFACE_MAX_FINITE_LANE_LIMIT_V2
  );
  const expandedLaneRows = Math.min(
    expandedSourceLaneRows,
    COMPILED_BROAD_SURFACE_MAX_FINITE_LANE_LIMIT_V2
  );
  return buildCompiledBroadSurfaceManifestV2({
    artifactKey: [
      ASSEMBLY_COMPILED_BROAD_RASTER_CONFIG_V2,
      artifact.artifactKey,
      sceneManifest.datasetContract.datasetId,
      sceneManifest.datasetContract.datasetVersion,
      sceneManifest.datasetContract.sourceSha256,
      sceneManifest.assemblyContract.assemblyId,
      sceneManifest.integrity.contractSha256,
      sceneManifest.integrity.payloadSha256,
    ].join(':'),
    trackId: artifact.trackType,
    genomeLengthBp: sceneManifest.assemblyContract.assemblyLengthBp,
    broadCorridorFinestSpanBp: assemblyCompiledBroadRasterFinestSpanBpV1(
      sceneManifest.assemblyContract.assemblyLengthBp
    ),
    broadTilePhysicalWidthPx: BROAD_SURFACE_TILE_CONTENT_WIDTH_PX_V2,
    broadTileXGuardPhysicalPx: BROAD_SURFACE_X_FILTER_GUARD_PX_V2,
    prefetchRing: BROAD_SURFACE_PREFETCH_RING_V2,
    maxQualifiedRasterMagnificationX: ASSEMBLY_COMPILED_BROAD_RASTER_MAX_MAGNIFICATION_X_V1,
    rasterDevicePixelRatio: ASSEMBLY_COMPILED_BROAD_RASTER_DEVICE_PIXEL_RATIO_V1,
    laneSlabRowCount: BROAD_SURFACE_LANE_SLAB_ROW_COUNT_V2,
    laneRowCssHeightPx: BROAD_SURFACE_LANE_ROW_CSS_HEIGHT_PX_V2,
    laneRowTextureStridePx: ASSEMBLY_COMPILED_BROAD_RASTER_ROW_TEXTURE_STRIDE_PX_V1,
    laneRowTransparentTailGutterPx: ASSEMBLY_COMPILED_BROAD_RASTER_ROW_TAIL_GUTTER_PX_V1,
    laneRowCounts: {
      canonical: canonicalLaneRows,
      expanded: expandedLaneRows,
    },
  });
}

export function assemblyAnnotationSceneArtifactKey(
  artifact: Omit<AssemblyAnnotationSceneArtifactContract, 'artifactKey'>
): string {
  return prepackedAnnotationSceneArtifactKey({
    themeMode: artifact.themeMode,
    trackType: artifact.trackType,
  });
}

export const ASSEMBLY_ANNOTATION_SEARCH_TRACK_TYPE = '__assembly__' as const;

export interface AssemblyAnnotationSceneCacheRevision {
  ipcContractVersion: typeof ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT;
  fingerprint: string;
  sourceBuildFingerprint: string;
}

export interface AssemblyAnnotationSceneMissResult extends AssemblyAnnotationSceneCacheRevision {
  status: 'miss';
}

export interface AssemblyAnnotationSceneHitResult extends AssemblyAnnotationSceneCacheRevision {
  status: 'hit';
  scope: AssemblyAnnotationSceneScopeContract;
  artifact: AssemblyAnnotationSceneArtifactContract;
  byteCount: number;
  manifest: PartitionedTranscriptSceneBinaryManifestV4;
  payload: Uint8Array;
  colorRoles?: PartitionedTranscriptSceneRoleSidecarV1;
}

export interface AssemblyAnnotationSceneColorRolesWireV1 {
  roleTable: PartitionedTranscriptSceneRoleSidecarV1['roleTable'];
  expandedCount: number;
  canonicalCount: number;
  resource: AssemblyAnnotationSceneResourceCapability;
}

export interface AssemblyAnnotationSceneResourceCapability {
  url: string;
  expiresAtMs: number;
  byteCount: number;
  payloadSha256: string;
}

export interface AssemblyAnnotationSceneWireHitResult extends AssemblyAnnotationSceneCacheRevision {
  status: 'hit';
  scope: AssemblyAnnotationSceneScopeContract;
  artifact: AssemblyAnnotationSceneArtifactContract;
  byteCount: number;
  manifest: PartitionedTranscriptSceneBinaryManifestV4;
  resource: AssemblyAnnotationSceneResourceCapability;
  colorRoles?: AssemblyAnnotationSceneColorRolesWireV1;
}

export type AssemblyAnnotationSceneWireReadResult =
  | AssemblyAnnotationSceneMissResult
  | AssemblyAnnotationSceneWireHitResult;

export const ASSEMBLY_ANNOTATION_SCENE_DETAIL_IPC_V1 =
  'assembly-annotation-scene-detail-ipc.v1' as const;

export interface AssemblyAnnotationSceneDetailReadRequestV1 {
  contract: typeof ASSEMBLY_ANNOTATION_SCENE_DETAIL_IPC_V1;
  source: AssemblyAnnotationSceneReadRequest;
  startBp: number;
  endBp: number;
}

export interface AssemblyAnnotationSceneDetailHitResultV1 {
  contract: typeof ASSEMBLY_ANNOTATION_SCENE_DETAIL_IPC_V1;
  status: 'hit';
  fingerprint: string;
  sourceBuildFingerprint: string;
  scope: AssemblyAnnotationSceneScopeContract;
  artifact: AssemblyAnnotationSceneArtifactContract;
  byteCount: number;
  manifest: PartitionedTranscriptSceneDetailPacketManifestV1;
  payload: Uint8Array;
  colorRoles?: PartitionedTranscriptSceneRoleSidecarV1;
}

export interface AssemblyAnnotationSceneDetailUnavailableResultV1 {
  contract: typeof ASSEMBLY_ANNOTATION_SCENE_DETAIL_IPC_V1;
  status: 'unavailable';
  reason: 'range-catalog-unavailable';
  fingerprint: string;
  sourceBuildFingerprint: string;
  scope: AssemblyAnnotationSceneScopeContract;
  artifact: AssemblyAnnotationSceneArtifactContract;
}

export type AssemblyAnnotationSceneDetailReadResultV1 =
  | AssemblyAnnotationSceneDetailHitResultV1
  | AssemblyAnnotationSceneDetailUnavailableResultV1;

export interface AssemblyAnnotationSceneDetailWireHitResultV1 extends Omit<
  AssemblyAnnotationSceneDetailHitResultV1,
  'payload'
> {
  resource: AssemblyAnnotationSceneResourceCapability;
}

export type AssemblyAnnotationSceneDetailWireReadResultV1 =
  | AssemblyAnnotationSceneDetailWireHitResultV1
  | AssemblyAnnotationSceneDetailUnavailableResultV1;

export const ASSEMBLY_COMPILED_BROAD_INTERACTION_IPC_V1 =
  'assembly-compiled-broad-interaction-ipc.v1' as const;

export interface AssemblyCompiledBroadInteractionSourceSceneV1 {
  byteCount: number;
  payloadSha256: string;
  contractSha256: string;
}

export interface AssemblyCompiledBroadInteractionHitResultV1 {
  contract: typeof ASSEMBLY_COMPILED_BROAD_INTERACTION_IPC_V1;
  status: 'hit';
  authorityKind: 'portable' | 'local';
  origin: 'durable-hit' | 'prepared-after-miss';
  fingerprint: string;
  sourceBuildFingerprint: string;
  scope: AssemblyAnnotationSceneScopeContract;
  artifact: AssemblyAnnotationSceneArtifactContract;
  sourceScene: AssemblyCompiledBroadInteractionSourceSceneV1;
  byteCount: number;
  manifest: CompiledBroadAnnotationInteractionBinaryManifestV1;
  payload: Uint8Array;
}

export interface AssemblyCompiledBroadInteractionWireHitResultV1 extends Omit<
  AssemblyCompiledBroadInteractionHitResultV1,
  'payload'
> {
  resource: AssemblyAnnotationSceneResourceCapability;
}

export interface AssemblyAnnotationSearchMissResult {
  status: 'miss';
  fingerprint: string;
}

export interface GenomeSearchRequestIdentityV1 {
  clientId: string;
  requestId: string;
}

export const ASSEMBLY_SEQUENCE_SEARCH_SOURCE_V1 = 'assembly-sequence-search-source.v1' as const;

export interface AssemblySequenceSearchChromosomeV1 {
  chrom: string;
  length: number;
  manifest: IndexedGenomeManifest;
}

export interface AssemblySequenceSearchSourceV1 {
  contract: typeof ASSEMBLY_SEQUENCE_SEARCH_SOURCE_V1;
  assemblyId: string;
  chromosomes: ReadonlyArray<AssemblySequenceSearchChromosomeV1>;
}

export interface AssemblySequenceSearchRequestV1 extends GenomeSearchRequestIdentityV1 {
  source: AssemblySequenceSearchSourceV1;
  motif: string;
  limit: number;
  reverseComplement: boolean;
  caseSensitive?: boolean;
}

export interface AssemblySequenceSearchHitV1 {
  chrom: string;
  localStartBp: number;
  localEndBp: number;
  globalStartBp: number;
  globalEndBp: number;
  strand: 'forward' | 'reverse';
  motif: string;
}

export interface AssemblySequenceSearchResultV1 {
  hits: AssemblySequenceSearchHitV1[];
  truncated: boolean;
}

export interface AssemblyAnnotationSearchQueryRequestV1 extends GenomeSearchRequestIdentityV1 {
  source: AssemblyAnnotationSceneReadRequest;
  query: string;
  limit: number;
}

export interface AssemblyAnnotationSearchCancelRequestV1 extends GenomeSearchRequestIdentityV1 {}

export interface AssemblyAnnotationSearchQueryHitResultV1 {
  status: 'hit';
  fingerprint: string;
  featureCount: number;
  matches: PrepackedAnnotationSearchMatchV1[];
  truncated: boolean;
}

export type AssemblyAnnotationSearchQueryResultV1 =
  | AssemblyAnnotationSearchMissResult
  | AssemblyAnnotationSearchQueryHitResultV1;

export type AssemblyAnnotationSearchPrepareResult =
  | { status: 'ready'; fingerprint: string }
  | { status: 'unavailable'; reason: 'source-unavailable' | 'stale' }
  | { status: 'failed'; reason: 'invalid-request' | 'compile-failed' | 'timeout'; message: string };

export interface AssemblyProteinSearchMissResult {
  status: 'miss';
  fingerprint: string;
}

export interface AssemblyProteinSearchQueryRequestV1 extends GenomeSearchRequestIdentityV1 {
  source: AssemblyAnnotationSceneReadRequest;
  query: string;
  limit: number;
}

export interface AssemblyProteinSearchCancelRequestV1 extends GenomeSearchRequestIdentityV1 {}

export interface AssemblyProteinSearchQueryHitResultV1 {
  status: 'hit';
  fingerprint: string;
  featureCount: number;
  matches: PrepackedProteinSearchMatchV1[];
  truncated: boolean;
  limit: number;
}

export type AssemblyProteinSearchQueryResultV1 =
  | AssemblyProteinSearchMissResult
  | AssemblyProteinSearchQueryHitResultV1;

export type AssemblyProteinSearchPrepareResult =
  | { status: 'ready'; fingerprint: string }
  | { status: 'unavailable'; reason: 'source-unavailable' | 'stale' }
  | { status: 'failed'; reason: 'invalid-request' | 'compile-failed' | 'timeout'; message: string };

export type AssemblyAnnotationSceneReadResult =
  | AssemblyAnnotationSceneMissResult
  | AssemblyAnnotationSceneHitResult;

export type AssemblyAnnotationScenePrepareResult =
  | (AssemblyAnnotationSceneCacheRevision & { status: 'ready' })
  | (AssemblyAnnotationSceneCacheRevision & {
      status: 'unavailable';
      reason: 'source-unavailable' | 'stale';
    })
  | {
      status: 'failed';
      reason: 'invalid-request' | 'compile-failed' | 'timeout';
      message: string;
    };

export type AssemblyAnnotationProductIndexResultV1 =
  | Readonly<{
      status: 'ready';
      artifactStatus: 'already-present' | 'published';
      sourceFingerprint: string;
      surfaceManifestFingerprint: string;
      catalogFingerprint: string;
    }>
  | Readonly<{
      status: 'rejected';
      reason: 'invalid-request' | 'queue-full' | 'preparation-failed';
      message?: string;
    }>;

export interface AssemblyAnnotationProductSetIndexRequestV1 {
  readonly products: readonly AssemblyAnnotationSceneReadRequest[];
}

export type AssemblyAnnotationProductSetIndexResultV1 =
  | Readonly<{
      status: 'ready';
      inventoryFingerprint: string;
      trackTypes: readonly string[];
    }>
  | Readonly<{
      status: 'rejected';
      reason: 'invalid-request' | 'queue-full' | 'preparation-failed';
      message?: string;
    }>;

export interface AssemblyAnnotationProductSetInventoryReadRequestV1 {
  readonly seedProduct: AssemblyAnnotationSceneReadRequest;
}

export type AssemblyAnnotationProductSetInventoryReadResultV1 =
  | Readonly<{
      status: 'ready';
      sourceFingerprint: string;
      inventoryFingerprint: string;
      trackTypes: readonly string[];
    }>
  | Readonly<{
      status: 'source-inventory';
      sourceFingerprint: string;
      trackTypes: readonly string[];
    }>
  | Readonly<{ status: 'unavailable' }>;

export const ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1 =
  'assembly-compiled-broad-raster-wire.v1' as const;
export const ASSEMBLY_COMPILED_BROAD_RASTER_CATALOG_RECEIPT_V1 =
  'assembly-compiled-broad-raster-catalog-receipt.v1' as const;
export const ASSEMBLY_COMPILED_BROAD_RASTER_CATALOG_CAPABILITY_V1 =
  'assembly-compiled-broad-raster-catalog-capability.v1' as const;
export const ASSEMBLY_COMPILED_BROAD_RASTER_MAX_CELLS_PER_IPC_RESPONSE_V1 = 1 as const;
export const COMPILED_BROAD_RASTER_ARTIFACT_WIRE_V1 = 'compiled-broad-raster-artifact.v1' as const;
export const COMPILED_BROAD_RASTER_PIXEL_FORMAT_WIRE_V1 = 'rgba8-premultiplied-srgb.v1' as const;
export const COMPILED_BROAD_RASTER_PIXEL_FORMAT_ROLE_WEIGHTS_WIRE_V1 =
  'rgba8-role-weights.v1' as const;
export const COMPILED_BROAD_RASTER_OCCUPANCY_RGBA8_WIRE_V1 = 'rgba8' as const;
export const COMPILED_BROAD_RASTER_OCCUPANCY_TRANSPARENT_WIRE_V1 = 'transparent' as const;

export interface AssemblyCompiledBroadRasterManifestRequestV1 {
  readonly contract: typeof ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1;
  readonly scene: AssemblyAnnotationSceneReadRequest;
}

export interface AssemblyCompiledBroadRasterArtifactRequestV1 extends AssemblyCompiledBroadRasterManifestRequestV1 {
  readonly contract: typeof ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1;
  readonly surfaceManifestFingerprint: string;
}

export interface AssemblyCompiledBroadRasterCatalogCapabilityV1 {
  readonly contract: typeof ASSEMBLY_COMPILED_BROAD_RASTER_CATALOG_CAPABILITY_V1;
  readonly openingId: string;
  readonly catalogReceiptSha256: string;
  readonly catalogFingerprint: string;
  readonly surfaceManifestFingerprint: string;
}

export interface AssemblyCompiledBroadRasterCatalogReceiptV1 {
  readonly contract: typeof ASSEMBLY_COMPILED_BROAD_RASTER_CATALOG_RECEIPT_V1;
  readonly receiptSha256: string;
  readonly genomeIdentity: string;
  readonly genomeLengthBp: number;
  readonly sourceFingerprint: string;
  readonly placementFingerprint: string;
  readonly scenePayloadSha256: string;
  readonly sceneContractSha256: string;
  readonly sceneSourceBuildFingerprint: string;
  readonly surfaceManifestFingerprint: string;
  readonly catalogFingerprint: string;
  readonly sceneArtifactKey: string;
  readonly surfaceArtifactKey: string;
  readonly themeMode: AssemblyAnnotationSceneArtifactContract['themeMode'];
  readonly trackId: string;
  readonly expectedInteractionOwnerKey: string;
  readonly pixelFormat:
    | typeof COMPILED_BROAD_RASTER_PIXEL_FORMAT_WIRE_V1
    | typeof COMPILED_BROAD_RASTER_PIXEL_FORMAT_ROLE_WEIGHTS_WIRE_V1;
  readonly roleTable?: readonly PartitionedTranscriptSceneRoleSidecarV1['roleTable'][number][];
  readonly bytesPerPixel: 4;
  readonly storedCellWidthPx: number;
  readonly storedCellHeightPx: number;
  readonly cellCount: number;
  readonly rasterDevicePixelRatio: number;
  readonly tileContentWidthPx: number;
  readonly tileGuardWidthPx: number;
  readonly laneSlabRowCount: number;
  readonly laneRowTextureStridePx: number;
}

export function assemblyAnnotationSceneGenomeIdentityV1(
  request: Pick<AssemblyAnnotationSceneReadRequest, 'datasetContract'>
): string | null {
  const sourceSha256 = request?.datasetContract?.sourceSha256;
  return typeof sourceSha256 === 'string' && /^[0-9a-f]{64}$/.test(sourceSha256)
    ? `assembly-annotation-source-sha256.v1:${sourceSha256}`
    : null;
}

export function assemblyAnnotationSceneInteractionOwnerKeyV3(input: {
  readonly sourceFingerprint: string;
  readonly scenePayloadSha256: string;
  readonly sceneArtifactKey: string;
}): string | null {
  if (
    !/^[0-9a-f]{24}$/.test(input.sourceFingerprint) ||
    !/^[0-9a-f]{64}$/.test(input.scenePayloadSha256) ||
    typeof input.sceneArtifactKey !== 'string' ||
    input.sceneArtifactKey.length === 0 ||
    /[\r\n]/.test(input.sceneArtifactKey)
  ) {
    return null;
  }
  return [
    'annotation-scene-owner.v3',
    input.sourceFingerprint,
    input.scenePayloadSha256,
    input.sceneArtifactKey,
  ].join('\n');
}

export interface CompiledBroadRasterCellAddressWireV1 {
  readonly isoformMode: BroadSurfaceIsoformModeV2;
  readonly level: number;
  readonly tileX: number;
  readonly laneSlabIndex: number;
}

export function isAssemblyCompiledBroadRasterSingleCellBatchV1(
  addresses: unknown
): addresses is readonly [CompiledBroadRasterCellAddressWireV1] {
  return (
    Array.isArray(addresses) &&
    addresses.length === ASSEMBLY_COMPILED_BROAD_RASTER_MAX_CELLS_PER_IPC_RESPONSE_V1
  );
}

interface CompiledBroadRasterCellRecordWireBaseV1 extends CompiledBroadRasterCellAddressWireV1 {
  readonly cellId: string;
  readonly trackId: string;
  readonly laneSlabId: string;
  readonly widthPx: number;
  readonly heightPx: number;
}

export interface CompiledBroadRasterRgbaCellRecordWireV1 extends CompiledBroadRasterCellRecordWireBaseV1 {
  readonly occupancy: typeof COMPILED_BROAD_RASTER_OCCUPANCY_RGBA8_WIRE_V1;
  readonly decodedByteLength: number;
  readonly decodedSha256: string;
}

export interface CompiledBroadRasterTransparentCellRecordWireV1 extends CompiledBroadRasterCellRecordWireBaseV1 {
  readonly occupancy: typeof COMPILED_BROAD_RASTER_OCCUPANCY_TRANSPARENT_WIRE_V1;
  readonly decodedByteLength: 0;
  readonly decodedSha256: null;
}

export type CompiledBroadRasterCellRecordWireV1 =
  | CompiledBroadRasterRgbaCellRecordWireV1
  | CompiledBroadRasterTransparentCellRecordWireV1;

export interface AssemblyCompiledBroadRasterManifestResultV1 {
  readonly contract: typeof COMPILED_BROAD_RASTER_ARTIFACT_WIRE_V1;
  readonly catalogReceipt: AssemblyCompiledBroadRasterCatalogReceiptV1;
  readonly catalogCapability: AssemblyCompiledBroadRasterCatalogCapabilityV1;
  readonly surfaceManifest: CompiledBroadSurfaceManifestV2;
}

export interface AssemblyCompiledBroadRasterCellsRequestV1 {
  readonly contract: typeof ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1;
  readonly catalogCapability: AssemblyCompiledBroadRasterCatalogCapabilityV1;
  readonly addresses: readonly CompiledBroadRasterCellAddressWireV1[];
}

export type CompiledBroadRasterCellPayloadWireV1 =
  | {
      readonly record: CompiledBroadRasterRgbaCellRecordWireV1;
      readonly premultipliedRgba: Uint8Array;
    }
  | {
      readonly record: CompiledBroadRasterTransparentCellRecordWireV1;
      readonly premultipliedRgba: null;
    };

export interface AssemblyCompiledBroadRasterCellsReadyResultV1 {
  readonly contract: typeof ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1;
  readonly status: 'ready';
  readonly catalogCapability: AssemblyCompiledBroadRasterCatalogCapabilityV1;
  readonly cells: readonly CompiledBroadRasterCellPayloadWireV1[];
}

export interface AssemblyCompiledBroadRasterCellsRepairingResultV1 {
  readonly contract: typeof ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1;
  readonly status: 'repairing';
  readonly reason: 'artifact-missing' | 'artifact-corrupt';
  readonly catalogCapability: AssemblyCompiledBroadRasterCatalogCapabilityV1;
  readonly retryAfterMs: number;
}

export interface AssemblyCompiledBroadRasterCellsUnavailableResultV1 {
  readonly contract: typeof ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1;
  readonly status: 'unavailable';
  readonly reason:
    | 'invalid-request'
    | 'catalog-stale'
    | 'artifact-io-failure'
    | 'repair-not-known'
    | 'repair-exhausted';
}

export type AssemblyCompiledBroadRasterCellsResultV1 =
  | AssemblyCompiledBroadRasterCellsReadyResultV1
  | AssemblyCompiledBroadRasterCellsRepairingResultV1
  | AssemblyCompiledBroadRasterCellsUnavailableResultV1;

export interface AssemblyAnnotationSceneWriteRequest extends AssemblyAnnotationSceneReadRequest {
  expectedSourceFingerprint: string;
  expectedSourceBuildFingerprint: string;
  manifest: PartitionedTranscriptSceneBinaryManifestV4;
  payload: Uint8Array | ArrayBuffer;
  compiledBroadInteraction?: {
    manifest: CompiledBroadAnnotationInteractionBinaryManifestV1;
    payload: Uint8Array | ArrayBuffer;
  };
  roleSidecar?: PartitionedTranscriptSceneRoleSidecarV1;
}

export interface AssemblyAnnotationSceneWriteResult {
  fingerprint: string;
  byteCount: number;
  scenePath: string;
  manifestPath: string;
}

export interface AssemblyFeaturesReadRequest extends AssemblyTextureReadRequest {
  mode: string;
}

export interface AssemblyOverviewFeaturesManifest {
  version: number;
  assemblyId: string;
  fingerprint: string;
  cacheContractToken: string;
  mode: string;
  featureCount: number;
}

export interface AssemblyOverviewFeaturesReadResult {
  byChrom?: Record<string, readonly unknown[]>;
  rawFileJson?: string;
  manifest: AssemblyOverviewFeaturesManifest;
}

export interface AssemblyFeaturesWriteRequest extends AssemblyFeaturesReadRequest {
  byChrom: Record<string, unknown[]>;
}

export interface AssemblyFeaturesWriteResult {
  fingerprint: string;
  path: string;
  featureCount: number;
}

export type IndexedGenomeScope =
  | { kind: 'all' }
  | { kind: 'chromosome'; chrom: string }
  | { kind: 'locus'; chrom: string; start: number; end: number };

export type IndexedGenomeViewRestoreViewport =
  | Readonly<{ kind: 'all' }>
  | Readonly<{ kind: 'chromosome'; chrom: string }>
  | Readonly<{ kind: 'locus'; chrom: string; start0: number; end0: number }>
  | Readonly<{ kind: 'assembly-range'; start0: number; end0: number }>;

export interface IndexedGenomeViewRestoreCommand {
  id: string;
  viewport: IndexedGenomeViewRestoreViewport;
  annotationPolicy: {
    isoformMode: 'canonical' | 'expanded';
    laneLimit: number | null;
  };
  visibleAnnotationTrackIds: string[];
  orderedAnnotationTrackIds: string[];
}

export interface GenomeFeature {
  chrom: string;
  source: string;
  type: string;
  start: number;
  end: number;
  score: string | null;
  strand: '+' | '-' | '.';
  phase: string | null;
  attributes: Record<string, string[]>;
  raw: string;
  fileOffset?: number;
}

export interface GenomeFeatureDetailsRequest {
  chrom: string;
  start: number;
  end: number;
  featureId?: string;
  maxWindowBp?: number;
}

export interface GenomeFeatureDetails {
  chrom: string;
  featureId?: string;
  feature: GenomeFeature | null;
  relatedFeatures: GenomeFeature[];
  sourceRecordCount: number;
  window: {
    start: number;
    end: number;
  };
  truncated: boolean;
}

export interface GenomeSearchHit {
  chrom: string;
  start: number;
  end: number;
  strand: 'forward' | 'reverse';
  motif: string;
}

export interface GenomeSearchOptions {
  start?: number;
  end?: number;
  chunkSize?: number;
  maxResults?: number;
  reverseComplement?: boolean;
  caseSensitive?: boolean;
  validateIupacDna?: boolean;
}

export interface IndexedGenomeMetadata {
  length: number;
  circular: boolean;
  featureCount?: number;
  annotationTypes?: string[];
  annotationRasterReady?: boolean;
}

export interface IndexedGenomeInitialAnnotationMapperPolicy {
  isoformMode: 'canonical' | 'expanded';
  laneLimit: number | null;
}

export const DEFAULT_INDEXED_ANNOTATION_MAPPER_POLICY = Object.freeze({
  isoformMode: 'canonical',
  laneLimit: 2,
}) satisfies Readonly<IndexedGenomeInitialAnnotationMapperPolicy>;

export interface IndexedGenomeBamTrackState {
  trackId: string;
  label: string;
  order?: number;
  source: {
    bamPath: string;
    indexPath: string;
    referencePath?: string;
    generation?: AlignedReadSourceGenerationV1;
    remote?: import('./remote-genomics-ipc').RemoteAlignmentLocatorV1;
  };
  admittedSource?: AdmittedTrackSource;
  visible: boolean;
  color?: number;
  trackPx?: number;
  laneHeightPx?: number;
  maxLanes?: number;
  coverageCutoffDepth: number;
}

export const SIGNAL_READ_PILEUP_VIEW_V1 = 'dnaforge.signal-read-pileup-view.v1' as const;

export interface IndexedGenomeSignalReadPileupViewState {
  readonly contract: typeof SIGNAL_READ_PILEUP_VIEW_V1;
  readonly trackId: string;
  readonly readsTrackId: string;
  readonly signalTrackId: string;
  readonly label: string;
  readonly order?: number;
  readonly visible: boolean;
  readonly color: number;
  readonly trackPx: number;
  readonly laneHeightPx: number;
  readonly maxLanes: number;
  readonly overflowBandHeightPx: number;
  readonly coverageCutoffDepth: number;
  readonly loadingAnimation: 'diagonal-scan';
}

export interface IndexedGenomeVariantSourceState {
  sourcePath: string;
  queryPath: string;
  indexPath: string;
  format: 'vcf' | 'bcf';
  label: string;
  sourceSizeBytes: number;
  sourceMtimeNs?: string;
  sourceIdentity: string;
  sourceGeneration?: VariantFileGeneration;
  queryGeneration?: VariantFileGeneration;
  indexGeneration?: VariantFileGeneration;
  assemblyRevision?: string;
  admittedSource?: AdmittedTrackSource;
  matchedReferences: string[];
  samples: string[];
  attachedAt: number;
}

export const ASSEMBLY_REFERENCE_ASSET_GENERATION_V1 =
  'assembly-reference-asset-generation.v1' as const;

export interface AssemblyReferenceAssetGenerationV1 {
  readonly contract: typeof ASSEMBLY_REFERENCE_ASSET_GENERATION_V1;
  readonly sourceFingerprint: string;
  readonly inventoryFingerprint: string;
  readonly themeMode: 'light' | 'dark';
}

export interface AssemblyReferenceAssetGenerationByThemeV1 {
  readonly light: AssemblyReferenceAssetGenerationV1;
  readonly dark?: AssemblyReferenceAssetGenerationV1;
}

export function assemblyReferenceAssetGenerationForThemeV1(
  input:
    | Pick<IndexedGenomeTabState, 'assemblyAssetGeneration' | 'assemblyAssetGenerationsByTheme'>
    | null
    | undefined,
  themeMode: 'light' | 'dark'
): AssemblyReferenceAssetGenerationV1 | undefined {
  return (
    input?.assemblyAssetGenerationsByTheme?.[themeMode] ??
    (input?.assemblyAssetGeneration?.themeMode === themeMode
      ? input.assemblyAssetGeneration
      : undefined)
  );
}

export function isAssemblyReferenceAssetGenerationV1(
  value: unknown
): value is AssemblyReferenceAssetGenerationV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 4 &&
    candidate.contract === ASSEMBLY_REFERENCE_ASSET_GENERATION_V1 &&
    typeof candidate.sourceFingerprint === 'string' &&
    /^[0-9a-f]{24}$/.test(candidate.sourceFingerprint) &&
    typeof candidate.inventoryFingerprint === 'string' &&
    /^[0-9a-f]{64}$/.test(candidate.inventoryFingerprint) &&
    (candidate.themeMode === 'light' || candidate.themeMode === 'dark')
  );
}

export function sameAssemblyReferenceAssetGenerationV1(
  left: AssemblyReferenceAssetGenerationV1,
  right: AssemblyReferenceAssetGenerationV1
): boolean {
  return (
    left.contract === right.contract &&
    left.sourceFingerprint === right.sourceFingerprint &&
    left.inventoryFingerprint === right.inventoryFingerprint &&
    left.themeMode === right.themeMode
  );
}

export interface IndexedGenomeTabState {
  sourcePath: string;
  workspaceRoot?: string;
  sourceSizeBytes?: number;
  sourceMtimeMs?: number;
  sourceCtimeMs?: number;
  sourceExt: string;
  chrom: string;
  outputDir?: string;
  manifest?: IndexedGenomeManifest;
  metadata?: IndexedGenomeMetadata;
  indexedAt?: number;
  error?: string;
  assembly?: GenomeAssembly;
  assemblySearchSource?: AssemblyAnnotationSceneReadRequest;
  assemblyAssetGeneration?: AssemblyReferenceAssetGenerationV1;
  assemblyAssetGenerationsByTheme?: AssemblyReferenceAssetGenerationByThemeV1;
  assemblyPortableBundleFingerprint?: string;
  assemblyReferenceIdentity?: ReferenceContentIdentity;
  assemblyReferenceVersionHistory?: readonly ReferenceVersionIdentity[];
  referenceAnnotationUpdateNotice?: string;
  assemblyAnnotationTrackTypes?: readonly string[];
  assemblySourceReadiness?: GenomeAssemblySourceReadiness;
  assemblyAnnotationProductsReadiness?: GenomeAssemblyCapabilityReadiness;
  assemblySearchReadiness?: GenomeAssemblyCapabilityReadiness;
  scope?: IndexedGenomeScope;
  bamTracks?: IndexedGenomeBamTrackState[];
  dataTracks?: IndexedGenomeDataTrackState[];
  signalReadPileupViews?: IndexedGenomeSignalReadPileupViewState[];
  ucscTracks?: IndexedGenomeUcscTrackState[];
  variantSource?: IndexedGenomeVariantSourceState;
  userAnnotations?: IndexedGenomeUserAnnotation[];
  primerBindings?: IndexedGenomePrimerBinding[];
}

export interface IndexedGenomePrimerBinding {
  id: string;
  primerId: string;
  primerName: string;
  primerBases: string;
  chrom: string;
  start0: number;
  end0: number;
  strand: '+' | '-';
  source: 'created' | 'attached';
}

export interface IndexedGenomeUserAnnotation {
  id: string;
  chrom: string;
  annotation: Annotation;
}

export interface IndexedGenomeDataTrackState {
  readonly trackId: string;
  readonly trackType: string;
  readonly label: string;
  readonly order?: number;
  readonly color: number;
  readonly trackPx: number;
  readonly laneHeightPx: number;
  readonly maxLanes: number;
  readonly visible: boolean;
  readonly quantitativePresentation?: import('@waypoint/genome-data').QuantitativeTrackPresentationV1;
  readonly source: AdmittedTrackSource;
  readonly remoteSignal?: import('./remote-genomics-ipc').RemoteSignalLocatorV1;
}

export type IndexedGenomeUcscTrackState = IndexedGenomeDataTrackState;

export interface GenomeDataInitResult {
  length: number;
}

export type GenomeTrackState =
  | 'source_accepted'
  | 'metadata_pending'
  | 'coordinate_ready'
  | 'index_required'
  | 'building_cache'
  | 'validation_pending'
  | 'ready'
  | 'degraded'
  | 'error';

export type GenomeTileState =
  | 'missing'
  | 'queued'
  | 'loading'
  | 'building_summary'
  | 'retained'
  | 'ready'
  | 'empty'
  | 'stale'
  | 'error';

export type GenomeTileFidelity = 'summary' | 'exact' | 'best_available';
export type GenomeValidationState = 'unvalidated' | 'metadata_match' | 'strong_match' | 'mismatch';
export type GenomeAnnotationFeatureModel = 'raw-gff3' | 'resolved-transcript-v2';
export type GenomeTileCacheState = 'none' | 'hit' | 'miss' | 'written';
export type GenomeTrackUserState =
  | 'Preparing'
  | 'Showing overview'
  | 'Updating'
  | 'Details limited'
  | 'Ready'
  | 'No data here'
  | 'Needs attention';

export const GENOME_TRACK_USER_STATE_BY_MACHINE: Record<GenomeTrackState, GenomeTrackUserState> = {
  source_accepted: 'Preparing',
  metadata_pending: 'Preparing',
  coordinate_ready: 'Showing overview',
  index_required: 'Updating',
  building_cache: 'Updating',
  validation_pending: 'Updating',
  ready: 'Showing overview',
  degraded: 'Details limited',
  error: 'Needs attention',
};

export const GENOME_TRACK_STATE_BY_TILE_STATE: Record<GenomeTileState, GenomeTrackState> = {
  missing: 'building_cache',
  queued: 'building_cache',
  loading: 'building_cache',
  building_summary: 'building_cache',
  retained: 'validation_pending',
  stale: 'validation_pending',
  ready: 'ready',
  empty: 'ready',
  error: 'error',
};

export function userStateForGenomeTrackState(state: GenomeTrackState): GenomeTrackUserState {
  return GENOME_TRACK_USER_STATE_BY_MACHINE[state];
}

export function trackStateForGenomeTileState(state: GenomeTileState): GenomeTrackState {
  return GENOME_TRACK_STATE_BY_TILE_STATE[state];
}

export type GenomeAssemblyCapabilityReadiness = 'not-applicable' | 'pending' | 'ready';

export type GenomeAssemblySourceReadiness = 'pending' | 'ready';

export type GenomeOpenIntent =
  | {
      kind: 'reference-assembly';
      searchSource?: AssemblyAnnotationSceneReadRequest;
      annotationProductsReadiness: GenomeAssemblyCapabilityReadiness;
      searchReadiness: GenomeAssemblyCapabilityReadiness;
      assetGeneration?: AssemblyReferenceAssetGenerationV1;
    }
  | {
      kind: 'reference-single';
    }
  | {
      kind: 'internal-assembly-segment';
      assetGeneration?: AssemblyReferenceAssetGenerationV1;
    };

export interface GenomeOpenSource {
  sourcePath: string;
  workspaceRoot?: string | null;
  chrom?: string;
  sourceSizeBytes?: number;
  sourceExt?: string;
  manifest?: IndexedGenomeManifest;
  intent: GenomeOpenIntent;
}

export interface GenomeTrackDescriptor {
  id: string;
  kind: 'sequence' | 'annotation' | 'alignment' | 'variant' | 'signal';
  label: string;
  state: GenomeTrackState;
  userState: GenomeTrackUserState;
  message?: string;
}

export interface GenomeSessionShell {
  sessionId: string;
  sourcePath: string;
  sourceFingerprint: string;
  chrom: string;
  sourceSizeBytes?: number;
  openReady: boolean;
  preparationError?: string;
  coordinateReady: boolean;
  length?: number;
  manifest?: IndexedGenomeManifest;
  assemblySearchSource?: AssemblyAnnotationSceneReadRequest;
  assemblyAnnotationFeatureCount?: number;
  assemblyAnnotationProductsReadiness?: GenomeAssemblyCapabilityReadiness;
  assemblySearchReadiness?: GenomeAssemblyCapabilityReadiness;
  preparedReferenceReadOnly?: true;
  assemblyAssetGeneration?: AssemblyReferenceAssetGenerationV1;
  validationState: GenomeValidationState;
  tracks: GenomeTrackDescriptor[];
  openedAt: number;
}

export interface GenomeTileRequest {
  trackId: string;
  chrom: string;
  start: number;
  end: number;
  lod: number;
  generation: number;
  fidelity: GenomeTileFidelity;
  byteBudget?: number;
  annotationOwner?: {
    start: number;
    end: number;
  };
  laneEpoch?: string;
}

export const GENOME_ANNOTATION_VIEWPORT_TILE_MAX_BP = 2_000_000;
export const GENOME_ANNOTATION_VIEWPORT_TILE_BYTE_BUDGET = 512 * 1024;
export const GENOME_ANNOTATION_EXACT_OWNER_MAX_BP = 512 * 1024;

export type GenomeAnnotationTileRequest = GenomeTileRequest & {
  trackId: string;
};

export interface GenomeSequenceWindowRequest {
  chrom: string;
  start: number;
  end: number;
  generation: number;
}

export interface GenomeSequenceWindow {
  sessionId: string;
  requestId: string;
  chrom: string;
  start: number;
  end: number;
  generation: number;
  validationState: GenomeValidationState;
  byteCount: number;
  bases: string;
}

export interface GenomeSequenceTilePayload {
  type: 'sequence';
  startBp: number;
  endBp: number;
  bases: string;
}

export interface GenomeAnnotationGlyphPayloadItem {
  id: string;
  type: string;
  trackId?: string;
  trackLane?: number;
  trackLaneCapacity?: number;
  label: string;
  startBp: number;
  endBp: number;
  strand: '+' | '-' | '.';
  lane: number;
  color: number;
  exons?: ReadonlyArray<{ start: number; end: number }>;
  cds?: ReadonlyArray<{ start: number; end: number }>;
  transcriptId?: string;
  qualifiers?: Record<string, string | undefined>;
}

type GenomeAnnotationCompactGlyphPayloadBase = [
  id: string,
  type: string,
  label: string,
  startBp: number,
  endBp: number,
  strand: '+' | '-' | '.',
  lane: number,
];

export type GenomeAnnotationCompactGlyphPayloadItem =
  | GenomeAnnotationCompactGlyphPayloadBase
  | [...GenomeAnnotationCompactGlyphPayloadBase, trackId: string]
  | [...GenomeAnnotationCompactGlyphPayloadBase, trackId: string, trackLane: number]
  | [
      ...GenomeAnnotationCompactGlyphPayloadBase,
      trackId: string,
      trackLane: number,
      trackLaneCapacity: number,
    ];

export type GenomeAnnotationCompactGlyphGeometryPayloadItem =
  | [id: string, exonRanges: number[]]
  | [id: string, exonRanges: number[], cdsRanges: number[]]
  | [id: string, exonRanges: number[], cdsRanges: number[], transcriptId: string];

export interface GenomeAnnotationGlyphPayload {
  type: 'annotation-glyphs';
  featureModel: GenomeAnnotationFeatureModel;
  glyphs: GenomeAnnotationGlyphPayloadItem[];
  compactGlyphs?: GenomeAnnotationCompactGlyphPayloadItem[];
  compactGeometry?: GenomeAnnotationCompactGlyphGeometryPayloadItem[];
  styleByType?: Record<string, { color: number }>;
  laneBounds?: {
    maxAnnotationLane: number;
    maxCdsLane: number;
  };
  droppedCount: number;
  typeFilteredCount: number;
}

export type GenomeTrackTilePayload = GenomeSequenceTilePayload | GenomeAnnotationGlyphPayload;

export interface GenomeTrackTile {
  sessionId: string;
  requestId: string;
  trackId: string;
  chrom: string;
  start: number;
  end: number;
  generation: number;
  state: GenomeTileState;
  fidelity: GenomeTileFidelity;
  validationState: GenomeValidationState;
  byteCount: number;
  recordCount: number;
  sourceRecordCount?: number;
  sourceRepresentationComplete?: boolean;
  layerTypes?: string[];
  featureModel?: GenomeAnnotationFeatureModel;
  cacheState?: GenomeTileCacheState;
  laneEpoch?: string;
  degradedReason?: GenomeTileDegradedReason;
  payload?: GenomeTrackTilePayload;
  features?: GenomeFeature[];
  message?: string;
}

export type GenomeTileDegradedReason = 'density';

export type GenomeDebugRequestKind =
  | 'open'
  | 'session_update'
  | 'track_tile'
  | 'annotation_tile'
  | 'sequence_window'
  | 'feature_details'
  | 'overview_build';

export type GenomeDebugRequestStatus = 'started' | 'completed' | 'error' | 'cancelled';

export interface GenomeCancelRequestResult {
  sessionId: string;
  requestId: string;
  cancelled: boolean;
}

export interface GenomeSessionReleaseResult {
  released: boolean;
  activeSessionCount: number;
  cancelledRequestCount: number;
}

export interface GenomeDebugOpenTimings {
  acceptedAt: number;
  shellCreatedAt: number;
  shellReturnedAt?: number;
  coordinateReadyAt?: number;
  readyAt?: number;
  errorAt?: number;
  elapsedToShellMs?: number;
  elapsedToCoordinateReadyMs?: number;
  elapsedToReadyMs?: number;
  status: 'source_accepted' | 'metadata_pending' | 'coordinate_ready' | 'ready' | 'error';
}

export interface GenomeDebugBudgets {
  maxSequenceWindowBases: number;
  maxAnnotationViewportTileBases: number;
  maxAnnotationViewportTileBytes: number;
}

export interface GenomeDebugQueues {
  pendingRequests: number;
  recentRequestCount: number;
  workerCount: number;
}

export interface GenomeDebugSourceIndexes {
  fastaPath?: string;
  faiPath?: string;
  gffPath?: string | null;
  tbiPath?: string | null;
}

export interface GenomeDebugRequestTrace {
  traceId: string;
  requestId: string;
  kind: GenomeDebugRequestKind;
  status: GenomeDebugRequestStatus;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  error?: string;
  trackId?: string;
  chrom?: string;
  start?: number;
  end?: number;
  lod?: number;
  generation?: number;
  fidelity?: GenomeTileFidelity;
  byteBudget?: number;
  tileKey?: string;
  tileState?: GenomeTileState;
  validationState?: GenomeValidationState;
  cacheState?: GenomeTileCacheState;
  byteCount?: number;
  recordCount?: number;
  sourceRecordCount?: number;
  milestonesMs?: Record<string, number>;
}

export interface GenomeDebugSnapshot {
  sessionId: string;
  sourceFingerprint: string;
  sourcePath: string;
  sourcePathRedacted: string;
  chrom: string;
  coordinateReady: boolean;
  validationState: GenomeValidationState;
  openedAt: number;
  trackStates: Array<Pick<GenomeTrackDescriptor, 'id' | 'kind' | 'state' | 'userState'>>;
  sourceIndexes?: GenomeDebugSourceIndexes;
  open: GenomeDebugOpenTimings;
  budgets: GenomeDebugBudgets;
  queues: GenomeDebugQueues;
  recentRequests: GenomeDebugRequestTrace[];
}

export type GenomeSessionPrepareStatus = 'preparing' | 'ready' | 'error';
export type GenomeSessionPrepareLoadPhase = 'indexing' | 'opening';

export interface GenomeSessionUpdate {
  sessionId: string;
  shell: GenomeSessionShell;
  prepareStatus: GenomeSessionPrepareStatus;
  prepareLoadPhase: GenomeSessionPrepareLoadPhase;
  tabState?: IndexedGenomeTabState;
  reusedExistingIndex?: boolean;
  error?: string;
}
