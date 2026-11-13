import type { AnnotationColorRoleKeyV1 } from '../../../annotation-role-palette';

export const COMPILED_BROAD_SURFACE_MANIFEST_V2 = 'compiled-broad-surface-manifest.v2' as const;
export const COMPILED_BROAD_SURFACE_ADMISSION_PROVENANCE_V1 =
  'compiled-broad-surface-admission-provenance.v1' as const;
export const BROAD_SURFACE_LEVEL_ORDER_FINEST_FIRST_V1 =
  'broad-surface-level-order.finest-first.v1' as const;
export const BROAD_SURFACE_NATIVE_DYADIC_SELECTION_V1 =
  'broad-surface-native-dyadic-selection.v1' as const;
export const BROAD_SURFACE_ADJACENT_MIP_BLEND_V1 = 'broad-surface-adjacent-mip-blend.v1' as const;
export const BROAD_SURFACE_GUTTERED_ROW_AND_X_SAMPLING_V2 =
  'broad-surface-guttered-row-and-x-sampling.v2' as const;
export const BOUNDED_ANNOTATION_PHYSICAL_BUDGET_V2 =
  'bounded-annotation-physical-budget.v2' as const;
export const BOUNDED_ANNOTATION_PLANNING_AUTHORITY_V2 =
  'bounded-annotation-planning-authority.v2' as const;
export const COMPILED_BROAD_SURFACE_MAX_FINITE_LANE_LIMIT_V2 = 64 as const;
export const BROAD_SURFACE_LANE_SLAB_ROW_COUNT_V2 = 8 as const;
export const BROAD_SURFACE_TILE_CONTENT_WIDTH_PX_V2 = 512 as const;
export const BROAD_SURFACE_X_FILTER_GUARD_PX_V2 = 1 as const;
export const BROAD_SURFACE_PREFETCH_RING_V2 = 1 as const;
export const BROAD_SURFACE_SUPPORTED_RASTER_DEVICE_PIXEL_RATIOS_V2 = Object.freeze([
  1, 2, 3,
] as const);
export const BROAD_SURFACE_LANE_ROW_CSS_HEIGHT_PX_V2 = 16 as const;
export const BROAD_SURFACE_LANE_ROW_TRANSPARENT_TAIL_GUTTER_CSS_PX_V2 = 2 as const;
export const BROAD_SURFACE_MAX_RASTER_MAGNIFICATION_X_EXCLUSIVE_V2 = 2 as const;

export type BroadSurfaceIsoformModeV2 = 'canonical' | 'expanded';

export interface CompiledBroadSurfaceViewportOwnershipInputV2 {
  readonly broadCorridorFinestSpanBp: number;
  readonly viewportSpanBp: number;
  readonly viewportCssWidthPx: number;
  readonly devicePixelRatio: number;
}

export function compiledBroadSurfaceHandoffSpanBpV2(
  input: Omit<CompiledBroadSurfaceViewportOwnershipInputV2, 'viewportSpanBp'> & {
    readonly genomeLengthBp: number;
  }
): number {
  const viewportPhysicalWidthPx =
    Math.max(1, input.viewportCssWidthPx) * Math.max(1, input.devicePixelRatio);
  return Math.min(
    input.genomeLengthBp,
    Math.ceil(
      input.broadCorridorFinestSpanBp *
        (viewportPhysicalWidthPx / BROAD_SURFACE_TILE_CONTENT_WIDTH_PX_V2)
    )
  );
}

export function compiledBroadSurfaceOwnsViewportV2(
  input: CompiledBroadSurfaceViewportOwnershipInputV2
): boolean {
  const viewportPhysicalWidthPx = input.viewportCssWidthPx * input.devicePixelRatio;
  if (input.viewportSpanBp <= 0 || viewportPhysicalWidthPx <= 0) return false;
  const desiredNativeTileSpanBp =
    input.viewportSpanBp * (BROAD_SURFACE_TILE_CONTENT_WIDTH_PX_V2 / viewportPhysicalWidthPx);
  return desiredNativeTileSpanBp >= input.broadCorridorFinestSpanBp;
}

const VERIFIED_MANIFESTS = new WeakSet<object>();
type TilePlacementCacheV2 = Array<Array<ExactBroadSurfaceTilePlacementV2 | undefined> | undefined>;
type CellIdBySlabCacheV2 = Array<string | undefined>;
type CellIdByTileCacheV2 = Array<CellIdBySlabCacheV2 | undefined>;
type CellIdByLevelCacheV2 = Array<CellIdByTileCacheV2 | undefined>;
const EXACT_TILE_PLACEMENT_CACHE_V2 = new WeakMap<
  CompiledBroadSurfaceManifestV2,
  TilePlacementCacheV2
>();
const COMPILED_CELL_ID_CACHE_V2 = new WeakMap<
  CompiledBroadSurfaceManifestV2,
  Record<BroadSurfaceIsoformModeV2, CellIdByLevelCacheV2>
>();
const MANIFEST_KEYS = Object.freeze([
  'contract',
  'levelOrderingContract',
  'pyramidSelectionContract',
  'mipBlendContract',
  'textureSamplingContract',
  'manifestFingerprint',
  'artifactKey',
  'trackId',
  'genomeLengthBp',
  'broadCorridorFinestSpanBp',
  'broadTilePhysicalWidthPx',
  'broadTileXGuardPhysicalPx',
  'prefetchRing',
  'maxQualifiedRasterMagnificationX',
  'rasterDevicePixelRatio',
  'laneSlabRowCount',
  'laneRowCssHeightPx',
  'laneRowTextureStridePx',
  'laneRowTransparentTailGutterPx',
  'laneRowCounts',
  'laneSlabs',
  'levels',
] as const);
const LEVEL_KEYS = Object.freeze(['level', 'tileSpanBp', 'tileCount'] as const);
const MODE_KEYS = Object.freeze(['canonical', 'expanded'] as const);
const SLAB_KEYS = Object.freeze([
  'slabId',
  'slabIndex',
  'firstLaneRow',
  'sourceLaneRowCount',
  'paddedLaneRowCount',
] as const);

export interface CompiledBroadSurfaceLevelV2 {
  readonly level: number;
  readonly tileSpanBp: number;
  readonly tileCount: number;
}

const ADMITTED_BROAD_SURFACE_PRESENTATION_PLANS_V2 = new WeakSet<object>();

export function isAdmittedBroadSurfacePresentationPlanV2(
  value: unknown
): value is BroadSurfacePresentationPlanV2 {
  return (
    typeof value === 'object' &&
    value !== null &&
    ADMITTED_BROAD_SURFACE_PRESENTATION_PLANS_V2.has(value)
  );
}

export interface CompiledBroadSurfaceLaneSlabV2 {
  readonly slabId: string;
  readonly slabIndex: number;
  readonly firstLaneRow: number;
  readonly sourceLaneRowCount: number;
  readonly paddedLaneRowCount: number;
}

export interface CompiledBroadSurfaceManifestV2 {
  readonly contract: typeof COMPILED_BROAD_SURFACE_MANIFEST_V2;
  readonly levelOrderingContract: typeof BROAD_SURFACE_LEVEL_ORDER_FINEST_FIRST_V1;
  readonly pyramidSelectionContract: typeof BROAD_SURFACE_NATIVE_DYADIC_SELECTION_V1;
  readonly mipBlendContract: typeof BROAD_SURFACE_ADJACENT_MIP_BLEND_V1;
  readonly textureSamplingContract: typeof BROAD_SURFACE_GUTTERED_ROW_AND_X_SAMPLING_V2;
  readonly manifestFingerprint: string;
  readonly artifactKey: string;
  readonly trackId: string;
  readonly genomeLengthBp: number;
  readonly broadCorridorFinestSpanBp: number;
  readonly broadTilePhysicalWidthPx: number;
  readonly broadTileXGuardPhysicalPx: number;
  readonly prefetchRing: number;
  readonly maxQualifiedRasterMagnificationX: number;
  readonly rasterDevicePixelRatio: number;
  readonly laneSlabRowCount: number;
  readonly laneRowCssHeightPx: number;
  readonly laneRowTextureStridePx: number;
  readonly laneRowTransparentTailGutterPx: number;
  readonly laneRowCounts: Readonly<Record<BroadSurfaceIsoformModeV2, number>>;
  readonly laneSlabs: Readonly<
    Record<BroadSurfaceIsoformModeV2, readonly CompiledBroadSurfaceLaneSlabV2[]>
  >;
  readonly levels: readonly CompiledBroadSurfaceLevelV2[];
}

export interface CompiledBroadSurfaceAdmissionProvenanceV1 {
  readonly contract: typeof COMPILED_BROAD_SURFACE_ADMISSION_PROVENANCE_V1;
  readonly manifestFingerprint: string;
  readonly artifactKey: string;
  readonly trackId: string;
  readonly genomeIdentity: string;
  readonly genomeLengthBp: number;
  readonly sourceFingerprint: string;
  readonly placementFingerprint: string;
  readonly themeMode?: 'light' | 'dark';
  readonly prepackedOwnerKey: string;
  readonly prepackedArtifactKey: string;
  readonly roleTable?: readonly AnnotationColorRoleKeyV1[];
}

export interface ExactLaneSlabCropV2 {
  readonly firstLaneRow: 0;
  readonly visibleLaneRowCount: number;
  readonly hiddenLaneRowStart: number;
  readonly submittedLaneSlabIds: readonly string[];
  readonly finalSlabIndex: number;
  readonly finalSlabVisibleRowCount: number;
  readonly finalSlabSourceRowCount: number;
  readonly finalSlabPaddedRowCount: number;
  readonly finalSlabTextureEndRowExclusivePx: number;
  readonly finalSlabTextureHiddenRowStartPx: number;
  readonly finalSlabTextureVEndExclusive: number;
  readonly finalSlabTextureSampleVMaxInclusive: number;
  readonly finalSlabNextRowFirstTexelCenterV: number;
  readonly cssHeightPx: number;
  readonly rasterDevicePixelRatio: number;
  readonly displayDevicePixelRatio: number;
  readonly textureToDisplayScale: number;
  readonly projectedPhysicalHeightPx: number;
  readonly physicalScissorHeightPx: number;
}

