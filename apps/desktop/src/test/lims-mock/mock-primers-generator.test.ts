// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { reverseComplement } from '@waypoint/sequence-utils';
import {
  primerTm,
  gcPercent,
  revComp,
  parseGenes,
  extractGenBankOrigin,
  FORBIDDEN_GENE_TOKENS,
} from '../../../scripts/generate-mock-primer-dataset.mjs';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const PUC19 = path.join(REPO_ROOT, 'test-fixtures/sequences/circular/pUC19.gb');
const CHR_IV = path.join(REPO_ROOT, 'test-fixtures/genomes/yeast-chrIV/chrIV.gbff');
const S288C_I = path.join(REPO_ROOT, 'test-fixtures/genomes/yeast-S288C/S288C_chromosome_I.gb');
const HERO_MANIFEST = path.join(REPO_ROOT, 'test-fixtures/lims-mock/mock-demo-hero-manifest.json');

function genbankSequence(file: string): string {
  return readFileSync(file, 'utf8')
    .split(/^ORIGIN/m)[1]
    .replace(/[^acgtACGT]/g, '')
    .toUpperCase();
}

const TARGET_SEQUENCES: Record<string, () => string> = {
  puc19: () => genbankSequence(PUC19),
  'yeast-chrIV': () => genbankSequence(CHR_IV),
};

describe('primer designer — pure transforms', () => {
  it('revComp matches the shared sequence-utils reverseComplement', () => {
    const s = 'ATGCATTACGGGCCAATTCAG';
    expect(revComp(s)).toBe(reverseComplement(s));
  });

  it('primerTm rises with GC content and length', () => {
    expect(primerTm('GCGCGCGCGCGCGCGCGCGC')).toBeGreaterThan(primerTm('ATATATATATATATATATAT'));
    expect(primerTm('GCATGCATGCATGCATGCATGC')).toBeGreaterThan(primerTm('GCATGCATGCAT'));
  });

  it('gcPercent computes the GC fraction', () => {
    expect(gcPercent('GGCC')).toBe(100);
    expect(gcPercent('ATAT')).toBe(0);
    expect(gcPercent('ATGC')).toBe(50);
  });

  it('parseGenes recovers named single-span genes from a Benchling export', () => {
    const genes = parseGenes(readFileSync(S288C_I, 'utf8'), 5000);
    expect(genes.length).toBeGreaterThan(50);
    const names = new Set(genes.map((g) => g.gene));
    expect(names.has('SEO1')).toBe(true);
    expect(names.has('PAU8')).toBe(true);
    for (const g of genes) {
      expect(g.end).toBeGreaterThan(g.start);
      expect([1, -1]).toContain(g.strand);
    }
  });

  it('parseGenes skips every forbidden (old-lab target) gene token', () => {
    const genes = parseGenes(readFileSync(S288C_I, 'utf8'), 5000);
    for (const g of genes) {
      const upper = g.gene.toUpperCase();
      for (const token of FORBIDDEN_GENE_TOKENS) {
        expect(upper.includes(token), `${g.gene} contains forbidden ${token}`).toBe(false);
      }
    }
  });

  it('extractGenBankOrigin returns the clean ACGT sequence', () => {
    const seq = extractGenBankOrigin(readFileSync(PUC19, 'utf8'));
    expect(seq.length).toBeGreaterThan(2000);
    expect(/^[ACGT]+$/.test(seq)).toBe(true);
  });
});

describe('LIMS demo primer fixtures — hero/manifest agreement', () => {
  const manifest = JSON.parse(readFileSync(HERO_MANIFEST, 'utf8')) as {
    _provenance: { rowCount: number; generator: string; note: string };
    heroes: Array<{ name: string; sequence: string; target: string; expectedOrientation: string }>;
  };

  it('carries public-provenance metadata so the fixture is traceable', () => {
    expect(manifest._provenance.generator).toContain('generate-mock-primer-dataset');
    expect(manifest._provenance.note.toLowerCase()).toContain('public');
  });

  it('covers both a plasmid and a chromosome target', () => {
    const targets = new Set(manifest.heroes.map((h) => h.target));
    expect(targets.has('puc19'), 'a hero must target pUC19').toBe(true);
    expect(targets.has('yeast-chrIV'), 'a hero must target the yeast chromosome').toBe(true);
  });

  it('every hero oligo genuinely binds its declared target at its declared orientation', () => {
    expect(manifest.heroes.length).toBeGreaterThanOrEqual(2);
    for (const hero of manifest.heroes) {
      const loadSeq = TARGET_SEQUENCES[hero.target];
      expect(loadSeq, `hero ${hero.name} has unknown target "${hero.target}"`).toBeTruthy();
      const seq = loadSeq();
      const fwdHit = seq.includes(hero.sequence);
      const revHit = seq.includes(reverseComplement(hero.sequence));
      if (hero.expectedOrientation === 'forward') {
        expect(fwdHit, `${hero.name} should bind ${hero.target} forward strand`).toBe(true);
      } else {
        expect(revHit, `${hero.name} should bind ${hero.target} reverse strand`).toBe(true);
      }
    }
  });
});
