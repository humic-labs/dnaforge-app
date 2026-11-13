import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { customFetch } from '@waypoint/api-client';
import {
  configureSidecarApiClient,
  sidecarFetchSequenceBytes,
  sidecarFetchSequenceUrlBytes,
} from './sidecar-client';

const BASE_URL = 'http://127.0.0.1:8004';

beforeEach(() => {
  vi.stubEnv('VITE_API_URL', BASE_URL);
  (globalThis as any).electronAPI = {};
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  delete (globalThis as any).electronAPI;
});

function mockFetchResponse(init: {
  ok?: boolean;
  status: number;
  json: unknown;
}): void {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: init.ok ?? (init.status >= 200 && init.status < 300),
    status: init.status,
    json: async () => init.json,
  } as Response);
}

describe('sidecarFetchSequenceBytes', () => {
  it('configures the runtime URL without renderer session authority', async () => {
    await configureSidecarApiClient('test.renderer-authority');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await customFetch('/health');

    const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get('X-DNAForge-Session')).toBeNull();
  });

  it('does not leak an AI-tool-specific token error into a later shared-client request', async () => {
    await configureSidecarApiClient('test.shared-provider');
    delete (globalThis as any).electronAPI;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ detail: 'missing session' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(customFetch('/health')).rejects.toMatchObject({ status: 401 });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    expect(headers.has('X-DNAForge-Session')).toBe(false);
  });

  it('POSTs to /external/sequence/bytes with the caller capability scope', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        provider: 'ncbi-nuccore',
        external_id: 'NC_000913.3',
        format: 'genbank',
        content: 'LOCUS NC_000913',
        content_sha256: 'c'.repeat(64),
        source_url: 'https://www.ncbi.nlm.nih.gov/nuccore/NC_000913.3',
        license: 'Public domain',
        attribution: 'NCBI',
        version_identifier: '3',
        metadata: { organism: 'Escherichia coli' },
      }),
    } as Response);

    const result = await sidecarFetchSequenceBytes(
      { externalId: 'nc_000913.3' },
      { grantedCapabilities: ['external-fetch:annotation', 'read-workspace'] }
    );

    expect(result).toMatchObject({
      provider: 'ncbi-nuccore',
      externalId: 'NC_000913.3',
      content: 'LOCUS NC_000913',
      contentSha256: 'c'.repeat(64),
      sourceUrl: 'https://www.ncbi.nlm.nih.gov/nuccore/NC_000913.3',
      metadata: { organism: 'Escherichia coli' },
    });
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/external/sequence/bytes`);
    expect((opts as RequestInit).method).toBe('POST');
    expect(new Headers((opts as RequestInit).headers).get('X-DNAForge-Session')).toBeNull();
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body).toMatchObject({
      provider: 'ncbi-nuccore',
      external_id: 'nc_000913.3',
      format: 'genbank',
      granted_capabilities: ['external-fetch:annotation', 'read-workspace'],
    });
  });

  it('uses the annotation capability for non-agent imports with no forwarded scope', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        provider: 'ncbi-nuccore',
        external_id: 'NC_000913.3',
        format: 'genbank',
        content: 'LOCUS NC_000913',
        content_sha256: 'c'.repeat(64),
      }),
    } as Response);

    await sidecarFetchSequenceBytes({ externalId: 'NC_000913.3' });

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.granted_capabilities).toEqual(['external-fetch:annotation']);
  });

  it('maps 422 to a recognizable-accession message', async () => {
    mockFetchResponse({ status: 422, json: { detail: { message: 'bad id' } } });
    await expect(sidecarFetchSequenceBytes({ externalId: 'bogus' })).rejects.toThrow(
      /not a recognized NCBI nucleotide accession/
    );
  });

  it('maps 413 / sequence_too_large to a too-large message', async () => {
    mockFetchResponse({
      status: 413,
      json: { detail: { failure_kind: 'sequence_too_large', max_bytes: 100000000 } },
    });
    await expect(sidecarFetchSequenceBytes({ externalId: 'NC_000001.11' })).rejects.toThrow(
      /too large to import/
    );
  });

  it('maps a provider_contract_error to a no-record message', async () => {
    mockFetchResponse({
      status: 502,
      json: { detail: { failure_kind: 'provider_contract_error', message: 'no record' } },
    });
    await expect(sidecarFetchSequenceBytes({ externalId: 'NC_999999.9' })).rejects.toThrow(
      /no usable record for NC_999999\.9/
    );
  });

  it('maps a rate_limited failure to a retry message', async () => {
    mockFetchResponse({
      status: 502,
      json: { detail: { failure_kind: 'rate_limited' } },
    });
    await expect(sidecarFetchSequenceBytes({ externalId: 'NC_000913.3' })).rejects.toThrow(
      /rate-limited/
    );
  });

  it('maps 503 / circuit_open to a temporarily-unavailable message', async () => {
    mockFetchResponse({
      status: 503,
      json: { detail: { failure_kind: 'circuit_open' } },
    });
    await expect(sidecarFetchSequenceBytes({ externalId: 'NC_000913.3' })).rejects.toThrow(
      /temporarily unavailable/
    );
  });

  it('maps 401/403 to a rejected-request message without parsing detail', async () => {
    mockFetchResponse({ status: 403, json: {} });
    await expect(sidecarFetchSequenceBytes({ externalId: 'NC_000913.3' })).rejects.toThrow(
      /rejected the NCBI import request/
    );
  });

  it('rejects when the body has no content', async () => {
    mockFetchResponse({
      status: 200,
      json: { provider: 'ncbi-nuccore', external_id: 'NC_000913.3', content: '' },
    });
    await expect(sidecarFetchSequenceBytes({ externalId: 'NC_000913.3' })).rejects.toThrow(
      /returned no record/
    );
  });

  it('rethrows AbortError untouched for cancellation', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(abortErr);
    await expect(sidecarFetchSequenceBytes({ externalId: 'NC_000913.3' })).rejects.toBe(abortErr);
  });

  it('wraps a network failure in a reach-the-sidecar message', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(sidecarFetchSequenceBytes({ externalId: 'NC_000913.3' })).rejects.toThrow(
      /Could not reach the sidecar/
    );
  });
});

describe('sidecarFetchSequenceUrlBytes', () => {
  it('uses the guarded URL route with caller scope and workspace context', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        provider: 'public-url',
        external_id: 'https://example.com/sequence.gb',
        format: 'auto',
        content: 'LOCUS remote',
        content_sha256: 'd'.repeat(64),
        source_url: 'https://example.com/sequence.gb',
        attribution: 'Source: example.com',
        metadata: {},
      }),
    } as Response);

    const result = await sidecarFetchSequenceUrlBytes(
      { url: 'https://example.com/sequence.gb', workspaceId: 'workspace-1' },
      { grantedCapabilities: ['external-fetch:annotation'] }
    );

    expect(result).toMatchObject({
      provider: 'public-url',
      externalId: 'https://example.com/sequence.gb',
      content: 'LOCUS remote',
      attribution: 'Source: example.com',
    });
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/external/sequence/url-bytes`);
    expect(JSON.parse((opts as RequestInit).body as string)).toEqual({
      url: 'https://example.com/sequence.gb',
      workspace_id: 'workspace-1',
      granted_capabilities: ['external-fetch:annotation'],
    });
  });

  it('surfaces the guarded-boundary reason and preserves cancellation', async () => {
    mockFetchResponse({
      status: 422,
      json: { detail: { message: 'The remote source must use a public host' } },
    });
    await expect(
      sidecarFetchSequenceUrlBytes({ url: 'http://127.0.0.1/sequence.gb' })
    ).rejects.toThrow(/must use a public host/);

    vi.restoreAllMocks();
    const abortError = Object.assign(new Error('stopped'), { name: 'AbortError' });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(abortError);
    await expect(
      sidecarFetchSequenceUrlBytes({ url: 'https://example.com/sequence.gb' })
    ).rejects.toBe(abortError);
  });
});
