import type { ImmediateDrawHost } from './indexed-annotation-draw-host';
import { buildAnnotationMutationPaint } from './annotation-mutation-paint';
import {
  renderAnnotationMutationSectors,
  retainedAnnotationSectorOutline,
} from './annotation-mutation-sectors';
import { Container, Graphics, Renderer, Text } from 'pixi.js';
import type {
  OverlayPosition,
  OverlayHitResult,
  RetainedOverlayCameraState,
  RetainedOverlayDebugSnapshot,
  RetainedOverlayFallbackReason,
  RetainedOverlayTrack,
} from './overlay-track';
import type { PathMapper } from '../shared/path-mapper';
import type { UnifiedLayout } from '../shared/track-layout';
import { CurvedLabelRenderer } from '../shared/curved-label';
import { ANNOTATION_LANE_TOTAL } from '../shared/lane-contracts';
import { pillLabelTextStyle, targetPillLabelTextResolution } from '../shared/label-pill';
import {
  createAnnotationBodyFrameAuthoritySnapshotV1,
  type AnnotationBodyFrameAuthoritySnapshotV1,
  type AnnotationBodyFrameOwnerKind,
  type AnnotationBodyPresenterEligibility,
  type AnnotationBodyReplacementReadiness,
} from './annotation-body-presentation-authority';
import {
  type AnnotationFlatPresentationSnapshot,
  type AnnotationPresentationSnapshotApplyResult,
  type AnnotationResidentPagePublication,
  type AnnotationResidentPagePublicationApplyResult,
  type Feature,
  type Genome,
  type RenderState,
} from '../../../types';
import {
  getColor as annotationFeatureGetColor,
  isOutlineOnlyFeature as annotationFeatureIsOutlineOnly,
  isSplicedFeature as annotationFeatureIsSpliced,
  isTranscript as annotationFeatureIsTranscript,
  normalizeAnnotationLayerTypes as annotationFeatureNormalizeLayerTypes,
} from './annotation-feature-semantics';
import {
  buildDirectionalPolygon as annotationBuildDirectionalPolygon,
  cdsLabelStripOutlineCommand as annotationCdsLabelStripOutlineCommand,
  lanePillOutlineCommand as annotationLanePillOutlineCommand,
  type OutlineCommand,
} from './annotation-feature-geometry';
import { visibleCenterFromPolygon as annotationVisibleCenterFromPolygon } from './annotation-label-geometry';
import { type OverlayPresenterCollaborators } from './indexed-annotation-overlay-collaborators';
import { AnnotationBodyFrameController } from './indexed-annotation-body-frame-controller';
import { AnnotationResidentPageController } from './indexed-annotation-resident-page-controller';
import { AnnotationSearchFocusController } from './indexed-annotation-search-focus-controller';
import { AnnotationHitTestController } from './indexed-annotation-hit-test-controller';
import { AnnotationImmediateDrawController } from './indexed-annotation-immediate-draw-controller';
import { AnnotationInteractionOutlineController } from './indexed-annotation-interaction-outline-controller';

import { type AnnotationResidentPageRecord } from '../../../annotation-resident-page-store';
import { laneRoundedPillPolygon, normalizeBp, screenWidthToBp } from '../shared/lane-path';

import { type RetainedOverviewAnnotationStyle } from './annotation-lod-policy';

import { rangesCoverInterval } from './annotation-range-coverage';
import type { RetainedOverviewAnnotationLayer } from '../overview/retained-overview-layer';
import type { RetainedLinearFeatureLayer } from '../overview/retained-linear-feature-layer';
import {
  type RetainedLinearTranscriptLayer,
  type DirectionalBlock,
  type ForcedLinearTranscriptPresentationTestState,
} from '../overview/retained-linear-transcript-layer';
import { retainedOverviewAnnotationsEnabled } from '../overview/retained-overview-style';
import {
  type GenomeWideTextureCacheLayer,
  type GenomeWideTextureCompositeArgs,
  type PrebuiltGenomeWideTextureMeta,
} from '../overview/genome-wide-texture-cache-layer';
import { type AnnotationSidecarRasterExternalSources } from '../overview/annotation-sidecar-raster-presenter';
import { IndexedSidecarRasterController } from './indexed-sidecar-raster-controller';
import { IndexedTilePyramidController } from './indexed-tile-pyramid-controller';

import { type CompiledBroadSurfaceRequirementV1 } from './indexed-compiled-broad-requirement';
import {
  type CompiledBroadSurfaceAdmissionProvenanceV1,
  type CompiledBroadSurfaceManifestV2,
} from '../overview/bounded-annotation-broad-surface';
import {
  type CompiledBroadSurfaceCellAdmissionResultV2,
  type CompiledBroadSurfacePixiPresenterV2,
} from '../overview/compiled-broad-surface-pixi-presenter';
import { PartitionedInstancedTranscriptLayer } from '../overview/partitioned-instanced-transcript-layer';
import { type CompiledBroadSurfaceDemandV2 } from './indexed-compiled-broad-demand';
import { type CompiledBroadSurfaceTrackOwnerV2 } from './indexed-compiled-broad-frame';
import {
  PrepackedAnnotationSceneController,
  type ResidentPrepackedAnnotationScene,
} from './indexed-prepacked-scene-controller';
import { CompiledBroadSurfaceController } from './indexed-compiled-broad-surface-controller';
import { RetainedLinearPresenter } from './indexed-retained-linear-presenter';
import {
  drawCDSLabelStrip as drawCDSLabelStripFn,
  type CdsLabelStripDrawHost,
} from './indexed-annotation-draw-cds';
import {
  drawRetainedTranscriptIntronConnectors as drawRetainedTranscriptIntronConnectorsFn,
  drawTranscriptGlyph as drawTranscriptGlyphFn,
  transcriptGlyphOutlineCommands as transcriptGlyphOutlineCommandsFn,
  type TranscriptGlyphDrawHost,
} from './indexed-annotation-draw-transcript';
import { flatAnnotationSearchFocusBlockGeometry as flatAnnotationSearchFocusBlockGeometryFn } from './indexed-annotation-search-focus-geometry';
import {
  prepackedAnnotationPrimitiveScreenGeometry as prepackedAnnotationPrimitiveScreenGeometryFn,
  strokePrepackedInteractionFeature as strokePrepackedInteractionFeatureFn,
  type PrepackedInteractionGeometryHost,
} from './indexed-prepacked-interaction-geometry';
import {
  drawFeatureLevelTransitionShape as drawFeatureLevelTransitionShapeFn,
  drawStandard as drawStandardFn,
  type StandardFeatureDrawHost,
} from './indexed-annotation-draw-standard';
import { renderImmediateFeature as renderImmediateFeatureFn } from './indexed-annotation-draw-immediate';

import { type ResidentPageFeatureResident } from './indexed-annotation-resident-pages';
import {
  getColdGestureSnapshot as getColdGestureSnapshotFn,
  getDebugSnapshot as getDebugSnapshotFn,
  type AnnotationSnapshotSources,
} from './indexed-annotation-snapshots';
import {
  applyAnnotationGenome as applyAnnotationGenomeFn,
  loadAnnotationGenome as loadAnnotationGenomeFn,
} from './indexed-annotation-genome-ingress';
import { AnnotationLayoutState } from './indexed-annotation-layout-state';
import { setAnnotationFlatPresentationSnapshot as setAnnotationFlatPresentationSnapshotFn } from './indexed-annotation-flat-snapshot';

import { type CompiledBroadSurfaceResidentLeaseReconcileResultV1 } from './indexed-compiled-broad-owner-lifecycle';
import {
  auditAnnotationDraw as auditAnnotationDrawFn,
  beginDrawAudit as beginDrawAuditFn,
  beginDrawAuditIfDiagnosticsEnabled as beginDrawAuditIfDiagnosticsEnabledFn,
  buildPresentationDebugSnapshot as buildPresentationDebugSnapshotFn,
  recordDrawAuditDecision as recordDrawAuditDecisionFn,
  renderSetLayerTypesForAudit as renderSetLayerTypesForAuditFn,
} from './indexed-annotation-presentation-audit';
import { drawLaneBandWithGaps as drawLaneBandWithGapsFn } from './indexed-annotation-draw-lane-band';
import { commitPrebuiltGenomeWideTexturePolicy as commitPrebuiltGenomeWideTexturePolicyFn } from './indexed-prepacked-prebuilt-texture-policy';

import {
  addFeatureOutline as addFeatureOutlineFn,
  setFeatureOutline as setFeatureOutlineFn,
  strokeCurrentPath as strokeCurrentPathFn,
  strokeDraftOutlineCommands as strokeDraftOutlineCommandsFn,
  strokeLanePill as strokeLanePillFn,
  strokeOutlineCommand as strokeOutlineCommandFn,
  strokeOutlineCommands as strokeOutlineCommandsFn,
} from './indexed-annotation-draft-outlines';

import {
  drawCdsDirectionGlyphInPill as drawCdsDirectionGlyphInPillFn,
  drawLabelTextInPill as drawLabelTextInPillFn,
  drawLanePillShell as drawLanePillShellFn,
  drawPillSeparator as drawPillSeparatorFn,
  pushPillHit as pushPillHitFn,
  renderCurvedLabel as renderCurvedLabelFn,
} from './indexed-annotation-draw-pills';
import {
  applyPrepackedAnnotationLaneEnvelope as applyPrepackedAnnotationLaneEnvelopeFn,
  commitAnnotationLaneEnvelope as commitAnnotationLaneEnvelopeFn,
  reconcileAnnotationLaneEnvelopeAuthority as reconcileAnnotationLaneEnvelopeAuthorityFn,
} from './indexed-annotation-lane-envelope';
import {
  prepackedPolicyTrackLaneForPrimitive as prepackedPolicyTrackLaneForPrimitiveFn,
  prepackedRendererIdForCanonicalIdentity as prepackedRendererIdForCanonicalIdentityFn,
  prepackedResidentTrackOffsetPx as prepackedResidentTrackOffsetPxFn,
} from './indexed-prepacked-policy-lane';
import {
  featuresInRange as featuresInRangeFn,
  hasFeaturesInRange as hasFeaturesInRangeFn,
} from './indexed-annotation-features-in-range';

import {
  commitAnnotationPresentationPolicy as commitAnnotationPresentationPolicyFn,
  getAnnotationSearchFocusPresentationSnapshot as getAnnotationSearchFocusPresentationSnapshotFn,
  getCompiledBroadAnnotationInteractionAuthoritySnapshot as getCompiledBroadAnnotationInteractionAuthoritySnapshotFn,
  getPrepackedAnnotationSceneOwnerSnapshot as getPrepackedAnnotationSceneOwnerSnapshotFn,
  overviewCacheContext as overviewCacheContextFn,
  releaseRetiredGpuResourcesAfterPresent as releaseRetiredGpuResourcesAfterPresentFn,
} from './indexed-annotation-lifecycle';
import {
  cdsDetailProgress as cdsDetailProgressFn,
  cdsExonLabelAlpha as cdsExonLabelAlphaFn,
  cdsTransitionHalfHeight as cdsTransitionHalfHeightFn,
  directionalArrowWidth as directionalArrowWidthFn,
  featureEnvelope as featureEnvelopeFn,
  featureOffset as featureOffsetFn,
  featurePixelWidth as featurePixelWidthFn,
  getFeatureRenderOffset as getFeatureRenderOffsetFn,
  isRetainedTranscriptLaneVisible as isRetainedTranscriptLaneVisibleFn,
  overviewLabelAlpha as overviewLabelAlphaFn,
  overviewLaneScale as overviewLaneScaleFn,
  prepackedAnnotationCenterScreenY as prepackedAnnotationCenterScreenYFn,
  prepackedAnnotationTrackBaseOffsetPx as prepackedAnnotationTrackBaseOffsetPxFn,
  renderKeyChangeReasons as renderKeyChangeReasonsFn,
  renderKeyFromParts as renderKeyFromPartsFn,
  renderKeyParts as renderKeyPartsFn,
  retainedLinearTranscriptFeatureKey as retainedLinearTranscriptFeatureKeyFn,
  retainedLinearTranscriptLayoutKey as retainedLinearTranscriptLayoutKeyFn,
  scaledArrowMax as scaledArrowMaxFn,
  scaledBarHeight as scaledBarHeightFn,
  scaledCdsLineHeight as scaledCdsLineHeightFn,
  setOverlayLayout as setOverlayLayoutFn,
  type AnnotationRenderKeyParts,
} from './indexed-annotation-layout';

