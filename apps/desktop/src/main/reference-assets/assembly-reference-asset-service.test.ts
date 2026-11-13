import {
  PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
  PREPACKED_ANNOTATION_INTERACTION_TOKEN,
  PREPACKED_ANNOTATION_LANE_TOKEN,
  PREPACKED_ANNOTATION_MAPPER_TOKEN,
} from '@waypoint/genome-renderer/pure';
import { describe, expect, it, vi } from 'vitest';

import type { AssemblyAnnotationSceneReadRequest } from '../../shared/indexed-genome';
import type { AssemblyAnnotationProductSetManifestV2 } from '../ipc/assembly-annotation-product-set-manifest';
import { AssemblyReferenceAssetServiceV1 } from './assembly-reference-asset-service';

function request(trackType = 'mRNA'): AssemblyAnnotationSceneReadRequest {
  return {
    ipcContractVersion: 'assembly-annotation-scene-ipc.v4',
    assemblyId: 'grch38',
    workspaceRoot: '/workspace',
    chromosomes: [{ chrom: 'chr1', length: 100, sourcePath: '/workspace/chr1.gff3.gz' }],
    scope: {
      kind: 'complete-assembly',
      placements: [{ chrom: 'chr1', length: 100, annotationCoverage: 'sourced' }],
    },
    datasetContract: {
      datasetId: 'waypoint:assembly-annotation:grch38',
      datasetVersion: 'test',
      sourceSha256: 'a'.repeat(64),
    },
    artifact: {
      artifactKey: `${trackType}-light`,
      themeMode: 'light',
      trackType,
      partitionSpanBp: 1_000_000,
      annotationBarHeightPx: 10,
      laneAlgorithmToken: PREPACKED_ANNOTATION_LANE_TOKEN,
      mapperContractToken: PREPACKED_ANNOTATION_MAPPER_TOKEN,
      geometryContractToken: PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
      interactionContractToken: PREPACKED_ANNOTATION_INTERACTION_TOKEN,
    },
    requestedPolicy: { isoformMode: 'canonical', laneLimit: 2 },
  };
}

function publishedRequest(trackType = 'mRNA'): AssemblyAnnotationSceneReadRequest {
  return {
    ...request(trackType),
    expectedAssetGeneration: {
      contract: 'assembly-reference-asset-generation.v1',
      sourceFingerprint: 'a'.repeat(24),
      inventoryFingerprint: 'f'.repeat(64),
      themeMode: 'light',
    },
  };
}

const hit = {
  status: 'hit' as const,
  ipcContractVersion: 'assembly-annotation-scene-ipc.v4' as const,
  fingerprint: 'a'.repeat(24),
  sourceBuildFingerprint: 'b'.repeat(64),
  scope: request().scope,
  artifact: request().artifact,
  scenePath: '/workspace/scene.bin',
  payloadSha256: 'c'.repeat(64),
  placementFingerprint: `ap1:${'d'.repeat(24)}`,
  manifest: {
    byteLength: 1,
    integrity: { payloadSha256: 'c'.repeat(64), contractSha256: 'e'.repeat(64) },
  },
} as never;

const miss = {
  status: 'miss' as const,
  ipcContractVersion: 'assembly-annotation-scene-ipc.v4' as const,
  fingerprint: 'a'.repeat(24),
  sourceBuildFingerprint: 'b'.repeat(64),
};

const manifest = {
  contract: 'assembly-annotation-product-set-manifest.v2',
  assemblyId: 'grch38',
  themeMode: 'light',
  sourceFingerprint: 'a'.repeat(24),
  datasetContract: request().datasetContract,
  scope: request().scope,
  chromosomes: request().chromosomes,
  trackTypes: ['mRNA', 'lnc_RNA'],
  products: [],
  searchIndexes: {},
  inventoryFingerprint: 'f'.repeat(64),
} as unknown as AssemblyAnnotationProductSetManifestV2;

