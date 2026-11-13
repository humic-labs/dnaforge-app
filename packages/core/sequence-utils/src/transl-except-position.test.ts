import { describe, expect, it } from 'vitest';
import { codonPositionOf } from './codon-reading';
import { cdsToProteinSpliced } from './translation';
import { classifyMutation } from './mutation-classifier';
import type { Annotation } from './types';

const FORWARD = 'ATGAAATAGAAA';
const REVERSE = 'TTTCTATTTCAT';

const suppressed = {
  transl_table: ['11'],
  note: ['p-azido-L-phenylalanine (pAzF)'],
};

function cds(over: Partial<Annotation>): Annotation {
  return {
    name: 'gene',
    type: 'CDS',
    start: 1,
    end: 12,
    direction: 1,
    color: '',
    ...over,
  } as Annotation;
}

describe('the position that names a codon', () => {
  it('is the lowest of its three bases, whichever way the gene reads', () => {
    expect(codonPositionOf(7, 8, 9)).toBe(7);
    expect(codonPositionOf(9, 8, 7)).toBe(7);
  });

  it('survives a codon whose bases are not all known', () => {
    expect(codonPositionOf(9, undefined, 7)).toBe(7);
  });
});

describe('protein text and a codon exception, on each strand', () => {
  it('reads the exception on the forward strand', () => {
    const protein = cdsToProteinSpliced(
      cds({ qualifiers: { ...suppressed, transl_except: ['(pos:7..9,aa:OTHER)'] } }),
      FORWARD
    );
    expect(protein).toBe('MKXK');
  });

  it('reads the exception on the reverse strand, written as a plain range', () => {
    const protein = cdsToProteinSpliced(
      cds({ direction: -1, qualifiers: { ...suppressed, transl_except: ['(pos:4..6,aa:OTHER)'] } }),
      REVERSE
    );
    expect(protein).toBe('MKXK');
  });

  it('reads the exception on the reverse strand, written with complement()', () => {
    const protein = cdsToProteinSpliced(
      cds({
        direction: -1,
        qualifiers: { ...suppressed, transl_except: ['(pos:complement(4..6),aa:OTHER)'] },
      }),
      REVERSE
    );
    expect(protein).toBe('MKXK');
  });

  it('still reads the codon as a stop when no exception names it', () => {
    expect(cdsToProteinSpliced(cds({ qualifiers: { transl_table: ['11'] } }), FORWARD)).toBe(
      'MK*K'
    );
    expect(
      cdsToProteinSpliced(cds({ direction: -1, qualifiers: { transl_table: ['11'] } }), REVERSE)
    ).toBe('MK*K');
  });

  it('applies an exception only to the codon it names, on the reverse strand too', () => {
    expect(
      cdsToProteinSpliced(
        cds({
          direction: -1,
          qualifiers: { ...suppressed, transl_except: ['(pos:1..3,aa:OTHER)'] },
        }),
        REVERSE
      )
    ).toBe('MK*K');
  });
});

describe('the mutation classifier and a spliced gene', () => {
  const SPLICED = 'ATGAAAgggTAGAAAC';
  const mutated = SPLICED.slice(0, 14) + 'C' + SPLICED.slice(15);
  const spliced = (qualifiers: Record<string, string[]>): Annotation =>
    cds({
      end: 15,
      segments: [
        { start: 1, end: 6 },
        { start: 10, end: 15 },
      ],
      qualifiers: { _locationString: ['join(1..6,10..15)'], ...qualifiers },
    });
  const classify = (qualifiers: Record<string, string[]>) =>
    classifyMutation(
      { type: 'substitution', position: 15, ref_base: 'A', query_base: 'C' },
      SPLICED,
      mutated,
      [spliced(qualifiers)]
    );

  it('calls an ordinary substitution missense', () => {
    expect(classify({ transl_table: ['11'] }).classification).toBe('missense');
  });

  it('does NOT apply an exception that names a different codon', () => {
    expect(
      classify({ transl_table: ['11'], transl_except: ['(pos:1..3,aa:Trp)'] }).classification
    ).toBe('missense');
  });

  it('DOES apply an exception that names the mutated codon', () => {
    expect(
      classify({ transl_table: ['11'], transl_except: ['(pos:13..15,aa:Trp)'] }).classification
    ).toBe('synonymous');
  });
});

describe('the shape real selenoprotein records use', () => {
  it('reads Sec on a spliced minus-strand gene instead of ending the protein', () => {
    const seq = 'TTTTCAgggTTTCAT';
    const protein = cdsToProteinSpliced(
      cds({
        end: 15,
        direction: -1,
        segments: [
          { start: 1, end: 6 },
          { start: 10, end: 15 },
        ],
        qualifiers: {
          _locationString: ['complement(join(1..6,10..15))'],
          transl_table: ['1'],
          transl_except: ['(pos:complement(4..6),aa:Sec)'],
        },
      }),
      seq
    );
    expect(protein).toBe('MKUK');
  });
});
