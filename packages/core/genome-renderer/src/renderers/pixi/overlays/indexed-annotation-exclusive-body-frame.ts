import type { RetainedOverlayCameraState } from './overlay-track';
import {
  runExclusiveAnnotationBodyPresenter,
  shouldHoldCommittedAnnotationBodyGeneration,
  type AnnotationBodyReplacementReadiness,
} from './annotation-body-presentation-authority';
import type { RetainedOverviewAnnotationStyle } from './annotation-lod-policy';
import type { AnnotationPolicyGpuRuntimeV1 } from '../overview/annotation-policy-gpu-instances-v1';
import type { AnnotationPrebuiltRasterEligibility } from './annotation-lod-ownership';
import type { AnnotationBodyFrameOwnerKind } from './annotation-body-presentation-authority';
import type { AnnotationBodyPresenterEligibility } from './annotation-body-presentation-authority';

export type ExclusiveBodyFrameHost = {
  maxAnnotationLane: number;
  prepackedAnnotationRuntimePolicy: AnnotationPolicyGpuRuntimeV1 | null;
  annotationBodyFrameEligibility: AnnotationBodyPresenterEligibility;
  annotationLayerTypesForPresentation(): string[];
  tryPresentRequestedCompiledBroadSurfaces(
    camera: RetainedOverlayCameraState,
    requestedLayerTypes: readonly string[]
  ): AnnotationBodyReplacementReadiness;
  hideCompiledBroadPresenters?(): void;
  noteAnnotationBodyFrameOwner(owner: AnnotationBodyFrameOwnerKind): void;
  probeAnnotationBodyPresenterEligibility(
    camera: RetainedOverlayCameraState,
    prebuiltRasterEligibility: AnnotationPrebuiltRasterEligibility,
    priorFrameHadCompleteBroadOwnership: boolean
  ): AnnotationBodyPresenterEligibility;
  tryPresentPrepackedAnnotationScene(
    camera: RetainedOverlayCameraState,
    style: RetainedOverviewAnnotationStyle,
    prebuiltRasterEligibility: AnnotationPrebuiltRasterEligibility
  ): AnnotationBodyReplacementReadiness;
  tilePyramid: {
    tryPresent(host: unknown, camera: RetainedOverlayCameraState, onPresent: () => void): boolean;
  };
  tilePyramidHost(): unknown;
  finalizeCompiledAnnotationBodyPresent(
    camera: RetainedOverlayCameraState,
    style: RetainedOverviewAnnotationStyle
  ): void;
  tryPresentPrebuiltRasterBody(
    camera: RetainedOverlayCameraState,
    style: RetainedOverviewAnnotationStyle,
    prebuiltRasterEligibility: AnnotationPrebuiltRasterEligibility
  ): boolean;
  tryRetainLastCompleteCompiledBroadSurfaceFrame(
    camera: RetainedOverlayCameraState,
    policy: { isoformMode: 'canonical' | 'expanded'; laneLimit: number | null }
  ): boolean;
};

export function presentExclusiveAnnotationBodyFrame(
  host: ExclusiveBodyFrameHost,
  camera: RetainedOverlayCameraState,
  style: RetainedOverviewAnnotationStyle,
  prebuiltRasterEligibility: AnnotationPrebuiltRasterEligibility,
  priorFrameHadCompleteBroadOwnership: boolean
): boolean {
  const requestedLayerTypes = host.annotationLayerTypesForPresentation();
  const compiledBroadReplacementReadiness = host.tryPresentRequestedCompiledBroadSurfaces(
    camera,
    requestedLayerTypes
  );
  if (compiledBroadReplacementReadiness === 'complete') {
    host.noteAnnotationBodyFrameOwner('compiled-broad');
    return true;
  }
  const probed = host.probeAnnotationBodyPresenterEligibility(
    camera,
    prebuiltRasterEligibility,
    priorFrameHadCompleteBroadOwnership
  );
  host.annotationBodyFrameEligibility = probed;
  let prepackedReplacementReadiness: AnnotationBodyReplacementReadiness = 'absent';
  const exclusive = runExclusiveAnnotationBodyPresenter({
    'compiled-broad': () => false,
    'prepacked-vector': () => {
      prepackedReplacementReadiness = host.tryPresentPrepackedAnnotationScene(
        camera,
        style,
        prebuiltRasterEligibility
      );
      if (prepackedReplacementReadiness === 'complete') {
        host.hideCompiledBroadPresenters?.();
      }
      return prepackedReplacementReadiness === 'complete';
    },
    'tile-pyramid': () => {
      const presented = host.tilePyramid.tryPresent(host.tilePyramidHost(), camera, () =>
        host.finalizeCompiledAnnotationBodyPresent(camera, style)
      );
      if (presented) host.hideCompiledBroadPresenters?.();
      return presented;
    },
    'prebuilt-raster': () => {
      const presented = host.tryPresentPrebuiltRasterBody(camera, style, prebuiltRasterEligibility);
      if (presented) host.hideCompiledBroadPresenters?.();
      return presented;
    },
  });
  if (exclusive.presented) {
    host.noteAnnotationBodyFrameOwner(exclusive.owner);
    return true;
  }
  const policy = host.prepackedAnnotationRuntimePolicy ?? {
    isoformMode: 'canonical' as const,
    laneLimit: Math.max(1, host.maxAnnotationLane + 1),
  };
  const observedPrepackedReplacementReadiness =
    prepackedReplacementReadiness as AnnotationBodyReplacementReadiness;
  const replacementReadiness =
    observedPrepackedReplacementReadiness === 'pending'
      ? 'pending'
      : compiledBroadReplacementReadiness;
  if (
    shouldHoldCommittedAnnotationBodyGeneration({
      hasCommittedGeneration: priorFrameHadCompleteBroadOwnership,
      replacementReadiness,
    }) &&
    host.tryRetainLastCompleteCompiledBroadSurfaceFrame(camera, policy)
  ) {
    host.noteAnnotationBodyFrameOwner('compiled-broad');
    return true;
  }
  return false;
}
