import {
  ANNOTATION_LANE_TOTAL,
  resolveAnnotationTrackContract,
  type TrackContract,
} from '../shared/lane-contracts';
import type { UnifiedLayout } from '../shared/track-layout';
import { INDEXED_ANNOTATION_COLOR_BASIS_THEME } from '../shared/annotation-runtime-theme';
import { compiledBroadSurfaceRequirementOwnsCamera } from './annotation-compiled-broad-address';
import {
  deriveBroadSurfacePresentationPlanV2,
  type CompiledBroadSurfaceAdmissionProvenanceV1,
  type CompiledBroadSurfaceManifestV2,
} from '../overview/bounded-annotation-broad-surface';
import type {
  CompiledBroadSurfacePixiCameraV2,
  CompiledBroadSurfacePixiPresenterV2,
  StagedCompiledBroadSurfacePixiPresentationV2,
} from '../overview/compiled-broad-surface-pixi-presenter';
import type {
  AnnotationPolicyGpuRuntimeV1,
  AnnotationPolicyGpuTrackLaneMaximaV1,
} from '../overview/annotation-policy-gpu-instances-v1';
import {
  validatePrepackedAnnotationRuntimePolicy,
  type PrepackedAnnotationSceneLoadInput,
  type PrepackedAnnotationSceneMetadata,
  type PrepackedAnnotationSceneStatus,
} from '../overview/prepacked-annotation-scene';
import type {
  PartitionedInstancedTranscriptLayer,
  PartitionedTranscriptPolicyTransactionV1,
} from '../overview/partitioned-instanced-transcript-layer';
import {
  findAnnotationTrackIdentity,
  resolveAnnotationTrackIdentity,
} from '../../../annotation-track-identity';
import type { ViewerRenderContract } from '../overview/viewer-render-contract';
import type { CompiledBroadSurfaceRequirementV1 } from './indexed-compiled-broad-requirement';
import type { CompiledBroadSurfaceTrackOwnerV2 } from './indexed-compiled-broad-frame';
import { pickDisposableCachedResident } from './indexed-prepacked-resident-eviction';
import {
  isCompleteRequestedPolicyAuthorityRoster,
  isPolicyLessResidentBlocking,
  residentHasPolicyPlane,
} from './indexed-prepacked-policy-roster';
import type { AnnotationRolePaletteOverridesV1 } from '../../../annotation-role-palette';

export type PrepackedPolicyThemeOwnerRoster = ReadonlyArray<{
  trackId: string;
  currentOwner: CompiledBroadSurfaceTrackOwnerV2 | null;
  candidateOwner: CompiledBroadSurfaceTrackOwnerV2 | null;
  owner: CompiledBroadSurfaceTrackOwnerV2 | null;
}>;

export type PrepackedPolicyPresentationCamera = {
  contract: ViewerRenderContract;
  fwdStrandTop: number;
  viewportCssWidthPx: number;
  viewportCssHeightPx: number;
  themeMode: 'light' | 'dark';
  rolePalette?: AnnotationRolePaletteOverridesV1;
};

export type PrepackedPolicyCameraRequest = {
  viewportStartBp: number;
  viewportEndBp: number;
  viewportCssWidthPx: number;
  devicePixelRatio: number;
};

export type PrepackedPolicyLastPresentation = {
  viewportStartBp: number;
  viewportEndBp: number;
  contract: ViewerRenderContract;
  viewportWidth: number;
  viewportHeight: number;
  cdsDetail: number;
  themeMode: 'light' | 'dark';
  rolePalette?: AnnotationRolePaletteOverridesV1;
};

export type PrepackedPolicyResident = {
  ownerKey: string;
  lastUsed: number;
  policyGeneration: number;
  viewportDetailPresentationAdmitted: boolean;
  visiblePartitionCount: number;
  visibleInstanceCount: number;
  metadata: Pick<PrepackedAnnotationSceneMetadata, 'trackType' | 'themeMode'>;
  input: Pick<
    PrepackedAnnotationSceneLoadInput,
    'policyProjection' | 'policyGpuInstanceData' | 'submissionBank' | 'submissionFineIndices'
  >;
  policyTrackLaneMaxima: AnnotationPolicyGpuTrackLaneMaximaV1 | null;
  layer: PartitionedInstancedTranscriptLayer;
};

export type PrepackedPolicyHost<
  TResident extends PrepackedPolicyResident = PrepackedPolicyResident,
