import { BitmapFontManager, BitmapText, Container, Graphics, Text, TextStyle } from 'pixi.js';
import type { PathMapper } from '../shared/path-mapper';
import { destroyPixiText } from '../shared/pixi-text-lifecycle';
import { LABEL_FONT_FAMILY, LABEL_FONT_WEIGHT } from '../shared/theme';
import {
  PILL_LABEL_FONT_SIZE,
  measurePillLabelTextWidth,
  pillLabelTextStyle,
  targetPillLabelTextResolution,
  PILL_LABEL_EMPHASIS_STROKE_PX,
  PILL_LABEL_TEXT_DARK_THEME,
} from '../shared/label-pill';
import {
  FLOATING_LABEL_TANGENT_STEPS,
  FLOATING_LABEL_TANGENT_STEP_PX,
  floatingAnnotationLabelDensityTarget,
  floatingAnnotationVisibleLeaderSegments,
  floatingAnnotationLabelPlanFromDecisions,
  floatingLabelOutwardAnchor,
  planFloatingAnnotationLabels,
  precomputeFloatingAnnotationLabelAssignments,
  rankFloatingAnnotationLabelFeatureIds,
  type FloatingAnnotationLabelCandidate,
  type FloatingAnnotationLabelDecision,
  type FloatingAnnotationLabelDescriptor,
  type FloatingAnnotationLabelAssignmentPlan,
  type FloatingAnnotationLabelPlacementOption,
  type FloatingAnnotationLabelOutlineLookup,
  type FloatingAnnotationLabelPlan,
} from './floating-annotation-label-layout';
import type {
  FloatingAnnotationLabelLayoutWorkerRequest,
  FloatingAnnotationLabelLayoutWorkerResponse,
} from './floating-annotation-label-layout-worker';
import FloatingAnnotationLabelLayoutWorker from './floating-annotation-label-layout-worker?worker&inline';
import {
  planCircularColumnLabels,
  type FloatingLabelColumnRing,
} from './floating-annotation-label-columns';
import { FloatingAnnotationClearanceIndex } from './floating-annotation-clearance-index';
import { computeBBox } from './hit-testing';
import { isSplicedFeatureCached as isSplicedFeature } from '../shared/feature-splice-cache';
import { type Feature, type RenderState } from '../../../types';
import { time as ptime } from '../../../perf-log';

const MIN_BAR_FOR_LABEL = 30;
const FLOATING_LABEL_COLUMN_RING_GAP_PX = 6;
const FLOATING_LABEL_COLUMN_GUTTER_ALLOWANCE_PX = 24;
const FLOATING_LABEL_COLUMN_MIN_SIDE_ROOM_PX = 40;
const FLOATING_LABEL_PRELOAD_VIEWPORTS = 0.5;
const FLOATING_LABEL_TEXT_HEIGHT_PX = PILL_LABEL_FONT_SIZE + 4;
const FLOATING_LABEL_MAX_TEXT_WIDTH_PX = 180;
const FLOATING_LABEL_LEADER_LIGHT = 0x9ca3af;
const FLOATING_LABEL_LEADER_DARK = 0x6b7280;
const FLOATING_LABEL_BITMAP_FONT = 'dnaforge-floating-annotation-label-v1';
const FLOATING_LABEL_BITMAP_FONT_EMPHASIS = 'dnaforge-floating-annotation-label-emphasis-v1';
const FLOATING_LABEL_BITMAP_CHARACTERS = /^[\x20-\x7e…]*$/;
const FLOATING_LABEL_ZOOM_BANDS_PER_OCTAVE = 1;
const FLOATING_LABEL_ASSIGNMENT_CACHE_LIMIT = 12;
const FLOATING_LABEL_OVERVIEW_PREWARM_BAND_COUNT = 10;
const FLOATING_LABEL_OVERVIEW_PREWARM_MIN_GENOME_BP = 250_000;
const FLOATING_LABEL_PREWARM_SLICE_MS = 4;

const FLOATING_LABEL_LEADER_INTERACTION_WIDTH_PX = 1.5;

const FLOATING_LABEL_EMPHASIS_STROKE_PX = PILL_LABEL_EMPHASIS_STROKE_PX;

export function floatingLabelLeaderInteractionWidth(
  hovered: boolean,
  selected: boolean
): number | null {
  return hovered || selected ? FLOATING_LABEL_LEADER_INTERACTION_WIDTH_PX : null;
}

export function floatingLabelEmphasized(state: RenderState, featureId: number): boolean {
  return state.hoveredId === featureId || state.selectedIds.has(featureId);
}

const FLOATING_LABEL_TEXT_DARK = PILL_LABEL_TEXT_DARK_THEME;
const FLOATING_LABEL_TEXT_LIGHT = 0x374151;

function floatingLabelTextColor(state: RenderState, featureId: number): number {
  return (
    state.sequencePresentation?.annotationColors?.get(featureId) ??
    (state.themeMode === 'dark' ? FLOATING_LABEL_TEXT_DARK : FLOATING_LABEL_TEXT_LIGHT)
  );
}

const FLOATING_LABEL_SYNC_BUILD_MAX_FEATURES = 250;

const FLOATING_LABEL_PREWARM_MIN_SLICE_MS = 1;

export interface FloatingAnnotationLabelFrameReceipt {
  readonly contract: 'floating-annotation-label-frame.v3';
  readonly cameraKey: string;
  readonly pathMode: 'circular' | 'linear';
  readonly preloadMarginPx: number;
  readonly sourceFeatureCount: number;
  readonly windowFeatureCount: number;
  readonly assignmentBuildCount: number;
  readonly assignmentPrewarmBuildCount: number;
  readonly assignmentPrewarmMaxMs: number;
  readonly assignmentCacheKey: string | null;
  readonly assignmentZoomBandIndex: number | null;
  readonly assignmentZoomBandMinPixelsPerBp: number | null;
  readonly assignmentZoomBandMaxPixelsPerBp: number | null;

  readonly requestedZoomBandIndex: number | null;

  readonly assignmentSubstituted: boolean;

  readonly assignmentPlanRevision: number;
  readonly densityPoolCount: number;
  readonly densityTargetCount: number;
  readonly densitySelectedCount: number;
  readonly assignmentCacheEntryCount: number;
  readonly assignmentCacheKeys: readonly string[];
  readonly assignmentCandidateCount: number;
  readonly assignmentAssignedCount: number;
  readonly assignmentSearchStepCount: number;
  readonly assignmentSearchBudgetExhaustionCount: number;
  readonly assignmentFingerprint: string;
  readonly candidateCount: number;
  readonly decisionCount: number;
  readonly placedCount: number;
  readonly rejectedCount: number;
  readonly fingerprint: string;
  readonly decisions: readonly FloatingAnnotationLabelDecision[];
}

export interface FloatingAnnotationLabelObstacle {
  readonly xMin: number;
  readonly xMax: number;
  readonly yMin: number;
  readonly yMax: number;
  readonly owner: string;
  readonly featureId?: number;
}

export interface FloatingAnnotationCalloutRecord {
  readonly featureId: number;
  readonly text: string;
  readonly bounds: {
    readonly xMin: number;
    readonly xMax: number;
    readonly yMin: number;
    readonly yMax: number;
  };
}

export interface FloatingAnnotationLabelPresenterHost {
  readonly container: Container;
  readonly features: () => readonly Feature[];
  readonly candidatesForPath: (path: PathMapper, preloadMargin: number) => readonly Feature[];
  readonly featuresInRange: (startBp: number, endBp: number) => readonly Feature[];
  readonly genomeLength: () => number;
  readonly genomeCircular: () => boolean;
  readonly featureOffset: (feature: Feature) => number;
  readonly barHeight: () => number;
  readonly cdsDetailProgress: () => number;
  readonly shouldRenderFeatureText: (path: PathMapper) => boolean;
  readonly overviewLabelAlpha: () => number;
  readonly clearCalloutRecords: (state: RenderState) => void;
  readonly bodyObstacles: () => readonly FloatingAnnotationLabelObstacle[];
  readonly labelObstacles: (state: RenderState) => readonly FloatingAnnotationLabelObstacle[];
  readonly recordCallout: (state: RenderState, record: FloatingAnnotationCalloutRecord) => void;
  readonly outwardLaneExtentPx?: () => number;
  readonly bodyOutlineLookup?: () => FloatingAnnotationLabelOutlineLookup;

