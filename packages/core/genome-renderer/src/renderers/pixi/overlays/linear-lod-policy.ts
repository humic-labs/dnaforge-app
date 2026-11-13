export function planLinearImmediateAnnotationRender(pixelsPerBp: number): {
  kind: 'full-shapes' | 'overview-aggregation';
  forceTinyFeatureShapes: boolean;
} {
  void pixelsPerBp;
  return { kind: 'full-shapes', forceTinyFeatureShapes: true };
}
