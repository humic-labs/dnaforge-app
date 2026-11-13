export const JOB_MANAGEMENT_ACTIONS = [
  'stop',
  'import',
  'open',
  'release',
  'history',
  'reconnect',
  'scope',
  'record_completed',
] as const;
export const JOB_MANAGEMENT_PHASES = [
  'intent',
  'confirmed',
  'accepted',
  'refused',
  'cancelled',
  'result',
  'error',
  'observed',
] as const;
export const JOB_MANAGEMENT_STAGES = ['intent', 'confirmation', 'request', 'record'] as const;
export const JOB_MANAGEMENT_RESULTS = [
  'management_requested',
  'confirmation_accepted',
  'confirmation_cancelled',
  'unsupported_owner',
  'owner_record_unavailable',
  'owner_identity_changed',
  'stop_accepted',
  'stop_already_requested',
  'stop_already_settled',
  'stop_unavailable',
  'request_rejected',
  'terminal_cancelled',
  'terminal_succeeded',
  'terminal_failed',
  'terminal_interrupted',
  'terminal_not_attested',
  'superseded',
  'surface_closed',
  'runtime_changed',
  'import_returned_true',
  'import_not_applied',
  'open_presented',
  'open_refused',
  'open_cancelled',
  'open_unavailable',
  'presenter_returned_not_attested',
  'release_returned',
  'already_released',
  'release_unavailable',
  'history_returned',
  'reconnect_returned',
  'collection_current',
  'collection_unavailable',
  'scope_requested',
  'scope_applied',
  'scope_unchanged',
  'scope_unavailable',
  'recorded_history_added',
  'record_picker_cancelled',
] as const;
export const JOB_MANAGEMENT_OWNERS = [
  'managed-operation',
  'hosted-compute',
  'agent-action',
  'federated',
  'unknown',
] as const;
export const JOB_MANAGEMENT_AUTHORITIES = [
  'surface',
  'owner_ack',
  'adapter_return',
  'presenter_return',
  'owner_record',
  'owner_history_return',
  'request_return',
  'not_attested',
] as const;
export const JOB_MANAGEMENT_FRESHNESS = ['current', 'stale', 'unknown', 'superseded'] as const;
export const JOB_MANAGEMENT_MODES = ['managed', 'connected', 'recorded', 'unknown'] as const;
export const JOB_MANAGEMENT_ORIGINS = ['live', 'recorded', 'unknown'] as const;
export const JOB_MANAGEMENT_AVAILABILITY = [
  'none',
  'available',
  'released',
  'expired',
  'unavailable',
  'unknown',
] as const;
export const JOB_MANAGEMENT_STATES = [
  'queued',
  'running',
  'stopping',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
  'unknown',
] as const;
export const JOB_MANAGEMENT_HISTORY = ['complete', 'limited', 'unknown'] as const;
export const JOB_MANAGEMENT_SCOPES = ['all', 'scoped', 'unknown'] as const;
export type JobManagementAction = (typeof JOB_MANAGEMENT_ACTIONS)[number];
export interface JobManagementContext {
  owner: (typeof JOB_MANAGEMENT_OWNERS)[number];
  freshness: (typeof JOB_MANAGEMENT_FRESHNESS)[number];
  mode: (typeof JOB_MANAGEMENT_MODES)[number];
  availability: (typeof JOB_MANAGEMENT_AVAILABILITY)[number];
  state: (typeof JOB_MANAGEMENT_STATES)[number];
  observedAtMs?: number;
  history?: (typeof JOB_MANAGEMENT_HISTORY)[number];
  scope?: (typeof JOB_MANAGEMENT_SCOPES)[number];
}
export interface JobManagementDetails extends Partial<JobManagementContext> {
  phase: Exclude<(typeof JOB_MANAGEMENT_PHASES)[number], 'intent'>;
  result: (typeof JOB_MANAGEMENT_RESULTS)[number];
  authority?: (typeof JOB_MANAGEMENT_AUTHORITIES)[number];
}
export interface JobManagementObservation {
  readonly id: string | null;
  confirm(approved: boolean): void;
  settle(details: JobManagementDetails): void;
  record(details: JobManagementDetails): void;
}
