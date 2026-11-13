import { describe, it, expect } from 'vitest';
import { planSplitCDSMerges, type MergeCandidate } from './split-cds-merge';

const cds = (start: number, end: number, name: string): MergeCandidate => ({
  start,
  end,
  type: 'CDS',
  name,
  directionKey: '1',
  hasSegments: false,
});

describe('planSplitCDSMerges — exon coverage is a union, never a double count', () => {
  it('merges a contiguous 1-base-overlap pair (the real frameshift shape)', () => {
    const plans = planSplitCDSMerges([cds(100, 200, 'prfB'), cds(200, 299, 'prfB')]);
    expect(plans).toEqual([[0, 1]]);
  });

  it('refuses two same-named neighbours whose merged length cannot code a protein', () => {
    const plans = planSplitCDSMerges([
      cds(100, 200, 'hypothetical protein'),
      cds(200, 300, 'hypothetical protein'),
    ]);
    expect(plans).toEqual([]);
  });

  it('rejects a SPARSE 1-base-overlap group whose union does not fill the span', () => {
    const plans = planSplitCDSMerges([
      cds(100, 200, 'hypothetical protein'),
      cds(200, 300, 'hypothetical protein'),
      cds(9000, 9100, 'hypothetical protein'),
    ]);
    expect(plans).toEqual([]);
  });

  it('still merges a plain adjacent (non-overlapping) exon pair', () => {
    const plans = planSplitCDSMerges([cds(100, 200, 'geneA'), cds(201, 300, 'geneA')]);
    expect(plans).toEqual([[0, 1]]);
  });
});
