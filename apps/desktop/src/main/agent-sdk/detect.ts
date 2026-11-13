// @vendor-credential-boundary: probe
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { getSearchedCliDirs } from './resolve-shell-path';
import { nodeAwareSpawn } from './cli-layout';
import {
  isRepoLocalNodeModulesBin,
  resolveWin32SpawnablePath,
  pathExists,
  resolveAgentCliPresence,
} from './cli-presence';
import { trackAgentHelperOperation } from './helper-lifecycle';
import { CODEX_APP_MCP_FEATURES } from './codex-mcp-session-config';
import { claudeCliEnv, codexCliEnv, subprocessEnv } from './subprocess-env';
import type {
  AgentCliModelCapabilityShape,
  AgentCliPathOverridesShape,
} from '../../shared/agent-runtime-ipc';
import { collectCodexModelCatalog, mapClaudeModelCatalog } from './model-catalog';
import { launchLocalCodexAppServer } from './local-codex-app-server';
import { captureModelCatalogDiscovery } from './model-catalog-discovery';
import type { AgentCliModelCatalogDiscoveryShape } from '../../shared/agent-runtime-ipc';

export { resolveAmbientGrokAuthPath } from './subprocess-env';

const execFileAsync = promisify(execFile);

export type CliStatus = 'installed' | 'missing';
export type AuthStatus = 'authenticated' | 'unauthenticated' | 'unknown';

export interface ClaudeCodeDetection {
  cli: CliStatus;
  path: string | null;
  auth: AuthStatus;
  defaultModel: string | null;
  keychainEntryPresent: boolean | null;
  credentialsFilePresent: boolean | null;
  searchedDirs?: string[];
  models?: AgentCliModelCapabilityShape[];
  modelCatalog?: AgentCliModelCatalogDiscoveryShape;
}

export interface CodexDetection {
  cli: CliStatus;
  path: string | null;
  auth: AuthStatus;
  defaultModel: string | null;
  configuredReasoningEffort?: string | null;
  authMode: 'chatgpt' | 'apikey' | null;
  authFilePresent: boolean;
  searchedDirs?: string[];
  models?: AgentCliModelCapabilityShape[];
  modelCatalog?: AgentCliModelCatalogDiscoveryShape;
}

export interface GrokDetection {
  cli: CliStatus;
  path: string | null;
  auth: AuthStatus;
  defaultModel: string | null;
  availableModels: string[];
  searchedDirs?: string[];
  models?: AgentCliModelCapabilityShape[];
  modelCatalog?: AgentCliModelCatalogDiscoveryShape;
}

export interface AgentSdkDetection {
  claudeCode: ClaudeCodeDetection;
  codex: CodexDetection;
  grok: GrokDetection;
}

interface ParsedCodexVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<string | number>;
}

function parseCodexVersion(raw: string): ParsedCodexVersion | null {
  const match = raw.match(/(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]
      ? match[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part))
      : [],
  };
}

function comparePrerelease(
  left: ParsedCodexVersion['prerelease'],
  right: ParsedCodexVersion['prerelease']
): number {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    if (typeof a === 'number' && typeof b === 'number') return a > b ? 1 : -1;
    if (typeof a === 'number') return -1;
    if (typeof b === 'number') return 1;
    return a > b ? 1 : -1;
  }
  return 0;
}

function compareCodexVersions(left: ParsedCodexVersion, right: ParsedCodexVersion): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

async function readCodexVersion(path: string): Promise<ParsedCodexVersion | null> {
  try {
    const spawnable = nodeAwareSpawn(path, ['--version'], subprocessEnv('codex'));
    const { stdout, stderr } = await execFileAsync(spawnable.file, spawnable.args, {
      timeout: 2000,
      env: spawnable.env,
    });
    return parseCodexVersion(`${stdout}\n${stderr}`);
  } catch {
    return null;
  }
}

async function selectNewestCodexCandidate(pathCandidates: string[]): Promise<string | null> {
  const candidates = [...new Set(pathCandidates)].filter(
    (candidate) => candidate.length > 0 && !isRepoLocalNodeModulesBin(candidate)
  );
  if (candidates.length === 0) return null;

  const probed = await Promise.all(
    candidates.map(async (path, order) => ({ path, order, version: await readCodexVersion(path) }))
  );
  const versioned = probed.filter(
    (candidate): candidate is typeof candidate & { version: ParsedCodexVersion } =>
      candidate.version !== null
  );
  if (versioned.length === 0) return candidates[0];

  versioned.sort((left, right) => {
    const byVersion = compareCodexVersions(right.version, left.version);
    return byVersion !== 0 ? byVersion : left.order - right.order;
  });
  return versioned[0].path;
}

