import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { get as getHttp, type ClientRequest, type IncomingMessage } from 'node:http';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createFakeSshBoundary,
  fakeSshProcessHasExited,
} from '../../../../e2e/electron/fixtures/fake-ssh-boundary';
import {
  addRemoteSshForward,
  allocateRemoteSshForward,
  cancelRemoteSshForward,
} from './remote-ssh-connection-handoff';
import type { RemoteSshLocalForward } from './remote-ssh-local-forward';

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind TCP.');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function exchange(port: number, body: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(port, '127.0.0.1');
    const chunks: Buffer[] = [];
    let ended = false;
    socket.setTimeout(2_000, () => socket.destroy(new Error('Fixture TCP response timed out.')));
    socket.once('connect', () => socket.end(body));
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.once('error', reject);
    socket.once('end', () => {
      ended = true;
      resolve(Buffer.concat(chunks));
    });
    socket.once('close', () => {
      if (!ended) reject(new Error('Fixture TCP response closed early.'));
    });
  });
}

describe.runIf(process.platform !== 'win32')('app-owned SSH loopback listeners', () => {
  let root: string;
  let remote: Server;
  let master: ChildProcessWithoutNullStreams;
  let boundary: ReturnType<typeof createFakeSshBoundary>;
  let controlPath: string;
  let remotePort: number;
  const relays: RemoteSshLocalForward[] = [];
  const remoteSockets = new Set<Socket>();

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ssh-local-listener-'));
    boundary = createFakeSshBoundary(root);
    vi.stubEnv('DNAFORGE_FAKE_SSH_LOG', boundary.logPath);
    vi.stubEnv('DNAFORGE_FAKE_SSH_BRIDGE', boundary.bridgePath);
    vi.stubEnv('DNAFORGE_FAKE_SSH_FAIL_MARKER', boundary.failureMarkerPath);
    remote = createServer({ allowHalfOpen: true }, (socket) => {
      remoteSockets.add(socket);
      socket.once('close', () => remoteSockets.delete(socket));
      socket.on('error', () => undefined);
      const chunks: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.once('end', () =>
        socket.end(Buffer.concat([...chunks, Buffer.from(':response-tail')]))
      );
    });
    await new Promise<void>((resolve) => remote.listen(0, '127.0.0.1', resolve));
    const address = remote.address();
    if (!address || typeof address === 'string') throw new Error('Fixture did not bind TCP.');
    remotePort = address.port;
    controlPath = join(root, 'master');
    master = spawn(
      boundary.executablePath,
      [
        '-T',
        '-o',
        'BatchMode=yes',
        '-o',
        'ControlMaster=yes',
        '-S',
        controlPath,
        'fixture-hpc',
        'python3',
        '-u',
        '-',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    master.stderr.resume();
    master.stdin.end(
      'import time\nprint("FIXTURE_MASTER_READY", flush=True)\nwhile True: time.sleep(1)\n'
    );
    await once(master.stdout, 'data');
    master.stdout.resume();
  });

  afterEach(async () => {
    await Promise.all(relays.splice(0).map((input) => cancelRemoteSshForward(input)));
    if (master && master.exitCode === null && master.signalCode === null) {
      const exited = once(master, 'exit');
      master.kill('SIGTERM');
      await exited;
    }
    for (const socket of remoteSockets) socket.destroy();
    remoteSockets.clear();
    if (remote) await new Promise<void>((resolve) => remote.close(() => resolve()));
    vi.unstubAllEnvs();
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function input(
    overrides: Partial<RemoteSshLocalForward> = {}
  ): Promise<RemoteSshLocalForward> {
    const value = {
      sshPath: boundary.executablePath,
      target: 'fixture-hpc',
      controlPath,
      localPort: await unusedPort(),
      remotePort,
      ...overrides,
    };
    relays.push(value);
    return value;
  }

  it('preserves half-close and response tails through a real TCP stdio channel', async () => {
    const relay = await input();
    expect(await addRemoteSshForward(relay)).toBe(true);
    const body = Buffer.alloc(128 * 1024, 7);
    expect(await exchange(relay.localPort, body)).toEqual(
      Buffer.concat([body, Buffer.from(':response-tail')])
    );
    const commands = await readFile(boundary.logPath, 'utf8');
    expect(commands).toContain(` -W 127.0.0.1:${remotePort} `);
    expect(commands).toContain('ControlMaster=no');
    expect(commands).toContain('BatchMode=yes');
    expect(commands).toContain('ProxyCommand=false');
    expect(commands).not.toMatch(/ -O (forward|cancel) /u);
  });

  it('retains independent OS-assigned listeners on the same authenticated master', async () => {
    const destination = {
      sshPath: boundary.executablePath,
      target: 'fixture-hpc',
      controlPath,
      remotePort,
    };
    const first = await allocateRemoteSshForward(destination);
    const second = await allocateRemoteSshForward(destination);
    if (!first || !second) throw new Error('Fixture forwards did not bind TCP.');
    relays.push(first, second);
    expect(first.localPort).toBeGreaterThan(0);
    expect(second.localPort).not.toBe(first.localPort);
    expect(await exchange(first.localPort, Buffer.from('first'))).toEqual(
      Buffer.from('first:response-tail')
    );
    await cancelRemoteSshForward(first);
    expect(await exchange(second.localPort, Buffer.from('sibling'))).toEqual(
      Buffer.from('sibling:response-tail')
    );
    expect(master.exitCode).toBeNull();
    expect(master.signalCode).toBeNull();
  });

  it('reaps a cancelled partial HTTP range without closing its master or a live sibling', async () => {
    const advertisedBytes = 32 * 1024 * 1024;
    const chunk = Buffer.alloc(64 * 1024, 23);
    const siblingBody = Buffer.alloc(128 * 1024, 47);
    let cancelledRemoteSocket: Socket | undefined;
    let siblingRemoteSocket: Socket | undefined;
    let writtenBytes = 0;
    let releaseSibling: (() => void) | undefined;
    remote.removeAllListeners('connection');
    remote.on('connection', (socket: Socket) => {
      remoteSockets.add(socket);
      let timer: ReturnType<typeof setTimeout> | undefined;
      socket.on('error', () => undefined);
      socket.once('close', () => {
        if (timer) clearTimeout(timer);
        remoteSockets.delete(socket);
      });
      let head = '';
      const onRequest = (data: Buffer): void => {
        head += data.toString('ascii');
        if (!head.includes('\r\n\r\n')) return;
        socket.off('data', onRequest);
        if (head.startsWith('GET /sibling ')) {
          siblingRemoteSocket = socket;
          socket.write(
            `HTTP/1.1 200 OK\r\nContent-Length: ${siblingBody.length}\r\nConnection: close\r\n\r\n`
          );
          socket.write(siblingBody.subarray(0, chunk.length));
          releaseSibling = () => socket.end(siblingBody.subarray(chunk.length));
          return;
        }
        expect(head).toMatch(/^GET \/cancel HTTP\/1\.1\r\n/u);
        expect(head).toMatch(/\r\nRange: bytes=0-\r\n/iu);
        cancelledRemoteSocket = socket;
        socket.write(
          `HTTP/1.1 206 Partial Content\r\nContent-Length: ${advertisedBytes}\r\nContent-Range: bytes 0-${advertisedBytes - 1}/${advertisedBytes}\r\nConnection: close\r\n\r\n`
        );
        const writeBody = (): void => {
          if (socket.destroyed) return;
          writtenBytes += chunk.length;
          const ready = socket.write(chunk);
          if (writtenBytes === advertisedBytes) {
            socket.end();
            return;
          }
          const schedule = (): void => {
            timer = setTimeout(writeBody, 5);
          };
          if (ready) schedule();
          else socket.once('drain', schedule);
        };
        writeBody();
      };
      socket.on('data', onRequest);
    });
    const relay = await input();
    expect(await addRemoteSshForward(relay)).toBe(true);
    const requests: ClientRequest[] = [];
    const responses: IncomingMessage[] = [];
    const partialResponse = (path: string): Promise<{ response: IncomingMessage; first: Buffer }> =>
      new Promise((resolve, reject) => {
        const request = getHttp(
          `http://127.0.0.1:${relay.localPort}/${path}`,
          { agent: false, ...(path === 'cancel' ? { headers: { Range: 'bytes=0-' } } : {}) },
          (response) => {
            responses.push(response);
            response.on('error', () => undefined);
            response.once('data', (first: Buffer) => {
              response.pause();
              resolve({ response, first });
            });
          }
        );
        requests.push(request);
        request.on('error', reject);
      });
    const stdioPids = async (): Promise<number[]> => {
      const lines = (await readFile(boundary.logPath, 'utf8')).split(/\r?\n/u);
      return lines.flatMap((line, index) => {
        if (!line.includes(' -W ')) return [];
        const pid = Number(/^DNAFORGE_FAKE_SSH_PID (\d+)$/u.exec(lines[index + 1] ?? '')?.[1]);
        return Number.isSafeInteger(pid) && pid > 1 ? [pid] : [];
      });
    };
    try {
      const cancelled = await partialResponse('cancel');
      expect(cancelled.response.statusCode).toBe(206);
      expect(cancelled.response.headers['content-length']).toBe(String(advertisedBytes));
      expect(cancelled.first.length).toBeGreaterThan(0);
      const [cancelledPid] = await stdioPids();
      expect(cancelledPid).toBeGreaterThan(1);
      const sibling = await partialResponse('sibling');
      const pids = await stdioPids();
      expect(pids).toHaveLength(2);
      const siblingPid = pids.find((pid) => pid !== cancelledPid)!;
      expect(fakeSshProcessHasExited(siblingPid)).toBe(false);
      expect(siblingRemoteSocket?.destroyed).toBe(false);
      expect(writtenBytes).toBeLessThan(advertisedBytes);
      cancelled.response.destroy();
      requests[0]!.destroy();
      await expect
        .poll(() => fakeSshProcessHasExited(cancelledPid!), { timeout: 1_000 })
        .toBe(true);
      await expect.poll(() => cancelledRemoteSocket?.destroyed, { timeout: 1_000 }).toBe(true);
      expect(writtenBytes).toBeLessThan(advertisedBytes);
      expect(fakeSshProcessHasExited(master.pid!)).toBe(false);
      expect(fakeSshProcessHasExited(siblingPid)).toBe(false);
      expect(siblingRemoteSocket?.destroyed).toBe(false);
      const completedSibling = new Promise<Buffer>((resolve, reject) => {
        const chunks = [sibling.first];
        sibling.response.on('data', (data: Buffer) => chunks.push(data));
        sibling.response.once('end', () => resolve(Buffer.concat(chunks)));
        sibling.response.once('error', reject);
      });
      releaseSibling!();
      sibling.response.resume();
      expect(await completedSibling).toEqual(siblingBody);
      await expect.poll(() => fakeSshProcessHasExited(siblingPid), { timeout: 1_000 }).toBe(true);
      expect(fakeSshProcessHasExited(master.pid!)).toBe(false);
    } finally {
      for (const response of responses) response.destroy();
      for (const request of requests) request.destroy();
    }
  });

  it('reaps stopped stdio clients and closes the listener without stopping its master', async () => {
    const relay = await input();
    expect(await addRemoteSshForward(relay)).toBe(true);
    const client = createConnection(relay.localPort, '127.0.0.1');
    client.on('error', () => undefined);
    await once(client, 'connect');
    client.write('pending response');
    let stdioPid = 0;
    await expect
      .poll(async () => {
        const lines = (await readFile(boundary.logPath, 'utf8')).split(/\r?\n/u);
        const index = lines.findIndex((line) => line.includes(' -W '));
        stdioPid = Number(/^DNAFORGE_FAKE_SSH_PID (\d+)$/u.exec(lines[index + 1] ?? '')?.[1]);
        return stdioPid > 1;
      })
      .toBe(true);
    process.kill(stdioPid, 'SIGSTOP');
    await Promise.all([cancelRemoteSshForward(relay), cancelRemoteSshForward(relay)]);
    expect(fakeSshProcessHasExited(stdioPid)).toBe(true);
    expect(fakeSshProcessHasExited(master.pid!)).toBe(false);
    await expect(exchange(relay.localPort, Buffer.from('closed'))).rejects.toThrow();
    const next = await input();
    expect(await addRemoteSshForward(next)).toBe(true);
    expect((await exchange(next.localPort, Buffer.from('master retained'))).toString()).toBe(
      'master retained:response-tail'
    );
    client.destroy();
  });

  it('rejects a conflicting listener and ignores another destination when releasing ownership', async () => {
    const first = await input();
    const second = await input();
    expect(await addRemoteSshForward(first)).toBe(true);
    expect(await addRemoteSshForward(second)).toBe(true);
    const conflict = await input({ localPort: first.localPort, remotePort: remotePort + 1 });
    expect(await addRemoteSshForward(conflict)).toBe(false);
    await cancelRemoteSshForward(conflict);
    expect((await exchange(first.localPort, Buffer.from('first'))).toString()).toBe(
      'first:response-tail'
    );
    await cancelRemoteSshForward(first);
    await expect(exchange(first.localPort, Buffer.from('closed'))).rejects.toThrow();
    expect((await exchange(second.localPort, Buffer.from('second'))).toString()).toBe(
      'second:response-tail'
    );
    expect(fakeSshProcessHasExited(master.pid!)).toBe(false);
  });

  it('does not reopen authentication when the admitted master is missing', async () => {
    const relay = await input({ controlPath: join(root, 'missing-master') });
    expect(await addRemoteSshForward(relay)).toBe(true);
    expect(await exchange(relay.localPort, Buffer.from('no fallback'))).toHaveLength(0);
    expect(remoteSockets.size).toBe(0);
    const commands = await readFile(boundary.logPath, 'utf8');
    expect(
      commands.split(/\r?\n/u).filter((line) => line.endsWith('fixture-hpc python3 -u -'))
    ).toHaveLength(1);
    expect(commands).toContain(` -S ${relay.controlPath} -W `);
    expect(commands).toContain('ProxyCommand=false');
  });

  it('does not publish a listener for an already-cancelled request', async () => {
    const relay = await input();
    const controller = new AbortController();
    controller.abort();
    expect(await addRemoteSshForward(relay, controller.signal)).toBe(false);
    await expect(exchange(relay.localPort, Buffer.from('cancelled'))).rejects.toThrow();
  });

  it('closes a listener cancelled during binding and permits a subsequent owned retry', async () => {
    const relay = await input();
    const controller = new AbortController();
    const binding = addRemoteSshForward(relay, controller.signal);
    controller.abort();
    expect(await binding).toBe(false);
    await expect(exchange(relay.localPort, Buffer.from('cancelled'))).rejects.toThrow();
    expect(await addRemoteSshForward(relay)).toBe(true);
    expect((await exchange(relay.localPort, Buffer.from('retry'))).toString()).toBe(
      'retry:response-tail'
    );
  });
});
