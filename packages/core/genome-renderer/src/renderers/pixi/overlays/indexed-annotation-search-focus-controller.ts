import { Graphics } from 'pixi.js';
import type { Feature, RenderState } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import type { UnifiedLayout } from '../shared/track-layout';
import type { TrackContract } from '../shared/lane-contracts';
import type { OutlineCommand } from './annotation-feature-geometry';
import type { AnnotationPolicyGpuRuntimeV1 } from '../overview/annotation-policy-gpu-instances-v1';
import type { CompiledBroadSurfaceTrackOwnerV2 } from './indexed-compiled-broad-frame';
import type { PrepackedAnnotationSceneLoadInput } from '../overview/prepacked-annotation-scene';
import {
  renderAnnotationSearchFocus as renderAnnotationSearchFocusFn,
  resolvePrepackedAnnotationSearchFocusTarget as resolvePrepackedAnnotationSearchFocusTargetFn,
  type SearchFocusHost,
} from './indexed-annotation-search-focus';

import type { OverlayPresenterCollaborators } from './indexed-annotation-overlay-collaborators';

export type AnnotationSearchFocusGlue = Omit<
  SearchFocusHost,
  | 'annotationSearchFocusMaskDrawCount'
  | 'annotationSearchFocusPrimitiveDrawCount'
  | 'annotationSearchFocusResolvedTrackId'
  | 'annotationSearchFocusResolvedCanonicalIdentity'
  | 'annotationSearchFocusPresentationLane'
  | 'annotationSearchFocusGraphics'
>;

function idleAnnotationSearchFocusGlue(): AnnotationSearchFocusGlue {
  return {
    genomeLength: 0,
    layout: null,
    contract: null,
    maxAnnotationLane: 0,
    maxCdsLane: -1,
    prepackedAnnotationRuntimePolicy: null,
    resolvePrepackedAnnotationSearchFocusTarget: () => null,
    compiledBroadSurfaceOwnerForTrack: () => null,
    compiledBroadSurfaceLaneStart: () => 0,
    annotationTrackRealizedLaneCapacity: () => 0,
    prepackedAnnotationPolicyFeatureIsDurablyVisible: () => true,
    prepackedAnnotationCenterScreenY: () => null,
    scaledBarHeight: () => 0,
    prepackedResidentTrackOffsetPx: () => 0,
    cdsDetailProgress: () => 0,
    prepackedAnnotationPrimitiveScreenGeometry: () => null,
    featureOffset: () => 0,
    transcriptGlyphOutlineCommands: () => [],
    strokeOutlineCommands() {},
    standardFeatureDrawPoints: () => [],
  };
}

export class AnnotationSearchFocusController implements SearchFocusHost {
  annotationSearchFocusMaskDrawCount = 0;
  annotationSearchFocusPrimitiveDrawCount = 0;
  annotationSearchFocusResolvedTrackId: string | null = null;
  annotationSearchFocusResolvedCanonicalIdentity: string | null = null;
  annotationSearchFocusPresentationLane: number | null = null;
  readonly annotationSearchFocusGraphics = new Graphics();

  private glue: AnnotationSearchFocusGlue = idleAnnotationSearchFocusGlue();

  constructor() {}
  attach(collaborators: OverlayPresenterCollaborators): void {
    this.glue = {
      get genomeLength() {
        return collaborators.layout.genomeLength;
      },
      get layout() {
        return collaborators.layout._layout;
      },
      get contract() {
        return collaborators.layout._contract;
      },
      get maxAnnotationLane() {
        return collaborators.layout.maxAnnotationLane;
      },
      get maxCdsLane() {
        return collaborators.layout.maxCdsLane;
      },
      get prepackedAnnotationRuntimePolicy() {
        return collaborators.prepacked.prepackedAnnotationRuntimePolicy;
      },
      resolvePrepackedAnnotationSearchFocusTarget: (focus) =>
        resolvePrepackedAnnotationSearchFocusTargetFn(
          {
            compiledBroadSurfacePresentingLayerTypes: () =>
              collaborators.compiledBroad.compiledBroadSurfacePresentingLayerTypes(),
            prepackedAnnotationScenePresentingResidents: () =>
              collaborators.prepacked.prepackedAnnotationScenePresentingResidents(),
            compiledBroadSurfaceInteractionResidentForTrack: (trackId) =>
              collaborators.compiledBroad.compiledBroadSurfaceInteractionResidentForTrack(
                trackId
              ) as never,
          },
          focus
        ),
      compiledBroadSurfaceOwnerForTrack: (trackId) =>
        collaborators.compiledBroad.compiledBroadSurfaceOwnerForTrack(trackId) as ReturnType<
          AnnotationSearchFocusGlue['compiledBroadSurfaceOwnerForTrack']
        >,
      compiledBroadSurfaceLaneStart: (trackId, presentationTrackIds, policy) =>
        collaborators.compiledBroad.compiledBroadSurfaceLaneStart(
          trackId,
          presentationTrackIds,
          policy
        ),
      annotationTrackRealizedLaneCapacity: (trackId, policy, singleTrack) =>
        collaborators.compiledBroad.annotationTrackRealizedLaneCapacity(
          trackId,
          policy,
          singleTrack
        ),
      prepackedAnnotationPolicyFeatureIsDurablyVisible: (resident, featureIndex) =>
        collaborators.prepacked.prepackedAnnotationPolicyFeatureIsDurablyVisible(
          resident as never,
          featureIndex
        ),
      prepackedAnnotationCenterScreenY: (path, offsetPx) =>
        collaborators.layout.prepackedAnnotationCenterScreenY(path, offsetPx),
      scaledBarHeight: () => collaborators.layout.scaledBarHeight(),
      prepackedResidentTrackOffsetPx: (resident, presentationTrackIds, policy) =>
        collaborators.prepacked.prepackedResidentTrackOffsetPx(
          resident as never,
          presentationTrackIds,
          policy
        ),
      cdsDetailProgress: () => collaborators.layout.cdsDetailProgress(),
      prepackedAnnotationPrimitiveScreenGeometry: (
        path,
        state,
        input,
        primitiveIndex,
        trackOffsetPx,
        temporaryAdditionalLane
      ) =>
        collaborators.prepacked.prepackedAnnotationPrimitiveScreenGeometry(
          path,
          state,
          input,
          primitiveIndex,
          trackOffsetPx,
          temporaryAdditionalLane
        ),
      featureOffset: (feature) => collaborators.layout.featureOffset(feature),
      transcriptGlyphOutlineCommands: (feature, path) =>
        collaborators.immediateDraw.transcriptGlyphOutlineCommands(feature, path),
      strokeOutlineCommands: (graphics, path, commands, color, alpha) =>
        collaborators.immediateDraw.strokeOutlineCommands(graphics, path, commands, color, alpha),
      standardFeatureDrawPoints: (feature, endBp, pixelWidth, path, hitPts) =>
        collaborators.immediateDraw.standardFeatureDrawPoints(
          feature,
          endBp,
          pixelWidth,
          path,
          hitPts
        ),
    } as AnnotationSearchFocusGlue;
  }

