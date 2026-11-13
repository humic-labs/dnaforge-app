// @vitest-environment node

import {
  buildCompiledBroadSurfaceManifestV2,
  compiledBroadSurfaceCellIdV2,
  compiledBroadSurfaceOwnsViewportV2,
  type PartitionedTranscriptSceneBinaryManifestV4,
} from '@waypoint/genome-renderer/pure';
import { describe, expect, it } from 'vitest';

import {
  ASSEMBLY_COMPILED_BROAD_RASTER_CANONICAL_VIEWPORT_CSS_WIDTH_PX_V1,
  ASSEMBLY_COMPILED_BROAD_RASTER_CANONICAL_VIEWPORT_DEVICE_PIXEL_RATIO_V1,
  ASSEMBLY_COMPILED_BROAD_RASTER_CONFIG_V2,
  ASSEMBLY_COMPILED_BROAD_RASTER_CATALOG_CAPABILITY_V1,
  ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
  buildAssemblyCompiledBroadRasterSurfaceManifestV1,
  type AssemblyAnnotationSceneArtifactContract,
  type AssemblyCompiledBroadRasterCellsResultV1,
} from './indexed-genome';

const artifact: AssemblyAnnotationSceneArtifactContract = {
  artifactKey: 'mRNA:light',
  themeMode: 'light',
  trackType: 'mRNA',
  partitionSpanBp: 1,
  annotationBarHeightPx: 1,
  laneAlgorithmToken: 'lane',
  mapperContractToken: 'mapper',
  geometryContractToken: 'geometry',
  interactionContractToken: 'interaction',
};

function scene(
  payloadSha256: string,
  assemblyLengthBp = 3_088_269_832
): PartitionedTranscriptSceneBinaryManifestV4 {
  return {
    schema: 'partitioned-transcript-scene-binary.v4',
    datasetContract: {
      datasetId: 'grch38-refseq',
      datasetVersion: '1',
      sourceSha256: 'a'.repeat(64),
    },
    assemblyContract: { assemblyId: 'grch38', assemblyLengthBp },
    directContract: {
      canonical: { maxTrackLane: 21 },
      expanded: { maxTrackLane: 367 },
    },
    integrity: {
      algorithm: 'sha256',
      contractSha256: 'b'.repeat(64),
      payloadSha256,
    },
  } as unknown as PartitionedTranscriptSceneBinaryManifestV4;
}

