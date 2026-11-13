import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import { genomeSequenceAvailable } from '../shared/genome-sequence-availability';
import {
  GOLDEN_GATE_JUNCTION_VISUAL,
  resolveGoldenGateJunctionVisual,
} from '@waypoint/sequence-utils';
import type {
  OverlayHitResult,
  OverlayLayoutBands,
  OverlayPosition,
  OverlayTrack,
} from './overlay-track';
import type { PathMapper } from '../shared/path-mapper';
import type { UnifiedLayout } from '../shared/track-layout';
import {
  PRIMER_FEATURE_LANE_MIN_PIXELS_PER_BP,
  SECTION_GAP,
  computeSequenceRevealMetrics,
  primerFeatureLaneScaleForPixelsPerBp,
} from '../shared/track-layout';
import {
  CUT_SITE_LABEL_FONT_FAMILY,
  SEQUENCE_FONT_FAMILY,
  webglThemeForMode,
  type WebGLRenderTheme,
} from '../shared';
import { drawDashedLine, drawDashedPolyline, type Point2 } from '../shared/dashed-line';
import {
  assemblyPrimerHandleContainsPoint,
  assemblyPrimerHandleGeometry,
  assemblyPrimerHandleVisualForMode,
  type AssemblyPrimerHandleGeometry,
  type AssemblyPrimerHandleVisual,
} from '../shared/assembly-primer-handle-visual';
import type { PrimerHandleDragPreview } from '../../../types';
import {
  CANVAS_PRIMER_ARROW_WIDTH,
  PRIMER_OVERVIEW_MIN_VISIBLE_WIDTH,
  computePrimerTrackHeightForLayout,
  getPrimerLaneEnvelope,
  primerScreenMetricsForReveal,
  primerScreenMetrics,
  resolvePrimerTrackContract,
  type LaneEnvelope,
} from '../shared/lane-contracts';
import { type HitRecord, computeBBox, pointInPolygon } from './hit-testing';
import { assignFeatureLanes } from '../../../geometry/lane-assignment';
import type { Genome, Primer, RenderState } from '../../../types';
import {
  DEFAULT_PBS_COLOR,
  MISMATCH_COLOR,
  computePrimerVisualPlan,
  type PrimerVisualFillSegment,
  type PrimerVisualPlan,
  type PrimerVisualRoleCounts,
  type PrimerVisualStrokeStyle,
  type PrimerVisualTextSegment,
} from './primer-visual-roles';
import { destroyPixiText } from '../shared/pixi-text-lifecycle';
import { CurvedLabelRenderer } from '../shared/curved-label';
import {
  labelBoxPolygonAtPath,
  labelPlacementAt,
  readableTextRotation,
  renderCutSiteLabelText,
  resolveCutSiteLabels,
  buildCutSiteLabelConnectorPolyline,
  type CutSiteLabelAnchor,
} from '../shared/cut-site-label';

const PRIMER_HAIRLINE_MIN_WIDTH = PRIMER_OVERVIEW_MIN_VISIBLE_WIDTH;
const MAX_PRIMER_TEXT_GLYPHS = 3000;
const UNSAVED_PRIMER_ALPHA_MULTIPLIER = 0.5;
const UNSAVED_PRIMER_DASH_PX = 4;
const UNSAVED_PRIMER_GAP_PX = 3;
const OVERVIEW_PRIMER_FILL_ALPHA = 0.72;
const PRIMER_TEXT_STYLE_CACHE_MAX_ENTRIES = 64;

enum PrimerLOD {
  Hidden,
  Hairline,
  Shape,
  Sequence,
}

interface DirectionalPrimer {
  start: number;
  end: number;
  direction: 'forward' | 'reverse';
}

type PrimerArrowPosition = 'above' | 'below';

export interface PrimerOverlayRenderStats {
  loadedPrimers: number;
  drawnPrimers: number;
  hitRecords: number;
  culledByLod: number;
  culledByViewport: number;
  pixelsPerBp: number;
  sequenceVisible: boolean;
  maxPrimerLane: number;
  textGlyphs: number;
  unsavedPrimerOutlines: number;
  pbsHandles: number;
  junctionScarHighlights: number;
  junctionCutIndicators: number;
  junctionIdentityLabels: number;
  roleCounts: PrimerVisualRoleCounts;
  contractLod: string | null;
  firstJunction: {
    primerId: string;
    scarStart: number;
    scarEnd: number;
    identityLabel: string | null;
  } | null;
  drawnJunctions: Array<{
    primerId: string;
    scarStart: number;
    scarEnd: number;
    identityLabel: string | null;
  }>;
  firstDrawnPrimer: {
    id: string;
    renderId: number;
    start: number;
    end: number;
    bbox: { xMin: number; xMax: number; yMin: number; yMax: number };
    pbsHandle: {
      x: number;
      y: number;
      anchorBp: number;
      angle: number;
      visual: AssemblyPrimerHandleVisual;
    } | null;
    contract: {
      role: LaneEnvelope['role'];
      laneIndex: number;
      contractLaneIndex: number;
      centerOffset: number;
      minOffset: number;
      maxOffset: number;
    } | null;
  } | null;
}

interface PrimerHandleRecord {
  x: number;
  y: number;
  normalOffsetPx: number;
  geometry: AssemblyPrimerHandleGeometry;
  visual: AssemblyPrimerHandleVisual;
  payload: import('../shared/hit-targets').PrimerHandleHitPayload;
}

function primerLength(primer: Pick<Primer, 'start' | 'end'>, genomeLength: number): number {
  return primer.end > primer.start
    ? primer.end - primer.start
    : genomeLength - primer.start + primer.end;
}

function isUnsavedPrimer(primer: Pick<Primer, 'isDraft' | 'isCandidate'>): boolean {
  return !!(primer.isDraft || primer.isCandidate);
}

function laneCountFromMax(maxLane: number): number {
  return maxLane >= 0 ? maxLane + 1 : 0;
}

function positiveModulo(value: number, modulo: number): number {
  return ((value % modulo) + modulo) % modulo;
}

function drawDashedPolygon(
  g: Graphics,
  pts: number[],
  dash: number = UNSAVED_PRIMER_DASH_PX,
  gap: number = UNSAVED_PRIMER_GAP_PX
): void {
  if (pts.length < 4) return;
  const count = Math.floor(pts.length / 2);
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    drawDashedLine(g, pts[i * 2], pts[i * 2 + 1], pts[j * 2], pts[j * 2 + 1], dash, gap);
  }
}

function flatPoints(pts: number[]): Point2[] {
  const result: Point2[] = [];
  for (let i = 0; i + 1 < pts.length; i += 2) {
    result.push({ x: pts[i], y: pts[i + 1] });
  }
  return result;
}

function strokePolyline(
  g: Graphics,
  points: readonly Point2[],
  strokeStyle: PrimerVisualStrokeStyle,
  forceDashed: boolean
): void {
  if (points.length < 2 || strokeStyle === 'none') return;
  if (forceDashed || strokeStyle === 'dotted') {
    drawDashedPolyline(g, [...points], UNSAVED_PRIMER_DASH_PX, UNSAVED_PRIMER_GAP_PX);
    return;
  }
  g.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    g.lineTo(points[i].x, points[i].y);
  }
  g.stroke();
}

