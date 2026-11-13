import { act, renderHook } from '@testing-library/react';
import { setImmediate as waitForImmediate } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { quantitativeSourceBasesPerSpan, type Assembly } from '@waypoint/genome-renderer';
import type { Lane } from '../lane-contract-store';
import { UCSC_TRACK_RECOVERING_STATUS } from '../ucsc-streaming-status';
import { sameStreamingLanes, useIndexedUcscTrackStreaming } from './useIndexedUcscTrackStreaming';

const mocks = vi.hoisted(() => ({
  fetchRegion: vi.fn(),
  fetchWhole: vi.fn(),
  admitTrack: vi.fn(),
  openBbi: vi.fn(),
  queryBbi: vi.fn(),
  closeBbi: vi.fn(),
}));

vi.mock('../ucsc-track-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ucsc-track-client')>()),
  fetchUcscTrackRegion: mocks.fetchRegion,
  fetchUcscWholeTrack: mocks.fetchWhole,
  admitUcscTrack: mocks.admitTrack,
}));

vi.mock('../bbi-reader-runtime', () => ({
  getBbiReaderWorkerClient: () => ({
    open: mocks.openBbi,
    queryQuantitative: mocks.queryBbi,
    closeSource: mocks.closeBbi,
  }),
}));

const ASSEMBLY: Assembly = {
  id: 'grch38',
  displayName: 'GRCh38',
  totalLengthBp: 200_000_000,
  chromosomes: [
    {
      chromosome: { id: 'chr1', displayName: 'chr1', length: 100_000_000, cytobands: [] },
      globalStartBp: 0,
      globalEndBp: 100_000_000,
      order: 0,
    },
    {
      chromosome: { id: 'chr2', displayName: 'chr2', length: 100_000_000, cytobands: [] },
      globalStartBp: 100_000_000,
      globalEndBp: 200_000_000,
      order: 1,
    },
  ],
};

const LANE: Lane = {
  visible: true,
  dataset: {
    trackType: 'imported-transcript',
    trackId: 'ucsc:hg38-knownGene',
    label: 'MANE Select',
    color: 0x3b82f6,
    laneHeightPx: 8,
    maxLanes: 32,
    trackPx: 160,
    records: [],
    kind: 'annotation',
  },
  source: {
    admissionVersion: 1,
    uri: 'https://example.org/knownGene.bb',
    formatId: 'bigbed',
    readerKind: 'ucsc-rest',
    scientificKind: 'transcript',
    assemblyId: 'grch38',
    referenceReceipt: {
      assemblyId: 'grch38',
      referenceSignature: 'grch38',
      sourceSignature: 'known-gene',
      contigMap: { chr1: 'chr1', chr2: 'chr2' },
      checkedContigs: 2,
      status: 'compatible',
      checkedAt: '2026-07-28T00:00:00.000Z',
    },
    provenance: {
      provider: 'ucsc',
      sourceKind: 'ucsc-native',
      catalogId: 'hg38:knownGene',
      ucscGenome: 'hg38',
      track: 'knownGene',
      label: 'MANE Select',
    },
    fingerprint: 'ucsc-native\u0000hg38\u0000knownGene\u0000',
  },
};

const BIGWIG_LANE: Lane = {
  visible: true,
  dataset: {
    trackType: 'quantitative',
    trackId: 'ucsc:hg38-gc5BaseBw',
    label: 'GC Percent',
    color: 0x3b82f6,
    laneHeightPx: 8,
    maxLanes: 32,
    trackPx: 96,
    records: [],
    kind: 'annotation',
    quantitativePresentation: {
      version: 1,
      graph: 'bar',
      showRange: true,
      smoothingSigmaBins: 0,
      scale: { mode: 'robust-global', transform: 'linear' },
    },
  },
  source: {
    admissionVersion: 1,
    uri: 'https://example.org/gc5Base.bw',
    formatId: 'bigwig',
    readerKind: 'bbi',
    scientificKind: 'quantitative',
    quantitativeColumnSemantics: 'continuous-signal',
    assemblyId: 'grch38',
    referenceReceipt: {
      assemblyId: 'grch38',
      referenceSignature: 'grch38',
      sourceSignature: 'gc5base',
      contigMap: { chr1: 'chr1', chr2: 'chr2' },
      checkedContigs: 2,
      status: 'compatible',
      checkedAt: '2026-07-28T00:00:00.000Z',
    },
    provenance: {
      provider: 'ucsc',
      sourceKind: 'ucsc-native',
      catalogId: 'hg38:gc5BaseBw',
      ucscGenome: 'hg38',
      track: 'gc5BaseBw',
      label: 'GC Percent',
    },
    fingerprint: 'ucsc-native\u0000hg38\u0000gc5BaseBw\u0000',
  },
};

function remoteHybridLanes(): ReadonlyArray<Lane> {
  const signalTrackId = 'data:remote-signal';
  const alignmentTrackId = 'pileup:remote-alignment';
  const uri = 'http://127.0.0.1:43119/v1/session_123/signal.bigWig';
  const signal: Lane = {
    ...BIGWIG_LANE,
    dataset: { ...BIGWIG_LANE.dataset, trackId: signalTrackId, label: 'signal.bigWig' },
    source: {
      ...BIGWIG_LANE.source!,
      uri,
      input: { kind: 'url', url: uri },
      provenance: {
        provider: 'direct-url',
        sourceKind: 'remote-url',
        label: 'signal.bigWig',
      },
      fingerprint: `remote-signal\u0000ssh://lab-hpc/data/signal.bigWig\u0000${uri}\u000010000`,
      expectedValidators: { contentLength: 10_000 },
    },
  };
  const alignment: Lane = {
    assemblyId: 'grch38',
    order: 1,
    visible: false,
    dataset: {
      trackType: 'pileup-genomewide',
      trackId: alignmentTrackId,
      label: 'Remote reads',
      color: 0x3b82f6,
      trackPx: 276,
      records: [],
      kind: 'pileup',
      source: {
        bamPath: 'http://127.0.0.1:43119/v1/session_123/alignment.cram',
        indexPath: '/tmp/session_123/alignment.cram.crai',
        remote: {
          locator: {
            contract: 'remote-alignment-locator.v1',
            endpointId: 'endpoint-1',
            target: 'lab-hpc',
            alignmentPath: '/data/alignment.cram',
            indexPath: '/data/alignment.cram.crai',
            signalPath: '/data/signal.bigWig',
          },
          sessionId: 'session_123',
        },
      },
    },
  };
  const hybrid: Lane = {
    assemblyId: 'grch38',
    order: 2,
    visible: true,
    dataset: {
      trackType: 'pileup-genomewide',
      trackId: 'hybrid:remote-alignment',
      label: 'BigWig → reads',
      color: 0x3b82f6,
      trackPx: 276,
      records: [],
      kind: 'pileup',
      experimentalHybrid: {
        alignmentTrackId,
        quantitativeTrackId: signalTrackId,
        loadingAnimation: 'diagonal-scan',
      },
    },
  };
  return [signal, alignment, hybrid];
}

