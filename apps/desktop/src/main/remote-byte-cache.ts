import {
  request as requestHttp,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

import type { RemoteFileReceiptV1 } from '../shared/remote-genomics-ipc';
import { RemoteGenomicsError, REMOTE_SOURCE_CHANGED_MESSAGE } from './remote-genomics-supervisor';

const BLOCK_BYTES = 64 * 1024;
const CACHE_BYTES = 32 * 1024 * 1024;
const ACTIVE_FETCHES = 4;
const PENDING_FETCHES = 32;

type BlockLoader = (signal: AbortSignal) => Promise<Buffer>;
interface BlockJob {
  readonly key: string;
  readonly load: BlockLoader;
  readonly controller: AbortController;
  readonly promise: Promise<Buffer>;
  readonly resolve: (buffer: Buffer) => void;
  readonly reject: (error: unknown) => void;
  readers: number;
  active: boolean;
}

export class RemoteByteReadCancelled extends Error {
  constructor() {
    super('The remote byte reader was cancelled.');
  }
}

export class RemoteByteCache {
  private readonly cache = new Map<string, Buffer>();
  private readonly jobs = new Map<string, BlockJob>();
  private readonly queue: BlockJob[] = [];
  private bytes = 0;
  private active = 0;

  constructor(
    private readonly limitBytes = CACHE_BYTES,
    private readonly maxActive = ACTIVE_FETCHES,
    private readonly maxPending = PENDING_FETCHES
  ) {}

  get(key: string, load: BlockLoader, signal: AbortSignal): Promise<Buffer> {
    if (signal.aborted) return Promise.reject(new RemoteByteReadCancelled());
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return Promise.resolve(cached);
    }
    let job = this.jobs.get(key);
    if (!job) {
      if (this.active + this.queue.length >= this.maxPending) {
        return Promise.reject(new Error('The remote byte fetch queue is full.'));
      }
      let resolve!: BlockJob['resolve'];
      let reject!: BlockJob['reject'];
      const promise = new Promise<Buffer>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      job = {
        key,
        load,
        promise,
        resolve,
        reject,
        controller: new AbortController(),
        readers: 0,
        active: false,
      };
      void promise.catch(() => undefined);
      this.jobs.set(key, job);
      this.queue.push(job);
    }
    const subscribedJob = job;
    subscribedJob.readers += 1;
    const result = new Promise<Buffer>((resolve, reject) => {
      let settled = false;
      const finish = (error: unknown, buffer?: Buffer): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', cancel);
        subscribedJob.readers -= 1;
        if (error !== undefined) reject(error);
        else resolve(buffer!);
        if (!subscribedJob.readers) this.cancel(subscribedJob);
      };
      const cancel = (): void => finish(new RemoteByteReadCancelled());
      signal.addEventListener('abort', cancel, { once: true });
      void subscribedJob.promise.then(
        (buffer) => finish(undefined, buffer),
        (error) => finish(error)
      );
      if (signal.aborted) cancel();
    });
    this.pump();
    return result;
  }

  async invalidateSource(sourceId: string): Promise<void> {
    const prefix = `${sourceId}:`;
    for (const [key, buffer] of this.cache) {
      if (!key.startsWith(prefix)) continue;
      this.cache.delete(key);
      this.bytes -= buffer.length;
    }
    const pending: Promise<Buffer>[] = [];
    for (const job of this.jobs.values()) {
      if (!job.key.startsWith(prefix)) continue;
      pending.push(job.promise);
      this.cancel(job);
    }
    await Promise.allSettled(pending);
  }

  private cancel(job: BlockJob): void {
    if (this.jobs.get(job.key) !== job) return;
    this.jobs.delete(job.key);
    job.controller.abort();
    if (!job.active) {
      const index = this.queue.indexOf(job);
      if (index >= 0) this.queue.splice(index, 1);
      job.reject(new RemoteByteReadCancelled());
    }
  }

  private pump(): void {
    while (this.active < this.maxActive && this.queue.length) {
      const job = this.queue.shift()!;
      job.active = true;
      this.active += 1;
      void job
        .load(job.controller.signal)
        .then((buffer) => {
          if (job.controller.signal.aborted) throw new RemoteByteReadCancelled();
          if (buffer.length <= this.limitBytes) {
            while (this.bytes + buffer.length > this.limitBytes && this.cache.size) {
              const key = this.cache.keys().next().value!;
              this.bytes -= this.cache.get(key)!.length;
              this.cache.delete(key);
            }
            this.cache.set(job.key, buffer);
            this.bytes += buffer.length;
          }
          job.resolve(buffer);
        })
        .catch((error: unknown) => job.reject(error))
        .finally(() => {
          if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
          this.active -= 1;
          this.pump();
        });
    }
  }
}