function strokePolygonEdges(
  g: Graphics,
  pts: number[],
  strokeStyle: PrimerVisualStrokeStyle,
  forceDashed: boolean,
  skipEdge?: (a: Point2, b: Point2) => boolean
): void {
  const points = flatPoints(pts);
  if (points.length < 2) return;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (skipEdge?.(a, b)) continue;
    strokePolyline(g, [a, b], strokeStyle, forceDashed);
  }
}

function boundaryPoint(path: PathMapper, bp: number, offset: number): Point2 {
  if (path.isArcMode) {
    const pos = path.featureLabelPosAt(bp - 0.5, offset);
    return { x: pos.x, y: pos.y };
  }
  const pos = path.featureLabelPosAt(bp, offset);
  return { x: path.bpLeftX(bp), y: pos.y };
}

function boundaryPolyline(
  path: PathMapper,
  startBp: number,
  endBp: number,
  offset: number
): Point2[] {
  if (!path.isArcMode) {
    return [boundaryPoint(path, startBp, offset), boundaryPoint(path, endBp, offset)];
  }
  const pixelWidth = Math.abs(endBp - startBp) * path.pixelsPerBp;
  const steps = Math.max(1, Math.min(64, Math.ceil(pixelWidth / 12)));
  const points: Point2[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    points.push(boundaryPoint(path, startBp + (endBp - startBp) * t, offset));
  }
  return points;
}

function boundaryDistance(a: Point2, b: Point2, top: Point2, bottom: Point2): number {
  const d1 = Math.hypot(a.x - top.x, a.y - top.y) + Math.hypot(b.x - bottom.x, b.y - bottom.y);
  const d2 = Math.hypot(a.x - bottom.x, a.y - bottom.y) + Math.hypot(b.x - top.x, b.y - top.y);
  return Math.min(d1, d2);
}

function computePrimerLod(pixelWidth: number, sequenceVisible: boolean): PrimerLOD {
  if (pixelWidth <= 0) return PrimerLOD.Hidden;
  if (!sequenceVisible && pixelWidth < PRIMER_OVERVIEW_MIN_VISIBLE_WIDTH) {
    return PrimerLOD.Hairline;
  }
  if (pixelWidth < 2) return PrimerLOD.Hairline;
  if (sequenceVisible && pixelWidth >= CANVAS_PRIMER_ARROW_WIDTH) return PrimerLOD.Sequence;
  return PrimerLOD.Shape;
}

function primerOligoIndex(primer: Primer, baseIndex: number, length: number): number {
  return primer.direction === 'forward' ? baseIndex : length - 1 - baseIndex;
}

function primerBaseVisual(
  primer: Primer,
  baseIndex: number,
  length: number,
  mismatchPositions?: Set<number>,
  visualRole?: PrimerVisualTextSegment
): { text: string; color: number; bold: boolean } {
  const oligoIndex = primerOligoIndex(primer, baseIndex, length);
  const isMismatch =
    mismatchPositions?.has(baseIndex) ??
    primer.mismatches?.some((m) => m.position === baseIndex) ??
    false;
  let color = visualRole?.textColor ?? primer.pbsColor ?? DEFAULT_PBS_COLOR;
  if (isMismatch) {
    color = MISMATCH_COLOR;
  }

  return {
    text: primer.bases[oligoIndex] ?? '',
    color,
    bold: isMismatch || !!visualRole?.boldText,
  };
}

function buildCanvasPrimerShapePolygon(
  path: PathMapper,
  primer: DirectionalPrimer,
  endBp: number,
  offset: number,
  halfHeight: number,
  arrowWidth: number,
  arrowHeight: number,
  arrowPosition: PrimerArrowPosition,
  showForward: boolean,
  showReverse: boolean
): number[] {
  const featureLen = endBp - primer.start;
  const widthPx = featureLen * path.pixelsPerBp;

  if (!path.isArcMode) {
    const x1 = path.bpLeftX(primer.start);
    const x2 = path.bpLeftX(endBp);
    const cy = path.featureLabelPosAt(primer.start, offset).y;
    const boxY = cy - halfHeight;
    const bottom = cy + halfHeight;
    const width = x2 - x1;

    if (showForward && width > arrowWidth) {
      if (arrowPosition === 'above') {
        return [
          x1,
          boxY,
          x2 - arrowWidth,
          boxY,
          x2 - arrowWidth,
          boxY - arrowHeight,
          x2,
          boxY,
          x2,
          bottom,
          x1,
          bottom,
        ];
      }
      return [
        x1,
        boxY,
        x2,
        boxY,
        x2,
        bottom,
        x2 - arrowWidth,
        bottom + arrowHeight,
        x2 - arrowWidth,
        bottom,
        x1,
        bottom,
      ];
    }

    if (showReverse && width > arrowWidth) {
      if (arrowPosition === 'above') {
        return [
          x1,
          boxY,
          x1 + arrowWidth,
          boxY - arrowHeight,
          x1 + arrowWidth,
          boxY,
          x2,
          boxY,
          x2,
          bottom,
          x1,
          bottom,
        ];
      }
      return [
        x1,
        boxY,
        x2,
        boxY,
        x2,
        bottom,
        x1 + arrowWidth,
        bottom,
        x1 + arrowWidth,
        bottom + arrowHeight,
        x1,
        bottom,
      ];
    }

    return [x1, boxY, x2, boxY, x2, bottom, x1, bottom];
  }

  const shapeStartBp = primer.start - 0.5;
  const shapeEndBp = endBp - 0.5;

  if ((!showForward && !showReverse) || widthPx <= arrowWidth) {
    return path.featurePolygonAt(shapeStartBp, shapeEndBp, offset, halfHeight);
  }

  const sampleCount = Math.max(1, Math.min(64, Math.ceil(widthPx / 12)));
  const arrowBp = Math.min(featureLen * 0.8, arrowWidth / Math.max(path.pixelsPerBp, 0.0001));
  const pointAt = (bp: number, edgeOffset: number): [number, number] => {
    const point = path.featureLabelPosAt(bp, edgeOffset);
    return [point.x, point.y];
  };
  const pushPoint = (pts: number[], bp: number, edgeOffset: number) => {
    const [x, y] = pointAt(bp, edgeOffset);
    pts.push(x, y);
  };
  const pushEdge = (
    pts: number[],
    fromBp: number,
    toBp: number,
    edgeOffset: number,
    includeStart: boolean,
    includeEnd: boolean
  ) => {
    const steps = Math.max(1, Math.ceil((Math.abs(toBp - fromBp) / featureLen) * sampleCount));
    for (let i = includeStart ? 0 : 1; i <= steps; i++) {
      if (!includeEnd && i === steps) continue;
      const t = i / steps;
      pushPoint(pts, fromBp + (toBp - fromBp) * t, edgeOffset);
    }
  };
  const top = offset - halfHeight;
  const bottom = offset + halfHeight;
  const above = top - arrowHeight;
  const below = bottom + arrowHeight;
  const pts: number[] = [];

  if (showForward) {
    const notchBp = shapeEndBp - arrowBp;
    if (arrowPosition === 'above') {
      pushEdge(pts, shapeStartBp, notchBp, top, true, true);
      pushPoint(pts, notchBp, above);
      pushPoint(pts, shapeEndBp, top);
      pushEdge(pts, shapeEndBp, shapeStartBp, bottom, true, true);
      return pts;
    }
    pushEdge(pts, shapeStartBp, shapeEndBp, top, true, true);
    pushPoint(pts, shapeEndBp, bottom);
    pushPoint(pts, notchBp, below);
    pushPoint(pts, notchBp, bottom);
    pushEdge(pts, notchBp, shapeStartBp, bottom, false, true);
    return pts;
  }

  const notchBp = shapeStartBp + arrowBp;
  if (arrowPosition === 'above') {
    pushPoint(pts, shapeStartBp, top);
    pushPoint(pts, notchBp, above);
    pushPoint(pts, notchBp, top);
    pushEdge(pts, notchBp, shapeEndBp, top, false, true);
    pushEdge(pts, shapeEndBp, shapeStartBp, bottom, true, true);
    return pts;
  }
  pushEdge(pts, shapeStartBp, shapeEndBp, top, true, true);
  pushPoint(pts, shapeEndBp, bottom);
  pushEdge(pts, shapeEndBp, notchBp, bottom, false, true);
  pushPoint(pts, notchBp, below);
  pushPoint(pts, shapeStartBp, bottom);
  return pts;
}

