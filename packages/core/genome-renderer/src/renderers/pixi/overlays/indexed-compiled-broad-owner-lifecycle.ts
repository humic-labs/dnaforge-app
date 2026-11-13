import type { Container, Texture } from 'pixi.js';
import { compiledBroadSurfaceOwnedCellKey } from './annotation-compiled-broad-address';
import { inspectCompiledBroadDemandLeaseReconcileRequest } from './indexed-compiled-broad-lease-reconcile';
import type { CompiledBroadSurfaceDemandLeaseV1 } from './indexed-compiled-broad-demand';
import type { CompiledBroadSurfaceTrackOwnerV2 } from './indexed-compiled-broad-frame';
import type {
  CompiledBroadSurfaceAdmissionProvenanceV1,
  CompiledBroadSurfaceManifestV2,
} from '../overview/bounded-annotation-broad-surface';
import type { AnnotationPolicyGpuRuntimeV1 } from '../overview/annotation-policy-gpu-instances-v1';

export type CompiledBroadSurfaceResidentLeaseReconcileResultV1 = Readonly<
  | {
      status: 'reconciled';
      cameraEpoch: number;
      retainedCellCount: number;
      evictedCellIds: readonly string[];
    }
  | {
      status: 'rejected';
      cameraEpoch: number;
      retainedCellCount: 0;
      evictedCellIds: readonly [];
      reason: string;
    }
>;

export type CompiledBroadOwnerLifecyclePresenter = {
  container: Container;
  readonly residentCellCount: number;
  activeResidentCellIds(): readonly string[];
  evictCellsExcept(requestedCellIds: ReadonlySet<string>): readonly string[];
  destroy(): void;
};

export type CompiledBroadOwnerLifecycleOwner = {
  manifest: CompiledBroadSurfaceManifestV2;
  provenance: CompiledBroadSurfaceAdmissionProvenanceV1;
  presenter: CompiledBroadOwnerLifecyclePresenter;
};

export type CompiledBroadOwnerLifecycleHost = {
  container: Container;
  compiledBroadSurfaceReadyDetailDemands: Map<string, unknown>;
  compiledBroadSurfaceCandidateManifest: CompiledBroadSurfaceManifestV2 | null;
  compiledBroadSurfaceCandidateProvenance: CompiledBroadSurfaceAdmissionProvenanceV1 | null;
  compiledBroadSurfaceCandidatePresenter: CompiledBroadOwnerLifecyclePresenter | null;
  compiledBroadSurfaceManifest: CompiledBroadSurfaceManifestV2 | null;
  compiledBroadSurfaceProvenance: CompiledBroadSurfaceAdmissionProvenanceV1 | null;
  compiledBroadSurfacePresenter: CompiledBroadOwnerLifecyclePresenter | null;
  compiledBroadSurfaceTrackOwners: Map<string, CompiledBroadOwnerLifecycleOwner>;
  compiledBroadSurfaceTrackCandidateOwners: Map<string, CompiledBroadOwnerLifecycleOwner>;
  compiledBroadSurfaceDemandLeases: Map<string, CompiledBroadSurfaceDemandLeaseV1>;
  compiledBroadSurfacePlanStatus: string;
  compiledBroadSurfaceLastCompleteTrackIds: readonly string[];
  compiledBroadSurfaceOwnedLastFrame: boolean;
  compiledBroadSurfaceOwnedCellTextures: Map<string, Texture>;
  compiledBroadSurfaceGpuPreuploadedCellIds: Set<string>;
  compiledBroadSurfaceLastCameraRequest: unknown;
  compiledBroadSurfaceLastPresentationCamera: unknown;
  compiledBroadSurfaceCameraEpoch: number;
  prepackedAnnotationSceneResidents: { readonly size: number };
  prepackedAnnotationSceneLayer: unknown;
  prepackedAnnotationRuntimePolicy: AnnotationPolicyGpuRuntimeV1 | null;
  compiledBroadSurfaceProvenanceIsCurrent(
    manifest: CompiledBroadSurfaceManifestV2 | null,
    provenance: CompiledBroadSurfaceAdmissionProvenanceV1 | null
  ): boolean;
  compiledBroadSurfaceOwnerForTrack(trackId: string): unknown;
  reconcileAnnotationLaneEnvelopeAuthority(): void;
};

