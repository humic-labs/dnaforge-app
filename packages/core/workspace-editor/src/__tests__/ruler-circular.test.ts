import { describe, expect, it } from 'vitest';
import { compute1DLayout, create1DLayoutAdapter } from '../layout-1d';

const COLUMN_COUNT = 6000;
const PX_PER_BASE = 8;

function makeCircularAdapter() {
  const layout = compute1DLayout({
    columnCount: COLUMN_COUNT,
    annotations: [],
    pxPerBase: PX_PER_BASE,
    isCircular: true,
  });
  return { layout, adapter: create1DLayoutAdapter(layout) };
}

function makeLinearAdapter() {
  const layout = compute1DLayout({
    columnCount: COLUMN_COUNT,
    annotations: [],
    pxPerBase: PX_PER_BASE,
    isCircular: false,
  });
  return { layout, adapter: create1DLayoutAdapter(layout) };
}

describe('getRulerTicks — circular', () => {
  it('labels nucleotide 1 at virtual col 0 when viewport starts at 0', () => {
    const { adapter } = makeCircularAdapter();
    const ticks = adapter.getRulerTicks(0, 100);
    const labels = ticks.map((t) => t.label);
    expect(labels[0]).toBe('1');
  });

  it('labels increment by step within a single cycle, capped at columnCount', () => {
    const { adapter } = makeCircularAdapter();
    const ticks = adapter.getRulerTicks(0, COLUMN_COUNT);
    const labels = ticks.map((t) => t.label);
    expect(labels[0]).toBe('1');
    expect(labels[labels.length - 1]).toBe(String(COLUMN_COUNT));
    for (const label of labels) {
      const n = Number(label);
      expect(Number.isFinite(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(COLUMN_COUNT);
    }
  });

  it('DOES NOT emit labels past columnCount (no "6001", "6002" …)', () => {
    const { adapter } = makeCircularAdapter();
    const ticks = adapter.getRulerTicks(5900, COLUMN_COUNT + 99);
    for (const t of ticks) {
      const n = Number(t.label);
      expect(n).toBeLessThanOrEqual(COLUMN_COUNT);
    }
  });

  it('DOES NOT disappear in the wrap buffer when viewport straddles origin', () => {
    const { adapter } = makeCircularAdapter();
    const ticks = adapter.getRulerTicks(5950, 6099);
    const wrapTicks = ticks.filter((t) => t.position >= COLUMN_COUNT);
    expect(wrapTicks.length).toBeGreaterThan(0);
  });

  it('resumes numbering at "1" at each cycle boundary, not continuing past columnCount', () => {
    const { adapter } = makeCircularAdapter();
    const ticks = adapter.getRulerTicks(5950, 6099);
    const atWrapBoundary = ticks.find((t) => t.position === COLUMN_COUNT);
    expect(atWrapBoundary).toBeDefined();
    expect(atWrapBoundary?.label).toBe('1');
  });

  it('emits ruler ticks on BOTH sides of origin when viewport straddles it', () => {
    const { adapter } = makeCircularAdapter();
    const ticks = adapter.getRulerTicks(5950, 6099);
    const preOrigin = ticks.filter((t) => t.position < COLUMN_COUNT);
    const postOrigin = ticks.filter((t) => t.position >= COLUMN_COUNT);
    expect(preOrigin.length).toBeGreaterThan(0);
    expect(postOrigin.length).toBeGreaterThan(0);

    const preLabels = preOrigin.map((t) => Number(t.label));
    for (let i = 1; i < preLabels.length; i++) {
      expect(preLabels[i]).toBeGreaterThan(preLabels[i - 1]);
      expect(preLabels[i]).toBeLessThanOrEqual(COLUMN_COUNT);
    }
    const postLabels = postOrigin.map((t) => Number(t.label));
    expect(postLabels[0]).toBe(1);
    for (let i = 1; i < postLabels.length; i++) {
      expect(postLabels[i]).toBeGreaterThan(postLabels[i - 1]);
      expect(postLabels[i]).toBeLessThanOrEqual(COLUMN_COUNT);
    }
  });

  it('never emits labels past columnCount across any viewport slice', () => {
    const { adapter } = makeCircularAdapter();
    const slices: Array<[number, number]> = [
      [0, 300],
      [2500, 2900],
      [5800, 6000],
      [5900, 6100],
      [6000, 6300],
      [5500, 7200],
    ];
    for (const [s, e] of slices) {
      const ticks = adapter.getRulerTicks(s, e);
      for (const t of ticks) {
        const n = Number(t.label);
        expect(n, `viewport ${s}-${e}, tick at ${t.position}`).toBeGreaterThanOrEqual(1);
        expect(n, `viewport ${s}-${e}, tick at ${t.position}`).toBeLessThanOrEqual(COLUMN_COUNT);
      }
    }
  });
});

describe('getRulerTicks — linear', () => {
  it('stops ruler at columnCount; never emits ticks past the sequence end', () => {
    const { adapter } = makeLinearAdapter();
    const ticks = adapter.getRulerTicks(5900, 6500);
    for (const t of ticks) {
      expect(t.position).toBeLessThan(COLUMN_COUNT);
      const n = Number(t.label);
      expect(n).toBeLessThanOrEqual(COLUMN_COUNT);
    }
  });
});
