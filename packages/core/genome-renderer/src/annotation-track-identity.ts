export type AnnotationTrackIdentityResolution<T> =
  | Readonly<{
      status: 'matched';
      matchKind: 'exact' | 'unique-case-insensitive-alias';
      value: T;
    }>
  | Readonly<{ status: 'missing' | 'ambiguous' }>;

export function resolveAnnotationTrackIdentity<T>(
  requestedTrackType: string,
  candidates: Iterable<T>,
  readTrackType: (candidate: T) => string
): AnnotationTrackIdentityResolution<T> {
  const normalizedRequest = requestedTrackType.toLowerCase();
  let aliasValue: T | undefined;
  let aliasTrackType: string | undefined;

  for (const candidate of candidates) {
    const candidateTrackType = readTrackType(candidate);
    if (candidateTrackType === requestedTrackType) {
      return { status: 'matched', matchKind: 'exact', value: candidate };
    }
    if (candidateTrackType.toLowerCase() !== normalizedRequest) continue;
    if (aliasTrackType === undefined) {
      aliasTrackType = candidateTrackType;
      aliasValue = candidate;
      continue;
    }
    if (candidateTrackType !== aliasTrackType) return { status: 'ambiguous' };
  }

  return aliasValue === undefined
    ? { status: 'missing' }
    : {
        status: 'matched',
        matchKind: 'unique-case-insensitive-alias',
        value: aliasValue,
      };
}

export function findAnnotationTrackIdentity<T>(
  requestedTrackType: string,
  candidates: Iterable<T>,
  readTrackType: (candidate: T) => string
): T | null {
  const resolution = resolveAnnotationTrackIdentity(requestedTrackType, candidates, readTrackType);
  return resolution.status === 'matched' ? resolution.value : null;
}
