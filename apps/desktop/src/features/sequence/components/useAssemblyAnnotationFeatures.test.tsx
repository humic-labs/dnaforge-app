import { act, renderHook, waitFor } from '@testing-library/react';
import type { GenomeAssembly, GenomeFeature, ResolvedTranscript } from '@waypoint/genome-data';
import type { Feature } from '@waypoint/genome-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  readAssemblyOverviewFeatures,
  writeAssemblyOverviewFeatures,
  getAssemblyOverview,
  open,
  getAnnotationTile,
  closeSession,
} = vi.hoisted(() => ({
  readAssemblyOverviewFeatures: vi.fn(),
  writeAssemblyOverviewFeatures: vi.fn(async () => ({ path: '/cache', featureCount: 1 })),
  getAssemblyOverview: vi.fn(),
  open: vi.fn(),
  getAnnotationTile: vi.fn(),
  closeSession: vi.fn(async () => true),
}));

vi.mock('../../../platform', () => ({
  platform: () => ({
    genome: {
      readAssemblyOverviewFeatures,
      writeAssemblyOverviewFeatures,
      getAssemblyOverview,
      open,
      getAnnotationTile,
      closeSession,
    },
  }),
}));

vi.mock('../transcript-glyph-flag', () => ({
  isTranscriptGlyphV2Enabled: () => true,
}));

import { useAssemblyAnnotationFeatures } from './useAssemblyAnnotationFeatures';
import type { TranscriptDisplayMode } from './isoform-collapse';

function assemblyFixture(): GenomeAssembly {
  return {
    assemblyId: 'fixture-assembly',
    displayName: 'Fixture assembly',
    chromosomes: [
      {
        chrom: 'chrFixture',
        displayName: 'chrFixture',
        length: 10_000,
        manifest: { gffPath: '/ws/chrFixture.gff3.gz' },
      },
    ],
  } as unknown as GenomeAssembly;
}

const ASSEMBLY = assemblyFixture();

function resolvedTranscript(
  transcriptId: string,
  options: { primary?: boolean } = {}
): ResolvedTranscript {
  const primary = options.primary === true;
  return {
    chrom: 'chrFixture',
    source: 'fixture',
    type: 'mRNA',
    start: primary ? 100 : 120,
    end: primary ? 900 : 800,
    score: null,
    strand: '+',
    phase: null,
    attributes: {
      ID: [transcriptId],
      gene: ['fixture-gene'],
      ...(primary ? { tag: ['MANE_Select'] } : {}),
    },
    raw: '',
    exons: primary
      ? [
          { start: 100, end: 300 },
          { start: 500, end: 900 },
        ]
      : [
          { start: 120, end: 260 },
          { start: 600, end: 800 },
        ],
    cds: primary ? [{ start: 150, end: 850 }] : [{ start: 180, end: 500 }],
    transcriptId,
    geneId: 'fixture-gene',
  };
}

function rendererTranscript(transcriptId: string): Feature {
  return {
    id: transcriptId === 'fresh-canonical' ? 1 : transcriptId === 'stale-expanded' ? 2 : 3,
    type: 'mRNA',
    start: 100,
    end: 900,
    direction: 1,
    lane: 0,
    color: 0x123456,
    displayName: transcriptId,
    transcriptId,
    exons: [{ start: 100, end: 900 }],
    cds: [{ start: 150, end: 850 }],
    qualifiers: { ID: transcriptId },
  } as Feature;
}

function rendererTranscriptIds(result: ReturnType<typeof useAssemblyAnnotationFeatures>): string[] {
  return (result?.features ?? [])
    .filter((feature) => feature.type === 'mRNA')
    .map((feature) => feature.transcriptId ?? feature.qualifiers?.ID ?? feature.displayName)
    .sort();
}

