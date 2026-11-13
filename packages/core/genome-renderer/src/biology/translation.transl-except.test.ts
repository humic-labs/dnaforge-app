import { describe, expect, it } from 'vitest';
import { translateCDS } from './translation';

const SEQUENCE = 'ATGAAATAGAAA';

function codonsOf(options: Parameters<typeof translateCDS>[6]) {
  return translateCDS(SEQUENCE, 0, SEQUENCE.length, 'forward', SEQUENCE.length, false, options).map(
    (codon) => codon.aa
  );
}

describe('the WebGL map and /transl_except', () => {
  it.each([
    {
      sequence: 'ATGCCCTAGAAA',
      direction: 'forward' as const,
      at: '7..9',
      aa: 'Pyl',
      expected: 'MOK',
      full: 'O',
    },
    {
      sequence: 'TTACCCTCACAT',
      direction: 'reverse' as const,
      at: 'complement(7..9)',
      aa: 'Sec',
      expected: 'MU*',
      full: 'U',
    },
  ])(
    'keeps exception identity and stop status in a $direction spliced CDS',
    ({ sequence, direction, at, aa, expected, full }) => {
      const codons = translateCDS(sequence, 0, sequence.length, direction, sequence.length, false, {
        segments: [
          { start: 1, end: 3 },
          { start: 7, end: 12 },
        ],
        qualifiers: { transl_except: `(pos:${at},aa:${aa})` },
      });
      expect(codons.map((codon) => codon.aa).join('')).toBe(expected);
      expect(codons[1].display).toMatchObject({ full, kind: 'amino-acid', fromException: true });
      expect(codons[1].isStop).toBe(false);
    }
  );
  it('stops at an in-frame TAG when the file says nothing', () => {
    expect(codonsOf({})).toEqual(['M', 'K', '*', 'K']);
  });

  it('reads the codon the file flags as an exception, and carries the frame on', () => {
    expect(
      codonsOf({
        qualifiers: {
          transl_table: '11',
          transl_except: '(pos:7..9,aa:OTHER)',
          note: 'p-azido-L-phenylalanine (pAzF)',
        },
      })
    ).toEqual(['M', 'K', 'X', 'K']);
  });

  it('applies the exception only to the codon it names', () => {
    expect(codonsOf({ qualifiers: { transl_except: '(pos:100..102,aa:OTHER)' } })).toEqual([
      'M',
      'K',
      '*',
      'K',
    ]);
  });

  it('reads an exception that names an ordinary amino acid', () => {
    expect(codonsOf({ qualifiers: { transl_except: '(pos:7..9,aa:Trp)' } })).toEqual([
      'M',
      'K',
      'W',
      'K',
    ]);
  });

  it("still honours the record's genetic code where no exception applies", () => {
    expect(codonsOf({ sequenceGeneticCode: 3 })).toEqual(['M', 'K', '*', 'K']);
  });

  it('carries the name through so a surface with room can draw it', () => {
    const codons = translateCDS(SEQUENCE, 0, SEQUENCE.length, 'forward', SEQUENCE.length, false, {
      qualifiers: {
        transl_except: '(pos:7..9,aa:OTHER)',
        note: 'p-azido-L-phenylalanine (pAzF)',
      },
    });
    expect(codons[2].display).toMatchObject({ short: 'X', full: 'pAzF', kind: 'residue' });
  });
});
