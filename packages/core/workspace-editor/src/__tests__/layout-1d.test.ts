import { describe, it, expect } from 'vitest';
import type { Annotation } from '@waypoint/sequence-utils';
import {
  pack1D,
  compute1DLayout,
  create1DLayoutAdapter,
  MAX_LANES_1D,
  MIN_PX_PER_BASE_1D,
  MAX_PX_PER_BASE_1D,
  LANE_HEIGHT_1D,
  LANE_GAP_1D,
  RULER_HEIGHT_1D,
  CUT_SITE_LABEL_ROW_HEIGHT_1D,
} from '../layout-1d';

function ann(name: string, start: number, end: number): Annotation {
  return { name, type: 'misc_feature', start, end, direction: 1 };
}

function idOf(a: Annotation): string {
  return `${a.name}:${a.start}-${a.end}:${a.direction ?? 1}`;
}

describe('pack1D', () => {
  it('places non-overlapping features all in lane 0', () => {
    const a = ann('a', 1, 10);
    const b = ann('b', 20, 30);
    const c = ann('c', 40, 50);
    const { placed, laneCount, hasOverflow } = pack1D([a, b, c], 60);
    expect(laneCount).toBe(1);
    expect(hasOverflow).toBe(false);
    expect(placed.map((p) => p.lane)).toEqual([0, 0, 0]);
  });

  it('nested overlapping features go to higher lanes', () => {
    const outer = ann('outer', 1, 100);
    const inner = ann('inner', 10, 90);
    const deep = ann('deep', 20, 80);
    const { placed, laneCount } = pack1D([outer, inner, deep], 120);
    expect(laneCount).toBe(3);
    const byName = Object.fromEntries(placed.map((p) => [p.name, p.lane]));
    expect(byName.outer).toBe(0);
    expect(byName.inner).toBe(1);
    expect(byName.deep).toBe(2);
  });

  it('ties on length broken by earliest start winning lane 0', () => {
    const first = ann('first', 1, 10);
    const tied = ann('tied', 5, 14);
    const { placed } = pack1D([tied, first], 20);
    const byName = Object.fromEntries(placed.map((p) => [p.name, p.lane]));
    expect(byName.first).toBe(0);
    expect(byName.tied).toBe(1);
  });

  it('overflow collapses the shortest features first when lanes exceed cap', () => {
    const anns: Annotation[] = [];
    for (let i = 0; i < MAX_LANES_1D; i++) {
      anns.push(ann(`big${i}`, 1, 50 - i));
    }
    const shortExtra = ann('short', 20, 25);
    anns.push(shortExtra);

    const { placed, laneCount, hasOverflow, overflowCounts } = pack1D(anns, 60);
    expect(laneCount).toBe(MAX_LANES_1D);
    expect(hasOverflow).toBe(true);
    expect(placed.find((p) => p.name === 'short')).toBeUndefined();
    for (let c = 19; c < 25; c++) expect(overflowCounts[c]).toBeGreaterThanOrEqual(1);
    expect(overflowCounts[0]).toBe(0);
  });

  it('selected feature is promoted over longer non-selected when cap is saturated', () => {
    const anns: Annotation[] = [];
    for (let i = 0; i < MAX_LANES_1D; i++) {
      anns.push(ann(`big${i}`, 1, 50 - i));
    }
    const selectedShort = ann('sel', 20, 25);
    anns.push(selectedShort);

    const { placed, hasOverflow } = pack1D(anns, 60, new Set([idOf(selectedShort)]));
    expect(placed.find((p) => p.name === 'sel')).toBeDefined();
    expect(hasOverflow).toBe(true);
  });

  it('empty input returns empty layout with no overflow', () => {
    const { placed, laneCount, hasOverflow, overflowCounts } = pack1D([], 100);
    expect(placed).toEqual([]);
    expect(laneCount).toBe(0);
    expect(hasOverflow).toBe(false);
    expect(overflowCounts.length).toBe(100);
  });
});

