export type ScientificTrackKind =
  | 'transcript'
  | 'interval'
  | 'quantitative'
  | 'peak'
  | 'repeat'
  | 'reads'
  | 'variants'
  | 'unsupported';

export const SCIENTIFIC_TRACK_KINDS: ReadonlySet<ScientificTrackKind> =
  new Set<ScientificTrackKind>([
    'transcript',
    'interval',
    'quantitative',
    'peak',
    'repeat',
    'reads',
    'variants',
    'unsupported',
  ]);
