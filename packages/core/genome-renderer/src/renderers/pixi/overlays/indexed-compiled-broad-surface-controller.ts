import { Container, Renderer, Texture } from 'pixi.js';
import { findAnnotationTrackIdentity } from '../../../annotation-track-identity';
import type { AnnotationPolicyGpuRuntimeV1 } from '../overview/annotation-policy-gpu-instances-v1';
import type {
  BroadSurfaceIsoformModeV2,
  CompiledBroadSurfaceAdmissionProvenanceV1,
  CompiledBroadSurfaceManifestV2,
} from '../overview/bounded-annotation-broad-surface';
import type {
  CompiledBroadSurfaceCellAdmissionResultV2,
  CompiledBroadSurfacePixiPresenterV2,
} from '../overview/compiled-broad-surface-pixi-presenter';
import type { GenomeWideTextureCacheLayer } from '../overview/genome-wide-texture-cache-layer';
import {
  ReusableLinearViewerRenderContract,
  type ViewerRenderContract,
} from '../overview/viewer-render-contract';
import { compiledBroadSurfaceAdmissionIdentityMatches } from './indexed-compiled-broad-identity';
import { compiledBroadSurfaceProvenanceFailure as inspectCompiledBroadSurfaceProvenanceFailure } from './indexed-compiled-broad-provenance';
import { compiledBroadSurfaceAdmissionLeaseFailure } from './indexed-compiled-broad-lease';
import {
  createCompiledBroadDemandHost,
  getCompiledBroadSurfaceDemand as getCompiledBroadSurfaceDemandFn,
  type CompiledBroadDemandHost,
  type CompiledBroadSurfaceDemandLeaseV1,
  type CompiledBroadSurfaceDemandV2,
  type CompiledBroadSurfaceReadyDetailDemandV1,
} from './indexed-compiled-broad-demand';
import {
  createCompiledBroadFrameHost,
  presentRequestedCompiledBroadSurfaces,
  retainLastCompleteCompiledBroadSurfaceFrame,
  type CompiledBroadFastCameraMailbox,
  type CompiledBroadFrameHost,
  type CompiledBroadSurfaceSteadyRosterV2,
  type CompiledBroadSurfaceTrackOwnerV2,
} from './indexed-compiled-broad-frame';
import {
  createCompiledBroadLoadHost,
  loadCompiledBroadSurfaceManifest as loadCompiledBroadSurfaceManifestFn,
  type CompiledBroadLoadHost,
} from './indexed-compiled-broad-load';
import {
  admitCompiledBroadSurfaceCellTexture as admitCompiledBroadSurfaceCellTextureFn,
  admitCompiledBroadSurfaceRgbaCell as admitCompiledBroadSurfaceRgbaCellFn,
  admitCompiledBroadSurfaceTransparentCell as admitCompiledBroadSurfaceTransparentCellFn,
  createCompiledBroadAdmitHost,
  type CompiledBroadAdmitHost,
  type CompiledBroadSurfaceRgbaCellAdmissionInputV2,
  type CompiledBroadSurfaceRgbaCellAdmissionResultV2,
  type CompiledBroadSurfaceTextureCellAdmissionInputV2,
  type CompiledBroadSurfaceTransparentCellAdmissionInputV2,
} from './indexed-compiled-broad-admit';
import {
  clearCompiledBroadSurfaceManifest as clearCompiledBroadSurfaceManifestFn,
  compiledBroadSurfaceAdmissionOwner as compiledBroadSurfaceAdmissionOwnerFn,
  destroyCompiledBroadSurfaceOwnedTextures as destroyCompiledBroadSurfaceOwnedTexturesFn,
  disposeCompiledBroadSurfaceCandidate as disposeCompiledBroadSurfaceCandidateFn,
  disposeCompiledBroadSurfaceTrackOwner as disposeCompiledBroadSurfaceTrackOwnerFn,
  reconcileCompiledBroadSurfaceResidentLeases as reconcileCompiledBroadSurfaceResidentLeasesFn,
  type CompiledBroadSurfaceResidentLeaseReconcileResultV1,
} from './indexed-compiled-broad-owner-lifecycle';
import {
  admitCompiledBroadSurfaceSourcePlacementAuthority as admitCompiledBroadSurfaceSourcePlacementAuthorityFn,
  compiledBroadAnnotationInteractionResidentForTrack as compiledBroadAnnotationInteractionResidentForTrackFn,
  compiledBroadSurfaceCandidateOwnerForTrack as compiledBroadSurfaceCandidateOwnerForTrackFn,
  compiledBroadSurfaceInteractionResidentForTrack as compiledBroadSurfaceInteractionResidentForTrackFn,
  compiledBroadSurfaceOwnerForTrack as compiledBroadSurfaceOwnerForTrackFn,
  compiledBroadSurfaceOwnerRosterForTheme as compiledBroadSurfaceOwnerRosterForThemeFn,
  compiledBroadSurfacePresentingLayerTypes as compiledBroadSurfacePresentingLayerTypesFn,
  evictCompiledBroadAnnotationInteractionResidentsToLimit as evictCompiledBroadAnnotationInteractionResidentsToLimitFn,
  isCompiledBroadSurfaceDemandRefreshRequired as isCompiledBroadSurfaceDemandRefreshRequiredFn,
  loadCompiledBroadAnnotationInteraction as loadCompiledBroadAnnotationInteractionFn,
  prepackedAnnotationSceneResidentForTrack as prepackedAnnotationSceneResidentForTrackFn,
  recordCompiledBroadSurfaceCameraRequest as recordCompiledBroadSurfaceCameraRequestFn,
  requestedPrepackedAnnotationSceneResidentForTrack as requestedPrepackedAnnotationSceneResidentForTrackFn,
  type CompiledBroadInteractionPrepackedResident,
  type ResidentCompiledBroadAnnotationInteraction,
} from './indexed-compiled-broad-interaction-residents';
import {
  getCompiledBroadSurfaceDiagnostics as getCompiledBroadSurfaceDiagnosticsFn,
  getCompiledBroadSurfaceReadinessDiagnostics as getCompiledBroadSurfaceReadinessDiagnosticsFn,
} from './indexed-compiled-broad-diagnostics';
import {
  annotationTrackRealizedLaneCapacity as annotationTrackRealizedLaneCapacityFn,
  annotationTrackStackMaxLane as annotationTrackStackMaxLaneFn,
  compiledBroadSurfaceCandidateRegistrationMatches as compiledBroadSurfaceCandidateRegistrationMatchesFn,
  compiledBroadSurfaceLaneStart as compiledBroadSurfaceLaneStartFn,
  disposeCompiledBroadSurfaceRegisteredCandidate as disposeCompiledBroadSurfaceRegisteredCandidateFn,
  finalizeCompiledBroadSurfaceCandidateOwner as finalizeCompiledBroadSurfaceCandidateOwnerFn,
  installCompiledBroadSurfaceCandidateOwner as installCompiledBroadSurfaceCandidateOwnerFn,
} from './indexed-compiled-broad-track-layout';
import {
  IndexedCompiledBroadRequirement,
  type CompiledBroadSurfaceRequirementV1,
} from './indexed-compiled-broad-requirement';
import type {
  CompiledBroadSurfacePlanStatusV2,
  CompiledBroadSurfaceSourcePlacementAuthorityV1,
  CompiledBroadAnnotationInteractionLoadInputV1,
} from './annotation-overlay-types';
import type { RetainedOverlayCameraState } from './overlay-track';
import type { AnnotationBodyReplacementReadiness } from './annotation-body-presentation-authority';
import type { ResidentPrepackedAnnotationScene } from './indexed-prepacked-scene-controller';

