import { describe, expect, it } from 'vitest';
import {
  adjustAnnotationsForInsert,
  mapAnnotationThroughSequenceEditTransition,
} from './annotation-coordinate-edit';
import { parseGenBankFull } from './parsers/genbank';
import { serializeGenBank } from './writers/genbank';
import { cdsToProteinSpliced } from './translation';
import type { AnnotatedSequence, Annotation } from './types';

const directions = [1, -1] as const;
const shapes = [
  [{ start: 3, end: 5 }],
  [
    { start: 3, end: 5 },
    { start: 10, end: 12 },
  ],
  [
    { start: 3, end: 5 },
    { start: 6, end: 8 },
  ],
  [
    { start: 3, end: 5 },
    { start: 7, end: 9 },
  ],
  [
    { start: 3, end: 6 },
    { start: 6, end: 9 },
  ],
  [
    { start: 3, end: 7 },
    { start: 5, end: 9 },
  ],
  [
    { start: 3, end: 5 },
    { start: 100, end: 102 },
  ],
  [
    { start: 3, end: 5 },
    { start: 3, end: 5 },
    { start: 10, end: 12 },
  ],
];

function feature(segments: NonNullable<Annotation['segments']>, direction: 1 | -1): Annotation {
  return {
    name: 'boundary CDS',
    type: 'CDS',
    direction,
    start: Math.min(...segments.map((segment) => segment.start)),
    end: Math.max(...segments.map((segment) => segment.end)),
    segments,
    qualifiers: {
      dnaforge_ann_id: ['38390002-0000-4000-8000-000000000002'],
      note: ['retained'],
      transl_table: ['11'],
      codon_start: ['1'],
    },
  };
}

function positions(segment: { start: number; end: number }): number[] {
  return Array.from({ length: segment.end - segment.start + 1 }, (_, i) => segment.start - 1 + i);
}

