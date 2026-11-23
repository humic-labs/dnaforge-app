import { queryClaudeCode, queryCodex } from '../query';
import { userMessage } from '@waypoint/user-messages';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILT_IN_AGENT_PERMISSIONS } from '../../../shared/agent-permissions';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as childProcess from 'node:child_process';
import {
  DNAFORGE_CLI_SYSTEM_PROMPT,
  REFERENCE_SYSTEM_PROMPT,
} from '../../../shared/ai-reference-system-prompt';
import { requiredWorkspaceToolNames } from '../required-workspace-tools';
import { SidecarSessionAuthority } from '../../sidecar-session-authority';
import { createReadyCliMcpBridgeProvider } from '../cli-mcp-provider';

const privateProteinRenderer = vi.hoisted(() => vi.fn());
vi.mock('../../protein-experiment-workers', () => ({
  proteinExperimentRendererForTurn: privateProteinRenderer,
}));

const processProtection = vi.hoisted(() => ({
  prepare: vi.fn(),
  spawn: vi.fn(),
  wrap: vi.fn(),
  executable: vi.fn(),
  dispose: vi.fn(),
}));
const nativeProcesses = vi.hoisted(() => ({
  spawn: vi.fn(),
  originalSpawn: null as typeof childProcess.spawn | null,
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  nativeProcesses.originalSpawn = actual.spawn;
  nativeProcesses.spawn.mockImplementation(actual.spawn);
  return { ...actual, spawn: nativeProcesses.spawn };
});
vi.mock('../agent-process-confinement', () => ({
  prepareManagedAgentProcessConfinement: processProtection.prepare,
}));

const {
  mockDetectClaudeCode,
  mockDetectCodex,
  mockDetectGrok,
  mockReadCodexMcpServerNames,
  mockClaudeQuery,
  mockCodexConstructor,
  mockCodexStartThread,
  mockCodexResumeThread,
  mockCodexRun,
  mockCodexRunStreamed,
  mockLaunchLocalCodexAppServer,
  mockRunLocalCodexAppServerTurn,
  mockOpenGrokAcpClient,
  mockRunGrokAcpTurn,
  mockResolveClaudePluginInstallPath,
  mockResolveGrokPluginInstallPath,
  mockResolveGrokSkillSourcePath,
  mockResolveGrokSkillSourcePaths,
} = vi.hoisted(() => {
  const mockCodexRun = vi.fn();
  const mockCodexRunStreamed = vi.fn();
  const mockCodexStartThread = vi.fn(() => ({
    id: 'codex-thread-new',
    run: mockCodexRun,
    runStreamed: mockCodexRunStreamed,
  }));
  const mockCodexResumeThread = vi.fn(() => ({
    id: 'codex-thread-existing',
    run: mockCodexRun,
    runStreamed: mockCodexRunStreamed,
  }));
  const mockCodexConstructor = vi.fn(
    (_options: { config?: { developer_instructions?: string } } = {}) => ({
      startThread: mockCodexStartThread,
      resumeThread: mockCodexResumeThread,
    })
  );
  return {
    mockDetectClaudeCode: vi.fn(),
    mockDetectCodex: vi.fn(),
    mockDetectGrok: vi.fn(),
    mockReadCodexMcpServerNames: vi.fn(async () => [] as string[]),
    mockClaudeQuery: vi.fn(),
    mockCodexConstructor,
    mockCodexStartThread,
    mockCodexResumeThread,
    mockCodexRun,
    mockCodexRunStreamed,
    mockLaunchLocalCodexAppServer: vi.fn(),
    mockRunLocalCodexAppServerTurn: vi.fn(),
    mockOpenGrokAcpClient: vi.fn(),
    mockRunGrokAcpTurn: vi.fn(),
    mockResolveClaudePluginInstallPath: vi.fn(),
    mockResolveGrokPluginInstallPath: vi.fn(),
    mockResolveGrokSkillSourcePath: vi.fn(),
    mockResolveGrokSkillSourcePaths: vi.fn(),
  };
});

vi.mock('../detect', () => ({
  detectClaudeCode: mockDetectClaudeCode,
  detectCodex: mockDetectCodex,
  detectGrok: mockDetectGrok,
  readCodexConfiguredReasoningEffort: vi.fn(async () => null),
  readCodexConfiguredMcpServerNames: mockReadCodexMcpServerNames,
}));

vi.mock('../grok-acp', () => ({
  grokSessionUpdateAsTraceEvent: vi.fn((notification) => notification),
  createGrokSessionTraceProjector: vi.fn(() => ({
    project: (notification: unknown) => notification,
  })),
  openGrokAcpClient: mockOpenGrokAcpClient,
  runGrokAcpTurn: mockRunGrokAcpTurn,
}));

vi.mock('../local-codex-app-server', () => ({
  appServerNotificationAsCodexSdkEvent: vi.fn((notification) => notification),
  launchLocalCodexAppServer: mockLaunchLocalCodexAppServer,
  runLocalCodexAppServerTurn: mockRunLocalCodexAppServerTurn,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: mockClaudeQuery,
}));

vi.mock('@openai/codex-sdk', () => ({
  Codex: mockCodexConstructor,
}));

vi.mock('../../agent-capabilities/provider-operations', () => ({
  resolveClaudePluginInstallPath: mockResolveClaudePluginInstallPath,
  resolveGrokPluginInstallPath: mockResolveGrokPluginInstallPath,
  resolveGrokSkillSourcePath: mockResolveGrokSkillSourcePath,
  resolveGrokSkillSourcePaths: mockResolveGrokSkillSourcePaths,
}));

const TEST_CLI_MCP_API_URL = 'http://127.0.0.1:18099';
const TEST_DISCOVERED_TOOLS = [
  ...new Set([...requiredWorkspaceToolNames(), 'get_workspace']),
].sort();
const TEST_AUTO_ALLOWED_MCP_TOOLS = ['mcp__dnaforge__*'];

async function* claudeMessages(messages: unknown[]) {
  for (const message of messages) {
    yield message;
  }
}

const fakeCompanionDir = mkdtempSync(join(tmpdir(), 'fixture-query-companion-'));
const fakeCompanionScript = join(fakeCompanionDir, 'companion.cjs');
writeFileSync(
  fakeCompanionScript,
  `
const TOOLS = ${JSON.stringify(TEST_DISCOVERED_TOOLS)};
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf8');
  let i;
  while ((i = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'test-companion', version: '1' } } });
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS.map((n) => ({ name: n, inputSchema: { type: 'object' } })) } });
    } else if (msg.method === 'tools/call') {
      send({ jsonrpc: '2.0', id: msg.id, result: { isError: false, content: [{ type: 'text', text: '{"folders":[]}' }] } });
    }
  }
});
`,
  'utf8'
);

const cliMcpBridge = {
  apiUrl: TEST_CLI_MCP_API_URL,
  sessionToken: 'session-token',
  agentIdentityId: 'local-in-app-chat',
  capabilities: ['read-workspace', 'write-workspace', 'read-sequences', 'modify-tabs'],
  command: process.execPath,
  commandArgs: [fakeCompanionScript],
};

function stubPoisonedClaudeEnv(): void {
  vi.stubEnv('PATH', '/test/bin:/usr/bin');
  vi.stubEnv('HOME', '/Users/test');
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-invalid');
  vi.stubEnv('ANTHROPIC_NEWVAR', 'future-sdk-auth-var');
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'ambient-oauth');
  vi.stubEnv('CLAUDE_CODE_SESSION_ACCESS_TOKEN', 'ambient-session');
  vi.stubEnv('CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR', '9');
  vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '1');
  vi.stubEnv('CLAUDE_CODE_USE_VERTEX', '1');
  vi.stubEnv('CLAUDE_CODE_USE_FOUNDRY', '1');
  vi.stubEnv('CLAUDE_CODE_USE_ANTHROPIC_AWS', '1');
  vi.stubEnv('CLAUDE_CODE_USE_MANTLE', '1');
  vi.stubEnv('CLAUDE_CODE_REMOTE', '1');
  vi.stubEnv('CLAUDE_SESSION_INGRESS_TOKEN_FILE', '/tmp/ingress-token');
  vi.stubEnv('CLAUDE_CONFIG_DIR', '/tmp/claude-config');
  vi.stubEnv('CLAUDE_SECURESTORAGE_CONFIG_DIR', '/tmp/claude-secure');
}

