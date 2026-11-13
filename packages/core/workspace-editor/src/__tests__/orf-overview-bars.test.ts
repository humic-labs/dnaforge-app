// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { drawORFOverviewBars, drawORFTracks } from '../orf-drawing';
import { DEFAULT_EDITOR_CONFIG, type ORFWithLane } from '../types';
import {
  installRecordingCanvas,
  uninstallRecordingCanvas,
  getRecordingLog,
  opsOf,
} from '../testing/recording-canvas-context';

const orf = (overrides: Partial<ORFWithLane> = {}): ORFWithLane => ({
  start: 0,
  end: 26,
  frame: 1,
  strand: '+',
  length: 27,
  lane: 0,
  ...overrides,
});

let canvas: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;

beforeEach(() => {
  installRecordingCanvas();
  canvas = document.createElement('canvas');
  ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
});
afterEach(() => uninstallRecordingCanvas());

const drawBars = (orfs: ORFWithLane[], on: CanvasRenderingContext2D = ctx) => {
  const sequence = 'A'.repeat(60);
  drawORFOverviewBars(on, orfs, 0, 60, 0, 100, DEFAULT_EDITOR_CONFIG, sequence, sequence.length, {
    type: 'normal',
  });
};

function polyPoints(c: HTMLCanvasElement): Array<{ x: number; y: number }> {
  const log = getRecordingLog(c);
  return [
    ...opsOf(log, 'moveTo').map((o) => ({ x: o.x, y: o.y })),
    ...opsOf(log, 'lineTo').map((o) => ({ x: o.x, y: o.y })),
  ];
}

describe('drawORFOverviewBars  feature-level parity)', () => {
  it('emits a flat rect body + one triangle per visible ORF (no outline)', () => {
    drawBars([orf(), orf({ start: 30, end: 56, lane: 1 })]);
    const log = getRecordingLog(canvas);
    expect(opsOf(log, 'fillRect').length).toBe(2);
    expect(opsOf(log, 'fill').length).toBe(2);
    expect(opsOf(log, 'stroke').length).toBe(0);
    expect(opsOf(log, 'strokeRect').length).toBe(0);
  });

  it('bar body is 4 px (WebGL band + 1 px, per user)', () => {
    drawBars([orf()]);
    const rects = opsOf(getRecordingLog(canvas), 'fillRect');
    expect(rects.length).toBe(1);
    expect(rects[0].h).toBe(4);
  });

  it('uses a muted grey (equal RGB channels), not a per-feature hue', () => {
    drawBars([orf()]);
    const log = getRecordingLog(canvas);
    const greys = log
      .filter((e) => e.op === 'set' && e.prop === 'fillStyle')
      .map((e) => (e as { value: string }).value)
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/))
      .filter((m): m is RegExpMatchArray => m !== null);
    expect(greys.length).toBeGreaterThan(0);
    for (const m of greys) {
      expect(m[1]).toBe(m[2]);
      expect(m[2]).toBe(m[3]);
    }
  });

  it('is absent when there are no ORFs (hidden = nothing drawn)', () => {
    drawBars([]);
    const log = getRecordingLog(canvas);
    expect(opsOf(log, 'fillRect').length).toBe(0);
    expect(opsOf(log, 'fill').length).toBe(0);
    expect(opsOf(log, 'lineTo').length).toBe(0);
  });

  it('is a low-detail primitive — far fewer ops than the detailed chevron path', () => {
    const orfs = [orf()];
    const seq = 'A'.repeat(60);
    drawORFOverviewBars(ctx, orfs, 0, 60, 0, 100, DEFAULT_EDITOR_CONFIG, seq, seq.length, {
      type: 'normal',
    });
    const barOps = getRecordingLog(canvas).length;

    const canvas2 = document.createElement('canvas');
    const ctx2 = canvas2.getContext('2d') as CanvasRenderingContext2D;
    drawORFTracks(ctx2, orfs, 0, 60, 0, 100, DEFAULT_EDITOR_CONFIG, seq, seq.length, {
      type: 'normal',
    });
    expect(barOps).toBeLessThan(getRecordingLog(canvas2).length);
  });

  describe('strand arrowhead (direction, not screen order)', () => {
    function apexAndExtremes(c: HTMLCanvasElement) {
      const pts = polyPoints(c);
      const ys = pts.map((p) => p.y);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      const midY = (minY + maxY) / 2;
      const apex = pts.find((p) => Math.abs(p.y - midY) < 0.5)!;
      const xs = pts.map((p) => p.x);
      return { apex, minX: Math.min(...xs), maxX: Math.max(...xs) };
    }

    it('forward ORF points at the HIGHER coordinate (apex at maxX)', () => {
      drawBars([orf({ strand: '+' })]);
      const { apex, maxX } = apexAndExtremes(canvas);
      expect(apex.x).toBeCloseTo(maxX, 5);
    });

    it('reverse ORF points at the LOWER coordinate (apex at minX) — same screen span', () => {
      drawBars([orf({ strand: '-' })]);
      const { apex, minX } = apexAndExtremes(canvas);
      expect(apex.x).toBeCloseTo(minX, 5);
    });

    it('a reverse ORF placed at high columns STILL points left (strand, not screen)', () => {
      drawBars([orf({ start: 30, end: 56, strand: '-' })]);
      const { apex, minX } = apexAndExtremes(canvas);
      expect(apex.x).toBeCloseTo(minX, 5);
    });
  });
});