export class PrimerOverlay implements OverlayTrack {
  readonly id = 'primers';
  readonly displayName = 'Primers';
  readonly position: OverlayPosition = 'below';
  sortOrder = 100;
  hitTestOrder = 40;
  enabled = true;
  readonly container = new Container();

  private graphics = new Graphics();
  private textContainer = new Container();
  private curvedJunctionLabels = new CurvedLabelRenderer(this.textContainer);
  private textPool: Text[] = [];
  private textIndex = 0;
  private junctionLabelPool: Text[] = [];
  private junctionLabelIndex = 0;
  private textStyleCache = new Map<string, TextStyle>();
  private primers: Primer[] = [];
  private laneAssignments = new Map<number, number>();
  private detailLaneAssignments = new Map<number, number>();
  private hitCache: HitRecord[] = [];
  private handleHitCache: PrimerHandleRecord[] = [];
  private genomeLength = 0;
  private layout: UnifiedLayout | null = null;
  private pbsEndpointPreview: {
    renderId: number;
    boundaryBp: number;
    bases?: string;
    tm?: number;
    gc?: number;
  } | null = null;

  maxPrimerLane = -1;
  maxForwardPrimerLane = -1;
  maxReversePrimerLane = -1;
  lastRenderStats: PrimerOverlayRenderStats = {
    loadedPrimers: 0,
    drawnPrimers: 0,
    hitRecords: 0,
    culledByLod: 0,
    culledByViewport: 0,
    pixelsPerBp: 0,
    sequenceVisible: false,
    maxPrimerLane: -1,
    textGlyphs: 0,
    unsavedPrimerOutlines: 0,
    pbsHandles: 0,
    junctionScarHighlights: 0,
    junctionCutIndicators: 0,
    junctionIdentityLabels: 0,
    roleCounts: {},
    contractLod: null,
    firstJunction: null,
    drawnJunctions: [],
    firstDrawnPrimer: null,
  };

  layoutCacheKey(_genome: Genome, _state: RenderState, pixelsPerBp: number): number | string {
    const base =
      this.maxPrimerLane < 0 || pixelsPerBp <= PRIMER_FEATURE_LANE_MIN_PIXELS_PER_BP
        ? 0
        : pixelsPerBp;
    if (!this.viewScopedBands()) return base;
    const lanes = this.bandLaneMaxima();
    return `${base}|${lanes.forward}|${lanes.reverse}`;
  }

  private visibleStartBp = Number.NEGATIVE_INFINITY;
  private visibleEndBp = Number.POSITIVE_INFINITY;

  setVisibleRange(startBp: number, endBp: number): void {
    this.visibleStartBp = startBp;
    this.visibleEndBp = endBp;
  }

  private viewScopedBands(): boolean {
    return Number.isFinite(this.visibleStartBp) && Number.isFinite(this.visibleEndBp);
  }

  private bandLaneMaxima(): { forward: number; reverse: number } {
    if (!this.viewScopedBands()) {
      return { forward: this.maxForwardPrimerLane, reverse: this.maxReversePrimerLane };
    }
    const margin = (this.visibleEndBp - this.visibleStartBp) * 0.25;
    const start = this.visibleStartBp - margin;
    const end = this.visibleEndBp + margin;
    let forward = -1;
    let reverse = -1;
    this.primers.forEach((primer, index) => {
      if (primer.end <= start || primer.start >= end) return;
      const lane = this.detailLaneAssignments.get(index);
      if (lane === undefined) return;
      if (primer.direction === 'forward') forward = Math.max(forward, lane);
      else reverse = Math.max(reverse, lane);
    });
    return { forward, reverse };
  }

  constructor() {
    this.container.addChild(this.graphics, this.textContainer);
  }

  setLayout(layout: UnifiedLayout): void {
    this.layout = layout;
  }

  setPbsEndpointPreview(renderId: number, preview: PrimerHandleDragPreview | number): boolean {
    const boundaryBp = typeof preview === 'number' ? preview : preview.boundaryBp;
    if (!Number.isFinite(boundaryBp) || this.genomeLength <= 0) return false;
    const primer = this.primers.find((candidate) => candidate.renderId === renderId);
    if (
      !primer?.editablePbsEndpoint ||
      primer.isScarMarkerOnly ||
      primer.isDraft ||
      primer.isCandidate
    ) {
      return false;
    }
    this.pbsEndpointPreview = {
      renderId,
      boundaryBp: Math.max(0, Math.min(this.genomeLength, Math.round(boundaryBp))),
      ...(typeof preview === 'number'
        ? {}
        : {
            bases: preview.bases,
            tm: preview.tm,
            gc: preview.gc,
          }),
    };
    return true;
  }

  clearPbsEndpointPreview(renderId?: number): boolean {
    if (
      !this.pbsEndpointPreview ||
      (renderId !== undefined && this.pbsEndpointPreview.renderId !== renderId)
    ) {
      return false;
    }
    this.pbsEndpointPreview = null;
    return true;
  }

  getPbsHandleNormalOffsetPx(renderId: number): number | null {
    return (
      this.handleHitCache.find((record) => record.payload.id === renderId)?.normalOffsetPx ?? null
    );
  }

  private primerWithPbsEndpointPreview(primer: Primer): Primer {
    if (this.pbsEndpointPreview?.renderId !== primer.renderId) return primer;
    const projectedPrimer =
      primer.direction === 'forward'
        ? { ...primer, end: this.pbsEndpointPreview.boundaryBp }
        : { ...primer, start: this.pbsEndpointPreview.boundaryBp };
    return {
      ...projectedPrimer,
      ...(this.pbsEndpointPreview.bases === undefined
        ? {}
        : {
            bases: this.pbsEndpointPreview.bases,
            tm: this.pbsEndpointPreview.tm,
            gc: this.pbsEndpointPreview.gc,
          }),
    };
  }

