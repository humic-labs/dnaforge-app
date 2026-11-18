import { canvasCdsMetrics } from '@waypoint/platform';
import {
  computeLayoutModel,
  bpLeftX as modelBpLeftX,
  bpCenterX as modelBpCenterX,
  translationLaneCenterY,
  annotationLaneY as modelAnnotationLaneY,
  LANE_HEIGHT,
  type LayoutModel,
  type LayoutInputs,
} from './layout-model';
import { sequenceFontSizeForPixelsPerBp, sequenceRowHeightForFontSize } from './sequence-sizing';

import {
  seqPosToPointNorm,
  type StadiumDimensions,
  type StadiumPoint,
  closestSeqPosOnBackbone,
} from '../../../geometry/stadium';
import type { PathMapper, Pos2, Pos3 } from './path-types';
export type { PathMapper, Pos2, Pos3 } from './path-types';

interface FeaturePolygonSample {
  x: number;
  y: number;
  angle: number;
  nx: number;
  ny: number;
}

const FEATURE_POLYGON_MAX_SCREEN_ERROR_PX = 0.45;
const FEATURE_POLYGON_MAX_ANGLE_STEP_RAD = Math.PI / 48;
const FEATURE_POLYGON_MAX_SAMPLES = 512;
const FEATURE_POLYGON_MAX_DEPTH = 14;

export class LinearPathMapper implements PathMapper {
  private model: LayoutModel;
  private _layout?: import('./track-layout').UnifiedLayout;

  get fwdStrandTop() {
    return this.model.fwdStrandTop;
  }
  get fwdStrandBottom() {
    return this.model.fwdStrandBottom;
  }
  get revStrandTop() {
    return this.model.revStrandTop;
  }
  get revStrandBottom() {
    return this.model.revStrandBottom;
  }
  get cutLineTopY() {
    return this.model.cutLineTop;
  }
  get cutLineBottomY() {
    return this.model.cutLineBottom;
  }
  get cutLabelY() {
    return this.model.cutLabelY;
  }
  get pixelsPerBp() {
    return this.model.pixelsPerBp;
  }
  get viewStartBp() {
    return this.model.viewStartBp;
  }
  get viewEndBp() {
    return this.model.viewEndBp;
  }
  get sequenceVisible() {
    return this.model.sequenceVisible;
  }
  get sequenceOpacity() {
    return this.model.sequenceOpacity;
  }
  get rowHeight() {
    return this.model.rowHeight;
  }
  get sequenceFontSize() {
    return this.model.sequenceFontSize;
  }
  get cdsZoomPresentation() {
    return this._layout?.cdsZoomPresentation;
  }
  get cdsChevronHeight() {
    return this._layout?.cdsChevronHeight;
  }

  constructor(inputs: LayoutInputs) {
    this.model = computeLayoutModel(inputs);
  }

  static fromModel(model: LayoutModel): LinearPathMapper {
    const pm = Object.create(LinearPathMapper.prototype) as LinearPathMapper;
    pm.model = model;
    return pm;
  }

