import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { RemoteGenomicsSupervisor } from './remote-genomics-supervisor';
import { RemoteEndpointExplorer } from './remote-endpoint-explorer';

const fixtures: Array<{
  root: string;
  drained: string;
  pidFile: string;
  rejectedConfiguration: boolean;
}> = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    if (fixture.rejectedConfiguration) {
      expect(existsSync(fixture.pidFile)).toBe(false);
      expect(existsSync(fixture.drained)).toBe(false);
    } else {
      await expect.poll(() => existsSync(fixture.drained), { timeout: 2_000 }).toBe(true);
    }
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function exitedSshWithPendingOutput(input: {
  diagnostic?: string;
  delaySeconds?: number;
  staleReadiness?: boolean;
  explorerReadiness?: boolean;
  holdSeconds?: number;
  rejectConfiguration?: boolean;
}): Promise<{ sshPath: string; drained: string; pidFile: string; lifecycle: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dnaforge-ssh-startup-'));
  const drained = join(root, 'output-drained');
  const sshPath = join(root, 'ssh');
  const pidFile = join(root, 'ssh-pid');
  const lifecycle = join(root, 'lifecycle');
  fixtures.push({
    root,
    drained,
    pidFile,
    rejectedConfiguration: input.rejectConfiguration === true,
  });
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(
    sshPath,
    [
      '#!/bin/bash',
      `trace() { printf '%s %s\\n' "$1" "$$" >> ${quote(lifecycle)}; }`,
      'if [ "$1" = -G ]; then',
      '  trace configuration-started',
      ...(input.rejectConfiguration ? ['  trace configuration-rejected', '  exit 73'] : []),
      "  printf 'controlmaster false\\ncontrolpath none\\n'",
      '  trace configuration-completed',
      '  exit 0',
      'fi',
      'trace original-child-started',
      `printf '%s' "$$" > ${quote(pidFile)}`,
      '(',
      '  trace inherited-writer-started',
      `  sleep ${input.delaySeconds ?? 0.1}`,
      ...(input.staleReadiness ? ["  printf 'DNAFORGE_REMOTE_READY {}\\n'"] : []),
      ...(input.explorerReadiness
        ? [
            '  printf \'DNAFORGE_REMOTE_EXPLORE_READY {"protocol":"dnaforge-remote-explorer.v1","port":32123,"platform":"Linux","homePath":"/home/fixture"}\\n\'',
          ]
        : []),
      ...(input.diagnostic ? [`  printf '%s\\n' ${quote(input.diagnostic)} >&2`] : []),
      ...(input.holdSeconds ? [`  sleep ${input.holdSeconds}`] : []),
      '  trace inherited-writer-releasing',
      `  : > ${quote(drained)}`,
      ') </dev/null &',
      'trace original-child-exiting',
      'exit 255',
      '',
    ].join('\n'),
    { mode: 0o700 }
  );
  return { sshPath, drained, pidFile, lifecycle };
}

