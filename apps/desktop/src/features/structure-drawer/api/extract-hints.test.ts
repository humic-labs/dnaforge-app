// @vitest-environment node

import { describe, it, expect } from 'vitest';
import type { Annotation } from '@waypoint/sequence-utils';
import { extractHintsFromAnnotation } from './extract-hints';

function makeCDS(qualifiers: Record<string, string[]> = {}): Annotation {
  return {
    name: 'thrL',
    type: 'CDS',
    start: 1,
    end: 66,
    direction: 1,
    qualifiers,
  };
}

describe('extractHintsFromAnnotation', () => {
  it('returns an empty hints object when the CDS has no qualifiers and no usable name token', () => {
    expect(
      extractHintsFromAnnotation({
        name: '...',
        type: 'CDS',
        start: 1,
        end: 100,
        direction: 1,
      })
    ).toEqual({});
    expect(
      extractHintsFromAnnotation({
        name: '',
        type: 'CDS',
        start: 1,
        end: 100,
        direction: 1,
      })
    ).toEqual({});
  });

  it('falls back to Annotation.name when /gene= is absent (APE-style records)', () => {
    const cds: Annotation = {
      name: 'mioC CDS (flavoprotein MioC)',
      type: 'CDS',
      start: 1,
      end: 444,
      direction: -1,
    };
    expect(extractHintsFromAnnotation(cds)).toEqual({ geneName: 'mioC' });
  });

  it('rejects label tokens that look like sentence fragments', () => {
    expect(
      extractHintsFromAnnotation({
        name: 'thisIsTooLongForAGeneSymbol',
        type: 'CDS',
        start: 1,
        end: 100,
        direction: 1,
      })
    ).toEqual({});
    expect(
      extractHintsFromAnnotation({
        name: '12345NumericFirst',
        type: 'CDS',
        start: 1,
        end: 100,
        direction: 1,
      })
    ).toEqual({});
  });

  it('prefers /gene= over the name fallback when both are present', () => {
    const cds: Annotation = {
      name: 'XYZ different label',
      type: 'CDS',
      start: 1,
      end: 100,
      direction: 1,
      qualifiers: { gene: ['mioC'] },
    };
    expect(extractHintsFromAnnotation(cds).geneName).toBe('mioC');
  });

  it('extracts singleton qualifiers via array index 0', () => {
    const hints = extractHintsFromAnnotation(
      makeCDS({
        gene: ['thrL'],
        locus_tag: ['b0001'],
        protein_id: ['AAC73112.1'],
      })
    );
    expect(hints.geneName).toBe('thrL');
    expect(hints.locusTag).toBe('b0001');
    expect(hints.proteinId).toBe('AAC73112.1');
  });

  it('passes through the full /db_xref array', () => {
    const xrefs = [
      'UniProtKB/Swiss-Prot:P0AD86',
      'ASAP:ABE-0000006',
      'ECOCYC:EG10998',
      'EcoGene:EG10998',
    ];
    const hints = extractHintsFromAnnotation(makeCDS({ db_xref: xrefs }));
    expect(hints.dbXrefs).toEqual(xrefs);
  });

  it('parses taxonId out of /db_xref="taxon:..."', () => {
    const hints = extractHintsFromAnnotation(
      makeCDS({ db_xref: ['UniProtKB:P0AD86', 'taxon:83333'] })
    );
    expect(hints.taxonId).toBe(83333);
  });

  it('leaves taxonId undefined when no taxon xref is present', () => {
    const hints = extractHintsFromAnnotation(makeCDS({ db_xref: ['UniProtKB:P0AD86'] }));
    expect(hints.taxonId).toBeUndefined();
  });

  it('ignores malformed taxon entries (NaN parse)', () => {
    const hints = extractHintsFromAnnotation(makeCDS({ db_xref: ['taxon:not-a-number'] }));
    expect(hints.taxonId).toBeUndefined();
  });
});
