import { describe, expect, it } from 'vitest';
import { computeCodonCells, computeCodonEnvelopeCells } from './codon-rendering';
import { buildChevronStripOuterPath } from './rendering/canvas-primitives';

const sequence = 'ATGAAATAG'.repeat(100);
const rows = [
  [0, 900],
  [7, 40],
  [8, 35],
  [300, 600],
  [599, 604],
  [610, 680],
] as const;
type Geometry = Parameters<typeof buildChevronStripOuterPath>[1];

function contour(cells: Geometry, direction: 1 | -1, depth: number, left: number, right: number) {
  const operations: (string | number)[][] = [];
  buildChevronStripOuterPath(
    {
      beginPath: () => {
        operations.push(['begin']);
      },
      moveTo: (x, y) => {
        operations.push(['move', x, y]);
      },
      lineTo: (x, y) => {
        operations.push(['line', x, y]);
      },
      closePath: () => {
        operations.push(['close']);
      },
    },
    cells,
    232.5,
    14.333,
    depth,
    direction,
    { left, right }
  );
  return operations;
}

describe('ordinary codon envelope geometry', () => {
  for (const direction of [1, -1] as const)
    for (const codonStart of [1, 2, 3])
      it.each(rows)(
        'retains the full contour on strand ' +
          direction +
          ', frame ' +
          codonStart +
          ', row %i..%i',
        (start, end) => {
          const region = {
            start: 6,
            end: 602,
            direction,
            qualifiers: { codon_start: [String(codonStart)], transl_table: ['4'] },
          };
          for (const width of [0.017, 0.33, 3.333, 8.125]) {
            const envelope = computeCodonEnvelopeCells(
              region,
              start,
              end,
              17.25,
              width,
              sequence.length
            );
            expect(envelope).not.toBeNull();
            if (!envelope) throw new Error('Ordinary fixture must use bounded geometry');
            expect(envelope.length).toBeLessThanOrEqual(4);
            const complete = computeCodonCells(
              region,
              start,
              end,
              17.25,
              width,
              sequence,
              sequence.length,
              { type: 'normal' }
            );
            const left = 17.25 + (Math.max(start, region.start) - start) * width;
            const right = 17.25 + (Math.min(end, region.end + 1) - start) * width;
            for (const depth of [0, 1.75, 7.2])
              expect(contour(envelope, direction, depth, left, right)).toEqual(
                contour(complete, direction, depth, left, right)
              );
            expect(envelope.every((cell) => !('aa' in cell) && !('display' in cell))).toBe(true);
          }
        }
      );

  it('requests the complete authoritative path for splicing, origin crossings and general rows', () => {
    const region = { start: 6, end: 602, direction: 1 as const };
    expect(
      computeCodonEnvelopeCells(
        {
          ...region,
          segments: [
            { start: 7, end: 30 },
            { start: 601, end: 603 },
          ],
        },
        0,
        900,
        0,
        1,
        900
      )
    ).toBeNull();
    expect(
      computeCodonEnvelopeCells({ ...region, start: 749, end: 59 }, 0, 900, 0, 1, 900)
    ).toBeNull();
    for (const [start, end] of [
      [880, 20],
      [-1, 40],
      [1.25, 40],
    ])
      expect(computeCodonEnvelopeCells(region, start, end, 0, 1, 900)).toBeNull();
    expect(computeCodonEnvelopeCells(region, 0, 900, 0, -1, 900)).toBeNull();
  });
});
