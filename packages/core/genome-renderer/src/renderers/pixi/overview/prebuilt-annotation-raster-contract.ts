import type { WebGLThemeMode } from '../shared/theme';
import type { AnnotationSourcePlacementProvenanceV1 } from '../../../types';
import type { AnnotationPolicyGpuRuntimeV1 } from './annotation-policy-gpu-instances-v1';
import {
  PREPACKED_ANNOTATION_BAR_HEIGHT_PX,
  PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
  PREPACKED_ANNOTATION_LANE_STEP_PX,
  PREPACKED_ANNOTATION_LANE_TOKEN,
  PREPACKED_ANNOTATION_MAPPER_TOKEN,
} from './prepacked-annotation-scene';

export const PREBUILT_ANNOTATION_RASTER_PRESENTATION_V1 =
  'prebuilt-annotation-raster-presentation.v1' as const;
export const PREBUILT_ANNOTATION_RASTER_SOURCE_PLACEMENT_V1 =
  'validated-annotation-source-placement.v1' as const;
export const PREBUILT_ANNOTATION_RASTER_LANE_ARTIFACT_V1 = 'lane-complete-artifact.v1' as const;
export const PREBUILT_ANNOTATION_RASTERIZER_V1 =
  'prebuilt-annotation-rasterizer.track-local.v1' as const;
export const PREBUILT_ANNOTATION_RASTER_LANE_PROJECTION_V1 =
  'prebuilt-annotation-raster-lane-projection.v1' as const;

export interface PrebuiltAnnotationRasterPresentationReceiptV1 {
  readonly contract: typeof PREBUILT_ANNOTATION_RASTER_PRESENTATION_V1;
  readonly artifactKey: string;
  readonly sourceValidationContract: typeof PREBUILT_ANNOTATION_RASTER_SOURCE_PLACEMENT_V1;
  readonly genomeIdentity: string;
  readonly genomeLengthBp: number;
  readonly sourceFingerprint: string;
  readonly placementFingerprint: string;
  readonly trackType: 'mRNA';
  readonly isoformMode: AnnotationPolicyGpuRuntimeV1['isoformMode'];
  readonly laneLimit: number | null;
  readonly layerTypes: readonly string[];
  readonly maxAnnotationLane: number;
  readonly maxCdsLane: number;
  readonly themeMode: WebGLThemeMode;
  readonly laneArtifactContract: typeof PREBUILT_ANNOTATION_RASTER_LANE_ARTIFACT_V1;
  readonly annotationBarHeightPx: typeof PREPACKED_ANNOTATION_BAR_HEIGHT_PX;
  readonly laneStepPx: typeof PREPACKED_ANNOTATION_LANE_STEP_PX;
  readonly laneAlgorithmToken: typeof PREPACKED_ANNOTATION_LANE_TOKEN;
  readonly mapperContractToken: typeof PREPACKED_ANNOTATION_MAPPER_TOKEN;
  readonly geometryContractToken: typeof PREPACKED_ANNOTATION_GEOMETRY_TOKEN;
  readonly rasterizerContractToken: typeof PREBUILT_ANNOTATION_RASTERIZER_V1;
}

export type PrebuiltAnnotationRasterPresentationIdentityV1 = Omit<
  PrebuiltAnnotationRasterPresentationReceiptV1,
  'artifactKey'
>;

export interface PrebuiltAnnotationRasterLaneProjectionV1 {
  readonly contract: typeof PREBUILT_ANNOTATION_RASTER_LANE_PROJECTION_V1;
  readonly laneLimit: number | null;
  readonly sourceHeightPx: number;
  readonly sourceSpineOffsetPx: number;
  readonly sourceMaxAnnotationLane: number;
  readonly presentedHeightPx: number;
  readonly presentedSpineOffsetPx: number;
}

export interface ActiveAnnotationRasterPresentationContract {
  readonly genomeIdentity: string;
  readonly genomeLengthBp: number;
  readonly sourceFingerprint: string | null;
  readonly placementFingerprint: string | null;
  readonly runtimePolicy: AnnotationPolicyGpuRuntimeV1 | null;
  readonly layerTypes: readonly string[];
  readonly maxAnnotationLane: number;
  readonly maxCdsLane: number;
  readonly themeMode: WebGLThemeMode;
}

export interface PrebuiltAnnotationRasterContractMatch {
  readonly contractMatch: boolean;
  readonly sourceMatch: boolean;
  readonly placementMatch: boolean;
  readonly artifactLayerTypes: readonly string[];
  readonly artifactSourceFingerprint: string | null;
  readonly artifactPlacementFingerprint: string | null;
}