export async function serveRemoteByteRange(input: {
  readonly incoming: IncomingMessage;
  readonly outgoing: ServerResponse;
  readonly upstreamUrl: string;
  readonly receipt: RemoteFileReceiptV1;
  readonly namespace: string;
  readonly cache: RemoteByteCache;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
}): Promise<boolean> {
  const { incoming, outgoing, upstreamUrl, receipt, namespace, cache, timeoutMs, signal } = input;
  if (
    incoming.method !== 'GET' ||
    ['if-range', 'if-none-match', 'if-modified-since'].some(
      (key) => incoming.headers[key] !== undefined
    )
  )
    return false;
  const metadata = await readUpstream(upstreamUrl, 'HEAD', undefined, timeoutMs, signal);
  const assertCurrent = (): void => {
    if (!input.isCurrent()) throw new Error('The SSH byte transport was replaced.');
  };
  assertCurrent();
  const etag = metadata.headers.etag;
  if (metadata.status !== 200 || typeof etag !== 'string' || !/^"[^"\r\n]+"$/u.test(etag))
    return false;
  if (
    Number(metadata.headers['content-length']) !== receipt.size ||
    (receipt.inode !== null && etag !== expectedEtag(receipt))
  ) {
    throw new RemoteGenomicsError('source-changed', REMOTE_SOURCE_CHANGED_MESSAGE);
  }
  const range = selectRange(incoming.headers.range, receipt.size);
  const headers: Record<string, string | number> = {
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'content-type': 'application/octet-stream',
    'access-control-allow-origin': '*',
    'cross-origin-resource-policy': 'cross-origin',
    etag,
    'content-length': Math.max(0, range.end - range.start + 1),
  };
  if (typeof metadata.headers['last-modified'] === 'string')
    headers['last-modified'] = metadata.headers['last-modified'];
  if (range.status === 206)
    headers['content-range'] = `bytes ${range.start}-${range.end}/${receipt.size}`;
  if (range.status === 416) {
    headers['content-range'] = `bytes */${receipt.size}`;
    headers['content-length'] = 0;
    outgoing.writeHead(416, headers).end();
    return true;
  }
  for (let position = range.start; position <= range.end; ) {
    assertCurrent();
    if (signal.aborted) throw new RemoteByteReadCancelled();
    const block = Math.floor(position / BLOCK_BYTES);
    const start = block * BLOCK_BYTES;
    const end = Math.min(start + BLOCK_BYTES, receipt.size) - 1;
    const buffer = await cache.get(
      `${namespace}:${block}`,
      async (fetchSignal) => {
        assertCurrent();
        const result = await readUpstream(
          upstreamUrl,
          'GET',
          { start, end, size: receipt.size, etag },
          timeoutMs,
          fetchSignal
        );
        assertCurrent();
        return result.body;
      },
      signal
    );
    assertCurrent();
    if (signal.aborted || outgoing.destroyed) throw new RemoteByteReadCancelled();
    if (!outgoing.headersSent) outgoing.writeHead(range.status, headers);
    const stop = Math.min(range.end + 1, start + buffer.length);
    if (!outgoing.write(buffer.subarray(position - start, stop - start)))
      await waitForDrain(outgoing, signal);
    position = stop;
  }
  if (signal.aborted) throw new RemoteByteReadCancelled();
  if (!outgoing.headersSent) outgoing.writeHead(range.status, headers);
  outgoing.end();
  return true;
}