describe('compute1DLayout', () => {
  it('computes total dimensions from columnCount and pxPerBase', () => {
    const layout = compute1DLayout({ columnCount: 100, annotations: [], pxPerBase: 8 });
    expect(layout.pxPerBase).toBe(8);
    expect(layout.totalWidth).toBeGreaterThanOrEqual(100 * 8);
  });

  it('clamps pxPerBase to allowed range', () => {
    const lo = compute1DLayout({ columnCount: 10, annotations: [], pxPerBase: 0.1 });
    const hi = compute1DLayout({ columnCount: 10, annotations: [], pxPerBase: 999 });
    expect(lo.pxPerBase).toBe(MIN_PX_PER_BASE_1D);
    expect(hi.pxPerBase).toBe(MAX_PX_PER_BASE_1D);
  });

  it('allocates band positions in order: overflow (if any), lanes, sequence, ruler', () => {
    const a = ann('a', 1, 10);
    const layout = compute1DLayout({ columnCount: 20, annotations: [a], pxPerBase: 8 });
    expect(layout.laneBandTop).toBeLessThanOrEqual(layout.sequenceRowY);
    expect(layout.sequenceRowY).toBeLessThan(layout.rulerY);
  });

  it('removes the ruler band from total height when showRuler is false', () => {
    const withRuler = compute1DLayout({
      columnCount: 20,
      annotations: [],
      pxPerBase: 8,
      showReverseComplement: true,
      showRuler: true,
    });
    const withoutRuler = compute1DLayout({
      columnCount: 20,
      annotations: [],
      pxPerBase: 8,
      showReverseComplement: true,
      showRuler: false,
    });

    expect(withoutRuler.rulerY).toBe(withRuler.rulerY);
    expect(withoutRuler.totalHeight).toBe(withRuler.totalHeight - RULER_HEIGHT_1D);
  });

  it('keeps Golden Gate primer cut labels in the layout when the ruler is hidden', () => {
    const base = compute1DLayout({
      columnCount: 40,
      annotations: [],
      pxPerBase: 8,
      showReverseComplement: true,
      showRuler: false,
      showPrimers: true,
      primers: [
        {
          id: 'forward-gg',
          name: 'forward-gg',
          start: 8,
          end: 30,
          direction: 'forward',
          bases: 'GGTCTCAAACCCGGGTTTAAA',
          tm: 60,
          gc: 50,
          overhangLength: 12,
          cutPositionInOverhang: 8,
          enzymeName: 'BsaI',
        },
        {
          id: 'reverse-gg',
          name: 'reverse-gg',
          start: 10,
          end: 32,
          direction: 'reverse',
          bases: 'GGTCTCAAACCCGGGTTTAAA',
          tm: 60,
          gc: 50,
          overhangLength: 12,
          cutPositionInOverhang: 8,
          enzymeName: 'BsaI',
        },
      ],
    });
    const suppressed = compute1DLayout({
      columnCount: 40,
      annotations: [],
      pxPerBase: 8,
      showReverseComplement: true,
      showRuler: false,
      showPrimers: true,
      primers: [
        {
          id: 'forward-gg',
          name: 'forward-gg',
          start: 8,
          end: 30,
          direction: 'forward',
          bases: 'GGTCTCAAACCCGGGTTTAAA',
          tm: 60,
          gc: 50,
          overhangLength: 12,
          cutPositionInOverhang: 8,
          enzymeName: 'BsaI',
          suppressCutSiteRendering: true,
        },
        {
          id: 'reverse-gg',
          name: 'reverse-gg',
          start: 10,
          end: 32,
          direction: 'reverse',
          bases: 'GGTCTCAAACCCGGGTTTAAA',
          tm: 60,
          gc: 50,
          overhangLength: 12,
          cutPositionInOverhang: 8,
          enzymeName: 'BsaI',
        },
      ],
    });

    expect(base.cutSiteLabelRowHeight).toBe(CUT_SITE_LABEL_ROW_HEIGHT_1D);
    expect(base.totalHeight).toBe(suppressed.totalHeight + CUT_SITE_LABEL_ROW_HEIGHT_1D + 2);
  });

  it('renders circular sequences linearly (no wrap, no infinite scroll)', () => {
    const wrap: Annotation = {
      name: 'wrap',
      type: 'misc_feature',
      start: 90,
      end: 10,
      direction: 1,
    };
    const layout = compute1DLayout({ columnCount: 100, annotations: [wrap], pxPerBase: 4 });
    expect(layout.totalWidth).toBeGreaterThan(0);
  });
});

