import type { PrimerDisplay } from '@waypoint/workspace-editor';
import type { PrimerSearchResult } from '../primers/public/primer-search-service';

const MAX_CANDIDATE_PRIMER_DISPLAYS = 50;

export function candidatePrimerDisplaysFromSearch(
  searchResults: readonly PrimerSearchResult[],
  maxCandidates = MAX_CANDIDATE_PRIMER_DISPLAYS
): PrimerDisplay[] {
  if (searchResults.length === 0) return [];
  return searchResults
    .filter((result) => !result.isAttached)
    .slice(0, maxCandidates)
    .flatMap((result) =>
      result.bestHit
        ? [
            {
              id: `__candidate_${result.primer.id}__`,
              name: result.primer.name,
              bases: result.primer.sequence,
              start: result.bestHit.start,
              end: result.bestHit.end,
              direction: (result.bestHit.strand === 1 ? 'forward' : 'reverse') as
                | 'forward'
                | 'reverse',
              tm: result.bestHit.effectiveTm || result.primer.tm || 0,
              gc: result.primer.gcPercent,
              overhangLength: 0,
              pbsColor: '#D97706',
              isCandidate: true,
              mismatches: result.bestHit.mismatchPositions.map((pos) => ({
                position: pos,
                oligoBase: '',
                templateBase: '',
              })),
            },
          ]
        : []
    );
}