import type { OverlayPresenterCollaborators } from './indexed-annotation-overlay-collaborators';

export type CompiledBroadOverlayGlue = {
  pixiRenderer: Renderer | null;
  currentGenomeIdentity: string;
  genomeLength: number;
  container: Container;
  _layout: { annotationOffset: number } | null;
  presentationVisible: boolean;
  genomeWideTextureCacheLayer: GenomeWideTextureCacheLayer | null;
  maxAnnotationLane: number;
  currentAnnotationSourceFingerprint: string | null;
  currentAnnotationPlacementFingerprint: string | null;
  currentGenomeAnnotationSourcePlacementProvenance: {
    sourceFingerprint: string;
    placementFingerprint: string;
  } | null;
  prepackedAnnotationRuntimePolicy: AnnotationPolicyGpuRuntimeV1 | null;
  prepackedAnnotationSceneResidents: Map<string, ResidentPrepackedAnnotationScene>;
  prepackedAnnotationSceneReplacementCandidates: Map<string, ResidentPrepackedAnnotationScene>;
  prepackedAnnotationSceneLayer: unknown;
  prepackedAnnotationSceneOwnerKey: string | null;
  prepackedAnnotationSceneResidentClock: number;
  annotationLayerTypesForPresentation(): string[];
  reconcileAnnotationLaneEnvelopeAuthority(): void;
  sealCompiledBroadPresentedFrame(
    camera: RetainedOverlayCameraState,
    options: { clearImmediate: boolean }
  ): true;
};

