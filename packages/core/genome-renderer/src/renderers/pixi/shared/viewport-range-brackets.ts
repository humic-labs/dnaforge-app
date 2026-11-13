import type { Graphics } from 'pixi.js';
import type { Genome, RenderState } from '../../../types';
import type { PathMapper } from './path-types';
import { webglThemeForMode } from './theme';
import {
  VIEWPORT_BRACKET_HALF_HEIGHT,
  VIEWPORT_BRACKET_STROKE,
  type ViewportBracketKind,
  viewportBracketPaints,
} from './viewport-range-bracket-layout';

const STYLE = { width: VIEWPORT_BRACKET_STROKE, alpha: 1, cap: 'round', join: 'round' } as const;

export interface ViewportBracketSnapshot {
  range: [number, number] | null;
  kind: ViewportBracketKind | null;
  pathSegmentsDrawn: number;
  strokeWidth: number;
  bbox: { xMin: number; xMax: number; yMin: number; yMax: number } | null;
}

export class ViewportRangeBrackets {
  snapshot: ViewportBracketSnapshot = this.emptySnapshot();

  private emptySnapshot(): ViewportBracketSnapshot {
    return {
      range: null,
      kind: null,
      pathSegmentsDrawn: 0,
      strokeWidth: STYLE.width,
      bbox: null,
    };
  }

  render(
    graphics: Graphics,
    path: PathMapper,
    state: RenderState,
    genome: Pick<Genome, 'length' | 'circular'>
  ): void {
    this.snapshot = this.emptySnapshot();
    const range = state.viewportRange;
    if (!state.viewportIndicatorVisible || !range || genome.length <= 0) return;
    const [start, end] = range;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return;
    const paints = viewportBracketPaints({
      start,
      end,
      genomeLength: genome.length,
      circular: genome.circular,
      pixelsPerBp: path.pixelsPerBp,
    });
    this.snapshot.range = range;
    this.snapshot.kind = paints[0]?.kind ?? null;
    const color = webglThemeForMode(state.themeMode).viewportRange;
    const boundary = (bp: number) => {
      if (!genome.circular) return Math.max(0, Math.min(genome.length, bp));
      const wrapped = ((bp % genome.length) + genome.length) % genome.length;
      return !path.isArcMode && wrapped === 0 && bp > 0 ? genome.length : wrapped;
    };
    for (const paint of paints) {
      const p = path.rulerAt(boundary(paint.anchorBp) - 0.5);
      const tx = Math.cos(p.angle);
      const ty = Math.sin(p.angle);
      const point = (tangent: number, normal: number) => ({
        x: p.x + tangent * tx - normal * ty,
        y: p.y + tangent * ty + normal * tx,
      });
      const points = [
        point(paint.spineTangent + paint.inward * paint.arm, -VIEWPORT_BRACKET_HALF_HEIGHT),
        point(paint.spineTangent, -VIEWPORT_BRACKET_HALF_HEIGHT),
        point(paint.spineTangent, VIEWPORT_BRACKET_HALF_HEIGHT),
        point(paint.spineTangent + paint.inward * paint.arm, VIEWPORT_BRACKET_HALF_HEIGHT),
      ];
      graphics.setStrokeStyle({ ...STYLE, color });
      graphics.moveTo(points[0].x, points[0].y);
      for (const [index, vertex] of points.entries()) {
        if (index > 0) graphics.lineTo(vertex.x, vertex.y);
        const pad = STYLE.width / 2;
        const box = this.snapshot.bbox;
        this.snapshot.bbox = {
          xMin: Math.min(box?.xMin ?? Infinity, vertex.x - pad),
          xMax: Math.max(box?.xMax ?? -Infinity, vertex.x + pad),
          yMin: Math.min(box?.yMin ?? Infinity, vertex.y - pad),
          yMax: Math.max(box?.yMax ?? -Infinity, vertex.y + pad),
        };
      }
      graphics.stroke();
      this.snapshot.pathSegmentsDrawn++;
    }
  }
}
