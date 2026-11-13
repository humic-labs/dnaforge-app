import { isAnnotationColorRoleKeyV1 } from '@waypoint/genome-renderer/pure';
import {
  COMPILED_BROAD_SURFACE_ADMISSION_PROVENANCE_V1,
  COMPILED_BROAD_SURFACE_MAX_FINITE_LANE_LIMIT_V2,
  admitCompiledBroadSurfaceManifestV2,
  compiledBroadSurfaceCellIdV2,
  type BroadSurfaceIsoformModeV2,
  type CompiledBroadSurfaceAdmissionProvenanceV1,
  type CompiledBroadSurfaceManifestV2,
} from '@waypoint/genome-renderer/pure';

import {
  ASSEMBLY_COMPILED_BROAD_RASTER_CATALOG_CAPABILITY_V1,
  ASSEMBLY_COMPILED_BROAD_RASTER_CATALOG_RECEIPT_V1,
  ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
  COMPILED_BROAD_RASTER_ARTIFACT_WIRE_V1,
  COMPILED_BROAD_RASTER_OCCUPANCY_RGBA8_WIRE_V1,
  COMPILED_BROAD_RASTER_OCCUPANCY_TRANSPARENT_WIRE_V1,
  COMPILED_BROAD_RASTER_PIXEL_FORMAT_WIRE_V1,
  COMPILED_BROAD_RASTER_PIXEL_FORMAT_ROLE_WEIGHTS_WIRE_V1,
  assemblyCompiledBroadRasterFinestSpanBpV1,
  ASSEMBLY_COMPILED_BROAD_RASTER_MAX_CELLS_PER_IPC_RESPONSE_V1,
  type AssemblyAnnotationRuntimePolicy,
  type AssemblyReferenceAssetGenerationV1,
  type AssemblyAnnotationSceneArtifactContract,
  type AssemblyAnnotationSceneReadRequest,
  type AssemblyCompiledBroadRasterCatalogCapabilityV1,
  type AssemblyCompiledBroadRasterCellsRequestV1,
  type AssemblyCompiledBroadRasterCellsReadyResultV1,
  type AssemblyCompiledBroadRasterCellsResultV1,
  type AssemblyCompiledBroadRasterManifestRequestV1,
  type AssemblyCompiledBroadRasterManifestResultV1,
  type CompiledBroadRasterCellAddressWireV1,
  assemblyAnnotationSceneInteractionOwnerKeyV3,
} from '../../../shared/indexed-genome';
import { readNullableAuthorityUntilPublishedV1 } from './awaitNullableAuthorityPublication';

export const ASSEMBLY_COMPILED_BROAD_RASTER_LOADER_V1 =
  'assembly-compiled-broad-raster-loader.v1' as const;
export const ASSEMBLY_COMPILED_BROAD_RASTER_POLICY_COMMIT_V1 =
  'assembly-compiled-broad-raster-policy-commit.v1' as const;
const COMPILED_BROAD_SURFACE_DEMAND_V2 = 'compiled-broad-surface-demand.v2' as const;
const REPAIR_REPROBE_BASE_DELAY_MS = 100;
const REPAIR_REPROBE_MAX_DELAY_MS = 5_000;
const COMPILED_BROAD_REQUIRED_CELL_TRANSPORT_WINDOW = 8;
const COMPILED_BROAD_MAX_CELL_ADMISSIONS_PER_POST_PRESENT_SLICE = 2;
const COMPILED_BROAD_POST_PRESENT_ADMISSION_BUDGET_MS = 2;
const COMPILED_BROAD_ADMISSION_DEADLINE_HEADROOM_MS = 0.25;
const REPAIR_REPROBE_MAX_BACKOFF_EXPONENT = Math.ceil(
  Math.log2(REPAIR_REPROBE_MAX_DELAY_MS / REPAIR_REPROBE_BASE_DELAY_MS)
);

export type AssemblyCompiledBroadRasterReadinessV1 =
  | 'idle'
  | 'loading'
  | 'repairing'
  | 'ready'
  | 'unavailable'
  | 'error';
export type AssemblyCompiledBroadRasterPolicyControlsReadinessV1 =
  | 'idle'
  | 'warming'
  | 'repairing'
  | 'ready'
  | 'unavailable'
  | 'error';

export interface AssemblyCompiledBroadRasterLoaderTargetV1 {
  readonly identityKey: string;
  readonly genomeIdentity: string;
  readonly genomeLengthBp: number;
  readonly placementFingerprint: string;
  readonly sceneRequest: AssemblyAnnotationSceneReadRequest;
  readonly artifact: AssemblyAnnotationSceneArtifactContract;
  readonly expectedAssetGeneration?: AssemblyReferenceAssetGenerationV1 | null;
  readonly policy: AssemblyAnnotationRuntimePolicy;
  readonly policyRequestId?: number | null;
}

export interface AssemblyCompiledBroadRasterPolicyCommitReceiptV1 {
  readonly contract: typeof ASSEMBLY_COMPILED_BROAD_RASTER_POLICY_COMMIT_V1;
  readonly identityKey: string;
  readonly policyRequestId: number | null;
  readonly policy: AssemblyAnnotationRuntimePolicy;
  readonly surfaceManifestFingerprint: string;
  readonly catalogReceiptSha256: string;
}

export interface AssemblyCompiledBroadRasterRequirementV1 {
  readonly identityKey: string;
  readonly genomeLengthBp: number;
}

export interface ActiveCompiledBroadSurfaceDemandAddressV1 extends CompiledBroadRasterCellAddressWireV1 {
  readonly cellId: string;
}

export interface ActiveCompiledBroadSurfaceDemandV1 {
  readonly contract: string;
  readonly demandLeaseId: string | null;
  readonly cameraEpoch: number | null;
  readonly manifestFingerprint: string | null;
  readonly artifactKey: string | null;
  readonly trackId: string | null;
  readonly isoformMode: BroadSurfaceIsoformModeV2 | null;
  readonly laneLimit: number | null;
  readonly status:
    | 'not-loaded'
    | 'camera-required'
    | 'detail-required'
    | 'broad-artifact-required'
    | 'broad-ready'
    | 'rejected';
  readonly viewportStartBp: number | null;
  readonly viewportEndBp: number | null;
  readonly viewportCssWidthPx: number | null;
  readonly devicePixelRatio: number | null;
  readonly requiredCellAddresses: readonly ActiveCompiledBroadSurfaceDemandAddressV1[];
  readonly missingRequiredCellAddresses: readonly ActiveCompiledBroadSurfaceDemandAddressV1[];
  readonly successorCellAddresses: readonly ActiveCompiledBroadSurfaceDemandAddressV1[];
  readonly missingSuccessorCellAddresses: readonly ActiveCompiledBroadSurfaceDemandAddressV1[];
  readonly interactionPrefetchCellAddresses: readonly ActiveCompiledBroadSurfaceDemandAddressV1[];
  readonly missingInteractionPrefetchCellAddresses: readonly ActiveCompiledBroadSurfaceDemandAddressV1[];
  readonly prefetchCellAddresses: readonly ActiveCompiledBroadSurfaceDemandAddressV1[];
  readonly missingPrefetchCellAddresses: readonly ActiveCompiledBroadSurfaceDemandAddressV1[];
  readonly missingCellAddresses: readonly ActiveCompiledBroadSurfaceDemandAddressV1[];
}

export type CompiledBroadRasterCellAdmissionV1 = Readonly<
  | {
      status: 'admitted' | 'already-resident';
      cellId?: string;
      explicitCopyByteLength: number;
      uploadedByteLength: number;
    }
  | { status: 'rejected'; cellId?: string | null; reason: string }
>;

export interface AssemblyCompiledBroadRasterLoaderDiagnosticsV1 {
  readonly contract: 'assembly-compiled-broad-raster-loader-diagnostics.v1';
  readonly readiness: AssemblyCompiledBroadRasterReadinessV1;
  readonly policyControlsReadiness: AssemblyCompiledBroadRasterPolicyControlsReadinessV1;
  readonly demandEpoch: number;
  readonly pendingAdmissionCellCount: number;
  readonly cameraNotificationCount: number;
  readonly coalescedCameraNotificationCount: number;
  readonly uniformOnlyCameraNotificationCount: number;
  readonly postPresentSliceCount: number;
  readonly lastPostPresentSliceDurationMs: number;
  readonly maxPostPresentSliceDurationMs: number;
  readonly lastPostPresentSliceAdmissionCount: number;
  readonly maxPostPresentSliceAdmissionCount: number;
  readonly lastPostPresentSliceUploadedByteLength: number;
  readonly lastPostPresentSliceExplicitCopyByteLength: number;
  readonly totalAdmittedCellCount: number;
  readonly totalUploadedByteLength: number;
  readonly totalExplicitCopyByteLength: number;
  readonly cellTransportResponseCount: number;
  readonly maxCellTransportResponseCellCount: number;
  readonly totalCellTransportResponseByteLength: number;
  readonly maxCellTransportResponseByteLength: number;
  readonly staleResponseCount: number;
  readonly obsoleteCellDropCount: number;
  readonly stagedCellDropCount: number;
  readonly readinessTransitionCount: number;
  readonly policyControlsReadinessTransitionCount: number;
  readonly lastRejection: Readonly<{
    reason: string;
    message: string | null;
    demandEpoch: number;
    observedAtMs: number;
  }> | null;
  readonly targetDemand: Readonly<{
    status: ActiveCompiledBroadSurfaceDemandV1['status'] | null;
    isoformMode: BroadSurfaceIsoformModeV2 | null;
    laneLimit: number | null;
    viewportStartBp: number | null;
    viewportEndBp: number | null;
    requiredCellCount: number;
    missingRequiredCellCount: number;
    successorCellCount: number;
    missingSuccessorCellCount: number;
    interactionPrefetchCellCount: number;
    missingInteractionPrefetchCellCount: number;
    prefetchCellCount: number;
    missingPrefetchCellCount: number;
  }>;
  readonly demandPumpInFlight: boolean;
  readonly demandPumpAgain: boolean;
  readonly cameraDemandDirty: boolean;
  readonly pendingAdmissionTier: CompiledBroadDemandTier | null;
}

export type CompiledBroadRasterResidentLeaseReconcileResultV1 = Readonly<
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

export interface CompiledBroadRasterRendererV1 {
  requireCompiledBroadSurface(requirement: {
    readonly genomeLengthBp: number;
    readonly broadCorridorFinestSpanBp: number;
  }): boolean;
  admitCompiledBroadSurfaceSourcePlacementAuthority(authority: {
    readonly genomeIdentity: string;
    readonly genomeLengthBp: number;
    readonly sourceFingerprint: string;
    readonly placementFingerprint: string;
  }): boolean;
  loadCompiledBroadSurfaceManifest(
    manifest: CompiledBroadSurfaceManifestV2,
    provenance: CompiledBroadSurfaceAdmissionProvenanceV1
  ): boolean;
  commitAnnotationPresentationPolicy?(
    policy: AssemblyAnnotationRuntimePolicy
  ): Readonly<
    | { status: 'committed'; policyGeneration: number }
    | { status: 'deferred'; reason: 'selected-raster-roster-incomplete' }
    | { status: 'rejected'; reason: string }
  >;
  updateAnnotationPresentationPolicy(policy: AssemblyAnnotationRuntimePolicy): boolean;
  getCompiledBroadSurfaceDemand(
    policy?: AssemblyAnnotationRuntimePolicy,
    manifestFingerprint?: string
  ): ActiveCompiledBroadSurfaceDemandV1 | null;
  isCompiledBroadSurfaceDemandRefreshRequired?(
    policy: AssemblyAnnotationRuntimePolicy,
    manifestFingerprint: string
  ): boolean;
  admitCompiledBroadSurfaceRgbaCell(
    cell: Readonly<{
      demandLeaseId: string;
      manifestFingerprint: string;
      cellId: string;
      isoformMode: BroadSurfaceIsoformModeV2;
      level: number;
      tileX: number;
      laneSlabIndex: number;
      widthPx: number;
      heightPx: number;
      premultipliedRgba: Uint8Array;
    }>
  ): CompiledBroadRasterCellAdmissionV1;
  admitCompiledBroadSurfaceTransparentCell(
    cell: Readonly<{
      demandLeaseId: string;
      manifestFingerprint: string;
      cellId: string;
      isoformMode: BroadSurfaceIsoformModeV2;
      level: number;
      tileX: number;
      laneSlabIndex: number;
    }>
  ): CompiledBroadRasterCellAdmissionV1;
  reconcileCompiledBroadSurfaceResidentLeases(
    demandLeaseIds: readonly string[]
  ): CompiledBroadRasterResidentLeaseReconcileResultV1;
  clearCompiledBroadSurfaceManifest?(manifestFingerprint?: string): void;
  clearCompiledBroadSurfaceRequirement?(): void;
}

export interface AssemblyCompiledBroadRasterReadinessReceiptV1 {
  readonly readiness: AssemblyCompiledBroadRasterReadinessV1;
  readonly commandKey: string | null;
  readonly commandRenderer: CompiledBroadRasterRendererV1 | null;
  readonly targetIdentityKey: string | null;
  readonly renderer: CompiledBroadRasterRendererV1 | null;
  readonly expectedInteractionOwnerKey: string | null;
  readonly validatedSourceFingerprint: string | null;
  readonly admittedBroadCorridorFinestSpanBp: number | null;
}

