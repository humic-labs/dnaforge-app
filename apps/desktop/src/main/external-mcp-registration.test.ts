import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindExternalAccessObservationSink } from './external-access-observation';
import type { ExternalAccessObservation } from '../shared/external-access-telemetry';
import {
  externalMcpRegistrationSnapshot,
  refreshExternalMcpRegistration,
  registerExternalMcpClients,
  runExternalMcpClientCommand,
  startExternalMcpRegistration,
} from './external-mcp-registration';

describe('external MCP client registration', () => {
  afterEach(() => bindExternalAccessObservationSink(null));

  it('observes actual configuration results without exporting command paths or inventing grant authority', async () => {
    const receipts: ExternalAccessObservation[] = [];
    bindExternalAccessObservationSink((receipt) => {
      receipts.push(receipt);
      return true;
    });
    const result = await registerExternalMcpClients({
      isPackaged: true,
      resourcesPath: '/PRIVATE_APPLICATION/Contents/Resources',
      detectClaudeCode: async () => ({ cli: 'installed', path: '/PRIVATE_CLIENT/claude' }),
      detectCodex: async () => ({ cli: 'missing', path: null }),
      detectGrok: async () => ({ cli: 'missing', path: null }),
      run: async (_provider, _path, args) => ({
        ok: !args.includes('get'),
        stdout: args.includes('get') ? 'No MCP server named dnaforge' : '',
      }),
      registerDesktopClients: async () => [],
    });
    expect(result[0]).toEqual({ client: 'Claude Code', status: 'registered' });
    expect(receipts).toHaveLength(3);
    expect(receipts.find((receipt) => receipt.access_client === 'claude_code')).toMatchObject({
      access_stage: 'registration',
      access_result: 'registered',
      access_transport: 'configuration',
      access_authority: 'native_configuration',
      access_scope_class: 'not_observed',
      access_expiry_class: 'not_observed',
      access_execution: 'not_observed',
      access_usefulness: 'not_attested',
    });
    expect(new Set(receipts.map((receipt) => receipt.operation_id)).size).toBe(3);
    expect(JSON.stringify(receipts)).not.toContain('PRIVATE_');
    bindExternalAccessObservationSink(() => {
      throw new Error('optional sink unavailable');
    });
    await expect(
      registerExternalMcpClients({
        isPackaged: true,
        resourcesPath: '/PRIVATE_APPLICATION/Contents/Resources',
        detectClaudeCode: async () => ({ cli: 'missing', path: null }),
        detectCodex: async () => ({ cli: 'missing', path: null }),
        detectGrok: async () => ({ cli: 'missing', path: null }),
        registerDesktopClients: async () => [],
        run: async () => ({ ok: true, stdout: '' }),
      })
    ).resolves.toHaveLength(3);
  });

  it('keeps successful command JSON separate from stderr diagnostics', async () => {
    const result = await runExternalMcpClientCommand('grok', process.execPath, [
      '-e',
      'process.stdout.write("[]\\n"); process.stderr.write("NONFUNCTIONAL_CONFIG_WARNING\\n");',
    ]);
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe('[]\n');
    expect(JSON.parse(result.stdout)).toEqual([]);
  });

  it.each([
    ['ERROR config toml has syntax errors: synthetic parse refusal', false],
    ['WARN config layer failed to load; plugin config fails closed', false],
    ['ERROR reading config file: synthetic directory refusal', false],
    ['WARN hook setting is not supported; hook runs without it', true],
  ] as const)(
    'classifies Grok list diagnostics without inferring absence: %s',
    async (diagnostic, accepted) => {
      const root = mkdtempSync(join(tmpdir(), 'f27-grok-inspection-'));
      try {
        const executable = join(root, 'grok-fixture');
        writeFileSync(
          executable,
          '#!/usr/bin/env node\n' +
            'process.stdout.write("[]\\n");\n' +
            `process.stderr.write(${JSON.stringify(diagnostic + '\n')});\n`
        );
        chmodSync(executable, 0o700);
        const result = await runExternalMcpClientCommand(
          'grok',
          executable,
          ['mcp', 'list', '--json'],
          process.env,
          root
        );
        expect(result).toEqual(
          accepted
            ? { ok: true, stdout: '[]\n' }
            : { ok: false, stdout: 'Grok configuration inspection failed.' }
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it('retains failed-command stderr for explicit missing-entry classification', async () => {
    const result = await runExternalMcpClientCommand('codex', process.execPath, [
      '-e',
      'process.stderr.write("No MCP server named dnaforge\\n"); process.exitCode = 1;',
    ]);
    expect(result.ok).toBe(false);
    expect(result.stdout).toContain('No MCP server named dnaforge');
  });

  it('rechecks an app installed after startup and cancels checks when stopped', async () => {
    vi.useFakeTimers();
    let stop = () => {};
    try {
      const detectGrok = vi
        .fn()
        .mockResolvedValueOnce({ cli: 'missing', path: null })
        .mockResolvedValue({ cli: 'installed', path: '/bin/grok' });
      const run = vi.fn(async (_provider: string, _path: string, args: readonly string[]) => ({
        ok: true,
        stdout: args.includes('list') ? '[]' : '',
      }));
      stop = startExternalMcpRegistration({
        isPackaged: true,
        resourcesPath: '/Applications/DNAForge.app/Contents/Resources',
        detectClaudeCode: async () => ({ cli: 'missing', path: null }),
        detectCodex: async () => ({ cli: 'missing', path: null }),
        detectGrok,
        run,
        registerDesktopClients: async () => [],
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(externalMcpRegistrationSnapshot().clients.at(-1)?.status).toBe('not-installed');
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(externalMcpRegistrationSnapshot().clients.at(-1)?.status).toBe('registered');
      stop();
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(detectGrok).toHaveBeenCalledTimes(2);
    } finally {
      stop();
      vi.useRealTimers();
    }
  });
  it('uses each client documented user-scoped stdio command without secrets or ports', async () => {
    const run = vi.fn(async (_provider: string, _path: string, args: readonly string[]) => ({
      ok: !args.includes('get'),
      stdout: args.includes('get') ? 'No MCP server named dnaforge' : '',
    }));
    const launcher = '/Applications/DNAForge.app/Contents/Resources/cli/dnaforge';

    const results = await registerExternalMcpClients({
      isPackaged: true,
      repairCliConfig: async () => true,
      registerDesktopClients: async () => [],
      resourcesPath: '/Applications/DNAForge.app/Contents/Resources',
      detectClaudeCode: async () => ({ cli: 'installed', path: '/usr/local/bin/claude' }),
      detectGrok: async () => ({ cli: 'missing', path: null }),
      detectCodex: async () => ({ cli: 'installed', path: '/usr/local/bin/codex' }),
      run,
    });

    expect(results).toEqual([
      { client: 'Claude Code', status: 'registered' },
      { client: 'Codex', status: 'registered' },
      { client: 'Grok Build', status: 'not-installed' },
    ]);
    expect(run).toHaveBeenCalledWith('claude', '/usr/local/bin/claude', [
      'mcp',
      'add',
      '--scope',
      'user',
      'dnaforge',
      '--',
      launcher,
      'mcp',
    ]);
    expect(run).toHaveBeenCalledWith('codex', '/usr/local/bin/codex', [
      'mcp',
      'add',
      'dnaforge',
      '--',
      launcher,
      'mcp',
    ]);
    expect(JSON.stringify(run.mock.calls)).not.toMatch(/token|key|127\.0\.0\.1|:\d{4}/i);
  });

  it('keeps a current registration and repairs only a prior app-owned path', async () => {
    const launcher = '/Applications/DNAForge.app/Contents/Resources/cli/dnaforge';
    const run = vi.fn(async (provider: string, _path: string, args: readonly string[]) => {
      if (args.includes('get') && provider === 'claude') {
        return {
          ok: true,
          stdout: JSON.stringify({ transport: { command: launcher, args: ['mcp'] } }),
        };
      }
      if (args.includes('get')) {
        return {
          ok: true,
          stdout: JSON.stringify({
            transport: {
              type: 'stdio',
              command: '/Applications/DNAForge Old.app/Contents/Resources/cli/dnaforge',
              args: ['mcp'],
            },
          }),
        };
      }
      return { ok: true, stdout: '' };
    });

    const results = await registerExternalMcpClients({
      isPackaged: true,
      repairCliConfig: async () => true,
      registerDesktopClients: async () => [],
      resourcesPath: '/Applications/DNAForge.app/Contents/Resources',
      detectClaudeCode: async () => ({ cli: 'installed', path: '/bin/claude' }),
      detectGrok: async () => ({ cli: 'missing', path: null }),
      detectCodex: async () => ({ cli: 'installed', path: '/bin/codex' }),
      run,
    });

    expect(results).toEqual([
      { client: 'Claude Code', status: 'current' },
      { client: 'Codex', status: 'repaired' },
      { client: 'Grok Build', status: 'not-installed' },
    ]);
    expect(run.mock.calls.some((call) => call[2].includes('remove'))).toBe(false);
  });

  it('does not overwrite an unrelated server using the canonical name', async () => {
    const run = vi.fn(async () => ({
      ok: true,
      stdout: JSON.stringify({
        transport: { command: '/usr/local/bin/unrelated', args: ['serve'] },
      }),
    }));

    const results = await registerExternalMcpClients({
      isPackaged: true,
      repairCliConfig: async () => true,
      registerDesktopClients: async () => [],
      resourcesPath: '/Applications/DNAForge.app/Contents/Resources',
      detectClaudeCode: async () => ({ cli: 'installed', path: '/bin/claude' }),
      detectGrok: async () => ({ cli: 'missing', path: null }),
      detectCodex: async () => ({ cli: 'missing', path: null }),
      run,
    });

    expect(results).toEqual([
      { client: 'Claude Code', status: 'name-conflict' },
      { client: 'Codex', status: 'not-installed' },
      { client: 'Grok Build', status: 'not-installed' },
    ]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does nothing outside a packaged install', async () => {
    const run = vi.fn();
    const registerDesktopClients = vi.fn();
    await expect(
      registerExternalMcpClients({
        isPackaged: false,
        resourcesPath: '/repo/resources',
        detectClaudeCode: vi.fn(),
        detectGrok: async () => ({ cli: 'missing', path: null }),
        detectCodex: vi.fn(),
        run,
        registerDesktopClients,
      })
    ).resolves.toEqual([]);
    expect(run).not.toHaveBeenCalled();
    expect(registerDesktopClients).not.toHaveBeenCalled();
  });

  it('includes desktop registrations at startup without a Settings request', async () => {
    const registerDesktopClients = vi.fn(async () => [
      { client: 'Claude Desktop' as const, status: 'registered' as const },
      { client: 'Cursor' as const, status: 'current' as const },
    ]);
    const result = await refreshExternalMcpRegistration({
      isPackaged: true,
      resourcesPath: '/Applications/DNAForge.app/Contents/Resources',
      detectClaudeCode: async () => ({ cli: 'missing', path: null }),
      detectGrok: async () => ({ cli: 'missing', path: null }),
      detectCodex: async () => ({ cli: 'missing', path: null }),
      registerDesktopClients,
    });
    expect(registerDesktopClients).toHaveBeenCalledWith(
      '/Applications/DNAForge.app/Contents/Resources/cli/dnaforge'
    );
    expect(result.clients.slice(3)).toEqual(await registerDesktopClients.mock.results[0].value);
  });

  it('reports a client whose add command fails', async () => {
    const run = vi.fn(async () => ({ ok: false, stdout: 'permission denied' }));

    const results = await registerExternalMcpClients({
      isPackaged: true,
      repairCliConfig: async () => true,
      registerDesktopClients: async () => [],
      resourcesPath: '/Applications/DNAForge.app/Contents/Resources',
      detectClaudeCode: async () => ({ cli: 'installed', path: '/bin/claude' }),
      detectGrok: async () => ({ cli: 'missing', path: null }),
      detectCodex: async () => ({ cli: 'missing', path: null }),
      run,
    });

    expect(results[0]).toEqual({ client: 'Claude Code', status: 'failed' });
  });

  it('publishes the latest outcome and the launcher for Settings', async () => {
    const resourcesPath = '/Applications/DNAForge.app/Contents/Resources';
    await refreshExternalMcpRegistration({
      isPackaged: true,
      repairCliConfig: async () => true,
      registerDesktopClients: async () => [],
      resourcesPath,
      detectClaudeCode: async () => ({ cli: 'installed', path: '/bin/claude' }),
      detectGrok: async () => ({ cli: 'missing', path: null }),
      detectCodex: async () => ({ cli: 'missing', path: null }),
      run: async (_provider, _path, args) => ({
        ok: !args.includes('get'),
        stdout: args.includes('get') ? 'No MCP server named dnaforge' : '',
      }),
    });

    expect(externalMcpRegistrationSnapshot()).toEqual({
      state: 'complete',
      launcher: expect.stringMatching(/Resources[\\/]cli[\\/]dnaforge(\.cmd)?$/),
      clients: [
        { client: 'Claude Code', status: 'registered' },
        { client: 'Codex', status: 'not-installed' },
        { client: 'Grok Build', status: 'not-installed' },
      ],
    });

    await refreshExternalMcpRegistration({ isPackaged: false, resourcesPath });
    expect(externalMcpRegistrationSnapshot()).toEqual({
      state: 'development-build',
      launcher: null,
      clients: [],
    });
  });

  it('isolates a CLI detection failure instead of preventing other registrations', async () => {
    await refreshExternalMcpRegistration({
      isPackaged: true,
      repairCliConfig: async () => true,
      registerDesktopClients: async () => [],
      resourcesPath: '/Applications/DNAForge.app/Contents/Resources',
      detectClaudeCode: async () => {
        throw new Error('PATH repair failed');
      },
      detectGrok: async () => ({ cli: 'missing', path: null }),
      detectCodex: async () => ({ cli: 'missing', path: null }),
    });

    expect(externalMcpRegistrationSnapshot()).toMatchObject({
      state: 'complete',
      clients: [
        { client: 'Claude Code', status: 'failed' },
        { client: 'Codex', status: 'not-installed' },
        { client: 'Grok Build', status: 'not-installed' },
      ],
    });
  });

  it('starts desktop registration without waiting for CLI detection', async () => {
    let finishDetection!: (value: { cli: 'missing'; path: null }) => void;
    const slowDetection = new Promise<{ cli: 'missing'; path: null }>((resolve) => {
      finishDetection = resolve;
    });
    const registerDesktopClients = vi.fn(async () => [
      { client: 'Cursor' as const, status: 'registered' as const },
    ]);
    const registration = registerExternalMcpClients({
      isPackaged: true,
      resourcesPath: '/Applications/DNAForge.app/Contents/Resources',
      detectClaudeCode: () => slowDetection,
      detectGrok: async () => ({ cli: 'missing', path: null }),
      detectCodex: async () => ({ cli: 'missing', path: null }),
      registerDesktopClients,
    });
    expect(registerDesktopClients).toHaveBeenCalledTimes(1);
    finishDetection({ cli: 'missing', path: null });
    expect((await registration).at(-1)).toEqual({ client: 'Cursor', status: 'registered' });
  });
  it('registers Grok natively from its JSON list without relying on Claude compatibility', async () => {
    const run = vi.fn(async (_provider: string, _path: string, args: readonly string[]) => ({
      ok: true,
      stdout: args.includes('list') ? '[]' : '',
    }));
    const result = await registerExternalMcpClients({
      isPackaged: true,
      resourcesPath: '/Applications/DNAForge.app/Contents/Resources',
      detectClaudeCode: async () => ({ cli: 'missing', path: null }),
      detectCodex: async () => ({ cli: 'missing', path: null }),
      detectGrok: async () => ({ cli: 'installed', path: '/bin/grok' }),
      repairCliConfig: async () => true,
      registerDesktopClients: async () => [],
      run,
    });
    expect(result.at(-1)).toEqual({ client: 'Grok Build', status: 'registered' });
    expect(run).toHaveBeenCalledWith('grok', '/bin/grok', ['mcp', 'list', '--json']);
    expect(run).toHaveBeenCalledWith('grok', '/bin/grok', [
      'mcp',
      'add',
      '--scope',
      'user',
      'dnaforge',
      '--',
      '/Applications/DNAForge.app/Contents/Resources/cli/dnaforge',
      'mcp',
    ]);
  });

  it.each(['permission denied', 'config.toml is invalid', ''])(
    'does not write after a failed inspection: %s',
    async (message) => {
      const run = vi.fn(async (_provider: string, _path: string, _args: readonly string[]) => ({
        ok: false,
        stdout: message,
      }));
      const result = await registerExternalMcpClients({
        isPackaged: true,
        resourcesPath: '/Applications/DNAForge.app/Contents/Resources',
        detectClaudeCode: async () => ({ cli: 'installed', path: '/bin/claude' }),
        detectCodex: async () => ({ cli: 'installed', path: '/bin/codex' }),
        detectGrok: async () => ({ cli: 'installed', path: '/bin/grok' }),
        repairCliConfig: async () => true,
        registerDesktopClients: async () => [],
        run,
      });
      expect(result.every(({ status }) => status === 'failed')).toBe(true);
      expect(run.mock.calls.every((call) => !call[2].includes('add'))).toBe(true);
    }
  );

  it.each([
    ['/Applications/DNAForge.app/Contents/Resources/cli/dnaforge', 'current'],
    ['/Applications/DNAForge Old.app/Contents/Resources/cli/dnaforge', 'repaired'],
    ['/bin/something-else', 'name-conflict'],
  ])('keeps or repairs the exact Grok command: %s', async (command, status) => {
    const run = vi.fn(async (_provider: string, _path: string, args: readonly string[]) => ({
      ok: true,
      stdout: args.includes('list')
        ? JSON.stringify([{ name: 'dnaforge', command, args: ['mcp'], scope: 'user' }])
        : '',
    }));
    const result = await registerExternalMcpClients({
      isPackaged: true,
      resourcesPath: '/Applications/DNAForge.app/Contents/Resources',
      detectClaudeCode: async () => ({ cli: 'missing', path: null }),
      detectCodex: async () => ({ cli: 'missing', path: null }),
      detectGrok: async () => ({ cli: 'installed', path: '/bin/grok' }),
      repairCliConfig: async () => true,
      registerDesktopClients: async () => [],
      run,
    });
    expect(result.at(-1)).toEqual({ client: 'Grok Build', status });
    expect(run.mock.calls.some((call) => call[2].includes('remove'))).toBe(false);
  });

  it('shares an in-flight refresh instead of racing external writes', async () => {
    let finish!: (results: []) => void;
    const registerDesktopClients = vi.fn(
      () =>
        new Promise<[]>((resolve) => {
          finish = resolve;
        })
    );
    const options = {
      isPackaged: true,
      resourcesPath: '/Applications/DNAForge.app/Contents/Resources',
      detectClaudeCode: async () => ({ cli: 'missing' as const, path: null }),
      detectCodex: async () => ({ cli: 'missing' as const, path: null }),
      detectGrok: async () => ({ cli: 'missing' as const, path: null }),
      registerDesktopClients,
    };
    const first = refreshExternalMcpRegistration(options);
    const second = refreshExternalMcpRegistration(options);
    expect(registerDesktopClients).toHaveBeenCalledTimes(1);
    finish([]);
    expect(await second).toEqual(await first);
  });
});
