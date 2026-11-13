// @vitest-environment node

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  createServer,
  get,
  type ClientRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RemoteAlignmentMaterializationV1 } from '../shared/remote-genomics-ipc';
import {
  RemoteGenomicsRuntime,
  type RemoteGenomicsTransportProvider,
} from './remote-genomics-runtime';

const REQUEST_TIMEOUT_MS = 300;
const STREAM_SIZE = 32 * 1024 * 1024;
const CHUNK = Buffer.alloc(64 * 1024, 0xa5);
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

describe('remote gateway reader lifetime over real TCP', () => {
  it('preserves a healthy sibling and helper when one range channel goes idle', async () => {
    const fixture = await streamingFixture({ physicalDisconnect: true, slowSibling: true });
    await fixture.requireHealthyHead();
    const sibling = await fixture.openReader('bytes=1048576-3145727');
    const siblingBytes = readBytes(sibling);
    const idle = await fixture.openReader('bytes=123-456');
    const idleBytes = readBytes(idle).catch(() => -1);

    expect(await siblingBytes).toBe(2 * 1024 * 1024);
    expect(await idleBytes).toBe(-1);
    expect(fixture.disconnect).not.toHaveBeenCalled();
    expect(fixture.connect).toHaveBeenCalledOnce();
    expect(fixture.rangeProofCount()).toBe(1);
    expect(fixture.runtime.listStatuses()[0]).toMatchObject({
      state: 'online',
      transportGeneration: 1,
    });
    await fixture.requireFreshRange();
  });

  it('uses its existing retry before headers without replacing a byte-readable helper', async () => {
    const fixture = await streamingFixture({ idleBeforeHeaders: 'once' });
    const reader = await fixture.openReader('bytes=0-15');
    expect(reader.statusCode).toBe(206);
    expect(await readBytes(reader)).toBe(16);
    expect(fixture.preHeaderRequestCount()).toBe(2);
    expect(fixture.rangeProofCount()).toBe(1);
    expect(fixture.connect).toHaveBeenCalledOnce();
    expect(fixture.disconnect).not.toHaveBeenCalled();
  });

  it('ends an isolated failed request after the existing retry budget is exhausted', async () => {
    const fixture = await streamingFixture({ idleBeforeHeaders: 'always' });
    const reader = await fixture.openReader('bytes=0-15');
    expect(reader.statusCode).toBe(503);
    await readBytes(reader);
    expect(fixture.preHeaderRequestCount()).toBe(2);
    expect(fixture.rangeProofCount()).toBe(2);
    expect(fixture.connect).toHaveBeenCalledOnce();
    expect(fixture.disconnect).not.toHaveBeenCalled();
    expect(fixture.runtime.listStatuses()[0]?.transportGeneration).toBe(1);
  });

  it('still retires when HEAD is healthy but its one-byte range proof is invalid', async () => {
    const fixture = await streamingFixture({ rangeProof: 'invalid', physicalDisconnect: true });
    await fixture.requireHealthyHead();
    const idle = await fixture.openReader('bytes=123-456');
    const consumed = readBytes(idle).catch(() => -1);
    await expect.poll(() => fixture.disconnect.mock.calls.length).toBe(1);
    expect(fixture.rangeProofCount()).toBe(1);
    expect(await consumed).toBe(-1);
    await expect.poll(() => fixture.runtime.listStatuses()[0]?.transportGeneration).toBe(2);
  });

  it('blocks a current source changed during the channel confirmation', async () => {
    const fixture = await streamingFixture({ rangeProof: 'held', physicalDisconnect: true });
    const idle = await fixture.openReader('bytes=123-456');
    const consumed = readBytes(idle).catch(() => -1);
    await expect.poll(() => fixture.rangeProofCount()).toBe(1);
    fixture.releaseRangeProof(412);
    await expect.poll(() => fixture.runtime.listStatuses()[0]?.state).toBe('blocked');
    expect(fixture.runtime.listStatuses()[0]?.lastFailure?.code).toBe('source-changed');
    expect(fixture.disconnect).toHaveBeenCalledOnce();
    expect(await consumed).toBe(-1);
  });

  it('does not retire a replacement after a stale channel confirmation fails', async () => {
    const fixture = await streamingFixture({ rangeProof: 'held' });
    const idle = await fixture.openReader('bytes=123-456');
    const consumed = readBytes(idle).catch(() => -1);
    await expect.poll(() => fixture.rangeProofCount()).toBe(1);
    fixture.closeServingSession();
    await expect.poll(() => fixture.runtime.listStatuses()[0]?.transportGeneration).toBe(2);
    fixture.releaseRangeProof(503);
    expect(await consumed).toBe(-1);
    expect(fixture.disconnect).not.toHaveBeenCalled();
    expect(fixture.connect).toHaveBeenCalledTimes(2);
    expect(fixture.runtime.listStatuses()[0]?.state).toBe('online');
  });

  it('cancels a channel confirmation when the downstream reader closes', async () => {
    const fixture = await streamingFixture({ rangeProof: 'held', physicalDisconnect: true });
    const idle = await fixture.openReader('bytes=123-456');
    idle.resume();
    await expect.poll(() => fixture.rangeProofCount()).toBe(1);
    idle.destroy();
    await delay(REQUEST_TIMEOUT_MS * 2);
    expect(fixture.disconnect).not.toHaveBeenCalled();
    expect(fixture.connect).toHaveBeenCalledOnce();
    expect(fixture.runtime.listStatuses()[0]?.state).toBe('online');
    await fixture.requireFreshRange();
  });

  it('does not revive a stopped source when its channel confirmation completes late', async () => {
    const fixture = await streamingFixture({ rangeProof: 'held', physicalDisconnect: true });
    const idle = await fixture.openReader('bytes=123-456');
    const consumed = readBytes(idle).catch(() => -1);
    await expect.poll(() => fixture.rangeProofCount()).toBe(1);
    await fixture.runtime.stopAll();
    fixture.releaseRangeProof(503);
    await consumed;
    expect(fixture.runtime.listStatuses()).toEqual([]);
    expect(fixture.connect).toHaveBeenCalledOnce();
    expect(fixture.disconnect).toHaveBeenCalledOnce();
  });

  it('does not retire an active paused reader because a background health check is unavailable', async () => {
    const fixture = await streamingFixture({ holdHealthChecks: true });
    const reader = await fixture.openReader('bytes=0-');
    await fixture.waitForBackpressure();
    await delay(REQUEST_TIMEOUT_MS * 2);
    expect(fixture.disconnect).not.toHaveBeenCalled();
    expect(fixture.runtime.listStatuses()[0]).toMatchObject({
      state: 'online',
      transportGeneration: 1,
    });
    expect(await readBytes(reader)).toBe(STREAM_SIZE);
  });

  it('does not let a health probe started while idle retire a subsequently active reader', async () => {
    const fixture = await streamingFixture({ holdHealthChecks: true });
    await expect.poll(() => fixture.healthRequestCount()).toBeGreaterThan(0);
    const reader = await fixture.openReader('bytes=0-');
    await fixture.waitForBackpressure();
    await delay(REQUEST_TIMEOUT_MS * 2);
    expect(fixture.disconnect).not.toHaveBeenCalled();
    expect(await readBytes(reader)).toBe(STREAM_SIZE);
  });

  it('still retires an idle source after its health probe fails', async () => {
    const fixture = await streamingFixture({ holdHealthChecks: true });
    await expect.poll(() => fixture.disconnect.mock.calls.length).toBeGreaterThan(0);
    await expect
      .poll(() => fixture.runtime.listStatuses()[0]?.transportGeneration)
      .toBeGreaterThan(1);
  });

  it('still blocks a changed source reported by an earlier probe while a reader is active', async () => {
    const fixture = await streamingFixture({ holdHealthChecks: true });
    await expect.poll(() => fixture.healthRequestCount()).toBeGreaterThan(0);
    const reader = await fixture.openReader('bytes=0-');
    await fixture.waitForBackpressure();
    fixture.reportChangedSource();
    await expect.poll(() => fixture.runtime.listStatuses()[0]?.state).toBe('blocked');
    expect(fixture.runtime.listStatuses()[0]?.lastFailure?.code).toBe('source-changed');
    expect(fixture.disconnect).toHaveBeenCalledOnce();
    reader.destroy();
  });

  it('keeps the serving generation when a reader pauses, then resumes its body', async () => {
    const fixture = await streamingFixture();
    const reader = await fixture.openReader('bytes=0-');
    expect(reader.statusCode).toBe(206);

    await fixture.waitForBackpressure();
    const writtenWhilePaused = fixture.transfers[0]!.bytesQueued;
    await delay(REQUEST_TIMEOUT_MS * 2);

    expect(
      fixture.connect,
      JSON.stringify({
        readerFlowing: reader.readableFlowing,
        upstreamBytesQueued: writtenWhilePaused,
        upstreamComplete: fixture.transfers[0]!.bytesQueued === STREAM_SIZE,
        statuses: fixture.runtime.listStatuses(),
      })
    ).toHaveBeenCalledOnce();
    expect(fixture.disconnect).not.toHaveBeenCalled();
    expect(fixture.runtime.listStatuses()[0]).toMatchObject({
      state: 'online',
      transportGeneration: 1,
    });
    expect(writtenWhilePaused).toBeLessThan(STREAM_SIZE);
    await fixture.requireFreshRange();
    expect(await readBytes(reader)).toBe(STREAM_SIZE);
    expect(fixture.connect).toHaveBeenCalledOnce();
    await fixture.requireFreshRange();
  });

  it('rearms upstream inactivity recovery when a paused reader resumes into a real stall', async () => {
    const fixture = await streamingFixture({
      stallAfterBytes: 16 * 1024 * 1024,
      rangeProof: 'hung',
    });
    const reader = await fixture.openReader('bytes=0-');
    await fixture.waitForBackpressure();
    await delay(REQUEST_TIMEOUT_MS * 2);
    expect(fixture.connect).toHaveBeenCalledOnce();
    expect(fixture.disconnect).not.toHaveBeenCalled();

    const consumed = readBytes(reader).catch(() => -1);
    await expect.poll(() => fixture.disconnect.mock.calls.length).toBe(1);
    await expect.poll(() => fixture.runtime.listStatuses()[0]?.transportGeneration).toBe(2);
    expect(fixture.transfers[0]!.bytesQueued).toBe(16 * 1024 * 1024);
    expect(await consumed).toBe(-1);
    await fixture.requireFreshRange();
  });

  it('still replaces a genuinely broken upstream when its paused reader resumes', async () => {
    const fixture = await streamingFixture({ rangeProof: 'hung' });
    const reader = await fixture.openReader('bytes=0-');
    await fixture.waitForBackpressure();
    fixture.destroyUpstream();
    const consumed = readBytes(reader).catch(() => -1);

    await expect.poll(() => fixture.disconnect.mock.calls.length).toBe(1);
    await expect.poll(() => fixture.runtime.listStatuses()[0]?.transportGeneration).toBe(2);
    expect(fixture.connect).toHaveBeenCalledTimes(2);
    expect(await consumed).toBe(-1);
    await fixture.requireFreshRange();
  });

  it('keeps a healthy generation when a reader closes its partial body without an abort signal', async () => {
    const fixture = await streamingFixture();
    const reader = await fixture.openReader('bytes=0-');
    expect(reader.statusCode).toBe(206);
    reader.destroy();

    await delay(REQUEST_TIMEOUT_MS * 2);
    expect(fixture.connect).toHaveBeenCalledOnce();
    expect(fixture.disconnect).not.toHaveBeenCalled();
    expect(fixture.runtime.listStatuses()[0]).toMatchObject({
      state: 'online',
      transportGeneration: 1,
    });
    await fixture.requireFreshRange();
  });

  it('keeps a healthy generation when a reader opens a seek range before closing its old body', async () => {
    const fixture = await streamingFixture();
    const previous = await fixture.openReader('bytes=0-');
    const sought = await fixture.openReader('bytes=1048576-1048591');
    expect(sought.statusCode).toBe(206);
    expect(sought.headers['content-range']).toBe(`bytes 1048576-1048591/${STREAM_SIZE}`);
    expect(await readBytes(sought)).toBe(16);
    previous.destroy();

    await delay(REQUEST_TIMEOUT_MS * 2);
    expect(fixture.connect).toHaveBeenCalledOnce();
    expect(fixture.disconnect).not.toHaveBeenCalled();
    expect(fixture.runtime.listStatuses()[0]).toMatchObject({
      state: 'online',
      transportGeneration: 1,
    });
    await fixture.requireFreshRange();
  });

  it('still replaces a genuinely stalled upstream while its reader is consuming', async () => {
    const fixture = await streamingFixture({ rangeProof: 'hung' });
    const reader = await fixture.openReader('bytes=123-456');
    const consumed = readBytes(reader).catch(() => -1);

    await expect.poll(() => fixture.disconnect.mock.calls.length).toBe(1);
    await expect.poll(() => fixture.runtime.listStatuses()[0]?.transportGeneration).toBe(2);
    expect(await consumed).toBe(-1);
    expect(fixture.connect).toHaveBeenCalledTimes(2);
    await fixture.requireFreshRange();
  });

  it('still replaces an upstream that closes before its advertised range is complete', async () => {
    const fixture = await streamingFixture({ rangeProof: 'hung' });
    const reader = await fixture.openReader('bytes=789-999');
    const consumed = readBytes(reader).catch(() => -1);

    await expect.poll(() => fixture.disconnect.mock.calls.length).toBe(1);
    await expect.poll(() => fixture.runtime.listStatuses()[0]?.transportGeneration).toBe(2);
    expect(await consumed).toBe(-1);
    expect(fixture.connect).toHaveBeenCalledTimes(2);
    await fixture.requireFreshRange();
  });
});

