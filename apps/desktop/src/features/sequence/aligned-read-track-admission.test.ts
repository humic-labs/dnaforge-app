import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TRACK_ADMISSION_REQUEST_V1, type TrackAdmissionRequestV1 } from '@waypoint/genome-data';

import { readAlignmentHeader } from './alignment-header-client';
import {
  startAlignmentIndexOperation,
  waitForAlignmentIndexResult,
} from './alignment-index-operation-client';
import { admitAlignedReadTrackRequest } from './aligned-read-track-admission';
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

vi.mock('./alignment-index-operation-client', () => ({
  startAlignmentIndexOperation: vi.fn(),
  waitForAlignmentIndexResult: vi.fn(),
}));

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

const references = [
  { name: 'chr1', length: 1_000 },
  { name: 'chr2', length: 2_000 },
];

function request(overrides: Partial<TrackAdmissionRequestV1> = {}): TrackAdmissionRequestV1 {
  return {
    contract: TRACK_ADMISSION_REQUEST_V1,
    assemblyId: 'grch38',
    source: { kind: 'local-file', path: '/analysis/reads.bam' },
    formatId: 'bam',
    scientificKind: 'reads',
    ingress: { kind: 'file-picker' },
    ...overrides,
  };
}

function readableHeader(format: 'bam' | 'cram' = 'bam') {
  return {
    format,
    isCram: format === 'cram',
    referenceRequired: format === 'cram',
    references: references.map((reference) => ({ ...reference, md5: null })),
    index: { state: 'present' as const },
  };
}

