import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TRACK_ADMISSION_REQUEST_V1, type TrackAdmissionRequestV1 } from '@waypoint/genome-data';

import { admitIndexedRangeSource } from './indexed-range-client';
import { prepareRemoteVariantRuntime } from './remote-variant-client';
import { prepareHtsgetRuntime } from './htsget-client';
import { clearPreparedVariantSources } from './prepared-variant-source-cache';
import { prepareVariantSource } from './variant-client';
import { admitVariantTrackRequest } from './variant-track-admission';

vi.mock('./indexed-range-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./indexed-range-client')>()),
  admitIndexedRangeSource: vi.fn(),
}));
vi.mock('./remote-variant-client', () => ({ prepareRemoteVariantRuntime: vi.fn() }));
vi.mock('./htsget-client', () => ({ prepareHtsgetRuntime: vi.fn() }));
vi.mock('./variant-client', () => ({ prepareVariantSource: vi.fn() }));

const references = [
  { name: 'chr1', length: 1_000 },
  { name: 'chr2', length: 2_000 },
];

function request(overrides: Partial<TrackAdmissionRequestV1> = {}): TrackAdmissionRequestV1 {
  return {
    contract: TRACK_ADMISSION_REQUEST_V1,
    assemblyId: 'grch38',
    source: { kind: 'http', url: 'https://variants.example.org/tumor.vcf.gz' },
    index: { kind: 'http', url: 'https://variants.example.org/tumor.vcf.gz.tbi' },
    formatId: 'vcf',
    scientificKind: 'variants',
    label: 'Tumor calls',
    ingress: { kind: 'url' },
    ...overrides,
  };
}

