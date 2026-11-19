import {
  paintTranscriptGlyph,
  type AminoAcidIntronOwner,
  type IntronConnectorStroke,
} from './transcript-drawing';
import type { SequenceDrawingContext } from './rendering/drawing-context';

import type { Annotation } from '@waypoint/sequence-utils';
import type {
  WorkspaceEditorConfig,
  Selection,
  InsertedRange,
  DeletedRange,
  LinePositions,
} from './types';
export type { LinePositions } from './types';
export { drawSequenceText, drawComplementText } from './canvas-drawing-sequence-text';
export { getEffectiveRulerInterval, drawRuler } from './canvas-drawing-ruler';
export { drawPrimers } from './canvas-drawing-primers';
export {
  drawRecognitionHighlights,
  drawJunctionIndicators,
  drawHoveredRecognitionBorder,
  hitTestGGProductLabel,
  drawAllGGScarBackgrounds,
  drawGGScarHighlights,
} from './canvas-drawing-restriction';
export {
  drawDiffSequenceHighlights,
  drawMutationTrack,
  getMutationTrackHeight,
  drawMutationTrack1D,
} from './canvas-drawing-mutation-track';
import { ANNOTATION_CANVAS_CONSTANTS } from './canvas-constants';
import {
  ANNOTATION_BAR_HEIGHT,
  ANNOTATION_LABEL_FONT_SIZE,
  ROW_TOP_PADDING,
  ROW_BOTTOM_PADDING,
} from './layout-constants';
import { getCanvasTheme } from './canvas-theme';
import { rowBackgroundBounds } from './row-background-geometry';
import { adaptColorForDark, isLightColor } from './canvas-colors';
import { getDarkenedColor, getEmphasizedColor } from './utils/color-utils';
import {
  annotationOutlineStrokeSpec,
  annotationRenderState,
  paintAnnotationOutline,
} from './annotation-render-state';
import {
  ANNOTATION_DRAFT_OUTLINE_ALPHA,
  ANNOTATION_DRAFT_OUTLINE_DASH,
  ANNOTATION_DRAFT_OUTLINE_WIDTH,
  resolveAnnotationDraftStyle,
} from './annotation-draft-style';
import { drawSelectionHandleBar, drawViewCursorLine } from './selection-primitives';
import { getVisibleRangeSegments, lineSpansOrigin } from './utils/range-utils';
import { resolveAnnotationDisplayColor, type SearchMatch } from '@waypoint/sequence-utils';
import { DEFAULT_MUTED_COLUMN_COLOR, splitRangeByMutedColumns } from './muted-columns';

const ELLIPSIS = '…';

interface AnnotationSegmentStyle {
  lane?: number;
  labelText?: string;
  colorOverride?: string | undefined;
  colorIsAdapted?: boolean;
  surfaceOpacity?: number;
  contour?: readonly { x: number; y: number }[];

  traceContour?: (context: SequenceDrawingContext) => void;
  mutedColumns?: ReadonlySet<number> | undefined;
  mutedColumnColor?: string | undefined;
  sequenceLength?: number | undefined;
  clipStart?: number | undefined;
  clipEnd?: number | undefined;
  suppressStartTear?: boolean | undefined;
  suppressEndTear?: boolean | undefined;
  labelBounds?: { centerX: number; availableWidth: number };
}

export function fitCanvasLabel(
  ctx: SequenceDrawingContext,
  label: string,
  maxWidth: number
): string | null {
  if (maxWidth <= 0) return null;
  if (ctx.measureText(label).width <= maxWidth) return label;

  const ellipsisWidth = ctx.measureText(ELLIPSIS).width;
  const textWidth = maxWidth - ellipsisWidth;
  if (textWidth <= 0) return null;

  let lo = 1;
  let hi = label.length;
  let best = '';
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const candidate = label.slice(0, mid);
    if (ctx.measureText(candidate).width <= textWidth) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return best.length > 0 ? best + ELLIPSIS : null;
}

export { getVisibleRangeSegments } from './utils/range-utils';

function drawCdsAnnotationDetail(args: {
  ctx: SequenceDrawingContext;
  ann: Annotation;
  config: WorkspaceEditorConfig;
  color: string;
  direction: number | undefined;
  isUncheckedDraft: boolean;
  draftSurfaceAlpha: number;
  reviewFade: number;
  draftStyle: ReturnType<typeof resolveAnnotationDraftStyle>;
  laneY: number;
  annotationHeight: number;
  barX: number;
  barWidth: number;
  isChanged: boolean | undefined;
  hasDraftOutline: boolean;
  effectiveRenderState: 'default' | 'hovered' | 'selected';
  annotationLabelFontSize: number;
}): void {
  const {
    ctx,
    ann,
    config,
    color,
    direction,
    isUncheckedDraft,
    draftSurfaceAlpha,
    reviewFade,
    draftStyle,
    laneY,
    annotationHeight,
    barX,
    barWidth,
    isChanged,
    hasDraftOutline,
    effectiveRenderState,
    annotationLabelFontSize,
  } = args;
  const lineThickness = 5;
  const lineMidY = laneY + annotationHeight / 2;

  ctx.font = `500 ${annotationLabelFontSize}px ${config.labelFontFamily}`;
  const labelText = ann.name;
  const labelPadding = 6;
  const measuredWidth = ctx.measureText(labelText).width;
  const directionGlyph = direction === 1 ? '»' : direction === -1 ? '«' : null;
  ctx.font = `500 ${annotationLabelFontSize}px ${config.labelFontFamily}`;
  const directionGlyphWidth = directionGlyph ? ctx.measureText(directionGlyph).width : 0;
  const directionGlyphGap = directionGlyph ? 3 : 0;
  const directionGlyphSlotWidth = directionGlyphWidth + directionGlyphGap;
  ctx.font = `500 ${annotationLabelFontSize}px ${config.labelFontFamily}`;
  const labelBlockWidth = Math.min(
    measuredWidth + labelPadding * 2 + directionGlyphSlotWidth,
    barWidth
  );

  const labelBlockAlpha = draftSurfaceAlpha * reviewFade;
  const connectorAlpha = labelBlockAlpha * draftStyle.connectorAlphaMultiplier;

  const labelBlockX = barX;
  ctx.beginPath();
  ctx.roundRect(labelBlockX, laneY, labelBlockWidth, annotationHeight, 3);
  if (isUncheckedDraft) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 1.0;
    ctx.stroke();
  } else {
    ctx.fillStyle = color;
    ctx.globalAlpha = labelBlockAlpha;
    ctx.fill();
    ctx.globalAlpha = 1.0;
  }

  if (labelBlockWidth > 4) {
    const labelColor = isUncheckedDraft
      ? color
      : isLightColor(color)
        ? getCanvasTheme().fgMuted
        : 'rgba(255, 255, 255, 0.85)';
    ctx.fillStyle = labelColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (directionGlyph) {
      ctx.font = `500 ${annotationLabelFontSize}px ${config.labelFontFamily}`;
      const glyphX =
        direction === -1
          ? labelBlockX + Math.min(labelBlockWidth / 2, labelPadding + directionGlyphWidth / 2)
          : labelBlockX +
            Math.max(labelBlockWidth / 2, labelBlockWidth - labelPadding - directionGlyphWidth / 2);
      ctx.fillText(directionGlyph, glyphX, laneY + annotationHeight / 2);
    }

    const nameStartOffset = direction === -1 ? directionGlyphSlotWidth : 0;
    const nameEndOffset = direction === 1 ? directionGlyphSlotWidth : 0;
    const nameAreaWidth = labelBlockWidth - labelPadding * 2 - nameStartOffset - nameEndOffset;
    if (nameAreaWidth > 0) {
      ctx.font = `500 ${annotationLabelFontSize}px ${config.labelFontFamily}`;
      const labelX = labelBlockX + labelPadding + nameStartOffset + nameAreaWidth / 2;
      const displayLabel = fitCanvasLabel(ctx, labelText, nameAreaWidth);
      if (displayLabel) {
        ctx.fillText(displayLabel, labelX, laneY + annotationHeight / 2);
      }
    }
  }

  const lineStartX = labelBlockX + labelBlockWidth;
  const lineEndX = barX + barWidth;
  if (lineEndX > lineStartX + 1) {
    ctx.fillStyle = color;
    ctx.globalAlpha = connectorAlpha;
    ctx.fillRect(lineStartX, lineMidY - lineThickness / 2, lineEndX - lineStartX, lineThickness);
    ctx.globalAlpha = 1.0;
  }

  if (isChanged) {
    ctx.save();
    ctx.setLineDash([3, 2.5]);
    ctx.strokeStyle = getDarkenedColor(color, 60, 1.0);
    ctx.lineWidth = 1.75;
    ctx.beginPath();
    ctx.roundRect(labelBlockX, laneY, labelBlockWidth, annotationHeight, 2);
    ctx.stroke();
    if (lineEndX > lineStartX + 1) {
      const halfT = lineThickness / 2;
      ctx.beginPath();
      ctx.moveTo(lineStartX, lineMidY - halfT);
      ctx.lineTo(lineEndX, lineMidY - halfT);
      ctx.moveTo(lineStartX, lineMidY + halfT);
      ctx.lineTo(lineEndX, lineMidY + halfT);
      ctx.stroke();
    }
    ctx.restore();
  }

  if (hasDraftOutline) {
    ctx.save();
    ctx.setLineDash([...ANNOTATION_DRAFT_OUTLINE_DASH]);
    ctx.strokeStyle = getDarkenedColor(color, 30, ANNOTATION_DRAFT_OUTLINE_ALPHA);
    ctx.lineWidth = ANNOTATION_DRAFT_OUTLINE_WIDTH;
    ctx.beginPath();
    ctx.roundRect(labelBlockX, laneY, labelBlockWidth, annotationHeight, 2);
    ctx.stroke();
    if (lineEndX > lineStartX + 1) {
      const halfT = lineThickness / 2;
      ctx.beginPath();
      ctx.moveTo(lineStartX, lineMidY - halfT);
      ctx.lineTo(lineEndX, lineMidY - halfT);
      ctx.moveTo(lineStartX, lineMidY + halfT);
      ctx.lineTo(lineEndX, lineMidY + halfT);
      ctx.stroke();
    }
    ctx.restore();
  }

  paintAnnotationOutline(
    ctx,
    effectiveRenderState,
    getEmphasizedColor(
      color,
      getCanvasTheme().isDark,
      60,
      annotationOutlineStrokeSpec(effectiveRenderState)?.alpha ?? 0.95
    ),
    (c) => {
      c.beginPath();
      c.roundRect(labelBlockX, laneY, labelBlockWidth, annotationHeight, 2);
      c.stroke();
      if (lineEndX > lineStartX + 1) {
        const halfThickness = lineThickness / 2;
        c.beginPath();
        c.moveTo(lineStartX, lineMidY - halfThickness);
        c.lineTo(lineEndX, lineMidY - halfThickness);
        c.moveTo(lineStartX, lineMidY + halfThickness);
        c.lineTo(lineEndX, lineMidY + halfThickness);
        c.stroke();
      }
    }
  );
}

