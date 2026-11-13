import { describe, it, expect } from 'vitest';
import { buildSplicedCodingSequence, isSplicedCDS } from './spliced-coding-sequence';
import type { Annotation } from '@waypoint/sequence-utils';

function makeSplicedCDS(
  segments: Array<{ start: number; end: number }>,
  direction: 1 | -1 = 1,
  qualifiers: Record<string, string[]> = {}
): Annotation {
  return {
    name: 'test_cds',
    type: 'CDS',
    start: Math.min(...segments.map((s) => s.start)),
    end: Math.max(...segments.map((s) => s.end)),
    direction,
    segments,
    qualifiers: { _locationString: ['join(mock)'], ...qualifiers },
  };
}

describe('buildSplicedCodingSequence', () => {
  describe('forward strand', () => {
    it('builds spliced sequence from 3 exons, phase 0 introns', () => {
      const seq = 'ATGGCTGAA' + 'nnnnnnnnn' + 'AAACCCTTT' + 'nnnnnnnnn' + 'GGGTAA';
      const cds = makeSplicedCDS([
        { start: 1, end: 9 },
        { start: 19, end: 27 },
        { start: 37, end: 42 },
      ]);

      const result = buildSplicedCodingSequence(cds, seq);

      expect(result.codingSequence).toBe('ATGGCTGAAAAACCCTTTGGGTAA');
      expect(result.proteinLength).toBe(8);
      expect(result.introns).toHaveLength(2);
      expect(result.introns[0].phase).toBe(0);
      expect(result.introns[1].phase).toBe(0);
      expect(result.genomicCoordinateMap).toHaveLength(24);
      expect(result.genomicCoordinateMap[0]).toBe(0);
      expect(result.genomicCoordinateMap[9]).toBe(18);
    });

    it('handles phase 1 intron (splits codon after 1st base)', () => {
      const seq = 'ATGGCTA' + 'nnn' + 'GAAACC';
      const cds = makeSplicedCDS([
        { start: 1, end: 7 },
        { start: 11, end: 16 },
      ]);

      const result = buildSplicedCodingSequence(cds, seq);

      expect(result.codingSequence).toBe('ATGGCTAGAAACC');
      expect(result.introns).toHaveLength(1);
      expect(result.introns[0].phase).toBe(1);
    });

    it('handles phase 2 intron (splits codon after 2nd base)', () => {
      const seq = 'ATGGCTAG' + 'nnn' + 'AAACCC';
      const cds = makeSplicedCDS([
        { start: 1, end: 8 },
        { start: 12, end: 17 },
      ]);

      const result = buildSplicedCodingSequence(cds, seq);

      expect(result.codingSequence).toBe('ATGGCTAGAAACCC');
      expect(result.introns).toHaveLength(1);
      expect(result.introns[0].phase).toBe(2);
    });
  });

  describe('reverse strand', () => {
    it('reverse-complements the spliced coding sequence', () => {
      const seq = 'ATGGCTGAA' + 'nnnnnnnnn' + 'AAACCCTTT';
      const cds = makeSplicedCDS(
        [
          { start: 1, end: 9 },
          { start: 19, end: 27 },
        ],
        -1
      );

      const result = buildSplicedCodingSequence(cds, seq);

      expect(result.codingSequence).toBe('AAAGGGTTTTTCAGCCAT');
      expect(result.proteinLength).toBe(6);
      expect(result.genomicCoordinateMap).toHaveLength(18);
    });

    it('computes correct phase for reverse strand (7-base first coding exon → phase 1)', () => {
      const seq = 'ATGGCT' + 'nnnnnnnnn' + 'GCTAAAC';
      const cds = makeSplicedCDS(
        [
          { start: 1, end: 6 },
          { start: 16, end: 22 },
        ],
        -1
      );

      const result = buildSplicedCodingSequence(cds, seq);

      expect(result.introns).toHaveLength(1);
      expect(result.introns[0].phase).toBe(1);
    });

    it('extracts splice sites with RC for reverse strand', () => {
      const seq = 'ATGGCTGAA' + 'GTnnnnnAG' + 'AAACCCTTT';
      const cds = makeSplicedCDS(
        [
          { start: 1, end: 9 },
          { start: 19, end: 27 },
        ],
        -1
      );

      const result = buildSplicedCodingSequence(cds, seq);

      expect(result.introns).toHaveLength(1);
      expect(result.introns[0].donorSite).toBe('CT');
      expect(result.introns[0].acceptorSite).toBe('AC');
    });
  });

  describe('/codon_start qualifier', () => {
    it('applies /codon_start=2 offset (skip 1 base)', () => {
      const seq = 'NATGGCTGAA';
      const cds = makeSplicedCDS([{ start: 1, end: 10 }], 1, { codon_start: ['2'] });

      const result = buildSplicedCodingSequence(cds, seq);

      expect(result.codonStartOffset).toBe(1);
      expect(result.proteinLength).toBe(3);
    });

    it('applies /codon_start=3 offset (skip 2 bases)', () => {
      const seq = 'NNATGGCTGAA';
      const cds = makeSplicedCDS([{ start: 1, end: 11 }], 1, { codon_start: ['3'] });

      const result = buildSplicedCodingSequence(cds, seq);

      expect(result.codonStartOffset).toBe(2);
      expect(result.proteinLength).toBe(3);
    });
  });

  describe('splice site extraction', () => {
    it('extracts GT-AG splice sites for forward strand', () => {
      const seq = 'ATGGCTGAA' + 'GTnnnnnAG' + 'AAACCCTTT';
      const cds = makeSplicedCDS([
        { start: 1, end: 9 },
        { start: 19, end: 27 },
      ]);

      const result = buildSplicedCodingSequence(cds, seq);

      expect(result.introns[0].donorSite).toBe('GT');
      expect(result.introns[0].acceptorSite).toBe('AG');
    });
  });

  describe('origin-spanning', () => {
    it('handles circular origin-spanning exon', () => {
      const seq = 'xxxxATGCCCxxxxxxxATG';
      const cds = makeSplicedCDS([
        { start: 18, end: 20 },
        { start: 5, end: 10 },
      ]);

      const result = buildSplicedCodingSequence(cds, seq);

      expect(result.codingSequence).toBe('ATGATGCCC');
      expect(result.genomicCoordinateMap[0]).toBe(17);
      expect(result.genomicCoordinateMap[3]).toBe(4);
    });
  });

  describe('/translation validation', () => {
    it('sets translationMismatch=false when computed matches /translation', () => {
      const seq = 'ATGGCT';
      const cds = makeSplicedCDS([{ start: 1, end: 6 }], 1, {
        translation: ['MA'],
      });

      const result = buildSplicedCodingSequence(cds, seq);

      expect(result.translationMismatch).toBe(false);
    });

    it('sets translationMismatch=true when computed mismatches /translation', () => {
      const seq = 'ATGGCT';
      const cds = makeSplicedCDS([{ start: 1, end: 6 }], 1, {
        translation: ['MV'],
      });

      const result = buildSplicedCodingSequence(cds, seq);

      expect(result.translationMismatch).toBe(true);
    });

    it('sets translationMismatch=false when no /translation qualifier', () => {
      const seq = 'ATGGCT';
      const cds = makeSplicedCDS([{ start: 1, end: 6 }]);

      const result = buildSplicedCodingSequence(cds, seq);

      expect(result.translationMismatch).toBe(false);
    });
  });

  describe('order() guard', () => {
    it('treats CDS without join() locationString as contiguous', () => {
      const seq = 'ATGGCTGAA' + 'nnn' + 'AAACCC';
      const cds: Annotation = {
        name: 'test',
        type: 'CDS',
        start: 1,
        end: 15,
        direction: 1,
        segments: [
          { start: 1, end: 9 },
          { start: 13, end: 15 },
        ],
        qualifiers: { _locationString: ['order(1..9,13..15)'] },
      };

      const result = buildSplicedCodingSequence(cds, seq);

      expect(result.codingSequence).toBe(seq.slice(0, 15));
      expect(result.introns).toHaveLength(0);
    });
  });

  describe('phantom intron guard', () => {
    it('produces no intron for adjacent segments (no gap)', () => {
      const seq = 'ATGGCTAAATGA';
      const cds: Annotation = {
        name: 'test',
        type: 'CDS',
        start: 1,
        end: 12,
        direction: 1,
        segments: [
          { start: 1, end: 6 },
          { start: 7, end: 12 },
        ],
        qualifiers: { _locationString: ['join(1..6,7..12)'] },
      };

      const result = buildSplicedCodingSequence(cds, seq);

      expect(result.introns).toHaveLength(0);
      expect(result.codingSequence).toBe('ATGGCTAAATGA');
    });
  });

  describe('intron metadata', () => {
    it('computes intron number, genomicStart, genomicEnd, length', () => {
      const seq = 'ATGGCTGAA' + 'nnnnn' + 'AAACCCTTT' + 'nn' + 'GGGTAA';
      const cds = makeSplicedCDS([
        { start: 1, end: 9 },
        { start: 15, end: 23 },
        { start: 26, end: 31 },
      ]);

      const result = buildSplicedCodingSequence(cds, seq);

      expect(result.introns).toHaveLength(2);

      expect(result.introns[0].number).toBe(1);
      expect(result.introns[0].genomicStart).toBe(9);
      expect(result.introns[0].genomicEnd).toBe(13);
      expect(result.introns[0].length).toBe(5);

      expect(result.introns[1].number).toBe(2);
      expect(result.introns[1].genomicStart).toBe(23);
      expect(result.introns[1].genomicEnd).toBe(24);
      expect(result.introns[1].length).toBe(2);
    });
  });
});

