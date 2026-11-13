import { Graphics } from 'pixi.js';
import type { Feature, RenderState } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import type { OutlineCommand } from './annotation-feature-geometry';
import { isTranscript } from './annotation-feature-semantics';
import {
  invalidateCameraDependentInteractionOutline,
  setFeatureOutline,
  strokeOutlineCommand,
} from './indexed-annotation-draft-outlines';
import {
  ensureInteractionOutline as ensureInteractionOutlineFn,
  renderInteractionOutlines as renderInteractionOutlinesFn,
  type EnsureInteractionOutlineHost,
  type InteractionOutlineCompactResident,
  type InteractionOutlineHost,
  type InteractionOutlinePrepackedResident,
} from './indexed-annotation-interaction-outlines';
import {
  strokeCompiledBroadInteractionFeature as strokeCompiledBroadInteractionFeatureFn,
  type CompiledBroadStrokeHost,
} from './indexed-annotation-compiled-broad-stroke';
import type { AnnotationPolicyGpuRuntimeV1 } from '../overview/annotation-policy-gpu-instances-v1';
import { renderAnnotationChangeDecorations } from './indexed-annotation-change-decorations';

import type { OverlayPresenterCollaborators } from './indexed-annotation-overlay-collaborators';

export type AnnotationInteractionOutlineGlue = {
  prepackedAnnotationRuntimePolicy: AnnotationPolicyGpuRuntimeV1 | null;
  maxAnnotationLane: number;
  prepackedAnnotationLastHitOwnerKey: string | null;
  prepackedAnnotationSceneResidents: InteractionOutlineHost['prepackedAnnotationSceneResidents'];
  compiledBroadAnnotationInteractionResidents: InteractionOutlineHost['compiledBroadAnnotationInteractionResidents'];
  outlineCache: Map<number, OutlineCommand[]>;
  genomeLength: number;
  featureById: Map<number, Feature>;
  retainedOverviewMode: string;
  retainedLinearTranscriptFeatureSet: ReadonlySet<Feature> | null;
  renderAnnotationSearchFocus(path: PathMapper, state: RenderState): void;
  annotationLayerTypesForPresentation(): string[];
  compiledBroadSurfaceInteractionResidentForTrack(
    trackType: string
  ): InteractionOutlinePrepackedResident | null;
  compiledBroadSurfaceOwnerForTrack(
    trackType: string
  ): ReturnType<InteractionOutlineHost['compiledBroadSurfaceOwnerForTrack']>;
  compiledBroadAnnotationInteractionResidentForTrack(
    trackType: string
  ): InteractionOutlineCompactResident | null;
  compiledBroadSurfaceLaneStart(
    trackType: string,
    requestedLayerTypes: readonly string[],
    policy: AnnotationPolicyGpuRuntimeV1
  ): number;
  strokePrepackedInteractionFeature(
    graphics: Graphics,
    path: PathMapper,
    state: RenderState,
    resident: InteractionOutlinePrepackedResident,
    rendererId: number,
    forceSelected: boolean,
    laneOffsetPx: number
  ): number;
  prepackedResidentTrackOffsetPx(
    resident: InteractionOutlinePrepackedResident,
    requestedLayerTypes: readonly string[],
    policy: AnnotationPolicyGpuRuntimeV1
  ): number;
  prepackedRendererIdForCanonicalIdentity(
    canonicalIdentity: string
  ): { ownerKey: string; rendererId: number } | null;
  prepackedAnnotationCenterScreenY(path: PathMapper, offsetPx: number): number | null;
  featureOffset(feature: Feature): number;
  scaledBarHeight(): number;
  cdsDetailProgress(): number;
  standardFeatureDrawPoints(
    feature: Feature,
    endBp: number,
    pixelWidth: number,
    path: PathMapper,
    hitPts: number[]
  ): number[];
  transcriptGlyphOutlineCommands(feature: Feature, path: PathMapper): OutlineCommand[];
};

