import { describe, it, expect } from 'vitest';
import {
  pointInPolygon,
  computeBBox,
  transcriptHitTest,
  type TranscriptHitGeometry,
} from './hit-testing';

describe('pointInPolygon', () => {
  const rect = [10, 10, 50, 10, 50, 30, 10, 30];

  it('returns true for point inside rectangle', () => {
    expect(pointInPolygon(30, 20, rect)).toBe(true);
  });

  it('returns false for point outside rectangle', () => {
    expect(pointInPolygon(0, 0, rect)).toBe(false);
    expect(pointInPolygon(60, 20, rect)).toBe(false);
    expect(pointInPolygon(30, 40, rect)).toBe(false);
  });

  it('returns false for point to the left', () => {
    expect(pointInPolygon(5, 20, rect)).toBe(false);
  });

  it('returns false for point to the right', () => {
    expect(pointInPolygon(55, 20, rect)).toBe(false);
  });

  const triangle = [100, 0, 200, 100, 0, 100];

  it('returns true for point inside triangle', () => {
    expect(pointInPolygon(100, 80, triangle)).toBe(true);
  });

  it('returns false for point outside triangle', () => {
    expect(pointInPolygon(10, 10, triangle)).toBe(false);
    expect(pointInPolygon(250, 50, triangle)).toBe(false);
  });

  const lShape = [0, 0, 50, 0, 50, 50, 25, 50, 25, 25, 0, 25];

  it('returns true for point in L-shape main body', () => {
    expect(pointInPolygon(10, 10, lShape)).toBe(true);
  });

  it('returns true for point in L-shape extension', () => {
    expect(pointInPolygon(35, 40, lShape)).toBe(true);
  });

  it('returns false for point in L-shape notch', () => {
    expect(pointInPolygon(10, 40, lShape)).toBe(false);
  });

  const band = [100, 0, 150, 0, 200, 0, 200, 20, 150, 20, 100, 20];

  it('returns true for point inside band polygon', () => {
    expect(pointInPolygon(150, 10, band)).toBe(true);
    expect(pointInPolygon(120, 5, band)).toBe(true);
  });

  it('returns false for point outside band polygon', () => {
    expect(pointInPolygon(80, 10, band)).toBe(false);
    expect(pointInPolygon(150, 25, band)).toBe(false);
  });

  it('returns false for empty polygon', () => {
    expect(pointInPolygon(0, 0, [])).toBe(false);
  });
});

describe('transcriptHitTest — hit boxes hug the drawn glyph : "too broad")', () => {
  const geo: TranscriptHitGeometry = {
    cy: 100,
    halfHeight: 8,
    exons: [
      { x1: 50, x2: 90 },
      { x1: 150, x2: 190 },
    ],
    intronGaps: [{ x1: 90, x2: 150 }],
  };

  it('hits an exon at its center', () => {
    expect(transcriptHitTest(70, 100, geo)).toBe(true);
    expect(transcriptHitTest(170, 100, geo)).toBe(true);
  });

  it('exon vertical hit is exactly the bar half-height — no adjacent-lane bleed', () => {
    expect(transcriptHitTest(70, 108, geo)).toBe(true);
    expect(transcriptHitTest(70, 112, geo)).toBe(false);
    expect(transcriptHitTest(70, 88, geo)).toBe(false);
  });

  it('hits the thin intron connector along the center line', () => {
    expect(transcriptHitTest(120, 100, geo)).toBe(true);
    expect(transcriptHitTest(120, 103, geo)).toBe(true);
  });

  it('intron vertical tolerance is tight (≤4px), not the full bar height', () => {
    expect(transcriptHitTest(120, 105, geo)).toBe(false);
    expect(transcriptHitTest(120, 95, geo)).toBe(false);
  });

  it('does not overshoot the transcript ends into a neighbour (tight horizontal pad)', () => {
    expect(transcriptHitTest(44, 100, geo)).toBe(false);
    expect(transcriptHitTest(196, 100, geo)).toBe(false);
    expect(transcriptHitTest(48, 100, geo)).toBe(true);
  });

  it('a gap with no exon/intron coverage at that Y is a miss', () => {
    const single: TranscriptHitGeometry = {
      cy: 100,
      halfHeight: 8,
      exons: [{ x1: 50, x2: 90 }],
      intronGaps: [],
    };
    expect(transcriptHitTest(120, 100, single)).toBe(false);
  });
});

describe('computeBBox', () => {
  it('computes correct bbox for rectangle', () => {
    const bbox = computeBBox([10, 20, 50, 20, 50, 40, 10, 40]);
    expect(bbox.xMin).toBe(10);
    expect(bbox.xMax).toBe(50);
    expect(bbox.yMin).toBe(20);
    expect(bbox.yMax).toBe(40);
  });

  it('computes correct bbox for irregular polygon', () => {
    const bbox = computeBBox([0, 5, 100, 0, 80, 50, 20, 60]);
    expect(bbox.xMin).toBe(0);
    expect(bbox.xMax).toBe(100);
    expect(bbox.yMin).toBe(0);
    expect(bbox.yMax).toBe(60);
  });
});
