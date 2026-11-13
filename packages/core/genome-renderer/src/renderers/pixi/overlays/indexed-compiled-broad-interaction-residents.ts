import { compiledBroadSurfaceRequirementOwnsCamera } from './annotation-compiled-broad-address';
import { prepackedAnnotationSceneMetadataEqual } from './annotation-prepacked-metadata';
import {
  pickDisposableCachedResident,
  selectProtectedInteractionResident,
} from './indexed-prepacked-resident-eviction';
import {
  sameViewportDetailPresentationLease,
  type PrepackedViewportDetailLease,
} from './indexed-prepacked-resident-selection';
import {
  compiledBroadAnnotationInteractionConflictsWithExisting,
  isCompiledBroadAnnotationInteractionAdmissible,
} from './indexed-compiled-broad-interaction-admission';
import { isCompiledBroadDemandRefreshRequired } from './indexed-compiled-broad-demand-refresh';
import { selectCompiledBroadThemeOwner } from './indexed-compiled-broad-theme-roster';
import {
  compiledBroadCompactInteractionResidentMatches,
  compiledBroadInteractionBlockedByDifferentActiveOwner,
  compiledBroadInteractionResidentMatchesOwner,
  selectUniqueOrActivePrepackedResident,
} from './indexed-compiled-broad-provenance';
import type { CompiledBroadSurfaceTrackOwnerV2 } from './indexed-compiled-broad-frame';
import type {
  CompiledBroadSurfaceAdmissionProvenanceV1,
  CompiledBroadSurfaceManifestV2,
} from '../overview/bounded-annotation-broad-surface';
import {
  validatePrepackedAnnotationRuntimePolicy,
  validatePrepackedAnnotationSceneMetadata,
  type PrepackedAnnotationSceneMetadata,
} from '../overview/prepacked-annotation-scene';
import type { AnnotationPolicyGpuRuntimeV1 } from '../overview/annotation-policy-gpu-instances-v1';
import type { CompiledBroadSurfaceRequirementV1 } from './indexed-compiled-broad-requirement';
import {
  findAnnotationTrackIdentity,
  resolveAnnotationTrackIdentity,
} from '../../../annotation-track-identity';
import type { AnnotationRolePaletteOverridesV1 } from '../../../annotation-role-palette';

export const PREPACKED_ANNOTATION_INTERACTION_RESIDENT_OWNER_LIMIT = 16;

export type CompiledBroadSourcePlacementAuthorityV1 = {
  readonly genomeIdentity: string;
  readonly genomeLengthBp: number;
  readonly sourceFingerprint: string;
  readonly placementFingerprint: string;
};

export type CompiledBroadAnnotationInteractionLoadV1 = {
  readonly validationMarker: string;
  readonly ownerKey: string;
  readonly sourceFingerprint: string;
  readonly interactionPayloadSha256: string;
  readonly sourceScene: Readonly<{
    byteCount: number;
    payloadSha256: string;
    contractSha256: string;
  }>;
  readonly metadata: PrepackedAnnotationSceneMetadata;
  readonly policyProjection: { readonly featureCount: number };
  readonly featureLookup: { readonly featureCount: number };
};

export type ResidentCompiledBroadAnnotationInteraction =
  CompiledBroadAnnotationInteractionLoadV1 & {
    lastUsed: number;
  };

export type CompiledBroadInteractionPrepackedResident = {
  ownerKey: string;
  metadata: {
    artifactKey: string;
    genomeIdentity: string;
    genomeLengthBp: number;
    trackType: string;
  };
  input?: { ownerKey?: string; viewportDetail?: PrepackedViewportDetailLease };
  layer?: { isPresenting?: boolean };
};

export type CompiledBroadCameraRequest = {
  viewportStartBp: number;
  viewportEndBp: number;
  viewportCssWidthPx: number;
  devicePixelRatio: number;
};

export type CompiledBroadPresentationCamera = {
  contract: unknown;
  fwdStrandTop: number;
  viewportCssWidthPx: number;
  viewportCssHeightPx: number;
  themeMode: 'light' | 'dark';
  rolePalette?: AnnotationRolePaletteOverridesV1;
};

