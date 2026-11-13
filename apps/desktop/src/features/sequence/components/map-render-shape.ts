export type SequenceMapShapeControlMode = 'shape' | 'topology';

export interface MapRenderShapeInput {
  mapFillsAvailableSpace: boolean;
  continuousShapeControl?: boolean;
  mapShape: 'circular' | 'linear';
  persistedMorphToCircle: number;
  persistedGeometryHeight: number;
  filledGeometryHeight: number;
}

export interface MapRenderShape {
  controlMode: SequenceMapShapeControlMode;
  morphToCircle: number;
  geometryHeight: number;
}

export function resolveMapRenderShape(input: MapRenderShapeInput): MapRenderShape {
  const controlMode: SequenceMapShapeControlMode =
    input.continuousShapeControl || !input.mapFillsAvailableSpace ? 'shape' : 'topology';
  const drawAsFullCircle = controlMode === 'topology' && input.mapShape === 'circular';
  return {
    controlMode,
    morphToCircle: drawAsFullCircle ? 1 : input.persistedMorphToCircle,
    geometryHeight: drawAsFullCircle ? input.filledGeometryHeight : input.persistedGeometryHeight,
  };
}
