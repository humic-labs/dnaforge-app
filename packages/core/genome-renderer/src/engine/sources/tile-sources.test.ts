import { describe, it, expect } from 'vitest';
import type { AssemblySegment } from '../../assembly-layout';
import {
  createAssemblyCoverageTileSource,
  createCoverageTileSource,
  createAlignmentTileSource,
  createAnnotationTileSource,
  maxFineLevel,
  maxAlternateGuideLevel,
  maxReadAlignmentLevel,
} from './tile-sources';
import type { TileTransport, TileTransportRequest, TileTransportResponse } from './tile-transport';

function seg(chrom = 'chr11', localStart = 0, localEnd = 1024, globalStart = 0): AssemblySegment {
  return {
    chrom,
    localStart,
    localEnd,
    globalStart,
    placement: {
      chromosome: { id: chrom, displayName: chrom, length: 135_086_622, cytobands: [] },
      globalStartBp: globalStart,
      globalEndBp: globalStart + 135_086_622,
      order: 0,
    },
  } as AssemblySegment;
}

function recordingTransport(
  response: TileTransportResponse,
  log: TileTransportRequest[]
): TileTransport {
  return async (req) => {
    log.push(req);
    return response;
  };
}

const ok = (body: unknown): TileTransportResponse => ({ ok: true, status: 200, body });
const notFound = (detail: string): TileTransportResponse => ({
  ok: false,
  status: 404,
  body: { detail },
});

const sourceGeneration = {
  contract: 'aligned-read-source-generation.v1',
  alignment: {
    canonicalPath: '/data/HG002.bam',
    size: 100,
    mtimeNs: '10',
    ctimeNs: '11',
  },
  index: {
    canonicalPath: '/data/HG002.bam.bai',
    size: 20,
    mtimeNs: '12',
    ctimeNs: '13',
  },
} as const;

