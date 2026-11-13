import { describe, expect, it } from 'vitest';
import { cdsToProteinSpliced, parseGenBankFull, serializeGenBank } from '@waypoint/sequence-utils';
import { cleanSequenceFromEditorState, createInitialState, editorReducer } from './useEditorState';
import type { EditorAction } from '../types';

describe('scalar circular CDS interior insertion', () => {
  const strands: Array<1 | -1> = [1, -1];
  for (const direction of strands) {
    it(`expands scalar coding membership without adding segments on strand ${direction}`, () => {
      const qualifiers = {
        dnaforge_ann_id: ['33680036-0000-4000-8000-000000000002'],
        note: ['retained scalar template provenance'],
        transl_table: ['11'],
        codon_start: ['1'],
      };
      const initial = createInitialState('CCATGAAACCCC', [
        {
          id: 'scalar-template-feature',
          name: 'scalar template CDS',
          type: 'CDS',
          direction,
          start: 3,
          end: 8,
          qualifiers: { ...qualifiers, _locationString: ['3..8'] },
        },
      ]);
      const baseline = structuredClone(cleanSequenceFromEditorState(initial));
      expect(
        cdsToProteinSpliced(initial.annotations[0], initial.sequence, {
          sequenceLength: initial.sequence.length,
        })
      ).toBe(direction === 1 ? 'MK' : 'FH');
      const inserted = editorReducer(editorReducer(initial, { type: 'SET_CURSOR', position: 5 }), {
        type: 'INSERT',
        text: 'GGC',
      });
      const clean = cleanSequenceFromEditorState(inserted);
      expect(clean.sequence).toBe('CCATGGGCAAACCCC');
      expect(clean.annotations).toEqual([
        {
          ...initial.annotations[0],
          start: 3,
          end: 11,
          qualifiers,
        },
      ]);
      expect(clean.annotations[0].segments).toBeUndefined();
      expect(clean.annotations[0].qualifiers?._locationString).toBeUndefined();
      expect(clean.sequence.slice(2, 11)).toBe('ATGGGCAAA');
      expect(
        cdsToProteinSpliced(clean.annotations[0], clean.sequence, {
          sequenceLength: clean.sequence.length,
        })
      ).toBe(direction === 1 ? 'MGK' : 'FAH');
      const roundtrip = parseGenBankFull(
        serializeGenBank(
          {
            id: 'scalar-circular-template',
            name: 'scalar circular template',
            sequence: clean.sequence,
            length: clean.sequence.length,
            circular: true,
            annotations: clean.annotations,
          },
          { date: new Date('2026-01-01T00:00:00Z') }
        )
      );
      expect(roundtrip.sequence).toBe('CCATGGGCAAACCCC');
      expect(roundtrip.circular).toBe(true);
      expect(roundtrip.annotations[0]).toMatchObject({ start: 3, end: 11, direction });
      expect(roundtrip.annotations[0].segments).toBeUndefined();
      expect(roundtrip.annotations[0].qualifiers?.dnaforge_ann_id).toEqual(
        qualifiers.dnaforge_ann_id
      );
      expect(
        cdsToProteinSpliced(roundtrip.annotations[0], roundtrip.sequence, {
          sequenceLength: roundtrip.length,
        })
      ).toBe(direction === 1 ? 'MGK' : 'FAH');
      expect(cleanSequenceFromEditorState(initial)).toEqual(baseline);
      const undone = editorReducer(inserted, { type: 'UNDO' });
      expect(cleanSequenceFromEditorState(undone)).toEqual(baseline);
      expect(cleanSequenceFromEditorState(editorReducer(undone, { type: 'REDO' }))).toEqual(clean);
    });
  }
});

