import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GENETIC_CODES,
  STANDARD_GENETIC_CODE,
  STANDARD_GENETIC_CODE_ID,
  geneticCodeLabel,
  geneticCodesAssignIdenticalAminoAcids,
  getGeneticCode,
  isCodingFeature,
  isKnownGeneticCodeId,
  parseTranslTableQualifier,
  resolveAnnotationGeneticCode,
  resolveGeneticCode,
  resolveSequenceGeneticCode,
} from './genetic-codes';
import { RAW_GENETIC_CODE_TABLES } from './genetic-codes.generated';
import { buildCustomGeneticCode } from './custom-genetic-codes';
import type { Annotation } from './types';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDORED = path.resolve(HERE, '../vendor/ncbi-gc.prt');

function cds(overrides: Partial<Annotation> = {}): Annotation {
  return { name: 'f', type: 'CDS', start: 1, end: 9, direction: 1, ...overrides };
}

function source(qualifiers: Record<string, string[]>): Annotation {
  return { name: 'source', type: 'source', start: 1, end: 100, direction: 0, qualifiers };
}

describe('the vendored NCBI tables', () => {
  it('generates one entry per table in the source file', () => {
    const text = readFileSync(VENDORED, 'utf8');
    const ids = [...text.matchAll(/^\s*id\s+(\d+)\s*,\s*$/gm)].map((m) => Number(m[1]));
    expect(ids.length).toBeGreaterThan(20);
    expect(RAW_GENETIC_CODE_TABLES.map((t) => t.id)).toEqual(ids.sort((a, b) => a - b));
  });

  it('reproduces every amino-acid and start string byte-for-byte', () => {
    const text = readFileSync(VENDORED, 'utf8');
    for (const table of RAW_GENETIC_CODE_TABLES) {
      expect(text).toContain(`ncbieaa  "${table.aminoAcids}"`);
      expect(text).toContain(`sncbieaa "${table.starts}"`);
    }
  });

  it('assigns all 64 codons in every table, with at least one stop and one start', () => {
    for (const code of GENETIC_CODES) {
      expect(Object.keys(code.codonTable)).toHaveLength(64);
      expect(code.stopCodons.size).toBeGreaterThan(0);
      expect(code.startCodons.size).toBeGreaterThan(0);
      for (const stop of code.stopCodons) {
        const translatesToStop = code.codonTable[stop] === '*';
        expect(translatesToStop).toBe(!code.dualFunctionCodons.has(stop));
      }
    }
  });

  it('never treats a stop codon as an initiator', () => {
    expect([...STANDARD_GENETIC_CODE.startCodons].sort()).toEqual(['ATG', 'CTG', 'TTG']);
    expect([...getGeneticCode(2)!.startCodons].sort()).toEqual(['ATA', 'ATC', 'ATG', 'ATT', 'GTG']);
  });

  it('keeps the dual-function codons of the ciliate-adjacent nuclear codes', () => {
    for (const id of [27, 28, 31]) {
      const code = getGeneticCode(id)!;
      expect(code.dualFunctionCodons.size).toBeGreaterThan(0);
      expect(code.stopCodons.size).toBeGreaterThan(0);
      for (const codon of code.dualFunctionCodons) {
        expect(code.codonTable[codon]).not.toBe('*');
        expect(code.stopCodons.has(codon)).toBe(true);
      }
    }
    expect(STANDARD_GENETIC_CODE.dualFunctionCodons.size).toBe(0);
  });
});

