import { describe, it, expect } from 'vitest';
import {
  adjustAnnotationsForInsert,
  adjustAnnotationsForDelete,
  createInitialState,
  editorReducer,
  hasUncommittedSequenceEdits,
  cleanSequenceFromEditorState,
} from './useEditorState';
import type { Annotation } from '@waypoint/sequence-utils';
import type { EditorState } from '../types';

function makeSplicedCDS(
  segments: Array<{ start: number; end: number }>,
  qualifiers: Record<string, string[]> = {}
): Annotation {
  return {
    name: 'test_cds',
    type: 'CDS',
    start: Math.min(...segments.map((s) => s.start)),
    end: Math.max(...segments.map((s) => s.end)),
    direction: 1,
    segments,
    qualifiers: { _locationString: ['join(mock)'], ...qualifiers },
  };
}

describe('adjustAnnotationsForInsert — segment remapping', () => {
  it('shifts all segments when insert is before all segments', () => {
    const cds = makeSplicedCDS([
      { start: 10, end: 20 },
      { start: 30, end: 40 },
    ]);

    const result = adjustAnnotationsForInsert([cds], 0, 5);

    expect(result[0].segments).toEqual([
      { start: 15, end: 25 },
      { start: 35, end: 45 },
    ]);
    expect(result[0].qualifiers?._locationString).toBeUndefined();
  });

  it('extends segment when insert falls within a segment', () => {
    const cds = makeSplicedCDS([
      { start: 10, end: 20 },
      { start: 30, end: 40 },
    ]);

    const result = adjustAnnotationsForInsert([cds], 15, 3);

    expect(result[0].segments).toEqual([
      { start: 10, end: 23 },
      { start: 33, end: 43 },
    ]);
  });

  it('shifts later segments when insert falls in intron region', () => {
    const cds = makeSplicedCDS([
      { start: 10, end: 20 },
      { start: 30, end: 40 },
    ]);

    const result = adjustAnnotationsForInsert([cds], 25, 2);

    expect(result[0].segments).toEqual([
      { start: 10, end: 20 },
      { start: 32, end: 42 },
    ]);
  });

  it('clears _locationString on any segment modification', () => {
    const cds = makeSplicedCDS(
      [
        { start: 10, end: 20 },
        { start: 30, end: 40 },
      ],
      { _locationString: ['join(10..20,30..40)'] }
    );

    const result = adjustAnnotationsForInsert([cds], 0, 5);

    expect(result[0].qualifiers?._locationString).toBeUndefined();
  });
});

describe('adjustAnnotationsForDelete — segment remapping', () => {
  it('shrinks segment when delete is within a segment', () => {
    const cds = makeSplicedCDS([
      { start: 10, end: 20 },
      { start: 30, end: 40 },
    ]);

    const result = adjustAnnotationsForDelete([cds], 12, 15);

    expect(result[0].segments).toEqual([
      { start: 10, end: 17 },
      { start: 27, end: 37 },
    ]);
  });

  it('removes entire segment when delete covers it completely', () => {
    const cds = makeSplicedCDS([
      { start: 10, end: 20 },
      { start: 30, end: 40 },
      { start: 50, end: 60 },
    ]);

    const result = adjustAnnotationsForDelete([cds], 29, 40);

    expect(result[0].segments).toEqual([
      { start: 10, end: 20 },
      { start: 39, end: 49 },
    ]);
  });

  it('handles delete spanning intron + exon boundary', () => {
    const cds = makeSplicedCDS([
      { start: 10, end: 20 },
      { start: 30, end: 40 },
    ]);

    const result = adjustAnnotationsForDelete([cds], 18, 32);

    expect(result[0].segments).toBeDefined();
    expect(result[0].segments![0].end).toBeLessThanOrEqual(18);
    expect(result[0].segments!.length).toBeGreaterThanOrEqual(1);
  });
});

type Ranges = Pick<EditorState, 'insertedRanges' | 'deletedRanges' | 'substitutedRanges'>;
const emptyRanges = (): Ranges => ({
  insertedRanges: [],
  deletedRanges: [],
  substitutedRanges: [],
});

