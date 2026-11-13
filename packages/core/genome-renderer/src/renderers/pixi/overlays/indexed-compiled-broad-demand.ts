import type { CompiledBroadSurfaceCellDemandAddressV2 } from './annotation-compiled-broad-address';
import { compiledBroadDemandEarlyStatus } from './indexed-compiled-broad-demand-status';
import { collectCompiledBroadReadyDemandCells } from './indexed-compiled-broad-demand-collect';
import { collectCompiledBroadDetailHandoffCells } from './indexed-compiled-broad-detail-handoff';
import {
  COMPILED_BROAD_SURFACE_DEMAND_LEASE_V1,
  compiledBroadDemandLeaseId,
} from './indexed-compiled-broad-lease';
import {
  COMPILED_BROAD_SURFACE_MAX_FINITE_LANE_LIMIT_V2,
  compiledBroadSurfaceOwnsViewportV2,
  deriveBroadSurfacePresentationPlanV2,
  type BroadSurfaceIsoformModeV2,
  type BroadSurfacePresentationPlanV2,
  type CompiledBroadSurfaceAdmissionProvenanceV1,
  type CompiledBroadSurfaceManifestV2,
} from '../overview/bounded-annotation-broad-surface';
import type { AnnotationPolicyGpuRuntimeV1 } from '../overview/annotation-policy-gpu-instances-v1';
import { validatePrepackedAnnotationRuntimePolicy } from '../overview/prepacked-annotation-scene';
import type { PrepackedViewportDetailLease } from './indexed-prepacked-resident-selection';

export const COMPILED_BROAD_SURFACE_DEMAND_V2 = 'compiled-broad-surface-demand.v2' as const;

export type CompiledBroadSurfaceDemandStatusV2 =
  | 'not-loaded'
  | 'camera-required'
  | 'detail-required'
  | 'broad-artifact-required'
  | 'broad-ready'
  | 'rejected';

export interface CompiledBroadSurfaceDemandV2 {
  readonly contract: typeof COMPILED_BROAD_SURFACE_DEMAND_V2;
  readonly status: CompiledBroadSurfaceDemandStatusV2;
  readonly demandLeaseId: string | null;
  readonly cameraEpoch: number | null;
  readonly manifestFingerprint: string | null;
  readonly artifactKey: string | null;
  readonly trackId: string | null;
  readonly isoformMode: BroadSurfaceIsoformModeV2 | null;
  readonly laneLimit: number | null;
  readonly viewportStartBp: number | null;
  readonly viewportEndBp: number | null;
  readonly viewportCssWidthPx: number | null;
  readonly devicePixelRatio: number | null;
  readonly requiredCellAddresses: readonly CompiledBroadSurfaceCellDemandAddressV2[];
  readonly missingRequiredCellAddresses: readonly CompiledBroadSurfaceCellDemandAddressV2[];
  readonly successorCellAddresses: readonly CompiledBroadSurfaceCellDemandAddressV2[];
  readonly missingSuccessorCellAddresses: readonly CompiledBroadSurfaceCellDemandAddressV2[];
  readonly interactionPrefetchCellAddresses: readonly CompiledBroadSurfaceCellDemandAddressV2[];
  readonly missingInteractionPrefetchCellAddresses: readonly CompiledBroadSurfaceCellDemandAddressV2[];
  readonly prefetchCellAddresses: readonly CompiledBroadSurfaceCellDemandAddressV2[];
  readonly missingPrefetchCellAddresses: readonly CompiledBroadSurfaceCellDemandAddressV2[];
  readonly missingCellAddresses: readonly CompiledBroadSurfaceCellDemandAddressV2[];
}

export type CompiledBroadSurfaceDemandLeaseV1 = {
  readonly contract: typeof COMPILED_BROAD_SURFACE_DEMAND_LEASE_V1;
  readonly leaseId: string;
  readonly cameraEpoch: number;
  readonly manifestFingerprint: string;
  readonly isoformMode: BroadSurfaceIsoformModeV2;
  readonly laneLimit: number | null;
  readonly allowedCellIds: ReadonlySet<string>;
};

export type CompiledBroadSurfaceReadyDetailDemandV1 = {
  readonly manifestFingerprint: string;
  readonly isoformMode: BroadSurfaceIsoformModeV2;
  readonly laneLimit: number | null;
  readonly viewportDetail: PrepackedViewportDetailLease;
};

