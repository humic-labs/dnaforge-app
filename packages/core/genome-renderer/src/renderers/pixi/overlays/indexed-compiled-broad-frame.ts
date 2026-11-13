import { INDEXED_ANNOTATION_COLOR_BASIS_THEME } from '../shared/annotation-runtime-theme';
import type { RetainedOverlayCameraState } from './overlay-track';
import type { AnnotationBodyReplacementReadiness } from './annotation-body-presentation-authority';
import type { AnnotationPolicyGpuRuntimeV1 } from '../overview/annotation-policy-gpu-instances-v1';
import type { CompiledBroadSurfaceRequirementV1 } from './indexed-compiled-broad-requirement';
import { compiledBroadSurfaceRequirementOwnsCamera } from './annotation-compiled-broad-address';
import {
  deriveBroadSurfacePresentationPlanV2,
  type BroadSurfaceIsoformModeV2,
  type BroadSurfacePresentationPlanV2,
  type CompiledBroadSurfaceAdmissionProvenanceV1,
  type CompiledBroadSurfaceManifestV2,
} from '../overview/bounded-annotation-broad-surface';
import type {
  CompiledBroadSurfacePixiCameraV2,
  CompiledBroadSurfacePixiPresenterV2,
  StagedCompiledBroadSurfacePixiPresentationV2,
} from '../overview/compiled-broad-surface-pixi-presenter';
import type { ViewerRenderContract } from '../overview/viewer-render-contract';
import type { AnnotationRolePaletteOverridesV1 } from '../../../annotation-role-palette';
import {
  compiledBroadDerivedPlanAction,
  compiledBroadPresentHasProduct,
  compiledBroadStageCommitAction,
  compiledBroadSteadyRosterPlanStatus,
  planCompiledBroadPresentRoster,
} from './indexed-compiled-broad-present';

export interface CompiledBroadSurfaceTrackOwnerV2 {
  readonly manifest: CompiledBroadSurfaceManifestV2;
  readonly provenance: CompiledBroadSurfaceAdmissionProvenanceV1;
  readonly presenter: CompiledBroadSurfacePixiPresenterV2;
}

export interface CompiledBroadSurfaceSteadyRosterV2 {
  readonly requestedLayerTypes: readonly string[];
  readonly requestedThemeMode: 'light' | 'dark';
  readonly isoformMode: BroadSurfaceIsoformModeV2;
  readonly laneLimit: number | null;
  readonly sourceFingerprint: string | null;
  readonly placementFingerprint: string | null;
  readonly orderedTrackIds: readonly string[];
  readonly tracks: readonly Readonly<{
    trackId: string;
    owner: CompiledBroadSurfaceTrackOwnerV2;
    laneStart: number;
  }>[];
}

export type CompiledBroadFastCameraMailbox = {
  isoformMode: BroadSurfaceIsoformModeV2;
  laneLimit: number | null;
  viewportStartBp: number;
  viewportEndBp: number;
  devicePixelRatio: number;
  contract: ViewerRenderContract;
  trackTopCssPx: number;
  viewportCssWidthPx: number;
  viewportCssHeightPx: number;
  themeMode: 'light' | 'dark';
  rolePalette?: AnnotationRolePaletteOverridesV1;
};