describe('remote variant track admission', () => {
  beforeEach(() => {
    clearPreparedVariantSources();
    vi.mocked(admitIndexedRangeSource)
      .mockReset()
      .mockImplementation(async ({ source, formatId, provenanceId }) => ({
        baseUrl: 'http://127.0.0.1:8059',
        sourceUri: source.kind === 'url' ? source.url : `file://${source.path}`,
        sourceToken: `opaque-${formatId}-token`,
        canonicalUrlHash: `${formatId}-url-hash`,
        format: formatId,
        byteLength: formatId === 'vcf' || formatId === 'bcf' ? 10_000 : 500,
        etag: `"${formatId}-v1"`,
        provenanceId,
        expiresAtMs: Date.now() + 1_800_000,
      }));
    vi.mocked(prepareRemoteVariantRuntime)
      .mockReset()
      .mockResolvedValue({
        format: 'vcf',
        sourceToken: 'opaque-vcf-token',
        indexToken: 'opaque-tbi-token',
        sourceIdentity: 'a'.repeat(64),
        assemblyRevision: `variant-assembly-v1:sha256:${'b'.repeat(64)}`,
        matchedReferences: ['chr1', 'chr2'],
        samples: ['tumor'],
        grantExpiresAtMs: Date.now() + 1_800_000,
      });
    vi.mocked(prepareHtsgetRuntime)
      .mockReset()
      .mockResolvedValue({
        kind: 'htsget',
        dataClass: 'variants',
        format: 'VCF',
        sourceToken: 'opaque-htsget-variant-token',
        sourceIdentity: 'e'.repeat(64),
        assemblyRevision: `variant-assembly-v1:sha256:${'f'.repeat(64)}`,
        references,
        matchedReferences: ['chr1', 'chr2'],
        samples: ['tumor'],
        grantExpiresAtMs: Date.now() + 900_000,
      });
    vi.mocked(prepareVariantSource)
      .mockReset()
      .mockResolvedValue({
        sourcePath: '/canonical/tumor.vcf.gz',
        queryPath: '/managed/tumor.vcf.gz',
        indexPath: '/managed/tumor.vcf.gz.tbi',
        format: 'vcf',
        label: 'tumor.vcf.gz',
        sourceSizeBytes: 10_000,
        sourceMtimeNs: '1000',
        sourceIdentity: '1'.repeat(64),
        sourceGeneration: {
          canonicalPath: '/canonical/tumor.vcf.gz',
          size: 10_000,
          mtimeNs: '1000',
          ctimeNs: '1001',
          device: '1',
          inode: '2',
        },
        queryGeneration: {
          canonicalPath: '/managed/tumor.vcf.gz',
          size: 10_000,
          mtimeNs: '1002',
          ctimeNs: '1003',
          device: '1',
          inode: '3',
        },
        indexGeneration: {
          canonicalPath: '/managed/tumor.vcf.gz.tbi',
          size: 500,
          mtimeNs: '1004',
          ctimeNs: '1005',
          device: '1',
          inode: '4',
        },
        assemblyRevision: `variant-assembly-v1:sha256:${'2'.repeat(64)}`,
        matchedReferences: ['chr1', 'chr2'],
        samples: ['tumor'],
      });
  });

  it('admits VCF plus TBI through two range grants and persists no native capability', async () => {
    const onRuntimeReady = vi.fn();
    const source = await admitVariantTrackRequest({
      request: request(),
      assemblyReferences: references,
      onRuntimeReady,
    });

    expect(admitIndexedRangeSource).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        source: { kind: 'url', url: 'https://variants.example.org/tumor.vcf.gz' },
        formatId: 'vcf',
      }),
      { signal: undefined }
    );
    expect(admitIndexedRangeSource).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        source: { kind: 'url', url: 'https://variants.example.org/tumor.vcf.gz.tbi' },
        formatId: 'tbi',
      }),
      { signal: undefined }
    );
    expect(source).toMatchObject({
      admissionVersion: 2,
      formatId: 'vcf',
      readerKind: 'variant',
      scientificKind: 'variants',
      input: { kind: 'url', url: 'https://variants.example.org/tumor.vcf.gz' },
      index: { kind: 'url', url: 'https://variants.example.org/tumor.vcf.gz.tbi' },
      expectedValidators: { contentLength: 10_000, etag: '"vcf-v1"' },
      indexExpectedValidators: { contentLength: 500, etag: '"tbi-v1"' },
      referenceReceipt: {
        assemblyId: 'grch38',
        contigMap: { chr1: 'chr1', chr2: 'chr2' },
        status: 'compatible',
      },
    });
    expect(source.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(onRuntimeReady).toHaveBeenCalledOnce();
    expect(JSON.stringify(source)).not.toContain('opaque-');
    expect(JSON.stringify(source)).not.toContain('/external/range-proxy/');
  });

  it('admits a file-picked VCF through the same durable request and runtime callback', async () => {
    const onRuntimeReady = vi.fn();
    const source = await admitVariantTrackRequest({
      request: request({
        source: { kind: 'local-file', path: '/selected/tumor.vcf.gz' },
        index: undefined,
        ingress: { kind: 'file-picker' },
      }),
      assemblyReferences: references,
      onRuntimeReady,
    });

    expect(prepareVariantSource).toHaveBeenCalledWith(
      { variantPath: '/selected/tumor.vcf.gz', references },
      { signal: undefined }
    );
    expect(source).toMatchObject({
      admissionVersion: 2,
      input: { kind: 'path', path: '/canonical/tumor.vcf.gz' },
      formatId: 'vcf',
      readerKind: 'variant',
      scientificKind: 'variants',
      provenance: { provider: 'local-file', sourceKind: 'local-file' },
      expectedValidators: { contentLength: 10_000 },
    });
    expect(onRuntimeReady).toHaveBeenCalledWith({
      runtime: expect.objectContaining({
        kind: 'local',
        sourceIdentity: '1'.repeat(64),
      }),
    });
  });

  it('reuses the managed preparation for the same file and references', async () => {
    const localRequest = request({
      source: { kind: 'local-file', path: '/selected/tumor.vcf.gz' },
      index: undefined,
      ingress: { kind: 'file-picker' },
    });
    const first = await admitVariantTrackRequest({
      request: localRequest,
      assemblyReferences: references,
    });
    const onRuntimeReady = vi.fn();
    const second = await admitVariantTrackRequest({
      request: localRequest,
      assemblyReferences: references,
      onRuntimeReady,
      reuseRememberedPreparation: true,
    });

    expect(prepareVariantSource).toHaveBeenCalledTimes(1);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(onRuntimeReady).toHaveBeenCalledWith({
      runtime: expect.objectContaining({ kind: 'local', sourceIdentity: '1'.repeat(64) }),
    });

    await admitVariantTrackRequest({
      request: localRequest,
      assemblyReferences: [
        { name: 'chr1', length: 1_000 },
        { name: 'chr2', length: 2_001 },
      ],
      reuseRememberedPreparation: true,
    });
    expect(prepareVariantSource).toHaveBeenCalledTimes(2);

    await admitVariantTrackRequest({ request: localRequest, assemblyReferences: references });
    expect(prepareVariantSource).toHaveBeenCalledTimes(3);
  });

  it('admits BCF only with CSI and preserves the BCF runtime format', async () => {
    vi.mocked(prepareRemoteVariantRuntime).mockResolvedValue({
      format: 'bcf',
      sourceToken: 'opaque-bcf-token',
      indexToken: 'opaque-csi-token',
      sourceIdentity: 'c'.repeat(64),
      assemblyRevision: `variant-assembly-v1:sha256:${'d'.repeat(64)}`,
      matchedReferences: ['chr1'],
      samples: [],
      grantExpiresAtMs: Date.now() + 1_800_000,
    });

    const source = await admitVariantTrackRequest({
      request: request({
        source: { kind: 'http', url: 'https://variants.example.org/tumor.bcf' },
        index: { kind: 'http', url: 'https://variants.example.org/tumor.bcf.csi' },
        formatId: 'bcf',
      }),
      assemblyReferences: references,
    });

    expect(source).toMatchObject({
      formatId: 'bcf',
      index: { url: expect.stringMatching(/\.csi$/u) },
    });
    expect(admitIndexedRangeSource).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ formatId: 'csi' }),
      { signal: undefined }
    );
  });

  it('requires an explicit compatible index before issuing any network grant', async () => {
    await expect(
      admitVariantTrackRequest({
        request: request({ index: undefined }),
        assemblyReferences: references,
      })
    ).rejects.toThrow('requires an explicit .tbi or .csi index URL');
    await expect(
      admitVariantTrackRequest({
        request: request({
          source: { kind: 'http', url: 'https://variants.example.org/tumor.bcf' },
          index: { kind: 'http', url: 'https://variants.example.org/tumor.bcf.tbi' },
          formatId: 'bcf',
        }),
        assemblyReferences: references,
      })
    ).rejects.toThrow('index URL must end in .csi');
    expect(admitIndexedRangeSource).not.toHaveBeenCalled();
  });

  it('rejects a fabricated reference receipt returned by the runtime', async () => {
    vi.mocked(prepareRemoteVariantRuntime).mockResolvedValue({
      format: 'vcf',
      sourceToken: 'opaque-vcf-token',
      indexToken: 'opaque-tbi-token',
      sourceIdentity: 'a'.repeat(64),
      assemblyRevision: `variant-assembly-v1:sha256:${'b'.repeat(64)}`,
      matchedReferences: ['chrUnknown'],
      samples: [],
      grantExpiresAtMs: Date.now() + 1_800_000,
    });

    await expect(
      admitVariantTrackRequest({ request: request(), assemblyReferences: references })
    ).rejects.toThrow('unknown reference chrUnknown');
  });

  it('admits htsget VCF without inventing or persisting a file index', async () => {
    const onRuntimeReady = vi.fn();
    const source = await admitVariantTrackRequest({
      request: request({
        source: {
          kind: 'htsget',
          endpoint: 'https://htsget.example.org',
          resourceId: 'cohort',
          dataClass: 'variants',
          format: 'VCF',
        },
        index: undefined,
        ingress: { kind: 'url' },
      }),
      assemblyReferences: references,
      onRuntimeReady,
    });

    expect(prepareHtsgetRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'https://htsget.example.org',
        resourceId: 'cohort',
        dataClass: 'variants',
        format: 'VCF',
        references,
      }),
      { signal: undefined }
    );
    expect(source).toMatchObject({
      uri: `htsget:${'e'.repeat(64)}`,
      formatId: 'vcf',
      readerKind: 'variant',
      scientificKind: 'variants',
      provenance: { provider: 'htsget', sourceKind: 'htsget' },
    });
    expect(source.input).toBeUndefined();
    expect(source.index).toBeUndefined();
    expect(onRuntimeReady).toHaveBeenCalledWith(
      expect.objectContaining({ runtime: expect.objectContaining({ kind: 'htsget' }) })
    );
    expect(JSON.stringify(source)).not.toContain('opaque-htsget-variant-token');
  });
});
