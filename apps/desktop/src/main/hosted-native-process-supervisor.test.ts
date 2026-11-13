import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HostedNativeProcessNotStartedError,
  HostedNativeProcessSupervisor,
  HostedNativeProcessTerminationUnconfirmedError,
  hostedNativeProcessEnvironment,
  hostedNativeShellInvocation,
} from './hosted-native-process-supervisor';

function terminateTestProcessTree(
  child: { pid?: number; kill: (signal: NodeJS.Signals) => boolean },
  signal: NodeJS.Signals,
  platform: NodeJS.Platform
): void {
  if (platform === 'win32' && child.pid) {
    try {
      execFileSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
      });
      return;
    } catch {
      child.kill(signal);
      return;
    }
  }
  if (child.pid) {
    process.kill(-child.pid, signal);
    return;
  }
  child.kill(signal);
}

describe('HostedNativeProcessSupervisor', () => {
  const supervisors: HostedNativeProcessSupervisor[] = [];
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(supervisors.map((supervisor) => supervisor.cancelOwner(7)));
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    supervisors.length = 0;
    roots.length = 0;
  });

  it('passes only the explicit safe environment allowlist', () => {
    expect(
      hostedNativeProcessEnvironment({
        PATH: '/bin',
        HOME: '/tmp/home',
        LANG: 'en_US.UTF-8',
        LC_ALL: 'C',
        AZURE_OPENAI_API_KEY: 'secret',
        DNAFORGE_DESKTOP_TOKEN: 'secret',
        SSH_AUTH_SOCK: '/tmp/agent.sock',
      })
    ).toEqual({ PATH: '/bin', HOME: '/tmp/home', LANG: 'en_US.UTF-8', LC_ALL: 'C' });
  });

  it('uses a fixed non-login POSIX shell so profile files cannot restore filtered values', () => {
    expect(hostedNativeShellInvocation('darwin', 'printf harmless')).toEqual({
      shell: '/bin/sh',
      args: ['-c', 'printf harmless'],
    });
    expect(hostedNativeShellInvocation('linux', 'printf harmless')).not.toEqual(
      expect.objectContaining({ args: expect.arrayContaining(['-l']) })
    );
  });

  it('caps combined process output and never exposes a PID', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-native-process-'));
    roots.push(root);
    const supervisor = new HostedNativeProcessSupervisor({
      idGenerator: () => 'opaque-process',
      outputByteLimit: 8,
      stopGraceMs: 50,
    });
    supervisors.push(supervisor);

    const result = await supervisor.run(
      7,
      'binding-token',
      "printf '123456'; printf 'abcdef' >&2",
      root,
      5_000,
      new AbortController().signal
    );

    expect(result).toEqual({
      process_id: 'opaque-process',
      status: 'completed',
      stdout: '123456',
      stderr: 'ab',
      exit_code: 0,
      truncated: true,
    });
    expect(result).not.toHaveProperty('pid');
  });

  it.skipIf(process.platform === 'win32')(
    'waits for inherited output pipes to close before returning a foreground result',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'hosted-native-process-'));
      roots.push(root);
      const supervisor = new HostedNativeProcessSupervisor({
        idGenerator: () => 'opaque-process',
        stopGraceMs: 50,
      });
      supervisors.push(supervisor);

      const result = await supervisor.run(
        7,
        'binding-token',
        "(sleep 0.05; printf 'late') &",
        root,
        5_000,
        new AbortController().signal
      );

      expect(result).toMatchObject({
        status: 'completed',
        stdout: 'late',
        exit_code: 0,
      });
    }
  );

  it('rejects another turn and stops the owned process group', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-native-process-'));
    roots.push(root);
    const supervisor = new HostedNativeProcessSupervisor({
      idGenerator: () => 'opaque-process',
      stopGraceMs: 50,
    });
    supervisors.push(supervisor);
    supervisor.start(7, 'binding-token', 'sleep 10', root);

    expect(() => supervisor.status(8, 'binding-token', 'opaque-process')).toThrow(/not owned/i);
    await expect(supervisor.stop(7, 'binding-token', 'opaque-process')).resolves.toMatchObject({
      status: 'stopped',
      process_id: 'opaque-process',
    });
  });

  it('does not allocate or spawn a foreground command when Stop already won', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-native-process-'));
    roots.push(root);
    const idGenerator = vi.fn(() => 'must-not-be-allocated');
    const supervisor = new HostedNativeProcessSupervisor({ idGenerator });
    supervisors.push(supervisor);
    const controller = new AbortController();
    controller.abort();

    await expect(
      supervisor.run(7, 'binding-token', "printf 'must-not-run'", root, 5_000, controller.signal)
    ).rejects.toBeInstanceOf(HostedNativeProcessNotStartedError);
    expect(idGenerator).not.toHaveBeenCalled();
  });

  it('caps active background handles and reuses a slot after a process stops', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-native-process-'));
    roots.push(root);
    let sequence = 0;
    const supervisor = new HostedNativeProcessSupervisor({
      idGenerator: () => `opaque-process-${++sequence}`,
      maxProcessHandles: 2,
      stopGraceMs: 50,
    });
    supervisors.push(supervisor);

    supervisor.start(7, 'binding-token', 'sleep 10', root);
    supervisor.start(7, 'binding-token', 'sleep 10', root);
    expect(() => supervisor.start(7, 'binding-token', 'sleep 10', root)).toThrow(/process limit/i);

    await supervisor.stop(7, 'binding-token', 'opaque-process-1');
    expect(supervisor.start(7, 'binding-token', 'sleep 10', root)).toMatchObject({
      process_id: 'opaque-process-3',
      status: 'running',
    });
  });

  it('delegates Stop to one process-tree terminator', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-native-process-'));
    roots.push(root);
    const terminateProcessTree = vi.fn(terminateTestProcessTree);
    const supervisor = new HostedNativeProcessSupervisor({
      idGenerator: () => 'opaque-process',
      stopGraceMs: 50,
      terminateProcessTree,
    });
    supervisors.push(supervisor);
    supervisor.start(7, 'binding-token', 'sleep 10', root);

    await supervisor.stop(7, 'binding-token', 'opaque-process');

    expect(terminateProcessTree).toHaveBeenCalledWith(
      expect.anything(),
      'SIGTERM',
      process.platform
    );
  });

  it.skipIf(process.platform === 'win32')(
    'reports and retains ownership when process termination cannot be confirmed',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'hosted-native-process-'));
      roots.push(root);
      let suppressedTerminations = 2;
      const terminateProcessTree = vi.fn(
        (
          child: { pid?: number; kill: (signal: NodeJS.Signals) => boolean },
          signal: NodeJS.Signals,
          platform: NodeJS.Platform
        ) => {
          if (suppressedTerminations > 0) {
            suppressedTerminations -= 1;
            return;
          }
          terminateTestProcessTree(child, signal, platform);
        }
      );
      const supervisor = new HostedNativeProcessSupervisor({
        idGenerator: () => 'wedged-process',
        maxProcessHandles: 1,
        stopGraceMs: 5,
        terminateProcessTree,
      });
      supervisors.push(supervisor);
      supervisor.start(7, 'binding-token', 'sleep 10', root);

      const stopped = supervisor.stop(7, 'binding-token', 'wedged-process');
      await expect(stopped).rejects.toBeInstanceOf(HostedNativeProcessTerminationUnconfirmedError);
      expect(terminateProcessTree.mock.calls.map((call) => call[1])).toEqual([
        'SIGTERM',
        'SIGKILL',
      ]);
      expect(supervisor.status(7, 'binding-token', 'wedged-process')).toMatchObject({
        status: 'termination_unconfirmed',
      });
      expect(() => supervisor.start(7, 'binding-token', 'sleep 0.01', root)).toThrow(
        /process limit/i
      );

      await expect(supervisor.stop(7, 'binding-token', 'wedged-process')).resolves.toMatchObject({
        status: 'stopped',
      });
      expect(terminateProcessTree.mock.calls.map((call) => call[1])).toEqual([
        'SIGTERM',
        'SIGKILL',
        'SIGTERM',
      ]);
    }
  );
});
