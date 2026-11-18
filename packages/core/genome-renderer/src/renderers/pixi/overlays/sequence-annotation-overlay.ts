import { CDS_GLYPH_STYLE, TRANSCRIPT_INTRON_STYLE } from '@waypoint/platform';
import { compoundCdsOutlineCommands } from './compound-cds-outline';
import { interactionOutlineStrokeStyle } from './indexed-annotation-draft-outlines';

import { Container, Graphics, Renderer, Text } from 'pixi.js';
import type {
  OverlayPosition,
  OverlayHitResult,
  RetainedOverlayCameraState,
  RetainedOverlayDebugSnapshot,
  RetainedOverlayTrack,
} from './overlay-track';
import type { PathMapper } from '../shared/path-mapper';
import type { UnifiedLayout } from '../shared/track-layout';
import { CurvedLabelRenderer, renderCurvedLabelOnPath } from '../shared/curved-label';
import { destroyPixiText } from '../shared/pixi-text-lifecycle';
import {
  ANNOTATION_BAR_HEIGHT,
  ANNOTATION_LANE_TOTAL,
  getAnnotationLaneEnvelope,
  resolveAnnotationTrackContract,
  type TrackContract,
} from '../shared/lane-contracts';
import { ARROW_HEIGHT_RATIO, ARROW_MAX_WIDTH, webglAnnotationColorForMode } from '../shared/theme';
import {
  PILL_LABEL_FONT_SIZE,
  measurePillLabelTextWidth,
  pillLabelTextColor,
  pillLabelTextStyle,
  targetPillLabelTextResolution,
  setPillLabelTheme,
} from '../shared/label-pill';
import { type HitRecord, pointInPolygon, computeBBox, transcriptHitTest } from './hit-testing';
import {
  createAnnotationBodyFrameAuthoritySnapshotV1,
  emptyAnnotationBodyPresenterEligibility,
  type AnnotationBodyFrameAuthoritySnapshotV1,
} from './annotation-body-presentation-authority';
import { genomeFeatures, type Feature, type Genome, type RenderState } from '../../../types';
import { assignFeatureLanes } from '../../../geometry/lane-assignment';
import { time as ptime } from '../../../perf-log';
import { isWebGLDiagnosticsEnabled } from '../../../diagnostics-gate';
import { isNonCodingTranscriptType, transcriptColorForMode } from '../../../feature-colors';
import {
  getColor as annotationFeatureGetColor,
  getThemedColor as annotationFeatureGetThemedColor,
  isOutlineOnlyFeature as annotationFeatureIsOutlineOnly,
  hasDraftOutline as annotationFeatureHasDraftOutline,
  stableSourceLaneAssignments as annotationFeatureStableSourceLaneAssignments,
  normalizeAnnotationLayerTypes as annotationFeatureNormalizeLayerTypes,
} from './annotation-feature-semantics';
import { isSplicedFeatureCached, isTranscriptCached } from '../shared/feature-splice-cache';
import { renderAnnotationChangeDecorations } from './indexed-annotation-change-decorations';
import { buildAnnotationMutationPaint } from './annotation-mutation-paint';
import {
  renderAnnotationMutationSectors,
  retainedAnnotationSectorOutline,
} from './annotation-mutation-sectors';
import { retainedOverviewHitCandidates } from './retained-overview-hit-index';
import {
  buildDirectionalPolygon as annotationBuildDirectionalPolygon,
  cdsLabelStripOutlineCommand as annotationCdsLabelStripOutlineCommand,
  flatPolygonToPolyline as annotationFlatPolygonToPolyline,
  lanePillOutlineCommand as annotationLanePillOutlineCommand,
  lerp as annotationLerp,
  type OutlineCommand,
} from './annotation-feature-geometry';
import {
  bestVisiblePolygonLabelCandidate as annotationBestVisiblePolygonLabelCandidate,
  truncateForWidth as annotationTruncateForWidth,
  visibleCenterFromPolygon as annotationVisibleCenterFromPolygon,
} from './annotation-label-geometry';

import {
  advanceBpByScreenWidth,
  laneRoundedPillPolygon,
  screenWidthToBp,
} from '../shared/lane-path';
import {
  getLabelOccupancyRecords,
  removeLabelOccupancyRecords,
  reserveLabelBounds,
} from '../shared/label-occupancy';
import { interactionOutlineStyle } from '../shared/interaction-outline';
import { drawDashedPolyline, type Point2 } from '../shared/dashed-line';
import {
  OVERVIEW_LOD_COMPRESSED_PIXELS_PER_BP,
  OVERVIEW_DENSITY_ATLAS_SAMPLE_SCREEN_PX,
  MIN_NARROW_FEATURE_PX,
  fullShapeOverviewAlphaScale,
  planImmediateAnnotationRender,
  planRetainedAnnotationRender,
  smoothstep,
} from './annotation-lod-policy';
import { planLinearImmediateAnnotationRender } from './linear-lod-policy';
import {
  buildTranscriptGlyphBlocks,
  getRetainedLinearTranscriptPackDebugSnapshot,
  type DirectionalBlock,
} from '../overview/retained-linear-transcript-layer';
import {
  retainedOverviewAnnotationStyle,
  retainedOverviewAnnotationsEnabled,
  stadiumRetainedCameraParams,
} from '../overview/retained-overview-style';
import { linearViewerRenderContract } from '../overview/viewer-render-contract';
import {
  RETAINED_SUBPIXEL_MIN_WIDTH_PX,
  retainedSubpixelAlphaScale,
} from '../overview/retained-subpixel-aa';
import {
  GraphicsPrimitiveSink,
  type FeaturePrimitiveSink,
} from '../overview/feature-primitive-sink';
import type {
  AnnotationOverlayColdGestureSnapshot,
  AnnotationOverlayDebugSnapshot,
  AnnotationOverlayPolicyReadinessSnapshotV1,
} from './annotation-overlay';
import {
  AnnotationOverviewCacheManager,
  type AnnotationOverviewCacheContext,
  type OverviewAggregationCache,
  type OverviewBin,
  type RetainedOverviewBodyRead,
  type RetainedOverviewPreparationReceipt,
} from './annotation-overview-cache';
import {
  SequenceRetainedLinearPresenter,
  RETAINED_TRANSCRIPT_KEY_CACHE_MIN_FEATURES,
} from './sequence-retained-linear-presenter';
import { SequenceImmediateDrawPresenter } from './sequence-immediate-draw-presenter';
import { FeatureWindowIndex } from '../shared/feature-window-index';
import {
  AnnotationInvariantViolationError,
  runAnnotationInvariantGuard,
  type AnnotationInvariantContext,
} from './annotation-invariants';
import {
  annotationDebugLayoutSnapshot,
  buildAnnotationPresentationDebug,
  type AnnotationPresentationDebugSnapshot,
} from './annotation-presentation-debug';
import {
  buildAnnotationDrawAudit,
  recordAnnotationDrawAuditDecision,
  type AnnotationDrawAuditDecision,
  type AnnotationDrawAuditSnapshot,
} from './annotation-draw-audit';
import { shouldRenderFeatureTextAtLod } from './feature-text-lod';
import {
  FloatingAnnotationLabelPresenter,
  type FloatingAnnotationLabelFrameReceipt,
} from './floating-annotation-label-presenter';
import { FLOATING_LABEL_TOP_RESERVE_PX } from './floating-annotation-label-layout';
export type { FloatingAnnotationLabelFrameReceipt } from './floating-annotation-label-presenter';

const CDS_LINE_HEIGHT = CDS_GLYPH_STYLE.replacementTopEdgeHeight;
const LABEL_FONT_SIZE = PILL_LABEL_FONT_SIZE;
const MIN_BAR_FOR_LABEL = 30;
const CURVED_BODY_FILL_RATIO = 0.5;

function polygonArea(pts: readonly number[]): number {
  let twiceArea = 0;
  const count = pts.length >> 1;
  for (let index = 0, previous = count - 1; index < count; previous = index, index += 1) {
    twiceArea += pts[previous * 2] * pts[index * 2 + 1] - pts[index * 2] * pts[previous * 2 + 1];
  }
  return Math.abs(twiceArea) / 2;
}
const ANNOTATION_BODY_WINDOW_MARGIN_PX = 64;
const ANNOTATION_SEARCH_FOCUS_DIM_COLOR = 0x6b7280;
const ANNOTATION_SEARCH_FOCUS_DIM_ALPHA = 0.72;

const RETAINED_TRANSCRIPT_DECORATION_MIN_PIXELS_PER_BP = 0.0005;
const RETAINED_TRANSCRIPT_DECORATION_FULL_PIXELS_PER_BP = 0.003;

const DECORATION_CACHE_MARGIN_VIEWPORTS = 1.5;
const DRAFT_OUTLINE_DASH_PX = 2;
const DRAFT_OUTLINE_GAP_PX = 2;

const RETAINED_OVERVIEW_BUILD_ONCE_MIN_VISIBLE_BP = 512_000;

const getColor = annotationFeatureGetColor;
const getThemedColor = annotationFeatureGetThemedColor;
const isOutlineOnlyFeature = annotationFeatureIsOutlineOnly;
const hasDraftOutline = annotationFeatureHasDraftOutline;

const isSplicedFeature = isSplicedFeatureCached;

const isTranscript = isTranscriptCached;
const stableSourceLaneAssignments = annotationFeatureStableSourceLaneAssignments;
const normalizeAnnotationLayerTypes = annotationFeatureNormalizeLayerTypes;
const flatPolygonToPolyline = annotationFlatPolygonToPolyline;
const buildDirectionalPolygon = annotationBuildDirectionalPolygon;
const visibleCenterFromPolygon = annotationVisibleCenterFromPolygon;
const truncateForWidth = annotationTruncateForWidth;
const bestVisiblePolygonLabelCandidate = annotationBestVisiblePolygonLabelCandidate;
const lerp = annotationLerp;

type AnnotationRenderKeyParts = Record<string, string>;

export const ANNOTATION_OVERLAY_COLD_GESTURE_SNAPSHOT_V1 =
  'annotation-overlay-cold-gesture-snapshot.v1' as const;

export const ANNOTATION_OVERLAY_POLICY_READINESS_SNAPSHOT_V1 =
  'annotation-overlay-policy-readiness-snapshot.v1' as const;

export interface AnnotationSearchFocusPresentationSnapshot {
  readonly annotationSearchFocusResolvedTrackId: string | null;
  readonly annotationSearchFocusResolvedCanonicalIdentity: string | null;
  readonly annotationSearchFocusPresentationLane: number | null;
}

export class SequenceAnnotationOverlay implements RetainedOverlayTrack {
  readonly id = 'annotations';
  readonly displayName = 'Annotations';
  readonly position: OverlayPosition = 'above';
  sortOrder = 100;
  hitTestOrder = 30;
  enabled = true;

  readonly layoutCacheKey = (): number => 0;
  private presentationVisible = true;

  readonly container = new Container();
  private graphics = new Graphics();
  private retainedTranscriptDecorationGraphics = new Graphics();
  private mutationSectorGraphics = new Graphics();
  private mutationPaint = buildAnnotationMutationPaint([], undefined, 0);
  private mutationSectorReceipt: ReturnType<typeof renderAnnotationMutationSectors> = {
    sectorCount: 0,
    samples: [],
  };
  private annotationBodyColors: ReadonlyMap<number, number> | undefined;
  private mutationPresentation: RenderState['sequencePresentation'];
  private mutationFeatures: readonly Feature[] | undefined;

  private decorationCacheKey = '';

  private decorationCacheAnchorViewStartBp = 0;
  private decorationCacheAnchorPpb = 0;
  private decorationCacheBuiltLoBp = 0;
  private decorationCacheBuiltHiBp = 0;

  private retainedTranscriptDecorationBuilds = 0;

  private annotationSearchFocusGraphics = new Graphics();
  private interactionGraphics = new Graphics();
  private changeDecorationGraphics = new Graphics();
  private changeDecorationCommandCount = 0;
  private changeDecorationFeatureIds: number[] = [];
  private curvedLabels: CurvedLabelRenderer;
  private floatingLabels: FloatingAnnotationLabelPresenter;
  private floatingLabelOutwardExtent = 0;
  private frameRequester: (() => void) | null = null;
  private labelPool: Text[] = [];
  private labelIndex = 0;

  private features: Feature[] = [];
  private annotationRequestedLayerTypes: string[] = [];

  private annotationExactCoverage: ReadonlyArray<{ startBp: number; endBp: number }> | null = null;
  private featureById = new Map<number, Feature>();
  private annotationColors: ReadonlyMap<number, number> | undefined;
  private featureWindowIndex = new FeatureWindowIndex({
    genomeLength: 0,
    circular: false,
    features: [],
  });
  private maxLane = 0;
  private genomeLength = 0;
  private genomeCircular = false;

  private hitCache: HitRecord[] = [];

  private lastInteractionOutlineCommandCount = 0;
  private lastInteractionContours: { featureId: number; points: number[] }[] = [];
  private annotationSearchFocusMaskDrawCount = 0;
  private annotationSearchFocusPrimitiveDrawCount = 0;
  private annotationSearchFocusResolvedTrackId: string | null = null;
  private annotationSearchFocusResolvedCanonicalIdentity: string | null = null;
  private annotationSearchFocusPresentationLane: number | null = null;

  private readonly overviewCache = new AnnotationOverviewCacheManager({
    maxResidentRetainedLevels: 12,
  });
  private retainedPreparationRefusal: string | null = null;
  private readonly retainedLinear = new SequenceRetainedLinearPresenter({
    container: this.container,
    features: () => this.features,
    genomeLength: () => this.genomeLength,
    featuresInRange: (startBp, endBp) => this.featuresInRange(startBp, endBp),
    clearDrawState: () => this.clearDrawState(),
    clearDecorationCache: () => this.clearDecorationCache(),
    resetDecorationBookkeeping: () => {
      this.retainedTranscriptDecorationBuilds = 0;
      this.decorationCacheKey = '';
      this.decorationCacheAnchorViewStartBp = 0;
      this.decorationCacheAnchorPpb = 0;
      this.decorationCacheBuiltLoBp = 0;
      this.decorationCacheBuiltHiBp = 0;
      this.retainedTranscriptDecorationGraphics.position.x = 0;
    },
    resetOverviewLodBlendStats: () => {
      this.retainedLinear.lastOverviewLodCompressionBlend = 0;
      this.retainedLinear.lastOverviewLodFullShapeBlend = 1;
      this.retainedLinear.lastOverviewCacheMs = 0;
      this.retainedLinear.lastOverviewImmediateBlendMs = 0;
    },
  });

  getRetainedLinearPresenterForTest(): SequenceRetainedLinearPresenter {
    return this.retainedLinear;
  }

  private readonly immediateDraw = new SequenceImmediateDrawPresenter({
    featureBodyColor: (feature) => this.annotationBodyColors?.get(feature.id),
    graphics: () => this.graphics,
    curvedLabels: () => this.curvedLabels,
    hitCache: () => this.hitCache,
    genomeLength: () => this.genomeLength,
    genomeCircular: () => this.genomeCircular,
    featureOffset: (feature) => this.featureOffset(feature),
    scaledBarHeight: () => this.scaledBarHeight(),
    scaledCdsLineHeight: () => this.scaledCdsLineHeight(),
    directionalArrowWidth: (pixelWidth, barHeight) =>
      this.directionalArrowWidth(pixelWidth, barHeight),
    cdsDetailProgress: () => this.cdsDetailProgress(),
    cdsExonLabelAlpha: () => this.cdsExonLabelAlpha(),
    overviewLabelAlpha: () => this.overviewLabelAlpha(),
    acquireLabel: () => this.acquireLabel(),
    strokeOutlineCommands: (g, path, commands, color, alpha) =>
      this.strokeOutlineCommands(g, path, commands, color, alpha),
    strokeLanePill: (g, path, startBp, widthPx, offset, halfHeight, color, alpha) =>
      this.strokeLanePill(g, path, startBp, widthPx, offset, halfHeight, color, alpha),
    transcriptViewportBounds: (path) => this.transcriptViewportBounds(path),
    transcriptIntronGapRanges: (feature, path) => this.transcriptIntronGapRanges(feature, path),
    transcriptIntronLineOutlineCommands: (feature, path, offset) =>
      this.transcriptIntronLineOutlineCommands(feature, path, offset),
    renderCurvedLabel: (
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
    ) =>
      this.renderCurvedLabel(
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
      ),
    drawTranscriptIntronChevrons: (g, feature, path, state, alpha, clipRange) =>
      this.drawTranscriptIntronChevrons(g, feature, path, state, alpha, clipRange),
  });

  getImmediateDrawPresenterForTest(): SequenceImmediateDrawPresenter {
    return this.immediateDraw;
  }

  private get outlineCache() {
    return this.immediateDraw.outlineCache;
  }
  private set outlineCache(value) {
    this.immediateDraw.outlineCache = value;
  }
  private get labelCache() {
    return this.immediateDraw.labelCache;
  }
  private set labelCache(value) {
    this.immediateDraw.labelCache = value;
  }
  private get labelOccupancyCache() {
    return this.immediateDraw.labelOccupancyCache;
  }
  private set labelOccupancyCache(value) {
    this.immediateDraw.labelOccupancyCache = value;
  }
  private get lastDrawnFeatureCount() {
    return this.immediateDraw.lastDrawnFeatureCount;
  }
  private set lastDrawnFeatureCount(value) {
    this.immediateDraw.lastDrawnFeatureCount = value;
  }
  private get lastImmediateTranscriptDrawnCount() {
    return this.immediateDraw.lastImmediateTranscriptDrawnCount;
  }
  private set lastImmediateTranscriptDrawnCount(value) {
    this.immediateDraw.lastImmediateTranscriptDrawnCount = value;
  }
  private get lastImmediateDrawnLayerTypes() {
    return this.immediateDraw.lastImmediateDrawnLayerTypes;
  }
  private currentGenomeIdentity = '';

