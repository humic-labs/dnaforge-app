import { execFileSync, spawn, spawnSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { runtimeOwnerLockPath } from './sidecar-control-plane-env';
import { reclaimAbandonedLockHolders } from './sidecar-owner-reclaim';

const HOLD = `
import fcntl, os, sys, time
pid = os.fork()
if pid > 0:
    print(pid, flush=True)
    os._exit(0)
os.setsid()
fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT, 0o600)
fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
time.sleep(60)
`;

const released: Array<() => void> = [];

describe('live profile-lock reclaim', () => {
  afterEach(() => {
    for (const release of released.splice(0)) release();
  });

  it('accepts a real existing lock file with no process holding it', async () => {
    if (process.platform === 'win32') return;
    const directory = mkdtempSync(join(tmpdir(), 'unheld-profile-lock-'));
    released.push(() => rmSync(directory, { recursive: true, force: true }));
    const lockPath = join(directory, 'existing.lock');
    writeFileSync(lockPath, '');
    expect(existsSync(lockPath)).toBe(true);
    await expect(reclaimWithDiagnostics(lockPath)).resolves.toEqual({
      kill: [],
      blockedByLiveParent: [],
    });
    expect(canLock(lockPath)).toBe(true);
  });

  it('admits a fresh profile without scanning OS holders for a nonexistent lock', async () => {
    if (process.platform === 'win32') return;
    const directory = mkdtempSync(join(tmpdir(), 'profile-lock-fresh-'));
    released.push(() => rmSync(directory, { recursive: true, force: true }));
    const decision = await reclaimAbandonedLockHolders({
      lockPath: join(directory, 'new-profile.lock'),
      appPid: process.pid,
      currentChildPid: null,
    });
    expect(decision).toEqual({ kill: [], blockedByLiveParent: [] });
  });

  it('stops a process that holds the lock under an unrelated command', async () => {
    if (process.platform === 'win32') return;
    const directory = mkdtempSync(join(tmpdir(), 'profile-lock-'));
    released.push(() => rmSync(directory, { recursive: true, force: true }));
    const lockPath = runtimeOwnerLockPath(
      join(directory, 'sidecar-control-plane.sqlite3'),
      'packaged-profile-probe'
    );
    const holderPid = await orphanHolding(lockPath);
    released.push(() => {
      try {
        process.kill(holderPid, 'SIGKILL');
      } catch {}
    });

    await expect.poll(() => existsSync(lockPath) && !canLock(lockPath)).toBe(true);

    await expect(
      reclaimAbandonedLockHolders({
        lockPath,
        appPid: process.pid,
        currentChildPid: null,
        listLockHolders: () => {
          throw Object.assign(new Error('scan timed out'), { code: 'ETIMEDOUT' });
        },
      })
    ).resolves.toEqual({ kill: [], blockedByLiveParent: [] });
    expect(pidAlive(holderPid)).toBe(true);
    expect(canLock(lockPath)).toBe(false);

    const decision = await reclaimWithDiagnostics(lockPath);

    expect(decision.kill).toContain(holderPid);
    expect(pidAlive(holderPid)).toBe(false);
    expect(canLock(lockPath)).toBe(true);
  });
});

async function reclaimWithDiagnostics(lockPath: string) {
  try {
    return await reclaimAbandonedLockHolders({
      lockPath,
      appPid: process.pid,
      currentChildPid: null,
    });
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      killed?: boolean;
      signal?: string;
      stdout?: string;
      stderr?: string;
    };
    const details = {
      code: failure.code,
      killed: failure.killed,
      signal: failure.signal,
      stdout: failure.stdout,
      stderr: failure.stderr,
    };
    if (error instanceof Error) error.message += `\nInspection details: ${JSON.stringify(details)}`;
    throw error;
  }
}

function orphanHolding(lockPath: string): Promise<number> {
  const child = spawn('python3', ['-c', HOLD, lockPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`holder did not start\n${output}`)), 5_000);
    child.stdout?.addListener('data', (chunk: Buffer) => {
      output += chunk.toString();
      const pid = Number(output.trim().split('\n')[0]);
      if (!Number.isInteger(pid) || pid <= 0) return;
      clearTimeout(timer);
      resolve(waitForParent(pid, 1));
    });
    child.addListener('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.addListener('exit', (code) => {
      if (output.trim() === '') {
        clearTimeout(timer);
        reject(new Error(`holder launcher exited ${code}`));
      }
    });
  });
}

async function waitForParent(pid: number, ppid: number): Promise<number> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (parentOf(pid) === ppid) return pid;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`holder ${pid} parent is ${parentOf(pid)}, expected ${ppid}`);
}

function parentOf(pid: number): number | null {
  try {
    const output = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' });
    const parent = Number(output.trim());
    return Number.isInteger(parent) ? parent : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function canLock(lockPath: string): boolean {
  const probe = spawnSync(
    'python3',
    [
      '-c',
      'import fcntl, os, sys; fd = os.open(sys.argv[1], os.O_RDWR); fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB); fcntl.flock(fd, fcntl.LOCK_UN)',
      lockPath,
    ],
    { encoding: 'utf8' }
  );
  return probe.status === 0;
}
