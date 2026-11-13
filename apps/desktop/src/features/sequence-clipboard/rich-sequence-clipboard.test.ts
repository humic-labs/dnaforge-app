// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  parseGenBankFull,
  reverseComplement,
  serializeGenBank,
  type Annotation,
} from '@waypoint/sequence-utils';
import {
  cleanSequenceFromEditorState,
  createInitialState,
  editorReducer,
} from '@waypoint/workspace-editor';
import {
  buildRichSequenceFragmentFromSelection,
  extractDesignAnnotationsForRange,
  richSequenceFragmentForEditor,
} from './rich-sequence-clipboard';

const sourceAnnotation: Annotation = {
  name: 'copied feature',
  type: 'misc_feature',
  start: 6,
  end: 10,
  direction: 1,
  qualifiers: { note: ['preserve me'] },
};

describe('buildRichSequenceFragmentFromSelection', () => {
  it('builds one fragment carrying relative annotations and only complete primer bindings', () => {
    const sourceSequence = 'AACCGGTTAACCGGTTAA';

    const result = buildRichSequenceFragmentFromSelection({
      sourceId: '/workspace/source.gb',
      sourceName: 'source.gb',
      sourceSequence,
      sourceAnnotations: [sourceAnnotation],
      sourcePrimerBindings: [
        {
          primerId: 'primer-complete',
          bindingStart: 6,
          bindingEnd: 10,
          strand: 1,
        },
        {
          primerId: 'primer-clipped',
          bindingStart: 2,
          bindingEnd: 8,
          strand: -1,
        },
      ],
      sourceWorkspaceRoot: '/workspace',
      range: { start: 4, end: 14 },
      orientation: 'forward',
    });

    expect(result.clipboardSequence).toBe(sourceSequence.slice(4, 14));
    expect(result.fragment.annotations).toEqual([
      expect.objectContaining({ start: 1, end: 6, name: 'copied feature' }),
    ]);
    expect(result.fragment.primerBindings).toEqual([
      {
        primerId: 'primer-complete',
        start: 2,
        end: 6,
        strand: 1,
      },
    ]);
    expect(result.fragment.sourceWorkspaceRoot).toBe('/workspace');
  });

  it('reorients annotations and primer bindings with the reverse-complement copy', () => {
    const sourceSequence = 'AACCGGTTAACCGGTTAA';

    const result = buildRichSequenceFragmentFromSelection({
      sourceId: '/workspace/source.gb',
      sourceName: 'source.gb',
      sourceSequence,
      sourceAnnotations: [sourceAnnotation],
      sourcePrimerBindings: [
        {
          primerId: 'primer-complete',
          bindingStart: 6,
          bindingEnd: 10,
          strand: 1,
        },
      ],
      range: { start: 4, end: 14 },
      orientation: 'reverse-complement',
    });

    expect(result.clipboardSequence).toBe(reverseComplement(sourceSequence.slice(4, 14)));
    expect(result.fragment.annotations).toEqual([
      expect.objectContaining({ start: 4, end: 9, strand: 'reverse' }),
    ]);
    expect(result.fragment.primerBindings).toEqual([
      {
        primerId: 'primer-complete',
        start: 4,
        end: 8,
        strand: -1,
      },
    ]);
  });
});

it('clips joined features to retained exons and excludes an intron-only selection', () => {
  const annotation: Annotation = {
    name: 'spliced',
    type: 'CDS',
    start: 10,
    end: 40,
    direction: 1,
    segments: [
      { start: 10, end: 20 },
      { start: 31, end: 40 },
    ],
  };
  expect(extractDesignAnnotationsForRange([annotation], { start: 20, end: 32 }, 100)).toEqual([
    {
      name: 'spliced',
      type: 'CDS',
      start: 10,
      end: 12,
      strand: 'forward',
      color: undefined,
      segments: [{ start: 10, end: 12 }],
    },
  ]);
  expect(extractDesignAnnotationsForRange([annotation], { start: 20, end: 30 }, 100)).toEqual([]);
});

