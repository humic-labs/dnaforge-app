export const TRANSLATION_COPY_STRANDS = ['forward', 'reverse'] as const;
export const TRANSLATION_COPY_FRAMES = ['1', '2', '3'] as const;
export const TRANSLATION_COPY_CODES = ['standard', 'nonstandard', 'custom', 'unknown'] as const;
export const TRANSLATION_COPY_RESULTS = [
  'pending',
  'delivered',
  'not_allowed',
  'write_failed',
  'observation_interrupted',
] as const;
export const TRANSLATION_COPY_LENGTH_BUCKETS = [
  '0',
  '1',
  '2_5',
  '6_20',
  '21_100',
  '100_plus',
  'unknown',
] as const;

export type TranslationCopyCode = (typeof TRANSLATION_COPY_CODES)[number];
export type TranslationCopyResult = (typeof TRANSLATION_COPY_RESULTS)[number];
export type TranslationCopyLengthBucket = (typeof TRANSLATION_COPY_LENGTH_BUCKETS)[number];

export function translationCopyLengthBucket(count: number): TranslationCopyLengthBucket {
  if (!Number.isSafeInteger(count) || count < 0) return 'unknown';
  if (count === 0) return '0';
  if (count === 1) return '1';
  if (count <= 5) return '2_5';
  if (count <= 20) return '6_20';
  if (count <= 100) return '21_100';
  return '100_plus';
}
