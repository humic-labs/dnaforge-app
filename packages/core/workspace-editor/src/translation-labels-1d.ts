import type { ClassifiedCDS } from './types';
import { strokeCdsOutline } from './cds-glyph-drawing';
import { singleRowChevronOutlines } from './translation-drawing';
import {
  CDS_GLYPH_STYLE,
  cdsConnectorCenterOffset,
  rectangleContour,
  roundedRectangleContour,
  type OutlinePoint,
} from '@waypoint/platform';
import type { AnnotationColorMode } from '@waypoint/sequence-utils';
import { adaptColorForDark, isLightColor } from './canvas-colors';
import { getCanvasTheme } from './canvas-theme';
import { getAnnotationDisplayColor } from './utils/color-utils';
import { effectiveEnd } from './utils/circular-cols';
import { TRANSLATION_LABEL_HEIGHT } from './layout-constants';
import {
  annotationRenderState,
  annotationOutlineStrokeSpec,
  type AnnotationRenderStateInput,
} from './annotation-render-state';
import {
  DEFAULT_MUTED_COLUMN_COLOR,
  isMutedColumn,
  splitRangeByMutedColumns,
} from './muted-columns';

const PILL_CORNER_RADIUS = 3;
const PILL_PAD_H = 6;
const SEP_GAP = 3;
const SEP_WIDTH = 1;
const MIN_PILL_WIDTH_PX = 24;
const THIN_BAR_THICKNESS = CDS_GLYPH_STYLE.replacementTopEdgeHeight;
const THIN_BAR_ALPHA = 0.7;

export interface TranslationLabel1DParams {
  cdss: ClassifiedCDS[];
  pxPerBase: number;
  columnCount: number;
  sequenceLength: number;
  viewportLeftX: number;
  viewportRightX: number;
  originX: number;
  bandTopY: number;
  laneHeight: number;
  labelHeight?: number;
  labelFontSize: number;
  labelFontFamily: string;
  colorPalette?: string;
  annotationColorMode?: AnnotationColorMode;
  mutedColumns?: ReadonlySet<number> | undefined;
  mutedColumnColor?: string | undefined;
  annotationRenderStateInput?: AnnotationRenderStateInput;
}

