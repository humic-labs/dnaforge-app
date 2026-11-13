import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CurrentAdmittedTrackSource } from '@waypoint/genome-data';
import type { Assembly, AssemblySegment } from '@waypoint/genome-renderer';

import { readVariantRegion } from './variant-client';
import type { VariantSourceSession } from './variant-source-session';
import { createVariantTileSource } from './variant-tile-source';

vi.mock('./variant-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./variant-client')>();
  return { ...actual, readVariantRegion: vi.fn() };
});

const ASSEMBLY: Assembly = {
  id: 'test-assembly',
  displayName: 'Test assembly',
  totalLengthBp: 3_000,
  chromosomes: [
    {
      chromosome: { id: 'chr1', displayName: 'chr1', length: 1_000, cytobands: [] },
      globalStartBp: 0,
      globalEndBp: 1_000,
      order: 0,
    },
    {
      chromosome: { id: 'chr2', displayName: 'chr2', length: 2_000, cytobands: [] },
      globalStartBp: 1_000,
      globalEndBp: 3_000,
      order: 1,
    },
  ],
};

const SOURCE: CurrentAdmittedTrackSource = {
  admissionVersion: 2,
  request: {
    contract: 'dnaforge.track-admission-request.v1',
    assemblyId: 'test-assembly',
    source: { kind: 'local-file', path: '/data/calls.vcf.gz' },
    formatId: 'vcf',
    scientificKind: 'variants',
    ingress: { kind: 'file-picker' },
  },
  admittedAt: '2026-09-21T20:00:00.000Z',
  uri: 'file:///data/calls.vcf.gz',
  input: { kind: 'path', path: '/data/calls.vcf.gz' },
  formatId: 'vcf',
  recommendedTypes: ['variant'],
  fingerprint: `sha256:${'a'.repeat(64)}`,
  readerKind: 'variant',
  scientificKind: 'variants',
  assemblyId: 'test-assembly',
  referenceReceipt: {
    assemblyId: 'test-assembly',
    referenceSignature: `sha256:${'b'.repeat(64)}`,
    sourceSignature: `sha256:${'c'.repeat(64)}`,
    contigMap: { chr1: 'chr1', chr2: 'chr2' },
    checkedContigs: 2,
    status: 'compatible',
    checkedAt: '2026-09-21T20:00:00.000Z',
  },
  provenance: { provider: 'local-file', sourceKind: 'local-file', label: 'calls.vcf.gz' },
  expectedValidators: { contentLength: 1_000 },
};

const PREPARED = {
  sourcePath: '/data/calls.vcf.gz',
  queryPath: '/cache/calls.vcf.gz',
  indexPath: '/cache/calls.vcf.gz.tbi',
  format: 'vcf' as const,
  label: 'calls.vcf.gz',
  sourceSizeBytes: 1_000,
  sourceMtimeNs: '1',
  sourceIdentity: 'd'.repeat(64),
  sourceGeneration: generation('/data/calls.vcf.gz'),
  queryGeneration: generation('/cache/calls.vcf.gz'),
  indexGeneration: generation('/cache/calls.vcf.gz.tbi'),
  assemblyRevision: `variant-assembly-v1:sha256:${'e'.repeat(64)}`,
  matchedReferences: ['chr1', 'chr2'],
  samples: [],
};

describe('variant tile source', () => {
  beforeEach(() => vi.mocked(readVariantRegion).mockReset());

  it('queries chromosome-local bounds and publishes assembly-global variant records', async () => {
    vi.mocked(readVariantRegion).mockResolvedValue({
      variants: [
        {
          id: 'call-1',
          recordId: 'rs1',
          chrom: 'chr2',
          start: 9,
          end: 10,
          position: 10,
          ref: 'A',
          alts: ['T'],
          quality: 60,
          filters: ['PASS'],
          variantClass: 'substitution',
          genotypes: {},
        },
      ],
      truncated: false,
    });
    const session = localSession();
    const source = createVariantTileSource({
      assembly: ASSEMBLY,
      trackId: 'variant-track',
      source: SOURCE,
      session,
    });

    const tile = await source.fetchTile(
      0,
      1,
      [segmentFor(ASSEMBLY.chromosomes[1], 0, 100)],
      new AbortController().signal
    );

    expect(source.levelRange).toEqual([0, 12]);
    expect(readVariantRegion).toHaveBeenCalledWith(
      expect.objectContaining({ chrom: 'chr2', start: 0, end: 100, limit: 10_000 }),
      fetch,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(tile).toMatchObject({ state: 'ready', count: 1 });
    expect(
      (tile.payload as { records: Array<{ chrom: string; start: number; end: number }> }).records
    ).toEqual([expect.objectContaining({ chrom: 'chr2', start: 1_009, end: 1_010 })]);
  });

  it('turns a truncated source response into a visible zoom-in tile error', async () => {
    vi.mocked(readVariantRegion).mockResolvedValue({ variants: [], truncated: true });
    const source = createVariantTileSource({
      assembly: ASSEMBLY,
      trackId: 'variant-track',
      source: SOURCE,
      session: localSession(),
    });

    const tile = await source.fetchTile(
      4,
      0,
      [segmentFor(ASSEMBLY.chromosomes[0], 0, 1_000)],
      new AbortController().signal
    );

    expect(tile.state).toBe('error');
    expect(tile.errorReason).toContain('Zoom in');
    expect(tile.errorReason).toContain('10,000');
  });
});

function localSession(): VariantSourceSession {
  return {
    execute: async (_signal, query) =>
      query({
        kind: 'local',
        prepared: PREPARED,
        sourceIdentity: PREPARED.sourceIdentity,
        assemblyRevision: PREPARED.assemblyRevision,
        matchedReferences: PREPARED.matchedReferences,
        samples: PREPARED.samples,
      }),
    dispose: vi.fn(),
  };
}

function segmentFor(
  placement: Assembly['chromosomes'][number],
  localStart: number,
  localEnd: number
): AssemblySegment {
  return {
    chrom: placement.chromosome.id,
    localStart,
    localEnd,
    globalStart: placement.globalStartBp,
    placement,
  };
}

function generation(path: string) {
  return {
    canonicalPath: path,
    size: 1_000,
    mtimeNs: '1',
    ctimeNs: '2',
    device: '3',
    inode: '4',
  };
}
