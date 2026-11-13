import type { RenderState } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import type { RetainedOverlayCameraState } from './overlay-track';
import {
  annotationPrebuiltRasterEligibility,
  type AnnotationPrebuiltRasterEligibility,
} from './annotation-lod-ownership';
import { matchPrebuiltAnnotationRasterPresentation } from '../overview/prebuilt-annotation-raster-contract';
import type { PrebuiltAnnotationRasterContractMatch } from '../overview/prebuilt-annotation-raster-contract';
import type { AnnotationPolicyGpuRuntimeV1 } from '../overview/annotation-policy-gpu-instances-v1';

export type PrebuiltRasterEligibilityHost = {
  genomeLength: number;
  genomeWideTextureCacheLayer: {
    prebuiltWidthPx?: number;
    prebuiltResolution?: number;
    prebuiltSemanticReceipt?: unknown;
    prebuiltLaneProjection?: unknown;
    hasPrebuilt(): boolean;
    buildAndExtractPng(args: unknown): Promise<{
      dataUrl: string;
      widthPx: number;
      heightPx: number;
      resolution: number;
      spineOffsetPx: number;
      genomeLength: number;
    } | null>;
  } | null;
  pixiRenderer: { resolution?: number } | null;
  currentGenomeIdentity: string | null;
  currentAnnotationSourceFingerprint: string | null;
  currentAnnotationPlacementFingerprint: string | null;
  prepackedAnnotationRuntimePolicy: AnnotationPolicyGpuRuntimeV1 | null;
  maxAnnotationLane: number;
  maxCdsLane: number;
  lastGenomeWideContext: { path: PathMapper; state: RenderState } | null;
  retainedLinearTranscriptBlockCount: number;
  prebuiltRasterContractForLastFrame: PrebuiltAnnotationRasterContractMatch;
  annotationLayerTypesForPresentation(): string[];
  forceMeshOverview(): boolean;
  prebuiltRasterTexelsPerDevicePx(camera: RetainedOverlayCameraState): number;
  buildGenomeWideCompositeArgs(path: PathMapper, state: RenderState): unknown;
  ensureGenomeWideTextureCacheLayer(): NonNullable<
    PrebuiltRasterEligibilityHost['genomeWideTextureCacheLayer']
  >;
};

export function forceMeshOverview(): boolean {
  return (
    (globalThis as { __WAYPOINT_FORCE_MESH_OVERVIEW?: boolean }).__WAYPOINT_FORCE_MESH_OVERVIEW ===
    true
  );
}

export function prebuiltRasterTexelsPerDevicePx(
  host: PrebuiltRasterEligibilityHost,
  camera: RetainedOverlayCameraState
): number {
  const layer = host.genomeWideTextureCacheLayer;
  const widthPx = layer?.prebuiltWidthPx ?? 0;
  if (widthPx <= 0 || host.genomeLength <= 0) return Number.POSITIVE_INFINITY;
  const artifactResolution = Math.max(1, layer?.prebuiltResolution ?? 1);
  const displayResolution = Math.max(
    1,
    host.pixiRenderer?.resolution ??
      (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1)
  );
  const artifactTexelsPerBp = (widthPx * artifactResolution) / host.genomeLength;
  const displayDevicePixelsPerBp = camera.path.pixelsPerBp * displayResolution;
  if (!(displayDevicePixelsPerBp > 0)) return 0;
  const horizontalDensity = artifactTexelsPerBp / displayDevicePixelsPerBp;
  const verticalDensity = artifactResolution / displayResolution;
  return Math.min(horizontalDensity, verticalDensity);
}

export function prebuiltRasterEligibility(
  host: PrebuiltRasterEligibilityHost,
  camera: RetainedOverlayCameraState
): AnnotationPrebuiltRasterEligibility {
  const contract = matchPrebuiltAnnotationRasterPresentation(
    host.genomeWideTextureCacheLayer?.prebuiltSemanticReceipt ?? null,
    {
      genomeIdentity: host.currentGenomeIdentity ?? '',
      genomeLengthBp: host.genomeLength,
      sourceFingerprint: host.currentAnnotationSourceFingerprint,
      placementFingerprint: host.currentAnnotationPlacementFingerprint,
      runtimePolicy: host.prepackedAnnotationRuntimePolicy,
      layerTypes: host.annotationLayerTypesForPresentation(),
      maxAnnotationLane: host.maxAnnotationLane,
      maxCdsLane: host.maxCdsLane,
      themeMode: camera.state.themeMode ?? 'light',
    },
    host.genomeWideTextureCacheLayer?.prebuiltLaneProjection ?? null
  );
  host.prebuiltRasterContractForLastFrame = contract;
  return annotationPrebuiltRasterEligibility({
    genomeLength: host.genomeLength,
    visibleBp: camera.path.viewEndBp - camera.path.viewStartBp,
    texelsPerDevicePx: host.prebuiltRasterTexelsPerDevicePx(camera),
    rasterAvailable: host.genomeWideTextureCacheLayer?.hasPrebuilt() ?? false,
    forceMeshOverview: host.forceMeshOverview(),
    semanticContractMatch: contract.contractMatch,
  });
}

export async function buildAndExtractGenomeWideTexturePng(
  host: PrebuiltRasterEligibilityHost
): Promise<{
  dataUrl: string;
  widthPx: number;
  heightPx: number;
  resolution: number;
  spineOffsetPx: number;
  genomeLength: number;
  maxAnnotationLane: number;
  maxCdsLane: number;
  layerTypes: string[];
} | null> {
  const ctx = host.lastGenomeWideContext;
  const blocks = host.retainedLinearTranscriptBlockCount;
  if (!ctx || blocks <= 0) {
    console.error(`[texture-precompute-diag] not-ready: hasContext=${!!ctx} blockCount=${blocks}`);
    return null;
  }
  const args = host.buildGenomeWideCompositeArgs(ctx.path, ctx.state);
  if (!args) {
    console.error('[texture-precompute-diag] no-args (renderer/mesh missing)');
    return null;
  }
  const out = await host.ensureGenomeWideTextureCacheLayer().buildAndExtractPng(args);
  if (!out) {
    console.error('[texture-precompute-diag] extract-failed (rebuild/extract returned null)');
    return null;
  }
  return {
    ...out,
    maxAnnotationLane: host.maxAnnotationLane,
    maxCdsLane: host.maxCdsLane,
    layerTypes: host.annotationLayerTypesForPresentation(),
  };
}
