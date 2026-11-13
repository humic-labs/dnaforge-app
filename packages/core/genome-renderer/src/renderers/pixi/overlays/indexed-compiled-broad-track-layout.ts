import type {
  AnnotationPolicyGpuRuntimeV1,
  AnnotationPolicyGpuTrackLaneMaximaV1,
} from '../overview/annotation-policy-gpu-instances-v1';
import type { CompiledBroadSurfaceTrackOwnerV2 } from './indexed-compiled-broad-frame';

export type CompiledBroadTrackLayoutHost = {
  compiledBroadSurfaceCandidateManifest: CompiledBroadSurfaceTrackOwnerV2['manifest'] | null;
  compiledBroadSurfaceCandidateProvenance: CompiledBroadSurfaceTrackOwnerV2['provenance'] | null;
  compiledBroadSurfaceCandidatePresenter: CompiledBroadSurfaceTrackOwnerV2['presenter'] | null;
  compiledBroadSurfaceTrackCandidateOwners: Map<string, CompiledBroadSurfaceTrackOwnerV2>;
  compiledBroadSurfaceRequirement: unknown;
  compiledBroadSurfaceOwnerForTrack(trackId: string): CompiledBroadSurfaceTrackOwnerV2 | null;
  compiledBroadSurfaceCandidateOwnerForTrack(
    trackId: string
  ): CompiledBroadSurfaceTrackOwnerV2 | null;
  installCompiledBroadSurfaceActiveOwner(owner: CompiledBroadSurfaceTrackOwnerV2): void;
  disposeCompiledBroadSurfaceCandidate(): void;
  disposeCompiledBroadSurfaceTrackOwner(owner: CompiledBroadSurfaceTrackOwnerV2): void;
  prepackedAnnotationSceneResidentForTrack(trackId: string): {
    policyTrackLaneMaxima?: AnnotationPolicyGpuTrackLaneMaximaV1 | null;
  } | null;
  annotationLayerTypesForPresentation(): string[];
  annotationTrackRealizedLaneCapacity(
    trackId: string,
    policy: AnnotationPolicyGpuRuntimeV1,
    preserveLegacyFixedCapacity?: boolean
  ): number;
  compiledBroadSurfaceLaneStart(
    trackId: string,
    requestedLayerTypes: readonly string[],
    policy: AnnotationPolicyGpuRuntimeV1
  ): number;
};

export function installCompiledBroadSurfaceCandidateOwner(
  host: CompiledBroadTrackLayoutHost,
  owner: CompiledBroadSurfaceTrackOwnerV2
): void {
  if (owner.manifest.trackId === 'mRNA') {
    host.compiledBroadSurfaceCandidateManifest = owner.manifest;
    host.compiledBroadSurfaceCandidateProvenance = owner.provenance;
    host.compiledBroadSurfaceCandidatePresenter = owner.presenter;
    return;
  }
  host.compiledBroadSurfaceTrackCandidateOwners.set(owner.manifest.trackId, owner);
}

export function compiledBroadSurfaceCandidateRegistrationMatches(
  host: CompiledBroadTrackLayoutHost,
  owner: CompiledBroadSurfaceTrackOwnerV2
): boolean {
  const registered = host.compiledBroadSurfaceCandidateOwnerForTrack(owner.manifest.trackId);
  return Boolean(
    registered &&
    registered.manifest === owner.manifest &&
    registered.provenance === owner.provenance &&
    registered.presenter === owner.presenter
  );
}

export function disposeCompiledBroadSurfaceRegisteredCandidate(
  host: CompiledBroadTrackLayoutHost,
  owner: CompiledBroadSurfaceTrackOwnerV2
): void {
  if (
    owner.manifest === host.compiledBroadSurfaceCandidateManifest &&
    owner.provenance === host.compiledBroadSurfaceCandidateProvenance &&
    owner.presenter === host.compiledBroadSurfaceCandidatePresenter
  ) {
    host.disposeCompiledBroadSurfaceCandidate();
    return;
  }
  for (const [trackId, candidate] of host.compiledBroadSurfaceTrackCandidateOwners) {
    if (candidate !== owner) continue;
    host.compiledBroadSurfaceTrackCandidateOwners.delete(trackId);
    host.disposeCompiledBroadSurfaceTrackOwner(candidate);
    return;
  }
}