  private computeTransitionLaneAssignments(genomeLength: number): void {
    this.laneAssignments.clear();
    this.maxPrimerLane = -1;

    const assignDirection = (direction: 'forward' | 'reverse'): void => {
      const directionalPrimers = this.primers
        .map((primer, index) => ({ primer, index }))
        .filter(({ primer }) => primer.direction === direction);
      const assignments = assignFeatureLanes(
        directionalPrimers.map(({ primer }) => primer),
        genomeLength
      ).laneAssignments;
      let maxLocalLane = -1;
      for (const [localIndex, localLane] of assignments) {
        this.laneAssignments.set(directionalPrimers[localIndex].index, localLane);
        if (localLane > maxLocalLane) maxLocalLane = localLane;
      }
      if (maxLocalLane > this.maxPrimerLane) this.maxPrimerLane = maxLocalLane;
    };

    assignDirection('forward');
    assignDirection('reverse');
  }

  computeHeight(genome: Genome, state: RenderState, pixelsPerBp: number): number {
    if (this.maxPrimerLane < 0) return 0;
    const compactScale = Math.max(0.5, Math.min(1, state.height / 600));
    const sequenceViewportSpanPx = genome.circular ? (state.width + state.height) * 2 : state.width;
    const reveal = computeSequenceRevealMetrics(
      genomeSequenceAvailable(genome),
      pixelsPerBp,
      sequenceViewportSpanPx
    );
    const primerFeatureLaneScale = primerFeatureLaneScaleForPixelsPerBp(
      pixelsPerBp,
      reveal.sequenceRevealStartPixelsPerBp
    );
    return computePrimerTrackHeightForLayout({
      sequenceVisible: reveal.sequenceVisible,
      sequenceRevealProgress: reveal.sequenceRevealProgress,
      primerFeatureLaneScale,
      compactScale,
      sequenceFontSize: reveal.sequenceFontSize,
      maxOverviewLane: this.maxPrimerLane,
      maxForwardLane: this.bandLaneMaxima().forward,
      maxReverseLane: this.bandLaneMaxima().reverse,
    });
  }

  computeLayoutBands(genome: Genome, state: RenderState, pixelsPerBp: number): OverlayLayoutBands {
    if (this.maxPrimerLane < 0) return {};
    const compactScale = Math.max(0.5, Math.min(1, state.height / 600));
    const sequenceViewportSpanPx = genome.circular ? (state.width + state.height) * 2 : state.width;
    const reveal = computeSequenceRevealMetrics(
      genomeSequenceAvailable(genome),
      pixelsPerBp,
      sequenceViewportSpanPx
    );
    const primerFeatureLaneScale = primerFeatureLaneScaleForPixelsPerBp(
      pixelsPerBp,
      reveal.sequenceRevealStartPixelsPerBp
    );
    const overviewMetrics = primerScreenMetricsForReveal(
      0,
      compactScale,
      reveal.sequenceFontSize,
      primerFeatureLaneScale
    );
    const sequenceBandHeight = overviewMetrics.margin + 2 * overviewMetrics.laneHeight;
    const splitProgress = reveal.sequenceRevealProgress;
    const metrics = primerScreenMetricsForReveal(
      splitProgress,
      compactScale,
      reveal.sequenceFontSize,
      primerFeatureLaneScale
    );
    const bandLanes = this.bandLaneMaxima();
    const forwardLaneCount = laneCountFromMax(bandLanes.forward);
    const reverseLaneCount = laneCountFromMax(bandLanes.reverse);
    const forwardHeight =
      forwardLaneCount > 0 ? metrics.margin + forwardLaneCount * metrics.laneHeight : 0;
    const reverseHeight =
      reverseLaneCount > 0 ? metrics.margin + reverseLaneCount * metrics.laneHeight : 0;
    return {
      aboveSequenceHeight: forwardHeight,
      belowSequenceHeight: reverseHeight,
      sequenceBandHeight,
    };
  }

  loadGenome(genome: Genome): void {
    this.genomeLength = genome.length;
    this.pbsEndpointPreview = null;
    this.replacePrimers(genome.primers ?? []);
  }

  setPrimers(primers: readonly Primer[]): void {
    this.replacePrimers(primers);
  }

  private replacePrimers(primers: readonly Primer[]): void {
    const genomeLength = this.genomeLength;
    this.primers = [...primers].sort(
      (a, b) => primerLength(b, genomeLength) - primerLength(a, genomeLength)
    );
    this.graphics.clear();
    this.curvedJunctionLabels.reset();
    this.textIndex = 0;
    this.junctionLabelIndex = 0;
    this.hideUnusedText();
    this.hitCache.length = 0;
    this.handleHitCache.length = 0;
    this.lastRenderStats = {
      ...this.lastRenderStats,
      loadedPrimers: this.primers.length,
      drawnPrimers: 0,
      hitRecords: 0,
      culledByLod: 0,
      culledByViewport: 0,
      textGlyphs: 0,
      unsavedPrimerOutlines: 0,
      pbsHandles: 0,
      junctionScarHighlights: 0,
      junctionCutIndicators: 0,
      junctionIdentityLabels: 0,
      roleCounts: {},
      firstJunction: null,
      drawnJunctions: [],
      firstDrawnPrimer: null,
    };
    this.detailLaneAssignments.clear();

    const forward = this.primers
      .map((primer, index) => ({ primer, index }))
      .filter(({ primer }) => primer.direction === 'forward');
    const reverse = this.primers
      .map((primer, index) => ({ primer, index }))
      .filter(({ primer }) => primer.direction === 'reverse');

    this.maxForwardPrimerLane = -1;
    for (const [localIndex, lane] of assignFeatureLanes(
      forward.map(({ primer }) => primer),
      genomeLength
    ).laneAssignments) {
      this.detailLaneAssignments.set(forward[localIndex].index, lane);
      if (lane > this.maxForwardPrimerLane) this.maxForwardPrimerLane = lane;
    }

    this.maxReversePrimerLane = -1;
    for (const [localIndex, lane] of assignFeatureLanes(
      reverse.map(({ primer }) => primer),
      genomeLength
    ).laneAssignments) {
      this.detailLaneAssignments.set(reverse[localIndex].index, lane);
      if (lane > this.maxReversePrimerLane) this.maxReversePrimerLane = lane;
    }

    this.computeTransitionLaneAssignments(genomeLength);
  }