const CPG_LANE: Lane = {
  visible: true,
  dataset: {
    trackType: 'genericInterval',
    trackId: 'ucsc:hg38-cpgIslandExt',
    label: 'CpG Islands',
    color: 0x3b82f6,
    laneHeightPx: 8,
    maxLanes: 32,
    trackPx: 96,
    records: [],
    kind: 'annotation',
  },
  source: {
    admissionVersion: 1,
    uri: 'ucsc://hg38/cpgIslandExt',
    formatId: 'ucsc-native',
    readerKind: 'ucsc-rest',
    scientificKind: 'interval',
    assemblyId: 'grch38',
    referenceReceipt: {
      assemblyId: 'grch38',
      referenceSignature: 'grch38',
      sourceSignature: 'cpg-islands',
      contigMap: { chr1: 'chr1', chr2: 'chr2' },
      checkedContigs: 2,
      status: 'compatible',
      checkedAt: '2026-07-28T00:00:00.000Z',
    },
    provenance: {
      provider: 'ucsc',
      sourceKind: 'ucsc-native',
      catalogId: 'hg38:cpgIslandExt',
      ucscGenome: 'hg38',
      track: 'cpgIslandExt',
      label: 'CpG Islands',
    },
    fingerprint: 'ucsc-native\u0000hg38\u0000cpgIslandExt\u0000',
  },
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(globalThis.crypto.subtle, 'digest').mockResolvedValue(new ArrayBuffer(32));
  mocks.fetchRegion.mockReset();
  mocks.fetchWhole.mockReset();
  mocks.admitTrack.mockReset();
  mocks.openBbi.mockReset();
  mocks.queryBbi.mockReset();
  mocks.closeBbi.mockReset();
  mocks.fetchRegion.mockResolvedValue({
    records: [
      {
        chrom: 'chr2',
        chromStart: 924_431,
        chromEnd: 944_574,
        name: 'ENST00000342066.8',
        blockSizes: '1000,2000,',
        chromStarts: '0,18143,',
        thickStart: 925_000,
        thickEnd: 944_000,
        geneName: 'SAMD11',
        strand: '+',
      },
    ],
    complete: true,
    itemsReturned: 1,
    maxItemsOutput: 10_000,
    trackType: 'bigGenePred',
  });
  mocks.fetchWhole.mockResolvedValue({
    records: [
      {
        chrom: 'chr1',
        chromStart: 28_735,
        chromEnd: 29_737,
        name: 'chr1 CpG island',
      },
      {
        chrom: 'chr2',
        chromStart: 50_000,
        chromEnd: 51_000,
        name: 'chr2 CpG island',
      },
    ],
    complete: true,
    itemsReturned: 2,
    maxItemsOutput: 100_000,
    trackType: 'bed 4',
  });
  mocks.admitTrack.mockResolvedValue({
    baseUrl: 'http://127.0.0.1:8042',
    sourceUri: 'https://example.org/gc5Base.bw',
    sourceToken: 'opaque-source-token',
    canonicalUrlHash: 'canonical-hash',
    byteLength: 1_764_507_851,
    provenanceId: 'provenance-id',
    expiresAtMs: Date.now() + 60_000,
  });
  mocks.openBbi.mockResolvedValue({
    fileType: 'bigwig',
    references: ASSEMBLY.chromosomes.map((placement) => ({
      name: placement.chromosome.id,
      length: placement.chromosome.length,
    })),
    zoomReductionLevels: [10, 100, 1_000, 10_000],
  });
  mocks.queryBbi.mockImplementation(
    async (
      _sourceKey: string,
      regions: ReadonlyArray<{ refName: string; start: number; end: number }>
    ) =>
      regions.map((region, index) => ({
        starts: Int32Array.of(region.start),
        ends: Int32Array.of(Math.min(region.end, region.start + 1_000)),
        values: Float32Array.of(40 + index),
      }))
  );
  mocks.closeBbi.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (window as unknown as { __ucscTrackDebug?: unknown }).__ucscTrackDebug;
});