function compiledBroadOwnerPresenters(host: CompiledBroadOwnerLifecycleHost): Array<{
  manifest: CompiledBroadSurfaceManifestV2;
  presenter: CompiledBroadOwnerLifecyclePresenter;
}> {
  return [
    host.compiledBroadSurfaceManifest && host.compiledBroadSurfacePresenter
      ? {
          manifest: host.compiledBroadSurfaceManifest,
          presenter: host.compiledBroadSurfacePresenter,
        }
      : null,
    host.compiledBroadSurfaceCandidateManifest && host.compiledBroadSurfaceCandidatePresenter
      ? {
          manifest: host.compiledBroadSurfaceCandidateManifest,
          presenter: host.compiledBroadSurfaceCandidatePresenter,
        }
      : null,
    ...[...host.compiledBroadSurfaceTrackOwners.values()].map(({ manifest, presenter }) => ({
      manifest,
      presenter,
    })),
    ...[...host.compiledBroadSurfaceTrackCandidateOwners.values()].map(
      ({ manifest, presenter }) => ({ manifest, presenter })
    ),
  ].filter(
    (
      owner
    ): owner is {
      manifest: CompiledBroadSurfaceManifestV2;
      presenter: CompiledBroadOwnerLifecyclePresenter;
    } => owner !== null
  );
}

export function compiledBroadSurfaceAdmissionOwner(
  host: CompiledBroadOwnerLifecycleHost,
  manifestFingerprint: string | undefined
): CompiledBroadSurfaceTrackOwnerV2 | null {
  for (const owner of host.compiledBroadSurfaceTrackCandidateOwners.values()) {
    if (
      owner.manifest.manifestFingerprint === manifestFingerprint &&
      host.compiledBroadSurfaceProvenanceIsCurrent(owner.manifest, owner.provenance)
    ) {
      return owner as CompiledBroadSurfaceTrackOwnerV2;
    }
  }
  for (const owner of host.compiledBroadSurfaceTrackOwners.values()) {
    if (
      owner.manifest.manifestFingerprint === manifestFingerprint &&
      host.compiledBroadSurfaceProvenanceIsCurrent(owner.manifest, owner.provenance)
    ) {
      return owner as CompiledBroadSurfaceTrackOwnerV2;
    }
  }
  const candidateManifest = host.compiledBroadSurfaceCandidateManifest;
  const candidatePresenter = host.compiledBroadSurfaceCandidatePresenter;
  const candidateProvenance = host.compiledBroadSurfaceCandidateProvenance;
  if (
    candidateManifest !== null &&
    candidateManifest.manifestFingerprint === manifestFingerprint &&
    candidatePresenter &&
    candidateProvenance &&
    host.compiledBroadSurfaceProvenanceIsCurrent(candidateManifest, candidateProvenance)
  ) {
    return {
      manifest: candidateManifest,
      provenance: candidateProvenance,
      presenter: candidatePresenter,
    } as CompiledBroadSurfaceTrackOwnerV2;
  }
  const manifest = host.compiledBroadSurfaceManifest;
  const presenter = host.compiledBroadSurfacePresenter;
  const provenance = host.compiledBroadSurfaceProvenance;
  if (
    manifest !== null &&
    manifest.manifestFingerprint === manifestFingerprint &&
    presenter &&
    provenance &&
    host.compiledBroadSurfaceProvenanceIsCurrent(manifest, provenance)
  ) {
    return {
      manifest,
      provenance,
      presenter,
    } as CompiledBroadSurfaceTrackOwnerV2;
  }
  return null;
}

export function destroyCompiledBroadSurfaceOwnedTextures(
  host: CompiledBroadOwnerLifecycleHost,
  manifestFingerprint: string
): void {
  const prefix = `${manifestFingerprint}\u0000`;
  for (const [ownershipKey, texture] of host.compiledBroadSurfaceOwnedCellTextures) {
    if (!ownershipKey.startsWith(prefix)) continue;
    host.compiledBroadSurfaceOwnedCellTextures.delete(ownershipKey);
    host.compiledBroadSurfaceGpuPreuploadedCellIds.delete(ownershipKey);
    if (!texture.destroyed) texture.destroy(true);
  }
}

export function disposeCompiledBroadSurfaceCandidate(host: CompiledBroadOwnerLifecycleHost): void {
  const manifest = host.compiledBroadSurfaceCandidateManifest;
  const presenter = host.compiledBroadSurfaceCandidatePresenter;
  if (presenter?.container.parent === host.container) {
    host.container.removeChild(presenter.container as never);
  }
  presenter?.destroy();
  if (manifest) destroyCompiledBroadSurfaceOwnedTextures(host, manifest.manifestFingerprint);
  host.compiledBroadSurfaceCandidateManifest = null;
  host.compiledBroadSurfaceCandidateProvenance = null;
  host.compiledBroadSurfaceCandidatePresenter = null;
}