export type CompiledBroadFrameHost = {
  genomeLength: number;
  hasLayout: boolean;
  layoutAnnotationOffset: number;
  devicePixelRatio: number;
  requirement: CompiledBroadSurfaceRequirementV1 | null;
  hasPresenter: boolean;
  hasCandidatePresenter: boolean;
  trackOwnerCount: number;
  candidateOwnerCount: number;
  runtimePolicy: AnnotationPolicyGpuRuntimeV1 | null;
  maxAnnotationLane: number;
  sourceFingerprint: string | null;
  placementFingerprint: string | null;
  steadyRoster: CompiledBroadSurfaceSteadyRosterV2 | null;
  lastCompleteTrackIds: readonly string[];
  linearContract: ViewerRenderContract;
  fastCamera: CompiledBroadFastCameraMailbox;
  activePresenter: CompiledBroadSurfacePixiPresenterV2 | null;
  activeManifest: CompiledBroadSurfaceManifestV2 | null;
  activeProvenance: CompiledBroadSurfaceAdmissionProvenanceV1 | null;
  recordCameraRequest(
    camera: RetainedOverlayCameraState,
    viewportStartBp: number,
    viewportEndBp: number,
    viewportCssWidthPx: number,
    devicePixelRatio: number,
    viewportCssHeightPx: number
  ): void;
  ownerRosterForTheme(
    requestedLayerTypes: readonly string[],
    requestedThemeMode: 'light' | 'dark'
  ): Array<{
    trackId: string;
    currentOwner: CompiledBroadSurfaceTrackOwnerV2 | null;
    candidateOwner: CompiledBroadSurfaceTrackOwnerV2 | null;
    owner: CompiledBroadSurfaceTrackOwnerV2 | null;
  }>;
  laneStart(
    trackId: string,
    requestedLayerTypes: readonly string[],
    policy: AnnotationPolicyGpuRuntimeV1
  ): number;
  provenanceIsCurrent(
    manifest: CompiledBroadSurfaceManifestV2,
    provenance: CompiledBroadSurfaceAdmissionProvenanceV1
  ): boolean;
  candidateRegistrationMatches(owner: CompiledBroadSurfaceTrackOwnerV2): boolean;
  finalizeCandidateOwner(owner: CompiledBroadSurfaceTrackOwnerV2): void;
  retirePresentersOutsideRoster(presenters: readonly CompiledBroadSurfacePixiPresenterV2[]): void;
  ownerForTrack(trackId: string): CompiledBroadSurfaceTrackOwnerV2 | null;
  registeredTrackOwner(trackId: string): CompiledBroadSurfaceTrackOwnerV2 | undefined;
  incrementPlanDerivationCount(): void;
  setPlanStatus(
    status:
      | 'not-loaded'
      | 'broad-presenting'
      | 'broad-holding-last-good'
      | 'broad-cells-missing'
      | 'broad-artifact-required'
      | 'detail-required'
      | 'rejected'
  ): void;
  setOwnedLastFrame(value: boolean): void;
  setSteadyRoster(roster: CompiledBroadSurfaceSteadyRosterV2): void;
  setLastCompleteTrackIds(ids: readonly string[]): void;
  sealPresentedFrame(
    camera: RetainedOverlayCameraState,
    options: { clearImmediate: boolean }
  ): true;
};

export function compiledBroadTrackTopCssPx(input: {
  fwdStrandTop: number;
  layoutAnnotationOffset: number;
  laneRowCssHeightPx: number;
  laneStart: number;
}): number {
  return (
    input.fwdStrandTop +
    input.layoutAnnotationOffset -
    input.laneRowCssHeightPx / 2 -
    input.laneStart * input.laneRowCssHeightPx
  );
}

export function isCompiledBroadSteadyOwnerCurrent(input: {
  owner: CompiledBroadSurfaceTrackOwnerV2;
  activePresenter: CompiledBroadSurfacePixiPresenterV2 | null;
  activeManifest: CompiledBroadSurfaceManifestV2 | null;
  activeProvenance: CompiledBroadSurfaceAdmissionProvenanceV1 | null;
  registeredOwner: CompiledBroadSurfaceTrackOwnerV2 | undefined;
}): boolean {
  if (input.owner.presenter === input.activePresenter) {
    return (
      input.owner.manifest === input.activeManifest &&
      input.owner.provenance === input.activeProvenance
    );
  }
  return input.registeredOwner === input.owner;
}

export function isCompiledBroadSteadyRosterReusable(input: {
  roster: CompiledBroadSurfaceSteadyRosterV2 | null;
  requestedLayerTypes: readonly string[];
  requestedThemeMode: 'light' | 'dark';
  policy: AnnotationPolicyGpuRuntimeV1;
  sourceFingerprint: string | null;
  placementFingerprint: string | null;
  hasLayout: boolean;
  hasCandidatePresenter: boolean;
  candidateOwnerCount: number;
}): boolean {
  const roster = input.roster;
  return Boolean(
    roster &&
    roster.requestedLayerTypes === input.requestedLayerTypes &&
    roster.requestedThemeMode === input.requestedThemeMode &&
    roster.isoformMode === input.policy.isoformMode &&
    roster.laneLimit === input.policy.laneLimit &&
    roster.sourceFingerprint === input.sourceFingerprint &&
    roster.placementFingerprint === input.placementFingerprint &&
    roster.tracks.length === input.requestedLayerTypes.length &&
    input.hasLayout &&
    !input.hasCandidatePresenter &&
    input.candidateOwnerCount === 0
  );
}

