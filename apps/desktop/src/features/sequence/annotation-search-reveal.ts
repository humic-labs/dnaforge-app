import {
  resolveAnnotationTrackIdentity,
  type AnnotationTrackIdentityResolution,
} from '@waypoint/genome-renderer/annotation-track-identity';

export interface AnnotationSearchRevealTarget {
  readonly start: number;
  readonly end: number;
  readonly featureType?: string;
  readonly annotationTrackId?: string;
  readonly canonicalIdentity?: string;
}

export type AnnotationSearchReveal =
  | Readonly<{
      kind: 'unavailable';
      focusRange: null;
    }>
  | Readonly<{
      kind: 'visible';
      focusRange: readonly [number, number];
      trackId: string;
      featureType: string;
      canonicalIdentity: string;
    }>
  | Readonly<{
      kind: 'temporary';
      focusRange: readonly [number, number];
      trackId: string;
      featureType: string;
      canonicalIdentity: string;
    }>;

function resolveVisibleTrackIdentity(
  visibleTypes: ReadonlySet<string>,
  requestedTrackId: string
): AnnotationTrackIdentityResolution<string> {
  return resolveAnnotationTrackIdentity(
    requestedTrackId,
    visibleTypes,
    (visibleType) => visibleType
  );
}

export function deriveAnnotationSearchReveal(
  visibleTypes: ReadonlySet<string>,
  target: AnnotationSearchRevealTarget | null | undefined
): AnnotationSearchReveal {
  const trackId = target?.annotationTrackId?.trim() ?? '';
  const canonicalIdentity = target?.canonicalIdentity?.trim() ?? '';
  const featureType = target?.featureType?.trim() || trackId;
  if (
    !target ||
    !trackId ||
    !canonicalIdentity ||
    !Number.isSafeInteger(target.start) ||
    !Number.isSafeInteger(target.end) ||
    target.start < 0 ||
    target.end <= target.start
  ) {
    return { kind: 'unavailable', focusRange: null };
  }

  const visibleTrack = resolveVisibleTrackIdentity(visibleTypes, trackId);
  if (visibleTrack.status === 'matched') {
    return {
      kind: 'visible',
      focusRange: [target.start, target.end],
      trackId,
      featureType,
      canonicalIdentity,
    };
  }

  if (visibleTrack.status === 'ambiguous') {
    return { kind: 'unavailable', focusRange: null };
  }

  return {
    kind: 'temporary',
    focusRange: [target.start, target.end],
    trackId,
    featureType,
    canonicalIdentity,
  };
}

export function persistTemporarilyRevealedTrack(
  visibleTypes: ReadonlySet<string>,
  trackId: string
): ReadonlySet<string> {
  const requestedTrackId = trackId.trim();
  if (!requestedTrackId) {
    return visibleTypes;
  }
  const visibleTrack = resolveVisibleTrackIdentity(visibleTypes, requestedTrackId);
  if (visibleTrack.status !== 'missing') return visibleTypes;
  const next = new Set(visibleTypes);
  next.add(requestedTrackId);
  return next;
}