import {
  ANNOTATION_OVERLAY_POLICY_READINESS_SNAPSHOT_V1,
  type AnnotationOverlayColdGestureSnapshot,
  type AnnotationOverlayDebugSnapshot,
  type AnnotationOverlayPolicyReadinessSnapshotV1,
  type AnnotationPresentationPolicyCommitDispositionV1,
  type AnnotationSearchFocusPresentationSnapshot,
  type CompiledBroadAnnotationInteractionAuthoritySnapshotV1,
  type CompiledBroadSurfaceRuntimeDiagnosticsV2,
  type CompiledBroadSurfaceRuntimeReadinessDiagnosticsV2,
  type CompiledBroadSurfaceSourcePlacementAuthorityV1,
  type CompiledBroadAnnotationInteractionLoadInputV1,
} from './annotation-overlay-types';
export {
  ANNOTATION_OVERLAY_COLD_GESTURE_SNAPSHOT_V1,
  ANNOTATION_OVERLAY_POLICY_READINESS_SNAPSHOT_V1,
  COMPILED_BROAD_ANNOTATION_INTERACTION_AUTHORITY_SNAPSHOT_V1,
  type AnnotationColdGestureOwnerId,
  type AnnotationOverlayColdGestureSnapshot,
  type AnnotationOverlayDebugSnapshot,
  type AnnotationOverlayPolicyReadinessSnapshotV1,
  type AnnotationPresentationPolicyCommitDispositionV1,
  type AnnotationSearchFocusPresentationSnapshot,
  type CompiledBroadAnnotationInteractionAuthoritySnapshotV1,
  type CompiledBroadSurfaceCellDemandAddressV2,
  type CompiledBroadSurfacePlanStatusV2,
  type CompiledBroadSurfaceRuntimeDiagnosticsV2,
  type CompiledBroadSurfaceRuntimeReadinessDiagnosticsV2,
  type CompiledBroadSurfaceSourcePlacementAuthorityV1,
  type CompiledBroadAnnotationInteractionLoadInputV1,
} from './annotation-overlay-types';
import {
  type CompiledBroadSurfaceRgbaCellAdmissionInputV2,
  type CompiledBroadSurfaceRgbaCellAdmissionResultV2,
  type CompiledBroadSurfaceTextureCellAdmissionInputV2,
  type CompiledBroadSurfaceTransparentCellAdmissionInputV2,
} from './indexed-compiled-broad-admit';
import {
  renderAnnotationSearchFocus as renderAnnotationSearchFocusFn,
  renderAnnotationSearchFocusMask as renderAnnotationSearchFocusMaskFn,
  renderFlatAnnotationSearchFocus as renderFlatAnnotationSearchFocusFn,
  resolvePrepackedAnnotationSearchFocusTarget as resolvePrepackedAnnotationSearchFocusTargetFn,
  type SearchFocusHost,
  type SearchFocusTargetResident,
} from './indexed-annotation-search-focus';
import { type AnnotationHitTestHost } from './indexed-annotation-hit-test';
import {
  renderAnnotationOverlayFrame,
  renderRetainedTranscriptDecorations as renderRetainedTranscriptDecorationsFn,
  replayAnnotationLabelOccupancy,
  reserveAnnotationPillBounds,
} from './indexed-annotation-retained-draw';
import {
  admitPrepackedAnnotationViewportDetailRoster as admitPrepackedAnnotationViewportDetailRosterFn,
  buildAndLoadPrepackedAnnotationScene as buildAndLoadPrepackedAnnotationSceneFn,
  preparePrepackedAnnotationFineViews as preparePrepackedAnnotationFineViewsFn,
  type PrepackedAnnotationFinePreparationResult,
} from './indexed-prepacked-scene-lifecycle';

import {
  type PrepackedAnnotationSceneLoadInput,
  type PrepackedAnnotationSceneOwnerSnapshot,
  type PrepackedAnnotationSceneBuildOptions,
  type PrepackedAnnotationSceneStatus,
} from '../overview/prepacked-annotation-scene';
import {
  type AnnotationPolicyGpuTrackLaneMaximaV1,
  type AnnotationPolicyGpuRuntimeV1,
} from '../overview/annotation-policy-gpu-instances-v1';
import { decodeAnnotationPolicyProjectionFeatureV1 } from '../overview/annotation-policy-projection-v1';

import { type FeaturePrimitiveSink } from '../overview/feature-primitive-sink';
import {
  type AnnotationOverviewCacheContext,
  type OverviewAggregationCache,
  type OverviewBin,
} from './annotation-overview-cache';
import { type AnnotationPresentationDebugSnapshot } from './annotation-presentation-debug';
import { type AnnotationPrebuiltRasterEligibility } from './annotation-lod-ownership';

import {
  type AnnotationDrawAuditDecision,
  type AnnotationDrawAuditSnapshot,
} from './annotation-draw-audit';
import { shouldRenderFeatureTextAtLod } from './feature-text-lod';

interface ResidentCompiledBroadAnnotationInteractionV1 extends CompiledBroadAnnotationInteractionLoadInputV1 {
  lastUsed: number;
}

const getColor = annotationFeatureGetColor;
const isOutlineOnlyFeature = annotationFeatureIsOutlineOnly;
const isSplicedFeature = annotationFeatureIsSpliced;
const isTranscript = annotationFeatureIsTranscript;
const normalizeAnnotationLayerTypes = annotationFeatureNormalizeLayerTypes;
const buildDirectionalPolygon = annotationBuildDirectionalPolygon;
const visibleCenterFromPolygon = annotationVisibleCenterFromPolygon;

export type { PrepackedAnnotationFinePreparationResult };
export { COMPILED_BROAD_SURFACE_DEMAND_LEASE_V1 } from './indexed-compiled-broad-lease';
export {
  COMPILED_BROAD_SURFACE_DEMAND_V2,
  type CompiledBroadSurfaceDemandStatusV2,
  type CompiledBroadSurfaceDemandV2,
} from './indexed-compiled-broad-demand';
export {
  COMPILED_BROAD_SURFACE_REQUIREMENT_V1,
  type CompiledBroadSurfaceRequirementV1,
} from './indexed-compiled-broad-requirement';
export type {
  CompiledBroadSurfaceRgbaCellAdmissionInputV2,
  CompiledBroadSurfaceRgbaCellAdmissionResultV2,
  CompiledBroadSurfaceTextureCellAdmissionInputV2,
  CompiledBroadSurfaceTransparentCellAdmissionInputV2,
} from './indexed-compiled-broad-admit';
export type { CompiledBroadSurfaceResidentLeaseReconcileResultV1 } from './indexed-compiled-broad-owner-lifecycle';

export class IndexedAnnotationOverlay implements RetainedOverlayTrack {
  readonly id = 'annotations';
  readonly displayName = 'Annotations';
  readonly position: OverlayPosition = 'above';
  sortOrder = 100;
  hitTestOrder = 30;
  enabled = true;

  readonly layoutCacheKey = (): number => 0;

  readonly container = new Container();

  private readonly retainedLinear = new RetainedLinearPresenter();
  getRetainedLinearPresenterForTest(): RetainedLinearPresenter {
    return this.retainedLinear;
  }

  private readonly compiledBroad = new CompiledBroadSurfaceController();
  getCompiledBroadControllerForTest(): CompiledBroadSurfaceController {
    return this.compiledBroad;
  }

  private readonly immediateDraw = new AnnotationImmediateDrawController();
  private annotationColors: ReadonlyMap<number, number> | undefined;
  private readonly mutationSectorGraphics = new Graphics();
  private mutationPaint = buildAnnotationMutationPaint([], undefined, 0);
  private mutationPresentation: RenderState['sequencePresentation'];
  private mutationFeatures: readonly Feature[] | undefined;
  private mutationPresentationVisible = true;
  private mutationSectorReceipt: ReturnType<typeof renderAnnotationMutationSectors> = {
    sectorCount: 0,
    samples: [],
  };
  getImmediateDrawControllerForTest(): AnnotationImmediateDrawController {
    return this.immediateDraw;
  }
  private prepackedInteractionGeometryHostCache: PrepackedInteractionGeometryHost | null = null;
  private readonly searchFocus = new AnnotationSearchFocusController();
  getSearchFocusControllerForTest(): AnnotationSearchFocusController {
    return this.searchFocus;
  }
  private readonly hits = new AnnotationHitTestController();
  getHitTestControllerForTest(): AnnotationHitTestController {
    return this.hits;
  }

  get prepackedAnnotationLastHitOwnerKey(): string | null {
    return this.hits.prepackedAnnotationLastHitOwnerKey;
  }
  private readonly outlines = new AnnotationInteractionOutlineController();
  getInteractionOutlineControllerForTest(): AnnotationInteractionOutlineController {
    return this.outlines;
  }

  private readonly tilePyramid = new IndexedTilePyramidController();
  private readonly sidecarRaster = new IndexedSidecarRasterController();
  private readonly prepacked = new PrepackedAnnotationSceneController();
  getPrepackedControllerForTest(): PrepackedAnnotationSceneController {
    return this.prepacked;
  }

  get prepackedAnnotationSceneResidents() {
    return this.prepacked.prepackedAnnotationSceneResidents;
  }
  private readonly layoutState = new AnnotationLayoutState();
  getLayoutStateForTest(): AnnotationLayoutState {
    return this.layoutState;
  }
  private readonly bodyFrame = new AnnotationBodyFrameController();
  getBodyFrameControllerForTest(): AnnotationBodyFrameController {
    return this.bodyFrame;
  }
  private readonly residentPages = new AnnotationResidentPageController();
  getResidentPageControllerForTest(): AnnotationResidentPageController {
    return this.residentPages;
  }
  get maxAnnotationLane() {
    return this.layoutState.maxAnnotationLane;
  }
  set maxAnnotationLane(value) {
    this.layoutState.maxAnnotationLane = value;
  }
  get maxCdsLane() {
    return this.layoutState.maxCdsLane;
  }
  set maxCdsLane(value) {
    this.layoutState.maxCdsLane = value;
  }

  setLayout(
    layout: UnifiedLayout,
    effectiveEnvelope: {
      maxAnnotationLane: number;
      maxCdsLane: number;
    } = {
      maxAnnotationLane: this.maxAnnotationLane,
      maxCdsLane: this.maxCdsLane,
    }
  ): void {
    setOverlayLayoutFn(this.layoutState, layout, effectiveEnvelope);
  }

  private scaledBarHeight(): number {
    return scaledBarHeightFn();
  }

  private prepackedAnnotationTrackBaseOffsetPx(): number | null {
    return prepackedAnnotationTrackBaseOffsetPxFn(this.layoutState);
  }

  private prepackedAnnotationCenterScreenY(
    path: PathMapper,
    localOffsetCenter: number
  ): number | null {
    return prepackedAnnotationCenterScreenYFn(this.layoutState, path, localOffsetCenter);
  }

  private scaledCdsLineHeight(): number {
    return scaledCdsLineHeightFn();
  }

  private scaledArrowMax(): number {
    return scaledArrowMaxFn();
  }

  private directionalArrowWidth(pixelWidth: number, barHeight: number): number {
    return directionalArrowWidthFn(pixelWidth, barHeight);
  }

  private cdsTransitionHalfHeight(detailProgress: number): number {
    return cdsTransitionHalfHeightFn(detailProgress);
  }

  getFeatureRenderOffset(feature: Feature): number | null {
    return getFeatureRenderOffsetFn(this.layoutState, feature);
  }

  private featureOffset(feature: Feature): number {
    return featureOffsetFn(this.layoutState, feature);
  }

  private featureEnvelope(feature: Feature) {
    return featureEnvelopeFn(this.layoutState, feature);
  }

  private featurePixelWidth(feature: Feature, path: PathMapper): number {
    return featurePixelWidthFn(this.layoutState, feature, path);
  }

  private retainedLinearTranscriptLayoutKey(state: RenderState): string {
    return retainedLinearTranscriptLayoutKeyFn(this.layoutState, state);
  }

  private retainedLinearTranscriptFeatureKey(featuresToRender: readonly Feature[]): string {
    return retainedLinearTranscriptFeatureKeyFn(this.layoutState, featuresToRender);
  }