const EMPTY_PREPACKED_RESIDENTS = new Map<string, ResidentPrepackedAnnotationScene>();
const EMPTY_PREPACKED_CANDIDATES = new Map<string, ResidentPrepackedAnnotationScene>();

export function idleCompiledBroadOverlayGlue(): CompiledBroadOverlayGlue {
  const children: unknown[] = [];
  return {
    pixiRenderer: null,
    currentGenomeIdentity: '',
    genomeLength: 0,
    container: {
      children,
      addChildAt() {},
      removeChild() {},
    } as unknown as Container,
    _layout: null,
    presentationVisible: true,
    genomeWideTextureCacheLayer: null,
    maxAnnotationLane: 0,
    currentAnnotationSourceFingerprint: null,
    currentAnnotationPlacementFingerprint: null,
    currentGenomeAnnotationSourcePlacementProvenance: null,
    prepackedAnnotationRuntimePolicy: null,
    prepackedAnnotationSceneResidents: EMPTY_PREPACKED_RESIDENTS,
    prepackedAnnotationSceneReplacementCandidates: EMPTY_PREPACKED_CANDIDATES,
    prepackedAnnotationSceneLayer: null,
    prepackedAnnotationSceneOwnerKey: null,
    prepackedAnnotationSceneResidentClock: 0,
    annotationLayerTypesForPresentation: () => [],
    reconcileAnnotationLaneEnvelopeAuthority() {},
    sealCompiledBroadPresentedFrame() {
      return true;
    },
  };
}

export class CompiledBroadSurfaceController {
  compiledBroadSurfaceManifest: CompiledBroadSurfaceManifestV2 | null = null;
  compiledBroadSurfaceProvenance: CompiledBroadSurfaceAdmissionProvenanceV1 | null = null;
  compiledBroadSurfacePresenter: CompiledBroadSurfacePixiPresenterV2 | null = null;
  compiledBroadSurfaceCandidateManifest: CompiledBroadSurfaceManifestV2 | null = null;
  compiledBroadSurfaceCandidateProvenance: CompiledBroadSurfaceAdmissionProvenanceV1 | null = null;
  compiledBroadSurfaceCandidatePresenter: CompiledBroadSurfacePixiPresenterV2 | null = null;
  readonly compiledBroadSurfaceTrackOwners = new Map<string, CompiledBroadSurfaceTrackOwnerV2>();
  readonly compiledBroadSurfaceTrackCandidateOwners = new Map<
    string,
    CompiledBroadSurfaceTrackOwnerV2
  >();
  compiledBroadSurfaceLastCompleteTrackIds: readonly string[] = Object.freeze([]);
  compiledBroadSurfaceSteadyRoster: CompiledBroadSurfaceSteadyRosterV2 | null = null;
  compiledBroadSurfaceOwnedLastFrame = false;
  readonly compiledBroadRequirement = new IndexedCompiledBroadRequirement();
  readonly compiledBroadSurfaceOwnedCellTextures = new Map<string, Texture>();
  readonly compiledBroadSurfaceGpuPreuploadedCellIds = new Set<string>();
  compiledBroadSurfaceLastCameraRequest: {
    viewportStartBp: number;
    viewportEndBp: number;
    viewportCssWidthPx: number;
    devicePixelRatio: number;
  } | null = null;
  compiledBroadSurfaceLastPresentationCamera: {
    contract: ViewerRenderContract;
    fwdStrandTop: number;
    viewportCssWidthPx: number;
    viewportCssHeightPx: number;
    themeMode: 'light' | 'dark';
  } | null = null;
  readonly compiledBroadSurfaceLinearContract = new ReusableLinearViewerRenderContract();
  readonly compiledBroadSurfaceFastCamera: CompiledBroadFastCameraMailbox = {
    isoformMode: 'canonical' as BroadSurfaceIsoformModeV2,
    laneLimit: null,
    viewportStartBp: 0,
    viewportEndBp: 0,
    devicePixelRatio: 1,
    contract: this.compiledBroadSurfaceLinearContract,
    trackTopCssPx: 0,
    viewportCssWidthPx: 1,
    viewportCssHeightPx: 1,
    themeMode: 'light',
  };
  compiledBroadSurfaceCameraEpoch = 0;
  readonly compiledBroadSurfaceDemandLeases = new Map<string, CompiledBroadSurfaceDemandLeaseV1>();
  readonly compiledBroadSurfaceReadyDetailDemands = new Map<
    string,
    CompiledBroadSurfaceReadyDetailDemandV1
  >();
  compiledBroadSurfaceRgbaAdmissions = 0;
  compiledBroadSurfaceGpuPreuploads = 0;
  compiledBroadSurfaceExplicitRgbaCopyBytes = 0;
  compiledBroadSurfaceGpuPreuploadedBytes = 0;
  compiledBroadSurfacePostPresentGpuUploads = 0;
  compiledBroadSurfacePostPresentGpuUploadBytes = 0;
  compiledBroadSurfacePlanDerivationCount = 0;
  readonly compiledBroadSurfaceCameraContractCreateCount = 1;
  readonly compiledBroadSurfaceFastCameraMailboxCreateCount = 1;
  compiledBroadSurfaceGpuPreuploadFailures = 0;
  compiledBroadSurfacePlanStatus: CompiledBroadSurfacePlanStatusV2 = 'not-loaded';
  compiledBroadSurfaceSourcePlacementAuthority: Readonly<CompiledBroadSurfaceSourcePlacementAuthorityV1> | null =
    null;
  readonly compiledBroadAnnotationInteractionResidents = new Map<
    string,
    ResidentCompiledBroadAnnotationInteraction
  >();
  compiledBroadAnnotationInteractionResidentGeneration = 0;

