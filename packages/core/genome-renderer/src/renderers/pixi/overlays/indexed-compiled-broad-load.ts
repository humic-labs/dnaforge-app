import type { Container } from 'pixi.js';
import { CompiledBroadSurfacePixiPresenterV2 } from '../overview/compiled-broad-surface-pixi-presenter';
import type {
  CompiledBroadSurfaceAdmissionProvenanceV1,
  CompiledBroadSurfaceManifestV2,
} from '../overview/bounded-annotation-broad-surface';
import { canAdmitCompiledBroadSurfaceManifest } from './indexed-compiled-broad-manifest-admission';
import type { CompiledBroadSurfaceTrackOwnerV2 } from './indexed-compiled-broad-frame';
import type { CompiledBroadSurfaceRequirementV1 } from './indexed-compiled-broad-requirement';
import type { CompiledBroadSurfacePlanStatusV2 } from './annotation-overlay-types';

export type CompiledBroadLoadHost = {
  genomeLength: number;
  requirement: CompiledBroadSurfaceRequirementV1 | null;
  hasAdmittedSurface: boolean;
  provenanceFailure(
    manifest: CompiledBroadSurfaceManifestV2,
    provenance: CompiledBroadSurfaceAdmissionProvenanceV1
  ): string | null;
  requireCompiledBroadSurface(input: CompiledBroadSurfaceRequirementV1): boolean;
  ownerForTrack(trackId: string): CompiledBroadSurfaceTrackOwnerV2 | null;
  candidateOwnerForTrack(trackId: string): CompiledBroadSurfaceTrackOwnerV2 | null;
  provenanceIsCurrent(
    manifest: CompiledBroadSurfaceManifestV2,
    provenance: CompiledBroadSurfaceAdmissionProvenanceV1
  ): boolean;
  admissionIdentityMatches(
    owner: CompiledBroadSurfaceTrackOwnerV2,
    manifest: CompiledBroadSurfaceManifestV2,
    provenance: CompiledBroadSurfaceAdmissionProvenanceV1
  ): boolean;
  disposeRegisteredCandidate(owner: CompiledBroadSurfaceTrackOwnerV2): void;
  installActiveOwner(owner: CompiledBroadSurfaceTrackOwnerV2): void;
  installCandidateOwner(owner: CompiledBroadSurfaceTrackOwnerV2): void;
  reconcileLaneEnvelope(): void;
  setPlanStatus(status: 'broad-cells-missing' | 'rejected' | 'not-loaded'): void;
  addPresenterContainer(container: Container): void;
};

export function loadCompiledBroadSurfaceManifest(
  host: CompiledBroadLoadHost,
  manifest: CompiledBroadSurfaceManifestV2,
  provenance: CompiledBroadSurfaceAdmissionProvenanceV1
): boolean {
  if (
    !canAdmitCompiledBroadSurfaceManifest({
      hasManifestObject: Boolean(manifest && typeof manifest === 'object'),
      hostGenomeLength: host.genomeLength,
      manifestGenomeLength: manifest?.genomeLengthBp ?? 0,
      hasAdmittedSurface: host.hasAdmittedSurface,
      requirement: host.requirement,
      manifestBroadCorridorFinestSpanBp: manifest?.broadCorridorFinestSpanBp ?? 0,
      themeMode: provenance.themeMode ?? '',
      provenanceFailure:
        manifest && typeof manifest === 'object'
          ? host.provenanceFailure(manifest, provenance)
          : 'compiled-broad-surface-provenance-identity-mismatch',
    })
  ) {
    return false;
  }
  if (
    !host.requireCompiledBroadSurface({
      genomeLengthBp: manifest.genomeLengthBp,
      broadCorridorFinestSpanBp: manifest.broadCorridorFinestSpanBp,
    })
  ) {
    return false;
  }
  const activeOwner = host.ownerForTrack(manifest.trackId);
  const candidateOwner = host.candidateOwnerForTrack(manifest.trackId);
  if (
    activeOwner?.manifest.manifestFingerprint === manifest.manifestFingerprint &&
    sameRoleTable(activeOwner.provenance.roleTable, provenance.roleTable) &&
    host.provenanceIsCurrent(activeOwner.manifest, activeOwner.provenance)
  ) {
    if (
      candidateOwner &&
      candidateOwner.manifest.manifestFingerprint !== manifest.manifestFingerprint
    ) {
      host.disposeRegisteredCandidate(candidateOwner);
    }
    if (!host.admissionIdentityMatches(activeOwner, manifest, provenance)) {
      if (candidateOwner) host.disposeRegisteredCandidate(candidateOwner);
      host.installActiveOwner(
        Object.freeze({
          manifest,
          provenance: Object.freeze({ ...provenance }),
          presenter: activeOwner.presenter,
        })
      );
    }
    host.reconcileLaneEnvelope();
    return true;
  }
  if (
    candidateOwner &&
    host.admissionIdentityMatches(candidateOwner, manifest, provenance) &&
    sameRoleTable(candidateOwner.provenance.roleTable, provenance.roleTable) &&
    host.provenanceIsCurrent(candidateOwner.manifest, candidateOwner.provenance)
  ) {
    host.reconcileLaneEnvelope();
    return true;
  }
  try {
    const owner = Object.freeze({
      manifest,
      provenance: Object.freeze({ ...provenance }),
      presenter: new CompiledBroadSurfacePixiPresenterV2(
        manifest,
        provenance.roleTable ? { roleTable: provenance.roleTable } : {}
      ),
    });
    if (activeOwner) {
      if (candidateOwner) host.disposeRegisteredCandidate(candidateOwner);
      host.installCandidateOwner(owner);
    } else {
      if (candidateOwner) host.disposeRegisteredCandidate(candidateOwner);
      host.installActiveOwner(owner);
    }
    host.setPlanStatus('broad-cells-missing');
    host.addPresenterContainer(owner.presenter.container);
    host.reconcileLaneEnvelope();
    return true;
  } catch {
    host.setPlanStatus('rejected');
    return false;
  }
}

