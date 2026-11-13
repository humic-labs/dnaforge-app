import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CurrentAdmittedTrackSource } from '@waypoint/genome-data';

import { readAlignmentHeader } from './alignment-header-client';
import { openAlignedReadSource } from './aligned-read-source-session';
import { prepareHtsgetRuntime } from './htsget-client';
import {
  admitIndexedRangeSource,
  materializeIndexedRangeSource,
  nativeRangeProxyUrl,
} from './indexed-range-client';

const { statFile } = vi.hoisted(() => ({ statFile: vi.fn() }));

vi.mock('../../platform', () => ({
  platform: () => ({ fs: { stat: statFile } }),
}));

vi.mock('./alignment-header-client', async () => {
  const actual = await vi.importActual<typeof import('./alignment-header-client')>(
    './alignment-header-client'
  );
  return { ...actual, readAlignmentHeader: vi.fn() };
});

vi.mock('./indexed-range-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./indexed-range-client')>()),
  admitIndexedRangeSource: vi.fn(),
  materializeIndexedRangeSource: vi.fn(),
  nativeRangeProxyUrl: vi.fn(
    (grant: { sourceToken: string; format: string }) =>
      `http://dnaforge-source:${grant.sourceToken}@127.0.0.1:8000/external/range-proxy/source.${grant.format}`
  ),
}));
vi.mock('./htsget-client', () => ({ prepareHtsgetRuntime: vi.fn() }));

const REFERENCES = [{ name: 'chr1', length: 1_000 }] as const;

const REMOTE_SOURCE: CurrentAdmittedTrackSource = {
  admissionVersion: 2,
  request: {
    contract: 'dnaforge.track-admission-request.v1',
    assemblyId: 'grch38',
    source: { kind: 'http', url: 'https://reads.example.org/run/sample.bam' },
    index: { kind: 'http', url: 'https://reads.example.org/run/sample.bam.bai' },
    formatId: 'bam',
    scientificKind: 'reads',
    ingress: { kind: 'url' },
  },
  admittedAt: '2026-09-21T20:00:00.000Z',
  uri: 'https://reads.example.org/run/sample.bam',
  input: { kind: 'url', url: 'https://reads.example.org/run/sample.bam' },
  index: { kind: 'url', url: 'https://reads.example.org/run/sample.bam.bai' },
  formatId: 'bam',
  recommendedTypes: ['pileup'],
  fingerprint: `sha256:${'a'.repeat(64)}`,
  readerKind: 'bam',
  scientificKind: 'reads',
  assemblyId: 'grch38',
  referenceReceipt: {
    assemblyId: 'grch38',
    referenceSignature: `sha256:${'b'.repeat(64)}`,
    sourceSignature: `sha256:${'c'.repeat(64)}`,
    contigMap: { chr1: 'chr1' },
    checkedContigs: 1,
    status: 'compatible',
    checkedAt: '2026-09-21T20:00:00.000Z',
  },
  provenance: { provider: 'http', sourceKind: 'http', label: 'sample.bam' },
  expectedValidators: { contentLength: 10_000, etag: '"bam-v1"' },
  indexExpectedValidators: { contentLength: 500, etag: '"bai-v1"' },
  alignedReadIndexState: 'present',
};

const REMOTE_CRAM_SOURCE: CurrentAdmittedTrackSource = {
  ...REMOTE_SOURCE,
  request: {
    ...REMOTE_SOURCE.request,
    source: { kind: 'http', url: 'https://reads.example.org/run/sample.cram' },
    index: { kind: 'http', url: 'https://reads.example.org/run/sample.cram.crai' },
    reference: { kind: 'local-file', path: '/canonical/references/GRCh38.fa' },
    formatId: 'cram',
  },
  uri: 'https://reads.example.org/run/sample.cram',
  input: { kind: 'url', url: 'https://reads.example.org/run/sample.cram' },
  index: { kind: 'url', url: 'https://reads.example.org/run/sample.cram.crai' },
  reference: { kind: 'path', path: '/canonical/references/GRCh38.fa' },
  formatId: 'cram',
  expectedValidators: { contentLength: 500, etag: '"cram-v1"' },
  indexExpectedValidators: { contentLength: 500, etag: '"crai-v1"' },
  alignedReadReferenceGeneration: {
    contract: 'aligned-read-reference-generation.v1',
    reference: {
      canonicalPath: '/canonical/references/GRCh38.fa',
      size: 100,
      mtimeNs: '1000000',
      ctimeNs: '2000000',
      device: '42',
      inode: '1001',
    },
    referenceIndex: {
      canonicalPath: '/canonical/references/GRCh38.fa.fai',
      size: 20,
      mtimeNs: '1000000',
      ctimeNs: '2000000',
      device: '42',
      inode: '1002',
    },
  },
};