async function which(
  cmd: 'claude' | 'codex' | 'grok',
  binaryPathOverride?: string
): Promise<string | null> {
  const presence = await resolveAgentCliPresence(cmd, binaryPathOverride);
  if (presence.kind === 'fixed') return presence.path;
  const { externalPaths: external, fallbackPath: fallback, bundledPaths: bundled } = presence;
  const isWin = platform() === 'win32';
  if (cmd === 'codex') {
    const candidates = [...external, ...(fallback ? [fallback] : []), ...bundled];
    if (isWin) return await resolveWin32SpawnablePath('codex', candidates);
    return await selectNewestCodexCandidate(candidates);
  }
  if (isWin && cmd === 'claude') {
    return await resolveWin32SpawnablePath('claude', [
      ...external,
      ...(fallback ? [fallback] : []),
    ]);
  }
  if (isWin && cmd === 'grok') {
    return await resolveWin32SpawnablePath('grok', [...external, ...(fallback ? [fallback] : [])]);
  }
  return external[0] ?? fallback;
}

function normalizeConfiguredModel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed &&
    /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,159}$/.test(trimmed) &&
    !trimmed.includes('..')
    ? trimmed
    : null;
}

function parseTomlStringLiteral(rawValue: string): string | null {
  const value = rawValue
    .trim()
    .replace(/\s+#.*$/, '')
    .trim();
  if (!value) return null;
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return normalizeConfiguredModel(value.slice(1, -1));
  }
  return normalizeConfiguredModel(value.split(/\s+/)[0]);
}

function parseTopLevelTomlField(raw: string, field: string): string | null {
  const pattern = new RegExp(`^${field}\\s*=\\s*(.+)$`);
  let inTable = false;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('[')) {
      inTable = true;
      continue;
    }
    if (inTable) continue;
    const match = trimmed.match(pattern);
    if (match) return parseTomlStringLiteral(match[1]);
  }
  return null;
}

function codexHomeDir(): string {
  const fromEnv = process.env.CODEX_HOME?.trim();
  return fromEnv ? fromEnv : join(homedir(), '.codex');
}

async function readCodexConfiguredDefaultModel(): Promise<string | null> {
  try {
    const raw = await fs.readFile(join(codexHomeDir(), 'config.toml'), 'utf-8');
    return parseTopLevelTomlField(raw, 'model');
  } catch {
    return null;
  }
}

export async function readCodexConfiguredReasoningEffort(): Promise<string | null> {
  try {
    const raw = await fs.readFile(join(codexHomeDir(), 'config.toml'), 'utf-8');
    return parseTopLevelTomlField(raw, 'model_reasoning_effort');
  } catch {
    return null;
  }
}

export async function readCodexConfiguredMcpServerNames(
  binaryPath: string,
  options: { cwd?: string; signal?: AbortSignal } = {}
): Promise<string[]> {
  return trackAgentHelperOperation(async () => {
    const featureArgs = Object.entries(CODEX_APP_MCP_FEATURES).flatMap(([name, enabled]) => [
      '-c',
      `features.${name}=${String(enabled)}`,
    ]);
    const spawnable = nodeAwareSpawn(
      binaryPath,
      [...featureArgs, 'mcp', 'list', '--json'],
      codexCliEnv()
    );
    try {
      const { stdout } = await execFileAsync(spawnable.file, spawnable.args, {
        env: spawnable.env,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        timeout: 10_000,
        maxBuffer: Infinity,
      });
      const servers: unknown = JSON.parse(stdout);
      if (!Array.isArray(servers)) throw new Error('Invalid tool-server metadata');
      const names = servers.map((server: unknown) => {
        if (
          !server ||
          typeof server !== 'object' ||
          !('name' in server) ||
          typeof server.name !== 'string' ||
          server.name.length === 0
        )
          throw new Error('Invalid tool-server identity');
        return server.name;
      });
      return [...new Set(names)].sort();
    } catch {
      throw new Error(
        'Codex MCP configuration unavailable; the app could not isolate its tool servers.'
      );
    }
  });
}

