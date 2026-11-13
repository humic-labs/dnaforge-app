// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import type { GenomeFeature, IndexedGenomeManifest } from '../../shared/indexed-genome';
import type { VariantSummary } from './variant-client';
import {
  classifyMutationAnnotationImpact,
  loadMutationAnnotationImpacts,
} from './mutation-annotation-impact';

const MANIFEST: IndexedGenomeManifest = {
  chrom: 'chr1',
  fastaPath: '/reference/chr1.fa',
  faiPath: '/reference/chr1.fa.fai',
  gffPath: '/reference/chr1.gff3.gz',
  tbiPath: '/reference/chr1.gff3.gz.tbi',
  length: 248_956_422,
};

const CODING_FEATURES: GenomeFeature[] = [
  feature('gene', 923_922, 944_574, {
    ID: ['SAMD11.gene.1'],
    Name: ['SAMD11'],
    gene: ['SAMD11'],
  }),
  feature('mRNA', 923_922, 944_574, {
    ID: ['SAMD11.mrna.1'],
    Name: ['NM_001385640.1'],
    gene: ['SAMD11'],
    transcript_id: ['NM_001385640.1'],
  }),
  feature('exon', 923_922, 924_948, {
    ID: ['SAMD11.exon.1'],
    Parent: ['SAMD11.mrna.1'],
    gene: ['SAMD11'],
    transcript_id: ['NM_001385640.1'],
  }),
  feature('CDS', 924_431, 924_948, {
    ID: ['SAMD11.cds.1'],
    Parent: ['SAMD11.mrna.1'],
    Name: ['NP_001372569.1'],
    gene: ['SAMD11'],
    protein_id: ['NP_001372569.1'],
  }),
];

describe('mutation annotation impact', () => {
  it('identifies every affected annotation and calls out a CDS substitution', () => {
    const impact = classifyMutationAnnotationImpact(
      variant({
        id: 'coding-snv',
        start: 924_532,
        end: 924_533,
        position: 924_533,
        ref: 'A',
        alts: ['G'],
        variantClass: 'substitution',
      }),
      CODING_FEATURES
    );

    expect(impact.overlapsAnnotation).toBe(true);
    expect(impact.overlapsCds).toBe(true);
    expect(impact.codingEffect).toEqual({
      label: 'CDS substitution',
      frameEffect: null,
    });
    expect(impact.annotations.map(({ type, label }) => ({ type, label }))).toEqual([
      { type: 'gene', label: 'SAMD11' },
      { type: 'mRNA', label: 'NM_001385640.1' },
      { type: 'exon', label: 'NM_001385640.1' },
      { type: 'CDS', label: 'NP_001372569.1' },
    ]);
  });

  it.each([
    {
      name: 'one-base insertion',
      ref: 'A',
      alt: 'AT',
      variantClass: 'insertion' as const,
      label: 'Frameshift-risk CDS insertion',
      frameEffect: 'frameshift-risk',
    },
    {
      name: 'three-base insertion',
      ref: 'A',
      alt: 'ATGC',
      variantClass: 'insertion' as const,
      label: 'In-frame CDS insertion',
      frameEffect: 'in-frame',
    },
    {
      name: 'one-base deletion',
      ref: 'AT',
      alt: 'A',
      variantClass: 'deletion' as const,
      label: 'Frameshift-risk CDS deletion',
      frameEffect: 'frameshift-risk',
    },
    {
      name: 'three-base deletion',
      ref: 'ATGC',
      alt: 'A',
      variantClass: 'deletion' as const,
      label: 'In-frame CDS deletion',
      frameEffect: 'in-frame',
    },
  ])('classifies $name from the allele-length change', (testCase) => {
    const impact = classifyMutationAnnotationImpact(
      variant({
        ref: testCase.ref,
        alts: [testCase.alt],
        variantClass: testCase.variantClass,
      }),
      CODING_FEATURES
    );

    expect(impact.codingEffect).toEqual({
      label: testCase.label,
      frameEffect: testCase.frameEffect,
    });
  });

  it('does not claim a coding effect for a gene-only overlap', () => {
    const impact = classifyMutationAnnotationImpact(variant(), [
      feature('gene', 924_000, 925_000, {
        ID: ['LOC107985728.gene.1'],
        gene: ['LOC107985728'],
      }),
    ]);

    expect(impact.overlapsAnnotation).toBe(true);
    expect(impact.overlapsCds).toBe(false);
    expect(impact.codingEffect).toBeNull();
    expect(impact.annotations).toEqual([
      expect.objectContaining({ type: 'gene', label: 'LOC107985728' }),
    ]);
  });

  it('reports a real empty result instead of treating intergenic calls as unavailable', () => {
    expect(
      classifyMutationAnnotationImpact(variant(), [
        feature('region', 0, 248_956_422, {
          ID: ['chr1'],
          Name: ['1'],
        }),
      ])
    ).toEqual({
      variantId: 'variant',
      overlapsAnnotation: false,
      overlapsCds: false,
      codingEffect: null,
      annotations: [],
      hiddenAnnotationCount: 0,
      truncated: false,
    });
  });

  it('coalesces nearby variants into one bounded indexed-GFF read', async () => {
    const first = variant({ id: 'first', start: 924_532, end: 924_533, position: 924_533 });
    const second = variant({ id: 'second', start: 960_100, end: 960_101, position: 960_101 });
    const readFeatures = vi.fn(async () => CODING_FEATURES);

    const impacts = await loadMutationAnnotationImpacts({
      variants: [first, second],
      manifests: new Map([['chr1', MANIFEST]]),
      readFeatures,
    });

    expect(readFeatures).toHaveBeenCalledTimes(1);
    expect(readFeatures).toHaveBeenCalledWith(MANIFEST, 'chr1', 0, 1_000_000, 1);
    expect(impacts.get('first')).toMatchObject({
      status: 'ready',
      impact: { overlapsCds: true },
    });
    expect(impacts.get('second')).toMatchObject({
      status: 'ready',
      impact: { overlapsAnnotation: false },
    });
  });

  it('marks a chromosome without indexed annotations unavailable without issuing I/O', async () => {
    const readFeatures = vi.fn();
    const impacts = await loadMutationAnnotationImpacts({
      variants: [variant()],
      manifests: new Map(),
      readFeatures,
    });

    expect(readFeatures).not.toHaveBeenCalled();
    expect(impacts.get('variant')).toEqual({
      status: 'unavailable',
      message: 'Reference annotations are unavailable for chr1.',
    });
  });
});

function variant(overrides: Partial<VariantSummary> = {}): VariantSummary {
  return {
    id: 'variant',
    recordId: null,
    chrom: 'chr1',
    start: 924_532,
    end: 924_533,
    position: 924_533,
    ref: 'A',
    alts: ['G'],
    quality: 60,
    filters: ['PASS'],
    variantClass: 'substitution',
    genotypes: { HG002: '0/1' },
    ...overrides,
  };
}

function feature(
  type: string,
  start: number,
  end: number,
  attributes: Record<string, string[]>
): GenomeFeature {
  return {
    chrom: 'chr1',
    source: 'DNAForge',
    type,
    start,
    end,
    score: null,
    strand: '+',
    phase: type === 'CDS' ? '0' : null,
    attributes,
    raw: '',
  };
}
