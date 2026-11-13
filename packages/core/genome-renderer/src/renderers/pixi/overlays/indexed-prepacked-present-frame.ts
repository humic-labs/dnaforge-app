import { INDEXED_ANNOTATION_COLOR_BASIS_THEME } from '../shared/annotation-runtime-theme';
import { ANNOTATION_LANE_TOTAL } from '../shared/lane-contracts';
import {
  linearViewerRenderContract,
  type ViewerRenderContract,
} from '../overview/viewer-render-contract';
import {
  prepackedSceneCoversRequestedLayers,
  type PrepackedAnnotationSceneLoadInput,
  type PrepackedAnnotationSceneStatus,
} from '../overview/prepacked-annotation-scene';
import type { AnnotationPolicyGpuRuntimeV1 } from '../overview/annotation-policy-gpu-instances-v1';
import type { RetainedOverlayCameraState } from './overlay-track';
import type { AnnotationBodyReplacementReadiness } from './annotation-body-presentation-authority';
import type { AnnotationPrebuiltRasterEligibility } from './annotation-lod-ownership';
import type { RetainedOverviewAnnotationStyle } from './annotation-lod-policy';
import { selectAnnotationPresentationResident } from './indexed-prepacked-resident-selection';
import {
  compiledExactPrepackedOwnerKey,
  isAdmittedPrepackedPresentationCandidate,
  resolveLastCompletePrepackedResidents,
  resolvePrepackedPresentationResident,
} from './indexed-prepacked-presentation-candidate';
import {
  planPrepackedPresentAfterResidents,
  prepackedFineSelectionIsExact,
} from './indexed-prepacked-present-readiness';
import type { AnnotationRolePaletteOverridesV1 } from '../../../annotation-role-palette';

export type PrepackedPresentFinePendingReason =
  | 'viewport-coverage'
  | 'fine-views-not-prewarmed'
  | 'fine-selection-not-exact';

export type PrepackedPresentCompiledOwner = {
  readonly provenance: {
    readonly themeMode?: string;
    readonly prepackedOwnerKey: string;
  };
  readonly manifest: {
    readonly trackId: string;
    readonly laneRowCssHeightPx?: number;
  };
} | null;

export type PrepackedPresentResident = {
  ownerKey: string;
  lastUsed: number;
  policyGeneration: number;
  viewportDetailPresentationAdmitted: boolean;
  visiblePartitionCount: number;
  visibleInstanceCount: number;
  metadata: {
    trackType: string;
    themeMode: string;
    annotationBarHeightPx: number;
  };
  input: {
    scene: PrepackedAnnotationSceneLoadInput['scene'];
    gpuReadyScene?: { featureIndices?: { readonly length: number } } | null;
    viewportDetail?: {
      empty?: boolean;
      coverageStartBp?: number;
      coverageEndBp?: number;
    } | null;
  };
  layer: {
    isFinePresentationExact: boolean;
    requiresFinePresentationForViewport(startBp: number, endBp: number): boolean;
    areFineViewsPrewarmed(startBp: number, endBp: number): boolean;
    updateVisibleRange(
      startBp: number,
      endBp: number
    ): ReadonlyArray<{ readonly instanceCount: number }>;
    updateCamera(
      contract: ViewerRenderContract,
      viewportWidth: number,
      viewportHeight: number,
      cdsDetail: number,
      annotationTrackBasePx: number,
      themeMode: 'light' | 'dark',
      rolePalette?: AnnotationRolePaletteOverridesV1
    ): void;
    hide(): void;
    show(): void;
  };
};

export type PrepackedPresentLastPresentation = {
  viewportStartBp: number;
  viewportEndBp: number;
  contract: ViewerRenderContract;
  viewportWidth: number;
  viewportHeight: number;
  cdsDetail: number;
  themeMode: 'light' | 'dark';
  rolePalette?: AnnotationRolePaletteOverridesV1;
};

export type PrepackedPresentFrameHost<
  TResident extends PrepackedPresentResident = PrepackedPresentResident,
