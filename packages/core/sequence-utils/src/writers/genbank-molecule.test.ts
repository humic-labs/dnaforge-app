import { describe, expect, it } from 'vitest';
import { parseGenBankFull } from '../parsers/genbank';
import { isRnaMolecule, parseGenBankMoleculeLabel } from '../molecule-type';
import { serializeGenBank } from './genbank';

const RNA = 'AUGACCAUGAUUACGGAUUCACUGGCCGUCGUUUUACAACGUCGUGACUGGG';

describe('GenBank LOCUS molecule type', () => {
  it.each([
    ['DNA     linear', 'DNA'],
    ['RNA     linear', 'RNA'],
    ['mRNA    linear', 'mRNA'],
    ['ss-RNA  circular', 'ss-RNA'],
    ['ds-DNA  linear', 'ds-DNA'],
    ['linear', null],
  ])('reads %s as %s', (tail, label) => {
    expect(parseGenBankMoleculeLabel(tail)).toBe(label);
  });

  it('round-trips an RNA record with its uracil bases', () => {
    const content = serializeGenBank({
      id: 'guide',
      name: 'guide',
      sequence: RNA,
      length: RNA.length,
      annotations: [],
      molecule: 'RNA',
    });
    expect(content).toMatch(/^LOCUS\s+guide\s+52 bp\s+RNA\s+linear\b/m);
    const reopened = parseGenBankFull(content);
    expect(reopened.molecule).toBe('RNA');
    expect(isRnaMolecule(reopened.molecule)).toBe(true);
    expect(reopened.sequence).toBe(RNA);
    expect(serializeGenBank(reopened, { date: new Date(2026, 0, 1) })).toBe(
      serializeGenBank({ ...reopened }, { date: new Date(2026, 0, 1) })
    );
  });

  it('keeps an mRNA label exactly', () => {
    const reopened = parseGenBankFull(
      serializeGenBank({
        id: 'm',
        name: 'm',
        sequence: RNA,
        length: 52,
        annotations: [],
        molecule: 'mRNA',
      })
    );
    expect(reopened.molecule).toBe('mRNA');
  });

  it('leaves DNA records without a molecule field and writes DNA', () => {
    const content = serializeGenBank({
      id: 'd',
      name: 'd',
      sequence: 'ACGT',
      length: 4,
      annotations: [],
    });
    expect(content).toMatch(/^LOCUS\s+d\s+4 bp\s+DNA\s+linear\b/m);
    expect('molecule' in parseGenBankFull(content)).toBe(false);
    expect(isRnaMolecule(undefined)).toBe(false);
  });
});
