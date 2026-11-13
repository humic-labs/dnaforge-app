import { userMessage } from '@waypoint/user-messages';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readVariantPage } from '../variant-client';
import { readRemoteVariantPage } from '../remote-variant-client';
import { readHtsgetVariantPage } from '../htsget-client';
import { admitTrackSource } from '../track-admission';
import {
  startVariantSourceOperation,
  waitForVariantSourceResult,
} from '../variant-source-operation-client';
import { useMutationNavigator } from './useMutationNavigator';

const { mockDialogOpen, mockGetFeatures } = vi.hoisted(() => ({
  mockDialogOpen: vi.fn(),
  mockGetFeatures: vi.fn(),
}));

vi.mock('../../../platform', () => ({
  platform: () => ({
    dialog: { open: mockDialogOpen },
    genome: { getFeatures: mockGetFeatures },
  }),
}));

vi.mock('../variant-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../variant-client')>()),
  readVariantPage: vi.fn(),
}));
vi.mock('../remote-variant-client', () => ({
  readRemoteVariantPage: vi.fn(),
}));
vi.mock('../htsget-client', () => ({
  readHtsgetVariantPage: vi.fn(),
}));
vi.mock('../track-admission', () => ({
  admitTrackSource: vi.fn(),
}));
vi.mock('../variant-source-operation-client', () => ({
  startVariantSourceOperation: vi.fn(),
  waitForVariantSourceResult: vi.fn(),
}));

const REFERENCES = [
  { name: 'chr1', length: 248_956_422 },
  { name: 'chr7', length: 159_345_973 },
];

const ANNOTATION_MANIFESTS = new Map([
  [
    'chr1',
    {
      chrom: 'chr1',
      fastaPath: '/reference/chr1.fa',
      faiPath: '/reference/chr1.fa.fai',
      gffPath: '/reference/chr1.gff3.gz',
      tbiPath: '/reference/chr1.gff3.gz.tbi',
      length: 248_956_422,
    },
  ],
]);

const PREPARED = {
  sourcePath: '/data/HG002.vcf.gz',
  queryPath: '/data/HG002.vcf.gz',
  indexPath: '/data/HG002.vcf.gz.tbi',
  format: 'vcf' as const,
  label: 'HG002.vcf.gz',
  sourceSizeBytes: 123,
  sourceMtimeNs: '456',
  sourceIdentity: 'a'.repeat(64),
  sourceGeneration: {
    canonicalPath: '/data/HG002.vcf.gz',
    size: 123,
    mtimeNs: '456',
    ctimeNs: '457',
    device: '10',
    inode: '11',
  },
  queryGeneration: {
    canonicalPath: '/data/HG002.vcf.gz',
    size: 123,
    mtimeNs: '456',
    ctimeNs: '457',
    device: '10',
    inode: '11',
  },
  indexGeneration: {
    canonicalPath: '/data/HG002.vcf.gz.tbi',
    size: 10,
    mtimeNs: '458',
    ctimeNs: '459',
    device: '10',
    inode: '12',
  },
  assemblyRevision: `variant-assembly-v1:sha256:${'b'.repeat(64)}`,
  matchedReferences: ['chr1', 'chr7'],
  samples: ['HG002'],
};

const FIRST_VARIANT = {
  id: 'call-1',
  recordId: 'rs1',
  chrom: 'chr1',
  start: 104_312_460,
  end: 104_312_461,
  position: 104_312_461,
  ref: 'T',
  alts: ['A'],
  quality: 60,
  filters: ['PASS'],
  variantClass: 'substitution' as const,
  genotypes: { HG002: '0/1' },
};

const REMOTE_REQUEST = {
  contract: 'dnaforge.track-admission-request.v1' as const,
  assemblyId: 'grch38',
  source: { kind: 'http' as const, url: 'https://variants.example.org/tumor.vcf.gz' },
  index: { kind: 'http' as const, url: 'https://variants.example.org/tumor.vcf.gz.tbi' },
  formatId: 'vcf',
  scientificKind: 'variants' as const,
  label: 'Tumor calls',
  ingress: { kind: 'url' as const },
};

