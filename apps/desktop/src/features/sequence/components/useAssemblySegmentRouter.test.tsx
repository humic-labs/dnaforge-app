import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { annotationCanonicalIdentityV2, buildAssembly } from '@waypoint/genome-renderer';
import type { GenomeFeature } from '@waypoint/genome-data';

import {
  assemblySessionConfigsIdentity,
  useAssemblySegmentRouter,
} from './useAssemblySegmentRouter';
import type { AssemblySessionChromConfig } from './assembly-session-registry';
import { refreshTranscriptGlyphV2Flag } from '../transcript-glyph-flag';
import {
  ASSEMBLY_ANNOTATION_PAGE_QUERY_SPAN_BP,
  ASSEMBLY_ANNOTATION_PAGE_SIZE_BP,
} from './assembly-annotation-resident-pages';
import {
  annotationResidentPagePublicationReducer,
  INITIAL_ANNOTATION_RESIDENT_PAGE_PUBLICATION_STATE,
} from './useAnnotationPresentationSnapshot';
import { rendererAnnotationIdentityProjection } from './indexed-genome-legacy-adapter';
import { autoZoomToFeature } from '../auto-zoom-to-feature';
import { resolveTranscripts } from './spliced-feature-resolver';

const mockOpen = vi.fn();
const mockGetSession = vi.fn();
const mockCloseSession = vi.fn();
const mockCancel = vi.fn();
const mockGetFeatures = vi.fn();
const mockGetAnnotationTile = vi.fn();
const mockGetSequenceWindow = vi.fn();

vi.mock('../../../platform', () => ({
  platform: () => ({
    genome: {
      open: mockOpen,
      getSession: mockGetSession,
      closeSession: mockCloseSession,
      cancelRequest: mockCancel,
      getFeatures: mockGetFeatures,
      getAnnotationTile: mockGetAnnotationTile,
      getSequenceWindow: mockGetSequenceWindow,
    },
  }),
}));

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface SequenceWindowRequest {
  chrom: string;
  start: number;
  end: number;
  generation: number;
}

function sequenceWindowResponse(request: SequenceWindowRequest, base: string) {
  const bases = base.repeat(request.end - request.start);
  return {
    start: request.start,
    end: request.end,
    generation: request.generation,
    byteCount: bases.length,
    bases,
  };
}

const assembly = buildAssembly('test', 'Test', [
  { id: 'chr1', displayName: 'chr1', length: 1_000_000, cytobands: [] },
  { id: 'chr11', displayName: 'chr11', length: 2_000_000, cytobands: [] },
]);
const rawGffFocusAssembly = buildAssembly('raw-gff-focus', 'Raw GFF focus', [
  { id: 'chr1', displayName: 'chr1', length: 1_000_000, cytobands: [] },
  { id: 'chr2', displayName: 'chr2', length: 2_000_000, cytobands: [] },
]);
const largeAssembly = buildAssembly('large-test', 'Large test', [
  {
    id: 'chrLong',
    displayName: 'chrLong',
    length: ASSEMBLY_ANNOTATION_PAGE_SIZE_BP * 64,
    cytobands: [],
  },
]);
const corridorAssembly = buildAssembly('corridor-test', 'Corridor test', [
  { id: 'chrCorridor', displayName: 'chrCorridor', length: 270_000_000, cytobands: [] },
]);

function config(chrom: string): AssemblySessionChromConfig {
  return {
    chrom,
    source: {
      sourcePath: `/tmp/${chrom}.gff3.gz`,
      sourceExt: 'gff3',
      chrom,
      intent: { kind: 'internal-assembly-segment' },
    },
    manifest: {
      chrom,
      fastaPath: `/tmp/${chrom}.fa`,
      faiPath: `/tmp/${chrom}.fa.fai`,
      gffPath: `/tmp/${chrom}.gff3.gz`,
      tbiPath: `/tmp/${chrom}.gff3.gz.tbi`,
    },
  };
}

const sessionConfigs = [config('chr1'), config('chr11')];

function genomeFeature(
  overrides: Partial<GenomeFeature> & Pick<GenomeFeature, 'type' | 'start' | 'end'>
): GenomeFeature {
  const id = `${overrides.type}-${overrides.start}-${overrides.end}`;
  return {
    chrom: overrides.chrom ?? 'chr11',
    source: overrides.source ?? 'test',
    type: overrides.type,
    start: overrides.start,
    end: overrides.end,
    score: overrides.score ?? null,
    strand: overrides.strand ?? '+',
    phase: overrides.phase ?? null,
    attributes: overrides.attributes ?? { ID: [id], Name: [id] },
    raw: overrides.raw ?? '',
  };
}

