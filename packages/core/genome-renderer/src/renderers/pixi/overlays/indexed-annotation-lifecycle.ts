import { RendererType, type Graphics, type Renderer, type Text } from 'pixi.js';
import type { Feature, RenderState } from '../../../types';
import type { UnifiedLayout } from '../shared/track-layout';
import type { PathMapper } from '../shared/path-mapper';
import type { AnnotationOverviewCacheContext } from './annotation-overview-cache';
import { MIN_NARROW_FEATURE_PX } from './annotation-lod-policy';
import { PartitionedInstancedTranscriptLayer } from '../overview/partitioned-instanced-transcript-layer';
import { RetainedOverviewAnnotationLayer } from '../overview/retained-overview-layer';
import { RetainedLinearFeatureLayer } from '../overview/retained-linear-feature-layer';
import { RetainedLinearTranscriptLayer } from '../overview/retained-linear-transcript-layer';
import {
  GenomeWideTextureCacheLayer,
  type GenomeWideTextureCompositeArgs,
  type PrebuiltGenomeWideTextureMeta,
} from '../overview/genome-wide-texture-cache-layer';
import type { Container } from 'pixi.js';
import { linearViewerRenderContract } from '../overview/viewer-render-contract';
import type { PrebuiltAnnotationRasterContractMatch } from '../overview/prebuilt-annotation-raster-contract';
import type { CompiledBroadAnnotationInteractionAuthoritySnapshotV1 } from './annotation-overlay-types';
import { COMPILED_BROAD_ANNOTATION_INTERACTION_AUTHORITY_SNAPSHOT_V1 } from './annotation-overlay-types';
import type { AnnotationSearchFocusPresentationSnapshot } from './annotation-overlay-types';
import type { AnnotationPresentationPolicyCommitDispositionV1 } from './annotation-overlay-types';
import type { AnnotationPolicyGpuRuntimeV1 } from '../overview/annotation-policy-gpu-instances-v1';
import { buildPrepackedAnnotationSceneOwnerSnapshot } from './indexed-prepacked-owner-snapshot';
import { destroyPixiText } from '../shared/pixi-text-lifecycle';
import type {
  PrepackedAnnotationSceneMetadata,
  PrepackedAnnotationSceneOwnerSnapshot,
  PrepackedAnnotationSceneStatus,
} from '../overview/prepacked-annotation-scene';

export type OverlayLifecycleHost = {
  pixiRenderer: Renderer | null;
  prepackedAnnotationSceneResidents: { readonly size: number };
  disposePrepackedAnnotationScene(status: string): void;
  prebuiltRasterEligibleForLastFrame: boolean;
  prebuiltRasterContractForLastFrame: PrebuiltAnnotationRasterContractMatch;
  retainedOverviewLayer: RetainedOverviewAnnotationLayer | null;
  genomeWideTextureCacheLayer: GenomeWideTextureCacheLayer | null;
  retainedLinearFeatureLayer: RetainedLinearFeatureLayer | null;
  retainedLinearTranscriptLayer: RetainedLinearTranscriptLayer | null;
  resetTilePyramid(): void;
  retainedLinearTranscriptKey: string;
  retainedLinearTranscriptFeatureSet: unknown;
  retainedLinearTranscriptMembershipNeedsRebind: boolean;
  retainedLinearSourceWindow: unknown;
  overviewCache: { invalidate(): void };
  retainedOverviewHitBins: unknown[];
  retainedOverviewPassthroughDrawn: boolean;
  resetRetainedOverviewDebug(): void;
  features: Feature[];
  genomeLength: number;
  _layout: UnifiedLayout | null;
  maxAnnotationLane: number;
  maxCdsLane: number;
  featureOffset(feature: Feature): number;
  scaledBarHeight(): number;
  compiledBroadAnnotationInteractionResidentGeneration: number;
  compiledBroadAnnotationInteractionResidents: Map<string, unknown>;
  annotationSearchFocusResolvedTrackId: string | null;
  annotationSearchFocusResolvedCanonicalIdentity: string | null;
  annotationSearchFocusPresentationLane: number | null;
  applyAnnotationPresentationPolicy(policy: AnnotationPolicyGpuRuntimeV1): boolean | 'deferred';
  prepackedAnnotationPolicyGeneration: number;
  clearCompiledBroadSurfaceRequirement(): void;
  disposePrepackedAnnotationScene(status: string, recordOwnerChange?: boolean): void;
  releaseRetiredGpuResourcesAfterPresent(force?: boolean): void;
  graphics: Graphics;
  retainedTranscriptDecorationGraphics: Graphics;
  annotationSearchFocusGraphics: Graphics;
  interactionGraphics: Graphics;
  tilePyramid: { destroy(): void };
  sidecarRaster: { destroy(): void };
  curvedLabels: { destroy(): void };
  labelPool: Text[];
  container: Container;
  retiredPrepackedAnnotationSceneLayers: Map<{ destroy(): void }, number>;
  prepackedAnnotationSceneLayerDestroys: number;
};

