import { describe, expect, it, vi } from 'vitest';

import {
  ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
  type AssemblyAnnotationSceneReadRequest,
  type AssemblyAnnotationSearchQueryResultV1,
} from '../../shared/indexed-genome';
import type { AssemblyAnnotationSearchCacheIndexHit } from './assembly-annotation-search-cache';
import { AssemblyAnnotationSearchAuthority } from './assembly-annotation-search-authority';

function source(sourcePath = '/source/chr11.gff3'): AssemblyAnnotationSceneReadRequest {
  return {
    ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
    assemblyId: 'GRCh38',
    workspaceRoot: '/workspace',
    chromosomes: [
      {
        chrom: 'chr11',
        length: 135_086_622,
        sourcePath,
        manifest: {
          chrom: 'chr11',
          length: 135_086_622,
          fastaPath: '/source/chr11.fa',
          faiPath: '/source/chr11.fa.fai',
          gffPath: sourcePath,
          tbiPath: `${sourcePath}.tbi`,
        },
      },
    ],
    scope: {
      kind: 'complete-assembly',
      placements: [{ chrom: 'chr11', length: 135_086_622, annotationCoverage: 'sourced' }],
    },
    datasetContract: {
      datasetId: 'gencode',
      datasetVersion: '44',
      sourceSha256: 'a'.repeat(64),
    },
    artifact: {} as never,
    requestedPolicy: { isoformMode: 'expanded', laneLimit: 2 },
  };
}

function cacheHit(revision: number): AssemblyAnnotationSearchCacheIndexHit {
  return {
    status: 'hit',
    fingerprint: String(revision).repeat(24).slice(0, 24),
    byteCount: 1_024,
    manifest: { featureCount: 1 } as never,
    payloadPath: '/workspace/search.bin',
    payloadSha256: 'b'.repeat(64),
    payloadIdentity: {
      size: '1024',
      mtimeNs: '1',
      ctimeNs: '1',
      ino: '1',
      dev: '1',
    },
    sourceContinuity: [
      {
        sourcePath: '/source/chr11.gff3',
        size: 1_000,
        mtimeMs: revision,
        ctimeMs: 1,
      },
    ],
  };
}

function queryHit(fingerprint: string, label: string): AssemblyAnnotationSearchQueryResultV1 {
  return {
    status: 'hit',
    fingerprint,
    featureCount: 1,
    matches: [
      {
        featureIndex: 0,
        start: 100,
        end: 200,
        label,
        featureType: 'gene',
        annotationTrackId: 'gene',
        canonicalIdentity: 'annotation.v2:test-gene',
        direction: 'forward',
      },
    ],
    truncated: false,
  };
}