describe('createCoverageTileSource', () => {
  const file = {
    bamPath: '/data/HG002.bam',
    indexPath: '/data/HG002.bam.bai',
    referencePath: '/data/GRCh38.fa',
  };

  it('hits /tiles/coverage and builds {bamPath, chrom, indexPath, referencePath}', async () => {
    const log: TileTransportRequest[] = [];
    const src = createCoverageTileSource(file, {
      transport: recordingTransport(
        ok({
          bins: [0, 1, 2],
          binSize: 1024,
          maxDepth: 2,
          provenance: { exact: true, method: 'pyramid-maxpool' },
        }),
        log
      ),
    });
    await src.fetchTile(8, 13, [seg('chr11')], new AbortController().signal);
    expect(log[0].kind).toBe('coverage');
    expect(log[0].level).toBe(8);
    expect(log[0].tileIndex).toBe(13);
    expect(log[0].body).toEqual({
      bamPath: '/data/HG002.bam',
      chrom: 'chr11',
      chromGlobalStart: 0,
      indexPath: '/data/HG002.bam.bai',
      referencePath: '/data/GRCh38.fa',
    });
  });

  it('a populated coverage tile (maxDepth>0) is ready with count>0', async () => {
    const src = createCoverageTileSource(file, {
      transport: recordingTransport(
        ok({
          bins: [0, 3, 5, 0],
          binSize: 1024,
          maxDepth: 5,
          provenance: { exact: true, method: 'pyramid-maxpool' },
        }),
        []
      ),
    });
    const data = await src.fetchTile(8, 13, [seg()], new AbortController().signal);
    expect(data.state).toBe('ready');
    expect(data.count).toBeGreaterThan(0);
    expect(data.byteSize).toBeGreaterThan(0);
  });

  it('an all-zero coverage tile (maxDepth===0) is ready but count:0 (valid empty)', async () => {
    const src = createCoverageTileSource(file, {
      transport: recordingTransport(
        ok({
          bins: [0, 0, 0],
          binSize: 1024,
          maxDepth: 0,
          provenance: { exact: true, method: 'pyramid-maxpool' },
        }),
        []
      ),
    });
    const data = await src.fetchTile(8, 13, [seg()], new AbortController().signal);
    expect(data.state).toBe('ready');
    expect(data.count).toBe(0);
  });

  it('estimated or provenance-missing coverage cannot count as non-empty ready data', async () => {
    const missing = createCoverageTileSource(file, {
      transport: recordingTransport(ok({ bins: [4, 4, 4], binSize: 1024, maxDepth: 4 }), []),
    });
    const estimated = createCoverageTileSource(file, {
      transport: recordingTransport(
        ok({
          bins: [4, 4, 4],
          binSize: 1024,
          maxDepth: 4,
          provenance: { exact: false, method: 'estimated-average-depth' },
        }),
        []
      ),
    });

    expect((await missing.fetchTile(8, 13, [seg()], new AbortController().signal)).count).toBe(0);
    expect((await estimated.fetchTile(8, 13, [seg()], new AbortController().signal)).count).toBe(0);
  });

  it('inherits the 404→error contract (index missing)', async () => {
    const src = createCoverageTileSource(file, {
      transport: recordingTransport(notFound('IndexNotFoundError: .bai missing'), []),
    });
    const data = await src.fetchTile(8, 13, [seg()], new AbortController().signal);
    expect(data.state).toBe('error');
    expect(data.errorReason).toContain('IndexNotFoundError');
  });

  it('omits optional path keys when not provided', async () => {
    const log: TileTransportRequest[] = [];
    const src = createCoverageTileSource(
      { bamPath: '/data/x.bam' },
      {
        transport: recordingTransport(
          ok({
            bins: [],
            binSize: 0,
            maxDepth: 0,
            provenance: { exact: true, method: 'empty-outside-chrom' },
          }),
          log
        ),
      }
    );
    await src.fetchTile(8, 13, [seg()], new AbortController().signal);
    expect(log[0].body).toEqual({ bamPath: '/data/x.bam', chrom: 'chr11', chromGlobalStart: 0 });
  });

  it('sends the admitted source generation on coverage requests', async () => {
    const log: TileTransportRequest[] = [];
    const src = createCoverageTileSource(
      { ...file, sourceGeneration },
      {
        transport: recordingTransport(
          ok({
            bins: [],
            binSize: 0,
            maxDepth: 0,
            provenance: { exact: true, method: 'empty' },
          }),
          log
        ),
      }
    );

    await src.fetchTile(8, 13, [seg()], new AbortController().signal);

    expect(log[0].body).toMatchObject({ sourceGeneration });
  });

  it('declares the production coverage handoff and fast-pan prefetch contract', () => {
    const src = createCoverageTileSource(file, {
      transport: recordingTransport(
        ok({
          bins: [],
          binSize: 0,
          maxDepth: 0,
          provenance: { exact: true, method: 'empty' },
        }),
        []
      ),
    });
    expect(src.prefetch?.sameLevelMarginTiles).toBe(64);
    expect(src.prefetch?.sameLevelMarginMinLevel).toBe(0);
    expect(src.prefetch?.criticalFinerLevel).toBe(17);
    expect(src.prefetch?.criticalFinerPrefetchLevels).toBe(3);
    expect(src.prefetch?.criticalFinerMaxCurrentLevel).toBe(21);
    expect(src.prefetch?.finerLookaheadWindowBp).toBe(256_000);
    expect(src.prefetch?.additionalCriticalFinerHandoffs).toEqual([
      {
        level: 3,
        prefetchLevels: 1,
        minCurrentLevel: 7,
        maxCurrentLevel: 9,
        lookaheadWindowBp: 32_000,
      },
      {
        level: 2,
        prefetchLevels: 1,
        minCurrentLevel: 7,
        maxCurrentLevel: 9,
        lookaheadWindowBp: 32_000,
      },
    ]);
  });
});

