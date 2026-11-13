// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { applyMutationsToSequence } from './apply-mutations';
import { cdsToProteinSpliced } from '@waypoint/sequence-utils';
import type { Mutation } from '../types';
import type { Annotation } from '@waypoint/workspace-editor';

function makeMutation(
  overrides: Partial<Mutation> & Pick<Mutation, 'id' | 'position' | 'type'>
): Mutation {
  return {
    referenceBase: '',
    alternateBase: '',
    length: 1,
    ...overrides,
  };
}

function makeAnnotation(
  overrides: Partial<Annotation> & Pick<Annotation, 'start' | 'end'>
): Annotation {
  return {
    name: 'test',
    type: 'CDS',
    direction: 1,
    qualifiers: {},
    ...overrides,
  };
}

describe('applyMutationsToSequence', () => {
  it('applies a substitution', () => {
    const sequence = 'ATCGATCG';
    const mutations: Mutation[] = [
      makeMutation({
        id: 'mut-0',
        position: 3,
        type: 'substitution',
        referenceBase: 'C',
        alternateBase: 'T',
        length: 1,
      }),
    ];
    const result = applyMutationsToSequence(sequence, [], mutations);
    expect(result.sequence).toBe('ATTGATCG');
  });

  it('applies an insertion', () => {
    const sequence = 'ATCGATCG';
    const mutations: Mutation[] = [
      makeMutation({
        id: 'mut-0',
        position: 4,
        type: 'insertion',
        referenceBase: '',
        alternateBase: 'NNN',
        length: 3,
      }),
    ];
    const result = applyMutationsToSequence(sequence, [], mutations);
    expect(result.sequence).toBe('ATCNNNGATCG');
  });

  it('applies a deletion', () => {
    const sequence = 'ATCGATCG';
    const mutations: Mutation[] = [
      makeMutation({
        id: 'mut-0',
        position: 3,
        type: 'deletion',
        referenceBase: 'CG',
        alternateBase: '',
        length: 2,
      }),
    ];
    const result = applyMutationsToSequence(sequence, [], mutations);
    expect(result.sequence).toBe('ATATCG');
  });

  it('applies multiple mutations in correct order (reverse position)', () => {
    const sequence = 'ATCGATCG';
    const mutations: Mutation[] = [
      makeMutation({
        id: 'mut-0',
        position: 2,
        type: 'substitution',
        referenceBase: 'T',
        alternateBase: 'G',
        length: 1,
      }),
      makeMutation({
        id: 'mut-1',
        position: 7,
        type: 'substitution',
        referenceBase: 'C',
        alternateBase: 'A',
        length: 1,
      }),
    ];
    const result = applyMutationsToSequence(sequence, [], mutations);
    expect(result.sequence).toBe('AGCGATAG');
  });

  it('shifts annotations downstream of insertion', () => {
    const sequence = 'ATCGATCG';
    const annotations: Annotation[] = [makeAnnotation({ start: 5, end: 8 })];
    const mutations: Mutation[] = [
      makeMutation({
        id: 'mut-0',
        position: 2,
        type: 'insertion',
        alternateBase: 'NNN',
        length: 3,
      }),
    ];
    const result = applyMutationsToSequence(sequence, annotations, mutations);
    expect(result.annotations[0].start).toBe(8);
    expect(result.annotations[0].end).toBe(11);
  });

  it('removes annotation entirely within deletion', () => {
    const sequence = 'ATCGATCGATCG';
    const annotations: Annotation[] = [makeAnnotation({ start: 4, end: 6 })];
    const mutations: Mutation[] = [
      makeMutation({
        id: 'mut-0',
        position: 3,
        type: 'deletion',
        referenceBase: 'CGAT',
        length: 4,
      }),
    ];
    const result = applyMutationsToSequence(sequence, annotations, mutations);
    expect(result.annotations).toHaveLength(0);
  });

  it('handles empty mutation list', () => {
    const sequence = 'ATCGATCG';
    const annotations: Annotation[] = [makeAnnotation({ start: 1, end: 4 })];
    const result = applyMutationsToSequence(sequence, annotations, []);
    expect(result.sequence).toBe(sequence);
    expect(result.annotations).toEqual(annotations);
  });

  it('applies mixed substitution + insertion + deletion', () => {
    const sequence = 'ATCGATCGATCG';
    const mutations: Mutation[] = [
      makeMutation({
        id: 'mut-sub',
        position: 2,
        type: 'substitution',
        referenceBase: 'T',
        alternateBase: 'G',
        length: 1,
      }),
      makeMutation({
        id: 'mut-ins',
        position: 6,
        type: 'insertion',
        alternateBase: 'NN',
        length: 2,
      }),
      makeMutation({
        id: 'mut-del',
        position: 10,
        type: 'deletion',
        referenceBase: 'TC',
        length: 2,
      }),
    ];
    const result = applyMutationsToSequence(sequence, [], mutations);
    expect(result.sequence).toBe('AGCGANNTCGAG');
  });
});

describe('circular mutation insertion membership', () => {
  for (const direction of [1, -1] as const) {
    for (const insertion of [
      {
        at: 6,
        start: 13,
        dna: 'ATGAAA',
        forward: 'MK',
        reverse: 'FH',
        sequence: 'AAACCCGGCCCCATG',
      },
      {
        at: 10,
        start: 10,
        dna: 'AGGCTGAAA',
        forward: 'RLK',
        reverse: 'FQP',
        sequence: 'AAACCCCCCAGGCTG',
      },
    ]) {
      it(`retains circular CDS membership at ${insertion.at} on strand ${direction}`, () => {
        const annotation = makeAnnotation({
          start: 10,
          end: 3,
          direction,
          segments: [
            { start: 10, end: 12 },
            { start: 1, end: 3 },
          ],
          qualifiers: {
            dnaforge_ann_id: ['38390002-0000-4000-8000-000000000005'],
            note: ['retained circular template'],
            codon_start: ['1'],
            transl_table: ['11'],
            _locationString: [
              direction === 1 ? 'join(10..12,1..3)' : 'complement(join(10..12,1..3))',
            ],
          },
        });
        const annotations = [annotation];
        const mutations = [
          makeMutation({
            id: 'circular-insertion',
            position: insertion.at + 1,
            type: 'insertion',
            alternateBase: 'GGC',
            length: 3,
          }),
        ];
        const original = structuredClone({ annotations, mutations });
        const result = applyMutationsToSequence('AAACCCCCCATG', annotations, mutations);
        expect(result.sequence).toBe(insertion.sequence);
        expect(result.annotations).toEqual([
          {
            ...annotation,
            start: insertion.start,
            segments: [
              { start: insertion.start, end: 15 },
              { start: 1, end: 3 },
            ],
            qualifiers: {
              dnaforge_ann_id: ['38390002-0000-4000-8000-000000000005'],
              note: ['retained circular template'],
              codon_start: ['1'],
              transl_table: ['11'],
            },
          },
        ]);
        const [edited] = result.annotations;
        if (!edited) throw new Error('Mutation removed the CDS');
        expect(
          edited.segments?.map(({ start, end }) => result.sequence.slice(start - 1, end)).join('')
        ).toBe(insertion.dna);
        expect(cdsToProteinSpliced(edited, result.sequence)).toBe(
          direction === 1 ? insertion.forward : insertion.reverse
        );
        expect({ annotations, mutations }).toEqual(original);
      });
    }
  }
});
