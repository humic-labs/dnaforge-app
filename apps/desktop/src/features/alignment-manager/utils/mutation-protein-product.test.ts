import { describe, expect, it } from 'vitest';
import {
  reverseComplement,
  type AnnotatedSequence,
  type Annotation,
} from '@waypoint/sequence-utils';
import { deriveMutationProteinProduct } from './mutation-protein-product';
import type { Mutation } from '../types';

const cds: Annotation = {
  id: 'cds',
  name: 'P',
  type: 'CDS',
  start: 1,
  end: 12,
  direction: 1,
  qualifiers: { transl_table: ['11'] },
};
const ref = {
  name: 'reference',
  sequence: 'ATGAAAGGTTAA',
  annotations: [cds],
  circular: false,
} as AnnotatedSequence;
const change: Mutation = {
  id: 'm',
  position: 5,
  referenceBase: 'A',
  alternateBase: 'G',
  type: 'substitution',
  length: 1,
};
const derive = (mutation: Mutation = change, sequence = ref, feature = sequence.annotations![0]) =>
  deriveMutationProteinProduct({ sequence, cds: feature, mutation, referenceProtein: 'MKG' });

describe('single-allele protein products', () => {
  it('translates the complete missense product with correspondence to the original codons', () => {
    expect(derive()).toMatchObject({
      status: 'complete',
      basis: 'single-allele',
      sequence: 'MRG',
      alternateToReference: [0, 1, 2],
    });
  });
  it('ends at a gained stop and does not invent coordinates for the absent tail', () => {
    expect(derive({ ...change, position: 4, alternateBase: 'T' })).toMatchObject({
      status: 'complete',
      sequence: 'M',
      alternateToReference: [0],
      stop: { residue: 2 },
    });
  });
  it('reads the reverse strand before applying the allele', () => {
    expect(
      derive(
        { ...change, position: 8, referenceBase: 'T', alternateBase: 'C' },
        {
          ...ref,
          sequence: reverseComplement(ref.sequence),
          annotations: [{ ...cds, direction: -1 }],
        }
      )
    ).toMatchObject({ status: 'complete', sequence: 'MRG', alternateToReference: [0, 1, 2] });
  });
  it('inserts an entire codon without shifting reference correspondence onto the new residue', () => {
    expect(
      derive({
        ...change,
        position: 3,
        type: 'insertion',
        referenceBase: '',
        alternateBase: 'TCC',
        length: 3,
      })
    ).toMatchObject({
      status: 'complete',
      sequence: 'MSKG',
      alternateToReference: [0, null, 1, 2],
    });
  });
  it('deletes an entire codon and preserves the downstream correspondence', () => {
    expect(
      derive({
        ...change,
        position: 4,
        type: 'deletion',
        referenceBase: 'AAA',
        alternateBase: '',
        length: 3,
      })
    ).toMatchObject({ status: 'complete', sequence: 'MG', alternateToReference: [0, 2] });
  });
  it('translates a frameshift through available downstream DNA to its new stop', () => {
    const sequence = { ...ref, sequence: ref.sequence + 'CTAA' };
    expect(
      derive(
        {
          ...change,
          position: 4,
          type: 'deletion',
          referenceBase: 'A',
          alternateBase: '',
          length: 1,
        },
        sequence
      )
    ).toMatchObject({
      status: 'complete',
      sequence: 'MKVN',
      alternateToReference: [0, null, null, null],
      extendedBeyondCds: true,
    });
  });
  it('does not call an unterminated frameshift a complete protein', () => {
    expect(
      derive({
        ...change,
        position: 4,
        type: 'deletion',
        referenceBase: 'A',
        alternateBase: '',
        length: 1,
      })
    ).toMatchObject({ status: 'unresolved', reason: expect.stringMatching(/stop|downstream/i) });
  });
  it('does not infer translation initiation after loss of the start', () => {
    expect(
      derive({ ...change, position: 2, referenceBase: 'T', alternateBase: 'C' })
    ).toMatchObject({ status: 'unresolved', reason: expect.stringMatching(/start|initiation/i) });
  });
  it('retains bacterial alternate initiation as methionine', () => {
    expect(
      derive({ ...change, position: 1, referenceBase: 'A', alternateBase: 'G' })
    ).toMatchObject({ status: 'complete', sequence: 'MKG' });
  });
  it('honors joined coding DNA without translating the intron', () => {
    const sequence = {
      ...ref,
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
    expect(derive({ ...change, position: 8 }, sequence)).toMatchObject({
      status: 'complete',
      sequence: 'MRG',
      alternateToReference: [0, 1, 2],
    });
  });
  it('rejects stale reference alleles', () => {
    expect(derive({ ...change, referenceBase: 'C' })).toMatchObject({
      status: 'unresolved',
      reason: expect.stringMatching(/reference/i),
    });
  });
  it('does not turn a partial coding start into a complete product', () => {
    const sequence = {
      ...ref,
      sequence: 'A' + ref.sequence,
      annotations: [{ ...cds, end: 13, qualifiers: { codon_start: ['2'] } }],
    };
    expect(derive({ ...change, position: 6 }, sequence)).toMatchObject({
      status: 'unresolved',
      reason: expect.stringMatching(/partial|start/i),
    });
  });
  it('orients reverse-strand insertions before translating them', () => {
    expect(
      derive(
        {
          ...change,
          position: 9,
          type: 'insertion',
          referenceBase: '',
          alternateBase: 'GGA',
          length: 3,
        },
        {
          ...ref,
          sequence: reverseComplement(ref.sequence),
          annotations: [{ ...cds, direction: -1 }],
        }
      )
    ).toMatchObject({
      status: 'complete',
      sequence: 'MSKG',
      alternateToReference: [0, null, 1, 2],
    });
  });
  it('preserves codon correspondence across the circular origin', () => {
    expect(
      derive(
        { ...change, position: 3 },
        {
          ...ref,
          circular: true,
          sequence: 'GAAAGGTTAAAT',
          annotations: [{ ...cds, start: 11, end: 10 }],
        }
      )
    ).toMatchObject({ status: 'complete', sequence: 'MRG', alternateToReference: [0, 1, 2] });
  });
  it('does not assign a fused junction codon to one of its former residues', () => {
    expect(
      derive({
        ...change,
        position: 5,
        type: 'deletion',
        referenceBase: 'AAG',
        alternateBase: '',
        length: 3,
      })
    ).toMatchObject({ status: 'complete', sequence: 'MS', alternateToReference: [0, null] });
  });
  it('does not invent downstream exons for a frameshift in a joined feature', () => {
    const sequence = {
      ...ref,
      sequence: 'ATGACCCAAGGTTAACTAA',
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
    expect(
      derive(
        {
          ...change,
          position: 8,
          type: 'deletion',
          referenceBase: 'A',
          alternateBase: '',
          length: 1,
        },
        sequence
      )
    ).toMatchObject({ status: 'unresolved', reason: expect.stringMatching(/transcript|joined/i) });
  });
  it('reports ambiguous termination without choosing the full-length or truncated product', () => {
    const sequence = {
      ...ref,
      sequence: 'ATGAAATGATAA',
      annotations: [{ ...cds, qualifiers: { transl_except: ['(pos:7..9,aa:Sec)'] } }],
    };
    expect(
      deriveMutationProteinProduct({
        sequence,
        cds: sequence.annotations[0],
        mutation: change,
        referenceProtein: 'MKU',
      })
    ).toMatchObject({
      status: 'unresolved',
      reason: expect.stringMatching(/encode and terminate/i),
    });
  });
});
