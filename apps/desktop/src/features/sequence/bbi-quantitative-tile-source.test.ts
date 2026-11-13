import { describe, expect, it, vi } from 'vitest';

import type { IndexedBbiTrackSource, UcscTrackSource } from '@waypoint/genome-data';
import type { Assembly, AssemblySegment } from '@waypoint/genome-renderer';

import { createBbiQuantitativeTileSource } from './bbi-quantitative-tile-source';
import { BBI_RANGE_GRANT_EXPIRED_ERROR_NAME } from './bbi-range-grant-recovery';
import { admitUcscTrack } from './ucsc-track-client';

describe('createBbiQuantitativeTileSource', () => {
  it('opens the live SSH BigWig directly and allows omitted unplaced contigs', async () => {
    const primary = { id: 'chr1', displayName: 'chr1', length: 1_000, cytobands: [] };
    const unplaced = { id: 'chrUn_A', displayName: 'chrUn_A', length: 200, cytobands: [] };
    const assembly: Assembly = {
      id: 'grch38',
      displayName: 'GRCh38',
      totalLengthBp: 1_200,
      chromosomes: [
        { chromosome: primary, globalStartBp: 0, globalEndBp: 1_000, order: 0 },
        { chromosome: unplaced, globalStartBp: 1_000, globalEndBp: 1_200, order: 1 },
      ],
    };
    const uri = 'http://127.0.0.1:43119/v1/session_123/signal.bigWig';
    const source: IndexedBbiTrackSource = {
      admissionVersion: 1,
      uri,
      input: { kind: 'url', url: uri },
      formatId: 'bigwig',
      readerKind: 'bbi',
      scientificKind: 'quantitative',
      assemblyId: 'grch38',
      referenceReceipt: {
        assemblyId: 'grch38',
        referenceSignature: 'chr1',
        sourceSignature: 'chr1',
        contigMap: { chr1: 'chr1' },
        checkedContigs: 1,
        status: 'compatible',
        checkedAt: '2026-09-24T00:00:00.000Z',
      },
      provenance: {
        provider: 'direct-url',
        sourceKind: 'remote-url',
        label: 'signal.bigWig',
      },
      fingerprint: `remote-signal\u0000ssh://lab-hpc/data/signal.bigWig\u0000${uri}\u000010000`,
      expectedValidators: { contentLength: 10_000 },
    };
    const reader = {
      open: vi.fn().mockResolvedValue({
        fileType: 'bigwig' as const,
        references: [{ name: 'chr1', length: primary.length }],
        zoomReductionLevels: [],
      }),
      queryQuantitative: vi.fn().mockResolvedValue([]),
      closeSource: vi.fn().mockResolvedValue(undefined),
    };
    const admitIndexed = vi.fn();
    const tileSource = createBbiQuantitativeTileSource({
      assembly,
      trackId: 'data:remote-signal',
      source,
      reader,
      admitIndexed,
    });

    const tile = await tileSource.fetchTile(0, 0, [], new AbortController().signal);

    expect(tile.state).toBe('ready');
    expect(admitIndexed).not.toHaveBeenCalled();
    expect(reader.open).toHaveBeenCalledWith(
      expect.stringContaining(source.fingerprint),
      'bigwig',
      expect.objectContaining({
        sourceUri: uri,
        directRangeUrl: uri,
        byteLength: 10_000,
      })
    );
  });

  it.each([
    { sourceContig: 'chr1', sourceLength: 1_000, compatible: true, fixture: true, allowed: true },
    {
      sourceContig: 'NC_000001.11',
      sourceLength: 1_000,
      compatible: true,
      fixture: true,
      allowed: true,
    },
    {
      sourceContig: 'NC_000001.11',
      sourceLength: 999,
      compatible: false,
      fixture: true,
      allowed: true,
    },
    { sourceContig: 'chr1', sourceLength: 1_000, compatible: true, fixture: false, allowed: true },
    {
      sourceContig: 'NC_000001.11',
      sourceLength: 1_000,
      compatible: true,
      fixture: false,
      allowed: true,
    },
    { sourceContig: 'chr1', sourceLength: 1_000, compatible: true, fixture: false, allowed: false },
  ])(
    'reopens $sourceContig ($sourceLength bp), fixture=$fixture, allowed=$allowed',
    async ({ sourceContig, sourceLength, compatible, fixture, allowed }) => {
      const localAuthorityContext = fixture ? 'dev-scenario-fixture' : 'workspace-grounded';
      const chromosome = { id: 'chr1', displayName: 'chr1', length: 1_000, cytobands: [] };
      const placement = {
        chromosome,
        globalStartBp: 0,
        globalEndBp: chromosome.length,
        order: 0,
      };
      const assembly: Assembly = {
        id: 'grch38',
        displayName: 'GRCh38',
        totalLengthBp: chromosome.length + 100,
        chromosomes: [
          placement,
          {
            chromosome: { id: 'chrY', displayName: 'chrY', length: 100, cytobands: [] },
            globalStartBp: chromosome.length,
            globalEndBp: chromosome.length + 100,
            order: 1,
          },
        ],
      };
      const source: IndexedBbiTrackSource = {
        admissionVersion: 1,
        uri: 'file:///analysis/output/signal.bigWig',
        input: { kind: 'path', path: '/analysis/output/signal.bigWig' },
        formatId: 'bigwig',
        readerKind: 'bbi',
        scientificKind: 'quantitative',
        assemblyId: 'grch38',
        referenceReceipt: {
          assemblyId: 'grch38',
          referenceSignature: 'chr1',
          sourceSignature: 'chr1',
          contigMap: { chr1: sourceContig },
          checkedContigs: 1,
          status: 'compatible',
          checkedAt: '2026-08-17T00:00:00.000Z',
        },
        provenance: {
          provider: 'local-file',
          sourceKind: 'local-file',
          label: 'signal.bigWig',
          ...(fixture ? { devScenarioFixture: true } : {}),
        },
        fingerprint: 'local-generation',
      };
      const reader = {
        open: vi.fn().mockResolvedValue({
          fileType: 'bigwig' as const,
          references: [{ name: sourceContig, length: sourceLength }],
          zoomReductionLevels: [],
        }),
        queryQuantitative: vi.fn().mockResolvedValue([]),
        closeSource: vi.fn().mockResolvedValue(undefined),
      };
      const admit = vi.fn();
      const admitIndexed = vi.fn().mockImplementation(async (_input, options) => {
        if (options?.localAuthorityContext !== localAuthorityContext)
          throw new Error(
            'Select this local indexed track through the DNAForge file picker first.'
          );
        if (!allowed) throw new Error('This local indexed track is outside every active project.');
        return {
          baseUrl: 'http://127.0.0.1:8099',
          sourceUri: source.uri,
          sourceToken: 'opaque-local-token',
          canonicalUrlHash: 'local-hash',
          byteLength: 10_000,
          provenanceId: source.fingerprint,
          expiresAtMs: Date.now() + 60_000,
        };
      });
      const tileSource = createBbiQuantitativeTileSource({
        assembly,
        trackId: 'data:signal',
        source,
        reader,
        admit,
        admitIndexed,
      });

      const segment: AssemblySegment = {
        chrom: 'chr1',
        localStart: 100,
        localEnd: 200,
        globalStart: 0,
        placement,
      };
      const tile = await tileSource.fetchTile(0, 0, [segment], new AbortController().signal);

      if (!allowed) {
        expect(tile).toMatchObject({
          state: 'error',
          errorReason: 'This local indexed track is outside every active project.',
        });
        expect(reader.open).not.toHaveBeenCalled();
        expect(reader.queryQuantitative).not.toHaveBeenCalled();
        return;
      }

      if (!compatible) {
        expect(tile).toMatchObject({
          state: 'error',
          errorReason: 'BigWig reference mismatch for chr1: expected 1000, received 999.',
        });
        expect(reader.queryQuantitative).not.toHaveBeenCalled();
        return;
      }

      expect(tile.state).toBe('ready');
      expect(admit).not.toHaveBeenCalled();
      expect(admitIndexed).toHaveBeenCalledWith(
        {
          source: source.input,
          formatId: 'bigwig',
          provenanceId: source.fingerprint,
        },
        { localAuthorityContext }
      );
      expect(reader.open).toHaveBeenCalledWith(
        expect.stringContaining(source.fingerprint),
        'bigwig',
        expect.any(Object)
      );
      expect(reader.queryQuantitative).toHaveBeenCalledWith(
        expect.stringContaining(source.fingerprint),
        [{ refName: sourceContig, start: 100, end: 200 }],
        expect.any(Number),
        expect.any(AbortSignal)
      );
    }
  );

  it('isolates worker handles when two viewers open the same durable source', async () => {
    const chromosome = { id: 'chr1', displayName: 'chr1', length: 1_000, cytobands: [] };
    const assembly: Assembly = {
      id: 'grch38',
      displayName: 'GRCh38',
      totalLengthBp: chromosome.length,
      chromosomes: [
        {
          chromosome,
          globalStartBp: 0,
          globalEndBp: chromosome.length,
          order: 0,
        },
      ],
    };
    const source: IndexedBbiTrackSource = {
      admissionVersion: 1,
      uri: 'file:///analysis/output/signal.bigWig',
      input: { kind: 'path', path: '/analysis/output/signal.bigWig' },
      formatId: 'bigwig',
      readerKind: 'bbi',
      scientificKind: 'quantitative',
      assemblyId: 'grch38',
      referenceReceipt: {
        assemblyId: 'grch38',
        referenceSignature: 'chr1',
        sourceSignature: 'chr1',
        contigMap: { chr1: 'chr1' },
        checkedContigs: 1,
        status: 'compatible',
        checkedAt: '2026-08-17T00:00:00.000Z',
      },
      provenance: {
        provider: 'local-file',
        sourceKind: 'local-file',
        label: 'signal.bigWig',
      },
      fingerprint: 'shared-local-generation',
    };
    const open = vi.fn().mockResolvedValue({
      fileType: 'bigwig' as const,
      references: [{ name: 'chr1', length: chromosome.length }],
      zoomReductionLevels: [],
    });
    const queryQuantitative = vi.fn().mockResolvedValue([]);
    const closeSource = vi.fn().mockResolvedValue(undefined);
    const reader = { open, queryQuantitative, closeSource };
    const admitIndexed = vi.fn().mockResolvedValue({
      baseUrl: 'http://127.0.0.1:8099',
      sourceUri: source.uri,
      sourceToken: 'opaque-local-token',
      canonicalUrlHash: 'local-hash',
      byteLength: 10_000,
      provenanceId: source.fingerprint,
      expiresAtMs: Date.now() + 60_000,
    });
    const first = createBbiQuantitativeTileSource({
      assembly,
      trackId: 'data:signal',
      source,
      reader,
      admitIndexed,
    });
    const second = createBbiQuantitativeTileSource({
      assembly,
      trackId: 'data:signal',
      source,
      reader,
      admitIndexed,
    });

    await first.fetchTile(0, 0, [], new AbortController().signal);
    await second.fetchTile(0, 0, [], new AbortController().signal);
    const firstWorkerKey = open.mock.calls[0]?.[0] as string;
    const secondWorkerKey = open.mock.calls[1]?.[0] as string;
    expect(firstWorkerKey).not.toBe(secondWorkerKey);

    await first.dispose?.();
    expect(closeSource).toHaveBeenCalledWith(firstWorkerKey);
    await second.fetchTile(1, 0, [], new AbortController().signal);
    expect(queryQuantitative).toHaveBeenLastCalledWith(
      secondWorkerKey,
      [],
      expect.any(Number),
      expect.any(AbortSignal)
    );
  });

  it('queries the exact tile range at the shared supersampled resolution', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const chromosome = { id: 'chr1', displayName: 'chr1', length: 1_000, cytobands: [] };
    const placement = {
      chromosome,
      globalStartBp: 0,
      globalEndBp: chromosome.length,
      order: 0,
    };
    const assembly: Assembly = {
      id: 'grch38',
      displayName: 'GRCh38',
      totalLengthBp: chromosome.length,
      chromosomes: [placement],
    };
    const segment: AssemblySegment = {
      chrom: 'chr1',
      localStart: 100,
      localEnd: 200,
      globalStart: 0,
      placement,
    };
    const source: UcscTrackSource = {
      admissionVersion: 1,
      uri: 'https://example.org/gc5Base.bw',
      formatId: 'bigwig',
      readerKind: 'bbi',
      scientificKind: 'quantitative',
      quantitativeColumnSemantics: 'continuous-signal',
      assemblyId: 'grch38',
      referenceReceipt: {
        assemblyId: 'grch38',
        referenceSignature: 'chr1',
        sourceSignature: 'chr1',
        contigMap: { chr1: 'chr1' },
        checkedContigs: 1,
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
      fingerprint: 'ucsc-native\u0000hg38\u0000gc5BaseBw\u0000canonical-hash\u0000"v1"',
      expectedValidators: {
        etag: '"v1"',
        contentLength: 10_000,
      },
    };
    const queryQuantitative = vi.fn().mockResolvedValue([
      {
        starts: Int32Array.of(100, 105),
        ends: Int32Array.of(105, 110),
        values: Float32Array.of(48, 52),
      },
    ]);
    const reader = {
      open: vi.fn().mockResolvedValue({
        fileType: 'bigwig',
        references: [{ name: 'chr1', length: chromosome.length }],
        zoomReductionLevels: [],
      }),
      queryQuantitative,
      closeSource: vi.fn().mockResolvedValue(undefined),
    };
    const admit = vi.fn().mockImplementation(async () => ({
      baseUrl: 'http://127.0.0.1:8099',
      sourceUri: 'https://example.org/gc5Base.bw',
      sourceToken: 'opaque-token',
      canonicalUrlHash: 'canonical-hash',
      byteLength: 10_000,
      etag: '"v1"',
      provenanceId: 'provenance-id',
      expiresAtMs: Date.now() + 60_000,
    }));
    const tileSource = createBbiQuantitativeTileSource({
      assembly,
      trackId: 'ucsc:hg38-gc5BaseBw',
      source,
      reader,
      admit,
    });
    const signal = new AbortController().signal;

    const tile = await tileSource.fetchTile(0, 0, [segment], signal);
    const workerSourceKey = reader.open.mock.calls[0]?.[0] as string;

    expect(queryQuantitative).toHaveBeenCalledWith(
      workerSourceKey,
      [
        {
          refName: 'chr1',
          start: 100,
          end: 200,
        },
      ],
      1,
      signal
    );
    expect(tile).toMatchObject({
      key: {
        sourceId: expect.stringContaining(source.fingerprint),
      },
      state: 'ready',
      count: 2,
      payload: {
        records: [
          { chrom: 'chr1', start: 100, end: 105, value: 48 },
          { chrom: 'chr1', start: 105, end: 110, value: 52 },
        ],
      },
    });

    await tileSource.fetchTile(12, 0, [segment], signal);
    expect(queryQuantitative).toHaveBeenNthCalledWith(
      2,
      workerSourceKey,
      [
        {
          refName: 'chr1',
          start: 100,
          end: 200,
        },
      ],
      1_024,
      signal
    );

    now.mockReturnValue(62_000);
    await tileSource.fetchTile(12, 0, [segment], signal);
    expect(admit).toHaveBeenCalledTimes(2);
    expect(reader.open).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it('rejects a changed remote generation before opening the worker reader', async () => {
    const chromosome = { id: 'chr1', displayName: 'chr1', length: 1_000, cytobands: [] };
    const assembly: Assembly = {
      id: 'grch38',
      displayName: 'GRCh38',
      totalLengthBp: chromosome.length,
      chromosomes: [
        {
          chromosome,
          globalStartBp: 0,
          globalEndBp: chromosome.length,
          order: 0,
        },
      ],
    };
    const source: UcscTrackSource = {
      admissionVersion: 1,
      uri: 'https://example.org/gc5Base.bw',
      formatId: 'bigwig',
      readerKind: 'bbi',
      scientificKind: 'quantitative',
      assemblyId: 'grch38',
      referenceReceipt: {
        assemblyId: 'grch38',
        referenceSignature: 'chr1',
        sourceSignature: 'chr1',
        contigMap: { chr1: 'chr1' },
        checkedContigs: 1,
        status: 'compatible',
        checkedAt: '2026-08-17T00:00:00.000Z',
      },
      provenance: {
        provider: 'ucsc',
        sourceKind: 'ucsc-native',
        catalogId: 'hg38:gc5BaseBw',
        ucscGenome: 'hg38',
        track: 'gc5BaseBw',
        label: 'GC Percent',
      },
      fingerprint: 'durable-generation-v1',
      expectedValidators: {
        etag: '"v1"',
        contentLength: 10_000,
      },
    };
    const reader = {
      open: vi.fn(),
      queryQuantitative: vi.fn(),
      closeSource: vi.fn().mockResolvedValue(undefined),
    };
    const admit = vi.fn().mockResolvedValue({
      baseUrl: 'http://127.0.0.1:8099',
      sourceUri: source.uri,
      sourceToken: 'opaque-token',
      canonicalUrlHash: 'canonical-hash',
      byteLength: 10_000,
      etag: '"v2"',
      provenanceId: 'provenance-id',
      expiresAtMs: Date.now() + 60_000,
    });
    const tileSource = createBbiQuantitativeTileSource({
      assembly,
      trackId: 'ucsc:hg38-gc5BaseBw',
      source,
      reader,
      admit,
    });

    const result = await tileSource.fetchTile(0, 0, [], new AbortController().signal);

    expect(result).toMatchObject({
      state: 'error',
      errorReason: expect.stringContaining('changed since it was added'),
    });
    expect(reader.open).not.toHaveBeenCalled();
  });

  it('re-admits once and retries a retained source after its sidecar grant disappears', async () => {
    const chromosome = { id: 'chr1', displayName: 'chr1', length: 1_000, cytobands: [] };
    const placement = {
      chromosome,
      globalStartBp: 0,
      globalEndBp: chromosome.length,
      order: 0,
    };
    const assembly: Assembly = {
      id: 'grch38',
      displayName: 'GRCh38',
      totalLengthBp: chromosome.length,
      chromosomes: [placement],
    };
    const segment: AssemblySegment = {
      chrom: 'chr1',
      localStart: 100,
      localEnd: 200,
      globalStart: 0,
      placement,
    };
    const source: UcscTrackSource = {
      admissionVersion: 1,
      uri: 'https://example.org/gc5Base.bw',
      formatId: 'bigwig',
      readerKind: 'bbi',
      scientificKind: 'quantitative',
      quantitativeColumnSemantics: 'continuous-signal',
      assemblyId: 'grch38',
      referenceReceipt: {
        assemblyId: 'grch38',
        referenceSignature: 'chr1',
        sourceSignature: 'chr1',
        contigMap: { chr1: 'chr1' },
        checkedContigs: 1,
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
    };
    const expired = new Error('The remote range grant is missing or expired');
    expired.name = BBI_RANGE_GRANT_EXPIRED_ERROR_NAME;
    const decoded = [
      {
        starts: Int32Array.of(100),
        ends: Int32Array.of(105),
        values: Float32Array.of(48),
      },
    ];
    const reader = {
      open: vi.fn().mockResolvedValue({
        fileType: 'bigwig' as const,
        references: [{ name: 'chr1', length: chromosome.length }],
        zoomReductionLevels: [],
      }),
      queryQuantitative: vi.fn().mockRejectedValueOnce(expired).mockResolvedValueOnce(decoded),
      closeSource: vi.fn().mockResolvedValue(undefined),
    };
    let grant = 0;
    const admit = vi.fn().mockImplementation(async () => {
      grant += 1;
      return {
        baseUrl: 'http://127.0.0.1:8099',
        sourceUri: 'https://example.org/gc5Base.bw',
        sourceToken: `opaque-token-${grant}`,
        canonicalUrlHash: 'canonical-hash',
        byteLength: 10_000,
        provenanceId: 'provenance-id',
        expiresAtMs: Date.now() + 60_000,
      };
    });
    const tileSource = createBbiQuantitativeTileSource({
      assembly,
      trackId: 'ucsc:hg38-gc5BaseBw',
      source,
      reader,
      admit,
    });

    const tile = await tileSource.fetchTile(0, 0, [segment], new AbortController().signal);

    expect(tile).toMatchObject({ state: 'ready', count: 1 });
    expect(admit).toHaveBeenCalledTimes(2);
    expect(reader.open).toHaveBeenCalledTimes(2);
    expect(reader.closeSource).toHaveBeenCalledTimes(1);
    expect(reader.queryQuantitative).toHaveBeenCalledTimes(2);
  });

  it('finishes with a closed worker source when disposed during grant recovery', async () => {
    const chromosome = { id: 'chr1', displayName: 'chr1', length: 1_000, cytobands: [] };
    const placement = {
      chromosome,
      globalStartBp: 0,
      globalEndBp: chromosome.length,
      order: 0,
    };
    const assembly: Assembly = {
      id: 'grch38',
      displayName: 'GRCh38',
      totalLengthBp: chromosome.length,
      chromosomes: [placement],
    };
    const segment: AssemblySegment = {
      chrom: 'chr1',
      localStart: 100,
      localEnd: 200,
      globalStart: 0,
      placement,
    };
    const source: UcscTrackSource = {
      admissionVersion: 1,
      uri: 'https://example.org/gc5Base.bw',
      formatId: 'bigwig',
      readerKind: 'bbi',
      scientificKind: 'quantitative',
      quantitativeColumnSemantics: 'continuous-signal',
      assemblyId: 'grch38',
      referenceReceipt: {
        assemblyId: 'grch38',
        referenceSignature: 'chr1',
        sourceSignature: 'chr1',
        contigMap: { chr1: 'chr1' },
        checkedContigs: 1,
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
    };
    const expired = new Error('The remote range grant is missing or expired');
    expired.name = BBI_RANGE_GRANT_EXPIRED_ERROR_NAME;
    const workerOperations: string[] = [];
    const reader = {
      open: vi.fn().mockImplementation(async () => {
        workerOperations.push('open');
        return {
          fileType: 'bigwig' as const,
          references: [{ name: 'chr1', length: chromosome.length }],
          zoomReductionLevels: [],
        };
      }),
      queryQuantitative: vi.fn().mockImplementation(async () => {
        workerOperations.push('query');
        throw expired;
      }),
      closeSource: vi.fn().mockImplementation(async () => {
        workerOperations.push('close');
      }),
    };
    let resolveRecoveryGrant!: (grant: Awaited<ReturnType<typeof admitUcscTrack>>) => void;
    const recoveryGrant = new Promise<Awaited<ReturnType<typeof admitUcscTrack>>>((resolve) => {
      resolveRecoveryGrant = resolve;
    });
    const admit = vi
      .fn()
      .mockResolvedValueOnce({
        baseUrl: 'http://127.0.0.1:8099',
        sourceUri: 'https://example.org/gc5Base.bw',
        sourceToken: 'opaque-token-1',
        canonicalUrlHash: 'canonical-hash',
        byteLength: 10_000,
        provenanceId: 'provenance-id',
        expiresAtMs: Date.now() + 60_000,
      })
      .mockReturnValueOnce(recoveryGrant);
    const tileSource = createBbiQuantitativeTileSource({
      assembly,
      trackId: 'ucsc:hg38-gc5BaseBw',
      source,
      reader,
      admit,
    });

    const fetchPromise = tileSource.fetchTile(0, 0, [segment], new AbortController().signal);
    await vi.waitFor(() => expect(admit).toHaveBeenCalledTimes(2));
    const disposePromise = Promise.resolve(tileSource.dispose?.());
    resolveRecoveryGrant({
      baseUrl: 'http://127.0.0.1:8099',
      sourceUri: 'https://example.org/gc5Base.bw',
      sourceToken: 'opaque-token-2',
      canonicalUrlHash: 'canonical-hash',
      byteLength: 10_000,
      provenanceId: 'provenance-id',
      expiresAtMs: Date.now() + 60_000,
    });

    await disposePromise;
    await expect(fetchPromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(reader.open).toHaveBeenCalledTimes(1);
    expect(reader.queryQuantitative).toHaveBeenCalledTimes(1);
    expect(workerOperations).toEqual(['open', 'query', 'close', 'close']);
  });
});
