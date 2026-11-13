import { describe, it, expect } from 'vitest';
import { inferFeatureTypeFromLabel } from './annotation-type-inference';

describe('inferFeatureTypeFromLabel (Benchling annotation-type resolver, ', () => {
  const cases: Array<[label: string, expected: string]> = [
    ['PAU8 CDS (seripauperin PAU8)', 'CDS'],
    ['YAL067W-A CDS (hypothetical protein)', 'CDS'],
    ['PAU8 gene', 'gene'],
    ['PAU8 mRNA (seripauperin PAU8)', 'mRNA'],
    ['SEO1 mRNA (putative permease SEO1)', 'mRNA'],
    ['TEL01L; Telomeric region on the left arm of Chromosome I', 'telomere'],
    ['ARS102; Autonomously Replicating Sequence', 'rep_origin'],
    ['ARS103', 'rep_origin'],
    ['CEN1; Centromere of Chromosome I', 'centromere'],
    ['SUF2 tRNA (tRNA-Gly)', 'tRNA'],
    ['RDN18-1 rRNA', 'rRNA'],
    ['snR30 snoRNA', 'snoRNA'],
    ['YARCTy1-1 LTR retrotransposon', 'LTR'],
    ['some long terminal repeat region', 'LTR'],
    ['GAL1 promoter', 'promoter'],
    ['ADH1 terminator', 'terminator'],
    ['X element combinatorial repeat', 'repeat_region'],
  ];

  it.each(cases)('resolves a misc_feature labeled %j to %s', (label, expected) => {
    expect(inferFeatureTypeFromLabel('misc_feature', label)).toBe(expected);
  });

  it('CDS is checked before gene so "<NAME> CDS" never resolves to gene', () => {
    expect(inferFeatureTypeFromLabel('misc_feature', 'PAU8 CDS (seripauperin)')).toBe('CDS');
    expect(inferFeatureTypeFromLabel('misc_feature', 'PAU8 gene')).toBe('gene');
  });

  it('leaves a genuinely miscellaneous feature as misc_feature', () => {
    expect(inferFeatureTypeFromLabel('misc_feature', 'some uncharacterized region')).toBe(
      'misc_feature'
    );
    expect(inferFeatureTypeFromLabel('misc_feature', undefined)).toBe('misc_feature');
  });

  it('NEVER overrides a file that already carries a real type (NCBI RefSeq)', () => {
    expect(inferFeatureTypeFromLabel('CDS', 'PAU8 gene')).toBe('CDS');
    expect(inferFeatureTypeFromLabel('gene', 'PAU8 mRNA')).toBe('gene');
    expect(inferFeatureTypeFromLabel('tRNA', 'anything')).toBe('tRNA');
    expect(inferFeatureTypeFromLabel('rep_origin', 'CDS-like text')).toBe('rep_origin');
  });
});
