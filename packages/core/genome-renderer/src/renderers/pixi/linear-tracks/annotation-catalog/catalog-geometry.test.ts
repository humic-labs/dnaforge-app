import { describe, expect, it } from 'vitest';

import { decideTrackLod } from '../../lod/lod-policy';
import { createCatalogDensityScratch } from './catalog-density';
import {
  CatalogDataCache,
  buildCatalogDensityBars,
  buildCatalogDetailGlyphs,
  catalogDataUnitBp,
  declutterForZoom,
} from './catalog-geometry';
import { createCatalogGlyphBatches } from './catalog-glyph-batches';
import type { CatalogGlyphFrame } from './catalog-glyphs';
import { fitCatalogRows } from './catalog-rows';
import { catalogTrackData, terminatorRecord, tssRecord, unitRecord } from './catalog-test-fixtures';
import { CATALOG_VISUALIZATION_SPECS } from './catalog-visualizations';
import type { AnnotationCatalogTrackData } from './types';

const spec = (id: string) => CATALOG_VISUALIZATION_SPECS.find((s) => s.id === id)!;

function build(input: {
  data: AnnotationCatalogTrackData;
  specId: string;
  viewStartBp: number;
  viewEndBp: number;
  pixelsPerBp: number;
  maxGlyphs?: number;
}) {
  const cache = new CatalogDataCache();
  const visualization = spec(input.specId);
  const derived = cache.derivedFor(input.data);
  const lanes = cache.lanesFor(input.data, visualization.rowMode, 10);
  const batches = createCatalogGlyphBatches({
    color: 0x22c55e,
    evidence: input.data.evidence,
    themeMode: 'light',
  });
  const frame: CatalogGlyphFrame = {
    viewStartBp: input.viewStartBp,
    pixelsPerBp: input.pixelsPerBp,
    rows: fitCatalogRows({
      forwardRows: lanes.forwardRows,
      reverseRows: lanes.reverseRows,
      preferredRowHeightPx: visualization.defaultRowHeightPx,
      heightPx: 200,
    }),
    genesByName: input.data.genesByName,
    scoreScale: derived.scoreScale,
  };
  const declutter = declutterForZoom({
    memo: null,
    lanes,
    footprints: cache.footprintsFor(input.data, visualization),
    derived,
    pixelsPerBp: input.pixelsPerBp,
  });
  const detail = buildCatalogDetailGlyphs({
    spec: visualization,
    records: input.data.records,
    derived,
    lanes,
    keep: declutter.result.keep,
    frame,
    viewEndBp: input.viewEndBp,
    batches,
    maxGlyphs: input.maxGlyphs ?? 20_000,
  });
  return { detail, batches, frame, derived };
}

describe('catalogDataUnitBp', () => {
  it('uses mean spacing for point-drawn kinds and the median span for transcription units', () => {
    const cache = new CatalogDataCache();
    const tss = catalogTrackData({
      kind: 'tss',
      genomeLengthBp: 4_641_652,
      records: Array.from({ length: 1000 }, (_, i) => tssRecord(i * 4000)),
    });
    expect(catalogDataUnitBp(tss, cache.derivedFor(tss))).toBeCloseTo(4641.652);

    const units = catalogTrackData({
      kind: 'transcription_unit',
      records: [
        unitRecord({ start: 0, end: 900 }),
        unitRecord({ start: 1000, end: 3000 }),
        unitRecord({ start: 5000, end: 50_000 }),
      ],
    });
    expect(catalogDataUnitBp(units, cache.derivedFor(units))).toBe(2000);
  });

  it('switches E. coli-scale start sites to detail once one spacing spans a pixel', () => {
    const cache = new CatalogDataCache();
    const data = catalogTrackData({
      kind: 'tss',
      genomeLengthBp: 4_641_652,
      records: Array.from({ length: 10_000 }, (_, i) => tssRecord(i * 460)),
    });
    const unit = catalogDataUnitBp(data, cache.derivedFor(data));
    const wholeGenome = 1200 / 4_641_652;
    expect(decideTrackLod({ pixelsPerBp: wholeGenome, dataUnitBp: unit })).toBe('aggregate');
    expect(decideTrackLod({ pixelsPerBp: 2 / unit, dataUnitBp: unit })).toBe('detail');
  });
});

