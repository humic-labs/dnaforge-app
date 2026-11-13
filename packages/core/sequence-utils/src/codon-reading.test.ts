import { describe, expect, it } from 'vitest';
import { codonReaderFor, readCodon } from './codon-reading';

describe('a reader bound to live feature qualifiers', () => {
  it('retains live multi-value qualifiers without keeping stale legacy exceptions', () => {
    const qualifiers = { transl_table: '4' };
    const qualifierValues = {
      transl_table: ['11'],
      transl_except: ['(pos:4..6,aa:Sec)'],
    };
    const bound = codonReaderFor({ qualifiers, qualifierValues });
    expect(bound('TGA', 4).short).toBe('U');
    qualifierValues.transl_except[0] = '(pos:1..3,aa:Sec)';
    expect(bound('TGA', 4).kind).toBe('stop');
    expect(bound('TGA', 1).short).toBe('U');
    qualifierValues.transl_table[0] = '4';
    expect(bound('TGA', 4).short).toBe('W');
    expect(bound('TGA', 1).short).toBe('W');
  });

  it.each(['declared', 'chosen'] as const)(
    'matches complete direct readings across positions and qualifier edits with a %s record code',
    (recordBasis) => {
      const qualifiers = {
        transl_table: ['11'],
        transl_except: ['(pos:10..12,aa:OTHER)'],
        note: ['p-azido-L-phenylalanine (pAzF)'],
      };
      const feature = Object.freeze({ qualifiers });
      const bound = codonReaderFor(feature, 3, recordBasis);
      const checkReadings = () => {
        for (const [codon, at] of [
          ['tag', 10],
          ['TAG', 13],
          ['AAA', 10],
          ['TGA', 10],
          ['TGA', 13],
          ['NNK', 16],
          ['CTG', 10],
        ] as const) {
          const context = Object.freeze({ codon, at, qualifiers, recordCode: 3, recordBasis });
          const before = structuredClone(context);
          expect(bound(codon, at)).toEqual(readCodon(context));
          expect(context).toEqual(before);
        }
      };
      checkReadings();
      qualifiers.transl_except[0] = '(pos:13..15,aa:Sec)';
      checkReadings();
      qualifiers.transl_table[0] = '28';
      qualifiers.transl_except = [];
      checkReadings();
      qualifiers.transl_except = ['(pos:10..12,aa:OTHER)'];
      qualifiers.note[0] = 'unidentified residue';
      checkReadings();
      qualifiers.transl_except[0] = '(pos:10..12,aa:Met)';
      checkReadings();
    }
  );
});

describe('which instruction decides a codon', () => {
  it('reads by the standard code when nothing says otherwise', () => {
    expect(readCodon({ codon: 'TGA', at: 1 })).toMatchObject({ short: '*', kind: 'stop' });
  });

  it("uses the record's code for a feature that declares nothing", () => {
    expect(readCodon({ codon: 'TGA', at: 1, recordCode: 3 })).toMatchObject({
      short: 'W',
      kind: 'amino-acid',
    });
  });

  it("lets a feature's own table beat a record code it merely inherited", () => {
    const reading = readCodon({
      codon: 'TGA',
      at: 1,
      qualifiers: { transl_table: ['1'] },
      recordCode: 3,
      recordBasis: 'declared',
    });
    expect(reading).toMatchObject({ short: '*', kind: 'stop' });
  });

  it('lets a code the user chose beat the table the feature declares', () => {
    const reading = readCodon({
      codon: 'TGA',
      at: 1,
      qualifiers: { transl_table: ['1'] },
      recordCode: 3,
      recordBasis: 'chosen',
    });
    expect(reading).toMatchObject({ short: 'W', kind: 'amino-acid' });
  });

  it('lets a codon exception beat everything, because it is about this codon', () => {
    const reading = readCodon({
      codon: 'TAG',
      at: 766,
      qualifiers: {
        transl_table: ['11'],
        transl_except: ['(pos:766..768,aa:OTHER)'],
        note: ['p-azido-L-phenylalanine (pAzF)'],
      },
    });
    expect(reading).toMatchObject({ short: 'X', full: 'pAzF', kind: 'residue' });
    expect(reading.fromException).toBe(true);
  });

  it('applies an exception only to the codon it names', () => {
    const qualifiers = {
      transl_table: ['11'],
      transl_except: ['(pos:766..768,aa:OTHER)'],
      note: ['p-azido-L-phenylalanine (pAzF)'],
    };

    expect(readCodon({ codon: 'TAG', at: 100, qualifiers })).toMatchObject({
      short: '*',
      kind: 'stop',
    });
  });

  it('reads an exception that names an ordinary amino acid', () => {
    expect(
      readCodon({ codon: 'TGA', at: 10, qualifiers: { transl_except: ['(pos:10..12,aa:Trp)'] } })
    ).toMatchObject({ short: 'W', full: 'W', kind: 'amino-acid' });
  });

  it('reads an exception that says this codon terminates', () => {
    expect(
      readCodon({ codon: 'AAA', at: 10, qualifiers: { transl_except: ['(pos:10..12,aa:TERM)'] } })
    ).toMatchObject({ short: '*', kind: 'stop' });
  });

  it('says X when an exception names a residue the note does not identify', () => {
    const reading = readCodon({
      codon: 'TAG',
      at: 766,
      qualifiers: {
        transl_except: ['(pos:766..768,aa:OTHER)'],
        note: ['amber stop codon at position N150 for amber suppression'],
      },
    });
    expect(reading).toMatchObject({ short: 'X', full: 'X', kind: 'residue' });
  });
});