describe('useIndexedUcscTrackStreaming', () => {
  it('publishes genuine pending histogram tiles separately from read loading, including empty completion', async () => {
    const completions: Array<() => void> = [];
    mocks.queryBbi.mockImplementation(
      () =>
        new Promise((resolve) => {
          completions.push(() => resolve([]));
        })
    );
    const onTrackPendingIntervalsPublished = vi.fn();
    const onTrackRecordsPublished = vi.fn();
    const map = {
      getViewportRange: () => ({ start: 1_000_000, end: 1_000_100 }),
      getLinearRenderer: () => ({ hasTrackInstance: () => false, setTrackData: vi.fn() }),
      requestRender: vi.fn(),
      subscribeToPresentedFrames: vi.fn(() => () => undefined),
    };
    renderHook(() =>
      useIndexedUcscTrackStreaming({
        webglRef: { current: map } as never,
        rendererAssembly: ASSEMBLY,
        containerWidth: 1_000,
        activeLanes: [BIGWIG_LANE],
        onTrackPendingIntervalsPublished,
        onTrackRecordsPublished,
      })
    );
    await settle();
    expect(onTrackPendingIntervalsPublished).toHaveBeenCalledWith(BIGWIG_LANE.dataset.trackId, [
      expect.objectContaining({
        state: 'pending',
        startBp: expect.any(Number),
        endBp: expect.any(Number),
      }),
    ]);
    expect(onTrackRecordsPublished).not.toHaveBeenCalled();
    await act(async () => {
      completions.forEach((complete) => complete());
      await settle();
    });
    expect(onTrackRecordsPublished).toHaveBeenCalledWith(
      BIGWIG_LANE.dataset.trackId,
      [],
      expect.any(String)
    );
    expect(onTrackPendingIntervalsPublished.mock.calls.at(-1)).toEqual([
      BIGWIG_LANE.dataset.trackId,
      [],
    ]);
  });

  it('reconnects a failed SSH BigWig at broad zoom without waiting for read LOD or Retry', async () => {
    mocks.queryBbi.mockRejectedValue(new Error('Failed to fetch'));
    const reconnectRemoteTrack = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary SSH failure'))
      .mockResolvedValueOnce(true);
    const map = {
      getViewportRange: () => ({ start: 0, end: ASSEMBLY.totalLengthBp }),
      getLinearRenderer: () => ({ hasTrackInstance: () => true, setTrackData: vi.fn() }),
      requestRender: vi.fn(),
      subscribeToPresentedFrames: vi.fn(() => () => undefined),
    };
    const webglRef = { current: map } as never;
    const lanes = remoteHybridLanes();

    renderHook(() =>
      useIndexedUcscTrackStreaming({
        webglRef,
        rendererAssembly: ASSEMBLY,
        containerWidth: 1_000,
        activeLanes: lanes,
        reconnectRemoteTrack,
      })
    );
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
    });

    expect(reconnectRemoteTrack).toHaveBeenCalledTimes(1);
    expect(reconnectRemoteTrack).toHaveBeenCalledWith('pileup:remote-alignment');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
      await waitForImmediate();
    });
    expect(reconnectRemoteTrack).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(reconnectRemoteTrack).toHaveBeenCalledTimes(2);
  });

  it('does not apply a stale BigWig error to the replacement SSH session', async () => {
    mocks.queryBbi.mockRejectedValueOnce(new Error('Failed to fetch'));
    const reconnectRemoteTrack = vi.fn().mockResolvedValue(true);
    const map = {
      getViewportRange: () => ({ start: 0, end: ASSEMBLY.totalLengthBp }),
      getLinearRenderer: () => ({ hasTrackInstance: () => true, setTrackData: vi.fn() }),
      requestRender: vi.fn(),
      subscribeToPresentedFrames: vi.fn(() => () => undefined),
    };
    const webglRef = { current: map } as never;
    let lanes = remoteHybridLanes();
    const { rerender } = renderHook(() =>
      useIndexedUcscTrackStreaming({
        webglRef,
        rendererAssembly: ASSEMBLY,
        containerWidth: 1_000,
        activeLanes: lanes,
        reconnectRemoteTrack,
      })
    );
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
    });
    expect(reconnectRemoteTrack).toHaveBeenCalledTimes(1);

    mocks.queryBbi.mockImplementation(() => new Promise(() => undefined));
    lanes = lanes.map((lane) => {
      if (lane.dataset.trackId !== 'data:remote-signal' || !lane.source) return lane;
      const uri = 'http://127.0.0.1:43120/v1/session_456/signal.bigWig';
      return {
        ...lane,
        source: {
          ...lane.source,
          uri,
          input: { kind: 'url' as const, url: uri },
          fingerprint: `remote-signal\u0000ssh://lab-hpc/data/signal.bigWig\u0000${uri}\u000010000`,
        },
      };
    });
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
    });

    expect(reconnectRemoteTrack).toHaveBeenCalledTimes(1);
  });

  it('treats presentation reordering as the same streaming source set', () => {
    expect(sameStreamingLanes([BIGWIG_LANE, CPG_LANE], [CPG_LANE, BIGWIG_LANE])).toBe(true);
    expect(
      sameStreamingLanes(
        [BIGWIG_LANE, CPG_LANE],
        [
          CPG_LANE,
          {
            ...BIGWIG_LANE,
            source: { ...BIGWIG_LANE.source!, fingerprint: 'replacement-source' },
          },
        ]
      )
    ).toBe(false);
  });

  it('keeps the same streaming controller and BBI reader alive across presentation reorder', async () => {
    const setTrackData = vi.fn();
    const map = {
      getViewportRange: () => ({ start: 0, end: ASSEMBLY.totalLengthBp }),
      getLinearRenderer: () => ({ hasTrackInstance: () => true, setTrackData }),
      requestRender: vi.fn(),
      subscribeToPresentedFrames: vi.fn(() => () => undefined),
    };
    const webglRef = { current: map } as never;
    let activeLanes: ReadonlyArray<Lane> = [BIGWIG_LANE, CPG_LANE];
    const { rerender } = renderHook(() =>
      useIndexedUcscTrackStreaming({
        webglRef,
        rendererAssembly: ASSEMBLY,
        containerWidth: 1_000,
        activeLanes,
      })
    );
    await settle();
    const admissionCount = mocks.admitTrack.mock.calls.length;
    const queryCount = mocks.queryBbi.mock.calls.length;
    const wholeCount = mocks.fetchWhole.mock.calls.length;
    const closeCount = mocks.closeBbi.mock.calls.length;

    activeLanes = [CPG_LANE, BIGWIG_LANE];
    rerender();
    await settle();

    expect(mocks.closeBbi).toHaveBeenCalledTimes(closeCount);
    expect(mocks.admitTrack).toHaveBeenCalledTimes(admissionCount);
    expect(mocks.queryBbi).toHaveBeenCalledTimes(queryCount);
    expect(mocks.fetchWhole).toHaveBeenCalledTimes(wholeCount);
  });

  it('publishes a hidden BigWig dependency to its hybrid consumer without requiring a renderer lane', async () => {
    const setTrackData = vi.fn();
    const onTrackRecordsPublished = vi.fn();
    const map = {
      getViewportRange: () => ({ start: 1_000_000, end: 1_010_000 }),
      getLinearRenderer: () => ({ hasTrackInstance: () => false, setTrackData }),
      requestRender: vi.fn(),
      subscribeToPresentedFrames: vi.fn(() => () => undefined),
    };
    const { result } = renderHook(() =>
      useIndexedUcscTrackStreaming({
        webglRef: { current: map } as never,
        rendererAssembly: ASSEMBLY,
        containerWidth: 1_000,
        activeLanes: [BIGWIG_LANE],
        onTrackRecordsPublished,
      })
    );

    await settle();

    expect(setTrackData).not.toHaveBeenCalled();
    expect(onTrackRecordsPublished).toHaveBeenCalledWith(
      BIGWIG_LANE.dataset.trackId,
      expect.arrayContaining([expect.objectContaining({ value: 40 })]),
      expect.any(String)
    );
    const publicationCount = onTrackRecordsPublished.mock.calls.length;

    act(() => result.current.noteLaneContractWired());
    await settle();
    expect(onTrackRecordsPublished).toHaveBeenCalledTimes(publicationCount);
  });

  it('loads a non-anchor viewport, publishes assembly-global records, and fetches only the new pan margin', async () => {
    let range = { start: 100_920_000, end: 100_950_000 };
    let presented: (() => void) | null = null;
    const setTrackData = vi.fn();
    const renderer = {
      hasTrackInstance: vi.fn(() => true),
      setTrackData,
    };
    const map = {
      getViewportRange: () => range,
      getLinearRenderer: () => renderer,
      requestRender: vi.fn(),
      subscribeToPresentedFrames: vi.fn((listener: () => void) => {
        presented = listener;
        return () => undefined;
      }),
    };
    const webglRef = { current: map } as never;

    renderHook(() =>
      useIndexedUcscTrackStreaming({
        webglRef,
        rendererAssembly: ASSEMBLY,
        containerWidth: 1_000,
        activeLanes: [LANE],
      })
    );
    await settle();

    expect(mocks.fetchRegion).toHaveBeenCalledWith(
      expect.objectContaining({
        genome: 'hg38',
        track: 'knownGene',
        chrom: 'chr2',
        start: 892_672,
        end: 925_440,
      }),
      expect.any(Object)
    );
    expect(setTrackData).toHaveBeenLastCalledWith('ucsc:hg38-knownGene', {
      records: [
        expect.objectContaining({
          chrom: 'chr2',
          start: 100_924_431,
          end: 100_944_574,
          transcriptId: 'ENST00000342066.8',
          exons: expect.any(Array),
        }),
      ],
    });
    const callsAfterFirstViewport = mocks.fetchRegion.mock.calls.length;

    range = { start: 100_930_000, end: 100_960_000 };
    act(() => {
      presented?.();
    });
    await settle();
    expect(mocks.fetchRegion).toHaveBeenCalledTimes(callsAfterFirstViewport + 1);
  });

  it('streams indexed BigWig summaries at whole-genome view instead of publishing zoom-in blank', async () => {
    const setTrackData = vi.fn();
    const map = {
      getViewportRange: () => ({ start: 0, end: ASSEMBLY.totalLengthBp }),
      getLinearRenderer: () => ({
        hasTrackInstance: () => true,
        setTrackData,
      }),
      requestRender: vi.fn(),
      subscribeToPresentedFrames: vi.fn(() => () => undefined),
    };

    renderHook(() =>
      useIndexedUcscTrackStreaming({
        webglRef: { current: map } as never,
        rendererAssembly: ASSEMBLY,
        containerWidth: 1_000,
        activeLanes: [BIGWIG_LANE],
      })
    );
    await settle();

    expect(mocks.fetchRegion).not.toHaveBeenCalled();
    expect(mocks.admitTrack).toHaveBeenCalledOnce();
    expect(mocks.queryBbi).toHaveBeenCalled();
    expect(mocks.queryBbi.mock.calls[0]?.[2]).toBe(65_536);
    expect(quantitativeSourceBasesPerSpan(18)).toBe(65_536);
    expect(quantitativeSourceBasesPerSpan(18, 'native-interval')).toBe(1);
    expect(setTrackData).toHaveBeenCalledWith(
      'ucsc:hg38-gc5BaseBw',
      expect.objectContaining({
        records: expect.arrayContaining([
          expect.objectContaining({ chrom: 'chr1', value: 40 }),
          expect.objectContaining({ chrom: 'chr2', value: 41 }),
        ]),
      })
    );
    expect(
      (window as unknown as { __ucscTrackDebug?: { status?: string } }).__ucscTrackDebug?.status
    ).toBe('ready');
  });

  it('adds neighboring BigWig tiles as a smoothing halo and refetches an evicted neighbor', async () => {
    const range = { start: 920_000, end: 950_000 };
    const successfulQuery = mocks.queryBbi.getMockImplementation()!;
    let rejectedLeftHalo = false;
    mocks.queryBbi.mockImplementation((...args) => {
      const regions = args[1] as ReadonlyArray<{ start: number; end: number }>;
      const isLeftHalo = regions.every((region) => region.end <= range.start);
      if (!rejectedLeftHalo && isLeftHalo) {
        rejectedLeftHalo = true;
        return Promise.reject(new Error('Simulated evicted smoothing halo.'));
      }
      return successfulQuery(...args);
    });
    const setTrackData = vi.fn();
    const map = {
      getViewportRange: () => range,
      getLinearRenderer: () => ({
        hasTrackInstance: () => true,
        setTrackData,
      }),
      requestRender: vi.fn(),
      subscribeToPresentedFrames: vi.fn(() => () => undefined),
    };
    const webglRef = { current: map } as never;
    let activeLanes: ReadonlyArray<Lane> = [BIGWIG_LANE];
    const { rerender } = renderHook(() =>
      useIndexedUcscTrackStreaming({
        webglRef,
        rendererAssembly: ASSEMBLY,
        containerWidth: 1_000,
        activeLanes,
      })
    );
    await settle();

    const coreRecords = setTrackData.mock.lastCall?.[1].records as ReadonlyArray<{
      start: number;
      end: number;
    }>;
    expect(coreRecords).toHaveLength(1);
    expect(rejectedLeftHalo).toBe(true);
    const admissionCount = mocks.admitTrack.mock.calls.length;
    const queryCount = mocks.queryBbi.mock.calls.length;

    activeLanes = [
      {
        ...BIGWIG_LANE,
        dataset: {
          ...BIGWIG_LANE.dataset,
          quantitativePresentation: {
            version: 1,
            graph: 'bar',
            showRange: true,
            smoothingSigmaBins: 10,
            scale: { mode: 'robust-global', transform: 'linear' },
          },
        },
      },
    ];
    rerender();
    await settle();

    const haloRecords = setTrackData.mock.lastCall?.[1].records as ReadonlyArray<{
      start: number;
      end: number;
    }>;
    expect(haloRecords).toHaveLength(3);
    expect(haloRecords.map((record) => record.start)).toEqual(
      [...haloRecords].map((record) => record.start).sort((left, right) => left - right)
    );
    expect(haloRecords.some((record) => record.end <= range.start)).toBe(true);
    expect(haloRecords.some((record) => record.start >= range.end)).toBe(true);
    expect(mocks.admitTrack).toHaveBeenCalledTimes(admissionCount);
    expect(mocks.queryBbi).toHaveBeenCalledTimes(queryCount + 1);
    expect(mocks.closeBbi).not.toHaveBeenCalled();
  });

  it('fetches neighboring BigWig tiles for the default one-bin smoothing', async () => {
    const range = { start: 920_000, end: 950_000 };
    const setTrackData = vi.fn();
    const map = {
      getViewportRange: () => range,
      getLinearRenderer: () => ({
        hasTrackInstance: () => true,
        setTrackData,
      }),
      requestRender: vi.fn(),
      subscribeToPresentedFrames: vi.fn(() => () => undefined),
    };
    const defaultSmoothingDataset = { ...BIGWIG_LANE.dataset };
    delete defaultSmoothingDataset.quantitativePresentation;
    const defaultSmoothingLane: Lane = {
      ...BIGWIG_LANE,
      dataset: defaultSmoothingDataset,
    };

    renderHook(() =>
      useIndexedUcscTrackStreaming({
        webglRef: { current: map } as never,
        rendererAssembly: ASSEMBLY,
        containerWidth: 1_000,
        activeLanes: [defaultSmoothingLane],
      })
    );
    await settle();

    const records = setTrackData.mock.lastCall?.[1].records as ReadonlyArray<{
      start: number;
      end: number;
    }>;
    expect(records).toHaveLength(3);
    expect(records.some((record) => record.end <= range.start)).toBe(true);
    expect(records.some((record) => record.start >= range.end)).toBe(true);
  });

  it('uses the latest smoothing presentation when assembly readiness arrives later', async () => {
    const range = { start: 920_000, end: 950_000 };
    const setTrackData = vi.fn();
    const map = {
      getViewportRange: () => range,
      getLinearRenderer: () => ({
        hasTrackInstance: () => true,
        setTrackData,
      }),
      requestRender: vi.fn(),
      subscribeToPresentedFrames: vi.fn(() => () => undefined),
    };
    const webglRef = { current: map } as never;
    let rendererAssembly: Assembly | null = null;
    let activeLanes: ReadonlyArray<Lane> = [BIGWIG_LANE];
    const { rerender } = renderHook(() =>
      useIndexedUcscTrackStreaming({
        webglRef,
        rendererAssembly,
        containerWidth: 1_000,
        activeLanes,
      })
    );

    activeLanes = [
      {
        ...BIGWIG_LANE,
        dataset: {
          ...BIGWIG_LANE.dataset,
          quantitativePresentation: {
            version: 1,
            graph: 'bar',
            showRange: true,
            smoothingSigmaBins: 10,
            scale: { mode: 'robust-global', transform: 'linear' },
          },
        },
      },
    ];
    rerender();
    await settle();
    expect(mocks.admitTrack).not.toHaveBeenCalled();

    rendererAssembly = ASSEMBLY;
    rerender();
    await settle();

    const records = setTrackData.mock.lastCall?.[1].records as ReadonlyArray<{
      start: number;
      end: number;
    }>;
    expect(records).toHaveLength(3);
    expect(records.some((record) => record.end <= range.start)).toBe(true);
    expect(records.some((record) => record.start >= range.end)).toBe(true);
    expect(mocks.admitTrack).toHaveBeenCalledOnce();
    expect(mocks.closeBbi).not.toHaveBeenCalled();
  });

  it('streams native interval records at whole-genome view instead of publishing zoom-in blank', async () => {
    const setTrackData = vi.fn();
    const map = {
      getViewportRange: () => ({ start: 0, end: ASSEMBLY.totalLengthBp }),
      getLinearRenderer: () => ({
        hasTrackInstance: () => true,
        setTrackData,
      }),
      requestRender: vi.fn(),
      subscribeToPresentedFrames: vi.fn(() => () => undefined),
    };

    renderHook(() =>
      useIndexedUcscTrackStreaming({
        webglRef: { current: map } as never,
        rendererAssembly: ASSEMBLY,
        containerWidth: 1_000,
        activeLanes: [CPG_LANE],
      })
    );
    await settle();

    expect(mocks.fetchWhole).toHaveBeenCalledOnce();
    expect(mocks.fetchWhole).toHaveBeenCalledWith(
      { genome: 'hg38', track: 'cpgIslandExt', hubUrl: undefined, maxItemsOutput: 1_000_000 },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(mocks.fetchRegion).not.toHaveBeenCalled();
    expect(setTrackData).toHaveBeenCalledWith('ucsc:hg38-cpgIslandExt', {
      records: expect.arrayContaining([
        expect.objectContaining({ chrom: 'chr1', name: 'chr1 CpG island' }),
        expect.objectContaining({ chrom: 'chr2', name: 'chr2 CpG island' }),
      ]),
    });
    expect(
      (window as unknown as { __ucscTrackDebug?: { status?: string } }).__ucscTrackDebug?.status
    ).toBe('ready');
  });

  it('reuses one native sparse snapshot while zooming in and back out', async () => {
    let range = { start: 10_000, end: 20_000 };
    let presented: (() => void) | null = null;
    const setTrackData = vi.fn();
    const map = {
      getViewportRange: () => range,
      getLinearRenderer: () => ({ hasTrackInstance: () => true, setTrackData }),
      requestRender: vi.fn(),
      subscribeToPresentedFrames: vi.fn((listener: () => void) => {
        presented = listener;
        return () => undefined;
      }),
    };

    renderHook(() =>
      useIndexedUcscTrackStreaming({
        webglRef: { current: map } as never,
        rendererAssembly: ASSEMBLY,
        containerWidth: 1_000,
        activeLanes: [CPG_LANE],
      })
    );
    await settle();

    range = { start: 0, end: ASSEMBLY.totalLengthBp };
    act(() => presented?.());
    await settle();

    expect(mocks.fetchWhole).toHaveBeenCalledOnce();
    expect(mocks.fetchRegion).not.toHaveBeenCalled();
    expect(setTrackData).toHaveBeenLastCalledWith(
      'ucsc:hg38-cpgIslandExt',
      expect.objectContaining({ records: expect.arrayContaining([expect.any(Object)]) })
    );
  });

  it('re-presents cached BigWig rows when the lane contract wires a replacement renderer', async () => {
    const firstSetTrackData = vi.fn();
    const secondSetTrackData = vi.fn();
    let renderer = {
      hasTrackInstance: vi.fn(() => true),
      setTrackData: firstSetTrackData,
    };
    const map = {
      getViewportRange: () => ({ start: 0, end: ASSEMBLY.totalLengthBp }),
      getLinearRenderer: () => renderer,
      requestRender: vi.fn(),
      subscribeToPresentedFrames: vi.fn(() => () => undefined),
    };
    const webglRef = { current: map } as never;

    const { result } = renderHook(() =>
      useIndexedUcscTrackStreaming({
        webglRef,
        rendererAssembly: ASSEMBLY,
        containerWidth: 1_000,
        activeLanes: [BIGWIG_LANE],
      })
    );
    await settle();

    const firstPayload = firstSetTrackData.mock.lastCall?.[1] as
      | { records: ReadonlyArray<unknown> }
      | undefined;
    expect(firstPayload?.records.length).toBeGreaterThan(0);
    const admissionCount = mocks.admitTrack.mock.calls.length;
    const queryCount = mocks.queryBbi.mock.calls.length;

    renderer = {
      hasTrackInstance: vi.fn(() => true),
      setTrackData: secondSetTrackData,
    };
    act(() => {
      result.current.noteLaneContractWired();
    });
    await settle();

    expect(secondSetTrackData).toHaveBeenCalledWith('ucsc:hg38-gc5BaseBw', firstPayload);
    expect(mocks.admitTrack).toHaveBeenCalledTimes(admissionCount);
    expect(mocks.queryBbi).toHaveBeenCalledTimes(queryCount);
  });

  it('restores cached BigWig rows after a same-renderer lane-contract rewire', async () => {
    let presented: (() => void) | null = null;
    const setTrackData = vi.fn();
    const renderer = {
      hasTrackInstance: vi.fn(() => true),
      setTrackData,
    };
    const map = {
      getViewportRange: () => ({ start: 0, end: ASSEMBLY.totalLengthBp }),
      getLinearRenderer: () => renderer,
      requestRender: vi.fn(),
      subscribeToPresentedFrames: vi.fn((listener: () => void) => {
        presented = listener;
        return () => undefined;
      }),
    };
    const webglRef = { current: map } as never;

    const { result } = renderHook(() =>
      useIndexedUcscTrackStreaming({
        webglRef,
        rendererAssembly: ASSEMBLY,
        containerWidth: 1_000,
        activeLanes: [BIGWIG_LANE],
      })
    );
    await settle();

    const firstPayload = setTrackData.mock.lastCall?.[1] as
      | { records: ReadonlyArray<unknown> }
      | undefined;
    expect(firstPayload?.records.length).toBeGreaterThan(0);
    const firstCompositionCount = (
      window as unknown as {
        __ucscTrackDebug?: { compositionCounts?: Record<string, number> };
      }
    ).__ucscTrackDebug?.compositionCounts?.['ucsc:hg38-gc5BaseBw'];
    expect(firstCompositionCount).toBe(1);
    const admissionCount = mocks.admitTrack.mock.calls.length;
    const queryCount = mocks.queryBbi.mock.calls.length;

    renderer.setTrackData('ucsc:hg38-gc5BaseBw', { records: [] });
    setTrackData.mockClear();

    act(() => {
      result.current.noteLaneContractWired(['ucsc:hg38-gc5BaseBw']);
    });
    await settle();

    expect(setTrackData).toHaveBeenCalledOnce();
    expect(setTrackData).toHaveBeenCalledWith('ucsc:hg38-gc5BaseBw', firstPayload);
    expect(
      (
        window as unknown as {
          __ucscTrackDebug?: { compositionCounts?: Record<string, number> };
        }
      ).__ucscTrackDebug?.compositionCounts?.['ucsc:hg38-gc5BaseBw']
    ).toBe(2);
    expect(mocks.admitTrack).toHaveBeenCalledTimes(admissionCount);
    expect(mocks.queryBbi).toHaveBeenCalledTimes(queryCount);

    for (let frame = 0; frame < 100; frame += 1) {
      act(() => {
        presented?.();
      });
    }
    await settle();

    expect(setTrackData).toHaveBeenCalledOnce();
    expect(
      (
        window as unknown as {
          __ucscTrackDebug?: { compositionCounts?: Record<string, number> };
        }
      ).__ucscTrackDebug?.compositionCounts?.['ucsc:hg38-gc5BaseBw']
    ).toBe(2);
  });

  it('does not reopen or republish a BigWig when only its display color changes', async () => {
    const setTrackData = vi.fn();
    const map = {
      getViewportRange: () => ({ start: 0, end: ASSEMBLY.totalLengthBp }),
      getLinearRenderer: () => ({
        hasTrackInstance: () => true,
        setTrackData,
      }),
      requestRender: vi.fn(),
      subscribeToPresentedFrames: vi.fn(() => () => undefined),
    };
    let activeLanes: ReadonlyArray<Lane> = [BIGWIG_LANE];
    const webglRef = { current: map } as never;

    const { rerender } = renderHook(() =>
      useIndexedUcscTrackStreaming({
        webglRef,
        rendererAssembly: ASSEMBLY,
        containerWidth: 1_000,
        activeLanes,
      })
    );
    await settle();

    expect(mocks.admitTrack).toHaveBeenCalledOnce();
    expect(mocks.queryBbi).toHaveBeenCalledOnce();
    expect(setTrackData).toHaveBeenCalledOnce();

    activeLanes = [
      {
        ...BIGWIG_LANE,
        dataset: {
          ...BIGWIG_LANE.dataset,
          color: 0xe11d48,
        },
      },
    ];
    rerender();
    await settle();

    expect(mocks.closeBbi).not.toHaveBeenCalled();
    expect(mocks.admitTrack).toHaveBeenCalledOnce();
    expect(mocks.queryBbi).toHaveBeenCalledOnce();
    expect(setTrackData).toHaveBeenCalledOnce();
  });

  it('preserves scientifically meaningful native interval widths when a quantitative source opts out', async () => {
    const nativeIntervalLane: Lane = {
      ...BIGWIG_LANE,
      source: {
        ...BIGWIG_LANE.source!,
        quantitativeColumnSemantics: 'native-interval',
      },
    };
    const map = {
      getViewportRange: () => ({ start: 0, end: ASSEMBLY.totalLengthBp }),
      getLinearRenderer: () => ({
        hasTrackInstance: () => true,
        setTrackData: vi.fn(),
      }),
      requestRender: vi.fn(),
      subscribeToPresentedFrames: vi.fn(() => () => undefined),
    };

    renderHook(() =>
      useIndexedUcscTrackStreaming({
        webglRef: { current: map } as never,
        rendererAssembly: ASSEMBLY,
        containerWidth: 1_000,
        activeLanes: [nativeIntervalLane],
      })
    );
    await settle();

    expect(mocks.queryBbi.mock.calls[0]?.[2]).toBe(1);
  });

  it('does not recompose the same ready BigWig tiles on every camera frame', async () => {
    let range = { start: 920_000, end: 950_000 };
    let presented: (() => void) | null = null;
    const setTrackData = vi.fn();
    const map = {
      getViewportRange: () => range,
      getLinearRenderer: () => ({
        hasTrackInstance: () => true,
        setTrackData,
      }),
      requestRender: vi.fn(),
      subscribeToPresentedFrames: vi.fn((listener: () => void) => {
        presented = listener;
        return () => undefined;
      }),
    };

    renderHook(() =>
      useIndexedUcscTrackStreaming({
        webglRef: { current: map } as never,
        rendererAssembly: ASSEMBLY,
        containerWidth: 1_000,
        activeLanes: [BIGWIG_LANE],
      })
    );
    await settle();
    const initialCompositions = (
      window as unknown as {
        __ucscTrackDebug?: { compositionCounts?: Record<string, number> };
      }
    ).__ucscTrackDebug?.compositionCounts?.['ucsc:hg38-gc5BaseBw'];
    expect(initialCompositions).toBe(1);

    for (let frame = 1; frame <= 100; frame += 1) {
      range = { start: 920_000 + frame, end: 950_000 + frame };
      act(() => {
        presented?.();
      });
    }
    await settle();

    expect(
      (
        window as unknown as {
          __ucscTrackDebug?: { compositionCounts?: Record<string, number> };
        }
      ).__ucscTrackDebug?.compositionCounts?.['ucsc:hg38-gc5BaseBw']
    ).toBe(initialCompositions);
    expect(setTrackData).toHaveBeenCalledTimes(1);
  });

  it('teleports from a populated whole-genome overview to a fine window without fetching intermediate levels', async () => {
    let range = { start: 0, end: ASSEMBLY.totalLengthBp };
    let presented: (() => void) | null = null;
    const setTrackData = vi.fn();
    const map = {
      getViewportRange: () => range,
      getLinearRenderer: () => ({
        hasTrackInstance: () => true,
        setTrackData,
      }),
      requestRender: vi.fn(),
      subscribeToPresentedFrames: vi.fn((listener: () => void) => {
        presented = listener;
        return () => undefined;
      }),
    };

    renderHook(() =>
      useIndexedUcscTrackStreaming({
        webglRef: { current: map } as never,
        rendererAssembly: ASSEMBLY,
        containerWidth: 1_000,
        activeLanes: [LANE],
      })
    );
    await settle();
    expect(mocks.fetchWhole).toHaveBeenCalledOnce();
    expect(mocks.fetchRegion).not.toHaveBeenCalled();

    range = { start: 920_000, end: 920_500 };
    act(() => {
      presented?.();
    });
    await settle();

    const fineCalls = mocks.fetchRegion.mock.calls;
    expect(fineCalls.length).toBeGreaterThan(0);
    for (const [request] of fineCalls) {
      expect(request.end - request.start).toBeLessThanOrEqual(1_024);
    }
    expect(setTrackData).toHaveBeenCalled();
  });

  it('recovers a transient BigWig error without a click and clears the status after rows publish', async () => {
    const successfulQuery = mocks.queryBbi.getMockImplementation()!;
    let completeRetry: (() => void) | undefined;
    mocks.queryBbi.mockRejectedValueOnce(new Error('BBI range request failed'));
    mocks.queryBbi.mockImplementationOnce(
      (...args) =>
        new Promise((resolve) => {
          completeRetry = () => resolve(successfulQuery(...args));
        })
    );
    const setTrackData = vi.fn();
    const map = {
      getViewportRange: () => ({ start: 0, end: ASSEMBLY.totalLengthBp }),
      getLinearRenderer: () => ({
        hasTrackInstance: () => true,
        setTrackData,
      }),
      requestRender: vi.fn(),
      subscribeToPresentedFrames: vi.fn(() => () => undefined),
    };
    const webglRef = { current: map } as never;

    const { result } = renderHook(() =>
      useIndexedUcscTrackStreaming({
        webglRef,
        rendererAssembly: ASSEMBLY,
        containerWidth: 1_000,
        activeLanes: [BIGWIG_LANE],
      })
    );
    await settle();

    expect(result.current.trackErrors).toEqual({
      'ucsc:hg38-gc5BaseBw': UCSC_TRACK_RECOVERING_STATUS,
    });
    const admissionCount = mocks.admitTrack.mock.calls.length;
    const openCount = mocks.openBbi.mock.calls.length;
    const queryCount = mocks.queryBbi.mock.calls.length;

    await settle();

    expect(result.current.trackErrors).toEqual({
      'ucsc:hg38-gc5BaseBw': UCSC_TRACK_RECOVERING_STATUS,
    });
    expect(completeRetry).toBeTypeOf('function');
    expect(mocks.admitTrack).toHaveBeenCalledTimes(admissionCount);
    expect(mocks.openBbi).toHaveBeenCalledTimes(openCount);
    expect(mocks.queryBbi).toHaveBeenCalledTimes(queryCount + 1);

    act(() => {
      completeRetry?.();
    });
    await settle();

    expect(result.current.trackErrors).toEqual({});
    expect(setTrackData).toHaveBeenCalledWith(
      'ucsc:hg38-gc5BaseBw',
      expect.objectContaining({
        records: expect.arrayContaining([
          expect.objectContaining({ chrom: 'chr1', value: 40 }),
          expect.objectContaining({ chrom: 'chr2', value: 41 }),
        ]),
      })
    );
    expect(mocks.admitTrack).toHaveBeenCalledTimes(admissionCount);
    expect(mocks.openBbi).toHaveBeenCalledTimes(openCount);
    expect(mocks.queryBbi).toHaveBeenCalledTimes(queryCount + 1);
  });

  it('does not rerender React for unchanged BigWig recovery across 100 camera frames', async () => {
    mocks.queryBbi.mockRejectedValue(new Error('persistent BBI failure'));
    let range = { start: 920_000, end: 950_000 };
    let presented: (() => void) | null = null;
    let renderCount = 0;
    const renderer = {
      hasTrackInstance: () => true,
      setTrackData: vi.fn(),
    };
    const map = {
      getViewportRange: () => range,
      getLinearRenderer: () => renderer,
      requestRender: vi.fn(),
      subscribeToPresentedFrames: vi.fn((listener: () => void) => {
        presented = listener;
        return () => undefined;
      }),
    };
    const webglRef = { current: map } as never;

    const { result } = renderHook(() => {
      renderCount += 1;
      return useIndexedUcscTrackStreaming({
        webglRef,
        rendererAssembly: ASSEMBLY,
        containerWidth: 1_000,
        activeLanes: [BIGWIG_LANE],
      });
    });
    await settle();

    expect(result.current.trackErrors).toEqual({
      'ucsc:hg38-gc5BaseBw': UCSC_TRACK_RECOVERING_STATUS,
    });
    const renderCountAfterFirstError = renderCount;

    for (let frame = 1; frame <= 100; frame += 1) {
      range = { start: 920_000 + frame, end: 950_000 + frame };
      act(() => {
        presented?.();
      });
    }
    await settle();

    expect(result.current.trackErrors).toEqual({
      'ucsc:hg38-gc5BaseBw': UCSC_TRACK_RECOVERING_STATUS,
    });
    expect(renderCount - renderCountAfterFirstError).toBeLessThanOrEqual(1);
  });

  it('never publishes a late tile from a viewport that side-scrolled away', async () => {
    let range = { start: 100_920_000, end: 100_930_000 };
    let presented: (() => void) | null = null;
    const setTrackData = vi.fn();
    const pending: Array<{
      readonly input: {
        chrom: string;
        start: number;
        end: number;
      };
      readonly signal: AbortSignal | undefined;
      readonly resolve: (value: ReturnType<typeof responseFor>) => void;
    }> = [];
    mocks.fetchRegion.mockImplementation(
      (input: { chrom: string; start: number; end: number }, options: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          pending.push({ input, signal: options.signal, resolve });
        })
    );
    const map = {
      getViewportRange: () => range,
      getLinearRenderer: () => ({
        hasTrackInstance: () => true,
        setTrackData,
      }),
      requestRender: vi.fn(),
      subscribeToPresentedFrames: vi.fn((listener: () => void) => {
        presented = listener;
        return () => undefined;
      }),
    };

    renderHook(() =>
      useIndexedUcscTrackStreaming({
        webglRef: { current: map } as never,
        rendererAssembly: ASSEMBLY,
        containerWidth: 1_000,
        activeLanes: [LANE],
      })
    );
    await settle();
    const firstViewportRequests = [...pending];
    expect(firstViewportRequests.length).toBeGreaterThan(0);

    range = { start: 120_920_000, end: 120_930_000 };
    act(() => {
      presented?.();
    });
    await settle();
    const secondViewportRequests = pending.slice(firstViewportRequests.length);
    expect(secondViewportRequests.length).toBeGreaterThan(0);
    expect(firstViewportRequests.some((request) => request.signal?.aborted)).toBe(true);

    for (const request of firstViewportRequests) {
      request.resolve(responseFor(request.input, 'stale'));
    }
    await settle();
    expect(setTrackData).not.toHaveBeenCalled();

    for (const request of secondViewportRequests) {
      request.resolve(responseFor(request.input, 'current'));
    }
    await settle();
    expect(setTrackData).toHaveBeenCalled();
    const lastRecords = setTrackData.mock.calls.at(-1)?.[1]?.records as Array<{
      transcriptId?: string;
    }>;
    expect(lastRecords.length).toBeGreaterThan(0);
    expect(lastRecords.every((record) => record.transcriptId?.startsWith('current-'))).toBe(true);
  });
});

async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(150);
    await waitForImmediate();
    await waitForImmediate();
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
  });
}

function responseFor(input: { chrom: string; start: number; end: number }, prefix = 'record') {
  const start = input.start + 10;
  const end = Math.min(input.end, start + 100);
  return {
    records:
      end > start
        ? [
            {
              chrom: input.chrom,
              chromStart: start,
              chromEnd: end,
              name: `${prefix}-${input.chrom}-${start}`,
              blockSizes: `${end - start},`,
              chromStarts: '0,',
              thickStart: start + 10,
              thickEnd: Math.max(start + 11, end - 10),
              strand: '+',
            },
          ]
        : [],
    complete: true,
    itemsReturned: end > start ? 1 : 0,
    maxItemsOutput: 10_000,
    trackType: 'bigGenePred',
  };
}
