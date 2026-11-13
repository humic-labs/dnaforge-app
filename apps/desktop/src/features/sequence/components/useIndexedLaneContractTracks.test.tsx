import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PixiAnnotationTrackRenderer,
  PENDING_INTERVAL_BAND_HEIGHT_PX,
  PixiPileupTrackRenderer,
  PixiTranscriptTrackRenderer,
  PixiVariantTrackRenderer,
  type Assembly,
} from '@waypoint/genome-renderer';

import { useIndexedLaneContractTracks } from './useIndexedLaneContractTracks';
import type { ActiveStressDataset } from '../lane-contract-store';

vi.mock('@waypoint/genome-renderer', async () => {
  const actual = await vi.importActual<typeof import('@waypoint/genome-renderer')>(
    '@waypoint/genome-renderer'
  );
  return {
    ...actual,
    PixiAnnotationTrackRenderer: vi.fn().mockImplementation(() => ({})),
    PixiCytobandTrackRenderer: vi.fn().mockImplementation(() => ({})),
    PixiPileupTrackRenderer: vi.fn().mockImplementation(() => ({})),
    PixiTranscriptTrackRenderer: vi.fn().mockImplementation(() => ({})),
    PixiVariantTrackRenderer: vi.fn().mockImplementation(() => ({})),
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

function pileupDataset(): ActiveStressDataset {
  return {
    trackType: 'pileup-genomewide',
    trackId: 'pileup-genomewide-grch38',
    label: 'HG002',
    color: 0x3366cc,
    trackPx: 120,
    records: [],
    kind: 'pileup',
    source: {
      bamPath: '/fixtures/HG002.bam',
      indexPath: '/fixtures/HG002.bam.bai',
      referencePath: '/fixtures/GRCh38.fa',
    },
    coverage: {
      bins: [4, 9, 16],
      binSize: 2048,
      maxDepth: 16,
      provenance: { exact: true, method: 'legacy-seed' },
    },
  };
}

function quantitativeDataset(trackId: string): ActiveStressDataset {
  return {
    trackType: 'quantitative',
    trackId,
    label: trackId,
    color: 0x3b82f6,
    trackPx: 96,
    records: [],
    kind: 'annotation',
  };
}

function fakeRenderer() {
  let revision = 0;
  const trackInstanceIds = new Set<string>();
  const trackColors = new Map<string, string | undefined>();
  const trackDataIds = new Set<string>();
  return {
    registerTrack: vi.fn(),
    setAssembly: vi.fn(),
    setChromosome: vi.fn(),
    setTrackHitHandler: vi.fn(),
    setTrackInstances: vi.fn((tracks: ReadonlyArray<{ id: string }>) => {
      trackInstanceIds.clear();
      trackColors.clear();
      tracks.forEach((track: { id: string; color?: string }) => {
        trackInstanceIds.add(track.id);
        trackColors.set(track.id, track.color);
      });
      revision += 1;
    }),
    setTrackColor: vi.fn((trackId: string, color: string | undefined) => {
      if (!trackInstanceIds.has(trackId) || trackColors.get(trackId) === color) return false;
      trackColors.set(trackId, color);
      revision += 1;
      return true;
    }),
    setTrackData: vi.fn((trackId: string) => {
      trackDataIds.add(trackId);
      revision += 1;
    }),
    getLaneContractRevision: vi.fn(() => revision),
    hasTrackInstance: vi.fn((trackId: string) => trackInstanceIds.has(trackId)),
    hasTrackData: vi.fn((trackId: string) => trackDataIds.has(trackId)),
    seedTrackData(trackId: string) {
      trackDataIds.add(trackId);
      revision += 1;
    },
    removeTrackInstance(trackId: string) {
      trackInstanceIds.delete(trackId);
      revision += 1;
    },
    getRendererDebugSnapshot: vi.fn(() => null),
  };
}

describe('useIndexedLaneContractTracks pileup ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('frames tracks on a chromosome with no cytoband table, without an ideogram', () => {
    const renderer = fakeRenderer();
    const { unmount } = renderHook(() =>
      useIndexedLaneContractTracks({
        webglRef: {
          current: {
            getLinearRenderer: () => renderer,
            getViewportRange: () => ({ start: 0, end: 1_000 }),
            setViewport: vi.fn(),
            setViewCenter: vi.fn(),
          },
        },
        rendererAssembly: null,
        manifestChrom: 'chrIV',
        manifestChromLength: 1_531_933,
        activeStressDatasets: [quantitativeDataset('user-annotations')],
        pileupStreaming: { streamPileupViaTileEngine: vi.fn(() => true) },
        recordEvent: vi.fn(),
      })
    );

    expect(renderer.setChromosome).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'chrIV', length: 1_531_933, cytobands: [] })
    );
    expect(renderer.setTrackInstances).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'user-annotations' }),
    ]);
    unmount();
  });

  it('makes read bodies 20% taller while preserving the one-pixel row gap', () => {
    vi.mocked(PixiPileupTrackRenderer).mockClear();
    const renderer = fakeRenderer();
    const dataset = {
      ...pileupDataset(),
      laneHeightPx: 3,
      maxLanes: 80,
      overflowBandHeightPx: 36,
      trackPx: 276,
    };

    const { unmount } = renderHook(() =>
      useIndexedLaneContractTracks({
        webglRef: {
          current: {
            getLinearRenderer: () => renderer,
            getViewportRange: () => ({ start: 0, end: 1_000_000 }),
            setViewport: vi.fn(),
            setViewCenter: vi.fn(),
          },
        },
        rendererAssembly: rendererAssembly(),
        manifestChrom: 'chr11',
        activeStressDatasets: [dataset],
        pileupStreaming: { streamPileupViaTileEngine: vi.fn(() => true) },
        recordEvent: vi.fn(),
      })
    );

    expect(PixiPileupTrackRenderer).toHaveBeenCalledWith(
      expect.objectContaining({ rowHeightPx: 3.4 })
    );
    expect(renderer.setTrackInstances).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          id: dataset.trackId,
          rowHeightPx: 3.4,
          sizing: { kind: 'fixed', pixels: 308 + PENDING_INTERVAL_BAND_HEIGHT_PX },
        }),
      ])
    );
    expect(3.4 - 2.4).toBeCloseTo(1);
    unmount();
  });

  it('enables the bounded feature-label budget for imported interval lanes', () => {
    vi.mocked(PixiAnnotationTrackRenderer).mockClear();
    vi.mocked(PixiTranscriptTrackRenderer).mockClear();
    const renderer = fakeRenderer();
    const dataset: ActiveStressDataset = {
      ...quantitativeDataset('local:targets-bed'),
      trackType: 'generic-interval',
    };
    const transcriptDataset: ActiveStressDataset = {
      ...quantitativeDataset('local:transcripts-bed12'),
      trackType: 'imported-transcript',
      maxLanes: 32,
    };

    const { unmount } = renderHook(() =>
      useIndexedLaneContractTracks({
        webglRef: {
          current: {
            getLinearRenderer: () => renderer,
            getViewportRange: () => ({ start: 0, end: 1_000_000 }),
            setViewport: vi.fn(),
            setViewCenter: vi.fn(),
          },
        },
        rendererAssembly: rendererAssembly(),
        manifestChrom: 'chr11',
        activeStressDatasets: [dataset, transcriptDataset],
        pileupStreaming: { streamPileupViaTileEngine: vi.fn(() => true) },
        recordEvent: vi.fn(),
      })
    );

    expect(PixiAnnotationTrackRenderer).toHaveBeenCalledWith({
      type: 'generic-interval',
      maxLabels: 96,
    });
    expect(PixiTranscriptTrackRenderer).toHaveBeenCalledWith({
      type: 'imported-transcript',
      maxLanes: 32,
      maxLabels: 96,
    });
    unmount();
  });

  it('registers variant lanes with the dedicated variant-marker renderer', () => {
    vi.mocked(PixiVariantTrackRenderer).mockClear();
    const renderer = fakeRenderer();
    const dataset: ActiveStressDataset = {
      trackType: 'variant',
      trackId: `variant:${'a'.repeat(64)}`,
      label: 'Tumor calls',
      color: 0xdc2626,
      trackPx: 44,
      laneHeightPx: 12,
      maxLanes: 8,
      records: [],
      kind: 'variant',
    };

    const { unmount } = renderHook(() =>
      useIndexedLaneContractTracks({
        webglRef: {
          current: {
            getLinearRenderer: () => renderer,
            getViewportRange: () => ({ start: 0, end: 1_000_000 }),
            setViewport: vi.fn(),
            setViewCenter: vi.fn(),
          },
        },
        rendererAssembly: rendererAssembly(),
        manifestChrom: 'chr11',
        activeStressDatasets: [dataset],
        pileupStreaming: { streamPileupViaTileEngine: vi.fn(() => true) },
        recordEvent: vi.fn(),
      })
    );

    expect(PixiVariantTrackRenderer).toHaveBeenCalledWith({ type: 'variant' });
    expect(renderer.setTrackData).toHaveBeenCalledWith(dataset.trackId, { records: [] });
    unmount();
  });

  it('reserves the complete cytoband band-and-label height above annotations', () => {
    const renderer = fakeRenderer();
    const pileupStreaming = {
      streamPileupViaTileEngine: vi.fn(() => true),
    };

    const { unmount } = renderHook(() =>
      useIndexedLaneContractTracks({
        webglRef: {
          current: {
            getLinearRenderer: () => renderer,
            getViewportRange: () => ({ start: 0, end: 1_000_000 }),
            setViewport: vi.fn(),
            setViewCenter: vi.fn(),
          },
        },
        rendererAssembly: rendererAssembly(),
        manifestChrom: 'chr11',
        activeStressDatasets: [],
        pileupStreaming,
        recordEvent: vi.fn(),
      })
    );

    expect(renderer.setTrackInstances).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'cytoband-grch38',
        zone: 'above-legacy',
        sizing: { kind: 'fixed', pixels: 32, minHeight: 32, maxHeight: 34 },
      }),
    ]);
    unmount();
  });

  it('preserves zoom for body hits and frames the exact chromosome range for label hits', () => {
    const renderer = fakeRenderer();
    const setViewCenter = vi.fn();
    const setViewport = vi.fn();
    const { unmount } = renderHook(() =>
      useIndexedLaneContractTracks({
        webglRef: {
          current: {
            getLinearRenderer: () => renderer,
            getViewportRange: () => ({ start: 100_000, end: 200_000 }),
            setViewport,
            setViewCenter,
          },
        },
        rendererAssembly: rendererAssembly(),
        manifestChrom: 'chr11',
        activeStressDatasets: [],
        pileupStreaming: { streamPileupViaTileEngine: vi.fn(() => true) },
        recordEvent: vi.fn(),
      })
    );
    const handler = renderer.setTrackHitHandler.mock.calls.at(-1)?.[0];
    if (!handler) throw new Error('Expected a track-hit handler');

    handler({ kind: 'jump-to-bp', bp: 350_000 });
    expect(setViewCenter).toHaveBeenCalledExactlyOnceWith(350_000);
    expect(setViewport).not.toHaveBeenCalled();

    handler({
      kind: 'frame-bp-range',
      startBp: 400_000,
      endBp: 600_000,
      chromosomeId: 'chr12',
    });
    expect(setViewport).toHaveBeenCalledExactlyOnceWith({ start: 400_000, end: 600_000 });
    expect(setViewCenter).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('wires the final lane envelope in the renderer-ready layout phase', () => {
    vi.mocked(window.requestAnimationFrame).mockImplementation(() => 1);
    const renderer = fakeRenderer();
    let liveRenderer: ReturnType<typeof fakeRenderer> | null = null;
    const webglRef = {
      current: {
        getLinearRenderer: () => liveRenderer,
        getViewportRange: () => ({ start: 0, end: 1_000_000 }),
        setViewport: vi.fn(),
        setViewCenter: vi.fn(),
      },
    };

    const { rerender, unmount } = renderHook(
      ({ rendererReadyEpoch }: { rendererReadyEpoch: number }) =>
        useIndexedLaneContractTracks({
          webglRef,
          rendererReadyEpoch,
          rendererAssembly: rendererAssembly(),
          manifestChrom: 'chr11',
          activeStressDatasets: [],
          pileupStreaming: { streamPileupViaTileEngine: vi.fn(() => true) },
          recordEvent: vi.fn(),
        }),
      { initialProps: { rendererReadyEpoch: 0 } }
    );

    expect(renderer.setTrackInstances).not.toHaveBeenCalled();
    liveRenderer = renderer;
    rerender({ rendererReadyEpoch: 1 });
    expect(renderer.setTrackInstances).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'cytoband-grch38', zone: 'above-legacy' }),
    ]);
    unmount();
  });

  it('publishes current renderer lane readiness before starting the initial full-range stream', () => {
    const renderer = fakeRenderer();
    const dataset = pileupDataset();
    const noteLaneContractWired = vi.fn();
    const streamPileupViaTileEngine = vi.fn(() => true);
    const range = { start: 0, end: 1_000_000 };

    const { unmount } = renderHook(() =>
      useIndexedLaneContractTracks({
        webglRef: {
          current: {
            getLinearRenderer: () => renderer,
            getViewportRange: () => range,
            setViewport: vi.fn(),
            setViewCenter: vi.fn(),
          },
        },
        rendererAssembly: rendererAssembly(),
        manifestChrom: 'chr11',
        activeStressDatasets: [dataset],
        pileupStreaming: { noteLaneContractWired, streamPileupViaTileEngine },
        recordEvent: vi.fn(),
      })
    );

    expect(noteLaneContractWired).toHaveBeenCalledWith(
      renderer,
      range,
      expect.arrayContaining([dataset.trackId])
    );
    expect(noteLaneContractWired.mock.invocationCallOrder[0]).toBeLessThan(
      streamPileupViaTileEngine.mock.invocationCallOrder[0]!
    );
    unmount();
  });

  it('wires an incrementally added BAM at the unchanged camera before restarting the stream', () => {
    const renderer = fakeRenderer();
    const assembly = rendererAssembly();
    const range = { start: 0, end: 1_000_000 };
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => range,
        setViewport: vi.fn(),
        setViewCenter: vi.fn(),
      },
    };
    const bamA = {
      ...pileupDataset(),
      trackId: 'pileup-a',
      label: 'Tumor BAM',
      source: {
        bamPath: '/fixtures/tumor.bam',
        indexPath: '/fixtures/tumor.bam.bai',
      },
    } satisfies ActiveStressDataset;
    const bamB = {
      ...pileupDataset(),
      trackId: 'pileup-b',
      label: 'Normal BAM',
      source: {
        bamPath: '/fixtures/normal.bam',
        indexPath: '/fixtures/normal.bam.bai',
      },
    } satisfies ActiveStressDataset;
    const noteLaneContractWired = vi.fn();
    const streamPileupViaTileEngine = vi.fn(() => true);

    const { rerender, unmount } = renderHook(
      ({ datasets }: { datasets: ActiveStressDataset[] }) =>
        useIndexedLaneContractTracks({
          webglRef,
          rendererAssembly: assembly,
          manifestChrom: 'chr11',
          activeStressDatasets: datasets,
          pileupStreaming: { noteLaneContractWired, streamPileupViaTileEngine },
          recordEvent: vi.fn(),
        }),
      { initialProps: { datasets: [bamA] } }
    );

    expect(renderer.hasTrackInstance(bamA.trackId)).toBe(true);
    expect(renderer.hasTrackData(bamA.trackId)).toBe(true);
    renderer.setTrackInstances.mockClear();
    renderer.setTrackData.mockClear();
    noteLaneContractWired.mockClear();
    streamPileupViaTileEngine.mockClear();

    rerender({ datasets: [bamA, bamB] });

    expect(renderer.setTrackInstances).toHaveBeenCalledOnce();
    expect(
      renderer.setTrackInstances.mock.calls[0]![0].map((track: { id: string }) => track.id)
    ).toEqual(['cytoband-grch38', bamA.trackId, bamB.trackId]);
    expect(renderer.hasTrackInstance(bamA.trackId)).toBe(true);
    expect(renderer.hasTrackInstance(bamB.trackId)).toBe(true);
    expect(renderer.hasTrackData(bamA.trackId)).toBe(true);
    expect(renderer.hasTrackData(bamB.trackId)).toBe(true);
    expect(renderer.setTrackData).toHaveBeenCalledOnce();
    expect(renderer.setTrackData).toHaveBeenCalledWith(bamB.trackId, {
      dataAuthority: 'tile-engine',
      records: [],
    });
    expect(renderer.setTrackData).not.toHaveBeenCalledWith(bamA.trackId, expect.anything());
    expect(noteLaneContractWired).toHaveBeenCalledWith(renderer, range, [
      'cytoband-grch38',
      bamA.trackId,
      bamB.trackId,
    ]);
    expect(renderer.setTrackData.mock.invocationCallOrder[0]).toBeLessThan(
      noteLaneContractWired.mock.invocationCallOrder[0]!
    );
    expect(noteLaneContractWired.mock.invocationCallOrder[0]).toBeLessThan(
      streamPileupViaTileEngine.mock.invocationCallOrder[0]!
    );
    expect(streamPileupViaTileEngine).toHaveBeenCalledOnce();
    expect(streamPileupViaTileEngine).toHaveBeenCalledWith(range);

    unmount();
  });

  it('notifies UCSC streaming after a same-renderer lane rewire seeds empty placeholders', () => {
    const renderer = fakeRenderer();
    const assembly = rendererAssembly();
    const ucscTrack = quantitativeDataset('ucsc:hg38-gc5BaseBw');
    const unrelatedTrack = quantitativeDataset('ucsc:hg38-phastCons100way');
    const noteLaneContractWired = vi.fn();
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => ({ start: 0, end: 1_000_000 }),
        setViewport: vi.fn(),
        setViewCenter: vi.fn(),
      },
    };

    const { rerender, unmount } = renderHook(
      ({ datasets }: { datasets: ActiveStressDataset[] }) =>
        useIndexedLaneContractTracks({
          webglRef,
          rendererAssembly: assembly,
          manifestChrom: 'chr11',
          activeStressDatasets: datasets,
          pileupStreaming: { streamPileupViaTileEngine: vi.fn(() => true) },
          ucscStreaming: { noteLaneContractWired },
          recordEvent: vi.fn(),
        }),
      { initialProps: { datasets: [ucscTrack] } }
    );

    renderer.setTrackData.mockClear();
    noteLaneContractWired.mockClear();
    rerender({ datasets: [ucscTrack, unrelatedTrack] });

    expect(renderer.setTrackData).not.toHaveBeenCalledWith(ucscTrack.trackId, expect.anything());
    expect(renderer.setTrackData).toHaveBeenCalledWith(unrelatedTrack.trackId, { records: [] });
    expect(noteLaneContractWired).toHaveBeenCalledOnce();
    const finalPlaceholderOrder = Math.max(...renderer.setTrackData.mock.invocationCallOrder);
    expect(finalPlaceholderOrder).toBeLessThan(noteLaneContractWired.mock.invocationCallOrder[0]!);

    unmount();
  });

  it('keeps surviving track payloads when another track is hidden or removed', () => {
    const renderer = fakeRenderer();
    const assembly = rendererAssembly();
    const first = quantitativeDataset('ucsc:hg38-gc5BaseBw');
    const second = quantitativeDataset('ucsc:hg38-phastCons100way');
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => ({ start: 0, end: 1_000_000 }),
        setViewport: vi.fn(),
        setViewCenter: vi.fn(),
      },
    };
    const { rerender, unmount } = renderHook(
      ({ datasets }: { datasets: ActiveStressDataset[] }) =>
        useIndexedLaneContractTracks({
          webglRef,
          rendererAssembly: assembly,
          manifestChrom: 'chr11',
          activeStressDatasets: datasets,
          pileupStreaming: { streamPileupViaTileEngine: vi.fn(() => true) },
          ucscStreaming: { noteLaneContractWired: vi.fn() },
          recordEvent: vi.fn(),
        }),
      { initialProps: { datasets: [first, second] } }
    );

    renderer.setTrackData.mockClear();
    rerender({ datasets: [second] });
    expect(renderer.setTrackData).not.toHaveBeenCalledWith(second.trackId, expect.anything());
    renderer.setTrackData.mockClear();
    rerender({ datasets: [first, second] });
    expect(renderer.setTrackData).toHaveBeenCalledWith(first.trackId, { records: [] });
    expect(renderer.setTrackData).not.toHaveBeenCalledWith(second.trackId, expect.anything());
    unmount();
  });

  it('clears assembly pileup data to tile-engine authority before the tile engine feeds', () => {
    const renderer = fakeRenderer();
    const dataset = pileupDataset();
    const pileupStreaming = {
      streamPileupViaTileEngine: vi.fn(() => true),
    };

    const { unmount } = renderHook(() =>
      useIndexedLaneContractTracks({
        webglRef: {
          current: {
            getLinearRenderer: () => renderer,
            getViewportRange: () => ({ start: 0, end: 1_000_000 }),
            setViewport: vi.fn(),
            setViewCenter: vi.fn(),
          },
        },
        rendererAssembly: rendererAssembly(),
        manifestChrom: 'chr11',
        activeStressDatasets: [dataset],
        pileupStreaming,
        recordEvent: vi.fn(),
      })
    );

    expect(renderer.setTrackInstances).toHaveBeenCalledTimes(1);
    expect(renderer.setTrackData).toHaveBeenCalledWith(dataset.trackId, {
      dataAuthority: 'tile-engine',
      records: [],
    });
    expect(renderer.setTrackData).not.toHaveBeenCalledWith(
      dataset.trackId,
      expect.objectContaining({ dataAuthority: 'static' })
    );
    expect(pileupStreaming.streamPileupViaTileEngine).toHaveBeenCalledWith({
      start: 0,
      end: 1_000_000,
    });

    unmount();
  });

  it('does not seed assembly pileup with cached tile-engine coverage', () => {
    const renderer = fakeRenderer();
    const dataset = {
      ...pileupDataset(),
      coverage: {
        bins: [4, 9, 16],
        binSize: 2048,
        maxDepth: 16,
        provenance: { exact: true, method: 'pyramid-maxpool', source: 'tile-engine' },
      },
    } satisfies ActiveStressDataset;
    const pileupStreaming = {
      streamPileupViaTileEngine: vi.fn(() => true),
    };

    const { unmount } = renderHook(() =>
      useIndexedLaneContractTracks({
        webglRef: {
          current: {
            getLinearRenderer: () => renderer,
            getViewportRange: () => ({ start: 0, end: 1_000_000 }),
            setViewport: vi.fn(),
            setViewCenter: vi.fn(),
          },
        },
        rendererAssembly: rendererAssembly(),
        manifestChrom: 'chr11',
        activeStressDatasets: [dataset],
        pileupStreaming,
        recordEvent: vi.fn(),
      })
    );

    expect(renderer.setTrackData).toHaveBeenCalledWith(dataset.trackId, {
      dataAuthority: 'tile-engine',
      records: [],
    });
    expect(renderer.setTrackData).not.toHaveBeenCalledWith(
      dataset.trackId,
      expect.objectContaining({ coverage: dataset.coverage })
    );
    expect(renderer.setTrackData).not.toHaveBeenCalledWith(
      dataset.trackId,
      expect.objectContaining({ dataAuthority: 'static' })
    );

    unmount();
  });

  it('does not clear already-mounted tile-engine pileup data during lane wiring', () => {
    const renderer = fakeRenderer();
    const dataset = pileupDataset();
    renderer.seedTrackData(dataset.trackId);
    const pileupStreaming = {
      streamPileupViaTileEngine: vi.fn(() => true),
    };

    const { unmount } = renderHook(() =>
      useIndexedLaneContractTracks({
        webglRef: {
          current: {
            getLinearRenderer: () => renderer,
            getViewportRange: () => ({ start: 0, end: 1_000_000 }),
            setViewport: vi.fn(),
            setViewCenter: vi.fn(),
          },
        },
        rendererAssembly: rendererAssembly(),
        manifestChrom: 'chr11',
        activeStressDatasets: [dataset],
        pileupStreaming,
        recordEvent: vi.fn(),
      })
    );

    expect(renderer.setTrackInstances).toHaveBeenCalledTimes(1);
    expect(renderer.setTrackData).not.toHaveBeenCalledWith(dataset.trackId, {
      dataAuthority: 'tile-engine',
      records: [],
    });
    expect(pileupStreaming.streamPileupViaTileEngine).toHaveBeenCalledWith({
      start: 0,
      end: 1_000_000,
    });

    unmount();
  });

  it('takes no full debug snapshots and does not rewire across stable scheduler ticks', () => {
    const renderer = fakeRenderer();
    const dataset = pileupDataset();
    const pileupStreaming = {
      streamPileupViaTileEngine: vi.fn(() => true),
    };

    const { unmount } = renderHook(() =>
      useIndexedLaneContractTracks({
        webglRef: {
          current: {
            getLinearRenderer: () => renderer,
            getViewportRange: () => ({ start: 0, end: 1_000_000 }),
            setViewport: vi.fn(),
            setViewCenter: vi.fn(),
          },
        },
        rendererAssembly: rendererAssembly(),
        manifestChrom: 'chr11',
        activeStressDatasets: [dataset],
        pileupStreaming,
        recordEvent: vi.fn(),
      })
    );

    const snapshotsAfterWire = renderer.getRendererDebugSnapshot.mock.calls.length;
    act(() => vi.advanceTimersByTime(2_500));

    expect(renderer.getRendererDebugSnapshot).toHaveBeenCalledTimes(snapshotsAfterWire);
    expect(renderer.setTrackInstances).toHaveBeenCalledTimes(1);
    expect(pileupStreaming.streamPileupViaTileEngine).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('does not rebuild lane instances when only one BAM height cutoff changes', () => {
    const renderer = fakeRenderer();
    const dataset = pileupDataset();
    const assembly = rendererAssembly();
    const pileupStreaming = {
      streamPileupViaTileEngine: vi.fn(() => true),
    };
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => ({ start: 0, end: 1_000_000 }),
        setViewport: vi.fn(),
        setViewCenter: vi.fn(),
      },
    };
    const recordEvent = vi.fn();

    const { rerender, unmount } = renderHook(
      ({ cutoff }: { cutoff: number }) =>
        useIndexedLaneContractTracks({
          webglRef,
          rendererAssembly: assembly,
          manifestChrom: 'chr11',
          activeStressDatasets: [{ ...dataset, coverageCutoffDepth: cutoff }],
          pileupStreaming,
          recordEvent,
        }),
      { initialProps: { cutoff: 25 } }
    );

    expect(renderer.setTrackInstances).toHaveBeenCalledTimes(1);
    expect(pileupStreaming.streamPileupViaTileEngine).toHaveBeenCalledTimes(1);

    rerender({ cutoff: 140 });
    act(() => vi.advanceTimersByTime(500));

    expect(renderer.setTrackInstances).toHaveBeenCalledTimes(1);
    expect(pileupStreaming.streamPileupViaTileEngine).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('updates only the retained track color when a quantitative lane is recolored', () => {
    const renderer = fakeRenderer();
    const records = [{ chrom: 'chr1', start: 0, end: 5, value: 42 }];
    const dataset: ActiveStressDataset = {
      trackType: 'quantitative',
      trackId: 'ucsc:hg38-gc5BaseBw',
      label: 'GC Percent',
      color: 0x2563eb,
      trackPx: 80,
      records,
      kind: 'annotation',
    };
    const requestRender = vi.fn();
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => ({ start: 0, end: 1_000_000 }),
        requestRender,
        setViewport: vi.fn(),
        setViewCenter: vi.fn(),
      },
    };
    const pileupStreaming = {
      streamPileupViaTileEngine: vi.fn(() => true),
    };
    const recordEvent = vi.fn();
    const assembly = rendererAssembly();

    const { rerender, unmount } = renderHook(
      ({ color }: { color: number }) =>
        useIndexedLaneContractTracks({
          webglRef,
          rendererAssembly: assembly,
          manifestChrom: 'chr11',
          activeStressDatasets: [{ ...dataset, color }],
          pileupStreaming,
          recordEvent,
        }),
      { initialProps: { color: 0x2563eb } }
    );

    expect(renderer.setTrackInstances).toHaveBeenCalledTimes(1);
    expect(renderer.setTrackData).toHaveBeenCalledTimes(1);
    renderer.setTrackColor.mockClear();
    requestRender.mockClear();

    rerender({ color: 0xe11d48 });

    expect(renderer.setTrackInstances).toHaveBeenCalledTimes(1);
    expect(renderer.setTrackData).toHaveBeenCalledTimes(1);
    expect(renderer.setTrackColor).toHaveBeenCalledWith(dataset.trackId, '#e11d48');
    expect(requestRender).toHaveBeenCalledOnce();
    unmount();
  });

  it('presents a changed quantitative range without reseeding retained track data', () => {
    const renderer = fakeRenderer();
    const requestRender = vi.fn();
    const assembly = rendererAssembly();
    const records = [{ chrom: 'chr11', start: 0, end: 5, value: 42 }];
    const dataset: ActiveStressDataset = {
      ...quantitativeDataset('ucsc:hg38-gc5BaseBw'),
      records,
      quantitativePresentation: {
        version: 1,
        graph: 'bar',
        showRange: true,
        smoothingSigmaBins: 1,
        scale: { mode: 'fixed', transform: 'linear', min: 0, max: 70 },
      },
    };
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer,
        getViewportRange: () => ({ start: 0, end: 1_000_000 }),
        requestRender,
        setViewport: vi.fn(),
        setViewCenter: vi.fn(),
      },
    };
    const { rerender, unmount } = renderHook(
      ({ current }: { current: ActiveStressDataset }) =>
        useIndexedLaneContractTracks({
          webglRef,
          rendererAssembly: assembly,
          manifestChrom: 'chr11',
          activeStressDatasets: [current],
          pileupStreaming: { streamPileupViaTileEngine: vi.fn(() => true) },
          recordEvent: vi.fn(),
        }),
      { initialProps: { current: dataset } }
    );
    renderer.setTrackData.mockClear();
    requestRender.mockClear();

    rerender({
      current: {
        ...dataset,
        quantitativePresentation: {
          ...dataset.quantitativePresentation!,
          scale: { mode: 'robust-global', transform: 'linear' },
        },
      },
    });

    expect(renderer.setTrackInstances).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          id: dataset.trackId,
          quantitative: expect.objectContaining({
            scale: { mode: 'robust-global', transform: 'linear' },
          }),
        }),
      ])
    );
    expect(renderer.setTrackData).not.toHaveBeenCalled();
    expect(requestRender).toHaveBeenCalledOnce();
    unmount();
  });

  it('self-heals a missing lane instance only after the renderer revision changes', () => {
    const renderer = fakeRenderer();
    const dataset = pileupDataset();
    const pileupStreaming = {
      streamPileupViaTileEngine: vi.fn(() => true),
    };

    const { unmount } = renderHook(() =>
      useIndexedLaneContractTracks({
        webglRef: {
          current: {
            getLinearRenderer: () => renderer,
            getViewportRange: () => ({ start: 0, end: 1_000_000 }),
            setViewport: vi.fn(),
            setViewCenter: vi.fn(),
          },
        },
        rendererAssembly: rendererAssembly(),
        manifestChrom: 'chr11',
        activeStressDatasets: [dataset],
        pileupStreaming,
        recordEvent: vi.fn(),
      })
    );

    renderer.removeTrackInstance(dataset.trackId);
    act(() => vi.advanceTimersByTime(250));

    expect(renderer.setTrackInstances).toHaveBeenCalledTimes(2);
    expect(renderer.getRendererDebugSnapshot).not.toHaveBeenCalled();
    unmount();
  });

  it('keeps source-backed pileup rejected until the same track becomes assembly engine-owned', () => {
    const renderer = fakeRenderer();
    const dataset = pileupDataset();
    const pileupStreaming = {
      streamPileupViaTileEngine: vi.fn(() => true),
    };

    const { rerender, unmount } = renderHook(
      ({ assembly }: { assembly: Assembly | null }) =>
        useIndexedLaneContractTracks({
          webglRef: {
            current: {
              getLinearRenderer: () => renderer,
              getViewportRange: () => ({ start: 10, end: 20 }),
              setViewport: vi.fn(),
              setViewCenter: vi.fn(),
            },
          },
          rendererAssembly: assembly,
          manifestChrom: 'chr11',
          activeStressDatasets: [dataset],
          pileupStreaming,
          recordEvent: vi.fn(),
        }),
      {
        initialProps: { assembly: null },
      }
    );

    expect(renderer.setTrackData).not.toHaveBeenCalledWith(dataset.trackId, expect.anything());

    renderer.setTrackData.mockClear();
    rerender({ assembly: rendererAssembly() });

    expect(renderer.setTrackData).toHaveBeenCalledWith(dataset.trackId, {
      dataAuthority: 'tile-engine',
      records: [],
    });
    expect(renderer.setTrackData).not.toHaveBeenCalledWith(
      dataset.trackId,
      expect.objectContaining({ dataAuthority: 'static' })
    );
    expect(pileupStreaming.streamPileupViaTileEngine).toHaveBeenCalledWith({
      start: 10,
      end: 20,
    });

    unmount();
  });

  it('rejects source-backed pileup outside renderer assembly instead of mounting a legacy stream', () => {
    const renderer = fakeRenderer();
    const dataset = pileupDataset();
    const pileupStreaming = {
      streamPileupViaTileEngine: vi.fn(),
    };
    const recordEvent = vi.fn();

    const { unmount } = renderHook(() =>
      useIndexedLaneContractTracks({
        webglRef: {
          current: {
            getLinearRenderer: () => renderer,
            getViewportRange: () => ({ start: 10, end: 20 }),
            setViewport: vi.fn(),
            setViewCenter: vi.fn(),
          },
        },
        rendererAssembly: null,
        manifestChrom: 'chr11',
        activeStressDatasets: [dataset],
        pileupStreaming,
        recordEvent,
      })
    );

    expect(renderer.setTrackInstances).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'cytoband-chr11' }),
    ]);
    expect(renderer.setTrackData).not.toHaveBeenCalledWith(dataset.trackId, expect.anything());
    expect(pileupStreaming.streamPileupViaTileEngine).not.toHaveBeenCalled();
    expect(recordEvent).toHaveBeenCalledWith(
      'pileup-source-rejected-without-renderer-assembly',
      expect.objectContaining({
        trackId: dataset.trackId,
        trackType: dataset.trackType,
        manifestChrom: 'chr11',
      })
    );

    unmount();
  });
});
