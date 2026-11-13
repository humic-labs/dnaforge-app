import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { stopChildProcessTree } from './sidecar-process-tree';

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stubbornTree(): Promise<{ parent: ChildProcess; workerPid: number }> {
  const workerScript = `
    process.on('SIGTERM', () => {});
    process.send('ready');
    setInterval(() => {}, 1000);
  `;
  const parentScript = `
    const { spawn } = require('node:child_process');
    const worker = spawn(process.execPath, ['-e', ${JSON.stringify(workerScript)}], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    worker.once('message', () => process.stdout.write(String(worker.pid) + '\\n'));
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => {}, 1000);
  `;
  const parent = spawn(process.execPath, ['-e', parentScript], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  const [chunk] = (await once(parent.stdout!, 'data')) as [Buffer];
  const workerPid = Number(chunk.toString().trim());
  if (!Number.isInteger(workerPid)) throw new Error(`invalid worker PID: ${chunk.toString()}`);
  return { parent, workerPid };
}

describe('stopChildProcessTree', () => {
  it('shares one actual termination when app shutdown overlaps a worker restart', async () => {
    const { parent, workerPid } = await stubbornTree();
    const kill = vi.spyOn(process, 'kill');
    try {
      const restartStop = stopChildProcessTree(parent, {
        gracefulTimeoutMs: 100,
        forceTimeoutMs: 1000,
      });
      const quitStop = stopChildProcessTree(parent);
      expect(quitStop).toBe(restartStop);
      await Promise.all([restartStop, quitStop]);
      expect(pidIsAlive(parent.pid!)).toBe(false);
      expect(pidIsAlive(workerPid)).toBe(false);
      if (process.platform !== 'win32') {
        expect(
          kill.mock.calls.filter(([pid, signal]) => pid === workerPid && signal === 'SIGTERM')
        ).toHaveLength(1);
      }
    } finally {
      kill.mockRestore();
      for (const pid of [workerPid, parent.pid]) {
        if (!pid) continue;
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
    }
  });
  it.skipIf(process.platform === 'win32')(
    'retries a failed POSIX stop against the original worker after its parent has exited',
    async () => {
      const { parent, workerPid } = await stubbornTree();
      const originalKill = process.kill.bind(process);
      const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === workerPid && signal === 'SIGKILL') {
          throw Object.assign(new Error('injected worker termination refusal'), { code: 'EPERM' });
        }
        return originalKill(pid, signal);
      });
      try {
        await expect(
          stopChildProcessTree(parent, { gracefulTimeoutMs: 200, forceTimeoutMs: 0 })
        ).rejects.toThrow(`surviving PIDs: ${workerPid}`);
        kill.mockRestore();
        expect(pidIsAlive(parent.pid!)).toBe(false);
        expect(pidIsAlive(workerPid)).toBe(true);

        await stopChildProcessTree(parent, { gracefulTimeoutMs: 100, forceTimeoutMs: 1000 });

        expect(pidIsAlive(workerPid)).toBe(false);
      } finally {
        kill.mockRestore();
        for (const pid of [workerPid, parent.pid]) {
          if (!pid) continue;
          try {
            originalKill(pid, 'SIGKILL');
          } catch {}
        }
      }
    }
  );

  it('kills a TERM-resistant descendant after its parent exits and reparents it', async () => {
    const { parent, workerPid } = await stubbornTree();
    try {
      expect(pidIsAlive(parent.pid!)).toBe(true);
      expect(pidIsAlive(workerPid)).toBe(true);

      await stopChildProcessTree(parent, {
        gracefulTimeoutMs: 200,
        forceTimeoutMs: 1000,
      });

      expect(pidIsAlive(parent.pid!)).toBe(false);
      expect(pidIsAlive(workerPid)).toBe(false);
    } finally {
      for (const pid of [workerPid, parent.pid]) {
        if (!pid) continue;
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
    }
  });

  it('waits for the Windows root process to be absent before reporting success', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/main/sidecar-process-tree.ts'), 'utf8');
    const windowsBranch = source.slice(
      source.indexOf("process.platform === 'win32'"),
      source.indexOf('const pids = sidecarProcessTree')
    );

    expect(windowsBranch).toContain('await waitForPidsToExit');
    expect(windowsBranch).toContain('surviving PIDs');
  });
});
