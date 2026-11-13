import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readAlignmentHeader,
  requireExactAlignmentReferenceMatch,
} from './alignment-header-client';

const { resolveSidecarBaseUrl } = vi.hoisted(() => ({
  resolveSidecarBaseUrl: vi.fn(async () => 'http://127.0.0.1:8059'),
}));

vi.mock('../../services/sidecar-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/sidecar-session')>();
  return { ...actual, resolveSidecarBaseUrl };
});

const SOURCE = {
  bamPath: '/data/HG002.bam',
  indexPath: '/data/HG002.bam.bai',
  chroms: ['chr1', 'chr2'],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('readAlignmentHeader', () => {
  it('reads the admitted cluster header without using the local decoding service', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        format: 'bam',
        isCram: false,
        referenceRequired: false,
        references: [{ name: 'NC_000913.3', length: 4_641_652, md5: null }],
        index: { state: 'present' },
      })
    ) as unknown as typeof fetch;
    const tileBaseUrl = 'http://127.0.0.1:54000/v1/source/compute';
    await readAlignmentHeader(
      {
        bamPath: 'http://127.0.0.1:54000/v1/source/alignment.bam',
        indexPath: '/private/index.bai',
        remote: {
          locator: {
            contract: 'remote-alignment-locator.v1',
            endpointId: 'endpoint',
            target: 'cluster',
            alignmentPath: '/data/reads.bam',
          },
          tileBaseUrl,
        },
      },
      fetchImpl
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      `${tileBaseUrl}/tiles/alignment/header`,
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('passes the selected reference FASTA to CRAM validation', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        format: 'cram',
        isCram: true,
        referenceRequired: true,
        references: [{ name: 'chr1', length: 248_956_422, md5: null }],
        index: { state: 'present' },
      })
    ) as unknown as typeof fetch;

    await readAlignmentHeader(
      {
        bamPath: '/data/NA12718.final.cram',
        indexPath: '/data/NA12718.final.cram.crai',
        referencePath: '/references/GRCh38.fa',
      },
      fetchImpl
    );

    const [, init] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body))).toEqual({
      bamPath: '/data/NA12718.final.cram',
      indexPath: '/data/NA12718.final.cram.crai',
      referencePath: '/references/GRCh38.fa',
    });
  });

  it('uses only the runtime htsget grant for a protocol-backed header request', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        format: 'bam',
        isCram: false,
        referenceRequired: false,
        references: [{ name: 'chr1', length: 248_956_422, md5: null }],
        index: { state: 'present' },
      })
    ) as unknown as typeof fetch;

    await readAlignmentHeader(
      {
        bamPath: `htsget-runtime://${'e'.repeat(64)}/source.bam`,
        htsget: {
          sourceToken: 'short-lived-runtime-token',
          sourceIdentity: 'e'.repeat(64),
          format: 'BAM',
        },
      },
      fetchImpl
    );

    const [, init] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body))).toEqual({
      htsgetToken: 'short-lived-runtime-token',
      htsgetSourceIdentity: 'e'.repeat(64),
      htsgetFormat: 'BAM',
    });
  });
});

describe('requireExactAlignmentReferenceMatch', () => {
  const expectedReferences = [
    { name: 'chr1', length: 248_956_422 },
    { name: 'chr2', length: 242_193_529 },
  ];

  it('accepts an exact expected reference subset while allowing extra BAM contigs', () => {
    expect(() =>
      requireExactAlignmentReferenceMatch({
        alignmentReferences: [
          ...expectedReferences,
          { name: 'chrM', length: 16_569 },
          { name: 'chr1_KI270706v1_random', length: 175_055 },
        ],
        expectedReferences,
        genomeDisplayName: 'GRCh38',
      })
    ).not.toThrow();
  });

  it('rejects a chr-prefix alias instead of admitting a name downstream fetches cannot use', () => {
    expect(() =>
      requireExactAlignmentReferenceMatch({
        alignmentReferences: [
          { name: '1', length: 248_956_422 },
          { name: 'chr2', length: 242_193_529 },
        ],
        expectedReferences,
        genomeDisplayName: 'GRCh38',
      })
    ).toThrow(
      'BAM is incompatible with GRCh38: missing exact reference "chr1" (expected 248956422 bp); found alias-like reference "1", but aliases are not remapped.'
    );
  });

  it('rejects a same-name chromosome whose length identifies a different assembly', () => {
    expect(() =>
      requireExactAlignmentReferenceMatch({
        alignmentReferences: [
          { name: 'chr1', length: 249_250_621 },
          { name: 'chr2', length: 242_193_529 },
        ],
        expectedReferences,
        genomeDisplayName: 'GRCh38',
      })
    ).toThrow(
      'BAM is incompatible with GRCh38: reference "chr1" is 249250621 bp in the BAM, expected 248956422 bp.'
    );
  });

  it('reports every missing or wrong-length expected chromosome in one actionable error', () => {
    expect(() =>
      requireExactAlignmentReferenceMatch({
        alignmentReferences: [{ name: 'chr1', length: 249_250_621 }],
        expectedReferences,
        genomeDisplayName: 'GRCh38',
      })
    ).toThrow(
      'BAM is incompatible with GRCh38: reference "chr1" is 249250621 bp in the BAM, expected 248956422 bp; missing exact reference "chr2" (expected 242193529 bp).'
    );
  });

  it('refuses to claim compatibility without an expected reference dictionary', () => {
    expect(() =>
      requireExactAlignmentReferenceMatch({
        alignmentReferences: expectedReferences,
        expectedReferences: [],
        genomeDisplayName: 'GRCh38',
      })
    ).toThrow(
      'Cannot validate BAM compatibility with GRCh38: no expected references were provided.'
    );
  });

  it('rejects duplicate BAM reference identities rather than choosing one length', () => {
    expect(() =>
      requireExactAlignmentReferenceMatch({
        alignmentReferences: [
          { name: 'chr1', length: 248_956_422 },
          { name: 'chr1', length: 249_250_621 },
          { name: 'chr2', length: 242_193_529 },
        ],
        expectedReferences,
        genomeDisplayName: 'GRCh38',
      })
    ).toThrow('Cannot validate BAM compatibility with GRCh38: duplicate BAM reference "chr1".');
  });
});