function expectScrubbedClaudeEnv(env: Record<string, unknown> | undefined): void {
  expect(env).toMatchObject({
    PATH: '/test/bin:/usr/bin',
    HOME: '/Users/test',
    CLAUDE_CONFIG_DIR: '/tmp/claude-config',
    CLAUDE_SECURESTORAGE_CONFIG_DIR: '/tmp/claude-secure',
  });
  expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
  expect(env).not.toHaveProperty('ANTHROPIC_NEWVAR');
  expect(env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
  expect(env).not.toHaveProperty('CLAUDE_CODE_SESSION_ACCESS_TOKEN');
  expect(env).not.toHaveProperty('CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR');
  expect(env).not.toHaveProperty('CLAUDE_CODE_USE_BEDROCK');
  expect(env).not.toHaveProperty('CLAUDE_CODE_USE_VERTEX');
  expect(env).not.toHaveProperty('CLAUDE_CODE_USE_FOUNDRY');
  expect(env).not.toHaveProperty('CLAUDE_CODE_USE_ANTHROPIC_AWS');
  expect(env).not.toHaveProperty('CLAUDE_CODE_USE_MANTLE');
  expect(env).not.toHaveProperty('CLAUDE_CODE_REMOTE');
  expect(env).not.toHaveProperty('CLAUDE_SESSION_INGRESS_TOKEN_FILE');
}

describe('agent-sdk query transports', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nativeProcesses.spawn.mockReset().mockImplementation(nativeProcesses.originalSpawn!);
    processProtection.prepare.mockReset().mockImplementation(async (input) => ({
      cwd: input.purpose === 'chat' && input.cwd ? input.cwd : '/protected/scratch',
      scratchRoot: '/protected/scratch',
      spawn: processProtection.spawn,
      wrap: processProtection.wrap,
      executable: processProtection.executable,
      dispose: processProtection.dispose,
    }));
    processProtection.wrap.mockImplementation((command, args, env) => ({
      command: '/protected/sandbox',
      args: ['--', command, ...args],
      env: { ...env, DNAFORGE_TEST_CONFINED: 'true' },
    }));
    processProtection.executable.mockImplementation((_command, env) => ({
      path: '/protected/runtime-wrapper',
      env: { ...env, DNAFORGE_TEST_CONFINED: 'true' },
    }));
    privateProteinRenderer.mockReturnValue(undefined);
    mockReadCodexMcpServerNames.mockReset().mockResolvedValue([]);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          tools: TEST_DISCOVERED_TOOLS.map((name) => ({ name })),
        }),
      })
    );
    mockDetectClaudeCode.mockResolvedValue({
      cli: 'installed',
      path: '/usr/local/bin/claude',
      auth: 'authenticated',
      defaultModel: null,
      keychainEntryPresent: true,
      credentialsFilePresent: null,
    });
    mockDetectCodex.mockResolvedValue({
      cli: 'installed',
      path: '/usr/local/bin/codex',
      auth: 'authenticated',
      defaultModel: null,
      authMode: 'chatgpt',
      authFilePresent: true,
    });
    mockDetectGrok.mockResolvedValue({
      cli: 'installed',
      path: '/usr/local/bin/grok',
      auth: 'authenticated',
      defaultModel: null,
    });
    mockResolveClaudePluginInstallPath.mockResolvedValue('/claude/plugins/feature-dev');
    mockResolveGrokPluginInstallPath.mockResolvedValue('/grok/plugins/laboratory');
    mockResolveGrokSkillSourcePath.mockResolvedValue('/grok/skills/review/SKILL.md');
    mockResolveGrokSkillSourcePaths.mockResolvedValue([
      { nativeId: 'review', sourcePath: '/grok/skills/review/SKILL.md' },
      { nativeId: 'sequence-search', sourcePath: '/grok/skills/sequence-search/SKILL.md' },
    ]);
    mockCodexRun.mockResolvedValue({ finalResponse: 'CODEX_OK' });
    mockCodexRunStreamed.mockResolvedValue({
      events: claudeMessages([
        {
          type: 'item.completed',
          item: { id: 'msg-1', type: 'agent_message', text: 'CODEX_STREAM_OK' },
        },
        { type: 'turn.completed', usage: null },
      ]),
    });
    mockLaunchLocalCodexAppServer.mockResolvedValue({
      protocol: { client: ['model/list'] },
      supervisor: {
        request: vi.fn().mockResolvedValue({
          data: [
            {
              id: 'gpt-5.3-codex',
              displayName: 'GPT-5.3 Codex',
              isDefault: true,
              supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
              supportsPersonality: true,
              serviceTiers: [{ id: 'priority', name: 'Priority' }],
            },
          ],
          nextCursor: null,
        }),
        setNotificationListener: vi.fn(),
        setServerRequestHandler: vi.fn(),
        onExit: vi.fn(),
        interrupt: vi.fn(),
      },
      dispose: vi.fn(),
    });
    mockRunLocalCodexAppServerTurn.mockResolvedValue({
      ok: true,
      text: 'CODEX_APP_SERVER_OK',
      threadId: 'codex-app-thread',
      turnId: 'codex-app-turn',
    });
    mockOpenGrokAcpClient.mockReturnValue({
      rpc: { close: vi.fn() },
      processExited: Promise.resolve(),
      registerUpdateSink: vi.fn(),
      stderr: vi.fn(() => ''),
    });
    mockRunGrokAcpTurn.mockResolvedValue({
      ok: true,
      text: 'GROK_ACP_OK',
      sessionId: 'grok-session-new',
      stopReason: 'end_turn',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each(['claude', 'codex-sdk', 'codex-app-server', 'grok'] as const)(
    'fails before starting %s when filesystem protection is unavailable',
    async (route) => {
      processProtection.prepare.mockRejectedValueOnce(new Error('verified sandbox unavailable'));
      const { queryClaudeCode, queryCodex, queryGrok } = await import('../query');
      const query =
        route === 'claude' ? queryClaudeCode : route === 'grok' ? queryGrok : queryCodex;

      await expect(
        query('try every available execution route', {
          purpose: 'chat',
          cwd: '/workspace',
          toolExposure: 'none',
          ...(route === 'codex-app-server' ? { requestUserInput: vi.fn() } : {}),
        })
      ).resolves.toMatchObject({
        ok: false,
        stopState: 'failed',
        error: expect.stringContaining('verified sandbox unavailable'),
      });
      expect(processProtection.prepare).toHaveBeenCalledOnce();
      expect(mockClaudeQuery).not.toHaveBeenCalled();
      expect(mockCodexConstructor).not.toHaveBeenCalled();
      expect(mockLaunchLocalCodexAppServer).not.toHaveBeenCalled();
      expect(mockRunLocalCodexAppServerTurn).not.toHaveBeenCalled();
      expect(mockOpenGrokAcpClient).not.toHaveBeenCalled();
      expect(mockRunGrokAcpTurn).not.toHaveBeenCalled();
      expect(processProtection.wrap).not.toHaveBeenCalled();
      expect(processProtection.executable).not.toHaveBeenCalled();
    }
  );

  it('uses the outer process wrapper for the actual Codex app-server spawn', async () => {
    const child = { pid: 4162 } as childProcess.ChildProcess;
    const spawn = nativeProcesses.spawn.mockReturnValueOnce(child);
    const appServer = await mockLaunchLocalCodexAppServer.getMockImplementation()!();
    mockLaunchLocalCodexAppServer.mockImplementationOnce(async (options) => {
      expect(
        options.spawn('/usr/local/bin/codex', ['app-server'], {
          cwd: '/workspace',
          env: { PROVIDER_RUNTIME: 'codex' },
        })
      ).toBe(child);
      return appServer;
    });
    try {
      const { queryCodex } = await import('../query');
      await expect(
        queryCodex('inspect the project', {
          purpose: 'chat',
          cwd: '/workspace',
          toolExposure: 'none',
          requestUserInput: vi.fn(),
        })
      ).resolves.toMatchObject({ ok: true, text: 'CODEX_APP_SERVER_OK' });
      expect(processProtection.wrap).toHaveBeenCalledWith('/usr/local/bin/codex', ['app-server'], {
        PROVIDER_RUNTIME: 'codex',
      });
      expect(spawn).toHaveBeenCalledWith(
        '/protected/sandbox',
        ['--', '/usr/local/bin/codex', 'app-server'],
        {
          cwd: '/workspace',
          env: { PROVIDER_RUNTIME: 'codex', DNAFORGE_TEST_CONFINED: 'true' },
        }
      );
      expect(mockCodexConstructor).not.toHaveBeenCalled();
      expect(appServer.dispose).toHaveBeenCalledOnce();
      expect(processProtection.dispose).toHaveBeenCalledOnce();
    } finally {
      spawn.mockReset().mockImplementation(nativeProcesses.originalSpawn!);
    }
  });

  it('retains Grok process protection until its child exits after closing RPC', async () => {
    let finishProcess!: () => void;
    const processExited = new Promise<void>((resolve) => {
      finishProcess = resolve;
    });
    const opened = mockOpenGrokAcpClient.getMockImplementation()!();
    mockOpenGrokAcpClient.mockReturnValueOnce({ ...opened, processExited });
    const { queryGrok } = await import('../query');

    await expect(
      queryGrok('inspect the project', {
        purpose: 'chat',
        cwd: '/workspace',
        toolExposure: 'none',
      })
    ).resolves.toMatchObject({ ok: true });

    expect(opened.rpc.close).toHaveBeenCalledOnce();
    expect(processProtection.dispose).not.toHaveBeenCalled();
    finishProcess();
    await Promise.resolve();
    expect(processProtection.dispose).toHaveBeenCalledOnce();
  });

  it.each([
    ['authentication_failed', 'Sign in', 'authentication_required'],
    ['rate_limit', 'Try again later', 'provider_capacity'],
    ['invalid_request', 'Invalid request', 'provider_rejected'],
    ['server_error', 'Internal server error', 'provider_error'],
    ['server_error', 'Provider DNS error (ENOTFOUND)', 'dns_resolution_failed'],
    ['unknown', 'getaddrinfo ENOTFOUND fixture.invalid', 'dns_resolution_failed'],
    ['unknown', 'Unclassified condition', 'unknown'],
  ])(
    'retains a Claude %s failure through a trailing process exit',
    async (code, detail, reason) => {
      mockClaudeQuery.mockReturnValue(
        (async function* () {
          yield {
            type: 'assistant',
            error: code,
            message: { content: [{ type: 'text', text: detail }] },
          };
          yield {
            type: 'result',
            subtype: 'error_during_execution',
            is_error: true,
            errors: [detail],
          };
          throw new Error('Claude Code process exited with code 1');
        })()
      );
      expect(
        await queryClaudeCode('fixture', { purpose: 'chat', toolExposure: 'none', emitTrace: true })
      ).toMatchObject({
        ok: false,
        error: detail,
        failure: { reason, stage: 'provider_stream' },
      });
    }
  );

  it.each(['throw', 'recover'] as const)(
    'handles a Claude assistant error before %s',
    async (outcome) => {
      mockClaudeQuery.mockReturnValue(
        (async function* () {
          yield { type: 'assistant', error: 'rate_limit', message: { content: [] } };
          if (outcome === 'throw') throw new Error('Claude Code process exited with code 1');
          yield { type: 'result', subtype: 'success', result: 'Recovered' };
        })()
      );
      const value = await queryClaudeCode('fixture', {
        purpose: 'chat',
        toolExposure: 'none',
        emitTrace: true,
      });
      if (outcome === 'throw')
        expect(value).toMatchObject({
          ok: false,
          failure: { reason: 'provider_capacity', stage: 'provider_stream' },
        });
      else {
        expect(value).toMatchObject({ ok: true, text: 'Recovered' });
        expect(value.failure).toBeUndefined();
      }
    }
  );

  it('identifies a Codex account model rejection from the terminal SDK diagnostic', async () => {
    const message = 'This model is not supported with a ChatGPT account.';
    mockCodexRunStreamed.mockResolvedValue({
      events: (async function* () {
        yield { type: 'turn.failed', error: { message } };
        throw new Error('Codex Exec exited with code 1: local diagnostic');
      })(),
    });
    expect(
      await queryCodex('fixture', { purpose: 'chat', toolExposure: 'none', emitTrace: true })
    ).toMatchObject({
      ok: false,
      error: message,
      failure: { reason: 'provider_rejected', stage: 'provider_stream' },
    });
  });

  it.each([true, false])(
    'classifies blank chat output with completed tool = %s for both providers',
    async (completed) => {
      mockClaudeQuery.mockReturnValue(
        claudeMessages([
          ...(completed
            ? [{ type: 'user', message: { content: [{ type: 'tool_result', is_error: false }] } }]
            : []),
          { type: 'result', subtype: 'success', result: '' },
        ])
      );
      mockCodexRunStreamed.mockResolvedValue({
        events: claudeMessages([
          ...(completed
            ? [{ type: 'item.completed', item: { type: 'command_execution', status: 'completed' } }]
            : []),
          { type: 'turn.completed' },
        ]),
      });
      const options = { purpose: 'chat', toolExposure: 'none', emitTrace: true } as const;
      const expected = completed
        ? { ok: true }
        : { ok: false, failure: { reason: 'no_response', stage: 'provider_stream' } };
      for (const query of [queryClaudeCode, queryCodex])
        expect(await query('fixture', options)).toMatchObject(expected);
    }
  );

  it('does not duplicate Claude assistant text with the final result message', async () => {
    mockClaudeQuery.mockReturnValue(
      claudeMessages([
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'WAYPOINT_CLAUDE_UI_OK' }],
          },
        },
        { type: 'result', result: 'WAYPOINT_CLAUDE_UI_OK' },
      ])
    );

    const { queryClaudeCode } = await import('../query');
    const result = await queryClaudeCode('reply ok');

    expect(result).toMatchObject({
      transport: 'claude-agent-sdk',
      ok: true,
      text: 'WAYPOINT_CLAUDE_UI_OK',
    });
  });

  it('uses the Claude terminal result instead of a pre-tool assistant preamble', async () => {
    mockClaudeQuery.mockReturnValue(
      claudeMessages([
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: "I'll list the workspace files." }],
          },
        },
        { type: 'result', result: 'pUC19.gb is present.' },
      ])
    );

    const { queryClaudeCode } = await import('../query');
    const result = await queryClaudeCode('list files');

    expect(result).toMatchObject({
      transport: 'claude-agent-sdk',
      ok: true,
      text: 'pUC19.gb is present.',
    });
  });

  it('uses Claude assistant text when the terminal result is blank', async () => {
    mockClaudeQuery.mockReturnValue(
      claudeMessages([
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'The workspace contains pUC19.gb.' }],
          },
        },
        { type: 'result', result: '   ' },
      ])
    );

    const { queryClaudeCode } = await import('../query');
    const result = await queryClaudeCode('list files');

    expect(result).toMatchObject({
      transport: 'claude-agent-sdk',
      ok: true,
      text: 'The workspace contains pUC19.gb.',
    });
  });

  it('falls back to the Claude result message when no assistant text is emitted', async () => {
    mockClaudeQuery.mockReturnValue(claudeMessages([{ type: 'result', result: 'fallback ok' }]));

    const { queryClaudeCode } = await import('../query');
    const result = await queryClaudeCode('reply ok');

    expect(result).toMatchObject({
      transport: 'claude-agent-sdk',
      ok: true,
      text: 'fallback ok',
    });
  });

  it('passes scrubbed Claude CLI env for smoke and chat query subprocesses', async () => {
    stubPoisonedClaudeEnv();
    mockClaudeQuery.mockImplementation(() =>
      claudeMessages([{ type: 'result', result: 'env scrub ok' }])
    );

    const { queryClaudeCode } = await import('../query');
    await expect(queryClaudeCode('smoke probe')).resolves.toMatchObject({ ok: true });
    await expect(
      queryClaudeCode('chat turn', {
        purpose: 'chat',
        cwd: '/workspace',
        cliMcpBridge,
      })
    ).resolves.toMatchObject({ ok: true });

    expect(mockClaudeQuery).toHaveBeenCalledTimes(2);
    for (const [call] of mockClaudeQuery.mock.calls) {
      expectScrubbedClaudeEnv(call.options.env);
    }
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-invalid');
  });

  it('runs Claude chat turns with only the supervised DNAForge MCP bridge attached', async () => {
    mockClaudeQuery.mockReturnValue(claudeMessages([{ type: 'result', result: 'safe chat ok' }]));
    const abortController = new AbortController();

    const { queryClaudeCode } = await import('../query');
    await expect(
      queryClaudeCode('reason about lac operon import plan', {
        purpose: 'chat',
        cwd: '/workspace',
        queryId: 'session-claude-1',
        turnId: 'turn-claude-1',
        cliMcpBridge,
        abortController,
        permissionMode: 'app-supervised',
        model: 'claude-opus-4-20250514',
        modelReasoningEffort: 'max',
        modelServiceTier: 'fast',
        modelPersonality: 'explanatory',
      })
    ).resolves.toMatchObject({ ok: true, text: 'safe chat ok' });

    const call = mockClaudeQuery.mock.calls[0][0];
    expect(mockClaudeQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'reason about lac operon import plan',
        options: expect.objectContaining({
          pathToClaudeCodeExecutable: '/usr/local/bin/claude',
          cwd: '/workspace',
          abortController,
          permissionMode: 'dontAsk',
          model: 'claude-opus-4-20250514',
          effort: 'max',
          settings: { fastMode: true, outputStyle: 'explanatory' },
          allowedTools: TEST_AUTO_ALLOWED_MCP_TOOLS,
          settingSources: [],
          mcpServers: {
            dnaforge: expect.objectContaining({
              type: 'stdio',
              command: cliMcpBridge.command,
              args: cliMcpBridge.commandArgs,
              env: expect.objectContaining({
                DNAFORGE_API_URL: TEST_CLI_MCP_API_URL,
                DNAFORGE_MCP_SESSION_TOKEN: 'session-token',
                DNAFORGE_MCP_TURN_ID: 'turn-claude-1',
              }),
              alwaysLoad: true,
            }),
          },
        }),
      })
    );
    await expect(call.options.canUseTool('mcp__dnaforge__list_files')).resolves.toMatchObject({
      behavior: 'allow',
    });
    await expect(call.options.canUseTool('Bash')).resolves.toMatchObject({
      behavior: 'deny',
    });
  });

  it('installs the NUCLEAR permissive-by-default model on the built-in (native-cli) chat turn ', async () => {
    mockClaudeQuery.mockReturnValue(claudeMessages([{ type: 'result', result: 'native ok' }]));

    const { queryClaudeCode } = await import('../query');
    await expect(
      queryClaudeCode('use native cli policy', {
        purpose: 'chat',
        cwd: '/workspace',
        cliMcpBridge,
      })
    ).resolves.toMatchObject({ ok: true, text: 'native ok' });

    const call = mockClaudeQuery.mock.calls[0][0];
    expect(call.options.permissionMode).toBe('dontAsk');
    expect(call.options.settingSources).toEqual([]);
    expect(call.options.mcpServers).toMatchObject({
      dnaforge: expect.objectContaining({ type: 'stdio' }),
    });
    const { CLAUDE_NATIVE_CHAT_ALLOWED_TOOLS } = await import('../native-tool-capabilities');
    expect(call.options.allowedTools).toEqual([
      ...CLAUDE_NATIVE_CHAT_ALLOWED_TOOLS,
      ...TEST_AUTO_ALLOWED_MCP_TOOLS,
    ]);
    expect(call.options.canUseTool).toBeUndefined();
    expect(call.options.hooks).toBeUndefined();
  });

  it('retains outer filesystem protection when bypassPermissions skips provider prompts', async () => {
    mockClaudeQuery.mockReturnValue(claudeMessages([{ type: 'result', result: 'full ok' }]));
    const { queryClaudeCode } = await import('../query');
    await queryClaudeCode('change anything', {
      purpose: 'chat',
      cwd: '/workspace',
      cliMcpBridge,
      permissions: { ...BUILT_IN_AGENT_PERMISSIONS, claude: 'bypassPermissions' },
      userRoots: ['/workspace'],
      scratchRoot: '/scratch',
      confirmDestructiveFile: vi.fn(async () => 'once' as const),
    });

    const call = mockClaudeQuery.mock.calls[0][0];
    expect(call.options.permissionMode).toBe('bypassPermissions');
    expect(call.options.allowDangerouslySkipPermissions).toBe(true);
    expect(call.options.hooks).toBeUndefined();
    expect(call.options.sandbox).toBeUndefined();
    expect(call.options.spawnClaudeCodeProcess).toBe(processProtection.spawn);
    expect(processProtection.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'claude',
        cwd: '/workspace',
        purpose: 'chat',
        runtimeExecutable: '/usr/local/bin/claude',
      })
    );
    expect(processProtection.dispose).toHaveBeenCalledOnce();
  });

  it.each(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk'] as const)(
    'passes Claude permission mode %s straight to an interactive chat',
    async (mode) => {
      mockClaudeQuery.mockReturnValue(claudeMessages([{ type: 'result', result: 'mode ok' }]));
      const { queryClaudeCode } = await import('../query');
      await queryClaudeCode('run blast', {
        purpose: 'chat',
        cwd: '/data/chats/conv-1',
        cliMcpBridge,
        permissions: { ...BUILT_IN_AGENT_PERMISSIONS, claude: mode },
        requestUserInput: vi.fn(),
        writableRoots: ['/data/chats/conv-1', '/data/projects/a'],
      });

      const call = mockClaudeQuery.mock.calls[0][0];
      expect(call.options.permissionMode).toBe(mode);
      expect(call.options.allowDangerouslySkipPermissions).toBeUndefined();
      expect(call.options.sandbox).toBeUndefined();
    }
  );

  it('loads only the explicitly selected Claude plugin path for a turn', async () => {
    mockClaudeQuery.mockReturnValue(claudeMessages([{ type: 'result', result: 'plugin ok' }]));
    const { queryClaudeCode } = await import('../query');

    await expect(
      queryClaudeCode('use the selected extension', {
        purpose: 'chat',
        cwd: '/workspace',
        cliMcpBridge,
        selectedCapability: {
          id: 'claude-agent-sdk:plugin:feature-dev@official',
          provider: 'claude-agent-sdk',
          nativeId: 'feature-dev@official',
          kind: 'plugin',
          label: 'Feature development',
          description: 'Build features.',
          scope: 'workspace',
          effects: ['instructions'],
          availability: { state: 'supported' },
          stages: {
            advertised: true,
            discoverable: true,
            invocable: true,
            visible: true,
            deterministic: true,
            liveQualified: false,
          },
          source: 'claude-plugin-list',
        },
      })
    ).resolves.toMatchObject({ ok: true, text: 'plugin ok' });

    expect(mockResolveClaudePluginInstallPath).toHaveBeenCalledWith(
      'feature-dev@official',
      '/workspace'
    );
    expect(mockClaudeQuery.mock.calls[0][0].options).toMatchObject({
      settingSources: [],
      plugins: [{ type: 'local', path: '/claude/plugins/feature-dev' }],
    });
  });

  it('loads Claude settings only after an explicit native skill selection', async () => {
    mockClaudeQuery.mockReturnValue(claudeMessages([{ type: 'result', result: 'skill ok' }]));
    const { queryClaudeCode } = await import('../query');

    await queryClaudeCode('/tdd add a regression test', {
      purpose: 'chat',
      cwd: '/workspace',
      cliMcpBridge,
      selectedCapability: {
        id: 'claude-agent-sdk:skill:tdd',
        provider: 'claude-agent-sdk',
        nativeId: 'tdd',
        kind: 'skill',
        label: 'tdd',
        description: 'Write a failing test first.',
        scope: 'workspace',
        effects: ['instructions'],
        availability: { state: 'supported' },
        stages: {
          advertised: true,
          discoverable: true,
          invocable: true,
          visible: true,
          deterministic: true,
          liveQualified: false,
        },
        source: 'claude-supportedSkills',
      },
    });

    expect(mockClaudeQuery.mock.calls[0][0].options).toMatchObject({
      settingSources: ['user', 'project', 'local'],
      skills: ['tdd'],
    });
  });

  it('lets Claude choose among every enabled native skill without a manual selection', async () => {
    mockClaudeQuery.mockReturnValue(claudeMessages([{ type: 'result', result: 'automatic ok' }]));
    const { queryClaudeCode } = await import('../query');

    await queryClaudeCode('Review this primer pair.', {
      purpose: 'chat',
      cwd: '/workspace',
      cliMcpBridge,
      enabledNativeSkillIds: ['primer-review', 'sequence-search', 'primer-review'],
    });

    expect(mockClaudeQuery.mock.calls[0][0].options).toMatchObject({
      settingSources: ['user', 'project', 'local'],
      skills: ['primer-review', 'sequence-search'],
    });
  });

  it('bridges Claude AskUserQuestion through the app and resumes the same tool call', async () => {
    mockClaudeQuery.mockReturnValue(claudeMessages([{ type: 'result', result: 'continued' }]));
    const requestUserInput = vi.fn(async () => ({
      outcome: 'submitted' as const,
      answers: { 'question-0': { selectedOptionIds: ['option-0'] } },
    }));

    const { queryClaudeCode } = await import('../query');
    await queryClaudeCode('ask before continuing', {
      purpose: 'chat',
      cwd: '/workspace',
      cliMcpBridge,
      conversationId: 'conversation-question',
      requestUserInput,
    });

    const call = mockClaudeQuery.mock.calls[0][0];
    expect(call.options.permissionMode).toBe('default');
    const result = await call.options.canUseTool(
      'AskUserQuestion',
      {
        questions: [
          {
            question: 'Which method?',
            header: 'Method',
            options: [
              { label: 'Gibson', description: 'Overlap assembly' },
              { label: 'Golden Gate', description: 'Type IIS assembly' },
            ],
            multiSelect: false,
          },
        ],
      },
      {
        signal: new AbortController().signal,
        toolUseID: 'tool-question-1',
      }
    );
    expect(requestUserInput).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'claude-agent-sdk',
        conversationId: 'conversation-question',
      }),
      expect.any(AbortSignal)
    );
    expect(result).toMatchObject({
      behavior: 'allow',
      updatedInput: { answers: { 'Which method?': 'Gibson' } },
    });
  });

  it('bridges Claude ExitPlanMode through the same app-owned interaction channel', async () => {
    mockClaudeQuery.mockReturnValue(claudeMessages([{ type: 'result', result: 'continued' }]));
    const requestUserInput = vi.fn(async () => ({
      outcome: 'submitted' as const,
      answers: { 'plan-decision': { selectedOptionIds: ['approve'] } },
    }));

    const { queryClaudeCode } = await import('../query');
    await queryClaudeCode('plan before continuing', {
      purpose: 'chat',
      cwd: '/workspace',
      cliMcpBridge,
      conversationId: 'conversation-plan',
      requestUserInput,
    });

    const call = mockClaudeQuery.mock.calls[0][0];
    const result = await call.options.canUseTool(
      'ExitPlanMode',
      { plan: '1. Inspect\n2. Edit' },
      { signal: new AbortController().signal, toolUseID: 'tool-plan-1' }
    );
    expect(requestUserInput).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'claude-agent-sdk',
        conversationId: 'conversation-plan',
      }),
      expect.any(AbortSignal)
    );
    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: { plan: '1. Inspect\n2. Edit' },
    });
  });

  it('installs the destructive-file PreToolUse guardrail when a confirm callback is supplied ', async () => {
    mockClaudeQuery.mockReturnValue(claudeMessages([{ type: 'result', result: 'guarded ok' }]));

    const root = mkdtempSync(join(tmpdir(), 'fixture-query-guard-'));
    const scratchRoot = join(root, 'cli-scratch');
    const userRoot = join(root, 'workspace');
    mkdirSync(join(scratchRoot, 'session'), { recursive: true });
    mkdirSync(userRoot, { recursive: true });
    const existingUserFile = join(userRoot, 'design.gb');
    writeFileSync(existingUserFile, 'ORIGIN');

    const confirmDestructiveFile = vi.fn(async () => 'deny' as const);

    const { queryClaudeCode } = await import('../query');
    await queryClaudeCode('edit my files', {
      purpose: 'chat',
      cwd: userRoot,
      cliMcpBridge,
      userRoots: [userRoot],
      scratchRoot,
      confirmDestructiveFile,
    });

    const call = mockClaudeQuery.mock.calls[0][0];
    const hook = call.options.hooks?.PreToolUse?.[0]?.hooks?.[0];
    expect(typeof hook).toBe('function');

    const readOut = await hook(
      { tool_name: 'Read', tool_input: { file_path: existingUserFile } },
      'tu',
      { signal: new AbortController().signal }
    );
    expect(confirmDestructiveFile).not.toHaveBeenCalled();
    expect(readOut?.hookSpecificOutput?.permissionDecision).not.toBe('deny');

    const writeOut = await hook(
      { tool_name: 'Write', tool_input: { file_path: existingUserFile } },
      'tu',
      { signal: new AbortController().signal }
    );
    expect(confirmDestructiveFile).toHaveBeenCalledTimes(1);
    expect(writeOut?.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('keeps the built-in agent SDK options cwd-independent ', async () => {
    const { queryClaudeCode } = await import('../query');
    const shapes: Array<Record<string, unknown>> = [];
    for (const cwd of [null, '/workspace', '/Users/test/Sample Workspaces/example']) {
      mockClaudeQuery.mockReturnValueOnce(claudeMessages([{ type: 'result', result: 'ok' }]));
      await queryClaudeCode('turn', { purpose: 'chat', cwd, cliMcpBridge });
      const { options } = mockClaudeQuery.mock.calls[mockClaudeQuery.mock.calls.length - 1][0];
      shapes.push({
        permissionMode: options.permissionMode,
        settingSources: options.settingSources,
        allowedTools: options.allowedTools,
      });
    }
    expect(shapes[1]).toEqual(shapes[0]);
    expect(shapes[2]).toEqual(shapes[0]);
  });

  it('runs Codex chat turns with the supervised DNAForge MCP bridge and abort signal', async () => {
    mockDetectCodex.mockResolvedValue({
      cli: 'installed',
      path: '/usr/local/bin/codex',
      auth: 'authenticated',
      defaultModel: null,
      authMode: 'apikey',
      authFilePresent: true,
    });
    const abortController = new AbortController();
    const { queryCodex } = await import('../query');
    await expect(
      queryCodex('reason about pBR322 features', {
        purpose: 'chat',
        cwd: '/workspace',
        queryId: 'session-codex-1',
        turnId: 'turn-codex-1',
        cliMcpBridge,
        abortController,
        permissionMode: 'app-supervised',
        model: 'gpt-5-codex',
        modelReasoningEffort: 'high',
      })
    ).resolves.toMatchObject({ ok: true, text: 'CODEX_OK' });

    expect(mockCodexConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        codexPathOverride: '/protected/runtime-wrapper',
        env: expect.objectContaining({ DNAFORGE_TEST_CONFINED: 'true' }),
        config: expect.objectContaining({
          mcp_servers: {
            dnaforge: {
              command: cliMcpBridge.command,
              args: cliMcpBridge.commandArgs,
              env: expect.objectContaining({
                DNAFORGE_MCP_SESSION_TOKEN: 'session-token',
                DNAFORGE_MCP_TURN_ID: 'turn-codex-1',
              }),
              enabled: true,
              startup_timeout_sec: 120,
              required: true,
              default_tools_approval_mode: 'approve',
            },
          },
        }),
      })
    );
    expect(mockCodexStartThread).toHaveBeenCalledWith({
      workingDirectory: '/workspace',
      skipGitRepoCheck: true,
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      networkAccessEnabled: false,
      webSearchMode: 'disabled',
      model: 'gpt-5-codex',
      modelReasoningEffort: 'high',
    });
    expect(mockCodexRun).toHaveBeenCalledWith('reason about pBR322 features', {
      signal: abortController.signal,
    });
  });

  it.each([false, true])(
    'isolates inherited MCP servers on the actual Codex query projection (interactive=%s)',
    async (interactive) => {
      mockReadCodexMcpServerNames.mockResolvedValue(['slack', 'dnaforge', 'odd.name']);
      const { queryCodex } = await import('../query');
      await expect(
        queryCodex('inspect the current scientific workspace', {
          purpose: 'chat',
          cwd: '/workspace',
          cliMcpBridge,
          ...(interactive ? { requestUserInput: vi.fn() } : {}),
        })
      ).resolves.toMatchObject({ ok: true });
      expect(mockReadCodexMcpServerNames).toHaveBeenCalledWith(
        '/usr/local/bin/codex',
        expect.objectContaining({ cwd: '/workspace' })
      );
      const options = interactive
        ? mockRunLocalCodexAppServerTurn.mock.calls[0][0]
        : mockCodexConstructor.mock.calls[0][0];
      expect(options.config).toMatchObject({
        features: { plugins: false, apps: false },
        mcp_servers: {
          slack: { enabled: false },
          'odd.name': { enabled: false },
          dnaforge: { enabled: true, required: true, startup_timeout_sec: 120 },
        },
      });
    }
  );

  it('isolates inherited servers for tool-free app chat while preserving standalone probe configuration', async () => {
    mockReadCodexMcpServerNames.mockResolvedValue(['slack', 'dnaforge']);
    const { queryCodex } = await import('../query');
    await expect(
      queryCodex('what is two plus two?', {
        purpose: 'chat',
        cliMcpBridge,
        toolExposure: 'none',
      })
    ).resolves.toMatchObject({ ok: true });
    const appOptions = mockCodexConstructor.mock.calls.at(-1)?.[0];
    expect(appOptions?.config).toEqual(
      expect.objectContaining({
        mcp_servers: { slack: { enabled: false }, dnaforge: { enabled: false } },
        features: { plugins: false, apps: false },
      })
    );
    mockReadCodexMcpServerNames.mockClear();
    mockCodexConstructor.mockClear();
    await expect(queryCodex('connection probe')).resolves.toMatchObject({ ok: true });
    expect(mockReadCodexMcpServerNames).not.toHaveBeenCalled();
    expect(mockCodexConstructor).toHaveBeenCalledOnce();
    const probeOptions = mockCodexConstructor.mock.calls.at(-1)?.[0];
    expect(probeOptions?.config).toBeUndefined();
  });

  it('fails explicitly before a Codex app turn if effective MCP configuration cannot be read', async () => {
    mockReadCodexMcpServerNames.mockRejectedValue(new Error('Codex MCP configuration unavailable'));
    const { queryCodex } = await import('../query');
    await expect(
      queryCodex('inspect the current workspace', {
        purpose: 'chat',
        cwd: '/workspace',
        cliMcpBridge,
      })
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('MCP configuration unavailable'),
    });
    expect(mockCodexConstructor).not.toHaveBeenCalled();
    expect(mockRunLocalCodexAppServerTurn).not.toHaveBeenCalled();
  });

  it('uses a custom Codex-compatible executable without requiring the built-in detection result', async () => {
    mockDetectCodex.mockResolvedValue({
      cli: 'missing',
      path: null,
      auth: 'unauthenticated',
      defaultModel: null,
      authMode: null,
      authFilePresent: false,
    });
    const { queryCodex } = await import('../query');

    await expect(
      queryCodex('custom harness probe', {
        purpose: 'probe',
        binaryPathOverride: '/opt/lab/bin/codex',
      })
    ).resolves.toMatchObject({ ok: true, text: 'CODEX_OK' });
    expect(mockCodexConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ codexPathOverride: '/protected/runtime-wrapper' })
    );
    expect(processProtection.executable).toHaveBeenCalledWith(
      '/opt/lab/bin/codex',
      expect.any(Object)
    );
    expect(processProtection.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'codex', runtimeExecutable: '/opt/lab/bin/codex' })
    );
  });

  it('restricts a main-bound fresh protein author and rejects SDK fallback or resume', async () => {
    privateProteinRenderer.mockImplementation((turnId) =>
      turnId === 'private-author' ? {} : undefined
    );
    const { queryCodex } = await import('../query');
    const options = {
      purpose: 'chat' as const,
      turnId: 'private-author',
      cwd: '/scratch',
      cliMcpBridge,
    };
    await expect(queryCodex('fixed question', options)).resolves.toMatchObject({ ok: false });
    await expect(
      queryCodex('fixed question', {
        ...options,
        requestUserInput: vi.fn(),
        providerConversationId: 'prior-thread',
      })
    ).resolves.toMatchObject({ ok: false });
    expect(mockCodexConstructor).not.toHaveBeenCalled();
    expect(mockLaunchLocalCodexAppServer).not.toHaveBeenCalled();
    await expect(
      queryCodex('fixed question', { ...options, requestUserInput: vi.fn() })
    ).resolves.toMatchObject({ ok: true });
    expect(mockRunLocalCodexAppServerTurn).toHaveBeenCalledWith(
      expect.objectContaining({ molecularTrialAuthor: true })
    );
    expect(mockLaunchLocalCodexAppServer).toHaveBeenCalledWith(
      expect.objectContaining({ molecularTrialAuthor: true })
    );
  });

  it('uses App Server for interactive Codex chat turns so native requests are answerable', async () => {
    const abortController = new AbortController();
    const requestUserInput = vi.fn();
    const { queryCodex } = await import('../query');

    await expect(
      queryCodex('ask which assembly method to use and continue', {
        purpose: 'chat',
        cwd: '/workspace',
        conversationId: 'conversation-codex-interactive',
        providerConversationId: 'codex-thread-existing',
        cliMcpBridge,
        scratchRoot: '/app/cli-scratch',
        abortController,
        requestUserInput,
        model: 'gpt-5.3-codex',
        modelReasoningEffort: 'high',
        modelServiceTier: 'priority',
        modelPersonality: 'friendly',
        disabledNativeSkillIds: ['unsafe-old-skill', 'deprecated-skill'],
      })
    ).resolves.toMatchObject({
      ok: true,
      text: 'CODEX_APP_SERVER_OK',
      providerConversationId: 'codex-app-thread',
    });

    expect(mockCodexConstructor).not.toHaveBeenCalled();
    expect(mockLaunchLocalCodexAppServer).toHaveBeenCalledWith({
      binaryPath: '/usr/local/bin/codex',
      rootDir: '/protected/scratch',
      spawn: expect.any(Function),
    });
    expect(mockRunLocalCodexAppServerTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'ask which assembly method to use and continue',
        cwd: '/workspace',
        conversationId: 'conversation-codex-interactive',
        providerConversationId: 'codex-thread-existing',
        model: 'gpt-5.3-codex',
        effort: 'high',
        serviceTier: 'priority',
        personality: 'friendly',
        requestUserInput,
        signal: abortController.signal,
        developerInstructions: expect.stringContaining('DNAForge MCP tools'),
        config: expect.objectContaining({
          mcp_servers: expect.objectContaining({ dnaforge: expect.any(Object) }),
          features: expect.objectContaining({
            default_mode_request_user_input: true,
            exec_permission_approvals: true,
            apps: false,
            hooks: false,
            plugins: false,
            memories: false,
          }),
          skills: {
            config: [
              { name: 'deprecated-skill', enabled: false },
              { name: 'unsafe-old-skill', enabled: false },
            ],
          },
        }),
      })
    );
  });

  it('fails before the user turn if model discovery outlives its MCP generation', async () => {
    const authority = new SidecarSessionAuthority();
    authority.markReady(authority.prepareManagedSpawn('initial').generation);
    const provide = createReadyCliMcpBridgeProvider(authority, (snapshot) => ({
      ...cliMcpBridge,
      sessionToken: snapshot.token,
    }));
    const capturedBridge = await provide();
    let entered: () => void = () => {};
    let release: () => void = () => {};
    const discovering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dispose = vi.fn();
    mockLaunchLocalCodexAppServer.mockResolvedValueOnce({
      protocol: { client: ['model/list'] },
      supervisor: {
        request: vi.fn(async () => {
          entered();
          await blocked;
          return {
            data: [
              {
                id: 'gpt-5.3-codex',
                displayName: 'GPT-5.3 Codex',
                isDefault: true,
                supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
              },
            ],
            nextCursor: null,
          };
        }),
        setNotificationListener: vi.fn(),
        setServerRequestHandler: vi.fn(),
        onExit: vi.fn(),
        interrupt: vi.fn(),
      },
      dispose,
    });
    const { queryCodex } = await import('../query');
    const pending = queryCodex('use workspace tools', {
      purpose: 'chat',
      cliMcpBridge: capturedBridge,
      requestUserInput: vi.fn(),
    });
    await discovering;
    authority.markRestarting();
    authority.markReady(authority.prepareManagedSpawn('respawn').generation);
    release();
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('SIDECAR_SESSION_CHANGED'),
    });
    expect(mockRunLocalCodexAppServerTurn).not.toHaveBeenCalled();
    expect(mockCodexRun).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  for (const restarted of [false, true]) {
    it.each(['thread/start', 'thread/resume', 'turn/start'] as const)(
      `binds %s to the MCP generation after model discovery (restarted=${restarted})`,
      async (method) => {
        const authority = new SidecarSessionAuthority();
        authority.markReady(authority.prepareManagedSpawn('initial').generation);
        const provide = createReadyCliMcpBridgeProvider(authority, (snapshot) => ({
          ...cliMcpBridge,
          sessionToken: snapshot.token,
        }));
        const capturedBridge = await provide();
        let entered: () => void = () => {};
        let release: () => void = () => {};
        const discovering = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const blocked = new Promise<void>((resolve) => {
          release = resolve;
        });
        const request = vi.fn(async (requestedMethod: string) => {
          if (requestedMethod !== 'model/list') return {};
          entered();
          await blocked;
          return {
            data: [
              {
                id: 'gpt-5.3-codex',
                displayName: 'GPT-5.3 Codex',
                isDefault: true,
                supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
              },
            ],
            nextCursor: null,
          };
        });
        const dispose = vi.fn();
        mockLaunchLocalCodexAppServer.mockResolvedValueOnce({
          protocol: { client: ['model/list'] },
          supervisor: {
            request,
            setNotificationListener: vi.fn(),
            setServerRequestHandler: vi.fn(),
            onExit: vi.fn(),
            interrupt: vi.fn(),
          },
          dispose,
        });
        mockRunLocalCodexAppServerTurn.mockImplementation(
          async ({
            transport,
          }: Parameters<
            typeof import('../local-codex-app-server').runLocalCodexAppServerTurn
          >[0]) => {
            await transport.request(method, {});
            return {
              ok: true,
              text: 'CONTROLLED_MCP_GENERATION_ACCEPTED',
              threadId: 'controlled-thread',
              turnId: 'controlled-turn',
            };
          }
        );
        const { queryCodex } = await import('../query');
        const pending = queryCodex('use workspace tools', {
          purpose: 'chat',
          cliMcpBridge: capturedBridge,
          requestUserInput: vi.fn(),
        });
        await discovering;
        if (restarted) {
          authority.markRestarting();
          authority.markReady(authority.prepareManagedSpawn('respawn').generation);
        }
        release();
        if (restarted) {
          await expect(pending).resolves.toMatchObject({
            ok: false,
            error: expect.stringContaining('SIDECAR_SESSION_CHANGED'),
          });
          expect(request.mock.calls.map(([calledMethod]) => calledMethod)).toEqual(['model/list']);
        } else {
          await expect(pending).resolves.toMatchObject({
            ok: true,
            text: 'CONTROLLED_MCP_GENERATION_ACCEPTED',
          });
          expect(request.mock.calls.map(([calledMethod]) => calledMethod)).toEqual([
            'model/list',
            method,
          ]);
        }
        expect(mockCodexRun).not.toHaveBeenCalled();
        expect(dispose).toHaveBeenCalledTimes(1);
      }
    );
  }

  it('refuses a fresh empty catalog before any interactive provider turn', async () => {
    const dispose = vi.fn();
    mockLaunchLocalCodexAppServer.mockResolvedValueOnce({
      protocol: { client: ['model/list'] },
      supervisor: {
        request: vi.fn().mockResolvedValue({ data: [], nextCursor: null }),
        setNotificationListener: vi.fn(),
        setServerRequestHandler: vi.fn(),
        onExit: vi.fn(),
        interrupt: vi.fn(),
      },
      dispose,
    });
    const { queryCodex } = await import('../query');
    await expect(
      queryCodex('preserve this request', {
        purpose: 'chat',
        cwd: '/workspace',
        requestUserInput: vi.fn(),
      })
    ).resolves.toMatchObject({
      ok: false,
      text: '',
      failureReason: 'admission_rejected',
      error: expect.stringMatching(/models.*unavailable/i),
    });
    expect(mockRunLocalCodexAppServerTurn).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('rejects a stale Codex model and effort pair before starting the model turn', async () => {
    const dispose = vi.fn();
    mockLaunchLocalCodexAppServer.mockResolvedValueOnce({
      protocol: { client: ['model/list'] },
      supervisor: {
        request: vi.fn().mockResolvedValue({
          data: [
            {
              id: 'gpt-5.3-codex',
              displayName: 'GPT-5.3 Codex',
              hidden: false,
              isDefault: true,
              supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
              serviceTiers: [],
            },
          ],
          nextCursor: null,
        }),
        setNotificationListener: vi.fn(),
        setServerRequestHandler: vi.fn(),
        onExit: vi.fn(),
        interrupt: vi.fn(),
      },
      dispose,
    });
    const { queryCodex } = await import('../query');

    await expect(
      queryCodex('do not start this turn', {
        purpose: 'chat',
        cwd: '/workspace',
        cliMcpBridge,
        requestUserInput: vi.fn(),
        model: 'gpt-5.3-codex',
        modelReasoningEffort: 'ultra',
      })
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('does not support the “ultra” reasoning effort'),
    });
    expect(mockRunLocalCodexAppServerTurn).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('keeps interactive Codex chat on App Server while the optional tool bridge is starting', async () => {
    const requestUserInput = vi.fn();
    const { queryCodex } = await import('../query');

    await expect(
      queryCodex('answer an ordinary biology question', {
        purpose: 'chat',
        cwd: '/workspace',
        conversationId: 'conversation-codex-no-bridge',
        scratchRoot: '/app/cli-scratch',
        requestUserInput,
        toolExposure: 'auto',
      })
    ).resolves.toMatchObject({
      ok: true,
      text: 'CODEX_APP_SERVER_OK',
      providerConversationId: 'codex-app-thread',
    });

    expect(mockCodexConstructor).not.toHaveBeenCalled();
    expect(mockRunLocalCodexAppServerTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'answer an ordinary biology question',
        requestUserInput,
        config: expect.not.objectContaining({ mcp_servers: expect.anything() }),
      })
    );
  });

  it('runs Grok through ACP with the exact app MCP bridge, model controls, and question callback', async () => {
    const abortController = new AbortController();
    const requestUserInput = vi.fn();
    const { queryGrok } = await import('../query');

    await expect(
      queryGrok('ask which assembly method to use', {
        purpose: 'chat',
        cwd: '/workspace',
        conversationId: 'conversation-grok',
        providerConversationId: 'grok-session-existing',
        turnId: 'turn-grok-1',
        cliMcpBridge,
        abortController,
        requestUserInput,
        permissionMode: 'app-supervised',
        model: 'grok-code-fast-1',
        modelReasoningEffort: 'high',
      })
    ).resolves.toMatchObject({
      transport: 'grok-acp',
      ok: true,
      text: 'GROK_ACP_OK',
      providerConversationId: 'grok-session-new',
    });

    expect(mockOpenGrokAcpClient).toHaveBeenCalledWith(
      expect.objectContaining({
        binaryPath: '/usr/local/bin/grok',
        processConfinement: expect.objectContaining({
          wrap: processProtection.wrap,
          executable: processProtection.executable,
          spawn: processProtection.spawn,
        }),
        cwd: '/workspace',
        permissionMode: 'app-supervised',
        model: 'grok-code-fast-1',
        reasoningEffort: 'high',
        conversationId: 'conversation-grok',
        signal: abortController.signal,
        requestUserInput,
        systemPrompt: expect.stringContaining('DNAForge MCP tools'),
        runtimeRoot: expect.stringContaining('dnaforge-grok-runtime'),
      })
    );
    expect(mockRunGrokAcpTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/workspace',
        prompt: 'ask which assembly method to use',
        permissionMode: 'app-supervised',
        providerConversationId: 'grok-session-existing',
        model: 'grok-code-fast-1',
        reasoningEffort: 'high',
        signal: abortController.signal,
        mcpServer: expect.objectContaining({
          name: 'dnaforge',
          command: cliMcpBridge.command,
          args: cliMcpBridge.commandArgs,
          env: expect.arrayContaining([
            { name: 'DNAFORGE_MCP_SESSION_TOKEN', value: 'session-token' },
            { name: 'DNAFORGE_MCP_TURN_ID', value: 'turn-grok-1' },
          ]),
        }),
      })
    );
    expect(processProtection.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'grok', runtimeExecutable: '/usr/local/bin/grok' })
    );
  });

  it('loads only the explicitly selected Grok plugin directory for a turn', async () => {
    const { queryGrok } = await import('../query');

    await expect(
      queryGrok('inspect the construct', {
        purpose: 'probe',
        cwd: '/workspace',
        selectedCapability: {
          id: 'grok-acp:plugin:laboratory@abc123',
          provider: 'grok-acp',
          nativeId: 'laboratory@abc123',
          kind: 'plugin',
          label: 'Laboratory',
          description: 'Laboratory tools.',
          scope: 'installation',
          effects: ['instructions'],
          availability: { state: 'supported' },
          stages: {
            advertised: true,
            discoverable: true,
            invocable: true,
            visible: true,
            deterministic: true,
            liveQualified: false,
          },
          source: 'grok-plugin-list',
        },
      })
    ).resolves.toMatchObject({ ok: true });

    expect(mockResolveGrokPluginInstallPath).toHaveBeenCalledWith(
      'laboratory@abc123',
      '/protected/scratch'
    );
    expect(mockOpenGrokAcpClient).toHaveBeenCalledWith(
      expect.objectContaining({ pluginDirectories: ['/grok/plugins/laboratory'] })
    );
  });

  it('wraps only the explicitly selected Grok skill for a turn', async () => {
    const { queryGrok } = await import('../query');

    await expect(
      queryGrok('/review inspect the construct', {
        purpose: 'probe',
        cwd: '/workspace',
        selectedCapability: {
          id: 'grok-acp:skill:review',
          provider: 'grok-acp',
          nativeId: 'review',
          kind: 'skill',
          label: 'review',
          description: 'Review a construct.',
          scope: 'workspace',
          effects: ['instructions'],
          availability: { state: 'supported' },
          stages: {
            advertised: true,
            discoverable: true,
            invocable: true,
            visible: true,
            deterministic: true,
            liveQualified: false,
          },
          source: 'grok-inspect-skills',
        },
      })
    ).resolves.toMatchObject({ ok: true });

    expect(mockResolveGrokSkillSourcePath).toHaveBeenCalledWith('review', '/protected/scratch');
    expect(mockOpenGrokAcpClient).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedSkills: [{ nativeId: 'review', sourcePath: '/grok/skills/review/SKILL.md' }],
      })
    );
  });

  it('adapts app-library skills into Grok plugins and gives them precedence over same-named CLI skills', async () => {
    const { queryGrok } = await import('../query');
    mockResolveGrokSkillSourcePaths.mockImplementation(async (nativeIds: string[]) =>
      nativeIds.map((nativeId) => ({
        nativeId,
        sourcePath: `/grok/skills/${nativeId}/SKILL.md`,
      }))
    );

    await expect(
      queryGrok('Review this construct.', {
        purpose: 'probe',
        cwd: '/workspace',
        enabledNativeSkillIds: ['review', 'sequence-search', 'review'],
        portableSkills: [
          { name: 'review', sourcePath: '/app/skills/review/SKILL.md' },
          { name: 'review', sourcePath: '/ignored/duplicate/review/SKILL.md' },
        ],
      })
    ).resolves.toMatchObject({ ok: true });

    expect(mockResolveGrokSkillSourcePaths).toHaveBeenCalledWith(
      ['sequence-search'],
      '/protected/scratch'
    );
    expect(mockOpenGrokAcpClient).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedSkills: [
          { nativeId: 'review', sourcePath: '/app/skills/review/SKILL.md' },
          { nativeId: 'sequence-search', sourcePath: '/grok/skills/sequence-search/SKILL.md' },
        ],
      })
    );
  });

  it('resumes a Codex thread with the current turn configuration and returns its opaque id', async () => {
    const { queryCodex } = await import('../query');

    await expect(
      queryCodex('follow-up only', {
        purpose: 'chat',
        cwd: '/workspace',
        turnId: 'turn-codex-resumed',
        cliMcpBridge,
        permissionMode: 'app-supervised',
        providerConversationId: 'codex-thread-existing',
      })
    ).resolves.toMatchObject({
      ok: true,
      providerConversationId: 'codex-thread-existing',
    });

    expect(mockCodexStartThread).not.toHaveBeenCalled();
    expect(mockCodexResumeThread).toHaveBeenCalledWith(
      'codex-thread-existing',
      expect.objectContaining({
        workingDirectory: '/workspace',
        sandboxMode: 'read-only',
      })
    );
    expect(mockCodexRun).toHaveBeenCalledWith('follow-up only', undefined);
  });

  it('passes Claude resume and returns the provider session id', async () => {
    mockClaudeQuery.mockReturnValue(
      claudeMessages([
        {
          type: 'result',
          result: 'continued',
          session_id: 'claude-session-existing',
        },
      ])
    );
    const { queryClaudeCode } = await import('../query');

    await expect(
      queryClaudeCode('follow-up only', {
        purpose: 'chat',
        cwd: '/workspace',
        turnId: 'turn-claude-resumed',
        cliMcpBridge,
        providerConversationId: 'claude-session-existing',
      })
    ).resolves.toMatchObject({
      ok: true,
      text: 'continued',
      providerConversationId: 'claude-session-existing',
    });

    expect(mockClaudeQuery.mock.calls[0][0].options).toMatchObject({
      resume: 'claude-session-existing',
    });
  });

  it('streams Codex provider-native events and extracts the final text from trace items', async () => {
    const traceSink = vi.fn();
    const { queryCodex } = await import('../query');

    await expect(
      queryCodex('stream trace please', {
        purpose: 'chat',
        cwd: '/workspace',
        cliMcpBridge,
        emitTrace: true,
        traceSink,
      })
    ).resolves.toMatchObject({
      ok: true,
      text: 'CODEX_STREAM_OK',
      stopState: 'completed',
    });

    expect(mockCodexRun).not.toHaveBeenCalled();
    expect(mockCodexRunStreamed).toHaveBeenCalledWith('stream trace please', undefined);
    expect(traceSink).toHaveBeenCalledWith(
      expect.objectContaining({
        transport: 'codex-sdk',
        providerEventType: 'item.completed',
        providerItemType: 'agent_message',
        display: expect.objectContaining({
          kind: 'assistant_text',
          text: 'CODEX_STREAM_OK',
        }),
      })
    );
  });

  it('does not turn a nonfatal Codex diagnostic error item into a failed completed turn', async () => {
    mockCodexRunStreamed.mockResolvedValue({
      events: claudeMessages([
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'turn.started' },
        {
          type: 'item.completed',
          item: {
            id: 'warning-1',
            type: 'error',
            message:
              'Skill descriptions were shortened to fit the skills context budget. Codex can still see every skill, but some descriptions are shorter. Disable unused skills or plugins to leave more room for the rest.',
          },
        },
        {
          type: 'item.completed',
          item: { id: 'msg-1', type: 'agent_message', text: 'Completed answer' },
        },
        { type: 'turn.completed', usage: null },
      ]),
    });

    const traceSink = vi.fn();
    const { queryCodex } = await import('../query');
    await expect(
      queryCodex('complete despite diagnostic warning', {
        purpose: 'chat',
        cwd: '/workspace',
        cliMcpBridge,
        emitTrace: true,
        traceSink,
      })
    ).resolves.toMatchObject({
      ok: true,
      text: 'Completed answer',
      stopState: 'completed',
    });
    expect(traceSink).toHaveBeenCalledWith(
      expect.objectContaining({
        display: expect.objectContaining({
          kind: 'lifecycle',
          title: userMessage('assistant.notice'),
          visibility: 'diagnostic',
        }),
      })
    );
  });

  it('defaults Codex chat turns to workspace-write CLI permissions', async () => {
    const { queryCodex } = await import('../query');
    await expect(
      queryCodex('native mode', {
        purpose: 'chat',
        cwd: '/workspace',
        cliMcpBridge,
      })
    ).resolves.toMatchObject({ ok: true });

    expect(mockCodexStartThread).toHaveBeenCalledWith({
      workingDirectory: '/workspace',
      skipGitRepoCheck: true,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
    });
  });

  it('installs the app-owned Codex Bash hook when shell supervision can ask', async () => {
    const confirmDestructiveFile = vi.fn(async () => 'deny' as const);
    const { queryCodex } = await import('../query');

    await expect(
      queryCodex('run a guarded command', {
        purpose: 'chat',
        cwd: '/workspace',
        cliMcpBridge,
        shellSupervision: 'destructive-only',
        scratchRoot: '/app/cli-scratch',
        userRoots: ['/workspace'],
        confirmDestructiveFile,
      })
    ).resolves.toMatchObject({ ok: true });

    expect(mockCodexConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          ELECTRON_RUN_AS_NODE: '1',
          DNAFORGE_AGENT_PERMISSION_URL: expect.stringMatching(
            /^http:\/\/127\.0\.0\.1:\d+\/pre-tool-use$/
          ),
          DNAFORGE_AGENT_PERMISSION_TOKEN: expect.any(String),
        }),
        config: expect.objectContaining({
          features: { hooks: true, plugins: false, apps: false },
          hooks: expect.objectContaining({
            PreToolUse: [
              expect.objectContaining({
                matcher: '^Bash$',
                hooks: [
                  expect.objectContaining({
                    type: 'command',
                    command: expect.stringMatching(/dnaforge-codex-hook-.*pre-tool-use\.cjs/),
                  }),
                ],
              }),
            ],
          }),
        }),
      })
    );
  });

  it('fails visibly instead of silently substituting an unsupported Codex model', async () => {
    const { queryCodex } = await import('../query');
    await expect(
      queryCodex('use the selected model', {
        purpose: 'chat',
        cwd: '/workspace',
        cliMcpBridge,
        model: 'gpt-5-codex',
      })
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining(
        'The selected Codex model "gpt-5-codex" is not available with ChatGPT-account authentication'
      ),
    });

    expect(mockCodexStartThread).not.toHaveBeenCalled();
  });

  it('starts ordinary auto-exposure chat turns when the CLI bridge is unavailable', async () => {
    const { queryCodex, queryClaudeCode } = await import('../query');
    mockClaudeQuery.mockReturnValue(claudeMessages([{ type: 'result', result: 'four' }]));

    await expect(queryCodex('what is two plus two?', { purpose: 'chat' })).resolves.toMatchObject({
      ok: true,
      text: 'CODEX_OK',
    });
    await expect(
      queryClaudeCode('what is two plus two?', { purpose: 'chat' })
    ).resolves.toMatchObject({
      ok: true,
      text: 'four',
    });
    expect(mockCodexConstructor).toHaveBeenCalled();
    expect(mockClaudeQuery).toHaveBeenCalled();
  });

  it('does not run the diagnostic companion before an auto-exposure turn', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('diagnostic unavailable')));
    mockClaudeQuery.mockReturnValue(claudeMessages([{ type: 'result', result: 'four' }]));
    const unavailableDiagnosticBridge = {
      ...cliMcpBridge,
      command: '/missing/dnaforge-mcp-companion',
    };

    const { queryClaudeCode } = await import('../query');
    await expect(
      queryClaudeCode('what is two plus two?', {
        purpose: 'chat',
        cliMcpBridge: unavailableDiagnosticBridge,
        toolExposure: 'auto',
      })
    ).resolves.toMatchObject({ ok: true, text: 'four' });

    expect(fetch).not.toHaveBeenCalled();
    expect(mockClaudeQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          mcpServers: expect.objectContaining({
            dnaforge: expect.objectContaining({ command: '/missing/dnaforge-mcp-companion' }),
          }),
        }),
      })
    );
  });

  it('keeps a blocking diagnostic for explicitly required tool workflows', async () => {
    const { queryCodex } = await import('../query');

    await expect(
      queryCodex('import NC_001416', { purpose: 'chat', toolExposure: 'required' })
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('DNAForge CLI tool bridge is not available'),
    });
    expect(mockCodexConstructor).not.toHaveBeenCalled();
  });

  it('omits the MCP server entirely for explicit tool-free turns', async () => {
    mockClaudeQuery.mockReturnValue(claudeMessages([{ type: 'result', result: 'four' }]));
    const { queryClaudeCode } = await import('../query');

    await expect(
      queryClaudeCode('what is two plus two?', {
        purpose: 'chat',
        cliMcpBridge,
        toolExposure: 'none',
      })
    ).resolves.toMatchObject({ ok: true, text: 'four' });

    expect(mockClaudeQuery.mock.calls[0][0].options.mcpServers).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('injects the DNAForge system prompt into Claude chat turns (UNIT A6)', async () => {
    const { DNAFORGE_CLI_SYSTEM_PROMPT } = await import('../query');
    mockClaudeQuery.mockReturnValue(claudeMessages([{ type: 'result', result: 'ok' }]));

    const { queryClaudeCode } = await import('../query');
    await expect(
      queryClaudeCode('what is this sequence?', {
        purpose: 'chat',
        cwd: '/workspace',
        cliMcpBridge,
      })
    ).resolves.toMatchObject({ ok: true });

    const { options } = mockClaudeQuery.mock.calls[0][0];
    expect(options.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: DNAFORGE_CLI_SYSTEM_PROMPT,
    });
    expect(options.systemPrompt.append).toContain('DNAForge MCP tools');
    expect(options.systemPrompt.append).toContain(
      'Do not replace supported app operations with shell parsing'
    );
    expect(options.systemPrompt.append).toContain('do not hand-parse those documents');
    expect(options.systemPrompt.append).toContain('use command-line bioinformatics tools');
    expect(options.systemPrompt.append).toContain(REFERENCE_SYSTEM_PROMPT);
    expect(options.systemPrompt.append).toContain('color_variant_protein');
    expect(options.systemPrompt.append).toContain('DNAForge automatically embeds the saved view');
  });

  it('adds user-configured instructions to both CLI system-prompt forms', async () => {
    const { queryClaudeCode, queryCodex } = await import('../query');
    mockClaudeQuery.mockReturnValue(claudeMessages([{ type: 'result', result: 'ok' }]));
    const options = {
      purpose: 'chat' as const,
      cwd: '/workspace',
      cliMcpBridge,
      additionalAgentInstructions: 'Prefer short paragraphs.',
    };

    await queryClaudeCode('hello', options);
    expect(mockClaudeQuery.mock.calls[0][0].options.systemPrompt.append).toContain(
      'Prefer short paragraphs.'
    );
    await queryCodex('hello', options);
    expect(mockCodexConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          developer_instructions: expect.stringContaining('Prefer short paragraphs.'),
        }),
      })
    );
  });

  it('forwards the selected native Grok permission mode to its client', async () => {
    const { queryGrok } = await import('../query');
    for (const grok of ['default', 'plan', 'auto', 'bypassPermissions']) {
      mockOpenGrokAcpClient.mockClear();
      await queryGrok('hello', {
        purpose: 'chat',
        cwd: '/workspace',
        permissionMode: 'native-cli',
        permissions: { ...BUILT_IN_AGENT_PERMISSIONS, grok },
      });
      expect(mockOpenGrokAcpClient).toHaveBeenCalledWith(
        expect.objectContaining({ permissionMode: 'native-cli', grokMode: grok })
      );
    }
  });

  it('places app-owned turn instructions after app rules and user preferences for every CLI', async () => {
    const { queryClaudeCode, queryCodex, queryGrok } = await import('../query');
    mockClaudeQuery.mockReturnValue(claudeMessages([{ type: 'result', result: 'ok' }]));
    const options = {
      purpose: 'chat' as const,
      cwd: '/workspace',
      cliMcpBridge,
      additionalAgentInstructions: 'Prefer short paragraphs.',
      runtimeAgentInstructions: 'Read skill://primer-review/SKILL.md before answering.',
    };

    await queryClaudeCode('hello', options);
    await queryCodex('hello', options);
    await queryGrok('hello', options);

    const claudePrompt = mockClaudeQuery.mock.calls[0][0].options.systemPrompt.append as string;
    const codexPrompt =
      mockCodexConstructor.mock.calls[0]?.[0]?.config?.developer_instructions ?? '';
    const grokPrompt = mockOpenGrokAcpClient.mock.calls[0][0].systemPrompt as string;
    for (const prompt of [claudePrompt, codexPrompt, grokPrompt]) {
      expect(prompt.indexOf(DNAFORGE_CLI_SYSTEM_PROMPT)).toBe(0);
      expect(prompt.indexOf('User-configured additional instructions:')).toBeGreaterThan(
        prompt.indexOf(DNAFORGE_CLI_SYSTEM_PROMPT)
      );
      expect(prompt.indexOf('DNAForge app-owned instructions for this turn:')).toBeGreaterThan(
        prompt.indexOf('User-configured additional instructions:')
      );
      expect(prompt).toContain('Read skill://primer-review/SKILL.md before answering.');
      expect(prompt).toMatch(/app rules win\.\s*$/u);
    }
  });

  it('does not force a workspace tool before Claude can answer a general question', async () => {
    const { queryClaudeCode } = await import('../query');
    mockClaudeQuery.mockReturnValue(claudeMessages([{ type: 'result', result: 'ok' }]));

    await expect(
      queryClaudeCode('what is two plus two?', {
        purpose: 'chat',
        cwd: '/workspace',
        cliMcpBridge,
        workspaceGrounding: 'required',
      })
    ).resolves.toMatchObject({ ok: true });

    const { options } = mockClaudeQuery.mock.calls[0][0];
    expect(options.systemPrompt.append).not.toContain('Before writing ANY assistant prose');
    expect(options.systemPrompt.append).not.toContain('even when the user asks a general question');
  });

  it('does not attach the DNAForge system prompt to Claude smoke/probe turns (UNIT A6)', async () => {
    mockClaudeQuery.mockReturnValue(claudeMessages([{ type: 'result', result: 'ok' }]));

    const { queryClaudeCode } = await import('../query');
    await expect(queryClaudeCode('smoke probe')).resolves.toMatchObject({ ok: true });

    const { options } = mockClaudeQuery.mock.calls[0][0];
    expect(options.systemPrompt).toBeUndefined();
  });

  it('injects the DNAForge system prompt into Codex chat turns as developer_instructions (UNIT A6)', async () => {
    const { DNAFORGE_CLI_SYSTEM_PROMPT, queryCodex } = await import('../query');
    await expect(
      queryCodex('what is this sequence?', {
        purpose: 'chat',
        cwd: '/workspace',
        cliMcpBridge,
      })
    ).resolves.toMatchObject({ ok: true });

    expect(mockCodexConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          developer_instructions: DNAFORGE_CLI_SYSTEM_PROMPT,
          mcp_servers: expect.objectContaining({ dnaforge: expect.anything() }),
        }),
      })
    );
    expect(DNAFORGE_CLI_SYSTEM_PROMPT).toContain('DNAForge MCP tools');
    expect(DNAFORGE_CLI_SYSTEM_PROMPT).toContain('STRUCTURE IDENTITY IS NATIVE');
    expect(DNAFORGE_CLI_SYSTEM_PROMPT).toContain('measured.residues');
    expect(DNAFORGE_CLI_SYSTEM_PROMPT).toContain('one object per selected coordinate');
    expect(DNAFORGE_CLI_SYSTEM_PROMPT).toContain(
      'NEVER translate linked DNA to infer or replace residue identity'
    );
    expect(DNAFORGE_CLI_SYSTEM_PROMPT).toContain('mol_get_state');
    expect(DNAFORGE_CLI_SYSTEM_PROMPT).toContain('mol_set_representation');
    expect(DNAFORGE_CLI_SYSTEM_PROMPT).toContain('visible ACTIONS');
    expect(DNAFORGE_CLI_SYSTEM_PROMPT).toContain('completed tool result');
    expect(DNAFORGE_CLI_SYSTEM_PROMPT).toContain('create_reference');
    expect(DNAFORGE_CLI_SYSTEM_PROMPT).toContain('typed selection');
    expect(DNAFORGE_CLI_SYSTEM_PROMPT).toContain(REFERENCE_SYSTEM_PROMPT);
    expect(DNAFORGE_CLI_SYSTEM_PROMPT.replace(/\s+/g, ' ')).toContain(
      'issue create_reference calls in exactly that order'
    );
    expect(DNAFORGE_CLI_SYSTEM_PROMPT).toContain('do not prioritize staged references');
  });

  it('does not force a workspace tool before Codex can answer a general question', async () => {
    const { queryCodex } = await import('../query');

    await expect(
      queryCodex('what is two plus two?', {
        purpose: 'chat',
        cwd: '/workspace',
        cliMcpBridge,
        workspaceGrounding: 'required',
      })
    ).resolves.toMatchObject({ ok: true });

    const config = mockCodexConstructor.mock.calls.at(-1)?.[0]?.config;
    expect(config?.developer_instructions).not.toContain('Before writing ANY assistant prose');
    expect(config?.developer_instructions).not.toContain(
      'even when the user asks a general question'
    );
  });

  it('does not attach developer_instructions to Codex probe turns (UNIT A6)', async () => {
    const { queryCodex } = await import('../query');
    await expect(queryCodex('probe')).resolves.toMatchObject({ ok: true });

    expect(mockCodexConstructor).toHaveBeenCalledTimes(1);
    expect(mockCodexConstructor).not.toHaveBeenCalledWith(
      expect.objectContaining({ config: expect.anything() })
    );
  });

  it('returns a stopped result when Codex aborts the underlying child process', async () => {
    const abortController = new AbortController();
    mockCodexRun.mockImplementation(async () => {
      abortController.abort();
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    });

    const { queryCodex } = await import('../query');
    await expect(
      queryCodex('long task', {
        purpose: 'chat',
        cwd: '/workspace',
        cliMcpBridge,
        abortController,
      })
    ).resolves.toMatchObject({
      ok: false,
      error: 'Stop requested.',
      stopState: 'stop_requested',
    });
  });
});

