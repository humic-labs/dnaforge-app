import { afterEach, describe, expect, it, vi } from 'vitest';
import { authenticateAgentCli, type AuthProcessRunner } from '../auth';
import type { AgentSdkDetection } from '../detect';

function detection(overrides: Partial<AgentSdkDetection> = {}): AgentSdkDetection {
  return {
    claudeCode: {
      cli: 'installed',
      path: '/usr/local/bin/claude',
      auth: 'unauthenticated',
      defaultModel: null,
      keychainEntryPresent: false,
      credentialsFilePresent: null,
    },
    codex: {
      cli: 'installed',
      path: '/usr/local/bin/codex',
      auth: 'unauthenticated',
      defaultModel: null,
      authMode: null,
      authFilePresent: false,
    },
    grok: {
      cli: 'installed',
      path: '/usr/local/bin/grok',
      auth: 'unauthenticated',
      defaultModel: null,
      availableModels: [],
    },
    ...overrides,
  };
}

function stubPoisonedClaudeEnv(): void {
  vi.stubEnv('PATH', '/test/bin:/usr/bin');
  vi.stubEnv('HOME', '/Users/test');
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-invalid');
  vi.stubEnv('ANTHROPIC_NEWVAR', 'future-sdk-auth-var');
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'ambient-oauth');
  vi.stubEnv('CLAUDE_CODE_SESSION_ACCESS_TOKEN', 'ambient-session');
  vi.stubEnv('CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR', '9');
  vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '1');
  vi.stubEnv('CLAUDE_CODE_REMOTE', '1');
  vi.stubEnv('CLAUDE_SESSION_INGRESS_TOKEN_FILE', '/tmp/ingress-token');
  vi.stubEnv('CLAUDE_CONFIG_DIR', '/tmp/claude-config');
  vi.stubEnv('CLAUDE_SECURESTORAGE_CONFIG_DIR', '/tmp/claude-secure');
}

function expectScrubbedClaudeEnv(env: NodeJS.ProcessEnv | undefined): void {
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
  expect(env).not.toHaveProperty('CLAUDE_CODE_REMOTE');
  expect(env).not.toHaveProperty('CLAUDE_SESSION_INGRESS_TOKEN_FILE');
}

function stubPoisonedCodexEnv(): void {
  vi.stubEnv('PATH', '/test/bin:/usr/bin');
  vi.stubEnv('HOME', '/Users/test');
  vi.stubEnv('OPENAI_API_KEY', 'sk-openai-invalid');
  vi.stubEnv('OPENAI_BASE_URL', 'https://ambient.example/v1');
  vi.stubEnv('OPENAI_NEWVAR', 'future-openai-auth-var');
  vi.stubEnv('CODEX_API_KEY', 'codex-ambient-key');
  vi.stubEnv('CODEX_HOME', '/Users/test/.codex');
}

function expectScrubbedCodexEnv(env: NodeJS.ProcessEnv | undefined): void {
  expect(env).toMatchObject({
    PATH: '/test/bin:/usr/bin',
    HOME: '/Users/test',
    CODEX_HOME: '/Users/test/.codex',
  });
  expect(env).not.toHaveProperty('OPENAI_API_KEY');
  expect(env).not.toHaveProperty('OPENAI_BASE_URL');
  expect(env).not.toHaveProperty('OPENAI_NEWVAR');
  expect(env).not.toHaveProperty('CODEX_API_KEY');
}

