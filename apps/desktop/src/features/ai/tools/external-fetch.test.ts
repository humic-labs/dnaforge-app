import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { externalFetchOutputSchema, externalFetchSchema, externalFetchTool as uncheckedexternalFetchTool } from './external-fetch';
import { execTool } from './test-helpers';

const realFetch = globalThis.fetch;
const TEST_ENV_API_URL = 'http://127.0.0.1:8122';
const TEST_RUNTIME_SIDECAR_URL = 'http://127.0.0.1:8123';

beforeEach(() => {
                                                              
                                                                           
                                                                           
  vi.stubEnv('VITE_API_URL', TEST_ENV_API_URL);
  (globalThis as any).electronAPI = {};
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as any).electronAPI;
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('external.fetch input schema', () => {
  it('rejects missing required fields', () => {
    expect(externalFetchSchema.safeParse({}).success).toBe(false);
    expect(externalFetchSchema.safeParse({ provider: 'uniprot' }).success).toBe(false);
  });

  it('accepts a minimal valid payload', () => {
    const result = externalFetchSchema.safeParse({
      provider: 'uniprot',
      external_id: 'P00875',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a full payload with workspace_id + bind_to', () => {
    const result = externalFetchSchema.safeParse({
      provider: 'uniprot',
      external_id: 'P00875',
      workspace_id: 'ws-a',
      bind_to: {
        source_kind: 'sequence',
        source_uri: 'waypoint://sequence/foo.gb',
        relationship: 'derived_from',
        evidence: 'asserted',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid bind_to.evidence', () => {
    const result = externalFetchSchema.safeParse({
      provider: 'uniprot',
      external_id: 'P00875',
      bind_to: {
        source_kind: 'sequence',
        source_uri: 'foo.gb',
        relationship: 'derived_from',
        evidence: 'something_invented',
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects undeclared top-level and nested model-controlled fields', () => {
    expect(
      externalFetchSchema.safeParse({
        provider: 'uniprot',
        external_id: 'P00875',
        granted_capabilities: ['external-fetch:xref-resolution'],
      }).success
    ).toBe(false);
    expect(
      externalFetchSchema.safeParse({
        provider: 'uniprot',
        external_id: 'P00875',
        bind_to: {
          source_kind: 'sequence',
          source_uri: 'foo.gb',
          relationship: 'derived_from',
          evidence: 'asserted',
          extra: 'not allowed',
        },
      }).success
    ).toBe(false);
  });
});

describe('external.fetch handler', () => {
  it('POSTs to /external/fetch on the configured sidecar URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          external_resource_id: 'res-1', provider: 'uniprot', external_id: 'P00875', cache_hit: false, license: 'CC-BY-4.0', attribution: null, metadata: {}, xref_count: 5,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await execTool<{ ok: boolean; external_resource_id?: string }>(externalFetchTool, {
      provider: 'uniprot',
      external_id: 'P00875',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${TEST_ENV_API_URL}/external/fetch`);
    expect(init?.method).toBe('POST');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.provider).toBe('uniprot');
    expect(body.external_id).toBe('P00875');
    expect(body.granted_capabilities).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.external_resource_id).toBe('res-1');
  });

  it('uses Electron main-process runtime API URL instead of the Vite-baked URL', async () => {
    const getApiUrl = vi.fn(async () => TEST_RUNTIME_SIDECAR_URL);
    (globalThis as any).electronAPI = {
      config: { getApiUrl },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ external_resource_id: 'res-runtime', provider: 'uniprot', external_id: 'P00875', cache_hit: true, license: null, attribution: null, metadata: {}, xref_count: 0 }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await execTool(externalFetchTool, { provider: 'uniprot', external_id: 'P00875' });

    expect(getApiUrl).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${TEST_RUNTIME_SIDECAR_URL}/external/fetch`);
  });

  it('derives granted capabilities from the renderer bridge context, not model input', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ external_resource_id: 'res-1', provider: 'uniprot', external_id: 'P00875', cache_hit: false, license: null, attribution: null, metadata: {}, xref_count: 0 }), { status: 200 })
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await execTool(
      externalFetchTool,
      {
        provider: 'uniprot',
        external_id: 'P00875',
        granted_capabilities: ['external-fetch:xref-resolution'],
      },
      {
        toolCallId: 'action-abc-123',
        messages: [],
        abortSignal: undefined as any,
        grantedCapabilities: ['external-fetch:annotation'],
      }
    );

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.granted_capabilities).toEqual(['external-fetch:annotation']);
  });

  it('forwards workspace_id + bind_to in the request body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ external_resource_id: 'res-1', provider: 'uniprot', external_id: 'P00875', cache_hit: false, license: null, attribution: null, metadata: {}, xref_count: 0 }), { status: 200 })
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await execTool(externalFetchTool, {
      provider: 'uniprot',
      external_id: 'P00875',
      workspace_id: 'ws-a',
      bind_to: {
        source_kind: 'sequence',
        source_uri: 'foo.gb',
        relationship: 'derived_from',
        evidence: 'asserted',
      },
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.workspace_id).toBe('ws-a');
    expect(body.bind_to).toEqual({
      source_kind: 'sequence',
      source_uri: 'foo.gb',
      relationship: 'derived_from',
      evidence: 'asserted',
    });
  });

  it('forwards toolCallId as X-DNAForge-Action-Id header', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ external_resource_id: 'res-1', provider: 'uniprot', external_id: 'P00875', cache_hit: false, license: null, attribution: null, metadata: {}, xref_count: 0 }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await execTool(
      externalFetchTool,
      { provider: 'uniprot', external_id: 'P00875' },
      { toolCallId: 'action-abc-123', messages: [], abortSignal: undefined as any }
    );

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('X-DNAForge-Action-Id')).toBe('action-abc-123');
  });

  it('does not expose the sidecar session token to renderer requests', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ external_resource_id: 'res-1', provider: 'uniprot', external_id: 'P00875', cache_hit: false, license: null, attribution: null, metadata: {}, xref_count: 0 }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await execTool(externalFetchTool, { provider: 'uniprot', external_id: 'P00875' });

    const headers = new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get('X-DNAForge-Session')).toBeNull();
  });

  it('does not require a renderer-visible session token', async () => {
    delete (globalThis as any).electronAPI;
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ external_resource_id: 'res-1', provider: 'uniprot', external_id: 'P00875', cache_hit: false, license: null, attribution: null, metadata: {}, xref_count: 0 }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      execTool(externalFetchTool, { provider: 'uniprot', external_id: 'P00875' })
    ).resolves.toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('returns ok:false on sidecar 502', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ detail: 'provider_error' }), { status: 502 })
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await execTool<{ ok: boolean; status: number; error?: string }>(
      externalFetchTool,
      { provider: 'uniprot', external_id: 'NOTREAL99' }
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(502);
    expect(result.error).toBe('provider_error');
  });

  it('returns ok:false on non-JSON response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('<html>500 from gateway</html>', { status: 500 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await execTool<{ ok: boolean; status: number; error?: string }>(
      externalFetchTool,
      { provider: 'uniprot', external_id: 'X' }
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(result.error).toMatch(/non-JSON/);
  });

  it('returns ok:false on a non-JSON success response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('<html>unexpected proxy page</html>', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await execTool<{ ok: boolean; status: number; error?: string }>(
      externalFetchTool,
      { provider: 'uniprot', external_id: 'X' }
    );
    expect(result).toMatchObject({
      ok: false,
      status: 200,
      code: 'INVALID_EXTERNAL_FETCH_RESPONSE', error: 'Sidecar returned a non-JSON response.', retriable: false, stateChanged: 'unknown', partialEffects: [],
    });
  });

  it('passes abortSignal through to fetch', async () => {
    const controller = new AbortController();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ resource_id: 'r' }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await execTool(
      externalFetchTool,
      { provider: 'uniprot', external_id: 'P00875' },
      { toolCallId: 't', messages: [], abortSignal: controller.signal }
    );
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBe(controller.signal);
  });
});

import { checkedToolFactory } from '../../../test-utils/mcp-output-test-helper';
const externalFetchTool = checkedToolFactory(() => uncheckedexternalFetchTool, externalFetchOutputSchema)();
