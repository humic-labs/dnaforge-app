import { userMessage } from '@waypoint/user-messages';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PREPACKED_ANNOTATION_SEARCH_MAX_QUERY_CODE_UNITS_V1 } from '@waypoint/genome-data';

import type {
  AssemblyAnnotationSceneReadRequest,
  AssemblyAnnotationSearchQueryResultV1,
  AssemblySequenceSearchSourceV1,
} from '../../../shared/indexed-genome';
import { ASSEMBLY_SEQUENCE_SEARCH_SOURCE_V1 } from '../../../shared/indexed-genome';
import type { AnnotationIndex, AnnotationIndexMatch } from '../genome-annotation-index';

const {
  queryAssemblyAnnotationSearch,
  queryAssemblyProteinSearch,
  searchSequence,
  searchAssemblySequence,
} = vi.hoisted(() => ({
  queryAssemblyAnnotationSearch: vi.fn(),
  queryAssemblyProteinSearch: vi.fn(),
  searchSequence: vi.fn(),
  searchAssemblySequence: vi.fn(),
}));

vi.mock('../../../platform', () => ({
  platform: () => ({
    genome: {
      queryAssemblyAnnotationSearch,
      queryAssemblyProteinSearch,
      searchSequence,
      searchAssemblySequence,
    },
  }),
}));
import { useGenomeSearch } from './useGenomeSearch';

function annotationIndex(match: AnnotationIndexMatch): AnnotationIndex {
  return {
    size: 1,
    query: vi.fn(() => [match]),
  };
}

const HBB = {
  featureIndex: 0,
  start: 100,
  end: 200,
  label: 'HBB',
  featureType: 'gene',
  annotationTrackId: 'gene',
  canonicalIdentity: 'annotation.v2:test-hbb',
  direction: 'forward',
} satisfies AnnotationIndexMatch;

function assemblySearchSource(
  assemblyId: string,
  manifestRevision = assemblyId
): AssemblyAnnotationSceneReadRequest {
  return {
    ipcContractVersion: 'assembly-annotation-scene-ipc.v4',
    assemblyId,
    workspaceRoot: '/workspace',
    chromosomes: [
      {
        chrom: 'chr11',
        sourcePath: '/workspace/chr11.gff3.gz',
        length: 2_000,
        manifest: {
          chrom: 'chr11',
          fastaPath: `/workspace/chr11-${manifestRevision}.fa`,
          faiPath: `/workspace/chr11-${manifestRevision}.fa.fai`,
          gffPath: '/workspace/chr11.gff3.gz',
          tbiPath: `/workspace/chr11-${manifestRevision}.gff3.gz.tbi`,
        },
      },
    ],
    scope: {
      kind: 'complete-assembly',
      placements: [{ chrom: 'chr11', length: 2_000, annotationCoverage: 'sourced' }],
    },
    datasetContract: {
      datasetId: `${assemblyId}-annotations`,
      datasetVersion: '1',
      sourceSha256: 'a'.repeat(64),
    },
    artifact: {
      artifactKey: 'mRNA-light',
      themeMode: 'light',
      trackType: 'mRNA',
      partitionSpanBp: 100_000_000,
      annotationBarHeightPx: 14,
      laneAlgorithmToken: 'source-lanes.v1',
      mapperContractToken: 'annotation-isoform-mapper.v2',
      geometryContractToken: 'retained-linear-directional-block.v1',
      interactionContractToken: 'annotation-feature-hit-index.v3',
    },
    requestedPolicy: { isoformMode: 'canonical', laneLimit: 2 },
  } as AssemblyAnnotationSceneReadRequest;
}