describe('createAssemblyCoverageTileSource', () => {
  const file = {
    bamPath: '/data/HG002.bam',
    indexPath: '/data/HG002.bam.bai',
  };

  it('hits /tiles/coverage-assembly and sends every global-tile chromosome segment', async () => {
    const log: TileTransportRequest[] = [];
    const src = createAssemblyCoverageTileSource(file, {
      transport: recordingTransport(
        ok({
          segments: [
            {
              chrom: 'chr1',
              start: 100,
              end: 900,
              globalStart: 100,
              globalEnd: 900,
              bins: [0, 2, 0],
              binSize: 10,
              maxDepth: 2,
              provenance: { exact: true, method: 'pyramid-maxpool' },
            },
            {
              chrom: 'chr2',
              start: 0,
              end: 600,
              globalStart: 1_000_000,
              globalEnd: 1_000_600,
              bins: [3, 0, 4],
              binSize: 10,
              maxDepth: 4,
              provenance: { exact: true, method: 'pyramid-maxpool' },
            },
          ],
          maxDepth: 4,
          provenance: { exact: true, method: 'pyramid-maxpool' },
        }),
        log
      ),
    });

    const data = await src.fetchTile(
      12,
      0,
      [seg('chr1', 100, 900, 0), seg('chr2', 0, 600, 1_000_000)],
      new AbortController().signal
    );

    expect(log[0].kind).toBe('coverage-assembly');
    expect(log[0].body).toEqual({
      bamPath: '/data/HG002.bam',
      indexPath: '/data/HG002.bam.bai',
      segments: [
        { chrom: 'chr1', start: 100, end: 900, chromGlobalStart: 0 },
        { chrom: 'chr2', start: 0, end: 600, chromGlobalStart: 1_000_000 },
      ],
    });
    expect(data.state).toBe('ready');
    expect(data.count).toBe(3);
    expect(data.byteSize).toBe(24);
  });

  it('sends an htsget runtime grant instead of file locators', async () => {
    const log: TileTransportRequest[] = [];
    const src = createAssemblyCoverageTileSource(
      {
        bamPath: 'htsget-runtime://identity/source.bam',
        htsget: {
          sourceToken: 'short-lived-runtime-token',
          sourceIdentity: 'e'.repeat(64),
          format: 'BAM',
        },
      },
      { transport: recordingTransport(ok({ segments: [] }), log) }
    );

    await src.fetchTile(12, 0, [seg('chr1', 100, 900, 0)], new AbortController().signal);

    expect(log[0].body).toEqual({
      htsgetToken: 'short-lived-runtime-token',
      htsgetSourceIdentity: 'e'.repeat(64),
      htsgetFormat: 'BAM',
      segments: [{ chrom: 'chr1', start: 100, end: 900, chromGlobalStart: 0 }],
    });
    expect(log[0].body).not.toHaveProperty('bamPath');
    expect(log[0].body).not.toHaveProperty('indexPath');
  });

  it('declares the production assembly coverage handoff and fast-pan prefetch contract', () => {
    const src = createAssemblyCoverageTileSource(file, {
      transport: recordingTransport(ok({ segments: [] }), []),
    });
    expect(src.prefetch?.sameLevelMarginTiles).toBe(64);
    expect(src.prefetch?.sameLevelMarginMinLevel).toBe(0);
    expect(src.prefetch?.criticalFinerLevel).toBe(17);
    expect(src.prefetch?.criticalFinerPrefetchLevels).toBe(3);
    expect(src.prefetch?.criticalFinerMaxCurrentLevel).toBe(21);
    expect(src.prefetch?.finerLookaheadWindowBp).toBe(256_000);
    expect(src.prefetch?.additionalCriticalFinerHandoffs).toEqual([
      {
        level: 3,
        prefetchLevels: 1,
        minCurrentLevel: 7,
        maxCurrentLevel: 9,
        lookaheadWindowBp: 32_000,
      },
      {
        level: 2,
        prefetchLevels: 1,
        minCurrentLevel: 7,
        maxCurrentLevel: 9,
        lookaheadWindowBp: 32_000,
      },
    ]);
  });

  it('caps bounded foreground coverage at the sidecar direct-scan ceiling', () => {
    const src = createAssemblyCoverageTileSource(
      file,
      {
        transport: recordingTransport(ok({ segments: [] }), []),
      },
      'bounded-foreground'
    );

    expect(src.levelRange).toEqual([0, 10]);
    expect(src.prefetch?.wholeGenomeResident).toBe(false);
    expect(src.prefetch?.coverageWorkingSetMarginTiles).toBe(0);
  });
});

