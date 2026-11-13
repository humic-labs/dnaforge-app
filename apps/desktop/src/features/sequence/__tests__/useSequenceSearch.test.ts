import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useSequenceSearch } from '@waypoint/workspace-editor';

const TEST_SEQUENCE = 'ATGATGATGATGATGATGATG';

const TEST_ANNOTATIONS = [
  {
    name: 'GFP',
    type: 'CDS',
    start: 1,
    end: 18,
    direction: 1,
    qualifiers: { gene: ['gfp'], translation: ['MMMMMM'] },
  },
  {
    name: 'Promoter',
    type: 'misc_feature',
    start: 1,
    end: 6,
    direction: 1,
    qualifiers: { note: ['T7 promoter region'] },
  },
];

describe('useSequenceSearch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts in closed state with empty results', () => {
    const { result } = renderHook(() =>
      useSequenceSearch({
        sequence: TEST_SEQUENCE,
        annotations: TEST_ANNOTATIONS,
      })
    );

    expect(result.current.isOpen).toBe(false);
    expect(result.current.query).toBe('');
    expect(result.current.mode).toBe('nucleotide');
    expect(result.current.matches).toEqual([]);
    expect(result.current.matchCount).toBe(0);
    expect(result.current.activeIndex).toBe(0);
    expect(result.current.isError).toBe(false);
    expect(result.current.errorMessage).toBeNull();
    expect(result.current.scrollToPosition).toBeNull();
  });

  it('openInMode("nucleotide") opens in nucleotide mode', () => {
    const { result } = renderHook(() =>
      useSequenceSearch({
        sequence: TEST_SEQUENCE,
        annotations: TEST_ANNOTATIONS,
      })
    );

    act(() => {
      result.current.openInMode('nucleotide');
    });

    expect(result.current.isOpen).toBe(true);
    expect(result.current.mode).toBe('nucleotide');
  });

  it('openInMode("aminoAcid") opens in AA mode', () => {
    const { result } = renderHook(() =>
      useSequenceSearch({
        sequence: TEST_SEQUENCE,
        annotations: TEST_ANNOTATIONS,
      })
    );

    act(() => {
      result.current.openInMode('aminoAcid');
    });

    expect(result.current.isOpen).toBe(true);
    expect(result.current.mode).toBe('aminoAcid');
  });

  it('switches mode when already open in a different mode', () => {
    const { result } = renderHook(() =>
      useSequenceSearch({
        sequence: TEST_SEQUENCE,
        annotations: TEST_ANNOTATIONS,
      })
    );

    act(() => {
      result.current.openInMode('nucleotide');
    });
    expect(result.current.mode).toBe('nucleotide');

    act(() => {
      result.current.openInMode('aminoAcid');
    });
    expect(result.current.mode).toBe('aminoAcid');
    expect(result.current.isOpen).toBe(true);
  });

  it('close() resets all state', () => {
    const { result } = renderHook(() =>
      useSequenceSearch({
        sequence: TEST_SEQUENCE,
        annotations: TEST_ANNOTATIONS,
      })
    );

    act(() => {
      result.current.openInMode('nucleotide');
      result.current.setQuery('ATG');
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current.matches.length).toBeGreaterThan(0);

    act(() => {
      result.current.close();
    });

    expect(result.current.isOpen).toBe(false);
    expect(result.current.query).toBe('');
    expect(result.current.matches).toEqual([]);
    expect(result.current.activeIndex).toBe(0);
    expect(result.current.isError).toBe(false);
    expect(result.current.errorMessage).toBeNull();
  });

  it('setQuery triggers debounced search after 150ms', () => {
    const { result } = renderHook(() =>
      useSequenceSearch({
        sequence: TEST_SEQUENCE,
        annotations: TEST_ANNOTATIONS,
      })
    );

    act(() => {
      result.current.openInMode('nucleotide');
      result.current.setQuery('ATG');
    });

    expect(result.current.matches).toEqual([]);

    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(result.current.matches.length).toBeGreaterThan(0);
    expect(result.current.matchCount).toBeGreaterThan(0);
  });

  it('empty query clears matches immediately without debounce', () => {
    const { result } = renderHook(() =>
      useSequenceSearch({
        sequence: TEST_SEQUENCE,
        annotations: TEST_ANNOTATIONS,
      })
    );

    act(() => {
      result.current.openInMode('nucleotide');
      result.current.setQuery('ATG');
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current.matches.length).toBeGreaterThan(0);

    act(() => {
      result.current.setQuery('');
    });
    expect(result.current.matches).toEqual([]);
    expect(result.current.query).toBe('');
  });

  it('next() cycles forward with wrap-around', () => {
    const { result } = renderHook(() =>
      useSequenceSearch({
        sequence: TEST_SEQUENCE,
        annotations: TEST_ANNOTATIONS,
      })
    );

    act(() => {
      result.current.openInMode('nucleotide');
      result.current.setQuery('ATG');
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    const total = result.current.matchCount;
    expect(total).toBeGreaterThan(1);
    expect(result.current.activeIndex).toBe(0);

    act(() => {
      result.current.next();
    });
    expect(result.current.activeIndex).toBe(1);

    for (let i = 2; i < total; i++) {
      act(() => {
        result.current.next();
      });
    }
    expect(result.current.activeIndex).toBe(total - 1);

    act(() => {
      result.current.next();
    });
    expect(result.current.activeIndex).toBe(0);
  });

  it('prev() cycles backward with wrap-around', () => {
    const { result } = renderHook(() =>
      useSequenceSearch({
        sequence: TEST_SEQUENCE,
        annotations: TEST_ANNOTATIONS,
      })
    );

    act(() => {
      result.current.openInMode('nucleotide');
      result.current.setQuery('ATG');
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    const total = result.current.matchCount;
    expect(total).toBeGreaterThan(1);
    expect(result.current.activeIndex).toBe(0);

    act(() => {
      result.current.prev();
    });
    expect(result.current.activeIndex).toBe(total - 1);

    act(() => {
      result.current.prev();
    });
    expect(result.current.activeIndex).toBe(total - 2);
  });

  it('next/prev are no-op when 0 matches', () => {
    const { result } = renderHook(() =>
      useSequenceSearch({
        sequence: TEST_SEQUENCE,
        annotations: TEST_ANNOTATIONS,
      })
    );

    act(() => {
      result.current.openInMode('nucleotide');
    });

    expect(result.current.matchCount).toBe(0);

    act(() => {
      result.current.next();
    });
    expect(result.current.activeIndex).toBe(0);

    act(() => {
      result.current.prev();
    });
    expect(result.current.activeIndex).toBe(0);
  });

  it('scrollToPosition is match.start + 1 (1-indexed)', () => {
    const { result } = renderHook(() =>
      useSequenceSearch({
        sequence: TEST_SEQUENCE,
        annotations: TEST_ANNOTATIONS,
      })
    );

    act(() => {
      result.current.openInMode('nucleotide');
      result.current.setQuery('ATG');
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(result.current.matches.length).toBeGreaterThan(0);
    const firstMatch = result.current.matches[0];
    expect(result.current.scrollToPosition).toBe(firstMatch.start + 1);
  });

  it('scrollToPosition is null when no matches', () => {
    const { result } = renderHook(() =>
      useSequenceSearch({
        sequence: TEST_SEQUENCE,
        annotations: TEST_ANNOTATIONS,
      })
    );

    act(() => {
      result.current.openInMode('nucleotide');
    });

    expect(result.current.scrollToPosition).toBeNull();
  });

  it('scrollToPosition is null after releaseActiveHighlight, even with an active match', () => {
    const { result } = renderHook(() =>
      useSequenceSearch({
        sequence: TEST_SEQUENCE,
        annotations: TEST_ANNOTATIONS,
      })
    );

    act(() => {
      result.current.openInMode('nucleotide');
      result.current.setQuery('ATG');
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current.matches.length).toBeGreaterThan(0);
    expect(result.current.scrollToPosition).not.toBeNull();

    act(() => {
      result.current.releaseActiveHighlight();
    });

    expect(result.current.scrollToPosition).toBeNull();
    expect(result.current.activeHighlightRange).toBeNull();
    expect(result.current.matches.length).toBeGreaterThan(0);
  });

  it('goToMatch re-engages scrollToPosition after a release', () => {
    const { result } = renderHook(() =>
      useSequenceSearch({
        sequence: TEST_SEQUENCE,
        annotations: TEST_ANNOTATIONS,
      })
    );

    act(() => {
      result.current.openInMode('nucleotide');
      result.current.setQuery('ATG');
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    act(() => {
      result.current.releaseActiveHighlight();
    });
    expect(result.current.scrollToPosition).toBeNull();

    act(() => {
      result.current.goToMatch(1);
    });

    expect(result.current.activeIndex).toBe(1);
    expect(result.current.scrollToPosition).toBe(result.current.matches[1].start + 1);
  });

  it('next()/prev() always preview-navigate — no separate browsing tier that suppresses scrollToPosition', () => {
    const { result } = renderHook(() =>
      useSequenceSearch({
        sequence: TEST_SEQUENCE,
        annotations: TEST_ANNOTATIONS,
      })
    );

    act(() => {
      result.current.openInMode('nucleotide');
      result.current.setQuery('ATG');
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current.scrollToPosition).not.toBeNull();

    act(() => {
      result.current.next();
    });

    expect(result.current.scrollToPosition).toBe(
      result.current.matches[result.current.activeIndex].start + 1
    );
    expect(result.current.activeHighlightRange).not.toBeNull();

    act(() => {
      result.current.prev();
    });

    expect(result.current.scrollToPosition).toBe(
      result.current.matches[result.current.activeIndex].start + 1
    );
  });

  it('isActiveReverse is true when active match is on reverse strand', () => {
    const { result } = renderHook(() =>
      useSequenceSearch({
        sequence: TEST_SEQUENCE,
        annotations: TEST_ANNOTATIONS,
      })
    );

    act(() => {
      result.current.openInMode('nucleotide');
      result.current.setQuery('CAT');
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    if (result.current.matches.length > 0) {
      const reverseMatches = result.current.matches.filter((m) => m.strand === 'reverse');
      expect(reverseMatches.length).toBeGreaterThan(0);

      const reverseIdx = result.current.matches.findIndex((m) => m.strand === 'reverse');
      for (let i = 0; i < reverseIdx; i++) {
        act(() => {
          result.current.next();
        });
      }
      expect(result.current.isActiveReverse).toBe(true);
    }
  });

  it('setMode clears results and re-searches after debounce', () => {
    const { result } = renderHook(() =>
      useSequenceSearch({
        sequence: TEST_SEQUENCE,
        annotations: TEST_ANNOTATIONS,
      })
    );

    act(() => {
      result.current.openInMode('nucleotide');
      result.current.setQuery('ATG');
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    const nucleotideCount = result.current.matchCount;
    expect(nucleotideCount).toBeGreaterThan(0);

    act(() => {
      result.current.setMode('aminoAcid');
    });
    expect(result.current.matches).toEqual([]);
    expect(result.current.mode).toBe('aminoAcid');

    act(() => {
      vi.advanceTimersByTime(200);
    });
  });

  it('error in search engine sets isError and errorMessage', async () => {
    const seqUtils = await import('@waypoint/sequence-utils');
    const origSearch = seqUtils.searchNucleotide;
    vi.spyOn(seqUtils, 'searchNucleotide').mockImplementation(() => {
      throw new Error('Bad pattern');
    });

    const { result } = renderHook(() =>
      useSequenceSearch({
        sequence: TEST_SEQUENCE,
        annotations: TEST_ANNOTATIONS,
      })
    );

    act(() => {
      result.current.openInMode('nucleotide');
      result.current.setQuery('BAD');
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(result.current.isError).toBe(true);
    expect(result.current.errorMessage).toBe('Invalid pattern');
    expect(result.current.matches).toEqual([]);

    vi.mocked(seqUtils.searchNucleotide).mockImplementation(origSearch);
  });

  it('aminoAcid mode finds annotation by name', () => {
    const annotationsWithLabel = [
      {
        name: 'GFP',
        label: 'GFP',
        type: 'CDS',
        start: 1,
        end: 18,
        direction: 1,
        qualifiers: { gene: ['gfp'] },
      },
    ];

    const { result } = renderHook(() =>
      useSequenceSearch({
        sequence: TEST_SEQUENCE,
        annotations: annotationsWithLabel,
      })
    );

    act(() => {
      result.current.openInMode('aminoAcid');
    });
    act(() => {
      result.current.setQuery('GFP');
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(result.current.matches.length).toBeGreaterThan(0);
    const annotationMatch = result.current.matches.find((m) => m.type === 'annotation');
    expect(annotationMatch).toBeDefined();
    expect(annotationMatch?.label).toBe('GFP');
  });
  it('revokes the previous query before debounced replacement and navigation', () => {
    const { result } = renderHook(() =>
      useSequenceSearch({
        sequence: 'ATGAAATTTGGGCCCTAA',
        annotations: TEST_ANNOTATIONS,
      })
    );

    act(() => result.current.openInMode('nucleotide'));
    act(() => result.current.setQuery('ATGAAA'));
    act(() => vi.advanceTimersByTime(150));
    expect(result.current.matches).toEqual([
      expect.objectContaining({ start: 0, end: 5, strand: 'forward' }),
    ]);

    act(() => result.current.setQuery('TTTGGG'));
    expect(result.current.query).toBe('TTTGGG');
    expect(result.current.matches).toEqual([]);
    expect(result.current.activeHighlightRange).toBeNull();
    expect(result.current.scrollToPosition).toBeNull();

    act(() => {
      result.current.next();
      result.current.prev();
      result.current.goToMatch(0);
      vi.advanceTimersByTime(149);
    });
    expect(result.current.matches).toEqual([]);
    expect(result.current.activeHighlightRange).toBeNull();
    expect(result.current.scrollToPosition).toBeNull();

    act(() => vi.advanceTimersByTime(1));
    expect(result.current.matches).toEqual([
      expect.objectContaining({ start: 6, end: 11, strand: 'forward' }),
    ]);
    expect(result.current.activeHighlightRange).toEqual({ start: 6, end: 11, wraps: undefined });
    expect(result.current.scrollToPosition).toBe(7);
  });

  it('does not restore pending matches from the previous sequence', () => {
    const { result, rerender } = renderHook(
      ({ sequence }) => useSequenceSearch({ sequence, annotations: TEST_ANNOTATIONS }),
      { initialProps: { sequence: 'ATGAAATTTGGGCCCTAA' } }
    );

    act(() => result.current.openInMode('nucleotide'));
    act(() => result.current.setQuery('TTTGGG'));
    rerender({ sequence: 'ATGAAACCCCCCTAA' });
    expect(result.current.matches).toEqual([]);

    act(() => vi.advanceTimersByTime(150));
    expect(result.current.matches).toEqual([]);
    expect(result.current.activeHighlightRange).toBeNull();
    expect(result.current.scrollToPosition).toBeNull();
  });

  it('revokes old matches when the Find command switches the open search mode', () => {
    const { result } = renderHook(() =>
      useSequenceSearch({
        sequence: 'ATGAAATTTGGGCCCTAA',
        annotations: TEST_ANNOTATIONS,
      })
    );

    act(() => result.current.openInMode('nucleotide'));
    act(() => result.current.setQuery('ATGAAA'));
    act(() => vi.advanceTimersByTime(150));
    expect(result.current.matchCount).toBe(1);

    act(() => result.current.openInMode('aminoAcid'));
    expect(result.current.mode).toBe('aminoAcid');
    expect(result.current.matches).toEqual([]);
    expect(result.current.activeHighlightRange).toBeNull();
    expect(result.current.scrollToPosition).toBeNull();

    act(() => vi.advanceTimersByTime(150));
    expect(result.current.matches).toEqual([]);
  });

  it('does not restore pending origin-crossing matches after circularity changes', () => {
    const { result, rerender } = renderHook(
      ({ circular }) =>
        useSequenceSearch({
          sequence: 'ATGAAATTTGGGCCCTAA',
          annotations: TEST_ANNOTATIONS,
          circular,
        }),
      { initialProps: { circular: true } }
    );

    act(() => result.current.openInMode('nucleotide'));
    act(() => result.current.setQuery('TAAATG'));
    act(() => vi.advanceTimersByTime(150));
    expect(result.current.matches).toEqual([
      expect.objectContaining({ start: 15, end: 2, strand: 'forward', wraps: true }),
    ]);
    act(() => result.current.setQuery('TAAATG'));
    rerender({ circular: false });

    act(() => vi.advanceTimersByTime(150));
    expect(result.current.matches).toEqual([]);
    expect(result.current.activeHighlightRange).toBeNull();
    expect(result.current.scrollToPosition).toBeNull();
  });

  it('does not restore pending matches from an earlier annotation revision', () => {
    const { result, rerender } = renderHook(
      ({ annotations }) => useSequenceSearch({ sequence: TEST_SEQUENCE, annotations }),
      { initialProps: { annotations: TEST_ANNOTATIONS } }
    );

    act(() => result.current.openInMode('aminoAcid'));
    act(() => result.current.setQuery('GFP'));
    rerender({ annotations: [] });
    act(() => vi.advanceTimersByTime(150));

    expect(result.current.matches).toEqual([]);
    expect(result.current.activeHighlightRange).toBeNull();
    expect(result.current.scrollToPosition).toBeNull();
  });

  it('clears the previous query error while a valid replacement is pending', () => {
    const { result } = renderHook(() =>
      useSequenceSearch({ sequence: TEST_SEQUENCE, annotations: TEST_ANNOTATIONS })
    );

    act(() => result.current.openInMode('nucleotide'));
    act(() => result.current.setQuery('??'));
    act(() => vi.advanceTimersByTime(150));
    expect(result.current.isError).toBe(true);
    expect(result.current.errorMessage).toBe('Invalid pattern');

    act(() => result.current.setQuery('ATG'));
    expect(result.current.isError).toBe(false);
    expect(result.current.errorMessage).toBeNull();
    expect(result.current.matches).toEqual([]);
    act(() => vi.advanceTimersByTime(150));
    expect(result.current.matchCount).toBeGreaterThan(0);
  });

  it('does not revive a pending query after close and immediate reopen', () => {
    const { result } = renderHook(() =>
      useSequenceSearch({ sequence: TEST_SEQUENCE, annotations: TEST_ANNOTATIONS })
    );

    act(() => result.current.openInMode('nucleotide'));
    act(() => result.current.setQuery('ATG'));
    act(() => result.current.close());
    act(() => result.current.openInMode('aminoAcid'));
    act(() => vi.advanceTimersByTime(150));

    expect(result.current.isOpen).toBe(true);
    expect(result.current.query).toBe('');
    expect(result.current.matches).toEqual([]);
    expect(result.current.activeHighlightRange).toBeNull();
    expect(result.current.scrollToPosition).toBeNull();
  });
});
