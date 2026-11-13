import { describe, it, expect } from 'vitest';
import { isInAlignmentMode } from '../coordinate-space-utils';

describe('isInAlignmentMode', () => {
  it('returns false when coordinateSpace is undefined or null', () => {
    expect(isInAlignmentMode(undefined)).toBe(false);
    expect(isInAlignmentMode(null)).toBe(false);
  });

  it('returns false in normal mode', () => {
    expect(isInAlignmentMode({ mode: 'biological' })).toBe(false);
  });

  it('returns true when mode is gapped (no aligned query)', () => {
    expect(isInAlignmentMode({ mode: 'gapped', gappedSequence: 'ATG-CC' })).toBe(true);
  });

  it('returns true when alignedQuery is set (even with mode=normal — defensive)', () => {
    expect(isInAlignmentMode({ mode: 'biological', alignedQuery: 'ATGCCG' })).toBe(true);
  });

  it('returns true when both signals fire', () => {
    expect(
      isInAlignmentMode({ mode: 'gapped', gappedSequence: 'ATG-CC', alignedQuery: 'ATGCCC' })
    ).toBe(true);
  });
});