describe('the standard code', () => {
  const KNOWN_STANDARD: Record<string, string> = {
    TTT: 'F',
    TTC: 'F',
    TTA: 'L',
    TTG: 'L',
    TCT: 'S',
    TCC: 'S',
    TCA: 'S',
    TCG: 'S',
    TAT: 'Y',
    TAC: 'Y',
    TAA: '*',
    TAG: '*',
    TGT: 'C',
    TGC: 'C',
    TGA: '*',
    TGG: 'W',
    CTT: 'L',
    CTC: 'L',
    CTA: 'L',
    CTG: 'L',
    CCT: 'P',
    CCC: 'P',
    CCA: 'P',
    CCG: 'P',
    CAT: 'H',
    CAC: 'H',
    CAA: 'Q',
    CAG: 'Q',
    CGT: 'R',
    CGC: 'R',
    CGA: 'R',
    CGG: 'R',
    ATT: 'I',
    ATC: 'I',
    ATA: 'I',
    ATG: 'M',
    ACT: 'T',
    ACC: 'T',
    ACA: 'T',
    ACG: 'T',
    AAT: 'N',
    AAC: 'N',
    AAA: 'K',
    AAG: 'K',
    AGT: 'S',
    AGC: 'S',
    AGA: 'R',
    AGG: 'R',
    GTT: 'V',
    GTC: 'V',
    GTA: 'V',
    GTG: 'V',
    GCT: 'A',
    GCC: 'A',
    GCA: 'A',
    GCG: 'A',
    GAT: 'D',
    GAC: 'D',
    GAA: 'E',
    GAG: 'E',
    GGT: 'G',
    GGC: 'G',
    GGA: 'G',
    GGG: 'G',
  };

  it('matches the table this repo already shipped', () => {
    expect(STANDARD_GENETIC_CODE.codonTable).toEqual(KNOWN_STANDARD);
  });

  it('stops at TAA, TAG and TGA', () => {
    expect([...STANDARD_GENETIC_CODE.stopCodons].sort()).toEqual(['TAA', 'TAG', 'TGA']);
  });
});

describe('the reassignments that make this ticket necessary', () => {
  it('reads TGA as tryptophan under the yeast, mold and invertebrate mitochondrial codes', () => {
    for (const id of [2, 3, 4, 5]) {
      expect(getGeneticCode(id)?.codonTable.TGA).toBe('W');
      expect(getGeneticCode(id)?.stopCodons.has('TGA')).toBe(false);
    }
    expect(STANDARD_GENETIC_CODE.codonTable.TGA).toBe('*');
  });

  it('reads AGA and AGG as stop under the vertebrate mitochondrial code', () => {
    const vertebrateMito = getGeneticCode(2);
    expect(vertebrateMito?.codonTable.AGA).toBe('*');
    expect(vertebrateMito?.codonTable.AGG).toBe('*');
    expect(STANDARD_GENETIC_CODE.codonTable.AGA).toBe('R');
  });

  it('reads the CTN family as threonine under the yeast mitochondrial code', () => {
    const yeastMito = getGeneticCode(3);
    for (const codon of ['CTT', 'CTC', 'CTA', 'CTG']) {
      expect(yeastMito?.codonTable[codon]).toBe('T');
      expect(STANDARD_GENETIC_CODE.codonTable[codon]).toBe('L');
    }
  });

  it('reads TAA and TAG as glutamine under the ciliate code', () => {
    const ciliate = getGeneticCode(6);
    expect(ciliate?.codonTable.TAA).toBe('Q');
    expect(ciliate?.codonTable.TAG).toBe('Q');
    expect([...(ciliate?.stopCodons ?? [])]).toEqual(['TGA']);
  });
});

describe('geneticCodesAssignIdenticalAminoAcids', () => {
  it('treats the bacterial code as identical to the standard one', () => {
    expect(geneticCodesAssignIdenticalAminoAcids(1, 11)).toBe(true);
    expect(getGeneticCode(11)?.startCodons).not.toEqual(STANDARD_GENETIC_CODE.startCodons);
  });

  it('separates codes that actually reassign a codon', () => {
    expect(geneticCodesAssignIdenticalAminoAcids(1, 3)).toBe(false);
    expect(geneticCodesAssignIdenticalAminoAcids(2, 3)).toBe(false);
  });

  it('treats undefined as the standard code', () => {
    expect(geneticCodesAssignIdenticalAminoAcids(undefined, 1)).toBe(true);
    expect(geneticCodesAssignIdenticalAminoAcids(undefined, 4)).toBe(false);
  });
});