  static fromUnifiedLayout(
    layout: import('./track-layout').UnifiedLayout,
    viewportWidth: number,
    bpPerPixel: number,
    viewStartBp: number,
    viewEndBp: number,
    annotationLanes: number,
    translationLanes: number,
    viewportHeight: number
  ): LinearPathMapper {
    const model: LayoutModel = {
      viewportWidth,
      viewportHeight,
      bpPerPixel,
      pixelsPerBp: 1 / bpPerPixel,
      viewStartBp,
      viewEndBp,
      sequenceFontSize: layout.sequenceFontSize,
      rowHeight: layout.rowHeight,
      sequenceVisible: layout.sequenceVisible,
      sequenceOpacity: layout.sequenceOpacity,
      annotationLanes,
      translationLanes,
      annotationTop: layout.annotationTop,
      annotationHeight: layout.annotationHeight,
      translationTop: layout.translationTop,
      translationLaneHeight: layout.translationLaneHeight,
      translationHeight: layout.translationHeight,
      fwdStrandTop: layout.fwdStrandTop,
      fwdStrandCenter: layout.fwdStrandCenter,
      fwdStrandBottom: layout.fwdStrandBottom,
      revStrandTop: layout.revStrandTop,
      revStrandCenter: layout.revStrandCenter,
      revStrandBottom: layout.revStrandBottom,
      rulerY: layout.rulerY,
      totalHeight: layout.totalHeight,
      cutLineTop: layout.cutLineTop,
      cutLineBottom: layout.cutLineBottom,
      cutLineConnectorY: layout.cutLineConnectorY,
      cutLabelY: layout.cutLabelY,
    };
    const pm = Object.create(LinearPathMapper.prototype) as LinearPathMapper;
    pm.model = model;
    pm._layout = layout;
    return pm;
  }

  getModel(): LayoutModel {
    return this.model;
  }

  scaleStroke(baseWidth: number): number {
    const scale = Math.min(1, Math.max(0.3, this.model.pixelsPerBp / 5));
    return Math.max(0.5, baseWidth * scale);
  }

  scaleNormalOffset(baseOffsetPx: number): number {
    return baseOffsetPx;
  }

  isNormalBandRenderable(_offsetPx: number, _halfHeightPx: number): boolean {
    return true;
  }

  boundaryAt(
    bp: number,
    layer: 'backbone' | 'fwdStrand' | 'revStrand' | 'cutTop' | 'cutConnector' | 'cutBottom'
  ): Pos2 {
    const x = modelBpLeftX(this.model, bp);
    const yMap = {
      backbone: this.model.fwdStrandTop - 2,
      fwdStrand: this.model.fwdStrandCenter,
      revStrand: this.model.revStrandCenter,
      cutTop: this.model.cutLineTop,
      cutConnector: this.model.cutLineConnectorY,
      cutBottom: this.model.cutLineBottom,
    };
    return { x, y: yMap[layer] };
  }

  backboneAt(bp: number): Pos3 {
    return { x: modelBpCenterX(this.model, bp), y: this.model.fwdStrandTop - 2, angle: 0 };
  }

  fwdStrandAt(bp: number): Pos3 {
    return { x: modelBpCenterX(this.model, bp), y: this.model.fwdStrandCenter, angle: 0 };
  }

  revStrandAt(bp: number): Pos3 {
    return { x: modelBpCenterX(this.model, bp), y: this.model.revStrandCenter, angle: 0 };
  }

  cutLineTopAt(bp: number): Pos2 {
    return this.boundaryAt(bp, 'cutTop');
  }
  cutLineConnectorAt(bp: number): Pos2 {
    return this.boundaryAt(bp, 'cutConnector');
  }
  cutLineBottomAt(bp: number): Pos2 {
    return this.boundaryAt(bp, 'cutBottom');
  }

  translationAt(bp: number, laneIndex: number): Pos3 {
    return {
      x: modelBpCenterX(this.model, bp),
      y: translationLaneCenterY(this.model, laneIndex),
      angle: 0,
    };
  }

  annotationAt(bp: number, lane: number): Pos3 {
    return {
      x: modelBpLeftX(this.model, bp),
      y: modelAnnotationLaneY(this.model, lane),
      angle: 0,
    };
  }

  rulerAt(bp: number): Pos3 {
    return { x: modelBpCenterX(this.model, bp), y: this.model.rulerY, angle: 0 };
  }

  bpLeftX(bp: number): number {
    return modelBpLeftX(this.model, bp);
  }

  bpCenterX(bp: number): number {
    return modelBpCenterX(this.model, bp);
  }

  readonly isArcMode = false;

