import type { BufferEncodingOption, ObjectEncodingOptions, PathLike } from 'node:fs';
import { mkdtemp, rm, unlink, type realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildCompiledBroadSurfaceManifestV2,
  CompiledBroadSurfaceManifestV2,
  type PartitionedTranscriptSceneBinaryManifestV4,
} from '@waypoint/genome-renderer/pure';

import type { AssemblyAnnotationSceneReadRequest } from '../../shared/indexed-genome';
import {
  createAuthorizedCompiledBroadRasterScenePathGuard,
  prepareAssemblyCompiledBroadRasterWorkerJobV1,
  type AssemblyCompiledBroadRasterWorkerJobV1,
} from './assembly-compiled-broad-raster-worker-job';
import {
  COMPILED_BROAD_RASTER_OCCUPANCY_RGBA8_V1,
  CompiledBroadRasterArtifactError,
  openCompiledBroadRasterArtifactV1,
  publishCompiledBroadRasterArtifactV1,
  type CompiledBroadRasterCellAddressV1,
  type CompiledBroadRasterArtifactReaderV1,
  type CompiledBroadRasterSourceCellV1,
} from './compiled-broad-raster-artifact';

function realpathFake(resolvePath: (path: string) => Promise<string>): typeof realpath {
  function fake(
    path: PathLike,
    options?: ObjectEncodingOptions | BufferEncoding | null
  ): Promise<string>;
  function fake(path: PathLike, options: BufferEncodingOption): Promise<Buffer>;
  function fake(
    path: PathLike,
    options?: ObjectEncodingOptions | BufferEncoding | null
  ): Promise<string | Buffer>;
  async function fake(
    path: PathLike,
    options?: ObjectEncodingOptions | BufferEncodingOption | BufferEncoding | null
  ): Promise<string | Buffer> {
    const resolved = await resolvePath(String(path));
    return options === 'buffer' || (typeof options === 'object' && options?.encoding === 'buffer')
      ? Buffer.from(resolved)
      : resolved;
  }
  return fake;
}

const SOURCE_FINGERPRINT = 'a'.repeat(24);
const PAYLOAD_SHA = 'b'.repeat(64);
const SURFACE_FINGERPRINT = 'c'.repeat(64);
const CATALOG_FINGERPRINT = 'd'.repeat(64);

const REQUEST = {
  assemblyId: 'grch38',
  workspaceRoot: '/ws',
  chromosomes: [{ chrom: 'chr1', sourcePath: '/ws/chr1.gff3.gz', length: 1_000 }],
  datasetContract: {
    datasetId: 'grch38-refseq',
    datasetVersion: '1',
    sourceSha256: 'e'.repeat(64),
  },
  artifact: { trackType: 'mRNA', partitionSpanBp: 1_000 },
} as AssemblyAnnotationSceneReadRequest;

const SCENE_MANIFEST = {
  byteLength: 4,
  sourcePrimitiveCount: 0,
  partitionSpanBp: 1_000,
  datasetContract: REQUEST.datasetContract,
  assemblyContract: { assemblyId: 'grch38', assemblyLengthBp: 1_000 },
  directContract: {
    expanded: { instanceCount: 0 },
    canonical: { instanceCount: 0 },
  },
  sections: {
    expandedFineBankRecordIndices: { count: 0 },
    canonicalFineBankRecordIndices: { count: 0 },
  },
  integrity: {
    payloadSha256: PAYLOAD_SHA,
    contractSha256: 'f'.repeat(64),
  },
} as unknown as PartitionedTranscriptSceneBinaryManifestV4;

const SURFACE = {
  manifestFingerprint: SURFACE_FINGERPRINT,
} as CompiledBroadSurfaceManifestV2;

const READER = {
  manifest: {
    catalogFingerprint: CATALOG_FINGERPRINT,
    surfaceManifest: SURFACE,
  },
} as CompiledBroadRasterArtifactReaderV1;

const JOB: AssemblyCompiledBroadRasterWorkerJobV1 = {
  request: REQUEST,
  sourceFingerprint: SOURCE_FINGERPRINT,
  scenePath: '/ws/scene.bin',
  authorizedSceneRealPath: '/real/scene.bin',
  sceneManifest: SCENE_MANIFEST,
  expectedPayloadSha256: PAYLOAD_SHA,
  expectedSurfaceManifestFingerprint: SURFACE_FINGERPRINT,
  forceRebuildExistingArtifact: false,
};

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })));
});

