import { describe, expect, it, vi } from 'vitest';

import type { Assembly, AssemblySegment } from '@waypoint/genome-renderer';
import type {
  AdmittedTrackSource,
  IndexedBbiTrackSource,
  UcscTrackSource,
} from '@waypoint/genome-data';

import {
  buildSortedIntervalIndex,
  createAdmittedTrackTileSource,
  createUcscRestTileSource,
  querySortedIntervalIndex,
} from './ucsc-tile-source';

vi.mock('./bbi-reader-runtime', () => ({
  getBbiReaderWorkerClient: () => ({
    open: vi.fn(),
    queryIntervals: vi.fn(),
    queryQuantitative: vi.fn(),
    closeSource: vi.fn(),
  }),
}));

vi.mock('./text-interval-reader-runtime', () => ({
  getTextIntervalReaderWorkerClient: () => ({
    open: vi.fn(),
    query: vi.fn(),
    closeSource: vi.fn(),
  }),
}));

const ASSEMBLY: Assembly = {
  id: 'grch38',
  displayName: 'GRCh38',
  totalLengthBp: 200_000,
  chromosomes: [
    {
      chromosome: { id: 'chr1', displayName: 'chr1', length: 100_000, cytobands: [] },
      globalStartBp: 0,
      globalEndBp: 100_000,
      order: 0,
    },
    {
      chromosome: { id: 'chr2', displayName: 'chr2', length: 100_000, cytobands: [] },
      globalStartBp: 100_000,
      globalEndBp: 200_000,
      order: 1,
    },
  ],
};

