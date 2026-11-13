import type { AnnotationPolicyGpuRuntimeV1 } from '../overview/annotation-policy-gpu-instances-v1';
import type { RetainedOverlayCameraState } from './overlay-track';
import type { RetainedOverviewAnnotationStyle } from './annotation-lod-policy';
import type { AnnotationPrebuiltRasterEligibility } from './annotation-lod-ownership';
import type { AnnotationBodyReplacementReadiness } from './annotation-body-presentation-authority';
import {
  emptyAnnotationBodyPresenterEligibility,
  type AnnotationBodyFrameOwnerKind,
  type AnnotationBodyPresenterEligibility,
  type AnnotationBodyPresentationGenerationV1,
} from './annotation-body-presentation-authority';
import {
  annotationBodyProductFingerprintsMatchCurrentGeneration as annotationBodyProductFingerprintsMatchCurrentGenerationFn,
  noteAnnotationBodyFrameOwner as noteAnnotationBodyFrameOwnerFn,
  probeAnnotationBodyPresenterEligibility as probeAnnotationBodyPresenterEligibilityFn,
  type BodyOwnerHost,
  type BodyProbeHost,
} from './indexed-annotation-body-owner';
import {
  noteAnnotationBodyPresentationCommit as noteAnnotationBodyPresentationCommitFn,
  type BodyCommitHost,
} from './indexed-annotation-body-commit';
import {
  presentExclusiveAnnotationBodyFrame as presentExclusiveAnnotationBodyFrameFn,
  type ExclusiveBodyFrameHost,
} from './indexed-annotation-exclusive-body-frame';

export type AnnotationBodyFrameGlue = {
  maxAnnotationLane: number;
  prepackedAnnotationRuntimePolicy: AnnotationPolicyGpuRuntimeV1 | null;
  currentAnnotationSourceFingerprint: string | null;
  currentAnnotationPlacementFingerprint: string | null;
  prepackedAnnotationSceneResidents: BodyOwnerHost['prepackedAnnotationSceneResidents'];
  annotationLayerTypesForPresentation(): string[];
  compiledBroadSurfaceOwnerForTrack: BodyCommitHost['compiledBroadSurfaceOwnerForTrack'];
  compiledBroadSurfaceManifestFingerprintForTrack(trackId: string): string | null;
  compiledBroadSurfaceRequirement: BodyProbeHost['compiledBroadSurfaceRequirement'];
  compiledBroadSurfacePresenter: BodyProbeHost['compiledBroadSurfacePresenter'];
  compiledBroadSurfaceCandidatePresenter: BodyProbeHost['compiledBroadSurfaceCandidatePresenter'];
  compiledBroadSurfaceTrackOwners: BodyProbeHost['compiledBroadSurfaceTrackOwners'];
  compiledBroadSurfaceTrackCandidateOwners: BodyProbeHost['compiledBroadSurfaceTrackCandidateOwners'];
  prepackedAnnotationSceneLayer: BodyProbeHost['prepackedAnnotationSceneLayer'];
  prepackedAnnotationSceneLastCompleteOwnerKeys: BodyProbeHost['prepackedAnnotationSceneLastCompleteOwnerKeys'];
  prepackedAnnotationSceneInput: BodyProbeHost['prepackedAnnotationSceneInput'];
  prepackedAnnotationSceneStatus: BodyProbeHost['prepackedAnnotationSceneStatus'];
  genomeWideTextureCacheLayer: BodyProbeHost['genomeWideTextureCacheLayer'];
  genomeLength: number;
  tilePyramid: ExclusiveBodyFrameHost['tilePyramid'] & BodyProbeHost['tilePyramid'];
  tilePyramidHost(): ReturnType<ExclusiveBodyFrameHost['tilePyramidHost']>;
  tryPresentRequestedCompiledBroadSurfaces(
    camera: RetainedOverlayCameraState,
    requestedLayerTypes: readonly string[]
  ): AnnotationBodyReplacementReadiness;
  hideCompiledBroadPresenters(): void;
  tryPresentPrepackedAnnotationScene(
    camera: RetainedOverlayCameraState,
    style: RetainedOverviewAnnotationStyle,
    prebuiltRasterEligibility: AnnotationPrebuiltRasterEligibility
  ): AnnotationBodyReplacementReadiness;
  finalizeCompiledAnnotationBodyPresent(
    camera: RetainedOverlayCameraState,
    style: RetainedOverviewAnnotationStyle
  ): void;
  tryPresentPrebuiltRasterBody(
    camera: RetainedOverlayCameraState,
    style: RetainedOverviewAnnotationStyle,
    prebuiltRasterEligibility: AnnotationPrebuiltRasterEligibility
  ): boolean;
  tryRetainLastCompleteCompiledBroadSurfaceFrame(
    camera: RetainedOverlayCameraState,
    policy: { isoformMode: 'canonical' | 'expanded'; laneLimit: number | null }
  ): boolean;
};

