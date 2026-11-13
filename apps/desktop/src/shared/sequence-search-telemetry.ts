export const SEQUENCE_SEARCH_SOURCES = ['in_memory', 'unknown'] as const;
export const SEQUENCE_SEARCH_MODES = ['nucleotide', 'amino_acid', 'unknown'] as const;
export const SEQUENCE_SEARCH_TOPOLOGIES = ['linear', 'circular', 'unknown'] as const;
export const SEQUENCE_SEARCH_RESULTS = [
  'pending',
  'matches',
  'empty',
  'invalid_pattern',
  'too_broad',
  'superseded',
  'mode_changed',
  'source_changed',
  'closed',
  'unmounted',
  'unknown',
] as const;
export const SEQUENCE_SEARCH_COUNT_BUCKETS = [
  '0',
  '1',
  '2_10',
  '11_100',
  '101_1000',
  '1001_10000',
  '10001_100000',
  '100001_1000000',
  'over_1000000',
  'unknown',
] as const;

export type SequenceSearchResult = (typeof SEQUENCE_SEARCH_RESULTS)[number];
export const SEQUENCE_SEARCH_NAVIGATION_RESULTS = [
  'pending',
  'presented',
  'cancelled',
  'observation_interrupted',
] as const;
export const SEQUENCE_SEARCH_NAVIGATION_SURFACES = [
  'pending',
  'sequence_canvas',
  'sequence_tracks',
] as const;
export type SequenceSearchNavigationResult = (typeof SEQUENCE_SEARCH_NAVIGATION_RESULTS)[number];

export function sequenceSearchCountBucket(
  value: number
): (typeof SEQUENCE_SEARCH_COUNT_BUCKETS)[number] {
  if (!Number.isSafeInteger(value) || value < 0) return 'unknown';
  if (value === 0) return '0';
  if (value === 1) return '1';
  if (value <= 10) return '2_10';
  if (value <= 100) return '11_100';
  if (value <= 1000) return '101_1000';
  if (value <= 10000) return '1001_10000';
  if (value <= 100000) return '10001_100000';
  if (value <= 1000000) return '100001_1000000';
  return 'over_1000000';
}