export interface ExactBroadSurfaceXCropV2 {
  readonly contentPhysicalWidthPx: number;
  readonly guardPhysicalPx: number;
  readonly storedPhysicalWidthPx: number;
  readonly contentStartPx: number;
  readonly contentEndExclusivePx: number;
  readonly textureContentUStart: number;
  readonly textureContentUEndExclusive: number;
  readonly textureSampleUMinInclusive: number;
  readonly textureSampleUMaxInclusive: number;
}

export interface ExactBroadSurfaceTilePlacementV2 {
  readonly tileId: string;
  readonly level: number;
  readonly tileX: number;
  readonly nominalStartBp: number;
  readonly nominalEndBpExclusive: number;
  readonly nominalSpanBp: number;
  readonly sourceStartBp: number;
  readonly sourceEndBpExclusive: number;
  readonly sourceSpanBp: number;
  readonly destinationStartBp: number;
  readonly destinationEndBpExclusive: number;
  readonly destinationSpanBp: number;
  readonly isAssemblyTerminalTile: boolean;
}

export type BroadSurfaceMipRoleV2 = 'single' | 'finer' | 'coarser';

export interface BroadSurfaceActiveLevelPlanV2 {
  readonly role: BroadSurfaceMipRoleV2;
  readonly level: number;
  readonly tileSpanBp: number;
  readonly sampleWeight: number;
  readonly projectedTilePhysicalWidthPx: number;
  readonly rasterMagnificationX: number;
  readonly visibleXTileIds: readonly string[];
  readonly residentXTileIds: readonly string[];
  readonly visibleTilePlacements: readonly ExactBroadSurfaceTilePlacementV2[];
}

export interface BroadSurfaceMipSelectionV2 {
  readonly nativeLevelPosition: number;
  readonly finerLevel: number;
  readonly coarserLevel: number | null;
  readonly lodMix: number;
  readonly activeLevels: readonly BroadSurfaceActiveLevelPlanV2[];
}

export interface BroadSurfaceActiveLevelBudgetV2 {
  readonly role: BroadSurfaceMipRoleV2;
  readonly level: number;
  readonly tileSpanBp: number;
  readonly sampleWeight: number;
  readonly projectedTilePhysicalWidthPx: number;
  readonly rasterMagnificationX: number;
  readonly visibleXTileBudget: number;
  readonly residentXTileBudget: number;
  readonly surfaceCellBudget: number;
  readonly residentTexturePixelBudget: number;
}

export interface BroadSurfaceTrackBudgetV2 {
  readonly trackId: string;
  readonly manifestFingerprint: string;
  readonly selectedLevel: number;
  readonly selectedTileSpanBp: number;
  readonly projectedTilePhysicalWidthPx: number;
  readonly prefetchRing: number;
  readonly nativeLevelPosition: number;
  readonly lodMix: number;
  readonly activeLevels: readonly BroadSurfaceActiveLevelBudgetV2[];
  readonly visibleXTileBudget: number;
  readonly residentXTileBudget: number;
  readonly submittedLaneSlabBudget: number;
  readonly surfaceSpriteBudget: number;
  readonly tileContentPhysicalWidthPx: number;
  readonly tileXGuardPhysicalPx: number;
  readonly tileStoredPhysicalWidthPx: number;
  readonly residentTexturePixelBudget: number;
  readonly committedTrackPhysicalHeightPx: number;
}

export interface BroadSurfacePhysicalBudgetV2 {
  readonly formula: typeof BOUNDED_ANNOTATION_PHYSICAL_BUDGET_V2;
  readonly authority: typeof BOUNDED_ANNOTATION_PLANNING_AUTHORITY_V2;
  readonly viewportPhysicalWidthPx: number;
  readonly committedVisibleBroadTrackCount: number;
  readonly trackBudgets: readonly BroadSurfaceTrackBudgetV2[];
  readonly visibleSpriteBudget: number;
  readonly residentTexturePixelBudget: number;
  readonly committedTrackPhysicalHeightPx: number;
  readonly fragmentPixelBudget: number;
  readonly broadVectorInstanceBudget: 0;
  readonly durableWriteBudget: 0;
}

export interface BroadSurfacePresentationPlanV2 {
  readonly status: 'broad-ready';
  readonly manifestFingerprint: string;
  readonly artifactKey: string;
  readonly trackId: string;
  readonly isoformMode: BroadSurfaceIsoformModeV2;
  readonly laneLimit: number | null;
  readonly viewportStartBp: number;
  readonly viewportEndBp: number;
  readonly ordinaryPresentationKind: 'compiled-broad-surface-2d';
  readonly desiredNativeTileSpanBp: number;
  readonly nativeLevelPosition: number;
  readonly finerLevel: number;
  readonly coarserLevel: number | null;
  readonly lodMix: number;
  readonly activeLevels: readonly BroadSurfaceActiveLevelPlanV2[];
  readonly activeVisibleXTileIds: readonly string[];
  readonly activeResidentXTileIds: readonly string[];
  readonly activeSubmittedSurfaceCellIds: readonly string[];
  readonly selectedLevel: number;
  readonly selectedTileSpanBp: number;
  readonly projectedTilePhysicalWidthPx: number;
  readonly visibleXTileIds: readonly string[];
  readonly residentXTileIds: readonly string[];
  readonly visibleTilePlacements: readonly ExactBroadSurfaceTilePlacementV2[];
  readonly submittedLaneSlabIds: readonly string[];
  readonly submittedSurfaceCellIds: readonly string[];
  readonly xCrop: ExactBroadSurfaceXCropV2;
  readonly laneCrop: ExactLaneSlabCropV2;
  readonly physicalBudget: BroadSurfacePhysicalBudgetV2;
}

export interface BroadSurfaceDetailRequiredV2 {
  readonly status: 'detail-required';
  readonly reason: 'below-broad-corridor-finest-span';
  readonly manifestFingerprint: string;
  readonly artifactKey: string;
  readonly trackId: string;
  readonly isoformMode: BroadSurfaceIsoformModeV2;
  readonly laneLimit: number | null;
  readonly viewportStartBp: number;
  readonly viewportEndBp: number;
  readonly desiredNativeTileSpanBp: number;
  readonly broadCorridorFinestSpanBp: number;
}

export interface BroadSurfaceArtifactRequiredV2 {
  readonly status: 'broad-artifact-required';
  readonly reason: 'insufficient-raster-device-pixel-ratio';
  readonly manifestFingerprint: string;
  readonly artifactKey: string;
  readonly trackId: string;
  readonly isoformMode: BroadSurfaceIsoformModeV2;
  readonly laneLimit: number | null;
  readonly viewportStartBp: number;
  readonly viewportEndBp: number;
  readonly manifestRasterDevicePixelRatio: number;
  readonly requestedRasterDevicePixelRatio: number;
}

export type BroadSurfacePlanResultV2 =
  | BroadSurfacePresentationPlanV2
  | BroadSurfaceDetailRequiredV2
  | BroadSurfaceArtifactRequiredV2;

export interface CommittedVisibleBroadTrackV2 {
  readonly trackId: string;
  readonly manifest: CompiledBroadSurfaceManifestV2;
  readonly isoformMode: BroadSurfaceIsoformModeV2;
  readonly laneLimit: number | null;
  readonly viewportStartBp: number;
  readonly viewportEndBp: number;
}

export interface BroadSurfaceObservationV2 {
  readonly trackId: string;
  readonly artifactKey: string;
  readonly manifestFingerprint: string;
  readonly isoformMode: BroadSurfaceIsoformModeV2;
  readonly laneLimit: number | null;
  readonly selectedLevel: number;
  readonly nativeLevelPosition: number;
  readonly lodMix: number;
  readonly activeLevelIds: readonly string[];
  readonly activeLevelSampleWeights: readonly number[];
  readonly activeVisibleXTileIds: readonly string[];
  readonly activeResidentXTileIds: readonly string[];
  readonly activeSubmittedSurfaceCellIds: readonly string[];
  readonly visibleXTileIds: readonly string[];
  readonly residentXTileIds: readonly string[];
  readonly visibleTilePlacements: readonly ExactBroadSurfaceTilePlacementV2[];
  readonly submittedLaneSlabIds: readonly string[];
  readonly submittedSurfaceCellIds: readonly string[];
  readonly tileContentPhysicalWidthPx: number;
  readonly tileXGuardPhysicalPx: number;
  readonly tileStoredPhysicalWidthPx: number;
  readonly textureContentUStart: number;
  readonly textureContentUEndExclusive: number;
  readonly textureSampleUMinInclusive: number;
  readonly textureSampleUMaxInclusive: number;
  readonly finalSlabTextureEndRowExclusivePx: number;
  readonly finalSlabTextureVEndExclusive: number;
  readonly finalSlabTextureSampleVMaxInclusive: number;
  readonly physicalScissorHeightPx: number;
  readonly submittedSpriteHighWater: number;
  readonly residentTexturePixelHighWater: number;
  readonly fragmentPixelHighWater: number;
  readonly broadVectorInstanceHighWater: number;
  readonly durableWriteHighWater: number;
}