export type CompiledBroadReadyDetailDemand = {
  manifestFingerprint: string;
  isoformMode: string;
  laneLimit: number | null;
  viewportDetail: PrepackedViewportDetailLease;
};

export type CompiledBroadInteractionResidentHost = {
  currentGenomeIdentity: string;
  genomeLength: number;
  currentGenomeAnnotationSourcePlacementProvenance: {
    sourceFingerprint: string;
    placementFingerprint: string;
  } | null;
  compiledBroadSurfaceSourcePlacementAuthority: Readonly<CompiledBroadSourcePlacementAuthorityV1> | null;
  compiledBroadSurfaceProvenance: CompiledBroadSurfaceAdmissionProvenanceV1 | null;
  compiledBroadSurfaceCandidateProvenance: CompiledBroadSurfaceAdmissionProvenanceV1 | null;
  compiledBroadSurfaceTrackOwners: Map<string, CompiledBroadSurfaceTrackOwnerV2>;
  compiledBroadSurfaceTrackCandidateOwners: Map<string, CompiledBroadSurfaceTrackOwnerV2>;
  compiledBroadSurfaceManifest: CompiledBroadSurfaceManifestV2 | null;
  compiledBroadSurfacePresenter: CompiledBroadSurfaceTrackOwnerV2['presenter'] | null;
  compiledBroadSurfaceCandidateManifest: CompiledBroadSurfaceManifestV2 | null;
  compiledBroadSurfaceCandidatePresenter: CompiledBroadSurfaceTrackOwnerV2['presenter'] | null;
  currentAnnotationSourceFingerprint: string | null;
  currentAnnotationPlacementFingerprint: string | null;
  compiledBroadAnnotationInteractionResidents: Map<
    string,
    ResidentCompiledBroadAnnotationInteraction
  >;
  prepackedAnnotationSceneResidentClock: number;
  compiledBroadAnnotationInteractionResidentGeneration: number;
  prepackedAnnotationSceneOwnerKey: string | null;
  prepackedAnnotationSceneResidents: {
    get(ownerKey: string): CompiledBroadInteractionPrepackedResident | undefined;
    values(): Iterable<CompiledBroadInteractionPrepackedResident>;
  };
  prepackedAnnotationSceneLayer: unknown;
  prepackedAnnotationSceneReplacementCandidates: {
    get(
      ownerKey: string
    ): { input?: { viewportDetail?: PrepackedViewportDetailLease } } | undefined;
  };
  compiledBroadSurfaceLastCameraRequest: CompiledBroadCameraRequest | null;
  compiledBroadSurfaceLastPresentationCamera: CompiledBroadPresentationCamera | null;
  compiledBroadSurfaceLinearContract: { update(path: { fwdStrandTop: number }): void };
  compiledBroadSurfaceRequirement: CompiledBroadSurfaceRequirementV1 | null;
  compiledBroadSurfacePlanStatus: string;
  compiledBroadSurfaceReadyDetailDemands: Map<string, CompiledBroadReadyDetailDemand>;
  compiledBroadSurfaceDemandLeases: Map<string, unknown>;
  compiledBroadSurfaceCameraEpoch: number;
  compiledBroadSurfaceLastCompleteTrackIds: readonly string[];
  compiledBroadSurfaceProvenanceIsCurrent(
    manifest: CompiledBroadSurfaceManifestV2 | null,
    provenance: CompiledBroadSurfaceAdmissionProvenanceV1 | null
  ): boolean;
  compiledBroadSurfaceAdmissionOwner(
    manifestFingerprint: string
  ): CompiledBroadSurfaceTrackOwnerV2 | null;
  compiledBroadSurfaceOwnerForTrack(trackId: string): CompiledBroadSurfaceTrackOwnerV2 | null;
  compiledBroadSurfaceCandidateOwnerForTrack(
    trackId: string
  ): CompiledBroadSurfaceTrackOwnerV2 | null;
  annotationLayerTypesForPresentation(): string[];
};