export function setRenderer(host: OverlayLifecycleHost, renderer: Renderer | null): void {
  if (host.pixiRenderer === renderer) return;
  host.pixiRenderer = renderer;
  if (
    renderer?.type === RendererType.WEBGL &&
    typeof (renderer as { shader?: { bind?: unknown } }).shader?.bind === 'function'
  ) {
    PartitionedInstancedTranscriptLayer.prepareGpuPrograms(
      renderer as Parameters<typeof PartitionedInstancedTranscriptLayer.prepareGpuPrograms>[0],
      true
    );
  }
  if (host.prepackedAnnotationSceneResidents.size > 0 && renderer?.type !== RendererType.WEBGL) {
    host.disposePrepackedAnnotationScene('unsupported-renderer');
  }
}

export function buildRetainedData(
  host: OverlayLifecycleHost,
  noPrebuiltMatch: PrebuiltAnnotationRasterContractMatch
): void {
  host.prebuiltRasterEligibleForLastFrame = false;
  host.prebuiltRasterContractForLastFrame = noPrebuiltMatch;
  host.retainedOverviewLayer?.resetData();
  host.genomeWideTextureCacheLayer?.resetData();
  host.retainedLinearFeatureLayer?.resetData();
  host.retainedLinearTranscriptLayer?.resetData();
  host.resetTilePyramid();
  host.retainedLinearTranscriptKey = '';
  host.retainedLinearTranscriptFeatureSet = null;
  host.retainedLinearTranscriptMembershipNeedsRebind = false;
  host.retainedLinearSourceWindow = null;
  host.overviewCache.invalidate();
  host.retainedOverviewHitBins = [];
  host.retainedOverviewPassthroughDrawn = false;
  host.resetRetainedOverviewDebug();
}

export type OverviewCacheContextHost = Pick<
  OverlayLifecycleHost,
  | 'features'
  | 'genomeLength'
  | '_layout'
  | 'maxAnnotationLane'
  | 'maxCdsLane'
  | 'featureOffset'
  | 'scaledBarHeight'
>;

export function overviewCacheContext(
  host: OverviewCacheContextHost,
  getColor: (feature: Feature, featureScoped: boolean) => number,
  isOutlineOnlyFeature: (feature: Feature) => boolean,
  isSplicedFeature: (feature: Feature) => boolean,
  isTranscript: (feature: Feature) => boolean
): AnnotationOverviewCacheContext {
  return {
    features: host.features,
    genomeLength: host.genomeLength,
    layout: host._layout,
    maxAnnotationLane: host.maxAnnotationLane,
    maxCdsLane: host.maxCdsLane,
    minAggregateFeaturePixels: MIN_NARROW_FEATURE_PX,
    getEndBp: (feature) =>
      feature.end > feature.start ? feature.end : feature.end + host.genomeLength,
    getOffset: (feature) => host.featureOffset(feature),
    getHalfHeight: () => host.scaledBarHeight() / 2,
    getColor: (feature) => getColor(feature, false),
    getAlpha: (feature, featureScoped) =>
      featureScoped && isOutlineOnlyFeature(feature) ? 0.35 : 0.85,
    shouldPassThrough: (feature, featureScoped) =>
      featureScoped
        ? isSplicedFeature(feature)
        : isOutlineOnlyFeature(feature) || isSplicedFeature(feature) || isTranscript(feature),
  };
}

export type CompiledBroadInteractionAuthorityHost = {
  compiledBroadAnnotationInteractionResidentGeneration: number;
  compiledBroadAnnotationInteractionResidents: { keys(): Iterable<string> };
};

export function getCompiledBroadAnnotationInteractionAuthoritySnapshot(
  host: CompiledBroadInteractionAuthorityHost
): CompiledBroadAnnotationInteractionAuthoritySnapshotV1 {
  return {
    contract: COMPILED_BROAD_ANNOTATION_INTERACTION_AUTHORITY_SNAPSHOT_V1,
    residentGeneration: host.compiledBroadAnnotationInteractionResidentGeneration,
    preparedOwnerKeys: [...host.compiledBroadAnnotationInteractionResidents.keys()].sort(
      (left, right) => left.localeCompare(right)
    ),
  };
}