function idleAnnotationInteractionOutlineGlue(): AnnotationInteractionOutlineGlue {
  return {
    prepackedAnnotationRuntimePolicy: null,
    maxAnnotationLane: 0,
    prepackedAnnotationLastHitOwnerKey: null,
    prepackedAnnotationSceneResidents: new Map(),
    compiledBroadAnnotationInteractionResidents: new Map(),
    outlineCache: new Map(),
    genomeLength: 0,
    featureById: new Map(),
    retainedOverviewMode: 'inactive',
    retainedLinearTranscriptFeatureSet: null,
    renderAnnotationSearchFocus() {},
    annotationLayerTypesForPresentation: () => [],
    compiledBroadSurfaceInteractionResidentForTrack: () => null,
    compiledBroadSurfaceOwnerForTrack: () => null,
    compiledBroadAnnotationInteractionResidentForTrack: () => null,
    compiledBroadSurfaceLaneStart: () => 0,
    strokePrepackedInteractionFeature: () => 0,
    prepackedResidentTrackOffsetPx: () => 0,
    prepackedRendererIdForCanonicalIdentity: () => null,
    prepackedAnnotationCenterScreenY: () => null,
    featureOffset: () => 0,
    scaledBarHeight: () => 0,
    cdsDetailProgress: () => 0,
    standardFeatureDrawPoints: () => [],
    transcriptGlyphOutlineCommands: () => [],
  };
}