export function buildCompiledBroadSteadyRoster(input: {
  requestedLayerTypes: readonly string[];
  requestedThemeMode: 'light' | 'dark';
  policy: AnnotationPolicyGpuRuntimeV1;
  sourceFingerprint: string | null;
  placementFingerprint: string | null;
  rows: readonly Readonly<{
    trackId: string;
    owner: CompiledBroadSurfaceTrackOwnerV2;
    laneStart: number;
  }>[];
}): CompiledBroadSurfaceSteadyRosterV2 {
  const tracks = Object.freeze(
    input.rows.map(({ trackId, owner, laneStart }) => Object.freeze({ trackId, owner, laneStart }))
  );
  const orderedTrackIds = Object.freeze(tracks.map(({ trackId }) => trackId));
  return Object.freeze({
    requestedLayerTypes: input.requestedLayerTypes,
    requestedThemeMode: input.requestedThemeMode,
    isoformMode: input.policy.isoformMode,
    laneLimit: input.policy.laneLimit,
    sourceFingerprint: input.sourceFingerprint,
    placementFingerprint: input.placementFingerprint,
    orderedTrackIds,
    tracks,
  });
}

function defaultCompiledBroadPolicy(host: CompiledBroadFrameHost): AnnotationPolicyGpuRuntimeV1 {
  return (
    host.runtimePolicy ?? {
      isoformMode: 'canonical',
      laneLimit: Math.max(1, host.maxAnnotationLane + 1),
    }
  );
}

function fillCompiledBroadFastCamera(
  host: CompiledBroadFrameHost,
  input: {
    policy: AnnotationPolicyGpuRuntimeV1;
    viewportStartBp: number;
    viewportEndBp: number;
    devicePixelRatio: number;
    fwdStrandTop: number;
    laneRowCssHeightPx: number;
    laneStart: number;
    viewportCssWidthPx: number;
    viewportCssHeightPx: number;
    themeMode: 'light' | 'dark';
    rolePalette: AnnotationRolePaletteOverridesV1 | undefined;
  }
): CompiledBroadFastCameraMailbox {
  const fastCamera = host.fastCamera;
  fastCamera.isoformMode = input.policy.isoformMode;
  fastCamera.laneLimit = input.policy.laneLimit;
  fastCamera.viewportStartBp = input.viewportStartBp;
  fastCamera.viewportEndBp = input.viewportEndBp;
  fastCamera.devicePixelRatio = input.devicePixelRatio;
  fastCamera.trackTopCssPx = compiledBroadTrackTopCssPx({
    fwdStrandTop: input.fwdStrandTop,
    layoutAnnotationOffset: host.layoutAnnotationOffset,
    laneRowCssHeightPx: input.laneRowCssHeightPx,
    laneStart: input.laneStart,
  });
  fastCamera.viewportCssWidthPx = input.viewportCssWidthPx;
  fastCamera.viewportCssHeightPx = input.viewportCssHeightPx;
  fastCamera.themeMode = input.themeMode;
  fastCamera.rolePalette = input.rolePalette;
  return fastCamera;
}

export function commitCompiledBroadSurfaceSteadyRoster(
  host: CompiledBroadFrameHost,
  requestedLayerTypes: readonly string[],
  requestedThemeMode: 'light' | 'dark',
  policy: AnnotationPolicyGpuRuntimeV1,
  rows: readonly Readonly<{
    trackId: string;
    owner: CompiledBroadSurfaceTrackOwnerV2;
    laneStart: number;
  }>[]
): void {
  const roster = buildCompiledBroadSteadyRoster({
    requestedLayerTypes,
    requestedThemeMode,
    policy,
    sourceFingerprint: host.sourceFingerprint,
    placementFingerprint: host.placementFingerprint,
    rows,
  });
  host.setSteadyRoster(roster);
  host.setLastCompleteTrackIds(roster.orderedTrackIds);
}

