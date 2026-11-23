import { TOOL_ERROR_REASON_CODES } from './tool-error-reasons';
import {
  INDEXED_GENOME_ORIGINS,
  INDEXED_GENOME_REASONS,
  INDEXED_GENOME_STAGES,
} from './indexed-genome-telemetry-vocab';
import {
  SANGER_READ_STAGES,
  SANGER_READ_ORIGINS,
  SANGER_READ_CLASSIFICATIONS,
  SANGER_READ_REASONS,
  SANGER_READ_VIEWPORT_KINDS,
} from './sanger-read-telemetry-vocab';
import {
  NOTEBOOK_OPERATION_KINDS,
  NOTEBOOK_ERROR_CODES,
  NOTEBOOK_RELOAD_STAGES,
  AUTH_STATE_VENDORS,
  AUTH_STATE_STAGES,
  AUTH_STATE_OUTCOMES,
  AUTH_STATE_REASONS,
  MODEL_PREFERENCE_STAGES,
  MODEL_PREFERENCE_OUTCOMES,
  MODEL_PREFERENCE_ROUTES,
  MODEL_PREFERENCE_SELECTION_SOURCES,
  MODEL_PREFERENCE_MODEL_SOURCES,
  MODEL_PREFERENCE_FAILURE_CODES,
  notificationDefinition,
  notificationVariant,
} from './desktop-failure-telemetry';
import { ORF_DISPLAY_RESULTS, ORF_DISPLAY_SURFACES } from './orf-display-telemetry';
import {
  TRANSLATION_COPY_STRANDS,
  TRANSLATION_COPY_FRAMES,
  TRANSLATION_COPY_CODES,
  TRANSLATION_COPY_RESULTS,
  TRANSLATION_COPY_LENGTH_BUCKETS,
} from './translation-copy-telemetry';
import {
  ORF_DETECTION_SOURCES,
  ORF_DETECTION_RESULTS,
  ORF_DETECTION_COUNT_BUCKETS,
} from './orf-detection-telemetry';
import { EXTERNAL_ACCESS_ENUMS } from './external-access-telemetry';
import {
  SEQUENCE_SEARCH_SOURCES,
  SEQUENCE_SEARCH_MODES,
  SEQUENCE_SEARCH_TOPOLOGIES,
  SEQUENCE_SEARCH_RESULTS,
  SEQUENCE_SEARCH_COUNT_BUCKETS,
  SEQUENCE_SEARCH_NAVIGATION_RESULTS,
  SEQUENCE_SEARCH_NAVIGATION_SURFACES,
} from './sequence-search-telemetry';
import { STATIC_INTERACTION_CONTROLS } from './interaction-controls';
import {
  MAX_TABLE_OBSERVATION_COUNT,
  TABLE_OPERATIONS,
  TABLE_SURFACES,
  TABLE_CALCULATION_RESULTS,
} from './table-notebook-observation';
import {
  SKILL_ACTIONS,
  SKILL_HOSTS,
  SKILL_SCOPES,
  SKILL_SOURCES,
  SKILL_STAGES,
  SKILL_RESULTS,
  SKILL_AUTHORITIES,
  SKILL_ENABLEMENT,
  SKILL_RUNTIME,
  SKILL_INSTRUCTION,
  SKILL_FRESHNESS,
} from './skill-operation-telemetry';
import {
  RELEASE_NOTES_SOURCES,
  RELEASE_NOTES_PHASES,
  RELEASE_NOTES_CLOSE_REASONS,
  RELEASE_NOTES_REQUEST_KINDS,
  RELEASE_NOTES_ARTIFACT_KINDS,
  sanitizeReleaseNoteIdentity,
  sanitizeReleaseBuildIdentity,
} from './release-notes-telemetry';
import {
  JOB_MANAGEMENT_ACTIONS,
  JOB_MANAGEMENT_STAGES,
  JOB_MANAGEMENT_PHASES,
  JOB_MANAGEMENT_RESULTS,
  JOB_MANAGEMENT_AUTHORITIES,
  JOB_MANAGEMENT_OWNERS,
  JOB_MANAGEMENT_FRESHNESS,
  JOB_MANAGEMENT_MODES,
  JOB_MANAGEMENT_ORIGINS,
  JOB_MANAGEMENT_AVAILABILITY,
  JOB_MANAGEMENT_STATES,
  JOB_MANAGEMENT_HISTORY,
  JOB_MANAGEMENT_SCOPES,
} from './jobs-management-telemetry';
import {
  HISTORY_ACTIONS,
  HISTORY_SOURCES,
  HISTORY_PHASES,
  HISTORY_STAGES,
  HISTORY_RESULTS,
  HISTORY_FRESHNESS,
  HISTORY_AUTHORITIES,
  HISTORY_AVAILABILITY,
  HISTORY_REPLACEMENTS,
  HISTORY_PANE_ROLES,
  HISTORY_PIN_STATES,
  HISTORY_MATCH_BUCKETS,
} from './chat-history-telemetry';
import {
  PROJECT_LIFECYCLE_PHASES,
  PROJECT_LIFECYCLE_SOURCES,
  PROJECT_LIFECYCLE_STAGES,
  PROJECT_OPEN_MODES,
  PROJECT_AUTHORITIES,
} from './project-lifecycle-telemetry';

import { CLOSED_BETA_EVENTS, type ClosedBetaEvent } from './analytics-registry.generated';
import {
  HOSTED_REFERENCE_INSTALL_PHASES,
  HOSTED_REFERENCE_INSTALL_STAGES,
} from './hosted-reference-install-telemetry';
import { HOSTED_REFERENCE_UCSC_TRACK_TARGETS_V1 } from './hosted-reference-ucsc-targets';
import {
  WORKSPACE_SYNC_ACCESS_ROLES,
  WORKSPACE_SYNC_OPERATIONS,
  WORKSPACE_SYNC_NATIVE_STAGES,
  WORKSPACE_SYNC_RECOVERY_STAGES,
  WORKSPACE_SYNC_OUTCOMES,
  WORKSPACE_SYNC_REPRESENTATIONS,
} from './workspace-sync-telemetry';
import {
  AUTH_PROVIDER_CATEGORIES,
  SAFE_FILE_COUNT_BUCKETS,
  SAFE_FILE_SIZE_BUCKETS,
  SAFE_FILE_TYPE_CATEGORIES,
  SAFE_SCREEN_CATEGORIES,
  SAFE_SOURCE_SURFACES,
  classifyInternalOperator,
  normalizeTelemetryActor,
  sanitizeCiRunId,
  sanitizeTelemetryOriginClassification,
  SAFE_WORKSPACE_KINDS,
  SAFE_WORKSPACE_SOURCES,
} from '@waypoint/analytics-policy';
import {
  SCIENTIFIC_WORKFLOW_ACTIONS,
  SCIENTIFIC_WORKFLOWS,
  WORKFLOW_REVISION_RELATIONS,
  WORKFLOW_STATUSES,
  WORKFLOW_OUTCOME_KINDS,
  WORKFLOW_ORIGINS,
  RECORD_WRITE_STATUSES,
  RECORD_PROJECTION_STATUSES,
  RECORD_HISTORY_STATUSES,
  ASSEMBLY_COMPUTE_STAGES,
  ASSEMBLY_MATERIAL_ROUTES,
  ASSEMBLY_METHODS,
  EXPORT_FORMATS,
  DIGEST_TOPOLOGIES,
  DIGEST_READINESS_STATES,
  DIGEST_TRIGGERS,
  MAX_DIGEST_OBSERVATION_COUNT,
} from './scientific-workflow-vocab';
import {
  AI_TURN_COUNT_BUCKETS,
  AI_TURN_DURATION_BUCKETS,
  AI_TURN_EFFECT_STATES,
  AI_TURN_FAILURE_CLASSES,
  AI_TURN_INITIATORS,
  AI_TURN_QUALIFICATION_BASES,
  AI_TURN_REASON_CODES,
  AI_TURN_ROUTES,
  AI_TURN_SETTLEMENT_STATES,
  AI_TURN_STAGES,
  AI_TURN_TRACE_STATES,
} from './ai-turn-telemetry';