export type SearchFocusPresentationSnapshotHost = Pick<
  OverlayLifecycleHost,
  | 'annotationSearchFocusResolvedTrackId'
  | 'annotationSearchFocusResolvedCanonicalIdentity'
  | 'annotationSearchFocusPresentationLane'
>;

export function getAnnotationSearchFocusPresentationSnapshot(
  host: SearchFocusPresentationSnapshotHost
): AnnotationSearchFocusPresentationSnapshot {
  return {
    annotationSearchFocusResolvedTrackId: host.annotationSearchFocusResolvedTrackId,
    annotationSearchFocusResolvedCanonicalIdentity:
      host.annotationSearchFocusResolvedCanonicalIdentity,
    annotationSearchFocusPresentationLane: host.annotationSearchFocusPresentationLane,
  };
}

export type AnnotationPolicyCommitHost = {
  applyAnnotationPresentationPolicy(policy: AnnotationPolicyGpuRuntimeV1): boolean | 'deferred';
  prepackedAnnotationPolicyGeneration: number;
};

export function commitAnnotationPresentationPolicy(
  host: AnnotationPolicyCommitHost,
  policy: AnnotationPolicyGpuRuntimeV1
): AnnotationPresentationPolicyCommitDispositionV1 {
  const result = host.applyAnnotationPresentationPolicy(policy);
  if (result === 'deferred') {
    return Object.freeze({
      status: 'deferred',
      reason: 'selected-raster-roster-incomplete',
    });
  }
  if (result) {
    return Object.freeze({
      status: 'committed',
      policyGeneration: host.prepackedAnnotationPolicyGeneration,
    });
  }
  return Object.freeze({
    status: 'rejected',
    reason: 'annotation-policy-commit-rejected',
  });
}

export type RetiredPrepackedGpuHost = {
  retiredPrepackedAnnotationSceneLayers: Map<{ destroy(): void }, number>;
  prepackedAnnotationSceneLayerDestroys: number;
};

export function releaseRetiredGpuResourcesAfterPresent(
  host: RetiredPrepackedGpuHost,
  force = false
): void {
  for (const [
    layer,
    remainingPresentationBoundaries,
  ] of host.retiredPrepackedAnnotationSceneLayers) {
    if (!force && remainingPresentationBoundaries > 1) {
      host.retiredPrepackedAnnotationSceneLayers.set(layer, remainingPresentationBoundaries - 1);
      continue;
    }
    host.retiredPrepackedAnnotationSceneLayers.delete(layer);
    layer.destroy();
    host.prepackedAnnotationSceneLayerDestroys += 1;
  }
}

export type PrepackedOwnerSnapshotHost = {
  prepackedAnnotationSceneOwnerKey: string | null;
  prepackedAnnotationSceneOwnerGeneration: number;
  prepackedAnnotationSceneLayer: { isGpuPrepared?: boolean; isPresenting?: boolean } | null;
  prepackedAnnotationSceneInput: object | null;
  prepackedAnnotationSceneStatus: PrepackedAnnotationSceneStatus;
  prepackedAnnotationSceneOwnerMetadata: PrepackedAnnotationSceneMetadata | null;
  prepackedAnnotationRuntimePolicy: AnnotationPolicyGpuRuntimeV1 | null;
  prepackedAnnotationPolicyGeneration: number;
  prepackedAnnotationSceneResidents: {
    get(key: string):
      | {
          layer: object;
          visiblePartitionCount: number;
          visibleInstanceCount: number;
        }
      | undefined;
  };
};

export function getPrepackedAnnotationSceneOwnerSnapshot(
  host: PrepackedOwnerSnapshotHost
): PrepackedAnnotationSceneOwnerSnapshot {
  const resident = host.prepackedAnnotationSceneOwnerKey
    ? host.prepackedAnnotationSceneResidents.get(host.prepackedAnnotationSceneOwnerKey)
    : null;
  return buildPrepackedAnnotationSceneOwnerSnapshot({
    ownerKey: host.prepackedAnnotationSceneOwnerKey,
    ownerGeneration: host.prepackedAnnotationSceneOwnerGeneration,
    layer: host.prepackedAnnotationSceneLayer,
    input: host.prepackedAnnotationSceneInput,
    status: host.prepackedAnnotationSceneStatus,
    metadata: host.prepackedAnnotationSceneOwnerMetadata,
    runtimePolicy: host.prepackedAnnotationRuntimePolicy,
    policyGeneration: host.prepackedAnnotationPolicyGeneration,
    resident: resident ?? null,
  });
}

