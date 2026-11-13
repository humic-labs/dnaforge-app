import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  codonExceptionDisplay,
  codonExceptionsOf,
  formatTranslExcept,
  parseTranslExcept,
  residueAbbreviationFromNote,
  residueNameFromNote,
  translExceptsOf,
  withTranslExcept,
} from './transl-except';

const FIXTURES = join(__dirname, '../../../../test-fixtures/sequences');

describe('parsing one /transl_except value', () => {
  it('reads a base range and a standard three-letter amino acid', () => {
    expect(parseTranslExcept('(pos:213..215,aa:Trp)')).toEqual({
      location: { start: 213, end: 215 },
      aa: { kind: 'standard', abbreviation: 'Trp', letter: 'W', name: 'Tryptophan' },
    });
  });

  it('reads a single-base position, which a partial stop codon uses', () => {
    expect(parseTranslExcept('(pos:1017,aa:TERM)')).toEqual({
      location: { start: 1017, end: 1017 },
      aa: { kind: 'stop' },
    });
  });

  it('reads a two-base partial stop completed by poly-A on the mRNA', () => {
    expect(parseTranslExcept('(pos:2000..2001,aa:TERM)')).toEqual({
      location: { start: 2000, end: 2001 },
      aa: { kind: 'stop' },
    });
  });

  it('reads a position in another entry without losing the accession', () => {
    expect(parseTranslExcept('(pos:X22222:15..17,aa:Ala)')).toMatchObject({
      location: { accession: 'X22222', start: 15, end: 17 },
      aa: { kind: 'standard', letter: 'A' },
    });
  });

  it('reads selenocysteine, which the spec calls out by name', () => {
    expect(parseTranslExcept('(pos:1002..1004,aa:Sec)')).toMatchObject({
      aa: { kind: 'standard', abbreviation: 'Sec', letter: 'U' },
    });
  });

  it('reads a modified residue that has a name but no one-letter code', () => {
    expect(parseTranslExcept('(pos:10..12,aa:Nle)')).toMatchObject({
      aa: { kind: 'modified', abbreviation: 'Nle', name: 'Norleucine' },
    });
  });

  it('reads OTHER, the value that means "look at the note"', () => {
    expect(parseTranslExcept('(pos:766..768,aa:OTHER)')).toEqual({
      location: { start: 766, end: 768 },
      aa: { kind: 'other' },
    });
  });

  it('tolerates the whitespace real files contain', () => {
    expect(parseTranslExcept('( pos: 766..768 , aa: OTHER )')).toMatchObject({
      location: { start: 766, end: 768 },
      aa: { kind: 'other' },
    });
  });

  it('reads a complemented position rather than dropping the exception', () => {
    expect(parseTranslExcept('(pos:complement(213..215),aa:Trp)')).toMatchObject({
      location: { start: 213, end: 215, complement: true },
    });
  });

  it('refuses nonsense instead of guessing', () => {
    expect(parseTranslExcept('(pos:213..215)')).toBeNull();
    expect(parseTranslExcept('aa:Trp')).toBeNull();
    expect(parseTranslExcept('')).toBeNull();
  });

  it('treats an abbreviation outside the vocabulary as unreadable, never as OTHER', () => {
    expect(parseTranslExcept('(pos:1..3,aa:Wibble)')).toBeNull();
  });
});

describe('the residue name a note carries', () => {
  it('lifts a name the spec told the submitter to put there', () => {
    expect(residueNameFromNote('p-azido-L-phenylalanine')).toBe('p-azido-L-phenylalanine');
  });

  it('finds the name inside a longer sentence', () => {
    expect(residueNameFromNote('site of incorporation of p-benzoyl-L-phenylalanine (pBpa)')).toBe(
      'p-benzoyl-L-phenylalanine'
    );
  });

  it('says nothing rather than guessing from prose that names no residue', () => {
    expect(
      residueNameFromNote('superfolder green fluorescent protein with an amber stop codon')
    ).toBeNull();
  });

  it('says nothing for prose that names no residue but dodges a word blocklist', () => {
    expect(residueNameFromNote('amber suppression site')).toBeNull();
  });

  it('reads a bare one-word name, which is what the spec asks submitters for', () => {
    expect(residueNameFromNote('Norleucine')).toBe('Norleucine');
    expect(residueNameFromNote('selenocysteine')).toBe('selenocysteine');
  });

  it('reads a modified residue written without hyphens', () => {
    expect(residueNameFromNote('N6-Boc-L-lysine')).toBe('N6-Boc-L-lysine');
    expect(residueNameFromNote('3-hydroxyaspartic acid')).toBe('3-hydroxyaspartic');
  });

  it('reads a chemical name written as two words ending in "acid"', () => {
    expect(residueNameFromNote('L-2-aminobutyric acid')).toBe('L-2-aminobutyric acid');
  });

  it('never returns prose, even prose containing a hyphen', () => {
    expect(residueNameFromNote('serine hydrolase-resistant analog')).toBeNull();
    expect(residueNameFromNote('tyrosine kinase substrate motif')).toBeNull();
    expect(residueNameFromNote('arginine finger of the AAA+ ATPase')).toBeNull();
  });

  it('never returns a plain amino acid the note merely mentions', () => {
    expect(
      residueNameFromNote(
        'incorporates an unnatural amino acid replacing genomically-encoded serine'
      )
    ).toBeNull();
    expect(
      residueNameFromNote('nonstandard residue similar to arginine decarboxylase substrate')
    ).toBeNull();
    expect(residueNameFromNote('this position historically encoded glycine')).toBeNull();
  });

  it('stays fast on a note built to make a backtracking parser hang', () => {
    const started = Date.now();
    expect(residueNameFromNote('p-'.repeat(2000))).toBeNull();
    expect(Date.now() - started).toBeLessThan(250);
  });
});