export async function buildCompiledBroadSurfaceManifestV2(input: {
  artifactKey: string;
  trackId: string;
  genomeLengthBp: number;
  broadCorridorFinestSpanBp: number;
  broadTilePhysicalWidthPx: number;
  broadTileXGuardPhysicalPx: number;
  prefetchRing: number;
  maxQualifiedRasterMagnificationX: number;
  rasterDevicePixelRatio: number;
  laneSlabRowCount: number;
  laneRowCssHeightPx: number;
  laneRowTextureStridePx: number;
  laneRowTransparentTailGutterPx: number;
  laneRowCounts: Readonly<Record<BroadSurfaceIsoformModeV2, number>>;
}): Promise<CompiledBroadSurfaceManifestV2> {
  const artifactKey = token(input.artifactKey, 'artifactKey');
  const trackId = token(input.trackId, 'trackId');
  const genomeLengthBp = positiveSafeInteger(input.genomeLengthBp, 'genomeLengthBp');
  const broadCorridorFinestSpanBp = positiveSafeInteger(
    input.broadCorridorFinestSpanBp,
    'broadCorridorFinestSpanBp'
  );
  const broadTilePhysicalWidthPx = positiveSafeInteger(
    input.broadTilePhysicalWidthPx,
    'broadTilePhysicalWidthPx'
  );
  const broadTileXGuardPhysicalPx = positiveSafeInteger(
    input.broadTileXGuardPhysicalPx,
    'broadTileXGuardPhysicalPx'
  );
  const prefetchRing = nonnegativeSafeInteger(input.prefetchRing, 'prefetchRing');
  const maxQualifiedRasterMagnificationX = qualifiedRasterMagnification(
    input.maxQualifiedRasterMagnificationX
  );
  const rasterDevicePixelRatio = positiveFinite(
    input.rasterDevicePixelRatio,
    'rasterDevicePixelRatio'
  );
  const laneSlabRowCount = positiveSafeInteger(input.laneSlabRowCount, 'laneSlabRowCount');
  if (laneSlabRowCount !== BROAD_SURFACE_LANE_SLAB_ROW_COUNT_V2) {
    throw new Error('broad surface lane slab row contract must be 8');
  }
  const laneRowCssHeightPx = positiveFinite(input.laneRowCssHeightPx, 'laneRowCssHeightPx');
  const laneRowTextureStridePx = positiveSafeInteger(
    input.laneRowTextureStridePx,
    'laneRowTextureStridePx'
  );
  const laneRowTransparentTailGutterPx = positiveSafeInteger(
    input.laneRowTransparentTailGutterPx,
    'laneRowTransparentTailGutterPx'
  );
  if (laneRowTransparentTailGutterPx >= laneRowTextureStridePx) {
    throw new Error('broad surface lane row gutter must leave content texels');
  }
  assertPinnedBroadSurfaceGeometry({
    broadTilePhysicalWidthPx,
    broadTileXGuardPhysicalPx,
    prefetchRing,
    rasterDevicePixelRatio,
    laneSlabRowCount,
    laneRowCssHeightPx,
    laneRowTextureStridePx,
    laneRowTransparentTailGutterPx,
  });
  const laneRowCounts = Object.freeze({
    canonical: positiveSafeInteger(input.laneRowCounts?.canonical, 'canonical lane rows'),
    expanded: positiveSafeInteger(input.laneRowCounts?.expanded, 'expanded lane rows'),
  });
  const laneSlabs = Object.freeze({
    canonical: buildLaneSlabRoster('canonical', laneRowCounts.canonical, laneSlabRowCount),
    expanded: buildLaneSlabRoster('expanded', laneRowCounts.expanded, laneSlabRowCount),
  });
  const levels = buildFinestFirstLevels(genomeLengthBp, broadCorridorFinestSpanBp);
  const canonicalFields = {
    artifactKey,
    trackId,
    genomeLengthBp,
    broadCorridorFinestSpanBp,
    broadTilePhysicalWidthPx,
    broadTileXGuardPhysicalPx,
    prefetchRing,
    maxQualifiedRasterMagnificationX,
    rasterDevicePixelRatio,
    laneSlabRowCount,
    laneRowCssHeightPx,
    laneRowTextureStridePx,
    laneRowTransparentTailGutterPx,
    laneRowCounts,
    laneSlabs,
    levels,
  };
  const manifestFingerprint = await sha256Hex(
    new TextEncoder().encode(manifestContractMaterial(canonicalFields))
  );
  return admitCompiledBroadSurfaceManifestV2({
    contract: COMPILED_BROAD_SURFACE_MANIFEST_V2,
    levelOrderingContract: BROAD_SURFACE_LEVEL_ORDER_FINEST_FIRST_V1,
    pyramidSelectionContract: BROAD_SURFACE_NATIVE_DYADIC_SELECTION_V1,
    mipBlendContract: BROAD_SURFACE_ADJACENT_MIP_BLEND_V1,
    textureSamplingContract: BROAD_SURFACE_GUTTERED_ROW_AND_X_SAMPLING_V2,
    manifestFingerprint,
    ...canonicalFields,
  });
}

export async function admitCompiledBroadSurfaceManifestV2(
  value: unknown
): Promise<CompiledBroadSurfaceManifestV2> {
  const input = exactRecord(value, MANIFEST_KEYS, 'compiled broad surface manifest');
  if (input.contract !== COMPILED_BROAD_SURFACE_MANIFEST_V2) {
    throw new Error('compiled broad surface manifest contract is invalid');
  }
  if (input.levelOrderingContract !== BROAD_SURFACE_LEVEL_ORDER_FINEST_FIRST_V1) {
    throw new Error('compiled broad surface level ordering is invalid');
  }
  if (
    input.pyramidSelectionContract !== BROAD_SURFACE_NATIVE_DYADIC_SELECTION_V1 ||
    input.mipBlendContract !== BROAD_SURFACE_ADJACENT_MIP_BLEND_V1 ||
    input.textureSamplingContract !== BROAD_SURFACE_GUTTERED_ROW_AND_X_SAMPLING_V2
  ) {
    throw new Error('compiled broad surface manifest contract is invalid');
  }
  const artifactKey = token(input.artifactKey, 'artifactKey');
  const trackId = token(input.trackId, 'trackId');
  const genomeLengthBp = positiveSafeInteger(input.genomeLengthBp, 'genomeLengthBp');
  const broadCorridorFinestSpanBp = positiveSafeInteger(
    input.broadCorridorFinestSpanBp,
    'broadCorridorFinestSpanBp'
  );
  const broadTilePhysicalWidthPx = positiveSafeInteger(
    input.broadTilePhysicalWidthPx,
    'broadTilePhysicalWidthPx'
  );
  const broadTileXGuardPhysicalPx = positiveSafeInteger(
    input.broadTileXGuardPhysicalPx,
    'broadTileXGuardPhysicalPx'
  );
  const prefetchRing = nonnegativeSafeInteger(input.prefetchRing, 'prefetchRing');
  const maxQualifiedRasterMagnificationX = qualifiedRasterMagnification(
    input.maxQualifiedRasterMagnificationX
  );
  const rasterDevicePixelRatio = positiveFinite(
    input.rasterDevicePixelRatio,
    'rasterDevicePixelRatio'
  );
  const laneSlabRowCount = positiveSafeInteger(input.laneSlabRowCount, 'laneSlabRowCount');
  if (laneSlabRowCount !== BROAD_SURFACE_LANE_SLAB_ROW_COUNT_V2) {
    throw new Error('compiled broad surface lane slab row contract is invalid');
  }
  const laneRowCssHeightPx = positiveFinite(input.laneRowCssHeightPx, 'laneRowCssHeightPx');
  const laneRowTextureStridePx = positiveSafeInteger(
    input.laneRowTextureStridePx,
    'laneRowTextureStridePx'
  );
  const laneRowTransparentTailGutterPx = positiveSafeInteger(
    input.laneRowTransparentTailGutterPx,
    'laneRowTransparentTailGutterPx'
  );
  if (laneRowTransparentTailGutterPx >= laneRowTextureStridePx) {
    throw new Error('broad surface lane row gutter must leave content texels');
  }
  assertPinnedBroadSurfaceGeometry({
    broadTilePhysicalWidthPx,
    broadTileXGuardPhysicalPx,
    prefetchRing,
    rasterDevicePixelRatio,
    laneSlabRowCount,
    laneRowCssHeightPx,
    laneRowTextureStridePx,
    laneRowTransparentTailGutterPx,
  });
  const rawCounts = exactRecord(
    input.laneRowCounts,
    MODE_KEYS,
    'compiled broad surface lane row counts'
  );
  const laneRowCounts = Object.freeze({
    canonical: positiveSafeInteger(rawCounts.canonical, 'canonical lane rows'),
    expanded: positiveSafeInteger(rawCounts.expanded, 'expanded lane rows'),
  });
  const rawSlabs = exactRecord(input.laneSlabs, MODE_KEYS, 'compiled broad surface lane slabs');
  const laneSlabs = Object.freeze({
    canonical: admitLaneSlabRoster(
      rawSlabs.canonical,
      'canonical',
      laneRowCounts.canonical,
      laneSlabRowCount
    ),
    expanded: admitLaneSlabRoster(
      rawSlabs.expanded,
      'expanded',
      laneRowCounts.expanded,
      laneSlabRowCount
    ),
  });
  const levels = admitFinestFirstLevels(input.levels, genomeLengthBp, broadCorridorFinestSpanBp);
  const canonicalFields = {
    artifactKey,
    trackId,
    genomeLengthBp,
    broadCorridorFinestSpanBp,
    broadTilePhysicalWidthPx,
    broadTileXGuardPhysicalPx,
    prefetchRing,
    maxQualifiedRasterMagnificationX,
    rasterDevicePixelRatio,
    laneSlabRowCount,
    laneRowCssHeightPx,
    laneRowTextureStridePx,
    laneRowTransparentTailGutterPx,
    laneRowCounts,
    laneSlabs,
    levels,
  };
  const manifestFingerprint = sha256(input.manifestFingerprint, 'manifestFingerprint');
  const computedFingerprint = await sha256Hex(
    new TextEncoder().encode(manifestContractMaterial(canonicalFields))
  );
  if (manifestFingerprint !== computedFingerprint) {
    throw new Error('compiled broad surface manifest SHA-256 mismatch');
  }
  const manifest: CompiledBroadSurfaceManifestV2 = Object.freeze({
    contract: COMPILED_BROAD_SURFACE_MANIFEST_V2,
    levelOrderingContract: BROAD_SURFACE_LEVEL_ORDER_FINEST_FIRST_V1,
    pyramidSelectionContract: BROAD_SURFACE_NATIVE_DYADIC_SELECTION_V1,
    mipBlendContract: BROAD_SURFACE_ADJACENT_MIP_BLEND_V1,
    textureSamplingContract: BROAD_SURFACE_GUTTERED_ROW_AND_X_SAMPLING_V2,
    manifestFingerprint,
    ...canonicalFields,
  });
  VERIFIED_MANIFESTS.add(manifest);
  return manifest;
}