  readonly requestFrame?: () => void;
}

interface FloatingAnnotationBodyDescriptor extends FloatingAnnotationLabelDescriptor {
  readonly startBp: number;
  readonly endBp: number;
  readonly offset: number;
}

interface FloatingAnnotationLabelAssignmentCache {
  readonly key: string;
  readonly zoomBandIndex: number;
  readonly zoomBandMinPixelsPerBp: number;
  readonly zoomBandMaxPixelsPerBp: number;
  readonly densityPoolCount: number;
  readonly densityTargetCount: number;
  readonly descriptorsByFeatureId: ReadonlyMap<number, FloatingAnnotationBodyDescriptor>;
  readonly plan: FloatingAnnotationLabelAssignmentPlan;
}

interface FloatingAnnotationLabelZoomBand {
  readonly index: number;
  readonly minPixelsPerBp: number;
  readonly maxPixelsPerBp: number;
}

interface FloatingAnnotationLabelPrewarmRequest {
  readonly generation: number;
  readonly isArcMode: boolean;
  readonly zoomBand: FloatingAnnotationLabelZoomBand;
  readonly cacheKey: string;
}

interface FloatingAnnotationLabelPreparedAssignment {
  readonly minPixelsPerBp: number;
  readonly maxPixelsPerBp: number;
  readonly densityPoolCount: number;
  readonly densityTargetCount: number;
  readonly descriptors: readonly FloatingAnnotationLabelDescriptor[];
  readonly descriptorsByFeatureId: ReadonlyMap<number, FloatingAnnotationBodyDescriptor>;
}

interface FloatingAnnotationLabelActivePrewarm {
  readonly request: FloatingAnnotationLabelPrewarmRequest;
  readonly requestId: number;
  readonly prepared: FloatingAnnotationLabelPreparedAssignment;
}

interface FloatingAnnotationLabelPreparingPrewarm {
  readonly request: FloatingAnnotationLabelPrewarmRequest;
  readonly minPixelsPerBp: number;
  readonly maxPixelsPerBp: number;
  readonly sourceFeatures: readonly Feature[];
  readonly densityPoolCount: number;
  readonly densityTargetCount: number;
  readonly descriptors: FloatingAnnotationLabelDescriptor[];
  readonly descriptorsByFeatureId: Map<number, FloatingAnnotationBodyDescriptor>;
  featureIndex: number;
}

function emptyFloatingLabelFrame(): FloatingAnnotationLabelFrameReceipt {
  return {
    contract: 'floating-annotation-label-frame.v3',
    cameraKey: '',
    pathMode: 'circular',
    preloadMarginPx: 0,
    sourceFeatureCount: 0,
    windowFeatureCount: 0,
    assignmentBuildCount: 0,
    assignmentPrewarmBuildCount: 0,
    assignmentPrewarmMaxMs: 0,
    assignmentCacheKey: null,
    assignmentZoomBandIndex: null,
    assignmentZoomBandMinPixelsPerBp: null,
    assignmentZoomBandMaxPixelsPerBp: null,
    requestedZoomBandIndex: null,
    assignmentSubstituted: false,
    assignmentPlanRevision: 0,
    densityPoolCount: 0,
    densityTargetCount: 0,
    densitySelectedCount: 0,
    assignmentCacheEntryCount: 0,
    assignmentCacheKeys: [],
    assignmentCandidateCount: 0,
    assignmentAssignedCount: 0,
    assignmentSearchStepCount: 0,
    assignmentSearchBudgetExhaustionCount: 0,
    assignmentFingerprint: '',
    candidateCount: 0,
    decisionCount: 0,
    placedCount: 0,
    rejectedCount: 0,
    fingerprint: '',
    decisions: [],
  };
}

function withLazyFingerprint(
  frame: Omit<FloatingAnnotationLabelFrameReceipt, 'fingerprint'>,
  plan: FloatingAnnotationLabelPlan
): FloatingAnnotationLabelFrameReceipt {
  return Object.defineProperty(frame, 'fingerprint', {
    enumerable: true,
    configurable: true,
    get: () => plan.fingerprint,
  }) as FloatingAnnotationLabelFrameReceipt;
}

function floatingAnnotationLabelZoomBand(pixelsPerBp: number): FloatingAnnotationLabelZoomBand {
  const positivePixelsPerBp = Math.max(pixelsPerBp, 1e-12);
  const rawIndex = Math.log2(positivePixelsPerBp) * FLOATING_LABEL_ZOOM_BANDS_PER_OCTAVE;
  const nearestInteger = Math.round(rawIndex);
  const index =
    Math.abs(rawIndex - nearestInteger) <= 1e-10 ? nearestInteger : Math.floor(rawIndex);
  return floatingAnnotationLabelZoomBandForIndex(index);
}

function floatingAnnotationLabelZoomBandForIndex(index: number): FloatingAnnotationLabelZoomBand {
  return {
    index,
    minPixelsPerBp: 2 ** (index / FLOATING_LABEL_ZOOM_BANDS_PER_OCTAVE),
    maxPixelsPerBp: 2 ** ((index + 1) / FLOATING_LABEL_ZOOM_BANDS_PER_OCTAVE),
  };
}

let floatingLabelBitmapFontReady = false;
const floatingLabelBitmapStyles = new Map<string, TextStyle>();

function ensureFloatingLabelBitmapFont(): string | null {
  if (typeof WebGLRenderingContext === 'undefined') return null;
  if (!floatingLabelBitmapFontReady) {
    for (const [name, stroke] of [
      [FLOATING_LABEL_BITMAP_FONT, undefined],
      [
        FLOATING_LABEL_BITMAP_FONT_EMPHASIS,
        { color: 0xffffff, width: FLOATING_LABEL_EMPHASIS_STROKE_PX },
      ],
    ] as const) {
      BitmapFontManager.install({
        name,
        style: new TextStyle({
          fontFamily: LABEL_FONT_FAMILY,
          fontSize: PILL_LABEL_FONT_SIZE,
          fontWeight: LABEL_FONT_WEIGHT,
          fill: 0xffffff,
          ...(stroke ? { stroke } : {}),
        }),
        chars: [...BitmapFontManager.ASCII, '…'],
        resolution: targetPillLabelTextResolution(),
        padding: 3,
        skipKerning: false,
        dynamicFill: true,
        textureStyle: { scaleMode: 'linear' },
      });
    }
    floatingLabelBitmapFontReady = true;
  }
  return FLOATING_LABEL_BITMAP_FONT;
}

function floatingLabelBitmapFontFor(emphasized: boolean): string {
  return emphasized ? FLOATING_LABEL_BITMAP_FONT_EMPHASIS : FLOATING_LABEL_BITMAP_FONT;
}

function floatingLabelBitmapStyle(fontName: string, color: number): TextStyle {
  const key = `${fontName}:${color}`;
  let style = floatingLabelBitmapStyles.get(key);
  if (!style) {
    style = new TextStyle({
      fontFamily: fontName,
      fontSize: PILL_LABEL_FONT_SIZE,
      fontWeight: LABEL_FONT_WEIGHT,
      fill: color,
    });
    floatingLabelBitmapStyles.set(key, style);
  }
  return style;
}

function outsideRing(
  obstacle: {
    readonly xMin: number;
    readonly xMax: number;
    readonly yMin: number;
    readonly yMax: number;
  },
  ring: FloatingLabelColumnRing
): boolean {
  const nearestX = Math.min(Math.max(ring.center.x, obstacle.xMin), obstacle.xMax);
  const nearestY = Math.min(Math.max(ring.center.y, obstacle.yMin), obstacle.yMax);
  return Math.hypot(nearestX - ring.center.x, nearestY - ring.center.y) >= ring.radius;
}

export class FloatingAnnotationLabelPresenter {
  private readonly leaderGraphics = new Graphics();
  private readonly hoverLeaderGraphics = new Graphics();