const HTSGET_SOURCE: CurrentAdmittedTrackSource = {
  ...REMOTE_SOURCE,
  request: {
    contract: 'dnaforge.track-admission-request.v1',
    assemblyId: 'grch38',
    source: {
      kind: 'htsget',
      endpoint: 'https://htsget.example.org',
      resourceId: 'sample',
      dataClass: 'reads',
      format: 'BAM',
    },
    formatId: 'bam',
    scientificKind: 'reads',
    ingress: { kind: 'url' },
  },
  uri: `htsget:${'e'.repeat(64)}`,
  input: undefined,
  index: undefined,
  provenance: { provider: 'htsget', sourceKind: 'htsget', label: 'sample' },
  expectedValidators: undefined,
  indexExpectedValidators: undefined,
};

describe('aligned-read source runtime session', () => {
  beforeEach(() => {
    statFile.mockReset().mockImplementation(async (path: string) => ({
      canonicalPath: path,
      size: path.endsWith('.fai') ? 20 : 100,
      isFile: true,
      isDirectory: false,
      mtime: 1,
      ctime: 2,
      mtimeNs: '1000000',
      ctimeNs: '2000000',
      device: '42',
      inode: path.endsWith('.fai') ? '1002' : '1001',
    }));
    vi.mocked(admitIndexedRangeSource)
      .mockReset()
      .mockImplementation(async ({ source, formatId, provenanceId }) => ({
        baseUrl: 'http://127.0.0.1:8000',
        sourceUri: source.kind === 'url' ? source.url : `file://${source.path}`,
        sourceToken: `fresh-${formatId}-token`,
        canonicalUrlHash: `${formatId}-hash`,
        format: formatId,
        byteLength: formatId === 'bam' ? 10_000 : 500,
        etag: `"${formatId}-v1"`,
        provenanceId,
        expiresAtMs: formatId === 'bam' ? 2_000_000 : 1_900_000,
      }));
    vi.mocked(materializeIndexedRangeSource)
      .mockReset()
      .mockImplementation(async (grant) => ({
        sourcePath: `/tmp/dnaforge-index.${grant.format}`,
        representationSha256: 'a'.repeat(64),
        expiresAtMs: grant.expiresAtMs,
      }));
    vi.mocked(nativeRangeProxyUrl).mockClear();
    vi.mocked(readAlignmentHeader)
      .mockReset()
      .mockResolvedValue({
        format: 'bam',
        isCram: false,
        referenceRequired: false,
        references: [{ name: 'chr1', length: 1_000, md5: null }],
        index: { state: 'present' },
      });
    vi.mocked(prepareHtsgetRuntime)
      .mockReset()
      .mockResolvedValue({
        kind: 'htsget',
        dataClass: 'reads',
        format: 'BAM',
        sourceToken: 'fresh-htsget-token',
        sourceIdentity: 'e'.repeat(64),
        assemblyRevision: `variant-assembly-v1:sha256:${'f'.repeat(64)}`,
        references: [...REFERENCES],
        matchedReferences: ['chr1'],
        samples: [],
        grantExpiresAtMs: 1_900_000,
      });
  });

  it('re-admits durable URLs and returns only runtime proxy paths to the pileup reader', async () => {
    const opened = await openAlignedReadSource({
      source: REMOTE_SOURCE,
      assemblyReferences: REFERENCES,
      assemblyDisplayName: 'GRCh38',
    });

    expect(opened).toEqual({
      source: {
        bamPath:
          'http://dnaforge-source:fresh-bam-token@127.0.0.1:8000/external/range-proxy/source.bam',
        indexPath: '/tmp/dnaforge-index.bai',
        grantExpiresAtMs: 1_900_000,
      },
      grantExpiresAtMs: 1_900_000,
    });
    expect(readAlignmentHeader).toHaveBeenCalledWith(opened.source);
    expect(JSON.stringify(REMOTE_SOURCE)).not.toContain('fresh-');
  });

  it('fails closed when the remote alignment generation changed', async () => {
    vi.mocked(admitIndexedRangeSource).mockImplementation(async ({ source, formatId }) => ({
      baseUrl: 'http://127.0.0.1:8000',
      sourceUri: source.kind === 'url' ? source.url : `file://${source.path}`,
      sourceToken: `fresh-${formatId}-token`,
      canonicalUrlHash: `${formatId}-hash`,
      format: formatId,
      byteLength: formatId === 'bam' ? 10_001 : 500,
      etag: `"${formatId}-v2"`,
      provenanceId: 'changed',
      expiresAtMs: 1_900_000,
    }));

    await expect(
      openAlignedReadSource({
        source: REMOTE_SOURCE,
        assemblyReferences: REFERENCES,
        assemblyDisplayName: 'GRCh38',
      })
    ).rejects.toThrow('changed since it was added');

    expect(readAlignmentHeader).not.toHaveBeenCalled();
  });

  it('revalidates the local FASTA generation before reopening remote CRAM', async () => {
    vi.mocked(readAlignmentHeader).mockResolvedValue({
      format: 'cram',
      isCram: true,
      referenceRequired: true,
      references: [{ name: 'chr1', length: 1_000, md5: null }],
      index: { state: 'present' },
    });

    const opened = await openAlignedReadSource({
      source: REMOTE_CRAM_SOURCE,
      assemblyReferences: REFERENCES,
      assemblyDisplayName: 'GRCh38',
    });

    expect(statFile.mock.calls.map(([path]) => path)).toEqual([
      '/canonical/references/GRCh38.fa',
      '/canonical/references/GRCh38.fa.fai',
    ]);
    expect(opened.source).toMatchObject({
      bamPath:
        'http://dnaforge-source:fresh-cram-token@127.0.0.1:8000/external/range-proxy/source.cram',
      indexPath: '/tmp/dnaforge-index.crai',
      referencePath: '/canonical/references/GRCh38.fa',
    });
  });

  it('fails closed before network re-admission when a remote CRAM reference changed', async () => {
    statFile.mockImplementation(async (path: string) => ({
      canonicalPath: path,
      size: path.endsWith('.fai') ? 21 : 101,
      isFile: true,
      isDirectory: false,
      mtime: 3,
      ctime: 4,
      mtimeNs: '3000000',
      ctimeNs: '4000000',
      device: '42',
      inode: path.endsWith('.fai') ? '2002' : '2001',
    }));

    await expect(
      openAlignedReadSource({
        source: REMOTE_CRAM_SOURCE,
        assemblyReferences: REFERENCES,
        assemblyDisplayName: 'GRCh38',
      })
    ).rejects.toThrow('local CRAM reference changed since this track was added');

    expect(admitIndexedRangeSource).not.toHaveBeenCalled();
  });

  it('re-admits htsget from its durable endpoint and returns a fresh regional grant', async () => {
    const opened = await openAlignedReadSource({
      source: HTSGET_SOURCE,
      assemblyReferences: REFERENCES,
      assemblyDisplayName: 'GRCh38',
    });

    expect(prepareHtsgetRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'https://htsget.example.org',
        resourceId: 'sample',
        dataClass: 'reads',
        format: 'BAM',
      }),
      { signal: undefined }
    );
    expect(opened).toEqual({
      source: {
        bamPath: `htsget-runtime://${'e'.repeat(64)}/source.bam`,
        htsget: {
          sourceToken: 'fresh-htsget-token',
          sourceIdentity: 'e'.repeat(64),
          format: 'BAM',
        },
        grantExpiresAtMs: 1_900_000,
      },
      grantExpiresAtMs: 1_900_000,
    });
    expect(JSON.stringify(HTSGET_SOURCE)).not.toContain('fresh-htsget-token');
  });

  it('fails closed when the htsget source identity changed on reopen', async () => {
    vi.mocked(prepareHtsgetRuntime).mockResolvedValue({
      kind: 'htsget',
      dataClass: 'reads',
      format: 'BAM',
      sourceToken: 'fresh-htsget-token',
      sourceIdentity: '9'.repeat(64),
      assemblyRevision: `variant-assembly-v1:sha256:${'f'.repeat(64)}`,
      references: [...REFERENCES],
      matchedReferences: ['chr1'],
      samples: [],
      grantExpiresAtMs: 1_900_000,
    });

    await expect(
      openAlignedReadSource({
        source: HTSGET_SOURCE,
        assemblyReferences: REFERENCES,
        assemblyDisplayName: 'GRCh38',
      })
    ).rejects.toThrow('changed since it was added');
  });
});
