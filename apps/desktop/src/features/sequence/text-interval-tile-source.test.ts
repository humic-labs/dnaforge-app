import { describe, expect, it, vi } from 'vitest';

import type { AdmittedTrackSource } from '@waypoint/genome-data';
import type { Assembly, AssemblySegment } from '@waypoint/genome-renderer';

import { createTextIntervalTileSource } from './text-interval-tile-source';
import type { TextIntervalSourceSession } from './text-interval-source-session';

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

function admitted(scientificKind: 'interval' | 'transcript'): AdmittedTrackSource {
  return {
    admissionVersion: 2,
    request: {
      contract: 'dnaforge.track-admission-request.v1',
      assemblyId: 'grch38',
      source: { kind: 'local-file', path: '/analysis/features.bed' },
      formatId: 'bed',
      scientificKind,
      ingress: { kind: 'file-picker' },
    },
    admittedAt: '2026-09-21T00:00:00.000Z',
    uri: 'file:///analysis/features.bed',
    input: { kind: 'path', path: '/analysis/features.bed' },
    formatId: 'bed',
    readerKind: 'interval-text',
    scientificKind,
    assemblyId: 'grch38',
    referenceReceipt: {
      assemblyId: 'grch38',
      referenceSignature: 'assembly-signature',
      sourceSignature: 'source-signature',
      contigMap: { chr1: '1' },
      checkedContigs: 1,
      status: 'compatible',
      checkedAt: '2026-09-21T00:00:00.000Z',
    },
    provenance: { provider: 'local-file', sourceKind: 'local-file', label: 'features.bed' },
    fingerprint: `bed:sha256:${'a'.repeat(64)}`,
    expectedValidators: { contentLength: 100 },
  };
}

function sessionReturning(result: unknown): TextIntervalSourceSession {
  return {
    execute: vi.fn(async (_signal, operation) =>
      operation({
        sourceKey: 'runtime-source',
        header: {
          formatId: 'bed',
          scientificKind: 'interval',
          referenceExtents: [{ name: '1', maxEnd: 200 }],
          recordCount: 1,
          sourceByteLength: 100,
          decodedByteLength: 100,
          contentSha256: `sha256:${'a'.repeat(64)}`,
        },
      })
    ),
    dispose: vi.fn(async () => undefined),
    queryResultForTest: result,
  } as TextIntervalSourceSession & { queryResultForTest: unknown };
}

describe('createTextIntervalTileSource', () => {
  it('queries source-local aliases and globalizes exact transcript structure', async () => {
    const query = vi.fn().mockResolvedValue([
      {
        kind: 'records',
        totalRecords: 1,
        records: [
          {
            chrom: '1',
            start: 110,
            end: 200,
            transcriptId: 'tx-1',
            strand: '+',
            exons: [
              { start: 110, end: 130 },
              { start: 170, end: 200 },
            ],
            cds: [{ start: 120, end: 190 }],
          },
        ],
      },
    ]);
    const session = sessionReturning(null);
    const tileSource = createTextIntervalTileSource({
      assembly,
      trackId: 'data:transcripts',
      source: admitted('transcript'),
      session,
      query,
    });

    const tile = await tileSource.fetchTile(0, 7, [segment], new AbortController().signal);

    expect(query).toHaveBeenCalledWith(
      'runtime-source',
      [{ refName: '1', start: 100, end: 220 }],
      { maxRecords: 20_000, maxOverlap: 32, densityBinCount: 256 },
      expect.any(AbortSignal)
    );
    expect(tile).toMatchObject({
      state: 'ready',
      count: 1,
      payload: {
        records: [
          {
            chrom: 'chr1',
            start: 5_110,
            end: 5_200,
            transcriptId: 'tx-1',
            exons: [
              { start: 5_110, end: 5_130 },
              { start: 5_170, end: 5_200 },
            ],
            cds: [{ start: 5_120, end: 5_190 }],
          },
        ],
      },
    });
  });

  it('materializes dense transcript bins as bounded valid transcript glyphs', async () => {
    const query = vi.fn().mockResolvedValue([
      {
        kind: 'density',
        totalRecords: 500,
        bins: [
          { start: 100, end: 110, count: 4 },
          { start: 110, end: 120, count: 64 },
        ],
      },
    ]);
    const tileSource = createTextIntervalTileSource({
      assembly,
      trackId: 'data:dense-transcripts',
      source: admitted('transcript'),
      session: sessionReturning(null),
      query,
    });

    const tile = await tileSource.fetchTile(0, 8, [segment], new AbortController().signal);
    if (tile.state !== 'ready' || !tile.payload || typeof tile.payload !== 'object') {
      throw new Error('expected ready tile');
    }
    const records = (tile.payload as { records: Array<Record<string, unknown>> }).records;

    expect(records.length).toBeGreaterThan(2);
    expect(records.length).toBeLessThanOrEqual(16);
    expect(records[0]).toMatchObject({
      chrom: 'chr1',
      start: 5_100,
      end: 5_110,
      strand: '+',
      exons: [{ start: 5_100, end: 5_110 }],
      cds: [],
      extra: { dnaforgeDensity: { count: 4, totalRecords: 500, maxCount: 64 } },
    });
  });
});
