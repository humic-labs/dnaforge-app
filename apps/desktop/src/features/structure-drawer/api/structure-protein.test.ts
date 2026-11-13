// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parseGenBankFull, type Annotation } from '@waypoint/sequence-utils';
import { deriveStructureProteinFromCds } from './structure-protein';

const TEST_FIXTURES_DIR = join(__dirname, '../../../../../../test-fixtures');
const CLEAN_REFERENCE = join(TEST_FIXTURES_DIR, 'genomes/ecoli-W3110/NC_007779.1.gb');

const RF2_LENGTH = 365;
const RF2_PREFIX = 'MFEINPVNNRIQDLTERSDVLRGYLDYDAKKERLEEVNAE';

const internalStops = (protein: string): number => (protein.match(/\*/g) ?? []).length;

function withoutQualifierTranslation(annotation: Annotation): Annotation {
  if (!annotation.qualifiers?.translation) return annotation;
  const qualifiers = { ...annotation.qualifiers };
  delete (qualifiers as Record<string, unknown>).translation;
  return { ...annotation, qualifiers };
}

function loadReference(): { annotations: Annotation[]; sequence: string } {
  expect(existsSync(CLEAN_REFERENCE), CLEAN_REFERENCE).toBe(true);
  const parsed = parseGenBankFull(readFileSync(CLEAN_REFERENCE, 'utf-8'));
  return { annotations: parsed.annotations, sequence: parsed.sequence };
}

const splicedCds = (annotations: Annotation[]): Annotation[] =>
  annotations.filter((a) => a.type === 'CDS' && (a.segments?.length ?? 0) > 1);

describe('deriveStructureProteinFromCds — segment-aware for a frameshifted CDS', () => {
  it('derives a stop-free RF2 for prfB', () => {
    const { annotations, sequence } = loadReference();
    const prfB = annotations.find(
      (a) => a.type === 'CDS' && /prfB/i.test(a.name ?? '') && (a.segments?.length ?? 0) > 1
    );
    expect(prfB, 'no multi-segment prfB CDS in the reference').toBeDefined();

    const derived = deriveStructureProteinFromCds(withoutQualifierTranslation(prfB!), sequence, {
      circular: true,
    });

    expect(derived).not.toBeNull();
    expect(derived!.source).toBe('derived_cds');
    expect(internalStops(derived!.rawProtein)).toBe(0);
    expect(derived!.rawProtein).toHaveLength(RF2_LENGTH);
    expect(derived!.rawProtein.startsWith(RF2_PREFIX)).toBe(true);
  });

  it('never derives an internal-stop protein for any native join in the reference', () => {
    const { annotations, sequence } = loadReference();
    const spliced = splicedCds(annotations);
    expect(spliced.length).toBeGreaterThan(0);

    const offenders = spliced
      .map((a) => ({
        name: a.name ?? '(unnamed)',
        derived: deriveStructureProteinFromCds(withoutQualifierTranslation(a), sequence, {
          circular: true,
        }),
      }))
      .filter(({ derived }) => derived === null || internalStops(derived.rawProtein) > 0)
      .map(({ name }) => name);

    expect(offenders).toEqual([]);
  });

  it('still prefers a stored /translation qualifier when the record has one', () => {
    const { annotations, sequence } = loadReference();
    const withTranslation = annotations.find(
      (a) => a.type === 'CDS' && (a.qualifiers?.translation?.[0]?.length ?? 0) > 0
    );
    if (!withTranslation) return;

    const derived = deriveStructureProteinFromCds(withTranslation, sequence, { circular: true });

    expect(derived).not.toBeNull();
    expect(derived!.source).toBe('qualifier_translation');
  });
});
