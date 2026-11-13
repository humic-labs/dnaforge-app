import { describe, expect, it } from 'vitest';

import type { Feature } from '../../../types';
import { StadiumPathMapper, type PathMapper } from '../shared/path-mapper';
import {
  buildDirectionalPolygon,
  cdsLabelStripOutlineCommand,
  flatPolygonToPolyline,
  lanePillOutlineCommand,
  lerp,
  lerpBp,
  screenDistanceFromFeatureStart,
} from './annotation-feature-geometry';

function feature(direction: Feature['direction']): Feature {
  return {
    id: 1,
    type: 'gene',
    start: 10,
    end: 40,
    direction,
    displayName: 'feature',
    color: 0,
    lane: 0,
  };
}

const linearPath = {
  isArcMode: false,
  bpLeftX: (bp: number) => bp * 2,
  featureLabelPosAt: (_bp: number, offset: number) => ({ x: 0, y: 100 + offset }),
} as unknown as PathMapper;

describe('annotation feature geometry', () => {
  it.each(['forward', 'reverse'] as const)(
    'keeps a viewport-clipped circular %s feature inside its visible ribbon',
    (direction) => {
      const path = new StadiumPathMapper({
        genomeLength: 60096,
        viewOffset: 36800 / 60096,
        zoom: 80,
        dims: {
          width: 372,
          height: 372,
          radius: 186,
          straightLength: 0,
          totalLength: 2 * Math.PI * 186,
        },
        ox: 0,
        oy: 0,
        stagePosX: 0,
        stagePosY: 0,
        bpPerPixel: 60096 / (2 * Math.PI * 186 * 80),
        hasSequence: true,
        viewportWidth: 418,
        viewportHeight: 600,
        geometryHeight: 600,
      });
      const annotation = { ...feature(direction), start: 35000, end: 40000 };
      const ribbon = path.featurePolygonAt(annotation.start, annotation.end, -14, 7);
      const polygon = buildDirectionalPolygon(path, annotation, annotation.end, -14, 8, 7);
      const xs = ribbon.filter((_, index) => index % 2 === 0);
      const ys = ribbon.filter((_, index) => index % 2 === 1);
      const bounds = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      const escaped = polygon.filter(
        (value, index) =>
          !Number.isFinite(value) ||
          value < bounds[index % 2] - 1e-6 ||
          value > bounds[(index % 2) + 2] + 1e-6
      );
      expect(escaped).toEqual([]);
    }
  );

  it('converts flat polygon coordinates to a closed point path', () => {
    expect(flatPolygonToPolyline([1, 2, 3, 4, 5, 6])).toEqual([
      { x: 1, y: 2 },
      { x: 3, y: 4 },
      { x: 5, y: 6 },
      { x: 1, y: 2 },
    ]);
    expect(flatPolygonToPolyline([])).toEqual([]);
  });

  it('measures forward and circularly wrapped screen distance from a feature start', () => {
    expect(screenDistanceFromFeatureStart(10, 25, 100, 2)).toBe(30);
    expect(screenDistanceFromFeatureStart(90, 5, 100, 2)).toBe(30);
    expect(screenDistanceFromFeatureStart(10, 9.75, 100, 2)).toBe(0);
  });

  it('clamps scalar interpolation and follows the shortest circular base-pair path', () => {
    expect(lerp(10, 20, -1)).toBe(10);
    expect(lerp(10, 20, 0.25)).toBe(12.5);
    expect(lerp(10, 20, 2)).toBe(20);
    expect(lerpBp(95, 5, 0.5, 100, true)).toBe(0);
    expect(lerpBp(10, 20, 0.5, 100, false)).toBe(15);
  });

  it('builds the existing linear forward and reverse chevrons', () => {
    expect(buildDirectionalPolygon(linearPath, feature('forward'), 40, 4, 6, 5)).toEqual([
      20, 99, 74, 99, 80, 104, 74, 109, 20, 109,
    ]);
    expect(buildDirectionalPolygon(linearPath, feature('reverse'), 40, 4, 6, 5)).toEqual([
      26, 99, 80, 99, 80, 109, 26, 109, 20, 104,
    ]);
  });

  it('builds linear lane-pill outlines as roundRects when the pill fits the genome', () => {
    const path = {
      isArcMode: false,
      pixelsPerBp: 1,
      bpLeftX: (bp: number) => bp,
      featureLabelPosAt: (bp: number, offset: number) => ({ x: bp, y: 50 + offset }),
      featurePolygonAt: () => [0, 0, 1, 0, 1, 1, 0, 1],
    } as unknown as PathMapper;
    expect(lanePillOutlineCommand(path, 10, 20, 0, 4, 1000)).toEqual([
      {
        kind: 'roundRect',
        x: 10,
        y: 46,
        width: 20,
        height: 8,
        radius: 3,
      },
    ]);
    expect(lanePillOutlineCommand(path, 10, 0, 0, 4, 1000)).toEqual([]);
  });

  it('builds a CDS label-strip outline poly when pill width is positive', () => {
    const path = {
      isArcMode: false,
      pixelsPerBp: 1,
      bpLeftX: (bp: number) => bp,
      featureLabelPosAt: (bp: number, offset: number) => ({ x: bp, y: 50 + offset }),
      featurePolygonAt: () => [0, 0, 1, 0, 1, 1, 0, 1],

      featureQuadAt: () => [0, 0, 1, 0, 1, 1, 0, 1],
    } as unknown as PathMapper;
    const commands = cdsLabelStripOutlineCommand(path, 0, 10, 40, 0, 5, 2, 1000);
    expect(commands).toHaveLength(1);
    expect(commands[0].kind).toBe('poly');
    expect(Array.isArray((commands[0] as { pts: number[] }).pts)).toBe(true);
  });
});