export { CLOSED_BETA_EVENTS };
export type { ClosedBetaEvent };

const CLOSED_BETA_EVENT_SET = new Set<string>(CLOSED_BETA_EVENTS);

const ALLOWED_FEATURE_AREAS = new Set([
  'lifecycle',
  'auth',
  'workspace',
  'project',
  'import',
  'reliability',
  'settings',
  'tool_usage',
  'navigation',
  'file',
  'scientific_workflow',
  'telemetry',
]);

const ALLOWED_TOOL_IDS = new Set([
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
]);
const ALLOWED_TOOL_SURFACES = new Set([
  'sidebar',
  'tab',
  'menu',
  'agent_tool',
  'welcome',
  'command_palette',
  'unknown',
]);
const ALLOWED_TOOL_ACTIONS = new Set([
  'click',
  'opened',
  'created',
  'searched',
  'imported',
  'exported',
  'completed',
  'failed',
  'computed',
  'cancelled',
]);
const ALLOWED_WORKSPACE_SOURCES = new Set<string>(SAFE_WORKSPACE_SOURCES);
const ALLOWED_WORKSPACE_KINDS = new Set<string>(SAFE_WORKSPACE_KINDS);
const ALLOWED_SOURCE_SURFACES = new Set<string>(SAFE_SOURCE_SURFACES);
const ALLOWED_SCREEN_CATEGORIES = new Set<string>(SAFE_SCREEN_CATEGORIES);
const ALLOWED_FILE_COUNT_BUCKETS = new Set<string>(SAFE_FILE_COUNT_BUCKETS);
const ALLOWED_SOURCE_SYSTEM_TYPES = new Set(['benchling', 'snapgene', 'file', 'manual', 'unknown']);
const ALLOWED_FILE_TYPE_CATEGORIES = new Set<string>(SAFE_FILE_TYPE_CATEGORIES);
const CATALOG_GENOME_BUILDS = new Set(HOSTED_REFERENCE_UCSC_TRACK_TARGETS_V1.map(({ id }) => id));
const ALLOWED_FAILURE_STAGES = new Set([
  'parse',
  'validate',
  'normalize',
  'write',
  'submit',
  'job',
  'import',
  'unknown',
]);
const ALLOWED_TELEMETRY_MODES = new Set(['disabled', 'closed_beta', 'dev', 'preview', 'prod']);
const ALLOWED_RELEASE_CHANNELS = new Set(['closed_beta', 'dev', 'preview', 'prod', 'unknown']);
const ALLOWED_ENVIRONMENTS = new Set(['development', 'staging', 'production', 'test', 'unknown']);
const ALLOWED_PLATFORM_FAMILIES = new Set(['macos', 'windows', 'linux', 'web', 'unknown']);
const ALLOWED_BOOL_KEYS = new Set([
  'online',
  'is_update',
  'used_bundle_fallback',
  'annotations_ready',
  'is_first_upload',
  'is_shared',
  'recovered_at_launch',
  'fatal',
  'handled',
  'success',
  'manual',
  'restored_from_backup',
  'repeat',
  'is_composing',
  'clean_exit',
  'cached',
  'credential_target',
  'is_release',
  'is_synthetic',
  'usable_result',
  'blocking',
  'count_overflow',
  'value_delivered',
  'had_workspace_context',
  'continuation',
  'historical',
  'impersonated',
  'wrote',
  'dirty',
]);
const ALLOWED_OPERATION_STAGES = new Set([
  'check',
  'download',
  'install',
  'intake',
  'scope',
  'capture',
  'parsing',
  'resolution',
  'projection',
  'validation',
  'finalization',
  'recovery',
  'unknown',
  ...AI_TURN_STAGES,
]);
const ALLOWED_AI_TURN_ROUTES = new Set<string>(AI_TURN_ROUTES);
const ALLOWED_AI_TURN_QUALIFICATION_BASES = new Set<string>(AI_TURN_QUALIFICATION_BASES);
const ALLOWED_AI_TURN_INITIATORS = new Set<string>(AI_TURN_INITIATORS);
const ALLOWED_AI_TURN_REASON_CODES = new Set<string>(AI_TURN_REASON_CODES);
const ALLOWED_AI_TURN_FAILURE_CLASSES = new Set<string>(AI_TURN_FAILURE_CLASSES);
const ALLOWED_AI_TURN_EFFECT_STATES = new Set<string>(AI_TURN_EFFECT_STATES);
const ALLOWED_AI_TURN_TRACE_STATES = new Set<string>(AI_TURN_TRACE_STATES);
const ALLOWED_AI_TURN_SETTLEMENT_STATES = new Set<string>(AI_TURN_SETTLEMENT_STATES);
const ALLOWED_AI_TURN_DURATION_BUCKETS = new Set<string>(AI_TURN_DURATION_BUCKETS);
const ALLOWED_AI_TURN_COUNT_BUCKETS = new Set<string>(AI_TURN_COUNT_BUCKETS);
const ALLOWED_MIGRATION_OPERATIONS = new Set([
  'initial_import',
  'linked_item_recovery',
  'workspace_append',
]);
const ALLOWED_MIGRATION_SOURCE_KINDS = new Set([
  'benchling_export_zip',
  'benchling_export_html',
  'legacy_provider_capture',
]);
const ALLOWED_NOTEBOOK_MIGRATION_SOURCES = new Set(['database-only', 'json-authority-package']);
const ALLOWED_MIGRATION_SCOPE_KINDS = new Set(['file', 'folder', 'folder_tree']);
const ALLOWED_MIGRATION_ISSUE_CODES = new Set([
  'identity_unverified',
  'identity_mismatch',
  'protected_account',
  'scope_plan_incomplete',
  'unsupported_scope_item',
  'local_export_warning',
  'unsafe_archive',
  'insufficient_storage',
  'ambiguous_receipt',
  'provider_retry_exhausted',
  'required_target_missing',
  'hash_mismatch',
  'projection_failed',
  'projection_contract_restart_required',
  'validation_failed',
  'migration_interrupted',
  'source_unavailable',
  'internal_invariant',
  'copy_failed',
  'decode_failed',
  'target_mismatch',
]);
const ALLOWED_MIGRATION_PRIMARY_ISSUE_CODES = new Set([...ALLOWED_MIGRATION_ISSUE_CODES, 'none']);
const ALLOWED_OUTCOMES = new Set([
  'started',
  'success',
  'recovered',
  'completed',
  'succeeded',
  'failed',
  'stopped',
  'cancelled',
  'cancelled_preserved',
  'interrupted',
  'needs_action',
  'outcome_unknown',
]);
const ALLOWED_DISPOSITIONS = new Set(['discarded']);
const ALLOWED_UPDATE_REASONS = new Set(['no-manifest', 'network', 'unknown']);
const ALLOWED_OVERSIZE_EXT_BUCKETS = new Set(['gb', 'gbk', 'fasta', 'fa', 'fastq', 'ab1', 'other']);
const ALLOWED_OVERSIZE_SIZE_BUCKETS = new Set(['<100MB', '100-256MB', '>256MB']);
const ALLOWED_OVERSIZE_DECISIONS = new Set([
  'warned',
  'confirmed',
  'cancelled',
  'blocked',
  'indexed',
  'deferred-on-rehydrate',
  'missing',
  'stat-error',
]);
const ALLOWED_WORKFLOWS = new Set<string>(SCIENTIFIC_WORKFLOWS);
const ALLOWED_WORKFLOW_ACTIONS = new Set<string>(SCIENTIFIC_WORKFLOW_ACTIONS);
const ALLOWED_WORKFLOW_PHASES = new Set(['start', 'result', 'error', 'commit', 'cancel']);
const ALLOWED_WORKFLOW_STATUSES = new Set<string>(WORKFLOW_STATUSES);
const ALLOWED_WORKFLOW_OUTCOME_KINDS = new Set<string>(WORKFLOW_OUTCOME_KINDS);
const ALLOWED_IDENTITY_KINDS = new Set(['anonymous', 'identified']);
const ALLOWED_ACTOR_KINDS = new Set(['external', 'internal', 'test', 'unknown']);
const ALLOWED_EXECUTION_MODES = new Set(['interactive', 'automated', 'synthetic']);
const ALLOWED_IDENTITY_RESOLUTIONS = new Set(['direct_session', 'linked_later']);
const ALLOWED_AUTH_PROVIDER_CATEGORIES = new Set<string>(AUTH_PROVIDER_CATEGORIES);
const ALLOWED_REJECTION_REASONS = new Set([
  'unknown_event',
  'unknown_property',
  'invalid_property',
  'mixed_property',
  'queue_overflow',
]);
const CORRELATION_UUID_KEYS = new Set([
  'app_session_id',
  'episode_correlation_id',
  'action_id',
  'effect_id',
  'attempt_correlation_id',
  'gesture_id',
  'interaction_id',
  'artifact_correlation_id',
  'search_episode_id',
  'native_action_id',
  'parent_action_id',
  'download_operation_id',
  'retry_parent_attempt_id',
  'origin_boot_id',
  'update_boot_id',
]);
const NONNEGATIVE_NUMBER_KEYS = new Set([
  'occurred_at_ms',
  'origin_started_at_ms',
  'emitted_at_ms',
  'terminal_occurred_at_ms',
  'file_count',
  'download_duration_ms',
  'file_size_bytes',
  'session_duration_ms',
  'result_count',
  'result_rank',
  'save_attempt_count',
  'sync_attempt_count',
  'selected_count',
  'affected_count',
  'state_revision',
  'attempt_count',
  'captured_revision',
  'acknowledged_revision',
  'rejected_property_count',
  'dropped_rejection_count',
  'source_object_count',
  'imported_object_count',
  'skipped_object_count',
  'attachment_count',
  'resolved_relationship_count',
  'unresolved_relationship_count',
  'ambiguous_relationship_count',
  'broken_relationship_count',
  'supported_formula_count',
  'unsupported_formula_count',
  'stale_formula_count',
  'projection_exception_count',
  'blocking_issue_count',
  'count',
  'origin_index',
  'client_x',
  'client_y',
  'button',
  'buttons',
  'capture_delay_ms',
  'sequence_number',
  'target_rect_x',
  'target_rect_y',
  'target_rect_width',
  'target_rect_height',
  'viewport_width',
  'viewport_height',
  'delta_mode',
  'initiated_at_ms',
  'qualified_at_ms',
  'elapsed_ms',
  'interval_minutes',
  'active_minutes',
  'focused_minutes',
  'main_heap_mb',
  'app_memory_mb',
  'renderer_memory_mb',
  'gpu_memory_mb',
  'ready_ms',
  'window_ms',
  'shell_ready_ms',
  'compute_duration_ms',
  'job_duration_ms',
  'update_waiting_minutes',
  'poll_count',
]);
const HANG_PHASES = new Set(['detected', 'resolved']);
const HANG_SOURCES = new Set(['heartbeat', 'chromium']);
const HANG_RESOLUTIONS = new Set(['recovered', 'reloaded', 'crashed', 'window_closed', 'app_quit']);
const CHILD_PROCESS_TYPES = new Set([
  'renderer',
  'gpu',
  'utility',
  'zygote',
  'sandbox_helper',
  'pepper_plugin',
  'pepper_plugin_broker',
  'unknown',
]);
const PROCESS_GONE_REASONS = new Set([
  'clean_exit',
  'abnormal_exit',
  'killed',
  'crashed',
  'oom',
  'launch_failed',
  'integrity_failure',
  'memory_eviction',
  'unknown',
]);
const EXIT_SIGNALS = new Set([
  'sigabrt',
  'sigbus',
  'sigfpe',
  'sighup',
  'sigill',
  'sigint',
  'sigkill',
  'sigpipe',
  'sigsegv',
  'sigterm',
  'sigtrap',
  'other',
]);
const BUCKET_VALUE_RE =
  /^(?:0|1|2_5|6_20|21_100|100_plus|lt_1s|1_5s|5_30s|30s_plus|0_1|2_3|4_plus|unknown)$/;