interface AssemblyCompiledBroadRasterLoaderDependenciesV1 {
  readonly readManifest: (
    request: AssemblyCompiledBroadRasterManifestRequestV1
  ) => Promise<AssemblyCompiledBroadRasterManifestResultV1 | null>;
  readonly readCells: (
    request: AssemblyCompiledBroadRasterCellsRequestV1
  ) => Promise<AssemblyCompiledBroadRasterCellsResultV1>;
  readonly getRenderer: () => CompiledBroadRasterRendererV1 | null;
  readonly getRendererPresentationLifecycle?: () => Readonly<{
    renderer: CompiledBroadRasterRendererV1;
    requestRender: () => void;
    schedulePostPresentWork: (work: (deadlineMs: number) => void) => void;
  }> | null;
  readonly requestRender: () => void;
  readonly schedulePostPresentWork: (work: (deadlineMs: number) => void) => void;
  readonly rendererInteractionQuietDelayMs?: () => number;
  readonly recordEvent: (event: string, detail?: Record<string, unknown>) => void;
  readonly onReadinessChange?: (receipt: AssemblyCompiledBroadRasterReadinessReceiptV1) => void;
  readonly onPolicyControlsReadinessChange?: (
    readiness: AssemblyCompiledBroadRasterPolicyControlsReadinessV1
  ) => void;
  readonly onPolicyCommitted?: (receipt: AssemblyCompiledBroadRasterPolicyCommitReceiptV1) => void;
  readonly now?: () => number;
  readonly scheduleDelayedWork?: (
    work: () => void,
    delayMs: number
  ) => ReturnType<typeof setTimeout>;
  readonly cancelDelayedWork?: (handle: ReturnType<typeof setTimeout>) => void;
  readonly manifestPublicationDeadlineMs?: number;
  readonly manifestPublicationInitialRetryDelayMs?: number;
  readonly manifestPublicationMaxRetryDelayMs?: number;
}

type CompiledBroadRendererPresentationLifecycle = Readonly<{
  renderer: CompiledBroadRasterRendererV1;
  requestRender: () => void;
  schedulePostPresentWork: (work: (deadlineMs: number) => void) => void;
}>;

type ReadySurface = {
  readonly generation: number;
  readonly identityKey: string;
  target: AssemblyCompiledBroadRasterLoaderTargetV1;
  readonly renderer: CompiledBroadRasterRendererV1;
  readonly presentationLifecycle: Readonly<{
    requestRender: () => void;
    schedulePostPresentWork: (work: (deadlineMs: number) => void) => void;
  }>;
  readonly manifestResult: AssemblyCompiledBroadRasterManifestResultV1;
  committedPolicyKey: string | null;
  committedPolicy: AssemblyAnnotationRuntimePolicy | null;
  committedPolicyRequestId: number | null | undefined;
};

type ReadyRasterCellV1 = AssemblyCompiledBroadRasterCellsReadyResultV1['cells'][number];

type CompiledBroadDemandTier =
  | 'required'
  | 'commit-envelope'
  | 'control-prefetch'
  | 'successor'
  | 'interaction-prefetch'
  | 'prefetch';

function isSpeculativeDemandTier(tier: CompiledBroadDemandTier): boolean {
  return tier === 'control-prefetch' || tier === 'interaction-prefetch' || tier === 'prefetch';
}

function emptyTargetDemandDiagnostics(): AssemblyCompiledBroadRasterLoaderDiagnosticsV1['targetDemand'] {
  return Object.freeze({
    status: null,
    isoformMode: null,
    laneLimit: null,
    viewportStartBp: null,
    viewportEndBp: null,
    requiredCellCount: 0,
    missingRequiredCellCount: 0,
    successorCellCount: 0,
    missingSuccessorCellCount: 0,
    interactionPrefetchCellCount: 0,
    missingInteractionPrefetchCellCount: 0,
    prefetchCellCount: 0,
    missingPrefetchCellCount: 0,
  });
}

type PendingAdmissionBatchV1 = {
  readonly ready: ReadySurface;
  readonly policy: AssemblyAnnotationRuntimePolicy;
  readonly tier: CompiledBroadDemandTier;
  readonly cells: readonly ReadyRasterCellV1[];
  readonly mayAdmitDuringInteraction: boolean;
  readonly cancelOnCameraChange: boolean;
  supersededByCamera: boolean;
  nextCellIndex: number;
  admittedCellCount: number;
  readonly admittedCellIds: string[];
  supersededCellCount: number;
};

export class AssemblyCompiledBroadRasterLoaderV1 {
  readonly #dependencies: AssemblyCompiledBroadRasterLoaderDependenciesV1;
  readonly #now: () => number;
  #generation = 0;
  #target: AssemblyCompiledBroadRasterLoaderTargetV1 | null = null;
  #ready: ReadySurface | null = null;
  #requiredRenderer: CompiledBroadRasterRendererV1 | null = null;
  #requiredGenomeLengthBp: number | null = null;
  #pumpAgain = false;
  #pumpPromise: Promise<void> | null = null;
  #demandEpoch = 0;
  #cameraDemandDirty = false;
  #postPresentWorkScheduled = false;
  #pendingAdmissionBatch: PendingAdmissionBatchV1 | null = null;
  #disposed = false;
  #readiness: AssemblyCompiledBroadRasterReadinessV1 = 'idle';
  #policyControlsReadiness: AssemblyCompiledBroadRasterPolicyControlsReadinessV1 = 'idle';
  #rendererRetryTimer: ReturnType<typeof setTimeout> | null = null;
  #demandRetryTimer: ReturnType<typeof setTimeout> | null = null;
  #repairRetryTimer: ReturnType<typeof setTimeout> | null = null;
  #repairReprobeMode: 'cells' | 'catalog' | null = null;
  #repairRetryBackoffExponent = 0;
  #cameraNotificationCount = 0;
  #coalescedCameraNotificationCount = 0;
  #uniformOnlyCameraNotificationCount = 0;
  #postPresentSliceCount = 0;
  #lastPostPresentSliceDurationMs = 0;
  #maxPostPresentSliceDurationMs = 0;
  #lastPostPresentSliceAdmissionCount = 0;
  #maxPostPresentSliceAdmissionCount = 0;
  #lastPostPresentSliceUploadedByteLength = 0;
  #lastPostPresentSliceExplicitCopyByteLength = 0;
  #totalAdmittedCellCount = 0;
  #totalUploadedByteLength = 0;
  #totalExplicitCopyByteLength = 0;
  #cellTransportResponseCount = 0;
  #maxCellTransportResponseCellCount = 0;
  #totalCellTransportResponseByteLength = 0;
  #maxCellTransportResponseByteLength = 0;
  #staleResponseCount = 0;
  #obsoleteCellDropCount = 0;
  #stagedCellDropCount = 0;
  #readinessTransitionCount = 0;
  #policyControlsReadinessTransitionCount = 0;
  #lastRejection: AssemblyCompiledBroadRasterLoaderDiagnosticsV1['lastRejection'] = null;
  #idleWarmPlanKey: string | null = null;
  #idleWarmStageIndex = 0;
  #idleWarmPending = false;
  #idleWarmInFlight = false;
  #idleWarmEpoch = 0;
  #idleWarmQuietTimer: ReturnType<typeof setTimeout> | null = null;
  #interactionQuietAdmissionTimer: ReturnType<typeof setTimeout> | null = null;
  #manifestPublicationController: AbortController | null = null;
  #targetDemandDiagnostics: AssemblyCompiledBroadRasterLoaderDiagnosticsV1['targetDemand'] =
    emptyTargetDemandDiagnostics();

  constructor(dependencies: AssemblyCompiledBroadRasterLoaderDependenciesV1) {
    this.#dependencies = dependencies;
    this.#now = dependencies.now ?? (() => performance.now());
  }

