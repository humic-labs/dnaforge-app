import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readHtsgetVariantRegion } from './htsget-client';

const { resolveSidecarBaseUrl, sidecarFetch } = vi.hoisted(() => ({
  resolveSidecarBaseUrl: vi.fn(),
  sidecarFetch: vi.fn(),
}));

vi.mock('../../services/sidecar-session', () => ({
  resolveSidecarBaseUrl,
  sidecarFetch,
}));

describe('htsget variant regional client', () => {
  beforeEach(() => {
    resolveSidecarBaseUrl.mockReset().mockResolvedValue('http://127.0.0.1:8059/');
    sidecarFetch
      .mockReset()
      .mockImplementation(async (url: string, init: RequestInit, fetchImpl: typeof fetch) =>
        fetchImpl(url, init)
      );
  });

  it('keeps the runtime token in the request boundary and returns a bounded region', async () => {
    const runtime = {
      kind: 'htsget' as const,
      dataClass: 'variants' as const,
      format: 'VCF' as const,
      sourceToken: 'opaque-htsget-token',
      sourceIdentity: 'a'.repeat(64),
      assemblyRevision: `variant-assembly-v1:sha256:${'b'.repeat(64)}`,
      references: [{ name: 'chr1', length: 1_000 }],
      matchedReferences: ['chr1'],
      samples: [],
      grantExpiresAtMs: Date.now() + 60_000,
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('http://127.0.0.1:8059/external/htsget/variants/region');
      expect(JSON.parse(String(init?.body))).toMatchObject({
        source_token: 'opaque-htsget-token',
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
      readHtsgetVariantRegion(
        {
          runtime,
          references: runtime.references,
          chrom: 'chr1',
          start: 90,
          end: 110,
        },
        { fetchImpl: fetchImpl as typeof fetch }
      )
    ).resolves.toEqual({ variants: [], truncated: false });
  });
});
