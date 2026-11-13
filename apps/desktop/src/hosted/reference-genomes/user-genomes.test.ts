// @vitest-environment node

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../controller', () => ({
  hostedWorkspaceSessionController: {
    getState: () => ({ snapshot: { revisionId: '33333333-3333-4333-8333-333333333333' } }),
  },
  hostedDurableSync: {},
}));

import { BrowserPreparedReferencesV1 } from './browser-prepared-references';
import { PreparedReferenceObjectStoreV1 } from './object-store';
import {
  projectGenomeObjectLocator,
  userGenomeDefinition,
  userGenomeObjectStore,
} from './user-genomes';
import type { HostedGenomeLocation } from '../reference-genome-jobs';

const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const ASSEMBLY = `local-${'a'.repeat(24)}`;
const SHA = 'b'.repeat(64);
const OBJECT_KEY = `objects/sha256/bb/${SHA}`;
const LOCATION: HostedGenomeLocation = {
  workspaceId: WORKSPACE,
  versionId: '33333333-3333-4333-8333-333333333333',
  root: `.waypoint/reference-genomes/${ASSEMBLY}`,
  record: {
    contract: 'dnaforge-user-genome-publication.v1',
    operationId: '44444444-4444-4444-8444-444444444444',
    sourcePath: 'genomes/ecoli.gb',
    sourceSha256: 'c'.repeat(64),
    assembly: {
      id: ASSEMBLY,
      name: 'NC_000913.3',
      organism: 'Escherichia coli',
      description: 'Custom reference.',
      lengthBp: 4_641_652,
      contigs: [
        { chrom: 'NC_000913', displayName: 'NC_000913', lengthBp: 4_641_652, circular: false },
      ],
    },
    publicationFingerprint: 'd'.repeat(64),
    bundle: {
      objectKey: OBJECT_KEY,
      sha256: SHA,
      byteLength: 120,
      bundleFingerprint: 'e'.repeat(64),
    },
    objects: [
      { objectKey: OBJECT_KEY, sha256: SHA, byteLength: 120, contentType: 'application/json' },
    ],
  },
};

const BLOCK = 256 * 1024;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function savedGenome(objects: ReadonlyArray<{ bytes: Uint8Array; blocks: boolean }>) {
  const published = objects.map(({ bytes, blocks }) => {
    const digest = sha256(bytes);
    return {
      bytes,
      object: {
        objectKey: `objects/sha256/${digest.slice(0, 2)}/${digest}`,
        sha256: digest,
        byteLength: bytes.byteLength,
        contentType: 'application/octet-stream',
        ...(blocks
          ? {
              blockSha256: Array.from({ length: Math.ceil(bytes.byteLength / BLOCK) }, (_, index) =>
                sha256(bytes.subarray(index * BLOCK, (index + 1) * BLOCK))
              ),
            }
          : {}),
      },
    };
  });
  const location: HostedGenomeLocation = {
    ...LOCATION,
    record: {
      ...LOCATION.record,
      ...(objects.some(({ blocks }) => blocks) ? { blockBytes: BLOCK } : {}),
      objects: [...LOCATION.record.objects, ...published.map(({ object }) => object)],
    },
  };
  return { location, published };
}

function projectBucket(served: ReadonlyMap<string, Uint8Array>) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const bytes = served.get(String(input))!;
    const [, start, end] = /^bytes=(\d+)-(\d+)$/
      .exec(new Headers(init?.headers).get('range')!)!
      .map(Number);
    return new Response(bytes.slice(start, end + 1), {
      status: 206,
      headers: { 'content-range': `bytes ${start}-${end}/${bytes.byteLength}` },
    });
  }) as typeof fetch;
}

