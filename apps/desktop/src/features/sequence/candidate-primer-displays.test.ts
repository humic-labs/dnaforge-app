import { describe, expect, it } from 'vitest';
import type { PrimerSearchResult } from '../primers/primer-search-service';
import { candidatePrimerDisplaysFromSearch } from './candidate-primer-displays';

function result(overrides: Partial<PrimerSearchResult> & { primerId: number }): PrimerSearchResult {
  return {
    primer: {
      id: overrides.primerId,
      name: `p${overrides.primerId}`,
      sequence: 'ACGT',
      tm: 55,
      gcPercent: 50,
    } as PrimerSearchResult['primer'],
    hits: [],
    bestHit: overrides.bestHit ?? {
      start: 10,
      end: 14,
      strand: 1,
      identity: 1,
      editDistance: 0,
      mismatchPositions: [11],
      threePrimeMatchLength: 4,
      effectiveTm: 54,
    },
    isAttached: overrides.isAttached ?? false,
    ...overrides,
  };
}

describe('candidatePrimerDisplaysFromSearch', () => {
  it('returns no ghosts when search is empty', () => {
    expect(candidatePrimerDisplaysFromSearch([])).toEqual([]);
  });

  it('skips attached primers and primers without a best hit', () => {
    const displays = candidatePrimerDisplaysFromSearch([
      result({ primerId: 1, isAttached: true }),
      result({ primerId: 2, bestHit: null }),
      result({ primerId: 3, isAttached: false }),
    ]);
    expect(displays.map((d) => d.id)).toEqual(['__candidate_3__']);
    expect(displays[0]?.isCandidate).toBe(true);
    expect(displays[0]?.mismatches).toEqual([{ position: 11, oligoBase: '', templateBase: '' }]);
  });

  it('caps unattached candidates', () => {
    const results = Array.from({ length: 60 }, (_, i) => result({ primerId: i + 1 }));
    expect(candidatePrimerDisplaysFromSearch(results)).toHaveLength(50);
  });
});