function annotationDraftPaintStyle(
  ann: Annotation,
  renderState: 'default' | 'hovered' | 'selected' | undefined
): {
  draftStyle: ReturnType<typeof resolveAnnotationDraftStyle>;
  hasDraftOutline: boolean;
  isUncheckedDraft: boolean;
  draftSurfaceAlpha: number;
  effectiveRenderState: 'default' | 'hovered' | 'selected';
  reviewFade: number;
} {
  const draftStyle = resolveAnnotationDraftStyle(ann);
  return {
    draftStyle,
    hasDraftOutline: draftStyle.hasDottedOutline,
    isUncheckedDraft: draftStyle.isHollow,
    draftSurfaceAlpha: draftStyle.fillAlpha,
    effectiveRenderState: draftStyle.suppressInteractionOutline
      ? 'default'
      : (renderState ?? 'default'),
    reviewFade: ann.color === '#e5e7eb' && getCanvasTheme().isDark ? 0.5 : 1.0,
  };
}

function shouldRenderCdsDetailShape(
  ann: Annotation,
  renderCdsAsBar: boolean | undefined,
  config: WorkspaceEditorConfig
): boolean {
  return (
    ann.type === 'CDS' && !renderCdsAsBar && !config.overviewLod && config.lodLevel !== 'feature'
  );
}

function drawMutedColumnAnnotationSegments(
  ctx: SequenceDrawingContext,
  ann: Annotation & { lane?: number },
  visibleStart: number,
  visibleEnd: number,
  lineStartPos: number,
  x: number,
  y: number,
  config: WorkspaceEditorConfig,
  annotationHeight: number,
  laneSpacing: number,
  drawLabel: boolean,
  isStartOfAnnotation: boolean,
  isEndOfAnnotation: boolean,
  charIndexStart: number | undefined,
  isChanged: boolean | undefined,
  renderState: 'default' | 'hovered' | 'selected' | undefined,
  renderCdsAsBar: boolean | undefined,
  segmentStyle: AnnotationSegmentStyle
): boolean {
  if (!segmentStyle.mutedColumns || segmentStyle.mutedColumns.size === 0) return false;
  const styledStart = Math.max(visibleStart, Math.floor(segmentStyle.clipStart ?? visibleStart));
  const styledEnd = Math.min(visibleEnd, Math.ceil(segmentStyle.clipEnd ?? visibleEnd));
  if (styledEnd <= styledStart) return true;
  const mutedSegments = splitRangeByMutedColumns(
    styledStart,
    styledEnd,
    segmentStyle.mutedColumns,
    segmentStyle.sequenceLength
  );
  if (mutedSegments.length === 0) return true;
  if (
    mutedSegments.length === 1 &&
    !mutedSegments[0]?.muted &&
    styledStart <= visibleStart &&
    styledEnd >= visibleEnd
  ) {
    return false;
  }

  let labelSegmentIndex = -1;
  if (drawLabel) {
    let widest = -Infinity;
    mutedSegments.forEach((seg, idx) => {
      const width = seg.end - seg.start;
      if (width > widest) {
        widest = width;
        labelSegmentIndex = idx;
      }
    });
  }

  mutedSegments.forEach((seg, idx) => {
    drawAnnotationSegment(
      ctx,
      ann,
      seg.start,
      seg.end,
      lineStartPos,
      x,
      y,
      config,
      annotationHeight,
      laneSpacing,
      drawLabel && idx === labelSegmentIndex,
      seg.start === visibleStart ? isStartOfAnnotation : false,
      seg.end === visibleEnd ? isEndOfAnnotation : false,
      charIndexStart !== undefined ? charIndexStart + (seg.start - visibleStart) : undefined,
      isChanged,
      renderState,
      renderCdsAsBar,
      {
        lane: segmentStyle.lane,
        labelText: segmentStyle.labelText,
        colorOverride: seg.muted
          ? (segmentStyle.mutedColumnColor ?? DEFAULT_MUTED_COLUMN_COLOR)
          : undefined,
        suppressStartTear: seg.start > visibleStart || segmentStyle.suppressStartTear,
        suppressEndTear: seg.end < visibleEnd || segmentStyle.suppressEndTear,
      }
    );
  });
  return true;
}

