import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parseGenBankFull } from './genbank';
import { resolveFeaturesByName } from '../feature-aliases';
import type { Annotation } from '../types';

const FIXTURES = join(__dirname, '../../../../../test-fixtures/sequences/circular');
const CANONICAL = join(FIXTURES, 'ecoli-mg1655-complete.gb');
const FLATTENED = join(FIXTURES, 'ecoli-mg1655-flattened-ape-export.gb');

const GENES = [
  { query: 'ffs', type: 'ncRNA', length: 114 },
  { query: 'chiX', type: 'ncRNA', length: 84 },
  { query: 'ffh', type: 'CDS', length: 1362 },
  { query: 'rrlC', type: 'rRNA', length: 2904 },
  { query: 'rrsC', type: 'rRNA', length: 1542 },
  { query: 'thrA', type: 'CDS', length: 2463 },
] as const;

const isStructureTarget = (a: Annotation) => a.type.toLowerCase() !== 'gene';

function parse(path: string): Annotation[] {
  return parseGenBankFull(readFileSync(path, 'utf-8')).annotations;
}

const bothPresent = existsSync(CANONICAL) && existsSync(FLATTENED);

describe.skipIf(!bothPresent)('🟥 MG1655 identity resolves the same in both export shapes', () => {
  const canonical = parse(CANONICAL);
  const flattened = parse(FLATTENED);

  it.each(GENES)('resolves $query in both files, to the same feature', (gene) => {
    const fromCanonical = resolveFeaturesByName(canonical, gene.query, {
      filter: isStructureTarget,
    });
    const fromFlattened = resolveFeaturesByName(flattened, gene.query, {
      filter: isStructureTarget,
    });

    expect(fromCanonical.length).toBeGreaterThan(0);
    expect(fromFlattened.length).toBeGreaterThan(0);

    const a = fromCanonical[0].feature;
    const b = fromFlattened[0].feature;

    expect(a.type).toBe(gene.type);
    expect(b.type).toBe(gene.type);
    expect(a.end - a.start + 1).toBe(gene.length);
    expect(b.end - b.start + 1).toBe(gene.length);
  });

  it('confirms the two files really are rotated relative to each other', () => {
    const a = resolveFeaturesByName(canonical, 'ffs', { filter: isStructureTarget })[0].feature;
    const b = resolveFeaturesByName(flattened, 'ffs', { filter: isStructureTarget })[0].feature;

    expect(b.start - a.start).toBe(716_019);
  });

  it('finds systematic identifiers the canonical record carries', () => {
    for (const query of ['b0455', 'ECK0449', 'GeneID:944909']) {
      const matches = resolveFeaturesByName(canonical, query, { filter: isStructureTarget });
      expect(matches.length, `${query} should resolve`).toBeGreaterThan(0);
      expect(matches[0].feature.type).toBe('ncRNA');
    }
  });

  it('still finds features by classification qualifier, not just by name', () => {
    expect(resolveFeaturesByName(canonical, 'insertion sequence').length).toBeGreaterThan(0);
    expect(resolveFeaturesByName(canonical, 'IS150').length).toBeGreaterThan(0);
  });

  it('never matches a feature by its protein sequence', () => {
    const proteinish = resolveFeaturesByName(canonical, 'MKRISTTITTTITITTGNGAG');
    expect(proteinish).toHaveLength(0);
  });

  it('resolves a gene symbol to exactly ONE structure target', () => {
    for (const gene of GENES) {
      const matches = resolveFeaturesByName(canonical, gene.query, {
        filter: isStructureTarget,
      }).filter((m) => m.exact);
      expect(matches.length, `${gene.query} should be unambiguous`).toBe(1);
    }
  });
});