describe('the residue abbreviation a note offers in brackets', () => {
  it('takes the short form an author bracketed', () => {
    expect(residueAbbreviationFromNote('p-azido-L-phenylalanine (pAzF)')).toBe('pAzF');
  });

  it('does not mistake a bracketed codon for the residue', () => {
    expect(residueAbbreviationFromNote('amber (TAG) suppression')).toBeNull();
  });
});

describe('the two published records this feature exists for', () => {
  it('reads the amber codon out of the sfGFP reporter', () => {
    const gb = readFileSync(join(FIXTURES, 'circular/pbad-sfgfp150tag-amber-reporter.gb'), 'utf8');
    const excepts = translExceptsOf(gb);
    expect(excepts).toHaveLength(1);
    expect(excepts[0]).toEqual({
      location: { start: 766, end: 768 },
      aa: { kind: 'other' },
    });
  });

  it('reads all three exceptions on the suppressor plasmid', () => {
    const gb = readFileSync(join(FIXTURES, 'circular/pbarn-amber-suppressor-trna.gb'), 'utf8');
    expect(translExceptsOf(gb)).toHaveLength(3);
  });

  it('finds none in a record that declares no exception', () => {
    const gb = readFileSync(join(FIXTURES, 'linear/c321-deltaA-prfa-locus-region.gb'), 'utf8');
    expect(translExceptsOf(gb)).toHaveLength(0);
  });
});

describe('keeping exceptions on a feature, and changing them', () => {
  const sfgfp = {
    transl_except: ['(pos:766..768,aa:OTHER)'],
    note: ['p-azido-L-phenylalanine (pAzF)'],
  };

  it('indexes by the first base of the codon, which is how a renderer asks', () => {
    const found = codonExceptionsOf(sfgfp);
    expect([...found.keys()]).toEqual([766]);
    expect(found.get(766)).toMatchObject({
      residueName: 'p-azido-L-phenylalanine',
      residueAbbreviation: 'pAzF',
    });
  });

  it('draws one character for protein text and the short name where there is room', () => {
    expect(codonExceptionDisplay(codonExceptionsOf(sfgfp).get(766)!)).toEqual({
      short: 'X',
      full: 'pAzF',
      kind: 'residue',
    });
  });

  it('falls back to X when the note names nothing', () => {
    const bare = codonExceptionsOf({ transl_except: ['(pos:766..768,aa:OTHER)'] });
    expect(codonExceptionDisplay(bare.get(766)!)).toEqual({
      short: 'X',
      full: 'X',
      kind: 'residue',
    });
  });

  it('uses the letter for an exception that has one, and * for a terminator', () => {
    const trp = codonExceptionsOf({ transl_except: ['(pos:10..12,aa:Trp)'] }).get(10)!;
    expect(codonExceptionDisplay(trp)).toEqual({ short: 'W', full: 'W', kind: 'amino-acid' });
    const term = codonExceptionsOf({ transl_except: ['(pos:1017,aa:TERM)'] }).get(1017)!;
    expect(codonExceptionDisplay(term)).toEqual({ short: '*', full: '*', kind: 'stop' });
  });

  it('names a modified residue by its abbreviation, which fits a cell', () => {
    const nle = codonExceptionsOf({ transl_except: ['(pos:4..6,aa:Nle)'] }).get(4)!;
    expect(codonExceptionDisplay(nle)).toEqual({ short: 'X', full: 'Nle', kind: 'residue' });
  });

  it('writes an exception back in the form it was read', () => {
    const roundTrip = (raw: string) => formatTranslExcept(parseTranslExcept(raw)!);
    expect(roundTrip('(pos:766..768,aa:OTHER)')).toBe('(pos:766..768,aa:OTHER)');
    expect(roundTrip('(pos:1017,aa:TERM)')).toBe('(pos:1017,aa:TERM)');
    expect(roundTrip('(pos:213..215,aa:Trp)')).toBe('(pos:213..215,aa:Trp)');
    expect(roundTrip('(pos:X22222:15..17,aa:Ala)')).toBe('(pos:X22222:15..17,aa:Ala)');
    expect(roundTrip('(pos:complement(213..215),aa:Trp)')).toBe(
      '(pos:complement(213..215),aa:Trp)'
    );
  });

  it('replaces the exception at a codon rather than leaving two that disagree', () => {
    const changed = withTranslExcept(sfgfp, 766, parseTranslExcept('(pos:766..768,aa:Trp)'));
    expect(changed.transl_except).toEqual(['(pos:766..768,aa:Trp)']);
    expect(changed.note).toEqual(['p-azido-L-phenylalanine (pAzF)']);
  });

  it('adds one without disturbing an exception elsewhere on the same feature', () => {
    const two = withTranslExcept(sfgfp, 100, parseTranslExcept('(pos:100..102,aa:Sec)'));
    expect(two.transl_except).toEqual(['(pos:766..768,aa:OTHER)', '(pos:100..102,aa:Sec)']);
  });

  it('removes the qualifier entirely when the last exception goes', () => {
    expect(withTranslExcept(sfgfp, 766, null)).not.toHaveProperty('transl_except');
  });
});
