export type RegisteredRouteAvailability = 'ready' | 'setup-required' | 'pending' | 'unavailable';

export interface RegisteredRouteCandidate<TSelection> {
  selection: TSelection;
  availability: RegisteredRouteAvailability;
}

export function pickPreferredRegisteredRoute<TSelection>(
  candidates: readonly RegisteredRouteCandidate<TSelection>[]
): TSelection | null {
  return (
    candidates.find((candidate) => candidate.availability === 'ready')?.selection ??
    candidates.find((candidate) => candidate.availability === 'setup-required')?.selection ??
    null
  );
}
