import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), append: vi.fn(), log: vi.fn(), read: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:fs', () => ({
  appendFileSync: mocks.append,
  closeSync: vi.fn(),
  existsSync: () => true,
  mkdirSync: vi.fn(),
  openSync: () => 3,
  readFileSync: mocks.read,
}));
vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => '/owned/profile' },
}));
vi.mock('./boot-log', () => ({ appendBootLog: mocks.log }));

describe('update status inherits the application background policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.read.mockReset();
    mocks.read.mockReturnValue(JSON.stringify({ kind: 'shown', visible: true, pid: 123 }));
    const child = Object.assign(new EventEmitter(), {
      pid: 123,
      exitCode: null,
      signalCode: null,
      unref: vi.fn(),
      kill: vi.fn(),
    });
    mocks.spawn.mockReturnValue(child);
  });

  it.each([true, false])(
    'checks native acknowledgement after delayed polling (shown=%s)',
    async (shown) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      vi.stubGlobal('process', {
        ...process,
        platform: 'darwin',
        execPath: '/owned/DNAForge.app/Contents/MacOS/DNAForge',
        env: { DNAFORGE_BACKGROUND_WINDOW: '1' },
      });
      mocks.read.mockReturnValue(JSON.stringify({ kind: 'requested', at: 0 }));
      try {
        const { showMacUpdateStatus } = await import('./update-status');
        const result = showMacUpdateStatus('2.1.0').then(
          (stop) => ({ stop, error: undefined }),
          (error: Error) => ({ stop: undefined, error })
        );
        expect(mocks.read).toHaveBeenCalledTimes(1);
        if (shown) {
          mocks.read.mockReturnValue(
            JSON.stringify({ kind: 'shown', visible: true, pid: 123, at: 100 })
          );
        }
        vi.setSystemTime(6000);
        await vi.advanceTimersByTimeAsync(50);
        const outcome = await result;
        if (shown) {
          expect(outcome.error).toBeUndefined();
          expect(outcome.stop).toBeTypeOf('function');
          outcome.stop?.();
        } else {
          expect(outcome.error?.message).toBe('The update status window did not open.');
        }
      } finally {
        vi.unstubAllGlobals();
        vi.useRealTimers();
      }
    }
  );

  it.each([
    [{ DNAFORGE_BACKGROUND_WINDOW: '1', DNAFORGE_FOREGROUND_WINDOW: '1' }, 'background'],
    [{ CODEX_HOME: '/agent' }, 'background'],
    [{ CLAUDECODE: '1' }, 'background'],
    [{ NODE_ENV: 'test' }, 'background'],
    [{ CODEX_HOME: '/agent', DNAFORGE_FOREGROUND_WINDOW: '1' }, 'normal'],
    [{ NODE_ENV: 'production' }, 'normal'],
  ])('uses the existing policy for %j', async (env, expected) => {
    vi.stubGlobal('process', {
      ...process,
      platform: 'darwin',
      execPath: '/owned/DNAForge.app/Contents/MacOS/DNAForge',
      env,
    });
    try {
      const { showMacUpdateStatus } = await import('./update-status');
      const stop = await showMacUpdateStatus('2.1.0');
      expect(mocks.spawn.mock.calls[0][1].at(-1)).toBe(expected);
      stop();
      stop();
      expect(mocks.spawn.mock.results[0].value.kill).toHaveBeenCalledWith('SIGTERM');
      expect(mocks.spawn.mock.results[0].value.kill).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
