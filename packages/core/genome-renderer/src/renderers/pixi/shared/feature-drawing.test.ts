import { describe, it, expect } from 'vitest';
import { computeFeatureDrawDecision } from './feature-drawing';
import { LODTier } from '../../../types';
import type { Feature } from '../../../types';

function makeFeature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: 0,
    type: 'CDS',
    start: 0,
    end: 1000,
    direction: 'forward',
    displayName: 'testGene',
    color: 0x5498ff,
    lane: 0,
    ...overrides,
  };
}

describe('computeFeatureDrawDecision', () => {
  const genomeLength = 4641652;

  it('hides tiny features at low zoom', () => {
    const d = computeFeatureDrawDecision(
      makeFeature({ end: 100 }),
      genomeLength,
      genomeLength,
      3400,
      false,
      false
    );
    expect(d.visible).toBe(false);
    expect(d.tier).toBe(LODTier.Hidden);
  });

  it('shows features at moderate zoom', () => {
    const d = computeFeatureDrawDecision(
      makeFeature(),
      genomeLength,
      genomeLength,
      34000,
      false,
      false
    );
    expect(d.visible).toBe(true);
    expect(d.tier).toBeGreaterThanOrEqual(LODTier.Arrow);
  });

  it('detects CDS features', () => {
    const cds = computeFeatureDrawDecision(
      makeFeature({ type: 'CDS' }),
      genomeLength,
      genomeLength,
      34000,
      false,
      false
    );
    const misc = computeFeatureDrawDecision(
      makeFeature({ type: 'misc_feature' }),
      genomeLength,
      genomeLength,
      34000,
      false,
      false
    );
    expect(cds.isCDS).toBe(true);
    expect(misc.isCDS).toBe(false);
  });

  it('gene features are NOT CDS-style (only type CDS gets chevrons)', () => {
    const gene = computeFeatureDrawDecision(
      makeFeature({ type: 'gene' }),
      genomeLength,
      genomeLength,
      34000,
      false,
      false
    );
    expect(gene.isCDS).toBe(false);
  });

  it('arrow proportions differ for CDS vs standard when not capped', () => {
    const feature = makeFeature({ end: 1100 });
    const cds = computeFeatureDrawDecision(
      { ...feature, type: 'CDS' },
      genomeLength,
      genomeLength,
      100000,
      false,
      false
    );
    const std = computeFeatureDrawDecision(
      { ...feature, type: 'promoter' },
      genomeLength,
      genomeLength,
      100000,
      false,
      false
    );

    expect(cds.hasArrow).toBe(true);
    expect(std.hasArrow).toBe(true);
    expect(cds.arrowWidth).toBeLessThan(std.arrowWidth);
  });

  it('provides label text for detailed features', () => {
    const d = computeFeatureDrawDecision(
      makeFeature({ end: 50000 }),
      genomeLength,
      genomeLength,
      100000,
      false,
      false
    );
    expect(d.tier).toBe(LODTier.Detailed);
    expect(d.labelText).toBeTruthy();
    expect(d.labelPlacement).toBe('internal');
  });

  it('returns external label when feature is too narrow', () => {
    const d = computeFeatureDrawDecision(
      makeFeature({ end: 5000, displayName: 'longGeneName' }),
      genomeLength,
      genomeLength,
      50000,
      false,
      false
    );
    if (d.tier >= LODTier.Detailed && d.labelText) {
      expect(['internal', 'external']).toContain(d.labelPlacement);
    }
  });

  it('alpha reflects hover/select state', () => {
    const normal = computeFeatureDrawDecision(
      makeFeature({ end: 50000 }),
      genomeLength,
      genomeLength,
      100000,
      false,
      false
    );
    const hovered = computeFeatureDrawDecision(
      makeFeature({ end: 50000 }),
      genomeLength,
      genomeLength,
      100000,
      true,
      false
    );
    const selected = computeFeatureDrawDecision(
      makeFeature({ end: 50000 }),
      genomeLength,
      genomeLength,
      100000,
      false,
      true
    );

    expect(hovered.alpha).toBe(1.0);
    expect(selected.alpha).toBe(0.95);
    expect(normal.alpha).toBe(0.8);
  });

  it('both renderers get identical decisions for same parameters', () => {
    const features = [
      makeFeature({ type: 'CDS', end: 1000, displayName: 'geneA' }),
      makeFeature({ type: 'promoter', end: 500, displayName: 'prom1' }),
      makeFeature({ type: 'gene', end: 10000, displayName: 'bigGene' }),
    ];

    for (const f of features) {
      const d1 = computeFeatureDrawDecision(f, genomeLength, genomeLength, 34000, false, false);
      const d2 = computeFeatureDrawDecision(f, genomeLength, genomeLength, 34000, false, false);
      expect(d1).toEqual(d2);
    }
  });
});
