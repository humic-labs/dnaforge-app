import type {
  CloudSyncBackupResult,
  CloudSyncRestoreResult,
  CloudSyncShareResult,
  CloudSyncSnapshotSummary,
  CloudSyncWorkspaceRequest,
} from '../cloud-sync-types';
import { defineGroup, invoke } from './contract';

export const cloudSyncBackupContract = defineGroup('cloudSync', {
  backupWorkspace: invoke<[request: CloudSyncWorkspaceRequest], CloudSyncBackupResult>(),
  shareWorkspace: invoke<[request: CloudSyncWorkspaceRequest], CloudSyncShareResult>(),
  listSnapshots: invoke<[], CloudSyncSnapshotSummary[]>(),
  restoreSnapshot: invoke<[snapshotId?: string], CloudSyncRestoreResult>(),
});