  private readonly bitmapLabelsByFeature = new Map<number, BitmapText>();
  private readonly textLabelsByFeature = new Map<number, Text>();
  private spareBitmapLabels: BitmapText[] = [];
  private spareTextLabels: Text[] = [];
  private readonly labelsUsedThisFrame = new Set<number>();
  private windowFeatureCount = 0;
  private readonly assignmentCaches = new Map<string, FloatingAnnotationLabelAssignmentCache>();
  private assignmentGeneration = 0;
  private assignmentPrewarmBuilds = 0;
  private assignmentPrewarmMaxMs = 0;
  private readonly prewarmQueue: FloatingAnnotationLabelPrewarmRequest[] = [];
  private readonly prewarmKeys = new Set<string>();
  private prewarmIdleHandle: number | null = null;
  private prewarmWorker: Worker | null = null;
  private readonly activePrewarms = new Map<number, FloatingAnnotationLabelActivePrewarm>();
  private preparingPrewarm: FloatingAnnotationLabelPreparingPrewarm | null = null;
  private prewarmRequestId = 0;
  private assignmentBuilds = 0;
  private assignmentPlanRevision = 0;
  private lastRequestedCacheKey: string | null = null;
  private lastRequestedZoomBandIndex: number | null = null;
  private lastAssignmentSubstituted = false;
  private layoutKey = '';
  private clearanceIndex: FloatingAnnotationClearanceIndex | null = null;
  private priorityFeatures: Feature[] = [];
  private readonly priorityRankByFeatureId = new Map<number, number>();
  private readonly textMetrics = new Map<
    string,
    { readonly text: string; readonly width: number } | null
  >();
  private _frame: FloatingAnnotationLabelFrameReceipt = emptyFloatingLabelFrame();
  private visibleLeaderSegments: ReturnType<typeof floatingAnnotationVisibleLeaderSegments> = [];
  private leadersVisibleForTests = true;
  private columnGutter = 0;

  constructor(private readonly host: FloatingAnnotationLabelPresenterHost) {
    host.container.addChild(this.leaderGraphics);
    host.container.addChild(this.hoverLeaderGraphics);
  }

  renderInteractionLeaders(state: RenderState): void {
    const graphics = this.hoverLeaderGraphics;
    graphics.clear();
    graphics.visible = false;
    if (!this.leadersVisibleForTests) return;
    const color =
      state.themeMode === 'dark' ? FLOATING_LABEL_LEADER_DARK : FLOATING_LABEL_LEADER_LIGHT;
    let drawn = false;
    const drawLeader = (featureId: number): void => {
      const width = floatingLabelLeaderInteractionWidth(
        state.hoveredId === featureId,
        state.selectedIds.has(featureId)
      );
      if (width === null) return;
      const segments = this.leaderSegmentsFor(featureId);
      if (segments.length === 0) return;
      for (const segment of segments) {
        graphics.moveTo(segment.start.x, segment.start.y).lineTo(segment.end.x, segment.end.y);
      }
      graphics.stroke({ width, color, alpha: 1 });
      drawn = true;
    };
    for (const featureId of state.selectedIds) drawLeader(featureId);
    if (state.hoveredId !== null && !state.selectedIds.has(state.hoveredId)) {
      drawLeader(state.hoveredId);
    }
    graphics.visible = drawn;
    this.applyLabelEmphasis(state);
  }

  private applyLabelEmphasis(state: RenderState): void {
    for (const [featureId, label] of this.bitmapLabelsByFeature) {
      if (!label.visible) continue;
      const style = floatingLabelBitmapStyle(
        floatingLabelBitmapFontFor(floatingLabelEmphasized(state, featureId)),
        floatingLabelTextColor(state, featureId)
      );
      if (label.style !== style) label.style = style;
    }
    for (const [featureId, label] of this.textLabelsByFeature) {
      if (!label.visible) continue;
      const style = pillLabelTextStyle(
        0xffffff,
        undefined,
        floatingLabelTextColor(state, featureId),
        floatingLabelEmphasized(state, featureId)
      );
      if (label.style !== style) label.style = style;
    }
  }

  renderHoverLeader(state: RenderState): void {
    this.renderInteractionLeaders(state);
  }

  leaderSegmentsFor(featureId: number): ReturnType<typeof floatingAnnotationVisibleLeaderSegments> {
    return this.visibleLeaderSegments.filter((segment) => segment.featureId === featureId);
  }

  hoveredLeaderSegments(
    featureId: number
  ): ReturnType<typeof floatingAnnotationVisibleLeaderSegments> {
    return this.leaderSegmentsFor(featureId);
  }

  get frame(): FloatingAnnotationLabelFrameReceipt {
    return this._frame;
  }

  setLeadersVisibleForTests(visible: boolean): void {
    this.leadersVisibleForTests = visible;
    this.leaderGraphics.visible = visible;
    if (!visible) this.hoverLeaderGraphics.visible = false;
  }

  setLayoutKey(layoutKey: string): void {
    if (layoutKey === this.layoutKey) return;
    this.layoutKey = layoutKey;
    this.invalidateAssignments();
    if (this.host.features().length > 0) {
      this.scheduleOverviewAssignmentPrewarm(this.host.genomeCircular());
    }
  }

  loadGenome(): void {
    this.invalidateAssignments();
    this.assignmentBuilds = 0;
    this.assignmentPrewarmBuilds = 0;
    this.assignmentPrewarmMaxMs = 0;
    this.rebuildPriorities();
    if (this.layoutKey) this.scheduleOverviewAssignmentPrewarm(this.host.genomeCircular());
  }

  clear(): void {
    this.leaderGraphics.clear();
    this.leaderGraphics.visible = false;
    this.hoverLeaderGraphics.clear();
    this.hoverLeaderGraphics.visible = false;
    this.visibleLeaderSegments = [];
    this._frame = emptyFloatingLabelFrame();
    this.labelsUsedThisFrame.clear();
    for (const label of this.bitmapLabelsByFeature.values()) label.visible = false;
    for (const label of this.textLabelsByFeature.values()) label.visible = false;
  }

  private cancelAssignmentPrewarm(): void {
    if (this.prewarmIdleHandle !== null && typeof window !== 'undefined') {
      window.cancelIdleCallback(this.prewarmIdleHandle);
    }
    this.prewarmWorker?.terminate();
    this.prewarmWorker = null;
    this.activePrewarms.clear();
    this.preparingPrewarm = null;
    this.prewarmIdleHandle = null;
    this.prewarmQueue.length = 0;
    this.prewarmKeys.clear();
  }

  private invalidateAssignments(): void {
    this.cancelAssignmentPrewarm();
    this.assignmentCaches.clear();
    this.clearanceIndex = null;
    this.assignmentGeneration += 1;
  }

  private labelText(displayName: string): { text: string; width: number } | null {
    const cached = this.textMetrics.get(displayName);
    if (cached !== undefined || this.textMetrics.has(displayName)) return cached ?? null;
    const fullWidth = measurePillLabelTextWidth(displayName);
    if (fullWidth <= FLOATING_LABEL_MAX_TEXT_WIDTH_PX) {
      const result = { text: displayName, width: fullWidth };
      this.textMetrics.set(displayName, result);
      return result;
    }
    for (let length = displayName.length - 1; length > 0; length--) {
      const text = `${displayName.slice(0, length)}…`;
      const width = measurePillLabelTextWidth(text);
      if (width <= FLOATING_LABEL_MAX_TEXT_WIDTH_PX) {
        const result = { text, width };
        this.textMetrics.set(displayName, result);
        return result;
      }
    }
    this.textMetrics.set(displayName, null);
    return null;
  }

  private bodyRange(feature: Feature): {
    startBp: number;
    endBp: number;
    lengthBp: number;
  } | null {
    if (isSplicedFeature(feature) && feature.segments && feature.segments.length > 0) {
      let largest = feature.segments[0];
      for (let index = 1; index < feature.segments.length; index++) {
        const segment = feature.segments[index];
        if (segment.end - segment.start > largest.end - largest.start) largest = segment;
      }
      const startBp = largest.start - 1;
      const endBp = largest.end;
      return endBp > startBp ? { startBp, endBp, lengthBp: endBp - startBp } : null;
    }

    const genomeLength = this.host.genomeLength();
    const endBp = feature.end > feature.start ? feature.end : feature.end + genomeLength;
    const lengthBp = endBp - feature.start;
    return lengthBp > 0 ? { startBp: feature.start, endBp, lengthBp } : null;
  }

