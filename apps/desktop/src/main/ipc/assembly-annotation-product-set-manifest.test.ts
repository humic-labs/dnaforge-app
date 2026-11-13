import { describe, expect, it, vi } from 'vitest';

import {
  readAssemblyAnnotationProductSetManifestV2,
  writeAssemblyAnnotationProductSetManifestV2,
} from './assembly-annotation-product-set-manifest';
import type { AssemblyAnnotationSceneReadRequest } from '../../shared/indexed-genome';

const product = (
  trackType: string,
  artifactStatus: 'already-present' | 'published' = 'published'
) => ({
  trackType,
  artifactStatus,
  sourceFingerprint: 'a'.repeat(24),
  surfaceManifestFingerprint: 'b'.repeat(64),
  catalogFingerprint: 'c'.repeat(64),
});
const searchIndexes = {
  annotationSearch: {
    fingerprint: '1'.repeat(24),
    byteCount: 101,
    featureCount: 11,
    payloadSha256: '2'.repeat(64),
    contractSha256: '3'.repeat(64),
    schema: 'prepacked-annotation-search-index.v1',
    contractToken: 'annotation-search-contract.v1',
  },
  proteinSearch: {
    fingerprint: '4'.repeat(24),
    byteCount: 202,
    featureCount: 22,
    payloadSha256: '5'.repeat(64),
    contractSha256: '6'.repeat(64),
    schema: 'prepacked-protein-search-index.v1',
    contractToken: 'protein-search-contract.v1',
  },
} as const;

