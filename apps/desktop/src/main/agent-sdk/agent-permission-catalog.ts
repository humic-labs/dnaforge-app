import { spawn } from 'node:child_process';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  BUILT_IN_AGENT_PERMISSION_CATALOG,
  CODEX_MENU,
  cliModeChoices,
  codexChoice,
  codexCustomProfileChoice,
  isPermissionWord,
  type AgentPermissionCatalog,
  type AgentPermissionChoice,
  type AgentPermissionKey,
  type AgentPermissionOptions,
} from '../../shared/agent-permissions';
import { nodeAwareSpawn } from './cli-layout';
import { findInstalledAgentCli } from './detect';
import { codexCliEnv, subprocessEnv, type SubprocessTarget } from './subprocess-env';

const PROBE_TIMEOUT_MS = 15_000;
const BUILT_IN = BUILT_IN_AGENT_PERMISSION_CATALOG;

const GROK_CONFIG_WORDS: Readonly<Record<string, string>> = {
  'always-approve': 'bypassPermissions',
  ask: 'default',
};

interface CodexPermissionState {
  readonly choices: readonly AgentPermissionChoice[];
  readonly current: string | null;
}

interface Discovered {
  readonly options: AgentPermissionOptions;
  readonly codexCurrent: string | null;
}

interface CodexProfileSummary {
  readonly id: string;
  readonly description: string | null;
}

export function permissionModesFromHelp(help: string): string[] {
  const start = help.indexOf('--permission-mode');
  if (start < 0) return [];
  const section = help.slice(start).split(/\n\s*-/, 1)[0] ?? '';
  const quoted = /\(choices:([^)]*)\)/.exec(section)?.[1];
  const listed = /\[possible values: ([^\]]*)\]/.exec(section)?.[1];
  const words = quoted
    ? [...quoted.matchAll(/"([^"]+)"/g)].map((match) => match[1])
    : (listed?.split(',').map((word) => word.trim()) ?? []);
  return words.filter(isPermissionWord);
}

export function codexAllowedProfiles(entries: readonly unknown[]): CodexProfileSummary[] {
  return entries.flatMap((entry) => {
    const profile = entry as { id?: unknown; description?: unknown; allowed?: unknown } | null;
    if (!isPermissionWord(profile?.id) || profile.allowed === false) return [];
    return [
      {
        id: profile.id,
        description: typeof profile.description === 'string' ? profile.description : null,
      },
    ];
  });
}

export function codexMenuChoices(
  profiles: readonly CodexProfileSummary[],
  approveForMeEnabled: boolean
): AgentPermissionChoice[] {
  const offered = new Set(profiles.map((profile) => profile.id));
  return [
    ...CODEX_MENU.filter(
      (item) =>
        offered.has(item.profile) && (item.value !== ':approve-for-me' || approveForMeEnabled)
    ).map(codexChoice),
    ...profiles
      .filter((profile) => !profile.id.startsWith(':'))
      .map((profile) => codexCustomProfileChoice(profile.id, profile.description)),
  ];
}

export function currentCodexChoice(
  threadStartResult: unknown,
  choices: readonly AgentPermissionChoice[]
): string | null {
  const result = threadStartResult as {
    activePermissionProfile?: { id?: unknown };
    approvalPolicy?: unknown;
    approvalsReviewer?: unknown;
  } | null;
  const profile = result?.activePermissionProfile?.id;
  if (typeof profile !== 'string') return null;
  const reviewer =
    result?.approvalsReviewer === 'guardian_subagent' ? 'auto_review' : result?.approvalsReviewer;
  const offered = CODEX_MENU.filter(
    (item) => item.profile === profile && choices.some((choice) => choice.value === item.value)
  );
  const exact = offered.find(
    (item) => item.approvalPolicy === result?.approvalPolicy && item.approvalsReviewer === reviewer
  );
  if (exact ?? offered[0]) return (exact ?? offered[0]).value;
  return choices.some((choice) => choice.value === profile) ? profile : null;
}

