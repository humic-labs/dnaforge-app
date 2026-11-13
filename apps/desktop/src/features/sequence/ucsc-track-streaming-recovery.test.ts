import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UcscTrackSource } from '@waypoint/genome-data';
import type { Assembly, TileData } from '@waypoint/genome-renderer';

import type { Lane } from './lane-contract-store';
import {
  UcscTrackStreamingController,
  type UcscStreamingDebug,
} from './ucsc-track-streaming-controller';

const assembly: Assembly = {
  id: 'recovery-reference',
  displayName: 'Recovery reference',
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
  uri: 'ucsc://recovery-reference/adipose',
  formatId: 'ucsc-native',
  readerKind: 'ucsc-rest',
  scientificKind: 'interval',
  assemblyId: assembly.id,
  referenceReceipt: {
    assemblyId: assembly.id,
    referenceSignature: 'reference',
    sourceSignature: 'adipose',
    contigMap: { chr1: 'chr1' },
    checkedContigs: 1,
    status: 'compatible',
    checkedAt: '2026-09-29T00:00:00.000Z',
  },
  provenance: {
    provider: 'ucsc',
    sourceKind: 'ucsc-native',
    catalogId: 'recovery-reference:adipose',
    ucscGenome: 'recovery-reference',
    track: 'adipose',
    label: 'Adipose',
  },
  fingerprint: 'adipose-source',
};
const lane: Lane = {
  visible: true,
  dataset: {
    kind: 'annotation',
    trackType: 'generic-interval',
    trackId: 'adipose',
    label: 'Adipose',
    records: [],
  },
  source,
};
const viewport = { globalStart: 0, globalEnd: 1024, viewportPx: 1024 };

function harness(
  fetchTile: (level: number, index: number, signal: AbortSignal) => Promise<TileData>
) {
  let debug: UcscStreamingDebug | undefined;
  const publish = vi.fn();
  const controller = new UcscTrackStreamingController({
    assembly,
    lanes: [lane],
    target: {
      getRenderer: () => ({ hasTrackInstance: () => true, setTrackData: publish }),
      requestRender: vi.fn(),
      publishDebug: (next) => {
        debug = next;
      },
    },
    createSource: (input) => ({
      id: 'recovery-adipose',
      trackId: 'adipose',
      source: input.source,
      levelRange: [0, 2],
      fetchTile,
    }),
  });
  return { controller, publish, debug: () => debug };
}

function ready(level: number, index: number): TileData {
  return {
    key: { sourceId: 'recovery-adipose', level, index },
    state: 'ready',
    count: 1,
    byteSize: 32,
    payload: { records: [{ chrom: 'chr1', start: index * 1024, end: index * 1024 + 10 }] },
  };
}

afterEach(() => vi.useRealTimers());