export function presentCommittedCompiledBroadSurfaceRoster(
  host: CompiledBroadFrameHost,
  camera: RetainedOverlayCameraState,
  requestedLayerTypes: readonly string[],
  requestedThemeMode: 'light' | 'dark',
  policy: AnnotationPolicyGpuRuntimeV1,
  viewportStartBp: number,
  viewportEndBp: number,
  viewportCssWidthPx: number,
  viewportCssHeightPx: number,
  devicePixelRatio: number
): boolean {
  const roster = host.steadyRoster;
  if (
    !isCompiledBroadSteadyRosterReusable({
      roster,
      requestedLayerTypes,
      requestedThemeMode,
      policy,
      sourceFingerprint: host.sourceFingerprint,
      placementFingerprint: host.placementFingerprint,
      hasLayout: host.hasLayout,
      hasCandidatePresenter: host.hasCandidatePresenter,
      candidateOwnerCount: host.candidateOwnerCount,
    }) ||
    !roster
  ) {
    return false;
  }
  for (let index = 0; index < roster.tracks.length; index += 1) {
    const track = roster.tracks[index];
    if (
      track.trackId !== requestedLayerTypes[index] ||
      !isCompiledBroadSteadyOwnerCurrent({
        owner: track.owner,
        activePresenter: host.activePresenter,
        activeManifest: host.activeManifest,
        activeProvenance: host.activeProvenance,
        registeredOwner: host.registeredTrackOwner(track.owner.manifest.trackId),
      })
    ) {
      return false;
    }
    const fastCamera = fillCompiledBroadFastCamera(host, {
      policy,
      viewportStartBp,
      viewportEndBp,
      devicePixelRatio,
      fwdStrandTop: camera.path.fwdStrandTop,
      laneRowCssHeightPx: track.owner.manifest.laneRowCssHeightPx,
      laneStart: track.laneStart,
      viewportCssWidthPx,
      viewportCssHeightPx,
      themeMode: camera.state.themeMode ?? 'light',
      rolePalette: camera.state.annotationRolePalette,
    });
    if (!track.owner.presenter.updateCameraWithinActiveTopology(fastCamera)) return false;
  }
  host.setLastCompleteTrackIds(roster.orderedTrackIds);
  host.setPlanStatus('broad-presenting');
  host.setOwnedLastFrame(true);
  return host.sealPresentedFrame(camera, { clearImmediate: true });
}

