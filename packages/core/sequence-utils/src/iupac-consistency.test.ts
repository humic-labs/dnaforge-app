import { describe, it, expect } from 'vitest';
import { reverseComplement as canonical } from './iupac';
import {
  reverseComplement as translationRc,
  complement as translationComplement,
} from './translation';

const ALPHABET = 'ACGTNRYSWKMBDHVacgtnryswkmbdhv';

const SATURATION_PRIMER = 'ATGGCTNNKGTTNNKCGTTAA';

describe('sequence-utils reverseComplement matches the canonical table', () => {
  it('agrees on every base in the accepted alphabet', () => {
    for (const base of ALPHABET) {
      expect(translationRc(base), `translation.ts disagrees on ${base}`).toBe(canonical(base));
    }
  });

  it('agrees on a saturation-library primer', () => {
    expect(translationRc(SATURATION_PRIMER)).toBe(canonical(SATURATION_PRIMER));
  });

  it('exposes a single-base complement that agrees with the table', () => {
    for (const base of ALPHABET) {
      expect(translationComplement(base), `complement() disagrees on ${base}`).toBe(
        canonical(base)
      );
    }
  });

  it('is an involution (the property that would have caught this)', () => {
    expect(translationRc(translationRc(ALPHABET))).toBe(ALPHABET);
  });
});
