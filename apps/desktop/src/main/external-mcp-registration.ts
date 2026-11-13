import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { findInstalledAgentCli } from './agent-sdk/detect';
import { nodeAwareSpawn } from './agent-sdk/cli-layout';
import { subprocessEnv } from './agent-sdk/subprocess-env';
import { registerDesktopMcpClients } from './external-mcp-desktop-clients';
import { externalMcpStdioConfig } from '../shared/external-mcp-registration';
import { observeExternalRegistration } from './external-access-observation';
import {
  externalMcpClientEnvironment,
  inspectClaudeMcpConfig,
  repairNativeMcpConfig,
} from './external-mcp-config-files';
import type {
  ExternalMcpRegistrationResult,
  ExternalMcpRegistrationSnapshot,
  ExternalMcpRegistrationStatus,
} from '../shared/external-mcp-registration';

const execFileAsync = promisify(execFile);

type SupportedClient = 'claude' | 'codex' | 'grok';
interface Detection {
  cli: 'installed' | 'missing';
  path: string | null;
}

type CommandRunner = (
  provider: SupportedClient,
  executable: string,
  args: readonly string[]
) => Promise<{ ok: boolean; stdout: string }>;

interface RegistrationOptions {
  isPackaged: boolean;
  resourcesPath: string;
  detectClaudeCode?: () => Promise<Detection>;
  detectCodex?: () => Promise<Detection>;
  detectGrok?: () => Promise<Detection>;
  run?: CommandRunner;
  registerDesktopClients?: (launcher: string) => Promise<ExternalMcpRegistrationResult[]>;
  retryMissingOnly?: boolean;
  repairCliConfig?: typeof repairNativeMcpConfig;
}

let snapshot: ExternalMcpRegistrationSnapshot = { state: 'pending', launcher: null, clients: [] };
let refreshInFlight: Promise<ExternalMcpRegistrationSnapshot> | null = null;

export function startExternalMcpRegistration(options: RegistrationOptions): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let initial = true;
  const check = async () => {
    await refreshExternalMcpRegistration({ ...options, retryMissingOnly: !initial });
    initial = false;
    if (!stopped && options.isPackaged) {
      timer = setTimeout(() => void check(), 15 * 60_000);
      timer.unref();
    }
  };
  void check();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

function registerDesktopClients(launcher: string): Promise<ExternalMcpRegistrationResult[]> {
  if (process.env.WAYPOINT_TEST === '1') {
    const home = process.env.DNAFORGE_EXTERNAL_MCP_CONFIG_HOME;
    return home
      ? registerDesktopMcpClients(launcher, {
          home,
          platform: process.platform,
          appData: join(home, 'AppData', 'Roaming'),
          applicationDirectories: [],
        })
      : Promise.resolve([]);
  }
  return registerDesktopMcpClients(launcher);
}

export function externalMcpRegistrationSnapshot(): ExternalMcpRegistrationSnapshot {
  return snapshot;
}

export function refreshExternalMcpRegistration(
  options: RegistrationOptions
): Promise<ExternalMcpRegistrationSnapshot> {
  if (refreshInFlight) return refreshInFlight;
  const refresh = runRegistrationRefresh(options);
  refreshInFlight = refresh;
  void refresh.finally(() => {
    if (refreshInFlight === refresh) refreshInFlight = null;
  });
  return refresh;
}

