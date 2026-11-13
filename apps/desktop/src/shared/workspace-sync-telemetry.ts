export const WORKSPACE_SYNC_OPERATIONS = [
  'upload',
  'pull',
  'restore',
  'conflict_resolve',
  'reconcile',
  'delete_remote',
  'share_import',
  'org_registry',
] as const;

export const WORKSPACE_SYNC_OUTCOMES = [
  'uploaded',
  'unchanged',
  'in_progress',
  'retry_wait',
  'failed',
  'pulled',
  'conflict',
  'access_removed',
  'restored',
  'reused_local',
  'kept_local',
  'used_remote',
  'merged',
  'no_remote_change',
  'deleted',
  'imported',
  'synchronized',
  'not_configured',
] as const;

export const WORKSPACE_SYNC_NATIVE_STAGES = [
  'accepted',
  'restored',
  'uploaded',
  'unchanged',
  'failed',
] as const;

export const WORKSPACE_SYNC_RECOVERY_STAGES = ['accepted', 'retained'] as const;

export function isWorkspaceSyncReceiptEvent(event: string): boolean {
  return (
    event === 'workspace_sync_stage' ||
    event === 'workspace_recovery_stage' ||
    event === 'workspace_backup_enabled'
  );
}

export const WORKSPACE_SYNC_ACCESS_ROLES = [
  'owner',
  'manager',
  'editor',
  'viewer',
  'unknown',
] as const;

export const WORKSPACE_SYNC_REPRESENTATIONS = ['bundle_v1', 'manifest_v1', 'unknown'] as const;

export type WorkspaceSyncOperation = (typeof WORKSPACE_SYNC_OPERATIONS)[number];
export type WorkspaceSyncOutcome = (typeof WORKSPACE_SYNC_OUTCOMES)[number];
export type WorkspaceSyncAccessRole = (typeof WORKSPACE_SYNC_ACCESS_ROLES)[number];
export type WorkspaceSyncRepresentation = (typeof WORKSPACE_SYNC_REPRESENTATIONS)[number];