const REMOTE_ADMITTED = {
  admissionVersion: 2 as const,
  request: REMOTE_REQUEST,
  admittedAt: '2026-09-21T21:00:00.000Z',
  uri: 'https://variants.example.org/tumor.vcf.gz',
  input: { kind: 'url' as const, url: 'https://variants.example.org/tumor.vcf.gz' },
  index: { kind: 'url' as const, url: 'https://variants.example.org/tumor.vcf.gz.tbi' },
  formatId: 'vcf',
  recommendedTypes: ['variant'],
  fingerprint: `sha256:${'c'.repeat(64)}`,
  readerKind: 'variant' as const,
  scientificKind: 'variants' as const,
  assemblyId: 'grch38',
  referenceReceipt: {
    assemblyId: 'grch38',
    referenceSignature: `sha256:${'d'.repeat(64)}`,
    sourceSignature: `sha256:${'e'.repeat(64)}`,
    contigMap: { chr1: 'chr1', chr7: 'chr7' },
    checkedContigs: 2,
    status: 'compatible' as const,
    checkedAt: '2026-09-21T21:00:00.000Z',
  },
  provenance: {
    provider: 'http',
    sourceKind: 'http',
    remoteUrl: 'https://variants.example.org/tumor.vcf.gz',
    label: 'Tumor calls',
  },
  expectedValidators: { contentLength: 12_345, etag: '"vcf-v1"' },
  indexExpectedValidators: { contentLength: 678, etag: '"tbi-v1"' },
};

function remoteRuntime(expiresAtMs = Date.now() + 1_800_000) {
  return {
    format: 'vcf' as const,
    sourceToken: 'opaque-vcf-token',
    indexToken: 'opaque-tbi-token',
    sourceIdentity: 'f'.repeat(64),
    assemblyRevision: `variant-assembly-v1:sha256:${'1'.repeat(64)}`,
    matchedReferences: ['chr1', 'chr7'],
    samples: ['tumor'],
    grantExpiresAtMs: expiresAtMs,
  };
}

const REMOTE_DURABLE = {
  sourcePath: REMOTE_ADMITTED.input.url,
  queryPath: REMOTE_ADMITTED.input.url,
  indexPath: REMOTE_ADMITTED.index.url,
  format: 'vcf' as const,
  label: 'Tumor calls',
  sourceSizeBytes: 12_345,
  sourceIdentity: 'f'.repeat(64),
  assemblyRevision: `variant-assembly-v1:sha256:${'1'.repeat(64)}`,
  admittedSource: REMOTE_ADMITTED,
  matchedReferences: ['chr1', 'chr7'],
  samples: ['tumor'],
  attachedAt: 1,
};

const HTSGET_REQUEST = {
  contract: 'dnaforge.track-admission-request.v1' as const,
  assemblyId: 'grch38',
  source: {
    kind: 'htsget' as const,
    endpoint: 'https://htsget.example.org',
    resourceId: 'tumor',
    dataClass: 'variants' as const,
    format: 'VCF' as const,
  },
  formatId: 'vcf',
  scientificKind: 'variants' as const,
  label: 'htsget tumor calls',
  ingress: { kind: 'url' as const },
};

const HTSGET_IDENTITY = '9'.repeat(64);
const HTSGET_ADMITTED = {
  admissionVersion: 2 as const,
  request: HTSGET_REQUEST,
  admittedAt: '2026-09-21T21:00:00.000Z',
  uri: `htsget:${HTSGET_IDENTITY}`,
  formatId: 'vcf',
  recommendedTypes: ['variant'],
  fingerprint: `sha256:${'7'.repeat(64)}`,
  readerKind: 'variant' as const,
  scientificKind: 'variants' as const,
  assemblyId: 'grch38',
  referenceReceipt: {
    assemblyId: 'grch38',
    referenceSignature: `sha256:${'d'.repeat(64)}`,
    sourceSignature: `sha256:${'e'.repeat(64)}`,
    contigMap: { chr1: 'chr1', chr7: 'chr7' },
    checkedContigs: 2,
    status: 'compatible' as const,
    checkedAt: '2026-09-21T21:00:00.000Z',
  },
  provenance: {
    provider: 'htsget',
    sourceKind: 'htsget',
    label: 'htsget tumor calls',
  },
};

