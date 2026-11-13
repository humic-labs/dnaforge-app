import { describe, it, expect } from 'vitest';
import { resolveImportSource } from './lims-import-source';

const noPath = () => '';

describe('resolveImportSource — paste source ', () => {
  it('maps TAB-delimited paste to a .tsv content source (no path → apply materializes a file)', async () => {
    const text = 'Name\tSequence\nprimer-1\tACGTACGT';
    const r = await resolveImportSource({ kind: 'paste', text, kindLabel: 'oligo' }, noPath);
    expect(r).toMatchObject({
      fileName: 'pasted-oligo.tsv',
      isWorkbook: false,
      text,
      sourcePath: undefined,
    });
  });

  it('maps COMMA-delimited paste to a .csv content source, named per the kind label', async () => {
    const text = 'Name,Species\nBW25113,E. coli';
    const r = await resolveImportSource({ kind: 'paste', text, kindLabel: 'strain' }, noPath);
    expect(r.fileName).toBe('pasted-strain.csv');
    expect(r.isWorkbook).toBe(false);
    expect(r.text).toBe(text);
    expect(r.sourcePath).toBeUndefined();
  });

  it('strips a leading BOM before sniffing the delimiter (BOM must not hide the header tab)', async () => {
    const r = await resolveImportSource(
      { kind: 'paste', text: '\uFEFFName\tSequence\nx\tACGT', kindLabel: 'oligo' },
      noPath
    );
    expect(r.text?.startsWith('\uFEFF')).toBe(false);
    expect(r.fileName).toBe('pasted-oligo.tsv');
  });

  it('only the FIRST row decides the extension — a tab deeper in the body does not force .tsv', async () => {
    const text = 'Name,Notes\nprimer-1,has\ttab';
    const r = await resolveImportSource({ kind: 'paste', text, kindLabel: 'oligo' }, noPath);
    expect(r.fileName).toBe('pasted-oligo.csv');
  });

  it('a LEADING BLANK line does not misclassify a TSV paste as .csv (review fix)', async () => {
    const text = '\n\nName\tSequence\nprimer-1\tACGTACGT';
    const r = await resolveImportSource({ kind: 'paste', text, kindLabel: 'oligo' }, noPath);
    expect(r.fileName).toBe('pasted-oligo.tsv');
  });

  it('preserves pasted protein FASTA as a FASTA source instead of inventing CSV provenance', async () => {
    const text = [
      '',
      '>sp|P0A7M2|RL28_ECOLI Large ribosomal subunit protein bL28',
      'MSRVCQVTGKRPVTGNNRSHALNATKRRFLPNLHSHRFWVESEKRFVTLRVSAKGMRVIDKKGIDTVLAELRARGEKY',
      '>sp|P0A7M6|RL29_ECOLI Large ribosomal subunit protein uL29',
      'MKAKELREKSVEELNTELLNLLREQFNLRMQAASGQLQQSHLLKQVRRDVARVKTLLNEKAGA',
    ].join('\n');
    const r = await resolveImportSource({ kind: 'paste', text, kindLabel: 'protein' }, noPath);

    expect(r.fileName).toBe('pasted-protein.fasta');
    expect(r.text).toBe(text);
  });
});
