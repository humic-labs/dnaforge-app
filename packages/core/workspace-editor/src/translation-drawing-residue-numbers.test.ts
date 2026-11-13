import { describe, expect, it } from 'vitest';
import {
  intronBoundaryResidueIndices,
  residueNumberStepForPixelsPerCodon,
} from './translation-drawing-residue-numbers';

describe('residueNumberStepForPixelsPerCodon', () => {
  it('widens the step as codon cells shrink', () => {
    expect(residueNumberStepForPixelsPerCodon(30)).toBe(1);
    expect(residueNumberStepForPixelsPerCodon(15)).toBe(2);
    expect(residueNumberStepForPixelsPerCodon(8)).toBe(5);
    expect(residueNumberStepForPixelsPerCodon(4)).toBe(10);
    expect(residueNumberStepForPixelsPerCodon(2)).toBe(20);
    expect(residueNumberStepForPixelsPerCodon(1)).toBe(50);
    expect(residueNumberStepForPixelsPerCodon(0.5)).toBe(100);
  });
});

describe('intronBoundaryResidueIndices', () => {
  it('marks both sides of a residue-index gap as intron boundaries', () => {
    expect(
      intronBoundaryResidueIndices([
        { residueIndex: 1, codonX: 0, visibleWidth: 10 },
        { residueIndex: 2, codonX: 10, visibleWidth: 10 },
        { residueIndex: 10, codonX: 20, visibleWidth: 10 },
      ])
    ).toEqual(new Set([2, 10]));
  });
});