  private hashRetainedLinearTranscriptFeatureKey(featuresToRender: readonly Feature[]): string {
    return this.retainedLinear.hashRetainedLinearTranscriptFeatureKey(featuresToRender);
  }

  private retainedLinearSourceFeaturesForViewport(path: PathMapper): Feature[] {
    return this.retainedLinear.retainedLinearSourceFeaturesForViewport(path);
  }

  private isRetainedTranscriptLaneVisible(
    feature: Feature,
    path: PathMapper,
    state: RenderState
  ): boolean {
    return isRetainedTranscriptLaneVisibleFn(this.layoutState, feature, path, state);
  }

  private beginDrawAudit(
    path: PathMapper,
    state: RenderState,
    featuresToRender: readonly Feature[],
    useOverviewAggregation: boolean,
    overviewCache: {
      binBp: number;
      bins: OverviewBin[];
      passthroughFeatures: Feature[];
      diagnostics: {
        inputFeatureCount: number;
        skippedMinVisibleFeatureCount: number;
        aggregateWideFeatureCount: number;
        aggregatedFeatureCount: number;
        binContributionCount: number;
      };
    } | null
  ): AnnotationDrawAuditSnapshot {
    return beginDrawAuditFn(
      this.retainedLinear,
      path,
      state,
      featuresToRender,
      useOverviewAggregation,
      overviewCache
    );
  }

  private beginDrawAuditIfDiagnosticsEnabled(
    path: PathMapper,
    state: RenderState,
    featuresToRender: readonly Feature[],
    useOverviewAggregation: boolean,
    overviewCache: Parameters<IndexedAnnotationOverlay['beginDrawAudit']>[4]
  ): AnnotationDrawAuditSnapshot | null {
    return beginDrawAuditIfDiagnosticsEnabledFn(
      this.retainedLinear,
      path,
      state,
      featuresToRender,
      useOverviewAggregation,
      overviewCache
    );
  }

  private renderSetLayerTypesForAudit(featuresToRender: readonly Feature[]): string[] {
    return renderSetLayerTypesForAuditFn(
      { annotationLayerTypesForPresentation: () => this.annotationLayerTypesForPresentation() },
      featuresToRender,
      normalizeAnnotationLayerTypes
    );
  }

  private recordDrawAuditDecision(
    audit: AnnotationDrawAuditSnapshot,
    feature: Feature,
    decision: AnnotationDrawAuditDecision,
    path: PathMapper
  ): void {
    recordDrawAuditDecisionFn(this.layoutState, audit, feature, decision, path);
  }

  private cdsDetailProgress(): number {
    return cdsDetailProgressFn(this.layoutState);
  }

  private cdsExonLabelAlpha(): number {
    return cdsExonLabelAlphaFn(this.layoutState);
  }

  private overviewLaneScale(): number {
    return overviewLaneScaleFn(this.layoutState);
  }

  private overviewLabelAlpha(): number {
    return overviewLabelAlphaFn(this.layoutState);
  }

  private renderKeyParts(state: RenderState): AnnotationRenderKeyParts {
    return renderKeyPartsFn(this.layoutState, state);
  }

  private renderKeyFromParts(parts: AnnotationRenderKeyParts): string {
    return renderKeyFromPartsFn(parts);
  }

  private renderKeyChangeReasons(next: AnnotationRenderKeyParts): string[] {
    return renderKeyChangeReasonsFn(this.layoutState, next);
  }

  private resetRenderStats(): void {
    this.retainedLinear.resetRenderStats();
  }

  private resetImmediateDrawStats(): void {
    this.retainedLinear.resetImmediateDrawStats();
  }

  constructor() {
    this.container.eventMode = 'none';
    this.container.addChild(this.retainedLinear.graphics);

    this.container.addChild(this.retainedLinear.retainedTranscriptDecorationGraphics);
    this.container.addChild(this.mutationSectorGraphics);
    this.retainedLinear.curvedLabels = new CurvedLabelRenderer(this.container);

    this.container.addChild(this.searchFocus.annotationSearchFocusGraphics);
    this.container.addChild(this.outlines.changeDecorationGraphics);
    this.container.addChild(this.outlines.interactionGraphics);
    this.bodyFrame.attach({
      layout: this.layoutState,
      prepacked: this.prepacked,
      compiledBroad: this.compiledBroad,
      retainedLinear: this.retainedLinear,
      tilePyramid: this.tilePyramid,
      annotationLayerTypesForPresentation: () => this.annotationLayerTypesForPresentation(),
      tilePyramidHost: () => this.retainedLinear,
    });
    this.attachPresenterCollaborators();
    this.residentPages.attach({
      layout: this.layoutState,
      prepacked: this.prepacked,
      compiledBroad: this.compiledBroad,
      annotationLayerTypesForPresentation: () => this.annotationLayerTypesForPresentation(),
    });
  }

  private attachPresenterCollaborators(): void {
    const collaborators: OverlayPresenterCollaborators = {
      container: this.container,
      layout: this.layoutState,
      retained: this.retainedLinear,
      compiledBroad: this.compiledBroad,
      prepacked: this.prepacked,
      searchFocus: this.searchFocus,
      hits: this.hits,
      outlines: this.outlines,
      immediateDraw: this.immediateDraw,
      bodyFrame: this.bodyFrame,
      residentPages: this.residentPages,
      tilePyramid: this.tilePyramid,
      sidecarRaster: this.sidecarRaster,
    };
    this.retainedLinear.attach(collaborators);
    this.compiledBroad.attach(collaborators);
    this.prepacked.attach(collaborators);
    this.layoutState.attach(collaborators);
    this.searchFocus.attach(collaborators);
    this.hits.attach(collaborators);
    this.outlines.attach(collaborators);
    this.immediateDraw.attach(collaborators);
  }

  requireCompiledBroadSurface(input: CompiledBroadSurfaceRequirementV1): boolean {
    return this.compiledBroad.requireCompiledBroadSurface(input);
  }

  admitCompiledBroadSurfaceSourcePlacementAuthority(
    authority: CompiledBroadSurfaceSourcePlacementAuthorityV1
  ): boolean {
    return this.compiledBroad.admitCompiledBroadSurfaceSourcePlacementAuthority(authority);
  }

  loadCompiledBroadAnnotationInteraction(
    input: CompiledBroadAnnotationInteractionLoadInputV1
  ): CompiledBroadAnnotationInteractionLoadInputV1 | null {
    return this.compiledBroad.loadCompiledBroadAnnotationInteraction(
      input
    ) as CompiledBroadAnnotationInteractionLoadInputV1 | null;
  }

  private compiledBroadSurfaceProvenanceFailure(
    manifest: CompiledBroadSurfaceManifestV2,
    provenance: CompiledBroadSurfaceAdmissionProvenanceV1 | null | undefined
  ): string | null {
    return this.compiledBroad.compiledBroadSurfaceProvenanceFailure(manifest, provenance);
  }

  private compiledBroadSurfaceInteractionAuthorityIsCurrent(): boolean {
    const manifest = this.compiledBroad.compiledBroadSurfaceManifest;
    return Boolean(
      manifest && this.compiledBroadSurfaceInteractionResidentForTrack(manifest.trackId)
    );
  }

  private compiledBroadSurfaceInteractionResidentForTrack(
    trackId: string
  ): ResidentPrepackedAnnotationScene | null {
    return this.compiledBroad.compiledBroadSurfaceInteractionResidentForTrack(
      trackId
    ) as ResidentPrepackedAnnotationScene | null;
  }

  private compiledBroadAnnotationInteractionResidentForTrack(
    trackId: string
  ): ResidentCompiledBroadAnnotationInteractionV1 | null {
    return this.compiledBroad.compiledBroadAnnotationInteractionResidentForTrack(
      trackId
    ) as ResidentCompiledBroadAnnotationInteractionV1 | null;
  }

  private prepackedAnnotationSceneResidentForTrack(
    trackId: string
  ): ResidentPrepackedAnnotationScene | null {
    return this.compiledBroad.prepackedAnnotationSceneResidentForTrack(
      trackId
    ) as ResidentPrepackedAnnotationScene | null;
  }

  private requestedPrepackedAnnotationSceneResidentForTrack(
    trackId: string
  ): ResidentPrepackedAnnotationScene | null {
    return this.compiledBroad.requestedPrepackedAnnotationSceneResidentForTrack(
      trackId
    ) as ResidentPrepackedAnnotationScene | null;
  }

  private compiledBroadSurfaceProvenanceIsCurrent(
    manifest: CompiledBroadSurfaceManifestV2 | null,
    provenance: CompiledBroadSurfaceAdmissionProvenanceV1 | null
  ): boolean {
    return this.compiledBroad.compiledBroadSurfaceProvenanceIsCurrent(manifest, provenance);
  }

  private compiledBroadSurfaceAdmissionIdentityMatches(
    owner: CompiledBroadSurfaceTrackOwnerV2,
    manifest: CompiledBroadSurfaceManifestV2,
    provenance: CompiledBroadSurfaceAdmissionProvenanceV1
  ): boolean {
    return this.compiledBroad.compiledBroadSurfaceAdmissionIdentityMatches(
      owner,
      manifest,
      provenance
    );
  }

  private compiledBroadSurfaceOwnerRosterForTheme(
    requestedLayerTypes: readonly string[],
    requestedThemeMode: 'light' | 'dark'
  ): Array<{
    trackId: string;
    currentOwner: CompiledBroadSurfaceTrackOwnerV2 | null;
    candidateOwner: CompiledBroadSurfaceTrackOwnerV2 | null;
    owner: CompiledBroadSurfaceTrackOwnerV2 | null;
  }> {
    return this.compiledBroad.compiledBroadSurfaceOwnerRosterForTheme(
      requestedLayerTypes,
      requestedThemeMode
    );
  }

  private searchFocusHost(): SearchFocusHost {
    return this.searchFocus;
  }

  loadCompiledBroadSurfaceManifest(
    manifest: CompiledBroadSurfaceManifestV2,
    provenance: CompiledBroadSurfaceAdmissionProvenanceV1
  ): boolean {
    return this.compiledBroad.loadCompiledBroadSurfaceManifest(manifest, provenance);
  }

  admitCompiledBroadSurfaceCellTexture(
    input: CompiledBroadSurfaceTextureCellAdmissionInputV2
  ): CompiledBroadSurfaceCellAdmissionResultV2 {
    return this.compiledBroad.admitCompiledBroadSurfaceCellTexture(input);
  }

  admitCompiledBroadSurfaceTransparentCell(
    input: CompiledBroadSurfaceTransparentCellAdmissionInputV2
  ): CompiledBroadSurfaceRgbaCellAdmissionResultV2 {
    return this.compiledBroad.admitCompiledBroadSurfaceTransparentCell(input);
  }

  admitCompiledBroadSurfaceRgbaCell(
    input: CompiledBroadSurfaceRgbaCellAdmissionInputV2
  ): CompiledBroadSurfaceRgbaCellAdmissionResultV2 {
    return this.compiledBroad.admitCompiledBroadSurfaceRgbaCell(input);
  }

  getCompiledBroadSurfaceDemand(
    policy?: AnnotationPolicyGpuRuntimeV1,
    manifestFingerprint?: string
  ): CompiledBroadSurfaceDemandV2 {
    return this.compiledBroad.getCompiledBroadSurfaceDemand(policy, manifestFingerprint);
  }

  isCompiledBroadSurfaceDemandRefreshRequired(
    policy: AnnotationPolicyGpuRuntimeV1,
    manifestFingerprint: string
  ): boolean {
    return this.compiledBroad.isCompiledBroadSurfaceDemandRefreshRequired(
      policy,
      manifestFingerprint
    );
  }

  reconcileCompiledBroadSurfaceResidentLeases(
    demandLeaseIds: readonly string[]
  ): CompiledBroadSurfaceResidentLeaseReconcileResultV1 {
    return this.compiledBroad.reconcileCompiledBroadSurfaceResidentLeases(demandLeaseIds);
  }

  getCompiledBroadSurfaceDiagnostics(): CompiledBroadSurfaceRuntimeDiagnosticsV2 | null {
    return this.compiledBroad.getCompiledBroadSurfaceDiagnostics() as CompiledBroadSurfaceRuntimeDiagnosticsV2 | null;
  }