export class AnnotationInteractionOutlineController
  implements InteractionOutlineHost, EnsureInteractionOutlineHost, CompiledBroadStrokeHost
{
  lastInteractionOutlineCommandCount = 0;
  readonly interactionGraphics = new Graphics();
  readonly changeDecorationGraphics = new Graphics();
  lastChangeDecorationCommandCount = 0;
  lastChangeDecorationFeatureIds: number[] = [];

  private glue: AnnotationInteractionOutlineGlue = idleAnnotationInteractionOutlineGlue();

  constructor() {}
  attach(collaborators: OverlayPresenterCollaborators): void {
    this.glue = {
      get prepackedAnnotationRuntimePolicy() {
        return collaborators.prepacked.prepackedAnnotationRuntimePolicy;
      },
      get maxAnnotationLane() {
        return collaborators.layout.maxAnnotationLane;
      },
      get prepackedAnnotationLastHitOwnerKey() {
        return collaborators.hits.prepackedAnnotationLastHitOwnerKey;
      },
      get prepackedAnnotationSceneResidents() {
        return collaborators.prepacked
          .prepackedAnnotationSceneResidents as AnnotationInteractionOutlineGlue['prepackedAnnotationSceneResidents'];
      },
      get compiledBroadAnnotationInteractionResidents() {
        return collaborators.compiledBroad
          .compiledBroadAnnotationInteractionResidents as AnnotationInteractionOutlineGlue['compiledBroadAnnotationInteractionResidents'];
      },
      get outlineCache() {
        return collaborators.immediateDraw.outlineCache;
      },
      get genomeLength() {
        return collaborators.layout.genomeLength;
      },
      get featureById() {
        return collaborators.layout.featureById;
      },
      get retainedOverviewMode() {
        return collaborators.retained.retainedOverviewMode;
      },
      get retainedLinearTranscriptFeatureSet() {
        return collaborators.retained.retainedLinearTranscriptFeatureSet;
      },
      renderAnnotationSearchFocus: (path, state) =>
        collaborators.searchFocus.renderAnnotationSearchFocus(path, state),
      annotationLayerTypesForPresentation: () =>
        collaborators.layout.annotationLayerTypesForPresentation(),
      compiledBroadSurfaceInteractionResidentForTrack: (trackType) =>
        collaborators.compiledBroad.compiledBroadSurfaceInteractionResidentForTrack(
          trackType
        ) as ReturnType<
          AnnotationInteractionOutlineGlue['compiledBroadSurfaceInteractionResidentForTrack']
        >,
      compiledBroadSurfaceOwnerForTrack: (trackType) =>
        collaborators.compiledBroad.compiledBroadSurfaceOwnerForTrack(trackType) as ReturnType<
          AnnotationInteractionOutlineGlue['compiledBroadSurfaceOwnerForTrack']
        >,
      compiledBroadAnnotationInteractionResidentForTrack: (trackType) =>
        collaborators.compiledBroad.compiledBroadAnnotationInteractionResidentForTrack(
          trackType
        ) as ReturnType<
          AnnotationInteractionOutlineGlue['compiledBroadAnnotationInteractionResidentForTrack']
        >,
      compiledBroadSurfaceLaneStart: (trackType, requestedLayerTypes, policy) =>
        collaborators.compiledBroad.compiledBroadSurfaceLaneStart(
          trackType,
          requestedLayerTypes,
          policy
        ),
      strokePrepackedInteractionFeature: (
        graphics,
        path,
        state,
        resident,
        rendererId,
        forceSelected,
        laneOffsetPx
      ) =>
        collaborators.prepacked.strokePrepackedInteractionFeature(
          graphics,
          path,
          state,
          resident as never,
          rendererId,
          forceSelected,
          laneOffsetPx
        ),
      prepackedResidentTrackOffsetPx: (resident, requestedLayerTypes, policy) =>
        collaborators.prepacked.prepackedResidentTrackOffsetPx(
          resident as never,
          requestedLayerTypes,
          policy
        ),
      prepackedRendererIdForCanonicalIdentity: (canonicalIdentity) =>
        collaborators.prepacked.prepackedRendererIdForCanonicalIdentity(canonicalIdentity),
      prepackedAnnotationCenterScreenY: (path, offsetPx) =>
        collaborators.layout.prepackedAnnotationCenterScreenY(path, offsetPx),
      featureOffset: (feature) => collaborators.layout.featureOffset(feature),
      scaledBarHeight: () => collaborators.layout.scaledBarHeight(),
      cdsDetailProgress: () => collaborators.immediateDraw.cdsDetailProgress(),
      standardFeatureDrawPoints: (feature, endBp, pixelWidth, path, hitPts) =>
        collaborators.immediateDraw.standardFeatureDrawPoints(
          feature,
          endBp,
          pixelWidth,
          path,
          hitPts
        ),
      transcriptGlyphOutlineCommands: (feature, path) =>
        collaborators.immediateDraw.transcriptGlyphOutlineCommands(feature, path),
    } as AnnotationInteractionOutlineGlue;
  }

  get prepackedAnnotationRuntimePolicy() {
    return this.glue.prepackedAnnotationRuntimePolicy;
  }
  get maxAnnotationLane() {
    return this.glue.maxAnnotationLane;
  }
  get prepackedAnnotationLastHitOwnerKey() {
    return this.glue.prepackedAnnotationLastHitOwnerKey;
  }
  get prepackedAnnotationSceneResidents() {
    return this.glue.prepackedAnnotationSceneResidents;
  }
  get compiledBroadAnnotationInteractionResidents() {
    return this.glue.compiledBroadAnnotationInteractionResidents;
  }
  get outlineCache() {
    return this.glue.outlineCache;
  }
  get genomeLength() {
    return this.glue.genomeLength;
  }
  get featureById() {
    return this.glue.featureById;
  }
  get retainedOverviewMode() {
    return this.glue.retainedOverviewMode;
  }
  get retainedLinearTranscriptFeatureSet() {
    return this.glue.retainedLinearTranscriptFeatureSet;
  }

  renderAnnotationSearchFocus(path: PathMapper, state: RenderState): void {
    this.glue.renderAnnotationSearchFocus(path, state);
  }
  annotationLayerTypesForPresentation(): string[] {
    return this.glue.annotationLayerTypesForPresentation();
  }
  compiledBroadSurfaceInteractionResidentForTrack(
    trackType: string
  ): InteractionOutlinePrepackedResident | null {
    return this.glue.compiledBroadSurfaceInteractionResidentForTrack(trackType);
  }
  compiledBroadSurfaceOwnerForTrack(
    trackType: string
  ): ReturnType<InteractionOutlineHost['compiledBroadSurfaceOwnerForTrack']> {
    return this.glue.compiledBroadSurfaceOwnerForTrack(trackType);
  }
  compiledBroadAnnotationInteractionResidentForTrack(
    trackType: string
  ): InteractionOutlineCompactResident | null {
    return this.glue.compiledBroadAnnotationInteractionResidentForTrack(trackType);
  }
  compiledBroadSurfaceLaneStart(
    trackType: string,
    requestedLayerTypes: readonly string[],
    policy: AnnotationPolicyGpuRuntimeV1
  ): number {
    return this.glue.compiledBroadSurfaceLaneStart(trackType, requestedLayerTypes, policy);
  }
  strokePrepackedInteractionFeature(
    graphics: Graphics,
    path: PathMapper,
    state: RenderState,
    resident: InteractionOutlinePrepackedResident,
    rendererId: number,
    forceSelected: boolean,
    laneOffsetPx: number
  ): number {
    return this.glue.strokePrepackedInteractionFeature(
      graphics,
      path,
      state,
      resident,
      rendererId,
      forceSelected,
      laneOffsetPx
    );
  }
  prepackedResidentTrackOffsetPx(
    resident: InteractionOutlinePrepackedResident,
    requestedLayerTypes: readonly string[],
    policy: AnnotationPolicyGpuRuntimeV1
  ): number {
    return this.glue.prepackedResidentTrackOffsetPx(resident, requestedLayerTypes, policy);
  }
  prepackedRendererIdForCanonicalIdentity(
    canonicalIdentity: string
  ): { ownerKey: string; rendererId: number } | null {
    return this.glue.prepackedRendererIdForCanonicalIdentity(canonicalIdentity);
  }
  prepackedAnnotationCenterScreenY(path: PathMapper, offsetPx: number): number | null {
    return this.glue.prepackedAnnotationCenterScreenY(path, offsetPx);
  }
  featureOffset(feature: Feature): number {
    return this.glue.featureOffset(feature);
  }
  scaledBarHeight(): number {
    return this.glue.scaledBarHeight();
  }
  cdsDetailProgress(): number {
    return this.glue.cdsDetailProgress();
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
  transcriptGlyphOutlineCommands(feature: Feature, path: PathMapper): OutlineCommand[] {
    return this.glue.transcriptGlyphOutlineCommands(feature, path);
  }

  setFeatureOutline(featureId: number, commands: OutlineCommand[]): void {
    setFeatureOutline(this.outlineCache, featureId, commands);
  }

  strokeOutlineCommand(graphics: Graphics, command: OutlineCommand): void {
    strokeOutlineCommand(graphics, command);
  }

  strokeCompiledBroadInteractionFeature(
    graphics: Graphics,
    path: PathMapper,
    state: RenderState,
    resident: InteractionOutlineCompactResident,
    rendererId: number,
    forceSelected = false,
    trackOffsetPx = 0
  ): number {
    return strokeCompiledBroadInteractionFeatureFn(
      this,
      graphics,
      path,
      state,
      resident,
      rendererId,
      forceSelected,
      trackOffsetPx
    );
  }

  ensureInteractionOutline(path: PathMapper, featureId: number, state?: RenderState): void {
    ensureInteractionOutlineFn(this, path, featureId, state);
  }

  invalidateCameraDependentInteractionOutline(featureId: number): void {
    invalidateCameraDependentInteractionOutline(this, featureId, isTranscript);
  }

  clearChangeDecorations(): void {
    if (!this.lastChangeDecorationCommandCount) return;
    this.changeDecorationGraphics.clear();
    this.changeDecorationGraphics.visible = false;
    this.lastChangeDecorationCommandCount = 0;
    this.lastChangeDecorationFeatureIds = [];
  }

  render(
    path: PathMapper,
    state: RenderState,
    codonContours?: ReadonlyMap<number, readonly number[][]>
  ): void {
    const graphics = this.changeDecorationGraphics;
    if (
      !codonContours &&
      (state.annotationChangeDecorations?.size || this.lastChangeDecorationCommandCount)
    ) {
      graphics.clear();
      const result = renderAnnotationChangeDecorations(this, graphics, path, state);
      this.lastChangeDecorationCommandCount = result.commandCount;
      this.lastChangeDecorationFeatureIds = result.featureIds;
      graphics.visible = result.commandCount > 0;
    }
    renderInteractionOutlinesFn(this, path, state, codonContours);
  }

  renderInteractionOutlines(path: PathMapper, state: RenderState): void {
    this.render(path, state);
  }
}

declare module './indexed-annotation-overlay-collaborators' {
  interface OverlayOutlinesCollaborator extends AnnotationInteractionOutlineController {}
}
