import type {
  AnnotationResidentPagePublication,
  AnnotationResidentPagePublicationApplyResult,
  Feature,
  RenderState,
} from '../../../types';
import type { AnnotationResidentPageStore } from '../../../annotation-resident-page-store';
import type { AnnotationResidentPageRecord } from '../../../annotation-resident-page-store';
import type { AnnotationPolicyGpuRuntimeV1 } from '../overview/annotation-policy-gpu-instances-v1';
import {
  ingestAnnotationResidentPages as ingestAnnotationResidentPagesFn,
  prepackedPolicyFeatureIndexForResidentFeature as prepackedPolicyFeatureIndexForResidentFeatureFn,
  projectResidentAnnotationFeatures as projectResidentAnnotationFeaturesFn,
  residentAnnotationPolicyProjectionKey as residentAnnotationPolicyProjectionKeyFn,
  selectResidentAnnotationFeaturesForViewport as selectResidentAnnotationFeaturesForViewportFn,
  type ResidentPageFeatureResident,
  type ResidentPageLifecycleHost,
  type ResidentViewportSelectionCache,
} from './indexed-annotation-resident-pages';

export type AnnotationResidentPageCollaborators = {
  layout: {
    genomeLength: number;
    maxAnnotationLane: number;
    maxCdsLane: number;
    currentGenomeIdentity: string | null;
    annotationRequestedLayerTypes: string[];
    annotationExactCoverage: Array<{ startBp: number; endBp: number }> | null;
    features: Feature[];
    reconcileAnnotationLaneEnvelopeAuthority(): void;
    commitAnnotationLaneEnvelope(maxAnnotationLane: number, maxCdsLane: number): void;
  };
  prepacked: {
    prepackedAnnotationPolicyGeneration: number;
    prepackedAnnotationRuntimePolicy: AnnotationPolicyGpuRuntimeV1 | null;
    prepackedResidentPolicyFeatureIndexCache: Map<string, number | null>;
    prepackedAnnotationSceneInput: unknown;
  };
  compiledBroad: {
    prepackedAnnotationSceneResidentForTrack(trackId: string): unknown;
    compiledBroadSurfaceLaneStart(
      trackType: string,
      requestedLayerTypes: readonly string[],
      policy: AnnotationPolicyGpuRuntimeV1
    ): number;
  };
  annotationLayerTypesForPresentation(): string[];
};

function idleAnnotationResidentPageCollaborators(): AnnotationResidentPageCollaborators {
  return {
    layout: {
      genomeLength: 0,
      maxAnnotationLane: 0,
      maxCdsLane: -1,
      currentGenomeIdentity: null,
      annotationRequestedLayerTypes: [],
      annotationExactCoverage: [],
      features: [],
      reconcileAnnotationLaneEnvelopeAuthority() {},
      commitAnnotationLaneEnvelope() {},
    },
    prepacked: {
      prepackedAnnotationPolicyGeneration: 0,
      prepackedAnnotationRuntimePolicy: null,
      prepackedResidentPolicyFeatureIndexCache: new Map(),
      prepackedAnnotationSceneInput: null,
    },
    compiledBroad: {
      prepackedAnnotationSceneResidentForTrack: () => null,
      compiledBroadSurfaceLaneStart: () => 0,
    },
    annotationLayerTypesForPresentation: () => [],
  };
}

export class AnnotationResidentPageController implements ResidentPageLifecycleHost {
  readonly annotationResidentPageStreams = new Map<
    string,
    { generation: number; snapshot: AnnotationResidentPagePublication }
  >();
  activeAnnotationResidentPageStreamKey: string | null = null;
  annotationResidentPageStore: AnnotationResidentPageStore | null = null;
  residentAnnotationViewportSelectionCache: ResidentViewportSelectionCache | null = null;
  residentAnnotationViewportSelectionStatus: 'unavailable' | 'ready' | 'incomplete' = 'unavailable';
  residentAnnotationViewportSelectionQueries = 0;
  residentAnnotationViewportSelectedPageCount = 0;
  residentAnnotationViewportSelectedFeatureCount = 0;
  residentAnnotationViewportExpectedPageCount = 0;
  residentAnnotationViewportMissingPageCount = 0;
  residentAnnotationViewportCoverageComplete = false;
  residentAnnotationViewportProducerCoverageComplete = false;
  residentAnnotationPageSnapshotApplies = 0;
  residentAnnotationPageFlatGraphSkips = 0;

  private collaborators: AnnotationResidentPageCollaborators =
    idleAnnotationResidentPageCollaborators();

  attach(collaborators: AnnotationResidentPageCollaborators): void {
    this.collaborators = collaborators;
  }

