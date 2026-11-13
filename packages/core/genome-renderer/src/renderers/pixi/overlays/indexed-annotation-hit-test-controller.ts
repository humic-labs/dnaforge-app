import type { Feature } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import type { OverlayHitResult } from './overlay-track';
import type { HitRecord } from './hit-testing';
import {
  hitTestAnnotationOverlay,
  hitTestCompiledBroadAnnotationInteraction,
  hitTestPrepackedAnnotationResident,
  hitTestPrepackedAnnotationScene,
  hitTestRetainedLinearTranscripts,
  hitTestRetainedOverview,
  prepackedAnnotationInteractionP99Ms,
  recordPrepackedAnnotationInteraction,
  type AnnotationHitDispatchHost,
  type AnnotationHitTestHost,
  type CompiledBroadHitResident,
  type PrepackedHitResident,
  type RetainedOverviewHitBin,
  type RetainedTranscriptHitHost,
} from './indexed-annotation-hit-test';

import type { OverlayPresenterCollaborators } from './indexed-annotation-overlay-collaborators';

export type AnnotationHitTestGlue = {
  genomeLength: number;
  maxAnnotationLane: number;
  prepackedAnnotationRuntimePolicy: AnnotationHitTestHost['prepackedAnnotationRuntimePolicy'];
  prepackedAnnotationSceneResidents: Map<string, PrepackedHitResident>;
  prepackedAnnotationPolicyTransactionInFlight: boolean;
  retainedOverviewMode: string;
  retainedOverviewHitBins: readonly RetainedOverviewHitBin[];
  retainedLinearTranscriptFeatureSet: Set<Feature> | null;
  annotationLayerTypesForPresentation(): string[];
  prepackedAnnotationScenePresentingResidents(): PrepackedHitResident[];
  compiledBroadAnnotationInteractionResidentForTrack(
    trackType: string
  ): CompiledBroadHitResident | null;
  compiledBroadSurfaceLaneStart(
    trackType: string,
    presentationLayerTypes: readonly string[],
    policy: NonNullable<AnnotationHitTestHost['prepackedAnnotationRuntimePolicy']>
  ): number;
  compiledBroadSurfaceOwnerForTrack(
    trackType: string
  ): ReturnType<AnnotationHitTestHost['compiledBroadSurfaceOwnerForTrack']>;
  compiledBroadSurfaceInteractionResidentForTrack(trackType: string): PrepackedHitResident | null;
  compiledBroadSurfacePresentingLayerTypes(): string[];
  prepackedAnnotationCenterScreenY(path: PathMapper, offsetPx: number): number | null;
  prepackedResidentTrackOffsetPx(
    resident: PrepackedHitResident,
    presentationLayerTypes: readonly string[],
    policy: NonNullable<AnnotationHitTestHost['prepackedAnnotationRuntimePolicy']>
  ): number;
  prepackedPolicyTrackLaneForPrimitive(
    primitiveIndex: number,
    input: PrepackedHitResident['input']
  ): number | null | undefined;
  scaledBarHeight(): number;
  featuresInRange(viewStartBp: number, viewEndBp: number): Feature[];
  featureOffset(feature: Feature): number;
  transcriptIntronGapRanges(
    feature: Feature,
    path: PathMapper
  ): Array<{ startBp: number; endBp: number }>;
};

function idleAnnotationHitTestGlue(): AnnotationHitTestGlue {
  return {
    genomeLength: 0,
    maxAnnotationLane: 0,
    prepackedAnnotationRuntimePolicy: null,
    prepackedAnnotationSceneResidents: new Map(),
    prepackedAnnotationPolicyTransactionInFlight: false,
    retainedOverviewMode: 'inactive',
    retainedOverviewHitBins: [],
    retainedLinearTranscriptFeatureSet: null,
    annotationLayerTypesForPresentation: () => [],
    prepackedAnnotationScenePresentingResidents: () => [],
    compiledBroadAnnotationInteractionResidentForTrack: () => null,
    compiledBroadSurfaceLaneStart: () => 0,
    compiledBroadSurfaceOwnerForTrack: () => null,
    compiledBroadSurfaceInteractionResidentForTrack: () => null,
    compiledBroadSurfacePresentingLayerTypes: () => [],
    prepackedAnnotationCenterScreenY: () => null,
    prepackedResidentTrackOffsetPx: () => 0,
    prepackedPolicyTrackLaneForPrimitive: () => undefined,
    scaledBarHeight: () => 0,
    featuresInRange: () => [],
    featureOffset: () => 0,
    transcriptIntronGapRanges: () => [],
  };
}

