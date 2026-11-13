import { TOAST_DEFINITIONS, TOAST_REVIEW_ENTRIES } from '../stores/toast-definitions';

export const NOTEBOOK_OPERATION_KINDS = [
  'schema',
  'search',
  'insert',
  'insert-reference',
  'list',
  'inspect',
  'create',
  'splice-blocks',
  'insert-table',
  'table',
  'rename',
  'undo',
  'redo',
  'save',
  'keep-local',
  'inspect-copy',
  'capture-save',
  'await-save',
  'apply-steps',
  'discard',
  'reload',
  'set-title',
  'table-view',
  'restore-recovery',
  'retain-legacy-recovery',
  'unknown',
] as const;
export const NOTEBOOK_ERROR_CODES = [
  'NOTEBOOK_BINDING_CHANGED',
  'NOTEBOOK_BLOCK_PAYLOAD_INVALID',
  'NOTEBOOK_COMMAND_FAILED',
  'NOTEBOOK_CREATE_FAILED',
  'NOTEBOOK_EXTERNAL_CONFLICT',
  'NOTEBOOK_ID_REQUIRED',
  'NOTEBOOK_LIFECYCLE_BUSY',
  'NOTEBOOK_MARKDOWN_INVALID',
  'NOTEBOOK_MARKDOWN_NEWER_CODEC',
  'NOTEBOOK_NOT_FOUND',
  'NOTEBOOK_OPERATION_TARGET',
  'NOTEBOOK_OWNER_CLOSED',
  'NOTEBOOK_PENDING_BUDGET',
  'NOTEBOOK_READ_ONLY',
  'NOTEBOOK_RECOVERY_ALREADY_RETAINED',
  'NOTEBOOK_RECOVERY_CONFLICT',
  'NOTEBOOK_RECOVERY_MISSING',
  'NOTEBOOK_RECOVERY_PENDING',
  'NOTEBOOK_RENDERER_CHANGED',
  'NOTEBOOK_REQUEST_ID_REUSED',
  'NOTEBOOK_SAVE_CAPTURE_LIMIT',
  'NOTEBOOK_SAVE_CAPTURE_UNAVAILABLE',
  'NOTEBOOK_SAVE_FAILED',
  'STALE_NOTEBOOK',
  'STALE_NOTEBOOK_TRANSACTION',
  'ENOENT',
  'EACCES',
  'EPERM',
  'EIO',
  'ENOSPC',
  'EBUSY',
  'none',
  'unknown',
] as const;
export const NOTEBOOK_RELOAD_STAGES = [
  'watch',
  'external-change',
  'reload',
  'keep-local',
  'unknown',
] as const;
export const AUTH_STATE_VENDORS = ['claude', 'codex', 'grok', 'unknown'] as const;
export const AUTH_STATE_STAGES = [
  'native_result',
  'renderer_accepted',
  'renderer_published',
  'model_enrichment',
] as const;
export const AUTH_STATE_OUTCOMES = [
  'started',
  'succeeded',
  'failed',
  'cancelled',
  'stale',
] as const;
export const AUTH_STATE_REASONS = [
  'none',
  'auth_not_detected',
  'timed_out',
  'not_installed',
  'spawn_error',
  'exit_nonzero',
  'cancelled',
  'handler_error',
  'model_enrichment_failed',
  'superseded',
  'invalid_transport',
  'unknown',
] as const;
export const MODEL_PREFERENCE_STAGES = ['select', 'persist', 'restore', 'discovery'] as const;
export const MODEL_PREFERENCE_OUTCOMES = ['started', 'succeeded', 'failed'] as const;
export const MODEL_PREFERENCE_ROUTES = ['cli', 'provider', 'hosted', 'extension'] as const;
export const MODEL_PREFERENCE_SELECTION_SOURCES = ['explicit', 'computed'] as const;
export const MODEL_PREFERENCE_MODEL_SOURCES = ['catalog', 'custom', 'default'] as const;
export const MODEL_PREFERENCE_FAILURE_CODES = [
  'persist-failed',
  'restore-invalid',
  'catalog-omitted',
  'presentation-mismatch',
  'none',
] as const;

const notebookErrorCodes = new Set<string>(NOTEBOOK_ERROR_CODES);
const notificationVariants = new Set(TOAST_REVIEW_ENTRIES.map((entry) => entry.variant));

export function notebookErrorCode(error: unknown): (typeof NOTEBOOK_ERROR_CODES)[number] {
  if (!error || typeof error !== 'object') return 'unknown';
  const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
  return typeof code === 'string' && notebookErrorCodes.has(code)
    ? (code as (typeof NOTEBOOK_ERROR_CODES)[number])
    : 'unknown';
}

export function notificationDefinition(value: unknown): string | undefined {
  return value === 'uncatalogued' ||
    (typeof value === 'string' && Object.prototype.hasOwnProperty.call(TOAST_DEFINITIONS, value))
    ? (value as string)
    : undefined;
}

export function notificationVariant(value: unknown): string | undefined {
  return typeof value === 'string' && notificationVariants.has(value) ? value : undefined;
}
