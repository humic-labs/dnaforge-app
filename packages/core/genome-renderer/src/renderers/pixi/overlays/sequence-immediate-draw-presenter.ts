import { TRANSCRIPT_INTRON_STYLE, cdsConnectorCenterOffset } from '@waypoint/platform';
import { Graphics, Text } from 'pixi.js';
import type { Feature, RenderState } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import type { CurvedLabelRenderer } from '../shared/curved-label';
import {
  PILL_LABEL_FONT_SIZE,
  PILL_LABEL_PADDING,
  drawLanePillLabelText,
  measurePillLabelTextWidth,
  pillLabelTextStyle,
  targetPillLabelTextResolution,
} from '../shared/label-pill';
import {
  advanceBpByScreenWidth,
  clampedLanePillPlacement,
  drawLaneBand,
  drawLanePill,
  isLaneRangeVisibleInViewport,
  laneRoundedPillShellPolygons,
  normalizeBp,
  rangeLength,
  screenWidthToBp,
} from '../shared/lane-path';
import { reserveLabelBounds, type LabelOccupancyRecord } from '../shared/label-occupancy';
import {
  isNonCodingTranscriptType,
  rnaAccentColorForMode,
  transcriptColorForMode,
} from '../../../feature-colors';
import { computeBBox, type HitRecord } from './hit-testing';
import {
  cdsLabelStripOutlineCommand as annotationCdsLabelStripOutlineCommand,
  lanePillOutlineCommand as annotationLanePillOutlineCommand,
  screenDistanceFromFeatureStart,
  buildDirectionalPolygon,
  type OutlineCommand,
} from './annotation-feature-geometry';
import { isOutlineOnlyFeature } from './annotation-feature-semantics';
import { drawCDSLabelStrip as drawCDSLabelStripFn } from './indexed-annotation-draw-cds';
import { bestVisiblePolygonLabelCandidate, truncateForWidth } from './annotation-label-geometry';
import { shouldRenderFeatureTextAtLod } from './feature-text-lod';
import type { FeaturePrimitiveSink } from '../overview/feature-primitive-sink';

const LABEL_PADDING = PILL_LABEL_PADDING;
const DIRECTION_GLYPH_FONT_SIZE = PILL_LABEL_FONT_SIZE;
const MIN_BAR_FOR_LABEL = 30;

export type SequenceImmediateDrawGlue = {
  featureBodyColor?: (feature: Feature) => number | undefined;
  graphics: () => Graphics;
  curvedLabels: () => CurvedLabelRenderer;
  hitCache: () => HitRecord[];
  genomeLength: () => number;
  genomeCircular: () => boolean;
  featureOffset: (feature: Feature) => number;
  scaledBarHeight: () => number;
  scaledCdsLineHeight: () => number;
  directionalArrowWidth: (pixelWidth: number, barHeight: number) => number;
  cdsDetailProgress: () => number;
  cdsExonLabelAlpha: () => number;
  overviewLabelAlpha: () => number;
  acquireLabel: () => Text;
  strokeOutlineCommands: (
    g: Graphics,
    path: PathMapper,
    commands: OutlineCommand[],
    color: number,
    alpha: number
  ) => void;
  strokeLanePill: (
    g: Graphics,
    path: PathMapper,
    startBp: number,
    widthPx: number,
    offset: number,
    halfHeight: number,
    color: number,
    alpha: number
  ) => void;
  transcriptViewportBounds: (path: PathMapper) => { visLo: number; visHi: number };
  transcriptIntronGapRanges: (
    feature: Feature,
    path: PathMapper
  ) => Array<{ startBp: number; endBp: number }>;
  transcriptIntronLineOutlineCommands: (
    feature: Feature,
    path: PathMapper,
    offset: number
  ) => OutlineCommand[];
  renderCurvedLabel: (
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
  ) => void;
  drawTranscriptIntronChevrons: (
    g: Graphics,
    feature: Feature,
    path: PathMapper,
    state: RenderState,
    alpha: number,
    clipRange?: { lo: number; hi: number }
  ) => void;
};