export type CompiledBroadDemandCamera = {
  viewportStartBp: number;
  viewportEndBp: number;
  viewportCssWidthPx: number;
  devicePixelRatio: number;
};

export type CompiledBroadDemandPresenter = {
  reserveCorridorPresentationCapacity(input: {
    viewportCssWidthPx: number;
    devicePixelRatio: number;
    maximumLaneLimit: number;
  }): boolean;
  reservePresentationCapacity(plan: BroadSurfacePresentationPlanV2): boolean;
  hasResidentCell(cellId: string): boolean;
};

export type CompiledBroadDemandOwner = {
  manifest: CompiledBroadSurfaceManifestV2;
  presenter: CompiledBroadDemandPresenter;
  provenance: CompiledBroadSurfaceAdmissionProvenanceV1;
};

export type CompiledBroadDemandHost = {
  readonly cameraEpoch: number;
  readonly lastCamera: CompiledBroadDemandCamera | null;
  readonly runtimePolicy: AnnotationPolicyGpuRuntimeV1 | null;
  readonly maxAnnotationLane: number;
  readonly candidateManifest: CompiledBroadSurfaceManifestV2 | null;
  readonly candidatePresenter: CompiledBroadDemandPresenter | null;
  readonly candidateProvenance: CompiledBroadSurfaceAdmissionProvenanceV1 | null;
  readonly currentManifest: CompiledBroadSurfaceManifestV2 | null;
  readonly currentPresenter: CompiledBroadDemandPresenter | null;
  readonly currentProvenance: CompiledBroadSurfaceAdmissionProvenanceV1 | null;
  admissionOwner(manifestFingerprint: string): CompiledBroadDemandOwner | null;
  provenanceIsCurrent(
    manifest: CompiledBroadSurfaceManifestV2,
    provenance: CompiledBroadSurfaceAdmissionProvenanceV1 | null
  ): boolean;
  incrementPlanDerivationCount(): void;
  viewportDetailForOwnerKey(ownerKey: string): PrepackedViewportDetailLease | undefined;
  rememberReadyDetailDemand(demand: CompiledBroadSurfaceReadyDetailDemandV1): void;
  forgetReadyDetailDemand(manifestFingerprint: string): void;
  demandLease?(leaseId: string): CompiledBroadSurfaceDemandLeaseV1 | undefined;
  storeDemandLease(lease: CompiledBroadSurfaceDemandLeaseV1): void;
};

type BroadDemandGeometry = {
  requiredCellAddresses: readonly CompiledBroadSurfaceCellDemandAddressV2[];
  successorCellAddresses: readonly CompiledBroadSurfaceCellDemandAddressV2[];
  interactionPrefetchCellAddresses: readonly CompiledBroadSurfaceCellDemandAddressV2[];
  prefetchCellAddresses: readonly CompiledBroadSurfaceCellDemandAddressV2[];
  allowedCellIds: ReadonlySet<string>;
};

type DemandPlanEntry = {
  manifest: CompiledBroadSurfaceManifestV2;
  plan: ReturnType<typeof deriveBroadSurfacePresentationPlanV2>;
  geometry?: BroadDemandGeometry;
};

const demandPlanCaches = new WeakMap<
  CompiledBroadDemandHost,
  {
    cameraEpoch: number;
    camera: CompiledBroadDemandCamera;
    entries: Map<string, DemandPlanEntry>;
  }
>();

function demandPlanCache(host: CompiledBroadDemandHost, camera: CompiledBroadDemandCamera) {
  const cached = demandPlanCaches.get(host);
  if (
    cached &&
    cached.cameraEpoch === host.cameraEpoch &&
    cached.camera.viewportStartBp === camera.viewportStartBp &&
    cached.camera.viewportEndBp === camera.viewportEndBp &&
    cached.camera.viewportCssWidthPx === camera.viewportCssWidthPx &&
    cached.camera.devicePixelRatio === camera.devicePixelRatio
  )
    return cached.entries;
  const entries = new Map<string, DemandPlanEntry>();
  demandPlanCaches.set(host, { cameraEpoch: host.cameraEpoch, camera: { ...camera }, entries });
  return entries;
}

