import { describe, expect, it } from 'vitest';
import type { LimsStrainGenomeSummary } from './lims';
import { registryConfidenceLabel } from './strain-genome-evidence';

describe('shared strain genome evidence labels', () => {
  it.each([
    ['none', 'no_hypothesis', 'No genome linked'],
    ['parent', 'no_hypothesis', 'Parent genome referenced'],
    ['hypothesis', 'no_verified', 'Genome hypothesis supplied'],
    ['verified', 'no_hypothesis', 'WGS linked'],
    ['verified', 'match', 'WGS verified'],
    ['verified', 'mismatch', 'WGS verified with mismatch'],
  ])('describes %s with %s without overstating verification', (kind, gap, label) => {
    const summary = {
      parentGenome: kind === 'parent' ? { name: 'Parent' } : null,
      hypothesisGenome: kind === 'hypothesis' ? { name: 'Prediction' } : null,
      verifiedGenome: kind === 'verified' ? { name: 'Sequenced genome' } : null,
      gap: { status: gap },
    } as LimsStrainGenomeSummary;
    expect(registryConfidenceLabel(summary)).toBe(label);
  });
});
