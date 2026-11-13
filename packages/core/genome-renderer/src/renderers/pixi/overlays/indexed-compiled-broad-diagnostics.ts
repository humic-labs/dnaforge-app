import type {
  CompiledBroadSurfaceAdmissionProvenanceV1,
  CompiledBroadSurfaceManifestV2,
} from '../overview/bounded-annotation-broad-surface';

export type CompiledBroadDiagnosticsPresenter = {
  isPresenting: boolean;
  diagnostics(): object;
  getReadinessDiagnostics(): object;
};

export type CompiledBroadDiagnosticsHost = {
  compiledBroadSurfacePresenter: CompiledBroadDiagnosticsPresenter | null;
  presentationVisible: boolean;
  genomeWideTextureCacheLayer: { prebuiltTexturePresenting?: boolean } | null;
  compiledBroadSurfaceManifest: CompiledBroadSurfaceManifestV2 | null;
  compiledBroadSurfaceProvenance: CompiledBroadSurfaceAdmissionProvenanceV1 | null;
  compiledBroadSurfaceProvenanceIsCurrent(
    manifest: CompiledBroadSurfaceManifestV2 | null,
    provenance: CompiledBroadSurfaceAdmissionProvenanceV1 | null
  ): boolean;
  compiledBroadSurfaceRgbaAdmissions: number;
  compiledBroadSurfaceGpuPreuploads: number;
  compiledBroadSurfaceExplicitRgbaCopyBytes: number;
  compiledBroadSurfaceGpuPreuploadedBytes: number;
  compiledBroadSurfacePostPresentGpuUploads: number;
  compiledBroadSurfacePostPresentGpuUploadBytes: number;
  compiledBroadSurfaceGpuPreuploadFailures: number;
  compiledBroadSurfacePlanDerivationCount: number;
  compiledBroadSurfaceCameraContractCreateCount: number;
  compiledBroadSurfaceFastCameraMailboxCreateCount: number;
};

function compiledBroadProvenanceFields(host: CompiledBroadDiagnosticsHost) {
  return {
    provenanceValid: host.compiledBroadSurfaceProvenanceIsCurrent(
      host.compiledBroadSurfaceManifest,
      host.compiledBroadSurfaceProvenance
    ),
    provenanceManifestFingerprint: host.compiledBroadSurfaceProvenance?.manifestFingerprint ?? null,
    provenanceSourceFingerprint: host.compiledBroadSurfaceProvenance?.sourceFingerprint ?? null,
    provenancePlacementFingerprint:
      host.compiledBroadSurfaceProvenance?.placementFingerprint ?? null,
    provenancePrepackedOwnerKey: host.compiledBroadSurfaceProvenance?.prepackedOwnerKey ?? null,
    provenancePrepackedArtifactKey:
      host.compiledBroadSurfaceProvenance?.prepackedArtifactKey ?? null,
  };
}

export function getCompiledBroadSurfaceDiagnostics(
  host: CompiledBroadDiagnosticsHost
): Readonly<Record<string, unknown>> | null {
  const presenter = host.compiledBroadSurfacePresenter;
  if (!presenter) return null;
  const legacyRasterVisible =
    host.presentationVisible &&
    (host.genomeWideTextureCacheLayer?.prebuiltTexturePresenting ?? false);
  const compiledRasterVisible = host.presentationVisible && presenter.isPresenting;
  return Object.freeze({
    ...presenter.diagnostics(),
    ...compiledBroadProvenanceFields(host),
    legacyRasterVisible,
    compiledRasterVisible,
    rasterOwnerCount: Number(legacyRasterVisible) + Number(compiledRasterVisible),
    rgbaAdmissionCount: host.compiledBroadSurfaceRgbaAdmissions,
    gpuPreuploadCount: host.compiledBroadSurfaceGpuPreuploads,
    explicitRgbaCopyBytes: host.compiledBroadSurfaceExplicitRgbaCopyBytes,
    gpuPreuploadedBytes: host.compiledBroadSurfaceGpuPreuploadedBytes,
    postPresentGpuUploadCount: host.compiledBroadSurfacePostPresentGpuUploads,
    postPresentGpuUploadBytes: host.compiledBroadSurfacePostPresentGpuUploadBytes,
    gpuPreuploadFailureCount: host.compiledBroadSurfaceGpuPreuploadFailures,
    planDerivationCount: host.compiledBroadSurfacePlanDerivationCount,
    cameraContractCreateCount: host.compiledBroadSurfaceCameraContractCreateCount,
    fastCameraMailboxCreateCount: host.compiledBroadSurfaceFastCameraMailboxCreateCount,
  });
}

export function getCompiledBroadSurfaceReadinessDiagnostics(
  host: CompiledBroadDiagnosticsHost
): Readonly<Record<string, unknown>> | null {
  const presenter = host.compiledBroadSurfacePresenter;
  if (!presenter) return null;
  const legacyRasterVisible =
    host.presentationVisible &&
    (host.genomeWideTextureCacheLayer?.prebuiltTexturePresenting ?? false);
  const compiledRasterVisible = host.presentationVisible && presenter.isPresenting;
  return Object.freeze({
    ...presenter.getReadinessDiagnostics(),
    ...compiledBroadProvenanceFields(host),
    legacyRasterVisible,
    compiledRasterVisible,
    rasterOwnerCount: Number(legacyRasterVisible) + Number(compiledRasterVisible),
    gpuPreuploadFailureCount: host.compiledBroadSurfaceGpuPreuploadFailures,
  });
}