describe('create1DLayoutAdapter', () => {
  it('getRectsForBaseRange returns one segment at correct x/width', () => {
    const snap = compute1DLayout({ columnCount: 100, annotations: [], pxPerBase: 8 });
    const adapter = create1DLayoutAdapter(snap);
    const rects = adapter.getRectsForBaseRange(5, 15);
    expect(rects).toHaveLength(1);
    expect(rects[0].width).toBe(80);
    expect(rects[0].baseStart).toBe(5);
    expect(rects[0].baseEnd).toBe(15);
    expect(rects[0].startsAtRangeStart).toBe(true);
    expect(rects[0].endsAtRangeEnd).toBe(true);
  });

  it('getRectsForBaseRange clamps to columnCount', () => {
    const snap = compute1DLayout({ columnCount: 50, annotations: [], pxPerBase: 4 });
    const adapter = create1DLayoutAdapter(snap);
    const rects = adapter.getRectsForBaseRange(45, 100);
    expect(rects).toHaveLength(1);
    expect(rects[0].baseEnd).toBe(50);
    expect(rects[0].endsAtRangeEnd).toBe(false);
  });

  it('getBaseAtPoint returns column under pixel, lane when in lane band', () => {
    const a = ann('a', 1, 10);
    const snap = compute1DLayout({ columnCount: 100, annotations: [a], pxPerBase: 8 });
    const adapter = create1DLayoutAdapter(snap);

    const hitSeq = adapter.getBaseAtPoint(88, snap.sequenceRowY + 5);
    expect(hitSeq?.baseIndex).toBe(10);
    expect(hitSeq?.laneIndex).toBeUndefined();

    const hitLane = adapter.getBaseAtPoint(24, snap.laneBandTop + 3);
    expect(hitLane?.baseIndex).toBe(2);
    expect(hitLane?.laneIndex).toBe(0);
  });

  it('getBaseAtPoint returns null outside layout', () => {
    const snap = compute1DLayout({ columnCount: 100, annotations: [], pxPerBase: 8 });
    const adapter = create1DLayoutAdapter(snap);
    expect(adapter.getBaseAtPoint(0, 0)).toBeNull();
    expect(adapter.getBaseAtPoint(-5, snap.sequenceRowY)).toBeNull();
    expect(adapter.getBaseAtPoint(99999, snap.sequenceRowY)).toBeNull();
  });

  it('getRulerTicks returns ticks at pickTickStep intervals within viewport', () => {
    const snap = compute1DLayout({ columnCount: 500, annotations: [], pxPerBase: 8 });
    const adapter = create1DLayoutAdapter(snap);
    const ticks = adapter.getRulerTicks(0, 100);
    expect(ticks.length).toBeGreaterThan(0);
    const step = ticks[2] ? Number(ticks[2].label) - Number(ticks[1].label) : 5;
    for (const t of ticks) {
      const label = Number(t.label);
      expect(label === 1 || label % step === 0).toBe(true);
      expect(t.position).toBe(label - 1);
    }
  });
});

describe('gapped coordinate space (column-based)', () => {
  it('uses columnCount independent of biological sequence length', () => {
    const layout = compute1DLayout({
      columnCount: 120,
      annotations: [ann('a', 1, 30)],
      pxPerBase: 8,
    });
    expect(layout.columnCount).toBe(120);
    expect(layout.totalWidth).toBeGreaterThanOrEqual(120 * 8);
  });
});

describe('lane band geometry', () => {
  it('laneBandHeight = 0 when no annotations', () => {
    const layout = compute1DLayout({ columnCount: 10, annotations: [], pxPerBase: 8 });
    expect(layout.laneBandHeight).toBe(0);
    expect(layout.laneCount).toBe(0);
  });

  it('laneBandHeight scales with laneCount', () => {
    const anns = [ann('a', 1, 10), ann('b', 2, 9), ann('c', 3, 8)];
    const layout = compute1DLayout({ columnCount: 20, annotations: anns, pxPerBase: 8 });
    const expected = layout.laneCount * (LANE_HEIGHT_1D + LANE_GAP_1D) - LANE_GAP_1D;
    expect(layout.laneBandHeight).toBe(expected);
  });
});
