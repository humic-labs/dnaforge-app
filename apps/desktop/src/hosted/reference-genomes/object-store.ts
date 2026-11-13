import type { GenericFilehandle, FilehandleOptions, Stats } from 'generic-filehandle2';

export interface PreparedReferenceObjectRefV1 {
  readonly objectKey: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export type PreparedReferenceObjectLocatorV1 = (objectKey: string) => string | Promise<string>;

export type PreparedReferenceBlockDigestsV1 = (
  ref: PreparedReferenceObjectRefV1
) => readonly string[] | null;

export interface PreparedReferenceObjectStoreOptionsV1 {
  readonly locate: PreparedReferenceObjectLocatorV1;
  readonly fetch?: typeof fetch;
  readonly cacheName?: string | null;
  readonly rangeBlockBytes?: number;
  readonly maxCachedRangeBlocks?: number;
  readonly sha256Hex?: (bytes: Uint8Array) => Promise<string>;
  readonly hiddenContentRange?: boolean;
  readonly blockSha256?: PreparedReferenceBlockDigestsV1;
}

export class PreparedReferenceObjectIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreparedReferenceObjectIntegrityError';
  }
}

const DEFAULT_CACHE_NAME = 'dnaforge-prepared-reference-objects.v1';
const DEFAULT_RANGE_BLOCK_BYTES = 256 * 1024;
const DEFAULT_MAX_CACHED_RANGE_BLOCKS = 512;
const OBJECT_CACHE_ORIGIN = 'https://prepared-objects.dnaforge.invalid';
const OBJECT_KEY = /^objects\/sha256\/([0-9a-f]{2})\/([0-9a-f]{64})$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function hostedReferenceObjectLocatorV1(baseUrl: string): PreparedReferenceObjectLocatorV1 {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return (objectKey) => {
    assertContentAddressedObjectKey(objectKey);
    return new URL(objectKey, base).toString();
  };
}

export function preparedReferenceObjectKeyV1(sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new PreparedReferenceObjectIntegrityError('Object digest is not a SHA-256 value.');
  }
  return `objects/sha256/${sha256.slice(0, 2)}/${sha256}`;
}

export async function webCryptoSha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function objectCacheKey(sha256: string, bytes?: string): string {
  const key = new URL(`/sha256/${sha256}`, OBJECT_CACHE_ORIGIN);
  if (bytes) key.searchParams.set('bytes', bytes);
  return key.toString();
}

function assertContentAddressedObjectKey(objectKey: string): void {
  const match = OBJECT_KEY.exec(objectKey);
  if (!match || match[2].slice(0, 2) !== match[1]) {
    throw new PreparedReferenceObjectIntegrityError(`Unsupported object key: ${objectKey}`);
  }
}

export class PreparedReferenceObjectStoreV1 {
  readonly #locate: PreparedReferenceObjectLocatorV1;
  readonly #fetch: typeof fetch;
  readonly #cacheName: string | null;
  readonly #blockBytes: number;
  readonly #maxBlocks: number;
  readonly #sha256Hex: (bytes: Uint8Array) => Promise<string>;
  readonly #hiddenContentRange: boolean;
  readonly #blockSha256: PreparedReferenceBlockDigestsV1 | null;
  readonly #whole = new Map<string, Promise<Uint8Array>>();
  readonly #blocks = new Map<string, Promise<Uint8Array>>();
  #requestCount = 0;
  #transferredBytes = 0;

  constructor(options: PreparedReferenceObjectStoreOptionsV1) {
    this.#locate = options.locate;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#cacheName = options.cacheName === undefined ? DEFAULT_CACHE_NAME : options.cacheName;
    this.#blockBytes = options.rangeBlockBytes ?? DEFAULT_RANGE_BLOCK_BYTES;
    this.#maxBlocks = options.maxCachedRangeBlocks ?? DEFAULT_MAX_CACHED_RANGE_BLOCKS;
    this.#sha256Hex = options.sha256Hex ?? webCryptoSha256Hex;
    this.#hiddenContentRange = options.hiddenContentRange ?? false;
    this.#blockSha256 = options.blockSha256 ?? null;
  }