  private frameHostCache: CompiledBroadFrameHost | null = null;
  private demandHostCache: CompiledBroadDemandHost | null = null;
  private loadHostCache: CompiledBroadLoadHost | null = null;
  private admitHostCache: CompiledBroadAdmitHost | null = null;

  private overlay: CompiledBroadOverlayGlue = idleCompiledBroadOverlayGlue();

  constructor() {}
  attach(collaborators: OverlayPresenterCollaborators): void {
    this.overlay = {
      get pixiRenderer() {
        return collaborators.retained.pixiRenderer;
      },
      get currentGenomeIdentity() {
        return collaborators.layout.currentGenomeIdentity;
      },
      get genomeLength() {
        return collaborators.layout.genomeLength;
      },
      get container() {
        return collaborators.container;
      },
      get _layout() {
        return collaborators.layout._layout;
      },
      get presentationVisible() {
        return collaborators.retained.presentationVisible;
      },
      get genomeWideTextureCacheLayer() {
        return collaborators.retained.genomeWideTextureCacheLayer;
      },
      get maxAnnotationLane() {
        return collaborators.layout.maxAnnotationLane;
      },
      get currentAnnotationSourceFingerprint() {
        return collaborators.layout.currentAnnotationSourceFingerprint;
      },
      set currentAnnotationSourceFingerprint(value) {
        collaborators.layout.currentAnnotationSourceFingerprint = value;
      },
      get currentAnnotationPlacementFingerprint() {
        return collaborators.layout.currentAnnotationPlacementFingerprint;
      },
      set currentAnnotationPlacementFingerprint(value) {
        collaborators.layout.currentAnnotationPlacementFingerprint = value;
      },
      get currentGenomeAnnotationSourcePlacementProvenance() {
        return collaborators.layout.currentGenomeAnnotationSourcePlacementProvenance;
      },
      get prepackedAnnotationRuntimePolicy() {
        return collaborators.prepacked.prepackedAnnotationRuntimePolicy;
      },
      set prepackedAnnotationRuntimePolicy(value) {
        collaborators.prepacked.prepackedAnnotationRuntimePolicy = value;
      },
      get prepackedAnnotationSceneResidents() {
        return collaborators.prepacked.prepackedAnnotationSceneResidents;
      },
      get prepackedAnnotationSceneReplacementCandidates() {
        return collaborators.prepacked.prepackedAnnotationSceneReplacementCandidates;
      },
      get prepackedAnnotationSceneLayer() {
        return collaborators.prepacked.prepackedAnnotationSceneLayer;
      },
      get prepackedAnnotationSceneOwnerKey() {
        return collaborators.prepacked.prepackedAnnotationSceneOwnerKey;
      },
      get prepackedAnnotationSceneResidentClock() {
        return collaborators.prepacked.prepackedAnnotationSceneResidentClock;
      },
      set prepackedAnnotationSceneResidentClock(value) {
        collaborators.prepacked.prepackedAnnotationSceneResidentClock = value;
      },
      annotationLayerTypesForPresentation: () =>
        collaborators.layout.annotationLayerTypesForPresentation(),
      reconcileAnnotationLaneEnvelopeAuthority: () =>
        collaborators.layout.reconcileAnnotationLaneEnvelopeAuthority(),
      sealCompiledBroadPresentedFrame: (camera, options) =>
        collaborators.retained.sealCompiledBroadPresentedFrame(camera, options),
    } as CompiledBroadOverlayGlue;
  }

  get compiledBroadSurfaceRequirement(): CompiledBroadSurfaceRequirementV1 | null {
    return this.compiledBroadRequirement.current;
  }

