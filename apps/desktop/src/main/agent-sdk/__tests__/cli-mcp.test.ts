import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { customFetch, resetApiClientConfigurationForTests } from '@waypoint/api-client';
import {
  buildCliMcpServerLaunch,
  buildClaudeMcpServers,
  buildCodexMcpConfig,
  buildGrokMcpServer,
  listDnaForgeMcpToolNames,
  listClaudeAllowedDnaForgeMcpTools,
} from '../cli-mcp';
import { resolveMcpCompanionExecutable } from '../../sidecar-binary';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = resolve(TEST_DIR, '../../../..');
const API_DIR = resolve(DESKTOP_DIR, '../api');

describe('resolveMcpCompanionExecutable', () => {
  it('launches the source entrypoint through the resolved API Python in dev', () => {
    const launch = resolveMcpCompanionExecutable({
      isPackaged: false,
      appPath: DESKTOP_DIR,
      resourcesPath: '/unused/Resources',
      resolvePython: (apiDir) => {
        expect(apiDir).toBe(API_DIR);
        return '/test/python3';
      },
    });

    expect(launch).toEqual({
      command: '/test/python3',
      args: [join(API_DIR, 'run_server.py'), '--mcp-stdio'],
    });
  });

  it('recovers apps/api from a built non-packaged out/main app path', () => {
    const launch = resolveMcpCompanionExecutable({
      isPackaged: false,
      appPath: join(DESKTOP_DIR, 'out/main'),
      resourcesPath: '/unused/Resources',
      pathExists: (path) => path === API_DIR,
      resolvePython: (apiDir) => {
        expect(apiDir).toBe(API_DIR);
        return '/test/python3';
      },
    });

    expect(launch.args).toEqual([join(API_DIR, 'run_server.py'), '--mcp-stdio']);
  });

  it('resolves the Windows API virtualenv for development launches', () => {
    const windowsPython = join(API_DIR, '.venv', 'Scripts', 'python.exe');
    const launch = resolveMcpCompanionExecutable({
      isPackaged: false,
      appPath: DESKTOP_DIR,
      resourcesPath: '/unused/Resources',
      platform: 'win32',
      pathExists: (path) => path === API_DIR || path === windowsPython,
    });

    expect(launch).toEqual({
      command: windowsPython,
      args: [join(API_DIR, 'run_server.py'), '--mcp-stdio'],
    });
  });

  it('launches the packaged native sidecar executable without Electron-as-Node', () => {
    const resourcesPath = '/Applications/DNAForge.app/Contents/Resources';
    const binary = join(resourcesPath, 'binaries/waypoint-api-aarch64-apple-darwin/waypoint-api');
    const launch = resolveMcpCompanionExecutable({
      isPackaged: true,
      appPath: '/unused/app.asar',
      resourcesPath,
      platform: 'darwin',
      arch: 'arm64',
      pathExists: (path) => path === binary,
    });

    expect(launch).toEqual({ command: binary, args: ['--mcp-stdio'] });
  });
});

