import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parseGenBankFull } from './parsers/genbank';
import { cdsToProtein, cdsToProteinSpliced } from './translation';
import type { Annotation } from './types';

const TEST_FIXTURES_DIR = join(__dirname, '../../../../test-fixtures');

const RF2_LENGTH = 365;
const RF2_PREFIX = 'MFEINPVNNRIQDLTERSDVLRGYLDYDAKKERLEEVNAE';

function internalStops(protein: string): number {
  return (protein.match(/\*/g) ?? []).length;
}

function findSplicedPrfB(gbPath: string): { annotation: Annotation; sequence: string } {
  const parsed = parseGenBankFull(readFileSync(gbPath, 'utf-8'));
  const annotation = parsed.annotations.find(
    (a) =>
      a.type === 'CDS' && /prfB/i.test(a.name) && a.segments !== undefined && a.segments.length > 1
  );
  if (!annotation) throw new Error(`No multi-segment prfB CDS found in ${gbPath}`);
  return { annotation, sequence: parsed.sequence };
}

const CLEAN_REFERENCE = join(TEST_FIXTURES_DIR, 'genomes/ecoli-W3110/NC_007779.1.gb');
const SHIPPED_DEFECTIVE = join(TEST_FIXTURES_DIR, 'sequences/circular/ecoli-mg1655-complete.gb');

describe('cdsToProteinSpliced — prfB on real genomes  acceptance)', () => {
  it('derives authentic RF2 from a CLEAN NCBI RefSeq record with a native join()', () => {
    const { annotation, sequence } = findSplicedPrfB(CLEAN_REFERENCE);

    const protein = cdsToProteinSpliced(annotation, sequence, {
      sequenceLength: sequence.length,
    });

    expect(protein).not.toBeNull();
    expect(internalStops(protein!)).toBe(0);
    expect(protein).toHaveLength(RF2_LENGTH);
    expect(protein!.startsWith(RF2_PREFIX)).toBe(true);
  });

  it('derives the SAME authentic RF2 from the defective genome we ship today', () => {
    expect(existsSync(SHIPPED_DEFECTIVE), SHIPPED_DEFECTIVE).toBe(true);
    const { annotation, sequence } = findSplicedPrfB(SHIPPED_DEFECTIVE);

    const protein = cdsToProteinSpliced(annotation, sequence, {
      sequenceLength: sequence.length,
    });

    expect(protein).not.toBeNull();
    expect(internalStops(protein!)).toBe(0);
    expect(protein).toHaveLength(RF2_LENGTH);
    expect(protein!.startsWith(RF2_PREFIX)).toBe(true);
  });

  it('pins the defect: the contiguous outer span yields 24 internal stops on BOTH files', () => {
    for (const gbPath of [CLEAN_REFERENCE, SHIPPED_DEFECTIVE]) {
      expect(existsSync(gbPath), gbPath).toBe(true);
      const { annotation, sequence } = findSplicedPrfB(gbPath);

      const spanProtein = cdsToProtein(
        annotation.start,
        annotation.end,
        annotation.direction as 1 | -1,
        sequence,
        sequence.length
      );

      expect(spanProtein).not.toBeNull();
      expect(internalStops(spanProtein!)).toBe(24);
    }
  });

  it('every native join() in the clean reference translates without internal stops', () => {
    const parsed = parseGenBankFull(readFileSync(CLEAN_REFERENCE, 'utf-8'));
    const spliced = parsed.annotations.filter(
      (a) => a.type === 'CDS' && a.segments !== undefined && a.segments.length > 1
    );

    expect(spliced.length).toBeGreaterThanOrEqual(23);

    const offenders: string[] = [];
    for (const annotation of spliced) {
      const protein = cdsToProteinSpliced(annotation, parsed.sequence, {
        sequenceLength: parsed.sequence.length,
      });
      if (protein === null || internalStops(protein) > 0) {
        offenders.push(`${annotation.name} (${internalStops(protein ?? '')} stops)`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