const SAFE_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_INVITE_ID_RE = /^bti_[a-f0-9]{16}$/;
const SAFE_VERSION_RE = /^[0-9]+(?:\.[0-9]+){0,3}(?:[-+][a-z0-9.-]+)?$/i;
const SAFE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_FILE_SIZE_BUCKETS = new Set<string>(SAFE_FILE_SIZE_BUCKETS);

export function isAllowedClosedBetaEvent(eventName: string): eventName is ClosedBetaEvent {
  return CLOSED_BETA_EVENT_SET.has(eventName);
}

export function normalizePlatformFamily(value: unknown): string {
  const normalized =
    value === 'darwin' || value === 'mac'
      ? 'macos'
      : value === 'win32'
        ? 'windows'
        : typeof value === 'string'
          ? value.trim().toLowerCase()
          : 'unknown';
  if (ALLOWED_PLATFORM_FAMILIES.has(normalized)) return normalized;
  return 'unknown';
}

export function normalizeEnvironment(value: unknown): string {
  if (typeof value !== 'string') return 'unknown';
  const normalized = value.trim().toLowerCase();
  return ALLOWED_ENVIRONMENTS.has(normalized) ? normalized : 'unknown';
}

export function normalizeReleaseChannel(value: unknown): string {
  if (typeof value !== 'string') return 'unknown';
  const normalized = value.trim().toLowerCase();
  return ALLOWED_RELEASE_CHANNELS.has(normalized) ? normalized : 'unknown';
}

