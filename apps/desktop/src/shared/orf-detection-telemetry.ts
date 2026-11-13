export const ORF_DETECTION_SOURCES = ['worker', 'fallback', 'cache'] as const;
export const ORF_DETECTION_RESULTS = [
  'pending',
  'results',
  'empty',
  'detector_error',
  'worker_error',
  'invalid_result',
  'superseded',
  'retry',
  'view_hidden',
  'detector_cancelled',
  'unmounted',
  'observation_interrupted',
] as const;
export const ORF_DETECTION_COUNT_BUCKETS = [
  '0',
  '1',
  '2_5',
  '6_20',
  '21_100',
  '100_plus',
  'unknown',
] as const;

export type OrfDetectionResult = (typeof ORF_DETECTION_RESULTS)[number];
export type OrfDetectionCountBucket = (typeof ORF_DETECTION_COUNT_BUCKETS)[number];