export function presentRequestedCompiledBroadSurfaces(
  host: CompiledBroadFrameHost,
  camera: RetainedOverlayCameraState,
  requestedLayerTypes: readonly string[]
): AnnotationBodyReplacementReadiness {
  if (
    !compiledBroadPresentHasProduct({
      requestedLayerCount: requestedLayerTypes.length,
      hasRequirement: Boolean(host.requirement),
      hasPresenter: host.hasPresenter,
      hasCandidatePresenter: host.hasCandidatePresenter,
      trackOwnerCount: host.trackOwnerCount,
      candidateOwnerCount: host.candidateOwnerCount,
    })
  ) {
    return 'absent';
  }
  const viewportStartBp = Math.max(0, camera.path.viewStartBp);
  const viewportEndBp = Math.min(host.genomeLength, camera.path.viewEndBp);
  const viewportCssWidthPx = camera.state.width;
  const devicePixelRatio = host.devicePixelRatio;
  const viewportCssHeightPx = camera.state.geometryHeight ?? camera.state.height;
  host.recordCameraRequest(
    camera,
    viewportStartBp,
    viewportEndBp,
    viewportCssWidthPx,
    devicePixelRatio,
    viewportCssHeightPx
  );
  const policy = defaultCompiledBroadPolicy(host);
  const requirement = host.requirement;
  const requirementOwnsCamera = Boolean(
    requirement &&
    compiledBroadSurfaceRequirementOwnsCamera({
      requirement,
      viewportStartBp,
      viewportEndBp,
      viewportCssWidthPx,
      devicePixelRatio,
    })
  );
  const displayThemeMode = camera.state.themeMode ?? 'light';
  const requestedThemeMode = INDEXED_ANNOTATION_COLOR_BASIS_THEME;
  if (
    (!requirement || requirementOwnsCamera) &&
    presentCommittedCompiledBroadSurfaceRoster(
      host,
      camera,
      requestedLayerTypes,
      requestedThemeMode,
      policy,
      viewportStartBp,
      viewportEndBp,
      viewportCssWidthPx,
      viewportCssHeightPx,
      devicePixelRatio
    )
  ) {
    return 'complete';
  }
  const selected = host
    .ownerRosterForTheme(requestedLayerTypes, requestedThemeMode)
    .map(({ trackId, currentOwner, candidateOwner, owner }) => ({
      trackId,
      currentOwner,
      candidateOwner,
      owner,
      laneStart: host.laneStart(trackId, requestedLayerTypes, policy),
    }));
  const retainOrFail = (
    status: 'broad-cells-missing' | 'broad-artifact-required' | 'rejected'
  ): AnnotationBodyReplacementReadiness => {
    host.setPlanStatus(status);
    for (const { candidateOwner } of selected) candidateOwner?.presenter.hide();
    return 'pending';
  };
  const rosterPlan = planCompiledBroadPresentRoster({
    hasRequirement: Boolean(requirement),
    requirementOwnsCamera,
    hasLayout: host.hasLayout,
    anyOwnerMissing: selected.some(({ owner }) => owner === null),
    anyGenomeOrProvenanceStale: selected.some(
      ({ owner }) =>
        owner !== null &&
        (owner.manifest.genomeLengthBp !== host.genomeLength ||
          !host.provenanceIsCurrent(owner.manifest, owner.provenance))
    ),
    anyCandidateRegistrationMismatch: selected.some(
      ({ candidateOwner }) =>
        candidateOwner !== null && !host.candidateRegistrationMatches(candidateOwner)
    ),
  });
  if (rosterPlan.kind === 'detail-required') {
    host.setPlanStatus('detail-required');
    for (const { candidateOwner } of selected) candidateOwner?.presenter.hide();
    return 'pending';
  }
  if (rosterPlan.kind === 'retain') return retainOrFail(rosterPlan.status);

  const resolved = selected as Array<
    (typeof selected)[number] & { owner: CompiledBroadSurfaceTrackOwnerV2 }
  >;

  let everyFastCameraUpdated = true;
  for (const { owner, laneStart } of resolved) {
    const fastCamera = fillCompiledBroadFastCamera(host, {
      policy,
      viewportStartBp,
      viewportEndBp,
      devicePixelRatio,
      fwdStrandTop: camera.path.fwdStrandTop,
      laneRowCssHeightPx: owner.manifest.laneRowCssHeightPx,
      laneStart,
      viewportCssWidthPx,
      viewportCssHeightPx,
      themeMode: displayThemeMode,
      rolePalette: camera.state.annotationRolePalette,
    });
    if (!owner.presenter.updateCameraWithinActiveTopology(fastCamera)) {
      everyFastCameraUpdated = false;
      break;
    }
  }
  if (everyFastCameraUpdated) {
    for (const { candidateOwner } of resolved) {
      if (candidateOwner) host.finalizeCandidateOwner(candidateOwner);
    }
    host.retirePresentersOutsideRoster(resolved.map(({ owner }) => owner.presenter));
    commitCompiledBroadSurfaceSteadyRoster(
      host,
      requestedLayerTypes,
      requestedThemeMode,
      policy,
      resolved
    );
    host.setPlanStatus('broad-presenting');
    host.setOwnedLastFrame(true);
    host.sealPresentedFrame(camera, { clearImmediate: true });
    return 'complete';
  }
  const planned: Array<{
    trackId: string;
    owner: CompiledBroadSurfaceTrackOwnerV2;
    candidateOwner: CompiledBroadSurfaceTrackOwnerV2 | null;
    plan: BroadSurfacePresentationPlanV2;
    camera: CompiledBroadSurfacePixiCameraV2;
  }> = [];
  for (const { trackId, owner, candidateOwner, laneStart } of resolved) {
    let result;
    try {
      host.incrementPlanDerivationCount();
      result = deriveBroadSurfacePresentationPlanV2({
        manifest: owner.manifest,
        isoformMode: policy.isoformMode,
        laneLimit: policy.laneLimit,
        viewportStartBp,
        viewportEndBp,
        viewportCssWidthPx,
        devicePixelRatio,
      });
    } catch {
      return retainOrFail('rejected');
    }
    const derivedAction = compiledBroadDerivedPlanAction(result.status);
    if (derivedAction === 'detail-required') {
      host.setPlanStatus('detail-required');
      for (const { candidateOwner } of planned) candidateOwner?.presenter.hide();
      return 'pending';
    }
    if (result.status !== 'broad-ready') {
      return retainOrFail(
        derivedAction === 'retain-artifact' ? 'broad-artifact-required' : 'rejected'
      );
    }
    planned.push({
      trackId,
      owner,
      candidateOwner,
      plan: result,
      camera: {
        plan: result,
        contract: host.linearContract,
        trackTopCssPx: compiledBroadTrackTopCssPx({
          fwdStrandTop: camera.path.fwdStrandTop,
          layoutAnnotationOffset: host.layoutAnnotationOffset,
          laneRowCssHeightPx: owner.manifest.laneRowCssHeightPx,
          laneStart,
        }),
        viewportCssWidthPx,
        viewportCssHeightPx,
        themeMode: displayThemeMode,
        rolePalette: camera.state.annotationRolePalette,
      },
    });
  }

  const stagedCommits: Array<{
    presenter: CompiledBroadSurfacePixiPresenterV2;
    receipt: StagedCompiledBroadSurfacePixiPresentationV2;
    camera: CompiledBroadSurfacePixiCameraV2;
  }> = [];
  const alreadyActive: Array<{
    presenter: CompiledBroadSurfacePixiPresenterV2;
    camera: CompiledBroadSurfacePixiCameraV2;
  }> = [];
  for (const { owner, plan, camera: compiledCamera } of planned) {
    const staged = owner.presenter.stagePresentation(plan);
    const stageAction = compiledBroadStageCommitAction(staged.status);
    if (staged.status === 'staged') {
      stagedCommits.push({
        presenter: owner.presenter,
        receipt: staged.receipt,
        camera: compiledCamera,
      });
    } else if (stageAction === 'already-active') {
      alreadyActive.push({ presenter: owner.presenter, camera: compiledCamera });
    } else {
      for (const commit of stagedCommits) {
        commit.presenter.discardStagedPresentation(commit.receipt);
      }
      return retainOrFail(stageAction === 'retain-missing' ? 'broad-cells-missing' : 'rejected');
    }
  }

  if (
    stagedCommits.some(
      ({ presenter, receipt, camera: stagedCamera }) =>
        !presenter.canCommitStagedPresentation(receipt, stagedCamera)
    )
  ) {
    for (const commit of stagedCommits) {
      commit.presenter.discardStagedPresentation(commit.receipt);
    }
    return retainOrFail('rejected');
  }
  for (const commit of stagedCommits) {
    commit.presenter.commitStagedPresentation(commit.receipt, commit.camera);
  }
  for (const active of alreadyActive) {
    if (!active.presenter.updateCamera(active.camera)) return retainOrFail('rejected');
  }
  if (planned.some(({ owner }) => !owner.presenter.isPresenting)) {
    return retainOrFail('rejected');
  }
  for (const { candidateOwner } of planned) {
    if (candidateOwner) host.finalizeCandidateOwner(candidateOwner);
  }
  host.retirePresentersOutsideRoster(planned.map(({ owner }) => owner.presenter));
  commitCompiledBroadSurfaceSteadyRoster(
    host,
    requestedLayerTypes,
    requestedThemeMode,
    policy,
    resolved
  );
  host.setPlanStatus(
    compiledBroadSteadyRosterPlanStatus({
      holdingLastGood: planned.some(({ owner }) => owner.presenter.holdingLastGood),
    })
  );
  host.setOwnedLastFrame(true);
  host.sealPresentedFrame(camera, { clearImmediate: true });
  return 'complete';
}