export function admitCompiledBroadSurfaceSourcePlacementAuthority(
  host: CompiledBroadInteractionResidentHost,
  authority: CompiledBroadSourcePlacementAuthorityV1
): boolean {
  if (
    !authority ||
    authority.genomeIdentity !== host.currentGenomeIdentity ||
    authority.genomeLengthBp !== host.genomeLength ||
    !/^[0-9a-f]{24}$/.test(authority.sourceFingerprint) ||
    !/^ap1:[0-9a-f]{24}$/.test(authority.placementFingerprint)
  ) {
    return false;
  }
  const genomeAuthority = host.currentGenomeAnnotationSourcePlacementProvenance;
  if (
    genomeAuthority &&
    (genomeAuthority.sourceFingerprint !== authority.sourceFingerprint ||
      genomeAuthority.placementFingerprint !== authority.placementFingerprint)
  ) {
    return false;
  }
  const admitted = host.compiledBroadSurfaceSourcePlacementAuthority;
  if (
    admitted &&
    (admitted.genomeIdentity !== authority.genomeIdentity ||
      admitted.genomeLengthBp !== authority.genomeLengthBp ||
      admitted.sourceFingerprint !== authority.sourceFingerprint ||
      admitted.placementFingerprint !== authority.placementFingerprint)
  ) {
    return false;
  }
  for (const provenance of [
    host.compiledBroadSurfaceProvenance,
    host.compiledBroadSurfaceCandidateProvenance,
    ...[...host.compiledBroadSurfaceTrackOwners.values()].map((owner) => owner.provenance),
    ...[...host.compiledBroadSurfaceTrackCandidateOwners.values()].map((owner) => owner.provenance),
  ]) {
    if (
      provenance &&
      (provenance.genomeIdentity !== authority.genomeIdentity ||
        provenance.genomeLengthBp !== authority.genomeLengthBp ||
        provenance.sourceFingerprint !== authority.sourceFingerprint ||
        provenance.placementFingerprint !== authority.placementFingerprint)
    ) {
      return false;
    }
  }
  host.compiledBroadSurfaceSourcePlacementAuthority = Object.freeze({ ...authority });
  host.currentAnnotationSourceFingerprint = authority.sourceFingerprint;
  host.currentAnnotationPlacementFingerprint = authority.placementFingerprint;
  return true;
}

export function loadCompiledBroadAnnotationInteraction(
  host: CompiledBroadInteractionResidentHost,
  input: CompiledBroadAnnotationInteractionLoadV1
): ResidentCompiledBroadAnnotationInteraction | null {
  if (
    !input ||
    !isCompiledBroadAnnotationInteractionAdmissible({
      ownerKey: input.ownerKey,
      validationMarker: input.validationMarker,
      sourceFingerprint: input.sourceFingerprint,
      interactionPayloadSha256: input.interactionPayloadSha256,
      sourceScene: input.sourceScene,
      metadataValid: validatePrepackedAnnotationSceneMetadata(input.metadata),
      metadataGenomeIdentity: input.metadata.genomeIdentity,
      metadataGenomeLengthBp: input.metadata.genomeLengthBp,
      currentGenomeIdentity: host.currentGenomeIdentity,
      currentGenomeLengthBp: host.genomeLength,
      policyFeatureCount: input.policyProjection.featureCount,
      lookupFeatureCount: input.featureLookup.featureCount,
    })
  ) {
    return null;
  }
  const existing = host.compiledBroadAnnotationInteractionResidents.get(input.ownerKey);
  if (
    existing &&
    compiledBroadAnnotationInteractionConflictsWithExisting({
      existing,
      candidate: input,
      metadataEqual: prepackedAnnotationSceneMetadataEqual(existing.metadata, input.metadata),
    })
  ) {
    return null;
  }
  if (existing) {
    existing.lastUsed = ++host.prepackedAnnotationSceneResidentClock;
    return existing;
  }
  const rosterBefore = [...host.compiledBroadAnnotationInteractionResidents.keys()]
    .sort((left, right) => left.localeCompare(right))
    .join('\n');
  const admitted: ResidentCompiledBroadAnnotationInteraction = {
    ...input,
    sourceScene: Object.freeze({ ...input.sourceScene }),
    metadata: Object.freeze({ ...input.metadata }),
    lastUsed: ++host.prepackedAnnotationSceneResidentClock,
  };
  host.compiledBroadAnnotationInteractionResidents.set(input.ownerKey, admitted);
  evictCompiledBroadAnnotationInteractionResidentsToLimit(host);
  const rosterAfter = [...host.compiledBroadAnnotationInteractionResidents.keys()]
    .sort((left, right) => left.localeCompare(right))
    .join('\n');
  if (rosterBefore !== rosterAfter) {
    host.compiledBroadAnnotationInteractionResidentGeneration += 1;
  }
  return admitted;
}

