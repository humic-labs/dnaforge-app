import { describe, expect, it, vi } from 'vitest';
import type { UcscTrackSource } from '@waypoint/genome-data';
import type { Assembly } from '@waypoint/genome-renderer';

import type { Lane } from './lane-contract-store';
import {
  UcscTrackStreamingController,
  type UcscStreamingDebug,
} from './ucsc-track-streaming-controller';

describe('UCSC visible tiles under cache pressure', () => {
  it('stops automatic retries after repeated transient failures, then permits an explicit retry', async () => {
    vi.useFakeTimers();
    const assembly: Assembly = {
      id: 'retry-reference',
      displayName: 'Retry reference',
      totalLengthBp: 1024,
      chromosomes: [
        {
          chromosome: { id: 'chr1', displayName: 'chr1', length: 1024, cytobands: [] },
          globalStartBp: 0,
          globalEndBp: 1024,
          order: 0,
        },
      ],
    };
    const source = { fingerprint: 'retry-source', scientificKind: 'interval' } as UcscTrackSource;
    const lane: Lane = {
      visible: true,
      dataset: {
        kind: 'annotation',
        trackType: 'generic-interval',
        trackId: 'retry-track',
        label: 'Retry track',
        records: [],
      },
      source,
    };
    let debug: UcscStreamingDebug | undefined;
    const fetchTile = vi.fn(async (level: number, index: number) => ({
      key: { sourceId: 'retry-source', level, index },
      state: 'error' as const,
      count: 0,
      byteSize: 0,
      errorReason: 'Service unavailable',
      errorRetryable: true,
    }));
    const controller = new UcscTrackStreamingController({
      assembly,
      lanes: [lane],
      target: {
        getRenderer: () => null,
        requestRender: vi.fn(),
        publishDebug: (next) => {
          debug = next;
        },
      },
      createSource: () => ({
        id: 'retry-source',
        trackId: 'retry-track',
        source,
        levelRange: [0, 0],
        fetchTile,
      }),
    });
    try {
      controller.setViewport({ globalStart: 0, globalEnd: 1024, viewportPx: 1024 });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(debug?.status).toBe('error');
      expect(debug?.recoveringTrackIds).toEqual([]);
      const attempts = fetchTile.mock.calls.length;
      await vi.advanceTimersByTimeAsync(300_000);
      expect(fetchTile).toHaveBeenCalledTimes(attempts);
      controller.retryFailedTiles();
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchTile.mock.calls.length).toBeGreaterThan(attempts);
      expect(debug?.recoveringTrackIds).toEqual(['retry-track']);
    } finally {
      controller.dispose();
      vi.useRealTimers();
    }
  });
  it('preserves the surviving source and its published data across hide, show, and remove', async () => {
    const assembly: Assembly = {
      id: 'two-track-reference',
      displayName: 'Two-track reference',
      totalLengthBp: 4096,
      chromosomes: [
        {
          chromosome: { id: 'chr1', displayName: 'chr1', length: 4096, cytobands: [] },
          globalStartBp: 0,
          globalEndBp: 4096,
          order: 0,
        },
      ],
    };
    const source: UcscTrackSource = {
      admissionVersion: 1,
      uri: 'ucsc://two-track-reference/a',
      formatId: 'ucsc-native',
      readerKind: 'ucsc-rest',
      scientificKind: 'interval',
      assemblyId: assembly.id,
      referenceReceipt: {
        assemblyId: assembly.id,
        referenceSignature: 'reference',
        sourceSignature: 'source-a',
        contigMap: { chr1: 'chr1' },
        checkedContigs: 1,
        status: 'compatible',
        checkedAt: '2026-09-29T00:00:00.000Z',
      },
      provenance: {
        provider: 'ucsc',
        sourceKind: 'ucsc-native',
        catalogId: 'two-track-reference:a',
        ucscGenome: 'two-track-reference',
        track: 'a',
        label: 'A',
      },
      fingerprint: 'source-a',
    };
    const lane = (id: string): Lane => ({
      visible: true,
      dataset: {
        kind: 'annotation',
        trackType: 'generic-interval',
        trackId: id,
        label: id,
        records: [],
      },
      source:
        id === 'a'
          ? source
          : {
              ...source,
              uri: 'ucsc://two-track-reference/b',
              fingerprint: 'source-b',
              provenance: { ...source.provenance, catalogId: 'two-track-reference:b', track: 'b' },
            },
    });
    const a = lane('a');
    const b = lane('b');
    const fetches = new Map<string, number>();
    let debug: UcscStreamingDebug | undefined;
    const setTrackData = vi.fn();
    const renderer = { hasTrackInstance: () => true, setTrackData };
    const controller = new UcscTrackStreamingController({
      assembly,
      lanes: [a, b],
      target: {
        getRenderer: () => renderer,
        requestRender: vi.fn(),
        publishDebug: (next) => {
          debug = next;
        },
      },
      createSource: ({ trackId, source: admitted }) => ({
        id: `source:${trackId}`,
        trackId,
        source: admitted,
        levelRange: [0, 2],
        fetchTile: async (level, index) => {
          fetches.set(trackId, (fetches.get(trackId) ?? 0) + 1);
          return {
            key: { sourceId: `source:${trackId}`, level, index },
            state: 'ready',
            count: 1,
            byteSize: 32,
            payload: { records: [{ chrom: 'chr1', start: index * 1024, end: index * 1024 + 10 }] },
          };
        },
      }),
    });
    try {
      controller.setViewport({ globalStart: 0, globalEnd: 1024, viewportPx: 1024 });
      await vi.waitFor(() => expect(debug?.status).toBe('ready'));
      const aFetches = fetches.get('a');
      setTrackData.mockClear();

      controller.updateActiveLanes([a]);
      controller.refreshPresentationOwner();
      expect(debug?.status).toBe('ready');
      expect(debug?.trackIds).toEqual(['a']);
      expect(fetches.get('a')).toBe(aFetches);
      expect(setTrackData).not.toHaveBeenCalledWith('a', expect.anything());

      setTrackData.mockClear();
      controller.updateActiveLanes([a, b]);
      controller.refreshPresentationOwner();
      await vi.waitFor(() => expect(debug?.status).toBe('ready'));
      expect(fetches.get('a')).toBe(aFetches);
      expect(setTrackData).not.toHaveBeenCalledWith('a', expect.anything());
      expect(setTrackData).toHaveBeenCalledWith(
        'b',
        expect.objectContaining({ records: expect.any(Array) })
      );

      setTrackData.mockClear();
      controller.updateActiveLanes([b]);
      controller.refreshPresentationOwner();
      expect(fetches.get('b')).toBeGreaterThan(0);
      expect(setTrackData).not.toHaveBeenCalledWith('b', expect.anything());
    } finally {
      controller.dispose();
    }
  });

  it('finishes a large visible interval view and a later pan when prefetch exceeds the cache budget', async () => {
    const assembly: Assembly = {
      id: 'pressure-reference',
      displayName: 'Pressure reference',
      totalLengthBp: 4096,
      chromosomes: [
        {
          chromosome: { id: 'chr1', displayName: 'chr1', length: 4096, cytobands: [] },
          globalStartBp: 0,
          globalEndBp: 4096,
          order: 0,
        },
      ],
    };
    const source: UcscTrackSource = {
      admissionVersion: 1,
      uri: 'https://example.org/large.bb',
      formatId: 'bigbed',
      readerKind: 'bbi',
      scientificKind: 'interval',
      assemblyId: assembly.id,
      referenceReceipt: {
        assemblyId: assembly.id,
        referenceSignature: 'reference',
        sourceSignature: 'source',
        contigMap: { chr1: 'chr1' },
        checkedContigs: 1,
        status: 'compatible',
        checkedAt: '2026-09-29T00:00:00.000Z',
      },
      provenance: {
        provider: 'ucsc',
        sourceKind: 'ucsc-native',
        catalogId: 'pressure:large',
        ucscGenome: 'pressure',
        track: 'large',
        label: 'Large intervals',
      },
      fingerprint: 'pressure-source',
    };
    const lane: Lane = {
      visible: true,
      dataset: {
        kind: 'annotation',
        trackType: 'generic-interval',
        trackId: 'large',
        label: 'Large intervals',
        records: [],
      },
      source,
    };
    let debug: UcscStreamingDebug | undefined;
    const setTrackData = vi.fn();
    const controller = new UcscTrackStreamingController({
      assembly,
      lanes: [lane],
      target: {
        getRenderer: () => ({ hasTrackInstance: () => true, setTrackData }),
        requestRender: vi.fn(),
        publishDebug: (next) => {
          debug = next;
        },
      },
      createSource: () => ({
        id: 'pressure-source',
        trackId: 'large',
        source,
        levelRange: [0, 2],
        fetchTile: async (level, index) => ({
          key: { sourceId: 'pressure-source', level, index },
          state: 'ready',
          count: 1,
          byteSize: 48 * 1024 * 1024,
          payload: {
            records: [
              {
                chrom: 'chr1',
                start: index * 1024 * 2 ** level,
                end: index * 1024 * 2 ** level + 10,
              },
            ],
          },
        }),
      }),
    });
    try {
      controller.setViewport({ globalStart: 0, globalEnd: 2048, viewportPx: 2048 });
      await vi.waitFor(() => expect(debug?.status).toBe('ready'));
      expect(setTrackData).toHaveBeenLastCalledWith('large', {
        records: [
          { chrom: 'chr1', start: 0, end: 10 },
          { chrom: 'chr1', start: 1024, end: 1034 },
        ],
      });

      controller.setViewport({ globalStart: 2048, globalEnd: 4096, viewportPx: 2048 });
      await vi.waitFor(() => expect(debug?.status).toBe('ready'));
      expect(setTrackData).toHaveBeenLastCalledWith('large', {
        records: [
          { chrom: 'chr1', start: 2048, end: 2058 },
          { chrom: 'chr1', start: 3072, end: 3082 },
        ],
      });
    } finally {
      controller.dispose();
    }
  });
});