function assemblySequenceSearchSource(): AssemblySequenceSearchSourceV1 {
  return {
    contract: ASSEMBLY_SEQUENCE_SEARCH_SOURCE_V1,
    assemblyId: 'grch38',
    chromosomes: [
      {
        chrom: 'chr1',
        length: 248_956_422,
        manifest: { chrom: 'chr1', fastaPath: '/chr1.fa', faiPath: '/chr1.fa.fai' },
      },
      {
        chrom: 'chr11',
        length: 135_086_622,
        manifest: { chrom: 'chr11', fastaPath: '/chr11.fa', faiPath: '/chr11.fa.fai' },
      },
    ],
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function assemblySearchHit(
  label: string,
  start = 100,
  end = 200
): Extract<AssemblyAnnotationSearchQueryResultV1, { status: 'hit' }> {
  return {
    status: 'hit',
    fingerprint: 'source-a',
    featureCount: 1,
    matches: [{ ...HBB, start, end, label }],
  };
}

describe('useGenomeSearch annotation index replacement', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    queryAssemblyAnnotationSearch.mockReset();
    queryAssemblyProteinSearch.mockReset();
    searchSequence.mockReset().mockResolvedValue([]);
    searchAssemblySequence.mockReset().mockResolvedValue({ hits: [], truncated: false });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reruns the current annotation query when the index becomes ready', async () => {
    const onJumpToMatch = vi.fn();
    const readyIndex = annotationIndex(HBB);
    const { result, rerender } = renderHook(
      ({ index }: { index: AnnotationIndex | null }) =>
        useGenomeSearch({
          manifest: null,
          chrom: null,
          annotationIndex: index,
          onJumpToMatch,
        }),
      { initialProps: { index: null as AnnotationIndex | null } }
    );

    act(() => {
      result.current.openInMode('aminoAcid');
    });
    act(() => {
      result.current.setQuery('HBB');
      vi.advanceTimersByTime(200);
    });
    expect(result.current.matches).toEqual([]);

    rerender({ index: readyIndex });
    await act(async () => Promise.resolve());

    expect(readyIndex.query).toHaveBeenCalledWith('HBB', 500);
    expect(result.current.matches).toEqual([
      expect.objectContaining({ label: 'HBB', featureType: 'gene', start: 100, end: 199 }),
    ]);
  });

  it('replaces stale results and click ownership when the index changes', async () => {
    const onJumpToMatch = vi.fn();
    const firstIndex = annotationIndex({ ...HBB, label: 'OLD-HBB', start: 100, end: 200 });
    const nextIndex = annotationIndex({ ...HBB, label: 'NEW-HBB', start: 900, end: 950 });
    const { result, rerender } = renderHook(
      ({ index }: { index: AnnotationIndex }) =>
        useGenomeSearch({
          manifest: null,
          chrom: null,
          annotationIndex: index,
          onJumpToMatch,
        }),
      { initialProps: { index: firstIndex } }
    );

    act(() => {
      result.current.openInMode('aminoAcid');
    });
    expect(result.current.annotationAuthorityRevision).toBe(firstIndex);
    act(() => {
      result.current.setQuery('HBB');
      vi.advanceTimersByTime(200);
    });
    expect(result.current.matches[0]?.label).toBe('OLD-HBB');

    rerender({ index: nextIndex });
    await act(async () => Promise.resolve());

    expect(result.current.annotationAuthorityRevision).toBe(nextIndex);
    expect(nextIndex.query).toHaveBeenCalledWith('HBB', 500);
    expect(result.current.matches.map((match) => match.label)).toEqual(['NEW-HBB']);

    act(() => result.current.goToMatch(0));
    expect(onJumpToMatch).toHaveBeenCalledOnce();
    expect(onJumpToMatch).toHaveBeenCalledWith({
      start: 900,
      end: 949,
      strand: 'forward',
      type: 'annotation',
      label: 'NEW-HBB',
      featureType: 'gene',
      annotation: {
        type: 'gene',
        name: 'NEW-HBB',
        start: 901,
        end: 950,
        direction: 1,
      },
      annotationFeatureIndex: 0,
      annotationTrackId: 'gene',
      canonicalIdentity: 'annotation.v2:test-hbb',
    });
  });

  it('preserves reverse direction and marks results from a hidden logical track', async () => {
    const reverseHidden = {
      ...HBB,
      label: 'NR_131224.2',
      featureType: 'ncRNA',
      annotationTrackId: 'lnc_RNA',
      canonicalIdentity: 'annotation.v2:NR_131224.2',
      direction: 'reverse' as const,
    };
    const visibleTracks = new Set(['gene', 'mRNA']);
    const reverseIndex = annotationIndex(reverseHidden);
    const { result } = renderHook(() =>
      useGenomeSearch({
        manifest: null,
        chrom: null,
        annotationIndex: reverseIndex,
        visibleAnnotationTrackIds: visibleTracks,
        onJumpToMatch: vi.fn(),
      })
    );

    act(() => result.current.openInMode('aminoAcid'));
    await act(async () => {
      result.current.setQuery('NR_131224.2');
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });

    expect(result.current.matches).toEqual([
      expect.objectContaining({
        label: 'NR_131224.2',
        strand: 'reverse',
        annotation: expect.objectContaining({ direction: -1 }),
        annotationTrackVisibility: 'hidden',
      }),
    ]);
    expect(result.current.isActiveReverse).toBe(true);
  });

  it('does not mark an ambiguous case-insensitive track alias as visible', async () => {
    const ambiguousTrack = {
      ...HBB,
      label: 'DM88',
      featureType: 'transposon',
      annotationTrackId: 'transposon:dm88',
      canonicalIdentity: 'annotation.v2:transposon-dm88',
    };
    const visibleTracks = new Set(['transposon:DM88', 'transposon:Dm88']);
    const ambiguousIndex = annotationIndex(ambiguousTrack);
    const { result } = renderHook(() =>
      useGenomeSearch({
        manifest: null,
        chrom: null,
        annotationIndex: ambiguousIndex,
        visibleAnnotationTrackIds: visibleTracks,
        onJumpToMatch: vi.fn(),
      })
    );

    act(() => result.current.openInMode('aminoAcid'));
    await act(async () => {
      result.current.setQuery('DM88');
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });

    expect(result.current.matches).toEqual([
      expect.objectContaining({
        label: 'DM88',
        annotationTrackId: 'transposon:dm88',
        annotationTrackVisibility: 'hidden',
      }),
    ]);
  });

  it('projects off-anchor packed annotations to chromosome-local labels but navigates globally', async () => {
    const source = assemblySearchSource('grch38');
    source.chromosomes = [
      { chrom: 'chr1', sourcePath: '/workspace/chr1.gff3.gz', length: 248_956_422 },
      { chrom: 'chr11', sourcePath: '/workspace/chr11.gff3.gz', length: 135_086_622 },
    ];
    source.scope.placements = [
      { chrom: 'chr1', length: 248_956_422, annotationCoverage: 'sourced' },
      { chrom: 'chr11', length: 135_086_622, annotationCoverage: 'sourced' },
    ];
    const globalStart = 248_956_422 + 5_225_494;
    queryAssemblyAnnotationSearch.mockResolvedValue(
      assemblySearchHit('HBB', globalStart, globalStart + 1_606)
    );
    const onJumpToMatch = vi.fn();
    const { result } = renderHook(() =>
      useGenomeSearch({
        manifest: { chrom: 'chr1', fastaPath: '/chr1.fa', faiPath: '/chr1.fa.fai' },
        chrom: 'chr1',
        annotationIndex: null,
        assemblyAnnotationSearchSource: source,
        onJumpToMatch,
      })
    );

    act(() => result.current.openInMode('aminoAcid'));
    await act(async () => {
      result.current.setQuery('HBB');
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });

    expect(result.current.matches).toEqual([
      expect.objectContaining({
        chrom: 'chr11',
        localStart: 5_225_494,
        localEnd: 5_227_099,
        start: globalStart,
        end: globalStart + 1_605,
      }),
    ]);

    act(() => result.current.goToMatch(0));
    expect(onJumpToMatch).toHaveBeenCalledWith(
      expect.objectContaining({
        chrom: 'chr11',
        localStart: 5_225_494,
        start: globalStart,
      })
    );
  });

  it('merges exact junction-spanning peptide hits, groups isoforms, and preserves codon segments', async () => {
    const source = assemblySearchSource('grch38');
    source.chromosomes = [
      { chrom: 'chr1', sourcePath: '/workspace/chr1.gff3.gz', length: 248_956_422 },
      { chrom: 'chr11', sourcePath: '/workspace/chr11.gff3.gz', length: 135_086_622 },
    ];
    source.scope.placements = [
      { chrom: 'chr1', length: 248_956_422, annotationCoverage: 'sourced' },
      { chrom: 'chr11', length: 135_086_622, annotationCoverage: 'sourced' },
    ];
    queryAssemblyAnnotationSearch.mockResolvedValue({
      status: 'hit',
      fingerprint: 'source-a',
      featureCount: 0,
      matches: [],
    });
    const globalStart = 248_956_422 + 5_225_494;
    queryAssemblyProteinSearch.mockResolvedValue({
      status: 'hit',
      fingerprint: 'protein-a',
      featureCount: 2,
      truncated: false,
      limit: 500,
      matches: [
        {
          featureIndex: 2,
          proteinStart: 7,
          proteinEnd: 12,
          start: globalStart,
          end: globalStart + 115,
          segments: [
            { start: globalStart, end: globalStart + 6 },
            { start: globalStart + 106, end: globalStart + 115 },
          ],
          strand: 'reverse',
          geneticCode: 1,
          label: 'HBB isoform 2',
          geneId: 'HBB',
          transcriptId: 'NM_000519.4',
          featureType: 'mRNA',
          annotationTrackId: 'mRNA',
          canonicalIdentity: 'annotation.v2:hbb-2',
        },
        {
          featureIndex: 1,
          proteinStart: 2,
          proteinEnd: 7,
          start: globalStart + 200,
          end: globalStart + 215,
          segments: [{ start: globalStart + 200, end: globalStart + 215 }],
          strand: 'forward',
          geneticCode: 1,
          label: 'HBB isoform 1',
          geneId: 'HBB',
          transcriptId: 'NM_000518.5',
          featureType: 'mRNA',
          annotationTrackId: 'mRNA',
          canonicalIdentity: 'annotation.v2:hbb-1',
        },
      ],
    });
    const onJumpToMatch = vi.fn();
    const visibleTracks = new Set(['mRNA']);
    const { result } = renderHook(() =>
      useGenomeSearch({
        manifest: null,
        chrom: null,
        annotationIndex: null,
        assemblyAnnotationSearchSource: source,
        visibleAnnotationTrackIds: visibleTracks,
        onJumpToMatch,
      })
    );

    act(() => result.current.openInMode('aminoAcid'));
    await act(async () => {
      result.current.setQuery('MVHLT');
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });

    expect(queryAssemblyAnnotationSearch).toHaveBeenCalledOnce();
    expect(queryAssemblyProteinSearch).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'MVHLT', limit: 500 }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(result.current.matches.map((match) => match.protein?.transcriptId)).toEqual([
      'NM_000518.5',
      'NM_000519.4',
    ]);
    expect(result.current.matches[1]).toMatchObject({
      type: 'protein',
      strand: 'reverse',
      chrom: 'chr11',
      localStart: 5_225_494,
      annotationTrackVisibility: 'visible',
      protein: {
        geneId: 'HBB',
        transcriptId: 'NM_000519.4',
        segments: [
          { start: globalStart, end: globalStart + 6 },
          { start: globalStart + 106, end: globalStart + 115 },
        ],
      },
    });
    expect(result.current.isActiveReverse).toBe(false);

    act(() => result.current.goToMatch(1));
    expect(onJumpToMatch).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalIdentity: 'annotation.v2:hbb-2',
        protein: expect.objectContaining({
          segments: expect.arrayContaining([
            { start: globalStart, end: globalStart + 6 },
            { start: globalStart + 106, end: globalStart + 115 },
          ]),
        }),
      })
    );
    expect(result.current.isActiveReverse).toBe(true);
  });

  it('treats a protein artifact miss as unavailable without publishing partial annotation hits', async () => {
    queryAssemblyAnnotationSearch.mockResolvedValue(assemblySearchHit('PEPTI feature'));
    queryAssemblyProteinSearch.mockResolvedValue({
      status: 'miss',
      fingerprint: 'protein-a',
    });
    const { result } = renderHook(() =>
      useGenomeSearch({
        manifest: null,
        chrom: null,
        annotationIndex: null,
        assemblyAnnotationSearchSource: assemblySearchSource('source-a'),
        onJumpToMatch: vi.fn(),
      })
    );

    act(() => result.current.openInMode('aminoAcid'));
    await act(async () => {
      result.current.setQuery('PEPTI');
      vi.advanceTimersByTime(200);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(queryAssemblyAnnotationSearch).toHaveBeenCalledOnce();
    expect(queryAssemblyProteinSearch).toHaveBeenCalledOnce();
    expect(result.current.matches).toEqual([]);
    expect(result.current.isError).toBe(true);
    expect(result.current.errorMessage).toBe('Search index is unavailable for this reference.');
  });

  it('keeps exact protein hits ahead of a full annotation-name result bucket', async () => {
    queryAssemblyAnnotationSearch.mockResolvedValue({
      status: 'hit',
      fingerprint: 'source-a',
      featureCount: 500,
      matches: Array.from({ length: 500 }, (_, index) => ({
        ...HBB,
        featureIndex: index,
        start: index,
        end: index + 1,
        label: `annotation-${index}`,
        canonicalIdentity: `annotation.v2:test-${index}`,
      })),
      truncated: false,
    });
    queryAssemblyProteinSearch.mockResolvedValue({
      status: 'hit',
      fingerprint: 'protein-a',
      featureCount: 1,
      matches: [
        {
          featureIndex: 0,
          proteinStart: 0,
          proteinEnd: 5,
          start: 1_500,
          end: 1_515,
          segments: [{ start: 1_500, end: 1_515 }],
          strand: 'forward',
          geneticCode: 1,
          label: 'exact peptide',
          geneId: 'EXACT',
          transcriptId: 'exact-1',
          featureType: 'mRNA',
          annotationTrackId: 'mRNA',
          canonicalIdentity: 'annotation.v2:exact',
        },
      ],
      truncated: false,
      limit: 500,
    });
    const { result } = renderHook(() =>
      useGenomeSearch({
        manifest: null,
        chrom: null,
        annotationIndex: null,
        assemblyAnnotationSearchSource: assemblySearchSource('source-a'),
        onJumpToMatch: vi.fn(),
      })
    );

    act(() => result.current.openInMode('aminoAcid'));
    await act(async () => {
      result.current.setQuery('PEPTI');
      vi.advanceTimersByTime(200);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.matches).toHaveLength(500);
    expect(result.current.matches[0]).toMatchObject({
      type: 'protein',
      label: 'exact peptide',
    });
    expect(result.current.matches.at(-1)?.label).toBe('annotation-498');
    expect(result.current.matches.some((match) => match.label === 'annotation-499')).toBe(false);
    expect(result.current.isTruncated).toBe(true);
  });

  it('does not invoke the protein authority below the exact five-residue minimum', async () => {
    queryAssemblyAnnotationSearch.mockResolvedValue({
      status: 'hit',
      fingerprint: 'source-a',
      featureCount: 0,
      matches: [],
    });
    const { result } = renderHook(() =>
      useGenomeSearch({
        manifest: null,
        chrom: null,
        annotationIndex: null,
        assemblyAnnotationSearchSource: assemblySearchSource('source-a'),
        onJumpToMatch: vi.fn(),
      })
    );

    act(() => result.current.openInMode('aminoAcid'));
    await act(async () => {
      result.current.setQuery('MVHL');
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });

    expect(queryAssemblyAnnotationSearch).toHaveBeenCalledOnce();
    expect(queryAssemblyProteinSearch).not.toHaveBeenCalled();
  });

  it('surfaces a terminal annotation-index failure for the current feature query', () => {
    const onJumpToMatch = vi.fn();
    const { result, rerender } = renderHook(
      ({ error }: { error: unknown | null }) =>
        useGenomeSearch({
          manifest: null,
          chrom: null,
          annotationIndex: null,
          annotationIndexError: error,
          onJumpToMatch,
        }),
      { initialProps: { error: null as unknown | null } }
    );

    act(() => result.current.openInMode('aminoAcid'));
    act(() => {
      result.current.setQuery('HBB');
      vi.advanceTimersByTime(200);
    });
    expect(result.current.isError).toBe(false);

    rerender({ error: new Error('annotation search preparation timeout: deadline') });

    expect(result.current.isError).toBe(true);
    expect(result.current.errorMessage).toBe(userMessage('genome.searchFailed'));
    expect(result.current.matches).toEqual([]);
  });

  it('replaces stale remote hits when the assembly annotation authority changes', async () => {
    queryAssemblyAnnotationSearch.mockImplementation(async ({ source }) => ({
      status: 'hit' as const,
      fingerprint: source.assemblyId,
      featureCount: 1,
      matches: [
        {
          ...HBB,
          start: source.assemblyId === 'source-a' ? 100 : 900,
          end: source.assemblyId === 'source-a' ? 200 : 950,
          label: source.assemblyId === 'source-a' ? 'OLD-HBB' : 'NEW-HBB',
        },
      ],
    }));
    const onJumpToMatch = vi.fn();
    const { result, rerender } = renderHook(
      ({ source }: { source: AssemblyAnnotationSceneReadRequest }) =>
        useGenomeSearch({
          manifest: null,
          chrom: null,
          annotationIndex: null,
          assemblyAnnotationSearchSource: source,
          onJumpToMatch,
        }),
      { initialProps: { source: assemblySearchSource('source-a') } }
    );

    act(() => result.current.openInMode('aminoAcid'));
    await act(async () => {
      result.current.setQuery('HBB');
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });
    expect(result.current.matches[0]?.label).toBe('OLD-HBB');

    await act(async () => {
      rerender({ source: assemblySearchSource('source-b') });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.matches.map((match) => match.label)).toEqual(['NEW-HBB']);
    expect(queryAssemblyAnnotationSearch).toHaveBeenCalledTimes(2);
  });

  it('replaces remote hits when the exact manifest changes under the same assembly id', async () => {
    queryAssemblyAnnotationSearch.mockImplementation(async ({ source }) => ({
      status: 'hit' as const,
      fingerprint: source.chromosomes[0]?.manifest?.fastaPath ?? 'missing',
      featureCount: 1,
      matches: [
        {
          ...HBB,
          label: source.chromosomes[0]?.manifest?.fastaPath.includes('-b.') ? 'NEW-HBB' : 'OLD-HBB',
        },
      ],
    }));
    const { result, rerender } = renderHook(
      ({ source }: { source: AssemblyAnnotationSceneReadRequest }) =>
        useGenomeSearch({
          manifest: null,
          chrom: null,
          annotationIndex: null,
          assemblyAnnotationSearchSource: source,
          onJumpToMatch: vi.fn(),
        }),
      { initialProps: { source: assemblySearchSource('source-a', 'a') } }
    );

    act(() => result.current.openInMode('aminoAcid'));
    await act(async () => {
      result.current.setQuery('HBB');
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });
    expect(result.current.matches[0]?.label).toBe('OLD-HBB');

    await act(async () => {
      rerender({ source: assemblySearchSource('source-a', 'b') });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.matches[0]?.label).toBe('NEW-HBB');
    expect(queryAssemblyAnnotationSearch).toHaveBeenCalledTimes(2);
  });

  it('exposes and enforces the disk annotation minimum without changing nucleotide minimums', async () => {
    const onJumpToMatch = vi.fn();
    const { result } = renderHook(() =>
      useGenomeSearch({
        manifest: { chrom: 'chr11', fastaPath: '/chr11.fa', faiPath: '/chr11.fa.fai' },
        chrom: 'chr11',
        annotationIndex: null,
        assemblyAnnotationSearchSource: assemblySearchSource('source-a'),
        onJumpToMatch,
      })
    );

    act(() => result.current.openInMode('aminoAcid'));
    expect(result.current.minQueryLength).toBe(3);
    await act(async () => {
      result.current.setQuery('AR');
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });
    expect(queryAssemblyAnnotationSearch).not.toHaveBeenCalled();

    queryAssemblyAnnotationSearch.mockResolvedValue({
      status: 'hit',
      fingerprint: 'source-a',
      featureCount: 1,
      matches: [HBB],
    });
    await act(async () => {
      result.current.setQuery('HBB');
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });
    expect(queryAssemblyAnnotationSearch).toHaveBeenCalledOnce();
    expect(queryAssemblyAnnotationSearch).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'HBB', limit: 500 }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );

    act(() => result.current.setMode('nucleotide'));
    expect(result.current.minQueryLength).toBe(2);
    await act(async () => {
      result.current.setQuery('AT');
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });
    expect(searchSequence).toHaveBeenCalledWith(
      expect.any(Object),
      'chr11',
      'AT',
      expect.objectContaining({ reverseComplement: true }),
      expect.objectContaining({
        clientId: expect.any(String),
        requestId: expect.any(String),
        signal: expect.any(AbortSignal),
      })
    );
  });

  it('rejects an oversized disk annotation query before issuing IPC', async () => {
    const { result } = renderHook(() =>
      useGenomeSearch({
        manifest: null,
        chrom: null,
        annotationIndex: null,
        assemblyAnnotationSearchSource: assemblySearchSource('source-a'),
        onJumpToMatch: vi.fn(),
      })
    );

    act(() => result.current.openInMode('aminoAcid'));
    await act(async () => {
      result.current.setQuery('x'.repeat(PREPACKED_ANNOTATION_SEARCH_MAX_QUERY_CODE_UNITS_V1 + 1));
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });

    expect(queryAssemblyAnnotationSearch).not.toHaveBeenCalled();
    expect(result.current.errorMessage).toBe(
      `Annotation queries are limited to ${PREPACKED_ANNOTATION_SEARCH_MAX_QUERY_CODE_UNITS_V1} characters.`
    );
  });

  it('searches a whitespace-formatted peptide even when its raw text exceeds the annotation limit', async () => {
    const normalizedPeptide = 'P'.repeat(200);
    const formattedPeptide = normalizedPeptide.split('').join(' ');
    expect(formattedPeptide.length).toBeGreaterThan(
      PREPACKED_ANNOTATION_SEARCH_MAX_QUERY_CODE_UNITS_V1
    );
    queryAssemblyProteinSearch.mockResolvedValue({
      status: 'hit',
      fingerprint: 'protein-a',
      featureCount: 0,
      matches: [],
      truncated: false,
      limit: 500,
    });
    const { result } = renderHook(() =>
      useGenomeSearch({
        manifest: null,
        chrom: null,
        annotationIndex: null,
        assemblyAnnotationSearchSource: assemblySearchSource('source-a'),
        onJumpToMatch: vi.fn(),
      })
    );

    act(() => result.current.openInMode('aminoAcid'));
    await act(async () => {
      result.current.setQuery(formattedPeptide);
      vi.advanceTimersByTime(200);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(queryAssemblyAnnotationSearch).not.toHaveBeenCalled();
    expect(queryAssemblyProteinSearch).toHaveBeenCalledWith(
      expect.objectContaining({ query: normalizedPeptide, limit: 500 }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(result.current.isError).toBe(false);
    expect(result.current.errorMessage).toBeNull();
  });

  it('treats an annotation artifact miss as unavailable after one read-only probe', async () => {
    queryAssemblyAnnotationSearch.mockResolvedValue({
      status: 'miss',
      fingerprint: 'source-a',
    });
    const { result } = renderHook(() =>
      useGenomeSearch({
        manifest: null,
        chrom: null,
        annotationIndex: null,
        assemblyAnnotationSearchSource: assemblySearchSource('source-a'),
        onJumpToMatch: vi.fn(),
      })
    );

    act(() => result.current.openInMode('aminoAcid'));
    await act(async () => {
      result.current.setQuery('HBB');
      vi.advanceTimersByTime(200);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(queryAssemblyAnnotationSearch).toHaveBeenCalledOnce();
    expect(result.current.matches).toEqual([]);
    expect(result.current.isError).toBe(true);
    expect(result.current.errorMessage).toBe('Search index is unavailable for this reference.');
  });

  it('stays pending through a delayed disk probe and clears only on current completion', async () => {
    const delayedProbe = deferred<AssemblyAnnotationSearchQueryResultV1>();
    queryAssemblyAnnotationSearch.mockReturnValue(delayedProbe.promise);
    const { result } = renderHook(() =>
      useGenomeSearch({
        manifest: null,
        chrom: null,
        annotationIndex: null,
        assemblyAnnotationSearchSource: assemblySearchSource('source-a'),
        onJumpToMatch: vi.fn(),
      })
    );

    act(() => result.current.openInMode('aminoAcid'));
    act(() => {
      result.current.setQuery('HBB');
      vi.advanceTimersByTime(200);
    });
    expect(result.current.isSearching).toBe(true);
    expect(result.current.matches).toEqual([]);

    await act(async () => {
      delayedProbe.resolve(assemblySearchHit('HBB'));
      await delayedProbe.promise;
      await Promise.resolve();
    });

    expect(result.current.isSearching).toBe(false);
    expect(result.current.matches.map((match) => match.label)).toEqual(['HBB']);
  });

  it('clears prior hits immediately and rejects an older query response before the next debounce', async () => {
    const delayedBrca = deferred<AssemblyAnnotationSearchQueryResultV1>();
    queryAssemblyAnnotationSearch.mockImplementation(async ({ query }) => {
      if (query === 'BRCA') return delayedBrca.promise;
      return assemblySearchHit(query, query === 'TP53' ? 900 : 100, query === 'TP53' ? 950 : 200);
    });
    const onJumpToMatch = vi.fn();
    const { result } = renderHook(() =>
      useGenomeSearch({
        manifest: null,
        chrom: null,
        annotationIndex: null,
        assemblyAnnotationSearchSource: assemblySearchSource('source-a'),
        onJumpToMatch,
      })
    );

    act(() => result.current.openInMode('aminoAcid'));
    await act(async () => {
      result.current.setQuery('HBB');
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });
    expect(result.current.matches.map((match) => match.label)).toEqual(['HBB']);

    act(() => result.current.setQuery('BRCA'));
    expect(result.current.matches).toEqual([]);
    expect(result.current.matchCount).toBe(0);
    act(() => vi.advanceTimersByTime(200));
    expect(queryAssemblyAnnotationSearch).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'BRCA' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    const brcaRequest = queryAssemblyAnnotationSearch.mock.calls.at(-1)?.[0];
    const brcaSignal = queryAssemblyAnnotationSearch.mock.calls.at(-1)?.[1]?.signal as AbortSignal;
    expect(brcaSignal.aborted).toBe(false);

    act(() => result.current.setQuery('TP53'));
    expect(brcaSignal.aborted).toBe(true);
    expect(result.current.matches).toEqual([]);
    await act(async () => {
      delayedBrca.resolve(assemblySearchHit('BRCA', 500, 550));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.matches).toEqual([]);
    expect(onJumpToMatch).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });
    expect(result.current.matches.map((match) => match.label)).toEqual(['TP53']);
    const tp53Request = queryAssemblyAnnotationSearch.mock.calls.at(-1)?.[0];
    expect(tp53Request.clientId).toBe(brcaRequest.clientId);
    expect(tp53Request.requestId).not.toBe(brcaRequest.requestId);
  });

  it('invalidates a delayed nucleotide response when the search mode changes', async () => {
    const delayedNucleotide = deferred<
      Array<{
        chrom: string;
        start: number;
        end: number;
        strand: 'forward' | 'reverse';
        motif: string;
      }>
    >();
    searchSequence.mockReturnValue(delayedNucleotide.promise);
    queryAssemblyAnnotationSearch.mockResolvedValue(assemblySearchHit('CCC-annotation', 700, 760));
    const onJumpToMatch = vi.fn();
    const { result } = renderHook(() =>
      useGenomeSearch({
        manifest: { chrom: 'chr11', fastaPath: '/chr11.fa', faiPath: '/chr11.fa.fai' },
        chrom: 'chr11',
        annotationIndex: null,
        assemblyAnnotationSearchSource: assemblySearchSource('source-a'),
        onJumpToMatch,
      })
    );

    act(() => result.current.openInMode('nucleotide'));
    act(() => {
      result.current.setQuery('CCC');
      vi.advanceTimersByTime(200);
    });
    expect(searchSequence).toHaveBeenCalledOnce();
    const nucleotideControl = searchSequence.mock.calls[0]?.[4];
    expect(nucleotideControl).toEqual(
      expect.objectContaining({
        clientId: expect.any(String),
        requestId: expect.any(String),
        signal: expect.any(AbortSignal),
      })
    );
    expect(nucleotideControl.signal.aborted).toBe(false);

    act(() => result.current.setMode('aminoAcid'));
    expect(nucleotideControl.signal.aborted).toBe(true);
    expect(result.current.matches).toEqual([]);
    await act(async () => {
      delayedNucleotide.resolve([
        { chrom: 'chr11', start: 20, end: 23, strand: 'forward', motif: 'CCC' },
      ]);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.matches).toEqual([]);

    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });
    expect(result.current.matches.map((match) => match.label)).toEqual(['CCC-annotation']);
  });

  it('searches the complete assembly instead of the bootstrap chromosome and keeps both coordinate domains', async () => {
    searchAssemblySequence.mockResolvedValue({
      hits: [
        {
          chrom: 'chr11',
          localStartBp: 5_225_494,
          localEndBp: 5_225_518,
          globalStartBp: 254_181_916,
          globalEndBp: 254_181_940,
          strand: 'forward',
          motif: 'GCAGAATCCAGATGCTCAAGGCCC',
        },
      ],
      truncated: true,
    });
    const onJumpToMatch = vi.fn();
    const completeAssembly = assemblySequenceSearchSource();
    const { result } = renderHook(() =>
      useGenomeSearch({
        manifest: completeAssembly.chromosomes[0].manifest,
        chrom: 'chr1',
        assemblySequenceSearchSource: completeAssembly,
        annotationIndex: null,
        onJumpToMatch,
      })
    );

    act(() => result.current.openInMode('nucleotide'));
    await act(async () => {
      result.current.setQuery('GCAGAATCCAGATGCTCAAGGCCC');
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });

    expect(searchSequence).not.toHaveBeenCalled();
    expect(searchAssemblySequence).toHaveBeenCalledWith(
      expect.objectContaining({
        source: completeAssembly,
        motif: 'GCAGAATCCAGATGCTCAAGGCCC',
        limit: 500,
        reverseComplement: true,
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(result.current.matches).toEqual([
      expect.objectContaining({
        chrom: 'chr11',
        localStart: 5_225_494,
        localEnd: 5_225_517,
        start: 254_181_916,
        end: 254_181_939,
      }),
    ]);
    expect(result.current.isTruncated).toBe(true);

    act(() => result.current.goToMatch(0));
    expect(onJumpToMatch).toHaveBeenCalledWith(
      expect.objectContaining({
        chrom: 'chr11',
        start: 254_181_916,
        end: 254_181_939,
      })
    );
  });

  it('clears prior hits immediately when openInMode switches an open Find surface', async () => {
    searchSequence.mockResolvedValue([
      { chrom: 'chr11', start: 20, end: 23, strand: 'forward', motif: 'CCC' },
    ]);
    queryAssemblyAnnotationSearch.mockResolvedValue(assemblySearchHit('CCC-annotation', 700, 760));
    const { result } = renderHook(() =>
      useGenomeSearch({
        manifest: { chrom: 'chr11', fastaPath: '/chr11.fa', faiPath: '/chr11.fa.fai' },
        chrom: 'chr11',
        annotationIndex: null,
        assemblyAnnotationSearchSource: assemblySearchSource('source-a'),
        onJumpToMatch: vi.fn(),
      })
    );

    act(() => result.current.openInMode('nucleotide'));
    await act(async () => {
      result.current.setQuery('CCC');
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });
    expect(result.current.matches.map((match) => match.label)).toEqual(['CCC']);

    act(() => result.current.openInMode('aminoAcid'));
    expect(result.current.mode).toBe('aminoAcid');
    expect(result.current.matches).toEqual([]);
    expect(result.current.matchCount).toBe(0);

    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });
    expect(result.current.matches.map((match) => match.label)).toEqual(['CCC-annotation']);
  });

  it('does not publish an unavailable result after Find closes while a probe is pending', async () => {
    const delayedProbe = deferred<AssemblyAnnotationSearchQueryResultV1>();
    queryAssemblyAnnotationSearch.mockReturnValue(delayedProbe.promise);
    const { result } = renderHook(() =>
      useGenomeSearch({
        manifest: null,
        chrom: null,
        annotationIndex: null,
        assemblyAnnotationSearchSource: assemblySearchSource('source-a'),
        onJumpToMatch: vi.fn(),
      })
    );

    act(() => result.current.openInMode('aminoAcid'));
    act(() => {
      result.current.setQuery('HBB');
      vi.advanceTimersByTime(200);
    });
    expect(queryAssemblyAnnotationSearch).toHaveBeenCalledOnce();
    const pendingSignal = queryAssemblyAnnotationSearch.mock.calls[0]?.[1]?.signal as AbortSignal;
    expect(pendingSignal.aborted).toBe(false);

    act(() => result.current.close());
    expect(pendingSignal.aborted).toBe(true);
    await act(async () => {
      delayedProbe.resolve({ status: 'miss', fingerprint: 'source-a' });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(queryAssemblyAnnotationSearch).toHaveBeenCalledOnce();
    expect(result.current.isError).toBe(false);
  });

  it('does not publish an unavailable result after unmount while a probe is pending', async () => {
    const delayedProbe = deferred<AssemblyAnnotationSearchQueryResultV1>();
    queryAssemblyAnnotationSearch.mockReturnValue(delayedProbe.promise);
    const { result, unmount } = renderHook(() =>
      useGenomeSearch({
        manifest: null,
        chrom: null,
        annotationIndex: null,
        assemblyAnnotationSearchSource: assemblySearchSource('source-a'),
        onJumpToMatch: vi.fn(),
      })
    );

    act(() => result.current.openInMode('aminoAcid'));
    act(() => {
      result.current.setQuery('HBB');
      vi.advanceTimersByTime(200);
    });
    expect(queryAssemblyAnnotationSearch).toHaveBeenCalledOnce();
    const pendingSignal = queryAssemblyAnnotationSearch.mock.calls[0]?.[1]?.signal as AbortSignal;
    expect(pendingSignal.aborted).toBe(false);

    unmount();
    expect(pendingSignal.aborted).toBe(true);
    await act(async () => {
      delayedProbe.resolve({ status: 'miss', fingerprint: 'source-a' });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(queryAssemblyAnnotationSearch).toHaveBeenCalledOnce();
  });

  it('aborts the pending assembly probe when the mode changes', () => {
    queryAssemblyAnnotationSearch.mockReturnValue(
      deferred<AssemblyAnnotationSearchQueryResultV1>().promise
    );
    const { result } = renderHook(() =>
      useGenomeSearch({
        manifest: { chrom: 'chr11', fastaPath: '/chr11.fa', faiPath: '/chr11.fa.fai' },
        chrom: 'chr11',
        annotationIndex: null,
        assemblyAnnotationSearchSource: assemblySearchSource('source-a'),
        onJumpToMatch: vi.fn(),
      })
    );

    act(() => result.current.openInMode('aminoAcid'));
    act(() => {
      result.current.setQuery('HBB');
      vi.advanceTimersByTime(200);
    });
    const pendingSignal = queryAssemblyAnnotationSearch.mock.calls[0]?.[1]?.signal as AbortSignal;
    expect(pendingSignal.aborted).toBe(false);

    act(() => result.current.setMode('nucleotide'));
    expect(pendingSignal.aborted).toBe(true);
  });

  it('aborts the old-source probe and gives the replacement a new exact request id', async () => {
    const oldSourceProbe = deferred<AssemblyAnnotationSearchQueryResultV1>();
    queryAssemblyAnnotationSearch.mockImplementation(({ source }) =>
      source.assemblyId === 'source-a'
        ? oldSourceProbe.promise
        : Promise.resolve(assemblySearchHit('NEW-HBB', 900, 950))
    );
    const { result, rerender } = renderHook(
      ({ source }: { source: AssemblyAnnotationSceneReadRequest }) =>
        useGenomeSearch({
          manifest: null,
          chrom: null,
          annotationIndex: null,
          assemblyAnnotationSearchSource: source,
          onJumpToMatch: vi.fn(),
        }),
      { initialProps: { source: assemblySearchSource('source-a') } }
    );

    act(() => result.current.openInMode('aminoAcid'));
    act(() => {
      result.current.setQuery('HBB');
      vi.advanceTimersByTime(200);
    });
    const oldRequest = queryAssemblyAnnotationSearch.mock.calls[0]?.[0];
    const oldSignal = queryAssemblyAnnotationSearch.mock.calls[0]?.[1]?.signal as AbortSignal;

    await act(async () => {
      rerender({ source: assemblySearchSource('source-b') });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(oldSignal.aborted).toBe(true);
    const replacementRequest = queryAssemblyAnnotationSearch.mock.calls.at(-1)?.[0];
    expect(replacementRequest.clientId).toBe(oldRequest.clientId);
    expect(replacementRequest.requestId).not.toBe(oldRequest.requestId);
    expect(result.current.matches.map((match) => match.label)).toEqual(['NEW-HBB']);
  });
});
