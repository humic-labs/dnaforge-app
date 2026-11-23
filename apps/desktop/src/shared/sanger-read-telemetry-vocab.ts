export const SANGER_READ_STAGES = [
  'read_requested',
  'parse_started',
  'parsed',
  'revision_ready',
  'scene_admitted',
  'first_viewport_presented',
  'read_refused',
  'read_failed',
  'read_cancelled',
  'read_superseded',
  'viewport_accepted',
  'viewport_presented',
  'viewport_refused',
  'viewport_failed',
  'viewport_cancelled',
  'viewport_superseded',
] as const;

export const SANGER_READ_ORIGINS = [
  'initial_read',
  'local_reload',
  'native_reload',
  'attached_read',
  'reopen',
] as const;

export const SANGER_READ_CLASSIFICATIONS = ['requested_ab1', 'decoded_ab1'] as const;

export const SANGER_READ_REASONS = [
  'source_unavailable',
  'decode',
  'scene',
  'renderer',
  'stale_revision',
  'closed',
  'superseded',
] as const;

export const SANGER_READ_VIEWPORT_KINDS = ['pan', 'zoom'] as const;

export type SangerReadStage = (typeof SANGER_READ_STAGES)[number];
export type SangerReadOrigin = (typeof SANGER_READ_ORIGINS)[number];
export type SangerReadClassification = (typeof SANGER_READ_CLASSIFICATIONS)[number];
export type SangerReadReason = (typeof SANGER_READ_REASONS)[number];
export type SangerReadViewportKind = (typeof SANGER_READ_VIEWPORT_KINDS)[number];