describe('SSH startup classification after child exit', () => {
  it.each(['alignment', 'signal'] as const)(
    'classifies %s authentication denial after inherited stderr drains',
    async (kind) => {
      const fixture = await exitedSshWithPendingOutput({
        diagnostic: 'denied@fixture: Permission denied (publickey).',
      });
      const supervisor = new RemoteGenomicsSupervisor({
        sshPath: fixture.sshPath,
        connectTimeoutMs: 1_000,
      });
      try {
        const request = { target: 'stdio-fixture', allowInteractive: false };
        const opening =
          kind === 'alignment'
            ? supervisor.connect({
                ...request,
                alignmentPath: '/reads.bam',
                indexPath: '/reads.bam.bai',
              })
            : supervisor.connectSignal({ ...request, signalPath: '/coverage.bw' });
        await expect(opening).rejects.toMatchObject({ code: 'authentication-required' });
        await expect.poll(() => existsSync(fixture.drained), { timeout: 2_000 }).toBe(true);
      } finally {
        await supervisor.stopAll();
      }
    }
  );

  it('retains a delayed host-trust diagnostic', async () => {
    const fixture = await exitedSshWithPendingOutput({
      diagnostic: 'Host key verification failed.',
    });
    const supervisor = new RemoteGenomicsSupervisor({ sshPath: fixture.sshPath });
    try {
      await expect(
        supervisor.connectSignal({ target: 'stdio-fixture', signalPath: '/coverage.bw' })
      ).rejects.toMatchObject({ code: 'host-trust-failed' });
    } finally {
      await supervisor.stopAll();
    }
  });

  it('does not accept readiness output from an already-exited child', async () => {
    const fixture = await exitedSshWithPendingOutput({
      staleReadiness: true,
      diagnostic: 'denied@fixture: Permission denied (publickey).',
    });
    const supervisor = new RemoteGenomicsSupervisor({ sshPath: fixture.sshPath });
    try {
      await expect(
        supervisor.connectSignal({ target: 'stdio-fixture', signalPath: '/coverage.bw' })
      ).rejects.toMatchObject({ code: 'authentication-required' });
    } finally {
      await supervisor.stopAll();
    }
  });

  it('keeps startup bounded when an inherited output pipe remains open', async () => {
    const fixture = await exitedSshWithPendingOutput({ delaySeconds: 1.2 });
    const supervisor = new RemoteGenomicsSupervisor({
      sshPath: fixture.sshPath,
      connectTimeoutMs: 500,
    });
    try {
      await expect(
        supervisor.connectSignal({ target: 'stdio-fixture', signalPath: '/coverage.bw' })
      ).rejects.toMatchObject({ code: 'connection-timeout' });
      expect(existsSync(fixture.drained)).toBe(false);
    } finally {
      await supervisor.stopAll();
    }
  });

  it('preserves the generic helper failure after an empty stderr closes', async () => {
    const fixture = await exitedSshWithPendingOutput({});
    const supervisor = new RemoteGenomicsSupervisor({ sshPath: fixture.sshPath });
    try {
      await expect(
        supervisor.connectSignal({ target: 'stdio-fixture', signalPath: '/coverage.bw' })
      ).rejects.toMatchObject({ code: 'helper-failed' });
    } finally {
      await supervisor.stopAll();
    }
  });

  it('settles cancellation after SSH exits without waiting for an inherited pipe', async () => {
    const fixture = await exitedSshWithPendingOutput({ delaySeconds: 1.2 });
    const supervisor = new RemoteGenomicsSupervisor({
      sshPath: fixture.sshPath,
      connectTimeoutMs: 3_000,
    });
    const controller = new AbortController();
    const reason = new Error('owned fixture startup cancelled');
    let settled = false;
    const opening = supervisor
      .connectSignal({ target: 'stdio-fixture', signalPath: '/coverage.bw' }, controller.signal)
      .catch((error: unknown) => {
        settled = true;
        return error;
      });
    try {
      await expect
        .poll(async () => {
          if (!existsSync(fixture.pidFile)) return false;
          const pid = Number(await readFile(fixture.pidFile, 'utf8'));
          if (!Number.isSafeInteger(pid) || pid < 1) return false;
          try {
            process.kill(pid, 0);
            return false;
          } catch (error) {
            return (error as NodeJS.ErrnoException).code === 'ESRCH';
          }
        })
        .toBe(true);
      expect(existsSync(fixture.drained)).toBe(false);
      controller.abort(reason);
      await expect.poll(() => settled, { timeout: 250, interval: 10 }).toBe(true);
      expect(await opening).toBe(reason);
    } finally {
      controller.abort(reason);
      await opening;
      await supervisor.stopAll();
    }
  });
});