export function matchPrebuiltAnnotationRasterPresentation(
  receipt: unknown,
  active: ActiveAnnotationRasterPresentationContract,
  laneProjection: unknown = null
): PrebuiltAnnotationRasterContractMatch {
  if (!isPrebuiltAnnotationRasterPresentationReceiptV1(receipt)) {
    return {
      contractMatch: false,
      sourceMatch: false,
      placementMatch: false,
      artifactLayerTypes: [],
      artifactSourceFingerprint: null,
      artifactPlacementFingerprint: null,
    };
  }
  const sourceMatch =
    receipt.genomeIdentity === active.genomeIdentity &&
    receipt.genomeLengthBp === active.genomeLengthBp &&
    isSourceFingerprint(active.sourceFingerprint) &&
    receipt.sourceFingerprint === active.sourceFingerprint;
  const placementMatch =
    isPlacementFingerprint(active.placementFingerprint) &&
    receipt.placementFingerprint === active.placementFingerprint;
  const activeLayers = normalizeLayerTypes(active.layerTypes);
  const artifactLayers = normalizeLayerTypes(receipt.layerTypes);
  const laneProjectionProvided = laneProjection !== null && laneProjection !== undefined;
  const projection = isPrebuiltAnnotationRasterLaneProjectionV1(laneProjection)
    ? laneProjection
    : null;
  const projectionValid = !laneProjectionProvided || projection !== null;
  const policyMatch =
    projectionValid &&
    active.runtimePolicy !== null &&
    receipt.isoformMode === active.runtimePolicy.isoformMode &&
    receipt.laneLimit === null &&
    (active.runtimePolicy.laneLimit === null
      ? !laneProjectionProvided || projection?.laneLimit === null
      : projection?.laneLimit === active.runtimePolicy.laneLimit);
  const laneEnvelopeMatch =
    active.runtimePolicy?.laneLimit === null
      ? receipt.maxAnnotationLane === active.maxAnnotationLane
      : active.runtimePolicy !== null &&
        active.maxAnnotationLane === active.runtimePolicy.laneLimit - 1 &&
        projection?.sourceMaxAnnotationLane === receipt.maxAnnotationLane;
  const contractMatch =
    sourceMatch &&
    placementMatch &&
    policyMatch &&
    laneEnvelopeMatch &&
    receipt.themeMode === active.themeMode &&
    sameStrings(artifactLayers, activeLayers) &&
    receipt.maxCdsLane === active.maxCdsLane;
  return {
    contractMatch,
    sourceMatch,
    placementMatch,
    artifactLayerTypes: artifactLayers,
    artifactSourceFingerprint: receipt.sourceFingerprint,
    artifactPlacementFingerprint: receipt.placementFingerprint,
  };
}

export function isPrebuiltAnnotationRasterLaneProjectionV1(
  value: unknown
): value is PrebuiltAnnotationRasterLaneProjectionV1 {
  if (!isRecord(value) || !hasExactFields(value, LANE_PROJECTION_FIELDS)) return false;
  if (
    value.contract !== PREBUILT_ANNOTATION_RASTER_LANE_PROJECTION_V1 ||
    !validPositivePixelSize(value.sourceHeightPx) ||
    !validPixelOffset(value.sourceSpineOffsetPx, value.sourceHeightPx) ||
    !validPopulatedLane(value.sourceMaxAnnotationLane) ||
    !validPositivePixelSize(value.presentedHeightPx) ||
    !validPixelOffset(value.presentedSpineOffsetPx, value.presentedHeightPx)
  ) {
    return false;
  }
  const expectedSourceHeightPx =
    ((value.sourceMaxAnnotationLane as number) + 1) * PREPACKED_ANNOTATION_LANE_STEP_PX;
  if (
    !Number.isSafeInteger(expectedSourceHeightPx) ||
    value.sourceHeightPx !== expectedSourceHeightPx ||
    value.sourceSpineOffsetPx !== expectedSourceHeightPx - 1
  ) {
    return false;
  }
  if (value.laneLimit === null) {
    return (
      value.presentedHeightPx === value.sourceHeightPx &&
      value.presentedSpineOffsetPx === value.sourceSpineOffsetPx
    );
  }
  if (!Number.isSafeInteger(value.laneLimit) || (value.laneLimit as number) <= 0) return false;
  const expectedHeightPx = (value.laneLimit as number) * PREPACKED_ANNOTATION_LANE_STEP_PX;
  return (
    value.presentedHeightPx === expectedHeightPx &&
    value.presentedSpineOffsetPx === expectedHeightPx - 1
  );
}