function annotationSegmentBarGeometry(args: {
  x: number;
  y: number;
  charWidth: number;
  visibleStart: number;
  visibleEnd: number;
  lineStartPos: number;
  charIndexStart: number | undefined;
  lane: number;
  laneSpacing: number;
  color: string;
  direction: number;
}): { barX: number; barWidth: number; laneY: number; color: string; direction: number } {
  const barX =
    args.charIndexStart !== undefined
      ? args.x + args.charIndexStart * args.charWidth
      : args.x + (args.visibleStart - args.lineStartPos) * args.charWidth;
  return {
    barX,
    barWidth: (args.visibleEnd - args.visibleStart) * args.charWidth,
    laneY: args.y + args.lane * args.laneSpacing,
    color: args.color,
    direction: args.direction,
  };
}

export function annotationSegmentArrowFlags(args: {
  isStartOfAnnotation: boolean;
  isEndOfAnnotation: boolean;
  direction: number;
  barWidth: number;
  annotationHeight: number;
  suppressStartTear: boolean | undefined;
  suppressEndTear: boolean | undefined;
}): {
  arrowWidth: number;
  tearWidth: number;
  drawStartArrow: boolean;
  drawEndArrow: boolean;
  drawStartTear: boolean;
  drawEndTear: boolean;
} {
  const arrowWidth = Math.min(args.annotationHeight * 0.6, args.barWidth * 0.3, 8);
  const tearWidth = Math.min(args.annotationHeight * 0.5, args.barWidth * 0.2, 7);
  return {
    arrowWidth,
    tearWidth,
    drawStartArrow:
      args.isStartOfAnnotation && args.direction === -1 && args.barWidth > arrowWidth * 2,
    drawEndArrow: args.isEndOfAnnotation && args.direction === 1 && args.barWidth > arrowWidth * 2,
    drawStartTear:
      !args.isStartOfAnnotation && !args.suppressStartTear && args.barWidth > tearWidth * 2,
    drawEndTear: !args.isEndOfAnnotation && !args.suppressEndTear && args.barWidth > tearWidth * 2,
  };
}

export function buildAnnotationSegmentPath(
  ctx: Pick<SequenceDrawingContext, 'beginPath' | 'moveTo' | 'lineTo' | 'closePath'>,
  barX: number,
  laneY: number,
  barWidth: number,
  annotationHeight: number,
  flags: ReturnType<typeof annotationSegmentArrowFlags>
): void {
  const { arrowWidth, tearWidth, drawStartArrow, drawEndArrow, drawStartTear, drawEndTear } = flags;
  const midY = laneY + annotationHeight / 2;
  const quarterY = laneY + annotationHeight * 0.25;
  const threeQuarterY = laneY + annotationHeight * 0.75;
  const leftInset = drawStartArrow ? arrowWidth : drawStartTear ? tearWidth * 0.3 : 0;
  const rightInset = drawEndArrow ? arrowWidth : drawEndTear ? tearWidth * 0.3 : 0;
  ctx.beginPath();
  ctx.moveTo(barX + leftInset, laneY);
  ctx.lineTo(barX + barWidth - rightInset, laneY);
  if (drawEndArrow) {
    ctx.lineTo(barX + barWidth, midY);
  } else if (drawEndTear) {
    ctx.lineTo(barX + barWidth - tearWidth * 0.6, quarterY);
    ctx.lineTo(barX + barWidth, midY);
    ctx.lineTo(barX + barWidth - tearWidth * 0.6, threeQuarterY);
  }
  ctx.lineTo(barX + barWidth - rightInset, laneY + annotationHeight);
  ctx.lineTo(barX + leftInset, laneY + annotationHeight);
  if (drawStartArrow) {
    ctx.lineTo(barX, midY);
  } else if (drawStartTear) {
    ctx.lineTo(barX + tearWidth * 0.6, threeQuarterY);
    ctx.lineTo(barX, midY);
    ctx.lineTo(barX + tearWidth * 0.6, quarterY);
  }
  ctx.closePath();
}

export function annotationSegmentLabelBounds(
  barX: number,
  barWidth: number,
  flags: ReturnType<typeof annotationSegmentArrowFlags>
): { centerX: number; availableWidth: number } {
  const indicatorFontSize = Math.round(ANNOTATION_LABEL_FONT_SIZE * 1.4);
  const leftPadding = flags.drawStartArrow
    ? flags.arrowWidth
    : flags.drawStartTear
      ? flags.tearWidth + indicatorFontSize
      : 4;
  const rightPadding = flags.drawEndArrow
    ? flags.arrowWidth
    : flags.drawEndTear
      ? flags.tearWidth + indicatorFontSize
      : 4;
  const availableWidth = barWidth - leftPadding - rightPadding;
  return { centerX: barX + leftPadding + availableWidth / 2, availableWidth };
}

