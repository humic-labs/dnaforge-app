import { describe, it, expect } from 'vitest';
import { planSplitCDSMerges, type MergeCandidate } from './split-cds-merge';

const cds = (
  start: number,
  end: number,
  name: string,
  opts: { dir?: string; identity?: string } = {}
): MergeCandidate => ({
  start,
  end,
  type: 'CDS',
  name,
  identity: opts.identity,
  directionKey: opts.dir ?? '1',
  hasSegments: false,
});

const gene = (start: number, end: number, name: string): MergeCandidate => ({
  start,
  end,
  type: 'gene',
  name,
  directionKey: '1',
  hasSegments: false,
});

describe('planSplitCDSMerges — -1 frameshift (1-base overlap) is mergeable', () => {
  it('merges the dnaX shape: segments sharing exactly one base', () => {
    expect(
      planSplitCDSMerges([
        cds(1208111, 1209394, 'dnaX CDS (DNA polymerase III subunit gamma)'),
        cds(1209394, 1209405, 'dnaX CDS (DNA polymerase III subunit gamma)'),
      ])
    ).toEqual([[0, 1]]);
  });

  it('merges the copA shape (also a -1 slip)', () => {
    expect(
      planSplitCDSMerges([
        cds(1227187, 1227195, 'copA CDS (soluble Cu(+) chaperone)'),
        cds(1227195, 1227398, 'copA CDS (soluble Cu(+) chaperone)'),
      ])
    ).toEqual([[0, 1]]);
  });

  it('merges a 1-base overlap on the reverse strand', () => {
    expect(
      planSplitCDSMerges([cds(100, 200, 'x', { dir: '-1' }), cds(200, 299, 'x', { dir: '-1' })])
    ).toEqual([[0, 1]]);
  });

  it('still merges a +1 skip and an adjacent pair (unchanged by this slice)', () => {
    expect(planSplitCDSMerges([cds(100, 200, 'p'), cds(202, 300, 'p')])).toEqual([[0, 1]]);
    expect(planSplitCDSMerges([cds(100, 200, 'a'), cds(201, 300, 'a')])).toEqual([[0, 1]]);
  });
});

describe('planSplitCDSMerges — the overlap veto still holds beyond one base', () => {
  it('does NOT merge a TWO-base overlap (the exact boundary)', () => {
    expect(planSplitCDSMerges([cds(100, 200, 'x'), cds(199, 300, 'x')])).toHaveLength(0);
  });

  it('does NOT merge a 21-base overlap (the original  case)', () => {
    expect(planSplitCDSMerges([cds(10, 80, 'insZ'), cds(60, 120, 'insZ')])).toHaveLength(0);
  });

  it('does NOT merge a fully-contained duplicate', () => {
    expect(planSplitCDSMerges([cds(100, 500, 'x'), cds(200, 300, 'x')])).toHaveLength(0);
  });
});

describe('planSplitCDSMerges —  guards survive the relaxation', () => {
  it('P1 — still refuses scattered same-name CDS with nothing between them (coverage)', () => {
    expect(
      planSplitCDSMerges([cds(1000, 1400, 'transposase'), cds(101000, 101400, 'transposase')])
    ).toHaveLength(0);
  });

  it('P2 — still refuses same-name CDS with a distinct feature inside the gap (clean-gap)', () => {
    expect(
      planSplitCDSMerges([
        cds(1000, 1400, 'hypothetical protein'),
        gene(1500, 1900, 'someOtherGene'),
        cds(2000, 2400, 'hypothetical protein'),
      ])
    ).toHaveLength(0);
  });

  it('still refuses same-name CDS carrying DISTINCT locus_tags', () => {
    expect(
      planSplitCDSMerges([
        cds(100, 200, 'transposase', { identity: 'b0001' }),
        cds(201, 300, 'transposase', { identity: 'b0002' }),
      ])
    ).toHaveLength(0);
  });

  it('still merges same-locus_tag exons across a large intron (identity wins)', () => {
    expect(
      planSplitCDSMerges([
        cds(1000, 1400, 'gene', { identity: 'b0001' }),
        cds(50000, 50400, 'gene', { identity: 'b0001' }),
      ])
    ).toEqual([[0, 1]]);
  });

  it('refuses a MIXED group whose tight junction is now tolerated (insO)', () => {
    expect(
      planSplitCDSMerges([
        cds(581564, 581818, 'insO CDS (IS911B regulator fragment)'),
        cds(583376, 583846, 'insO CDS (IS911B regulator fragment)'),
        cds(583846, 584160, 'insO CDS (IS911B regulator fragment)'),
      ])
    ).toHaveLength(0);
  });

  it('never emits a plan whose merged span dwarfs its exonic content', () => {
    const candidates = [
      cds(1000, 1400, 'far'),
      cds(90000, 90400, 'far'),
      cds(2000, 2100, 'near'),
      cds(2100, 2200, 'near'),
    ];
    for (const plan of planSplitCDSMerges(candidates)) {
      const members = plan.map((i) => candidates[i]);
      const span =
        Math.max(...members.map((m) => m.end)) - Math.min(...members.map((m) => m.start)) + 1;
      const exonic = members.reduce((sum, m) => sum + (m.end - m.start + 1), 0);
      expect(exonic / span).toBeGreaterThanOrEqual(0.5);
    }
  });
});
