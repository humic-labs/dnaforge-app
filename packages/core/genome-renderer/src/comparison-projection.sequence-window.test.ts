import { describe, expect, it } from 'vitest';
import { createComparisonProjection } from './comparison-projection';
import { comparisonFixture } from './test-support/comparison-projection-fixture';

describe('comparison source sequence windows', () => {
  for (const side of ['target', 'query'] as const) {
    const field = side === 'target' ? 'targetSequenceWindows' : 'querySequenceWindows';

    it(`accepts bounded ${side} bases in exact source coordinates`, () => {
      const source = comparisonFixture();
      const window = { start: 10, sequence: 'aCg' };
      const projection = createComparisonProjection({
        ...source,
        targetSequence: undefined,
        querySequence: undefined,
        [field]: [window],
      });
      expect(projection[field]).toEqual([window]);
      expect(projection.layout).toEqual(source.layout);
      expect(projection.targetSequence).toBeUndefined();
      expect(projection.querySequence).toBeUndefined();
    });

    it.each([
      { start: -1, sequence: 'A' },
      { start: 1.5, sequence: 'A' },
      { start: Number.NaN, sequence: 'A' },
      { start: Number.POSITIVE_INFINITY, sequence: 'A' },
      { start: Number.MAX_SAFE_INTEGER + 1, sequence: '' },
      { start: 19, sequence: 'AC' },
      { start: 21, sequence: '' },
    ])(`refuses an invalid ${side} source window %j`, (window) => {
      expect(() =>
        createComparisonProjection({ ...comparisonFixture(), [field]: [window] })
      ).toThrow('reference length');
    });

    it(`rejects overlapping ${side} source windows`, () => {
      expect(() =>
        createComparisonProjection({
          ...comparisonFixture(),
          [field]: [
            { start: 10, sequence: 'ACG' },
            { start: 9, sequence: 'TT' },
          ],
        })
      ).toThrow('overlap');
    });

    it(`accepts unordered adjacent ${side} source windows without changing their order`, () => {
      const windows = [
        { start: 12, sequence: 'GT' },
        { start: 10, sequence: 'AC' },
      ];
      const projection = createComparisonProjection({ ...comparisonFixture(), [field]: windows });
      expect(projection[field]).toEqual([
        { start: 12, sequence: 'GT' },
        { start: 10, sequence: 'AC' },
      ]);
      expect(windows[0].start).toBe(12);
    });

    it(`accepts the final ${side} base and an empty window at the reference end`, () => {
      expect(
        createComparisonProjection({
          ...comparisonFixture(),
          [field]: [{ start: 19, sequence: 'T' }],
        })[field]
      ).toEqual([{ start: 19, sequence: 'T' }]);
      expect(
        createComparisonProjection({
          ...comparisonFixture(),
          [field]: [{ start: 20, sequence: '' }],
        })[field]
      ).toEqual([{ start: 20, sequence: '' }]);
    });
  }

  it('keeps complete sequence validation when an explicit window is also supplied', () => {
    expect(() =>
      createComparisonProjection({
        ...comparisonFixture(),
        targetSequence: 'AC',
        targetSequenceWindows: [{ start: 0, sequence: 'AC' }],
      })
    ).toThrow('reference length');
  });
});
