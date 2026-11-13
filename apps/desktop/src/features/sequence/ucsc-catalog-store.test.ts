// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { UcscCatalogLeaf } from '@waypoint/genome-data';

import { fetchUcscCatalog, searchUcscTracks } from './ucsc-track-client';
import { clearUcscCatalogCache, loadUcscCatalog, searchUcscCatalog } from './ucsc-catalog-store';

vi.mock('./ucsc-track-client', () => ({
  fetchUcscCatalog: vi.fn(),
  searchUcscTracks: vi.fn(),
}));

function leaf(track: string, shortLabel = track): UcscCatalogLeaf {
  return {
    sourceKind: 'ucsc-native',
    catalogId: `hg38:${track}`,
    track,
    shortLabel,
    longLabel: `${shortLabel} description`,
    scientificKind: 'quantitative',
    formatId: 'bigwig',
    assembly: { ucscGenome: 'hg38', aliases: ['hg38'] },
  } as UcscCatalogLeaf;
}

const CATALOG = [leaf('gc5BaseBw', 'GC Percent'), leaf('brainSignal', 'brain signal')];

describe('holding one assembly catalog and searching it locally', () => {
  beforeEach(() => {
    clearUcscCatalogCache();
    vi.mocked(fetchUcscCatalog).mockReset();
    vi.mocked(searchUcscTracks).mockReset();
    vi.mocked(fetchUcscCatalog).mockResolvedValue({ genome: 'hg38', tracks: CATALOG });
  });

  it('reads the catalog once however many searches follow', async () => {
    await searchUcscCatalog({ genome: 'hg38', query: 'brain' });
    await searchUcscCatalog({ genome: 'hg38', query: 'GC' });
    await searchUcscCatalog({ genome: 'hg38', query: '' });
    expect(fetchUcscCatalog).toHaveBeenCalledTimes(1);
    expect(searchUcscTracks).not.toHaveBeenCalled();
  });

  it('reports the real total and catalog size, never a page', async () => {
    const result = await searchUcscCatalog({ genome: 'hg38', query: 'brain' });
    expect(result).toMatchObject({ total: 1, catalogSize: 2, complete: true });
    expect(result.tracks.map((track) => track.track)).toEqual(['brainSignal']);
  });

  it('gives several callers arriving together one fetch, not a race', async () => {
    const [a, b, c] = await Promise.all([
      searchUcscCatalog({ genome: 'hg38', query: 'brain' }),
      searchUcscCatalog({ genome: 'hg38', query: 'GC' }),
      loadUcscCatalog({ genome: 'hg38' }),
    ]);
    expect(fetchUcscCatalog).toHaveBeenCalledTimes(1);
    expect(a.total).toBe(1);
    expect(b.total).toBe(1);
    expect(c.tracks).toHaveLength(2);
  });

  it('keeps separate catalogs for separate assemblies and hubs', async () => {
    vi.mocked(fetchUcscCatalog).mockResolvedValue({ genome: 'x', tracks: [] });
    await searchUcscCatalog({ genome: 'hg38', query: '' });
    await searchUcscCatalog({ genome: 'mm39', query: '' });
    await searchUcscCatalog({ genome: 'hg38', query: '', hubUrl: 'https://h.example/hub.txt' });
    expect(fetchUcscCatalog).toHaveBeenCalledTimes(3);
  });

  it('falls back to the capped search and says its counts are not facts', async () => {
    vi.mocked(fetchUcscCatalog).mockRejectedValue(new Error('catalog_too_large'));
    vi.mocked(searchUcscTracks).mockResolvedValue([leaf('brainSignal', 'brain signal')]);

    const result = await searchUcscCatalog({ genome: 'hg38', query: 'brain' });
    expect(result).toMatchObject({ total: 1, catalogSize: null, complete: false });
    expect(searchUcscTracks).toHaveBeenCalledWith(
      expect.objectContaining({ genome: 'hg38', query: 'brain' }),
      expect.anything()
    );
  });

  it('does not cache a failure, so the next caller tries again', async () => {
    vi.mocked(fetchUcscCatalog).mockRejectedValueOnce(new Error('offline'));
    vi.mocked(searchUcscTracks).mockResolvedValue([]);
    const first = await searchUcscCatalog({ genome: 'hg38', query: 'brain' });
    expect(first.complete).toBe(false);

    const second = await searchUcscCatalog({ genome: 'hg38', query: 'brain' });
    expect(second.complete).toBe(true);
    expect(fetchUcscCatalog).toHaveBeenCalledTimes(2);
  });

  it('lets one caller abort without cancelling the catalog for everyone else', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      searchUcscCatalog({ genome: 'hg38', query: 'brain' }, { signal: controller.signal })
    ).rejects.toThrow();
    const result = await searchUcscCatalog({ genome: 'hg38', query: 'brain' });
    expect(result.complete).toBe(true);
    expect(fetchUcscCatalog).toHaveBeenCalledTimes(1);
    expect(searchUcscTracks).not.toHaveBeenCalled();
  });

  it('does not let an older fetch replace a catalog after its cache was cleared', async () => {
    let resolveOld!: (snapshot: { genome: string; tracks: UcscCatalogLeaf[] }) => void;
    vi.mocked(fetchUcscCatalog)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          })
      )
      .mockResolvedValueOnce({ genome: 'hg38', tracks: [leaf('freshTrack')] });
    const oldRequest = loadUcscCatalog({ genome: 'hg38' });
    await vi.waitFor(() => expect(fetchUcscCatalog).toHaveBeenCalledOnce());

    clearUcscCatalogCache();
    const replacement = await loadUcscCatalog({ genome: 'hg38' });
    expect(replacement.tracks.map((track) => track.track)).toEqual(['freshTrack']);
    resolveOld({ genome: 'hg38', tracks: [leaf('oldTrack')] });
    await oldRequest;

    const current = await searchUcscCatalog({ genome: 'hg38', query: '' });
    expect(current.tracks.map((track) => track.track)).toEqual(['freshTrack']);
  });
});