  featurePolygonAt(
    startBp: number,
    endBp: number,
    offsetPx: number,
    halfHeight?: number
  ): number[] {
    const hh = halfHeight ?? LANE_HEIGHT / 2;
    const x1 = modelBpLeftX(this.model, startBp);
    const x2 = modelBpLeftX(this.model, endBp);

    const cy = this.model.fwdStrandTop + offsetPx;
    return [x1, cy - hh, x2, cy - hh, x2, cy + hh, x1, cy + hh];
  }

  featureQuadAt(startBp: number, endBp: number, offsetPx: number, halfHeight?: number): number[] {
    return this.featurePolygonAt(startBp, endBp, offsetPx, halfHeight);
  }

  featureLabelPosAt(bp: number, offsetPx: number): Pos3 {
    return {
      x: modelBpCenterX(this.model, bp),
      y: this.model.fwdStrandTop + offsetPx,
      angle: 0,
    };
  }

  isFeatureVisible(startBp: number, featureLenBp: number): boolean {
    const x1 = modelBpLeftX(this.model, startBp);
    const px = featureLenBp * this.model.pixelsPerBp;
    return x1 + px > -50 && x1 < this.model.viewportWidth + 50;
  }

  cutLabelAt(bp: number): Pos2 {
    return { x: modelBpLeftX(this.model, bp), y: this.model.cutLabelY };
  }
}

export interface StadiumPathInputs {
  genomeLength: number;
  viewOffset: number;
  zoom: number;
  dims: StadiumDimensions;

  ox: number;
  oy: number;
  stagePosX: number;
  stagePosY: number;

  bpPerPixel: number;

  hasSequence: boolean;

  viewportWidth: number;

  viewportHeight: number;

  geometryHeight?: number;

  layout?: import('./track-layout').UnifiedLayout;
}

export interface StadiumRetainedCameraParams {
  genomeLength: number;
  viewOffset: number;
  zoom: number;
  dims: StadiumDimensions;
  ox: number;
  oy: number;
  stagePosX: number;
  stagePosY: number;
  viewportWidth: number;
  viewportHeight: number;
  offsetScale: number;
}

export class StadiumPathMapper implements PathMapper {
  private inputs: StadiumPathInputs;
  private zInv: number;

  private _maxSegmentLengthPx: number | null = null;
  private _maxSpanBpUnderBudget: number | null = null;

  private fwdOffset: number;
  private revOffset: number;
  private cutTopOffset: number;
  private cutBottomOffset: number;
  private cutConnectorOffset: number;
  private cutLabelOffset: number;
  private rulerOffset: number;

  readonly pixelsPerBp: number;
  readonly viewStartBp: number;
  readonly viewEndBp: number;
  readonly sequenceVisible: boolean;
  readonly sequenceOpacity: number;
  readonly rowHeight: number;
  readonly sequenceFontSize: number;
  readonly cdsChevronHeight: number;

  /** Layout-provided ruler offset (0 when the layout does not set one). */
  get layoutRulerOffset(): number {
    return this.inputs.layout?.rulerOffset ?? 0;
  }

  get fwdStrandTop() {
    return 0;
  }
  get fwdStrandBottom() {
    return 0;
  }
  get revStrandTop() {
    return 0;
  }
  get revStrandBottom() {
    return 0;
  }
  get cutLineTopY() {
    return 0;
  }
  get cutLineBottomY() {
    return 0;
  }
  get cutLabelY() {
    return 0;
  }

  private offsetScale: number = 1;