  get pixiRenderer() {
    return this.overlay.pixiRenderer;
  }
  get currentGenomeIdentity() {
    return this.overlay.currentGenomeIdentity;
  }
  get genomeLength() {
    return this.overlay.genomeLength;
  }
  get container() {
    return this.overlay.container;
  }
  get _layout() {
    return this.overlay._layout;
  }
  get presentationVisible() {
    return this.overlay.presentationVisible;
  }
  get genomeWideTextureCacheLayer() {
    return this.overlay.genomeWideTextureCacheLayer;
  }
  get maxAnnotationLane() {
    return this.overlay.maxAnnotationLane;
  }
  get currentAnnotationSourceFingerprint() {
    return this.overlay.currentAnnotationSourceFingerprint;
  }
  set currentAnnotationSourceFingerprint(value) {
    this.overlay.currentAnnotationSourceFingerprint = value;
  }
  get currentAnnotationPlacementFingerprint() {
    return this.overlay.currentAnnotationPlacementFingerprint;
  }
  set currentAnnotationPlacementFingerprint(value) {
    this.overlay.currentAnnotationPlacementFingerprint = value;
  }
  get currentGenomeAnnotationSourcePlacementProvenance() {
    return this.overlay.currentGenomeAnnotationSourcePlacementProvenance;
  }
  get prepackedAnnotationRuntimePolicy() {
    return this.overlay.prepackedAnnotationRuntimePolicy;
  }
  set prepackedAnnotationRuntimePolicy(value) {
    this.overlay.prepackedAnnotationRuntimePolicy = value;
  }
  get prepackedAnnotationSceneResidents() {
    return this.overlay.prepackedAnnotationSceneResidents;
  }
  get prepackedAnnotationSceneReplacementCandidates() {
    return this.overlay.prepackedAnnotationSceneReplacementCandidates;
  }
  get prepackedAnnotationSceneLayer() {
    return this.overlay.prepackedAnnotationSceneLayer;
  }
  get prepackedAnnotationSceneOwnerKey() {
    return this.overlay.prepackedAnnotationSceneOwnerKey;
  }
  get prepackedAnnotationSceneResidentClock() {
    return this.overlay.prepackedAnnotationSceneResidentClock;
  }
  set prepackedAnnotationSceneResidentClock(value) {
    this.overlay.prepackedAnnotationSceneResidentClock = value;
  }

  annotationLayerTypesForPresentation(): string[] {
    return this.overlay.annotationLayerTypesForPresentation();
  }
  reconcileAnnotationLaneEnvelopeAuthority(): void {
    this.overlay.reconcileAnnotationLaneEnvelopeAuthority();
  }
  sealCompiledBroadPresentedFrame(
    camera: RetainedOverlayCameraState,
    options: { clearImmediate: boolean }
  ): true {
    return this.overlay.sealCompiledBroadPresentedFrame(camera, options);
  }

  frameHost(): CompiledBroadFrameHost {
    if (!this.frameHostCache) {
      this.frameHostCache = createCompiledBroadFrameHost(this);
    }
    return this.frameHostCache;
  }

  demandHost(): CompiledBroadDemandHost {
    if (!this.demandHostCache) {
      this.demandHostCache = createCompiledBroadDemandHost(this);
    }
    return this.demandHostCache;
  }

  loadHost(): CompiledBroadLoadHost {
    if (!this.loadHostCache) {
      this.loadHostCache = createCompiledBroadLoadHost(this);
    }
    return this.loadHostCache;
  }

  admitHost(): CompiledBroadAdmitHost {
    if (!this.admitHostCache) {
      this.admitHostCache = createCompiledBroadAdmitHost(this);
    }
    return this.admitHostCache;
  }

  compiledBroadSurfaceProvenanceFailure(
    manifest: CompiledBroadSurfaceManifestV2,
    provenance: CompiledBroadSurfaceAdmissionProvenanceV1 | null | undefined
  ): string | null {
    return inspectCompiledBroadSurfaceProvenanceFailure({
      provenance,
      manifest,
      currentGenomeIdentity: this.currentGenomeIdentity,
      genomeLengthBp: this.genomeLength,
      currentAnnotationSourceFingerprint: this.currentAnnotationSourceFingerprint,
      currentAnnotationPlacementFingerprint: this.currentAnnotationPlacementFingerprint,
    });
  }

  compiledBroadSurfaceProvenanceIsCurrent(
    manifest: CompiledBroadSurfaceManifestV2 | null,
    provenance: CompiledBroadSurfaceAdmissionProvenanceV1 | null
  ): boolean {
    return Boolean(manifest && !this.compiledBroadSurfaceProvenanceFailure(manifest, provenance));
  }

