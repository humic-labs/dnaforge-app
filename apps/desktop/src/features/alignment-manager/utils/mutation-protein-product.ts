import { z } from 'zod';
import {
  codonReaderFor,
  resolveGeneticCode,
  resolveSequenceGeneticCode,
  reverseComplement,
  type AnnotatedSequence,
  type Annotation,
} from '@waypoint/sequence-utils';
import { buildSplicedCodingSequence } from '@waypoint/workspace-editor';
import type { Mutation } from '../types';

export const mutationProteinProductSchema = z.discriminatedUnion('status', [
  z.object({
    basis: z.literal('single-allele'),
    status: z.literal('unresolved'),
    reason: z.string().min(1).max(2000),
  }),
  z.object({
    basis: z.literal('single-allele'),
    status: z.literal('complete'),
    sequence: z
      .string()
      .min(1)
      .max(24000)
      .regex(/^[ACDEFGHIKLMNPQRSTVWY]+$/),
    referenceLength: z.number().int().positive().max(24000),
    alternateToReference: z.array(z.number().int().nonnegative().nullable()).max(24000),
    stop: z.object({
      residue: z.number().int().positive(),
      genomicPositions: z.array(z.number().int().nonnegative().nullable()).length(3),
    }),
    extendedBeyondCds: z.boolean(),
  }),
]);
export type MutationProteinProduct = z.infer<typeof mutationProteinProductSchema>;