describe('resolveGeneticCode', () => {
  it('falls back to the standard code for an unpublished id', () => {
    expect(resolveGeneticCode(999).id).toBe(STANDARD_GENETIC_CODE_ID);
    expect(resolveGeneticCode(undefined).id).toBe(STANDARD_GENETIC_CODE_ID);
  });

  it('passes an already-resolved code straight through', () => {
    const yeastMito = getGeneticCode(3)!;
    expect(resolveGeneticCode(yeastMito)).toBe(yeastMito);
  });

  it('reports which ids are published', () => {
    expect(isKnownGeneticCodeId(3)).toBe(true);
    expect(isKnownGeneticCodeId(7)).toBe(false);
    expect(isKnownGeneticCodeId(8)).toBe(false);
    expect(isKnownGeneticCodeId('3')).toBe(false);
  });

  it('labels a code for display', () => {
    expect(geneticCodeLabel(3)).toBe('3 — Yeast Mitochondrial');
    expect(geneticCodeLabel(undefined)).toBe('1 — Standard');
  });
});

describe('parseTranslTableQualifier', () => {
  it('reads a declared table', () => {
    expect(parseTranslTableQualifier(cds({ qualifiers: { transl_table: ['3'] } }))).toBe(3);
  });

  it('returns null for absent, empty or non-numeric values', () => {
    expect(parseTranslTableQualifier(cds())).toBeNull();
    expect(parseTranslTableQualifier(cds({ qualifiers: { transl_table: ['abc'] } }))).toBeNull();
    expect(parseTranslTableQualifier(cds({ qualifiers: { transl_table: ['0'] } }))).toBeNull();
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseTranslTableQualifier(cds({ qualifiers: { transl_table: [' 11 '] } }))).toBe(11);
  });
});

describe('resolveSequenceGeneticCode', () => {
  it('defaults to the standard code for a record with nothing to go on', () => {
    const resolution = resolveSequenceGeneticCode({ annotations: [] });
    expect(resolution).toMatchObject({
      code: 1,
      basis: 'default',
      mixed: false,
      needsUserChoice: false,
    });
    expect(resolution.declaredCodes).toEqual([]);
  });

  it('adopts a code every coding feature agrees on', () => {
    const annotations = [
      cds({ qualifiers: { transl_table: ['3'] } }),
      cds({ qualifiers: { transl_table: ['3'] } }),
    ];
    expect(resolveSequenceGeneticCode({ annotations })).toMatchObject({
      code: 3,
      basis: 'declared',
      declaredCodes: [3],
      mixed: false,
    });
  });

  it('reports a record whose features disagree as mixed, taking the most common', () => {
    const annotations = [
      cds({ qualifiers: { transl_table: ['3'] } }),
      cds({ qualifiers: { transl_table: ['3'] } }),
      cds({ qualifiers: { transl_table: ['1'] } }),
    ];
    expect(resolveSequenceGeneticCode({ annotations })).toMatchObject({
      code: 3,
      basis: 'declared-mixed',
      declaredCodes: [1, 3],
      mixed: true,
    });
  });

  it('breaks a tie toward the lower id so the answer does not depend on order', () => {
    const forward = [
      cds({ qualifiers: { transl_table: ['4'] } }),
      cds({ qualifiers: { transl_table: ['1'] } }),
    ];
    expect(resolveSequenceGeneticCode({ annotations: forward }).code).toBe(1);
    expect(resolveSequenceGeneticCode({ annotations: [...forward].reverse() }).code).toBe(1);
  });

  it('ignores a transl_table on a non-coding feature', () => {
    const annotations = [{ ...cds({ qualifiers: { transl_table: ['3'] } }), type: 'misc_feature' }];
    expect(resolveSequenceGeneticCode({ annotations })).toMatchObject({
      code: 1,
      basis: 'default',
      declaredCodes: [],
    });
  });

  it('counts mat_peptide and sig_peptide as coding', () => {
    expect(isCodingFeature({ ...cds(), type: 'mat_peptide' })).toBe(true);
    expect(isCodingFeature({ ...cds(), type: 'sig_peptide' })).toBe(true);
    expect(isCodingFeature({ ...cds(), type: 'promoter' })).toBe(false);
  });

  it('asks rather than guessing for a mitochondrial record that declares nothing', () => {
    const annotations = [source({ organelle: ['mitochondrion'] }), cds()];
    expect(resolveSequenceGeneticCode({ annotations })).toMatchObject({
      code: 1,
      basis: 'default',
      needsUserChoice: true,
      organelle: 'mitochondrion',
    });
  });

  it('does not ask when the mitochondrial record already declares a code', () => {
    const annotations = [
      source({ organelle: ['mitochondrion'] }),
      cds({ qualifiers: { transl_table: ['3'] } }),
    ];
    expect(resolveSequenceGeneticCode({ annotations })).toMatchObject({
      code: 3,
      basis: 'declared',
      needsUserChoice: false,
    });
  });

  it('does not ask about a plastid, whose code is not in genuine doubt', () => {
    const annotations = [source({ organelle: ['plastid:chloroplast'] })];
    expect(resolveSequenceGeneticCode({ annotations }).needsUserChoice).toBe(false);
  });

  it('lets a user choice override what the features declare', () => {
    const annotations = [cds({ qualifiers: { transl_table: ['1'] } })];
    expect(resolveSequenceGeneticCode({ annotations, chosenGeneticCode: 3 })).toMatchObject({
      code: 3,
      basis: 'chosen',
      declaredCodes: [1],
    });
  });

  it('ignores an unpublished chosen code rather than translating on nothing', () => {
    const annotations = [cds({ qualifiers: { transl_table: ['3'] } })];
    expect(resolveSequenceGeneticCode({ annotations, chosenGeneticCode: 999 })).toMatchObject({
      code: 3,
      basis: 'declared',
    });
  });
});

