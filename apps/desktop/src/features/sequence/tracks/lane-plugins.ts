import type { SequenceExtraLane } from '@waypoint/workspace-editor';

const COLORS = {
  axis: 'rgba(100, 116, 139, 0.4)',
  low: 'rgba(8, 145, 178, 0.85)',
  high: 'rgba(220, 38, 38, 0.85)',
  label: '#475569',
};

const FONT_FAMILY =
  'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

export interface GcContentLaneOptions {
  values: Float32Array;
  windowSize: number;
  height?: number;
}

export function gcContentLane(opts: GcContentLaneOptions): SequenceExtraLane {
  const height = opts.height ?? 56;
  return {
    id: 'gc-content',
    height,
    draw: (ctx, info) => {
      const padding = Math.min(6, Math.floor(info.laneHeight / 4));
      const innerY = info.laneY + padding;
      const innerH = Math.max(2, info.laneHeight - padding * 2);
      if (innerH <= 0) return;
      const baselineY = innerY + innerH / 2;
      const halfH = innerH / 2;

      const worldLeft = info.scrollLeft;
      const worldRight = info.scrollLeft + info.viewportWidth;

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(worldLeft, info.laneY, info.viewportWidth, info.laneHeight);

      ctx.strokeStyle = COLORS.axis;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(worldLeft, baselineY + 0.5);
      ctx.lineTo(worldRight, baselineY + 0.5);
      ctx.stroke();

      const px = info.pxPerBase;
      const N = opts.values.length;
      const cycle = info.columnCount > 0 ? info.columnCount : N;
      const start = Math.max(0, Math.floor(info.visibleStart));
      const end = info.isCircular
        ? Math.ceil(info.visibleEnd)
        : Math.min(N, Math.ceil(info.visibleEnd));
      if (end <= start || px <= 0) {
        drawLabel(ctx, info, opts.windowSize, worldLeft);
        return;
      }
      const toBioCol = (v: number): number => {
        if (!info.isCircular || cycle <= 0) return v;
        return ((v % cycle) + cycle) % cycle;
      };

      const colsPerPixel = 1 / px;
      const samplePx = Math.max(1, info.viewportWidth);
      const samples: { x: number; y: number; deviation: number }[] = [];
      for (let pxi = 0; pxi <= samplePx; pxi++) {
        const screenX = pxi;
        const colFloat = info.visibleStart + screenX * colsPerPixel;
        const colStart = Math.floor(colFloat);
        const colEnd = Math.max(colStart + 1, Math.ceil(colFloat + colsPerPixel));
        if (colStart >= end) break;
        const sliceStart = Math.max(start, colStart);
        const sliceEnd = Math.min(end, colEnd);
        if (sliceEnd <= sliceStart) continue;
        let sum = 0;
        let count = 0;
        for (let i = sliceStart; i < sliceEnd; i++) {
          const bio = toBioCol(i);
          if (bio < 0 || bio >= N) continue;
          sum += opts.values[bio];
          count++;
        }
        if (count === 0) continue;
        const avg = sum / count;
        const deviation = avg - 0.5;
        const y = baselineY - (deviation / 0.5) * halfH;
        samples.push({ x: worldLeft + screenX, y, deviation });
      }
      if (samples.length < 2) {
        drawLabel(ctx, info, opts.windowSize, worldLeft);
        return;
      }

      ctx.fillStyle = COLORS.high;
      ctx.beginPath();
      ctx.moveTo(samples[0].x, baselineY);
      for (const s of samples) {
        const yClamped = Math.min(baselineY, s.y);
        ctx.lineTo(s.x, yClamped);
      }
      ctx.lineTo(samples[samples.length - 1].x, baselineY);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = COLORS.low;
      ctx.beginPath();
      ctx.moveTo(samples[0].x, baselineY);
      for (const s of samples) {
        const yClamped = Math.max(baselineY, s.y);
        ctx.lineTo(s.x, yClamped);
      }
      ctx.lineTo(samples[samples.length - 1].x, baselineY);
      ctx.closePath();
      ctx.fill();

      drawLabel(ctx, info, opts.windowSize, worldLeft);
    },
  };
}

function drawLabel(
  ctx: CanvasRenderingContext2D,
  info: { laneY: number },
  windowSize: number,
  worldLeft: number
): void {
  ctx.fillStyle = COLORS.label;
  ctx.font = `600 10px ${FONT_FAMILY}`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText(`GC content · ${windowSize}-bp window`, worldLeft + 6, info.laneY + 4);
}