  armRequirement(requirement: AssemblyCompiledBroadRasterRequirementV1): boolean {
    if (this.#disposed) return false;
    if (
      !requirement.identityKey.trim() ||
      !Number.isSafeInteger(requirement.genomeLengthBp) ||
      requirement.genomeLengthBp <= 0
    ) {
      this.#reject('renderer-requirement-invalid');
      return false;
    }
    const renderer = this.#dependencies.getRenderer();
    if (!renderer) {
      this.#dependencies.recordEvent('compiled-broad-raster-requirement-awaiting-renderer', {
        identityKey: requirement.identityKey,
      });
      return false;
    }
    return this.#armRendererRequirement(renderer, requirement);
  }

  async reconcile(
    target: AssemblyCompiledBroadRasterLoaderTargetV1,
    forceManifestReprobe = false
  ): Promise<void> {
    if (this.#disposed) return;
    const nextTarget = freezeTarget(target);
    this.#recordCompiledBroadTargetIdentityChange(this.#target, nextTarget);
    const currentPresentationLifecycle = this.#rendererPresentationLifecycle();
    const currentRenderer = currentPresentationLifecycle?.renderer ?? null;
    const reusableRenderer = this.#reusableAdmittedRasterRenderer(
      nextTarget,
      currentRenderer,
      forceManifestReprobe
    );
    if (reusableRenderer) {
      await this.#reconcileSameRasterTarget(nextTarget, reusableRenderer);
      return;
    }

    this.#resetCompiledBroadReconcileState();
    const generation = ++this.#generation;
    this.#target = nextTarget;
    if (
      await this.#tryResumeCompiledBroadSurface(
        target,
        nextTarget,
        currentRenderer,
        currentPresentationLifecycle,
        generation
      )
    ) {
      return;
    }
    await this.#admitFreshCompiledBroadManifest(target, nextTarget, generation);
  }

  #recordCompiledBroadTargetIdentityChange(
    previousTarget: AssemblyCompiledBroadRasterLoaderTargetV1 | null,
    nextTarget: AssemblyCompiledBroadRasterLoaderTargetV1
  ): void {
    if (previousTarget?.identityKey === nextTarget.identityKey) return;
    this.#dependencies.recordEvent('compiled-broad-raster-target-identity-changed', {
      previousIdentityKey: previousTarget?.identityKey ?? null,
      nextIdentityKey: nextTarget.identityKey,
      sameGenomeIdentity:
        previousTarget === null || previousTarget.genomeIdentity === nextTarget.genomeIdentity,
      samePlacementFingerprint:
        previousTarget === null ||
        previousTarget.placementFingerprint === nextTarget.placementFingerprint,
      sameArtifactKey:
        previousTarget === null ||
        previousTarget.artifact.artifactKey === nextTarget.artifact.artifactKey,
    });
  }

  #reusableAdmittedRasterRenderer(
    nextTarget: AssemblyCompiledBroadRasterLoaderTargetV1,
    currentRenderer: CompiledBroadRasterRendererV1 | null,
    forceManifestReprobe: boolean
  ): CompiledBroadRasterRendererV1 | null {
    if (forceManifestReprobe || currentRenderer === null || this.#hasTerminalFailure()) return null;
    const previousTarget = this.#target;
    const sameTargetAddress = previousTarget?.identityKey === nextTarget.identityKey;
    const expectedGenerationChanged = !sameExpectedAssetGeneration(
      previousTarget?.expectedAssetGeneration ?? null,
      nextTarget.expectedAssetGeneration ?? null
    );
    const readyGenerationCompatible =
      this.#ready !== null &&
      expectedGenerationMatchesManifest(nextTarget, this.#ready.manifestResult);
    const sameRasterTarget =
      sameTargetAddress && (!expectedGenerationChanged || readyGenerationCompatible);
    const sameRenderer =
      this.#requiredRenderer === currentRenderer &&
      (!this.#ready ||
        this.#ready.identityKey !== nextTarget.identityKey ||
        this.#ready.renderer === currentRenderer);
    return sameRasterTarget && sameRenderer ? currentRenderer : null;
  }

  async #reconcileSameRasterTarget(
    nextTarget: AssemblyCompiledBroadRasterLoaderTargetV1,
    currentRenderer: CompiledBroadRasterRendererV1
  ): Promise<void> {
    const expectedGenerationChanged = !sameExpectedAssetGeneration(
      this.#target?.expectedAssetGeneration ?? null,
      nextTarget.expectedAssetGeneration ?? null
    );
    const sameCommand = sameTargetCommand(this.#target!, nextTarget);
    if (sameCommand && !expectedGenerationChanged) return;

    const runtimePolicyChanged = !sameRuntimePolicy(this.#target!.policy, nextTarget.policy);
    if (runtimePolicyChanged) {
      this.#resetIdleWarmPlan();
      const pendingAdmission = this.#pendingAdmissionBatch;
      if (
        pendingAdmission &&
        isSpeculativeDemandTier(pendingAdmission.tier) &&
        !sameRuntimePolicy(pendingAdmission.policy, nextTarget.policy)
      ) {
        this.#dropPendingAdmissionBatch('speculative-work-superseded-by-policy-command');
      }
    }
    this.#target = nextTarget;
    const ready = this.#ready;
    if (
      !ready ||
      ready.identityKey !== nextTarget.identityKey ||
      ready.renderer !== currentRenderer
    ) {
      return;
    }
    ready.target = nextTarget;
    if (sameCommand) {
      this.#publishReadinessReceipt(ready);
      this.#dependencies.recordEvent('compiled-broad-raster-source-revision-validated', {
        sourceFingerprint:
          nextTarget.expectedAssetGeneration?.sourceFingerprint ??
          ready.manifestResult.catalogReceipt.sourceFingerprint,
        surfaceManifestFingerprint: ready.manifestResult.surfaceManifest.manifestFingerprint,
      });
      return;
    }
    if (this.#repairReprobeMode === 'catalog' || this.#pendingAdmissionBatch) return;
    await this.refreshDemand(false);
  }

  #resetCompiledBroadReconcileState(): void {
    this.#dropPendingAdmissionBatch('target-reconciled');
    this.#cameraDemandDirty = false;
    this.#postPresentWorkScheduled = false;
    this.#resetIdleWarmPlan();
    this.#clearRendererRetry();
    this.#clearDemandRetry();
    this.#clearRepairRetry(true);
    this.#abortManifestPublication();
  }

  async #tryResumeCompiledBroadSurface(
    target: AssemblyCompiledBroadRasterLoaderTargetV1,
    nextTarget: AssemblyCompiledBroadRasterLoaderTargetV1,
    currentRenderer: CompiledBroadRasterRendererV1 | null,
    currentPresentationLifecycle: CompiledBroadRendererPresentationLifecycle | null,
    generation: number
  ): Promise<boolean> {
    const previous = this.#ready;
    if (
      this.#hasTerminalFailure() ||
      !currentRenderer ||
      previous?.identityKey !== target.identityKey ||
      previous.renderer !== currentRenderer ||
      !expectedGenerationMatchesManifest(nextTarget, previous.manifestResult)
    ) {
      return false;
    }
    const resumedReady: ReadySurface = {
      ...previous,
      generation,
      target: this.#target!,
      presentationLifecycle: currentPresentationLifecycle ?? previous.presentationLifecycle,
      committedPolicyKey: null,
      committedPolicy: null,
      committedPolicyRequestId: undefined,
    };
    const resumedProvenance = compiledBroadSurfaceProvenanceForManifestResult(
      resumedReady.manifestResult
    );
    if (
      !currentRenderer.admitCompiledBroadSurfaceSourcePlacementAuthority({
        genomeIdentity: resumedProvenance.genomeIdentity,
        genomeLengthBp: resumedProvenance.genomeLengthBp,
        sourceFingerprint: resumedProvenance.sourceFingerprint,
        placementFingerprint: resumedProvenance.placementFingerprint,
      }) ||
      !currentRenderer.loadCompiledBroadSurfaceManifest(
        resumedReady.manifestResult.surfaceManifest,
        resumedProvenance
      )
    ) {
      this.#ready = null;
      this.#reject('renderer-manifest-readmission-rejected');
      return true;
    }
    this.#ready = resumedReady;
    this.#publishReadinessReceipt(resumedReady);
    this.#dependencies.recordEvent('compiled-broad-raster-manifest-readmitted', {
      surfaceManifestFingerprint: resumedReady.manifestResult.surfaceManifest.manifestFingerprint,
    });
    this.#requestRender(resumedReady);
    await this.refreshDemand(false);
    return true;
  }

  async #admitFreshCompiledBroadManifest(
    target: AssemblyCompiledBroadRasterLoaderTargetV1,
    nextTarget: AssemblyCompiledBroadRasterLoaderTargetV1,
    generation: number
  ): Promise<void> {
    this.#setReadiness('loading');
    this.#setPolicyControlsReadiness('warming');

    const request: AssemblyCompiledBroadRasterManifestRequestV1 = {
      contract: ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
      scene: target.sceneRequest,
    };
    const presentationLifecycle = this.#rendererPresentationLifecycle();
    const renderer = presentationLifecycle?.renderer ?? null;
    if (!renderer || !presentationLifecycle) {
      this.#dependencies.recordEvent('compiled-broad-raster-target-awaiting-renderer', {
        identityKey: target.identityKey,
      });
      this.#scheduleRendererRetry(generation, target.identityKey);
      return;
    }
    if (
      !this.#armRendererRequirement(renderer, {
        identityKey: `scene:${target.sceneRequest.assemblyId}`,
        genomeLengthBp: target.genomeLengthBp,
      })
    ) {
      return;
    }
    let wireResult: AssemblyCompiledBroadRasterManifestResultV1 | null;
    const publicationController = target.expectedAssetGeneration ? new AbortController() : null;
    if (publicationController) this.#manifestPublicationController = publicationController;
    try {
      let publicationAttempt = 0;
      const readManifest =
        async (): Promise<AssemblyCompiledBroadRasterManifestResultV1 | null> => {
          const result = await this.#dependencies.readManifest(request);
          if (publicationController) {
            publicationAttempt += 1;
            this.#dependencies.recordEvent('compiled-broad-raster-manifest-publication-attempt', {
              attempt: publicationAttempt,
              outcome: result === null ? 'not-published' : 'published',
              sourceFingerprint: target.expectedAssetGeneration!.sourceFingerprint,
              inventoryFingerprint: target.expectedAssetGeneration!.inventoryFingerprint,
              themeMode: target.expectedAssetGeneration!.themeMode,
            });
          }
          return result;
        };
      wireResult = publicationController
        ? await readNullableAuthorityUntilPublishedV1({
            authorityLabel: 'The expected compiled broad annotation raster',
            signal: publicationController.signal,
            read: readManifest,
            deadlineMs: this.#dependencies.manifestPublicationDeadlineMs,
            initialRetryDelayMs: this.#dependencies.manifestPublicationInitialRetryDelayMs,
            maxRetryDelayMs: this.#dependencies.manifestPublicationMaxRetryDelayMs,
          })
        : await readManifest();
    } catch (error) {
      if (this.#isStale(generation, target.identityKey)) {
        this.#stale('manifest');
        return;
      }
      this.#reject(
        publicationController ? 'expected-manifest-publication-failed' : 'manifest-read-failed',
        error
      );
      return;
    } finally {
      if (this.#manifestPublicationController === publicationController) {
        this.#manifestPublicationController = null;
      }
    }
    if (this.#isStale(generation, target.identityKey)) {
      this.#stale('manifest');
      return;
    }
    let result: AssemblyCompiledBroadRasterManifestResultV1 | null;
    try {
      result = await admitManifestResultFromIpc(wireResult);
    } catch (error) {
      if (this.#isStale(generation, target.identityKey)) {
        this.#stale('manifest-admission');
        return;
      }
      this.#reject('surface-manifest-admission-failed', error);
      return;
    }
    if (this.#isStale(generation, target.identityKey)) {
      this.#stale('manifest-admission');
      return;
    }
    const manifestFailure = validateManifestResult(result, target);
    if (manifestFailure) {
      if (manifestFailure === 'manifest-miss') {
        this.#setReadiness('unavailable');
        this.#setPolicyControlsReadiness('unavailable');
        this.#dependencies.recordEvent('compiled-broad-raster-manifest-unavailable', {
          identityKey: target.identityKey,
        });
        return;
      }
      this.#reject(manifestFailure);
      return;
    }

    const rendererAfterManifest = this.#dependencies.getRenderer();
    if (rendererAfterManifest !== null && rendererAfterManifest !== renderer) {
      this.#stale('manifest-renderer');
      return;
    }
    const provenance = compiledBroadSurfaceProvenanceForManifestResult(result!);
    if (
      !renderer.admitCompiledBroadSurfaceSourcePlacementAuthority({
        genomeIdentity: provenance.genomeIdentity,
        genomeLengthBp: provenance.genomeLengthBp,
        sourceFingerprint: provenance.sourceFingerprint,
        placementFingerprint: provenance.placementFingerprint,
      })
    ) {
      this.#reject('renderer-source-placement-authority-rejected');
      return;
    }
    if (!renderer.loadCompiledBroadSurfaceManifest(result!.surfaceManifest, provenance)) {
      this.#reject('renderer-manifest-rejected');
      return;
    }
    if (
      this.#isStale(generation, target.identityKey) ||
      (this.#dependencies.getRenderer() !== null && this.#dependencies.getRenderer() !== renderer)
    ) {
      this.#stale('manifest-admission');
      return;
    }
    const ready: ReadySurface = {
      generation,
      identityKey: target.identityKey,
      target: this.#target ?? nextTarget,
      renderer,
      presentationLifecycle,
      manifestResult: result!,
      committedPolicyKey: null,
      committedPolicy: null,
      committedPolicyRequestId: undefined,
    };
    this.#ready = ready;
    this.#publishReadinessReceipt(ready);
    this.#dependencies.recordEvent('compiled-broad-raster-manifest-admitted', {
      catalogFingerprint: result!.catalogReceipt.catalogFingerprint,
      surfaceManifestFingerprint: result!.catalogReceipt.surfaceManifestFingerprint,
      sourceFingerprint: result!.catalogReceipt.sourceFingerprint,
    });
    this.#requestRender(ready);
    await this.refreshDemand(false);
  }

  signalCameraChanged(): void {
    if (this.#disposed) return;
    this.#resetIdleWarmPlan();
    const pendingAdmission = this.#pendingAdmissionBatch;
    if (pendingAdmission?.cancelOnCameraChange) {
      pendingAdmission.supersededByCamera = true;
      this.#clearInteractionQuietAdmissionTimer();
    }
    this.#cameraNotificationCount += 1;
    if (this.#postPresentWorkScheduled) this.#coalescedCameraNotificationCount += 1;
    this.#clearDemandRetry();
    this.#demandEpoch += 1;
    this.#cameraDemandDirty = true;
    this.#schedulePostPresentWork();
  }

  async refreshDemand(_cameraChanged = false): Promise<void> {
    if (this.#disposed) return;
    this.#clearDemandRetry();
    this.#demandEpoch += 1;
    this.#pumpAgain = true;
    if (!this.#pumpPromise) {
      this.#pumpPromise = this.#drainDemand().finally(() => {
        this.#pumpPromise = null;
        if (this.#pumpAgain && !this.#disposed) {
          void this.refreshDemand(false);
        } else if (this.#idleWarmPending && !this.#disposed) {
          this.#schedulePostPresentWork();
        }
      });
    }
    await this.#pumpPromise;
  }

  readonly drainPostPresentWork = (deadlineMs: number): void => {
    if (this.#disposed) return;
    this.#postPresentWorkScheduled = false;
    const sliceStartedAt = this.#now();
    const admittedBefore = this.#totalAdmittedCellCount;
    const uploadedBefore = this.#totalUploadedByteLength;
    const copiedBefore = this.#totalExplicitCopyByteLength;
    const deadline = Math.min(
      Number.isFinite(deadlineMs) ? deadlineMs : Number.POSITIVE_INFINITY,
      sliceStartedAt + COMPILED_BROAD_POST_PRESENT_ADMISSION_BUDGET_MS
    );
    const pendingAdmission = this.#pendingAdmissionBatch;
    const interactionQuietDelayMs =
      pendingAdmission &&
      !pendingAdmission.mayAdmitDuringInteraction &&
      !pendingAdmission.supersededByCamera
        ? Math.max(0, this.#dependencies.rendererInteractionQuietDelayMs?.() ?? 0)
        : 0;
    if (interactionQuietDelayMs > 0) {
      this.#deferPassiveAdmissionsUntilInteractionQuiet(interactionQuietDelayMs);
    } else {
      this.#clearInteractionQuietAdmissionTimer();
      this.#drainPendingAdmissions(deadline);
    }
    const sliceDurationMs = Math.max(0, this.#now() - sliceStartedAt);
    const sliceAdmissionCount = this.#totalAdmittedCellCount - admittedBefore;
    this.#postPresentSliceCount += 1;
    this.#lastPostPresentSliceDurationMs = sliceDurationMs;
    this.#maxPostPresentSliceDurationMs = Math.max(
      this.#maxPostPresentSliceDurationMs,
      sliceDurationMs
    );
    this.#lastPostPresentSliceAdmissionCount = sliceAdmissionCount;
    this.#maxPostPresentSliceAdmissionCount = Math.max(
      this.#maxPostPresentSliceAdmissionCount,
      sliceAdmissionCount
    );
    this.#lastPostPresentSliceUploadedByteLength = this.#totalUploadedByteLength - uploadedBefore;
    this.#lastPostPresentSliceExplicitCopyByteLength =
      this.#totalExplicitCopyByteLength - copiedBefore;
    if (this.#pendingAdmissionBatch) {
      if (interactionQuietDelayMs <= 0) {
        this.#schedulePostPresentWork();
        this.#requestRender();
      }
      return;
    }
    if (this.#cameraDemandDirty) {
      if (this.#idleWarmInFlight) return;
      this.#cameraDemandDirty = false;
      const ready = this.#ready;
      const demandRefreshRequired = ready?.renderer.isCompiledBroadSurfaceDemandRefreshRequired;
      if (ready && demandRefreshRequired) {
        try {
          if (
            !demandRefreshRequired.call(
              ready.renderer,
              ready.target.policy,
              ready.manifestResult.surfaceManifest.manifestFingerprint
            )
          ) {
            this.#uniformOnlyCameraNotificationCount += 1;
            this.#scheduleIdleWarmPlan(ready, ready.target.policy);
            return;
          }
        } catch {}
      }
      void this.refreshDemand(false);
      return;
    }
    this.#startIdleWarmUnitIfBudgetAllows(deadline);
  };

  diagnostics(): AssemblyCompiledBroadRasterLoaderDiagnosticsV1 {
    return Object.freeze({
      contract: 'assembly-compiled-broad-raster-loader-diagnostics.v1',
      readiness: this.#readiness,
      policyControlsReadiness: this.#policyControlsReadiness,
      demandEpoch: this.#demandEpoch,
      pendingAdmissionCellCount: this.#pendingAdmissionCellCount(),
      cameraNotificationCount: this.#cameraNotificationCount,
      coalescedCameraNotificationCount: this.#coalescedCameraNotificationCount,
      uniformOnlyCameraNotificationCount: this.#uniformOnlyCameraNotificationCount,
      postPresentSliceCount: this.#postPresentSliceCount,
      lastPostPresentSliceDurationMs: this.#lastPostPresentSliceDurationMs,
      maxPostPresentSliceDurationMs: this.#maxPostPresentSliceDurationMs,
      lastPostPresentSliceAdmissionCount: this.#lastPostPresentSliceAdmissionCount,
      maxPostPresentSliceAdmissionCount: this.#maxPostPresentSliceAdmissionCount,
      lastPostPresentSliceUploadedByteLength: this.#lastPostPresentSliceUploadedByteLength,
      lastPostPresentSliceExplicitCopyByteLength: this.#lastPostPresentSliceExplicitCopyByteLength,
      totalAdmittedCellCount: this.#totalAdmittedCellCount,
      totalUploadedByteLength: this.#totalUploadedByteLength,
      totalExplicitCopyByteLength: this.#totalExplicitCopyByteLength,
      cellTransportResponseCount: this.#cellTransportResponseCount,
      maxCellTransportResponseCellCount: this.#maxCellTransportResponseCellCount,
      totalCellTransportResponseByteLength: this.#totalCellTransportResponseByteLength,
      maxCellTransportResponseByteLength: this.#maxCellTransportResponseByteLength,
      staleResponseCount: this.#staleResponseCount,
      obsoleteCellDropCount: this.#obsoleteCellDropCount,
      stagedCellDropCount: this.#stagedCellDropCount,
      readinessTransitionCount: this.#readinessTransitionCount,
      policyControlsReadinessTransitionCount: this.#policyControlsReadinessTransitionCount,
      lastRejection: this.#lastRejection,
      targetDemand: this.#targetDemandDiagnostics,
      demandPumpInFlight: this.#pumpPromise !== null,
      demandPumpAgain: this.#pumpAgain,
      cameraDemandDirty: this.#cameraDemandDirty,
      pendingAdmissionTier: this.#pendingAdmissionBatch?.tier ?? null,
    });
  }

  pause(): void {
    if (this.#disposed) return;
    this.#generation += 1;
    this.#demandEpoch += 1;
    this.#resetIdleWarmPlan();
    this.#clearRendererRetry();
    this.#clearDemandRetry();
    this.#clearRepairRetry(true);
    this.#abortManifestPublication();
    this.#target = null;
    this.#cameraDemandDirty = false;
    this.#postPresentWorkScheduled = false;
    this.#dropPendingAdmissionBatch('paused');
    this.#pumpAgain = false;
    this.#setReadiness('idle');
    this.#setPolicyControlsReadiness('idle');
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation += 1;
    this.#demandEpoch += 1;
    this.#resetIdleWarmPlan();
    this.#clearRendererRetry();
    this.#clearDemandRetry();
    this.#clearRepairRetry(true);
    this.#abortManifestPublication();
    this.#pumpAgain = false;
    this.#cameraDemandDirty = false;
    this.#postPresentWorkScheduled = false;
    this.#dropPendingAdmissionBatch('disposed');
    const requiredRenderer = this.#requiredRenderer;
    const loadedManifestFingerprint =
      this.#ready?.manifestResult.surfaceManifest.manifestFingerprint;
    this.#ready = null;
    this.#requiredRenderer = null;
    this.#requiredGenomeLengthBp = null;
    this.#target = null;
    if (requiredRenderer && this.#dependencies.getRenderer() === requiredRenderer) {
      if (loadedManifestFingerprint) {
        requiredRenderer.clearCompiledBroadSurfaceManifest?.(loadedManifestFingerprint);
      }
      this.#requestRender();
    }
    this.#setReadiness('idle');
    this.#setPolicyControlsReadiness('idle');
  }

  async #drainDemand(): Promise<void> {
    while (this.#pumpAgain && !this.#disposed) {
      this.#pumpAgain = false;
      if (this.#pendingAdmissionBatch) return;
      const ready = this.#ready;
      if (!ready || !this.#isCurrent(ready)) continue;
      await this.#loadDemandForReadySurface(ready);
    }
  }

  async #loadDemandForReadySurface(ready: ReadySurface): Promise<void> {
    const demandEpoch = this.#demandEpoch;
    const currentPolicy = ready.target.policy;
    const currentPolicyRequestId = ready.target.policyRequestId ?? null;
    const policyCommandPending =
      (ready.committedPolicy !== null &&
        !sameRuntimePolicy(ready.committedPolicy, currentPolicy)) ||
      (currentPolicyRequestId !== null &&
        ready.committedPolicyRequestId !== currentPolicyRequestId);
    if (policyCommandPending) this.#setPolicyControlsReadiness('warming');
    let currentDemand: ActiveCompiledBroadSurfaceDemandV1 | null;
    try {
      currentDemand = ready.renderer.getCompiledBroadSurfaceDemand(
        currentPolicy,
        ready.manifestResult.surfaceManifest.manifestFingerprint
      );
    } catch (error) {
      this.#reject('renderer-demand-failed', error);
      return;
    }
    if (!currentDemand) {
      this.#scheduleDemandRetry();
      return;
    }
    this.#recordTargetDemandDiagnostics(ready, currentPolicy, currentDemand);
    const hadCommittedPolicy = ready.committedPolicy !== null;
    const currentDemandTier =
      policyCommandPending && hadCommittedPolicy && currentDemand.status === 'broad-ready'
        ? ('commit-envelope' as const)
        : ('required' as const);
    const currentRequired = await this.#loadPolicyDemand(
      ready,
      currentPolicy,
      currentDemandTier,
      demandEpoch,
      true,
      currentDemand
    );
    if (currentRequired === 'detail') {
      if (this.#commitCurrentPolicy(ready, currentPolicy, currentPolicyRequestId) !== 'committed') {
        return;
      }
    } else {
      if (currentRequired !== 'loaded') return;
      if (ready.committedPolicy === null) {
        if (
          this.#commitCurrentPolicy(ready, currentPolicy, currentPolicyRequestId) !== 'committed'
        ) {
          return;
        }
      }
    }

    if (!hadCommittedPolicy || !policyCommandPending || currentRequired === 'detail') {
      const currentSuccessor = await this.#loadPolicyDemand(
        ready,
        currentPolicy,
        'successor',
        demandEpoch,
        false,
        currentDemand
      );
      if (currentSuccessor !== 'loaded') return;
    }
    if (currentRequired !== 'detail' && hadCommittedPolicy && policyCommandPending) {
      const latestContinuity = this.#latestPolicyContinuityReady(ready, currentPolicy);
      if (latestContinuity !== 'ready') {
        if (latestContinuity === 'deferred') this.#pumpAgain = true;
        return;
      }
      if (this.#commitCurrentPolicy(ready, currentPolicy, currentPolicyRequestId) !== 'committed') {
        return;
      }
    }

    this.#setPolicyControlsReadiness('ready');
    const currentMotionRunway = await this.#loadPolicyDemand(
      ready,
      currentPolicy,
      'interaction-prefetch',
      demandEpoch,
      false,
      currentDemand,
      this.#readiness !== 'ready'
    );
    if (currentMotionRunway !== 'loaded') return;

    if (currentRequired !== 'detail' && this.#readiness !== 'ready') {
      for (const controlPolicy of this.#nextControlPolicies(ready, currentPolicy)) {
        const controlEnvelope = await this.#loadPolicyDemand(
          ready,
          controlPolicy,
          'control-prefetch',
          demandEpoch,
          false,
          undefined,
          true,
          currentPolicy
        );
        if (controlEnvelope !== 'loaded') return;
      }
    }
    const currentPolicyWasReady = this.#readiness === 'ready';
    this.#setReadiness('ready');
    if (!currentPolicyWasReady) {
      this.#dependencies.recordEvent('compiled-broad-raster-current-policy-ready', {
        isoformMode: currentPolicy.isoformMode,
        laneLimit: currentPolicy.laneLimit,
      });
    }

    this.#scheduleIdleWarmPlan(ready, currentPolicy);
  }

  #latestPolicyContinuityReady(
    ready: ReadySurface,
    policy: AssemblyAnnotationRuntimePolicy
  ): 'ready' | 'deferred' | 'failed' {
    if (!this.#isCurrent(ready)) return 'deferred';
    let demand: ActiveCompiledBroadSurfaceDemandV1 | null;
    try {
      demand = ready.renderer.getCompiledBroadSurfaceDemand(
        policy,
        ready.manifestResult.surfaceManifest.manifestFingerprint
      );
    } catch (error) {
      this.#reject('renderer-demand-failed', error);
      return 'failed';
    }
    if (!demand || demand.status === 'camera-required') return 'deferred';
    this.#recordTargetDemandDiagnostics(ready, policy, demand);
    if (demand.status !== 'broad-ready') {
      this.#reject(`renderer-demand-${demand.status}`);
      return 'failed';
    }
    const demandFailure = this.#validateBroadReadyDemand(ready, demand, policy);
    if (demandFailure) {
      this.#reject(demandFailure);
      return 'failed';
    }
    return demand.missingRequiredCellAddresses.length === 0 &&
      demand.missingSuccessorCellAddresses.length === 0
      ? 'ready'
      : 'deferred';
  }

  #scheduleIdleWarmPlan(ready: ReadySurface, currentPolicy: AssemblyAnnotationRuntimePolicy): void {
    if (!this.#isCurrent(ready)) return;
    const planKey = [
      ready.generation,
      ready.manifestResult.surfaceManifest.manifestFingerprint,
      currentPolicy.isoformMode,
      currentPolicy.laneLimit ?? 'all',
    ].join('\n');
    if (this.#idleWarmPlanKey !== planKey) {
      this.#idleWarmPlanKey = planKey;
      this.#idleWarmStageIndex = 0;
      this.#idleWarmEpoch += 1;
    }
    this.#idleWarmPending = true;
    this.#scheduleIdleWarmAfterCameraQuiet();
  }

  #scheduleIdleWarmAfterCameraQuiet(delayMs = 250): void {
    if (this.#idleWarmQuietTimer !== null) {
      (this.#dependencies.cancelDelayedWork ?? clearTimeout)(this.#idleWarmQuietTimer);
    }
    const warmEpoch = this.#idleWarmEpoch;
    const schedule = this.#dependencies.scheduleDelayedWork ?? setTimeout;
    this.#idleWarmQuietTimer = schedule(
      () => {
        this.#idleWarmQuietTimer = null;
        if (this.#disposed || warmEpoch !== this.#idleWarmEpoch || !this.#idleWarmPending) {
          return;
        }
        this.#schedulePostPresentWork();
      },
      Math.max(1, Math.ceil(delayMs))
    );
  }

  #startIdleWarmUnitIfBudgetAllows(deadlineMs: number): void {
    if (!this.#idleWarmPending || this.#idleWarmInFlight || this.#disposed) return;
    if (this.#pumpPromise) return;
    const interactionQuietDelayMs = Math.max(
      0,
      this.#dependencies.rendererInteractionQuietDelayMs?.() ?? 0
    );
    if (interactionQuietDelayMs > 0) {
      this.#scheduleIdleWarmAfterCameraQuiet(interactionQuietDelayMs);
      return;
    }
    if (Number.isFinite(deadlineMs) && this.#now() >= deadlineMs) {
      this.#schedulePostPresentWork();
      return;
    }
    const ready = this.#ready;
    if (!ready || !this.#isCurrent(ready)) {
      this.#resetIdleWarmPlan();
      return;
    }
    this.#idleWarmPending = false;
    this.#idleWarmInFlight = true;
    const warmEpoch = this.#idleWarmEpoch;
    void this.#runIdleWarmUnit(ready, warmEpoch).finally(() => {
      this.#idleWarmInFlight = false;
      if ((this.#idleWarmPending || this.#cameraDemandDirty) && !this.#disposed) {
        const interactionQuietDelayMs = this.#cameraDemandDirty
          ? 0
          : Math.max(0, this.#dependencies.rendererInteractionQuietDelayMs?.() ?? 0);
        if (interactionQuietDelayMs > 0) {
          this.#scheduleIdleWarmAfterCameraQuiet(interactionQuietDelayMs);
        } else {
          this.#schedulePostPresentWork();
        }
      }
    });
  }

  async #runIdleWarmUnit(ready: ReadySurface, warmEpoch: number): Promise<void> {
    if (!this.#isCurrent(ready) || warmEpoch !== this.#idleWarmEpoch) return;
    const currentPolicy = ready.target.policy;
    const policies: AssemblyAnnotationRuntimePolicy[] = [
      currentPolicy,
      ...this.#nextControlPolicies(ready, currentPolicy),
    ];
    const uniquePolicies = policies.filter(
      (policy, index, all) =>
        all.findIndex((candidate) => sameRuntimePolicy(candidate, policy)) === index
    );
    const stages: ReadonlyArray<
      Readonly<{
        policy: AssemblyAnnotationRuntimePolicy;
        tier: CompiledBroadDemandTier;
      }>
    > = [{ policy: currentPolicy, tier: 'prefetch' }];
    while (this.#idleWarmStageIndex < stages.length) {
      const stage = stages[this.#idleWarmStageIndex]!;
      const result = await this.#loadPolicyDemand(
        ready,
        stage.policy,
        stage.tier,
        this.#demandEpoch,
        false,
        undefined,
        false
      );
      if (!this.#isCurrent(ready) || warmEpoch !== this.#idleWarmEpoch) return;
      if (result === 'loaded') {
        this.#idleWarmStageIndex += 1;
        this.#idleWarmPending = true;
        continue;
      } else if (result === 'resnapshot') {
        this.#idleWarmPending = true;
      } else if (result === 'detail' || result === 'failed') {
        this.#resetIdleWarmPlan();
      }
      return;
    }
    if (!this.#isCurrent(ready) || warmEpoch !== this.#idleWarmEpoch) return;
    const continuityDemands: Array<{
      policy: AssemblyAnnotationRuntimePolicy;
      demand: ActiveCompiledBroadSurfaceDemandV1;
      requireInteractionDemand: boolean;
    }> = [];
    let detailOwnsCurrentPolicy = false;
    for (const policy of uniquePolicies) {
      if (detailOwnsCurrentPolicy && !sameRuntimePolicy(policy, currentPolicy)) continue;
      let demand: ActiveCompiledBroadSurfaceDemandV1 | null;
      try {
        demand = ready.renderer.getCompiledBroadSurfaceDemand(
          policy,
          ready.manifestResult.surfaceManifest.manifestFingerprint
        );
      } catch (error) {
        this.#reject('renderer-demand-failed', error);
        return;
      }
      if (!demand) {
        this.#scheduleDemandRetry();
        this.#idleWarmPending = true;
        return;
      }
      continuityDemands.push({
        policy,
        demand,
        requireInteractionDemand: sameRuntimePolicy(policy, currentPolicy),
      });
      if (sameRuntimePolicy(policy, currentPolicy) && demand.status === 'detail-required') {
        detailOwnsCurrentPolicy = true;
      }
    }
    const interactionQuietDelayMs = Math.max(
      0,
      this.#dependencies.rendererInteractionQuietDelayMs?.() ?? 0
    );
    if (interactionQuietDelayMs > 0) {
      this.#idleWarmPending = true;
      return;
    }
    const retention = this.#reconcilePolicyLeaseUnion(ready, this.#demandEpoch, continuityDemands);
    if (retention === 'resnapshot' || retention === 'deferred') {
      this.#idleWarmPending = true;
      return;
    }
    if (retention !== 'reconciled') {
      this.#resetIdleWarmPlan();
      return;
    }
    this.#dependencies.recordEvent('compiled-broad-raster-current-policy-ring-warmed', {
      isoformMode: currentPolicy.isoformMode,
      laneLimit: currentPolicy.laneLimit,
    });
    this.#idleWarmPending = false;
  }

  #nextControlPolicies(
    ready: ReadySurface,
    currentPolicy: AssemblyAnnotationRuntimePolicy
  ): readonly AssemblyAnnotationRuntimePolicy[] {
    const finiteLaneLimit = Math.min(
      COMPILED_BROAD_SURFACE_MAX_FINITE_LANE_LIMIT_V2,
      currentPolicy.laneLimit ?? COMPILED_BROAD_SURFACE_MAX_FINITE_LANE_LIMIT_V2
    );
    const nextLaneSlabLimit = Math.min(
      COMPILED_BROAD_SURFACE_MAX_FINITE_LANE_LIMIT_V2,
      (Math.ceil(finiteLaneLimit / ready.manifestResult.surfaceManifest.laneSlabRowCount) + 1) *
        ready.manifestResult.surfaceManifest.laneSlabRowCount
    );
    const policies: AssemblyAnnotationRuntimePolicy[] = [
      {
        isoformMode: currentPolicy.isoformMode === 'canonical' ? 'expanded' : 'canonical',
        laneLimit: finiteLaneLimit,
      },
      { isoformMode: currentPolicy.isoformMode, laneLimit: nextLaneSlabLimit },
    ];
    return Object.freeze(
      policies.filter(
        (policy, index, all) =>
          !sameRuntimePolicy(policy, currentPolicy) &&
          all.findIndex((candidate) => sameRuntimePolicy(candidate, policy)) === index
      )
    );
  }

  #commitCurrentPolicy(
    ready: ReadySurface,
    policy: AssemblyAnnotationRuntimePolicy,
    policyRequestId: number | null
  ): 'committed' | 'deferred' | 'failed' {
    if (
      !sameRuntimePolicy(ready.target.policy, policy) ||
      (ready.target.policyRequestId ?? null) !== policyRequestId
    ) {
      this.#pumpAgain = true;
      return 'deferred';
    }
    const policyKey = compiledBroadRasterPolicyKey(
      ready.manifestResult.surfaceManifest.manifestFingerprint,
      policy
    );
    if (ready.committedPolicyKey !== policyKey) {
      let disposition: Readonly<
        | { status: 'committed'; policyGeneration?: number }
        | { status: 'deferred'; reason: string }
        | { status: 'rejected'; reason: string }
      >;
      try {
        disposition = ready.renderer.commitAnnotationPresentationPolicy
          ? ready.renderer.commitAnnotationPresentationPolicy(policy)
          : ready.renderer.updateAnnotationPresentationPolicy(policy)
            ? { status: 'committed' }
            : { status: 'rejected', reason: 'annotation-policy-commit-rejected' };
      } catch (error) {
        this.#reject('renderer-policy-commit-failed', error);
        return 'failed';
      }
      if (disposition.status === 'deferred') {
        this.#setReadiness('loading');
        this.#setPolicyControlsReadiness('warming');
        this.#dependencies.recordEvent('compiled-broad-raster-policy-deferred', {
          reason: disposition.reason,
          isoformMode: policy.isoformMode,
          laneLimit: policy.laneLimit,
          surfaceManifestFingerprint: ready.manifestResult.surfaceManifest.manifestFingerprint,
        });
        return 'deferred';
      }
      if (disposition.status === 'rejected') {
        this.#reject('renderer-policy-commit-rejected', disposition.reason);
        return 'failed';
      }
      ready.committedPolicyKey = policyKey;
      ready.committedPolicy = Object.freeze({ ...policy });
      ready.committedPolicyRequestId = undefined;
      this.#dependencies.recordEvent('compiled-broad-raster-policy-committed', {
        isoformMode: policy.isoformMode,
        laneLimit: policy.laneLimit,
        surfaceManifestFingerprint: ready.manifestResult.surfaceManifest.manifestFingerprint,
      });
      this.#requestRender();
    }
    if (ready.committedPolicyRequestId !== policyRequestId) {
      ready.committedPolicyRequestId = policyRequestId;
      this.#dependencies.onPolicyCommitted?.(
        Object.freeze({
          contract: ASSEMBLY_COMPILED_BROAD_RASTER_POLICY_COMMIT_V1,
          identityKey: ready.identityKey,
          policyRequestId,
          policy: Object.freeze({ ...policy }),
          surfaceManifestFingerprint: ready.manifestResult.surfaceManifest.manifestFingerprint,
          catalogReceiptSha256: ready.manifestResult.catalogReceipt.receiptSha256,
        })
      );
    }
    return 'committed';
  }

  #reconcilePolicyLeaseUnion(
    ready: ReadySurface,
    demandEpoch: number,
    entries: readonly Readonly<{
      policy: AssemblyAnnotationRuntimePolicy;
      demand: ActiveCompiledBroadSurfaceDemandV1;
      requireInteractionDemand: boolean;
    }>[]
  ): 'reconciled' | 'detail' | 'deferred' | 'resnapshot' | 'failed' {
    if (!this.#isCurrent(ready) || demandEpoch !== this.#demandEpoch) return 'deferred';
    const leaseIds: string[] = [];
    let cameraEpoch: number | null = null;
    for (const { policy, demand, requireInteractionDemand } of entries) {
      if (demand.status === 'camera-required') {
        this.#scheduleDemandRetry();
        return 'deferred';
      }
      if (demand.status !== 'broad-ready' && demand.status !== 'detail-required') {
        this.#reject(`renderer-demand-${demand.status}`);
        return 'failed';
      }
      const demandFailure = this.#validateBroadReadyDemand(ready, demand, policy);
      if (demandFailure || !demand.demandLeaseId || demand.cameraEpoch === null) {
        this.#reject(demandFailure ?? 'renderer-demand-identity-mismatch');
        return 'failed';
      }
      if (
        demand.missingRequiredCellAddresses.length > 0 ||
        demand.missingSuccessorCellAddresses.length > 0 ||
        (requireInteractionDemand && demand.missingInteractionPrefetchCellAddresses.length > 0)
      ) {
        if (!requireInteractionDemand) {
          continue;
        }
        this.#pumpAgain = true;
        return 'resnapshot';
      }
      if (cameraEpoch === null) cameraEpoch = demand.cameraEpoch;
      if (cameraEpoch !== demand.cameraEpoch || demandEpoch !== this.#demandEpoch) {
        this.#pumpAgain = true;
        return 'resnapshot';
      }
      leaseIds.push(demand.demandLeaseId);
    }
    if (!this.#isCurrent(ready) || demandEpoch !== this.#demandEpoch) return 'deferred';
    const result = ready.renderer.reconcileCompiledBroadSurfaceResidentLeases(leaseIds);
    if (result.status === 'rejected') {
      if (result.reason === 'compiled-broad-surface-demand-lease-stale-or-unknown') {
        this.#stale('resident-lease-reconcile');
        this.#scheduleDemandRetry();
        return 'deferred';
      }
      this.#reject('renderer-resident-lease-reconcile-rejected', result.reason);
      return 'failed';
    }
    if (cameraEpoch === null || result.cameraEpoch !== cameraEpoch) {
      this.#stale('resident-lease-camera');
      this.#scheduleDemandRetry();
      return 'deferred';
    }
    if (result.evictedCellIds.length > 0) {
      this.#dependencies.recordEvent('compiled-broad-raster-resident-leases-reconciled', {
        cameraEpoch,
        leaseCount: leaseIds.length,
        retainedCellCount: result.retainedCellCount,
        evictedCellCount: result.evictedCellIds.length,
      });
    }
    this.#requestRender();
    return 'reconciled';
  }

  async #loadPolicyDemand(
    ready: ReadySurface,
    policy: AssemblyAnnotationRuntimePolicy,
    tier: CompiledBroadDemandTier,
    demandEpoch: number,
    blocking: boolean,
    demandSnapshot?: ActiveCompiledBroadSurfaceDemandV1,
    mayAdmitDuringInteraction = tier !== 'prefetch',
    speculationOwnerPolicy = policy
  ): Promise<'loaded' | 'detail' | 'deferred' | 'resnapshot' | 'failed'> {
    if (!this.#isCurrent(ready)) return 'deferred';
    if (this.#repairReprobeMode === 'catalog') return 'deferred';
    let demand: ActiveCompiledBroadSurfaceDemandV1 | null = demandSnapshot ?? null;
    if (!demand) {
      try {
        demand = ready.renderer.getCompiledBroadSurfaceDemand(
          policy,
          ready.manifestResult.surfaceManifest.manifestFingerprint
        );
      } catch (error) {
        this.#reject('renderer-demand-failed', error);
        return 'failed';
      }
    }
    if (!demand) {
      this.#scheduleDemandRetry();
      return 'deferred';
    }
    if (demand.status === 'detail-required' && tier === 'required') return 'detail';
    if (demand.status === 'camera-required') {
      this.#scheduleDemandRetry();
      return 'deferred';
    }
    if (demand.status !== 'broad-ready' && demand.status !== 'detail-required') {
      this.#reject(`renderer-demand-${demand.status}`);
      return 'failed';
    }
    const demandFailure = this.#validateBroadReadyDemand(ready, demand, policy);
    if (demandFailure) {
      this.#reject(demandFailure);
      return 'failed';
    }
    if (!demand.demandLeaseId) {
      this.#reject('renderer-demand-identity-mismatch');
      return 'failed';
    }
    const source =
      tier === 'required'
        ? demand.missingRequiredCellAddresses
        : tier === 'commit-envelope' || tier === 'control-prefetch'
          ? [...demand.missingRequiredCellAddresses, ...demand.missingSuccessorCellAddresses]
          : tier === 'successor'
            ? demand.missingSuccessorCellAddresses
            : tier === 'interaction-prefetch'
              ? demand.missingInteractionPrefetchCellAddresses
              : demand.missingPrefetchCellAddresses;
    const valid: ActiveCompiledBroadSurfaceDemandAddressV1[] = [];
    const seen = new Set<string>();
    for (const candidate of source) {
      const failure = validateDemandAddress(
        ready.manifestResult.surfaceManifest,
        candidate,
        policy.isoformMode
      );
      if (failure) {
        this.#reject(failure);
        return 'failed';
      }
      const finiteWarmSlabCount = Math.ceil(
        COMPILED_BROAD_SURFACE_MAX_FINITE_LANE_LIMIT_V2 /
          ready.manifestResult.surfaceManifest.laneSlabRowCount
      );
      if (
        policy.laneLimit === COMPILED_BROAD_SURFACE_MAX_FINITE_LANE_LIMIT_V2 &&
        candidate.laneSlabIndex >= finiteWarmSlabCount
      ) {
        this.#reject('finite-warm-envelope-exceeded');
        return 'failed';
      }
      if (!seen.has(candidate.cellId)) {
        seen.add(candidate.cellId);
        valid.push(candidate);
      }
    }
    if (valid.length === 0) return 'loaded';
    const hadReadyOwner = this.#readiness === 'ready';
    if (blocking && !hadReadyOwner) {
      this.#setReadiness('loading');
      this.#setPolicyControlsReadiness('warming');
    }
    const transportWindow =
      blocking || mayAdmitDuringInteraction ? COMPILED_BROAD_REQUIRED_CELL_TRANSPORT_WINDOW : 1;
    const batch = valid.slice(0, transportWindow);
    const cancelOnCameraChange =
      tier === 'control-prefetch' ||
      tier === 'interaction-prefetch' ||
      tier === 'prefetch' ||
      (tier === 'successor' && demand.status === 'broad-ready');
    const admission = await this.#readAndAdmitBatch(
      ready,
      policy,
      tier,
      batch,
      demandEpoch,
      mayAdmitDuringInteraction,
      cancelOnCameraChange,
      speculationOwnerPolicy
    );
    if (admission === 'failed') return 'failed';
    if (admission === 'repairing') return 'deferred';
    if (admission === 'queued') return 'deferred';
    this.#pumpAgain = true;
    return 'resnapshot';
  }

  #validateBroadReadyDemand(
    ready: ReadySurface,
    demand: ActiveCompiledBroadSurfaceDemandV1,
    policy: AssemblyAnnotationRuntimePolicy
  ): string | null {
    if (
      demand.contract !== COMPILED_BROAD_SURFACE_DEMAND_V2 ||
      typeof demand.demandLeaseId !== 'string' ||
      demand.demandLeaseId.length === 0 ||
      demand.cameraEpoch === null ||
      !Number.isSafeInteger(demand.cameraEpoch) ||
      demand.cameraEpoch < 0 ||
      demand.manifestFingerprint !== ready.manifestResult.surfaceManifest.manifestFingerprint ||
      demand.artifactKey !== ready.manifestResult.surfaceManifest.artifactKey ||
      demand.trackId !== ready.manifestResult.surfaceManifest.trackId ||
      demand.isoformMode !== policy.isoformMode ||
      demand.laneLimit !== policy.laneLimit
    ) {
      return 'renderer-demand-identity-mismatch';
    }
    return null;
  }

  #recordTargetDemandDiagnostics(
    ready: ReadySurface,
    policy: AssemblyAnnotationRuntimePolicy,
    demand: ActiveCompiledBroadSurfaceDemandV1
  ): void {
    if (!sameRuntimePolicy(ready.target.policy, policy)) return;
    this.#targetDemandDiagnostics = Object.freeze({
      status: demand.status,
      isoformMode: demand.isoformMode,
      laneLimit: demand.laneLimit,
      viewportStartBp: demand.viewportStartBp,
      viewportEndBp: demand.viewportEndBp,
      requiredCellCount: demand.requiredCellAddresses.length,
      missingRequiredCellCount: demand.missingRequiredCellAddresses.length,
      successorCellCount: demand.successorCellAddresses.length,
      missingSuccessorCellCount: demand.missingSuccessorCellAddresses.length,
      interactionPrefetchCellCount: demand.interactionPrefetchCellAddresses.length,
      missingInteractionPrefetchCellCount: demand.missingInteractionPrefetchCellAddresses.length,
      prefetchCellCount: demand.prefetchCellAddresses.length,
      missingPrefetchCellCount: demand.missingPrefetchCellAddresses.length,
    });
  }

  async #readAndAdmitBatch(
    ready: ReadySurface,
    policy: AssemblyAnnotationRuntimePolicy,
    tier: CompiledBroadDemandTier,
    demand: readonly ActiveCompiledBroadSurfaceDemandAddressV1[],
    demandEpoch: number,
    mayAdmitDuringInteraction: boolean,
    cancelOnCameraChange: boolean,
    speculationOwnerPolicy: AssemblyAnnotationRuntimePolicy
  ): Promise<'queued' | 'superseded' | 'repairing' | 'failed'> {
    if (demand.length === 0 || !this.#isCurrent(ready)) return 'failed';
    const requests: AssemblyCompiledBroadRasterCellsRequestV1[] = demand.map(
      ({ isoformMode, level, tileX, laneSlabIndex }) => ({
        contract: ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
        catalogCapability: ready.manifestResult.catalogCapability,
        addresses: [{ isoformMode, level, tileX, laneSlabIndex }],
      })
    );
    const settled = await Promise.allSettled(
      requests.map((request) => this.#dependencies.readCells(request))
    );
    if (!this.#isCurrent(ready)) {
      this.#stale('cells');
      return 'superseded';
    }
    if (
      isSpeculativeDemandTier(tier) &&
      !sameRuntimePolicy(ready.target.policy, speculationOwnerPolicy)
    ) {
      this.#stale('speculative-cells-policy-command');
      return 'superseded';
    }
    const supersededByCamera = cancelOnCameraChange && demandEpoch !== this.#demandEpoch;
    const transportFailure = settled.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'
    );
    if (transportFailure) {
      this.#beginRepair(ready, 'cell-transport-unavailable', 250, transportFailure.reason);
      return 'repairing';
    }
    const results = settled.map(
      (outcome) =>
        (outcome as PromiseFulfilledResult<AssemblyCompiledBroadRasterCellsResultV1>).value
    );
    const repairingResult = results.find((result) => result.status === 'repairing');
    if (repairingResult?.status === 'repairing') {
      if (
        !sameCatalogCapability(
          repairingResult.catalogCapability,
          ready.manifestResult.catalogCapability
        ) ||
        !Number.isSafeInteger(repairingResult.retryAfterMs) ||
        repairingResult.retryAfterMs < 0
      ) {
        this.#reject('cell-repair-state-invalid');
        return 'failed';
      }
      this.#beginRepair(
        ready,
        repairingResult.reason,
        repairingResult.retryAfterMs,
        undefined,
        'catalog'
      );
      return 'repairing';
    }
    const unavailableResult = results.find((result) => result.status === 'unavailable');
    if (unavailableResult?.status === 'unavailable') {
      this.#markRepairUnavailable(unavailableResult.reason);
      return 'repairing';
    }
    const cells: ReadyRasterCellV1[] = [];
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index]!;
      if (result.status !== 'ready') {
        this.#reject('cell-transport-status-invalid');
        return 'failed';
      }
      const requested = [demand[index]!] as const;
      const failure = validateCellResult(result, ready.manifestResult, requested);
      if (failure) {
        this.#reject(failure);
        return 'failed';
      }
      const responseByteLength = result.cells.reduce(
        (total, cell) => total + (cell.premultipliedRgba?.byteLength ?? 0),
        0
      );
      this.#cellTransportResponseCount += 1;
      this.#maxCellTransportResponseCellCount = Math.max(
        this.#maxCellTransportResponseCellCount,
        result.cells.length
      );
      this.#totalCellTransportResponseByteLength += responseByteLength;
      this.#maxCellTransportResponseByteLength = Math.max(
        this.#maxCellTransportResponseByteLength,
        responseByteLength
      );
      this.#dependencies.recordEvent('compiled-broad-raster-cells-transported', {
        cellCount: result.cells.length,
        byteLength: responseByteLength,
        maxAllowedCellCount: ASSEMBLY_COMPILED_BROAD_RASTER_MAX_CELLS_PER_IPC_RESPONSE_V1,
      });
      cells.push(...result.cells);
    }
    if (supersededByCamera) {
      let latestDemand: ActiveCompiledBroadSurfaceDemandV1 | null;
      try {
        latestDemand = ready.renderer.getCompiledBroadSurfaceDemand(
          policy,
          ready.manifestResult.surfaceManifest.manifestFingerprint
        );
      } catch (error) {
        this.#reject('renderer-demand-failed', error);
        return 'failed';
      }
      const responseHasNewestOwner = Boolean(
        latestDemand &&
        (latestDemand.status === 'broad-ready' || latestDemand.status === 'detail-required') &&
        demand.some(
          (address) =>
            demandContainsForegroundCell(latestDemand!, address.cellId) ||
            (tier === 'interaction-prefetch' &&
              !demandHasMissingForegroundCells(latestDemand!) &&
              demandContainsCell(latestDemand!, address.cellId))
        )
      );
      if (!responseHasNewestOwner) {
        this.#stale(
          tier === 'prefetch'
            ? 'passive-cells-camera'
            : tier === 'successor'
              ? 'successor-cells-camera'
              : tier === 'control-prefetch'
                ? 'control-prefetch-cells-camera'
                : 'interaction-prefetch-cells-camera'
        );
        return 'superseded';
      }
    }
    if (this.#pendingAdmissionBatch) {
      this.#reject('renderer-admission-batch-overlap');
      return 'failed';
    }
    this.#pendingAdmissionBatch = {
      ready,
      policy: Object.freeze({ ...policy }),
      tier,
      cells: Object.freeze(cells),
      mayAdmitDuringInteraction,
      cancelOnCameraChange,
      supersededByCamera,
      nextCellIndex: 0,
      admittedCellCount: 0,
      admittedCellIds: [],
      supersededCellCount: 0,
    };
    this.#dependencies.recordEvent('compiled-broad-raster-cells-staged', {
      count: cells.length,
      demandEpoch,
      currentDemandEpoch: this.#demandEpoch,
      isoformMode: policy.isoformMode,
      tier,
    });
    this.#schedulePostPresentWork();
    return 'queued';
  }

  #drainPendingAdmissions(deadlineMs: number): void {
    const batch = this.#pendingAdmissionBatch;
    if (!batch) return;
    if (!this.#isCurrent(batch.ready)) {
      this.#dropPendingAdmissionBatch('target-superseded');
      return;
    }

    let latestDemand: ActiveCompiledBroadSurfaceDemandV1 | null;
    try {
      latestDemand = batch.ready.renderer.getCompiledBroadSurfaceDemand(
        batch.policy,
        batch.ready.manifestResult.surfaceManifest.manifestFingerprint
      );
    } catch (error) {
      this.#dropPendingAdmissionBatch('latest-demand-failed');
      this.#reject('renderer-demand-failed', error);
      return;
    }
    if (!latestDemand || latestDemand.status === 'camera-required') {
      this.#schedulePostPresentWork();
      return;
    }
    if (latestDemand.status !== 'broad-ready' && latestDemand.status !== 'detail-required') {
      this.#dropPendingAdmissionBatch(`latest-demand-${latestDemand.status}`);
      this.#reject(`renderer-demand-${latestDemand.status}`);
      return;
    }
    const demandFailure = this.#validateBroadReadyDemand(batch.ready, latestDemand, batch.policy);
    if (demandFailure || !latestDemand.demandLeaseId) {
      this.#dropPendingAdmissionBatch('latest-demand-identity-mismatch');
      this.#reject(demandFailure ?? 'renderer-demand-identity-mismatch');
      return;
    }

    let processedCellCount = 0;
    while (
      batch.nextCellIndex < batch.cells.length &&
      processedCellCount < COMPILED_BROAD_MAX_CELL_ADMISSIONS_PER_POST_PRESENT_SLICE &&
      this.#now() < deadlineMs
    ) {
      const cell = batch.cells[batch.nextCellIndex++]!;
      const stillOwned = batch.supersededByCamera
        ? demandContainsForegroundCell(latestDemand, cell.record.cellId) ||
          (batch.tier === 'interaction-prefetch' &&
            !demandHasMissingForegroundCells(latestDemand) &&
            demandContainsCell(latestDemand, cell.record.cellId))
        : demandContainsCell(latestDemand, cell.record.cellId);
      if (!stillOwned) {
        batch.supersededCellCount += 1;
        this.#obsoleteCellDropCount += 1;
        continue;
      }
      processedCellCount += 1;
      const identity = {
        demandLeaseId: latestDemand.demandLeaseId,
        manifestFingerprint: batch.ready.manifestResult.surfaceManifest.manifestFingerprint,
        cellId: cell.record.cellId,
        isoformMode: cell.record.isoformMode,
        level: cell.record.level,
        tileX: cell.record.tileX,
        laneSlabIndex: cell.record.laneSlabIndex,
      } as const;
      const admissionStartedAt = this.#now();
      const admission =
        cell.premultipliedRgba === null
          ? batch.ready.renderer.admitCompiledBroadSurfaceTransparentCell(identity)
          : batch.ready.renderer.admitCompiledBroadSurfaceRgbaCell({
              ...identity,
              widthPx: cell.record.widthPx,
              heightPx: cell.record.heightPx,
              premultipliedRgba: cell.premultipliedRgba,
            });
      if (admission.status === 'rejected') {
        this.#dropPendingAdmissionBatch('renderer-cell-rejected');
        this.#reject('renderer-cell-rejected', admission.reason);
        return;
      }
      if (admission.cellId !== undefined && admission.cellId !== identity.cellId) {
        this.#dropPendingAdmissionBatch('renderer-cell-identity-mismatch');
        this.#reject('renderer-cell-identity-mismatch');
        return;
      }
      batch.admittedCellCount += 1;
      batch.admittedCellIds.push(identity.cellId);
      this.#totalAdmittedCellCount += 1;
      this.#totalUploadedByteLength += admission.uploadedByteLength;
      this.#totalExplicitCopyByteLength += admission.explicitCopyByteLength;
      if (batch.nextCellIndex < batch.cells.length && Number.isFinite(deadlineMs)) {
        const admissionCompletedAt = this.#now();
        const observedAdmissionDurationMs = Math.max(0, admissionCompletedAt - admissionStartedAt);
        if (
          admissionCompletedAt +
            observedAdmissionDurationMs +
            COMPILED_BROAD_ADMISSION_DEADLINE_HEADROOM_MS >=
          deadlineMs
        ) {
          break;
        }
      }
    }

    if (batch.nextCellIndex < batch.cells.length) return;
    if (batch.supersededByCamera && batch.admittedCellIds.length === 0) {
      this.#dropPendingAdmissionBatch(
        batch.tier === 'prefetch'
          ? 'passive-warm-superseded-by-camera'
          : batch.tier === 'successor'
            ? 'successor-superseded-by-camera'
            : batch.tier === 'control-prefetch'
              ? 'control-prefetch-superseded-by-camera'
              : 'interaction-prefetch-superseded-by-camera'
      );
      return;
    }
    this.#completePendingAdmissionBatch(batch);
  }

  #completePendingAdmissionBatch(batch: PendingAdmissionBatchV1): void {
    if (this.#pendingAdmissionBatch !== batch) return;
    this.#pendingAdmissionBatch = null;
    this.#dependencies.recordEvent('compiled-broad-raster-cells-admitted', {
      admittedCount: batch.admittedCellCount,
      supersededCount: batch.supersededCellCount,
      count: batch.cells.length,
      isoformMode: batch.policy.isoformMode,
      tier: batch.tier,
    });
    if (batch.admittedCellCount > 0) this.#requestRender(batch.ready);
    this.#clearRepairRetry(true);
    void this.refreshDemand(false);
  }

  #dropPendingAdmissionBatch(reason: string): void {
    const batch = this.#pendingAdmissionBatch;
    if (!batch) return;
    this.#clearInteractionQuietAdmissionTimer();
    this.#pendingAdmissionBatch = null;
    this.#stagedCellDropCount += batch.cells.length - batch.nextCellIndex;
    this.#dependencies.recordEvent('compiled-broad-raster-staged-cells-dropped', {
      reason,
      remainingCount: batch.cells.length - batch.nextCellIndex,
      admittedCount: batch.admittedCellCount,
      supersededCount: batch.supersededCellCount,
    });
  }

  #schedulePostPresentWork(): void {
    if (this.#disposed || this.#postPresentWorkScheduled) return;
    this.#postPresentWorkScheduled = true;
    const lifecycle =
      this.#pendingAdmissionBatch?.ready.presentationLifecycle ??
      this.#ready?.presentationLifecycle;
    (lifecycle?.schedulePostPresentWork ?? this.#dependencies.schedulePostPresentWork)(
      this.drainPostPresentWork
    );
  }

  #requestRender(ready: ReadySurface | null = this.#ready): void {
    (ready?.presentationLifecycle.requestRender ?? this.#dependencies.requestRender)();
  }

  #rendererPresentationLifecycle(): Readonly<{
    renderer: CompiledBroadRasterRendererV1;
    requestRender: () => void;
    schedulePostPresentWork: (work: (deadlineMs: number) => void) => void;
  }> | null {
    const lifecycle = this.#dependencies.getRendererPresentationLifecycle?.() ?? null;
    if (lifecycle) return lifecycle;
    const renderer = this.#dependencies.getRenderer();
    return renderer
      ? {
          renderer,
          requestRender: this.#dependencies.requestRender,
          schedulePostPresentWork: this.#dependencies.schedulePostPresentWork,
        }
      : null;
  }

  #deferPassiveAdmissionsUntilInteractionQuiet(delayMs: number): void {
    if (this.#interactionQuietAdmissionTimer !== null || this.#disposed) return;
    const schedule = this.#dependencies.scheduleDelayedWork ?? setTimeout;
    this.#interactionQuietAdmissionTimer = schedule(
      () => {
        this.#interactionQuietAdmissionTimer = null;
        if (!this.#disposed && this.#pendingAdmissionBatch) this.#schedulePostPresentWork();
      },
      Math.max(1, Math.ceil(delayMs))
    );
  }

  #clearInteractionQuietAdmissionTimer(): void {
    if (this.#interactionQuietAdmissionTimer === null) return;
    (this.#dependencies.cancelDelayedWork ?? clearTimeout)(this.#interactionQuietAdmissionTimer);
    this.#interactionQuietAdmissionTimer = null;
  }

  #pendingAdmissionCellCount(): number {
    const batch = this.#pendingAdmissionBatch;
    return batch ? batch.cells.length - batch.nextCellIndex : 0;
  }

  #beginRepair(
    ready: ReadySurface,
    reason: string,
    retryAfterMs: number,
    error?: unknown,
    reprobe: 'cells' | 'catalog' = 'cells'
  ): void {
    if (!this.#isCurrent(ready)) return;
    this.#setReadiness('repairing');
    this.#setPolicyControlsReadiness('repairing');
    this.#dependencies.recordEvent('compiled-broad-raster-repairing', {
      reason,
      backoffExponent: this.#repairRetryBackoffExponent,
      retryAfterMs,
      ...(error === undefined ? undefined : { message: message(error) }),
    });
    this.#scheduleRepairReprobe(ready, retryAfterMs, reprobe);
  }

  #scheduleRepairReprobe(
    ready: ReadySurface,
    serverRetryAfterMs: number,
    reprobe: 'cells' | 'catalog' = 'cells'
  ): void {
    if (!this.#isCurrent(ready)) return;
    if (reprobe === 'catalog') this.#repairReprobeMode = 'catalog';
    else if (this.#repairReprobeMode === null) this.#repairReprobeMode = 'cells';
    if (this.#repairRetryTimer !== null) return;
    const exponent = this.#repairRetryBackoffExponent;
    this.#repairRetryBackoffExponent = Math.min(REPAIR_REPROBE_MAX_BACKOFF_EXPONENT, exponent + 1);
    const exponentialDelay = Math.min(
      REPAIR_REPROBE_MAX_DELAY_MS,
      REPAIR_REPROBE_BASE_DELAY_MS * 2 ** exponent
    );
    const delayMs = Math.max(
      REPAIR_REPROBE_BASE_DELAY_MS,
      Math.min(REPAIR_REPROBE_MAX_DELAY_MS, serverRetryAfterMs),
      exponentialDelay
    );
    this.#repairRetryTimer = setTimeout(() => {
      this.#repairRetryTimer = null;
      if (!this.#isCurrent(ready)) return;
      if (this.#repairReprobeMode === 'catalog') {
        void this.#reacquireCatalogAfterRepair(ready);
      } else {
        void this.refreshDemand(false);
      }
    }, delayMs);
  }

  async #reacquireCatalogAfterRepair(ready: ReadySurface): Promise<void> {
    if (!this.#isCurrent(ready)) return;
    const request: AssemblyCompiledBroadRasterManifestRequestV1 = {
      contract: ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
      scene: ready.target.sceneRequest,
    };
    let wireResult: AssemblyCompiledBroadRasterManifestResultV1 | null;
    try {
      wireResult = await this.#dependencies.readManifest(request);
    } catch (error) {
      if (!this.#isCurrent(ready)) {
        this.#stale('repair-manifest');
        return;
      }
      this.#dependencies.recordEvent('compiled-broad-raster-repair-reprobe-deferred', {
        reason: 'manifest-transport-failed',
        message: message(error),
      });
      this.#scheduleRepairReprobe(ready, 500, 'catalog');
      return;
    }
    if (!this.#isCurrent(ready)) {
      this.#stale('repair-manifest');
      return;
    }
    let result: AssemblyCompiledBroadRasterManifestResultV1 | null;
    try {
      result = await admitManifestResultFromIpc(wireResult);
    } catch (error) {
      if (!this.#isCurrent(ready)) {
        this.#stale('repair-manifest-admission');
        return;
      }
      this.#markRepairUnavailable('repair-surface-manifest-admission-failed');
      this.#dependencies.recordEvent('compiled-broad-raster-repair-manifest-rejected', {
        message: message(error),
      });
      return;
    }
    if (!this.#isCurrent(ready)) {
      this.#stale('repair-manifest-admission');
      return;
    }
    const failure = validateManifestResult(result, ready.target);
    if (failure === 'manifest-miss') {
      this.#dependencies.recordEvent('compiled-broad-raster-repair-reprobe-deferred', {
        reason: failure,
      });
      this.#scheduleRepairReprobe(ready, 500, 'catalog');
      return;
    }
    if (failure) {
      this.#markRepairUnavailable(`repair-${failure}`);
      return;
    }
    if (
      result!.catalogReceipt.receiptSha256 !== ready.manifestResult.catalogReceipt.receiptSha256 ||
      result!.catalogReceipt.catalogFingerprint !==
        ready.manifestResult.catalogReceipt.catalogFingerprint ||
      result!.catalogReceipt.surfaceManifestFingerprint !==
        ready.manifestResult.catalogReceipt.surfaceManifestFingerprint
    ) {
      this.#markRepairUnavailable('repair-catalog-revision-changed');
      return;
    }
    if (result!.catalogCapability.openingId === ready.manifestResult.catalogCapability.openingId) {
      this.#dependencies.recordEvent('compiled-broad-raster-repair-reprobe-deferred', {
        reason: 'catalog-capability-not-refreshed',
      });
      this.#scheduleRepairReprobe(ready, 500, 'catalog');
      return;
    }
    const refreshed: ReadySurface = {
      ...ready,
      manifestResult: result!,
    };
    this.#ready = refreshed;
    this.#dependencies.recordEvent('compiled-broad-raster-repair-catalog-reacquired', {
      catalogFingerprint: result!.catalogReceipt.catalogFingerprint,
      backoffExponent: this.#repairRetryBackoffExponent,
    });
    this.#clearRepairRetry(true);
    await this.refreshDemand(false);
  }

  #markRepairUnavailable(reason: string): void {
    this.#clearRepairRetry(false);
    this.#setReadiness('unavailable');
    this.#setPolicyControlsReadiness('unavailable');
    this.#dependencies.recordEvent('compiled-broad-raster-repair-unavailable', { reason });
  }

  #isCurrent(ready: ReadySurface): boolean {
    const projectedRenderer = this.#dependencies.getRenderer();
    return (
      !this.#disposed &&
      this.#ready === ready &&
      this.#generation === ready.generation &&
      this.#target?.identityKey === ready.identityKey &&
      (projectedRenderer === null || projectedRenderer === ready.renderer)
    );
  }

  #isStale(generation: number, identityKey: string): boolean {
    return (
      this.#disposed || generation !== this.#generation || this.#target?.identityKey !== identityKey
    );
  }

  #stale(phase: string): void {
    this.#staleResponseCount += 1;
    this.#dependencies.recordEvent('compiled-broad-raster-stale-response-dropped', { phase });
  }

  #reject(reason: string, error?: unknown): void {
    this.#lastRejection = Object.freeze({
      reason,
      message: error === undefined ? null : message(error),
      demandEpoch: this.#demandEpoch,
      observedAtMs: this.#now(),
    });
    this.#dropPendingAdmissionBatch(`rejected:${reason}`);
    this.#setReadiness('error');
    this.#setPolicyControlsReadiness('error');
    this.#dependencies.recordEvent('compiled-broad-raster-rejected', {
      reason,
      ...(error === undefined ? undefined : { message: message(error) }),
    });
  }

  #setReadiness(readiness: AssemblyCompiledBroadRasterReadinessV1): void {
    if (this.#readiness === readiness) return;
    this.#readiness = readiness;
    this.#readinessTransitionCount += 1;
    const readyAuthority = readiness === 'ready' ? this.#ready : null;
    this.#publishReadinessReceipt(readyAuthority);
  }

  #publishReadinessReceipt(readyAuthority: ReadySurface | null): void {
    this.#dependencies.onReadinessChange?.(
      Object.freeze({
        readiness: this.#readiness,
        commandKey: this.#target ? assemblyCompiledBroadRasterCommandKeyV1(this.#target) : null,
        commandRenderer: readyAuthority?.renderer ?? this.#requiredRenderer,
        targetIdentityKey: readyAuthority?.identityKey ?? this.#target?.identityKey ?? null,
        renderer: readyAuthority?.renderer ?? null,
        expectedInteractionOwnerKey:
          readyAuthority?.manifestResult.catalogReceipt.expectedInteractionOwnerKey ?? null,
        validatedSourceFingerprint:
          readyAuthority?.target.expectedAssetGeneration?.sourceFingerprint ?? null,
        admittedBroadCorridorFinestSpanBp:
          readyAuthority?.manifestResult.surfaceManifest.broadCorridorFinestSpanBp ?? null,
      })
    );
  }

  #setPolicyControlsReadiness(
    readiness: AssemblyCompiledBroadRasterPolicyControlsReadinessV1
  ): void {
    if (this.#policyControlsReadiness === readiness) return;
    this.#policyControlsReadiness = readiness;
    this.#policyControlsReadinessTransitionCount += 1;
    this.#dependencies.onPolicyControlsReadinessChange?.(readiness);
  }

  #hasTerminalFailure(): boolean {
    return (
      this.#readiness === 'error' ||
      this.#readiness === 'unavailable' ||
      this.#policyControlsReadiness === 'error' ||
      this.#policyControlsReadiness === 'unavailable'
    );
  }

  #resetIdleWarmPlan(): void {
    if (this.#idleWarmQuietTimer !== null) {
      (this.#dependencies.cancelDelayedWork ?? clearTimeout)(this.#idleWarmQuietTimer);
      this.#idleWarmQuietTimer = null;
    }
    this.#idleWarmEpoch += 1;
    this.#idleWarmPlanKey = null;
    this.#idleWarmStageIndex = 0;
    this.#idleWarmPending = false;
  }

  #scheduleDemandRetry(): void {
    if (this.#demandRetryTimer !== null || this.#disposed) return;
    this.#demandRetryTimer = setTimeout(() => {
      this.#demandRetryTimer = null;
      void this.refreshDemand(false);
    }, 16);
  }

  #clearDemandRetry(): void {
    if (this.#demandRetryTimer === null) return;
    clearTimeout(this.#demandRetryTimer);
    this.#demandRetryTimer = null;
  }

  #scheduleRendererRetry(generation: number, identityKey: string): void {
    if (this.#rendererRetryTimer !== null || this.#disposed) return;
    const schedule = this.#dependencies.scheduleDelayedWork ?? setTimeout;
    this.#rendererRetryTimer = schedule(() => {
      this.#rendererRetryTimer = null;
      const target = this.#target;
      if (
        this.#disposed ||
        this.#generation !== generation ||
        target?.identityKey !== identityKey
      ) {
        return;
      }
      void this.reconcile(target, true);
    }, 16);
  }

  #clearRendererRetry(): void {
    if (this.#rendererRetryTimer === null) return;
    (this.#dependencies.cancelDelayedWork ?? clearTimeout)(this.#rendererRetryTimer);
    this.#rendererRetryTimer = null;
  }

  #clearRepairRetry(resetBackoff: boolean): void {
    if (this.#repairRetryTimer !== null) {
      clearTimeout(this.#repairRetryTimer);
      this.#repairRetryTimer = null;
    }
    this.#repairReprobeMode = null;
    if (resetBackoff) this.#repairRetryBackoffExponent = 0;
  }

  #abortManifestPublication(): void {
    this.#manifestPublicationController?.abort();
    this.#manifestPublicationController = null;
  }

  #armRendererRequirement(
    renderer: CompiledBroadRasterRendererV1,
    requirement: AssemblyCompiledBroadRasterRequirementV1
  ): boolean {
    const broadCorridorFinestSpanBp = assemblyCompiledBroadRasterFinestSpanBpV1(
      requirement.genomeLengthBp
    );
    if (
      this.#requiredRenderer === renderer &&
      this.#requiredGenomeLengthBp === requirement.genomeLengthBp
    ) {
      return true;
    }
    if (
      !renderer.requireCompiledBroadSurface({
        genomeLengthBp: requirement.genomeLengthBp,
        broadCorridorFinestSpanBp,
      })
    ) {
      this.#reject('renderer-requirement-rejected');
      return false;
    }
    this.#requiredRenderer = renderer;
    this.#requiredGenomeLengthBp = requirement.genomeLengthBp;
    this.#dependencies.recordEvent('compiled-broad-raster-requirement-armed', {
      identityKey: requirement.identityKey,
      genomeLengthBp: requirement.genomeLengthBp,
      broadCorridorFinestSpanBp,
    });
    return true;
  }
}

