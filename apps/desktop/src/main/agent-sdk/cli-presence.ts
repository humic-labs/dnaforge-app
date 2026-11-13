import { execFile } from 'node:child_process';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, win32 as pathWin32 } from 'node:path';
import { promisify } from 'node:util';
import { ensureShellPathRepaired, findInKnownCliDirsPresence } from './resolve-shell-path';
import {
  isDirectlySpawnableWin32,
  isNodeEntrypoint,
  parseCmdShimTargets,
  resolveCodexNativeExe,
} from './cli-layout';

const execFileAsync = promisify(execFile);

export function isRepoLocalNodeModulesBin(resolvedPath: string): boolean {
  return /(^|[/\\])node_modules[/\\]/.test(resolvedPath);
}

const CHATGPT_BUNDLED_CODEX_PATHS = [
  '/Applications/ChatGPT.app/Contents/Resources/codex',
  join(homedir(), 'Applications', 'ChatGPT.app', 'Contents', 'Resources', 'codex'),
  '/Applications/Codex.app/Contents/Resources/codex',
  join(homedir(), 'Applications', 'Codex.app', 'Contents', 'Resources', 'codex'),
];

async function executablePathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveWin32SpawnablePath(
  cmd: 'claude' | 'codex' | 'grok',
  candidates: string[]
): Promise<string | null> {
  for (const cand of candidates) {
    if (!cand) continue;
    if (isDirectlySpawnableWin32(cand)) return cand;
    if ((cmd === 'claude' || cmd === 'grok') && isNodeEntrypoint(cand)) return cand;
    const resolved = await resolveWin32ShimEntrypoint(cmd, cand);
    if (resolved) return resolved;
  }
  return null;
}