  getCompiledBroadSurfaceReadinessDiagnostics(): CompiledBroadSurfaceRuntimeReadinessDiagnosticsV2 | null {
    return this.compiledBroad.getCompiledBroadSurfaceReadinessDiagnostics() as CompiledBroadSurfaceRuntimeReadinessDiagnosticsV2 | null;
  }

  getAnnotationPolicyReadinessSnapshot(): AnnotationOverlayPolicyReadinessSnapshotV1 {
    const presentation = this.buildPresentationDebugSnapshot();
    return Object.freeze({
      contract: ANNOTATION_OVERLAY_POLICY_READINESS_SNAPSHOT_V1,
      annotationPresentationOwnerViolations: presentation.annotationPresentationOwnerViolations,
      annotationPresentationLayerTypes: presentation.annotationPresentationLayerTypes,
      annotationPresentationOwners: presentation.annotationPresentationOwners,
      prebuiltGenomeWideTextureLoaded:
        this.retainedLinear.genomeWideTextureCacheLayer?.hasPrebuilt() ?? false,
      prebuiltGenomeWideTextureContractMatch:
        this.retainedLinear.prebuiltRasterContractForLastFrame.contractMatch,
      prebuiltGenomeWideTextureSourceMatch:
        this.retainedLinear.prebuiltRasterContractForLastFrame.sourceMatch,
      prebuiltGenomeWideTexturePlacementMatch:
        this.retainedLinear.prebuiltRasterContractForLastFrame.placementMatch,
      prebuiltGenomeWideTexturePlacementFingerprint:
        this.retainedLinear.prebuiltRasterContractForLastFrame.artifactPlacementFingerprint,
      prebuiltGenomeWideTextureLayerTypes:
        this.retainedLinear.prebuiltRasterContractForLastFrame.artifactLayerTypes,
      prebuiltGenomeWideTextureVisible: presentation.prebuiltGenomeWideTextureVisible,
      prebuiltGenomeWideTextureEligible: presentation.prebuiltGenomeWideTextureEligible,
      compiledBroad: this.getCompiledBroadSurfaceReadinessDiagnostics(),
    });
  }

  clearCompiledBroadSurfaceManifest(manifestFingerprint?: string): void {
    this.compiledBroad.clearCompiledBroadSurfaceManifest(manifestFingerprint);
  }

  clearCompiledBroadSurfaceRequirement(): void {
    this.layoutState.clearCompiledBroadSurfaceRequirement();
  }

  private compiledBroadSurfaceAdmissionOwner(manifestFingerprint: string | undefined): Readonly<{
    manifest: CompiledBroadSurfaceManifestV2;
    provenance: CompiledBroadSurfaceAdmissionProvenanceV1;
    presenter: CompiledBroadSurfacePixiPresenterV2;
  }> | null {
    return this.compiledBroad.compiledBroadSurfaceAdmissionOwner(manifestFingerprint);
  }

  private compiledBroadSurfaceAdmissionLeaseFailure(
    demandLeaseId: string | undefined,
    manifestFingerprint: string,
    cellId: string
  ): string | null {
    return this.compiledBroad.compiledBroadSurfaceAdmissionLeaseFailure(
      demandLeaseId,
      manifestFingerprint,
      cellId
    );
  }

  private disposeCompiledBroadSurfaceCandidate(): void {
    this.compiledBroad.disposeCompiledBroadSurfaceCandidate();
  }

  private disposeCompiledBroadSurfaceTrackOwner(owner: CompiledBroadSurfaceTrackOwnerV2): void {
    this.compiledBroad.disposeCompiledBroadSurfaceTrackOwner(owner);
  }

  private destroyCompiledBroadSurfaceOwnedTextures(manifestFingerprint: string): void {
    this.compiledBroad.destroyCompiledBroadSurfaceOwnedTextures(manifestFingerprint);
  }

  private ensureRetainedOverviewLayer(): RetainedOverviewAnnotationLayer {
    return this.retainedLinear.ensureRetainedOverviewLayer();
  }

  private ensureRetainedLinearFeatureLayer(): RetainedLinearFeatureLayer {
    return this.retainedLinear.ensureRetainedLinearFeatureLayer();
  }

  private ensureRetainedLinearTranscriptLayer(): RetainedLinearTranscriptLayer {
    return this.retainedLinear.ensureRetainedLinearTranscriptLayer();
  }

  installSidecarRasterSource(sources: AnnotationSidecarRasterExternalSources): void {
    this.sidecarRaster.install(sources, {
      parentContainer: this.container,
      readRenderer: () => this.retainedLinear.pixiRenderer,
    });
  }

  clearSidecarRasterSource(): void {
    this.sidecarRaster.clear();
  }

  setSidecarRasterVisibleTypes(types: readonly string[]): void {
    this.sidecarRaster.setVisibleTypes(types);
  }

  getSidecarRasterVisibleTypes(): readonly string[] {
    return this.sidecarRaster.getVisibleTypes();
  }

  setSidecarRasterLaneLimit(laneLimit: number): void {
    this.sidecarRaster.setLaneLimit(laneLimit);
  }

  getSidecarRasterLaneLimit(): number {
    return this.sidecarRaster.getLaneLimit();
  }

  getSidecarRasterAvailableTypes(): readonly string[] {
    return this.sidecarRaster.getAvailableTypes();
  }

  setRenderer(renderer: Renderer | null): void {
    this.retainedLinear.setRenderer(renderer);
  }

  loadPrepackedAnnotationScene(input: PrepackedAnnotationSceneLoadInput): boolean {
    return this.prepacked.load(input);
  }

  preparePrepackedAnnotationScene(input: PrepackedAnnotationSceneLoadInput): boolean {
    return this.prepacked.prepare(input);
  }

  preparePrepackedAnnotationFineViews(
    viewportStartBp: number,
    viewportEndBp: number,
    _themeMode: 'light' | 'dark',
    deadlineMs = Number.POSITIVE_INFINITY
  ): PrepackedAnnotationFinePreparationResult {
    return preparePrepackedAnnotationFineViewsFn(
      this.prepacked,
      viewportStartBp,
      viewportEndBp,
      _themeMode,
      deadlineMs
    );
  }

  admitPrepackedAnnotationViewportDetailRoster(
    viewportStartBp: number,
    viewportEndBp: number,
    _themeMode: 'light' | 'dark'
  ): boolean {
    return admitPrepackedAnnotationViewportDetailRosterFn(
      this.prepacked,
      viewportStartBp,
      viewportEndBp,
      _themeMode
    );
  }

  private materializePrepackedAnnotationScene(
    input: PrepackedAnnotationSceneLoadInput,
    preserveActiveOwner: boolean,
    deferGpuPreparation: boolean
  ): boolean {
    return this.prepacked.materialize(input, preserveActiveOwner, deferGpuPreparation);
  }

  activatePrepackedAnnotationScene(ownerKey: string): boolean {
    return this.prepacked.activate(ownerKey);
  }

  clearPrepackedAnnotationScene(): void {
    this.prepacked.clear();
  }

  buildAndLoadPrepackedAnnotationScene(
    options: PrepackedAnnotationSceneBuildOptions
  ): PrepackedAnnotationSceneLoadInput | null {
    return buildAndLoadPrepackedAnnotationSceneFn(this.prepacked, options);
  }

  getPrepackedAnnotationFeatureIndex(
    partitionKey: string,
    localInstanceIndex: number
  ): number | null {
    return (
      this.prepacked.prepackedAnnotationSceneLayer?.featureIndexFor(
        partitionKey,
        localInstanceIndex
      ) ?? null
    );
  }

  updatePrepackedAnnotationPolicy(policy: AnnotationPolicyGpuRuntimeV1): boolean {
    return this.updateAnnotationPresentationPolicy(policy);
  }

  updateAnnotationPresentationPolicy(policy: AnnotationPolicyGpuRuntimeV1): boolean {
    return this.commitAnnotationPresentationPolicy(policy).status === 'committed';
  }

  commitAnnotationPresentationPolicy(
    policy: AnnotationPolicyGpuRuntimeV1
  ): AnnotationPresentationPolicyCommitDispositionV1 {
    return commitAnnotationPresentationPolicyFn(this.prepacked, policy);
  }

  private applyAnnotationPresentationPolicy(
    policy: AnnotationPolicyGpuRuntimeV1
  ): boolean | 'deferred' {
    return this.prepacked.applyPolicy(policy);
  }

  private applyPrepackedAnnotationLaneEnvelope(
    policy: AnnotationPolicyGpuRuntimeV1,
    maxima: AnnotationPolicyGpuTrackLaneMaximaV1
  ): void {
    applyPrepackedAnnotationLaneEnvelopeFn(this.layoutState, policy, maxima);
  }

  private commitAnnotationLaneEnvelope(maxAnnotationLane: number, maxCdsLane: number): void {
    commitAnnotationLaneEnvelopeFn(this.layoutState, maxAnnotationLane, maxCdsLane);
  }

  private reconcileAnnotationLaneEnvelopeAuthority(): void {
    reconcileAnnotationLaneEnvelopeAuthorityFn(this.layoutState);
  }

  reconcileAnnotationLaneEnvelopeForFrame(): void {
    this.reconcileAnnotationLaneEnvelopeAuthority();
  }

  getPrepackedAnnotationSceneOwnerSnapshot(): PrepackedAnnotationSceneOwnerSnapshot {
    return getPrepackedAnnotationSceneOwnerSnapshotFn(this.prepacked);
  }

  getAnnotationBodyPresentationAuthoritySnapshot(): AnnotationBodyFrameAuthoritySnapshotV1 {
    return createAnnotationBodyFrameAuthoritySnapshotV1({
      commitEpoch: this.bodyFrame.annotationBodyPresentationCommitEpoch,
      eligibility: this.bodyFrame.annotationBodyFrameEligibility,
      generation: this.bodyFrame.annotationBodyPresentationGeneration,
      frameOwner: this.bodyFrame.annotationBodyFrameOwner,
    });
  }

  private noteAnnotationBodyPresentationCommit(input?: {
    orderedVisibleTrackIds?: readonly string[];
    sourceFingerprint?: string | null;
    placementFingerprint?: string | null;
    productKind?: AnnotationBodyFrameOwnerKind;
    productFingerprints?: readonly string[];
  }): void {
    return this.bodyFrame.noteAnnotationBodyPresentationCommit(input);
  }

  private annotationBodyProductFingerprintsMatchCurrentGeneration(
    committed: readonly string[],
    productKind: AnnotationBodyFrameOwnerKind,
    orderedVisibleTrackIds: readonly string[],
    explicit: readonly string[] | undefined
  ): boolean {
    return this.bodyFrame.annotationBodyProductFingerprintsMatchCurrentGeneration(
      committed,
      productKind,
      orderedVisibleTrackIds,
      explicit
    );
  }

  private noteAnnotationBodyFrameOwner(
    frameOwner: AnnotationBodyFrameOwnerKind,
    probedEligibility?: AnnotationBodyPresenterEligibility
  ): void {
    this.bodyFrame.noteAnnotationBodyFrameOwner(frameOwner, probedEligibility);
  }

  private primeInactivePrepackedAnnotationSceneResident(
    resident: ResidentPrepackedAnnotationScene
  ): void {
    this.prepacked.primeInactivePrepackedAnnotationSceneResident(resident);
  }

  private destroyPrepackedAnnotationSceneResident(
    ownerKey: string,
    status: PrepackedAnnotationSceneStatus,
    recordOwnerChange = true
  ): void {
    this.prepacked.destroyPrepackedAnnotationSceneResident(ownerKey, status, recordOwnerChange);
  }

  private commitPrepackedAnnotationSceneReplacement(
    replacement: ResidentPrepackedAnnotationScene
  ): void {
    this.prepacked.commitPrepackedAnnotationSceneReplacement(replacement);
  }

  private evictPrepackedAnnotationSceneResidentsToLimit(): void {
    this.prepacked.evictPrepackedAnnotationSceneResidentsToLimit();
  }

  private evictCompiledBroadAnnotationInteractionResidentsToLimit(): void {
    this.compiledBroad.evictCompiledBroadAnnotationInteractionResidentsToLimit();
  }

  private disposePrepackedAnnotationSceneLayer(
    layer: PartitionedInstancedTranscriptLayer,
    wasLastComplete: boolean
  ): void {
    this.prepacked.disposePrepackedAnnotationSceneLayer(layer, wasLastComplete);
  }

