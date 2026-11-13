import type { SequenceDrawingContext } from './rendering/drawing-context';
import type {
  WorkspaceEditorConfig,
  LinePositions,
  RulerSegment,
  RulerDecoration,
  CoordinateSpace,
} from './types';
import { RULER_FONT_SIZE } from './layout-constants';
import { getCanvasTheme } from './canvas-theme';
import { gappedToBio } from './coordinate-space';
import { lineSpansOrigin } from './utils/range-utils';
import { assemblyScaffoldRulerTicks } from '@waypoint/sequence-utils';

export function getEffectiveRulerInterval(config: WorkspaceEditorConfig): number {
  const MIN_TICK_PX = 40;
  const NICE_INTERVALS = [
    10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000, 500000,
    1000000, 2000000, 5000000, 10000000,
  ];
  const safeCharWidth = Math.max(0.001, config.charWidth);
  const minBpBetweenLabels = Math.ceil(MIN_TICK_PX / safeCharWidth);
  return (
    NICE_INTERVALS.find((n) => n >= Math.max(config.rulerInterval, minBpBetweenLabels)) ??
    NICE_INTERVALS[NICE_INTERVALS.length - 1]
  );
}

function formatRulerTickLabel(pos: number, interval: number): string {
  if (interval >= 1000000 && pos % 1000000 === 0) return `${pos / 1000000} Mb`;
  if (interval >= 1000 && pos % 1000 === 0) return `${pos / 1000} kb`;
  return String(pos);
}

function drawRulerTick(
  ctx: SequenceDrawingContext,
  x: number,
  rulerY: number,
  charIndex: number,
  labelPos: number,
  interval: number,
  config: WorkspaceEditorConfig,
  tickHeight: number,
  paintTick?: ((x: number) => void) | null
): void {
  const tickX = x + charIndex * config.charWidth + config.charWidth / 2;
  if (paintTick) paintTick(tickX);
  else {
    ctx.beginPath();
    ctx.moveTo(tickX, rulerY);
    ctx.lineTo(tickX, rulerY + tickHeight);
    ctx.stroke();
  }
  ctx.fillText(formatRulerTickLabel(labelPos, interval), tickX, rulerY + tickHeight + 1);
}

function drawBiologicalRulerTicksForRange(
  ctx: SequenceDrawingContext,
  params: {
    x: number;
    rulerY: number;
    charOffset: number;
    firstLabelPos: number;
    lastLabelPos: number;
    interval: number;
    config: WorkspaceEditorConfig;
    tickHeight: number;
    paintTick?: ((x: number) => void) | null;
  }
): void {
  const {
    x,
    rulerY,
    charOffset,
    firstLabelPos,
    lastLabelPos,
    interval,
    config,
    tickHeight,
    paintTick,
  } = params;
  const firstTick = Math.ceil(firstLabelPos / interval) * interval;
  for (let pos = firstTick; pos <= lastLabelPos; pos += interval) {
    const charIndex = charOffset + (pos - firstLabelPos);
    drawRulerTick(ctx, x, rulerY, charIndex, pos, interval, config, tickHeight, paintTick);
  }
}

function strokeRulerLine(
  ctx: SequenceDrawingContext,
  startX: number,
  endX: number,
  rulerY: number,
  color: string,
  width: number,
  alpha: number = 1
): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.moveTo(startX, rulerY);
  ctx.lineTo(endX, rulerY);
  ctx.stroke();
  ctx.restore();
}