  private _layout: UnifiedLayout | null = null;
  private _contract: TrackContract | null = null;
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
    this._layout = layout;
    this._contract = resolveAnnotationTrackContract({
      layout,
      maxAnnotationLane: effectiveEnvelope.maxAnnotationLane,
      maxCdsLane: effectiveEnvelope.maxCdsLane,
    });
    const floatingLayoutKey = [
      layout.annotationOffset,
      layout.annotationStep,
      layout.cdsBarOffset,
      layout.cdsLaneStep,
      effectiveEnvelope.maxAnnotationLane,
      effectiveEnvelope.maxCdsLane,
    ].join('|');
    this.floatingLabels.setLayoutKey(floatingLayoutKey);
  }

  private scaledBarHeight(): number {
    return ANNOTATION_BAR_HEIGHT;
  }

  private scaledCdsLineHeight(): number {
    return CDS_LINE_HEIGHT;
  }

  private scaledArrowMax(): number {
    return ARROW_MAX_WIDTH;
  }

  private directionalArrowWidth(pixelWidth: number, barHeight: number): number {
    return Math.min(barHeight * ARROW_HEIGHT_RATIO, pixelWidth * 0.3, this.scaledArrowMax());
  }

  private cdsTransitionHalfHeight(detailProgress: number): number {
    const heightProgress = smoothstep(0, 0.85, detailProgress);
    return lerp(this.scaledBarHeight() / 2, this.scaledCdsLineHeight() / 2, heightProgress);
  }

  getFeatureRenderOffset(feature: Feature): number | null {
    if (!this._layout) return null;
    return this.featureOffset(feature);
  }

  private featureOffset(feature: Feature): number {
    const L = this._layout;
    if (L) {
      const contracted = this.featureEnvelope(feature);
      if (!contracted) {
        throw new Error(
          `Annotation lane contract missing ${feature.type} lane ${feature.type === 'CDS' ? (feature.cdsLane ?? feature.lane ?? 0) : feature.lane}`
        );
      }
      return contracted.centerOffset;
    }

    return -14;
  }

  private featureEnvelope(feature: Feature) {
    if (!this._contract) return null;
    const laneIndex =
      feature.type === 'CDS' ? (feature.cdsLane ?? feature.lane ?? 0) : feature.lane;
    return getAnnotationLaneEnvelope(this._contract, feature.type, laneIndex);
  }

  private featurePixelWidth(feature: Feature, path: PathMapper): number {
    const featureLen =
      feature.end > feature.start
        ? feature.end - feature.start
        : this.genomeLength - feature.start + feature.end;
    return featureLen * path.pixelsPerBp;
  }

  private retainedLinearTranscriptLayoutKey(state: RenderState): string {
    const L = this._layout;
    if (!L) return `no-layout|h:${state.height}`;
    return [
      `h:${state.height}`,
      `ao:${L.annotationOffset}`,
      `as:${L.annotationStep}`,
      `co:${L.cdsBarOffset}`,
      `cs:${L.cdsLaneStep}`,
    ].join('|');
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
    return buildAnnotationDrawAudit({
      frameId: ++this.retainedLinear.drawAuditFrameId,
      renderMode: this.retainedLinear.lastRenderMode,
      path,
      state,
      featureCount: this.features.length,
      renderSetFeatureCount: featuresToRender.length,
      renderSetLayerTypes: this.renderSetLayerTypesForAudit(featuresToRender),
      maxAnnotationLane: this.maxAnnotationLane,
      maxCdsLane: this.maxCdsLane,
      layout: this._layout,
      overviewAggregationEnabled: useOverviewAggregation,
      overviewCache: overviewCache
        ? {
            binBp: overviewCache.binBp,
            binCount: overviewCache.bins.length,
            passthroughFeatureCount: overviewCache.passthroughFeatures.length,
            diagnostics: overviewCache.diagnostics,
          }
        : null,
      overviewCacheHit: this.retainedLinear.lastOverviewAggregationCacheHit,
      overviewBudgetExceeded: this.retainedLinear.lastOverviewDensityAtlasBudgetExceeded,
    });
  }

  private beginDrawAuditIfDiagnosticsEnabled(
    path: PathMapper,
    state: RenderState,
    featuresToRender: readonly Feature[],
    useOverviewAggregation: boolean,
    overviewCache: Parameters<SequenceAnnotationOverlay['beginDrawAudit']>[4]
  ): AnnotationDrawAuditSnapshot | null {
    if (!isWebGLDiagnosticsEnabled()) return null;
    return this.beginDrawAudit(
      path,
      state,
      featuresToRender,
      useOverviewAggregation,
      overviewCache
    );
  }

  private renderSetLayerTypesForAudit(featuresToRender: readonly Feature[]): string[] {
    if (featuresToRender.length === 0) return [];
    if (featuresToRender.length < RETAINED_TRANSCRIPT_KEY_CACHE_MIN_FEATURES) {
      return normalizeAnnotationLayerTypes(
        featuresToRender.map((feature) => feature.annotationTrackId ?? feature.type)
      );
    }
    return this.annotationLayerTypesForPresentation();
  }

  private recordDrawAuditDecision(
    audit: AnnotationDrawAuditSnapshot,
    feature: Feature,
    decision: AnnotationDrawAuditDecision,
    path: PathMapper
  ): void {
    recordAnnotationDrawAuditDecision(audit, {
      id: feature.id,
      type: feature.type,
      start: feature.start,
      end: feature.end,
      lane: feature.lane,
      cdsLane: feature.cdsLane ?? null,
      pixelWidth: this.featurePixelWidth(feature, path),
      decision,
    });
  }

  private syncAnnotationColors(state: RenderState): void {
    const presentation = state.sequencePresentation;
    const colors = presentation?.annotationColors;
    if (
      colors === this.annotationColors &&
      presentation === this.mutationPresentation &&
      this.features === this.mutationFeatures
    )
      return;
    this.annotationColors = colors;
    this.mutationPresentation = presentation;
    this.mutationFeatures = this.features;
    this.mutationPaint = buildAnnotationMutationPaint(
      this.features,
      presentation,
      this.genomeLength
    );
    this.annotationBodyColors = this.mutationPaint.size
      ? new Map([
          ...(colors ?? []),
          ...[...this.mutationPaint].map(([id, paint]) => [id, paint.baseColor] as const),
        ])
      : colors;
    this.retainedLinear.lastRenderKey = '';
    this.clearDecorationCache();
  }

  private cdsDetailProgress(): number {
    if (!this._layout) return 1;
    return Math.max(0, Math.min(1, this._layout.sequenceRevealProgress));
  }

  private cdsExonLabelAlpha(): number {
    if (!this._layout) return 1;
    if (!this._layout.sequenceVisible) return 0;
    return Math.max(0, Math.min(1, this._layout.sequenceOpacity ?? 1));
  }

  private overviewLaneScale(): number {
    return Math.max(
      0,
      Math.min(1, this._layout?.laneGeometryScale ?? this._layout?.overviewLaneScale ?? 1)
    );
  }

  private overviewLabelAlpha(): number {
    return smoothstep(0.7, 0.95, this.overviewLaneScale());
  }

  private renderKeyParts(state: RenderState): AnnotationRenderKeyParts {
    const revealProgress = this._layout?.sequenceRevealProgress ?? 0;
    const sequenceOpacity = this._layout?.sequenceOpacity ?? 0;
    const overviewLaneScale = this._layout?.overviewLaneScale ?? 1;
    const laneGeometryScale = this._layout?.laneGeometryScale ?? overviewLaneScale;
    return {
      zoom: `${state.zoom}`,
      viewOffset: `${state.viewOffset}`,
      morph: `${state.morph}`,
      width: `${state.width}`,
      height: `${state.height}`,
      geometryHeight: `${state.geometryHeight ?? state.height}`,
      themeMode: state.themeMode ?? 'light',
      sequenceVisible: this._layout?.sequenceVisible ? '1' : '0',
      sequenceRevealProgress: `${revealProgress}`,
      sequenceOpacity: `${sequenceOpacity}`,
      overviewLaneScale: `${overviewLaneScale}`,
      laneGeometryScale: `${laneGeometryScale}`,
      overviewStyle: retainedOverviewAnnotationStyle(),

      floatingLabelPlan: `${this.floatingLabels.frame.assignmentPlanRevision}`,
    };
  }

  private renderKeyFromParts(parts: AnnotationRenderKeyParts): string {
    return [
      parts.zoom,
      parts.viewOffset,
      parts.morph,
      parts.width,
      parts.height,
      parts.geometryHeight,
      parts.themeMode,
      parts.sequenceVisible,
      parts.sequenceRevealProgress,
      parts.sequenceOpacity,
      parts.overviewLaneScale,
      parts.laneGeometryScale,
      parts.overviewStyle,
      parts.floatingLabelPlan,
    ].join('|');
  }

  private renderKeyChangeReasons(next: AnnotationRenderKeyParts): string[] {
    if (!this.retainedLinear.lastRenderKeyParts) return ['initial'];
    const reasons: string[] = [];
    for (const [key, value] of Object.entries(next)) {
      if (this.retainedLinear.lastRenderKeyParts[key] !== value) reasons.push(key);
    }
    return reasons;
  }

  private resetRenderStats(): void {
    this.retainedLinear.renderCallCount = 0;
    this.retainedLinear.geometryRebuildCount = 0;
    this.retainedLinear.geometryCacheHitCount = 0;
    this.retainedLinear.lastRenderMode = 'none';
    this.retainedLinear.lastRenderKeyParts = null;
    this.retainedLinear.lastGeometryRebuildReasons = [];
    this.retainedLinear.lastDrawAudit = null;
    this.resetImmediateDrawStats();
    this.retainedLinear.lastOverviewAggregationEnabled = false;
    this.retainedLinear.lastOverviewAggregationCacheHit = false;
    this.retainedLinear.lastOverviewPassthroughFeatureCount = 0;
    this.retainedLinear.lastOverviewDensityAtlasBinBp = 0;
    this.retainedLinear.lastOverviewDensityAtlasLevelCount = 0;
    this.retainedLinear.lastOverviewDensityAtlasEstimatedBinCount = 0;
    this.retainedLinear.lastOverviewDensityAtlasWasCoarsened = false;
    this.retainedLinear.lastOverviewDensityAtlasBudgetExceeded = false;
    this.retainedLinear.lastOverviewLodCompressionBlend = 0;
    this.retainedLinear.lastOverviewLodFullShapeBlend = 1;
    this.retainedLinear.lastOverviewCacheMs = 0;
    this.retainedLinear.lastOverviewImmediateBlendMs = 0;
  }

  private resetImmediateDrawStats(): void {
    this.immediateDraw.resetImmediateDrawStats();
  }

  constructor() {
    this.container.eventMode = 'none';
    this.container.addChild(this.graphics);

    this.container.addChild(this.retainedTranscriptDecorationGraphics);
    this.container.addChild(this.mutationSectorGraphics);
    this.curvedLabels = new CurvedLabelRenderer(this.container);
    this.floatingLabels = new FloatingAnnotationLabelPresenter({
      container: this.container,
      features: () => this.features,
      featureForId: (featureId) => this.featureById.get(featureId),
      candidatesForPath: (path, preloadMargin) =>
        this.featureWindowIndex.candidatesForPath(path, this.features, preloadMargin, {
          forceWindowing: true,
        }),
      featuresInRange: (startBp, endBp) => this.featuresInRange(startBp, endBp),
      genomeLength: () => this.genomeLength,
      genomeCircular: () => this.genomeCircular,
      featureOffset: (feature) => this.featureOffset(feature),
      barHeight: () => this.scaledBarHeight(),
      cdsDetailProgress: () => this.cdsDetailProgress(),
      shouldRenderFeatureText: (path) => this.shouldRenderFeatureText(path),
      overviewLabelAlpha: () => this.overviewLabelAlpha(),
      clearCalloutRecords: (state) => {
        for (let index = this.hitCache.length - 1; index >= 0; index -= 1) {
          if (this.hitCache[index].kind === 'annotation-callout') this.hitCache.splice(index, 1);
        }
        this.labelOccupancyCache = this.labelOccupancyCache.filter(
          (record) => record.kind !== 'annotation-callout'
        );
        removeLabelOccupancyRecords(state, (record) => record.kind === 'annotation-callout');
      },
      bodyObstacles: () =>
        this.hitCache.map(({ id, kind, xMin, xMax, yMin, yMax }) => ({
          xMin,
          xMax,
          yMin,
          yMax,
          owner: `body:${id}`,
          featureId: kind === 'annotation-callout' ? undefined : id,
        })),
      bodyOutlineLookup: () => {
        const cache = new Map<object, number[][] | null>();
        return (obstacle) => {
          if (obstacle.featureId === undefined) return null;
          let outlines = cache.get(obstacle);
          if (outlines === undefined) {
            outlines = this.currentBodyOutlines(
              obstacle.featureId,
              obstacle.xMin,
              obstacle.xMax,
              obstacle.yMin,
              obstacle.yMax
            );
            cache.set(obstacle, outlines);
          }
          return outlines;
        };
      },
      labelObstacles: (state) =>
        getLabelOccupancyRecords(state).map(
          ({ xMin, xMax, yMin, yMax, kind, featureId }, index) => ({
            xMin,
            xMax,
            yMin,
            yMax,
            owner: `occupancy:${kind}:${featureId ?? index}`,
          })
        ),
      requestFrame: () => this.frameRequester?.(),
      outwardLaneExtentPx: () => this.floatingLabelOutwardExtent,
      recordCallout: (state, record) => {
        const feature = this.featureById.get(record.featureId);
        this.hitCache.push({
          id: record.featureId,
          kind: 'annotation-callout',
          start: feature?.start ?? 0,
          end: feature?.end ?? 0,
          pts: [],
          ...record.bounds,
        });
        reserveLabelBounds(
          state,
          record.bounds,
          {
            kind: 'annotation-callout',
            featureId: record.featureId,
            text: record.text,
          },
          { force: true }
        );
        this.labelOccupancyCache.push({
          ...record.bounds,
          kind: 'annotation-callout',
          featureId: record.featureId,
          text: record.text,
        });
      },
    });

    this.container.addChild(this.annotationSearchFocusGraphics);
    this.container.addChild(this.changeDecorationGraphics);
    this.container.addChild(this.interactionGraphics);
  }

  setFrameRequester(requester: (() => void) | null): void {
    this.frameRequester = requester;
  }

  setFloatingLabelLeadersVisibleForTests(visible: boolean): void {
    this.floatingLabels.setLeadersVisibleForTests(visible);
  }

  getAnnotationPolicyReadinessSnapshot(): AnnotationOverlayPolicyReadinessSnapshotV1 {
    const presentation = this.buildPresentationDebugSnapshot();
    return Object.freeze({
      contract: ANNOTATION_OVERLAY_POLICY_READINESS_SNAPSHOT_V1,
      annotationPresentationOwnerViolations: presentation.annotationPresentationOwnerViolations,
      annotationPresentationLayerTypes: presentation.annotationPresentationLayerTypes,
      annotationPresentationOwners: presentation.annotationPresentationOwners,
      prebuiltGenomeWideTextureLoaded: false,
      prebuiltGenomeWideTextureContractMatch: false,
      prebuiltGenomeWideTextureSourceMatch: false,
      prebuiltGenomeWideTexturePlacementMatch: false,
      prebuiltGenomeWideTexturePlacementFingerprint: null,
      prebuiltGenomeWideTextureLayerTypes: Object.freeze([]),
      prebuiltGenomeWideTextureVisible: false,
      prebuiltGenomeWideTextureEligible: false,
      compiledBroad: null,
    });
  }

  setRenderer(_renderer: Renderer | null): void {}

  private commitAnnotationLaneEnvelope(maxAnnotationLane: number, maxCdsLane: number): void {
    const maxLane = Math.max(maxAnnotationLane, maxCdsLane);
    const contract = this._layout
      ? resolveAnnotationTrackContract({
          layout: this._layout,
          maxAnnotationLane,
          maxCdsLane,
        })
      : this._contract;
    this.maxAnnotationLane = maxAnnotationLane;
    this.maxCdsLane = maxCdsLane;
    this.maxLane = maxLane;
    this._contract = contract;
  }

  private reconcileAnnotationLaneEnvelopeAuthority(): void {
    this.commitAnnotationLaneEnvelope(this.sourceMaxAnnotationLane, this.sourceMaxCdsLane);
  }

  reconcileAnnotationLaneEnvelopeForFrame(): void {
    this.reconcileAnnotationLaneEnvelopeAuthority();
  }

  getAnnotationBodyPresentationAuthoritySnapshot(): AnnotationBodyFrameAuthoritySnapshotV1 {
    return createAnnotationBodyFrameAuthoritySnapshotV1({
      commitEpoch: 0,
      eligibility: emptyAnnotationBodyPresenterEligibility(),
      generation: null,
      frameOwner: 'none',
    });
  }

  releaseRetiredGpuResourcesAfterPresent(_force = false): void {}

  setPresentationVisible(visible: boolean): void {
    if (this.presentationVisible === visible) return;
    this.presentationVisible = visible;
    if (!visible) {
      this.hideAllPresentationSurfaces();
      this.retainedLinear.lastDrawAudit = null;
    }
  }

  private currentBodyOutlines(
    featureId: number,
    xMin: number,
    xMax: number,
    yMin: number,
    yMax: number
  ): number[][] | null {
    const polygons: number[][] = [];
    for (const command of this.outlineCache.get(featureId) ?? []) {
      if (command.kind !== 'poly' || command.pts.length < 6) continue;
      const bounds = computeBBox(command.pts);
      if (
        bounds.xMin < xMin - 6 ||
        bounds.xMax > xMax + 6 ||
        bounds.yMin < yMin - 6 ||
        bounds.yMax > yMax + 6
      ) {
        return null;
      }
      polygons.push(command.pts);
    }
    if (polygons.length === 0) return null;
    const boxArea = Math.max(1e-9, (xMax - xMin) * (yMax - yMin));
    const filledArea = polygons.reduce((total, pts) => total + polygonArea(pts), 0);
    return filledArea / boxArea < CURVED_BODY_FILL_RATIO ? polygons : null;
  }

  setFloatingLabelOutwardExtent(extentPx: number): void {
    this.floatingLabelOutwardExtent = Number.isFinite(extentPx) ? Math.max(0, extentPx) : 0;
  }

  floatingLabelSideGutterPx(): number {
    return this.presentationVisible && this.features.length > 0
      ? this.floatingLabels.columnGutterPx
      : 0;
  }

  floatingLabelTopReservePx(): number {
    return this.presentationVisible && this.features.length > 0 ? FLOATING_LABEL_TOP_RESERVE_PX : 0;
  }

  private resetAllPresentersToHidden(): void {
    this.retainedLinear.resetAllPresentersToHidden();
    this.retainedTranscriptDecorationGraphics.visible = false;
    this.mutationSectorGraphics.visible = false;
  }

  private hideAllPresentationSurfaces(): void {
    this.resetAllPresentersToHidden();
    this.retainedLinear.retainedOverviewLayer?.hide();
    this.retainedLinear.retainedLinearFeatureLayer?.hide();
    this.retainedLinear.retainedLinearTranscriptLayer?.hide();
    this.clearDrawState();
    this.retainedLinear.retainedDrawStateClean = true;
    this.retainedLinear.immediateDrawStateClearedForRetained = true;
    this.resetImmediateDrawStats();
    this.retainedLinear.lastOverviewAggregationEnabled = false;
    this.retainedLinear.lastOverviewPassthroughFeatureCount = 0;
    this.retainedLinear.retainedOverviewMode = 'inactive';
    this.retainedLinear.retainedOverviewVisibleInstanceCount = 0;
    this.retainedLinear.retainedOverviewHitBins = [];
    this.retainedLinear.retainedOverviewPassthroughDrawn = false;
  }

  private renderHiddenPresentation(camera: RetainedOverlayCameraState): boolean {
    this.hideAllPresentationSurfaces();
    this.retainedLinear.renderCallCount += 1;
    this.retainedLinear.lastRenderMode = 'retained';
    this.retainedLinear.lastRenderKey = '';
    this.retainedLinear.lastRenderKeyParts = null;
    this.retainedLinear.lastGeometryRebuildReasons = [];
    this.retainedLinear.lastDrawAudit = this.beginDrawAuditIfDiagnosticsEnabled(
      camera.path,
      camera.state,
      [],
      false,
      null
    );
    this.renderInteractionOutlines(camera.path, camera.state);
    return true;
  }

  buildRetainedData(_genome: Genome): void {
    this.retainedLinear.retainedOverviewLayer?.resetData();
    this.retainedLinear.retainedLinearFeatureLayer?.resetData();
    this.retainedLinear.retainedLinearTranscriptLayer?.resetData();
    this.retainedLinear.retainedLinearTranscriptKey = '';
    this.retainedLinear.retainedLinearTranscriptFeatureSet = null;
    this.retainedLinear.retainedLinearTranscriptMembershipNeedsRebind = false;
    this.retainedLinear.retainedLinearSourceWindow = null;
    this.overviewCache.invalidate();
    this.retainedLinear.retainedOverviewHitBins = [];
    this.retainedLinear.retainedOverviewPassthroughDrawn = false;
    this.retainedLinear.resetRetainedOverviewDebug();
  }

  private renderImmediateShapesForLodTransition(
    path: PathMapper,
    state: RenderState,
    passthroughFeatures: Feature[],
    fullShapeBlend: number
  ): void {
    const passthroughIds = new Set(passthroughFeatures.map((feature) => feature.id));
    this.clearDrawState();
    this.retainedLinear.immediateDrawStateClearedForRetained = true;
    this.resetImmediateDrawStats();

    const sink: FeaturePrimitiveSink = new GraphicsPrimitiveSink(this.graphics, path);

    if (fullShapeBlend > 0.001) {
      for (const feature of this.features) {
        if (passthroughIds.has(feature.id)) continue;
        this.renderImmediateFeature(sink, feature, path, state, false, false, fullShapeBlend);
      }
    }

    for (const feature of passthroughFeatures) {
      this.renderImmediateFeature(sink, feature, path, state, false, false, 1);
    }

    this.retainedLinear.retainedOverviewPassthroughDrawn =
      passthroughFeatures.length > 0 || fullShapeBlend > 0.001;
  }

  private syncRetainedLinearOverviewLayers(
    path: PathMapper,
    state: RenderState,
    overviewCache: OverviewAggregationCache,
    featuresToRender: readonly Feature[]
  ): Set<Feature> | null {
    this.retainedLinear.retainedLinearTranscriptLayer?.setFeatureColors(this.annotationBodyColors);
    if (overviewCache.bins.length > 0) {
      const layer = this.retainedLinear.ensureRetainedLinearFeatureLayer();
      const key = `linear-feat|${overviewCache.key}|theme:${state.themeMode ?? 'light'}`;
      if (layer.syncData(key, overviewCache.bins, state.themeMode)) {
        this.retainedLinear.retainedLinearDataBuilds += 1;
        this.retainedLinear.retainedOverviewDataBuilds += 1;
      }
      layer.updateCamera(linearViewerRenderContract(path), state.width, state.height);
      layer.setAlpha(1);
      this.retainedLinear.retainedLinearBinCount = overviewCache.bins.length;
    } else {
      this.retainedLinear.retainedLinearFeatureLayer?.hide();
      this.retainedLinear.retainedLinearBinCount = 0;
    }

    const cdsDetail = this.cdsDetailProgress();
    const tKeyParts = [
      'linear-tx',
      `g:${this.genomeLength}`,
      `n:${this.features.length}`,
      `fs:${this.retainedLinear.retainedLinearTranscriptFeatureKey(featuresToRender)}`,
      `al:${this.maxAnnotationLane}`,
      `cl:${this.maxCdsLane}`,
      `th:${state.themeMode ?? 'light'}`,
      `layout:${this.retainedLinearTranscriptLayoutKey(state)}`,
    ];
    const tKey = tKeyParts.join('|');
    if (
      tKey === this.retainedLinear.retainedLinearTranscriptKey &&
      this.retainedLinear.retainedLinearTranscriptFeatureSet
    ) {
      if (this.retainedLinear.retainedLinearTranscriptMembershipNeedsRebind) {
        const reboundFeatureSet = new Set<Feature>();
        for (const feature of featuresToRender) {
          if (isTranscript(feature) && !isOutlineOnlyFeature(feature)) {
            reboundFeatureSet.add(feature);
          }
        }
        this.retainedLinear.retainedLinearTranscriptFeatureSet = reboundFeatureSet;
        this.retainedLinear.retainedLinearTranscriptVisibleFeatureCount = reboundFeatureSet.size;
        this.retainedLinear.retainedLinearTranscriptMembershipNeedsRebind = false;
      }
      this.retainedLinear.retainedLinearTranscriptLayer?.updateCamera(
        linearViewerRenderContract(path),
        state.width,
        state.height,
        cdsDetail
      );
      return this.retainedLinear.retainedLinearTranscriptFeatureSet.size > 0
        ? this.retainedLinear.retainedLinearTranscriptFeatureSet
        : null;
    }

    const transcripts: Feature[] = [];
    const batchedTranscriptSet = new Set<Feature>();
    for (const f of featuresToRender) {
      if (isTranscript(f) && !isOutlineOnlyFeature(f)) {
        batchedTranscriptSet.add(f);
        transcripts.push(f);
      }
    }

    if (transcripts.length === 0 && this.retainedLinear.retainedLinearTranscriptBlockCount > 0) {
      this.retainedLinear.retainedLinearTranscriptStaleHolds += 1;
      this.retainedLinear.retainedLinearTranscriptLayer?.updateCamera(
        linearViewerRenderContract(path),
        state.width,
        state.height,
        cdsDetail
      );
      return this.retainedLinear.retainedLinearTranscriptFeatureSet;
    }

    this.retainedLinear.retainedLinearTranscriptKey = tKey;
    this.retainedLinear.retainedLinearTranscriptFeatureSet = batchedTranscriptSet;
    this.retainedLinear.retainedLinearTranscriptMembershipNeedsRebind = false;
    this.retainedLinear.retainedLinearTranscriptVisibleFeatureCount = transcripts.length;

    if (transcripts.length === 0) {
      this.retainedLinear.retainedLinearTranscriptLayer?.hide();
      this.retainedLinear.retainedLinearTranscriptBlockCount = 0;
      return null;
    }

    const tLayer = this.retainedLinear.ensureRetainedLinearTranscriptLayer();
    const blocks = buildTranscriptGlyphBlocks(transcripts, {
      getFeatureId: (feature) => (feature as Feature).id,
      getOffset: (f) => {
        const env = this.featureEnvelope(f as Feature);
        return env ? env.centerOffset : null;
      },
      halfHeight: this.scaledBarHeight() / 2,
      themeMode: state.themeMode,
      cdsDetail,
    });
    if (tLayer.syncData(tKey, blocks)) {
      this.retainedLinear.retainedLinearTranscriptBuilds += 1;
      this.retainedLinear.retainedOverviewDataBuilds += 1;

      const prev = this.retainedLinear.retainedLinearTranscriptPrevKeyParts;
      if (prev) {
        const changed: string[] = [];
        for (let i = 0; i < tKeyParts.length; i += 1) {
          if (tKeyParts[i] !== prev[i]) changed.push(tKeyParts[i].split(':')[0] || `#${i}`);
        }
        this.retainedLinear.retainedLinearTranscriptLastBuildCause = changed.join(',') || 'first';
      } else {
        this.retainedLinear.retainedLinearTranscriptLastBuildCause = 'first';
      }
      this.retainedLinear.retainedLinearTranscriptPrevKeyParts = tKeyParts;
    }
    tLayer.setFeatureColors(this.annotationBodyColors);

    if (featuresToRender === this.features)
      this.retainedLinear.retainedLinearFullSetMeshResident = true;
    this.retainedLinear.retainedLinearTranscriptBlockCount = blocks.length;
    tLayer.updateCamera(linearViewerRenderContract(path), state.width, state.height, cdsDetail);

    this.runInvariantGuardAfterRetainedSync(transcripts, blocks.length, tKey, path);

    return batchedTranscriptSet;
  }

  private runInvariantGuardAfterRetainedSync(
    transcripts: Feature[],
    blockCount: number,
    transcriptKey: string,
    path: PathMapper
  ): void {
    const visibleFeatureCount = transcripts.length;
    if (visibleFeatureCount === 0) return;
    if (blockCount > 0) return;

    const sourceWindow = this.retainedLinear.retainedLinearSourceWindow;
    const samples = transcripts.slice(0, 5).map((f) => ({
      id: f.id,
      type: f.type,
      displayName: f.displayName,
      start: f.start,
      end: f.end,
      exonCount: f.exons?.length ?? 0,
      cdsCount: f.cds?.length ?? 0,
      laneResolved: this.featureEnvelope(f) !== null,
    }));
    const context: AnnotationInvariantContext = {
      visibleFeatureCount,
      blockCount,
      renderMode: 'retained',
      transcriptKey,
      sourceWindowStartBp: sourceWindow?.startBp ?? null,
      sourceWindowEndBp: sourceWindow?.endBp ?? null,
      viewStartBp: path.viewStartBp,
      viewEndBp: path.viewEndBp,
      transcriptSamples: samples,
    };
    const violation = runAnnotationInvariantGuard(context);
    if (!violation) return;

    if (
      typeof import.meta !== 'undefined' &&
      (import.meta as { env?: { MODE?: string } }).env?.MODE === 'test'
    ) {
      throw new AnnotationInvariantViolationError(
        violation.invariantId,
        violation.message,
        violation.context
      );
    }
    if (typeof console !== 'undefined' && typeof console.error === 'function') {
      console.error(`[${violation.invariantId}] ${violation.message}`, violation.context);
    }
  }

  private renderRetainedTranscriptDecorations(
    batchedTranscriptSet: ReadonlySet<Feature> | null,
    path: PathMapper,
    state: RenderState,
    sourceFeatures: readonly Feature[] = this.features
  ): void {
    const g = this.retainedTranscriptDecorationGraphics;

    const ppb = path.pixelsPerBp;
    const minPpb = RETAINED_TRANSCRIPT_DECORATION_MIN_PIXELS_PER_BP;
    const fullPpb = RETAINED_TRANSCRIPT_DECORATION_FULL_PIXELS_PER_BP;
    const lodAlpha = ppb >= fullPpb ? 1 : ppb <= minPpb ? 0 : (ppb - minPpb) / (fullPpb - minPpb);

    const batchedSet =
      batchedTranscriptSet && batchedTranscriptSet.size > 0 && lodAlpha > 0
        ? batchedTranscriptSet
        : null;
    if (!batchedSet) {
      g.clear();
      g.visible = false;
      g.position.x = 0;
      this.decorationCacheKey = '';
      this.retainedLinear.lastRetainedTranscriptDecorationsDrawn = false;
      return;
    }
    this.retainedLinear.lastRetainedTranscriptDecorationsDrawn = true;

    const decorationAlpha = 0.85 * lodAlpha;
    const cacheKey = this.decorationCacheKeyFor(batchedSet, ppb, state);

    const viewStartBp = path.viewStartBp;
    const viewEndBp = path.viewEndBp;
    const ppbMatches = ppb === this.decorationCacheAnchorPpb;
    const insideBuilt =
      viewStartBp >= this.decorationCacheBuiltLoBp && viewEndBp <= this.decorationCacheBuiltHiBp;
    if (cacheKey !== '' && cacheKey === this.decorationCacheKey && ppbMatches && insideBuilt) {
      g.position.x = (this.decorationCacheAnchorViewStartBp - viewStartBp) * ppb;
      g.visible = true;
      return;
    }

    g.clear();
    g.visible = true;
    g.position.x = 0;
    const span = Math.max(1, viewEndBp - viewStartBp);
    const margin = span * DECORATION_CACHE_MARGIN_VIEWPORTS;
    const clipRange = { lo: viewStartBp - margin, hi: viewEndBp + margin };

    const buildCandidates =
      sourceFeatures === this.features
        ? this.featuresInRange(clipRange.lo, clipRange.hi)
        : sourceFeatures.filter(
            (feature) => feature.start < clipRange.hi && feature.end > clipRange.lo
          );

    for (const feature of buildCandidates) {
      if (!batchedSet.has(feature)) continue;
      this.drawRetainedTranscriptIntronConnectors(
        g,
        feature,
        path,
        state,
        decorationAlpha,
        clipRange
      );
      this.drawTranscriptIntronChevrons(g, feature, path, state, decorationAlpha, clipRange);
    }

    this.decorationCacheKey = cacheKey;
    this.decorationCacheAnchorViewStartBp = viewStartBp;
    this.decorationCacheAnchorPpb = ppb;
    this.decorationCacheBuiltLoBp = clipRange.lo;
    this.decorationCacheBuiltHiBp = clipRange.hi;
    this.retainedTranscriptDecorationBuilds += 1;
  }

  private decorationCacheKeyFor(
    batchedTranscriptSet: ReadonlySet<Feature>,
    ppb: number,
    state: RenderState
  ): string {
    return [
      'chev',

      `bn:${batchedTranscriptSet.size}`,
      `fs:${this.retainedLinear.retainedLinearTranscriptKey}`,

      `ppb:${ppb}`,
      `th:${state.themeMode ?? 'light'}`,
      `layout:${this.retainedLinearTranscriptLayoutKey(state)}`,
      `bh:${this.scaledBarHeight()}`,
    ].join('|');
  }

  private clearDecorationCache(): void {
    this.retainedTranscriptDecorationGraphics.clear();
    this.retainedTranscriptDecorationGraphics.position.x = 0;
    this.decorationCacheKey = '';
  }

  private updateRetainedLinearCamera(camera: RetainedOverlayCameraState): boolean {
    const handled = this.updateRetainedLinearCameraInner(camera);
    this.auditAnnotationDraw(camera.state);
    return handled;
  }

  private updateRetainedLinearCameraInner(camera: RetainedOverlayCameraState): boolean {
    const style = retainedOverviewAnnotationStyle();
    if (!retainedOverviewAnnotationsEnabled()) {
      return this.retainedLinear.retainedOverviewFallback('disabled');
    }
    if (style !== 'retained') {
      return this.retainedLinear.retainedOverviewFallback('unsupported-visual-state');
    }

    this.resetAllPresentersToHidden();

    const overviewVisibleBp = camera.path.viewEndBp - camera.path.viewStartBp;

    const immediatePlan = planLinearImmediateAnnotationRender(camera.path.pixelsPerBp);

    const retainedFeatures =
      overviewVisibleBp > RETAINED_OVERVIEW_BUILD_ONCE_MIN_VISIBLE_BP ||
      this.retainedLinear.retainedLinearFullSetMeshResident
        ? this.features
        : this.retainedLinear.retainedLinearSourceFeaturesForViewport(camera.path);

    let visibleFeaturesCache: readonly Feature[] | null = null;
    const getVisibleFeatures = (): readonly Feature[] =>
      (visibleFeaturesCache ??= this.featuresInRange(
        camera.path.viewStartBp,
        camera.path.viewEndBp
      ));
    const viewportHasMaterializedFeatures = this.hasFeaturesInRange(
      camera.path.viewStartBp,
      camera.path.viewEndBp
    );

    if (
      !viewportHasMaterializedFeatures &&
      this.retainedLinear.retainedLinearTranscriptBlockCount === 0
    ) {
      return this.retainedLinear.presentEmptyRetainedLinearViewport(style, {
        noteEmptyFrame: () => {
          this.retainedLinear.renderCallCount += 1;
          this.retainedLinear.lastRenderMode = 'retained';
          this.retainedLinear.lastRenderKey = '';
          this.retainedLinear.lastRenderKeyParts = null;
          this.retainedLinear.lastGeometryRebuildReasons = [];
          this.retainedLinear.lastOverviewAggregationEnabled = false;
          this.retainedLinear.lastOverviewPassthroughFeatureCount = 0;
          this.retainedLinear.lastOverviewDensityAtlasBinBp = 0;
          this.retainedLinear.lastOverviewDensityAtlasLevelCount = 0;
          this.retainedLinear.lastOverviewDensityAtlasEstimatedBinCount = 0;
          this.retainedLinear.lastOverviewDensityAtlasWasCoarsened = false;
          this.retainedLinear.lastOverviewDensityAtlasBudgetExceeded = false;
        },
        resetImmediateDrawStats: () => this.resetImmediateDrawStats(),
        beginDrawAudit: () => {
          this.retainedLinear.lastDrawAudit = this.beginDrawAuditIfDiagnosticsEnabled(
            camera.path,
            camera.state,
            [],
            false,
            null
          );
        },
        renderDecorations: () => {
          this.renderRetainedTranscriptDecorations(null, camera.path, camera.state);
          ptime('annotation.floating-labels', () =>
            this.floatingLabels.render(camera.path, camera.state)
          );
        },
        renderOutlines: () => this.renderInteractionOutlines(camera.path, camera.state),
      });
    }

    const sourceShapeCache: OverviewAggregationCache = {
      key: 'linear-source-shaped-full-shapes',
      binBp: 0,
      atlasLevelCount: 0,
      bins: [],

      passthroughFeatures: retainedFeatures as Feature[],
      diagnostics: {
        inputFeatureCount: retainedFeatures.length,
        skippedMinVisibleFeatureCount: 0,
        passthroughFeatureCount: retainedFeatures.length,
        aggregateWideFeatureCount: 0,
        aggregatedFeatureCount: 0,
        binContributionCount: 0,
      },
    };
    this.retainedLinear.renderCallCount += 1;
    this.retainedLinear.lastRenderMode = 'retained';
    this.retainedLinear.lastRenderKey = '';
    this.retainedLinear.lastRenderKeyParts = null;
    this.retainedLinear.lastGeometryRebuildReasons = [];
    this.resetImmediateDrawStats();
    this.retainedLinear.lastOverviewAggregationEnabled = false;
    this.retainedLinear.lastOverviewPassthroughFeatureCount = retainedFeatures.length;
    this.retainedLinear.overviewBinDrawCount = 0;
    this.retainedLinear.lastOverviewDensityAtlasBinBp = 0;
    this.retainedLinear.lastOverviewDensityAtlasLevelCount = 0;
    this.retainedLinear.lastOverviewDensityAtlasEstimatedBinCount = 0;
    this.retainedLinear.lastOverviewDensityAtlasWasCoarsened = false;
    this.retainedLinear.lastOverviewDensityAtlasBudgetExceeded = false;
    const drawAudit = this.beginDrawAudit(camera.path, camera.state, retainedFeatures, false, null);
    this.retainedLinear.lastDrawAudit = drawAudit;
    const batchedTranscriptSet = this.syncRetainedLinearOverviewLayers(
      camera.path,
      camera.state,
      sourceShapeCache,
      retainedFeatures
    );

    const overviewMeshCoversFullSet =
      retainedFeatures === this.features &&
      batchedTranscriptSet !== null &&
      batchedTranscriptSet.size >= this.features.length;
    const allVisibleFeaturesBatched =
      overviewMeshCoversFullSet ||
      (batchedTranscriptSet !== null &&
        getVisibleFeatures().every((feature) => batchedTranscriptSet.has(feature)));
    if (allVisibleFeaturesBatched) {
      if (!this.retainedLinear.retainedDrawStateClean) {
        this.clearDrawState();
        this.retainedLinear.retainedDrawStateClean = true;
      }
      this.retainedLinear.immediateDrawStateClearedForRetained = true;
      drawAudit.decisions['skipped-batched-transcript'] += batchedTranscriptSet?.size ?? 0;
    } else {
      this.clearDrawState();
      this.retainedLinear.retainedDrawStateClean = false;
      this.retainedLinear.immediateDrawStateClearedForRetained = true;
      this.graphics.visible = true;
      const sink: FeaturePrimitiveSink = new GraphicsPrimitiveSink(this.graphics, camera.path);
      for (const feature of getVisibleFeatures()) {
        if (batchedTranscriptSet?.has(feature)) {
          this.recordDrawAuditDecision(
            drawAudit,
            feature,
            'skipped-batched-transcript',
            camera.path
          );
          continue;
        }
        const decision = this.renderImmediateFeature(
          sink,
          feature,
          camera.path,
          camera.state,
          false,
          immediatePlan.forceTinyFeatureShapes
        );
        this.recordDrawAuditDecision(drawAudit, feature, decision, camera.path);
      }
    }
    this.renderRetainedTranscriptDecorations(
      batchedTranscriptSet,
      camera.path,
      camera.state,
      retainedFeatures
    );
    ptime('annotation.floating-labels', () =>
      this.floatingLabels.render(camera.path, camera.state)
    );
    drawAudit.drawnFeatureCount = this.lastDrawnFeatureCount;
    for (let i = this.labelIndex; i < this.labelPool.length; i++) {
      this.labelPool[i].visible = false;
    }
    return this.retainedLinear.finalizeRetainedImmediateLinearFrame(
      style,
      this.lastDrawnFeatureCount,
      () => this.renderInteractionOutlines(camera.path, camera.state)
    );
  }

  updateRetainedCamera(camera: RetainedOverlayCameraState): boolean {
    this.syncAnnotationColors(camera.state);
    setPillLabelTheme(camera.state.themeMode);
    if (!this.presentationVisible) {
      return this.renderHiddenPresentation(camera);
    }
    if (!camera.path.isArcMode) {
      return this.updateRetainedLinearCamera(camera);
    }

    const style = retainedOverviewAnnotationStyle();
    const plan = planRetainedAnnotationRender({
      enabled: retainedOverviewAnnotationsEnabled(),
      style,
      hasLayout: Boolean(this._layout),
      genomeLength: this.genomeLength,
      featureCount: this.features.length,
      isArcMode: camera.path.isArcMode,
      pixelsPerBp: camera.path.pixelsPerBp,
    });
    if (plan.kind === 'fallback') {
      return this.retainedLinear.retainedOverviewFallback(plan.reason);
    }

    const retainedCamera = stadiumRetainedCameraParams(camera.path);
    if (!retainedCamera) {
      return this.retainedLinear.retainedOverviewFallback('unsupported-mode');
    }

    const compressionBlend = plan.compressionBlend;
    const fullShapeBlend = plan.fullShapeBlend;
    const cacheContext = this.overviewCacheContext();
    this.retainedLinear.lastOverviewCacheMs = 0;
    this.retainedLinear.lastOverviewImmediateBlendMs = 0;
    this.retainedLinear.lastOverviewLodCompressionBlend = compressionBlend;
    this.retainedLinear.lastOverviewLodFullShapeBlend = fullShapeBlend;

    const retainedCacheStart = performance.now();
    const retainedRead = ptime('annotation.retained-overview-cache', () =>
      this.overviewCache.readRetainedOverviewBodyCache(
        {
          pixelsPerBp: Math.min(camera.path.pixelsPerBp, OVERVIEW_LOD_COMPRESSED_PIXELS_PER_BP),
        },
        cacheContext
      )
    );
    this.retainedLinear.lastOverviewCacheMs = performance.now() - retainedCacheStart;
    if (retainedRead.kind !== 'ready') {
      return this.retainedLinear.retainedOverviewFallback('budget-exceeded');
    }
    const retainedCache = retainedRead.cache;
    this.resetAllPresentersToHidden();
    this.retainedLinear.retainedLinearFeatureLayer?.hide();
    this.retainedLinear.retainedLinearTranscriptLayer?.hide();
    const retainedAtlasDiagnostics = this.overviewCache.retainedDensityAtlasDiagnostics();
    this.retainedLinear.lastOverviewDensityAtlasBinBp = retainedCache.binBp;
    this.retainedLinear.lastOverviewDensityAtlasSampleScreenPx =
      OVERVIEW_DENSITY_ATLAS_SAMPLE_SCREEN_PX;
    this.retainedLinear.lastOverviewDensityAtlasLevelCount = retainedCache.atlasLevelCount;
    this.retainedLinear.lastOverviewDensityAtlasEstimatedBinCount =
      retainedAtlasDiagnostics.estimatedBinCount;
    this.retainedLinear.lastOverviewDensityAtlasWasCoarsened =
      retainedAtlasDiagnostics.wasCoarsened;
    this.retainedLinear.lastOverviewDensityAtlasBudgetExceeded =
      retainedAtlasDiagnostics.budgetExceeded;
    this.retainedLinear.lastOverviewAggregationCacheHit = this.overviewCache.lastCacheHit;

    const layer = this.retainedLinear.ensureRetainedOverviewLayer();
    const synced = ptime('annotation.retained-overview-sync', () =>
      layer.syncData(
        `${retainedCache.key}|style:${plan.style}|theme:${camera.state.themeMode ?? 'light'}`,
        retainedCache.bins,
        plan.style,
        camera.state.themeMode
      )
    );
    if (synced) this.retainedLinear.retainedOverviewDataBuilds += 1;
    layer.updateCamera(retainedCamera);
    layer.setAlpha(compressionBlend);
    const retainedBlendStart = performance.now();

    ptime('annotation.retained-overview-blend', () =>
      this.renderImmediateShapesForLodTransition(
        camera.path,
        camera.state,
        retainedCache.passthroughFeatures,
        0
      )
    );
    this.retainedLinear.lastOverviewImmediateBlendMs = performance.now() - retainedBlendStart;

    this.retainedLinear.renderCallCount += 1;
    this.retainedLinear.lastRenderMode = 'retained';
    this.retainedLinear.lastRenderKey = '';
    this.retainedLinear.lastRenderKeyParts = null;
    this.retainedLinear.lastGeometryRebuildReasons = [];
    this.retainedLinear.lastOverviewAggregationEnabled = true;
    this.retainedLinear.lastOverviewPassthroughFeatureCount =
      retainedCache.passthroughFeatures.length;
    this.retainedLinear.overviewBinDrawCount = retainedCache.bins.length;
    this.retainedLinear.retainedOverviewMode = 'retained';
    this.retainedLinear.retainedOverviewStyle = plan.style;
    this.retainedLinear.retainedOverviewCameraUpdates += 1;
    this.retainedLinear.retainedOverviewFallbackReason = null;
    this.retainedLinear.retainedOverviewInstanceCount = layer.retainedInstanceCount;
    this.retainedLinear.retainedOverviewVisibleInstanceCount = layer.retainedInstanceCount;
    this.retainedLinear.retainedOverviewHitBins = retainedCache.bins;
    ptime('annotation.floating-labels', () =>
      this.floatingLabels.render(camera.path, camera.state)
    );
    this.renderInteractionOutlines(camera.path, camera.state);
    return true;
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
      supported: this.features.length > 0,
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
    if (this.features.length === 0) return 0;

    return Math.max(0, this.maxAnnotationLane + 1) * ANNOTATION_LANE_TOTAL;
  }

  maxAnnotationLane = 0;

  maxCdsLane = -1;

  private sourceMaxAnnotationLane = 0;
  private sourceMaxCdsLane = -1;

  loadGenome(genome: Genome): void {
    this.applyAnnotationGenome(genome);
  }

  getAnnotationPresentationFeatures(): ReadonlyArray<Feature> {
    return this.features;
  }

  selectResidentAnnotationFeaturesForViewport(
    _viewStartBp: number,
    _viewEndBp: number,
    _annotationSearchFocus: RenderState['annotationSearchFocus'] = null
  ): Readonly<{
    status: 'unavailable' | 'ready' | 'incomplete';
    key: string | null;
    features: ReadonlyArray<Feature>;
  }> {
    return { status: 'unavailable', key: null, features: this.features };
  }

  private applyAnnotationGenome(genome: Genome): void {
    const previousGenomeIdentity = this.currentGenomeIdentity;
    const nextGenomeIdentity = genome.sourceIdentity ?? genome.name;
    const streamingUpdate =
      previousGenomeIdentity === nextGenomeIdentity &&
      this.genomeLength === genome.length &&
      this.genomeCircular === genome.circular;
    this.currentGenomeIdentity = nextGenomeIdentity;
    this.features = genomeFeatures(genome);
    this.annotationRequestedLayerTypes = normalizeAnnotationLayerTypes(
      genome.annotationLayerTypes ?? this.features.map((feature) => feature.type)
    );
    this.annotationExactCoverage = genome.annotationExactCoverage
      ? genome.annotationExactCoverage.map((coverage) => ({ ...coverage }))
      : null;
    this.retainedLinear.retainedLinearFullSetMeshResident = false;
    this.featureById = new Map(this.features.map((feature) => [feature.id, feature]));
    this.featureWindowIndex = new FeatureWindowIndex({
      genomeLength: genome.length,
      circular: genome.circular,
      features: this.features,
    });
    this.genomeLength = genome.length;
    this.genomeCircular = genome.circular;
    this.clearDrawState();
    this.labelCache.clear();
    this.overviewCache.invalidate();
    this.retainedLinear.retainedOverviewHitBins = [];
    this.retainedLinear.retainedOverviewPassthroughDrawn = false;
    this.retainedLinear.lastRenderKey = '';
    this.resetRenderStats();
    this.retainedLinear.retainedOverviewLayer?.resetData();
    this.retainedLinear.retainedLinearFeatureLayer?.resetData();

    if (!streamingUpdate) {
      this.retainedLinear.retainedLinearTranscriptLayer?.resetData();
      this.retainedLinear.retainedLinearTranscriptKey = '';
      this.retainedLinear.retainedLinearTranscriptFeatureSet = null;
      this.retainedLinear.retainedLinearTranscriptMembershipNeedsRebind = false;
    } else if (this.retainedLinear.retainedLinearTranscriptFeatureSet !== null) {
      this.retainedLinear.retainedLinearTranscriptMembershipNeedsRebind = true;
    }

    this.retainedLinear.retainedLinearSourceWindow = null;

    this.retainedLinear.resetRetainedOverviewDebug({ preserveTranscriptMesh: streamingUpdate });

    const nonCds = this.features.filter((f) => f.type !== 'CDS');
    const cds = this.features.filter((f) => f.type === 'CDS');

    const annLanes = ptime(
      'assignFeatureLanes.nonCds',
      () =>
        stableSourceLaneAssignments(nonCds) ??
        assignFeatureLanes(nonCds, genome.length).laneAssignments,
      { count: nonCds.length }
    );
    for (const [idx, lane] of annLanes) {
      nonCds[idx].lane = lane;
    }
    const cdsLaneMap = ptime(
      'assignFeatureLanes.cds',
      () =>
        stableSourceLaneAssignments(cds) ?? assignFeatureLanes(cds, genome.length).laneAssignments,
      { count: cds.length }
    );
    for (const [idx, lane] of cdsLaneMap) {
      cds[idx].lane = lane;
      cds[idx].cdsLane = lane;
    }

    this.sourceMaxAnnotationLane = -1;
    for (const f of nonCds) {
      if (f.lane > this.sourceMaxAnnotationLane) this.sourceMaxAnnotationLane = f.lane;
    }
    this.sourceMaxCdsLane = -1;
    for (const f of cds) if (f.lane > this.sourceMaxCdsLane) this.sourceMaxCdsLane = f.lane;
    if (genome.annotationLayout) {
      this.sourceMaxAnnotationLane = genome.annotationLayout.maxAnnotationLane;
      this.sourceMaxCdsLane = genome.annotationLayout.maxCdsLane;
    }
    this.reconcileAnnotationLaneEnvelopeAuthority();

    this.featuresSortedByStart = [...this.features]
      .filter((f) => Number.isFinite(f.start))
      .sort((a, b) => a.start - b.start);
    this.circularWrappedFeatures = this.genomeCircular
      ? this.features.filter((feature) => feature.start > feature.end)
      : [];
    this.maxFeatureLenBp = this.features.reduce((max, f) => {
      const len = f.end > f.start ? f.end - f.start : genome.length - f.start + f.end;
      return len > max ? len : max;
    }, 0);
    this.floatingLabels.loadGenome();
  }

  private featuresInRange(viewStartBp: number, viewEndBp: number): Feature[] {
    const sorted = this.featuresSortedByStart;
    if (!sorted || sorted.length === 0) return this.features;

    const lowBound = viewStartBp - this.maxFeatureLenBp;
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sorted[mid].start < lowBound) lo = mid + 1;
      else hi = mid;
    }
    const out: Feature[] = [];
    for (let i = lo; i < sorted.length; i++) {
      const f = sorted[i];
      if (f.start > viewEndBp) break;
      const fEnd = f.end > f.start ? f.end : f.end + this.genomeLength;
      if (fEnd < viewStartBp) continue;
      out.push(f);
    }

    for (const feature of this.circularWrappedFeatures) {
      if (!this.wrappedFeatureOverlapsRange(feature, viewStartBp, viewEndBp)) continue;
      if (!out.includes(feature)) out.push(feature);
    }
    return out;
  }

  private wrappedFeatureOverlapsRange(
    feature: Feature,
    viewStartBp: number,
    viewEndBp: number
  ): boolean {
    return (
      (feature.start < viewEndBp && this.genomeLength > viewStartBp) ||
      (viewEndBp > 0 && feature.end > viewStartBp)
    );
  }

  private hasFeaturesInRange(viewStartBp: number, viewEndBp: number): boolean {
    const sorted = this.featuresSortedByStart;
    if (!sorted || sorted.length === 0) return this.features.length > 0;
    const lowBound = viewStartBp - this.maxFeatureLenBp;
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sorted[mid].start < lowBound) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < sorted.length; i++) {
      const f = sorted[i];
      if (f.start > viewEndBp) break;
      const fEnd = f.end > f.start ? f.end : f.end + this.genomeLength;
      if (fEnd < viewStartBp) continue;
      return true;
    }
    for (const feature of this.circularWrappedFeatures) {
      if (this.wrappedFeatureOverlapsRange(feature, viewStartBp, viewEndBp)) return true;
    }
    return false;
  }

  private featuresSortedByStart: Feature[] = [];

  private circularWrappedFeatures: Feature[] = [];

  private maxFeatureLenBp = 0;

  private clearDrawState(): void {
    this.changeDecorationGraphics.clear();
    this.changeDecorationGraphics.visible = false;
    this.changeDecorationCommandCount = 0;
    this.changeDecorationFeatureIds = [];
    this.graphics.clear();
    this.graphics.visible = false;
    this.clearDecorationCache();
    this.retainedTranscriptDecorationGraphics.visible = false;
    this.annotationSearchFocusGraphics.clear();
    this.annotationSearchFocusGraphics.visible = false;
    this.floatingLabels.clear();
    this.interactionGraphics.clear();
    this.interactionGraphics.visible = false;
    this.labelIndex = 0;
    this.curvedLabels.reset();
    for (const label of this.labelPool) {
      label.visible = false;
    }
    this.hitCache.length = 0;
    this.outlineCache.clear();
    this.labelOccupancyCache = [];
    this.retainedLinear.overviewBinDrawCount = 0;
    this.lastInteractionOutlineCommandCount = 0;
    this.annotationSearchFocusMaskDrawCount = 0;
    this.annotationSearchFocusPrimitiveDrawCount = 0;
    this.annotationSearchFocusResolvedTrackId = null;
    this.annotationSearchFocusResolvedCanonicalIdentity = null;
    this.annotationSearchFocusPresentationLane = null;
  }

  private overviewCacheContext(layout = this._layout): AnnotationOverviewCacheContext {
    const genomeLength = this.genomeLength;
    const contract = layout
      ? resolveAnnotationTrackContract({
          layout,
          maxAnnotationLane: this.maxAnnotationLane,
          maxCdsLane: this.maxCdsLane,
        })
      : null;
    return {
      features: this.features,
      genomeLength,
      layout,
      maxAnnotationLane: this.maxAnnotationLane,
      maxCdsLane: this.maxCdsLane,
      minAggregateFeaturePixels: MIN_NARROW_FEATURE_PX,
      getEndBp: (feature) =>
        feature.end > feature.start ? feature.end : feature.end + genomeLength,
      getOffset: (feature) => {
        if (!contract) return -14;
        const laneIndex =
          feature.type === 'CDS' ? (feature.cdsLane ?? feature.lane ?? 0) : feature.lane;
        const envelope = getAnnotationLaneEnvelope(contract, feature.type, laneIndex);
        if (!envelope)
          throw new Error(`Annotation lane contract missing ${feature.type} lane ${laneIndex}`);
        return envelope.centerOffset;
      },
      getHalfHeight: () => ANNOTATION_BAR_HEIGHT / 2,
      getColor,
      getAlpha: (feature, featureScoped) =>
        featureScoped && isOutlineOnlyFeature(feature) ? 0.35 : 0.85,
      shouldPassThrough: (feature, featureScoped) =>
        featureScoped
          ? isSplicedFeature(feature)
          : isOutlineOnlyFeature(feature) || isSplicedFeature(feature) || isTranscript(feature),
    };
  }

  private retainedPreparationKey(read: RetainedOverviewBodyRead): string | null {
    return read.kind === 'unprepared'
      ? `${read.request.generation}|${read.request.contextKey}`
      : null;
  }

  canPresentRetainedOverview(layout: UnifiedLayout, pixelsPerBp: number): boolean {
    if (!this.enabled || !this.presentationVisible) return true;
    const plan = planRetainedAnnotationRender({
      enabled: retainedOverviewAnnotationsEnabled(),
      style: retainedOverviewAnnotationStyle(),
      hasLayout: true,
      genomeLength: this.genomeLength,
      featureCount: this.features.length,
      isArcMode: true,
      pixelsPerBp,
    });
    if (plan.kind === 'fallback') return true;
    const read = this.overviewCache.readRetainedOverviewBodyCache(
      { pixelsPerBp: Math.min(pixelsPerBp, OVERVIEW_LOD_COMPRESSED_PIXELS_PER_BP) },
      this.overviewCacheContext(layout)
    );
    return (
      read.kind !== 'unprepared' ||
      this.retainedPreparationKey(read) === this.retainedPreparationRefusal
    );
  }

  async prepareRetainedOverviewForLayout(
    layout: UnifiedLayout,
    pixelsPerBpMin: number,
    pixelsPerBpMax = OVERVIEW_LOD_COMPRESSED_PIXELS_PER_BP
  ): Promise<RetainedOverviewPreparationReceipt> {
    const context = this.overviewCacheContext(layout);
    const read = this.overviewCache.readRetainedOverviewBodyCache(
      { pixelsPerBp: pixelsPerBpMax },
      context
    );
    const receipt = await this.overviewCache.prepareRetainedOverview({
      presentationKey: 'stadium-annotations',
      contexts: [
        { context, pixelsPerBpMin: Math.min(pixelsPerBpMin, pixelsPerBpMax), pixelsPerBpMax },
      ],
    });
    if (receipt.kind === 'unprepared' && receipt.reason !== 'stale-generation') {
      this.retainedPreparationRefusal = this.retainedPreparationKey(read);
    }
    this.frameRequester?.();
    return receipt;
  }

  render(path: PathMapper, state: RenderState, _yOffset: number, _height: number): void {
    this.syncAnnotationColors(state);
    setPillLabelTheme(state.themeMode);
    this.retainedLinear.immediateDrawStateClearedForRetained = false;
    this.retainedLinear.retainedDrawStateClean = false;
    this.resetAllPresentersToHidden();
    this.retainedLinear.retainedOverviewLayer?.hide();

    this.retainedLinear.retainedOverviewHitBins = [];
    this.retainedLinear.lastOverviewImmediateBlendMs = 0;

    this.retainedLinear.renderCallCount += 1;
    this.retainedLinear.lastOverviewAggregationCacheHit = false;
    const renderKeyParts = this.renderKeyParts(state);
    const renderKey = this.renderKeyFromParts(renderKeyParts);
    if (renderKey === this.retainedLinear.lastRenderKey) {
      this.retainedLinear.geometryCacheHitCount += 1;
      this.retainedLinear.lastRenderMode = 'cache-hit';
      this.retainedLinear.lastGeometryRebuildReasons = [];
      if (this.retainedLinear.lastDrawAudit) {
        this.retainedLinear.lastDrawAudit = {
          ...this.retainedLinear.lastDrawAudit,
          frameId: ++this.retainedLinear.drawAuditFrameId,
          renderMode: 'cache-hit',
          pixelsPerBp: path.pixelsPerBp,
          viewStartBp: path.viewStartBp,
          viewEndBp: path.viewEndBp,
          zoom: state.zoom,
          viewOffset: state.viewOffset,
        };
      }
      this.replayLabelOccupancy(state);
      this.renderInteractionOutlines(path, state);
      return;
    }
    this.retainedLinear.lastGeometryRebuildReasons = this.renderKeyChangeReasons(renderKeyParts);
    this.retainedLinear.lastRenderKeyParts = renderKeyParts;
    this.retainedLinear.geometryRebuildCount += 1;
    this.retainedLinear.lastRenderMode = 'rebuild';
    this.retainedLinear.lastRenderKey = renderKey;

    const g = this.graphics;
    g.clear();
    g.visible = true;
    this.clearDecorationCache();
    this.retainedTranscriptDecorationGraphics.visible = false;

    const sink: FeaturePrimitiveSink = new GraphicsPrimitiveSink(g, path);
    this.labelIndex = 0;
    this.curvedLabels.reset();
    this.hitCache.length = 0;
    this.outlineCache.clear();
    this.labelOccupancyCache = [];
    this.retainedLinear.overviewBinDrawCount = 0;
    this.resetImmediateDrawStats();
    this.retainedLinear.lastOverviewLodCompressionBlend = 0;
    this.retainedLinear.lastOverviewLodFullShapeBlend = 1;

    const immediatePlan = path.isArcMode
      ? planImmediateAnnotationRender({
          style: retainedOverviewAnnotationStyle(),
          isArcMode: path.isArcMode,
          pixelsPerBp: path.pixelsPerBp,
        })
      : planLinearImmediateAnnotationRender(path.pixelsPerBp);
    const forceFullShapeOverview = immediatePlan.forceTinyFeatureShapes;
    const useOverviewAggregation = immediatePlan.kind === 'overview-aggregation';
    this.retainedLinear.lastOverviewDensityAtlasSampleScreenPx =
      OVERVIEW_DENSITY_ATLAS_SAMPLE_SCREEN_PX;
    const overviewCacheStart = performance.now();
    const overviewCache = useOverviewAggregation
      ? this.overviewCache.getOverviewAggregationCache(path, this.overviewCacheContext())
      : null;
    this.retainedLinear.lastOverviewCacheMs = performance.now() - overviewCacheStart;
    const atlasDiagnostics = this.overviewCache.mergedDensityAtlasDiagnostics();
    this.retainedLinear.lastOverviewDensityAtlasBinBp = overviewCache?.binBp ?? 0;
    this.retainedLinear.lastOverviewDensityAtlasLevelCount = overviewCache?.atlasLevelCount ?? 0;
    this.retainedLinear.lastOverviewDensityAtlasEstimatedBinCount =
      atlasDiagnostics.estimatedBinCount;
    this.retainedLinear.lastOverviewDensityAtlasWasCoarsened = atlasDiagnostics.wasCoarsened;
    this.retainedLinear.lastOverviewDensityAtlasBudgetExceeded = atlasDiagnostics.budgetExceeded;
    this.retainedLinear.lastOverviewAggregationCacheHit = this.overviewCache.lastCacheHit;

    const rawFeaturesToRender = overviewCache?.passthroughFeatures ?? this.features;
    const featuresToRender = path.isArcMode
      ? [
          ...this.featureWindowIndex.candidatesForPath(
            path,
            rawFeaturesToRender,
            ANNOTATION_BODY_WINDOW_MARGIN_PX,

            { forceWindowing: !overviewCache }
          ),
        ]
      : overviewCache
        ? rawFeaturesToRender
        : this.featuresInRange(path.viewStartBp, path.viewEndBp);
    this.retainedLinear.lastOverviewAggregationEnabled = Boolean(overviewCache);
    this.retainedLinear.lastOverviewPassthroughFeatureCount = featuresToRender.length;
    const drawAudit = this.beginDrawAudit(
      path,
      state,
      featuresToRender,
      useOverviewAggregation,
      overviewCache
    );
    this.retainedLinear.lastDrawAudit = drawAudit;

    for (const feature of featuresToRender) {
      const decision = this.renderImmediateFeature(
        sink,
        feature,
        path,
        state,
        useOverviewAggregation,
        forceFullShapeOverview
      );
      this.recordDrawAuditDecision(drawAudit, feature, decision, path);
    }

    if (overviewCache && overviewCache.bins.length > 0) {
      let visibleBinCount = 0;
      let viewportCulledBinCount = 0;
      let binSourceCount = 0;
      for (const bin of overviewCache.bins) {
        binSourceCount += bin.sourceCount;
        if (
          !path.isFeatureVisible(bin.startBp, bin.endBp - bin.startBp, bin.offset, bin.halfHeight)
        ) {
          viewportCulledBinCount += 1;
          continue;
        }
        const pts = path.isArcMode
          ? path.featurePolygonAt(bin.startBp, bin.endBp, bin.offset, bin.halfHeight)
          : path.featureQuadAt(bin.startBp, bin.endBp, bin.offset, bin.halfHeight);
        sink.fillPoly(pts, webglAnnotationColorForMode(bin.color, state.themeMode), bin.alpha);
        this.retainedLinear.overviewBinDrawCount += 1;
        visibleBinCount += 1;
      }
      drawAudit.overview.visibleBinCount = visibleBinCount;
      drawAudit.overview.viewportCulledBinCount = viewportCulledBinCount;
      drawAudit.overview.binSourceCount = binSourceCount;
    }
    this.renderRetainedTranscriptDecorations(null, path, state);
    ptime('annotation.floating-labels', () => this.floatingLabels.render(path, state));
    drawAudit.drawnFeatureCount = this.lastDrawnFeatureCount;

    for (let i = this.labelIndex; i < this.labelPool.length; i++) {
      this.labelPool[i].visible = false;
    }
    this.renderInteractionOutlines(path, state);
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
    if (this.shouldSplitLinearWrappedFeature(feature, path)) {
      return this.renderLinearWrappedFeatureSegments(
        sink,
        feature,
        path,
        state,
        useOverviewAggregation,
        forceTinyFeatureShapes,
        alphaScale
      );
    }

    const featureLen =
      feature.end > feature.start
        ? feature.end - feature.start
        : this.genomeLength - feature.start + feature.end;
    const pixelWidth = featureLen * path.pixelsPerBp;

    if (!forceTinyFeatureShapes && pixelWidth < 0.3) return 'skipped-subpixel';

    const offset = this.featureOffset(feature);
    const halfHeight = this.scaledBarHeight() / 2;

    if (!path.isFeatureVisible(feature.start, featureLen, offset, halfHeight)) {
      return 'skipped-viewport';
    }

    const color =
      this.annotationBodyColors?.get(feature.id) ?? getThemedColor(feature, state.themeMode);

    const overviewAlphaScale = forceTinyFeatureShapes ? fullShapeOverviewAlphaScale(pixelWidth) : 1;
    const effectiveAlphaScale = Math.max(0, Math.min(1, alphaScale)) * overviewAlphaScale;
    const alpha = 0.85 * effectiveAlphaScale;

    const endBp = feature.end > feature.start ? feature.end : feature.end + this.genomeLength;
    const isSpliced = isSplicedFeature(feature);

    if (
      !isOutlineOnlyFeature(feature) &&
      !isSpliced &&
      useOverviewAggregation &&
      pixelWidth < MIN_NARROW_FEATURE_PX
    ) {
      return 'skipped-overview-aggregated-tiny';
    }
    this.lastDrawnFeatureCount += 1;
    this.lastImmediateDrawnLayerTypes.add(feature.type);
    if (isTranscript(feature)) this.lastImmediateTranscriptDrawnCount += 1;

    if (!isSpliced && pixelWidth < MIN_NARROW_FEATURE_PX) {
      const centerBp = feature.start + featureLen / 2;
      const minLenBp = path.isArcMode
        ? screenWidthToBp(path, centerBp, MIN_NARROW_FEATURE_PX, offset)
        : MIN_NARROW_FEATURE_PX / Math.max(path.pixelsPerBp, 1e-4);
      const visualLenBp = Math.max(featureLen, minLenBp);
      let visualStart = centerBp - visualLenBp / 2;
      let visualEnd = centerBp + visualLenBp / 2;

      if (!this.genomeCircular) {
        if (visualStart < 0) {
          visualEnd -= visualStart;
          visualStart = 0;
        }
        if (visualEnd > this.genomeLength) {
          visualStart -= visualEnd - this.genomeLength;
          visualEnd = this.genomeLength;
        }
        visualStart = Math.max(0, visualStart);
        visualEnd = Math.min(this.genomeLength, visualEnd);
      }
      if (visualEnd <= visualStart) return 'skipped-empty-visual-range';

      const pts = path.featurePolygonAt(visualStart, visualEnd, offset, halfHeight);
      if (isOutlineOnlyFeature(feature)) {
        sink.strokePoly(pts, color, 0.9 * effectiveAlphaScale);
      } else {
        sink.fillPoly(pts, color, alpha);
      }
      this.setFeaturePolygonOutline(feature.id, pts);
      if (hasDraftOutline(feature)) {
        this.strokeDraftOutlineCommands(
          this.graphics,
          path,
          [{ kind: 'poly', pts }],
          color,
          0.95 * effectiveAlphaScale
        );
      }
      const bbox = computeBBox(pts);

      this.hitCache.push({
        id: feature.id,
        start: feature.start,
        end: feature.end,
        pts: [],
        xMin: bbox.xMin - 4,
        xMax: bbox.xMax + 4,
        yMin: bbox.yMin - 2,
        yMax: bbox.yMax + 2,
      });
      return 'drawn';
    }

    const hitPts = path.featurePolygonAt(feature.start, endBp, offset, halfHeight);
    const bbox = computeBBox(hitPts);
    this.hitCache.push({
      id: feature.id,
      start: feature.start,
      end: feature.end,
      pts: hitPts,
      ...bbox,
    });

    if (isTranscript(feature)) {
      this.immediateDraw.drawTranscriptGlyph(
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
        effectiveAlphaScale
      );
      return 'drawn';
    }

    const isCDS = feature.type === 'CDS';

    if (isCDS) {
      const outlineOnly = isOutlineOnlyFeature(feature);
      const detailProgress = this.cdsDetailProgress();
      if (detailProgress <= 0) {
        this.drawStandard(
          sink,
          feature,
          endBp,
          featureLen,
          pixelWidth,
          color,
          alpha * (1 - detailProgress),
          path,
          state,
          hitPts,
          true,
          effectiveAlphaScale
        );
      } else if (detailProgress < 1 && !outlineOnly) {
        this.drawFeatureLevelTransitionShape(
          this.graphics,
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
      if (detailProgress > 0) {
        this.immediateDraw.drawCDSLabelStrip(
          this.graphics,
          feature,
          endBp,
          featureLen,
          color,
          alpha,
          path,
          state,
          detailProgress,
          detailProgress < 1
            ? this.featureLevelLabelCenterBp(feature, featureLen, hitPts, state)
            : null,
          detailProgress >= 1,
          detailProgress < 1 ? this.cdsTransitionHalfHeight(detailProgress) : null
        );
      }
    } else {
      this.drawStandard(
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
        true,
        effectiveAlphaScale
      );
    }

    if (hasDraftOutline(feature)) {
      const outlineCommands = this.outlineCache.get(feature.id);
      if (outlineCommands) {
        this.strokeDraftOutlineCommands(
          this.graphics,
          path,
          outlineCommands,
          color,
          0.95 * effectiveAlphaScale
        );
      }
    }

    return 'drawn';
  }

  private shouldSplitLinearWrappedFeature(feature: Feature, path: PathMapper): boolean {
    return (
      this.genomeCircular && !path.isArcMode && this.genomeLength > 0 && feature.start > feature.end
    );
  }

  private linearWrappedFeatureSegments(feature: Feature): Feature[] {
    const splicedSegments = this.linearWrappedSplicedFeatureSegments(feature);
    if (splicedSegments) return splicedSegments;

    const qualifiers = feature.qualifiers ? { ...feature.qualifiers } : undefined;
    if (qualifiers) delete qualifiers._locationString;
    const baseSegment = {
      ...feature,
      segments: undefined,
      qualifiers,
    };
    const segments: Feature[] = [];
    if (feature.start < this.genomeLength) {
      segments.push({
        ...baseSegment,
        end: this.genomeLength,
        direction: feature.direction === 'reverse' ? 'reverse' : 'none',
      });
    }
    if (feature.end > 0) {
      segments.push({
        ...baseSegment,
        start: 0,
        direction: feature.direction === 'forward' ? 'forward' : 'none',
      });
    }
    return segments;
  }

  private linearWrappedSplicedFeatureSegments(feature: Feature): Feature[] | null {
    if (!isSplicedFeature(feature)) return null;

    const sourceSegments = feature.segments ?? [];
    const pieces: Feature[] = [];
    const splitInclusiveSegment = (segment: { start: number; end: number }) =>
      segment.start <= segment.end
        ? [segment]
        : [
            { start: segment.start, end: this.genomeLength },
            { start: 1, end: segment.end },
          ];

    const pushPiece = (rangeStart0: number, rangeEnd0: number, direction: Feature['direction']) => {
      const rangeStart1 = rangeStart0 + 1;
      const rangeEnd1 = rangeEnd0;
      const clippedSegments = sourceSegments.flatMap((segment) =>
        splitInclusiveSegment(segment)
          .map((part) => ({
            start: Math.max(part.start, rangeStart1),
            end: Math.min(part.end, rangeEnd1),
          }))
          .filter((part) => part.start <= part.end)
      );
      if (clippedSegments.length === 0) return;

      const start = Math.min(...clippedSegments.map((segment) => segment.start)) - 1;
      const end = Math.max(...clippedSegments.map((segment) => segment.end));
      const qualifiers = { ...(feature.qualifiers ?? {}) };
      qualifiers._locationString =
        clippedSegments.length > 1
          ? `join(${clippedSegments.map((segment) => `${segment.start}..${segment.end}`).join(',')})`
          : `${clippedSegments[0].start}..${clippedSegments[0].end}`;

      pieces.push({
        ...feature,
        start,
        end,
        direction,
        segments: clippedSegments,
        qualifiers,
      });
    };

    if (feature.start < this.genomeLength) {
      pushPiece(
        feature.start,
        this.genomeLength,
        feature.direction === 'reverse' ? 'reverse' : 'none'
      );
    }
    if (feature.end > 0) {
      pushPiece(0, feature.end, feature.direction === 'forward' ? 'forward' : 'none');
    }

    return pieces.length > 0 ? pieces : null;
  }

  private renderLinearWrappedFeatureSegments(
    sink: FeaturePrimitiveSink,
    feature: Feature,
    path: PathMapper,
    state: RenderState,
    useOverviewAggregation: boolean,
    forceTinyFeatureShapes: boolean,
    alphaScale: number
  ): AnnotationDrawAuditDecision {
    const outlineCommands: OutlineCommand[] = [];
    let aggregateDecision: AnnotationDrawAuditDecision = 'skipped-empty-visual-range';
    for (const segment of this.linearWrappedFeatureSegments(feature)) {
      const hitStartIndex = this.hitCache.length;
      const segmentDecision = this.renderImmediateFeature(
        sink,
        segment,
        path,
        state,
        useOverviewAggregation,
        forceTinyFeatureShapes,
        alphaScale
      );
      if (segmentDecision === 'drawn' || aggregateDecision === 'skipped-empty-visual-range') {
        aggregateDecision = segmentDecision;
      }
      for (let i = hitStartIndex; i < this.hitCache.length; i++) {
        const record = this.hitCache[i];
        if (record.id !== feature.id) continue;
        record.start = feature.start;
        record.end = feature.end;
      }
      const segmentOutline = this.outlineCache.get(feature.id);
      if (segmentOutline) outlineCommands.push(...segmentOutline);
    }
    if (outlineCommands.length > 0) this.outlineCache.set(feature.id, outlineCommands);
    return aggregateDecision;
  }

  private setFeaturePolygonOutline(featureId: number, points: number[]): void {
    this.outlineCache.set(featureId, points.length >= 6 ? [{ kind: 'poly', pts: points }] : []);
  }

  private setFeatureOutline(featureId: number, commands: OutlineCommand[]): void {
    this.outlineCache.set(
      featureId,
      commands.filter((command) => {
        if (command.kind === 'poly') return command.pts.length >= 6;
        if (command.kind === 'polyline') return command.pts.length >= 4;
        return true;
      })
    );
  }

  private addFeatureOutline(featureId: number, command: OutlineCommand): void {
    const existing = this.outlineCache.get(featureId);
    if (existing) {
      existing.push(command);
    } else {
      this.outlineCache.set(featureId, [command]);
    }
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
      this.genomeLength
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
      this.genomeLength
    );
  }

  private ensureInteractionOutline(path: PathMapper, featureId: number, state?: RenderState): void {
    if (this.outlineCache.has(featureId)) return;
    const feature = this.featureById.get(featureId);
    if (!feature) return;

    const featureLen =
      feature.end > feature.start
        ? feature.end - feature.start
        : this.genomeLength - feature.start + feature.end;
    if (featureLen <= 0) return;

    const offset = this.featureOffset(feature);
    const halfHeight = this.scaledBarHeight() / 2;
    if (!path.isFeatureVisible(feature.start, featureLen, offset, halfHeight)) return;

    if (
      state &&
      !path.isArcMode &&
      this.retainedLinear.retainedLinearTranscriptFeatureSet?.has(feature)
    ) {
      this.setFeatureOutline(featureId, [
        ...retainedAnnotationSectorOutline(
          feature,
          path,
          state,
          offset,
          halfHeight,
          this.cdsDetailProgress()
        ),
        ...this.transcriptGlyphOutlineCommands(feature, path).filter(
          (command) => command.kind === 'polyline'
        ),
      ]);
      return;
    }

    const endBp = feature.end > feature.start ? feature.end : feature.end + this.genomeLength;
    const pixelWidth = featureLen * path.pixelsPerBp;
    const hitPts = path.featurePolygonAt(feature.start, endBp, offset, halfHeight);
    const drawPts = this.standardFeatureDrawPoints(feature, endBp, pixelWidth, path, hitPts);
    if (isTranscript(feature)) {
      this.setFeatureOutline(feature.id, this.transcriptGlyphOutlineCommands(feature, path));
    } else {
      this.setFeaturePolygonOutline(feature.id, drawPts);
    }
  }

  renderCompoundCdsInteractionOutlines(
    path: PathMapper,
    state: RenderState,
    codonContours: ReadonlyMap<number, readonly number[][]>
  ): void {
    if (codonContours.size) this.renderInteractionOutlines(path, state, codonContours);
  }

  private renderInteractionOutlines(
    path: PathMapper,
    state: RenderState,
    codonContours?: ReadonlyMap<number, readonly number[][]>
  ): void {
    if (
      !codonContours &&
      (state.annotationChangeDecorations?.size || this.changeDecorationCommandCount)
    ) {
      this.changeDecorationGraphics.clear();
      const result = renderAnnotationChangeDecorations(
        {
          featureById: this.featureById,
          outlineCache: this.outlineCache,
          invalidateCameraDependentInteractionOutline: (id) =>
            this.invalidateCameraDependentInteractionOutline(id),
          ensureInteractionOutline: (mapper, id) => this.ensureInteractionOutline(mapper, id),
        },
        this.changeDecorationGraphics,
        path,
        state
      );
      this.changeDecorationCommandCount = result.commandCount;
      this.changeDecorationFeatureIds = result.featureIds;
      this.changeDecorationGraphics.visible = result.commandCount > 0;
    }
    if (!codonContours) {
      this.mutationSectorReceipt = renderAnnotationMutationSectors(
        {
          featureById: this.featureById,
          featureOffset: (feature) => this.featureOffset(feature),
          halfHeight: this.scaledBarHeight() / 2,
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
                this.scaledBarHeight() / 2,
                this.cdsDetailProgress()
              );
            }
            this.invalidateCameraDependentInteractionOutline(feature.id);
            this.ensureInteractionOutline(path, feature.id);
            return this.outlineCache.get(feature.id) ?? [];
          },
        },
        this.mutationSectorGraphics,
        path,
        this.mutationPaint,
        this.cdsDetailProgress()
      );
      this.renderAnnotationSearchFocus(path, state);
    }

    if (!codonContours) this.floatingLabels.renderInteractionLeaders(state);
    const g = this.interactionGraphics;
    g.clear();
    g.visible = false;
    this.lastInteractionOutlineCommandCount = 0;
    this.lastInteractionContours = [];
    const selectedCanonicalIdentities = state.selectedCanonicalIdentities;
    if (
      state.hoveredId === null &&
      state.selectedIds.size === 0 &&
      (!selectedCanonicalIdentities || selectedCanonicalIdentities.size === 0)
    ) {
      return;
    }
    g.visible = true;

    if (state.hoveredId !== null) {
      this.invalidateCameraDependentInteractionOutline(state.hoveredId);
      this.ensureInteractionOutline(path, state.hoveredId, state);
    }
    for (const featureId of state.selectedIds) {
      this.invalidateCameraDependentInteractionOutline(featureId);
      this.ensureInteractionOutline(path, featureId, state);
    }

    for (const featureId of codonContours?.keys() ?? []) {
      if (!this.outlineCache.has(featureId)) this.outlineCache.set(featureId, []);
    }
    for (const [featureId, featureCommands] of this.outlineCache) {
      const style = interactionOutlineStyle(state, featureId);
      if (!style) continue;
      const codons = codonContours?.get(featureId);
      const commands = codons
        ? compoundCdsOutlineCommands(featureCommands, codons)
        : featureCommands;
      this.lastInteractionOutlineCommandCount += commands.length;

      for (const command of commands) {
        g.setStrokeStyle(interactionOutlineStrokeStyle(command, style));
        if (command.kind === 'poly')
          this.lastInteractionContours.push({ featureId, points: command.pts });
        this.strokeOutlineCommand(g, command);
      }
    }
  }

  annotationSearchFocusDurableVisibility(
    focus: RenderState['annotationSearchFocus']
  ): 'visible' | 'filtered' | 'unavailable' {
    if (!focus) return 'unavailable';
    return 'unavailable';
  }

  private renderAnnotationSearchFocusMask(
    graphics: Graphics,
    path: PathMapper,
    state: RenderState,
    top: number,
    bottom: number
  ): void {
    const genomeStartX = path.bpLeftX(0);
    const genomeEndX = path.bpLeftX(this.genomeLength);
    if (!Number.isFinite(genomeStartX) || !Number.isFinite(genomeEndX)) return;
    const left = Math.max(0, Math.min(state.width, genomeStartX, genomeEndX));
    const right = Math.max(0, Math.min(state.width, Math.max(genomeStartX, genomeEndX)));
    if (right <= left || bottom <= top) return;
    graphics.rect(left, top, right - left, bottom - top).fill({
      color: ANNOTATION_SEARCH_FOCUS_DIM_COLOR,
      alpha: ANNOTATION_SEARCH_FOCUS_DIM_ALPHA,
    });
    this.annotationSearchFocusMaskDrawCount = 1;
  }

  private renderAnnotationSearchFocus(path: PathMapper, state: RenderState): void {
    const graphics = this.annotationSearchFocusGraphics;
    graphics.clear();
    graphics.visible = false;
    this.annotationSearchFocusMaskDrawCount = 0;
    this.annotationSearchFocusPrimitiveDrawCount = 0;
    this.annotationSearchFocusResolvedTrackId = null;
    this.annotationSearchFocusResolvedCanonicalIdentity = null;
    this.annotationSearchFocusPresentationLane = null;

    const focus = state.annotationSearchFocus;
    if (
      !focus ||
      path.isArcMode ||
      focus.trackId.length === 0 ||
      focus.canonicalIdentity.length === 0 ||
      !this._layout
    ) {
      return;
    }
    this.renderFlatAnnotationSearchFocus(path, state);
  }

  private renderFlatAnnotationSearchFocus(path: PathMapper, state: RenderState): void {
    const focus = state.annotationSearchFocus;
    const feature = state.annotationSearchFocusFeature;
    const layout = this._layout;
    const contract = this._contract;
    if (
      !focus ||
      !feature ||
      !layout ||
      !contract ||
      (feature.annotationTrackId ?? feature.type) !== focus.trackId ||
      feature.canonicalIdentity !== focus.canonicalIdentity
    ) {
      return;
    }

    const featureLane = feature.type === 'CDS' ? (feature.cdsLane ?? feature.lane) : feature.lane;
    const localLane = feature.annotationTrackLane ?? 0;
    const laneCapacity = feature.annotationTrackLaneCapacity ?? 1;
    const trackBaseLane = featureLane - localLane;
    const trackLastLane = trackBaseLane + laneCapacity - 1;
    if (
      !Number.isSafeInteger(featureLane) ||
      !Number.isSafeInteger(localLane) ||
      localLane < 0 ||
      !Number.isSafeInteger(laneCapacity) ||
      laneCapacity <= 0 ||
      localLane >= laneCapacity ||
      !Number.isSafeInteger(trackBaseLane) ||
      trackBaseLane < 0 ||
      !Number.isSafeInteger(trackLastLane)
    ) {
      return;
    }
    const firstLane = getAnnotationLaneEnvelope(contract, feature.type, trackBaseLane);
    const lastLane = getAnnotationLaneEnvelope(contract, feature.type, trackLastLane);
    if (!firstLane || !lastLane) return;

    const laneStep = feature.type === 'CDS' ? layout.cdsLaneStep : layout.annotationStep;
    if (!Number.isFinite(laneStep) || laneStep <= 0) return;
    const slotTop =
      path.fwdStrandTop + Math.min(firstLane.centerOffset, lastLane.centerOffset) - laneStep / 2;
    const slotBottom =
      path.fwdStrandTop + Math.max(firstLane.centerOffset, lastLane.centerOffset) + laneStep / 2;
    const clippedTop = Math.max(0, slotTop);
    const clippedBottom = Math.min(state.height, slotBottom);
    if (state.width <= 0 || clippedBottom <= clippedTop) return;

    const graphics = this.annotationSearchFocusGraphics;
    const presentationLane =
      focus.presentation === 'temporary-additional-lane' &&
      (feature.type === 'CDS'
        ? featureLane > this.maxCdsLane
        : featureLane > this.maxAnnotationLane)
        ? featureLane
        : null;
    graphics.visible = true;
    this.annotationSearchFocusResolvedTrackId = focus.trackId;
    this.annotationSearchFocusResolvedCanonicalIdentity = focus.canonicalIdentity;
    this.annotationSearchFocusPresentationLane = presentationLane;
    if (focus.presentation !== 'temporary-additional-lane' || presentationLane !== null) {
      this.renderAnnotationSearchFocusMask(graphics, path, state, clippedTop, clippedBottom);
    }

    const offset = this.featureOffset(feature);
    if (isTranscript(feature)) {
      if (isOutlineOnlyFeature(feature)) {
        const commands = this.transcriptGlyphOutlineCommands(feature, path);
        this.strokeOutlineCommands(
          graphics,
          path,
          commands,
          this.annotationColors?.get(feature.id) ?? getThemedColor(feature, state.themeMode),
          0.9
        );
        this.annotationSearchFocusPrimitiveDrawCount += commands.length;
        return;
      }
      const cdsDetail = this.cdsDetailProgress();
      const blocks = buildTranscriptGlyphBlocks([feature], {
        getOffset: () => offset,
        halfHeight: this.scaledBarHeight() / 2,
        themeMode: state.themeMode,
        cdsDetail,
      });
      for (const block of blocks) {
        const geometry = this.flatAnnotationSearchFocusBlockGeometry(path, state, block);
        if (!geometry) continue;
        const alpha =
          block.alpha *
          Math.max(0, 1 - block.cdsFade * cdsDetail) *
          retainedSubpixelAlphaScale(geometry.actualWidthPx);
        if (alpha <= 0) continue;
        graphics.poly(geometry.points).fill({ color: block.color, alpha });
        this.annotationSearchFocusPrimitiveDrawCount += 1;
      }
      return;
    }

    const featureLen =
      feature.end > feature.start
        ? feature.end - feature.start
        : this.genomeLength - feature.start + feature.end;
    if (featureLen <= 0) return;
    const pixelWidth = featureLen * path.pixelsPerBp;
    const endBp = feature.end > feature.start ? feature.end : feature.end + this.genomeLength;
    const hitPts = path.featurePolygonAt(feature.start, endBp, offset, this.scaledBarHeight() / 2);
    const drawPts = this.standardFeatureDrawPoints(feature, endBp, pixelWidth, path, hitPts);
    const sink: FeaturePrimitiveSink = new GraphicsPrimitiveSink(graphics, path);
    const color =
      this.annotationColors?.get(feature.id) ?? getThemedColor(feature, state.themeMode);
    if (isOutlineOnlyFeature(feature)) {
      sink.strokePoly(drawPts, color, 0.9);
    } else {
      sink.fillPoly(drawPts, color, 0.85);
    }
    this.annotationSearchFocusPrimitiveDrawCount = 1;
  }

  private flatAnnotationSearchFocusBlockGeometry(
    path: PathMapper,
    state: RenderState,
    block: DirectionalBlock
  ): { points: number[]; actualWidthPx: number } | null {
    let xMin = path.bpLeftX(block.startBp);
    let xMax = path.bpLeftX(block.endBp);
    if (xMax < xMin) {
      const swap = xMin;
      xMin = xMax;
      xMax = swap;
    }
    const actualWidthPx = Math.max(0, xMax - xMin);
    if (actualWidthPx < RETAINED_SUBPIXEL_MIN_WIDTH_PX) {
      const midpoint = (xMin + xMax) / 2;
      xMin = midpoint - RETAINED_SUBPIXEL_MIN_WIDTH_PX / 2;
      xMax = midpoint + RETAINED_SUBPIXEL_MIN_WIDTH_PX / 2;
    }
    if (xMax < 0 || xMin > state.width) return null;

    const centerY = path.fwdStrandTop + block.offsetCenter;
    let arrowWidth = 0;
    if (block.dirSign !== 0) {
      const candidate = Math.min(
        2 * block.halfH * ARROW_HEIGHT_RATIO,
        actualWidthPx * 0.3,
        ARROW_MAX_WIDTH
      );
      if (actualWidthPx > candidate * 2) arrowWidth = candidate;
    }
    const points =
      block.dirSign < 0
        ? [
            xMin + arrowWidth,
            centerY - block.halfH,
            xMax,
            centerY - block.halfH,
            xMax,
            centerY + block.halfH,
            xMin + arrowWidth,
            centerY + block.halfH,
            xMin,
            centerY,
          ]
        : [
            xMin,
            centerY - block.halfH,
            xMax - arrowWidth,
            centerY - block.halfH,
            xMax,
            centerY,
            xMax - arrowWidth,
            centerY + block.halfH,
            xMin,
            centerY + block.halfH,
          ];
    return { points, actualWidthPx };
  }

  private invalidateCameraDependentInteractionOutline(featureId: number): void {
    if (this.retainedLinear.retainedOverviewMode !== 'retained') return;
    const retainedSet = this.retainedLinear.retainedLinearTranscriptFeatureSet;
    if (!retainedSet || retainedSet.size === 0) return;
    const feature = this.featureById.get(featureId);
    if (!feature || !retainedSet.has(feature) || !isTranscript(feature)) return;
    this.outlineCache.delete(featureId);
  }

  private strokeOutlineCommand(g: Graphics, command: OutlineCommand): void {
    if (command.kind === 'poly') {
      g.poly(command.pts);
    } else if (command.kind === 'polyline') {
      if (command.pts.length < 4) return;
      g.moveTo(command.pts[0], command.pts[1]);
      for (let i = 2; i < command.pts.length; i += 2) {
        g.lineTo(command.pts[i], command.pts[i + 1]);
      }
    } else {
      g.roundRect(command.x, command.y, command.width, command.height, command.radius);
    }
    g.stroke();
  }

  private strokeCurrentPath(
    g: Graphics,
    path: PathMapper,
    color: number,
    alpha: number,
    width = 1.5
  ): void {
    g.setStrokeStyle({ width: path.scaleStroke(width), color, alpha });
    g.stroke();
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
    if (widthPx <= 0) return;
    const endBp = advanceBpByScreenWidth(path, startBp, widthPx, offset);
    g.setStrokeStyle({ width: path.scaleStroke(1.5), color, alpha });
    if (!path.isArcMode && endBp <= this.genomeLength) {
      const y = path.featureLabelPosAt(startBp, offset).y - halfHeight;
      g.roundRect(
        path.bpLeftX(startBp),
        y,
        widthPx,
        halfHeight * 2,
        Math.min(3, halfHeight, widthPx / 2)
      );
    } else {
      const pts = laneRoundedPillPolygon(path, startBp, widthPx, offset, halfHeight);
      if (pts.length < 6) return;
      g.poly(pts);
    }
    g.stroke();
  }

  private strokeOutlineCommands(
    g: Graphics,
    path: PathMapper,
    commands: OutlineCommand[],
    color: number,
    alpha: number
  ): void {
    if (commands.length === 0) return;
    g.setStrokeStyle({ width: path.scaleStroke(1.5), color, alpha });
    for (const command of commands) {
      this.strokeOutlineCommand(g, command);
    }
  }

  private strokeDraftOutlineCommands(
    g: Graphics,
    path: PathMapper,
    commands: OutlineCommand[],
    color: number,
    alpha: number
  ): void {
    if (commands.length === 0) return;
    g.setStrokeStyle({ width: path.scaleStroke(1.5), color, alpha });
    for (const command of commands) {
      if (command.kind === 'poly') {
        drawDashedPolyline(
          g,
          flatPolygonToPolyline(command.pts),
          DRAFT_OUTLINE_DASH_PX,
          DRAFT_OUTLINE_GAP_PX
        );
      } else if (command.kind === 'polyline') {
        const points: Point2[] = [];
        for (let i = 0; i + 1 < command.pts.length; i += 2) {
          points.push({ x: command.pts[i], y: command.pts[i + 1] });
        }
        drawDashedPolyline(g, points, DRAFT_OUTLINE_DASH_PX, DRAFT_OUTLINE_GAP_PX);
      } else {
        drawDashedPolyline(
          g,
          [
            { x: command.x, y: command.y },
            { x: command.x + command.width, y: command.y },
            { x: command.x + command.width, y: command.y + command.height },
            { x: command.x, y: command.y + command.height },
            { x: command.x, y: command.y },
          ],
          DRAFT_OUTLINE_DASH_PX,
          DRAFT_OUTLINE_GAP_PX
        );
      }
    }
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
      genomeLength: this.genomeLength,
      pixelsPerBp: path.pixelsPerBp,
      isArcMode: path.isArcMode,
    });
  }

  private replayLabelOccupancy(state: RenderState): void {
    for (const { xMin, xMax, yMin, yMax, kind, featureId, text } of this.labelOccupancyCache) {
      reserveLabelBounds(
        state,
        { xMin, xMax, yMin, yMax },
        { kind, featureId, text },
        { force: true }
      );
    }
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
    const halfHeight = this.cdsTransitionHalfHeight(detailProgress);
    const drawPts = this.standardFeatureDrawPoints(
      feature,
      endBp,
      pixelWidth,
      path,
      hitPts,
      halfHeight
    );
    const outlineOnly = isOutlineOnlyFeature(feature);
    this.setFeaturePolygonOutline(feature.id, drawPts);
    if (alpha <= 0) return;

    g.poly(drawPts);
    if (outlineOnly) {
      this.strokeCurrentPath(g, path, color, 0.9);
    } else {
      g.fill({ color, alpha });
    }
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
    const offset = this.featureOffset(feature);
    const outlineOnly = isOutlineOnlyFeature(feature);
    const halfHeight = this.scaledBarHeight() / 2;

    if (isSplicedFeature(feature) && feature.segments && feature.segments.length > 1) {
      const segments = feature.segments;
      const dir = feature.direction;
      const drawArrow = dir === 'forward' || dir === 'reverse';
      const arrowExonIdx = dir === 'reverse' ? 0 : segments.length - 1;

      const exonOutlinePolys: number[][] = [];
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];

        const segStart = seg.start - 1;
        const segEnd = seg.end;
        const segWidthPx = (segEnd - segStart) * path.pixelsPerBp;

        let exonPts: number[];
        if (drawArrow && i === arrowExonIdx) {
          const aw = this.directionalArrowWidth(segWidthPx, halfHeight * 2);
          if (segWidthPx > aw * 2) {
            const subFeature = { ...feature, start: segStart };
            exonPts = buildDirectionalPolygon(path, subFeature, segEnd, offset, aw, halfHeight);
          } else {
            exonPts = path.featurePolygonAt(segStart, segEnd, offset, halfHeight);
          }
        } else {
          exonPts = path.featurePolygonAt(segStart, segEnd, offset, halfHeight);
        }
        if (outlineOnly) {
          sink.strokePoly(exonPts, color, 0.9 * labelAlphaScale);
        } else {
          sink.fillPoly(exonPts, color, alpha);
        }
        exonOutlinePolys.push(exonPts);

        if (i < segments.length - 1) {
          const nextSeg = segments[i + 1];
          const intronStart = segEnd;
          const intronEnd = nextSeg.start - 1;
          if (intronEnd > intronStart) {
            const connectorHalfHeight = Math.max(0.5, halfHeight * 0.08);
            const linePts = path.featurePolygonAt(
              intronStart,
              intronEnd,
              offset,
              connectorHalfHeight
            );
            sink.fillPoly(linePts, color, alpha * 0.55);
          }
        }
      }
      this.setFeatureOutline(
        feature.id,
        exonOutlinePolys.map((pts) => ({ kind: 'poly' as const, pts }))
      );

      const labelAlpha = this.overviewLabelAlpha() * labelAlphaScale;
      if (renderLabel && labelAlpha > 0.01 && feature.displayName) {
        const labelPlacement = bestVisiblePolygonLabelCandidate(
          exonOutlinePolys,
          state.width,
          state.height
        );
        if (labelPlacement && labelPlacement.visibleWidth > MIN_BAR_FOR_LABEL) {
          const labelSegment = segments[labelPlacement.candidateIndex];
          const availW = labelPlacement.visibleWidth - 8;
          const labelText = truncateForWidth(
            feature.displayName,
            availW,
            this.labelCache,
            feature.id
          );
          if (labelText && path.isArcMode) {
            const rangeStartBp = labelSegment.start - 1;
            const rangeEndBp = labelSegment.end;
            const centerBp = rangeStartBp + (rangeEndBp - rangeStartBp) * labelPlacement.fraction;
            this.renderCurvedLabel(
              labelText,
              centerBp,
              measurePillLabelTextWidth(labelText),
              feature,
              rangeEndBp,
              color,
              offset,
              path,
              labelAlpha,
              rangeStartBp,
              rangeEndBp,
              state.sequencePresentation?.annotationColors?.get(feature.id) ??
                (outlineOnly ? color : undefined)
            );
          } else if (labelText) {
            const textObj = this.acquireLabel();
            textObj.text = labelText;
            const targetStyle = pillLabelTextStyle(
              color,
              undefined,
              state.sequencePresentation?.annotationColors?.get(feature.id) ??
                (outlineOnly ? color : undefined)
            );
            if (textObj.style !== targetStyle) textObj.style = targetStyle;
            textObj.alpha = labelAlpha;
            const resolution = targetPillLabelTextResolution();
            if (textObj.resolution !== resolution) textObj.resolution = resolution;
            textObj.roundPixels = true;
            textObj.anchor.set(0.5, 0.5);
            textObj.x = labelPlacement.cx;
            textObj.y = labelPlacement.cy;
            textObj.rotation = 0;
            textObj.scale.set(1);
          }
        }
      }
      return;
    }

    const drawPts = this.standardFeatureDrawPoints(feature, endBp, pixelWidth, path, hitPts);
    this.setFeaturePolygonOutline(feature.id, drawPts);
    if (outlineOnly) {
      sink.strokePoly(drawPts, color, 0.9 * labelAlphaScale);
    } else {
      sink.fillPoly(drawPts, color, alpha);
    }

    const labelAlpha = this.overviewLabelAlpha() * labelAlphaScale;
    if (
      renderLabel &&
      this.shouldRenderFeatureText(path) &&
      labelAlpha > 0.01 &&
      pixelWidth > MIN_BAR_FOR_LABEL &&
      feature.displayName
    ) {
      const {
        cx: labelPosX,
        cy: labelPosY,
        visibleWidth: visW,
        fraction,
      } = visibleCenterFromPolygon(hitPts, state.width, state.height);
      const availW = visW - 8;

      const labelText = truncateForWidth(feature.displayName, availW, this.labelCache, feature.id);
      if (labelText) {
        if (path.isArcMode) {
          const centerBp = feature.start + featureLen * fraction;
          const textWidth = measurePillLabelTextWidth(labelText);
          this.renderCurvedLabel(
            labelText,
            centerBp,
            textWidth,
            feature,
            endBp,
            color,
            offset,
            path,
            labelAlpha,
            feature.start,
            endBp,
            state.sequencePresentation?.annotationColors?.get(feature.id) ??
              (outlineOnly ? color : undefined)
          );
          return;
        }

        const textObj = this.acquireLabel();
        textObj.text = labelText;
        const targetStyle = pillLabelTextStyle(
          color,
          undefined,
          state.sequencePresentation?.annotationColors?.get(feature.id) ??
            (outlineOnly ? color : undefined)
        );
        if (textObj.style !== targetStyle) textObj.style = targetStyle;
        textObj.alpha = labelAlpha;
        const resolution = targetPillLabelTextResolution();
        if (textObj.resolution !== resolution) textObj.resolution = resolution;
        textObj.roundPixels = true;
        textObj.anchor.set(0.5, 0.5);
        textObj.x = labelPosX;
        textObj.y = labelPosY;

        const outerCount = hitPts.length / 4;
        const midIdx = Math.floor(outerCount / 2);
        let labelAngle = 0;
        if (midIdx > 0 && midIdx < outerCount) {
          const dx = hitPts[midIdx * 2] - hitPts[(midIdx - 1) * 2];
          const dy = hitPts[midIdx * 2 + 1] - hitPts[(midIdx - 1) * 2 + 1];
          labelAngle = Math.atan2(dy, dx);
        }
        textObj.rotation = labelAngle;
        textObj.scale.set(1);
      }
    }
  }

  private drawTranscriptIntronChevrons(
    g: Graphics,
    feature: Feature,
    path: PathMapper,
    state: RenderState,
    alpha: number,

    clipRange?: { lo: number; hi: number }
  ): void {
    const exons = feature.exons ?? [];
    const dir = feature.direction;
    const drawArrow = dir === 'forward' || dir === 'reverse';
    if (exons.length <= 1 || !drawArrow || path.isArcMode) return;

    const offset = this.featureOffset(feature);
    const intronChevronColor =
      this.annotationColors?.get(feature.id) ??
      transcriptColorForMode('intronChevron', state.themeMode);
    const ppb = path.pixelsPerBp;

    const chevY = path.featureLabelPosAt(feature.start, offset).y;
    const visStart = path.viewStartBp;
    const visEnd = path.viewEndBp;
    const visMargin = Math.max(1, visEnd - visStart);
    const visLo = clipRange ? clipRange.lo : visStart - visMargin;
    const visHi = clipRange ? clipRange.hi : visEnd + visMargin;

    const BASE_UNIT_BP = 1 << 20;

    const MIN_SCREEN_PITCH = 50;

    const MIN_VISIBLE_WIDTH_PX = 12;
    const FULL_OPACITY_WIDTH_PX = 64;
    const CHEV_PX = 1.875;
    const chevHalf = 2.25;
    const forward = dir === 'forward';

    const targetBpPitch = MIN_SCREEN_PITCH / ppb;
    if (!Number.isFinite(targetBpPitch) || targetBpPitch <= 0) return;

    const level = Math.max(0, Math.floor(Math.log2(BASE_UNIT_BP / targetBpPitch)));
    const pitchBp = BASE_UNIT_BP / Math.pow(2, level);
    if (!Number.isFinite(pitchBp) || pitchBp <= 0) return;

    const baseChevronAlpha = alpha * 0.8;
    const fadeRange = FULL_OPACITY_WIDTH_PX - MIN_VISIBLE_WIDTH_PX;
    for (let i = 0; i < exons.length - 1; i++) {
      const intronS = exons[i].end;
      const intronE = exons[i + 1].start - 1;
      if (intronE < visLo || intronS > visHi) continue;
      const widthPx = (intronE - intronS) * ppb;

      if (widthPx < MIN_VISIBLE_WIDTH_PX) continue;

      const fadeProgress =
        widthPx >= FULL_OPACITY_WIDTH_PX ? 1 : (widthPx - MIN_VISIBLE_WIDTH_PX) / fadeRange;
      const chevronAlpha = baseChevronAlpha * fadeProgress;
      if (chevronAlpha <= 0) continue;
      g.setStrokeStyle({ width: 1, color: intronChevronColor, alpha: chevronAlpha });

      const drawLo = Math.max(intronS + 1, visLo);
      const drawHi = Math.min(intronE - 1, visHi);
      if (drawHi <= drawLo) continue;

      const firstK = Math.ceil(drawLo / pitchBp);
      const lastK = Math.floor(drawHi / pitchBp);

      let drewChevron = false;
      for (let k = firstK; k <= lastK; k++) {
        const centerBp = k * pitchBp;

        if (centerBp <= intronS || centerBp >= intronE) continue;
        const cx = path.bpCenterX(centerBp);
        const tipDx = forward ? CHEV_PX : -CHEV_PX;
        g.moveTo(cx - tipDx, chevY - chevHalf);
        g.lineTo(cx + tipDx, chevY);
        g.lineTo(cx - tipDx, chevY + chevHalf);
        drewChevron = true;
      }
      if (drewChevron) g.stroke();
    }
  }

  private drawRetainedTranscriptIntronConnectors(
    g: Graphics,
    feature: Feature,
    path: PathMapper,
    state: RenderState,
    alpha: number,

    clipRange?: { lo: number; hi: number }
  ): void {
    const exons = feature.exons ?? [];
    if (exons.length <= 1 || path.isArcMode) return;

    const offset = this.featureOffset(feature);
    const halfHeight = Math.max(1, (this.scaledBarHeight() / 2) * 0.12);
    const intronColor =
      this.annotationColors?.get(feature.id) ?? transcriptColorForMode('intron', state.themeMode);
    const visStart = path.viewStartBp;
    const visEnd = path.viewEndBp;
    const visMargin = Math.max(1, visEnd - visStart);
    const visLo = clipRange ? clipRange.lo : visStart - visMargin;
    const visHi = clipRange ? clipRange.hi : visEnd + visMargin;

    let drewConnector = false;
    for (let i = 0; i < exons.length - 1; i++) {
      const intronS = exons[i].end;
      const intronE = exons[i + 1].start - 1;
      const drawStart = Math.max(intronS, visLo);
      const drawEnd = Math.min(intronE, visHi);
      if (drawEnd <= drawStart) continue;
      if ((drawEnd - drawStart) * path.pixelsPerBp < 0.5) continue;
      g.poly(path.featurePolygonAt(drawStart, drawEnd, offset, halfHeight));
      drewConnector = true;
    }
    if (drewConnector) g.fill({ color: intronColor, alpha: alpha * 0.7 });
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
    const offset = this.featureOffset(feature);
    const outlineOnly = isOutlineOnlyFeature(feature);
    const halfHeight = this.scaledBarHeight() / 2;
    const cdsHalfH = halfHeight;
    const utrHalfH = Math.max(2, halfHeight * TRANSCRIPT_INTRON_STYLE.utrHeightRatio);
    const isNonCodingType = isNonCodingTranscriptType(feature.annotationTrackId ?? feature.type);
    const cdsSegments = feature.cds ?? [];
    const drawCdsBlocks = !isNonCodingType && cdsSegments.length > 0 && !outlineOnly;
    const exons = feature.exons ?? [];
    const dir = feature.direction;
    const drawArrow = dir === 'forward' || dir === 'reverse';
    const { visLo, visHi } = this.transcriptViewportBounds(path);
    const commands: OutlineCommand[] = [];

    const buildBlockPts = (
      segStart: number,
      segEnd: number,
      halfH: number,
      pointed: boolean
    ): number[] => {
      const segWidthPx = (segEnd - segStart) * path.pixelsPerBp;
      if (drawArrow && pointed) {
        const aw = this.directionalArrowWidth(segWidthPx, halfH * 2);
        if (segWidthPx > aw * 2) {
          const subFeature = { ...feature, start: segStart };
          return buildDirectionalPolygon(path, subFeature, segEnd, offset, aw, halfH);
        }
      }
      return path.featurePolygonAt(segStart, segEnd, offset, halfH);
    };

    const splitExon = (
      exStart: number,
      exEnd: number
    ): Array<{ s: number; e: number; kind: 'utr' | 'cds' }> => {
      if (!drawCdsBlocks) return [{ s: exStart, e: exEnd, kind: 'utr' }];
      const clipped = cdsSegments
        .map((c) => ({ s: Math.max(exStart, c.start - 1), e: Math.min(exEnd, c.end) }))
        .filter((c) => c.e > c.s)
        .sort((a, b) => a.s - b.s);
      if (clipped.length === 0) return [{ s: exStart, e: exEnd, kind: 'utr' }];
      const parts: Array<{ s: number; e: number; kind: 'utr' | 'cds' }> = [];
      let cursor = exStart;
      for (const c of clipped) {
        if (c.s > cursor) parts.push({ s: cursor, e: c.s, kind: 'utr' });
        parts.push({ s: c.s, e: c.e, kind: 'cds' });
        cursor = c.e;
      }
      if (cursor < exEnd) parts.push({ s: cursor, e: exEnd, kind: 'utr' });
      return parts;
    };

    for (const exon of exons) {
      const exStart = exon.start - 1;
      const exEnd = exon.end;
      if (exEnd < visLo || exStart > visHi) continue;
      const parts = splitExon(exStart, exEnd);
      const arrowPartIdx = dir === 'reverse' ? 0 : parts.length - 1;
      for (let p = 0; p < parts.length; p++) {
        const part = parts[p];
        const isCds = part.kind === 'cds';
        const halfH = isCds ? cdsHalfH : utrHalfH;
        const pointed = p === arrowPartIdx;
        commands.push({
          kind: 'poly',
          pts: buildBlockPts(part.s, part.e, halfH, pointed),
        });
      }
    }

    commands.push(...this.transcriptIntronLineOutlineCommands(feature, path, offset));
    return commands;
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
    renderCurvedLabelOnPath(
      this.curvedLabels,
      labelText,
      path,
      centerBp,
      textWidth,
      offset,
      rangeStartBp,
      rangeEndBp,
      LABEL_FONT_SIZE,
      textColor ?? pillLabelTextColor(color),
      1,
      alpha,
      `feature:${feature.id}`
    );
  }

  private acquireLabel(): Text {
    let t: Text;
    if (this.labelIndex < this.labelPool.length) {
      t = this.labelPool[this.labelIndex];
      t.visible = true;
    } else {
      t = new Text({
        text: '',
        style: pillLabelTextStyle(0xffffff),
        resolution: targetPillLabelTextResolution(),
      });
      this.container.addChild(t);
      this.labelPool.push(t);
    }
    this.labelIndex++;
    return t;
  }

  private buildPresentationDebugSnapshot(): AnnotationPresentationDebugSnapshot {
    return buildAnnotationPresentationDebug({
      requestedLayerTypes: this.annotationLayerTypesForPresentation(),
      renderSetLayerTypes: this.retainedLinear.lastDrawAudit?.renderSetLayerTypes ?? null,
      presentationVisible: this.presentationVisible,
      genomeLength: this.genomeLength,
      lastDrawAuditRange: this.retainedLinear.lastDrawAudit
        ? {
            viewStartBp: this.retainedLinear.lastDrawAudit.viewStartBp,
            viewEndBp: this.retainedLinear.lastDrawAudit.viewEndBp,
          }
        : null,
      runtimeGenomeWideTextureVisible: false,
      prebuiltGenomeWideTextureVisible: false,
      prebuiltGenomeWideTextureEligible: false,
      retainedLinearVisibleMeshCount:
        Number(this.retainedLinear.retainedLinearFeatureLayer?.isPresenting) +
        Number(this.retainedLinear.retainedLinearTranscriptLayer?.isPresenting),
      retainedTranscriptVisibleBlockCount: this.retainedLinear.retainedLinearTranscriptBlockCount,
      tilePyramidVectorVisibleLayerCount: 0,
      tilePyramidVectorPresenting: false,
      tilePyramidVectorPresentingBlockCount: 0,
      tilePyramidVectorCoverageLevel: null,
      tilePyramidVectorVisibleTileFirst: null,
      tilePyramidVectorVisibleTileLast: null,
      tilePyramidVectorExpectedVisibleTileCount: 0,
      tilePyramidVectorBuiltVisibleTileCount: 0,
      tilePyramidVectorMissingVisibleTileCount: 0,
      tilePyramidVectorCoverageComplete: true,
      overviewGlyphTilesPresenting: false,
      overviewGlyphTilesVisibleTileCount: 0,
      overviewGlyphTilesCoverageComplete: true,
      immediateGraphicsVisible: this.graphics.visible,
      lastDrawnFeatureCount: this.lastDrawnFeatureCount,
      immediateDrawnLayerTypes: [...this.lastImmediateDrawnLayerTypes],
    });
  }

  private auditAnnotationDraw(_state: RenderState): void {
    this.retainedLinear.lastFrameDoubleDraw = false;
  }

  getColdGestureSnapshot(): AnnotationOverlayColdGestureSnapshot {
    return {
      annotation: this.getAnnotationPolicyReadinessSnapshot(),
      retainedLinearTranscriptBlockCount: this.retainedLinear.retainedLinearTranscriptBlockCount,
      lastRenderMode: this.retainedLinear.lastRenderMode,
    } as unknown as AnnotationOverlayColdGestureSnapshot;
  }

  getAnnotationSearchFocusPresentationSnapshot(): AnnotationSearchFocusPresentationSnapshot {
    return {
      annotationSearchFocusResolvedTrackId: this.annotationSearchFocusResolvedTrackId,
      annotationSearchFocusResolvedCanonicalIdentity:
        this.annotationSearchFocusResolvedCanonicalIdentity,
      annotationSearchFocusPresentationLane: this.annotationSearchFocusPresentationLane,
    };
  }

  getDebugSnapshot(): AnnotationOverlayDebugSnapshot & {
    readonly floatingLabelFrame: FloatingAnnotationLabelFrameReceipt;
    readonly annotationMutationSectors: ReturnType<typeof renderAnnotationMutationSectors>;
    readonly interactionContours: readonly { featureId: number; points: readonly number[] }[];
  } {
    const presentation = this.buildPresentationDebugSnapshot();
    return {
      straightLabelCount: this.labelIndex,
      straightLabelAlphas: this.labelPool.slice(0, this.labelIndex).map((label) => label.alpha),
      straightLabelResolutions: this.labelPool
        .slice(0, this.labelIndex)
        .map((label) => label.resolution),
      curvedGlyphCount: this.curvedLabels.activeCount,
      curvedGlyphRotations: this.curvedLabels.activeRotations,
      curvedGlyphFontSizes: this.curvedLabels.activeFontSizes,
      curvedGlyphScales: this.curvedLabels.activeScales,
      curvedGlyphResolutions: this.curvedLabels.activeResolutions,
      curvedGlyphPositions: this.curvedLabels.activePositions,
      floatingLabelFrame: this.floatingLabels.frame,
      annotationMutationSectors: this.mutationSectorReceipt,
      overviewBinDrawCount: this.retainedLinear.overviewBinDrawCount,
      retainedLinearDataBuilds: this.retainedLinear.retainedLinearDataBuilds,
      retainedLinearBinCount: this.retainedLinear.retainedLinearBinCount,
      retainedLinearTranscriptBuilds: this.retainedLinear.retainedLinearTranscriptBuilds,
      retainedLinearTranscriptPacks: getRetainedLinearTranscriptPackDebugSnapshot().count,
      residentAnnotationPageCount: 0,
      residentAnnotationPageBytes: 0,
      residentAnnotationPageSnapshotApplies: 0,
      residentAnnotationPageFlatGraphSkips: 0,
      residentAnnotationViewportSelectionStatus: 'unavailable',
      residentAnnotationViewportSelectionQueries: 0,
      residentAnnotationViewportSelectedPageCount: 0,
      residentAnnotationViewportSelectedFeatureCount: 0,
      residentAnnotationViewportExpectedPageCount: 0,
      residentAnnotationViewportMissingPageCount: 0,
      residentAnnotationViewportCoverageComplete: false,
      residentAnnotationViewportProducerCoverageComplete: false,
      retainedLinearTranscriptBlockCount: this.retainedLinear.retainedLinearTranscriptBlockCount,
      retainedLinearTranscriptStaleHolds: this.retainedLinear.retainedLinearTranscriptStaleHolds,
      retainedLinearTranscriptLastBuildCause:
        this.retainedLinear.retainedLinearTranscriptLastBuildCause,
      retainedTranscriptDecorationBuilds: this.retainedTranscriptDecorationBuilds,
      featureCount: this.features.length,
      drawnFeatureCount: this.lastDrawnFeatureCount,
      immediateDrawnLayerTypes: [...this.lastImmediateDrawnLayerTypes].sort((a, b) =>
        a.localeCompare(b)
      ),
      hitRecords: this.hitCache.length,
      renderCalls: this.retainedLinear.renderCallCount,
      geometryRebuilds: this.retainedLinear.geometryRebuildCount,
      geometryCacheHits: this.retainedLinear.geometryCacheHitCount,
      lastRenderMode: this.retainedLinear.lastRenderMode,
      lastGeometryRebuildReasons: this.retainedLinear.lastGeometryRebuildReasons,
      annotationSearchFocusPresentationLane: this.annotationSearchFocusPresentationLane,
      annotationSearchFocusResolvedTrackId: this.annotationSearchFocusResolvedTrackId,
      annotationSearchFocusResolvedCanonicalIdentity:
        this.annotationSearchFocusResolvedCanonicalIdentity,
      lastInteractionOutlineCommandCount: this.lastInteractionOutlineCommandCount,
      interactionContours: this.lastInteractionContours,
      annotationSearchFocusMaskDrawCount: this.annotationSearchFocusMaskDrawCount,
      annotationSearchFocusPrimitiveDrawCount: this.annotationSearchFocusPrimitiveDrawCount,
      overviewAggregationEnabled: this.retainedLinear.lastOverviewAggregationEnabled,
      overviewAggregationCacheHit: this.retainedLinear.lastOverviewAggregationCacheHit,
      overviewPassthroughFeatureCount: this.retainedLinear.lastOverviewPassthroughFeatureCount,
      overviewDensityAtlasBinBp: this.retainedLinear.lastOverviewDensityAtlasBinBp,
      overviewDensityAtlasSampleScreenPx:
        this.retainedLinear.lastOverviewDensityAtlasSampleScreenPx,
      overviewDensityAtlasLevelCount: this.retainedLinear.lastOverviewDensityAtlasLevelCount,
      overviewDensityAtlasEstimatedBinCount:
        this.retainedLinear.lastOverviewDensityAtlasEstimatedBinCount,
      overviewDensityAtlasWasCoarsened: this.retainedLinear.lastOverviewDensityAtlasWasCoarsened,
      overviewDensityAtlasBudgetExceeded:
        this.retainedLinear.lastOverviewDensityAtlasBudgetExceeded,
      overviewLodCompressionBlend: this.retainedLinear.lastOverviewLodCompressionBlend,
      overviewLodFullShapeBlend: this.retainedLinear.lastOverviewLodFullShapeBlend,
      overviewCacheMs: this.retainedLinear.lastOverviewCacheMs,
      overviewImmediateBlendMs: this.retainedLinear.lastOverviewImmediateBlendMs,
      retainedLinearTranscriptVisibleFeatureCount:
        this.retainedLinear.retainedLinearTranscriptVisibleFeatureCount,
      retainedTranscriptDecorationsDrawn:
        this.retainedLinear.lastRetainedTranscriptDecorationsDrawn,
      retainedLinearSourceWindowStartBp:
        this.retainedLinear.retainedLinearSourceWindow?.startBp ?? null,
      retainedLinearSourceWindowEndBp:
        this.retainedLinear.retainedLinearSourceWindow?.endBp ?? null,
      retainedLinearSourceWindowFeatureCount:
        this.retainedLinear.retainedLinearSourceWindow?.features.length ?? 0,
      ...presentation,
      layout: annotationDebugLayoutSnapshot(this._layout, this.maxAnnotationLane, this.maxCdsLane),
      drawAudit: this.retainedLinear.lastDrawAudit,
    } as unknown as AnnotationOverlayDebugSnapshot & {
      readonly floatingLabelFrame: FloatingAnnotationLabelFrameReceipt;
      readonly annotationMutationSectors: ReturnType<typeof renderAnnotationMutationSectors>;
      readonly interactionContours: readonly { featureId: number; points: readonly number[] }[];
    };
  }

  private annotationLayerTypesForPresentation(): string[] {
    if (this.annotationRequestedLayerTypes.length > 0) return this.annotationRequestedLayerTypes;
    return normalizeAnnotationLayerTypes(this.features.map((feature) => feature.type));
  }

  hitTest(
    screenX: number,
    screenY: number,
    path: PathMapper,
    _state: RenderState
  ): OverlayHitResult | null {
    if (this.retainedLinear.retainedOverviewMode === 'retained') {
      const retainedHit = this.hitTestRetainedOverview(screenX, screenY, path);
      if (retainedHit) return retainedHit;
      const retainedTranscriptHit = this.hitTestRetainedLinearTranscripts(screenX, screenY, path);
      if (retainedTranscriptHit) return retainedTranscriptHit;
    }

    for (let i = this.hitCache.length - 1; i >= 0; i--) {
      const rec = this.hitCache[i];
      if (screenX < rec.xMin || screenX > rec.xMax || screenY < rec.yMin || screenY > rec.yMax)
        continue;
      if (rec.pts.length > 0 && !pointInPolygon(screenX, screenY, rec.pts)) continue;
      return {
        kind: 'feature',
        payload: { id: rec.id, start: rec.start, end: rec.end },
      };
    }
    return null;
  }

  private hitTestRetainedOverview(
    screenX: number,
    screenY: number,
    path: PathMapper
  ): OverlayHitResult | null {
    const bins = this.retainedLinear.retainedOverviewHitBins;
    const candidates = retainedOverviewHitCandidates(
      bins,
      path,
      screenX,
      screenY,
      this.genomeLength
    );
    const count = candidates ? candidates.length : bins.length;
    for (let position = 0; position < count; position += 1) {
      const i = candidates ? candidates[position] : bins.length - 1 - position;
      const bin = bins[i];
      if (bin.featureId == null || bin.featureStart == null || bin.featureEnd == null) continue;

      const pts = path.featurePolygonAt(bin.startBp, bin.endBp, bin.offset, bin.halfHeight);
      const bbox = computeBBox(pts);
      if (screenX < bbox.xMin || screenX > bbox.xMax || screenY < bbox.yMin || screenY > bbox.yMax)
        continue;
      if (!pointInPolygon(screenX, screenY, pts)) continue;
      return {
        kind: 'feature',
        payload: { id: bin.featureId, start: bin.featureStart, end: bin.featureEnd },
      };
    }
    return null;
  }

  private hitTestRetainedLinearTranscripts(
    screenX: number,
    screenY: number,
    path: PathMapper
  ): OverlayHitResult | null {
    const retainedSet = this.retainedLinear.retainedLinearTranscriptFeatureSet;
    if (!retainedSet || retainedSet.size === 0 || path.isArcMode) return null;

    const halfHeight = this.scaledBarHeight() / 2;
    const visible = this.featuresInRange(path.viewStartBp, path.viewEndBp);

    for (let i = visible.length - 1; i >= 0; i--) {
      const feature = visible[i];
      if (!retainedSet.has(feature) || !isTranscript(feature)) continue;

      let offset: number;
      try {
        offset = this.featureOffset(feature);
      } catch {
        continue;
      }
      const cy = path.featureLabelPosAt(path.viewStartBp, offset).y;

      if (screenY < cy - halfHeight || screenY > cy + halfHeight) continue;

      const exons = (feature.exons ?? []).map((exon) => ({
        x1: path.bpLeftX(exon.start - 1),
        x2: path.bpLeftX(exon.end),
      }));
      const intronGaps: { x1: number; x2: number }[] = [];
      for (const { startBp, endBp } of this.transcriptIntronGapRanges(feature, path)) {
        intronGaps.push({ x1: path.bpLeftX(startBp), x2: path.bpLeftX(endBp) });
      }
      if (transcriptHitTest(screenX, screenY, { cy, halfHeight, exons, intronGaps })) {
        return {
          kind: 'feature',
          payload: { id: feature.id, start: feature.start, end: feature.end },
        };
      }
    }

    return null;
  }

  getChangeDecorationSnapshot(): { commandCount: number; featureIds: readonly number[] } {
    return {
      commandCount: this.changeDecorationCommandCount,
      featureIds: this.changeDecorationFeatureIds,
    };
  }

  destroy(): void {
    this.frameRequester = null;
    this.overviewCache.invalidate();
    this.releaseRetiredGpuResourcesAfterPresent(true);
    this.graphics.destroy();
    this.retainedTranscriptDecorationGraphics.destroy();
    this.mutationSectorGraphics.destroy();
    this.floatingLabels.destroy();
    this.annotationSearchFocusGraphics.destroy();
    this.interactionGraphics.destroy();
    this.changeDecorationGraphics.destroy();
    this.retainedLinear.retainedOverviewLayer?.destroy();
    this.retainedLinear.retainedLinearFeatureLayer?.destroy();
    this.retainedLinear.retainedLinearTranscriptLayer?.destroy();
    this.curvedLabels.destroy();
    for (const t of this.labelPool) destroyPixiText(t);
    this.container.destroy();
  }
}
