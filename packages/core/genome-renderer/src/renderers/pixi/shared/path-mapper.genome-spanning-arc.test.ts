import { describe, it, expect } from 'vitest';
import { StadiumPathMapper, type StadiumPathInputs } from './path-mapper';
import type { StadiumDimensions } from '../../../geometry/stadium';

const GENOME_LENGTH = 1_072_315;

const DIMS: StadiumDimensions = {
  width: 372,
  height: 372,
  radius: 186,
  straightLength: 0,
  totalLength: 1168.672467135403,
} as StadiumDimensions;

const VIEWPORT_W = 1293;
const VIEWPORT_H = 1594;

function mapperAtZoom(
  zoom: number,
  camera?: { x: number; y: number },
  viewOffset = 0.8152357537331684
): StadiumPathMapper {
  const inputs: StadiumPathInputs = {
    genomeLength: GENOME_LENGTH,
    viewOffset,
    zoom,
    dims: DIMS,
    ox: 460.5,
    oy: 611,
    stagePosX: camera ? camera.x : -646.5 * (zoom - 1),
    stagePosY: camera ? camera.y : -611 * zoom + 826,
    bpPerPixel: 917.549639 / zoom,
    hasSequence: true,
    viewportWidth: VIEWPORT_W,
    viewportHeight: VIEWPORT_H,
    geometryHeight: 600,
  };
  return new StadiumPathMapper(inputs);
}

function outerEdge(pts: number[]): Array<{ x: number; y: number }> {
  const n = pts.length / 2;
  const half = Math.floor(n / 2);
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < half; i++) out.push({ x: pts[2 * i], y: pts[2 * i + 1] });
  return out;
}

const onScreen = (p: { x: number; y: number }) =>
  p.x >= 0 && p.x <= VIEWPORT_W && p.y >= 0 && p.y <= VIEWPORT_H;

type Pt = { x: number; y: number };

function segmentTouchesViewport(a: Pt, b: Pt): boolean {
  if (onScreen(a) || onScreen(b)) return true;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return (
    clip(-dx, a.x) &&
    clip(dx, VIEWPORT_W - a.x) &&
    clip(-dy, a.y) &&
    clip(dy, VIEWPORT_H - a.y) &&
    t0 <= t1
  );
}

function visibleSegments(edge: Pt[]): Array<[Pt, Pt]> {
  const out: Array<[Pt, Pt]> = [];
  for (let i = 1; i < edge.length; i++) {
    if (segmentTouchesViewport(edge[i - 1], edge[i])) out.push([edge[i - 1], edge[i]]);
  }
  return out;
}

function spanningPolygon(pm: StadiumPathMapper): number[] {
  return pm.featurePolygonAt(0, GENOME_LENGTH, -14, 6);
}

describe('StadiumPathMapper — genome-spanning feature stays visible while zooming', () => {
  it('still crosses the viewport at the zoom where it vanished (130)', () => {
    const edge = outerEdge(spanningPolygon(mapperAtZoom(130)));

    expect(visibleSegments(edge).length).toBeGreaterThan(0);
  });

  it('never stops crossing the viewport across a continuous zoom sweep', () => {
    const missing: number[] = [];
    for (let zoom = 100; zoom <= 800; zoom += 10) {
      const edge = outerEdge(spanningPolygon(mapperAtZoom(zoom)));
      if (visibleSegments(edge).length === 0) missing.push(zoom);
    }

    expect(missing).toEqual([]);
  });

  it('does not replace the visible arc with one runaway chord', () => {
    for (const zoom of [130, 200, 400, 800]) {
      const edge = outerEdge(spanningPolygon(mapperAtZoom(zoom)));
      const segments = visibleSegments(edge);

      expect(segments.length).toBeGreaterThan(0);
      const worst = Math.max(...segments.map(([a, b]) => Math.hypot(b.x - a.x, b.y - a.y)));
      expect(worst).toBeLessThan(4000);
    }
  });

  it('does not pay for off-screen geometry (budget spent where it shows)', () => {
    for (const zoom of [130, 400, 800, 6000]) {
      const pm = mapperAtZoom(zoom);
      const windowLen = pm.viewEndBp - pm.viewStartBp;
      const samples = spanningPolygon(pm).length / 4;

      expect(windowLen, `zoom=${zoom}: clipping inactive, bound is vacuous`).toBeLessThan(
        GENOME_LENGTH
      );
      expect(samples, `zoom=${zoom}: tessellating off-screen arc`).toBeLessThanOrEqual(64);
    }
  });

  it('never draws a ribbon that dwarfs the viewport, at any zoom or pan', () => {
    const viewportArea = VIEWPORT_W * VIEWPORT_H;
    const offenders: string[] = [];

    for (const zoom of [60, 100, 120, 130, 140, 180, 260, 400, 700, 1200, 2500, 6000]) {
      for (const viewOffset of [0, 0.12, 0.25, 0.4, 0.5, 0.63, 0.75, 0.815, 0.9, 0.97]) {
        const pts = spanningPolygon(mapperAtZoom(zoom, undefined, viewOffset));
        const xs: number[] = [];
        const ys: number[] = [];
        for (let i = 0; i < pts.length; i += 2) {
          xs.push(pts[i]);
          ys.push(pts[i + 1]);
        }
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);
        const touchesScreen = maxX > 0 && minX < VIEWPORT_W && maxY > 0 && minY < VIEWPORT_H;
        if (!touchesScreen) continue;
        const ratio = ((maxX - minX) * (maxY - minY)) / viewportArea;
        if (ratio > 4) {
          offenders.push(`zoom=${zoom} viewOffset=${viewOffset} ratio=${Math.round(ratio)}x`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('still draws the whole ring when the whole ring is on screen (zoomed out)', () => {
    const edge = outerEdge(spanningPolygon(mapperAtZoom(1, { x: 0, y: 0 })));
    const xs = edge.map((p) => p.x);
    const ys = edge.map((p) => p.y);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);

    expect(width).toBeGreaterThan(DIMS.radius);
    expect(height).toBeGreaterThan(DIMS.radius);
  });
});
