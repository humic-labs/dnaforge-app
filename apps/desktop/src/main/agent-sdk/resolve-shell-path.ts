import { spawn } from 'node:child_process';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { homedir, platform } from 'node:os';
import { basename, delimiter, join } from 'node:path';

export interface ShellPathInfo {
  repairedPath: string;

  knownDirs: string[];
  knownDirsComplete: boolean;

  shellProbeOk: boolean;

  skipped: boolean;
}

const SHELL_PROBE_TIMEOUT_MS = 5000;
const PATH_SENTINEL_OPEN = '__WP_PATH_START__';
const PATH_SENTINEL_CLOSE = '__WP_PATH_END__';

const NON_POSIX_SHELLS = new Set(['fish', 'nu', 'nushell', 'elvish', 'xonsh']);

export function knownCliDirCandidates(home: string = homedir()): string[] {
  const dirs = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    join(home, '.local', 'bin'),
    join(home, '.codex', 'bin'),
    join(home, 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.npm-packages', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.deno', 'bin'),
    join(home, '.volta', 'bin'),
    platform() === 'darwin' ? join(home, 'Library', 'pnpm') : join(home, '.local', 'share', 'pnpm'),
  ];
  return dirs;
}

export interface CliLocationPresence<T> {
  value: T;
  complete: boolean;
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

async function pathPresence(p: string): Promise<CliLocationPresence<boolean>> {
  try {
    await fs.access(p);
    return { value: true, complete: true };
  } catch (error) {
    return { value: false, complete: isMissingPath(error) };
  }
}

async function executableFilePresence(p: string): Promise<CliLocationPresence<boolean>> {
  try {
    const st = await fs.stat(p);
    if (!st.isFile()) return { value: false, complete: true };
    await fs.access(p, fsConstants.X_OK);
    return { value: true, complete: true };
  } catch (error) {
    return { value: false, complete: isMissingPath(error) };
  }
}

async function nvmBinDirs(home: string): Promise<CliLocationPresence<string[]>> {
  const versionsRoot = join(home, '.nvm', 'versions', 'node');
  try {
    const entries = await fs.readdir(versionsRoot, { withFileTypes: true });
    return {
      value: entries.filter((e) => e.isDirectory()).map((e) => join(versionsRoot, e.name, 'bin')),
      complete: true,
    };
  } catch (error) {
    return { value: [], complete: isMissingPath(error) };
  }
}

export async function resolveExistingKnownCliDirs(home: string = homedir()): Promise<string[]> {
  return (await resolveKnownCliDirPresence(home)).value;
}

export async function resolveKnownCliDirPresence(
  home: string = homedir()
): Promise<CliLocationPresence<string[]>> {
  const nvm = await nvmBinDirs(home);
  const candidates = [...knownCliDirCandidates(home), ...nvm.value];
  const checked = await Promise.all(
    candidates.map(async (dir) => ({ dir, presence: await pathPresence(dir) }))
  );
  return {
    value: checked.filter(({ presence }) => presence.value).map(({ dir }) => dir),
    complete: nvm.complete && checked.every(({ presence }) => presence.complete),
  };
}

export async function probeLoginShellPath(
  shell: string = process.env.SHELL || '/bin/bash',
  timeoutMs: number = SHELL_PROBE_TIMEOUT_MS
): Promise<string | null> {
  if (platform() === 'win32') return null;
  if (NON_POSIX_SHELLS.has(basename(shell))) return null;

  const script = `printf '%s%s%s' '${PATH_SENTINEL_OPEN}' "$PATH" '${PATH_SENTINEL_CLOSE}'`;

  return await new Promise<string | null>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, ['-lc', script], {
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: true,
      });
    } catch {
      resolve(null);
      return;
    }

    let stdout = '';
    let settled = false;
    const settle = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdout?.destroy();
      } catch {}
      try {
        child.unref();
      } catch {}
      try {
        child.kill('SIGKILL');
      } catch {}
      resolve(value);
    };

    const timer = setTimeout(() => settle(parseSentinelPath(stdout)), timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      const parsed = parseSentinelPath(stdout);
      if (parsed !== null) settle(parsed);
    });
    child.on('error', () => settle(null));
    child.on('close', () => settle(parseSentinelPath(stdout)));
  });
}

export function parseSentinelPath(raw: string): string | null {
  const start = raw.indexOf(PATH_SENTINEL_OPEN);
  const end = raw.lastIndexOf(PATH_SENTINEL_CLOSE);
  if (start === -1 || end === -1 || end < start + PATH_SENTINEL_OPEN.length) return null;
  const value = raw.slice(start + PATH_SENTINEL_OPEN.length, end).trim();
  if (!value || !value.includes('/')) return null;
  return value;
}

export function unionPathSegments(...sources: Array<string | null | undefined>): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const source of sources) {
    if (!source) continue;
    for (const seg of source.split(delimiter)) {
      const trimmed = seg.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out.join(delimiter);
}

let repairPromise: Promise<ShellPathInfo> | null = null;

async function computeRepair(): Promise<ShellPathInfo> {
  const inherited = process.env.PATH ?? '';

  if (platform() === 'win32') {
    return {
      repairedPath: inherited,
      knownDirs: [],
      knownDirsComplete: true,
      shellProbeOk: false,
      skipped: true,
    };
  }

  const [shellPath, knownPresence] = await Promise.all([
    probeLoginShellPath(),
    resolveKnownCliDirPresence(),
  ]);
  const knownDirs = knownPresence.value;

  const repairedPath = unionPathSegments(inherited, shellPath, knownDirs.join(delimiter));
  process.env.PATH = repairedPath;

  return {
    repairedPath,
    knownDirs,
    knownDirsComplete: knownPresence.complete,
    shellProbeOk: shellPath !== null,
    skipped: false,
  };
}

export function ensureShellPathRepaired(): Promise<ShellPathInfo> {
  if (!repairPromise) {
    repairPromise = computeRepair();
  }
  return repairPromise;
}

export async function findInKnownCliDirs(
  cmd: string,
  home: string = homedir()
): Promise<string | null> {
  return (await findInKnownCliDirsPresence(cmd, home)).value;
}

export async function findInKnownCliDirsPresence(
  cmd: string,
  home: string = homedir()
): Promise<CliLocationPresence<string | null>> {
  if (platform() === 'win32') return { value: null, complete: true };
  const dirs = await resolveKnownCliDirPresence(home);
  let complete = dirs.complete;
  for (const dir of dirs.value) {
    const candidate = join(dir, cmd);
    const presence = await executableFilePresence(candidate);
    complete &&= presence.complete;
    if (presence.value) return { value: candidate, complete };
  }
  return { value: null, complete };
}

export async function getSearchedCliDirs(): Promise<string[]> {
  const info = await ensureShellPathRepaired();
  const home = homedir();
  return info.repairedPath
    .split(delimiter)
    .map((d) => d.trim())
    .filter((d) => d.length > 0)
    .map((d) =>
      home && (d === home || d.startsWith(home + '/')) ? '~' + d.slice(home.length) : d
    );
}

export function __resetShellPathRepairForTests(): void {
  repairPromise = null;
}
