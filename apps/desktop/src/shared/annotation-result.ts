import type { AnnotationResult } from '@waypoint/api-client/models';

function isPosition(value: unknown, length: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= length;
}

function isScore(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function hasFeatureShape(value: unknown, length: number): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const feature = value as Record<string, unknown>;
  return (
    typeof feature.name === 'string' &&
    ['accession', 'type', 'description'].every(
      (key) => feature[key] === undefined || typeof feature[key] === 'string'
    ) &&
    isPosition(feature.start, length) &&
    isPosition(feature.end, length) &&
    (feature.strand === 1 || feature.strand === -1) &&
    isScore(feature.identity) &&
    isScore(feature.coverage) &&
    typeof feature.fragment === 'boolean' &&
    typeof feature.ref_length === 'number' &&
    Number.isSafeInteger(feature.ref_length) &&
    isPosition(feature.ref_start, feature.ref_length) &&
    isPosition(feature.ref_end, feature.ref_length) &&
    typeof feature.db_source === 'string' &&
    ['protein', 'nucleotide', 'rna'].includes(feature.db_source)
  );
}

export function hasAnnotationResultShape(value: unknown): value is AnnotationResult {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<AnnotationResult>;
  return (
    Array.isArray(candidate.features) &&
    typeof candidate.sequence_length === 'number' &&
    Number.isSafeInteger(candidate.sequence_length) &&
    candidate.sequence_length >= 0 &&
    (candidate.error === undefined ||
      candidate.error === null ||
      (typeof candidate.error === 'string' && candidate.error.length > 0)) &&
    candidate.features.every((feature) => hasFeatureShape(feature, candidate.sequence_length!))
  );
}