export function drawTranslationLabels1D(
  ctx: CanvasRenderingContext2D,
  params: TranslationLabel1DParams
): void {
  const {
    cdss,
    pxPerBase,
    columnCount,
    viewportLeftX,
    viewportRightX,
    originX,
    bandTopY,
    laneHeight,
    labelFontSize,
    labelFontFamily,
    annotationColorMode,
  } = params;
  const labelHeight = params.labelHeight ?? TRANSLATION_LABEL_HEIGHT;
  const isDark = getCanvasTheme().isDark;
  const mutedColumns = params.mutedColumns;
  const mutedCdsColor = adaptColorForDark(
    params.mutedColumnColor ?? DEFAULT_MUTED_COLUMN_COLOR,
    isDark
  );
  const textColorFor = (bgColor: string): string =>
    isLightColor(bgColor) ? getCanvasTheme().fgMuted : 'rgba(255, 255, 255, 0.85)';
  const mutedTextColor = textColorFor(mutedCdsColor);

  const drawThinBar = (
    rangeStartCol: number,
    rangeEndCol: number,
    laneY: number,
    cdsColor: string
  ): Array<{ x1: number; x2: number }> => {
    const barMidY =
      laneY + labelHeight / 2 + cdsConnectorCenterOffset(labelHeight / 2, THIN_BAR_THICKNESS / 2);
    const viewportStartCol = Math.floor((viewportLeftX - originX) / pxPerBase);
    const viewportEndCol = Math.ceil((viewportRightX - originX) / pxPerBase);
    const splitStartCol = Math.max(rangeStartCol, viewportStartCol);
    const splitEndCol = Math.min(rangeEndCol, viewportEndCol);
    if (splitEndCol <= splitStartCol) return [];
    const spans = splitRangeByMutedColumns(splitStartCol, splitEndCol, mutedColumns, columnCount);
    const drawnSpans: Array<{ x1: number; x2: number }> = [];
    ctx.globalAlpha = THIN_BAR_ALPHA;
    for (const span of spans) {
      const x1 = Math.max(originX + span.start * pxPerBase, viewportLeftX);
      const x2 = Math.min(originX + span.end * pxPerBase, viewportRightX);
      if (x2 <= x1) continue;
      ctx.fillStyle = span.muted ? mutedCdsColor : cdsColor;
      ctx.fillRect(x1, barMidY - THIN_BAR_THICKNESS / 2, x2 - x1, THIN_BAR_THICKNESS);
      drawnSpans.push({ x1, x2 });
    }
    ctx.globalAlpha = 1.0;
    return drawnSpans;
  };

  const styleForPill = (
    pillLeft: number,
    cdsColor: string,
    textColor: string
  ): { bgColor: string; textColor: string } => {
    const virtualColumn = Math.floor((pillLeft - originX) / pxPerBase);
    if (isMutedColumn(virtualColumn, mutedColumns, columnCount)) {
      return { bgColor: mutedCdsColor, textColor: mutedTextColor };
    }
    return { bgColor: cdsColor, textColor };
  };

  ctx.save();
  ctx.font = `500 ${labelFontSize}px ${labelFontFamily}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const cds of cdss) {
    if (cds.translationLane < 0) continue;
    const laneY = bandTopY + cds.translationLane * laneHeight;

    const cdsColor = adaptColorForDark(
      getAnnotationDisplayColor(cds, { annotationColorMode }),
      isDark
    );
    const textColor = textColorFor(cdsColor);

    const cdsRenderState = annotationRenderState(cds, params.annotationRenderStateInput);
    const cdsOutlineSpec = annotationOutlineStrokeSpec(cdsRenderState);

    const chevronOutlines = singleRowChevronOutlines.get(cds) ?? [];
    singleRowChevronOutlines.delete(cds);
    const outlineShapes: OutlinePoint[][] = cdsOutlineSpec ? [...chevronOutlines] : [];

    const cdsStartCol = Math.max(0, cds.start - 1);
    const cdsEndCol = effectiveEnd(cds.start, cds.end, columnCount, columnCount > 0);
    const cdsOffsets = columnCount > 0 ? [-columnCount, 0, columnCount] : [0];
    for (const cdsOffset of cdsOffsets) {
      const cdsFullX1 = originX + (cdsStartCol + cdsOffset) * pxPerBase;
      const cdsFullX2 = originX + (cdsEndCol + cdsOffset) * pxPerBase;
      if (cdsFullX2 < viewportLeftX) continue;
      if (cdsFullX1 > viewportRightX) continue;

      const barMidY =
        laneY + labelHeight / 2 + cdsConnectorCenterOffset(labelHeight / 2, THIN_BAR_THICKNESS / 2);
      const barSpans = drawThinBar(cdsStartCol + cdsOffset, cdsEndCol + cdsOffset, laneY, cdsColor);
      if (cdsOutlineSpec)
        for (const span of barSpans)
          outlineShapes.push(
            rectangleContour(
              span.x1,
              barMidY - THIN_BAR_THICKNESS / 2,
              span.x2 - span.x1,
              THIN_BAR_THICKNESS
            )
          );

      if (cdsFullX2 - cdsFullX1 >= MIN_PILL_WIDTH_PX) {
        const pillLeft = Math.max(cdsFullX1, viewportLeftX);
        const nameW = ctx.measureText(cds.name).width + PILL_PAD_H * 2;
        const pillStyle = styleForPill(pillLeft, cdsColor, textColor);
        const pill = drawCompoundPillAt(ctx, {
          segments: [{ label: cds.name, bold: true }],
          pillLeft,
          pillWidth: nameW,
          maxRight: cdsFullX2,
          y: laneY,
          height: labelHeight,
          bgColor: pillStyle.bgColor,
          textColor: pillStyle.textColor,
        });
        if (cdsOutlineSpec && pill)
          outlineShapes.push(
            roundedRectangleContour(pill.left, laneY, pill.width, labelHeight, PILL_CORNER_RADIUS)
          );
      }
    }
    if (outlineShapes.length) strokeCdsOutline(ctx, cdsRenderState, outlineShapes);
  }

  ctx.restore();
}

interface CompoundPillAtParams {
  segments: Array<{ label: string; bold: boolean }>;
  pillLeft: number;
  pillWidth: number;
  maxRight: number;
  y: number;
  height: number;
  bgColor: string;
  textColor: string;
}

function drawCompoundPillAt(
  ctx: CanvasRenderingContext2D,
  p: CompoundPillAtParams
): { left: number; width: number } | null {
  const sepW = SEP_GAP + SEP_WIDTH + SEP_GAP;
  type LaidOut = { display: string; width: number };
  const laid: LaidOut[] = p.segments.map((s) => ({
    display: s.label,
    width: ctx.measureText(s.label).width,
  }));
  const computeTotal = (segs: LaidOut[]): number =>
    segs.reduce((acc, s, i) => acc + s.width + PILL_PAD_H * 2 + (i > 0 ? sepW : 0), 0);

  let totalW = computeTotal(laid);
  const availW = p.maxRight - p.pillLeft;

  while (totalW > availW && laid.length > 0) {
    const last = laid[laid.length - 1];
    if (last.display.length <= 1) {
      laid.pop();
      totalW = computeTotal(laid);
      continue;
    }
    const trimmed = last.display.endsWith('…')
      ? last.display.slice(0, -2) + '…'
      : last.display.slice(0, -1) + '…';
    last.display = trimmed;
    last.width = ctx.measureText(trimmed).width;
    totalW = computeTotal(laid);
  }

  if (laid.length === 0 || totalW <= 0) {
    const w = Math.min(p.pillWidth, Math.max(2, availW));
    if (w < 2) return null;
    ctx.fillStyle = p.bgColor;
    ctx.beginPath();
    ctx.roundRect(p.pillLeft, p.y, w, p.height, PILL_CORNER_RADIUS);
    ctx.fill();
    return { left: p.pillLeft, width: w };
  }

  ctx.fillStyle = p.bgColor;
  ctx.beginPath();
  ctx.roundRect(p.pillLeft, p.y, totalW, p.height, PILL_CORNER_RADIUS);
  ctx.fill();

  let cursor = p.pillLeft;
  for (let i = 0; i < laid.length; i++) {
    const s = laid[i];
    const blockW = s.width + PILL_PAD_H * 2;

    if (i > 0) {
      ctx.fillStyle = p.textColor;
      ctx.globalAlpha = 0.3;
      ctx.fillRect(cursor + SEP_GAP, p.y + 2, SEP_WIDTH, p.height - 4);
      ctx.globalAlpha = 1.0;
      cursor += sepW;
    }

    ctx.fillStyle = p.textColor;
    ctx.fillText(s.display, cursor + blockW / 2, p.y + p.height / 2);
    cursor += blockW;
  }
  return { left: p.pillLeft, width: totalW };
}