export function mintCompiledBroadSurfaceDemandLease(
  host: Pick<CompiledBroadDemandHost, 'cameraEpoch' | 'demandLease' | 'storeDemandLease'>,
  input: {
    manifestFingerprint: string;
    isoformMode: BroadSurfaceIsoformModeV2;
    laneLimit: number | null;
    allowedCellIds: ReadonlySet<string>;
  }
): string {
  const leaseId = compiledBroadDemandLeaseId({
    cameraEpoch: host.cameraEpoch,
    manifestFingerprint: input.manifestFingerprint,
    isoformMode: input.isoformMode,
    laneLimit: input.laneLimit,
  });
  const existing = host.demandLease?.(leaseId);
  if (existing && existing.allowedCellIds.size === input.allowedCellIds.size) {
    let unchanged = true;
    for (const cellId of input.allowedCellIds) {
      if (!existing.allowedCellIds.has(cellId)) {
        unchanged = false;
        break;
      }
    }
    if (unchanged) return leaseId;
  }
  host.storeDemandLease(
    Object.freeze({
      contract: COMPILED_BROAD_SURFACE_DEMAND_LEASE_V1,
      leaseId,
      cameraEpoch: host.cameraEpoch,
      manifestFingerprint: input.manifestFingerprint,
      isoformMode: input.isoformMode,
      laneLimit: input.laneLimit,
      allowedCellIds: new Set(input.allowedCellIds),
    })
  );
  return leaseId;
}

