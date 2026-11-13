import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseGenBankFull, type AnnotatedSequence } from '@waypoint/sequence-utils';
import { computeSequenceLayoutImpl } from '../useSequenceLayout';
import { DEFAULT_EDITOR_CONFIG } from '../types';
import {
  getScrollYForSequencePosition,
  continuousCircularScrollY,
  hasCircularScrollBuffers,
} from '../layout-utils';

const FIXTURES = join(__dirname, '../../../../../test-fixtures');
const CIRCULAR = (f: string) => join(FIXTURES, 'sequences/circular', f);
const LINEAR = (f: string) => join(FIXTURES, 'sequences/linear', f);
const WHEEL_PIXEL_SCALE = 0.001;
const CLIENT_H = 600;
const ORIGIN_FIXTURE = 'origin-spanning-synthetic.gb';
const PUC19 = 'pUC19.gb';

function load(path: string): AnnotatedSequence {
  return parseGenBankFull(readFileSync(path, 'utf8')) as AnnotatedSequence;
}
function buildLayout(seq: AnnotatedSequence, virtualRowCount = 12) {
  return computeSequenceLayoutImpl(
    seq,
    { ...DEFAULT_EDITOR_CONFIG, charsPerLine: 100 },
    0,
    virtualRowCount,
    [],
    false,
    [],
    0
  );
}
type L = ReturnType<typeof buildLayout>;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] || 0;
};

function trajectory(
  layout: L,
  pathFn: (pos: number) => number | null,
  opts: { zoom?: number; startFrac: number; notches: number; dir?: 1 | -1; deltaPx?: number }
) {
  const s = layout.summary!;
  const seqLen = s.seqLength;
  const zoom = opts.zoom ?? 1;
  const dir = opts.dir ?? 1;
  const deltaPx = opts.deltaPx ?? 2;
  const vstep = (deltaPx * WHEEL_PIXEL_SCALE) / Math.max(0.1, zoom);
  const realSpan = (layout.bottomBufferStartY ?? 0) - (layout.realRowsStartY ?? 0);
  const scrollHeight = s.rowYOffsets[s.totalRows - 1] + s.rowHeights[s.totalRows - 1];
  const maxScroll = Math.max(0, scrollHeight - CLIENT_H);

  const scrolls: number[] = [];
  let current: number | null = null;
  let crossed = false;
  let prev = ((opts.startFrac % 1) + 1) % 1;
  for (let i = 0; i <= opts.notches; i++) {
    const frac = (((opts.startFrac + dir * i * vstep) % 1) + 1) % 1;
    if (i > 0 && Math.abs(frac - prev) > 0.5) crossed = true;
    prev = frac;
    const centerBp = frac * seqLen;
    const centerBio = Math.max(1, Math.min(seqLen, Math.round(centerBp) + 1));
    const y = pathFn(centerBio - 1);
    if (y == null) continue;
    let ts = Math.max(0, y - CLIENT_H / 2);
    if (current != null && hasCircularScrollBuffers(layout) && realSpan > 0) {
      for (const cand of [ts - realSpan, ts + realSpan]) {
        if (cand < 0 || cand > maxScroll) continue;
        if (Math.abs(cand - current) < Math.abs(ts - current)) ts = cand;
      }
    }
    scrolls.push(ts);
    current = ts;
  }
  const deltas: number[] = [];
  for (let i = 1; i < scrolls.length; i++) deltas.push(Math.abs(scrolls[i] - scrolls[i - 1]));
  const med = median(deltas) || 1e-9;
  const max = Math.max(...deltas);
  return { scrolls, deltas, median: med, max, ratio: max / med, crossed, realSpan };
}

const OLD = (layout: L) => (pos: number) => getScrollYForSequencePosition(pos, layout, true);
const NEW = (layout: L) => (pos: number) => continuousCircularScrollY(pos, layout);

