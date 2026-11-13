import type { ImmediateDrawHost } from './indexed-annotation-draw-host';
import type { Graphics, Text } from 'pixi.js';
import type { Feature, RenderState } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import type { CurvedLabelRenderer } from '../shared/curved-label';
import type { FeaturePrimitiveSink } from '../overview/feature-primitive-sink';
import type { HitRecord } from './hit-testing';
import type { OutlineCommand } from './annotation-feature-geometry';
import type { AnnotationDrawAuditDecision } from './annotation-draw-audit';
import { renderImmediateFeature as renderImmediateFeatureFn } from './indexed-annotation-draw-immediate';
import {
  drawCDSLabelStrip as drawCDSLabelStripFn,
  type CdsLabelStripDrawHost,
} from './indexed-annotation-draw-cds';
import {
  drawLanePillShell as drawLanePillShellFn,
  drawCdsDirectionGlyphInPill as drawCdsDirectionGlyphInPillFn,
  drawLabelTextInPill as drawLabelTextInPillFn,
  type PillDrawHost,
} from './indexed-annotation-draw-pills';
import {
  drawStandard as drawStandardFn,
  drawFeatureLevelTransitionShape as drawFeatureLevelTransitionShapeFn,
  type FeatureTransitionDrawHost,
  type StandardFeatureDrawHost,
} from './indexed-annotation-draw-standard';
import {
  drawRetainedTranscriptIntronConnectors as drawRetainedTranscriptIntronConnectorsFn,
  drawTranscriptGlyph as drawTranscriptGlyphFn,
  transcriptGlyphOutlineCommands as transcriptGlyphOutlineCommandsFn,
  type TranscriptGlyphDrawHost,
} from './indexed-annotation-draw-transcript';
import {
  addFeatureOutline,
  setFeatureOutline,
  strokeCurrentPath as strokeCurrentPathFn,
  strokeDraftOutlineCommands as strokeDraftOutlineCommandsFn,
  strokeOutlineCommands as strokeOutlineCommandsFn,
} from './indexed-annotation-draft-outlines';
import { drawLaneBandWithGaps as drawLaneBandWithGapsFn } from './indexed-annotation-draw-lane-band';
import {
  drawPillSeparator as drawPillSeparatorFn,
  pushPillHit as pushPillHitFn,
  renderCurvedLabel as renderCurvedLabelFn,
} from './indexed-annotation-draw-pills';
import {
  cdsTransitionHalfHeight as cdsTransitionHalfHeightFn,
  directionalArrowWidth as directionalArrowWidthFn,
} from './indexed-annotation-layout';
import { buildDirectionalPolygon } from './annotation-feature-geometry';
import {
  bestVisibleFeatureLabelPlacement,
  visibleCenterFromPolygon,
} from './annotation-label-geometry';
import { PILL_LABEL_PADDING } from '../shared/label-pill';
import { getThemedColor } from './annotation-feature-semantics';

import type { OverlayPresenterCollaborators } from './indexed-annotation-overlay-collaborators';