export function drawAnnotationSegment(
  ctx: SequenceDrawingContext,
  ann: Annotation & { lane?: number },
  visibleStart: number,
  visibleEnd: number,
  lineStartPos: number,
  x: number,
  y: number,
  config: WorkspaceEditorConfig,
  annotationHeight: number,
  laneSpacing: number,
  drawLabel: boolean,
  isStartOfAnnotation: boolean,
  isEndOfAnnotation: boolean,
  charIndexStart?: number,
  isChanged?: boolean,
  renderState?: 'default' | 'hovered' | 'selected',
  renderCdsAsBar?: boolean,
  segmentStyle?: AnnotationSegmentStyle
): void {
  const { charWidth } = config;
  const annotationLabelFontSize = ANNOTATION_LABEL_FONT_SIZE;
  const annotationIndicatorFontSize = Math.round(ANNOTATION_LABEL_FONT_SIZE * 1.4);

  if (visibleEnd <= visibleStart) return;

  if (
    segmentStyle &&
    drawMutedColumnAnnotationSegments(
      ctx,
      ann,
      visibleStart,
      visibleEnd,
      lineStartPos,
      x,
      y,
      config,
      annotationHeight,
      laneSpacing,
      drawLabel,
      isStartOfAnnotation,
      isEndOfAnnotation,
      charIndexStart,
      isChanged,
      renderState,
      renderCdsAsBar,
      segmentStyle
    )
  ) {
    return;
  }

  const displayColor =
    segmentStyle?.colorOverride ||
    resolveAnnotationDisplayColor(ann, {
      profile: { colorMode: config.annotationColorMode },
    });
  const color = segmentStyle?.colorIsAdapted
    ? displayColor
    : adaptColorForDark(displayColor, getCanvasTheme().isDark);
  const { barX, barWidth, laneY, direction } = annotationSegmentBarGeometry({
    x,
    y,
    charWidth,
    visibleStart,
    visibleEnd,
    lineStartPos,
    charIndexStart,
    lane: segmentStyle?.lane ?? ann.lane ?? 0,
    laneSpacing,
    color,
    direction: ann.direction,
  });

  const draftPaint = annotationDraftPaintStyle(ann, renderState);
  const {
    draftStyle,
    hasDraftOutline,
    isUncheckedDraft,
    draftSurfaceAlpha: originalSurfaceAlpha,
    effectiveRenderState,
    reviewFade,
  } = draftPaint;
  const surfaceOpacity = segmentStyle?.surfaceOpacity ?? 1;
  const draftSurfaceAlpha = originalSurfaceAlpha * surfaceOpacity;
  const renderCdsDetailShape = shouldRenderCdsDetailShape(ann, renderCdsAsBar, config);
  if (renderCdsDetailShape) {
    drawCdsAnnotationDetail({
      ctx,
      ann,
      config,
      color,
      direction,
      isUncheckedDraft,
      draftSurfaceAlpha,
      reviewFade,
      draftStyle,
      laneY,
      annotationHeight,
      barX,
      barWidth,
      isChanged,
      hasDraftOutline,
      effectiveRenderState,
      annotationLabelFontSize,
    });
    return;
  }
  const flags = annotationSegmentArrowFlags({
    isStartOfAnnotation,
    isEndOfAnnotation,
    direction,
    barWidth,
    annotationHeight,
    suppressStartTear: segmentStyle?.suppressStartTear,
    suppressEndTear: segmentStyle?.suppressEndTear,
  });
  const { arrowWidth, tearWidth, drawStartArrow, drawEndArrow, drawStartTear, drawEndTear } = flags;

  ctx.fillStyle = color;
  if (segmentStyle?.contour) {
    ctx.beginPath();
    segmentStyle.contour.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
  } else if (segmentStyle?.traceContour) {
    segmentStyle.traceContour(ctx);
  } else {
    buildAnnotationSegmentPath(ctx, barX, laneY, barWidth, annotationHeight, flags);
  }
  const midY = laneY + annotationHeight / 2;

  if (isUncheckedDraft) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.5 * surfaceOpacity;
    ctx.stroke();
    ctx.restore();
  } else {
    ctx.save();
    ctx.globalAlpha = draftSurfaceAlpha * reviewFade;
    ctx.fill();
    ctx.restore();
  }

  if (isChanged) {
    ctx.setLineDash([3, 2.5]);
    ctx.strokeStyle = getDarkenedColor(color, 60, 1.0);
    ctx.lineWidth = 1.75;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (hasDraftOutline) {
    ctx.save();
    ctx.setLineDash([...ANNOTATION_DRAFT_OUTLINE_DASH]);
    ctx.strokeStyle = getDarkenedColor(color, 30, ANNOTATION_DRAFT_OUTLINE_ALPHA);
    ctx.lineWidth = ANNOTATION_DRAFT_OUTLINE_WIDTH;
    ctx.stroke();
    ctx.restore();
  }

  paintAnnotationOutline(
    ctx,
    effectiveRenderState,
    getEmphasizedColor(
      color,
      getCanvasTheme().isDark,
      60,
      annotationOutlineStrokeSpec(effectiveRenderState)?.alpha ?? 0.95
    ),
    (c) => {
      c.stroke();
    }
  );

  ctx.fillStyle = isLightColor(color) ? 'rgba(0, 0, 0, 0.6)' : 'rgba(255, 255, 255, 0.9)';
  ctx.font = `${annotationIndicatorFontSize}px ${config.fontFamily}`;
  ctx.textBaseline = 'middle';
  const indicator = direction === -1 ? '«' : direction === 1 ? '»' : '…';

  if (drawStartTear) {
    ctx.textAlign = 'left';
    ctx.fillText(indicator, barX + tearWidth + 2, midY);
  }

  if (drawEndTear) {
    ctx.textAlign = 'right';
    ctx.fillText(indicator, barX + barWidth - tearWidth - 2, midY);
  }

  if (barWidth > 30 && drawLabel) {
    ctx.save();
    const labelColor = isUncheckedDraft
      ? color
      : isLightColor(color)
        ? getCanvasTheme().fgMuted
        : 'rgba(255, 255, 255, 0.85)';
    ctx.fillStyle = labelColor;
    if (!isUncheckedDraft) ctx.globalAlpha = draftSurfaceAlpha * reviewFade;
    ctx.font = `500 ${annotationLabelFontSize}px ${config.labelFontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const { centerX, availableWidth } =
      segmentStyle?.labelBounds ??
      annotationSegmentLabelBounds(barX, barWidth, {
        arrowWidth,
        tearWidth,
        drawStartArrow,
        drawEndArrow,
        drawStartTear,
        drawEndTear,
      });

    if (availableWidth <= 0) {
      ctx.restore();
      return;
    }

    const label = fitCanvasLabel(ctx, segmentStyle?.labelText ?? ann.name, availableWidth);
    if (!label) {
      ctx.restore();
      return;
    }

    ctx.fillText(label, centerX, laneY + annotationHeight / 2);
    ctx.restore();
  }
}

export function drawAnnotations(
  ctx: SequenceDrawingContext,
  annotations: Array<Annotation & { lane: number }>,
  lineStartPos: number,
  lineEndPos: number,
  x: number,
  y: number,
  laneCount: number,
  config: WorkspaceEditorConfig,
  sequenceLength?: number,
  changedAnnotationNames?: Set<string>,
  annotationRenderStateInput?: import('./annotation-render-state').AnnotationRenderStateInput,
  renderCdsAsBar?: boolean,
  mutedColumns?: ReadonlySet<number>,
  mutedColumnColor?: string,
  intronOptions?: {
    aminoAcidIntronOwners?: readonly AminoAcidIntronOwner[];
    onIntronConnector?: (stroke: IntronConnectorStroke) => void;
  }
): number {
  const annotationHeight = ANNOTATION_BAR_HEIGHT;
  const laneSpacing = annotationHeight + ANNOTATION_CANVAS_CONSTANTS.LANE_SPACING;
  const annotationLabelFontSize = ANNOTATION_LABEL_FONT_SIZE;

  const lineIsOriginSpanning = lineSpansOrigin(lineStartPos, lineEndPos);

  annotations.forEach((ann) => {
    const annStart = ann.start - 1;
    const annEnd = ann.end;
    const annotationSpansOrigin = ann.start > ann.end;
    const isChanged = changedAnnotationNames?.has(ann.name) ?? false;
    const annRenderState = annotationRenderState(ann, annotationRenderStateInput);

    const isPromoter =
      ann.type === 'promoter' ||
      (ann.type === 'regulatory' && ann.qualifiers?.regulatory_class?.includes('promoter'));
    if (ann.segments && ann.segments.length > 1 && !isPromoter) {
      const color = adaptColorForDark(
        resolveAnnotationDisplayColor(ann, {
          profile: { colorMode: config.annotationColorMode },
        }),
        getCanvasTheme().isDark
      );
      const laneY = y + ann.lane * laneSpacing;
      const draft = resolveAnnotationDraftStyle(ann);
      paintTranscriptGlyph({
        ctx,
        annotation: ann,
        lineStart: lineStartPos,
        lineEnd: lineEndPos,
        sequenceLength: sequenceLength ?? Math.max(ann.start, ann.end, lineStartPos, lineEndPos),
        x,
        y: laneY,
        charWidth: config.charWidth,
        height: annotationHeight,
        color,
        alpha: draft.fillAlpha,
        outlineOnly: draft.isHollow,
        ...intronOptions,
      });
      const glyph = (c: SequenceDrawingContext, outlineColor: string) =>
        paintTranscriptGlyph({
          ctx: c,
          annotation: ann,
          lineStart: lineStartPos,
          lineEnd: lineEndPos,
          sequenceLength: sequenceLength ?? Math.max(ann.start, ann.end, lineStartPos, lineEndPos),
          x,
          y: laneY,
          charWidth: config.charWidth,
          height: annotationHeight,
          color: outlineColor,
          alpha: c.globalAlpha,
          outlineOnly: true,
          lineWidth: c.lineWidth,
          dash: c.getLineDash(),
          ...intronOptions,
        });
      paintAnnotationOutline(
        ctx,
        draft.suppressInteractionOutline ? 'default' : annRenderState,
        getEmphasizedColor(color, getCanvasTheme().isDark),
        (c) => glyph(c, String(c.strokeStyle))
      );
      if (draft.hasDottedOutline) {
        ctx.save();
        ctx.globalAlpha = ANNOTATION_DRAFT_OUTLINE_ALPHA;
        ctx.lineWidth = ANNOTATION_DRAFT_OUTLINE_WIDTH;
        ctx.setLineDash([...ANNOTATION_DRAFT_OUTLINE_DASH]);
        glyph(ctx, color);
        ctx.restore();
      }
      const visibleExons = ann.segments.flatMap((seg) =>
        getVisibleRangeSegments(
          seg.start - 1,
          seg.end,
          lineStartPos,
          lineEndPos,
          sequenceLength ?? Math.max(ann.start, ann.end, lineStartPos, lineEndPos)
        )
      );
      const labelSeg = visibleExons.reduce<(typeof visibleExons)[number] | null>(
        (best, seg) => (!best || seg.end - seg.start > best.end - best.start ? seg : best),
        null
      );
      if (labelSeg) {
        const width = (labelSeg.end - labelSeg.start) * config.charWidth;
        if (width > 30) {
          ctx.save();
          ctx.font = `500 ${annotationLabelFontSize}px ${config.labelFontFamily}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = isLightColor(color) ? getCanvasTheme().fgMuted : 'rgba(255,255,255,0.85)';
          const text = fitCanvasLabel(ctx, ann.name, width - 8);
          if (text)
            ctx.fillText(
              text,
              x + labelSeg.charIndexStart * config.charWidth + width / 2,
              laneY + annotationHeight / 2
            );
          ctx.restore();
        }
      }
      return;
    }

    if (annotationSpansOrigin && sequenceLength !== undefined) {
      const seg1Segments = getVisibleRangeSegments(
        annStart,
        sequenceLength,
        lineStartPos,
        lineEndPos,
        sequenceLength
      );
      const seg2Segments = getVisibleRangeSegments(
        0,
        annEnd,
        lineStartPos,
        lineEndPos,
        sequenceLength
      );

      const allSegments = [
        ...seg1Segments.map((seg) => ({ ...seg, isSeg1: true })),
        ...seg2Segments.map((seg) => ({ ...seg, isSeg1: false })),
      ];

      if (allSegments.length === 0) return;

      let minCharIndex = Infinity;
      let maxCharIndex = -Infinity;
      allSegments.forEach((seg) => {
        const segWidth = seg.end - seg.start;
        minCharIndex = Math.min(minCharIndex, seg.charIndexStart);
        maxCharIndex = Math.max(maxCharIndex, seg.charIndexStart + segWidth);
      });

      const combinedCenterCharIndex = (minCharIndex + maxCharIndex) / 2;

      allSegments.forEach((seg) => {
        drawAnnotationSegment(
          ctx,
          ann,
          seg.start,
          seg.end,
          0,
          x,
          y,
          config,
          annotationHeight,
          laneSpacing,
          false,
          seg.isSeg1 ? seg.start === annStart : false,
          seg.isSeg1 ? false : seg.end === annEnd,
          seg.charIndexStart,
          isChanged,
          annRenderState as 'default' | 'hovered' | 'selected',
          renderCdsAsBar,
          { mutedColumns, mutedColumnColor, sequenceLength }
        );
      });

      const combinedWidth = maxCharIndex - minCharIndex;
      if (combinedWidth > 30 / config.charWidth) {
        const laneY = y + ann.lane * laneSpacing;
        const centerX = x + combinedCenterCharIndex * config.charWidth;

        ctx.font = `500 ${annotationLabelFontSize}px ${config.labelFontFamily}`;
        const wrapColor = adaptColorForDark(
          resolveAnnotationDisplayColor(ann, {
            profile: { colorMode: config.annotationColorMode },
          }),
          getCanvasTheme().isDark
        );
        ctx.fillStyle = isLightColor(wrapColor)
          ? getCanvasTheme().fgMuted
          : 'rgba(255, 255, 255, 0.85)';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';

        const availableWidth = combinedWidth * config.charWidth - 8;
        const label = fitCanvasLabel(ctx, ann.name, availableWidth);
        if (label) {
          ctx.fillText(label, centerX, laneY + annotationHeight / 2);
        }
      }
    } else if (lineIsOriginSpanning && sequenceLength !== undefined) {
      const segments = getVisibleRangeSegments(
        annStart,
        annEnd,
        lineStartPos,
        lineEndPos,
        sequenceLength
      );

      let largestSegmentIndex = -1;
      let largestWidth = 0;
      segments.forEach((seg, idx) => {
        const width = seg.end - seg.start;
        if (width > largestWidth) {
          largestWidth = width;
          largestSegmentIndex = idx;
        }
      });

      segments.forEach((seg, idx) => {
        const shouldDrawLabel = idx === largestSegmentIndex;
        drawAnnotationSegment(
          ctx,
          ann,
          seg.start,
          seg.end,
          0,
          x,
          y,
          config,
          annotationHeight,
          laneSpacing,
          shouldDrawLabel,
          seg.start === annStart,
          seg.end === annEnd,
          seg.charIndexStart,
          isChanged,
          annRenderState as 'default' | 'hovered' | 'selected',
          renderCdsAsBar,
          { mutedColumns, mutedColumnColor, sequenceLength }
        );
      });
    } else {
      const visibleStart = Math.max(annStart, lineStartPos);
      const visibleEnd = Math.min(annEnd, lineEndPos);

      if (visibleEnd > visibleStart) {
        drawAnnotationSegment(
          ctx,
          ann,
          visibleStart,
          visibleEnd,
          lineStartPos,
          x,
          y,
          config,
          annotationHeight,
          laneSpacing,
          true,
          visibleStart === annStart,
          visibleEnd === annEnd,
          undefined,
          isChanged,
          annRenderState as 'default' | 'hovered' | 'selected',
          renderCdsAsBar,
          { mutedColumns, mutedColumnColor, sequenceLength }
        );
      }
    }
  });

  return y + laneCount * laneSpacing;
}

