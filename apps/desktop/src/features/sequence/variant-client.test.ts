// @vitest-environment node

import type { VariantFileGeneration, VariantSourceResult } from '@waypoint/api-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveSidecarBaseUrl, startVariantSourceOperation, waitForVariantSourceResult } =
  vi.hoisted(() => ({
    resolveSidecarBaseUrl: vi.fn(),
    startVariantSourceOperation: vi.fn(),
    waitForVariantSourceResult: vi.fn(),
  }));

vi.mock('../../services/sidecar-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/sidecar-session')>();
  return { ...actual, resolveSidecarBaseUrl };
});
vi.mock('./variant-source-operation-client', () => ({
  startVariantSourceOperation,
  waitForVariantSourceResult,
}));

import {
  prepareVariantSource,
  readVariantPage,
  readVariantRegion,
  VariantRequestError,
} from './variant-client';

const SOURCE_GENERATION: VariantFileGeneration = {
  canonicalPath: '/data/HG002.vcf.gz',
  size: 123,
  mtimeNs: '456',
  ctimeNs: '457',
  device: '10',
  inode: '11',
};
const QUERY_GENERATION: VariantFileGeneration = {
  ...SOURCE_GENERATION,
  canonicalPath: '/cache/HG002.vcf.gz',
};
const INDEX_GENERATION: VariantFileGeneration = {
  ...SOURCE_GENERATION,
  canonicalPath: '/cache/HG002.vcf.gz.tbi',
};
const ASSEMBLY_REVISION = `variant-assembly-v1:sha256:${'b'.repeat(64)}`;
const PREPARED: VariantSourceResult = {
  sourcePath: SOURCE_GENERATION.canonicalPath,
  queryPath: QUERY_GENERATION.canonicalPath,
  indexPath: INDEX_GENERATION.canonicalPath,
  format: 'vcf',
  label: 'HG002.vcf.gz',
  sourceSizeBytes: SOURCE_GENERATION.size,
  sourceMtimeNs: SOURCE_GENERATION.mtimeNs,
  sourceIdentity: 'a'.repeat(64),
  sourceGeneration: SOURCE_GENERATION,
  queryGeneration: QUERY_GENERATION,
  indexGeneration: INDEX_GENERATION,
  assemblyRevision: ASSEMBLY_REVISION,
  matchedReferences: ['chr1', 'chr7'],
  samples: ['HG002'],
};

describe('variant client', () => {
  beforeEach(() => {
    resolveSidecarBaseUrl.mockReset().mockResolvedValue('http://127.0.0.1:8059/');
    startVariantSourceOperation.mockReset().mockResolvedValue({ id: 'variant-operation-1' });
    waitForVariantSourceResult.mockReset().mockResolvedValue(PREPARED);
  });

  it('uses the managed operation owner for compatibility callers', async () => {
    const controller = new AbortController();
    const request = {
      variantPath: '/data/HG002.vcf.gz',
      references: [
        { name: 'chr1', length: 248_956_422 },
        { name: 'chr7', length: 159_345_973 },
      ],
    };

    await expect(prepareVariantSource(request, { signal: controller.signal })).resolves.toEqual(
      PREPARED
    );

    expect(startVariantSourceOperation).toHaveBeenCalledExactlyOnceWith(request);
    expect(waitForVariantSourceResult).toHaveBeenCalledExactlyOnceWith('variant-operation-1', {
      signal: controller.signal,
    });
  });

  it('reads one bounded page against every admitted generation and preserves the cursor', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          variants: [
            {
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
              variantClass: 'substitution',
              genotypes: { HG002: '0/1' },
            },
          ],
          nextCursor: 'opaque-cursor',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const result = await readVariantPage(pageRequest(), fetchImpl);

    expect(result.nextCursor).toBe('opaque-cursor');
    expect(result.variants[0]).toMatchObject({
      chrom: 'chr1',
      position: 104_312_461,
      ref: 'T',
      alts: ['A'],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:8059/tiles/variants/page',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(pageRequest()),
      })
    );
  });

  it('preserves the stable source-change code from a rejected page', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          detail: { code: 'VARIANT_SOURCE_CHANGED', message: 'The source changed.' },
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const failure = await readVariantPage(pageRequest(), fetchImpl).catch((error) => error);

    expect(failure).toBeInstanceOf(VariantRequestError);
    expect(failure).toMatchObject({
      code: 'VARIANT_SOURCE_CHANGED',
      status: 409,
      message: 'The source changed.',
    });
  });

  it('reads a bounded regional snapshot for the viewport tile path', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          variants: [
            {
              id: 'call-1',
              recordId: 'rs1',
              chrom: 'chr1',
              start: 99,
              end: 100,
              position: 100,
              ref: 'A',
              alts: ['T'],
              quality: 60,
              filters: ['PASS'],
              variantClass: 'substitution',
              genotypes: {},
            },
          ],
          truncated: false,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    await expect(
      readVariantRegion(
        {
          queryPath: QUERY_GENERATION.canonicalPath,
          indexPath: INDEX_GENERATION.canonicalPath,
          sourceGeneration: SOURCE_GENERATION,
          queryGeneration: QUERY_GENERATION,
          indexGeneration: INDEX_GENERATION,
          assemblyRevision: ASSEMBLY_REVISION,
          chrom: 'chr1',
          start: 90,
          end: 110,
        },
        fetchImpl
      )
    ).resolves.toMatchObject({ variants: [{ id: 'call-1' }], truncated: false });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:8059/tiles/variants/region',
      expect.objectContaining({
        body: expect.stringContaining('"limit":10000'),
      })
    );
  });

  it('rejects malformed unbounded responses instead of admitting them', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ variants: new Array(201).fill({}), nextCursor: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(readVariantPage({ ...pageRequest(), limit: 200 }, fetchImpl)).rejects.toThrow(
      'invalid page'
    );
  });
});

function pageRequest() {
  return {
    queryPath: QUERY_GENERATION.canonicalPath,
    indexPath: INDEX_GENERATION.canonicalPath,
    references: ['chr1', 'chr7'],
    sourceGeneration: SOURCE_GENERATION,
    queryGeneration: QUERY_GENERATION,
    indexGeneration: INDEX_GENERATION,
    assemblyRevision: ASSEMBLY_REVISION,
    cursor: null,
    limit: 100,
  };
}
