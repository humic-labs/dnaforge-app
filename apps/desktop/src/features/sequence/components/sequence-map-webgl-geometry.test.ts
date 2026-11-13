// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { resolveSequenceMapWebGLGeometry } from './sequence-map-webgl-geometry';

describe('resolveSequenceMapWebGLGeometry', () => {
  it('keeps circular/stadium shape geometry independent from the pane render height', () => {
    expect(
      resolveSequenceMapWebGLGeometry({
        mapShape: 'circular',
        renderHeight: 900,
        shapeGeometryHeight: 260,
        morphToCircle: 0,
        minHeight: 180,
      })
    ).toEqual({
      renderHeight: 900,
      geometryHeight: 260,
      morphToCircle: 0,
    });
  });

  it('preserves circular morph while clamping invalid values', () => {
    expect(
      resolveSequenceMapWebGLGeometry({
        mapShape: 'circular',
        renderHeight: 420,
        shapeGeometryHeight: 600,
        morphToCircle: 1.7,
        minHeight: 180,
      })
    ).toEqual({
      renderHeight: 420,
      geometryHeight: 600,
      morphToCircle: 1,
    });
  });

  it('uses the actual viewport height for linear topology', () => {
    expect(
      resolveSequenceMapWebGLGeometry({
        mapShape: 'linear',
        renderHeight: 760,
        shapeGeometryHeight: 240,
        morphToCircle: 1,
        minHeight: 180,
      })
    ).toEqual({
      renderHeight: 760,
      geometryHeight: 760,
      morphToCircle: 0,
    });
  });
});