describe('file browser startup classification after child exit', () => {
  it('retains a configuration failure before the original SSH child starts', async () => {
    const fixture = await exitedSshWithPendingOutput({ rejectConfiguration: true });
    const explorer = new RemoteEndpointExplorer({ sshPath: fixture.sshPath });
    try {
      await expect(
        explorer.open({ requestId: 'rejected-browser-configuration', target: 'stdio-fixture' }, 42)
      ).rejects.toMatchObject({
        code: 'helper-failed',
        message:
          'OpenSSH connection settings could not be read. Check your SSH configuration or try again.',
      });
      expect(existsSync(fixture.pidFile)).toBe(false);
      expect(existsSync(fixture.drained)).toBe(false);
      const lifecycle = await readFile(fixture.lifecycle, 'utf8');
      expect(lifecycle).toContain('configuration-rejected');
      expect(lifecycle).not.toContain('original-child-started');
      expect(lifecycle).not.toContain('inherited-writer-started');
    } finally {
      await explorer.stopAll();
    }
  });

  it.each([
    ['denied@fixture: Permission denied (publickey).', 'authentication-required'],
    ['Host key verification failed.', 'host-trust-failed'],
    ['python3: command not found', 'python-unavailable'],
  ])('retains the delayed browser failure: %s', async (diagnostic, code) => {
    const fixture = await exitedSshWithPendingOutput({ diagnostic });
    const explorer = new RemoteEndpointExplorer({ sshPath: fixture.sshPath, timeoutMs: 1_000 });
    try {
      await expect(
        explorer.open({ requestId: 'delayed-browser-failure', target: 'stdio-fixture' }, 42)
      ).rejects.toMatchObject({ code });
      await expect.poll(() => existsSync(fixture.drained), { timeout: 2_000 }).toBe(true);
    } finally {
      await explorer.stopAll();
    }
  });

  it('ignores valid browser readiness emitted after the SSH child exits', async () => {
    const fixture = await exitedSshWithPendingOutput({
      explorerReadiness: true,
      diagnostic: 'denied@fixture: Permission denied (publickey).',
    });
    const explorer = new RemoteEndpointExplorer({ sshPath: fixture.sshPath });
    try {
      await expect(
        explorer.open({ requestId: 'stale-browser-ready', target: 'stdio-fixture' }, 42)
      ).rejects.toMatchObject({ code: 'authentication-required' });
    } finally {
      await explorer.stopAll();
    }
  });

  it('bounds the browser startup when an inherited output pipe remains open', async () => {
    const fixture = await exitedSshWithPendingOutput({ delaySeconds: 1.2 });
    const explorer = new RemoteEndpointExplorer({ sshPath: fixture.sshPath, timeoutMs: 500 });
    try {
      await expect(
        explorer.open({ requestId: 'bounded-browser-pipe', target: 'stdio-fixture' }, 42)
      ).rejects.toMatchObject({ code: 'connection-timeout' });
      expect(existsSync(fixture.drained)).toBe(false);
    } finally {
      await explorer.stopAll();
    }
  });

  it('cancels the browser immediately while waiting for an exited child output pipe', async () => {
    const fixture = await exitedSshWithPendingOutput({ delaySeconds: 1.2 });
    const explorer = new RemoteEndpointExplorer({ sshPath: fixture.sshPath, timeoutMs: 3_000 });
    const requestId = 'cancel-browser-pipe';
    let settled = false;
    let openingResult: unknown;
    let phase = 'waiting-for-original-child-exit';
    const opening = explorer
      .open({ requestId, target: 'stdio-fixture' }, 42)
      .catch((error: unknown) => {
        settled = true;
        openingResult = error;
        return error;
      });
    try {
      await expect
        .poll(async () => {
          if (!existsSync(fixture.pidFile)) return false;
          const pid = Number(await readFile(fixture.pidFile, 'utf8'));
          try {
            process.kill(pid, 0);
            return false;
          } catch (error) {
            return (error as NodeJS.ErrnoException).code === 'ESRCH';
          }
        })
        .toBe(true);
      expect(settled).toBe(false);
      expect(existsSync(fixture.drained)).toBe(false);
      phase = 'cancelling-with-inherited-pipe-open';
      expect(explorer.cancelOpen(requestId, 42)).toBe(true);
      await expect.poll(() => settled, { timeout: 250, interval: 10 }).toBe(true);
      expect(await opening).toMatchObject({
        code: 'helper-failed',
        message: 'The connection test was cancelled.',
      });
    } catch (error) {
      console.error('[remote-ssh-startup-fixture]', {
        phase,
        settled,
        openingResult,
        pid: await readFile(fixture.pidFile, 'utf8').catch(() => null),
        writerDrained: existsSync(fixture.drained),
        lifecycle: await readFile(fixture.lifecycle, 'utf8').catch(() => null),
      });
      throw error;
    } finally {
      explorer.cancelOpen(requestId, 42);
      await opening;
      await explorer.stopAll();
    }
  });
});

describe('terminal SSH diagnostics with inherited pipes still open', () => {
  it.each(['alignment', 'signal', 'explorer'] as const)(
    'reports %s missing Python after command exit without waiting for the shared master pipe',
    async (kind) => {
      const fixture = await exitedSshWithPendingOutput({
        diagnostic:
          'debug1: preferred authentication includes keyboard-interactive\npython3: command not found',
        holdSeconds: 1.2,
      });
      const supervisor = new RemoteGenomicsSupervisor({
        sshPath: fixture.sshPath,
        connectTimeoutMs: 500,
      });
      const explorer = new RemoteEndpointExplorer({ sshPath: fixture.sshPath, timeoutMs: 500 });
      try {
        const opening =
          kind === 'explorer'
            ? explorer.open({ requestId: 'held-pipe-browser', target: 'stdio-fixture' }, 42)
            : kind === 'alignment'
              ? supervisor.connect({
                  target: 'stdio-fixture',
                  alignmentPath: '/reads.bam',
                  indexPath: '/reads.bam.bai',
                })
              : supervisor.connectSignal({ target: 'stdio-fixture', signalPath: '/coverage.bw' });
        await expect(opening).rejects.toMatchObject({ code: 'python-unavailable' });
        expect(existsSync(fixture.drained)).toBe(false);
      } finally {
        await explorer.stopAll();
        await supervisor.stopAll();
      }
    }
  );

  it('does not turn a debug-only authentication mention into an early failure', async () => {
    const fixture = await exitedSshWithPendingOutput({
      diagnostic: 'debug1: preferred authentication includes keyboard-interactive',
      holdSeconds: 1.2,
    });
    const explorer = new RemoteEndpointExplorer({ sshPath: fixture.sshPath, timeoutMs: 500 });
    try {
      await expect(
        explorer.open({ requestId: 'debug-only-browser', target: 'stdio-fixture' }, 42)
      ).rejects.toMatchObject({ code: 'connection-timeout' });
      expect(existsSync(fixture.drained)).toBe(false);
    } finally {
      await explorer.stopAll();
    }
  });
});