describe('hasUncommittedSequenceEdits  pending-edit predicate)', () => {
  it('is false for a clean editor state', () => {
    expect(hasUncommittedSequenceEdits(createInitialState('ATCGATCG'))).toBe(false);
    expect(hasUncommittedSequenceEdits(emptyRanges())).toBe(false);
  });

  it('is true with only inserted bases', () => {
    expect(
      hasUncommittedSequenceEdits({ ...emptyRanges(), insertedRanges: [{ start: 0, end: 1 }] })
    ).toBe(true);
  });

  it('is true with only deleted bases', () => {
    expect(
      hasUncommittedSequenceEdits({ ...emptyRanges(), deletedRanges: [{ start: 0, end: 1 }] })
    ).toBe(true);
  });

  it('is true with only SUBSTITUTED bases (substitution save-loss regression guard)', () => {
    expect(
      hasUncommittedSequenceEdits({
        ...emptyRanges(),
        substitutedRanges: [{ start: 0, end: 1, original: 'A' }],
      })
    ).toBe(true);
  });

  it('reflects a real reducer edit: clean → false, after typing a base → true', () => {
    const initial = createInitialState('ATCGATCG');
    expect(hasUncommittedSequenceEdits(initial)).toBe(false);
    const afterType = editorReducer(initial, { type: 'INSERT', text: 'G' });
    expect(hasUncommittedSequenceEdits(afterType)).toBe(true);
  });
});

function substituteAt(state: EditorState, position: number, replacement: string): EditorState {
  const positioned = editorReducer(state, { type: 'SET_CURSOR', position });
  const deleted = editorReducer(positioned, { type: 'DELETE_AFTER' });
  return editorReducer(deleted, { type: 'INSERT', text: replacement });
}

describe('substituted range coordinate integrity ', () => {
  it('shifts a substituted span when a later insertion lands before it', () => {
    const substituted = substituteAt(substituteAt(createInitialState('AACCGG'), 2, 'T'), 3, 'T');
    expect(substituted.substitutedRanges).toEqual([{ start: 2, end: 4, original: 'CC' }]);

    const inserted = editorReducer(
      editorReducer(substituted, { type: 'SET_CURSOR', position: 1 }),
      { type: 'INSERT', text: 'G' }
    );

    expect(inserted.substitutedRanges).toEqual([{ start: 3, end: 5, original: 'CC' }]);
  });

  it('splits a substituted span when a later insertion lands inside it', () => {
    const substituted = substituteAt(substituteAt(createInitialState('AACCGG'), 2, 'T'), 3, 'T');

    const inserted = editorReducer(
      editorReducer(substituted, { type: 'SET_CURSOR', position: 3 }),
      { type: 'INSERT', text: 'G' }
    );

    expect(inserted.substitutedRanges).toEqual([
      { start: 2, end: 3, original: 'C' },
      { start: 4, end: 5, original: 'C' },
    ]);
  });

  it('shifts substituted spans back when an earlier inserted base is removed', () => {
    const withInsertion = editorReducer(
      editorReducer(createInitialState('AACCGG'), { type: 'SET_CURSOR', position: 1 }),
      { type: 'INSERT', text: 'T' }
    );
    const substituted = substituteAt(substituteAt(withInsertion, 3, 'T'), 4, 'T');
    expect(substituted.substitutedRanges).toEqual([{ start: 3, end: 5, original: 'CC' }]);

    const removedInsertion = editorReducer(
      editorReducer(substituted, { type: 'SET_CURSOR', position: 2 }),
      { type: 'DELETE_BEFORE' }
    );

    expect(removedInsertion.substitutedRanges).toEqual([{ start: 2, end: 4, original: 'CC' }]);
    const undone = editorReducer(removedInsertion, { type: 'UNDO' });
    expect(undone.substitutedRanges).toEqual([{ start: 3, end: 5, original: 'CC' }]);
    const redone = editorReducer(undone, { type: 'REDO' });
    expect(redone.substitutedRanges).toEqual([{ start: 2, end: 4, original: 'CC' }]);
  });
});

