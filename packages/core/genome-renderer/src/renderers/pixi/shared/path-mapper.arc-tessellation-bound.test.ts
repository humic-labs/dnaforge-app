import { describe, it, expect } from 'vitest';
import { StadiumPathMapper, type StadiumPathInputs } from './path-mapper';
import type { StadiumDimensions } from '../../../geometry/stadium';

const GENOME_LENGTH = 1_072_315;

const DIMS: StadiumDimensions = {
  width: 372,
  height: 372,
  radius: 186,
  straightLength: 0,
  totalLength: 1168.672467135403,
} as StadiumDimensions;

const FEATURE_POLYGON_MAX_SAMPLES_EXPECTED = 512;

const ZOOMS_THAT_EXHAUST_BUDGET = [130, 200, 400, 1000, 4000];

function unclippedMapperAtZoom(zoom: number): StadiumPathMapper {
  const huge = Math.ceil(300 * zoom);
  const inputs: StadiumPathInputs = {
    genomeLength: GENOME_LENGTH,
    viewOffset: 0.8152357537331684,
    zoom,
    dims: DIMS,
    ox: 460.5,
    oy: 611,
    stagePosX: -646.5 * (zoom - 1),
    stagePosY: -611 * zoom + 826,
    bpPerPixel: 917.549639 / zoom,
    hasSequence: true,
    viewportWidth: huge,
    viewportHeight: huge,
    geometryHeight: huge,
  };
  return new StadiumPathMapper(inputs);
}

function outerEdge(pts: number[]): Array<{ x: number; y: number }> {
  const half = Math.floor(pts.length / 2 / 2);
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < half; i++) out.push({ x: pts[2 * i], y: pts[2 * i + 1] });
  return out;
}

function longestChord(edge: Array<{ x: number; y: number }>): number {
  let worst = 0;
  for (let i = 1; i < edge.length; i++) {
    worst = Math.max(worst, Math.hypot(edge[i].x - edge[i - 1].x, edge[i].y - edge[i - 1].y));
  }
  return worst;
}

describe('StadiumPathMapper — arc tessellation degrades safely, never catastrophically', () => {
  it('confirms the budget is genuinely exhausted at these zooms (measured, not modelled)', () => {
    for (const zoom of ZOOMS_THAT_EXHAUST_BUDGET) {
      const pm = unclippedMapperAtZoom(zoom);
      const windowLen = pm.viewEndBp - pm.viewStartBp;
      const samples = pm.featurePolygonAt(0, GENOME_LENGTH, -14, 6).length / 4;

      expect(
        windowLen,
        `zoom=${zoom}: clipping active, exhaustion path not reached`
      ).toBeGreaterThanOrEqual(GENOME_LENGTH);
      expect(samples, `zoom=${zoom}: budget not exhausted`).toBeGreaterThanOrEqual(
        FEATURE_POLYGON_MAX_SAMPLES_EXPECTED
      );
    }
  });

  it('keeps every chord bounded when the budget cannot meet the tolerance', () => {
    for (const zoom of ZOOMS_THAT_EXHAUST_BUDGET) {
      const edge = outerEdge(
        unclippedMapperAtZoom(zoom).featurePolygonAt(0, GENOME_LENGTH, -14, 6)
      );
      const circumference = 2 * Math.PI * DIMS.radius * zoom;
      const uniformChord = circumference / 512;

      expect(longestChord(edge)).toBeLessThan(uniformChord * 3);
    }
  });

  it('spreads samples evenly instead of clustering them at the start', () => {
    for (const zoom of ZOOMS_THAT_EXHAUST_BUDGET) {
      const edge = outerEdge(
        unclippedMapperAtZoom(zoom).featurePolygonAt(0, GENOME_LENGTH, -14, 6)
      );
      const chords: number[] = [];
      for (let i = 1; i < edge.length; i++) {
        chords.push(Math.hypot(edge[i].x - edge[i - 1].x, edge[i].y - edge[i - 1].y));
      }
      const mean = chords.reduce((a, b) => a + b, 0) / chords.length;

      expect(chords.length).toBeGreaterThan(64);
      expect(Math.max(...chords) / mean).toBeLessThan(8);
    }
  });

  it('emits only finite coordinates', () => {
    for (const zoom of [1, 130, 4000]) {
      const pts = unclippedMapperAtZoom(zoom).featurePolygonAt(0, GENOME_LENGTH, -14, 6);
      expect(pts.length).toBeGreaterThan(0);
      expect(pts.every((v) => Number.isFinite(v))).toBe(true);
    }
  });

  it('respects the sample budget even while degrading', () => {
    for (const zoom of [130, 4000]) {
      const pts = unclippedMapperAtZoom(zoom).featurePolygonAt(0, GENOME_LENGTH, -14, 6);
      expect(pts.length / 4).toBeLessThanOrEqual(FEATURE_POLYGON_MAX_SAMPLES_EXPECTED);
    }
  });
});