export function exactLaneSlabCropV2(input: {
  manifest: CompiledBroadSurfaceManifestV2;
  isoformMode: BroadSurfaceIsoformModeV2;
  laneLimit: number | null;
  devicePixelRatio: number;
}): ExactLaneSlabCropV2 {
  validateManifest(input.manifest);
  const isoformMode = mode(input.isoformMode);
  const laneLimit = laneLimitValue(input.laneLimit);
  const devicePixelRatio = positiveFinite(input.devicePixelRatio, 'devicePixelRatio');
  if (devicePixelRatio > input.manifest.rasterDevicePixelRatio) {
    throw new Error('broad surface raster device pixel ratio is insufficient');
  }
  const availableLaneRows = input.manifest.laneRowCounts[isoformMode];
  const visibleLaneRowCount =
    laneLimit === null ? availableLaneRows : Math.min(availableLaneRows, laneLimit);
  const finalSlabIndex = Math.ceil(visibleLaneRowCount / input.manifest.laneSlabRowCount) - 1;
  const selectedSlabs = input.manifest.laneSlabs[isoformMode].slice(0, finalSlabIndex + 1);
  const finalSlab = selectedSlabs[selectedSlabs.length - 1];
  if (!finalSlab) throw new Error('broad surface final lane slab is absent');
  const finalSlabVisibleRowCount =
    visibleLaneRowCount - finalSlabIndex * input.manifest.laneSlabRowCount;
  if (finalSlabVisibleRowCount > finalSlab.sourceLaneRowCount) {
    throw new Error('broad surface crop enters padded lane rows');
  }
  const slabTextureHeightPx =
    input.manifest.laneSlabRowCount * input.manifest.laneRowTextureStridePx;
  const finalSlabTextureHiddenRowStartPx =
    finalSlabVisibleRowCount * input.manifest.laneRowTextureStridePx;
  const finalSlabTextureEndRowExclusivePx = finalSlabTextureHiddenRowStartPx;
  const cssHeightPx = visibleLaneRowCount * input.manifest.laneRowCssHeightPx;
  const projectedPhysicalHeightPx = cssHeightPx * devicePixelRatio;
  return Object.freeze({
    firstLaneRow: 0,
    visibleLaneRowCount,
    hiddenLaneRowStart: visibleLaneRowCount,
    submittedLaneSlabIds: Object.freeze(selectedSlabs.map((slab) => slab.slabId)),
    finalSlabIndex,
    finalSlabVisibleRowCount,
    finalSlabSourceRowCount: finalSlab.sourceLaneRowCount,
    finalSlabPaddedRowCount: finalSlab.paddedLaneRowCount,
    finalSlabTextureEndRowExclusivePx,
    finalSlabTextureHiddenRowStartPx,
    finalSlabTextureVEndExclusive: finalSlabTextureEndRowExclusivePx / slabTextureHeightPx,
    finalSlabTextureSampleVMaxInclusive:
      (finalSlabTextureHiddenRowStartPx - 0.5) / slabTextureHeightPx,
    finalSlabNextRowFirstTexelCenterV:
      (finalSlabTextureHiddenRowStartPx + 0.5) / slabTextureHeightPx,
    cssHeightPx,
    rasterDevicePixelRatio: input.manifest.rasterDevicePixelRatio,
    displayDevicePixelRatio: devicePixelRatio,
    textureToDisplayScale: devicePixelRatio / input.manifest.rasterDevicePixelRatio,
    projectedPhysicalHeightPx,
    physicalScissorHeightPx: projectedPhysicalHeightPx,
  });
}

export function exactBroadSurfaceXCropV2(
  manifest: CompiledBroadSurfaceManifestV2
): ExactBroadSurfaceXCropV2 {
  validateManifest(manifest);
  const contentPhysicalWidthPx = manifest.broadTilePhysicalWidthPx;
  const guardPhysicalPx = manifest.broadTileXGuardPhysicalPx;
  const storedPhysicalWidthPx = contentPhysicalWidthPx + guardPhysicalPx * 2;
  const contentStartPx = guardPhysicalPx;
  const contentEndExclusivePx = guardPhysicalPx + contentPhysicalWidthPx;
  return Object.freeze({
    contentPhysicalWidthPx,
    guardPhysicalPx,
    storedPhysicalWidthPx,
    contentStartPx,
    contentEndExclusivePx,
    textureContentUStart: contentStartPx / storedPhysicalWidthPx,
    textureContentUEndExclusive: contentEndExclusivePx / storedPhysicalWidthPx,
    textureSampleUMinInclusive: (contentStartPx + 0.5) / storedPhysicalWidthPx,
    textureSampleUMaxInclusive: (contentEndExclusivePx - 0.5) / storedPhysicalWidthPx,
  });
}

export function exactBroadSurfaceTilePlacementV2(input: {
  manifest: CompiledBroadSurfaceManifestV2;
  level: number;
  tileX: number;
}): ExactBroadSurfaceTilePlacementV2 {
  validateManifest(input.manifest);
  const levelIndex = nonnegativeSafeInteger(input.level, 'level');
  const tileX = nonnegativeSafeInteger(input.tileX, 'tileX');
  const level = input.manifest.levels[levelIndex];
  if (!level || level.level !== levelIndex || tileX >= level.tileCount) {
    throw new Error('broad surface tile address is outside the finest-first pyramid');
  }
  let manifestCache = EXACT_TILE_PLACEMENT_CACHE_V2.get(input.manifest);
  if (!manifestCache) {
    manifestCache = [];
    EXACT_TILE_PLACEMENT_CACHE_V2.set(input.manifest, manifestCache);
  }
  let levelCache = manifestCache[levelIndex];
  if (!levelCache) {
    levelCache = [];
    manifestCache[levelIndex] = levelCache;
  }
  const cached = levelCache[tileX];
  if (cached) return cached;
  const nominalStartBp = tileX * level.tileSpanBp;
  const nominalEndBpExclusive = nominalStartBp + level.tileSpanBp;
  if (!Number.isSafeInteger(nominalStartBp) || !Number.isSafeInteger(nominalEndBpExclusive)) {
    throw new Error('broad surface nominal tile placement exceeds the safe coordinate range');
  }
  const sourceEndBpExclusive = Math.min(nominalEndBpExclusive, input.manifest.genomeLengthBp);
  const placement = Object.freeze({
    tileId: xTileId(level.level, tileX),
    level: level.level,
    tileX,
    nominalStartBp,
    nominalEndBpExclusive,
    nominalSpanBp: level.tileSpanBp,
    sourceStartBp: nominalStartBp,
    sourceEndBpExclusive,
    sourceSpanBp: sourceEndBpExclusive - nominalStartBp,
    destinationStartBp: nominalStartBp,
    destinationEndBpExclusive: nominalEndBpExclusive,
    destinationSpanBp: level.tileSpanBp,
    isAssemblyTerminalTile: tileX === level.tileCount - 1,
  });
  levelCache[tileX] = placement;
  return placement;
}

export function compiledBroadSurfaceCellIdV2(input: {
  manifest: CompiledBroadSurfaceManifestV2;
  isoformMode: BroadSurfaceIsoformModeV2;
  level: number;
  tileX: number;
  laneSlabIndex: number;
}): string {
  validateManifest(input.manifest);
  const isoformMode = mode(input.isoformMode);
  const placement = exactBroadSurfaceTilePlacementV2(input);
  const laneSlabIndex = nonnegativeSafeInteger(input.laneSlabIndex, 'laneSlabIndex');
  const slab = input.manifest.laneSlabs[isoformMode][laneSlabIndex];
  if (!slab || slab.slabIndex !== laneSlabIndex) {
    throw new Error('broad surface lane slab address is outside the manifest');
  }
  let manifestCache = COMPILED_CELL_ID_CACHE_V2.get(input.manifest);
  if (!manifestCache) {
    manifestCache = { canonical: [], expanded: [] };
    COMPILED_CELL_ID_CACHE_V2.set(input.manifest, manifestCache);
  }
  const modeCache = manifestCache[isoformMode];
  let levelCache = modeCache[placement.level];
  if (!levelCache) {
    levelCache = [];
    modeCache[placement.level] = levelCache;
  }
  let tileCache = levelCache[placement.tileX];
  if (!tileCache) {
    tileCache = [];
    levelCache[placement.tileX] = tileCache;
  }
  const cached = tileCache[laneSlabIndex];
  if (cached) return cached;
  const cellId = `M${input.manifest.manifestFingerprint}|DPR${input.manifest.rasterDevicePixelRatio}|${placement.tileId}|${slab.slabId}`;
  tileCache[laneSlabIndex] = cellId;
  return cellId;
}

export function selectCompiledBroadSurfaceRasterVariantV2(input: {
  manifests: readonly CompiledBroadSurfaceManifestV2[];
  devicePixelRatio: number;
}): CompiledBroadSurfaceManifestV2 | null {
  const devicePixelRatio = positiveFinite(input.devicePixelRatio, 'devicePixelRatio');
  if (!Array.isArray(input.manifests) || input.manifests.length === 0) return null;
  const variants = input.manifests.map((manifest) => {
    validateManifest(manifest);
    return manifest;
  });
  const family = rasterVariantFamilyMaterial(variants[0]);
  if (variants.some((manifest) => rasterVariantFamilyMaterial(manifest) !== family)) {
    throw new Error('broad surface raster variants do not share one logical surface');
  }
  const scales = new Set<number>();
  for (const variant of variants) {
    if (scales.has(variant.rasterDevicePixelRatio)) {
      throw new Error('broad surface raster variant scale is duplicated');
    }
    scales.add(variant.rasterDevicePixelRatio);
  }
  return (
    [...variants]
      .sort((left, right) => left.rasterDevicePixelRatio - right.rasterDevicePixelRatio)
      .find((manifest) => manifest.rasterDevicePixelRatio >= devicePixelRatio) ?? null
  );
}