describe('assembly annotation search sessionized authority', () => {
  it('retains and bounds unsettled authority producers instead of LRU-dropping them', async () => {
    const authority = new AssemblyAnnotationSearchAuthority();
    const resolvers: Array<(value: null) => void> = [];
    const readCacheIndex = vi.fn(
      async () =>
        new Promise<null>((resolve) => {
          resolvers.push(resolve);
        })
    );
    const deps = {
      assertSafePath: vi.fn(async () => {}),
      readCacheIndex,
    };
    const pending = Array.from({ length: 8 }, (_, index) =>
      authority.query(source(`/safe/chr${index}.gff3.gz`), 'HBB', 500, undefined, deps)
    );

    expect(authority.residentCountForTests()).toBe(8);
    await expect(
      authority.query(source('/safe/overflow.gff3.gz'), 'HBB', 500, undefined, deps)
    ).rejects.toThrow('Annotation search authority preparation capacity is full');
    expect(readCacheIndex).toHaveBeenCalledTimes(8);

    for (const resolve of resolvers) resolve(null);
    await expect(Promise.all(pending)).resolves.toEqual(Array(8).fill(null));
    await vi.waitFor(() => expect(authority.residentCountForTests()).toBe(0));
  });

  it('admits the source once and uses one continuity stat per warm query', async () => {
    const authority = new AssemblyAnnotationSearchAuthority();
    const hit = cacheHit(1);
    const readCacheIndex = vi.fn(async () => hit);
    const statSource = vi.fn(async () => ({ size: 1_000, mtimeMs: 1, ctimeMs: 1 }));
    const queryCacheHit = vi.fn(async (_hit, query: string) => queryHit(hit.fingerprint, query));
    const deps = {
      assertSafePath: vi.fn(async () => {}),
      readCacheIndex,
      statSource,
      queryCacheHit,
    };

    await expect(authority.query(source(), 'HBB', 500, undefined, deps)).resolves.toMatchObject({
      status: 'hit',
    });
    await expect(authority.query(source(), 'BRCA1', 500, undefined, deps)).resolves.toMatchObject({
      status: 'hit',
    });

    expect(readCacheIndex).toHaveBeenCalledTimes(1);
    expect(queryCacheHit).toHaveBeenCalledTimes(2);
    expect(statSource).toHaveBeenCalledTimes(2);
    expect(authority.residentCountForTests()).toBe(1);
  });

  it('turns a changed source seal into a miss and re-admits on the next query', async () => {
    const authority = new AssemblyAnnotationSearchAuthority();
    let revision = 1;
    const readCacheIndex = vi.fn(async () => cacheHit(revision));
    const statSource = vi.fn(async () => ({ size: 1_000, mtimeMs: revision, ctimeMs: 1 }));
    const queryCacheHit = vi.fn(async (hit: AssemblyAnnotationSearchCacheIndexHit, query: string) =>
      queryHit(hit.fingerprint, query)
    );
    const deps = {
      assertSafePath: vi.fn(async () => {}),
      readCacheIndex,
      statSource,
      queryCacheHit,
    };

    await expect(authority.query(source(), 'HBB', 500, undefined, deps)).resolves.toMatchObject({
      status: 'hit',
    });
    revision = 2;
    await expect(authority.query(source(), 'BRCA1', 500, undefined, deps)).resolves.toEqual({
      status: 'miss',
      fingerprint: cacheHit(1).fingerprint,
    });
    await expect(authority.query(source(), 'TP53', 500, undefined, deps)).resolves.toMatchObject({
      status: 'hit',
      fingerprint: cacheHit(2).fingerprint,
    });

    expect(readCacheIndex).toHaveBeenCalledTimes(2);
  });

  it('makes the first query after successful rebuild use the newly published authority', async () => {
    const authority = new AssemblyAnnotationSearchAuthority();
    let publishedRevision = 1;
    const readCacheIndex = vi.fn(async () => cacheHit(publishedRevision));
    const queryCacheHit = vi.fn(
      async (hit: AssemblyAnnotationSearchCacheIndexHit, query: string) =>
        hit.fingerprint === cacheHit(publishedRevision).fingerprint
          ? queryHit(hit.fingerprint, query)
          : { status: 'miss' as const, fingerprint: hit.fingerprint }
    );
    const deps = {
      assertSafePath: vi.fn(async () => {}),
      readCacheIndex,
      statSource: vi.fn(async () => ({
        size: 1_000,
        mtimeMs: publishedRevision,
        ctimeMs: 1,
      })),
      queryCacheHit,
    };
    const exactSource = source();

    await expect(authority.query(exactSource, 'HBB', 500, undefined, deps)).resolves.toMatchObject({
      status: 'hit',
      fingerprint: cacheHit(1).fingerprint,
    });
    publishedRevision = 2;
    expect(authority.invalidate(exactSource)).toBe(true);

    await expect(
      authority.query(exactSource, 'BRCA1', 500, undefined, deps)
    ).resolves.toMatchObject({
      status: 'hit',
      fingerprint: cacheHit(2).fingerprint,
    });
    expect(readCacheIndex).toHaveBeenCalledTimes(2);
    expect(authority.residentCountForTests()).toBe(1);
  });

  it('does not share a resident authority across different explicit TBI manifests', async () => {
    const authority = new AssemblyAnnotationSearchAuthority();
    const readCacheIndex = vi.fn(async () => cacheHit(1));
    const deps = {
      assertSafePath: vi.fn(async () => {}),
      readCacheIndex,
      statSource: vi.fn(async () => ({ size: 1_000, mtimeMs: 1, ctimeMs: 1 })),
      queryCacheHit: vi.fn(async (hit: AssemblyAnnotationSearchCacheIndexHit, query: string) =>
        queryHit(hit.fingerprint, query)
      ),
    };
    const first = source();
    const second: AssemblyAnnotationSceneReadRequest = {
      ...first,
      chromosomes: [
        {
          ...first.chromosomes[0],
          manifest: {
            ...first.chromosomes[0].manifest!,
            tbiPath: '/source/chr11.replacement.gff3.tbi',
          },
        },
      ],
    };

    await authority.query(first, 'HBB', 500, undefined, deps);
    await authority.query(second, 'BRCA1', 500, undefined, deps);
    expect(readCacheIndex).toHaveBeenCalledTimes(2);
    expect(authority.residentCountForTests()).toBe(2);
  });

  it('retains an admitted authority when a query is superseded', async () => {
    const authority = new AssemblyAnnotationSearchAuthority();
    const hit = cacheHit(1);
    const readCacheIndex = vi.fn(async () => hit);
    let markQueryStarted!: () => void;
    const queryStarted = new Promise<void>((resolve) => (markQueryStarted = resolve));
    const queryCacheHit = vi
      .fn()
      .mockImplementationOnce(
        async (
          _hit: AssemblyAnnotationSearchCacheIndexHit,
          _query: string,
          _limit: number,
          { signal }: { signal?: AbortSignal }
        ) => {
          markQueryStarted();
          await new Promise<never>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        }
      )
      .mockImplementationOnce(async () => queryHit(hit.fingerprint, 'BRCA1'));
    const deps = {
      assertSafePath: vi.fn(async () => {}),
      readCacheIndex,
      statSource: vi.fn(async () => ({ size: 1_000, mtimeMs: 1, ctimeMs: 1 })),
      queryCacheHit,
    };
    const controller = new AbortController();
    const first = authority.query(source(), 'HBB', 500, controller.signal, deps);
    await queryStarted;
    const cancellation = new Error('superseded');
    cancellation.name = 'AbortError';
    controller.abort(cancellation);

    await expect(first).rejects.toBe(cancellation);
    await expect(authority.query(source(), 'BRCA1', 500, undefined, deps)).resolves.toMatchObject({
      status: 'hit',
    });
    expect(readCacheIndex).toHaveBeenCalledTimes(1);
  });
});
