import { describe, expect, it } from 'vitest';
import type { AnnotatedSequence, Annotation } from '@waypoint/sequence-utils';
import type { Mutation } from '../types';
import { buildMutationProteinContext } from './mutation-protein-context';

const cds: Annotation = {
  id: 'cds',
  name: 'reporter',
  type: 'CDS',
  start: 1,
  end: 12,
  direction: 1,
};
const reference = {
  name: 'clone design',
  sequence: 'ATGAAAGGTTAA',
  annotations: [cds],
  circular: false,
} as AnnotatedSequence;
const mutation: Mutation = {
  id: 'mut-5-A-G',
  position: 5,
  type: 'substitution',
  referenceBase: 'A',
  alternateBase: 'G',
  length: 1,
};
const build = (sequence = reference, change = mutation) =>
  buildMutationProteinContext({
    sequence,
    mutation: change,
    documentId: 'seq:clone-design',
    trackId: 'clone-7',
    trackLabel: 'Clone 7',
  });

describe('clone mutation to reference protein context', () => {
  it('uses the translated CDS identity and biological residue, not an alignment column', () => {
    const result = build();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.request.translation).toBe('MKG');
    expect(result.selections[0].target).toMatchObject({
      moleculeId: result.request.residueMolecule?.moleculeId,
      coordinateSystem: 'residue',
      intervals: [{ start: 1, end: 1 }],
    });
    expect(result.selections[0].mappings).toContainEqual(
      expect.objectContaining({
        kind: 'coding-dna',
        referenceId: 'seq:clone-design',
        intervals: [{ start: 3, end: 5 }],
      })
    );
    expect(result.request.variantContext).toMatchObject({
      trackLabel: 'Clone 7',
      position: 5,
      referenceBase: 'A',
      alternateBase: 'G',
      residueIndices: [1],
    });
  });

  it('maps the reverse strand in protein order', () => {
    const result = build(
      { ...reference, sequence: 'TTAACCTTTCAT', annotations: [{ ...cds, direction: -1 }] },
      {
        ...mutation,
        position: 8,
        referenceBase: 'T',
        alternateBase: 'C',
      }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.request.translation).toBe('MKG');
    expect(result.selections[0].target.intervals).toEqual([{ start: 1, end: 1 }]);
    expect(result.selections[0].mappings[0]).toMatchObject({
      strand: -1,
      intervals: [{ start: 6, end: 8 }],
    });
  });

  it('respects the coding frame and does not interpret a preceding partial codon', () => {
    const seq = {
      ...reference,
      sequence: 'AATGAAAGGTTAA',
      annotations: [{ ...cds, end: 13, qualifiers: { codon_start: ['2'] } }],
    };
    const result = build(seq, { ...mutation, position: 6 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.selections[0].target.intervals).toEqual([{ start: 1, end: 1 }]);
    expect(build(seq, { ...mutation, position: 1 }).ok).toBe(false);
  });

  it('refuses evidence whose reference allele no longer matches the open sequence', () => {
    expect(build({ ...reference, sequence: 'ATGACAGGTTAA' })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/reference.*changed|no longer matches/i),
    });
  });

  it('refuses a protein qualifier that disagrees with the current coding DNA', () => {
    expect(
      build({ ...reference, annotations: [{ ...cds, qualifiers: { translation: ['MRA'] } }] })
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/translation.*disagree/i),
    });
  });

  it('retains explicitly normalized bacterial initiators from the structure request', () => {
    const result = build(
      { ...reference, sequence: 'GTGAAAGGTTAA' },
      { ...mutation, position: 1, referenceBase: 'G', alternateBase: 'A' }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.request.translation).toBe('MKG');
    expect(result.request.variantContext?.residueIndices).toEqual([0]);
  });

  it('keeps an alternate bacterial start as methionine in the displayed consequence and product', () => {
    const result = build(
      { ...reference, annotations: [{ ...cds, qualifiers: { transl_table: ['11'] } }] },
      { ...mutation, position: 1, referenceBase: 'A', alternateBase: 'G' }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.request.variantContext).toMatchObject({
      proteinEffect: 'synonymous',
      changes: [{ residue: 1, reference: 'M', alternate: 'M' }],
      product: { status: 'complete', sequence: 'MKG' },
    });
  });

  it('does not choose one of two overlapping coding features by display name', () => {
    expect(
      build({ ...reference, annotations: [cds, { ...cds, id: 'other', name: 'other protein' }] })
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/more than one|multiple/i),
    });
  });

  it('keeps noncoding changes out of protein projection', () => {
    expect(build({ ...reference, annotations: [] })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/coding/i),
    });
  });

  it('retains every affected reference residue for a multi-base substitution', () => {
    const result = build(reference, {
      ...mutation,
      position: 6,
      referenceBase: 'AG',
      alternateBase: 'TC',
      length: 2,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.request.variantContext?.residueIndices).toEqual([1, 2]);
  });

  it('does not turn an annotated stop codon into a structural residue', () => {
    expect(
      build(reference, { ...mutation, position: 10, referenceBase: 'T', alternateBase: 'C' })
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/stop|protein residue/i),
    });
  });

  it('selects both exon pieces of a split codon without selecting the intron', () => {
    const seq = {
      ...reference,
      sequence: 'ATGACCCAAGGTTAA',
      annotations: [
        {
          ...cds,
          end: 15,
          segments: [
            { start: 1, end: 4 },
            { start: 8, end: 15 },
          ],
        },
      ],
    };
    const result = build(seq, { ...mutation, position: 8 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.request.translation).toBe('MKG');
    expect(result.selections[0].target.intervals).toEqual([{ start: 1, end: 1 }]);
    expect(result.selections[0].mappings[0].intervals).toEqual([
      { start: 3, end: 3 },
      { start: 7, end: 8 },
    ]);
    expect(build(seq, { ...mutation, position: 6, referenceBase: 'C' }).ok).toBe(false);
  });

  it('maps an origin-spanning circular codon as one protein residue', () => {
    const result = build(
      {
        ...reference,
        circular: true,
        sequence: 'GAAAGGTTAAAT',
        annotations: [{ ...cds, start: 11, end: 10 }],
      },
      { ...mutation, position: 1, referenceBase: 'G', alternateBase: 'C' }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.request.translation).toBe('MKG');
    expect(result.selections).toHaveLength(1);
    expect(result.selections[0].target.intervals).toEqual([{ start: 0, end: 0 }]);
    expect(result.selections[0].mappings[0].intervals).toEqual([{ start: 10, end: 0 }]);
  });
});
