import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  compiledBroadSurfaceCellIdV2,
  type PartitionedTranscriptSceneBinaryManifestV4,
} from '@waypoint/genome-renderer/pure';

import {
  ASSEMBLY_COMPILED_BROAD_RASTER_CATALOG_CAPABILITY_V1,
  ASSEMBLY_COMPILED_BROAD_RASTER_CATALOG_RECEIPT_V1,
  ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
  COMPILED_BROAD_RASTER_ARTIFACT_WIRE_V1,
  COMPILED_BROAD_RASTER_PIXEL_FORMAT_WIRE_V1,
  COMPILED_BROAD_RASTER_OCCUPANCY_RGBA8_WIRE_V1,
  assemblyAnnotationSceneInteractionOwnerKeyV3,
  buildAssemblyCompiledBroadRasterSurfaceManifestV1,
  type AssemblyAnnotationSceneArtifactContract,
  type AssemblyReferenceAssetGenerationV1,
} from '../../../shared/indexed-genome';

const platformHarness = vi.hoisted(() => ({
  readManifest: vi.fn(),
  readCells: vi.fn(),
  prepareAppearance: vi.fn(),
}));

vi.mock('../../../platform', () => ({
  platform: () => ({
    genome: {
      readAssemblyCompiledBroadRasterManifestV1: platformHarness.readManifest,
      readAssemblyCompiledBroadRasterCellsV1: platformHarness.readCells,
      prepareAssemblyAnnotationAppearanceV1: platformHarness.prepareAppearance,
    },
  }),
}));

import {
  NOT_APPLICABLE_ASSEMBLY_PREPACKED_ANNOTATION_SCENE_CACHE,
  type AssemblyPrepackedAnnotationSceneCacheState,
} from './useAssemblyPrepackedAnnotationSceneCache';
import type { CompiledBroadRasterRendererV1 } from './assembly-compiled-broad-raster-loader';
import {
  activeAssemblyCompiledBroadRasterTargetV1,
  useAssemblyCompiledBroadRasterSurface,
} from './useAssemblyCompiledBroadRasterSurface';

const SOURCE_FINGERPRINT = '1'.repeat(24);
const RECEIPT_SHA256 = '7'.repeat(64);
const PREPACKED_OWNER_KEY = assemblyAnnotationSceneInteractionOwnerKeyV3({
  sourceFingerprint: SOURCE_FINGERPRINT,
  scenePayloadSha256: '2'.repeat(64),
  sceneArtifactKey: 'fixture-artifact',
})!;

function artifact(): AssemblyAnnotationSceneArtifactContract {
  return {
    artifactKey: 'fixture-artifact',
    themeMode: 'dark',
    trackType: 'mRNA',
    partitionSpanBp: 1,
    annotationBarHeightPx: 1,
    laneAlgorithmToken: 'lane',
    mapperContractToken: 'mapper',
    geometryContractToken: 'geometry',
    interactionContractToken: 'interaction',
  };
}

function sceneManifest(): PartitionedTranscriptSceneBinaryManifestV4 {
  return {
    schema: 'partitioned-transcript-scene-binary.v4',
    datasetContract: {
      datasetId: 'fixture',
      datasetVersion: 'fixture-v1',
      sourceSha256: '4'.repeat(64),
    },
    assemblyContract: { assemblyId: 'grch38', assemblyLengthBp: 3_088_286_401 },
    directContract: {
      expanded: { maxTrackLane: 31 },
      canonical: { maxTrackLane: 15 },
    },
    integrity: {
      algorithm: 'sha256',
      contractSha256: '5'.repeat(64),
      payloadSha256: '2'.repeat(64),
    },
  } as unknown as PartitionedTranscriptSceneBinaryManifestV4;
}