  compiledBroadSurfaceAdmissionIdentityMatches(
    owner: CompiledBroadSurfaceTrackOwnerV2,
    manifest: CompiledBroadSurfaceManifestV2,
    provenance: CompiledBroadSurfaceAdmissionProvenanceV1
  ): boolean {
    return compiledBroadSurfaceAdmissionIdentityMatches({
      ownerManifest: owner.manifest,
      ownerProvenance: owner.provenance,
      nextManifest: manifest,
      nextProvenance: provenance,
    });
  }

  compiledBroadSurfaceAdmissionOwner(
    manifestFingerprint: string | undefined
  ): CompiledBroadSurfaceTrackOwnerV2 | null {
    return compiledBroadSurfaceAdmissionOwnerFn(this, manifestFingerprint);
  }

  compiledBroadSurfaceAdmissionLeaseFailure(
    demandLeaseId: string | undefined,
    manifestFingerprint: string,
    cellId: string
  ): string | null {
    return compiledBroadSurfaceAdmissionLeaseFailure({
      demandLeaseId,
      cameraEpoch: this.compiledBroadSurfaceCameraEpoch,
      manifestFingerprint,
      cellId,
      lease: demandLeaseId ? this.compiledBroadSurfaceDemandLeases.get(demandLeaseId) : undefined,
    });
  }

  compiledBroadSurfaceOwnerForTrack(trackId: string): CompiledBroadSurfaceTrackOwnerV2 | null {
    return compiledBroadSurfaceOwnerForTrackFn(this, trackId);
  }

  compiledBroadSurfaceCandidateOwnerForTrack(
    trackId: string
  ): CompiledBroadSurfaceTrackOwnerV2 | null {
    return compiledBroadSurfaceCandidateOwnerForTrackFn(this, trackId);
  }

  compiledBroadSurfaceOwnerRosterForTheme(
    requestedLayerTypes: readonly string[],
    requestedThemeMode: 'light' | 'dark'
  ): Array<{
    trackId: string;
    currentOwner: CompiledBroadSurfaceTrackOwnerV2 | null;
    candidateOwner: CompiledBroadSurfaceTrackOwnerV2 | null;
    owner: CompiledBroadSurfaceTrackOwnerV2 | null;
  }> {
    return compiledBroadSurfaceOwnerRosterForThemeFn(this, requestedLayerTypes, requestedThemeMode);
  }

  compiledBroadSurfaceCandidateRegistrationMatches(
    owner: CompiledBroadSurfaceTrackOwnerV2
  ): boolean {
    return compiledBroadSurfaceCandidateRegistrationMatchesFn(this, owner);
  }

  installCompiledBroadSurfaceActiveOwner(owner: CompiledBroadSurfaceTrackOwnerV2): void {
    if (
      findAnnotationTrackIdentity('mRNA', [owner], (candidate) => candidate.manifest.trackId) ===
      owner
    ) {
      this.compiledBroadSurfaceManifest = owner.manifest;
      this.compiledBroadSurfaceProvenance = owner.provenance;
      this.compiledBroadSurfacePresenter = owner.presenter;
      return;
    }
    this.compiledBroadSurfaceTrackOwners.set(owner.manifest.trackId, owner);
  }

  installCompiledBroadSurfaceCandidateOwner(owner: CompiledBroadSurfaceTrackOwnerV2): void {
    installCompiledBroadSurfaceCandidateOwnerFn(this, owner);
  }

  disposeCompiledBroadSurfaceCandidate(): void {
    disposeCompiledBroadSurfaceCandidateFn(this);
  }

  disposeCompiledBroadSurfaceTrackOwner(owner: CompiledBroadSurfaceTrackOwnerV2): void {
    disposeCompiledBroadSurfaceTrackOwnerFn(this, owner);
  }

  disposeCompiledBroadSurfaceRegisteredCandidate(owner: CompiledBroadSurfaceTrackOwnerV2): void {
    disposeCompiledBroadSurfaceRegisteredCandidateFn(this, owner);
  }

  finalizeCompiledBroadSurfaceCandidateOwner(owner: CompiledBroadSurfaceTrackOwnerV2): void {
    finalizeCompiledBroadSurfaceCandidateOwnerFn(this, owner);
  }

  destroyCompiledBroadSurfaceOwnedTextures(manifestFingerprint: string): void {
    destroyCompiledBroadSurfaceOwnedTexturesFn(this, manifestFingerprint);
  }