  releaseRetiredGpuResourcesAfterPresent(force = false): void {
    releaseRetiredGpuResourcesAfterPresentFn(this.prepacked, force);
  }

  private disposePrepackedAnnotationScene(
    status: PrepackedAnnotationSceneStatus,
    recordOwnerChange = true
  ): void {
    this.prepacked.dispose(status, recordOwnerChange);
  }

  private ensureGenomeWideTextureCacheLayer(): GenomeWideTextureCacheLayer {
    return this.retainedLinear.ensureGenomeWideTextureCacheLayer();
  }

  private buildGenomeWideCompositeArgs(
    path: PathMapper,
    state: RenderState
  ): GenomeWideTextureCompositeArgs | null {
    return this.retainedLinear.buildGenomeWideCompositeArgs(path, state);
  }

  async buildAndExtractGenomeWideTexturePng(): Promise<{
    dataUrl: string;
    widthPx: number;
    heightPx: number;
    resolution: number;
    spineOffsetPx: number;
    genomeLength: number;
    maxAnnotationLane: number;
    maxCdsLane: number;
    layerTypes: string[];
  } | null> {
    return this.retainedLinear.buildAndExtractGenomeWideTexturePng();
  }

  loadPrebuiltGenomeWideTexture(image: ImageBitmap, meta: PrebuiltGenomeWideTextureMeta): void {
    this.retainedLinear.loadPrebuiltGenomeWideTexture(image, meta);
  }

  commitPrebuiltGenomeWideTexturePolicy(
    image: ImageBitmap,
    meta: PrebuiltGenomeWideTextureMeta,
    policy: AnnotationPolicyGpuRuntimeV1
  ): boolean {
    return commitPrebuiltGenomeWideTexturePolicyFn(this.retainedLinear, image, meta, policy);
  }

  clearPrebuiltGenomeWideTexture(): void {
    this.retainedLinear.clearPrebuiltGenomeWideTexture();
  }

  isPrebuiltGenomeWideTextureLoaded(): boolean {
    return this.retainedLinear.isPrebuiltGenomeWideTextureLoaded();
  }

  getCompiledBroadAnnotationInteractionAuthoritySnapshot(): CompiledBroadAnnotationInteractionAuthoritySnapshotV1 {
    return getCompiledBroadAnnotationInteractionAuthoritySnapshotFn(this.compiledBroad);
  }

  setPresentationVisible(visible: boolean): void {
    this.mutationPresentationVisible = visible;
    if (!visible) this.mutationSectorGraphics.visible = false;
    this.retainedLinear.setPresentationVisible(visible);
  }

  private resetRetainedOverviewDebug(opts: { preserveTranscriptMesh?: boolean } = {}): void {
    this.retainedLinear.resetRetainedOverviewDebug(opts);
  }

  private retainedOverviewFallback(reason: RetainedOverlayFallbackReason): false {
    return this.retainedLinear.retainedOverviewFallback(reason);
  }

  private clearImmediateStateForCompiledAnnotationOwner(): void {
    this.retainedLinear.clearImmediateStateForCompiledAnnotationOwner();
  }

  private resetAllPresentersToHidden(): void {
    this.retainedLinear.resetAllPresentersToHidden();
  }

  private hideAllPresentationSurfaces(): void {
    this.retainedLinear.hideAllPresentationSurfaces();
  }

  private renderHiddenPresentation(camera: RetainedOverlayCameraState): boolean {
    return this.retainedLinear.renderHiddenPresentation(camera);
  }

  private forceMeshOverview(): boolean {
    return this.retainedLinear.forceMeshOverview();
  }

  private prebuiltRasterTexelsPerDevicePx(camera: RetainedOverlayCameraState): number {
    return this.retainedLinear.prebuiltRasterTexelsPerDevicePx(camera);
  }

  private prebuiltRasterEligibility(
    camera: RetainedOverlayCameraState
  ): AnnotationPrebuiltRasterEligibility {
    return this.retainedLinear.prebuiltRasterEligibility(camera);
  }

  buildRetainedData(_genome: Genome): void {
    this.retainedLinear.buildRetainedData();
  }

  private resetTilePyramid(opts: { retainRtt?: boolean } = {}): void {
    this.tilePyramid.reset(opts);
  }

  private renderImmediateShapesForLodTransition(
    path: PathMapper,
    state: RenderState,
    passthroughFeatures: Feature[],
    fullShapeBlend: number
  ): void {
    this.retainedLinear.renderImmediateShapesForLodTransition(
      path,
      state,
      passthroughFeatures,
      fullShapeBlend
    );
  }

  private syncRetainedLinearOverviewLayers(
    path: PathMapper,
    state: RenderState,
    overviewCache: OverviewAggregationCache,
    featuresToRender: readonly Feature[]
  ): Set<Feature> | null {
    return this.retainedLinear.syncRetainedLinearOverviewLayers(
      path,
      state,
      overviewCache,
      featuresToRender
    );
  }

  private runInvariantGuardAfterRetainedSync(
    transcripts: Feature[],
    blockCount: number,
    transcriptKey: string,
    path: PathMapper
  ): void {
    this.retainedLinear.runInvariantGuardAfterRetainedSync(
      transcripts,
      blockCount,
      transcriptKey,
      path
    );
  }

  private renderRetainedTranscriptDecorations(
    batchedTranscriptSet: ReadonlySet<Feature> | null,
    path: PathMapper,
    state: RenderState,
    sourceFeatures: readonly Feature[] = this.layoutState.features
  ): void {
    renderRetainedTranscriptDecorationsFn(
      this.retainedLinear,
      batchedTranscriptSet,
      path,
      state,
      sourceFeatures
    );
  }

  private clearDecorationCache(): void {
    this.retainedLinear.clearDecorationCache();
  }

  private updateRetainedLinearCamera(camera: RetainedOverlayCameraState): boolean {
    return this.retainedLinear.updateRetainedLinearCamera(camera);
  }

  releaseForcedDoubleDrawForTest(): ForcedLinearTranscriptPresentationTestState {
    return (
      this.retainedLinear.retainedLinearTranscriptLayer?.releaseForcedPresentationForTest() ?? {
        presenting: false,
        retainedBlockCount: 0,
        sentinelResident: false,
      }
    );
  }

  private recordCompiledBroadSurfaceCameraRequest(
    camera: RetainedOverlayCameraState,
    viewportStartBp: number,
    viewportEndBp: number,
    viewportCssWidthPx: number,
    devicePixelRatio: number,
    viewportCssHeightPx: number
  ): void {
    this.compiledBroad.recordCompiledBroadSurfaceCameraRequest(
      camera,
      viewportStartBp,
      viewportEndBp,
      viewportCssWidthPx,
      devicePixelRatio,
      viewportCssHeightPx
    );
  }

  private compiledBroadSurfaceOwnerForTrack(
    trackId: string
  ): CompiledBroadSurfaceTrackOwnerV2 | null {
    return this.compiledBroad.compiledBroadSurfaceOwnerForTrack(trackId);
  }

  private compiledBroadSurfaceManifestFingerprintForTrack(trackId: string): string | null {
    return this.compiledBroad.compiledBroadSurfaceManifestFingerprintForTrack(trackId);
  }

  private compiledBroadSurfaceCandidateOwnerForTrack(
    trackId: string
  ): CompiledBroadSurfaceTrackOwnerV2 | null {
    return this.compiledBroad.compiledBroadSurfaceCandidateOwnerForTrack(trackId);
  }

  private installCompiledBroadSurfaceActiveOwner(owner: CompiledBroadSurfaceTrackOwnerV2): void {
    this.compiledBroad.installCompiledBroadSurfaceActiveOwner(owner);
  }

  private installCompiledBroadSurfaceCandidateOwner(owner: CompiledBroadSurfaceTrackOwnerV2): void {
    this.compiledBroad.installCompiledBroadSurfaceCandidateOwner(owner);
  }

  private compiledBroadSurfaceCandidateRegistrationMatches(
    owner: CompiledBroadSurfaceTrackOwnerV2
  ): boolean {
    return this.compiledBroad.compiledBroadSurfaceCandidateRegistrationMatches(owner);
  }

  private disposeCompiledBroadSurfaceRegisteredCandidate(
    owner: CompiledBroadSurfaceTrackOwnerV2
  ): void {
    this.compiledBroad.disposeCompiledBroadSurfaceRegisteredCandidate(owner);
  }

  private finalizeCompiledBroadSurfaceCandidateOwner(
    owner: CompiledBroadSurfaceTrackOwnerV2
  ): void {
    this.compiledBroad.finalizeCompiledBroadSurfaceCandidateOwner(owner);
  }

  private compiledBroadSurfaceLaneStart(
    trackId: string,
    requestedLayerTypes: readonly string[],
    policy: AnnotationPolicyGpuRuntimeV1
  ): number {
    return this.compiledBroad.compiledBroadSurfaceLaneStart(trackId, requestedLayerTypes, policy);
  }

  private annotationTrackRealizedLaneCapacity(
    trackId: string,
    policy: AnnotationPolicyGpuRuntimeV1,
    preserveLegacyFixedCapacity = this.annotationLayerTypesForPresentation().length <= 1
  ): number {
    return this.compiledBroad.annotationTrackRealizedLaneCapacity(
      trackId,
      policy,
      preserveLegacyFixedCapacity
    );
  }

  private annotationTrackStackMaxLane(policy: AnnotationPolicyGpuRuntimeV1): number {
    return this.compiledBroad.annotationTrackStackMaxLane(policy);
  }

  private sealCompiledBroadPresentedFrame(
    camera: RetainedOverlayCameraState,
    options: { clearImmediate: boolean }
  ): true {
    return this.retainedLinear.sealCompiledBroadPresentedFrame(camera, options);
  }

  private tryPresentRequestedCompiledBroadSurfaces(
    camera: RetainedOverlayCameraState,
    requestedLayerTypes: readonly string[]
  ): AnnotationBodyReplacementReadiness {
    return this.compiledBroad.tryPresentRequestedCompiledBroadSurfaces(camera, requestedLayerTypes);
  }

  private tryRetainLastCompleteCompiledBroadSurfaceFrame(
    camera: RetainedOverlayCameraState,
    policy: AnnotationPolicyGpuRuntimeV1
  ): boolean {
    return this.compiledBroad.tryRetainLastCompleteCompiledBroadSurfaceFrame(camera, policy);
  }

  private finalizeCompiledBroadSurfaceFrame(camera: RetainedOverlayCameraState): true {
    return this.sealCompiledBroadPresentedFrame(camera, { clearImmediate: true });
  }

  private tryPresentPrepackedAnnotationScene(
    camera: RetainedOverlayCameraState,
    style: RetainedOverviewAnnotationStyle,
    prebuiltRasterEligibility: AnnotationPrebuiltRasterEligibility
  ): AnnotationBodyReplacementReadiness {
    return this.prepacked.present(camera, style, prebuiltRasterEligibility);
  }

  private annotationExactCoverageCovers(viewStartBp: number, viewEndBp: number): boolean {
    return rangesCoverInterval(
      this.layoutState.annotationExactCoverage,
      viewStartBp,
      viewEndBp,
      this.layoutState.genomeLength
    );
  }

  private probeAnnotationBodyPresenterEligibility(
    camera: RetainedOverlayCameraState,
    prebuiltRasterEligibility: ReturnType<IndexedAnnotationOverlay['prebuiltRasterEligibility']>,
    priorFrameHadCompleteBroadOwnership: boolean
  ): AnnotationBodyPresenterEligibility {
    return this.bodyFrame.probeAnnotationBodyPresenterEligibility(
      camera,
      prebuiltRasterEligibility,
      priorFrameHadCompleteBroadOwnership
    );
  }

  private presentExclusiveAnnotationBodyFrame(
    camera: RetainedOverlayCameraState,
    style: RetainedOverviewAnnotationStyle,
    prebuiltRasterEligibility: ReturnType<IndexedAnnotationOverlay['prebuiltRasterEligibility']>,
    priorFrameHadCompleteBroadOwnership: boolean
  ): boolean {
    return this.bodyFrame.presentExclusiveAnnotationBodyFrame(
      camera,
      style,
      prebuiltRasterEligibility,
      priorFrameHadCompleteBroadOwnership
    );
  }

