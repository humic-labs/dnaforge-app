import type Database from 'better-sqlite3';
import { assertScientificCloudTransferSupported } from './scientific-cloud-admission';

export interface PrepareWorkspaceSyncProjectionResult {
  notebooksMirrored: number;
  limsAppendedEvents: number;
  limsLogFiles: string[];
}

export function prepareWorkspaceSyncProjection(
  db: Database.Database,
  input: { workspaceId: number; workspaceRoot: string; scientificHistoryFormat?: 1 }
): PrepareWorkspaceSyncProjectionResult {
  assertScientificCloudTransferSupported(db, input.workspaceId, input.scientificHistoryFormat);
  return {
    notebooksMirrored: 0,
    limsAppendedEvents: 0,
    limsLogFiles: [],
  };
}