  constructor(inputs: StadiumPathInputs) {
    this.inputs = inputs;
    this.zInv = 1 / inputs.zoom;

    const circumPx = inputs.dims.totalLength * inputs.zoom;
    const L = inputs.layout;
    this.pixelsPerBp = circumPx / inputs.genomeLength;
    this.sequenceVisible = L ? L.sequenceVisible : inputs.hasSequence && inputs.bpPerPixel < 5;
    this.sequenceOpacity = L
      ? L.sequenceOpacity
      : this.sequenceVisible
        ? inputs.bpPerPixel <= 2
          ? 1
          : 1 - (inputs.bpPerPixel - 2) / 3
        : 0;

    const topMidFrac =
      inputs.dims.straightLength > 0 ? inputs.dims.straightLength / inputs.dims.totalLength / 2 : 0;
    const viewportSpanPx =
      (inputs.viewportWidth + (inputs.geometryHeight ?? inputs.viewportHeight)) * 2;
    const visibleBpCount = viewportSpanPx / Math.max(this.pixelsPerBp, 1e-6);
    const viewCenterFrac = (((topMidFrac + inputs.viewOffset) % 1) + 1) % 1;
    const viewCenterBp = viewCenterFrac * inputs.genomeLength;
    this.viewStartBp = Math.floor(viewCenterBp - visibleBpCount / 2);
    this.viewEndBp = Math.ceil(viewCenterBp + visibleBpCount / 2);

    this.sequenceFontSize = L
      ? L.sequenceFontSize
      : sequenceFontSizeForPixelsPerBp(this.pixelsPerBp);
    this.rowHeight = L ? L.rowHeight : sequenceRowHeightForFontSize(this.sequenceFontSize);
    this.cdsChevronHeight =
      L?.cdsChevronHeight ?? Math.max(5.4, canvasCdsMetrics(this.pixelsPerBp).aaHeight);

    if (L) {
      this.offsetScale = Math.max(0, Math.min(1, L.laneGeometryScale ?? L.overviewLaneScale ?? 1));
      this.fwdOffset = L.fwdStrandCenter - L.fwdStrandTop;
      this.revOffset = L.revStrandCenter - L.fwdStrandTop;
      this.cutTopOffset = L.cutLineTopOffset;
      this.cutBottomOffset = L.cutLineBottomOffset;
      this.cutConnectorOffset = L.cutLineConnectorOffset;
      this.cutLabelOffset = L.cutLabelOffset;
      this.rulerOffset = L.rulerOffset;
    } else {
      const rh = this.rowHeight;
      this.fwdOffset = 6 + rh / 2;
      this.revOffset = this.fwdOffset + rh / 2 + 2 + rh / 2;
      this.cutTopOffset = this.fwdOffset - rh / 2;
      this.cutBottomOffset = this.revOffset + rh / 2;
      this.cutConnectorOffset = this.fwdOffset + rh / 2;
      this.cutLabelOffset = this.cutBottomOffset + 4;
      this.rulerOffset = this.revOffset + rh / 2 + 2 + 8;
    }
  }

  private scaledOffset(screenPx: number): number {
    return screenPx * this.offsetScale;
  }

  getRetainedCameraParams(): StadiumRetainedCameraParams {
    return {
      genomeLength: this.inputs.genomeLength,
      viewOffset: this.inputs.viewOffset,
      zoom: this.inputs.zoom,
      dims: this.inputs.dims,
      ox: this.inputs.ox,
      oy: this.inputs.oy,
      stagePosX: this.inputs.stagePosX,
      stagePosY: this.inputs.stagePosY,
      viewportWidth: this.inputs.viewportWidth,
      viewportHeight: this.inputs.viewportHeight,
      offsetScale: this.offsetScale,
    };
  }

  private bbPoint(bp: number): StadiumPoint {
    return seqPosToPointNorm(
      bp,
      this.inputs.genomeLength,
      this.inputs.viewOffset,
      this.inputs.dims
    );
  }

  private toScreen(wx: number, wy: number): Pos2 {
    return {
      x: (this.inputs.ox + wx) * this.inputs.zoom + this.inputs.stagePosX,
      y: (this.inputs.oy + wy) * this.inputs.zoom + this.inputs.stagePosY,
    };
  }

  private screenOffset3(bp: number, screenPx: number): Pos3 {
    const pt = this.bbPoint(bp);
    const scr = this.toScreen(pt.x, pt.y);
    const nx = -Math.sin(pt.angle);
    const ny = Math.cos(pt.angle);
    return {
      x: scr.x + nx * screenPx,
      y: scr.y + ny * screenPx,
      angle: pt.angle,
    };
  }

