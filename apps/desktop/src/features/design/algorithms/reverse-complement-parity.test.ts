// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { reverseComplement as canonical } from '@waypoint/sequence-utils';
import { reverseComplement as designPath } from './utils';
import { reverseComplement as draftAssemblyPath } from './draft-assembly';

const ALPHABET = 'ACGTNRYSWKMBDHVacgtnryswkmbdhv';

const SATURATION_PRIMER = 'ATGGCTNNKGTTNNKCGTTAA';

const SEQUENCES = [
  ALPHABET,
  SATURATION_PRIMER,
  'ATGCGATCGATCGATCGATC',
  'atgcgatcgatcgatcgatc',
  'AcGtRyKmBvDh',
  'ATGC-ATGC',
  '',
];

describe('design-path reverseComplement is the canonical one ', () => {
  it.each(SEQUENCES)('agrees with sequence-utils on %j', (sequence) => {
    expect(designPath(sequence)).toBe(canonical(sequence));
  });

  it('agrees base-for-base across the whole accepted alphabet', () => {
    for (const base of ALPHABET) {
      expect(designPath(base), `design path disagrees on ${base}`).toBe(canonical(base));
    }
  });

  it('is exported unchanged through the draft-assembly barrel', () => {
    expect(draftAssemblyPath(SATURATION_PRIMER)).toBe(canonical(SATURATION_PRIMER));
  });

  it('does NOT leave degenerate bases unchanged (the original defect)', () => {
    expect(designPath('R')).toBe('Y');
    expect(designPath('NNK')).toBe('MNN');
    expect(designPath('R')).not.toBe('R');
  });

  it('is an involution over the accepted alphabet', () => {
    expect(designPath(designPath(ALPHABET))).toBe(ALPHABET);
  });
});
