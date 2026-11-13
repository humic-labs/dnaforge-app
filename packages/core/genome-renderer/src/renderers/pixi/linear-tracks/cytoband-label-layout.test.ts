import { describe, expect, it } from 'vitest';

import {
  compactCytobandLabel,
  estimateCytobandLabelWidthPx,
  findCytobandLabelIndexAtX,
  layoutCytobandLabels,
} from './cytoband-label-layout';

describe('cytoband label layout', () => {
  it.each([
    ['chr1', '1'],
    ['chr22', '22'],
    ['chrX', 'X'],
    ['chrY', 'Y'],
    ['chrM', 'M'],
    ['contig-17', 'contig-17'],
    ['Chromosome 1', 'Chromosome 1'],
  ])('uses a compact karyotype label for %s', (displayName, expected) => {
    expect(compactCytobandLabel(displayName)).toBe(expected);
  });

  it('estimates label width without requiring a live canvas measurement context', () => {
    expect(estimateCytobandLabelWidthPx('22')).toBe(14);
    expect(estimateCytobandLabelWidthPx('tiny-contig')).toBe(77);
    expect(estimateCytobandLabelWidthPx('染色体')).toBe(30);
  });

  it('centers every fitting label inside its own genomic span with a boundary gutter', () => {
    expect(
      layoutCytobandLabels([
        { chromosomeId: 'chr1', text: '1', textWidthPx: 6, leftPx: 0, rightPx: 30 },
        { chromosomeId: 'chr2', text: '2', textWidthPx: 6, leftPx: 30, rightPx: 52 },
      ])
    ).toEqual([
      {
        chromosomeId: 'chr1',
        text: '1',
        visible: true,
        memberLeftPx: 0,
        memberRightPx: 30,
        labelLeftPx: 12,
        labelRightPx: 18,
      },
      {
        chromosomeId: 'chr2',
        text: '2',
        visible: true,
        memberLeftPx: 30,
        memberRightPx: 52,
        labelLeftPx: 38,
        labelRightPx: 44,
      },
    ]);
  });

  it('fails closed instead of letting a long contig label overlap its neighbors', () => {
    expect(
      layoutCytobandLabels([
        {
          chromosomeId: 'tiny',
          text: 'tiny-contig',
          textWidthPx: 66,
          leftPx: 40,
          rightPx: 52,
        },
      ])
    ).toEqual([
      {
        chromosomeId: 'tiny',
        text: 'tiny-contig',
        visible: false,
        memberLeftPx: 40,
        memberRightPx: 52,
        labelLeftPx: null,
        labelRightPx: null,
      },
    ]);
  });

  it('hides a fitting label that would overlap a previous visible label', () => {
    const layouts = layoutCytobandLabels([
      { chromosomeId: 'a', text: 'A', textWidthPx: 10, leftPx: 0, rightPx: 30 },
      { chromosomeId: 'b', text: 'B', textWidthPx: 10, leftPx: 10, rightPx: 40 },
      { chromosomeId: 'c', text: 'C', textWidthPx: 10, leftPx: 30, rightPx: 60 },
    ]);

    expect(layouts.map(({ visible }) => visible)).toEqual([true, false, true]);
  });

  it('adds horizontal padding around visible labels without crossing chromosome bounds', () => {
    const layouts = layoutCytobandLabels([
      { chromosomeId: 'chr1', text: '1', textWidthPx: 6, leftPx: 0, rightPx: 30 },
      { chromosomeId: 'chr2', text: '2', textWidthPx: 6, leftPx: 30, rightPx: 52 },
    ]);

    expect(findCytobandLabelIndexAtX(layouts, 5, 6)).toBe(-1);
    expect(findCytobandLabelIndexAtX(layouts, 6, 6)).toBe(0);
    expect(findCytobandLabelIndexAtX(layouts, 29, 20)).toBe(0);
    expect(findCytobandLabelIndexAtX(layouts, 31, 20)).toBe(1);
  });
});
