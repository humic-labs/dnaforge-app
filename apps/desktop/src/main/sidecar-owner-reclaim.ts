import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

export interface ProcessSnapshot {
  readonly pid: number;
  readonly ppid: number;
  readonly executable: string;
}

export interface AbandonedLockDecision {
  readonly kill: readonly number[];
  readonly blockedByLiveParent: readonly number[];
}

export function parsePsProcessList(output: string): ProcessSnapshot[] {
  const processes: ProcessSnapshot[] = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S.*)$/.exec(line);
    if (!match) continue;
    processes.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      executable: match[3].trim(),
    });
  }
  return processes;
}

export function decideAbandonedLockHolders(input: {
  readonly lockHolderPids: readonly number[];
  readonly appPid: number;
  readonly currentChildPid: number | null;
  readonly processes: readonly ProcessSnapshot[];
}): AbandonedLockDecision {
  const byPid = new Map(input.processes.map((process) => [process.pid, process]));
  const kill: number[] = [];
  const blockedByLiveParent: number[] = [];
  for (const pid of input.lockHolderPids) {
    if (pid === input.appPid || pid === input.currentChildPid) continue;
    if (!byPid.has(pid)) continue;
    if (holderIsAbandoned(pid, input.appPid, byPid)) kill.push(pid);
    else blockedByLiveParent.push(pid);
  }
  return { kill, blockedByLiveParent };
}

export async function reclaimAbandonedLockHolders(input: {
  readonly lockPath: string;
  readonly appPid: number;
  readonly currentChildPid: number | null;
  readonly pathExists?: (lockPath: string) => boolean;
  readonly listProcesses?: () => readonly ProcessSnapshot[] | Promise<readonly ProcessSnapshot[]>;
  readonly listLockHolders?: (lockPath: string) => readonly number[] | Promise<readonly number[]>;
  readonly signal?: (pid: number, signal: NodeJS.Signals) => void;
  readonly pause?: (ms: number) => Promise<void>;
}): Promise<AbandonedLockDecision> {
  if (!(input.pathExists ?? existsSync)(input.lockPath)) {
    console.log('[Sidecar] Profile lock is absent; reclaim is not needed:', input.lockPath);
    return { kill: [], blockedByLiveParent: [] };
  }
  const listProcesses = input.listProcesses ?? listOsProcesses;
  const listLockHolders = input.listLockHolders ?? listOsLockHolders;
  const signal = input.signal ?? signalPid;
  const pause = input.pause ?? delay;
  let decision: AbandonedLockDecision;
  try {
    const lockHolderPids = await listLockHolders(input.lockPath);
    if (lockHolderPids.length === 0) return { kill: [], blockedByLiveParent: [] };
    decision = decideAbandonedLockHolders({
      lockHolderPids,
      appPid: input.appPid,
      currentChildPid: input.currentChildPid,
      processes: await listProcesses(),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 240) : 'OS inspection failed';
    console.warn(
      `[Sidecar] Skipping owner reclamation: ${detail}. RuntimeScopeLease still enforces exclusive ownership.`
    );
    return { kill: [], blockedByLiveParent: [] };
  }
  if (decision.kill.length === 0) return decision;

  for (const pid of decision.kill) signal(pid, 'SIGTERM');
  let survivors = await waitForExit(decision.kill, listProcesses, pause, 3_000);
  for (const pid of survivors) signal(pid, 'SIGKILL');
  if (survivors.length > 0) {
    survivors = await waitForExit(survivors, listProcesses, pause, 3_000);
  }
  if (survivors.length > 0) {
    throw new Error(`[Sidecar] Abandoned analysis engine did not exit: ${survivors.join(', ')}`);
  }
  return decision;
}

function holderIsAbandoned(
  holderPid: number,
  appPid: number,
  byPid: ReadonlyMap<number, ProcessSnapshot>
): boolean {
  let pid = holderPid;
  for (let depth = 0; depth < 20; depth += 1) {
    const process = byPid.get(pid);
    if (!process) return true;
    if (process.ppid === appPid) return false;
    if (process.ppid <= 1 || !byPid.has(process.ppid)) return true;
    const parent = byPid.get(process.ppid);
    if (parent && isDesktopApp(parent)) return false;
    pid = process.ppid;
  }
  return true;
}

function isDesktopApp(process: ProcessSnapshot): boolean {
  const token = process.executable.trim().split(/\s+/)[0] ?? '';
  const name = token.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  return (
    name === 'electron' || name === 'electron.exe' || name === 'dnaforge' || name === 'dnaforge.exe'
  );
}

async function listOsLockHolders(lockPath: string): Promise<number[]> {
  if (process.platform === 'win32') return [];
  try {
    const args = [
      '-nP',
      '-l',
      ...(process.platform === 'darwin' ? ['-X', '-O'] : []),
      '-t',
      lockPath,
    ];
    const { stdout: output } = await promisify(execFile)('lsof', args, {
      encoding: 'utf8',
      timeout: 5_000,
    });
    return output
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch (error) {
    const status =
      typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined;
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (status === 1 || code === 1 || code === 'ENOENT') return [];
    throw error;
  }
}

async function listOsProcesses(): Promise<ProcessSnapshot[]> {
  if (process.platform === 'win32') return [];
  const { stdout: output } = await promisify(execFile)('ps', ['-axo', 'pid=,ppid=,command='], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  return parsePsProcessList(output);
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {}
}

async function waitForExit(
  pids: readonly number[],
  listProcesses: () => readonly ProcessSnapshot[] | Promise<readonly ProcessSnapshot[]>,
  pause: (ms: number) => Promise<void>,
  timeoutMs: number
): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let remaining = [...pids];
  while (remaining.length > 0) {
    const alive = new Set((await listProcesses()).map((process) => process.pid));
    remaining = remaining.filter((pid) => alive.has(pid));
    if (remaining.length === 0 || Date.now() >= deadline) return remaining;
    await pause(100);
  }
  return remaining;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