export function retainLastCompleteCompiledBroadSurfaceFrame(
  host: CompiledBroadFrameHost,
  camera: RetainedOverlayCameraState,
  policy: AnnotationPolicyGpuRuntimeV1
): boolean {
  if (!host.hasLayout || host.lastCompleteTrackIds.length === 0) {
    return false;
  }
  const viewportStartBp = Math.max(0, camera.path.viewStartBp);
  const viewportEndBp = Math.min(host.genomeLength, camera.path.viewEndBp);
  const viewportCssWidthPx = camera.state.width;
  const viewportCssHeightPx = camera.state.geometryHeight ?? camera.state.height;
  const devicePixelRatio = host.devicePixelRatio;
  const retained: Array<{
    presenter: CompiledBroadSurfacePixiPresenterV2;
    camera: CompiledBroadSurfacePixiCameraV2;
  }> = [];
  for (const trackId of host.lastCompleteTrackIds) {
    const owner = host.ownerForTrack(trackId);
    if (!owner || !host.provenanceIsCurrent(owner.manifest, owner.provenance)) {
      return false;
    }
    let plan;
    try {
      host.incrementPlanDerivationCount();
      plan = deriveBroadSurfacePresentationPlanV2({
        manifest: owner.manifest,
        isoformMode: policy.isoformMode,
        laneLimit: policy.laneLimit,
        viewportStartBp,
        viewportEndBp,
        viewportCssWidthPx,
        devicePixelRatio,
      });
    } catch {
      return false;
    }
    if (plan.status !== 'broad-ready') {
      const activePlan = owner.presenter.activePresentationPlan;
      if (
        !activePlan ||
        activePlan.isoformMode !== policy.isoformMode ||
        activePlan.laneLimit !== policy.laneLimit ||
        activePlan.activeLevels.some((level) => {
          const first = level.visibleTilePlacements[0];
          const last = level.visibleTilePlacements[level.visibleTilePlacements.length - 1];
          return (
            !first ||
            !last ||
            first.sourceStartBp > viewportStartBp ||
            last.sourceEndBpExclusive < viewportEndBp
          );
        })
      )
        return false;
      plan = activePlan;
    }
    const laneStart = host.laneStart(trackId, host.lastCompleteTrackIds, policy);
    retained.push({
      presenter: owner.presenter,
      camera: {
        plan,
        contract: host.linearContract,
        trackTopCssPx: compiledBroadTrackTopCssPx({
          fwdStrandTop: camera.path.fwdStrandTop,
          layoutAnnotationOffset: host.layoutAnnotationOffset,
          laneRowCssHeightPx: owner.manifest.laneRowCssHeightPx,
          laneStart,
        }),
        viewportCssWidthPx,
        viewportCssHeightPx,
        themeMode: camera.state.themeMode ?? 'light',
        rolePalette: camera.state.annotationRolePalette,
      },
    });
  }
  for (const entry of retained) entry.presenter.updateCamera(entry.camera);
  if (retained.some(({ presenter }) => !presenter.isPresenting)) {
    for (const { presenter } of retained) presenter.hide();
    return false;
  }
  host.setPlanStatus('broad-holding-last-good');
  host.setOwnedLastFrame(true);
  return host.sealPresentedFrame(camera, { clearImmediate: false });
}

