import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SidecarSessionAuthority } from '../../sidecar-session-authority';
import { createReadyCliMcpBridgeProvider } from '../cli-mcp-provider';

const {
  ipcHandlers,
  mockSenderSend,
  mockDetectAgentSdk,
  mockDetectAgentSdkWithModels,
  mockQueryClaudeCode,
  mockQueryCodex,
  mockQueryGrok,
  mockAuthenticateAgentCli,
  mockBuildStaticProviderProbeMatrix,
  mockGetProviderProbeVersions,
  mockCancelRendererToolCallsForTurn,
} = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  mockSenderSend: vi.fn(),
  mockDetectAgentSdk: vi.fn(),
  mockDetectAgentSdkWithModels: vi.fn(),
  mockQueryClaudeCode: vi.fn(),
  mockQueryCodex: vi.fn(),
  mockQueryGrok: vi.fn(),
  mockAuthenticateAgentCli: vi.fn(),
  mockBuildStaticProviderProbeMatrix: vi.fn(),
  mockGetProviderProbeVersions: vi.fn(),
  mockCancelRendererToolCallsForTurn: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler);
    }),
  },
}));

vi.mock('../detect', () => ({
  detectAgentSdk: mockDetectAgentSdk,
  detectAgentSdkWithModels: mockDetectAgentSdkWithModels,
}));

vi.mock('../query', () => ({
  queryClaudeCode: mockQueryClaudeCode,
  queryCodex: mockQueryCodex,
  queryGrok: mockQueryGrok,
}));

vi.mock('../auth', () => ({
  authenticateAgentCli: mockAuthenticateAgentCli,
}));

vi.mock('../probe', () => ({
  buildStaticProviderProbeMatrix: mockBuildStaticProviderProbeMatrix,
  getProviderProbeVersions: mockGetProviderProbeVersions,
}));

vi.mock('../../agent-tools-bridge', () => ({
  cancelRendererToolCallsForTurn: mockCancelRendererToolCallsForTurn,
}));

const TEST_CLI_MCP_API_URL = 'http://agent-sdk-sidecar.test.invalid';

async function invoke(channel: string, ...args: unknown[]) {
  const handler = ipcHandlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
  return handler({ sender: { send: mockSenderSend } }, ...args);
}