describe('UCSC streaming recovery', () => {
  it('does not refill the retry budget by visiting cached data while the source remains unavailable', async () => {
    vi.useFakeTimers();
    let available = true;
    const fetchTile = vi.fn(async (level: number, index: number) =>
      available
        ? ready(level, index)
        : {
            key: { sourceId: 'recovery-adipose', level, index },
            state: 'error' as const,
            count: 0,
            byteSize: 0,
            errorReason: 'UCSC returned HTTP 503',
            errorRetryable: true,
          }
    );
    const h = harness(fetchTile);
    try {
      h.controller.setViewport(viewport);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.debug()?.status).toBe('ready');
      available = false;
      h.controller.setViewport({ ...viewport, globalStart: 2048, globalEnd: 3072 });
      await vi.advanceTimersByTimeAsync(0);
      expect(h.debug()?.recoveringTrackIds).toEqual(['adipose']);
      h.controller.setViewport({ ...viewport, globalStart: 1024, globalEnd: 2048 });
      await vi.advanceTimersByTimeAsync(250);
      expect(h.debug()?.recoveringTrackIds).toEqual(['adipose']);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.debug()?.status).toBe('error');
      const attempts = fetchTile.mock.calls.length;
      h.controller.setViewport({ ...viewport, globalStart: 2048, globalEnd: 3072 });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchTile).toHaveBeenCalledTimes(attempts);
      expect(h.debug()?.status).toBe('error');
      expect(h.debug()?.recoveringTrackIds).toEqual([]);
    } finally {
      h.controller.dispose();
    }
  });

  it('replaces a blocked source and ignores completions from the previous source lifetime', async () => {
    vi.useFakeTimers();
    const pending: Array<(value: TileData) => void> = [];
    let replaced = false;
    const fetchTile = vi.fn((level: number, index: number) =>
      replaced
        ? Promise.resolve(ready(level, index))
        : new Promise<TileData>((resolve) => pending.push(resolve))
    );
    const h = harness(fetchTile);
    try {
      h.controller.setViewport(viewport);
      pending[0]({
        key: { sourceId: 'recovery-adipose', level: 0, index: 0 },
        state: 'error',
        count: 0,
        byteSize: 0,
        errorReason: 'ENOENT: no such file or directory',
        errorRetryable: false,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(h.debug()?.status).toBe('error');
      replaced = true;
      h.controller.updateActiveLanes([
        { ...lane, source: { ...source, fingerprint: 'replacement-source' } },
      ]);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.debug()?.status).toBe('ready');
      for (const resolve of pending.slice(1))
        resolve({
          key: { sourceId: 'recovery-adipose', level: 0, index: 1 },
          state: 'error',
          count: 0,
          byteSize: 0,
          errorReason: 'The old source failed after replacement.',
          errorRetryable: false,
        });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.debug()?.status).toBe('ready');
      expect(h.debug()?.errorsByTrackId).toBeUndefined();
    } finally {
      h.controller.dispose();
    }
  });

  it('keeps an unavailable source blocked across navigation and presentation rewiring until explicit retry', async () => {
    vi.useFakeTimers();
    let available = false;
    const fetchTile = vi.fn(async (level: number, index: number) =>
      available
        ? ready(level, index)
        : {
            key: { sourceId: 'recovery-adipose', level, index },
            state: 'error' as const,
            count: 0,
            byteSize: 0,
            errorReason: 'ENOENT: no such file or directory',
            errorRetryable: false,
          }
    );
    const h = harness(fetchTile);
    try {
      h.controller.setViewport(viewport);
      await vi.advanceTimersByTimeAsync(0);
      const attempts = fetchTile.mock.calls.length;
      for (const next of [
        { ...viewport, globalStart: 1, globalEnd: 1025 },
        { ...viewport, globalStart: 3072, globalEnd: 4096 },
        { ...viewport, globalEnd: 4096, viewportPx: 256 },
        viewport,
      ]) {
        h.controller.setViewport(next);
        h.controller.refreshPresentationOwner(['adipose']);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(fetchTile).toHaveBeenCalledTimes(attempts);
        expect(h.debug()?.errorsByTrackId?.adipose).toContain('ENOENT');
        expect(h.debug()?.recoveringTrackIds).toEqual([]);
      }
      available = true;
      h.controller.retryFailedTiles();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchTile.mock.calls.length).toBeGreaterThan(attempts);
      expect(h.debug()?.status).toBe('ready');
    } finally {
      h.controller.dispose();
    }
  });

  it('preserves an exhausted source retry budget across new tiles and zoom levels', async () => {
    vi.useFakeTimers();
    const fetchTile = vi.fn(async (level: number, index: number) => ({
      key: { sourceId: 'recovery-adipose', level, index },
      state: 'error' as const,
      count: 0,
      byteSize: 0,
      errorReason: 'UCSC returned HTTP 503',
      errorRetryable: true,
    }));
    const h = harness(fetchTile);
    try {
      h.controller.setViewport(viewport);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.debug()?.status).toBe('error');
      const attempts = fetchTile.mock.calls.length;
      for (const next of [
        { ...viewport, globalStart: 3072, globalEnd: 4096 },
        { ...viewport, globalEnd: 4096, viewportPx: 256 },
        viewport,
      ]) {
        h.controller.setViewport(next);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(fetchTile).toHaveBeenCalledTimes(attempts);
        expect(h.debug()?.status).toBe('error');
        expect(h.debug()?.recoveringTrackIds).toEqual([]);
      }
    } finally {
      h.controller.dispose();
    }
  });

  it('keeps navigation behind the current source backoff and recovers the latest viewport', async () => {
    vi.useFakeTimers();
    let available = false;
    const fetchTile = vi.fn(async (level: number, index: number) =>
      available
        ? ready(level, index)
        : {
            key: { sourceId: 'recovery-adipose', level, index },
            state: 'error' as const,
            count: 0,
            byteSize: 0,
            errorReason: 'UCSC returned HTTP 503',
            errorRetryable: true,
          }
    );
    const h = harness(fetchTile);
    try {
      h.controller.setViewport(viewport);
      await vi.advanceTimersByTimeAsync(0);
      const attempts = fetchTile.mock.calls.length;
      h.controller.setViewport({ ...viewport, globalStart: 3072, globalEnd: 4096 });
      await vi.advanceTimersByTimeAsync(100);
      expect(fetchTile).toHaveBeenCalledTimes(attempts);
      expect(h.debug()?.recoveringTrackIds).toEqual(['adipose']);
      available = true;
      await vi.advanceTimersByTimeAsync(2000);
      expect(h.debug()?.status).toBe('ready');
      expect(h.debug()?.viewport).toEqual({ start: 3072, end: 4096 });
    } finally {
      h.controller.dispose();
    }
  });

  it('lets a smaller request recover a request-scoped limit without resetting a source failure', async () => {
    vi.useFakeTimers();
    const fetchTile = vi.fn(async (level: number, index: number) =>
      level === 0
        ? ready(level, index)
        : {
            key: { sourceId: 'recovery-adipose', level, index },
            state: 'error' as const,
            count: 0,
            byteSize: 0,
            errorReason: 'upstream-truncated:10000/10000',
            errorRetryable: false,
            errorScope: 'request' as const,
          }
    );
    const h = harness(fetchTile);
    try {
      h.controller.setViewport({ ...viewport, globalEnd: 4096, viewportPx: 256 });
      await vi.advanceTimersByTimeAsync(0);
      expect(h.debug()?.status).toBe('error');
      h.controller.setViewport({ ...viewport, globalEnd: 512 });
      await vi.advanceTimersByTimeAsync(0);
      expect(h.debug()?.status).toBe('ready');
    } finally {
      h.controller.dispose();
    }
  });

  it('retries a transient visible failure without a click or viewport change, then clears the error', async () => {
    vi.useFakeTimers();
    const attempts = new Map<string, number>();
    const h = harness(async (level, index) => {
      const key = `${level}/${index}`;
      const count = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, count);
      if (count === 1)
        return {
          key: { sourceId: 'recovery-adipose', level, index },
          state: 'error',
          count: 0,
          byteSize: 0,
          errorReason: 'UCSC returned HTTP 503',
        };
      return ready(level, index);
    });
    try {
      h.controller.setViewport(viewport);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.debug()?.status).toBe('loading');
      expect(h.debug()?.errorsByTrackId).toBeUndefined();
      await vi.advanceTimersByTimeAsync(2000);
      expect(h.debug()?.status).toBe('ready');
      expect(h.publish).toHaveBeenCalledWith(
        'adipose',
        expect.objectContaining({ records: expect.any(Array) })
      );
      expect([...attempts.values()].some((count) => count > 1)).toBe(true);
    } finally {
      h.controller.dispose();
    }
  });

  it('turns a stalled request into a recoverable retry instead of leaving the lane pending forever', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const h = harness(async (level, index) => {
      attempts += 1;
      if (attempts === 1) return new Promise<TileData>(() => {});
      return ready(level, index);
    });
    try {
      h.controller.setViewport(viewport);
      await vi.advanceTimersByTimeAsync(62_000);
      expect(h.debug()?.status).toBe('ready');
      expect(attempts).toBeGreaterThan(1);
    } finally {
      h.controller.dispose();
    }
  });

  it('recovers a shared-reader abort while the current viewport is still wanted', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const h = harness(async (level, index) => {
      attempts += 1;
      if (attempts === 1) throw new DOMException('Shared index read was cancelled.', 'AbortError');
      return ready(level, index);
    });
    try {
      h.controller.setViewport(viewport);
      await vi.advanceTimersByTimeAsync(2000);
      expect(h.debug()?.status).toBe('ready');
      expect(attempts).toBeGreaterThan(1);
    } finally {
      h.controller.dispose();
    }
  });

  it('cancels scheduled recovery when the lane is removed', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const h = harness(async (level, index) => {
      attempts += 1;
      return {
        key: { sourceId: 'recovery-adipose', level, index },
        state: 'error',
        count: 0,
        byteSize: 0,
        errorReason: 'UCSC returned HTTP 503',
      };
    });
    try {
      h.controller.setViewport(viewport);
      await vi.advanceTimersByTimeAsync(0);
      const before = attempts;
      h.controller.updateActiveLanes([]);
      await vi.advanceTimersByTimeAsync(62_000);
      expect(attempts).toBe(before);
    } finally {
      h.controller.dispose();
    }
  });

  it('surfaces a permanent source error without repeatedly requesting the same tile', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const h = harness(async (level, index) => {
      attempts += 1;
      return {
        key: { sourceId: 'recovery-adipose', level, index },
        state: 'error',
        count: 0,
        byteSize: 0,
        errorReason: 'The genomic source changed after admission.',
        errorRetryable: false,
      };
    });
    try {
      h.controller.setViewport(viewport);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.debug()?.status).toBe('error');
      expect(h.debug()?.errorsByTrackId?.adipose).toMatch(/source changed/);
      const before = attempts;
      await vi.advanceTimersByTimeAsync(62_000);
      expect(attempts).toBe(before);
    } finally {
      h.controller.dispose();
    }
  });
});