describe('circular template membership and pasted primer history', () => {
  const strands: Array<1 | -1> = [1, -1];
  for (const direction of strands) {
    for (const segmented of [false, true]) {
      const actions = [
        { type: 'INSERT', text: 'GGC' },
        {
          type: 'INSERT_FRAGMENT',
          fragment: {
            sequence: 'GGC',
            annotations: [],
            primerBindings: [{ primerId: 'gap-primer', start: 0, end: 3, strand: direction }],
          },
        },
      ] satisfies EditorAction[];
      for (const action of actions) {
        it(`${action.type} keeps outside primer bases out of the origin CDS through Undo and Redo on strand ${direction}, segments=${segmented}`, () => {
          const initial = createInitialState('AAACCCCCCATG', [
            {
              id: 'origin-template-feature',
              name: 'origin template CDS',
              type: 'CDS',
              direction,
              start: 10,
              end: 3,
              ...(segmented
                ? {
                    segments: [
                      { start: 10, end: 12 },
                      { start: 1, end: 3 },
                    ],
                  }
                : {}),
              qualifiers: {
                dnaforge_ann_id: ['33680031-0000-4000-8000-000000000002'],
                note: ['retained template provenance'],
                transl_table: ['11'],
                codon_start: ['1'],
              },
            },
          ]);
          const baseline = structuredClone(cleanSequenceFromEditorState(initial));
          const inserted = editorReducer(
            editorReducer(initial, { type: 'SET_CURSOR', position: 6 }),
            action
          );
          const clean = cleanSequenceFromEditorState(inserted);
          expect(clean.sequence).toBe('AAACCCGGCCCCATG');
          expect(clean.annotations).toEqual([
            {
              ...initial.annotations[0],
              start: 13,
              end: 3,
              ...(segmented
                ? {
                    segments: [
                      { start: 13, end: 15 },
                      { start: 1, end: 3 },
                    ],
                  }
                : {}),
            },
          ]);
          expect(clean.sequence.slice(12) + clean.sequence.slice(0, 3)).toBe('ATGAAA');
          if (action.type === 'INSERT_FRAGMENT') {
            expect(clean.pendingPrimerBindings).toHaveLength(1);
            expect(clean.pendingPrimerBindings).toMatchObject([
              { primerId: 'gap-primer', start: 6, end: 9, strand: direction },
            ]);
          } else expect(clean.pendingPrimerBindings).toEqual([]);
          expect(initial.sequence).toBe('AAACCCCCCATG');
          expect(cleanSequenceFromEditorState(initial)).toEqual(baseline);
          const undone = editorReducer(inserted, { type: 'UNDO' });
          expect(cleanSequenceFromEditorState(undone)).toEqual(baseline);
          expect(cleanSequenceFromEditorState(editorReducer(undone, { type: 'REDO' }))).toEqual(
            clean
          );
        });
      }
    }
  }
});

describe('joined annotation insertion through the editor', () => {
  for (const direction of [1, -1] as const) {
    for (const action of [
      { type: 'INSERT', text: 'GG' },
      {
        type: 'INSERT_FRAGMENT',
        fragment: { sequence: 'GG', annotations: [], primerBindings: [] },
      },
    ] satisfies EditorAction[]) {
      it(`${action.type} preserves joined membership, undo, redo and serialization on strand ${direction}`, () => {
        const initial = createInitialState('AAATGCCCCAAA', [
          {
            id: 'boundary-cds',
            name: 'boundary',
            type: 'CDS',
            direction,
            start: 3,
            end: 12,
            segments: [
              { start: 3, end: 5 },
              { start: 10, end: 12 },
            ],
            qualifiers: { note: ['retained'], transl_table: ['11'], codon_start: ['1'] },
          },
        ]);
        const positioned = editorReducer(initial, { type: 'SET_CURSOR', position: 2 });
        const inserted = editorReducer(positioned, action);
        const clean = cleanSequenceFromEditorState(inserted);
        expect(clean.sequence).toBe('AAGGATGCCCCAAA');
        expect(clean.annotations).toMatchObject([
          {
            id: 'boundary-cds',
            direction,
            start: 5,
            end: 14,
            segments: [
              { start: 5, end: 7 },
              { start: 12, end: 14 },
            ],
            qualifiers: initial.annotations[0]?.qualifiers,
          },
        ]);
        expect(inserted.insertedRanges).toEqual([{ start: 2, end: 4 }]);
        expect(initial.sequence).toBe('AAATGCCCCAAA');
        expect(initial.annotations[0]?.segments).toEqual([
          { start: 3, end: 5 },
          { start: 10, end: 12 },
        ]);
        const undone = editorReducer(inserted, { type: 'UNDO' });
        expect(cleanSequenceFromEditorState(undone)).toEqual(cleanSequenceFromEditorState(initial));
        expect(cleanSequenceFromEditorState(editorReducer(undone, { type: 'REDO' }))).toEqual(
          clean
        );
        const committed = editorReducer(inserted, { type: 'COMMIT' });
        expect(cleanSequenceFromEditorState(committed).annotations).toEqual(clean.annotations);
        const reopened = parseGenBankFull(
          serializeGenBank({
            id: 'boundary',
            name: 'boundary',
            length: clean.sequence.length,
            sequence: clean.sequence,
            circular: false,
            annotations: clean.annotations,
          })
        );
        expect(reopened.sequence).toBe(clean.sequence);
        expect(reopened.annotations[0]).toMatchObject({
          direction,
          start: 5,
          end: 14,
          segments: clean.annotations[0]?.segments,
        });
      });
    }
  }
});