describe('agent-sdk IPC handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipcHandlers.clear();
    const detection = {
      claudeCode: {
        cli: 'missing',
        path: null,
        auth: 'unauthenticated',
        defaultModel: null,
        keychainEntryPresent: null,
        credentialsFilePresent: null,
      },
      codex: {
        cli: 'installed',
        path: '/usr/local/bin/codex',
        auth: 'authenticated',
        defaultModel: null,
        authMode: 'chatgpt',
        authFilePresent: true,
      },
      grok: {
        cli: 'installed',
        path: '/usr/local/bin/grok',
        auth: 'authenticated',
        defaultModel: null,
      },
    };
    mockDetectAgentSdk.mockResolvedValue(detection);
    mockDetectAgentSdkWithModels.mockResolvedValue(detection);
    mockQueryClaudeCode.mockResolvedValue({
      transport: 'claude-agent-sdk',
      ok: true,
      text: 'claude ok',
      durationMs: 10,
    });
    mockQueryCodex.mockResolvedValue({
      transport: 'codex-sdk',
      ok: true,
      text: 'codex ok',
      durationMs: 10,
    });
    mockQueryGrok.mockResolvedValue({
      transport: 'grok-acp',
      ok: true,
      text: 'grok ok',
      durationMs: 10,
    });
    mockAuthenticateAgentCli.mockResolvedValue({
      authId: 'auth-1',
      transport: 'codex-sdk',
      ok: true,
      status: 'completed',
      command: ['/usr/local/bin/codex', 'login'],
      output: '',
      durationMs: 10,
    });
    mockGetProviderProbeVersions.mockResolvedValue({
      codexSdkVersion: '0.133.0',
      claudeSdkVersion: '0.3.150',
      codexCliVersion: 'codex 1.0.0',
      claudeCliVersion: 'claude 2.0.0',
      grokAcpSdkVersion: '1.4.0',
      grokCliVersion: 'grok 1.0.13',
    });
    mockBuildStaticProviderProbeMatrix.mockReturnValue([
      {
        transport: 'codex-sdk',
        releaseMode: 'dev_only',
        stop: { userVisibleStopState: 'stop_requested' },
      },
      {
        transport: 'claude-agent-sdk',
        releaseMode: 'dev_only',
        stop: { userVisibleStopState: 'stop_requested' },
      },
      {
        transport: 'grok-acp',
        releaseMode: 'production',
        stop: { userVisibleStopState: 'stopped' },
      },
    ]);
  });

  it('registers detect, query, and probe matrix handlers', async () => {
    const { registerAgentSdkHandlers } = await import('../index');
    registerAgentSdkHandlers();

    expect(ipcHandlers.has('agentSdk:detect')).toBe(true);
    expect(ipcHandlers.has('agentSdk:getHelperLifecycleSnapshot')).toBe(true);
    expect(ipcHandlers.has('agentSdk:query')).toBe(true);
    expect(ipcHandlers.has('agentSdk:cancelQuery')).toBe(true);
    expect(ipcHandlers.has('agentSdk:authenticate')).toBe(true);
    expect(ipcHandlers.has('agentSdk:probeMatrix')).toBe(true);
  }, 15_000);

  it('returns the authoritative main-process helper lifecycle snapshot', async () => {
    const { registerAgentSdkHandlers } = await import('../index');
    registerAgentSdkHandlers();

    await expect(invoke('agentSdk:getHelperLifecycleSnapshot')).resolves.toMatchObject({
      active: 0,
      started: expect.any(Number),
      settled: expect.any(Number),
      peakActive: expect.any(Number),
    });
  });

  it('detect handler returns the native detector result', async () => {
    const { registerAgentSdkHandlers } = await import('../index');
    registerAgentSdkHandlers();

    await expect(invoke('agentSdk:detect')).resolves.toMatchObject({
      codex: {
        cli: 'installed',
        auth: 'authenticated',
        authMode: 'chatgpt',
      },
    });
    expect(mockDetectAgentSdkWithModels).toHaveBeenCalledTimes(1);
    expect(mockDetectAgentSdkWithModels).toHaveBeenCalledWith({});
    expect(mockDetectAgentSdk).not.toHaveBeenCalled();
  });

  it('sanitizes Settings executable overrides before native detection', async () => {
    const { registerAgentSdkHandlers } = await import('../index');
    registerAgentSdkHandlers();

    await invoke('agentSdk:detect', {
      'codex-sdk': '/opt/lab/bin/codex',
      'claude-agent-sdk': 'relative/claude',
      unexpected: '/tmp/not-a-provider',
    });

    expect(mockDetectAgentSdkWithModels).toHaveBeenCalledWith({
      'codex-sdk': '/opt/lab/bin/codex',
    });
  });

  it('probe matrix handler returns the conservative provider capability contract', async () => {
    const { registerAgentSdkHandlers } = await import('../index');
    registerAgentSdkHandlers();

    await expect(invoke('agentSdk:probeMatrix')).resolves.toEqual([
      {
        transport: 'codex-sdk',
        releaseMode: 'dev_only',
        stop: { userVisibleStopState: 'stop_requested' },
      },
      {
        transport: 'claude-agent-sdk',
        releaseMode: 'dev_only',
        stop: { userVisibleStopState: 'stop_requested' },
      },
      {
        transport: 'grok-acp',
        releaseMode: 'production',
        stop: { userVisibleStopState: 'stopped' },
      },
    ]);

    expect(mockDetectAgentSdk).toHaveBeenCalledTimes(1);
    expect(mockGetProviderProbeVersions).toHaveBeenCalledWith({
      claudeCode: {
        cli: 'missing',
        path: null,
        auth: 'unauthenticated',
        defaultModel: null,
        keychainEntryPresent: null,
        credentialsFilePresent: null,
      },
      codex: {
        cli: 'installed',
        path: '/usr/local/bin/codex',
        auth: 'authenticated',
        defaultModel: null,
        authMode: 'chatgpt',
        authFilePresent: true,
      },
      grok: {
        cli: 'installed',
        path: '/usr/local/bin/grok',
        auth: 'authenticated',
        defaultModel: null,
      },
    });
    expect(mockBuildStaticProviderProbeMatrix).toHaveBeenCalledWith(
      {
        claudeCode: {
          cli: 'missing',
          path: null,
          auth: 'unauthenticated',
          defaultModel: null,
          keychainEntryPresent: null,
          credentialsFilePresent: null,
        },
        codex: {
          cli: 'installed',
          path: '/usr/local/bin/codex',
          auth: 'authenticated',
          defaultModel: null,
          authMode: 'chatgpt',
          authFilePresent: true,
        },
        grok: {
          cli: 'installed',
          path: '/usr/local/bin/grok',
          auth: 'authenticated',
          defaultModel: null,
        },
      },
      {
        codexSdkVersion: '0.133.0',
        claudeSdkVersion: '0.3.150',
        codexCliVersion: 'codex 1.0.0',
        claudeCliVersion: 'claude 2.0.0',
        grokAcpSdkVersion: '1.4.0',
        grokCliVersion: 'grok 1.0.13',
      }
    );
  });

  it('dispatches Codex, Claude, and Grok query requests to the matching transport implementation', async () => {
    const { registerAgentSdkHandlers } = await import('../index');
    registerAgentSdkHandlers();

    await expect(
      invoke('agentSdk:query', 'codex-sdk', 'hello codex', {
        purpose: 'chat',
        cwd: '/workspace',
      })
    ).resolves.toMatchObject({
      transport: 'codex-sdk',
      ok: true,
      text: 'codex ok',
    });
    await expect(
      invoke('agentSdk:query', 'claude-agent-sdk', 'hello claude')
    ).resolves.toMatchObject({
      transport: 'claude-agent-sdk',
      ok: true,
      text: 'claude ok',
    });
    await expect(invoke('agentSdk:query', 'grok-acp', 'hello grok')).resolves.toMatchObject({
      transport: 'grok-acp',
      ok: true,
      text: 'grok ok',
    });

    expect(mockQueryCodex).toHaveBeenCalledWith(
      'hello codex',
      expect.objectContaining({
        purpose: 'chat',
        cwd: '/workspace',
        abortController: expect.any(AbortController),
        cliMcpBridge: null,
      })
    );
    expect(mockQueryClaudeCode).toHaveBeenCalledWith(
      'hello claude',
      expect.objectContaining({
        abortController: expect.any(AbortController),
        cliMcpBridge: null,
      })
    );
    expect(mockQueryGrok).toHaveBeenCalledWith(
      'hello grok',
      expect.objectContaining({
        abortController: expect.any(AbortController),
        cliMcpBridge: null,
      })
    );
  });

  it('wires the direct query entry point to the same main-owned shell policy context', async () => {
    const confirm = vi.fn(async () => 'once' as const);
    const resolveContext = vi.fn(async () => ({
      scratchRoot: '/app/cli-scratch',
      userRoots: ['/workspace'],
    }));
    const {
      registerAgentSdkHandlers,
      setAgentSdkConfirmDestructiveFileProvider,
      setAgentSdkGuardrailContextProvider,
    } = await import('../index');
    setAgentSdkConfirmDestructiveFileProvider(() => confirm);
    setAgentSdkGuardrailContextProvider(resolveContext);
    registerAgentSdkHandlers();

    await invoke('agentSdk:query', 'claude-agent-sdk', 'run ls', {
      purpose: 'chat',
      cwd: '/workspace',
      conversationId: 'conv-1',
      shellSupervision: 'always',
    });

    expect(resolveContext).toHaveBeenCalledTimes(1);
    expect(mockQueryClaudeCode).toHaveBeenCalledWith(
      'run ls',
      expect.objectContaining({
        shellSupervision: 'always',
        conversationId: 'conv-1',
        scratchRoot: '/app/cli-scratch',
        userRoots: ['/workspace'],
        confirmDestructiveFile: confirm,
      })
    );

    setAgentSdkConfirmDestructiveFileProvider(null);
    setAgentSdkGuardrailContextProvider(null);
  });

  it('dispatches CLI auth requests and forwards auth output events to the renderer', async () => {
    mockAuthenticateAgentCli.mockImplementationOnce((_transport, options, sink) => {
      sink({
        authId: options.authId,
        transport: 'claude-agent-sdk',
        stream: 'stdout',
        text: 'Open browser to finish sign-in.',
        receivedAt: '2026-06-03T00:00:00.000Z',
      });
      return Promise.resolve({
        authId: options.authId,
        transport: 'claude-agent-sdk',
        ok: true,
        status: 'completed',
        command: ['/usr/local/bin/claude', 'auth', 'login', '--claudeai'],
        output: '',
        durationMs: 10,
      });
    });
    const { registerAgentSdkHandlers } = await import('../index');
    registerAgentSdkHandlers();

    await expect(
      invoke('agentSdk:authenticate', 'claude-agent-sdk', { authId: 'auth-claude-1' })
    ).resolves.toMatchObject({
      authId: 'auth-claude-1',
      transport: 'claude-agent-sdk',
      ok: true,
      status: 'completed',
    });

    expect(mockAuthenticateAgentCli).toHaveBeenCalledWith(
      'claude-agent-sdk',
      { authId: 'auth-claude-1' },
      expect.any(Function)
    );
    expect(mockSenderSend).toHaveBeenCalledWith('agentSdk:authEvent', {
      authId: 'auth-claude-1',
      event: expect.objectContaining({
        authId: 'auth-claude-1',
        transport: 'claude-agent-sdk',
        text: 'Open browser to finish sign-in.',
      }),
    });
  });

  it('rejects unknown auth transports without launching a CLI', async () => {
    const { registerAgentSdkHandlers } = await import('../index');
    registerAgentSdkHandlers();

    await expect(
      invoke('agentSdk:authenticate', 'bogus-sdk', { authId: 'auth-bogus' })
    ).resolves.toMatchObject({
      ok: false,
      error: 'Unknown agent transport: bogus-sdk',
    });
    expect(mockAuthenticateAgentCli).not.toHaveBeenCalled();
  });

  it('sanitizes query options before dispatching to a transport', async () => {
    const { registerAgentSdkHandlers } = await import('../index');
    registerAgentSdkHandlers();

    await expect(
      invoke('agentSdk:query', 'claude-agent-sdk', 'hello claude', {
        purpose: 'chat',
        cwd: '/workspace',
        emitTrace: true,
        permissionMode: 'native-cli',
        ignored: true,
      })
    ).resolves.toMatchObject({
      transport: 'claude-agent-sdk',
      ok: true,
    });
    await expect(
      invoke('agentSdk:query', 'codex-sdk', 'hello codex', {
        purpose: 'other',
        cwd: 42,
      })
    ).resolves.toMatchObject({
      transport: 'codex-sdk',
      ok: true,
    });

    expect(mockQueryClaudeCode).toHaveBeenCalledWith(
      'hello claude',
      expect.objectContaining({
        purpose: 'chat',
        cwd: '/workspace',
        emitTrace: true,
        permissionMode: 'native-cli',
        abortController: expect.any(AbortController),
      })
    );
    expect(mockQueryCodex).toHaveBeenCalledWith(
      'hello codex',
      expect.objectContaining({
        abortController: expect.any(AbortController),
      })
    );
  });

  it('emits provider trace events over the renderer sender for the matching query id', async () => {
    mockQueryCodex.mockImplementationOnce((_prompt, options) => {
      (options as any).traceSink({
        transport: 'codex-sdk',
        sequence: 0,
        receivedAt: '2026-06-02T00:00:00.000Z',
        providerEventType: 'item.completed',
        providerItemType: 'agent_message',
        raw: { type: 'item.completed' },
        display: { kind: 'assistant_text', title: 'Assistant', text: 'trace ok' },
        versions: { sdkVersion: null, cliVersion: null },
      });
      return Promise.resolve({
        transport: 'codex-sdk',
        ok: true,
        text: 'trace ok',
        durationMs: 1,
      });
    });

    const { registerAgentSdkHandlers } = await import('../index');
    registerAgentSdkHandlers();

    await expect(
      invoke('agentSdk:query', 'codex-sdk', 'stream please', {
        purpose: 'chat',
        queryId: 'trace-turn-1',
        emitTrace: true,
      })
    ).resolves.toMatchObject({ ok: true });

    expect(mockSenderSend).toHaveBeenCalledWith('agentSdk:traceEvent', {
      queryId: 'trace-turn-1',
      event: expect.objectContaining({
        transport: 'codex-sdk',
        display: expect.objectContaining({ text: 'trace ok' }),
      }),
    });
  });

  it('passes the configured CLI MCP bridge into chat query calls', async () => {
    const cliMcpBridge = {
      apiUrl: TEST_CLI_MCP_API_URL,
      sessionToken: 'session-token',
      agentIdentityId: 'local-in-app-chat',
      capabilities: ['read-workspace'],
      command: '/Applications/DNAForge.app/Contents/Resources/binaries/waypoint-api',
      commandArgs: ['--mcp-stdio'],
    };
    const { registerAgentSdkHandlers, setAgentSdkCliMcpBridgeProvider } = await import('../index');
    setAgentSdkCliMcpBridgeProvider(() => cliMcpBridge);
    registerAgentSdkHandlers();

    await expect(
      invoke('agentSdk:query', 'codex-sdk', 'hello codex', {
        purpose: 'chat',
        cwd: '/workspace',
        queryId: 'query-1',
      })
    ).resolves.toMatchObject({ ok: true });

    expect(mockQueryCodex).toHaveBeenCalledWith(
      'hello codex',
      expect.objectContaining({
        purpose: 'chat',
        cwd: '/workspace',
        queryId: 'query-1',
        cliMcpBridge,
        abortController: expect.any(AbortController),
      })
    );
  });

  it.each(['codex-sdk', 'claude-agent-sdk', 'grok-acp'])(
    'waits for the ready MCP generation before dispatching %s',
    async (transport) => {
      const authority = new SidecarSessionAuthority();
      const spawn = authority.prepareManagedSpawn('initial');
      const provide = createReadyCliMcpBridgeProvider(authority, (snapshot) => ({
        apiUrl: TEST_CLI_MCP_API_URL,
        sessionToken: snapshot.token,
        agentIdentityId: 'local-in-app-chat',
        capabilities: ['read-workspace'],
        command: '/test/companion',
        commandArgs: ['--mcp-stdio'],
      }));
      let entered: () => void = () => {};
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const { registerAgentSdkHandlers, setAgentSdkCliMcpBridgeProvider } =
        await import('../index');
      setAgentSdkCliMcpBridgeProvider((signal) => {
        entered();
        return provide(signal);
      });
      registerAgentSdkHandlers();
      try {
        const pending = invoke('agentSdk:query', transport, 'workspace turn', {
          purpose: 'chat',
          queryId: `startup-${transport}`,
        });
        await waiting;
        expect(mockQueryCodex).not.toHaveBeenCalled();
        expect(mockQueryClaudeCode).not.toHaveBeenCalled();
        expect(mockQueryGrok).not.toHaveBeenCalled();
        authority.markReady(spawn.generation);
        await expect(pending).resolves.toMatchObject({ ok: true });
        const query =
          transport === 'codex-sdk'
            ? mockQueryCodex
            : transport === 'grok-acp'
              ? mockQueryGrok
              : mockQueryClaudeCode;
        expect(query).toHaveBeenCalledWith(
          'workspace turn',
          expect.objectContaining({
            cliMcpBridge: expect.objectContaining({ sessionToken: spawn.token }),
          })
        );
      } finally {
        authority.markStopped();
        setAgentSdkCliMcpBridgeProvider(null);
      }
    }
  );

  it('returns an IPC-cloneable launch descriptor after asynchronous readiness', async () => {
    const previousTestMode = process.env.WAYPOINT_TEST;
    const previousArgCount = process.argv.length;
    process.env.WAYPOINT_TEST = '1';
    process.argv.push('--e2e');
    const { registerAgentSdkHandlers, setAgentSdkCliMcpBridgeProvider } = await import('../index');
    const assertCurrent = vi.fn();
    setAgentSdkCliMcpBridgeProvider(async () => ({
      apiUrl: TEST_CLI_MCP_API_URL,
      sessionToken: 'session-token',
      agentIdentityId: 'local-in-app-chat',
      capabilities: ['read-workspace'],
      command: '/test/companion',
      commandArgs: ['--mcp-stdio'],
      assertCurrent,
    }));
    try {
      registerAgentSdkHandlers();
      const launch = await invoke('agentSdk:getMcpBridgeLaunchForTest');
      expect(structuredClone(launch)).toEqual(launch);
      expect(launch).not.toHaveProperty('assertCurrent');
      expect(assertCurrent).toHaveBeenCalledTimes(1);
    } finally {
      setAgentSdkCliMcpBridgeProvider(null);
      process.argv.splice(previousArgCount);
      if (previousTestMode === undefined) delete process.env.WAYPOINT_TEST;
      else process.env.WAYPOINT_TEST = previousTestMode;
    }
  });

  it.each(['cancel', 'service-stop'] as const)(
    'releases an in-flight query waiting for readiness after %s',
    async (outcome) => {
      const authority = new SidecarSessionAuthority();
      const spawn = authority.prepareManagedSpawn('initial');
      let entered: () => void = () => {};
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const { registerAgentSdkHandlers, setAgentSdkCliMcpBridgeProvider } =
        await import('../index');
      setAgentSdkCliMcpBridgeProvider(async (signal) => {
        entered();
        await authority.waitForReadySnapshot(30_000, signal);
        throw new Error('A stopped wait must not resume');
      });
      mockCancelRendererToolCallsForTurn.mockReturnValue(0);
      registerAgentSdkHandlers();
      try {
        const pending = invoke('agentSdk:query', 'codex-sdk', 'waiting turn', {
          purpose: 'chat',
          queryId: 'startup-stopped',
        });
        await waiting;
        if (outcome === 'cancel') await invoke('agentSdk:cancelQuery', 'startup-stopped');
        else authority.markStopped();
        await expect(pending).resolves.toMatchObject({
          ok: false,
          stopState: outcome === 'cancel' ? 'stop_requested' : 'failed',
        });
        expect(mockQueryCodex).not.toHaveBeenCalled();
        authority.markReady(spawn.generation);
        await expect(
          invoke('agentSdk:query', 'codex-sdk', 'auxiliary retry', {
            purpose: 'chat',
            toolExposure: 'none',
            queryId: 'startup-stopped',
          })
        ).resolves.toMatchObject({ ok: true });
        expect(mockQueryCodex).toHaveBeenCalledTimes(1);
      } finally {
        authority.markStopped();
        setAgentSdkCliMcpBridgeProvider(null);
      }
    }
  );

  it.each([{ purpose: 'probe' }, { purpose: 'chat', toolExposure: 'none' }])(
    'does not acquire MCP authority for auxiliary options %j',
    async (options) => {
      const { registerAgentSdkHandlers, setAgentSdkCliMcpBridgeProvider } =
        await import('../index');
      const provide = vi.fn(() => {
        throw new Error('Auxiliary turn acquired MCP authority');
      });
      setAgentSdkCliMcpBridgeProvider(provide);
      registerAgentSdkHandlers();
      try {
        await expect(
          invoke('agentSdk:query', 'codex-sdk', 'auxiliary', options)
        ).resolves.toMatchObject({ ok: true });
        expect(provide).not.toHaveBeenCalled();
        expect(mockQueryCodex).toHaveBeenCalledWith(
          'auxiliary',
          expect.objectContaining({
            cliMcpBridge: null,
          })
        );
      } finally {
        setAgentSdkCliMcpBridgeProvider(null);
      }
    }
  );

  it('aborts an in-flight CLI query when cancelQuery is invoked', async () => {
    const queryState: {
      options: { abortController?: AbortController } | null;
      resolve: ((value: unknown) => void) | null;
    } = { options: null, resolve: null };
    mockQueryCodex.mockImplementationOnce((_prompt, options) => {
      queryState.options = options as { abortController?: AbortController };
      return new Promise((resolve) => {
        queryState.resolve = resolve;
      });
    });

    const { registerAgentSdkHandlers } = await import('../index');
    registerAgentSdkHandlers();

    const queryPromise = invoke('agentSdk:query', 'codex-sdk', 'long query', {
      purpose: 'chat',
      queryId: 'query-stop-1',
    });

    await vi.waitFor(() => {
      expect(queryState.options?.abortController).toBeInstanceOf(AbortController);
    });

    await expect(invoke('agentSdk:cancelQuery', 'query-stop-1')).resolves.toEqual({
      ok: true,
      cancelled: true,
    });
    expect(queryState.options?.abortController?.signal.aborted).toBe(true);
    expect(mockCancelRendererToolCallsForTurn).toHaveBeenCalledWith('query-stop-1');

    queryState.resolve?.({
      transport: 'codex-sdk',
      ok: false,
      text: '',
      error: 'Stop requested.',
      durationMs: 1,
      stopState: 'stop_requested',
    });
    await expect(queryPromise).resolves.toMatchObject({ error: 'Stop requested.' });
  });

  it('rejects empty prompts before dispatching to a transport', async () => {
    const { registerAgentSdkHandlers } = await import('../index');
    registerAgentSdkHandlers();

    await expect(invoke('agentSdk:query', 'codex-sdk', '')).resolves.toMatchObject({
      transport: 'codex-sdk',
      ok: false,
      error: 'agentSdk:query requires a non-empty prompt.',
    });
    await expect(invoke('agentSdk:query', 'codex-sdk', null)).resolves.toMatchObject({
      transport: 'codex-sdk',
      ok: false,
      error: 'agentSdk:query requires a non-empty prompt.',
    });
    expect(mockQueryCodex).not.toHaveBeenCalled();
    expect(mockQueryClaudeCode).not.toHaveBeenCalled();
  });

  it('rejects prompts over the IPC byte cap before dispatching to a transport', async () => {
    const { registerAgentSdkHandlers } = await import('../index');
    registerAgentSdkHandlers();

    const tooLarge = 'x'.repeat(64 * 1024 + 1);

    await expect(invoke('agentSdk:query', 'codex-sdk', tooLarge)).resolves.toMatchObject({
      transport: 'codex-sdk',
      ok: false,
      error: 'agentSdk:query prompt exceeds 65536-byte cap.',
    });
    expect(mockQueryCodex).not.toHaveBeenCalled();
  });

  it('rejects unknown transports before acquiring MCP authority or dispatching', async () => {
    const { registerAgentSdkHandlers, setAgentSdkCliMcpBridgeProvider } = await import('../index');
    const provide = vi.fn(() => {
      throw new Error('Invalid transport acquired MCP authority');
    });
    setAgentSdkCliMcpBridgeProvider(provide);
    registerAgentSdkHandlers();
    try {
      await expect(
        invoke('agentSdk:query', 'bogus-sdk', 'hello', {
          purpose: 'chat',
          queryId: 'invalid-startup',
        })
      ).resolves.toMatchObject({
        transport: 'bogus-sdk',
        ok: false,
        error: 'Unknown agent transport: bogus-sdk',
        durationMs: 0,
      });
      expect(provide).not.toHaveBeenCalled();
      expect(mockQueryCodex).not.toHaveBeenCalled();
      expect(mockQueryClaudeCode).not.toHaveBeenCalled();
      expect(mockQueryGrok).not.toHaveBeenCalled();
    } finally {
      setAgentSdkCliMcpBridgeProvider(null);
    }
  });
});