  private rebuildPriorities(): void {
    const features = this.host.features();
    const featureById = new Map(features.map((feature) => [feature.id, feature]));
    let widestLabel = 0;
    const rankedIds = ptime('annotation.floating-label-priorities', () =>
      rankFloatingAnnotationLabelFeatureIds(
        features.flatMap((feature) => {
          if (!feature.displayName) return [];
          const bodyRange = this.bodyRange(feature);
          if (!bodyRange) return [];
          const measured = this.labelText(feature.displayName);
          if (measured) widestLabel = Math.max(widestLabel, measured.width);
          return [
            {
              featureId: feature.id,
              sequenceCenterBp: bodyRange.startBp + bodyRange.lengthBp / 2,
            },
          ];
        }),
        this.host.genomeLength()
      )
    );
    this.columnGutter =
      widestLabel > 0 ? Math.ceil(widestLabel + FLOATING_LABEL_COLUMN_GUTTER_ALLOWANCE_PX) : 0;
    this.priorityFeatures = rankedIds.flatMap((featureId) => {
      const feature = featureById.get(featureId);
      return feature ? [feature] : [];
    });
    this.priorityRankByFeatureId.clear();
    this.priorityFeatures.forEach((feature, rank) => {
      this.priorityRankByFeatureId.set(feature.id, rank);
    });
  }

  private preloadMargin(state: RenderState): number {
    return Math.max(0, state.width * FLOATING_LABEL_PRELOAD_VIEWPORTS);
  }

  private descriptor(
    feature: Feature,
    minPixelsPerBp: number,
    maxPixelsPerBp: number
  ): FloatingAnnotationBodyDescriptor | null {
    if (!feature.displayName || (feature.type === 'CDS' && this.host.cdsDetailProgress() > 0.01)) {
      return null;
    }
    const bodyRange = this.bodyRange(feature);
    if (!bodyRange) return null;
    const minPixelWidth = bodyRange.lengthBp * minPixelsPerBp;
    const maxPixelWidth = bodyRange.lengthBp * maxPixelsPerBp;
    if (
      !Number.isFinite(minPixelWidth) ||
      !Number.isFinite(maxPixelWidth) ||
      minPixelWidth > MIN_BAR_FOR_LABEL
    ) {
      return null;
    }

    const measured = this.labelText(feature.displayName);
    if (!measured) return null;
    const offset = this.host.featureOffset(feature);
    const outwardSide = offset <= 0 ? -1 : 1;
    const outwardRail = offset + outwardSide * (this.host.barHeight() / 2);
    return {
      featureId: feature.id,
      startBp: bodyRange.startBp,
      endBp: bodyRange.endBp,
      offset,
      text: measured.text,
      stableOrder: [this.priorityRankByFeatureId.get(feature.id) ?? feature.start, feature.id],
      sequenceCenterBp: bodyRange.startBp + bodyRange.lengthBp / 2,
      outwardSide,
      textWidth: measured.width,
      textHeight: FLOATING_LABEL_TEXT_HEIGHT_PX,
      placementOptions: [
        {
          tangentStep: 0,
          layoutCenterBp: bodyRange.startBp + bodyRange.lengthBp / 2,
          outwardClearance: 0,
          outwardRail,
        },
      ],
    };
  }

  private localOutwardClearance(
    descriptor: FloatingAnnotationBodyDescriptor,
    ownOuterEdge: number,
    minPixelsPerBp: number,
    layoutCenterMinBp: number,
    layoutCenterMaxBp: number
  ): number {
    const halfLabelSpanBp = (descriptor.textWidth / 2 + 3) / Math.max(minPixelsPerBp, 1e-9);
    const rawStart = Math.min(layoutCenterMinBp, layoutCenterMaxBp) - halfLabelSpanBp;
    const rawEnd = Math.max(layoutCenterMinBp, layoutCenterMaxBp) + halfLabelSpanBp;
    const genomeLength = this.host.genomeLength();
    const ranges: Array<readonly [number, number]> = [];
    if (!this.host.genomeCircular() || genomeLength <= 0) {
      ranges.push([Math.max(0, rawStart), Math.min(genomeLength, rawEnd)]);
    } else if (rawEnd - rawStart >= genomeLength) {
      ranges.push([0, genomeLength]);
    } else {
      const start = ((rawStart % genomeLength) + genomeLength) % genomeLength;
      const span = rawEnd - rawStart;
      const end = start + span;
      if (end <= genomeLength) ranges.push([start, end]);
      else ranges.push([start, genomeLength], [0, end - genomeLength]);
    }

    let outermostEdge = ownOuterEdge;
    const clearanceIndex = (this.clearanceIndex ??= new FloatingAnnotationClearanceIndex(
      this.host.features(),
      genomeLength,
      this.host.genomeCircular(),
      this.host.featureOffset,
      this.host.barHeight()
    ));
    for (const [start, end] of ranges) {
      if (end <= start) continue;
      const magnitude = clearanceIndex.maxOutwardMagnitude(descriptor.outwardSide, start, end);
      if (magnitude === null) continue;
      const nearbyOuterEdge = descriptor.outwardSide * magnitude;
      outermostEdge =
        descriptor.outwardSide < 0
          ? Math.min(outermostEdge, nearbyOuterEdge)
          : Math.max(outermostEdge, nearbyOuterEdge);
    }
    return Math.abs(outermostEdge - ownOuterEdge);
  }

  private assignmentCacheKey(
    isArcMode: boolean,
    zoomBand: FloatingAnnotationLabelZoomBand
  ): string {
    return [
      isArcMode ? 'circular' : 'linear',
      zoomBand.index,
      this.host.cdsDetailProgress() > 0.01 ? 'cds-detail' : 'overview',
      this.layoutKey,
    ].join('|');
  }

  private prepareAssignment(
    zoomBand: FloatingAnnotationLabelZoomBand
  ): FloatingAnnotationLabelPreparedAssignment {
    const minPixelsPerBp = zoomBand.minPixelsPerBp;
    const maxPixelsPerBp = zoomBand.maxPixelsPerBp;
    const densityPoolCount = this.priorityFeatures.length;
    const densityTargetCount = floatingAnnotationLabelDensityTarget({
      genomeLength: this.host.genomeLength(),
      bandMinPixelsPerBp: minPixelsPerBp,
      maxCandidates: densityPoolCount,
    });
    const descriptors: FloatingAnnotationLabelDescriptor[] = [];
    const descriptorsByFeatureId = new Map<number, FloatingAnnotationBodyDescriptor>();
    ptime('annotation.floating-label-assignment-descriptors', () => {
      for (const feature of this.priorityFeatures) {
        const prepared = this.prepareAssignmentDescriptor(feature, minPixelsPerBp, maxPixelsPerBp);
        if (!prepared) continue;
        descriptors.push(prepared);
        descriptorsByFeatureId.set(feature.id, prepared);
        if (descriptors.length >= densityTargetCount) break;
      }
    });
    return {
      minPixelsPerBp,
      maxPixelsPerBp,
      densityPoolCount,
      densityTargetCount,
      descriptors,
      descriptorsByFeatureId,
    };
  }

  private prepareAssignmentDescriptor(
    feature: Feature,
    minPixelsPerBp: number,
    maxPixelsPerBp: number
  ): FloatingAnnotationBodyDescriptor | null {
    const baseDescriptor = this.descriptor(feature, minPixelsPerBp, maxPixelsPerBp);
    if (!baseDescriptor) return null;
    const ownOuterRail = baseDescriptor.placementOptions[0].outwardRail;
    const placementOptions: FloatingAnnotationLabelPlacementOption[] = [];
    for (const tangentStep of FLOATING_LABEL_TANGENT_STEPS) {
      const centerAtMinPixelsPerBp =
        baseDescriptor.sequenceCenterBp +
        (tangentStep * FLOATING_LABEL_TANGENT_STEP_PX) / Math.max(minPixelsPerBp, 1e-9);
      const centerAtMaxPixelsPerBp =
        baseDescriptor.sequenceCenterBp +
        (tangentStep * FLOATING_LABEL_TANGENT_STEP_PX) / Math.max(maxPixelsPerBp, 1e-9);
      const layoutCenterMinBp = Math.min(centerAtMinPixelsPerBp, centerAtMaxPixelsPerBp);
      const layoutCenterMaxBp = Math.max(centerAtMinPixelsPerBp, centerAtMaxPixelsPerBp);
      const layoutCenterBp = (layoutCenterMinBp + layoutCenterMaxBp) / 2;
      const outwardClearance = this.localOutwardClearance(
        baseDescriptor,
        ownOuterRail,
        minPixelsPerBp,
        layoutCenterMinBp,
        layoutCenterMaxBp
      );
      placementOptions.push({
        tangentStep,
        layoutCenterBp,
        layoutCenterMinBp,
        layoutCenterMaxBp,
        outwardClearance,
        outwardRail: ownOuterRail + baseDescriptor.outwardSide * outwardClearance,
      });
    }
    return { ...baseDescriptor, placementOptions };
  }

