export const HISTORY_ACTIONS = [
  'list',
  'title_filter',
  'resume',
  'hydrate',
  'new',
  'rename',
  'row_pin',
  'delete',
  'presentation',
  'sidebar_preference',
] as const;
export const HISTORY_SOURCES = [
  'store',
  'history_surface',
  'history_retry',
  'pane_owner',
  'background_pane',
  'delete_replacement',
] as const;
export const HISTORY_PHASES = ['accepted', 'result', 'refused', 'cancelled', 'error'] as const;
export const HISTORY_STAGES = ['operation', 'store', 'pane', 'filter'] as const;
export const HISTORY_RESULTS = [
  'started',
  'loaded_empty',
  'loaded_rows',
  'read_rejected',
  'read_returned_projection_failed',
  'superseded',
  'cached_available',
  'live_available',
  'persisted_available',
  'already_available',
  'joined_existing',
  'hydration_rejected',
  'tombstoned',
  'row_updated',
  'row_missing',
  'row_not_applied',
  'native_write_returned',
  'native_write_rejected',
  'write_returned_projection_failed',
  'new_reused',
  'new_created',
  'create_rejected',
  'create_returned_projection_failed',
  'delete_returned',
  'delete_rejected',
  'delete_returned_recovery_failed',
  'pane_presented',
  'placeholder_presented',
  'background_available',
  'pane_requested',
  'request_returned',
  'request_rejected',
  'pane_unavailable',
  'surface_closed',
  'filter_matches',
  'filter_no_match',
  'filter_cleared',
  'filter_unavailable',
  'edit_cancelled',
  'empty_title',
  'preference_requested',
] as const;
export const HISTORY_FRESHNESS = [
  'current',
  'cached',
  'superseded',
  'unavailable',
  'not_applicable',
] as const;
export const HISTORY_AUTHORITIES = [
  'loaded_titles',
  'keyed_state',
  'sqlite_return',
  'sqlite_changes',
  'pane_commit',
  'local_preference',
  'not_attested',
] as const;
export const HISTORY_AVAILABILITY = [
  'live',
  'cached',
  'persisted',
  'keyed',
  'placeholder',
  'unknown',
] as const;
export const HISTORY_REPLACEMENTS = [
  'not_applicable',
  'none',
  'keyed_available',
  'persisted_available',
  'read_failed_placeholder',
  'created',
  'reused',
  'create_failed_placeholder',
] as const;
export const HISTORY_PANE_ROLES = ['current_pane', 'scoped_pane', 'background', 'unknown'] as const;
export const HISTORY_PIN_STATES = ['pinned', 'unpinned', 'unknown'] as const;
export const HISTORY_MATCH_BUCKETS = ['zero', 'one', 'many', 'not_applicable'] as const;
export type HistoryAction = (typeof HISTORY_ACTIONS)[number];
export type HistorySource = (typeof HISTORY_SOURCES)[number];
export type HistoryPhase = (typeof HISTORY_PHASES)[number];
export type HistoryResult = (typeof HISTORY_RESULTS)[number];
export interface HistoryDetails {
  phase?: Exclude<HistoryPhase, 'accepted'>;
  result: HistoryResult;
  authority?: (typeof HISTORY_AUTHORITIES)[number];
  freshness?: (typeof HISTORY_FRESHNESS)[number];
  availability?: (typeof HISTORY_AVAILABILITY)[number];
  replacement?: (typeof HISTORY_REPLACEMENTS)[number];
  paneRole?: (typeof HISTORY_PANE_ROLES)[number];
  presentedGenerationId?: string | null;
  matches?: (typeof HISTORY_MATCH_BUCKETS)[number];
  pinState?: (typeof HISTORY_PIN_STATES)[number];
  shadow?: 'NOT_ATTESTED';
}
export interface HistoryObservation {
  readonly id: string | null;
  readonly paneGenerationId: string | null;
  readonly availability: HistoryDetails['availability'];
  readonly replacement: HistoryDetails['replacement'];
  store(details: HistoryDetails): void;
  pane(details: HistoryDetails): void;
}