function baseDeps() {
  return {
    assertAuthorizedScenePath: vi.fn(async () => {}),
    readSceneFile: vi.fn(async () => new Uint8Array(4)),
    validateScene: vi.fn(async () => ({
      interactionIndexValidationCount: 1 as const,
      interactionFeatureScanCardinality: 0,
      couplingPrimitiveScanCardinality: 0,
      directFineIndexValidationCount: 2 as const,
      directFineIndexRecordScanCardinality: 0,
    })),
    buildSurfaceManifest: vi.fn(async () => SURFACE),
    resolveArtifactDirectory: vi.fn(() => '/ws/raster'),
  };
}

describe('compiled broad raster worker job', () => {
  it('rechecks the authorized realpath and rejects a changed target', async () => {
    const guard = createAuthorizedCompiledBroadRasterScenePathGuard(
      '/ws/scene.bin',
      '/real/original.bin',
      realpathFake(async () => '/real/replaced.bin')
    );
    await expect(guard('/ws/scene.bin')).rejects.toThrow(/changed scene path/);
    await expect(guard('/ws/other.bin')).rejects.toThrow(/unauthorized scene path/);
  });

  it('opens an exact companion with zero scene read, validation/hash, or compiler work', async () => {
    const deps = baseDeps();
    const compileAndPublish = vi.fn();
    const openArtifact = vi.fn(async () => READER);

    await expect(
      prepareAssemblyCompiledBroadRasterWorkerJobV1(JOB, {
        ...deps,
        openArtifact,
        compileAndPublish,
      })
    ).resolves.toEqual({
      status: 'already-present',
      sourceFingerprint: SOURCE_FINGERPRINT,
      surfaceManifestFingerprint: SURFACE_FINGERPRINT,
      catalogFingerprint: CATALOG_FINGERPRINT,
      quarantinedCorruptArtifact: false,
    });
    expect(deps.assertAuthorizedScenePath).not.toHaveBeenCalled();
    expect(deps.readSceneFile).not.toHaveBeenCalled();
    expect(deps.validateScene).not.toHaveBeenCalled();
    expect(compileAndPublish).not.toHaveBeenCalled();
  });

  it('quarantines a corrupt catalog and publishes a fresh readable companion', async () => {
    const deps = baseDeps();
    const compileAndPublish = vi.fn(async () => undefined);
    const quarantineArtifactDirectory = vi.fn(async () => true);
    const openArtifact = vi
      .fn()
      .mockRejectedValueOnce(
        new CompiledBroadRasterArtifactError('invalid-manifest', 'corrupt catalog')
      )
      .mockResolvedValueOnce(READER);

    await expect(
      prepareAssemblyCompiledBroadRasterWorkerJobV1(JOB, {
        ...deps,
        openArtifact,
        compileAndPublish,
        quarantineArtifactDirectory,
      })
    ).resolves.toMatchObject({
      status: 'published',
      quarantinedCorruptArtifact: true,
    });
    expect(quarantineArtifactDirectory).toHaveBeenCalledWith('/ws/raster');
    expect(compileAndPublish).toHaveBeenCalledTimes(1);
    expect(openArtifact).toHaveBeenCalledTimes(2);
    expect(deps.readSceneFile).toHaveBeenCalledTimes(1);
  });

  it('never performs the post-publication readable commit check after compiler failure', async () => {
    const deps = baseDeps();
    const openArtifact = vi
      .fn()
      .mockRejectedValueOnce(
        new CompiledBroadRasterArtifactError('artifact-not-found', 'missing catalog')
      );
    const compileAndPublish = vi.fn(async () => {
      throw new Error('injected worker crash during cell production');
    });

    await expect(
      prepareAssemblyCompiledBroadRasterWorkerJobV1(JOB, {
        ...deps,
        openArtifact,
        compileAndPublish,
      })
    ).rejects.toThrow('injected worker crash');
    expect(openArtifact).toHaveBeenCalledTimes(1);
  });

  it('converges a valid catalog with a deleted cell blob through quarantine and rebuild', async () => {
    const root = await mkdtemp(join(tmpdir(), 'waypoint-broad-raster-repair-'));
    temporaryRoots.push(root);
    const artifactDirectory = join(root, 'artifact');
    const surface = await buildCompiledBroadSurfaceManifestV2({
      artifactKey: 'grch38:mRNA:repair-fixture',
      trackId: 'mRNA',
      genomeLengthBp: 1_000,
      broadCorridorFinestSpanBp: 1_000,
      broadTilePhysicalWidthPx: 512,
      broadTileXGuardPhysicalPx: 1,
      prefetchRing: 1,
      maxQualifiedRasterMagnificationX: 1.75,
      rasterDevicePixelRatio: 1,
      laneSlabRowCount: 8,
      laneRowCssHeightPx: 16,
      laneRowTextureStridePx: 16,
      laneRowTransparentTailGutterPx: 2,
      laneRowCounts: { canonical: 8, expanded: 8 },
    });
    const addresses = completeRoster(surface);
    const sources = sourceCells(surface, addresses);
    const published = await publishCompiledBroadRasterArtifactV1({
      artifactDirectory,
      surfaceManifest: surface,
      cells: sources,
    });
    const deleted = published.cells.find((cell) => cell.fileName !== null);
    if (!deleted?.fileName) throw new Error('repair fixture did not publish an occupied cell');
    await unlink(join(artifactDirectory, deleted.fileName));

    const staleReader = await openCompiledBroadRasterArtifactV1({
      artifactDirectory,
      expectedSurfaceManifestFingerprint: surface.manifestFingerprint,
    });
    await expect(staleReader.readCells([addresses[0]])).rejects.toMatchObject({
      code: 'artifact-not-found',
    });

    const repairJob: AssemblyCompiledBroadRasterWorkerJobV1 = {
      ...JOB,
      expectedSurfaceManifestFingerprint: surface.manifestFingerprint,
      forceRebuildExistingArtifact: true,
    };
    const result = await prepareAssemblyCompiledBroadRasterWorkerJobV1(repairJob, {
      assertAuthorizedScenePath: async () => {},
      readSceneFile: async () => new Uint8Array(4),
      validateScene: baseDeps().validateScene,
      buildSurfaceManifest: async () => surface,
      resolveArtifactDirectory: () => artifactDirectory,
      compileAndPublish: async () => {
        await publishCompiledBroadRasterArtifactV1({
          artifactDirectory,
          surfaceManifest: surface,
          cells: sourceCells(surface, addresses),
        });
        return undefined;
      },
    });
    expect(result).toMatchObject({
      status: 'published',
      quarantinedCorruptArtifact: true,
    });
    const repairedReader = await openCompiledBroadRasterArtifactV1({
      artifactDirectory,
      expectedSurfaceManifestFingerprint: surface.manifestFingerprint,
    });
    await expect(repairedReader.readCells([addresses[0]])).resolves.toHaveLength(1);
  });
});

