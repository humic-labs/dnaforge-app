// @vitest-environment node

import { createHash } from 'node:crypto';
import { IndexedGenomeDataSource } from '@waypoint/genome-data';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PreparedReferenceObjectIntegrityError,
  PreparedReferenceObjectStoreV1,
  hostedReferenceObjectLocatorV1,
  preparedReferenceObjectKeyV1,
  type PreparedReferenceObjectRefV1,
} from './object-store';

const BASE = 'https://references.test/reference-genomes/v1/';

function published(bytes: Uint8Array): PreparedReferenceObjectRefV1 {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { objectKey: preparedReferenceObjectKeyV1(sha256), sha256, byteLength: bytes.byteLength };
}

function bucket(
  objects: ReadonlyMap<string, Uint8Array>,
  reportedLength?: number | null,
  type?: ResponseType
) {
  const requests: Array<{ url: string; range: string | null }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const range = headers.get('range');
    requests.push({ url, range });
    const bytes = objects.get(url);
    if (!bytes) return new Response(null, { status: 404 });
    if (!range) return new Response(bytes, { status: 200 });
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(range)!.map(Number);
    const response = new Response(bytes.slice(start, end + 1), {
      status: 206,
      headers:
        reportedLength === null
          ? {}
          : { 'content-range': `bytes ${start}-${end}/${reportedLength ?? bytes.byteLength}` },
    });
    if (type) Object.defineProperty(response, 'type', { value: type });
    return response;
  }) as typeof fetch;
  return { fetchImpl, requests };
}

function blockDigests(bytes: Uint8Array, blockBytes: number): string[] {
  const digests: string[] = [];
  for (let start = 0; start < bytes.byteLength; start += blockBytes) {
    digests.push(
      createHash('sha256')
        .update(bytes.subarray(start, start + blockBytes))
        .digest('hex')
    );
  }
  return digests;
}

function specCacheStorage() {
  const entries = new Map<string, Uint8Array>();
  const matchKey = (key: string) => {
    const url = new URL(key);
    url.hash = '';
    return url.toString();
  };
  return {
    open: async () => ({
      match: async (key: string) => {
        const bytes = entries.get(matchKey(key));
        return bytes ? new Response(bytes.slice()) : undefined;
      },
      put: async (key: string, response: Response) => {
        entries.set(matchKey(key), new Uint8Array(await response.arrayBuffer()));
      },
    }),
  };
}

