import {
  WORKSPACE_SYNC_ACCESS_ROLES,
  type WorkspaceSyncAccessRole,
  type WorkspaceSyncOperation,
  type WorkspaceSyncOutcome,
  type WorkspaceSyncRepresentation,
} from '../shared/workspace-sync-telemetry';

export type WorkspaceSyncObservation = {
  readonly feature_area: 'workspace';
  readonly sync_operation: WorkspaceSyncOperation;
  readonly sync_outcome: WorkspaceSyncOutcome;
  readonly error_code?: string;
  readonly sync_attempt_count?: number;
  readonly duration_ms?: number;
  readonly is_first_upload?: boolean;
  readonly is_shared?: boolean;
  readonly sync_access_role?: WorkspaceSyncAccessRole;
  readonly size_bucket?: string;
  readonly file_count_bucket?: string;
  readonly sync_representation?: WorkspaceSyncRepresentation;
};

type WorkspaceSyncObservationSink = (observation: WorkspaceSyncObservation) => unknown;

const SYNC_ERROR_CODES = new Set([
  'signed_out',
  'session_revoked',
  'account_changed',
  'account_paused',
  'network',
  'conflict',
  'sync_conflict',
  'idempotency_conflict',
  'manifest_restore_required',
  'recovery_candidate_expired',
  'recovery_capture_only',
  'quota_exceeded',
  'rate_limited',
  'server',
  'bad_response',
  'bad_bundle',
  'validation',
  'feature_disabled',
  'forbidden',
  'not_found',
  'not_configured',
  'invalid_bundle',
  'invalid_text_encoding',
  'invalid_request',
  'bundle_too_large',
  'bundle_wire_too_large',
  'no_included_files',
  'local_capture_obsolete',
  'missing_remote_binding',
  'durable_upload_invalid',
  'replica_recovery_required',
  'package_recovery_required',
  'shared_file_ownership_required',
  'unsupported_authoritative_state',
  'remote_pull_invalid',
  'sync_disabled',
  'stale_lock_reclaimed',
  'workspace_trashed',
  'workspace_archived',
  'workspace_not_found',
  'workspace_not_managed',
  'enoent',
  'eexist',
  'eacces',
  'enospc',
  'renderer_delivery_pending',
  'unknown',
]);
const ACCESS_ROLES: ReadonlySet<string> = new Set(WORKSPACE_SYNC_ACCESS_ROLES);
const REPORTED_LIMIT = 2_000;

let sink: WorkspaceSyncObservationSink | null = null;
const reported = new Set<string>();
const lastOrgRegistryOutcome = new Map<string, string>();

export function bindWorkspaceSyncObservationSink(next: WorkspaceSyncObservationSink | null): void {
  sink = next;
}

export function observeWorkspaceSync(
  observation: Omit<WorkspaceSyncObservation, 'feature_area'>,
  onceKey?: string
): void {
  try {
    if (onceKey !== undefined) {
      if (reported.has(onceKey)) return;
      if (reported.size >= REPORTED_LIMIT) reported.clear();
      reported.add(onceKey);
    }
    sink?.({ feature_area: 'workspace', ...observation });
  } catch {}
}

export function observeWorkspaceSyncReconcile(
  workspaceKey: string,
  result: { ok: true; outcome: string } | { ok: false; code: string }
): void {
  if (!result.ok) {
    const errorCode = workspaceSyncErrorCode(result.code);
    observeWorkspaceSync(
      { sync_operation: 'reconcile', sync_outcome: 'failed', error_code: errorCode },
      `reconcile:${workspaceKey}:failed:${errorCode}`
    );
    return;
  }
  const outcome =
    result.outcome === 'merged'
      ? 'merged'
      : result.outcome === 'conflicts'
        ? 'conflict'
        : 'no_remote_change';
  observeWorkspaceSync(
    { sync_operation: 'reconcile', sync_outcome: outcome },
    outcome === 'merged' ? undefined : `reconcile:${workspaceKey}:${outcome}`
  );
}

export function observeOrgRegistrySync(
  orgKey: string,
  synced:
    | { ok: false }
    | {
        ok: true;
        sync: { status: string; conflictCount?: number; errorCode?: string };
      }
    | { thrown: unknown }
): void {
  const observation: Omit<WorkspaceSyncObservation, 'feature_area'> =
    'thrown' in synced
      ? {
          sync_operation: 'org_registry',
          sync_outcome: 'failed',
          error_code: workspaceSyncErrorCode(synced.thrown),
        }
      : !synced.ok
        ? { sync_operation: 'org_registry', sync_outcome: 'failed', error_code: 'other' }
        : synced.sync.status === 'ready'
          ? {
              sync_operation: 'org_registry',
              sync_outcome: (synced.sync.conflictCount ?? 0) > 0 ? 'conflict' : 'synchronized',
            }
          : synced.sync.status === 'not_configured'
            ? { sync_operation: 'org_registry', sync_outcome: 'not_configured' }
            : synced.sync.status === 'access_revoked'
              ? { sync_operation: 'org_registry', sync_outcome: 'access_removed' }
              : {
                  sync_operation: 'org_registry',
                  sync_outcome: 'failed',
                  error_code: workspaceSyncErrorCode(synced.sync.errorCode),
                };
  const state = `${observation.sync_outcome}:${observation.error_code ?? ''}`;
  if (lastOrgRegistryOutcome.get(orgKey) === state) return;
  if (lastOrgRegistryOutcome.size >= REPORTED_LIMIT) lastOrgRegistryOutcome.clear();
  lastOrgRegistryOutcome.set(orgKey, state);
  observeWorkspaceSync(observation);
}

export function workspaceSyncErrorCode(value: unknown): string {
  const code =
    typeof value === 'object' && value !== null && 'code' in value
      ? (value as { code?: unknown }).code
      : value;
  const normalized = typeof code === 'string' ? code.toLowerCase() : '';
  return SYNC_ERROR_CODES.has(normalized) ? normalized : 'other';
}

export function workspaceSyncAccessRole(role: string | null | undefined): WorkspaceSyncAccessRole {
  return role && ACCESS_ROLES.has(role) ? (role as WorkspaceSyncAccessRole) : 'unknown';
}

export function workspaceSyncVersionFacts(
  version: { sizeBytes?: unknown; fileCount?: unknown; representation?: unknown } | undefined
): Pick<WorkspaceSyncObservation, 'size_bucket' | 'file_count_bucket' | 'sync_representation'> {
  if (!version) return {};
  return {
    ...(typeof version.sizeBytes === 'number'
      ? { size_bucket: sizeBucket(version.sizeBytes) }
      : {}),
    ...(typeof version.fileCount === 'number'
      ? { file_count_bucket: fileCountBucket(version.fileCount) }
      : {}),
    sync_representation:
      version.representation === 'bundle_v1' || version.representation === 'manifest_v1'
        ? version.representation
        : 'unknown',
  };
}

function sizeBucket(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  if (bytes === 0) return '0';
  if (bytes < 10 * 1024) return '1_10kb';
  if (bytes < 100 * 1024) return '10_100kb';
  if (bytes < 1024 * 1024) return '100kb_1mb';
  if (bytes < 10 * 1024 * 1024) return '1_10mb';
  return '10mb_plus';
}

function fileCountBucket(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '0';
  if (count === 1) return '1';
  if (count <= 5) return '2_5';
  if (count <= 20) return '6_20';
  if (count <= 100) return '21_100';
  return '100_plus';
}

export function __resetWorkspaceSyncObservationForTests(): void {
  sink = null;
  reported.clear();
  lastOrgRegistryOutcome.clear();
}