describe('createAlignmentTileSource', () => {
  const file = { bamPath: '/data/HG002.bam', referencePath: '/data/GRCh38.fa' };

  it('hits /tiles/alignment and counts reads from the payload', async () => {
    const log: TileTransportRequest[] = [];
    const src = createAlignmentTileSource(file, {
      transport: recordingTransport(ok({ reads: [{}, {}, {}], count: 3, fine: true }), log),
    });
    const data = await src.fetchTile(0, 5103, [seg()], new AbortController().signal);
    expect(log[0].kind).toBe('alignment');
    expect(log[0].body).toMatchObject({ referencePath: '/data/GRCh38.fa' });
    expect(data.state).toBe('ready');
    expect(data.count).toBe(3);
    expect(data.byteSize).toBeGreaterThan(0);
  });

  it('sends an htsget runtime grant instead of file locators', async () => {
    const log: TileTransportRequest[] = [];
    const src = createAlignmentTileSource(
      {
        bamPath: 'htsget-runtime://identity/source.bam',
        htsget: {
          sourceToken: 'short-lived-runtime-token',
          sourceIdentity: 'e'.repeat(64),
          format: 'BAM',
        },
      },
      { transport: recordingTransport(ok({ reads: [], count: 0, fine: true }), log) }
    );

    await src.fetchTile(0, 5103, [seg('chr11')], new AbortController().signal);

    expect(log[0].body).toEqual({
      htsgetToken: 'short-lived-runtime-token',
      htsgetSourceIdentity: 'e'.repeat(64),
      htsgetFormat: 'BAM',
      chrom: 'chr11',
      chromGlobalStart: 0,
    });
    expect(log[0].body).not.toHaveProperty('bamPath');
    expect(log[0].body).not.toHaveProperty('indexPath');
  });

  it('sends the admitted source generation on aligned-read requests', async () => {
    const log: TileTransportRequest[] = [];
    const src = createAlignmentTileSource(
      { ...file, sourceGeneration },
      { transport: recordingTransport(ok({ reads: [], count: 0, fine: true }), log) }
    );

    await src.fetchTile(0, 5103, [seg()], new AbortController().signal);

    expect(log[0].body).toMatchObject({ sourceGeneration });
  });

  it('a fine tile with zero reads is ready/empty (count:0), not error', async () => {
    const src = createAlignmentTileSource(file, {
      transport: recordingTransport(ok({ reads: [], count: 0, fine: true }), []),
    });
    const data = await src.fetchTile(0, 5103, [seg()], new AbortController().signal);
    expect(data.state).toBe('ready');
    expect(data.count).toBe(0);
  });

  it('separates sidecar fine capability from production drawable-read levels', () => {
    const src = createAlignmentTileSource(file, {
      transport: recordingTransport(ok({ reads: [], count: 0, fine: true }), []),
    });
    expect(maxFineLevel()).toBe(8);
    expect(maxReadAlignmentLevel()).toBe(2);
    expect(maxAlternateGuideLevel()).toBe(3);
    expect(src.levelRange[0]).toBe(0);
    expect(src.levelRange[1]).toBe(3);
  });

  it('requests mutation columns without read rows at the first histogram level only', async () => {
    const log: TileTransportRequest[] = [];
    const src = createAlignmentTileSource(file, {
      transport: recordingTransport(
        ok({
          reads: [],
          alternateColumns: [{ pos: 37 }],
          count: 0,
          fine: true,
        }),
        log
      ),
    });

    const exact = await src.fetchTile(2, 7, [seg('chr1')], new AbortController().signal);
    const firstHistogram = await src.fetchTile(3, 7, [seg('chr1')], new AbortController().signal);

    expect(exact.state).toBe('ready');
    expect(log[0].body).not.toHaveProperty('guidesOnly');
    expect(firstHistogram.state).toBe('ready');
    expect(firstHistogram.count).toBe(1);
    expect(log[1].body).toMatchObject({ guidesOnly: true });
  });

  it('declares bounded alignment handoff and read-level side-pan prefetch', () => {
    const src = createAlignmentTileSource(file, {
      transport: recordingTransport(ok({ reads: [], count: 0, fine: true }), []),
    });
    expect(src.prefetch?.criticalFinerLevel).toBe(2);
    expect(src.prefetch?.criticalFinerPrefetchLevels).toBe(2);
    expect(src.prefetch?.criticalFinerMaxCurrentLevel).toBe(7);
    expect(src.prefetch?.finerLookaheadWindowBp).toBe(32_000);
    expect(src.prefetch?.sameLevelMarginTiles).toBe(16);
    expect(src.prefetch?.sameLevelMarginMinLevel).toBe(0);
  });

  it('keeps a bounded network alignment neighborhood for first paint', () => {
    const src = createAlignmentTileSource(
      file,
      {
        transport: recordingTransport(ok({ reads: [], count: 0, fine: true }), []),
      },
      'bounded-network'
    );

    expect(src.prefetch?.sameLevelMarginTiles).toBe(1);
    expect(src.prefetch?.criticalFinerLevel).toBe(2);
  });

  it('inherits the 404→error contract (CRAM missing reference — bug #3)', async () => {
    const src = createAlignmentTileSource(
      { bamPath: '/data/NA12718.cram' },
      {
        transport: recordingTransport(
          notFound('CRAM chr11 needs a reference FASTA to decode any slice'),
          []
        ),
      }
    );
    const data = await src.fetchTile(0, 5103, [seg()], new AbortController().signal);
    expect(data.state).toBe('error');
    expect(data.errorReason).toContain('reference');
  });
});