export function getCompiledBroadSurfaceDemand(
  host: CompiledBroadDemandHost,
  policy?: AnnotationPolicyGpuRuntimeV1,
  manifestFingerprint?: string
): CompiledBroadSurfaceDemandV2 {
  const requestedOwner = manifestFingerprint ? host.admissionOwner(manifestFingerprint) : null;
  const manifest = requestedOwner
    ? requestedOwner.manifest
    : (host.candidateManifest ?? host.currentManifest);
  const presenter = requestedOwner
    ? requestedOwner.presenter
    : (host.candidatePresenter ?? host.currentPresenter);
  const provenance = requestedOwner
    ? requestedOwner.provenance
    : host.candidatePresenter
      ? host.candidateProvenance
      : host.currentProvenance;
  const camera = host.lastCamera;
  const empty = Object.freeze([]) as readonly CompiledBroadSurfaceCellDemandAddressV2[];
  const base = {
    contract: COMPILED_BROAD_SURFACE_DEMAND_V2,
    demandLeaseId: null,
    cameraEpoch: camera ? host.cameraEpoch : null,
    manifestFingerprint: manifest?.manifestFingerprint ?? null,
    artifactKey: manifest?.artifactKey ?? null,
    trackId: manifest?.trackId ?? null,
    isoformMode: null,
    laneLimit: null,
    viewportStartBp: camera?.viewportStartBp ?? null,
    viewportEndBp: camera?.viewportEndBp ?? null,
    viewportCssWidthPx: camera?.viewportCssWidthPx ?? null,
    devicePixelRatio: camera?.devicePixelRatio ?? null,
    requiredCellAddresses: empty,
    missingRequiredCellAddresses: empty,
    successorCellAddresses: empty,
    missingSuccessorCellAddresses: empty,
    interactionPrefetchCellAddresses: empty,
    missingInteractionPrefetchCellAddresses: empty,
    prefetchCellAddresses: empty,
    missingPrefetchCellAddresses: empty,
    missingCellAddresses: empty,
  } as const;
  const resolvedPolicy = policy ??
    host.runtimePolicy ?? {
      isoformMode: 'canonical' as const,
      laneLimit: Math.max(1, host.maxAnnotationLane + 1),
    };
  const identifiedBase = {
    ...base,
    isoformMode: resolvedPolicy.isoformMode,
    laneLimit: resolvedPolicy.laneLimit,
  } as const;
  const earlyStatus = compiledBroadDemandEarlyStatus({
    hasManifest: Boolean(manifest),
    hasPresenter: Boolean(presenter),
    provenanceCurrent: Boolean(manifest && host.provenanceIsCurrent(manifest, provenance)),
    policyValid: validatePrepackedAnnotationRuntimePolicy(resolvedPolicy),
    hasCamera: Boolean(camera),
  });
  if (earlyStatus?.status === 'not-loaded') {
    demandPlanCaches.delete(host);
    return Object.freeze({ ...base, status: 'not-loaded' });
  }
  if (earlyStatus?.status === 'rejected') {
    demandPlanCaches.delete(host);
    return Object.freeze({
      ...(earlyStatus.withPolicy ? identifiedBase : base),
      status: 'rejected',
    });
  }
  if (earlyStatus?.status === 'camera-required') {
    return Object.freeze({ ...identifiedBase, status: 'camera-required' });
  }
  const readyManifest = manifest!;
  const readyPresenter = presenter!;
  const readyCamera = camera!;
  const planCache = demandPlanCache(host, readyCamera);
  const planKey = compiledBroadDemandLeaseId({
    cameraEpoch: host.cameraEpoch,
    manifestFingerprint: readyManifest.manifestFingerprint,
    isoformMode: resolvedPolicy.isoformMode,
    laneLimit: resolvedPolicy.laneLimit,
  });
  let entry = planCache.get(planKey);
  try {
    if (!entry || entry.manifest !== readyManifest) {
      host.incrementPlanDerivationCount();
      entry = {
        manifest: readyManifest,
        plan: deriveBroadSurfacePresentationPlanV2({
          manifest: readyManifest,
          isoformMode: resolvedPolicy.isoformMode,
          laneLimit: resolvedPolicy.laneLimit,
          ...readyCamera,
        }),
      };
      if (planCache.size >= 8) planCache.delete(planCache.keys().next().value!);
      planCache.set(planKey, entry);
    }
  } catch {
    return Object.freeze({ ...identifiedBase, status: 'rejected' });
  }
  const plan = entry.plan;
  if (plan.status !== 'broad-ready' && plan.status !== 'detail-required') {
    return Object.freeze({ ...identifiedBase, status: plan.status });
  }
  if (
    !readyPresenter.reserveCorridorPresentationCapacity({
      viewportCssWidthPx: readyCamera.viewportCssWidthPx,
      devicePixelRatio: readyCamera.devicePixelRatio,
      maximumLaneLimit: COMPILED_BROAD_SURFACE_MAX_FINITE_LANE_LIMIT_V2,
    })
  ) {
    return Object.freeze({ ...identifiedBase, status: 'rejected' });
  }
  if (plan.status === 'broad-ready' && !readyPresenter.reservePresentationCapacity(plan)) {
    return Object.freeze({ ...identifiedBase, status: 'rejected' });
  }

  const cellReady = (cellId: string): boolean => readyPresenter.hasResidentCell(cellId);
  if (plan.status === 'detail-required') {
    const detail = provenance
      ? host.viewportDetailForOwnerKey(provenance.prepackedOwnerKey)
      : undefined;
    const detailHandoff = collectCompiledBroadDetailHandoffCells({
      detail,
      planStatus: plan.status,
      ownsViewport: compiledBroadSurfaceOwnsViewportV2({
        broadCorridorFinestSpanBp: readyManifest.broadCorridorFinestSpanBp,
        viewportSpanBp: readyManifest.genomeLengthBp,
        viewportCssWidthPx: readyCamera.viewportCssWidthPx,
        devicePixelRatio: readyCamera.devicePixelRatio,
      }),
      manifest: readyManifest,
      planIsoformMode: plan.isoformMode,
      resolvedPolicy,
      camera: readyCamera,
    });
    if (detailHandoff.status === 'rejected') {
      return Object.freeze({ ...identifiedBase, status: 'rejected' });
    }
    const detailHandoffById =
      detailHandoff.status === 'ok'
        ? detailHandoff.handoffById
        : new Map<string, CompiledBroadSurfaceCellDemandAddressV2>();
    const detailInteractionPrefetchById =
      detailHandoff.status === 'ok'
        ? detailHandoff.interactionPrefetchById
        : new Map<string, CompiledBroadSurfaceCellDemandAddressV2>();
    const successorCellAddresses = Object.freeze([...detailHandoffById.values()]);
    const missingSuccessorCellAddresses = Object.freeze(
      successorCellAddresses.filter(({ cellId }) => !cellReady(cellId))
    );
    const interactionPrefetchCellAddresses = Object.freeze([
      ...detailInteractionPrefetchById.values(),
    ]);
    const missingInteractionPrefetchCellAddresses = Object.freeze(
      interactionPrefetchCellAddresses.filter(({ cellId }) => !cellReady(cellId))
    );
    const demandLeaseId = mintCompiledBroadSurfaceDemandLease(host, {
      manifestFingerprint: readyManifest.manifestFingerprint,
      isoformMode: resolvedPolicy.isoformMode,
      laneLimit: resolvedPolicy.laneLimit,
      allowedCellIds: new Set([
        ...detailHandoffById.keys(),
        ...detailInteractionPrefetchById.keys(),
      ]),
    });
    if (
      detail &&
      missingSuccessorCellAddresses.length === 0 &&
      missingInteractionPrefetchCellAddresses.length === 0
    ) {
      host.rememberReadyDetailDemand(
        Object.freeze({
          manifestFingerprint: readyManifest.manifestFingerprint,
          isoformMode: resolvedPolicy.isoformMode,
          laneLimit: resolvedPolicy.laneLimit,
          viewportDetail: detail,
        })
      );
    } else {
      host.forgetReadyDetailDemand(readyManifest.manifestFingerprint);
    }
    return Object.freeze({
      ...identifiedBase,
      status: 'detail-required',
      demandLeaseId,
      requiredCellAddresses: empty,
      missingRequiredCellAddresses: empty,
      successorCellAddresses,
      missingSuccessorCellAddresses,
      interactionPrefetchCellAddresses,
      missingInteractionPrefetchCellAddresses,
      prefetchCellAddresses: empty,
      missingPrefetchCellAddresses: empty,
      missingCellAddresses: Object.freeze([
        ...missingSuccessorCellAddresses,
        ...missingInteractionPrefetchCellAddresses,
      ]),
    });
  }

  if (!entry.geometry) {
    const demandCells = collectCompiledBroadReadyDemandCells({
      manifest: readyManifest,
      plan,
      camera: readyCamera,
    });
    entry.geometry = {
      successorCellAddresses: Object.freeze([...demandCells.successor.values()]),
      interactionPrefetchCellAddresses: Object.freeze([
        ...demandCells.interactionPrefetch.values(),
      ]),
      requiredCellAddresses: Object.freeze([...demandCells.required.values()]),
      prefetchCellAddresses: Object.freeze([...demandCells.prefetch.values()]),
      allowedCellIds: new Set([
        ...demandCells.required.keys(),
        ...demandCells.successor.keys(),
        ...demandCells.interactionPrefetch.keys(),
        ...demandCells.prefetch.keys(),
      ]),
    };
  }
  const {
    successorCellAddresses,
    interactionPrefetchCellAddresses,
    requiredCellAddresses,
    prefetchCellAddresses,
    allowedCellIds,
  } = entry.geometry;
  const missingSuccessorCellAddresses = Object.freeze(
    successorCellAddresses.filter(({ cellId }) => !cellReady(cellId))
  );
  const missingInteractionPrefetchCellAddresses = Object.freeze(
    interactionPrefetchCellAddresses.filter(({ cellId }) => !cellReady(cellId))
  );
  const missingRequiredCellAddresses = Object.freeze(
    requiredCellAddresses.filter(({ cellId }) => !cellReady(cellId))
  );
  const missingPrefetchCellAddresses = Object.freeze(
    prefetchCellAddresses.filter(({ cellId }) => !cellReady(cellId))
  );
  const demandLeaseId = mintCompiledBroadSurfaceDemandLease(host, {
    manifestFingerprint: readyManifest.manifestFingerprint,
    isoformMode: resolvedPolicy.isoformMode,
    laneLimit: resolvedPolicy.laneLimit,
    allowedCellIds,
  });
  return Object.freeze({
    ...identifiedBase,
    status: 'broad-ready',
    demandLeaseId,
    requiredCellAddresses,
    missingRequiredCellAddresses,
    successorCellAddresses,
    missingSuccessorCellAddresses,
    interactionPrefetchCellAddresses,
    missingInteractionPrefetchCellAddresses,
    prefetchCellAddresses,
    missingPrefetchCellAddresses,
    missingCellAddresses: Object.freeze([
      ...missingRequiredCellAddresses,
      ...missingSuccessorCellAddresses,
      ...missingInteractionPrefetchCellAddresses,
      ...missingPrefetchCellAddresses,
    ]),
  });
}

