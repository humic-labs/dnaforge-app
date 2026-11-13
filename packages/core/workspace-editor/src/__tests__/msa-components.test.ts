import { describe, it, expect } from 'vitest';
import { mapAlignmentToRefCoords } from '../msa-utils';
import type { MSATrackData } from '../msa-utils';

describe('mapAlignmentToRefCoords', () => {
  it('maps a perfect match', () => {
    const result = mapAlignmentToRefCoords('ATCG', 'ATCG');
    expect(result.bases).toHaveLength(4);
    expect(result.insertions).toHaveLength(0);
    result.bases.forEach((b) => {
      expect(b.mutation).toBeNull();
    });
  });

  it('detects substitutions', () => {
    const result = mapAlignmentToRefCoords('ATCG', 'AACG');
    expect(result.bases[1].mutation).toBe('substitution');
    expect(result.bases[1].base).toBe('A');
    expect(result.bases[1].refBase).toBe('T');
    expect(result.bases[0].mutation).toBeNull();
  });

  it('detects deletions (gap in query)', () => {
    const result = mapAlignmentToRefCoords('ATCG', 'A-CG');
    expect(result.bases[1].mutation).toBe('deletion');
    expect(result.bases[1].base).toBe('-');
  });

  it('detects insertions (gap in reference)', () => {
    const result = mapAlignmentToRefCoords('A-TCG', 'AXTCG');
    expect(result.bases).toHaveLength(4);
    expect(result.insertions).toHaveLength(1);
    expect(result.insertions[0].afterRefPos).toBe(0);
    expect(result.insertions[0].bases).toBe('X');
  });

  it('handles multiple insertions at same position', () => {
    const result = mapAlignmentToRefCoords('A--TCG', 'AXYTCG');
    expect(result.bases).toHaveLength(4);
    expect(result.insertions).toHaveLength(1);
    expect(result.insertions[0].bases).toBe('XY');
  });

  it('handles empty sequences', () => {
    const result = mapAlignmentToRefCoords('', '');
    expect(result.bases).toHaveLength(0);
    expect(result.insertions).toHaveLength(0);
  });

  it('handles complex mixed mutations', () => {
    const result = mapAlignmentToRefCoords('ATCGA', 'A-XGA');
    expect(result.bases).toHaveLength(5);
    expect(result.bases[0].mutation).toBeNull();
    expect(result.bases[1].mutation).toBe('deletion');
    expect(result.bases[2].mutation).toBe('substitution');
    expect(result.bases[3].mutation).toBeNull();
    expect(result.bases[4].mutation).toBeNull();
  });
});

describe('MSATrackData structure', () => {
  it('can be constructed from mapAlignmentToRefCoords output', () => {
    const alignment = mapAlignmentToRefCoords('ATCGATCG', 'ATCAATCG');
    const track: MSATrackData = {
      id: 'test-1',
      label: 'Clone 1',
      alignment,
      status: 'variants',
      identity: 87.5,
    };

    expect(track.alignment.bases).toHaveLength(8);
    expect(track.alignment.bases[3].mutation).toBe('substitution');
    expect(track.status).toBe('variants');
  });
});

describe('Zustand selector stability simulation', () => {
  interface MockSession {
    id: string;
    tracks: Array<{
      id: string;
      label: string;
      status: 'pass' | 'variants' | 'fail';
      alignment: {
        alignedReference: string;
        alignedQuery: string;
        identity: number;
      };
    }>;
  }

  function deriveTracks(
    session: MockSession | null,
    hiddenTrackIds: string[] | undefined
  ): MSATrackData[] {
    if (!session || session.tracks.length === 0) return [];

    const hiddenIds = new Set(hiddenTrackIds ?? []);

    const visibleTracks = session.tracks.filter(
      (t) => !hiddenIds.has(t.id) && t.alignment?.alignedReference && t.alignment?.alignedQuery
    );

    if (visibleTracks.length === 0) return [];

    return visibleTracks.map((t) => ({
      id: t.id,
      label: t.label,
      alignment: mapAlignmentToRefCoords(t.alignment.alignedReference, t.alignment.alignedQuery),
      status: t.status,
      identity: t.alignment?.identity ?? 0,
    }));
  }

  const mockSession: MockSession = {
    id: 'session-1',
    tracks: [
      {
        id: 'track-1',
        label: 'Clone A',
        status: 'pass',
        alignment: {
          alignedReference: 'ATCGATCG',
          alignedQuery: 'ATCGATCG',
          identity: 100,
        },
      },
      {
        id: 'track-2',
        label: 'Clone B',
        status: 'variants',
        alignment: {
          alignedReference: 'ATCGATCG',
          alignedQuery: 'ATCAATCG',
          identity: 87.5,
        },
      },
    ],
  };

  it('returns empty array for null session', () => {
    expect(deriveTracks(null, undefined)).toEqual([]);
  });

  it('derives correct track count', () => {
    const result = deriveTracks(mockSession, undefined);
    expect(result).toHaveLength(2);
  });

  it('filters hidden tracks', () => {
    const result = deriveTracks(mockSession, ['track-1']);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('track-2');
  });

  it('maps alignments correctly', () => {
    const result = deriveTracks(mockSession, undefined);
    expect(result[0].alignment.bases.every((b) => b.mutation === null)).toBe(true);
    expect(result[1].alignment.bases[3].mutation).toBe('substitution');
  });

  it('preserves identity values', () => {
    const result = deriveTracks(mockSession, undefined);
    expect(result[0].identity).toBe(100);
    expect(result[1].identity).toBe(87.5);
  });
});