export function drawCursor(
  ctx: SequenceDrawingContext,
  cursorPos: number,
  lineStartPos: number,
  lineEndPos: number,
  x: number,
  y: number,
  config: WorkspaceEditorConfig,
  opacity: number = 1
): void {
  if (cursorPos < lineStartPos || cursorPos > lineEndPos) return;

  const cursorX = x + (cursorPos - lineStartPos) * config.charWidth;

  const cursorTheme = getCanvasTheme();
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.fillStyle = cursorTheme.accent;
  ctx.fillRect(cursorX - 1, y + 2, 2, config.rowHeight - 4);
  ctx.restore();
}

export function drawEditSelectionColumns(
  ctx: SequenceDrawingContext,
  selection: Selection,
  lineStartPos: number,
  lineEndPos: number,
  x: number,
  rowTop: number,
  rowBottom: number,
  config: WorkspaceEditorConfig,
  sequenceLength: number
): void {
  const theme = getCanvasTheme();
  ctx.fillStyle = theme.isDark ? 'rgba(180, 160, 50, 0.25)' : 'rgb(255, 255, 200)';

  const rowHeight = rowBottom - rowTop;
  const isWrapping = selection.wraps && sequenceLength > 0;

  const fillSegment = (segStart: number, segEnd: number) => {
    const segments = getVisibleRangeSegments(
      segStart,
      segEnd + 1,
      lineStartPos,
      lineEndPos,
      sequenceLength
    );
    for (const seg of segments) {
      const columnX = x + seg.charIndexStart * config.charWidth;
      const columnWidth = (seg.end - seg.start) * config.charWidth;
      ctx.fillRect(columnX, rowTop, columnWidth, rowHeight);
    }
  };

  if (isWrapping) {
    fillSegment(selection.start, sequenceLength - 1);
    fillSegment(0, selection.end);
  } else {
    const selStart = Math.min(selection.start, selection.end);
    const selEnd = Math.max(selection.start, selection.end);
    fillSegment(selStart, selEnd);
  }
}

