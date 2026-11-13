/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnnotatedSequence, Annotation } from '@waypoint/sequence-utils';
import { cdsReplacementZoomPresentation } from '@waypoint/platform';
import { computeSequenceLayoutImpl } from '../useSequenceLayout';
import { computeLineTrackPositions } from '../line-track-layout';
import { renderSequence } from '../canvas-renderer';
import { computeScaledConfig } from '../zoom-math';
import { DEFAULT_EDITOR_CONFIG, type WorkspaceEditorConfig } from '../types';
import {
  getRecordingLog,
  installRecordingCanvas,
  uninstallRecordingCanvas,
  type CanvasOp,
} from '../testing/recording-canvas-context';

type Point = { x: number; y: number };
type Paint = {
  index: number;
  kind: 'fill' | 'stroke';
  polygons: Point[][];
  color: string;
  alpha: number;
};

const VIEWPORT_PX = 655;
const CODON_ALPHA = 0.6;
const ZOOMS = [0.2, 0.235, 0.245, 0.255, 0.27, 0.31, 0.33, 0.35, 0.37, 0.39, 0.41, 0.5, 1, 3, 8];
const bases = 'ATGGCTAAAGCTCTGGTTCGTAAAGATCTGGAAGCTCGTTCTGCTCAGGCTGAAACC';
const sequenceText = bases.repeat(Math.ceil(12000 / bases.length)).slice(0, 12000);

function cds(name: string, start: number, end: number, direction: 1 | -1, color = '#4F7FE8') {
  return { name, type: 'CDS', start, end, direction, color, qualifiers: { label: [name] } };
}

function subject(annotations: Annotation[], circular = false): AnnotatedSequence {
  return {
    name: 'CDS zoom silhouette',
    sequence: sequenceText,
    circular,
    annotations,
  } as AnnotatedSequence;
}

function frame(charWidth: number, seq: AnnotatedSequence, hovered: Annotation) {
  const presentation = cdsReplacementZoomPresentation(charWidth, VIEWPORT_PX);
  const config = {
    ...computeScaledConfig(DEFAULT_EDITOR_CONFIG, (charWidth / 8) * 100),
    charWidth,
    charsPerLine: Math.floor((VIEWPORT_PX - 4) / charWidth),
    marginLeft: 4,
    annotationColorMode: 'manual',
    aaColorScheme: 'rasmol',
    showTranslation: true,
    cdsDetailProgress: presentation.progress,
    cdsZoomPresentation: presentation,
    lodLevel: presentation.progress > 0 ? 'detail' : 'feature',
  } as WorkspaceEditorConfig;
  const layout = computeSequenceLayoutImpl(seq, config, 0, 0, [], false, [], 0, {
    firstRowIndex: 0,
    lastRowIndex: 40,
    emitOnlyViewportLines: true,
  });
  const rows = layout.lines.filter((l) =>
    (l.classifiedCDSs ?? []).some((c) => c.name === hovered.name)
  );
  const canvas = document.createElement('canvas');
  renderSequence(canvas.getContext('2d')!, {
    linePositions: rows.map((row) => computeLineTrackPositions(row, config)),
    config,
    layout: { ...layout, lines: rows },
    canvasWidth: VIEWPORT_PX,
    canvasHeight: layout.totalHeight,
    sequenceLength: seq.sequence.length,
    fullSequence: seq.sequence,
    cutSites: [],
    scannedCutSites: [],
    primers: [],
    mutations: [],
    rulerSegments: [],
    insertedRanges: [],
    deletedRanges: [],
    showCutSites: false,
    highlightedRange: null,
    hoveredCodon: null,
    viewCursor: null,
    hoveredCutSite: null,
    hoveredGGProductLabel: null,
    hoveredEnzymeName: null,
    hoveredPositionInfo: null,
    viewport: { scrollTop: 0, height: layout.totalHeight },
    annotationRenderStateInput: { hovered },
  });
  return { presentation, rows, paints: interpret(getRecordingLog(canvas)) };
}