async function cliOutput(
  binaryPath: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dnaforge-agent-permissions-'));
  const outputPath = join(dir, 'output.txt');
  try {
    const output = await open(outputPath, 'w');
    try {
      const spawnable = nodeAwareSpawn(binaryPath, args, env);
      await new Promise<void>((resolve, reject) => {
        const child = spawn(spawnable.file, spawnable.args, {
          env: spawnable.env,
          stdio: ['ignore', output.fd, 'ignore'],
          timeout: PROBE_TIMEOUT_MS,
        });
        child.on('error', reject);
        child.on('exit', (code, signal) => {
          if (code === 0) resolve();
          else reject(new Error(`${binaryPath} ${args.join(' ')} exited with ${signal ?? code}`));
        });
      });
    } finally {
      await output.close();
    }
    return await readFile(outputPath, 'utf8');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function helpModes(provider: Extract<SubprocessTarget, 'claude' | 'grok'>) {
  const { path } = await findInstalledAgentCli(provider);
  if (!path) return null;
  const words = permissionModesFromHelp(await cliOutput(path, ['--help'], subprocessEnv(provider)));
  const choices = cliModeChoices(provider, words);
  return choices.length > 0 ? choices : null;
}

async function askCodex(binaryPath: string): Promise<CodexPermissionState | null> {
  const cwd = homedir();
  const child = spawn(binaryPath, ['app-server'], {
    cwd,
    env: codexCliEnv(),
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const pending = new Map<number, (message: { result?: unknown; error?: unknown }) => void>();
  let nextId = 1;
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message: { id?: unknown; result?: unknown; error?: unknown };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    if (typeof message.id !== 'number') return;
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  const write = (message: Record<string, unknown>): void => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  };
  const request = (method: string, params: Record<string, unknown>): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (message) =>
        message.error ? reject(new Error(`${method} failed`)) : resolve(message.result)
      );
      write({ id, method, params });
    });
  const listAll = async (method: string, params: Record<string, unknown>) => {
    const entries: unknown[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const result = (await request(method, cursor ? { ...params, cursor } : params)) as {
        data?: unknown;
        nextCursor?: unknown;
      } | null;
      if (Array.isArray(result?.data)) entries.push(...(result.data as unknown[]));
      cursor = typeof result?.nextCursor === 'string' ? result.nextCursor : null;
      if (!cursor) break;
    }
    return entries;
  };

  let timer: NodeJS.Timeout | undefined;
  const stopped = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Codex did not answer in time')), PROBE_TIMEOUT_MS);
    child.on('error', reject);
    child.on('exit', () => reject(new Error('Codex app-server exited')));
  });
  stopped.catch(() => undefined);
  const work = async (): Promise<CodexPermissionState | null> => {
    await request('initialize', { clientInfo: { name: 'dnaforge', version: '1' } });
    write({ method: 'initialized' });
    const profiles = codexAllowedProfiles(await listAll('permissionProfile/list', { cwd }));
    if (profiles.length === 0) return null;
    const features = await listAll('experimentalFeature/list', {}).catch(() => []);
    const approveForMe = features.some((feature) => {
      const entry = feature as { name?: unknown; enabled?: unknown } | null;
      return entry?.name === 'guardian_approval' && entry.enabled === true;
    });
    const choices = codexMenuChoices(profiles, approveForMe);
    const threadStart = await request('thread/start', { cwd, ephemeral: true });
    return { choices, current: currentCodexChoice(threadStart, choices) };
  };
  try {
    return await Promise.race([work(), stopped]);
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}

async function codexPermissions(): Promise<CodexPermissionState | null> {
  const { path } = await findInstalledAgentCli('codex');
  return path ? askCodex(path) : null;
}

function withFallback<T>(label: string, probe: Promise<T | null>): Promise<T | null> {
  return probe
    .catch((error: unknown) => {
      console.warn(`[agent-permissions] Could not read ${label} permission words:`, error);
      return null;
    })
    .then((value) => {
      if (value === null) {
        console.warn(`[agent-permissions] Using the built-in ${label} permission words.`);
      }
      return value;
    });
}

async function discover(): Promise<Discovered> {
  const [claude, grok, codex] = await Promise.all([
    withFallback('Claude Code', helpModes('claude')),
    withFallback('Grok Build', helpModes('grok')),
    withFallback('Codex', codexPermissions()),
  ]);
  return {
    options: {
      claude: claude ?? BUILT_IN.options.claude,
      grok: grok ?? BUILT_IN.options.grok,
      codex: codex?.choices ?? BUILT_IN.options.codex,
    },
    codexCurrent: codex?.current ?? null,
  };
}

async function claudeConfiguredMode(home: string): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(home, '.claude', 'settings.json'), 'utf8')
    );
    const mode = (parsed as { permissions?: { defaultMode?: unknown } } | null)?.permissions
      ?.defaultMode;
    return typeof mode === 'string' ? mode : null;
  } catch {
    return null;
  }
}

async function grokConfiguredMode(home: string): Promise<string | null> {
  try {
    const text = await readFile(join(home, '.grok', 'config.toml'), 'utf8');
    const word = /^\s*permission_mode\s*=\s*"([^"]+)"/m.exec(text)?.[1];
    return word ? (GROK_CONFIG_WORDS[word] ?? word) : null;
  } catch {
    return null;
  }
}

let discovery: Promise<Discovered> | null = null;

export async function readAgentPermissionCatalog(): Promise<AgentPermissionCatalog> {
  const home = homedir();
  discovery ??= discover();
  const [{ options, codexCurrent }, claudeMode, grokMode] = await Promise.all([
    discovery,
    claudeConfiguredMode(home),
    grokConfiguredMode(home),
  ]);
  const pick = (key: AgentPermissionKey, ...candidates: (string | null | undefined)[]) =>
    [...candidates, BUILT_IN.defaults[key]].find((word): word is string =>
      options[key].some((choice) => choice.value === word)
    ) ??
    options[key][0]?.value ??
    BUILT_IN.defaults[key];
  return {
    options,
    defaults: {
      claude: pick('claude', claudeMode, 'manual', 'default'),
      grok: pick('grok', grokMode, claudeMode, 'default'),
      codex: pick('codex', codexCurrent),
    },
  };
}