function drawRangeHighlight(
  ctx: SequenceDrawingContext,
  ranges: Array<{ start: number; end: number }>,
  lineStartPos: number,
  lineEndPos: number,
  x: number,
  y: number,
  config: WorkspaceEditorConfig,
  sequenceLength: number,
  fillColor: string,
  strikethrough?: { color: string; width: number }
): void {
  for (const range of ranges) {
    if (lineSpansOrigin(lineStartPos, lineEndPos)) {
      const segments = getVisibleRangeSegments(
        range.start,
        range.end,
        lineStartPos,
        lineEndPos,
        sequenceLength
      );
      for (const seg of segments) {
        const hx = x + seg.charIndexStart * config.charWidth;
        const hw = (seg.end - seg.start) * config.charWidth;
        ctx.fillStyle = fillColor;
        ctx.fillRect(hx, y, hw, config.rowHeight);
        if (strikethrough) {
          ctx.strokeStyle = strikethrough.color;
          ctx.lineWidth = strikethrough.width;
          ctx.beginPath();
          ctx.moveTo(hx, y + config.rowHeight / 2);
          ctx.lineTo(hx + hw, y + config.rowHeight / 2);
          ctx.stroke();
        }
      }
    } else {
      if (range.end <= lineStartPos || range.start >= lineEndPos) continue;
      const visibleStart = Math.max(range.start, lineStartPos);
      const visibleEnd = Math.min(range.end, lineEndPos);
      const hx = x + (visibleStart - lineStartPos) * config.charWidth;
      const hw = (visibleEnd - visibleStart) * config.charWidth;
      ctx.fillStyle = fillColor;
      ctx.fillRect(hx, y, hw, config.rowHeight);
      if (strikethrough) {
        ctx.strokeStyle = strikethrough.color;
        ctx.lineWidth = strikethrough.width;
        ctx.beginPath();
        ctx.moveTo(hx, y + config.rowHeight / 2);
        ctx.lineTo(hx + hw, y + config.rowHeight / 2);
        ctx.stroke();
      }
    }
  }
}

export function drawInsertionHighlight(
  ctx: SequenceDrawingContext,
  insertedRanges: InsertedRange[],
  lineStartPos: number,
  lineEndPos: number,
  x: number,
  y: number,
  config: WorkspaceEditorConfig,
  sequenceLength: number
): void {
  drawRangeHighlight(
    ctx,
    insertedRanges,
    lineStartPos,
    lineEndPos,
    x,
    y,
    config,
    sequenceLength,
    'rgba(76, 175, 80, 0.3)'
  );
}

export function drawDeletionHighlight(
  ctx: SequenceDrawingContext,
  deletedRanges: DeletedRange[],
  lineStartPos: number,
  lineEndPos: number,
  x: number,
  y: number,
  config: WorkspaceEditorConfig,
  sequenceLength: number
): void {
  drawRangeHighlight(
    ctx,
    deletedRanges,
    lineStartPos,
    lineEndPos,
    x,
    y,
    config,
    sequenceLength,
    'rgba(244, 67, 54, 0.2)',
    { color: 'rgba(244, 67, 54, 0.8)', width: 1.5 }
  );
}

export function drawRowBackgrounds(
  ctx: SequenceDrawingContext,
  linePositions: LinePositions[],
  canvasWidth: number,
  backgroundOffset = 0
): void {
  const theme = getCanvasTheme();
  for (const lp of linePositions) {
    const { y: rowTop, height: rowHeight } = rowBackgroundBounds(lp);
    const isOddRow = Math.abs((lp.line.lineIndex + backgroundOffset) % 2) === 1;
    if (isOddRow && !theme.isDark) {
      ctx.fillStyle = theme.bgSubtle;
    } else {
      ctx.fillStyle = theme.bg;
    }
    ctx.fillRect(0, rowTop, canvasWidth, rowHeight);
    if (isOddRow && theme.isDark) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.035)';
      ctx.fillRect(0, rowTop, canvasWidth, rowHeight);
    }
  }
}

export function drawHighlightedRangeColumns(
  ctx: SequenceDrawingContext,
  linePositions: LinePositions[],
  highlightedRange: Selection,
  x: number,
  config: WorkspaceEditorConfig,
  sequenceLength: number
): void {
  ctx.save();
  const theme = getCanvasTheme();
  ctx.fillStyle = theme.isDark ? 'rgba(180, 160, 50, 0.25)' : 'rgb(255, 255, 200)';

  const isWrapping = highlightedRange.wraps && sequenceLength > 0;

  const drawHighlightSegment = (
    segStart: number,
    segEnd: number,
    lp: LinePositions,
    nextLp: LinePositions | undefined
  ) => {
    const { line } = lp;
    const isOriginSpanningLine = lineSpansOrigin(line.startPos, line.endPos);

    if (isOriginSpanningLine && sequenceLength > 0) {
      const segments = getVisibleRangeSegments(
        segStart,
        segEnd + 1,
        line.startPos,
        line.endPos,
        sequenceLength
      );
      for (const seg of segments) {
        const columnX = x + seg.charIndexStart * config.charWidth;
        const rowTop = lp.annotationY - ROW_TOP_PADDING;
        const rowBottom = nextLp
          ? nextLp.annotationY - ROW_TOP_PADDING
          : lp.lineEndY + ROW_BOTTOM_PADDING;
        const columnCount = seg.end - seg.start;
        ctx.fillRect(columnX, rowTop, columnCount * config.charWidth, rowBottom - rowTop);
      }
    } else {
      if (segEnd >= line.startPos && segStart < line.endPos) {
        const visibleStart = Math.max(segStart, line.startPos);
        const visibleEnd = Math.min(segEnd + 1, line.endPos);
        const startPosInLine = visibleStart - line.startPos;
        const columnCount = visibleEnd - visibleStart;

        const columnX = x + startPosInLine * config.charWidth;
        const rowTop = lp.annotationY - ROW_TOP_PADDING;
        const rowBottom = nextLp
          ? nextLp.annotationY - ROW_TOP_PADDING
          : lp.lineEndY + ROW_BOTTOM_PADDING;
        ctx.fillRect(columnX, rowTop, columnCount * config.charWidth, rowBottom - rowTop);
      }
    }
  };

  for (let i = 0; i < linePositions.length; i++) {
    const lp = linePositions[i];
    const nextLp = linePositions[i + 1];

    if (isWrapping) {
      drawHighlightSegment(highlightedRange.start, sequenceLength - 1, lp, nextLp);
      drawHighlightSegment(0, highlightedRange.end, lp, nextLp);
    } else {
      const hlStart = Math.min(highlightedRange.start, highlightedRange.end);
      const hlEnd = Math.max(highlightedRange.start, highlightedRange.end);
      drawHighlightSegment(hlStart, hlEnd, lp, nextLp);
    }
  }
  ctx.restore();
}