describe('resolveAnnotationGeneticCode', () => {
  it('prefers the feature declaration over the record code', () => {
    expect(resolveAnnotationGeneticCode(cds({ qualifiers: { transl_table: ['1'] } }), 3)).toBe(1);
  });

  it('inherits the record code when the feature declares nothing', () => {
    expect(resolveAnnotationGeneticCode(cds(), 3)).toBe(3);
  });

  it('falls back to the record code for an unpublished declaration', () => {
    expect(resolveAnnotationGeneticCode(cds({ qualifiers: { transl_table: ['7'] } }), 4)).toBe(4);
  });

  it('defaults to the standard code with nothing to go on', () => {
    expect(resolveAnnotationGeneticCode(cds())).toBe(1);
  });
});

describe('a record reading a custom code', () => {
  const built = buildCustomGeneticCode({
    id: 'gc-3f2a9c1e',
    revision: 1,
    name: 'Amber suppression (pAzF at TAG)',
    base: 11,
    changes: { TAG: { kind: 'residue', residue: 'pAzF' } },
    residues: [{ abbreviation: 'pAzF', name: 'p-azido-L-phenylalanine', ccd: 'AZF' }],
  });
  if (!built.ok) throw new Error('fixture must build');
  const amber = built.definition;

  it('resolves to the custom definition, as a user choice', () => {
    const resolution = resolveSequenceGeneticCode({
      annotations: [cds()],
      chosenGeneticCode: amber,
    });
    expect(resolution.basis).toBe('chosen');
    expect(resolution.code).toBe(amber);
  });

  it('still lets a feature that declares a published table keep it', () => {
    const declaring = cds({ qualifiers: { transl_table: ['3'] } });
    expect(resolveAnnotationGeneticCode(declaring, amber)).toBe(3);
  });

  it('gives an undeclared feature the custom code', () => {
    expect(resolveAnnotationGeneticCode(cds(), amber)).toBe(amber);
  });
});

describe('what wins when a record and a gene disagree ', () => {
  const cds: Annotation = {
    name: 'gene',
    type: 'CDS',
    start: 1,
    end: 30,
    direction: 1,
    qualifiers: { transl_table: ['11'] },
  };

  it("lets a user's explicit choice beat the table the gene declares", () => {
    expect(resolveAnnotationGeneticCode(cds, 3, 'chosen')).toBe(3);
  });

  it('still lets a gene declare its own table when nothing was chosen', () => {
    expect(resolveAnnotationGeneticCode(cds, 3, 'declared')).toBe(11);
    expect(resolveAnnotationGeneticCode(cds, 3, 'default')).toBe(11);
  });

  it('gives an undeclared gene the record code however the record got it', () => {
    const undeclared: Annotation = { ...cds, qualifiers: {} };
    expect(resolveAnnotationGeneticCode(undeclared, 3, 'chosen')).toBe(3);
    expect(resolveAnnotationGeneticCode(undeclared, 3, 'declared')).toBe(3);
  });

  it('keeps the old behaviour when no basis is given, so existing callers are unchanged', () => {
    expect(resolveAnnotationGeneticCode(cds, 3)).toBe(11);
  });
});