describe('user genomes in the browser reader', () => {
  it('signs each project object once per lifetime through the cookie-authenticated route', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            signedUrl: 'https://project.storage.test/object/sign/x?token=1',
            contentSha256: SHA,
            sizeBytes: 120,
            expiresAt: new Date(Date.now() + 240_000).toISOString(),
          })
        )
    );
    const locate = projectGenomeObjectLocator(LOCATION, fetchImpl);
    await expect(locate(OBJECT_KEY)).resolves.toBe(
      'https://project.storage.test/object/sign/x?token=1'
    );
    await locate(OBJECT_KEY);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe(
      `/api/hosted-workspaces/${WORKSPACE}/versions/33333333-3333-4333-8333-333333333333/files?path=${encodeURIComponent(
        `.waypoint/reference-genomes/${ASSEMBLY}/${OBJECT_KEY}`
      )}&location=json`
    );
    expect(init?.credentials).toBe('same-origin');
  });

  it('refuses a signed location whose digest differs from the saved object', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            signedUrl: 'https://project.storage.test/x',
            contentSha256: 'f'.repeat(64),
            sizeBytes: 120,
            expiresAt: new Date(Date.now() + 240_000).toISOString(),
          })
        )
    );
    const locate = projectGenomeObjectLocator(LOCATION, fetchImpl);
    await expect(locate(OBJECT_KEY)).rejects.toThrow(/unavailable/);
    await expect(locate(`objects/sha256/cc/${'c'.repeat(64)}`)).rejects.toThrow(/unavailable/);
  });

  it('checks each block of a saved genome against its published digest', async () => {
    const fasta = Uint8Array.from({ length: BLOCK * 2 + 1_000 }, (_, index) => (index * 7) % 251);
    const { location, published } = savedGenome([{ bytes: fasta, blocks: true }]);
    const { object } = published[0];
    const tampered = fasta.slice();
    tampered[BLOCK + 5] ^= 0xff;
    const options = (bytes: Uint8Array) => ({
      locate: () => 'https://project.storage.test/fasta',
      fetch: projectBucket(new Map([['https://project.storage.test/fasta', bytes]])),
      cacheName: null,
    });
    await expect(
      userGenomeObjectStore(location, options(fasta)).readRange(object, BLOCK - 10, 20)
    ).resolves.toEqual(fasta.slice(BLOCK - 10, BLOCK + 10));
    await expect(
      userGenomeObjectStore(location, options(tampered)).readRange(object, BLOCK - 10, 20)
    ).rejects.toThrow('failed its SHA-256 check');
  });

  it('still opens a genome saved before block digests, verifying only single-block objects', async () => {
    const fasta = Uint8Array.from({ length: BLOCK * 2 + 1_000 }, (_, index) => (index * 7) % 251);
    const index = Uint8Array.from({ length: 4_000 }, (_, offset) => offset % 13);
    const { location, published } = savedGenome([
      { bytes: fasta, blocks: false },
      { bytes: index, blocks: false },
    ]);
    expect(location.record.blockBytes).toBeUndefined();
    const store = (fastaBytes: Uint8Array, indexBytes: Uint8Array) =>
      userGenomeObjectStore(location, {
        locate: (objectKey) => `https://project.storage.test/${objectKey}`,
        fetch: projectBucket(
          new Map([
            [`https://project.storage.test/${published[0].object.objectKey}`, fastaBytes],
            [`https://project.storage.test/${published[1].object.objectKey}`, indexBytes],
          ])
        ),
        cacheName: null,
      });
    await expect(store(fasta, index).readRange(published[0].object, BLOCK, 100)).resolves.toEqual(
      fasta.slice(BLOCK, BLOCK + 100)
    );
    await expect(store(fasta, index).readRange(published[1].object, 0, 8)).resolves.toEqual(
      index.slice(0, 8)
    );
    const tamperedIndex = index.slice();
    tamperedIndex[3_999] ^= 0xff;
    await expect(store(fasta, tamperedIndex).readRange(published[1].object, 0, 8)).rejects.toThrow(
      'failed its SHA-256 check'
    );
  });

  it('adds a user genome beside the hosted catalog without listing it as hosted', () => {
    const references = new BrowserPreparedReferencesV1({
      store: new PreparedReferenceObjectStoreV1({ locate: () => 'https://public.test/x' }),
      definitions: [],
      cacheRoot: '/hosted/reference-cache',
      publicationRoot: '/hosted/reference-publication',
      brotliDecompress: async (bytes) => bytes,
    });
    references.addDefinition(
      userGenomeDefinition(LOCATION),
      new PreparedReferenceObjectStoreV1({ locate: projectGenomeObjectLocator(LOCATION) })
    );
    expect(references.listHosted()).toEqual([]);
    expect(userGenomeDefinition(LOCATION)).toMatchObject({
      listing: { id: ASSEMBLY, lengthBp: 4_641_652, contigCount: 1 },
      manifest: { relativePath: OBJECT_KEY, sha256: SHA, byteLength: 120 },
      contigs: [{ chrom: 'NC_000913' }],
    });
  });
});
