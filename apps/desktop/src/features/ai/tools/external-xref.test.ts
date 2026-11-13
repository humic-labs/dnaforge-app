import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { externalXrefOutputSchema, externalXrefSchema, externalXrefTool as uncheckedexternalXrefTool } from './external-xref';
import { execTool } from './test-helpers';

const realFetch = globalThis.fetch;
const TEST_ENV_API_URL = 'http://127.0.0.1:8120';
const TEST_RUNTIME_SIDECAR_URL = 'http://127.0.0.1:8121';

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

describe('external.xref input schema', () => {
  it('rejects missing required fields', () => {
    expect(externalXrefSchema.safeParse({}).success).toBe(false);
  });

  it('accepts a minimal valid payload', () => {
    const r = externalXrefSchema.safeParse({ provider: 'uniprot', external_id: 'P00875' });
    expect(r.success).toBe(true);
  });

  it('accepts target_provider for filtering', () => {
    const r = externalXrefSchema.safeParse({
      provider: 'uniprot',
      external_id: 'P00875',
      target_provider: 'pdb',
    });
    expect(r.success).toBe(true);
  });

  it('rejects undeclared fields so the schema matches the shared manifest', () => {
    const r = externalXrefSchema.safeParse({
      provider: 'uniprot',
      external_id: 'P00875',
      granted_capabilities: ['external-fetch:annotation'],
    });
    expect(r.success).toBe(false);
  });
});

describe('external.xref handler', () => {
  it('returns not_cached on sidecar 404  contract: /xrefs matches sibling 404)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 404 })) as any;

    const result = await execTool<{ ok: boolean; status: number; error?: string; code?: string }>(
      externalXrefTool,
      { provider: 'uniprot', external_id: 'NEVER_FETCHED' }
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.code).toBe('RESOURCE_NOT_CACHED');
  });

  it('returns xrefs from cached resource', async () => {
    const xrefs = [
      { from_resource_id: 'r1', to_resource_id: 'r2', xref_type: 'has_structure' },
      { from_resource_id: 'r1', to_resource_id: 'r3', xref_type: 'has_homolog' },
    ];
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ resource_id: 'r1', xrefs, total: xrefs.length }), {
          status: 200,
        })
      ) as any;

    const result = await execTool<{
      ok: boolean;
      xrefs: typeof xrefs;
      total: number;
      resource_id: string;
    }>(externalXrefTool, { provider: 'uniprot', external_id: 'P00875' });
    expect(result.ok).toBe(true);
    expect(result.resource_id).toBe('r1');
    expect(result.total).toBe(2);
    expect(result.xrefs.length).toBe(2);
  });

  it('passes target_provider as a query param when supplied', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ resource_id: 'r1', xrefs: [], total: 0 }), {
        status: 200,
      })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await execTool(externalXrefTool, {
      provider: 'uniprot',
      external_id: 'P00875',
      target_provider: 'pdb',
    });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/external/xrefs');
    expect(url).toContain('provider=uniprot');
    expect(url).toContain('external_id=P00875');
    expect(url).toContain('target_provider=pdb');
  });

  it('uses Electron main-process runtime API URL instead of the Vite-baked URL', async () => {
    const getApiUrl = vi.fn(async () => TEST_RUNTIME_SIDECAR_URL);
    (globalThis as any).electronAPI = {
      config: { getApiUrl },
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ resource_id: 'r1', xrefs: [], total: 0 }), {
        status: 200,
      })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await execTool(externalXrefTool, { provider: 'uniprot', external_id: 'P00875' });

    expect(getApiUrl).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${TEST_RUNTIME_SIDECAR_URL}/external/xrefs?provider=uniprot&external_id=P00875`
    );
  });

  it('uses GET against /external/xrefs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ resource_id: 'r1', xrefs: [], total: 0 }), {
        status: 200,
      })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await execTool(externalXrefTool, { provider: 'uniprot', external_id: 'P00875' });

    const init = fetchMock.mock.calls[0][1] as RequestInit | undefined;
    expect(init?.method).toBe('GET');
  });

  it('returns lookup_failed on non-2xx (other than 404)', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('internal error', { status: 500 })) as any;

    const result = await execTool<{ ok: boolean; status: number; error?: string; code?: string }>(
      externalXrefTool,
      { provider: 'uniprot', external_id: 'P00875' }
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(result.code).toBe('EXTERNAL_XREF_FAILED');
  });

  it('propagates cancellation instead of reporting a broken sidecar reply', async () => {
    const abortError = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    globalThis.fetch = vi.fn().mockRejectedValue(abortError) as any;

    await expect(
      execTool(externalXrefTool, { provider: 'uniprot', external_id: 'P00875' })
    ).rejects.toBe(abortError);
  });

  it('propagates network failures instead of reporting a broken sidecar reply', async () => {
    const networkError = new TypeError('sidecar unreachable');
    globalThis.fetch = vi.fn().mockRejectedValue(networkError) as any;

    await expect(
      execTool(externalXrefTool, { provider: 'uniprot', external_id: 'P00875' })
    ).rejects.toBe(networkError);
  });

  it('returns malformed_xref_response when sidecar omits required fields', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ resource_id: 'r1' }), { status: 200 })
      ) as any;
    const result = await execTool<{ ok: boolean; error?: string; code?: string }>(externalXrefTool, {
      provider: 'uniprot',
      external_id: 'P00875',
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('INVALID_XREF_RESPONSE');
  });

  it('returns a structured failure for a non-JSON success response', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response('<html>unexpected proxy page</html>', { status: 200 })
      ) as unknown as typeof fetch;

    const result = await execTool<{ ok: boolean; status: number; error?: string; code?: string }>(
      externalXrefTool,
      { provider: 'uniprot', external_id: 'P00875' }
    );
    expect(result).toEqual({
      ok: false,
      status: 200,
      code: 'INVALID_XREF_RESPONSE', error: 'Sidecar returned a non-JSON response.', retriable: false, stateChanged: false, partialEffects: [],
    });
  });

  it('does not expose the sidecar session token to renderer requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ resource_id: 'r1', xrefs: [], total: 0 }), {
        status: 200,
      })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await execTool(externalXrefTool, { provider: 'uniprot', external_id: 'P00875' });

    const headers = new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get('X-DNAForge-Session')).toBeNull();
  });

  it('does not require a renderer-visible session token', async () => {
    delete (globalThis as any).electronAPI;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ resource_id: 'r1', xrefs: [], total: 0 }), { status: 200 })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      execTool(externalXrefTool, { provider: 'uniprot', external_id: 'P00875' })
    ).resolves.toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

import { checkedToolFactory } from '../../../test-utils/mcp-output-test-helper';
const externalXrefTool = checkedToolFactory(() => uncheckedexternalXrefTool, externalXrefOutputSchema)();