export function compiledBroadSurfaceInteractionResidentForTrack(
  host: CompiledBroadInteractionResidentHost,
  trackId: string
): CompiledBroadInteractionPrepackedResident | null {
  const owner = host.compiledBroadSurfaceOwnerForTrack(trackId);
  if (
    !owner ||
    !owner.presenter.isPresenting ||
    !host.compiledBroadSurfaceProvenanceIsCurrent(owner.manifest, owner.provenance)
  ) {
    return null;
  }
  const { manifest, provenance } = owner;
  const activeResident = host.prepackedAnnotationSceneOwnerKey
    ? host.prepackedAnnotationSceneResidents.get(host.prepackedAnnotationSceneOwnerKey)
    : null;
  if (
    compiledBroadInteractionBlockedByDifferentActiveOwner({
      activeTrackType: activeResident?.metadata.trackType,
      activeOwnerKey: activeResident?.ownerKey,
      trackId,
      expectedOwnerKey: provenance.prepackedOwnerKey,
    })
  ) {
    return null;
  }
  const resident = host.prepackedAnnotationSceneResidents.get(provenance.prepackedOwnerKey);
  if (
    !compiledBroadInteractionResidentMatchesOwner({
      resident,
      provenance,
      manifestTrackId: manifest.trackId,
    })
  ) {
    return null;
  }
  return resident ?? null;
}

export function compiledBroadAnnotationInteractionResidentForTrack(
  host: CompiledBroadInteractionResidentHost,
  trackId: string
): ResidentCompiledBroadAnnotationInteraction | null {
  const owner = host.compiledBroadSurfaceOwnerForTrack(trackId);
  if (
    !owner ||
    !owner.presenter.isPresenting ||
    !host.compiledBroadSurfaceProvenanceIsCurrent(owner.manifest, owner.provenance)
  ) {
    return null;
  }
  const resident = host.compiledBroadAnnotationInteractionResidents.get(
    owner.provenance.prepackedOwnerKey
  );
  if (
    !resident ||
    !compiledBroadCompactInteractionResidentMatches({
      resident,
      provenance: owner.provenance,
      manifestTrackId: owner.manifest.trackId,
    })
  ) {
    return null;
  }
  resident.lastUsed = ++host.prepackedAnnotationSceneResidentClock;
  return resident;
}

export function prepackedAnnotationSceneResidentForTrack(
  host: CompiledBroadInteractionResidentHost,
  trackId: string
): CompiledBroadInteractionPrepackedResident | null {
  const owner = host.compiledBroadSurfaceOwnerForTrack(trackId);
  if (owner && host.compiledBroadSurfaceProvenanceIsCurrent(owner.manifest, owner.provenance)) {
    const resident = host.prepackedAnnotationSceneResidents.get(owner.provenance.prepackedOwnerKey);
    if (
      resident &&
      resident.metadata.artifactKey === owner.provenance.prepackedArtifactKey &&
      resident.metadata.genomeIdentity === owner.provenance.genomeIdentity &&
      resident.metadata.genomeLengthBp === owner.provenance.genomeLengthBp &&
      resident.metadata.trackType.toLocaleLowerCase() === owner.manifest.trackId.toLocaleLowerCase()
    ) {
      return resident;
    }
  }

  const currentResidents = [...host.prepackedAnnotationSceneResidents.values()].filter(
    (resident) =>
      resident.metadata.genomeIdentity === host.currentGenomeIdentity &&
      resident.metadata.genomeLengthBp === host.genomeLength
  );
  const identity = resolveAnnotationTrackIdentity(
    trackId,
    currentResidents,
    (resident) => resident.metadata.trackType
  );
  if (identity.status !== 'matched') return null;
  const resolvedTrackType = identity.value.metadata.trackType;
  const candidates = currentResidents.filter(
    (resident) => resident.metadata.trackType === resolvedTrackType
  );
  return (
    selectUniqueOrActivePrepackedResident({
      candidates,
      activeOwnerKey: host.prepackedAnnotationSceneOwnerKey,
      activeLayer: host.prepackedAnnotationSceneLayer,
    }) ?? null
  );
}

