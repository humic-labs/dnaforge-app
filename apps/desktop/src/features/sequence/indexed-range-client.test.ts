import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

import {
  admitIndexedRangeSource,
  materializeIndexedRangeSource,
  nativeRangeProxyUrl,
} from './indexed-range-client';

vi.mock('../../services/sidecar-session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/sidecar-session')>()),
  resolveSidecarBaseUrl: vi.fn(async () => 'http://127.0.0.1:8000'),
  sidecarFetch: vi.fn(async (_url: string, init: RequestInit, fetchImpl: typeof fetch) =>
    fetchImpl(_url, init)
  ),
}));

describe('indexed range client', () => {
  beforeEach(() => vi.restoreAllMocks());

  it.each([500, 501, 1200])(
    'reopens source identities of %s characters within the service contract',
    async (length) => {
      const provenanceId = 'x'.repeat(length);
      const expected =
        length <= 500
          ? provenanceId
          : `indexed-source:${createHash('sha256').update(provenanceId).digest('hex')}`;
      const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body));
        expect(request.provenance_id).toBe(expected);
        expect(request.provenance_id.length).toBeLessThanOrEqual(500);
        return new Response(
          JSON.stringify({
            source_uri: 'https://tracks.example.org/signal.bw',
            source_token: 'token',
            canonical_url_hash: 'hash',
            byte_length: 1000,
            format: 'bigwig',
            expires_in_seconds: 1800,
            provenance_id: request.provenance_id,
          })
        );
      });
      const grant = await admitIndexedRangeSource(
        {
          source: { kind: 'url', url: 'https://tracks.example.org/signal.bw' },
          formatId: 'bigwig',
          provenanceId,
        },
        { fetchImpl: fetchImpl as typeof fetch }
      );
      expect(grant.provenanceId).toBe(expected);
    }
  );

  it.each([
    [404, false],
    [403, false],
    [422, false],
    [429, true],
    [503, true],
  ])(
    'preserves HTTP %s retryability when admission supplies its own message',
    async (status, retryable) => {
      await expect(
        admitIndexedRangeSource(
          {
            source: { kind: 'url', url: 'https://tracks.example.org/signal.bw' },
            formatId: 'bigwig',
            provenanceId: 'saved-signal',
          },
          {
            fetchImpl: vi.fn(
              async () => new Response(JSON.stringify({ detail: 'Source unavailable' }), { status })
            ) as typeof fetch,
          }
        )
      ).rejects.toMatchObject({ message: 'Source unavailable', retryable });
    }
  );

  it('normalizes a remote BAM grant and constructs an ephemeral native proxy URL', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('http://127.0.0.1:8000/external/indexed-tracks/admit');
      expect(JSON.parse(String(init?.body))).toEqual({
        source_kind: 'url',
        source: 'https://reads.example.org/run/sample.bam',
        format_id: 'bam',
        provenance_id: 'reads-source',
        granted_capabilities: ['external-fetch:annotation'],
      });
      return new Response(
        JSON.stringify({
          source_uri: 'https://reads.example.org/run/sample.bam',
          source_token: 'opaque-bam-token',
          canonical_url_hash: 'bam-url-hash',
          byte_length: 12_345,
          format: 'bam',
          etag: '"bam-v1"',
          expires_in_seconds: 1800,
          provenance_id: 'reads-source',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const grant = await admitIndexedRangeSource(
      {
        source: { kind: 'url', url: 'https://reads.example.org/run/sample.bam' },
        formatId: 'bam',
        provenanceId: 'reads-source',
      },
      { fetchImpl: fetchImpl as typeof fetch }
    );

    expect(grant).toMatchObject({
      format: 'bam',
      sourceToken: 'opaque-bam-token',
      byteLength: 12_345,
      etag: '"bam-v1"',
    });
    expect(nativeRangeProxyUrl(grant, 'sample.bam')).toBe(
      'http://dnaforge-source:opaque-bam-token@127.0.0.1:8000/external/range-proxy/source.bam'
    );
    expect(new URL(nativeRangeProxyUrl(grant, 'sample.bam')).pathname).not.toContain(
      grant.sourceToken
    );
  });

  it('refuses a proxy filename that does not preserve the admitted suffix', () => {
    expect(() =>
      nativeRangeProxyUrl(
        {
          baseUrl: 'http://127.0.0.1:8000',
          sourceUri: 'https://reads.example.org/sample.bam',
          sourceToken: 'opaque-bam-token',
          canonicalUrlHash: 'source-hash',
          format: 'bam',
          byteLength: 100,
          provenanceId: 'reads-source',
          expiresAtMs: Date.now() + 10_000,
        },
        'sample.cram'
      )
    ).toThrow('must end in .bam');
  });

  it('refuses to put native proxy credentials on a non-loopback endpoint', () => {
    expect(() =>
      nativeRangeProxyUrl(
        {
          baseUrl: 'https://api.example.org',
          sourceUri: 'https://reads.example.org/sample.bam',
          sourceToken: 'opaque-bam-token',
          canonicalUrlHash: 'source-hash',
          format: 'bam',
          byteLength: 100,
          provenanceId: 'reads-source',
          expiresAtMs: Date.now() + 10_000,
        },
        'sample.bam'
      )
    ).toThrow('require a loopback HTTP endpoint');
  });

  it('materializes a remote native index and cross-checks its admission identity', async () => {
    const grant = {
      baseUrl: 'http://127.0.0.1:8000',
      sourceUri: 'https://reads.example.org/sample.bam.bai',
      sourceToken: 'opaque-bai-token',
      canonicalUrlHash: 'b'.repeat(64),
      format: 'bai' as const,
      byteLength: 8_192,
      provenanceId: 'reads-index',
      expiresAtMs: Date.now() + 1_800_000,
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('http://127.0.0.1:8000/external/indexed-tracks/materialize');
      expect(JSON.parse(String(init?.body))).toEqual({ source_token: 'opaque-bai-token' });
      return new Response(
        JSON.stringify({
          source_path: '/tmp/dnaforge-remote-range-index.bai',
          representation_sha256: 'a'.repeat(64),
          canonical_url_hash: grant.canonicalUrlHash,
          format: 'bai',
          byte_length: grant.byteLength,
          expires_in_seconds: 1_700,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    await expect(
      materializeIndexedRangeSource(grant, { fetchImpl: fetchImpl as typeof fetch })
    ).resolves.toMatchObject({
      sourcePath: '/tmp/dnaforge-remote-range-index.bai',
      representationSha256: 'a'.repeat(64),
    });
  });
});
