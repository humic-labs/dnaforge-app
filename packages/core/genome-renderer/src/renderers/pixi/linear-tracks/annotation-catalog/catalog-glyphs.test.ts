import { describe, expect, it } from 'vitest';

import type {
  AnnotationEvidenceClass,
  CatalogRecord,
} from '@waypoint/genome-data/annotation-catalog';

import { deriveCatalogTrackData, recordAnchorEdgeBp } from './catalog-derived-data';
import { createCatalogGlyphBatches, type CatalogGlyphBatches } from './catalog-glyph-batches';
import {
  CATALOG_MIN_BRACKET_WIDTH_PX,
  CATALOG_MIN_TICK_FRACTION,
  CATALOG_POINT_GLYPH_WIDTH_PX,
  drawIntervalBox,
  drawPositionTick,
  drawPromoterArrow,
  drawTerminatorHairpin,
  drawTranscriptionUnitArrow,
  type CatalogGlyphDrawer,
  type CatalogGlyphFrame,
} from './catalog-glyphs';
import {
  catalogTrackData,
  promoterRecord,
  terminatorRecord,
  tssRecord,
  unitRecord,
} from './catalog-test-fixtures';
import type { AnnotationCatalogGeneSpan } from './types';

const ROW = 16;
const BASELINE = 20;
const TOP = BASELINE - ROW;
const BOTTOM = BASELINE + ROW;

function frame(overrides: Partial<CatalogGlyphFrame> = {}): CatalogGlyphFrame {
  return {
    viewStartBp: 0,
    pixelsPerBp: 1,
    rows: { rowHeightPx: ROW, forwardRows: 1, reverseRows: 1, baselineYPx: BASELINE },
    genesByName: new Map(),
    scoreScale: null,
    ...overrides,
  };
}

function draw(
  drawer: CatalogGlyphDrawer,
  record: CatalogRecord,
  options: {
    frame?: CatalogGlyphFrame;
    recordIndex?: number;
    lane?: number;
    evidence?: AnnotationEvidenceClass;
  } = {}
): CatalogGlyphBatches {
  const batches = createCatalogGlyphBatches({
    color: 0x22c55e,
    evidence: options.evidence ?? 'measured',
    themeMode: 'light',
  });
  drawer(
    batches,
    options.frame ?? frame(),
    record,
    options.recordIndex ?? 0,
    options.lane ?? 0,
    recordAnchorEdgeBp(record)
  );
  return batches;
}

