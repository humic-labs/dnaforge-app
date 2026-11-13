import type { SequenceMapShape } from '../view-state/sequence-view-state';

export interface SequenceMapWebGLGeometryInput {
  mapShape: SequenceMapShape;
  renderHeight: number;
  shapeGeometryHeight: number;
  morphToCircle: number;
  minHeight: number;
}

export interface SequenceMapWebGLGeometry {
  renderHeight: number;
  geometryHeight: number;
  morphToCircle: number;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clampMorph(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function resolveSequenceMapWebGLGeometry({
  mapShape,
  renderHeight,
  shapeGeometryHeight,
  morphToCircle,
  minHeight,
}: SequenceMapWebGLGeometryInput): SequenceMapWebGLGeometry {
  const safeMinHeight = Math.max(1, finiteOr(minHeight, 1));
  const safeRenderHeight = Math.max(safeMinHeight, finiteOr(renderHeight, safeMinHeight));
  const safeShapeGeometryHeight = Math.max(
    safeMinHeight,
    finiteOr(shapeGeometryHeight, safeRenderHeight)
  );

  if (mapShape === 'linear') {
    return {
      renderHeight: safeRenderHeight,
      geometryHeight: safeRenderHeight,
      morphToCircle: 0,
    };
  }

  return {
    renderHeight: safeRenderHeight,
    geometryHeight: safeShapeGeometryHeight,
    morphToCircle: clampMorph(morphToCircle),
  };
}