async function readClaudeConfiguredDefaultModel(): Promise<string | null> {
  const configuredDirectory = process.env.CLAUDE_CONFIG_DIR?.trim();
  const configDirectory =
    configuredDirectory && isAbsolute(configuredDirectory)
      ? configuredDirectory
      : join(homedir(), '.claude');
  const settingsPaths = [
    join(configDirectory, 'settings.local.json'),
    join(configDirectory, 'settings.json'),
  ];
  for (const settingsPath of settingsPaths) {
    try {
      const raw = await fs.readFile(settingsPath, 'utf-8');
      const parsed = JSON.parse(raw) as { model?: unknown };
      const model = normalizeConfiguredModel(parsed.model);
      if (model) return model;
    } catch {}
  }
  return null;
}

async function execStatus(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
} | null> {
  try {
    const spawnable = nodeAwareSpawn(command, args, options.env ?? process.env);
    const { stdout, stderr } = await execFileAsync(spawnable.file, spawnable.args, {
      timeout: options.timeoutMs ?? 5000,
      env: spawnable.env,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const maybe = err as { code?: unknown; stdout?: unknown; stderr?: unknown };
    if (typeof maybe.stdout === 'string' || typeof maybe.stderr === 'string') {
      return {
        code: typeof maybe.code === 'number' ? maybe.code : 1,
        stdout: typeof maybe.stdout === 'string' ? maybe.stdout : '',
        stderr: typeof maybe.stderr === 'string' ? maybe.stderr : '',
      };
    }
    return null;
  }
}

async function probeClaudeAuthStatus(cliPath: string): Promise<AuthStatus | null> {
  const result = await execStatus(cliPath, ['auth', 'status', '--json'], {
    env: subprocessEnv('claude'),
  });
  if (!result) return null;
  try {
    const parsed = JSON.parse(result.stdout) as { loggedIn?: unknown };
    if (parsed.loggedIn === true) return 'authenticated';
    if (parsed.loggedIn === false) return 'unauthenticated';
  } catch {}
  const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (result.code === 0 && combined.includes('logged')) return 'authenticated';
  if (combined.includes('not logged') || combined.includes('not signed')) return 'unauthenticated';
  return null;
}

async function probeCodexLoginStatus(cliPath: string): Promise<{
  auth: AuthStatus;
  authMode: 'chatgpt' | 'apikey' | null;
} | null> {
  const result = await execStatus(cliPath, ['login', 'status'], {
    env: subprocessEnv('codex'),
  });
  if (!result) return null;
  const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (result.code === 0 && combined.includes('logged in')) {
    return {
      auth: 'authenticated',
      authMode: combined.includes('api key') ? 'apikey' : 'chatgpt',
    };
  }
  if (combined.includes('not logged') || combined.includes('not signed')) {
    return { auth: 'unauthenticated', authMode: null };
  }
  return null;
}

interface GrokModelsProbe {
  auth: AuthStatus;
  defaultModel: string | null;
  availableModels: string[];
}

export function parseGrokModelsOutput(output: string): {
  defaultModel: string | null;
  availableModels: string[];
} {
  const defaultModel = output.match(/^Default model:\s*(\S+)\s*$/imu)?.[1]?.trim() ?? null;
  const availableModels = [
    ...new Set(
      output
        .split(/\r?\n/u)
        .map((line) => line.match(/^\s*[*-]\s+(\S+?)(?:\s+\(default\))?\s*$/u)?.[1] ?? null)
        .filter((model): model is string => Boolean(model))
    ),
  ];
  if (defaultModel && !availableModels.includes(defaultModel)) {
    availableModels.unshift(defaultModel);
  }
  return { defaultModel, availableModels };
}

async function probeGrokModels(cliPath: string): Promise<GrokModelsProbe | null> {
  const result = await execStatus(cliPath, ['models'], {
    env: subprocessEnv('grok'),
    timeoutMs: 15_000,
  });
  if (!result) return null;
  if (result.code === 0) {
    return { auth: 'authenticated', ...parseGrokModelsOutput(result.stdout) };
  }
  const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (
    combined.includes('not logged') ||
    combined.includes('not signed') ||
    combined.includes('login required') ||
    combined.includes('authentication required')
  ) {
    return { auth: 'unauthenticated', defaultModel: null, availableModels: [] };
  }
  return { auth: 'unknown', defaultModel: null, availableModels: [] };
}

async function probeMacKeychain(service: string, account: string): Promise<boolean | null> {
  if (platform() !== 'darwin') return null;
  try {
    await execFileAsync('security', ['find-generic-password', '-s', service, '-a', account], {
      timeout: 2000,
    });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('could not be found') || msg.includes('SecKeychainSearch')) {
      return false;
    }
    if (msg.includes('command not found') || msg.includes('ENOENT')) return null;
    return false;
  }
}

export async function detectClaudeCode(binaryPathOverride?: string): Promise<ClaudeCodeDetection> {
  return trackAgentHelperOperation(async () => {
    const cliPath = await which('claude', binaryPathOverride);
    const cli: CliStatus = cliPath ? 'installed' : 'missing';
    const searchedDirs = await getSearchedCliDirs();
    const defaultModel = await readClaudeConfiguredDefaultModel();

    let keychainEntryPresent: boolean | null = null;
    let credentialsFilePresent: boolean | null = null;

    if (platform() === 'darwin') {
      keychainEntryPresent = await probeMacKeychain(
        'Claude Code-credentials',
        process.env.USER ?? ''
      );
    } else {
      credentialsFilePresent = await pathExists(join(homedir(), '.claude', '.credentials.json'));
    }

    let auth: AuthStatus = 'unknown';
    if (cli === 'missing') {
      auth = 'unauthenticated';
    } else if (cliPath) {
      const statusAuth = await probeClaudeAuthStatus(cliPath);
      if (statusAuth) auth = statusAuth;
    }

    if (auth === 'unknown') {
      if (keychainEntryPresent === true || credentialsFilePresent === true) {
        auth = 'authenticated';
      } else if (keychainEntryPresent === false || credentialsFilePresent === false) {
        auth = 'unauthenticated';
      }
    }

    return {
      cli,
      path: cliPath,
      auth,
      defaultModel,
      keychainEntryPresent,
      credentialsFilePresent,
      searchedDirs,
    };
  });
}

interface CodexAuthFile {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    account_id?: string;
  };
}