describe('buildCliMcpServerLaunch', () => {
  const bridge = {
    apiUrl: 'http://127.0.0.1:8099',
    sessionToken: 'session-token',
    agentIdentityId: 'local-in-app-chat',
    capabilities: ['read-sequences'],
    command: '/Applications/DNAForge.app/Contents/Resources/binaries/waypoint-api',
    commandArgs: ['--mcp-stdio'],
  };

  it('keeps grant secrets in env and out of the process argument list', () => {
    const launch = buildCliMcpServerLaunch(bridge);

    expect(launch.args).toEqual(['--mcp-stdio']);
    expect(JSON.stringify(launch.args)).not.toContain(bridge.sessionToken);
    expect(launch.env).toMatchObject({
      DNAFORGE_API_URL: bridge.apiUrl,
      DNAFORGE_MCP_SESSION_TOKEN: bridge.sessionToken,
      DNAFORGE_MCP_API_KEY: '',
      DNAFORGE_MCP_AGENT_IDENTITY: bridge.agentIdentityId,
      DNAFORGE_MCP_CLIENT_SURFACE: 'dnaforge-chat',
      DNAFORGE_MCP_GRANT_CAPABILITIES: JSON.stringify(bridge.capabilities),
    });
    expect(launch.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it('requires the app-owned native companion to initialize within the unchanged Codex timeout', () => {
    const launch = buildCliMcpServerLaunch(bridge);
    expect(buildCodexMcpConfig(launch)).toMatchObject({
      mcp_servers: { dnaforge: { startup_timeout_sec: 120, required: true } },
    });
  });

  it('rechecks authority for each provider descriptor and keeps the check in main', () => {
    let current = true;
    const launch = buildCliMcpServerLaunch({
      ...bridge,
      assertCurrent: () => {
        if (!current) throw new Error('Revoked generation');
      },
    });
    const builders = [buildClaudeMcpServers, buildCodexMcpConfig, buildGrokMcpServer];
    for (const build of builders) {
      expect(JSON.stringify(build(launch))).not.toContain('assertCurrent');
    }
    current = false;
    for (const build of builders) expect(() => build(launch)).toThrow('Revoked generation');
  });

  it('disables inherited personal MCP servers only in the current app session', () => {
    const launch = buildCliMcpServerLaunch(bridge);
    const inherited = ['slack', 'dnaforge', 'odd.name', 'quoted"name', 'slack'];
    const original = [...inherited];
    const config = buildCodexMcpConfig(launch, inherited);
    expect(config).toMatchObject({
      features: { plugins: false, apps: false },
      mcp_servers: {
        slack: { enabled: false },
        'odd.name': { enabled: false },
        [inherited[3]]: { enabled: false },
        dnaforge: { enabled: true, required: true, startup_timeout_sec: 120 },
      },
    });
    expect(config).not.toHaveProperty('mcp_servers."dnaforge".enabled');
    expect(inherited).toEqual(original);
  });

  it('exposes the app-owned user-input bridge only to Grok ACP', () => {
    const launch = buildCliMcpServerLaunch(bridge);
    const grok = buildGrokMcpServer(launch, {
      path: '/private/app/grok-input.json',
      token: 'one-time-token',
    });

    expect(grok.env).toContainEqual({
      name: 'DNAFORGE_MCP_EXPOSE_AGENT_USER_INPUT',
      value: '1',
    });
    expect(grok.env).toContainEqual({
      name: 'DNAFORGE_MCP_AGENT_USER_INPUT_HANDOFF_PATH',
      value: '/private/app/grok-input.json',
    });
    expect(grok.env).toContainEqual({
      name: 'DNAFORGE_MCP_AGENT_USER_INPUT_HANDOFF_TOKEN',
      value: 'one-time-token',
    });
    expect(launch.env).not.toHaveProperty('DNAFORGE_MCP_EXPOSE_AGENT_USER_INPUT');
    expect(buildCodexMcpConfig(launch)).not.toMatchObject({
      mcp_servers: {
        dnaforge: {
          env: { DNAFORGE_MCP_EXPOSE_AGENT_USER_INPUT: '1' },
        },
      },
    });
  });
});

describe('listClaudeAllowedDnaForgeMcpTools', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetApiClientConfigurationForTests();
  });

  it('does not send discovery credentials after their generation is revoked', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      listDnaForgeMcpToolNames({
        apiUrl: 'http://127.0.0.1:8099',
        sessionToken: 'session-token',
        agentIdentityId: 'local-in-app-chat',
        capabilities: ['read-workspace'],
        assertCurrent: () => {
          throw new Error('Revoked generation');
        },
      })
    ).rejects.toThrow('Revoked generation');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the same authenticated scoped discovery projection as the companion', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        tools: [{ name: 'observe_app_state' }, { name: 'import_sequence' }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const tools = await listClaudeAllowedDnaForgeMcpTools({
      apiUrl: 'http://127.0.0.1:8099',
      sessionToken: 'session-token',
      agentIdentityId: 'local-in-app-chat',
      capabilities: ['read-workspace'],
    });

    expect(tools).toEqual(['mcp__dnaforge__import_sequence', 'mcp__dnaforge__observe_app_state']);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('http://127.0.0.1:8099/mcp/discover');
    expect(init.method).toBe('POST');
    const headers = new Headers(init.headers);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('X-DNAForge-Session')).toBe('session-token');
    expect(headers.get('X-DNAForge-Agent-Identity')).toBe('local-in-app-chat');
    expect(headers.get('X-DNAForge-Agent-Capabilities')).toBe('["read-workspace"]');
    expect(init.body).toBe(
      JSON.stringify({
        clientInfo: {
          name: 'dnaforge-desktop-catalog-parity',
          version: '1',
        },
      })
    );
  });

  it('does not leave agent identity or capabilities on unrelated generated-client calls', async () => {
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({ tools: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    await listDnaForgeMcpToolNames({
      apiUrl: 'http://127.0.0.1:8099',
      sessionToken: 'session-token',
      agentIdentityId: 'local-in-app-chat',
      capabilities: ['read-workspace'],
    });
    await customFetch('/unrelated');

    const unrelatedHeaders = new Headers(fetchMock.mock.calls[1][1].headers);
    expect(unrelatedHeaders.get('X-DNAForge-Agent-Identity')).toBeNull();
    expect(unrelatedHeaders.get('X-DNAForge-Agent-Capabilities')).toBeNull();
  });

  it('returns raw sorted names for exact companion catalog comparison', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          tools: [
            { name: 'observe_app_state' },
            { name: 'list_files' },
            { name: 'observe_app_state' },
          ],
        }),
      })
    );

    await expect(
      listDnaForgeMcpToolNames({
        apiUrl: 'http://127.0.0.1:8099',
        sessionToken: 'session-token',
        agentIdentityId: 'local-in-app-chat',
        capabilities: ['read-workspace'],
      })
    ).resolves.toEqual(['list_files', 'observe_app_state']);
  });

  it('bounds authenticated discovery instead of leaving the chat turn hung', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: URL, init: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true }
          );
        });
      })
    );

    await expect(
      listDnaForgeMcpToolNames(
        {
          apiUrl: 'http://127.0.0.1:8099',
          sessionToken: 'session-token',
          agentIdentityId: 'local-in-app-chat',
          capabilities: ['read-workspace'],
        },
        { timeoutMs: 10 }
      )
    ).rejects.toThrow('DNAForge tool discovery timed out after 10ms.');
  });

  it('keeps the discovery deadline active while reading the response body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: URL, init: RequestInit) =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener(
                'abort',
                () => reject(new DOMException('aborted', 'AbortError')),
                { once: true }
              );
            }),
        } as Response)
      )
    );

    await expect(
      listDnaForgeMcpToolNames(
        {
          apiUrl: 'http://127.0.0.1:8099',
          sessionToken: 'session-token',
          agentIdentityId: 'local-in-app-chat',
          capabilities: ['read-workspace'],
        },
        { timeoutMs: 10 }
      )
    ).rejects.toThrow('DNAForge tool discovery timed out after 10ms.');
  });
});