function completeRoster(
  manifest: CompiledBroadSurfaceManifestV2
): CompiledBroadRasterCellAddressV1[] {
  const result: CompiledBroadRasterCellAddressV1[] = [];
  for (const isoformMode of ['canonical', 'expanded'] as const) {
    for (const level of manifest.levels) {
      for (let tileX = 0; tileX < level.tileCount; tileX += 1) {
        for (const slab of manifest.laneSlabs[isoformMode]) {
          result.push({
            isoformMode,
            level: level.level,
            tileX,
            laneSlabIndex: slab.slabIndex,
          });
        }
      }
    }
  }
  return result;
}

function sourceCells(
  manifest: CompiledBroadSurfaceManifestV2,
  addresses: readonly CompiledBroadRasterCellAddressV1[]
): CompiledBroadRasterSourceCellV1[] {
  const widthPx = manifest.broadTilePhysicalWidthPx + manifest.broadTileXGuardPhysicalPx * 2;
  const heightPx = manifest.laneSlabRowCount * manifest.laneRowTextureStridePx;
  return addresses.map((address, index) => {
    const premultipliedRgba = new Uint8Array(widthPx * heightPx * 4);
    premultipliedRgba.set([index + 1, index + 1, index + 1, 255], 0);
    return {
      ...address,
      occupancy: COMPILED_BROAD_RASTER_OCCUPANCY_RGBA8_V1,
      premultipliedRgba,
    };
  });
}
