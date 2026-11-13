import { execFileSync, type ChildProcess } from 'node:child_process';

export interface StopProcessTreeOptions {
  readonly gracefulTimeoutMs?: number;
  readonly forceTimeoutMs?: number;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function childPids(pid: number): number[] {
  if (process.platform === 'win32') return [];
  try {
    return execFileSync('pgrep', ['-P', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\s+/)
      .filter(Boolean)
      .map((value) => Number(value))
      .filter(Number.isInteger);
  } catch {
    return [];
  }
}

function processTreePids(pid: number): number[] {
  const children = childPids(pid);
  return [...children.flatMap(processTreePids), pid];
}

const ownedTrees = new WeakMap<ChildProcess, Map<number, string>>();
const activeStops = new WeakMap<ChildProcess, Promise<void>>();

function processIdentities(pids: readonly number[]): Map<number, string> {
  if (pids.length === 0) return new Map();
  try {
    const output = execFileSync('ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const identities = new Map<number, string>();
    for (const line of output.split('\n')) {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (match) identities.set(Number(match[1]), match[2]);
    }
    return identities;
  } catch {
    if (pids.some(isPidAlive)) throw new Error('[Sidecar] Cannot verify process-tree ownership');
    return new Map();
  }
}

function sidecarProcessTree(child: ChildProcess): number[] {
  const original = ownedTrees.get(child);
  if (original) {
    const current = processIdentities([...original.keys()]);
    return [...original.keys()].filter((pid) => current.get(pid) === original.get(pid));
  }
  if (child.pid && (child.exitCode !== null || child.signalCode !== null)) {
    throw new Error('[Sidecar] Cannot establish process-tree ownership after parent exit');
  }
  const pids = child.pid ? processTreePids(child.pid) : [];
  const current = processIdentities(pids);
  const identities = new Map<number, string>();
  for (const pid of pids) {
    const identity = current.get(pid);
    if (identity) identities.set(pid, identity);
  }
  ownedTrees.set(child, identities);
  return [...identities.keys()];
}

function signalPids(pids: readonly number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

async function waitForPidsToExit(pids: readonly number[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !isPidAlive(pid))) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return pids.every((pid) => !isPidAlive(pid));
}

export function stopChildProcessTree(
  child: ChildProcess,
  options: StopProcessTreeOptions = {}
): Promise<void> {
  const active = activeStops.get(child);
  if (active) return active;
  const stopping = Promise.resolve()
    .then(() => stopProcessTree(child, options))
    .finally(() => activeStops.delete(child));
  activeStops.set(child, stopping);
  return stopping;
}

async function stopProcessTree(
  child: ChildProcess,
  options: StopProcessTreeOptions
): Promise<void> {
  if (process.platform === 'win32') {
    if (!child.pid) {
      child.kill();
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('[Sidecar] Cannot prove Windows process-tree shutdown after parent exit');
    }
    try {
      execFileSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
      });
    } catch {
      child.kill();
    }
    const forceTimeoutMs = options.forceTimeoutMs ?? 15_000;
    if (await waitForPidsToExit([child.pid], forceTimeoutMs)) return;

    const survivors = [child.pid].filter(isPidAlive);
    throw new Error(
      `[Sidecar] Failed to terminate Windows process tree; surviving PIDs: ${survivors.join(', ')}`
    );
  }

  const pids = sidecarProcessTree(child);
  if (pids.length === 0) {
    if (!child.pid) child.kill('SIGTERM');
    return;
  }

  signalPids(pids, 'SIGTERM');
  const gracefulTimeoutMs = options.gracefulTimeoutMs ?? 3000;
  if (await waitForPidsToExit(pids, gracefulTimeoutMs)) {
    return;
  }

  const stillLive = sidecarProcessTree(child).filter(isPidAlive);
  signalPids(stillLive, 'SIGKILL');
  const forceTimeoutMs = options.forceTimeoutMs ?? 3000;
  if (await waitForPidsToExit(stillLive, forceTimeoutMs)) {
    return;
  }

  const survivors = sidecarProcessTree(child).filter(isPidAlive);
  if (survivors.length === 0) {
    return;
  }
  throw new Error(
    `[Sidecar] Failed to terminate process tree; surviving PIDs: ${survivors.join(', ')}`
  );
}