export function deriveBoundedAnnotationPhysicalBudgetV2(input: {
  viewportCssWidthPx: number;
  devicePixelRatio: number;
  committedVisibleBroadTracks: readonly CommittedVisibleBroadTrackV2[];
}): BroadSurfacePhysicalBudgetV2 {
  const viewportPhysicalWidthPx =
    positiveFinite(input.viewportCssWidthPx, 'viewportCssWidthPx') *
    positiveFinite(input.devicePixelRatio, 'devicePixelRatio');
  if (
    !Array.isArray(input.committedVisibleBroadTracks) ||
    input.committedVisibleBroadTracks.length === 0
  ) {
    throw new Error('broad surface budget requires a committed visible track');
  }
  const trackIds = new Set<string>();
  const trackBudgets: BroadSurfaceTrackBudgetV2[] = [];
  let visibleSpriteBudget = 0;
  let residentTexturePixelBudget = 0;
  let committedTrackPhysicalHeightPx = 0;
  let fragmentPixelBudget = 0;
  for (const track of input.committedVisibleBroadTracks) {
    validateManifest(track.manifest);
    const trackId = token(track.trackId, 'committed trackId');
    if (trackId !== track.manifest.trackId) {
      throw new Error('broad surface committed track owner mismatch');
    }
    if (trackIds.has(trackId)) {
      throw new Error(`broad surface committed track duplicated: ${trackId}`);
    }
    trackIds.add(trackId);
    const viewport = validatedViewport(track.manifest, track.viewportStartBp, track.viewportEndBp);
    const mipSelection = deriveBroadSurfaceMipSelectionV2({
      manifest: track.manifest,
      viewportStartBp: viewport.startBp,
      viewportEndBp: viewport.endBp,
      viewportPhysicalWidthPx,
    });
    if (!mipSelection) {
      throw new Error('broad surface budget track is below the compiled corridor');
    }
    const crop = exactLaneSlabCropV2({
      manifest: track.manifest,
      isoformMode: track.isoformMode,
      laneLimit: track.laneLimit,
      devicePixelRatio: input.devicePixelRatio,
    });
    const xCrop = exactBroadSurfaceXCropV2(track.manifest);
    const slabTextureHeightPx =
      track.manifest.laneSlabRowCount * track.manifest.laneRowTextureStridePx;
    const activeLevelBudgets = Object.freeze(
      mipSelection.activeLevels.map((activeLevel) => {
        const surfaceCellBudget =
          activeLevel.visibleXTileIds.length * crop.submittedLaneSlabIds.length;
        const activeTexturePixelBudget =
          activeLevel.residentXTileIds.length *
          crop.submittedLaneSlabIds.length *
          xCrop.storedPhysicalWidthPx *
          slabTextureHeightPx;
        return Object.freeze({
          role: activeLevel.role,
          level: activeLevel.level,
          tileSpanBp: activeLevel.tileSpanBp,
          sampleWeight: activeLevel.sampleWeight,
          projectedTilePhysicalWidthPx: activeLevel.projectedTilePhysicalWidthPx,
          rasterMagnificationX: activeLevel.rasterMagnificationX,
          visibleXTileBudget: activeLevel.visibleXTileIds.length,
          residentXTileBudget: activeLevel.residentXTileIds.length,
          surfaceCellBudget,
          residentTexturePixelBudget: activeTexturePixelBudget,
        });
      })
    );
    const surfaceSpriteBudget = activeLevelBudgets.reduce(
      (sum, active) => sum + active.surfaceCellBudget,
      0
    );
    const trackTexturePixelBudget = activeLevelBudgets.reduce(
      (sum, active) => sum + active.residentTexturePixelBudget,
      0
    );
    const selected = mipSelection.activeLevels[0];
    visibleSpriteBudget += surfaceSpriteBudget;
    residentTexturePixelBudget += trackTexturePixelBudget;
    committedTrackPhysicalHeightPx += crop.physicalScissorHeightPx;
    fragmentPixelBudget += viewportPhysicalWidthPx * crop.physicalScissorHeightPx;
    trackBudgets.push(
      Object.freeze({
        trackId,
        manifestFingerprint: track.manifest.manifestFingerprint,
        selectedLevel: selected.level,
        selectedTileSpanBp: selected.tileSpanBp,
        projectedTilePhysicalWidthPx: selected.projectedTilePhysicalWidthPx,
        prefetchRing: track.manifest.prefetchRing,
        nativeLevelPosition: mipSelection.nativeLevelPosition,
        lodMix: mipSelection.lodMix,
        activeLevels: activeLevelBudgets,
        visibleXTileBudget: activeLevelBudgets.reduce(
          (sum, active) => sum + active.visibleXTileBudget,
          0
        ),
        residentXTileBudget: activeLevelBudgets.reduce(
          (sum, active) => sum + active.residentXTileBudget,
          0
        ),
        submittedLaneSlabBudget: crop.submittedLaneSlabIds.length,
        surfaceSpriteBudget,
        tileContentPhysicalWidthPx: xCrop.contentPhysicalWidthPx,
        tileXGuardPhysicalPx: xCrop.guardPhysicalPx,
        tileStoredPhysicalWidthPx: xCrop.storedPhysicalWidthPx,
        residentTexturePixelBudget: trackTexturePixelBudget,
        committedTrackPhysicalHeightPx: crop.physicalScissorHeightPx,
      })
    );
  }
  return Object.freeze({
    formula: BOUNDED_ANNOTATION_PHYSICAL_BUDGET_V2,
    authority: BOUNDED_ANNOTATION_PLANNING_AUTHORITY_V2,
    viewportPhysicalWidthPx,
    committedVisibleBroadTrackCount: trackIds.size,
    trackBudgets: Object.freeze(trackBudgets),
    visibleSpriteBudget,
    residentTexturePixelBudget,
    committedTrackPhysicalHeightPx,
    fragmentPixelBudget,
    broadVectorInstanceBudget: 0,
    durableWriteBudget: 0,
  });
}

export function deriveBroadSurfacePresentationPlanV2(input: {
  manifest: CompiledBroadSurfaceManifestV2;
  isoformMode: BroadSurfaceIsoformModeV2;
  laneLimit: number | null;
  viewportStartBp: number;
  viewportEndBp: number;
  viewportCssWidthPx: number;
  devicePixelRatio: number;
}): BroadSurfacePlanResultV2 {
  validateManifest(input.manifest);
  const isoformMode = mode(input.isoformMode);
  const laneLimit = laneLimitValue(input.laneLimit);
  const viewportCssWidthPx = positiveFinite(input.viewportCssWidthPx, 'viewportCssWidthPx');
  const devicePixelRatio = positiveFinite(input.devicePixelRatio, 'devicePixelRatio');
  const viewportPhysicalWidthPx = viewportCssWidthPx * devicePixelRatio;
  const viewport = validatedViewport(input.manifest, input.viewportStartBp, input.viewportEndBp);
  if (devicePixelRatio > input.manifest.rasterDevicePixelRatio) {
    return Object.freeze({
      status: 'broad-artifact-required',
      reason: 'insufficient-raster-device-pixel-ratio',
      manifestFingerprint: input.manifest.manifestFingerprint,
      artifactKey: input.manifest.artifactKey,
      trackId: input.manifest.trackId,
      isoformMode,
      laneLimit,
      viewportStartBp: viewport.startBp,
      viewportEndBp: viewport.endBp,
      manifestRasterDevicePixelRatio: input.manifest.rasterDevicePixelRatio,
      requestedRasterDevicePixelRatio: devicePixelRatio,
    });
  }
  const desiredNativeTileSpanBp =
    viewport.spanBp * (input.manifest.broadTilePhysicalWidthPx / viewportPhysicalWidthPx);
  const mipSelection = deriveBroadSurfaceMipSelectionV2({
    manifest: input.manifest,
    viewportStartBp: viewport.startBp,
    viewportEndBp: viewport.endBp,
    viewportPhysicalWidthPx,
  });
  if (!mipSelection) {
    return Object.freeze({
      status: 'detail-required',
      reason: 'below-broad-corridor-finest-span',
      manifestFingerprint: input.manifest.manifestFingerprint,
      artifactKey: input.manifest.artifactKey,
      trackId: input.manifest.trackId,
      isoformMode,
      laneLimit,
      viewportStartBp: viewport.startBp,
      viewportEndBp: viewport.endBp,
      desiredNativeTileSpanBp,
      broadCorridorFinestSpanBp: input.manifest.broadCorridorFinestSpanBp,
    });
  }
  const laneCrop = exactLaneSlabCropV2({
    manifest: input.manifest,
    isoformMode,
    laneLimit,
    devicePixelRatio,
  });
  const xCrop = exactBroadSurfaceXCropV2(input.manifest);
  const activeVisibleXTileIds = Object.freeze(
    mipSelection.activeLevels.flatMap((activeLevel) => activeLevel.visibleXTileIds)
  );
  const activeResidentXTileIds = Object.freeze(
    mipSelection.activeLevels.flatMap((activeLevel) => activeLevel.residentXTileIds)
  );
  const visibleTilePlacements = Object.freeze(
    mipSelection.activeLevels.flatMap((activeLevel) => activeLevel.visibleTilePlacements)
  );
  const activeSubmittedSurfaceCellIds = Object.freeze(
    visibleTilePlacements.flatMap((placement) =>
      laneCrop.submittedLaneSlabIds.map((_slabId, laneSlabIndex) =>
        compiledBroadSurfaceCellIdV2({
          manifest: input.manifest,
          isoformMode,
          level: placement.level,
          tileX: placement.tileX,
          laneSlabIndex,
        })
      )
    )
  );
  const primaryLevel = mipSelection.activeLevels[0];
  const submittedSurfaceCellIds = Object.freeze(
    primaryLevel.visibleTilePlacements.flatMap((placement) =>
      laneCrop.submittedLaneSlabIds.map((_slabId, laneSlabIndex) =>
        compiledBroadSurfaceCellIdV2({
          manifest: input.manifest,
          isoformMode,
          level: placement.level,
          tileX: placement.tileX,
          laneSlabIndex,
        })
      )
    )
  );
  const physicalBudget = deriveBoundedAnnotationPhysicalBudgetV2({
    viewportCssWidthPx,
    devicePixelRatio,
    committedVisibleBroadTracks: [
      {
        trackId: input.manifest.trackId,
        manifest: input.manifest,
        isoformMode,
        laneLimit,
        viewportStartBp: viewport.startBp,
        viewportEndBp: viewport.endBp,
      },
    ],
  });
  const plan: BroadSurfacePresentationPlanV2 = Object.freeze({
    status: 'broad-ready',
    manifestFingerprint: input.manifest.manifestFingerprint,
    artifactKey: input.manifest.artifactKey,
    trackId: input.manifest.trackId,
    isoformMode,
    laneLimit,
    viewportStartBp: viewport.startBp,
    viewportEndBp: viewport.endBp,
    ordinaryPresentationKind: 'compiled-broad-surface-2d',
    desiredNativeTileSpanBp,
    nativeLevelPosition: mipSelection.nativeLevelPosition,
    finerLevel: mipSelection.finerLevel,
    coarserLevel: mipSelection.coarserLevel,
    lodMix: mipSelection.lodMix,
    activeLevels: mipSelection.activeLevels,
    activeVisibleXTileIds,
    activeResidentXTileIds,
    activeSubmittedSurfaceCellIds,
    selectedLevel: primaryLevel.level,
    selectedTileSpanBp: primaryLevel.tileSpanBp,
    projectedTilePhysicalWidthPx: primaryLevel.projectedTilePhysicalWidthPx,
    visibleXTileIds: primaryLevel.visibleXTileIds,
    residentXTileIds: primaryLevel.residentXTileIds,
    visibleTilePlacements,
    submittedLaneSlabIds: laneCrop.submittedLaneSlabIds,
    submittedSurfaceCellIds,
    xCrop,
    laneCrop,
    physicalBudget,
  });
  ADMITTED_BROAD_SURFACE_PRESENTATION_PLANS_V2.add(plan);
  return plan;
}

