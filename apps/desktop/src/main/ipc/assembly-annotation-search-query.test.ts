import { mkdtemp, open, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  packPrepackedAnnotationSearchIndexV1,
  unpackPrepackedAnnotationSearchIndexV1,
} from '@waypoint/genome-data';
import { afterEach, describe, expect, it } from 'vitest';

import {
  payloadIdentityFromFileStat,
  type AssemblyAnnotationSearchCacheIndexHit,
  type AssemblyAnnotationSearchPayloadIdentityV2,
} from './assembly-annotation-search-cache';
import {
  disposeAssemblyAnnotationSearchQuerySessions,
  queryAssemblyAnnotationSearchIndexHit,
  queryAssemblyAnnotationSearchIndexHitOrMiss,
  type AssemblyAnnotationSearchQueryFile,
} from './assembly-annotation-search-query';

const temporaryRoots: string[] = [];

function searchIdentity(type: string, index: number = 0) {
  return {
    annotationTrackId: type,
    canonicalIdentity: `annotation.v2:test-${type}-${index}`,
    direction: 'none' as const,
  };
}

async function payloadIdentityFor(
  payloadPath: string
): Promise<AssemblyAnnotationSearchPayloadIdentityV2> {
  const identity = payloadIdentityFromFileStat(await stat(payloadPath, { bigint: true }));
  if (!identity) throw new Error('test payload identity unavailable');
  return identity;
}