async function admitManifestResultFromIpc(
  result: AssemblyCompiledBroadRasterManifestResultV1 | null
): Promise<AssemblyCompiledBroadRasterManifestResultV1 | null> {
  if (!result) return null;
  const surfaceManifest = await admitCompiledBroadSurfaceManifestV2(result.surfaceManifest);
  return Object.freeze({
    contract: result.contract,
    catalogReceipt: Object.freeze({ ...result.catalogReceipt }),
    catalogCapability: Object.freeze({ ...result.catalogCapability }),
    surfaceManifest,
  });
}

function compiledBroadSurfaceProvenanceForManifestResult(
  result: AssemblyCompiledBroadRasterManifestResultV1
): CompiledBroadSurfaceAdmissionProvenanceV1 {
  return Object.freeze({
    contract: COMPILED_BROAD_SURFACE_ADMISSION_PROVENANCE_V1,
    manifestFingerprint: result.surfaceManifest.manifestFingerprint,
    artifactKey: result.surfaceManifest.artifactKey,
    trackId: result.surfaceManifest.trackId,
    genomeIdentity: result.catalogReceipt.genomeIdentity,
    genomeLengthBp: result.catalogReceipt.genomeLengthBp,
    sourceFingerprint: result.catalogReceipt.sourceFingerprint,
    placementFingerprint: result.catalogReceipt.placementFingerprint,
    themeMode: result.catalogReceipt.themeMode,
    prepackedOwnerKey: result.catalogReceipt.expectedInteractionOwnerKey,
    prepackedArtifactKey: result.catalogReceipt.sceneArtifactKey,
    ...(result.catalogReceipt.roleTable
      ? { roleTable: Object.freeze([...result.catalogReceipt.roleTable]) }
      : {}),
  });
}

