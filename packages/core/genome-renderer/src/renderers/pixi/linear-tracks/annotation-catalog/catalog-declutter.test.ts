import { describe, expect, it } from 'vitest';

import type { CatalogRecord } from '@waypoint/genome-data/annotation-catalog';

import { deriveCatalogTrackData } from './catalog-derived-data';
import {
  catalogFootprints,
  declutterCatalogGlyphs,
  type CatalogDeclutterRule,
} from './catalog-declutter';
import { assignCatalogLanes, type CatalogRowMode } from './catalog-rows';
import {
  catalogTrackData,
  seededIntegers,
  terminatorRecord,
  tssRecord,
  unitRecord,
} from './catalog-test-fixtures';
import type { AnnotationCatalogTrackData } from './types';

const ANCHOR_RULE: CatalogDeclutterRule = { by: 'anchor', minGapPx: 4 };
const SPAN_RULE: CatalogDeclutterRule = {
  by: 'span',
  minGapPx: 0,
  minWidthPx: 1,
  pointWidthPx: 6,
};

function declutter(
  data: AnnotationCatalogTrackData,
  rule: CatalogDeclutterRule,
  mode: CatalogRowMode,
  pixelsPerBp: number,
  maxRowsPerStrand = 10
) {
  const derived = deriveCatalogTrackData(data);
  const lanes = assignCatalogLanes({ derived, mode, maxRowsPerStrand });
  const result = declutterCatalogGlyphs({
    footprints: catalogFootprints(data.records, derived, rule),
    lanes,
    forward: derived.forward,
    pixelsPerBp,
  });
  const keptIds = data.records.filter((_, i) => result.keep[i] === 1).map((r) => r.id);
  return { derived, lanes, result, keptIds };
}

describe('declutterCatalogGlyphs — point glyphs', () => {
  it('keeps anchors at least 4 px apart, greedily from the left', () => {
    const data = catalogTrackData({
      kind: 'tss',
      records: Array.from({ length: 10 }, (_, bp) => tssRecord(bp)),
    });
    const { keptIds, result } = declutter(data, ANCHOR_RULE, 'strand-rows', 1);
    expect(keptIds).toEqual(['tss:+:0', 'tss:+:4', 'tss:+:8']);
    expect(result.kept).toBe(3);
  });

  it('declutters each strand row on its own', () => {
    const data = catalogTrackData({
      kind: 'tss',
      records: [tssRecord(10, '+'), tssRecord(10, '-'), tssRecord(11, '+')],
    });
    const { keptIds } = declutter(data, ANCHOR_RULE, 'strand-rows', 1);
    expect(keptIds.sort()).toEqual(['tss:+:10', 'tss:-:10']);
  });

  it('never keeps two anchors in one row closer than the gap, at any zoom', () => {
    const records: CatalogRecord[] = seededIntegers(7, 2000, 50_000).map((bp, i) =>
      terminatorRecord({ start: bp, end: bp + 30, strand: i % 3 === 0 ? '-' : '+' })
    );
    const data = catalogTrackData({ kind: 'terminator', records });
    for (const pixelsPerBp of [0.05, 0.3, 1, 7]) {
      const { derived, result } = declutter(data, ANCHOR_RULE, 'strand-rows', pixelsPerBp);
      for (const strand of [1, 0]) {
        const xs = data.records
          .map((_, i) => i)
          .filter((i) => result.keep[i] === 1 && derived.forward[i] === strand)
          .map((i) => derived.anchorEdges[i] * pixelsPerBp)
          .sort((a, b) => a - b);
        for (let k = 1; k < xs.length; k++) {
          expect(xs[k] - xs[k - 1]).toBeGreaterThanOrEqual(4 - 1e-6);
        }
      }
      expect(result.kept).toBeGreaterThan(0);
    }
  });
});

describe('declutterCatalogGlyphs — span glyphs', () => {
  it('keeps abutting units in one row', () => {
    const data = catalogTrackData({
      kind: 'transcription_unit',
      records: [unitRecord({ start: 0, end: 100 }), unitRecord({ start: 100, end: 250 })],
    });
    const { keptIds } = declutter(data, SPAN_RULE, 'stacked', 0.37);
    expect(keptIds).toHaveLength(2);
  });

  it('drops a unit that would overlap its row neighbour on screen when zoomed out', () => {
    const data = catalogTrackData({
      kind: 'transcription_unit',
      records: [
        unitRecord({ start: 0, end: 100 }),
        unitRecord({ start: 110, end: 120 }),
        unitRecord({ start: 5000, end: 6000 }),
      ],
    });
    const zoomedOut = declutter(data, SPAN_RULE, 'stacked', 0.001);
    expect(zoomedOut.keptIds).toEqual(['unit:+:0-100', 'unit:+:5000-6000']);
    const zoomedIn = declutter(data, SPAN_RULE, 'stacked', 1);
    expect(zoomedIn.keptIds).toHaveLength(3);
  });

  it('gives single-base records the point glyph width', () => {
    const data = catalogTrackData({ kind: 'tss', records: [tssRecord(0), tssRecord(4)] });
    expect(declutter(data, SPAN_RULE, 'stacked', 1).keptIds).toEqual(['tss:+:0']);
    expect(declutter(data, SPAN_RULE, 'stacked', 2).keptIds).toHaveLength(2);
  });

  it('never keeps overflowed records', () => {
    const data = catalogTrackData({
      kind: 'transcription_unit',
      records: [unitRecord({ start: 0, end: 100 }), unitRecord({ start: 0, end: 100 })],
    });
    const { result, lanes } = declutter(data, SPAN_RULE, 'stacked', 1, 1);
    expect(lanes.overflowed).toBe(1);
    expect(result.kept).toBe(1);
  });
});
