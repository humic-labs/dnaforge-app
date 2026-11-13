import type Database from 'better-sqlite3';
import type { LimsLink } from '../shared/lims';
import { errorMessage } from './lims-engine-core';
import { app } from 'electron';
import { join } from 'node:path';
import {
  materializeLimsGitReadableExportInDb,
  materializeLimsGlobalRegistryExportInDb,
} from './lims-git-export';
import { WorkspaceWriteAdmissionError } from './workspace-write-admission';

export function materializeLimsGlobalRegistryExportForProfile(db: Database.Database) {
  return materializeLimsGlobalRegistryExportInDb(
    db,
    join(app.getPath('userData'), 'lims-registry')
  );
}

export function materializeLimsGitExportForWorkspaceIds(
  db: Database.Database,
  workspaceIds: Iterable<number | null | undefined>
): void {
  const uniqueWorkspaceIds = new Set<number>();
  for (const workspaceId of workspaceIds) {
    if (typeof workspaceId === 'number' && Number.isInteger(workspaceId)) {
      uniqueWorkspaceIds.add(workspaceId);
    }
  }
  for (const workspaceId of uniqueWorkspaceIds) {
    try {
      materializeLimsGitReadableExportInDb(db, { workspaceId });
    } catch (err) {
      if (err instanceof WorkspaceWriteAdmissionError) continue;
      console.warn(
        `[LIMS] Failed to materialize git-readable export for workspace ${workspaceId}: ${errorMessage(err)}`
      );
    }
  }
}

export function materializeLimsGitExportForBatchId(db: Database.Database, batchId: string): void {
  const rows = db
    .prepare(
      `SELECT DISTINCT workspace_id
       FROM lims_audit
       WHERE batch_id = ? AND workspace_id IS NOT NULL`
    )
    .all(batchId) as Array<{ workspace_id: number | null }>;
  materializeLimsGitExportForWorkspaceIds(
    db,
    rows.map((row) => row.workspace_id)
  );
}

export function materializeLimsGitExportForLinks(
  db: Database.Database,
  links: Iterable<LimsLink | null | undefined>
): void {
  materializeLimsGitExportForWorkspaceIds(
    db,
    [...links].map((link) => link?.workspaceId)
  );
}

export function materializeLimsGitExportForAllEntityWorkspaces(db: Database.Database): void {
  const rows = db
    .prepare(
      `SELECT DISTINCT workspace_id
       FROM lims_entity
       WHERE workspace_id IS NOT NULL`
    )
    .all() as Array<{ workspace_id: number }>;
  materializeLimsGitExportForWorkspaceIds(
    db,
    rows.map((row) => row.workspace_id)
  );
}