export function finalizeCompiledBroadSurfaceCandidateOwner(
  host: CompiledBroadTrackLayoutHost,
  owner: CompiledBroadSurfaceTrackOwnerV2
): void {
  const previous = host.compiledBroadSurfaceOwnerForTrack(owner.manifest.trackId);
  host.installCompiledBroadSurfaceActiveOwner(owner);
  if (owner.manifest.trackId === 'mRNA') {
    host.compiledBroadSurfaceCandidateManifest = null;
    host.compiledBroadSurfaceCandidateProvenance = null;
    host.compiledBroadSurfaceCandidatePresenter = null;
  } else {
    for (const [trackId, candidate] of host.compiledBroadSurfaceTrackCandidateOwners) {
      if (candidate === owner) host.compiledBroadSurfaceTrackCandidateOwners.delete(trackId);
    }
  }
  if (previous && previous.presenter !== owner.presenter) {
    host.disposeCompiledBroadSurfaceTrackOwner(previous);
  }
}

export function compiledBroadSurfaceLaneStart(
  host: CompiledBroadTrackLayoutHost,
  trackId: string,
  requestedLayerTypes: readonly string[],
  policy: AnnotationPolicyGpuRuntimeV1
): number {
  const preferred = ['gene', 'mRNA', 'lncRNA', 'lnc_RNA', 'ncRNA', 'miRNA', 'snoRNA', 'tRNA'];
  const priority = new Map(preferred.map((type, index) => [type, index]));
  const ordered = [...new Set(requestedLayerTypes)].sort((left, right) => {
    const leftRank = priority.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = priority.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftRank === rightRank ? left.localeCompare(right) : leftRank - rightRank;
  });
  let laneStart = 0;
  for (const requestedTrackId of ordered) {
    if (requestedTrackId === trackId) return laneStart;
    laneStart +=
      host.annotationTrackRealizedLaneCapacity(requestedTrackId, policy, ordered.length <= 1) + 1;
  }
  return laneStart;
}

export function annotationTrackRealizedLaneCapacity(
  host: CompiledBroadTrackLayoutHost,
  trackId: string,
  policy: AnnotationPolicyGpuRuntimeV1,
  preserveLegacyFixedCapacity = host.annotationLayerTypesForPresentation().length <= 1
): number {
  const owner = host.compiledBroadSurfaceOwnerForTrack(trackId);
  const resident = host.prepackedAnnotationSceneResidentForTrack(trackId);
  const artifactLaneCount = owner?.manifest.laneRowCounts[policy.isoformMode];
  const residentLaneCount = resident?.policyTrackLaneMaxima
    ? resident.policyTrackLaneMaxima[policy.isoformMode] + 1
    : null;
  const realizedLaneCount = artifactLaneCount ?? residentLaneCount ?? 1;
  if (
    policy.laneLimit !== null &&
    !owner &&
    !host.compiledBroadSurfaceRequirement &&
    preserveLegacyFixedCapacity
  ) {
    return policy.laneLimit;
  }
  return Math.max(
    1,
    policy.laneLimit === null ? realizedLaneCount : Math.min(realizedLaneCount, policy.laneLimit)
  );
}

export function annotationTrackStackMaxLane(
  host: CompiledBroadTrackLayoutHost,
  policy: AnnotationPolicyGpuRuntimeV1
): number {
  const requestedLayerTypes = host.annotationLayerTypesForPresentation();
  let maxLane = -1;
  for (const trackId of requestedLayerTypes) {
    const laneStart = host.compiledBroadSurfaceLaneStart(trackId, requestedLayerTypes, policy);
    const laneCapacity = host.annotationTrackRealizedLaneCapacity(trackId, policy);
    maxLane = Math.max(maxLane, laneStart + laneCapacity - 1);
  }
  return maxLane;
}
