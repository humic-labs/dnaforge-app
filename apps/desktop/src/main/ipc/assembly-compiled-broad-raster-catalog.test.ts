import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  buildCompiledBroadSurfaceManifestV2,
  PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
  PREPACKED_ANNOTATION_INTERACTION_TOKEN,
  PREPACKED_ANNOTATION_LANE_TOKEN,
  PREPACKED_ANNOTATION_MAPPER_TOKEN,
  type CompiledBroadSurfaceManifestV2,
} from '@waypoint/genome-renderer/pure';
import { describe, expect, it, vi } from 'vitest';

import {
  ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
  ASSEMBLY_COMPILED_BROAD_RASTER_CATALOG_CAPABILITY_V1,
  ASSEMBLY_COMPILED_BROAD_RASTER_CATALOG_RECEIPT_V1,
  ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
  assemblyAnnotationSceneArtifactKey,
  type AssemblyAnnotationSceneReadRequest,
} from '../../shared/indexed-genome';
import type { AssemblyAnnotationSceneCacheIndexHit } from './assembly-overview-texture-cache';
import {
  AssemblyCompiledBroadRasterCatalogCapabilityRegistryV1,
  openAssemblyCompiledBroadRasterCatalogV1,
} from './assembly-compiled-broad-raster-catalog';
import {
  COMPILED_BROAD_RASTER_ARTIFACT_V1,
  COMPILED_BROAD_RASTER_COMPRESSION_V1,
  COMPILED_BROAD_RASTER_PIXEL_FORMAT_V1,
  type CompiledBroadRasterArtifactReaderV1,
} from './compiled-broad-raster-artifact';

const SOURCE_BUILD = 'b'.repeat(64);
const PAYLOAD_SHA = 'c'.repeat(64);
const CONTRACT_SHA = 'd'.repeat(64);
const CATALOG_SHA = 'e'.repeat(64);

const ARTIFACT = {
  artifactKey: assemblyAnnotationSceneArtifactKey({
    themeMode: 'light',
    trackType: 'mRNA',
    partitionSpanBp: 1_000_000,
    annotationBarHeightPx: 14,
    laneAlgorithmToken: PREPACKED_ANNOTATION_LANE_TOKEN,
    mapperContractToken: PREPACKED_ANNOTATION_MAPPER_TOKEN,
    geometryContractToken: PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
    interactionContractToken: PREPACKED_ANNOTATION_INTERACTION_TOKEN,
  }),
  themeMode: 'light',
  trackType: 'mRNA',
  partitionSpanBp: 1_000_000,
  annotationBarHeightPx: 14,
  laneAlgorithmToken: PREPACKED_ANNOTATION_LANE_TOKEN,
  mapperContractToken: PREPACKED_ANNOTATION_MAPPER_TOKEN,
  geometryContractToken: PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
  interactionContractToken: PREPACKED_ANNOTATION_INTERACTION_TOKEN,
} as const;

const SCENE: AssemblyAnnotationSceneReadRequest = {
  ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
  assemblyId: 'GRCh38',
  workspaceRoot: '/workspace',
  chromosomes: [{ chrom: 'chr1', length: 1_000, sourcePath: '/workspace/chr1.gff3.gz' }],
  scope: {
    kind: 'complete-assembly',
    placements: [{ chrom: 'chr1', length: 1_000, annotationCoverage: 'sourced' }],
  },
  datasetContract: {
    datasetId: 'gencode',
    datasetVersion: 'v-test',
    sourceSha256: 'a'.repeat(64),
  },
  artifact: ARTIFACT,
  requestedPolicy: { isoformMode: 'expanded', laneLimit: 8 },
};

const REQUEST = {
  contract: ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
  scene: SCENE,
} as const;

async function surfaceManifest(): Promise<CompiledBroadSurfaceManifestV2> {
  return buildCompiledBroadSurfaceManifestV2({
    artifactKey: 'GRCh38:mRNA:light:broad',
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
    laneRowCounts: { canonical: 8, expanded: 16 },
  });
}

function indexHit(sourceFingerprint: string): AssemblyAnnotationSceneCacheIndexHit {
  return {
    status: 'hit',
    ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
    fingerprint: sourceFingerprint,
    placementFingerprint: `ap1:${'f'.repeat(24)}`,
    sourceBuildFingerprint: SOURCE_BUILD,
    scope: SCENE.scope,
    artifact: SCENE.artifact,
    byteCount: 99,
    scenePath: `/workspace/${sourceFingerprint}.annotation-scene.v6.bin`,
    payloadSha256: PAYLOAD_SHA,
    manifest: {
      integrity: { algorithm: 'sha256', payloadSha256: PAYLOAD_SHA, contractSha256: CONTRACT_SHA },
    },
  } as unknown as AssemblyAnnotationSceneCacheIndexHit;
}

