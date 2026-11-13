import type { SequenceDrawingContext } from './rendering/drawing-context';
import type {
  JunctionIndicator,
  RenderedGGProductLabel,
  WorkspaceEditorConfig,
  LinePositions,
} from './types';
import { GOLDEN_GATE_JUNCTION_VISUAL, type ColoredCutSite } from '@waypoint/sequence-utils';
import { getCanvasTheme } from './canvas-theme';
import { lineSpansOrigin, getVisibleRangeSegments, rangeOverlapsLine } from './utils/range-utils';
import { ROW_TOP_PADDING } from './layout-constants';
import {
  RECOGNITION_HIGHLIGHT_FILL as RECOGNITION_FILL,
  INTERNAL_RECOGNITION_HIGHLIGHT_FILL as INTERNAL_RECOGNITION_FILL,
} from './restriction-enzymes/cut-site-styling';

export function drawRecognitionHighlights(
  ctx: SequenceDrawingContext,
  linePositions: LinePositions[],
  cutSites: ColoredCutSite[],
  x: number,
  config: WorkspaceEditorConfig
): void {
  if (cutSites.length === 0) return;

  for (const site of cutSites) {
    const { recognitionStart, recognitionEnd } = site;
    ctx.fillStyle = site.isInternalCutSite ? INTERNAL_RECOGNITION_FILL : RECOGNITION_FILL;
    for (const { line, sequenceY, complementY } of linePositions) {
      if (recognitionEnd > line.startPos && recognitionStart < line.endPos) {
        const highlightStart = Math.max(0, recognitionStart - line.startPos);
        const highlightEnd = Math.min(line.sequence.length, recognitionEnd - line.startPos);
        const highlightX = x + highlightStart * config.charWidth;
        const highlightWidth = (highlightEnd - highlightStart) * config.charWidth;
        ctx.fillRect(highlightX, sequenceY, highlightWidth, config.rowHeight);
        if (config.showReverseComplement) {
          ctx.fillRect(highlightX, complementY, highlightWidth, config.rowHeight);
        }
      }
    }
  }
}

export function drawJunctionIndicators(
  ctx: SequenceDrawingContext,
  linePositions: LinePositions[],
  x: number,
  config: WorkspaceEditorConfig,
  junctionIndicators: JunctionIndicator[]
): void {
  if (!junctionIndicators || junctionIndicators.length === 0) return;

  const lineWidth = 3;

  for (const { line, annotationY, rulerY } of linePositions) {
    const rowTop = annotationY - ROW_TOP_PADDING;
    const rowBottom = rulerY + 14;

    for (const junction of junctionIndicators) {
      const isOriginLine = lineSpansOrigin(line.startPos, line.endPos);

      let charIndex: number | null = null;

      if (isOriginLine && line.originPosition !== undefined) {
        const sequenceLength = line.startPos + line.originPosition;
        if (junction.position >= line.startPos && junction.position < sequenceLength) {
          charIndex = junction.position - line.startPos;
        } else if (junction.position >= 0 && junction.position < line.endPos) {
          charIndex = line.originPosition + junction.position;
        }
      } else {
        if (junction.position >= line.startPos && junction.position <= line.endPos) {
          charIndex = junction.position - line.startPos;
        }
      }

      if (charIndex !== null) {
        const junctionX = x + charIndex * config.charWidth;
        ctx.lineWidth = lineWidth;

        if (junction.leftColor) {
          ctx.strokeStyle = junction.leftColor;
          ctx.beginPath();
          ctx.moveTo(junctionX - lineWidth / 2, rowTop);
          ctx.lineTo(junctionX - lineWidth / 2, rowBottom);
          ctx.stroke();
        }

        if (junction.rightColor) {
          ctx.strokeStyle = junction.rightColor;
          ctx.beginPath();
          ctx.moveTo(junctionX + lineWidth / 2, rowTop);
          ctx.lineTo(junctionX + lineWidth / 2, rowBottom);
          ctx.stroke();
        }
      }
    }
  }

  ctx.lineWidth = 1;
}

