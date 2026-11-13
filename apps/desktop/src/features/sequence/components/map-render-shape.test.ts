// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { resolveMapRenderShape } from './map-render-shape';

const PERSISTED_MORPH = 0.42;
const PERSISTED_GEOMETRY = 345;
const FILLED_GEOMETRY = 600;

const base = {
  mapShape: 'circular' as const,
  persistedMorphToCircle: PERSISTED_MORPH,
  persistedGeometryHeight: PERSISTED_GEOMETRY,
  filledGeometryHeight: FILLED_GEOMETRY,
};

describe('resolveMapRenderShape — a map that owns its pane draws a circle', () => {
  it('draws a full circle when the map is shown on its own', () => {
    expect(resolveMapRenderShape({ ...base, mapFillsAvailableSpace: true })).toEqual({
      controlMode: 'topology',
      morphToCircle: 1,
      geometryHeight: FILLED_GEOMETRY,
    });
  });

  it('draws a full circle side by side with the sequence, as before', () => {
    expect(resolveMapRenderShape({ ...base, mapFillsAvailableSpace: true })).toMatchObject({
      morphToCircle: 1,
    });
  });

  it('keeps the morphable strip when stacked above or below the sequence', () => {
    expect(resolveMapRenderShape({ ...base, mapFillsAvailableSpace: false })).toEqual({
      controlMode: 'shape',
      morphToCircle: PERSISTED_MORPH,
      geometryHeight: PERSISTED_GEOMETRY,
    });
  });

  it('keeps the continuous circle-to-line editor when an assembly map owns the pane', () => {
    expect(
      resolveMapRenderShape({
        ...base,
        mapFillsAvailableSpace: true,
        continuousShapeControl: true,
      })
    ).toEqual({
      controlMode: 'shape',
      morphToCircle: PERSISTED_MORPH,
      geometryHeight: PERSISTED_GEOMETRY,
    });
  });
});

describe('resolveMapRenderShape — a linear sequence has no circle to draw', () => {
  it('keeps the persisted morph even when it owns the whole pane', () => {
    expect(
      resolveMapRenderShape({ ...base, mapShape: 'linear', mapFillsAvailableSpace: true })
    ).toEqual({
      controlMode: 'topology',
      morphToCircle: PERSISTED_MORPH,
      geometryHeight: PERSISTED_GEOMETRY,
    });
  });

  it('is unchanged when stacked', () => {
    expect(
      resolveMapRenderShape({ ...base, mapShape: 'linear', mapFillsAvailableSpace: false })
    ).toEqual({
      controlMode: 'shape',
      morphToCircle: PERSISTED_MORPH,
      geometryHeight: PERSISTED_GEOMETRY,
    });
  });
});

describe('resolveMapRenderShape — the control mode and the drawn shape agree', () => {
  it('never reports topology while drawing a partial morph for a circular map', () => {
    for (const mapFillsAvailableSpace of [true, false]) {
      const r = resolveMapRenderShape({ ...base, mapFillsAvailableSpace });
      if (r.controlMode === 'topology') expect(r.morphToCircle).toBe(1);
      else expect(r.morphToCircle).toBe(PERSISTED_MORPH);
    }
  });

  it('pairs the filled geometry height with a closed circle, always', () => {
    for (const mapFillsAvailableSpace of [true, false]) {
      for (const mapShape of ['circular', 'linear'] as const) {
        const r = resolveMapRenderShape({ ...base, mapFillsAvailableSpace, mapShape });
        expect(r.geometryHeight === FILLED_GEOMETRY).toBe(r.morphToCircle === 1);
      }
    }
  });
});
