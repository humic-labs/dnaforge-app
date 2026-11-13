import type { UnifiedLayout } from '../shared/track-layout';
import type { TrackContract } from '../shared/lane-contracts';
import type {
  AnnotationPolicyGpuRuntimeV1,
  AnnotationPolicyGpuTrackLaneMaximaV1,
} from '../overview/annotation-policy-gpu-instances-v1';
import type {
  PrepackedAnnotationSceneLoadInput,
  PrepackedAnnotationSceneMetadata,
  PrepackedAnnotationSceneStatus,
} from '../overview/prepacked-annotation-scene';
import type { PartitionedInstancedTranscriptLayer } from '../overview/partitioned-instanced-transcript-layer';
import type { CompiledBroadSurfaceRequirementV1 } from './indexed-compiled-broad-requirement';
import type {
  CompiledBroadSurfaceAdmissionProvenanceV1,
  CompiledBroadSurfaceManifestV2,
} from '../overview/bounded-annotation-broad-surface';
import type { CompiledBroadSurfaceTrackOwnerV2 } from './indexed-compiled-broad-frame';
import type { RetainedOverlayCameraState } from './overlay-track';
import type { AnnotationBodyReplacementReadiness } from './annotation-body-presentation-authority';
import type { AnnotationPrebuiltRasterEligibility } from './annotation-lod-ownership';
import type { RetainedOverviewAnnotationStyle } from './annotation-lod-policy';
import {
  activatePrepackedAnnotationScene as runActivatePrepackedAnnotationScene,
  applyAnnotationPresentationPolicy as runApplyAnnotationPresentationPolicy,
  createPrepackedPolicyHost,
  disposePrepackedAnnotationScene as runDisposePrepackedAnnotationScene,
  disposePrepackedAnnotationSceneLayer as runDisposePrepackedAnnotationSceneLayer,
  evictPrepackedAnnotationSceneResidentsToLimit as runEvictPrepackedAnnotationSceneResidentsToLimit,
  type PrepackedPolicyHost,
  type PrepackedPolicyLastPresentation,
  type PrepackedPolicyOverlayBindings,
  type PrepackedPolicyPresentationCamera,
  type PrepackedPolicyCameraRequest,
  type PrepackedPolicyThemeOwnerRoster,
} from './indexed-prepacked-policy';
import {
  createPrepackedMaterializeHost,
  materializePrepackedAnnotationScene as runPrepackedAnnotationMaterialize,
  type PrepackedMaterializeCompiledInteraction,
  type PrepackedMaterializeHost,
  type PrepackedMaterializeOverlayBindings,
} from './indexed-prepacked-materialize';
import {
  createPrepackedPresentFrameHost,
  presentPrepackedAnnotationScene,
  type PrepackedPresentFinePendingReason,
  type PrepackedPresentFrameHost,
  type PrepackedPresentFrameOverlayBindings,
} from './indexed-prepacked-present-frame';
import {
  commitPrepackedAnnotationSceneReplacement,
  destroyPrepackedAnnotationSceneResident,
  primeInactivePrepackedAnnotationSceneResident,
  type PrepackedSceneTeardownHost,
} from './indexed-prepacked-scene-teardown';
import type { PrepackedSceneLifecycleHost } from './indexed-prepacked-scene-lifecycle';
import type { Feature, RenderState } from '../../../types';
import type { Graphics } from 'pixi.js';
import type { PathMapper } from '../shared/path-mapper';
import { decodeAnnotationPolicyProjectionFeatureV1 } from '../overview/annotation-policy-projection-v1';
import {
  prepackedAnnotationPrimitiveScreenGeometry as prepackedAnnotationPrimitiveScreenGeometryFn,
  strokePrepackedInteractionFeature as strokePrepackedInteractionFeatureFn,
  type PrepackedInteractionGeometryHost,
} from './indexed-prepacked-interaction-geometry';
import {
  prepackedPolicyTrackLaneForPrimitive as prepackedPolicyTrackLaneForPrimitiveFn,
  prepackedRendererIdForCanonicalIdentity as prepackedRendererIdForCanonicalIdentityFn,
  prepackedResidentTrackOffsetPx as prepackedResidentTrackOffsetPxFn,
} from './indexed-prepacked-policy-lane';
import {
  commitAnnotationPresentationPolicy as commitAnnotationPresentationPolicyFn,
  releaseRetiredGpuResourcesAfterPresent as releaseRetiredGpuResourcesAfterPresentFn,
} from './indexed-annotation-lifecycle';

import type { OverlayPresenterCollaborators } from './indexed-annotation-overlay-collaborators';

export type ResidentPrepackedAnnotationScene = {
  ownerKey: string;
  input: PrepackedAnnotationSceneLoadInput;
  sourceInput: PrepackedAnnotationSceneLoadInput;
  metadata: PrepackedAnnotationSceneMetadata;
  layer: PartitionedInstancedTranscriptLayer;
  policyTrackLaneMaxima: AnnotationPolicyGpuTrackLaneMaximaV1 | null;
  policyGeneration: number;
  viewportDetailPresentationAdmitted: boolean;
  lastUsed: number;
  visiblePartitionCount: number;
  visibleInstanceCount: number;
};