function idleAnnotationBodyFrameGlue(): AnnotationBodyFrameGlue {
  return {
    maxAnnotationLane: 0,
    prepackedAnnotationRuntimePolicy: null,
    currentAnnotationSourceFingerprint: null,
    currentAnnotationPlacementFingerprint: null,
    prepackedAnnotationSceneResidents: new Map(),
    annotationLayerTypesForPresentation: () => [],
    compiledBroadSurfaceOwnerForTrack: () => null,
    compiledBroadSurfaceManifestFingerprintForTrack: () => null,
    compiledBroadSurfaceRequirement: null,
    compiledBroadSurfacePresenter: null,
    compiledBroadSurfaceCandidatePresenter: null,
    compiledBroadSurfaceTrackOwners: { size: 0 },
    compiledBroadSurfaceTrackCandidateOwners: { size: 0 },
    prepackedAnnotationSceneLayer: null,
    prepackedAnnotationSceneLastCompleteOwnerKeys: [],
    prepackedAnnotationSceneInput: null,
    prepackedAnnotationSceneStatus: 'not-loaded',
    genomeWideTextureCacheLayer: null,
    genomeLength: 0,
    tilePyramid: { vector: null, tryPresent: () => false },
    tilePyramidHost: () => ({}),
    tryPresentRequestedCompiledBroadSurfaces: () => 'absent',
    hideCompiledBroadPresenters() {},
    tryPresentPrepackedAnnotationScene: () => 'absent',
    finalizeCompiledAnnotationBodyPresent() {},
    tryPresentPrebuiltRasterBody: () => false,
    tryRetainLastCompleteCompiledBroadSurfaceFrame: () => false,
  };
}

