import type Database from 'better-sqlite3';
import { getActiveStoredSession } from './auth/session-store';
import { createDesktopSyncClient } from './desktop-sync-client';
import { restoreScientificCloudRecoveryInIsolatedProfile } from './scientific-cloud-recovery-profile';
import type { WorkspaceSyncScientificRecoveryResult } from '../shared/workspace-sync-ipc';

export async function recoverScientificCloudDrafts(
  db: Database.Database,
  input: { workspaceUuid: string; candidateId: string }
): Promise<WorkspaceSyncScientificRecoveryResult> {
  try {
    const session = await getActiveStoredSession();
    if (!session) throw new Error('Sign in to recover your saved scientific history.');
    const binding = db
      .prepare(
        `SELECT b.remote_workspace_id,w.name FROM workspace_sync_bindings b
      JOIN workspaces w ON w.id=b.workspace_id WHERE b.workspace_uuid=? AND b.owner_account_id=?
      AND w.archived_at IS NULL AND w.trashed_at IS NULL`
      )
      .get(input.workspaceUuid, session.accountId) as
      | { remote_workspace_id: string | null; name: string }
      | undefined;
    if (!binding?.remote_workspace_id) throw new Error('This project has no cloud recovery owner.');
    const context = {
      accountId: session.accountId,
      workspaceId: binding.remote_workspace_id,
      candidateId: input.candidateId,
    };
    const result = await restoreScientificCloudRecoveryInIsolatedProfile({
      client: createDesktopSyncClient(),
      context,
      projectName: binding.name,
    });
    if (result.state === 'pending')
      return {
        ok: false,
        code: 'INVALID_REQUEST',
        message: `History is preserved in ${result.projectPath}. File delivery needs another attempt: ${result.delivery.kind === 'blocked' ? result.delivery.error : 'unfinished delivery'}`,
      };
    return {
      ok: true,
      workspaceUuid: result.workspaceUuid,
      profilePath: result.profilePath,
      projectPath: result.projectPath,
      draftsPath: result.draftsPath,
      changedDraftFiles: result.changedDraftFiles,
      coverage: result.coverage,
      missingPaths: result.missingPaths,
    };
  } catch (error) {
    return {
      ok: false,
      code: 'INVALID_REQUEST',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