  get stats(): { readonly requestCount: number; readonly transferredBytes: number } {
    return { requestCount: this.#requestCount, transferredBytes: this.#transferredBytes };
  }

  readVerified(ref: PreparedReferenceObjectRefV1, signal?: AbortSignal): Promise<Uint8Array> {
    assertContentAddressedObjectKey(ref.objectKey);
    if (!ref.objectKey.endsWith(ref.sha256)) {
      throw new PreparedReferenceObjectIntegrityError('Object key does not name its digest.');
    }
    const existing = this.#whole.get(ref.sha256);
    if (existing) return existing;
    const task = this.#readVerifiedUncached(ref, signal);
    this.#whole.set(ref.sha256, task);
    task.catch(() => {
      if (this.#whole.get(ref.sha256) === task) this.#whole.delete(ref.sha256);
    });
    return task;
  }

  async readVerifiedText(ref: PreparedReferenceObjectRefV1, signal?: AbortSignal): Promise<string> {
    return new TextDecoder().decode(await this.readVerified(ref, signal));
  }

  async readVerifiedJson(
    ref: PreparedReferenceObjectRefV1,
    signal?: AbortSignal
  ): Promise<unknown> {
    return JSON.parse(await this.readVerifiedText(ref, signal)) as unknown;
  }

  openRange(ref: PreparedReferenceObjectRefV1): GenericFilehandle {
    assertContentAddressedObjectKey(ref.objectKey);
    return new PreparedReferenceRangeFilehandleV1(this, ref);
  }

  async readRange(
    ref: PreparedReferenceObjectRefV1,
    position: number,
    length: number,
    signal?: AbortSignal
  ): Promise<Uint8Array> {
    if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0) {
      throw new RangeError(`Invalid object range ${position}+${length}`);
    }
    const end = Math.min(ref.byteLength, position + Math.max(0, length));
    if (end <= position) return new Uint8Array(0);
    const firstBlock = Math.floor(position / this.#blockBytes);
    const lastBlock = Math.floor((end - 1) / this.#blockBytes);
    const out = new Uint8Array(end - position);
    const blocks = await Promise.all(
      Array.from({ length: lastBlock - firstBlock + 1 }, (_, index) =>
        this.#block(ref, firstBlock + index, signal)
      )
    );
    blocks.forEach((block, index) => {
      const blockStart = (firstBlock + index) * this.#blockBytes;
      const from = Math.max(position, blockStart);
      const to = Math.min(end, blockStart + block.byteLength);
      out.set(block.subarray(from - blockStart, to - blockStart), from - position);
    });
    return out;
  }

  #block(
    ref: PreparedReferenceObjectRefV1,
    index: number,
    signal?: AbortSignal
  ): Promise<Uint8Array> {
    const key = `${ref.sha256}:${index}`;
    const existing = this.#blocks.get(key);
    if (existing) {
      this.#blocks.delete(key);
      this.#blocks.set(key, existing);
      return existing;
    }
    const start = index * this.#blockBytes;
    const end = Math.min(ref.byteLength, start + this.#blockBytes);
    const task = this.#fetchRange(ref, start, end, signal);
    this.#blocks.set(key, task);
    task.catch(() => {
      if (this.#blocks.get(key) === task) this.#blocks.delete(key);
    });
    while (this.#blocks.size > this.#maxBlocks) {
      const oldest = this.#blocks.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#blocks.delete(oldest);
    }
    return task;
  }

  async #fetchRange(
    ref: PreparedReferenceObjectRefV1,
    start: number,
    end: number,
    signal?: AbortSignal
  ): Promise<Uint8Array> {
    const cacheKey = objectCacheKey(ref.sha256, `${start}-${end - 1}`);
    const expected = this.#expectedBlockSha256(ref, start);
    const cached = await this.#cacheRead(cacheKey);
    if (
      cached &&
      cached.byteLength === end - start &&
      (expected === null || (await this.#sha256Hex(cached)) === expected)
    ) {
      return cached;
    }
    const url = await this.#locate(ref.objectKey);
    this.#requestCount += 1;
    const response = await this.#fetch(url, {
      headers: { Range: `bytes=${start}-${end - 1}` },
      credentials: 'omit',
      signal,
    });
    if (response.status !== 206) {
      throw new PreparedReferenceObjectIntegrityError(
        `Range read returned HTTP ${response.status} for ${ref.objectKey}`
      );
    }
    const contentRange = response.headers.get('content-range');
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec((contentRange ?? '').trim());
    if (
      !(contentRange === null && this.#hiddenContentRange && response.type === 'cors') &&
      (!match ||
        Number(match[1]) !== start ||
        Number(match[2]) !== end - 1 ||
        Number(match[3]) !== ref.byteLength)
    ) {
      throw new PreparedReferenceObjectIntegrityError(
        `Range response for ${ref.objectKey} did not match the published object length.`
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    this.#transferredBytes += bytes.byteLength;
    if (bytes.byteLength !== end - start) {
      throw new PreparedReferenceObjectIntegrityError(
        `Range response for ${ref.objectKey} was truncated.`
      );
    }
    if (expected !== null && (await this.#sha256Hex(bytes)) !== expected) {
      throw new PreparedReferenceObjectIntegrityError(
        `Block at byte ${start} of ${ref.objectKey} failed its SHA-256 check.`
      );
    }
    await this.#cacheWrite(cacheKey, bytes);
    return bytes;
  }

  #expectedBlockSha256(ref: PreparedReferenceObjectRefV1, start: number): string | null {
    const digests = this.#blockSha256?.(ref) ?? null;
    if (digests === null) return null;
    const digest = digests[start / this.#blockBytes];
    if (
      digests.length !== Math.ceil(ref.byteLength / this.#blockBytes) ||
      typeof digest !== 'string' ||
      !SHA256.test(digest)
    ) {
      throw new PreparedReferenceObjectIntegrityError(
        `Block checksums for ${ref.objectKey} do not cover the object.`
      );
    }
    return digest;
  }

  async #readVerifiedUncached(
    ref: PreparedReferenceObjectRefV1,
    signal?: AbortSignal
  ): Promise<Uint8Array> {
    const cacheKey = objectCacheKey(ref.sha256);
    const cached = await this.#cacheRead(cacheKey);
    if (cached && (await this.#matches(ref, cached))) return cached;
    const url = await this.#locate(ref.objectKey);
    this.#requestCount += 1;
    const response = await this.#fetch(url, { credentials: 'omit', signal });
    if (!response.ok) {
      throw new PreparedReferenceObjectIntegrityError(
        `HTTP ${response.status} reading ${ref.objectKey}`
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    this.#transferredBytes += bytes.byteLength;
    if (!(await this.#matches(ref, bytes))) {
      throw new PreparedReferenceObjectIntegrityError(
        `Published object ${ref.objectKey} failed its SHA-256 or length check.`
      );
    }
    await this.#cacheWrite(cacheKey, bytes);
    return bytes;
  }

  async #matches(ref: PreparedReferenceObjectRefV1, bytes: Uint8Array): Promise<boolean> {
    return bytes.byteLength === ref.byteLength && (await this.#sha256Hex(bytes)) === ref.sha256;
  }

  async #cacheRead(key: string): Promise<Uint8Array | null> {
    if (!this.#cacheName || typeof caches === 'undefined') return null;
    try {
      const cache = await caches.open(this.#cacheName);
      const hit = await cache.match(key);
      return hit ? new Uint8Array(await hit.arrayBuffer()) : null;
    } catch {
      return null;
    }
  }

  async #cacheWrite(key: string, bytes: Uint8Array): Promise<void> {
    if (!this.#cacheName || typeof caches === 'undefined') return;
    try {
      const cache = await caches.open(this.#cacheName);
      await cache.put(
        key,
        new Response(bytes as Uint8Array<ArrayBuffer>, {
          headers: { 'content-type': 'application/octet-stream' },
        })
      );
    } catch {
      return;
    }
  }
}

class PreparedReferenceRangeFilehandleV1 implements GenericFilehandle {
  constructor(
    private readonly store: PreparedReferenceObjectStoreV1,
    private readonly ref: PreparedReferenceObjectRefV1
  ) {}

  async read(
    length: number,
    position: number,
    opts: FilehandleOptions = {}
  ): Promise<Uint8Array<ArrayBuffer>> {
    return (await this.store.readRange(
      this.ref,
      position,
      length,
      opts.signal
    )) as Uint8Array<ArrayBuffer>;
  }

  readFile(options?: Omit<FilehandleOptions, 'encoding'>): Promise<Uint8Array<ArrayBuffer>>;
  readFile(
    options:
      | FilehandleOptions['encoding']
      | (Omit<FilehandleOptions, 'encoding'> & {
          encoding: NonNullable<FilehandleOptions['encoding']>;
        })
  ): Promise<string>;
  async readFile(options?: string | FilehandleOptions): Promise<Uint8Array<ArrayBuffer> | string> {
    const encoding = typeof options === 'string' ? options : options?.encoding;
    const signal = typeof options === 'object' ? options.signal : undefined;
    const bytes = (await this.store.readVerified(this.ref, signal)) as Uint8Array<ArrayBuffer>;
    if (!encoding) return bytes;
    if (encoding !== 'utf8' && encoding !== 'utf-8') {
      throw new Error(`Unsupported encoding ${encoding}`);
    }
    return new TextDecoder().decode(bytes);
  }

  async stat(): Promise<Stats> {
    return { size: this.ref.byteLength };
  }

  async close(): Promise<void> {}
}
