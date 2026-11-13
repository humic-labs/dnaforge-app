import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parseGenBankFull } from './genbank';
import { cdsToProteinSpliced } from '../translation';

const MG1655 = join(
  __dirname,
  '../../../../../test-fixtures/sequences/circular/ecoli-mg1655-flattened-ape-export.gb'
);

function mergedAnnotations() {
  const parsed = parseGenBankFull(readFileSync(MG1655, 'utf-8'));
  return {
    merged: parsed.annotations.filter((a) => a.segments && a.segments.length > 1),
    sequence: parsed.sequence,
  };
}

describe.skipIf(!existsSync(MG1655))(
  'planSplitCDSMerges — real flattened MG1655  Slice 5)',
  () => {
    it('reconstructs exactly the three Class A recoded genes', () => {
      const { merged } = mergedAnnotations();

      const names = merged.map((a) => a.name.split(' ')[0]).sort();
      expect(names).toEqual(['copA', 'dnaX', 'prfB']);
    });

    it('translates every reconstructed gene stop-free, at its known length', () => {
      const { merged, sequence } = mergedAnnotations();

      const byGene = Object.fromEntries(
        merged.map((a) => {
          const protein = cdsToProteinSpliced(a, sequence, { sequenceLength: sequence.length });
          return [
            a.name.split(' ')[0],
            { length: protein?.length ?? null, stops: (protein?.match(/\*/g) ?? []).length },
          ];
        })
      );

      expect(byGene).toEqual({
        prfB: { length: 365, stops: 0 },
        dnaX: { length: 431, stops: 0 },
        copA: { length: 70, stops: 0 },
      });
    });

    it('🟥 produces NO genome-spanning arc (the  catastrophe)', () => {
      const { merged, sequence } = mergedAnnotations();

      for (const annotation of merged) {
        const span = annotation.end - annotation.start + 1;
        expect(span).toBeLessThan(10_000);
        expect(span).toBeLessThan(sequence.length * 0.001);
      }
    });

    it('keeps every merged gene majority-exon', () => {
      const { merged } = mergedAnnotations();

      for (const annotation of merged) {
        const span = annotation.end - annotation.start + 1;
        const exonic = annotation.segments!.reduce((sum, s) => sum + (s.end - s.start + 1), 0);
        expect(exonic / span).toBeGreaterThanOrEqual(0.5);
      }
    });

    it('leaves the IS-interrupted pseudogene fragments split', () => {
      const { merged } = mergedAnnotations();
      expect(merged.some((a) => /yhiS/i.test(a.name))).toBe(false);
    });

    it('leaves the mixed insO group split despite its tolerable junction', () => {
      const { merged } = mergedAnnotations();
      expect(merged.some((a) => /insO/i.test(a.name))).toBe(false);
    });
  }
);