export function drawSearchHighlights(
  ctx: SequenceDrawingContext,
  linePositions: LinePositions[],
  matches: SearchMatch[],
  activeIndex: number,
  x: number,
  config: WorkspaceEditorConfig,
  sequenceLength: number
): void {
  if (matches.length === 0) return;
  ctx.save();

  const theme = getCanvasTheme();

  const inactiveColor = theme.isDark ? 'hsla(35, 85%, 52%, 0.10)' : 'hsla(35, 85%, 52%, 0.12)';

  for (let mi = 0; mi < matches.length; mi++) {
    if (mi === activeIndex) continue;

    const match = matches[mi];

    ctx.fillStyle = inactiveColor;

    const isWrapping = match.wraps && sequenceLength > 0;
    const hlStart = isWrapping ? match.start : Math.min(match.start, match.end);
    const hlEnd = isWrapping ? match.end : Math.max(match.start, match.end);

    for (let i = 0; i < linePositions.length; i++) {
      const lp = linePositions[i];
      const nextLp = linePositions[i + 1];
      const { line } = lp;

      const isOriginLine = line.preOriginLength !== undefined;

      const drawRect = (posInLine: number, cols: number) => {
        const columnX = x + posInLine * config.charWidth;
        const rowTop = lp.annotationY - ROW_TOP_PADDING;
        const rowBottom = nextLp
          ? nextLp.annotationY - ROW_TOP_PADDING
          : lp.lineEndY + ROW_BOTTOM_PADDING;
        ctx.fillRect(columnX, rowTop, cols * config.charWidth, rowBottom - rowTop);
      };

      const drawSegment = (segStart: number, segEnd: number) => {
        if (isOriginLine) {
          if (segEnd >= line.startPos && segStart < sequenceLength) {
            const vs = Math.max(segStart, line.startPos);
            const ve = Math.min(segEnd + 1, sequenceLength);
            drawRect(vs - line.startPos, ve - vs);
          }
          if (segEnd >= 0 && segStart < line.endPos) {
            const vs = Math.max(segStart, 0);
            const ve = Math.min(segEnd + 1, line.endPos);
            drawRect(line.preOriginLength! + vs, ve - vs);
          }
        } else if (segEnd >= line.startPos && segStart < line.endPos) {
          const visibleStart = Math.max(segStart, line.startPos);
          const visibleEnd = Math.min(segEnd + 1, line.endPos);
          drawRect(visibleStart - line.startPos, visibleEnd - visibleStart);
        }
      };

      if (isWrapping) {
        drawSegment(hlStart, sequenceLength - 1);
        drawSegment(0, hlEnd);
      } else {
        drawSegment(hlStart, hlEnd);
      }
    }
  }
  ctx.restore();
}

export function drawHoveredCodonHighlight(
  ctx: SequenceDrawingContext,
  linePositions: LinePositions[],
  hoveredCodon: { start: number; end: number; strand: 1 | -1 },
  x: number,
  config: WorkspaceEditorConfig,
  sequenceLength: number,
  isCircular: boolean
): void {
  ctx.save();
  ctx.fillStyle = 'rgba(140, 140, 140, 0.25)';

  for (const lp of linePositions) {
    const { line } = lp;

    const isOriginSpanningCodon =
      isCircular && sequenceLength > 0 && hoveredCodon.start > hoveredCodon.end;

    const isOriginSpanningLine = line.preOriginLength !== undefined;

    let lineOverlaps = false;
    if (isOriginSpanningCodon) {
      lineOverlaps =
        line.endPos > hoveredCodon.start ||
        line.startPos >= hoveredCodon.start ||
        line.startPos <= hoveredCodon.end;
    } else if (isOriginSpanningLine) {
      const inFirstSegment = hoveredCodon.end >= line.startPos;
      const inSecondSegment = hoveredCodon.start < line.endPos;
      lineOverlaps = inFirstSegment || inSecondSegment;
    } else {
      lineOverlaps = line.endPos > hoveredCodon.start && line.startPos <= hoveredCodon.end;
    }

    if (lineOverlaps) {
      let visibleStart: number;
      let visibleEnd: number;

      if (isOriginSpanningCodon) {
        if (line.startPos >= hoveredCodon.start) {
          visibleStart = Math.max(hoveredCodon.start, line.startPos);
          visibleEnd = Math.min(sequenceLength - 1, line.endPos - 1);
        } else {
          visibleStart = Math.max(0, line.startPos);
          visibleEnd = Math.min(hoveredCodon.end, line.endPos - 1);
        }
      } else if (isOriginSpanningLine) {
        if (hoveredCodon.start >= line.startPos) {
          visibleStart = Math.max(hoveredCodon.start, line.startPos);
          visibleEnd = Math.min(hoveredCodon.end, sequenceLength - 1);
        } else {
          visibleStart = Math.max(hoveredCodon.start, 0);
          visibleEnd = Math.min(hoveredCodon.end, line.endPos - 1);
        }
      } else {
        visibleStart = Math.max(hoveredCodon.start, line.startPos);
        visibleEnd = Math.min(hoveredCodon.end, line.endPos - 1);
      }

      let startPosInLine: number;
      let endPosInLine: number;

      if (isOriginSpanningLine && line.preOriginLength !== undefined) {
        if (visibleStart >= line.startPos) {
          startPosInLine = visibleStart - line.startPos;
        } else {
          startPosInLine = line.preOriginLength + visibleStart;
        }

        if (visibleEnd >= line.startPos) {
          endPosInLine = visibleEnd - line.startPos;
        } else {
          endPosInLine = line.preOriginLength + visibleEnd;
        }
      } else {
        startPosInLine = visibleStart - line.startPos;
        endPosInLine = visibleEnd - line.startPos;
      }

      const columnX = x + startPosInLine * config.charWidth;
      const columnCount = endPosInLine - startPosInLine + 1;

      const strandTop =
        hoveredCodon.strand === -1 && config.showReverseComplement ? lp.complementY : lp.sequenceY;
      const strandHeight = config.rowHeight;

      ctx.fillRect(columnX, strandTop, columnCount * config.charWidth, strandHeight);
    }
  }
  ctx.restore();
}

export function drawViewCursor(
  ctx: SequenceDrawingContext,
  linePositions: LinePositions[],
  viewCursor: number,
  x: number,
  config: WorkspaceEditorConfig
): void {
  for (let i = 0; i < linePositions.length; i++) {
    const lp = linePositions[i];
    const nextLp = linePositions[i + 1];
    const { line } = lp;

    if (viewCursor >= line.startPos && viewCursor <= line.endPos) {
      const posInLine = viewCursor - line.startPos;
      const cursorX = x + posInLine * config.charWidth;
      const rowTop = lp.annotationY - ROW_TOP_PADDING;
      const rowBottom = nextLp
        ? nextLp.annotationY - ROW_TOP_PADDING
        : lp.lineEndY + ROW_BOTTOM_PADDING;
      drawViewCursorLine(ctx, cursorX, rowTop, rowBottom);
    }
  }
}

export interface ShiftPreviewLineInfo {
  startPos: number;
  endPos: number;
  annotationY: number;
  sequenceY: number;
  complementY: number;
  lineEndY: number;
}

