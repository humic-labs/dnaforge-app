import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Assembly } from '@waypoint/genome-renderer';

import type { ActiveStressDataset } from '../lane-contract-store';
import type { PileupSource } from '../pileup-source';
import type { TileEngineFeed } from '../tile-engine-driver';
import { ExperimentalHybridPileupPublisher } from '../experimental-hybrid-pileup';
import {
  REMOTE_ALIGNED_READ_TILE_TIMEOUT_MS,
  useIndexedPileupStreaming,
} from './useIndexedPileupStreaming';

type CoverageAtlasReuse = {
  coverageGpuAtlas: NonNullable<TileEngineFeed['coverageGpuAtlas']>;
  viewRange: { start: number; end: number };
};

const driverMock = vi.hoisted(() => {
  const instances: Array<{
    options: {
      baseUrl: string;
      assembly: Assembly;
      source: PileupSource;
      timeoutMs: number;
      onFeed: (feed: TileEngineFeed) => void;
      onCoverageAtlasReuse?: (presentation: CoverageAtlasReuse) => void;
      onTileError?: (failure: {
        key: { sourceId: string; level: number; index: number };
        reason: string;
      }) => void;
    };
    setViewport: ReturnType<typeof vi.fn>;
    retryCurrentViewport: ReturnType<typeof vi.fn>;
    presentViewport: ReturnType<typeof vi.fn>;
    canPresentViewportFromTargetGrid: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    debugSnapshot: ReturnType<typeof vi.fn>;
  }> = [];

  class MockTileEngineDriver {
    options: {
      baseUrl: string;
      assembly: Assembly;
      source: PileupSource;
      timeoutMs: number;
      onFeed: (feed: TileEngineFeed) => void;
      onCoverageAtlasReuse?: (presentation: CoverageAtlasReuse) => void;
      onTileError?: (failure: {
        key: { sourceId: string; level: number; index: number };
        reason: string;
      }) => void;
    };
    setViewport = vi.fn();
    retryCurrentViewport = vi.fn(() => true);
    presentViewport = vi.fn(() => true);
    canPresentViewportFromTargetGrid = vi.fn(() => true);
    dispose = vi.fn();
    debugSnapshot = vi.fn(() => ({
      level: null,
      inFlight: 0,
      sourceIds: [],
      aln: { ready: 0, pending: 0, error: 0, readyLevels: [], reads: 0 },
      cov: {
        ready: 0,
        pending: 0,
        error: 0,
        readyLevels: [],
        pendingLevels: [],
        errorLevels: [],
        readyBinsByLevel: [],
      },
      residentCoverage: [],
    }));

    constructor(options: {
      baseUrl: string;
      assembly: Assembly;
      source: PileupSource;
      onFeed: (feed: TileEngineFeed) => void;
      onCoverageAtlasReuse?: (presentation: CoverageAtlasReuse) => void;
      onTileError?: (failure: {
        key: { sourceId: string; level: number; index: number };
        reason: string;
      }) => void;
    }) {
      this.options = options;
      instances.push(this);
    }
  }

  return {
    instances,
    MockTileEngineDriver,
    resolveSidecarBaseUrl: vi.fn(() => Promise.resolve('http://localhost:8015')),
  };
});

vi.mock('../tile-engine-driver', () => ({
  TileEngineDriver: driverMock.MockTileEngineDriver,
}));

vi.mock('../../../services/sidecar-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/sidecar-session')>();
  return {
    ...actual,
    resolveSidecarBaseUrl: driverMock.resolveSidecarBaseUrl,
  };
});

function rendererAssembly(): Assembly {
  return {
    id: 'grch38',
    displayName: 'GRCh38',
    totalLengthBp: 1_000_000,
    chromosomes: [
      {
        chromosome: { id: 'chr11', displayName: 'chr11', length: 1_000_000, cytobands: [] },
        globalStartBp: 0,
        globalEndBp: 1_000_000,
      },
    ],
  } as Assembly;
}

function rendererAssemblyWithShiftedChromLayout(): Assembly {
  return {
    id: 'grch38',
    displayName: 'GRCh38',
    totalLengthBp: 1_000_000,
    chromosomes: [
      {
        chromosome: { id: 'chr10', displayName: 'chr10', length: 400_000, cytobands: [] },
        globalStartBp: 0,
        globalEndBp: 400_000,
      },
      {
        chromosome: { id: 'chr11', displayName: 'chr11', length: 600_000, cytobands: [] },
        globalStartBp: 400_000,
        globalEndBp: 1_000_000,
      },
    ],
  } as Assembly;
}

function humanScaleRendererAssembly(): Assembly {
  return {
    id: 'grch38',
    displayName: 'GRCh38',
    totalLengthBp: 3_088_269_832,
    chromosomes: [
      {
        chromosome: {
          id: 'chr1',
          displayName: 'chr1',
          length: 3_088_269_832,
          cytobands: [],
        },
        globalStartBp: 0,
        globalEndBp: 3_088_269_832,
      },
    ],
  } as Assembly;
}

function pileupDataset(source?: PileupSource): ActiveStressDataset {
  return {
    trackType: 'pileup-genomewide',
    trackId: 'pileup-genomewide-grch38',
    label: 'HG002',
    color: 0x3366cc,
    trackPx: 120,
    records: [],
    kind: 'pileup',
    ...(source ? { source } : {}),
  };
}

function sourceGeneration(version: number): NonNullable<PileupSource['generation']> {
  const file = (suffix: string) => ({
    canonicalPath: `/fixtures/HG002.bam${suffix}`,
    size: version * 1_000,
    mtimeNs: String(version * 1_000_000),
    ctimeNs: String(version * 1_000_000 + 1),
    device: '42',
    inode: String(1_000 + version),
  });
  return {
    contract: 'aligned-read-source-generation.v1',
    alignment: file(''),
    index: file('.bai'),
  };
}

function ignoredTileEngineCoverage() {
  return {
    bins: [3, 8, 13],
    binSize: 4096,
    maxDepth: 13,
    provenance: { exact: true, method: 'pyramid-maxpool', source: 'tile-engine' },
  } as const;
}

function coverageGpuAtlas(): NonNullable<TileEngineFeed['coverageGpuAtlas']> {
  return {
    contract: 'coverage-gpu-atlas.v1',
    authorityKey: 'source\0assembly\0fixed-base-peak-mean-v1\0revision-1',
    sourceIdentity: 'source',
    assemblyFingerprint: 'assembly',
    statistic: 'fixed-base-peak-mean-v1',
    payloadRevision: 'revision-1',
    assemblyStartBp: 0,
    assemblyEndBp: 1_000_000,
    baseBinSizeBp: 250_000,
    textureWidth: 4,
    textureHeight: 1,
    data: new Float32Array([4, 9, 3, 7]),
    depthPercentiles: { p50: 4, p90: 9, p95: 9, p99: 9, max: 9 },
    chromosomes: [
      {
        chrom: 'chr11',
        globalStartBp: 0,
        globalEndBp: 1_000_000,
        baseBinCount: 4,
        rowStart: 0,
        rowCount: 1,
      },
    ],
  };
}

