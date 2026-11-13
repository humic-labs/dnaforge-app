import type { Graphics } from 'pixi.js';

export interface Point2 {
  x: number;
  y: number;
}

export function drawDashedLine(
  g: Graphics,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  dash: number,
  gap: number
): void {
  drawDashedPolyline(
    g,
    [
      { x: x1, y: y1 },
      { x: x2, y: y2 },
    ],
    dash,
    gap
  );
}

export function drawDashedPolyline(g: Graphics, points: Point2[], dash: number, gap: number): void {
  if (points.length < 2 || dash <= 0 || gap < 0) return;
  const cycle = dash + gap;
  if (cycle <= 0) return;
  let patternOffset = 0;

  for (let i = 1; i < points.length; i++) {
    const x1 = points[i - 1].x;
    const y1 = points[i - 1].y;
    const x2 = points[i].x;
    const y2 = points[i].y;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const length = Math.hypot(dx, dy);
    if (length <= 0) continue;
    const ux = dx / length;
    const uy = dy / length;

    let consumed = 0;
    while (consumed < length) {
      const inDash = patternOffset < dash;
      const remainingInPart = inDash ? dash - patternOffset : cycle - patternOffset;
      const step = Math.min(remainingInPart, length - consumed);
      if (inDash && step > 0) {
        g.moveTo(x1 + ux * consumed, y1 + uy * consumed);
        g.lineTo(x1 + ux * (consumed + step), y1 + uy * (consumed + step));
        g.stroke();
      }
      consumed += step;
      patternOffset = (patternOffset + step) % cycle;
    }
  }
}
