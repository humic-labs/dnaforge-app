import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

const guardFile = resolve(__dirname, '../../../scripts/dev-single-instance-guard.cjs');
const repository = resolve(dirname(guardFile), '../../..');
const nativeRequire = createRequire(guardFile);

function stopFixture(ownership: 'exited' | 'unknown' | 'foreign' | 'owned') {
  const pid = 123456;
  let alive = true;
  let livenessProbes = 0;
  let ownershipProbes = 0;
  const signals: Array<{ pid: number; signal: string | number }> = [];
  const bindings = { exports: {} as { stopWorktreeStack: (state: unknown) => Promise<boolean> } };
  const execution = (command: string, args: string[]) => {
    if (command !== 'lsof') throw new Error(`Unexpected command ${command}`);
    if (args.includes('cwd')) {
      ownershipProbes++;
      if (ownership === 'exited') alive = false;
      if (ownership === 'owned') return `p${pid}\nn${repository}\n`;
      if (ownership === 'foreign') return `p${pid}\nn/some-other-worktree\n`;
      return '';
    }
    return alive && args.includes('-iTCP:32000') ? `p${pid}\n` : '';
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
      setTimeout,
      clearTimeout,
      process: {
        env: {},
        platform: 'darwin',
        kill(target: number, signal: string | number) {
          if (target !== pid) throw new Error(`Unexpected PID ${target}`);
          if (signal === 0) {
            livenessProbes++;
            if (!alive) throw Object.assign(new Error('Process has exited'), { code: 'ESRCH' });
            return true;
          }
          signals.push({ pid: target, signal });
          alive = false;
          return true;
        },
      },
    },
    { filename: guardFile }
  );
  const state = {
    kind: 'running',
    rendererPort: 31000,
    debugPort: 32000,
    debugPids: [pid],
    rendererPids: [],
  };
  return {
    stop: () => bindings.exports.stopWorktreeStack(state),
    signals,
    probes: () => ({ liveness: livenessProbes, ownership: ownershipProbes }),
  };
}

describe('owned dev stack process disappearance', () => {
  it('finishes cleanup when a previously live process exits during its ownership probe', async () => {
    const fixture = stopFixture('exited');
    await expect(fixture.stop()).resolves.toBe(true);
    expect(fixture.signals).toEqual([]);
    expect(fixture.probes().ownership).toBe(1);
    expect(fixture.probes().liveness).toBeGreaterThan(1);
  });

  for (const ownership of ['unknown', 'foreign'] as const) {
    it(`refuses a still-live process with ${ownership} ownership`, async () => {
      const fixture = stopFixture(ownership);
      await expect(fixture.stop()).rejects.toThrow(/ownership.*unverified/iu);
      expect(fixture.signals).toEqual([]);
    });
  }

  it('terminates only the process whose worktree ownership is verified', async () => {
    const fixture = stopFixture('owned');
    await expect(fixture.stop()).resolves.toBe(true);
    expect(fixture.signals).toEqual([{ pid: 123456, signal: 'SIGTERM' }]);
  });
});
