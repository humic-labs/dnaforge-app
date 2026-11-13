import type { SequenceDrawingContext } from './rendering/drawing-context';

import { getCanvasTheme } from './canvas-theme';
import { sequenceSelectionFillCss } from '@waypoint/platform';

export const SELECTION_FILL_LIGHT = sequenceSelectionFillCss('light');
export const SELECTION_FILL_DARK = sequenceSelectionFillCss('dark');

export const SELECTION_HANDLE_DARK = 'rgba(200, 180, 80, 0.7)';
export const SELECTION_HANDLE_WIDTH = 2;

export const SELECTION_HANDLE_HIT_TOLERANCE_BASES = 1;

export const HOVER_CURSOR_GLOW_LIGHT = 'rgba(107, 114, 128, 0.25)';
export const HOVER_CURSOR_GLOW_DARK = 'rgba(156, 163, 175, 0.25)';
export const HOVER_CURSOR_LINE_LIGHT = '#6b7280';
export const HOVER_CURSOR_LINE_DARK = '#9ca3af';

export function getHoverCursorChrome(isDark: boolean): { glow: string; line: string } {
  return {
    glow: isDark ? HOVER_CURSOR_GLOW_DARK : HOVER_CURSOR_GLOW_LIGHT,
    line: isDark ? HOVER_CURSOR_LINE_DARK : HOVER_CURSOR_LINE_LIGHT,
  };
}

export function drawSelectionFillRect(
  ctx: SequenceDrawingContext,
  x: number,
  rowTop: number,
  width: number,
  height: number
): void {
  const theme = getCanvasTheme();
  ctx.fillStyle = theme.isDark ? SELECTION_FILL_DARK : SELECTION_FILL_LIGHT;
  ctx.fillRect(x, rowTop, width, height);
}

export function drawSelectionHandleBar(
  ctx: SequenceDrawingContext,
  x: number,
  rowTop: number,
  rowBottom: number
): void {
  const theme = getCanvasTheme();
  drawFullStackVLine(
    ctx,
    x,
    rowTop,
    rowBottom,
    theme.isDark ? SELECTION_HANDLE_DARK : theme.fg,
    SELECTION_HANDLE_WIDTH
  );
}

export function drawViewCursorLine(
  ctx: SequenceDrawingContext,
  x: number,
  rowTop: number,
  rowBottom: number
): void {
  drawSelectionHandleBar(ctx, x, rowTop, rowBottom);
}

export function drawHoverCursorLine(
  ctx: SequenceDrawingContext,
  x: number,
  rowTop: number,
  rowBottom: number
): void {
  const theme = getCanvasTheme();
  ctx.save();
  ctx.strokeStyle = theme.isDark ? '#f5e58a' : '#000000';
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = 0.55;
  ctx.lineCap = 'butt';
  ctx.setLineDash([5, 4]);
  ctx.lineDashOffset = 0;
  ctx.beginPath();
  ctx.moveTo(x, rowTop);
  ctx.lineTo(x, rowBottom);
  ctx.stroke();
  ctx.restore();
}

function drawFullStackVLine(
  ctx: SequenceDrawingContext,
  x: number,
  rowTop: number,
  rowBottom: number,
  strokeStyle: string,
  lineWidth: number
): void {
  ctx.save();
  ctx.strokeStyle = strokeStyle;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  ctx.moveTo(x, rowTop);
  ctx.lineTo(x, rowBottom);
  ctx.stroke();
  ctx.restore();
}
