import { describe, expect, it } from 'vitest';
import {
  OVERVIEW_AGGREGATE_MAX_PIXELS_PER_BP,
  OVERVIEW_LOD_COMPRESSED_PIXELS_PER_BP,
  OVERVIEW_LOD_FULL_SHAPES_PIXELS_PER_BP,
  overviewLodCompressionBlend,
  overviewLodThresholds,
  planImmediateAnnotationRender,
  planRetainedAnnotationRender,
  resolveRetainedOverviewAnnotationStyle,
} from './annotation-lod-policy';

describe('annotation LOD policy', () => {
  it('resolves hidden and legacy texture overview styles to the retained renderer', () => {
    expect(resolveRetainedOverviewAnnotationStyle('feature-gaussian-field-v1')).toBe('retained');
    expect(resolveRetainedOverviewAnnotationStyle('shape-raster-coverage')).toBe('retained');
    expect(resolveRetainedOverviewAnnotationStyle('feature-gaussian-field-tight')).toBe('retained');
    expect(resolveRetainedOverviewAnnotationStyle('feature-gaussian-field-soft')).toBe('retained');
    expect(resolveRetainedOverviewAnnotationStyle('feature-gaussian-field-wash')).toBe('retained');
    expect(resolveRetainedOverviewAnnotationStyle('feature-gaussian-field-ridge')).toBe('retained');
    expect(resolveRetainedOverviewAnnotationStyle('retained')).toBe('retained');
    expect(resolveRetainedOverviewAnnotationStyle('full-shapes')).toBe('full-shapes');
    expect(resolveRetainedOverviewAnnotationStyle('texture-coverage')).toBe('retained');
    expect(resolveRetainedOverviewAnnotationStyle('density')).toBe('retained');
  });

  it('uses one monotonic blend curve for the perceptual overview LOD transition', () => {
    expect(overviewLodCompressionBlend(OVERVIEW_LOD_COMPRESSED_PIXELS_PER_BP / 2)).toBe(1);
    expect(overviewLodCompressionBlend(OVERVIEW_LOD_FULL_SHAPES_PIXELS_PER_BP * 2)).toBe(0);

    const midpoint =
      (OVERVIEW_LOD_COMPRESSED_PIXELS_PER_BP + OVERVIEW_LOD_FULL_SHAPES_PIXELS_PER_BP) / 2;
    const midpointBlend = overviewLodCompressionBlend(midpoint);
    expect(midpointBlend).toBeGreaterThan(0);
    expect(midpointBlend).toBeLessThan(1);
    expect(overviewLodCompressionBlend(OVERVIEW_LOD_COMPRESSED_PIXELS_PER_BP)).toBe(1);
    expect(overviewLodCompressionBlend(OVERVIEW_LOD_FULL_SHAPES_PIXELS_PER_BP)).toBe(0);
  });

  it('allows live workbench tuning of the overview LOD transition band', () => {
    const globals = globalThis as typeof globalThis & {
      __WAYPOINT_WEBGL_OVERVIEW_LOD_COMPRESSED_PIXELS_PER_BP?: number;
      __WAYPOINT_WEBGL_OVERVIEW_LOD_FULL_SHAPES_PIXELS_PER_BP?: number;
    };
    const previousCompressed = globals.__WAYPOINT_WEBGL_OVERVIEW_LOD_COMPRESSED_PIXELS_PER_BP;
    const previousFullShapes = globals.__WAYPOINT_WEBGL_OVERVIEW_LOD_FULL_SHAPES_PIXELS_PER_BP;
    try {
      globals.__WAYPOINT_WEBGL_OVERVIEW_LOD_COMPRESSED_PIXELS_PER_BP =
        OVERVIEW_AGGREGATE_MAX_PIXELS_PER_BP;
      globals.__WAYPOINT_WEBGL_OVERVIEW_LOD_FULL_SHAPES_PIXELS_PER_BP =
        OVERVIEW_AGGREGATE_MAX_PIXELS_PER_BP * 3;

      expect(overviewLodThresholds()).toEqual({
        compressedPixelsPerBp: OVERVIEW_AGGREGATE_MAX_PIXELS_PER_BP,
        fullShapePixelsPerBp: OVERVIEW_AGGREGATE_MAX_PIXELS_PER_BP * 3,
      });
      expect(overviewLodCompressionBlend(OVERVIEW_AGGREGATE_MAX_PIXELS_PER_BP)).toBe(1);
      expect(overviewLodCompressionBlend(OVERVIEW_AGGREGATE_MAX_PIXELS_PER_BP * 3)).toBe(0);
    } finally {
      globals.__WAYPOINT_WEBGL_OVERVIEW_LOD_COMPRESSED_PIXELS_PER_BP = previousCompressed;
      globals.__WAYPOINT_WEBGL_OVERVIEW_LOD_FULL_SHAPES_PIXELS_PER_BP = previousFullShapes;
    }
  });

  it('keeps immediate fallback aggregation on the legacy safe overview boundary', () => {
    expect(
      planImmediateAnnotationRender({
        style: 'retained',
        isArcMode: true,
        pixelsPerBp: OVERVIEW_AGGREGATE_MAX_PIXELS_PER_BP / 2,
      })
    ).toMatchObject({ kind: 'overview-aggregation', forceTinyFeatureShapes: false });

    expect(
      planImmediateAnnotationRender({
        style: 'full-shapes',
        isArcMode: true,
        pixelsPerBp: OVERVIEW_AGGREGATE_MAX_PIXELS_PER_BP / 2,
      })
    ).toMatchObject({ kind: 'full-shapes', forceTinyFeatureShapes: true });
  });

  it('returns only retained-bin plans from the retained overview transition policy', () => {
    const transitionPixelsPerBp =
      (OVERVIEW_LOD_COMPRESSED_PIXELS_PER_BP + OVERVIEW_LOD_FULL_SHAPES_PIXELS_PER_BP) / 2;

    for (const style of [
      'retained',
      'shape-raster-coverage',
      'feature-gaussian-field-v1',
      'feature-gaussian-field-soft',
    ]) {
      expect(
        planRetainedAnnotationRender({
          enabled: true,
          style: resolveRetainedOverviewAnnotationStyle(style),
          hasLayout: true,
          genomeLength: 10_000,
          featureCount: 3,
          isArcMode: true,
          pixelsPerBp: transitionPixelsPerBp,
        })
      ).toMatchObject({
        kind: 'retained-bins',
        style: 'retained',
        compressionBlend: overviewLodCompressionBlend(transitionPixelsPerBp),
        fullShapeBlend: 1 - overviewLodCompressionBlend(transitionPixelsPerBp),
      });
    }
  });

  it('returns explicit retained fallback reasons before renderer-specific work starts', () => {
    expect(
      planRetainedAnnotationRender({
        enabled: false,
        style: 'retained',
        hasLayout: true,
        genomeLength: 10_000,
        featureCount: 1,
        isArcMode: true,
        pixelsPerBp: OVERVIEW_LOD_COMPRESSED_PIXELS_PER_BP,
      })
    ).toEqual({ kind: 'fallback', reason: 'disabled' });

    expect(
      planRetainedAnnotationRender({
        enabled: true,
        style: 'full-shapes',
        hasLayout: true,
        genomeLength: 10_000,
        featureCount: 1,
        isArcMode: true,
        pixelsPerBp: OVERVIEW_LOD_COMPRESSED_PIXELS_PER_BP,
      })
    ).toEqual({ kind: 'fallback', reason: 'unsupported-visual-state' });

    expect(
      planRetainedAnnotationRender({
        enabled: true,
        style: 'retained',
        hasLayout: true,
        genomeLength: 10_000,
        featureCount: 1,
        isArcMode: true,
        pixelsPerBp: OVERVIEW_LOD_FULL_SHAPES_PIXELS_PER_BP * 2,
      })
    ).toEqual({ kind: 'fallback', reason: 'unsupported-mode' });
  });
});