  private screenOffset2(bp: number, screenPx: number): Pos2 {
    const pt = this.bbPoint(bp);
    const scr = this.toScreen(pt.x, pt.y);
    const nx = -Math.sin(pt.angle);
    const ny = Math.cos(pt.angle);
    return {
      x: scr.x + nx * screenPx,
      y: scr.y + ny * screenPx,
    };
  }

  backboneAt(bp: number): Pos3 {
    const pt = this.bbPoint(bp);
    const scr = this.toScreen(pt.x, pt.y);
    return { x: scr.x, y: scr.y, angle: pt.angle };
  }

  fwdStrandAt(bp: number): Pos3 {
    return this.screenOffset3(bp, this.scaledOffset(this.fwdOffset));
  }
  revStrandAt(bp: number): Pos3 {
    return this.screenOffset3(bp, this.scaledOffset(this.revOffset));
  }

  boundaryAt(
    bp: number,
    layer: 'backbone' | 'fwdStrand' | 'revStrand' | 'cutTop' | 'cutConnector' | 'cutBottom'
  ): Pos2 {
    const offsetMap = {
      backbone: 0,
      fwdStrand: this.fwdOffset,
      revStrand: this.revOffset,
      cutTop: this.cutTopOffset,
      cutConnector: this.cutConnectorOffset,
      cutBottom: this.cutBottomOffset,
    };
    return this.screenOffset2(bp - 0.5, this.scaledOffset(offsetMap[layer]));
  }

  cutLineTopAt(bp: number): Pos2 {
    return this.boundaryAt(bp, 'cutTop');
  }
  cutLineConnectorAt(bp: number): Pos2 {
    return this.boundaryAt(bp, 'cutConnector');
  }
  cutLineBottomAt(bp: number): Pos2 {
    return this.boundaryAt(bp, 'cutBottom');
  }

  translationAt(bp: number, laneIndex: number): Pos3 {
    const L = this.inputs.layout;
    const screenPx = L
      ? this.scaledOffset(L.translationOffset - laneIndex * L.translationStep)
      : -10;
    return this.screenOffset3(bp, screenPx);
  }

  annotationAt(bp: number, lane: number): Pos3 {
    const L = this.inputs.layout;
    const screenPx = L
      ? this.scaledOffset(L.annotationOffset - lane * L.annotationStep)
      : -14 - lane * 20;
    return this.screenOffset3(bp, screenPx);
  }

  rulerAt(bp: number): Pos3 {
    return this.screenOffset3(bp, this.scaledOffset(this.rulerOffset));
  }

  bpLeftX(bp: number): number {
    const pt = this.bbPoint(bp);
    const scr = this.toScreen(pt.x, pt.y);
    return scr.x - this.pixelsPerBp / 2;
  }

  bpCenterX(bp: number): number {
    const pt = this.bbPoint(bp);
    const scr = this.toScreen(pt.x, pt.y);
    return scr.x;
  }

  scaleStroke(baseWidth: number): number {
    const scale = Math.min(1, Math.max(0.3, this.pixelsPerBp / 5));
    return Math.max(0.5, baseWidth * scale);
  }

  scaleNormalOffset(baseOffsetPx: number): number {
    return this.scaledOffset(baseOffsetPx);
  }

  isNormalBandRenderable(offsetPx: number, halfHeightPx: number): boolean {
    const maxEdgeOffset =
      Math.abs(this.scaledOffset(offsetPx)) + Math.abs(this.scaledOffset(halfHeightPx));
    return this.inputs.dims.radius * this.inputs.zoom > maxEdgeOffset + 4;
  }

  readonly isArcMode = true;

  arcCircle(): { readonly center: Pos2; readonly radius: number } | null {
    const { dims, zoom } = this.inputs;
    if (dims.straightLength > 1e-6 || !(dims.radius > 0)) return null;
    return { center: this.toScreen(dims.radius, dims.radius), radius: dims.radius * zoom };
  }