export class SequenceImmediateDrawPresenter {
  outlineCache = new Map<number, OutlineCommand[]>();
  labelCache = new Map<number, { text: string; width: number }>();
  labelOccupancyCache: LabelOccupancyRecord[] = [];
  lastDrawnFeatureCount = 0;
  lastImmediateTranscriptDrawnCount = 0;
  readonly lastImmediateDrawnLayerTypes = new Set<string>();

  constructor(private readonly glue: SequenceImmediateDrawGlue | null = null) {}

  private requiredGlue(): SequenceImmediateDrawGlue {
    if (!this.glue) {
      throw new Error('SequenceImmediateDrawPresenter requires overlay glue');
    }
    return this.glue;
  }

  get graphics(): Graphics {
    return this.requiredGlue().graphics();
  }
  get curvedLabels(): CurvedLabelRenderer {
    return this.requiredGlue().curvedLabels();
  }
  get hitCache(): HitRecord[] {
    return this.requiredGlue().hitCache();
  }
  get genomeLength(): number {
    return this.requiredGlue().genomeLength();
  }
  get genomeCircular(): boolean {
    return this.requiredGlue().genomeCircular();
  }

  featureOffset(feature: Feature): number {
    return this.requiredGlue().featureOffset(feature);
  }
  scaledBarHeight(): number {
    return this.requiredGlue().scaledBarHeight();
  }
  scaledCdsLineHeight(): number {
    return this.requiredGlue().scaledCdsLineHeight();
  }
  directionalArrowWidth(pixelWidth: number, barHeight: number): number {
    return this.requiredGlue().directionalArrowWidth(pixelWidth, barHeight);
  }
  cdsDetailProgress(): number {
    return this.requiredGlue().cdsDetailProgress();
  }
  cdsExonLabelAlpha(): number {
    return this.requiredGlue().cdsExonLabelAlpha();
  }
  overviewLabelAlpha(): number {
    return this.requiredGlue().overviewLabelAlpha();
  }
  acquireLabel(): Text {
    return this.requiredGlue().acquireLabel();
  }
  strokeOutlineCommands(
    g: Graphics,
    path: PathMapper,
    commands: OutlineCommand[],
    color: number,
    alpha: number
  ): void {
    this.requiredGlue().strokeOutlineCommands(g, path, commands, color, alpha);
  }
  strokeLanePill(
    g: Graphics,
    path: PathMapper,
    startBp: number,
    widthPx: number,
    offset: number,
    halfHeight: number,
    color: number,
    alpha: number
  ): void {
    this.requiredGlue().strokeLanePill(g, path, startBp, widthPx, offset, halfHeight, color, alpha);
  }
  transcriptViewportBounds(path: PathMapper): { visLo: number; visHi: number } {
    return this.requiredGlue().transcriptViewportBounds(path);
  }
  transcriptIntronGapRanges(
    feature: Feature,
    path: PathMapper
  ): Array<{ startBp: number; endBp: number }> {
    return this.requiredGlue().transcriptIntronGapRanges(feature, path);
  }
  transcriptIntronLineOutlineCommands(
    feature: Feature,
    path: PathMapper,
    offset: number
  ): OutlineCommand[] {
    return this.requiredGlue().transcriptIntronLineOutlineCommands(feature, path, offset);
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
    this.requiredGlue().renderCurvedLabel(
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
  drawTranscriptIntronChevrons(
    g: Graphics,
    feature: Feature,
    path: PathMapper,
    state: RenderState,
    alpha: number,
    clipRange?: { lo: number; hi: number }
  ): void {
    this.requiredGlue().drawTranscriptIntronChevrons(g, feature, path, state, alpha, clipRange);
  }

  cdsLabelStripOutlineCommand(
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
      this.genomeLength,
      cdsConnectorCenterOffset(pillHalfHeight, connectorHalfHeight)
    );
  }

  lanePillOutlineCommand(
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

  resetImmediateDrawStats(): void {
    this.lastDrawnFeatureCount = 0;
    this.lastImmediateTranscriptDrawnCount = 0;
    this.lastImmediateDrawnLayerTypes.clear();
  }

  setFeatureOutline(featureId: number, commands: OutlineCommand[]): void {
    this.outlineCache.set(
      featureId,
      commands.filter((command) => {
        if (command.kind === 'poly') return command.pts.length >= 6;
        if (command.kind === 'polyline') return command.pts.length >= 4;
        return true;
      })
    );
  }

  addFeatureOutline(featureId: number, command: OutlineCommand): void {
    const existing = this.outlineCache.get(featureId);
    if (existing) {
      existing.push(command);
    } else {
      this.outlineCache.set(featureId, [command]);
    }
  }

  shouldRenderFeatureText(path: PathMapper): boolean {
    return shouldRenderFeatureTextAtLod({
      sequenceVisible: path.sequenceVisible,
      genomeLength: this.genomeLength,
      pixelsPerBp: path.pixelsPerBp,
      isArcMode: path.isArcMode,
    });
  }

  pillStartForTextCenter(
    path: PathMapper,
    centerBp: number,
    textCenterOffsetPx: number,
    offset: number
  ): number {
    const offsetBp = screenWidthToBp(path, centerBp, textCenterOffsetPx, offset);
    const startBp = centerBp - offsetBp;
    return this.genomeCircular ? normalizeBp(startBp, this.genomeLength) : startBp;
  }

  cdsChevronStartBp(path: PathMapper, startBp: number): number {
    return path.isArcMode ? startBp - 0.5 : startBp;
  }

  cdsChevronEndBp(path: PathMapper, endBp: number): number {
    return path.isArcMode ? endBp - 0.5 : endBp;
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
    labelAlpha = 1,
    transitionFromCenterBp: number | null = null,
    drawConnector = true,
    centerCutoutHalfHeight: number | null = null
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

  computeSplicedExonLabels(
    feature: Feature,
    path: PathMapper,
    state: RenderState,
    offset: number,
    nameBlockW: number,
    namePillStartBp: number
  ): {
    appended: Array<{
      label: string;
      outerWidth: number;
      textBlockWidth: number;
      separatorBefore: number;
      separatorWidth: number;
      separatorAfter: number;
      rangeStart: number;
      rangeEnd: number;
    }>;
    floating: Array<{
      label: string;
      widthPx: number;
      startBp: number;
      rangeStart: number;
      rangeEnd: number;
    }>;
  } {
    const segments = feature.segments ?? [];
    const isReverse = feature.direction === 'reverse';
    const totalExons = segments.length;
    const sepWidth = 1;
    const sepGap = 3;
    const appended: Array<{
      label: string;
      outerWidth: number;
      textBlockWidth: number;
      separatorBefore: number;
      separatorWidth: number;
      separatorAfter: number;
      rangeStart: number;
      rangeEnd: number;
    }> = [];
    const floating: Array<{
      label: string;
      widthPx: number;
      startBp: number;
      rangeStart: number;
      rangeEnd: number;
    }> = [];

    const candidates: Array<{
      label: string;
      textBlockWidth: number;
      requestedWidthPx: number;
      startBp: number;
      endExclusiveBp: number;
      distanceFromFeatureStartPx: number;
      rangeStart: number;
      rangeEnd: number;
    }> = [];

    for (let si = 0; si < totalExons; si++) {
      const segment = segments[si];
      const startBp = segment.start - 1;
      const exonNum = isReverse ? totalExons - si : si + 1;
      const exonBp =
        segment.end >= segment.start
          ? segment.end - segment.start + 1
          : this.genomeLength - segment.start + 1 + segment.end;
      const label = `exon ${exonNum} (${exonBp} bp)`;
      const textBlockWidth = measurePillLabelTextWidth(label) + LABEL_PADDING;
      const requestedWidthPx = textBlockWidth + LABEL_PADDING;
      const exonEndExclusive = segment.end;
      if (
        !isLaneRangeVisibleInViewport(
          path,
          state.width,
          state.height,
          startBp,
          exonEndExclusive,
          offset,
          this.genomeLength
        )
      ) {
        continue;
      }
      const distanceFromFeatureStartPx = screenDistanceFromFeatureStart(
        feature.start,
        startBp,
        this.genomeLength,
        path.pixelsPerBp
      );

      candidates.push({
        label,
        textBlockWidth,
        requestedWidthPx,
        startBp,
        endExclusiveBp: exonEndExclusive,
        distanceFromFeatureStartPx,
        rangeStart: startBp,
        rangeEnd: segment.end - 1,
      });
    }

    candidates.sort((a, b) => a.distanceFromFeatureStartPx - b.distanceFromFeatureStartPx);

    const namePillDistancePx = screenDistanceFromFeatureStart(
      feature.start,
      namePillStartBp,
      this.genomeLength,
      path.pixelsPerBp
    );
    for (const candidate of candidates) {
      if (candidate.distanceFromFeatureStartPx <= namePillDistancePx + nameBlockW + 10) {
        const outerWidth = sepGap + sepWidth + sepGap + candidate.textBlockWidth;
        appended.push({
          label: candidate.label,
          outerWidth,
          textBlockWidth: candidate.textBlockWidth,
          separatorBefore: sepGap,
          separatorWidth: sepWidth,
          separatorAfter: sepGap,
          rangeStart: candidate.rangeStart,
          rangeEnd: candidate.rangeEnd,
        });
      } else {
        const floatingPlacement = clampedLanePillPlacement(
          path,
          state.width,
          state.height,
          candidate.startBp,
          candidate.endExclusiveBp,
          candidate.requestedWidthPx,
          offset,
          this.genomeLength,
          candidate.startBp
        );
        if (floatingPlacement.widthPx <= 0) continue;
        floating.push({
          label: candidate.label,
          widthPx: floatingPlacement.widthPx,
          startBp: floatingPlacement.startBp,
          rangeStart: candidate.rangeStart,
          rangeEnd: candidate.rangeEnd,
        });
      }
    }

    return { appended, floating };
  }
  drawLanePillShell(
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
    if (widthPx <= 0) return;
    const cutoutHalfHeight = Math.max(0, Math.min(pillHalfHeight - 1e-3, centerCutoutHalfHeight));
    if (cutoutHalfHeight <= 0) {
      drawLanePill(
        g,
        path,
        pillStartBp,
        widthPx,
        offset,
        pillHalfHeight,
        color,
        alpha,
        this.genomeLength
      );
      return;
    }

    const shellPolygons = laneRoundedPillShellPolygons(
      path,
      pillStartBp,
      widthPx,
      offset,
      pillHalfHeight,
      cutoutHalfHeight
    );
    for (const pts of shellPolygons) {
      g.poly(pts);
      g.fill({ color, alpha });
    }
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
    const totalLen = rangeLength(startBp, endBp, this.genomeLength);
    if (totalLen <= 0) return;

    const gapPadBp = screenWidthToBp(path, startBp, 1.5, offset, totalLen);
    const normalizedGaps = gaps
      .map((gap) => {
        const rawStart = rangeLength(startBp, gap.startBp, this.genomeLength);
        const rawEnd = rangeLength(startBp, gap.endBp, this.genomeLength);
        return {
          start: Math.max(0, rawStart - gapPadBp),
          end: Math.min(totalLen, rawEnd + gapPadBp),
        };
      })
      .filter((gap) => gap.end > gap.start && gap.start < totalLen && gap.end > 0)
      .sort((a, b) => a.start - b.start);

    let cursor = 0;
    for (const gap of normalizedGaps) {
      const gapStart = Math.max(cursor, gap.start);
      if (gapStart > cursor + 1e-6) {
        drawLaneBand(
          g,
          path,
          startBp + cursor,
          startBp + gapStart,
          offset,
          halfHeight,
          color,
          alpha,
          this.genomeLength
        );
      }
      cursor = Math.max(cursor, gap.end);
    }

    if (cursor < totalLen - 1e-6) {
      drawLaneBand(
        g,
        path,
        startBp + cursor,
        endBp,
        offset,
        halfHeight,
        color,
        alpha,
        this.genomeLength
      );
    }
  }

  drawPillSeparator(
    g: Graphics,
    path: PathMapper,
    pillStartBp: number,
    offsetPxFromPillStart: number,
    offset: number,
    height: number,
    alpha = 1
  ): void {
    const bp = advanceBpByScreenWidth(path, pillStartBp, offsetPxFromPillStart, offset);
    const center = path.featureLabelPosAt(bp, offset);
    const nx = -Math.sin(center.angle);
    const ny = Math.cos(center.angle);
    const half = Math.max(1, height / 2 - 2);
    g.setStrokeStyle({ width: 1, color: 0xffffff, alpha: 0.3 * alpha });
    g.moveTo(center.x - nx * half, center.y - ny * half);
    g.lineTo(center.x + nx * half, center.y + ny * half);
    g.stroke();
  }

  cdsDirectionGlyph(feature: Feature): string | null {
    if (feature.direction === 'forward') return '»';
    if (feature.direction === 'reverse') return '«';
    return null;
  }

  drawCdsDirectionGlyphInPill(
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
    if (pillWidthPx <= 0) return;
    const sideOffset =
      feature.direction === 'reverse'
        ? Math.min(pillWidthPx / 2, LABEL_PADDING + glyphWidthPx / 2)
        : Math.max(pillWidthPx / 2, pillWidthPx - LABEL_PADDING - glyphWidthPx / 2);
    const centerBp = advanceBpByScreenWidth(path, pillStartBp, sideOffset, offset);
    const startOffset = Math.max(0, sideOffset - glyphWidthPx / 2);
    const endOffset = Math.min(pillWidthPx, sideOffset + glyphWidthPx / 2);
    drawLanePillLabelText({
      text: glyph,
      path,
      startBp: advanceBpByScreenWidth(path, pillStartBp, startOffset, offset),
      widthPx: Math.max(1, endOffset - startOffset),
      offsetPx: offset,
      color,
      maxTextWidth: glyphWidthPx,
      acquireText: () => this.acquireLabel(),
      curvedLabels: this.curvedLabels,
      alpha,
      fontSize: DIRECTION_GLYPH_FONT_SIZE,
      textColor,
      centerBpOverride: centerBp,
      curvedRangeStartBp: advanceBpByScreenWidth(path, pillStartBp, startOffset, offset),
      curvedRangeEndBp: advanceBpByScreenWidth(path, pillStartBp, endOffset, offset),
    });
  }

  drawLabelTextInPill(
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
    void feature;
    drawLanePillLabelText({
      text,
      path,
      startBp,
      widthPx,
      offsetPx: offset,
      color,
      maxTextWidth,
      acquireText: () => this.acquireLabel(),
      curvedLabels: this.curvedLabels,
      alpha,
      textColor,
      centerBpOverride,
      curvedRangeStartBp,
      curvedRangeEndBp,
    });
  }

  pushPillHit(
    feature: Feature,
    startBp: number,
    widthPx: number,
    offset: number,
    halfHeight: number,
    rangeStart: number,
    rangeEnd: number,
    path: PathMapper
  ): void {
    const endBp = advanceBpByScreenWidth(path, startBp, widthPx, offset);
    const pts = path.featurePolygonAt(startBp, endBp, offset, halfHeight);
    const bbox = computeBBox(pts);
    this.hitCache.push({
      id: feature.id,
      start: normalizeBp(rangeStart, this.genomeLength),
      end: normalizeBp(rangeEnd, this.genomeLength),
      pts,
      ...bbox,
    });
  }

  reservePillBounds(
    state: RenderState,
    path: PathMapper,
    startBp: number,
    widthPx: number,
    offset: number,
    halfHeight: number,
    record: { kind: string; featureId?: number; text?: string },
    force = false
  ): boolean {
    if (widthPx <= 0) return false;
    const endBp = advanceBpByScreenWidth(path, startBp, widthPx, offset);
    const pts = path.featurePolygonAt(startBp, endBp, offset, halfHeight);
    const bounds = computeBBox(pts);
    const reserved = reserveLabelBounds(state, bounds, record, { force });
    if (reserved) {
      this.labelOccupancyCache.push({ ...bounds, ...record });
    }
    return reserved;
  }

  replayLabelOccupancy(state: RenderState): void {
    for (const { xMin, xMax, yMin, yMax, kind, featureId, text } of this.labelOccupancyCache) {
      reserveLabelBounds(
        state,
        { xMin, xMax, yMin, yMax },
        { kind, featureId, text },
        { force: true }
      );
    }
  }
  drawTranscriptGlyph(
    sink: FeaturePrimitiveSink,
    feature: Feature,
    _endBp: number,
    _featureLen: number,
    _pixelWidth: number,
    _baseColor: number,
    alpha: number,
    path: PathMapper,
    state: RenderState,
    _hitPts: number[],
    labelAlphaScale: number
  ): void {
    const offset = this.featureOffset(feature);
    const outlineOnly = isOutlineOnlyFeature(feature);
    const halfHeight = this.scaledBarHeight() / 2;
    const intronHalfH = Math.max(0.5, halfHeight * TRANSCRIPT_INTRON_STYLE.heightRatio);

    const transcriptType = feature.annotationTrackId ?? feature.type;
    const isNonCodingType = isNonCodingTranscriptType(transcriptType);
    const hasCdsData = (feature.cds?.length ?? 0) > 0;

    const mappedColor =
      this.glue?.featureBodyColor?.(feature) ??
      state.sequencePresentation?.annotationColors?.get(feature.id);
    const utrColor =
      mappedColor ??
      (isNonCodingType
        ? rnaAccentColorForMode(transcriptType, state.themeMode)
        : transcriptColorForMode('utr', state.themeMode));
    const cdsColor = mappedColor ?? transcriptColorForMode('cdsThick', state.themeMode);
    const intronColor = mappedColor ?? transcriptColorForMode('intron', state.themeMode);

    const cdsHalfH = halfHeight;
    const utrHalfH = Math.max(2, halfHeight * TRANSCRIPT_INTRON_STYLE.utrHeightRatio);

    const cdsDetail = this.cdsDetailProgress();

    const exons = feature.exons ?? [];
    const cdsSegments = feature.cds ?? [];
    const dir = feature.direction;
    const drawArrow = dir === 'forward' || dir === 'reverse';

    const drawCdsBlocks = !isNonCodingType && hasCdsData && !outlineOnly;

    const exonOutlinePolys: number[][] = [];
    const transcriptOutlineCommands: OutlineCommand[] = [];

    const { visLo, visHi } = this.transcriptViewportBounds(path);
    const exonVisible = (s: number, e: number): boolean => e >= visLo && s <= visHi;

    const directionalArrowWidthFor = (w: number, h: number): number =>
      this.directionalArrowWidth(w, h);

    const buildBlockPts = (
      segStart: number,
      segEnd: number,
      halfH: number,
      pointed: boolean
    ): number[] => {
      const segWidthPx = (segEnd - segStart) * path.pixelsPerBp;
      if (drawArrow && pointed) {
        const aw = directionalArrowWidthFor(segWidthPx, halfH * 2);
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

    if (exons.length > 1) {
      for (const { startBp, endBp } of this.transcriptIntronGapRanges(feature, path)) {
        if ((endBp - startBp) * path.pixelsPerBp < 0.5) continue;
        const intronPts = path.featurePolygonAt(startBp, endBp, offset, intronHalfH);
        sink.fillPoly(intronPts, intronColor, alpha * 0.7);
      }
    }

    for (let i = 0; i < exons.length; i++) {
      const exon = exons[i];
      const exStart = exon.start - 1;
      const exEnd = exon.end;

      if (!exonVisible(exStart, exEnd)) {
        exonOutlinePolys.push([]);
        continue;
      }

      exonOutlinePolys.push(path.featurePolygonAt(exStart, exEnd, offset, cdsHalfH));

      const parts = splitExon(exStart, exEnd);
      const arrowPartIdx = dir === 'reverse' ? 0 : parts.length - 1;
      for (let p = 0; p < parts.length; p++) {
        const part = parts[p];
        const isCds = part.kind === 'cds';
        const halfH = isCds ? cdsHalfH : utrHalfH;
        const fill = isCds ? cdsColor : utrColor;
        const pointed = p === arrowPartIdx;
        const pts = buildBlockPts(part.s, part.e, halfH, pointed);
        transcriptOutlineCommands.push({ kind: 'poly', pts });
        if (outlineOnly) {
          sink.strokePoly(pts, fill, 0.9 * labelAlphaScale);
        } else if (isCds) {
          const cdsFillAlpha = alpha * (1 - 0.85 * cdsDetail);
          sink.fillPoly(pts, fill, cdsFillAlpha);
        } else {
          sink.fillPoly(pts, fill, alpha);
        }
      }
    }

    this.drawTranscriptIntronChevrons(this.graphics, feature, path, state, alpha);

    transcriptOutlineCommands.push(
      ...this.transcriptIntronLineOutlineCommands(feature, path, offset)
    );
    this.setFeatureOutline(feature.id, transcriptOutlineCommands);

    const labelAlpha = this.overviewLabelAlpha() * labelAlphaScale;
    if (labelAlpha > 0.01 && feature.displayName) {
      const labelPlacement = bestVisiblePolygonLabelCandidate(
        exonOutlinePolys,
        state.width,
        state.height
      );
      if (labelPlacement && labelPlacement.visibleWidth > MIN_BAR_FOR_LABEL) {
        const labelExon = exons[labelPlacement.candidateIndex];
        const labelExonPts = exonOutlinePolys[labelPlacement.candidateIndex] ?? [];
        const exStart0 = labelExon.start - 1;
        const exEnd0 = labelExon.end;
        const labelMidExon =
          Math.floor(exStart0 + (exEnd0 - exStart0) * labelPlacement.fraction) + 1;
        const labelOverCds = cdsSegments.some(
          (c) => c.start <= labelMidExon && c.end >= labelMidExon
        );
        const labelColor =
          state.sequencePresentation?.annotationColors?.get(feature.id) ??
          (labelOverCds ? 0xffffff : cdsColor);
        if (path.isArcMode) {
          const availW = labelPlacement.visibleWidth - 8;
          const labelText = truncateForWidth(
            feature.displayName,
            availW,
            this.labelCache,
            feature.id
          );
          if (labelText) {
            const textWidth = measurePillLabelTextWidth(labelText);
            const centerBp0 = exStart0 + (exEnd0 - exStart0) * labelPlacement.fraction;
            this.renderCurvedLabel(
              labelText,
              centerBp0,
              textWidth,
              feature,
              exEnd0,
              cdsColor,
              offset,
              path,
              labelAlpha,
              exStart0,
              exEnd0,
              labelColor
            );
          }
        } else {
          const labelPosX = labelPlacement.cx;
          const labelPosY = labelPlacement.cy;
          const availW = labelPlacement.visibleWidth - 8;

          const labelText = truncateForWidth(
            feature.displayName,
            availW,
            this.labelCache,
            feature.id
          );
          if (labelText) {
            const labelMode =
              typeof window !== 'undefined'
                ? (window as Window & { __transcriptLabelMode?: string }).__transcriptLabelMode
                : undefined;

            if (labelMode === 'gutter') {
              let barTop = Infinity;
              for (let i = 1; i < labelExonPts.length; i += 2) {
                if (labelExonPts[i] < barTop) barTop = labelExonPts[i];
              }
              if (!Number.isFinite(barTop)) barTop = labelPosY;
              const PLATE_H = 14;
              const GUTTER_GAP = 3;
              const padX = 4;
              const gutterCenterY = barTop - GUTTER_GAP - PLATE_H / 2;
              const textW = measurePillLabelTextWidth(labelText);
              const isDark = state.themeMode === 'dark';

              const g = this.graphics;
              g.roundRect(
                labelPosX - textW / 2 - padX,
                gutterCenterY - PLATE_H / 2,
                textW + padX * 2,
                PLATE_H,
                3
              );
              g.fill({ color: isDark ? 0x1f2937 : 0xffffff, alpha: 0.82 * labelAlpha });
              const textObj = this.acquireLabel();
              textObj.text = labelText;
              const gStyle = pillLabelTextStyle(
                isDark ? 0xe5e7eb : 0x1f2937,
                undefined,
                state.sequencePresentation?.annotationColors?.get(feature.id)
              );
              if (textObj.style !== gStyle) textObj.style = gStyle;
              textObj.alpha = labelAlpha;
              textObj.resolution = targetPillLabelTextResolution();
              textObj.x = labelPosX;
              textObj.y = gutterCenterY;
              textObj.anchor.set(0.5, 0.5);
              textObj.rotation = 0;
              textObj.scale.set(1);
            } else {
              const textObj = this.acquireLabel();
              textObj.text = labelText;
              const targetStyle = pillLabelTextStyle(
                labelColor,
                undefined,
                state.sequencePresentation?.annotationColors?.get(feature.id)
              );
              if (textObj.style !== targetStyle) textObj.style = targetStyle;
              textObj.alpha = labelAlpha;
              textObj.resolution = targetPillLabelTextResolution();
              textObj.x = labelPosX;
              textObj.y = labelPosY;
              textObj.anchor.set(0.5, 0.5);
              textObj.rotation = 0;
              textObj.scale.set(1);
            }
          }
        }
      }
    }
  }
}
