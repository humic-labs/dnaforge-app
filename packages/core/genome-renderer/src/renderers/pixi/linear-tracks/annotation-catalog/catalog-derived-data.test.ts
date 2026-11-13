import { describe, expect, it } from 'vitest';

import {
  deriveCatalogTrackData,
  lowerBound,
  recordAnchorEdgeBp,
  scoreFraction,
  signedLog,
  sortedOrder,
} from './catalog-derived-data';
import {
  catalogTrackData,
  promoterRecord,
  terminatorRecord,
  tssRecord,
  unitRecord,
} from './catalog-test-fixtures';

describe('recordAnchorEdgeBp', () => {
  it('puts a start on the 5-prime edge of its +1 base', () => {
    expect(recordAnchorEdgeBp(tssRecord(100, '+'))).toBe(100);
    expect(recordAnchorEdgeBp(tssRecord(100, '-'))).toBe(101);
    expect(recordAnchorEdgeBp(unitRecord({ start: 10, end: 50, strand: '+' }))).toBe(10);
    expect(recordAnchorEdgeBp(unitRecord({ start: 10, end: 50, strand: '-' }))).toBe(50);
  });

  it('uses the promoter +1 base when known, else the window edge nearest transcription', () => {
    expect(
      recordAnchorEdgeBp(promoterRecord({ start: 40, end: 101, transcriptionStartBp: 100 }))
    ).toBe(100);
    expect(recordAnchorEdgeBp(promoterRecord({ start: 40, end: 101 }))).toBe(100);
    expect(recordAnchorEdgeBp(promoterRecord({ start: 40, end: 101, strand: '-' }))).toBe(41);
  });

  it('puts an end on the 3-prime edge of its last transcribed base', () => {
    expect(recordAnchorEdgeBp(terminatorRecord({ start: 200, end: 240, strand: '+' }))).toBe(240);
    expect(recordAnchorEdgeBp(terminatorRecord({ start: 200, end: 240, strand: '-' }))).toBe(200);
  });

  it('uses the measured 3-prime end of a terminator when the source gives one', () => {
    const at = (strand: '+' | '-') =>
      recordAnchorEdgeBp(terminatorRecord({ start: 100, end: 130, strand, terminationBp: 118 }));
    expect(at('+')).toBe(119);
    expect(at('-')).toBe(118);
  });
});

describe('deriveCatalogTrackData', () => {
  it('orders records by anchor edge even when span order differs', () => {
    const data = catalogTrackData({
      kind: 'terminator',
      records: [
        terminatorRecord({ start: 0, end: 500, strand: '+' }),
        terminatorRecord({ start: 100, end: 140, strand: '+' }),
        terminatorRecord({ start: 300, end: 320, strand: '-' }),
      ],
    });
    const derived = deriveCatalogTrackData(data);

    expect(Array.from(derived.anchorsSorted)).toEqual([140, 300, 500]);
    expect(Array.from(derived.anchorOrder).map((i) => data.records[i].id)).toEqual([
      'terminator:+:100-140',
      'terminator:-:300-320',
      'terminator:+:0-500',
    ]);
    expect(Array.from(derived.startOrder)).toEqual([0, 1, 2]);
    expect(derived.maxSpanBp).toBe(500);
    expect(derived.hasForward).toBe(true);
    expect(derived.hasReverse).toBe(true);
  });

  it('reports the median span for odd and even counts', () => {
    const odd = deriveCatalogTrackData(
      catalogTrackData({
        kind: 'transcription_unit',
        records: [
          unitRecord({ start: 0, end: 100 }),
          unitRecord({ start: 0, end: 300 }),
          unitRecord({ start: 0, end: 2000 }),
        ],
      })
    );
    expect(odd.medianSpanBp).toBe(300);

    const even = deriveCatalogTrackData(
      catalogTrackData({
        kind: 'transcription_unit',
        records: [unitRecord({ start: 0, end: 100 }), unitRecord({ start: 0, end: 300 })],
      })
    );
    expect(even.medianSpanBp).toBe(200);
  });

  it('has no score scale when no record has a score', () => {
    const derived = deriveCatalogTrackData(
      catalogTrackData({ kind: 'tss', records: [tssRecord(1), tssRecord(2)] })
    );
    expect(derived.scoreScale).toBeNull();
  });
});

describe('score scaling', () => {
  const scaleFor = (scores: number[]) =>
    deriveCatalogTrackData(
      catalogTrackData({
        kind: 'tss',
        records: scores.map((score, i) => tssRecord(i * 10, '+', score)),
      })
    ).scoreScale!;

  it('is monotonic in score and clamped to 0..1', () => {
    const scale = scaleFor([1, 10, 100, 1000, 10_000]);
    const fractions = [1, 10, 100, 1000, 10_000].map((s) => scoreFraction(scale, s));
    for (let i = 1; i < fractions.length; i++) {
      expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1]);
    }
    expect(scoreFraction(scale, -1e9)).toBe(0);
    expect(scoreFraction(scale, 1e12)).toBe(1);
  });

  it('keeps an outlier from flattening typical scores, because the scale is log and percentile clamped', () => {
    const scores = [...Array.from({ length: 40 }, (_, i) => 10 + i * 5), 1_000_000];
    const scale = scaleFor(scores);
    expect(scoreFraction(scale, 200) - scoreFraction(scale, 20)).toBeGreaterThan(0.5);
  });

  it('orders negative scores (such as folding energies) with higher still taller', () => {
    const scale = scaleFor([-30, -20, -10, -5]);
    expect(scoreFraction(scale, -5)).toBeGreaterThan(scoreFraction(scale, -20));
    expect(signedLog(-10)).toBeLessThan(signedLog(-5));
  });

  it('puts null scores at the bottom and equal scores at the top', () => {
    const scale = scaleFor([7, 7, 7]);
    expect(scoreFraction(scale, 7)).toBe(1);
    expect(scoreFraction(scale, null)).toBe(0);
  });
});

describe('sortedOrder and lowerBound', () => {
  it('returns the identity for sorted input and keeps ties in record order', () => {
    expect(Array.from(sortedOrder(new Float64Array([1, 2, 2, 3])))).toEqual([0, 1, 2, 3]);
    expect(Array.from(sortedOrder(new Float64Array([5, 1, 5, 0])))).toEqual([3, 1, 0, 2]);
  });

  it('finds the first index at or above a value', () => {
    const values = new Float64Array([10, 20, 20, 30]);
    expect(lowerBound(values, 5)).toBe(0);
    expect(lowerBound(values, 20)).toBe(1);
    expect(lowerBound(values, 21)).toBe(3);
    expect(lowerBound(values, 99)).toBe(4);
  });
});
