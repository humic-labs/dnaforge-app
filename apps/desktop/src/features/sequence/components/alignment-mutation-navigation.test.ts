import { describe, expect, it } from 'vitest';
import { buildSharedAlignmentProjection } from './shared-alignment-projection';
import { buildSharedSequenceAxis } from './shared-sequence-read-model';
import { resolveAlignmentMutationNavigation } from './alignment-mutation-navigation';

const projection = buildSharedAlignmentProjection('ACGT', [
  { id: 'one', label: 'One', alignedReference: 'AC-GT', alignedQuery: 'ACTGA' },
  { id: 'two', label: 'Two', alignedReference: 'A--CGT', alignedQuery: 'ATT-GT' },
])!;
const axis = buildSharedSequenceAxis('ACGT', projection.coordinateSpace);
const focus = {
  documentId: 'ref',
  trackId: 'one',
  position: 5,
  highlightRange: { start: 4, end: 4 },
  timestamp: 1,
};

describe('alignment mutation navigation', () => {
  it('maps the source track into the shared columns and biological selection once', () => {
    expect(resolveAlignmentMutationNavigation(focus, 'ref', projection, axis)).toEqual({
      columnNavigation: {
        column: 6,
        requestId: 1,
        selection: { start: 6, end: 6 },
        biologicalSelection: { start: 3, end: 3 },
      },
      highlightRange: { start: 3, end: 3 },
      position: 4,
    });
  });

  it('retains gap-only insertions without selecting an unrelated reference base', () => {
    expect(
      resolveAlignmentMutationNavigation(
        { ...focus, position: 3, highlightRange: { start: 2, end: 2 } },
        'ref',
        projection,
        axis
      )
    ).toEqual({
      columnNavigation: {
        column: 4,
        requestId: 1,
        selection: { start: 4, end: 4 },
        biologicalSelection: null,
      },
      highlightRange: null,
      position: 2,
    });
  });

  it('maps each structural endpoint while preserving the complete selected range', () => {
    expect(
      resolveAlignmentMutationNavigation(
        { ...focus, position: 5, highlightRange: { start: 2, end: 4 } },
        'ref',
        projection,
        axis
      )
    ).toEqual({
      columnNavigation: {
        column: 6,
        requestId: 1,
        selection: { start: 4, end: 6 },
        biologicalSelection: { start: 2, end: 3 },
      },
      highlightRange: { start: 2, end: 3 },
      position: 4,
    });
  });

  it.each([
    { ...focus, trackId: 'hidden' },
    { ...focus, documentId: 'other' },
    { ...focus, position: 0 },
    { ...focus, position: 1.5 },
    { ...focus, highlightRange: { start: 4, end: 99 } },
  ])('rejects stale or invalid requests rather than guessing a base: %j', (request) => {
    expect(resolveAlignmentMutationNavigation(request, 'ref', projection, axis)).toBeNull();
  });
});

describe('alignment boundary columns', () => {
  it.each([
    {
      reference: 'AC',
      query: 'AT',
      position: 2,
      start: 1,
      end: 1,
      column: 1,
      bio: { start: 1, end: 1 },
      scroll: 2,
    },
    {
      reference: '--AC',
      query: 'TTAC',
      position: 2,
      start: 0,
      end: 1,
      column: 1,
      bio: null,
      scroll: 1,
    },
    {
      reference: 'AC--',
      query: 'ACTT',
      position: 4,
      start: 2,
      end: 3,
      column: 3,
      bio: null,
      scroll: 2,
    },
    {
      reference: 'A--C',
      query: 'ATT-',
      position: 4,
      start: 1,
      end: 3,
      column: 3,
      bio: { start: 1, end: 1 },
      scroll: 2,
    },
  ])(
    'preserves exact columns at reference boundaries: $reference',
    ({ reference, query, position, start, end, column, bio, scroll }) => {
      const projected = buildSharedAlignmentProjection('AC', [
        { id: 'query', label: 'Query', alignedReference: reference, alignedQuery: query },
      ])!;
      const result = resolveAlignmentMutationNavigation(
        {
          documentId: 'ref',
          trackId: 'query',
          position,
          highlightRange: { start, end },
          timestamp: 7,
        },
        'ref',
        projected,
        buildSharedSequenceAxis('AC', projected.coordinateSpace)
      );
      expect(result).toEqual({
        columnNavigation: {
          column,
          requestId: 7,
          selection: { start, end },
          biologicalSelection: bio,
        },
        highlightRange: bio,
        position: scroll,
      });
    }
  );
});
