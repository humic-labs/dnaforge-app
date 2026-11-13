import { handleGroup } from '../../shared/ipc-contract';

import {
  backupWorkspaceSnapshot,
  listWorkspaceSnapshots,
  restoreWorkspaceSnapshot,
  shareWorkspaceSnapshot,
} from '../cloud-sync';
import type { CloudSyncWorkspaceRequest } from '../../shared/cloud-sync-types';
import { cloudSyncBackupContract } from '../../shared/ipc/cloud-sync-backup.contract';

export function registerCloudSyncHandlers(): void {
  handleGroup(cloudSyncBackupContract, {
    backupWorkspace: (_event, request: CloudSyncWorkspaceRequest) =>
      backupWorkspaceSnapshot(request),
    shareWorkspace: (_event, request: CloudSyncWorkspaceRequest) => shareWorkspaceSnapshot(request),
    listSnapshots: () => listWorkspaceSnapshots(),
    restoreSnapshot: (_event, snapshotId?: unknown) =>
      restoreWorkspaceSnapshot(typeof snapshotId === 'string' ? snapshotId : undefined),
  });
}