export type CompiledBroadFrameOverlayBindings = {
  genomeLength: number;
  _layout: { annotationOffset: number } | null;
  pixiRenderer: { resolution?: number } | null;
  compiledBroadSurfaceRequirement: CompiledBroadSurfaceRequirementV1 | null;
  compiledBroadSurfacePresenter: CompiledBroadSurfacePixiPresenterV2 | null;
  compiledBroadSurfaceCandidatePresenter: CompiledBroadSurfacePixiPresenterV2 | null;
  compiledBroadSurfaceTrackOwners: {
    readonly size: number;
    get(trackId: string): CompiledBroadSurfaceTrackOwnerV2 | undefined;
  };
  compiledBroadSurfaceTrackCandidateOwners: { readonly size: number };
  prepackedAnnotationRuntimePolicy: AnnotationPolicyGpuRuntimeV1 | null;
  maxAnnotationLane: number;
  currentAnnotationSourceFingerprint: string | null;
  currentAnnotationPlacementFingerprint: string | null;
  compiledBroadSurfaceSteadyRoster: CompiledBroadSurfaceSteadyRosterV2 | null;
  compiledBroadSurfaceLastCompleteTrackIds: readonly string[];
  compiledBroadSurfaceLinearContract: ViewerRenderContract;
  compiledBroadSurfaceFastCamera: CompiledBroadFastCameraMailbox;
  compiledBroadSurfaceManifest: CompiledBroadSurfaceManifestV2 | null;
  compiledBroadSurfaceProvenance: CompiledBroadSurfaceAdmissionProvenanceV1 | null;
  compiledBroadSurfacePlanDerivationCount: number;
  compiledBroadSurfacePlanStatus:
    | 'not-loaded'
    | 'broad-presenting'
    | 'broad-holding-last-good'
    | 'broad-cells-missing'
    | 'broad-artifact-required'
    | 'detail-required'
    | 'rejected';
  compiledBroadSurfaceOwnedLastFrame: boolean;
  recordCompiledBroadSurfaceCameraRequest(
    camera: RetainedOverlayCameraState,
    viewportStartBp: number,
    viewportEndBp: number,
    viewportCssWidthPx: number,
    devicePixelRatio: number,
    viewportCssHeightPx: number
  ): void;
  compiledBroadSurfaceOwnerRosterForTheme(
    requestedLayerTypes: readonly string[],
    requestedThemeMode: 'light' | 'dark'
  ): Array<{
    trackId: string;
    currentOwner: CompiledBroadSurfaceTrackOwnerV2 | null;
    candidateOwner: CompiledBroadSurfaceTrackOwnerV2 | null;
    owner: CompiledBroadSurfaceTrackOwnerV2 | null;
  }>;
  compiledBroadSurfaceLaneStart(
    trackId: string,
    requestedLayerTypes: readonly string[],
    policy: AnnotationPolicyGpuRuntimeV1
  ): number;
  compiledBroadSurfaceProvenanceIsCurrent(
    manifest: CompiledBroadSurfaceManifestV2,
    provenance: CompiledBroadSurfaceAdmissionProvenanceV1
  ): boolean;
  compiledBroadSurfaceCandidateRegistrationMatches(
    owner: CompiledBroadSurfaceTrackOwnerV2
  ): boolean;
  finalizeCompiledBroadSurfaceCandidateOwner(owner: CompiledBroadSurfaceTrackOwnerV2): void;
  retireCompiledBroadPresentersOutsideRoster(
    presenters: readonly CompiledBroadSurfacePixiPresenterV2[]
  ): void;
  compiledBroadSurfaceOwnerForTrack(trackId: string): CompiledBroadSurfaceTrackOwnerV2 | null;
  sealCompiledBroadPresentedFrame(
    camera: RetainedOverlayCameraState,
    options: { clearImmediate: boolean }
  ): true;
};

