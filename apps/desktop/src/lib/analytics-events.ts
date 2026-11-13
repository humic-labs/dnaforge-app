export const TOOL_OPENED = 'tool_opened' as const;
export const TOOL_ACTION_STARTED = 'tool_action_started' as const;
export const TOOL_ACTION_COMPLETED = 'tool_action_completed' as const;
export const TOOL_ERROR = 'tool_error' as const;

export const TOOL_USAGE_TOOL_IDS = [
  'primers',
  'primer_design',
  'lims',
  'assembly',
  'import',
  'sequence_viewer',
  'structure_viewer',
  'agent_chat',
  'settings',
  'unknown',
] as const;

export const TOOL_USAGE_SURFACES = [
  'sidebar',
  'tab',
  'menu',
  'agent_tool',
  'welcome',
  'command_palette',
  'unknown',
] as const;

export const TOOL_USAGE_ACTIONS = [
  'opened',
  'created',
  'searched',
  'imported',
  'exported',
  'completed',
  'failed',
  'computed',
  'cancelled',
] as const;

export type ToolUsageToolId = (typeof TOOL_USAGE_TOOL_IDS)[number];
export type ToolUsageSurface = (typeof TOOL_USAGE_SURFACES)[number];
export type ToolUsageAction = (typeof TOOL_USAGE_ACTIONS)[number];

export type ToolUsageErrorClass =
  | 'validation'
  | 'cancelled'
  | 'compute'
  | 'sidecar'
  | 'timeout'
  | 'filesystem'
  | 'projection'
  | 'not_ready'
  | 'parse_failed'
  | 'write_failed'
  | 'sidecar_unreachable'
  | 'provider_unavailable'
  | 'unknown';

export const CHAT_HISTORY_OBSERVED = 'chat_history_observed' as const;
export const JOB_MANAGEMENT_OBSERVED = 'job_management_observed' as const;
export interface JobManagementObservedProps {
  feature_area: 'navigation';
  operation_id: string;
  occurred_at_ms: number;
  jobs_action: import('../shared/jobs-management-telemetry').JobManagementAction;
  jobs_stage: (typeof import('../shared/jobs-management-telemetry').JOB_MANAGEMENT_STAGES)[number];
  jobs_phase: (typeof import('../shared/jobs-management-telemetry').JOB_MANAGEMENT_PHASES)[number];
  jobs_result: (typeof import('../shared/jobs-management-telemetry').JOB_MANAGEMENT_RESULTS)[number];
  jobs_authority: NonNullable<
    import('../shared/jobs-management-telemetry').JobManagementDetails['authority']
  >;
  jobs_owner: import('../shared/jobs-management-telemetry').JobManagementContext['owner'];
  jobs_freshness: import('../shared/jobs-management-telemetry').JobManagementContext['freshness'];
  jobs_execution_mode: import('../shared/jobs-management-telemetry').JobManagementContext['mode'];
  jobs_origin: (typeof import('../shared/jobs-management-telemetry').JOB_MANAGEMENT_ORIGINS)[number];
  jobs_result_availability: import('../shared/jobs-management-telemetry').JobManagementContext['availability'];
  jobs_execution_state: import('../shared/jobs-management-telemetry').JobManagementContext['state'];
  jobs_history_coverage: NonNullable<
    import('../shared/jobs-management-telemetry').JobManagementContext['history']
  >;
  jobs_scope: NonNullable<
    import('../shared/jobs-management-telemetry').JobManagementContext['scope']
  >;
  jobs_operation_relation: 'action_only_native_not_exported';
  jobs_observation_clock: 'client_observed' | 'unknown';
  jobs_observed_at_ms?: number;
  jobs_context_basis: 'intent_snapshot' | 'intent_and_outcome' | 'record_observation';
}

export interface ChatHistoryObservedProps {
  feature_area: 'navigation';
  operation_id: string;
  occurred_at_ms: number;
  history_pane_generation_id?: string;
  history_parent_operation_id?: string;
  history_presented_generation_id?: string;
  history_action: import('../shared/chat-history-telemetry').HistoryAction;
  history_source: import('../shared/chat-history-telemetry').HistorySource;
  history_stage: (typeof import('../shared/chat-history-telemetry').HISTORY_STAGES)[number];
  history_phase: import('../shared/chat-history-telemetry').HistoryPhase;
  history_result: import('../shared/chat-history-telemetry').HistoryResult;
  history_authority: NonNullable<
    import('../shared/chat-history-telemetry').HistoryDetails['authority']
  >;
  history_freshness: NonNullable<
    import('../shared/chat-history-telemetry').HistoryDetails['freshness']
  >;
  history_availability: NonNullable<
    import('../shared/chat-history-telemetry').HistoryDetails['availability']
  >;
  history_replacement: NonNullable<
    import('../shared/chat-history-telemetry').HistoryDetails['replacement']
  >;
  history_pane_role: NonNullable<
    import('../shared/chat-history-telemetry').HistoryDetails['paneRole']
  >;
  history_match_bucket: NonNullable<
    import('../shared/chat-history-telemetry').HistoryDetails['matches']
  >;
  history_pin_state: NonNullable<
    import('../shared/chat-history-telemetry').HistoryDetails['pinState']
  >;
  history_shadow_cleanup: 'NOT_ATTESTED';
}

export const RELEASE_NOTES_OBSERVED = 'release_notes_observed' as const;
export interface ReleaseNotesObservedProps {
  feature_area: 'navigation';
  presentation_id: string;
  occurred_at_ms: number;
  notes_source: 'settings' | 'home' | 'post_update_toast';
  notes_phase: 'presented' | 'version_changed' | 'closed';
  notes_requested_kind: 'explicit' | 'installed_release' | 'source_release' | 'latest_registry';
  notes_requested_version: string;
  notes_displayed_version: string;
  notes_installed_version: string;
  notes_source_version: string;
  notes_artifact_kind: 'development' | 'local' | 'release' | 'test' | 'unknown';
  notes_result: 'available' | 'missing';
  notes_close_reason?: 'escape' | 'backdrop' | 'close';
  notes_capability: 'information_only';
}

export const ALL_EVENTS = [
  TOOL_OPENED,
  TOOL_ACTION_STARTED,
  TOOL_ACTION_COMPLETED,
  TOOL_ERROR,
  CHAT_HISTORY_OBSERVED,
  JOB_MANAGEMENT_OBSERVED,
  RELEASE_NOTES_OBSERVED,
] as const;