> = {
  readonly genomeLength: number;
  readonly requestedLayerTypes: readonly string[];
  readonly ownerKey: string | null;
  readonly policyGeneration: number;
  readonly lastCompleteOwnerKeys: readonly string[];
  readonly residentsSize: number;
  readonly candidatesSize: number;
  readonly scaledBarHeightPx: number;
  readonly annotationTrackBase: number | null;
  readonly runtimePolicy: AnnotationPolicyGpuRuntimeV1 | null;
  readonly maxAnnotationLane: number;
  readonly replacementCandidates: Iterable<TResident>;
  readonly residents: Iterable<TResident>;
  getResident(ownerKey: string): TResident | undefined;
  compiledOwnerForTrack(trackType: string): PrepackedPresentCompiledOwner;
  laneStart(
    trackType: string,
    presentationLayerTypes: readonly string[],
    policy: AnnotationPolicyGpuRuntimeV1
  ): number;
  setFinePendingReason(reason: PrepackedPresentFinePendingReason | null): void;
  setStatus(status: PrepackedAnnotationSceneStatus): void;
  disposeScene(status: PrepackedAnnotationSceneStatus): void;
  hideResident(resident: TResident): void;
  setVisibleCounts(partitionCount: number, instanceCount: number): void;
  incrementCameraUpdates(): void;
  commitReplacement(resident: TResident): void;
  setLastPresentation(input: PrepackedPresentLastPresentation): void;
  setLastCompleteOwnerKeys(ownerKeys: readonly string[]): void;
  cdsDetailProgress(): number;
  sealPresentedFrame(
    camera: RetainedOverlayCameraState,
    style: RetainedOverviewAnnotationStyle
  ): void;
};