export function deriveMutationProteinProduct({
  sequence,
  cds,
  mutation,
  referenceProtein,
}: {
  sequence: AnnotatedSequence;
  cds: Annotation;
  mutation: Mutation;
  referenceProtein: string;
}): MutationProteinProduct {
  const unresolved = (reason: string): MutationProteinProduct => ({
    basis: 'single-allele',
    status: 'unresolved',
    reason,
  });
  const genome = sequence.sequence.toUpperCase();
  const reference = (mutation.referenceBase ?? '').toUpperCase();
  const alternate = (mutation.alternateBase ?? '').toUpperCase();
  const start = mutation.position - 1;
  if (
    !Number.isInteger(start) ||
    start < 0 ||
    start + reference.length > genome.length ||
    genome.slice(start, start + reference.length) !== reference
  )
    return unresolved('The reference DNA does not match this allele.');
  if (!/^[ACGT]*$/.test(reference + alternate))
    return unresolved('Ambiguous allele bases do not establish one protein sequence.');
  if (cds.direction !== 1 && cds.direction !== -1)
    return unresolved('The coding strand is unknown.');
  if (/\border\s*\(/i.test(cds.qualifiers?._locationString?.[0] ?? ''))
    return unresolved('The coding segments do not establish a joined product.');
  const recordCode = resolveSequenceGeneticCode(sequence);
  const walk = buildSplicedCodingSequence(cds, genome, recordCode.code, recordCode.basis);
  if (
    walk.codonStartOffset !== 0 ||
    /[<>]/.test(cds.qualifiers?._locationString?.[0] ?? '') ||
    cds.qualifiers?.partial ||
    cds.qualifiers?.pseudo ||
    cds.qualifiers?.pseudogene
  )
    return unresolved(
      'A partial or inactive coding annotation does not establish a complete translated product.'
    );
  const coordinates: Array<number | null> = [...walk.genomicCoordinateMap];
  if (new Set(coordinates).size !== coordinates.length)
    return unresolved(
      'This coding feature reuses DNA positions; the allele needs a programmed-frameshift model.'
    );
  let dna = walk.codingSequence.toUpperCase();
  const read = codonReaderFor(cds, recordCode.code, recordCode.basis);
  const table = resolveGeneticCode(walk.geneticCode);
  if (!table.startCodons.has(dna.slice(0, 3)))
    return unresolved('The reference coding start does not establish translation initiation.');
  const codonPositions = new Map<string, number>();
  let observedReference = '';
  for (let i = 0; i + 3 <= dna.length; i += 3) {
    const positions = walk.genomicCoordinateMap.slice(i, i + 3);
    codonPositions.set(positions.join(','), i / 3);
    const reading = read(dna.slice(i, i + 3), Math.min(...positions) + 1);
    observedReference += i === 0 ? 'M' : reading.short;
  }
  if (observedReference.replace(/\*$/, '') !== referenceProtein)
    return unresolved('The reference protein and current coding DNA disagree.');
  let editOffset: number;
  let removeLength: number;
  if (mutation.type === 'insertion') {
    if (reference || !alternate) return unresolved('The insertion has invalid allele bases.');
    const left = coordinates.indexOf(start);
    const right = coordinates.indexOf(start + 1);
    if (left < 0 || right < 0 || Math.abs(left - right) !== 1)
      return unresolved('The insertion crosses a coding boundary or untranslated gap.');
    editOffset = Math.max(left, right);
    removeLength = 0;
  } else {
    if (
      !reference ||
      (mutation.type === 'deletion' ? !!alternate : alternate.length !== reference.length)
    )
      return unresolved('The allele has an unsupported reference interval.');
    const indices = Array.from({ length: reference.length }, (_, i) =>
      coordinates.indexOf(start + i)
    ).sort((a, b) => a - b);
    if (indices[0] < 0 || indices.some((value, i) => value !== indices[0] + i))
      return unresolved('The allele crosses a coding boundary or untranslated gap.');
    editOffset = indices[0];
    removeLength = indices.length;
  }
  const orientedAlternate = cds.direction === -1 ? reverseComplement(alternate) : alternate;
  const replacementCoordinates =
    mutation.type === 'substitution'
      ? coordinates.slice(editOffset, editOffset + removeLength)
      : Array.from({ length: alternate.length }, () => null);
  dna = dna.slice(0, editOffset) + orientedAlternate + dna.slice(editOffset + removeLength);
  coordinates.splice(editOffset, removeLength, ...replacementCoordinates);
  if (!table.startCodons.has(dna.slice(0, 3)))
    return unresolved('The allele changes the coding start; translation initiation is unresolved.');

  const annotatedLength = dna.length;
  const canExtend = !cds.segments || cds.segments.length <= 1;
  const occupied = new Set(walk.genomicCoordinateMap);
  let next = walk.genomicCoordinateMap[walk.genomicCoordinateMap.length - 1] + cds.direction;
  const extendCodon = (offset: number) => {
    while (canExtend && dna.length < offset + 3) {
      if (!sequence.circular && (next < 0 || next >= genome.length)) break;
      const position = ((next % genome.length) + genome.length) % genome.length;
      if (occupied.has(position)) break;
      occupied.add(position);
      dna += cds.direction === -1 ? reverseComplement(genome[position]) : genome[position];
      coordinates.push(position);
      next += cds.direction;
    }
    return offset + 3 <= dna.length;
  };
  const noExceptions = codonReaderFor(
    { qualifiers: { ...cds.qualifiers, transl_except: [] } },
    recordCode.code,
    recordCode.basis
  );
  let protein = '';
  const alternateToReference: Array<number | null> = [];
  for (let i = 0; extendCodon(i); i += 3) {
    const positions = coordinates.slice(i, i + 3);
    const referenceIndex = positions.includes(null)
      ? undefined
      : codonPositions.get(positions.join(','));
    const codon = dna.slice(i, i + 3);
    const reader = referenceIndex === undefined ? noExceptions : read;
    const knownPositions = positions.filter((p): p is number => p !== null);
    const reading = reader(codon, knownPositions.length ? Math.min(...knownPositions) + 1 : 0);
    if (reading.alsoTerminates)
      return unresolved(
        'This sequence can both encode and terminate at a codon; it does not establish one complete product.'
      );
    if (reading.kind === 'stop') {
      if (!protein)
        return unresolved('This allele does not encode a protein before its first stop.');
      return {
        basis: 'single-allele',
        status: 'complete',
        sequence: protein,
        referenceLength: referenceProtein.length,
        alternateToReference,
        stop: { residue: protein.length + 1, genomicPositions: positions },
        extendedBeyondCds: i + 3 > annotatedLength,
      };
    }
    if (!/^[ACDEFGHIKLMNPQRSTVWY]$/.test(reading.short) || reading.kind !== 'amino-acid')
      return unresolved(
        'An unknown or nonstandard amino acid prevents an exact prediction sequence.'
      );
    protein += i === 0 ? 'M' : reading.short;
    alternateToReference.push(
      referenceIndex !== undefined && referenceIndex < referenceProtein.length
        ? referenceIndex
        : null
    );
    if (protein.length > 24_000)
      return unresolved('This allele exceeds the supported protein length.');
  }
  return unresolved(
    canExtend
      ? 'The available downstream DNA does not contain a complete in-frame stop for this allele.'
      : 'The allele needs downstream transcript sequence beyond the annotated joined coding feature.'
  );
}
