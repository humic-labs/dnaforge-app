import { createHash, randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import type { PackageScratchRecoveryCallbacks } from './ipc/package-scratch-capability';
import {
  enqueueWorkspaceSyncJob,
  markWorkspaceSyncJobFailed,
  markWorkspaceSyncJobSucceeded,
} from './workspace-sync-queue';

export const WORKSPACE_SYNC_PACKAGE_RECOVERY_REQUIRED_CODE = 'PACKAGE_RECOVERY_REQUIRED';

interface BoundPackageWorkspace {
  workspaceId: number;
  workspaceUuid: string;
}

export function createPackageScratchRecoveryCallbacks(
  db: Database.Database,
  workspaceRoot: string,
  packageRoot: string,
  now: () => number = Date.now
): PackageScratchRecoveryCallbacks | undefined {
  const binding = selectBoundPackageWorkspace(db, workspaceRoot);
  if (!binding) return undefined;
  const idempotencyKey = packageRecoveryIdempotencyKey(binding.workspaceUuid, packageRoot);
  return {
    markRequired: async (message) => {
      const nowMs = now();
      const job = enqueueWorkspaceSyncJob(db, {
        id: randomUUID(),
        workspaceId: binding.workspaceId,
        operation: 'refresh',
        idempotencyKey,
        nowMs,
      });
      markWorkspaceSyncJobFailed(db, {
        id: job.id,
        nowMs,
        retryable: false,
        retryDelayMs: 0,
        maxAttempts: 1,
        errorCode: WORKSPACE_SYNC_PACKAGE_RECOVERY_REQUIRED_CODE,
        errorMessage: message,
      });
    },
    clear: async () => {
      const row = db
        .prepare(`SELECT id FROM workspace_sync_queue WHERE idempotency_key = ? LIMIT 1`)
        .get(idempotencyKey) as { id: string } | undefined;
      if (row) markWorkspaceSyncJobSucceeded(db, { id: row.id, nowMs: now() });
    },
  };
}

function selectBoundPackageWorkspace(
  db: Database.Database,
  workspaceRoot: string
): BoundPackageWorkspace | undefined {
  return db
    .prepare(
      `SELECT b.workspace_id AS workspaceId, b.workspace_uuid AS workspaceUuid
       FROM workspace_sync_bindings b
       JOIN workspaces w ON w.id = b.workspace_id
       WHERE w.path = ?
       LIMIT 1`
    )
    .get(workspaceRoot) as BoundPackageWorkspace | undefined;
}

function packageRecoveryIdempotencyKey(workspaceUuid: string, packageRoot: string): string {
  const packageHash = createHash('sha256').update(packageRoot).digest('hex');
  return `package-recovery:${workspaceUuid}:${packageHash}`;
}