  render(path: PathMapper, state: RenderState, yOffset: number, _height: number): void {
    this.curvedJunctionLabels.reset();
    const g = this.graphics;
    g.clear();
    this.textIndex = 0;
    this.junctionLabelIndex = 0;
    this.hitCache.length = 0;
    this.handleHitCache.length = 0;
    const stats: PrimerOverlayRenderStats = {
      loadedPrimers: this.primers.length,
      drawnPrimers: 0,
      hitRecords: 0,
      culledByLod: 0,
      culledByViewport: 0,
      pixelsPerBp: path.pixelsPerBp,
      sequenceVisible: path.sequenceVisible,
      maxPrimerLane: this.maxPrimerLane,
      textGlyphs: 0,
      unsavedPrimerOutlines: 0,
      pbsHandles: 0,
      junctionScarHighlights: 0,
      junctionCutIndicators: 0,
      junctionIdentityLabels: 0,
      roleCounts: {},
      contractLod: null,
      firstJunction: null,
      drawnJunctions: [],
      firstDrawnPrimer: null,
    };
    const finishStats = () => {
      stats.hitRecords = this.hitCache.length;
      stats.textGlyphs = this.textIndex;
      this.lastRenderStats = stats;
    };
    if (this.primers.length === 0 || this.genomeLength <= 0) {
      this.hideUnusedText();
      finishStats();
      return;
    }

    const compactScale = this.layout?.compactScale ?? 1;
    const revealProgress = this.layout
      ? this.layout.sequenceRevealProgress
      : path.sequenceVisible
        ? 1
        : 0;
    const metrics = this.layout
      ? primerScreenMetricsForReveal(
          revealProgress,
          compactScale,
          path.sequenceFontSize,
          this.layout.primerFeatureLaneScale
        )
      : primerScreenMetrics(path.sequenceVisible, compactScale, path.sequenceFontSize);
    const laneHeight = metrics.laneHeight;
    const sectionGap = SECTION_GAP * compactScale;
    const margin = metrics.margin;
    const contract = this.layout
      ? resolvePrimerTrackContract({
          layout: this.layout,
          yOffset,
          sequenceVisible: path.sequenceVisible,
          compactScale,
          sequenceFontSize: path.sequenceFontSize,
          maxOverviewLane: this.maxPrimerLane,
          maxForwardLane: this.maxForwardPrimerLane,
          maxReverseLane: this.maxReversePrimerLane,
        })
      : null;
    stats.contractLod = contract?.lod ?? null;

    this.drawGoldenGateJunctions(g, path, state, stats);

    for (let index = 0; index < this.primers.length; index++) {
      if (this.primers[index].isScarMarkerOnly) continue;
      const primer = this.primerWithPbsEndpointPreview(this.primers[index]);
      const unsaved = isUnsavedPrimer(primer);
      const featureLen = primerLength(primer, this.genomeLength);
      const visualPlan = computePrimerVisualPlan(primer, featureLen);
      const pixelWidth = featureLen * path.pixelsPerBp;
      const lod = computePrimerLod(pixelWidth, path.sequenceVisible);
      if (lod === PrimerLOD.Hidden) {
        stats.culledByLod++;
        continue;
      }

      const useSplitLanes = contract?.side === 'overlay';
      const overviewLane = this.laneAssignments.get(index) ?? 0;
      const detailLane = this.detailLaneAssignments.get(index) ?? 0;
      const lane = useSplitLanes ? detailLane : overviewLane;
      const envelope = contract
        ? getPrimerLaneEnvelope(
            contract,
            primer.direction,
            lane,
            useSplitLanes ? overviewLane : undefined
          )
        : null;
      if (contract && !envelope) {
        throw new Error(`Primer lane contract missing ${primer.direction} lane ${lane}`);
      }
      const fallbackHalfHeight = metrics.barHeight / 2;
      const offset =
        envelope?.centerOffset ??
        this.computeOffset(path, yOffset, lane, laneHeight, sectionGap, margin, primer.direction);
      const halfHeight = envelope?.halfHeight ?? fallbackHalfHeight;
      if (!path.isFeatureVisible(primer.start, featureLen, offset, halfHeight)) {
        stats.culledByViewport++;
        continue;
      }
      const shapeMetrics = metrics;
      const drawHalfHeight = halfHeight;
      const endBp = primer.end > primer.start ? primer.end : primer.end + this.genomeLength;
      const pts =
        lod === PrimerLOD.Hairline
          ? this.hairlineShape(path, primer.start, featureLen, offset, drawHalfHeight)
          : this.primerShape(
              path,
              primer,
              primer.start,
              endBp,
              offset,
              drawHalfHeight,
              shapeMetrics.arrowWidth,
              shapeMetrics.arrowHeight,
              featureLen
            );
      const bbox = computeBBox(pts);
      if (!unsaved && !primer.isScarMarkerOnly) {
        this.hitCache.push({
          id: primer.renderId,
          start: primer.start,
          end: primer.end,
          pts,
          ...bbox,
        });
      }
      stats.drawnPrimers++;
      if (unsaved) stats.unsavedPrimerOutlines++;
      for (const role of visualPlan.fillSegments) {
        stats.roleCounts[role.role] = (stats.roleCounts[role.role] ?? 0) + 1;
      }
      if (!stats.firstDrawnPrimer) {
        stats.firstDrawnPrimer = {
          id: primer.id,
          renderId: primer.renderId,
          start: primer.start,
          end: primer.end,
          bbox: {
            xMin: +bbox.xMin.toFixed(1),
            xMax: +bbox.xMax.toFixed(1),
            yMin: +bbox.yMin.toFixed(1),
            yMax: +bbox.yMax.toFixed(1),
          },
          pbsHandle: null,
          contract: envelope
            ? {
                role: envelope.role,
                laneIndex: envelope.laneIndex,
                contractLaneIndex: envelope.contractLaneIndex,
                centerOffset: +envelope.centerOffset.toFixed(2),
                minOffset: +envelope.minOffset.toFixed(2),
                maxOffset: +envelope.maxOffset.toFixed(2),
              }
            : null,
        };
      }

      const isHovered = state.hoveredId === primer.renderId;
      if (lod === PrimerLOD.Hairline) {
        g.poly(pts);
        g.fill({
          color: primer.color,
          alpha: (isHovered ? 0.85 : 0.6) * (unsaved ? UNSAVED_PRIMER_ALPHA_MULTIPLIER : 1),
        });
        if (unsaved) {
          g.setStrokeStyle({
            width: path.scaleStroke(1.5),
            color: primer.color,
            alpha: 0.9 * UNSAVED_PRIMER_ALPHA_MULTIPLIER,
          });
          drawDashedPolygon(g, pts);
        }
        this.drawPbsHandle(g, path, state, primer, endBp, offset, stats);
        continue;
      }

      if (lod === PrimerLOD.Shape) {
        this.drawCompoundPrimer(
          g,
          path,
          primer,
          visualPlan,
          featureLen,
          offset,
          drawHalfHeight,
          shapeMetrics.arrowWidth,
          shapeMetrics.arrowHeight,
          !path.sequenceVisible
        );
        this.drawPbsHandle(g, path, state, primer, endBp, offset, stats);
        continue;
      }

      this.drawCompoundPrimer(
        g,
        path,
        primer,
        visualPlan,
        featureLen,
        offset,
        halfHeight,
        metrics.arrowWidth,
        metrics.arrowHeight
      );

      if (isHovered) {
        g.poly(pts);
        g.fill({ color: primer.color, alpha: 0.12 });
      }

      if (lod === PrimerLOD.Sequence) {
        this.drawPrimerBases(path, primer, visualPlan.textSegments, featureLen, offset);
      }
      this.drawPbsHandle(g, path, state, primer, endBp, offset, stats);
    }

    this.hideUnusedText();
    finishStats();
  }

  hitTest(
    screenX: number,
    screenY: number,
    _path: PathMapper,
    _state: RenderState
  ): OverlayHitResult | null {
    for (let i = this.handleHitCache.length - 1; i >= 0; i--) {
      const rec = this.handleHitCache[i];
      if (assemblyPrimerHandleContainsPoint(rec.geometry, { x: screenX, y: screenY })) {
        return { kind: 'primer-handle', payload: rec.payload };
      }
    }
    for (let i = this.hitCache.length - 1; i >= 0; i--) {
      const rec = this.hitCache[i];
      if (screenX < rec.xMin || screenX > rec.xMax || screenY < rec.yMin || screenY > rec.yMax) {
        continue;
      }
      if (!pointInPolygon(screenX, screenY, rec.pts)) continue;
      return {
        kind: 'feature',
        payload: { id: rec.id, start: rec.start, end: rec.end },
      };
    }
    return null;
  }