describe('createAnnotationTileSource', () => {
  const file = { gffPath: '/data/chr11.gff3.gz' };

  it('hits /tiles/annotation and builds {gffPath, chrom}', async () => {
    const log: TileTransportRequest[] = [];
    const src = createAnnotationTileSource(file, {
      transport: recordingTransport(
        ok({ format: 'vector', transcripts: [{}, {}], droppedCount: 0, fine: true }),
        log
      ),
    });
    const data = await src.fetchTile(2, 100, [seg('chr11')], new AbortController().signal);
    expect(log[0].kind).toBe('annotation');
    expect(log[0].body).toEqual({
      gffPath: '/data/chr11.gff3.gz',
      chrom: 'chr11',
      chromGlobalStart: 0,
    });
    expect(data.state).toBe('ready');
    expect(data.count).toBe(2);
  });

  it('a coarse raster tile counts the rasterized marks (markCount)', async () => {
    const src = createAnnotationTileSource(file, {
      transport: recordingTransport(
        ok({
          format: 'raster',
          transcripts: [],
          exonRaster: [0.1, 0.2],
          cdsRaster: [0.3],
          markCount: 17,
          droppedCount: 0,
          fine: false,
        }),
        []
      ),
    });
    const data = await src.fetchTile(15, 0, [seg()], new AbortController().signal);
    expect(data.state).toBe('ready');
    expect(data.count).toBe(17);
    expect(data.byteSize).toBeGreaterThan(0);
  });

  it('an empty annotation tile (no genes here) is ready/empty (count:0), not error', async () => {
    const src = createAnnotationTileSource(file, {
      transport: recordingTransport(
        ok({ format: 'vector', transcripts: [], droppedCount: 0, fine: true }),
        []
      ),
    });
    const data = await src.fetchTile(2, 100, [seg()], new AbortController().signal);
    expect(data.state).toBe('ready');
    expect(data.count).toBe(0);
  });

  it('inherits the 404→error contract (missing GFF source)', async () => {
    const src = createAnnotationTileSource(file, {
      transport: recordingTransport(notFound('AnnotationSourceNotFoundError: gff3 missing'), []),
    });
    const data = await src.fetchTile(2, 100, [seg()], new AbortController().signal);
    expect(data.state).toBe('error');
    expect(data.errorReason).toContain('AnnotationSourceNotFoundError');
  });
});