export function classifyBroadSurfaceObservationV2(
  plan: BroadSurfacePresentationPlanV2,
  observed: BroadSurfaceObservationV2
): { readonly status: 'pass' | 'red'; readonly failures: readonly string[] } {
  const failures: string[] = [];
  if (
    observed?.trackId !== plan.trackId ||
    observed?.artifactKey !== plan.artifactKey ||
    observed?.manifestFingerprint !== plan.manifestFingerprint ||
    observed?.isoformMode !== plan.isoformMode ||
    observed?.laneLimit !== plan.laneLimit
  ) {
    failures.push('presentation-owner-mismatch');
  }
  if (observed?.selectedLevel !== plan.selectedLevel) {
    failures.push('selected-pyramid-level-mismatch');
  }
  if (
    observed?.nativeLevelPosition !== plan.nativeLevelPosition ||
    observed?.lodMix !== plan.lodMix ||
    !sameStrings(
      observed?.activeLevelIds,
      plan.activeLevels.map((active) => `${active.role}:L${active.level}`)
    ) ||
    !sameNumbers(
      observed?.activeLevelSampleWeights,
      plan.activeLevels.map((active) => active.sampleWeight)
    ) ||
    !sameStrings(observed?.activeVisibleXTileIds, plan.activeVisibleXTileIds) ||
    !sameStrings(observed?.activeResidentXTileIds, plan.activeResidentXTileIds) ||
    !sameStrings(observed?.activeSubmittedSurfaceCellIds, plan.activeSubmittedSurfaceCellIds)
  ) {
    failures.push('adjacent-mip-selection-mismatch');
  }
  if (!sameStrings(observed?.visibleXTileIds, plan.visibleXTileIds)) {
    failures.push('visible-x-tile-set-mismatch');
  }
  if (!sameStrings(observed?.residentXTileIds, plan.residentXTileIds)) {
    failures.push('resident-x-tile-set-mismatch');
  }
  if (!sameTilePlacements(observed?.visibleTilePlacements, plan.visibleTilePlacements)) {
    failures.push('nominal-tile-placement-mismatch');
  }
  if (!sameStrings(observed?.submittedLaneSlabIds, plan.submittedLaneSlabIds)) {
    failures.push('submitted-lane-slab-set-mismatch');
  }
  if (!sameStrings(observed?.submittedSurfaceCellIds, plan.submittedSurfaceCellIds)) {
    failures.push('submitted-surface-cell-set-mismatch');
  }
  if (
    observed?.tileContentPhysicalWidthPx !== plan.xCrop.contentPhysicalWidthPx ||
    observed?.tileXGuardPhysicalPx !== plan.xCrop.guardPhysicalPx ||
    observed?.tileStoredPhysicalWidthPx !== plan.xCrop.storedPhysicalWidthPx ||
    observed?.textureContentUStart !== plan.xCrop.textureContentUStart ||
    observed?.textureContentUEndExclusive !== plan.xCrop.textureContentUEndExclusive ||
    observed?.textureSampleUMinInclusive !== plan.xCrop.textureSampleUMinInclusive ||
    observed?.textureSampleUMaxInclusive !== plan.xCrop.textureSampleUMaxInclusive
  ) {
    failures.push('x-guard-crop-mismatch');
  }
  if (
    observed?.finalSlabTextureEndRowExclusivePx !==
      plan.laneCrop.finalSlabTextureEndRowExclusivePx ||
    observed?.finalSlabTextureVEndExclusive !== plan.laneCrop.finalSlabTextureVEndExclusive ||
    observed?.finalSlabTextureSampleVMaxInclusive !==
      plan.laneCrop.finalSlabTextureSampleVMaxInclusive ||
    observed?.physicalScissorHeightPx !== plan.laneCrop.physicalScissorHeightPx
  ) {
    failures.push('lane-slab-crop-mismatch');
  }
  if (
    !nonnegativeFiniteValue(observed?.submittedSpriteHighWater) ||
    observed.submittedSpriteHighWater > plan.physicalBudget.visibleSpriteBudget
  ) {
    failures.push('submitted-sprite-high-water-overflow');
  }
  if (
    !nonnegativeFiniteValue(observed?.residentTexturePixelHighWater) ||
    observed.residentTexturePixelHighWater > plan.physicalBudget.residentTexturePixelBudget
  ) {
    failures.push('resident-texture-pixel-high-water-overflow');
  }
  if (
    !nonnegativeFiniteValue(observed?.fragmentPixelHighWater) ||
    observed.fragmentPixelHighWater > plan.physicalBudget.fragmentPixelBudget
  ) {
    failures.push('fragment-pixel-high-water-overflow');
  }
  if (observed?.broadVectorInstanceHighWater !== plan.physicalBudget.broadVectorInstanceBudget) {
    failures.push('broad-vector-instance-budget-violated');
  }
  if (observed?.durableWriteHighWater !== plan.physicalBudget.durableWriteBudget) {
    failures.push('durable-write-budget-violated');
  }
  return Object.freeze({
    status: failures.length === 0 ? 'pass' : 'red',
    failures: Object.freeze([...new Set(failures)]),
  });
}

function buildFinestFirstLevels(
  genomeLengthBp: number,
  broadCorridorFinestSpanBp: number
): readonly CompiledBroadSurfaceLevelV2[] {
  const levels: CompiledBroadSurfaceLevelV2[] = [];
  let level = 0;
  let tileSpanBp = broadCorridorFinestSpanBp;
  for (;;) {
    const tileCount = Math.ceil(genomeLengthBp / tileSpanBp);
    levels.push(Object.freeze({ level, tileSpanBp, tileCount }));
    if (tileCount === 1) break;
    if (tileSpanBp > Number.MAX_SAFE_INTEGER / 2) {
      throw new Error('compiled broad surface pyramid exceeds safe range');
    }
    level += 1;
    tileSpanBp *= 2;
  }
  return Object.freeze(levels);
}

function admitFinestFirstLevels(
  value: unknown,
  genomeLengthBp: number,
  broadCorridorFinestSpanBp: number
): readonly CompiledBroadSurfaceLevelV2[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('compiled broad surface pyramid is invalid');
  }
  const levels = Object.freeze(
    value.map((entry, index) => {
      const raw = exactRecord(entry, LEVEL_KEYS, 'compiled broad surface level');
      const level = Object.freeze({
        level: nonnegativeSafeInteger(raw.level, 'level'),
        tileSpanBp: positiveSafeInteger(raw.tileSpanBp, 'tileSpanBp'),
        tileCount: positiveSafeInteger(raw.tileCount, 'tileCount'),
      });
      if (
        level.level !== index ||
        level.tileSpanBp !== broadCorridorFinestSpanBp * 2 ** index ||
        level.tileCount !== Math.ceil(genomeLengthBp / level.tileSpanBp)
      ) {
        throw new Error('compiled broad surface finest-first pyramid is invalid');
      }
      return level;
    })
  );
  if (levels[levels.length - 1]?.tileCount !== 1) {
    throw new Error('compiled broad surface pyramid root is invalid');
  }
  return levels;
}

function buildLaneSlabRoster(
  isoformMode: BroadSurfaceIsoformModeV2,
  laneRowCount: number,
  laneSlabRowCount: number
): readonly CompiledBroadSurfaceLaneSlabV2[] {
  return Object.freeze(
    Array.from({ length: Math.ceil(laneRowCount / laneSlabRowCount) }, (_, slabIndex) => {
      const firstLaneRow = slabIndex * laneSlabRowCount;
      const sourceLaneRowCount = Math.min(laneSlabRowCount, laneRowCount - firstLaneRow);
      return Object.freeze({
        slabId: `${isoformMode}:slab:${slabIndex}`,
        slabIndex,
        firstLaneRow,
        sourceLaneRowCount,
        paddedLaneRowCount: laneSlabRowCount - sourceLaneRowCount,
      });
    })
  );
}