describe('outside insertion and original-position restoration', () => {
  for (const direction of [1, -1] as const) {
    for (const segmented of [false, true]) {
      const annotations = [
        {
          id: 'partial',
          name: 'partial',
          type: 'CDS',
          start: 6,
          end: 7,
          direction,
          ...(segmented ? { segments: [{ start: 6, end: 7 }] } : {}),
          qualifiers: { note: ['retained'], codon_start: ['1'], transl_table: ['11'] },
        },
        { id: 'deleted', name: 'deleted', type: 'misc_feature', start: 7, end: 7, direction },
      ];
      it(`does not absorb trailing insertion without prior deletion (segmented=${segmented}, strand=${direction})`, () => {
        const initial = createInitialState('ACGTACGT', annotations);
        const inserted = editorReducer(
          editorReducer(initial, { type: 'SET_CURSOR', position: 7 }),
          { type: 'INSERT', text: 'NN' }
        );
        const clean = cleanSequenceFromEditorState(inserted);
        expect(clean.sequence).toBe('ACGTACGNNT');
        expect(clean.annotations).toEqual(initial.annotations);
        expect(clean.sequence.slice(5, 7)).toBe('CG');
      });
      for (const wrapped of [false, true]) {
        for (const fragment of [false, true]) {
          it(`keeps outside bases distinct from restored originals (segmented=${segmented}, strand=${direction}, wrapped=${wrapped}, fragment=${fragment})`, () => {
            const initial = createInitialState('ACGTACGT', annotations);
            const deleted = editorReducer(
              editorReducer(initial, { type: 'SET_SELECTION', selection: { start: 6, end: 6 } }),
              { type: 'DELETE_SELECTION' }
            );
            const positioned = editorReducer(
              deleted,
              wrapped
                ? { type: 'SET_SELECTION', selection: { start: 7, end: 1, wraps: true } }
                : { type: 'SET_CURSOR', position: 7 }
            );
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
            const partial = clean.annotations.find(({ id }) => id === 'partial');
            const identities = Array.from('ACGTACGT', (base, identity) => ({ base, identity }));
            const tokens = [
              ...identities.slice(0, 7),
              { base: 'N', identity: -1 },
              { base: 'N', identity: -2 },
              ...identities.slice(7),
            ];
            const removed = new Set(wrapped ? [6, 7, 0, 1] : [6]);
            const visible = tokens.filter(({ identity }) => !removed.has(identity));
            const survivingFeaturePositions = visible.flatMap(({ identity }, index) =>
              identity === 5 ? [index + 1] : []
            );
            expect(clean.sequence).toBe(visible.map(({ base }) => base).join(''));
            expect(survivingFeaturePositions).toEqual([wrapped ? 4 : 6]);
            expect(partial).toMatchObject({
              id: 'partial',
              start: survivingFeaturePositions[0],
              end: survivingFeaturePositions[0],
              direction,
              qualifiers: annotations[0]?.qualifiers,
            });
            expect(clean.annotations.find(({ id }) => id === 'deleted')).toBeUndefined();
            expect(inserted.annotations.find(({ id }) => id === 'deleted')).toEqual(
              initial.annotations[1]
            );
            const undone = editorReducer(inserted, { type: 'UNDO' });
            expect(cleanSequenceFromEditorState(undone).sequence).toBe(
              wrapped ? 'GTAC' : 'ACGTACT'
            );
            expect(cleanSequenceFromEditorState(editorReducer(undone, { type: 'REDO' }))).toEqual(
              clean
            );
            for (const text of ['G', 'T']) {
              const restored = editorReducer(
                editorReducer(inserted, { type: 'SET_CURSOR', position: 6 }),
                { type: 'INSERT', text }
              );
              expect(restored.sequence.length).toBe(inserted.sequence.length);
              expect(restored.annotations).toEqual(inserted.annotations);
              expect(restored.deletedRanges.some(({ start, end }) => start <= 6 && end > 6)).toBe(
                false
              );
              const restoredClean = cleanSequenceFromEditorState(restored);
              const restoredPartial = restoredClean.annotations.find(({ id }) => id === 'partial');
              expect(restoredPartial).toMatchObject({
                start: wrapped ? 4 : 6,
                end: wrapped ? 5 : 7,
                direction,
              });
              expect(restoredClean.sequence.slice(wrapped ? 3 : 5, wrapped ? 5 : 7)).toBe(
                `C${text}`
              );
              expect(restoredClean.annotations.find(({ id }) => id === 'deleted')).toMatchObject({
                start: wrapped ? 5 : 7,
                end: wrapped ? 5 : 7,
              });
              expect(restored.substitutedRanges).toEqual(
                text === 'G' ? [] : [{ start: 6, end: 7, original: 'G' }]
              );
              expect(
                cleanSequenceFromEditorState(editorReducer(restored, { type: 'UNDO' }))
              ).toEqual(clean);
              expect(
                cleanSequenceFromEditorState(
                  editorReducer(editorReducer(restored, { type: 'UNDO' }), { type: 'REDO' })
                )
              ).toEqual(restoredClean);
            }
          });
        }
      }
    }
  }
});