describe('prepared reference object store', () => {
  const locate = hostedReferenceObjectLocatorV1(BASE);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('caches each range by content address so a fresh store never reuses another block', async () => {
    vi.stubGlobal('caches', specCacheStorage());
    const bytes = new Uint8Array(4096).map((_, index) => index % 251);
    const ref = published(bytes);
    let signed = 0;
    const signedLocate = (objectKey: string) => `${String(locate(objectKey))}?token=${signed++}`;
    const remote = bucket(new Map([[String(locate(ref.objectKey)), bytes]]));
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) =>
      remote.fetchImpl(String(input).replace(/\?token=\d+$/u, ''), init)) as typeof fetch;
    const options = { locate: signedLocate, fetch: fetchImpl, rangeBlockBytes: 1024 };
    const first = new PreparedReferenceObjectStoreV1(options);
    await first.readRange(ref, 0, 1024);
    await first.readRange(ref, 2048, 1024);
    const fresh = new PreparedReferenceObjectStoreV1(options);
    expect(await fresh.readRange(ref, 0, 1024)).toEqual(bytes.slice(0, 1024));
    expect(await fresh.readRange(ref, 2048, 1024)).toEqual(bytes.slice(2048, 3072));
    expect(remote.requests).toHaveLength(2);
  });

  it('admits a whole object only when its published digest and length match', async () => {
    const bytes = new TextEncoder().encode('{"contract":"x"}');
    const ref = published(bytes);
    const good = bucket(new Map([[String(locate(ref.objectKey)), bytes]]));
    const store = new PreparedReferenceObjectStoreV1({
      locate,
      fetch: good.fetchImpl,
      cacheName: null,
    });
    await expect(store.readVerifiedJson(ref)).resolves.toEqual({ contract: 'x' });

    const tampered = bucket(
      new Map([[String(locate(ref.objectKey)), new TextEncoder().encode('{"contract":"y"}')]])
    );
    const rejecting = new PreparedReferenceObjectStoreV1({
      locate,
      fetch: tampered.fetchImpl,
      cacheName: null,
    });
    await expect(rejecting.readVerified(ref)).rejects.toBeInstanceOf(
      PreparedReferenceObjectIntegrityError
    );
  });

  it('reads byte ranges across blocks and rejects a response for a different object length', async () => {
    const bytes = Uint8Array.from({ length: 1_000 }, (_, index) => index % 251);
    const ref = published(bytes);
    const objects = new Map([[String(locate(ref.objectKey)), bytes]]);
    const store = new PreparedReferenceObjectStoreV1({
      locate,
      fetch: bucket(objects).fetchImpl,
      cacheName: null,
      rangeBlockBytes: 64,
    });
    await expect(store.readRange(ref, 50, 200)).resolves.toEqual(bytes.slice(50, 250));
    expect(store.stats.requestCount).toBe(4);

    const wrongLength = new PreparedReferenceObjectStoreV1({
      locate,
      fetch: bucket(objects, 999).fetchImpl,
      cacheName: null,
      rangeBlockBytes: 64,
    });
    await expect(wrongLength.readRange(ref, 0, 10)).rejects.toBeInstanceOf(
      PreparedReferenceObjectIntegrityError
    );
  });

  it('accepts a cross-origin hidden content range only when the store allows it and the byte count matches', async () => {
    const bytes = Uint8Array.from({ length: 1_000 }, (_, index) => index % 251);
    const ref = published(bytes);
    const objects = new Map([[String(locate(ref.objectKey)), bytes]]);
    const options = {
      locate,
      fetch: bucket(objects, null, 'cors').fetchImpl,
      cacheName: null,
      rangeBlockBytes: 64,
    };

    await expect(
      new PreparedReferenceObjectStoreV1(options).readRange(ref, 0, 10)
    ).rejects.toBeInstanceOf(PreparedReferenceObjectIntegrityError);
    await expect(
      new PreparedReferenceObjectStoreV1({ ...options, hiddenContentRange: true }).readRange(
        ref,
        50,
        200
      )
    ).resolves.toEqual(bytes.slice(50, 250));

    await expect(
      new PreparedReferenceObjectStoreV1({
        ...options,
        fetch: bucket(objects, null).fetchImpl,
        hiddenContentRange: true,
      }).readRange(ref, 0, 10)
    ).rejects.toBeInstanceOf(PreparedReferenceObjectIntegrityError);

    const truncated = new Map([[String(locate(ref.objectKey)), bytes.slice(0, 100)]]);
    await expect(
      new PreparedReferenceObjectStoreV1({
        ...options,
        fetch: bucket(truncated, null, 'cors').fetchImpl,
        hiddenContentRange: true,
      }).readRange(ref, 64, 64)
    ).rejects.toBeInstanceOf(PreparedReferenceObjectIntegrityError);
  });

  it('refuses a ranged block whose bytes differ from its published digest', async () => {
    const bytes = Uint8Array.from({ length: 1_000 }, (_, index) => index % 251);
    const ref = published(bytes);
    const tampered = bytes.slice();
    tampered[130] ^= 0xff;
    const store = new PreparedReferenceObjectStoreV1({
      locate,
      fetch: bucket(new Map([[String(locate(ref.objectKey)), tampered]])).fetchImpl,
      cacheName: null,
      rangeBlockBytes: 64,
      blockSha256: () => blockDigests(bytes, 64),
    });
    await expect(store.readRange(ref, 0, 100)).resolves.toEqual(bytes.slice(0, 100));
    await expect(store.readRange(ref, 120, 20)).rejects.toThrow(
      'Block at byte 128 of ' + ref.objectKey + ' failed its SHA-256 check.'
    );
  });

  it('checks a cached block against its digest and replaces one that fails', async () => {
    vi.stubGlobal('caches', specCacheStorage());
    const bytes = Uint8Array.from({ length: 1_000 }, (_, index) => index % 251);
    const ref = published(bytes);
    const remote = bucket(new Map([[String(locate(ref.objectKey)), bytes]]));
    const options = {
      locate,
      fetch: remote.fetchImpl,
      cacheName: 'spec-blocks',
      rangeBlockBytes: 64,
      blockSha256: () => blockDigests(bytes, 64),
    };
    const cache = await caches.open('spec-blocks');
    const key = new URL(`/sha256/${ref.sha256}`, 'https://prepared-objects.dnaforge.invalid');
    key.searchParams.set('bytes', '64-127');
    await cache.put(key.toString(), new Response(bytes.slice(128, 192)));

    await expect(
      new PreparedReferenceObjectStoreV1(options).readRange(ref, 64, 64)
    ).resolves.toEqual(bytes.slice(64, 128));
    expect(remote.requests).toHaveLength(1);
    await expect(
      new PreparedReferenceObjectStoreV1(options).readRange(ref, 64, 64)
    ).resolves.toEqual(bytes.slice(64, 128));
    expect(remote.requests).toHaveLength(1);
  });

  it('refuses block digests that do not cover the object', async () => {
    const bytes = Uint8Array.from({ length: 1_000 }, (_, index) => index % 251);
    const ref = published(bytes);
    const store = new PreparedReferenceObjectStoreV1({
      locate,
      fetch: bucket(new Map([[String(locate(ref.objectKey)), bytes]])).fetchImpl,
      cacheName: null,
      rangeBlockBytes: 64,
      blockSha256: () => blockDigests(bytes, 64).slice(1),
    });
    await expect(store.readRange(ref, 0, 10)).rejects.toThrow('do not cover the object');
  });

  it('streams FASTA bases through ranged reads with the shared indexed reader', async () => {
    const sequence = 'ACGTACGTTTGGCCAANNACGTAGCTAGCTAGGATCCAAGCTT'.repeat(3);
    const lines = sequence.match(/.{1,20}/g)!;
    const fasta = new TextEncoder().encode(`>chrT\n${lines.join('\n')}\n`);
    const fai = new TextEncoder().encode(`chrT\t${sequence.length}\t6\t20\t21\n`);
    const fastaRef = published(fasta);
    const faiRef = published(fai);
    const { fetchImpl, requests } = bucket(
      new Map([
        [String(locate(fastaRef.objectKey)), fasta],
        [String(locate(faiRef.objectKey)), fai],
      ])
    );
    const store = new PreparedReferenceObjectStoreV1({
      locate,
      fetch: fetchImpl,
      cacheName: null,
      rangeBlockBytes: 32,
    });
    const refs = new Map([
      ['/hosted/reference-cache/test/chrT.fa', fastaRef],
      ['/hosted/reference-cache/test/chrT.fa.fai', faiRef],
    ]);
    const source = new IndexedGenomeDataSource(
      {
        chrom: 'chrT',
        fastaPath: '/hosted/reference-cache/test/chrT.fa',
        faiPath: '/hosted/reference-cache/test/chrT.fa.fai',
        gffPath: null,
        tbiPath: null,
      },
      { openFile: (path) => store.openRange(refs.get(path)!) }
    );
    await expect(source.getSequence('chrT', 7, 61)).resolves.toBe(sequence.slice(7, 61));
    expect(requests.some(({ range }) => range !== null)).toBe(true);
  });

  it('returns each block of a public-bucket object after a reload, not the last block cached', async () => {
    vi.stubGlobal('caches', specCacheStorage());
    const bytes = new Uint8Array(4096).map((_, index) => index % 251);
    const ref = published(bytes);
    const remote = bucket(new Map([[String(locate(ref.objectKey)), bytes]]));
    const options = { locate, fetch: remote.fetchImpl, rangeBlockBytes: 1024 };
    const first = new PreparedReferenceObjectStoreV1(options);
    await first.readRange(ref, 0, 1024);
    await first.readRange(ref, 2048, 1024);
    const reloaded = new PreparedReferenceObjectStoreV1(options);
    expect(await reloaded.readRange(ref, 0, 1024)).toEqual(bytes.slice(0, 1024));
    expect(await reloaded.readRange(ref, 2048, 1024)).toEqual(bytes.slice(2048, 3072));
    expect(remote.requests).toHaveLength(2);
  });
});