function cache(): AssemblyPrepackedAnnotationSceneCacheState {
  const scene = sceneManifest();
  const artifactContract = artifact();
  const descriptor = {
    sourceIdentity: 'fixture-source',
    placementFingerprint: `ap1:${'3'.repeat(24)}`,
    datasetContract: {
      datasetId: 'fixture',
      datasetVersion: 'fixture-v1',
      sourceSha256: '4'.repeat(64),
    },
    artifact: artifactContract,
    runtimeCacheKey: 'fixture-runtime',
    sceneKey: 'fixture-scene',
    request: {
      ipcContractVersion: 'assembly-annotation-scene-ipc.v4',
      workspaceRoot: '/fixture/workspace',
      assemblyId: 'grch38',
      chromosomes: [
        {
          chrom: 'chr-fixture',
          length: 3_088_286_401,
          sourcePath: '/fixture/workspace/chr-fixture.gff',
        },
      ],
      scope: {
        kind: 'complete-assembly',
        placements: [
          { chrom: 'chr-fixture', length: 3_088_286_401, annotationCoverage: 'sourced' },
        ],
      },
      datasetContract: {
        datasetId: 'fixture',
        datasetVersion: 'fixture-v1',
        sourceSha256: '4'.repeat(64),
      },
      artifact: artifactContract,
      requestedPolicy: { isoformMode: 'canonical', laneLimit: 12 },
    },
  };
  return {
    status: 'hit',
    descriptor,
    result: {
      status: 'hit',
      fingerprint: SOURCE_FINGERPRINT,
      sourceBuildFingerprint: 'fixture-build',
      ipcContractVersion: 'assembly-annotation-scene-ipc.v4',
      scope: descriptor.request.scope,
      artifact: artifactContract,
      byteCount: 1,
      manifest: scene,
      payload: new Uint8Array(1),
    },
    error: null,
    lifecycle: {} as never,
  } as AssemblyPrepackedAnnotationSceneCacheState;
}