function htsgetRuntime(expiresAtMs = Date.now() + 900_000) {
  return {
    kind: 'htsget' as const,
    dataClass: 'variants' as const,
    format: 'VCF' as const,
    sourceToken: 'opaque-htsget-token',
    sourceIdentity: HTSGET_IDENTITY,
    assemblyRevision: `variant-assembly-v1:sha256:${'6'.repeat(64)}`,
    references: REFERENCES,
    matchedReferences: ['chr1', 'chr7'],
    samples: ['tumor'],
    grantExpiresAtMs: expiresAtMs,
  };
}

const HTSGET_DURABLE = {
  sourcePath: `htsget-source://${HTSGET_IDENTITY}/source.vcf`,
  queryPath: `htsget-source://${HTSGET_IDENTITY}/source.vcf`,
  indexPath: `htsget-source://${HTSGET_IDENTITY}/regional-index`,
  format: 'vcf' as const,
  label: 'htsget tumor calls',
  sourceSizeBytes: 0,
  sourceIdentity: HTSGET_IDENTITY,
  assemblyRevision: `variant-assembly-v1:sha256:${'6'.repeat(64)}`,
  admittedSource: HTSGET_ADMITTED,
  matchedReferences: ['chr1', 'chr7'],
  samples: ['tumor'],
  attachedAt: 1,
};

