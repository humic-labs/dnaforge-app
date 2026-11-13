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

describe('planSplitCDSMerges — identity (locus_tag) is ground truth', () => {
  it('does NOT merge same-name CDS with DISTINCT locus_tags (the  case)', () => {
    const plans = planSplitCDSMerges([
      cds(500, 600, 'transposase', { identity: 'LT_1' }),
      cds(50000, 50100, 'transposase', { identity: 'LT_2' }),
      cds(90000, 90100, 'transposase', { identity: 'LT_3' }),
    ]);
    expect(plans).toHaveLength(0);
  });

  it('merges same-locus_tag exons EVEN with a feature annotated in the gap (fixes P2)', () => {
    const plans = planSplitCDSMerges([
      cds(100, 200, 'geneX', { identity: 'LT_9' }),
      gene(220, 260, 'intronAnno'),
      cds(300, 400, 'geneX', { identity: 'LT_9' }),
    ]);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toEqual([0, 2]);
  });

  it('merges same-locus_tag exons across a large intron (identity, not geometry)', () => {
    const plans = planSplitCDSMerges([
      cds(500, 600, 'geneY', { identity: 'LT_5' }),
      cds(50000, 50100, 'geneY', { identity: 'LT_5' }),
    ]);
    expect(plans).toHaveLength(1);
  });
});

describe('planSplitCDSMerges — no-identity exon-coverage fallback', () => {
  it('merges compact adjacent split-CDS exons (Benchling flatten)', () => {
    const plans = planSplitCDSMerges([
      cds(10, 50, 'insY'),
      cds(60, 100, 'insY'),
      cds(110, 150, 'insY'),
    ]);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toEqual([0, 1, 2]);
  });

  it('does NOT merge scattered same-name CDS with NOTHING between them (fixes P1 — sparse input)', () => {
    const plans = planSplitCDSMerges([
      cds(500, 600, 'hypothetical protein'),
      cds(50000, 50100, 'hypothetical protein'),
    ]);
    expect(plans).toHaveLength(0);
  });

  it('does NOT merge same-name CDS spread far apart (low exon coverage)', () => {
    const plans = planSplitCDSMerges([
      cds(10, 50, 'insX'),
      cds(200, 240, 'insX'),
      cds(400, 440, 'insX'),
    ]);
    expect(plans).toHaveLength(0);
  });

  it('does not merge when ranges overlap', () => {
    expect(planSplitCDSMerges([cds(10, 80, 'insZ'), cds(60, 120, 'insZ')])).toHaveLength(0);
  });

  it('does not merge singletons or different strands', () => {
    expect(planSplitCDSMerges([cds(10, 50, 'solo')])).toHaveLength(0);
    expect(
      planSplitCDSMerges([cds(10, 50, 'x', { dir: '1' }), cds(60, 100, 'x', { dir: '-1' })])
    ).toHaveLength(0);
  });

  it('skips CDS that already have segments, and non-CDS features', () => {
    const already: MergeCandidate = { ...cds(10, 50, 'insY'), hasSegments: true };
    expect(planSplitCDSMerges([already, cds(60, 100, 'insY')])).toHaveLength(0);
  });
});