function pastedFeatures(
  annotation: Annotation,
  orientation: 'forward' | 'reverse-complement' = 'forward'
) {
  const sourceSequence = 'A'.repeat(100);
  const copied = buildRichSequenceFragmentFromSelection({
    sourceId: 'source',
    sourceName: 'Source',
    sourceSequence,
    sourceAnnotations: [annotation],
    sourceIsCircular: true,
    range: { start: 0, end: sourceSequence.length },
    orientation,
  });
  const cursor = editorReducer(createInitialState('GG'), { type: 'SET_CURSOR', position: 1 });
  const pasted = editorReducer(cursor, {
    type: 'INSERT_FRAGMENT',
    fragment: richSequenceFragmentForEditor(copied.fragment),
  });
  const clean = cleanSequenceFromEditorState(pasted);
  const expectedBases = `G${(orientation === 'forward' ? 'A' : 'T').repeat(100)}G`;
  expect(clean.sequence).toBe(expectedBases);
  const saved = parseGenBankFull(
    serializeGenBank({
      id: 'target',
      name: 'Target',
      sequence: clean.sequence,
      length: 102,
      circular: false,
      annotations: clean.annotations,
    })
  );
  expect(saved.sequence).toBe(expectedBases);
  expect(saved.length).toBe(102);
  return { pasted, saved };
}

it('saves each copied circular-origin piece at its actual target coordinates', () => {
  const { pasted, saved } = pastedFeatures({
    name: 'origin',
    type: 'rep_origin',
    start: 96,
    end: 8,
    direction: 1,
    segments: [
      { start: 96, end: 100 },
      { start: 1, end: 8 },
    ],
    qualifiers: {
      _locationString: ['join(96..100,1..8)'],
      direction: ['RIGHT'],
      note: ['retain origin'],
      dnaforge_ann_id: ['source-feature'],
    },
  });
  expect(
    saved.annotations.map(({ name, type, start, end, direction, qualifiers }) => ({
      name,
      type,
      start,
      end,
      direction,
      note: qualifiers?.note,
    }))
  ).toEqual([
    { name: 'origin', type: 'rep_origin', start: 2, end: 9, direction: 1, note: ['retain origin'] },
    {
      name: 'origin',
      type: 'rep_origin',
      start: 97,
      end: 101,
      direction: 1,
      note: ['retain origin'],
    },
  ]);
  expect(pasted.annotations.every((annotation) => !annotation.qualifiers?.dnaforge_ann_id)).toBe(
    true
  );
});

it.each([
  [
    'forward',
    1,
    [
      { start: 11, end: 21 },
      { start: 32, end: 41 },
    ],
  ],
  [
    'reverse-complement',
    -1,
    [
      { start: 62, end: 71 },
      { start: 82, end: 92 },
    ],
  ],
] as const)(
  'retains joined feature segments through %s copy, offset paste and Save',
  (orientation, direction, expectedSegments) => {
    const { pasted, saved } = pastedFeatures(
      {
        name: 'spliced',
        type: 'CDS',
        start: 10,
        end: 40,
        direction: 1,
        segments: [
          { start: 10, end: 20 },
          { start: 31, end: 40 },
        ],
        qualifiers: {
          _locationString: ['join(10..20,31..40)'],
          note: ['retain intron'],
          dnaforge_ann_id: ['source-feature'],
        },
      },
      orientation
    );
    expect(saved.annotations).toHaveLength(1);
    expect(saved.annotations[0]).toMatchObject({
      name: 'spliced',
      type: 'CDS',
      direction,
      segments: expectedSegments,
      qualifiers: { note: ['retain intron'] },
    });
    expect(pasted.annotations[0]?.qualifiers?.dnaforge_ann_id).toBeUndefined();
  }
);