export function presentPrepackedAnnotationScene<TResident extends PrepackedPresentResident>(
  host: PrepackedPresentFrameHost<TResident>,
  camera: RetainedOverlayCameraState,
  style: RetainedOverviewAnnotationStyle,
  prebuiltRasterEligibility: Pick<AnnotationPrebuiltRasterEligibility, 'eligible'>
): AnnotationBodyReplacementReadiness {
  host.setFinePendingReason(null);
  const requestedLayerTypes = host.requestedLayerTypes;
  if (prebuiltRasterEligibility.eligible) {
    host.setStatus('eligible');
    return 'absent';
  }
  const requestedThemeMode = INDEXED_ANNOTATION_COLOR_BASIS_THEME;
  const viewportStartBp = Math.max(0, Math.floor(camera.path.viewStartBp));
  const viewportEndBp = Math.min(host.genomeLength, Math.ceil(camera.path.viewEndBp));
  const residentForCommittedTrack = (trackType: string): TResident | undefined => {
    const candidates = [...host.replacementCandidates, ...host.residents].filter((resident) =>
      isAdmittedPrepackedPresentationCandidate({
        admitted: resident.viewportDetailPresentationAdmitted,
        trackType: resident.metadata.trackType,
        themeMode: resident.metadata.themeMode,
        requestedTrackType: trackType,
        requestedThemeMode,
        coversRequestedLayer: prepackedSceneCoversRequestedLayers(
          [trackType],
          resident.input.scene,
          resident.input.gpuReadyScene?.featureIndices?.length ?? 0
        ),
        emptyDetailPacket: Boolean(
          resident.input.viewportDetail?.empty &&
          (resident.input.gpuReadyScene?.featureIndices?.length ?? 0) === 0
        ),
      })
    );
    const compiledOwner = host.compiledOwnerForTrack(trackType);
    const exactCompiledOwnerKey = compiledExactPrepackedOwnerKey({
      compiledTrackType: compiledOwner?.manifest.trackId,
      requestedTrackType: trackType,
      compiledThemeMode: compiledOwner?.provenance.themeMode,
      requestedThemeMode,
      compiledOwnerKey: compiledOwner?.provenance.prepackedOwnerKey,
    });
    const exactOwnerKey = host.ownerKey ?? exactCompiledOwnerKey;
    const exactDetail = exactOwnerKey
      ? selectAnnotationPresentationResident({
          residents: candidates,
          trackType,
          themeMode: requestedThemeMode,
          policyGeneration: host.policyGeneration,
          viewportStartBp,
          viewportEndBp,
          requireAdmitted: true,
          ownerKey: exactOwnerKey,
        })
      : undefined;
    const joinedDetail = selectAnnotationPresentationResident({
      residents: candidates,
      trackType,
      themeMode: requestedThemeMode,
      policyGeneration: host.policyGeneration,
      viewportStartBp,
      viewportEndBp,
      requireAdmitted: true,
      ...(exactCompiledOwnerKey ? { ownerKey: exactCompiledOwnerKey } : {}),
    });
    const staticResidents = candidates
      .filter(({ input }) => input.viewportDetail === undefined)
      .sort(
        (left, right) =>
          right.lastUsed - left.lastUsed || left.ownerKey.localeCompare(right.ownerKey)
      );
    return resolvePrepackedPresentationResident({
      exactDetail,
      joinedDetail,
      staticResidents,
      exactOwnerKey,
      exactCompiledOwnerKey,
    });
  };
  const presentingResidents = requestedLayerTypes.map(residentForCommittedTrack);
  let holdingLastComplete = false;
  let residents: TResident[];
  const resolveLastCompleteResidents = (): TResident[] | null =>
    resolveLastCompletePrepackedResidents({
      lastCompleteOwnerKeys: host.lastCompleteOwnerKeys,
      getResident: (ownerKey) => host.getResident(ownerKey),
    });
  if (presentingResidents.some((resident) => resident == null)) {
    const lastCompleteResidents = resolveLastCompleteResidents();
    if (!lastCompleteResidents) {
      host.setStatus('mixed-layer-fallback');
      return host.residentsSize > 0 || host.candidatesSize > 0 ? 'pending' : 'absent';
    }
    residents = lastCompleteResidents;
    holdingLastComplete = true;
  } else {
    residents = presentingResidents as TResident[];
  }
  const visibleBp = camera.path.viewEndBp - camera.path.viewStartBp;
  const annotationTrackBase = host.annotationTrackBase;
  const presentReadiness = planPrepackedPresentAfterResidents({
    residents,
    holdingLastComplete,
    lastCompleteResidents: resolveLastCompleteResidents(),
    policyGeneration: host.policyGeneration,
    residentPolicyGeneration: (resident) => resident.policyGeneration,
    visibleBp,
    scaledBarHeightPx: host.scaledBarHeightPx,
    residentBarHeightPx: (resident) => resident.metadata.annotationBarHeightPx,
    annotationTrackBase,
    coversViewport: (resident) => {
      const detail = resident.input.viewportDetail;
      return (
        !detail ||
        ((detail.coverageStartBp ?? Number.NEGATIVE_INFINITY) <= viewportStartBp &&
          (detail.coverageEndBp ?? Number.POSITIVE_INFINITY) >= viewportEndBp)
      );
    },
    needsFinePreparation: (resident) =>
      resident.layer.requiresFinePresentationForViewport(viewportStartBp, viewportEndBp) &&
      !resident.layer.areFineViewsPrewarmed(viewportStartBp, viewportEndBp),
  });
  if (presentReadiness.kind === 'absent') return 'absent';
  if (presentReadiness.kind === 'status-absent') {
    host.setStatus(presentReadiness.status);
    return 'absent';
  }
  if (presentReadiness.kind === 'dispose-absent') {
    host.disposeScene(presentReadiness.status);
    return 'absent';
  }
  if (presentReadiness.kind === 'pending') {
    host.setFinePendingReason(presentReadiness.reason);
    host.setStatus(presentReadiness.status);
    return 'pending';
  }
  if (presentReadiness.kind === 'hide-pending') {
    for (const resident of residents) {
      host.hideResident(resident);
    }
    host.setVisibleCounts(0, 0);
    host.setFinePendingReason(presentReadiness.reason);
    host.setStatus(presentReadiness.status);
    return 'pending';
  }
  residents = presentReadiness.residents as TResident[];
  holdingLastComplete = presentReadiness.holdingLastComplete;
  const contract = linearViewerRenderContract(camera.path);
  const cdsDetail = host.cdsDetailProgress();
  const runtimePolicy = host.runtimePolicy ?? {
    isoformMode: 'canonical' as const,
    laneLimit: Math.max(1, host.maxAnnotationLane + 1),
  };
  const presentationLayerTypes = residents.map(({ metadata }) => metadata.trackType);
  let visiblePartitionCount = 0;
  let visibleInstanceCount = 0;
  const submissionsByResident: Array<{
    resident: TResident;
    submissions: ReadonlyArray<{ readonly instanceCount: number }>;
  }> = [];
  for (const resident of residents) {
    const submissions = resident.layer.updateVisibleRange(viewportStartBp, viewportEndBp);
    submissionsByResident.push({ resident, submissions });
  }
  if (
    submissionsByResident.some(
      ({ resident }) =>
        !prepackedFineSelectionIsExact({
          requiresFinePresentation: resident.layer.requiresFinePresentationForViewport(
            viewportStartBp,
            viewportEndBp
          ),
          isFinePresentationExact: resident.layer.isFinePresentationExact,
        })
    )
  ) {
    for (const resident of residents) {
      host.hideResident(resident);
    }
    host.setVisibleCounts(0, 0);
    host.setFinePendingReason('fine-selection-not-exact');
    host.setStatus('fine-view-pending');
    return 'pending';
  }
  for (const { resident, submissions } of submissionsByResident) {
    const laneStart = host.laneStart(
      resident.metadata.trackType,
      presentationLayerTypes,
      runtimePolicy
    );
    const laneRowCssHeightPx =
      host.compiledOwnerForTrack(resident.metadata.trackType)?.manifest.laneRowCssHeightPx ??
      ANNOTATION_LANE_TOTAL;
    resident.layer.updateCamera(
      contract,
      camera.state.width,
      camera.state.height,
      cdsDetail,
      annotationTrackBase! - laneStart * laneRowCssHeightPx,
      camera.state.themeMode ?? 'light',
      camera.state.annotationRolePalette
    );
    resident.visiblePartitionCount = submissions.length;
    resident.visibleInstanceCount = submissions.reduce(
      (count, partition) => count + partition.instanceCount,
      0
    );
    visiblePartitionCount += resident.visiblePartitionCount;
    visibleInstanceCount += resident.visibleInstanceCount;
    resident.layer.show();
    host.incrementCameraUpdates();
  }
  for (const resident of residents) {
    host.commitReplacement(resident);
  }
  host.setLastPresentation({
    viewportStartBp,
    viewportEndBp,
    contract,
    viewportWidth: camera.state.width,
    viewportHeight: camera.state.height,
    cdsDetail,
    themeMode: camera.state.themeMode ?? 'light',
    rolePalette: camera.state.annotationRolePalette,
  });
  host.setVisibleCounts(visiblePartitionCount, visibleInstanceCount);
  host.setFinePendingReason(null);
  host.setStatus(holdingLastComplete ? 'holding-last-good' : 'eligible');
  if (!holdingLastComplete) {
    host.setLastCompleteOwnerKeys(Object.freeze(residents.map(({ ownerKey }) => ownerKey)));
  }

  host.sealPresentedFrame(camera, style);
  return 'complete';
}

