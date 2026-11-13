// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import {
  ASSEMBLY_COMPILED_BROAD_RASTER_CATALOG_CAPABILITY_V1,
  ASSEMBLY_COMPILED_BROAD_RASTER_CATALOG_RECEIPT_V1,
  ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
  COMPILED_BROAD_RASTER_ARTIFACT_WIRE_V1,
  COMPILED_BROAD_RASTER_OCCUPANCY_RGBA8_WIRE_V1,
  COMPILED_BROAD_RASTER_OCCUPANCY_TRANSPARENT_WIRE_V1,
  COMPILED_BROAD_RASTER_PIXEL_FORMAT_WIRE_V1,
  buildAssemblyCompiledBroadRasterSurfaceManifestV1,
  assemblyAnnotationSceneInteractionOwnerKeyV3,
  type AssemblyAnnotationSceneArtifactContract,
  type AssemblyAnnotationSceneReadRequest,
  type AssemblyCompiledBroadRasterCellsRequestV1,
  type AssemblyCompiledBroadRasterCellsResultV1,
  type AssemblyCompiledBroadRasterManifestResultV1,
} from '../../../shared/indexed-genome';
import type { PartitionedTranscriptSceneBinaryManifestV4 } from '@waypoint/genome-renderer/pure';
import {
  COMPILED_BROAD_SURFACE_MAX_FINITE_LANE_LIMIT_V2,
  compiledBroadSurfaceCellIdV2,
} from '@waypoint/genome-renderer/pure';

import {
  ASSEMBLY_COMPILED_BROAD_RASTER_POLICY_COMMIT_V1,
  AssemblyCompiledBroadRasterLoaderV1,
  type ActiveCompiledBroadSurfaceDemandV1,
  type AssemblyCompiledBroadRasterLoaderTargetV1,
  type AssemblyCompiledBroadRasterReadinessReceiptV1,
  type CompiledBroadRasterRendererV1,
} from './assembly-compiled-broad-raster-loader';

const SOURCE_FINGERPRINT = '1'.repeat(24);
const CATALOG_FINGERPRINT = '2'.repeat(64);
const PLACEMENT_FINGERPRINT = `ap1:${'7'.repeat(24)}`;
const RECEIPT_SHA256 = '8'.repeat(64);
const PREPACKED_OWNER_KEY = assemblyAnnotationSceneInteractionOwnerKeyV3({
  sourceFingerprint: SOURCE_FINGERPRINT,
  scenePayloadSha256: '6'.repeat(64),
  sceneArtifactKey: 'fixture-artifact',
})!;

function sceneManifest(): PartitionedTranscriptSceneBinaryManifestV4 {
  return {
    schema: 'partitioned-transcript-scene-binary.v4',
    datasetContract: {
      datasetId: 'fixture',
      datasetVersion: 'fixture-v1',
      sourceSha256: '3'.repeat(64),
    },
    assemblyContract: { assemblyId: 'grch38', assemblyLengthBp: 3_088_286_401 },
    directContract: {
      expanded: { maxTrackLane: 367 },
      canonical: { maxTrackLane: 15 },
    },
    integrity: {
      algorithm: 'sha256',
      contractSha256: '5'.repeat(64),
      payloadSha256: '6'.repeat(64),
    },
  } as unknown as PartitionedTranscriptSceneBinaryManifestV4;
}

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

function sceneRequest(): AssemblyAnnotationSceneReadRequest {
  return {
    workspaceRoot: '/fixture/workspace',
    assemblyId: 'grch38',
    chromosomes: [],
    scope: { kind: 'full-assembly', placements: [] },
    ipcContractVersion: 'assembly-annotation-scene-ipc.v4',
    datasetContract: {
      datasetId: 'fixture',
      datasetVersion: 'fixture-v1',
      sourceSha256: '3'.repeat(64),
    },
    artifact: artifact(),
    requestedPolicy: { isoformMode: 'expanded', laneLimit: 12 },
  } as AssemblyAnnotationSceneReadRequest;
}

function target(
  identityKey = 'fixture-runtime-key',
  policy: { isoformMode: 'canonical' | 'expanded'; laneLimit: number | null } = {
    isoformMode: 'expanded',
    laneLimit: 12,
  },
  policyRequestId: number | null = null
): AssemblyCompiledBroadRasterLoaderTargetV1 {
  return {
    identityKey,
    genomeIdentity: 'fixture-source',
    genomeLengthBp: 3_088_286_401,
    placementFingerprint: PLACEMENT_FINGERPRINT,
    sceneRequest: sceneRequest(),
    artifact: artifact(),
    policy,
    policyRequestId,
  };
}

function targetWithExpectedPublication(
  identityKey = 'fixture-runtime-key'
): AssemblyCompiledBroadRasterLoaderTargetV1 {
  return {
    ...target(identityKey),
    expectedAssetGeneration: {
      contract: 'assembly-reference-asset-generation.v1',
      sourceFingerprint: SOURCE_FINGERPRINT,
      inventoryFingerprint: '9'.repeat(64),
      themeMode: 'dark',
    },
  };
}

async function manifestResult(): Promise<AssemblyCompiledBroadRasterManifestResultV1> {
  const surfaceManifest = await buildAssemblyCompiledBroadRasterSurfaceManifestV1({
    sceneManifest: sceneManifest(),
    artifact: artifact(),
  });
  return {
    contract: COMPILED_BROAD_RASTER_ARTIFACT_WIRE_V1,
    catalogReceipt: {
      contract: ASSEMBLY_COMPILED_BROAD_RASTER_CATALOG_RECEIPT_V1,
      receiptSha256: RECEIPT_SHA256,
      genomeIdentity: 'fixture-source',
      genomeLengthBp: 3_088_286_401,
      sourceFingerprint: SOURCE_FINGERPRINT,
      placementFingerprint: PLACEMENT_FINGERPRINT,
      scenePayloadSha256: '6'.repeat(64),
      sceneContractSha256: '5'.repeat(64),
      sceneSourceBuildFingerprint: 'fixture-build',
      surfaceManifestFingerprint: surfaceManifest.manifestFingerprint,
      catalogFingerprint: CATALOG_FINGERPRINT,
      sceneArtifactKey: artifact().artifactKey,
      surfaceArtifactKey: surfaceManifest.artifactKey,
      themeMode: artifact().themeMode,
      trackId: surfaceManifest.trackId,
      expectedInteractionOwnerKey: PREPACKED_OWNER_KEY,
      pixelFormat: COMPILED_BROAD_RASTER_PIXEL_FORMAT_WIRE_V1,
      bytesPerPixel: 4,
      storedCellWidthPx:
        surfaceManifest.broadTilePhysicalWidthPx + surfaceManifest.broadTileXGuardPhysicalPx * 2,
      storedCellHeightPx: surfaceManifest.laneSlabRowCount * surfaceManifest.laneRowTextureStridePx,
      cellCount:
        surfaceManifest.levels.reduce((sum, level) => sum + level.tileCount, 0) *
        (surfaceManifest.laneSlabs.canonical.length + surfaceManifest.laneSlabs.expanded.length),
      rasterDevicePixelRatio: surfaceManifest.rasterDevicePixelRatio,
      tileContentWidthPx: surfaceManifest.broadTilePhysicalWidthPx,
      tileGuardWidthPx: surfaceManifest.broadTileXGuardPhysicalPx,
      laneSlabRowCount: surfaceManifest.laneSlabRowCount,
      laneRowTextureStridePx: surfaceManifest.laneRowTextureStridePx,
    },
    catalogCapability: {
      contract: ASSEMBLY_COMPILED_BROAD_RASTER_CATALOG_CAPABILITY_V1,
      openingId: 'fixture-catalog-opening',
      catalogReceiptSha256: RECEIPT_SHA256,
      catalogFingerprint: CATALOG_FINGERPRINT,
      surfaceManifestFingerprint: surfaceManifest.manifestFingerprint,
    },
    surfaceManifest,
  };
}

function demand(
  manifest: Awaited<ReturnType<typeof buildAssemblyCompiledBroadRasterSurfaceManifestV1>>,
  isoformMode: 'canonical' | 'expanded',
  count: number,
  tileOffset = 0
): ActiveCompiledBroadSurfaceDemandV1 {
  const addresses = Array.from({ length: count }, (_, index) => {
    const address = {
      isoformMode,
      level: 0,
      tileX: index + tileOffset,
      laneSlabIndex: 0,
    } as const;
    return {
      ...address,
      cellId: compiledBroadSurfaceCellIdV2({ manifest, ...address }),
    };
  });
  return {
    contract: 'compiled-broad-surface-demand.v2',
    demandLeaseId: `fixture-lease:${isoformMode}:12`,
    cameraEpoch: 1,
    manifestFingerprint: manifest.manifestFingerprint,
    artifactKey: manifest.artifactKey,
    trackId: manifest.trackId,
    isoformMode,
    laneLimit: 12,
    status: 'broad-ready',
    viewportStartBp: 0,
    viewportEndBp: manifest.genomeLengthBp,
    viewportCssWidthPx: 1_600,
    devicePixelRatio: 2,
    requiredCellAddresses: addresses,
    missingRequiredCellAddresses: addresses,
    successorCellAddresses: [],
    missingSuccessorCellAddresses: [],
    interactionPrefetchCellAddresses: [],
    missingInteractionPrefetchCellAddresses: [],
    prefetchCellAddresses: [],
    missingPrefetchCellAddresses: [],
    missingCellAddresses: addresses,
  };
}

function demandForSlabs(
  manifest: Awaited<ReturnType<typeof buildAssemblyCompiledBroadRasterSurfaceManifestV1>>,
  isoformMode: 'canonical' | 'expanded',
  slabIndices: readonly number[],
  tileX = 0
): ActiveCompiledBroadSurfaceDemandV1 {
  const addresses = slabIndices.map((laneSlabIndex) => {
    const address = { isoformMode, level: 0, tileX, laneSlabIndex } as const;
    return { ...address, cellId: compiledBroadSurfaceCellIdV2({ manifest, ...address }) };
  });
  return {
    ...demand(manifest, isoformMode, 0),
    requiredCellAddresses: addresses,
    missingRequiredCellAddresses: addresses,
    missingCellAddresses: addresses,
  };
}

function demandWithPrefetch(
  manifest: Awaited<ReturnType<typeof buildAssemblyCompiledBroadRasterSurfaceManifestV1>>,
  isoformMode: 'canonical' | 'expanded',
  count: number,
  tileOffset = 0
): ActiveCompiledBroadSurfaceDemandV1 {
  const base = demand(manifest, isoformMode, 0);
  const prefetchCellAddresses = demand(
    manifest,
    isoformMode,
    count,
    tileOffset
  ).requiredCellAddresses;
  return {
    ...base,
    prefetchCellAddresses,
    missingPrefetchCellAddresses: prefetchCellAddresses,
    missingCellAddresses: prefetchCellAddresses,
  };
}

function demandWithSuccessor(
  manifest: Awaited<ReturnType<typeof buildAssemblyCompiledBroadRasterSurfaceManifestV1>>,
  isoformMode: 'canonical' | 'expanded',
  count: number,
  tileOffset = 0
): ActiveCompiledBroadSurfaceDemandV1 {
  const base = demand(manifest, isoformMode, 0);
  const successorCellAddresses = demand(
    manifest,
    isoformMode,
    count,
    tileOffset
  ).requiredCellAddresses;
  return {
    ...base,
    successorCellAddresses,
    missingSuccessorCellAddresses: successorCellAddresses,
    missingCellAddresses: successorCellAddresses,
  };
}

function demandWithInteractionPrefetch(
  manifest: Awaited<ReturnType<typeof buildAssemblyCompiledBroadRasterSurfaceManifestV1>>,
  isoformMode: 'canonical' | 'expanded',
  count: number,
  tileOffset = 0
): ActiveCompiledBroadSurfaceDemandV1 {
  const base = demand(manifest, isoformMode, 0);
  const interactionPrefetchCellAddresses = demand(
    manifest,
    isoformMode,
    count,
    tileOffset
  ).requiredCellAddresses;
  return {
    ...base,
    interactionPrefetchCellAddresses,
    missingInteractionPrefetchCellAddresses: interactionPrefetchCellAddresses,
    missingCellAddresses: interactionPrefetchCellAddresses,
  };
}