describe('the two qualifier shapes the renderers hand it', () => {
  it('accepts one value per qualifier, as the WebGL renderer has them', () => {
    expect(
      readCodon({ codon: 'TGA', at: 1, qualifiers: { transl_table: '1' }, recordCode: 3 })
    ).toMatchObject({ short: '*' });
  });

  it('accepts a list per qualifier, as GenBank parsing produces', () => {
    expect(
      readCodon({ codon: 'TGA', at: 1, qualifiers: { transl_table: ['1'] }, recordCode: 3 })
    ).toMatchObject({ short: '*' });
  });

  it('ignores a declared table that is not a published one, rather than guessing', () => {
    expect(
      readCodon({ codon: 'TGA', at: 1, qualifiers: { transl_table: ['999'] }, recordCode: 3 })
    ).toMatchObject({ short: 'W' });
  });
});

describe('what it reports back', () => {
  it('keeps protein text one character per residue, whatever the name', () => {
    const reading = readCodon({
      codon: 'TAG',
      at: 766,
      qualifiers: {
        transl_except: ['(pos:766..768,aa:OTHER)'],
        note: ['p-azido-L-phenylalanine (pAzF)'],
      },
    });
    expect(reading.short).toHaveLength(1);
  });

  it('marks an ordinary reading as not coming from an exception', () => {
    expect(readCodon({ codon: 'ATG', at: 1 }).fromException).toBe(false);
  });
});

describe('a codon that both encodes and terminates', () => {
  it('reports a suppressed stop as still able to terminate', () => {
    const reading = readCodon({
      codon: 'TAG',
      at: 766,
      qualifiers: {
        transl_table: ['11'],
        transl_except: ['(pos:766..768,aa:OTHER)'],
        note: ['p-azido-L-phenylalanine (pAzF)'],
      },
    });
    expect(reading).toMatchObject({ short: 'X', kind: 'residue' });
    expect(reading.alsoTerminates).toBe(true);
  });

  it('does not claim a second product where no stop was suppressed', () => {
    expect(
      readCodon({ codon: 'AAA', at: 10, qualifiers: { transl_except: ['(pos:10..12,aa:Trp)'] } })
        .alsoTerminates
    ).toBe(false);
  });

  it('marks the dual-function codons NCBI itself defines', () => {
    const reading = readCodon({ codon: 'TAA', at: 1, recordCode: 28 });
    expect(reading.kind).toBe('amino-acid');
    expect(reading.alsoTerminates).toBe(true);
  });

  it('leaves an ordinary codon alone', () => {
    expect(readCodon({ codon: 'ATG', at: 1 }).alsoTerminates).toBe(false);
    expect(readCodon({ codon: 'TGA', at: 1 }).alsoTerminates).toBe(false);
  });
});

describe('protein text stays something other tools can read', () => {
  const IUPAC = /^[ACDEFGHIKLMNPQRSTVWYBZJUOX*]$/;

  it('emits a legal one-letter code for an ordinary codon', () => {
    expect(readCodon({ codon: 'ATG', at: 1 }).short).toMatch(IUPAC);
    expect(readCodon({ codon: 'TGA', at: 1 }).short).toMatch(IUPAC);
  });

  it('emits X, not a punctuation mark, for a residue it cannot name', () => {
    const reading = readCodon({
      codon: 'TAG',
      at: 766,
      qualifiers: { transl_except: ['(pos:766..768,aa:OTHER)'] },
    });
    expect(reading.short).toBe('X');
    expect(reading.short).toMatch(IUPAC);
  });

  it('keeps the richer answer available without putting it in the text', () => {
    const reading = readCodon({
      codon: 'TAG',
      at: 766,
      qualifiers: {
        transl_except: ['(pos:766..768,aa:OTHER)'],
        note: ['p-azido-L-phenylalanine (pAzF)'],
      },
    });
    expect(reading.short).toBe('X');
    expect(reading.full).toBe('pAzF');
    expect(reading.kind).toBe('residue');
  });
});

describe('an exception that no longer describes the codon under it', () => {
  it('drops a Sec exception once its stop codon is edited away', () => {
    const qualifiers = { transl_table: ['11'], transl_except: ['(pos:10..12,aa:Sec)'] };
    expect(readCodon({ codon: 'TGA', at: 10, qualifiers }).short).toBe('U');
    expect(readCodon({ codon: 'AAA', at: 10, qualifiers })).toMatchObject({
      short: 'K',
      fromException: false,
    });
  });

  it('drops a Pyl exception the same way', () => {
    const qualifiers = { transl_table: ['11'], transl_except: ['(pos:10..12,aa:Pyl)'] };
    expect(readCodon({ codon: 'TAG', at: 10, qualifiers }).short).toBe('O');
    expect(readCodon({ codon: 'GGG', at: 10, qualifiers }).fromException).toBe(false);
  });

  it('keeps an alternative-initiator exception, which never named a stop', () => {
    const reading = readCodon({
      codon: 'CTG',
      at: 10,
      qualifiers: { transl_except: ['(pos:10..12,aa:Met)'] },
    });
    expect(reading).toMatchObject({ short: 'M', fromException: true });
  });
});
