import { describe, it, expect } from 'vitest';
import { parseGenBank } from './genbank';
import { parseGenBankFull } from '@waypoint/sequence-utils';

const BENCHLING_FLATTENED = [
  'LOCUS       t                        200 bp    DNA     circular UNA 01-JAN-2020',
  'FEATURES             Location/Qualifiers',
  '     misc_feature    1..60',
  '                     /label="prfB CDS (peptide chain release factor RF2)"',
  '     misc_feature    62..120',
  '                     /label="prfB CDS (peptide chain release factor RF2)"',
  'ORIGIN',
  `        1 ${'acgt'.repeat(50)}`,
  '//',
  '',
].join('\n');

describe('parser parity — Benchling misc_feature labelled "<gene> CDS"', () => {
  it.each(['misc_feature', 'CDS'])(
    'preserves separate native source-marked %s features',
    (type) => {
      const native = BENCHLING_FLATTENED.replaceAll('misc_feature', type).replaceAll(
        '/label=',
        `/dnaforge_original_type="${type}"\n                     /label=`
      );
      for (const features of [
        parseGenBankFull(native).annotations,
        parseGenBank(native).features,
      ]) {
        expect(features).toHaveLength(2);
        expect(features.map(({ type, start, end }) => ({ type, start, end }))).toEqual([
          { type, start: 1, end: 60 },
          { type, start: 62, end: 120 },
        ]);
        expect(features.every((feature) => feature.segments === undefined)).toBe(true);
      }
    }
  );

  it('sequence-utils recovers the CDS type and merges the flattened pieces', () => {
    const parsed = parseGenBankFull(BENCHLING_FLATTENED);
    const spliced = parsed.annotations.filter((a) => a.segments && a.segments.length > 1);

    expect(spliced).toHaveLength(1);
    expect(spliced[0].type).toBe('CDS');
    expect(spliced[0].segments).toEqual([
      { start: 1, end: 60 },
      { start: 62, end: 120 },
    ]);
  });

  it('plasmid-viewer recovers the SAME type and the SAME segments', () => {
    const parsed = parseGenBank(BENCHLING_FLATTENED);
    const spliced = parsed.features.filter((f) => f.segments && f.segments.length > 1);

    expect(spliced).toHaveLength(1);
    expect(spliced[0].type).toBe('CDS');
    expect(spliced[0].segments).toEqual([
      { start: 1, end: 60 },
      { start: 62, end: 120 },
    ]);
  });

  it('both parsers agree on the merged segment list', () => {
    const fromCore = parseGenBankFull(BENCHLING_FLATTENED).annotations.find(
      (a) => a.segments && a.segments.length > 1
    );
    const fromViewer = parseGenBank(BENCHLING_FLATTENED).features.find(
      (f) => f.segments && f.segments.length > 1
    );

    expect(fromViewer?.segments).toEqual(fromCore?.segments);
    expect(fromViewer?.type).toEqual(fromCore?.type);
  });

  it('neither parser invents a type for a genuinely generic misc_feature', () => {
    const generic = BENCHLING_FLATTENED.replace(
      /prfB CDS \(peptide chain release factor RF2\)/g,
      'random region'
    );

    expect(parseGenBankFull(generic).annotations.every((a) => a.type !== 'CDS')).toBe(true);
    expect(parseGenBank(generic).features.every((f) => f.type !== 'CDS')).toBe(true);
  });
});