function reader(
  surface: CompiledBroadSurfaceManifestV2,
  catalogFingerprint = CATALOG_SHA
): CompiledBroadRasterArtifactReaderV1 {
  return {
    manifest: {
      contract: COMPILED_BROAD_RASTER_ARTIFACT_V1,
      catalogFingerprint,
      surfaceManifest: surface,
      pixelFormat: COMPILED_BROAD_RASTER_PIXEL_FORMAT_V1,
      compression: COMPILED_BROAD_RASTER_COMPRESSION_V1,
      storedWidthPx: 514,
      storedHeightPx: 128,
      bytesPerPixel: 4,
      cells: [
        {
          cellId: 'cell-0',
          trackId: 'mRNA',
          isoformMode: 'canonical',
          level: 0,
          tileX: 0,
          laneSlabId: 'canonical:0',
          laneSlabIndex: 0,
          occupancy: 'transparent',
          widthPx: 514,
          heightPx: 128,
          decodedByteLength: 0,
          decodedSha256: null,
          encodedByteLength: 0,
          encodedSha256: null,
          fileName: null,
        },
      ],
    },
    readCells: vi.fn(async () => []),
  };
}

describe('main-owned compiled broad raster catalog admission', () => {
  it('opens a valid catalog from index metadata without any V4 payload operation', async () => {
    const surface = await surfaceManifest();
    const admittedReader = reader(surface);
    const readSceneIndex = vi.fn(async () => indexHit('1'.repeat(24)));
    const openArtifact = vi.fn(async () => admittedReader);
    const forbiddenV4PayloadOperations = {
      readPayload: vi.fn(() => {
        throw new Error('V4 payload read is forbidden on manifest admission');
      }),
      hashPayload: vi.fn(() => {
        throw new Error('V4 payload hash is forbidden on manifest admission');
      }),
      validatePayload: vi.fn(() => {
        throw new Error('V4 payload validation is forbidden on manifest admission');
      }),
      issueSceneResource: vi.fn(() => {
        throw new Error('scene resource issuance is forbidden on manifest admission');
      }),
      compileVectors: vi.fn(() => {
        throw new Error('vector compilation is forbidden on manifest admission');
      }),
    };

    const opening = await openAssemblyCompiledBroadRasterCatalogV1(REQUEST, {
      assertSafePath: async () => {},
      sourceBuildFingerprint: SOURCE_BUILD,
      readSceneIndex,
      buildSurfaceManifest: async () => surface,
      artifactDirectory: ({ sourceFingerprint }) => `/workspace/raster/${sourceFingerprint}`,
      openArtifact,
      ...forbiddenV4PayloadOperations,
    });

    expect(opening?.reader).toBe(admittedReader);
    expect(readSceneIndex).toHaveBeenCalledTimes(1);
    expect(openArtifact).toHaveBeenCalledWith({
      artifactDirectory: `/workspace/raster/${'1'.repeat(24)}`,
      expectedSurfaceManifestFingerprint: surface.manifestFingerprint,
    });
    for (const operation of Object.values(forbiddenV4PayloadOperations)) {
      expect(operation).not.toHaveBeenCalled();
    }

    let openingOrdinal = 0;
    const registry = new AssemblyCompiledBroadRasterCatalogCapabilityRegistryV1({
      idFactory: () => `opening-${String(++openingOrdinal).padStart(16, '0')}`,
    });
    const issued = registry.issue(41, opening!);
    expect(issued).toMatchObject({
      catalogReceipt: {
        contract: ASSEMBLY_COMPILED_BROAD_RASTER_CATALOG_RECEIPT_V1,
        genomeIdentity: `assembly-annotation-source-sha256.v1:${'a'.repeat(64)}`,
        sourceFingerprint: '1'.repeat(24),
        placementFingerprint: `ap1:${'f'.repeat(24)}`,
        scenePayloadSha256: PAYLOAD_SHA,
        sceneContractSha256: CONTRACT_SHA,
        sceneSourceBuildFingerprint: SOURCE_BUILD,
        surfaceManifestFingerprint: surface.manifestFingerprint,
        catalogFingerprint: CATALOG_SHA,
        sceneArtifactKey: ARTIFACT.artifactKey,
        surfaceArtifactKey: surface.artifactKey,
        expectedInteractionOwnerKey: [
          'annotation-scene-owner.v3',
          '1'.repeat(24),
          PAYLOAD_SHA,
          ARTIFACT.artifactKey,
        ].join('\n'),
        storedCellWidthPx: 514,
        storedCellHeightPx: 128,
        cellCount: 1,
      },
      catalogCapability: {
        contract: ASSEMBLY_COMPILED_BROAD_RASTER_CATALOG_CAPABILITY_V1,
        openingId: 'opening-0000000000000001',
        catalogFingerprint: CATALOG_SHA,
        surfaceManifestFingerprint: surface.manifestFingerprint,
      },
    });
    expect(issued?.catalogReceipt.receiptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(registry.resolve(41, issued!.catalogCapability)?.opening).toBe(opening);
    expect(registry.resolve(42, issued!.catalogCapability)).toBeNull();
    expect(
      registry.resolve(41, {
        ...issued!.catalogCapability,
        catalogFingerprint: '0'.repeat(64),
      })
    ).toBeNull();
    const completeRoster = [issued!];
    for (let index = 1; index < 70; index += 1) {
      completeRoster.push(registry.issue(41, opening!)!);
    }
    expect(completeRoster.every(Boolean)).toBe(true);
    expect(registry.size).toBe(70);
    expect(registry.resolve(41, issued!.catalogCapability)?.opening).toBe(opening);
    registry.releaseOwner(41);
    expect(registry.resolve(41, issued!.catalogCapability)).toBeNull();
  });

  it('never shares an artifact opening between source revisions with the same surface', async () => {
    const surface = await surfaceManifest();
    const sourceA = '1'.repeat(24);
    const sourceB = '2'.repeat(24);
    let currentSource = sourceA;
    const readerA = reader(surface, '3'.repeat(64));
    const readerB = reader(surface, '4'.repeat(64));
    const openArtifact = vi.fn(async ({ artifactDirectory }: { artifactDirectory: string }) =>
      artifactDirectory.endsWith(sourceA) ? readerA : readerB
    );
    const readerCache = new Map<string, Promise<CompiledBroadRasterArtifactReaderV1>>();
    const deps = {
      assertSafePath: async () => {},
      sourceBuildFingerprint: SOURCE_BUILD,
      readSceneIndex: vi.fn(async () => indexHit(currentSource)),
      buildSurfaceManifest: async () => surface,
      artifactDirectory: ({ sourceFingerprint }: { sourceFingerprint: string }) =>
        `/workspace/raster/${sourceFingerprint}`,
      openArtifact,
      readerCache,
    };

    const openingA = await openAssemblyCompiledBroadRasterCatalogV1(REQUEST, deps);
    currentSource = sourceB;
    const openingB = await openAssemblyCompiledBroadRasterCatalogV1(REQUEST, deps);
    currentSource = sourceA;
    const openingAAgain = await openAssemblyCompiledBroadRasterCatalogV1(REQUEST, deps);

    expect(openingA?.reader).toBe(readerA);
    expect(openingB?.reader).toBe(readerB);
    expect(openingAAgain?.reader).toBe(readerA);
    expect(openingA?.readerRevisionKey).not.toBe(openingB?.readerRevisionKey);
    expect(openArtifact).toHaveBeenCalledTimes(2);
    expect(readerCache.size).toBe(2);

    let openingOrdinal = 0;
    const registry = new AssemblyCompiledBroadRasterCatalogCapabilityRegistryV1({
      idFactory: () => `opening-${String(++openingOrdinal).padStart(20, '0')}`,
    });
    const admittedA = registry.issue(41, openingA!);
    const admittedB = registry.issue(41, openingB!);
    expect(admittedA?.catalogReceipt.sourceFingerprint).toBe(sourceA);
    expect(admittedB?.catalogReceipt.sourceFingerprint).toBe(sourceB);
    expect(admittedA?.catalogReceipt.receiptSha256).not.toBe(
      admittedB?.catalogReceipt.receiptSha256
    );
    expect(registry.resolve(41, admittedA!.catalogCapability)?.opening.reader).toBe(readerA);
    expect(registry.resolve(41, admittedB!.catalogCapability)?.opening.reader).toBe(readerB);
  });

  it('keeps payload validation, resource capability, and vector compilation out of admission', () => {
    const implementation = readFileSync(
      resolve(__dirname, './assembly-compiled-broad-raster-catalog.ts'),
      'utf8'
    );
    expect(implementation).toContain('readAssemblyAnnotationSceneCacheIndex');
    expect(implementation).not.toContain('readAssemblyAnnotationSceneCacheResource');
    expect(implementation).not.toContain('validatePartitionedTranscriptSceneBinaryV4');
    expect(implementation).not.toContain('assemblyAnnotationSceneResourceRegistry');
    expect(implementation).not.toContain('compileBoundedAnnotationBroadSurfaceV2');
  });
});
