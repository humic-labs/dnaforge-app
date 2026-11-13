import { describe, expect, it } from 'vitest';
import { codonNameLine, featureSummaryLine, cdsRegionHoverLine } from './codon-hover-tooltip-lines';

describe('the exon/intron hover line', () => {
  const feature = {
    type: 'CDS',
    start: 1,
    end: 120,
    direction: 1,
    segments: [
      { start: 1, end: 30 },
      { start: 61, end: 90 },
      { start: 91, end: 120 },
    ],
  };
  it('follows biological boundaries and omits lengths', () => {
    for (const [position, expected] of [
      [0, 'Exon 1'],
      [29, 'Exon 1'],
      [30, 'Intron 1'],
      [59, 'Intron 1'],
      [60, 'Exon 2'],
      [89, 'Exon 2'],
      [90, 'Exon 3'],
      [119, 'Exon 3'],
    ] as const)
      expect(cdsRegionHoverLine(feature, position, 150)).toBe(expected);
    expect(cdsRegionHoverLine(feature, 120, 150)).toBeNull();
    expect(cdsRegionHoverLine(feature, null, 150)).toBeNull();
    expect(cdsRegionHoverLine({ ...feature, segments: undefined }, 0, 150)).toBeNull();
    expect(cdsRegionHoverLine({ ...feature, type: 'gene' }, 0, 150)).toBeNull();
  });
  it('numbers in transcription order on the reverse strand without inventing an intron between adjacent exons', () => {
    const reverse = { ...feature, direction: -1 };
    expect(cdsRegionHoverLine(reverse, 0, 150)).toBe('Exon 3');
    expect(cdsRegionHoverLine(reverse, 60, 150)).toBe('Exon 2');
    expect(cdsRegionHoverLine(reverse, 119, 150)).toBe('Exon 1');
    expect(cdsRegionHoverLine(reverse, 45, 150)).toBe('Intron 1');
    const multipleGaps = {
      ...reverse,
      end: 150,
      segments: [
        { start: 1, end: 30 },
        { start: 61, end: 90 },
        { start: 121, end: 150 },
      ],
    };
    expect(cdsRegionHoverLine(multipleGaps, 45, 150)).toBe('Intron 2');
    expect(cdsRegionHoverLine(multipleGaps, 100, 150)).toBe('Intron 1');
  });
  it.each([1, -1])('handles circular-origin exons and introns on strand %i', (direction) => {
    const origin = {
      type: 'CDS',
      start: 240,
      end: 120,
      direction,
      segments: [
        { start: 240, end: 270 },
        { start: 31, end: 120 },
      ],
    };
    for (const position of [270, 299, 0, 29])
      expect(cdsRegionHoverLine(origin, position, 300)).toBe('Intron 1');
    expect(cdsRegionHoverLine(origin, 269, 300)).toBe(`Exon ${direction === 1 ? 1 : 2}`);
    expect(cdsRegionHoverLine(origin, 30, 300)).toBe(`Exon ${direction === 1 ? 2 : 1}`);
    const wrappedExon = {
      ...origin,
      segments: [
        { start: 240, end: 30 },
        { start: 61, end: 120 },
      ],
    };
    for (const position of [239, 299, 0, 29])
      expect(cdsRegionHoverLine(wrappedExon, position, 300)).toBe(
        `Exon ${direction === 1 ? 1 : 2}`
      );
    expect(cdsRegionHoverLine(wrappedExon, 30, 300)).toBe('Intron 1');
    expect(cdsRegionHoverLine(wrappedExon, 59, 300)).toBe('Intron 1');
    expect(cdsRegionHoverLine(wrappedExon, 150, 300)).toBeNull();
  });
});

describe('the feature line', () => {
  it('gives the type and how long the feature is', () => {
    expect(featureSummaryLine({ type: 'CDS', start: 319, end: 1062 })).toBe('CDS • 744 bp');
  });

  it('points the way the feature reads', () => {
    expect(featureSummaryLine({ type: 'CDS', start: 1, end: 12, direction: 1 })).toBe(
      'CDS • 12 bp →'
    );
    expect(featureSummaryLine({ type: 'CDS', start: 1, end: 12, direction: -1 })).toBe(
      'CDS • 12 bp ←'
    );
  });

  it('says nothing about direction for a feature that has none', () => {
    expect(featureSummaryLine({ type: 'misc_feature', start: 1, end: 12 })).toBe(
      'misc_feature • 12 bp'
    );
    expect(featureSummaryLine({ type: 'misc_feature', start: 1, end: 12, direction: 0 })).toBe(
      'misc_feature • 12 bp'
    );
  });

  it('counts the bases that become protein, not the span, for a spliced gene', () => {
    expect(
      featureSummaryLine({
        type: 'CDS',
        start: 1,
        end: 15,
        direction: 1,
        segments: [
          { start: 1, end: 6 },
          { start: 10, end: 15 },
        ],
      })
    ).toBe('CDS • 12 bp (15 bp span) →');
  });

  it('shows one number when the gene has no introns to distinguish', () => {
    expect(
      featureSummaryLine({
        type: 'CDS',
        start: 1,
        end: 12,
        segments: [{ start: 1, end: 12 }],
      })
    ).toBe('CDS • 12 bp');
  });

  it('groups the digits of a long gene so it can be read at a glance', () => {
    expect(featureSummaryLine({ type: 'CDS', start: 1, end: 2148 })).toBe('CDS • 2,148 bp');
  });
});

describe('the amino-acid line', () => {
  it('names an ordinary amino acid beside its letter', () => {
    expect(codonNameLine({ short: 'M', full: 'M', kind: 'amino-acid', name: 'Methionine' })).toBe(
      'M • Methionine'
    );
  });

  it('names a non-standard residue the file described', () => {
    expect(
      codonNameLine({
        short: 'X',
        full: 'pAzF',
        kind: 'residue',
        name: 'p-azido-L-phenylalanine',
      })
    ).toBe('X • p-azido-L-phenylalanine');
  });

  it('writes a stop as a word rather than a symbol', () => {
    expect(codonNameLine({ short: '*', full: '*', kind: 'stop', name: 'Stop' })).toBe('* • Stop');
  });

  it('does not repeat itself when the letter IS the name', () => {
    expect(codonNameLine({ short: 'Stop', full: 'Stop', kind: 'stop', name: 'Stop' })).toBe('Stop');
  });

  it('has no line at all when the pointer is not on a codon', () => {
    expect(codonNameLine(null)).toBeNull();
    expect(codonNameLine(undefined)).toBeNull();
  });

  it('has no line when the codon carries no name', () => {
    expect(codonNameLine({ short: 'M', full: 'M', kind: 'amino-acid' })).toBeNull();
  });
});
