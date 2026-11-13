import { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFileSync: mocks.exec,
}));

describe('process-tree ownership across overlapping and completed stops', () => {
  let alive = true;
  let identity = 'original start time';
  let signals: Array<{ pid: number; signal: string | number; identity: string }>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
    alive = true;
    identity = 'original start time';
    signals = [];
    mocks.exec.mockImplementation((command: string) => {
      if (command === 'pgrep') return '';
      if (command === 'ps') return alive ? `100 ${identity}\n` : '';
      throw new Error(`Unexpected process operation: ${command}`);
    });
    vi.spyOn(process, 'kill').mockImplementation((pid, signal = 'SIGTERM') => {
      if (signal === 0) {
        if (!alive) throw Object.assign(new Error('No process'), { code: 'ESRCH' });
        return true;
      }
      signals.push({ pid, signal, identity });
      if (signal === 'SIGKILL') alive = false;
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('never blesses a recycled root when a stale queue calls stop after completion', async () => {
    const { stopChildProcessTree } = await import('./sidecar-process-tree');
    const root: { pid: number; exitCode: number | null } = { pid: 100, exitCode: null };
    const child = Object.assign(new ChildProcess(), root);
    const options = { gracefulTimeoutMs: 0, forceTimeoutMs: 0 };
    const first = stopChildProcessTree(child, options);
    const overlapping = stopChildProcessTree(child, options);
    expect(overlapping).toBe(first);
    await Promise.all([first, overlapping]);
    expect(signals).toHaveLength(2);

    child.exitCode = 0;
    alive = true;
    identity = 'recycled unrelated process start time';
    await stopChildProcessTree(child, options);

    expect(signals).toHaveLength(2);
    expect(signals.every((event) => event.identity === 'original start time')).toBe(true);
    expect(alive).toBe(true);
  });

  it('refuses to discover a new tree from an already-exited child without an ownership snapshot', async () => {
    const { stopChildProcessTree } = await import('./sidecar-process-tree');
    const child = Object.assign(new ChildProcess(), { pid: 100, exitCode: 0 });
    await expect(stopChildProcessTree(child)).rejects.toThrow('ownership after parent exit');
    expect(mocks.exec).not.toHaveBeenCalled();
    expect(signals).toEqual([]);
  });

  it('never invokes Windows taskkill against an exited child with a reusable PID', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    const { stopChildProcessTree } = await import('./sidecar-process-tree');
    const child = Object.assign(new ChildProcess(), { pid: 100, exitCode: 0 });
    await expect(stopChildProcessTree(child)).rejects.toThrow('shutdown after parent exit');
    expect(mocks.exec).not.toHaveBeenCalled();
    expect(signals).toEqual([]);
  });

  it('shares one Windows tree termination when shutdown overlaps a worker restart', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    mocks.exec.mockImplementation((command: string) => {
      if (command !== 'taskkill.exe') throw new Error(`Unexpected process operation: ${command}`);
      alive = false;
    });
    const { stopChildProcessTree } = await import('./sidecar-process-tree');
    const child = Object.assign(new ChildProcess(), { pid: 100 });

    const first = stopChildProcessTree(child, { forceTimeoutMs: 0 });
    const overlapping = stopChildProcessTree(child, { forceTimeoutMs: 0 });
    expect(overlapping).toBe(first);
    await Promise.all([first, overlapping]);

    expect(mocks.exec).toHaveBeenCalledExactlyOnceWith(
      'taskkill.exe',
      ['/pid', '100', '/T', '/F'],
      { stdio: 'ignore' }
    );
    expect(alive).toBe(false);
  });

  it('retries a refused Windows stop while the original parent is still alive', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    const child = Object.assign(new ChildProcess(), { pid: 100 });
    const fallbackKill = vi.spyOn(child, 'kill').mockReturnValue(false);
    mocks.exec
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('injected Windows termination refusal'), { code: 'EPERM' });
      })
      .mockImplementationOnce(() => {
        alive = false;
      });
    const { stopChildProcessTree } = await import('./sidecar-process-tree');

    await expect(stopChildProcessTree(child, { forceTimeoutMs: 0 })).rejects.toThrow(
      'surviving PIDs: 100'
    );
    expect(alive).toBe(true);
    expect(fallbackKill).toHaveBeenCalledOnce();

    await stopChildProcessTree(child, { forceTimeoutMs: 0 });

    expect(mocks.exec).toHaveBeenCalledTimes(2);
    expect(mocks.exec.mock.calls.every(([, args]) => args[1] === '100')).toBe(true);
    expect(alive).toBe(false);
  });
});
