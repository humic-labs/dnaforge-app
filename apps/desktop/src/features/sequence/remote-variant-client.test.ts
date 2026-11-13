import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  prepareRemoteVariantRuntime,
  readRemoteVariantPage,
  readRemoteVariantRegion,
} from './remote-variant-client';
import { VariantRequestError } from './variant-client';

const { resolveSidecarBaseUrl, sidecarFetch } = vi.hoisted(() => ({
  resolveSidecarBaseUrl: vi.fn(),
  sidecarFetch: vi.fn(),
}));

vi.mock('../../services/sidecar-session', () => ({
  resolveSidecarBaseUrl,
  sidecarFetch,
}));

const references = [{ name: 'chr1', length: 1_000 }];

function grant(format: 'vcf' | 'bcf' | 'tbi' | 'csi', token: string, expiresAtMs: number) {
  return {
    baseUrl: 'http://127.0.0.1:8059',
    sourceUri: `https://variants.example.org/sample.${format}`,
    sourceToken: token,
    canonicalUrlHash: `${format}-url-hash`,
    format,
    byteLength: 1_000,
    provenanceId: `test:${format}`,
    expiresAtMs,
  };
}

describe('remote variant client', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resolveSidecarBaseUrl.mockResolvedValue('http://127.0.0.1:8059/');
    sidecarFetch.mockImplementation(
      async (url: string, init: RequestInit, fetchImpl: typeof fetch) => fetchImpl(url, init)
    );
  });

  it('prepares opaque source and index grants without exposing either token in durable output', async () => {
    const now = Date.now();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('http://127.0.0.1:8059/external/indexed-variants/prepare');
      expect(JSON.parse(String(init?.body))).toEqual({
        source_token: 'opaque-vcf-token',
        index_token: 'opaque-tbi-token',
        references,
      });
      return new Response(
        JSON.stringify({
          format: 'vcf',
          source_identity: 'a'.repeat(64),
          assembly_revision: `variant-assembly-v1:sha256:${'b'.repeat(64)}`,
          matched_references: ['chr1'],
          samples: ['tumor'],
          expires_in_seconds: 1_200,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const runtime = await prepareRemoteVariantRuntime(
      {
        sourceGrant: grant('vcf', 'opaque-vcf-token', now + 1_800_000),
        indexGrant: grant('tbi', 'opaque-tbi-token', now + 1_500_000),
        references,
      },
      { fetchImpl: fetchImpl as typeof fetch }
    );

    expect(runtime).toMatchObject({
      format: 'vcf',
      sourceToken: 'opaque-vcf-token',
      indexToken: 'opaque-tbi-token',
      sourceIdentity: 'a'.repeat(64),
      matchedReferences: ['chr1'],
      samples: ['tumor'],
    });
    expect(runtime.grantExpiresAtMs).toBeLessThanOrEqual(now + 1_200_100);
  });

  it('reads one bounded page through the current authenticated sidecar', async () => {
    const runtime = {
      format: 'bcf' as const,
      sourceToken: 'opaque-bcf-token',
      indexToken: 'opaque-csi-token',
      sourceIdentity: 'a'.repeat(64),
      assemblyRevision: `variant-assembly-v1:sha256:${'b'.repeat(64)}`,
      matchedReferences: ['chr1'],
      samples: [],
      grantExpiresAtMs: Date.now() + 60_000,
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('http://127.0.0.1:8059/external/indexed-variants/page');
      expect(JSON.parse(String(init?.body))).toMatchObject({
        source_token: runtime.sourceToken,
        index_token: runtime.indexToken,
        source_identity: runtime.sourceIdentity,
        assembly_revision: runtime.assemblyRevision,
        references,
        cursor: null,
        limit: 100,
      });
      return new Response(
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
          nextCursor: null,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    await expect(
      readRemoteVariantPage(
        { runtime, references, cursor: null, limit: 100 },
        { fetchImpl: fetchImpl as typeof fetch }
      )
    ).resolves.toMatchObject({ variants: [{ id: 'call-1' }], nextCursor: null });
    expect(resolveSidecarBaseUrl).toHaveBeenCalledWith('remote-variant-navigation');
  });

  it('preserves the sidecar error code and refuses malformed payloads', async () => {
    const sourceGrant = grant('vcf', 'opaque-vcf-token', Date.now() + 60_000);
    const indexGrant = grant('tbi', 'opaque-tbi-token', Date.now() + 60_000);
    const changed = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            detail: { error: 'variant_source_changed', message: 'The ETag changed.' },
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } }
        )
    );

    const rejection = prepareRemoteVariantRuntime(
      { sourceGrant, indexGrant, references },
      { fetchImpl: changed as typeof fetch }
    );
    await expect(rejection).rejects.toMatchObject<Partial<VariantRequestError>>({
      code: 'variant_source_changed',
      status: 409,
      message: 'The ETag changed.',
    });

    const malformed = vi.fn(
      async () =>
        new Response(JSON.stringify({ format: 'vcf' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    await expect(
      prepareRemoteVariantRuntime(
        { sourceGrant, indexGrant, references },
        { fetchImpl: malformed as typeof fetch }
      )
    ).rejects.toThrow('invalid source_identity');
  });

  it('queries one explicit remote viewport region without cursor paging', async () => {
    const runtime = {
      format: 'vcf' as const,
      sourceToken: 'opaque-vcf-token',
      indexToken: 'opaque-tbi-token',
      sourceIdentity: 'a'.repeat(64),
      assemblyRevision: `variant-assembly-v1:sha256:${'b'.repeat(64)}`,
      matchedReferences: ['chr1'],
      samples: [],
      grantExpiresAtMs: Date.now() + 60_000,
    };
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        chrom: 'chr1',
        start: 90,
        end: 110,
        limit: 10_000,
      });
      return new Response(JSON.stringify({ variants: [], truncated: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    await expect(
      readRemoteVariantRegion(
        { runtime, references, chrom: 'chr1', start: 90, end: 110 },
        { fetchImpl: fetchImpl as typeof fetch }
      )
    ).resolves.toEqual({ variants: [], truncated: false });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      'http://127.0.0.1:8059/external/indexed-variants/region'
    );
  });
});