describe('buildCatalogDetailGlyphs', () => {
  const data = catalogTrackData({
    kind: 'tss',
    records: [tssRecord(0), tssRecord(100), tssRecord(101), tssRecord(500), tssRecord(5000)],
  });

  it('draws only records in view (plus a small margin) and counts decluttered neighbours', () => {
    const { detail, batches } = build({
      data,
      specId: 'promoter-arrow',
      viewStartBp: 50,
      viewEndBp: 600,
      pixelsPerBp: 1,
    });
    expect(detail).toEqual({ paintedGlyphs: 2, decluttered: 1, glyphCapSkipped: 0 });
    const stemXs = batches.line.segments.filter((_, i) => i % 8 === 0);
    expect(stemXs).toEqual([50, 450]);
  });

  it('draws a glyph whose anchor is just outside the view but within the margin', () => {
    const { detail } = build({
      data,
      specId: 'position-ticks',
      viewStartBp: 505,
      viewEndBp: 1000,
      pixelsPerBp: 1,
    });
    expect(detail.paintedGlyphs).toBe(1);
  });

  it('keeps the same glyphs while panning at one zoom', () => {
    const dense = catalogTrackData({
      kind: 'tss',
      records: Array.from({ length: 400 }, (_, i) => tssRecord(i * 3)),
    });
    const drawnAnchors = (viewStartBp: number) => {
      const { batches } = build({
        data: dense,
        specId: 'position-ticks',
        viewStartBp,
        viewEndBp: viewStartBp + 300,
        pixelsPerBp: 1,
      });
      return batches.thinLine.segments
        .filter((_, i) => i % 4 === 0)
        .map((x) => x + viewStartBp)
        .filter((bp) => bp >= 400 && bp < 600);
    };
    expect(drawnAnchors(350)).toEqual(drawnAnchors(371));
  });

  it('stops drawing at the glyph cap and counts the rest', () => {
    const many = catalogTrackData({
      kind: 'tss',
      records: Array.from({ length: 100 }, (_, i) => tssRecord(i * 10)),
    });
    const { detail } = build({
      data: many,
      specId: 'position-ticks',
      viewStartBp: 0,
      viewEndBp: 1000,
      pixelsPerBp: 1,
      maxGlyphs: 30,
    });
    expect(detail).toEqual({ paintedGlyphs: 30, decluttered: 0, glyphCapSkipped: 70 });
  });

  it('stands terminator glyphs on the measured 3-prime end, not the region edge', () => {
    const terminators = catalogTrackData({
      kind: 'terminator',
      records: [
        terminatorRecord({ start: 100, end: 130, terminationBp: 118 }),
        terminatorRecord({ start: 100, end: 130, strand: '-', terminationBp: 118 }),
        terminatorRecord({ start: 400, end: 430 }),
      ],
    });
    const { detail, batches } = build({
      data: terminators,
      specId: 'terminator-hairpin',
      viewStartBp: 0,
      viewEndBp: 1000,
      pixelsPerBp: 1,
    });
    expect(detail.paintedGlyphs).toBe(3);
    const loopXs = batches.body.circles.filter((_, i) => i % 3 === 0).sort((a, b) => a - b);
    expect(loopXs).toEqual([118, 119, 430]);
  });

  it('culls long transcription units by their span, not only their anchor', () => {
    const units = catalogTrackData({
      kind: 'transcription_unit',
      records: [unitRecord({ start: 0, end: 20_000 }), unitRecord({ start: 30_000, end: 31_000 })],
    });
    const { detail } = build({
      data: units,
      specId: 'transcription-unit-arrows',
      viewStartBp: 10_000,
      viewEndBp: 11_000,
      pixelsPerBp: 1,
    });
    expect(detail.paintedGlyphs).toBe(1);
  });
});