function deps() {
  return {
    inspectSourceInputs: vi.fn().mockResolvedValue({ status: 'ready' }),
    readSceneIndex: vi.fn().mockResolvedValue(hit),
    readProductSetManifest: vi.fn().mockResolvedValue(manifest),
    inspectProductSet: vi.fn().mockResolvedValue({ status: 'ready' }),
    verifyProductSet: vi.fn().mockResolvedValue({ status: 'ready' }),
    ensureSourceSummaries: vi.fn().mockResolvedValue(undefined),
    discoverProductRequests: vi.fn().mockResolvedValue([request('mRNA'), request('lnc_RNA')]),
    prepareProductSet: vi.fn().mockResolvedValue(undefined),
  };
}

describe('AssemblyReferenceAssetServiceV1', () => {
  it('admits a published runtime generation from the atomic commit without scanning siblings', async () => {
    const dependencies = deps();
    const service = new AssemblyReferenceAssetServiceV1(dependencies);

    await expect(service.status({ seedProduct: publishedRequest() })).resolves.toEqual({
      status: 'ready',
      generation: publishedRequest().expectedAssetGeneration,
      trackTypes: ['mRNA', 'lnc_RNA'],
    });

    expect(dependencies.readProductSetManifest).toHaveBeenCalledOnce();
    expect(dependencies.readProductSetManifest).toHaveBeenCalledWith(
      expect.anything(),
      'a'.repeat(24)
    );
    expect(dependencies.inspectSourceInputs).not.toHaveBeenCalled();
    expect(dependencies.readSceneIndex).not.toHaveBeenCalled();
    expect(dependencies.inspectProductSet).not.toHaveBeenCalled();
  });

  it('rejects a published generation that disagrees with the atomic commit', async () => {
    const dependencies = deps();
    const service = new AssemblyReferenceAssetServiceV1(dependencies);
    const seedProduct = publishedRequest();

    await expect(
      service.status({
        seedProduct: {
          ...seedProduct,
          expectedAssetGeneration: {
            ...seedProduct.expectedAssetGeneration!,
            inventoryFingerprint: '0'.repeat(64),
          },
        },
      })
    ).resolves.toMatchObject({
      status: 'needs-refresh',
      reason: 'generation-mismatch',
      sourceFingerprint: 'a'.repeat(24),
    });

    expect(dependencies.inspectProductSet).not.toHaveBeenCalled();
  });

  it('reports a complete generation without invoking any writer', async () => {
    const dependencies = deps();
    const service = new AssemblyReferenceAssetServiceV1(dependencies);

    await expect(service.status({ seedProduct: request() })).resolves.toEqual({
      status: 'ready',
      generation: {
        contract: 'assembly-reference-asset-generation.v1',
        sourceFingerprint: 'a'.repeat(24),
        inventoryFingerprint: 'f'.repeat(64),
        themeMode: 'light',
      },
      trackTypes: ['mRNA', 'lnc_RNA'],
    });
    expect(dependencies.ensureSourceSummaries).not.toHaveBeenCalled();
    expect(dependencies.discoverProductRequests).not.toHaveBeenCalled();
    expect(dependencies.prepareProductSet).not.toHaveBeenCalled();
    expect(dependencies.verifyProductSet).not.toHaveBeenCalled();
  });

  it('reports a missing source index before probing derived products', async () => {
    const dependencies = deps();
    dependencies.inspectSourceInputs.mockResolvedValue({
      status: 'stale',
      message: 'chr1 FASTA index is missing',
    });
    const service = new AssemblyReferenceAssetServiceV1(dependencies);

    await expect(service.status({ seedProduct: request() })).resolves.toEqual({
      status: 'needs-refresh',
      reason: 'source-index-missing',
      message: 'chr1 FASTA index is missing',
    });
    expect(dependencies.readSceneIndex).not.toHaveBeenCalled();
    expect(dependencies.prepareProductSet).not.toHaveBeenCalled();
  });

  it('refreshes a stale generation in the one legal order and verifies after publication', async () => {
    const dependencies = deps();
    dependencies.readSceneIndex
      .mockResolvedValueOnce(miss)
      .mockResolvedValueOnce(miss)
      .mockResolvedValue(hit)
      .mockResolvedValue(hit);
    dependencies.readProductSetManifest.mockResolvedValueOnce(null).mockResolvedValue(manifest);
    const phases: string[] = [];
    const service = new AssemblyReferenceAssetServiceV1(dependencies);

    await expect(
      service.ensure({ seedProduct: request(), onProgress: (phase) => phases.push(phase) })
    ).resolves.toMatchObject({ status: 'ready' });

    expect(phases).toEqual([
      'checking',
      'preparing-source-summaries',
      'discovering-annotation-tracks',
      'preparing-products',
      'verifying',
    ]);
    expect(dependencies.ensureSourceSummaries).toHaveBeenCalledBefore(
      dependencies.discoverProductRequests
    );
    expect(dependencies.discoverProductRequests).toHaveBeenCalledBefore(
      dependencies.prepareProductSet
    );
    expect(dependencies.readProductSetManifest.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      dependencies.prepareProductSet.mock.invocationCallOrder[0]
    );
    expect(dependencies.inspectProductSet).not.toHaveBeenCalled();
    expect(dependencies.verifyProductSet).not.toHaveBeenCalled();
  });

  it('coalesces concurrent refreshes of the same immutable identity', async () => {
    const dependencies = deps();
    dependencies.readSceneIndex.mockResolvedValue(miss);
    dependencies.readProductSetManifest.mockResolvedValue(null);
    let release!: () => void;
    dependencies.ensureSourceSummaries.mockImplementation(
      () => new Promise<void>((resolve) => (release = resolve))
    );
    const service = new AssemblyReferenceAssetServiceV1(dependencies);

    const first = service.ensure({ seedProduct: request() });
    const second = service.ensure({ seedProduct: request() });
    await vi.waitFor(() => expect(dependencies.ensureSourceSummaries).toHaveBeenCalledOnce());
    release();
    await Promise.all([first, second]);

    expect(dependencies.ensureSourceSummaries).toHaveBeenCalledOnce();
    expect(dependencies.prepareProductSet).toHaveBeenCalledOnce();
  });

  it('fails closed when a committed child artifact cannot be inspected', async () => {
    const dependencies = deps();
    dependencies.inspectProductSet.mockResolvedValue({
      status: 'stale',
      message: 'lnc_RNA broad catalog is missing',
    });
    const service = new AssemblyReferenceAssetServiceV1(dependencies);

    await expect(service.status({ seedProduct: request() })).resolves.toEqual({
      status: 'needs-refresh',
      reason: 'child-artifact-missing',
      message: 'lnc_RNA broad catalog is missing',
      sourceFingerprint: 'a'.repeat(24),
    });
  });

  it('does full verification only for the explicit verify boundary', async () => {
    const dependencies = deps();
    const service = new AssemblyReferenceAssetServiceV1(dependencies);

    await expect(service.verify({ seedProduct: request() })).resolves.toMatchObject({
      status: 'ready',
    });

    expect(dependencies.verifyProductSet).toHaveBeenCalledOnce();
  });

  it('admits a complete product set when the mRNA seed scene was never compiled', async () => {
    const geneManifest = {
      ...manifest,
      trackTypes: ['gene', 'tRNA'],
    } as unknown as AssemblyAnnotationProductSetManifestV2;
    const dependencies = deps();
    dependencies.readSceneIndex.mockResolvedValue(miss);
    dependencies.readProductSetManifest.mockResolvedValueOnce(null).mockResolvedValue(geneManifest);
    dependencies.discoverProductRequests.mockResolvedValue([request('gene'), request('tRNA')]);
    const service = new AssemblyReferenceAssetServiceV1(dependencies);

    await expect(service.ensure({ seedProduct: request('mRNA') })).resolves.toEqual({
      status: 'ready',
      generation: {
        contract: 'assembly-reference-asset-generation.v1',
        sourceFingerprint: 'a'.repeat(24),
        inventoryFingerprint: 'f'.repeat(64),
        themeMode: 'light',
      },
      trackTypes: ['gene', 'tRNA'],
    });
    expect(dependencies.prepareProductSet).toHaveBeenCalledOnce();
    await expect(service.verify({ seedProduct: request('mRNA') })).resolves.toMatchObject({
      status: 'ready',
      trackTypes: ['gene', 'tRNA'],
    });
    expect(dependencies.verifyProductSet).toHaveBeenCalledOnce();
  });
});
