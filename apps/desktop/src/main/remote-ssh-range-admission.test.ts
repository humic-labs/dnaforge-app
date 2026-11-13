// @vitest-environment node
import { createServer, type RequestListener, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { proveForwardedRange } from './remote-genomics-supervisor';

const servers = new Set<Server>();

async function serve(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a loopback TCP address.');
  return `http://127.0.0.1:${address.port}/v1/range-proof/alignment.bam`;
}

async function settledWithin<T>(work: Promise<T>, timeoutMs: number): Promise<T | 'deadline'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<'deadline'>((resolve) => {
        timer = setTimeout(() => resolve('deadline'), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
  servers.clear();
});

describe('SSH one-byte range admission', () => {
  it.each([false, true])(
    'accepts exactly one byte from the intended helper (chunked=%s)',
    async (chunked) => {
      let range: string | undefined;
      const url = await serve((request, response) => {
        range = request.headers.range;
        response.writeHead(206, {
          'accept-ranges': 'bytes',
          'content-range': 'bytes 0-0/19',
          ...(chunked ? {} : { 'content-length': '1' }),
        });
        if (chunked) response.write('x');
        response.end(chunked ? undefined : 'x');
      });
      await expect(proveForwardedRange(url, fetch)).resolves.toBeUndefined();
      expect(range).toBe('bytes=0-0');
    }
  );

  it('rejects a redirect before requesting a second local service', async () => {
    let secondServiceRequests = 0;
    const destination = await serve((_request, response) => {
      secondServiceRequests += 1;
      response.writeHead(206, {
        'accept-ranges': 'bytes',
        'content-range': 'bytes 0-0/19',
        'content-length': '1',
      });
      response.end('x');
    });
    const helper = await serve((_request, response) => {
      response.writeHead(302, { location: destination, 'content-length': '0' });
      response.end();
    });

    await expect(proveForwardedRange(helper, fetch)).rejects.toMatchObject({
      code: 'tunnel-failed',
    });
    expect(secondServiceRequests).toBe(0);
  });

  it.each([undefined, 'bytes 0-1/19', 'bytes 1-1/19', 'bytes 0-0/0', 'bytes 0-0/*'])(
    'rejects an incompatible Content-Range (%s)',
    async (contentRange) => {
      const url = await serve((_request, response) => {
        response.writeHead(206, {
          'accept-ranges': 'bytes',
          'content-length': '1',
          ...(contentRange === undefined ? {} : { 'content-range': contentRange }),
        });
        response.end('x');
      });
      await expect(proveForwardedRange(url, fetch)).rejects.toMatchObject({
        code: 'tunnel-failed',
      });
    }
  );

  it('rejects a declared oversized body instead of accepting an entire file', async () => {
    const url = await serve((_request, response) => {
      response.writeHead(206, {
        'accept-ranges': 'bytes',
        'content-range': 'bytes 0-0/1048576',
        'content-length': '1048576',
      });
      response.end(Buffer.alloc(1024 * 1024, 0x78));
    });
    await expect(proveForwardedRange(url, fetch)).rejects.toMatchObject({ code: 'tunnel-failed' });
  });

  it('rejects a chunked body containing more than one byte', async () => {
    const url = await serve((_request, response) => {
      response.writeHead(206, { 'accept-ranges': 'bytes', 'content-range': 'bytes 0-0/19' });
      response.write('xx');
      response.end();
    });
    await expect(proveForwardedRange(url, fetch)).rejects.toMatchObject({ code: 'tunnel-failed' });
  });

  it('rejects an empty chunked body', async () => {
    const url = await serve((_request, response) => {
      response.writeHead(206, {
        'accept-ranges': 'bytes',
        'content-range': 'bytes 0-0/19',
        'transfer-encoding': 'chunked',
      });
      response.end();
    });
    await expect(proveForwardedRange(url, fetch)).rejects.toMatchObject({ code: 'tunnel-failed' });
  });

  it('cancels an oversized streaming body without waiting for its end', async () => {
    let closed!: () => void;
    const connectionClosed = new Promise<'closed'>((resolve) => {
      closed = () => resolve('closed');
    });
    const url = await serve((request, response) => {
      request.socket.once('close', closed);
      response.writeHead(206, { 'accept-ranges': 'bytes', 'content-range': 'bytes 0-0/19' });
      response.write('xx');
    });
    const controller = new AbortController();
    const rejected = proveForwardedRange(url, fetch, controller.signal).then(
      () => 'accepted' as const,
      () => 'rejected' as const
    );
    try {
      expect(await settledWithin(rejected, 750)).toBe('rejected');
      expect(await settledWithin(connectionClosed, 750)).toBe('closed');
    } finally {
      controller.abort();
      await rejected;
    }
  });

  it('cancels a rejected response body instead of leaving its connection open', async () => {
    let closed!: () => void;
    const connectionClosed = new Promise<'closed'>((resolve) => {
      closed = () => resolve('closed');
    });
    const url = await serve((request, response) => {
      request.socket.once('close', closed);
      response.writeHead(200, { 'accept-ranges': 'bytes', 'content-range': 'bytes 0-0/19' });
      response.write('x');
    });
    await expect(proveForwardedRange(url, fetch)).rejects.toMatchObject({ code: 'tunnel-failed' });
    expect(await settledWithin(connectionClosed, 750)).toBe('closed');
  });

  it('still aborts an unfinished valid response with its owning request', async () => {
    let firstByte!: () => void;
    const started = new Promise<void>((resolve) => {
      firstByte = resolve;
    });
    const url = await serve((_request, response) => {
      response.writeHead(206, { 'accept-ranges': 'bytes', 'content-range': 'bytes 0-0/19' });
      response.write('x');
      firstByte();
    });
    const controller = new AbortController();
    const rejected = expect(
      proveForwardedRange(url, fetch, controller.signal)
    ).rejects.toMatchObject({ code: 'tunnel-failed' });
    await started;
    controller.abort();
    await rejected;
  });
});