describe('selection replacement history', () => {
  it.each(['bases', 'rich fragment'] as const)(
    'restores the complete original sequence with one undo after replacing with %s',
    (kind) => {
      const initial = createInitialState('AAAACCCC', [
        { name: 'original', type: 'misc_feature', start: 5, end: 8, direction: 1 },
      ]);
      const selected = editorReducer(initial, {
        type: 'SET_SELECTION',
        selection: { start: 2, end: 4 },
      });
      const replaced = editorReducer(
        selected,
        kind === 'bases'
          ? { type: 'INSERT', text: 'TG' }
          : {
              type: 'INSERT_FRAGMENT',
              fragment: {
                sequence: 'TG',
                annotations: [
                  { name: 'pasted', type: 'misc_feature', start: 1, end: 2, direction: 1 },
                ],
                primerBindings: [{ primerId: 'primer-a', start: 0, end: 2, strand: 1 }],
              },
            }
      );
      expect(cleanSequenceFromEditorState(replaced).sequence).toBe('AATGCCC');
      expect(replaced.historyIndex).toBe(1);
      const undone = editorReducer(replaced, { type: 'UNDO' });
      expect(cleanSequenceFromEditorState(undone)).toEqual({
        sequence: 'AAAACCCC',
        annotations: initial.annotations,
        pendingPrimerBindings: [],
      });
      expect(undone.insertedRanges).toEqual([]);
      expect(undone.deletedRanges).toEqual([]);
      expect(undone.substitutedRanges).toEqual([]);
      const redone = editorReducer(undone, { type: 'REDO' });
      expect(cleanSequenceFromEditorState(redone)).toEqual(cleanSequenceFromEditorState(replaced));
      expect(redone.insertedRanges).toEqual(replaced.insertedRanges);
      expect(redone.deletedRanges).toEqual(replaced.deletedRanges);
      expect(redone.substitutedRanges).toEqual(replaced.substitutedRanges);
    }
  );
});

describe('INSERT_FRAGMENT rich sequence paste', () => {
  it('inserts bases, annotations, and staged primer bindings as one undoable edit', () => {
    const initial = editorReducer(createInitialState('AAAA'), {
      type: 'SET_CURSOR',
      position: 2,
    });

    const pasted = editorReducer(initial, {
      type: 'INSERT_FRAGMENT',
      fragment: {
        sequence: 'CG',
        annotations: [
          {
            name: 'copied feature',
            type: 'misc_feature',
            start: 1,
            end: 2,
            direction: 1,
          },
        ],
        primerBindings: [
          {
            primerId: 'primer-1',
            start: 0,
            end: 2,
            strand: 1,
            sourceWorkspaceRoot: '/workspace',
          },
        ],
      },
    });

    expect(pasted.sequence).toBe('AACGAA');
    expect(pasted.annotations).toContainEqual(
      expect.objectContaining({ name: 'copied feature', start: 3, end: 4 })
    );
    expect(pasted.pendingPrimerBindings).toEqual([
      {
        pendingId: expect.any(String),
        primerId: 'primer-1',
        start: 2,
        end: 4,
        strand: 1,
        sourceWorkspaceRoot: '/workspace',
      },
    ]);

    const undone = editorReducer(pasted, { type: 'UNDO' });
    expect(undone.sequence).toBe('AAAA');
    expect(undone.pendingPrimerBindings).toEqual([]);

    const redone = editorReducer(undone, { type: 'REDO' });
    expect(redone.sequence).toBe('AACGAA');
    expect(redone.pendingPrimerBindings).toHaveLength(1);
    expect(redone.pendingPrimerBindings[0]?.pendingId).toBe(
      pasted.pendingPrimerBindings[0]?.pendingId
    );

    const discarded = editorReducer(redone, { type: 'DISCARD' });
    expect(discarded.sequence).toBe('AAAA');
    expect(discarded.pendingPrimerBindings).toEqual([]);
  });

  it('drops a staged primer binding if a later edit changes its binding interval', () => {
    const pasted = editorReducer(createInitialState('AAAA'), {
      type: 'INSERT_FRAGMENT',
      fragment: {
        sequence: 'CG',
        annotations: [],
        primerBindings: [{ primerId: 'primer-1', start: 0, end: 2, strand: 1 }],
      },
    });
    const insideBinding = editorReducer(
      editorReducer(pasted, { type: 'SET_CURSOR', position: 1 }),
      { type: 'INSERT', text: 'T' }
    );

    expect(insideBinding.pendingPrimerBindings).toEqual([]);
  });
});