  private packAssignmentDescriptors(descriptors: readonly FloatingAnnotationLabelDescriptor[]): {
    descriptorData: Float64Array;
    optionData: Float64Array;
  } {
    const descriptorStride = 9;
    const optionStride = 6;
    const optionCount = descriptors.reduce(
      (total, descriptor) => total + descriptor.placementOptions.length,
      0
    );
    const descriptorData = new Float64Array(descriptors.length * descriptorStride);
    const optionData = new Float64Array(optionCount * optionStride);
    let optionOffset = 0;
    for (let descriptorIndex = 0; descriptorIndex < descriptors.length; descriptorIndex += 1) {
      const descriptor = descriptors[descriptorIndex];
      const descriptorBase = descriptorIndex * descriptorStride;
      descriptorData[descriptorBase] = descriptor.featureId;
      descriptorData[descriptorBase + 1] = descriptor.stableOrder[0];
      descriptorData[descriptorBase + 2] = descriptor.stableOrder[1];
      descriptorData[descriptorBase + 3] = descriptor.sequenceCenterBp;
      descriptorData[descriptorBase + 4] = descriptor.outwardSide;
      descriptorData[descriptorBase + 5] = descriptor.textWidth;
      descriptorData[descriptorBase + 6] = descriptor.textHeight;
      descriptorData[descriptorBase + 7] = optionOffset;
      descriptorData[descriptorBase + 8] = descriptor.placementOptions.length;
      for (const option of descriptor.placementOptions) {
        const optionBase = optionOffset * optionStride;
        optionData[optionBase] = option.tangentStep;
        optionData[optionBase + 1] = option.layoutCenterBp;
        optionData[optionBase + 2] = option.layoutCenterMinBp ?? option.layoutCenterBp;
        optionData[optionBase + 3] = option.layoutCenterMaxBp ?? option.layoutCenterBp;
        optionData[optionBase + 4] = option.outwardClearance;
        optionData[optionBase + 5] = option.outwardRail;
        optionOffset += 1;
      }
    }
    return { descriptorData, optionData };
  }

  private storeAssignment(
    key: string,
    zoomBand: FloatingAnnotationLabelZoomBand,
    prepared: FloatingAnnotationLabelPreparedAssignment,
    plan: FloatingAnnotationLabelAssignmentPlan,
    source: 'foreground' | 'prewarm'
  ): FloatingAnnotationLabelAssignmentCache {
    const built: FloatingAnnotationLabelAssignmentCache = {
      key,
      zoomBandIndex: zoomBand.index,
      zoomBandMinPixelsPerBp: prepared.minPixelsPerBp,
      zoomBandMaxPixelsPerBp: prepared.maxPixelsPerBp,
      densityPoolCount: prepared.densityPoolCount,
      densityTargetCount: prepared.densityTargetCount,
      descriptorsByFeatureId: prepared.descriptorsByFeatureId,
      plan,
    };
    if (source === 'foreground') this.assignmentBuilds += 1;
    this.assignmentCaches.set(key, built);
    while (this.assignmentCaches.size > FLOATING_LABEL_ASSIGNMENT_CACHE_LIMIT) {
      const oldestKey = this.assignmentCaches.keys().next().value;
      if (oldestKey === undefined) break;
      this.assignmentCaches.delete(oldestKey);
    }
    return built;
  }

  private cachedAssignment(key: string): FloatingAnnotationLabelAssignmentCache | null {
    const cached = this.assignmentCaches.get(key);
    if (!cached) return null;
    this.assignmentCaches.delete(key);
    this.assignmentCaches.set(key, cached);
    return cached;
  }

  private buildAssignmentsNow(
    isArcMode: boolean,
    zoomBand: FloatingAnnotationLabelZoomBand
  ): FloatingAnnotationLabelAssignmentCache {
    const key = this.assignmentCacheKey(isArcMode, zoomBand);
    const prepared = this.prepareAssignment(zoomBand);
    const plan = ptime('annotation.floating-label-assignment-plan', () =>
      precomputeFloatingAnnotationLabelAssignments(prepared.descriptors, {
        pixelsPerBp: prepared.minPixelsPerBp,
        genomeLength: this.host.genomeLength(),
        circular: this.host.genomeCircular() && isArcMode,
      })
    );
    return this.storeAssignment(key, zoomBand, prepared, plan, 'foreground');
  }

  private nearestCachedAssignment(
    isArcMode: boolean,
    zoomBand: FloatingAnnotationLabelZoomBand
  ): FloatingAnnotationLabelAssignmentCache | null {
    return (
      this.nearestCachedAssignmentWhere(zoomBand, (cache) => this.sameFamily(cache, isArcMode)) ??
      this.nearestCachedAssignmentWhere(zoomBand, () => true)
    );
  }

  private sameFamily(cache: FloatingAnnotationLabelAssignmentCache, isArcMode: boolean): boolean {
    return (
      cache.key ===
      this.assignmentCacheKey(
        isArcMode,
        floatingAnnotationLabelZoomBandForIndex(cache.zoomBandIndex)
      )
    );
  }