describe('useAssemblyCompiledBroadRasterSurface', () => {
  it('prepares legacy source aliases and removes the binding immediately when the exact source changes', async () => {
    const original = cache();
    const sourceBinding = {
      payloadSha256: original.result!.manifest.integrity.payloadSha256,
      contractSha256: original.result!.manifest.integrity.contractSha256,
      aliases: [{ featureIndex: 0, aliases: ['glcF.gene.1', 'b1007'] }],
    };
    platformHarness.prepareAppearance.mockResolvedValueOnce({ status: 'ready', sourceBinding });
    const options = {
      enabled: true,
      prepareAnnotationAliases: true,
      assemblyRequirement: null,
      policy: { isoformMode: 'expanded' as const, laneLimit: null },
      rendererReadyEpoch: 0,
      rendererGenomeCommitEpoch: 0,
      webglRef: { current: null },
      recordEvent: vi.fn(),
    };
    const view = renderHook(
      ({ cacheState }) => useAssemblyCompiledBroadRasterSurface({ ...options, cache: cacheState }),
      { initialProps: { cacheState: original } }
    );
    await waitFor(() => expect(view.result.current.annotationSourceBinding).toEqual(sourceBinding));
    expect(platformHarness.prepareAppearance).toHaveBeenLastCalledWith(
      expect.objectContaining({ prepareAliasesOnly: true, scene: original.descriptor!.request })
    );
    const changed = {
      ...original,
      result: {
        ...original.result!,
        manifest: {
          ...original.result!.manifest,
          integrity: { ...original.result!.manifest.integrity, contractSha256: 'a'.repeat(64) },
        },
      },
    } as AssemblyPrepackedAnnotationSceneCacheState;
    platformHarness.prepareAppearance.mockResolvedValueOnce({ status: 'ready', sourceBinding });
    view.rerender({ cacheState: changed });
    expect(view.result.current.annotationSourceBinding).toBeNull();
    await waitFor(() => expect(platformHarness.prepareAppearance).toHaveBeenCalledTimes(2));
    expect(view.result.current.annotationSourceBinding).toBeNull();
    view.unmount();
  });

  it('derives the same visual raster target while the independent V4 cache is unresolved or failed', () => {
    const hit = cache();
    const loading = {
      ...hit,
      status: 'loading',
      result: null,
      error: null,
    } as AssemblyPrepackedAnnotationSceneCacheState;
    const failed = {
      ...hit,
      status: 'error',
      result: null,
      error: new Error('independent V4 failure'),
    } as AssemblyPrepackedAnnotationSceneCacheState;
    const policy = { isoformMode: 'expanded' as const, laneLimit: 8 };

    const loadingTarget = activeAssemblyCompiledBroadRasterTargetV1(loading, policy);
    const failedTarget = activeAssemblyCompiledBroadRasterTargetV1(failed, policy);

    expect(loadingTarget).toMatchObject({
      sceneRequest: hit.descriptor!.request,
      artifact: hit.descriptor!.artifact,
      policy,
    });
    expect(failedTarget).toEqual(loadingTarget);

    const firstPublication = activeAssemblyCompiledBroadRasterTargetV1(loading, policy, null, {
      contract: 'assembly-reference-asset-generation.v1',
      sourceFingerprint: 'a'.repeat(24),
      inventoryFingerprint: 'b'.repeat(64),
      themeMode: 'dark',
    });
    const replacementPublication = activeAssemblyCompiledBroadRasterTargetV1(
      loading,
      policy,
      null,
      {
        contract: 'assembly-reference-asset-generation.v1',
        sourceFingerprint: 'a'.repeat(24),
        inventoryFingerprint: 'c'.repeat(64),
        themeMode: 'dark',
      }
    );
    expect(replacementPublication?.identityKey).toBe(firstPublication?.identityKey);
    expect(replacementPublication?.expectedAssetGeneration?.inventoryFingerprint).toBe(
      'c'.repeat(64)
    );

    const oppositeDisplayThemePublication = activeAssemblyCompiledBroadRasterTargetV1(
      loading,
      policy,
      null,
      {
        contract: 'assembly-reference-asset-generation.v1',
        sourceFingerprint: 'a'.repeat(24),
        inventoryFingerprint: 'c'.repeat(64),
        themeMode: 'light',
      }
    );
    expect(oppositeDisplayThemePublication?.identityKey).toBe(firstPublication?.identityKey);
    expect(oppositeDisplayThemePublication?.expectedAssetGeneration?.themeMode).toBe('light');
  });

  it('presents Expanded/8 from the sealed raster while V4 is unresolved or failed, then switches warmed lanes without reload', async () => {
    const surface = await buildAssemblyCompiledBroadRasterSurfaceManifestV1({
      sceneManifest: sceneManifest(),
      artifact: artifact(),
    });
    const catalogCapability = {
      contract: ASSEMBLY_COMPILED_BROAD_RASTER_CATALOG_CAPABILITY_V1,
      openingId: 'fixture-opening',
      catalogReceiptSha256: RECEIPT_SHA256,
      catalogFingerprint: '8'.repeat(64),
      surfaceManifestFingerprint: surface.manifestFingerprint,
    } as const;
    platformHarness.readManifest.mockResolvedValue({
      contract: COMPILED_BROAD_RASTER_ARTIFACT_WIRE_V1,
      catalogReceipt: {
        contract: ASSEMBLY_COMPILED_BROAD_RASTER_CATALOG_RECEIPT_V1,
        receiptSha256: RECEIPT_SHA256,
        genomeIdentity: 'fixture-source',
        genomeLengthBp: 3_088_286_401,
        sourceFingerprint: SOURCE_FINGERPRINT,
        placementFingerprint: `ap1:${'3'.repeat(24)}`,
        scenePayloadSha256: '2'.repeat(64),
        sceneContractSha256: '5'.repeat(64),
        sceneSourceBuildFingerprint: 'fixture-build',
        surfaceManifestFingerprint: surface.manifestFingerprint,
        catalogFingerprint: catalogCapability.catalogFingerprint,
        sceneArtifactKey: 'fixture-artifact',
        surfaceArtifactKey: surface.artifactKey,
        themeMode: 'dark',
        trackId: 'mRNA',
        expectedInteractionOwnerKey: PREPACKED_OWNER_KEY,
        pixelFormat: COMPILED_BROAD_RASTER_PIXEL_FORMAT_WIRE_V1,
        bytesPerPixel: 4,
        storedCellWidthPx: surface.broadTilePhysicalWidthPx + surface.broadTileXGuardPhysicalPx * 2,
        storedCellHeightPx: surface.laneSlabRowCount * surface.laneRowTextureStridePx,
        cellCount:
          surface.levels.reduce((sum, level) => sum + level.tileCount, 0) *
          (surface.laneSlabs.canonical.length + surface.laneSlabs.expanded.length),
        rasterDevicePixelRatio: surface.rasterDevicePixelRatio,
        tileContentWidthPx: surface.broadTilePhysicalWidthPx,
        tileGuardWidthPx: surface.broadTileXGuardPhysicalPx,
        laneSlabRowCount: surface.laneSlabRowCount,
        laneRowTextureStridePx: surface.laneRowTextureStridePx,
      },
      catalogCapability,
      surfaceManifest: surface,
    });
    const address = { isoformMode: 'expanded' as const, level: 0, tileX: 0, laneSlabIndex: 0 };
    const cellId = compiledBroadSurfaceCellIdV2({ manifest: surface, ...address });
    const storedWidthPx = surface.broadTilePhysicalWidthPx + surface.broadTileXGuardPhysicalPx * 2;
    const storedHeightPx = surface.laneSlabRowCount * surface.laneRowTextureStridePx;
    platformHarness.readCells.mockImplementation(async (request) => ({
      contract: ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
      status: 'ready' as const,
      catalogCapability: request.catalogCapability,
      cells: [
        {
          record: {
            ...request.addresses[0]!,
            cellId,
            trackId: 'mRNA',
            laneSlabId: surface.laneSlabs.expanded[0]!.slabId,
            widthPx: storedWidthPx,
            heightPx: storedHeightPx,
            occupancy: COMPILED_BROAD_RASTER_OCCUPANCY_RGBA8_WIRE_V1,
            decodedByteLength: storedWidthPx * storedHeightPx * 4,
            decodedSha256: '9'.repeat(64),
          },
          premultipliedRgba: new Uint8Array(storedWidthPx * storedHeightPx * 4),
        },
      ],
    }));
    const resident = new Set<string>();
    let admittedAuthority: Readonly<{
      genomeIdentity: string;
      genomeLengthBp: number;
      sourceFingerprint: string;
      placementFingerprint: string;
    }> | null = null;
    const renderer: CompiledBroadRasterRendererV1 = {
      requireCompiledBroadSurface: vi.fn(() => true),
      admitCompiledBroadSurfaceSourcePlacementAuthority: vi.fn((authority) => {
        admittedAuthority = { ...authority };
        return true;
      }),
      loadCompiledBroadSurfaceManifest: vi.fn((_manifest, provenance) =>
        Boolean(
          admittedAuthority &&
          admittedAuthority.genomeIdentity === provenance.genomeIdentity &&
          admittedAuthority.sourceFingerprint === provenance.sourceFingerprint &&
          admittedAuthority.placementFingerprint === provenance.placementFingerprint
        )
      ),
      updateAnnotationPresentationPolicy: vi.fn(
        (policy) =>
          policy.isoformMode !== 'expanded' ||
          (policy.laneLimit !== 8 && policy.laneLimit !== 24) ||
          resident.has(cellId)
      ),
      getCompiledBroadSurfaceDemand: vi.fn((policy) => {
        const resolved = policy ?? { isoformMode: 'canonical' as const, laneLimit: 12 };
        const usesExpandedCell =
          resolved.isoformMode === 'expanded' &&
          (resolved.laneLimit === 8 || resolved.laneLimit === 24 || resolved.laneLimit === 64);
        const requiredCellAddresses = usesExpandedCell ? [{ ...address, cellId }] : [];
        const missingRequiredCellAddresses = resident.has(cellId) ? [] : requiredCellAddresses;
        return {
          contract: 'compiled-broad-surface-demand.v2',
          status: 'broad-ready' as const,
          demandLeaseId: `fixture-lease:${resolved.isoformMode}:${resolved.laneLimit}`,
          cameraEpoch: 1,
          manifestFingerprint: surface.manifestFingerprint,
          artifactKey: surface.artifactKey,
          trackId: surface.trackId,
          isoformMode: resolved.isoformMode,
          laneLimit: resolved.laneLimit,
          viewportStartBp: 0,
          viewportEndBp: surface.genomeLengthBp,
          viewportCssWidthPx: 1_600,
          devicePixelRatio: surface.rasterDevicePixelRatio,
          requiredCellAddresses,
          missingRequiredCellAddresses,
          successorCellAddresses: [],
          missingSuccessorCellAddresses: [],
          interactionPrefetchCellAddresses: [],
          missingInteractionPrefetchCellAddresses: [],
          prefetchCellAddresses: [],
          missingPrefetchCellAddresses: [],
          missingCellAddresses: missingRequiredCellAddresses,
        };
      }),
      admitCompiledBroadSurfaceRgbaCell: vi.fn((cell) => {
        resident.add(cell.cellId);
        return {
          status: 'admitted',
          explicitCopyByteLength: 0,
          uploadedByteLength: cell.premultipliedRgba.byteLength,
        };
      }),
      admitCompiledBroadSurfaceTransparentCell: vi.fn(() => ({
        status: 'admitted',
        explicitCopyByteLength: 0,
        uploadedByteLength: 0,
      })),
      reconcileCompiledBroadSurfaceResidentLeases: vi.fn(() => ({
        status: 'reconciled',
        cameraEpoch: 1,
        retainedCellCount: resident.size,
        evictedCellIds: [],
      })),
      clearCompiledBroadSurfaceManifest: vi.fn(),
      clearCompiledBroadSurfaceRequirement: vi.fn(),
    };
    const requestRender = vi.fn();
    let postPresentWork: ((deadlineMs: number) => void) | null = null;
    const schedulePostPresentWork = vi.fn((work: (deadlineMs: number) => void) => {
      postPresentWork = work;
    });
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer as never,
        requestRender,
        schedulePostPresentWork,
      },
    };
    const recordEvent = vi.fn();
    let assetGeneration: AssemblyReferenceAssetGenerationV1 | null = null;
    const assemblyRequirement = {
      identityKey: 'indexed-full-assembly:grch38',
      genomeLengthBp: 3_088_286_401,
    } as const;
    const annotationCache = cache();
    const loadingCache = {
      ...annotationCache,
      status: 'loading',
      result: null,
      error: null,
    } as AssemblyPrepackedAnnotationSceneCacheState;
    const errorCache = {
      ...annotationCache,
      status: 'error',
      result: null,
      error: new Error('V4 failed independently'),
    } as AssemblyPrepackedAnnotationSceneCacheState;
    const wrongLaterInteractionCache = {
      ...annotationCache,
      result: {
        ...annotationCache.result!,
        fingerprint: 'f'.repeat(24),
        manifest: {
          ...annotationCache.result!.manifest,
          integrity: {
            ...annotationCache.result!.manifest.integrity,
            payloadSha256: 'a'.repeat(64),
          },
        },
      },
    } as AssemblyPrepackedAnnotationSceneCacheState;
    const onPolicyCommitted = vi.fn();
    const view = renderHook(
      ({ cacheState, enabled, laneLimit, policyRequestId }) =>
        useAssemblyCompiledBroadRasterSurface({
          enabled,
          cache: cacheState,
          assetGeneration,
          assemblyRequirement,
          policy: { isoformMode: 'expanded', laneLimit },
          policyRequestId,
          rendererReadyEpoch: 1,
          rendererGenomeCommitEpoch: 1,
          webglRef,
          recordEvent,
          onPolicyCommitted,
        }),
      {
        initialProps: {
          cacheState: loadingCache,
          enabled: true,
          laneLimit: 8,
          policyRequestId: 41,
        },
      }
    );

    await waitFor(() => expect(platformHarness.readCells).toHaveBeenCalledOnce());
    await waitFor(() => expect(postPresentWork).not.toBeNull());
    await waitFor(
      () => {
        act(() => {
          const work = postPresentWork;
          postPresentWork = null;
          work?.(Number.POSITIVE_INFINITY);
        });
        expect(view.result.current.readiness).toBe('ready');
      },
      { timeout: 5_000 }
    );
    expect(view.result.current.expectedInteractionOwnerKey).toBe(PREPACKED_OWNER_KEY);
    assetGeneration = {
      contract: 'assembly-reference-asset-generation.v1',
      sourceFingerprint: SOURCE_FINGERPRINT,
      inventoryFingerprint: '9'.repeat(64),
      themeMode: 'dark',
    };
    view.rerender({
      cacheState: loadingCache,
      enabled: true,
      laneLimit: 8,
      policyRequestId: 41,
    });
    await waitFor(() =>
      expect(view.result.current.validatedSourceFingerprint).toBe(SOURCE_FINGERPRINT)
    );
    expect(platformHarness.readManifest).toHaveBeenCalledTimes(1);
    expect(renderer.admitCompiledBroadSurfaceSourcePlacementAuthority).toHaveBeenCalledBefore(
      vi.mocked(renderer.loadCompiledBroadSurfaceManifest)
    );
    expect(renderer.loadCompiledBroadSurfaceManifest).toHaveBeenCalledWith(
      surface,
      expect.objectContaining({
        manifestFingerprint: surface.manifestFingerprint,
        artifactKey: surface.artifactKey,
        trackId: surface.trackId,
        genomeIdentity: 'fixture-source',
        genomeLengthBp: 3_088_286_401,
        sourceFingerprint: SOURCE_FINGERPRINT,
        placementFingerprint: `ap1:${'3'.repeat(24)}`,
        prepackedOwnerKey: PREPACKED_OWNER_KEY,
        prepackedArtifactKey: 'fixture-artifact',
      })
    );
    expect(platformHarness.readManifest).toHaveBeenCalledWith({
      contract: ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
      scene: annotationCache.descriptor!.request,
    });
    expect(renderer.updateAnnotationPresentationPolicy).toHaveBeenCalledWith({
      isoformMode: 'expanded',
      laneLimit: 8,
    });
    expect(
      vi.mocked(renderer.admitCompiledBroadSurfaceRgbaCell).mock.invocationCallOrder[0]
    ).toBeLessThan(
      vi.mocked(renderer.updateAnnotationPresentationPolicy).mock.invocationCallOrder[0]!
    );
    expect(requestRender).toHaveBeenCalled();
    expect(onPolicyCommitted).toHaveBeenCalledWith(
      expect.objectContaining({
        policyRequestId: 41,
        policy: { isoformMode: 'expanded', laneLimit: 8 },
      })
    );
    const getDiagnostics = view.result.current.getDiagnostics;
    expect(getDiagnostics()).toMatchObject({
      contract: 'assembly-compiled-broad-raster-loader-diagnostics.v1',
      readiness: 'ready',
      maxCellTransportResponseCellCount: 1,
      maxCellTransportResponseByteLength: storedWidthPx * storedHeightPx * 4,
    });

    const demandSnapshotsBeforeIndependentCacheLifecycle = vi.mocked(
      renderer.getCompiledBroadSurfaceDemand
    ).mock.calls.length;
    view.rerender({ cacheState: errorCache, enabled: true, laneLimit: 8, policyRequestId: 41 });
    expect(view.result.current.getDiagnostics).toBe(getDiagnostics);
    await waitFor(() => expect(view.result.current.readiness).toBe('ready'));
    expect(renderer.getCompiledBroadSurfaceDemand).toHaveBeenCalledTimes(
      demandSnapshotsBeforeIndependentCacheLifecycle
    );
    view.rerender({
      cacheState: wrongLaterInteractionCache,
      enabled: true,
      laneLimit: 8,
      policyRequestId: 41,
    });
    await waitFor(() => expect(view.result.current.readiness).toBe('ready'));
    expect(renderer.getCompiledBroadSurfaceDemand).toHaveBeenCalledTimes(
      demandSnapshotsBeforeIndependentCacheLifecycle
    );
    view.rerender({
      cacheState: annotationCache,
      enabled: true,
      laneLimit: 24,
      policyRequestId: 42,
    });
    await waitFor(() =>
      expect(renderer.updateAnnotationPresentationPolicy).toHaveBeenLastCalledWith({
        isoformMode: 'expanded',
        laneLimit: 24,
      })
    );
    expect(platformHarness.readManifest).toHaveBeenCalledTimes(1);
    expect(platformHarness.readCells).toHaveBeenCalledTimes(1);
    expect(renderer.loadCompiledBroadSurfaceManifest).toHaveBeenCalledTimes(1);
    expect(renderer.admitCompiledBroadSurfaceSourcePlacementAuthority).toHaveBeenCalledTimes(1);
    expect(onPolicyCommitted).toHaveBeenLastCalledWith(
      expect.objectContaining({
        policyRequestId: 42,
        policy: { isoformMode: 'expanded', laneLimit: 24 },
      })
    );
    expect(view.result.current.readiness).toBe('ready');

    const transientDescriptorGap = {
      ...NOT_APPLICABLE_ASSEMBLY_PREPACKED_ANNOTATION_SCENE_CACHE,
      status: 'loading',
    } as AssemblyPrepackedAnnotationSceneCacheState;
    view.rerender({
      cacheState: transientDescriptorGap,
      enabled: true,
      laneLimit: 24,
      policyRequestId: 42,
    });
    await waitFor(() => expect(view.result.current.targetIdentityKey).toBeNull());
    expect(view.result.current.readiness).toBe('ready');

    view.rerender({
      cacheState: annotationCache,
      enabled: true,
      laneLimit: 24,
      policyRequestId: 42,
    });
    await waitFor(() => expect(view.result.current.targetIdentityKey).not.toBeNull());
    expect(platformHarness.readManifest).toHaveBeenCalledTimes(1);
    expect(renderer.loadCompiledBroadSurfaceManifest).toHaveBeenCalledTimes(1);

    view.rerender({
      cacheState: transientDescriptorGap,
      enabled: false,
      laneLimit: 24,
      policyRequestId: 42,
    });
    await waitFor(() => expect(view.result.current.readiness).toBe('idle'));
  });

  it('arms broad ownership before any scene or raster cache hit exists', () => {
    platformHarness.readManifest.mockClear();
    platformHarness.readCells.mockClear();
    const renderer: CompiledBroadRasterRendererV1 = {
      requireCompiledBroadSurface: vi.fn(() => true),
      admitCompiledBroadSurfaceSourcePlacementAuthority: vi.fn(() => true),
      loadCompiledBroadSurfaceManifest: vi.fn(() => true),
      updateAnnotationPresentationPolicy: vi.fn(() => true),
      getCompiledBroadSurfaceDemand: vi.fn(() => null),
      admitCompiledBroadSurfaceRgbaCell: vi.fn(() => ({
        status: 'admitted',
        explicitCopyByteLength: 0,
        uploadedByteLength: 0,
      })),
      admitCompiledBroadSurfaceTransparentCell: vi.fn(() => ({
        status: 'admitted',
        explicitCopyByteLength: 0,
        uploadedByteLength: 0,
      })),
      reconcileCompiledBroadSurfaceResidentLeases: vi.fn(() => ({
        status: 'reconciled',
        cameraEpoch: 1,
        retainedCellCount: 0,
        evictedCellIds: [],
      })),
      clearCompiledBroadSurfaceRequirement: vi.fn(),
    };
    const webglRef = {
      current: {
        getLinearRenderer: () => renderer as never,
        requestRender: vi.fn(),
        schedulePostPresentWork: vi.fn(),
      },
    };

    renderHook(() =>
      useAssemblyCompiledBroadRasterSurface({
        enabled: true,
        cache: NOT_APPLICABLE_ASSEMBLY_PREPACKED_ANNOTATION_SCENE_CACHE,
        assemblyRequirement: {
          identityKey: 'indexed-full-assembly:grch38',
          genomeLengthBp: 3_088_286_401,
        },
        policy: { isoformMode: 'canonical', laneLimit: 12 },
        rendererReadyEpoch: 1,
        rendererGenomeCommitEpoch: 1,
        webglRef,
        recordEvent: vi.fn(),
      })
    );

    expect(renderer.requireCompiledBroadSurface).toHaveBeenCalledWith({
      genomeLengthBp: 3_088_286_401,
      broadCorridorFinestSpanBp: 16_000_000,
    });
    expect(platformHarness.readManifest).not.toHaveBeenCalled();
    expect(renderer.loadCompiledBroadSurfaceManifest).not.toHaveBeenCalled();
  });
});
