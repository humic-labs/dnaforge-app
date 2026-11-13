import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface ExecFileScript {
  which?: Record<string, string | string[] | null>;
  lookupErrors?: Record<
    string,
    {
      code: string | number;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      signal?: string | null;
    }
  >;
  securityFound?: boolean;
  commands?: Record<string, { stdout: string; stderr?: string; error?: string }>;
  calls?: Array<{ cmd: string; args: readonly string[]; opts: unknown }>;
}
interface FsScript {
  files?: Record<string, string>;
}

const script: { exec: ExecFileScript; fs: FsScript; osPlatform: NodeJS.Platform; homedir: string } =
  {
    exec: {},
    fs: {},
    osPlatform: 'linux',
    homedir: '/home/test',
  };

const execFileMock = (
  cmd: string,
  args: readonly string[],
  opts: unknown,
  cb: (err: Error | null, out: { stdout: string; stderr: string }) => void
) => {
  script.exec.calls?.push({ cmd, args, opts });
  if ((cmd === 'which' || cmd === 'where') && args.length >= 1) {
    const cmdArg = args[args.length - 1];
    const failure = script.exec.lookupErrors?.[cmdArg];
    if (failure) {
      cb(Object.assign(new Error('Synthetic lookup failure'), failure), {
        stdout: failure.stdout ?? '',
        stderr: '',
      });
      return;
    }
    const hit = script.exec.which?.[cmdArg] ?? null;
    if (hit) {
      const lines = Array.isArray(hit) ? hit : [hit];
      cb(null, { stdout: `${lines.join('\n')}\n`, stderr: '' });
    } else {
      cb(
        Object.assign(new Error(`${cmdArg} not found`), {
          code: 1,
          stdout: '',
          stderr: '',
          killed: false,
          signal: null,
        }),
        { stdout: '', stderr: '' }
      );
    }
    return;
  }
  if (cmd === 'security') {
    if (script.exec.securityFound) cb(null, { stdout: '', stderr: '' });
    else cb(new Error('could not be found'), { stdout: '', stderr: '' });
    return;
  }
  const key = [cmd, ...args].join(' ');
  const result = script.exec.commands?.[key];
  if (result) {
    if (result.error)
      cb(new Error(result.error), { stdout: result.stdout, stderr: result.stderr ?? '' });
    else cb(null, { stdout: result.stdout, stderr: result.stderr ?? '' });
    return;
  }
  cb(new Error(`unstubbed execFile: ${cmd}`), { stdout: '', stderr: '' });
};

vi.mock('node:child_process', () => ({
  default: { execFile: execFileMock },
  execFile: execFileMock,
}));

const fsPromisesMock = {
  access: async (p: string) => {
    if (script.fs.files && Object.prototype.hasOwnProperty.call(script.fs.files, p)) return;
    throw new Error('ENOENT');
  },
  readFile: async (p: string) => {
    const content = script.fs.files?.[p];
    if (content !== undefined) return content;
    throw new Error('ENOENT');
  },
};

vi.mock('node:fs', () => ({
  constants: { X_OK: 1 },
  default: { constants: { X_OK: 1 }, promises: fsPromisesMock },
  promises: fsPromisesMock,
}));

vi.mock('node:os', () => {
  const platform = () => script.osPlatform;
  const homedir = () => script.homedir;
  return {
    default: { platform, homedir },
    platform,
    homedir,
  };
});

const knownDirHits: Record<string, string | null> = {};
const discoveryStatus = { shell: true, cachedDirs: true, fallback: true };
vi.mock('../resolve-shell-path', () => ({
  ensureShellPathRepaired: vi.fn(async () => ({
    repairedPath: '/repaired/bin:/usr/bin',
    knownDirs: [],
    shellProbeOk: discoveryStatus.shell,
    knownDirsComplete: discoveryStatus.cachedDirs,
    skipped: false,
  })),
  findInKnownCliDirsPresence: vi.fn(async (cmd: string) => ({
    value: knownDirHits[cmd] ?? null,
    complete: discoveryStatus.fallback,
  })),
  getSearchedCliDirs: vi.fn(async () => ['/repaired/bin', '/usr/bin']),
}));