> = {
  readonly transactionInFlight: boolean;
  readonly activeLayer: PartitionedInstancedTranscriptLayer | null;
  readonly activeInput: TResident['input'] | null;
  readonly activeOwnerKey: string | null;
  readonly requestedLayerTypes: readonly string[];
  readonly lastPresentationCamera: PrepackedPolicyPresentationCamera | null;
  readonly lastCameraRequest: PrepackedPolicyCameraRequest | null;
  readonly requirement: CompiledBroadSurfaceRequirementV1 | null;
  readonly layout: UnifiedLayout | null;
  readonly contract: TrackContract | null;
  readonly runtimePolicy: AnnotationPolicyGpuRuntimeV1 | null;
  readonly policyGeneration: number;
  readonly lastPresentation: PrepackedPolicyLastPresentation | null;
  readonly annotationTrackBaseOffset: number;
  readonly bodyPresentationGeneration: unknown;
  readonly residentsSize: number;
  readonly residentOwnerLimit: number;
  readonly lastCompleteOwnerKeys: readonly string[];
  readonly hasResidentBank: boolean;
  readonly hasCompiledBroadSurface: boolean;
  readonly residents: Iterable<TResident>;
  readonly replacementCandidates: Iterable<TResident>;
  getResident(ownerKey: string): TResident | undefined;
  ownerRosterForTheme(
    requestedLayerTypes: readonly string[],
    requestedThemeMode: 'light' | 'dark'
  ): PrepackedPolicyThemeOwnerRoster;
  provenanceIsCurrent(
    manifest: CompiledBroadSurfaceManifestV2,
    provenance: CompiledBroadSurfaceAdmissionProvenanceV1
  ): boolean;
  candidateRegistrationMatches(owner: CompiledBroadSurfaceTrackOwnerV2): boolean;
  laneStart(
    trackType: string,
    requestedLayerTypes: readonly string[],
    policy: AnnotationPolicyGpuRuntimeV1
  ): number;
  ownerForTrack(trackType: string): CompiledBroadSurfaceTrackOwnerV2 | null;
  candidateOwnerForTrack(trackType: string): CompiledBroadSurfaceTrackOwnerV2 | null;
  stackMaxLane(policy: AnnotationPolicyGpuRuntimeV1): number;
  incrementPlanDerivationCount(): void;
  setTransactionInFlight(value: boolean): void;
  reconcileLaneEnvelope(): void;
  resetAllPresentersToHidden(): void;
  clearImmediateState(): void;
  finalizeCandidateOwner(owner: CompiledBroadSurfaceTrackOwnerV2): void;
  hideCompiledPresenters(): void;
  setLastCompleteOwnerKeys(ownerKeys: readonly string[]): void;
  setStatus(status: PrepackedAnnotationSceneStatus): void;
  setVisibleCounts(partitionCount: number, instanceCount: number): void;
  publishLaneEnvelope(
    maxAnnotationLane: number,
    maxCdsLane: number,
    maxLane: number,
    contract: TrackContract | null
  ): void;
  setRuntimePolicy(policy: AnnotationPolicyGpuRuntimeV1 | null): void;
  setPolicyGeneration(generation: number): void;
  clearIdentityCaches(): void;
  clearViewportSelectionCache(): void;
  noteBodyPresentationCommit(input: { orderedVisibleTrackIds: readonly string[] }): void;
  bumpResidentClock(): number;
  publishActiveOwner(resident: TResident): void;
  markInteractionCouplingValidated(): void;
  bumpOwnerGeneration(): void;
  destroyResident(
    ownerKey: string,
    status: PrepackedAnnotationSceneStatus,
    recordOwnerChange?: boolean
  ): void;
  removeLayerFromScene(layer: PartitionedInstancedTranscriptLayer): void;
  retireLayer(layer: PartitionedInstancedTranscriptLayer): void;
  destroyLayer(layer: PartitionedInstancedTranscriptLayer): void;
  clearResidentBank(): void;
  bumpResidentGeneration(): void;
  clearActiveOwner(): void;
  setLastPresentation(presentation: PrepackedPolicyLastPresentation | null): void;
  setCouplingValidated(value: boolean): void;
};

function shouldRejectAnnotationPolicyAdmission(args: {
  hasBlockingPolicyLessResident: boolean;
  hasAnyOwnerSurface: boolean;
  prepackedPolicyReady: boolean;
}): boolean {
  if (args.hasBlockingPolicyLessResident) return true;
  return args.hasAnyOwnerSurface && !args.prepackedPolicyReady;
}

function acknowledgePublishedAnnotationPolicy<TResident extends PrepackedPolicyResident>(args: {
  completeRequestedPolicyAuthorityRoster: boolean;
  requestedPolicyResidents: Array<TResident | null>;
  policy: AnnotationPolicyGpuRuntimeV1;
  policyGeneration: number;
  reconcileLaneEnvelope: () => void;
}): boolean | 'deferred' {
  try {
    if (!args.completeRequestedPolicyAuthorityRoster) return 'deferred';
    if (
      args.requestedPolicyResidents.some((resident) => {
        if (!resident) return false;
        const runtime = resident.layer.getAnnotationPolicyDebug().runtime;
        return (
          runtime?.isoformMode !== args.policy.isoformMode ||
          runtime?.laneLimit !== args.policy.laneLimit ||
          resident.policyGeneration !== args.policyGeneration
        );
      })
    ) {
      return false;
    }
    args.reconcileLaneEnvelope();
    return true;
  } catch {
    return false;
  }
}

type StagedCompiledBroadRosterCommit = Readonly<{
  owner: CompiledBroadSurfaceTrackOwnerV2;
  presenter: CompiledBroadSurfacePixiPresenterV2;
  receipt: StagedCompiledBroadSurfacePixiPresentationV2;
  camera: CompiledBroadSurfacePixiCameraV2;
}>;

function stageCompiledBroadSurfaceRoster<TResident extends PrepackedPolicyResident>(args: {
  host: PrepackedPolicyHost<TResident>;
  policy: AnnotationPolicyGpuRuntimeV1;
  camera: PrepackedPolicyCameraRequest | null;
  requirementOwnsCamera: boolean;
  completeCompiledRoster: boolean;
  ownerByRequestedTrack: ReadonlyArray<{
    trackType: string;
    owner: CompiledBroadSurfaceTrackOwnerV2 | null;
  }>;
  requestedCompiledTrackTypes: readonly string[];
  presentationCamera: PrepackedPolicyPresentationCamera | null;
}): {
  commits: StagedCompiledBroadRosterCommit[];
  discard: () => void;
  aborted: boolean;
} {
  const commits: StagedCompiledBroadRosterCommit[] = [];
  const discard = (): void => {
    for (const commit of commits) {
      commit.presenter.discardStagedPresentation(commit.receipt);
    }
    commits.length = 0;
  };
  const { host, policy, camera, presentationCamera } = args;
  if (
    !camera ||
    !args.requirementOwnsCamera ||
    !args.completeCompiledRoster ||
    !host.layout ||
    !presentationCamera
  ) {
    return { commits, discard, aborted: false };
  }
  let rosterReady = true;
  for (const { trackType, owner: nullableOwner } of args.ownerByRequestedTrack) {
    const owner = nullableOwner!;
    const { manifest, provenance, presenter } = owner;
    if (!host.provenanceIsCurrent(manifest, provenance)) {
      discard();
      return { commits, discard, aborted: true };
    }
    let plan;
    try {
      host.incrementPlanDerivationCount();
      plan = deriveBroadSurfacePresentationPlanV2({
        manifest,
        isoformMode: policy.isoformMode,
        laneLimit: policy.laneLimit,
        ...camera,
      });
    } catch {
      discard();
      return { commits, discard, aborted: true };
    }
    if (plan.status !== 'broad-ready') {
      discard();
      return { commits, discard, aborted: true };
    }
    const staged = presenter.stagePresentation(plan);
    if (staged.status === 'missing-cells') {
      rosterReady = false;
      break;
    }
    if (staged.status !== 'staged') {
      discard();
      return { commits, discard, aborted: true };
    }
    const laneStart = host.laneStart(trackType, args.requestedCompiledTrackTypes, policy);
    commits.push({
      owner,
      presenter,
      receipt: staged.receipt,
      camera: {
        plan,
        contract: presentationCamera.contract,
        trackTopCssPx:
          presentationCamera.fwdStrandTop +
          host.layout.annotationOffset -
          manifest.laneRowCssHeightPx / 2 -
          laneStart * manifest.laneRowCssHeightPx,
        viewportCssWidthPx: presentationCamera.viewportCssWidthPx,
        viewportCssHeightPx: presentationCamera.viewportCssHeightPx,
        themeMode: presentationCamera.themeMode,
        rolePalette: presentationCamera.rolePalette,
      },
    });
  }
  if (!rosterReady || commits.length !== args.ownerByRequestedTrack.length) {
    discard();
  }
  return { commits, discard, aborted: false };
}

