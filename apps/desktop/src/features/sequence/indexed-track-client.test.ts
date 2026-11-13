import { beforeEach, describe, expect, it, vi } from 'vitest';

import { admitIndexedTrack } from './indexed-track-client';

const { authorizeLocalIndexedTrack, rendererSidecarRequestAuthorityState } = vi.hoisted(() => ({
  authorizeLocalIndexedTrack: vi.fn(async ({ path }: { path: string }) => ({
    canonicalPath: path,
    authority: 'native-picker-proof',
  })),
  rendererSidecarRequestAuthorityState: vi.fn(async () => 'ready' as const),
}));

vi.mock('../../platform', () => ({
  platform: () => ({ dialog: { authorizeLocalIndexedTrack } }),
}));

vi.mock('../../services/sidecar-session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/sidecar-session')>()),
  resolveSidecarBaseUrl: vi.fn(async () => 'http://127.0.0.1:8000'),
  rendererSidecarRequestAuthorityState,
  sidecarFetch: vi.fn(async (_url: string, init: RequestInit, fetchImpl: typeof fetch) =>
    fetchImpl(_url, init)
  ),
}));

describe('admitIndexedTrack', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    rendererSidecarRequestAuthorityState.mockClear();
    authorizeLocalIndexedTrack.mockClear();
    rendererSidecarRequestAuthorityState.mockResolvedValue('ready');
  });

  it('sends the original local path and normalizes the opaque range grant', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        source_kind: 'path',
        source: '/analysis/output/signal.bigWig',
        local_path_authority: 'native-picker-proof',
        format_id: 'bigwig',
      });
      return new Response(
        JSON.stringify({
          source_uri: 'file:///analysis/output/signal.bigWig',
          source_token: 'opaque-token',
          canonical_url_hash: 'source-hash',
          byte_length: 4096,
          format: 'bigwig',
          etag: '"local-generation"',
          expires_in_seconds: 1800,
          provenance_id: 'local-1',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const grant = await admitIndexedTrack(
      {
        source: { kind: 'path', path: '/analysis/output/signal.bigWig' },
        formatId: 'bigwig',
        provenanceId: 'local-1',
      },
      { fetchImpl: fetchImpl as typeof fetch }
    );

    expect(grant).toMatchObject({
      sourceUri: 'file:///analysis/output/signal.bigWig',
      sourceToken: 'opaque-token',
      byteLength: 4096,
      provenanceId: 'local-1',
    });
    expect(authorizeLocalIndexedTrack).toHaveBeenCalledWith({
      path: '/analysis/output/signal.bigWig',
    });
  });

  it('marks a local path that belongs to an explicitly selected dev-scenario fixture', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            source_uri: 'file:///repo/apps/api/tests/fixtures/external/binary/signal.bw',
            source_token: 'opaque-token',
            canonical_url_hash: 'source-hash',
            byte_length: 4096,
            format: 'bigwig',
            expires_in_seconds: 1800,
            provenance_id: 'fixture-1',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    );

    await admitIndexedTrack(
      {
        source: {
          kind: 'path',
          path: '/repo/apps/api/tests/fixtures/external/binary/signal.bw',
        },
        formatId: 'bigwig',
        provenanceId: 'fixture-1',
      },
      { fetchImpl: fetchImpl as typeof fetch, localAuthorityContext: 'dev-scenario-fixture' }
    );

    expect(authorizeLocalIndexedTrack).toHaveBeenCalledWith({
      path: '/repo/apps/api/tests/fixtures/external/binary/signal.bw',
      devScenarioFixture: true,
    });
  });

  it('waits for a cold sidecar session before authorizing a local track', async () => {
    rendererSidecarRequestAuthorityState
      .mockResolvedValueOnce('pending')
      .mockResolvedValue('ready');
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            source_uri: 'file:///analysis/output/signal.bigWig',
            source_token: 'opaque-token',
            canonical_url_hash: 'source-hash',
            byte_length: 4096,
            format: 'bigwig',
            expires_in_seconds: 1800,
            provenance_id: 'cold-local',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    );

    await admitIndexedTrack(
      {
        source: { kind: 'path', path: '/analysis/output/signal.bigWig' },
        formatId: 'bigwig',
        provenanceId: 'cold-local',
      },
      { fetchImpl: fetchImpl as typeof fetch }
    );

    expect(rendererSidecarRequestAuthorityState).toHaveBeenCalledTimes(2);
    expect(authorizeLocalIndexedTrack).toHaveBeenCalledOnce();
  });

  it('surfaces a source-specific admission failure', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ detail: { message: 'The remote source does not support byte ranges' } }),
          { status: 422, headers: { 'Content-Type': 'application/json' } }
        )
    );

    await expect(
      admitIndexedTrack(
        {
          source: { kind: 'url', url: 'https://example.org/signal.bigWig' },
          formatId: 'bigwig',
          provenanceId: 'url-1',
        },
        { fetchImpl: fetchImpl as typeof fetch }
      )
    ).rejects.toThrow('does not support byte ranges');
  });
});
