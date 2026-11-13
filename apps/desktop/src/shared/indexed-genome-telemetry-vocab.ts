export const INDEXED_GENOME_STAGES = [
  'open_accepted',
  'coordinate_ready',
  'first_viewport_presented',
  'open_refused',
  'open_failed',
  'open_cancelled',
  'open_superseded',
  'viewport_accepted',
  'viewport_presented',
  'viewport_refused',
  'viewport_failed',
  'viewport_cancelled',
  'viewport_superseded',
] as const;

export const INDEXED_GENOME_ORIGINS = [
  'open',
  'reopen',
  'restored',
  'retry',
  'source_switch',
] as const;

export const INDEXED_GENOME_REASONS = [
  'source_unavailable',
  'index',
  'session',
  'renderer',
  'invalid_coordinate',
  'closed',
  'superseded',
] as const;

export type IndexedGenomeStage = (typeof INDEXED_GENOME_STAGES)[number];
export type IndexedGenomeOrigin = (typeof INDEXED_GENOME_ORIGINS)[number];
export type IndexedGenomeReason = (typeof INDEXED_GENOME_REASONS)[number];
