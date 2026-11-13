import { describe, expect, it } from 'vitest';
import { parseGenBankFull, serializeGenBank } from '@waypoint/sequence-utils';
import type { EditorAction, EditorState, Selection } from '../types';
import { cleanSequenceFromEditorState, createInitialState, editorReducer } from './useEditorState';

function select(state: EditorState, selection: Selection): EditorState {
  return editorReducer(state, { type: 'SET_SELECTION', selection });
}

function insertAt(state: EditorState, position: number, text: string): EditorState {
  return editorReducer(editorReducer(state, { type: 'SET_CURSOR', position }), {
    type: 'INSERT',
    text,
  });
}

const deletionActions = [
  { type: 'DELETE_SELECTION' },
  { type: 'DELETE_BEFORE' },
  { type: 'DELETE_AFTER' },
] satisfies EditorAction[];

describe('circular selection mutation membership', () => {
  it.each(deletionActions)(
    '$type removes indices 8, 9, 0, 1 and retains indices 2 through 7',
    (action) => {
      const selected = select(createInitialState('ACGTTGCAAA'), {
        start: 8,
        end: 1,
        wraps: true,
      });
      const deleted = editorReducer(selected, action);

      expect(deleted.sequence).toBe('ACGTTGCAAA');
      expect(deleted.deletedRanges).toEqual([
        { start: 0, end: 2 },
        { start: 8, end: 10 },
      ]);
      expect(deleted.cursor).toBe(8);
      expect(deleted.selection).toBeNull();
      expect(cleanSequenceFromEditorState(deleted).sequence).toBe('GTTGCA');
      expect(editorReducer(deleted, { type: 'COMMIT' }).sequence).toBe('GTTGCA');

      const undone = editorReducer(deleted, { type: 'UNDO' });
      expect(cleanSequenceFromEditorState(undone).sequence).toBe('ACGTTGCAAA');
      expect(cleanSequenceFromEditorState(editorReducer(undone, { type: 'REDO' })).sequence).toBe(
        'GTTGCA'
      );
    }
  );

  it.each([1, 2, 5, 10])(
    'matches an independent biological-index complement for every forward arc of length %i',
    (length) => {
      const sequence = 'ACGTRYSWKM'.slice(0, length);
      for (let start = 0; start < length; start++) {
        for (let end = 0; end < length; end++) {
          const removed = new Set<number>();
          let position = start;
          for (;;) {
            removed.add(position);
            if (position === end) break;
            position = (position + 1) % length;
          }
          const expected = [...sequence].filter((_, index) => !removed.has(index)).join('');
          const deleted = editorReducer(
            select(createInitialState(sequence), {
              start,
              end,
              wraps: start > end,
            }),
            { type: 'DELETE_SELECTION' }
          );

          expect(cleanSequenceFromEditorState(deleted).sequence, `${start}..${end}`).toBe(expected);
          expect(editorReducer(deleted, { type: 'COMMIT' }).sequence, `${start}..${end}`).toBe(
            expected
          );
        }
      }
    }
  );

  it('keeps a backwards nonwrapping drag as an ordinary interval', () => {
    const deleted = editorReducer(
      select(createInitialState('ACGTTGCAAA'), {
        start: 8,
        end: 1,
      }),
      { type: 'DELETE_SELECTION' }
    );
    expect(cleanSequenceFromEditorState(deleted).sequence).toBe('AA');
    expect(deleted.cursor).toBe(1);
  });

  it('leaves an empty molecule unchanged without a selection', () => {
    const empty = createInitialState('');
    expect(editorReducer(empty, { type: 'DELETE_SELECTION' })).toBe(empty);
    expect(editorReducer(empty, { type: 'SELECT_ALL' })).toBe(empty);
  });

  it.each(['G', 'GG'])('replaces at the clockwise start of a wrapped selection with %s', (text) => {
    const selected = select(createInitialState('ACGTTGCAAA'), { start: 8, end: 1, wraps: true });
    const replaced = editorReducer(selected, { type: 'INSERT', text });
    expect(cleanSequenceFromEditorState(replaced).sequence).toBe(`GTTGCA${text}`);
    expect(editorReducer(replaced, { type: 'COMMIT' }).sequence).toBe(`GTTGCA${text}`);
  });

  it.each(['INSERT', 'INSERT_FRAGMENT'] as const)(
    '%s retains a multi-base replacement when wrapped deletion merges across its cursor',
    (type) => {
      const plain = createInitialState('ACGT');
      const insertedPrefix = insertAt(plain, 0, 'RY');
      const adjacentDeletion = editorReducer(
        select(createInitialState('ACGTACGT'), { start: 6, end: 6 }),
        { type: 'DELETE_SELECTION' }
      );
      const bridgingDeletion = editorReducer(
        select(createInitialState('ACGTACGT'), { start: 2, end: 6 }),
        { type: 'DELETE_SELECTION' }
      );
      const cases = [
        { state: plain, start: 3, end: 2, expected: 'NN' },
        { state: insertedPrefix, start: 3, end: 2, expected: 'NN' },
        { state: adjacentDeletion, start: 7, end: 1, expected: 'GTACNN' },
        { state: bridgingDeletion, start: 7, end: 1, expected: 'NN' },
      ];

      for (const { state, start, end, expected } of cases) {
        const selected = select(state, { start, end, wraps: true });
        const action: EditorAction =
          type === 'INSERT'
            ? { type, text: 'NN' }
            : { type, fragment: { sequence: 'NN', annotations: [], primerBindings: [] } };
        const replaced = editorReducer(selected, action);
        expect(
          cleanSequenceFromEditorState(replaced).sequence,
          `${state.sequence}:${start}..${end}`
        ).toBe(expected);
        expect(editorReducer(replaced, { type: 'COMMIT' }).sequence).toBe(expected);
        expect(
          cleanSequenceFromEditorState(
            editorReducer(editorReducer(replaced, { type: 'UNDO' }), { type: 'REDO' })
          ).sequence
        ).toBe(expected);
      }
    }
  );

  it('does not restore an earlier deleted annotation when replacing the next wrapped base', () => {
    const initial = createInitialState('ACGTACGT', [
      {
        id: 'previously-removed',
        name: 'previously-removed',
        type: 'misc_feature',
        start: 7,
        end: 7,
        direction: 1,
      },
    ]);
    const deleted = editorReducer(select(initial, { start: 6, end: 6 }), {
      type: 'DELETE_SELECTION',
    });
    expect(cleanSequenceFromEditorState(deleted).annotations).toEqual([]);

    const replaced = editorReducer(select(deleted, { start: 7, end: 1, wraps: true }), {
      type: 'INSERT',
      text: 'N',
    });
    expect(cleanSequenceFromEditorState(replaced).sequence).toBe('GTACN');
    expect(cleanSequenceFromEditorState(replaced).annotations).toEqual([]);
    expect(replaced.substitutedRanges).toEqual([{ start: 7, end: 8, original: 'T' }]);
    expect(
      cleanSequenceFromEditorState(
        editorReducer(editorReducer(replaced, { type: 'UNDO' }), { type: 'REDO' })
      )
    ).toEqual(cleanSequenceFromEditorState(replaced));
  });

  it('keeps inserted bases between existing soft-deleted spans through undo and redo', () => {
    const deleted = editorReducer(select(createInitialState('ACGT'), { start: 1, end: 2 }), {
      type: 'DELETE_SELECTION',
    });
    const inserted = insertAt(deleted, 2, 'NN');
    expect(inserted.sequence).toBe('ACNNGT');
    expect(inserted.deletedRanges).toEqual([
      { start: 1, end: 2 },
      { start: 4, end: 5 },
    ]);
    expect(inserted.insertedRanges).toEqual([{ start: 2, end: 4 }]);
    expect(cleanSequenceFromEditorState(inserted).sequence).toBe('ANNT');
    const undone = editorReducer(inserted, { type: 'UNDO' });
    expect(cleanSequenceFromEditorState(undone).sequence).toBe('AT');
    const redone = editorReducer(undone, { type: 'REDO' });
    expect(cleanSequenceFromEditorState(redone).sequence).toBe('ANNT');
    expect(redone.deletedRanges).toEqual(inserted.deletedRanges);
  });

  it.each([
    { wrapped: false, fragment: false },
    { wrapped: false, fragment: true },
    { wrapped: true, fragment: false },
    { wrapped: true, fragment: true },
  ])(
    'does not extend a wholly deleted annotation at the insertion boundary (wrapped=$wrapped, fragment=$fragment)',
    ({ wrapped, fragment }) => {
      const initial = createInitialState('ACGTACGT', [
        { name: 'deleted', type: 'misc_feature', start: 7, end: 7, direction: 1 },
        { name: 'partial', type: 'misc_feature', start: 6, end: 7, direction: 1 },
        { name: 'survivor', type: 'misc_feature', start: 3, end: 6, direction: 1 },
      ]);
      const deleted = editorReducer(select(initial, { start: 6, end: 6 }), {
        type: 'DELETE_SELECTION',
      });
      const positioned = wrapped
        ? select(deleted, { start: 7, end: 1, wraps: true })
        : editorReducer(deleted, { type: 'SET_CURSOR', position: 7 });
      const inserted = editorReducer(
        positioned,
        fragment
          ? {
              type: 'INSERT_FRAGMENT',
              fragment: { sequence: 'NN', annotations: [], primerBindings: [] },
            }
          : { type: 'INSERT', text: 'NN' }
      );
      const clean = cleanSequenceFromEditorState(inserted);
      expect(clean.sequence).toBe(wrapped ? 'GTACNN' : 'ACGTACNNT');
      expect(clean.annotations.map(({ name, start, end }) => ({ name, start, end }))).toEqual(
        wrapped
          ? [
              { name: 'partial', start: 4, end: 4 },
              { name: 'survivor', start: 1, end: 4 },
            ]
          : [
              { name: 'partial', start: 6, end: 6 },
              { name: 'survivor', start: 3, end: 6 },
            ]
      );
      expect(inserted.annotations.find(({ name }) => name === 'deleted')).toEqual(
        initial.annotations[0]
      );
      const undone = editorReducer(inserted, { type: 'UNDO' });
      expect(cleanSequenceFromEditorState(undone).sequence).toBe(wrapped ? 'GTAC' : 'ACGTACT');
      expect(undone.annotations).toEqual(initial.annotations);
      expect(cleanSequenceFromEditorState(editorReducer(undone, { type: 'REDO' }))).toEqual(clean);
      const restored = insertAt(inserted, 6, 'G');
      expect(cleanSequenceFromEditorState(restored).sequence).toBe(
        wrapped ? 'GTACGNN' : 'ACGTACGNNT'
      );
      expect(cleanSequenceFromEditorState(restored).annotations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'deleted',
            start: wrapped ? 5 : 7,
            end: wrapped ? 5 : 7,
          }),
        ])
      );
    }
  );

  it.each([1, -1] satisfies Array<1 | -1>)(
    'preserves deleted original feature membership through interior insertions and restoration on strand %i',
    (direction) => {
      const initial = createInitialState('ACGTACGT', [
        {
          name: 'deleted-interior',
          type: 'misc_feature',
          start: 3,
          end: 6,
          direction,
          qualifiers: { note: ['original bases only'], _locationString: ['3..6'] },
        },
      ]);
      const deleted = editorReducer(select(initial, { start: 2, end: 5 }), {
        type: 'DELETE_SELECTION',
      });
      const inserted = insertAt(deleted, 4, 'NN');
      expect(cleanSequenceFromEditorState(inserted).sequence).toBe('ACNNGT');
      expect(cleanSequenceFromEditorState(inserted).annotations).toEqual([]);
      expect(inserted.annotations).toEqual([
        {
          name: 'deleted-interior',
          type: 'misc_feature',
          start: 3,
          end: 8,
          direction,
          qualifiers: { note: ['original bases only'] },
          segments: [
            { start: 3, end: 4 },
            { start: 7, end: 8 },
          ],
        },
      ]);
      expect(editorReducer(inserted, { type: 'UNDO' }).annotations).toEqual(initial.annotations);
      expect(
        cleanSequenceFromEditorState(
          editorReducer(editorReducer(inserted, { type: 'UNDO' }), { type: 'REDO' })
        )
      ).toEqual(cleanSequenceFromEditorState(inserted));

      for (const { position, base, sequence, coordinate } of [
        { position: 2, base: 'G', sequence: 'ACGNNGT', coordinate: 3 },
        { position: 7, base: 'C', sequence: 'ACNNCGT', coordinate: 5 },
      ]) {
        const restored = insertAt(inserted, position, base);
        const clean = cleanSequenceFromEditorState(restored);
        expect(clean.sequence).toBe(sequence);
        expect(clean.annotations).toMatchObject([
          {
            start: coordinate,
            end: coordinate,
            direction,
            segments: [{ start: coordinate, end: coordinate }],
          },
        ]);
        const committed = editorReducer(restored, { type: 'COMMIT' });
        const parsed = parseGenBankFull(
          serializeGenBank({
            name: 'restored',
            sequence: committed.sequence,
            annotations: committed.annotations,
            circular: true,
          })
        );
        expect(parsed.annotations).toMatchObject([
          {
            name: 'deleted-interior',
            start: coordinate,
            end: coordinate,
            direction,
            qualifiers: { note: ['original bases only'] },
          },
        ]);
      }

      const repeated = insertAt(inserted, 5, 'TT');
      expect(cleanSequenceFromEditorState(repeated).sequence).toBe('ACNTTNGT');
      expect(cleanSequenceFromEditorState(repeated).annotations).toEqual([]);
      expect(repeated.annotations[0]?.segments).toEqual([
        { start: 3, end: 4 },
        { start: 9, end: 10 },
      ]);
      const restored = insertAt(insertAt(repeated, 2, 'G'), 9, 'C');
      const clean = cleanSequenceFromEditorState(restored);
      expect(clean.sequence).toBe('ACGNTTNCGT');
      expect(clean.annotations).toMatchObject([
        {
          start: 3,
          end: 8,
          direction,
          segments: [
            { start: 3, end: 3 },
            { start: 8, end: 8 },
          ],
        },
      ]);
      const parsed = parseGenBankFull(
        serializeGenBank({ name: 'joined-restoration', ...clean, circular: true })
      );
      expect(parsed.annotations).toMatchObject([
        {
          start: 3,
          end: 8,
          direction,
          segments: [
            { start: 3, end: 3 },
            { start: 8, end: 8 },
          ],
          qualifiers: { note: ['original bases only'] },
        },
      ]);
      expect(editorReducer(restored, { type: 'COMMIT' }).annotations).toEqual(clean.annotations);
      expect(
        cleanSequenceFromEditorState(
          editorReducer(editorReducer(repeated, { type: 'UNDO' }), { type: 'REDO' })
        )
      ).toEqual(cleanSequenceFromEditorState(repeated));
    }
  );

  it('replaces a wrapped selection with a fragment and projects its feature and primer coordinates', () => {
    const selected = select(createInitialState('ACGTTGCAAA'), { start: 8, end: 1, wraps: true });
    const replaced = editorReducer(selected, {
      type: 'INSERT_FRAGMENT',
      fragment: {
        sequence: 'GG',
        annotations: [
          { id: 'pasted', name: 'pasted', type: 'misc_feature', start: 1, end: 2, direction: 1 },
        ],
        primerBindings: [{ primerId: 'pasted-primer', start: 0, end: 2, strand: 1 }],
      },
    });
    const clean = cleanSequenceFromEditorState(replaced);
    expect(clean.sequence).toBe('GTTGCAGG');
    expect(clean.annotations).toMatchObject([{ id: 'pasted', start: 7, end: 8 }]);
    expect(clean.pendingPrimerBindings).toEqual([
      { primerId: 'pasted-primer', start: 6, end: 8, strand: 1, pendingId: expect.any(String) },
    ]);
    const undone = editorReducer(replaced, { type: 'UNDO' });
    expect(cleanSequenceFromEditorState(undone).sequence).toBe('GTTGCA');
    expect(cleanSequenceFromEditorState(editorReducer(undone, { type: 'REDO' }))).toEqual(clean);
  });

  it('remaps the replacement cursor after physically removing inserted bases on both sides of the origin', () => {
    const leading = insertAt(createInitialState('ACGTTGCAAA'), 0, 'TT');
    const trailing = insertAt(leading, leading.sequence.length, 'CC');
    const selected = select(trailing, { start: 10, end: 3, wraps: true });
    const deleted = editorReducer(selected, { type: 'DELETE_SELECTION' });
    expect(deleted.sequence).toBe('ACGTTGCAAA');
    expect(deleted.cursor).toBe(8);
    expect(deleted.insertedRanges).toEqual([]);
    expect(cleanSequenceFromEditorState(deleted).sequence).toBe('GTTGCA');
    const replaced = editorReducer(selected, { type: 'INSERT', text: 'GG' });
    expect(cleanSequenceFromEditorState(replaced).sequence).toBe('GTTGCAGG');
  });

  it('keeps an earlier soft deletion and substitution while removing the selected origin bases', () => {
    const positioned = editorReducer(createInitialState('ACGTTGCAAA'), {
      type: 'SET_CURSOR',
      position: 4,
    });
    const substituted = editorReducer(editorReducer(positioned, { type: 'DELETE_AFTER' }), {
      type: 'INSERT',
      text: 'C',
    });
    const withDeletion = editorReducer(
      editorReducer(substituted, { type: 'SET_CURSOR', position: 0 }),
      { type: 'DELETE_AFTER' }
    );
    const deleted = editorReducer(select(withDeletion, { start: 8, end: 1, wraps: true }), {
      type: 'DELETE_SELECTION',
    });
    expect(cleanSequenceFromEditorState(deleted).sequence).toBe('GTCGCA');
    expect(deleted.substitutedRanges).toEqual([{ start: 4, end: 5, original: 'T' }]);
    expect(deleted.deletedRanges).toEqual([
      { start: 0, end: 2 },
      { start: 8, end: 10 },
    ]);
  });

  it('removes features on both selected origin arms and preserves the interior feature', () => {
    const initial = createInitialState('ACGTTGCAAA', [
      { id: 'low', name: 'low', type: 'misc_feature', start: 1, end: 2, direction: 1 },
      {
        id: 'middle',
        name: 'middle',
        type: 'misc_feature',
        start: 3,
        end: 8,
        direction: -1,
        qualifiers: { note: ['retained'] },
      },
      { id: 'high', name: 'high', type: 'misc_feature', start: 9, end: 10, direction: 1 },
    ]);
    const deleted = editorReducer(select(initial, { start: 8, end: 1, wraps: true }), {
      type: 'DELETE_SELECTION',
    });
    expect(cleanSequenceFromEditorState(deleted).annotations).toEqual([
      {
        id: 'middle',
        name: 'middle',
        type: 'misc_feature',
        start: 1,
        end: 6,
        direction: -1,
        qualifiers: { note: ['retained'] },
      },
    ]);
  });

  it('preserves a surviving pasted primer binding through wrapped deletion and redo', () => {
    const pasted = editorReducer(
      editorReducer(createInitialState('ACGTTGCAAA'), { type: 'SET_CURSOR', position: 5 }),
      {
        type: 'INSERT_FRAGMENT',
        fragment: {
          sequence: 'CC',
          annotations: [],
          primerBindings: [{ primerId: 'interior', start: 0, end: 2, strand: -1 }],
        },
      }
    );
    const deleted = editorReducer(select(pasted, { start: 10, end: 1, wraps: true }), {
      type: 'DELETE_SELECTION',
    });
    expect(cleanSequenceFromEditorState(deleted).sequence).toBe('GTTCCGCA');
    expect(cleanSequenceFromEditorState(deleted).pendingPrimerBindings).toEqual([
      { primerId: 'interior', start: 3, end: 5, strand: -1, pendingId: expect.any(String) },
    ]);
    const redone = editorReducer(editorReducer(deleted, { type: 'UNDO' }), { type: 'REDO' });
    expect(cleanSequenceFromEditorState(redone)).toEqual(cleanSequenceFromEditorState(deleted));
  });
});