function sameRoleTable(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined
): boolean {
  if (!left || !right) return left === right;
  return left.length === right.length && left.every((role, index) => role === right[index]);
}

export type CompiledBroadLoadOverlayBindings = {
  genomeLength: number;
  compiledBroadSurfaceRequirement: CompiledBroadSurfaceRequirementV1 | null;
  compiledBroadSurfaceManifest: unknown;
  compiledBroadSurfaceCandidateManifest: unknown;
  compiledBroadSurfaceTrackOwners: { readonly size: number };
  compiledBroadSurfaceTrackCandidateOwners: { readonly size: number };
  compiledBroadSurfacePlanStatus: CompiledBroadSurfacePlanStatusV2;
  container: { addChildAt(child: Container, index: number): unknown };
  compiledBroadSurfaceProvenanceFailure(
    manifest: CompiledBroadSurfaceManifestV2,
    provenance: CompiledBroadSurfaceAdmissionProvenanceV1
  ): string | null;
  requireCompiledBroadSurface(input: CompiledBroadSurfaceRequirementV1): boolean;
  compiledBroadSurfaceOwnerForTrack(trackId: string): CompiledBroadSurfaceTrackOwnerV2 | null;
  compiledBroadSurfaceCandidateOwnerForTrack(
    trackId: string
  ): CompiledBroadSurfaceTrackOwnerV2 | null;
  compiledBroadSurfaceProvenanceIsCurrent(
    manifest: CompiledBroadSurfaceManifestV2,
    provenance: CompiledBroadSurfaceAdmissionProvenanceV1
  ): boolean;
  compiledBroadSurfaceAdmissionIdentityMatches(
    owner: CompiledBroadSurfaceTrackOwnerV2,
    manifest: CompiledBroadSurfaceManifestV2,
    provenance: CompiledBroadSurfaceAdmissionProvenanceV1
  ): boolean;
  disposeCompiledBroadSurfaceRegisteredCandidate(owner: CompiledBroadSurfaceTrackOwnerV2): void;
  installCompiledBroadSurfaceActiveOwner(owner: CompiledBroadSurfaceTrackOwnerV2): void;
  installCompiledBroadSurfaceCandidateOwner(owner: CompiledBroadSurfaceTrackOwnerV2): void;
  reconcileAnnotationLaneEnvelopeAuthority(): void;
};

export function createCompiledBroadLoadHost(
  overlay: CompiledBroadLoadOverlayBindings
): CompiledBroadLoadHost {
  return {
    get genomeLength() {
      return overlay.genomeLength;
    },
    get requirement() {
      return overlay.compiledBroadSurfaceRequirement;
    },
    get hasAdmittedSurface() {
      return (
        overlay.compiledBroadSurfaceManifest !== null ||
        overlay.compiledBroadSurfaceCandidateManifest !== null ||
        overlay.compiledBroadSurfaceTrackOwners.size > 0 ||
        overlay.compiledBroadSurfaceTrackCandidateOwners.size > 0
      );
    },
    provenanceFailure: (manifest, provenance) =>
      overlay.compiledBroadSurfaceProvenanceFailure(manifest, provenance),
    requireCompiledBroadSurface: (input) => overlay.requireCompiledBroadSurface(input),
    ownerForTrack: (trackId) => overlay.compiledBroadSurfaceOwnerForTrack(trackId),
    candidateOwnerForTrack: (trackId) =>
      overlay.compiledBroadSurfaceCandidateOwnerForTrack(trackId),
    provenanceIsCurrent: (manifest, provenance) =>
      overlay.compiledBroadSurfaceProvenanceIsCurrent(manifest, provenance),
    admissionIdentityMatches: (owner, manifest, provenance) =>
      overlay.compiledBroadSurfaceAdmissionIdentityMatches(owner, manifest, provenance),
    disposeRegisteredCandidate: (owner) =>
      overlay.disposeCompiledBroadSurfaceRegisteredCandidate(owner),
    installActiveOwner: (owner) => overlay.installCompiledBroadSurfaceActiveOwner(owner),
    installCandidateOwner: (owner) => overlay.installCompiledBroadSurfaceCandidateOwner(owner),
    reconcileLaneEnvelope: () => overlay.reconcileAnnotationLaneEnvelopeAuthority(),
    setPlanStatus: (status) => {
      overlay.compiledBroadSurfacePlanStatus = status;
    },
    addPresenterContainer: (container) => {
      overlay.container.addChildAt(container, 0);
    },
  };
}