describe('useAssemblySegmentRouter', () => {
  it('keys sessions by the exact source generation, paths, and manifest coordinates', () => {
    const annotated = config('chr11');
    const assetGeneration = {
      contract: 'assembly-reference-asset-generation.v1' as const,
      sourceFingerprint: 'a'.repeat(24),
      inventoryFingerprint: 'b'.repeat(64),
      themeMode: 'light' as const,
    };
    const sequenceOnly: AssemblySessionChromConfig = {
      ...annotated,
      source: {
        ...annotated.source,
        sourcePath: annotated.manifest.fastaPath,
        sourceExt: 'fa',
        intent: { kind: 'internal-assembly-segment', assetGeneration },
      },
      manifest: {
        ...annotated.manifest,
        gffPath: null,
        tbiPath: null,
        length: 2_000_000,
        circular: false,
      },
    };
    const identity = assemblySessionConfigsIdentity([sequenceOnly]);

    expect(identity).not.toBe(
      assemblySessionConfigsIdentity([
        {
          ...sequenceOnly,
          source: {
            ...sequenceOnly.source,
            intent: {
              kind: 'internal-assembly-segment',
              assetGeneration: {
                ...assetGeneration,
                inventoryFingerprint: 'c'.repeat(64),
              },
            },
          },
        },
      ])
    );
    expect(identity).not.toBe(
      assemblySessionConfigsIdentity([
        {
          ...sequenceOnly,
          manifest: {
            ...sequenceOnly.manifest,
            faiPath: '/tmp/chr11.rebuilt.fa.fai',
          },
        },
      ])
    );
    expect(identity).not.toBe(
      assemblySessionConfigsIdentity([
        {
          ...sequenceOnly,
          manifest: {
            ...sequenceOnly.manifest,
            length: 2_000_001,
          },
        },
      ])
    );
    expect(identity).not.toBe(
      assemblySessionConfigsIdentity([
        {
          ...sequenceOnly,
          manifest: {
            ...sequenceOnly.manifest,
            circular: true,
          },
        },
      ])
    );
    expect(identity).not.toBe(assemblySessionConfigsIdentity([annotated]));
    expect(identity).toBe(
      assemblySessionConfigsIdentity([
        {
          ...sequenceOnly,
          source: { ...sequenceOnly.source },
          manifest: { ...sequenceOnly.manifest },
        },
      ])
    );
  });

  beforeEach(() => {
    vi.stubEnv('VITE_TRANSCRIPT_GLYPH_V2', '1');
    refreshTranscriptGlyphV2Flag();
    mockOpen.mockImplementation(async (source: { chrom: string }) => ({
      sessionId: `session-${source.chrom}`,
      chrom: source.chrom,
      coordinateReady: true,
      manifest: config(source.chrom).manifest,
      sourceFingerprint: `fp-${source.chrom}`,
    }));
    mockGetSession.mockImplementation(async (sessionId: string) => ({
      sessionId,
      chrom: sessionId.replace(/^session-/, ''),
      coordinateReady: true,
      manifest: config(sessionId.replace(/^session-/, '')).manifest,
      sourceFingerprint: `fp-${sessionId}`,
    }));
    mockCloseSession.mockResolvedValue(true);
    mockCancel.mockResolvedValue(undefined);
    mockGetFeatures.mockResolvedValue({ features: [], generation: 1, byteCount: 0 });
    mockGetAnnotationTile.mockResolvedValue({
      state: 'ready',
      fidelity: 'best_available',
      generation: 1,
      byteCount: 0,
      recordCount: 0,
      features: [],
      featureModel: 'raw-gff3',
      layerTypes: [],
    });
    mockGetSequenceWindow.mockResolvedValue({
      start: 0,
      end: 262_144,
      generation: 1,
      byteCount: 262_144,
      bases: 'A'.repeat(262_144),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    delete (window as unknown as { __assemblyDetailDebug?: unknown }).__assemblyDetailDebug;
    localStorage.removeItem('dnaforge:transcript_glyph_v2');
    refreshTranscriptGlyphV2Flag();
    vi.clearAllMocks();
  });

  it('prefetches detail and sequence from the immediate camera path without duplicate debounced work', async () => {
    const { result, unmount } = renderHook(() =>
      useAssemblySegmentRouter({
        rendererAssembly: assembly,
        sessionConfigs,
        containerWidth: 1000,
        enabled: true,
        overviewFeaturesComplete: false,
      })
    );

    act(() => {
      result.current.onCamera({ start: 1_050_000, end: 1_060_000 }, { immediate: true });
      result.current.onCamera({ start: 1_051_000, end: 1_059_000 }, { immediate: true });
    });
    await act(async () => {
      await flushMicrotasks();
      await flushMicrotasks();
    });
    await waitFor(() => expect(mockGetAnnotationTile).toHaveBeenCalledTimes(1));
    expect(mockGetSequenceWindow).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.onCamera({ start: 1_051_000, end: 1_059_000 }, { immediate: false });
    });
    await act(async () => {
      await flushMicrotasks();
      await flushMicrotasks();
    });
    await waitFor(() => expect(mockGetAnnotationTile).toHaveBeenCalledTimes(4));
    expect(mockGetSequenceWindow).toHaveBeenCalledTimes(1);
    expect(mockGetSequenceWindow.mock.calls[0][0]).toBe('session-chr11');
    expect(mockGetSequenceWindow.mock.calls[0][1]).toMatchObject({
      chrom: 'chr11',
      start: 0,
      end: 524_288,
      generation: 1,
    });

    await act(async () => {
      await flushMicrotasks();
    });
    expect(result.current.sequenceWindow?.bases.length).toBe(262_144);
    expect(result.current.sequenceWindow?.startBp).toBe(1_000_000);

    unmount();
  });

  it('streams nucleotides without issuing annotation requests for a sequence-only member', async () => {
    const annotated = config('chr11');
    const sequenceOnly: AssemblySessionChromConfig = {
      ...annotated,
      source: {
        ...annotated.source,
        sourcePath: annotated.manifest.fastaPath,
        sourceExt: 'fa',
      },
      manifest: {
        ...annotated.manifest,
        gffPath: null,
        tbiPath: null,
      },
    };
    const { result, unmount } = renderHook(() =>
      useAssemblySegmentRouter({
        rendererAssembly: assembly,
        sessionConfigs: [sequenceOnly],
        containerWidth: 1000,
        enabled: true,
      })
    );

    act(() => {
      result.current.onCamera({ start: 1_050_000, end: 1_060_000 }, { immediate: false });
    });
    await waitFor(() => expect(mockGetSequenceWindow).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.sequenceWindow?.bases).toHaveLength(262_144));

    expect(mockOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePath: annotated.manifest.fastaPath,
        sourceExt: 'fa',
      })
    );
    expect(mockGetAnnotationTile).not.toHaveBeenCalled();
    expect(result.current.annotationPages).toHaveLength(0);
    expect(result.current.detailByChrom.size).toBe(0);
    unmount();
  });

  it('refetches chromosome A after chromosome B replaces the single published sequence window', async () => {
    mockGetSequenceWindow.mockImplementation(
      async (_sessionId: string, request: SequenceWindowRequest) =>
        sequenceWindowResponse(request, request.chrom === 'chr1' ? 'A' : 'C')
    );
    const { result, unmount } = renderHook(() =>
      useAssemblySegmentRouter({
        rendererAssembly: assembly,
        sessionConfigs,
        containerWidth: 1000,
        enabled: true,
      })
    );

    act(() => {
      result.current.onCamera({ start: 100_000, end: 110_000 }, { immediate: false });
    });
    await waitFor(() => expect(result.current.sequenceWindow?.bases[0]).toBe('A'));

    act(() => {
      result.current.onCamera({ start: 1_100_000, end: 1_110_000 }, { immediate: false });
    });
    await waitFor(() => expect(result.current.sequenceWindow?.bases[0]).toBe('C'));

    act(() => {
      result.current.onCamera({ start: 100_000, end: 110_000 }, { immediate: false });
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(mockGetSequenceWindow).toHaveBeenCalledTimes(3);
    await waitFor(() => {
      expect(result.current.sequenceWindow?.startBp).toBe(0);
      expect(result.current.sequenceWindow?.bases[0]).toBe('A');
    });
    unmount();
  });

  it('keeps the published window when returning within the same chromosome before a distant read finishes', async () => {
    const distant = createDeferred<ReturnType<typeof sequenceWindowResponse>>();
    mockGetSequenceWindow.mockImplementation(
      (_sessionId: string, request: SequenceWindowRequest) =>
        mockGetSequenceWindow.mock.calls.length === 2
          ? distant.promise
          : Promise.resolve(sequenceWindowResponse(request, 'A'))
    );
    const { result, unmount } = renderHook(() =>
      useAssemblySegmentRouter({
        rendererAssembly: assembly,
        sessionConfigs,
        containerWidth: 1000,
        enabled: true,
      })
    );

    act(() => {
      result.current.onCamera({ start: 100_000, end: 110_000 }, { immediate: false });
    });
    await waitFor(() => expect(result.current.sequenceWindow?.bases[0]).toBe('A'));
    const published = result.current.sequenceWindow;

    act(() => {
      result.current.onCamera({ start: 800_000, end: 810_000 }, { immediate: false });
    });
    await waitFor(() => expect(mockGetSequenceWindow).toHaveBeenCalledTimes(2));
    const distantRequest = mockGetSequenceWindow.mock.calls[1][1] as SequenceWindowRequest;
    act(() => {
      result.current.onCamera({ start: 100_000, end: 110_000 }, { immediate: false });
    });
    await act(async () => {
      distant.resolve(sequenceWindowResponse(distantRequest, 'C'));
      await flushMicrotasks();
    });

    expect(result.current.sequenceWindow).toBe(published);
    expect(mockGetSequenceWindow).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('does not publish delayed responses after their chromosome request was canceled', async () => {
    const firstChr1 = createDeferred<ReturnType<typeof sequenceWindowResponse>>();
    const secondChr1 = createDeferred<ReturnType<typeof sequenceWindowResponse>>();
    mockGetSequenceWindow.mockImplementation(
      (_sessionId: string, request: SequenceWindowRequest) => {
        if (mockGetSequenceWindow.mock.calls.length === 1) return firstChr1.promise;
        if (mockGetSequenceWindow.mock.calls.length === 3) return secondChr1.promise;
        return Promise.resolve(sequenceWindowResponse(request, 'C'));
      }
    );
    const { result, unmount } = renderHook(() =>
      useAssemblySegmentRouter({
        rendererAssembly: assembly,
        sessionConfigs,
        containerWidth: 1000,
        enabled: true,
      })
    );

    act(() => {
      result.current.onCamera({ start: 100_000, end: 110_000 }, { immediate: false });
    });
    await waitFor(() => expect(mockGetSequenceWindow).toHaveBeenCalledTimes(1));
    const firstRequest = mockGetSequenceWindow.mock.calls[0][1] as SequenceWindowRequest;
    const firstRequestId = mockGetSequenceWindow.mock.calls[0][2] as string;

    act(() => {
      result.current.onCamera({ start: 1_100_000, end: 1_110_000 }, { immediate: false });
    });
    await waitFor(() => expect(mockGetSequenceWindow).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.sequenceWindow?.bases[0]).toBe('C'));
    expect(mockCancel).toHaveBeenCalledWith('session-chr1', firstRequestId);

    await act(async () => {
      firstChr1.resolve(sequenceWindowResponse(firstRequest, 'A'));
      await flushMicrotasks();
    });
    expect(result.current.sequenceWindow?.bases[0]).toBe('C');

    act(() => {
      result.current.onCamera({ start: 100_000, end: 110_000 }, { immediate: false });
    });
    await waitFor(() => expect(mockGetSequenceWindow).toHaveBeenCalledTimes(3));
    const secondRequest = mockGetSequenceWindow.mock.calls[2][1] as SequenceWindowRequest;
    const secondRequestId = mockGetSequenceWindow.mock.calls[2][2] as string;

    act(() => {
      result.current.onCamera({ start: 1_100_000, end: 1_110_000 }, { immediate: false });
    });
    expect(mockCancel).toHaveBeenCalledWith('session-chr1', secondRequestId);

    await act(async () => {
      secondChr1.resolve(sequenceWindowResponse(secondRequest, 'A'));
      await flushMicrotasks();
    });
    expect(result.current.sequenceWindow?.startBp).toBe(1_000_000);
    expect(result.current.sequenceWindow?.bases[0]).toBe('C');
    unmount();
  });

  it('guards immediate annotation prefetch with pending coverage', async () => {
    const { result, unmount } = renderHook(() =>
      useAssemblySegmentRouter({
        rendererAssembly: assembly,
        sessionConfigs,
        containerWidth: 1000,
        enabled: true,
      })
    );

    act(() => {
      result.current.onCamera({ start: 1_050_000, end: 1_060_000 }, { immediate: true });
      result.current.onCamera({ start: 1_051_000, end: 1_059_000 }, { immediate: true });
      result.current.onCamera({ start: 1_051_000, end: 1_059_000 }, { immediate: false });
    });

    await act(async () => {
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(mockGetSequenceWindow).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockGetAnnotationTile).toHaveBeenCalledTimes(4));
    expect(mockGetFeatures).not.toHaveBeenCalled();

    unmount();
  });

  it('settles an aligned 8 MiB halo and performs an 8 MiB forward/reverse gesture with zero additional fetches or publications', async () => {
    const viewportStart = ASSEMBLY_ANNOTATION_PAGE_SIZE_BP * 20 + 100_000;
    const viewportSpan = 200_000;
    const { result, unmount } = renderHook(() =>
      useAssemblySegmentRouter({
        rendererAssembly: largeAssembly,
        sessionConfigs: [config('chrLong')],
        containerWidth: 1000,
        enabled: true,
      })
    );

    act(() => {
      result.current.onCamera(
        { start: viewportStart, end: viewportStart + viewportSpan },
        { immediate: false }
      );
    });
    await waitFor(() => expect(mockGetAnnotationTile).toHaveBeenCalledTimes(33));
    await waitFor(() => expect(result.current.annotationPages).toHaveLength(33));

    const detailRequests = mockGetAnnotationTile.mock.calls.map((call) => call[1]);
    expect(
      detailRequests.every(
        (request) => request.end - request.start === ASSEMBLY_ANNOTATION_PAGE_QUERY_SPAN_BP
      )
    ).toBe(true);
    expect(detailRequests.map((request) => request.start).sort((a, b) => a - b)).toEqual(
      Array.from(
        { length: 33 },
        (_, index) =>
          ASSEMBLY_ANNOTATION_PAGE_SIZE_BP * (4 + index) -
          (ASSEMBLY_ANNOTATION_PAGE_QUERY_SPAN_BP - ASSEMBLY_ANNOTATION_PAGE_SIZE_BP) / 2
      )
    );
    expect([
      ...new Set(result.current.annotationPages.map((page) => page.ownerStartBp)),
    ]).toHaveLength(33);
    expect(
      result.current.annotationPages.every(
        (page) => page.ownerStartBp % ASSEMBLY_ANNOTATION_PAGE_SIZE_BP === 0
      )
    ).toBe(true);

    const settledPublication = result.current.annotationPages;
    const settledPageIdentities = [...settledPublication];
    for (let offsetPages = 1; offsetPages <= 16; offsetPages += 1) {
      const start = viewportStart + ASSEMBLY_ANNOTATION_PAGE_SIZE_BP * offsetPages;
      act(() => {
        result.current.onCamera({ start, end: start + viewportSpan }, { immediate: false });
      });
    }
    for (let offsetPages = 15; offsetPages >= 0; offsetPages -= 1) {
      const start = viewportStart + ASSEMBLY_ANNOTATION_PAGE_SIZE_BP * offsetPages;
      act(() => {
        result.current.onCamera({ start, end: start + viewportSpan }, { immediate: false });
      });
    }
    await act(async () => {
      await flushMicrotasks();
    });

    expect(mockGetAnnotationTile).toHaveBeenCalledTimes(33);
    expect(result.current.annotationPages).toBe(settledPublication);
    expect(result.current.annotationPages).toEqual(settledPageIdentities);
    result.current.annotationPages.forEach((page, index) => {
      expect(page).toBe(settledPageIdentities[index]);
    });
    unmount();
  });

  it('publishes the visible owner before a bounded four-request halo settles', async () => {
    const viewportStart = ASSEMBLY_ANNOTATION_PAGE_SIZE_BP * 20 + 100_000;
    const viewport = { start: viewportStart, end: viewportStart + 200_000 };
    const visibleQueryStart =
      ASSEMBLY_ANNOTATION_PAGE_SIZE_BP * 20 -
      (ASSEMBLY_ANNOTATION_PAGE_QUERY_SPAN_BP - ASSEMBLY_ANNOTATION_PAGE_SIZE_BP) / 2;
    const readyTile = {
      state: 'ready',
      fidelity: 'best_available',
      generation: 1,
      byteCount: 0,
      recordCount: 0,
      features: [],
      featureModel: 'raw-gff3',
      layerTypes: [],
    };
    const releaseHalo: Array<() => void> = [];
    mockGetAnnotationTile.mockImplementation(
      async (_sessionId: string, request: { start: number }) => {
        if (request.start === visibleQueryStart) return readyTile;
        return new Promise<typeof readyTile>((resolve) => {
          releaseHalo.push(() => resolve(readyTile));
        });
      }
    );
    const { result, unmount } = renderHook(() =>
      useAssemblySegmentRouter({
        rendererAssembly: largeAssembly,
        sessionConfigs: [config('chrLong')],
        containerWidth: 1000,
        enabled: true,
      })
    );

    act(() => result.current.onCamera(viewport, { immediate: false }));
    await waitFor(() => expect(result.current.annotationPages).toHaveLength(1));
    await waitFor(() => expect(mockGetAnnotationTile).toHaveBeenCalledTimes(5));
    expect(releaseHalo).toHaveLength(4);
    expect(
      (window as unknown as { __assemblyDetailDebug?: Record<string, unknown> })
        .__assemblyDetailDebug
    ).toMatchObject({
      pendingCoordinatePageCount: 4,
      residentCoordinatePageCount: 1,
    });

    mockGetAnnotationTile.mockResolvedValue(readyTile);
    await act(async () => {
      for (const release of releaseHalo.splice(0)) release();
      await flushMicrotasks();
    });
    await waitFor(() => expect(mockGetAnnotationTile).toHaveBeenCalledTimes(33));
    await waitFor(() => expect(result.current.annotationPages).toHaveLength(33));
    await waitFor(() =>
      expect(
        (window as unknown as { __assemblyDetailDebug?: Record<string, unknown> })
          .__assemblyDetailDebug
      ).toMatchObject({
        pendingCoordinatePageCount: 0,
        residentCoordinatePageCount: 33,
      })
    );
    unmount();
  });

  it('keeps source pages byte-identical and continuously published across every runtime policy switch', async () => {
    const viewportStart = ASSEMBLY_ANNOTATION_PAGE_SIZE_BP * 20 + 100_000;
    const viewport = { start: viewportStart, end: viewportStart + 200_000 };
    const initialConfig = config('chrLong');
    mockGetAnnotationTile.mockImplementation(
      async (_sessionId: string, request: { start: number; end: number }) => {
        const ownerStart =
          request.start +
          (ASSEMBLY_ANNOTATION_PAGE_QUERY_SPAN_BP - ASSEMBLY_ANNOTATION_PAGE_SIZE_BP) / 2;
        const isoform = (suffix: string) => ({
          ...genomeFeature({
            chrom: 'chrLong',
            type: 'mRNA',
            start: ownerStart + 10,
            end: ownerStart + 1_000,
            attributes: {
              ID: [`tx-${suffix}-${ownerStart}`],
              gene: [`gene-${ownerStart}`],
            },
          }),
          exons: [{ start: ownerStart + 10, end: ownerStart + 1_000 }],
          cds: [{ start: ownerStart + 100, end: ownerStart + 900 }],
          transcriptId: `tx-${suffix}-${ownerStart}`,
          geneId: `gene-${ownerStart}`,
        });
        return {
          state: 'ready',
          fidelity: 'best_available',
          generation: 1,
          byteCount: 256,
          recordCount: 2,
          features: [isoform('primary'), isoform('alternative')],
          featureModel: 'resolved-transcript-v2',
          layerTypes: ['mRNA'],
        };
      }
    );
    const { result, rerender, unmount } = renderHook(
      ({
        mode,
        laneLimit,
        visibleTypes,
        configs,
      }: {
        mode: 'canonical' | 'expanded';
        laneLimit: 8 | 12 | 24 | null;
        visibleTypes: ReadonlySet<string>;
        configs: AssemblySessionChromConfig[];
      }) =>
        useAssemblySegmentRouter({
          rendererAssembly: largeAssembly,
          sessionConfigs: configs,
          containerWidth: 1000,
          enabled: true,
          transcriptDisplayMode: mode,
          laneLimit,
          visibleTypes,
        }),
      {
        initialProps: {
          mode: 'canonical' as const,
          laneLimit: 12 as const,
          visibleTypes: new Set(['mRNA']),
          configs: [initialConfig],
        },
      }
    );

    act(() => result.current.onCamera(viewport, { immediate: false }));
    await waitFor(() => expect(mockGetAnnotationTile).toHaveBeenCalledTimes(33));
    await waitFor(() => expect(result.current.annotationPages).toHaveLength(33));
    const sourcePublication = result.current.annotationPages;
    const sourcePages = [...sourcePublication];
    const sourceKeys = sourcePages.map((page) => page.pageKey);
    const sourceRevisions = sourcePages.map((page) => page.contentRevision);
    const sourceFeatures = sourcePages.map((page) => page.features);
    const sourceStreamKey = result.current.annotationSourcePageStreamKey;
    expect(sourcePages.every((page) => page.trackId === 'mRNA')).toBe(true);
    expect(sourcePages.every((page) => page.features.length === 2)).toBe(true);
    const snapshotCandidate = {
      semanticIdentity: sourcePublication,
      sourceIdentity: 'router-source-fixture',
      genomeLengthBp: largeAssembly.totalLengthBp,
      policyKey: sourceStreamKey,
      requestedLayerTypes: ['mRNA'],
      exactCoverage: [{ startBp: viewport.start, endBp: viewport.end }],
      pages: sourcePublication,
    };
    let snapshotState = annotationResidentPagePublicationReducer(
      INITIAL_ANNOTATION_RESIDENT_PAGE_PUBLICATION_STATE,
      { type: 'publish-committed', candidate: snapshotCandidate }
    );
    const committedSourceSnapshot = snapshotState.current;
    expect(committedSourceSnapshot?.generation).toBe(0);
    expect(committedSourceSnapshot?.pages).toEqual(sourcePages);

    const runtimePolicies = (['canonical', 'expanded'] as const).flatMap((mode) =>
      ([8, 12, 24, null] as const).map((laneLimit, index) => ({
        mode,
        laneLimit,
        visibleTypes:
          index % 2 === 0 ? new Set(['enhancer']) : new Set(['enhancer', 'gene', 'mRNA']),
      }))
    );
    for (const policy of runtimePolicies) {
      rerender({ ...policy, configs: [initialConfig] });
      act(() => {
        result.current.onCamera(viewport, { immediate: true });
        result.current.onCamera(viewport, { immediate: false });
      });

      expect(result.current.annotationPages).toBe(sourcePublication);
      expect(result.current.annotationPages).toHaveLength(33);
      expect(result.current.annotationPages.map((page) => page.pageKey)).toEqual(sourceKeys);
      expect(result.current.annotationPages.map((page) => page.contentRevision)).toEqual(
        sourceRevisions
      );
      expect(result.current.annotationSourcePageStreamKey).toBe(sourceStreamKey);
      snapshotState = annotationResidentPagePublicationReducer(snapshotState, {
        type: 'publish-committed',
        candidate: snapshotCandidate,
      });
      expect(snapshotState.current).toBe(committedSourceSnapshot);
      expect(snapshotState.current?.generation).toBe(0);
      expect(snapshotState.current?.pages).toEqual(sourcePages);
      result.current.annotationPages.forEach((page, index) => {
        expect(page).toBe(sourcePages[index]);
        expect(page.features).toBe(sourceFeatures[index]);
      });
      expect(result.current.annotationProjectionPolicy).toEqual({
        isoformMode: policy.mode,
        laneLimit: policy.laneLimit,
        visibleTypes: [...policy.visibleTypes].sort(),
      });
      expect(mockGetAnnotationTile).toHaveBeenCalledTimes(33);
    }

    const changedSource = {
      ...initialConfig,
      source: { ...initialConfig.source, sourcePath: '/tmp/chrLong-v2.gff3.gz' },
      manifest: { ...initialConfig.manifest, gffPath: '/tmp/chrLong-v2.gff3.gz' },
    };
    rerender({ ...runtimePolicies[2], configs: [changedSource] });
    await waitFor(() => expect(result.current.annotationPages).toHaveLength(0));
    act(() => result.current.onCamera(viewport, { immediate: false }));
    await waitFor(() => expect(mockGetAnnotationTile).toHaveBeenCalledTimes(66));
    await waitFor(() => expect(result.current.annotationPages).toHaveLength(33));
    expect(result.current.annotationPages.map((page) => page.pageKey)).not.toEqual(sourceKeys);
    unmount();
  });

  it('publishes coarse summary annotations for chromosome-scale overview spans', async () => {
    mockGetAnnotationTile.mockResolvedValue({
      state: 'ready',
      fidelity: 'summary',
      generation: 1,
      byteCount: 128,
      recordCount: 1,
      features: [
        genomeFeature({
          start: 840_000,
          end: 860_000,
          type: 'mRNA',
          attributes: { ID: ['tx-prefetch'], Name: ['tx-prefetch'] },
        }),
      ],
      featureModel: 'raw-gff3',
      layerTypes: ['mRNA'],
    });

    const { result, unmount } = renderHook(() =>
      useAssemblySegmentRouter({
        rendererAssembly: assembly,
        sessionConfigs,
        containerWidth: 1000,
        enabled: true,
        overviewFeaturesComplete: false,
      })
    );

    act(() => {
      result.current.onCamera({ start: 1_800_000, end: 2_400_000 }, { immediate: false });
    });
    await waitFor(() => expect(mockGetAnnotationTile).toHaveBeenCalledTimes(5));
    const summaryCall = mockGetAnnotationTile.mock.calls.find((call) => call[1]?.lod === 0);
    const prefetchCall = mockGetAnnotationTile.mock.calls.find((call) => call[1]?.lod === 1);
    expect(summaryCall?.[1]).toMatchObject({
      chrom: 'chr11',
      start: 0,
      end: 2_000_000,
      lod: 0,
      fidelity: 'summary',
      byteBudget: 4_000_000,
    });
    expect(prefetchCall?.[1]).toMatchObject({
      chrom: 'chr11',
      lod: 1,
      fidelity: 'exact',
    });
    expect(result.current.detailByChrom.get('chr11')).toHaveLength(1);
    expect(result.current.detailByChrom.get('chr11')?.[0]).toMatchObject({
      type: 'mRNA',
      start: 1_840_000,
      end: 1_860_000,
    });

    act(() => {
      result.current.onCamera({ start: 1_849_000, end: 1_851_000 }, { immediate: false });
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(mockGetAnnotationTile).toHaveBeenCalledTimes(5);
    expect(result.current.detailByChrom.size).toBe(0);
    await waitFor(() => expect(result.current.annotationPages.length).toBeGreaterThan(0));

    unmount();
  });

  it('keeps the compiled resident scene authoritative through base zoom while sequence streams independently', async () => {
    const compiledOwnership = {
      broadOwner: 'compiled-broad-raster' as const,
      detailOwner: 'compiled-resident-scene' as const,
      codonCarrierOwner: 'resident-coordinate-pages' as const,
      identityKey: 'compiled:test',
      broadCorridorFinestSpanBp: 16_000_000,
      residentSceneCoversViewport: true,
    };
    const { result, rerender, unmount } = renderHook(
      ({ mode, laneLimit }: { mode: 'canonical' | 'expanded'; laneLimit: number }) =>
        useAssemblySegmentRouter({
          rendererAssembly: assembly,
          sessionConfigs,
          containerWidth: 1000,
          enabled: true,
          overviewFeaturesComplete: false,
          annotationTierOwnership: compiledOwnership,
          transcriptDisplayMode: mode,
          laneLimit,
        }),
      { initialProps: { mode: 'canonical' as const, laneLimit: 8 } }
    );

    act(() => {
      result.current.onCamera({ start: 300_000, end: 2_700_000 }, { immediate: false });
    });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(mockOpen).not.toHaveBeenCalled();
    expect(mockGetAnnotationTile).not.toHaveBeenCalled();
    expect(result.current.detailByChrom.size).toBe(0);
    expect(
      (window as unknown as { __assemblyDetailDebug?: any }).__assemblyDetailDebug?.lastDecision
    ).toMatchObject({
      kind: 'overview-compiled-resident-scene',
      annotationTierOwnership: compiledOwnership,
    });

    rerender({ mode: 'expanded', laneLimit: 8 });
    rerender({ mode: 'expanded', laneLimit: 24 });
    act(() => {
      result.current.onCamera({ start: 300_000, end: 2_700_000 }, { immediate: false });
    });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(mockOpen).not.toHaveBeenCalled();
    expect(mockGetAnnotationTile).not.toHaveBeenCalled();

    act(() => {
      result.current.onCamera({ start: 1_100_000, end: 1_700_000 }, { immediate: false });
    });
    act(() => {
      result.current.onCamera({ start: 1_150_000, end: 1_650_000 }, { immediate: false });
    });
    expect(mockGetAnnotationTile).not.toHaveBeenCalled();
    expect(result.current.annotationPages).toHaveLength(0);
    expect(result.current.detailByChrom.size).toBe(0);

    act(() => {
      result.current.onCamera({ start: 1_400_000, end: 1_600_000 }, { immediate: false });
    });
    await waitFor(() => expect(mockGetAnnotationTile).toHaveBeenCalled());
    await waitFor(() => expect(result.current.annotationPages.length).toBeGreaterThan(0));
    expect(mockGetSequenceWindow).not.toHaveBeenCalled();
    const carrierRequestCount = mockGetAnnotationTile.mock.calls.length;

    act(() => {
      result.current.onCamera({ start: 1_849_000, end: 1_851_000 }, { immediate: false });
    });
    await waitFor(() => expect(mockGetSequenceWindow).toHaveBeenCalledTimes(1));
    expect(mockGetAnnotationTile).toHaveBeenCalledTimes(carrierRequestCount);
    expect(result.current.detailByChrom.size).toBe(0);
    expect(result.current.annotationPages.length).toBeGreaterThan(0);
    expect(
      (window as unknown as { __assemblyDetailDebug?: any }).__assemblyDetailDebug?.lastDecision
    ).toMatchObject({
      kind: 'overview-compiled-resident-scene',
      wantNucleotides: true,
    });

    unmount();
  });

  it('retires unfinished detail work when a deep camera returns to broad LOD', async () => {
    const readyTile = {
      state: 'ready' as const,
      fidelity: 'exact' as const,
      generation: 1,
      byteCount: 128,
      recordCount: 1,
      features: [genomeFeature({ start: 150_000, end: 151_000, type: 'mRNA' })],
      featureModel: 'raw-gff3' as const,
      layerTypes: ['mRNA'],
    };
    let resolveTile!: (value: typeof readyTile) => void;
    mockGetAnnotationTile.mockReturnValue(
      new Promise<typeof readyTile>((resolve) => {
        resolveTile = resolve;
      })
    );
    const { result, unmount } = renderHook(() =>
      useAssemblySegmentRouter({
        rendererAssembly: assembly,
        sessionConfigs,
        containerWidth: 1000,
        enabled: true,
        overviewFeaturesComplete: true,
        annotationTierOwnership: {
          broadOwner: 'compiled-broad-raster',
          detailOwner: 'compiled-resident-scene',
          codonCarrierOwner: 'resident-coordinate-pages',
          identityKey: 'compiled:deep-return',

          broadCorridorFinestSpanBp: 1_000_000,
          residentSceneCoversViewport: false,
        },
      })
    );

    act(() => {
      result.current.onCamera({ start: 1_100_000, end: 1_110_000 }, { immediate: false });
    });
    await waitFor(() => expect(mockGetAnnotationTile).toHaveBeenCalledTimes(1));

    act(() => {
      result.current.onCamera({ start: 0, end: assembly.totalLengthBp }, { immediate: true });
    });
    expect(mockCancel).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveTile(readyTile);
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(mockGetAnnotationTile).toHaveBeenCalledTimes(1);
    expect(result.current.annotationPages).toHaveLength(0);
    expect(result.current.detailByChrom.size).toBe(0);

    unmount();
  });

  it('materializes one cold hidden feature wider than 630 kb without publishing camera-owned pages', async () => {
    const rawHiddenFeature = genomeFeature({
      chrom: 'chr11',
      type: 'lnc_RNA',
      start: 200_000,
      end: 900_001,
      strand: '-',
      attributes: {
        ID: ['hidden-long-transcript'],
        Name: ['HIDDEN-LONG'],
      },
    });
    const identity = rendererAnnotationIdentityProjection(rawHiddenFeature);
    const genomeIdentity = 'compiled:test-focus-source';
    const globalStartBp = 1_000_000 + identity.start;
    const globalEndBp = 1_000_000 + identity.end;
    const broadSearchViewport = autoZoomToFeature({
      featureStart: globalStartBp,
      featureEnd: globalEndBp,
      viewport: { start: 0, end: assembly.totalLengthBp },
      genomeLength: assembly.totalLengthBp,
    });
    const canonicalIdentity = annotationCanonicalIdentityV2({
      genomeIdentity,
      sourceId: identity.sourceId,
      transcriptId: 'hidden-long-transcript',
      trackId: identity.annotationTrackId,
      type: identity.type,
      startBp: globalStartBp,
      endBp: globalEndBp,
      direction: identity.direction,
    });
    mockGetAnnotationTile.mockResolvedValue({
      state: 'ready',
      fidelity: 'best_available',
      generation: 1,
      byteCount: 256,
      recordCount: 1,
      sourceRecordCount: 1,
      sourceRepresentationComplete: true,
      features: [rawHiddenFeature],
      featureModel: 'raw-gff3',
      layerTypes: ['lnc_RNA'],
    });

    const { result, unmount } = renderHook(() =>
      useAssemblySegmentRouter({
        rendererAssembly: assembly,
        sessionConfigs,
        containerWidth: 1000,
        enabled: true,
        overviewFeaturesComplete: true,
        annotationTierOwnership: {
          broadOwner: 'compiled-broad-raster',
          detailOwner: 'compiled-resident-scene',
          codonCarrierOwner: 'resident-coordinate-pages',
          identityKey: 'compiled:test',
          broadCorridorFinestSpanBp: 16_000_000,
          residentSceneCoversViewport: true,
        },
        visibleTypes: new Set(['mRNA']),
        annotationSearchFocusSource: {
          startBp: globalStartBp,
          endBp: globalEndBp,
          trackId: 'lnc_RNA',
          canonicalIdentity,
          genomeIdentity,
        },
      })
    );
    const durablePages = result.current.annotationPages;

    await waitFor(() => expect(mockGetAnnotationTile).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(result.current.annotationSearchFocusFeature).toMatchObject({
        type: 'lnc_RNA',
        annotationTrackId: 'lnc_RNA',
        start: globalStartBp,
        end: globalEndBp,
        direction: 'reverse',
        canonicalIdentity,
      })
    );

    expect(globalEndBp - globalStartBp).toBeGreaterThan(630_000);
    expect(broadSearchViewport.end - broadSearchViewport.start).toBeGreaterThan(
      ASSEMBLY_ANNOTATION_PAGE_QUERY_SPAN_BP
    );
    expect(mockGetAnnotationTile).toHaveBeenCalledTimes(1);
    expect(mockGetAnnotationTile.mock.calls[0]?.[0]).toBe('session-chr11');
    expect(mockGetAnnotationTile.mock.calls[0]?.[1]).toMatchObject({
      chrom: 'chr11',
      start: 0,
      end: 2_000_000,
      lod: 1,
      fidelity: 'best_available',
    });
    expect(
      mockGetAnnotationTile.mock.calls[0][1].end - mockGetAnnotationTile.mock.calls[0][1].start
    ).toBeLessThanOrEqual(ASSEMBLY_ANNOTATION_PAGE_QUERY_SPAN_BP);
    expect(result.current.annotationPages).toBe(durablePages);
    expect(result.current.annotationPages).toHaveLength(0);
    expect(result.current.detailByChrom.size).toBe(0);
    expect(result.current.exactDetailCoverageByChrom.size).toBe(0);
    expect(result.current.annotationProjectionPolicy.visibleTypes).toEqual(['mRNA']);

    unmount();
  });

  it('materializes a hidden reverse-strand gene from a resolved gene source while only mRNA is visible', async () => {
    const rawHiddenGene = {
      ...genomeFeature({
        chrom: 'chr11',
        type: 'gene',
        start: 225_464,
        end: 227_071,
        strand: '-',
        attributes: {
          ID: ['HBB.gene.1'],
          Name: ['HBB'],
          gene: ['HBB'],
        },
      }),
      geneId: 'HBB.gene.1',
      transcripts: [
        {
          ...genomeFeature({
            chrom: 'chr11',
            type: 'mRNA',
            start: 225_464,
            end: 227_071,
            strand: '-',
            attributes: {
              ID: ['HBB.mrna.1'],
              Parent: ['HBB.gene.1'],
              Name: ['NM_000518.5'],
              gene: ['HBB'],
            },
          }),
          transcriptId: 'HBB.mrna.1',
          geneId: 'HBB.gene.1',
          exons: [
            { start: 225_464, end: 225_726 },
            { start: 226_577, end: 226_799 },
            { start: 226_930, end: 227_071 },
          ],
          cds: [
            { start: 225_598, end: 225_726 },
            { start: 226_577, end: 226_799 },
            { start: 226_930, end: 227_021 },
          ],
        },
      ],
    };
    const identity = rendererAnnotationIdentityProjection(rawHiddenGene);
    const genomeIdentity = 'compiled:test-hidden-gene-focus';
    const globalStartBp = 1_000_000 + identity.start;
    const globalEndBp = 1_000_000 + identity.end;
    const canonicalIdentity = annotationCanonicalIdentityV2({
      genomeIdentity,
      sourceId: identity.sourceId,
      transcriptId: null,
      trackId: 'gene',
      type: 'gene',
      startBp: globalStartBp,
      endBp: globalEndBp,
      direction: 'reverse',
    });
    mockGetAnnotationTile.mockResolvedValue({
      state: 'ready',
      fidelity: 'best_available',
      generation: 1,
      byteCount: 512,
      recordCount: 1,
      sourceRecordCount: 6,
      sourceRepresentationComplete: true,
      features: [rawHiddenGene],
      featureModel: 'resolved-transcript-v2',
      layerTypes: ['gene', 'mRNA'],
    });

    const { result, unmount } = renderHook(() =>
      useAssemblySegmentRouter({
        rendererAssembly: assembly,
        sessionConfigs,
        containerWidth: 1_000,
        enabled: true,
        overviewFeaturesComplete: true,
        visibleTypes: new Set(['mRNA']),
        annotationSearchFocusSource: {
          startBp: globalStartBp,
          endBp: globalEndBp,
          trackId: 'gene',
          canonicalIdentity,
          genomeIdentity,
        },
      })
    );
    const durablePages = result.current.annotationPages;

    await waitFor(() => expect(mockGetAnnotationTile).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(result.current.annotationSearchFocusFeature).toMatchObject({
        type: 'gene',
        annotationTrackId: 'gene',
        start: globalStartBp,
        end: globalEndBp,
        direction: 'reverse',
        displayName: 'HBB',
        canonicalIdentity,
      })
    );

    expect(result.current.annotationSearchFocusFeature?.transcriptId).toBeUndefined();
    expect(result.current.annotationPages).toBe(durablePages);
    expect(result.current.annotationPages).toHaveLength(0);
    expect(result.current.detailByChrom.size).toBe(0);
    expect(result.current.annotationProjectionPolicy.visibleTypes).toEqual(['mRNA']);

    unmount();
  });

  it('uses the search compiler resolved-gene identity for a raw GFF3 gene with a file offset', async () => {
    const rawGene = {
      ...genomeFeature({
        chrom: 'chr2',
        source: 'RefSeq',
        type: 'gene',
        start: 225_464,
        end: 227_071,
        strand: '-',
        attributes: {
          ID: ['raw-gene-2'],
          Name: ['RAWGENE2'],
          gene: ['RAWGENE2'],
        },
        raw: 'chr2\tRefSeq\tgene\t225465\t227071\t.\t-\t.\tID=raw-gene-2;Name=RAWGENE2',
      }),
      fileOffset: 987_654_321,
    };
    const resolvedGene = resolveTranscripts([rawGene])[0];
    if (!resolvedGene) throw new Error('Expected the raw GFF3 gene to resolve.');
    const searchIdentity = rendererAnnotationIdentityProjection(resolvedGene);
    const rawIdentity = rendererAnnotationIdentityProjection(rawGene);
    const genomeIdentity = 'assembly-annotation-source-sha256.v1:raw-gff-focus';
    const chromosomeGlobalStartBp = 1_000_000;
    const globalStartBp = chromosomeGlobalStartBp + searchIdentity.start;
    const globalEndBp = chromosomeGlobalStartBp + searchIdentity.end;
    const canonicalIdentity = annotationCanonicalIdentityV2({
      genomeIdentity,
      sourceId: searchIdentity.sourceId,
      transcriptId: null,
      trackId: searchIdentity.annotationTrackId,
      type: searchIdentity.type,
      startBp: globalStartBp,
      endBp: globalEndBp,
      direction: searchIdentity.direction,
    });
    mockGetAnnotationTile.mockResolvedValue({
      state: 'ready',
      fidelity: 'best_available',
      generation: 1,
      byteCount: 256,
      recordCount: 1,
      sourceRecordCount: 1,
      sourceRepresentationComplete: true,
      features: [rawGene],
      featureModel: 'raw-gff3',
      layerTypes: ['gene'],
    });

    const { result, unmount } = renderHook(() =>
      useAssemblySegmentRouter({
        rendererAssembly: rawGffFocusAssembly,
        sessionConfigs: [config('chr1'), config('chr2')],
        containerWidth: 1_000,
        enabled: true,
        overviewFeaturesComplete: true,
        visibleTypes: new Set(['mRNA']),
        annotationSearchFocusSource: {
          startBp: globalStartBp,
          endBp: globalEndBp,
          trackId: 'gene',
          canonicalIdentity,
          genomeIdentity,
        },
      })
    );

    expect(searchIdentity.rendererFeatureId).not.toBe(rawIdentity.rendererFeatureId);
    await waitFor(() => expect(mockGetAnnotationTile).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(result.current.annotationSearchFocusFeature).toMatchObject({
        id: searchIdentity.rendererFeatureId,
        type: 'gene',
        annotationTrackId: 'gene',
        start: globalStartBp,
        end: globalEndBp,
        direction: 'reverse',
        displayName: 'RAWGENE2',
        canonicalIdentity,
      })
    );
    expect(mockGetAnnotationTile.mock.calls[0]?.[0]).toBe('session-chr2');
    expect(result.current.annotationSearchFocusFeature?.id).not.toBe(rawIdentity.rendererFeatureId);
    expect(result.current.annotationPages).toHaveLength(0);
    expect(result.current.detailByChrom.size).toBe(0);

    unmount();
  });

  it('closes a selected feature wider than the IPC maximum across bounded source chunks', async () => {
    const rawHiddenFeature = genomeFeature({
      chrom: 'chrLong',
      type: 'lnc_RNA',
      start: 100_000,
      end: 2_600_101,
      strand: '-',
      attributes: {
        ID: ['hidden-multichunk-transcript'],
        Name: ['HIDDEN-MULTICHUNK'],
      },
    });
    const identity = rendererAnnotationIdentityProjection(rawHiddenFeature);
    const genomeIdentity = 'compiled:test-multichunk-focus';
    const canonicalIdentity = annotationCanonicalIdentityV2({
      genomeIdentity,
      sourceId: identity.sourceId,
      transcriptId: 'hidden-multichunk-transcript',
      trackId: identity.annotationTrackId,
      type: identity.type,
      startBp: identity.start,
      endBp: identity.end,
      direction: identity.direction,
    });
    mockGetAnnotationTile.mockResolvedValue({
      state: 'ready',
      fidelity: 'best_available',
      generation: 1,
      byteCount: 256,
      recordCount: 1,
      sourceRecordCount: 1,
      sourceRepresentationComplete: true,
      features: [rawHiddenFeature],
      featureModel: 'raw-gff3',
      layerTypes: ['lnc_RNA'],
    });

    const { result, unmount } = renderHook(() =>
      useAssemblySegmentRouter({
        rendererAssembly: largeAssembly,
        sessionConfigs: [config('chrLong')],
        containerWidth: 1000,
        enabled: true,
        overviewFeaturesComplete: true,
        visibleTypes: new Set(['mRNA']),
        annotationSearchFocusSource: {
          startBp: identity.start,
          endBp: identity.end,
          trackId: 'lnc_RNA',
          canonicalIdentity,
          genomeIdentity,
        },
      })
    );

    await waitFor(() => expect(mockGetAnnotationTile).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(result.current.annotationSearchFocusFeature).toMatchObject({
        annotationTrackId: 'lnc_RNA',
        start: identity.start,
        end: identity.end,
        canonicalIdentity,
      })
    );

    const requests = mockGetAnnotationTile.mock.calls.map((call) => call[1]);
    expect(requests.map(({ start, end }) => [start, end])).toEqual([
      [identity.start, identity.start + ASSEMBLY_ANNOTATION_PAGE_QUERY_SPAN_BP],
      [identity.start + ASSEMBLY_ANNOTATION_PAGE_QUERY_SPAN_BP, identity.end],
    ]);
    expect(
      requests.every(({ start, end }) => end - start <= ASSEMBLY_ANNOTATION_PAGE_QUERY_SPAN_BP)
    ).toBe(true);
    expect(result.current.annotationPages).toHaveLength(0);
    expect(result.current.detailByChrom.size).toBe(0);
    expect(result.current.annotationProjectionPolicy.visibleTypes).toEqual(['mRNA']);

    unmount();
  });

  it('uses the renderer physical-pixel boundary at 70 Mb without reviving full-chromosome summaries', async () => {
    const dpr = vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(2);
    const compiledOwnership = {
      broadOwner: 'compiled-broad-raster' as const,
      detailOwner: 'compiled-resident-scene' as const,
      codonCarrierOwner: 'resident-coordinate-pages' as const,
      identityKey: 'compiled:corridor-test',
      broadCorridorFinestSpanBp: 16_000_000,
      residentSceneCoversViewport: true,
    };
    const { result, unmount } = renderHook(() =>
      useAssemblySegmentRouter({
        rendererAssembly: corridorAssembly,
        sessionConfigs: [config('chrCorridor')],
        containerWidth: 1166,
        enabled: true,
        overviewFeaturesComplete: true,
        annotationTierOwnership: compiledOwnership,
        visibleTypes: new Set(['mRNA', 'lnc_RNA', 'enhancer']),
      })
    );

    act(() => result.current.onCamera({ start: 0, end: 80_000_000 }));
    expect(
      (window as unknown as { __assemblyDetailDebug?: any }).__assemblyDetailDebug?.lastDecision
    ).toMatchObject({
      kind: 'overview-compiled-broad',
      lod: { annotationRepresentation: 'compiled-broad' },
    });

    act(() => result.current.onCamera({ start: 0, end: 70_000_000 }));
    expect(
      (window as unknown as { __assemblyDetailDebug?: any }).__assemblyDetailDebug?.lastDecision
    ).toMatchObject({
      kind: 'overview-compiled-resident-scene',
      lod: { annotationRepresentation: 'compiled-resident-scene' },
    });
    expect(mockOpen).not.toHaveBeenCalled();
    expect(mockGetAnnotationTile).not.toHaveBeenCalled();
    expect(result.current.annotationPages).toHaveLength(0);

    unmount();
    dpr.mockRestore();
  });

  it('does not create a second overview-summary authority across the strict 25 percent boundary when the primary overview is complete', async () => {
    mockGetAnnotationTile.mockResolvedValue({
      state: 'ready',
      fidelity: 'summary',
      generation: 1,
      byteCount: 128,
      recordCount: 1,
      features: [genomeFeature({ start: 100, end: 200, type: 'mRNA' })],
      featureModel: 'raw-gff3',
      layerTypes: ['mRNA'],
    });
    const { result, unmount } = renderHook(() =>
      useAssemblySegmentRouter({
        rendererAssembly: assembly,
        sessionConfigs,
        containerWidth: 1000,
        enabled: true,
        overviewFeaturesComplete: true,
      })
    );
    const threshold = assembly.totalLengthBp * 0.25;
    const center = 1_500_000;

    act(() => {
      result.current.onCamera(
        { start: center - (threshold + 1) / 2, end: center + (threshold + 1) / 2 },
        { immediate: false }
      );
    });
    await act(async () => {
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(mockOpen).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockGetAnnotationTile).toHaveBeenCalledTimes(4));
    for (const call of mockGetAnnotationTile.mock.calls) {
      expect(call[1]).toMatchObject({
        chrom: 'chr11',
        fidelity: 'exact',
        lod: 1,
      });
    }
    expect(result.current.detailByChrom.size).toBe(0);
    expect(
      (window as unknown as { __assemblyDetailDebug?: any }).__assemblyDetailDebug?.lastDecision
    ).toMatchObject({
      kind: 'overview-primary-complete',
      routerRasterOwns: true,
    });

    act(() => {
      result.current.onCamera(
        { start: center - (threshold - 1) / 2, end: center + (threshold - 1) / 2 },
        { immediate: false }
      );
    });
    await act(async () => {
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(mockOpen).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockGetAnnotationTile).toHaveBeenCalledTimes(4));
    expect(result.current.detailByChrom.size).toBe(0);
    const debug = (window as unknown as { __assemblyDetailDebug?: any }).__assemblyDetailDebug;
    expect(debug?.lastDecision).toMatchObject({
      kind: 'overview-primary-complete',
      overviewFeaturesComplete: true,
      routerRasterOwns: false,
      ownershipThresholds: {
        routerRasterFraction: 0.25,
        rendererRasterFraction: 0.72,
        consistent: false,
      },
    });

    act(() => {
      result.current.onCamera({ start: 1_050_000, end: 1_060_000 }, { immediate: false });
    });
    await act(async () => {
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(mockOpen, 'complete overview must not suppress <=512kb detail').toHaveBeenCalledTimes(1);
    expect(mockGetAnnotationTile).toHaveBeenCalledTimes(4);
    expect(mockGetSequenceWindow).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('prefetches exact detail before the 524288 bp handoff even when the prepacked overview authority is complete', async () => {
    const { result, unmount } = renderHook(() =>
      useAssemblySegmentRouter({
        rendererAssembly: assembly,
        sessionConfigs,
        containerWidth: 1000,
        enabled: true,
        overviewFeaturesComplete: true,
      })
    );

    act(() => {
      result.current.onCamera({ start: 1_100_000, end: 1_700_000 }, { immediate: true });
    });
    await act(async () => {
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(mockOpen).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockGetAnnotationTile).toHaveBeenCalledTimes(2));
    expect(mockGetAnnotationTile.mock.calls[0]?.[1]).toMatchObject({
      chrom: 'chr11',
      fidelity: 'exact',
    });
    expect(result.current.detailByChrom.size).toBe(0);
    await waitFor(() => expect(result.current.annotationPages).toHaveLength(2));
    expect(result.current.exactDetailCoverageByChrom.get('chr11')).toEqual({
      startBp: 1_000_000,
      endBp: 2_048_576,
    });
    const prefetchedPublication = result.current.annotationPages;
    expect(
      (window as unknown as { __assemblyDetailDebug?: any }).__assemblyDetailDebug?.lastDecision
    ).toMatchObject({
      kind: 'overview-primary-complete',
      detailPrefetchCovered: false,
    });

    act(() => {
      result.current.onCamera({ start: 1_150_000, end: 1_650_000 }, { immediate: false });
    });
    await act(async () => {
      await flushMicrotasks();
    });
    await waitFor(() => expect(mockGetAnnotationTile).toHaveBeenCalledTimes(4));
    expect(result.current.detailByChrom.size).toBe(0);
    await waitFor(() => expect(result.current.annotationPages).toHaveLength(4));
    expect(result.current.annotationPages.slice(0, 2)).toEqual(prefetchedPublication);
    result.current.annotationPages.slice(0, 2).forEach((page, index) => {
      expect(page).toBe(prefetchedPublication[index]);
    });
    expect(result.current.annotationPages.every((page) => page.features.length === 0)).toBe(true);
    expect(result.current.exactDetailCoverageByChrom.get('chr11')).toEqual({
      startBp: 1_000_000,
      endBp: 3_000_000,
    });

    unmount();
  });

  it('retires an already-published router summary when STEP0 becomes complete without suppressing detail', async () => {
    mockGetAnnotationTile.mockResolvedValue({
      state: 'ready',
      fidelity: 'summary',
      generation: 1,
      byteCount: 128,
      recordCount: 1,
      features: [genomeFeature({ start: 840_000, end: 860_000, type: 'mRNA' })],
      featureModel: 'raw-gff3',
      layerTypes: ['mRNA'],
    });
    const { result, rerender, unmount } = renderHook(
      ({ complete }: { complete: boolean }) =>
        useAssemblySegmentRouter({
          rendererAssembly: assembly,
          sessionConfigs,
          containerWidth: 1000,
          enabled: true,
          overviewFeaturesComplete: complete,
        }),
      { initialProps: { complete: false } }
    );

    act(() => {
      result.current.onCamera({ start: 1_800_000, end: 2_400_000 }, { immediate: false });
    });
    await act(async () => {
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(result.current.detailByChrom.has('chr11')).toBe(true);
    const publishedFeature = result.current.detailByChrom.get('chr11')?.[0];
    expect(publishedFeature).toBeDefined();
    expect(
      (window as unknown as { __assemblyDetailDebug?: any }).__assemblyDetailDebug?.detailStats
        ?.chr11
    ).toMatchObject({ featureCount: 1, transcriptCount: 1 });

    let cameraPathExonReads = 0;
    Object.defineProperty(publishedFeature!, 'exons', {
      configurable: true,
      get: () => {
        cameraPathExonReads += 1;
        return [];
      },
    });
    act(() => {
      result.current.onCamera({ start: 1_805_000, end: 2_405_000 }, { immediate: false });
      result.current.onCamera({ start: 1_810_000, end: 2_410_000 }, { immediate: false });
    });
    expect(cameraPathExonReads).toBe(0);

    await waitFor(() => expect(mockGetAnnotationTile).toHaveBeenCalledTimes(5));
    const fetchesBeforeComplete = mockGetAnnotationTile.mock.calls.length;

    rerender({ complete: true });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(result.current.detailByChrom.size).toBe(0);

    act(() => {
      result.current.onCamera({ start: 1_810_000, end: 2_410_000 }, { immediate: false });
    });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(mockGetAnnotationTile).toHaveBeenCalledTimes(fetchesBeforeComplete);
    expect(result.current.detailByChrom.size).toBe(0);
    unmount();
  });

  it('updates immediate camera diagnostics in place without republishing the same coordinate repository', async () => {
    mockGetAnnotationTile.mockImplementation(() => new Promise(() => undefined));
    const { result, unmount } = renderHook(() =>
      useAssemblySegmentRouter({
        rendererAssembly: assembly,
        sessionConfigs,
        containerWidth: 1000,
        enabled: true,
      })
    );

    act(() => {
      result.current.onCamera({ start: 1_050_000, end: 1_060_000 }, { immediate: true });
    });

    const debug = (window as unknown as { __assemblyDetailDebug?: any }).__assemblyDetailDebug;
    expect(debug?.lastDecision).toMatchObject({
      kind: 'immediate-prefetch',
      chrom: 'chr11',
    });
    expect(debug?.detailChroms).toEqual([]);
    expect(debug?.coordinateRepositoryPublicationCount).toBe(1);

    act(() => {
      result.current.onCamera({ start: 1_051_000, end: 1_059_000 }, { immediate: true });
    });

    expect((window as unknown as { __assemblyDetailDebug?: any }).__assemblyDetailDebug).toBe(
      debug
    );
    expect(debug?.lastDecision).toMatchObject({
      kind: 'immediate-prefetch',
      chrom: 'chr11',
    });
    expect(debug?.coordinateRepositoryPublicationCount).toBe(1);

    unmount();
  });

  it('fetches annotation detail for every chromosome touched by a seam viewport', async () => {
    const { result, unmount } = renderHook(() =>
      useAssemblySegmentRouter({
        rendererAssembly: assembly,
        sessionConfigs,
        containerWidth: 1000,
        enabled: true,
      })
    );

    act(() => {
      result.current.onCamera({ start: 999_500, end: 1_001_500 }, { immediate: true });
      result.current.onCamera({ start: 999_500, end: 1_001_500 }, { immediate: false });
    });

    await waitFor(() => {
      expect(new Set(mockGetAnnotationTile.mock.calls.map((call) => call[0]))).toEqual(
        new Set(['session-chr1', 'session-chr11'])
      );
      expect(
        [...new Set(result.current.annotationPages.map((page) => page.chromosomeId))].sort()
      ).toEqual(['chr1', 'chr11']);
    });
    expect(result.current.detailByChrom.size).toBe(0);

    unmount();
  });

  it('retains every source annotation type on an independent track when visible types switch', async () => {
    mockGetAnnotationTile.mockResolvedValue({
      state: 'ready',
      fidelity: 'best_available',
      generation: 1,
      byteCount: 128,
      recordCount: 2,
      features: [
        genomeFeature({
          type: 'enhancer',
          start: 10,
          end: 40,
          attributes: { ID: ['enhancer-a'], Name: ['enhancer-a'] },
        }),
        genomeFeature({
          start: 50,
          end: 100,
          type: 'mRNA',
          attributes: { ID: ['transcript-a'], Name: ['transcript-a'] },
        }),
      ],
      featureModel: 'raw-gff3',
      layerTypes: ['enhancer', 'mRNA'],
    });

    const { result, rerender, unmount } = renderHook(
      ({ visibleTypes }: { visibleTypes: ReadonlySet<string> }) =>
        useAssemblySegmentRouter({
          rendererAssembly: assembly,
          sessionConfigs,
          containerWidth: 1000,
          enabled: true,
          visibleTypes,
          laneLimit: 12,
          glyphV2Enabled: false,
        }),
      { initialProps: { visibleTypes: new Set(['enhancer']) } }
    );

    act(() => {
      result.current.onCamera({ start: 1_050_000, end: 1_060_000 }, { immediate: true });
      result.current.onCamera({ start: 1_050_000, end: 1_060_000 }, { immediate: false });
    });

    await act(async () => {
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const request = mockGetAnnotationTile.mock.calls[0]?.[1];
    expect(request?.laneEpoch).toContain('annotation-source-complete.v1:all');
    await waitFor(() => expect(result.current.annotationPages.length).toBeGreaterThan(0));
    const sourcePublication = result.current.annotationPages;
    const visibleOwnerTracks = sourcePublication
      .filter((page) => page.features.length > 0)
      .map((page) => page.trackId)
      .sort();
    expect(visibleOwnerTracks).toEqual(['enhancer', 'mRNA']);
    const fetchCount = mockGetAnnotationTile.mock.calls.length;

    rerender({ visibleTypes: new Set(['mRNA']) });
    expect(result.current.annotationPages).toBe(sourcePublication);
    expect(result.current.annotationProjectionPolicy.visibleTypes).toEqual(['mRNA']);
    expect(mockGetAnnotationTile).toHaveBeenCalledTimes(fetchCount);

    unmount();
  });

  it('never promotes a density-degraded tile to exact resident-page coverage', async () => {
    mockGetAnnotationTile.mockResolvedValue({
      state: 'ready',
      fidelity: 'best_available',
      generation: 1,
      byteCount: 128,
      recordCount: 1,
      sourceRecordCount: 2,
      degradedReason: 'density',
      features: [
        genomeFeature({
          start: 50_010,
          end: 50_100,
          type: 'mRNA',
          attributes: { ID: ['partial-transcript'], Name: ['partial-transcript'] },
        }),
      ],
      featureModel: 'raw-gff3',
      layerTypes: ['mRNA'],
    });
    const { result, unmount } = renderHook(() =>
      useAssemblySegmentRouter({
        rendererAssembly: assembly,
        sessionConfigs,
        containerWidth: 1000,
        enabled: true,
      })
    );

    act(() => result.current.onCamera({ start: 1_050_000, end: 1_060_000 }));
    await waitFor(() => expect(mockGetAnnotationTile).toHaveBeenCalledTimes(4));
    expect(result.current.annotationPages).toHaveLength(0);
    expect(result.current.exactDetailCoverageByChrom.size).toBe(0);
    expect(result.current.detailByChrom.size).toBe(0);
    unmount();
  });

  it('uses the viewer glyph mode for assembly detail resolution instead of the global flag', async () => {
    mockGetAnnotationTile.mockResolvedValue({
      state: 'ready',
      fidelity: 'best_available',
      generation: 1,
      byteCount: 256,
      recordCount: 3,
      features: [
        genomeFeature({
          type: 'mRNA',
          start: 10,
          end: 100,
          attributes: { ID: ['tx-a'], Name: ['TXA'] },
        }),
        genomeFeature({
          type: 'exon',
          start: 10,
          end: 30,
          attributes: { ID: ['tx-a-exon-1'], Parent: ['tx-a'] },
        }),
        genomeFeature({
          type: 'exon',
          start: 80,
          end: 100,
          attributes: { ID: ['tx-a-exon-2'], Parent: ['tx-a'] },
        }),
      ],
      featureModel: 'raw-gff3',
      layerTypes: ['mRNA', 'exon'],
    });

    const { result, unmount } = renderHook(() =>
      useAssemblySegmentRouter({
        rendererAssembly: assembly,
        sessionConfigs,
        containerWidth: 1000,
        enabled: true,
        visibleTypes: new Set(['mRNA']),
        glyphV2Enabled: false,
      })
    );

    act(() => {
      result.current.onCamera({ start: 1_050_000, end: 1_060_000 }, { immediate: true });
      result.current.onCamera({ start: 1_050_000, end: 1_060_000 }, { immediate: false });
    });

    await act(async () => {
      await flushMicrotasks();
      await flushMicrotasks();
    });

    await waitFor(() => expect(result.current.annotationPages.length).toBeGreaterThan(0));
    const feature = result.current.annotationPages
      .flatMap((page) => page.features)
      .find((candidate) => candidate.type === 'mRNA');
    expect(feature?.transcriptId).toBeUndefined();
    expect(feature?.qualifiers?._locationString).toBe('join(1000011..1000030,1000081..1000100)');

    unmount();
  });

  it('does not borrow unrelated canvas width when container width has not reported yet', async () => {
    const canvas = document.createElement('canvas');
    Object.defineProperty(canvas, 'getBoundingClientRect', {
      value: () => ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 1000,
        bottom: 500,
        width: 1000,
        height: 500,
        toJSON: () => ({}),
      }),
    });
    document.body.appendChild(canvas);

    const { result, unmount } = renderHook(() =>
      useAssemblySegmentRouter({
        rendererAssembly: assembly,
        sessionConfigs,
        containerWidth: 0,
        enabled: true,
      })
    );

    act(() => {
      result.current.onCamera({ start: 1_050_000, end: 1_060_000 }, { immediate: false });
    });

    await new Promise((r) => setTimeout(r, 500));
    expect(mockGetAnnotationTile).not.toHaveBeenCalled();
    expect(mockGetSequenceWindow).not.toHaveBeenCalled();

    unmount();
    canvas.remove();
  });
});
