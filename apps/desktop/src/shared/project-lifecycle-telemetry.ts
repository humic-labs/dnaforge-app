export const PROJECT_LIFECYCLE_PHASES = [
  'accepted',
  'minted',
  'registered',
  'mounted',
  'restored',
  'indexed',
  'index_failed',
  'tree_ready',
  'tree_partial',
  'tree_failed',
  'refused',
  'superseded',
  'presentation_superseded',
  'selection_failed',
  'asset_failed',
  'failed',
  'cancelled',
] as const;
export const PROJECT_LIFECYCLE_SOURCES = [
  'empty',
  'local',
  'managed_import',
  'sample',
  'restore',
  'bootstrap',
  'unknown',
] as const;
export const PROJECT_LIFECYCLE_STAGES = [
  'acceptance',
  'materialization',
  'registration',
  'mount',
  'selection',
  'asset',
  'index',
  'tree',
] as const;
export const PROJECT_OPEN_MODES = ['add', 'replace', 'restore'] as const;
export const PROJECT_AUTHORITIES = ['writable', 'reference', 'mixed', 'unknown'] as const;
export type ProjectLifecyclePhase = (typeof PROJECT_LIFECYCLE_PHASES)[number];
export type ProjectLifecycleSource = (typeof PROJECT_LIFECYCLE_SOURCES)[number];
export type ProjectLifecycleStage = (typeof PROJECT_LIFECYCLE_STAGES)[number];
export type ProjectOpenMode = (typeof PROJECT_OPEN_MODES)[number];
export type ProjectAuthority = (typeof PROJECT_AUTHORITIES)[number];
