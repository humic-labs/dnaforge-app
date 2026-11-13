// @vitest-environment node
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, Server } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RemoteSignalMaterializationV1 } from '../shared/remote-genomics-ipc';
import {
  createFakeSshBoundary,
  fakeSshProcessHasExited,
  readFakeSshProcesses,
} from '../../../../e2e/electron/fixtures/fake-ssh-boundary';
import {
  buildRemoteRangeHelperScript,
  RemoteGenomicsSupervisor,
  terminateRemoteChild,
} from './remote-genomics-supervisor';
import { RemoteGenomicsRuntime } from './remote-genomics-runtime';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.unstubAllEnvs();
});

async function signalFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dnaforge-standalone-signal-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const signalPath = join(root, 'only.bigWig');
  await writeFile(signalPath, Buffer.from('original-signal-data'));
  return { root, signalPath };
}

async function helperReady(child: ChildProcessWithoutNullStreams): Promise<{
  port: number;
  paths: { signal: string };
  files: RemoteSignalMaterializationV1['generation'];
}> {
  return new Promise((resolve, reject) => {
    let output = '';
    let diagnostic = '';
    const timer = setTimeout(() => reject(new Error('Signal helper did not become ready')), 2_000);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      diagnostic += chunk;
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      const ready = /^DNAFORGE_REMOTE_READY (.+)$/mu.exec(output);
      if (ready) {
        clearTimeout(timer);
        resolve(JSON.parse(ready[1]));
      }
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error(output || diagnostic || 'Signal helper exited before readiness'));
    });
  });
}