export function drawHoveredRecognitionBorder(
  ctx: SequenceDrawingContext,
  linePositions: LinePositions[],
  hoveredRecognition: { recognitionStart: number; recognitionEnd: number },
  x: number,
  config: WorkspaceEditorConfig
): void {
  const { recognitionStart, recognitionEnd } = hoveredRecognition;
  const reTheme = getCanvasTheme();
  ctx.strokeStyle = reTheme.isDark ? 'rgba(200, 200, 200, 0.8)' : 'rgba(80, 80, 80, 0.8)';
  ctx.lineWidth = 2;

  for (const { line, sequenceY, complementY } of linePositions) {
    if (recognitionEnd > line.startPos && recognitionStart < line.endPos) {
      const highlightStart = Math.max(0, recognitionStart - line.startPos);
      const highlightEnd = Math.min(line.sequence.length, recognitionEnd - line.startPos);
      const highlightX = x + highlightStart * config.charWidth;
      const highlightWidth = (highlightEnd - highlightStart) * config.charWidth;
      const boxTop = sequenceY;
      const boxBottom = config.showReverseComplement
        ? complementY + config.rowHeight
        : sequenceY + config.rowHeight;
      const boxHeight = boxBottom - boxTop;
      ctx.strokeRect(highlightX, boxTop, highlightWidth, boxHeight);
    }
  }
}

export function hitTestGGProductLabel(
  x: number,
  y: number,
  renderedLabels: RenderedGGProductLabel[]
): RenderedGGProductLabel | null {
  for (const rendered of renderedLabels) {
    const bounds = rendered.labelBounds;
    if (
      x >= bounds.x &&
      x <= bounds.x + bounds.width &&
      y >= bounds.y &&
      y <= bounds.y + bounds.height
    ) {
      return rendered;
    }
  }
  return null;
}

function drawScarRegion(
  ctx: SequenceDrawingContext,
  linePositions: LinePositions[],
  scarStart: number,
  scarEnd: number,
  x: number,
  config: WorkspaceEditorConfig,
  sequenceLength: number,
  mode: 'fill' | 'stroke'
): void {
  const scarSpansOrigin = scarEnd < scarStart;

  const ranges: Array<{ start: number; end: number }> = scarSpansOrigin
    ? [
        { start: scarStart, end: sequenceLength },
        { start: 0, end: scarEnd },
      ]
    : [{ start: scarStart, end: scarEnd }];

  for (const { line, sequenceY, complementY } of linePositions) {
    for (const range of ranges) {
      if (!rangeOverlapsLine(range.start, range.end, line.startPos, line.endPos, sequenceLength)) {
        continue;
      }

      const segments = getVisibleRangeSegments(
        range.start,
        range.end,
        line.startPos,
        line.endPos,
        sequenceLength
      );

      for (const segment of segments) {
        const highlightX = x + segment.charIndexStart * config.charWidth;
        const highlightWidth = (segment.end - segment.start) * config.charWidth;

        if (mode === 'fill') {
          ctx.fillRect(highlightX, sequenceY, highlightWidth, config.rowHeight);
          if (config.showReverseComplement) {
            ctx.fillRect(highlightX, complementY, highlightWidth, config.rowHeight);
          }
        } else {
          const boxTop = sequenceY;
          const boxBottom = config.showReverseComplement
            ? complementY + config.rowHeight
            : sequenceY + config.rowHeight;
          ctx.strokeRect(highlightX, boxTop, highlightWidth, boxBottom - boxTop);
        }
      }
    }
  }
}

export function drawAllGGScarBackgrounds(
  ctx: SequenceDrawingContext,
  linePositions: LinePositions[],
  renderedGGLabels: RenderedGGProductLabel[],
  x: number,
  config: WorkspaceEditorConfig,
  sequenceLength: number
): void {
  if (renderedGGLabels.length === 0) return;

  ctx.fillStyle = GOLDEN_GATE_JUNCTION_VISUAL.productScar.fillCss;

  for (const label of renderedGGLabels) {
    drawScarRegion(
      ctx,
      linePositions,
      label.scarStart,
      label.scarEnd,
      x,
      config,
      sequenceLength,
      'fill'
    );
  }
}

export function drawGGScarHighlights(
  ctx: SequenceDrawingContext,
  linePositions: LinePositions[],
  hoveredGGLabel: RenderedGGProductLabel,
  x: number,
  config: WorkspaceEditorConfig,
  sequenceLength: number
): void {
  ctx.strokeStyle = GOLDEN_GATE_JUNCTION_VISUAL.productScar.hoverStrokeCss;
  ctx.lineWidth = GOLDEN_GATE_JUNCTION_VISUAL.productScar.hoverStrokeWidthPx;

  drawScarRegion(
    ctx,
    linePositions,
    hoveredGGLabel.scarStart,
    hoveredGGLabel.scarEnd,
    x,
    config,
    sequenceLength,
    'stroke'
  );
}
