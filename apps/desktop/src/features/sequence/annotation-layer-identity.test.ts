// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  MOBILE_ELEMENT_LAYER_TYPE,
  annotationLayerLabel,
  annotationLayerType,
  isLayerIdentityAttributeKey,
  selectableAnnotationLayerTypesForGlyphMode,
  uniqueAnnotationLayerTypes,
} from './annotation-layer-identity';

describe('annotation layer identity — GFF3 subclass-qualifier convention', () => {
  describe('isLayerIdentityAttributeKey', () => {
    it('recognises keys ending in any registered suffix', () => {
      expect(isLayerIdentityAttributeKey('ncRNA_class')).toBe(true);
      expect(isLayerIdentityAttributeKey('regulatory_class')).toBe(true);
      expect(isLayerIdentityAttributeKey('mobile_element_type')).toBe(true);
      expect(isLayerIdentityAttributeKey('pseudogene_type')).toBe(true);
    });

    it('rejects keys that do not follow the convention', () => {
      expect(isLayerIdentityAttributeKey('ID')).toBe(false);
      expect(isLayerIdentityAttributeKey('Parent')).toBe(false);
      expect(isLayerIdentityAttributeKey('Name')).toBe(false);
      expect(isLayerIdentityAttributeKey('db_xref')).toBe(false);
      expect(isLayerIdentityAttributeKey('experiment')).toBe(false);
      expect(isLayerIdentityAttributeKey('gene_id')).toBe(false);
      expect(isLayerIdentityAttributeKey('transcript_id')).toBe(false);
      expect(isLayerIdentityAttributeKey('_lane')).toBe(false);
    });
  });

  describe('annotationLayerType (existing well-known cases)', () => {
    it('promotes ncRNA_class to layer identity (lncRNA / miRNA / …)', () => {
      expect(annotationLayerType({ type: 'ncRNA', attributes: { ncRNA_class: ['lncRNA'] } })).toBe(
        'lncRNA'
      );
      expect(
        annotationLayerType({ type: 'misc_RNA', attributes: { ncRNA_class: ['miRNA'] } })
      ).toBe('miRNA');
    });

    it('falls back to feature.type when no subclass qualifier is present', () => {
      expect(annotationLayerType({ type: 'mRNA' })).toBe('mRNA');
      expect(annotationLayerType({ type: 'tRNA', attributes: { ID: ['t-1'] } })).toBe('tRNA');
    });
  });

  describe('annotationLayerType (chr11 RefSeq regression —  2026-05-26)', () => {
    it('promotes regulatory_class subclasses to first-class layer badges', () => {
      const subclasses = [
        'enhancer',
        'silencer',
        'promoter',
        'insulator',
        'enhancer_blocking_element',
        'matrix_attachment_region',
        'DNase_I_hypersensitive_site',
        'TATA_box',
        'response_element',
        'locus_control_region',
        'imprinting_control_region',
        'CAAT_signal',
        'transcriptional_cis_regulatory_region',
        'replication_regulatory_region',
      ];
      for (const sub of subclasses) {
        expect(
          annotationLayerType({ type: 'regulatory', attributes: { regulatory_class: [sub] } })
        ).toBe(sub);
      }
    });

    it('draws every mobile element on one track whatever its category or name', () => {
      for (const value of [
        'transposon',
        'transposon:1360{}1005',
        'retrotransposon:YARCTy1-1',
        'insertion sequence:IS1A',
        'LINE:L1HS',
        'other:Tn7',
      ]) {
        expect(
          annotationLayerType({
            type: 'mobile_genetic_element',
            attributes: { mobile_element_type: [value] },
          })
        ).toBe(MOBILE_ELEMENT_LAYER_TYPE);
      }
      expect(annotationLayerType({ type: 'transposable_element' })).toBe(MOBILE_ELEMENT_LAYER_TYPE);
      expect(annotationLayerType({ type: 'LTR_retrotransposon' })).toBe(MOBILE_ELEMENT_LAYER_TYPE);
    });

    it('maps identities persisted by the per-family classifier to the shared track', () => {
      for (const stored of ['transposon:1360', 'insertion sequence:IS150', 'SINE:AluY', 'LINE']) {
        expect(annotationLayerLabel(stored)).toBe(MOBILE_ELEMENT_LAYER_TYPE);
      }
      expect(annotationLayerLabel('other')).toBe('other');
      expect(annotationLayerLabel('mature_protein_region_of_CDS')).toBe(
        'mature_protein_region_of_CDS'
      );
      expect(annotationLayerLabel(MOBILE_ELEMENT_LAYER_TYPE)).toBe(MOBILE_ELEMENT_LAYER_TYPE);
    });

    it('keeps every pseudogene on its pseudogene track whatever its pseudogene_type', () => {
      expect(
        annotationLayerType({
          type: 'pseudogene',
          attributes: { pseudogene_type: ['processed'] },
        })
      ).toBe('pseudogene');
    });
  });

  describe('annotationLayerType — which qualifiers name a track', () => {
    it('lets only feature-class qualifiers name a track', () => {
      expect(annotationLayerType({ type: 'ncRNA', attributes: { ncRNA_class: ['lncRNA'] } })).toBe(
        'lncRNA'
      );
      expect(
        annotationLayerType({ type: 'regulatory', attributes: { regulatory_class: ['enhancer'] } })
      ).toBe('enhancer');
      expect(
        annotationLayerType({ type: 'repeat_region', attributes: { rpt_type: ['tandem'] } })
      ).toBe('repeat_region');
      expect(
        annotationLayerType({
          type: 'recombination_feature',
          attributes: { recombination_class: ['meiotic'] },
        })
      ).toBe('recombination_feature');
      expect(
        annotationLayerType({ type: 'NEW_FUTURE_TYPE', attributes: { future_class: ['alpha'] } })
      ).toBe('NEW_FUTURE_TYPE');
    });

    it('hides the whole-sequence region that carries mol_type, like a GenBank source', () => {
      expect(
        annotationLayerType({ type: 'region', attributes: { mol_type: ['genomic DNA'] } })
      ).toBe('source');
      expect(annotationLayerType({ type: 'region' })).toBe('region');
    });

    it('maps rows persisted by the old any-qualifier rule to their feature track', () => {
      expect(annotationLayerLabel('genomic DNA')).toBe('source');
      expect(annotationLayerLabel('genomic RNA')).toBe('source');
      expect(annotationLayerLabel('dispersed')).toBe('repeat_region');
      expect(annotationLayerLabel('non_allelic_homologous')).toBe('recombination_feature');
      expect(annotationLayerLabel('mRNA')).toBe('mRNA');
    });

    it('skips empty or whitespace-only subclass values', () => {
      expect(
        annotationLayerType({
          type: 'regulatory',
          attributes: { regulatory_class: ['', '   ', 'silencer'] },
        })
      ).toBe('silencer');
      expect(
        annotationLayerType({
          type: 'regulatory',
          attributes: { regulatory_class: ['', '   '] },
        })
      ).toBe('regulatory');
    });
  });

  describe('uniqueAnnotationLayerTypes', () => {
    it('surfaces each distinct subclass as its own layer (the chr11 enhancer/silencer/lncRNA bug)', () => {
      const layers = uniqueAnnotationLayerTypes([
        { type: 'mRNA' },
        { type: 'mRNA' },
        { type: 'regulatory', attributes: { regulatory_class: ['enhancer'] } },
        { type: 'regulatory', attributes: { regulatory_class: ['enhancer'] } },
        { type: 'regulatory', attributes: { regulatory_class: ['silencer'] } },
        { type: 'regulatory', attributes: { regulatory_class: ['promoter'] } },
        { type: 'ncRNA', attributes: { ncRNA_class: ['lncRNA'] } },
        { type: 'ncRNA', attributes: { ncRNA_class: ['miRNA'] } },
        { type: 'mobile_element', attributes: { mobile_element_type: ['transposon'] } },
        {
          type: 'mobile_genetic_element',
          attributes: { mobile_element_type: ['transposon:1360{}1005'] },
        },
        {
          type: 'mobile_genetic_element',
          attributes: { mobile_element_type: ['transposon:roo{}6606'] },
        },
        { type: 'source' },
      ]);
      expect(layers).toEqual([
        'enhancer',
        'lncRNA',
        'miRNA',
        'mobile_genetic_element',
        'mRNA',
        'promoter',
        'silencer',
      ]);
    });
  });

  describe('glyph-mode inventory topology', () => {
    it('filters raw transcript children but preserves an already-resolved compound CDS glyph', () => {
      const types = ['gene', 'mRNA', 'CDS', 'exon'];

      expect(selectableAnnotationLayerTypesForGlyphMode(types, true)).toEqual(['mRNA']);
      expect(
        selectableAnnotationLayerTypesForGlyphMode(types, true, { inventory: 'resolved' })
      ).toEqual(['CDS', 'exon', 'gene', 'mRNA']);
    });

    it('keeps the track names a published package compiled, even superseded ones', () => {
      const types = ['genomic DNA', 'mRNA', 'retrotransposon:YARCTy1-1'];

      expect(selectableAnnotationLayerTypesForGlyphMode(types, true)).toEqual([
        'mobile_genetic_element',
        'mRNA',
      ]);
      expect(
        selectableAnnotationLayerTypesForGlyphMode(types, true, { inventory: 'resolved' })
      ).toEqual(['genomic DNA', 'mRNA', 'retrotransposon:YARCTy1-1']);
    });
  });
});