  private drawPbsHandle(
    g: Graphics,
    path: PathMapper,
    state: RenderState,
    primer: Primer,
    endBp: number,
    offset: number,
    stats: PrimerOverlayRenderStats
  ): void {
    if (
      !primer.editablePbsEndpoint ||
      primer.isScarMarkerOnly ||
      primer.isDraft ||
      primer.isCandidate
    ) {
      return;
    }
    const anchorBp = primer.direction === 'forward' ? endBp : primer.start;
    const point = boundaryPoint(path, anchorBp, offset);
    const angle = path.featureLabelPosAt(path.isArcMode ? anchorBp - 0.5 : anchorBp, offset).angle;
    const visual = assemblyPrimerHandleVisualForMode(state.themeMode);
    const geometry = assemblyPrimerHandleGeometry({
      anchorX: point.x,
      anchorY: point.y,
      angle,
    });
    const backbonePoint = boundaryPoint(path, anchorBp, 0);
    const normalX = -Math.sin(angle);
    const normalY = Math.cos(angle);
    const normalOffsetPx =
      (geometry.gripCenter.x - backbonePoint.x) * normalX +
      (geometry.gripCenter.y - backbonePoint.y) * normalY;
    g.setStrokeStyle({
      color: visual.guideColor,
      width: visual.guideWidthPx,
      alpha: 1,
    });
    drawDashedLine(
      g,
      geometry.anchor.x,
      geometry.anchor.y,
      geometry.guideEnd.x,
      geometry.guideEnd.y,
      visual.guideDashPx,
      visual.guideGapPx
    );
    g.save();
    g.rotateTransform(geometry.angle);
    g.translateTransform(geometry.gripCenter.x, geometry.gripCenter.y);
    g.roundRect(
      -visual.gripWidthPx / 2,
      -visual.gripHeightPx / 2,
      visual.gripWidthPx,
      visual.gripHeightPx,
      visual.gripRadiusPx
    );
    g.fill({ color: visual.gripFillColor, alpha: 1 });
    g.stroke({ color: visual.gripBorderColor, width: visual.gripBorderWidthPx, alpha: 1 });
    g.restore();
    this.handleHitCache.push({
      x: geometry.gripCenter.x,
      y: geometry.gripCenter.y,
      normalOffsetPx,
      geometry,
      visual,
      payload: {
        id: primer.renderId,
        primerId: primer.id,
        start: primer.start,
        end: primer.end,
        direction: primer.direction,
        overhangLength: primer.overhangLength ?? 0,
        anchorBp,
      },
    });
    stats.pbsHandles += 1;
    if (stats.firstDrawnPrimer?.renderId === primer.renderId) {
      stats.firstDrawnPrimer.pbsHandle = {
        x: geometry.gripCenter.x,
        y: geometry.gripCenter.y,
        anchorBp,
        angle,
        visual,
      };
    }
  }

  destroy(): void {
    this.curvedJunctionLabels.destroy();
    for (const text of this.textPool) destroyPixiText(text);
    for (const text of this.junctionLabelPool) destroyPixiText(text);
    this.textPool = [];
    this.junctionLabelPool = [];
    this.textStyleCache.clear();
    this.graphics.destroy();
    this.textContainer.destroy();
    this.container.destroy();
  }

  private drawGoldenGateJunctions(
    g: Graphics,
    path: PathMapper,
    state: RenderState,
    stats: PrimerOverlayRenderStats
  ): void {
    if (!path.sequenceVisible || path.sequenceOpacity <= 0 || !this.layout) return;

    const theme = webglThemeForMode(state.themeMode);
    const visual = GOLDEN_GATE_JUNCTION_VISUAL;
    const sequenceBandCenterOffset =
      (this.layout.cutLineTopOffset + this.layout.cutLineBottomOffset) / 2;
    const sequenceBandHalfHeight =
      (this.layout.cutLineBottomOffset - this.layout.cutLineTopOffset) / 2;
    const pendingLabels: Array<CutSiteLabelAnchor & { text: string }> = [];

    for (const primer of this.primers) {
      const junction = resolveGoldenGateJunctionVisual(primer, this.genomeLength);
      if (!junction) continue;
      if (
        !path.isFeatureVisible(
          junction.scarStart,
          junction.scarLengthBp,
          sequenceBandCenterOffset,
          sequenceBandHalfHeight
        )
      ) {
        continue;
      }

      const stadiumBoundaryOffsetBp = path.isArcMode ? -0.5 : 0;
      const scarPathStart = junction.scarStart + stadiumBoundaryOffsetBp;
      const scarPathEnd = junction.scarEndUnwrapped + stadiumBoundaryOffsetBp;
      const scarPolygon = path.featurePolygonAt(
        scarPathStart,
        scarPathEnd,
        sequenceBandCenterOffset,
        sequenceBandHalfHeight
      );
      g.poly(scarPolygon);
      g.fill({
        color: visual.productScar.fillColorPixi,
        alpha: visual.productScar.fillAlpha,
      });
      stats.junctionScarHighlights += 1;

      const topCut = path.boundaryAt(junction.scarStart, 'cutTop');
      const topConnector = path.boundaryAt(junction.scarStart, 'cutConnector');
      const bottomConnector = path.boundaryAt(junction.scarEndUnwrapped, 'cutConnector');
      const bottomCut = path.boundaryAt(junction.scarEndUnwrapped, 'cutBottom');
      g.setStrokeStyle({
        width: path.scaleStroke(visual.cutLine.widthPx),
        color: theme.text,
        alpha: 1,
      });
      g.moveTo(topCut.x, topCut.y);
      g.lineTo(topConnector.x, topConnector.y);
      g.lineTo(bottomConnector.x, bottomConnector.y);
      g.lineTo(bottomCut.x, bottomCut.y);
      g.stroke();
      stats.junctionCutIndicators += 1;

      const drawnJunction = {
        primerId: primer.id,
        scarStart: junction.scarStart,
        scarEnd: junction.scarEnd,
        identityLabel: junction.identityLabel,
      };
      stats.drawnJunctions.push(drawnJunction);
      stats.firstJunction ??= drawnJunction;

      if (!junction.identityLabel) continue;
      const labelBp = junction.scarStart + junction.scarLengthBp / 2 + stadiumBoundaryOffsetBp;
      const labelW =
        junction.identityLabel.length *
          visual.identityLabel.fontSizePx *
          visual.identityLabel.monospaceCharacterWidthEm +
        visual.identityLabel.horizontalPaddingPx * 2;
      const labelH = visual.identityLabel.fontSizePx + visual.identityLabel.verticalPaddingPx * 2;
      const placement = labelPlacementAt(path, labelBp, labelH);
      pendingLabels.push({
        text: junction.identityLabel,
        labelBp,
        labelW,
        labelH,
        labelTopX: placement.topX,
        labelTopY: placement.topY,
        labelCenterX: placement.centerX,
        labelCenterY: placement.centerY,
        angle: placement.angle,
      });
      stats.junctionIdentityLabels += 1;
    }
    for (const label of resolveCutSiteLabels(pendingLabels, path, this.genomeLength)) {
      this.drawGoldenGateIdentityLabel(g, path, theme, label);
    }
  }