describe('agent CLI auth runner', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('launches Codex login with a scrubbed env and reports success after detection turns authenticated', async () => {
    stubPoisonedCodexEnv();
    const detect = vi
      .fn()
      .mockResolvedValueOnce(detection())
      .mockResolvedValueOnce(
        detection({
          codex: {
            cli: 'installed',
            path: '/usr/local/bin/codex',
            auth: 'authenticated',
            defaultModel: null,
            authMode: 'chatgpt',
            authFilePresent: true,
          },
        })
      );
    let receivedEnv: NodeJS.ProcessEnv | undefined;
    const runProcess: AuthProcessRunner = vi.fn(async (_command, _args, options) => {
      receivedEnv = options.env;
      options.onOutput('stdout', 'Open browser to finish Codex login.\n');
      return { code: 0, stdout: 'Logged in using ChatGPT', stderr: '', timedOut: false };
    });
    const events: unknown[] = [];

    const result = await authenticateAgentCli(
      'codex-sdk',
      { authId: 'auth-codex' },
      (event) => events.push(event),
      { detect, runProcess }
    );

    expect(runProcess).toHaveBeenCalledWith(
      '/usr/local/bin/codex',
      ['login'],
      expect.objectContaining({ timeoutMs: expect.any(Number), env: expect.any(Object) })
    );
    expectScrubbedCodexEnv(receivedEnv);
    expect(process.env.OPENAI_API_KEY).toBe('sk-openai-invalid');
    expect(result).toMatchObject({
      authId: 'auth-codex',
      transport: 'codex-sdk',
      ok: true,
      status: 'completed',
      command: ['/usr/local/bin/codex', 'login'],
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        authId: 'auth-codex',
        transport: 'codex-sdk',
        stream: 'stdout',
        text: 'Open browser to finish Codex login.\n',
      })
    );
  });

  it('launches Claude Code subscription login with the official auth command', async () => {
    stubPoisonedClaudeEnv();
    const detect = vi
      .fn()
      .mockResolvedValueOnce(detection())
      .mockResolvedValueOnce(
        detection({
          claudeCode: {
            cli: 'installed',
            path: '/usr/local/bin/claude',
            auth: 'authenticated',
            defaultModel: null,
            keychainEntryPresent: true,
            credentialsFilePresent: null,
          },
        })
      );
    let receivedEnv: NodeJS.ProcessEnv | undefined;
    const runProcess: AuthProcessRunner = vi.fn(async (_command, _args, options) => {
      receivedEnv = options.env;
      options.onOutput('stdout', 'Visit Anthropic in your browser.\n');
      return { code: 0, stdout: 'Done', stderr: '', timedOut: false };
    });

    const result = await authenticateAgentCli(
      'claude-agent-sdk',
      { authId: 'auth-claude' },
      undefined,
      {
        detect,
        runProcess,
      }
    );

    expect(runProcess).toHaveBeenCalledWith(
      '/usr/local/bin/claude',
      ['auth', 'login', '--claudeai'],
      expect.objectContaining({ timeoutMs: expect.any(Number), env: expect.any(Object) })
    );
    expectScrubbedClaudeEnv(receivedEnv);
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-invalid');
    expect(result).toMatchObject({
      authId: 'auth-claude',
      transport: 'claude-agent-sdk',
      ok: true,
      status: 'completed',
      command: ['/usr/local/bin/claude', 'auth', 'login', '--claudeai'],
    });
  });

  it('does not launch a process when the requested CLI is missing', async () => {
    const detect = vi.fn().mockResolvedValue(
      detection({
        claudeCode: {
          cli: 'missing',
          path: null,
          auth: 'unauthenticated',
          defaultModel: null,
          keychainEntryPresent: null,
          credentialsFilePresent: null,
        },
      })
    );
    const runProcess: AuthProcessRunner = vi.fn();

    const result = await authenticateAgentCli(
      'claude-agent-sdk',
      { authId: 'auth-missing' },
      undefined,
      { detect, runProcess }
    );

    expect(runProcess).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      status: 'not_installed',
      error: 'Claude Code CLI is not installed.',
    });
  });

  it('redacts token-shaped output before surfacing auth logs', async () => {
    const detect = vi.fn().mockResolvedValue(detection());
    const runProcess: AuthProcessRunner = vi.fn(async (_command, _args, options) => {
      options.onOutput('stdout', 'access_token: secret-token-value\n');
      return {
        code: 1,
        stdout: 'OPENAI_API_KEY=sk-secretsecretsecret',
        stderr: '',
        timedOut: false,
      };
    });
    const events: Array<{ text?: string }> = [];

    const result = await authenticateAgentCli(
      'codex-sdk',
      { authId: 'auth-redact' },
      (event) => events.push(event),
      { detect, runProcess }
    );

    expect(events.some((event) => String(event.text).includes('secret-token-value'))).toBe(false);
    expect(result.output).not.toContain('sk-secretsecretsecret');
    expect(result.ok).toBe(false);
  });
});