export async function detectCodex(binaryPathOverride?: string): Promise<CodexDetection> {
  return trackAgentHelperOperation(async () => {
    const cliPath = await which('codex', binaryPathOverride);
    const cli: CliStatus = cliPath ? 'installed' : 'missing';
    const searchedDirs = await getSearchedCliDirs();
    const defaultModel = await readCodexConfiguredDefaultModel();
    const configuredReasoningEffort = await readCodexConfiguredReasoningEffort();

    const authFilePath = join(codexHomeDir(), 'auth.json');
    const authFilePresent = await pathExists(authFilePath);

    let authMode: 'chatgpt' | 'apikey' | null = null;
    let auth: AuthStatus = 'unknown';

    if (cli === 'missing') {
      auth = 'unauthenticated';
    } else if (!authFilePresent) {
      auth = 'unauthenticated';
    } else {
      try {
        const raw = await fs.readFile(authFilePath, 'utf-8');
        const parsed = JSON.parse(raw) as CodexAuthFile;
        if (parsed.auth_mode === 'chatgpt' && parsed.tokens?.access_token) {
          authMode = 'chatgpt';
          auth = 'authenticated';
        } else if (parsed.auth_mode === 'apikey' && parsed.OPENAI_API_KEY) {
          authMode = 'apikey';
          auth = 'authenticated';
        } else {
          auth = 'unauthenticated';
        }
      } catch {
        auth = 'unknown';
      }
    }

    if (cliPath) {
      const statusAuth = await probeCodexLoginStatus(cliPath);
      if (statusAuth) {
        auth = statusAuth.auth;
        authMode = statusAuth.authMode;
      }
    }

    return {
      cli,
      path: cliPath,
      auth,
      defaultModel,
      configuredReasoningEffort,
      authMode,
      authFilePresent,
      searchedDirs,
    };
  });
}

export async function findInstalledAgentCli(provider: 'claude' | 'codex' | 'grok') {
  const path = await which(provider);
  return { cli: path ? ('installed' as const) : ('missing' as const), path };
}

export async function detectGrok(binaryPathOverride?: string): Promise<GrokDetection> {
  return trackAgentHelperOperation(async () => {
    const cliPath = await which('grok', binaryPathOverride);
    const cli: CliStatus = cliPath ? 'installed' : 'missing';
    const searchedDirs = await getSearchedCliDirs();
    const models = cliPath ? await probeGrokModels(cliPath) : null;
    return {
      cli,
      path: cliPath,
      auth: cliPath ? (models?.auth ?? 'unknown') : 'unauthenticated',
      defaultModel: models?.defaultModel ?? null,
      availableModels: models?.availableModels ?? [],
      searchedDirs,
    };
  });
}