describe('detectAgentSdk', () => {
  beforeEach(() => {
    script.exec = { calls: [] };
    script.fs = {};
    script.osPlatform = 'linux';
    script.homedir = '/home/test';
    discoveryStatus.shell = discoveryStatus.cachedDirs = discoveryStatus.fallback = true;
    vi.stubEnv('CODEX_HOME', undefined);
    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
    for (const key of Object.keys(knownDirHits)) delete knownDirHits[key];
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves candidate presence without executing candidate versions or authentication', async () => {
    script.exec.which = { codex: ['/workspace/node_modules/.bin/codex', '/usr/local/bin/codex'] };
    knownDirHits.codex = '/home/test/.local/bin/codex';
    const { resolveAgentCliPresence } = await import('../cli-presence');
    await expect(resolveAgentCliPresence('codex')).resolves.toEqual({
      kind: 'searched',
      externalPaths: ['/usr/local/bin/codex'],
      fallbackPath: '/home/test/.local/bin/codex',
      bundledPaths: [],
      rejectedEnvironmentOverride: false,
      discovery: { shellPath: 'complete', pathLookup: 'complete', knownLocations: 'complete' },
    });
    expect(script.exec.calls?.map(({ cmd, args }) => [cmd, args])).toEqual([
      ['which', ['-a', 'codex']],
    ]);
  });

  it('distinguishes missing commands from lookup failure without changing legacy fallback', async () => {
    const { resolveAgentCliPresence } = await import('../cli-presence');
    const { findInstalledAgentCli } = await import('../detect');
    const missing = await resolveAgentCliPresence('codex');
    expect(missing.discovery.pathLookup).toBe('complete');
    script.exec.which = { codex: [] };
    expect((await resolveAgentCliPresence('codex')).discovery.pathLookup).toBe('unknown');
    delete script.exec.which;
    for (const failure of [
      { code: 'ENOENT' },
      { code: 'ETIMEDOUT' },
      { code: 1 },
      { code: 1, stdout: '', stderr: 'Synthetic diagnostic', killed: false, signal: null },
      { code: 1, stdout: '/partial/codex', stderr: '', killed: false, signal: null },
      { code: 1, stdout: '', stderr: '', killed: true, signal: null },
      { code: 1, stdout: '', stderr: '', killed: false, signal: 'SIGTERM' },
    ]) {
      script.exec.lookupErrors = { codex: failure };
      const unknown = await resolveAgentCliPresence('codex');
      expect(unknown.discovery.pathLookup).toBe('unknown');
      expect(await findInstalledAgentCli('codex')).toEqual({ cli: 'missing', path: null });
    }
    expect(script.exec.calls?.every(({ cmd }) => cmd === 'which')).toBe(true);
  });

  it('retains unknown cached and current filesystem observations in presence metadata', async () => {
    const { resolveAgentCliPresence } = await import('../cli-presence');
    discoveryStatus.cachedDirs = false;
    expect((await resolveAgentCliPresence('codex')).discovery.knownLocations).toBe('unknown');
    discoveryStatus.cachedDirs = true;
    discoveryStatus.fallback = false;
    expect((await resolveAgentCliPresence('codex')).discovery.knownLocations).toBe('unknown');
    discoveryStatus.shell = false;
    expect((await resolveAgentCliPresence('codex')).discovery.shellPath).toBe('unknown');
  });

  it('preserves fixed settings and environment override semantics before vendor probes', async () => {
    const { resolveAgentCliPresence } = await import('../cli-presence');
    script.fs.files = { '/custom/codex': '' };
    expect(await resolveAgentCliPresence('codex', '')).toMatchObject({
      kind: 'fixed',
      origin: 'settings-override',
      path: null,
    });
    expect(await resolveAgentCliPresence('codex', '/custom/codex')).toMatchObject({
      kind: 'fixed',
      origin: 'settings-override',
      path: '/custom/codex',
    });
    vi.stubEnv('DNAFORGE_CODEX_PATH', '/custom/codex');
    expect(await resolveAgentCliPresence('codex')).toMatchObject({
      kind: 'fixed',
      origin: 'environment-override',
      path: '/custom/codex',
    });
    expect(script.exec.calls).toEqual([]);
    vi.stubEnv('DNAFORGE_CODEX_PATH', 'relative-synthetic-path');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await resolveAgentCliPresence('codex')).toMatchObject({
        kind: 'searched',
        rejectedEnvironmentOverride: true,
        externalPaths: [],
      });
    } finally {
      warning.mockRestore();
    }
    vi.stubEnv('DNAFORGE_CODEX_PATH', '');
    expect(await resolveAgentCliPresence('codex')).toMatchObject({
      kind: 'searched',
      rejectedEnvironmentOverride: false,
    });
    expect(script.exec.calls?.every(({ cmd }) => cmd === 'which')).toBe(true);
  });

  it('reads exact MCP identities through the app-owned CLI environment without exposing credentials', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-unrelated-key');
    vi.stubEnv('CODEX_HOME', '/private/owner-codex-home');
    script.exec.commands = {
      '/usr/local/bin/codex -c features.plugins=false -c features.apps=false mcp list --json': {
        stdout: JSON.stringify([
          { name: 'slack', token: 'synthetic-private-value' },
          { name: 'odd.name' },
          { name: 'dnaforge' },
          { name: 'slack' },
        ]),
      },
    };
    const { readCodexConfiguredMcpServerNames } = await import('../detect');
    const signal = new AbortController().signal;
    const { getAgentHelperLifecycleSnapshot } = await import('../helper-lifecycle');
    const before = getAgentHelperLifecycleSnapshot();
    await expect(
      readCodexConfiguredMcpServerNames('/usr/local/bin/codex', { cwd: '/workspace', signal })
    ).resolves.toEqual(['dnaforge', 'odd.name', 'slack']);
    const options = script.exec.calls?.[0].opts as {
      cwd: string;
      signal: AbortSignal;
      env: Record<string, string>;
    };
    expect(options.cwd).toBe('/workspace');
    expect(options.signal).toBe(signal);
    expect(options.env.CODEX_HOME).toBe('/private/owner-codex-home');
    expect(options.env.OPENAI_API_KEY).toBeUndefined();
    const after = getAgentHelperLifecycleSnapshot();
    expect(after.started - before.started).toBe(1);
    expect(after.settled - before.settled).toBe(1);
    expect(after.active).toBe(before.active);
  });

  it.each(['{invalid', '{}', '[{}]', '[{"name":null}]', '[{"name":""}]'])(
    'rejects malformed MCP metadata without exposing its contents (%s)',
    async (stdout) => {
      script.exec.commands = {
        '/usr/local/bin/codex -c features.plugins=false -c features.apps=false mcp list --json': {
          stdout,
          stderr: 'synthetic-private-value',
        },
      };
      const { readCodexConfiguredMcpServerNames } = await import('../detect');
      await expect(readCodexConfiguredMcpServerNames('/usr/local/bin/codex')).rejects.toThrow(
        'Codex MCP configuration unavailable; the app could not isolate its tool servers.'
      );
    }
  );

  it('does not include CLI stderr or stdout in MCP configuration read errors', async () => {
    script.exec.commands = {
      '/usr/local/bin/codex -c features.plugins=false -c features.apps=false mcp list --json': {
        stdout: 'synthetic-private-stdout',
        stderr: 'synthetic-private-stderr',
        error: 'synthetic-private-failure',
      },
    };
    const { readCodexConfiguredMcpServerNames } = await import('../detect');
    await expect(readCodexConfiguredMcpServerNames('/usr/local/bin/codex')).rejects.toThrow(
      'Codex MCP configuration unavailable; the app could not isolate its tool servers.'
    );
  });

  it('returns missing/unauthenticated when no CLI is on PATH', async () => {
    const { getAgentHelperLifecycleSnapshot } = await import('../helper-lifecycle');
    const { detectAgentSdk } = await import('../detect');
    const before = getAgentHelperLifecycleSnapshot();
    const result = await detectAgentSdk();
    const after = getAgentHelperLifecycleSnapshot();

    expect(result.claudeCode.cli).toBe('missing');
    expect(result.claudeCode.auth).toBe('unauthenticated');
    expect(result.claudeCode.path).toBeNull();
    expect(result.codex.cli).toBe('missing');
    expect(result.codex.auth).toBe('unauthenticated');
    expect(result.codex.path).toBeNull();
    expect(result.codex.defaultModel).toBeNull();
    expect(result.codex.authFilePresent).toBe(false);
    expect(result.grok).toMatchObject({
      cli: 'missing',
      auth: 'unauthenticated',
      path: null,
      defaultModel: null,
    });
    expect(after.started - before.started).toBe(3);
    expect(after.settled - before.settled).toBe(3);
    expect(after.active).toBe(0);
  });

  it('detects Grok through the installed CLI without reading ~/.grok files', async () => {
    script.exec = {
      calls: [],
      which: { grok: '/home/test/.grok/bin/grok' },
      commands: {
        '/home/test/.grok/bin/grok models': {
          stdout:
            'Default model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5\n',
        },
      },
    };
    const { detectGrok } = await import('../detect');
    await expect(detectGrok()).resolves.toEqual({
      cli: 'installed',
      path: '/home/test/.grok/bin/grok',
      auth: 'authenticated',
      defaultModel: 'grok-4.6',
      availableModels: ['grok-4.6', 'grok-4.5'],
      searchedDirs: ['/repaired/bin', '/usr/bin'],
    });
    expect(script.exec.calls?.some((call) => String(call.cmd).includes('.grok/bin/grok'))).toBe(
      true
    );
    expect(script.exec.calls?.find((call) => call.args.join(' ') === 'models')?.opts).toMatchObject(
      { timeout: 15_000 }
    );
    expect(Object.keys(script.fs.files ?? {}).some((path) => path.includes('/.grok/'))).toBe(false);
  });

  it('resolves the official Grok npm Windows shim to its Node trampoline', async () => {
    script.osPlatform = 'win32';
    const shim = 'C:\\npm\\grok.cmd';
    const launcher = 'C:\\npm\\node_modules\\@xai-official\\grok\\bin\\grok';
    script.exec = {
      calls: [],
      which: { grok: shim },
      commands: {
        [`${process.execPath} ${launcher} models`]: {
          stdout: 'Default model: grok-4.6\n  * grok-4.6 (default)\n',
        },
      },
    };
    script.fs.files = {
      [shim]: [
        '@ECHO off',
        'SET "_prog=node"',
        `"%_prog%" "%dp0%\\node_modules\\@xai-official\\grok\\bin\\grok" %*`,
      ].join('\r\n'),
      [launcher]: '#!/usr/bin/env node',
    };

    const { detectGrok } = await import('../detect');
    await expect(detectGrok()).resolves.toMatchObject({
      cli: 'installed',
      path: launcher,
      auth: 'authenticated',
      defaultModel: 'grok-4.6',
    });
    expect(script.exec.calls).toContainEqual(
      expect.objectContaining({
        cmd: process.execPath,
        args: [launcher, 'models'],
      })
    );
  });

  it(': finds codex via the known-location fallback when `which` misses (stripped PATH)', async () => {
    script.exec = { which: {} };
    knownDirHits['codex'] = '/home/test/.codex/bin/codex';
    script.fs = {
      files: {
        '/home/test/.codex/auth.json': JSON.stringify({
          auth_mode: 'chatgpt',
          OPENAI_API_KEY: null,
          tokens: { access_token: 'fake', refresh_token: 'fake', id_token: 'fake' },
        }),
      },
    };

    const { detectCodex } = await import('../detect');
    const result = await detectCodex();

    expect(result.cli).toBe('installed');
    expect(result.path).toBe('/home/test/.codex/bin/codex');
    expect(result.auth).toBe('authenticated');

    expect(result.searchedDirs).toEqual(['/repaired/bin', '/usr/bin']);
  });

  it(': skips a repo-local node_modules/.bin codex and resolves the user CLI', async () => {
    script.exec = {
      calls: [],
      which: {
        codex: [
          '/repo/node_modules/.bin/codex',
          '/home/test/.nvm/versions/node/v20.19.4/bin/codex',
        ],
      },
    };
    script.fs = {
      files: {
        '/home/test/.codex/auth.json': JSON.stringify({
          auth_mode: 'chatgpt',
          OPENAI_API_KEY: null,
          tokens: { access_token: 'fake', refresh_token: 'fake', id_token: 'fake' },
        }),
      },
    };

    const { detectCodex } = await import('../detect');
    const result = await detectCodex();

    expect(result.cli).toBe('installed');

    expect(result.path).toBe('/home/test/.nvm/versions/node/v20.19.4/bin/codex');
    expect(result.path).not.toContain('node_modules');

    const whichCall = script.exec.calls?.find((c) => c.cmd === 'which');
    expect(whichCall?.args).toEqual(['-a', 'codex']);
  });

  it('selects the newest Codex CLI across PATH and ChatGPT.app instead of the first PATH hit', async () => {
    script.osPlatform = 'darwin';
    script.exec = {
      calls: [],
      which: {
        codex: ['/home/test/.local/bin/codex', '/opt/homebrew/bin/codex'],
      },
      commands: {
        '/home/test/.local/bin/codex --version': { stdout: 'codex-cli 0.142.0\n' },
        '/opt/homebrew/bin/codex --version': { stdout: 'codex-cli 0.142.0\n' },
        '/Applications/ChatGPT.app/Contents/Resources/codex --version': {
          stdout: 'codex-cli 0.144.0-alpha.4\n',
        },
      },
    };
    script.fs = {
      files: {
        '/Applications/ChatGPT.app/Contents/Resources/codex': '',
        '/home/test/.codex/auth.json': JSON.stringify({
          auth_mode: 'chatgpt',
          OPENAI_API_KEY: null,
          tokens: { access_token: 'fake', refresh_token: 'fake', id_token: 'fake' },
        }),
      },
    };

    const { detectCodex } = await import('../detect');
    const result = await detectCodex();

    expect(result.path).toBe('/Applications/ChatGPT.app/Contents/Resources/codex');
    expect(
      script.exec.calls
        ?.filter((call) => call.args.join(' ') === '--version')
        .map((call) => call.cmd)
    ).toEqual(
      expect.arrayContaining([
        '/home/test/.local/bin/codex',
        '/opt/homebrew/bin/codex',
        '/Applications/ChatGPT.app/Contents/Resources/codex',
      ])
    );
  });

  it('prefers a stable Codex release over a prerelease with the same core version', async () => {
    script.osPlatform = 'darwin';
    script.exec = {
      which: { codex: '/opt/homebrew/bin/codex' },
      commands: {
        '/opt/homebrew/bin/codex --version': { stdout: 'codex-cli 0.144.0\n' },
        '/Applications/ChatGPT.app/Contents/Resources/codex --version': {
          stdout: 'OpenAI Codex v0.144.0-alpha.4\n',
        },
      },
    };
    script.fs = {
      files: {
        '/Applications/ChatGPT.app/Contents/Resources/codex': '',
      },
    };

    const { detectCodex } = await import('../detect');
    const result = await detectCodex();

    expect(result.path).toBe('/opt/homebrew/bin/codex');
  });

  it(': when the ONLY PATH hit is node_modules/.bin, falls back to known dirs', async () => {
    script.exec = { which: { codex: ['/repo/node_modules/.bin/codex'] } };
    knownDirHits['codex'] = '/home/test/.nvm/versions/node/v20.19.4/bin/codex';
    script.fs = {
      files: {
        '/home/test/.codex/auth.json': JSON.stringify({
          auth_mode: 'chatgpt',
          OPENAI_API_KEY: null,
          tokens: { access_token: 'fake', refresh_token: 'fake', id_token: 'fake' },
        }),
      },
    };

    const { detectCodex } = await import('../detect');
    const result = await detectCodex();

    expect(result.cli).toBe('installed');
    expect(result.path).toBe('/home/test/.nvm/versions/node/v20.19.4/bin/codex');
    expect(result.path).not.toContain('node_modules');
  });

  it(': the node_modules skip also applies to claude detection (shared which)', async () => {
    script.exec = {
      which: {
        claude: ['/repo/node_modules/.bin/claude', '/opt/homebrew/bin/claude'],
      },
    };
    const { detectClaudeCode } = await import('../detect');
    const result = await detectClaudeCode();
    expect(result.cli).toBe('installed');
    expect(result.path).toBe('/opt/homebrew/bin/claude');
    expect(result.path).not.toContain('node_modules');
  });

  it(': still reports missing when neither PATH nor the known dirs have the CLI', async () => {
    script.exec = { which: {} };

    const { detectAgentSdk } = await import('../detect');
    const result = await detectAgentSdk();
    expect(result.codex.cli).toBe('missing');
    expect(result.claudeCode.cli).toBe('missing');
    expect(result.codex.searchedDirs).toEqual(['/repaired/bin', '/usr/bin']);
  });

  it('detects installed Codex CLI, chatgpt auth mode, and configured default model', async () => {
    script.exec = { which: { codex: '/usr/local/bin/codex' } };
    script.fs = {
      files: {
        '/home/test/.codex/config.toml': 'model = "gpt-5.5"\nmodel_reasoning_effort = "xhigh"\n',
        '/home/test/.codex/auth.json': JSON.stringify({
          auth_mode: 'chatgpt',
          OPENAI_API_KEY: null,
          tokens: {
            access_token: 'fake',
            refresh_token: 'fake',
            id_token: 'fake',
            account_id: 'acct_123',
          },
        }),
      },
    };

    const { detectAgentSdk } = await import('../detect');
    const result = await detectAgentSdk();

    expect(result.codex.cli).toBe('installed');
    expect(result.codex.path).toBe('/usr/local/bin/codex');
    expect(result.codex.authFilePresent).toBe(true);
    expect(result.codex.defaultModel).toBe('gpt-5.5');
    expect(result.codex.authMode).toBe('chatgpt');
    expect(result.codex.auth).toBe('authenticated');
    expect(result.claudeCode.cli).toBe('missing');
    expect(result.claudeCode.auth).toBe('unauthenticated');
  });

  it('detects Codex auth through the official status command when no auth file is present', async () => {
    script.exec = {
      which: { codex: '/usr/local/bin/codex' },
      commands: {
        '/usr/local/bin/codex login status': { stdout: 'Logged in using ChatGPT\n' },
      },
    };

    const { detectAgentSdk } = await import('../detect');
    const result = await detectAgentSdk();

    expect(result.codex.cli).toBe('installed');
    expect(result.codex.authFilePresent).toBe(false);
    expect(result.codex.authMode).toBe('chatgpt');
    expect(result.codex.auth).toBe('authenticated');
  });

  it('classifies codex with no usable credential as unauthenticated', async () => {
    script.exec = { which: { codex: '/usr/local/bin/codex' } };
    script.fs = {
      files: {
        '/home/test/.codex/auth.json': JSON.stringify({
          auth_mode: 'apikey',
          OPENAI_API_KEY: null,
          tokens: {},
        }),
      },
    };

    const { detectAgentSdk } = await import('../detect');
    const result = await detectAgentSdk();

    expect(result.codex.cli).toBe('installed');
    expect(result.codex.auth).toBe('unauthenticated');
    expect(result.codex.authMode).toBeNull();
  });

  it('detects darwin keychain entry as ready', async () => {
    script.osPlatform = 'darwin';
    script.exec = {
      which: { claude: '/opt/homebrew/bin/claude' },
      securityFound: true,
    };

    const { detectAgentSdk } = await import('../detect');
    const result = await detectAgentSdk();

    expect(result.claudeCode.cli).toBe('installed');
    expect(result.claudeCode.path).toBe('/opt/homebrew/bin/claude');
    expect(result.claudeCode.keychainEntryPresent).toBe(true);
    expect(result.claudeCode.auth).toBe('authenticated');
  });

  it('win32: prefers a native claude.exe over a .cmd shim (never returns .cmd)', async () => {
    script.osPlatform = 'win32';
    script.homedir = 'C:\\Users\\test';
    script.exec = {
      which: {
        claude: [
          'C:\\Users\\test\\AppData\\Roaming\\npm\\claude.cmd',
          'C:\\Users\\test\\.local\\bin\\claude.exe',
        ],
      },
    };

    const { detectAgentSdk } = await import('../detect');
    const result = await detectAgentSdk();

    expect(result.claudeCode.path).toBe('C:\\Users\\test\\.local\\bin\\claude.exe');
    expect(result.claudeCode.path?.toLowerCase().endsWith('.cmd')).toBe(false);
  });

  it('win32: npm-shim-only claude resolves the real cli.js, NEVER the .cmd', async () => {
    script.osPlatform = 'win32';
    script.homedir = 'C:\\Users\\test';
    const prefix = 'C:\\Users\\test\\AppData\\Roaming\\npm';
    const cliJs = `${prefix}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
    script.exec = { which: { claude: [`${prefix}\\claude.cmd`, `${prefix}\\claude`] } };
    script.fs = { files: { [cliJs]: '#!/usr/bin/env node' } };

    const { detectAgentSdk } = await import('../detect');
    const result = await detectAgentSdk();

    expect(result.claudeCode.path).toBe(cliJs);
    expect(result.claudeCode.path?.toLowerCase().endsWith('.cmd')).toBe(false);
  });

  it('win32: .cmd-only with NO resolvable entrypoint → missing/null, NEVER the .cmd (the core safety branch)', async () => {
    script.osPlatform = 'win32';
    script.homedir = 'C:\\Users\\test';
    const prefix = 'C:\\Users\\test\\AppData\\Roaming\\npm';

    script.exec = { which: { claude: [`${prefix}\\claude.cmd`, `${prefix}\\claude`] } };
    script.fs = { files: {} };

    const { detectAgentSdk } = await import('../detect');
    const result = await detectAgentSdk();

    expect(result.claudeCode.cli).toBe('missing');
    expect(result.claudeCode.path).toBeNull();
  });

  it('win32: never hands the SDK a .cmd for codex either (resolves the .exe)', async () => {
    script.osPlatform = 'win32';
    script.homedir = 'C:\\Users\\test';
    const prefix = 'C:\\Users\\test\\AppData\\Roaming\\npm';
    const exe = `${prefix}\\codex.exe`;
    script.exec = { which: { codex: [`${prefix}\\codex.cmd`] } };
    script.fs = { files: { [exe]: 'MZ' } };

    const { detectAgentSdk } = await import('../detect');
    const result = await detectAgentSdk();

    expect(result.codex.path).toBe(exe);
    expect(result.codex.path?.toLowerCase().endsWith('.cmd')).toBe(false);
  });

  it(' win32: npm-shim codex resolves the NATIVE platform-pkg .exe, NEVER codex.js', async () => {
    script.osPlatform = 'win32';
    script.homedir = 'C:\\Users\\test';
    const prefix = 'C:\\Users\\test\\AppData\\Roaming\\npm';
    const nativeExe = `${prefix}\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`;
    const launcherJs = `${prefix}\\node_modules\\@openai\\codex\\bin\\codex.js`;

    script.exec = { which: { codex: [`${prefix}\\codex.cmd`] } };
    script.fs = { files: { [nativeExe]: 'MZ', [launcherJs]: '#!/usr/bin/env node' } };

    const { detectAgentSdk } = await import('../detect');
    const result = await detectAgentSdk();

    expect(result.codex.path).toBe(nativeExe);
    expect(result.codex.path?.toLowerCase().endsWith('.js')).toBe(false);
    expect(result.codex.path?.toLowerCase().endsWith('.cmd')).toBe(false);
  });

  it(' win32 PNPM: parses the shim → resolves the native .exe nested in the .pnpm store (absent at dirname(shim))', async () => {
    script.osPlatform = 'win32';
    script.homedir = 'C:\\Users\\test';
    const prefix = 'C:\\Users\\test\\AppData\\Roaming\\npm';
    const launcher = `${prefix}\\node_modules\\.pnpm\\@openai+codex@1\\node_modules\\@openai\\codex\\bin\\codex.js`;
    const nestedExe = `${prefix}\\node_modules\\.pnpm\\@openai+codex@1\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`;
    const shimBody = `@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\.pnpm\\@openai+codex@1\\node_modules\\@openai\\codex\\bin\\codex.js" %*`;
    script.exec = { which: { codex: [`${prefix}\\codex.cmd`] } };
    script.fs = {
      files: { [`${prefix}\\codex.cmd`]: shimBody, [launcher]: '#!node', [nestedExe]: 'MZ' },
    };

    expect(
      script.fs.files?.[
        `${prefix}\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`
      ]
    ).toBeUndefined();

    const { detectAgentSdk } = await import('../detect');
    const result = await detectAgentSdk();

    expect(result.codex.path).toBe(nestedExe);
    expect(result.codex.path?.toLowerCase().endsWith('.js')).toBe(false);
  });

  it(': DNAFORGE_CODEX_PATH override wins AUTHORITATIVELY over a PATH codex (posix)', async () => {
    vi.stubEnv('DNAFORGE_CODEX_PATH', '/opt/mycodex/codex');
    script.exec = { which: { codex: ['/usr/local/bin/codex'] } };
    script.fs = { files: { '/opt/mycodex/codex': 'x' } };

    const { detectAgentSdk } = await import('../detect');
    const result = await detectAgentSdk();

    expect(result.codex.path).toBe('/opt/mycodex/codex');
  });

  it('uses a Settings executable override authoritatively for detection', async () => {
    vi.stubEnv('DNAFORGE_CODEX_PATH', '/opt/env/codex');
    script.exec = { which: { codex: ['/usr/local/bin/codex'] } };
    script.fs = {
      files: {
        '/opt/settings/codex': 'x',
        '/opt/env/codex': 'x',
      },
    };

    const { detectAgentSdk } = await import('../detect');
    const result = await detectAgentSdk({ 'codex-sdk': '/opt/settings/codex' });

    expect(result.codex.path).toBe('/opt/settings/codex');
  });

  it('reports missing for a bad Settings override instead of silently using PATH', async () => {
    script.exec = { which: { codex: ['/usr/local/bin/codex'] } };
    script.fs = { files: {} };

    const { detectAgentSdk } = await import('../detect');
    const result = await detectAgentSdk({ 'codex-sdk': '/missing/codex' });

    expect(result.codex.cli).toBe('missing');
    expect(result.codex.path).toBeNull();
  });

  it(': a non-existent / non-absolute override is ignored, falls through to PATH', async () => {
    vi.stubEnv('DNAFORGE_CODEX_PATH', '/nope/codex');
    script.exec = { which: { codex: ['/usr/local/bin/codex'] } };
    script.fs = { files: {} };

    const { detectAgentSdk } = await import('../detect');
    const result = await detectAgentSdk();

    expect(result.codex.path).toBe('/usr/local/bin/codex');
  });

  it(': DNAFORGE_CODEX_PATH override — a native .exe is used directly (win32)', async () => {
    script.osPlatform = 'win32';
    script.homedir = 'C:\\Users\\test';
    vi.stubEnv('DNAFORGE_CODEX_PATH', 'C:\\tools\\codex.exe');
    script.exec = { which: { codex: [] } };
    script.fs = { files: {} };

    const { detectAgentSdk } = await import('../detect');
    const result = await detectAgentSdk();

    expect(result.codex.path).toBe('C:\\tools\\codex.exe');
  });

  it('POSIX is unchanged: which() returns the first non-node_modules match verbatim', async () => {
    script.osPlatform = 'linux';
    script.exec = { which: { claude: ['/usr/local/bin/claude', '/opt/homebrew/bin/claude'] } };

    const { detectAgentSdk } = await import('../detect');
    const result = await detectAgentSdk();

    expect(result.claudeCode.path).toBe('/usr/local/bin/claude');
  });

  it('detects Claude auth and accepts the provider-advertised bracketed context alias', async () => {
    script.exec = {
      which: { claude: '/usr/local/bin/claude' },
      commands: {
        '/usr/local/bin/claude auth status --json': {
          stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }),
        },
      },
    };
    script.fs = {
      files: {
        '/home/test/.claude/settings.json': JSON.stringify({ model: 'claude-sonnet-4' }),
        '/home/test/.claude/settings.local.json': JSON.stringify({ model: 'claude-fable-5[1m]' }),
      },
    };

    const { detectAgentSdk } = await import('../detect');
    const result = await detectAgentSdk();

    expect(result.claudeCode.cli).toBe('installed');
    expect(result.claudeCode.auth).toBe('authenticated');
    expect(result.claudeCode.defaultModel).toBe('claude-fable-5[1m]');
    expect(result.claudeCode.credentialsFilePresent).toBe(false);
  });

  it('ignores an unsafe local Claude model setting and uses the safe user fallback', async () => {
    script.exec = {
      which: { claude: '/usr/local/bin/claude' },
      commands: {
        '/usr/local/bin/claude auth status --json': {
          stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }),
        },
      },
    };
    script.fs = {
      files: {
        '/home/test/.claude/settings.json': JSON.stringify({ model: 'claude-sonnet-4' }),
        '/home/test/.claude/settings.local.json': JSON.stringify({ model: 'claude;remove-data' }),
      },
    };

    const { detectAgentSdk } = await import('../detect');
    const result = await detectAgentSdk();

    expect(result.claudeCode.defaultModel).toBe('claude-sonnet-4');
  });

  it('probes Claude auth status with a scrubbed subscription-session CLI env', async () => {
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
    script.exec = {
      calls: [],
      which: { claude: '/usr/local/bin/claude' },
      commands: {
        '/usr/local/bin/claude auth status --json': {
          stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }),
        },
      },
    };

    const { detectClaudeCode } = await import('../detect');
    const result = await detectClaudeCode();

    expect(result.auth).toBe('authenticated');
    const statusCall = script.exec.calls?.find(
      (call) => call.cmd === '/usr/local/bin/claude' && call.args.join(' ') === 'auth status --json'
    );
    const env = (statusCall?.opts as { env?: Record<string, unknown> } | undefined)?.env;
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
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-invalid');
  });

  it('reads codex auth/config from CODEX_HOME when set (honors the sanctioned locator)', async () => {
    vi.stubEnv('CODEX_HOME', '/custom/codex-home');
    script.exec = { which: { codex: '/usr/local/bin/codex' } };
    script.fs = {
      files: {
        '/custom/codex-home/config.toml': 'model = "gpt-5.5"\n',
        '/custom/codex-home/auth.json': JSON.stringify({
          auth_mode: 'chatgpt',
          OPENAI_API_KEY: null,
          tokens: {
            access_token: 'fake',
            refresh_token: 'fake',
            id_token: 'fake',
            account_id: 'acct_123',
          },
        }),
      },
    };

    const { detectCodex } = await import('../detect');
    const result = await detectCodex();

    expect(result.authFilePresent).toBe(true);
    expect(result.authMode).toBe('chatgpt');
    expect(result.auth).toBe('authenticated');
    expect(result.defaultModel).toBe('gpt-5.5');
  });

  it('probes Codex login status with a scrubbed OpenAI/Codex CLI env ', async () => {
    vi.stubEnv('PATH', '/test/bin:/usr/bin');
    vi.stubEnv('HOME', '/Users/test');
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai-invalid');
    vi.stubEnv('OPENAI_BASE_URL', 'https://ambient.example/v1');
    vi.stubEnv('OPENAI_NEWVAR', 'future-openai-auth-var');
    vi.stubEnv('CODEX_API_KEY', 'codex-ambient-key');
    vi.stubEnv('CODEX_HOME', '/Users/test/.codex');
    script.exec = {
      calls: [],
      which: { codex: '/usr/local/bin/codex' },
      commands: {
        '/usr/local/bin/codex login status': { stdout: 'Logged in using ChatGPT\n' },
      },
    };

    const { detectCodex } = await import('../detect');
    const result = await detectCodex();

    expect(result.auth).toBe('authenticated');
    expect(result.authMode).toBe('chatgpt');

    const statusCall = script.exec.calls?.find(
      (call) => call.cmd === '/usr/local/bin/codex' && call.args.join(' ') === 'login status'
    );
    const env = (statusCall?.opts as { env?: Record<string, unknown> } | undefined)?.env;
    expect(env).toMatchObject({
      PATH: '/test/bin:/usr/bin',
      HOME: '/Users/test',

      CODEX_HOME: '/Users/test/.codex',
    });
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(env).not.toHaveProperty('OPENAI_BASE_URL');
    expect(env).not.toHaveProperty('OPENAI_NEWVAR');
    expect(env).not.toHaveProperty('CODEX_API_KEY');

    expect(process.env.OPENAI_API_KEY).toBe('sk-openai-invalid');
  });
});