async function directHelper(signalPath: string) {
  const child = spawn('python3', ['-u', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
  cleanup.push(() => terminateRemoteChild(child));
  const readiness = helperReady(child);
  child.stdin.end(
    buildRemoteRangeHelperScript({
      port: 0,
      signalPath,
      sourceHandle: 'standalone-signal',
    })
  );
  const ready = await readiness;
  return { child, ready, url: `http://127.0.0.1:${ready.port}${ready.paths.signal}` };
}

async function supervisedFixture() {
  const fixture = await signalFixture();
  const boundary = createFakeSshBoundary(fixture.root);
  vi.stubEnv('DNAFORGE_FAKE_SSH_LOG', boundary.logPath);
  vi.stubEnv('DNAFORGE_FAKE_SSH_BRIDGE', boundary.bridgePath);
  vi.stubEnv('DNAFORGE_FAKE_SSH_FAIL_MARKER', boundary.failureMarkerPath);
  const supervisor = new RemoteGenomicsSupervisor({ sshPath: boundary.executablePath });
  cleanup.push(() => supervisor.stopAll());
  return {
    ...fixture,
    boundary,
    supervisor,
    request: {
      target: 'signal-only-hpc',
      endpointId: 'signal-endpoint',
      signalPath: fixture.signalPath,
    },
  };
}

async function rangeText(url: string) {
  const response = await fetch(url, {
    headers: { Range: 'bytes=0-7' },
    signal: AbortSignal.timeout(2_000),
  });
  expect(response.status).toBe(206);
  return response.text();
}

describe('standalone remote BigWig admission', () => {
  it('opens and serves just the signal when no alignment or index exists', async () => {
    const fixture = await signalFixture();
    const { ready, url } = await directHelper(fixture.signalPath);
    expect(Object.keys(ready.paths)).toEqual(['signal']);
    expect(Object.keys(ready.files)).toEqual(['signal']);
    expect(ready.files.signal.canonicalPath).toBe(await realpath(fixture.signalPath));
    expect(await rangeText(url)).toBe('original');
    const alignmentUrl = url.replace('/signal.bigWig', '/alignment.bam');
    const unrelated = await fetch(alignmentUrl, { signal: AbortSignal.timeout(2_000) });
    expect(unrelated.status).toBe(404);
    await unrelated.body?.cancel();
  });

  it('pins the signal generation and rejects fresh ranges after an in-place rewrite', async () => {
    const fixture = await signalFixture();
    const { url } = await directHelper(fixture.signalPath);
    expect(await rangeText(url)).toBe('original');
    await writeFile(fixture.signalPath, Buffer.from('changed-signal-data!'));
    const changed = await fetch(url, { headers: { Range: 'bytes=0-7' } });
    expect(changed.status).toBe(412);
    expect(await changed.text()).toMatch(/remote file changed/i);
  });

  it('admits the independent signal through the existing SSH and owned local-forward boundary', async () => {
    const fixture = await supervisedFixture();
    const result = await fixture.supervisor.connectSignal(fixture.request);
    expect(result.locator).toEqual({
      contract: 'remote-signal-locator.v1',
      endpointId: 'signal-endpoint',
      target: fixture.request.target,
      signalPath: await realpath(fixture.signalPath),
    });
    expect(result).not.toHaveProperty('bamUrl');
    expect(result).not.toHaveProperty('indexPath');
    expect(Object.keys(result.generation)).toEqual(['signal']);
    expect(await rangeText(result.bigWigUrl)).toBe('original');
    const processes = readFakeSshProcesses(fixture.boundary.logPath, fixture.request.target);
    expect(processes).toHaveLength(1);
    await fixture.supervisor.disconnect(result.sessionId);
    expect(fakeSshProcessHasExited(processes[0].pid)).toBe(true);
  });

  it('keeps its local listener owned while the remote helper starts', async () => {
    const fixture = await supervisedFixture();
    const competitors: Server[] = [];
    cleanup.push(async () => {
      for (const peer of competitors) {
        await new Promise<void>((resolve, reject) =>
          peer.close((error) => (error ? reject(error) : resolve()))
        );
      }
    });
    const close = Server.prototype.close;
    let claimedReservation = false;
    const closing = vi.spyOn(Server.prototype, 'close').mockImplementation(function (
      this: Server,
      callback?: (error?: Error) => void
    ) {
      const address = this.address();
      if (
        !claimedReservation &&
        address &&
        typeof address !== 'string' &&
        this.listenerCount('connection') === 0
      ) {
        claimedReservation = true;
        return close.call(this, (error) => {
          if (error) {
            callback?.(error);
            return;
          }
          const peer = createServer((socket) => socket.destroy());
          competitors.push(peer);
          peer.once('error', (bindError) => callback?.(bindError));
          peer.listen(address.port, address.address, () => callback?.());
        });
      }
      return close.call(this, callback);
    });
    try {
      const result = await fixture.supervisor.connectSignal(fixture.request);
      expect(await rangeText(result.bigWigUrl)).toBe('original');
      expect(claimedReservation).toBe(false);
      await fixture.supervisor.disconnect(result.sessionId);
    } finally {
      closing.mockRestore();
    }
  });

  it('shares signal leases and keeps their gateway URL usable across an unchanged reconnect', async () => {
    const fixture = await supervisedFixture();
    const connect = vi.fn(fixture.supervisor.connectSignal.bind(fixture.supervisor));
    const provider = {
      connect: vi.fn(() => {
        throw new Error('Signal admission must not open an alignment');
      }),
      connectSignal: connect,
      disconnect: fixture.supervisor.disconnect.bind(fixture.supervisor),
      subscribeSession: fixture.supervisor.subscribeSession.bind(fixture.supervisor),
    };
    const runtime = new RemoteGenomicsRuntime(provider, { healthCheckIntervalMs: 0 });
    cleanup.push(() => runtime.stopAll());
    const first = await runtime.connectSignal(fixture.request);
    const second = await runtime.connectSignal(first.locator);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.bigWigUrl).toBe(second.bigWigUrl);
    expect(first.runtimeStatus).toMatchObject({
      alignmentPath: null,
      indexPath: null,
      state: 'online',
    });
    const owned = readFakeSshProcesses(fixture.boundary.logPath, fixture.request.target);
    process.kill(owned[0].pid, 'SIGTERM');
    await vi.waitFor(() => expect(runtime.listStatuses()[0]?.transportGeneration).toBe(2), {
      timeout: 5_000,
    });
    expect(await rangeText(first.bigWigUrl)).toBe('original');
    await runtime.disconnect(first.sessionId);
    expect(await rangeText(second.bigWigUrl)).toBe('original');
    await runtime.disconnect(second.sessionId);
    expect(runtime.listStatuses()).toEqual([]);
    expect(provider.connect).not.toHaveBeenCalled();
  });

  it('blocks changed signal bytes, then gives explicit readmission a fresh source without reviving old leases', async () => {
    const fixture = await supervisedFixture();
    const connectSignal = vi.fn(fixture.supervisor.connectSignal.bind(fixture.supervisor));
    const provider = {
      connect: vi.fn(() => {
        throw new Error('Unexpected alignment admission');
      }),
      connectSignal,
      disconnect: fixture.supervisor.disconnect.bind(fixture.supervisor),
      subscribeSession: fixture.supervisor.subscribeSession.bind(fixture.supervisor),
    };
    const runtime = new RemoteGenomicsRuntime(provider, { healthCheckIntervalMs: 0 });
    cleanup.push(() => runtime.stopAll());
    const old = await runtime.connectSignal(fixture.request);
    await writeFile(fixture.signalPath, Buffer.from('changed-signal-data!'));
    const changed = await fetch(old.bigWigUrl, { headers: { Range: 'bytes=0-7' } });
    expect(changed.status).toBe(412);
    await changed.body?.cancel();
    await expect(runtime.connectSignal(old.locator)).rejects.toThrow(/files changed/i);
    const fresh = await runtime.connectSignal({
      ...old.locator,
      requestId: 'signal-readmission',
      allowInteractive: true,
    });
    expect(fresh.runtimeStatus?.sourceId).not.toBe(old.runtimeStatus?.sourceId);
    expect(await rangeText(fresh.bigWigUrl)).toBe('changed-');
    const oldDemand = await fetch(old.bigWigUrl);
    expect(oldDemand.status).toBe(503);
    await oldDemand.body?.cancel();
    expect(connectSignal).toHaveBeenCalledTimes(2);
  });

  it('keeps a saved canonical signal bound to its file when a reconnect retargets the requested symlink', async () => {
    const fixture = await supervisedFixture();
    const aliasPath = join(fixture.root, 'current.bw');
    const replacementPath = join(fixture.root, 'replacement.bw');
    await symlink(fixture.signalPath, aliasPath);
    await writeFile(replacementPath, Buffer.from('replaced-signal-data'));
    const connectSignal = vi.fn(fixture.supervisor.connectSignal.bind(fixture.supervisor));
    const runtime = new RemoteGenomicsRuntime(
      {
        connect: vi.fn(() => {
          throw new Error('Unexpected alignment admission');
        }),
        connectSignal,
        disconnect: fixture.supervisor.disconnect.bind(fixture.supervisor),
        subscribeSession: fixture.supervisor.subscribeSession.bind(fixture.supervisor),
      },
      { healthCheckIntervalMs: 0 }
    );
    cleanup.push(() => runtime.stopAll());
    const original = await runtime.connectSignal({ ...fixture.request, signalPath: aliasPath });
    expect(original.locator.signalPath).toBe(await realpath(fixture.signalPath));
    await unlink(aliasPath);
    await symlink(replacementPath, aliasPath);
    const owned = readFakeSshProcesses(fixture.boundary.logPath, fixture.request.target);
    process.kill(owned[0].pid, 'SIGTERM');
    await vi.waitFor(
      () => expect(runtime.listStatuses()[0]?.lastFailure?.code).toBe('source-changed'),
      { timeout: 5_000 }
    );
    const replacement = await runtime.connectSignal({
      ...fixture.request,
      signalPath: aliasPath,
      requestId: 'retarget-signal',
      allowInteractive: true,
    });
    expect(replacement.locator.signalPath).toBe(await realpath(replacementPath));
    expect(await rangeText(replacement.bigWigUrl)).toBe('replaced');
    await expect(runtime.connectSignal(original.locator)).rejects.toThrow(/files changed/i);
    expect(connectSignal).toHaveBeenCalledTimes(3);
  });

  it('does not rebind a saved canonical signal while final release and a retargeted reconnect overlap', async () => {
    const fixture = await supervisedFixture();
    const aliasPath = join(fixture.root, 'current.bw');
    const replacementPath = join(fixture.root, 'replacement.bw');
    await symlink(fixture.signalPath, aliasPath);
    await writeFile(replacementPath, Buffer.from('replaced-signal-data'));
    const connectSignal = vi.fn(fixture.supervisor.connectSignal.bind(fixture.supervisor));
    let releaseDisconnect!: () => void;
    const disconnectHeld = new Promise<void>((resolve) => {
      releaseDisconnect = resolve;
    });
    let heldSessionId: string | null = null;
    const runtime = new RemoteGenomicsRuntime(
      {
        connect: vi.fn(() => {
          throw new Error('Unexpected alignment admission');
        }),
        connectSignal,
        disconnect: async (sessionId) => {
          if (sessionId === heldSessionId) await disconnectHeld;
          return fixture.supervisor.disconnect(sessionId);
        },
        subscribeSession: fixture.supervisor.subscribeSession.bind(fixture.supervisor),
      },
      { healthCheckIntervalMs: 0 }
    );
    cleanup.push(() => runtime.stopAll());
    const original = await runtime.connectSignal({ ...fixture.request, signalPath: aliasPath });
    heldSessionId = (await connectSignal.mock.results[0].value).sessionId;
    await unlink(aliasPath);
    await symlink(replacementPath, aliasPath);
    const releasing = runtime.disconnect(original.sessionId);
    try {
      const replacement = await runtime.connectSignal({
        ...fixture.request,
        signalPath: aliasPath,
      });
      expect(replacement.locator.signalPath).toBe(await realpath(replacementPath));
      const canonical = await runtime.connectSignal(original.locator);
      expect(canonical.locator.signalPath).toBe(original.locator.signalPath);
      expect(canonical.bigWigUrl).not.toBe(replacement.bigWigUrl);
      expect(await rangeText(canonical.bigWigUrl)).toBe('original');
      expect(connectSignal).toHaveBeenCalledTimes(3);
    } finally {
      releaseDisconnect();
      await releasing;
    }
  });

  it('releases a signal helper returned after its renderer cancels the pending acquisition', async () => {
    const fixture = await supervisedFixture();
    let resolveCandidate!: (value: RemoteSignalMaterializationV1) => void;
    const candidate = new Promise<RemoteSignalMaterializationV1>((resolve) => {
      resolveCandidate = resolve;
    });
    const connectSignal = vi.fn(() => candidate);
    const disconnect = vi.fn(fixture.supervisor.disconnect.bind(fixture.supervisor));
    const runtime = new RemoteGenomicsRuntime(
      {
        connect: vi.fn(() => {
          throw new Error('Unexpected alignment admission');
        }),
        connectSignal,
        disconnect,
        subscribeSession: fixture.supervisor.subscribeSession.bind(fixture.supervisor),
      },
      { healthCheckIntervalMs: 0 }
    );
    cleanup.push(() => runtime.stopAll());
    const opening = runtime.connectSignal({ ...fixture.request, requestId: 'cancel-signal' });
    const rejected = expect(opening).rejects.toThrow(/cancelled/i);
    await vi.waitFor(() => expect(connectSignal).toHaveBeenCalledOnce());
    expect(runtime.cancelConnect('cancel-signal')).toBe(true);
    const late = await fixture.supervisor.connectSignal(fixture.request);
    resolveCandidate(late);
    await rejected;
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledExactlyOnceWith(late.sessionId));
    await expect(disconnect.mock.results[0]?.value).resolves.toBe(true);
    expect(runtime.listStatuses()).toEqual([]);
    expect(
      readFakeSshProcesses(fixture.boundary.logPath, fixture.request.target).every(({ pid }) =>
        fakeSshProcessHasExited(pid)
      )
    ).toBe(true);
  });
});
