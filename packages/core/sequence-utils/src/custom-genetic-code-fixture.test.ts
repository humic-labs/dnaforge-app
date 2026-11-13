import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildCustomGeneticCode } from './custom-genetic-codes';
import { readGenBankGeneticCode, updateGenBankGeneticCodeComment } from './genbank-genetic-code';
import { codonDisplay } from './custom-genetic-codes';

const FIXTURE_PATH = join(
  __dirname,
  '../../../../test-fixtures/sequences/linear/custom-genetic-code-ochre-synthetic.gb'
);

const OCHRE = (() => {
  const built = buildCustomGeneticCode({
    id: 'gc-f11e0f1ea0b1',
    revision: 1,
    name: 'Ochre suppression (pBpa at TAA)',
    base: 1,
    changes: { TAA: { kind: 'residue', residue: 'pBpa' } },
    residues: [{ abbreviation: 'pBpa', name: 'p-benzoyl-L-phenylalanine', ccd: 'BPA' }],
  });
  if (!built.ok) throw new Error(`fixture code must build: ${JSON.stringify(built.issues)}`);
  return built.definition;
})();

const CODONS = [
  'ATG',
  'AAA',
  'GGT',
  'TTC',
  'CAT',
  'GAA',
  'CGT',
  'TAA',
  'GTT',
  'TGG',
  'CTG',
  'AAC',
  'GAT',
  'CAG',
  'TAC',
  'ATC',
  'CCG',
  'GCA',
  'TGA',
];

const CDS = CODONS.join('');
const TRAIL = 'GCATGCATGC'.repeat(6);
const SEQUENCE = (CDS + TRAIL).toLowerCase();

function originBlock(sequence: string): string[] {
  const lines: string[] = [];
  for (let at = 0; at < sequence.length; at += 60) {
    const groups = sequence.slice(at, at + 60).match(/.{1,10}/g) ?? [];
    lines.push(`${String(at + 1).padStart(9)} ${groups.join(' ')}`);
  }
  return lines;
}

function bareGenBank(): string {
  return [
    `LOCUS       OCHRE_PROBE              ${SEQUENCE.length} bp    DNA     linear   SYN 15-SEP-2026`,
    'DEFINITION  A record that carries its own genetic code, readable with no library.',
    'ACCESSION   OCHRE_PROBE',
    'VERSION     OCHRE_PROBE',
    'KEYWORDS    .',
    'SOURCE      synthetic construct',
    '  ORGANISM  synthetic construct',
    '            other sequences; artificial sequences; synthetic construct.',
    'FEATURES             Location/Qualifiers',
    `     source          1..${SEQUENCE.length}`,
    '                     /organism="synthetic construct"',
    '                     /mol_type="other DNA"',
    `     CDS             1..${CDS.length}`,
    '                     /label="ochre probe"',
    '                     /product="ochre suppression probe"',
    'ORIGIN',
    ...originBlock(SEQUENCE),
    '//',
    '',
  ].join('\n');
}

const EXPECTED = updateGenBankGeneticCodeComment(bareGenBank(), OCHRE);

describe('the custom-genetic-code fixture', () => {
  it('matches what the product would write for this record', () => {
    if (process.env.UPDATE_FIXTURES === '1') {
      writeFileSync(FIXTURE_PATH, EXPECTED);
    }
    expect(readFileSync(FIXTURE_PATH, 'utf8')).toBe(EXPECTED);
  });

  it('reads back the whole code from the file alone, with no library', () => {
    const reading = readGenBankGeneticCode(readFileSync(FIXTURE_PATH, 'utf8').split('\n'));
    expect(reading.kind).toBe('code');
    if (reading.kind !== 'code') throw new Error('unreachable');
    expect(reading.spec).toEqual(OCHRE);
  });

  it('puts the non-standard residue at codon 8, where the standard code stops', () => {
    const inFrameTaa = SEQUENCE.slice(21, 24).toUpperCase();
    expect(inFrameTaa).toBe('TAA');
    expect(codonDisplay(inFrameTaa, OCHRE)).toMatchObject({ kind: 'residue', full: 'pBpa' });
    expect(codonDisplay(inFrameTaa, 1)).toMatchObject({ kind: 'stop' });
  });

  it('ends on a codon that stops under this code, so the gene is well formed', () => {
    expect(codonDisplay('TGA', OCHRE)).toMatchObject({ kind: 'stop' });
  });
});
