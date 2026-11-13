import type { AggregatedMutation, VerificationSession } from '../../types';

export function aggregateMutations(session: VerificationSession): AggregatedMutation[] {
  const mutationMap = new Map<string, { mutation: AggregatedMutation; trackIds: Set<string> }>();

  const totalTracks = session.tracks.length;

  for (const track of session.tracks) {
    for (const mutation of track.mutations) {
      const key = `${mutation.position}:${mutation.type}:${mutation.referenceBase}:${mutation.alternateBase}`;

      const existing = mutationMap.get(key);
      if (existing) {
        existing.trackIds.add(track.id);
      } else {
        mutationMap.set(key, {
          mutation: {
            ...mutation,
            trackIds: [],
            hasConflict: false,
          },
          trackIds: new Set([track.id]),
        });
      }
    }
  }

  const result: AggregatedMutation[] = [];

  for (const { mutation, trackIds } of mutationMap.values()) {
    result.push({
      ...mutation,
      trackIds: Array.from(trackIds),
      hasConflict: trackIds.size < totalTracks,
    });
  }

  result.sort((a, b) => a.position - b.position);

  return result;
}