export type PrepackedSceneOverlayGlue = {
  pixiRenderer: { type?: number } | null;
  currentGenomeIdentity: string;
  genomeLength: number;
  features: Feature[];
  compiledBroadAnnotationInteractionResidents: {
    get(ownerKey: string): PrepackedMaterializeCompiledInteraction | undefined;
  };
  container: {
    children: { readonly length: number };
    addChildAt(child: unknown, index: number): void;
    removeChild(child: unknown): void;
  };
  compiledBroadSurfaceLastPresentationCamera: PrepackedPolicyPresentationCamera | null;
  compiledBroadSurfaceLastCameraRequest: PrepackedPolicyCameraRequest | null;
  compiledBroadSurfaceRequirement: CompiledBroadSurfaceRequirementV1 | null;
  _layout: UnifiedLayout | null;
  _contract: TrackContract | null;
  annotationBodyPresentationGeneration: unknown;
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
  residentAnnotationViewportSelectionCache: unknown;
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
  cdsDetailProgress(): number;
  prepackedAnnotationTrackBaseOffsetPx(): number | null;
  prepackedAnnotationCenterScreenY(path: PathMapper, offsetPx: number): number | null;
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

const EMPTY_INTERACTION_RESIDENTS = new Map<string, PrepackedMaterializeCompiledInteraction>();

export function idlePrepackedSceneOverlayGlue(): PrepackedSceneOverlayGlue {
  const children: unknown[] = [];
  const compiledOwners = new Map<string, { presenter: { hide(): void } }>();
  const compiledCandidates = new Map<string, { presenter: { hide(): void } }>();
  return {
    pixiRenderer: null,
    currentGenomeIdentity: '',
    genomeLength: 0,
    features: [],
    compiledBroadAnnotationInteractionResidents: EMPTY_INTERACTION_RESIDENTS,
    container: {
      children,
      addChildAt() {},
      removeChild() {},
    },
    compiledBroadSurfaceLastPresentationCamera: null,
    compiledBroadSurfaceLastCameraRequest: null,
    compiledBroadSurfaceRequirement: null,
    _layout: null,
    _contract: null,
    annotationBodyPresentationGeneration: null,
    compiledBroadSurfaceManifest: null,
    compiledBroadSurfaceCandidateManifest: null,
    compiledBroadSurfaceTrackOwners: compiledOwners,
    compiledBroadSurfaceTrackCandidateOwners: compiledCandidates,
    compiledBroadSurfacePlanDerivationCount: 0,
    compiledBroadSurfacePresenter: null,
    compiledBroadSurfaceCandidatePresenter: null,
    maxAnnotationLane: 0,
    maxCdsLane: -1,
    maxLane: 0,
    residentAnnotationViewportSelectionCache: null,
    lastDrawAudit: null,
    renderCallCount: 0,
    lastRenderMode: 'none',
    lastRenderKey: '',
    lastRenderKeyParts: null,
    lastGeometryRebuildReasons: [],
    retainedOverviewMode: 'inactive',
    retainedOverviewStyle: 'retained',
    retainedOverviewCameraUpdates: 0,
    retainedOverviewFallbackReason: null,
    retainedOverviewInstanceCount: 0,
    retainedOverviewVisibleInstanceCount: 0,
    lastRetainedTranscriptDecorationsDrawn: false,
    annotationLayerTypesForPresentation: () => ['mRNA'],
    scaledBarHeight: () => 8,
    cdsDetailProgress: () => 0,
    prepackedAnnotationTrackBaseOffsetPx: () => 0,
    prepackedAnnotationCenterScreenY: () => null,
    compiledBroadSurfaceOwnerRosterForTheme: () => [],
    compiledBroadSurfaceProvenanceIsCurrent: () => false,
    compiledBroadSurfaceCandidateRegistrationMatches: () => false,
    compiledBroadSurfaceLaneStart: () => 0,
    compiledBroadSurfaceOwnerForTrack: () => null,
    compiledBroadSurfaceCandidateOwnerForTrack: () => null,
    annotationTrackStackMaxLane: () => 0,
    reconcileAnnotationLaneEnvelopeAuthority() {},
    resetAllPresentersToHidden() {},
    clearImmediateStateForCompiledAnnotationOwner() {},
    finalizeCompiledBroadSurfaceCandidateOwner() {},
    noteAnnotationBodyPresentationCommit() {},
    beginDrawAuditIfDiagnosticsEnabled: () => null,
    renderInteractionOutlines() {},
  };
}

type PrepackedSceneBindings = PrepackedPolicyOverlayBindings<ResidentPrepackedAnnotationScene> &
  PrepackedMaterializeOverlayBindings<ResidentPrepackedAnnotationScene> &
  PrepackedPresentFrameOverlayBindings<ResidentPrepackedAnnotationScene> &
  PrepackedSceneTeardownHost;

export class PrepackedAnnotationSceneController
  implements PrepackedSceneBindings, PrepackedSceneLifecycleHost
{
  prepackedAnnotationSceneLayer: PartitionedInstancedTranscriptLayer | null = null;
  prepackedAnnotationSceneInput: PrepackedAnnotationSceneLoadInput | null = null;
  prepackedAnnotationSceneOwnerKey: string | null = null;
  prepackedAnnotationSceneOwnerMetadata: PrepackedAnnotationSceneMetadata | null = null;
  prepackedAnnotationSceneOwnerGeneration = 0;
  prepackedAnnotationRuntimePolicy: AnnotationPolicyGpuRuntimeV1 | null = null;
  prepackedAnnotationPolicyGeneration = 0;
  prepackedAnnotationPolicyTransactionInFlight = false;
  prepackedAnnotationSceneStatus: PrepackedAnnotationSceneStatus = 'not-loaded';
  prepackedAnnotationSceneFinePendingReason: PrepackedPresentFinePendingReason | null = null;
  readonly prepackedAnnotationSceneResidents = new Map<string, ResidentPrepackedAnnotationScene>();
  readonly prepackedAnnotationSceneReplacementCandidates = new Map<
    string,
    ResidentPrepackedAnnotationScene
  >();
  readonly retiredPrepackedAnnotationSceneLayers = new Map<
    PartitionedInstancedTranscriptLayer,
    number
  >();
  prepackedAnnotationSceneResidentGeneration = 0;
  prepackedAnnotationSceneLastCompleteOwnerKeys: readonly string[] = Object.freeze([]);
  prepackedAnnotationSceneResidentClock = 0;
  prepackedAnnotationSceneLayerCreates = 0;
  prepackedAnnotationSceneLayerDestroys = 0;
  prepackedAnnotationSceneGpuPreparations = 0;
  prepackedAnnotationSceneCameraUpdates = 0;
  prepackedAnnotationSceneVisiblePartitionCount = 0;
  prepackedAnnotationSceneVisibleInstanceCount = 0;
  prepackedAnnotationSceneLastPresentation: PrepackedPolicyLastPresentation | null = null;
  prepackedAnnotationSceneStartupBuilds = 0;
  prepackedAnnotationInteractionVisualCouplingValidated = false;
  prepackedAnnotationInteractionCouplingValidationCount = 0;
  prepackedAnnotationInteractionCouplingPrimitiveScanCardinality = 0;
  prepackedAnnotationTrustedV4AdmissionCount = 0;
  readonly prepackedCanonicalRendererIdCache = new Map<
    string,
    Readonly<{ ownerKey: string; rendererId: number }> | null
  >();
  readonly prepackedResidentPolicyFeatureIndexCache = new Map<string, number | null>();

  private materializeHostCache: PrepackedMaterializeHost<ResidentPrepackedAnnotationScene> | null =
    null;
  private policyHostCache: PrepackedPolicyHost<ResidentPrepackedAnnotationScene> | null = null;
  private presentFrameHostCache: PrepackedPresentFrameHost<ResidentPrepackedAnnotationScene> | null =
    null;

  private overlay: PrepackedSceneOverlayGlue = idlePrepackedSceneOverlayGlue();

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
      get features() {
        return collaborators.layout.features;
      },
      get compiledBroadAnnotationInteractionResidents() {
        return collaborators.compiledBroad
          .compiledBroadAnnotationInteractionResidents as PrepackedSceneOverlayGlue['compiledBroadAnnotationInteractionResidents'];
      },
      get container() {
        return collaborators.container;
      },
      get compiledBroadSurfaceLastPresentationCamera() {
        return collaborators.compiledBroad.compiledBroadSurfaceLastPresentationCamera;
      },
      get compiledBroadSurfaceLastCameraRequest() {
        return collaborators.compiledBroad.compiledBroadSurfaceLastCameraRequest;
      },
      get compiledBroadSurfaceRequirement() {
        return collaborators.compiledBroad.compiledBroadSurfaceRequirement;
      },
      get _layout() {
        return collaborators.layout._layout;
      },
      get _contract() {
        return collaborators.layout._contract;
      },
      set _contract(value) {
        collaborators.layout._contract = value;
      },
      get annotationBodyPresentationGeneration() {
        return collaborators.bodyFrame.annotationBodyPresentationGeneration;
      },
      get compiledBroadSurfaceManifest() {
        return collaborators.compiledBroad.compiledBroadSurfaceManifest;
      },
      get compiledBroadSurfaceCandidateManifest() {
        return collaborators.compiledBroad.compiledBroadSurfaceCandidateManifest;
      },
      get compiledBroadSurfaceTrackOwners() {
        return collaborators.compiledBroad.compiledBroadSurfaceTrackOwners;
      },
      get compiledBroadSurfaceTrackCandidateOwners() {
        return collaborators.compiledBroad.compiledBroadSurfaceTrackCandidateOwners;
      },
      get compiledBroadSurfacePlanDerivationCount() {
        return collaborators.compiledBroad.compiledBroadSurfacePlanDerivationCount;
      },
      set compiledBroadSurfacePlanDerivationCount(value) {
        collaborators.compiledBroad.compiledBroadSurfacePlanDerivationCount = value;
      },
      get compiledBroadSurfacePresenter() {
        return collaborators.compiledBroad.compiledBroadSurfacePresenter;
      },
      get compiledBroadSurfaceCandidatePresenter() {
        return collaborators.compiledBroad.compiledBroadSurfaceCandidatePresenter;
      },
      get maxAnnotationLane() {
        return collaborators.layout.maxAnnotationLane;
      },
      set maxAnnotationLane(value) {
        collaborators.layout.maxAnnotationLane = value;
      },
      get maxCdsLane() {
        return collaborators.layout.maxCdsLane;
      },
      set maxCdsLane(value) {
        collaborators.layout.maxCdsLane = value;
      },
      get maxLane() {
        return collaborators.layout.maxLane;
      },
      set maxLane(value) {
        collaborators.layout.maxLane = value;
      },
      get residentAnnotationViewportSelectionCache() {
        return collaborators.residentPages.residentAnnotationViewportSelectionCache;
      },
      set residentAnnotationViewportSelectionCache(value) {
        collaborators.residentPages.residentAnnotationViewportSelectionCache = value;
      },
      get lastDrawAudit() {
        return collaborators.retained.lastDrawAudit;
      },
      set lastDrawAudit(value) {
        collaborators.retained.lastDrawAudit = value;
      },
      get renderCallCount() {
        return collaborators.retained.renderCallCount;
      },
      set renderCallCount(value) {
        collaborators.retained.renderCallCount = value;
      },
      get lastRenderMode() {
        return collaborators.retained.lastRenderMode;
      },
      set lastRenderMode(value) {
        collaborators.retained.lastRenderMode = value;
      },
      get lastRenderKey() {
        return collaborators.retained.lastRenderKey;
      },
      set lastRenderKey(value) {
        collaborators.retained.lastRenderKey = value;
      },
      get lastRenderKeyParts() {
        return collaborators.retained.lastRenderKeyParts;
      },
      set lastRenderKeyParts(value) {
        collaborators.retained.lastRenderKeyParts = value;
      },
      get lastGeometryRebuildReasons() {
        return collaborators.retained.lastGeometryRebuildReasons;
      },
      set lastGeometryRebuildReasons(value) {
        collaborators.retained.lastGeometryRebuildReasons = value;
      },
      get retainedOverviewMode() {
        return collaborators.retained.retainedOverviewMode;
      },
      set retainedOverviewMode(value) {
        collaborators.retained.retainedOverviewMode = value;
      },
      get retainedOverviewStyle() {
        return collaborators.retained.retainedOverviewStyle;
      },
      set retainedOverviewStyle(value) {
        collaborators.retained.retainedOverviewStyle = value;
      },
      get retainedOverviewCameraUpdates() {
        return collaborators.retained.retainedOverviewCameraUpdates;
      },
      set retainedOverviewCameraUpdates(value) {
        collaborators.retained.retainedOverviewCameraUpdates = value;
      },
      get retainedOverviewFallbackReason() {
        return collaborators.retained.retainedOverviewFallbackReason;
      },
      set retainedOverviewFallbackReason(value) {
        collaborators.retained.retainedOverviewFallbackReason = value;
      },
      get retainedOverviewInstanceCount() {
        return collaborators.retained.retainedOverviewInstanceCount;
      },
      set retainedOverviewInstanceCount(value) {
        collaborators.retained.retainedOverviewInstanceCount = value;
      },
      get retainedOverviewVisibleInstanceCount() {
        return collaborators.retained.retainedOverviewVisibleInstanceCount;
      },
      set retainedOverviewVisibleInstanceCount(value) {
        collaborators.retained.retainedOverviewVisibleInstanceCount = value;
      },
      get lastRetainedTranscriptDecorationsDrawn() {
        return collaborators.retained.lastRetainedTranscriptDecorationsDrawn;
      },
      set lastRetainedTranscriptDecorationsDrawn(value) {
        collaborators.retained.lastRetainedTranscriptDecorationsDrawn = value;
      },
      annotationLayerTypesForPresentation: () =>
        collaborators.layout.annotationLayerTypesForPresentation(),
      scaledBarHeight: () => collaborators.layout.scaledBarHeight(),
      cdsDetailProgress: () => collaborators.layout.cdsDetailProgress(),
      prepackedAnnotationTrackBaseOffsetPx: () =>
        collaborators.layout.prepackedAnnotationTrackBaseOffsetPx(),
      prepackedAnnotationCenterScreenY: (path, offsetPx) =>
        collaborators.layout.prepackedAnnotationCenterScreenY(path, offsetPx),
      compiledBroadSurfaceOwnerRosterForTheme: (requestedLayerTypes, requestedThemeMode) =>
        collaborators.compiledBroad.compiledBroadSurfaceOwnerRosterForTheme(
          requestedLayerTypes,
          requestedThemeMode
        ),
      compiledBroadSurfaceProvenanceIsCurrent: (manifest, provenance) =>
        collaborators.compiledBroad.compiledBroadSurfaceProvenanceIsCurrent(manifest, provenance),
      compiledBroadSurfaceCandidateRegistrationMatches: (owner) =>
        collaborators.compiledBroad.compiledBroadSurfaceCandidateRegistrationMatches(owner),
      compiledBroadSurfaceLaneStart: (trackType, requestedLayerTypes, policy) =>
        collaborators.compiledBroad.compiledBroadSurfaceLaneStart(
          trackType,
          requestedLayerTypes,
          policy
        ),
      compiledBroadSurfaceOwnerForTrack: (trackType) =>
        collaborators.compiledBroad.compiledBroadSurfaceOwnerForTrack(trackType),
      compiledBroadSurfaceCandidateOwnerForTrack: (trackType) =>
        collaborators.compiledBroad.compiledBroadSurfaceCandidateOwnerForTrack(trackType),
      annotationTrackStackMaxLane: (policy) =>
        collaborators.compiledBroad.annotationTrackStackMaxLane(policy),
      reconcileAnnotationLaneEnvelopeAuthority: () =>
        collaborators.layout.reconcileAnnotationLaneEnvelopeAuthority(),
      resetAllPresentersToHidden: () => collaborators.retained.resetAllPresentersToHidden(),
      clearImmediateStateForCompiledAnnotationOwner: () =>
        collaborators.retained.clearImmediateStateForCompiledAnnotationOwner(),
      finalizeCompiledBroadSurfaceCandidateOwner: (owner) =>
        collaborators.compiledBroad.finalizeCompiledBroadSurfaceCandidateOwner(owner),
      noteAnnotationBodyPresentationCommit: (input) =>
        collaborators.bodyFrame.noteAnnotationBodyPresentationCommit(input),
      beginDrawAuditIfDiagnosticsEnabled: (
        path,
        state,
        features,
        useOverviewAggregation,
        forcedStyle
      ) =>
        collaborators.retained.beginDrawAuditIfDiagnosticsEnabled(
          path,
          state,
          features as readonly Feature[],
          useOverviewAggregation,
          forcedStyle as never
        ),
      renderInteractionOutlines: (path, state) =>
        collaborators.outlines.renderInteractionOutlines(path, state as RenderState),
    } as PrepackedSceneOverlayGlue;
  }

  get size(): number {
    return this.prepackedAnnotationSceneResidents.size;
  }

  get residents(): Map<string, ResidentPrepackedAnnotationScene> {
    return this.prepackedAnnotationSceneResidents;
  }

  get(ownerKey: string): ResidentPrepackedAnnotationScene | undefined {
    return this.prepackedAnnotationSceneResidents.get(ownerKey);
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
  get features() {
    return this.overlay.features;
  }
  get compiledBroadAnnotationInteractionResidents() {
    return this.overlay.compiledBroadAnnotationInteractionResidents;
  }
  get container() {
    return this.overlay.container;
  }
  get compiledBroadSurfaceLastPresentationCamera() {
    return this.overlay.compiledBroadSurfaceLastPresentationCamera;
  }
  get compiledBroadSurfaceLastCameraRequest() {
    return this.overlay.compiledBroadSurfaceLastCameraRequest;
  }
  get compiledBroadSurfaceRequirement() {
    return this.overlay.compiledBroadSurfaceRequirement;
  }
  get _layout() {
    return this.overlay._layout;
  }
  get _contract() {
    return this.overlay._contract;
  }
  set _contract(value) {
    this.overlay._contract = value;
  }
  get annotationBodyPresentationGeneration() {
    return this.overlay.annotationBodyPresentationGeneration;
  }
  get compiledBroadSurfaceManifest() {
    return this.overlay.compiledBroadSurfaceManifest;
  }
  get compiledBroadSurfaceCandidateManifest() {
    return this.overlay.compiledBroadSurfaceCandidateManifest;
  }
  get compiledBroadSurfaceTrackOwners() {
    return this.overlay.compiledBroadSurfaceTrackOwners;
  }
  get compiledBroadSurfaceTrackCandidateOwners() {
    return this.overlay.compiledBroadSurfaceTrackCandidateOwners;
  }
  get compiledBroadSurfacePlanDerivationCount() {
    return this.overlay.compiledBroadSurfacePlanDerivationCount;
  }
  set compiledBroadSurfacePlanDerivationCount(value) {
    this.overlay.compiledBroadSurfacePlanDerivationCount = value;
  }
  get compiledBroadSurfacePresenter() {
    return this.overlay.compiledBroadSurfacePresenter;
  }
  get compiledBroadSurfaceCandidatePresenter() {
    return this.overlay.compiledBroadSurfaceCandidatePresenter;
  }
  get maxAnnotationLane() {
    return this.overlay.maxAnnotationLane;
  }
  set maxAnnotationLane(value) {
    this.overlay.maxAnnotationLane = value;
  }
  get maxCdsLane() {
    return this.overlay.maxCdsLane;
  }
  set maxCdsLane(value) {
    this.overlay.maxCdsLane = value;
  }
  get maxLane() {
    return this.overlay.maxLane;
  }
  set maxLane(value) {
    this.overlay.maxLane = value;
  }
  get residentAnnotationViewportSelectionCache() {
    return this.overlay.residentAnnotationViewportSelectionCache;
  }
  set residentAnnotationViewportSelectionCache(value) {
    this.overlay.residentAnnotationViewportSelectionCache = value;
  }
  get lastDrawAudit() {
    return this.overlay.lastDrawAudit;
  }
  set lastDrawAudit(value) {
    this.overlay.lastDrawAudit = value;
  }
  get renderCallCount() {
    return this.overlay.renderCallCount;
  }
  set renderCallCount(value) {
    this.overlay.renderCallCount = value;
  }
  get lastRenderMode() {
    return this.overlay.lastRenderMode;
  }
  set lastRenderMode(value) {
    this.overlay.lastRenderMode = value;
  }
  get lastRenderKey() {
    return this.overlay.lastRenderKey;
  }
  set lastRenderKey(value) {
    this.overlay.lastRenderKey = value;
  }
  get lastRenderKeyParts() {
    return this.overlay.lastRenderKeyParts;
  }
  set lastRenderKeyParts(value) {
    this.overlay.lastRenderKeyParts = value;
  }
  get lastGeometryRebuildReasons() {
    return this.overlay.lastGeometryRebuildReasons;
  }
  set lastGeometryRebuildReasons(value) {
    this.overlay.lastGeometryRebuildReasons = value;
  }
  get retainedOverviewMode() {
    return this.overlay.retainedOverviewMode;
  }
  set retainedOverviewMode(value) {
    this.overlay.retainedOverviewMode = value;
  }
  get retainedOverviewStyle() {
    return this.overlay.retainedOverviewStyle;
  }
  set retainedOverviewStyle(value) {
    this.overlay.retainedOverviewStyle = value;
  }
  get retainedOverviewCameraUpdates() {
    return this.overlay.retainedOverviewCameraUpdates;
  }
  set retainedOverviewCameraUpdates(value) {
    this.overlay.retainedOverviewCameraUpdates = value;
  }
  get retainedOverviewFallbackReason() {
    return this.overlay.retainedOverviewFallbackReason;
  }
  set retainedOverviewFallbackReason(value) {
    this.overlay.retainedOverviewFallbackReason = value;
  }
  get retainedOverviewInstanceCount() {
    return this.overlay.retainedOverviewInstanceCount;
  }
  set retainedOverviewInstanceCount(value) {
    this.overlay.retainedOverviewInstanceCount = value;
  }
  get retainedOverviewVisibleInstanceCount() {
    return this.overlay.retainedOverviewVisibleInstanceCount;
  }
  set retainedOverviewVisibleInstanceCount(value) {
    this.overlay.retainedOverviewVisibleInstanceCount = value;
  }
  get lastRetainedTranscriptDecorationsDrawn() {
    return this.overlay.lastRetainedTranscriptDecorationsDrawn;
  }
  set lastRetainedTranscriptDecorationsDrawn(value) {
    this.overlay.lastRetainedTranscriptDecorationsDrawn = value;
  }

  annotationLayerTypesForPresentation(): readonly string[] {
    return this.overlay.annotationLayerTypesForPresentation();
  }
  scaledBarHeight(): number {
    return this.overlay.scaledBarHeight();
  }
  cdsDetailProgress(): number {
    return this.overlay.cdsDetailProgress();
  }
  prepackedAnnotationTrackBaseOffsetPx(): number | null {
    return this.overlay.prepackedAnnotationTrackBaseOffsetPx();
  }
  compiledBroadSurfaceOwnerRosterForTheme(
    requestedLayerTypes: readonly string[],
    requestedThemeMode: 'light' | 'dark'
  ): PrepackedPolicyThemeOwnerRoster {
    return this.overlay.compiledBroadSurfaceOwnerRosterForTheme(
      requestedLayerTypes,
      requestedThemeMode
    );
  }
  compiledBroadSurfaceProvenanceIsCurrent(
    manifest: CompiledBroadSurfaceManifestV2,
    provenance: CompiledBroadSurfaceAdmissionProvenanceV1
  ): boolean {
    return this.overlay.compiledBroadSurfaceProvenanceIsCurrent(manifest, provenance);
  }
  compiledBroadSurfaceCandidateRegistrationMatches(
    owner: CompiledBroadSurfaceTrackOwnerV2
  ): boolean {
    return this.overlay.compiledBroadSurfaceCandidateRegistrationMatches(owner);
  }
  compiledBroadSurfaceLaneStart(
    trackType: string,
    requestedLayerTypes: readonly string[],
    policy: AnnotationPolicyGpuRuntimeV1
  ): number {
    return this.overlay.compiledBroadSurfaceLaneStart(trackType, requestedLayerTypes, policy);
  }
  compiledBroadSurfaceOwnerForTrack(trackType: string): CompiledBroadSurfaceTrackOwnerV2 | null {
    return this.overlay.compiledBroadSurfaceOwnerForTrack(trackType);
  }
  compiledBroadSurfaceCandidateOwnerForTrack(
    trackType: string
  ): CompiledBroadSurfaceTrackOwnerV2 | null {
    return this.overlay.compiledBroadSurfaceCandidateOwnerForTrack(trackType);
  }
  annotationTrackStackMaxLane(policy: AnnotationPolicyGpuRuntimeV1): number {
    return this.overlay.annotationTrackStackMaxLane(policy);
  }
  reconcileAnnotationLaneEnvelopeAuthority(): void {
    this.overlay.reconcileAnnotationLaneEnvelopeAuthority();
  }
  resetAllPresentersToHidden(): void {
    this.overlay.resetAllPresentersToHidden();
  }
  clearImmediateStateForCompiledAnnotationOwner(): void {
    this.overlay.clearImmediateStateForCompiledAnnotationOwner();
  }
  finalizeCompiledBroadSurfaceCandidateOwner(owner: CompiledBroadSurfaceTrackOwnerV2): void {
    this.overlay.finalizeCompiledBroadSurfaceCandidateOwner(owner);
  }
  noteAnnotationBodyPresentationCommit(input: { orderedVisibleTrackIds: readonly string[] }): void {
    this.overlay.noteAnnotationBodyPresentationCommit(input);
  }
  beginDrawAuditIfDiagnosticsEnabled(
    path: RetainedOverlayCameraState['path'],
    state: RetainedOverlayCameraState['state'],
    features: readonly unknown[],
    useOverviewAggregation: boolean,
    forcedStyle: unknown
  ): unknown {
    return this.overlay.beginDrawAuditIfDiagnosticsEnabled(
      path,
      state,
      features,
      useOverviewAggregation,
      forcedStyle
    );
  }
  renderInteractionOutlines(
    path: RetainedOverlayCameraState['path'],
    state: RetainedOverlayCameraState['state']
  ): void {
    this.overlay.renderInteractionOutlines(path, state);
  }

  materializeHost(): PrepackedMaterializeHost<ResidentPrepackedAnnotationScene> {
    if (!this.materializeHostCache) {
      this.materializeHostCache = createPrepackedMaterializeHost(this);
    }
    return this.materializeHostCache;
  }

  policyHost(): PrepackedPolicyHost<ResidentPrepackedAnnotationScene> {
    if (!this.policyHostCache) {
      this.policyHostCache = createPrepackedPolicyHost(this);
    }
    return this.policyHostCache;
  }

  presentFrameHost(): PrepackedPresentFrameHost<ResidentPrepackedAnnotationScene> {
    if (!this.presentFrameHostCache) {
      this.presentFrameHostCache = createPrepackedPresentFrameHost(this);
    }
    return this.presentFrameHostCache;
  }

  installResident(resident: ResidentPrepackedAnnotationScene): void {
    this.prepackedAnnotationSceneResidents.set(resident.ownerKey, resident);
    this.prepackedAnnotationSceneResidentGeneration += 1;
  }

  materialize(
    input: PrepackedAnnotationSceneLoadInput,
    preserveActiveOwner: boolean,
    deferGpuPreparation: boolean
  ): boolean {
    return runPrepackedAnnotationMaterialize(
      this.materializeHost(),
      input,
      preserveActiveOwner,
      deferGpuPreparation
    );
  }

  load(input: PrepackedAnnotationSceneLoadInput): boolean {
    if (!this.materialize(input, false, false)) return false;
    return this.activate(input.ownerKey);
  }

  loadPrepackedAnnotationScene(input: PrepackedAnnotationSceneLoadInput): boolean {
    return this.load(input);
  }

  prepare(input: PrepackedAnnotationSceneLoadInput): boolean {
    return this.materialize(input, true, input.viewportDetail !== undefined);
  }

  activate(ownerKey: string): boolean {
    return runActivatePrepackedAnnotationScene(this.policyHost(), ownerKey);
  }

  applyPolicy(policy: AnnotationPolicyGpuRuntimeV1): boolean | 'deferred' {
    return runApplyAnnotationPresentationPolicy(this.policyHost(), policy);
  }

  applyAnnotationPresentationPolicy(policy: AnnotationPolicyGpuRuntimeV1): boolean | 'deferred' {
    return this.applyPolicy(policy);
  }

  present(
    camera: RetainedOverlayCameraState,
    style: RetainedOverviewAnnotationStyle,
    prebuiltRasterEligibility: Pick<AnnotationPrebuiltRasterEligibility, 'eligible'>
  ): AnnotationBodyReplacementReadiness {
    return presentPrepackedAnnotationScene(
      this.presentFrameHost(),
      camera,
      style,
      prebuiltRasterEligibility
    );
  }

  clear(): void {
    this.dispose('not-loaded');
  }

  dispose(status: PrepackedAnnotationSceneStatus = 'not-loaded', recordOwnerChange = true): void {
    runDisposePrepackedAnnotationScene(this.policyHost(), status, recordOwnerChange);
  }

  disposePrepackedAnnotationScene(
    status: PrepackedAnnotationSceneStatus,
    recordOwnerChange = true
  ): void {
    this.dispose(status, recordOwnerChange);
  }

  disposePrepackedAnnotationSceneLayer(
    layer: PartitionedInstancedTranscriptLayer,
    wasLastComplete: boolean
  ): void {
    runDisposePrepackedAnnotationSceneLayer(this.policyHost(), layer, wasLastComplete);
  }

  evictPrepackedAnnotationSceneResidentsToLimit(): void {
    runEvictPrepackedAnnotationSceneResidentsToLimit(this.policyHost());
  }

  primeInactivePrepackedAnnotationSceneResident(resident: ResidentPrepackedAnnotationScene): void {
    primeInactivePrepackedAnnotationSceneResident(this, resident);
  }

  destroyPrepackedAnnotationSceneResident(
    ownerKey: string,
    status: PrepackedAnnotationSceneStatus,
    recordOwnerChange = true
  ): void {
    destroyPrepackedAnnotationSceneResident(this, ownerKey, status, recordOwnerChange);
  }

  commitPrepackedAnnotationSceneReplacement(resident: ResidentPrepackedAnnotationScene): void {
    commitPrepackedAnnotationSceneReplacement(this, resident);
  }

  private geometryHost(): PrepackedInteractionGeometryHost {
    return {
      prepackedPolicyTrackLaneForPrimitive: (primitiveIndex, input) =>
        this.prepackedPolicyTrackLaneForPrimitive(primitiveIndex, input),
      prepackedAnnotationCenterScreenY: (path, offsetPx) =>
        this.overlay.prepackedAnnotationCenterScreenY(path, offsetPx),
    };
  }

  prepackedAnnotationPolicyFeatureIsDurablyVisible(
    resident: ResidentPrepackedAnnotationScene,
    featureIndex: number
  ): boolean {
    const runtimePolicy = this.prepackedAnnotationRuntimePolicy;
    const projection = resident.input.policyProjection;
    if (!runtimePolicy || !projection || featureIndex >= projection.featureCount) return true;
    const feature = decodeAnnotationPolicyProjectionFeatureV1(projection, featureIndex);
    const localLane =
      runtimePolicy.isoformMode === 'canonical'
        ? feature.canonicalTrackLane
        : feature.expandedTrackLane;
    return (
      localLane !== null &&
      (runtimePolicy.laneLimit === null || localLane < runtimePolicy.laneLimit)
    );
  }

  prepackedAnnotationPrimitiveScreenGeometry(
    path: PathMapper,
    state: RenderState,
    input: PrepackedAnnotationSceneLoadInput,
    primitiveIndex: number,
    trackOffsetPx: number,
    temporaryAdditionalLane: number | null = null
  ): { points: number[]; actualWidthPx: number } | null {
    return prepackedAnnotationPrimitiveScreenGeometryFn(
      this.geometryHost(),
      path,
      state,
      input,
      primitiveIndex,
      trackOffsetPx,
      temporaryAdditionalLane
    );
  }

  strokePrepackedInteractionFeature(
    graphics: Graphics,
    path: PathMapper,
    state: RenderState,
    resident: ResidentPrepackedAnnotationScene,
    rendererId: number,
    forceSelected = false,
    trackOffsetPx = 0
  ): number {
    return strokePrepackedInteractionFeatureFn(
      this.geometryHost(),
      graphics,
      path,
      state,
      resident.input,
      rendererId,
      forceSelected,
      trackOffsetPx
    );
  }

  prepackedPolicyTrackLaneForPrimitive(
    primitiveIndex: number,
    input: {
      policyGpuInstanceData?: Float32Array | null;
      policyProjection?: PrepackedAnnotationSceneLoadInput['policyProjection'];
      gpuReadyScene?: {
        featureIndices?: ArrayLike<number>;
        packedInstanceData?: ArrayLike<number>;
      } | null;
    } | null = this.prepackedAnnotationSceneInput
  ): number | null | undefined {
    return prepackedPolicyTrackLaneForPrimitiveFn(this, primitiveIndex, input);
  }

  prepackedResidentTrackOffsetPx(
    resident: { metadata: { trackType: string } },
    requestedLayerTypes: readonly string[],
    policy: AnnotationPolicyGpuRuntimeV1
  ): number {
    return prepackedResidentTrackOffsetPxFn(this, resident, requestedLayerTypes, policy);
  }

  prepackedRendererIdForCanonicalIdentity(
    canonicalIdentity: string
  ): Readonly<{ ownerKey: string; rendererId: number }> | null {
    return prepackedRendererIdForCanonicalIdentityFn(this, canonicalIdentity);
  }

  prepackedAnnotationScenePresentingResidents(): ResidentPrepackedAnnotationScene[] {
    const ordered: ResidentPrepackedAnnotationScene[] = [];
    const emitted = new Set<string>();
    for (const ownerKey of this.prepackedAnnotationSceneLastCompleteOwnerKeys) {
      const resident = this.prepackedAnnotationSceneResidents.get(ownerKey);
      if (!resident?.layer.isPresenting) continue;
      ordered.push(resident);
      emitted.add(ownerKey);
    }
    for (const resident of this.prepackedAnnotationSceneResidents.values()) {
      if (!resident.layer.isPresenting || emitted.has(resident.ownerKey)) continue;
      ordered.push(resident);
    }
    return ordered;
  }

  releaseRetiredGpuResourcesAfterPresent(force = false): void {
    releaseRetiredGpuResourcesAfterPresentFn(this, force);
  }

  updatePrepackedAnnotationPolicy(policy: AnnotationPolicyGpuRuntimeV1): boolean {
    return commitAnnotationPresentationPolicyFn(this, policy).status === 'committed';
  }
}

declare module './indexed-annotation-overlay-collaborators' {
  interface OverlayPrepackedCollaborator extends PrepackedAnnotationSceneController {}
}
