// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  computeFrameTranslation,
  computeSixFrameTranslations,
  FRAME_NUMBERS,
} from './six-frame-translation';

describe('six-frame-translation', () => {
  it('translates the forward frame 1 of a clean ORF (ATG AAA TAA -> MK*)', () => {
    const result = computeFrameTranslation('ATGAAATAA', 'forward', 1);
    expect(result.aminoAcids).toBe('MK*');
    expect(result.codonCount).toBe(3);
    expect(result.truncatedBases).toBe(0);
  });

  it('shifts the reading frame by (frame - 1) bases', () => {
    const frame2 = computeFrameTranslation('ATGAAATAA', 'forward', 2);
    expect(frame2.aminoAcids).toBe('*N');
    expect(frame2.truncatedBases).toBe((9 - 1) % 3);
  });

  it('translates all three reverse frames against the reverse complement (revcomp=TTATTTCAT)', () => {
    const reverse1 = computeFrameTranslation('ATGAAATAA', 'reverse', 1);
    expect(reverse1).toMatchObject({ aminoAcids: 'LFH', codonCount: 3, truncatedBases: 0 });

    const reverse2 = computeFrameTranslation('ATGAAATAA', 'reverse', 2);
    expect(reverse2).toMatchObject({ aminoAcids: 'YF', codonCount: 2, truncatedBases: 2 });

    const reverse3 = computeFrameTranslation('ATGAAATAA', 'reverse', 3);
    expect(reverse3).toMatchObject({ aminoAcids: 'IS', codonCount: 2, truncatedBases: 1 });
  });

  it('ignores alignment gaps when translating and counting codons', () => {
    expect(computeFrameTranslation('AT-GA-AAT-AA', 'forward', 1)).toMatchObject({
      aminoAcids: 'MK*',
      codonCount: 3,
      truncatedBases: 0,
    });
  });

  it('produces exactly six frames in forward-then-reverse order, numbered 1/2/3', () => {
    const frames = computeSixFrameTranslations('ATGAAATAA');
    expect(frames).toHaveLength(6);
    expect(frames.map((f) => `${f.strand}${f.frame}`)).toEqual([
      'forward1',
      'forward2',
      'forward3',
      'reverse1',
      'reverse2',
      'reverse3',
    ]);
    expect(FRAME_NUMBERS).toEqual([1, 2, 3]);
  });

  it('returns empty amino acids for a selection shorter than a codon', () => {
    const frame = computeFrameTranslation('AT', 'forward', 1);
    expect(frame.aminoAcids).toBe('');
    expect(frame.codonCount).toBe(0);
    expect(frame.truncatedBases).toBe(2);
  });
});