describe(' ① continuous circular scroll', () => {
  describe.each([ORIGIN_FIXTURE, PUC19])('%s', (name) => {
    const layout = buildLayout(load(CIRCULAR(name)));
    const s = layout.summary!;

    it('precondition: circular layout WITH wrap buffers and a full-materialized line list', () => {
      expect(s.isCircular).toBe(true);
      expect(hasCircularScrollBuffers(layout)).toBe(true);
      expect(layout.lines.length).toBe(s.totalRows);
    });

    it('gate fires here (continuousCircularScrollY non-null) even though lines.length === totalRows', () => {
      expect(continuousCircularScrollY(0, layout)).not.toBeNull();
    });

    const CROSS = { notches: 50 } as const;

    it('RED→GREEN: OLD path jumps crossing the origin; NEW path is uniform (identical inputs)', () => {
      const oldT = trajectory(layout, OLD(layout), { startFrac: 0.95, ...CROSS });
      const newT = trajectory(layout, NEW(layout), { startFrac: 0.95, ...CROSS });
      expect(oldT.crossed).toBe(true);
      expect(newT.crossed).toBe(true);
      expect(oldT.ratio).toBeGreaterThan(2.5);
      expect(newT.ratio).toBeLessThanOrEqual(1.6);
      expect(newT.ratio).toBeLessThan(oldT.ratio / 2);
    });

    it('bidirectional: NEW path is uniform crossing the origin in BOTH directions (no clamp stall)', () => {
      const fwd = trajectory(layout, NEW(layout), { startFrac: 0.95, dir: 1, ...CROSS });
      const rev = trajectory(layout, NEW(layout), { startFrac: 0.05, dir: -1, ...CROSS });
      expect(fwd.crossed).toBe(true);
      expect(rev.crossed).toBe(true);
      expect(fwd.ratio).toBeLessThanOrEqual(1.6);
      expect(rev.ratio).toBeLessThanOrEqual(1.6);
      expect(Math.abs(fwd.median - rev.median)).toBeLessThan(1);
    });

    it('away from the seam, NEW is uniform and its rate stays in a sane band of OLD', () => {
      const mid = { startFrac: 0.35, notches: 12, deltaPx: 10 } as const;
      const oldT = trajectory(layout, OLD(layout), mid);
      const newT = trajectory(layout, NEW(layout), mid);
      expect(oldT.crossed).toBe(false);
      expect(newT.crossed).toBe(false);
      expect(newT.ratio).toBeLessThanOrEqual(1.6);
      expect(Math.abs(newT.median - oldT.median) / oldT.median).toBeLessThan(0.25);
    });

    it('zoom-sensitivity preserved: per-notch scroll scales ≈ 1/zoom (finer when zoomed in)', () => {
      const med = (zoom: number) =>
        trajectory(layout, NEW(layout), { startFrac: 0.4, notches: 120, zoom }).median;
      const m1 = med(1);
      const m2 = med(2);
      const mHalf = med(0.5);
      expect(m1 / m2).toBeGreaterThan(1.5);
      expect(m1 / m2).toBeLessThan(2.5);
      expect(mHalf / m1).toBeGreaterThan(1.5);
      expect(mHalf / m1).toBeLessThan(2.5);
    });

    it('snap composition: genome pixel period === realSpan (so the ±realSpan snap cancels the wrap)', () => {
      const realSpan = (layout.bottomBufferStartY ?? 0) - (layout.realRowsStartY ?? 0);
      const realStartY = layout.realRowsStartY ?? 0;
      const pxPerBp = realSpan / s.seqLength;
      const yLast = continuousCircularScrollY((s.seqLength - 1 + s.topBp) % s.seqLength, layout)!;
      expect(yLast - realStartY).toBeCloseTo(realSpan - pxPerBp, 3);
    });
  });

  it('linear sequences are a no-op (override returns null; default centering preserved)', () => {
    const layout = buildLayout(load(LINEAR('ecoli-mg1655-region.gb')));
    expect(hasCircularScrollBuffers(layout)).toBe(false);
    expect(continuousCircularScrollY(100, layout)).toBeNull();
    expect(continuousCircularScrollY(0, layout)).toBeNull();
  });
});