const SOURCE: UcscTrackSource = {
  admissionVersion: 1,
  uri: 'ucsc://hg38/cpgIslandExt',
  formatId: 'ucsc-native',
  readerKind: 'ucsc-rest',
  scientificKind: 'interval',
  assemblyId: 'grch38',
  referenceReceipt: {
    assemblyId: 'grch38',
    referenceSignature: 'grch38',
    sourceSignature: 'cpg',
    contigMap: { chr1: 'chr1', chr2: 'chr2' },
    checkedContigs: 2,
    status: 'compatible',
    checkedAt: '2026-08-18T00:00:00.000Z',
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
};

function segment(chrom: 'chr1' | 'chr2', localStart: number, localEnd: number): AssemblySegment {
  const placement = ASSEMBLY.chromosomes.find((candidate) => candidate.chromosome.id === chrom)!;
  return { chrom, localStart, localEnd, globalStart: placement.globalStartBp, placement };
}

describe('createUcscRestTileSource', () => {
  it('fetches one immutable whole-track snapshot and serves every LOD from it', async () => {
    const fetchWhole = vi.fn().mockResolvedValue({
      records: [
        { chrom: 'chr1', chromStart: 100, chromEnd: 200, name: 'one' },
        { chrom: 'chr2', chromStart: 500, chromEnd: 600, name: 'two' },
      ],
      complete: true,
      itemsReturned: 2,
      maxItemsOutput: 100_000,
      trackType: 'bed 4',
    });
    const fetchRegion = vi.fn(() => {
      throw new Error('camera motion must never reach UCSC');
    });
    const source = createUcscRestTileSource({
      assembly: ASSEMBLY,
      trackId: 'ucsc:hg38-cpgIslandExt',
      source: SOURCE,
      fetchWhole,
      fetchRegion,
    });

    const first = await source.fetchTile(
      8,
      0,
      [segment('chr1', 0, 1_000)],
      new AbortController().signal
    );
    const second = await source.fetchTile(
      0,
      0,
      [segment('chr1', 0, 100_000), segment('chr2', 0, 100_000)],
      new AbortController().signal
    );

    expect(fetchWhole).toHaveBeenCalledOnce();
    expect(fetchWhole).toHaveBeenCalledWith(
      {
        genome: 'hg38',
        track: 'cpgIslandExt',
        hubUrl: undefined,
        maxItemsOutput: 1_000_000,
      },
      { signal: expect.any(AbortSignal) }
    );
    expect(fetchRegion).not.toHaveBeenCalled();
    expect(first).toMatchObject({ state: 'ready', count: 1 });
    expect(second).toMatchObject({ state: 'ready', count: 2 });
  });

  it('retires a failed snapshot so the tile engine can recover on its next attempt', async () => {
    const fetchWhole = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary UCSC failure'))
      .mockResolvedValueOnce({
        records: [{ chrom: 'chr1', chromStart: 100, chromEnd: 200, name: 'recovered' }],
        complete: true,
        itemsReturned: 1,
        maxItemsOutput: 100_000,
        trackType: 'bed 4',
      });
    const source = createUcscRestTileSource({
      assembly: ASSEMBLY,
      trackId: 'ucsc:hg38-cpgIslandExt',
      source: SOURCE,
      fetchWhole,
      fetchRegion: vi.fn(),
    });

    const failed = await source.fetchTile(
      8,
      0,
      [segment('chr1', 0, 1_000)],
      new AbortController().signal
    );
    const recovered = await source.fetchTile(
      8,
      0,
      [segment('chr1', 0, 1_000)],
      new AbortController().signal
    );

    expect(failed).toMatchObject({ state: 'error', errorReason: 'temporary UCSC failure' });
    expect(recovered).toMatchObject({ state: 'ready', count: 1 });
    expect(fetchWhole).toHaveBeenCalledTimes(2);
  });

  it('keeps the shared snapshot alive when one viewport tile is cancelled', async () => {
    let resolveWhole:
      | ((value: {
          records: Array<Record<string, unknown>>;
          complete: boolean;
          itemsReturned: number;
          maxItemsOutput: number;
          trackType: string;
        }) => void)
      | undefined;
    const fetchWhole = vi.fn(
      () =>
        new Promise<{
          records: Array<Record<string, unknown>>;
          complete: boolean;
          itemsReturned: number;
          maxItemsOutput: number;
          trackType: string;
        }>((resolve) => {
          resolveWhole = resolve;
        })
    );
    const source = createUcscRestTileSource({
      assembly: ASSEMBLY,
      trackId: 'ucsc:hg38-cpgIslandExt',
      source: SOURCE,
      fetchWhole,
      fetchRegion: vi.fn(),
    });
    const cancelled = new AbortController();
    const first = source.fetchTile(8, 0, [segment('chr1', 0, 1_000)], cancelled.signal);
    const surviving = source.fetchTile(
      8,
      0,
      [segment('chr2', 0, 1_000)],
      new AbortController().signal
    );

    cancelled.abort();
    resolveWhole?.({
      records: [
        { chrom: 'chr1', chromStart: 100, chromEnd: 200, name: 'one' },
        { chrom: 'chr2', chromStart: 500, chromEnd: 600, name: 'two' },
      ],
      complete: true,
      itemsReturned: 2,
      maxItemsOutput: 100_000,
      trackType: 'bed 4',
    });

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await expect(surviving).resolves.toMatchObject({ state: 'ready', count: 1 });
    expect(fetchWhole).toHaveBeenCalledOnce();
  });
});

describe('admitted track tile source registry', () => {
  it('routes an admitted BigBed to the regional BBI interval reader', () => {
    const source: IndexedBbiTrackSource = {
      admissionVersion: 1,
      uri: 'https://data.example.org/regions.bb',
      input: { kind: 'url', url: 'https://data.example.org/regions.bb' },
      formatId: 'bigbed',
      readerKind: 'bbi',
      scientificKind: 'interval',
      assemblyId: 'grch38',
      referenceReceipt: {
        assemblyId: 'grch38',
        referenceSignature: 'reference',
        sourceSignature: 'source',
        contigMap: { chr1: 'chr1', chr2: 'chr2' },
        checkedContigs: 2,
        status: 'compatible',
        checkedAt: '2026-09-21T00:00:00.000Z',
      },
      provenance: {
        provider: 'direct-url',
        sourceKind: 'remote-url',
        label: 'regions.bb',
      },
      fingerprint: 'bigbed-generation',
    };

    const tileSource = createAdmittedTrackTileSource({
      assembly: ASSEMBLY,
      trackId: 'data:regions',
      source,
    });

    expect(tileSource).toMatchObject({
      trackId: 'data:regions',
      source,
      levelRange: [0, expect.any(Number)],
    });
  });

  it('routes an admitted local text track to the retained interval reader', () => {
    const source: AdmittedTrackSource = {
      admissionVersion: 2,
      request: {
        contract: 'dnaforge.track-admission-request.v1',
        assemblyId: 'grch38',
        source: { kind: 'local-file', path: '/analysis/regions.bed' },
        formatId: 'bed',
        scientificKind: 'interval',
        ingress: { kind: 'file-picker' },
      },
      admittedAt: '2026-09-21T00:00:00.000Z',
      uri: 'file:///analysis/regions.bed',
      input: { kind: 'path', path: '/analysis/regions.bed' },
      formatId: 'bed',
      readerKind: 'interval-text',
      scientificKind: 'interval',
      assemblyId: 'grch38',
      referenceReceipt: {
        assemblyId: 'grch38',
        referenceSignature: 'reference',
        sourceSignature: 'source',
        contigMap: { chr1: 'chr1' },
        checkedContigs: 1,
        status: 'compatible',
        checkedAt: '2026-09-21T00:00:00.000Z',
      },
      provenance: { provider: 'local-file', sourceKind: 'local-file', label: 'regions.bed' },
      fingerprint: `bed:sha256:${'a'.repeat(64)}`,
    };

    const tileSource = createAdmittedTrackTileSource({
      assembly: ASSEMBLY,
      trackId: 'data:local-regions',
      source,
    });

    expect(tileSource).toMatchObject({
      id: expect.stringContaining('interval-text:data:local-regions'),
      trackId: 'data:local-regions',
      source,
    });
  });
});

describe('sorted sparse-track interval index', () => {
  it('positions a late-chromosome query without rescanning the preceding records', () => {
    let coordinateReads = 0;
    const records = Array.from({ length: 100_000 }, (_, ordinal) => {
      const start = ordinal * 10;
      const end = start + 5;
      return {
        ordinal,
        get start(): number {
          coordinateReads += 1;
          return start;
        },
        get end(): number {
          coordinateReads += 1;
          return end;
        },
      };
    });
    const index = buildSortedIntervalIndex(records);
    coordinateReads = 0;

    const matches = querySortedIntervalIndex(index, 999_900, 999_950);

    expect(matches.map((record) => record.ordinal)).toEqual([
      99_990, 99_991, 99_992, 99_993, 99_994,
    ]);
    expect(coordinateReads).toBeLessThan(20);
  });

  it('stays bounded when an early chromosome-spanning interval overlaps a late query', () => {
    const records = [
      { ordinal: -1, start: 0, end: 1_000_000 },
      ...Array.from({ length: 100_000 }, (_, ordinal) => ({
        ordinal,
        start: ordinal * 10,
        end: ordinal * 10 + 5,
      })),
    ];
    const built = buildSortedIntervalIndex(records);
    let treeReads = 0;
    const maxEndTree = new Proxy(built.maxEndTree, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) treeReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });

    const matches = querySortedIntervalIndex({ ...built, maxEndTree }, 999_900, 999_950);

    expect(matches.map((record) => record.ordinal)).toEqual([
      -1, 99_990, 99_991, 99_992, 99_993, 99_994,
    ]);
    expect(treeReads).toBeLessThan(100);
  });
});