function groups(values: number[], size: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

function ys(batches: CatalogGlyphBatches): number[] {
  const values: number[] = [];
  for (const [, y0, , y1] of groups(batches.line.segments, 4)) values.push(y0, y1);
  for (const [, y, , h] of groups(batches.body.rects, 4)) values.push(y, y + h);
  for (let i = 1; i < batches.body.polygonPoints.length; i += 2) {
    values.push(batches.body.polygonPoints[i]);
  }
  return values;
}

describe('drawPromoterArrow', () => {
  it('raises a forward stem from the baseline at the +1 base and points the arm right', () => {
    const record = promoterRecord({ start: 40, end: 101, transcriptionStartBp: 100 });
    const batches = draw(drawPromoterArrow, record);
    const [stem, arm] = groups(batches.line.segments, 4);

    expect(stem[0]).toBe(100);
    expect(stem[1]).toBe(BASELINE);
    expect(stem[2]).toBe(100);
    expect(stem[3]).toBeLessThan(BASELINE);
    expect(arm[0]).toBe(100);
    expect(arm[2]).toBeGreaterThan(100);
    const head = batches.body.polygonPoints;
    expect(batches.body.polygonSizes).toEqual([3]);
    expect(head[2]).toBeGreaterThan(arm[2]);
    for (const y of ys(batches)) {
      expect(y).toBeGreaterThanOrEqual(TOP);
      expect(y).toBeLessThanOrEqual(BASELINE);
    }
  });

  it('hangs a reverse stem below the baseline and points the arm left', () => {
    const record = promoterRecord({ start: 99, end: 160, strand: '-', transcriptionStartBp: 99 });
    const batches = draw(drawPromoterArrow, record);
    const [stem, arm] = groups(batches.line.segments, 4);

    expect(stem[0]).toBe(100);
    expect(stem[3]).toBeGreaterThan(BASELINE);
    expect(arm[2]).toBeLessThan(100);
    expect(batches.body.polygonPoints[2]).toBeLessThan(arm[2]);
    for (const y of ys(batches)) {
      expect(y).toBeGreaterThanOrEqual(BASELINE);
      expect(y).toBeLessThanOrEqual(BOTTOM);
    }
  });

  it('draws a faint band over the promoter window and a block per -10 or -35 element', () => {
    const record = promoterRecord({
      start: 40,
      end: 101,
      transcriptionStartBp: 100,
      boxes: [
        { element: 'minus35', start: 60, end: 66 },
        { element: 'minus10', start: 83, end: 89 },
      ],
    });
    const batches = draw(drawPromoterArrow, record);
    const [band] = groups(batches.band.rects, 4);
    expect(band[0]).toBe(40);
    expect(band[2]).toBe(61);
    expect(band[1] + band[3]).toBe(BASELINE);
    expect(groups(batches.body.rects, 4).map(([x, , w]) => [x, w])).toEqual([
      [60, 6],
      [83, 6],
    ]);
  });

  it('draws a start site as the arrow alone', () => {
    const batches = draw(drawPromoterArrow, tssRecord(500));
    expect(batches.band.shapeCount).toBe(0);
    expect(batches.body.rects).toHaveLength(0);
    expect(batches.line.segments[0]).toBe(500);
  });

  it('falls back to a box for a kind it does not draw', () => {
    const batches = draw(drawPromoterArrow, unitRecord({ start: 0, end: 50 }));
    expect(batches.line.shapeCount).toBe(0);
    expect(batches.body.polygonSizes).toEqual([5]);
  });
});

describe('drawTerminatorHairpin', () => {
  it('stands an intrinsic stem-loop on the 3-prime edge', () => {
    const batches = draw(drawTerminatorHairpin, terminatorRecord({ start: 200, end: 240 }));
    const [stem] = groups(batches.line.segments, 4);
    const [loop] = groups(batches.body.circles, 3);
    expect(stem[0]).toBe(240);
    expect(stem[1]).toBe(BASELINE);
    expect(loop[0]).toBe(240);
    expect(loop[1]).toBeLessThan(stem[3]);
    expect(loop[1] - loop[2]).toBeGreaterThanOrEqual(TOP);
  });

  it('stands the stem-loop on the measured 3-prime end when the source gives one', () => {
    const forward = draw(
      drawTerminatorHairpin,
      terminatorRecord({ start: 100, end: 130, terminationBp: 118 })
    );
    const [stem] = groups(forward.line.segments, 4);
    const [loop] = groups(forward.body.circles, 3);
    expect(stem[0]).toBe(119);
    expect(stem[2]).toBe(119);
    expect(loop[0]).toBe(119);

    const reverse = draw(
      drawTerminatorHairpin,
      terminatorRecord({ start: 100, end: 130, strand: '-', terminationBp: 118 })
    );
    const [reverseLoop] = groups(reverse.body.circles, 3);
    expect(reverse.line.segments[0]).toBe(118);
    expect(reverseLoop[0]).toBe(118);
    expect(reverseLoop[1]).toBeGreaterThan(BASELINE);
  });

  it('puts an unclassified T on the measured end too', () => {
    const batches = draw(
      drawTerminatorHairpin,
      terminatorRecord({ start: 100, end: 130, mechanism: 'unclassified', terminationBp: 118 })
    );
    const [stem, bar] = groups(batches.line.segments, 4);
    expect(stem[0]).toBe(119);
    expect((bar[0] + bar[2]) / 2).toBe(119);
  });

  it('hangs a reverse stem-loop below the baseline at the left edge', () => {
    const batches = draw(
      drawTerminatorHairpin,
      terminatorRecord({ start: 200, end: 240, strand: '-' })
    );
    const [loop] = groups(batches.body.circles, 3);
    expect(loop[0]).toBe(200);
    expect(loop[1]).toBeGreaterThan(BASELINE);
    expect(loop[1] + loop[2]).toBeLessThanOrEqual(BOTTOM);
  });

  it('brackets a Rho-dependent region and widens a point-sized one', () => {
    const region = draw(
      drawTerminatorHairpin,
      terminatorRecord({ start: 300, end: 420, mechanism: 'rho-dependent' })
    );
    const segments = groups(region.line.segments, 4);
    expect(segments).toHaveLength(3);
    expect(segments[1][0]).toBe(300);
    expect(segments[1][2]).toBe(420);
    expect(region.body.shapeCount).toBe(0);

    const point = draw(
      drawTerminatorHairpin,
      terminatorRecord({ start: 300, end: 301, mechanism: 'rho-dependent', point: true })
    );
    const [, bar] = groups(point.line.segments, 4);
    expect(bar[2] - bar[0]).toBe(CATALOG_MIN_BRACKET_WIDTH_PX);
  });

  it('draws an unclassified terminator as a plain T, unless a stem or loop is annotated', () => {
    const plain = draw(
      drawTerminatorHairpin,
      terminatorRecord({ start: 10, end: 40, mechanism: 'unclassified' })
    );
    expect(plain.body.circles).toHaveLength(0);
    expect(groups(plain.line.segments, 4)).toHaveLength(2);

    const withLoop = draw(
      drawTerminatorHairpin,
      terminatorRecord({
        start: 10,
        end: 40,
        mechanism: 'unclassified',
        parts: [{ element: 'loop', start: 20, end: 24 }],
      })
    );
    expect(withLoop.body.circles).toHaveLength(3);
  });
});

describe('drawPositionTick', () => {
  it('draws a uniform tick when the dataset has no scores', () => {
    const batches = draw(drawPositionTick, tssRecord(70));
    expect(batches.thinLine.segments).toEqual([70, BASELINE, 70, BASELINE - (ROW - 1)]);
  });

  it('scales tick height with score, keeping the lowest visible', () => {
    const records = [tssRecord(0, '+', 1), tssRecord(10, '+', 100), tssRecord(20, '-', 10_000)];
    const scoreScale = deriveCatalogTrackData(
      catalogTrackData({ kind: 'tss', records })
    ).scoreScale;
    const heights = records.map((record) => {
      const [, y0, , y1] = draw(drawPositionTick, record, { frame: frame({ scoreScale }) }).thinLine
        .segments;
      return Math.abs(y1 - y0);
    });
    expect(heights[0]).toBeCloseTo((ROW - 1) * CATALOG_MIN_TICK_FRACTION);
    expect(heights[1]).toBeGreaterThan(heights[0]);
    expect(heights[2]).toBeCloseTo(ROW - 1);

    const [, y0, , y1] = draw(drawPositionTick, records[2], { frame: frame({ scoreScale }) })
      .thinLine.segments;
    expect(y1).toBeGreaterThan(y0);
  });
});

describe('drawIntervalBox', () => {
  it('draws a forward region as a box with its tip at the right end', () => {
    const batches = draw(drawIntervalBox, unitRecord({ start: 10, end: 60 }));
    const points = batches.body.polygonPoints;
    expect(batches.body.polygonSizes).toEqual([5]);
    const xs = groups(points, 2).map(([x]) => x);
    expect(Math.min(...xs)).toBe(10);
    expect(Math.max(...xs)).toBe(60);
    expect(points[4]).toBe(60);
    for (const [, y] of groups(points, 2)) {
      expect(y).toBeGreaterThanOrEqual(TOP);
      expect(y).toBeLessThanOrEqual(BASELINE);
    }
  });

  it('puts a reverse tip at the left end, below the baseline', () => {
    const batches = draw(drawIntervalBox, unitRecord({ start: 10, end: 60, strand: '-' }));
    const [tipX, tipY] = batches.body.polygonPoints;
    expect(tipX).toBe(10);
    expect(tipY).toBeGreaterThan(BASELINE);
  });

  it('draws a region narrower than 3 px as a plain rectangle of at least 1 px', () => {
    const batches = draw(drawIntervalBox, unitRecord({ start: 10, end: 11 }), {
      frame: frame({ pixelsPerBp: 0.1 }),
    });
    expect(batches.body.polygonSizes).toHaveLength(0);
    expect(batches.body.rects[2]).toBe(1);
  });

  it('draws a single base as a triangle pointing along its strand', () => {
    const forward = draw(drawIntervalBox, tssRecord(100));
    const [backX, , tipX] = forward.body.polygonPoints;
    expect(tipX - backX).toBe(CATALOG_POINT_GLYPH_WIDTH_PX);
    expect((tipX + backX) / 2).toBe(100.5);

    const reverse = draw(drawIntervalBox, tssRecord(100, '-'));
    const [rBackX, , rTipX] = reverse.body.polygonPoints;
    expect(rTipX).toBeLessThan(rBackX);
  });

  it('stacks lanes away from the baseline', () => {
    const lane0 = draw(drawIntervalBox, unitRecord({ start: 0, end: 50 }), { lane: 0 });
    const lane1 = draw(drawIntervalBox, unitRecord({ start: 0, end: 50 }), { lane: 1 });
    const top0 = Math.min(...groups(lane0.body.polygonPoints, 2).map(([, y]) => y));
    const top1 = Math.min(...groups(lane1.body.polygonPoints, 2).map(([, y]) => y));
    expect(top0 - top1).toBe(ROW);
  });
});

describe('drawTranscriptionUnitArrow', () => {
  const genes: AnnotationCatalogGeneSpan[] = [
    { name: 'thrL', start: 189, end: 255, strand: '+' },
    { name: 'thrA', start: 336, end: 2799, strand: '+' },
    { name: 'thrB', start: 2800, end: 3733, strand: '+' },
  ];
  const genesByName = new Map(genes.map((gene) => [gene.name, gene]));

  it('draws a line ending in an arrowhead at the 3-prime end', () => {
    const batches = draw(drawTranscriptionUnitArrow, unitRecord({ start: 100, end: 400 }));
    const [line] = groups(batches.line.segments, 4);
    const [, , tipX] = batches.body.polygonPoints;
    expect(line[0]).toBe(100);
    expect(tipX).toBe(400);
    expect(line[2]).toBeLessThan(400);

    const reverse = draw(
      drawTranscriptionUnitArrow,
      unitRecord({ start: 100, end: 400, strand: '-' })
    );
    expect(reverse.body.polygonPoints[2]).toBe(100);
    expect(reverse.line.segments[1]).toBeGreaterThan(BASELINE);
  });

  it('draws the genes it can find as blocks in one color for the unit, clipped to the unit', () => {
    const record = unitRecord({
      start: 200,
      end: 3000,
      genes: ['thrL', 'thrA', 'missing', 'thrB'],
    });
    const batches = draw(drawTranscriptionUnitArrow, record, {
      frame: frame({ genesByName, pixelsPerBp: 0.1, viewStartBp: 0 }),
      recordIndex: 3,
    });
    const used = batches.unitColors.filter((batch) => batch.shapeCount > 0);
    expect(used).toEqual([batches.unitColors[3]]);
    const blocks = groups(batches.unitColors[3].rects, 4);
    expect(blocks).toHaveLength(3);
    expect(blocks[0][0]).toBeCloseTo(20.5);
    expect(blocks[2][0] + blocks[2][2]).toBeCloseTo(299.5);
  });

  it('finds genes by locus tag first, then by name, drawing each gene once', () => {
    const thrA = genes[1];
    const thrB = genes[2];
    const byNameAndTag = new Map<string, AnnotationCatalogGeneSpan>([
      ['thrL', genes[0]],
      ['b0001', genes[0]],
      ['thrA', thrA],
      ['b0002', thrA],
      ['thrB', thrB],
    ]);
    const record = unitRecord({
      start: 100,
      end: 4000,
      genes: ['thrL', 'thrA-old-name', 'thrB'],
      geneLocusTags: ['b0001', 'b0002', 'b1416'],
    });
    const batches = draw(drawTranscriptionUnitArrow, record, {
      frame: frame({ genesByName: byNameAndTag, pixelsPerBp: 1 }),
    });
    const blocks = groups(batches.unitColors[0].rects, 4).map(([x, , w]) => [x, x + w]);
    expect(blocks).toEqual([
      [189.5, 254.5],
      [336.5, 2798.5],
      [2800.5, 3732.5],
    ]);
  });

  it('prefers the locus tag when a name points at a different gene', () => {
    const copyA = { name: 'insI2', start: 200, end: 300, strand: '+' as const };
    const copyB = { name: 'insI2', start: 600, end: 700, strand: '+' as const };
    const map = new Map<string, AnnotationCatalogGeneSpan>([
      ['insI2', copyB],
      ['b0256', copyA],
      ['b0360', copyB],
    ]);
    const record = unitRecord({
      start: 100,
      end: 1000,
      genes: ['insI2'],
      geneLocusTags: ['b0256'],
    });
    const batches = draw(drawTranscriptionUnitArrow, record, {
      frame: frame({ genesByName: map }),
    });
    expect(groups(batches.unitColors[0].rects, 4).map(([x]) => x)).toEqual([200.5]);
  });

  it('gives neighbouring units different colors', () => {
    const record = unitRecord({ start: 200, end: 3000, genes: ['thrA'] });
    const colorOf = (recordIndex: number) => {
      const batches = draw(drawTranscriptionUnitArrow, record, {
        frame: frame({ genesByName }),
        recordIndex,
      });
      return batches.unitColors.find((batch) => batch.shapeCount > 0)!.paint.color;
    };
    expect(colorOf(0)).not.toBe(colorOf(1));
  });
});

describe('computed evidence', () => {
  const lineLength = (segments: number[]) =>
    groups(segments, 4).reduce((sum, [x0, y0, x1, y1]) => sum + Math.hypot(x1 - x0, y1 - y0), 0);

  const cases: [string, CatalogGlyphDrawer, CatalogRecord][] = [
    ['promoter arrow', drawPromoterArrow, promoterRecord({ start: 40, end: 101 })],
    ['intrinsic hairpin', drawTerminatorHairpin, terminatorRecord({ start: 200, end: 240 })],
    [
      'Rho bracket',
      drawTerminatorHairpin,
      terminatorRecord({ start: 300, end: 420, mechanism: 'rho-dependent' }),
    ],
    [
      'unclassified T',
      drawTerminatorHairpin,
      terminatorRecord({ start: 10, end: 40, mechanism: 'unclassified' }),
    ],
    ['score tick', drawPositionTick, tssRecord(70)],
    ['unit line', drawTranscriptionUnitArrow, unitRecord({ start: 100, end: 400 })],
  ];

  it.each(cases)('breaks every line of a computed %s into dashes', (_label, drawer, record) => {
    const measured = draw(drawer, record);
    const computed = draw(drawer, record, { evidence: 'computed' });
    for (const key of ['line', 'thinLine'] as const) {
      const solid = measured[key].segments;
      if (solid.length === 0) {
        expect(computed[key].segments).toHaveLength(0);
        continue;
      }
      for (const [x0, y0, x1, y1] of groups(solid, 4)) {
        if (Math.hypot(x1 - x0, y1 - y0) < 5) continue;
        const pieces = groups(computed[key].segments, 4).filter(
          ([cx0, cy0, cx1, cy1]) =>
            Math.min(cx0, cx1) >= Math.min(x0, x1) &&
            Math.max(cx0, cx1) <= Math.max(x0, x1) &&
            Math.min(cy0, cy1) >= Math.min(y0, y1) &&
            Math.max(cy0, cy1) <= Math.max(y0, y1)
        );
        expect(pieces.length).toBeGreaterThanOrEqual(2);
      }
      expect(lineLength(computed[key].segments)).toBeLessThan(lineLength(solid));
    }
  });
});