  private featurePolygonSample(bp: number): FeaturePolygonSample {
    const pt = seqPosToPointNorm(
      bp,
      this.inputs.genomeLength,
      this.inputs.viewOffset,
      this.inputs.dims
    );
    const scr = this.toScreen(pt.x, pt.y);
    return {
      x: scr.x,
      y: scr.y,
      angle: pt.angle,
      nx: -Math.sin(pt.angle),
      ny: Math.cos(pt.angle),
    };
  }

  private angleDelta(a: number, b: number): number {
    let delta = b - a;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    return Math.abs(delta);
  }

  private pointSegmentDistance(
    p: FeaturePolygonSample,
    a: FeaturePolygonSample,
    b: FeaturePolygonSample
  ): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq <= 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
    return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
  }

  private clipSpanToVisibleWindow(
    startBp: number,
    featureLen: number
  ): { startBp: number; featureLen: number } | null {
    const windowLen = this.viewEndBp - this.viewStartBp;
    if (featureLen <= windowLen) return null;

    const genomeLen = this.inputs.genomeLength;
    if (
      !Number.isFinite(genomeLen) ||
      genomeLen <= 0 ||
      !Number.isFinite(featureLen) ||
      featureLen <= 0 ||
      !Number.isFinite(windowLen) ||
      windowLen <= 0 ||
      windowLen >= genomeLen
    ) {
      return null;
    }

    const winStart = this.viewStartBp;

    const rel = (((startBp - winStart) % genomeLen) + genomeLen) % genomeLen;

    const fwdLo = rel > 0 ? rel : 0;
    const fwdHi = Math.min(windowLen, rel + featureLen);
    const hasForward = fwdHi > fwdLo;

    const wrapRel = rel - genomeLen;
    const wrapLo = wrapRel > 0 ? wrapRel : 0;
    const wrapHi = Math.min(windowLen, wrapRel + featureLen);
    const hasWrapped = wrapHi > wrapLo;

    if (!hasForward && !hasWrapped) return null;

    if (hasForward && hasWrapped) {
      const gapLen = genomeLen - featureLen;
      if (gapLen <= 0) return { startBp: winStart, featureLen: windowLen };

      const gapRel = (((rel + featureLen) % genomeLen) + genomeLen) % genomeLen;
      const gapHitsWindow =
        Math.min(windowLen, gapRel + gapLen) > Math.max(0, gapRel) ||
        Math.min(windowLen, gapRel - genomeLen + gapLen) > Math.max(0, gapRel - genomeLen);
      if (gapHitsWindow) return null;

      return { startBp: winStart, featureLen: windowLen };
    }

    const lo = hasForward ? fwdLo : wrapLo;
    const hi = hasForward ? fwdHi : wrapHi;
    return { startBp: winStart + lo, featureLen: hi - lo };
  }

  private maxSegmentLengthPx(): number {
    if (this._maxSegmentLengthPx !== null) return this._maxSegmentLengthPx;
    const radiusPx = this.inputs.dims.radius * this.inputs.zoom;
    const eps = FEATURE_POLYGON_MAX_SCREEN_ERROR_PX;

    const sagittaCap =
      radiusPx > eps ? 2 * Math.sqrt(2 * eps * radiusPx - eps * eps) : Number.POSITIVE_INFINITY;
    const angleCap = radiusPx * FEATURE_POLYGON_MAX_ANGLE_STEP_RAD;
    this._maxSegmentLengthPx = Math.min(sagittaCap, angleCap);
    return this._maxSegmentLengthPx;
  }

  private maxSpanBpUnderBudget(): number {
    if (this._maxSpanBpUnderBudget !== null) return this._maxSpanBpUnderBudget;
    const maxSeg = this.maxSegmentLengthPx();
    const ppb = this.pixelsPerBp;
    this._maxSpanBpUnderBudget =
      Number.isFinite(maxSeg) && maxSeg > 0 && ppb > 0
        ? (maxSeg * FEATURE_POLYGON_MAX_SAMPLES) / ppb
        : Number.POSITIVE_INFINITY;
    return this._maxSpanBpUnderBudget;
  }

  private analyticSegmentCount(lenBp: number): number {
    const maxSeg = this.maxSegmentLengthPx();
    if (!Number.isFinite(maxSeg) || maxSeg <= 0) return 1;
    return Math.ceil((Math.abs(lenBp) * this.pixelsPerBp) / maxSeg);
  }

  private appendUniformlyCoarseSpan(
    samples: FeaturePolygonSample[],
    aBp: number,
    bBp: number,
    b: FeaturePolygonSample
  ): void {
    const remaining = FEATURE_POLYGON_MAX_SAMPLES - samples.length;
    if (remaining <= 1) {
      samples.push(b);
      return;
    }

    const steps = Math.max(1, Math.min(this.analyticSegmentCount(bBp - aBp), remaining));

    for (let i = 1; i < steps; i++) {
      samples.push(this.featurePolygonSample(aBp + ((bBp - aBp) * i) / steps));
    }
    samples.push(b);
  }

  private buildFeaturePolygonSamples(
    rawStartBp: number,
    rawFeatureLen: number
  ): FeaturePolygonSample[] {
    const clip = this.clipSpanToVisibleWindow(rawStartBp, rawFeatureLen);
    const startBp = clip === null ? rawStartBp : clip.startBp;
    const featureLen = clip === null ? rawFeatureLen : clip.featureLen;
    const samples: FeaturePolygonSample[] = [];
    const start = this.featurePolygonSample(startBp);
    const end = this.featurePolygonSample(startBp + featureLen);
    samples.push(start);

    if (featureLen > this.maxSpanBpUnderBudget()) {
      this.appendUniformlyCoarseSpan(samples, startBp, startBp + featureLen, end);
      return samples;
    }

    const appendSegment = (
      aBp: number,
      bBp: number,
      a: FeaturePolygonSample,
      b: FeaturePolygonSample,
      depth: number
    ) => {
      if (samples.length >= FEATURE_POLYGON_MAX_SAMPLES || depth >= FEATURE_POLYGON_MAX_DEPTH) {
        this.appendUniformlyCoarseSpan(samples, aBp, bBp, b);
        return;
      }

      const midBp = (aBp + bBp) / 2;
      const mid = this.featurePolygonSample(midBp);
      const screenError = this.pointSegmentDistance(mid, a, b);
      const angleDelta = this.angleDelta(a.angle, b.angle);
      const needsSplit =
        screenError > FEATURE_POLYGON_MAX_SCREEN_ERROR_PX ||
        angleDelta > FEATURE_POLYGON_MAX_ANGLE_STEP_RAD;

      if (needsSplit) {
        appendSegment(aBp, midBp, a, mid, depth + 1);
        appendSegment(midBp, bBp, mid, b, depth + 1);
      } else {
        samples.push(b);
      }
    };

    appendSegment(startBp, startBp + featureLen, start, end, 0);
    return samples;
  }

  featurePolygonAt(
    startBp: number,
    endBp: number,
    offsetPx: number,
    halfHeight?: number
  ): number[] {
    const last = this.lastFeaturePolygon;
    const sameSpan = last !== null && last.startBp === startBp && last.endBp === endBp;
    if (sameSpan && last.offsetPx === offsetPx && last.halfHeight === halfHeight) return last.pts;

    const featureLen =
      endBp > startBp ? endBp - startBp : this.inputs.genomeLength - startBp + endBp;
    const samples = sameSpan ? last.samples : this.buildFeaturePolygonSamples(startBp, featureLen);
    const pts = this.buildFeaturePolygon(samples, offsetPx, halfHeight);
    this.lastFeaturePolygon = { startBp, endBp, offsetPx, halfHeight, samples, pts };
    return pts;
  }

  private lastFeaturePolygon: {
    startBp: number;
    endBp: number;
    offsetPx: number;
    halfHeight: number | undefined;
    samples: FeaturePolygonSample[];
    pts: number[];
  } | null = null;

  private buildFeaturePolygon(
    samples: FeaturePolygonSample[],
    offsetPx: number,
    halfHeight?: number
  ): number[] {
    const scaledOffset = this.scaledOffset(offsetPx);
    const hh = this.scaledOffset(halfHeight ?? 8);

    const pts: number[] = [];
    for (const sample of samples) {
      pts.push(
        sample.x + sample.nx * (scaledOffset - hh),
        sample.y + sample.ny * (scaledOffset - hh)
      );
    }
    for (let i = samples.length - 1; i >= 0; i--) {
      const sample = samples[i];
      pts.push(
        sample.x + sample.nx * (scaledOffset + hh),
        sample.y + sample.ny * (scaledOffset + hh)
      );
    }
    return pts;
  }

  featureQuadAt(startBp: number, endBp: number, offsetPx: number, halfHeight?: number): number[] {
    const scaledOffset = this.scaledOffset(offsetPx);
    const hh = this.scaledOffset(halfHeight ?? 8);
    const genomeLen = this.inputs.genomeLength;

    const point = (bp: number, edgeOffset: number) => {
      const pt = seqPosToPointNorm(bp, genomeLen, this.inputs.viewOffset, this.inputs.dims);
      const scr = this.toScreen(pt.x, pt.y);
      const nx = -Math.sin(pt.angle);
      const ny = Math.cos(pt.angle);
      return {
        x: scr.x + nx * edgeOffset,
        y: scr.y + ny * edgeOffset,
      };
    };

    const startOuter = point(startBp, scaledOffset - hh);
    const endOuter = point(endBp, scaledOffset - hh);
    const endInner = point(endBp, scaledOffset + hh);
    const startInner = point(startBp, scaledOffset + hh);

    return [
      startOuter.x,
      startOuter.y,
      endOuter.x,
      endOuter.y,
      endInner.x,
      endInner.y,
      startInner.x,
      startInner.y,
    ];
  }

  nearestBpAt(screenX: number, screenY: number): number {
    const { stagePosX, stagePosY, zoom, ox, oy, dims, genomeLength, viewOffset } = this.inputs;
    const worldX = (screenX - stagePosX) / zoom - ox;
    const worldY = (screenY - stagePosY) / zoom - oy;
    return closestSeqPosOnBackbone(worldX, worldY, dims, 0, genomeLength, viewOffset);
  }

  featureLabelPosAt(bp: number, offsetPx: number): Pos3 {
    return this.screenOffset3(bp, this.scaledOffset(offsetPx));
  }

  isFeatureVisible(startBp: number, featureLenBp: number, offsetPx = 0, halfHeightPx = 0): boolean {
    const midBp = startBp + featureLenBp / 2;
    const pt = seqPosToPointNorm(
      midBp,
      this.inputs.genomeLength,
      this.inputs.viewOffset,
      this.inputs.dims
    );
    const scr = this.toScreen(pt.x, pt.y);
    const normalExtent =
      Math.abs(this.scaledOffset(offsetPx)) + Math.abs(this.scaledOffset(halfHeightPx));
    const halfExtent = (featureLenBp * this.pixelsPerBp) / 2 + normalExtent + 50;
    const vw = this.inputs.viewportWidth ?? 1440;
    const vh = this.inputs.viewportHeight ?? 900;
    return (
      scr.x > -halfExtent &&
      scr.x < vw + halfExtent &&
      scr.y > -halfExtent &&
      scr.y < vh + halfExtent
    );
  }

  cutLabelAt(bp: number): Pos2 {
    return this.screenOffset2(bp, this.scaledOffset(this.cutLabelOffset));
  }
}