describe('isSplicedCDS', () => {
  it('returns false for a single-segment CDS', () => {
    const cds: Annotation = {
      name: 'plain',
      type: 'CDS',
      start: 100,
      end: 500,
      direction: 1,
      qualifiers: { _locationString: ['100..500'] },
    };
    expect(isSplicedCDS(cds)).toBe(false);
  });

  it('returns true for a real spliced CDS (start < end, has join() in location)', () => {
    const cds: Annotation = {
      name: 'spliced',
      type: 'CDS',
      start: 1,
      end: 300,
      direction: 1,
      segments: [
        { start: 1, end: 100 },
        { start: 200, end: 300 },
      ],
      qualifiers: { _locationString: ['join(1..100,200..300)'] },
    };
    expect(isSplicedCDS(cds)).toBe(true);
  });

  it('returns FALSE for an origin-wrapping CDS (start > end, complement strand)', () => {
    const cds: Annotation = {
      name: 'URA3',
      type: 'CDS',
      start: 12551,
      end: 603,
      direction: -1,
      segments: [
        { start: 12551, end: 12751 },
        { start: 1, end: 603 },
      ],
      qualifiers: { _locationString: ['complement(join(1..603,12551..12751))'] },
    };
    expect(isSplicedCDS(cds)).toBe(false);
  });

  it('returns FALSE for forward-strand origin-wrap (start > end, simple join)', () => {
    const cds: Annotation = {
      name: 'forward_wrap',
      type: 'CDS',
      start: 11000,
      end: 500,
      direction: 1,
      segments: [
        { start: 11000, end: 12751 },
        { start: 1, end: 500 },
      ],
      qualifiers: { _locationString: ['join(11000..12751,1..500)'] },
    };
    expect(isSplicedCDS(cds)).toBe(false);
  });

  it('returns false for order() locations (different semantics)', () => {
    const cds: Annotation = {
      name: 'order_loc',
      type: 'CDS',
      start: 1,
      end: 300,
      direction: 1,
      segments: [
        { start: 1, end: 100 },
        { start: 200, end: 300 },
      ],
      qualifiers: { _locationString: ['order(1..100,200..300)'] },
    };
    expect(isSplicedCDS(cds)).toBe(false);
  });
});
