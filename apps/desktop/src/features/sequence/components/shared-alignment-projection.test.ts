import { describe, expect, it } from 'vitest';
import { buildSharedAlignmentProjection } from './shared-alignment-projection';

describe('shared alignment projection', () => {
  it('aligns rows with different insertions on one reference and preserves column navigation', () => {
    const projection = buildSharedAlignmentProjection(
      'ACGT',
      [
        { id: 'one', label: 'first', alignedReference: 'AC-GT', alignedQuery: 'ACTGT' },
        { id: 'two', label: 'second', alignedReference: 'A--CGT', alignedQuery: 'ATT-GT' },
      ],
      'two'
    );
    expect(projection?.coordinateSpace).toEqual({
      mode: 'gapped',
      gappedSequence: 'A--C-GT',
      alignedQuery: 'ATT--GT',
    });
    expect(projection?.lanes.map((lane) => [lane.label, lane.alignedQuery])).toEqual([
      ['first', 'A--CTGT'],
      ['second', 'ATT--GT'],
    ]);
    expect(projection?.projectTrackColumn('one', 2)).toBe(4);
    expect(projection?.projectTrackColumn('two', 2)).toBe(2);
    expect(projection?.projectTrackColumn('two', 3)).toBe(3);
    expect(
      buildSharedAlignmentProjection(
        'ACGT',
        [{ id: 'one', label: 'first', alignedReference: 'AC-GT', alignedQuery: 'ACTGT' }],
        'hidden'
      )?.selectedTrackId
    ).toBe('one');
  });

  it('supports leading and trailing insertions without changing biological bases', () => {
    const projection = buildSharedAlignmentProjection('AC', [
      { id: 'a', label: 'a', alignedReference: '-AC', alignedQuery: 'TAC' },
      { id: 'b', label: 'b', alignedReference: 'AC--', alignedQuery: 'ACGG' },
    ]);
    expect(projection?.coordinateSpace.gappedSequence).toBe('-AC--');
    expect(projection?.lanes.map((lane) => lane.alignedQuery)).toEqual(['TAC--', '-ACGG']);
    expect(projection?.projectTrackColumn('a', 0)).toBe(0);
    expect(projection?.projectTrackColumn('b', 2)).toBe(3);
  });

  it('rejects rows that do not belong to the open reference', () => {
    expect(
      buildSharedAlignmentProjection('AC', [
        { id: 'wrong', label: 'wrong', alignedReference: 'AG', alignedQuery: 'AG' },
      ])
    ).toBeNull();
  });
});
