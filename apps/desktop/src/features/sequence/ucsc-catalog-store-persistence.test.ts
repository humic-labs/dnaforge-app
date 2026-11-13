// @vitest-environment node

import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UcscCatalogLeaf } from '@waypoint/genome-data';
import { fetchUcscCatalog, searchUcscTracks } from './ucsc-track-client';
import {
  readHostedUcscCatalogSnapshot,
  resetHostedUcscCatalogSnapshotDbForTests,
  writeHostedUcscCatalogSnapshot,
} from './ucsc-catalog-snapshot';
import {
  clearUcscCatalogCache,
  HOSTED_CATALOG_REFRESH_IDLE_MS,
  searchUcscCatalog,
  subscribeUcscCatalog,
} from './ucsc-catalog-store';

vi.mock('./ucsc-track-client', () => ({
  fetchUcscCatalog: vi.fn(),
  searchUcscTracks: vi.fn(),
}));

function leaf(track: string): UcscCatalogLeaf {
  return {
    sourceKind: 'ucsc-native',
    catalogId: `ucsc-native\u0000hg38\u0000${track}\u0000`,
    track,
    shortLabel: track,
    longLabel: `${track} description`,
    scientificKind: 'interval',
    formatId: 'ucsc-native',
    assembly: { ucscGenome: 'hg38', aliases: ['hg38'] },
  } as UcscCatalogLeaf;
}

describe('hosted UCSC catalog snapshot across app sessions', () => {
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    resetHostedUcscCatalogSnapshotDbForTests();
    clearUcscCatalogCache();
    vi.mocked(fetchUcscCatalog).mockReset();
    vi.mocked(searchUcscTracks).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetHostedUcscCatalogSnapshotDbForTests();
    vi.unstubAllGlobals();
  });

  it('opens the saved full catalog after an app-session reset without waiting for UCSC', async () => {
    const snapshot = { genome: 'hg38', tracks: [leaf('knownGene'), leaf('cpgIslandExt')] };
    vi.mocked(fetchUcscCatalog).mockResolvedValueOnce(snapshot);
    const first = await searchUcscCatalog({ genome: 'hg38', query: '' });
    expect(first.catalogSize).toBe(2);
    await vi.waitFor(async () => {
      expect((await readHostedUcscCatalogSnapshot('hg38'))?.snapshot.tracks).toHaveLength(2);
    });

    clearUcscCatalogCache();
    vi.mocked(fetchUcscCatalog).mockImplementation(() => new Promise(() => undefined));
    const reopened = await searchUcscCatalog({ genome: 'hg38', query: 'known' });
    expect(reopened.tracks.map((track) => track.track)).toEqual(['knownGene']);
    expect(reopened.catalogSize).toBe(2);
    expect(fetchUcscCatalog).toHaveBeenCalledTimes(1);
  });

  it('keeps a stale snapshot responsive while the picker is open, then refreshes after it is idle', async () => {
    await writeHostedUcscCatalogSnapshot(
      { genome: 'hg38', tracks: [leaf('oldTrack')] },
      Date.now() - 60 * 60 * 1000
    );
    vi.mocked(fetchUcscCatalog).mockResolvedValue({
      genome: 'hg38',
      tracks: [leaf('newTrack')],
    });
    const onRefresh = vi.fn();
    const unsubscribe = subscribeUcscCatalog({ genome: 'hg38' }, onRefresh);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const cached = await searchUcscCatalog({ genome: 'hg38', query: '' });
      expect(cached.tracks.map((track) => track.track)).toEqual(['oldTrack']);
      expect(fetchUcscCatalog).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(HOSTED_CATALOG_REFRESH_IDLE_MS * 2);
      expect(fetchUcscCatalog).not.toHaveBeenCalled();
      unsubscribe();
      await vi.advanceTimersByTimeAsync(HOSTED_CATALOG_REFRESH_IDLE_MS);
      expect(fetchUcscCatalog).toHaveBeenCalledOnce();
      expect(onRefresh).not.toHaveBeenCalled();
      const refreshed = await searchUcscCatalog({ genome: 'hg38', query: '' });
      expect(refreshed.tracks.map((track) => track.track)).toEqual(['newTrack']);
    } finally {
      unsubscribe();
    }
  });

  it('keeps a saved catalog usable when its idle refresh fails', async () => {
    await writeHostedUcscCatalogSnapshot(
      { genome: 'hg38', tracks: [leaf('knownGene')] },
      Date.now() - 60 * 60 * 1000
    );
    vi.mocked(fetchUcscCatalog).mockRejectedValue(new Error('UCSC temporarily unavailable'));

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const result = await searchUcscCatalog({ genome: 'hg38', query: 'known' });
    expect(result.complete).toBe(true);
    expect(result.tracks.map((track) => track.track)).toEqual(['knownGene']);
    expect(fetchUcscCatalog).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(HOSTED_CATALOG_REFRESH_IDLE_MS);
    expect(fetchUcscCatalog).toHaveBeenCalledOnce();
    expect(searchUcscTracks).not.toHaveBeenCalled();
  });

  it('cancels an idle refresh when the picker reopens and retries once it closes', async () => {
    await writeHostedUcscCatalogSnapshot(
      { genome: 'hg38', tracks: [leaf('oldTrack')] },
      Date.now() - 60 * 60 * 1000
    );
    vi.mocked(fetchUcscCatalog)
      .mockImplementationOnce(
        (_input, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError'))
            );
          })
      )
      .mockResolvedValueOnce({ genome: 'hg38', tracks: [leaf('newTrack')] });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const cached = await searchUcscCatalog({ genome: 'hg38', query: '' });
    expect(cached.tracks[0]?.track).toBe('oldTrack');
    await vi.advanceTimersByTimeAsync(HOSTED_CATALOG_REFRESH_IDLE_MS);
    expect(fetchUcscCatalog).toHaveBeenCalledOnce();

    const unsubscribe = subscribeUcscCatalog({ genome: 'hg38' }, vi.fn());
    expect(vi.mocked(fetchUcscCatalog).mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect((await searchUcscCatalog({ genome: 'hg38', query: '' })).tracks[0]?.track).toBe(
      'oldTrack'
    );
    unsubscribe();
    await vi.advanceTimersByTimeAsync(HOSTED_CATALOG_REFRESH_IDLE_MS);
    expect(fetchUcscCatalog).toHaveBeenCalledTimes(2);
    expect((await searchUcscCatalog({ genome: 'hg38', query: '' })).tracks[0]?.track).toBe(
      'newTrack'
    );
  });
});