function processedCacheHit(transcriptId: string, mode: TranscriptDisplayMode = 'canonical') {
  return {
    byChrom: { chrFixture: [rendererTranscript(transcriptId)] },
    manifest: {
      version: 1,
      assemblyId: 'fixture-assembly',
      fingerprint: 'fingerprint',
      cacheContractToken: 'contract',
      mode,
      featureCount: 1,
    },
  };
}

function rawFeature(
  type: string,
  start: number,
  end: number,
  attributes: Record<string, string[]>
): GenomeFeature {
  return {
    chrom: 'chrFixture',
    source: 'fixture',
    type,
    start,
    end,
    score: null,
    strand: '+',
    phase: null,
    attributes,
    raw: '',
  };
}

function rawIsoformRows(): GenomeFeature[] {
  return [
    rawFeature('gene', 100, 900, { ID: ['fixture-gene'] }),
    rawFeature('mRNA', 100, 900, {
      ID: ['tx-primary'],
      Parent: ['fixture-gene'],
      gene: ['fixture-gene'],
      tag: ['MANE_Select'],
    }),
    rawFeature('exon', 100, 300, { Parent: ['tx-primary'] }),
    rawFeature('exon', 500, 900, { Parent: ['tx-primary'] }),
    rawFeature('CDS', 150, 850, { Parent: ['tx-primary'] }),
    rawFeature('mRNA', 120, 800, {
      ID: ['tx-alt'],
      Parent: ['fixture-gene'],
      gene: ['fixture-gene'],
    }),
    rawFeature('exon', 120, 260, { Parent: ['tx-alt'] }),
    rawFeature('exon', 600, 800, { Parent: ['tx-alt'] }),
    rawFeature('CDS', 180, 500, { Parent: ['tx-alt'] }),
  ];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  readAssemblyOverviewFeatures.mockReset();
  writeAssemblyOverviewFeatures.mockClear();
  getAssemblyOverview.mockReset();
  open.mockReset();
  getAnnotationTile.mockReset();
  closeSession.mockClear();
});

