// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { connect } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  existingSocket: false,
  checkArguments: [] as string[],
  streamArguments: [] as string[],
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    stat: async (path: string) =>
      path === '/tmp/rt-control-private'
        ? { isDirectory: () => true, uid: process.getuid?.(), mode: 0o700 }
        : actual.stat(path),
    lstat: async (path: string) => {
      if (path !== '/tmp/rt-control-private/socket-%C') return actual.lstat(path);
      if (!fixture.existingSocket) {
        throw Object.assign(new Error('No fixture socket.'), { code: 'ENOENT' });
      }
      return { isSocket: () => true, uid: process.getuid?.() };
    },
  };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFile: (
      executable: string,
      arguments_: string[],
      options: object,
      callback: (...args: unknown[]) => void
    ) => {
      if (executable !== 'fixture-policy-ssh') {
        return actual.execFile(executable, arguments_, options, callback);
      }
      if (arguments_[0] === '-G') {
        return actual.execFile(
          '/usr/bin/ssh',
          [
            '-F',
            '/dev/null',
            '-T',
            '-o',
            'ControlMaster=auto',
            '-o',
            'ControlPersist=300',
            '-o',
            'ControlPath=/tmp/rt-control-private/socket-%%C',
            ...arguments_,
          ],
          options,
          callback
        );
      }
      fixture.checkArguments = [...arguments_];
      queueMicrotask(() => callback(null, 'Master running (fixture).'));
      return undefined;
    },
    spawn: (executable: string, arguments_: string[], options: object) => {
      if (executable !== 'fixture-stdio-ssh') return actual.spawn(executable, arguments_, options);
      fixture.streamArguments = [...arguments_];
      return actual.spawn(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], options);
    },
  };
});

import { buildRemoteSshArgs, reserveLoopbackPort } from './remote-genomics-supervisor';
import {
  addRemoteSshLocalForward,
  cancelRemoteSshLocalForward,
  type RemoteSshLocalForward,
} from './remote-ssh-local-forward';
import { resolveSystemSshControlPath } from './remote-ssh-system-sharing';

const literalPath = '/tmp/rt-control-private/socket-%C';
const forwards: RemoteSshLocalForward[] = [];

function effectiveControlPath(arguments_: readonly string[]): string {
  const output = execFileSync('/usr/bin/ssh', ['-F', '/dev/null', '-T', '-G', ...arguments_], {
    encoding: 'utf8',
    timeout: 2000,
  });
  const result = output.match(/^controlpath (.+)$/mu)?.[1];
  if (!result) throw new Error('Expected an OpenSSH control path.');
  return result;
}

beforeEach(() => {
  fixture.existingSocket = false;
  fixture.checkArguments = [];
  fixture.streamArguments = [];
});

afterEach(async () => {
  await Promise.all(forwards.splice(0).map(cancelRemoteSshLocalForward));
});

describe.skipIf(process.platform === 'win32')(
  'resolved OpenSSH control paths with literal percent characters',
  () => {
    it('keeps an eligible resolved path identical through the command-channel handoff', async () => {
      const resolved = await resolveSystemSshControlPath('fixture-policy-ssh', 'example.invalid');
      expect(resolved).toBe(literalPath);
      const arguments_ = buildRemoteSshArgs({
        localPort: 12345,
        remotePort: 0,
        target: 'example.invalid',
        control: { path: resolved!, master: false, systemShared: true },
      });
      expect(effectiveControlPath(arguments_)).toBe(literalPath);
    });

    it('checks the configured literal socket instead of another expanded socket', async () => {
      fixture.existingSocket = true;
      await expect(
        resolveSystemSshControlPath('fixture-policy-ssh', 'example.invalid')
      ).resolves.toBe(literalPath);
      const controlOption = fixture.checkArguments.indexOf('-S');
      expect(controlOption).toBeGreaterThanOrEqual(0);
      expect(
        effectiveControlPath(['-S', fixture.checkArguments[controlOption + 1]!, 'example.invalid'])
      ).toBe(literalPath);
    });

    it('lends a stdio channel from that same literal socket', async () => {
      const forward: RemoteSshLocalForward = {
        sshPath: 'fixture-stdio-ssh',
        target: 'example.invalid',
        controlPath: literalPath,
        localPort: await reserveLoopbackPort(),
        remotePort: 12346,
      };
      forwards.push(forward);
      await expect(addRemoteSshLocalForward(forward)).resolves.toBe(true);
      const socket = connect({ host: '127.0.0.1', port: forward.localPort });
      try {
        const echoed = new Promise<string>((resolve, reject) => {
          socket.once('data', (data) => resolve(data.toString('utf8')));
          socket.once('error', reject);
        });
        socket.end('probe');
        expect(await echoed).toBe('probe');
        const controlOption = fixture.streamArguments.indexOf('-S');
        expect(controlOption).toBeGreaterThanOrEqual(0);
        expect(
          effectiveControlPath([
            '-S',
            fixture.streamArguments[controlOption + 1]!,
            'example.invalid',
          ])
        ).toBe(literalPath);
      } finally {
        socket.destroy();
      }
    });
  }
);
