export const REFERENCE_SEMANTIC_VOCABULARY_REVISION = 1 as const;

const CENTROMERE_TERMS = new Set(['centromere', 'so:0000577']);
const ORIGIN_OF_REPLICATION_TERMS = new Set(['origin_of_replication', 'rep_origin', 'so:0000296']);

export type CanonicalCoordinateSemantic = 'centromere-region' | 'origin-of-replication';

export function canonicalCoordinateSemanticForSourceTerm(
  term: string
): CanonicalCoordinateSemantic | null {
  const normalized = term.trim().toLowerCase();
  if (CENTROMERE_TERMS.has(normalized)) return 'centromere-region';
  if (ORIGIN_OF_REPLICATION_TERMS.has(normalized)) return 'origin-of-replication';
  return null;
}
