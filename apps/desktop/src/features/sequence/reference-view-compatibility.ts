import type {
  ReferenceContentIdentity,
  ReferenceVersionIdentity,
} from '../../shared/reference-content-identity';
import { defaultVisibleAnnotationTypes } from './components/indexed-genome-viewer-controls';

export function savedReferenceContentIdentity(
  saved: Readonly<{
    sequenceIdentity?: string;
    annotationIdentity?: string;
    bundleFingerprint?: string | null;
    sourceFingerprint?: string | null;
    inventoryFingerprint?: string | null;
  }>,
  history: readonly ReferenceVersionIdentity[] = []
): ReferenceContentIdentity | null {
  if (saved.sequenceIdentity && saved.annotationIdentity)
    return {
      sequenceIdentity: saved.sequenceIdentity,
      annotationIdentity: saved.annotationIdentity,
    };
  return (
    history.find(
      (version) =>
        version.bundleFingerprint === saved.bundleFingerprint &&
        version.assetGenerations.some(
          (generation) =>
            generation.sourceFingerprint === saved.sourceFingerprint &&
            generation.inventoryFingerprint === saved.inventoryFingerprint
        )
    ) ?? null
  );
}

export function restoredReferenceAnnotationVisibility(
  overrides: Readonly<Record<string, boolean>>,
  trackIds: readonly string[]
): string[] {
  const defaults = defaultVisibleAnnotationTypes(trackIds);
  return trackIds.filter((id) => overrides[id] ?? defaults.has(id));
}

export function referenceViewCompatibility(
  saved: ReferenceContentIdentity,
  current: ReferenceContentIdentity
): Readonly<{ compatible: boolean; annotationsUpdated: boolean }> {
  const compatible = saved.sequenceIdentity === current.sequenceIdentity;
  return {
    compatible,
    annotationsUpdated: compatible && saved.annotationIdentity !== current.annotationIdentity,
  };
}

export const REFERENCE_ANNOTATION_UPDATE_NOTICE =
  "This reference's annotations were updated since this view was saved";

export function reconcileReferenceAnnotationTracks(
  saved: Readonly<{
    orderedTrackIds: readonly string[];
    visibilityByTrackId: Readonly<Record<string, boolean>>;
  }>,
  currentTrackIds: readonly string[]
) {
  const current = new Set(currentTrackIds);
  const savedIds = [
    ...new Set([...saved.orderedTrackIds, ...Object.keys(saved.visibilityByTrackId)]),
  ];
  const removedTrackIds = savedIds.filter((id) => !current.has(id));
  const orderedTrackIds = [
    ...new Set([...saved.orderedTrackIds.filter((id) => current.has(id)), ...currentTrackIds]),
  ];
  const visibilityByTrackId = Object.fromEntries(
    Object.entries(saved.visibilityByTrackId).filter(([id]) => current.has(id))
  );
  return {
    orderedTrackIds,
    visibilityByTrackId,
    removedTrackIds,
    notice: `${REFERENCE_ANNOTATION_UPDATE_NOTICE}.${removedTrackIds.length > 0 ? ` Removed tracks: ${removedTrackIds.join(', ')}.` : ''}`,
  };
}
