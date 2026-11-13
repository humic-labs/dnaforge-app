import { connect, createServer, type Socket, type Server } from 'node:net';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createWslTcpBridge } from './remote-ssh-wsl-tcp-bridge';

async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP port.');
  return address.port;
}
async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('Windows-owned WSL TCP bridge', () => {
  it('preserves a half-closed request and a large delayed response tail over real TCP', async () => {
    const payload = Buffer.alloc(2 * 1024 * 1024, 73);
    const upstream = createServer({ allowHalfOpen: true }, (socket) => {
      socket.resume();
      socket.once('end', () => socket.end(payload));
    });
    const guestPort = await listen(upstream);
    const port = await freePort();
    const bridge = await createWslTcpBridge(port, '127.0.0.1', guestPort);
    try {
      const socket = connect(port, '127.0.0.1');
      const chunks: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.end('request');
      await once(socket, 'end');
      expect(Buffer.concat(chunks).equals(payload)).toBe(true);
    } finally {
      await bridge.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it('cancels a client without closing a live sibling, then retires only its own listener', async () => {
    const accepted = new Set<Socket>();
    const upstream = createServer((socket) => {
      accepted.add(socket);
      socket.once('close', () => accepted.delete(socket));
      socket.pipe(socket);
    });
    const guestPort = await listen(upstream);
    const port = await freePort();
    const bridge = await createWslTcpBridge(port, '127.0.0.1', guestPort);
    const first = connect(port, '127.0.0.1');
    const second = connect(port, '127.0.0.1');
    try {
      await Promise.all([once(first, 'connect'), once(second, 'connect')]);
      first.destroy();
      const reply = once(second, 'data');
      second.write('still live');
      expect((await reply)[0].toString()).toBe('still live');
      const closed = once(second, 'close');
      await bridge.close();
      await closed;
      await bridge.close();
      const rejected = connect(port, '127.0.0.1');
      expect((await once(rejected, 'error'))[0].code).toBe('ECONNREFUSED');
    } finally {
      first.destroy();
      second.destroy();
      await bridge.close();
      for (const socket of accepted) socket.destroy();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});