function harness(
  options: {
    manualPostPresent?: boolean;
    manualIdleWarm?: boolean;
    now?: () => number;
    rendererInteractionQuietDelayMs?: () => number;
    bindPresentationLifecycle?: boolean;
    dropProjectedSchedulingWithoutRenderer?: boolean;
    manifestPublicationDeadlineMs?: number;
    manifestPublicationInitialRetryDelayMs?: number;
    manifestPublicationMaxRetryDelayMs?: number;
  } = {}
) {
  let activeManifestFingerprint = '';
  let admittedSourcePlacementAuthority: Readonly<{
    genomeIdentity: string;
    genomeLengthBp: number;
    sourceFingerprint: string;
    placementFingerprint: string;
  }> | null = null;
  const resident = new Set<string>();
  const currentDemand = { value: null as ActiveCompiledBroadSurfaceDemandV1 | null };
  const alternateDemand = { value: null as ActiveCompiledBroadSurfaceDemandV1 | null };
  const readiness: string[] = [];
  const readinessReceipts: AssemblyCompiledBroadRasterReadinessReceiptV1[] = [];
  const policyControlsReadiness: string[] = [];
  const policyCommitReceipts: unknown[] = [];
  const renderer: CompiledBroadRasterRendererV1 = {
    requireCompiledBroadSurface: vi.fn(() => true),
    admitCompiledBroadSurfaceSourcePlacementAuthority: vi.fn((authority) => {
      admittedSourcePlacementAuthority = { ...authority };
      return true;
    }),
    loadCompiledBroadSurfaceManifest: vi.fn((manifest, provenance) => {
      if (
        !admittedSourcePlacementAuthority ||
        admittedSourcePlacementAuthority.genomeIdentity !== provenance.genomeIdentity ||
        admittedSourcePlacementAuthority.genomeLengthBp !== provenance.genomeLengthBp ||
        admittedSourcePlacementAuthority.sourceFingerprint !== provenance.sourceFingerprint ||
        admittedSourcePlacementAuthority.placementFingerprint !== provenance.placementFingerprint
      ) {
        return false;
      }
      activeManifestFingerprint = manifest.manifestFingerprint;
      return true;
    }),
    updateAnnotationPresentationPolicy: vi.fn(() => true),
    getCompiledBroadSurfaceDemand: vi.fn((policy) => {
      const selected =
        policy?.isoformMode === 'canonical' ? alternateDemand.value : currentDemand.value;
      if (!selected || !policy) return selected;
      const slabCount =
        policy.laneLimit === null ? Number.POSITIVE_INFINITY : Math.ceil(policy.laneLimit / 8);
      const missingRequired = selected.requiredCellAddresses.filter(
        (address) => address.laneSlabIndex < slabCount && !resident.has(address.cellId)
      );
      const missingSuccessor = selected.successorCellAddresses.filter(
        (address) => address.laneSlabIndex < slabCount && !resident.has(address.cellId)
      );
      const missingInteractionPrefetch = selected.interactionPrefetchCellAddresses.filter(
        (address) => address.laneSlabIndex < slabCount && !resident.has(address.cellId)
      );
      const missingPrefetch = selected.prefetchCellAddresses.filter(
        (address) => address.laneSlabIndex < slabCount && !resident.has(address.cellId)
      );
      return {
        ...selected,
        demandLeaseId: `fixture-lease:${policy.isoformMode}:${policy.laneLimit ?? 'all'}`,
        laneLimit: policy.laneLimit,
        missingRequiredCellAddresses: missingRequired,
        missingSuccessorCellAddresses: missingSuccessor,
        missingInteractionPrefetchCellAddresses: missingInteractionPrefetch,
        missingPrefetchCellAddresses: missingPrefetch,
        missingCellAddresses: [
          ...missingRequired,
          ...missingSuccessor,
          ...missingInteractionPrefetch,
          ...missingPrefetch,
        ],
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
    admitCompiledBroadSurfaceTransparentCell: vi.fn((cell) => {
      resident.add(cell.cellId);
      return { status: 'admitted', explicitCopyByteLength: 0, uploadedByteLength: 0 };
    }),
    reconcileCompiledBroadSurfaceResidentLeases: vi.fn(() => ({
      status: 'reconciled',
      cameraEpoch: 1,
      retainedCellCount: resident.size,
      evictedCellIds: [],
    })),
    clearCompiledBroadSurfaceManifest: vi.fn(),
    clearCompiledBroadSurfaceRequirement: vi.fn(),
  };
  const manifest = { value: null as AssemblyCompiledBroadRasterManifestResultV1 | null };
  let manifestReadCount = 0;
  const readManifest = vi.fn(async () => {
    manifestReadCount += 1;
    if (!manifest.value) return null;
    const ipcClone = structuredClone(manifest.value);
    if (manifestReadCount === 1) return ipcClone;
    return {
      ...ipcClone,
      catalogCapability: {
        ...ipcClone.catalogCapability,
        openingId: `${ipcClone.catalogCapability.openingId}:${manifestReadCount}`,
      },
    };
  });
  const cellResponse = (
    request: AssemblyCompiledBroadRasterCellsRequestV1,
    transparentCellIds: ReadonlySet<string> = new Set()
  ): AssemblyCompiledBroadRasterCellsResultV1 => ({
    contract: ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
    status: 'ready',
    catalogCapability: request.catalogCapability,
    cells: request.addresses.map((address) => {
      const common = {
        ...address,
        cellId: compiledBroadSurfaceCellIdV2({
          manifest: manifest.value!.surfaceManifest,
          ...address,
        }),
        trackId: 'mRNA',
        laneSlabId:
          manifest.value!.surfaceManifest.laneSlabs[address.isoformMode][address.laneSlabIndex]!
            .slabId,
        widthPx: manifest.value!.catalogReceipt.storedCellWidthPx,
        heightPx: manifest.value!.catalogReceipt.storedCellHeightPx,
      } as const;
      if (transparentCellIds.has(common.cellId)) {
        return {
          record: {
            ...common,
            occupancy: COMPILED_BROAD_RASTER_OCCUPANCY_TRANSPARENT_WIRE_V1,
            decodedByteLength: 0 as const,
            decodedSha256: null,
          },
          premultipliedRgba: null,
        };
      }
      return {
        record: {
          ...common,
          occupancy: COMPILED_BROAD_RASTER_OCCUPANCY_RGBA8_WIRE_V1,
          decodedByteLength:
            manifest.value!.catalogReceipt.storedCellWidthPx *
            manifest.value!.catalogReceipt.storedCellHeightPx *
            manifest.value!.catalogReceipt.bytesPerPixel,
          decodedSha256: '4'.repeat(64),
        },
        premultipliedRgba: new Uint8Array(
          manifest.value!.catalogReceipt.storedCellWidthPx *
            manifest.value!.catalogReceipt.storedCellHeightPx *
            manifest.value!.catalogReceipt.bytesPerPixel
        ),
      };
    }),
  });
  const readCells = vi.fn(async (request: AssemblyCompiledBroadRasterCellsRequestV1) =>
    cellResponse(request)
  );
  const requestRender = vi.fn();
  const recordEvent = vi.fn();
  const getRenderer = vi.fn(() => renderer);
  let scheduledPostPresentWork: ((deadlineMs: number) => void) | null = null;
  let scheduledIdleWarmWork: (() => void) | null = null;
  const enqueuePostPresentWork = (work: (deadlineMs: number) => void) => {
    if (options.manualPostPresent) {
      scheduledPostPresentWork = work;
      return;
    }
    work(Number.POSITIVE_INFINITY);
  };
  const schedulePostPresentWork = vi.fn((work: (deadlineMs: number) => void) => {
    if (options.dropProjectedSchedulingWithoutRenderer && getRenderer() === null) return;
    enqueuePostPresentWork(work);
  });
  const getRendererPresentationLifecycle = vi.fn(() => {
    const currentRenderer = getRenderer();
    return currentRenderer
      ? {
          renderer: currentRenderer,
          requestRender,
          schedulePostPresentWork: enqueuePostPresentWork,
        }
      : null;
  });
  const scheduleDelayedWork = vi.fn((work: () => void, _delayMs: number) => {
    if (options.manualIdleWarm) scheduledIdleWarmWork = work;
    else queueMicrotask(work);
    return 1 as unknown as ReturnType<typeof setTimeout>;
  });
  const cancelDelayedWork = vi.fn(() => {
    scheduledIdleWarmWork = null;
  });
  const loader = new AssemblyCompiledBroadRasterLoaderV1({
    readManifest,
    readCells,
    getRenderer,
    ...(options.bindPresentationLifecycle ? { getRendererPresentationLifecycle } : {}),
    requestRender,
    schedulePostPresentWork,
    recordEvent,
    onReadinessChange: (receipt) => {
      readiness.push(receipt.readiness);
      readinessReceipts.push(receipt);
    },
    onPolicyControlsReadinessChange: (next) => policyControlsReadiness.push(next),
    onPolicyCommitted: (receipt) => policyCommitReceipts.push(receipt),
    now: options.now ?? (options.manualPostPresent ? () => 0 : undefined),
    rendererInteractionQuietDelayMs: options.rendererInteractionQuietDelayMs,
    scheduleDelayedWork,
    cancelDelayedWork,
    manifestPublicationDeadlineMs: options.manifestPublicationDeadlineMs,
    manifestPublicationInitialRetryDelayMs: options.manifestPublicationInitialRetryDelayMs,
    manifestPublicationMaxRetryDelayMs: options.manifestPublicationMaxRetryDelayMs,
  });
  return {
    activeManifestFingerprint: () => activeManifestFingerprint,
    admittedSourcePlacementAuthority: () => admittedSourcePlacementAuthority,
    alternateDemand,
    cellResponse,
    currentDemand,
    getRenderer,
    getRendererPresentationLifecycle,
    loader,
    manifest,
    readCells,
    readManifest,
    recordEvent,
    readiness,
    readinessReceipts,
    resident,
    policyControlsReadiness,
    policyCommitReceipts,
    renderer,
    requestRender,
    runPostPresentWork: (deadlineMs = Number.POSITIVE_INFINITY) => {
      const work = scheduledPostPresentWork;
      scheduledPostPresentWork = null;
      work?.(deadlineMs);
    },
    runIdleWarmWork: () => {
      const work = scheduledIdleWarmWork;
      scheduledIdleWarmWork = null;
      work?.();
    },
    scheduleDelayedWork,
    schedulePostPresentWork,
  };
}

describe('AssemblyCompiledBroadRasterLoaderV1', () => {
  it('waits for a transiently absent renderer and retries the same target without publishing an error', async () => {
    const h = harness({ manualIdleWarm: true });
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    h.currentDemand.value = demand(surface, 'expanded', 0);
    h.alternateDemand.value = demand(surface, 'canonical', 0);
    h.getRenderer.mockReturnValue(null);

    await h.loader.reconcile(target());

    expect(h.readiness.at(-1)).toBe('loading');
    expect(h.policyControlsReadiness.at(-1)).toBe('warming');
    expect(h.readiness).not.toContain('error');
    expect(h.scheduleDelayedWork).toHaveBeenCalled();

    h.getRenderer.mockReturnValue(h.renderer);
    expect(
      h.loader.armRequirement({
        identityKey: 'scene:grch38',
        genomeLengthBp: 3_088_286_401,
      })
    ).toBe(true);
    h.runIdleWarmWork();

    await vi.waitFor(() => expect(h.readiness.at(-1)).toBe('ready'));
    expect(h.readManifest).toHaveBeenCalledTimes(1);
    expect(h.readiness).not.toContain('error');
  });

  it('loads the visible and immediately reachable policies one immutable cell at a time', async () => {
    const h = harness();
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    const fingerprint = surface.manifestFingerprint;
    h.currentDemand.value = demand(surface, 'expanded', 21);
    h.alternateDemand.value = demand(surface, 'canonical', 5, 40);

    await h.loader.reconcile(target());

    await vi.waitFor(() => expect(h.readCells).toHaveBeenCalledTimes(26));

    expect(h.readManifest).toHaveBeenCalledWith({
      contract: ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
      scene: expect.objectContaining({ assemblyId: 'grch38' }),
    });
    expect(h.renderer.loadCompiledBroadSurfaceManifest).toHaveBeenCalledWith(
      h.manifest.value.surfaceManifest,
      expect.objectContaining({
        manifestFingerprint: fingerprint,
        sourceFingerprint: SOURCE_FINGERPRINT,
        placementFingerprint: PLACEMENT_FINGERPRINT,
        prepackedOwnerKey: PREPACKED_OWNER_KEY,
      })
    );
    expect(h.readCells).toHaveBeenCalledTimes(26);
    expect(h.readCells.mock.calls.every(([request]) => request.addresses.length === 1)).toBe(true);
    for (const [request] of h.readCells.mock.calls) {
      expect(request.catalogCapability).toEqual(h.manifest.value!.catalogCapability);
    }
    expect(h.readCells.mock.calls[0]![0].addresses.every((a) => a.isoformMode === 'expanded')).toBe(
      true
    );
    expect(
      h.readCells.mock.calls.filter(([request]) => request.addresses[0]?.isoformMode === 'expanded')
    ).toHaveLength(21);
    expect(
      h.readCells.mock.calls.filter(
        ([request]) => request.addresses[0]?.isoformMode === 'canonical'
      )
    ).toHaveLength(5);
    expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).toHaveBeenCalledTimes(26);
    expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).toHaveBeenCalledWith(
      expect.objectContaining({ demandLeaseId: 'fixture-lease:expanded:12' })
    );
    expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).toHaveBeenCalledWith(
      expect.objectContaining({ demandLeaseId: 'fixture-lease:canonical:12' })
    );
    await vi.waitFor(() =>
      expect(h.renderer.reconcileCompiledBroadSurfaceResidentLeases).toHaveBeenCalledWith([
        'fixture-lease:expanded:12',
        'fixture-lease:canonical:12',
        'fixture-lease:expanded:24',
      ])
    );
    expect(h.policyControlsReadiness.at(-1)).toBe('ready');
    expect(h.requestRender).toHaveBeenCalled();
    expect(h.loader.diagnostics()).toMatchObject({
      cellTransportResponseCount: 26,
      maxCellTransportResponseCellCount: 1,
    });
  });

  it('re-admits the retained manifest before reusing a paused same-renderer catalog', async () => {
    const h = harness();
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    h.currentDemand.value = demand(surface, 'expanded', 2);
    h.alternateDemand.value = demand(surface, 'canonical', 0);

    await h.loader.reconcile(target());
    await vi.waitFor(() => expect(h.readCells).toHaveBeenCalledTimes(2));
    expect(h.renderer.loadCompiledBroadSurfaceManifest).toHaveBeenCalledTimes(1);

    h.loader.pause();
    h.resident.clear();
    await h.loader.reconcile(target());

    await vi.waitFor(() => expect(h.readCells).toHaveBeenCalledTimes(4));
    expect(h.readManifest).toHaveBeenCalledTimes(1);
    expect(h.renderer.loadCompiledBroadSurfaceManifest).toHaveBeenCalledTimes(2);
    expect(h.recordEvent).toHaveBeenCalledWith(
      'compiled-broad-raster-manifest-readmitted',
      expect.objectContaining({
        surfaceManifestFingerprint: surface.manifestFingerprint,
      })
    );
    expect(h.readiness.at(-1)).toBe('ready');
  });

  it('pipelines eight single-cell transports while admitting at most two per budgeted turn', async () => {
    const h = harness({ manualPostPresent: true });
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    h.currentDemand.value = demand(surface, 'expanded', 9);
    h.alternateDemand.value = demand(surface, 'canonical', 0);
    let inFlight = 0;
    let maxInFlight = 0;
    const pendingReads: Array<{
      request: AssemblyCompiledBroadRasterCellsRequestV1;
      resolve: (result: AssemblyCompiledBroadRasterCellsResultV1) => void;
    }> = [];
    h.readCells.mockImplementation(
      (request) =>
        new Promise((resolve) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          pendingReads.push({
            request,
            resolve: (result) => {
              inFlight -= 1;
              resolve(result);
            },
          });
        })
    );

    const reconcile = h.loader.reconcile(target());
    await vi.waitFor(() => expect(pendingReads).toHaveLength(8));
    expect(maxInFlight).toBe(8);
    expect(h.readCells.mock.calls.every(([request]) => request.addresses.length === 1)).toBe(true);

    for (const pending of pendingReads.splice(0, 8)) {
      pending.resolve(h.cellResponse(pending.request));
    }
    await vi.waitFor(() =>
      expect(h.loader.diagnostics()).toMatchObject({ pendingAdmissionCellCount: 8 })
    );
    expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).not.toHaveBeenCalled();

    const rendersBeforeFirstSlice = h.requestRender.mock.calls.length;
    h.runPostPresentWork();
    expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).toHaveBeenCalledTimes(2);
    expect(h.requestRender.mock.calls.length).toBeGreaterThan(rendersBeforeFirstSlice);
    expect(h.loader.diagnostics()).toMatchObject({
      pendingAdmissionCellCount: 6,
      maxPostPresentSliceAdmissionCount: 2,
    });
    for (let slice = 2; slice <= 4; slice += 1) {
      h.runPostPresentWork();
      expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).toHaveBeenCalledTimes(slice * 2);
    }

    await vi.waitFor(() => expect(pendingReads).toHaveLength(1));
    expect(maxInFlight).toBe(8);
    const finalRead = pendingReads.shift()!;
    finalRead.resolve(h.cellResponse(finalRead.request));
    await vi.waitFor(() =>
      expect(h.loader.diagnostics()).toMatchObject({ pendingAdmissionCellCount: 1 })
    );
    h.runPostPresentWork();
    await reconcile;

    await vi.waitFor(() => expect(h.readiness.at(-1)).toBe('ready'));
    expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).toHaveBeenCalledTimes(9);
    expect(h.loader.diagnostics()).toMatchObject({
      pendingAdmissionCellCount: 0,
      cellTransportResponseCount: 9,
      maxCellTransportResponseCellCount: 1,
      maxPostPresentSliceAdmissionCount: 2,
    });
  });

  it('discards an obsolete transported camera batch in one bounded turn before loading the latest camera', async () => {
    const h = harness({ manualPostPresent: true });
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    h.currentDemand.value = demand(surface, 'expanded', 8);
    h.alternateDemand.value = demand(surface, 'canonical', 0);

    const reconcile = h.loader.reconcile(target());
    await vi.waitFor(() =>
      expect(h.loader.diagnostics()).toMatchObject({ pendingAdmissionCellCount: 8 })
    );

    const latest = demand(surface, 'expanded', 1, 40);
    h.currentDemand.value = latest;
    h.loader.signalCameraChanged();
    h.runPostPresentWork();

    expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(h.readCells).toHaveBeenCalledTimes(9));
    await vi.waitFor(() =>
      expect(h.loader.diagnostics()).toMatchObject({
        pendingAdmissionCellCount: 1,
        obsoleteCellDropCount: 8,
        totalAdmittedCellCount: 0,
      })
    );
    expect(h.recordEvent).toHaveBeenCalledWith(
      'compiled-broad-raster-cells-admitted',
      expect.objectContaining({ admittedCount: 0, count: 8, supersededCount: 8 })
    );

    h.runPostPresentWork();
    await reconcile;
    await vi.waitFor(() => expect(h.readiness.at(-1)).toBe('ready'));
    expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).toHaveBeenCalledTimes(1);
    expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).toHaveBeenCalledWith(
      expect.objectContaining({ cellId: latest.requiredCellAddresses[0]!.cellId })
    );
  });

  it('publishes ready after the exact renderer admission becomes resident', async () => {
    const h = harness({ manualPostPresent: true });
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    h.currentDemand.value = demand(surface, 'expanded', 1);
    h.alternateDemand.value = demand(surface, 'canonical', 0);

    const reconcile = h.loader.reconcile(target());
    await vi.waitFor(() =>
      expect(h.loader.diagnostics()).toMatchObject({ pendingAdmissionCellCount: 1 })
    );
    h.runPostPresentWork();
    await reconcile;
    await vi.waitFor(() => expect(h.readiness.at(-1)).toBe('ready'));
    expect(h.loader.diagnostics()).toMatchObject({
      pendingAdmissionCellCount: 0,
      policyControlsReadiness: 'ready',
    });
    expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).toHaveBeenCalledTimes(1);
  });

  it('drops a staged renderer admission when the loader is paused', async () => {
    const h = harness({ manualPostPresent: true });
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    h.currentDemand.value = demand(surface, 'expanded', 1);
    h.alternateDemand.value = demand(surface, 'canonical', 0);
    void h.loader.reconcile(target());
    await vi.waitFor(() =>
      expect(h.loader.diagnostics()).toMatchObject({ pendingAdmissionCellCount: 1 })
    );
    h.loader.pause();
    expect(h.loader.diagnostics()).toMatchObject({
      readiness: 'idle',
      pendingAdmissionCellCount: 0,
    });
    expect(h.recordEvent).toHaveBeenCalledWith(
      'compiled-broad-raster-staged-cells-dropped',
      expect.objectContaining({ reason: 'paused', remainingCount: 1, admittedCount: 0 })
    );
  });

  it('lets a visible policy command preempt a staged speculative admission', async () => {
    const h = harness({ manualPostPresent: true, manualIdleWarm: true });
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    h.currentDemand.value = demand(surface, 'expanded', 0);
    h.alternateDemand.value = demand(surface, 'canonical', 0);

    await h.loader.reconcile(target());
    expect(h.readiness.at(-1)).toBe('ready');

    h.currentDemand.value = demandWithInteractionPrefetch(surface, 'expanded', 1, 20);
    await h.loader.refreshDemand(false);
    await vi.waitFor(() => expect(h.loader.diagnostics().pendingAdmissionCellCount).toBe(1));

    await h.loader.reconcile(
      target('fixture-runtime-key', { isoformMode: 'canonical', laneLimit: 12 }, 42)
    );

    expect(h.recordEvent).toHaveBeenCalledWith(
      'compiled-broad-raster-staged-cells-dropped',
      expect.objectContaining({
        reason: 'speculative-work-superseded-by-policy-command',
        remainingCount: 1,
        admittedCount: 0,
      })
    );
    expect(h.policyCommitReceipts).toContainEqual(
      expect.objectContaining({
        policyRequestId: 42,
        policy: { isoformMode: 'canonical', laneLimit: 12 },
      })
    );
    expect(h.loader.diagnostics()).toMatchObject({
      pendingAdmissionCellCount: 0,
      policyControlsReadiness: 'ready',
    });
  });

  it('abandons an in-flight speculative response when a newer visible policy wins', async () => {
    const h = harness({ manualPostPresent: true, manualIdleWarm: true });
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    h.currentDemand.value = demand(surface, 'expanded', 0);
    h.alternateDemand.value = demand(surface, 'canonical', 0);
    await h.loader.reconcile(target());

    const runway = demandWithInteractionPrefetch(surface, 'expanded', 1, 20);
    const speculativeCellId = runway.interactionPrefetchCellAddresses[0]!.cellId;
    h.currentDemand.value = runway;
    let releaseRead!: (value: ReturnType<typeof h.cellResponse>) => void;
    let speculativeRequest: AssemblyCompiledBroadRasterCellsRequestV1 | null = null;
    h.readCells.mockImplementationOnce(
      (request) =>
        new Promise((resolve) => {
          speculativeRequest = request;
          releaseRead = resolve;
        })
    );

    const preload = h.loader.refreshDemand(false);
    await vi.waitFor(() => expect(speculativeRequest).not.toBeNull());
    const command = h.loader.reconcile(
      target('fixture-runtime-key', { isoformMode: 'canonical', laneLimit: 12 }, 43)
    );
    releaseRead(h.cellResponse(speculativeRequest!));
    await Promise.all([preload, command]);

    expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).not.toHaveBeenCalledWith(
      expect.objectContaining({ cellId: speculativeCellId })
    );
    expect(h.recordEvent).toHaveBeenCalledWith('compiled-broad-raster-stale-response-dropped', {
      phase: 'speculative-cells-policy-command',
    });
    expect(h.policyCommitReceipts).toContainEqual(
      expect.objectContaining({
        policyRequestId: 43,
        policy: { isoformMode: 'canonical', laneLimit: 12 },
      })
    );
    expect(h.loader.diagnostics().pendingAdmissionCellCount).toBe(0);
  });

  it('publishes the authenticated compact owner as soon as its raster manifest is admitted', async () => {
    const h = harness();
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    h.currentDemand.value = demand(surface, 'expanded', 1);
    h.alternateDemand.value = demand(surface, 'canonical', 0);
    let releaseRead!: (result: AssemblyCompiledBroadRasterCellsResultV1) => void;
    let pendingRequest: AssemblyCompiledBroadRasterCellsRequestV1 | null = null;
    h.readCells.mockImplementationOnce(
      (request) =>
        new Promise((resolve) => {
          pendingRequest = request;
          releaseRead = resolve;
        })
    );

    const reconcile = h.loader.reconcile(target());
    await vi.waitFor(() => expect(pendingRequest).not.toBeNull());

    expect(h.readinessReceipts.at(-1)).toMatchObject({
      readiness: 'loading',
      targetIdentityKey: 'fixture-runtime-key',
      renderer: h.renderer,
      expectedInteractionOwnerKey: PREPACKED_OWNER_KEY,
    });

    releaseRead(h.cellResponse(pendingRequest!));
    await reconcile;
    await vi.waitFor(() => expect(h.readiness.at(-1)).toBe('ready'));
  });

  it('admits and presents a sealed raster without waiting for its later interaction owner', async () => {
    const h = harness();
    h.manifest.value = await manifestResult();
    h.currentDemand.value = demand(h.manifest.value.surfaceManifest, 'expanded', 0);
    h.alternateDemand.value = demand(h.manifest.value.surfaceManifest, 'canonical', 0);
    await h.loader.reconcile(
      target('fixture-runtime-key', { isoformMode: 'expanded', laneLimit: 8 })
    );

    expect('getPrepackedAnnotationSceneOwnerSnapshot' in h.renderer).toBe(false);
    expect(h.renderer.admitCompiledBroadSurfaceSourcePlacementAuthority).toHaveBeenCalledWith({
      genomeIdentity: 'fixture-source',
      genomeLengthBp: 3_088_286_401,
      sourceFingerprint: SOURCE_FINGERPRINT,
      placementFingerprint: PLACEMENT_FINGERPRINT,
    });
    expect(h.renderer.loadCompiledBroadSurfaceManifest).toHaveBeenCalledTimes(1);
    expect(h.renderer.updateAnnotationPresentationPolicy).toHaveBeenCalledWith({
      isoformMode: 'expanded',
      laneLimit: 8,
    });
    expect(h.readiness.at(-1)).toBe('ready');
    expect(h.readiness).not.toContain('error');
    expect(h.recordEvent).not.toHaveBeenCalledWith(
      'compiled-broad-raster-awaiting-prepacked-owner',
      expect.anything()
    );
    h.loader.dispose();
  });

  it('promotes matching late source-generation provenance without replaying the resident product', async () => {
    const h = harness();
    h.manifest.value = await manifestResult();
    h.currentDemand.value = demand(h.manifest.value.surfaceManifest, 'expanded', 0);
    h.alternateDemand.value = demand(h.manifest.value.surfaceManifest, 'canonical', 0);
    const initialTarget = target();

    await h.loader.reconcile(initialTarget);
    expect(h.readManifest).toHaveBeenCalledTimes(1);
    expect(h.renderer.loadCompiledBroadSurfaceManifest).toHaveBeenCalledTimes(1);
    expect(h.renderer.updateAnnotationPresentationPolicy).toHaveBeenCalledTimes(1);

    await h.loader.reconcile({
      ...initialTarget,
      expectedAssetGeneration: {
        contract: 'assembly-reference-asset-generation.v1',
        sourceFingerprint: SOURCE_FINGERPRINT,
        inventoryFingerprint: '9'.repeat(64),
        themeMode: 'dark',
      },
    });

    expect(h.readManifest).toHaveBeenCalledTimes(1);
    expect(h.renderer.loadCompiledBroadSurfaceManifest).toHaveBeenCalledTimes(1);
    expect(h.renderer.updateAnnotationPresentationPolicy).toHaveBeenCalledTimes(1);
    expect(h.recordEvent).toHaveBeenCalledWith(
      'compiled-broad-raster-source-revision-validated',
      expect.objectContaining({ sourceFingerprint: SOURCE_FINGERPRINT })
    );
    expect(h.readiness.at(-1)).toBe('ready');
    expect(h.readinessReceipts.at(-1)).toMatchObject({
      readiness: 'ready',
      targetIdentityKey: initialTarget.identityKey,
      validatedSourceFingerprint: SOURCE_FINGERPRINT,
    });
  });

  it('proves next-control demand before readiness, then reconciles its leases after quiet', async () => {
    const h = harness({ manualPostPresent: true, manualIdleWarm: true });
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    h.currentDemand.value = demand(surface, 'expanded', 0);
    h.alternateDemand.value = demand(surface, 'canonical', 0);

    await h.loader.reconcile(target());

    expect(h.renderer.getCompiledBroadSurfaceDemand).toHaveBeenCalledWith(
      { isoformMode: 'expanded', laneLimit: 12 },
      surface.manifestFingerprint
    );
    expect(h.renderer.getCompiledBroadSurfaceDemand).toHaveBeenCalledWith(
      { isoformMode: 'canonical', laneLimit: 12 },
      surface.manifestFingerprint
    );
    expect(h.renderer.getCompiledBroadSurfaceDemand).toHaveBeenCalledWith(
      { isoformMode: 'expanded', laneLimit: 24 },
      surface.manifestFingerprint
    );
    expect(h.renderer.reconcileCompiledBroadSurfaceResidentLeases).not.toHaveBeenCalled();
    expect(h.readiness.at(-1)).toBe('ready');
    expect(h.policyControlsReadiness.at(-1)).toBe('ready');

    h.runIdleWarmWork();
    h.runPostPresentWork();
    await vi.waitFor(() =>
      expect(h.renderer.reconcileCompiledBroadSurfaceResidentLeases).toHaveBeenCalled()
    );
    expect(h.renderer.getCompiledBroadSurfaceDemand).toHaveBeenCalledWith(
      { isoformMode: 'canonical', laneLimit: 12 },
      surface.manifestFingerprint
    );
    expect(h.renderer.getCompiledBroadSurfaceDemand).toHaveBeenCalledWith(
      { isoformMode: 'expanded', laneLimit: 24 },
      surface.manifestFingerprint
    );
    expect(h.renderer.reconcileCompiledBroadSurfaceResidentLeases).toHaveBeenCalledWith([
      'fixture-lease:expanded:12',
      'fixture-lease:canonical:12',
      'fixture-lease:expanded:24',
    ]);
  });

  it('stages the next-control envelope before publishing interaction readiness', async () => {
    const h = harness({ manualPostPresent: true, manualIdleWarm: true });
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    h.currentDemand.value = demand(surface, 'expanded', 0);
    h.alternateDemand.value = demand(surface, 'canonical', 1);

    await h.loader.reconcile(
      target('fixture-runtime-key', { isoformMode: 'expanded', laneLimit: 12 })
    );

    expect(h.policyControlsReadiness.at(-1)).toBe('ready');
    expect(h.renderer.reconcileCompiledBroadSurfaceResidentLeases).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(h.readCells).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(h.loader.diagnostics()).toMatchObject({
        readiness: 'loading',
        pendingAdmissionCellCount: 1,
        pendingAdmissionTier: 'control-prefetch',
      })
    );
    expect(h.readCells.mock.calls[0]![0].addresses).toEqual([
      expect.objectContaining({ isoformMode: 'canonical' }),
    ]);
    expect(h.renderer.reconcileCompiledBroadSurfaceResidentLeases).not.toHaveBeenCalled();
    expect(h.scheduleDelayedWork).not.toHaveBeenCalled();
    h.runPostPresentWork();
    await vi.waitFor(() => expect(h.loader.diagnostics().readiness).toBe('ready'));
  });

  it('commits detail policy readiness before warming the bounded broad successor roster', async () => {
    const h = harness();
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    h.currentDemand.value = {
      ...demandWithSuccessor(surface, 'expanded', 1),
      status: 'detail-required',
    };

    await h.loader.reconcile(
      target('fixture-runtime-key', { isoformMode: 'expanded', laneLimit: 24 }, 73)
    );

    expect(h.readCells).toHaveBeenCalledTimes(1);
    expect(h.resident.size).toBe(1);
    expect(h.renderer.updateAnnotationPresentationPolicy).toHaveBeenCalledTimes(1);
    expect(h.renderer.updateAnnotationPresentationPolicy).toHaveBeenCalledWith({
      isoformMode: 'expanded',
      laneLimit: 24,
    });
    expect(h.policyCommitReceipts).toEqual([
      expect.objectContaining({
        contract: ASSEMBLY_COMPILED_BROAD_RASTER_POLICY_COMMIT_V1,
        policyRequestId: 73,
        policy: { isoformMode: 'expanded', laneLimit: 24 },
      }),
    ]);
    expect(h.readiness.at(-1)).toBe('ready');
    expect(h.policyControlsReadiness.at(-1)).toBe('ready');
  });

  it('gates detail return on its exact successor without manufacturing broad control leases', async () => {
    const h = harness();
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    const successor = demandWithSuccessor(surface, 'expanded', 1);
    const interaction = demandWithInteractionPrefetch(surface, 'expanded', 2, 3);
    h.currentDemand.value = {
      ...successor,
      status: 'detail-required',
      interactionPrefetchCellAddresses: interaction.interactionPrefetchCellAddresses,
      missingInteractionPrefetchCellAddresses: interaction.missingInteractionPrefetchCellAddresses,
      missingCellAddresses: [
        ...successor.missingSuccessorCellAddresses,
        ...interaction.missingInteractionPrefetchCellAddresses,
      ],
    };
    h.alternateDemand.value = {
      ...demand(surface, 'canonical', 0),
      status: 'detail-required',
    };
    const readinessAtCellRead: string[] = [];
    h.readCells.mockImplementation(async (request) => {
      readinessAtCellRead.push(h.policyControlsReadiness.at(-1) ?? 'missing');
      return h.cellResponse(request);
    });

    await h.loader.reconcile(target());

    await vi.waitFor(() => expect(h.readCells).toHaveBeenCalledTimes(3));
    expect(readinessAtCellRead).toEqual(['warming', 'ready', 'ready']);
    expect(h.policyControlsReadiness.at(-1)).toBe('ready');
    expect(h.renderer.reconcileCompiledBroadSurfaceResidentLeases).toHaveBeenCalledWith([
      'fixture-lease:expanded:12',
    ]);
  });

  it('keeps a deferred peer policy non-terminal and receipts only after a real commit', async () => {
    const h = harness();
    h.manifest.value = await manifestResult();
    h.currentDemand.value = demand(h.manifest.value.surfaceManifest, 'expanded', 0);
    h.alternateDemand.value = demand(h.manifest.value.surfaceManifest, 'canonical', 0);
    const commit = vi
      .fn()
      .mockReturnValueOnce({
        status: 'deferred',
        reason: 'selected-raster-roster-incomplete',
      })
      .mockReturnValueOnce({ status: 'committed', policyGeneration: 1 });
    h.renderer.commitAnnotationPresentationPolicy = commit;

    await h.loader.reconcile(
      target('fixture-runtime-key', { isoformMode: 'expanded', laneLimit: 12 }, 91)
    );

    expect(commit).toHaveBeenCalledTimes(1);
    expect(h.readiness.at(-1)).toBe('loading');
    expect(h.policyControlsReadiness.at(-1)).toBe('warming');
    expect(h.readiness).not.toContain('error');
    expect(h.policyCommitReceipts).toEqual([]);
    expect(h.recordEvent).toHaveBeenCalledWith(
      'compiled-broad-raster-policy-deferred',
      expect.objectContaining({ reason: 'selected-raster-roster-incomplete' })
    );

    await h.loader.refreshDemand(false);

    expect(commit).toHaveBeenCalledTimes(2);
    expect(h.readiness.at(-1)).toBe('ready');
    expect(h.policyControlsReadiness.at(-1)).toBe('ready');
    expect(h.policyCommitReceipts).toEqual([
      expect.objectContaining({
        contract: ASSEMBLY_COMPILED_BROAD_RASTER_POLICY_COMMIT_V1,
        policyRequestId: 91,
      }),
    ]);
  });

  it('admits mixed occupied and qualified-transparent cells without allocating transparent RGBA', async () => {
    const h = harness();
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    h.currentDemand.value = demand(surface, 'expanded', 2);
    h.alternateDemand.value = demand(surface, 'canonical', 0);
    const transparentCellId = h.currentDemand.value.missingCellAddresses[1]!.cellId;
    h.readCells.mockImplementation(async (request) =>
      h.cellResponse(request, new Set([transparentCellId]))
    );

    await h.loader.reconcile(target());

    expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).toHaveBeenCalledTimes(1);
    expect(h.renderer.admitCompiledBroadSurfaceTransparentCell).toHaveBeenCalledTimes(1);
    expect(h.renderer.admitCompiledBroadSurfaceTransparentCell).toHaveBeenCalledWith(
      expect.objectContaining({ cellId: transparentCellId })
    );
    expect(h.readiness).toContain('ready');
    expect(h.readiness).not.toContain('error');
  });

  it('admits an all-transparent visible roster without any RGBA upload', async () => {
    const h = harness();
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    h.currentDemand.value = demand(surface, 'expanded', 3);
    h.alternateDemand.value = demand(surface, 'canonical', 0);
    const transparentCellIds = new Set(
      h.currentDemand.value.missingCellAddresses.map((address) => address.cellId)
    );
    h.readCells.mockImplementation(async (request) => h.cellResponse(request, transparentCellIds));

    await h.loader.reconcile(target());

    expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).not.toHaveBeenCalled();
    expect(h.renderer.admitCompiledBroadSurfaceTransparentCell).toHaveBeenCalledTimes(3);
    expect(h.readiness.at(-1)).toBe('ready');
    expect(h.requestRender).toHaveBeenCalled();
  });

  it('retries camera-required demand after the renderer has produced its first camera frame', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.manifest.value = await manifestResult();
      const surface = h.manifest.value.surfaceManifest;
      const visible = demand(surface, 'expanded', 1);
      h.currentDemand.value = {
        ...visible,
        status: 'camera-required',
        requiredCellAddresses: [],
        missingRequiredCellAddresses: [],
        prefetchCellAddresses: [],
        missingPrefetchCellAddresses: [],
        missingCellAddresses: [],
      };
      h.alternateDemand.value = demand(surface, 'canonical', 0);

      await h.loader.reconcile(target());
      expect(h.readCells).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);

      h.currentDemand.value = visible;
      await vi.runOnlyPendingTimersAsync();
      await vi.waitFor(() => expect(h.readCells).toHaveBeenCalledTimes(1));
      expect(h.readiness).toContain('ready');
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops an old manifest response after the source identity changes', async () => {
    const h = harness();
    let release!: (value: AssemblyCompiledBroadRasterManifestResultV1 | null) => void;
    h.readManifest.mockImplementationOnce(
      () =>
        new Promise<AssemblyCompiledBroadRasterManifestResultV1 | null>(
          (resolve) => (release = resolve)
        )
    );
    const old = h.loader.reconcile(target('old'));
    const result = await manifestResult();
    h.manifest.value = result;
    h.currentDemand.value = demand(result.surfaceManifest, 'expanded', 0);
    h.alternateDemand.value = demand(result.surfaceManifest, 'canonical', 0);
    const current = h.loader.reconcile(target('new'));
    release(result);
    await Promise.all([old, current]);

    expect(h.renderer.loadCompiledBroadSurfaceManifest).toHaveBeenCalledTimes(1);
    expect(h.readinessReceipts.filter((receipt) => receipt.readiness === 'ready')).toEqual([
      expect.objectContaining({
        targetIdentityKey: 'new',
        renderer: h.renderer,
      }),
    ]);
    expect(h.recordEvent).toHaveBeenCalledWith(
      'compiled-broad-raster-stale-response-dropped',
      expect.objectContaining({ phase: 'manifest' })
    );
  });

  it.each(['manifest transport', 'manifest miss', 'cell unavailable'])(
    'recovers a failed %s at the same address all the way to an exact policy commit without camera input',
    async (failure) => {
      const h = harness();
      h.manifest.value = await manifestResult();
      const surface = h.manifest.value.surfaceManifest;
      h.currentDemand.value = demand(surface, 'expanded', 1);
      h.alternateDemand.value = demand(surface, 'canonical', 0);
      if (failure === 'manifest transport') {
        h.readManifest.mockRejectedValueOnce(new Error('temporary manifest read failure'));
      } else if (failure === 'manifest miss') {
        h.readManifest.mockResolvedValueOnce(null);
      } else {
        h.readCells.mockResolvedValueOnce({
          contract: ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
          status: 'unavailable',
          reason: 'artifact-io-failure',
        });
      }
      await h.loader.reconcile(
        target('same-product', { isoformMode: 'expanded', laneLimit: 2 }, 11)
      );
      expect(['error', 'unavailable']).toContain(h.readiness.at(-1));
      expect(h.readManifest).toHaveBeenCalledTimes(1);

      await h.loader.reconcile(
        target('same-product', { isoformMode: 'expanded', laneLimit: 4 }, 12)
      );

      expect(h.readManifest).toHaveBeenCalledTimes(2);
      expect(h.readiness.at(-1)).toBe('ready');
      expect(h.policyControlsReadiness.at(-1)).toBe('ready');
      expect(h.policyCommitReceipts.at(-1)).toMatchObject({
        identityKey: 'same-product',
        policyRequestId: 12,
        policy: { isoformMode: 'expanded', laneLimit: 4 },
      });
      expect(h.readCells).toHaveBeenCalled();
      expect(h.loader.diagnostics().cameraNotificationCount).toBe(0);
      h.loader.dispose();
    }
  );

  it('keeps a healthy initial manifest load in flight and commits only the latest settings request', async () => {
    const h = harness();
    const result = await manifestResult();
    h.manifest.value = result;
    h.currentDemand.value = demand(result.surfaceManifest, 'expanded', 1);
    h.alternateDemand.value = demand(result.surfaceManifest, 'canonical', 0);
    let release!: (value: AssemblyCompiledBroadRasterManifestResultV1) => void;
    h.readManifest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const initial = h.loader.reconcile(
      target('same-product', { isoformMode: 'expanded', laneLimit: 2 }, 11)
    );
    await vi.waitFor(() => expect(h.readManifest).toHaveBeenCalledTimes(1));
    await h.loader.reconcile(target('same-product', { isoformMode: 'expanded', laneLimit: 4 }, 12));
    await h.loader.reconcile(target('same-product', { isoformMode: 'expanded', laneLimit: 8 }, 13));
    expect(h.readManifest).toHaveBeenCalledTimes(1);
    release(result);
    await initial;
    expect(h.readiness.at(-1)).toBe('ready');
    expect(h.policyCommitReceipts).toEqual([
      expect.objectContaining({
        policyRequestId: 13,
        policy: { isoformMode: 'expanded', laneLimit: 8 },
      }),
    ]);
    expect(h.loader.diagnostics().cameraNotificationCount).toBe(0);
    h.loader.dispose();
  });

  it('fails closed on a sealed receipt placement mismatch and admits no bytes', async () => {
    const h = harness();
    const result = await manifestResult();
    h.manifest.value = {
      ...result,
      catalogReceipt: {
        ...result.catalogReceipt,
        placementFingerprint: `ap1:${'f'.repeat(24)}`,
      },
    };

    await h.loader.reconcile(target());

    expect(h.renderer.loadCompiledBroadSurfaceManifest).not.toHaveBeenCalled();
    expect(h.readCells).not.toHaveBeenCalled();
    expect(h.recordEvent).toHaveBeenCalledWith(
      'compiled-broad-raster-rejected',
      expect.objectContaining({ reason: 'catalog-receipt-provenance-mismatch' })
    );
  });

  it('drops a cell batch if the concrete renderer changes while IPC is in flight', async () => {
    const h = harness();
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    const fingerprint = surface.manifestFingerprint;
    h.currentDemand.value = demand(surface, 'expanded', 1);
    let release!: (value: ReturnType<typeof h.cellResponse>) => void;
    let pendingRequest: AssemblyCompiledBroadRasterCellsRequestV1 | null = null;
    h.readCells.mockImplementationOnce(
      (request) =>
        new Promise((resolve) => {
          pendingRequest = request;
          release = resolve;
        })
    );
    const pending = h.loader.reconcile(target());
    await vi.waitFor(() => expect(h.readCells).toHaveBeenCalledTimes(1));
    h.getRenderer.mockReturnValue({ ...h.renderer });
    release(h.cellResponse(pendingRequest!));
    await pending;

    expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).not.toHaveBeenCalled();
    expect(h.recordEvent).toHaveBeenCalledWith(
      'compiled-broad-raster-stale-response-dropped',
      expect.objectContaining({ phase: 'cells' })
    );
  });

  it('arms fail-closed ownership before IPC and treats an absent committed sidecar as terminal', async () => {
    const h = harness();
    h.manifest.value = null;
    await h.loader.reconcile(target());

    expect(h.renderer.requireCompiledBroadSurface).toHaveBeenCalledBefore(h.readManifest);
    expect(h.renderer.clearCompiledBroadSurfaceRequirement).not.toHaveBeenCalled();
    expect(h.readManifest).toHaveBeenCalledTimes(1);
    expect(h.readiness.at(-1)).toBe('unavailable');
    expect(h.policyControlsReadiness.at(-1)).toBe('unavailable');
    expect(h.recordEvent).toHaveBeenCalledWith(
      'compiled-broad-raster-manifest-unavailable',
      expect.any(Object)
    );
  });

  it('waits for an expected main-owned raster publication instead of turning startup order into permanent absence', async () => {
    const h = harness({
      manifestPublicationDeadlineMs: 1_000,
      manifestPublicationInitialRetryDelayMs: 0,
      manifestPublicationMaxRetryDelayMs: 0,
    });
    h.manifest.value = await manifestResult();
    h.currentDemand.value = demand(h.manifest.value.surfaceManifest, 'expanded', 0);
    h.alternateDemand.value = demand(h.manifest.value.surfaceManifest, 'canonical', 0);
    h.readManifest.mockImplementationOnce(async () => null);

    await h.loader.reconcile(targetWithExpectedPublication());

    expect(h.readManifest).toHaveBeenCalledTimes(2);
    expect(h.readiness.at(-1)).toBe('ready');
    expect(h.readiness).not.toContain('unavailable');
    expect(h.recordEvent).toHaveBeenCalledWith(
      'compiled-broad-raster-manifest-publication-attempt',
      expect.objectContaining({ attempt: 1, outcome: 'not-published' })
    );
    expect(h.recordEvent).toHaveBeenCalledWith(
      'compiled-broad-raster-manifest-publication-attempt',
      expect.objectContaining({ attempt: 2, outcome: 'published' })
    );
  });

  it('reprobes the same product address when its exact source generation arrives after an early manifest miss', async () => {
    const h = harness({
      manifestPublicationDeadlineMs: 1_000,
      manifestPublicationInitialRetryDelayMs: 0,
      manifestPublicationMaxRetryDelayMs: 0,
    });
    const published = await manifestResult();
    h.manifest.value = null;

    await h.loader.reconcile(target());
    expect(h.readiness.at(-1)).toBe('unavailable');
    expect(h.readManifest).toHaveBeenCalledTimes(1);

    h.manifest.value = published;
    h.currentDemand.value = demand(published.surfaceManifest, 'expanded', 0);
    h.alternateDemand.value = demand(published.surfaceManifest, 'canonical', 0);
    await h.loader.reconcile(targetWithExpectedPublication());

    expect(h.readManifest).toHaveBeenCalledTimes(2);
    expect(h.readiness.at(-1)).toBe('ready');
  });

  it('cancels an expected raster publication wait when the owning lane pauses', async () => {
    const h = harness({
      manifestPublicationDeadlineMs: 1_000,
      manifestPublicationInitialRetryDelayMs: 100,
      manifestPublicationMaxRetryDelayMs: 100,
    });
    h.manifest.value = null;

    const reconcile = h.loader.reconcile(targetWithExpectedPublication());
    await vi.waitFor(() => expect(h.readManifest).toHaveBeenCalledTimes(1));
    h.loader.pause();
    await reconcile;

    expect(h.readManifest).toHaveBeenCalledTimes(1);
    expect(h.readiness.at(-1)).toBe('idle');
    expect(h.readiness).not.toContain('error');
  });

  it('fails loudly after a bounded wait when an expected raster publication never appears', async () => {
    const h = harness({
      manifestPublicationDeadlineMs: 10,
      manifestPublicationInitialRetryDelayMs: 1,
      manifestPublicationMaxRetryDelayMs: 2,
    });
    h.manifest.value = null;

    await h.loader.reconcile(targetWithExpectedPublication());

    expect(h.readiness.at(-1)).toBe('error');
    expect(h.readiness).not.toContain('unavailable');
    expect(h.recordEvent).toHaveBeenCalledWith(
      'compiled-broad-raster-rejected',
      expect.objectContaining({
        reason: 'expected-manifest-publication-failed',
        message: expect.stringContaining('was not published within 10 ms'),
      })
    );
  });

  it('re-admits an exact Electron structured clone before any pure manifest guard', async () => {
    const h = harness();
    const original = await manifestResult();
    const ipcClone = structuredClone(original);
    expect(() =>
      compiledBroadSurfaceCellIdV2({
        manifest: ipcClone.surfaceManifest,
        isoformMode: 'expanded',
        level: 0,
        tileX: 0,
        laneSlabIndex: 0,
      })
    ).toThrow('compiled broad surface manifest is invalid');
    h.manifest.value = original;
    h.currentDemand.value = demand(original.surfaceManifest, 'expanded', 0);
    h.alternateDemand.value = demand(original.surfaceManifest, 'canonical', 0);

    await h.loader.reconcile(target());

    expect(h.readiness.at(-1)).toBe('ready');
    const admitted = h.renderer.loadCompiledBroadSurfaceManifest.mock.calls[0]?.[0];
    expect(admitted).not.toBe(original.surfaceManifest);
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(() =>
      compiledBroadSurfaceCellIdV2({
        manifest: admitted!,
        isoformMode: 'expanded',
        level: 0,
        tileX: 0,
        laneSlabIndex: 0,
      })
    ).not.toThrow();
  });

  it('rejects a malformed structured-clone manifest terminally without renderer admission', async () => {
    const h = harness();
    const original = await manifestResult();
    const malformed = structuredClone(original);
    (
      malformed.surfaceManifest as unknown as {
        levels: typeof malformed.surfaceManifest.levels;
      }
    ).levels = [...malformed.surfaceManifest.levels].reverse();
    h.manifest.value = malformed;

    await h.loader.reconcile(target());

    expect(h.readiness.at(-1)).toBe('error');
    expect(h.readCells).not.toHaveBeenCalled();
    expect(h.renderer.loadCompiledBroadSurfaceManifest).not.toHaveBeenCalled();
    expect(h.recordEvent).toHaveBeenCalledWith(
      'compiled-broad-raster-rejected',
      expect.objectContaining({ reason: 'surface-manifest-admission-failed' })
    );
    expect(h.loader.diagnostics().lastRejection).toMatchObject({
      reason: 'surface-manifest-admission-failed',
      demandEpoch: 0,
      observedAtMs: expect.any(Number),
    });
    expect(h.loader.diagnostics().lastRejection?.message).toMatch(/pyramid is invalid/i);
  });

  it('publishes first-paint and policy controls before passive current-policy warming', async () => {
    const h = harness({ manualPostPresent: true, manualIdleWarm: true, now: () => 10 });
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    h.alternateDemand.value = demand(surface, 'canonical', 0);
    h.currentDemand.value = demandWithPrefetch(surface, 'expanded', 1);
    await h.loader.reconcile(target());

    expect(h.readiness).toContain('ready');
    expect(h.policyControlsReadiness.at(-1)).toBe('ready');
    expect(h.readCells).not.toHaveBeenCalled();
    expect(h.loader.diagnostics().pendingAdmissionCellCount).toBe(0);

    h.runIdleWarmWork();
    h.runPostPresentWork(10);
    expect(h.readCells).not.toHaveBeenCalled();
    h.runPostPresentWork(Number.POSITIVE_INFINITY);
    await vi.waitFor(() => expect(h.readCells).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(h.loader.diagnostics()).toMatchObject({ pendingAdmissionCellCount: 1 })
    );
    expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).not.toHaveBeenCalled();
    h.runPostPresentWork(Number.POSITIVE_INFINITY);
    expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).toHaveBeenCalledTimes(1);
    const warmRequest = h.readCells.mock.calls[0]![0];
    expect(warmRequest.addresses.every((address) => address.isoformMode === 'expanded')).toBe(true);
    expect(h.renderer.getCompiledBroadSurfaceDemand).toHaveBeenCalledWith(
      expect.objectContaining({ isoformMode: 'canonical' }),
      surface.manifestFingerprint
    );
    expect(h.renderer.getCompiledBroadSurfaceDemand).toHaveBeenCalledWith(
      { isoformMode: 'expanded', laneLimit: 24 },
      surface.manifestFingerprint
    );
  });

  it.each([false, true])(
    'prepares the next control after the current interaction runway without waiting for quiet (budget deferred: %s)',
    async (budgetDeferred) => {
      const now = vi.fn(() => 0);
      const h = harness({
        manualPostPresent: true,
        manualIdleWarm: true,
        ...(budgetDeferred ? { now } : {}),
      });
      h.manifest.value = await manifestResult();
      const surface = h.manifest.value.surfaceManifest;
      h.currentDemand.value = demandWithInteractionPrefetch(surface, 'expanded', 1, 20);
      h.alternateDemand.value = demand(surface, 'canonical', 1, 40);

      await h.loader.reconcile(target());
      expect(h.policyControlsReadiness.at(-1)).toBe('ready');
      expect(h.readCells).toHaveBeenCalledTimes(1);
      expect(h.readCells.mock.calls[0]![0].addresses).toEqual([
        expect.objectContaining({ isoformMode: 'expanded' }),
      ]);
      expect(h.loader.diagnostics()).toMatchObject({ pendingAdmissionCellCount: 1 });
      expect(
        h.readCells.mock.calls.some(([request]) =>
          request.addresses.some((address) => address.isoformMode === 'canonical')
        )
      ).toBe(false);
      h.runPostPresentWork();

      await vi.waitFor(() =>
        expect(h.loader.diagnostics()).toMatchObject({
          demandPumpInFlight: false,
          pendingAdmissionCellCount: 1,
          pendingAdmissionTier: 'control-prefetch',
        })
      );
      await vi.waitFor(() =>
        expect(
          h.readCells.mock.calls.some(([request]) =>
            request.addresses.some((address) => address.isoformMode === 'canonical')
          )
        ).toBe(true)
      );
      expect(h.scheduleDelayedWork).not.toHaveBeenCalled();
      expect(h.readiness.at(-1)).toBe('loading');
      if (budgetDeferred) {
        now.mockReturnValueOnce(0).mockReturnValue(3);
        h.runPostPresentWork();
        expect(h.readiness.at(-1)).toBe('loading');
        expect(h.loader.diagnostics()).toMatchObject({
          pendingAdmissionCellCount: 1,
          pendingAdmissionTier: 'control-prefetch',
        });
        expect(h.scheduleDelayedWork).not.toHaveBeenCalled();
      }
      await vi.waitFor(() => {
        h.runPostPresentWork();
        expect(h.readiness.at(-1)).toBe('ready');
      });
      expect(h.policyControlsReadiness.at(-1)).toBe('ready');
      h.loader.dispose();
    }
  );

  it('cancels an in-flight interaction runway read when a newer camera takes authority', async () => {
    const h = harness({ manualPostPresent: true, manualIdleWarm: true });
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    const oldRunway = demandWithInteractionPrefetch(surface, 'expanded', 1, 20);
    const newestRequired = demand(surface, 'expanded', 1, 40);
    h.currentDemand.value = oldRunway;
    h.alternateDemand.value = demand(surface, 'canonical', 0);
    let releaseOldRead!: (value: ReturnType<typeof h.cellResponse>) => void;
    let oldRequest: AssemblyCompiledBroadRasterCellsRequestV1 | null = null;
    const defaultRead = h.readCells.getMockImplementation()!;
    h.readCells.mockImplementationOnce(
      (request) =>
        new Promise((resolve) => {
          oldRequest = request;
          releaseOldRead = resolve;
        })
    );

    const initial = h.loader.reconcile(target());
    await vi.waitFor(() => expect(oldRequest).not.toBeNull());
    h.currentDemand.value = newestRequired;
    h.loader.signalCameraChanged();
    releaseOldRead(h.cellResponse(oldRequest!));
    h.readCells.mockImplementation(defaultRead);
    await initial;

    expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).not.toHaveBeenCalledWith(
      expect.objectContaining({ cellId: oldRunway.interactionPrefetchCellAddresses[0]!.cellId })
    );
    expect(h.recordEvent).toHaveBeenCalledWith('compiled-broad-raster-stale-response-dropped', {
      phase: 'interaction-prefetch-cells-camera',
    });
    await vi.waitFor(() =>
      expect(h.readCells).toHaveBeenCalledWith(
        expect.objectContaining({
          addresses: [
            expect.objectContaining({
              tileX: newestRequired.requiredCellAddresses[0]!.tileX,
            }),
          ],
        })
      )
    );
  });

  it('drops a staged interaction runway batch before it can block newer camera demand', async () => {
    const h = harness({ manualPostPresent: true, manualIdleWarm: true });
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    const oldRunway = demandWithInteractionPrefetch(surface, 'expanded', 1, 20);
    const newestRequired = demand(surface, 'expanded', 1, 40);
    h.currentDemand.value = oldRunway;
    h.alternateDemand.value = demand(surface, 'canonical', 0);

    await h.loader.reconcile(target());
    await vi.waitFor(() => expect(h.loader.diagnostics().pendingAdmissionCellCount).toBe(1));
    h.currentDemand.value = newestRequired;
    h.loader.signalCameraChanged();
    h.runPostPresentWork();

    expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).not.toHaveBeenCalledWith(
      expect.objectContaining({ cellId: oldRunway.interactionPrefetchCellAddresses[0]!.cellId })
    );
    expect(h.recordEvent).toHaveBeenCalledWith(
      'compiled-broad-raster-staged-cells-dropped',
      expect.objectContaining({
        reason: 'interaction-prefetch-superseded-by-camera',
        remainingCount: 0,
        supersededCount: 1,
      })
    );
    await vi.waitFor(() =>
      expect(h.readCells).toHaveBeenCalledWith(
        expect.objectContaining({
          addresses: [
            expect.objectContaining({
              tileX: newestRequired.requiredCellAddresses[0]!.tileX,
            }),
          ],
        })
      )
    );
  });

  it('promotes a transported interaction-runway cell when the newest camera requires it', async () => {
    const h = harness({ manualPostPresent: true, manualIdleWarm: true });
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    const oldRunway = demandWithInteractionPrefetch(surface, 'expanded', 1, 20);
    const promoted = oldRunway.interactionPrefetchCellAddresses[0]!;
    h.currentDemand.value = oldRunway;
    h.alternateDemand.value = demand(surface, 'canonical', 0);

    await h.loader.reconcile(target());
    await vi.waitFor(() => expect(h.loader.diagnostics().pendingAdmissionCellCount).toBe(1));
    h.currentDemand.value = {
      ...demand(surface, 'expanded', 0),
      requiredCellAddresses: [promoted],
      missingRequiredCellAddresses: [promoted],
      missingCellAddresses: [promoted],
    };
    h.loader.signalCameraChanged();
    h.runPostPresentWork();

    expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).toHaveBeenCalledWith(
      expect.objectContaining({ cellId: promoted.cellId })
    );
    expect(h.recordEvent).not.toHaveBeenCalledWith(
      'compiled-broad-raster-staged-cells-dropped',
      expect.objectContaining({ reason: 'interaction-prefetch-superseded-by-camera' })
    );
  });

  it('promotes an in-flight runway response when the newest camera requires it', async () => {
    const h = harness({ manualPostPresent: true, manualIdleWarm: true });
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    const oldRunway = demandWithInteractionPrefetch(surface, 'expanded', 1, 20);
    const promoted = oldRunway.interactionPrefetchCellAddresses[0]!;
    h.currentDemand.value = oldRunway;
    h.alternateDemand.value = demand(surface, 'canonical', 0);
    let releaseOldRead!: (value: ReturnType<typeof h.cellResponse>) => void;
    let oldRequest: AssemblyCompiledBroadRasterCellsRequestV1 | null = null;
    h.readCells.mockImplementationOnce(
      (request) =>
        new Promise((resolve) => {
          oldRequest = request;
          releaseOldRead = resolve;
        })
    );

    const initial = h.loader.reconcile(target());
    await vi.waitFor(() => expect(oldRequest).not.toBeNull());
    h.currentDemand.value = {
      ...demand(surface, 'expanded', 0),
      requiredCellAddresses: [promoted],
      missingRequiredCellAddresses: [promoted],
      missingCellAddresses: [promoted],
    };
    h.loader.signalCameraChanged();
    releaseOldRead(h.cellResponse(oldRequest!));
    await initial;
    await vi.waitFor(() => expect(h.loader.diagnostics().pendingAdmissionCellCount).toBe(1));
    h.runPostPresentWork();

    expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).toHaveBeenCalledWith(
      expect.objectContaining({ cellId: promoted.cellId })
    );
    expect(h.recordEvent).not.toHaveBeenCalledWith(
      'compiled-broad-raster-stale-response-dropped',
      expect.objectContaining({ phase: 'interaction-prefetch-cells-camera' })
    );
  });

  it('retains transported runway still owned after the newest foreground is complete', async () => {
    const h = harness({ manualPostPresent: true, manualIdleWarm: true });
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    const oldRunway = demandWithInteractionPrefetch(surface, 'expanded', 1, 20);
    const retained = oldRunway.interactionPrefetchCellAddresses[0]!;
    h.currentDemand.value = oldRunway;
    h.alternateDemand.value = demand(surface, 'canonical', 0);

    await h.loader.reconcile(target());
    await vi.waitFor(() => expect(h.loader.diagnostics().pendingAdmissionCellCount).toBe(1));
    h.currentDemand.value = {
      ...demand(surface, 'expanded', 0),
      interactionPrefetchCellAddresses: [retained],
      missingInteractionPrefetchCellAddresses: [retained],
      missingCellAddresses: [retained],
    };
    h.loader.signalCameraChanged();
    h.runPostPresentWork();

    expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).toHaveBeenCalledWith(
      expect.objectContaining({ cellId: retained.cellId })
    );
    expect(h.recordEvent).not.toHaveBeenCalledWith(
      'compiled-broad-raster-staged-cells-dropped',
      expect.objectContaining({ reason: 'interaction-prefetch-superseded-by-camera' })
    );
  });

  it('drops transported runway instead of blocking an unrelated newest foreground', async () => {
    const h = harness({ manualPostPresent: true, manualIdleWarm: true });
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    const oldRunway = demandWithInteractionPrefetch(surface, 'expanded', 1, 20);
    const staleRunway = oldRunway.interactionPrefetchCellAddresses[0]!;
    const newestRequired = demand(surface, 'expanded', 1).requiredCellAddresses[0]!;
    h.currentDemand.value = oldRunway;
    h.alternateDemand.value = demand(surface, 'canonical', 0);

    await h.loader.reconcile(target());
    await vi.waitFor(() => expect(h.loader.diagnostics().pendingAdmissionCellCount).toBe(1));
    h.currentDemand.value = {
      ...demand(surface, 'expanded', 0),
      requiredCellAddresses: [newestRequired],
      missingRequiredCellAddresses: [newestRequired],
      interactionPrefetchCellAddresses: [staleRunway],
      missingInteractionPrefetchCellAddresses: [staleRunway],
      missingCellAddresses: [newestRequired, staleRunway],
    };
    h.loader.signalCameraChanged();
    h.runPostPresentWork();

    expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).not.toHaveBeenCalledWith(
      expect.objectContaining({ cellId: staleRunway.cellId })
    );
    expect(h.recordEvent).toHaveBeenCalledWith(
      'compiled-broad-raster-staged-cells-dropped',
      expect.objectContaining({ reason: 'interaction-prefetch-superseded-by-camera' })
    );
  });

  it('cancels a broad successor batch when a newer camera invalidates that prediction', async () => {
    const h = harness({ manualPostPresent: true, manualIdleWarm: true });
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    const oldSuccessor = demandWithSuccessor(surface, 'expanded', 1, 20);
    h.currentDemand.value = oldSuccessor;
    h.alternateDemand.value = demand(surface, 'canonical', 0);

    await h.loader.reconcile(target());
    await vi.waitFor(() => expect(h.loader.diagnostics().pendingAdmissionCellCount).toBe(1));
    h.currentDemand.value = demand(surface, 'expanded', 0);
    h.loader.signalCameraChanged();
    h.runPostPresentWork();

    expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).not.toHaveBeenCalledWith(
      expect.objectContaining({ cellId: oldSuccessor.successorCellAddresses[0]!.cellId })
    );
    expect(h.recordEvent).toHaveBeenCalledWith(
      'compiled-broad-raster-staged-cells-dropped',
      expect.objectContaining({
        reason: 'successor-superseded-by-camera',
        remainingCount: 0,
        supersededCount: 1,
      })
    );
  });

  it('retains the mandatory detail-return successor across detail camera epochs', async () => {
    const h = harness({ manualPostPresent: true, manualIdleWarm: true });
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    const detailReturn = {
      ...demandWithSuccessor(surface, 'expanded', 1, 20),
      status: 'detail-required' as const,
    };
    h.currentDemand.value = detailReturn;
    h.alternateDemand.value = {
      ...demand(surface, 'canonical', 0),
      status: 'detail-required',
    };

    await h.loader.reconcile(target());
    await vi.waitFor(() => expect(h.loader.diagnostics().pendingAdmissionCellCount).toBe(1));
    h.loader.signalCameraChanged();
    h.runPostPresentWork();

    expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).toHaveBeenCalledWith(
      expect.objectContaining({ cellId: detailReturn.successorCellAddresses[0]!.cellId })
    );
    expect(h.recordEvent).not.toHaveBeenCalledWith(
      'compiled-broad-raster-staged-cells-dropped',
      expect.objectContaining({ reason: 'successor-superseded-by-camera' })
    );
  });

  it('retains admitted runway cells but discards the remainder after camera supersession', async () => {
    let clockMs = 0;
    const h = harness({
      manualPostPresent: true,
      manualIdleWarm: true,
      now: () => clockMs,
    });
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    const oldRunway = demandWithInteractionPrefetch(surface, 'expanded', 2, 20);
    h.currentDemand.value = oldRunway;
    h.alternateDemand.value = demand(surface, 'canonical', 0);
    const rgbaAdmission = vi.mocked(h.renderer.admitCompiledBroadSurfaceRgbaCell);
    const originalAdmission = rgbaAdmission.getMockImplementation()!;
    rgbaAdmission.mockImplementation((cell) => {
      const result = originalAdmission(cell);
      clockMs += 6;
      return result;
    });

    await h.loader.reconcile(target());
    h.runPostPresentWork(10);
    expect(rgbaAdmission).toHaveBeenCalledTimes(1);
    h.currentDemand.value = demand(surface, 'expanded', 0);
    h.loader.signalCameraChanged();
    h.runPostPresentWork(16);

    await vi.waitFor(() =>
      expect(h.loader.diagnostics()).toMatchObject({
        pendingAdmissionCellCount: 0,
        totalAdmittedCellCount: 1,
      })
    );
    expect(rgbaAdmission).toHaveBeenCalledTimes(1);
    expect(rgbaAdmission).toHaveBeenCalledWith(
      expect.objectContaining({ cellId: oldRunway.interactionPrefetchCellAddresses[0]!.cellId })
    );
    expect(h.recordEvent).toHaveBeenCalledWith(
      'compiled-broad-raster-cells-admitted',
      expect.objectContaining({
        admittedCount: 1,
        supersededCount: 1,
        tier: 'interaction-prefetch',
      })
    );
  });

  it('does not commit a replacement policy until its latest-camera continuity envelope is resident', async () => {
    const h = harness({ manualPostPresent: true, manualIdleWarm: true });
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    h.alternateDemand.value = demand(surface, 'canonical', 0);
    h.currentDemand.value = demand(surface, 'expanded', 0);

    await h.loader.reconcile(
      target('fixture-runtime-key', { isoformMode: 'canonical', laneLimit: 12 }, 51)
    );
    expect(h.renderer.updateAnnotationPresentationPolicy).toHaveBeenLastCalledWith({
      isoformMode: 'canonical',
      laneLimit: 12,
    });

    h.currentDemand.value = demandWithSuccessor(surface, 'expanded', 1);
    await h.loader.reconcile(
      target('fixture-runtime-key', { isoformMode: 'expanded', laneLimit: 12 }, 52)
    );

    expect(h.loader.diagnostics().pendingAdmissionCellCount).toBe(1);
    expect(h.renderer.updateAnnotationPresentationPolicy).not.toHaveBeenCalledWith({
      isoformMode: 'expanded',
      laneLimit: 12,
    });
    expect(h.policyCommitReceipts).not.toContainEqual(
      expect.objectContaining({ policyRequestId: 52 })
    );

    h.runPostPresentWork();
    await vi.waitFor(() =>
      expect(h.policyCommitReceipts).toContainEqual(
        expect.objectContaining({
          policyRequestId: 52,
          policy: { isoformMode: 'expanded', laneLimit: 12 },
        })
      )
    );
  });

  it('loads the current camera before its successor when only the camera changed', async () => {
    const h = harness({ manualPostPresent: true, manualIdleWarm: true });
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    h.currentDemand.value = demand(surface, 'expanded', 0);
    h.alternateDemand.value = demand(surface, 'canonical', 0);
    await h.loader.reconcile(target());

    const current = demand(surface, 'expanded', 2, 40);
    const successor = demand(surface, 'expanded', 8, 50).requiredCellAddresses;
    h.currentDemand.value = {
      ...current,
      successorCellAddresses: successor,
      missingSuccessorCellAddresses: successor,
      missingCellAddresses: [...current.missingRequiredCellAddresses, ...successor],
    };

    void h.loader.refreshDemand();
    await vi.waitFor(() =>
      expect(h.loader.diagnostics()).toMatchObject({ pendingAdmissionCellCount: 2 })
    );
    expect(h.readCells).toHaveBeenCalledTimes(2);
    expect(
      h.readCells.mock.calls.flatMap(([request]) => request.addresses.map(({ tileX }) => tileX))
    ).toEqual([40, 41]);

    h.runPostPresentWork();
    await vi.waitFor(() => expect(h.readCells).toHaveBeenCalledTimes(10));
    expect(
      h.readCells.mock.calls
        .slice(2)
        .flatMap(([request]) => request.addresses.map(({ tileX }) => tileX))
    ).toEqual([50, 51, 52, 53, 54, 55, 56, 57]);
  });

  it('commits a replacement from the newest complete roster even when its camera epoch advanced', async () => {
    const h = harness();
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    h.alternateDemand.value = demand(surface, 'canonical', 0);
    h.currentDemand.value = demand(surface, 'expanded', 0);

    await h.loader.reconcile(
      target('fixture-runtime-key', { isoformMode: 'canonical', laneLimit: 12 }, 53)
    );

    const getDemand = vi.mocked(h.renderer.getCompiledBroadSurfaceDemand);
    const originalGetDemand = getDemand.getMockImplementation()!;
    let injectCameraEpoch = true;
    getDemand.mockImplementation((policy, manifestFingerprint) => {
      const result = originalGetDemand(policy, manifestFingerprint);
      if (injectCameraEpoch && policy?.isoformMode === 'expanded') {
        injectCameraEpoch = false;
        queueMicrotask(() => h.loader.signalCameraChanged());
      }
      return result;
    });

    await h.loader.reconcile(
      target('fixture-runtime-key', { isoformMode: 'expanded', laneLimit: 12 }, 54)
    );

    expect(h.loader.diagnostics().cameraNotificationCount).toBe(1);
    expect(h.policyCommitReceipts).toContainEqual(
      expect.objectContaining({
        policyRequestId: 54,
        policy: { isoformMode: 'expanded', laneLimit: 12 },
      })
    );
  });

  it('does not delay a replacement policy for passive cache warming', async () => {
    const h = harness({ manualPostPresent: true, manualIdleWarm: true });
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    h.alternateDemand.value = demand(surface, 'canonical', 0);
    h.currentDemand.value = demand(surface, 'expanded', 0);

    await h.loader.reconcile(
      target('fixture-runtime-key', { isoformMode: 'canonical', laneLimit: 12 }, 61)
    );

    h.currentDemand.value = demandWithPrefetch(surface, 'expanded', 1);
    await h.loader.reconcile(
      target('fixture-runtime-key', { isoformMode: 'expanded', laneLimit: 12 }, 62)
    );

    expect(h.policyCommitReceipts).toContainEqual(
      expect.objectContaining({
        policyRequestId: 62,
        policy: { isoformMode: 'expanded', laneLimit: 12 },
      })
    );
    expect(h.readCells).not.toHaveBeenCalled();
    expect(h.loader.diagnostics().pendingAdmissionCellCount).toBe(0);
    expect(h.policyControlsReadiness.at(-1)).toBe('ready');
  });

  it('keeps a policy replacement atomic while cancelling passive cache warming when interaction resumes', async () => {
    let interactionQuietDelayMs = 0;
    const h = harness({
      manualPostPresent: true,
      manualIdleWarm: true,
      rendererInteractionQuietDelayMs: () => interactionQuietDelayMs,
    });
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    h.alternateDemand.value = demand(surface, 'canonical', 0);
    h.currentDemand.value = demand(surface, 'expanded', 0);

    await h.loader.reconcile(
      target('fixture-runtime-key', { isoformMode: 'canonical', laneLimit: 12 }, 71)
    );

    h.currentDemand.value = demandWithPrefetch(surface, 'expanded', 1);
    await h.loader.reconcile(
      target('fixture-runtime-key', { isoformMode: 'expanded', laneLimit: 12 }, 72)
    );

    expect(h.policyCommitReceipts).toContainEqual(
      expect.objectContaining({
        policyRequestId: 72,
        policy: { isoformMode: 'expanded', laneLimit: 12 },
      })
    );
    expect(h.loader.diagnostics().pendingAdmissionCellCount).toBe(0);

    h.runIdleWarmWork();
    h.runPostPresentWork(Number.POSITIVE_INFINITY);
    await vi.waitFor(() =>
      expect(h.loader.diagnostics()).toMatchObject({ pendingAdmissionCellCount: 1 })
    );
    expect(h.loader.diagnostics().pendingAdmissionCellCount).toBe(1);

    interactionQuietDelayMs = 200;
    h.loader.signalCameraChanged();
    h.runPostPresentWork(Number.POSITIVE_INFINITY);

    expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).not.toHaveBeenCalled();
    expect(h.recordEvent).toHaveBeenCalledWith(
      'compiled-broad-raster-staged-cells-dropped',
      expect.objectContaining({ reason: 'passive-warm-superseded-by-camera' })
    );
  });

  it('defers passive current-policy cache admission until interaction is quiet', async () => {
    let interactionQuietDelayMs = 0;
    const h = harness({
      manualPostPresent: true,
      manualIdleWarm: true,
      rendererInteractionQuietDelayMs: () => interactionQuietDelayMs,
    });
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    h.currentDemand.value = demandWithPrefetch(surface, 'expanded', 1);
    h.alternateDemand.value = demand(surface, 'canonical', 0);

    await h.loader.reconcile(target());
    expect(h.readCells).not.toHaveBeenCalled();
    h.runIdleWarmWork();
    h.runPostPresentWork();
    await vi.waitFor(() => expect(h.readCells).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(h.loader.diagnostics()).toMatchObject({ pendingAdmissionCellCount: 1 })
    );

    interactionQuietDelayMs = 200;
    h.runPostPresentWork();
    expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).not.toHaveBeenCalled();
    expect(h.scheduleDelayedWork).toHaveBeenCalledWith(expect.any(Function), 200);

    interactionQuietDelayMs = 0;
    h.runIdleWarmWork();
    h.runPostPresentWork();
    expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).toHaveBeenCalledTimes(1);
  });

  it('defers a post-ready interaction runway upload until active input is quiet', async () => {
    let interactionQuietDelayMs = 0;
    const h = harness({
      manualPostPresent: true,
      manualIdleWarm: true,
      rendererInteractionQuietDelayMs: () => interactionQuietDelayMs,
    });
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    h.currentDemand.value = demand(surface, 'expanded', 0);
    h.alternateDemand.value = demand(surface, 'canonical', 0);

    await h.loader.reconcile(target());
    expect(h.readiness.at(-1)).toBe('ready');

    interactionQuietDelayMs = 200;
    h.currentDemand.value = demandWithInteractionPrefetch(surface, 'expanded', 1, 20);
    h.loader.signalCameraChanged();
    h.runPostPresentWork();
    await vi.waitFor(() => expect(h.readCells).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(h.loader.diagnostics()).toMatchObject({
        pendingAdmissionCellCount: 1,
        pendingAdmissionTier: 'interaction-prefetch',
      })
    );

    h.runPostPresentWork();
    expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).not.toHaveBeenCalled();
    expect(h.scheduleDelayedWork).toHaveBeenCalledWith(expect.any(Function), 200);

    interactionQuietDelayMs = 0;
    h.runIdleWarmWork();
    h.runPostPresentWork();
    expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).toHaveBeenCalledTimes(1);
  });

  it('rechecks interaction quiet before an already-fired idle callback may evict residency', async () => {
    let interactionQuietDelayMs = 0;
    const h = harness({
      manualPostPresent: true,
      manualIdleWarm: true,
      rendererInteractionQuietDelayMs: () => interactionQuietDelayMs,
    });
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    h.currentDemand.value = demand(surface, 'expanded', 0);
    h.alternateDemand.value = demand(surface, 'canonical', 0);

    await h.loader.reconcile(target());
    expect(h.readiness.at(-1)).toBe('ready');

    vi.mocked(h.renderer.getCompiledBroadSurfaceDemand).mockClear();
    h.runIdleWarmWork();
    interactionQuietDelayMs = 200;
    h.runPostPresentWork();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(h.renderer.reconcileCompiledBroadSurfaceResidentLeases).not.toHaveBeenCalled();
    expect(h.renderer.getCompiledBroadSurfaceDemand).not.toHaveBeenCalled();
    expect(h.scheduleDelayedWork).toHaveBeenLastCalledWith(expect.any(Function), 200);

    interactionQuietDelayMs = 0;
    h.runIdleWarmWork();
    h.runPostPresentWork();

    await vi.waitFor(() =>
      expect(h.renderer.reconcileCompiledBroadSurfaceResidentLeases).toHaveBeenCalledTimes(1)
    );
  });

  it('cancels pending passive admission when camera movement makes current demand foreground work', async () => {
    let interactionQuietDelayMs = 0;
    const h = harness({
      manualPostPresent: true,
      manualIdleWarm: true,
      rendererInteractionQuietDelayMs: () => interactionQuietDelayMs,
    });
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    h.currentDemand.value = demandWithPrefetch(surface, 'expanded', 1);
    h.alternateDemand.value = demand(surface, 'canonical', 0);

    await h.loader.reconcile(target());
    expect(h.readCells).not.toHaveBeenCalled();
    h.runIdleWarmWork();
    h.runPostPresentWork();
    await vi.waitFor(() => expect(h.loader.diagnostics().pendingAdmissionCellCount).toBe(1));

    interactionQuietDelayMs = 200;
    h.loader.signalCameraChanged();
    h.runPostPresentWork();

    expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).not.toHaveBeenCalled();
    expect(h.recordEvent).toHaveBeenCalledWith(
      'compiled-broad-raster-staged-cells-dropped',
      expect.objectContaining({
        reason: 'passive-warm-superseded-by-camera',
        remainingCount: 0,
        supersededCount: 1,
      })
    );
  });

  it('admits cold first-owner raster cells during interaction', async () => {
    const h = harness({
      manualPostPresent: true,
      manualIdleWarm: true,
      now: () => 0,
      rendererInteractionQuietDelayMs: () => 200,
    });
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    h.currentDemand.value = demand(surface, 'expanded', 1);
    h.alternateDemand.value = demand(surface, 'canonical', 0);

    await h.loader.reconcile(target());
    await vi.waitFor(() => expect(h.loader.diagnostics().pendingAdmissionCellCount).toBe(1));

    h.runPostPresentWork();
    expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(h.readiness.at(-1)).toBe('ready'));
  });

  it('admits newly required camera cells during interaction when an older owner is ready', async () => {
    const h = harness({
      manualPostPresent: true,
      manualIdleWarm: true,
      rendererInteractionQuietDelayMs: () => 200,
    });
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    h.currentDemand.value = demand(surface, 'expanded', 0);
    h.alternateDemand.value = demand(surface, 'canonical', 0);

    await h.loader.reconcile(target());
    expect(h.readiness.at(-1)).toBe('ready');

    h.currentDemand.value = demand(surface, 'expanded', 1);
    h.loader.signalCameraChanged();
    h.runPostPresentWork();
    await vi.waitFor(() => expect(h.loader.diagnostics().pendingAdmissionCellCount).toBe(1));

    h.runPostPresentWork();
    expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).toHaveBeenCalledTimes(1);
    expect(h.scheduleDelayedWork).not.toHaveBeenCalledWith(expect.any(Function), 200);
  });

  it('uses the prewarmed adjacent slab when the active policy expands from 8 to 16 lanes', async () => {
    const h = harness();
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    h.currentDemand.value = demandForSlabs(surface, 'expanded', [0, 1, 2, 3, 4, 5, 6, 7]);
    h.alternateDemand.value = demandForSlabs(surface, 'canonical', [0, 1]);

    await h.loader.reconcile(
      target('fixture-runtime-key', { isoformMode: 'expanded', laneLimit: 8 }, 41)
    );
    await vi.waitFor(() =>
      expect(h.policyCommitReceipts).toContainEqual(
        expect.objectContaining({ policyRequestId: 41 })
      )
    );
    await vi.waitFor(() =>
      expect(h.renderer.reconcileCompiledBroadSurfaceResidentLeases).toHaveBeenCalled()
    );
    const readsAfterInitialPolicy = h.readCells.mock.calls.length;
    const loadingTransitionsAfterInitialPolicy = h.readiness.filter(
      (value) => value === 'loading'
    ).length;
    const controlsWarmingTransitionsAfterInitialPolicy = h.policyControlsReadiness.filter(
      (value) => value === 'warming'
    ).length;

    await h.loader.reconcile(
      target('fixture-runtime-key', { isoformMode: 'expanded', laneLimit: 16 }, 42)
    );
    await vi.waitFor(() =>
      expect(h.policyCommitReceipts).toContainEqual(
        expect.objectContaining({ policyRequestId: 42 })
      )
    );

    const replenishmentRequests = h.readCells.mock.calls.slice(readsAfterInitialPolicy);
    expect(replenishmentRequests).toHaveLength(0);
    expect(h.readiness.filter((value) => value === 'loading')).toHaveLength(
      loadingTransitionsAfterInitialPolicy
    );
    expect(
      h.policyControlsReadiness.filter((value) => value === 'warming').length
    ).toBeGreaterThanOrEqual(controlsWarmingTransitionsAfterInitialPolicy);
    expect(h.renderer.getCompiledBroadSurfaceDemand).toHaveBeenCalledWith(
      {
        isoformMode: 'expanded',
        laneLimit: 16,
      },
      surface.manifestFingerprint
    );
    expect(h.readManifest).toHaveBeenCalledTimes(1);
    expect(h.renderer.admitCompiledBroadSurfaceSourcePlacementAuthority).toHaveBeenCalledTimes(1);
    expect(h.renderer.updateAnnotationPresentationPolicy).toHaveBeenCalledWith({
      isoformMode: 'expanded',
      laneLimit: 8,
    });
    expect(h.renderer.updateAnnotationPresentationPolicy).toHaveBeenLastCalledWith({
      isoformMode: 'expanded',
      laneLimit: 16,
    });
    expect(h.policyCommitReceipts).toEqual([
      expect.objectContaining({
        contract: ASSEMBLY_COMPILED_BROAD_RASTER_POLICY_COMMIT_V1,
        policyRequestId: 41,
        policy: { isoformMode: 'expanded', laneLimit: 8 },
        surfaceManifestFingerprint: surface.manifestFingerprint,
        catalogReceiptSha256: RECEIPT_SHA256,
      }),
      expect.objectContaining({
        contract: ASSEMBLY_COMPILED_BROAD_RASTER_POLICY_COMMIT_V1,
        policyRequestId: 42,
        policy: { isoformMode: 'expanded', laneLimit: 16 },
        surfaceManifestFingerprint: surface.manifestFingerprint,
        catalogReceiptSha256: RECEIPT_SHA256,
      }),
    ]);
  });

  it('treats an exact same-target reconcile as a no-op while a delayed cell read is in flight', async () => {
    const h = harness({ manualPostPresent: true });
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    h.currentDemand.value = demand(surface, 'expanded', 1);
    h.alternateDemand.value = demand(surface, 'canonical', 0);
    let releaseCell!: (value: ReturnType<typeof h.cellResponse>) => void;
    let delayedRequest: AssemblyCompiledBroadRasterCellsRequestV1 | null = null;
    const defaultRead = h.readCells.getMockImplementation()!;
    h.readCells.mockImplementationOnce(
      (request) =>
        new Promise((resolve) => {
          delayedRequest = request;
          releaseCell = resolve;
        })
    );

    const first = h.loader.reconcile(
      target('fixture-runtime-key', { isoformMode: 'expanded', laneLimit: 12 }, 41)
    );
    await vi.waitFor(() => expect(delayedRequest).not.toBeNull());
    const duplicate = h.loader.reconcile(
      target('fixture-runtime-key', { isoformMode: 'expanded', laneLimit: 12 }, 41)
    );
    await Promise.resolve();
    h.readCells.mockImplementation(defaultRead);
    releaseCell(h.cellResponse(delayedRequest!));
    await Promise.all([first, duplicate]);

    expect(h.readManifest).toHaveBeenCalledTimes(1);
    expect(h.readCells).toHaveBeenCalledTimes(1);
    expect(h.loader.diagnostics()).toMatchObject({
      pendingAdmissionCellCount: 1,
      staleResponseCount: 0,
      stagedCellDropCount: 0,
    });
    h.runPostPresentWork();
    await vi.waitFor(() =>
      expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).toHaveBeenCalledTimes(1)
    );
  });

  it('preserves delayed valid work across a policy/request-only reconcile and commits the newest command', async () => {
    const h = harness({ manualPostPresent: true });
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    h.currentDemand.value = demandForSlabs(surface, 'expanded', [0]);
    h.alternateDemand.value = demand(surface, 'canonical', 0);
    let releaseCell!: (value: ReturnType<typeof h.cellResponse>) => void;
    let delayedRequest: AssemblyCompiledBroadRasterCellsRequestV1 | null = null;
    h.readCells.mockImplementationOnce(
      (request) =>
        new Promise((resolve) => {
          delayedRequest = request;
          releaseCell = resolve;
        })
    );

    const first = h.loader.reconcile(
      target('fixture-runtime-key', { isoformMode: 'expanded', laneLimit: 8 }, 41)
    );
    await vi.waitFor(() => expect(delayedRequest).not.toBeNull());
    const policyChange = h.loader.reconcile(
      target('fixture-runtime-key', { isoformMode: 'expanded', laneLimit: 24 }, 42)
    );
    releaseCell(h.cellResponse(delayedRequest!));
    await Promise.all([first, policyChange]);

    expect(h.readManifest).toHaveBeenCalledTimes(1);
    expect(h.readCells).toHaveBeenCalledTimes(1);
    expect(h.loader.diagnostics()).toMatchObject({
      pendingAdmissionCellCount: 1,
      staleResponseCount: 0,
      stagedCellDropCount: 0,
    });
    h.runPostPresentWork();
    await vi.waitFor(() =>
      expect(h.policyCommitReceipts).toContainEqual(
        expect.objectContaining({
          policyRequestId: 42,
          policy: { isoformMode: 'expanded', laneLimit: 24 },
        })
      )
    );
    expect(
      h.policyCommitReceipts.filter(
        (receipt) => (receipt as { policyRequestId?: number }).policyRequestId === 42
      )
    ).toEqual([
      expect.objectContaining({
        policyRequestId: 42,
        policy: { isoformMode: 'expanded', laneLimit: 24 },
      }),
    ]);
    expect(h.readManifest).toHaveBeenCalledTimes(1);
    expect(h.readCells).toHaveBeenCalledTimes(1);
  });

  it('derives the active finite-policy slab ceiling from the shared lane limit and admitted manifest geometry', async () => {
    const h = harness();
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    h.alternateDemand.value = demand(surface, 'canonical', 0);
    const firstOutsideWarmSlabIndex = Math.ceil(
      COMPILED_BROAD_SURFACE_MAX_FINITE_LANE_LIMIT_V2 / surface.laneSlabRowCount
    );
    const malformedAddress = {
      isoformMode: 'expanded' as const,
      level: 0,
      tileX: 0,
      laneSlabIndex: firstOutsideWarmSlabIndex,
      cellId: 'malformed-outside-finite-manifest',
    };
    h.currentDemand.value = {
      ...demand(surface, 'expanded', 0),
      requiredCellAddresses: [malformedAddress],
      missingRequiredCellAddresses: [malformedAddress],
      missingCellAddresses: [malformedAddress],
    };
    h.renderer.getCompiledBroadSurfaceDemand = vi.fn((policy) => {
      const selected =
        policy?.isoformMode === 'expanded' ? h.currentDemand.value : h.alternateDemand.value;
      return selected && policy ? { ...selected, laneLimit: policy.laneLimit } : selected;
    });

    await h.loader.reconcile(
      target('fixture-runtime-key', {
        isoformMode: 'expanded',
        laneLimit: COMPILED_BROAD_SURFACE_MAX_FINITE_LANE_LIMIT_V2,
      })
    );

    expect(
      h.readCells.mock.calls.some(([request]) =>
        request.addresses.some(
          (address) =>
            address.isoformMode === 'expanded' &&
            address.laneSlabIndex === firstOutsideWarmSlabIndex
        )
      )
    ).toBe(false);
    expect(h.recordEvent).toHaveBeenCalledWith(
      'compiled-broad-raster-rejected',
      expect.objectContaining({ reason: 'renderer-demand-address-invalid' })
    );
  });

  it('fails closed instead of reading a slab outside the finite 64-lane envelope', async () => {
    const h = harness();
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    h.alternateDemand.value = demand(surface, 'canonical', 0);
    const malformedAddress = {
      isoformMode: 'expanded' as const,
      level: 0,
      tileX: 0,
      laneSlabIndex: 8,
      cellId: 'malformed-outside-finite-manifest',
    };
    h.currentDemand.value = {
      ...demand(surface, 'expanded', 0),
      requiredCellAddresses: [malformedAddress],
      missingRequiredCellAddresses: [malformedAddress],
      missingCellAddresses: [malformedAddress],
    };
    h.renderer.getCompiledBroadSurfaceDemand = vi.fn((policy) => {
      const selected =
        policy?.isoformMode === 'expanded' ? h.currentDemand.value : h.alternateDemand.value;
      return selected && policy ? { ...selected, laneLimit: policy.laneLimit } : selected;
    });

    await h.loader.reconcile(
      target('fixture-runtime-key', {
        isoformMode: 'expanded',
        laneLimit: COMPILED_BROAD_SURFACE_MAX_FINITE_LANE_LIMIT_V2,
      })
    );

    expect(
      h.readCells.mock.calls.some(([request]) =>
        request.addresses.some((address) => address.laneSlabIndex >= 8)
      )
    ).toBe(false);
    expect(h.recordEvent).toHaveBeenCalledWith(
      'compiled-broad-raster-rejected',
      expect.objectContaining({ reason: 'renderer-demand-address-invalid' })
    );
  });

  it('drops only obsolete cells from an in-flight camera batch and re-snapshots newest demand', async () => {
    const h = harness();
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    const oldDemand = demand(surface, 'expanded', 1, 0);
    const newDemand = demand(surface, 'expanded', 1, 20);
    h.currentDemand.value = oldDemand;
    h.alternateDemand.value = demand(surface, 'canonical', 0);
    let releaseOld!: (value: ReturnType<typeof h.cellResponse>) => void;
    let oldRequest: AssemblyCompiledBroadRasterCellsRequestV1 | null = null;
    const defaultRead = h.readCells.getMockImplementation()!;
    h.readCells.mockImplementationOnce(
      (request) =>
        new Promise((resolve) => {
          oldRequest = request;
          releaseOld = resolve;
        })
    );

    const pending = h.loader.reconcile(target());
    await vi.waitFor(() => expect(oldRequest).not.toBeNull());
    h.currentDemand.value = newDemand;
    const newest = h.loader.refreshDemand();
    releaseOld(h.cellResponse(oldRequest!));
    h.readCells.mockImplementation(defaultRead);
    await Promise.all([pending, newest]);

    expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).not.toHaveBeenCalledWith(
      expect.objectContaining({ cellId: oldDemand.missingCellAddresses[0]!.cellId })
    );
    expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).toHaveBeenCalledWith(
      expect.objectContaining({ cellId: newDemand.missingCellAddresses[0]!.cellId })
    );
    expect(h.recordEvent).toHaveBeenCalledWith(
      'compiled-broad-raster-cells-admitted',
      expect.objectContaining({ admittedCount: 0, supersededCount: 1 })
    );
  });

  it('serializes a camera refresh behind an in-flight quiet warm read', async () => {
    const h = harness({ manualPostPresent: true, manualIdleWarm: true });
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    h.currentDemand.value = demand(surface, 'expanded', 0);
    h.alternateDemand.value = demand(surface, 'canonical', 0);
    await h.loader.reconcile(target());

    h.currentDemand.value = demandWithPrefetch(surface, 'expanded', 1, 9);
    let releaseWarmRead!: () => void;
    h.readCells.mockImplementationOnce(
      (request) =>
        new Promise((resolve) => {
          releaseWarmRead = () => resolve(h.cellResponse(request));
        })
    );

    h.runIdleWarmWork();
    h.runPostPresentWork();
    await vi.waitFor(() => expect(h.readCells).toHaveBeenCalledTimes(1));

    h.loader.signalCameraChanged();
    h.runPostPresentWork();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(h.readCells).toHaveBeenCalledTimes(1);

    releaseWarmRead();
    await vi.waitFor(() =>
      expect(h.recordEvent).toHaveBeenCalledWith('compiled-broad-raster-stale-response-dropped', {
        phase: 'passive-cells-camera',
      })
    );
    h.runPostPresentWork();
    await vi.waitFor(() =>
      expect(h.loader.diagnostics()).toMatchObject({
        readiness: 'ready',
        policyControlsReadiness: 'ready',
        pendingAdmissionCellCount: 0,
      })
    );
    expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).not.toHaveBeenCalled();
    expect(h.readCells).toHaveBeenCalledTimes(1);
    expect(h.recordEvent).not.toHaveBeenCalledWith(
      'compiled-broad-raster-rejected',
      expect.objectContaining({ reason: 'renderer-admission-batch-overlap' })
    );
  });

  it('serializes a quiet warm callback behind an in-flight demand pump read', async () => {
    const h = harness({ manualPostPresent: true, manualIdleWarm: true });
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    h.currentDemand.value = demand(surface, 'expanded', 0);
    h.alternateDemand.value = demand(surface, 'canonical', 0);
    await h.loader.reconcile(target());

    h.currentDemand.value = demand(surface, 'expanded', 1, 11);
    let releaseDemandRead!: () => void;
    h.readCells.mockImplementationOnce(
      (request) =>
        new Promise((resolve) => {
          releaseDemandRead = () => resolve(h.cellResponse(request));
        })
    );

    const demandRefresh = h.loader.refreshDemand(false);
    await vi.waitFor(() => expect(h.readCells).toHaveBeenCalledTimes(1));

    h.runIdleWarmWork();
    h.runPostPresentWork();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(h.readCells).toHaveBeenCalledTimes(1);

    releaseDemandRead();
    await demandRefresh;
    await vi.waitFor(() =>
      expect(h.loader.diagnostics()).toMatchObject({ pendingAdmissionCellCount: 1 })
    );
    h.runPostPresentWork();
    await vi.waitFor(() =>
      expect(h.loader.diagnostics()).toMatchObject({
        readiness: 'ready',
        policyControlsReadiness: 'ready',
        pendingAdmissionCellCount: 0,
      })
    );
    expect(h.readCells).toHaveBeenCalledTimes(1);
    expect(h.recordEvent).not.toHaveBeenCalledWith(
      'compiled-broad-raster-rejected',
      expect.objectContaining({ reason: 'renderer-admission-batch-overlap' })
    );
  });

  it('treats 12 camera notifications as one scalar post-present demand signal with no readiness churn', async () => {
    const h = harness({ manualPostPresent: true });
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    h.currentDemand.value = demand(surface, 'expanded', 0);
    h.alternateDemand.value = demand(surface, 'canonical', 0);
    await h.loader.reconcile(target());
    const readsBeforeCamera = h.readCells.mock.calls.length;
    const readinessBeforeCamera = [...h.readiness];
    const controlsBeforeCamera = [...h.policyControlsReadiness];
    const scheduledBeforeCamera = h.schedulePostPresentWork.mock.calls.length;
    h.currentDemand.value = demand(surface, 'expanded', 1, 3);

    for (let epoch = 0; epoch < 12; epoch += 1) h.loader.signalCameraChanged();

    expect(h.schedulePostPresentWork).toHaveBeenCalledTimes(scheduledBeforeCamera);
    expect(h.readCells).toHaveBeenCalledTimes(readsBeforeCamera);
    expect(h.readiness).toEqual(readinessBeforeCamera);
    expect(h.policyControlsReadiness).toEqual(controlsBeforeCamera);
    expect(h.loader.diagnostics()).toMatchObject({
      cameraNotificationCount: 12,
      coalescedCameraNotificationCount: 12,
      pendingAdmissionCellCount: 0,
    });

    h.runPostPresentWork();
    await vi.waitFor(() =>
      expect(h.readCells.mock.calls.length).toBeGreaterThan(readsBeforeCamera)
    );
    await vi.waitFor(() =>
      expect(h.loader.diagnostics().pendingAdmissionCellCount).toBeGreaterThan(0)
    );
    h.runPostPresentWork();
    await vi.waitFor(() =>
      expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).toHaveBeenCalledWith(
        expect.objectContaining({ cellId: h.currentDemand.value!.requiredCellAddresses[0]!.cellId })
      )
    );
    expect(h.readiness.filter((value) => value === 'loading')).toEqual(
      readinessBeforeCamera.filter((value) => value === 'loading')
    );
    expect(h.policyControlsReadiness).toEqual(controlsBeforeCamera);
    expect(h.renderer.reconcileCompiledBroadSurfaceResidentLeases).not.toHaveBeenCalled();
  });

  it('does not perform alternate-control uploads after a ready camera transaction', async () => {
    const h = harness({ manualPostPresent: true, manualIdleWarm: true });
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    h.currentDemand.value = demand(surface, 'expanded', 0);
    h.alternateDemand.value = demand(surface, 'canonical', 0);
    await h.loader.reconcile(target());

    h.readCells.mockClear();
    vi.mocked(h.renderer.getCompiledBroadSurfaceDemand).mockClear();
    vi.mocked(h.renderer.reconcileCompiledBroadSurfaceResidentLeases).mockClear();
    const controlsBeforeCamera = [...h.policyControlsReadiness];
    h.currentDemand.value = demand(surface, 'expanded', 1, 3);
    h.alternateDemand.value = demand(surface, 'canonical', 1, 40);

    for (let epoch = 0; epoch < 12; epoch += 1) h.loader.signalCameraChanged();
    h.runPostPresentWork();
    await vi.waitFor(() =>
      expect(h.loader.diagnostics()).toMatchObject({ pendingAdmissionCellCount: 1 })
    );
    h.runPostPresentWork();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(h.readCells.mock.calls[0]![0].addresses).toEqual([
      expect.objectContaining({ isoformMode: 'expanded' }),
    ]);
    expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).toHaveBeenCalledWith(
      expect.objectContaining({
        cellId: h.currentDemand.value!.requiredCellAddresses[0]!.cellId,
      })
    );
    expect(
      h.readCells.mock.calls.some(([request]) =>
        request.addresses.some((cell) => cell.isoformMode === 'canonical')
      )
    ).toBe(false);
    expect(h.loader.diagnostics()).toMatchObject({
      readiness: 'ready',
      pendingAdmissionCellCount: 0,
      pendingAdmissionTier: null,
    });
    expect(h.policyControlsReadiness).toEqual(controlsBeforeCamera);
    expect(h.renderer.reconcileCompiledBroadSurfaceResidentLeases).not.toHaveBeenCalled();
  });

  it('does not rebuild demand when the presented immutable topology still covers the camera', async () => {
    const h = harness({ manualPostPresent: true, manualIdleWarm: true });
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    h.currentDemand.value = demand(surface, 'expanded', 0);
    h.alternateDemand.value = demand(surface, 'canonical', 0);
    h.renderer.isCompiledBroadSurfaceDemandRefreshRequired = vi.fn(() => false);
    await h.loader.reconcile(target());
    const demandReadsBeforeCamera = vi.mocked(h.renderer.getCompiledBroadSurfaceDemand).mock.calls
      .length;

    h.loader.signalCameraChanged();
    h.runPostPresentWork();
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(h.renderer.isCompiledBroadSurfaceDemandRefreshRequired).toHaveBeenCalledWith(
      target().policy,
      surface.manifestFingerprint
    );
    expect(h.renderer.getCompiledBroadSurfaceDemand).toHaveBeenCalledTimes(demandReadsBeforeCamera);
    expect(h.loader.diagnostics()).toMatchObject({
      cameraNotificationCount: 1,
      uniformOnlyCameraNotificationCount: 1,
      pendingAdmissionCellCount: 0,
    });
  });

  it('publishes no telemetry events during 1000 no-work camera/post-present frames', async () => {
    const h = harness({ manualPostPresent: true });
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    h.currentDemand.value = demand(surface, 'expanded', 0);
    h.alternateDemand.value = demand(surface, 'canonical', 0);
    await h.loader.reconcile(target());
    h.recordEvent.mockClear();

    for (let frame = 0; frame < 1_000; frame += 1) {
      h.loader.signalCameraChanged();
      h.runPostPresentWork();
    }
    await h.loader.refreshDemand();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(h.loader.diagnostics()).toMatchObject({
      cameraNotificationCount: 1_000,
      postPresentSliceCount: 1_000,
      pendingAdmissionCellCount: 0,
    });
    expect(h.recordEvent).not.toHaveBeenCalled();
  });

  it('uses measured deadline headroom to keep expensive admissions to one cell per turn', async () => {
    let clockMs = 0;
    const h = harness({ manualPostPresent: true, now: () => clockMs });
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    h.currentDemand.value = demand(surface, 'expanded', 3);
    h.alternateDemand.value = demand(surface, 'canonical', 0);
    const rgbaAdmission = vi.mocked(h.renderer.admitCompiledBroadSurfaceRgbaCell);
    const originalAdmission = rgbaAdmission.getMockImplementation()!;
    rgbaAdmission.mockImplementation((cell) => {
      const result = originalAdmission(cell);
      clockMs += 6;
      return {
        ...result,
        explicitCopyByteLength: 0,
        uploadedByteLength: cell.premultipliedRgba.byteLength,
      };
    });

    await h.loader.reconcile(target());
    expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).not.toHaveBeenCalled();

    const rendersBeforeFirstSlice = h.requestRender.mock.calls.length;
    h.runPostPresentWork(10);
    expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).toHaveBeenCalledTimes(1);
    expect(h.requestRender.mock.calls.length).toBeGreaterThan(rendersBeforeFirstSlice);
    await vi.waitFor(() => expect(h.readCells).toHaveBeenCalledTimes(3));
    expect(h.loader.diagnostics()).toMatchObject({
      pendingAdmissionCellCount: 2,
      lastPostPresentSliceAdmissionCount: 1,
      lastPostPresentSliceExplicitCopyByteLength: 0,
      maxPostPresentSliceAdmissionCount: 1,
      totalAdmittedCellCount: 1,
      cellTransportResponseCount: 3,
      maxCellTransportResponseCellCount: 1,
    });

    h.runPostPresentWork(16);
    expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).toHaveBeenCalledTimes(2);
    await vi.waitFor(() =>
      expect(h.loader.diagnostics()).toMatchObject({ pendingAdmissionCellCount: 1 })
    );
    h.runPostPresentWork(22);
    expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).toHaveBeenCalledTimes(3);
    expect(
      h.recordEvent.mock.calls.filter(([event]) => event === 'compiled-broad-raster-cells-admitted')
    ).toEqual([
      [
        'compiled-broad-raster-cells-admitted',
        expect.objectContaining({ admittedCount: 3, count: 3, supersededCount: 0 }),
      ],
    ]);
    expect(h.loader.diagnostics()).toMatchObject({
      pendingAdmissionCellCount: 0,
      totalAdmittedCellCount: 3,
      totalExplicitCopyByteLength: 0,
      maxPostPresentSliceDurationMs: 6,
      maxPostPresentSliceAdmissionCount: 1,
      maxCellTransportResponseCellCount: 1,
      maxCellTransportResponseByteLength:
        h.manifest.value!.catalogReceipt.storedCellWidthPx *
        h.manifest.value!.catalogReceipt.storedCellHeightPx *
        h.manifest.value!.catalogReceipt.bytesPerPixel,
      totalUploadedByteLength:
        3 *
        h.manifest.value!.catalogReceipt.storedCellWidthPx *
        h.manifest.value!.catalogReceipt.storedCellHeightPx *
        h.manifest.value!.catalogReceipt.bytesPerPixel,
    });
  });

  it('does not discard a durable admission batch while the React renderer ref is transiently null', async () => {
    const h = harness({ manualPostPresent: true, now: () => 0 });
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    h.currentDemand.value = demand(surface, 'expanded', 4);
    h.alternateDemand.value = demand(surface, 'canonical', 0);

    await h.loader.reconcile(target());
    await vi.waitFor(() =>
      expect(h.loader.diagnostics()).toMatchObject({ pendingAdmissionCellCount: 4 })
    );

    h.runPostPresentWork();
    await vi.waitFor(() =>
      expect(h.loader.diagnostics()).toMatchObject({ pendingAdmissionCellCount: 2 })
    );

    h.getRenderer.mockReturnValueOnce(null);
    h.runPostPresentWork();

    await vi.waitFor(() => expect(h.readiness.at(-1)).toBe('ready'));
    expect(h.loader.diagnostics()).toMatchObject({
      pendingAdmissionCellCount: 0,
      stagedCellDropCount: 0,
      totalAdmittedCellCount: 4,
    });
    expect(h.recordEvent).not.toHaveBeenCalledWith(
      'compiled-broad-raster-staged-cells-dropped',
      expect.anything()
    );
  });

  it('reschedules a bounded batch through its exact renderer lifecycle while the React handle projection is null', async () => {
    const h = harness({
      manualPostPresent: true,
      now: () => 0,
      bindPresentationLifecycle: true,
      dropProjectedSchedulingWithoutRenderer: true,
    });
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    h.currentDemand.value = demand(surface, 'expanded', 4);
    h.alternateDemand.value = demand(surface, 'canonical', 0);

    await h.loader.reconcile(target());
    await vi.waitFor(() =>
      expect(h.loader.diagnostics()).toMatchObject({ pendingAdmissionCellCount: 4 })
    );

    h.getRenderer.mockReturnValue(null);
    h.runPostPresentWork();
    await vi.waitFor(() =>
      expect(h.loader.diagnostics()).toMatchObject({ pendingAdmissionCellCount: 2 })
    );
    h.runPostPresentWork();

    await vi.waitFor(() => expect(h.readiness.at(-1)).toBe('ready'));
    expect(h.loader.diagnostics()).toMatchObject({
      pendingAdmissionCellCount: 0,
      totalAdmittedCellCount: 4,
      stagedCellDropCount: 0,
    });
  });

  it('caps admission work at the 120 Hz-safe slice even when the render loop offers 60 Hz', async () => {
    let clockMs = 0;
    const h = harness({ manualPostPresent: true, now: () => clockMs });
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    h.currentDemand.value = demand(surface, 'expanded', 2);
    h.alternateDemand.value = demand(surface, 'canonical', 0);
    const rgbaAdmission = vi.mocked(h.renderer.admitCompiledBroadSurfaceRgbaCell);
    const originalAdmission = rgbaAdmission.getMockImplementation()!;
    rgbaAdmission.mockImplementation((cell) => {
      const result = originalAdmission(cell);
      clockMs += 1.25;
      return result;
    });

    await h.loader.reconcile(target());
    h.runPostPresentWork(16.7);

    expect(rgbaAdmission).toHaveBeenCalledTimes(1);
    expect(h.loader.diagnostics()).toMatchObject({
      pendingAdmissionCellCount: 1,
      maxPostPresentSliceDurationMs: 1.25,
      maxPostPresentSliceAdmissionCount: 1,
    });
  });

  it('converges through four tile loads while 12 camera epochs continue without a quiescent gap', async () => {
    const h = harness({ manualPostPresent: true });
    h.manifest.value = await manifestResult();
    const surface = h.manifest.value.surfaceManifest;
    let cameraEpoch = 1;
    let currentTileX = 0;
    vi.mocked(h.renderer.getCompiledBroadSurfaceDemand).mockImplementation((policy) => {
      const resolvedPolicy = policy ?? { isoformMode: 'expanded' as const, laneLimit: 12 };
      const base =
        resolvedPolicy.isoformMode === 'expanded'
          ? demandForSlabs(surface, 'expanded', [0], currentTileX)
          : demand(surface, 'canonical', 0);
      const requiredCellAddresses = base.requiredCellAddresses;
      const missingRequiredCellAddresses = requiredCellAddresses.filter(
        ({ cellId }) => !h.resident.has(cellId)
      );
      return {
        ...base,
        cameraEpoch,
        demandLeaseId: `fixture-lease:${cameraEpoch}:${resolvedPolicy.isoformMode}:${resolvedPolicy.laneLimit}`,
        laneLimit: resolvedPolicy.laneLimit,
        requiredCellAddresses,
        missingRequiredCellAddresses,
        missingCellAddresses: missingRequiredCellAddresses,
      };
    });
    vi.mocked(h.renderer.reconcileCompiledBroadSurfaceResidentLeases).mockImplementation(() => ({
      status: 'reconciled',
      cameraEpoch,
      retainedCellCount: h.resident.size,
      evictedCellIds: [],
    }));
    const pendingReads: Array<{
      request: AssemblyCompiledBroadRasterCellsRequestV1;
      resolve: (result: AssemblyCompiledBroadRasterCellsResultV1) => void;
    }> = [];
    h.readCells.mockImplementation(
      (request) =>
        new Promise((resolve) => {
          pendingReads.push({ request, resolve });
        })
    );

    const initial = h.loader.reconcile(target());
    await vi.waitFor(() => expect(pendingReads).toHaveLength(1));

    for (let tileIndex = 0; tileIndex < 4; tileIndex += 1) {
      currentTileX = tileIndex;
      const firstEpoch = tileIndex * 3 + 1;
      if (tileIndex > 0) {
        cameraEpoch = firstEpoch;
        h.loader.signalCameraChanged();
        h.runPostPresentWork();
        await vi.waitFor(() => expect(pendingReads).toHaveLength(1));
      }
      for (let epoch = firstEpoch + 1; epoch <= firstEpoch + 2; epoch += 1) {
        cameraEpoch = epoch;
        h.loader.signalCameraChanged();
      }
      const pending = pendingReads.shift()!;
      pending.resolve(h.cellResponse(pending.request));
      await vi.waitFor(() =>
        expect(h.loader.diagnostics().pendingAdmissionCellCount).toBeGreaterThan(0)
      );
      h.runPostPresentWork();
      const expectedCellId = demandForSlabs(surface, 'expanded', [0], tileIndex)
        .requiredCellAddresses[0]!.cellId;
      await vi.waitFor(() => expect(h.resident.has(expectedCellId)).toBe(true));
    }
    await initial;

    expect(cameraEpoch).toBe(12);
    expect(h.readCells).toHaveBeenCalledTimes(4);
    expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).toHaveBeenCalledTimes(4);
    expect(h.recordEvent).not.toHaveBeenCalledWith(
      'compiled-broad-raster-stale-response-dropped',
      expect.objectContaining({ phase: 'demand-cells' })
    );
    await vi.waitFor(() => expect(h.readiness.at(-1)).toBe('ready'));
  });

  it('retains the last-good owner while a corrupt cell artifact rebuilds and becomes ready', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const readyManifest = await manifestResult();
      h.manifest.value = readyManifest;
      h.currentDemand.value = demand(readyManifest.surfaceManifest, 'expanded', 1);
      h.alternateDemand.value = demand(readyManifest.surfaceManifest, 'canonical', 0);
      let cellReadCount = 0;
      h.readCells.mockImplementation(async (request) => {
        cellReadCount += 1;
        if (cellReadCount === 1) {
          return {
            contract: ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
            status: 'repairing',
            reason: 'artifact-corrupt',
            catalogCapability: request.catalogCapability,
            retryAfterMs: 100,
          };
        }
        return h.cellResponse(request);
      });

      await h.loader.reconcile(target());
      expect(h.readiness.at(-1)).toBe('repairing');
      expect(h.renderer.clearCompiledBroadSurfaceManifest).not.toHaveBeenCalled();
      expect(h.renderer.clearCompiledBroadSurfaceRequirement).not.toHaveBeenCalled();
      expect(h.recordEvent).toHaveBeenCalledWith(
        'compiled-broad-raster-repairing',
        expect.objectContaining({ reason: 'artifact-corrupt' })
      );

      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(0);

      await vi.waitFor(() => expect(h.readManifest).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(h.readCells).toHaveBeenCalledTimes(2));
      expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).toHaveBeenCalledTimes(1);
      expect(h.renderer.loadCompiledBroadSurfaceManifest).toHaveBeenCalledTimes(1);
      expect(h.readiness.at(-1)).toBe('ready');
      expect(h.policyControlsReadiness.at(-1)).toBe('ready');
      expect(h.readiness).not.toContain('error');
      expect(h.recordEvent).not.toHaveBeenCalledWith(
        'compiled-broad-raster-rejected',
        expect.objectContaining({ reason: expect.stringContaining('repair') })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('terminates a malformed repair manifest without retrying or clearing the last-good owner', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const readyManifest = await manifestResult();
      h.manifest.value = readyManifest;
      h.currentDemand.value = demand(readyManifest.surfaceManifest, 'expanded', 1);
      h.alternateDemand.value = demand(readyManifest.surfaceManifest, 'canonical', 0);
      h.readCells.mockImplementation(async (request) => ({
        contract: ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
        status: 'repairing',
        reason: 'artifact-corrupt',
        catalogCapability: request.catalogCapability,
        retryAfterMs: 100,
      }));
      let manifestReadCount = 0;
      h.readManifest.mockImplementation(async () => {
        manifestReadCount += 1;
        const ipcClone = structuredClone(readyManifest);
        if (manifestReadCount === 1) return ipcClone;
        (
          ipcClone.surfaceManifest as unknown as {
            levels: typeof ipcClone.surfaceManifest.levels;
          }
        ).levels = [...ipcClone.surfaceManifest.levels].reverse();
        return ipcClone;
      });

      await h.loader.reconcile(target());
      expect(h.readiness.at(-1)).toBe('repairing');
      expect(h.readCells).toHaveBeenCalledTimes(1);
      expect(h.renderer.loadCompiledBroadSurfaceManifest).toHaveBeenCalledTimes(1);

      await vi.runOnlyPendingTimersAsync();
      await vi.waitFor(() => expect(h.readiness.at(-1)).toBe('unavailable'));

      expect(h.readManifest).toHaveBeenCalledTimes(2);
      expect(h.readCells).toHaveBeenCalledTimes(1);
      expect(h.renderer.clearCompiledBroadSurfaceManifest).not.toHaveBeenCalled();
      expect(h.renderer.clearCompiledBroadSurfaceRequirement).not.toHaveBeenCalled();
      expect(h.recordEvent).toHaveBeenCalledWith('compiled-broad-raster-repair-unavailable', {
        reason: 'repair-surface-manifest-admission-failed',
      });
      expect(h.recordEvent).toHaveBeenCalledWith(
        'compiled-broad-raster-repair-manifest-rejected',
        expect.objectContaining({ message: expect.stringContaining('pyramid') })
      );

      await vi.advanceTimersByTimeAsync(30_000);
      expect(h.readManifest).toHaveBeenCalledTimes(2);
      expect(h.readCells).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps catalog reprobes sticky across deterministic repair manifest miss and transport error', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const readyManifest = await manifestResult();
      h.manifest.value = readyManifest;
      h.currentDemand.value = demand(readyManifest.surfaceManifest, 'expanded', 1);
      h.alternateDemand.value = demand(readyManifest.surfaceManifest, 'canonical', 0);
      let cellReadCount = 0;
      h.readCells.mockImplementation(async (request) => {
        cellReadCount += 1;
        if (cellReadCount === 1) {
          return {
            contract: ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
            status: 'repairing',
            reason: 'artifact-corrupt',
            catalogCapability: request.catalogCapability,
            retryAfterMs: 100,
          };
        }
        return h.cellResponse(request);
      });
      let manifestReadCount = 0;
      h.readManifest.mockImplementation(async () => {
        manifestReadCount += 1;
        if (manifestReadCount === 1) return readyManifest;
        if (manifestReadCount === 2) return null;
        if (manifestReadCount === 3) throw new Error('deterministic manifest IPC outage');
        return {
          ...readyManifest,
          catalogCapability: {
            ...readyManifest.catalogCapability,
            openingId: 'fixture-catalog-opening:repaired',
          },
        };
      });

      await h.loader.reconcile(target());
      expect(h.readiness.at(-1)).toBe('repairing');
      expect(h.recordEvent).toHaveBeenCalledWith(
        'compiled-broad-raster-repairing',
        expect.objectContaining({ reason: 'artifact-corrupt' })
      );

      await vi.advanceTimersByTimeAsync(100);
      expect(h.readManifest).toHaveBeenCalledTimes(2);
      expect(h.readCells).toHaveBeenCalledTimes(1);
      expect(h.recordEvent).toHaveBeenCalledWith('compiled-broad-raster-repair-reprobe-deferred', {
        reason: 'manifest-miss',
      });

      await vi.advanceTimersByTimeAsync(500);
      expect(h.readManifest).toHaveBeenCalledTimes(3);
      expect(h.readCells).toHaveBeenCalledTimes(1);
      expect(h.recordEvent).toHaveBeenCalledWith(
        'compiled-broad-raster-repair-reprobe-deferred',
        expect.objectContaining({ reason: 'manifest-transport-failed' })
      );

      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(0);

      expect(h.readManifest).toHaveBeenCalledTimes(4);
      await vi.waitFor(() => expect(h.readCells).toHaveBeenCalledTimes(2));
      expect(h.readCells.mock.calls[1]![0].catalogCapability.openingId).toBe(
        'fixture-catalog-opening:repaired'
      );
      expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).toHaveBeenCalledTimes(1);
      expect(h.readiness.at(-1)).toBe('ready');
      expect(h.readiness).not.toContain('error');
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels an obsolete repair reprobe when a newer target generation wins', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.manifest.value = await manifestResult();
      const surface = h.manifest.value.surfaceManifest;
      h.currentDemand.value = demand(surface, 'expanded', 1);
      h.alternateDemand.value = demand(surface, 'canonical', 0);
      h.readCells
        .mockImplementationOnce(async (request) => ({
          contract: ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
          status: 'repairing',
          reason: 'artifact-missing',
          catalogCapability: request.catalogCapability,
          retryAfterMs: 500,
        }))
        .mockImplementation(async (request) => h.cellResponse(request));

      await h.loader.reconcile(target('old-generation'));
      expect(h.readiness.at(-1)).toBe('repairing');
      await h.loader.reconcile(target('new-generation'));
      const manifestReadsAfterNewTarget = h.readManifest.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5_000);

      expect(h.readManifest).toHaveBeenCalledTimes(manifestReadsAfterNewTarget);
      expect(h.readiness.at(-1)).toBe('ready');
      expect(h.readiness).not.toContain('error');
    } finally {
      vi.useRealTimers();
    }
  });

  it('continues bounded repair polling through forty sustained cycles and converges', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.manifest.value = await manifestResult();
      const surface = h.manifest.value.surfaceManifest;
      h.currentDemand.value = demand(surface, 'expanded', 1);
      h.alternateDemand.value = demand(surface, 'canonical', 0);
      let workerFinished = false;
      h.readCells.mockImplementation(async (request) =>
        workerFinished
          ? h.cellResponse(request)
          : {
              contract: ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
              status: 'repairing',
              reason: 'artifact-corrupt',
              catalogCapability: request.catalogCapability,
              retryAfterMs: 30_000,
            }
      );

      await h.loader.reconcile(target());
      for (let cycle = 1; cycle <= 40; cycle += 1) {
        const readsBeforeCycle = h.readCells.mock.calls.length;
        await vi.runOnlyPendingTimersAsync();
        await vi.waitFor(() =>
          expect(h.readCells.mock.calls.length).toBeGreaterThan(readsBeforeCycle)
        );
        expect(h.readiness.at(-1)).toBe('repairing');
        expect(h.policyControlsReadiness.at(-1)).toBe('repairing');
      }

      expect(h.readiness.at(-1)).toBe('repairing');
      expect(h.policyControlsReadiness.at(-1)).toBe('repairing');
      expect(
        h.recordEvent.mock.calls.filter(([event]) => event === 'compiled-broad-raster-repairing')
          .length
      ).toBeGreaterThanOrEqual(40);
      expect(h.recordEvent).toHaveBeenCalledWith(
        'compiled-broad-raster-repairing',
        expect.objectContaining({ reason: 'artifact-corrupt' })
      );
      expect(h.renderer.clearCompiledBroadSurfaceManifest).not.toHaveBeenCalled();
      expect(h.renderer.clearCompiledBroadSurfaceRequirement).not.toHaveBeenCalled();
      expect(h.recordEvent).not.toHaveBeenCalledWith(
        'compiled-broad-raster-repair-unavailable',
        expect.anything()
      );

      workerFinished = true;
      await vi.runOnlyPendingTimersAsync();
      await vi.waitFor(() => expect(h.readiness.at(-1)).toBe('ready'));

      expect(h.renderer.admitCompiledBroadSurfaceRgbaCell).toHaveBeenCalled();
      expect(h.readiness.at(-1)).toBe('ready');
      expect(h.policyControlsReadiness.at(-1)).toBe('ready');
      expect(h.readiness).not.toContain('error');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops repair polling only when the main process returns a terminal repair state', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.manifest.value = await manifestResult();
      const surface = h.manifest.value.surfaceManifest;
      h.currentDemand.value = demand(surface, 'expanded', 1);
      h.alternateDemand.value = demand(surface, 'canonical', 0);
      let responseCount = 0;
      h.readCells.mockImplementation(async (request) => {
        responseCount += 1;
        if (responseCount === 1) {
          return {
            contract: ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
            status: 'repairing',
            reason: 'artifact-corrupt',
            catalogCapability: request.catalogCapability,
            retryAfterMs: 100,
          };
        }
        return {
          contract: ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
          status: 'unavailable',
          reason: 'repair-exhausted',
        };
      });

      await h.loader.reconcile(target());
      expect(h.readiness.at(-1)).toBe('repairing');

      await vi.advanceTimersByTimeAsync(100);
      await vi.waitFor(() => expect(h.readCells).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(h.readiness.at(-1)).toBe('unavailable'));
      expect(h.policyControlsReadiness.at(-1)).toBe('unavailable');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(h.readCells).toHaveBeenCalledTimes(2);
      expect(h.recordEvent).toHaveBeenCalledWith('compiled-broad-raster-repair-unavailable', {
        reason: 'repair-exhausted',
      });
      expect(h.renderer.clearCompiledBroadSurfaceManifest).not.toHaveBeenCalled();
      expect(h.renderer.clearCompiledBroadSurfaceRequirement).not.toHaveBeenCalled();
      expect(h.readiness).not.toContain('error');
    } finally {
      vi.useRealTimers();
    }
  });
});
