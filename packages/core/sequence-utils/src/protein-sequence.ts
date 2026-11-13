const PROTEIN_AMINO_ACID_SEQUENCE = /^[ACDEFGHIKLMNOPQRSTUVWYX*]+$/u;

export function normalizeProteinSequence(value: string): string {
  return value.replace(/\s/gu, '').toUpperCase();
}

export function proteinSequenceValidationError(value: string): string | null {
  const aminoAcids = normalizeProteinSequence(value);
  if (!aminoAcids) return 'Protein sequence is required.';
  return PROTEIN_AMINO_ACID_SEQUENCE.test(aminoAcids)
    ? null
    : 'Use standard one-letter amino-acid codes, including U and O, X, or a stop marker (*).';
}