function interpret(ops: CanvasOp[]): Paint[] {
  type Matrix = [number, number, number, number, number, number];
  const apply = (m: Matrix, x: number, y: number): Point => ({
    x: m[0] * x + m[2] * y + m[4],
    y: m[1] * x + m[3] * y + m[5],
  });
  let state = { m: [1, 0, 0, 1, 0, 0] as Matrix, fill: '#000', stroke: '#000', alpha: 1 };
  const stack: (typeof state)[] = [];
  let path: Point[][] = [];
  const paints: Paint[] = [];
  const quad = (x: number, y: number, w: number, h: number) => [
    apply(state.m, x, y),
    apply(state.m, x + w, y),
    apply(state.m, x + w, y + h),
    apply(state.m, x, y + h),
  ];
  ops.forEach((op, index) => {
    if (op.op === 'save') stack.push({ ...state, m: [...state.m] as Matrix });
    else if (op.op === 'restore') state = stack.pop() ?? state;
    else if (op.op === 'translate') {
      state.m[4] += state.m[0] * op.x + state.m[2] * op.y;
      state.m[5] += state.m[1] * op.x + state.m[3] * op.y;
    } else if (op.op === 'scale') {
      state.m[0] *= op.x;
      state.m[1] *= op.x;
      state.m[2] *= op.y;
      state.m[3] *= op.y;
    } else if (op.op === 'setTransform') state.m = [op.a, op.b, op.c, op.d, op.e, op.f];
    else if (op.op === 'resetTransform') state.m = [1, 0, 0, 1, 0, 0];
    else if (op.op === 'set') {
      if (op.prop === 'fillStyle') state.fill = String(op.value);
      if (op.prop === 'strokeStyle') state.stroke = String(op.value);
      if (op.prop === 'globalAlpha') state.alpha = Number(op.value);
    } else if (op.op === 'beginPath') path = [];
    else if (op.op === 'moveTo') path.push([apply(state.m, op.x, op.y)]);
    else if (op.op === 'lineTo')
      (path[path.length - 1] ?? (path[0] = [])).push(apply(state.m, op.x, op.y));
    else if (op.op === 'rect') path.push(quad(op.x, op.y, op.w, op.h));
    else if (op.op === 'fill' || op.op === 'stroke')
      paints.push({
        index,
        kind: op.op,
        polygons: path.map((p) => [...p]),
        color: op.op === 'fill' ? state.fill : state.stroke,
        alpha: state.alpha,
      });
    else if (op.op === 'fillRect')
      paints.push({
        index,
        kind: 'fill',
        polygons: [quad(op.x, op.y, op.w, op.h)],
        color: state.fill,
        alpha: state.alpha,
      });
  });
  return paints;
}

const inside = (p: Point, poly: Point[]) => {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i],
      b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
      hit = !hit;
  }
  return hit;
};