function expectedEtag(receipt: RemoteFileReceiptV1): string {
  return `"${BigInt(receipt.inode!).toString(16)}-${BigInt(receipt.mtimeNs).toString(16)}-${receipt.size.toString(16)}"`;
}

function selectRange(
  header: string | undefined,
  size: number
): { status: number; start: number; end: number } {
  if (!header) return { status: 200, start: 0, end: size - 1 };
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || !size) return { status: 416, start: 0, end: -1 };
  const left = match[1] ? BigInt(match[1]) : null;
  const right = match[2] ? BigInt(match[2]) : null;
  const length = BigInt(size);
  if (
    (left === null && right === 0n) ||
    (left !== null && (left >= length || (right !== null && left > right)))
  )
    return { status: 416, start: 0, end: -1 };
  return {
    status: 206,
    start: left === null ? (right! >= length ? 0 : size - Number(right)) : Number(left),
    end: left === null || right === null || right >= length ? size - 1 : Number(right),
  };
}

function readUpstream(
  url: string,
  method: 'GET' | 'HEAD',
  range: { start: number; end: number; size: number; etag: string } | undefined,
  timeoutMs: number,
  signal: AbortSignal
): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    let response: IncomingMessage | null = null;
    let result: { status: number; headers: IncomingHttpHeaders; body: Buffer } | undefined;
    let failure: unknown;
    const expected = range ? range.end - range.start + 1 : 0;
    const body = Buffer.allocUnsafe(expected);
    let received = 0;
    const request = requestHttp(url, {
      method,
      headers: range
        ? { range: `bytes=${range.start}-${range.end}`, 'accept-encoding': 'identity' }
        : {},
    });
    const fail = (error: unknown): void => {
      failure ??= error;
      response?.destroy();
      request.destroy();
    };
    const abort = (): void => fail(new RemoteByteReadCancelled());
    request.once('error', (error) => {
      failure ??= error;
    });
    request.once('close', () => {
      signal.removeEventListener('abort', abort);
      if (failure !== undefined) reject(failure);
      else if (result) resolve(result);
      else reject(new Error('The SSH byte response ended before completion.'));
    });
    request.once('response', (incoming) => {
      response = incoming;
      if (incoming.statusCode === 412) {
        fail(new RemoteGenomicsError('source-changed', REMOTE_SOURCE_CHANGED_MESSAGE));
        return;
      }
      if (
        range &&
        (incoming.statusCode !== 206 ||
          incoming.headers['content-range'] !== `bytes ${range.start}-${range.end}/${range.size}` ||
          incoming.headers['content-length'] !== String(expected) ||
          incoming.headers.etag !== range.etag ||
          (incoming.headers['content-encoding'] !== undefined &&
            incoming.headers['content-encoding'] !== 'identity'))
      ) {
        fail(new Error('The SSH byte response did not match the admitted range.'));
        return;
      }
      incoming.on('data', (chunk: Buffer) => {
        if (received + chunk.length > expected) {
          fail(new Error('The SSH byte response exceeded its requested length.'));
          return;
        }
        chunk.copy(body, received);
        received += chunk.length;
      });
      incoming.once('error', fail);
      incoming.once('aborted', () => fail(new Error('The SSH byte response ended early.')));
      incoming.once('end', () => {
        if (received !== expected || !incoming.complete) {
          fail(new Error('The SSH byte response ended early.'));
          return;
        }
        result = { status: incoming.statusCode ?? 502, headers: incoming.headers, body };
      });
    });
    request.setTimeout(timeoutMs, () =>
      fail(new Error('The SSH range transport stopped responding.'))
    );
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    else request.end();
  });
}

function waitForDrain(response: ServerResponse, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      response.off('drain', drain);
      response.off('close', abort);
      response.off('error', abort);
      signal.removeEventListener('abort', abort);
    };
    const drain = (): void => {
      cleanup();
      resolve();
    };
    const abort = (): void => {
      cleanup();
      reject(new RemoteByteReadCancelled());
    };
    response.once('drain', drain);
    response.once('close', abort);
    response.once('error', abort);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted || response.destroyed) abort();
  });
}
