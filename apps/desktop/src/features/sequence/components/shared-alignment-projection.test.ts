import { describe, expect, it } from 'vitest';
import { buildSharedAlignmentProjection } from './shared-alignment-projection';

type PlacedProjectionTrack = Parameters<typeof buildSharedAlignmentProjection>[1][number] & {
  readonly circularOffset?: number;
  readonly referenceLength?: number;
};

const buildPlacedProjection: (
  reference: string,
  tracks: ReadonlyArray<PlacedProjectionTrack>,
  selectedTrackId?: string | null,
  topology?: 'linear' | 'circular'
) => ReturnType<typeof buildSharedAlignmentProjection> = buildSharedAlignmentProjection;

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

  it('places a partial query on the full reference without inventing unobserved bases', () => {
    const projection = buildPlacedProjection(
      'ATGAAACCCGGGTAA',
      [
        {
          id: 'partial',
          label: 'partial',
          alignedReference: 'CCCGGG',
          alignedQuery: 'CCTGGG',
          circularOffset: 6,
          referenceLength: 15,
        },
      ],
      'partial',
      'circular'
    );

    expect(projection).not.toBeNull();
    expect(projection?.coordinateSpace).toEqual({
      mode: 'gapped',
      gappedSequence: 'ATGAAACCCGGGTAA',
    });
    expect(projection?.lanes).toHaveLength(1);
    expect(projection?.lanes[0]).toMatchObject({
      alignedReference: 'ATGAAACCCGGGTAA',
      queryColumns: [
        null,
        null,
        null,
        null,
        null,
        null,
        'C',
        'C',
        'T',
        'G',
        'G',
        'G',
        null,
        null,
        null,
      ],
    });
    expect(projection?.lanes[0]).not.toHaveProperty('alignedQuery');
    expect(projection?.projectTrackColumn('partial', 2)).toBe(8);
  });

  it('keeps an observed internal deletion distinct from unobserved reference positions', () => {
    const projection = buildPlacedProjection(
      'ATGAAACCCGGGTAA',
      [
        {
          id: 'deletion',
          label: 'deletion',
          alignedReference: 'CCCGGG',
          alignedQuery: 'CC-GGG',
          circularOffset: 6,
          referenceLength: 15,
        },
      ],
      'deletion',
      'circular'
    );

    expect(projection?.lanes[0]).toMatchObject({
      queryColumns: [
        null,
        null,
        null,
        null,
        null,
        null,
        'C',
        'C',
        '-',
        'G',
        'G',
        'G',
        null,
        null,
        null,
      ],
    });
    expect(projection?.lanes[0]).not.toHaveProperty('alignedQuery');
    expect(projection?.projectTrackColumn('deletion', 2)).toBe(8);
  });

  it('maps a partial query across the circular origin while keeping the original reference order', () => {
    const projection = buildPlacedProjection(
      'ACGTAC',
      [
        {
          id: 'wrapped',
          label: 'wrapped',
          alignedReference: 'ACAC',
          alignedQuery: 'ACAC',
          circularOffset: 4,
          referenceLength: 6,
        },
      ],
      'wrapped',
      'circular'
    );

    expect(projection?.coordinateSpace).toEqual({ mode: 'gapped', gappedSequence: 'ACGTAC' });
    expect(projection?.lanes[0]).toMatchObject({
      alignedReference: 'ACGTAC',
      queryColumns: ['A', 'C', null, null, 'A', 'C'],
    });
    expect(projection?.lanes[0]).not.toHaveProperty('alignedQuery');
    expect([0, 1, 2, 3].map((column) => projection?.projectTrackColumn('wrapped', column))).toEqual(
      [4, 5, 0, 1]
    );
  });

  it('uses the explicit offset when a partial reference occurs more than once', () => {
    const projection = buildPlacedProjection(
      'ACGTACGT',
      [
        {
          id: 'repeat',
          label: 'repeat',
          alignedReference: 'ACGT',
          alignedQuery: 'ATGT',
          circularOffset: 4,
          referenceLength: 8,
        },
      ],
      'repeat',
      'circular'
    );

    expect(projection?.lanes[0]).toMatchObject({
      queryColumns: [null, null, null, null, 'A', 'T', 'G', 'T'],
    });
    expect([0, 1, 2, 3].map((column) => projection?.projectTrackColumn('repeat', column))).toEqual([
      4, 5, 6, 7,
    ]);
  });

  it.each([
    { reason: 'missing offset', placement: { referenceLength: 15 } },
    { reason: 'wrong offset', placement: { circularOffset: 5, referenceLength: 15 } },
    { reason: 'missing reference length', placement: { circularOffset: 6 } },
    { reason: 'wrong reference length', placement: { circularOffset: 6, referenceLength: 14 } },
    {
      reason: 'mismatched reference base',
      placement: { circularOffset: 6, referenceLength: 15, alignedReference: 'CCAGGG' },
    },
  ])('rejects a partial row with $reason', ({ placement }) => {
    expect(
      buildPlacedProjection(
        'ATGAAACCCGGGTAA',
        [
          {
            id: 'invalid',
            label: 'invalid',
            alignedReference: 'CCCGGG',
            alignedQuery: 'CCTGGG',
            ...placement,
          },
        ],
        'invalid',
        'circular'
      )
    ).toBeNull();
  });
});