const isHoverStroke = (p: Paint) => p.kind === 'stroke' && /^rgba\(17, 24, 39,/.test(p.color);
const isExtensionArrow = (p: Paint) => /^rgba\(107, 114, 128/.test(p.color);
const bounds = (polys: Point[][]) => {
  const xs = polys.flat().map((p) => p.x),
    ys = polys.flat().map((p) => p.y);
  return {
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.min(...ys),
    bottom: Math.max(...ys),
  };
};

type Band = { top: number; bottom: number; left: number; right: number };

function rowBand(row: { y: number }): Band {
  return { top: row.y - 4, bottom: row.y + 60, left: 0, right: VIEWPORT_PX + 12 };
}

function cdsFills(paints: Paint[], band: Band) {
  const inBand = (poly: Point[]) =>
    poly.some((p) => p.y > band.top && p.y < band.bottom && p.x > band.left && p.x < band.right);
  return paints.filter((p) => {
    if (p.kind !== 'fill' || p.alpha <= 0.02 || isExtensionArrow(p) || !p.polygons.some(inBand))
      return false;
    const b = bounds(p.polygons);
    return b.bottom - b.top < 40;
  });
}

function silhouetteMismatch(paints: Paint[], band: Band) {
  const step = 0.25;
  const fills = cdsFills(paints, band);
  const outlines = paints.filter(
    (p) =>
      isHoverStroke(p) &&
      p.polygons.some((poly) => poly.some((q) => q.y > band.top && q.y < band.bottom))
  );
  const width = Math.ceil((band.right - band.left) / step) + 2,
    height = Math.ceil((band.bottom - band.top) / step) + 2;
  const grid = new Uint8Array(width * height);
  for (const fill of fills)
    for (const poly of fill.polygons) {
      if (poly.length < 3) continue;
      const b = bounds([poly]);
      const i0 = Math.max(0, Math.floor((b.left - band.left) / step)),
        i1 = Math.min(width - 1, Math.ceil((b.right - band.left) / step));
      const j0 = Math.max(0, Math.floor((b.top - band.top) / step)),
        j1 = Math.min(height - 1, Math.ceil((b.bottom - band.top) / step));
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++)
          if (
            !grid[j * width + i] &&
            inside({ x: band.left + i * step, y: band.top + j * step }, poly)
          )
            grid[j * width + i] = 1;
    }
  const boundary: Point[] = [];
  for (let j = 0; j < height - 1; j++)
    for (let i = 0; i < width - 1; i++) {
      const here = grid[j * width + i];
      if (here !== grid[j * width + i + 1] || here !== grid[(j + 1) * width + i])
        boundary.push({ x: band.left + (i + 0.5) * step, y: band.top + (j + 0.5) * step });
    }
  const stroked: Point[] = [];
  for (const outline of outlines)
    for (const poly of outline.polygons)
      poly.forEach((a, i) => {
        const b = poly[(i + 1) % poly.length];
        const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
        for (let k = 0; k < n; k++)
          stroked.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
      });
  const nearest = (set: Point[]) => {
    const buckets = new Map<number, Map<number, Point[]>>();
    for (const p of set) {
      const x = Math.floor(p.x / 4),
        y = Math.floor(p.y / 4);
      const column = buckets.get(x) ?? buckets.set(x, new Map()).get(x)!;
      (column.get(y) ?? column.set(y, []).get(y)!).push(p);
    }
    return (p: Point) => {
      let d = Infinity;
      const x = Math.floor(p.x / 4),
        y = Math.floor(p.y / 4);
      for (let r = 1; r <= 8 && d === Infinity; r *= 2)
        for (let bx = x - r; bx <= x + r; bx++) {
          const column = buckets.get(bx);
          if (!column) continue;
          for (let by = y - r; by <= y + r; by++)
            for (const q of column.get(by) ?? []) d = Math.min(d, Math.hypot(p.x - q.x, p.y - q.y));
        }
      return d;
    };
  };
  const toBoundary = nearest(boundary),
    toStroke = nearest(stroked);
  const interior = (p: Point) => p.x > band.left + 1 && p.x < band.right - 1;
  return {
    outlinePolygons: outlines.reduce((n, o) => n + o.polygons.length, 0),
    strayStroke: Math.max(0, ...stroked.filter(interior).map(toBoundary)),
    unstrokedEdge: Math.max(0, ...boundary.filter(interior).map(toStroke)),
  };
}

beforeEach(installRecordingCanvas);
afterEach(uninstallRecordingCanvas);

describe('Wrap CDS zoom silhouette', () => {
  const cases = [
    { label: 'forward', annotation: cds('cdsA', 3001, 4500, 1), circular: false },
    { label: 'reverse', annotation: cds('cdsA', 3001, 4500, -1), circular: false },
    { label: 'origin-crossing', annotation: cds('cdsA', 11001, 1500, 1), circular: true },
  ];

  it.each(cases.flatMap((c) => ZOOMS.map((charWidth) => ({ ...c, charWidth }))))(
    'strokes exactly the painted $label CDS once per wrapped fragment at $charWidth px/bp',
    ({ annotation, circular, charWidth }) => {
      const { rows, paints } = frame(charWidth, subject([annotation], circular), annotation);
      expect(rows.length, `rows at ${charWidth}px/bp`).toBeGreaterThan(0);
      for (const row of rows) {
        const result = silhouetteMismatch(paints, rowBand(row));
        const where = `${charWidth}px/bp row ${row.lineIndex}`;
        expect(result.outlinePolygons, where).toBe(1);
        expect(result.strayStroke, where).toBeLessThanOrEqual(1.25);
        expect(result.unstrokedEdge, where).toBeLessThanOrEqual(1.5);
      }
    }
  );

  it('crossfades the compact body into codon colors without exposing extra background', () => {
    const annotation = cds('cdsA', 3001, 4500, 1);
    let sampled = 0;
    for (const charWidth of [0.315, 0.32, 0.33, 0.34, 0.35, 0.36]) {
      const { presentation, rows, paints } = frame(charWidth, subject([annotation]), annotation);
      const p = presentation.colorAlpha;
      if (p < 0.05 || p > 0.95) continue;
      const fills = cdsFills(paints, rowBand(rows[0]));
      const cells = fills.filter((f) => Math.abs(f.alpha - CODON_ALPHA * p) < 1e-6);
      expect(cells.length, `codon cells at ${charWidth}px/bp`).toBeGreaterThan(10);
      const b = bounds(cells[Math.floor(cells.length / 2)].polygons);
      const probe = { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 };
      const background = fills
        .filter((f) => f.polygons.some((poly) => poly.length > 2 && inside(probe, poly)))
        .reduce((weight, f) => weight * (1 - f.alpha), 1);
      expect(background, `background weight at colorAlpha ${p.toFixed(2)}`).toBeCloseTo(
        p * (1 - CODON_ALPHA),
        2
      );
      sampled++;
    }
    expect(sampled).toBeGreaterThanOrEqual(3);
  });

  it('paints the hovered outline after every neighbouring CDS body and name', () => {
    const first = cds('cdsA', 3001, 4500, 1);
    const second = cds('cdsB', 4502, 6000, 1, '#E8604F');
    for (const charWidth of [0.33, 0.5, 3]) {
      const { rows, paints } = frame(charWidth, subject([first, second]), first);
      const row = rows.find((r) => (r.classifiedCDSs ?? []).some((c) => c.name === 'cdsB'))!;
      const band = rowBand(row);
      const outline = paints.find(
        (p) =>
          isHoverStroke(p) &&
          p.polygons.some((poly) => poly.some((q) => q.y > band.top && q.y < band.bottom))
      )!;
      expect(outline, `${charWidth}px/bp`).toBeDefined();
      const lastFill = Math.max(...cdsFills(paints, band).map((f) => f.index));
      expect(outline.index, `${charWidth}px/bp`).toBeGreaterThan(lastFill);
    }
  });
});
