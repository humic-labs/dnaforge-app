import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

const guardFile = resolve(__dirname, '../../../scripts/dev-single-instance-guard.cjs');
const repository = resolve(dirname(guardFile), '../../..');
const nativeRequire = createRequire(guardFile);
const electronPid = 123450;
const rendererPid = 123456;

type Mode =
  | 'renderer-exits-later'
  | 'renderer-stays-unknown'
  | 'renderer-becomes-foreign'
  | 'term-esrch'
  | 'kill-esrch'
  | 'term-eperm'
  | 'kill-eperm';

function lifecycleFixture(mode: Mode) {
  const rendererSelected = mode.startsWith('renderer-');
  const live = new Set(rendererSelected ? [electronPid, rendererPid] : [electronPid]);
  let electronStopped = false;
  let rendererExitObserved = false;
  const signals: Array<{ pid: number; signal: string | number }> = [];
  const ownership: Array<{ pid: number; cwd: string }> = [];
  const bindings = { exports: {} as { stopWorktreeStack: (state: unknown) => Promise<boolean> } };
  const failure = (code: string) =>
    Object.assign(new Error(`Process signal failed: ${code}`), { code });
  const execution = (command: string, args: string[]) => {
    if (command !== 'lsof') throw new Error(`Unexpected command ${command}`);
    if (args.includes('cwd')) {
      const pid = Number(args[args.indexOf('-p') + 1]);
      const cwd =
        pid === rendererPid && electronStopped
          ? mode === 'renderer-becomes-foreign'
            ? '/another-worktree'
            : ''
          : repository;
      ownership.push({ pid, cwd });
      return cwd ? `p${pid}\nn${cwd}\n` : '';
    }
    if (args.includes('-iTCP:32000') && live.has(electronPid)) return `p${electronPid}\n`;
    if (args.includes('-iTCP:31000') && live.has(rendererPid)) return `p${rendererPid}\n`;
    return '';
  };
  const isolatedRequire = (id: string) => {
    if (id === 'node:child_process')
      return {
        execFileSync: execution,
        spawn: () => {
          throw new Error('No process may start in this fixture');
        },
      };
    if (id === 'node:fs') return { existsSync: () => false };
    if (id === 'node:net')
      return {
        createConnection: () => {
          const socket = Object.assign(new EventEmitter(), { destroy() {}, setTimeout() {} });
          queueMicrotask(() => socket.emit('error', new Error('Port is closed')));
          return socket;
        },
      };
    if (id === 'node:http' || id === 'node:https' || id.startsWith('./')) return {};
    if (id === 'node:path' || id === 'node:url') return nativeRequire(id);
    throw new Error(`Unexpected dependency ${id}`);
  };
  runInNewContext(
    readFileSync(guardFile, 'utf8'),
    {
      __dirname: dirname(guardFile),
      module: bindings,
      require: isolatedRequire,
      console: { log() {}, error() {} },
      URL,
      Date,
      setTimeout,
      clearTimeout,
      process: {
        env: {},
        platform: 'darwin',
        kill(pid: number, signal: string | number) {
          if (![electronPid, rendererPid].includes(pid)) throw new Error(`Unexpected PID ${pid}`);
          if (signal === 0) {
            if (!live.has(pid)) {
              if (pid === rendererPid) rendererExitObserved = true;
              throw failure('ESRCH');
            }
            return true;
          }
          signals.push({ pid, signal });
          if (pid === electronPid) {
            if (signal === 'SIGTERM' && mode.startsWith('kill-')) return true;
            if (
              (signal === 'SIGTERM' && mode === 'term-eperm') ||
              (signal === 'SIGKILL' && mode === 'kill-eperm')
            )
              throw failure('EPERM');
            live.delete(pid);
            electronStopped = true;
            if (mode === 'renderer-exits-later') setTimeout(() => live.delete(rendererPid), 25);
            if (
              (signal === 'SIGTERM' && mode === 'term-esrch') ||
              (signal === 'SIGKILL' && mode === 'kill-esrch')
            )
              throw failure('ESRCH');
            return true;
          }
          live.delete(pid);
          return true;
        },
      },
    },
    { filename: guardFile }
  );
  return {
    stop: () =>
      bindings.exports.stopWorktreeStack({
        kind: 'running',
        rendererPort: 31000,
        debugPort: 32000,
        debugPids: [electronPid],
        rendererPids: rendererSelected ? [rendererPid] : [],
      }),
    signals,
    ownership,
    rendererExitObserved: () => rendererExitObserved,
  };
}

async function settle(fixture: ReturnType<typeof lifecycleFixture>) {
  const result = fixture.stop().then(
    (value) => ({ value, error: undefined }),
    (error: Error) => ({ value: undefined, error })
  );
  await vi.runAllTimersAsync();
  return result;
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('dev stack shutdown lifecycle boundaries', () => {
  it('awaits confirmed renderer exit when ownership disappears after Electron stops', async () => {
    vi.useFakeTimers();
    const fixture = lifecycleFixture('renderer-exits-later');
    const result = await settle(fixture);
    expect(result.error).toBeUndefined();
    expect(result.value).toBe(true);
    expect(fixture.ownership).toContainEqual({ pid: rendererPid, cwd: repository });
    expect(fixture.ownership).toContainEqual({ pid: rendererPid, cwd: '' });
    expect(fixture.rendererExitObserved()).toBe(true);
    expect(fixture.signals).toEqual([{ pid: electronPid, signal: 'SIGTERM' }]);
  });

  for (const mode of ['renderer-stays-unknown', 'renderer-becomes-foreign'] as const) {
    it(`refuses ${mode} after stopping Electron without signaling that renderer`, async () => {
      vi.useFakeTimers();
      const fixture = lifecycleFixture(mode);
      const result = await settle(fixture);
      expect(result.error?.message).toMatch(/ownership.*unverified/iu);
      expect(result.value).toBeUndefined();
      expect(fixture.signals).toEqual([{ pid: electronPid, signal: 'SIGTERM' }]);
    });
  }

  for (const mode of ['term-esrch', 'kill-esrch'] as const) {
    it(`accepts an observed exit racing with ${mode}`, async () => {
      vi.useFakeTimers();
      const fixture = lifecycleFixture(mode);
      const result = await settle(fixture);
      expect(result.error).toBeUndefined();
      expect(result.value).toBe(true);
      expect(fixture.signals).toEqual(
        mode === 'term-esrch'
          ? [{ pid: electronPid, signal: 'SIGTERM' }]
          : [
              { pid: electronPid, signal: 'SIGTERM' },
              { pid: electronPid, signal: 'SIGKILL' },
            ]
      );
    });
  }

  for (const mode of ['term-eperm', 'kill-eperm'] as const) {
    it(`preserves ${mode} instead of interpreting permission failure as exit`, async () => {
      vi.useFakeTimers();
      const fixture = lifecycleFixture(mode);
      const result = await settle(fixture);
      expect(result.error?.message).toContain('EPERM');
      expect(result.value).toBeUndefined();
    });
  }
});