function admitLaneSlabRoster(
  value: unknown,
  isoformMode: BroadSurfaceIsoformModeV2,
  laneRowCount: number,
  laneSlabRowCount: number
): readonly CompiledBroadSurfaceLaneSlabV2[] {
  if (!Array.isArray(value)) {
    throw new Error('compiled broad surface lane slab roster is invalid');
  }
  const expected = buildLaneSlabRoster(isoformMode, laneRowCount, laneSlabRowCount);
  if (value.length !== expected.length) {
    throw new Error('compiled broad surface lane slab roster is incomplete');
  }
  return Object.freeze(
    value.map((entry, index) => {
      const raw = exactRecord(entry, SLAB_KEYS, 'compiled broad surface lane slab');
      const slab = Object.freeze({
        slabId: token(raw.slabId, 'slabId'),
        slabIndex: nonnegativeSafeInteger(raw.slabIndex, 'slabIndex'),
        firstLaneRow: nonnegativeSafeInteger(raw.firstLaneRow, 'firstLaneRow'),
        sourceLaneRowCount: positiveSafeInteger(raw.sourceLaneRowCount, 'sourceLaneRowCount'),
        paddedLaneRowCount: nonnegativeSafeInteger(raw.paddedLaneRowCount, 'paddedLaneRowCount'),
      });
      if (!sameSlab(slab, expected[index])) {
        throw new Error('compiled broad surface lane slab roster is invalid');
      }
      return slab;
    })
  );
}

function sameSlab(
  left: CompiledBroadSurfaceLaneSlabV2,
  right: CompiledBroadSurfaceLaneSlabV2
): boolean {
  return (
    left.slabId === right.slabId &&
    left.slabIndex === right.slabIndex &&
    left.firstLaneRow === right.firstLaneRow &&
    left.sourceLaneRowCount === right.sourceLaneRowCount &&
    left.paddedLaneRowCount === right.paddedLaneRowCount
  );
}

export function deriveBroadSurfaceMipSelectionV2(input: {
  manifest: CompiledBroadSurfaceManifestV2;
  viewportStartBp: number;
  viewportEndBp: number;
  viewportPhysicalWidthPx: number;
}): BroadSurfaceMipSelectionV2 | null {
  validateManifest(input.manifest);
  const viewport = validatedViewport(input.manifest, input.viewportStartBp, input.viewportEndBp);
  const viewportPhysicalWidthPx = positiveFinite(
    input.viewportPhysicalWidthPx,
    'viewportPhysicalWidthPx'
  );
  const nativeLevelPosition = broadSurfaceNativeLevelPositionV2({
    manifest: input.manifest,
    viewportSpanBp: viewport.spanBp,
    viewportPhysicalWidthPx,
  });
  if (nativeLevelPosition === null) return null;
  const maximumLevel = input.manifest.levels.length - 1;
  const nearestLevel = Math.round(nativeLevelPosition);
  if (broadSurfaceMipRoleV2(nativeLevelPosition) === 'single') {
    const level = input.manifest.levels[Math.min(nearestLevel, maximumLevel)];
    const active = activeLevelPlan(
      input.manifest,
      level,
      'single',
      1,
      viewport,
      viewportPhysicalWidthPx
    );
    return Object.freeze({
      nativeLevelPosition: level.level,
      finerLevel: level.level,
      coarserLevel: null,
      lodMix: 0,
      activeLevels: Object.freeze([active]),
    });
  }

  const finerLevel = Math.floor(nativeLevelPosition);
  const coarserLevel = finerLevel + 1;
  const lodMix = broadSurfaceLodMixV2(input.manifest, nativeLevelPosition);
  const finer = activeLevelPlan(
    input.manifest,
    input.manifest.levels[finerLevel],
    'finer',
    lodMix === 0 ? 1 : 1 - lodMix,
    viewport,
    viewportPhysicalWidthPx
  );
  const activeLevels: BroadSurfaceActiveLevelPlanV2[] = [finer];
  if (lodMix > 0) {
    const coarser = activeLevelPlan(
      input.manifest,
      input.manifest.levels[coarserLevel],
      'coarser',
      lodMix,
      viewport,
      viewportPhysicalWidthPx
    );
    if (coarser.rasterMagnificationX >= BROAD_SURFACE_MAX_RASTER_MAGNIFICATION_X_EXCLUSIVE_V2) {
      throw new Error('broad surface coarser mip exceeds the strict magnification bound');
    }
    if (
      coarser.rasterMagnificationX > input.manifest.maxQualifiedRasterMagnificationX &&
      !nearlyEqual(coarser.rasterMagnificationX, input.manifest.maxQualifiedRasterMagnificationX)
    ) {
      throw new Error('broad surface coarser mip exceeds qualified magnification');
    }
    activeLevels.push(coarser);
  }
  return Object.freeze({
    nativeLevelPosition,
    finerLevel,
    coarserLevel,
    lodMix,
    activeLevels: Object.freeze(activeLevels),
  });
}

export function broadSurfaceNativeLevelPositionV2(input: {
  readonly manifest: CompiledBroadSurfaceManifestV2;
  readonly viewportSpanBp: number;
  readonly viewportPhysicalWidthPx: number;
}): number | null {
  validateManifest(input.manifest);
  const viewportSpanBp = positiveFinite(input.viewportSpanBp, 'viewportSpanBp');
  const viewportPhysicalWidthPx = positiveFinite(
    input.viewportPhysicalWidthPx,
    'viewportPhysicalWidthPx'
  );
  const desiredNativeTileSpanBp =
    viewportSpanBp * (input.manifest.broadTilePhysicalWidthPx / viewportPhysicalWidthPx);
  const finestSpanBp = input.manifest.broadCorridorFinestSpanBp;
  if (
    desiredNativeTileSpanBp < finestSpanBp &&
    !nearlyEqual(desiredNativeTileSpanBp, finestSpanBp)
  ) {
    return null;
  }
  return clamp(
    Math.log2(Math.max(desiredNativeTileSpanBp, finestSpanBp) / finestSpanBp),
    0,
    input.manifest.levels.length - 1
  );
}

export function broadSurfaceMipRoleV2(nativeLevelPosition: number): 'single' | 'finer' {
  return nearlyEqual(nativeLevelPosition, Math.round(nativeLevelPosition)) ? 'single' : 'finer';
}

export function broadSurfaceLodMixV2(
  manifest: CompiledBroadSurfaceManifestV2,
  nativeLevelPosition: number
): number {
  validateManifest(manifest);
  const position = nonnegativeFinite(nativeLevelPosition, 'nativeLevelPosition');
  if (broadSurfaceMipRoleV2(position) === 'single') return 0;
  const fraction = position - Math.floor(position);
  const blendStartFraction = 1 - Math.log2(manifest.maxQualifiedRasterMagnificationX);
  return smoothstep01(clamp((fraction - blendStartFraction) / (1 - blendStartFraction), 0, 1));
}

function activeLevelPlan(
  manifest: CompiledBroadSurfaceManifestV2,
  level: CompiledBroadSurfaceLevelV2,
  role: BroadSurfaceMipRoleV2,
  sampleWeight: number,
  viewport: { readonly startBp: number; readonly endBp: number; readonly spanBp: number },
  viewportPhysicalWidthPx: number
): BroadSurfaceActiveLevelPlanV2 {
  const roster = xTileRoster(manifest, level, viewport.startBp, viewport.endBp);
  const projectedTilePhysicalWidthPx =
    (level.tileSpanBp / viewport.spanBp) * viewportPhysicalWidthPx;
  return Object.freeze({
    role,
    level: level.level,
    tileSpanBp: level.tileSpanBp,
    sampleWeight,
    projectedTilePhysicalWidthPx,
    rasterMagnificationX: projectedTilePhysicalWidthPx / manifest.broadTilePhysicalWidthPx,
    visibleXTileIds: roster.visible,
    residentXTileIds: roster.resident,
    visibleTilePlacements: Object.freeze(
      roster.visibleTileXs.map((tileX) =>
        exactBroadSurfaceTilePlacementV2({ manifest, level: level.level, tileX })
      )
    ),
  });
}

function xTileRoster(
  manifest: CompiledBroadSurfaceManifestV2,
  selected: CompiledBroadSurfaceLevelV2,
  viewportStartBp: number,
  viewportEndBp: number
): {
  readonly visible: readonly string[];
  readonly resident: readonly string[];
  readonly visibleTileXs: readonly number[];
  readonly residentTileXs: readonly number[];
} {
  const firstVisible = clamp(
    Math.floor(viewportStartBp / selected.tileSpanBp),
    0,
    selected.tileCount - 1
  );
  const lastVisible = clamp(
    Math.ceil(viewportEndBp / selected.tileSpanBp) - 1,
    firstVisible,
    selected.tileCount - 1
  );
  const firstSubmitted = Math.max(0, firstVisible - manifest.prefetchRing);
  const lastSubmitted = Math.min(selected.tileCount - 1, lastVisible + manifest.prefetchRing);
  const tileXs = (first: number, last: number) =>
    Object.freeze(Array.from({ length: last - first + 1 }, (_, offset) => first + offset));
  const visibleTileXs = tileXs(firstVisible, lastVisible);
  const residentTileXs = tileXs(firstSubmitted, lastSubmitted);
  return Object.freeze({
    visible: Object.freeze(visibleTileXs.map((tileX) => xTileId(selected.level, tileX))),
    resident: Object.freeze(residentTileXs.map((tileX) => xTileId(selected.level, tileX))),
    visibleTileXs,
    residentTileXs,
  });
}

function xTileId(level: number, tileX: number): string {
  return `L${level}:X${tileX}`;
}

function validatedViewport(
  manifest: CompiledBroadSurfaceManifestV2,
  start: unknown,
  end: unknown
): { readonly startBp: number; readonly endBp: number; readonly spanBp: number } {
  const startBp = nonnegativeFinite(start, 'viewportStartBp');
  const endBp = positiveFinite(end, 'viewportEndBp');
  if (endBp <= startBp || endBp > manifest.genomeLengthBp) {
    throw new Error('broad surface viewport is outside the genome');
  }
  return Object.freeze({ startBp, endBp, spanBp: endBp - startBp });
}