  get genomeLength() {
    return this.glue.genomeLength;
  }
  get layout() {
    return this.glue.layout;
  }
  get contract() {
    return this.glue.contract;
  }
  get maxAnnotationLane() {
    return this.glue.maxAnnotationLane;
  }
  get maxCdsLane() {
    return this.glue.maxCdsLane;
  }
  get prepackedAnnotationRuntimePolicy() {
    return this.glue.prepackedAnnotationRuntimePolicy;
  }
  resolvePrepackedAnnotationSearchFocusTarget(
    focus: NonNullable<RenderState['annotationSearchFocus']>
  ): ReturnType<SearchFocusHost['resolvePrepackedAnnotationSearchFocusTarget']> {
    return this.glue.resolvePrepackedAnnotationSearchFocusTarget(focus);
  }
  compiledBroadSurfaceOwnerForTrack(trackId: string): CompiledBroadSurfaceTrackOwnerV2 | null {
    return this.glue.compiledBroadSurfaceOwnerForTrack(trackId);
  }
  compiledBroadSurfaceLaneStart(
    trackId: string,
    presentationTrackIds: readonly string[],
    policy: AnnotationPolicyGpuRuntimeV1
  ): number {
    return this.glue.compiledBroadSurfaceLaneStart(trackId, presentationTrackIds, policy);
  }
  annotationTrackRealizedLaneCapacity(
    trackId: string,
    policy: AnnotationPolicyGpuRuntimeV1,
    singleTrack: boolean
  ): number {
    return this.glue.annotationTrackRealizedLaneCapacity(trackId, policy, singleTrack);
  }
  prepackedAnnotationPolicyFeatureIsDurablyVisible(
    resident: { input: PrepackedAnnotationSceneLoadInput },
    featureIndex: number
  ): boolean {
    return this.glue.prepackedAnnotationPolicyFeatureIsDurablyVisible(resident, featureIndex);
  }
  prepackedAnnotationCenterScreenY(path: PathMapper, offsetPx: number): number | null {
    return this.glue.prepackedAnnotationCenterScreenY(path, offsetPx);
  }
  scaledBarHeight(): number {
    return this.glue.scaledBarHeight();
  }
  prepackedResidentTrackOffsetPx(
    resident: { input: PrepackedAnnotationSceneLoadInput },
    presentationTrackIds: readonly string[],
    policy: AnnotationPolicyGpuRuntimeV1
  ): number {
    return this.glue.prepackedResidentTrackOffsetPx(resident, presentationTrackIds, policy);
  }
  cdsDetailProgress(): number {
    return this.glue.cdsDetailProgress();
  }
  prepackedAnnotationPrimitiveScreenGeometry(
    path: PathMapper,
    state: RenderState,
    input: PrepackedAnnotationSceneLoadInput,
    primitiveIndex: number,
    trackOffsetPx: number,
    temporaryAdditionalLane: number | null
  ): { points: number[]; actualWidthPx: number } | null {
    return this.glue.prepackedAnnotationPrimitiveScreenGeometry(
      path,
      state,
      input,
      primitiveIndex,
      trackOffsetPx,
      temporaryAdditionalLane
    );
  }
  featureOffset(feature: Feature): number {
    return this.glue.featureOffset(feature);
  }
  transcriptGlyphOutlineCommands(feature: Feature, path: PathMapper): OutlineCommand[] {
    return this.glue.transcriptGlyphOutlineCommands(feature, path);
  }
  strokeOutlineCommands(
    graphics: Graphics,
    path: PathMapper,
    commands: OutlineCommand[],
    color: number,
    alpha: number
  ): void {
    this.glue.strokeOutlineCommands(graphics, path, commands, color, alpha);
  }
  standardFeatureDrawPoints(
    feature: Feature,
    endBp: number,
    pixelWidth: number,
    path: PathMapper,
    hitPts: number[]
  ): number[] {
    return this.glue.standardFeatureDrawPoints(feature, endBp, pixelWidth, path, hitPts);
  }

  renderAnnotationSearchFocus(path: PathMapper, state: RenderState): void {
    renderAnnotationSearchFocusFn(this, path, state);
  }
}

export type { UnifiedLayout, TrackContract };

declare module './indexed-annotation-overlay-collaborators' {
  interface OverlaySearchFocusCollaborator extends AnnotationSearchFocusController {}
}
