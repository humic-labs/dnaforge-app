import { describe, expect, it } from 'vitest';

import { planLinearImmediateAnnotationRender } from './linear-lod-policy';

describe('planLinearImmediateAnnotationRender', () => {
  it('keeps plasmid-scale linear views on source-shaped glyphs', () => {
    expect(planLinearImmediateAnnotationRender(0.53)).toEqual({
      kind: 'full-shapes',
      forceTinyFeatureShapes: true,
    });
  });

  it('keeps chromosome-scale linear views on source-shaped glyphs', () => {
    expect(planLinearImmediateAnnotationRender(5.8e-6)).toEqual({
      kind: 'full-shapes',
      forceTinyFeatureShapes: true,
    });
  });

  it('does not expose a zoom band that can switch linear annotations into aggregation', () => {
    for (const pixelsPerBp of [1e-8, 1e-6, 5.8e-6, 0.001, 0.01, 0.53, 10]) {
      expect(planLinearImmediateAnnotationRender(pixelsPerBp)).toEqual({
        kind: 'full-shapes',
        forceTinyFeatureShapes: true,
      });
    }
  });
});
