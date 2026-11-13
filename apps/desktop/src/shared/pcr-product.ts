import { z } from 'zod';
import { reverseComplement, type AnnotatedSequence } from '@waypoint/sequence-utils';
import type { SequenceProductPart } from './sequence-product';

export const createPcrProductSchema = z
  .object({
    workspace: z
      .string()
      .min(1)
      .optional()
      .describe('Project name; required when multiple projects are open.'),
    name: z.string().min(1).max(80).describe('Name for the saved predicted PCR molecule.'),
    directory: z.string().min(1).default('products/verification'),
    templateDocumentId: z
      .string()
      .min(1)
      .max(200)
      .describe(
        'Accepted template sequence ID, returned by import_sequence or list_scientific_objects.'
      ),
    forwardPrimerId: z
      .string()
      .min(1)
      .max(200)
      .describe(
        'Accepted saved DNA oligo ID; this primer defines the product forward orientation.'
      ),
    reversePrimerId: z.string().min(1).max(200),
    forwardAnnealingLength: z
      .number()
      .int()
      .positive()
      .max(10000)
      .optional()
      .describe(
        'Number of 3-prime bases that anneal exactly. Defaults to the complete ordered oligo. Supply explicitly for a 5-prime-tailed construction primer.'
      ),
    reverseAnnealingLength: z
      .number()
      .int()
      .positive()
      .max(10000)
      .optional()
      .describe(
        'Number of 3-prime bases that anneal exactly. Defaults to the complete ordered oligo.'
      ),
    maxProductLength: z.number().int().positive().max(1000000).default(20000),
    productIndex: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'Choose a returned candidate if the pair predicts multiple products. Omit to save a unique product automatically.'
      ),
  })
  .strict();

export interface PcrProductCandidate {
  readonly parts: readonly SequenceProductPart[];
  readonly length: number;
  readonly templateSegments: readonly { start: number; end: number; strand: 1 | -1 }[];
}

function occurrences(sequence: string, query: string, limit: number): number[] {
  const positions: number[] = [];
  for (
    let start = sequence.indexOf(query);
    start !== -1 && start < limit;
    start = sequence.indexOf(query, start + 1)
  ) {
    positions.push(start);
    if (positions.length > 1000)
      throw new Error(
        'The oligo has too many exact binding sites to enumerate safely; choose a longer annealing sequence.'
      );
  }
  return positions;
}

export function predictPcrProducts(input: {
  templateDocumentId: string;
  template: AnnotatedSequence;
  forwardPrimerId: string;
  forward: string;
  reversePrimerId: string;
  reverse: string;
  forwardAnnealingLength?: number;
  reverseAnnealingLength?: number;
  maxProductLength: number;
}): PcrProductCandidate[] {
  const forward = input.forward.toUpperCase(),
    reverse = input.reverse.toUpperCase();
  if (!/^[ACGT]+$/.test(forward) || !/^[ACGT]+$/.test(reverse))
    throw new Error('Exact PCR prediction requires unambiguous A/C/G/T DNA oligos.');
  const fLength = input.forwardAnnealingLength ?? forward.length,
    rLength = input.reverseAnnealingLength ?? reverse.length;
  if (
    ![fLength, rLength].every(Number.isSafeInteger) ||
    fLength < 1 ||
    rLength < 1 ||
    fLength > forward.length ||
    rLength > reverse.length
  )
    throw new Error('Annealing lengths must be positive and fit their ordered oligos.');
  const fPbs = forward.slice(-fLength),
    rPbs = reverseComplement(reverse.slice(-rLength));
  const template = input.template.sequence.toUpperCase(),
    size = template.length;
  if (!size) throw new Error('The PCR template is empty.');
  const candidates: PcrProductCandidate[] = [];
  for (const strand of [1, -1] as const) {
    const oriented = strand === 1 ? template : reverseComplement(template);
    const searchable = input.template.circular ? oriented + oriented : oriented;
    const fStarts = occurrences(searchable, fPbs, size);
    const rStarts = occurrences(searchable, rPbs, searchable.length);
    const segments = (start: number, end: number) => {
      const ranges: { start: number; end: number; strand: 1 | -1 }[] = [];
      while (start < end) {
        const from = start % size,
          to = Math.min(size, from + end - start);
        ranges.push(
          strand === 1
            ? { start: from + 1, end: to, strand }
            : { start: size - to + 1, end: size - from, strand }
        );
        start += to - from;
      }
      return ranges;
    };
    for (const fStart of fStarts)
      for (const rStart of rStarts) {
        const end = rStart + rLength,
          interiorStart = fStart + fLength;
        if (rStart < interiorStart || end > searchable.length || end - fStart > size) continue;
        const length = forward.length + rStart - interiorStart + reverse.length;
        if (length > input.maxProductLength) continue;
        const parts: SequenceProductPart[] = [
          {
            kind: 'source',
            documentId: input.forwardPrimerId,
            start: 1,
            end: forward.length,
            strand: 1,
          },
          ...segments(interiorStart, rStart).map((range) => ({
            kind: 'source' as const,
            documentId: input.templateDocumentId,
            ...range,
          })),
          {
            kind: 'source',
            documentId: input.reversePrimerId,
            start: 1,
            end: reverse.length,
            strand: -1,
          },
        ];
        candidates.push({ parts, length, templateSegments: segments(fStart, end) });
        if (candidates.length > 100)
          throw new Error(
            'The pair predicts more than 100 exact products. Redesign the assay or narrow the explicit product-length limit.'
          );
      }
  }
  return candidates;
}