export function isPrebuiltAnnotationRasterPresentationReceiptV1(
  value: unknown
): value is PrebuiltAnnotationRasterPresentationReceiptV1 {
  if (!isRecord(value)) return false;
  if (!hasExactFields(value, RECEIPT_FIELDS)) return false;
  if (
    value.contract !== PREBUILT_ANNOTATION_RASTER_PRESENTATION_V1 ||
    value.sourceValidationContract !== PREBUILT_ANNOTATION_RASTER_SOURCE_PLACEMENT_V1 ||
    value.trackType !== 'mRNA' ||
    (value.isoformMode !== 'canonical' && value.isoformMode !== 'expanded') ||
    (value.themeMode !== 'light' && value.themeMode !== 'dark') ||
    value.laneArtifactContract !== PREBUILT_ANNOTATION_RASTER_LANE_ARTIFACT_V1 ||
    value.annotationBarHeightPx !== PREPACKED_ANNOTATION_BAR_HEIGHT_PX ||
    value.laneStepPx !== PREPACKED_ANNOTATION_LANE_STEP_PX ||
    value.laneAlgorithmToken !== PREPACKED_ANNOTATION_LANE_TOKEN ||
    value.mapperContractToken !== PREPACKED_ANNOTATION_MAPPER_TOKEN ||
    value.geometryContractToken !== PREPACKED_ANNOTATION_GEOMETRY_TOKEN ||
    value.rasterizerContractToken !== PREBUILT_ANNOTATION_RASTERIZER_V1
  ) {
    return false;
  }
  if (
    !nonEmptyString(value.genomeIdentity) ||
    !Number.isSafeInteger(value.genomeLengthBp) ||
    (value.genomeLengthBp as number) <= 0 ||
    !isSourceFingerprint(value.sourceFingerprint) ||
    !isPlacementFingerprint(value.placementFingerprint) ||
    value.laneLimit !== null ||
    !validLane(value.maxAnnotationLane) ||
    !validLane(value.maxCdsLane) ||
    !Array.isArray(value.layerTypes)
  ) {
    return false;
  }
  const normalized = normalizeLayerTypes(value.layerTypes as unknown[]);
  if (
    normalized.length === 0 ||
    normalized.length !== value.layerTypes.length ||
    !sameStrings(normalized, value.layerTypes as string[])
  ) {
    return false;
  }
  return value.artifactKey === prebuiltAnnotationRasterPresentationArtifactKeyV1(value as never);
}

export function isAnnotationSourcePlacementProvenanceV1(
  value: unknown
): value is AnnotationSourcePlacementProvenanceV1 {
  if (!isRecord(value)) return false;
  return (
    hasExactFields(value, ACTIVE_SOURCE_PLACEMENT_FIELDS) &&
    value.contract === PREBUILT_ANNOTATION_RASTER_SOURCE_PLACEMENT_V1 &&
    isSourceFingerprint(value.sourceFingerprint) &&
    isPlacementFingerprint(value.placementFingerprint)
  );
}

export function prebuiltAnnotationRasterPresentationArtifactKeyV1(
  identity: PrebuiltAnnotationRasterPresentationIdentityV1
): string {
  return `prebuilt-annotation-raster-artifact.v1:${framedKey([
    identity.contract,
    identity.sourceValidationContract,
    identity.genomeIdentity,
    String(identity.genomeLengthBp),
    identity.sourceFingerprint,
    identity.placementFingerprint,
    identity.trackType,
    identity.isoformMode,
    'uncapped',
    ...identity.layerTypes,
    String(identity.maxAnnotationLane),
    String(identity.maxCdsLane),
    identity.themeMode,
    identity.laneArtifactContract,
    String(identity.annotationBarHeightPx),
    String(identity.laneStepPx),
    identity.laneAlgorithmToken,
    identity.mapperContractToken,
    identity.geometryContractToken,
    identity.rasterizerContractToken,
  ])}`;
}

const RECEIPT_FIELDS = [
  'contract',
  'artifactKey',
  'sourceValidationContract',
  'genomeIdentity',
  'genomeLengthBp',
  'sourceFingerprint',
  'placementFingerprint',
  'trackType',
  'isoformMode',
  'laneLimit',
  'layerTypes',
  'maxAnnotationLane',
  'maxCdsLane',
  'themeMode',
  'laneArtifactContract',
  'annotationBarHeightPx',
  'laneStepPx',
  'laneAlgorithmToken',
  'mapperContractToken',
  'geometryContractToken',
  'rasterizerContractToken',
] as const;

const ACTIVE_SOURCE_PLACEMENT_FIELDS = [
  'contract',
  'sourceFingerprint',
  'placementFingerprint',
] as const;

const LANE_PROJECTION_FIELDS = [
  'contract',
  'laneLimit',
  'sourceHeightPx',
  'sourceSpineOffsetPx',
  'sourceMaxAnnotationLane',
  'presentedHeightPx',
  'presentedSpineOffsetPx',
] as const;

function normalizeLayerTypes(values: readonly unknown[]): string[] {
  return [...new Set(values.filter(nonEmptyString).map((value) => value.trim()))].sort((a, b) =>
    a.localeCompare(b)
  );
}

function validPositivePixelSize(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function validPixelOffset(value: unknown, height: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    Number.isSafeInteger(height) &&
    (value as number) >= 0 &&
    (value as number) < (height as number)
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validLane(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= -1;
}

function validPopulatedLane(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isSourceFingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{24}$/.test(value);
}

function isPlacementFingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^ap1:[0-9a-f]{24}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactFields(
  value: Record<string, unknown>,
  expectedFields: readonly string[]
): boolean {
  const actual = Object.keys(value);
  if (actual.length !== expectedFields.length) return false;
  const expected = new Set(expectedFields);
  return actual.every((field) => expected.has(field));
}

function framedKey(parts: readonly string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join('');
}
