export const ORF_DISPLAY_RESULTS = [
  'pending',
  'drawn',
  'empty',
  'superseded',
  'retry',
  'view_hidden',
  'detector_cancelled',
  'unmounted',
  'observation_interrupted',
] as const;
export const ORF_DISPLAY_SURFACES = [
  'pending',
  'sequence_canvas',
  'sequence_tracks',
  'plasmid_map',
] as const;
export type OrfDisplayResult = (typeof ORF_DISPLAY_RESULTS)[number];
export type OrfDisplaySurface = (typeof ORF_DISPLAY_SURFACES)[number];