async function runRegistrationRefresh(
  options: RegistrationOptions
): Promise<ExternalMcpRegistrationSnapshot> {
  if (!options.isPackaged) {
    snapshot = { state: 'development-build', launcher: null, clients: [] };
    return snapshot;
  }
  const launcher = bundledLauncher(options.resourcesPath);
  try {
    snapshot = { state: 'complete', launcher, clients: await registerExternalMcpClients(options) };
  } catch (error) {
    snapshot = {
      state: 'failed',
      launcher,
      clients: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return snapshot;
}

function bundledLauncher(resourcesPath: string): string {
  return join(resourcesPath, 'cli', process.platform === 'win32' ? 'dnaforge.cmd' : 'dnaforge');
}

export async function registerExternalMcpClients(
  options: RegistrationOptions
): Promise<ExternalMcpRegistrationResult[]> {
  if (!options.isPackaged) return [];
  const launcher = bundledLauncher(options.resourcesPath);
  if (
    process.env.WAYPOINT_TEST === '1' &&
    !process.env.DNAFORGE_EXTERNAL_MCP_CONFIG_HOME &&
    !options.run
  )
    return [];
  const run = options.run ?? runExternalMcpClientCommand;
  const registerCli = async (
    provider: SupportedClient,
    client: 'Claude Code' | 'Codex' | 'Grok Build',
    detect: () => Promise<Detection>
  ): Promise<ExternalMcpRegistrationResult> => {
    try {
      const prior =
        snapshot.launcher === launcher &&
        snapshot.clients.find((result) => result.client === client);
      if (
        options.retryMissingOnly &&
        prior &&
        ['current', 'registered', 'repaired'].includes(prior.status)
      )
        return prior;
      const detection = await detect();
      const result: ExternalMcpRegistrationResult = {
        client,
        status:
          detection.cli === 'installed' && detection.path
            ? await registerClient(
                provider,
                detection.path,
                launcher,
                run,
                options.repairCliConfig ?? repairNativeMcpConfig
              )
            : 'not-installed',
      };
      observeExternalRegistration(result.client, result.status);
      return result;
    } catch {
      observeExternalRegistration(client, 'failed');
      return { client, status: 'failed' };
    }
  };
  const [claude, codex, grok, desktops] = await Promise.all([
    registerCli(
      'claude',
      'Claude Code',
      options.detectClaudeCode ?? (() => findInstalledAgentCli('claude'))
    ),
    registerCli('codex', 'Codex', options.detectCodex ?? (() => findInstalledAgentCli('codex'))),
    registerCli('grok', 'Grok Build', options.detectGrok ?? (() => findInstalledAgentCli('grok'))),
    (async () => {
      const results = await (options.registerDesktopClients ?? registerDesktopClients)(launcher);
      for (const result of results) observeExternalRegistration(result.client, result.status);
      return results;
    })(),
  ]);
  return [claude, codex, grok, ...desktops];
}

async function registerClient(
  provider: SupportedClient,
  executable: string,
  launcher: string,
  run: CommandRunner,
  repair: typeof repairNativeMcpConfig
): Promise<ExternalMcpRegistrationStatus> {
  const existing = await run(
    provider,
    executable,
    provider === 'grok'
      ? ['mcp', 'list', '--json']
      : provider === 'codex'
        ? ['mcp', 'get', 'dnaforge', '--json']
        : ['mcp', 'get', 'dnaforge']
  );
  if (existing.ok) {
    if (provider === 'grok') {
      const entries: unknown = JSON.parse(existing.stdout);
      if (!Array.isArray(entries)) return 'failed';
      const entry = entries.find(
        (value: unknown) => isRecord(value) && value.name === 'dnaforge' && value.scope === 'user'
      );
      if (entry === undefined) {
        const added = await run(provider, executable, addArguments(provider, launcher));
        return added.ok ? 'registered' : 'failed';
      }
      if (!isRecord(entry)) return 'name-conflict';
      const previous = stdioLauncher(entry.command, entry.args);
      if (previous === launcher) return 'current';
      if (!previous || !isOwnedLauncher(previous)) return 'name-conflict';
      return (await repair(provider, previous, launcher)) ? 'repaired' : 'failed';
    }
    const entry: unknown = JSON.parse(existing.stdout);
    if (!isRecord(entry) || !isRecord(entry.transport)) return 'failed';
    const { command, args } = entry.transport;
    const previous = stdioLauncher(command, args);
    if (previous === launcher) return 'current';
    if (!previous || !isOwnedLauncher(previous)) return 'name-conflict';
    return (await repair(provider, previous, launcher)) ? 'repaired' : 'failed';
  }
  if (!/no mcp server named ["']?dnaforge["']?/iu.test(existing.stdout)) return 'failed';
  const added = await run(provider, executable, addArguments(provider, launcher));
  return added.ok ? 'registered' : 'failed';
}

function addArguments(provider: SupportedClient, launcher: string): string[] {
  const stdio = externalMcpStdioConfig(launcher, process.platform);
  return provider === 'claude' || provider === 'grok'
    ? ['mcp', 'add', '--scope', 'user', 'dnaforge', '--', stdio.command, ...stdio.args]
    : ['mcp', 'add', 'dnaforge', '--', stdio.command, ...stdio.args];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isOwnedLauncher(command: string): boolean {
  return /\/resources\/cli\/dnaforge(?:\.cmd)?$/iu.test(command.replaceAll('\\', '/'));
}

function stdioLauncher(command: unknown, args: unknown): string | null {
  if (typeof command !== 'string' || !Array.isArray(args)) return null;
  if (command === 'cmd' && args[0] === '/c' && typeof args[1] === 'string' && args[2] === 'mcp')
    return args[1];
  return args[0] === 'mcp' ? command : null;
}

export async function runExternalMcpClientCommand(
  provider: SupportedClient,
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  cwd = homedir()
): Promise<{ ok: boolean; stdout: string }> {
  const base = externalMcpClientEnvironment(environment);
  if (provider === 'claude' && args[0] === 'mcp' && args[1] === 'get' && args[2] === 'dnaforge')
    return inspectClaudeMcpConfig(base);
  const spawnable = nodeAwareSpawn(executable, args, subprocessEnv(provider, base));
  if (provider === 'grok') {
    for (const key of ['GROK_HOME', 'GROK_CLAUDE_MCPS_ENABLED', 'GROK_CURSOR_MCPS_ENABLED']) {
      if (base[key]) spawnable.env[key] = base[key];
    }
  }
  try {
    const result = await execFileAsync(spawnable.file, spawnable.args, {
      env: spawnable.env,
      cwd,
      timeout: 10_000,
      maxBuffer: 512_000,
      windowsHide: true,
    });
    if (
      provider === 'grok' &&
      args[0] === 'mcp' &&
      args[1] === 'list' &&
      /\bERROR\b[^\n]*\bconfig\b|\bconfig layer failed to load\b/iu.test(result.stderr)
    ) {
      return { ok: false, stdout: 'Grok configuration inspection failed.' };
    }
    return { ok: true, stdout: result.stdout };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string };
    return { ok: false, stdout: `${failed.stdout ?? ''}\n${failed.stderr ?? ''}` };
  }
}