describe('agent CLI auth failureKind classification ', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('classifies a missing CLI as not_installed', async () => {
    const detect = vi.fn().mockResolvedValue(
      detection({
        claudeCode: {
          cli: 'missing',
          path: null,
          auth: 'unauthenticated',
          defaultModel: null,
          keychainEntryPresent: null,
          credentialsFilePresent: null,
        },
      })
    );
    const runProcess: AuthProcessRunner = vi.fn();

    const result = await authenticateAgentCli(
      'claude-agent-sdk',
      { authId: 'auth-not-installed' },
      undefined,
      { detect, runProcess }
    );

    expect(result).toMatchObject({
      ok: false,
      status: 'not_installed',
      failureKind: 'not_installed',
    });
    expect(runProcess).not.toHaveBeenCalled();
  });

  it('classifies a spawn error (ENOENT) as spawn_error and captures the errno', async () => {
    const detect = vi.fn().mockResolvedValue(detection());
    const runProcess: AuthProcessRunner = vi.fn(async () => {
      const err = new Error('spawn claude ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });

    const result = await authenticateAgentCli(
      'claude-agent-sdk',
      { authId: 'auth-spawn' },
      undefined,
      { detect, runProcess }
    );

    expect(result).toMatchObject({
      ok: false,
      status: 'failed',
      failureKind: 'spawn_error',
      spawnErrorCode: 'ENOENT',
    });
  });

  it('classifies a non-zero CLI exit as exit_nonzero (distinct from spawn_error)', async () => {
    const detect = vi.fn().mockResolvedValue(detection());
    const runProcess: AuthProcessRunner = vi.fn(async () => ({
      code: 1,
      stdout: '',
      stderr: 'boom',
      timedOut: false,
    }));

    const result = await authenticateAgentCli(
      'claude-agent-sdk',
      { authId: 'auth-exit' },
      undefined,
      { detect, runProcess }
    );

    expect(result).toMatchObject({ ok: false, status: 'failed', failureKind: 'exit_nonzero' });
    expect(result.spawnErrorCode).toBeUndefined();
  });

  it('classifies exit 0 with still-unauthenticated detection as auth_not_detected', async () => {
    const detect = vi.fn().mockResolvedValue(detection());
    const runProcess: AuthProcessRunner = vi.fn(async () => ({
      code: 0,
      stdout: 'ok',
      stderr: '',
      timedOut: false,
    }));

    const result = await authenticateAgentCli(
      'claude-agent-sdk',
      { authId: 'auth-not-detected' },
      undefined,
      { detect, runProcess }
    );

    expect(result).toMatchObject({ ok: false, status: 'failed', failureKind: 'auth_not_detected' });
  });

  it('classifies a timeout as timed_out', async () => {
    const detect = vi.fn().mockResolvedValue(detection());
    const runProcess: AuthProcessRunner = vi.fn(async () => ({
      code: null,
      stdout: '',
      stderr: '',
      timedOut: true,
    }));

    const result = await authenticateAgentCli(
      'claude-agent-sdk',
      { authId: 'auth-timeout' },
      undefined,
      { detect, runProcess }
    );

    expect(result).toMatchObject({ ok: false, status: 'timed_out', failureKind: 'timed_out' });
  });

  it('does not set failureKind on a successful sign-in', async () => {
    const detect = vi
      .fn()
      .mockResolvedValueOnce(detection())
      .mockResolvedValueOnce(
        detection({
          claudeCode: {
            cli: 'installed',
            path: '/usr/local/bin/claude',
            auth: 'authenticated',
            defaultModel: null,
            keychainEntryPresent: true,
            credentialsFilePresent: null,
          },
        })
      );
    const runProcess: AuthProcessRunner = vi.fn(async () => ({
      code: 0,
      stdout: 'Done',
      stderr: '',
      timedOut: false,
    }));

    const result = await authenticateAgentCli(
      'claude-agent-sdk',
      { authId: 'auth-ok' },
      undefined,
      { detect, runProcess }
    );

    expect(result).toMatchObject({ ok: true, status: 'completed' });
    expect(result.failureKind).toBeUndefined();
    expect(result.spawnErrorCode).toBeUndefined();
  });
});