describe('annotation insertion endpoint affinity', () => {
  for (const direction of directions) {
    it(`preserves the literal joined CDS and native-format roundtrip on strand ${direction}`, () => {
      const sequence = 'AAATGCCCCAAA';
      const annotation = feature(
        [
          { start: 3, end: 5 },
          { start: 10, end: 12 },
        ],
        direction
      );
      annotation.qualifiers = {
        ...annotation.qualifiers,
        _locationString: [direction === 1 ? 'join(3..5,10..12)' : 'complement(join(3..5,10..12))'],
      };
      const original = structuredClone(annotation);
      const [edited] = adjustAnnotationsForInsert([annotation], 2, 2);
      expect(edited).toBeDefined();
      if (!edited) throw new Error('Insertion removed the CDS');
      expect(edited).toMatchObject({
        start: 5,
        end: 14,
        segments: [
          { start: 5, end: 7 },
          { start: 12, end: 14 },
        ],
        direction,
      });
      expect(edited.qualifiers).toEqual({
        dnaforge_ann_id: ['38390002-0000-4000-8000-000000000002'],
        note: ['retained'],
        transl_table: ['11'],
        codon_start: ['1'],
      });
      const editedSequence = 'AAGGATGCCCCAAA';
      expect(
        edited.segments
          ?.flatMap(positions)
          .map((index) => editedSequence[index])
          .join('')
      ).toBe('ATGAAA');
      expect(cdsToProteinSpliced(edited, editedSequence)).toBe(direction === 1 ? 'MK' : 'FH');
      expect(cdsToProteinSpliced(annotation, sequence)).toBe(direction === 1 ? 'MK' : 'FH');
      const document: AnnotatedSequence = {
        id: 'boundary',
        length: editedSequence.length,
        name: 'boundary',
        sequence: editedSequence,
        circular: false,
        annotations: [edited],
      };
      const output = serializeGenBank(document);
      expect(output).toContain('join(5..7,12..14)');
      const reopened = parseGenBankFull(output).annotations.find((item) => item.type === 'CDS');
      expect(reopened).toMatchObject({ start: 5, end: 14, direction, segments: edited.segments });
      expect(reopened?.qualifiers).toMatchObject(edited.qualifiers ?? {});
      expect(annotation).toEqual(original);
      expect(
        mapAnnotationThroughSequenceEditTransition(annotation, {
          beforeLength: 12,
          afterLength: 14,
          operations: [{ kind: 'insert', at: 2, length: 2 }],
        }).annotation
      ).toEqual(edited);
    });
    for (const segments of shapes) {
      for (const at of new Set(
        segments.flatMap(({ start, end }) => [start - 1, start, end - 1, end])
      )) {
        it(`maps ordered residue membership ${JSON.stringify(segments)} at ${at} on strand ${direction}`, () => {
          const annotation = feature(segments, direction);
          const original = structuredClone(annotation);
          const [edited] = adjustAnnotationsForInsert([annotation], at, 2);
          const expected = segments.map((segment) => {
            const oldPositions = positions(segment);
            const newPositions = oldPositions.map((index) => (index < at ? index : index + 2));
            if (oldPositions.includes(at - 1) && oldPositions.includes(at))
              newPositions.push(at, at + 1);
            return newPositions.sort((left, right) => left - right);
          });
          expect(edited?.segments?.map(positions)).toEqual(expected);
          expect(edited).toMatchObject({
            direction,
            qualifiers: annotation.qualifiers,
            start: Math.min(...expected.flat()) + 1,
            end: Math.max(...expected.flat()) + 1,
          });
          expect(annotation).toEqual(original);
          expect(adjustAnnotationsForInsert([annotation], at, 0)[0]).toEqual(annotation);
        });
      }
    }
    it(`keeps scalar and equivalent one-segment outer endpoints and interiors identical on strand ${direction}`, () => {
      const joined = feature([{ start: 3, end: 5 }], direction);
      const { segments: _, ...scalar } = joined;
      for (const at of [0, 1, 2, 3, 4, 5, 6, 7]) {
        const [range] = adjustAnnotationsForInsert([scalar], at, 2);
        const [segmented] = adjustAnnotationsForInsert([joined], at, 2);
        expect(segmented?.segments).toEqual([{ start: range?.start, end: range?.end }]);
        const transition = {
          beforeLength: 12,
          afterLength: 14,
          operations: [{ kind: 'insert' as const, at, length: 2 }],
        };
        expect(mapAnnotationThroughSequenceEditTransition(scalar, transition).annotation).toEqual(
          range
        );
        expect(mapAnnotationThroughSequenceEditTransition(joined, transition).annotation).toEqual(
          segmented
        );
        expect(adjustAnnotationsForInsert([{ ...scalar, segments: [] }], at, 2)[0]).toEqual({
          ...range,
          segments: [],
        });
      }
      expect(adjustAnnotationsForInsert([scalar], 5, 2)[0]).toBe(scalar);
      expect(adjustAnnotationsForInsert([joined], 5, 2)[0]).toMatchObject({
        start: 3,
        end: 5,
        segments: [{ start: 3, end: 5 }],
      });
    });
  }
  it('preserves the internal junction of touching segments instead of flattening it', () => {
    const joined = feature(
      [
        { start: 3, end: 5 },
        { start: 6, end: 8 },
      ],
      1
    );
    const { segments: _, ...scalar } = joined;
    const [edited] = adjustAnnotationsForInsert([joined], 5, 2);
    expect(edited?.segments).toEqual([
      { start: 3, end: 5 },
      { start: 8, end: 10 },
    ]);
    expect(edited?.segments?.flatMap(positions)).toEqual([2, 3, 4, 7, 8, 9]);
    expect(adjustAnnotationsForInsert([scalar], 5, 2)[0]).toMatchObject({ start: 3, end: 10 });
  });
  it('maps an internal segment even when the scalar envelope is stale', () => {
    const joined = {
      ...feature(
        [
          { start: 3, end: 5 },
          { start: 10, end: 12 },
        ],
        1
      ),
      end: 5,
    };
    expect(adjustAnnotationsForInsert([joined], 9, 2)[0]).toMatchObject({
      start: 3,
      end: 14,
      segments: [
        { start: 3, end: 5 },
        { start: 12, end: 14 },
      ],
    });
  });
  it('retains location fidelity at an unchanged outer trailing boundary', () => {
    const joined = feature(
      [
        { start: 3, end: 5 },
        { start: 10, end: 12 },
      ],
      1
    );
    joined.qualifiers = { ...joined.qualifiers, _locationString: ['join(3..5,10..12)'] };
    expect(adjustAnnotationsForInsert([joined], 12, 2)[0]).toBe(joined);
  });
  it('retains exact source fidelity and identity for zero-length insertion', () => {
    const annotation = feature(
      [
        { start: 3, end: 5 },
        { start: 10, end: 12 },
      ],
      1
    );
    annotation.qualifiers = { ...annotation.qualifiers, _locationString: ['join(3..5,10..12)'] };
    expect(adjustAnnotationsForInsert([annotation], 2, 0)[0]).toBe(annotation);
  });
});