async function streamingFixture(
  options: {
    readonly stallAfterBytes?: number;
    readonly holdHealthChecks?: boolean;
    readonly rangeProof?: 'hung' | 'invalid' | 'held';
    readonly physicalDisconnect?: boolean;
    readonly slowSibling?: boolean;
    readonly idleBeforeHeaders?: 'once' | 'always';
  } = {}
) {
  let healthRequests = 0;
  let rangeProofRequests = 0;
  let preHeaderRequests = 0;
  const heldHealthResponses: ServerResponse[] = [];
  const heldRangeProofs: ServerResponse[] = [];
  const responses = new Set<ServerResponse>();
  const transfers: Array<{ range: string | undefined; bytesQueued: number; closed: boolean }> = [];
  let destroyUpstream = (): void => undefined;
  const server = createServer((request, response) => {
    responses.add(response);
    response.on('close', () => responses.delete(response));
    if (request.headers.range === 'bytes=0-15' && options.idleBeforeHeaders) {
      preHeaderRequests += 1;
      if (options.idleBeforeHeaders === 'always' || preHeaderRequests === 1) return;
    }
    if (request.headers.range === 'bytes=0-0') {
      rangeProofRequests += 1;
      if (options.rangeProof === 'held') {
        heldRangeProofs.push(response);
        return;
      }
      if (options.rangeProof === 'hung') return;
      if (options.rangeProof === 'invalid') {
        response.writeHead(206, { 'content-length': 1 }).end(CHUNK.subarray(0, 1));
        return;
      }
    }
    if (request.method === 'HEAD' && options.holdHealthChecks) {
      healthRequests += 1;
      heldHealthResponses.push(response);
      return;
    }
    const range = request.headers.range;
    const match = /^bytes=(\d+)-(\d*)$/u.exec(range ?? '');
    const start = Number(match?.[1] ?? 0);
    const end = match?.[2] ? Number(match[2]) : STREAM_SIZE - 1;
    const length = end - start + 1;
    response.writeHead(range ? 206 : 200, {
      'accept-ranges': 'bytes',
      'content-type': 'application/octet-stream',
      'content-length': length,
      ...(range ? { 'content-range': `bytes ${start}-${end}/${STREAM_SIZE}` } : {}),
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    const transfer = { range, bytesQueued: 0, closed: false };
    transfers.push(transfer);
    if (transfers.length === 1) destroyUpstream = () => response.destroy();
    response.on('close', () => {
      transfer.closed = true;
    });
    if (range === 'bytes=123-456' || range === 'bytes=789-999') {
      response.write(CHUNK.subarray(0, 1));
      transfer.bytesQueued = 1;
      if (range === 'bytes=789-999') setTimeout(() => response.destroy(), 20);
      return;
    }
    if (options.slowSibling && range === 'bytes=1048576-3145727') {
      const timer = setInterval(() => {
        if (response.destroyed) return;
        const chunk = CHUNK.subarray(0, Math.min(CHUNK.length, length - transfer.bytesQueued));
        transfer.bytesQueued += chunk.length;
        response.write(chunk);
        if (transfer.bytesQueued === length) response.end();
      }, 20);
      response.once('close', () => clearInterval(timer));
      return;
    }
    const write = (): void => {
      while (!response.destroyed && transfer.bytesQueued < length) {
        if (
          range === 'bytes=0-' &&
          options.stallAfterBytes !== undefined &&
          transfer.bytesQueued >= options.stallAfterBytes
        ) {
          return;
        }
        const chunk = CHUNK.subarray(0, Math.min(CHUNK.length, length - transfer.bytesQueued));
        transfer.bytesQueued += chunk.length;
        if (!response.write(chunk)) {
          response.once('drain', write);
          return;
        }
      }
      if (!response.destroyed) response.end();
    };
    write();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The fixture did not bind TCP.');
  const root = await mkdtemp(join(tmpdir(), 'remote-runtime-reader-'));
  const indexPath = join(root, 'sample.cram.crai');
  await writeFile(indexPath, 'owned fixture index');
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const materialization: RemoteAlignmentMaterializationV1 = {
    protocol: 'dnaforge-remote-range.v1',
    sessionId: 'reader-transport-1',
    endpoint: {
      endpointId: 'reader-endpoint',
      target: 'fixture',
      displayName: 'fixture',
      lastConnectedAt: 1,
      observedPlatform: 'local-node',
      lastFailure: null,
    },
    locator: {
      contract: 'remote-alignment-locator.v1',
      endpointId: 'reader-endpoint',
      target: 'fixture',
      alignmentPath: '/fixture/sample.cram',
      indexPath: '/fixture/sample.cram.crai',
    },
    bamUrl: `http://127.0.0.1:${address.port}/alignment.cram`,
    indexPath,
    generation: {
      alignment: receipt('/fixture/sample.cram', STREAM_SIZE),
      index: receipt('/fixture/sample.cram.crai', 19),
    },
  };
  let generation = 0;
  const connect = vi.fn<RemoteGenomicsTransportProvider['connect']>(async () => ({
    ...materialization,
    sessionId: `reader-transport-${++generation}`,
  }));
  const sessionListeners = new Map<string, () => void>();
  const disconnect = vi.fn<RemoteGenomicsTransportProvider['disconnect']>(async () => {
    if (options.physicalDisconnect) {
      for (const response of responses) response.destroy();
    }
    return true;
  });
  const runtime = new RemoteGenomicsRuntime(
    {
      connect,
      disconnect,
      subscribeSession: (sessionId, listener) => {
        sessionListeners.set(sessionId, listener);
        return () => sessionListeners.delete(sessionId);
      },
    },
    {
      retryDelaysMs: [0],
      retryJitterRatio: 0,
      upstreamRequestTimeoutMs: REQUEST_TIMEOUT_MS,
      healthCheckIntervalMs: options.holdHealthChecks ? 50 : 0,
      healthCheckTimeoutMs: options.holdHealthChecks ? 200 : undefined,
    }
  );
  cleanup.push(() => runtime.stopAll());
  const lease = await runtime.connect({ ...materialization.locator });
  const readers: ClientRequest[] = [];
  cleanup.push(async () => {
    for (const request of readers) request.destroy();
  });

  const openReader = (range: string): Promise<IncomingMessage> =>
    new Promise((resolve, reject) => {
      const headers = {
        Range: range,
        ...(options.holdHealthChecks ? { 'If-Range': '"fixture-conditional-reader"' } : {}),
      };
      const request = get(lease.bamUrl, { headers, agent: false }, (response) => {
        response.on('error', () => undefined);
        response.pause();
        resolve(response);
      });
      readers.push(request);
      request.on('error', reject);
    });
  return {
    runtime,
    connect,
    disconnect,
    transfers,
    rangeProofCount: () => rangeProofRequests,
    preHeaderRequestCount: () => preHeaderRequests,
    releaseRangeProof: (status: number) => {
      for (const response of heldRangeProofs) {
        if (!response.destroyed) response.writeHead(status).end();
      }
    },
    closeServingSession: () => sessionListeners.get(`reader-transport-${generation}`)?.(),
    requireHealthyHead: async () => {
      await new Promise<void>((resolve, reject) => {
        const request = get(lease.bamUrl, { method: 'HEAD', agent: false }, (response) => {
          expect(response.statusCode).toBe(200);
          response.resume();
          response.once('end', resolve);
        });
        readers.push(request);
        request.once('error', reject);
      });
    },
    healthRequestCount: () => healthRequests,
    reportChangedSource: () => {
      for (const response of heldHealthResponses) {
        if (!response.destroyed) response.writeHead(412).end();
      }
    },
    destroyUpstream: () => destroyUpstream(),
    openReader,
    waitForBackpressure: async (): Promise<void> => {
      let previous = -1;
      await expect
        .poll(
          () => {
            const written = transfers[0]?.bytesQueued ?? 0;
            const unchanged = written === previous;
            previous = written;
            return unchanged && written > 0 && written < STREAM_SIZE;
          },
          { interval: 25, timeout: REQUEST_TIMEOUT_MS - 50 }
        )
        .toBe(true);
    },
    requireFreshRange: async (): Promise<void> => {
      const response = await openReader('bytes=0-15');
      expect(response.statusCode).toBe(206);
      expect(await readBytes(response)).toBe(16);
    },
  };
}

function receipt(canonicalPath: string, size: number) {
  return { canonicalPath, size, mtimeNs: '1', ctimeNs: '1', device: '1', inode: '1' };
}

async function readBytes(response: IncomingMessage): Promise<number> {
  let bytes = 0;
  for await (const chunk of response) bytes += Buffer.byteLength(chunk);
  return bytes;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