export function requestedPrepackedAnnotationSceneResidentForTrack(
  host: CompiledBroadInteractionResidentHost,
  trackId: string
): CompiledBroadInteractionPrepackedResident | null {
  const owner = host.compiledBroadSurfaceOwnerForTrack(trackId);
  if (owner && host.compiledBroadSurfaceProvenanceIsCurrent(owner.manifest, owner.provenance)) {
    const resident = host.prepackedAnnotationSceneResidents.get(owner.provenance.prepackedOwnerKey);
    return resident &&
      resident.metadata.artifactKey === owner.provenance.prepackedArtifactKey &&
      resident.metadata.genomeIdentity === owner.provenance.genomeIdentity &&
      resident.metadata.genomeLengthBp === owner.provenance.genomeLengthBp &&
      resident.metadata.trackType.toLocaleLowerCase() === owner.manifest.trackId.toLocaleLowerCase()
      ? resident
      : null;
  }
  return prepackedAnnotationSceneResidentForTrack(host, trackId);
}

export function compiledBroadSurfaceOwnerRosterForTheme(
  host: CompiledBroadInteractionResidentHost,
  requestedLayerTypes: readonly string[],
  requestedThemeMode: 'light' | 'dark'
): Array<{
  trackId: string;
  currentOwner: CompiledBroadSurfaceTrackOwnerV2 | null;
  candidateOwner: CompiledBroadSurfaceTrackOwnerV2 | null;
  owner: CompiledBroadSurfaceTrackOwnerV2 | null;
}> {
  const ownerRoster = [...new Set(requestedLayerTypes)].map((trackId) => ({
    trackId,
    currentOwner: host.compiledBroadSurfaceOwnerForTrack(trackId),
    registeredCandidateOwner: host.compiledBroadSurfaceCandidateOwnerForTrack(trackId),
  }));
  const rosterHasExplicitThemeAuthority = ownerRoster.some(
    ({ currentOwner, registeredCandidateOwner }) =>
      currentOwner?.provenance.themeMode != null ||
      registeredCandidateOwner?.provenance.themeMode != null
  );
  return ownerRoster.map(({ trackId, currentOwner, registeredCandidateOwner }) => ({
    trackId,
    ...selectCompiledBroadThemeOwner<CompiledBroadSurfaceTrackOwnerV2>({
      requestedThemeMode,
      rosterHasExplicitThemeAuthority,
      currentOwner,
      registeredCandidateOwner,
    }),
  }));
}

export function isCompiledBroadSurfaceDemandRefreshRequired(
  host: CompiledBroadInteractionResidentHost,
  policy: AnnotationPolicyGpuRuntimeV1,
  manifestFingerprint: string
): boolean {
  const owner = host.compiledBroadSurfaceAdmissionOwner(manifestFingerprint);
  const hasCurrentOwner = Boolean(
    owner && host.compiledBroadSurfaceProvenanceIsCurrent(owner.manifest, owner.provenance)
  );
  const camera = host.compiledBroadSurfaceLastCameraRequest;
  const requirement = host.compiledBroadSurfaceRequirement;
  const detailStillOwnsLatestCamera = Boolean(
    camera && requirement && !compiledBroadSurfaceRequirementOwnsCamera({ requirement, ...camera })
  );
  const readyDetail = host.compiledBroadSurfaceReadyDetailDemands.get(manifestFingerprint);
  const currentDetail = owner
    ? (
        host.prepackedAnnotationSceneReplacementCandidates.get(
          owner.provenance.prepackedOwnerKey
        ) ?? host.prepackedAnnotationSceneResidents.get(owner.provenance.prepackedOwnerKey)
      )?.input?.viewportDetail
    : undefined;
  const activePlan = owner?.presenter.activePresentationPlan;
  return isCompiledBroadDemandRefreshRequired({
    policyValid: validatePrepackedAnnotationRuntimePolicy(policy),
    hasCurrentOwner,
    planStatus: host.compiledBroadSurfacePlanStatus,
    detailStillOwnsLatestCamera,
    readyDetailMatchesCurrentLease: Boolean(
      readyDetail?.manifestFingerprint === manifestFingerprint &&
      readyDetail.isoformMode === policy.isoformMode &&
      readyDetail.laneLimit === policy.laneLimit &&
      sameViewportDetailPresentationLease(
        readyDetail.viewportDetail,
        currentDetail as PrepackedViewportDetailLease
      )
    ),
    presenterOwnsCurrentCamera: Boolean(
      owner?.presenter.isPresenting &&
      owner.presenter.activeTopologyCoversLastCamera &&
      activePlan?.manifestFingerprint === manifestFingerprint &&
      activePlan.isoformMode === policy.isoformMode &&
      activePlan.laneLimit === policy.laneLimit
    ),
  });
}

