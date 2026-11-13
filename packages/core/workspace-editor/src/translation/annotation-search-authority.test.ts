import { describe, expect, it } from 'vitest';
import {
  cdsToProteinSpliced,
  searchAnnotationsAndProtein,
  type Annotation,
} from '@waypoint/sequence-utils';
import { aminoAcidCreationBlockedReason, getCDSTranslation } from './cds-translation';
import { buildSplicedCodingSequence } from './spliced-coding-sequence';

const fixtures: Array<{
  name: string;
  sequence: string;
  cds: Annotation;
  protein: string;
  range: [number, number];
}> = [
  {
    name: 'forward exon junction',
    sequence: 'ATGAAATTT',
    cds: {
      name: 'alpha',
      type: 'CDS',
      start: 1,
      end: 9,
      direction: 1,
      segments: [
        { start: 1, end: 3 },
        { start: 7, end: 9 },
      ],
    },
    protein: 'MF',
    range: [0, 8],
  },
  {
    name: 'reverse exon junction',
    sequence: 'AAATTTCAT',
    cds: {
      name: 'beta',
      type: 'CDS',
      start: 1,
      end: 9,
      direction: -1,
      segments: [
        { start: 1, end: 3 },
        { start: 7, end: 9 },
      ],
    },
    protein: 'MF',
    range: [0, 8],
  },
  {
    name: 'partial first codon',
    sequence: 'AATGAAA',
    cds: {
      name: 'gamma',
      type: 'CDS',
      start: 1,
      end: 7,
      direction: 1,
      qualifiers: { codon_start: ['2'] },
    },
    protein: 'MK',
    range: [1, 6],
  },
  {
    name: 'mitochondrial code declaration',
    sequence: 'ATATGA',
    cds: {
      name: 'delta',
      type: 'CDS',
      start: 1,
      end: 6,
      direction: 1,
      qualifiers: { transl_table: ['2'] },
    },
    protein: 'MW',
    range: [0, 5],
  },
  {
    name: 'selenocysteine exception',
    sequence: 'ATGTGA',
    cds: {
      name: 'epsilon',
      type: 'CDS',
      start: 1,
      end: 6,
      direction: 1,
      qualifiers: { transl_except: ['(pos:4..6,aa:Sec)'], translation: ['MU'] },
    },
    protein: 'MU',
    range: [0, 5],
  },
  {
    name: 'circular origin',
    sequence: 'AAATTTATG',
    cds: { name: 'zeta', type: 'CDS', start: 7, end: 3, direction: 1 },
    protein: 'MK',
    range: [6, 2],
  },
];

describe('annotation-aware protein search and creation', () => {
  for (const fixture of fixtures) {
    it(`finds and maps ${fixture.name} using the displayed protein`, () => {
      const { cds, sequence, protein, range } = fixture;
      expect(getCDSTranslation(cds, sequence)).toBe(protein);
      expect(cdsToProteinSpliced(cds, sequence, { sequenceLength: sequence.length })).toBe(protein);
      const hits = searchAnnotationsAndProtein([cds], sequence, protein);
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({
        type: 'protein',
        start: range[0],
        end: range[1],
        strand: cds.direction === -1 ? 'reverse' : 'forward',
      });
      expect(Boolean(hits[0].wraps)).toBe(range[0] > range[1]);
    });
  }

  it('allows creation of a declared selenoprotein', () => {
    const { cds, sequence } = fixtures[4];
    expect(buildSplicedCodingSequence(cds, sequence).translationMismatch).toBe(false);
    expect(aminoAcidCreationBlockedReason(cds, sequence)).toBeNull();
  });

  it('compares stored translation with the chosen record genetic code', () => {
    const cds: Annotation = {
      name: 'chosen',
      type: 'CDS',
      start: 1,
      end: 6,
      direction: 1,
      qualifiers: { transl_table: ['2'], translation: ['I'] },
    };
    expect(getCDSTranslation(cds, 'ATATGA', 1, 'chosen')).toBe('I');
    expect(aminoAcidCreationBlockedReason(cds, 'ATATGA', 1, 'chosen')).toBeNull();
  });

  it('keeps standard-code internal stops blocked', () => {
    const cds: Annotation = { name: 'control', type: 'CDS', start: 1, end: 9, direction: 1 };
    expect(getCDSTranslation(cds, 'ATGTGAAAA')).toBe('M*K');
    expect(aminoAcidCreationBlockedReason(cds, 'ATGTGAAAA')).toBe('internal_stop');
  });
});