function validateManifestResult(
  result: AssemblyCompiledBroadRasterManifestResultV1 | null,
  target: AssemblyCompiledBroadRasterLoaderTargetV1
): string | null {
  if (!result) return 'manifest-miss';
  if (result.contract !== COMPILED_BROAD_RASTER_ARTIFACT_WIRE_V1) {
    return 'manifest-contract-mismatch';
  }
  const receipt = result.catalogReceipt;
  const capability = result.catalogCapability;
  const surface = result.surfaceManifest;
  if (
    receipt?.contract !== ASSEMBLY_COMPILED_BROAD_RASTER_CATALOG_RECEIPT_V1 ||
    capability?.contract !== ASSEMBLY_COMPILED_BROAD_RASTER_CATALOG_CAPABILITY_V1
  ) {
    return 'catalog-authority-contract-mismatch';
  }
  if (
    !isSha256(receipt.receiptSha256) ||
    !isSha256(receipt.catalogFingerprint) ||
    !isSha256(receipt.surfaceManifestFingerprint) ||
    !isSha256(receipt.scenePayloadSha256) ||
    !isSha256(receipt.sceneContractSha256) ||
    !/^[0-9a-f]{24}$/.test(receipt.sourceFingerprint) ||
    !capability.openingId ||
    /[\r\n]/.test(capability.openingId) ||
    !sameCatalogCapability(capability, {
      contract: ASSEMBLY_COMPILED_BROAD_RASTER_CATALOG_CAPABILITY_V1,
      openingId: capability.openingId,
      catalogReceiptSha256: receipt.receiptSha256,
      catalogFingerprint: receipt.catalogFingerprint,
      surfaceManifestFingerprint: receipt.surfaceManifestFingerprint,
    })
  ) {
    return 'catalog-authority-invalid';
  }
  const expectedInteractionOwnerKey = assemblyAnnotationSceneInteractionOwnerKeyV3({
    sourceFingerprint: receipt.sourceFingerprint,
    scenePayloadSha256: receipt.scenePayloadSha256,
    sceneArtifactKey: receipt.sceneArtifactKey,
  });
  if (
    receipt.genomeIdentity !== target.genomeIdentity ||
    receipt.genomeLengthBp !== target.genomeLengthBp ||
    receipt.placementFingerprint !== target.placementFingerprint ||
    receipt.sceneArtifactKey !== target.artifact.artifactKey ||
    receipt.themeMode !== target.artifact.themeMode ||
    !expectedGenerationMatchesManifest(target, result) ||
    receipt.trackId !== target.artifact.trackType ||
    !receiptPixelFormatIsAdmissible(receipt) ||
    receipt.bytesPerPixel !== 4 ||
    !receipt.sceneSourceBuildFingerprint ||
    /[\r\n]/.test(receipt.sceneSourceBuildFingerprint) ||
    expectedInteractionOwnerKey === null ||
    receipt.expectedInteractionOwnerKey !== expectedInteractionOwnerKey
  ) {
    return 'catalog-receipt-provenance-mismatch';
  }
  if (
    surface.manifestFingerprint !== receipt.surfaceManifestFingerprint ||
    surface.artifactKey !== receipt.surfaceArtifactKey ||
    surface.trackId !== receipt.trackId ||
    surface.genomeLengthBp !== receipt.genomeLengthBp ||
    surface.rasterDevicePixelRatio !== receipt.rasterDevicePixelRatio ||
    surface.broadTilePhysicalWidthPx !== receipt.tileContentWidthPx ||
    surface.broadTileXGuardPhysicalPx !== receipt.tileGuardWidthPx ||
    surface.laneSlabRowCount !== receipt.laneSlabRowCount ||
    surface.laneRowTextureStridePx !== receipt.laneRowTextureStridePx ||
    receipt.cellCount !== exactSurfaceCellCount(surface)
  ) {
    return 'surface-manifest-mismatch';
  }
  const width = surface.broadTilePhysicalWidthPx + surface.broadTileXGuardPhysicalPx * 2;
  const height = surface.laneSlabRowCount * surface.laneRowTextureStridePx;
  if (receipt.storedCellWidthPx !== width || receipt.storedCellHeightPx !== height) {
    return 'surface-cell-dimensions-mismatch';
  }
  return null;
}