export function sanitizeClosedBetaProperties(
  properties: Record<string, unknown> | undefined,
  defaults: Record<string, unknown> = {}
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  const merged = { ...properties, ...defaults };

  for (const [key, value] of Object.entries(merged)) {
    const safe = sanitizeProperty(key, value);
    if (safe !== undefined) {
      sanitized[key] = safe;
    }
  }
  if (sanitized.telemetry_actor !== 'ci') delete sanitized.ci_run_id;

  return sanitized;
}

type PropertySanitizer = (value: unknown) => unknown;

const BUILD_TAG_RE = /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/;
const OS_MAJOR_STRING_RE = /^[0-9]{1,2}$/;

function versionString(value: unknown): unknown {
  return typeof value === 'string' && SAFE_VERSION_RE.test(value) ? value : undefined;
}

function buildTag(value: unknown): unknown {
  return typeof value === 'string' && BUILD_TAG_RE.test(value) ? value : undefined;
}

function integerVersion(value: unknown): unknown {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function fromToVersion(value: unknown): unknown {
  if (typeof value === 'string' && SAFE_VERSION_RE.test(value)) return value;
  return isFiniteNonnegativeNumber(value) ? value : undefined;
}

function osMajorVersion(value: unknown): unknown {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 99) {
    return value;
  }
  if (typeof value === 'string' && OS_MAJOR_STRING_RE.test(value)) return value;
  return undefined;
}

function enumOf(allowed: Set<string>): PropertySanitizer {
  return (value) => enumValue(value, allowed);
}

const notebookErrorCodes = new Set<string>(NOTEBOOK_ERROR_CODES);
const notebookCode: PropertySanitizer = (value) =>
  typeof value === 'string' && notebookErrorCodes.has(value) ? value : undefined;

function bucketString(value: unknown): unknown {
  return typeof value === 'string' && BUCKET_VALUE_RE.test(value) ? value : undefined;
}

function codeString(value: unknown): unknown {
  return typeof value === 'string' && SAFE_CODE_RE.test(value) ? value : undefined;
}

function boundedLabel(value: unknown): unknown {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed) return undefined;
  if (trimmed.length >= 24 && /^[acgtunrykswmbdhv\s]+$/i.test(trimmed)) return undefined;
  return trimmed.slice(0, 120);
}

function structuralId(value: unknown): unknown {
  return typeof value === 'string' && /^[A-Za-z0-9_:-]{1,120}$/.test(value) ? value : undefined;
}

