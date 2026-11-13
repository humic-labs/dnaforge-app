import type { AnnotationEvidenceClass } from '@waypoint/genome-data/annotation-catalog';

import type { WebGLThemeMode } from '../../shared/theme';
import { TRANSCRIPTION_UNIT_GENE_PALETTE } from './catalog-colors';

export interface GlyphFillPaint {
  readonly mode: 'fill';
  readonly color: number;
  readonly alpha: number;
}

export interface GlyphStrokePaint {
  readonly mode: 'stroke';
  readonly color: number;
  readonly alpha: number;
  readonly widthPx: number;
}

export type GlyphPaint = GlyphFillPaint | GlyphStrokePaint;

export class ShapeBatch<P extends GlyphPaint = GlyphPaint> {
  readonly rects: number[] = [];
  readonly polygonPoints: number[] = [];
  readonly polygonSizes: number[] = [];
  readonly circles: number[] = [];

  constructor(readonly paint: P) {}

  rect(x: number, y: number, width: number, height: number): void {
    this.rects.push(x, y, width, height);
  }

  triangle(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number): void {
    this.polygonPoints.push(x0, y0, x1, y1, x2, y2);
    this.polygonSizes.push(3);
  }

  pentagon(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x3: number,
    y3: number,
    x4: number,
    y4: number
  ): void {
    this.polygonPoints.push(x0, y0, x1, y1, x2, y2, x3, y3, x4, y4);
    this.polygonSizes.push(5);
  }

  circle(cx: number, cy: number, radius: number): void {
    this.circles.push(cx, cy, radius);
  }

  get shapeCount(): number {
    return this.rects.length / 4 + this.polygonSizes.length + this.circles.length / 3;
  }

  reset(): void {
    this.rects.length = 0;
    this.polygonPoints.length = 0;
    this.polygonSizes.length = 0;
    this.circles.length = 0;
  }
}

export interface LineDash {
  readonly dashPx: number;
  readonly gapPx: number;
}

export class LineBatch extends ShapeBatch<GlyphStrokePaint> {
  readonly segments: number[] = [];
  private dashMinX = Number.NEGATIVE_INFINITY;
  private dashMaxX = Number.POSITIVE_INFINITY;

  constructor(
    paint: GlyphStrokePaint,
    readonly dash: LineDash | null = null
  ) {
    super(paint);
  }

  setDashClip(minX: number, maxX: number): void {
    this.dashMinX = minX;
    this.dashMaxX = maxX;
  }

  segment(x0: number, y0: number, x1: number, y1: number): void {
    const dash = this.dash;
    if (dash === null) {
      this.segments.push(x0, y0, x1, y1);
      return;
    }
    const dx = x1 - x0;
    const dy = y1 - y0;
    const length = Math.hypot(dx, dy);
    if (!(length > 0)) return;
    let from = 0;
    let to = length;
    if (dx !== 0) {
      const a = ((this.dashMinX - x0) / dx) * length;
      const b = ((this.dashMaxX - x0) / dx) * length;
      from = Math.max(0, Math.min(a, b));
      to = Math.min(length, Math.max(a, b));
    } else if (x0 < this.dashMinX || x0 > this.dashMaxX) {
      return;
    }
    const period = dash.dashPx + dash.gapPx;
    for (let d = Math.floor(from / period) * period; d < to; d += period) {
      const s = Math.max(d, from) / length;
      const e = Math.min(d + dash.dashPx, to) / length;
      if (e <= s) continue;
      this.segments.push(x0 + dx * s, y0 + dy * s, x0 + dx * e, y0 + dy * e);
    }
  }

  override get shapeCount(): number {
    return super.shapeCount + this.segments.length / 4;
  }

  override reset(): void {
    super.reset();
    this.segments.length = 0;
  }
}

export const CATALOG_LINE_WIDTH_PX = 1.5;
export const CATALOG_THIN_LINE_WIDTH_PX = 1;

export interface CatalogGlyphBatches {
  readonly band: ShapeBatch;
  readonly line: LineBatch;
  readonly thinLine: LineBatch;
  readonly body: ShapeBatch;
  readonly unitColors: readonly ShapeBatch[];
  readonly density: ShapeBatch<GlyphFillPaint>;
  readonly ordered: readonly ShapeBatch[];
}

export interface CatalogGlyphStyle {
  readonly color: number;
  readonly evidence: AnnotationEvidenceClass;
  readonly themeMode: WebGLThemeMode;
}

export const CATALOG_COMPUTED_ALPHA = 0.8;
export const CATALOG_COMPUTED_LINE_DASH: LineDash = Object.freeze({ dashPx: 3, gapPx: 2 });

export function createCatalogGlyphBatches(style: CatalogGlyphStyle): CatalogGlyphBatches {
  const { color } = style;
  const computed = style.evidence === 'computed';
  const solid = (paintColor: number, fillAlpha: number, outlineAlpha: number): GlyphPaint =>
    computed
      ? { mode: 'stroke', color: paintColor, alpha: outlineAlpha, widthPx: 1 }
      : { mode: 'fill', color: paintColor, alpha: fillAlpha };
  const lineAlpha = computed ? CATALOG_COMPUTED_ALPHA : 1;
  const lineDash = computed ? CATALOG_COMPUTED_LINE_DASH : null;

  const band = new ShapeBatch(solid(color, 0.18, CATALOG_COMPUTED_ALPHA / 2));
  const line = new LineBatch(
    { mode: 'stroke', color, alpha: lineAlpha, widthPx: CATALOG_LINE_WIDTH_PX },
    lineDash
  );
  const thinLine = new LineBatch(
    { mode: 'stroke', color, alpha: lineAlpha, widthPx: CATALOG_THIN_LINE_WIDTH_PX },
    lineDash
  );
  const body = new ShapeBatch(solid(color, 1, CATALOG_COMPUTED_ALPHA));
  const unitColors = TRANSCRIPTION_UNIT_GENE_PALETTE[style.themeMode].map(
    (geneColor) => new ShapeBatch(solid(geneColor, 1, CATALOG_COMPUTED_ALPHA))
  );
  const density = new ShapeBatch<GlyphFillPaint>({
    mode: 'fill',
    color,
    alpha: computed ? 0.85 * CATALOG_COMPUTED_ALPHA : 0.85,
  });
  return {
    band,
    line,
    thinLine,
    body,
    unitColors,
    density,
    ordered: [band, line, thinLine, body, ...unitColors, density],
  };
}

export function resetCatalogGlyphBatches(batches: CatalogGlyphBatches): void {
  for (const batch of batches.ordered) batch.reset();
}

export function clipCatalogDashes(batches: CatalogGlyphBatches, minX: number, maxX: number): void {
  batches.line.setDashClip(minX, maxX);
  batches.thinLine.setDashClip(minX, maxX);
}