  compiledBroadSurfaceLaneStart(
    trackId: string,
    requestedLayerTypes: readonly string[],
    policy: AnnotationPolicyGpuRuntimeV1
  ): number {
    return compiledBroadSurfaceLaneStartFn(this, trackId, requestedLayerTypes, policy);
  }

  annotationTrackRealizedLaneCapacity(
    trackId: string,
    policy: AnnotationPolicyGpuRuntimeV1,
    preserveLegacyFixedCapacity = this.annotationLayerTypesForPresentation().length <= 1
  ): number {
    return annotationTrackRealizedLaneCapacityFn(
      this,
      trackId,
      policy,
      preserveLegacyFixedCapacity
    );
  }

  annotationTrackStackMaxLane(policy: AnnotationPolicyGpuRuntimeV1): number {
    return annotationTrackStackMaxLaneFn(this, policy);
  }

  compiledBroadSurfaceInteractionResidentForTrack(
    trackId: string
  ): CompiledBroadInteractionPrepackedResident | null {
    return compiledBroadSurfaceInteractionResidentForTrackFn(this, trackId);
  }

  compiledBroadAnnotationInteractionResidentForTrack(
    trackId: string
  ): ResidentCompiledBroadAnnotationInteraction | null {
    return compiledBroadAnnotationInteractionResidentForTrackFn(this, trackId);
  }

  prepackedAnnotationSceneResidentForTrack(
    trackId: string
  ): ResidentPrepackedAnnotationScene | null {
    return prepackedAnnotationSceneResidentForTrackFn(
      this,
      trackId
    ) as ResidentPrepackedAnnotationScene | null;
  }

  requestedPrepackedAnnotationSceneResidentForTrack(
    trackId: string
  ): CompiledBroadInteractionPrepackedResident | null {
    return requestedPrepackedAnnotationSceneResidentForTrackFn(this, trackId);
  }

  compiledBroadSurfacePresentingLayerTypes(): string[] {
    return compiledBroadSurfacePresentingLayerTypesFn(this);
  }

  recordCompiledBroadSurfaceCameraRequest(
    camera: RetainedOverlayCameraState,
    viewportStartBp: number,
    viewportEndBp: number,
    viewportCssWidthPx: number,
    devicePixelRatio: number,
    viewportCssHeightPx: number
  ): void {
    recordCompiledBroadSurfaceCameraRequestFn(
      this,
      camera,
      viewportStartBp,
      viewportEndBp,
      viewportCssWidthPx,
      devicePixelRatio,
      viewportCssHeightPx
    );
  }

  requireCompiledBroadSurface(input: CompiledBroadSurfaceRequirementV1): boolean {
    return this.compiledBroadRequirement.require(input, {
      genomeLength: this.genomeLength,
      hasAdmittedSurface:
        this.compiledBroadSurfaceManifest !== null ||
        this.compiledBroadSurfaceCandidateManifest !== null ||
        this.compiledBroadSurfaceTrackOwners.size > 0 ||
        this.compiledBroadSurfaceTrackCandidateOwners.size > 0,
    });
  }

  loadCompiledBroadSurfaceManifest(
    manifest: CompiledBroadSurfaceManifestV2,
    provenance: CompiledBroadSurfaceAdmissionProvenanceV1
  ): boolean {
    return loadCompiledBroadSurfaceManifestFn(this.loadHost(), manifest, provenance);
  }

  admitCompiledBroadSurfaceCellTexture(
    input: CompiledBroadSurfaceTextureCellAdmissionInputV2
  ): CompiledBroadSurfaceCellAdmissionResultV2 {
    return admitCompiledBroadSurfaceCellTextureFn(this.admitHost(), input);
  }

  admitCompiledBroadSurfaceTransparentCell(
    input: CompiledBroadSurfaceTransparentCellAdmissionInputV2
  ): CompiledBroadSurfaceRgbaCellAdmissionResultV2 {
    return admitCompiledBroadSurfaceTransparentCellFn(this.admitHost(), input);
  }

  admitCompiledBroadSurfaceRgbaCell(
    input: CompiledBroadSurfaceRgbaCellAdmissionInputV2
  ): CompiledBroadSurfaceRgbaCellAdmissionResultV2 {
    return admitCompiledBroadSurfaceRgbaCellFn(this.admitHost(), input);
  }

  getCompiledBroadSurfaceDemand(
    policy?: AnnotationPolicyGpuRuntimeV1,
    manifestFingerprint?: string
  ): CompiledBroadSurfaceDemandV2 {
    return getCompiledBroadSurfaceDemandFn(this.demandHost(), policy, manifestFingerprint);
  }