  private finalizeCompiledAnnotationBodyPresent(
    camera: RetainedOverlayCameraState,
    style: RetainedOverviewAnnotationStyle
  ): void {
    this.retainedLinear.finalizeCompiledAnnotationBodyPresent(camera, style);
  }

  private tryPresentPrebuiltRasterBody(
    camera: RetainedOverlayCameraState,
    style: RetainedOverviewAnnotationStyle,
    prebuiltRasterEligibility: ReturnType<IndexedAnnotationOverlay['prebuiltRasterEligibility']>
  ): boolean {
    return this.retainedLinear.tryPresentPrebuiltRasterBody(
      camera,
      style,
      prebuiltRasterEligibility
    );
  }

  private presentEmptyRetainedLinearViewport(
    camera: RetainedOverlayCameraState,
    style: RetainedOverviewAnnotationStyle,
    overviewVisibleBp: number,
    prebuiltLayer: GenomeWideTextureCacheLayer | null | undefined
  ): boolean {
    return this.retainedLinear.presentEmptyRetainedLinearViewport(
      camera,
      style,
      overviewVisibleBp,
      prebuiltLayer
    );
  }

  private updateRetainedLinearCameraInner(camera: RetainedOverlayCameraState): boolean {
    return this.retainedLinear.updateRetainedLinearCameraInner(camera);
  }

  private finalizeRetainedImmediateLinearFrame(
    camera: RetainedOverlayCameraState,
    style: RetainedOverviewAnnotationStyle
  ): boolean {
    return this.retainedLinear.finalizeRetainedImmediateLinearFrame(camera, style);
  }

  updateRetainedCamera(camera: RetainedOverlayCameraState): boolean {
    this.syncAnnotationColors(camera.state);
    const presented = this.retainedLinear.updateRetainedCamera(camera);
    if (presented) this.renderMutationSectors(camera.path, camera.state);
    return presented;
  }

  updateRetainedInteraction(_state: RenderState): void {
    if (this.retainedLinear.retainedOverviewMode === 'retained') {
      this.retainedLinear.retainedOverviewInteractionUpdates += 1;
    }
  }

  getRetainedDebugSnapshot(): RetainedOverlayDebugSnapshot {
    return {
      id: 'annotations.overview-bodies',
      style: this.retainedLinear.retainedOverviewStyle,
      supported: this.layoutState.features.length > 0,
      enabled: retainedOverviewAnnotationsEnabled(),
      mode: this.retainedLinear.retainedOverviewMode,
      dataBuilds: this.retainedLinear.retainedOverviewDataBuilds,
      cameraUpdates: this.retainedLinear.retainedOverviewCameraUpdates,
      interactionUpdates: this.retainedLinear.retainedOverviewInteractionUpdates,
      fallbackRenders: this.retainedLinear.retainedOverviewFallbackRenders,
      lastFallbackReason: this.retainedLinear.retainedOverviewFallbackReason,
      retainedInstanceCount: this.retainedLinear.retainedOverviewInstanceCount,
      visibleInstanceCount: this.retainedLinear.retainedOverviewVisibleInstanceCount,
    };
  }

  computeHeight(_genome: Genome, _state: RenderState, _pixelsPerBp: number): number {
    if (this.layoutState.features.length === 0) return 0;

    return Math.max(0, this.maxAnnotationLane + 1) * ANNOTATION_LANE_TOTAL;
  }

  loadGenome(genome: Genome): void {
    this.outlines.clearChangeDecorations();
    loadAnnotationGenomeFn(this.layoutState, genome);
  }

  setAnnotationPresentationSnapshot(
    snapshot: AnnotationFlatPresentationSnapshot
  ): AnnotationPresentationSnapshotApplyResult {
    return this.setAnnotationFlatPresentationSnapshot(snapshot);
  }

  setAnnotationFlatPresentationSnapshot(
    snapshot: AnnotationFlatPresentationSnapshot
  ): AnnotationPresentationSnapshotApplyResult {
    return setAnnotationFlatPresentationSnapshotFn(this.layoutState, snapshot);
  }

  ingestAnnotationResidentPages(
    publication: AnnotationResidentPagePublication
  ): AnnotationResidentPagePublicationApplyResult {
    return this.residentPages.ingestAnnotationResidentPages(publication);
  }

  getAnnotationPresentationFeatures(): ReadonlyArray<Feature> {
    return this.layoutState.features;
  }

  selectResidentAnnotationFeaturesForViewport(
    viewStartBp: number,
    viewEndBp: number,
    annotationSearchFocus: RenderState['annotationSearchFocus'] = null
  ): Readonly<{
    status: 'unavailable' | 'ready' | 'incomplete';
    key: string | null;
    features: ReadonlyArray<Feature>;
  }> {
    return this.residentPages.selectResidentAnnotationFeaturesForViewport(
      viewStartBp,
      viewEndBp,
      annotationSearchFocus
    );
  }

  private activeResidentPublicationOwnsAnnotationBodyFallback(): boolean {
    return this.residentPages.activeResidentPublicationOwnsAnnotationBodyFallback();
  }

  private projectResidentAnnotationFeatures(
    records: ReadonlyArray<AnnotationResidentPageRecord>,
    annotationSearchFocus: RenderState['annotationSearchFocus']
  ): Feature[] | null {
    return this.residentPages.projectResidentAnnotationFeatures(records, annotationSearchFocus);
  }

  private prepackedPolicyFeatureIndexForResidentFeature(
    resident: ResidentPageFeatureResident,
    feature: Feature,
    canonicalIdentity: string
  ): number | null {
    return this.residentPages.prepackedPolicyFeatureIndexForResidentFeature(
      resident,
      feature,
      canonicalIdentity
    );
  }

  private residentAnnotationPolicyProjectionKey(
    annotationSearchFocus: RenderState['annotationSearchFocus']
  ): string {
    return this.residentPages.residentAnnotationPolicyProjectionKey(annotationSearchFocus);
  }

  private applyAnnotationGenome(genome: Genome): void {
    applyAnnotationGenomeFn(this.layoutState, genome);
  }

  private featuresInRange(viewStartBp: number, viewEndBp: number): Feature[] {
    return featuresInRangeFn(this.layoutState, viewStartBp, viewEndBp);
  }

  private wrappedFeatureOverlapsRange(
    feature: Feature,
    viewStartBp: number,
    viewEndBp: number
  ): boolean {
    return this.layoutState.wrappedFeatureOverlapsRange(feature, viewStartBp, viewEndBp);
  }

  private hasFeaturesInRange(viewStartBp: number, viewEndBp: number): boolean {
    return hasFeaturesInRangeFn(this.layoutState, viewStartBp, viewEndBp);
  }

  private clearDrawState(): void {
    this.outlines.clearChangeDecorations();
    this.layoutState.clearDrawState();
  }

  private overviewCacheContext(): AnnotationOverviewCacheContext {
    const layout = this.layoutState;
    return overviewCacheContextFn(
      {
        features: layout.features,
        genomeLength: layout.genomeLength,
        _layout: layout._layout,
        maxAnnotationLane: layout.maxAnnotationLane,
        maxCdsLane: layout.maxCdsLane,
        featureOffset: (feature) => this.featureOffset(feature),
        scaledBarHeight: () => this.scaledBarHeight(),
      },
      getColor,
      isOutlineOnlyFeature,
      isSplicedFeature,
      isTranscript
    );
  }

  render(path: PathMapper, state: RenderState, _yOffset: number, _height: number): void {
    this.syncAnnotationColors(state);
    renderAnnotationOverlayFrame(this.retainedLinear, path, state);
    this.renderMutationSectors(path, state);
  }

  private syncAnnotationColors(state: RenderState): void {
    const presentation = state.sequencePresentation;
    const colors = presentation?.annotationColors;
    if (
      colors === this.annotationColors &&
      presentation === this.mutationPresentation &&
      this.layoutState.features === this.mutationFeatures
    )
      return;
    this.annotationColors = colors;
    this.mutationPresentation = presentation;
    this.mutationFeatures = this.layoutState.features;
    this.mutationPaint = buildAnnotationMutationPaint(
      this.layoutState.features,
      presentation,
      this.layoutState.genomeLength
    );
    this.retainedLinear.lastRenderKey = '';
    this.clearDecorationCache();
  }

  private renderMutationSectors(path: PathMapper, state: RenderState): void {
    if (!this.mutationPresentationVisible) {
      this.mutationSectorGraphics.visible = false;
      return;
    }
    const halfHeight = this.scaledBarHeight() / 2;
    const detail = this.cdsDetailProgress();
    this.mutationSectorReceipt = renderAnnotationMutationSectors(
      {
        featureById: this.layoutState.featureById,
        featureOffset: (feature) => this.featureOffset(feature),
        halfHeight,
        outlineFor: (feature) => {
          if (
            !path.isArcMode &&
            this.retainedLinear.retainedLinearTranscriptFeatureSet?.has(feature)
          ) {
            return retainedAnnotationSectorOutline(
              feature,
              path,
              state,
              this.featureOffset(feature),
              halfHeight,
              detail
            );
          }
          this.ensureInteractionOutline(path, feature.id);
          return this.immediateDraw.outlineCache.get(feature.id) ?? [];
        },
      },
      this.mutationSectorGraphics,
      path,
      this.mutationPaint,
      detail
    );
  }

  private immediateDrawHost(): ImmediateDrawHost {
    return this.immediateDraw;
  }

  private renderImmediateFeature(
    sink: FeaturePrimitiveSink,
    feature: Feature,
    path: PathMapper,
    state: RenderState,
    useOverviewAggregation: boolean,
    forceTinyFeatureShapes = false,
    alphaScale = 1
  ): AnnotationDrawAuditDecision {
    return renderImmediateFeatureFn(
      this.immediateDrawHost(),
      sink,
      feature,
      path,
      state,
      useOverviewAggregation,
      forceTinyFeatureShapes,
      alphaScale
    );
  }

  private setFeatureOutline(featureId: number, commands: OutlineCommand[]): void {
    setFeatureOutlineFn(this.immediateDraw.outlineCache, featureId, commands);
  }

  private addFeatureOutline(featureId: number, command: OutlineCommand): void {
    addFeatureOutlineFn(this.immediateDraw.outlineCache, featureId, command);
  }

  private lanePillOutlineCommand(
    path: PathMapper,
    startBp: number,
    widthPx: number,
    offset: number,
    halfHeight: number
  ): OutlineCommand[] {
    return annotationLanePillOutlineCommand(
      path,
      startBp,
      widthPx,
      offset,
      halfHeight,
      this.layoutState.genomeLength
    );
  }

  private cdsLabelStripOutlineCommand(
    path: PathMapper,
    pillStartBp: number,
    pillWidthPx: number,
    featureEndBp: number,
    offset: number,
    pillHalfHeight: number,
    connectorHalfHeight: number
  ): OutlineCommand[] {
    return annotationCdsLabelStripOutlineCommand(
      path,
      pillStartBp,
      pillWidthPx,
      featureEndBp,
      offset,
      pillHalfHeight,
      connectorHalfHeight,
      this.layoutState.genomeLength
    );
  }

  private ensureInteractionOutline(path: PathMapper, featureId: number): void {
    this.outlines.ensureInteractionOutline(path, featureId);
  }

  private renderInteractionOutlines(path: PathMapper, state: RenderState): void {
    this.outlines.render(path, state);
  }

  renderCompoundCdsInteractionOutlines(
    path: PathMapper,
    state: RenderState,
    codonContours: ReadonlyMap<number, readonly number[][]>
  ): void {
    if (codonContours.size) this.outlines.render(path, state, codonContours);
  }

  private strokeCompiledBroadInteractionFeature(
    graphics: Graphics,
    path: PathMapper,
    state: RenderState,
    resident: ResidentCompiledBroadAnnotationInteractionV1,
    rendererId: number,
    forceSelected = false,
    trackOffsetPx = 0
  ): number {
    return this.outlines.strokeCompiledBroadInteractionFeature(
      graphics,
      path,
      state,
      resident,
      rendererId,
      forceSelected,
      trackOffsetPx
    );
  }