describe('aligned-read track admission', () => {
  beforeEach(() => {
    statFile.mockReset().mockImplementation(async (path: string) => ({
      canonicalPath: path.startsWith('/canonical') ? path : `/canonical${path}`,
      size: path.endsWith('.bai') ? 20 : 100,
      isFile: true,
      isDirectory: false,
      mtime: 1,
      ctime: 2,
      mtimeNs: '1000000',
      ctimeNs: '2000000',
      device: '42',
      inode: path.endsWith('.bai') ? '1002' : '1001',
    }));
    vi.mocked(startAlignmentIndexOperation)
      .mockReset()
      .mockResolvedValue({ id: 'alignment-index-job' } as never);
    vi.mocked(waitForAlignmentIndexResult).mockReset().mockResolvedValue({
      format: 'bam',
      state: 'created',
      indexPath: '/analysis/reads.bam.bai',
    });
    vi.mocked(readAlignmentHeader).mockReset().mockResolvedValue(readableHeader());
    vi.mocked(admitIndexedRangeSource)
      .mockReset()
      .mockImplementation(async ({ source, formatId, provenanceId }) => ({
        baseUrl: 'http://127.0.0.1:8000',
        sourceUri: source.kind === 'url' ? source.url : `file://${source.path}`,
        sourceToken: `opaque-${formatId}-token`,
        canonicalUrlHash: `${formatId}-url-hash`,
        format: formatId,
        byteLength: formatId === 'bam' ? 10_000 : 500,
        etag: `"${formatId}-v1"`,
        provenanceId,
        expiresAtMs: Date.now() + 1_800_000,
      }));
    vi.mocked(materializeIndexedRangeSource)
      .mockReset()
      .mockImplementation(async (grant) => ({
        sourcePath: `/tmp/dnaforge-index.${grant.format}`,
        representationSha256: 'a'.repeat(64),
        expiresAtMs: grant.expiresAtMs,
      }));
    vi.mocked(nativeRangeProxyUrl).mockClear();
    vi.mocked(prepareHtsgetRuntime)
      .mockReset()
      .mockResolvedValue({
        kind: 'htsget',
        dataClass: 'reads',
        format: 'BAM',
        sourceToken: 'opaque-htsget-token',
        sourceIdentity: 'e'.repeat(64),
        assemblyRevision: `variant-assembly-v1:sha256:${'f'.repeat(64)}`,
        references,
        matchedReferences: ['chr1', 'chr2'],
        samples: [],
        grantExpiresAtMs: Date.now() + 900_000,
      });
  });

  it('auto-indexes and returns one durable local BAM admission receipt', async () => {
    const onProgress = vi.fn();

    const source = await admitAlignedReadTrackRequest({
      request: request(),
      assemblyReferences: references,
      onProgress,
    });

    expect(startAlignmentIndexOperation).toHaveBeenCalledWith({
      bamPath: '/analysis/reads.bam',
    });
    expect(waitForAlignmentIndexResult).toHaveBeenCalledWith('alignment-index-job', {
      signal: undefined,
    });
    expect(readAlignmentHeader).toHaveBeenNthCalledWith(1, {
      bamPath: '/analysis/reads.bam',
      indexPath: '/analysis/reads.bam.bai',
    });
    expect(readAlignmentHeader).toHaveBeenNthCalledWith(2, {
      bamPath: '/canonical/analysis/reads.bam',
      indexPath: '/canonical/analysis/reads.bam.bai',
      generation: expect.objectContaining({
        contract: 'aligned-read-source-generation.v1',
      }),
    });
    expect(source).toMatchObject({
      admissionVersion: 2,
      formatId: 'bam',
      readerKind: 'bam',
      scientificKind: 'reads',
      input: { kind: 'path', path: '/canonical/analysis/reads.bam' },
      index: { kind: 'path', path: '/canonical/analysis/reads.bam.bai' },
      request: {
        source: { kind: 'local-file', path: '/canonical/analysis/reads.bam' },
        index: { kind: 'local-file', path: '/canonical/analysis/reads.bam.bai' },
        scientificKind: 'reads',
      },
      alignedReadGeneration: {
        contract: 'aligned-read-source-generation.v1',
        alignment: { canonicalPath: '/canonical/analysis/reads.bam' },
        index: { canonicalPath: '/canonical/analysis/reads.bam.bai' },
      },
      referenceReceipt: {
        assemblyId: 'grch38',
        contigMap: { chr1: 'chr1', chr2: 'chr2' },
        checkedContigs: 2,
        status: 'compatible',
      },
      provenance: {
        provider: 'local-file',
        sourceKind: 'local-file',
        label: 'reads.bam',
      },
      expectedValidators: { contentLength: 100 },
      alignedReadIndexState: 'created',
    });
    expect(source.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(onProgress.mock.calls.map(([progress]) => progress.phase)).toEqual([
      'checking-index',
      'validating-assembly',
    ]);
  });

  it('uses an explicit companion index without launching an index job', async () => {
    await admitAlignedReadTrackRequest({
      request: request({ index: { kind: 'local-file', path: '/indexes/reads.csi' } }),
      assemblyReferences: references,
    });

    expect(startAlignmentIndexOperation).not.toHaveBeenCalled();
    expect(readAlignmentHeader).toHaveBeenNthCalledWith(1, {
      bamPath: '/analysis/reads.bam',
      indexPath: '/indexes/reads.csi',
    });
  });

  it('requires an explicit indexed FASTA companion for local CRAM', async () => {
    vi.mocked(readAlignmentHeader).mockResolvedValue(readableHeader('cram'));
    vi.mocked(waitForAlignmentIndexResult).mockResolvedValue({
      format: 'cram',
      state: 'present',
      indexPath: '/analysis/reads.cram.crai',
    });
    await expect(
      admitAlignedReadTrackRequest({
        request: request({
          source: { kind: 'local-file', path: '/analysis/reads.cram' },
          formatId: 'cram',
        }),
        assemblyReferences: references,
      })
    ).rejects.toThrow('CRAM requires a matching indexed reference FASTA');

    expect(startAlignmentIndexOperation).toHaveBeenCalledOnce();
    expect(readAlignmentHeader).toHaveBeenCalledOnce();
  });

  it('does not issue a receipt when the alignment belongs to a different reference', async () => {
    vi.mocked(readAlignmentHeader).mockResolvedValue({
      ...readableHeader(),
      references: [
        { name: 'chr1', length: 999, md5: null },
        { name: 'chr2', length: 2_000, md5: null },
      ],
    });

    await expect(
      admitAlignedReadTrackRequest({
        request: request(),
        assemblyReferences: references,
      })
    ).rejects.toThrow('reference "chr1" is 999 bp');
  });

  it('admits remote BAM and index URLs without persisting either native proxy grant', async () => {
    const source = await admitAlignedReadTrackRequest({
      request: request({
        source: { kind: 'http', url: 'https://reads.example.org/run/sample.bam' },
        index: { kind: 'http', url: 'https://reads.example.org/run/sample.bam.bai' },
        ingress: { kind: 'url' },
      }),
      assemblyReferences: references,
    });

    expect(admitIndexedRangeSource).toHaveBeenNthCalledWith(
      1,
      {
        source: { kind: 'url', url: 'https://reads.example.org/run/sample.bam' },
        formatId: 'bam',
        provenanceId: expect.stringContaining('alignment:'),
      },
      { signal: undefined }
    );
    expect(admitIndexedRangeSource).toHaveBeenNthCalledWith(
      2,
      {
        source: { kind: 'url', url: 'https://reads.example.org/run/sample.bam.bai' },
        formatId: 'bai',
        provenanceId: expect.stringContaining('index:'),
      },
      { signal: undefined }
    );
    expect(readAlignmentHeader).toHaveBeenCalledWith({
      bamPath:
        'http://dnaforge-source:opaque-bam-token@127.0.0.1:8000/external/range-proxy/source.bam',
      indexPath: '/tmp/dnaforge-index.bai',
      grantExpiresAtMs: expect.any(Number),
    });
    expect(source).toMatchObject({
      input: { kind: 'url', url: 'https://reads.example.org/run/sample.bam' },
      index: { kind: 'url', url: 'https://reads.example.org/run/sample.bam.bai' },
      request: {
        source: { kind: 'http', url: 'https://reads.example.org/run/sample.bam' },
        index: { kind: 'http', url: 'https://reads.example.org/run/sample.bam.bai' },
      },
      expectedValidators: { contentLength: 10_000, etag: '"bam-v1"' },
      indexExpectedValidators: { contentLength: 500, etag: '"bai-v1"' },
      alignedReadIndexState: 'present',
      provenance: { provider: 'http', sourceKind: 'http' },
    });
    expect(source.alignedReadGeneration).toBeUndefined();
    expect(JSON.stringify(source)).not.toContain('opaque-');
    expect(JSON.stringify(source)).not.toContain('/external/range-proxy/');
  });

  it('requires an explicit remote index instead of guessing a neighboring URL', async () => {
    await expect(
      admitAlignedReadTrackRequest({
        request: request({
          source: { kind: 'http', url: 'https://reads.example.org/run/sample.bam' },
          ingress: { kind: 'url' },
        }),
        assemblyReferences: references,
      })
    ).rejects.toThrow('Remote BAM requires an explicit .bai or .csi index URL');

    expect(admitIndexedRangeSource).not.toHaveBeenCalled();
  });

  it('admits htsget BAM through a regional runtime without persisting its ticket grant', async () => {
    const onRuntimeReady = vi.fn();
    const source = await admitAlignedReadTrackRequest({
      request: request({
        source: {
          kind: 'htsget',
          endpoint: 'https://htsget.example.org',
          resourceId: 'sample',
          dataClass: 'reads',
          format: 'BAM',
        },
        formatId: 'bam',
        ingress: { kind: 'url' },
      }),
      assemblyReferences: references,
      onRuntimeReady,
    });

    expect(prepareHtsgetRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'https://htsget.example.org',
        resourceId: 'sample',
        dataClass: 'reads',
        format: 'BAM',
        references,
      }),
      { signal: undefined }
    );
    expect(onRuntimeReady).toHaveBeenCalledWith({
      source: expect.objectContaining({
        bamPath: `htsget-runtime://${'e'.repeat(64)}/source.bam`,
        htsget: {
          sourceToken: 'opaque-htsget-token',
          sourceIdentity: 'e'.repeat(64),
          format: 'BAM',
        },
      }),
      grantExpiresAtMs: expect.any(Number),
    });
    expect(source).toMatchObject({
      admissionVersion: 2,
      uri: `htsget:${'e'.repeat(64)}`,
      formatId: 'bam',
      readerKind: 'bam',
      scientificKind: 'reads',
      request: {
        source: {
          kind: 'htsget',
          endpoint: 'https://htsget.example.org',
          resourceId: 'sample',
        },
      },
      provenance: { provider: 'htsget', sourceKind: 'htsget' },
      alignedReadIndexState: 'present',
    });
    expect(source.input).toBeUndefined();
    expect(source.index).toBeUndefined();
    expect(JSON.stringify(source)).not.toContain('opaque-htsget-token');
  });

  it('binds remote CRAM to an exact canonical local FASTA and FAI generation', async () => {
    vi.mocked(readAlignmentHeader).mockResolvedValue(readableHeader('cram'));
    const onProgress = vi.fn();
    const resolveLocalCramReference = vi.fn().mockResolvedValue({
      kind: 'local-file' as const,
      path: '/references/GRCh38.fa',
    });

    const source = await admitAlignedReadTrackRequest({
      request: request({
        source: { kind: 'http', url: 'https://reads.example.org/run/sample.cram' },
        index: { kind: 'http', url: 'https://reads.example.org/run/sample.cram.crai' },
        formatId: 'cram',
        ingress: { kind: 'url' },
      }),
      assemblyReferences: references,
      resolveLocalCramReference,
      onProgress,
    });

    expect(resolveLocalCramReference).toHaveBeenCalledOnce();
    expect(statFile.mock.calls.map(([path]) => path)).toEqual([
      '/references/GRCh38.fa',
      '/canonical/references/GRCh38.fa.fai',
    ]);
    expect(readAlignmentHeader).toHaveBeenCalledWith({
      bamPath:
        'http://dnaforge-source:opaque-cram-token@127.0.0.1:8000/external/range-proxy/source.cram',
      indexPath: '/tmp/dnaforge-index.crai',
      referencePath: '/canonical/references/GRCh38.fa',
      grantExpiresAtMs: expect.any(Number),
    });
    expect(source).toMatchObject({
      formatId: 'cram',
      input: { kind: 'url', url: 'https://reads.example.org/run/sample.cram' },
      index: { kind: 'url', url: 'https://reads.example.org/run/sample.cram.crai' },
      reference: { kind: 'path', path: '/canonical/references/GRCh38.fa' },
      request: {
        reference: { kind: 'local-file', path: '/canonical/references/GRCh38.fa' },
      },
      alignedReadReferenceGeneration: {
        contract: 'aligned-read-reference-generation.v1',
        reference: { canonicalPath: '/canonical/references/GRCh38.fa' },
        referenceIndex: { canonicalPath: '/canonical/references/GRCh38.fa.fai' },
      },
    });
    expect(
      onProgress.mock.calls.map(([progress]) => [progress.phase, progress.stepNumber])
    ).toEqual([
      ['checking-index', 1],
      ['validating-reference', 2],
      ['validating-assembly', 3],
    ]);
    expect(JSON.stringify(source)).not.toContain('/external/range-proxy/');
  });
});