export type AnnotationImmediateDrawGlue = {
  graphics: Graphics;
  curvedLabels: CurvedLabelRenderer;
  hitCache: HitRecord[];
  genomeLength: number;
  genomeCircular: boolean;
  lastDrawnFeatureCount: number;
  lastImmediateDrawnLayerTypes: Set<string>;
  lastImmediateTranscriptDrawnCount: number;
  featureOffset(feature: Feature): number;

  hasLaneEnvelope(feature: Feature): boolean;
  scaledBarHeight(): number;
  cdsDetailProgress(): number;
  acquireLabel(): Text;
  directionalArrowWidth(pixelWidth: number, barHeight: number): number;
  cdsDirectionGlyph(feature: Feature): string | null;
  cdsExonLabelAlpha(): number;
  shouldRenderFeatureText(path: PathMapper): boolean;
  pillStartForTextCenter(
    path: PathMapper,
    centerBp: number,
    textCenterOffsetPx: number,
    offset: number
  ): number;
  scaledCdsLineHeight(): number;
  reservePillBounds(
    state: RenderState,
    path: PathMapper,
    startBp: number,
    widthPx: number,
    offset: number,
    halfHeight: number,
    record: { kind: string; featureId: number; text: string },
    force?: boolean
  ): boolean;
  drawLaneBandWithGaps(
    g: Graphics,
    path: PathMapper,
    startBp: number,
    endBp: number,
    offset: number,
    halfHeight: number,
    color: number,
    alpha: number,
    gaps: Array<{ startBp: number; endBp: number }>
  ): void;
  strokeOutlineCommands(
    g: Graphics,
    path: PathMapper,
    commands: OutlineCommand[],
    color: number,
    alpha: number
  ): void;
  strokeDraftOutlineCommands(
    g: Graphics,
    path: PathMapper,
    commands: OutlineCommand[],
    color: number,
    alpha: number
  ): void;
  cdsLabelStripOutlineCommand(
    path: PathMapper,
    pillStartBp: number,
    combinedW: number,
    connectorEndBp: number,
    offset: number,
    barHalfH: number,
    connectorHalfH: number
  ): OutlineCommand[];
  drawPillSeparator(
    g: Graphics,
    path: PathMapper,
    startBp: number,
    offsetPx: number,
    offset: number,
    barH: number,
    alpha: number
  ): void;
  pushPillHit(
    feature: Feature,
    startBp: number,
    width: number,
    offset: number,
    halfH: number,
    rangeStart: number,
    rangeEnd: number,
    path: PathMapper
  ): void;
  lanePillOutlineCommand(
    path: PathMapper,
    startBp: number,
    widthPx: number,
    offset: number,
    halfH: number
  ): OutlineCommand[];
  strokeLanePill(
    g: Graphics,
    path: PathMapper,
    startBp: number,
    widthPx: number,
    offset: number,
    halfH: number,
    color: number,
    alpha: number
  ): void;
  overviewLabelAlpha(): number;
  standardFeatureDrawPoints(
    feature: Feature,
    endBp: number,
    pixelWidth: number,
    path: PathMapper,
    hitPts: number[],
    halfHeight?: number
  ): number[];
  renderCurvedLabel(
    labelText: string,
    centerBp: number,
    textWidth: number,
    feature: Feature,
    endBp: number,
    color: number,
    offset: number,
    path: PathMapper,
    alpha: number,
    rangeStartBp: number,
    rangeEndBp: number,
    textColor?: number
  ): void;
  featureLevelLabelCenterBp(
    feature: Feature,
    featureLen: number,
    hitPts: number[],
    state: RenderState
  ): number;
  cdsTransitionHalfHeight(detailProgress: number): number;
  strokeCurrentPath(g: Graphics, path: PathMapper, color: number, alpha: number): void;
  transcriptViewportBounds(path: PathMapper): { visLo: number; visHi: number };
  transcriptIntronGapRanges(
    feature: Feature,
    path: PathMapper
  ): Array<{ startBp: number; endBp: number }>;
  transcriptIntronLineOutlineCommands(
    feature: Feature,
    path: PathMapper,
    offset: number
  ): OutlineCommand[];
};

function idleImmediateDrawGlue(): AnnotationImmediateDrawGlue {
  const graphics = { clear() {} } as Graphics;
  return {
    graphics,
    curvedLabels: { destroy() {}, reset() {} } as unknown as CurvedLabelRenderer,
    hitCache: [],
    genomeLength: 0,
    genomeCircular: false,
    lastDrawnFeatureCount: 0,
    lastImmediateDrawnLayerTypes: new Set(),
    lastImmediateTranscriptDrawnCount: 0,
    featureOffset: () => 0,
    hasLaneEnvelope: () => false,
    scaledBarHeight: () => 0,
    cdsDetailProgress: () => 0,
    acquireLabel: () => ({}) as Text,
    directionalArrowWidth: () => 0,
    cdsDirectionGlyph: () => null,
    cdsExonLabelAlpha: () => 1,
    shouldRenderFeatureText: () => false,
    pillStartForTextCenter: () => 0,
    scaledCdsLineHeight: () => 0,
    reservePillBounds: () => false,
    drawLaneBandWithGaps() {},
    strokeOutlineCommands() {},
    strokeDraftOutlineCommands() {},
    cdsLabelStripOutlineCommand: () => [],
    drawPillSeparator() {},
    pushPillHit() {},
    lanePillOutlineCommand: () => [],
    strokeLanePill() {},
    overviewLabelAlpha: () => 1,
    standardFeatureDrawPoints: () => [],
    renderCurvedLabel() {},
    featureLevelLabelCenterBp: () => 0,
    cdsTransitionHalfHeight: () => 0,
    strokeCurrentPath() {},
    transcriptViewportBounds: () => ({ visLo: 0, visHi: 0 }),
    transcriptIntronGapRanges: () => [],
    transcriptIntronLineOutlineCommands: () => [],
  };
}