export type PrepackedPresentFrameOverlayBindings<
  TResident extends PrepackedPresentResident = PrepackedPresentResident,
> = {
  genomeLength: number;
  prepackedAnnotationSceneOwnerKey: string | null;
  prepackedAnnotationPolicyGeneration: number;
  prepackedAnnotationSceneLastCompleteOwnerKeys: readonly string[];
  prepackedAnnotationSceneResidents: {
    readonly size: number;
    values(): Iterable<TResident>;
    get(ownerKey: string): TResident | undefined;
  };
  prepackedAnnotationSceneReplacementCandidates: {
    readonly size: number;
    values(): Iterable<TResident>;
  };
  prepackedAnnotationRuntimePolicy: AnnotationPolicyGpuRuntimeV1 | null;
  maxAnnotationLane: number;
  prepackedAnnotationSceneFinePendingReason: PrepackedPresentFinePendingReason | null;
  prepackedAnnotationSceneStatus: PrepackedAnnotationSceneStatus;
  prepackedAnnotationSceneVisiblePartitionCount: number;
  prepackedAnnotationSceneVisibleInstanceCount: number;
  prepackedAnnotationSceneCameraUpdates: number;
  prepackedAnnotationSceneLastPresentation: PrepackedPresentLastPresentation | null;
  lastDrawAudit: unknown;
  renderCallCount: number;
  lastRenderMode: string;
  lastRenderKey: string;
  lastRenderKeyParts: unknown;
  lastGeometryRebuildReasons: unknown;
  retainedOverviewMode: string;
  retainedOverviewStyle: RetainedOverviewAnnotationStyle | null;
  retainedOverviewCameraUpdates: number;
  retainedOverviewFallbackReason: unknown;
  retainedOverviewInstanceCount: number;
  retainedOverviewVisibleInstanceCount: number;
  lastRetainedTranscriptDecorationsDrawn: boolean;
  annotationLayerTypesForPresentation(): readonly string[];
  scaledBarHeight(): number;
  prepackedAnnotationTrackBaseOffsetPx(): number | null;
  compiledBroadSurfaceOwnerForTrack(trackType: string): PrepackedPresentCompiledOwner;
  compiledBroadSurfaceLaneStart(
    trackType: string,
    presentationLayerTypes: readonly string[],
    policy: AnnotationPolicyGpuRuntimeV1
  ): number;
  disposePrepackedAnnotationScene(status: PrepackedAnnotationSceneStatus): void;
  commitPrepackedAnnotationSceneReplacement(resident: TResident): void;
  cdsDetailProgress(): number;
  clearImmediateStateForCompiledAnnotationOwner(): void;
  beginDrawAuditIfDiagnosticsEnabled(
    path: RetainedOverlayCameraState['path'],
    state: RetainedOverlayCameraState['state'],
    features: readonly unknown[],
    useOverviewAggregation: boolean,
    forcedStyle: unknown
  ): unknown;
  renderInteractionOutlines(
    path: RetainedOverlayCameraState['path'],
    state: RetainedOverlayCameraState['state']
  ): void;
};