function exactSurfaceCellCount(manifest: CompiledBroadSurfaceManifestV2): number {
  const cellsPerSlab = manifest.levels.reduce((total, level) => total + level.tileCount, 0);
  return cellsPerSlab * (manifest.laneSlabs.canonical.length + manifest.laneSlabs.expanded.length);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function sameCatalogCapability(
  value: AssemblyCompiledBroadRasterCatalogCapabilityV1 | null | undefined,
  expected: AssemblyCompiledBroadRasterCatalogCapabilityV1
): boolean {
  return Boolean(
    value &&
    value.contract === ASSEMBLY_COMPILED_BROAD_RASTER_CATALOG_CAPABILITY_V1 &&
    value.openingId === expected.openingId &&
    value.catalogReceiptSha256 === expected.catalogReceiptSha256 &&
    value.catalogFingerprint === expected.catalogFingerprint &&
    value.surfaceManifestFingerprint === expected.surfaceManifestFingerprint
  );
}

function validateDemandAddress(
  manifest: CompiledBroadSurfaceManifestV2,
  address: ActiveCompiledBroadSurfaceDemandAddressV1,
  expectedMode: BroadSurfaceIsoformModeV2
): string | null {
  if (address.isoformMode !== expectedMode) return 'renderer-demand-policy-mismatch';
  let cellId: string;
  try {
    cellId = compiledBroadSurfaceCellIdV2({ manifest, ...address });
  } catch {
    return 'renderer-demand-address-invalid';
  }
  return cellId === address.cellId ? null : 'renderer-demand-cell-id-mismatch';
}

function demandContainsCell(demand: ActiveCompiledBroadSurfaceDemandV1, cellId: string): boolean {
  for (const address of demand.requiredCellAddresses) {
    if (address.cellId === cellId) return true;
  }
  for (const address of demand.successorCellAddresses) {
    if (address.cellId === cellId) return true;
  }
  for (const address of demand.interactionPrefetchCellAddresses) {
    if (address.cellId === cellId) return true;
  }
  for (const address of demand.prefetchCellAddresses) {
    if (address.cellId === cellId) return true;
  }
  return false;
}

function demandContainsForegroundCell(
  demand: ActiveCompiledBroadSurfaceDemandV1,
  cellId: string
): boolean {
  for (const address of demand.missingRequiredCellAddresses) {
    if (address.cellId === cellId) return true;
  }
  for (const address of demand.missingSuccessorCellAddresses) {
    if (address.cellId === cellId) return true;
  }
  return false;
}

function demandHasMissingForegroundCells(demand: ActiveCompiledBroadSurfaceDemandV1): boolean {
  return (
    demand.missingRequiredCellAddresses.length > 0 ||
    demand.missingSuccessorCellAddresses.length > 0
  );
}

function validateCellResult(
  result: AssemblyCompiledBroadRasterCellsReadyResultV1,
  manifestResult: AssemblyCompiledBroadRasterManifestResultV1,
  requested: readonly ActiveCompiledBroadSurfaceDemandAddressV1[]
): string | null {
  if (
    requested.length !== ASSEMBLY_COMPILED_BROAD_RASTER_MAX_CELLS_PER_IPC_RESPONSE_V1 ||
    result.cells.length > ASSEMBLY_COMPILED_BROAD_RASTER_MAX_CELLS_PER_IPC_RESPONSE_V1
  ) {
    return 'cell-transport-bound-exceeded';
  }
  if (result.contract !== ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1) {
    return 'cell-contract-mismatch';
  }
  if (!sameCatalogCapability(result.catalogCapability, manifestResult.catalogCapability)) {
    return 'cell-catalog-capability-mismatch';
  }
  if (result.cells.length !== requested.length) return 'cell-roster-incomplete';
  const requestedById = new Map(requested.map((address) => [address.cellId, address]));
  const seen = new Set<string>();
  for (const cell of result.cells) {
    const expected = requestedById.get(cell.record.cellId);
    if (!expected || seen.has(cell.record.cellId)) return 'cell-roster-mismatch';
    seen.add(cell.record.cellId);
    if (
      cell.record.isoformMode !== expected.isoformMode ||
      cell.record.level !== expected.level ||
      cell.record.tileX !== expected.tileX ||
      cell.record.laneSlabIndex !== expected.laneSlabIndex ||
      cell.record.trackId !== manifestResult.surfaceManifest.trackId ||
      cell.record.widthPx !== manifestResult.catalogReceipt.storedCellWidthPx ||
      cell.record.heightPx !== manifestResult.catalogReceipt.storedCellHeightPx
    ) {
      return 'cell-payload-mismatch';
    }
    if (cell.record.occupancy === COMPILED_BROAD_RASTER_OCCUPANCY_RGBA8_WIRE_V1) {
      if (
        cell.record.decodedByteLength !==
          manifestResult.catalogReceipt.storedCellWidthPx *
            manifestResult.catalogReceipt.storedCellHeightPx *
            manifestResult.catalogReceipt.bytesPerPixel ||
        !/^[0-9a-f]{64}$/.test(cell.record.decodedSha256) ||
        !(cell.premultipliedRgba instanceof Uint8Array) ||
        cell.premultipliedRgba.byteLength !== cell.record.decodedByteLength
      ) {
        return 'cell-payload-mismatch';
      }
    } else if (cell.record.occupancy === COMPILED_BROAD_RASTER_OCCUPANCY_TRANSPARENT_WIRE_V1) {
      if (
        cell.record.decodedByteLength !== 0 ||
        cell.record.decodedSha256 !== null ||
        cell.premultipliedRgba !== null
      ) {
        return 'cell-payload-mismatch';
      }
    } else {
      return 'cell-payload-mismatch';
    }
  }
  return null;
}

function freezeTarget(
  target: AssemblyCompiledBroadRasterLoaderTargetV1
): AssemblyCompiledBroadRasterLoaderTargetV1 {
  return Object.freeze({
    ...target,
    expectedAssetGeneration: target.expectedAssetGeneration
      ? Object.freeze({ ...target.expectedAssetGeneration })
      : null,
    policyRequestId: target.policyRequestId ?? null,
    policy: Object.freeze({ ...target.policy }),
  });
}

function sameExpectedAssetGeneration(
  left: AssemblyReferenceAssetGenerationV1 | null,
  right: AssemblyReferenceAssetGenerationV1 | null
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.contract === right.contract &&
      left.sourceFingerprint === right.sourceFingerprint &&
      left.inventoryFingerprint === right.inventoryFingerprint &&
      left.themeMode === right.themeMode)
  );
}