  private resolvePrepackedAnnotationSearchFocusTarget(
    focus: NonNullable<RenderState['annotationSearchFocus']>
  ): Readonly<{
    resident: ResidentPrepackedAnnotationScene;
    featureIndex: number;
    presentationTrackIds: readonly string[];
  }> | null {
    return resolvePrepackedAnnotationSearchFocusTargetFn(
      {
        compiledBroadSurfacePresentingLayerTypes: () =>
          this.compiledBroad.compiledBroadSurfacePresentingLayerTypes(),
        prepackedAnnotationScenePresentingResidents: () =>
          this.prepacked.prepackedAnnotationScenePresentingResidents(),
        compiledBroadSurfaceInteractionResidentForTrack: (trackId) =>
          this.compiledBroad.compiledBroadSurfaceInteractionResidentForTrack(
            trackId
          ) as SearchFocusTargetResident | null,
      },
      focus
    ) as Readonly<{
      resident: ResidentPrepackedAnnotationScene;
      featureIndex: number;
      presentationTrackIds: readonly string[];
    }> | null;
  }

  private prepackedAnnotationPolicyFeatureIsDurablyVisible(
    resident: ResidentPrepackedAnnotationScene,
    featureIndex: number
  ): boolean {
    const runtimePolicy = this.prepacked.prepackedAnnotationRuntimePolicy;
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

  annotationSearchFocusDurableVisibility(
    focus: RenderState['annotationSearchFocus']
  ): 'visible' | 'filtered' | 'unavailable' {
    if (!focus) return 'unavailable';
    const target = this.resolvePrepackedAnnotationSearchFocusTarget(focus);
    if (!target) return 'unavailable';
    return this.prepackedAnnotationPolicyFeatureIsDurablyVisible(
      target.resident,
      target.featureIndex
    )
      ? 'visible'
      : 'filtered';
  }

  private renderAnnotationSearchFocusMask(
    graphics: Graphics,
    path: PathMapper,
    state: RenderState,
    top: number,
    bottom: number
  ): void {
    renderAnnotationSearchFocusMaskFn(this.searchFocusHost(), graphics, path, state, top, bottom);
  }

  private renderAnnotationSearchFocus(path: PathMapper, state: RenderState): void {
    renderAnnotationSearchFocusFn(this.searchFocusHost(), path, state);
  }

  private renderFlatAnnotationSearchFocus(path: PathMapper, state: RenderState): void {
    renderFlatAnnotationSearchFocusFn(this.searchFocusHost(), path, state);
  }

  private flatAnnotationSearchFocusBlockGeometry(
    path: PathMapper,
    state: RenderState,
    block: DirectionalBlock
  ): { points: number[]; actualWidthPx: number } | null {
    return flatAnnotationSearchFocusBlockGeometryFn(path, state, block);
  }

  private prepackedInteractionGeometryHost(): PrepackedInteractionGeometryHost {
    if (this.prepackedInteractionGeometryHostCache)
      return this.prepackedInteractionGeometryHostCache;
    this.prepackedInteractionGeometryHostCache = ((
      overlay: this
    ): PrepackedInteractionGeometryHost => ({
      prepackedPolicyTrackLaneForPrimitive: (primitiveIndex, input) =>
        overlay.prepackedPolicyTrackLaneForPrimitive(primitiveIndex, input),
      prepackedAnnotationCenterScreenY: (path, offsetPx) =>
        overlay.prepackedAnnotationCenterScreenY(path, offsetPx),
    }))(this);
    return this.prepackedInteractionGeometryHostCache;
  }

  private prepackedAnnotationPrimitiveScreenGeometry(
    path: PathMapper,
    state: RenderState,
    input: PrepackedAnnotationSceneLoadInput,
    primitiveIndex: number,
    trackOffsetPx: number,
    temporaryAdditionalLane: number | null = null
  ): { points: number[]; actualWidthPx: number } | null {
    return prepackedAnnotationPrimitiveScreenGeometryFn(
      this.prepackedInteractionGeometryHost(),
      path,
      state,
      input,
      primitiveIndex,
      trackOffsetPx,
      temporaryAdditionalLane
    );
  }

  private strokePrepackedInteractionFeature(
    graphics: Graphics,
    path: PathMapper,
    state: RenderState,
    resident: ResidentPrepackedAnnotationScene,
    rendererId: number,
    forceSelected = false,
    trackOffsetPx = 0
  ): number {
    return strokePrepackedInteractionFeatureFn(
      this.prepackedInteractionGeometryHost(),
      graphics,
      path,
      state,
      resident.input,
      rendererId,
      forceSelected,
      trackOffsetPx
    );
  }

  private prepackedPolicyTrackLaneForPrimitive(
    primitiveIndex: number,
    input: PrepackedAnnotationSceneLoadInput | null = this.prepacked.prepackedAnnotationSceneInput
  ): number | null | undefined {
    return prepackedPolicyTrackLaneForPrimitiveFn(this.prepacked, primitiveIndex, input);
  }

  private prepackedResidentTrackOffsetPx(
    resident: ResidentPrepackedAnnotationScene,
    requestedLayerTypes: readonly string[],
    policy: AnnotationPolicyGpuRuntimeV1
  ): number {
    return prepackedResidentTrackOffsetPxFn(this.prepacked, resident, requestedLayerTypes, policy);
  }

  private prepackedRendererIdForCanonicalIdentity(
    canonicalIdentity: string
  ): Readonly<{ ownerKey: string; rendererId: number }> | null {
    return prepackedRendererIdForCanonicalIdentityFn(this.prepacked, canonicalIdentity);
  }

  private invalidateCameraDependentInteractionOutline(featureId: number): void {
    this.outlines.invalidateCameraDependentInteractionOutline(featureId);
  }

  private strokeOutlineCommand(g: Graphics, command: OutlineCommand): void {
    strokeOutlineCommandFn(g, command);
  }

  private strokeCurrentPath(
    g: Graphics,
    path: PathMapper,
    color: number,
    alpha: number,
    width = 1.5
  ): void {
    strokeCurrentPathFn(g, path, color, alpha, width);
  }

  private strokeLanePill(
    g: Graphics,
    path: PathMapper,
    startBp: number,
    widthPx: number,
    offset: number,
    halfHeight: number,
    color: number,
    alpha: number
  ): void {
    strokeLanePillFn(
      g,
      path,
      startBp,
      widthPx,
      offset,
      halfHeight,
      color,
      alpha,
      this.layoutState.genomeLength,
      laneRoundedPillPolygon
    );
  }

  private strokeOutlineCommands(
    g: Graphics,
    path: PathMapper,
    commands: OutlineCommand[],
    color: number,
    alpha: number
  ): void {
    strokeOutlineCommandsFn(g, path, commands, color, alpha);
  }

  private strokeDraftOutlineCommands(
    g: Graphics,
    path: PathMapper,
    commands: OutlineCommand[],
    color: number,
    alpha: number
  ): void {
    strokeDraftOutlineCommandsFn(g, path, commands, color, alpha);
  }

  private featureLevelLabelCenterBp(
    feature: Feature,
    featureLen: number,
    hitPts: number[],
    state: RenderState
  ): number {
    const { fraction } = visibleCenterFromPolygon(hitPts, state.width, state.height);
    return feature.start + featureLen * fraction;
  }

  private shouldRenderFeatureText(path: PathMapper): boolean {
    return shouldRenderFeatureTextAtLod({
      sequenceVisible: path.sequenceVisible,
      genomeLength: this.layoutState.genomeLength,
      pixelsPerBp: path.pixelsPerBp,
      isArcMode: path.isArcMode,
    });
  }

  private pillStartForTextCenter(
    path: PathMapper,
    centerBp: number,
    textCenterOffsetPx: number,
    offset: number
  ): number {
    const offsetBp = screenWidthToBp(path, centerBp, textCenterOffsetPx, offset);
    const startBp = centerBp - offsetBp;
    return this.layoutState.genomeCircular
      ? normalizeBp(startBp, this.layoutState.genomeLength)
      : startBp;
  }

  private cdsLabelStripHost(): CdsLabelStripDrawHost {
    return this.immediateDraw;
  }

  private drawCDSLabelStrip(
    g: Graphics,
    feature: Feature,
    endBp: number,
    featureLen: number,
    color: number,
    alpha: number,
    path: PathMapper,
    state: RenderState,
    labelAlpha = 1,
    transitionFromCenterBp: number | null = null,
    drawConnector = true,
    centerCutoutHalfHeight: number | null = null
  ): void {
    drawCDSLabelStripFn(
      this.cdsLabelStripHost(),
      g,
      feature,
      endBp,
      featureLen,
      color,
      alpha,
      path,
      state,
      labelAlpha,
      transitionFromCenterBp,
      drawConnector,
      centerCutoutHalfHeight
    );
  }

  private drawLanePillShell(
    g: Graphics,
    path: PathMapper,
    pillStartBp: number,
    widthPx: number,
    offset: number,
    pillHalfHeight: number,
    centerCutoutHalfHeight: number,
    color: number,
    alpha: number
  ): void {
    drawLanePillShellFn(
      this.immediateDraw,
      g,
      path,
      pillStartBp,
      widthPx,
      offset,
      pillHalfHeight,
      centerCutoutHalfHeight,
      color,
      alpha
    );
  }

  private drawLaneBandWithGaps(
    g: Graphics,
    path: PathMapper,
    startBp: number,
    endBp: number,
    offset: number,
    halfHeight: number,
    color: number,
    alpha: number,
    gaps: Array<{ startBp: number; endBp: number }>
  ): void {
    drawLaneBandWithGapsFn(
      this.layoutState,
      g,
      path,
      startBp,
      endBp,
      offset,
      halfHeight,
      color,
      alpha,
      gaps
    );
  }

  private drawPillSeparator(
    g: Graphics,
    path: PathMapper,
    pillStartBp: number,
    offsetPxFromPillStart: number,
    offset: number,
    height: number,
    alpha = 1
  ): void {
    drawPillSeparatorFn(g, path, pillStartBp, offsetPxFromPillStart, offset, height, alpha);
  }

  private cdsDirectionGlyph(feature: Feature): string | null {
    if (feature.direction === 'forward') return '»';
    if (feature.direction === 'reverse') return '«';
    return null;
  }

  private drawCdsDirectionGlyphInPill(
    feature: Feature,
    glyph: string,
    pillStartBp: number,
    pillWidthPx: number,
    glyphWidthPx: number,
    offset: number,
    color: number,
    path: PathMapper,
    alpha = 1,
    textColor?: number
  ): void {
    drawCdsDirectionGlyphInPillFn(
      this.immediateDraw,
      feature,
      glyph,
      pillStartBp,
      pillWidthPx,
      glyphWidthPx,
      offset,
      color,
      path,
      alpha,
      textColor
    );
  }

  private drawLabelTextInPill(
    feature: Feature,
    text: string,
    startBp: number,
    widthPx: number,
    offset: number,
    color: number,
    path: PathMapper,
    maxTextWidth: number,
    alpha = 1,
    centerBpOverride: number | null = null,
    curvedRangeStartBp: number | null = null,
    curvedRangeEndBp: number | null = null,
    textColor?: number
  ): void {
    drawLabelTextInPillFn(
      this.immediateDraw,
      feature,
      text,
      startBp,
      widthPx,
      offset,
      color,
      path,
      maxTextWidth,
      alpha,
      centerBpOverride,
      curvedRangeStartBp,
      curvedRangeEndBp,
      textColor
    );
  }

  private pushPillHit(
    feature: Feature,
    startBp: number,
    widthPx: number,
    offset: number,
    halfHeight: number,
    rangeStart: number,
    rangeEnd: number,
    path: PathMapper
  ): void {
    pushPillHitFn(
      {
        genomeLength: this.layoutState.genomeLength,
        hitCache: this.hits.hitCache,
      },
      feature,
      startBp,
      widthPx,
      offset,
      halfHeight,
      rangeStart,
      rangeEnd,
      path
    );
  }

  private reservePillBounds(
    state: RenderState,
    path: PathMapper,
    startBp: number,
    widthPx: number,
    offset: number,
    halfHeight: number,
    record: { kind: string; featureId?: number; text?: string },
    force = false
  ): boolean {
    return reserveAnnotationPillBounds(
      this.retainedLinear,
      state,
      path,
      startBp,
      widthPx,
      offset,
      halfHeight,
      record,
      force
    );
  }

  private replayLabelOccupancy(state: RenderState): void {
    replayAnnotationLabelOccupancy(this.retainedLinear, state);
  }

  private standardFeatureDrawPoints(
    feature: Feature,
    endBp: number,
    pixelWidth: number,
    path: PathMapper,
    hitPts: number[],
    halfHeight = this.scaledBarHeight() / 2
  ): number[] {
    const offset = this.featureOffset(feature);
    const barH = halfHeight * 2;

    const hasArrow = feature.direction !== 'none';
    const aw = hasArrow ? this.directionalArrowWidth(pixelWidth, barH) : 0;
    const drawArrow = hasArrow && pixelWidth > aw * 2;
    if (drawArrow) return buildDirectionalPolygon(path, feature, endBp, offset, aw, halfHeight);
    if (Math.abs(halfHeight - this.scaledBarHeight() / 2) < 1e-6) return hitPts;
    return path.featurePolygonAt(feature.start, endBp, offset, halfHeight);
  }

  private drawFeatureLevelTransitionShape(
    g: Graphics,
    feature: Feature,
    endBp: number,
    pixelWidth: number,
    color: number,
    alpha: number,
    path: PathMapper,
    hitPts: number[],
    detailProgress: number
  ): void {
    drawFeatureLevelTransitionShapeFn(
      this.immediateDraw,
      g,
      feature,
      endBp,
      pixelWidth,
      color,
      alpha,
      path,
      hitPts,
      detailProgress
    );
  }

  private standardFeatureDrawHost(): StandardFeatureDrawHost {
    return this.immediateDraw;
  }

  private drawStandard(
    sink: FeaturePrimitiveSink,
    feature: Feature,
    endBp: number,
    featureLen: number,
    pixelWidth: number,
    color: number,
    alpha: number,
    path: PathMapper,
    state: RenderState,
    hitPts: number[],
    renderLabel = true,
    labelAlphaScale = 1
  ): void {
    drawStandardFn(
      this.standardFeatureDrawHost(),
      sink,
      feature,
      endBp,
      featureLen,
      pixelWidth,
      color,
      alpha,
      path,
      state,
      hitPts,
      renderLabel,
      labelAlphaScale
    );
  }

  private drawRetainedTranscriptIntronConnectors(
    g: Graphics,
    feature: Feature,
    path: PathMapper,
    state: RenderState,
    alpha: number,
    clipRange?: { lo: number; hi: number }
  ): void {
    drawRetainedTranscriptIntronConnectorsFn(
      this.transcriptGlyphHost(),
      g,
      feature,
      path,
      state,
      alpha,
      clipRange
    );
  }

  private transcriptViewportBounds(path: PathMapper): { visLo: number; visHi: number } {
    const visStart = path.viewStartBp;
    const visEnd = path.viewEndBp;
    const visMargin = Math.max(1, visEnd - visStart);
    return {
      visLo: visStart - visMargin,
      visHi: visEnd + visMargin,
    };
  }

  private transcriptIntronGapRanges(
    feature: Feature,
    path: PathMapper
  ): Array<{ startBp: number; endBp: number }> {
    const exons = feature.exons ?? [];
    if (exons.length <= 1) return [];

    const { visLo, visHi } = this.transcriptViewportBounds(path);
    const ranges: Array<{ startBp: number; endBp: number }> = [];
    for (let i = 0; i < exons.length - 1; i++) {
      const intronStart = exons[i].end;
      const intronEnd = exons[i + 1].start - 1;
      const startBp = Math.max(intronStart, visLo);
      const endBp = Math.min(intronEnd, visHi);
      if (endBp <= startBp) continue;
      ranges.push({ startBp, endBp });
    }
    return ranges;
  }

  private laneCenterlinePoints(
    path: PathMapper,
    startBp: number,
    endBp: number,
    offset: number
  ): number[] {
    if (!path.isArcMode) {
      const y = path.featureLabelPosAt(startBp, offset).y;
      return [path.bpLeftX(startBp), y, path.bpLeftX(endBp), y];
    }

    const pixelWidth = Math.abs(endBp - startBp) * Math.max(path.pixelsPerBp, 1e-6);
    const steps = Math.max(1, Math.min(96, Math.ceil(pixelWidth / 10)));
    const pts: number[] = [];
    for (let i = 0; i <= steps; i++) {
      const bp = startBp + ((endBp - startBp) * i) / steps;
      const p = path.featureLabelPosAt(bp, offset);
      pts.push(p.x, p.y);
    }
    return pts;
  }

  private transcriptIntronLineOutlineCommands(
    feature: Feature,
    path: PathMapper,
    offset: number
  ): OutlineCommand[] {
    return this.transcriptIntronGapRanges(feature, path)
      .map(({ startBp, endBp }) => ({
        kind: 'polyline' as const,
        pts: this.laneCenterlinePoints(path, startBp, endBp, offset),
      }))
      .filter((command) => command.pts.length >= 4);
  }

  private transcriptGlyphOutlineCommands(feature: Feature, path: PathMapper): OutlineCommand[] {
    return transcriptGlyphOutlineCommandsFn(this.transcriptGlyphHost(), feature, path);
  }

  private transcriptGlyphHost(): TranscriptGlyphDrawHost {
    return this.immediateDraw;
  }

  private drawTranscriptGlyph(
    sink: FeaturePrimitiveSink,
    feature: Feature,
    endBp: number,
    featureLen: number,
    pixelWidth: number,
    baseColor: number,
    alpha: number,
    path: PathMapper,
    state: RenderState,
    hitPts: number[],
    labelAlphaScale: number
  ): void {
    drawTranscriptGlyphFn(
      this.transcriptGlyphHost(),
      sink,
      feature,
      endBp,
      featureLen,
      pixelWidth,
      baseColor,
      alpha,
      path,
      state,
      hitPts,
      labelAlphaScale
    );
  }

  private renderCurvedLabel(
    labelText: string,
    centerBp: number,
    textWidth: number,
    feature: Feature,
    endBp: number,
    color: number,
    offset: number,
    path: PathMapper,
    alpha = 1,
    rangeStartBp = feature.start,
    rangeEndBp = endBp,
    textColor?: number
  ): void {
    renderCurvedLabelFn(
      this.immediateDraw,
      labelText,
      centerBp,
      textWidth,
      feature,
      endBp,
      color,
      offset,
      path,
      alpha,
      rangeStartBp,
      rangeEndBp,
      textColor
    );
  }

  private acquireLabel(): Text {
    let t: Text;
    if (this.retainedLinear.labelIndex < this.retainedLinear.labelPool.length) {
      t = this.retainedLinear.labelPool[this.retainedLinear.labelIndex];
      t.visible = true;
    } else {
      t = new Text({
        text: '',
        style: pillLabelTextStyle(0xffffff),
        resolution: targetPillLabelTextResolution(),
      });
      this.container.addChild(t);
      this.retainedLinear.labelPool.push(t);
    }
    this.retainedLinear.labelIndex++;
    return t;
  }

  private buildPresentationDebugSnapshot(): AnnotationPresentationDebugSnapshot {
    return buildPresentationDebugSnapshotFn(this.retainedLinear);
  }

  private auditAnnotationDraw(state: RenderState): void {
    auditAnnotationDrawFn(this.retainedLinear, state);
  }

  private annotationSnapshotSources(): AnnotationSnapshotSources {
    return {
      retained: this.retainedLinear,
      prepacked: this.prepacked,
      compiled: this.compiledBroad,
      layout: this.layoutState,
      searchFocus: this.searchFocus,
      hits: this.hits,
      outlines: this.outlines,
      residentPages: this.residentPages,
      tilePyramid: this.tilePyramid,
      leftover: {
        currentGenomeIdentity: this.layoutState.currentGenomeIdentity,
        currentAnnotationSourceFingerprint: this.layoutState.currentAnnotationSourceFingerprint,
        currentAnnotationPlacementFingerprint:
          this.layoutState.currentAnnotationPlacementFingerprint,
        annotationRequestedLayerTypes: this.layoutState.annotationRequestedLayerTypes,
        annotationLayerTypesForPresentation: () => this.annotationLayerTypesForPresentation(),
        graphics: this.retainedLinear.graphics,
        labelIndex: this.retainedLinear.labelIndex,
        labelPool: this.retainedLinear.labelPool,
        curvedLabels: this.retainedLinear.curvedLabels,
        retainedTranscriptDecorationBuilds: this.retainedLinear.retainedTranscriptDecorationBuilds,
        featureEnvelope: (feature) => this.featureEnvelope(feature),
        prepackedAnnotationScenePresentingResidents: () =>
          this.prepackedAnnotationScenePresentingResidents(),
        getPrepackedAnnotationSceneOwnerSnapshot: () =>
          this.getPrepackedAnnotationSceneOwnerSnapshot(),
      },
    };
  }

  getColdGestureSnapshot(): AnnotationOverlayColdGestureSnapshot {
    return getColdGestureSnapshotFn(this.annotationSnapshotSources());
  }

  getAnnotationSearchFocusPresentationSnapshot(): AnnotationSearchFocusPresentationSnapshot {
    return getAnnotationSearchFocusPresentationSnapshotFn(this.searchFocus);
  }

  getDebugSnapshot(): AnnotationOverlayDebugSnapshot & {
    readonly annotationMutationSectors: ReturnType<typeof renderAnnotationMutationSectors>;
  } {
    return {
      ...getDebugSnapshotFn(this.annotationSnapshotSources()),
      annotationMutationSectors: this.mutationSectorReceipt,
    };
  }

  private annotationLayerTypesForPresentation(): string[] {
    return this.layoutState.annotationLayerTypesForPresentation();
  }

  private compiledBroadSurfacePresentingLayerTypes(): string[] {
    return this.compiledBroad.compiledBroadSurfacePresentingLayerTypes();
  }

  private prepackedAnnotationScenePresentingResidents(): ResidentPrepackedAnnotationScene[] {
    return this.prepacked.prepackedAnnotationScenePresentingResidents();
  }

  hitTest(
    screenX: number,
    screenY: number,
    path: PathMapper,
    _state: RenderState
  ): OverlayHitResult | null {
    return this.hits.hitTest(screenX, screenY, path);
  }

  private hitTestHost(): AnnotationHitTestHost {
    return this.hits;
  }

  private hitTestCompiledBroadAnnotationInteraction(
    screenX: number,
    screenY: number,
    path: PathMapper,
    presentationLayerTypes: readonly string[]
  ): OverlayHitResult | null {
    return this.hits.hitTestCompiledBroadAnnotationInteraction(
      screenX,
      screenY,
      path,
      presentationLayerTypes
    );
  }

  private hitTestPrepackedAnnotationScene(
    screenX: number,
    screenY: number,
    path: PathMapper,
    explicitPresentationLayerTypes?: readonly string[]
  ): OverlayHitResult | null {
    return this.hits.hitTestPrepackedAnnotationScene(
      screenX,
      screenY,
      path,
      explicitPresentationLayerTypes
    );
  }

  private hitTestPrepackedAnnotationResident(
    resident: ResidentPrepackedAnnotationScene,
    screenX: number,
    screenY: number,
    path: PathMapper,
    trackOffsetPx: number
  ): OverlayHitResult | null {
    return this.hits.hitTestPrepackedAnnotationResident(
      resident,
      screenX,
      screenY,
      path,
      trackOffsetPx
    );
  }

  private recordPrepackedAnnotationInteraction(
    visitedNodes: number,
    primitiveCandidates: number,
    durationMs: number
  ): void {
    this.hits.recordPrepackedAnnotationInteraction(visitedNodes, primitiveCandidates, durationMs);
  }

  private prepackedAnnotationInteractionP99Ms(): number {
    return this.hits.prepackedAnnotationInteractionP99Ms();
  }

  private hitTestRetainedOverview(
    screenX: number,
    screenY: number,
    path: PathMapper
  ): OverlayHitResult | null {
    return this.hits.hitTestRetainedOverview(screenX, screenY, path);
  }

  private hitTestRetainedLinearTranscripts(
    screenX: number,
    screenY: number,
    path: PathMapper
  ): OverlayHitResult | null {
    return this.hits.hitTestRetainedLinearTranscripts(screenX, screenY, path);
  }

  getChangeDecorationSnapshot(): { commandCount: number; featureIds: readonly number[] } {
    return {
      commandCount: this.outlines.lastChangeDecorationCommandCount,
      featureIds: this.outlines.lastChangeDecorationFeatureIds,
    };
  }

  destroy(): void {
    this.mutationSectorGraphics.destroy();
    this.outlines.changeDecorationGraphics.destroy();
    this.retainedLinear.destroy();
  }
}

export { IndexedAnnotationOverlay as AnnotationOverlay };