  get genomeLength() {
    return this.collaborators.layout.genomeLength;
  }
  get maxAnnotationLane() {
    return this.collaborators.layout.maxAnnotationLane;
  }
  get maxCdsLane() {
    return this.collaborators.layout.maxCdsLane;
  }
  get prepackedAnnotationPolicyGeneration() {
    return this.collaborators.prepacked.prepackedAnnotationPolicyGeneration;
  }
  get prepackedAnnotationRuntimePolicy() {
    return this.collaborators.prepacked.prepackedAnnotationRuntimePolicy;
  }
  get prepackedResidentPolicyFeatureIndexCache() {
    return this.collaborators.prepacked.prepackedResidentPolicyFeatureIndexCache;
  }
  annotationLayerTypesForPresentation(): string[] {
    return this.collaborators.annotationLayerTypesForPresentation();
  }
  prepackedAnnotationSceneResidentForTrack(trackId: string): ResidentPageFeatureResident | null {
    return this.collaborators.compiledBroad.prepackedAnnotationSceneResidentForTrack(
      trackId
    ) as ResidentPageFeatureResident | null;
  }
  compiledBroadSurfaceLaneStart(
    trackType: string,
    requestedLayerTypes: readonly string[],
    policy: AnnotationPolicyGpuRuntimeV1
  ): number {
    return this.collaborators.compiledBroad.compiledBroadSurfaceLaneStart(
      trackType,
      requestedLayerTypes,
      policy
    );
  }
  get currentGenomeIdentity() {
    return this.collaborators.layout.currentGenomeIdentity;
  }
  get annotationRequestedLayerTypes() {
    return this.collaborators.layout.annotationRequestedLayerTypes;
  }
  set annotationRequestedLayerTypes(value) {
    this.collaborators.layout.annotationRequestedLayerTypes = value as string[];
  }
  get annotationExactCoverage() {
    return this.collaborators.layout
      .annotationExactCoverage as ResidentPageLifecycleHost['annotationExactCoverage'];
  }
  set annotationExactCoverage(value) {
    this.collaborators.layout.annotationExactCoverage = value;
  }
  get prepackedAnnotationSceneInput() {
    return this.collaborators.prepacked
      .prepackedAnnotationSceneInput as ResidentPageLifecycleHost['prepackedAnnotationSceneInput'];
  }
  get features() {
    return this.collaborators.layout.features;
  }
  reconcileAnnotationLaneEnvelopeAuthority(): void {
    this.collaborators.layout.reconcileAnnotationLaneEnvelopeAuthority();
  }
  commitAnnotationLaneEnvelope(maxAnnotationLane: number, maxCdsLane: number): void {
    this.collaborators.layout.commitAnnotationLaneEnvelope(maxAnnotationLane, maxCdsLane);
  }

  ingestAnnotationResidentPages(
    publication: AnnotationResidentPagePublication
  ): AnnotationResidentPagePublicationApplyResult {
    return ingestAnnotationResidentPagesFn(this, publication);
  }
  selectResidentAnnotationFeaturesForViewport(
    viewStartBp: number,
    viewEndBp: number,
    annotationSearchFocus: RenderState['annotationSearchFocus'] = null
  ) {
    return selectResidentAnnotationFeaturesForViewportFn(
      this,
      viewStartBp,
      viewEndBp,
      annotationSearchFocus
    );
  }
  residentAnnotationPolicyProjectionKey(
    annotationSearchFocus: RenderState['annotationSearchFocus']
  ): string {
    return residentAnnotationPolicyProjectionKeyFn(this, annotationSearchFocus);
  }
  projectResidentAnnotationFeatures(
    records: ReadonlyArray<AnnotationResidentPageRecord>,
    annotationSearchFocus: RenderState['annotationSearchFocus']
  ): Feature[] | null {
    return projectResidentAnnotationFeaturesFn(this, records, annotationSearchFocus);
  }
  prepackedPolicyFeatureIndexForResidentFeature(
    resident: ResidentPageFeatureResident,
    feature: Feature,
    canonicalIdentity: string
  ): number | null {
    return prepackedPolicyFeatureIndexForResidentFeatureFn(
      this,
      resident,
      feature,
      canonicalIdentity
    );
  }
  activeResidentPublicationOwnsAnnotationBodyFallback(): boolean {
    const streamKey = this.activeAnnotationResidentPageStreamKey;
    return (
      (streamKey ? this.annotationResidentPageStreams.get(streamKey)?.snapshot.contract : null) ===
      'annotation-resident-page-publication.v1'
    );
  }
}

declare module './indexed-annotation-overlay-collaborators' {
  interface OverlayResidentPagesCollaborator extends AnnotationResidentPageController {}
}