export function createCompiledBroadFrameHost(
  overlay: CompiledBroadFrameOverlayBindings
): CompiledBroadFrameHost {
  return {
    get genomeLength() {
      return overlay.genomeLength;
    },
    get hasLayout() {
      return overlay._layout !== null;
    },
    get layoutAnnotationOffset() {
      return overlay._layout?.annotationOffset ?? 0;
    },
    get devicePixelRatio() {
      return Math.max(1, overlay.pixiRenderer?.resolution ?? 1);
    },
    get requirement() {
      return overlay.compiledBroadSurfaceRequirement;
    },
    get hasPresenter() {
      return overlay.compiledBroadSurfacePresenter !== null;
    },
    get hasCandidatePresenter() {
      return overlay.compiledBroadSurfaceCandidatePresenter !== null;
    },
    get trackOwnerCount() {
      return overlay.compiledBroadSurfaceTrackOwners.size;
    },
    get candidateOwnerCount() {
      return overlay.compiledBroadSurfaceTrackCandidateOwners.size;
    },
    get runtimePolicy() {
      return overlay.prepackedAnnotationRuntimePolicy;
    },
    get maxAnnotationLane() {
      return overlay.maxAnnotationLane;
    },
    get sourceFingerprint() {
      return overlay.currentAnnotationSourceFingerprint;
    },
    get placementFingerprint() {
      return overlay.currentAnnotationPlacementFingerprint;
    },
    get steadyRoster() {
      return overlay.compiledBroadSurfaceSteadyRoster;
    },
    get lastCompleteTrackIds() {
      return overlay.compiledBroadSurfaceLastCompleteTrackIds;
    },
    get linearContract() {
      return overlay.compiledBroadSurfaceLinearContract;
    },
    get fastCamera() {
      return overlay.compiledBroadSurfaceFastCamera;
    },
    get activePresenter() {
      return overlay.compiledBroadSurfacePresenter;
    },
    get activeManifest() {
      return overlay.compiledBroadSurfaceManifest;
    },
    get activeProvenance() {
      return overlay.compiledBroadSurfaceProvenance;
    },
    recordCameraRequest(
      camera,
      viewportStartBp,
      viewportEndBp,
      viewportCssWidthPx,
      devicePixelRatio,
      viewportCssHeightPx
    ) {
      overlay.recordCompiledBroadSurfaceCameraRequest(
        camera,
        viewportStartBp,
        viewportEndBp,
        viewportCssWidthPx,
        devicePixelRatio,
        viewportCssHeightPx
      );
    },
    ownerRosterForTheme(requestedLayerTypes, requestedThemeMode) {
      return overlay.compiledBroadSurfaceOwnerRosterForTheme(
        requestedLayerTypes,
        requestedThemeMode
      );
    },
    laneStart(trackId, requestedLayerTypes, policy) {
      return overlay.compiledBroadSurfaceLaneStart(trackId, requestedLayerTypes, policy);
    },
    provenanceIsCurrent(manifest, provenance) {
      return overlay.compiledBroadSurfaceProvenanceIsCurrent(manifest, provenance);
    },
    candidateRegistrationMatches(owner) {
      return overlay.compiledBroadSurfaceCandidateRegistrationMatches(owner);
    },
    finalizeCandidateOwner(owner) {
      overlay.finalizeCompiledBroadSurfaceCandidateOwner(owner);
    },
    retirePresentersOutsideRoster(presenters) {
      overlay.retireCompiledBroadPresentersOutsideRoster(presenters);
    },
    ownerForTrack(trackId) {
      return overlay.compiledBroadSurfaceOwnerForTrack(trackId);
    },
    registeredTrackOwner(trackId) {
      return overlay.compiledBroadSurfaceTrackOwners.get(trackId);
    },
    incrementPlanDerivationCount() {
      overlay.compiledBroadSurfacePlanDerivationCount += 1;
    },
    setPlanStatus(status) {
      overlay.compiledBroadSurfacePlanStatus = status;
    },
    setOwnedLastFrame(value) {
      overlay.compiledBroadSurfaceOwnedLastFrame = value;
    },
    setSteadyRoster(roster) {
      overlay.compiledBroadSurfaceSteadyRoster = roster;
    },
    setLastCompleteTrackIds(ids) {
      overlay.compiledBroadSurfaceLastCompleteTrackIds = ids;
    },
    sealPresentedFrame(camera, options) {
      return overlay.sealCompiledBroadPresentedFrame(camera, options);
    },
  };
}