describe('SET_ANNOTATIONS annotation-level edit', () => {
  it('replaces annotations, keeps the bases, and records one undoable history entry', () => {
    const initial = createInitialState('ATCGATCG', [
      { name: 'gene', type: 'CDS', start: 1, end: 4, direction: 1 },
    ]);
    const renamed = [{ ...initial.annotations[0], name: 'renamed' }];
    const edited = editorReducer(initial, { type: 'SET_ANNOTATIONS', annotations: renamed });

    expect(edited.sequence).toBe('ATCGATCG');
    expect(edited.annotations).toBe(renamed);
    expect(edited.isDirty).toBe(true);
    expect(edited.historyIndex).toBe(1);
    expect(hasUncommittedSequenceEdits(edited)).toBe(false);

    const undone = editorReducer(edited, { type: 'UNDO' });
    expect(undone.annotations[0].name).toBe('gene');
    const redone = editorReducer(undone, { type: 'REDO' });
    expect(redone.annotations[0].name).toBe('renamed');
  });

  it('is a no-op for the same annotations reference', () => {
    const initial = createInitialState('ATCG', []);
    expect(
      editorReducer(initial, { type: 'SET_ANNOTATIONS', annotations: initial.annotations })
    ).toBe(initial);
  });

  it('composes with a pending insertion: the stretched annotation is what gets renamed', () => {
    const initial = createInitialState('AAAACCCCGGGG', [
      { name: 'cc', type: 'misc_feature', start: 5, end: 8, direction: 1 },
    ]);
    const withCursor = editorReducer(initial, { type: 'SET_CURSOR', position: 6 });
    const inserted = editorReducer(withCursor, { type: 'INSERT', text: 'TT' });
    expect(inserted.sequence).toBe('AAAACCTTCCGGGG');
    expect(inserted.annotations[0]).toMatchObject({ start: 5, end: 10 });

    const renamed = editorReducer(inserted, {
      type: 'SET_ANNOTATIONS',
      annotations: [{ ...inserted.annotations[0], name: 'cc-renamed' }],
    });
    expect(renamed.annotations[0]).toMatchObject({ name: 'cc-renamed', start: 5, end: 10 });
    expect(renamed.insertedRanges).toEqual([{ start: 6, end: 8 }]);
    expect(hasUncommittedSequenceEdits(renamed)).toBe(true);
  });
});

describe('typing into RNA and DNA documents', () => {
  it('stores uracil in an RNA document whichever of T or U is typed', () => {
    const rna = createInitialState('AUGC', [], 'rna');
    const typedT = editorReducer(editorReducer(rna, { type: 'SET_CURSOR', position: 4 }), {
      type: 'INSERT',
      text: 't',
    });
    expect(typedT.sequence).toBe('AUGCU');
    const typedU = editorReducer(rna, { type: 'INSERT', text: 'U' });
    expect(typedU.sequence).not.toMatch(/T/i);
  });

  it('keeps DNA typing unchanged, mapping U to T', () => {
    const dna = createInitialState('ATGC');
    const typed = editorReducer(editorReducer(dna, { type: 'SET_CURSOR', position: 4 }), {
      type: 'INSERT',
      text: 'u',
    });
    expect(typed.sequence).toBe('ATGCT');
    expect(dna.nucleicAcid).toBe('dna');
  });

  it('pastes a DNA fragment into an RNA document as RNA', () => {
    const rna = createInitialState('AUGC', [], 'rna');
    const pasted = editorReducer(editorReducer(rna, { type: 'SET_CURSOR', position: 4 }), {
      type: 'INSERT',
      text: 'GATTACA',
    });
    expect(pasted.sequence).toBe('AUGCGAUUACA');
  });

  it('keeps the nucleic acid through a reset', () => {
    const rna = createInitialState('AUGC', [], 'rna');
    const reset = editorReducer(rna, { type: 'RESET', sequence: 'GGCC', annotations: [] });
    expect(reset.nucleicAcid).toBe('rna');
  });
});

it('preserves a pasted binding identity through shifts and undo while assigning a fresh identity to another paste', () => {
  const fragment = {
    sequence: 'AA',
    annotations: [],
    primerBindings: [{ primerId: 'primer-identity', start: 0, end: 2, strand: 1 as const }],
  };
  const pasted = editorReducer(createInitialState('ATGC'), { type: 'INSERT_FRAGMENT', fragment });
  const originalId = pasted.pendingPrimerBindings[0]?.pendingId;
  expect(originalId).toEqual(expect.any(String));
  const shifted = editorReducer(editorReducer(pasted, { type: 'SET_CURSOR', position: 0 }), {
    type: 'INSERT',
    text: 'CC',
  });
  expect(shifted.pendingPrimerBindings[0]).toEqual({
    ...pasted.pendingPrimerBindings[0],
    start: 2,
    end: 4,
  });
  const undone = editorReducer(shifted, { type: 'UNDO' });
  expect(undone.pendingPrimerBindings[0]?.pendingId).toBe(originalId);
  const repeated = editorReducer(undone, { type: 'INSERT_FRAGMENT', fragment });
  expect(repeated.pendingPrimerBindings).toHaveLength(2);
  expect(repeated.pendingPrimerBindings[1]?.pendingId).not.toBe(originalId);
});