async function resolveWin32ShimEntrypoint(
  cmd: 'claude' | 'codex' | 'grok',
  cand: string
): Promise<string | null> {
  const dir = pathWin32.dirname(cand);

  const siblingExe = pathWin32.join(dir, `${cmd}.exe`);
  if (await pathExists(siblingExe)) return siblingExe;

  let launchers: string[] = isNodeEntrypoint(cand) ? [cand] : [];
  if (launchers.length === 0) {
    let content: string | null = null;
    try {
      content = await fs.readFile(cand, 'utf-8');
    } catch {
      content = null;
    }
    launchers = content ? parseCmdShimTargets(content, dir) : [];
    if (launchers.length === 0) {
      launchers =
        cmd === 'claude'
          ? [pathWin32.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')]
          : cmd === 'grok'
            ? [pathWin32.join(dir, 'node_modules', '@xai-official', 'grok', 'bin', 'grok')]
            : [pathWin32.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')];
    }
  }

  for (const launcher of launchers) {
    if (cmd === 'codex') {
      const exe = await resolveCodexNativeExe(launcher);
      if (exe) return exe;
    } else if ((cmd === 'claude' || cmd === 'grok') && (await pathExists(launcher))) {
      return launcher;
    }
  }
  return null;
}

const CLI_OVERRIDE_VAR: Record<'claude' | 'codex' | 'grok', string> = {
  claude: 'DNAFORGE_CLAUDE_CODE_PATH',
  codex: 'DNAFORGE_CODEX_PATH',
  grok: 'DNAFORGE_GROK_PATH',
};

async function resolveExplicitCliPath(
  cmd: string,
  rawValue: string,
  isWin: boolean,
  sourceLabel: string
): Promise<string | null> {
  if (cmd !== 'claude' && cmd !== 'codex' && cmd !== 'grok') return null;
  const raw = rawValue.trim();
  if (!raw) return null;
  const isAbsolute = isWin ? /^(?:[a-z]:[\\/]|\\\\)/i.test(raw) : raw.startsWith('/');
  if (!isAbsolute) {
    console.warn(`[detect] ${sourceLabel}="${raw}" is not an absolute path — ignoring`);
    return null;
  }
  const resolved = isWin
    ? await resolveWin32SpawnablePath(cmd, [raw])
    : (await executablePathExists(raw))
      ? raw
      : null;
  if (resolved) return resolved;
  console.warn(`[detect] ${sourceLabel}="${raw}" is set but not spawnable — ignoring`);
  return null;
}

async function resolveCliOverride(cmd: string, isWin: boolean): Promise<string | null> {
  if (cmd !== 'claude' && cmd !== 'codex' && cmd !== 'grok') return null;
  const varName = CLI_OVERRIDE_VAR[cmd];
  const raw = process.env[varName]?.trim();
  return raw ? resolveExplicitCliPath(cmd, raw, isWin, varName) : null;
}

type AgentCliDiscovery = {
  shellPath: 'complete' | 'unknown';
  pathLookup: 'complete' | 'unknown' | 'not-needed';
  knownLocations: 'complete' | 'unknown' | 'not-needed';
};

export type AgentCliPresence =
  | {
      kind: 'fixed';
      origin: 'settings-override' | 'environment-override';
      path: string | null;
      discovery: AgentCliDiscovery;
    }
  | {
      kind: 'searched';
      externalPaths: string[];
      fallbackPath: string | null;
      bundledPaths: string[];
      rejectedEnvironmentOverride: boolean;
      discovery: AgentCliDiscovery;
    };

function isKnownCliNoMatch(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 1 &&
    'stdout' in error &&
    typeof error.stdout === 'string' &&
    error.stdout.trim() === '' &&
    'stderr' in error &&
    typeof error.stderr === 'string' &&
    error.stderr.trim() === '' &&
    'killed' in error &&
    error.killed === false &&
    'signal' in error &&
    error.signal === null &&
    !('timedOut' in error && error.timedOut === true)
  );
}

export async function resolveAgentCliPresence(
  cmd: 'claude' | 'codex' | 'grok',
  binaryPathOverride?: string
): Promise<AgentCliPresence> {
  const repair = await ensureShellPathRepaired();
  const discovery: AgentCliDiscovery = {
    shellPath: repair.shellProbeOk ? 'complete' : 'unknown',
    pathLookup: 'not-needed',
    knownLocations: 'not-needed',
  };
  const isWin = platform() === 'win32';
  if (binaryPathOverride !== undefined) {
    return {
      kind: 'fixed',
      origin: 'settings-override',
      discovery,
      path: await resolveExplicitCliPath(
        cmd,
        binaryPathOverride,
        isWin,
        'Settings executable path'
      ),
    };
  }
  const overridden = await resolveCliOverride(cmd, isWin);
  if (overridden)
    return { kind: 'fixed', origin: 'environment-override', path: overridden, discovery };
  const tool = isWin ? 'where' : 'which';
  const args = isWin ? [cmd] : ['-a', cmd];
  let external: string[] = [];
  try {
    const { stdout, stderr } = await execFileAsync(tool, args, { timeout: 2000 });
    external = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !isRepoLocalNodeModulesBin(line));
    discovery.pathLookup = stdout.trim() && stderr.trim() === '' ? 'complete' : 'unknown';
  } catch (error) {
    discovery.pathLookup = isKnownCliNoMatch(error) ? 'complete' : 'unknown';
  }

  const fallback = await findInKnownCliDirsPresence(cmd);
  discovery.knownLocations = repair.knownDirsComplete && fallback.complete ? 'complete' : 'unknown';
  const bundled =
    cmd === 'codex' && platform() === 'darwin'
      ? (
          await Promise.all(
            CHATGPT_BUNDLED_CODEX_PATHS.map(async (path) =>
              (await executablePathExists(path)) ? path : null
            )
          )
        ).filter((path): path is string => path !== null)
      : [];
  return {
    kind: 'searched',
    externalPaths: external,
    fallbackPath: fallback.value,
    bundledPaths: bundled,
    rejectedEnvironmentOverride: Boolean(process.env[CLI_OVERRIDE_VAR[cmd]]?.trim()),
    discovery,
  };
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