describe('useMutationNavigator', () => {
  beforeEach(() => {
    mockDialogOpen.mockReset();
    mockGetFeatures.mockReset();
    mockGetFeatures.mockResolvedValue([]);
    vi.mocked(startVariantSourceOperation)
      .mockReset()
      .mockResolvedValue({ id: 'variant-operation-1' } as never);
    vi.mocked(waitForVariantSourceResult).mockReset().mockResolvedValue(PREPARED);
    vi.mocked(readVariantPage).mockReset();
    vi.mocked(readRemoteVariantPage).mockReset();
    vi.mocked(readHtsgetVariantPage).mockReset();
    vi.mocked(admitTrackSource)
      .mockReset()
      .mockImplementation(async (input) => {
        if (input.request.source.kind === 'local-file') {
          const request = {
            ...input.request,
            formatId: 'vcf',
            scientificKind: 'variants' as const,
          };
          input.onVariantRuntime?.({
            runtime: {
              kind: 'local',
              prepared: PREPARED,
              sourceIdentity: PREPARED.sourceIdentity,
              assemblyRevision: PREPARED.assemblyRevision,
              matchedReferences: PREPARED.matchedReferences,
              samples: PREPARED.samples,
            },
          });
          return {
            ...REMOTE_ADMITTED,
            request,
            uri: `file://${PREPARED.sourcePath}`,
            input: { kind: 'path' as const, path: PREPARED.sourcePath },
            index: undefined,
            fingerprint: `sha256:${'2'.repeat(64)}`,
            provenance: {
              provider: 'local-file',
              sourceKind: 'local-file',
              label: PREPARED.label,
            },
            expectedValidators: { contentLength: PREPARED.sourceSizeBytes },
            indexExpectedValidators: undefined,
          };
        }
        input.onVariantRuntime?.({ runtime: remoteRuntime() });
        return REMOTE_ADMITTED;
      });
  });

  it('uses the first Mutations click to choose, prepare, persist, and load a real source', async () => {
    mockDialogOpen.mockResolvedValue('/data/HG002.vcf.gz');
    vi.mocked(readVariantPage).mockResolvedValue({
      variants: [FIRST_VARIANT],
      nextCursor: 'next',
    });
    const onSourcePrepared = vi.fn();
    const { result } = renderHook(() =>
      useMutationNavigator({
        references: REFERENCES,
        annotationManifests: ANNOTATION_MANIFESTS,
        persistedSource: null,
        onSourcePrepared,
      })
    );

    await act(async () => result.current.openNavigator());

    expect(mockDialogOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        multiple: false,
        title: 'Open mutation calls',
      })
    );
    expect(startVariantSourceOperation).not.toHaveBeenCalled();
    expect(waitForVariantSourceResult).not.toHaveBeenCalled();
    expect(admitTrackSource).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          assemblyId: 'grch38',
          source: { kind: 'local-file', path: '/data/HG002.vcf.gz' },
          scientificKind: 'variants',
          ingress: { kind: 'file-picker' },
        }),
      })
    );
    expect(onSourcePrepared).toHaveBeenCalledWith(
      expect.objectContaining({
        ...PREPARED,
        admittedSource: expect.objectContaining({ readerKind: 'variant' }),
        attachedAt: expect.any(Number),
      })
    );
    expect(readVariantPage).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceGeneration: PREPARED.sourceGeneration,
        queryGeneration: PREPARED.queryGeneration,
        indexGeneration: PREPARED.indexGeneration,
        assemblyRevision: PREPARED.assemblyRevision,
      }),
      fetch,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(result.current.isOpen).toBe(true);
    expect(result.current.variants).toEqual([FIRST_VARIANT]);
    expect(result.current.nextCursor).toBe('next');
  });

  it('revalidates an attached source without reopening the chooser', async () => {
    vi.mocked(readVariantPage).mockResolvedValue({ variants: [FIRST_VARIANT], nextCursor: null });
    const { result } = renderHook(() =>
      useMutationNavigator({
        references: REFERENCES,
        annotationManifests: ANNOTATION_MANIFESTS,
        persistedSource: { ...PREPARED, attachedAt: 1 },
        onSourcePrepared: vi.fn(),
      })
    );

    await act(async () => result.current.openNavigator());

    expect(mockDialogOpen).not.toHaveBeenCalled();
    expect(startVariantSourceOperation).toHaveBeenCalledWith({
      variantPath: PREPARED.sourcePath,
      references: REFERENCES,
    });
    expect(result.current.variants).toHaveLength(1);
  });

  it('reopens an already loaded source without repeating preparation or page I/O', async () => {
    vi.mocked(readVariantPage).mockResolvedValue({ variants: [FIRST_VARIANT], nextCursor: null });
    const { result } = renderHook(() =>
      useMutationNavigator({
        references: REFERENCES,
        annotationManifests: ANNOTATION_MANIFESTS,
        persistedSource: { ...PREPARED, attachedAt: 1 },
        onSourcePrepared: vi.fn(),
      })
    );

    await act(async () => result.current.openNavigator());
    act(() => result.current.closeNavigator());
    await act(async () => result.current.openNavigator());

    expect(result.current.isOpen).toBe(true);
    expect(result.current.variants).toEqual([FIRST_VARIANT]);
    expect(startVariantSourceOperation).toHaveBeenCalledTimes(1);
    expect(waitForVariantSourceResult).toHaveBeenCalledTimes(1);
    expect(readVariantPage).toHaveBeenCalledTimes(1);
  });

  it('does not persist partial state when the chooser is canceled or preparation fails', async () => {
    const onSourcePrepared = vi.fn();
    mockDialogOpen.mockResolvedValueOnce(null).mockResolvedValueOnce('/data/bad.vcf');
    vi.mocked(admitTrackSource).mockRejectedValueOnce(new Error('wrong assembly'));
    const { result } = renderHook(() =>
      useMutationNavigator({
        references: REFERENCES,
        annotationManifests: ANNOTATION_MANIFESTS,
        persistedSource: null,
        onSourcePrepared,
      })
    );

    await act(async () => result.current.openNavigator());
    expect(onSourcePrepared).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();

    await act(async () => result.current.chooseSource());
    expect(onSourcePrepared).not.toHaveBeenCalled();
    expect(result.current.error).toBe(userMessage('variant.preparationFailed'));
  });

  it('appends a next page without duplicating an overlapping record', async () => {
    vi.mocked(readVariantPage)
      .mockResolvedValueOnce({ variants: [FIRST_VARIANT], nextCursor: 'next' })
      .mockResolvedValueOnce({
        variants: [
          FIRST_VARIANT,
          {
            ...FIRST_VARIANT,
            id: 'call-2',
            position: 104_312_462,
            start: 104_312_461,
            end: 104_312_462,
          },
        ],
        nextCursor: null,
      });
    const { result } = renderHook(() =>
      useMutationNavigator({
        references: REFERENCES,
        annotationManifests: ANNOTATION_MANIFESTS,
        persistedSource: { ...PREPARED, attachedAt: 1 },
        onSourcePrepared: vi.fn(),
      })
    );

    await act(async () => result.current.openNavigator());
    await act(async () => result.current.loadMore());

    expect(result.current.variants.map((variant) => variant.id)).toEqual(['call-1', 'call-2']);
    expect(result.current.nextCursor).toBeNull();
  });

  it('loads bounded reference-annotation impact outside VCF paging and caches it across reopen', async () => {
    vi.mocked(readVariantPage).mockResolvedValue({ variants: [FIRST_VARIANT], nextCursor: null });
    mockGetFeatures.mockResolvedValue([
      {
        chrom: 'chr1',
        source: 'DNAForge',
        type: 'CDS',
        start: FIRST_VARIANT.start,
        end: FIRST_VARIANT.end,
        score: null,
        strand: '+',
        phase: '0',
        attributes: { gene: ['TEST1'], protein_id: ['NP_TEST.1'] },
        raw: '',
      },
    ]);
    const { result } = renderHook(() =>
      useMutationNavigator({
        references: REFERENCES,
        annotationManifests: ANNOTATION_MANIFESTS,
        persistedSource: { ...PREPARED, attachedAt: 1 },
        onSourcePrepared: vi.fn(),
      })
    );

    await act(async () => result.current.openNavigator());
    await waitFor(() =>
      expect(result.current.annotationImpacts.get(FIRST_VARIANT.id)).toMatchObject({
        status: 'ready',
        impact: {
          overlapsCds: true,
          codingEffect: { label: 'CDS substitution' },
        },
      })
    );
    expect(mockGetFeatures).toHaveBeenCalledWith(
      ANNOTATION_MANIFESTS.get('chr1'),
      'chr1',
      104_000_000,
      105_000_000,
      1
    );

    act(() => result.current.closeNavigator());
    await act(async () => result.current.openNavigator());
    expect(mockGetFeatures).toHaveBeenCalledTimes(1);
  });

  it('finishes annotation context for both pages when Load more overlaps the first lookup', async () => {
    const firstFeatures = promiseWithResolvers<Awaited<ReturnType<typeof mockGetFeatures>>>();
    const secondVariant = {
      ...FIRST_VARIANT,
      id: 'call-2',
      position: 106_000_002,
      start: 106_000_001,
      end: 106_000_002,
    };
    vi.mocked(readVariantPage)
      .mockResolvedValueOnce({ variants: [FIRST_VARIANT], nextCursor: 'next' })
      .mockResolvedValueOnce({ variants: [secondVariant], nextCursor: null });
    mockGetFeatures.mockImplementationOnce(() => firstFeatures.promise).mockResolvedValueOnce([]);
    const { result } = renderHook(() =>
      useMutationNavigator({
        references: REFERENCES,
        annotationManifests: ANNOTATION_MANIFESTS,
        persistedSource: { ...PREPARED, attachedAt: 1 },
        onSourcePrepared: vi.fn(),
      })
    );

    await act(async () => result.current.openNavigator());
    await waitFor(() => expect(mockGetFeatures).toHaveBeenCalledTimes(1));
    await act(async () => result.current.loadMore());
    await waitFor(() => expect(mockGetFeatures).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(result.current.annotationImpacts.get(secondVariant.id)).toMatchObject({
        status: 'ready',
      })
    );

    firstFeatures.resolve([]);
    await waitFor(() =>
      expect(result.current.annotationImpacts.get(FIRST_VARIANT.id)).toMatchObject({
        status: 'ready',
      })
    );
  });

  it('attaches a remote VCF through unified admission and persists only durable source intent', async () => {
    vi.mocked(readRemoteVariantPage).mockResolvedValue({
      variants: [FIRST_VARIANT],
      nextCursor: 'remote-next',
    });
    const onSourcePrepared = vi.fn();
    const { result } = renderHook(() =>
      useMutationNavigator({
        references: REFERENCES,
        annotationManifests: ANNOTATION_MANIFESTS,
        persistedSource: null,
        onSourcePrepared,
      })
    );

    await act(async () => result.current.attachNetworkRequest(REMOTE_REQUEST));

    expect(admitTrackSource).toHaveBeenCalledWith(
      expect.objectContaining({
        request: REMOTE_REQUEST,
        assemblyId: 'grch38',
        assemblyReferences: REFERENCES,
        onVariantRuntime: expect.any(Function),
      })
    );
    expect(onSourcePrepared).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePath: REMOTE_ADMITTED.input.url,
        queryPath: REMOTE_ADMITTED.input.url,
        indexPath: REMOTE_ADMITTED.index.url,
        sourceIdentity: 'f'.repeat(64),
        admittedSource: REMOTE_ADMITTED,
      })
    );
    const serialized = JSON.stringify(onSourcePrepared.mock.calls[0]?.[0]);
    expect(serialized).not.toContain('opaque-vcf-token');
    expect(serialized).not.toContain('/external/range-proxy/');
    expect(result.current.isOpen).toBe(true);
    expect(result.current.variants).toEqual([FIRST_VARIANT]);
  });

  it('attaches htsget VCF through the same admission seam and persists no runtime grant', async () => {
    vi.mocked(admitTrackSource).mockImplementation(async (input) => {
      input.onVariantRuntime?.({ runtime: htsgetRuntime() });
      return HTSGET_ADMITTED;
    });
    vi.mocked(readHtsgetVariantPage).mockResolvedValue({
      variants: [FIRST_VARIANT],
      nextCursor: 'htsget-next',
    });
    const onSourcePrepared = vi.fn();
    const { result } = renderHook(() =>
      useMutationNavigator({
        references: REFERENCES,
        annotationManifests: ANNOTATION_MANIFESTS,
        persistedSource: null,
        onSourcePrepared,
      })
    );

    await act(async () => result.current.attachNetworkRequest(HTSGET_REQUEST));

    expect(onSourcePrepared).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePath: `htsget-source://${HTSGET_IDENTITY}/source.vcf`,
        queryPath: `htsget-source://${HTSGET_IDENTITY}/source.vcf`,
        indexPath: `htsget-source://${HTSGET_IDENTITY}/regional-index`,
        sourceSizeBytes: 0,
        sourceIdentity: HTSGET_IDENTITY,
        admittedSource: HTSGET_ADMITTED,
      })
    );
    expect(readHtsgetVariantPage).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime: expect.objectContaining({ sourceToken: 'opaque-htsget-token' }),
        references: REFERENCES,
        cursor: null,
        limit: 100,
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(readRemoteVariantPage).not.toHaveBeenCalled();
    const serialized = JSON.stringify(onSourcePrepared.mock.calls[0]?.[0]);
    expect(serialized).toContain('https://htsget.example.org');
    expect(serialized).toContain('tumor');
    expect(serialized).not.toContain('opaque-htsget-token');
    expect(result.current.variants).toEqual([FIRST_VARIANT]);
  });

  it('restores a remote source by issuing fresh grants before its first page', async () => {
    vi.mocked(readRemoteVariantPage).mockResolvedValue({
      variants: [FIRST_VARIANT],
      nextCursor: null,
    });
    const { result } = renderHook(() =>
      useMutationNavigator({
        references: REFERENCES,
        annotationManifests: ANNOTATION_MANIFESTS,
        persistedSource: REMOTE_DURABLE,
        onSourcePrepared: vi.fn(),
      })
    );

    await act(async () => result.current.openNavigator());

    expect(startVariantSourceOperation).not.toHaveBeenCalled();
    expect(admitTrackSource).toHaveBeenCalledOnce();
    expect(readRemoteVariantPage).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime: expect.objectContaining({ sourceToken: 'opaque-vcf-token' }),
        references: REFERENCES,
        cursor: null,
        limit: 100,
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('restores htsget from endpoint intent and issues a fresh regional grant before paging', async () => {
    vi.mocked(admitTrackSource).mockImplementation(async (input) => {
      input.onVariantRuntime?.({
        runtime: { ...htsgetRuntime(), sourceToken: 'fresh-htsget-token' },
      });
      return HTSGET_ADMITTED;
    });
    vi.mocked(readHtsgetVariantPage).mockResolvedValue({
      variants: [FIRST_VARIANT],
      nextCursor: null,
    });
    const { result } = renderHook(() =>
      useMutationNavigator({
        references: REFERENCES,
        annotationManifests: ANNOTATION_MANIFESTS,
        persistedSource: HTSGET_DURABLE,
        onSourcePrepared: vi.fn(),
      })
    );

    await act(async () => result.current.openNavigator());

    expect(startVariantSourceOperation).not.toHaveBeenCalled();
    expect(admitTrackSource).toHaveBeenCalledWith(
      expect.objectContaining({ request: HTSGET_REQUEST })
    );
    expect(readHtsgetVariantPage).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime: expect.objectContaining({ sourceToken: 'fresh-htsget-token' }),
        cursor: null,
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('refuses to page a restored source when its validator-bound identity changed', async () => {
    vi.mocked(admitTrackSource).mockImplementation(async (input) => {
      input.onVariantRuntime?.({
        runtime: { ...remoteRuntime(), sourceIdentity: '2'.repeat(64) },
      });
      return { ...REMOTE_ADMITTED, fingerprint: `sha256:${'3'.repeat(64)}` };
    });
    const { result } = renderHook(() =>
      useMutationNavigator({
        references: REFERENCES,
        annotationManifests: ANNOTATION_MANIFESTS,
        persistedSource: REMOTE_DURABLE,
        onSourcePrepared: vi.fn(),
      })
    );

    await act(async () => result.current.openNavigator());

    expect(readRemoteVariantPage).not.toHaveBeenCalled();
    expect(result.current.error).toBe(userMessage('variant.sourceChanged'));
  });

  it('refreshes a remote source grant before expiry while the navigator remains open', async () => {
    vi.useFakeTimers();
    try {
      let admissionCount = 0;
      vi.mocked(admitTrackSource).mockImplementation(async (input) => {
        admissionCount += 1;
        input.onVariantRuntime?.({
          runtime: remoteRuntime(Date.now() + (admissionCount === 1 ? 31_000 : 1_800_000)),
        });
        return REMOTE_ADMITTED;
      });
      vi.mocked(readRemoteVariantPage).mockResolvedValue({ variants: [], nextCursor: null });
      const { result } = renderHook(() =>
        useMutationNavigator({
          references: REFERENCES,
          annotationManifests: ANNOTATION_MANIFESTS,
          persistedSource: REMOTE_DURABLE,
          onSourcePrepared: vi.fn(),
        })
      );

      await act(async () => result.current.openNavigator());
      expect(admitTrackSource).toHaveBeenCalledOnce();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_100);
      });
      expect(admitTrackSource).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

function promiseWithResolvers<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}