export function ensureRetainedOverviewLayer(
  host: OverlayLifecycleHost
): RetainedOverviewAnnotationLayer {
  if (!host.retainedOverviewLayer) {
    host.retainedOverviewLayer = new RetainedOverviewAnnotationLayer();
    host.container.addChildAt(
      host.retainedOverviewLayer.container,
      Math.min(1, host.container.children.length)
    );
  }
  return host.retainedOverviewLayer;
}

export function ensureRetainedLinearFeatureLayer(
  host: OverlayLifecycleHost
): RetainedLinearFeatureLayer {
  if (!host.retainedLinearFeatureLayer) {
    host.retainedLinearFeatureLayer = new RetainedLinearFeatureLayer();
    host.container.addChildAt(
      host.retainedLinearFeatureLayer.container,
      Math.min(1, host.container.children.length)
    );
  }
  return host.retainedLinearFeatureLayer;
}

export function ensureRetainedLinearTranscriptLayer(
  host: OverlayLifecycleHost
): RetainedLinearTranscriptLayer {
  if (!host.retainedLinearTranscriptLayer) {
    host.retainedLinearTranscriptLayer = new RetainedLinearTranscriptLayer();
    host.container.addChildAt(
      host.retainedLinearTranscriptLayer.container,
      Math.min(2, host.container.children.length)
    );
  }
  return host.retainedLinearTranscriptLayer;
}

export function ensureGenomeWideTextureCacheLayer(
  host: OverlayLifecycleHost
): GenomeWideTextureCacheLayer {
  if (!host.genomeWideTextureCacheLayer) {
    host.genomeWideTextureCacheLayer = new GenomeWideTextureCacheLayer();
    host.container.addChildAt(
      host.genomeWideTextureCacheLayer.container,
      Math.min(2, host.container.children.length)
    );
  }
  return host.genomeWideTextureCacheLayer;
}

export function buildGenomeWideCompositeArgs(
  host: OverlayLifecycleHost,
  path: PathMapper,
  state: RenderState
): GenomeWideTextureCompositeArgs | null {
  const tLayer = host.retainedLinearTranscriptLayer;
  if (host.pixiRenderer === null || tLayer === null || host.genomeLength <= 0) return null;
  const liveContract = linearViewerRenderContract(path);
  return {
    renderer: host.pixiRenderer,
    source: tLayer,
    genomeLength: host.genomeLength,
    trackHeightPx: state.height,
    spineOffsetPx: liveContract.projectY(0),
    liveContract,
  };
}

export function loadPrebuiltGenomeWideTexture(
  host: OverlayLifecycleHost,
  image: ImageBitmap,
  meta: PrebuiltGenomeWideTextureMeta,
  noPrebuiltMatch: PrebuiltAnnotationRasterContractMatch
): void {
  host.prebuiltRasterContractForLastFrame = noPrebuiltMatch;
  if (host.genomeLength > 0 && meta.genomeLength !== host.genomeLength) {
    host.genomeWideTextureCacheLayer?.clearPrebuilt();
    return;
  }
  ensureGenomeWideTextureCacheLayer(host).loadPrebuiltTexture(image, meta);
  if (host.genomeLength <= 0) host.genomeLength = meta.genomeLength;
}

export function clearPrebuiltGenomeWideTexture(
  host: OverlayLifecycleHost,
  noPrebuiltMatch: PrebuiltAnnotationRasterContractMatch
): void {
  host.prebuiltRasterContractForLastFrame = noPrebuiltMatch;
  host.genomeWideTextureCacheLayer?.clearPrebuilt();
}

export function isPrebuiltGenomeWideTextureLoaded(host: OverlayLifecycleHost): boolean {
  return host.genomeWideTextureCacheLayer?.hasPrebuilt() ?? false;
}

export function destroyAnnotationOverlay(host: OverlayLifecycleHost): void {
  host.clearCompiledBroadSurfaceRequirement();
  host.disposePrepackedAnnotationScene('not-loaded');
  host.releaseRetiredGpuResourcesAfterPresent(true);
  host.graphics.destroy();
  host.retainedTranscriptDecorationGraphics.destroy();
  host.annotationSearchFocusGraphics.destroy();
  host.interactionGraphics.destroy();
  host.retainedOverviewLayer?.destroy();
  host.genomeWideTextureCacheLayer?.destroy();
  host.tilePyramid.destroy();
  host.sidecarRaster.destroy();
  host.retainedLinearFeatureLayer?.destroy();
  host.retainedLinearTranscriptLayer?.destroy();
  host.curvedLabels.destroy();
  for (const t of host.labelPool) destroyPixiText(t);
  host.container.destroy();
}
