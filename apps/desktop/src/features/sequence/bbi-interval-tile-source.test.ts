import { describe, expect, it, vi } from 'vitest';

import type { IndexedBbiTrackSource, UcscTrackSource } from '@waypoint/genome-data';
import type { Assembly, AssemblySegment } from '@waypoint/genome-renderer';

import { createBbiIntervalTileSource } from './bbi-interval-tile-source';

describe('createBbiIntervalTileSource', () => {
  it.each([
    { sourceContig: '1', sourceLength: 1_000, compatible: true },
    { sourceContig: 'NC_000001.11', sourceLength: 1_000, compatible: true },
    { sourceContig: 'NC_000001.11', sourceLength: 999, compatible: false },
  ])(
    'reopens a BigBed named $sourceContig ($sourceLength bp) using its admitted map',
    async ({ sourceContig, sourceLength, compatible }) => {
      const chromosome = { id: 'chr1', displayName: 'chr1', length: 1_000, cytobands: [] };
      const placement = {
        chromosome,
        globalStartBp: 5_000,
        globalEndBp: 6_000,
        order: 0,
      };
      const assembly: Assembly = {
        id: 'grch38',
        displayName: 'GRCh38',
        totalLengthBp: 6_000,
        chromosomes: [placement],
      };
      const segment: AssemblySegment = {
        chrom: 'chr1',
        localStart: 100,
        localEnd: 220,
        globalStart: 5_000,
        placement,
      };
      const source: IndexedBbiTrackSource = {
        admissionVersion: 1,
        uri: 'file:///analysis/transcripts.bb',
        input: { kind: 'path', path: '/analysis/transcripts.bb' },
        formatId: 'bigbed',
        readerKind: 'bbi',
        scientificKind: 'transcript',
        assemblyId: 'grch38',
        referenceReceipt: {
          assemblyId: 'grch38',
          referenceSignature: 'chr1',
          sourceSignature: 'chr1',
          contigMap: { chr1: sourceContig },
          checkedContigs: 1,
          status: 'compatible',
          checkedAt: '2026-09-21T00:00:00.000Z',
        },
        provenance: {
          provider: 'local-file',
          sourceKind: 'local-file',
          label: 'transcripts.bb',
        },
        fingerprint: 'bigbed-generation',
      };
      const reader = {
        open: vi.fn().mockResolvedValue({
          fileType: 'bigbed' as const,
          references: [{ name: sourceContig, length: sourceLength }],
          zoomReductionLevels: [],
          autoSql:
            'table genes\n(\nstring chrom;\nuint chromStart;\nuint chromEnd;\nstring name;\nuint score;\nchar[1] strand;\nuint thickStart;\nuint thickEnd;\nuint reserved;\nint blockCount;\nint[blockCount] blockSizes;\nint[blockCount] chromStarts;\nstring geneName;\n)',
        }),
        queryIntervals: vi.fn().mockResolvedValue([
          [
            {
              start: 110,
              end: 200,
              rest: 'tx1\t900\t+\t120\t190\t10,20,30\t2\t20,30,\t0,60,\tGENE1',
            },
          ],
        ]),
        closeSource: vi.fn().mockResolvedValue(undefined),
      };
      const admitIndexed = vi.fn().mockResolvedValue({
        baseUrl: 'http://127.0.0.1:8100',
        sourceUri: source.uri,
        sourceToken: 'opaque-token',
        canonicalUrlHash: 'hash',
        byteLength: 10_000,
        provenanceId: source.fingerprint,
        expiresAtMs: Date.now() + 60_000,
      });
      const tileSource = createBbiIntervalTileSource({
        assembly,
        trackId: 'data:transcripts',
        source,
        reader,
        admitIndexed,
      });

      const tile = await tileSource.fetchTile(0, 7, [segment], new AbortController().signal);

      if (!compatible) {
        expect(tile).toMatchObject({
          state: 'error',
          errorReason: 'BigBed reference mismatch for chr1: expected 1000, received 999.',
        });
        expect(reader.queryIntervals).not.toHaveBeenCalled();
        return;
      }

      expect(reader.queryIntervals).toHaveBeenCalledWith(
        expect.stringContaining(source.fingerprint),
        [{ refName: sourceContig, start: 100, end: 220 }],
        expect.any(AbortSignal)
      );
      expect(tile).toMatchObject({
        key: { level: 0, index: 7 },
        state: 'ready',
        count: 1,
        payload: {
          records: [
            {
              transcriptId: 'tx1',
              geneName: 'GENE1',
              start: 5_110,
              end: 5_200,
              exons: [
                { start: 5_110, end: 5_130 },
                { start: 5_170, end: 5_200 },
              ],
            },
          ],
        },
      });
    }
  );

  it('probes a UCSC hub with the assembly chromosome while reading the mapped BigBed contig', async () => {
    const chromosome = { id: 'chr1', displayName: 'chr1', length: 1_000, cytobands: [] };
    const placement = {
      chromosome,
      globalStartBp: 0,
      globalEndBp: 1_000,
      order: 0,
    };
    const assembly: Assembly = {
      id: 'grch38',
      displayName: 'GRCh38',
      totalLengthBp: 1_000,
      chromosomes: [placement],
    };
    const source: UcscTrackSource = {
      admissionVersion: 1,
      uri: 'https://example.org/hg38/genes.bb',
      formatId: 'bigbed',
      readerKind: 'bbi',
      scientificKind: 'interval',
      assemblyId: 'grch38',
      referenceReceipt: {
        assemblyId: 'grch38',
        referenceSignature: 'chr1',
        sourceSignature: '1',
        contigMap: { chr1: '1' },
        checkedContigs: 1,
        status: 'compatible',
        checkedAt: '2026-09-21T00:00:00.000Z',
      },
      provenance: {
        provider: 'ucsc',
        sourceKind: 'ucsc-hub',
        catalogId: 'hg38:hubGenes',
        ucscGenome: 'hg38',
        track: 'hubGenes',
        label: 'Example hub genes',
        hubUrl: 'https://example.org/hg38/hub.txt',
      },
      fingerprint: 'ucsc-hub\u0000hg38\u0000hubGenes',
    };
    const admit = vi.fn().mockResolvedValue({
      baseUrl: 'http://127.0.0.1:8099',
      sourceUri: source.uri,
      sourceToken: 'opaque-token',
      canonicalUrlHash: 'hash',
      byteLength: 28_195,
      provenanceId: source.fingerprint,
      expiresAtMs: Date.now() + 120_000,
    });
    const reader = {
      open: vi.fn().mockResolvedValue({
        fileType: 'bigbed' as const,
        references: [{ name: '1', length: 1_000 }],
        zoomReductionLevels: [],
      }),
      queryIntervals: vi.fn().mockResolvedValue([[]]),
      closeSource: vi.fn().mockResolvedValue(undefined),
    };
    const tileSource = createBbiIntervalTileSource({
      assembly,
      trackId: 'ucsc:hg38-hubGenes',
      source,
      reader,
      admit,
    });

    const tile = await tileSource.fetchTile(
      0,
      0,
      [
        {
          chrom: 'chr1',
          localStart: 100,
          localEnd: 220,
          globalStart: 100,
          placement,
        },
      ],
      new AbortController().signal
    );

    expect(admit).toHaveBeenCalledWith({
      genome: 'hg38',
      track: 'hubGenes',
      formatId: 'bigbed',
      probeChrom: 'chr1',
      hubUrl: 'https://example.org/hg38/hub.txt',
    });
    expect(reader.queryIntervals).toHaveBeenCalledWith(
      expect.stringContaining(source.fingerprint),
      [{ refName: '1', start: 100, end: 220 }],
      expect.any(AbortSignal)
    );
    expect(tile.state).toBe('ready');
  });
});
