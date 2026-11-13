import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { GenomeFeature } from '@waypoint/genome-data';

import {
  createBudgetedBestAvailableAnnotationPayload,
  estimateFeatureBytes,
} from './genome-annotation-tile-budget';

describe('annotation viewport tile budget fallback', () => {
  it('compacts dense raw annotation rows into a bounded best-available payload', () => {
    const rawFeatures = Array.from({ length: 12 }, (_, index): GenomeFeature => {
      const start = 10_000 + index * 100;
      return {
        chrom: 'chr11',
        source: 'fixture',
        type: 'mRNA',
        start,
        end: start + 80,
        score: null,
        strand: '+',
        phase: null,
        attributes: {
          ID: [`tx-${index}`],
          Name: [`TX${index}`],
          product: ['dense transcript fixture'],
        },
        raw: `chr11\tfixture\tmRNA\t${start}\t${start + 80}\t.\t+\t.\t${'x'.repeat(20_000)}`,
      };
    });

    expect(estimateFeatureBytes(rawFeatures)).toBeGreaterThan(200_000);

    const payload = createBudgetedBestAvailableAnnotationPayload({
      rawFeatures,
      byteBudget: 2_000,
    });

    expect(payload.featureModel).toBe('resolved-transcript-v2');
    expect(payload.sourceRepresentationComplete).toBe(true);
    expect(payload.sourceRecordCount).toBe(rawFeatures.length);
    expect(payload.features.length).toBeGreaterThan(0);
    expect(payload.byteCount).toBeLessThanOrEqual(2_000);
    expect(payload.features.every((feature) => feature.raw === '')).toBe(true);
    expect(payload.layerTypes).toContain('mRNA');
  });

  it('marks a byte-capped resolved representation incomplete', () => {
    const rawFeatures = Array.from(
      { length: 4 },
      (_, index): GenomeFeature => ({
        chrom: 'chr11',
        source: 'fixture',
        type: 'mRNA',
        start: 10_000 + index * 100,
        end: 10_080 + index * 100,
        score: null,
        strand: '+',
        phase: null,
        attributes: { ID: [`tx-${index}`], product: ['dense transcript fixture'] },
        raw: '',
      })
    );

    const payload = createBudgetedBestAvailableAnnotationPayload({
      rawFeatures,
      byteBudget: 200,
    });

    expect(payload.features.length).toBeGreaterThan(0);
    expect(payload.features.length).toBeLessThan(rawFeatures.length);
    expect(payload.sourceRepresentationComplete).toBe(false);
  });

  it('producer attaches degradedReason="density" to budget-capped tiles (source-level guard)', () => {
    const src = readFileSync(
      resolve(process.cwd(), 'src/shared/genome-annotation-tiles.ts'),
      'utf8'
    );
    const matches = src.match(/degradedReason:\s*'density'/g) ?? [];
    expect(
      matches.length,
      'genome-annotation-tiles.ts must label both budget-cap paths with degradedReason: "density" (see Phase 3 plan F3)'
    ).toBeGreaterThanOrEqual(2);
  });
});