function validateManifest(value: CompiledBroadSurfaceManifestV2): void {
  if (
    value?.contract !== COMPILED_BROAD_SURFACE_MANIFEST_V2 ||
    value.levelOrderingContract !== BROAD_SURFACE_LEVEL_ORDER_FINEST_FIRST_V1 ||
    value.pyramidSelectionContract !== BROAD_SURFACE_NATIVE_DYADIC_SELECTION_V1 ||
    value.mipBlendContract !== BROAD_SURFACE_ADJACENT_MIP_BLEND_V1 ||
    value.textureSamplingContract !== BROAD_SURFACE_GUTTERED_ROW_AND_X_SAMPLING_V2 ||
    !VERIFIED_MANIFESTS.has(value) ||
    !Object.isFrozen(value) ||
    !Object.isFrozen(value.levels) ||
    !Object.isFrozen(value.laneSlabs) ||
    !Object.isFrozen(value.laneSlabs.canonical) ||
    !Object.isFrozen(value.laneSlabs.expanded) ||
    !isQualifiedRasterMagnification(value.maxQualifiedRasterMagnificationX) ||
    !validSha256(value.manifestFingerprint)
  ) {
    throw new Error('compiled broad surface manifest is invalid');
  }
}

function assertPinnedBroadSurfaceGeometry(value: {
  broadTilePhysicalWidthPx: number;
  broadTileXGuardPhysicalPx: number;
  prefetchRing: number;
  rasterDevicePixelRatio: number;
  laneSlabRowCount: number;
  laneRowCssHeightPx: number;
  laneRowTextureStridePx: number;
  laneRowTransparentTailGutterPx: number;
}): void {
  const supportedRasterScale = BROAD_SURFACE_SUPPORTED_RASTER_DEVICE_PIXEL_RATIOS_V2.some(
    (candidate) => candidate === value.rasterDevicePixelRatio
  );
  if (
    value.broadTilePhysicalWidthPx !== BROAD_SURFACE_TILE_CONTENT_WIDTH_PX_V2 ||
    value.broadTileXGuardPhysicalPx !== BROAD_SURFACE_X_FILTER_GUARD_PX_V2 ||
    value.prefetchRing !== BROAD_SURFACE_PREFETCH_RING_V2 ||
    !supportedRasterScale ||
    value.laneSlabRowCount !== BROAD_SURFACE_LANE_SLAB_ROW_COUNT_V2 ||
    value.laneRowCssHeightPx !== BROAD_SURFACE_LANE_ROW_CSS_HEIGHT_PX_V2 ||
    value.laneRowTextureStridePx !== value.laneRowCssHeightPx * value.rasterDevicePixelRatio ||
    value.laneRowTransparentTailGutterPx !==
      BROAD_SURFACE_LANE_ROW_TRANSPARENT_TAIL_GUTTER_CSS_PX_V2 * value.rasterDevicePixelRatio
  ) {
    throw new Error('compiled broad surface pinned physical geometry is invalid');
  }
}

function rasterVariantFamilyMaterial(value: CompiledBroadSurfaceManifestV2): string {
  return frame([
    value.contract,
    value.levelOrderingContract,
    value.pyramidSelectionContract,
    value.mipBlendContract,
    value.textureSamplingContract,
    value.artifactKey,
    value.trackId,
    String(value.genomeLengthBp),
    String(value.broadCorridorFinestSpanBp),
    String(value.broadTilePhysicalWidthPx),
    String(value.broadTileXGuardPhysicalPx),
    String(value.prefetchRing),
    String(value.maxQualifiedRasterMagnificationX),
    String(value.laneSlabRowCount),
    String(value.laneRowCssHeightPx),
    String(value.laneRowCounts.canonical),
    String(value.laneRowCounts.expanded),
    ...(['canonical', 'expanded'] as const).flatMap((isoformMode) =>
      value.laneSlabs[isoformMode].flatMap((slab) => [
        slab.slabId,
        String(slab.slabIndex),
        String(slab.firstLaneRow),
        String(slab.sourceLaneRowCount),
        String(slab.paddedLaneRowCount),
      ])
    ),
    ...value.levels.flatMap((level) => [
      String(level.level),
      String(level.tileSpanBp),
      String(level.tileCount),
    ]),
  ]);
}

function manifestContractMaterial(value: {
  artifactKey: string;
  trackId: string;
  genomeLengthBp: number;
  broadCorridorFinestSpanBp: number;
  broadTilePhysicalWidthPx: number;
  broadTileXGuardPhysicalPx: number;
  prefetchRing: number;
  maxQualifiedRasterMagnificationX: number;
  rasterDevicePixelRatio: number;
  laneSlabRowCount: number;
  laneRowCssHeightPx: number;
  laneRowTextureStridePx: number;
  laneRowTransparentTailGutterPx: number;
  laneRowCounts: Readonly<Record<BroadSurfaceIsoformModeV2, number>>;
  laneSlabs: Readonly<Record<BroadSurfaceIsoformModeV2, readonly CompiledBroadSurfaceLaneSlabV2[]>>;
  levels: readonly CompiledBroadSurfaceLevelV2[];
}): string {
  return frame([
    COMPILED_BROAD_SURFACE_MANIFEST_V2,
    BROAD_SURFACE_LEVEL_ORDER_FINEST_FIRST_V1,
    BROAD_SURFACE_NATIVE_DYADIC_SELECTION_V1,
    BROAD_SURFACE_ADJACENT_MIP_BLEND_V1,
    BROAD_SURFACE_GUTTERED_ROW_AND_X_SAMPLING_V2,
    value.artifactKey,
    value.trackId,
    String(value.genomeLengthBp),
    String(value.broadCorridorFinestSpanBp),
    String(value.broadTilePhysicalWidthPx),
    String(value.broadTileXGuardPhysicalPx),
    String(value.prefetchRing),
    String(value.maxQualifiedRasterMagnificationX),
    String(value.rasterDevicePixelRatio),
    String(value.laneSlabRowCount),
    String(value.laneRowCssHeightPx),
    String(value.laneRowTextureStridePx),
    String(value.laneRowTransparentTailGutterPx),
    String(value.laneRowCounts.canonical),
    String(value.laneRowCounts.expanded),
    ...(['canonical', 'expanded'] as const).flatMap((isoformMode) =>
      value.laneSlabs[isoformMode].flatMap((slab) => [
        slab.slabId,
        String(slab.slabIndex),
        String(slab.firstLaneRow),
        String(slab.sourceLaneRowCount),
        String(slab.paddedLaneRowCount),
      ])
    ),
    ...value.levels.flatMap((level) => [
      String(level.level),
      String(level.tileSpanBp),
      String(level.tileCount),
    ]),
  ]);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('compiled broad surface SHA-256 is unavailable');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function mode(value: unknown): BroadSurfaceIsoformModeV2 {
  if (value !== 'canonical' && value !== 'expanded') {
    throw new Error('broad surface isoformMode is invalid');
  }
  return value;
}

function laneLimitValue(value: unknown): number | null {
  if (value === null) return null;
  return positiveSafeInteger(value, 'laneLimit');
}

function sameStrings(left: unknown, right: readonly string[]): boolean {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameNumbers(left: unknown, right: readonly number[]): boolean {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameTilePlacements(
  left: unknown,
  right: readonly ExactBroadSurfaceTilePlacementV2[]
): boolean {
  if (!Array.isArray(left) || left.length !== right.length) return false;
  return left.every((candidate, index) => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      return false;
    }
    const value = candidate as Record<string, unknown>;
    const expected = right[index];
    return (
      value.tileId === expected.tileId &&
      value.level === expected.level &&
      value.tileX === expected.tileX &&
      value.nominalStartBp === expected.nominalStartBp &&
      value.nominalEndBpExclusive === expected.nominalEndBpExclusive &&
      value.nominalSpanBp === expected.nominalSpanBp &&
      value.sourceStartBp === expected.sourceStartBp &&
      value.sourceEndBpExclusive === expected.sourceEndBpExclusive &&
      value.sourceSpanBp === expected.sourceSpanBp &&
      value.destinationStartBp === expected.destinationStartBp &&
      value.destinationEndBpExclusive === expected.destinationEndBpExclusive &&
      value.destinationSpanBp === expected.destinationSpanBp &&
      value.isAssemblyTerminalTile === expected.isAssemblyTerminalTile
    );
  });
}

function token(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`broad surface ${label} is required`);
  }
  return value.trim();
}

function exactRecord(
  value: unknown,
  exactKeys: readonly string[],
  label: string
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== exactKeys.length || keys.some((key) => !exactKeys.includes(key))) {
    throw new Error(`${label} shape is invalid`);
  }
  return record;
}

function validSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function sha256(value: unknown, label: string): string {
  if (!validSha256(value)) {
    throw new Error(`broad surface ${label} must be a lowercase SHA-256`);
  }
  return value;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`broad surface ${label} must be a positive safe integer`);
  }
  return value as number;
}

function nonnegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`broad surface ${label} must be a nonnegative safe integer`);
  }
  return value as number;
}

function positiveFinite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`broad surface ${label} must be positive and finite`);
  }
  return value;
}

function isQualifiedRasterMagnification(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 1 &&
    value < BROAD_SURFACE_MAX_RASTER_MAGNIFICATION_X_EXCLUSIVE_V2
  );
}

function qualifiedRasterMagnification(value: unknown): number {
  if (!isQualifiedRasterMagnification(value)) {
    throw new Error(
      'broad surface qualified raster magnification must be greater than 1 and less than 2'
    );
  }
  return value;
}

function nonnegativeFinite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`broad surface ${label} must be nonnegative and finite`);
  }
  return value;
}

function nonnegativeFiniteValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function smoothstep01(value: number): number {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function nearlyEqual(left: number, right: number): boolean {
  return (
    Math.abs(left - right) <= Number.EPSILON * 16 * Math.max(1, Math.abs(left), Math.abs(right))
  );
}

function frame(parts: readonly string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join('');
}