describe('assembly compiled broad raster source identity', () => {
  it('gives small references enough native pixels to own the canonical whole-genome viewport', async () => {
    const surface = await buildAssemblyCompiledBroadRasterSurfaceManifestV1({
      sceneManifest: scene('8'.repeat(64), 2_686),
      artifact,
    });

    expect(surface.broadCorridorFinestSpanBp).toBe(573);
    expect(surface.levels.map(({ tileSpanBp, tileCount }) => [tileSpanBp, tileCount])).toEqual([
      [573, 5],
      [1_146, 3],
      [2_292, 2],
      [4_584, 1],
    ]);
    expect(
      compiledBroadSurfaceOwnsViewportV2({
        broadCorridorFinestSpanBp: surface.broadCorridorFinestSpanBp,
        viewportSpanBp: surface.genomeLengthBp,
        viewportCssWidthPx: ASSEMBLY_COMPILED_BROAD_RASTER_CANONICAL_VIEWPORT_CSS_WIDTH_PX_V1,
        devicePixelRatio: ASSEMBLY_COMPILED_BROAD_RASTER_CANONICAL_VIEWPORT_DEVICE_PIXEL_RATIO_V1,
      })
    ).toBe(true);
  });

  it('derives the same existing surface contract for any independently cached annotation track', async () => {
    const surface = await buildAssemblyCompiledBroadRasterSurfaceManifestV1({
      sceneManifest: scene('9'.repeat(64)),
      artifact: { ...artifact, artifactKey: 'lnc_RNA:light', trackType: 'lnc_RNA' },
    });

    expect(surface.trackId).toBe('lnc_RNA');
    expect(surface.artifactKey).toContain('lnc_RNA:light');
    expect(surface.laneRowCounts).toEqual({ canonical: 22, expanded: 64 });
  });

  it('derives the reviewed durable GRCh38 V4 fixture surface identity', async () => {
    const manifest = {
      datasetContract: {
        datasetId: 'waypoint:assembly-annotation:grch38',
        datasetVersion: 'resolved-annotation-v3:mapped-track-input.v1',
        sourceSha256: 'd2dab109aa66a64ef1ba10108ed020a1018669790bbf219bc30b4848fa19d1b8',
      },
      assemblyContract: { assemblyId: 'grch38', assemblyLengthBp: 3_088_269_832 },
      directContract: {
        canonical: { maxTrackLane: 21 },
        expanded: { maxTrackLane: 367 },
      },
      integrity: {
        algorithm: 'sha256',
        contractSha256: '62f862dec6c12ac390368d3d15fd1a6caa178a5078a8be224728afceb1c44cbc',
        payloadSha256: 'af9b69cdb3267befa26be26dfeafd4dcb262f0d78832e6772881595e71be1e5f',
      },
    } as unknown as PartitionedTranscriptSceneBinaryManifestV4;
    const exactArtifact: AssemblyAnnotationSceneArtifactContract = {
      artifactKey:
        'assembly-annotation-artifact.v4|theme:light|track:mRNA|partition:100000000|bar:14|lanes:source-lanes.v1|mapper:annotation-isoform-mapper.v2|geometry:retained-linear-directional-block.track-local.theme-final.v3|interaction:annotation-feature-hit-index.v3',
      themeMode: 'light',
      trackType: 'mRNA',
      partitionSpanBp: 100_000_000,
      annotationBarHeightPx: 14,
      laneAlgorithmToken: 'source-lanes.v1',
      mapperContractToken: 'annotation-isoform-mapper.v2',
      geometryContractToken: 'retained-linear-directional-block.track-local.theme-final.v3',
      interactionContractToken: 'annotation-feature-hit-index.v3',
    };

    const surface = await buildAssemblyCompiledBroadRasterSurfaceManifestV1({
      sceneManifest: manifest,
      artifact: exactArtifact,
    });
    expect(surface.manifestFingerprint).toBe(
      '1739ac98724f1b2bea4b2b16f3ac933234d7b21f9ac52fbcfc493cafff552d62'
    );
    expect(surface.genomeLengthBp).toBe(3_088_269_832);
    expect(surface.levels.map(({ tileSpanBp, tileCount }) => [tileSpanBp, tileCount])).toEqual([
      [16_000_000, 194],
      [32_000_000, 97],
      [64_000_000, 49],
      [128_000_000, 25],
      [256_000_000, 13],
      [512_000_000, 7],
      [1_024_000_000, 4],
      [2_048_000_000, 2],
      [4_096_000_000, 1],
    ]);
    expect(surface.laneRowCounts).toEqual({ canonical: 22, expanded: 64 });
    expect(surface.laneSlabs.canonical).toHaveLength(3);
    expect(surface.laneSlabs.expanded).toHaveLength(8);
    const xTileCount = surface.levels.reduce((sum, level) => sum + level.tileCount, 0);
    const cellCount =
      xTileCount * (surface.laneSlabs.canonical.length + surface.laneSlabs.expanded.length);
    expect(xTileCount).toBe(392);
    expect(cellCount).toBe(4_312);
  });

  it('invalidates the former lane-complete artifact identity even when every dimension matches', async () => {
    const current = await buildAssemblyCompiledBroadRasterSurfaceManifestV1({
      sceneManifest: scene('c'.repeat(64)),
      artifact,
    });
    const oldArtifactKey = current.artifactKey.replace(
      ASSEMBLY_COMPILED_BROAD_RASTER_CONFIG_V2,
      'assembly-compiled-broad-raster-config.v1'
    );
    const oldIdentity = await buildCompiledBroadSurfaceManifestV2({
      artifactKey: oldArtifactKey,
      trackId: current.trackId,
      genomeLengthBp: current.genomeLengthBp,
      broadCorridorFinestSpanBp: current.broadCorridorFinestSpanBp,
      broadTilePhysicalWidthPx: current.broadTilePhysicalWidthPx,
      broadTileXGuardPhysicalPx: current.broadTileXGuardPhysicalPx,
      prefetchRing: current.prefetchRing,
      maxQualifiedRasterMagnificationX: current.maxQualifiedRasterMagnificationX,
      rasterDevicePixelRatio: current.rasterDevicePixelRatio,
      laneSlabRowCount: current.laneSlabRowCount,
      laneRowCssHeightPx: current.laneRowCssHeightPx,
      laneRowTextureStridePx: current.laneRowTextureStridePx,
      laneRowTransparentTailGutterPx: current.laneRowTransparentTailGutterPx,
      laneRowCounts: current.laneRowCounts,
    });

    expect(current.artifactKey).toContain(ASSEMBLY_COMPILED_BROAD_RASTER_CONFIG_V2);
    expect(oldIdentity.manifestFingerprint).not.toBe(current.manifestFingerprint);
    expect(
      compiledBroadSurfaceCellIdV2({
        manifest: oldIdentity,
        isoformMode: 'expanded',
        level: 0,
        tileX: 0,
        laneSlabIndex: 0,
      })
    ).not.toBe(
      compiledBroadSurfaceCellIdV2({
        manifest: current,
        isoformMode: 'expanded',
        level: 0,
        tileX: 0,
        laneSlabIndex: 0,
      })
    );
  });

  it('cannot alias two source revisions with identical dimensions and lane counts', async () => {
    const first = await buildAssemblyCompiledBroadRasterSurfaceManifestV1({
      sceneManifest: scene('c'.repeat(64)),
      artifact,
    });
    const second = await buildAssemblyCompiledBroadRasterSurfaceManifestV1({
      sceneManifest: scene('d'.repeat(64)),
      artifact,
    });

    expect(first.genomeLengthBp).toBe(second.genomeLengthBp);
    expect(first.laneRowCounts).toEqual(second.laneRowCounts);
    expect(first.artifactKey).not.toBe(second.artifactKey);
    expect(first.manifestFingerprint).not.toBe(second.manifestFingerprint);
    expect(
      compiledBroadSurfaceCellIdV2({
        manifest: first,
        isoformMode: 'expanded',
        level: 0,
        tileX: 0,
        laneSlabIndex: 0,
      })
    ).not.toBe(
      compiledBroadSurfaceCellIdV2({
        manifest: second,
        isoformMode: 'expanded',
        level: 0,
        tileX: 0,
        laneSlabIndex: 0,
      })
    );
  });

  it('makes every cell transport outcome an exact discriminated lifecycle state', () => {
    const catalogCapability = {
      contract: ASSEMBLY_COMPILED_BROAD_RASTER_CATALOG_CAPABILITY_V1,
      openingId: 'opening-0000000000000001',
      catalogReceiptSha256: 'c'.repeat(64),
      catalogFingerprint: 'a'.repeat(64),
      surfaceManifestFingerprint: 'b'.repeat(64),
    } as const;
    const results: AssemblyCompiledBroadRasterCellsResultV1[] = [
      {
        contract: ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
        status: 'ready',
        catalogCapability,
        cells: [],
      },
      {
        contract: ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
        status: 'repairing',
        reason: 'artifact-corrupt',
        catalogCapability,
        retryAfterMs: 250,
      },
      {
        contract: ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
        status: 'unavailable',
        reason: 'repair-exhausted',
      },
    ];

    expect(results.map((result) => result.status)).toEqual(['ready', 'repairing', 'unavailable']);
    expect(results[1]).toMatchObject({
      reason: 'artifact-corrupt',
      retryAfterMs: 250,
    });
  });
});
