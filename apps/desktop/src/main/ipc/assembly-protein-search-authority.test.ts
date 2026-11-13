import { describe, expect, it, vi } from 'vitest';

import {
  ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
  type AssemblyAnnotationSceneReadRequest,
  type AssemblyProteinSearchQueryResultV1,
} from '../../shared/indexed-genome';
import type { AssemblyProteinSearchCacheIndexHit } from './assembly-protein-search-cache';
import { AssemblyProteinSearchAuthority } from './assembly-protein-search-authority';

function source(manifestRevision = 'a'): AssemblyAnnotationSceneReadRequest {
  return {
    ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
    assemblyId: 'GRCh38',
    workspaceRoot: '/workspace',
    chromosomes: [
      {
        chrom: 'chr11',
        length: 135_086_622,
        sourcePath: '/source/chr11.gff3',
        manifest: {
          chrom: 'chr11',
          fastaPath: `/source/chr11-${manifestRevision}.fa`,
          faiPath: `/source/chr11-${manifestRevision}.fa.fai`,
          gffPath: '/source/chr11.gff3',
          tbiPath: `/source/chr11-${manifestRevision}.gff3.tbi`,
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

function cacheHit(revision: number): AssemblyProteinSearchCacheIndexHit {
  return {
    status: 'hit',
    fingerprint: String(revision).repeat(24).slice(0, 24),
    byteCount: 1_024,
    work: {} as never,
    manifest: { featureCount: 1 } as never,
    payloadPath: '/workspace/protein-search.bin',
    payloadSha256: 'b'.repeat(64),
    payloadIdentity: {
      size: '1024',
      mtimeNs: String(revision),
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

function queryHit(fingerprint: string): AssemblyProteinSearchQueryResultV1 {
  return {
    status: 'hit',
    fingerprint,
    featureCount: 1,
    matches: [],
    truncated: false,
    limit: 500,
  };
}

describe('assembly protein search sessionized authority', () => {
  it('bounds callers retained by one unsettled authority producer', async () => {
    const authority = new AssemblyProteinSearchAuthority();
    let resolveLoad!: (value: null) => void;
    const readCacheIndex = vi.fn(
      async () =>
        new Promise<null>((resolve) => {
          resolveLoad = resolve;
        })
    );
    const deps = {
      assertSafePath: vi.fn(async () => {}),
      readCacheIndex,
    };
    const exactSource = source();
    const pending = Array.from({ length: 8 }, () =>
      authority.query(exactSource, 'PEPTI', 500, undefined, deps)
    );

    await expect(authority.query(exactSource, 'PEPTI', 500, undefined, deps)).rejects.toThrow(
      'Protein search authority claimant capacity is full'
    );
    expect(readCacheIndex).toHaveBeenCalledOnce();

    resolveLoad(null);
    await expect(Promise.all(pending)).resolves.toEqual(Array(8).fill(null));
    await vi.waitFor(() => expect(authority.residentCountForTests()).toBe(0));
  });

  it('makes the first query after successful rebuild use the newly published authority', async () => {
    const authority = new AssemblyProteinSearchAuthority();
    let publishedRevision = 1;
    const readCacheIndex = vi.fn(async () => cacheHit(publishedRevision));
    const queryCacheHit = vi.fn(async (hit: AssemblyProteinSearchCacheIndexHit) =>
      hit.fingerprint === cacheHit(publishedRevision).fingerprint
        ? queryHit(hit.fingerprint)
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

    await expect(
      authority.query(exactSource, 'PEPTI', 500, undefined, deps)
    ).resolves.toMatchObject({
      status: 'hit',
      fingerprint: cacheHit(1).fingerprint,
    });
    publishedRevision = 2;
    expect(authority.invalidate(exactSource)).toBe(true);

    await expect(
      authority.query(exactSource, 'TIDER', 500, undefined, deps)
    ).resolves.toMatchObject({
      status: 'hit',
      fingerprint: cacheHit(2).fingerprint,
    });
    expect(readCacheIndex).toHaveBeenCalledTimes(2);
    expect(authority.residentCountForTests()).toBe(1);
  });

  it('does not share a resident protein authority across distinct explicit manifests', async () => {
    const authority = new AssemblyProteinSearchAuthority();
    const readCacheIndex = vi.fn(async () => cacheHit(1));
    const deps = {
      assertSafePath: vi.fn(async () => {}),
      readCacheIndex,
      statSource: vi.fn(async () => ({
        size: 1_000,
        mtimeMs: 1,
        ctimeMs: 1,
      })),
      queryCacheHit: vi.fn(async (hit: AssemblyProteinSearchCacheIndexHit) =>
        queryHit(hit.fingerprint)
      ),
    };

    await authority.query(source('a'), 'PEPTI', 500, undefined, deps);
    await authority.query(source('b'), 'PEPTI', 500, undefined, deps);

    expect(readCacheIndex).toHaveBeenCalledTimes(2);
    expect(authority.residentCountForTests()).toBe(2);
  });
});