describe('buildCatalogDensityBars', () => {
  it('draws forward bars up and reverse bars down, scaled to the busiest bin in view', () => {
    const data = catalogTrackData({
      kind: 'tss',
      records: [tssRecord(0, '+'), tssRecord(1, '+'), tssRecord(2, '-'), tssRecord(40, '+')],
    });
    const cache = new CatalogDataCache();
    const derived = cache.derivedFor(data);
    const lanes = cache.lanesFor(data, 'strand-rows', 1);
    const rows = fitCatalogRows({
      forwardRows: lanes.forwardRows,
      reverseRows: lanes.reverseRows,
      preferredRowHeightPx: 12,
      heightPx: 100,
    });
    const batches = createCatalogGlyphBatches({
      color: 0x22c55e,
      evidence: 'measured',
      themeMode: 'light',
    });
    const bins = buildCatalogDensityBars({
      derived,
      frame: {
        viewStartBp: 0,
        pixelsPerBp: 0.1,
        rows,
        genesByName: data.genesByName,
        scoreScale: null,
      },
      viewEndBp: 300,
      batches,
      scratch: createCatalogDensityScratch(),
    });
    expect(bins).toBe(3);
    const bars = [];
    for (let i = 0; i < batches.density.rects.length; i += 4) {
      bars.push(batches.density.rects.slice(i, i + 4));
    }
    expect(bars).toEqual([
      [0, rows.baselineYPx - 12, 3, 12],
      [0, rows.baselineYPx, 3, 6],
      [3, rows.baselineYPx - 6, 3, 6],
    ]);
  });
});

describe('buildCatalogDensityBars across strands with different row counts', () => {
  it('draws equal counts at equal heights on both strands', () => {
    const data = catalogTrackData({
      kind: 'transcription_unit',
      records: [
        unitRecord({ start: 0, end: 100 }),
        unitRecord({ start: 10, end: 100 }),
        unitRecord({ start: 0, end: 100, strand: '-' }),
        unitRecord({ start: 10, end: 100, strand: '-' }),
        unitRecord({ start: 20, end: 200, strand: '-' }),
      ],
    });
    const cache = new CatalogDataCache();
    const lanes = cache.lanesFor(data, 'stacked', 10);
    const rows = fitCatalogRows({
      forwardRows: lanes.forwardRows,
      reverseRows: lanes.reverseRows,
      preferredRowHeightPx: 12,
      heightPx: 100,
    });
    expect(rows).toMatchObject({ forwardRows: 2, reverseRows: 3, rowHeightPx: 12 });
    const batches = createCatalogGlyphBatches({
      color: 0x22c55e,
      evidence: 'measured',
      themeMode: 'light',
    });
    const bins = buildCatalogDensityBars({
      derived: cache.derivedFor(data),
      frame: {
        viewStartBp: 0,
        pixelsPerBp: 0.1,
        rows,
        genesByName: data.genesByName,
        scoreScale: null,
      },
      viewEndBp: 300,
      batches,
      scratch: createCatalogDensityScratch(),
    });
    expect(bins).toBe(3);
    const bars = [];
    for (let i = 0; i < batches.density.rects.length; i += 4) {
      bars.push(batches.density.rects.slice(i, i + 4));
    }
    expect(bars).toEqual([
      [0, rows.baselineYPx - 24, 3, 24],
      [9, rows.baselineYPx, 3, 24],
      [18, rows.baselineYPx, 3, 12],
    ]);
  });
});

describe('CatalogDataCache', () => {
  it('reuses derived arrays and lanes per data object and row limit', () => {
    const cache = new CatalogDataCache();
    const data = catalogTrackData({
      kind: 'transcription_unit',
      records: [unitRecord({ start: 0, end: 10 }), unitRecord({ start: 0, end: 10 })],
    });
    expect(cache.derivedFor(data)).toBe(cache.derivedFor(data));
    expect(cache.lanesFor(data, 'stacked', 4)).toBe(cache.lanesFor(data, 'stacked', 4));
    expect(cache.lanesFor(data, 'stacked', 1)).not.toBe(cache.lanesFor(data, 'stacked', 4));
    expect(cache.lanesFor(data, 'stacked', 1).overflowed).toBe(1);
  });

  it('reuses a declutter pass while the zoom is unchanged', () => {
    const cache = new CatalogDataCache();
    const data = catalogTrackData({ kind: 'tss', records: [tssRecord(0), tssRecord(2)] });
    const visualization = spec('position-ticks');
    const input = {
      lanes: cache.lanesFor(data, visualization.rowMode, 1),
      footprints: cache.footprintsFor(data, visualization),
      derived: cache.derivedFor(data),
    };
    const first = declutterForZoom({ ...input, memo: null, pixelsPerBp: 1 });
    expect(declutterForZoom({ ...input, memo: first, pixelsPerBp: 1 })).toBe(first);
    const zoomed = declutterForZoom({ ...input, memo: first, pixelsPerBp: 3 });
    expect(zoomed).not.toBe(first);
    expect(first.result.kept).toBe(1);
    expect(zoomed.result.kept).toBe(2);
  });
});