export function recordCompiledBroadSurfaceCameraRequest(
  host: CompiledBroadInteractionResidentHost,
  camera: {
    path: { fwdStrandTop: number };
    state: {
      themeMode?: 'light' | 'dark';
      annotationRolePalette?: AnnotationRolePaletteOverridesV1;
    };
  },
  viewportStartBp: number,
  viewportEndBp: number,
  viewportCssWidthPx: number,
  devicePixelRatio: number,
  viewportCssHeightPx: number
): void {
  host.compiledBroadSurfaceLinearContract.update(camera.path);
  const presentation = host.compiledBroadSurfaceLastPresentationCamera;
  if (presentation) {
    presentation.fwdStrandTop = camera.path.fwdStrandTop;
    presentation.viewportCssWidthPx = viewportCssWidthPx;
    presentation.viewportCssHeightPx = viewportCssHeightPx;
    presentation.themeMode = camera.state.themeMode ?? 'light';
    presentation.rolePalette = camera.state.annotationRolePalette;
  } else {
    host.compiledBroadSurfaceLastPresentationCamera = {
      contract: host.compiledBroadSurfaceLinearContract,
      fwdStrandTop: camera.path.fwdStrandTop,
      viewportCssWidthPx,
      viewportCssHeightPx,
      themeMode: camera.state.themeMode ?? 'light',
      rolePalette: camera.state.annotationRolePalette,
    };
  }
  const previous = host.compiledBroadSurfaceLastCameraRequest;
  if (
    !previous ||
    previous.viewportStartBp !== viewportStartBp ||
    previous.viewportEndBp !== viewportEndBp ||
    previous.viewportCssWidthPx !== viewportCssWidthPx ||
    previous.devicePixelRatio !== devicePixelRatio
  ) {
    host.compiledBroadSurfaceCameraEpoch += 1;
    host.compiledBroadSurfaceDemandLeases.clear();
    if (previous) {
      previous.viewportStartBp = viewportStartBp;
      previous.viewportEndBp = viewportEndBp;
      previous.viewportCssWidthPx = viewportCssWidthPx;
      previous.devicePixelRatio = devicePixelRatio;
    } else {
      host.compiledBroadSurfaceLastCameraRequest = {
        viewportStartBp,
        viewportEndBp,
        viewportCssWidthPx,
        devicePixelRatio,
      };
    }
  }
}

export function compiledBroadSurfaceOwnerForTrack(
  host: CompiledBroadInteractionResidentHost,
  trackId: string
): CompiledBroadSurfaceTrackOwnerV2 | null {
  const owners = [...host.compiledBroadSurfaceTrackOwners.values()];
  if (
    host.compiledBroadSurfaceManifest &&
    host.compiledBroadSurfacePresenter &&
    host.compiledBroadSurfaceProvenance
  ) {
    owners.unshift({
      manifest: host.compiledBroadSurfaceManifest,
      provenance: host.compiledBroadSurfaceProvenance,
      presenter: host.compiledBroadSurfacePresenter,
    });
  }
  return findAnnotationTrackIdentity(trackId, owners, (owner) => owner.manifest.trackId);
}

