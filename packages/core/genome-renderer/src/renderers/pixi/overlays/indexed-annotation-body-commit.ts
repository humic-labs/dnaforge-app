import { createAnnotationBodyPresentationGenerationV1 } from './annotation-body-presentation-authority';
import type { AnnotationBodyFrameOwnerKind } from './annotation-body-presentation-authority';
import type { AnnotationPolicyGpuRuntimeV1 } from '../overview/annotation-policy-gpu-instances-v1';
import { findAnnotationTrackIdentity } from '../../../annotation-track-identity';

export type BodyCommitHost = {
  maxAnnotationLane: number;
  prepackedAnnotationRuntimePolicy: AnnotationPolicyGpuRuntimeV1 | null;
  annotationBodyFrameOwner: AnnotationBodyFrameOwnerKind | null;
  annotationBodyPresentationGeneration: {
    productKind: AnnotationBodyFrameOwnerKind | null;
    policy: { isoformMode: 'canonical' | 'expanded'; laneLimit: number | null };
    sourceFingerprint: string | null;
    placementFingerprint: string | null;
    orderedVisibleTrackIds: readonly string[];
    productFingerprints: readonly string[];
    generationId: string;
    commitEpoch: number;
  } | null;
  currentAnnotationSourceFingerprint: string | null;
  currentAnnotationPlacementFingerprint: string | null;
  annotationBodyPresentationCommitEpoch: number;
  prepackedAnnotationSceneResidents: Map<
    string,
    {
      ownerKey: string;
      metadata: { trackType: string };
      layer: { isPresenting: boolean };
    }
  >;
  annotationLayerTypesForPresentation(): string[];
  annotationBodyProductFingerprintsMatchCurrentGeneration(
    current: readonly string[],
    productKind: AnnotationBodyFrameOwnerKind | null,
    orderedVisibleTrackIds: readonly string[],
    next?: readonly string[]
  ): boolean;
  compiledBroadSurfaceOwnerForTrack(trackId: string): {
    manifest: { manifestFingerprint: string };
  } | null;
};

export function noteAnnotationBodyPresentationCommit(
  host: BodyCommitHost,
  input?: {
    orderedVisibleTrackIds?: readonly string[];
    sourceFingerprint?: string | null;
    placementFingerprint?: string | null;
    productKind?: AnnotationBodyFrameOwnerKind;
    productFingerprints?: readonly string[];
  }
): void {
  const policy = host.prepackedAnnotationRuntimePolicy ?? {
    isoformMode: 'canonical' as const,
    laneLimit: Math.max(1, host.maxAnnotationLane + 1),
  };
  const orderedVisibleTrackIds =
    input?.orderedVisibleTrackIds ?? host.annotationLayerTypesForPresentation();
  const productKind = input?.productKind ?? host.annotationBodyFrameOwner;
  const currentGeneration = host.annotationBodyPresentationGeneration;
  const sourceFingerprint =
    input?.sourceFingerprint ?? host.currentAnnotationSourceFingerprint ?? null;
  const placementFingerprint =
    input?.placementFingerprint ?? host.currentAnnotationPlacementFingerprint ?? null;
  if (
    currentGeneration &&
    currentGeneration.productKind === productKind &&
    currentGeneration.policy.isoformMode === policy.isoformMode &&
    currentGeneration.policy.laneLimit === policy.laneLimit &&
    currentGeneration.sourceFingerprint === sourceFingerprint &&
    currentGeneration.placementFingerprint === placementFingerprint &&
    currentGeneration.orderedVisibleTrackIds.length === orderedVisibleTrackIds.length &&
    currentGeneration.orderedVisibleTrackIds.every(
      (trackId, index) => trackId === orderedVisibleTrackIds[index]
    ) &&
    host.annotationBodyProductFingerprintsMatchCurrentGeneration(
      currentGeneration.productFingerprints,
      productKind,
      orderedVisibleTrackIds,
      input?.productFingerprints
    )
  ) {
    return;
  }
  const productFingerprints =
    input?.productFingerprints ??
    (productKind === 'compiled-broad'
      ? orderedVisibleTrackIds.flatMap((trackId) => {
          const owner = host.compiledBroadSurfaceOwnerForTrack(trackId);
          return owner ? [owner.manifest.manifestFingerprint] : [];
        })
      : productKind === 'prepacked-vector'
        ? orderedVisibleTrackIds.flatMap((trackId) => {
            const presentingResidents = [...host.prepackedAnnotationSceneResidents.values()].filter(
              (entry) => entry.layer.isPresenting
            );
            const resident = findAnnotationTrackIdentity(
              trackId,
              presentingResidents,
              (entry) => entry.metadata.trackType
            );
            return resident ? [resident.ownerKey] : [];
          })
        : []);
  const nextGeneration = createAnnotationBodyPresentationGenerationV1({
    commitEpoch: host.annotationBodyPresentationCommitEpoch + 1,
    orderedVisibleTrackIds,
    policy: {
      isoformMode: policy.isoformMode,
      laneLimit: policy.laneLimit,
    },
    sourceFingerprint,
    placementFingerprint,
    productKind,
    productFingerprints,
  });
  if (host.annotationBodyPresentationGeneration?.generationId === nextGeneration.generationId) {
    return;
  }
  host.annotationBodyPresentationCommitEpoch = nextGeneration.commitEpoch;
  host.annotationBodyPresentationGeneration = nextGeneration;
}