function beginResidentAnnotationPolicyTransactions<
  TResident extends PrepackedPolicyResident,
>(args: {
  policyResidents: TResident[];
  policy: AnnotationPolicyGpuRuntimeV1;
  policyTransactions: Array<{
    resident: TResident;
    receipt: PartitionedTranscriptPolicyTransactionV1;
  }>;
}): boolean {
  try {
    for (const resident of args.policyResidents) {
      const receipt = resident.layer.beginAnnotationPolicyTransaction(args.policy);
      if (!receipt) return false;
      args.policyTransactions.push({ resident, receipt });
    }
    if (
      args.policyTransactions.some(
        ({ resident, receipt }) => !resident.layer.canCommitAnnotationPolicyTransaction(receipt)
      )
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function applyVectorFallbackPresentation<TResident extends PrepackedPolicyResident>(args: {
  host: PrepackedPolicyHost<TResident>;
  policy: AnnotationPolicyGpuRuntimeV1;
  requestedAnnotationTrackTypes: readonly string[];
  requestedPolicyResidents: Array<TResident | null>;
}): { visiblePartitionCount: number; visibleInstanceCount: number } {
  const { host, policy, requestedAnnotationTrackTypes } = args;
  const lastPresentation = host.lastPresentation!;
  const fallbackResidents = args.requestedPolicyResidents as TResident[];
  host.resetAllPresentersToHidden();
  host.clearImmediateState();
  let visiblePartitionCount = 0;
  let visibleInstanceCount = 0;
  for (const resident of fallbackResidents) {
    const submissions = resident.layer.updateVisibleRange(
      lastPresentation.viewportStartBp,
      lastPresentation.viewportEndBp
    );
    const laneStart = host.laneStart(
      resident.metadata.trackType,
      requestedAnnotationTrackTypes,
      policy
    );
    const laneRowCssHeightPx =
      host.ownerForTrack(resident.metadata.trackType)?.manifest.laneRowCssHeightPx ??
      ANNOTATION_LANE_TOTAL;
    resident.layer.updateCamera(
      lastPresentation.contract,
      lastPresentation.viewportWidth,
      lastPresentation.viewportHeight,
      lastPresentation.cdsDetail,
      host.annotationTrackBaseOffset - laneStart * laneRowCssHeightPx,
      lastPresentation.themeMode,
      lastPresentation.rolePalette
    );
    resident.visiblePartitionCount = submissions.length;
    resident.visibleInstanceCount = submissions.reduce(
      (count, partition) => count + partition.instanceCount,
      0
    );
    visiblePartitionCount += resident.visiblePartitionCount;
    visibleInstanceCount += resident.visibleInstanceCount;
    resident.layer.show();
  }
  host.setLastCompleteOwnerKeys(Object.freeze(fallbackResidents.map(({ ownerKey }) => ownerKey)));
  host.setStatus('eligible');
  return { visiblePartitionCount, visibleInstanceCount };
}

function collectRequestedAnnotationPolicyRoster<TResident extends PrepackedPolicyResident>(
  host: PrepackedPolicyHost<TResident>
): {
  allResidents: TResident[];
  policyResidents: TResident[];
  requestedAnnotationTrackTypes: readonly string[];
  requestedPolicyResidents: Array<TResident | null>;
  requestedResidentTrackTypes: Set<string>;
  completePolicyResidentRoster: boolean;
  prepackedPolicyReady: boolean;
  activeLayer: PrepackedPolicyHost<TResident>['activeLayer'];
  activeInput: PrepackedPolicyHost<TResident>['activeInput'];
  activeResident: TResident | null;
} {
  const activeLayer = host.activeLayer;
  const activeInput = host.activeInput;
  const activeResident = host.activeOwnerKey
    ? (host.getResident(host.activeOwnerKey) ?? null)
    : null;
  const allResidents = [...host.residents, ...host.replacementCandidates];
  const policyResidents = allResidents.filter(residentHasPolicyPlane);
  const requestedAnnotationTrackTypes = host.requestedLayerTypes;
  const requestedPolicyResidents = requestedAnnotationTrackTypes.map((trackType) =>
    findAnnotationTrackIdentity(
      trackType,
      policyResidents,
      (resident) => resident.metadata.trackType
    )
  );
  const requestedResidentTrackTypes = new Set(
    requestedAnnotationTrackTypes.flatMap((trackType) => {
      const resident = findAnnotationTrackIdentity(
        trackType,
        allResidents,
        (candidate) => candidate.metadata.trackType
      );
      return resident ? [resident.metadata.trackType] : [];
    })
  );
  return {
    allResidents,
    policyResidents,
    requestedAnnotationTrackTypes,
    requestedPolicyResidents,
    requestedResidentTrackTypes,
    completePolicyResidentRoster:
      requestedPolicyResidents.length > 0 &&
      requestedPolicyResidents.every((resident): resident is TResident => resident !== null),
    prepackedPolicyReady: policyResidents.length > 0,
    activeLayer,
    activeInput,
    activeResident,
  };
}

function resolveNextAnnotationLaneEnvelope<TResident extends PrepackedPolicyResident>(params: {
  host: PrepackedPolicyHost<TResident>;
  policy: AnnotationPolicyGpuRuntimeV1;
  compiledVisualReady: boolean;
  compiledPolicyOwners: CompiledBroadSurfaceTrackOwnerV2[];
  policyResidents: TResident[];
}): {
  nextMaxAnnotationLane: number;
  nextMaxCdsLane: number;
  nextMaxLane: number;
  nextContract: TrackContract | null;
} | null {
  const { host, policy, compiledVisualReady, compiledPolicyOwners, policyResidents } = params;
  const stackMaxAnnotationLane = host.stackMaxLane(policy);
  const nextMaxAnnotationLane =
    stackMaxAnnotationLane >= 0
      ? stackMaxAnnotationLane
      : policy.laneLimit === null
        ? compiledVisualReady
          ? compiledPolicyOwners[0]!.manifest.laneRowCounts[policy.isoformMode] - 1
          : policyResidents[0]!.policyTrackLaneMaxima![policy.isoformMode]
        : policy.laneLimit - 1;
  const nextMaxCdsLane = -1;
  const nextMaxLane = Math.max(nextMaxAnnotationLane, nextMaxCdsLane);
  let nextContract = host.contract;
  try {
    if (host.layout) {
      nextContract = resolveAnnotationTrackContract({
        layout: host.layout,
        maxAnnotationLane: nextMaxAnnotationLane,
        maxCdsLane: nextMaxCdsLane,
      });
    }
  } catch {
    return null;
  }
  return { nextMaxAnnotationLane, nextMaxCdsLane, nextMaxLane, nextContract };
}

function commitAnnotationPolicyGeneration<TResident extends PrepackedPolicyResident>(params: {
  host: PrepackedPolicyHost<TResident>;
  policy: AnnotationPolicyGpuRuntimeV1;
  allResidents: TResident[];
  policyResidents: TResident[];
  requestedAnnotationTrackTypes: readonly string[];
  requestedPolicyResidents: Array<TResident | null>;
  prepackedPolicyReady: boolean;
  completePolicyResidentRoster: boolean;
  requirementOwnsCamera: boolean;
  compiledThemeOwnerRoster: PrepackedPolicyThemeOwnerRoster;
  ownerByRequestedTrack: Array<{
    trackType: string;
    owner: CompiledBroadSurfaceTrackOwnerV2 | null;
  }>;
  broadCommits: StagedCompiledBroadRosterCommit[];
  discardBroadCommits: () => void;
  nextMaxAnnotationLane: number;
  nextMaxCdsLane: number;
  nextMaxLane: number;
  nextContract: TrackContract | null;
}): boolean {
  const {
    host,
    policy,
    allResidents,
    policyResidents,
    requestedAnnotationTrackTypes,
    requestedPolicyResidents,
    prepackedPolicyReady,
    completePolicyResidentRoster,
    requirementOwnsCamera,
    compiledThemeOwnerRoster,
    ownerByRequestedTrack,
    broadCommits,
    discardBroadCommits,
    nextMaxAnnotationLane,
    nextMaxCdsLane,
    nextMaxLane,
    nextContract,
  } = params;
  const changed =
    host.runtimePolicy?.isoformMode !== policy.isoformMode ||
    host.runtimePolicy?.laneLimit !== policy.laneLimit;
  const nextPolicyGeneration = changed ? host.policyGeneration + 1 : host.policyGeneration;
  let broadRosterCommitted = false;
  host.setTransactionInFlight(true);
  try {
    const policyTransactions: Array<{
      resident: TResident;
      receipt: PartitionedTranscriptPolicyTransactionV1;
    }> = [];
    const abortPolicyTransactions = (): false => {
      for (let index = policyTransactions.length - 1; index >= 0; index -= 1) {
        const transaction = policyTransactions[index];
        transaction.resident.layer.rollbackAnnotationPolicyTransaction(transaction.receipt);
      }
      discardBroadCommits();
      return false;
    };
    if (prepackedPolicyReady) {
      const begun = beginResidentAnnotationPolicyTransactions({
        policyResidents,
        policy,
        policyTransactions,
      });
      if (!begun) return abortPolicyTransactions();
    }
    if (
      broadCommits.some(
        ({ presenter, receipt, camera: broadCamera }) =>
          !presenter.canCommitStagedPresentation(receipt, broadCamera)
      )
    ) {
      return abortPolicyTransactions();
    }
    const broadCandidatePromotions = broadCommits
      .map(({ owner }) => owner)
      .filter((owner) => host.candidateRegistrationMatches(owner));
    const requestedCandidateCount = compiledThemeOwnerRoster.filter(
      ({ owner, candidateOwner }) => owner !== null && owner === candidateOwner
    ).length;
    if (broadCandidatePromotions.length !== requestedCandidateCount) {
      return abortPolicyTransactions();
    }
    if (broadCommits.length > 0) host.resetAllPresentersToHidden();
    for (const commit of broadCommits) {
      commit.presenter.commitStagedPresentation(commit.receipt, commit.camera);
    }
    broadRosterCommitted = broadCommits.length === ownerByRequestedTrack.length;
    if (broadRosterCommitted) {
      for (const resident of allResidents) {
        resident.layer.hide();
      }
      host.clearImmediateState();
      for (const owner of broadCandidatePromotions) {
        host.finalizeCandidateOwner(owner);
      }
    } else {
      host.hideCompiledPresenters();
    }
    let visiblePartitionCount = 0;
    let visibleInstanceCount = 0;
    for (const transaction of policyTransactions) {
      transaction.resident.layer.commitAnnotationPolicyTransaction(transaction.receipt);
      const directSubmission = transaction.receipt.submission;
      if (directSubmission.directBankEnabled) {
        transaction.resident.visiblePartitionCount = directSubmission.visibleDrawCount;
        transaction.resident.visibleInstanceCount = directSubmission.actualSubmittedInstanceCount;
      }
      transaction.resident.policyGeneration = nextPolicyGeneration;
      visiblePartitionCount += transaction.resident.visiblePartitionCount;
      visibleInstanceCount += transaction.resident.visibleInstanceCount;
    }
    if (
      !broadRosterCommitted &&
      requirementOwnsCamera &&
      completePolicyResidentRoster &&
      host.lastPresentation !== null
    ) {
      const fallbackCounts = applyVectorFallbackPresentation({
        host,
        policy,
        requestedAnnotationTrackTypes,
        requestedPolicyResidents,
      });
      visiblePartitionCount = fallbackCounts.visiblePartitionCount;
      visibleInstanceCount = fallbackCounts.visibleInstanceCount;
    }
    if (policyTransactions.length > 0) {
      host.setVisibleCounts(visiblePartitionCount, visibleInstanceCount);
    }
    host.publishLaneEnvelope(nextMaxAnnotationLane, nextMaxCdsLane, nextMaxLane, nextContract);
    host.setRuntimePolicy({ ...policy });
    if (changed) {
      host.setPolicyGeneration(nextPolicyGeneration);
      host.clearIdentityCaches();
      host.clearViewportSelectionCache();
    }
    if (changed || host.bodyPresentationGeneration === null) {
      host.noteBodyPresentationCommit({
        orderedVisibleTrackIds: requestedAnnotationTrackTypes,
      });
    }
    return true;
  } finally {
    host.setTransactionInFlight(false);
  }
}

export function applyAnnotationPresentationPolicy<TResident extends PrepackedPolicyResident>(
  host: PrepackedPolicyHost<TResident>,
  policy: AnnotationPolicyGpuRuntimeV1
): boolean | 'deferred' {
  if (!validatePrepackedAnnotationRuntimePolicy(policy) || host.transactionInFlight) {
    return false;
  }
  const roster = collectRequestedAnnotationPolicyRoster(host);
  const {
    allResidents,
    policyResidents,
    requestedAnnotationTrackTypes,
    requestedPolicyResidents,
    requestedResidentTrackTypes,
    completePolicyResidentRoster,
    prepackedPolicyReady,
    activeLayer,
    activeInput,
    activeResident,
  } = roster;
  if (
    shouldRejectAnnotationPolicyAdmission({
      hasBlockingPolicyLessResident: allResidents.some((resident) =>
        isPolicyLessResidentBlocking({
          hasPolicyPlane: residentHasPolicyPlane(resident),
          isActiveLayer: resident.layer === activeLayer,
          isRequestedTrack: requestedResidentTrackTypes.has(resident.metadata.trackType),
        })
      ),
      hasAnyOwnerSurface: Boolean(
        activeLayer || activeInput || activeResident || policyResidents.length > 0
      ),
      prepackedPolicyReady,
    })
  ) {
    return false;
  }
  const requestedCompiledTrackTypes = requestedAnnotationTrackTypes;
  const presentationCamera = host.lastPresentationCamera;
  const requestedThemeMode = INDEXED_ANNOTATION_COLOR_BASIS_THEME;
  const compiledThemeOwnerRoster = host.ownerRosterForTheme(
    requestedCompiledTrackTypes,
    requestedThemeMode
  );
  const compiledPolicyOwnerByRequestedTrack = compiledThemeOwnerRoster.map(({ owner }) => owner);
  const compiledPolicyOwners = compiledPolicyOwnerByRequestedTrack
    .filter((owner): owner is CompiledBroadSurfaceTrackOwnerV2 => owner !== null)
    .filter(
      (owner, index, owners) =>
        owners.findIndex(
          (candidate) =>
            candidate.manifest.manifestFingerprint === owner.manifest.manifestFingerprint
        ) === index
    );
  const compiledVisualReady = compiledPolicyOwners.some(({ manifest, provenance }) =>
    host.provenanceIsCurrent(manifest, provenance)
  );
  const policyAlreadyPublished =
    host.runtimePolicy?.isoformMode === policy.isoformMode &&
    host.runtimePolicy?.laneLimit === policy.laneLimit;
  const completeRequestedPolicyAuthorityRoster = isCompleteRequestedPolicyAuthorityRoster({
    requestedPolicyPresent: requestedPolicyResidents.map((resident) => resident !== null),
    compiledOwnerCurrent: compiledPolicyOwnerByRequestedTrack.map((owner) =>
      Boolean(owner && host.provenanceIsCurrent(owner.manifest, owner.provenance))
    ),
  });
  if (requestedAnnotationTrackTypes.length > 0 && !prepackedPolicyReady && !compiledVisualReady) {
    return false;
  }
  if (policyAlreadyPublished) {
    return acknowledgePublishedAnnotationPolicy({
      completeRequestedPolicyAuthorityRoster,
      requestedPolicyResidents,
      policy,
      policyGeneration: host.policyGeneration,
      reconcileLaneEnvelope: () => host.reconcileLaneEnvelope(),
    });
  }

  if (requestedAnnotationTrackTypes.length === 0) return false;

  const laneEnvelope = resolveNextAnnotationLaneEnvelope({
    host,
    policy,
    compiledVisualReady,
    compiledPolicyOwners,
    policyResidents,
  });
  if (!laneEnvelope) return false;

  const camera = host.lastCameraRequest;
  const requirement = host.requirement;
  const requirementOwnsCamera = Boolean(
    camera && requirement && compiledBroadSurfaceRequirementOwnsCamera({ requirement, ...camera })
  );
  const ownerByRequestedTrack = compiledThemeOwnerRoster.map(({ trackId, owner }) => ({
    trackType: trackId,
    owner,
  }));
  const completeCompiledRoster =
    ownerByRequestedTrack.length > 0 && ownerByRequestedTrack.every(({ owner }) => owner !== null);
  const stagedBroadRoster = stageCompiledBroadSurfaceRoster({
    host,
    policy,
    camera,
    requirementOwnsCamera,
    completeCompiledRoster,
    ownerByRequestedTrack,
    requestedCompiledTrackTypes,
    presentationCamera,
  });
  if (stagedBroadRoster.aborted) return false;
  const { commits: broadCommits, discard: discardBroadCommits } = stagedBroadRoster;
  const vectorFallbackReady = completePolicyResidentRoster && host.lastPresentation !== null;
  if (requirementOwnsCamera && broadCommits.length === 0 && !vectorFallbackReady) {
    return 'deferred';
  }

  return commitAnnotationPolicyGeneration({
    host,
    policy,
    allResidents,
    policyResidents,
    requestedAnnotationTrackTypes,
    requestedPolicyResidents,
    prepackedPolicyReady,
    completePolicyResidentRoster,
    requirementOwnsCamera,
    compiledThemeOwnerRoster,
    ownerByRequestedTrack,
    broadCommits,
    discardBroadCommits,
    ...laneEnvelope,
  });
}

export function activatePrepackedAnnotationScene<TResident extends PrepackedPolicyResident>(
  host: PrepackedPolicyHost<TResident>,
  ownerKey: string
): boolean {
  const resident = host.getResident(ownerKey);
  if (
    !resident ||
    !resident.layer.isGpuPrepared ||
    resident.policyGeneration !== host.policyGeneration
  ) {
    return false;
  }
  activatePrepackedAnnotationSceneResident(host, resident);
  return true;
}

export function activatePrepackedAnnotationSceneResident<TResident extends PrepackedPolicyResident>(
  host: PrepackedPolicyHost<TResident>,
  resident: TResident
): void {
  resident.lastUsed = host.bumpResidentClock();
  const alreadyActive =
    host.activeLayer === resident.layer && host.activeOwnerKey === resident.ownerKey;
  if (alreadyActive) {
    host.setStatus('eligible');
    return;
  }

  host.publishActiveOwner(resident);
  if (host.runtimePolicy && resident.policyTrackLaneMaxima) {
    host.reconcileLaneEnvelope();
  }
  host.markInteractionCouplingValidated();
  host.clearIdentityCaches();
  host.setVisibleCounts(resident.visiblePartitionCount, resident.visibleInstanceCount);
  host.bumpOwnerGeneration();
  host.setStatus('eligible');
}

export function evictPrepackedAnnotationSceneResidentsToLimit<
  TResident extends PrepackedPolicyResident,
>(host: PrepackedPolicyHost<TResident>): void {
  while (host.residentsSize > host.residentOwnerLimit) {
    const protectedOwnerKeys = new Set<string>();
    for (const ownerKey of host.lastCompleteOwnerKeys) {
      protectedOwnerKeys.add(ownerKey);
    }
    if (host.activeOwnerKey) {
      protectedOwnerKeys.add(host.activeOwnerKey);
    }
    for (const trackType of host.requestedLayerTypes) {
      const residents = [...host.residents];
      const identity = resolveAnnotationTrackIdentity(
        trackType,
        residents,
        (entry) => entry.metadata.trackType
      );
      if (identity.status !== 'matched') continue;
      const candidates = residents.filter(
        (entry) => entry.metadata.trackType === identity.value.metadata.trackType
      );
      if (candidates.length === 0) continue;
      const compiledOwnerKey = host.ownerForTrack(trackType)?.provenance.prepackedOwnerKey;
      const compiledCandidateOwnerKey =
        host.candidateOwnerForTrack(trackType)?.provenance.prepackedOwnerKey;
      const candidatesByTheme = new Map<
        PrepackedAnnotationSceneMetadata['themeMode'],
        TResident[]
      >();
      for (const candidate of candidates) {
        const themeCandidates = candidatesByTheme.get(candidate.metadata.themeMode);
        if (themeCandidates) themeCandidates.push(candidate);
        else candidatesByTheme.set(candidate.metadata.themeMode, [candidate]);
      }
      for (const themeCandidates of candidatesByTheme.values()) {
        const protectedResident =
          themeCandidates.find((entry) => entry.ownerKey === compiledCandidateOwnerKey) ??
          themeCandidates.find((entry) => entry.ownerKey === compiledOwnerKey) ??
          themeCandidates.find((entry) => entry.layer.isPresenting) ??
          themeCandidates.find((entry) => entry.ownerKey === host.activeOwnerKey) ??
          [...themeCandidates].sort(
            (left, right) =>
              right.lastUsed - left.lastUsed || left.ownerKey.localeCompare(right.ownerKey)
          )[0];
        if (protectedResident) protectedOwnerKeys.add(protectedResident.ownerKey);
      }
    }
    const eviction = pickDisposableCachedResident([...host.residents], protectedOwnerKeys);
    if (!eviction) return;
    host.destroyResident(eviction.ownerKey, 'not-loaded', false);
  }
}

export function disposePrepackedAnnotationSceneLayer(
  host: PrepackedPolicyHost,
  layer: PartitionedInstancedTranscriptLayer,
  wasLastComplete: boolean
): void {
  const canStillBeNamedByPresentedInstructions = wasLastComplete || layer.isPresenting;
  layer.hide();
  host.removeLayerFromScene(layer);
  if (canStillBeNamedByPresentedInstructions) {
    host.retireLayer(layer);
    return;
  }
  host.destroyLayer(layer);
}

export function disposePrepackedAnnotationScene<TResident extends PrepackedPolicyResident>(
  host: PrepackedPolicyHost<TResident>,
  status: PrepackedAnnotationSceneStatus,
  recordOwnerChange = true
): void {
  const hadActiveOwner =
    host.activeLayer !== null || host.activeInput !== null || host.activeOwnerKey !== null;
  const hadResidentBank = host.hasResidentBank;
  const lastCompleteOwnerKeys = new Set(host.lastCompleteOwnerKeys);
  const destroyedLayers = new Set<PartitionedInstancedTranscriptLayer>();
  for (const resident of host.residents) {
    disposePrepackedAnnotationSceneLayer(
      host,
      resident.layer,
      lastCompleteOwnerKeys.has(resident.ownerKey)
    );
    destroyedLayers.add(resident.layer);
  }
  for (const resident of host.replacementCandidates) {
    disposePrepackedAnnotationSceneLayer(host, resident.layer, false);
    destroyedLayers.add(resident.layer);
  }
  host.clearResidentBank();
  if (hadResidentBank) host.bumpResidentGeneration();
  host.setLastCompleteOwnerKeys(Object.freeze([]));
  const layer = host.activeLayer;
  if (layer && !destroyedLayers.has(layer)) {
    disposePrepackedAnnotationSceneLayer(host, layer, layer.isPresenting);
  }
  host.clearActiveOwner();
  if (!host.hasCompiledBroadSurface) {
    host.setRuntimePolicy(null);
  }
  host.setCouplingValidated(false);
  host.clearIdentityCaches();
  host.setLastPresentation(null);
  if (recordOwnerChange && hadActiveOwner) {
    host.bumpOwnerGeneration();
  }
  host.setVisibleCounts(0, 0);
  host.setStatus(status);
  host.reconcileLaneEnvelope();
}

export type PrepackedPolicyOverlayBindings<
  TResident extends PrepackedPolicyResident = PrepackedPolicyResident,
> = {
  prepackedAnnotationPolicyTransactionInFlight: boolean;
  prepackedAnnotationSceneLayer: PartitionedInstancedTranscriptLayer | null;
  prepackedAnnotationSceneInput: TResident['input'] | null;
  prepackedAnnotationSceneOwnerKey: string | null;
  prepackedAnnotationSceneOwnerMetadata: TResident['metadata'] | null;
  compiledBroadSurfaceLastPresentationCamera: PrepackedPolicyPresentationCamera | null;
  compiledBroadSurfaceLastCameraRequest: PrepackedPolicyCameraRequest | null;
  compiledBroadSurfaceRequirement: CompiledBroadSurfaceRequirementV1 | null;
  _layout: UnifiedLayout | null;
  _contract: TrackContract | null;
  prepackedAnnotationRuntimePolicy: AnnotationPolicyGpuRuntimeV1 | null;
  prepackedAnnotationPolicyGeneration: number;
  prepackedAnnotationSceneLastPresentation: PrepackedPolicyLastPresentation | null;
  annotationBodyPresentationGeneration: unknown;
  prepackedAnnotationSceneResidents: {
    readonly size: number;
    values(): Iterable<TResident>;
    get(ownerKey: string): TResident | undefined;
    clear(): void;
  };
  prepackedAnnotationSceneReplacementCandidates: {
    values(): Iterable<TResident>;
    clear(): void;
  };
  prepackedAnnotationSceneLastCompleteOwnerKeys: readonly string[];
  compiledBroadSurfaceManifest: unknown;
  compiledBroadSurfaceCandidateManifest: unknown;
  compiledBroadSurfaceTrackOwners: {
    readonly size: number;
    values(): Iterable<{ presenter: { hide(): void } }>;
  };
  compiledBroadSurfaceTrackCandidateOwners: {
    readonly size: number;
    values(): Iterable<{ presenter: { hide(): void } }>;
  };
  compiledBroadSurfacePlanDerivationCount: number;
  compiledBroadSurfacePresenter: { hide(): void } | null;
  compiledBroadSurfaceCandidatePresenter: { hide(): void } | null;
  maxAnnotationLane: number;
  maxCdsLane: number;
  maxLane: number;
  prepackedCanonicalRendererIdCache: { clear(): void };
  prepackedResidentPolicyFeatureIndexCache: { clear(): void };
  residentAnnotationViewportSelectionCache: unknown;
  prepackedAnnotationSceneResidentClock: number;
  prepackedAnnotationInteractionVisualCouplingValidated: boolean;
  prepackedAnnotationSceneOwnerGeneration: number;
  retiredPrepackedAnnotationSceneLayers: Map<PartitionedInstancedTranscriptLayer, number>;
  prepackedAnnotationSceneLayerDestroys: number;
  prepackedAnnotationSceneResidentGeneration: number;
  prepackedAnnotationSceneStatus: PrepackedAnnotationSceneStatus;
  prepackedAnnotationSceneVisiblePartitionCount: number;
  prepackedAnnotationSceneVisibleInstanceCount: number;
  container: {
    children: { readonly length: number };
    removeChild(child: unknown): void;
  };
  annotationLayerTypesForPresentation(): readonly string[];
  prepackedAnnotationTrackBaseOffsetPx(): number | null;
  compiledBroadSurfaceOwnerRosterForTheme(
    requestedLayerTypes: readonly string[],
    requestedThemeMode: 'light' | 'dark'
  ): PrepackedPolicyThemeOwnerRoster;
  compiledBroadSurfaceProvenanceIsCurrent(
    manifest: CompiledBroadSurfaceManifestV2,
    provenance: CompiledBroadSurfaceAdmissionProvenanceV1
  ): boolean;
  compiledBroadSurfaceCandidateRegistrationMatches(
    owner: CompiledBroadSurfaceTrackOwnerV2
  ): boolean;
  compiledBroadSurfaceLaneStart(
    trackType: string,
    requestedLayerTypes: readonly string[],
    policy: AnnotationPolicyGpuRuntimeV1
  ): number;
  compiledBroadSurfaceOwnerForTrack(trackType: string): CompiledBroadSurfaceTrackOwnerV2 | null;
  compiledBroadSurfaceCandidateOwnerForTrack(
    trackType: string
  ): CompiledBroadSurfaceTrackOwnerV2 | null;
  annotationTrackStackMaxLane(policy: AnnotationPolicyGpuRuntimeV1): number;
  reconcileAnnotationLaneEnvelopeAuthority(): void;
  resetAllPresentersToHidden(): void;
  clearImmediateStateForCompiledAnnotationOwner(): void;
  finalizeCompiledBroadSurfaceCandidateOwner(owner: CompiledBroadSurfaceTrackOwnerV2): void;
  noteAnnotationBodyPresentationCommit(input: { orderedVisibleTrackIds: readonly string[] }): void;
  destroyPrepackedAnnotationSceneResident(
    ownerKey: string,
    status: PrepackedAnnotationSceneStatus,
    recordOwnerChange: boolean
  ): void;
};

const PREPACKED_POLICY_RESIDENT_OWNER_LIMIT = 16;

export function createPrepackedPolicyHost<TResident extends PrepackedPolicyResident>(
  overlay: PrepackedPolicyOverlayBindings<TResident>
): PrepackedPolicyHost<TResident> {
  return {
    get transactionInFlight() {
      return overlay.prepackedAnnotationPolicyTransactionInFlight;
    },
    get activeLayer() {
      return overlay.prepackedAnnotationSceneLayer;
    },
    get activeInput() {
      return overlay.prepackedAnnotationSceneInput;
    },
    get activeOwnerKey() {
      return overlay.prepackedAnnotationSceneOwnerKey;
    },
    get requestedLayerTypes() {
      return overlay.annotationLayerTypesForPresentation();
    },
    get lastPresentationCamera() {
      return overlay.compiledBroadSurfaceLastPresentationCamera;
    },
    get lastCameraRequest() {
      return overlay.compiledBroadSurfaceLastCameraRequest;
    },
    get requirement() {
      return overlay.compiledBroadSurfaceRequirement;
    },
    get layout() {
      return overlay._layout;
    },
    get contract() {
      return overlay._contract;
    },
    get runtimePolicy() {
      return overlay.prepackedAnnotationRuntimePolicy;
    },
    get policyGeneration() {
      return overlay.prepackedAnnotationPolicyGeneration;
    },
    get lastPresentation() {
      return overlay.prepackedAnnotationSceneLastPresentation;
    },
    get annotationTrackBaseOffset() {
      return overlay.prepackedAnnotationTrackBaseOffsetPx() ?? 0;
    },
    get bodyPresentationGeneration() {
      return overlay.annotationBodyPresentationGeneration;
    },
    get residentsSize() {
      return overlay.prepackedAnnotationSceneResidents.size;
    },
    get residentOwnerLimit() {
      return PREPACKED_POLICY_RESIDENT_OWNER_LIMIT;
    },
    get lastCompleteOwnerKeys() {
      return overlay.prepackedAnnotationSceneLastCompleteOwnerKeys;
    },
    get hasResidentBank() {
      return overlay.prepackedAnnotationSceneResidents.size > 0;
    },
    get hasCompiledBroadSurface() {
      return Boolean(
        overlay.compiledBroadSurfaceManifest ||
        overlay.compiledBroadSurfaceCandidateManifest ||
        overlay.compiledBroadSurfaceTrackOwners.size > 0 ||
        overlay.compiledBroadSurfaceTrackCandidateOwners.size > 0
      );
    },
    get residents() {
      return overlay.prepackedAnnotationSceneResidents.values();
    },
    get replacementCandidates() {
      return overlay.prepackedAnnotationSceneReplacementCandidates.values();
    },
    getResident(ownerKey) {
      return overlay.prepackedAnnotationSceneResidents.get(ownerKey);
    },
    ownerRosterForTheme(requestedLayerTypes, requestedThemeMode) {
      return overlay.compiledBroadSurfaceOwnerRosterForTheme(
        requestedLayerTypes,
        requestedThemeMode
      );
    },
    provenanceIsCurrent(manifest, provenance) {
      return overlay.compiledBroadSurfaceProvenanceIsCurrent(manifest, provenance);
    },
    candidateRegistrationMatches(owner) {
      return overlay.compiledBroadSurfaceCandidateRegistrationMatches(owner);
    },
    laneStart(trackType, requestedLayerTypes, policy) {
      return overlay.compiledBroadSurfaceLaneStart(trackType, requestedLayerTypes, policy);
    },
    ownerForTrack(trackType) {
      return overlay.compiledBroadSurfaceOwnerForTrack(trackType);
    },
    candidateOwnerForTrack(trackType) {
      return overlay.compiledBroadSurfaceCandidateOwnerForTrack(trackType);
    },
    stackMaxLane(policy) {
      return overlay.annotationTrackStackMaxLane(policy);
    },
    incrementPlanDerivationCount() {
      overlay.compiledBroadSurfacePlanDerivationCount += 1;
    },
    setTransactionInFlight(value) {
      overlay.prepackedAnnotationPolicyTransactionInFlight = value;
    },
    reconcileLaneEnvelope() {
      overlay.reconcileAnnotationLaneEnvelopeAuthority();
    },
    resetAllPresentersToHidden() {
      overlay.resetAllPresentersToHidden();
    },
    clearImmediateState() {
      overlay.clearImmediateStateForCompiledAnnotationOwner();
    },
    finalizeCandidateOwner(owner) {
      overlay.finalizeCompiledBroadSurfaceCandidateOwner(owner);
    },
    hideCompiledPresenters() {
      overlay.compiledBroadSurfacePresenter?.hide();
      overlay.compiledBroadSurfaceCandidatePresenter?.hide();
      for (const owner of overlay.compiledBroadSurfaceTrackOwners.values()) {
        owner.presenter.hide();
      }
      for (const owner of overlay.compiledBroadSurfaceTrackCandidateOwners.values()) {
        owner.presenter.hide();
      }
    },
    setLastCompleteOwnerKeys(ownerKeys) {
      overlay.prepackedAnnotationSceneLastCompleteOwnerKeys = ownerKeys;
    },
    setStatus(status) {
      overlay.prepackedAnnotationSceneStatus = status;
    },
    setVisibleCounts(partitionCount, instanceCount) {
      overlay.prepackedAnnotationSceneVisiblePartitionCount = partitionCount;
      overlay.prepackedAnnotationSceneVisibleInstanceCount = instanceCount;
    },
    publishLaneEnvelope(maxAnnotationLane, maxCdsLane, maxLane, contract) {
      overlay.maxAnnotationLane = maxAnnotationLane;
      overlay.maxCdsLane = maxCdsLane;
      overlay.maxLane = maxLane;
      overlay._contract = contract;
    },
    setRuntimePolicy(policy) {
      overlay.prepackedAnnotationRuntimePolicy = policy;
    },
    setPolicyGeneration(generation) {
      overlay.prepackedAnnotationPolicyGeneration = generation;
    },
    clearIdentityCaches() {
      overlay.prepackedCanonicalRendererIdCache.clear();
      overlay.prepackedResidentPolicyFeatureIndexCache.clear();
    },
    clearViewportSelectionCache() {
      overlay.residentAnnotationViewportSelectionCache = null;
    },
    noteBodyPresentationCommit(input) {
      overlay.noteAnnotationBodyPresentationCommit(input);
    },
    bumpResidentClock() {
      return ++overlay.prepackedAnnotationSceneResidentClock;
    },
    publishActiveOwner(resident) {
      overlay.prepackedAnnotationSceneLayer = resident.layer;
      overlay.prepackedAnnotationSceneInput = resident.input;
      overlay.prepackedAnnotationSceneOwnerKey = resident.ownerKey;
      overlay.prepackedAnnotationSceneOwnerMetadata = resident.metadata;
    },
    markInteractionCouplingValidated() {
      overlay.prepackedAnnotationInteractionVisualCouplingValidated = true;
    },
    bumpOwnerGeneration() {
      overlay.prepackedAnnotationSceneOwnerGeneration += 1;
    },
    destroyResident(ownerKey, status, recordOwnerChange) {
      overlay.destroyPrepackedAnnotationSceneResident(ownerKey, status, recordOwnerChange ?? true);
    },
    removeLayerFromScene(layer) {
      if (layer.container.parent === overlay.container) {
        overlay.container.removeChild(layer.container);
      }
    },
    retireLayer(layer) {
      overlay.retiredPrepackedAnnotationSceneLayers.set(
        layer,
        Math.max(overlay.retiredPrepackedAnnotationSceneLayers.get(layer) ?? 0, 2)
      );
    },
    destroyLayer(layer) {
      layer.destroy();
      overlay.prepackedAnnotationSceneLayerDestroys += 1;
    },
    clearResidentBank() {
      overlay.prepackedAnnotationSceneResidents.clear();
      overlay.prepackedAnnotationSceneReplacementCandidates.clear();
    },
    bumpResidentGeneration() {
      overlay.prepackedAnnotationSceneResidentGeneration += 1;
    },
    clearActiveOwner() {
      overlay.prepackedAnnotationSceneLayer = null;
      overlay.prepackedAnnotationSceneInput = null;
      overlay.prepackedAnnotationSceneOwnerKey = null;
      overlay.prepackedAnnotationSceneOwnerMetadata = null;
    },
    setLastPresentation(presentation) {
      overlay.prepackedAnnotationSceneLastPresentation = presentation;
    },
    setCouplingValidated(value) {
      overlay.prepackedAnnotationInteractionVisualCouplingValidated = value;
    },
  };
}
