// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseGenBankFull } from '@waypoint/sequence-utils';
import {
  applyLimsGenotypeEdits,
  findAnnotationForGenotypeTarget,
  parseLimsGenotype,
} from './genotype-reconstruction';

const REPO_ROOT = join(__dirname, '../../../../..');
const ECOLI_REGION = join(REPO_ROOT, 'test-fixtures/sequences/linear/ecoli-mg1655-region.gb');
const SFGFP_CDS = join(REPO_ROOT, 'test-fixtures/sequences/linear/sfgfp-cds.gb');

function loadGenBank(path: string) {
  return parseGenBankFull(readFileSync(path, 'utf8'));
}

describe('LIMS genotype edit projection', () => {
  it('resolves real MG1655 feature names from GenBank annotations', () => {
    const parent = loadGenBank(ECOLI_REGION);

    const argF = findAnnotationForGenotypeTarget(parent, 'argF');

    expect(argF).toMatchObject({
      type: 'gene',
      start: 5320,
      end: 6324,
    });
  });

  it('parses lab genotype notation and projects edits onto a real parent sequence', () => {
    const parent = loadGenBank(ECOLI_REGION);
    const marker = loadGenBank(SFGFP_CDS);
    const parsed = parseLimsGenotype('argFΔ::sfGFP; ins@6528:GGATCC; g.1414A>T');

    expect(parsed.errors).toEqual([]);
    expect(parsed.edits.map((edit) => edit.kind)).toEqual([
      'marker_replacement',
      'insertion',
      'substitution',
    ]);

    const projected = applyLimsGenotypeEdits(parent, parsed.edits, {
      sfGFP: marker.sequence,
    });

    let expected = parent.sequence.toUpperCase();
    expected = expected.slice(0, 6528) + 'GGATCC' + expected.slice(6528);
    expected = expected.slice(0, 5319) + marker.sequence.toUpperCase() + expected.slice(6324);
    expected = expected.slice(0, 1413) + 'T' + expected.slice(1414);

    expect(projected.sequence).toBe(expected);
    expect(projected.sequence.length).toBe(parent.length - 1005 + marker.length + 6);
    expect(projected.applied.map((edit) => edit.label)).toEqual([
      'g.1414A>T',
      'argFΔ::sfGFP',
      'ins@6528:GGATCC',
    ]);
  });

  it('rejects unsupported genotype tokens instead of silently inventing edits', () => {
    const parsed = parseLimsGenotype('argFΔ; unexplained phenotype');

    expect(parsed.edits).toHaveLength(1);
    expect(parsed.errors).toEqual(['Unsupported genotype token: unexplained phenotype']);
  });
});
