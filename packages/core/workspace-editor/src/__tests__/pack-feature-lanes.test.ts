import { describe, expect, it } from 'vitest';
import { packIntoLanes } from '../pack-feature-lanes';

describe('visible feature lane packing', () => {
  it('forgets completed intervals instead of comparing every preceding gene at whole-genome zoom', () => {
    let reads = 0;
    const rows = Array.from({ length: 2000 }, (_, item) => ({
      item,
      ranges: [
        {
          get start() {
            reads++;
            return item * 10;
          },
          get end() {
            reads++;
            return item * 10 + 8;
          },
        },
      ],
    }));
    const result = packIntoLanes(rows);
    expect(result.laneCount).toBe(1);
    expect(result.packed.map((entry) => entry.item)).toEqual(rows.map((entry) => entry.item));
    expect(reads).toBeLessThan(2000 * 20);
  });

  it('retains later segments of an origin-spanning feature while reusing completed space', () => {
    const rows = [
      {
        item: 'origin',
        ranges: [
          { start: 0, end: 10 },
          { start: 90, end: 100 },
        ],
      },
      { item: 'overlap-start', ranges: [{ start: 5, end: 15 }] },
      { item: 'middle', ranges: [{ start: 10, end: 80 }] },
      { item: 'touching', ranges: [{ start: 80, end: 90 }] },
      { item: 'overlap-end', ranges: [{ start: 95, end: 100 }] },
    ];
    expect(packIntoLanes(rows)).toEqual({
      laneCount: 2,
      packed: [
        { item: 'origin', lane: 0 },
        { item: 'overlap-start', lane: 1 },
        { item: 'middle', lane: 0 },
        { item: 'touching', lane: 0 },
        { item: 'overlap-end', lane: 1 },
      ],
    });
  });

  it('preserves first-fit assignments for dense overlapping and disjoint multi-range features', () => {
    let seed = 12345;
    const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const rows = Array.from({ length: 800 }, (_, item) => {
      const start = Math.floor(random() * 10000);
      return {
        item,
        ranges: [
          { start, end: start + 1 + Math.floor(random() * 100) },
          ...(item % 11 === 0 ? [{ start: start + 200, end: start + 250 }] : []),
        ],
      };
    }).sort((a, b) => a.ranges[0].start - b.ranges[0].start);
    const occupied: (typeof rows)[number]['ranges'][] = [];
    const expected = rows.map(({ item, ranges }) => {
      let lane = occupied.findIndex(
        (prior) => !ranges.some((a) => prior.some((b) => a.start < b.end && b.start < a.end))
      );
      if (lane < 0) {
        lane = occupied.length;
        occupied.push([]);
      }
      occupied[lane].push(...ranges);
      return { item, lane };
    });
    expect(packIntoLanes(rows)).toEqual({ packed: expected, laneCount: occupied.length });
  });
});