export type CompiledBroadDemandOverlayBindings = {
  compiledBroadSurfaceCameraEpoch: number;
  compiledBroadSurfaceLastCameraRequest: CompiledBroadDemandCamera | null;
  prepackedAnnotationRuntimePolicy: AnnotationPolicyGpuRuntimeV1 | null;
  maxAnnotationLane: number;
  compiledBroadSurfaceCandidateManifest: CompiledBroadSurfaceManifestV2 | null;
  compiledBroadSurfaceCandidatePresenter: CompiledBroadDemandPresenter | null;
  compiledBroadSurfaceCandidateProvenance: CompiledBroadSurfaceAdmissionProvenanceV1 | null;
  compiledBroadSurfaceManifest: CompiledBroadSurfaceManifestV2 | null;
  compiledBroadSurfacePresenter: CompiledBroadDemandPresenter | null;
  compiledBroadSurfaceProvenance: CompiledBroadSurfaceAdmissionProvenanceV1 | null;
  compiledBroadSurfacePlanDerivationCount: number;
  compiledBroadSurfaceReadyDetailDemands: Map<string, CompiledBroadSurfaceReadyDetailDemandV1>;
  compiledBroadSurfaceDemandLeases: Map<string, CompiledBroadSurfaceDemandLeaseV1>;
  prepackedAnnotationSceneReplacementCandidates: {
    get(ownerKey: string): { input: { viewportDetail?: PrepackedViewportDetailLease } } | undefined;
  };
  prepackedAnnotationSceneResidents: {
    get(ownerKey: string): { input: { viewportDetail?: PrepackedViewportDetailLease } } | undefined;
  };
  compiledBroadSurfaceAdmissionOwner(manifestFingerprint: string): CompiledBroadDemandOwner | null;
  compiledBroadSurfaceProvenanceIsCurrent(
    manifest: CompiledBroadSurfaceManifestV2,
    provenance: CompiledBroadSurfaceAdmissionProvenanceV1 | null
  ): boolean;
};