export function disposeCompiledBroadSurfaceTrackOwner(
  host: CompiledBroadOwnerLifecycleHost,
  owner: CompiledBroadOwnerLifecycleOwner
): void {
  if (owner.presenter.container.parent === host.container) {
    host.container.removeChild(owner.presenter.container as never);
  }
  owner.presenter.destroy();
  destroyCompiledBroadSurfaceOwnedTextures(host, owner.manifest.manifestFingerprint);
}

export function reconcileCompiledBroadSurfaceResidentLeases(
  host: CompiledBroadOwnerLifecycleHost,
  demandLeaseIds: readonly string[]
): CompiledBroadSurfaceResidentLeaseReconcileResultV1 {
  const reject = (reason: string): CompiledBroadSurfaceResidentLeaseReconcileResultV1 =>
    Object.freeze({
      status: 'rejected',
      cameraEpoch: host.compiledBroadSurfaceCameraEpoch,
      retainedCellCount: 0,
      evictedCellIds: Object.freeze([]) as readonly [],
      reason,
    });
  const owners = compiledBroadOwnerPresenters(host);
  const inspection = inspectCompiledBroadDemandLeaseReconcileRequest({
    demandLeaseIds,
    currentCameraEpoch: host.compiledBroadSurfaceCameraEpoch,
    leasesById: host.compiledBroadSurfaceDemandLeases,
    ownerFingerprints: new Set(owners.map(({ manifest }) => manifest.manifestFingerprint)),
  });
  if (!inspection.ok) return reject(inspection.reason);
  const { requestedLeaseIds, leases } = inspection;

  const evictedCellIds: string[] = [];
  let retainedCellCount = 0;
  for (const { manifest, presenter } of owners) {
    const ownerLeases = leases.filter(
      (lease) => lease.manifestFingerprint === manifest.manifestFingerprint
    );
    if (ownerLeases.length === 0) {
      retainedCellCount += presenter.residentCellCount;
      continue;
    }
    const retainedCellIds = new Set(presenter.activeResidentCellIds());
    for (const lease of ownerLeases) {
      for (const cellId of lease.allowedCellIds) retainedCellIds.add(cellId);
    }
    retainedCellCount += retainedCellIds.size;
    for (const evictedCellId of presenter.evictCellsExcept(retainedCellIds)) {
      evictedCellIds.push(evictedCellId);
      host.compiledBroadSurfaceReadyDetailDemands.delete(manifest.manifestFingerprint);
      const ownershipKey = compiledBroadSurfaceOwnedCellKey(
        manifest.manifestFingerprint,
        evictedCellId
      );
      const texture = host.compiledBroadSurfaceOwnedCellTextures.get(ownershipKey);
      host.compiledBroadSurfaceOwnedCellTextures.delete(ownershipKey);
      host.compiledBroadSurfaceGpuPreuploadedCellIds.delete(ownershipKey);
      if (texture && !texture.destroyed) texture.destroy(true);
    }
  }
  for (const leaseId of host.compiledBroadSurfaceDemandLeases.keys()) {
    if (!requestedLeaseIds.has(leaseId)) host.compiledBroadSurfaceDemandLeases.delete(leaseId);
  }
  return Object.freeze({
    status: 'reconciled',
    cameraEpoch: host.compiledBroadSurfaceCameraEpoch,
    retainedCellCount,
    evictedCellIds: Object.freeze(evictedCellIds),
  });
}