describe('resolveCodexReasoningEffort', () => {
  it('an explicit in-app request wins over the user config', async () => {
    const { resolveCodexReasoningEffort } = await import('../query');
    expect(resolveCodexReasoningEffort('low', 'ultra')).toEqual({ effort: 'low' });
  });

  it('a VALID configured value is respected (no redundant override)', async () => {
    const { resolveCodexReasoningEffort } = await import('../query');
    for (const valid of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
      expect(resolveCodexReasoningEffort(null, valid)).toEqual({ effort: undefined });
    }
    expect(resolveCodexReasoningEffort(null, 'HIGH')).toEqual({ effort: undefined });
  });

  it('an OUT-OF-RANGE configured value is normalized so the turn can start', async () => {
    const { resolveCodexReasoningEffort } = await import('../query');
    expect(resolveCodexReasoningEffort(null, 'maximum')).toEqual({
      effort: 'high',
      normalizedFrom: 'maximum',
    });
  });

  it('nothing configured and nothing requested adds no override', async () => {
    const { resolveCodexReasoningEffort } = await import('../query');
    expect(resolveCodexReasoningEffort(null, null)).toEqual({ effort: undefined });
    expect(resolveCodexReasoningEffort(undefined, '  ')).toEqual({ effort: undefined });
  });

  it("passes the current Codex 'max' and 'ultra' values through", async () => {
    const { resolveCodexReasoningEffort } = await import('../query');
    expect(resolveCodexReasoningEffort('max', null)).toEqual({ effort: 'max' });
    expect(resolveCodexReasoningEffort('ultra', null)).toEqual({ effort: 'ultra' });
  });
});

describe('resolveCodexModelOverride', () => {
  it('drops known unsupported overrides for ChatGPT auth', async () => {
    const { resolveCodexModelOverride } = await import('../query');
    expect(resolveCodexModelOverride('gpt-5', 'chatgpt')).toEqual({
      model: undefined,
      ignored: 'gpt-5',
    });
    expect(resolveCodexModelOverride('o3', 'chatgpt')).toEqual({
      model: undefined,
      ignored: 'o3',
    });
  });

  it('preserves API-key and custom model overrides', async () => {
    const { resolveCodexModelOverride } = await import('../query');
    expect(resolveCodexModelOverride('gpt-5-codex', 'apikey')).toEqual({
      model: 'gpt-5-codex',
      ignored: undefined,
    });
    expect(resolveCodexModelOverride('future-chatgpt-model', 'chatgpt')).toEqual({
      model: 'future-chatgpt-model',
      ignored: undefined,
    });
  });
});