export function createCompiledBroadDemandHost(
  overlay: CompiledBroadDemandOverlayBindings
): CompiledBroadDemandHost {
  return {
    get cameraEpoch() {
      return overlay.compiledBroadSurfaceCameraEpoch;
    },
    get lastCamera() {
      return overlay.compiledBroadSurfaceLastCameraRequest;
    },
    get runtimePolicy() {
      return overlay.prepackedAnnotationRuntimePolicy;
    },
    get maxAnnotationLane() {
      return overlay.maxAnnotationLane;
    },
    get candidateManifest() {
      return overlay.compiledBroadSurfaceCandidateManifest;
    },
    get candidatePresenter() {
      return overlay.compiledBroadSurfaceCandidatePresenter;
    },
    get candidateProvenance() {
      return overlay.compiledBroadSurfaceCandidateProvenance;
    },
    get currentManifest() {
      return overlay.compiledBroadSurfaceManifest;
    },
    get currentPresenter() {
      return overlay.compiledBroadSurfacePresenter;
    },
    get currentProvenance() {
      return overlay.compiledBroadSurfaceProvenance;
    },
    admissionOwner(manifestFingerprint) {
      return overlay.compiledBroadSurfaceAdmissionOwner(manifestFingerprint);
    },
    provenanceIsCurrent(manifest, provenance) {
      return overlay.compiledBroadSurfaceProvenanceIsCurrent(manifest, provenance);
    },
    incrementPlanDerivationCount() {
      overlay.compiledBroadSurfacePlanDerivationCount += 1;
    },
    viewportDetailForOwnerKey(ownerKey) {
      return (
        overlay.prepackedAnnotationSceneReplacementCandidates.get(ownerKey) ??
        overlay.prepackedAnnotationSceneResidents.get(ownerKey)
      )?.input.viewportDetail;
    },
    rememberReadyDetailDemand(demand) {
      overlay.compiledBroadSurfaceReadyDetailDemands.set(demand.manifestFingerprint, demand);
    },
    forgetReadyDetailDemand(manifestFingerprint) {
      overlay.compiledBroadSurfaceReadyDetailDemands.delete(manifestFingerprint);
    },
    storeDemandLease(lease) {
      overlay.compiledBroadSurfaceDemandLeases.set(lease.leaseId, lease);
    },
    demandLease(leaseId) {
      return overlay.compiledBroadSurfaceDemandLeases.get(leaseId);
    },
  };
}