describe('useAssemblyAnnotationFeatures mapper policy ownership', () => {
  it('binds requested mode to cache read, unified processing, generated write, and output', async () => {
    readAssemblyOverviewFeatures.mockResolvedValue(null);
    getAssemblyOverview.mockResolvedValue({
      byChrom: {
        chrFixture: {
          chrom: 'chrFixture',
          features: [
            resolvedTranscript('tx-primary', { primary: true }),
            resolvedTranscript('tx-alt'),
          ],
          layerTypes: ['mRNA'],
          cacheState: 'hit',
        },
      },
      hits: 1,
      misses: 0,
    });

    const { result } = renderHook(() => ({
      canonical: useAssemblyAnnotationFeatures(ASSEMBLY, '/ws', false, 'canonical'),
      expanded: useAssemblyAnnotationFeatures(ASSEMBLY, '/ws', false, 'expanded'),
    }));

    await waitFor(() => expect(writeAssemblyOverviewFeatures).toHaveBeenCalledTimes(2));
    expect(rendererTranscriptIds(result.current.canonical)).toEqual(['tx-primary']);
    expect(rendererTranscriptIds(result.current.expanded)).toEqual(['tx-alt', 'tx-primary']);
    expect(result.current.expanded!.features.length).toBeGreaterThan(
      result.current.canonical!.features.length
    );
    expect(readAssemblyOverviewFeatures.mock.calls.map(([request]) => request.mode).sort()).toEqual(
      ['canonical', 'expanded']
    );
    const writesByMode = new Map(
      writeAssemblyOverviewFeatures.mock.calls.map(([request]) => [request.mode, request])
    );
    expect(
      rendererTranscriptIds({ features: writesByMode.get('canonical').byChrom.chrFixture } as never)
    ).toEqual(['tx-primary']);
    expect(
      rendererTranscriptIds({ features: writesByMode.get('expanded').byChrom.chrFixture } as never)
    ).toEqual(['tx-alt', 'tx-primary']);
    expect(getAssemblyOverview).toHaveBeenCalledTimes(2);
    expect(open).not.toHaveBeenCalled();
    expect(getAnnotationTile).not.toHaveBeenCalled();
  });

  it('applies requested mode identically through the raw-GFF session fallback', async () => {
    readAssemblyOverviewFeatures.mockResolvedValue(null);
    getAssemblyOverview.mockResolvedValue({
      byChrom: {
        chrFixture: {
          chrom: 'chrFixture',
          features: [],
          layerTypes: [],
          cacheState: 'miss',
        },
      },
      hits: 0,
      misses: 1,
    });
    open.mockImplementation(async () => ({
      sessionId: `session-${open.mock.calls.length}`,
      sourcePath: '/ws/chrFixture.gff3.gz',
      sourceFingerprint: 'source',
      chrom: 'chrFixture',
      coordinateReady: true,
      validationState: 'metadata_match',
      openedAt: 1,
      manifest: { gffPath: '/ws/chrFixture.gff3.gz' },
      tracks: [],
    }));
    getAnnotationTile.mockResolvedValue({
      sessionId: 'session',
      requestId: 'request',
      trackId: 'annotations',
      chrom: 'chrFixture',
      start: 0,
      end: 10_000,
      generation: 1,
      state: 'ready',
      fidelity: 'summary',
      validationState: 'metadata_match',
      featureModel: 'raw-gff3',
      cacheState: 'hit',
      byteCount: 1,
      recordCount: rawIsoformRows().length,
      layerTypes: ['mRNA'],
      features: rawIsoformRows(),
    });

    const { result } = renderHook(() => ({
      canonical: useAssemblyAnnotationFeatures(ASSEMBLY, '/ws', false, 'canonical'),
      expanded: useAssemblyAnnotationFeatures(ASSEMBLY, '/ws', false, 'expanded'),
    }));

    await waitFor(() => expect(closeSession).toHaveBeenCalledTimes(2));
    expect(closeSession.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      'session-1',
      'session-2',
    ]);
    expect(rendererTranscriptIds(result.current.canonical)).toEqual(['tx-primary']);
    expect(rendererTranscriptIds(result.current.expanded)).toEqual(['tx-alt', 'tx-primary']);
    expect(result.current.expanded!.features.length).toBeGreaterThan(
      result.current.canonical!.features.length
    );
    expect(getAnnotationTile).toHaveBeenCalledTimes(2);
  });

  it('starts distinct A-to-B-to-A effects and rejects late superseded results', async () => {
    const d0 = deferred<ReturnType<typeof processedCacheHit>>();
    const d1 = deferred<ReturnType<typeof processedCacheHit>>();
    const d2 = deferred<ReturnType<typeof processedCacheHit>>();
    readAssemblyOverviewFeatures.mockImplementation(
      () => [d0.promise, d1.promise, d2.promise][readAssemblyOverviewFeatures.mock.calls.length - 1]
    );
    const { result, rerender } = renderHook(
      ({ mode }: { mode: TranscriptDisplayMode }) =>
        useAssemblyAnnotationFeatures(ASSEMBLY, '/ws', false, mode),
      { initialProps: { mode: 'canonical' as TranscriptDisplayMode } }
    );
    await waitFor(() => expect(readAssemblyOverviewFeatures).toHaveBeenCalledTimes(1));
    rerender({ mode: 'expanded' });
    await waitFor(() => expect(readAssemblyOverviewFeatures).toHaveBeenCalledTimes(2));
    rerender({ mode: 'canonical' });
    await waitFor(() => expect(readAssemblyOverviewFeatures).toHaveBeenCalledTimes(3));
    expect(readAssemblyOverviewFeatures.mock.calls.map(([request]) => request.mode)).toEqual([
      'canonical',
      'expanded',
      'canonical',
    ]);
    expect(rendererTranscriptIds(result.current)).toEqual([]);

    await act(async () => d2.resolve(processedCacheHit('fresh-canonical')));
    await waitFor(() => expect(rendererTranscriptIds(result.current)).toEqual(['fresh-canonical']));
    await act(async () => {
      d0.resolve(processedCacheHit('stale-old-canonical'));
      d1.resolve(processedCacheHit('stale-expanded'));
      await Promise.resolve();
    });
    expect(rendererTranscriptIds(result.current)).toEqual(['fresh-canonical']);
    expect(getAssemblyOverview).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(writeAssemblyOverviewFeatures).not.toHaveBeenCalled();
  });

  it('rejects stale A0 and B while the fresh same-key A2 read is still pending', async () => {
    const d0 = deferred<ReturnType<typeof processedCacheHit>>();
    const d1 = deferred<ReturnType<typeof processedCacheHit>>();
    const d2 = deferred<ReturnType<typeof processedCacheHit>>();
    readAssemblyOverviewFeatures.mockImplementation(
      () => [d0.promise, d1.promise, d2.promise][readAssemblyOverviewFeatures.mock.calls.length - 1]
    );
    const { result, rerender } = renderHook(
      ({ mode }: { mode: TranscriptDisplayMode }) =>
        useAssemblyAnnotationFeatures(ASSEMBLY, '/ws', false, mode),
      { initialProps: { mode: 'canonical' as TranscriptDisplayMode } }
    );
    await waitFor(() => expect(readAssemblyOverviewFeatures).toHaveBeenCalledTimes(1));
    rerender({ mode: 'expanded' });
    await waitFor(() => expect(readAssemblyOverviewFeatures).toHaveBeenCalledTimes(2));
    rerender({ mode: 'canonical' });
    await waitFor(() => expect(readAssemblyOverviewFeatures).toHaveBeenCalledTimes(3));

    await act(async () => {
      d0.resolve(processedCacheHit('stale-old-canonical'));
      d1.resolve(processedCacheHit('stale-expanded', 'expanded'));
      await Promise.resolve();
    });
    expect(rendererTranscriptIds(result.current)).toEqual([]);

    await act(async () => d2.resolve(processedCacheHit('fresh-canonical')));
    await waitFor(() => expect(rendererTranscriptIds(result.current)).toEqual(['fresh-canonical']));
  });

  it('presents mode-specific processed-cache bytes without source fallback or reprocessing', async () => {
    readAssemblyOverviewFeatures.mockImplementation(
      async ({ mode }: { mode: TranscriptDisplayMode }) => {
        const ids = mode === 'canonical' ? ['tx-primary'] : ['tx-primary', 'tx-alt'];
        const manifest = {
          version: 1,
          assemblyId: 'fixture-assembly',
          fingerprint: 'fingerprint',
          cacheContractToken: 'contract',
          mode,
          featureCount: ids.length,
        };
        return {
          rawFileJson: JSON.stringify({
            manifest,
            byChrom: {
              chrFixture: ids.map((id) => rendererTranscript(id)),
            },
          }),
          manifest,
        };
      }
    );

    const { result } = renderHook(() => ({
      canonical: useAssemblyAnnotationFeatures(ASSEMBLY, '/ws', false, 'canonical'),
      expanded: useAssemblyAnnotationFeatures(ASSEMBLY, '/ws', false, 'expanded'),
    }));

    await waitFor(() =>
      expect(rendererTranscriptIds(result.current.expanded)).toEqual(['tx-alt', 'tx-primary'])
    );
    expect(rendererTranscriptIds(result.current.canonical)).toEqual(['tx-primary']);
    expect(readAssemblyOverviewFeatures.mock.calls.map(([request]) => request.mode).sort()).toEqual(
      ['canonical', 'expanded']
    );
    expect(getAssemblyOverview).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(getAnnotationTile).not.toHaveBeenCalled();
    expect(writeAssemblyOverviewFeatures).not.toHaveBeenCalled();
  });

  it('rejects processed-cache bytes whose declared mode disagrees with the request', async () => {
    readAssemblyOverviewFeatures.mockResolvedValue(
      processedCacheHit('wrong-canonical-cache', 'canonical')
    );
    getAssemblyOverview.mockResolvedValue({
      byChrom: {
        chrFixture: {
          chrom: 'chrFixture',
          features: [
            resolvedTranscript('tx-primary', { primary: true }),
            resolvedTranscript('tx-alt'),
          ],
          layerTypes: ['mRNA'],
          cacheState: 'hit',
        },
      },
      hits: 1,
      misses: 0,
    });

    const { result } = renderHook(() =>
      useAssemblyAnnotationFeatures(ASSEMBLY, '/ws', false, 'expanded')
    );

    await waitFor(() =>
      expect(rendererTranscriptIds(result.current)).toEqual(['tx-alt', 'tx-primary'])
    );
    expect(rendererTranscriptIds(result.current)).not.toContain('wrong-canonical-cache');
    expect(getAssemblyOverview).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
  });

  it('does not restart source I/O when only the lane cap changes', async () => {
    readAssemblyOverviewFeatures.mockResolvedValue(processedCacheHit('tx-primary'));
    const { result, rerender } = renderHook(
      ({ laneLimit }: { laneLimit: number }) => ({
        laneLimit,
        annotations: useAssemblyAnnotationFeatures(ASSEMBLY, '/ws', false, 'canonical'),
      }),
      { initialProps: { laneLimit: 12 } }
    );
    await waitFor(() =>
      expect(rendererTranscriptIds(result.current.annotations)).toEqual(['tx-primary'])
    );
    expect(readAssemblyOverviewFeatures).toHaveBeenCalledTimes(1);

    rerender({ laneLimit: 8 });
    await act(async () => Promise.resolve());
    expect(result.current.laneLimit).toBe(8);
    expect(rendererTranscriptIds(result.current.annotations)).toEqual(['tx-primary']);
    expect(readAssemblyOverviewFeatures).toHaveBeenCalledTimes(1);
  });

  it('never returns a loaded canonical result during the first render of a pending expanded transition', async () => {
    const expandedRead = deferred<ReturnType<typeof processedCacheHit>>();
    readAssemblyOverviewFeatures
      .mockResolvedValueOnce(processedCacheHit('fresh-canonical'))
      .mockImplementationOnce(() => expandedRead.promise);
    const renderObservations: Array<{
      mode: TranscriptDisplayMode;
      returnedNull: boolean;
      ids: string[];
    }> = [];

    const { result, rerender } = renderHook(
      ({ mode }: { mode: TranscriptDisplayMode }) => {
        const annotationResult = useAssemblyAnnotationFeatures(ASSEMBLY, '/ws', false, mode);
        renderObservations.push({
          mode,
          returnedNull: annotationResult === null,
          ids: rendererTranscriptIds(annotationResult),
        });
        return annotationResult;
      },
      { initialProps: { mode: 'canonical' as TranscriptDisplayMode } }
    );

    await waitFor(() => expect(rendererTranscriptIds(result.current)).toEqual(['fresh-canonical']));
    renderObservations.length = 0;

    rerender({ mode: 'expanded' });
    const expandedObservations = renderObservations.filter(({ mode }) => mode === 'expanded');
    expect(expandedObservations[0]).toEqual({
      mode: 'expanded',
      returnedNull: true,
      ids: [],
    });
    expect(expandedObservations.every(({ ids }) => !ids.includes('fresh-canonical'))).toBe(true);
    expect(rendererTranscriptIds(result.current)).toEqual([]);
    expect(readAssemblyOverviewFeatures).toHaveBeenCalledTimes(2);

    await act(async () => expandedRead.resolve(processedCacheHit('fresh-expanded', 'expanded')));
    await waitFor(() => expect(rendererTranscriptIds(result.current)).toEqual(['fresh-expanded']));
  });
});