export function compiledBroadSurfaceCandidateOwnerForTrack(
  host: CompiledBroadInteractionResidentHost,
  trackId: string
): CompiledBroadSurfaceTrackOwnerV2 | null {
  const owners = [...host.compiledBroadSurfaceTrackCandidateOwners.values()];
  if (
    host.compiledBroadSurfaceCandidateManifest &&
    host.compiledBroadSurfaceCandidateProvenance &&
    host.compiledBroadSurfaceCandidatePresenter
  ) {
    owners.unshift({
      manifest: host.compiledBroadSurfaceCandidateManifest,
      provenance: host.compiledBroadSurfaceCandidateProvenance,
      presenter: host.compiledBroadSurfaceCandidatePresenter,
    });
  }
  const mapped = findAnnotationTrackIdentity(trackId, owners, (owner) => owner.manifest.trackId);
  if (mapped && host.compiledBroadSurfaceProvenanceIsCurrent(mapped.manifest, mapped.provenance)) {
    return mapped;
  }
  return null;
}

export function compiledBroadSurfacePresentingLayerTypes(
  host: CompiledBroadInteractionResidentHost
): string[] {
  const presentingOwners: CompiledBroadSurfaceTrackOwnerV2[] = [];
  const add = (owner: CompiledBroadSurfaceTrackOwnerV2 | null): void => {
    if (!owner?.presenter.isPresenting) return;
    presentingOwners.push(owner);
  };
  add(
    host.compiledBroadSurfaceManifest &&
      host.compiledBroadSurfacePresenter &&
      host.compiledBroadSurfaceProvenance
      ? {
          manifest: host.compiledBroadSurfaceManifest,
          provenance: host.compiledBroadSurfaceProvenance,
          presenter: host.compiledBroadSurfacePresenter,
        }
      : null
  );
  for (const owner of host.compiledBroadSurfaceTrackOwners.values()) add(owner);

  const ordered = [
    ...host.compiledBroadSurfaceLastCompleteTrackIds,
    ...host.annotationLayerTypesForPresentation(),
    ...presentingOwners.map((owner) => owner.manifest.trackId),
  ];
  const requestedLayerTypes = host.annotationLayerTypesForPresentation();
  const emitted = new Set<string>();
  return ordered.flatMap((trackType) => {
    const presenting = findAnnotationTrackIdentity(
      trackType,
      presentingOwners,
      (owner) => owner.manifest.trackId
    );
    if (!presenting || emitted.has(presenting.manifest.trackId)) return [];
    emitted.add(presenting.manifest.trackId);
    const requestedSpelling = findAnnotationTrackIdentity(
      presenting.manifest.trackId,
      requestedLayerTypes,
      String
    );
    return [requestedSpelling ?? presenting.manifest.trackId];
  });
}

export function evictCompiledBroadAnnotationInteractionResidentsToLimit(
  host: CompiledBroadInteractionResidentHost
): void {
  while (
    host.compiledBroadAnnotationInteractionResidents.size >
    PREPACKED_ANNOTATION_INTERACTION_RESIDENT_OWNER_LIMIT
  ) {
    const residents = [...host.compiledBroadAnnotationInteractionResidents.values()];
    const protectedOwnerKeys = new Set<string>();
    const residentTrackTypes = new Set(residents.map((entry) => entry.metadata.trackType));
    for (const trackType of residentTrackTypes) {
      const candidates = residents.filter((entry) => entry.metadata.trackType === trackType);
      if (candidates.length === 0) continue;
      const compiledOwnerKey =
        host.compiledBroadSurfaceOwnerForTrack(trackType)?.provenance.prepackedOwnerKey;
      const compiledCandidateOwnerKey =
        host.compiledBroadSurfaceCandidateOwnerForTrack(trackType)?.provenance.prepackedOwnerKey;
      const protectedResident = selectProtectedInteractionResident({
        candidates,
        compiledCandidateOwnerKey,
        compiledOwnerKey,
      });
      if (protectedResident) protectedOwnerKeys.add(protectedResident.ownerKey);
    }
    const eviction = pickDisposableCachedResident(residents, protectedOwnerKeys);
    if (!eviction) return;
    host.compiledBroadAnnotationInteractionResidents.delete(eviction.ownerKey);
  }
}