export class AnnotationHitTestController
  implements AnnotationHitTestHost, AnnotationHitDispatchHost, RetainedTranscriptHitHost
{
  hitCache: HitRecord[] = [];
  prepackedAnnotationLastHitOwnerKey: string | null = null;
  prepackedAnnotationInteractionQueries = 0;
  prepackedAnnotationInteractionLastVisitedNodes = 0;
  prepackedAnnotationInteractionMaxVisitedNodes = 0;
  prepackedAnnotationInteractionLastPrimitiveCandidates = 0;
  prepackedAnnotationInteractionMaxMs = 0;
  readonly prepackedAnnotationInteractionDurations = new Float32Array(256);
  prepackedAnnotationInteractionDurationCursor = 0;
  prepackedAnnotationInteractionDurationCount = 0;

  private glue: AnnotationHitTestGlue = idleAnnotationHitTestGlue();

  constructor() {}
  attach(collaborators: OverlayPresenterCollaborators): void {
    this.glue = {
      get genomeLength() {
        return collaborators.layout.genomeLength;
      },
      get maxAnnotationLane() {
        return collaborators.layout.maxAnnotationLane;
      },
      get prepackedAnnotationRuntimePolicy() {
        return collaborators.prepacked.prepackedAnnotationRuntimePolicy;
      },
      get prepackedAnnotationSceneResidents() {
        return collaborators.prepacked
          .prepackedAnnotationSceneResidents as AnnotationHitTestGlue['prepackedAnnotationSceneResidents'];
      },
      get prepackedAnnotationPolicyTransactionInFlight() {
        return collaborators.prepacked.prepackedAnnotationPolicyTransactionInFlight;
      },
      get retainedOverviewMode() {
        return collaborators.retained.retainedOverviewMode;
      },
      get retainedOverviewHitBins() {
        return collaborators.retained
          .retainedOverviewHitBins as AnnotationHitTestGlue['retainedOverviewHitBins'];
      },
      get retainedLinearTranscriptFeatureSet() {
        return collaborators.retained.retainedLinearTranscriptFeatureSet;
      },
      annotationLayerTypesForPresentation: () =>
        collaborators.layout.annotationLayerTypesForPresentation(),
      prepackedAnnotationScenePresentingResidents: () =>
        collaborators.prepacked.prepackedAnnotationScenePresentingResidents() as ReturnType<
          AnnotationHitTestGlue['prepackedAnnotationScenePresentingResidents']
        >,
      compiledBroadAnnotationInteractionResidentForTrack: (trackType) =>
        collaborators.compiledBroad.compiledBroadAnnotationInteractionResidentForTrack(trackType),
      compiledBroadSurfaceLaneStart: (trackType, presentationLayerTypes, policy) =>
        collaborators.compiledBroad.compiledBroadSurfaceLaneStart(
          trackType,
          presentationLayerTypes,
          policy
        ),
      compiledBroadSurfaceOwnerForTrack: (trackType) =>
        collaborators.compiledBroad.compiledBroadSurfaceOwnerForTrack(trackType) as ReturnType<
          AnnotationHitTestGlue['compiledBroadSurfaceOwnerForTrack']
        >,
      compiledBroadSurfaceInteractionResidentForTrack: (trackType) =>
        collaborators.compiledBroad.compiledBroadSurfaceInteractionResidentForTrack(trackType),
      compiledBroadSurfacePresentingLayerTypes: () =>
        collaborators.compiledBroad.compiledBroadSurfacePresentingLayerTypes(),
      prepackedAnnotationCenterScreenY: (path, offsetPx) =>
        collaborators.layout.prepackedAnnotationCenterScreenY(path, offsetPx),
      prepackedResidentTrackOffsetPx: (resident, presentationLayerTypes, policy) =>
        collaborators.prepacked.prepackedResidentTrackOffsetPx(
          resident,
          presentationLayerTypes,
          policy
        ),
      prepackedPolicyTrackLaneForPrimitive: (primitiveIndex, input) =>
        collaborators.prepacked.prepackedPolicyTrackLaneForPrimitive(primitiveIndex, input),
      scaledBarHeight: () => collaborators.layout.scaledBarHeight(),
      featuresInRange: (viewStartBp, viewEndBp) =>
        collaborators.layout.featuresInRange(viewStartBp, viewEndBp),
      featureOffset: (feature) => collaborators.layout.featureOffset(feature),
      transcriptIntronGapRanges: (feature, path) =>
        collaborators.immediateDraw.transcriptIntronGapRanges(feature, path),
    } as AnnotationHitTestGlue;
  }

  get genomeLength() {
    return this.glue.genomeLength;
  }
  get maxAnnotationLane() {
    return this.glue.maxAnnotationLane;
  }
  get prepackedAnnotationRuntimePolicy() {
    return this.glue.prepackedAnnotationRuntimePolicy;
  }
  get prepackedAnnotationSceneResidents() {
    return this.glue.prepackedAnnotationSceneResidents;
  }
  get prepackedAnnotationPolicyTransactionInFlight() {
    return this.glue.prepackedAnnotationPolicyTransactionInFlight;
  }
  get retainedOverviewMode() {
    return this.glue.retainedOverviewMode;
  }
  get retainedOverviewHitBins() {
    return this.glue.retainedOverviewHitBins;
  }
  get retainedLinearTranscriptFeatureSet() {
    return this.glue.retainedLinearTranscriptFeatureSet;
  }

  annotationLayerTypesForPresentation(): string[] {
    return this.glue.annotationLayerTypesForPresentation();
  }
  prepackedAnnotationScenePresentingResidents(): PrepackedHitResident[] {
    return this.glue.prepackedAnnotationScenePresentingResidents();
  }
  compiledBroadAnnotationInteractionResidentForTrack(
    trackType: string
  ): CompiledBroadHitResident | null {
    return this.glue.compiledBroadAnnotationInteractionResidentForTrack(trackType);
  }
  compiledBroadSurfaceLaneStart(
    trackType: string,
    presentationLayerTypes: readonly string[],
    policy: NonNullable<AnnotationHitTestHost['prepackedAnnotationRuntimePolicy']>
  ): number {
    return this.glue.compiledBroadSurfaceLaneStart(trackType, presentationLayerTypes, policy);
  }
  compiledBroadSurfaceOwnerForTrack(
    trackType: string
  ): ReturnType<AnnotationHitTestHost['compiledBroadSurfaceOwnerForTrack']> {
    return this.glue.compiledBroadSurfaceOwnerForTrack(trackType);
  }
  compiledBroadSurfaceInteractionResidentForTrack(trackType: string): PrepackedHitResident | null {
    return this.glue.compiledBroadSurfaceInteractionResidentForTrack(trackType);
  }
  compiledBroadSurfacePresentingLayerTypes(): string[] {
    return this.glue.compiledBroadSurfacePresentingLayerTypes();
  }
  prepackedAnnotationCenterScreenY(path: PathMapper, offsetPx: number): number | null {
    return this.glue.prepackedAnnotationCenterScreenY(path, offsetPx);
  }
  prepackedResidentTrackOffsetPx(
    resident: PrepackedHitResident,
    presentationLayerTypes: readonly string[],
    policy: NonNullable<AnnotationHitTestHost['prepackedAnnotationRuntimePolicy']>
  ): number {
    return this.glue.prepackedResidentTrackOffsetPx(resident, presentationLayerTypes, policy);
  }
  prepackedPolicyTrackLaneForPrimitive(
    primitiveIndex: number,
    input: PrepackedHitResident['input']
  ): number | null | undefined {
    return this.glue.prepackedPolicyTrackLaneForPrimitive(primitiveIndex, input);
  }
  scaledBarHeight(): number {
    return this.glue.scaledBarHeight();
  }
  featuresInRange(viewStartBp: number, viewEndBp: number): Feature[] {
    return this.glue.featuresInRange(viewStartBp, viewEndBp);
  }
  featureOffset(feature: Feature): number {
    return this.glue.featureOffset(feature);
  }
  transcriptIntronGapRanges(
    feature: Feature,
    path: PathMapper
  ): Array<{ startBp: number; endBp: number }> {
    return this.glue.transcriptIntronGapRanges(feature, path);
  }

  hitTest(screenX: number, screenY: number, path: PathMapper): OverlayHitResult | null {
    return hitTestAnnotationOverlay(this, screenX, screenY, path);
  }
  hitTestCompiledBroadAnnotationInteraction(
    screenX: number,
    screenY: number,
    path: PathMapper,
    presentationLayerTypes: readonly string[]
  ): OverlayHitResult | null {
    return hitTestCompiledBroadAnnotationInteraction(
      this,
      screenX,
      screenY,
      path,
      presentationLayerTypes
    );
  }
  hitTestPrepackedAnnotationScene(
    screenX: number,
    screenY: number,
    path: PathMapper,
    explicitPresentationLayerTypes?: readonly string[]
  ): OverlayHitResult | null {
    return hitTestPrepackedAnnotationScene(
      this,
      screenX,
      screenY,
      path,
      explicitPresentationLayerTypes
    );
  }
  hitTestPrepackedAnnotationResident(
    resident: PrepackedHitResident,
    screenX: number,
    screenY: number,
    path: PathMapper,
    trackOffsetPx: number
  ): OverlayHitResult | null {
    return hitTestPrepackedAnnotationResident(
      this,
      resident,
      screenX,
      screenY,
      path,
      trackOffsetPx
    );
  }
  recordPrepackedAnnotationInteraction(
    visitedNodes: number,
    primitiveCandidates: number,
    durationMs: number
  ): void {
    recordPrepackedAnnotationInteraction(this, visitedNodes, primitiveCandidates, durationMs);
  }
  prepackedAnnotationInteractionP99Ms(): number {
    return prepackedAnnotationInteractionP99Ms(this);
  }
  hitTestRetainedOverview(
    screenX: number,
    screenY: number,
    path: PathMapper
  ): OverlayHitResult | null {
    return hitTestRetainedOverview(this, screenX, screenY, path);
  }
  hitTestRetainedLinearTranscripts(
    screenX: number,
    screenY: number,
    path: PathMapper
  ): OverlayHitResult | null {
    return hitTestRetainedLinearTranscripts(this, screenX, screenY, path);
  }
}

declare module './indexed-annotation-overlay-collaborators' {
  interface OverlayHitsCollaborator extends AnnotationHitTestController {}
}