  private nearestCachedAssignmentWhere(
    zoomBand: FloatingAnnotationLabelZoomBand,
    accept: (cache: FloatingAnnotationLabelAssignmentCache) => boolean
  ): FloatingAnnotationLabelAssignmentCache | null {
    let nearest: FloatingAnnotationLabelAssignmentCache | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const cache of this.assignmentCaches.values()) {
      if (!accept(cache)) continue;
      const distance = Math.abs(cache.zoomBandIndex - zoomBand.index);
      const sparserOnTie =
        distance === nearestDistance &&
        nearest !== null &&
        cache.zoomBandIndex < nearest.zoomBandIndex;
      if (distance < nearestDistance || sparserOnTie) {
        nearest = cache;
        nearestDistance = distance;
      }
    }
    return nearest;
  }

  private canBuildAssignmentsOffFrame(): boolean {
    return typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function';
  }

  private enqueueAssignmentPrewarm(
    isArcMode: boolean,
    zoomBands: readonly FloatingAnnotationLabelZoomBand[],
    urgent = false
  ): void {
    if (!this.canBuildAssignmentsOffFrame()) return;
    const generation = this.assignmentGeneration;
    for (const zoomBand of zoomBands) {
      const cacheKey = this.assignmentCacheKey(isArcMode, zoomBand);
      if (this.assignmentCaches.has(cacheKey)) continue;
      if (this.prewarmKeys.has(cacheKey)) {
        if (!urgent) continue;
        const queuedIndex = this.prewarmQueue.findIndex((request) => request.cacheKey === cacheKey);

        if (queuedIndex <= 0) continue;
        const [queued] = this.prewarmQueue.splice(queuedIndex, 1);
        this.prewarmQueue.unshift(queued);
        continue;
      }
      this.prewarmKeys.add(cacheKey);
      const request: FloatingAnnotationLabelPrewarmRequest = {
        generation,
        isArcMode,
        zoomBand,
        cacheKey,
      };
      if (urgent) this.prewarmQueue.unshift(request);
      else this.prewarmQueue.push(request);
    }
    this.scheduleNextAssignmentPrewarm();
  }

  private scheduleAdjacentAssignmentPrewarm(
    isArcMode: boolean,
    currentBand: FloatingAnnotationLabelZoomBand
  ): void {
    this.enqueueAssignmentPrewarm(
      isArcMode,
      [currentBand.index + 1, currentBand.index - 1].map((index) =>
        floatingAnnotationLabelZoomBandForIndex(index)
      )
    );
  }

  private scheduleOverviewAssignmentPrewarm(isArcMode: boolean): void {
    const genomeLength = this.host.genomeLength();
    if (genomeLength < FLOATING_LABEL_OVERVIEW_PREWARM_MIN_GENOME_BP) return;
    const firstVisibleBand = floatingAnnotationLabelZoomBand(512 / genomeLength);
    this.enqueueAssignmentPrewarm(
      isArcMode,
      Array.from({ length: FLOATING_LABEL_OVERVIEW_PREWARM_BAND_COUNT }, (_, offset) =>
        floatingAnnotationLabelZoomBandForIndex(firstVisibleBand.index + offset)
      )
    );
  }

  private assignmentPrewarmWorker(): Worker | null {
    if (typeof Worker === 'undefined') return null;
    if (this.prewarmWorker) return this.prewarmWorker;
    const worker = new FloatingAnnotationLabelLayoutWorker();
    worker.onmessage = ({ data }: MessageEvent<FloatingAnnotationLabelLayoutWorkerResponse>) => {
      const active = this.activePrewarms.get(data.requestId);
      if (!active) return;
      this.activePrewarms.delete(data.requestId);
      const { requestId: _requestId, assignments, ...planFields } = data;
      this.completeAssignmentPrewarm(active.request, active.prepared, {
        ...planFields,
        assignments: new Map(assignments),
      });
      this.scheduleNextAssignmentPrewarm();
    };
    worker.onerror = () => {
      for (const active of this.activePrewarms.values()) {
        this.prewarmKeys.delete(active.request.cacheKey);
      }
      this.activePrewarms.clear();
      worker.terminate();
      if (this.prewarmWorker === worker) this.prewarmWorker = null;
      this.scheduleNextAssignmentPrewarm();
    };
    this.prewarmWorker = worker;
    return worker;
  }

  private completeAssignmentPrewarm(
    request: FloatingAnnotationLabelPrewarmRequest,
    prepared: FloatingAnnotationLabelPreparedAssignment,
    plan: FloatingAnnotationLabelAssignmentPlan
  ): void {
    this.prewarmKeys.delete(request.cacheKey);
    if (
      request.generation !== this.assignmentGeneration ||
      request.cacheKey !== this.assignmentCacheKey(request.isArcMode, request.zoomBand) ||
      this.assignmentCaches.has(request.cacheKey)
    ) {
      return;
    }
    this.storeAssignment(request.cacheKey, request.zoomBand, prepared, plan, 'prewarm');
    this.assignmentPrewarmBuilds += 1;

    const presentedFrameWaited =
      this.lastAssignmentSubstituted && this.lastRequestedCacheKey === request.cacheKey;
    if (presentedFrameWaited) this.assignmentPlanRevision += 1;
    this._frame = {
      ...this._frame,
      assignmentBuildCount: this.assignmentBuilds,
      assignmentPrewarmBuildCount: this.assignmentPrewarmBuilds,
      assignmentPrewarmMaxMs: this.assignmentPrewarmMaxMs,
      assignmentPlanRevision: this.assignmentPlanRevision,
      assignmentCacheEntryCount: this.assignmentCaches.size,
      assignmentCacheKeys: [...this.assignmentCaches.keys()],
    };
    if (presentedFrameWaited) this.host.requestFrame?.();
  }

  private scheduleNextAssignmentPrewarm(): void {
    if (
      this.prewarmIdleHandle !== null ||
      (this.preparingPrewarm === null && this.prewarmQueue.length === 0) ||
      !this.canBuildAssignmentsOffFrame()
    ) {
      return;
    }

    while (this.preparingPrewarm === null && this.prewarmQueue.length > 0) {
      const request = this.prewarmQueue.shift();
      if (!request) break;
      const valid =
        request.generation === this.assignmentGeneration &&
        request.cacheKey === this.assignmentCacheKey(request.isArcMode, request.zoomBand) &&
        !this.assignmentCaches.has(request.cacheKey);
      if (!valid) {
        this.prewarmKeys.delete(request.cacheKey);
        continue;
      }
      this.preparingPrewarm = {
        request,
        minPixelsPerBp: request.zoomBand.minPixelsPerBp,
        maxPixelsPerBp: request.zoomBand.maxPixelsPerBp,
        sourceFeatures: this.priorityFeatures,
        densityPoolCount: this.priorityFeatures.length,
        densityTargetCount: floatingAnnotationLabelDensityTarget({
          genomeLength: this.host.genomeLength(),
          bandMinPixelsPerBp: request.zoomBand.minPixelsPerBp,
          maxCandidates: this.priorityFeatures.length,
        }),
        descriptors: [],
        descriptorsByFeatureId: new Map(),
        featureIndex: 0,
      };
    }
    if (!this.preparingPrewarm) return;

    this.prewarmIdleHandle = window.requestIdleCallback(
      (deadline) => {
        this.prewarmIdleHandle = null;
        const preparing = this.preparingPrewarm;
        if (!preparing) {
          this.scheduleNextAssignmentPrewarm();
          return;
        }
        const { request } = preparing;
        if (
          request.generation !== this.assignmentGeneration ||
          request.cacheKey !== this.assignmentCacheKey(request.isArcMode, request.zoomBand) ||
          this.assignmentCaches.has(request.cacheKey)
        ) {
          this.prewarmKeys.delete(request.cacheKey);
          this.preparingPrewarm = null;
          this.scheduleNextAssignmentPrewarm();
          return;
        }

        const sliceBudgetMs = deadline.didTimeout
          ? FLOATING_LABEL_PREWARM_SLICE_MS
          : Math.max(
              FLOATING_LABEL_PREWARM_MIN_SLICE_MS,
              Math.min(FLOATING_LABEL_PREWARM_SLICE_MS, deadline.timeRemaining())
            );
        const sliceStartedAt = performance.now();
        do {
          const feature = preparing.sourceFeatures[preparing.featureIndex];
          preparing.featureIndex += 1;
          if (feature) {
            const descriptor = this.prepareAssignmentDescriptor(
              feature,
              preparing.minPixelsPerBp,
              preparing.maxPixelsPerBp
            );
            if (descriptor) {
              preparing.descriptors.push(descriptor);
              preparing.descriptorsByFeatureId.set(feature.id, descriptor);
            }
          }
        } while (
          preparing.featureIndex < preparing.sourceFeatures.length &&
          preparing.descriptors.length < preparing.densityTargetCount &&
          performance.now() - sliceStartedAt < sliceBudgetMs
        );

        if (
          preparing.featureIndex < preparing.sourceFeatures.length &&
          preparing.descriptors.length < preparing.densityTargetCount
        ) {
          this.assignmentPrewarmMaxMs = Math.max(
            this.assignmentPrewarmMaxMs,
            performance.now() - sliceStartedAt
          );
          this.scheduleNextAssignmentPrewarm();
          return;
        }

        this.preparingPrewarm = null;
        const prepared: FloatingAnnotationLabelPreparedAssignment = {
          minPixelsPerBp: preparing.minPixelsPerBp,
          maxPixelsPerBp: preparing.maxPixelsPerBp,
          densityPoolCount: preparing.densityPoolCount,
          densityTargetCount: preparing.densityTargetCount,
          descriptors: preparing.descriptors,
          descriptorsByFeatureId: preparing.descriptorsByFeatureId,
        };
        const planOptions = {
          pixelsPerBp: prepared.minPixelsPerBp,
          genomeLength: this.host.genomeLength(),
          circular: this.host.genomeCircular() && request.isArcMode,
        };
        const worker = this.assignmentPrewarmWorker();
        if (worker) {
          const requestId = ++this.prewarmRequestId;
          this.activePrewarms.set(requestId, { request, requestId, prepared });
          const packed = this.packAssignmentDescriptors(prepared.descriptors);
          const message: FloatingAnnotationLabelLayoutWorkerRequest = {
            requestId,
            ...packed,
            ...planOptions,
          };
          worker.postMessage(message, [packed.descriptorData.buffer, packed.optionData.buffer]);
        } else {
          this.completeAssignmentPrewarm(
            request,
            prepared,
            precomputeFloatingAnnotationLabelAssignments(prepared.descriptors, planOptions)
          );
        }
        this.assignmentPrewarmMaxMs = Math.max(
          this.assignmentPrewarmMaxMs,
          performance.now() - sliceStartedAt
        );
        this.scheduleNextAssignmentPrewarm();
      },
      { timeout: 500 }
    );
  }

  private ensureAssignments(path: PathMapper): FloatingAnnotationLabelAssignmentCache {
    const zoomBand = floatingAnnotationLabelZoomBand(path.pixelsPerBp);
    const key = this.assignmentCacheKey(path.isArcMode, zoomBand);
    this.lastRequestedCacheKey = key;
    this.lastRequestedZoomBandIndex = zoomBand.index;
    let cache = this.cachedAssignment(key);
    let substituted = false;
    if (!cache) {
      const smallSequence = this.priorityFeatures.length <= FLOATING_LABEL_SYNC_BUILD_MAX_FEATURES;
      const standIn = smallSequence ? null : this.nearestCachedAssignment(path.isArcMode, zoomBand);
      if (standIn && this.canBuildAssignmentsOffFrame()) {
        this.enqueueAssignmentPrewarm(path.isArcMode, [zoomBand], true);
        cache = standIn;
        substituted = true;
      } else {
        cache = this.buildAssignmentsNow(path.isArcMode, zoomBand);
      }
    }
    this.lastAssignmentSubstituted = substituted;
    this.scheduleAdjacentAssignmentPrewarm(path.isArcMode, zoomBand);
    return cache;
  }

  private candidate(
    descriptor: FloatingAnnotationBodyDescriptor,
    path: PathMapper,
    state: RenderState,
    preloadMargin: number,
    radialCenter: { readonly x: number; readonly y: number } | null
  ): FloatingAnnotationLabelCandidate | null {
    const { startBp, endBp, offset } = descriptor;
    const pixelWidth = (endBp - startBp) * path.pixelsPerBp;
    if (!Number.isFinite(pixelWidth) || pixelWidth > MIN_BAR_FOR_LABEL) return null;
    const center = path.featureLabelPosAt(descriptor.sequenceCenterBp, offset);

    const barHeight = this.host.barHeight();
    const reach = preloadMargin + descriptor.textWidth + pixelWidth + barHeight;
    if (
      center.x < -reach ||
      center.x > state.width + reach ||
      center.y < -reach ||
      center.y > state.height + reach
    ) {
      return null;
    }
    const radial = radialCenter
      ? { x: center.x - radialCenter.x, y: center.y - radialCenter.y }
      : null;
    const radialLength = radial ? Math.hypot(radial.x, radial.y) : 0;
    const outward =
      radial && radialLength > 1e-9
        ? { x: radial.x / radialLength, y: radial.y / radialLength }
        : {
            x: -Math.sin(center.angle) * descriptor.outwardSide,
            y: Math.cos(center.angle) * descriptor.outwardSide,
          };
    const bodyPoints = path.featurePolygonAt(startBp, endBp, offset, barHeight / 2);
    if (bodyPoints.length < 6) return null;
    const bodyBounds = computeBBox(bodyPoints);
    const expandedMargin = preloadMargin + descriptor.textWidth;
    if (
      bodyBounds.xMax < -expandedMargin ||
      bodyBounds.xMin > state.width + expandedMargin ||
      bodyBounds.yMax < -expandedMargin ||
      bodyBounds.yMin > state.height + expandedMargin
    ) {
      return null;
    }

    return {
      ...descriptor,
      normalScale: path.scaleNormalOffset?.(1) ?? 1,
      anchor: floatingLabelOutwardAnchor(center, outward, bodyPoints),
      outward,
      bodyBounds,
    };
  }

  private collectCandidates(
    path: PathMapper,
    state: RenderState,
    assignmentCache: FloatingAnnotationLabelAssignmentCache,
    preloadMargin: number,
    radialCenter: { readonly x: number; readonly y: number } | null
  ): FloatingAnnotationLabelCandidate[] {
    this.windowFeatureCount = 0;
    if (state.width <= 0 || state.height <= 0 || !this.host.shouldRenderFeatureText(path))
      return [];
    const pool = assignmentCache.descriptorsByFeatureId;
    const windowFeatures = this.windowFeatures(path, preloadMargin, pool.size);
    const candidates: FloatingAnnotationLabelCandidate[] = [];
    const collect = (descriptor: FloatingAnnotationBodyDescriptor): void => {
      const candidate = this.candidate(descriptor, path, state, preloadMargin, radialCenter);
      if (candidate) candidates.push(candidate);
    };
    if (windowFeatures) {
      this.windowFeatureCount = windowFeatures.length;
      for (const feature of windowFeatures) {
        const descriptor = pool.get(feature.id);
        if (descriptor) collect(descriptor);
      }
    } else {
      this.windowFeatureCount = pool.size;
      for (const descriptor of pool.values()) collect(descriptor);
    }
    return candidates;
  }

  private windowFeatures(
    path: PathMapper,
    preloadMargin: number,
    poolSize: number
  ): readonly Feature[] | null {
    const features = this.host.features();
    const genomeLength = this.host.genomeLength();
    const marginBp = preloadMargin / Math.max(path.pixelsPerBp, 1e-9);
    const windowBp = Math.max(0, path.viewEndBp - path.viewStartBp) + 2 * marginBp;
    const estimatedWindowCount =
      genomeLength > 0 && Number.isFinite(windowBp)
        ? features.length * Math.min(1, windowBp / genomeLength)
        : features.length;
    if (poolSize <= estimatedWindowCount) return null;
    return this.host.candidatesForPath(path, preloadMargin);
  }

  get columnGutterPx(): number {
    return this.columnGutter;
  }

  private overviewCircle(
    path: PathMapper,
    state: RenderState
  ): {
    readonly center: { readonly x: number; readonly y: number };
    readonly radius: number;
  } | null {
    if (!path.isArcMode) return null;
    const circle = path.arcCircle?.();
    if (!circle) return null;
    const { center } = circle;
    if (center.x < 0 || center.x > state.width || center.y < 0 || center.y > state.height) {
      return null;
    }
    return circle;
  }

  private columnRing(path: PathMapper, state: RenderState): FloatingLabelColumnRing | null {
    const circle = this.overviewCircle(path, state);
    if (!circle) return null;
    const { center } = circle;
    const extent = Math.max(0, this.host.outwardLaneExtentPx?.() ?? 0);
    const radius = circle.radius + extent + FLOATING_LABEL_COLUMN_RING_GAP_PX;
    const horizontalRoom = Math.min(center.x, state.width - center.x) - radius;
    const verticalRoom = Math.min(center.y, state.height - center.y) - radius;
    if (horizontalRoom < FLOATING_LABEL_COLUMN_MIN_SIDE_ROOM_PX || verticalRoom < 0) return null;
    return { center, radius };
  }

  render(path: PathMapper, state: RenderState): void {
    this.host.clearCalloutRecords(state);
    const bitmapFontName = ensureFloatingLabelBitmapFont();
    this.leaderGraphics.clear();
    this.leaderGraphics.visible = false;
    this.labelsUsedThisFrame.clear();
    const preloadMargin = this.preloadMargin(state);
    const labelsEnabled =
      state.width > 0 && state.height > 0 && this.host.shouldRenderFeatureText(path);
    this.windowFeatureCount = 0;
    this.lastRequestedCacheKey = null;
    this.lastRequestedZoomBandIndex = null;
    this.lastAssignmentSubstituted = false;
    const assignmentCache = labelsEnabled ? this.ensureAssignments(path) : null;
    const columnRing = labelsEnabled ? this.columnRing(path, state) : null;
    const candidates = assignmentCache
      ? ptime('annotation.floating-label-candidates', () =>
          this.collectCandidates(
            path,
            state,
            assignmentCache,
            preloadMargin,
            columnRing?.center ?? null
          )
        )
      : [];
    if (candidates.length === 0) {
      this.hideUnusedLabels();
      this.visibleLeaderSegments = [];
      this._frame = this.buildFrame(path, state, preloadMargin, assignmentCache);
      return;
    }

    const plan: FloatingAnnotationLabelPlan = ptime('annotation.floating-label-plan', () =>
      columnRing
        ? ptime('annotation.floating-label-plan-columns', () =>
            floatingAnnotationLabelPlanFromDecisions(
              planCircularColumnLabels(
                candidates,
                columnRing,
                { width: state.width, height: state.height },
                this.host
                  .labelObstacles(state)
                  .filter((obstacle) => outsideRing(obstacle, columnRing))
              )
            )
          )
        : ptime('annotation.floating-label-plan-slots', () =>
            planFloatingAnnotationLabels(
              candidates,
              assignmentCache?.plan.assignments ?? new Map(),
              { width: state.width, height: state.height, preloadMargin },
              [...this.host.bodyObstacles(), ...this.host.labelObstacles(state)],
              this.host.bodyOutlineLookup?.()
            )
          )
    );
    const labelAlpha = Math.max(0.85, this.host.overviewLabelAlpha());
    const leaderColor =
      state.themeMode === 'dark' ? FLOATING_LABEL_LEADER_DARK : FLOATING_LABEL_LEADER_LIGHT;
    ptime('annotation.floating-label-leaders', () => {
      const leaderSegments = floatingAnnotationVisibleLeaderSegments(plan.decisions);
      this.visibleLeaderSegments = leaderSegments;
      this.leaderGraphics.visible = this.leadersVisibleForTests && leaderSegments.length > 0;
      for (const segment of leaderSegments) {
        this.leaderGraphics
          .moveTo(segment.start.x, segment.start.y)
          .lineTo(segment.end.x, segment.end.y);
      }
      if (leaderSegments.length > 0) {
        this.leaderGraphics.stroke({
          width: 1,
          color: leaderColor,
          alpha: Math.min(0.8, labelAlpha),
        });
      }
    });

    ptime('annotation.floating-label-text', () => {
      for (const decision of plan.decisions) {
        if (decision.status !== 'placed') continue;
        const textColor = floatingLabelTextColor(state, decision.featureId);
        const useBitmapText =
          bitmapFontName !== null && FLOATING_LABEL_BITMAP_CHARACTERS.test(decision.text);
        const emphasized = floatingLabelEmphasized(state, decision.featureId);
        const fontName = floatingLabelBitmapFontFor(emphasized);
        const textObject = useBitmapText
          ? this.acquireBitmapLabel(decision.featureId, fontName)
          : this.acquireTextLabel(decision.featureId);
        this.labelsUsedThisFrame.add(decision.featureId);
        if (textObject.text !== decision.text) textObject.text = decision.text;
        const style = useBitmapText
          ? floatingLabelBitmapStyle(fontName, textColor)
          : pillLabelTextStyle(0xffffff, undefined, textColor, emphasized);
        if (textObject.style !== style) textObject.style = style;
        textObject.alpha = labelAlpha;
        if (!useBitmapText) {
          const resolution = targetPillLabelTextResolution();
          if (textObject.resolution !== resolution) textObject.resolution = resolution;
        }
        textObject.position.set(decision.x, decision.y);
        this.host.recordCallout(state, {
          featureId: decision.featureId,
          text: decision.text,
          bounds: decision.bounds,
        });
      }
    });

    this.hideUnusedLabels();
    ptime('annotation.floating-label-receipt', () => {
      const placedCount = plan.decisions.filter((decision) => decision.status === 'placed').length;
      this._frame = withLazyFingerprint(
        {
          ...this.buildFrame(path, state, preloadMargin, assignmentCache),
          candidateCount: candidates.length,
          decisionCount: plan.decisions.length,
          placedCount,
          rejectedCount: plan.decisions.length - placedCount,
          decisions: plan.decisions,
        },
        plan
      );
    });
  }

  private buildFrame(
    path: PathMapper,
    state: RenderState,
    preloadMargin: number,
    assignmentCache: FloatingAnnotationLabelAssignmentCache | null
  ): FloatingAnnotationLabelFrameReceipt {
    return {
      ...emptyFloatingLabelFrame(),
      cameraKey: `${state.zoom}|${state.viewOffset}|${state.morph}|${state.width}|${state.height}`,
      pathMode: path.isArcMode ? 'circular' : 'linear',
      preloadMarginPx: preloadMargin,
      sourceFeatureCount: this.host.features().length,
      windowFeatureCount: this.windowFeatureCount,
      assignmentBuildCount: this.assignmentBuilds,
      assignmentPrewarmBuildCount: this.assignmentPrewarmBuilds,
      assignmentPrewarmMaxMs: this.assignmentPrewarmMaxMs,
      assignmentCacheKey: assignmentCache?.key ?? null,
      assignmentZoomBandIndex: assignmentCache?.zoomBandIndex ?? null,
      assignmentZoomBandMinPixelsPerBp: assignmentCache?.zoomBandMinPixelsPerBp ?? null,
      assignmentZoomBandMaxPixelsPerBp: assignmentCache?.zoomBandMaxPixelsPerBp ?? null,
      requestedZoomBandIndex: this.lastRequestedZoomBandIndex,
      assignmentSubstituted: this.lastAssignmentSubstituted,
      assignmentPlanRevision: this.assignmentPlanRevision,
      densityPoolCount: assignmentCache?.densityPoolCount ?? 0,
      densityTargetCount: assignmentCache?.densityTargetCount ?? 0,
      densitySelectedCount: assignmentCache?.descriptorsByFeatureId.size ?? 0,
      assignmentCacheEntryCount: this.assignmentCaches.size,
      assignmentCacheKeys: [...this.assignmentCaches.keys()],
      assignmentCandidateCount: assignmentCache?.plan.candidateCount ?? 0,
      assignmentAssignedCount: assignmentCache?.plan.assignedCount ?? 0,
      assignmentSearchStepCount: assignmentCache?.plan.searchStepCount ?? 0,
      assignmentSearchBudgetExhaustionCount: assignmentCache?.plan.searchBudgetExhaustionCount ?? 0,
      assignmentFingerprint: assignmentCache?.plan.fingerprint ?? '',
    };
  }

  private hideUnusedLabels(): void {
    for (const [featureId, label] of this.bitmapLabelsByFeature) {
      if (this.labelsUsedThisFrame.has(featureId)) continue;
      label.visible = false;
      this.bitmapLabelsByFeature.delete(featureId);
      this.spareBitmapLabels.push(label);
    }
    for (const [featureId, label] of this.textLabelsByFeature) {
      if (this.labelsUsedThisFrame.has(featureId)) continue;
      label.visible = false;
      this.textLabelsByFeature.delete(featureId);
      this.spareTextLabels.push(label);
    }
  }

  private acquireBitmapLabel(featureId: number, fontName: string): BitmapText {
    const existing = this.bitmapLabelsByFeature.get(featureId);
    if (existing) {
      existing.visible = true;
      return existing;
    }
    let text = this.spareBitmapLabels.pop();
    if (text) {
      text.visible = true;
    } else {
      text = new BitmapText({
        text: '',
        anchor: 0.5,
        style: floatingLabelBitmapStyle(fontName, 0x374151),
      });
      this.host.container.addChild(text);
    }
    this.bitmapLabelsByFeature.set(featureId, text);
    return text;
  }

  private acquireTextLabel(featureId: number): Text {
    const existing = this.textLabelsByFeature.get(featureId);
    if (existing) {
      existing.visible = true;
      return existing;
    }
    let text = this.spareTextLabels.pop();
    if (text) {
      text.visible = true;
    } else {
      text = new Text({
        text: '',
        anchor: 0.5,
        style: pillLabelTextStyle(0xffffff),
        resolution: targetPillLabelTextResolution(),
      });
      this.host.container.addChild(text);
    }
    this.textLabelsByFeature.set(featureId, text);
    return text;
  }

  destroy(): void {
    this.cancelAssignmentPrewarm();
    this.leaderGraphics.destroy();
    this.hoverLeaderGraphics.destroy();
    for (const text of this.bitmapLabelsByFeature.values()) text.destroy();
    for (const text of this.spareBitmapLabels) text.destroy();
    for (const text of this.textLabelsByFeature.values()) destroyPixiText(text);
    for (const text of this.spareTextLabels) destroyPixiText(text);
    this.bitmapLabelsByFeature.clear();
    this.textLabelsByFeature.clear();
    this.spareBitmapLabels = [];
    this.spareTextLabels = [];
  }
}
