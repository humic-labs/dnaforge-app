import type { VerificationSession } from '../types';

export function detectPerSessionStaleness(
  sessions: readonly VerificationSession[],
  checksumStale: boolean,
  currentSequenceLength: number | null,
  currentReference?: {
    fileSha256?: string | null;
    sequenceRevision: string;
    topology: 'linear' | 'circular';
    checkpointId?: string | null;
  } | null
): Set<string> {
  const stale = new Set<string>();
  for (const session of sessions) {
    for (const track of session.tracks) {
      if (track.testedReference) {
        if (
          !currentReference ||
          track.testedReference.sequenceRevision !== currentReference.sequenceRevision ||
          track.testedReference.topology !== currentReference.topology ||
          (currentReference.checkpointId !== undefined &&
            track.testedReference.checkpointId !== currentReference.checkpointId)
        ) {
          stale.add(session.id);
          break;
        }
        continue;
      }
      if (checksumStale) {
        stale.add(session.id);
        break;
      }
      if (currentSequenceLength == null) continue;
      const ar = track.alignment?.alignedReference;
      if (!ar) continue;
      let nonGapCount = 0;
      for (let i = 0; i < ar.length; i++) if (ar[i] !== '-') nonGapCount++;
      if (nonGapCount !== currentSequenceLength) {
        console.warn(`[staleness] Legacy session ${session.id}: reference length changed`);
        stale.add(session.id);
        break;
      }
    }
  }

  return stale;
}