export function drawRuler(
  ctx: SequenceDrawingContext,
  linePositions: LinePositions[],
  x: number,
  config: WorkspaceEditorConfig,
  sequenceLength: number,
  rulerSegments?: RulerSegment[],
  coordinateSpace?: CoordinateSpace,
  rulerDecorations?: RulerDecoration[]
): void {
  const rulerFontSize = RULER_FONT_SIZE;
  ctx.fillStyle = getCanvasTheme().fgSubtle;
  ctx.font = `${rulerFontSize}px ${config.fontFamily}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const tickHeight = 4;
  const defaultRulerSegmentLineWidth = 2;

  for (const { line, rulerY } of linePositions) {
    const lineStartX = x;
    const lineEndX = x + line.sequence.length * config.charWidth;

    if (rulerSegments && rulerSegments.length > 0) {
      const drawnRanges: Array<{ startX: number; endX: number }> = [];
      const isOriginLine = lineSpansOrigin(line.startPos, line.endPos);

      for (const segment of rulerSegments) {
        if (isOriginLine && line.originPosition !== undefined) {
          const sequenceLength = line.startPos + line.originPosition;

          const preOverlapStart = Math.max(segment.start, line.startPos);
          const preOverlapEnd = Math.min(segment.end, sequenceLength);
          if (preOverlapStart < preOverlapEnd) {
            const charStart = preOverlapStart - line.startPos;
            const charEnd = preOverlapEnd - line.startPos;
            const segStartX = x + charStart * config.charWidth;
            const segEndX = x + charEnd * config.charWidth;

            strokeRulerLine(
              ctx,
              segStartX,
              segEndX,
              rulerY,
              segment.color,
              segment.rulerStrokeWidth ?? defaultRulerSegmentLineWidth,
              segment.alpha ?? 1
            );
            drawnRanges.push({ startX: segStartX, endX: segEndX });
          }

          const postOverlapStart = Math.max(segment.start, 0);
          const postOverlapEnd = Math.min(segment.end, line.endPos);
          if (postOverlapStart < postOverlapEnd) {
            const charStart = line.originPosition + postOverlapStart;
            const charEnd = line.originPosition + postOverlapEnd;
            const segStartX = x + charStart * config.charWidth;
            const segEndX = x + charEnd * config.charWidth;

            strokeRulerLine(
              ctx,
              segStartX,
              segEndX,
              rulerY,
              segment.color,
              segment.rulerStrokeWidth ?? defaultRulerSegmentLineWidth,
              segment.alpha ?? 1
            );
            drawnRanges.push({ startX: segStartX, endX: segEndX });
          }
        } else {
          const overlapStart = Math.max(segment.start, line.startPos);
          const overlapEnd = Math.min(segment.end, line.endPos);

          if (overlapStart < overlapEnd) {
            const segStartX = x + (overlapStart - line.startPos) * config.charWidth;
            const segEndX = x + (overlapEnd - line.startPos) * config.charWidth;

            strokeRulerLine(
              ctx,
              segStartX,
              segEndX,
              rulerY,
              segment.color,
              segment.rulerStrokeWidth ?? defaultRulerSegmentLineWidth,
              segment.alpha ?? 1
            );
            drawnRanges.push({ startX: segStartX, endX: segEndX });
          }
        }
      }

      ctx.strokeStyle = getCanvasTheme().border;
      ctx.lineWidth = 1;
      drawnRanges.sort((a, b) => a.startX - b.startX);
      let currentX = lineStartX;
      for (const range of drawnRanges) {
        if (range.startX > currentX) {
          ctx.beginPath();
          ctx.moveTo(currentX, rulerY);
          ctx.lineTo(range.startX, rulerY);
          ctx.stroke();
        }
        currentX = Math.max(currentX, range.endX);
      }
      if (currentX < lineEndX) {
        ctx.beginPath();
        ctx.moveTo(currentX, rulerY);
        ctx.lineTo(lineEndX, rulerY);
        ctx.stroke();
      }
    } else {
      ctx.strokeStyle = getCanvasTheme().border;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(lineStartX, rulerY);
      ctx.lineTo(lineEndX, rulerY);
      ctx.stroke();
    }

    ctx.strokeStyle = getCanvasTheme().fgSubtle;
    ctx.lineWidth = 1;

    const paintTick = ctx.prepareRepeatedPath?.(
      [
        [0, rulerY],
        [0, rulerY + tickHeight],
      ],
      'stroke'
    );
    const isOriginLine = lineSpansOrigin(line.startPos, line.endPos);
    const effectiveInterval = getEffectiveRulerInterval(config);

    if (coordinateSpace?.mode === 'gapped' && coordinateSpace.gappedSequence) {
      for (let i = 0; i < line.sequence.length; i++) {
        const col = line.startPos + i;
        if (coordinateSpace.gappedSequence[col] === '-') continue;
        const pos = gappedToBio(col, coordinateSpace.gappedSequence);
        if (pos % effectiveInterval === 0) {
          drawRulerTick(ctx, x, rulerY, i, pos, effectiveInterval, config, tickHeight, paintTick);
        }
      }
      continue;
    }

    if (rulerSegments?.some((segment) => segment.scaffold)) {
      const rows =
        isOriginLine && line.originPosition !== undefined
          ? [
              { start: line.startPos, length: line.originPosition, offset: 0 },
              {
                start: 0,
                length: line.sequence.length - line.originPosition,
                offset: line.originPosition,
              },
            ]
          : [{ start: line.startPos, length: line.sequence.length, offset: 0 }];
      for (const row of rows) {
        for (const tick of assemblyScaffoldRulerTicks(
          sequenceLength,
          rulerSegments,
          effectiveInterval,
          row.start,
          row.start + row.length,
          1
        )) {
          drawRulerTick(
            ctx,
            x,
            rulerY,
            row.offset + tick.position - row.start,
            tick.label,
            effectiveInterval,
            config,
            tickHeight,
            paintTick
          );
        }
      }
      continue;
    }

    if (isOriginLine && line.originPosition !== undefined) {
      if (line.originPosition > 0) {
        drawBiologicalRulerTicksForRange(ctx, {
          x,
          rulerY,
          charOffset: 0,
          firstLabelPos: line.startPos + 1,
          lastLabelPos: sequenceLength,
          interval: effectiveInterval,
          config,
          tickHeight,
          paintTick,
        });
      }

      const postOriginLength = line.sequence.length - line.originPosition;
      if (postOriginLength > 0) {
        drawBiologicalRulerTicksForRange(ctx, {
          x,
          rulerY,
          charOffset: line.originPosition,
          firstLabelPos: 1,
          lastLabelPos: postOriginLength,
          interval: effectiveInterval,
          config,
          tickHeight,
          paintTick,
        });
      }
    } else {
      drawBiologicalRulerTicksForRange(ctx, {
        x,
        rulerY,
        charOffset: 0,
        firstLabelPos: line.startPos + 1,
        lastLabelPos: line.startPos + line.sequence.length,
        interval: effectiveInterval,
        config,
        tickHeight,
        paintTick,
      });
    }
  }

  if (rulerDecorations && rulerDecorations.length > 0) {
    const decoHeight = 4;
    for (const { line, rulerY } of linePositions) {
      for (const deco of rulerDecorations) {
        const overlapStart = Math.max(deco.start, line.startPos);
        const overlapEnd = Math.min(deco.end + 1, line.endPos);
        if (overlapStart >= overlapEnd) continue;

        const charStart = overlapStart - line.startPos;
        const charEnd = overlapEnd - line.startPos;
        const decoStartX = x + charStart * config.charWidth;
        const decoWidth = Math.max(config.charWidth, (charEnd - charStart) * config.charWidth);

        if (deco.style === 'caret') {
          const caretX = decoStartX;
          ctx.fillStyle = deco.color;
          ctx.beginPath();
          ctx.moveTo(caretX, rulerY - decoHeight - 1);
          ctx.lineTo(caretX - 3, rulerY + 1);
          ctx.lineTo(caretX + 3, rulerY + 1);
          ctx.closePath();
          ctx.fill();
        } else if (deco.style === 'strikethrough') {
          ctx.fillStyle = deco.color;
          ctx.globalAlpha = 0.3;
          ctx.fillRect(decoStartX, rulerY - decoHeight, decoWidth, decoHeight);
          ctx.globalAlpha = 1.0;
          ctx.strokeStyle = deco.color;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(decoStartX, rulerY - decoHeight / 2);
          ctx.lineTo(decoStartX + decoWidth, rulerY - decoHeight / 2);
          ctx.stroke();
        } else {
          ctx.fillStyle = deco.color;
          ctx.globalAlpha = 0.7;
          ctx.fillRect(decoStartX, rulerY - decoHeight, decoWidth, decoHeight);
          ctx.globalAlpha = 1.0;
        }
      }
    }
  }

  ctx.lineWidth = 1;
}
