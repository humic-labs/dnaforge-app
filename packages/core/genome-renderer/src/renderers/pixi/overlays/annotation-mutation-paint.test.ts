import { describe, expect, it } from 'vitest';
import { CDS_MUTATION_MARKUP } from '@waypoint/sequence-utils/sequence-edit-markup';
import type { CodonInfo, CodonMutationKind } from '../../../biology/translation';
import type { Feature } from '../../../types';
import { buildAnnotationMutationPaint, codonMutationColor } from './annotation-mutation-paint';

function codon(startBp: number, endBp: number, kind: CodonMutationKind, extra = {}): CodonInfo {
  return {
    startBp,
    endBp,
    codon: 'AAA',
    aa: 'K',
    isStop: false,
    isStart: false,
    mutation: {
      kind,
      referenceCodons: [],
      frameShifted: false,
      prematureStop: false,
      stopLost: false,
    },
    ...extra,
  };
}

const feature: Feature = {
  id: 30,
  type: 'CDS',
  start: 0,
  end: 30,
  color: 0x123456,
  lane: 0,
  direction: 'forward',
  displayName: 'Gene',
};

describe('annotation mutation paint', () => {
  it('uses the exact chevron color authority for every protein effect', () => {
    expect(codonMutationColor(codon(0, 3, 'match'))).toBeNull();
    expect(codonMutationColor(codon(0, 3, 'synonymous'))).toBeNull();
    expect(codonMutationColor(codon(0, 3, 'deleted'))).toBeNull();
    expect(codonMutationColor(codon(0, 3, 'unknown'))).toBeNull();
    expect(codonMutationColor(codon(0, 3, 'substitution'))).toBe(
      CDS_MUTATION_MARKUP.substitution.background.color
    );
    expect(codonMutationColor(codon(0, 3, 'inserted'))).toBe(
      CDS_MUTATION_MARKUP.inserted.background.color
    );
    const original = codon(0, 3, 'frameshifted');
    const shifted = { ...original, mutation: { ...original.mutation!, frameShifted: true } };
    expect(codonMutationColor(shifted)).toBe(CDS_MUTATION_MARKUP.frameshifted.background.color);
    expect(codonMutationColor({ ...shifted, isStop: true, aa: '*' })).toBe(
      CDS_MUTATION_MARKUP.prematureStop.background.color
    );
  });

  it('keeps projected split codon fragments separate and merges only adjacent equal paint', () => {
    const paint = buildAnnotationMutationPaint(
      [feature],
      {
        cdsComparisonLayout: 'diff',
        codingFeatures: new Map([
          [
            30,
            {
              source: 'query',
              introns: [],
              codons: [
                codon(0, 3, 'synonymous'),
                codon(3, 4, 'substitution'),
                codon(10, 12, 'substitution'),
                codon(12, 15, 'substitution'),
                codon(15, 18, 'substitution', { isStop: true }),
              ],
            },
          ],
        ]),
      },
      30
    );
    expect(paint.get(30)).toEqual({
      baseColor: 0x9e9e9e,
      coding: true,
      sectors: [
        { start: 3, end: 4, color: 0xffc800 },
        { start: 10, end: 15, color: 0xffc800 },
        { start: 15, end: 18, color: 0xf44336 },
      ],
    });
  });

  it('clips non-CDS DNA sectors to covered segments and preserves palette edits', () => {
    const nonCoding = {
      ...feature,
      id: 40,
      type: 'misc_feature',
      segments: [
        { start: 3, end: 5 },
        { start: 11, end: 15 },
      ],
    };
    const paint = buildAnnotationMutationPaint(
      [nonCoding],
      {
        annotationUnchangedColor: 0x8899aa,
        nucleotideChanges: [
          { start: 3, end: 12, kind: 'substitution', color: 0xaabbcc },
          { start: 13, end: 20, kind: 'deletion', color: 0xaa3311 },
        ],
      },
      30
    );
    expect(paint.get(40)).toEqual({
      baseColor: 0x8899aa,
      coding: false,
      sectors: [
        { start: 3, end: 5, color: 0xaabbcc },
        { start: 10, end: 12, color: 0xaabbcc },
        { start: 13, end: 15, color: 0xaa3311 },
      ],
    });
    expect(buildAnnotationMutationPaint([feature], undefined, 30).size).toBe(0);
  });
});