export function drawShiftPreview(
  ctx: SequenceDrawingContext,
  lineInfos: ShiftPreviewLineInfo[],
  shiftPreview: {
    hoverPosition: number;
    anchorPosition: number;
    isOptionHeld: boolean;
  },
  x: number,
  config: WorkspaceEditorConfig,
  _sequenceLength: number
): void {
  const { hoverPosition, isOptionHeld } = shiftPreview;
  const PREVIEW_LENGTH = 20;

  ctx.save();

  for (let i = 0; i < lineInfos.length; i++) {
    const lineInfo = lineInfos[i];
    const nextLineInfo = lineInfos[i + 1];

    if (hoverPosition >= lineInfo.startPos && hoverPosition <= lineInfo.endPos) {
      const cursorX = x + (hoverPosition - lineInfo.startPos) * config.charWidth;
      const rowTop = lineInfo.annotationY - ROW_TOP_PADDING;
      const rowBottom = nextLineInfo
        ? nextLineInfo.annotationY - ROW_TOP_PADDING
        : lineInfo.lineEndY + ROW_BOTTOM_PADDING;
      const rowHeight = rowBottom - rowTop;
      const arrowY =
        (lineInfo.sequenceY +
          (config.showReverseComplement
            ? lineInfo.complementY + config.rowHeight
            : lineInfo.sequenceY + config.rowHeight)) /
        2;

      const fromLeft = !isOptionHeld;

      let highlightStartX: number;
      let highlightEndX: number;
      const lineStartX = x;
      const lineEndX = x + (lineInfo.endPos - lineInfo.startPos) * config.charWidth;

      if (fromLeft) {
        highlightEndX = cursorX + config.charWidth;
        highlightStartX = Math.max(
          cursorX - PREVIEW_LENGTH * config.charWidth + config.charWidth,
          lineStartX
        );
      } else {
        highlightStartX = cursorX;
        highlightEndX = Math.min(cursorX + (PREVIEW_LENGTH + 1) * config.charWidth, lineEndX);
      }

      const highlightWidth = highlightEndX - highlightStartX;

      const gradient = ctx.createLinearGradient(
        fromLeft ? highlightStartX : highlightEndX,
        0,
        fromLeft ? highlightEndX : highlightStartX,
        0
      );
      if (getCanvasTheme().isDark) {
        gradient.addColorStop(0, 'rgba(180, 160, 50, 0.02)');
        gradient.addColorStop(1, 'rgba(180, 160, 50, 0.25)');
      } else {
        gradient.addColorStop(0, 'rgba(255, 235, 59, 0.05)');
        gradient.addColorStop(1, 'rgba(255, 235, 59, 0.4)');
      }

      ctx.fillStyle = gradient;
      ctx.fillRect(highlightStartX, rowTop, highlightWidth, rowHeight);

      const arrowSize = 10;
      const arrowOffset = 15;

      ctx.fillStyle = 'rgba(255, 152, 0, 0.9)';
      ctx.beginPath();

      if (fromLeft) {
        const arrowTipX = cursorX - arrowOffset;
        ctx.moveTo(arrowTipX - arrowSize, arrowY - arrowSize / 2);
        ctx.lineTo(arrowTipX, arrowY);
        ctx.lineTo(arrowTipX - arrowSize, arrowY + arrowSize / 2);
      } else {
        const arrowTipX = cursorX + arrowOffset;
        ctx.moveTo(arrowTipX + arrowSize, arrowY - arrowSize / 2);
        ctx.lineTo(arrowTipX, arrowY);
        ctx.lineTo(arrowTipX + arrowSize, arrowY + arrowSize / 2);
      }

      ctx.closePath();
      ctx.fill();

      break;
    }
  }

  ctx.restore();
}

export function drawLineNumbers(
  ctx: SequenceDrawingContext,
  linePositions: LinePositions[],
  config: WorkspaceEditorConfig
): void {
  const lineNumberFontSize = 9;
  ctx.fillStyle = getCanvasTheme().fgMuted;
  ctx.font = `${lineNumberFontSize}px ${config.fontFamily}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const { line, sequenceY, complementY } of linePositions) {
    const labelX = config.marginLeft - 8;
    const labelY = config.showReverseComplement
      ? (sequenceY + complementY + config.rowHeight) / 2
      : sequenceY + config.rowHeight / 2;
    ctx.save();
    ctx.translate(labelX, labelY);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(String(line.startPos + 1), 0, 0);
    ctx.restore();
  }
}

export function drawHighlightHandles(
  ctx: SequenceDrawingContext,
  linePositions: LinePositions[],
  highlightedRange: Selection,
  x: number,
  config: WorkspaceEditorConfig,
  sequenceLength: number,
  canvasHeight: number
): void {
  const isWrapping = highlightedRange.wraps && sequenceLength > 0;
  const hlStart = isWrapping
    ? highlightedRange.start
    : Math.min(highlightedRange.start, highlightedRange.end);
  const hlEnd = isWrapping
    ? highlightedRange.end
    : Math.max(highlightedRange.start, highlightedRange.end);

  const findVisibleLineWithIndex = (pos: number): { lp: LinePositions; index: number } | null => {
    const matchIndices: number[] = [];
    linePositions.forEach((lp, idx) => {
      const { startPos, endPos } = lp.line;
      if (startPos > endPos) {
        if (pos >= startPos || pos < endPos) matchIndices.push(idx);
      } else {
        if (pos >= startPos && pos < endPos) matchIndices.push(idx);
      }
    });
    if (matchIndices.length === 0) return null;
    const visibleIdx = matchIndices.find(
      (idx) =>
        linePositions[idx].annotationY >= -50 && linePositions[idx].annotationY < canvasHeight + 50
    );
    const idx = visibleIdx ?? matchIndices[0];
    return { lp: linePositions[idx], index: idx };
  };

  const getPosInLine = (pos: number, line: LinePositions['line']) => {
    const { startPos, endPos } = line;
    if (startPos > endPos) {
      if (pos >= startPos) {
        return pos - startPos;
      } else {
        const preOriginLength = sequenceLength - startPos;
        return preOriginLength + pos;
      }
    }
    return pos - startPos;
  };

  const startResult = findVisibleLineWithIndex(hlStart);
  if (startResult) {
    const { lp: startLine, index: startIdx } = startResult;
    const nextLp = linePositions[startIdx + 1];
    const posInLine = getPosInLine(hlStart, startLine.line);
    const handleX = x + posInLine * config.charWidth;
    const rowTop = startLine.annotationY - ROW_TOP_PADDING;
    const rowBottom = nextLp
      ? nextLp.annotationY - ROW_TOP_PADDING
      : startLine.lineEndY + ROW_BOTTOM_PADDING;
    drawSelectionHandleBar(ctx, handleX, rowTop, rowBottom);
  }

  const endResult = findVisibleLineWithIndex(hlEnd);
  if (endResult) {
    const { lp: endLine, index: endIdx } = endResult;
    const nextLp = linePositions[endIdx + 1];
    const posInLine = getPosInLine(hlEnd, endLine.line) + 1;
    const handleX = x + posInLine * config.charWidth;
    const rowTop = endLine.annotationY - ROW_TOP_PADDING;
    const rowBottom = nextLp
      ? nextLp.annotationY - ROW_TOP_PADDING
      : endLine.lineEndY + ROW_BOTTOM_PADDING;
    drawSelectionHandleBar(ctx, handleX, rowTop, rowBottom);
  }
}

export function drawOriginIndicator(
  ctx: SequenceDrawingContext,
  lp: LinePositions,
  x: number,
  config: WorkspaceEditorConfig
): void {
  if (lp.line.originPosition === undefined) return;

  const originX = x + lp.line.originPosition * config.charWidth;
  const lineTop = lp.annotationY - ROW_TOP_PADDING;
  const lineBottom = lp.rulerY + 14;

  const strandCenterY = config.showReverseComplement
    ? (lp.sequenceY + config.rowHeight + lp.complementY) / 2
    : lp.sequenceY + config.rowHeight / 2;

  ctx.save();
  const originColor = 'rgba(255, 152, 0, 0.9)';
  ctx.strokeStyle = originColor;
  ctx.lineWidth = 2;

  ctx.beginPath();
  ctx.moveTo(originX, lineTop);
  ctx.lineTo(originX, lineBottom);
  ctx.stroke();

  const arrowLength = config.charWidth * 2.5;
  const arrowStartX = originX - arrowLength / 2;
  ctx.beginPath();
  ctx.moveTo(arrowStartX, strandCenterY);
  ctx.lineTo(originX, strandCenterY);
  ctx.stroke();

  const caretSize = 6;
  ctx.beginPath();
  ctx.moveTo(originX, strandCenterY - caretSize);
  ctx.lineTo(originX + caretSize, strandCenterY);
  ctx.lineTo(originX, strandCenterY + caretSize);
  ctx.stroke();

  ctx.restore();

  const rulerHeight = 14;
  const rulerCenterY = lp.rulerY + rulerHeight / 2;

  ctx.save();
  ctx.fillStyle = 'rgba(255, 152, 0, 0.9)';
  const circleRadius = 8;

  ctx.beginPath();
  ctx.arc(originX, rulerCenterY, circleRadius, 0, Math.PI * 2);
  ctx.fill();

  const originLabelFontSize = Math.round(config.fontSize * 0.82);
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${originLabelFontSize}px ${config.fontFamily}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('1', originX, rulerCenterY);
  ctx.restore();
}
