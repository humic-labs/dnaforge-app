import { describe, expect, it } from 'vitest';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import type { Mutation } from '../types';
import { buildMutationProteinContext } from './mutation-protein-context';
const reference = {
  name: 'Reporter',
  sequence: 'ATGAAAGGTTAA',
  circular: false,
  annotations: [{ id: 'reporter', name: 'Reporter', type: 'CDS', start: 1, end: 12, direction: 1 }],
} as AnnotatedSequence;
function context(change: Partial<Mutation>, sequence = reference) {
  return buildMutationProteinContext({
    sequence,
    documentId: 'reference',
    trackId: 'clone',
    trackLabel: 'Clone',
    mutation: {
      id: 'change',
      type: 'substitution',
      position: 4,
      referenceBase: 'A',
      alternateBase: 'T',
      length: 1,
      ...change,
    },
  });
}
function mapped(change: Partial<Mutation>, sequence = reference) {
  const result = context(change, sequence);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result.request.variantContext;
}
describe('reference context for stops and indels', () => {
  it('maps a three-base deletion onto its actual reference codon', () => {
    expect(
      mapped({ type: 'deletion', position: 4, referenceBase: 'AAA', alternateBase: '', length: 3 })
    ).toMatchObject({ residueIndices: [1], proteinEffect: 'in-frame-deletion' });
  });
  it('maps an insertion to both flanking reference codons without inventing inserted atoms', () => {
    expect(
      mapped({ type: 'insertion', position: 6, referenceBase: '', alternateBase: 'CCC', length: 3 })
    ).toMatchObject({ residueIndices: [1, 2], proteinEffect: 'in-frame-insertion' });
  });
  it('retains the affected reference tail for a frameshift', () => {
    expect(
      mapped({ type: 'deletion', position: 5, referenceBase: 'A', alternateBase: '', length: 1 })
    ).toMatchObject({ proteinEffect: 'frameshift', affectedTail: { start: 2, end: 3 } });
  });
  it('starts an insertion frameshift after the upstream codon, in either strand', () => {
    expect(
      mapped({ type: 'insertion', position: 6, referenceBase: '', alternateBase: 'C', length: 1 })
    ).toMatchObject({ affectedTail: { start: 3, end: 3 } });
    const reversed = {
      ...reference,
      sequence: 'TTAACCTTTCAT',
      annotations: [{ ...reference.annotations[0], direction: -1 as const }],
    };
    expect(
      mapped(
        { type: 'insertion', position: 6, referenceBase: '', alternateBase: 'C', length: 1 },
        reversed
      )
    ).toMatchObject({ affectedTail: { start: 3, end: 3 } });
  });
  it('accepts the null absent allele retained in older clone sidecars', () => {
    expect(
      mapped({
        type: 'deletion',
        position: 4,
        referenceBase: 'AAA',
        alternateBase: null as unknown as string,
        length: 3,
      })
    ).toMatchObject({ proteinEffect: 'in-frame-deletion' });
  });
  it('distinguishes a gained stop from a missense side chain', () => {
    expect(mapped({})).toMatchObject({
      proteinEffect: 'stop-gained',
      changes: [{ residue: 2, reference: 'K', alternate: '*' }],
      affectedTail: { start: 2, end: 3 },
    });
  });
  it('describes the encoded substitution and a synonymous allele separately', () => {
    expect(mapped({ position: 5, alternateBase: 'G' })).toMatchObject({
      proteinEffect: 'missense',
      changes: [{ residue: 2, reference: 'K', alternate: 'R' }],
    });
    expect(mapped({ position: 6, alternateBase: 'G' })).toMatchObject({
      proteinEffect: 'synonymous',
      changes: [{ residue: 2, reference: 'K', alternate: 'K' }],
    });
  });
  it('preserves reverse-strand flanks and frame direction', () => {
    const reversed = {
      ...reference,
      sequence: 'TTAACCTTTCAT',
      annotations: [{ ...reference.annotations[0], direction: -1 as const }],
    };
    expect(
      mapped(
        { type: 'deletion', position: 7, referenceBase: 'TTT', alternateBase: '', length: 3 },
        reversed
      )
    ).toMatchObject({ residueIndices: [1], proteinEffect: 'in-frame-deletion' });
  });
  it('refuses a deletion crossing untranslated sequence', () => {
    expect(
      context(
        { type: 'deletion', position: 2, referenceBase: 'TGAA', alternateBase: '', length: 4 },
        { ...reference, annotations: [{ ...reference.annotations[0], start: 4 }] }
      ).ok
    ).toBe(false);
  });
});
