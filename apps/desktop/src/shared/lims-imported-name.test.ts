// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { deriveImportedSequenceName, isGenericSequenceName } from './lims';

describe('isGenericSequenceName', () => {
  it('treats placeholders / ids as generic', () => {
    for (const n of [
      '',
      '   ',
      'sequence-222046-',
      'sequence',
      'Sequence',
      'seq_1',
      'Untitled',
      'unnamed',
      'Exported',
      'export2',
      'new-sequence',
      'contig_12',
      'scaffold3',
      '123456',
    ]) {
      expect(isGenericSequenceName(n)).toBe(true);
    }
  });

  it('treats real identities as NOT generic', () => {
    for (const n of ['pUC19', 'pLKO.1-puro', 'MG1655', 'NC_000913.3', 'BBa_K123', 'my-plasmid']) {
      expect(isGenericSequenceName(n)).toBe(false);
    }
  });
});

describe('deriveImportedSequenceName', () => {
  it('prefers a MEANINGFUL parsed LOCUS over the file name', () => {
    expect(deriveImportedSequenceName('pLKO.1-puro', 'addgene-8453.gb')).toBe('pLKO.1-puro');
  });

  it('falls back to the file STEM when the LOCUS is a generic placeholder (the reported bug)', () => {
    expect(deriveImportedSequenceName('sequence-222046-', 'pUC19.gb')).toBe('pUC19');
    expect(deriveImportedSequenceName('sequence-222046-', 'dragged-plasmid.gb')).toBe(
      'dragged-plasmid'
    );
  });

  it('uses the file stem when there is no parsed name at all', () => {
    expect(deriveImportedSequenceName(undefined, 'my-favorite-plasmid.fasta')).toBe(
      'my-favorite-plasmid'
    );
    expect(deriveImportedSequenceName('', 'construct7.gbk')).toBe('construct7');
  });

  it('never returns an empty string', () => {
    expect(deriveImportedSequenceName(undefined, '')).toBe('Sequence');
    expect(deriveImportedSequenceName('sequence-1', 'sequence-2.gb')).toBeTruthy();
  });

  it('prefers the filename when the LOCUS is a fixed-width TRUNCATION of it', () => {
    expect(
      deriveImportedSequenceName('pDEMO054_CRISTAL-RT-Cas', 'pDEMO054_CRISTAL-RT-Cas9.gb')
    ).toBe('pDEMO054_CRISTAL-RT-Cas9');
    expect(
      deriveImportedSequenceName('(n1)StayGold(c4).hybrid_', '(n1)StayGold(c4).hybrid_opt.REmin.gb')
    ).toBe('(n1)StayGold(c4).hybrid_opt.REmin');
    expect(deriveImportedSequenceName('oPNC6', 'oPNC667.gb')).toBe('oPNC667');
  });

  it('keeps a COMPLETE LOCUS when the filename is only a separated variant (not a truncation)', () => {
    expect(deriveImportedSequenceName('pUC19', 'pUC19-copy.gb')).toBe('pUC19');
    expect(deriveImportedSequenceName('pLKO.1-puro', 'pLKO.1-puro.gb')).toBe('pLKO.1-puro');
  });
});