export function clearCompiledBroadSurfaceManifest(
  host: CompiledBroadOwnerLifecycleHost,
  manifestFingerprint?: string
): void {
  if (manifestFingerprint) {
    host.compiledBroadSurfaceReadyDetailDemands.delete(manifestFingerprint);
    if (host.compiledBroadSurfaceCandidateManifest?.manifestFingerprint === manifestFingerprint) {
      disposeCompiledBroadSurfaceCandidate(host);
    }
    for (const [trackId, owner] of host.compiledBroadSurfaceTrackCandidateOwners) {
      if (owner.manifest.manifestFingerprint !== manifestFingerprint) continue;
      host.compiledBroadSurfaceTrackCandidateOwners.delete(trackId);
      disposeCompiledBroadSurfaceTrackOwner(host, owner);
    }
    if (host.compiledBroadSurfaceManifest?.manifestFingerprint === manifestFingerprint) {
      const presenter = host.compiledBroadSurfacePresenter;
      if (presenter?.container.parent === host.container) {
        host.container.removeChild(presenter.container as never);
      }
      presenter?.destroy();
      destroyCompiledBroadSurfaceOwnedTextures(host, manifestFingerprint);
      host.compiledBroadSurfacePresenter = null;
      host.compiledBroadSurfaceManifest = null;
      host.compiledBroadSurfaceProvenance = null;
    }
    for (const [trackId, owner] of host.compiledBroadSurfaceTrackOwners) {
      if (owner.manifest.manifestFingerprint !== manifestFingerprint) continue;
      host.compiledBroadSurfaceTrackOwners.delete(trackId);
      disposeCompiledBroadSurfaceTrackOwner(host, owner);
    }
    for (const [leaseId, lease] of host.compiledBroadSurfaceDemandLeases) {
      if (lease.manifestFingerprint === manifestFingerprint) {
        host.compiledBroadSurfaceDemandLeases.delete(leaseId);
      }
    }
    host.compiledBroadSurfacePlanStatus =
      host.compiledBroadSurfacePresenter ||
      host.compiledBroadSurfaceTrackOwners.size > 0 ||
      host.compiledBroadSurfaceTrackCandidateOwners.size > 0
        ? 'broad-cells-missing'
        : 'not-loaded';
    host.compiledBroadSurfaceLastCompleteTrackIds = Object.freeze(
      host.compiledBroadSurfaceLastCompleteTrackIds.filter((trackId) =>
        Boolean(host.compiledBroadSurfaceOwnerForTrack(trackId))
      )
    );
    if (host.compiledBroadSurfaceLastCompleteTrackIds.length === 0) {
      host.compiledBroadSurfaceOwnedLastFrame = false;
    }
    if (
      !host.compiledBroadSurfaceManifest &&
      !host.compiledBroadSurfaceCandidateManifest &&
      host.compiledBroadSurfaceTrackOwners.size === 0 &&
      host.compiledBroadSurfaceTrackCandidateOwners.size === 0 &&
      host.prepackedAnnotationSceneResidents.size === 0 &&
      !host.prepackedAnnotationSceneLayer
    ) {
      host.prepackedAnnotationRuntimePolicy = null;
      host.reconcileAnnotationLaneEnvelopeAuthority();
    }
    return;
  }
  disposeCompiledBroadSurfaceCandidate(host);
  const presenter = host.compiledBroadSurfacePresenter;
  if (presenter?.container.parent === host.container) {
    host.container.removeChild(presenter.container as never);
  }
  presenter?.destroy();
  for (const texture of host.compiledBroadSurfaceOwnedCellTextures.values()) {
    if (!texture.destroyed) texture.destroy(true);
  }
  host.compiledBroadSurfaceOwnedCellTextures.clear();
  host.compiledBroadSurfaceGpuPreuploadedCellIds.clear();
  host.compiledBroadSurfacePresenter = null;
  host.compiledBroadSurfaceManifest = null;
  host.compiledBroadSurfaceProvenance = null;
  for (const owner of host.compiledBroadSurfaceTrackOwners.values()) {
    disposeCompiledBroadSurfaceTrackOwner(host, owner);
  }
  host.compiledBroadSurfaceTrackOwners.clear();
  for (const owner of host.compiledBroadSurfaceTrackCandidateOwners.values()) {
    disposeCompiledBroadSurfaceTrackOwner(host, owner);
  }
  host.compiledBroadSurfaceTrackCandidateOwners.clear();
  host.compiledBroadSurfaceLastCompleteTrackIds = Object.freeze([]);
  host.compiledBroadSurfaceOwnedLastFrame = false;
  host.compiledBroadSurfaceLastCameraRequest = null;
  host.compiledBroadSurfaceLastPresentationCamera = null;
  host.compiledBroadSurfaceDemandLeases.clear();
  host.compiledBroadSurfaceReadyDetailDemands.clear();
  host.compiledBroadSurfaceCameraEpoch += 1;
  host.compiledBroadSurfacePlanStatus = 'not-loaded';
  if (host.prepackedAnnotationSceneResidents.size === 0 && !host.prepackedAnnotationSceneLayer) {
    host.prepackedAnnotationRuntimePolicy = null;
    host.reconcileAnnotationLaneEnvelopeAuthority();
  }
}