export async function detectAgentSdk(
  binaryPathOverrides: AgentCliPathOverridesShape = {}
): Promise<AgentSdkDetection> {
  const [claudeCode, codex, grok] = await Promise.all([
    detectClaudeCode(binaryPathOverrides['claude-agent-sdk']),
    detectCodex(binaryPathOverrides['codex-sdk']),
    detectGrok(binaryPathOverrides['grok-acp']),
  ]);
  return { claudeCode, codex, grok };
}

export async function detectAgentSdkWithModels(
  binaryPathOverrides: AgentCliPathOverridesShape = {}
): Promise<AgentSdkDetection> {
  const { claudeCode, codex, grok } = await detectAgentSdk(binaryPathOverrides);
  const [claudeCatalog, codexCatalog, grokCatalog] = await Promise.all([
    captureModelCatalogDiscovery({
      source: 'claude-sdk-initialization',
      executablePath: claudeCode.path,
      eligible: !!claudeCode.path,
      probe: () => probeClaudeModels(claudeCode.path!),
    }),
    captureModelCatalogDiscovery({
      source: 'codex-app-server',
      executablePath: codex.path,
      eligible: !!codex.path,
      probe: () => probeCodexModels(codex.path!),
    }),
    captureModelCatalogDiscovery({
      source: 'grok-acp-initialization',
      executablePath: grok.path,
      eligible: !!grok.path,
      probe: () =>
        import('./grok-acp').then(({ probeGrokModelCatalog }) => probeGrokModelCatalog(grok.path!)),
    }),
  ]);
  for (const [provider, catalog] of [
    ['Claude', claudeCatalog],
    ['Codex', codexCatalog],
    ['Grok', grokCatalog],
  ] as const) {
    if (catalog.modelCatalog.status === 'failed') {
      console.warn(`[agent-sdk] ${provider} model discovery failed:`, catalog.modelCatalog.error);
    }
  }
  const claudeModels = claudeCatalog.models;
  const codexModels = codexCatalog.models;
  const grokModels = grokCatalog.models;
  return {
    claudeCode: {
      ...claudeCode,
      defaultModel:
        claudeCode.defaultModel ?? claudeModels.find((model) => model.isDefault)?.id ?? null,
      models: claudeModels,
      modelCatalog: claudeCatalog.modelCatalog,
    },
    codex: {
      ...codex,
      defaultModel: codex.defaultModel ?? codexModels.find((model) => model.isDefault)?.id ?? null,
      models: codexModels,
      modelCatalog: codexCatalog.modelCatalog,
    },
    grok: {
      ...grok,
      defaultModel: grok.defaultModel ?? grokModels.find((model) => model.isDefault)?.id ?? null,
      models: grokModels,
      modelCatalog: grokCatalog.modelCatalog,
    },
  };
}

async function probeClaudeModels(binaryPath: string): Promise<AgentCliModelCapabilityShape[]> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const inputController = new AbortController();
  async function* idleInput() {
    await new Promise<void>((resolve) =>
      inputController.signal.addEventListener('abort', () => resolve(), { once: true })
    );
    yield* [];
  }
  const query = sdk.query({
    prompt: idleInput(),
    options: {
      pathToClaudeCodeExecutable: binaryPath,
      cwd: tmpdir(),
      settingSources: [],
      permissionMode: 'dontAsk',
      env: claudeCliEnv(),
    },
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    const initialized = await Promise.race([
      query.initializationResult(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Claude model discovery timed out.')), 12_000);
        timer.unref?.();
      }),
    ]);
    return mapClaudeModelCatalog(initialized.models, {
      outputStyles: initialized.available_output_styles,
      defaultStyle: initialized.output_style,
    });
  } finally {
    if (timer) clearTimeout(timer);
    inputController.abort();
    query.close();
  }
}

async function probeCodexModels(binaryPath: string): Promise<AgentCliModelCapabilityShape[]> {
  const appServer = await launchLocalCodexAppServer({
    binaryPath,
    rootDir: join(tmpdir(), 'dnaforge-codex-model-catalog'),
    requestTimeoutMs: 15_000,
  });
  try {
    if (!appServer.protocol.client.includes('model/list')) return [];
    return await collectCodexModelCatalog((method, params) =>
      appServer.supervisor.request(method, params)
    );
  } finally {
    await appServer.dispose();
  }
}