export function createPrepackedPresentFrameHost<TResident extends PrepackedPresentResident>(
  overlay: PrepackedPresentFrameOverlayBindings<TResident>
): PrepackedPresentFrameHost<TResident> {
  return {
    get genomeLength() {
      return overlay.genomeLength;
    },
    get requestedLayerTypes() {
      return overlay.annotationLayerTypesForPresentation();
    },
    get ownerKey() {
      return overlay.prepackedAnnotationSceneOwnerKey;
    },
    get policyGeneration() {
      return overlay.prepackedAnnotationPolicyGeneration;
    },
    get lastCompleteOwnerKeys() {
      return overlay.prepackedAnnotationSceneLastCompleteOwnerKeys;
    },
    get residentsSize() {
      return overlay.prepackedAnnotationSceneResidents.size;
    },
    get candidatesSize() {
      return overlay.prepackedAnnotationSceneReplacementCandidates.size;
    },
    get scaledBarHeightPx() {
      return overlay.scaledBarHeight();
    },
    get annotationTrackBase() {
      return overlay.prepackedAnnotationTrackBaseOffsetPx();
    },
    get runtimePolicy() {
      return overlay.prepackedAnnotationRuntimePolicy;
    },
    get maxAnnotationLane() {
      return overlay.maxAnnotationLane;
    },
    get replacementCandidates() {
      return overlay.prepackedAnnotationSceneReplacementCandidates.values();
    },
    get residents() {
      return overlay.prepackedAnnotationSceneResidents.values();
    },
    getResident(ownerKey) {
      return overlay.prepackedAnnotationSceneResidents.get(ownerKey);
    },
    compiledOwnerForTrack(trackType) {
      return overlay.compiledBroadSurfaceOwnerForTrack(trackType);
    },
    laneStart(trackType, presentationLayerTypes, policy) {
      return overlay.compiledBroadSurfaceLaneStart(trackType, presentationLayerTypes, policy);
    },
    setFinePendingReason(reason) {
      overlay.prepackedAnnotationSceneFinePendingReason = reason;
    },
    setStatus(status) {
      overlay.prepackedAnnotationSceneStatus = status;
    },
    disposeScene(status) {
      overlay.disposePrepackedAnnotationScene(status);
    },
    hideResident(resident) {
      resident.layer.hide();
      resident.visiblePartitionCount = 0;
      resident.visibleInstanceCount = 0;
    },
    setVisibleCounts(partitionCount, instanceCount) {
      overlay.prepackedAnnotationSceneVisiblePartitionCount = partitionCount;
      overlay.prepackedAnnotationSceneVisibleInstanceCount = instanceCount;
    },
    incrementCameraUpdates() {
      overlay.prepackedAnnotationSceneCameraUpdates += 1;
    },
    commitReplacement(resident) {
      overlay.commitPrepackedAnnotationSceneReplacement(resident);
    },
    setLastPresentation(input) {
      overlay.prepackedAnnotationSceneLastPresentation = input;
    },
    setLastCompleteOwnerKeys(ownerKeys) {
      overlay.prepackedAnnotationSceneLastCompleteOwnerKeys = ownerKeys;
    },
    cdsDetailProgress() {
      return overlay.cdsDetailProgress();
    },
    sealPresentedFrame(camera, style) {
      overlay.clearImmediateStateForCompiledAnnotationOwner();
      overlay.lastDrawAudit = overlay.beginDrawAuditIfDiagnosticsEnabled(
        camera.path,
        camera.state,
        [],
        false,
        null
      );
      overlay.renderCallCount += 1;
      overlay.lastRenderMode = 'retained';
      overlay.lastRenderKey = '';
      overlay.lastRenderKeyParts = null;
      overlay.lastGeometryRebuildReasons = [];
      overlay.retainedOverviewMode = 'retained';
      overlay.retainedOverviewStyle = style;
      overlay.retainedOverviewCameraUpdates += 1;
      overlay.retainedOverviewFallbackReason = null;
      overlay.retainedOverviewInstanceCount = overlay.prepackedAnnotationSceneVisibleInstanceCount;
      overlay.retainedOverviewVisibleInstanceCount =
        overlay.prepackedAnnotationSceneVisibleInstanceCount;
      overlay.lastRetainedTranscriptDecorationsDrawn = false;
      overlay.renderInteractionOutlines(camera.path, camera.state);
    },
  };
}