describe('circular high-arc insertion with unchanged outer bounds', () => {
  for (const direction of [1, -1] as const) {
    const actions = [
      { type: 'INSERT', text: 'GGC' },
      {
        type: 'INSERT_FRAGMENT',
        fragment: {
          sequence: 'GGC',
          annotations: [],
          primerBindings: [{ primerId: 'high-arc-primer', start: 0, end: 3, strand: direction }],
        },
      },
    ] satisfies EditorAction[];
    for (const action of actions) {
      it(`${action.type} extends the high segment and restores exact primer history on strand ${direction}`, () => {
        const initial = createInitialState('AAACCCCCCATG', [
          {
            id: 'high-arc-template-feature',
            name: 'high arc template CDS',
            type: 'CDS',
            direction,
            start: 10,
            end: 3,
            segments: [
              { start: 10, end: 12 },
              { start: 1, end: 3 },
            ],
            qualifiers: {
              dnaforge_ann_id: ['33680033-0000-4000-8000-000000000002'],
              note: ['retained high arc provenance'],
              transl_table: ['11'],
              codon_start: ['1'],
              _locationString: [
                direction === 1 ? 'join(10..12,1..3)' : 'complement(join(10..12,1..3))',
              ],
            },
          },
        ]);
        const baseline = structuredClone(cleanSequenceFromEditorState(initial));
        const inserted = editorReducer(
          editorReducer(initial, { type: 'SET_CURSOR', position: 10 }),
          action
        );
        const clean = cleanSequenceFromEditorState(inserted);
        expect(clean.sequence).toBe('AAACCCCCCAGGCTG');
        expect(clean.annotations).toEqual([
          {
            ...initial.annotations[0],
            start: 10,
            end: 3,
            segments: [
              { start: 10, end: 15 },
              { start: 1, end: 3 },
            ],
            qualifiers: {
              dnaforge_ann_id: ['33680033-0000-4000-8000-000000000002'],
              note: ['retained high arc provenance'],
              transl_table: ['11'],
              codon_start: ['1'],
            },
          },
        ]);
        const [annotation] = clean.annotations;
        if (!annotation) throw new Error('High-arc insertion removed the CDS');
        expect(
          annotation.segments
            ?.map(({ start, end }) => clean.sequence.slice(start - 1, end))
            .join('')
        ).toBe('AGGCTGAAA');
        expect(
          cdsToProteinSpliced(annotation, clean.sequence, { sequenceLength: clean.sequence.length })
        ).toBe(direction === 1 ? 'RLK' : 'FQP');
        if (action.type === 'INSERT_FRAGMENT')
          expect(clean.pendingPrimerBindings).toMatchObject([
            { primerId: 'high-arc-primer', start: 10, end: 13, strand: direction },
          ]);
        else expect(clean.pendingPrimerBindings).toEqual([]);
        const roundtrip = parseGenBankFull(
          serializeGenBank({
            id: 'high-arc',
            name: 'high-arc',
            sequence: clean.sequence,
            length: clean.sequence.length,
            circular: true,
            annotations: clean.annotations,
          })
        );
        expect(roundtrip.circular).toBe(true);
        expect(roundtrip.annotations[0]).toMatchObject({
          start: 10,
          end: 3,
          direction,
          segments: annotation.segments,
          qualifiers: annotation.qualifiers,
        });
        expect(
          cdsToProteinSpliced(roundtrip.annotations[0], roundtrip.sequence, {
            sequenceLength: roundtrip.length,
          })
        ).toBe(direction === 1 ? 'RLK' : 'FQP');
        expect(cleanSequenceFromEditorState(initial)).toEqual(baseline);
        const undone = editorReducer(inserted, { type: 'UNDO' });
        expect(cleanSequenceFromEditorState(undone)).toEqual(baseline);
        expect(cleanSequenceFromEditorState(editorReducer(undone, { type: 'REDO' }))).toEqual(
          clean
        );
      });
    }
  }
});
