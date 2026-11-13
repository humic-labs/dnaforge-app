import { IUPAC_EXPANSION } from '@waypoint/sequence-utils/iupac';

const IUPAC_SEQUENCE_CODES = new Set(Object.keys(IUPAC_EXPANSION));

export class InvalidGenomeSequenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidGenomeSequenceError';
  }
}

export function isInvalidGenomeSequenceError(error: unknown): error is Error {
  return (
    error instanceof InvalidGenomeSequenceError ||
    (error instanceof Error && error.name === 'InvalidGenomeSequenceError')
  );
}

export function validateIupacSequencePayload(sequence: string, expectedLength: number): string {
  if (sequence.length !== expectedLength) {
    throw new InvalidGenomeSequenceError(
      `Indexed FASTA returned ${sequence.length} bases for an expected ${expectedLength}-base interval.`
    );
  }
  const normalized = sequence.toUpperCase();
  for (let index = 0; index < normalized.length; index += 1) {
    if (!IUPAC_SEQUENCE_CODES.has(normalized[index])) {
      throw new InvalidGenomeSequenceError(
        'Indexed source returned characters outside the IUPAC nucleotide alphabet.'
      );
    }
  }
  return normalized;
}
