import type { SourceObject } from '../../shared/benchling-migration';
import { providerObjectClassForStableId } from '../../shared/provider-object-reference';

export function isNeedsSequenceCompletion(
  existing: SourceObject,
  candidate: SourceObject
): boolean {
  if (
    existing.id !== candidate.id ||
    existing.stableId !== candidate.stableId ||
    providerObjectClassForStableId(existing.stableId) !== 'sequence' ||
    normalizeSourceType(existing.sourceType) !== 'dna_sequence' ||
    normalizeSourceType(candidate.sourceType) !== 'dna_sequence'
  ) {
    return false;
  }
  const existingContent = record(existing.content);
  const candidateContent = record(candidate.content);
  return (
    existingContent?.kind === 'dna_sequence_needs_sequence' &&
    existingContent.moleculeType === 'DNA' &&
    existingContent.bases === '' &&
    Array.isArray(existingContent.annotations) &&
    existingContent.annotations.length === 0 &&
    candidateContent?.kind !== 'dna_sequence_needs_sequence' &&
    candidateContent?.moleculeType === 'DNA' &&
    typeof candidateContent.bases === 'string' &&
    candidateContent.bases.length > 0 &&
    Array.isArray(candidateContent.annotations)
  );
}

function normalizeSourceType(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/gu, '_');
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
