import type { CompiledBroadSurfaceManifestV2 } from '@waypoint/genome-renderer/pure';

import type { CompiledBroadRasterArtifactManifestV1 } from './compiled-broad-raster-artifact-reader';
import { compiledBroadRasterCanonicalJsonV1 } from './compiled-broad-raster-artifact-reader';
import {
  ASSEMBLY_COMPILED_BROAD_RASTER_CATALOG_RECEIPT_V1,
  assemblyAnnotationSceneGenomeIdentityV1,
  assemblyAnnotationSceneInteractionOwnerKeyV3,
  type AssemblyAnnotationSceneArtifactContract,
  type AssemblyCompiledBroadRasterCatalogReceiptV1,
  type AssemblyCompiledBroadRasterManifestRequestV1,
} from './indexed-genome';
import { sha256Hex } from './sha256-sync';

export interface AssemblyCompiledBroadRasterCatalogReceiptInputV1 {
  readonly request: AssemblyCompiledBroadRasterManifestRequestV1;
  readonly sceneIndex: Readonly<{
    fingerprint: string;
    placementFingerprint: string;
    payloadSha256: string;
    sourceBuildFingerprint: string;
    artifact: AssemblyAnnotationSceneArtifactContract;
    manifest: Readonly<{ integrity: Readonly<{ contractSha256: string }> }>;
  }>;
  readonly surfaceManifest: CompiledBroadSurfaceManifestV2;
  readonly reader: Readonly<{ manifest: CompiledBroadRasterArtifactManifestV1 }>;
}

export function buildAssemblyCompiledBroadRasterCatalogReceiptV1(
  opening: AssemblyCompiledBroadRasterCatalogReceiptInputV1
): AssemblyCompiledBroadRasterCatalogReceiptV1 | null {
  const { sceneIndex, surfaceManifest, reader, request } = opening;
  const genomeIdentity = assemblyAnnotationSceneGenomeIdentityV1(request.scene);
  const expectedInteractionOwnerKey = assemblyAnnotationSceneInteractionOwnerKeyV3({
    sourceFingerprint: sceneIndex.fingerprint,
    scenePayloadSha256: sceneIndex.payloadSha256,
    sceneArtifactKey: sceneIndex.artifact.artifactKey,
  });
  if (!genomeIdentity || !expectedInteractionOwnerKey) return null;
  const fields = {
    contract: ASSEMBLY_COMPILED_BROAD_RASTER_CATALOG_RECEIPT_V1,
    genomeIdentity,
    genomeLengthBp: surfaceManifest.genomeLengthBp,
    sourceFingerprint: sceneIndex.fingerprint,
    placementFingerprint: sceneIndex.placementFingerprint,
    scenePayloadSha256: sceneIndex.payloadSha256,
    sceneContractSha256: sceneIndex.manifest.integrity.contractSha256,
    sceneSourceBuildFingerprint: sceneIndex.sourceBuildFingerprint,
    surfaceManifestFingerprint: surfaceManifest.manifestFingerprint,
    catalogFingerprint: reader.manifest.catalogFingerprint,
    sceneArtifactKey: sceneIndex.artifact.artifactKey,
    surfaceArtifactKey: surfaceManifest.artifactKey,
    themeMode: sceneIndex.artifact.themeMode,
    trackId: surfaceManifest.trackId,
    expectedInteractionOwnerKey,
    pixelFormat: reader.manifest.pixelFormat,
    ...(reader.manifest.roleTable ? { roleTable: [...reader.manifest.roleTable] } : {}),
    bytesPerPixel: reader.manifest.bytesPerPixel,
    storedCellWidthPx: reader.manifest.storedWidthPx,
    storedCellHeightPx: reader.manifest.storedHeightPx,
    cellCount: reader.manifest.cells.length,
    rasterDevicePixelRatio: surfaceManifest.rasterDevicePixelRatio,
    tileContentWidthPx: surfaceManifest.broadTilePhysicalWidthPx,
    tileGuardWidthPx: surfaceManifest.broadTileXGuardPhysicalPx,
    laneSlabRowCount: surfaceManifest.laneSlabRowCount,
    laneRowTextureStridePx: surfaceManifest.laneRowTextureStridePx,
  } as const;
  if (
    fields.bytesPerPixel !== 4 ||
    !Number.isSafeInteger(fields.cellCount) ||
    fields.cellCount < 1 ||
    !Number.isSafeInteger(fields.storedCellWidthPx) ||
    fields.storedCellWidthPx < 1 ||
    !Number.isSafeInteger(fields.storedCellHeightPx) ||
    fields.storedCellHeightPx < 1
  ) {
    return null;
  }
  const receiptSha256 = sha256Hex(compiledBroadRasterCanonicalJsonV1(fields));
  return Object.freeze({ ...fields, receiptSha256 });
}