  private drawGoldenGateIdentityLabel(
    g: Graphics,
    path: PathMapper,
    theme: WebGLRenderTheme,
    resolved: { text: string; labelBp: number; finalBp: number; labelW: number; labelH: number }
  ): void {
    const {
      text: labelText,
      labelBp: scarCenterBp,
      finalBp,
      labelW: width,
      labelH: height,
    } = resolved;
    const visual = GOLDEN_GATE_JUNCTION_VISUAL.identityLabel;
    const label = this.acquireJunctionLabel();
    label.visible = true;
    label.text = labelText;
    label.style = this.getJunctionLabelTextStyle(theme.text);
    label.anchor.set(0.5, 0.5);

    const placement = labelPlacementAt(path, finalBp, height);
    const { angle } = placement;
    const labelCenter = { x: placement.centerX, y: placement.centerY };
    const connectorStart = path.boundaryAt(scarCenterBp, 'cutBottom');

    g.setStrokeStyle({
      width: path.scaleStroke(visual.connectorWidthPx),
      color: theme.text,
      alpha: 0.6,
    });
    drawDashedPolyline(
      g,
      buildCutSiteLabelConnectorPolyline(path, height, connectorStart, scarCenterBp, finalBp),
      visual.connectorDashPx[0],
      visual.connectorDashPx[1]
    );
    g.stroke();

    const box = labelBoxPolygonAtPath(path, finalBp, width, height);
    const backgroundColor =
      theme.mode === 'dark' ? visual.darkBackgroundColorPixi : visual.lightBackgroundColorPixi;
    const backgroundAlpha =
      theme.mode === 'dark' ? visual.darkBackgroundAlpha : visual.lightBackgroundAlpha;
    g.poly(box);
    g.fill({ color: backgroundColor, alpha: backgroundAlpha });
    g.setStrokeStyle({
      width: path.scaleStroke(visual.borderWidthPx),
      color: theme.text,
      alpha: 1,
    });
    g.poly(box);
    g.stroke();

    label.x = labelCenter.x;
    label.y = labelCenter.y;
    label.rotation = readableTextRotation(angle);
    label.alpha = path.sequenceOpacity;
    renderCutSiteLabelText(
      label,
      this.curvedJunctionLabels,
      path,
      finalBp,
      height,
      theme.text,
      path.sequenceOpacity
    );
  }

  private drawCompoundPrimer(
    g: Graphics,
    path: PathMapper,
    primer: Primer,
    visualPlan: PrimerVisualPlan,
    featureLen: number,
    offset: number,
    halfHeight: number,
    arrowWidth: number,
    arrowHeight: number,
    solidFillOnly = false
  ): void {
    const unsaved = isUnsavedPrimer(primer);
    const alphaMultiplier = unsaved ? UNSAVED_PRIMER_ALPHA_MULTIPLIER : 1;
    for (const segment of visualPlan.fillSegments) {
      const fillAlpha = solidFillOnly
        ? Math.max(segment.alpha, OVERVIEW_PRIMER_FILL_ALPHA)
        : segment.alpha;
      if (fillAlpha <= 0 && segment.strokeStyle === 'none') continue;
      const startBp = primer.start + segment.startBase;
      const endBp = primer.start + segment.endBase;
      const pts = this.primerShape(
        path,
        primer,
        startBp,
        endBp,
        offset,
        halfHeight,
        arrowWidth,
        arrowHeight,
        featureLen,
        {
          segmentFrom: segment.startBase,
          segmentTo: segment.endBase,
        }
      );

      g.poly(pts);
      if (fillAlpha > 0) {
        g.fill({ color: segment.fillColor, alpha: fillAlpha * alphaMultiplier });
      }
      if (solidFillOnly) continue;
      if (segment.strokeStyle === 'none') continue;
      g.setStrokeStyle({
        width: path.scaleStroke(GOLDEN_GATE_JUNCTION_VISUAL.primer.segmentStrokeWidthPx),
        color: segment.strokeColor,
        alpha: 0.9 * alphaMultiplier,
      });
      this.strokePrimerSegmentBorder(
        g,
        path,
        pts,
        startBp,
        endBp,
        offset,
        halfHeight,
        segment,
        unsaved
      );
    }
  }

  private strokePrimerSegmentBorder(
    g: Graphics,
    path: PathMapper,
    pts: number[],
    startBp: number,
    endBp: number,
    offset: number,
    halfHeight: number,
    segment: PrimerVisualFillSegment,
    forceDashed: boolean
  ): void {
    const strokeStyle = segment.strokeStyle;
    if (strokeStyle === 'none' || segment.borderMode === 'none') return;

    if (segment.borderMode === 'outline') {
      if (forceDashed || strokeStyle === 'dotted') {
        drawDashedPolygon(g, pts);
      } else {
        g.poly(pts);
        g.stroke();
      }
      return;
    }

    const topOffset = offset - halfHeight;
    const bottomOffset = offset + halfHeight;
    const top = boundaryPolyline(path, startBp, endBp, topOffset);
    const bottom = boundaryPolyline(path, startBp, endBp, bottomOffset);
    const startBoundary = [
      boundaryPoint(path, startBp, topOffset),
      boundaryPoint(path, startBp, bottomOffset),
    ];
    const endBoundary = [
      boundaryPoint(path, endBp, topOffset),
      boundaryPoint(path, endBp, bottomOffset),
    ];

    if (segment.borderMode === 'horizontal') {
      strokePolyline(g, top, strokeStyle, forceDashed);
      strokePolyline(g, bottom, strokeStyle, forceDashed);
      return;
    }

    if (segment.borderMode === 'open-right') {
      strokePolyline(g, top, strokeStyle, forceDashed);
      strokePolyline(g, bottom, strokeStyle, forceDashed);
      strokePolyline(g, startBoundary, strokeStyle, forceDashed);
      return;
    }

    if (segment.borderMode === 'open-left') {
      strokePolyline(g, top, strokeStyle, forceDashed);
      strokePolyline(g, bottom, strokeStyle, forceDashed);
      strokePolyline(g, endBoundary, strokeStyle, forceDashed);
      return;
    }

    if (segment.borderMode === 'primer-forward' || segment.borderMode === 'primer-reverse') {
      const skipBp = segment.borderMode === 'primer-forward' ? startBp : endBp;
      const skipTop = boundaryPoint(path, skipBp, topOffset);
      const skipBottom = boundaryPoint(path, skipBp, bottomOffset);
      const tolerance = Math.max(2.5, path.scaleStroke(2));
      strokePolygonEdges(g, pts, strokeStyle, forceDashed, (a, b) => {
        return boundaryDistance(a, b, skipTop, skipBottom) <= tolerance;
      });
    }
  }

