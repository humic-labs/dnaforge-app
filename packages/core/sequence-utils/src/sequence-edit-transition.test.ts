import { describe, expect, it } from 'vitest';

import { deriveSequenceEditTransition } from './sequence-edit-transition';

describe('deriveSequenceEditTransition', () => {
  it('emits no operations for an unchanged exact baseline', () => {
    expect(
      deriveSequenceEditTransition({
        baselineSequence: 'ACGT',
        draftSequence: 'ACGT',
        cleanSequence: 'ACGT',
        insertedRanges: [],
        deletedRanges: [],
        substitutedRanges: [],
      })
    ).toEqual({
      beforeLength: 4,
      afterLength: 4,
      operations: [],
    });
  });

  it('records an insertion at its immutable-baseline coordinate', () => {
    expect(
      deriveSequenceEditTransition({
        baselineSequence: 'ACGT',
        draftSequence: 'ATTCGT',
        cleanSequence: 'ATTCGT',
        insertedRanges: [{ start: 1, end: 3 }],
        deletedRanges: [],
        substitutedRanges: [],
      })
    ).toEqual({
      beforeLength: 4,
      afterLength: 6,
      operations: [{ kind: 'insert', at: 1, length: 2 }],
    });
  });

  it('records a soft deletion without copying deleted bases into the event', () => {
    expect(
      deriveSequenceEditTransition({
        baselineSequence: 'AACCGG',
        draftSequence: 'AACCGG',
        cleanSequence: 'AAGG',
        insertedRanges: [],
        deletedRanges: [{ start: 2, end: 4 }],
        substitutedRanges: [],
      })
    ).toEqual({
      beforeLength: 6,
      afterLength: 4,
      operations: [{ kind: 'delete', start: 2, end: 4 }],
    });
  });

  it('records equal-length substitutions only after checking retained originals', () => {
    expect(
      deriveSequenceEditTransition({
        baselineSequence: 'AACCGG',
        draftSequence: 'AATTGG',
        cleanSequence: 'AATTGG',
        insertedRanges: [],
        deletedRanges: [],
        substitutedRanges: [{ start: 2, end: 4, original: 'CC' }],
      })
    ).toEqual({
      beforeLength: 6,
      afterLength: 6,
      operations: [{ kind: 'substitute', start: 2, end: 4 }],
    });
  });

  it('preserves operation order when an insertion splits a substituted span', () => {
    expect(
      deriveSequenceEditTransition({
        baselineSequence: 'AACCGG',
        draftSequence: 'AATGTGG',
        cleanSequence: 'AATGTGG',
        insertedRanges: [{ start: 3, end: 4 }],
        deletedRanges: [],
        substitutedRanges: [
          { start: 2, end: 3, original: 'C' },
          { start: 4, end: 5, original: 'C' },
        ],
      })
    ).toEqual({
      beforeLength: 6,
      afterLength: 7,
      operations: [
        { kind: 'substitute', start: 2, end: 3 },
        { kind: 'insert', at: 3, length: 1 },
        { kind: 'substitute', start: 3, end: 4 },
      ],
    });
  });

  it('lets a later deletion win over overlapping substitution provenance', () => {
    expect(
      deriveSequenceEditTransition({
        baselineSequence: 'AACCGG',
        draftSequence: 'AATTGG',
        cleanSequence: 'AATGG',
        insertedRanges: [],
        deletedRanges: [{ start: 2, end: 3 }],
        substitutedRanges: [{ start: 2, end: 4, original: 'CC' }],
      }).operations
    ).toEqual([
      { kind: 'delete', start: 2, end: 3 },
      { kind: 'substitute', start: 3, end: 4 },
    ]);
  });

  it('rejects an unmarked draft difference', () => {
    expect(() =>
      deriveSequenceEditTransition({
        baselineSequence: 'ACGT',
        draftSequence: 'AGGT',
        cleanSequence: 'AGGT',
        insertedRanges: [],
        deletedRanges: [],
        substitutedRanges: [],
      })
    ).toThrow(/baseline mismatch/i);
  });

  it('rejects a substitution whose retained original is stale', () => {
    expect(() =>
      deriveSequenceEditTransition({
        baselineSequence: 'ACGT',
        draftSequence: 'ATGT',
        cleanSequence: 'ATGT',
        insertedRanges: [],
        deletedRanges: [],
        substitutedRanges: [{ start: 1, end: 2, original: 'A' }],
      })
    ).toThrow(/baseline mismatch/i);
  });

  it('rejects inserted characters that also claim substitution provenance', () => {
    expect(() =>
      deriveSequenceEditTransition({
        baselineSequence: 'ACGT',
        draftSequence: 'ATCGT',
        cleanSequence: 'ATCGT',
        insertedRanges: [{ start: 1, end: 2 }],
        deletedRanges: [],
        substitutedRanges: [{ start: 1, end: 2, original: 'C' }],
      })
    ).toThrow(/overlap/i);
  });

  it('rejects a clean save projection that the markers cannot replay', () => {
    expect(() =>
      deriveSequenceEditTransition({
        baselineSequence: 'AACCGG',
        draftSequence: 'AACCGG',
        cleanSequence: 'AACGG',
        insertedRanges: [],
        deletedRanges: [{ start: 2, end: 4 }],
        substitutedRanges: [],
      })
    ).toThrow(/clean sequence mismatch/i);
  });

  it('rejects non-canonical and out-of-bounds marker ranges', () => {
    expect(() =>
      deriveSequenceEditTransition({
        baselineSequence: 'ACGT',
        draftSequence: 'ACGT',
        cleanSequence: 'ACGT',
        insertedRanges: [
          { start: 2, end: 3 },
          { start: 1, end: 2 },
        ],
        deletedRanges: [],
        substitutedRanges: [],
      })
    ).toThrow(/canonical order/i);

    expect(() =>
      deriveSequenceEditTransition({
        baselineSequence: 'ACGT',
        draftSequence: 'ACGT',
        cleanSequence: 'ACGT',
        insertedRanges: [],
        deletedRanges: [{ start: 3, end: 5 }],
        substitutedRanges: [],
      })
    ).toThrow(/bounds/i);
  });
});
