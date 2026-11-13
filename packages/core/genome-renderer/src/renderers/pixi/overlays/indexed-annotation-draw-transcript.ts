import { annotationMutationBodyColor } from './annotation-mutation-paint';
import { TRANSCRIPT_INTRON_STYLE, cdsZoomBandCenterOffset } from '@waypoint/platform';

import type { Graphics, Text } from 'pixi.js';
import type { Feature, RenderState } from '../../../types';
import {
  isNonCodingTranscriptType,
  rnaAccentColorForMode,
  transcriptColorForMode,
} from '../../../feature-colors';
import type { PathMapper } from '../shared/path-mapper';
import {
  measurePillLabelTextWidth,
  pillLabelTextStyle,
  targetPillLabelTextResolution,
} from '../shared/label-pill';
import { buildDirectionalPolygon, type OutlineCommand } from './annotation-feature-geometry';
import { isOutlineOnlyFeature } from './annotation-feature-semantics';
import { bestVisiblePolygonLabelCandidate, truncateForWidth } from './annotation-label-geometry';
import type { FeaturePrimitiveSink } from '../overview/feature-primitive-sink';
import { drawTranscriptIntronChevrons } from './indexed-annotation-draw-geometry';

const MIN_BAR_FOR_LABEL = 30;

export type TranscriptGlyphDrawHost = {
  featureOffset(feature: Feature): number;
  scaledBarHeight(): number;
  cdsDetailProgress(): number;
  directionalArrowWidth(pixelWidth: number, barHeight: number): number;
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
  graphics: Graphics;
  setFeatureOutline(featureId: number, commands: OutlineCommand[]): void;
  overviewLabelAlpha(): number;
  labelCache: Map<number, { text: string; width: number }>;
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
  acquireLabel(): Text;
};

export function drawTranscriptGlyph(
  host: TranscriptGlyphDrawHost,
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
  const pose = path.cdsZoomPresentation;
  const codingMorph = Boolean(pose?.bandProgress && feature.cds?.length);
  const offset =
    host.featureOffset(feature) + (codingMorph && pose ? cdsZoomBandCenterOffset(pose) : 0);
  const outlineOnly = isOutlineOnlyFeature(feature);
  const halfHeight = codingMorph && pose ? pose.aaHeight / 2 : host.scaledBarHeight() / 2;
  const intronHalfH = Math.max(0.5, halfHeight * TRANSCRIPT_INTRON_STYLE.heightRatio);

  const transcriptType = feature.annotationTrackId ?? feature.type;
  const isNonCodingType = isNonCodingTranscriptType(transcriptType);
  const hasCdsData = (feature.cds?.length ?? 0) > 0;

  const mappedColor = annotationMutationBodyColor(feature, state.sequencePresentation);
  const utrColor =
    mappedColor ??
    (isNonCodingType
      ? rnaAccentColorForMode(transcriptType, state.themeMode)
      : transcriptColorForMode('utr', state.themeMode));
  const cdsColor = mappedColor ?? transcriptColorForMode('cdsThick', state.themeMode);
  const intronColor = mappedColor ?? transcriptColorForMode('intron', state.themeMode);

  const cdsHalfH = halfHeight;
  const utrHalfH = Math.max(2, halfHeight * TRANSCRIPT_INTRON_STYLE.utrHeightRatio);

  const cdsDetail = host.cdsDetailProgress();

  const exons = feature.exons ?? [];
  const cdsSegments = feature.cds ?? [];
  const dir = feature.direction;
  const drawArrow = dir === 'forward' || dir === 'reverse';

  const drawCdsBlocks = !isNonCodingType && hasCdsData && !outlineOnly;

  const exonOutlinePolys: number[][] = [];
  const transcriptOutlineCommands: OutlineCommand[] = [];

  const { visLo, visHi } = host.transcriptViewportBounds(path);
  const exonVisible = (s: number, e: number): boolean => e >= visLo && s <= visHi;

  const directionalArrowWidthFor = (w: number, h: number): number =>
    host.directionalArrowWidth(w, h);

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
    for (const { startBp, endBp } of host.transcriptIntronGapRanges(feature, path)) {
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
      if (codingMorph && isCds) continue;
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

  drawTranscriptIntronChevrons(host.graphics, feature, path, state, alpha, offset);

  transcriptOutlineCommands.push(
    ...host.transcriptIntronLineOutlineCommands(feature, path, offset)
  );
  host.setFeatureOutline(feature.id, transcriptOutlineCommands);
  if (codingMorph) return;

  const labelAlpha = host.overviewLabelAlpha() * labelAlphaScale;
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
      const labelMidExon = Math.floor(exStart0 + (exEnd0 - exStart0) * labelPlacement.fraction) + 1;
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
          host.labelCache,
          feature.id
        );
        if (labelText) {
          const textWidth = measurePillLabelTextWidth(labelText);
          const centerBp0 = exStart0 + (exEnd0 - exStart0) * labelPlacement.fraction;
          host.renderCurvedLabel(
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
          host.labelCache,
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

            const g = host.graphics;
            g.roundRect(
              labelPosX - textW / 2 - padX,
              gutterCenterY - PLATE_H / 2,
              textW + padX * 2,
              PLATE_H,
              3
            );
            g.fill({ color: isDark ? 0x1f2937 : 0xffffff, alpha: 0.82 * labelAlpha });
            const textObj = host.acquireLabel();
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
            const textObj = host.acquireLabel();
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

export function drawRetainedTranscriptIntronConnectors(
  host: Pick<TranscriptGlyphDrawHost, 'featureOffset' | 'scaledBarHeight'>,
  g: Graphics,
  feature: Feature,
  path: PathMapper,
  state: RenderState,
  alpha: number,
  clipRange?: { lo: number; hi: number }
): void {
  const exons = feature.exons ?? [];
  if (exons.length <= 1 || path.isArcMode) return;

  const offset = host.featureOffset(feature);
  const halfHeight = Math.max(1, (host.scaledBarHeight() / 2) * 0.12);
  const intronColor =
    state.sequencePresentation?.annotationColors?.get(feature.id) ??
    transcriptColorForMode('intron', state.themeMode);
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

export function transcriptGlyphOutlineCommands(
  host: TranscriptGlyphDrawHost,
  feature: Feature,
  path: PathMapper
): OutlineCommand[] {
  const offset = host.featureOffset(feature);
  const outlineOnly = isOutlineOnlyFeature(feature);
  const halfHeight = host.scaledBarHeight() / 2;
  const cdsHalfH = halfHeight;
  const utrHalfH = Math.max(2, halfHeight * TRANSCRIPT_INTRON_STYLE.utrHeightRatio);
  const isNonCodingType = isNonCodingTranscriptType(feature.annotationTrackId ?? feature.type);
  const cdsSegments = feature.cds ?? [];
  const drawCdsBlocks = !isNonCodingType && cdsSegments.length > 0 && !outlineOnly;
  const exons = feature.exons ?? [];
  const dir = feature.direction;
  const drawArrow = dir === 'forward' || dir === 'reverse';
  const { visLo, visHi } = host.transcriptViewportBounds(path);
  const commands: OutlineCommand[] = [];

  const buildBlockPts = (
    segStart: number,
    segEnd: number,
    halfH: number,
    pointed: boolean
  ): number[] => {
    const segWidthPx = (segEnd - segStart) * path.pixelsPerBp;
    if (drawArrow && pointed) {
      const aw = host.directionalArrowWidth(segWidthPx, halfH * 2);
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

  commands.push(...host.transcriptIntronLineOutlineCommands(feature, path, offset));
  return commands;
}
