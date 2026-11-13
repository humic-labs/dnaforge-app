import { describe, expect, it } from 'vitest';
import type { PathMapper } from '../shared/path-mapper';
import {
  annotationSectorPolygons,
  renderAnnotationMutationSectors,
  retainedAnnotationSectorOutline,
} from './annotation-mutation-sectors';
import type { Graphics } from 'pixi.js';
import type { Feature, RenderState } from '../../../types';

const path = {
  isArcMode: false,
  pixelsPerBp: 1,
  bpLeftX: (bp: number) => bp,
} as PathMapper;

describe('mutation sectors use the canonical annotation perimeter', () => {
  it('preserves exon membership when retained minimum-width bodies overlap on screen', () => {
    const mapper = {
      ...path,
      pixelsPerBp: 0.001,
      bpLeftX: (bp: number) => bp * 0.001,
      fwdStrandTop: 20,
    } as PathMapper;
    const feature: Feature = {
      id: 1,
      type: 'CDS',
      start: 0,
      end: 60,
      direction: 'none',
      lane: 0,
      color: 0x123456,
      displayName: 'Gene',
      exons: [
        { start: 1, end: 6 },
        { start: 31, end: 60 },
      ],
      cds: [
        { start: 1, end: 6 },
        { start: 31, end: 60 },
      ],
    };
    const commands = retainedAnnotationSectorOutline(
      feature,
      mapper,
      { width: 100 } as RenderState,
      0,
      7,
      0
    );
    const polygons = annotationSectorPolygons(
      commands,
      { start: 3, end: 6, color: 0xff9800 },
      mapper,
      0,
      7
    );
    const firstExon = commands[0];
    if (firstExon.kind !== 'poly') throw new Error('The first exon must have a body polygon');
    const firstExonRight = Math.max(...firstExon.pts.filter((_, index) => index % 2 === 0));
    expect(polygons.length).toBeGreaterThan(0);
    expect(Math.max(...polygons.flat().filter((_, index) => index % 2 === 0))).toBeLessThanOrEqual(
      firstExonRight + 1e-7
    );
  });
  it.each([false, true])(
    'keeps minimum-width paint within its own exon when arc mode is %s',
    (isArcMode) => {
      const mapper = {
        ...path,
        isArcMode,
        pixelsPerBp: 0.1,
        bpLeftX: (bp: number) => bp * 0.1,
        featurePolygonAt: (start: number, end: number) => [
          start * 0.1,
          -7,
          end * 0.1,
          -7,
          end * 0.1,
          7,
          start * 0.1,
          7,
        ],
      } as PathMapper;
      const polygons = annotationSectorPolygons(
        [
          { kind: 'poly', pts: [0, -7, 0.4, -7, 0.4, 7, 0, 7] },
          { kind: 'poly', pts: [1, -7, 2, -7, 2, 7, 1, 7] },
        ],
        { start: 3, end: 4, color: 0xff9800 },
        mapper,
        0,
        7
      );
      expect(polygons.length).toBeGreaterThan(0);
      const xs = polygons.flat().filter((_, index) => index % 2 === 0);
      expect(Math.max(...xs)).toBeLessThanOrEqual(0.4 + 1e-7);
    }
  );
  it('does not let minimum-width stop or insertion paint erase a neighboring frameshift sector', () => {
    const feature = { id: 1 } as Feature;
    const state = renderAnnotationMutationSectors(
      {
        featureById: new Map([[1, feature]]),
        featureOffset: () => 0,
        halfHeight: 7,
        outlineFor: () => [{ kind: 'poly', pts: [-0.15, -7, 1.35, -7, 1.35, 7, -0.15, 7] }],
      },
      { clear() {}, poly() {}, fill() {} } as unknown as Graphics,
      {
        ...path,
        pixelsPerBp: 0.02,
        bpLeftX: (bp: number) => bp * 0.02,
        isFeatureVisible: () => true,
      } as PathMapper,
      new Map([
        [
          1,
          {
            baseColor: 0x9e9e9e,
            coding: true,
            sectors: [
              { start: 0, end: 3, color: 0x4caf50 },
              { start: 3, end: 57, color: 0xff9800 },
              { start: 57, end: 60, color: 0xf44336 },
            ],
          },
        ],
      ]),
      0
    );
    const bounds = state.samples.map((sample) => {
      const xs = sample.polygons.flat().filter((_, index) => index % 2 === 0);
      return { color: sample.color, left: Math.min(...xs), right: Math.max(...xs) };
    });
    expect(bounds).toHaveLength(3);
    expect(bounds[0].right).toBeLessThanOrEqual(bounds[1].left + 1e-7);
    expect(bounds[1].right).toBeLessThanOrEqual(bounds[2].left + 1e-7);
    expect(bounds[1].right - bounds[1].left).toBeCloseTo(1.08);
  });
  it('clips a sector at the actual pointed tip instead of creating a rectangular overhang', () => {
    const polygons = annotationSectorPolygons(
      [{ kind: 'poly', pts: [0, -7, 92, -7, 100, 0, 92, 7, 0, 7] }],
      { start: 96, end: 100, color: 0xff0000 },
      path,
      0,
      7
    );
    expect(polygons).toEqual([[96, -3.5, 100, 0, 96, 3.5]]);
  });

  it('keeps a one-base change visible at overview without changing its biological interval', () => {
    const sector = { start: 5000, end: 5001, color: 0xff0000 };
    const polygons = annotationSectorPolygons(
      [{ kind: 'poly', pts: [0, -7, 100, -7, 100, 7, 0, 7] }],
      sector,
      { ...path, pixelsPerBp: 0.01, bpLeftX: (bp: number) => bp * 0.01 } as PathMapper,
      0,
      7
    );
    const xs = polygons.flat().filter((_, index) => index % 2 === 0);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(1.5);
    expect(sector).toEqual({ start: 5000, end: 5001, color: 0xff0000 });
  });
});
