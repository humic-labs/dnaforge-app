// @vitest-environment node

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import {
  __resetAgentGrantsForTests,
  createApiKeyAgentGrant,
  getAgentGrantStoreSnapshot,
  revokeAgentGrant,
} from './store';

const TEST_SIDECAR_BASE_URL = 'http://127.0.0.1:8124';
const TEST_RUNTIME_SIDECAR_URL = 'http://127.0.0.1:8125';

describe('agent grant store sidecar client', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_URL', TEST_SIDECAR_BASE_URL);
    (globalThis as { electronAPI?: object }).electronAPI = {};
    __resetAgentGrantsForTests([], 'connected');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    delete (globalThis as { electronAPI?: object }).electronAPI;
  });

  it('loads active grants from the authenticated sidecar route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        grants: [
          {
            id: 'local-in-app-chat',
            label: 'In-app Strider',
            kind: 'in-app',
            origin: 'app',
            isDevelopment: false,
            environmentId: 'dev-worktree',
            createdBy: 'electron-dev',
            scopes: ['read-workspace'],
            createdAt: '2026-05-27T12:00:00Z',
            lastUsedAt: null,
            expiresAt: null,
            revokedAt: null,
          },
        ],
        hiddenDevelopmentGrantCount: 2,
        hasMore: true,
        nextCursor: 'MjAw',
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const snapshot = await getAgentGrantStoreSnapshot();

    expect(snapshot.source).toBe('connected');
    expect(snapshot.grants[0]?.label).toBe('In-app Strider');
    expect(snapshot.grants[0]?.origin).toBe('app');
    expect(snapshot.grants[0]?.isDevelopment).toBe(false);
    expect(snapshot.grants[0]?.environmentId).toBe('dev-worktree');
    expect(snapshot.grants[0]?.createdBy).toBe('electron-dev');
    expect(snapshot.hiddenDevelopmentGrantCount).toBe(2);
    expect(snapshot.hasMore).toBe(true);
    expect(snapshot.nextCursor).toBe('MjAw');
    expect(fetchMock).toHaveBeenCalledWith(
      `${TEST_SIDECAR_BASE_URL}/agent-grants`,
      expect.any(Object)
    );
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(request.headers).get('X-DNAForge-Session')).toBeNull();
  });

  it('loads an explicit continuation page without hiding that the list is incomplete', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        grants: [
          {
            id: 'agent_http_older',
            label: 'Older caller',
            kind: 'http-api-key',
            origin: 'tool-key',
            isDevelopment: false,
            scopes: ['read-workspace'],
            createdAt: '2026-05-27T11:00:00Z',
            lastUsedAt: null,
            expiresAt: null,
            revokedAt: null,
          },
        ],
        hiddenDevelopmentGrantCount: 0,
        hasMore: false,
        nextCursor: null,
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const snapshot = await getAgentGrantStoreSnapshot({ cursor: 'MjAw' });

    expect(snapshot.grants.map((grant) => grant.id)).toEqual(['agent_http_older']);
    expect(snapshot.hasMore).toBe(false);
    expect(snapshot.nextCursor).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      `${TEST_SIDECAR_BASE_URL}/agent-grants?cursor=MjAw`,
      expect.any(Object)
    );
  });

  it('uses the runtime sidecar URL when the packaged renderer has no VITE_API_URL', async () => {
    vi.stubEnv('VITE_API_URL', '');
    (
      globalThis as {
        electronAPI?: {
          config?: { getApiUrl?: () => Promise<string> };
        };
      }
    ).electronAPI = {
      config: {
        getApiUrl: vi.fn().mockResolvedValue(TEST_RUNTIME_SIDECAR_URL),
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, grants: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await getAgentGrantStoreSnapshot();

    expect(fetchMock).toHaveBeenCalledWith(
      `${TEST_RUNTIME_SIDECAR_URL}/agent-grants`,
      expect.any(Object)
    );
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(request.headers).get('X-DNAForge-Session')).toBeNull();
  });

  it('can request development and test grants explicitly', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        grants: [
          {
            id: 'local-agent',
            label: 'Local agent',
            kind: 'stdio-mcp',
            origin: 'dev-test',
            isDevelopment: true,
            scopes: ['modify-tabs'],
            createdAt: '2026-05-27T12:00:00Z',
            lastUsedAt: null,
            expiresAt: null,
            revokedAt: null,
          },
        ],
        hiddenDevelopmentGrantCount: 0,
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const snapshot = await getAgentGrantStoreSnapshot({ includeDevelopment: true });

    expect(snapshot.grants[0]?.id).toBe('local-agent');
    expect(snapshot.grants[0]?.origin).toBe('dev-test');
    expect(snapshot.grants[0]?.isDevelopment).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      `${TEST_SIDECAR_BASE_URL}/agent-grants?includeDevTest=true`,
      expect.any(Object)
    );
  });

  it('creates and revokes grants through the sidecar', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          grant: {
            id: 'agent_http_created',
            label: 'Nightly import job',
            kind: 'http-api-key',
            scopes: ['read-workspace'],
            createdAt: '2026-05-27T12:00:00Z',
            lastUsedAt: null,
            expiresAt: null,
            revokedAt: null,
          },
          apiKey: 'dna_key_real',
        })
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await createApiKeyAgentGrant({
      label: 'Nightly import job',
      scopes: ['read-workspace'],
    });
    await revokeAgentGrant(result.grant.id);

    expect(result.apiKey).toBe('dna_key_real');
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `${TEST_SIDECAR_BASE_URL}/agent-grants/api-keys`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          label: 'Nightly import job',
          scopes: ['read-workspace'],
        }),
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `${TEST_SIDECAR_BASE_URL}/agent-grants/agent_http_created`,
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  it('preserves the sidecar reason when API key creation is rejected', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      errorJsonResponse(400, {
        error: { message: 'API key request includes unsupported scopes.' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createApiKeyAgentGrant({ label: 'Nightly import job', scopes: ['unsupported'] })
    ).rejects.toThrow('API key request includes unsupported scopes.');
  });

  it('preserves the sidecar reason when grant revocation is rejected', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        errorJsonResponse(404, { error: { message: 'Agent grant was not found.' } })
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(revokeAgentGrant('missing-grant')).rejects.toThrow('Agent grant was not found.');
  });

  it('rejects a refusal envelope even when the sidecar responds with HTTP 200', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ ok: false, error: { message: 'Grant list is unavailable.' } })
      )
      .mockResolvedValueOnce(
        jsonResponse({ ok: false, error: { message: 'API key creation was refused.' } })
      )
      .mockResolvedValueOnce(
        jsonResponse({ ok: false, error: { message: 'Grant revocation was refused.' } })
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(getAgentGrantStoreSnapshot()).rejects.toThrow('Grant list is unavailable.');
    await expect(
      createApiKeyAgentGrant({ label: 'Nightly import job', scopes: ['read-workspace'] })
    ).rejects.toThrow('API key creation was refused.');
    await expect(revokeAgentGrant('agent_http_created')).rejects.toThrow(
      'Grant revocation was refused.'
    );
  });
});

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    statusText: 'OK',
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function errorJsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 404 ? 'Not Found' : 'Bad Request',
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('manage-agent-access scope ', () => {
  it('is offered for keys but never selected by default', async () => {
    const { AGENT_GRANT_SCOPE_OPTIONS, DEFAULT_EXTERNAL_ACCESS_KEY_SCOPES } =
      await import('./store');
    expect(AGENT_GRANT_SCOPE_OPTIONS.map((option) => option.value)).toContain(
      'manage-agent-access'
    );
    expect(DEFAULT_EXTERNAL_ACCESS_KEY_SCOPES).not.toContain('manage-agent-access');
  });
});
