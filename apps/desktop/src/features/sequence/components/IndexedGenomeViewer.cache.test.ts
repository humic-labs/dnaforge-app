// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { applyDensityControls, uniqueFeatureTypes } from './indexed-genome-legacy-adapter';
import {
  defaultVisibleAnnotationTypes,
  toggleAnnotationLaneVisible,
  toggleVisibleFeatureType,
  visibleTypesForGlyphMode,
} from './indexed-genome-viewer-controls';
import { annotationLayerType } from '../annotation-layer-identity';
import type { GenomeFeature } from '@waypoint/genome-data';

describe('defaultVisibleAnnotationTypes', () => {
  it('prefers a true transcript track when the admitted roster contains one', () => {
    expect([...defaultVisibleAnnotationTypes(['CDS', 'ncRNA', 'mRNA'])]).toEqual(['mRNA']);
  });

  it('prefers dense CDS annotations over sparse RNA classes for transcript-less genomes', () => {
    expect([...defaultVisibleAnnotationTypes(['ncRNA', 'rRNA', 'tRNA', 'CDS'])]).toEqual(['CDS']);
  });
});

describe('visibleTypesForGlyphMode', () => {
  it('removes folded source rows from the glyph-v2 render filter', () => {
    const effective = visibleTypesForGlyphMode(
      new Set([
        'gene',
        'mRNA',
        'CDS',
        'exon',
        'five_prime_UTR',
        'three_prime_UTR',
        'UTR',
        'start_codon',
        'stop_codon',
        'regulatory',
      ]),
      true
    );

    expect([...effective].sort()).toEqual(['mRNA', 'regulatory']);
  });

  it('preserves legacy-mode type selections', () => {
    const visible = new Set(['gene', 'mRNA', 'CDS']);
    const effective = visibleTypesForGlyphMode(visible, false);

    expect(effective).toBe(visible);
    expect([...effective].sort()).toEqual(['CDS', 'gene', 'mRNA']);
  });

  it('preserves a top-level compound CDS from an authoritative resolved product roster', () => {
    const effective = visibleTypesForGlyphMode(new Set(['CDS']), true, ['CDS']);

    expect([...effective]).toEqual(['CDS']);
  });

  it('does not resurrect raw child rows that are absent from the resolved product roster', () => {
    const effective = visibleTypesForGlyphMode(new Set(['mRNA', 'CDS', 'exon']), true, ['mRNA']);

    expect([...effective]).toEqual(['mRNA']);
  });

  it('renders no guessed assembly track while the resolved product roster is pending', () => {
    const effective = visibleTypesForGlyphMode(new Set(['mRNA']), true, []);

    expect([...effective]).toEqual([]);
  });
});

describe('toggleAnnotationLaneVisible', () => {
  it('stashes the exact non-empty type selection and restores it', () => {
    const selected = new Set(['mRNA', 'enhancer']);
    const off = toggleAnnotationLaneVisible(selected, null, new Set(['gene']));
    expect([...off.next]).toEqual([]);
    expect([...off.stash!].sort()).toEqual(['enhancer', 'mRNA']);

    const on = toggleAnnotationLaneVisible(off.next, off.stash, new Set(['gene']));
    expect([...on.next].sort()).toEqual(['enhancer', 'mRNA']);
    expect(on.stash).toBeNull();
  });

  it('uses the fallback only when no non-empty selection was stashed', () => {
    const on = toggleAnnotationLaneVisible(new Set(), null, new Set(['gene', 'mRNA']));
    expect([...on.next].sort()).toEqual(['gene', 'mRNA']);
  });
});

describe('indexed annotation layer identity', () => {
  const feature = (overrides: Partial<GenomeFeature>): GenomeFeature => ({
    chrom: 'chrTest',
    source: 'test',
    type: 'misc_feature',
    start: 0,
    end: 10,
    score: null,
    strand: '+',
    phase: null,
    attributes: {},
    raw: '',
    ...overrides,
  });

  it('promotes ncRNA_class=lncRNA to a first-class layer badge', () => {
    expect(
      annotationLayerType(
        feature({ type: 'ncRNA', attributes: { ID: ['rna-1'], ncRNA_class: ['lncRNA'] } })
      )
    ).toBe('lncRNA');
  });

  it('promotes all ncRNA_class values to first-class biological layer badges', () => {
    const available = uniqueFeatureTypes([
      feature({ type: 'mRNA' }),
      feature({ type: 'ncRNA', attributes: { ncRNA_class: ['lncRNA'] } }),
      feature({ type: 'misc_RNA', attributes: { ncRNA_class: ['miRNA'] } }),
      feature({ type: 'ncRNA', attributes: { ncRNA_class: ['snoRNA'] } }),
      feature({ type: 'ncRNA', attributes: { ncRNA_class: ['snRNA'] } }),
      feature({ type: 'ncRNA', attributes: { ncRNA_class: ['scaRNA'] } }),
      feature({ type: 'ncRNA', attributes: { ncRNA_class: ['novel_RNA_class'] } }),
      feature({ type: 'ncRNA', attributes: {} }),
    ]);

    expect(available).toEqual([
      'lncRNA',
      'miRNA',
      'mRNA',
      'ncRNA',
      'novel_RNA_class',
      'scaRNA',
      'snoRNA',
      'snRNA',
    ]);
  });

  it('keeps direct RNA feature types such as rRNA and tRNA as badges', () => {
    const available = uniqueFeatureTypes([
      feature({ type: 'rRNA' }),
      feature({ type: 'tRNA' }),
      feature({ type: 'ncRNA', attributes: { ncRNA_class: ['lncRNA'] } }),
    ]);

    expect(available).toEqual(['lncRNA', 'rRNA', 'tRNA']);
  });

  it('does not expose the non-informative GFF source row as a user layer', () => {
    const available = uniqueFeatureTypes([feature({ type: 'source' }), feature({ type: 'mRNA' })]);

    expect(available).toEqual(['mRNA']);
  });

  it('filters lncRNA by biological layer identity, not raw source feature type', () => {
    const lnc = feature({
      type: 'ncRNA',
      start: 20,
      end: 80,
      attributes: { ID: ['lnc-1'], ncRNA_class: ['lncRNA'] },
    });
    const genericNc = feature({
      type: 'ncRNA',
      start: 120,
      end: 180,
      attributes: { ID: ['nc-1'] },
    });
    const mrna = feature({ type: 'mRNA', start: 220, end: 280, attributes: { ID: ['mrna-1'] } });

    const result = applyDensityControls(
      [lnc, genericNc, mrna],
      'chrTest',
      1000,
      new Set(['lncRNA']),
      null
    );

    expect(result.typeFilteredCount).toBe(1);
    expect(result.features).toHaveLength(1);
    expect(result.features[0].qualifiers?.ID).toBe('lnc-1');
  });
});

describe('visible feature toggle state', () => {
  it('applies rapid badge toggles from the latest selected set', () => {
    const first = toggleVisibleFeatureType(new Set(['mRNA']), 'centromere');
    const second = toggleVisibleFeatureType(first, 'lncRNA');

    expect([...second].sort()).toEqual(['centromere', 'lncRNA', 'mRNA']);
  });
});