  private hairlineShape(
    path: PathMapper,
    startBp: number,
    featureLen: number,
    offset: number,
    halfHeight: number
  ): number[] {
    const minLenBp = PRIMER_HAIRLINE_MIN_WIDTH / Math.max(path.pixelsPerBp, 0.0001);
    const visibleLen = Math.max(featureLen, minLenBp);
    const centerBp = startBp + featureLen / 2;
    return path.featurePolygonAt(
      centerBp - visibleLen / 2,
      centerBp + visibleLen / 2,
      offset,
      Math.max(1.5, halfHeight * 0.45)
    );
  }

  private primerShape(
    path: PathMapper,
    primer: Primer,
    startBp: number,
    endBp: number,
    offset: number,
    halfHeight: number,
    arrowWidth: number,
    arrowHeight: number,
    featureLen: number,
    segment?: { segmentFrom: number; segmentTo: number }
  ): number[] {
    const segmentFrom = segment?.segmentFrom ?? 0;
    const segmentTo = segment?.segmentTo ?? featureLen;
    const showForward = primer.direction === 'forward' && segmentTo === featureLen;
    const showReverse = primer.direction === 'reverse' && segmentFrom === 0;
    const arrowPosition: PrimerArrowPosition = primer.direction === 'forward' ? 'above' : 'below';

    return buildCanvasPrimerShapePolygon(
      path,
      { start: startBp, end: endBp, direction: primer.direction },
      endBp,
      offset,
      halfHeight,
      arrowWidth,
      arrowHeight,
      arrowPosition,
      showForward,
      showReverse
    );
  }

  private drawPrimerBases(
    path: PathMapper,
    primer: Primer,
    textSegments: readonly PrimerVisualTextSegment[],
    featureLen: number,
    offset: number
  ): void {
    if (
      !path.sequenceVisible ||
      path.sequenceOpacity <= 0 ||
      !primer.bases ||
      featureLen <= 0 ||
      featureLen > MAX_PRIMER_TEXT_GLYPHS
    ) {
      return;
    }

    const fontSize = path.sequenceFontSize;
    const rasterSize = Math.pow(2, Math.ceil(Math.log2(Math.max(4, fontSize))));
    const displayScale = fontSize / rasterSize;
    const mismatchPositions = new Set(primer.mismatches?.map((m) => m.position) ?? []);
    const roleByBase = new Array<PrimerVisualTextSegment | undefined>(featureLen);
    for (const role of textSegments) {
      for (let baseIndex = role.startBase; baseIndex < role.endBase; baseIndex++) {
        if (baseIndex >= 0 && baseIndex < featureLen) roleByBase[baseIndex] = role;
      }
    }

    for (let baseIndex = 0; baseIndex < featureLen; baseIndex++) {
      const rawBp = primer.start + baseIndex;
      const bp = positiveModulo(rawBp, this.genomeLength);
      const pos = path.featureLabelPosAt(rawBp, offset);
      const visual = primerBaseVisual(
        primer,
        baseIndex,
        featureLen,
        mismatchPositions,
        roleByBase[baseIndex]
      );
      if (!visual.text) continue;

      const text = this.acquireText();
      text.visible = true;
      text.text = visual.text;
      text.style = this.getTextStyle(visual.color, visual.bold, rasterSize);
      text.scale.set(displayScale);
      text.anchor.set(0.5, 0.5);
      text.x = pos.x;
      text.y = pos.y;
      text.rotation = pos.angle;
      text.alpha = path.sequenceOpacity;
      (text as Text & { __bp?: number }).__bp = bp;
    }
  }

  private acquireText(): Text {
    let text = this.textPool[this.textIndex];
    if (!text) {
      text = new Text({ text: '', style: this.getTextStyle(DEFAULT_PBS_COLOR, false, 8) });
      this.textPool.push(text);
      this.textContainer.addChild(text);
    }
    this.textIndex++;
    return text;
  }

  private acquireJunctionLabel(): Text {
    let text = this.junctionLabelPool[this.junctionLabelIndex];
    if (!text) {
      text = new Text({ text: '', style: this.getJunctionLabelTextStyle(0x222222) });
      this.junctionLabelPool.push(text);
      this.textContainer.addChild(text);
    }
    this.junctionLabelIndex++;
    return text;
  }

  private hideUnusedText(): void {
    for (let i = this.textIndex; i < this.textPool.length; i++) {
      this.textPool[i].visible = false;
    }
    for (let i = this.junctionLabelIndex; i < this.junctionLabelPool.length; i++) {
      this.junctionLabelPool[i].visible = false;
    }
  }

  private getJunctionLabelTextStyle(color: number): TextStyle {
    const visual = GOLDEN_GATE_JUNCTION_VISUAL.identityLabel;
    const key = `junction:${color}:${visual.fontSizePx}:${visual.fontWeight}`;
    let style = this.textStyleCache.get(key);
    if (!style) {
      style = new TextStyle({
        fontFamily: CUT_SITE_LABEL_FONT_FAMILY,
        fontSize: visual.fontSizePx,
        fill: color,
        fontWeight: `${visual.fontWeight}`,
      });
      this.textStyleCache.set(key, style);
    }
    return style;
  }

  private getTextStyle(color: number, bold: boolean, fontSize: number): TextStyle {
    const key = `${color}:${bold ? 1 : 0}:${fontSize}`;
    let style = this.textStyleCache.get(key);
    if (style) {
      this.textStyleCache.delete(key);
      this.textStyleCache.set(key, style);
      return style;
    }
    style = new TextStyle({
      fontFamily: SEQUENCE_FONT_FAMILY,
      fontSize,
      fill: color,
      fontWeight: bold ? `${GOLDEN_GATE_JUNCTION_VISUAL.primer.scarBaseFontWeight}` : '400',
    });
    this.textStyleCache.set(key, style);
    while (this.textStyleCache.size > PRIMER_TEXT_STYLE_CACHE_MAX_ENTRIES) {
      const oldestKey = this.textStyleCache.keys().next().value;
      if (oldestKey === undefined) break;
      this.textStyleCache.delete(oldestKey);
    }
    return style;
  }

  private computeOffset(
    path: PathMapper,
    yOffset: number,
    lane: number,
    laneHeight: number,
    sectionGap: number,
    margin: number,
    direction: 'forward' | 'reverse'
  ): number {
    if (!path.sequenceVisible && this.layout) {
      const primerSlot = this.layout.below.find((slot) => slot.overlay.id === this.id);
      const trackTopY = primerSlot?.yOffset ?? yOffset;
      const centerY = trackTopY + margin + lane * laneHeight + laneHeight / 2;
      return centerY - this.layout.fwdStrandTop;
    }

    if (path.sequenceVisible && this.layout) {
      const primerSlot = this.layout.below.find((slot) => slot.overlay.id === this.id);
      const trackTopY = primerSlot?.yOffset ?? yOffset;
      const sourceLane =
        direction === 'forward' ? lane : Math.max(0, this.maxForwardPrimerLane + 1) + lane;
      const centerY = trackTopY + margin + sourceLane * laneHeight + laneHeight / 2;
      return centerY - this.layout.fwdStrandTop;
    }

    if (!path.isArcMode && this.layout && yOffset > 0) {
      const centerY = yOffset + margin + lane * laneHeight + laneHeight / 2;
      return centerY - this.layout.fwdStrandTop;
    }

    const baseOffset = this.layout?.cutLineBottomOffset ?? 12;
    return baseOffset + sectionGap + margin + lane * laneHeight + laneHeight / 2;
  }
}