describe('origin-spanning annotation insertion membership', () => {
  const sequence = 'AAACCCCCCATG';
  const scenarios = [
    { label: 'unannotated gap', position: 6, start: 13, dna: 'ATGAAA', proteins: ['MK', 'FH'] },
    {
      label: 'low-coordinate trailing edge',
      position: 3,
      start: 13,
      dna: 'ATGAAA',
      proteins: ['MK', 'FH'],
    },
    {
      label: 'high-coordinate leading edge',
      position: 9,
      start: 13,
      dna: 'ATGAAA',
      proteins: ['MK', 'FH'],
    },
    {
      label: 'high-coordinate interior',
      position: 10,
      start: 10,
      dna: 'AGGCTGAAA',
      proteins: ['RLK', 'FQP'],
    },
  ];
  for (const direction of directions) {
    for (const segmented of [false, true]) {
      for (const scenario of scenarios) {
        it(`preserves circular ${scenario.label} bases and GenBank material on strand ${direction}, segments=${segmented}`, () => {
          const location = 'join(10..12,1..3)';
          const annotation: Annotation = {
            name: 'origin CDS',
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
              dnaforge_ann_id: ['33680031-0000-4000-8000-000000000001'],
              note: ['retained origin membership'],
              transl_table: ['11'],
              codon_start: ['1'],
              _locationString: [direction === 1 ? location : `complement(${location})`],
            },
          };
          const original = structuredClone(annotation);
          const inserted =
            sequence.slice(0, scenario.position) + 'GGC' + sequence.slice(scenario.position);
          const [edited] = adjustAnnotationsForInsert(
            [annotation],
            scenario.position,
            3,
            sequence.length
          );
          expect(edited).toBeDefined();
          if (!edited) throw new Error('Insertion removed the origin-spanning CDS');
          expect(edited).toMatchObject({ start: scenario.start, end: 3, direction });
          expect(edited.qualifiers).toEqual({
            dnaforge_ann_id: ['33680031-0000-4000-8000-000000000001'],
            note: ['retained origin membership'],
            transl_table: ['11'],
            codon_start: ['1'],
          });
          const expectedSegments = [
            { start: scenario.start, end: inserted.length },
            { start: 1, end: 3 },
          ];
          const segments = edited.segments ?? [
            { start: edited.start, end: inserted.length },
            { start: 1, end: edited.end },
          ];
          expect(segments).toEqual(expectedSegments);
          expect(segments.map(({ start, end }) => inserted.slice(start - 1, end)).join('')).toBe(
            scenario.dna
          );
          expect(cdsToProteinSpliced(edited, inserted, { sequenceLength: inserted.length })).toBe(
            scenario.proteins[direction === 1 ? 0 : 1]
          );
          expect(annotation).toEqual(original);
          if (segmented) {
            const product = serializeGenBank({
              id: 'origin-membership',
              name: 'origin membership',
              sequence: inserted,
              length: inserted.length,
              circular: true,
              annotations: [edited],
            });
            const expectedLocation = `join(${scenario.start}..${inserted.length},1..3)`;
            expect(product).toContain(
              direction === 1 ? expectedLocation : `complement(${expectedLocation})`
            );
            const reopened = parseGenBankFull(product);
            expect(reopened.sequence).toBe(inserted);
            expect(reopened.circular).toBe(true);
            const feature = reopened.annotations[0];
            expect(feature).toBeDefined();
            if (!feature) throw new Error('GenBank roundtrip lost the origin-spanning CDS');
            expect(feature.segments).toEqual(expectedSegments);
            expect(feature.qualifiers?.dnaforge_ann_id).toEqual([
              '33680031-0000-4000-8000-000000000001',
            ]);
            expect(
              cdsToProteinSpliced(feature, reopened.sequence, { sequenceLength: reopened.length })
            ).toBe(scenario.proteins[direction === 1 ? 0 : 1]);
          }
        });
      }
    }
  }
});
