import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchLocally } from './hosted-policy-tools';
import { __resetAgentGrantsForTests } from '../../agent-grants/store';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { mockUUID } from '../tools/test-helpers';

mockUUID();

describe('connected local agent authority', () => {
  const requests: string[] = [];
  let callerResponse: unknown;
  let status = 200;

  beforeEach(() => {
    requests.length = 0;
    status = 200;
    callerResponse = {
      ok: true,
      caller: { agentIdentityId: 'exact-bound-agent', effectiveCapabilities: ['read-workspace'] },
    };
    __resetAgentGrantsForTests([], 'connected');
    useWorkspaceStore.setState({ folders: [] });
    vi.stubEnv('VITE_API_URL', 'http://127.0.0.1:8123');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requests.push(url);
        return new Response(
          JSON.stringify(
            url.includes('/mcp/caller')
              ? callerResponse
              : { ok: true, grants: [], hiddenDevelopmentGrantCount: 0 }
          ),
          {
            status: url.includes('/mcp/caller') ? status : 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    __resetAgentGrantsForTests();
  });

  it('executes with the authenticated identity even when the Settings list is empty', async () => {
    const audit = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      await expect(dispatchLocally('get_workspace', {}, {})).resolves.toBeDefined();
      expect(requests).toEqual(['http://127.0.0.1:8123/mcp/caller']);
      expect(audit).toHaveBeenCalledWith(
        '[agent-bridge] renderer audit',
        expect.objectContaining({
          actor_identity: 'exact-bound-agent',
          status: 'completed',
        })
      );
    } finally {
      audit.mockRestore();
    }
  });

  it.each(['GRANT_MISSING', 'GRANT_REVOKED', 'GRANT_EXPIRED'])(
    'preserves %s and executes nothing',
    async (code) => {
      status = 401;
      callerResponse = {
        ok: false,
        error: { code, message: 'Exact caller is unavailable.', retriable: false },
      };
      await expect(dispatchLocally('get_workspace', {}, {})).rejects.toMatchObject({ code });
      expect(requests).toEqual(['http://127.0.0.1:8123/mcp/caller']);
    }
  );

  it('rechecks scope for every call and keeps a valid empty grant distinct from an absent grant', async () => {
    await dispatchLocally('get_workspace', {}, {});
    callerResponse = {
      ok: true,
      caller: { agentIdentityId: 'exact-bound-agent', effectiveCapabilities: [] },
    };
    await expect(dispatchLocally('get_workspace', {}, {})).rejects.toMatchObject({
      code: 'INSUFFICIENT_SCOPE',
    });
    expect(requests).toHaveLength(2);
  });

  it('does not substitute another app grant when authority is unavailable', async () => {
    __resetAgentGrantsForTests([
      {
        id: 'different-app-grant',
        label: 'Different app',
        kind: 'in-app',
        origin: 'app',
        scopes: ['*'],
        createdAt: '2026-01-01T00:00:00Z',
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
      },
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })
    );
    await expect(dispatchLocally('get_workspace', {}, {})).rejects.toMatchObject({
      code: 'AGENT_AUTHORITY_UNAVAILABLE',
      retriable: true,
    });
  });

  it('rejects a success-shaped caller returned with an HTTP failure', async () => {
    status = 503;
    await expect(dispatchLocally('get_workspace', {}, {})).rejects.toMatchObject({
      code: 'AGENT_AUTHORITY_UNAVAILABLE',
    });
  });

  it('never starts lookup or execution for an already stopped turn', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      dispatchLocally('get_workspace', {}, { abortSignal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(requests).toEqual([]);
  });
});
