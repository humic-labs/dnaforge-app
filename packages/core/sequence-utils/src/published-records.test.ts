import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseGenBankFull } from './parsers/genbank';
import { cdsToProteinSpliced } from './translation';
import { readCodon } from './codon-reading';
import { translExceptsOf } from './transl-except';

const FIXTURES = join(__dirname, '../../../../test-fixtures/sequences');
const load = (p: string) => parseGenBankFull(readFileSync(join(FIXTURES, p), 'utf8'));

function translate(record: ReturnType<typeof parseGenBankFull>, cdsName: string): string {
  const cds = (record.annotations ?? []).find(
    (a) => a.type === 'CDS' && (a.qualifiers?.product?.[0] === cdsName || a.name === cdsName)
  );
  if (!cds) throw new Error(`no CDS named ${cdsName}`);
  const dna = record.sequence.slice(cds.start - 1, cds.end).toUpperCase();
  let protein = '';
  for (let i = 0; i + 3 <= dna.length; i += 3) {
    protein += readCodon({
      codon: dna.slice(i, i + 3),
      at: cds.start + i,
      ...(cds.qualifiers ? { qualifiers: cds.qualifiers } : {}),
    }).short;
  }
  return protein;
}

describe('pBAD-sfGFP150TAG (PX848777) — the target', () => {
  const record = load('circular/pbad-sfgfp150tag-amber-reporter.gb');
  const cds = (record.annotations ?? []).find((a) => a.type === 'CDS')!;

  it('is the file this feature exists for: it contradicts itself about its own code', () => {
    expect(cds.qualifiers?.transl_table?.[0]).toBe('11');
    expect(cds.qualifiers?.translation?.[0]?.replace(/\s+/g, '')).toHaveLength(247);
    expect(cds.qualifiers?.transl_except?.[0]).toBe('(pos:766..768,aa:OTHER)');
  });

  it('translates to exactly the protein its submitter deposited', () => {
    const deposited = cds.qualifiers!.translation![0].replace(/\s+/g, '');
    const ours = translate(record, 'sfGFP-N150TAG');
    expect(ours.replace(/\*$/, '')).toBe(deposited);
  });

  it('puts a non-standard residue at 150, where the declared table says stop', () => {
    const ours = translate(record, 'sfGFP-N150TAG');
    expect(ours[149]).toBe('X');
    expect(ours.slice(150)).not.toHaveLength(0);
    expect(ours.slice(150, 155)).toBe('VYITA');
  });

  it('gives the SAME protein through the text path the app exports and folds', () => {
    const deposited = cds.qualifiers!.translation![0].replace(/\s+/g, '');
    expect(cdsToProteinSpliced(cds, record.sequence)).toBe(deposited);
  });

  it('would stop at 149 if the exception were ignored, which is the bug', () => {
    const dna = record.sequence.slice(cds.start - 1, cds.end).toUpperCase();
    const withoutException = readCodon({ codon: dna.slice(447, 450), at: 1 });
    expect(withoutException).toMatchObject({ short: '*', kind: 'stop' });
  });
});

describe('pBARN-MmtRNAPylCUA (PX848776) — the suppressor', () => {
  const record = load('circular/pbarn-amber-suppressor-trna.gb');

  it('says in a machine-readable feature that it suppresses amber codons', () => {
    const trna = (record.annotations ?? []).find((a) => a.type === 'tRNA');
    expect(trna?.qualifiers?.note?.[0]).toMatch(/amber suppression/i);
  });

  it('declares three codon exceptions, and we read all three', () => {
    expect(
      translExceptsOf(
        readFileSync(join(FIXTURES, 'circular/pbarn-amber-suppressor-trna.gb'), 'utf8')
      )
    ).toHaveLength(3);
  });
});

describe('C321.deltaA (CP006698) — the recoded host', () => {
  const gb = readFileSync(join(FIXTURES, 'linear/c321-deltaA-prfa-locus-region.gb'), 'utf8');
  const record = parseGenBankFull(gb);

  it('declares table 11 on every CDS, under which TAG is a stop', () => {
    const cdss = (record.annotations ?? []).filter((a) => a.type === 'CDS');
    expect(cdss.length).toBeGreaterThan(50);
    for (const cds of cdss) expect(cds.qualifiers?.transl_table?.[0]).toBe('11');
  });

  it('says in prose what no qualifier can say: TAG was recoded and RF1 deleted', () => {
    expect(gb).toMatch(/replaced all UAG stop codons with its synonym UAA/);
    expect(gb).toMatch(/removed RF1 \(prfA gene\)/);
  });

  it('has no prfA, which is the machine-checkable half of that claim', () => {
    const genes = (record.annotations ?? []).map((a) => a.qualifiers?.gene?.[0]);
    expect(genes).not.toContain('prfA');
  });

  it('declares no codon exceptions, so nothing overrides its table here', () => {
    expect(translExceptsOf(gb)).toHaveLength(0);
  });
});