function fakeRenderer() {
  return {
    setTrackData: vi.fn(),
    getTrackDiagnostics: vi.fn(() => null),
    getRendererDebugSnapshot: vi.fn(() => null),
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useIndexedPileupStreaming tile-engine ownership', () => {
  afterEach(() => {
    vi.useRealTimers();
    driverMock.instances.length = 0;
    driverMock.resolveSidecarBaseUrl.mockClear();
    driverMock.resolveSidecarBaseUrl.mockResolvedValue('http://localhost:8015');
    delete window.__webglDiagnosticsEnabled;
    delete window.__webglExposeForTests;
    delete (window as unknown as { __tileEngineFeed?: unknown }).__tileEngineFeed;
    delete (window as unknown as { __tileEnginePublishedFeedReceipts?: unknown })
      .__tileEnginePublishedFeedReceipts;
    delete (window as unknown as { __tileEnginePublishedFeedSnapshot?: unknown })
      .__tileEnginePublishedFeedSnapshot;
  });

  it('starts a restored stationary read lane when its pane gets its first width', async () => {
    const renderer = fakeRenderer();
    const range = { start: 100_000, end: 102_000 };
    const assembly = rendererAssembly();
    const datasets = [pileupDataset({ bamPath: '/fixtures/restored-pane.bam' })];
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => range,
        requestRender: vi.fn(),
      },
    };
    const { result, rerender } = renderHook(
      ({ width }: { width: number }) =>
        useIndexedPileupStreaming({
          webglRef,
          rendererAssembly: assembly,
          containerWidth: width,
          activeStressDatasets: datasets,
        }),
      { initialProps: { width: 0 } }
    );
    act(() => {
      result.current.noteLaneContractWired(renderer, range, [datasets[0].trackId]);
      expect(result.current.streamPileupViaTileEngine(range)).toBe(false);
    });
    expect(driverMock.instances).toHaveLength(0);

    rerender({ width: 286 });
    await waitFor(() => expect(driverMock.instances).toHaveLength(1));
    expect(driverMock.instances[0]?.setViewport).toHaveBeenLastCalledWith(range, 572, 286);
  });

  it('replans a stationary read viewport when its pane expands without another camera gesture', async () => {
    const renderer = fakeRenderer();
    const range = { start: 100_000, end: 102_000 };
    const assembly = rendererAssembly();
    const dataset = pileupDataset({ bamPath: '/fixtures/stationary-pane.bam' });
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => range,
        requestRender: vi.fn(),
      },
    };
    const { rerender, unmount } = renderHook(
      ({ width }: { width: number }) =>
        useIndexedPileupStreaming({
          webglRef,
          rendererAssembly: assembly,
          containerWidth: width,
          activeStressDatasets: [dataset],
        }),
      { initialProps: { width: 286 } }
    );
    try {
      await waitFor(() => expect(driverMock.instances).toHaveLength(1));
      const driver = driverMock.instances[0]!;
      expect(driver.setViewport).toHaveBeenLastCalledWith(range, 572, 286);
      rerender({ width: 1_102 });
      await waitFor(() => expect(driver.setViewport).toHaveBeenLastCalledWith(range, 2_204, 1_102));
      expect(driverMock.instances).toHaveLength(1);
      expect(driver.dispose).not.toHaveBeenCalled();
    } finally {
      unmount();
    }
  });

  it('acknowledges a retained driver feed using the expanded pane plan after a camera dispatch', async () => {
    const renderer = fakeRenderer();
    const range = { start: 100_000, end: 102_000 };
    const assembly = rendererAssembly();
    const dataset = pileupDataset({ bamPath: '/fixtures/expanded-pane-feed.bam' });
    let presentedFrame:
      | ((receipt: { frameEpoch: number; presentedAtMs: number }) => void)
      | undefined;
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => range,
        requestRender: vi.fn(),
        subscribeToPresentedFrames: vi.fn((listener: typeof presentedFrame) => {
          presentedFrame = listener;
          return () => {};
        }),
      },
    };
    const { result, rerender, unmount } = renderHook(
      ({ width }: { width: number }) =>
        useIndexedPileupStreaming({
          webglRef,
          rendererAssembly: assembly,
          containerWidth: width,
          activeStressDatasets: [dataset],
        }),
      { initialProps: { width: 286 } }
    );
    const feed: TileEngineFeed = {
      ownerPresentation: { kind: 'reads' },
      requiredReadBandReady: true,
      viewRange: range,
      records: [{ start: 100_010, end: 100_080, readId: 'pane-read', strand: '+', mapq: 60 }],
      readSource: { truncated: false, windowStartBp: 99_328, windowEndBp: 102_400 },
    };
    try {
      await waitFor(() => expect(driverMock.instances).toHaveLength(1));
      const driver = driverMock.instances[0]!;
      act(() => driver.options.onFeed(feed));
      act(() => presentedFrame?.({ frameEpoch: 1, presentedAtMs: 100 }));
      expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]).toEqual({
        phase: 'ready',
        kind: 'reads',
      });
      rerender({ width: 1_102 });
      act(() => {
        expect(result.current.streamPileupViaTileEngine(range)).toBe(true);
      });
      expect(driverMock.instances).toHaveLength(1);
      expect(driver.setViewport).toHaveBeenLastCalledWith(range, 2_204, 1_102);
      act(() => driver.options.onFeed(feed));
      act(() => presentedFrame?.({ frameEpoch: 2, presentedAtMs: 200 }));
      expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]).toEqual({
        phase: 'ready',
        kind: 'reads',
      });
      expect(driver.dispose).not.toHaveBeenCalled();
    } finally {
      unmount();
    }
  });

  it('starts the already-visible viewport without waiting for a camera gesture', async () => {
    const renderer = fakeRenderer();
    const range = { start: 100_000, end: 101_000 };
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: vi.fn(() => range),
        requestRender: vi.fn(),
      },
    };
    const dataset = pileupDataset({
      bamPath: '/fixtures/HG002.bam',
      indexPath: '/fixtures/HG002.bam.bai',
    });

    const { unmount } = renderHook(() =>
      useIndexedPileupStreaming({
        webglRef,
        rendererAssembly: rendererAssembly(),
        containerWidth: 1_000,
        activeStressDatasets: [dataset],
        enabled: true,
      })
    );

    await waitFor(() => expect(driverMock.instances).toHaveLength(1));
    expect(webglRef.current.getViewportRange).toHaveBeenCalled();
    expect(driverMock.instances[0]!.setViewport).toHaveBeenCalledWith(range, 2000, 1_000);
    unmount();
  });

  it('keeps an admission-blocked replacement repairable without creating a data driver', async () => {
    const renderer = fakeRenderer();
    const range = { start: 100_000, end: 220_000 };
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => range,
        requestRender: vi.fn(),
      },
    };
    const dataset = pileupDataset({
      bamPath: '/fixtures/replaced-in-place.bam',
      indexPath: '/fixtures/replaced-in-place.bam.bai',
      admissionError: 'This BAM does not match GRCh38.',
    });
    const { result, unmount } = renderHook(() =>
      useIndexedPileupStreaming({
        webglRef,
        rendererAssembly: rendererAssembly(),
        containerWidth: 1_000,
        activeStressDatasets: [dataset],
      })
    );

    await waitFor(() =>
      expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]).toEqual({
        phase: 'blocked',
        message: 'This BAM does not match GRCh38.',
        action: 'repair',
        hasLastGood: false,
      })
    );
    expect(result.current.streamPileupViaTileEngine(range)).toBe(false);
    expect(driverMock.instances).toHaveLength(0);
    expect(driverMock.resolveSidecarBaseUrl).not.toHaveBeenCalled();
    unmount();
  });

  it('preserves live SSH identity when constructing the tile-engine driver', async () => {
    const renderer = fakeRenderer();
    const range = { start: 0, end: 1_000 };
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => range,
        requestRender: vi.fn(),
      },
    };
    const remote: NonNullable<PileupSource['remote']> = {
      sessionId: 'remote-session',
      locator: {
        contract: 'remote-alignment-locator.v1',
        endpointId: 'remote-endpoint',
        target: 'lab-hpc',
        alignmentPath: '/cluster/run/sample.bam',
        indexPath: '/cluster/run/sample.bam.bai',
      },
    };
    const dataset = pileupDataset({
      bamPath: 'http://127.0.0.1:61234/v1/session/alignment.bam',
      indexPath: '/tmp/dnaforge-remote-index/alignment.bam.bai',
      remote,
    });
    const { result, unmount } = renderHook(() =>
      useIndexedPileupStreaming({
        webglRef,
        rendererAssembly: rendererAssembly(),
        containerWidth: 1_000,
        activeStressDatasets: [dataset],
      })
    );

    act(() => {
      expect(result.current.streamPileupViaTileEngine(range)).toBe(true);
    });
    await waitFor(() => expect(driverMock.instances).toHaveLength(1));

    expect(driverMock.instances[0]!.options.source.remote).toBe(remote);
    expect(driverMock.instances[0]!.options.timeoutMs).toBe(REMOTE_ALIGNED_READ_TILE_TIMEOUT_MS);
    unmount();
  });

  it('keeps a connecting remote intent visible without opening its remote path as a local file', async () => {
    const renderer = fakeRenderer();
    const range = { start: 0, end: 1_000 };
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => range,
        requestRender: vi.fn(),
      },
    };
    const dataset = pileupDataset({
      bamPath: '/cluster/run/sample.cram',
      indexPath: '/cluster/run/sample.cram.crai',
      remote: {
        locator: {
          contract: 'remote-alignment-locator.v1',
          endpointId: 'remote-endpoint',
          target: 'lab-hpc',
          alignmentPath: '/cluster/run/sample.cram',
          indexPath: '/cluster/run/sample.cram.crai',
        },
        connection: {
          state: 'connecting',
          attempt: 0,
          transportGeneration: 0,
          lastFailure: null,
          updatedAt: 1,
        },
      },
    });
    const { result, unmount } = renderHook(() =>
      useIndexedPileupStreaming({
        webglRef,
        rendererAssembly: rendererAssembly(),
        containerWidth: 1_000,
        activeStressDatasets: [dataset],
      })
    );

    expect(result.current.streamPileupViaTileEngine(range)).toBe(false);
    expect(driverMock.instances).toHaveLength(0);
    expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]).toEqual({
      phase: 'loading',
    });
    unmount();
  });

  it('recommits a stationary viewport when the main-owned SSH transport generation changes', async () => {
    const renderer = fakeRenderer();
    const range = { start: 100_000, end: 101_000 };
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: vi.fn(() => range),
        requestRender: vi.fn(),
        subscribeToPresentedFrames: vi.fn(() => () => undefined),
      },
    };
    const source = (state: 'online' | 'retrying', transportGeneration: number): PileupSource => ({
      bamPath: 'http://127.0.0.1:61234/v1/stable-source/alignment.cram',
      indexPath: '/tmp/dnaforge-remote-source/alignment.crai',
      remote: {
        sessionId: 'stable-source-lease',
        locator: {
          contract: 'remote-alignment-locator.v1',
          endpointId: 'remote-endpoint',
          target: 'lab-hpc',
          alignmentPath: '/cluster/run/sample.cram',
          indexPath: '/cluster/run/sample.cram.crai',
        },
        connection: {
          state,
          attempt: state === 'retrying' ? 1 : 0,
          transportGeneration,
          lastFailure:
            state === 'retrying' ? { code: 'tunnel-failed', message: 'Transport closed.' } : null,
          updatedAt: transportGeneration * 10 + (state === 'retrying' ? 1 : 2),
        },
      },
    });
    const { result, rerender, unmount } = renderHook(
      ({ remoteSource }: { remoteSource: PileupSource }) =>
        useIndexedPileupStreaming({
          webglRef,
          rendererAssembly: rendererAssembly(),
          containerWidth: 1_000,
          activeStressDatasets: [pileupDataset(remoteSource)],
        }),
      { initialProps: { remoteSource: source('online', 1) } }
    );

    act(() => {
      expect(result.current.streamPileupViaTileEngine(range)).toBe(true);
    });
    await waitFor(() => expect(driverMock.instances).toHaveLength(1));
    const driver = driverMock.instances[0]!;

    rerender({ remoteSource: source('retrying', 1) });
    await waitFor(() =>
      expect(result.current.trackLifecycle.getSnapshot()['pileup-genomewide-grch38']).toMatchObject(
        {
          phase: 'recovering',
        }
      )
    );
    expect(driver.retryCurrentViewport).not.toHaveBeenCalled();

    rerender({ remoteSource: source('online', 2) });
    await waitFor(() =>
      expect(driver.retryCurrentViewport).toHaveBeenCalledWith({ restartPending: true })
    );
    expect(driverMock.instances).toHaveLength(1);
    expect(webglRef.current.getViewportRange()).toEqual(range);
    unmount();
  });

  it('revokes inactive-tab tile work and resumes from the current viewport', async () => {
    const renderer = fakeRenderer();
    const range = { start: 100_000, end: 220_000 };
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => range,
        requestRender: vi.fn(),
      },
    };
    const dataset = pileupDataset({
      bamPath: '/fixtures/HG002.bam',
      indexPath: '/fixtures/HG002.bam.bai',
    });
    const { result, rerender, unmount } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useIndexedPileupStreaming({
          webglRef,
          rendererAssembly: rendererAssembly(),
          containerWidth: 1_000,
          activeStressDatasets: [dataset],
          enabled,
        }),
      { initialProps: { enabled: true } }
    );

    act(() => {
      expect(result.current.streamPileupViaTileEngine(range)).toBe(true);
    });
    await waitFor(() => expect(driverMock.instances).toHaveLength(1));
    const first = driverMock.instances[0]!;

    rerender({ enabled: false });
    await waitFor(() => expect(first.dispose).toHaveBeenCalledTimes(1));
    expect(result.current.streamPileupViaTileEngine(range)).toBe(false);
    expect(driverMock.instances).toHaveLength(1);

    rerender({ enabled: true });
    await waitFor(() => expect(driverMock.instances).toHaveLength(2));
    const resumed = driverMock.instances[1]!;
    expect(resumed.setViewport).toHaveBeenCalledWith(range, expect.any(Number), 1_000);
    expect(first.dispose).toHaveBeenCalledTimes(1);

    renderer.setTrackData.mockClear();
    act(() => {
      resumed.options.onFeed({
        coverageGpuAtlas: coverageGpuAtlas(),
        coverageGpuAtlasPresentation: 'active',
        coveragePresentation: { kind: 'current' },
        viewRange: range,
        records: [],
      });
    });
    expect(renderer.setTrackData).toHaveBeenCalledWith(
      dataset.trackId,
      expect.objectContaining({
        dataAuthority: 'tile-engine',
        coverageGpuAtlas: expect.objectContaining({
          depthPercentiles: expect.objectContaining({ max: 9 }),
        }),
        coverageGpuAtlasPresentation: 'active',
      })
    );
    expect(webglRef.current.requestRender).toHaveBeenCalled();

    unmount();
  });

  it('updates each resident BAM payload with only its own height cutoff', async () => {
    const trackData = new Map<
      string,
      { dataAuthority: 'static'; records: []; coverageCutoffDepth: number }
    >([
      ['pileup-a', { dataAuthority: 'static', records: [], coverageCutoffDepth: 25 }],
      ['pileup-b', { dataAuthority: 'static', records: [], coverageCutoffDepth: 140 }],
    ]);
    const renderer = {
      setTrackData: vi.fn(),
      getTrackDiagnostics: vi.fn(() => null),
      getRendererDebugSnapshot: vi.fn(() => null),
      updateTrackData: vi.fn(
        (
          trackId: string,
          update: (current: {
            dataAuthority: 'static';
            records: [];
            coverageCutoffDepth: number;
          }) => {
            dataAuthority: 'static';
            records: [];
            coverageCutoffDepth: number;
          }
        ) => {
          const current = trackData.get(trackId);
          if (!current) return false;
          const next = update(current);
          trackData.set(trackId, next);
          return next !== current;
        }
      ),
    };
    const requestRender = vi.fn();
    const webglRef = { current: { getLinearRenderer: () => renderer, requestRender } };
    const a = { ...pileupDataset(), trackId: 'pileup-a', coverageCutoffDepth: 25 };
    const b = { ...pileupDataset(), trackId: 'pileup-b', coverageCutoffDepth: 140 };

    const { rerender } = renderHook(
      ({ datasets }: { datasets: ActiveStressDataset[] }) =>
        useIndexedPileupStreaming({
          webglRef,
          rendererAssembly: rendererAssembly(),
          containerWidth: 1_000,
          activeStressDatasets: datasets,
        }),
      { initialProps: { datasets: [a, b] } }
    );

    rerender({ datasets: [{ ...a, coverageCutoffDepth: 115 }, b] });
    await waitFor(() => expect(trackData.get('pileup-a')?.coverageCutoffDepth).toBe(115));
    expect(trackData.get('pileup-b')?.coverageCutoffDepth).toBe(140);
    expect(requestRender).toHaveBeenCalledTimes(1);
  });

  it('publishes first-interaction readiness only after an exact full current feed is wired', async () => {
    window.__webglExposeForTests = true;
    const renderer = fakeRenderer();
    const range = { start: 0, end: 1_000_000 };
    const requestRender = vi.fn();
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => range,
        requestRender,
      },
    };
    const dataset = pileupDataset({
      bamPath: '/fixtures/HG002.bam',
      indexPath: '/fixtures/HG002.bam.bai',
      referencePath: '/fixtures/GRCh38.fa',
    });
    const { result, rerender, unmount } = renderHook(
      ({ activeDataset, width }: { activeDataset: ActiveStressDataset; width: number }) =>
        useIndexedPileupStreaming({
          webglRef,
          rendererAssembly: rendererAssembly(),
          containerWidth: width,
          activeStressDatasets: [activeDataset],
        }),
      { initialProps: { activeDataset: dataset, width: 1_000 } }
    );

    act(() => {
      result.current.noteLaneContractWired(renderer, range, [dataset.trackId]);
      expect(result.current.streamPileupViaTileEngine(range)).toBe(true);
    });
    await waitFor(() => expect(driverMock.instances).toHaveLength(1));
    expect(driverMock.instances[0].options.baseUrl).toBe('http://localhost:8015');
    expect(result.current.firstInteractionReadiness.getSnapshot()).toBe(false);

    const exactCurrentFeed: TileEngineFeed = {
      coverage: {
        startBp: 0,
        bins: [4, 9, 3, 7],
        binSize: 250_000,
        maxDepth: 9,
        provenance: {
          exact: true,
          method: 'resolution-ranked-source-merge',
          source: 'tile-engine',
        },
      },
      coverageLod: {
        role: 'current-lod',
        level: 0,
        targetLevel: 0,
        binSize: 250_000,
        authority: 'native-target',
        provenanceExact: true,
        provenanceMethod: 'resolution-ranked-source-merge',
        provenanceSource: 'tile-engine',
      },
      viewRange: range,
      coveragePresentation: { kind: 'current' },
      fullAssemblyInteractionCorridorReady: true,
      records: [],
      alternateColumns: [
        {
          pos: 123,
          kind: 'sub',
          length: 1,
          refBase: 'A',
          readBase: 'G',
          coveringReadCount: 10,
          supportingReadCount: 4,
          weightedDepth: 9.8,
          weightedSupport: 3.9,
          weightedFraction: 0.398,
        },
      ],
      debugTimings: {
        totalMs: 3,
        coverageComposeMs: 1,
        coverageMaxDepthMs: 0.5,
        readsComposeMs: 0,
        recordCount: 0,
        coverageBinCount: 4,
        coverageBinSize: 250_000,
        targetLevel: 0,
        coverageMemoMaterializeCount: 11,
        coverageMemoRevisionChangeCount: 7,
        exactCoverageRecordScanCount: 5,
        exactCoverageGeneration: 3,
      },
    };
    act(() => {
      driverMock.instances[0]!.options.onFeed(exactCurrentFeed);
    });

    expect(renderer.setTrackData).toHaveBeenCalledWith(
      dataset.trackId,
      expect.objectContaining({
        dataAuthority: 'tile-engine',
        alternateColumns: exactCurrentFeed.alternateColumns,
      })
    );
    expect(requestRender).toHaveBeenCalledTimes(1);
    expect(result.current.firstInteractionReadiness.getSnapshot()).toBe(true);
    expect(result.current.firstInteractionReadiness.inspect()).toMatchObject({
      ready: true,
      range,
      viewportPx: 2_000,
    });
    const published = (
      window as unknown as {
        __tileEnginePublishedFeedSnapshot?: (trackId: string) => Record<string, unknown> | null;
      }
    ).__tileEnginePublishedFeedSnapshot?.(dataset.trackId);
    expect(published).toMatchObject({
      contract: 'tile-engine-published-feed-receipt.v1',
      trackId: dataset.trackId,
      publicationSequence: 1,
      coverageMemoMaterializeCount: 11,
      coverageMemoRevisionChangeCount: 7,
      exactCoverageRecordScanCount: 5,
      exactCoverageGeneration: 3,
    });
    expect(published?.publisherEpoch).toMatch(/^tile-engine-publisher:\d+$/);
    const readyKey = result.current.firstInteractionReadiness.inspect().key;

    const cachedRange = { start: 100_000, end: 900_000 };
    act(() => {
      expect(result.current.streamPileupViaTileEngine(cachedRange)).toBe(true);
    });
    expect(driverMock.instances[0]!.presentViewport).toHaveBeenCalledWith(
      cachedRange,
      2_000,
      1_000
    );
    expect(result.current.firstInteractionReadiness.getSnapshot()).toBe(true);
    expect(result.current.firstInteractionReadiness.inspect()).toMatchObject({
      ready: true,
      reason: 'ready',
      range: cachedRange,
    });

    rerender({ activeDataset: dataset, width: 1_001 });
    expect(result.current.firstInteractionReadiness.getSnapshot()).toBe(false);
    expect(result.current.firstInteractionReadiness.inspect().key).not.toBe(readyKey);
    act(() => {
      result.current.noteLaneContractWired(renderer, range, [dataset.trackId]);
      driverMock.instances[0]!.options.onFeed(exactCurrentFeed);
    });
    expect(result.current.firstInteractionReadiness.getSnapshot()).toBe(true);

    rerender({
      activeDataset: pileupDataset({
        bamPath: '/fixtures/HG002-v2.bam',
        indexPath: '/fixtures/HG002-v2.bam.bai',
        referencePath: '/fixtures/GRCh38.fa',
      }),
      width: 1_000,
    });
    act(() => {
      result.current.noteLaneContractWired(renderer, range, [dataset.trackId]);
      driverMock.instances[0]!.options.onFeed(exactCurrentFeed);
    });
    expect(result.current.firstInteractionReadiness.getSnapshot()).toBe(false);
    expect(result.current.firstInteractionReadiness.inspect().key).not.toBe(readyKey);
    unmount();
    expect(
      (
        window as unknown as {
          __tileEnginePublishedFeedSnapshot?: (trackId: string) => Record<string, unknown> | null;
        }
      ).__tileEnginePublishedFeedSnapshot?.(dataset.trackId)
    ).toBeNull();
  });

  it('does not replay a pre-base-url range into a changed assembly context', async () => {
    const baseUrl = deferred<string>();
    driverMock.resolveSidecarBaseUrl.mockReturnValueOnce(baseUrl.promise);
    const renderer = fakeRenderer();
    const recordEvent = vi.fn();
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
      },
    };
    const dataset = pileupDataset({
      bamPath: '/fixtures/HG002.bam',
      indexPath: '/fixtures/HG002.bam.bai',
      referencePath: '/fixtures/GRCh38.fa',
    });

    const { result, rerender, unmount } = renderHook(
      ({ assembly }: { assembly: Assembly }) =>
        useIndexedPileupStreaming({
          webglRef,
          rendererAssembly: assembly,
          containerWidth: 1000,
          activeStressDatasets: [dataset],
          manifestChrom: 'chr11',
          recordEvent,
        }),
      {
        initialProps: {
          assembly: rendererAssembly(),
        },
      }
    );

    act(() => {
      expect(result.current.streamPileupViaTileEngine({ start: 0, end: 1_000 })).toBe(true);
    });
    expect(driverMock.instances).toHaveLength(0);

    rerender({ assembly: rendererAssemblyWithShiftedChromLayout() });

    await act(async () => {
      baseUrl.resolve('http://localhost:8015');
      await baseUrl.promise;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(driverMock.instances).toHaveLength(0);
    unmount();
  });

  it('rebuilds a tile-engine driver when the same track id points at a different source', async () => {
    const renderer = fakeRenderer();
    const recordEvent = vi.fn();
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
      },
    };

    const { result, rerender, unmount } = renderHook(
      ({ datasets }: { datasets: ActiveStressDataset[] }) =>
        useIndexedPileupStreaming({
          webglRef,
          rendererAssembly: rendererAssembly(),
          containerWidth: 1000,
          activeStressDatasets: datasets,
          manifestChrom: 'chr11',
          recordEvent,
        }),
      {
        initialProps: {
          datasets: [
            pileupDataset({
              bamPath: '/fixtures/HG002.old.bam',
              indexPath: '/fixtures/HG002.old.bam.bai',
              referencePath: '/fixtures/GRCh38.fa',
            }),
          ],
        },
      }
    );

    act(() => {
      expect(result.current.streamPileupViaTileEngine({ start: 0, end: 1_000 })).toBe(true);
    });
    await waitFor(() => expect(driverMock.instances).toHaveLength(1));
    const first = driverMock.instances[0]!;
    expect(first.options.source.bamPath).toBe('/fixtures/HG002.old.bam');

    rerender({
      datasets: [
        pileupDataset({
          bamPath: '/fixtures/HG002.new.bam',
          indexPath: '/fixtures/HG002.new.bam.bai',
          referencePath: '/fixtures/GRCh38.fa',
        }),
      ],
    });
    act(() => {
      expect(result.current.streamPileupViaTileEngine({ start: 2_000, end: 3_000 })).toBe(true);
    });

    await waitFor(() => expect(driverMock.instances).toHaveLength(2));
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(renderer.setTrackData).toHaveBeenCalledWith('pileup-genomewide-grch38', {
      dataAuthority: 'tile-engine',
      records: [],
    });
    expect(driverMock.instances[1]!.options.source.bamPath).toBe('/fixtures/HG002.new.bam');

    unmount();
  });

  it('rebuilds resident data when the same paths have a new local file generation', async () => {
    const renderer = fakeRenderer();
    const webglRef = { current: { getLinearRenderer: () => renderer } };
    const source = {
      bamPath: '/fixtures/HG002.bam',
      indexPath: '/fixtures/HG002.bam.bai',
      referencePath: '/fixtures/GRCh38.fa',
    };
    const { result, rerender, unmount } = renderHook(
      ({ generation }: { generation: number }) =>
        useIndexedPileupStreaming({
          webglRef,
          rendererAssembly: rendererAssembly(),
          containerWidth: 1_000,
          activeStressDatasets: [
            pileupDataset({ ...source, generation: sourceGeneration(generation) }),
          ],
        }),
      { initialProps: { generation: 1 } }
    );

    act(() => {
      result.current.streamPileupViaTileEngine({ start: 0, end: 1_000 });
    });
    await waitFor(() => expect(driverMock.instances).toHaveLength(1));
    const first = driverMock.instances[0]!;

    rerender({ generation: 2 });
    act(() => {
      result.current.streamPileupViaTileEngine({ start: 0, end: 1_000 });
    });

    await waitFor(() => expect(driverMock.instances).toHaveLength(2));
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(driverMock.instances[1]!.options.source.bamPath).toBe(source.bamPath);
    expect(renderer.setTrackData).toHaveBeenCalledWith('pileup-genomewide-grch38', {
      dataAuthority: 'tile-engine',
      records: [],
    });
    unmount();
  });

  it('rebuilds the driver with a refreshed htsget grant without using the token as identity', async () => {
    const renderer = fakeRenderer();
    const webglRef = { current: { getLinearRenderer: () => renderer } };
    const identity = 'e'.repeat(64);
    const source = (token: string, grantExpiresAtMs: number): PileupSource => ({
      bamPath: `htsget-runtime://${identity}/source.bam`,
      grantExpiresAtMs,
      htsget: { sourceToken: token, sourceIdentity: identity, format: 'BAM' },
    });
    const { result, rerender, unmount } = renderHook(
      ({ token, expiry }: { token: string; expiry: number }) =>
        useIndexedPileupStreaming({
          webglRef,
          rendererAssembly: rendererAssembly(),
          containerWidth: 1_000,
          activeStressDatasets: [pileupDataset(source(token, expiry))],
        }),
      { initialProps: { token: 'first-short-lived-token', expiry: 1_000 } }
    );

    act(() => {
      result.current.streamPileupViaTileEngine({ start: 0, end: 1_000 });
    });
    await waitFor(() => expect(driverMock.instances).toHaveLength(1));
    expect(driverMock.instances[0]!.options.source.htsget?.sourceToken).toBe(
      'first-short-lived-token'
    );

    rerender({ token: 'second-short-lived-token', expiry: 2_000 });
    act(() => {
      result.current.streamPileupViaTileEngine({ start: 0, end: 1_000 });
    });

    await waitFor(() => expect(driverMock.instances).toHaveLength(2));
    expect(driverMock.instances[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(driverMock.instances[1]!.options.source.htsget?.sourceToken).toBe(
      'second-short-lived-token'
    );
    unmount();
  });

  it('streams two BAM drivers concurrently and disposes only the hidden lane', async () => {
    const renderer = fakeRenderer();
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
      },
    };
    const tumor = {
      ...pileupDataset({ bamPath: '/fixtures/tumor.bam' }),
      trackId: 'pileup-tumor',
    };
    const normal = {
      ...pileupDataset({ bamPath: '/fixtures/normal.bam' }),
      trackId: 'pileup-normal',
    };

    const { result, rerender, unmount } = renderHook(
      ({ datasets }: { datasets: ActiveStressDataset[] }) =>
        useIndexedPileupStreaming({
          webglRef,
          rendererAssembly: rendererAssembly(),
          containerWidth: 1_000,
          activeStressDatasets: datasets,
        }),
      { initialProps: { datasets: [tumor, normal] } }
    );

    act(() => {
      expect(result.current.streamPileupViaTileEngine({ start: 0, end: 1_000 })).toBe(true);
    });
    await waitFor(() => expect(driverMock.instances).toHaveLength(2));
    const tumorDriver = driverMock.instances.find(
      (driver) => driver.options.source.bamPath === '/fixtures/tumor.bam'
    )!;
    const normalDriver = driverMock.instances.find(
      (driver) => driver.options.source.bamPath === '/fixtures/normal.bam'
    )!;
    expect(tumorDriver.setViewport).toHaveBeenCalled();
    expect(normalDriver.setViewport).toHaveBeenCalled();

    rerender({ datasets: [normal, tumor] });
    act(() => {
      expect(result.current.streamPileupViaTileEngine({ start: 1_000, end: 2_000 })).toBe(true);
    });
    expect(driverMock.instances).toHaveLength(2);
    expect(tumorDriver.dispose).not.toHaveBeenCalled();
    expect(normalDriver.dispose).not.toHaveBeenCalled();

    rerender({ datasets: [normal] });

    await waitFor(() => expect(tumorDriver.dispose).toHaveBeenCalledTimes(1));
    expect(normalDriver.dispose).not.toHaveBeenCalled();
    act(() => {
      expect(result.current.streamPileupViaTileEngine({ start: 2_000, end: 3_000 })).toBe(true);
    });
    expect(driverMock.instances).toHaveLength(2);
    await waitFor(
      () =>
        expect(normalDriver.setViewport).toHaveBeenLastCalledWith(
          { start: 2_000, end: 3_000 },
          expect.any(Number),
          1_000
        ),
      { timeout: 1_000 }
    );

    unmount();
  });

  it('adds a second BAM driver incrementally without replacing or cross-publishing the first', async () => {
    const renderer = fakeRenderer();
    const range = { start: 0, end: 1_000 };
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => range,
      },
    };
    const tumor = {
      ...pileupDataset({ bamPath: '/fixtures/tumor.bam' }),
      trackId: 'pileup-tumor',
    };
    const normal = {
      ...pileupDataset({ bamPath: '/fixtures/normal.bam' }),
      trackId: 'pileup-normal',
    };

    const { result, rerender, unmount } = renderHook(
      ({ datasets }: { datasets: ActiveStressDataset[] }) =>
        useIndexedPileupStreaming({
          webglRef,
          rendererAssembly: rendererAssembly(),
          containerWidth: 1_000,
          activeStressDatasets: datasets,
        }),
      { initialProps: { datasets: [tumor] } }
    );

    act(() => {
      expect(result.current.streamPileupViaTileEngine(range)).toBe(true);
    });
    await waitFor(() => expect(driverMock.instances).toHaveLength(1));
    const tumorDriver = driverMock.instances[0]!;
    expect(tumorDriver.options.source.bamPath).toBe('/fixtures/tumor.bam');

    rerender({ datasets: [tumor, normal] });
    act(() => {
      expect(result.current.streamPileupViaTileEngine(range)).toBe(true);
    });
    await waitFor(() => expect(driverMock.instances).toHaveLength(2));
    const normalDriver = driverMock.instances.find(
      (driver) => driver.options.source.bamPath === '/fixtures/normal.bam'
    )!;
    expect(tumorDriver.dispose).not.toHaveBeenCalled();
    expect(tumorDriver.setViewport).toHaveBeenCalledWith(range, 2_000, 1_000);
    expect(normalDriver.setViewport).toHaveBeenCalledWith(range, 2_000, 1_000);

    const feedFor = (depth: number): TileEngineFeed => ({
      coverage: {
        startBp: range.start,
        bins: [depth],
        binSize: range.end - range.start,
        maxDepth: depth,
        provenance: { exact: true, method: 'test-source-isolation', source: 'tile-engine' },
      },
      viewRange: range,
      coveragePresentation: { kind: 'current' },
      records: [],
    });
    act(() => {
      tumorDriver.options.onFeed(feedFor(11));
      normalDriver.options.onFeed(feedFor(29));
    });

    expect(renderer.setTrackData).toHaveBeenCalledWith(
      'pileup-tumor',
      expect.objectContaining({ coverage: expect.objectContaining({ bins: [11] }) })
    );
    expect(renderer.setTrackData).toHaveBeenCalledWith(
      'pileup-normal',
      expect.objectContaining({ coverage: expect.objectContaining({ bins: [29] }) })
    );
    expect(renderer.setTrackData).not.toHaveBeenCalledWith(
      'pileup-tumor',
      expect.objectContaining({ coverage: expect.objectContaining({ bins: [29] }) })
    );

    rerender({ datasets: [normal] });
    await waitFor(() => expect(tumorDriver.dispose).toHaveBeenCalledTimes(1));
    renderer.setTrackData.mockClear();
    act(() => {
      tumorDriver.options.onFeed(feedFor(41));
      normalDriver.options.onFeed(feedFor(43));
    });
    expect(renderer.setTrackData).not.toHaveBeenCalledWith(
      'pileup-tumor',
      expect.objectContaining({ coverage: expect.objectContaining({ bins: [41] }) })
    );
    expect(renderer.setTrackData).toHaveBeenCalledWith(
      'pileup-normal',
      expect.objectContaining({ coverage: expect.objectContaining({ bins: [43] }) })
    );

    unmount();
  });

  it('uses the renderer density sample count, not raw CSS width, for coverage LOD selection', async () => {
    const renderer = fakeRenderer();
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
      },
    };
    const dataset = pileupDataset({
      bamPath: '/fixtures/HG002.bam',
      indexPath: '/fixtures/HG002.bam.bai',
      referencePath: '/fixtures/GRCh38.fa',
    });

    const { result, unmount } = renderHook(() =>
      useIndexedPileupStreaming({
        webglRef,
        rendererAssembly: rendererAssembly(),
        containerWidth: 1338,
        activeStressDatasets: [dataset],
      })
    );

    const range = { start: 100_000, end: 927_163 };
    act(() => {
      expect(result.current.streamPileupViaTileEngine(range)).toBe(true);
    });

    await waitFor(() => expect(driverMock.instances).toHaveLength(1));
    expect(driverMock.instances[0]!.setViewport).toHaveBeenCalledWith(range, 2676, 1338);

    unmount();
  });

  it('does not publish a tile-engine feed whose coverage misses the current renderer viewport', async () => {
    const renderer = fakeRenderer();
    let currentRange = { start: 0, end: 1_000 };
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => currentRange,
      },
    };
    const dataset = pileupDataset({
      bamPath: '/fixtures/HG002.bam',
      indexPath: '/fixtures/HG002.bam.bai',
      referencePath: '/fixtures/GRCh38.fa',
    });

    const { result, unmount } = renderHook(() =>
      useIndexedPileupStreaming({
        webglRef,
        rendererAssembly: humanScaleRendererAssembly(),
        containerWidth: 1000,
        activeStressDatasets: [dataset],
      })
    );

    act(() => {
      expect(result.current.streamPileupViaTileEngine(currentRange)).toBe(true);
    });
    await waitFor(() => expect(driverMock.instances).toHaveLength(1));
    const driver = driverMock.instances[0]!;
    renderer.setTrackData.mockClear();
    driver.setViewport.mockClear();

    currentRange = { start: 2_000, end: 3_000 };
    act(() => {
      driver.options.onFeed({
        coverage: {
          startBp: 0,
          bins: Array.from({ length: 10 }, () => 8),
          binSize: 100,
          maxDepth: 8,
          provenance: { exact: true, method: 'test-current-lod', source: 'tile-engine' },
        },
        records: [],
      });
    });

    expect(renderer.setTrackData).not.toHaveBeenCalled();
    expect(driver.setViewport).not.toHaveBeenCalled();

    unmount();
  });

  it('does not synchronously drive the tile engine again while handling a stale feed', async () => {
    const renderer = fakeRenderer();
    const currentRange = { start: 2_000, end: 3_000 };
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => currentRange,
      },
    };
    const dataset = pileupDataset({
      bamPath: '/fixtures/HG002.bam',
      indexPath: '/fixtures/HG002.bam.bai',
      referencePath: '/fixtures/GRCh38.fa',
    });

    const { result, unmount } = renderHook(() =>
      useIndexedPileupStreaming({
        webglRef,
        rendererAssembly: humanScaleRendererAssembly(),
        containerWidth: 1000,
        activeStressDatasets: [dataset],
      })
    );

    act(() => {
      expect(result.current.streamPileupViaTileEngine(currentRange)).toBe(true);
    });
    await waitFor(() => expect(driverMock.instances).toHaveLength(1));
    const driver = driverMock.instances[0]!;
    driver.setViewport.mockClear();
    let handlingSetViewport = false;
    driver.setViewport.mockImplementation(() => {
      if (handlingSetViewport) {
        throw new Error('tile-engine feed synchronously re-entered setViewport');
      }
      handlingSetViewport = true;
      driver.options.onFeed({
        coverage: {
          startBp: 0,
          bins: Array.from({ length: 10 }, () => 8),
          binSize: 100,
          maxDepth: 8,
          provenance: { exact: true, method: 'test-stale-lod', source: 'tile-engine' },
        },
        records: [],
      });
      handlingSetViewport = false;
    });

    expect(() => {
      driver.options.onFeed({
        coverage: {
          startBp: 0,
          bins: Array.from({ length: 10 }, () => 8),
          binSize: 100,
          maxDepth: 8,
          provenance: { exact: true, method: 'test-stale-lod', source: 'tile-engine' },
        },
        records: [],
      });
    }).not.toThrow();
    expect(driver.setViewport).not.toHaveBeenCalled();

    unmount();
  });

  it('PUBLISHES (never blanks) a feed whose exact coverage OVERLAPS the widened viewport without re-entering the driver', async () => {
    const renderer = fakeRenderer();
    let currentRange = { start: 0, end: 1_000 };
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => currentRange,
      },
    };
    const dataset = pileupDataset({
      bamPath: '/fixtures/HG002.bam',
      indexPath: '/fixtures/HG002.bam.bai',
      referencePath: '/fixtures/GRCh38.fa',
    });

    const { result, unmount } = renderHook(() =>
      useIndexedPileupStreaming({
        webglRef,
        rendererAssembly: humanScaleRendererAssembly(),
        containerWidth: 1000,
        activeStressDatasets: [dataset],
      })
    );

    act(() => {
      expect(result.current.streamPileupViaTileEngine(currentRange)).toBe(true);
    });
    await waitFor(() => expect(driverMock.instances).toHaveLength(1));
    const driver = driverMock.instances[0]!;
    renderer.setTrackData.mockClear();
    driver.setViewport.mockClear();

    currentRange = { start: 0, end: 3_000 };
    act(() => {
      driver.options.onFeed({
        coverage: {
          startBp: 0,
          bins: Array.from({ length: 10 }, () => 8),
          binSize: 100,
          maxDepth: 8,
          provenance: { exact: true, method: 'test-current-lod', source: 'tile-engine' },
        },
        records: [],
      });
    });

    expect(renderer.setTrackData).toHaveBeenCalledTimes(1);
    expect(driver.setViewport).not.toHaveBeenCalled();

    unmount();
  });

  it('publishes new exact reads without erasing the overlapping last-good coverage owner', async () => {
    const renderer = fakeRenderer();
    let currentRange = { start: 0, end: 1_000 };
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => currentRange,
      },
    };
    const dataset = pileupDataset({
      bamPath: '/fixtures/HG002.bam',
      indexPath: '/fixtures/HG002.bam.bai',
      referencePath: '/fixtures/GRCh38.fa',
    });
    const { result, unmount } = renderHook(() =>
      useIndexedPileupStreaming({
        webglRef,
        rendererAssembly: humanScaleRendererAssembly(),
        containerWidth: 1000,
        activeStressDatasets: [dataset],
      })
    );

    act(() => {
      expect(result.current.streamPileupViaTileEngine(currentRange)).toBe(true);
    });
    await waitFor(() => expect(driverMock.instances).toHaveLength(1));
    const driver = driverMock.instances[0]!;
    const lastGoodCoverage = {
      startBp: 0,
      bins: Array.from({ length: 10 }, () => 8),
      binSize: 100,
      maxDepth: 8,
      provenance: { exact: true, method: 'test-current-lod', source: 'tile-engine' },
    } as const;
    const lastGoodLod = {
      role: 'current-lod',
      level: 7,
      targetLevel: 7,
      binSize: 100,
      authority: 'native-target',
      provenanceExact: true,
      provenanceMethod: 'test-current-lod',
      provenanceSource: 'tile-engine',
    } as const;
    act(() => {
      driver.options.onFeed({
        coverage: lastGoodCoverage,
        coverageLod: lastGoodLod,
        viewRange: currentRange,
        coveragePresentation: { kind: 'current' },
        records: [],
      });
    });

    const records = [{ id: 'read-2', start: 250, end: 750 }] as never;
    currentRange = { start: 100, end: 1_100 };
    renderer.setTrackData.mockClear();
    act(() => {
      driver.options.onFeed({
        viewRange: currentRange,
        coveragePresentation: { kind: 'none', reason: 'no-presentable-surface' },
        records,
        readSource: { windowStartBp: 0, windowEndBp: 2_000 },
      });
    });

    expect(renderer.setTrackData).toHaveBeenLastCalledWith(dataset.trackId, {
      dataAuthority: 'tile-engine',
      coverage: lastGoodCoverage,
      coverageLod: lastGoodLod,
      records,
      alternateColumns: [],
      referenceIntervals: [],
      readSource: { windowStartBp: 0, windowEndBp: 2_000, sourceGenerationKey: '' },
    });

    unmount();
  });

  it('uses the clamped assembly data viewport for edge-overscroll pileup ownership', async () => {
    const renderer = fakeRenderer();
    const currentRange = { start: -1_000, end: 1_000 };
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => currentRange,
      },
    };
    const dataset = pileupDataset({
      bamPath: '/fixtures/HG002.bam',
      indexPath: '/fixtures/HG002.bam.bai',
      referencePath: '/fixtures/GRCh38.fa',
    });

    const { result, unmount } = renderHook(() =>
      useIndexedPileupStreaming({
        webglRef,
        rendererAssembly: humanScaleRendererAssembly(),
        containerWidth: 1000,
        activeStressDatasets: [dataset],
      })
    );

    act(() => {
      expect(result.current.streamPileupViaTileEngine(currentRange)).toBe(true);
    });
    await waitFor(() => expect(driverMock.instances).toHaveLength(1));
    const driver = driverMock.instances[0]!;
    expect(driver.setViewport).toHaveBeenCalledWith({ start: 0, end: 1_000 }, 2000, 1000);
    renderer.setTrackData.mockClear();
    driver.setViewport.mockClear();

    act(() => {
      driver.options.onFeed({
        coverage: {
          startBp: 0,
          bins: Array.from({ length: 10 }, () => 8),
          binSize: 100,
          maxDepth: 8,
          provenance: { exact: true, method: 'test-current-lod', source: 'tile-engine' },
        },
        records: [],
      });
    });

    expect(
      renderer.setTrackData,
      'a feed covering the clamped data viewport must not be rejected because the visual camera is overscrolled'
    ).toHaveBeenCalledWith('pileup-genomewide-grch38', {
      dataAuthority: 'tile-engine',
      coverage: expect.objectContaining({ startBp: 0, binSize: 100 }),
      records: [],
      alternateColumns: [],
      referenceIntervals: [],
    });
    expect(driver.setViewport).not.toHaveBeenCalled();

    unmount();
  });

  it('does not clear renderer coverage for transient no-presentable-surface feeds', async () => {
    const renderer = fakeRenderer();
    const currentRange = { start: 2_000, end: 3_000 };
    renderer.getTrackDiagnostics.mockReturnValue({
      coverageSignalStartBp: 1_500,
      coverageSignalEndBp: 3_500,
      activeCoverageBinSize: 100,
    });
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => currentRange,
      },
    };
    const dataset = pileupDataset({
      bamPath: '/fixtures/HG002.bam',
      indexPath: '/fixtures/HG002.bam.bai',
      referencePath: '/fixtures/GRCh38.fa',
    });

    const { result, unmount } = renderHook(() =>
      useIndexedPileupStreaming({
        webglRef,
        rendererAssembly: humanScaleRendererAssembly(),
        containerWidth: 1000,
        activeStressDatasets: [dataset],
      })
    );

    act(() => {
      expect(result.current.streamPileupViaTileEngine(currentRange)).toBe(true);
    });
    await waitFor(() => expect(driverMock.instances).toHaveLength(1));
    const driver = driverMock.instances[0]!;
    renderer.setTrackData.mockClear();
    driver.setViewport.mockClear();

    act(() => {
      driver.options.onFeed({
        records: [],
        viewRange: currentRange,
        coveragePresentation: {
          kind: 'none',
          reason: 'target-pending-no-presentable-surface',
        },
      });
    });

    expect(renderer.setTrackData).not.toHaveBeenCalled();
    expect(renderer.getRendererDebugSnapshot).not.toHaveBeenCalled();
    expect((window as unknown as { __tileEngineFeed?: unknown }).__tileEngineFeed).toBeUndefined();
    expect(driver.setViewport).not.toHaveBeenCalled();

    unmount();
  });

  it('publishes an active atlas-only feed over retained CPU coverage', async () => {
    window.__webglDiagnosticsEnabled = true;
    const renderer = fakeRenderer();
    const currentRange = { start: 0, end: 1_000_000 };
    renderer.getTrackDiagnostics.mockReturnValue({
      coverageSignalStartBp: 0,
      coverageSignalEndBp: 1_000_000,
      activeCoverageBinSize: 1_048_576,
    });
    const requestRender = vi.fn();
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => currentRange,
        requestRender,
      },
    };
    const dataset = pileupDataset({
      bamPath: '/fixtures/HG002.bam',
      indexPath: '/fixtures/HG002.bam.bai',
      referencePath: '/fixtures/GRCh38.fa',
    });

    const { result, unmount } = renderHook(() =>
      useIndexedPileupStreaming({
        webglRef,
        rendererAssembly: rendererAssembly(),
        containerWidth: 1_000,
        activeStressDatasets: [dataset],
      })
    );

    act(() => {
      expect(result.current.streamPileupViaTileEngine(currentRange)).toBe(true);
    });
    await waitFor(() => expect(driverMock.instances).toHaveLength(1));
    const driver = driverMock.instances[0]!;
    const atlas = coverageGpuAtlas();
    renderer.setTrackData.mockClear();
    requestRender.mockClear();

    act(() => {
      driver.options.onFeed({
        coverageGpuAtlas: atlas,
        coverageGpuAtlasPresentation: 'active',
        viewRange: currentRange,
        coveragePresentation: { kind: 'current' },
        records: [],
      });
    });

    expect(renderer.setTrackData).toHaveBeenCalledWith(dataset.trackId, {
      dataAuthority: 'tile-engine',
      coverageGpuAtlas: atlas,
      coverageGpuAtlasPresentation: 'active',
      records: [],
      alternateColumns: [],
      referenceIntervals: [],
    });
    expect(requestRender).toHaveBeenCalledTimes(1);
    expect(
      (window as unknown as { __tileEngineFeed?: { published?: boolean } }).__tileEngineFeed
    ).toMatchObject({ published: true });

    unmount();
  });

  it('retains the committed exact reads while a coverage owner hands off to a new locus', async () => {
    const renderer = fakeRenderer();
    const currentRange = { start: 100_000, end: 101_000 };
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => currentRange,
        requestRender: vi.fn(),
      },
    };
    const dataset = pileupDataset({
      bamPath: '/fixtures/HG002.bam',
      indexPath: '/fixtures/HG002.bam.bai',
      referencePath: '/fixtures/GRCh38.fa',
    });
    const { result, unmount } = renderHook(() =>
      useIndexedPileupStreaming({
        webglRef,
        rendererAssembly: rendererAssembly(),
        containerWidth: 1_000,
        activeStressDatasets: [dataset],
      })
    );

    act(() => {
      expect(result.current.streamPileupViaTileEngine(currentRange)).toBe(true);
    });
    await waitFor(() => expect(driverMock.instances).toHaveLength(1));
    const driver = driverMock.instances[0]!;
    const records = [
      { start: 100_100, end: 100_180, readId: 'read-1', strand: '+' as const, mapq: 60 },
    ];
    const readSource = {
      windowStartBp: 100_000,
      windowEndBp: 101_000,
      truncated: false,
      sourceGenerationKey: '',
    };

    act(() => {
      driver.options.onFeed({
        ownerPresentation: { kind: 'reads' },
        viewRange: currentRange,
        records,
        readSource,
      });
    });
    renderer.setTrackData.mockClear();

    act(() => {
      driver.options.onFeed({
        ownerPresentation: { kind: 'coverage' },
        coverageGpuAtlas: coverageGpuAtlas(),
        coverageGpuAtlasPresentation: 'active',
        viewRange: currentRange,
        coveragePresentation: { kind: 'current' },
        records: [],
      });
    });

    expect(renderer.setTrackData).toHaveBeenLastCalledWith(
      dataset.trackId,
      expect.objectContaining({
        records,
        readSource,
        coverageGpuAtlasPresentation: 'active',
      })
    );

    unmount();
  });

  it('keeps completed right-hand reads in the hybrid lane while the left tile is pending', async () => {
    const renderer = fakeRenderer();
    const hybridSetTrackData = vi.fn();
    let currentRange = { start: 100_000, end: 101_000 };
    const dataset = pileupDataset({
      bamPath: '/fixtures/HG002.bam',
      indexPath: '/fixtures/HG002.bam.bai',
      referencePath: '/fixtures/GRCh38.fa',
    });
    const publisher = new ExperimentalHybridPileupPublisher({
      definitions: [
        {
          trackId: 'hybrid-right-left',
          alignmentTrackId: dataset.trackId,
          quantitativeTrackId: 'signal',
          coverageCutoffDepth: 80,
          loadingAnimation: 'diagonal-scan',
        },
      ],
      target: {
        getRenderer: () => ({ hasTrackInstance: () => true, setTrackData: hybridSetTrackData }),
        requestRender: vi.fn(),
      },
    });
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => currentRange,
        requestRender: vi.fn(),
      },
    };
    const { result, unmount } = renderHook(() =>
      useIndexedPileupStreaming({
        webglRef,
        rendererAssembly: rendererAssembly(),
        containerWidth: 1_000,
        activeStressDatasets: [dataset],
        onTrackDataPublished: (trackId, data) => publisher.publishAlignment(trackId, data),
      })
    );

    act(() => {
      expect(result.current.streamPileupViaTileEngine(currentRange)).toBe(true);
    });
    await waitFor(() => expect(driverMock.instances).toHaveLength(1));
    const driver = driverMock.instances[0]!;
    const records = [
      { start: 100_200, end: 100_450, readId: 'right-read', strand: '+' as const, mapq: 60 },
    ];
    const readSource = {
      windowStartBp: 100_000,
      windowEndBp: 101_000,
      truncated: false,
      sourceGenerationKey: '',
    };
    act(() => {
      driver.options.onFeed({
        ownerPresentation: { kind: 'reads' },
        viewRange: currentRange,
        records,
        readSource,
        referenceIntervals: [],
      });
    });

    currentRange = { start: 99_500, end: 100_500 };
    act(() => {
      expect(result.current.streamPileupViaTileEngine(currentRange)).toBe(true);
      driver.options.onFeed({
        ownerPresentation: { kind: 'pending' },
        viewRange: currentRange,
        coveragePresentation: { kind: 'none', reason: 'target-pending-no-presentable-surface' },
        records: [],
        referenceIntervals: [{ startBp: 99_500, endBp: 100_000, state: 'pending' }],
      });
    });

    expect(hybridSetTrackData).toHaveBeenLastCalledWith(
      'hybrid-right-left',
      expect.objectContaining({
        records,
        readSource,
        referenceIntervals: [{ startBp: 99_500, endBp: 100_000, state: 'pending' }],
        experimentalReadHandoff: expect.objectContaining({ readsLoading: true }),
      })
    );
    unmount();
  });

  it('clears stale renderer coverage for transient no-presentable-surface feeds when current coverage is absent', async () => {
    const renderer = fakeRenderer();
    const currentRange = { start: 2_000, end: 3_000 };
    renderer.getTrackDiagnostics.mockReturnValue({
      coverageSignalStartBp: 0,
      coverageSignalEndBp: 1_000,
      activeCoverageBinSize: 100,
    });
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => currentRange,
      },
    };
    const dataset = pileupDataset({
      bamPath: '/fixtures/HG002.bam',
      indexPath: '/fixtures/HG002.bam.bai',
      referencePath: '/fixtures/GRCh38.fa',
    });

    const { result, unmount } = renderHook(() =>
      useIndexedPileupStreaming({
        webglRef,
        rendererAssembly: humanScaleRendererAssembly(),
        containerWidth: 1000,
        activeStressDatasets: [dataset],
      })
    );

    act(() => {
      expect(result.current.streamPileupViaTileEngine(currentRange)).toBe(true);
    });
    await waitFor(() => expect(driverMock.instances).toHaveLength(1));
    const driver = driverMock.instances[0]!;
    renderer.setTrackData.mockClear();
    driver.setViewport.mockClear();

    act(() => {
      driver.options.onFeed({
        records: [],
        viewRange: currentRange,
        coveragePresentation: {
          kind: 'none',
          reason: 'target-pending-no-presentable-surface',
        },
      });
    });

    expect(renderer.setTrackData).toHaveBeenCalledWith('pileup-genomewide-grch38', {
      dataAuthority: 'tile-engine',
      coverage: undefined,
      records: [],
      alternateColumns: [],
      referenceIntervals: [],
    });
    expect(driver.setViewport).not.toHaveBeenCalled();

    unmount();
  });

  it('publishes mutation columns even when an unchanged retained histogram owns coverage', async () => {
    const renderer = fakeRenderer();
    const currentRange = { start: 2_000, end: 3_000 };
    renderer.getTrackDiagnostics.mockReturnValue({
      coverageSignalStartBp: 1_500,
      coverageSignalEndBp: 3_500,
      activeCoverageBinSize: 100,
    });
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => currentRange,
        requestRender: vi.fn(),
      },
    };
    const dataset = pileupDataset({
      bamPath: '/fixtures/HG002.bam',
      indexPath: '/fixtures/HG002.bam.bai',
      referencePath: '/fixtures/GRCh38.fa',
    });
    const { result, unmount } = renderHook(() =>
      useIndexedPileupStreaming({
        webglRef,
        rendererAssembly: humanScaleRendererAssembly(),
        containerWidth: 1000,
        activeStressDatasets: [dataset],
      })
    );

    act(() => {
      expect(result.current.streamPileupViaTileEngine(currentRange)).toBe(true);
    });
    await waitFor(() => expect(driverMock.instances).toHaveLength(1));
    const driver = driverMock.instances[0]!;
    renderer.setTrackData.mockClear();

    act(() => {
      driver.options.onFeed({
        records: [],
        alternateColumns: [
          {
            pos: 2_500,
            kind: 'sub',
            length: 1,
            refBase: 'A',
            readBase: 'G',
            coveringReadCount: 54,
            supportingReadCount: 54,
            weightedDepth: 53.7,
            weightedSupport: 53.7,
            weightedFraction: 1,
          },
        ],
        viewRange: currentRange,
        coveragePresentation: {
          kind: 'none',
          reason: 'target-pending-no-presentable-surface',
        },
      });
    });

    expect(renderer.setTrackData).toHaveBeenCalledWith(
      'pileup-genomewide-grch38',
      expect.objectContaining({
        records: [],
        alternateColumns: [expect.objectContaining({ pos: 2_500, readBase: 'G' })],
      })
    );
    expect(webglRef.current.requestRender).toHaveBeenCalled();
    unmount();
  });

  it('RETAINS (does not clear) retained coverage that OVERLAPS the widened viewport on an empty feed', async () => {
    const renderer = fakeRenderer();
    const currentRange = { start: 2_000, end: 3_000 };
    renderer.getTrackDiagnostics.mockReturnValue({
      coverageSignalStartBp: 1_500,
      coverageSignalEndBp: 2_500,
      activeCoverageBinSize: 100,
    });
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => currentRange,
      },
    };
    const dataset = pileupDataset({
      bamPath: '/fixtures/HG002.bam',
      indexPath: '/fixtures/HG002.bam.bai',
      referencePath: '/fixtures/GRCh38.fa',
    });

    const { result, unmount } = renderHook(() =>
      useIndexedPileupStreaming({
        webglRef,
        rendererAssembly: humanScaleRendererAssembly(),
        containerWidth: 1000,
        activeStressDatasets: [dataset],
      })
    );

    act(() => {
      expect(result.current.streamPileupViaTileEngine(currentRange)).toBe(true);
    });
    await waitFor(() => expect(driverMock.instances).toHaveLength(1));
    const driver = driverMock.instances[0]!;
    renderer.setTrackData.mockClear();
    driver.setViewport.mockClear();

    act(() => {
      driver.options.onFeed({
        records: [],
        viewRange: currentRange,
        coveragePresentation: { kind: 'none', reason: 'target-pending-no-presentable-surface' },
      });
    });

    expect(renderer.setTrackData).not.toHaveBeenCalled();

    unmount();
  });

  it('drops stale transient no-presentable-surface feeds without re-entering the driver', async () => {
    const renderer = fakeRenderer();
    const currentRange = { start: 2_000, end: 3_000 };
    const staleRange = { start: 0, end: 1_000 };
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => currentRange,
      },
    };
    const dataset = pileupDataset({
      bamPath: '/fixtures/HG002.bam',
      indexPath: '/fixtures/HG002.bam.bai',
      referencePath: '/fixtures/GRCh38.fa',
    });

    const { result, unmount } = renderHook(() =>
      useIndexedPileupStreaming({
        webglRef,
        rendererAssembly: humanScaleRendererAssembly(),
        containerWidth: 1000,
        activeStressDatasets: [dataset],
      })
    );

    act(() => {
      expect(result.current.streamPileupViaTileEngine(currentRange)).toBe(true);
    });
    await waitFor(() => expect(driverMock.instances).toHaveLength(1));
    const driver = driverMock.instances[0]!;
    renderer.setTrackData.mockClear();
    driver.setViewport.mockClear();

    act(() => {
      driver.options.onFeed({
        records: [],
        viewRange: staleRange,
        coveragePresentation: {
          kind: 'none',
          reason: 'target-pending-no-presentable-surface',
        },
      });
    });

    expect(renderer.setTrackData).not.toHaveBeenCalled();
    expect(driver.setViewport).not.toHaveBeenCalled();

    unmount();
  });

  it('clears stale tile-engine coverage for terminal target coverage errors', async () => {
    const renderer = fakeRenderer();
    const currentRange = { start: 2_000, end: 3_000 };
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => currentRange,
      },
    };
    const dataset = pileupDataset({
      bamPath: '/fixtures/HG002.bam',
      indexPath: '/fixtures/HG002.bam.bai',
      referencePath: '/fixtures/GRCh38.fa',
    });

    const { result, unmount } = renderHook(() =>
      useIndexedPileupStreaming({
        webglRef,
        rendererAssembly: humanScaleRendererAssembly(),
        containerWidth: 1000,
        activeStressDatasets: [dataset],
      })
    );

    act(() => {
      expect(result.current.streamPileupViaTileEngine(currentRange)).toBe(true);
    });
    await waitFor(() => expect(driverMock.instances).toHaveLength(1));
    const driver = driverMock.instances[0]!;
    renderer.setTrackData.mockClear();
    driver.setViewport.mockClear();

    act(() => {
      driver.options.onFeed({
        records: [],
        viewRange: currentRange,
        coveragePresentation: {
          kind: 'none',
          reason: 'target-error',
        },
      });
    });

    expect(renderer.setTrackData).toHaveBeenCalledWith('pileup-genomewide-grch38', {
      dataAuthority: 'tile-engine',
      coverage: undefined,
      records: [],
      alternateColumns: [],
      referenceIntervals: [],
    });
    expect(driver.setViewport).not.toHaveBeenCalled();

    unmount();
  });

  it('publishes coverage LOD metadata with the exact coverage signal handed to the renderer', async () => {
    const renderer = fakeRenderer();
    const currentRange = { start: 2_000, end: 3_000 };
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => currentRange,
      },
    };
    const dataset = pileupDataset({
      bamPath: '/fixtures/HG002.bam',
      indexPath: '/fixtures/HG002.bam.bai',
      referencePath: '/fixtures/GRCh38.fa',
    });

    const { result, unmount } = renderHook(() =>
      useIndexedPileupStreaming({
        webglRef,
        rendererAssembly: humanScaleRendererAssembly(),
        containerWidth: 1000,
        activeStressDatasets: [dataset],
      })
    );

    act(() => {
      expect(result.current.streamPileupViaTileEngine(currentRange)).toBe(true);
    });
    await waitFor(() => expect(driverMock.instances).toHaveLength(1));
    const driver = driverMock.instances[0]!;
    renderer.setTrackData.mockClear();

    const coverageLod = {
      role: 'current-lod' as const,
      level: 9,
      targetLevel: 9,
      binSize: 512,
      authority: 'target-grid-derived-from-finer' as const,
      provenanceExact: true,
      provenanceMethod: 'target-grid-derived-from-finer',
      sourceLevel: 6,
      sourceBinSize: 64,
    };
    const coverage = {
      startBp: 1_900,
      bins: Array.from({ length: 4 }, () => 8),
      binSize: 512,
      maxDepth: 8,
      provenance: {
        exact: true,
        method: 'target-grid-derived-from-finer',
        source: 'tile-engine',
        sourceLevel: 6,
        sourceBinSize: 64,
      },
    };

    act(() => {
      driver.options.onFeed({
        coverage,
        coverageLod,
        records: [],
      });
    });

    expect(renderer.setTrackData).toHaveBeenCalledWith('pileup-genomewide-grch38', {
      dataAuthority: 'tile-engine',
      coverage,
      coverageLod,
      records: [],
      alternateColumns: [],
      referenceIntervals: [],
    });

    unmount();
  });

  it('coalesces rapid camera commits to the latest tile-engine request plan', async () => {
    vi.useFakeTimers();
    let now = 0;
    const performanceNowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const renderer = fakeRenderer();
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
      },
    };
    const dataset = pileupDataset({
      bamPath: '/fixtures/HG002.bam',
      indexPath: '/fixtures/HG002.bam.bai',
      referencePath: '/fixtures/GRCh38.fa',
    });

    const { result, unmount } = renderHook(() =>
      useIndexedPileupStreaming({
        webglRef,
        rendererAssembly: humanScaleRendererAssembly(),
        containerWidth: 1000,
        activeStressDatasets: [dataset],
      })
    );

    const first = { start: 0, end: 20_000_000 };
    act(() => {
      expect(result.current.streamPileupViaTileEngine(first)).toBe(true);
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(driverMock.instances).toHaveLength(1);
    const driver = driverMock.instances[0]!;
    expect(driver.setViewport).toHaveBeenCalledTimes(1);
    expect(driver.setViewport).toHaveBeenLastCalledWith(first, 2000, 1000);

    const obsolete = { start: 10_000, end: 18_010_000 };
    const latest = { start: 1_500_000, end: 17_500_000 };
    now = 10;
    act(() => {
      expect(result.current.streamPileupViaTileEngine(obsolete)).toBe(true);
      expect(result.current.streamPileupViaTileEngine(latest)).toBe(true);
    });

    expect(driver.setViewport).toHaveBeenCalledTimes(1);
    expect(driver.presentViewport).toHaveBeenCalledWith(obsolete, 2000, 1000);
    expect(driver.presentViewport).toHaveBeenLastCalledWith(latest, 2000, 1000);
    now = 96;
    act(() => {
      vi.advanceTimersByTime(86);
    });

    expect(driver.setViewport).toHaveBeenCalledTimes(2);
    expect(driver.setViewport).not.toHaveBeenCalledWith(obsolete, 2000, 1000);
    expect(driver.setViewport).toHaveBeenLastCalledWith(latest, 2000, 1000);

    performanceNowSpy.mockRestore();
    unmount();
  });

  it('updates presentation for same-plan pans without launching a new tile request', async () => {
    const renderer = fakeRenderer();
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
      },
    };
    const dataset = pileupDataset({
      bamPath: '/fixtures/HG002.bam',
      indexPath: '/fixtures/HG002.bam.bai',
      referencePath: '/fixtures/GRCh38.fa',
    });

    const { result, unmount } = renderHook(() =>
      useIndexedPileupStreaming({
        webglRef,
        rendererAssembly: humanScaleRendererAssembly(),
        containerWidth: 1000,
        activeStressDatasets: [dataset],
      })
    );

    const initial = { start: 0, end: 20_000_000 };
    act(() => {
      expect(result.current.streamPileupViaTileEngine(initial)).toBe(true);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(driverMock.instances).toHaveLength(1);
    const driver = driverMock.instances[0]!;
    expect(driver.setViewport).toHaveBeenCalledTimes(1);
    driver.setViewport.mockClear();
    driver.presentViewport.mockClear();

    const samePlanPan = { start: 1_000, end: 20_001_000 };
    act(() => {
      expect(result.current.streamPileupViaTileEngine(samePlanPan)).toBe(true);
    });

    expect(driver.presentViewport).toHaveBeenCalledWith(samePlanPan, 2000, 1000);
    expect(driver.setViewport).not.toHaveBeenCalled();

    unmount();
  });

  it('forces a same-plan tile request when cache-only presentation cannot cover the new viewport', async () => {
    const renderer = fakeRenderer();
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
      },
    };
    const dataset = pileupDataset({
      bamPath: '/fixtures/HG002.bam',
      indexPath: '/fixtures/HG002.bam.bai',
      referencePath: '/fixtures/GRCh38.fa',
    });

    const { result, unmount } = renderHook(() =>
      useIndexedPileupStreaming({
        webglRef,
        rendererAssembly: humanScaleRendererAssembly(),
        containerWidth: 1000,
        activeStressDatasets: [dataset],
      })
    );

    const initial = { start: 0, end: 20_000_000 };
    act(() => {
      expect(result.current.streamPileupViaTileEngine(initial)).toBe(true);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const driver = driverMock.instances[0]!;
    expect(driver.setViewport).toHaveBeenCalledTimes(1);
    driver.setViewport.mockClear();
    driver.presentViewport.mockClear();
    driver.presentViewport.mockReturnValue(false);

    const samePlanPan = { start: 1_000, end: 20_001_000 };
    act(() => {
      expect(result.current.streamPileupViaTileEngine(samePlanPan)).toBe(true);
    });

    expect(driver.presentViewport).toHaveBeenCalledWith(samePlanPan, 2000, 1000);
    expect(driver.setViewport).toHaveBeenCalledWith(samePlanPan, 2000, 1000);

    unmount();
  });

  it('coalesces broad LOD camera bursts without dropping the latest material tile plan', async () => {
    vi.useFakeTimers();
    let now = 0;
    const performanceNowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const renderer = fakeRenderer();
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
      },
    };
    const dataset = pileupDataset({
      bamPath: '/fixtures/HG002.bam',
      indexPath: '/fixtures/HG002.bam.bai',
      referencePath: '/fixtures/GRCh38.fa',
    });

    const { result, unmount } = renderHook(() =>
      useIndexedPileupStreaming({
        webglRef,
        rendererAssembly: humanScaleRendererAssembly(),
        containerWidth: 1338,
        activeStressDatasets: [dataset],
      })
    );

    const fullGenome = { start: 0, end: 3_088_269_832 };
    act(() => {
      expect(result.current.streamPileupViaTileEngine(fullGenome)).toBe(true);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(driverMock.instances).toHaveLength(1);
    const driver = driverMock.instances[0]!;
    expect(driver.setViewport).toHaveBeenCalledTimes(1);

    const obsoleteSameBucket = { start: 0, end: 2_000_000_000 };
    const materialBucketChange = { start: 0, end: 300_000_000 };
    now = 12;
    act(() => {
      expect(result.current.streamPileupViaTileEngine(obsoleteSameBucket)).toBe(true);
      expect(result.current.streamPileupViaTileEngine(materialBucketChange)).toBe(true);
    });

    expect(driver.setViewport).toHaveBeenCalledTimes(1);
    expect(driver.presentViewport).toHaveBeenCalledWith(obsoleteSameBucket, 2676, 1338);
    expect(driver.presentViewport).toHaveBeenLastCalledWith(materialBucketChange, 2676, 1338);
    now = 96;
    act(() => {
      vi.advanceTimersByTime(84);
    });

    expect(driver.setViewport).toHaveBeenCalledTimes(2);
    expect(driver.setViewport).not.toHaveBeenCalledWith(obsoleteSameBucket, 2676, 1338);
    expect(driver.setViewport).toHaveBeenLastCalledWith(materialBucketChange, 2676, 1338);

    performanceNowSpy.mockRestore();
    unmount();
  });

  it('flushes the level-11 coverage commit so level 10 can prefetch before the sub-1Mb handoff', async () => {
    const performanceNowSpy = vi.spyOn(performance, 'now');
    performanceNowSpy.mockReturnValue(0);
    const renderer = fakeRenderer();
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
      },
    };
    const dataset = pileupDataset({
      bamPath: '/fixtures/HG002.bam',
      indexPath: '/fixtures/HG002.bam.bai',
      referencePath: '/fixtures/GRCh38.fa',
    });

    const { result, unmount } = renderHook(() =>
      useIndexedPileupStreaming({
        webglRef,
        rendererAssembly: humanScaleRendererAssembly(),
        containerWidth: 1338,
        activeStressDatasets: [dataset],
      })
    );

    const level13Viewport = { start: 0, end: 20_000_000 };
    act(() => {
      expect(result.current.streamPileupViaTileEngine(level13Viewport)).toBe(true);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(driverMock.instances).toHaveLength(1);
    const driver = driverMock.instances[0]!;
    expect(driver.setViewport).toHaveBeenCalledTimes(1);
    expect(driver.setViewport).toHaveBeenLastCalledWith(level13Viewport, 2676, 1338);

    performanceNowSpy.mockReturnValue(10);
    const criticalLevel11Viewport = { start: 0, end: 4_000_000 };
    act(() => {
      expect(result.current.streamPileupViaTileEngine(criticalLevel11Viewport)).toBe(true);
    });

    expect(
      driver.setViewport,
      'level 11 must be committed immediately so the coordinator can warm level 10 before sub-1Mb presentation'
    ).toHaveBeenCalledTimes(2);
    expect(driver.setViewport).toHaveBeenLastCalledWith(criticalLevel11Viewport, 2676, 1338);

    performanceNowSpy.mockRestore();
    unmount();
  });

  it('rebuilds a tile-engine driver when the assembly layout changes under the same id and source', async () => {
    const renderer = fakeRenderer();
    const recordEvent = vi.fn();
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
      },
    };
    const dataset = pileupDataset({
      bamPath: '/fixtures/HG002.bam',
      indexPath: '/fixtures/HG002.bam.bai',
      referencePath: '/fixtures/GRCh38.fa',
    });

    const { result, rerender, unmount } = renderHook(
      ({ assembly }: { assembly: Assembly }) =>
        useIndexedPileupStreaming({
          webglRef,
          rendererAssembly: assembly,
          containerWidth: 1000,
          activeStressDatasets: [dataset],
          manifestChrom: 'chr11',
          recordEvent,
        }),
      {
        initialProps: {
          assembly: rendererAssembly(),
        },
      }
    );

    act(() => {
      expect(result.current.streamPileupViaTileEngine({ start: 0, end: 1_000 })).toBe(true);
    });
    await waitFor(() => expect(driverMock.instances).toHaveLength(1));
    const first = driverMock.instances[0]!;
    expect(first.options.assembly.chromosomes).toHaveLength(1);

    rerender({ assembly: rendererAssemblyWithShiftedChromLayout() });
    act(() => {
      expect(result.current.streamPileupViaTileEngine({ start: 400_000, end: 401_000 })).toBe(true);
    });

    await waitFor(() => expect(driverMock.instances).toHaveLength(2));
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(renderer.setTrackData).toHaveBeenCalledWith('pileup-genomewide-grch38', {
      dataAuthority: 'tile-engine',
      records: [],
    });
    expect(
      driverMock.instances[1]!.options.assembly.chromosomes.map((p) => p.chromosome.id)
    ).toEqual(['chr10', 'chr11']);

    unmount();
  });

  it('clears cached tile-engine coverage while rebuilding a superseded driver', async () => {
    const renderer = fakeRenderer();
    const recordEvent = vi.fn();
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
      },
    };

    const { result, rerender, unmount } = renderHook(
      ({ datasets }: { datasets: ActiveStressDataset[] }) =>
        useIndexedPileupStreaming({
          webglRef,
          rendererAssembly: rendererAssembly(),
          containerWidth: 1000,
          activeStressDatasets: datasets,
          manifestChrom: 'chr11',
          recordEvent,
        }),
      {
        initialProps: {
          datasets: [
            {
              ...pileupDataset({
                bamPath: '/fixtures/HG002.old.bam',
                indexPath: '/fixtures/HG002.old.bam.bai',
                referencePath: '/fixtures/GRCh38.fa',
              }),
              coverage: ignoredTileEngineCoverage(),
            },
          ],
        },
      }
    );

    act(() => {
      expect(result.current.streamPileupViaTileEngine({ start: 0, end: 1_000 })).toBe(true);
    });
    await waitFor(() => expect(driverMock.instances).toHaveLength(1));
    const first = driverMock.instances[0]!;

    rerender({
      datasets: [
        {
          ...pileupDataset({
            bamPath: '/fixtures/HG002.new.bam',
            indexPath: '/fixtures/HG002.new.bam.bai',
            referencePath: '/fixtures/GRCh38.fa',
          }),
          coverage: ignoredTileEngineCoverage(),
        },
      ],
    });
    act(() => {
      expect(result.current.streamPileupViaTileEngine({ start: 2_000, end: 3_000 })).toBe(true);
    });

    await waitFor(() => expect(driverMock.instances).toHaveLength(2));
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(renderer.setTrackData).toHaveBeenCalledWith('pileup-genomewide-grch38', {
      dataAuthority: 'tile-engine',
      records: [],
    });

    unmount();
  });

  it('disposes a tile-engine driver when the same track is no longer engine-owned', async () => {
    const renderer = fakeRenderer();
    const recordEvent = vi.fn();
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
      },
    };
    const sourced = pileupDataset({
      bamPath: '/fixtures/HG002.bam',
      indexPath: '/fixtures/HG002.bam.bai',
      referencePath: '/fixtures/GRCh38.fa',
    });
    const unsourced = pileupDataset();

    const { result, rerender, unmount } = renderHook(
      ({ datasets }: { datasets: ActiveStressDataset[] }) =>
        useIndexedPileupStreaming({
          webglRef,
          rendererAssembly: rendererAssembly(),
          containerWidth: 1000,
          activeStressDatasets: datasets,
          manifestChrom: 'chr11',
          recordEvent,
        }),
      {
        initialProps: {
          datasets: [sourced],
        },
      }
    );

    act(() => {
      expect(result.current.streamPileupViaTileEngine({ start: 0, end: 1_000 })).toBe(true);
    });
    await waitFor(() => expect(driverMock.instances).toHaveLength(1));
    const first = driverMock.instances[0]!;

    rerender({ datasets: [unsourced] });

    await waitFor(() => expect(first.dispose).toHaveBeenCalledTimes(1));
    expect(renderer.setTrackData).toHaveBeenCalledWith('pileup-genomewide-grch38', {
      dataAuthority: 'static',
      records: [],
    });
    renderer.setTrackData.mockClear();
    first.options.onFeed({
      coverage: {
        bins: [9],
        binSize: 1024,
        maxDepth: 9,
        provenance: { exact: true, method: 'test', source: 'tile-engine' },
      },
      records: [],
    });

    expect(renderer.setTrackData).not.toHaveBeenCalled();

    unmount();
  });

  it('does not downgrade a still source-backed pileup dataset to static data when assembly disappears', async () => {
    const renderer = fakeRenderer();
    const recordEvent = vi.fn();
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
      },
    };
    const sourced = {
      ...pileupDataset({
        bamPath: '/fixtures/HG002.bam',
        indexPath: '/fixtures/HG002.bam.bai',
        referencePath: '/fixtures/GRCh38.fa',
      }),
      coverage: ignoredTileEngineCoverage(),
    } satisfies ActiveStressDataset;

    const { result, rerender, unmount } = renderHook(
      ({ assembly }: { assembly: Assembly | null }) =>
        useIndexedPileupStreaming({
          webglRef,
          rendererAssembly: assembly,
          containerWidth: 1000,
          activeStressDatasets: [sourced],
          manifestChrom: 'chr11',
          recordEvent,
        }),
      {
        initialProps: {
          assembly: rendererAssembly(),
        },
      }
    );

    act(() => {
      expect(result.current.streamPileupViaTileEngine({ start: 0, end: 1_000 })).toBe(true);
    });
    await waitFor(() => expect(driverMock.instances).toHaveLength(1));
    const first = driverMock.instances[0]!;

    rerender({ assembly: null });

    await waitFor(() => expect(first.dispose).toHaveBeenCalledTimes(1));
    expect(renderer.setTrackData).toHaveBeenCalledWith('pileup-genomewide-grch38', {
      dataAuthority: 'tile-engine',
      records: [],
    });
    expect(renderer.setTrackData).not.toHaveBeenCalledWith(
      'pileup-genomewide-grch38',
      expect.objectContaining({
        dataAuthority: 'static',
        coverage: sourced.coverage,
      })
    );

    unmount();
  });

  it.each(['partial core frame', 'pre-error complete frame'] as const)(
    'keeps required-band recovery through a %s until the complete current band is presented',
    async (ordering) => {
      const renderer = fakeRenderer();
      const range = { start: 100_000, end: 102_000 };
      let presentedFrame:
        | ((receipt: { frameEpoch: number; presentedAtMs: number }) => void)
        | undefined;
      const webglRef = {
        current: {
          getLinearRenderer: () => renderer,
          getViewportRange: () => range,
          requestRender: vi.fn(),
          subscribeToPresentedFrames: vi.fn(
            (listener: (receipt: { frameEpoch: number; presentedAtMs: number }) => void) => {
              presentedFrame = listener;
              return () => {};
            }
          ),
        },
      };
      const dataset = pileupDataset({
        bamPath: 'http://127.0.0.1:61234/v1/source/alignment.bam',
        indexPath: '/tmp/dnaforge-remote-index/alignment.bam.bai',
        remote: {
          sessionId: 'remote-lease',
          locator: {
            contract: 'remote-alignment-locator.v1',
            endpointId: 'remote-endpoint',
            target: 'lab-hpc',
            alignmentPath: '/cluster/run/sample.bam',
            signalPath: '/cluster/run/sample.bw',
          },
        },
      });
      const { result, unmount } = renderHook(() =>
        useIndexedPileupStreaming({
          webglRef,
          rendererAssembly: rendererAssembly(),
          containerWidth: 2048,
          activeStressDatasets: [dataset],
        })
      );
      try {
        await waitFor(() => expect(driverMock.instances).toHaveLength(1));
        const driver = driverMock.instances[0]!;
        const readsFeed = (requiredReadBandReady: boolean): TileEngineFeed => ({
          ownerPresentation: { kind: 'reads' },
          requiredReadBandReady,
          viewRange: range,
          records: [
            { start: 100_010, end: 100_080, readId: 'current-core', strand: '+', mapq: 60 },
          ],
          readSource: { truncated: false, windowStartBp: 99_328, windowEndBp: 102_400 },
        });
        vi.useFakeTimers();
        if (ordering === 'pre-error complete frame') {
          act(() => driver.options.onFeed(readsFeed(true)));
          expect(presentedFrame).toBeTypeOf('function');
        }
        act(() =>
          driver.options.onTileError?.({
            key: { sourceId: `aln:${dataset.source!.bamPath}:chr11`, level: 0, index: 96 },
            reason: 'queue-full',
          })
        );
        expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]?.phase).toBe(
          'recovering'
        );
        if (ordering === 'partial core frame') act(() => driver.options.onFeed(readsFeed(false)));
        act(() => presentedFrame?.({ frameEpoch: 7, presentedAtMs: 700 }));
        expect(renderer.setTrackData, 'valid core pixels remain paintable').toHaveBeenCalled();
        expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]?.phase).toBe(
          'recovering'
        );
        await act(async () => {
          vi.advanceTimersByTime(500);
          await Promise.resolve();
        });
        expect(
          driver.retryCurrentViewport,
          'the required collar still owns its bounded retry'
        ).toHaveBeenCalledTimes(1);
        act(() => driver.options.onFeed(readsFeed(false)));
        act(() => presentedFrame?.({ frameEpoch: 8, presentedAtMs: 800 }));
        expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]?.phase).toBe(
          'recovering'
        );
        act(() => driver.options.onFeed(readsFeed(true)));
        expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]?.phase).toBe(
          'recovering'
        );
        act(() => presentedFrame?.({ frameEpoch: 9, presentedAtMs: 900 }));
        expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]).toEqual({
          phase: 'ready',
          kind: 'reads',
        });
        act(() => vi.advanceTimersByTime(500));
        expect(driver.retryCurrentViewport).toHaveBeenCalledTimes(1);
      } finally {
        unmount();
      }
    }
  );

  it('retries one unchanged viewport for duplicate transient failures and waits for presentation', async () => {
    const renderer = fakeRenderer();
    const range = { start: 100_000, end: 220_000 };
    let presentedFrame:
      | ((receipt: { frameEpoch: number; presentedAtMs: number }) => void)
      | undefined;
    const unsubscribePresentedFrame = vi.fn();
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => range,
        requestRender: vi.fn(),
        subscribeToPresentedFrames: vi.fn(
          (listener: (receipt: { frameEpoch: number; presentedAtMs: number }) => void) => {
            presentedFrame = listener;
            return unsubscribePresentedFrame;
          }
        ),
      },
    };
    const dataset = pileupDataset({
      bamPath: '/fixtures/HG002.bam',
      indexPath: '/fixtures/HG002.bam.bai',
    });
    const { result, unmount } = renderHook(() =>
      useIndexedPileupStreaming({
        webglRef,
        rendererAssembly: rendererAssembly(),
        containerWidth: 1_000,
        activeStressDatasets: [dataset],
      })
    );

    act(() => {
      expect(result.current.streamPileupViaTileEngine(range)).toBe(true);
    });
    await waitFor(() => expect(driverMock.instances).toHaveLength(1));
    expect(webglRef.current.subscribeToPresentedFrames).not.toHaveBeenCalled();
    expect(presentedFrame).toBeUndefined();
    const driver = driverMock.instances[0]!;
    expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]).toEqual({
      phase: 'loading',
    });
    const lifecycleListener = vi.fn();
    const unsubscribeLifecycle = result.current.trackLifecycle.subscribe(lifecycleListener);

    vi.useFakeTimers();
    act(() => {
      for (let index = 0; index < 100; index += 1) {
        driver.options.onTileError?.({
          key: { sourceId: 'aln:fixture:chr11', level: 0, index },
          reason: 'queue-full',
        });
      }
    });
    expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]).toEqual({
      phase: 'recovering',
      attempt: 1,
      hasLastGood: false,
    });
    expect(driver.retryCurrentViewport).not.toHaveBeenCalled();
    expect(lifecycleListener).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    expect(driver.retryCurrentViewport).toHaveBeenCalledTimes(1);

    act(() => {
      driver.options.onFeed({
        ownerPresentation: { kind: 'reads' },
        requiredReadBandReady: true,
        viewRange: range,
        records: [{ start: 110_000, end: 110_100, readId: 'read-1', strand: '+', mapq: 60 }],
      });
    });
    expect(webglRef.current.subscribeToPresentedFrames).toHaveBeenCalledTimes(1);
    expect(presentedFrame).toBeTypeOf('function');
    expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]?.phase).toBe('recovering');

    act(() => presentedFrame?.({ frameEpoch: 7, presentedAtMs: 700 }));
    expect(unsubscribePresentedFrame).toHaveBeenCalledTimes(1);
    expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]).toEqual({
      phase: 'ready',
      kind: 'reads',
    });
    expect(lifecycleListener).toHaveBeenCalledTimes(2);

    unsubscribeLifecycle();
    unmount();
  });

  it('reports a side-scroll as active SSH streaming, escalates a silent request, and clears the stall on progress', async () => {
    vi.useFakeTimers();
    const renderer = fakeRenderer();
    let range = { start: 100_000, end: 101_000 };
    let presentedFrame: (() => void) | undefined;
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => range,
        requestRender: vi.fn(() => presentedFrame?.()),
        subscribeToPresentedFrames: vi.fn((listener: () => void) => {
          presentedFrame = listener;
          return () => undefined;
        }),
      },
    };
    const dataset = pileupDataset({
      bamPath: 'http://127.0.0.1:61234/v1/session/alignment.bam',
      indexPath: '/tmp/dnaforge-remote-index/alignment.bam.bai',
      remote: {
        sessionId: 'remote-session',
        locator: {
          contract: 'remote-alignment-locator.v1',
          endpointId: 'remote-endpoint',
          target: 'lab-hpc',
          alignmentPath: '/cluster/run/sample.bam',
          indexPath: '/cluster/run/sample.bam.bai',
        },
      },
    });
    const { result, unmount } = renderHook(() =>
      useIndexedPileupStreaming({
        webglRef,
        rendererAssembly: rendererAssembly(),
        containerWidth: 1_000,
        activeStressDatasets: [dataset],
      })
    );

    act(() => {
      result.current.streamPileupViaTileEngine(range);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const driver = driverMock.instances[0]!;
    act(() => {
      driver.options.onFeed({
        ownerPresentation: { kind: 'reads' },
        viewRange: range,
        records: [{ start: 100_100, end: 100_180, readId: 'read-a', strand: '+', mapq: 60 }],
      });
    });
    expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]).toEqual({
      phase: 'ready',
      kind: 'reads',
    });

    range = { start: 100_010, end: 101_010 };
    driver.presentViewport.mockReturnValue(false);
    act(() => {
      result.current.streamPileupViaTileEngine(range);
    });
    expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]).toEqual({
      phase: 'refreshing',
      hasLastGood: true,
    });

    act(() => vi.advanceTimersByTime(4_000));
    expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]).toEqual({
      phase: 'recovering',
      attempt: 1,
      hasLastGood: true,
    });

    act(() => {
      driver.options.onFeed({
        ownerPresentation: { kind: 'pending' },
        coveragePresentation: {
          kind: 'none',
          reason: 'target-pending-no-presentable-surface',
        },
        viewRange: range,
        records: [],
        referenceIntervals: [{ startBp: range.start, endBp: range.end, state: 'pending' }],
      });
    });
    expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]).toEqual({
      phase: 'refreshing',
      hasLastGood: true,
    });
    act(() => vi.advanceTimersByTime(3_000));
    act(() => {
      driver.options.onFeed({
        ownerPresentation: { kind: 'pending' },
        coveragePresentation: {
          kind: 'none',
          reason: 'target-pending-no-presentable-surface',
        },
        viewRange: range,
        records: [],
        referenceIntervals: [{ startBp: range.start, endBp: range.end, state: 'pending' }],
      });
    });
    act(() => vi.advanceTimersByTime(999));
    expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]?.phase).toBe('refreshing');
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]).toEqual({
      phase: 'recovering',
      attempt: 2,
      hasLastGood: true,
    });

    act(() => {
      driver.options.onFeed({
        ownerPresentation: { kind: 'reads' },
        viewRange: range,
        records: [{ start: 100_110, end: 100_190, readId: 'read-b', strand: '+', mapq: 60 }],
      });
    });
    expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]).toEqual({
      phase: 'ready',
      kind: 'reads',
    });
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]?.phase).toBe('ready');
    unmount();
  });

  it('automatically recommits the live viewport when streaming makes no progress', async () => {
    vi.useFakeTimers();
    const renderer = fakeRenderer();
    const range = { start: 100_000, end: 101_000 };
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => range,
        requestRender: vi.fn(),
        subscribeToPresentedFrames: vi.fn(() => () => undefined),
      },
    };
    const dataset = pileupDataset({
      bamPath: 'http://127.0.0.1:61234/v1/session/alignment.cram',
      indexPath: '/tmp/dnaforge-remote-index/alignment.crai',
      remote: {
        sessionId: 'remote-session',
        locator: {
          contract: 'remote-alignment-locator.v1',
          endpointId: 'remote-endpoint',
          target: 'lab-hpc',
          alignmentPath: '/cluster/run/sample.cram',
          indexPath: '/cluster/run/sample.cram.crai',
        },
      },
    });
    const { result, unmount } = renderHook(() =>
      useIndexedPileupStreaming({
        webglRef,
        rendererAssembly: rendererAssembly(),
        containerWidth: 1_000,
        activeStressDatasets: [dataset],
      })
    );

    act(() => {
      result.current.streamPileupViaTileEngine(range);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const driver = driverMock.instances[0]!;
    expect(driver.retryCurrentViewport).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(4_000);
      await Promise.resolve();
    });

    expect(driver.retryCurrentViewport).toHaveBeenCalledTimes(1);
    expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]).toMatchObject({
      phase: 'recovering',
      attempt: 1,
    });
    unmount();
  });

  it('restarts stalled local tile work because no gateway owns its timeout', async () => {
    vi.useFakeTimers();
    const renderer = fakeRenderer();
    const range = { start: 100_000, end: 101_000 };
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => range,
        requestRender: vi.fn(),
        subscribeToPresentedFrames: vi.fn(() => () => undefined),
      },
    };
    const dataset = pileupDataset({
      bamPath: '/fixtures/local-stalled.bam',
      indexPath: '/fixtures/local-stalled.bam.bai',
    });
    const { result, unmount } = renderHook(() =>
      useIndexedPileupStreaming({
        webglRef,
        rendererAssembly: rendererAssembly(),
        containerWidth: 1_000,
        activeStressDatasets: [dataset],
      })
    );

    act(() => {
      result.current.streamPileupViaTileEngine(range);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const driver = driverMock.instances[0]!;

    await act(async () => {
      vi.advanceTimersByTime(4_000);
      await Promise.resolve();
    });

    expect(driver.retryCurrentViewport).toHaveBeenCalledWith({ restartPending: true });
    expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]).toMatchObject({
      phase: 'recovering',
      attempt: 1,
    });
    unmount();
  });

  it('replays a stationary viewport without aborting the gateway request that owns SSH recovery', async () => {
    vi.useFakeTimers();
    const renderer = fakeRenderer();
    const range = { start: 100_000, end: 101_000 };
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => range,
        requestRender: vi.fn(),
        subscribeToPresentedFrames: vi.fn(() => () => undefined),
      },
    };
    const dataset = pileupDataset({
      bamPath: 'http://127.0.0.1:61234/v1/session/alignment.cram',
      indexPath: '/tmp/dnaforge-remote-index/alignment.crai',
      remote: {
        sessionId: 'dead-remote-session',
        locator: {
          contract: 'remote-alignment-locator.v1',
          endpointId: 'remote-endpoint',
          target: 'lab-hpc',
          alignmentPath: '/cluster/run/sample.cram',
          indexPath: '/cluster/run/sample.cram.crai',
        },
      },
    });
    const remoteSourceProbe = vi.fn(async () => false);
    const reconnectRemoteTrack = vi.fn(async () => true);
    const { result, unmount } = renderHook(() =>
      useIndexedPileupStreaming({
        webglRef,
        rendererAssembly: rendererAssembly(),
        containerWidth: 1_000,
        activeStressDatasets: [dataset],
        remoteSourceProbe,
        reconnectRemoteTrack,
      })
    );

    act(() => {
      result.current.streamPileupViaTileEngine(range);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const driver = driverMock.instances[0]!;

    await act(async () => {
      vi.advanceTimersByTime(4_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(remoteSourceProbe).toHaveBeenCalledWith(dataset.source);
    expect(reconnectRemoteTrack).toHaveBeenCalledOnce();
    expect(reconnectRemoteTrack).toHaveBeenCalledWith(dataset.trackId);
    expect(driver.retryCurrentViewport).toHaveBeenCalledWith({ restartPending: false });
    expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]).toMatchObject({
      phase: 'recovering',
      attempt: 1,
    });
    unmount();
  });

  it('presents a successfully settled zero-read band as empty without retrying', async () => {
    const renderer = fakeRenderer();
    const range = { start: 400_000, end: 401_000 };
    let presentedFrame: (() => void) | undefined;
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => range,
        requestRender: vi.fn(() => presentedFrame?.()),
        subscribeToPresentedFrames: vi.fn((listener: () => void) => {
          presentedFrame = listener;
          return () => undefined;
        }),
      },
    };
    const dataset = pileupDataset({ bamPath: '/fixtures/empty.bam' });
    const { result, unmount } = renderHook(() =>
      useIndexedPileupStreaming({
        webglRef,
        rendererAssembly: rendererAssembly(),
        containerWidth: 1_000,
        activeStressDatasets: [dataset],
      })
    );

    act(() => {
      result.current.streamPileupViaTileEngine(range);
    });
    await waitFor(() => expect(driverMock.instances).toHaveLength(1));
    const driver = driverMock.instances[0]!;
    act(() => {
      driver.options.onFeed({
        ownerPresentation: { kind: 'empty' },
        coveragePresentation: { kind: 'none', reason: 'no-presentable-surface' },
        viewRange: range,
        records: [],
      });
    });

    expect(renderer.setTrackData).toHaveBeenCalledWith(
      dataset.trackId,
      expect.objectContaining({ dataAuthority: 'tile-engine', records: [] })
    );
    expect(driver.retryCurrentViewport).not.toHaveBeenCalled();
    expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]).toEqual({
      phase: 'ready',
      kind: 'empty',
    });
    unmount();
  });

  it('arms the presentation receipt on the current live map handle only when needed', async () => {
    const renderer = fakeRenderer();
    const range = { start: 400_000, end: 401_000 };
    let stalePresentedFrame: (() => void) | undefined;
    let livePresentedFrame: (() => void) | undefined;
    const staleUnsubscribe = vi.fn();
    const liveUnsubscribe = vi.fn();
    const staleMap = {
      getLinearRenderer: () => renderer,
      getViewportRange: () => range,
      requestRender: vi.fn(() => stalePresentedFrame?.()),
      schedulePostPresentWork: vi.fn(),
      subscribeToPresentedFrames: vi.fn((listener: () => void) => {
        stalePresentedFrame = listener;
        return staleUnsubscribe;
      }),
    };
    const liveMap = {
      getLinearRenderer: () => renderer,
      getViewportRange: () => range,
      requestRender: vi.fn(() => livePresentedFrame?.()),
      schedulePostPresentWork: vi.fn(),
      subscribeToPresentedFrames: vi.fn((listener: () => void) => {
        livePresentedFrame = listener;
        return liveUnsubscribe;
      }),
    };
    const webglRef: { current: typeof staleMap | typeof liveMap } = {
      current: staleMap,
    };
    const dataset = pileupDataset({ bamPath: '/fixtures/empty.bam' });
    const { result, unmount } = renderHook(() =>
      useIndexedPileupStreaming({
        webglRef,
        rendererAssembly: rendererAssembly(),
        containerWidth: 1_000,
        activeStressDatasets: [dataset],
      })
    );

    act(() => {
      result.current.streamPileupViaTileEngine(range);
    });
    await waitFor(() => expect(driverMock.instances).toHaveLength(1));
    expect(staleMap.subscribeToPresentedFrames).not.toHaveBeenCalled();
    webglRef.current = liveMap;
    act(() => {
      driverMock.instances[0]!.options.onFeed({
        ownerPresentation: { kind: 'empty' },
        coveragePresentation: { kind: 'none', reason: 'no-presentable-surface' },
        viewRange: range,
        records: [],
      });
    });

    expect(staleUnsubscribe).not.toHaveBeenCalled();
    expect(liveMap.subscribeToPresentedFrames).toHaveBeenCalledTimes(1);
    expect(liveUnsubscribe).toHaveBeenCalledTimes(1);
    expect(liveMap.requestRender).toHaveBeenCalledTimes(1);
    expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]).toEqual({
      phase: 'ready',
      kind: 'empty',
    });
    unmount();
  });

  it.each(['new-plan', 'same-plan', 'rejected-feed'] as const)(
    'acknowledges an unchanged atlas after %s only on its current presented frame',
    async (scenario) => {
      vi.useFakeTimers({ toFake: ['performance'] });
      const renderer = fakeRenderer();
      const initialRange = { start: 0, end: 200_000 };
      let range = initialRange;
      const frames: Array<() => void> = [];
      const map = {
        getLinearRenderer: () => renderer,
        getViewportRange: () => range,
        requestRender: vi.fn(),
        subscribeToPresentedFrames: vi.fn((listener: () => void) => {
          frames.push(listener);
          return vi.fn();
        }),
      };
      const dataset = pileupDataset({ bamPath: '/fixtures/atlas-reuse.bam' });
      const { result, unmount } = renderHook(() =>
        useIndexedPileupStreaming({
          webglRef: { current: map },
          rendererAssembly: rendererAssembly(),
          containerWidth: 1_000,
          activeStressDatasets: [dataset],
        })
      );
      await waitFor(() => expect(driverMock.instances).toHaveLength(1));
      const driver = driverMock.instances[0]!;
      const atlas = coverageGpuAtlas();
      act(() => {
        driver.options.onFeed({
          records: [],
          ownerPresentation: { kind: 'coverage' },
          coverageGpuAtlas: atlas,
          coverageGpuAtlasPresentation: 'active',
          viewRange: scenario === 'rejected-feed' ? { start: 0.5, end: 200_000.5 } : range,
        });
      });
      if (scenario !== 'rejected-feed') act(() => frames.at(-1)?.());
      const originalFrameCount = frames.length;
      const publications = renderer.setTrackData.mock.calls.length;
      const fetchCommits = driver.setViewport.mock.calls.length;
      range =
        scenario === 'new-plan'
          ? { start: 700_000, end: 900_000 }
          : { start: 10_000, end: 210_000 };
      act(() => {
        result.current.streamPileupViaTileEngine(range);
      });
      expect(driver.options.onCoverageAtlasReuse).toBeTypeOf('function');
      act(() => {
        driver.options.onCoverageAtlasReuse?.({ coverageGpuAtlas: { ...atlas }, viewRange: range });
        driver.options.onCoverageAtlasReuse?.({ coverageGpuAtlas: atlas, viewRange: initialRange });
      });
      expect(frames).toHaveLength(originalFrameCount);
      act(() => {
        driver.options.onCoverageAtlasReuse?.({ coverageGpuAtlas: atlas, viewRange: range });
      });
      expect(frames).toHaveLength(originalFrameCount + 1);
      if (scenario !== 'same-plan') {
        expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]?.phase).not.toBe(
          'ready'
        );
      }
      expect(renderer.setTrackData).toHaveBeenCalledTimes(publications);
      expect(driver.setViewport).toHaveBeenCalledTimes(fetchCommits);
      act(() => frames.at(-1)?.());
      expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]).toEqual({
        phase: 'ready',
        kind: 'coverage',
      });
      expect(renderer.setTrackData).toHaveBeenCalledTimes(publications);
      expect(driver.setViewport).toHaveBeenCalledTimes(fetchCommits);
      unmount();
    }
  );

  it('requires a replacement frame when a rejected atlas feed precedes lane wiring', async () => {
    const firstRenderer = fakeRenderer();
    const replacementRenderer = fakeRenderer();
    let renderer = firstRenderer;
    const range = { start: 10_000, end: 210_000 };
    const frames: Array<() => void> = [];
    const map = {
      getLinearRenderer: () => renderer,
      getViewportRange: () => range,
      requestRender: vi.fn(),
      subscribeToPresentedFrames: vi.fn((listener: () => void) => {
        frames.push(listener);
        return vi.fn();
      }),
    };
    const dataset = pileupDataset({ bamPath: '/fixtures/atlas-renderer-replacement.bam' });
    const { result, unmount } = renderHook(() =>
      useIndexedPileupStreaming({
        webglRef: { current: map },
        rendererAssembly: rendererAssembly(),
        containerWidth: 1_000,
        activeStressDatasets: [dataset],
      })
    );
    await waitFor(() => expect(driverMock.instances).toHaveLength(1));
    const driver = driverMock.instances[0]!;
    const atlas = coverageGpuAtlas();
    const feed = {
      records: [],
      ownerPresentation: { kind: 'coverage' as const },
      coverageGpuAtlas: atlas,
      coverageGpuAtlasPresentation: 'active' as const,
      viewRange: range,
    };
    act(() => driver.options.onFeed(feed));
    act(() => frames.at(-1)?.());
    expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]?.phase).toBe('ready');
    renderer = replacementRenderer;
    act(() => {
      driver.options.onFeed({ ...feed, viewRange: { start: 10_000.5, end: 210_000.5 } });
      result.current.noteLaneContractWired(replacementRenderer, range, [dataset.trackId]);
    });
    expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]?.phase).not.toBe('ready');
    const publications = replacementRenderer.setTrackData.mock.calls.length;
    act(() => driver.options.onCoverageAtlasReuse?.({ coverageGpuAtlas: atlas, viewRange: range }));
    expect(frames).toHaveLength(2);
    act(() => frames[0]?.());
    expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]?.phase).not.toBe('ready');
    act(() => frames[1]?.());
    expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]).toEqual({
      phase: 'ready',
      kind: 'coverage',
    });
    expect(replacementRenderer.setTrackData).toHaveBeenCalledTimes(publications);
    unmount();
  });

  it('replays the last presented payload into a replacement renderer before restoring Ready', async () => {
    const firstRenderer = fakeRenderer();
    const replacementRenderer = fakeRenderer();
    const range = { start: 400_000, end: 401_000 };
    let liveRenderer = firstRenderer;
    const presentedFrames: Array<() => void> = [];
    const map = {
      getLinearRenderer: () => liveRenderer,
      getViewportRange: () => range,
      requestRender: vi.fn(),
      subscribeToPresentedFrames: vi.fn((listener: () => void) => {
        presentedFrames.push(listener);
        return () => undefined;
      }),
    };
    const webglRef = { current: map };
    const dataset = pileupDataset({ bamPath: '/fixtures/ready-before-replacement.bam' });
    const { result, unmount } = renderHook(() =>
      useIndexedPileupStreaming({
        webglRef,
        rendererAssembly: rendererAssembly(),
        containerWidth: 1_000,
        activeStressDatasets: [dataset],
      })
    );

    act(() => {
      result.current.streamPileupViaTileEngine(range);
    });
    await waitFor(() => expect(driverMock.instances).toHaveLength(1));
    const payloadFeed = {
      ownerPresentation: { kind: 'reads' as const },
      viewRange: range,
      records: [{ start: 400_100, end: 400_180, readId: 'read-1', strand: '+' as const, mapq: 60 }],
    };
    act(() => {
      driverMock.instances[0]!.options.onFeed(payloadFeed);
    });
    const firstPayload = firstRenderer.setTrackData.mock.lastCall?.[1];
    expect(firstPayload).toEqual(
      expect.objectContaining({
        dataAuthority: 'tile-engine',
        records: payloadFeed.records,
      })
    );
    act(() => presentedFrames[0]?.());
    expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]).toEqual({
      phase: 'ready',
      kind: 'reads',
    });

    liveRenderer = replacementRenderer;
    act(() => {
      result.current.noteLaneContractWired(replacementRenderer, range, [dataset.trackId]);
      result.current.streamPileupViaTileEngine(range);
    });

    expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]).toEqual({
      phase: 'loading',
    });
    expect(replacementRenderer.setTrackData).toHaveBeenCalledWith(dataset.trackId, firstPayload);
    expect(driverMock.instances[0]!.presentViewport).toHaveBeenCalledWith(range, 2000, 1000);
    expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]?.phase).not.toBe('ready');

    act(() => presentedFrames[0]?.());
    expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]).toEqual({
      phase: 'loading',
    });
    act(() => presentedFrames[1]?.());
    expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]).toEqual({
      phase: 'ready',
      kind: 'reads',
    });
    unmount();
  });

  it('re-subscribes when the linear renderer changes behind the same map handle', async () => {
    const firstRenderer = fakeRenderer();
    const replacementRenderer = fakeRenderer();
    const range = { start: 400_000, end: 401_000 };
    let liveRenderer = firstRenderer;
    const presentedFrames: Array<() => void> = [];
    const unsubscribes: Array<ReturnType<typeof vi.fn>> = [];
    const map = {
      getLinearRenderer: () => liveRenderer,
      getViewportRange: () => range,
      requestRender: vi.fn(),
      subscribeToPresentedFrames: vi.fn((listener: () => void) => {
        presentedFrames.push(listener);
        const unsubscribe = vi.fn();
        unsubscribes.push(unsubscribe);
        return unsubscribe;
      }),
    };
    const dataset = pileupDataset({ bamPath: '/fixtures/same-map-replacement.bam' });
    const { result, unmount } = renderHook(() =>
      useIndexedPileupStreaming({
        webglRef: { current: map },
        rendererAssembly: rendererAssembly(),
        containerWidth: 1_000,
        activeStressDatasets: [dataset],
      })
    );

    act(() => {
      result.current.streamPileupViaTileEngine(range);
    });
    await waitFor(() => expect(driverMock.instances).toHaveLength(1));
    const driver = driverMock.instances[0]!;
    const feed = {
      ownerPresentation: { kind: 'reads' as const },
      viewRange: range,
      records: [{ start: 400_100, end: 400_180, readId: 'read-1', strand: '+' as const, mapq: 60 }],
    };
    act(() => {
      driver.options.onFeed(feed);
    });
    expect(map.subscribeToPresentedFrames).toHaveBeenCalledTimes(1);

    liveRenderer = replacementRenderer;
    act(() => {
      driver.options.onFeed(feed);
    });

    expect(map.subscribeToPresentedFrames).toHaveBeenCalledTimes(2);
    expect(unsubscribes[0]).toHaveBeenCalledOnce();
    act(() => presentedFrames[0]?.());
    expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]?.phase).toBe('loading');
    act(() => presentedFrames[1]?.());
    expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]).toEqual({
      phase: 'ready',
      kind: 'reads',
    });
    unmount();
  });

  it('accepts a cache-only feed for a new locus before the throttled fetch commit', async () => {
    vi.useFakeTimers();
    let now = 0;
    const performanceNowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const renderer = fakeRenderer();
    let range = { start: 0, end: 20_000_000 };
    let presentedFrame: (() => void) | undefined;
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => range,
        requestRender: vi.fn(() => presentedFrame?.()),
        subscribeToPresentedFrames: vi.fn((listener: () => void) => {
          presentedFrame = listener;
          return () => undefined;
        }),
      },
    };
    const dataset = pileupDataset({ bamPath: '/fixtures/empty-at-second-locus.bam' });
    const { result, unmount } = renderHook(() =>
      useIndexedPileupStreaming({
        webglRef,
        rendererAssembly: humanScaleRendererAssembly(),
        containerWidth: 1_000,
        activeStressDatasets: [dataset],
      })
    );

    act(() => {
      result.current.streamPileupViaTileEngine(range);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const driver = driverMock.instances[0]!;

    act(() => {
      driver.options.onFeed({
        ownerPresentation: { kind: 'reads' },
        viewRange: range,
        records: [{ start: 100, end: 200, readId: 'read-1', strand: '+', mapq: 60 }],
      });
    });
    expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]).toEqual({
      phase: 'ready',
      kind: 'reads',
    });

    now = 10;
    range = { start: 40_000_000, end: 60_000_000 };
    driver.presentViewport.mockImplementation((presentedRange) => {
      driver.options.onFeed({
        ownerPresentation: { kind: 'empty' },
        coveragePresentation: { kind: 'none', reason: 'no-presentable-surface' },
        viewRange: presentedRange,
        records: [],
      });
      return true;
    });
    act(() => {
      result.current.streamPileupViaTileEngine(range);
    });

    expect(driver.presentViewport).toHaveBeenCalledWith(range, 2000, 1000);
    expect(driver.setViewport).toHaveBeenCalledTimes(1);
    expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]).toEqual({
      phase: 'ready',
      kind: 'empty',
    });

    performanceNowSpy.mockRestore();
    unmount();
  });

  it('turns manual Retry on a remote track into a real transport reconnect', async () => {
    const renderer = fakeRenderer();
    const range = { start: 100_000, end: 101_000 };
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => range,
        requestRender: vi.fn(),
        subscribeToPresentedFrames: vi.fn(() => () => undefined),
      },
    };
    const dataset = pileupDataset({
      bamPath: 'http://127.0.0.1:61234/v1/source/alignment.bam',
      indexPath: '/tmp/dnaforge-remote-index/alignment.bam.bai',
      remote: {
        sessionId: 'remote-lease',
        locator: {
          contract: 'remote-alignment-locator.v1',
          endpointId: 'remote-endpoint',
          target: 'lab-hpc',
          alignmentPath: '/cluster/run/sample.bam',
          indexPath: '/cluster/run/sample.bam.bai',
        },
      },
    });
    const reconnectRemoteTrack = vi.fn(async () => true);
    const { result, unmount } = renderHook(() =>
      useIndexedPileupStreaming({
        webglRef,
        rendererAssembly: rendererAssembly(),
        containerWidth: 1_000,
        activeStressDatasets: [dataset],
        reconnectRemoteTrack,
      })
    );
    await waitFor(() => expect(driverMock.instances).toHaveLength(1));

    act(() => result.current.retryTrack(dataset.trackId));

    await waitFor(() => expect(reconnectRemoteTrack).toHaveBeenCalledWith(dataset.trackId));
    unmount();
  });

  it('blocks permanent failures without a timer and performs one manual retry', async () => {
    const renderer = fakeRenderer();
    const range = { start: 100_000, end: 220_000 };
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => range,
        requestRender: vi.fn(),
        subscribeToPresentedFrames: vi.fn(() => () => undefined),
      },
    };
    const dataset = pileupDataset({ bamPath: '/fixtures/missing-index.bam' });
    const { result, unmount } = renderHook(() =>
      useIndexedPileupStreaming({
        webglRef,
        rendererAssembly: rendererAssembly(),
        containerWidth: 1_000,
        activeStressDatasets: [dataset],
      })
    );

    act(() => {
      result.current.streamPileupViaTileEngine(range);
    });
    await waitFor(() => expect(driverMock.instances).toHaveLength(1));
    const driver = driverMock.instances[0]!;
    act(() => {
      driver.options.onTileError?.({
        key: { sourceId: 'aln:fixture:chr11', level: 0, index: 0 },
        reason: 'not-found',
      });
    });
    expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]).toEqual({
      phase: 'blocked',
      message: 'The aligned-read source needs attention.',
      action: 'repair',
      hasLastGood: false,
    });
    expect(driver.retryCurrentViewport).not.toHaveBeenCalled();

    await act(async () => {
      result.current.retryTrack(dataset.trackId);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(driver.retryCurrentViewport).toHaveBeenCalledTimes(1);
    expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]).toEqual({
      phase: 'loading',
    });
    unmount();
  });

  it('retires resident data when the sidecar rejects a changed source generation', async () => {
    const renderer = fakeRenderer();
    const range = { start: 100_000, end: 220_000 };
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => range,
        requestRender: vi.fn(),
        subscribeToPresentedFrames: vi.fn(() => () => undefined),
      },
    };
    const dataset = pileupDataset({
      bamPath: '/fixtures/replaced.bam',
      indexPath: '/fixtures/replaced.bam.bai',
      generation: sourceGeneration(1),
    });
    const { result, unmount } = renderHook(() =>
      useIndexedPileupStreaming({
        webglRef,
        rendererAssembly: rendererAssembly(),
        containerWidth: 1_000,
        activeStressDatasets: [dataset],
      })
    );

    act(() => {
      result.current.streamPileupViaTileEngine(range);
    });
    await waitFor(() => expect(driverMock.instances).toHaveLength(1));
    const driver = driverMock.instances[0]!;
    renderer.setTrackData.mockClear();

    act(() => {
      driver.options.onTileError?.({
        key: { sourceId: 'aln:fixture:chr11', level: 0, index: 0 },
        reason: 'http-409',
      });
    });

    expect(driver.dispose).toHaveBeenCalledTimes(1);
    expect(renderer.setTrackData).toHaveBeenCalledWith(dataset.trackId, {
      dataAuthority: 'tile-engine',
      records: [],
    });
    expect(webglRef.current.requestRender).toHaveBeenCalled();
    expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]).toEqual({
      phase: 'blocked',
      message: 'The aligned-read source changed on disk.',
      action: 'repair',
      hasLastGood: false,
    });
    unmount();
  });

  it('routes a failed manual URL refresh through recovery and rebuilds for a changed URL', async () => {
    vi.useFakeTimers();
    const renderer = fakeRenderer();
    const range = { start: 100_000, end: 220_000 };
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => range,
        requestRender: vi.fn(),
        subscribeToPresentedFrames: vi.fn(() => () => undefined),
      },
    };
    const dataset = pileupDataset({ bamPath: '/fixtures/manual-sidecar-refresh.bam' });
    const { result, unmount } = renderHook(() =>
      useIndexedPileupStreaming({
        webglRef,
        rendererAssembly: rendererAssembly(),
        containerWidth: 1_000,
        activeStressDatasets: [dataset],
      })
    );

    act(() => {
      result.current.streamPileupViaTileEngine(range);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const firstDriver = driverMock.instances[0]!;
    act(() => {
      firstDriver.options.onTileError?.({
        key: { sourceId: 'aln:fixture:chr11', level: 0, index: 0 },
        reason: 'not-found',
      });
    });
    driverMock.resolveSidecarBaseUrl
      .mockRejectedValueOnce(new Error('runtime URL temporarily unavailable'))
      .mockResolvedValueOnce('http://localhost:8027');

    await act(async () => {
      result.current.retryTrack(dataset.trackId);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]).toEqual({
      phase: 'recovering',
      attempt: 1,
      hasLastGood: false,
    });
    expect(firstDriver.retryCurrentViewport).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(firstDriver.dispose).toHaveBeenCalledOnce();
    expect(driverMock.instances).toHaveLength(2);
    expect(driverMock.instances[1]!.options.baseUrl).toBe('http://localhost:8027');
    expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]).toEqual({
      phase: 'loading',
    });
    unmount();
  });

  it('keeps transient recovery alive at a bounded cadence without requiring Retry', async () => {
    vi.useFakeTimers();
    const renderer = fakeRenderer();
    const range = { start: 100_000, end: 220_000 };
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => range,
        requestRender: vi.fn(),
        subscribeToPresentedFrames: vi.fn(() => () => undefined),
      },
    };
    const dataset = pileupDataset({ bamPath: '/fixtures/exhausted-recovery.bam' });
    const { result, unmount } = renderHook(() =>
      useIndexedPileupStreaming({
        webglRef,
        rendererAssembly: rendererAssembly(),
        containerWidth: 1_000,
        activeStressDatasets: [dataset],
      })
    );

    act(() => {
      result.current.streamPileupViaTileEngine(range);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const driver = driverMock.instances[0]!;
    const failSibling = (index: number) =>
      driver.options.onTileError?.({
        key: { sourceId: 'aln:fixture:chr11', level: 0, index },
        reason: 'queue-full',
      });

    for (const [attempt, delay] of [500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000].entries()) {
      act(() => failSibling(attempt));
      await act(async () => {
        vi.advanceTimersByTime(delay);
        await Promise.resolve();
      });
    }
    expect(driver.retryCurrentViewport).toHaveBeenCalledTimes(7);

    act(() => failSibling(7));
    expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]).toEqual({
      phase: 'recovering',
      attempt: 8,
      hasLastGood: false,
    });

    act(() => {
      for (let index = 8; index < 108; index += 1) failSibling(index);
      vi.advanceTimersByTime(30_000);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(driver.retryCurrentViewport).toHaveBeenCalledTimes(8);
    expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]?.phase).toBe('recovering');
    unmount();
  });

  it('retries an initial sidecar URL resolution failure through the bounded recovery path', async () => {
    vi.useFakeTimers();
    driverMock.resolveSidecarBaseUrl
      .mockRejectedValueOnce(new Error('sidecar restarting'))
      .mockResolvedValueOnce('http://localhost:8027');
    const renderer = fakeRenderer();
    const range = { start: 100_000, end: 220_000 };
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => range,
        requestRender: vi.fn(),
        subscribeToPresentedFrames: vi.fn(() => () => undefined),
      },
    };
    const dataset = pileupDataset({ bamPath: '/fixtures/sidecar-restart.bam' });
    const { result, unmount } = renderHook(() =>
      useIndexedPileupStreaming({
        webglRef,
        rendererAssembly: rendererAssembly(),
        containerWidth: 1_000,
        activeStressDatasets: [dataset],
      })
    );

    act(() => {
      result.current.streamPileupViaTileEngine(range);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]).toEqual({
      phase: 'recovering',
      attempt: 1,
      hasLastGood: false,
    });
    expect(driverMock.instances).toHaveLength(0);

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(driverMock.resolveSidecarBaseUrl).toHaveBeenCalledTimes(2);
    expect(driverMock.instances).toHaveLength(1);
    expect(driverMock.instances[0]!.options.baseUrl).toBe('http://localhost:8027');
    expect(result.current.trackLifecycle.getSnapshot()[dataset.trackId]).toEqual({
      phase: 'loading',
    });
    unmount();
  });

  it('releases a stale in-flight URL retry when the source context changes', async () => {
    vi.useFakeTimers();
    const staleRetry = deferred<string>();
    driverMock.resolveSidecarBaseUrl
      .mockRejectedValueOnce(new Error('sidecar restarting'))
      .mockReturnValueOnce(staleRetry.promise)
      .mockResolvedValueOnce('http://localhost:8027');
    const renderer = fakeRenderer();
    const range = { start: 100_000, end: 220_000 };
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => range,
        requestRender: vi.fn(),
        subscribeToPresentedFrames: vi.fn(() => () => undefined),
      },
    };
    const firstDataset = pileupDataset({ bamPath: '/fixtures/source-before-restart.bam' });
    const replacementDataset = pileupDataset({ bamPath: '/fixtures/source-after-restart.bam' });
    const { result, rerender, unmount } = renderHook(
      ({ dataset }: { dataset: ActiveStressDataset }) =>
        useIndexedPileupStreaming({
          webglRef,
          rendererAssembly: rendererAssembly(),
          containerWidth: 1_000,
          activeStressDatasets: [dataset],
        }),
      { initialProps: { dataset: firstDataset } }
    );

    act(() => {
      result.current.streamPileupViaTileEngine(range);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    expect(driverMock.resolveSidecarBaseUrl).toHaveBeenCalledTimes(2);

    rerender({ dataset: replacementDataset });
    act(() => {
      result.current.streamPileupViaTileEngine(range);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(driverMock.resolveSidecarBaseUrl).toHaveBeenCalledTimes(3);
    expect(driverMock.instances).toHaveLength(1);
    expect(driverMock.instances[0]!.options.source.bamPath).toBe(
      '/fixtures/source-after-restart.bam'
    );
    expect(driverMock.instances[0]!.options.baseUrl).toBe('http://localhost:8027');

    await act(async () => {
      staleRetry.resolve('http://localhost:8999');
      await staleRetry.promise;
      await Promise.resolve();
    });
    expect(driverMock.instances).toHaveLength(1);
    expect(driverMock.instances[0]!.options.baseUrl).toBe('http://localhost:8027');
    unmount();
  });
});