function finiteNumber(value: unknown): unknown {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function uuidString(value: unknown): unknown {
  return typeof value === 'string' && SAFE_UUID_RE.test(value) ? value.toLowerCase() : undefined;
}

function codeOrUnknown(value: unknown): unknown {
  if (typeof value !== 'string') return undefined;
  return SAFE_CODE_RE.test(value) ? value : 'unknown';
}

function rejectedPropertyKeys(value: unknown): unknown {
  if (typeof value !== 'string') return undefined;
  const safeKeys = value
    .split(',')
    .filter((candidate) => SAFE_CODE_RE.test(candidate))
    .slice(0, 16);
  return safeKeys.length > 0 ? safeKeys.join(',') : undefined;
}

function inviteId(value: unknown): unknown {
  return typeof value === 'string' && SAFE_INVITE_ID_RE.test(value) ? value : undefined;
}

function durationMs(value: unknown): unknown {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 86_400_000
    ? value
    : undefined;
}

function sizeBucket(value: unknown): unknown {
  if (typeof value !== 'string') return undefined;
  if (ALLOWED_OVERSIZE_SIZE_BUCKETS.has(value)) return value;
  return enumValue(value, ALLOWED_FILE_SIZE_BUCKETS);
}

function boolValue(value: unknown): unknown {
  return typeof value === 'boolean' ? value : undefined;
}

function digestCount(value: unknown): unknown {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_DIGEST_OBSERVATION_COUNT
    ? value
    : undefined;
}

function exitCode(value: unknown): unknown {
  return typeof value === 'number' && Number.isInteger(value) && Math.abs(value) <= 4_294_967_295
    ? value
    : undefined;
}

function nonnegativeNumber(value: unknown): unknown {
  return isFiniteNonnegativeNumber(value) ? value : undefined;
}

function literalEnumOf(values: readonly string[]): PropertySanitizer {
  const allowed = new Set(values);
  return (value) => (typeof value === 'string' && allowed.has(value) ? value : undefined);
}

const PROPERTY_SANITIZERS: Record<string, PropertySanitizer> = {
  translation_copy_strand: enumOf(new Set(TRANSLATION_COPY_STRANDS)),
  translation_copy_frame: enumOf(new Set(TRANSLATION_COPY_FRAMES)),
  translation_copy_code: enumOf(new Set(TRANSLATION_COPY_CODES)),
  translation_copy_result: enumOf(new Set(TRANSLATION_COPY_RESULTS)),
  translation_copy_length_bucket: enumOf(new Set(TRANSLATION_COPY_LENGTH_BUCKETS)),
  orf_display_source: enumOf(new Set(ORF_DETECTION_SOURCES)),
  orf_display_result: enumOf(new Set(ORF_DISPLAY_RESULTS)),
  orf_display_surface: enumOf(new Set(ORF_DISPLAY_SURFACES)),
  orf_display_result_count_bucket: enumOf(new Set(ORF_DETECTION_COUNT_BUCKETS)),
  orf_detection_source: enumOf(new Set(ORF_DETECTION_SOURCES)),
  orf_detection_result: enumOf(new Set(ORF_DETECTION_RESULTS)),
  orf_detection_sequence_length_bucket: enumOf(new Set(ORF_DETECTION_COUNT_BUCKETS)),
  orf_detection_result_count_bucket: enumOf(new Set(ORF_DETECTION_COUNT_BUCKETS)),
  sequence_search_navigation_result: enumOf(new Set(SEQUENCE_SEARCH_NAVIGATION_RESULTS)),
  sequence_search_navigation_surface: enumOf(new Set(SEQUENCE_SEARCH_NAVIGATION_SURFACES)),
  sequence_search_source: enumOf(new Set(SEQUENCE_SEARCH_SOURCES)),
  sequence_search_mode: enumOf(new Set(SEQUENCE_SEARCH_MODES)),
  sequence_search_topology: enumOf(new Set(SEQUENCE_SEARCH_TOPOLOGIES)),
  sequence_search_result: enumOf(new Set(SEQUENCE_SEARCH_RESULTS)),
  sequence_search_query_length_bucket: enumOf(new Set(SEQUENCE_SEARCH_COUNT_BUCKETS)),
  sequence_search_sequence_length_bucket: enumOf(new Set(SEQUENCE_SEARCH_COUNT_BUCKETS)),
  sequence_search_match_count_bucket: enumOf(new Set(SEQUENCE_SEARCH_COUNT_BUCKETS)),
  table_operation: enumOf(new Set(TABLE_OPERATIONS)),
  table_surface: enumOf(new Set(TABLE_SURFACES)),
  table_calculation_result: enumOf(new Set(TABLE_CALCULATION_RESULTS)),
  ...Object.fromEntries(
    [
      'table_rows',
      'table_columns',
      'table_formula_count',
      'table_calculation_error_count',
      'table_saved_result_count',
      'table_stale_result_count',
      'table_saved_result_unavailable_count',
    ].map((key) => [
      key,
      (value: unknown) =>
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value >= 0 &&
        value <= MAX_TABLE_OBSERVATION_COUNT
          ? value
          : undefined,
    ])
  ),
  $insert_id: uuidString,
  presentation_id: uuidString,
  notification_id: uuidString,
  notification_definition: notificationDefinition,
  notification_variant: notificationVariant,
  notification_severity: enumOf(new Set(['warning', 'error'])),
  notebook_operation: enumOf(new Set(NOTEBOOK_OPERATION_KINDS)),
  notebook_phase: enumOf(new Set(['started', 'completed', 'failed'])),
  notebook_error_code: notebookCode,
  notebook_state_changed: enumOf(new Set(['yes', 'no', 'unknown'])),
  notebook_dirty: (value) => (typeof value === 'boolean' ? value : undefined),
  notebook_saving: (value) => (typeof value === 'boolean' ? value : undefined),
  notebook_recovery: (value) => (typeof value === 'boolean' ? value : undefined),
  notebook_read_only: (value) => (typeof value === 'boolean' ? value : undefined),
  reload_stage: enumOf(new Set(NOTEBOOK_RELOAD_STAGES)),
  reload_reason: notebookCode,
  auth_vendor: enumOf(new Set(AUTH_STATE_VENDORS)),
  auth_stage: enumOf(new Set(AUTH_STATE_STAGES)),
  auth_outcome: enumOf(new Set(AUTH_STATE_OUTCOMES)),
  auth_reason: enumOf(new Set(AUTH_STATE_REASONS)),
  preference_stage: enumOf(new Set(MODEL_PREFERENCE_STAGES)),
  preference_outcome: enumOf(new Set(MODEL_PREFERENCE_OUTCOMES)),
  preference_route_kind: enumOf(new Set(MODEL_PREFERENCE_ROUTES)),
  preference_selection_source: enumOf(new Set(MODEL_PREFERENCE_SELECTION_SOURCES)),
  preference_model_source: enumOf(new Set(MODEL_PREFERENCE_MODEL_SOURCES)),
  preference_failure_code: enumOf(new Set(MODEL_PREFERENCE_FAILURE_CODES)),
  notes_source: enumOf(new Set(RELEASE_NOTES_SOURCES)),
  notes_phase: enumOf(new Set(RELEASE_NOTES_PHASES)),
  notes_close_reason: enumOf(new Set(RELEASE_NOTES_CLOSE_REASONS)),
  notes_requested_kind: enumOf(new Set(RELEASE_NOTES_REQUEST_KINDS)),
  notes_artifact_kind: enumOf(new Set(RELEASE_NOTES_ARTIFACT_KINDS)),
  notes_requested_version: sanitizeReleaseNoteIdentity,
  notes_displayed_version: sanitizeReleaseNoteIdentity,
  notes_installed_version: sanitizeReleaseBuildIdentity,
  notes_source_version: sanitizeReleaseBuildIdentity,
  notes_result: enumOf(new Set(['available', 'missing'])),
  notes_capability: enumOf(new Set(['information_only'])),
  skills_action: enumOf(new Set(SKILL_ACTIONS)),
  skills_stage: enumOf(new Set(SKILL_STAGES)),
  skills_result: enumOf(new Set(SKILL_RESULTS)),
  skills_host: enumOf(new Set(SKILL_HOSTS)),
  skills_scope: enumOf(new Set(SKILL_SCOPES)),
  skills_source: enumOf(new Set(SKILL_SOURCES)),
  skills_authority: enumOf(new Set(SKILL_AUTHORITIES)),
  skills_freshness: enumOf(new Set(SKILL_FRESHNESS)),
  skills_installed: enumOf(new Set(['installed', 'not_attested'])),
  skills_stored_enablement: enumOf(new Set(SKILL_ENABLEMENT)),
  skills_effective_enablement: enumOf(new Set(SKILL_ENABLEMENT)),
  skills_runtime_discovery: enumOf(new Set(SKILL_RUNTIME)),
  skills_instruction_load: enumOf(new Set(SKILL_INSTRUCTION)),
  skills_task_reuse: enumOf(new Set(['not_attested'])),
  skills_operation_relation: enumOf(new Set(['observation_only_native_not_exported'])),
  skills_occurrence_clock: enumOf(new Set(['client', 'native_domain'])),
  skills_observation_clock: enumOf(new Set(['native_or_client_observed', 'unknown'])),
  skills_observed_at_ms: nonnegativeNumber,
  app_version: versionString,
  version: fromToVersion,
  build_version: versionString,
  build_tag: buildTag,
  db_version: integerVersion,
  from_version: fromToVersion,
  to_version: fromToVersion,
  release_channel: normalizeReleaseChannel,
  platform_family: normalizePlatformFamily,
  environment: normalizeEnvironment,
  os_major_version: osMajorVersion,
  feature_area: enumOf(ALLOWED_FEATURE_AREAS),
  tool_id: enumOf(ALLOWED_TOOL_IDS),
  surface: enumOf(ALLOWED_TOOL_SURFACES),
  component: enumOf(
    new Set(
      [
        'feature',
        'primer-handle',
        'backbone-boundary-handle',
        'backbone-part',
        'codon',
        'cut-site',
        'orf',
        'pileup-column',
        'read',
      ].map((kind) => `sequence-viewer.${kind}`)
    )
  ),
  action: enumOf(ALLOWED_TOOL_ACTIONS),
  attempted_action: enumOf(ALLOWED_TOOL_ACTIONS),
  search_activity_role: enumOf(new Set(['first_result', 'continuation', 'superseded'])),
  search_query_revision: (value) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined,
  lifecycle_scope: enumOf(new Set(['local_profile', 'process_session'])),
  workspace_source: enumOf(ALLOWED_WORKSPACE_SOURCES),
  workspace_kind: enumOf(ALLOWED_WORKSPACE_KINDS),
  source_surface: enumOf(ALLOWED_SOURCE_SURFACES),
  file_count_bucket: enumOf(ALLOWED_FILE_COUNT_BUCKETS),
  source_system_type: enumOf(ALLOWED_SOURCE_SYSTEM_TYPES),
  file_type_category: enumOf(ALLOWED_FILE_TYPE_CATEGORIES),
  extension_category: enumOf(ALLOWED_FILE_TYPE_CATEGORIES),
  failure_stage: enumOf(ALLOWED_FAILURE_STAGES),
  telemetry_mode: enumOf(ALLOWED_TELEMETRY_MODES),
  telemetry_actor: normalizeTelemetryActor,
  runtime_origin_class: sanitizeTelemetryOriginClassification,
  ci_run_id: sanitizeCiRunId,
  internal_operator: classifyInternalOperator,
  record_count_bucket: bucketString,
  import_duration_bucket: bucketString,
  unsupported_field_count_bucket: bucketString,
  duration_bucket: (value) =>
    enumValue(value, ALLOWED_AI_TURN_DURATION_BUCKETS) ?? bucketString(value),
  retry_count_bucket: bucketString,
  screen_category: enumOf(ALLOWED_SCREEN_CATEGORIES),
  route_category: codeString,
  network_state_category: codeString,
  setting: codeString,
  stage: enumOf(ALLOWED_OPERATION_STAGES),
  route: enumOf(ALLOWED_AI_TURN_ROUTES),
  qualification_basis: enumOf(ALLOWED_AI_TURN_QUALIFICATION_BASES),
  update_qualification: enumOf(
    new Set([
      'exact_install_intent',
      'exact_download_marker',
      'legacy_bridge',
      'late_intent_transition',
    ])
  ),
  initiated_by: enumOf(ALLOWED_AI_TURN_INITIATORS),
  reason_code: enumOf(new Set([...ALLOWED_AI_TURN_REASON_CODES, ...TOOL_ERROR_REASON_CODES])),
  failure_class: enumOf(ALLOWED_AI_TURN_FAILURE_CLASSES),
  effect_state: enumOf(ALLOWED_AI_TURN_EFFECT_STATES),
  trace_state: enumOf(ALLOWED_AI_TURN_TRACE_STATES),
  settlement_state: enumOf(ALLOWED_AI_TURN_SETTLEMENT_STATES),
  provider_attempt_count_bucket: enumOf(ALLOWED_AI_TURN_COUNT_BUCKETS),
  tool_call_count_bucket: enumOf(ALLOWED_AI_TURN_COUNT_BUCKETS),
  workspace_tool_count_bucket: enumOf(ALLOWED_AI_TURN_COUNT_BUCKETS),
  terminal_stage: enumOf(ALLOWED_OPERATION_STAGES),
  operation: enumOf(ALLOWED_MIGRATION_OPERATIONS),
  source_kind: enumOf(ALLOWED_MIGRATION_SOURCE_KINDS),
  source: enumOf(ALLOWED_NOTEBOOK_MIGRATION_SOURCES),
  scope_kind: enumOf(ALLOWED_MIGRATION_SCOPE_KINDS),
  outcome: enumOf(ALLOWED_OUTCOMES),
  prior_outcome: enumOf(ALLOWED_OUTCOMES),
  disposition: enumOf(ALLOWED_DISPOSITIONS),
  issue_code: enumOf(ALLOWED_MIGRATION_ISSUE_CODES),
  primary_issue_code: enumOf(ALLOWED_MIGRATION_PRIMARY_ISSUE_CODES),
  reason: enumOf(
    new Set([
      ...ALLOWED_UPDATE_REASONS,
      ...PROCESS_GONE_REASONS,
      'clean-exit',
      'abnormal-exit',
      'launch-failed',
      'integrity-failure',
      'memory-eviction',
    ])
  ),
  ext_bucket: enumOf(ALLOWED_OVERSIZE_EXT_BUCKETS),
  decision: enumOf(ALLOWED_OVERSIZE_DECISIONS),
  digest_topology: enumOf(new Set(DIGEST_TOPOLOGIES)),
  digest_readiness: enumOf(new Set(DIGEST_READINESS_STATES)),
  digest_trigger: enumOf(new Set(DIGEST_TRIGGERS)),
  digest_cut_count: digestCount,
  digest_enzyme_count: digestCount,
  workflow: enumOf(ALLOWED_WORKFLOWS),
  workflow_action: enumOf(ALLOWED_WORKFLOW_ACTIONS),
  action_phase: enumOf(ALLOWED_WORKFLOW_PHASES),
  workflow_status: enumOf(ALLOWED_WORKFLOW_STATUSES),
  assembly_compute_stage: enumOf(new Set(ASSEMBLY_COMPUTE_STAGES)),
  assembly_material_route: enumOf(new Set(ASSEMBLY_MATERIAL_ROUTES)),
  assembly_method: enumOf(new Set(ASSEMBLY_METHODS)),
  export_format: enumOf(new Set(EXPORT_FORMATS)),
  bases_inserted_bucket: bucketString,
  bases_deleted_bucket: bucketString,
  bases_substituted_bucket: bucketString,
  agent_tool_name: codeString,
  pcr_template_count: (value) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 100000
      ? value
      : undefined,
  workflow_origin: enumOf(new Set(WORKFLOW_ORIGINS)),
  record_write_status: enumOf(new Set(RECORD_WRITE_STATUSES)),
  record_projection_status: enumOf(new Set(RECORD_PROJECTION_STATUSES)),
  record_history_status: enumOf(new Set(RECORD_HISTORY_STATUSES)),
  outcome_kind: enumOf(ALLOWED_WORKFLOW_OUTCOME_KINDS),
  revision_relation: enumOf(new Set<string>(WORKFLOW_REVISION_RELATIONS)),
  identity_kind: enumOf(ALLOWED_IDENTITY_KINDS),
  actor_kind: enumOf(ALLOWED_ACTOR_KINDS),
  execution_mode: enumOf(ALLOWED_EXECUTION_MODES),
  identity_resolution: enumOf(ALLOWED_IDENTITY_RESOLUTIONS),
  auth_provider_category: enumOf(ALLOWED_AUTH_PROVIDER_CATEGORIES),
  rejection_reason: enumOf(ALLOWED_REJECTION_REASONS),
  rejected_event: codeOrUnknown,
  close_reason: codeOrUnknown,
  rejected_property_keys: rejectedPropertyKeys,
  error_code: codeString,
  beta_cohort: codeString,
  invite_batch: codeString,
  pseudonymous_account_id: codeString,
  pseudonymous_workspace_id: codeString,

  error_class: codeString,
  streak_count: (value) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined,
  event_type: boundedLabel,
  event_phase: boundedLabel,
  target_tag: boundedLabel,
  control_id: enumOf(new Set(STATIC_INTERACTION_CONTROLS)),
  control_relation: enumOf(new Set(['direct', 'ancestor'])),
  target_role: boundedLabel,
  target_id: structuralId,
  target_test_id: structuralId,
  target_name: structuralId,
  target_class: boundedLabel,
  input_type: boundedLabel,
  modifiers: boundedLabel,
  pointer_type: boundedLabel,
  data_transfer_types: boundedLabel,
  delta_x: finiteNumber,
  delta_y: finiteNumber,
  delta_z: finiteNumber,
  scroll_left: finiteNumber,
  scroll_top: finiteNumber,
  beta_invite_id: inviteId,
  genome_generation_id: uuidString,
  viewport_operation_id: uuidString,
  genome_stage: enumOf(new Set(INDEXED_GENOME_STAGES)),
  genome_origin: enumOf(new Set(INDEXED_GENOME_ORIGINS)),
  genome_reason: enumOf(new Set(INDEXED_GENOME_REASONS)),
  genome_started_at_ms: nonnegativeNumber,
  viewport_started_at_ms: nonnegativeNumber,
  sanger_read_revision_id: uuidString,
  sanger_view_id: uuidString,
  sanger_stage: literalEnumOf(SANGER_READ_STAGES),
  sanger_origin: literalEnumOf(SANGER_READ_ORIGINS),
  sanger_classification: literalEnumOf(SANGER_READ_CLASSIFICATIONS),
  sanger_reason: literalEnumOf(SANGER_READ_REASONS),
  sanger_started_at_ms: nonnegativeNumber,
  sanger_parse_started_at_ms: nonnegativeNumber,
  sanger_view_started_at_ms: nonnegativeNumber,
  sanger_viewport_kind: literalEnumOf(SANGER_READ_VIEWPORT_KINDS),
  sanger_trace_available: boolValue,
  sanger_quality_available: boolValue,
  sanger_trace_visible: boolValue,
  sanger_quality_visible: boolValue,
  sanger_bases_visible: boolValue,
  pdf_generation_id: uuidString,
  pdf_citation_id: uuidString,
  pdf_stage: enumOf(
    new Set([
      'accepted',
      'parsed',
      'canvas_complete',
      'text_ready',
      'text_unavailable',
      'page_presented',
      'first_page_presented',
      'failed',
      'cancelled',
      'retry',
      'identity_refused',
      'citation_requested',
      'citation_arrived',
    ])
  ),
  pdf_reason: enumOf(
    new Set(['none', 'load', 'page', 'canvas', 'text', 'closed', 'superseded', 'source_identity'])
  ),
  pdf_origin: enumOf(new Set(['explicit', 'restored', 'reload'])),
  pdf_visibility: enumOf(new Set(['foreground', 'background'])),
  pdf_started_at_ms: nonnegativeNumber,
  feedback_stage: enumOf(
    new Set([
      'accepted_intent',
      'durable_queue',
      'backend_accepted',
      'retry',
      'deferred',
      'refused',
      'cancelled',
    ])
  ),
  feedback_reason: enumOf(
    new Set([
      'none',
      'invalid_payload',
      'submission_conflict',
      'queue_corrupt',
      'queue_full',
      'storage_unavailable',
      'service_unavailable',
      'transport_unavailable',
      'timeout',
      'permanent_refusal',
      'delivery_unconfirmed',
      'cancelled',
    ])
  ),
  feedback_origin: enumOf(new Set(['current', 'restored'])),
  feedback_origin_class: enumOf(new Set(['synthetic', 'private', 'unknown', 'eligible_release'])),
  workspace_origin_class: enumOf(new Set(['synthetic', 'private', 'unknown', 'eligible_release'])),
  feedback_attempt_bucket: enumOf(new Set(['first', 'retry', 'many'])),
  operation_id: uuidString,
  jobs_action: enumOf(new Set(JOB_MANAGEMENT_ACTIONS)),
  jobs_stage: enumOf(new Set(JOB_MANAGEMENT_STAGES)),
  jobs_phase: enumOf(new Set(JOB_MANAGEMENT_PHASES)),
  jobs_result: enumOf(new Set(JOB_MANAGEMENT_RESULTS)),
  jobs_authority: enumOf(new Set(JOB_MANAGEMENT_AUTHORITIES)),
  jobs_owner: enumOf(new Set(JOB_MANAGEMENT_OWNERS)),
  jobs_freshness: enumOf(new Set(JOB_MANAGEMENT_FRESHNESS)),
  jobs_execution_mode: enumOf(new Set(JOB_MANAGEMENT_MODES)),
  jobs_origin: enumOf(new Set(JOB_MANAGEMENT_ORIGINS)),
  jobs_result_availability: enumOf(new Set(JOB_MANAGEMENT_AVAILABILITY)),
  jobs_execution_state: enumOf(new Set(JOB_MANAGEMENT_STATES)),
  jobs_history_coverage: enumOf(new Set(JOB_MANAGEMENT_HISTORY)),
  jobs_scope: enumOf(new Set(JOB_MANAGEMENT_SCOPES)),
  jobs_operation_relation: enumOf(new Set(['action_only_native_not_exported'])),
  jobs_context_basis: enumOf(
    new Set(['intent_snapshot', 'intent_and_outcome', 'record_observation'])
  ),
  jobs_observation_clock: enumOf(new Set(['client_observed', 'unknown'])),
  jobs_observed_at_ms: nonnegativeNumber,

  history_action: enumOf(new Set(HISTORY_ACTIONS)),
  history_source: enumOf(new Set(HISTORY_SOURCES)),
  history_phase: enumOf(new Set(HISTORY_PHASES)),
  history_stage: enumOf(new Set(HISTORY_STAGES)),
  history_result: enumOf(new Set(HISTORY_RESULTS)),
  history_freshness: enumOf(new Set(HISTORY_FRESHNESS)),
  history_authority: enumOf(new Set(HISTORY_AUTHORITIES)),
  history_availability: enumOf(new Set(HISTORY_AVAILABILITY)),
  history_replacement: enumOf(new Set(HISTORY_REPLACEMENTS)),
  history_pane_role: enumOf(new Set(HISTORY_PANE_ROLES)),
  history_pin_state: enumOf(new Set(HISTORY_PIN_STATES)),
  history_match_bucket: enumOf(new Set(HISTORY_MATCH_BUCKETS)),
  history_shadow_cleanup: (value) => (value === 'NOT_ATTESTED' ? value : undefined),
  history_pane_generation_id: uuidString,
  history_parent_operation_id: uuidString,
  history_presented_generation_id: uuidString,

  access_stage: enumOf(new Set(EXTERNAL_ACCESS_ENUMS.access_stage)),
  access_result: enumOf(new Set(EXTERNAL_ACCESS_ENUMS.access_result)),
  access_client: enumOf(new Set(EXTERNAL_ACCESS_ENUMS.access_client)),
  access_transport: enumOf(new Set(EXTERNAL_ACCESS_ENUMS.access_transport)),
  access_scope_class: enumOf(new Set(EXTERNAL_ACCESS_ENUMS.access_scope_class)),
  access_expiry_class: enumOf(new Set(EXTERNAL_ACCESS_ENUMS.access_expiry_class)),
  access_authority: enumOf(new Set(EXTERNAL_ACCESS_ENUMS.access_authority)),
  access_execution: enumOf(new Set(EXTERNAL_ACCESS_ENUMS.access_execution)),
  access_usefulness: enumOf(new Set(EXTERNAL_ACCESS_ENUMS.access_usefulness)),
  project_phase: enumOf(new Set(PROJECT_LIFECYCLE_PHASES)),
  project_stage: enumOf(new Set(PROJECT_LIFECYCLE_STAGES)),
  project_source: enumOf(new Set(PROJECT_LIFECYCLE_SOURCES)),
  project_open_mode: enumOf(new Set(PROJECT_OPEN_MODES)),
  project_authority: enumOf(new Set(PROJECT_AUTHORITIES)),
  duration_ms: durationMs,
  size_bucket: sizeBucket,
  compute_provider: codeString,
  compute_tool: codeString,
  job_phase: enumOf(
    new Set(['submitted', 'completed', 'failed', 'canceled', 'imported', 'interrupted'])
  ),
  job_kind: codeString,
  view_phase: enumOf(new Set(['ready', 'failed', 'abandoned'])),
  genome_source: enumOf(new Set(['catalog', 'local_reference', 'indexed_file'])),
  install_phase: enumOf(new Set<string>(HOSTED_REFERENCE_INSTALL_PHASES)),
  install_stage: enumOf(new Set<string>(HOSTED_REFERENCE_INSTALL_STAGES)),
  sync_operation: enumOf(new Set<string>(WORKSPACE_SYNC_OPERATIONS)),
  sync_outcome: enumOf(new Set<string>(WORKSPACE_SYNC_OUTCOMES)),
  sync_stage: enumOf(new Set<string>(WORKSPACE_SYNC_NATIVE_STAGES)),
  recovery_stage: enumOf(new Set<string>(WORKSPACE_SYNC_RECOVERY_STAGES)),
  sync_access_role: enumOf(new Set<string>(WORKSPACE_SYNC_ACCESS_ROLES)),
  sync_representation: enumOf(new Set<string>(WORKSPACE_SYNC_REPRESENTATIONS)),
  genome_build: (value) =>
    typeof value === 'string' && CATALOG_GENOME_BUILDS.has(value) ? value : undefined,
  track_count_bucket: bucketString,
  analysis_phase: enumOf(new Set(['started', 'completed', 'failed', 'canceled'])),
  read_preset: enumOf(new Set(['sr', 'map-ont', 'lr:hq', 'map-hifi'])),
  read_count_bucket: enumOf(
    new Set(['lt_1k', '1k_10k', '10k_100k', '100k_1m', '1m_10m', '10m_plus', 'unknown'])
  ),
  mapped_fraction_bucket: enumOf(
    new Set(['lt_50', '50_80', '80_95', '95_99', '99_plus', 'unknown'])
  ),
  candidate_count_bucket: bucketString,
  hang_phase: enumOf(HANG_PHASES),
  hang_source: enumOf(HANG_SOURCES),
  hang_resolution: enumOf(HANG_RESOLUTIONS),
  process_type: enumOf(CHILD_PROCESS_TYPES),
  gone_reason: enumOf(PROCESS_GONE_REASONS),
  process_memory: (value) => (value === 'unavailable' ? value : nonnegativeNumber(value)),
  uptime_ms: (value) => (value === 'unavailable' ? value : nonnegativeNumber(value)),
  exit_code: (value) => (value === 'unavailable' ? value : exitCode(value)),
  exit_signal: enumOf(EXIT_SIGNALS),
  previous_app_version: versionString,
  pseudonymous_install_id: uuidString,
  pseudonymous_attempt_id: uuidString,
  pseudonymous_download_id: uuidString,
  telemetry_canary_id: uuidString,
};

for (const key of CORRELATION_UUID_KEYS) {
  PROPERTY_SANITIZERS[key] = uuidString;
}
PROPERTY_SANITIZERS.attempt_correlation_id = uuidString;
for (const key of NONNEGATIVE_NUMBER_KEYS) {
  PROPERTY_SANITIZERS[key] = nonnegativeNumber;
}
for (const key of ALLOWED_BOOL_KEYS) {
  PROPERTY_SANITIZERS[key] = boolValue;
}

export function hasPropertySanitizer(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(PROPERTY_SANITIZERS, key);
}

function sanitizeProperty(key: string, value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  const sanitizer = PROPERTY_SANITIZERS[key];
  if (sanitizer) return sanitizer(value);
  return undefined;
}

function enumValue(value: unknown, allowed: Set<string>): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return allowed.has(normalized) ? normalized : undefined;
}

function isFiniteNonnegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