function expectedGenerationMatchesManifest(
  target: AssemblyCompiledBroadRasterLoaderTargetV1,
  result: AssemblyCompiledBroadRasterManifestResultV1
): boolean {
  const expected = target.expectedAssetGeneration;
  return (
    !expected ||
    (expected.sourceFingerprint === result.catalogReceipt.sourceFingerprint &&
      expected.themeMode === result.catalogReceipt.themeMode)
  );
}

export function assemblyCompiledBroadRasterCommandKeyV1(
  target: AssemblyCompiledBroadRasterLoaderTargetV1
): string {
  const generation = target.expectedAssetGeneration;
  return JSON.stringify([
    target.identityKey,
    generation?.sourceFingerprint ?? null,
    generation?.inventoryFingerprint ?? null,
    generation?.themeMode ?? null,
    target.policy.isoformMode,
    target.policy.laneLimit,
    target.policyRequestId ?? null,
  ]);
}

function sameTargetCommand(
  left: AssemblyCompiledBroadRasterLoaderTargetV1,
  right: AssemblyCompiledBroadRasterLoaderTargetV1
): boolean {
  return (
    left.identityKey === right.identityKey &&
    left.policy.isoformMode === right.policy.isoformMode &&
    left.policy.laneLimit === right.policy.laneLimit &&
    (left.policyRequestId ?? null) === (right.policyRequestId ?? null)
  );
}

function sameRuntimePolicy(
  left: AssemblyAnnotationRuntimePolicy,
  right: AssemblyAnnotationRuntimePolicy
): boolean {
  return left.isoformMode === right.isoformMode && left.laneLimit === right.laneLimit;
}

function compiledBroadRasterPolicyKey(
  manifestFingerprint: string,
  policy: AssemblyAnnotationRuntimePolicy
): string {
  return `${manifestFingerprint}\n${policy.isoformMode}\n${policy.laneLimit ?? 'all'}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function receiptPixelFormatIsAdmissible(
  receipt: AssemblyCompiledBroadRasterManifestResultV1['catalogReceipt']
): boolean {
  if (receipt.pixelFormat === COMPILED_BROAD_RASTER_PIXEL_FORMAT_WIRE_V1) {
    return receipt.roleTable === undefined;
  }
  const roles = receipt.roleTable;
  return (
    receipt.pixelFormat === COMPILED_BROAD_RASTER_PIXEL_FORMAT_ROLE_WEIGHTS_WIRE_V1 &&
    Array.isArray(roles) &&
    roles.length > 0 &&
    roles.length <= 4 &&
    roles.every(isAnnotationColorRoleKeyV1) &&
    new Set(roles).size === roles.length
  );
}
