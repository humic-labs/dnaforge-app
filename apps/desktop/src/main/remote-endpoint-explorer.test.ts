import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, type Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { describe, expect, it, vi } from 'vitest';

import {
  createFakeSshBoundary,
  fakeSshProcessHasExited,
  readFakeSshProcesses,
} from '../../../../e2e/electron/fixtures/fake-ssh-boundary';
import {
  buildRemoteExplorerHelperScript,
  RemoteEndpointExplorer,
} from './remote-endpoint-explorer';

describe.runIf(process.platform !== 'win32')(
  'remote directory exploration through an SSH process',
  () => {
    it('keeps listings responsive with an idle TCP socket and recovers after a missing directory', async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'remote-explorer-idle-socket-')));
      const token = 'a'.repeat(48);
      const child = spawn('python3', ['-u', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
      const lines = createInterface({ input: child.stdout });
      let idle: Socket | null = null;
      try {
        const ready = once(lines, 'line');
        child.stdin.end(buildRemoteExplorerHelperScript({ port: 0, token }));
        const [line] = await ready;
        const descriptor = JSON.parse(String(line).replace('DNAFORGE_REMOTE_EXPLORE_READY ', ''));
        const base = `http://127.0.0.1:${descriptor.port}/v1/${token}`;
        idle = connect({ host: '127.0.0.1', port: descriptor.port });
        await once(idle, 'connect');
        const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1_000) });
        expect(await health.json()).toMatchObject({ ready: true });
        const missing = await fetch(
          `${base}/list?path=${encodeURIComponent(join(root, 'missing'))}`,
          {
            signal: AbortSignal.timeout(1_000),
          }
        );
        expect(missing.status).toBe(403);
        expect(await missing.json()).toMatchObject({ code: 'directory-unavailable' });
        const recovered = await fetch(`${base}/list?path=${encodeURIComponent(root)}`, {
          signal: AbortSignal.timeout(1_000),
        });
        expect(recovered.status).toBe(200);
        expect(await recovered.json()).toMatchObject({ path: root, entries: [] });
      } finally {
        idle?.destroy();
        lines.close();
        const closed = once(child, 'close');
        child.kill('SIGTERM');
        await closed;
        await rm(root, { recursive: true, force: true });
      }
    });

    it('does not start an authentication helper after its real settings query fails', async () => {
      const root = await mkdtemp(join(tmpdir(), 'remote-explorer-policy-failure-'));
      const executable = join(root, 'ssh');
      const log = join(root, 'invocations');
      await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${log}'\nexit 255\n`, {
        mode: 0o700,
      });
      const explorer = new RemoteEndpointExplorer({ sshPath: executable });
      try {
        await expect(
          explorer.open({ requestId: 'policy-failure-1234', target: 'lab-hpc' }, 42)
        ).rejects.toThrow('OpenSSH connection settings could not be read');
        expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual(['-G']);
      } finally {
        await explorer.stopAll();
        await rm(root, { recursive: true, force: true });
      }
    });

    it('reports the actual idle deadline once when the browser closes but a track still borrows it', async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'remote-explorer-idle-test-')));
      const boundary = createFakeSshBoundary(root);
      vi.stubEnv('DNAFORGE_FAKE_SSH_BRIDGE', boundary.bridgePath);
      vi.stubEnv('DNAFORGE_FAKE_SSH_LOG', boundary.logPath);
      vi.stubEnv('DNAFORGE_FAKE_SSH_FAIL_MARKER', boundary.failureMarkerPath);
      const explorer = new RemoteEndpointExplorer({ sshPath: boundary.executablePath });
      const closed = vi.fn();
      let idleDeadline: (() => void) | undefined;
      const realTimer = globalThis.setTimeout.bind(globalThis);
      const timerSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
        callback: (...args: unknown[]) => void,
        delay: number,
        ...args: unknown[]
      ) => {
        if (delay === 300_000) idleDeadline = () => callback(...args);
        return realTimer(callback, delay, ...args);
      }) as typeof globalThis.setTimeout);
      try {
        const unsubscribe = explorer.subscribeClosed(closed);
        const connection = await explorer.open(
          { requestId: 'explore-idle-1234', target: 'fake-hpc' },
          42
        );
        const borrow = explorer.retainConnection(connection.sessionId, 'fake-hpc', 42)!;
        expect(idleDeadline).toBeTypeOf('function');
        idleDeadline!();
        expect(closed).toHaveBeenCalledExactlyOnceWith({
          ownerId: 42,
          sessionId: connection.sessionId,
          reason: 'idle',
        });
        await expect(explorer.list(connection.sessionId, root, 42)).rejects.toThrow(
          'no longer open'
        );
        expect((await stat(join(borrow.controlPath, '..'))).isDirectory()).toBe(true);
        await borrow.release();
        expect(closed).toHaveBeenCalledOnce();
        unsubscribe();
      } finally {
        timerSpy.mockRestore();
        await explorer.stopAll();
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
      }
    });

    it('reports unexpected SSH child termination once and removes the dead browser', async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'remote-explorer-loss-test-')));
      const boundary = createFakeSshBoundary(root);
      vi.stubEnv('DNAFORGE_FAKE_SSH_BRIDGE', boundary.bridgePath);
      vi.stubEnv('DNAFORGE_FAKE_SSH_LOG', boundary.logPath);
      vi.stubEnv('DNAFORGE_FAKE_SSH_FAIL_MARKER', boundary.failureMarkerPath);
      const explorer = new RemoteEndpointExplorer({ sshPath: boundary.executablePath });
      const closed = vi.fn();
      try {
        const unsubscribe = explorer.subscribeClosed(closed);
        const removedListener = vi.fn();
        explorer.subscribeClosed(removedListener)();
        const connection = await explorer.open(
          { requestId: 'explore-loss-1234', target: 'fake-hpc' },
          42
        );
        const processes = readFakeSshProcesses(boundary.logPath, 'fake-hpc');
        expect(processes).toHaveLength(1);
        process.kill(processes[0]!.pid, 'SIGTERM');
        await vi.waitFor(() =>
          expect(closed).toHaveBeenCalledExactlyOnceWith({
            ownerId: 42,
            sessionId: connection.sessionId,
            reason: 'connection-lost',
          })
        );
        await expect(explorer.list(connection.sessionId, root, 42)).rejects.toThrow(
          'no longer open'
        );
        await explorer.stopAll();
        expect(closed).toHaveBeenCalledOnce();
        expect(removedListener).not.toHaveBeenCalled();
        unsubscribe();
      } finally {
        await explorer.stopAll();
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
      }
    });

    it('keeps the authenticated connection through picker close until the last track releases it', async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'remote-explorer-borrow-test-')));
      const boundary = createFakeSshBoundary(root);
      vi.stubEnv('DNAFORGE_FAKE_SSH_BRIDGE', boundary.bridgePath);
      vi.stubEnv('DNAFORGE_FAKE_SSH_LOG', boundary.logPath);
      vi.stubEnv('DNAFORGE_FAKE_SSH_FAIL_MARKER', boundary.failureMarkerPath);
      const explorer = new RemoteEndpointExplorer({ sshPath: boundary.executablePath });
      const closed = vi.fn();
      explorer.subscribeClosed(closed);
      try {
        const connection = await explorer.open(
          { requestId: 'explore-borrow-1234', target: 'fake-hpc' },
          42
        );
        expect(await explorer.close(connection.sessionId, 43)).toBe(false);
        expect(closed).not.toHaveBeenCalled();
        expect(() => explorer.retainConnection(connection.sessionId, 'fake-hpc', 43)).toThrow(
          'this target and window'
        );
        expect(() => explorer.retainConnection(connection.sessionId, 'other-hpc', 42)).toThrow(
          'this target and window'
        );
        const first = explorer.retainConnection(connection.sessionId, 'fake-hpc', 42)!;
        const second = explorer.retainConnection(connection.sessionId, 'fake-hpc', 42)!;
        expect(first.controlPath).toBe(second.controlPath);
        const controlRoot = join(first.controlPath, '..');
        expect((await stat(controlRoot)).mode & 0o777).toBe(0o700);
        expect((await explorer.list(connection.sessionId, root, 42)).path).toBe(root);
        const processes = readFakeSshProcesses(boundary.logPath, 'fake-hpc');
        expect(processes).toHaveLength(1);
        const helperPid = processes[0]!.pid;
        expect(await explorer.close(connection.sessionId, 42)).toBe(true);
        expect(closed).toHaveBeenCalledExactlyOnceWith({
          ownerId: 42,
          sessionId: connection.sessionId,
          reason: 'disconnected',
        });
        await expect(explorer.list(connection.sessionId, root, 42)).rejects.toThrow(
          'no longer open'
        );
        expect(fakeSshProcessHasExited(helperPid)).toBe(false);
        await first.release();
        await first.release();
        expect((await stat(controlRoot)).isDirectory()).toBe(true);
        expect(fakeSshProcessHasExited(helperPid)).toBe(false);
        await second.release();
        expect(closed).toHaveBeenCalledOnce();
        await expect(stat(controlRoot)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(fakeSshProcessHasExited(helperPid)).toBe(true);
      } finally {
        await explorer.stopAll();
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
      }
    });

    it('invalidates a lost owner browser while a retained source keeps its real TCP connection', async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'remote-explorer-owner-test-')));
      const boundary = createFakeSshBoundary(root);
      vi.stubEnv('DNAFORGE_FAKE_SSH_BRIDGE', boundary.bridgePath);
      vi.stubEnv('DNAFORGE_FAKE_SSH_LOG', boundary.logPath);
      vi.stubEnv('DNAFORGE_FAKE_SSH_FAIL_MARKER', boundary.failureMarkerPath);
      const explorer = new RemoteEndpointExplorer({ sshPath: boundary.executablePath });
      const closed = vi.fn();
      explorer.subscribeClosed(closed);
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      try {
        const connection = await explorer.open(
          { requestId: 'explore-owner-1234', target: 'fake-hpc' },
          42
        );
        const borrow = explorer.retainConnection(connection.sessionId, 'fake-hpc', 42)!;
        const healthUrl = fetchSpy.mock.calls.find(
          ([url]) => typeof url === 'string' && url.endsWith('/health')
        )?.[0];
        if (typeof healthUrl !== 'string')
          throw new Error('The explorer did not check its health.');

        await explorer.closeOwner(42);

        expect(closed).toHaveBeenCalledExactlyOnceWith({
          ownerId: 42,
          sessionId: connection.sessionId,
          reason: 'disconnected',
        });
        await expect(explorer.list(connection.sessionId, root, 42)).rejects.toThrow(
          'no longer open'
        );
        expect((await stat(join(borrow.controlPath, '..'))).isDirectory()).toBe(true);
        expect(await (await fetch(healthUrl)).json()).toMatchObject({ ready: true });

        await borrow.release();

        await expect(fetch(healthUrl)).rejects.toThrow();
        await expect(stat(join(borrow.controlPath, '..'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
        expect(closed).toHaveBeenCalledOnce();
      } finally {
        fetchSpy.mockRestore();
        await explorer.stopAll();
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
      }
    });

    it('can cancel before port and socket preparation without spawning an SSH process', async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'remote-explorer-cancel-test-')));
      const boundary = createFakeSshBoundary(root);
      const explorer = new RemoteEndpointExplorer({ sshPath: boundary.executablePath });
      try {
        const opening = explorer.open({ requestId: 'explore-cancel-1234', target: 'fake-hpc' }, 42);
        expect(explorer.cancelOpen('explore-cancel-1234', 43)).toBe(false);
        expect(explorer.cancelOpen('explore-cancel-1234', 42)).toBe(true);
        await expect(opening).rejects.toThrow('cancelled');
        await expect(stat(boundary.logPath)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await explorer.stopAll();
        await rm(root, { recursive: true, force: true });
      }
    });

    it('lists one bounded UTF-8 directory, rejects another window, and releases the connection on close', async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'remote-explorer-test-')));
      const boundary = createFakeSshBoundary(root);
      vi.stubEnv('DNAFORGE_FAKE_SSH_BRIDGE', boundary.bridgePath);
      vi.stubEnv('DNAFORGE_FAKE_SSH_LOG', boundary.logPath);
      vi.stubEnv('DNAFORGE_FAKE_SSH_FAIL_MARKER', boundary.failureMarkerPath);
      const explorer = new RemoteEndpointExplorer({ sshPath: boundary.executablePath });
      try {
        const directory = join(root, 'run 42 µ');
        await mkdir(directory);
        await mkdir(join(directory, 'subfolder'));
        await Promise.all(
          ['tumor.bam', 'tumor.bam.bai', 'tumor.bigWig', 'private-notes.txt'].map((name) =>
            writeFile(join(directory, name), 'fixture')
          )
        );
        const connection = await explorer.open(
          { requestId: 'explore-test-1234', target: 'fake-hpc' },
          42
        );
        expect(connection).toMatchObject({ target: 'fake-hpc', platform: expect.any(String) });
        const listing = await explorer.list(connection.sessionId, directory, 42);
        expect(listing).toMatchObject({ path: directory, parentPath: root, truncated: false });
        expect(listing.entries).toEqual([
          { name: 'subfolder', path: join(directory, 'subfolder'), kind: 'directory' },
          { name: 'tumor.bam', path: join(directory, 'tumor.bam'), kind: 'alignment' },
          { name: 'tumor.bam.bai', path: join(directory, 'tumor.bam.bai'), kind: 'index' },
          { name: 'tumor.bigWig', path: join(directory, 'tumor.bigWig'), kind: 'signal' },
        ]);
        await expect(explorer.list(connection.sessionId, directory, 43)).rejects.toThrow(
          'no longer open'
        );
        expect(await explorer.close(connection.sessionId, 43)).toBe(false);
        await expect(
          explorer.list(connection.sessionId, join(root, 'missing'), 42)
        ).rejects.toThrow('missing or cannot be read');
        await expect(explorer.list(connection.sessionId, 'relative-path', 42)).rejects.toThrow(
          'absolute POSIX path'
        );

        await Promise.all(
          Array.from({ length: 140 }, (_, index) =>
            writeFile(join(directory, `sample-${index}.bam`), 'fixture')
          )
        );
        const bounded = await explorer.list(connection.sessionId, directory, 42);
        expect(bounded.entries).toHaveLength(128);
        expect(bounded.truncated).toBe(true);
        await explorer.closeOwner(42);
        await expect(explorer.list(connection.sessionId, directory, 42)).rejects.toThrow(
          'no longer open'
        );
        expect(await explorer.close(connection.sessionId, 42)).toBe(false);
      } finally {
        await explorer.stopAll();
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
);
