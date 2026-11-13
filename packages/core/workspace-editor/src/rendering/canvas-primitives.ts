export { buildChevronStripOuterPath } from '@waypoint/platform';
import { CODON_CHEVRON_DEPTH_RATIO } from '@waypoint/platform';
import type { SequenceDrawingContext } from './drawing-context';

import { getCanvasTheme } from '../canvas-theme';
import { isLightColor } from '../canvas-colors';

export const CHEVRON_WIDTH_RATIO = CODON_CHEVRON_DEPTH_RATIO;

export function getCodonLetterPosition(
  codonX: number,
  codonWidth: number,
  trackY: number,
  trackHeight: number,
  chevronDepth: number,
  direction: 1 | -1,
  fontSize: number
): { x: number; y: number } {
  return {
    x: codonX + codonWidth / 2 + direction * chevronDepth * 0.3,
    y: trackY + trackHeight / 2 + Math.round(fontSize * 0.06),
  };
}

export function drawLabelBar(
  ctx: SequenceDrawingContext,
  barX: number,
  barY: number,
  barWidth: number,
  barHeight: number,
  color: string,
  cornerRadius: number,
  label: string | null,
  labelFontSize: number,
  labelFontFamily: string
): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(barX, barY, barWidth, barHeight, cornerRadius);
  ctx.fill();

  if (label && barWidth > 20) {
    ctx.font = `500 ${labelFontSize}px ${labelFontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const availableWidth = barWidth - 8;
    const labelY = barY + barHeight / 2;
    const labelCenterX = barX + barWidth / 2;

    let displayLabel = label;
    const textWidth = ctx.measureText(label).width;
    if (textWidth > availableWidth) {
      let truncated = label;
      while (ctx.measureText(truncated + '…').width > availableWidth && truncated.length > 1) {
        truncated = truncated.slice(0, -1);
      }
      displayLabel = truncated + '…';
    }

    if (availableWidth > 15) {
      ctx.fillStyle = isLightColor(color) ? getCanvasTheme().fgMuted : 'rgba(255, 255, 255, 0.85)';
      ctx.fillText(displayLabel, labelCenterX, labelY);
    }
  }
}

export function drawChevronSeparatorLine(
  ctx: SequenceDrawingContext,
  sepX: number,
  sepY: number,
  sepColor: string,
  direction: number,
  trackHeight: number,
  padding: number
): void {
  const chevronWidth = Math.round(trackHeight * CHEVRON_WIDTH_RATIO);
  const midY = sepY + trackHeight / 2;

  const scaledLineWidth = Math.max(1, trackHeight * 0.075);

  ctx.strokeStyle = sepColor;
  ctx.lineWidth = scaledLineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();

  if (direction === 1) {
    ctx.moveTo(sepX, sepY + padding);
    ctx.lineTo(sepX + chevronWidth, midY);
    ctx.lineTo(sepX, sepY + trackHeight - padding);
  } else {
    ctx.moveTo(sepX, sepY + padding);
    ctx.lineTo(sepX - chevronWidth, midY);
    ctx.lineTo(sepX, sepY + trackHeight - padding);
  }
  ctx.stroke();
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
}

export type CodonEdge = 'flat' | 'chevron' | 'tip';

function codonEdgeShift(edge: CodonEdge, side: 'left' | 'right', direction: 1 | -1): number {
  if (edge === 'flat') return 0;
  return edge === 'tip' ? (side === 'left' ? -1 : 1) : direction;
}

export function buildCodonCellPath(
  ctx: Pick<SequenceDrawingContext, 'beginPath' | 'moveTo' | 'lineTo' | 'closePath'>,
  x: number,
  y: number,
  w: number,
  h: number,
  depth: number,
  direction: 1 | -1,
  leftEdge: CodonEdge,
  rightEdge: CodonEdge
): void {
  const midY = y + h / 2;
  ctx.beginPath();

  const leftShift = codonEdgeShift(leftEdge, 'left', direction);
  const rightShift = codonEdgeShift(rightEdge, 'right', direction);
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  if (rightShift) ctx.lineTo(x + w + rightShift * depth, midY);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  if (leftShift) ctx.lineTo(x + leftShift * depth, midY);

  ctx.closePath();
}

export function buildChevronStripInteriorDividersPath(
  ctx: SequenceDrawingContext,
  cells: ReadonlyArray<{ codonX: number; visibleWidth: number }>,
  trackY: number,
  trackHeight: number,
  chevronDepth: number,
  direction: 1 | -1
): void {
  ctx.beginPath();
  if (cells.length < 2) return;
  const y = trackY;
  const h = trackHeight;
  const midY = y + h / 2;
  for (let i = 0; i < cells.length - 1; i++) {
    const cell = cells[i];
    const boundaryX = cell.codonX + cell.visibleWidth;
    ctx.moveTo(boundaryX, y);
    if (direction === 1) {
      ctx.lineTo(boundaryX + chevronDepth, midY);
    } else {
      ctx.lineTo(boundaryX - chevronDepth, midY);
    }
    ctx.lineTo(boundaryX, y + h);
  }
}

export function drawLaneDivider(
  ctx: SequenceDrawingContext,
  x: number,
  y: number,
  width: number,
  color: string
): void {
  if (width <= 0) return;
  const lineY = Math.round(y) + 0.5;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, lineY);
  ctx.lineTo(x + width, lineY);
  ctx.stroke();
  ctx.restore();
}

export function drawLaneGutterDivider(
  ctx: SequenceDrawingContext,
  gutterWidth: number,
  y: number,
  height: number,
  color: string
): void {
  if (height <= 0 || gutterWidth <= 0) return;
  const lineX = Math.round(gutterWidth) + 0.5;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(lineX, y);
  ctx.lineTo(lineX, y + height);
  ctx.stroke();
  ctx.restore();
}

export function drawChevronRect(
  ctx: SequenceDrawingContext,
  x: number,
  y: number,
  width: number,
  height: number,
  chevronDepth: number,
  direction: number,
  leftChevron: boolean,
  rightChevron: boolean
): void {
  ctx.beginPath();

  if (leftChevron && direction === -1) {
    ctx.moveTo(x + chevronDepth, y);
  } else {
    ctx.moveTo(x, y);
  }

  if (rightChevron && direction === 1) {
    ctx.lineTo(x + width - chevronDepth, y);
    ctx.lineTo(x + width, y + height / 2);
    ctx.lineTo(x + width - chevronDepth, y + height);
  } else {
    ctx.lineTo(x + width, y);
    ctx.lineTo(x + width, y + height);
  }

  if (leftChevron && direction === -1) {
    ctx.lineTo(x + chevronDepth, y + height);
    ctx.lineTo(x, y + height / 2);
    ctx.lineTo(x + chevronDepth, y);
  } else {
    ctx.lineTo(x, y + height);
    ctx.lineTo(x, y);
  }

  ctx.closePath();
  ctx.fill();
}
