import { describe, expect, it } from 'vitest';
import { readCodon } from './codon-reading';

describe('the name a codon reads as', () => {
  it('names an ordinary amino acid in full', () => {
    expect(readCodon({ codon: 'ATG', at: 1 }).name).toBe('Methionine');
    expect(readCodon({ codon: 'TGG', at: 1 }).name).toBe('Tryptophan');
  });

  it('names a stop plainly rather than with a symbol', () => {
    expect(readCodon({ codon: 'TGA', at: 1 }).name).toBe('Stop');
  });

  it('names selenocysteine, which a record declares by abbreviation', () => {
    const reading = readCodon({
      codon: 'TGA',
      at: 10,
      qualifiers: { transl_table: ['11'], transl_except: ['(pos:10..12,aa:Sec)'] },
    });
    expect(reading.name).toBe('Selenocysteine');
  });

  it('names a modified residue from the published vocabulary', () => {
    const reading = readCodon({
      codon: 'TGA',
      at: 10,
      qualifiers: { transl_except: ['(pos:10..12,aa:Nle)'] },
    });
    expect(reading.name).toBe('Norleucine');
  });

  it('uses the chemical name a note gives for a residue outside the vocabulary', () => {
    const reading = readCodon({
      codon: 'TAG',
      at: 766,
      qualifiers: {
        transl_table: ['11'],
        transl_except: ['(pos:766..768,aa:OTHER)'],
        note: ['p-azido-L-phenylalanine (pAzF)'],
      },
    });
    expect(reading.name).toBe('p-azido-L-phenylalanine');
  });

  it('says what it can when the note names nothing', () => {
    const reading = readCodon({
      codon: 'TAG',
      at: 766,
      qualifiers: { transl_table: ['11'], transl_except: ['(pos:766..768,aa:OTHER)'] },
    });
    expect(reading.name).toBe('Unnamed residue');
  });

  it('is honest about a codon nothing decodes', () => {
    expect(readCodon({ codon: 'ATG', at: 1 }).name).not.toBe('Unassigned');
  });

  it('gives a name for every codon of the standard table', () => {
    const bases = ['T', 'C', 'A', 'G'];
    for (const a of bases)
      for (const b of bases)
        for (const c of bases) {
          const name = readCodon({ codon: a + b + c, at: 1 }).name;
          expect(name.length).toBeGreaterThan(1);
        }
  });
});
