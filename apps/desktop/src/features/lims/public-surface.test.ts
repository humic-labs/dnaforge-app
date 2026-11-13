import { describe, expect, it } from 'vitest';

describe('LIMS public surface', () => {
  it('does not export the deferred genotype reconstruction prototype from the feature barrel', async () => {
    const lims = await import('./index');

    expect(lims).not.toHaveProperty('parseLimsGenotype');
    expect(lims).not.toHaveProperty('applyLimsGenotypeEdits');
    expect(lims).not.toHaveProperty('findAnnotationForGenotypeTarget');
  }, 20000);
});
