import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseGenBankFull } from './genbank';

const BENCHLING_GB = `LOCUS       TESTCHR                 60 bp    DNA     linear   01-JAN-2025
DEFINITION  .
FEATURES             Location/Qualifiers
     source          1..60
     misc_feature    complement(1..15)
                     /label="TEL01L; Telomeric region on the left arm"
     misc_feature    1..30
                     /label="PAU8 CDS (seripauperin PAU8)"
     misc_feature    1..30
                     /label="PAU8 gene"
     misc_feature    1..30
                     /label="PAU8 mRNA (seripauperin PAU8)"
     misc_feature    20..40
                     /label="ARS102; Autonomously Replicating Sequence"
     misc_feature    45..55
                     /label="uncharacterized region X"
ORIGIN
        1 atgcatgcat gcatgcatgc atgcatgcat gcatgcatgc atgcatgcat gcatgcatgc
//
`;

const REFSEQ_GB = `LOCUS       NC_TEST                 60 bp    DNA     linear   01-JAN-2025
DEFINITION  .
FEATURES             Location/Qualifiers
     source          1..60
     CDS             1..30
                     /gene="REAL1"
                     /label="REAL1 gene product"
     tRNA            31..45
                     /label="tT(AGU) something"
ORIGIN
        1 atgcatgcat gcatgcatgc atgcatgcat gcatgcatgc atgcatgcat gcatgcatgc
//
`;

const PRESERVED_SOURCE_TYPE_GB = `LOCUS       SOURCE_TYPE             60 bp    DNA     linear   01-JAN-2025
DEFINITION  .
FEATURES             Location/Qualifiers
     misc_feature    1..30
                     /label="terminator (putative)"
                     /dnaforge_original_type="Rho-independ..."
ORIGIN
        1 atgcatgcat gcatgcatgc atgcatgcat gcatgcatgc atgcatgcat gcatgcatgc
//
`;

const COLORS = {
  CDS: '#3B82F6',
  gene: '#3B82F6',
  mRNA: '#0EA5E9',
  telomere: '#7C3AED',
  rep_origin: '#F97316',
  misc_feature: '#6B7280',
};

describe('GenBank parse — Benchling annotation-type resolver ', () => {
  const result = parseGenBankFull(BENCHLING_GB);
  const byLabel = (needle: string) => result.annotations.find((a) => a.name.includes(needle));

  it('recovers the real type from each Benchling misc_feature label', () => {
    expect(byLabel('PAU8 CDS')?.type).toBe('CDS');
    expect(byLabel('PAU8 gene')?.type).toBe('gene');
    expect(byLabel('PAU8 mRNA')?.type).toBe('mRNA');
    expect(byLabel('TEL01L')?.type).toBe('telomere');
    expect(byLabel('ARS102')?.type).toBe('rep_origin');
  });

  it('colors each recovered type distinctly (no longer one misc_feature gray)', () => {
    expect(byLabel('PAU8 CDS')?.color).toBe(COLORS.CDS);
    expect(byLabel('PAU8 mRNA')?.color).toBe(COLORS.mRNA);
    expect(byLabel('TEL01L')?.color).toBe(COLORS.telomere);
    expect(byLabel('ARS102')?.color).toBe(COLORS.rep_origin);
    const distinctColors = new Set(result.annotations.map((a) => a.color));
    expect(distinctColors.size).toBeGreaterThanOrEqual(4);
  });

  it('leaves a genuinely miscellaneous feature as misc_feature gray', () => {
    const misc = byLabel('uncharacterized region X');
    expect(misc?.type).toBe('misc_feature');
    expect(misc?.color).toBe(COLORS.misc_feature);
  });

  it('does NOT touch a RefSeq file that already carries real types', () => {
    const refseq = parseGenBankFull(REFSEQ_GB);
    const cds = refseq.annotations.find((a) => a.type === 'CDS');
    const trna = refseq.annotations.find((a) => a.type === 'tRNA');
    expect(cds, 'RefSeq CDS preserved').toBeDefined();
    expect(trna?.type).toBe('tRNA');
    expect(cds?.color).toBe(COLORS.CDS);
  });

  it('does not infer over an intentionally portable DNAForge source type', () => {
    const preserved = parseGenBankFull(PRESERVED_SOURCE_TYPE_GB);
    expect(preserved.annotations[0]).toMatchObject({
      type: 'misc_feature',
      qualifiers: { dnaforge_original_type: ['Rho-independ...'] },
    });
  });

  it('preserves every flattened feature in the real S288C Benchling export', () => {
    const fixture = readFileSync(
      new URL(
        '../../../../../test-fixtures/genomes/yeast-S288C/S288C_chromosome_I.gb',
        import.meta.url
      ),
      'utf8'
    );
    const chromosome = parseGenBankFull(fixture);

    expect(chromosome.annotations).toHaveLength(328);
    expect(chromosome.annotations.map((annotation) => annotation.type)).toEqual(
      expect.arrayContaining(['CDS', 'telomere', 'rep_origin'])
    );
    expect(
      chromosome.annotations.find((annotation) => annotation.name.startsWith('ARS102;'))
    ).toMatchObject({
      name: 'ARS102; Autonomously Replicating Sequence',
      qualifiers: { label: ['ARS102; Autonomously Replicating Sequence'] },
    });
  });
});
