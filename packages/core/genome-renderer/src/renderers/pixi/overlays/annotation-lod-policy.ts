import type { RetainedOverlayFallbackReason } from './overlay-track';

export const OVERVIEW_AGGREGATE_MAX_PIXELS_PER_BP = 0.002;
export const OVERVIEW_LOD_COMPRESSED_PIXELS_PER_BP = OVERVIEW_AGGREGATE_MAX_PIXELS_PER_BP * 0.55;
export const OVERVIEW_LOD_FULL_SHAPES_PIXELS_PER_BP = OVERVIEW_AGGREGATE_MAX_PIXELS_PER_BP * 1.55;
export const OVERVIEW_DENSITY_ATLAS_SAMPLE_SCREEN_PX = 0.25;

export type RetainedOverviewAnnotationStyle = 'retained' | 'full-shapes';

export type OverviewLodThresholds = {
  compressedPixelsPerBp: number;
  fullShapePixelsPerBp: number;
};

export type ImmediateAnnotationRenderPlan =
  | { kind: 'full-shapes'; forceTinyFeatureShapes: boolean }
  | { kind: 'overview-aggregation'; forceTinyFeatureShapes: boolean };

export type RetainedAnnotationRenderPlan =
  | { kind: 'fallback'; reason: RetainedOverlayFallbackReason }
  | {
      kind: 'retained-bins';
      style: 'retained';
      compressionBlend: number;
      fullShapeBlend: number;
    };

export type ImmediateAnnotationRenderPlanInput = {
  style: RetainedOverviewAnnotationStyle;
  isArcMode: boolean;
  pixelsPerBp: number;
};

export type RetainedAnnotationRenderPlanInput = ImmediateAnnotationRenderPlanInput & {
  enabled: boolean;
  hasLayout: boolean;
  genomeLength: number;
  featureCount: number;
};

export function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export const MIN_NARROW_FEATURE_PX = 2;

export function fullShapeOverviewAlphaScale(pixelWidth: number): number {
  if (pixelWidth >= MIN_NARROW_FEATURE_PX) return 1;
  return 0.2 + 0.8 * smoothstep(0.15, MIN_NARROW_FEATURE_PX, pixelWidth);
}

export function resolveRetainedOverviewAnnotationStyle(
  style: unknown
): RetainedOverviewAnnotationStyle {
  if (style === 'full-shapes') return 'full-shapes';
  return 'retained';
}

type OverviewLodTuningGlobal = typeof globalThis & {
  __WAYPOINT_WEBGL_OVERVIEW_LOD_COMPRESSED_PIXELS_PER_BP?: number;
  __WAYPOINT_WEBGL_OVERVIEW_LOD_FULL_SHAPES_PIXELS_PER_BP?: number;
};

function finitePositive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function overviewLodThresholds(): OverviewLodThresholds {
  const globals = globalThis as OverviewLodTuningGlobal;
  const compressed = finitePositive(
    globals.__WAYPOINT_WEBGL_OVERVIEW_LOD_COMPRESSED_PIXELS_PER_BP,
    OVERVIEW_LOD_COMPRESSED_PIXELS_PER_BP
  );
  const fullShapes = finitePositive(
    globals.__WAYPOINT_WEBGL_OVERVIEW_LOD_FULL_SHAPES_PIXELS_PER_BP,
    OVERVIEW_LOD_FULL_SHAPES_PIXELS_PER_BP
  );
  if (fullShapes <= compressed) {
    return {
      compressedPixelsPerBp: compressed,
      fullShapePixelsPerBp: compressed * 1.01,
    };
  }
  return {
    compressedPixelsPerBp: compressed,
    fullShapePixelsPerBp: fullShapes,
  };
}

export function overviewLodCompressionBlend(pixelsPerBp: number): number {
  const thresholds = overviewLodThresholds();
  return (
    1 - smoothstep(thresholds.compressedPixelsPerBp, thresholds.fullShapePixelsPerBp, pixelsPerBp)
  );
}

export function planImmediateAnnotationRender(
  input: ImmediateAnnotationRenderPlanInput
): ImmediateAnnotationRenderPlan {
  const forceTinyFeatureShapes = input.style === 'full-shapes';
  if (
    !forceTinyFeatureShapes &&
    input.isArcMode &&
    input.pixelsPerBp < OVERVIEW_AGGREGATE_MAX_PIXELS_PER_BP
  ) {
    return { kind: 'overview-aggregation', forceTinyFeatureShapes };
  }
  return { kind: 'full-shapes', forceTinyFeatureShapes };
}

export function planRetainedAnnotationRender(
  input: RetainedAnnotationRenderPlanInput
): RetainedAnnotationRenderPlan {
  if (!input.enabled) {
    return { kind: 'fallback', reason: 'disabled' };
  }
  if (!input.hasLayout || input.genomeLength <= 0 || input.featureCount <= 0) {
    return { kind: 'fallback', reason: 'dirty-data' };
  }
  if (input.style === 'full-shapes') {
    return { kind: 'fallback', reason: 'unsupported-visual-state' };
  }
  if (!input.isArcMode) {
    return { kind: 'fallback', reason: 'unsupported-mode' };
  }

  const compressionBlend = overviewLodCompressionBlend(input.pixelsPerBp);
  if (compressionBlend <= 0.001) {
    return { kind: 'fallback', reason: 'unsupported-mode' };
  }

  const fullShapeBlend = 1 - compressionBlend;
  return {
    kind: 'retained-bins',
    style: 'retained',
    compressionBlend,
    fullShapeBlend,
  };
}
