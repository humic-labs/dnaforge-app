import { connect, createServer, type Socket } from 'node:net';

export async function createWslTcpBridge(
  localPort: number,
  guestAddress: string,
  guestPort: number
) {
  const sockets = new Set<Socket>();
  let closing = false;
  let closed: Promise<void> | null = null;
  const server = createServer({ pauseOnConnect: true, allowHalfOpen: true }, (client) => {
    if (closing) return client.destroy();
    const startedAt = Date.now();
    let connected = false;
    let failureCode: string | null = null;
    const upstream = connect({ host: guestAddress, port: guestPort, allowHalfOpen: true });
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    }
    const stop = () => {
      client.destroy();
      upstream.destroy();
    };
    client.once('error', stop);
    upstream.once('error', (error: NodeJS.ErrnoException) => {
      failureCode = error.code ?? null;
      stop();
    });
    client.once('close', () => {
      if (client.bytesRead > 0 && upstream.bytesRead === 0) {
        console.warn('[remote-ssh-wsl-tcp] closed before first response', {
          connected,
          elapsedMs: Date.now() - startedAt,
          requestBytes: client.bytesRead,
          forwardedBytes: upstream.bytesWritten,
          responseBytes: upstream.bytesRead,
          failureCode,
          closing,
        });
      }
      upstream.destroy();
    });
    upstream.setTimeout(5_000, stop);
    upstream.once('connect', () => {
      connected = true;
      upstream.setTimeout(0);
      if (closing || client.destroyed) return stop();
      client.pipe(upstream);
      upstream.pipe(client);
    });
  });
  server.on('error', () => {
    for (const socket of sockets) socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => reject(error);
    server.once('error', failed);
    server.listen(localPort, '127.0.0.1', () => {
      server.off('error', failed);
      resolve();
    });
  });
  return {
    close(): Promise<void> {
      return (closed ??= new Promise<void>((resolve, reject) => {
        closing = true;
        for (const socket of sockets) socket.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      }));
    },
  };
}