afterEach(async () => {
  await disposeAssemblyAnnotationSearchQuerySessions();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('assembly annotation search bounded disk query', () => {
  it('matches the packed query contract without reading the payload into one buffer', async () => {
    const packed = await packPrepackedAnnotationSearchIndexV1({
      datasetContract: {
        datasetId: 'grch38-annotations',
        datasetVersion: '1',
        sourceSha256: 'a'.repeat(64),
      },
      assemblyContract: {
        assemblyId: 'GRCh38',
        assemblyLengthBp: 3_088_269_832,
        placementSignature: 'test-placement',
        sourceFingerprint: 'b'.repeat(24),
      },
      trackType: 'annotation',
      features: Array.from({ length: 1_000 }, (_, index) => ({
        sourceOrdinal: index,
        type: index % 2 === 0 ? 'mRNA' : 'lnc_RNA',
        ...searchIdentity(index % 2 === 0 ? 'mRNA' : 'lnc_RNA', index),
        start: index * 1_000,
        end: index * 1_000 + 500,
        displayName: index === 777 ? 'HBB target transcript' : `feature-${index}-padding-value`,
        attributes: { gene: [index === 777 ? 'HBB' : `GENE-${index}`] },
      })),
    });
    const expected = await unpackPrepackedAnnotationSearchIndexV1(packed.manifest, packed.payload);
    const root = await mkdtemp(join(tmpdir(), 'waypoint-search-query-'));
    temporaryRoots.push(root);
    const payloadPath = join(root, 'annotation-search.bin');
    await writeFile(payloadPath, packed.payload);

    const requestedReadLengths: number[] = [];
    let statCalls = 0;
    const payloadIdentity = await payloadIdentityFor(payloadPath);
    const hit: AssemblyAnnotationSearchCacheIndexHit = {
      status: 'hit',
      fingerprint: packed.manifest.assemblyContract.sourceFingerprint,
      byteCount: packed.payload.byteLength,
      manifest: packed.manifest,
      payloadPath,
      payloadSha256: packed.manifest.integrity.payloadSha256,
      payloadIdentity,
      sourceContinuity: [],
    };
    const matches = await queryAssemblyAnnotationSearchIndexHit(hit, 'hbb target', 500, {
      async openFile(path): Promise<AssemblyAnnotationSearchQueryFile> {
        const handle = await open(path, 'r');
        return {
          stat: () => {
            statCalls += 1;
            return handle.stat({ bigint: true });
          },
          close: () => handle.close(),
          async read(buffer, byteOffset, byteLength, position) {
            requestedReadLengths.push(byteLength);
            return handle.read(buffer, byteOffset, byteLength, position);
          },
        };
      },
    });

    expect(matches).toEqual(expected.query('hbb target', 500));
    expect(requestedReadLengths.length).toBeGreaterThan(1);
    expect(Math.max(...requestedReadLengths)).toBeLessThan(packed.payload.byteLength);
    expect(requestedReadLengths).not.toContain(packed.payload.byteLength);
    expect(requestedReadLengths.reduce((sum, length) => sum + length, 0)).toBeLessThan(
      packed.payload.byteLength
    );
    expect(statCalls).toBeGreaterThanOrEqual(4);
  });

  it('reports truncation only when an exact result exists beyond the requested bound', async () => {
    const packed = await packPrepackedAnnotationSearchIndexV1({
      datasetContract: {
        datasetId: 'grch38-annotations',
        datasetVersion: '1',
        sourceSha256: 'a'.repeat(64),
      },
      assemblyContract: {
        assemblyId: 'GRCh38',
        assemblyLengthBp: 3_088_269_832,
        placementSignature: 'test-placement',
        sourceFingerprint: '8'.repeat(24),
      },
      trackType: 'annotation',
      features: Array.from({ length: 501 }, (_, index) => ({
        sourceOrdinal: index,
        type: 'gene',
        ...searchIdentity('gene', index),
        start: index * 1_000,
        end: index * 1_000 + 100,
        displayName: `COMMON-${index}`,
      })),
    });
    const root = await mkdtemp(join(tmpdir(), 'waypoint-search-truncation-'));
    temporaryRoots.push(root);
    const payloadPath = join(root, 'annotation-search.bin');
    await writeFile(payloadPath, packed.payload);
    const hit: AssemblyAnnotationSearchCacheIndexHit = {
      status: 'hit',
      fingerprint: packed.manifest.assemblyContract.sourceFingerprint,
      byteCount: packed.payload.byteLength,
      manifest: packed.manifest,
      payloadPath,
      payloadSha256: packed.manifest.integrity.payloadSha256,
      payloadIdentity: await payloadIdentityFor(payloadPath),
      sourceContinuity: [],
    };

    const result = await queryAssemblyAnnotationSearchIndexHitOrMiss(hit, 'common', 500);

    expect(result).toMatchObject({
      status: 'hit',
      matches: expect.any(Array),
      truncated: true,
    });
    if (result.status !== 'hit') throw new Error('expected authenticated search hit');
    expect(result.matches).toHaveLength(500);
  });

  it('turns an authenticated cache-hit failure into an exact repairable miss', async () => {
    const packed = await packPrepackedAnnotationSearchIndexV1({
      datasetContract: {
        datasetId: 'grch38-annotations',
        datasetVersion: '1',
        sourceSha256: 'a'.repeat(64),
      },
      assemblyContract: {
        assemblyId: 'GRCh38',
        assemblyLengthBp: 3_088_269_832,
        placementSignature: 'test-placement',
        sourceFingerprint: 'c'.repeat(24),
      },
      trackType: 'annotation',
      features: [
        {
          type: 'gene',
          ...searchIdentity('gene'),
          start: 100,
          end: 200,
          displayName: 'HBB',
        },
      ],
    });
    const root = await mkdtemp(join(tmpdir(), 'waypoint-search-corrupt-'));
    temporaryRoots.push(root);
    const payloadPath = join(root, 'annotation-search.bin');
    const corrupt = new Uint8Array(packed.payload);
    corrupt[packed.manifest.sections.postingOffsets.byteOffset] = 1;
    await writeFile(payloadPath, corrupt);
    const payloadIdentity = await payloadIdentityFor(payloadPath);
    const hit: AssemblyAnnotationSearchCacheIndexHit = {
      status: 'hit',
      fingerprint: packed.manifest.assemblyContract.sourceFingerprint,
      byteCount: packed.payload.byteLength,
      manifest: packed.manifest,
      payloadPath,
      payloadSha256: packed.manifest.integrity.payloadSha256,
      payloadIdentity,
      sourceContinuity: [],
    };

    await expect(queryAssemblyAnnotationSearchIndexHitOrMiss(hit, 'HBB', 500)).resolves.toEqual({
      status: 'miss',
      fingerprint: packed.manifest.assemblyContract.sourceFingerprint,
    });
  });

  it('does not translate cancellation into a repair miss or evict the warm session', async () => {
    const packed = await packPrepackedAnnotationSearchIndexV1({
      datasetContract: {
        datasetId: 'grch38-annotations',
        datasetVersion: '1',
        sourceSha256: 'a'.repeat(64),
      },
      assemblyContract: {
        assemblyId: 'GRCh38',
        assemblyLengthBp: 3_088_269_832,
        placementSignature: 'test-placement',
        sourceFingerprint: '9'.repeat(24),
      },
      trackType: 'annotation',
      features: Array.from({ length: 1_000 }, (_, index) => ({
        sourceOrdinal: index,
        type: 'gene',
        ...searchIdentity('gene', index),
        start: index * 1_000,
        end: index * 1_000 + 100,
        displayName: `COMMON-${index}`,
      })),
    });
    const root = await mkdtemp(join(tmpdir(), 'waypoint-search-cancel-'));
    temporaryRoots.push(root);
    const payloadPath = join(root, 'annotation-search.bin');
    await writeFile(payloadPath, packed.payload);
    const hit: AssemblyAnnotationSearchCacheIndexHit = {
      status: 'hit',
      fingerprint: packed.manifest.assemblyContract.sourceFingerprint,
      byteCount: packed.payload.byteLength,
      manifest: packed.manifest,
      payloadPath,
      payloadSha256: packed.manifest.integrity.payloadSha256,
      payloadIdentity: await payloadIdentityFor(payloadPath),
      sourceContinuity: [],
    };
    let openCount = 0;
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => (releaseRead = resolve));
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => (markReadStarted = resolve));
    let blockOnce = true;
    const deps = {
      async openFile(path: string): Promise<AssemblyAnnotationSearchQueryFile> {
        openCount += 1;
        const handle = await open(path, 'r');
        return {
          stat: () => handle.stat({ bigint: true }),
          close: () => handle.close(),
          async read(buffer, byteOffset, byteLength, position) {
            if (
              blockOnce &&
              position >= packed.manifest.sections.postingFeatureIndices.byteOffset
            ) {
              blockOnce = false;
              markReadStarted();
              await readGate;
            }
            return handle.read(buffer, byteOffset, byteLength, position);
          },
        };
      },
    };
    const controller = new AbortController();
    const cancellation = new Error('superseded annotation query');
    cancellation.name = 'AbortError';
    const cancelledQuery = queryAssemblyAnnotationSearchIndexHitOrMiss(hit, 'common', 500, {
      ...deps,
      signal: controller.signal,
    });

    await readStarted;
    controller.abort(cancellation);
    releaseRead();

    await expect(cancelledQuery).rejects.toBe(cancellation);
    await expect(
      queryAssemblyAnnotationSearchIndexHit(hit, 'common-999', 500, deps)
    ).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ label: 'COMMON-999' })]));
    expect(openCount).toBe(1);
  });

  it('never closes an LRU-evicted file while a query still holds its lease', async () => {
    const packed = await packPrepackedAnnotationSearchIndexV1({
      datasetContract: {
        datasetId: 'grch38-annotations',
        datasetVersion: '1',
        sourceSha256: 'a'.repeat(64),
      },
      assemblyContract: {
        assemblyId: 'GRCh38',
        assemblyLengthBp: 3_088_269_832,
        placementSignature: 'test-placement',
        sourceFingerprint: 'd'.repeat(24),
      },
      trackType: 'annotation',
      features: Array.from({ length: 1_000 }, (_, index) => ({
        sourceOrdinal: index,
        type: 'gene',
        ...searchIdentity('gene', index),
        start: index * 1_000,
        end: index * 1_000 + 100,
        displayName: index === 500 ? 'HBB' : `GENE-${index}`,
      })),
    });
    const root = await mkdtemp(join(tmpdir(), 'waypoint-search-lease-'));
    temporaryRoots.push(root);
    const paths = [0, 1, 2].map((index) => join(root, `annotation-search-${index}.bin`));
    await Promise.all(paths.map((path) => writeFile(path, packed.payload)));
    const payloadIdentities = new Map(
      await Promise.all(paths.map(async (path) => [path, await payloadIdentityFor(path)] as const))
    );

    let unblockFirstRead!: () => void;
    const firstReadGate = new Promise<void>((resolve) => (unblockFirstRead = resolve));
    let markFirstReadBlocked!: () => void;
    const firstReadBlocked = new Promise<void>((resolve) => (markFirstReadBlocked = resolve));
    let firstReadIsBlocked = false;
    const closeCounts = new Map<string, number>();
    const deps = {
      async openFile(path: string): Promise<AssemblyAnnotationSearchQueryFile> {
        const handle = await open(path, 'r');
        return {
          stat: () => handle.stat({ bigint: true }),
          async close() {
            closeCounts.set(path, (closeCounts.get(path) ?? 0) + 1);
            await handle.close();
          },
          async read(buffer, byteOffset, byteLength, position) {
            if (
              path === paths[0] &&
              !firstReadIsBlocked &&
              position >= packed.manifest.sections.postingFeatureIndices.byteOffset
            ) {
              firstReadIsBlocked = true;
              markFirstReadBlocked();
              await firstReadGate;
            }
            return handle.read(buffer, byteOffset, byteLength, position);
          },
        };
      },
    };
    const hitFor = (payloadPath: string): AssemblyAnnotationSearchCacheIndexHit => ({
      status: 'hit',
      fingerprint: packed.manifest.assemblyContract.sourceFingerprint,
      byteCount: packed.payload.byteLength,
      manifest: packed.manifest,
      payloadPath,
      payloadSha256: packed.manifest.integrity.payloadSha256,
      payloadIdentity: payloadIdentities.get(payloadPath)!,
      sourceContinuity: [],
    });

    const firstQuery = queryAssemblyAnnotationSearchIndexHit(hitFor(paths[0]), 'HBB', 500, deps);
    await firstReadBlocked;
    await queryAssemblyAnnotationSearchIndexHit(hitFor(paths[1]), 'HBB', 500, deps);
    await queryAssemblyAnnotationSearchIndexHit(hitFor(paths[2]), 'HBB', 500, deps);
    expect(closeCounts.get(paths[0]) ?? 0).toBe(0);

    unblockFirstRead();
    await expect(firstQuery).resolves.toHaveLength(1);
    await disposeAssemblyAnnotationSearchQuerySessions();
    expect(closeCounts.get(paths[0])).toBe(1);
  });

  it('rejects a renamed replacement before open as an exact miss and closes once', async () => {
    const packed = await packPrepackedAnnotationSearchIndexV1({
      datasetContract: {
        datasetId: 'grch38-annotations',
        datasetVersion: '1',
        sourceSha256: 'a'.repeat(64),
      },
      assemblyContract: {
        assemblyId: 'GRCh38',
        assemblyLengthBp: 3_088_269_832,
        placementSignature: 'test-placement',
        sourceFingerprint: 'e'.repeat(24),
      },
      trackType: 'annotation',
      features: [
        {
          type: 'gene',
          ...searchIdentity('gene'),
          start: 100,
          end: 200,
          displayName: 'HBB',
        },
      ],
    });
    const root = await mkdtemp(join(tmpdir(), 'waypoint-search-replace-'));
    temporaryRoots.push(root);
    const payloadPath = join(root, 'annotation-search.bin');
    await writeFile(payloadPath, packed.payload);
    const payloadIdentity = await payloadIdentityFor(payloadPath);
    const replacementPath = join(root, 'replacement.bin');
    await writeFile(replacementPath, packed.payload);
    await rename(replacementPath, payloadPath);

    let closeCount = 0;
    const hit: AssemblyAnnotationSearchCacheIndexHit = {
      status: 'hit',
      fingerprint: packed.manifest.assemblyContract.sourceFingerprint,
      byteCount: packed.payload.byteLength,
      manifest: packed.manifest,
      payloadPath,
      payloadSha256: packed.manifest.integrity.payloadSha256,
      payloadIdentity,
      sourceContinuity: [],
    };
    const result = await queryAssemblyAnnotationSearchIndexHitOrMiss(hit, 'HBB', 500, {
      async openFile(path): Promise<AssemblyAnnotationSearchQueryFile> {
        const handle = await open(path, 'r');
        return {
          stat: () => handle.stat({ bigint: true }),
          read: (buffer, byteOffset, byteLength, position) =>
            handle.read(buffer, byteOffset, byteLength, position),
          async close() {
            closeCount += 1;
            await handle.close();
          },
        };
      },
    });

    expect(result).toEqual({ status: 'miss', fingerprint: hit.fingerprint });
    await disposeAssemblyAnnotationSearchQuerySessions();
    expect(closeCount).toBe(1);
  });

  it('rejects a same-size in-place mutation during a query as an exact miss and closes once', async () => {
    const packed = await packPrepackedAnnotationSearchIndexV1({
      datasetContract: {
        datasetId: 'grch38-annotations',
        datasetVersion: '1',
        sourceSha256: 'a'.repeat(64),
      },
      assemblyContract: {
        assemblyId: 'GRCh38',
        assemblyLengthBp: 3_088_269_832,
        placementSignature: 'test-placement',
        sourceFingerprint: 'f'.repeat(24),
      },
      trackType: 'annotation',
      features: Array.from({ length: 1_000 }, (_, index) => ({
        sourceOrdinal: index,
        type: 'gene',
        ...searchIdentity('gene', index),
        start: index * 1_000,
        end: index * 1_000 + 100,
        displayName: index === 500 ? 'HBB' : `GENE-${index}`,
      })),
    });
    const root = await mkdtemp(join(tmpdir(), 'waypoint-search-mutate-'));
    temporaryRoots.push(root);
    const payloadPath = join(root, 'annotation-search.bin');
    await writeFile(payloadPath, packed.payload);
    const payloadIdentity = await payloadIdentityFor(payloadPath);

    let unblockRead!: () => void;
    const readGate = new Promise<void>((resolve) => (unblockRead = resolve));
    let markReadBlocked!: () => void;
    const readBlocked = new Promise<void>((resolve) => (markReadBlocked = resolve));
    let blocked = false;
    let closeCount = 0;
    const hit: AssemblyAnnotationSearchCacheIndexHit = {
      status: 'hit',
      fingerprint: packed.manifest.assemblyContract.sourceFingerprint,
      byteCount: packed.payload.byteLength,
      manifest: packed.manifest,
      payloadPath,
      payloadSha256: packed.manifest.integrity.payloadSha256,
      payloadIdentity,
      sourceContinuity: [],
    };
    const query = queryAssemblyAnnotationSearchIndexHitOrMiss(hit, 'HBB', 500, {
      async openFile(path): Promise<AssemblyAnnotationSearchQueryFile> {
        const handle = await open(path, 'r');
        return {
          stat: () => handle.stat({ bigint: true }),
          async read(buffer, byteOffset, byteLength, position) {
            if (!blocked && position >= packed.manifest.sections.postingFeatureIndices.byteOffset) {
              blocked = true;
              markReadBlocked();
              await readGate;
            }
            return handle.read(buffer, byteOffset, byteLength, position);
          },
          async close() {
            closeCount += 1;
            await handle.close();
          },
        };
      },
    });

    await readBlocked;
    const corrupt = new Uint8Array(packed.payload);
    corrupt[corrupt.byteLength - 1] ^= 0xff;
    await writeFile(payloadPath, corrupt);
    unblockRead();

    await expect(query).resolves.toEqual({ status: 'miss', fingerprint: hit.fingerprint });
    await disposeAssemblyAnnotationSearchQuerySessions();
    expect(closeCount).toBe(1);
  });
});
