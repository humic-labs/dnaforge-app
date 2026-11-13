import {
  emptyAnnotationBodyPresenterEligibility,
  selectAnnotationBodyPresenter,
  type AnnotationBodyFrameOwnerKind,
  type AnnotationBodyPresenterEligibility,
  type AnnotationBodyPresenterKind,
} from './annotation-body-presentation-authority';
import type { RetainedOverlayCameraState } from './overlay-track';
import { findAnnotationTrackIdentity } from '../../../annotation-track-identity';

export const OVERVIEW_GLYPH_TILE_MIN_VISIBLE_BP = 512_000;

export type BodyOwnerHost = {
  annotationBodyFrameOwner: AnnotationBodyFrameOwnerKind | null;
  annotationBodyFrameEligibility: AnnotationBodyPresenterEligibility;
  compiledBroadSurfaceManifestFingerprintForTrack(trackId: string): string | null;
  prepackedAnnotationSceneResidents: Map<
    string,
    {
      ownerKey: string;
      metadata: { trackType: string };
      layer: { isPresenting: boolean };
    }
  >;
  noteAnnotationBodyPresentationCommit(input?: {
    productKind?: AnnotationBodyFrameOwnerKind;
  }): void;
};

export type BodyProbeHost = {
  annotationLayerTypesForPresentation(): string[];
  compiledBroadSurfaceRequirement: unknown;
  compiledBroadSurfacePresenter: unknown;
  compiledBroadSurfaceCandidatePresenter: unknown;
  compiledBroadSurfaceTrackOwners: { readonly size: number };
  compiledBroadSurfaceTrackCandidateOwners: { readonly size: number };
  prepackedAnnotationSceneLayer: unknown;
  prepackedAnnotationSceneResidents: { readonly size: number };
  prepackedAnnotationSceneLastCompleteOwnerKeys: readonly string[];
  prepackedAnnotationSceneInput: unknown;
  prepackedAnnotationSceneStatus: string;
  genomeWideTextureCacheLayer: { hasPrebuilt(): boolean } | null;
  genomeLength: number;
  tilePyramid: { vector: unknown };
};

export function annotationBodyProductFingerprintsMatchCurrentGeneration(
  host: BodyOwnerHost,
  committed: readonly string[],
  productKind: AnnotationBodyFrameOwnerKind,
  orderedVisibleTrackIds: readonly string[],
  explicit: readonly string[] | undefined
): boolean {
  if (explicit) {
    return (
      committed.length === explicit.length &&
      committed.every((fingerprint, index) => fingerprint === explicit[index])
    );
  }
  if (productKind === 'compiled-broad') {
    if (committed.length !== orderedVisibleTrackIds.length) return false;
    for (let index = 0; index < orderedVisibleTrackIds.length; index += 1) {
      const fingerprint = host.compiledBroadSurfaceManifestFingerprintForTrack(
        orderedVisibleTrackIds[index]
      );
      if (!fingerprint || committed[index] !== fingerprint) return false;
    }
    return true;
  }
  if (productKind === 'prepacked-vector') {
    if (committed.length !== orderedVisibleTrackIds.length) return false;
    const presentingResidents = [...host.prepackedAnnotationSceneResidents.values()].filter(
      (resident) => resident.layer.isPresenting
    );
    for (let index = 0; index < orderedVisibleTrackIds.length; index += 1) {
      const resident = findAnnotationTrackIdentity(
        orderedVisibleTrackIds[index],
        presentingResidents,
        (candidate) => candidate.metadata.trackType
      );
      const ownerKey = resident?.ownerKey ?? null;
      if (ownerKey === null || committed[index] !== ownerKey) return false;
    }
    return true;
  }
  return committed.length === 0;
}

export function noteAnnotationBodyFrameOwner(
  host: BodyOwnerHost,
  frameOwner: AnnotationBodyFrameOwnerKind,
  probedEligibility?: AnnotationBodyPresenterEligibility
): void {
  if (frameOwner === host.annotationBodyFrameOwner) {
    if (frameOwner !== 'none') {
      host.noteAnnotationBodyPresentationCommit({ productKind: frameOwner });
    }
    return;
  }
  if (probedEligibility) {
    host.annotationBodyFrameEligibility = Object.freeze({ ...probedEligibility });
    const selected = selectAnnotationBodyPresenter(host.annotationBodyFrameEligibility);
    host.annotationBodyFrameOwner =
      frameOwner !== 'none' && frameOwner !== selected ? frameOwner : selected;
    if (frameOwner !== 'none' && frameOwner !== selected) {
      const forced = { ...emptyAnnotationBodyPresenterEligibility() } as {
        -readonly [K in AnnotationBodyPresenterKind]: boolean;
      };
      forced[frameOwner] = true;
      host.annotationBodyFrameEligibility = Object.freeze(forced);
      host.annotationBodyFrameOwner = frameOwner;
    }
  } else {
    const eligibility = { ...emptyAnnotationBodyPresenterEligibility() } as {
      -readonly [K in AnnotationBodyPresenterKind]: boolean;
    };
    if (frameOwner !== 'none') eligibility[frameOwner] = true;
    host.annotationBodyFrameEligibility = Object.freeze(eligibility);
    host.annotationBodyFrameOwner = selectAnnotationBodyPresenter(
      host.annotationBodyFrameEligibility
    );
  }
  if (frameOwner !== 'none') {
    host.noteAnnotationBodyPresentationCommit({ productKind: frameOwner });
  }
}

export function probeAnnotationBodyPresenterEligibility(
  host: BodyProbeHost,
  camera: RetainedOverlayCameraState,
  prebuiltRasterEligibility: { eligible: boolean },
  priorFrameHadCompleteBroadOwnership: boolean
): AnnotationBodyPresenterEligibility {
  const requestedLayerTypes = host.annotationLayerTypesForPresentation();
  const overviewVisibleBp = camera.path.viewEndBp - camera.path.viewStartBp;
  const hasAnyBroadProduct =
    Boolean(host.compiledBroadSurfaceRequirement) ||
    Boolean(host.compiledBroadSurfacePresenter) ||
    Boolean(host.compiledBroadSurfaceCandidatePresenter) ||
    host.compiledBroadSurfaceTrackOwners.size > 0 ||
    host.compiledBroadSurfaceTrackCandidateOwners.size > 0 ||
    priorFrameHadCompleteBroadOwnership;
  const compiledBroadEligible = requestedLayerTypes.length > 0 && hasAnyBroadProduct;
  const prepackedEligible =
    !prebuiltRasterEligibility.eligible &&
    requestedLayerTypes.length > 0 &&
    (host.prepackedAnnotationSceneLayer !== null ||
      host.prepackedAnnotationSceneResidents.size > 0 ||
      host.prepackedAnnotationSceneLastCompleteOwnerKeys.length > 0 ||
      host.prepackedAnnotationSceneInput !== null ||
      host.prepackedAnnotationSceneStatus !== 'not-loaded');
  const prebuiltEligible =
    Boolean(host.genomeWideTextureCacheLayer?.hasPrebuilt()) &&
    host.genomeLength > 0 &&
    prebuiltRasterEligibility.eligible &&
    overviewVisibleBp > OVERVIEW_GLYPH_TILE_MIN_VISIBLE_BP;
  const tilePyramidEligible = host.tilePyramid.vector !== null;
  return Object.freeze({
    'compiled-broad': compiledBroadEligible,
    'prepacked-vector': prepackedEligible,
    'tile-pyramid': tilePyramidEligible,
    'prebuilt-raster': prebuiltEligible,
    'retained-immediate': false,
  });
}