export class AnnotationBodyFrameController
  implements BodyOwnerHost, BodyCommitHost, BodyProbeHost, ExclusiveBodyFrameHost
{
  annotationBodyPresentationCommitEpoch = 0;
  annotationBodyPresentationGeneration: AnnotationBodyPresentationGenerationV1 | null = null;
  annotationBodyFrameOwner: AnnotationBodyFrameOwnerKind = 'none';
  annotationBodyFrameEligibility: AnnotationBodyPresenterEligibility =
    emptyAnnotationBodyPresenterEligibility();

  private glue: AnnotationBodyFrameGlue;

  constructor(glue: Partial<AnnotationBodyFrameGlue> = {}) {
    this.glue = { ...idleAnnotationBodyFrameGlue(), ...glue };
  }

  attach(input: {
    layout: {
      maxAnnotationLane: number;
      currentAnnotationSourceFingerprint: string | null;
      currentAnnotationPlacementFingerprint: string | null;
      genomeLength: number;
    };
    prepacked: {
      prepackedAnnotationRuntimePolicy: AnnotationPolicyGpuRuntimeV1 | null;
      prepackedAnnotationSceneResidents: BodyOwnerHost['prepackedAnnotationSceneResidents'];
      prepackedAnnotationSceneLayer: BodyProbeHost['prepackedAnnotationSceneLayer'];
      prepackedAnnotationSceneLastCompleteOwnerKeys: BodyProbeHost['prepackedAnnotationSceneLastCompleteOwnerKeys'];
      prepackedAnnotationSceneInput: BodyProbeHost['prepackedAnnotationSceneInput'];
      prepackedAnnotationSceneStatus: BodyProbeHost['prepackedAnnotationSceneStatus'];
      present(
        camera: RetainedOverlayCameraState,
        style: RetainedOverviewAnnotationStyle,
        prebuiltRasterEligibility: AnnotationPrebuiltRasterEligibility
      ): AnnotationBodyReplacementReadiness;
    };
    compiledBroad: {
      compiledBroadSurfaceOwnerForTrack: BodyCommitHost['compiledBroadSurfaceOwnerForTrack'];
      compiledBroadSurfaceManifestFingerprintForTrack(trackId: string): string | null;
      compiledBroadSurfaceRequirement: BodyProbeHost['compiledBroadSurfaceRequirement'];
      compiledBroadSurfacePresenter: BodyProbeHost['compiledBroadSurfacePresenter'];
      compiledBroadSurfaceCandidatePresenter: BodyProbeHost['compiledBroadSurfaceCandidatePresenter'];
      compiledBroadSurfaceTrackOwners: BodyProbeHost['compiledBroadSurfaceTrackOwners'];
      compiledBroadSurfaceTrackCandidateOwners: BodyProbeHost['compiledBroadSurfaceTrackCandidateOwners'];
      tryPresentRequestedCompiledBroadSurfaces(
        camera: RetainedOverlayCameraState,
        requestedLayerTypes: readonly string[]
      ): AnnotationBodyReplacementReadiness;
      hideCompiledBroadPresenters(): void;
      tryRetainLastCompleteCompiledBroadSurfaceFrame(
        camera: RetainedOverlayCameraState,
        policy: { isoformMode: 'canonical' | 'expanded'; laneLimit: number | null }
      ): boolean;
    };
    retainedLinear: {
      genomeWideTextureCacheLayer: BodyProbeHost['genomeWideTextureCacheLayer'];
      finalizeCompiledAnnotationBodyPresent(
        camera: RetainedOverlayCameraState,
        style: RetainedOverviewAnnotationStyle
      ): void;
      tryPresentPrebuiltRasterBody(
        camera: RetainedOverlayCameraState,
        style: RetainedOverviewAnnotationStyle,
        prebuiltRasterEligibility: AnnotationPrebuiltRasterEligibility
      ): boolean;
    };
    tilePyramid: ExclusiveBodyFrameHost['tilePyramid'] & BodyProbeHost['tilePyramid'];
    annotationLayerTypesForPresentation(): string[];
    tilePyramidHost(): ReturnType<ExclusiveBodyFrameHost['tilePyramidHost']>;
  }): void {
    this.glue = {
      get maxAnnotationLane() {
        return input.layout.maxAnnotationLane;
      },
      get prepackedAnnotationRuntimePolicy() {
        return input.prepacked.prepackedAnnotationRuntimePolicy;
      },
      get currentAnnotationSourceFingerprint() {
        return input.layout.currentAnnotationSourceFingerprint;
      },
      get currentAnnotationPlacementFingerprint() {
        return input.layout.currentAnnotationPlacementFingerprint;
      },
      get prepackedAnnotationSceneResidents() {
        return input.prepacked.prepackedAnnotationSceneResidents;
      },
      annotationLayerTypesForPresentation: () => input.annotationLayerTypesForPresentation(),
      compiledBroadSurfaceOwnerForTrack: (trackId) =>
        input.compiledBroad.compiledBroadSurfaceOwnerForTrack(trackId),
      compiledBroadSurfaceManifestFingerprintForTrack: (trackId) =>
        input.compiledBroad.compiledBroadSurfaceManifestFingerprintForTrack(trackId),
      get compiledBroadSurfaceRequirement() {
        return input.compiledBroad.compiledBroadSurfaceRequirement;
      },
      get compiledBroadSurfacePresenter() {
        return input.compiledBroad.compiledBroadSurfacePresenter;
      },
      get compiledBroadSurfaceCandidatePresenter() {
        return input.compiledBroad.compiledBroadSurfaceCandidatePresenter;
      },
      get compiledBroadSurfaceTrackOwners() {
        return input.compiledBroad.compiledBroadSurfaceTrackOwners;
      },
      get compiledBroadSurfaceTrackCandidateOwners() {
        return input.compiledBroad.compiledBroadSurfaceTrackCandidateOwners;
      },
      get prepackedAnnotationSceneLayer() {
        return input.prepacked.prepackedAnnotationSceneLayer;
      },
      get prepackedAnnotationSceneLastCompleteOwnerKeys() {
        return input.prepacked.prepackedAnnotationSceneLastCompleteOwnerKeys;
      },
      get prepackedAnnotationSceneInput() {
        return input.prepacked.prepackedAnnotationSceneInput;
      },
      get prepackedAnnotationSceneStatus() {
        return input.prepacked.prepackedAnnotationSceneStatus;
      },
      get genomeWideTextureCacheLayer() {
        return input.retainedLinear.genomeWideTextureCacheLayer;
      },
      get genomeLength() {
        return input.layout.genomeLength;
      },
      get tilePyramid() {
        return input.tilePyramid;
      },
      tilePyramidHost: () => input.tilePyramidHost(),
      tryPresentRequestedCompiledBroadSurfaces: (camera, requestedLayerTypes) =>
        input.compiledBroad.tryPresentRequestedCompiledBroadSurfaces(camera, requestedLayerTypes),
      hideCompiledBroadPresenters: () => input.compiledBroad.hideCompiledBroadPresenters(),
      tryPresentPrepackedAnnotationScene: (camera, style, prebuiltRasterEligibility) =>
        input.prepacked.present(camera, style, prebuiltRasterEligibility),
      finalizeCompiledAnnotationBodyPresent: (camera, style) =>
        input.retainedLinear.finalizeCompiledAnnotationBodyPresent(camera, style),
      tryPresentPrebuiltRasterBody: (camera, style, prebuiltRasterEligibility) =>
        input.retainedLinear.tryPresentPrebuiltRasterBody(camera, style, prebuiltRasterEligibility),
      tryRetainLastCompleteCompiledBroadSurfaceFrame: (camera, policy) =>
        input.compiledBroad.tryRetainLastCompleteCompiledBroadSurfaceFrame(camera, policy),
    };
  }

  get maxAnnotationLane() {
    return this.glue.maxAnnotationLane;
  }
  get prepackedAnnotationRuntimePolicy() {
    return this.glue.prepackedAnnotationRuntimePolicy;
  }
  get currentAnnotationSourceFingerprint() {
    return this.glue.currentAnnotationSourceFingerprint;
  }
  get currentAnnotationPlacementFingerprint() {
    return this.glue.currentAnnotationPlacementFingerprint;
  }
  get prepackedAnnotationSceneResidents() {
    return this.glue.prepackedAnnotationSceneResidents;
  }
  annotationLayerTypesForPresentation(): string[] {
    return this.glue.annotationLayerTypesForPresentation();
  }
  compiledBroadSurfaceOwnerForTrack(
    trackId: string
  ): ReturnType<BodyCommitHost['compiledBroadSurfaceOwnerForTrack']> {
    return this.glue.compiledBroadSurfaceOwnerForTrack(trackId);
  }
  compiledBroadSurfaceManifestFingerprintForTrack(trackId: string): string | null {
    return this.glue.compiledBroadSurfaceManifestFingerprintForTrack(trackId);
  }
  get compiledBroadSurfaceRequirement() {
    return this.glue.compiledBroadSurfaceRequirement;
  }
  get compiledBroadSurfacePresenter() {
    return this.glue.compiledBroadSurfacePresenter;
  }
  get compiledBroadSurfaceCandidatePresenter() {
    return this.glue.compiledBroadSurfaceCandidatePresenter;
  }
  get compiledBroadSurfaceTrackOwners() {
    return this.glue.compiledBroadSurfaceTrackOwners;
  }
  get compiledBroadSurfaceTrackCandidateOwners() {
    return this.glue.compiledBroadSurfaceTrackCandidateOwners;
  }
  get prepackedAnnotationSceneLayer() {
    return this.glue.prepackedAnnotationSceneLayer;
  }
  get prepackedAnnotationSceneLastCompleteOwnerKeys() {
    return this.glue.prepackedAnnotationSceneLastCompleteOwnerKeys;
  }
  get prepackedAnnotationSceneInput() {
    return this.glue.prepackedAnnotationSceneInput;
  }
  get prepackedAnnotationSceneStatus() {
    return this.glue.prepackedAnnotationSceneStatus;
  }
  get genomeWideTextureCacheLayer() {
    return this.glue.genomeWideTextureCacheLayer;
  }
  get genomeLength() {
    return this.glue.genomeLength;
  }
  get tilePyramid() {
    return this.glue.tilePyramid;
  }
  tilePyramidHost(): ReturnType<ExclusiveBodyFrameHost['tilePyramidHost']> {
    return this.glue.tilePyramidHost();
  }
  tryPresentRequestedCompiledBroadSurfaces(
    camera: RetainedOverlayCameraState,
    requestedLayerTypes: readonly string[]
  ): AnnotationBodyReplacementReadiness {
    return this.glue.tryPresentRequestedCompiledBroadSurfaces(camera, requestedLayerTypes);
  }
  hideCompiledBroadPresenters(): void {
    this.glue.hideCompiledBroadPresenters();
  }
  tryPresentPrepackedAnnotationScene(
    camera: RetainedOverlayCameraState,
    style: RetainedOverviewAnnotationStyle,
    prebuiltRasterEligibility: AnnotationPrebuiltRasterEligibility
  ): AnnotationBodyReplacementReadiness {
    return this.glue.tryPresentPrepackedAnnotationScene(camera, style, prebuiltRasterEligibility);
  }
  finalizeCompiledAnnotationBodyPresent(
    camera: RetainedOverlayCameraState,
    style: RetainedOverviewAnnotationStyle
  ): void {
    this.glue.finalizeCompiledAnnotationBodyPresent(camera, style);
  }
  tryPresentPrebuiltRasterBody(
    camera: RetainedOverlayCameraState,
    style: RetainedOverviewAnnotationStyle,
    prebuiltRasterEligibility: AnnotationPrebuiltRasterEligibility
  ): boolean {
    return this.glue.tryPresentPrebuiltRasterBody(camera, style, prebuiltRasterEligibility);
  }
  tryRetainLastCompleteCompiledBroadSurfaceFrame(
    camera: RetainedOverlayCameraState,
    policy: { isoformMode: 'canonical' | 'expanded'; laneLimit: number | null }
  ): boolean {
    return this.glue.tryRetainLastCompleteCompiledBroadSurfaceFrame(camera, policy);
  }
  probeAnnotationBodyPresenterEligibility(
    camera: RetainedOverlayCameraState,
    prebuiltRasterEligibility: { eligible: boolean },
    priorFrameHadCompleteBroadOwnership: boolean
  ): AnnotationBodyPresenterEligibility {
    return probeAnnotationBodyPresenterEligibilityFn(
      this,
      camera,
      prebuiltRasterEligibility,
      priorFrameHadCompleteBroadOwnership
    );
  }
  presentExclusiveAnnotationBodyFrame(
    camera: RetainedOverlayCameraState,
    style: RetainedOverviewAnnotationStyle,
    prebuiltRasterEligibility: AnnotationPrebuiltRasterEligibility,
    priorFrameHadCompleteBroadOwnership: boolean
  ): boolean {
    return presentExclusiveAnnotationBodyFrameFn(
      this,
      camera,
      style,
      prebuiltRasterEligibility,
      priorFrameHadCompleteBroadOwnership
    );
  }

  noteAnnotationBodyPresentationCommit(
    input?: Parameters<typeof noteAnnotationBodyPresentationCommitFn>[1]
  ): void {
    noteAnnotationBodyPresentationCommitFn(this, input);
  }
  annotationBodyProductFingerprintsMatchCurrentGeneration(
    committed: readonly string[],
    productKind: AnnotationBodyFrameOwnerKind,
    orderedVisibleTrackIds: readonly string[],
    explicit: readonly string[] | undefined
  ): boolean {
    return annotationBodyProductFingerprintsMatchCurrentGenerationFn(
      this,
      committed,
      productKind,
      orderedVisibleTrackIds,
      explicit
    );
  }
  noteAnnotationBodyFrameOwner(
    frameOwner: AnnotationBodyFrameOwnerKind,
    probedEligibility?: AnnotationBodyPresenterEligibility
  ): void {
    noteAnnotationBodyFrameOwnerFn(this, frameOwner, probedEligibility);
  }
}

declare module './indexed-annotation-overlay-collaborators' {
  interface OverlayBodyFrameCollaborator extends AnnotationBodyFrameController {}
}