export class AnnotationImmediateDrawController
  implements
    ImmediateDrawHost,
    CdsLabelStripDrawHost,
    PillDrawHost,
    StandardFeatureDrawHost,
    TranscriptGlyphDrawHost,
    FeatureTransitionDrawHost
{
  outlineCache = new Map<number, OutlineCommand[]>();
  labelCache = new Map<number, { text: string; width: number }>();

  private glue: AnnotationImmediateDrawGlue = idleImmediateDrawGlue();

  constructor() {}
  attach(collaborators: OverlayPresenterCollaborators): void {
    this.glue = {
      get graphics() {
        return collaborators.retained.graphics;
      },
      get curvedLabels() {
        return collaborators.retained.curvedLabels;
      },
      get hitCache() {
        return collaborators.hits.hitCache;
      },
      get genomeLength() {
        return collaborators.layout.genomeLength;
      },
      get genomeCircular() {
        return collaborators.layout.genomeCircular;
      },
      get lastDrawnFeatureCount() {
        return collaborators.retained.lastDrawnFeatureCount;
      },
      set lastDrawnFeatureCount(value) {
        collaborators.retained.lastDrawnFeatureCount = value;
      },
      get lastImmediateDrawnLayerTypes() {
        return collaborators.retained.lastImmediateDrawnLayerTypes;
      },
      get lastImmediateTranscriptDrawnCount() {
        return collaborators.retained.lastImmediateTranscriptDrawnCount;
      },
      set lastImmediateTranscriptDrawnCount(value) {
        collaborators.retained.lastImmediateTranscriptDrawnCount = value;
      },
      featureOffset: (feature) => collaborators.layout.featureOffset(feature),

      hasLaneEnvelope: (feature) =>
        !collaborators.layout._layout || collaborators.layout.featureEnvelope(feature) !== null,
      scaledBarHeight: () => collaborators.layout.scaledBarHeight(),
      cdsDetailProgress: () => collaborators.layout.cdsDetailProgress(),
      acquireLabel: () => collaborators.retained.acquireLabel(),
      directionalArrowWidth: (pixelWidth, barHeight) =>
        collaborators.immediateDraw.directionalArrowWidth(pixelWidth, barHeight),
      cdsDirectionGlyph: (feature) => collaborators.immediateDraw.cdsDirectionGlyph(feature),
      cdsExonLabelAlpha: () => collaborators.layout.cdsExonLabelAlpha(),
      shouldRenderFeatureText: (path) => collaborators.layout.shouldRenderFeatureText(path),
      pillStartForTextCenter: (path, centerBp, textCenterOffsetPx, offset) =>
        collaborators.layout.pillStartForTextCenter(path, centerBp, textCenterOffsetPx, offset),
      scaledCdsLineHeight: () => collaborators.layout.scaledCdsLineHeight(),
      reservePillBounds: (state, path, startBp, widthPx, offset, halfHeight, record, force) =>
        collaborators.retained.reservePillBounds(
          state,
          path,
          startBp,
          widthPx,
          offset,
          halfHeight,
          record,
          force
        ),
      drawLaneBandWithGaps: (g, path, startBp, endBp, offset, halfHeight, color, alpha, gaps) =>
        collaborators.immediateDraw.drawLaneBandWithGaps(
          g,
          path,
          startBp,
          endBp,
          offset,
          halfHeight,
          color,
          alpha,
          gaps
        ),
      strokeOutlineCommands: (g, path, commands, color, alpha) =>
        collaborators.immediateDraw.strokeOutlineCommands(g, path, commands, color, alpha),
      strokeDraftOutlineCommands: (g, path, commands, color, alpha) =>
        collaborators.immediateDraw.strokeDraftOutlineCommands(g, path, commands, color, alpha),
      cdsLabelStripOutlineCommand: (
        path,
        pillStartBp,
        combinedW,
        connectorEndBp,
        offset,
        barHalfH,
        connectorHalfH
      ) =>
        collaborators.layout.cdsLabelStripOutlineCommand(
          path,
          pillStartBp,
          combinedW,
          connectorEndBp,
          offset,
          barHalfH,
          connectorHalfH
        ),
      drawPillSeparator: (g, path, startBp, offsetPx, offset, barH, alpha) =>
        collaborators.immediateDraw.drawPillSeparator(
          g,
          path,
          startBp,
          offsetPx,
          offset,
          barH,
          alpha
        ),
      pushPillHit: (feature, startBp, width, offset, halfH, rangeStart, rangeEnd, path) =>
        collaborators.immediateDraw.pushPillHit(
          feature,
          startBp,
          width,
          offset,
          halfH,
          rangeStart,
          rangeEnd,
          path
        ),
      lanePillOutlineCommand: (path, startBp, widthPx, offset, halfH) =>
        collaborators.layout.lanePillOutlineCommand(path, startBp, widthPx, offset, halfH),
      strokeLanePill: (g, path, startBp, widthPx, offset, halfH, color, alpha) =>
        collaborators.layout.strokeLanePill(g, path, startBp, widthPx, offset, halfH, color, alpha),
      overviewLabelAlpha: () => collaborators.layout.overviewLabelAlpha(),
      standardFeatureDrawPoints: (feature, endBp, pixelWidth, path, hitPts, halfHeight) =>
        collaborators.immediateDraw.standardFeatureDrawPoints(
          feature,
          endBp,
          pixelWidth,
          path,
          hitPts,
          halfHeight
        ),
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
        collaborators.immediateDraw.renderCurvedLabel(
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
      featureLevelLabelCenterBp: (feature, featureLen, hitPts, state) =>
        collaborators.immediateDraw.featureLevelLabelCenterBp(feature, featureLen, hitPts, state),
      cdsTransitionHalfHeight: (detailProgress) =>
        collaborators.immediateDraw.cdsTransitionHalfHeight(detailProgress),
      strokeCurrentPath: (g, path, color, alpha) =>
        collaborators.immediateDraw.strokeCurrentPath(g, path, color, alpha),
      transcriptViewportBounds: (path) =>
        collaborators.immediateDraw.transcriptViewportBounds(path),
      transcriptIntronGapRanges: (feature, path) =>
        collaborators.immediateDraw.transcriptIntronGapRanges(feature, path),
      transcriptIntronLineOutlineCommands: (feature, path, offset) =>
        collaborators.immediateDraw.transcriptIntronLineOutlineCommands(feature, path, offset),
    } as AnnotationImmediateDrawGlue;
  }

  get graphics() {
    return this.glue.graphics;
  }
  get curvedLabels() {
    return this.glue.curvedLabels;
  }
  get hitCache() {
    return this.glue.hitCache;
  }
  get genomeLength() {
    return this.glue.genomeLength;
  }
  get genomeCircular() {
    return this.glue.genomeCircular;
  }
  get lastDrawnFeatureCount() {
    return this.glue.lastDrawnFeatureCount;
  }
  set lastDrawnFeatureCount(value) {
    this.glue.lastDrawnFeatureCount = value;
  }
  get lastImmediateDrawnLayerTypes() {
    return this.glue.lastImmediateDrawnLayerTypes;
  }
  get lastImmediateTranscriptDrawnCount() {
    return this.glue.lastImmediateTranscriptDrawnCount;
  }
  set lastImmediateTranscriptDrawnCount(value) {
    this.glue.lastImmediateTranscriptDrawnCount = value;
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
  acquireLabel(): Text {
    return this.glue.acquireLabel();
  }
  directionalArrowWidth(pixelWidth: number, barHeight: number): number {
    return directionalArrowWidthFn(pixelWidth, barHeight);
  }
  cdsDirectionGlyph(feature: Feature): string | null {
    if (feature.direction === 'forward') return '»';
    if (feature.direction === 'reverse') return '«';
    return null;
  }
  cdsExonLabelAlpha(): number {
    return this.glue.cdsExonLabelAlpha();
  }
  shouldRenderFeatureText(path: PathMapper): boolean {
    return this.glue.shouldRenderFeatureText(path);
  }
  pillStartForTextCenter(
    path: PathMapper,
    centerBp: number,
    textCenterOffsetPx: number,
    offset: number
  ): number {
    return this.glue.pillStartForTextCenter(path, centerBp, textCenterOffsetPx, offset);
  }
  scaledCdsLineHeight(): number {
    return this.glue.scaledCdsLineHeight();
  }
  reservePillBounds(
    state: RenderState,
    path: PathMapper,
    startBp: number,
    widthPx: number,
    offset: number,
    halfHeight: number,
    record: { kind: string; featureId: number; text: string },
    force?: boolean
  ): boolean {
    return this.glue.reservePillBounds(
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
  drawLaneBandWithGaps(
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
    drawLaneBandWithGapsFn(this, g, path, startBp, endBp, offset, halfHeight, color, alpha, gaps);
  }
  setFeatureOutline(featureId: number, commands: OutlineCommand[]): void {
    setFeatureOutline(this.outlineCache, featureId, commands);
  }
  addFeatureOutline(featureId: number, command: OutlineCommand): void {
    addFeatureOutline(this.outlineCache, featureId, command);
  }
  strokeOutlineCommands(
    g: Graphics,
    path: PathMapper,
    commands: OutlineCommand[],
    color: number,
    alpha: number
  ): void {
    strokeOutlineCommandsFn(g, path, commands, color, alpha);
  }
  strokeDraftOutlineCommands(
    g: Graphics,
    path: PathMapper,
    commands: OutlineCommand[],
    color: number,
    alpha: number
  ): void {
    strokeDraftOutlineCommandsFn(g, path, commands, color, alpha);
  }
  cdsLabelStripOutlineCommand(
    path: PathMapper,
    pillStartBp: number,
    combinedW: number,
    connectorEndBp: number,
    offset: number,
    barHalfH: number,
    connectorHalfH: number
  ): OutlineCommand[] {
    return this.glue.cdsLabelStripOutlineCommand(
      path,
      pillStartBp,
      combinedW,
      connectorEndBp,
      offset,
      barHalfH,
      connectorHalfH
    );
  }
  drawPillSeparator(
    g: Graphics,
    path: PathMapper,
    startBp: number,
    offsetPx: number,
    offset: number,
    barH: number,
    alpha: number
  ): void {
    drawPillSeparatorFn(g, path, startBp, offsetPx, offset, barH, alpha);
  }
  pushPillHit(
    feature: Feature,
    startBp: number,
    width: number,
    offset: number,
    halfH: number,
    rangeStart: number,
    rangeEnd: number,
    path: PathMapper
  ): void {
    pushPillHitFn(
      { genomeLength: this.genomeLength, hitCache: this.hitCache },
      feature,
      startBp,
      width,
      offset,
      halfH,
      rangeStart,
      rangeEnd,
      path
    );
  }
  lanePillOutlineCommand(
    path: PathMapper,
    startBp: number,
    widthPx: number,
    offset: number,
    halfH: number
  ): OutlineCommand[] {
    return this.glue.lanePillOutlineCommand(path, startBp, widthPx, offset, halfH);
  }
  strokeLanePill(
    g: Graphics,
    path: PathMapper,
    startBp: number,
    widthPx: number,
    offset: number,
    halfH: number,
    color: number,
    alpha: number
  ): void {
    this.glue.strokeLanePill(g, path, startBp, widthPx, offset, halfH, color, alpha);
  }
  overviewLabelAlpha(): number {
    return this.glue.overviewLabelAlpha();
  }
  standardFeatureDrawPoints(
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
  renderCurvedLabel(
    labelText: string,
    centerBp: number,
    textWidth: number,
    feature: Feature,
    endBp: number,
    color: number,
    offset: number,
    path: PathMapper,
    alpha: number,
    rangeStartBp: number,
    rangeEndBp: number,
    textColor?: number
  ): void {
    renderCurvedLabelFn(
      this,
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
  featureLevelLabelCenterBp(
    feature: Feature,
    featureLen: number,
    hitPts: number[],
    state: RenderState
  ): number {
    const { fraction } = visibleCenterFromPolygon(hitPts, state.width, state.height);
    return feature.start + featureLen * fraction;
  }
  cdsTransitionHalfHeight(detailProgress: number): number {
    return cdsTransitionHalfHeightFn(detailProgress);
  }
  strokeCurrentPath(g: Graphics, path: PathMapper, color: number, alpha: number): void {
    strokeCurrentPathFn(g, path, color, alpha);
  }
  transcriptViewportBounds(path: PathMapper): { visLo: number; visHi: number } {
    const visStart = path.viewStartBp;
    const visEnd = path.viewEndBp;
    const visMargin = Math.max(1, visEnd - visStart);
    return {
      visLo: visStart - visMargin,
      visHi: visEnd + visMargin,
    };
  }
  transcriptIntronGapRanges(
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
  transcriptIntronLineOutlineCommands(
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
  transcriptGlyphOutlineCommands(feature: Feature, path: PathMapper): OutlineCommand[] {
    return transcriptGlyphOutlineCommandsFn(this, feature, path);
  }

  drawRetainedTranscriptIntronConnectors(
    g: Graphics,
    feature: Feature,
    path: PathMapper,
    state: RenderState,
    alpha: number,
    clipRange?: { lo: number; hi: number }
  ): void {
    drawRetainedTranscriptIntronConnectorsFn(this, g, feature, path, state, alpha, clipRange);
  }

  drawLanePillShell(
    g: Graphics,
    path: PathMapper,
    startBp: number,
    widthPx: number,
    offset: number,
    pillHalfHeight: number,
    cutoutHalfHeight: number,
    color: number,
    alpha: number
  ): void {
    drawLanePillShellFn(
      this,
      g,
      path,
      startBp,
      widthPx,
      offset,
      pillHalfHeight,
      cutoutHalfHeight,
      color,
      alpha
    );
  }
  drawCdsDirectionGlyphInPill(
    feature: Feature,
    glyph: string,
    startBp: number,
    visibleNameBlockW: number,
    glyphWidth: number,
    offset: number,
    color: number,
    path: PathMapper,
    alpha: number,
    labelTextColor: number | undefined
  ): void {
    drawCdsDirectionGlyphInPillFn(
      this,
      feature,
      glyph,
      startBp,
      visibleNameBlockW,
      glyphWidth,
      offset,
      color,
      path,
      alpha,
      labelTextColor
    );
  }
  drawLabelTextInPill(
    feature: Feature,
    text: string,
    startBp: number,
    width: number,
    offset: number,
    color: number,
    path: PathMapper,
    maxTextW: number,
    alpha: number,
    a: null,
    b: null,
    c: null,
    labelTextColor: number | undefined
  ): void {
    drawLabelTextInPillFn(
      this,
      feature,
      text,
      startBp,
      width,
      offset,
      color,
      path,
      maxTextW,
      alpha,
      a,
      b,
      c,
      labelTextColor
    );
  }

  renderResidentFeatureLabels(
    features: readonly Feature[],
    path: PathMapper,
    state: RenderState
  ): void {
    if (!this.shouldRenderFeatureText(path)) return;
    const alpha = this.glue.overviewLabelAlpha();
    if (alpha <= 0.01) return;

    for (const feature of features) {
      const text = feature.displayName?.trim();
      if (!text) continue;

      if (!this.glue.hasLaneEnvelope(feature)) continue;
      const offset = this.featureOffset(feature);
      const placement = bestVisibleFeatureLabelPlacement(
        feature,
        path,
        state.width,
        state.height,
        offset,
        this.genomeLength
      );
      if (!placement || placement.widthPx <= 30) continue;
      const maxTextWidth = placement.widthPx - PILL_LABEL_PADDING * 2;
      if (maxTextWidth <= 0) continue;
      if (
        !this.reservePillBounds(
          state,
          path,
          placement.startBp,
          placement.widthPx,
          offset,
          this.scaledBarHeight() / 2,
          { kind: 'resident-annotation-label', featureId: feature.id, text }
        )
      ) {
        continue;
      }
      this.drawLabelTextInPill(
        feature,
        text,
        placement.startBp,
        placement.widthPx,
        offset,
        state.sequencePresentation?.annotationColors?.get(feature.id) ??
          getThemedColor(feature, state.themeMode),
        path,
        maxTextWidth,
        alpha,
        null,
        null,
        null,
        undefined
      );
    }
  }

  renderImmediateFeature(
    sink: FeaturePrimitiveSink,
    feature: Feature,
    path: PathMapper,
    state: RenderState,
    useOverviewAggregation: boolean,
    forceTinyFeatureShapes = false,
    alphaScale = 1
  ): AnnotationDrawAuditDecision {
    return renderImmediateFeatureFn(
      this,
      sink,
      feature,
      path,
      state,
      useOverviewAggregation,
      forceTinyFeatureShapes,
      alphaScale
    );
  }
  drawStandard(
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
    renderLabel?: boolean,
    labelAlphaScale?: number
  ): void {
    drawStandardFn(
      this,
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
  drawTranscriptGlyph(
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
    labelAlphaScale: number
  ): void {
    drawTranscriptGlyphFn(
      this,
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
      labelAlphaScale
    );
  }
  drawCDSLabelStrip(
    g: Graphics,
    feature: Feature,
    endBp: number,
    featureLen: number,
    color: number,
    alpha: number,
    path: PathMapper,
    state: RenderState,
    labelAlpha?: number,
    transitionFromCenterBp?: number | null,
    drawConnector?: boolean,
    centerCutoutHalfHeight?: number | null
  ): void {
    drawCDSLabelStripFn(
      this,
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
  drawFeatureLevelTransitionShape(
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
      this,
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
}

declare module './indexed-annotation-overlay-collaborators' {
  interface OverlayImmediateDrawCollaborator extends AnnotationImmediateDrawController {}
}