describe('assembly annotation product-set manifest', () => {
  it('writes a deterministic complete inventory to a temporary file and renames it last', async () => {
    const writes: Array<{ path: string; body: string }> = [];
    const rename = vi.fn(async () => undefined);
    const result = await writeAssemblyAnnotationProductSetManifestV2(
      {
        assemblyId: 'grch38',
        workspaceRoot: '/workspace',
        themeMode: 'light',
        datasetContract: {
          datasetId: 'grch38-annotations',
          datasetVersion: '1',
          sourceSha256: 'd'.repeat(64),
        },
        scope: { kind: 'complete-assembly', placements: [] },
        chromosomes: [],
        products: [product('mRNA'), product('enhancer', 'already-present'), product('lnc_RNA')],
        searchIndexes,
      },
      {
        assertSafePath: async () => undefined,
        mkdirImpl: vi.fn(async () => undefined),
        writeFileImpl: vi.fn(async (path, body) => {
          writes.push({ path: String(path), body: String(body) });
        }) as never,
        renameImpl: rename as never,
        unlinkImpl: vi.fn(async () => undefined),
        randomId: () => 'atomic',
      }
    );

    expect(result.inventoryFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toMatch(/\.atomic\.tmp$/);
    expect(JSON.parse(writes[0].body)).toMatchObject({
      trackTypes: ['enhancer', 'lnc_RNA', 'mRNA'],
      products: [
        expect.objectContaining({ trackType: 'enhancer', artifactStatus: 'published' }),
        expect.objectContaining({ trackType: 'lnc_RNA', artifactStatus: 'published' }),
        expect.objectContaining({ trackType: 'mRNA', artifactStatus: 'published' }),
      ],
      searchIndexes,
      inventoryFingerprint: result.inventoryFingerprint,
    });
    expect(rename).toHaveBeenCalledWith(
      expect.stringMatching(/\.atomic\.tmp$/),
      expect.stringMatching(/\.annotation-product-set\.v2\.json$/)
    );
  });

  it('refuses to publish an inventory with duplicate tracks or mixed source revisions', async () => {
    const base = {
      assemblyId: 'grch38',
      workspaceRoot: '/workspace',
      themeMode: 'light' as const,
      datasetContract: {
        datasetId: 'grch38-annotations',
        datasetVersion: '1',
        sourceSha256: 'd'.repeat(64),
      },
      scope: { kind: 'complete-assembly' as const, placements: [] },
      chromosomes: [],
    };
    const deps = { assertSafePath: async () => undefined };
    await expect(
      writeAssemblyAnnotationProductSetManifestV2(
        { ...base, products: [product('mRNA'), product('mRNA')], searchIndexes },
        deps
      )
    ).rejects.toThrow('unique');
    await expect(
      writeAssemblyAnnotationProductSetManifestV2(
        {
          ...base,
          products: [product('mRNA'), { ...product('lnc_RNA'), sourceFingerprint: 'e'.repeat(24) }],
          searchIndexes,
        },
        deps
      )
    ).rejects.toThrow('one source revision');
  });

  it('admits only the commit record bound to the current source and assembly request', async () => {
    let body = '';
    const base = {
      assemblyId: 'grch38',
      workspaceRoot: '/workspace',
      themeMode: 'light' as const,
      datasetContract: {
        datasetId: 'grch38-annotations',
        datasetVersion: '1',
        sourceSha256: 'd'.repeat(64),
      },
      scope: { kind: 'complete-assembly' as const, placements: [] },
      chromosomes: [],
    };
    await writeAssemblyAnnotationProductSetManifestV2(
      { ...base, products: [product('lnc_RNA'), product('mRNA')], searchIndexes },
      {
        assertSafePath: async () => undefined,
        mkdirImpl: vi.fn(async () => undefined),
        writeFileImpl: vi.fn(async (_path, value) => {
          body = String(value);
        }) as never,
        renameImpl: vi.fn(async () => undefined) as never,
        unlinkImpl: vi.fn(async () => undefined),
        randomId: () => 'atomic',
      }
    );
    const seedRequest = {
      ...base,
      ipcContractVersion: 'assembly-annotation-scene-ipc.v4',
      artifact: { themeMode: 'light' },
    } as unknown as AssemblyAnnotationSceneReadRequest;
    const readFileImpl = vi.fn(async () => body) as never;
    await expect(
      readAssemblyAnnotationProductSetManifestV2(
        { seedRequest, sourceFingerprint: 'a'.repeat(24) },
        { assertSafePath: async () => undefined, readFileImpl }
      )
    ).resolves.toMatchObject({ trackTypes: ['lnc_RNA', 'mRNA'] });
    await expect(
      readAssemblyAnnotationProductSetManifestV2(
        { seedRequest, sourceFingerprint: 'e'.repeat(24) },
        { assertSafePath: async () => undefined, readFileImpl }
      )
    ).resolves.toBeNull();
  });

  it('admits a content-identical prepared publication after its cache root is relocated', async () => {
    let body = '';
    const buildRoot = '/build-agent/reference-cache/grch38/generations/build-generation';
    const runtimeRoot = '/Users/scientist/reference-cache/grch38/generations/installed-generation';
    const chromosomeAt = (root: string) => ({
      chrom: 'chr1',
      sourcePath: `${root}/prepared/chr1/chr1.gff3.gz`,
      manifest: {
        chrom: 'chr1',
        fastaPath: `${root}/prepared/chr1/chr1.fa`,
        faiPath: `${root}/prepared/chr1/chr1.fa.fai`,
        gffPath: `${root}/prepared/chr1/chr1.gff3.gz`,
        tbiPath: `${root}/prepared/chr1/chr1.gff3.gz.tbi`,
        length: 248_956_422,
      },
      length: 248_956_422,
    });
    const base = {
      assemblyId: 'grch38',
      workspaceRoot: buildRoot,
      themeMode: 'light' as const,
      datasetContract: {
        datasetId: 'grch38-annotations',
        datasetVersion: '1',
        sourceSha256: 'd'.repeat(64),
      },
      scope: {
        kind: 'complete-assembly' as const,
        placements: [
          {
            chrom: 'chr1',
            length: 248_956_422,
            annotationCoverage: 'sourced' as const,
          },
        ],
      },
      chromosomes: [chromosomeAt(buildRoot)],
    };
    await writeAssemblyAnnotationProductSetManifestV2(
      { ...base, products: [product('mRNA')], searchIndexes },
      {
        assertSafePath: async () => undefined,
        mkdirImpl: vi.fn(async () => undefined),
        writeFileImpl: vi.fn(async (_path, value) => {
          body = String(value);
        }) as never,
        renameImpl: vi.fn(async () => undefined) as never,
        unlinkImpl: vi.fn(async () => undefined),
        randomId: () => 'atomic',
      }
    );
    const seedRequest = {
      ...base,
      workspaceRoot: runtimeRoot,
      chromosomes: [chromosomeAt(runtimeRoot)],
      ipcContractVersion: 'assembly-annotation-scene-ipc.v4',
      artifact: { themeMode: 'light' },
    } as unknown as AssemblyAnnotationSceneReadRequest;

    await expect(
      readAssemblyAnnotationProductSetManifestV2(
        { seedRequest, sourceFingerprint: 'a'.repeat(24) },
        {
          assertSafePath: async () => undefined,
          readFileImpl: vi.fn(async () => body) as never,
        }
      )
    ).resolves.toMatchObject({
      datasetContract: base.datasetContract,
      chromosomes: [expect.objectContaining({ sourcePath: expect.stringContaining(buildRoot) })],
    });
  });

  it('rejects old or incomplete visual-only manifests so open automatically rebuilds search indexes', async () => {
    const seedRequest = {
      assemblyId: 'grch38',
      workspaceRoot: '/workspace',
      datasetContract: {
        datasetId: 'grch38-annotations',
        datasetVersion: '1',
        sourceSha256: 'd'.repeat(64),
      },
      scope: { kind: 'complete-assembly', placements: [] },
      chromosomes: [],
      artifact: { themeMode: 'light' },
    } as unknown as AssemblyAnnotationSceneReadRequest;
    const oldManifest = {
      contract: 'assembly-annotation-product-set-manifest.v1',
      assemblyId: 'grch38',
      themeMode: 'light',
      sourceFingerprint: 'a'.repeat(24),
      datasetContract: seedRequest.datasetContract,
      scope: seedRequest.scope,
      chromosomes: seedRequest.chromosomes,
      trackTypes: ['mRNA'],
      products: [product('mRNA')],
      inventoryFingerprint: '0'.repeat(64),
    };

    await expect(
      readAssemblyAnnotationProductSetManifestV2(
        { seedRequest, sourceFingerprint: 'a'.repeat(24) },
        {
          assertSafePath: async () => undefined,
          readFileImpl: vi.fn(async () => JSON.stringify(oldManifest)) as never,
        }
      )
    ).resolves.toBeNull();
  });
});