  isCompiledBroadSurfaceDemandRefreshRequired(
    policy: AnnotationPolicyGpuRuntimeV1,
    manifestFingerprint: string
  ): boolean {
    return isCompiledBroadSurfaceDemandRefreshRequiredFn(this, policy, manifestFingerprint);
  }

  reconcileCompiledBroadSurfaceResidentLeases(
    demandLeaseIds: readonly string[]
  ): CompiledBroadSurfaceResidentLeaseReconcileResultV1 {
    return reconcileCompiledBroadSurfaceResidentLeasesFn(this, demandLeaseIds);
  }

  getCompiledBroadSurfaceDiagnostics() {
    return getCompiledBroadSurfaceDiagnosticsFn(this);
  }

  getCompiledBroadSurfaceReadinessDiagnostics() {
    return getCompiledBroadSurfaceReadinessDiagnosticsFn(this);
  }

  clearCompiledBroadSurfaceManifest(manifestFingerprint?: string): void {
    clearCompiledBroadSurfaceManifestFn(this, manifestFingerprint);
  }

  clearCompiledBroadSurfaceRequirement(): void {
    this.clearCompiledBroadSurfaceManifest();
    if (this.compiledBroadAnnotationInteractionResidents.size > 0) {
      this.compiledBroadAnnotationInteractionResidents.clear();
      this.compiledBroadAnnotationInteractionResidentGeneration += 1;
    }
    this.compiledBroadRequirement.clear();
    this.compiledBroadSurfaceSourcePlacementAuthority = null;
  }

  admitCompiledBroadSurfaceSourcePlacementAuthority(
    authority: CompiledBroadSurfaceSourcePlacementAuthorityV1
  ): boolean {
    return admitCompiledBroadSurfaceSourcePlacementAuthorityFn(this, authority);
  }

  loadCompiledBroadAnnotationInteraction(
    input: CompiledBroadAnnotationInteractionLoadInputV1
  ): ResidentCompiledBroadAnnotationInteraction | null {
    return loadCompiledBroadAnnotationInteractionFn(this, input);
  }

  evictCompiledBroadAnnotationInteractionResidentsToLimit(): void {
    evictCompiledBroadAnnotationInteractionResidentsToLimitFn(this);
  }

  tryPresentRequestedCompiledBroadSurfaces(
    camera: RetainedOverlayCameraState,
    requestedLayerTypes: readonly string[]
  ): AnnotationBodyReplacementReadiness {
    return presentRequestedCompiledBroadSurfaces(this.frameHost(), camera, requestedLayerTypes);
  }

  hideCompiledBroadPresenters(): void {
    this.compiledBroadSurfacePresenter?.hide();
    this.compiledBroadSurfaceCandidatePresenter?.hide();
    for (const owner of this.compiledBroadSurfaceTrackOwners.values()) {
      owner.presenter.hide();
    }
    for (const owner of this.compiledBroadSurfaceTrackCandidateOwners.values()) {
      owner.presenter.hide();
    }
  }

  retireCompiledBroadPresentersOutsideRoster(
    presenters: readonly CompiledBroadSurfacePixiPresenterV2[]
  ): void {
    const retained = new Set(presenters);
    const hideUnlessRetained = (presenter: CompiledBroadSurfacePixiPresenterV2 | null): void => {
      if (presenter && !retained.has(presenter)) presenter.hide();
    };
    hideUnlessRetained(this.compiledBroadSurfacePresenter);
    hideUnlessRetained(this.compiledBroadSurfaceCandidatePresenter);
    for (const owner of this.compiledBroadSurfaceTrackOwners.values()) {
      hideUnlessRetained(owner.presenter);
    }
    for (const owner of this.compiledBroadSurfaceTrackCandidateOwners.values()) {
      hideUnlessRetained(owner.presenter);
    }
  }

  tryRetainLastCompleteCompiledBroadSurfaceFrame(
    camera: RetainedOverlayCameraState,
    policy: AnnotationPolicyGpuRuntimeV1
  ): boolean {
    return retainLastCompleteCompiledBroadSurfaceFrame(this.frameHost(), camera, policy);
  }

  compiledBroadSurfaceManifestFingerprintForTrack(trackId: string): string | null {
    const manifests = [...this.compiledBroadSurfaceTrackOwners.values()].map(
      (owner) => owner.manifest
    );
    if (this.compiledBroadSurfaceManifest) manifests.unshift(this.compiledBroadSurfaceManifest);
    return (
      findAnnotationTrackIdentity(trackId, manifests, (manifest) => manifest.trackId)
        ?.manifestFingerprint ?? null
    );
  }
}

declare module './indexed-annotation-overlay-collaborators' {
  interface OverlayCompiledBroadCollaborator extends CompiledBroadSurfaceController {}
}
