import type { ShareBundleExcludedFile } from '@waypoint/share-bundle';
import type { ImportManagedWorkspaceResult } from './workspace-git-types';

export interface CloudSyncWorkspaceRoot {
  path: string;
  name: string;
  pinned?: boolean;
}

export interface CloudSyncWorkspaceRequest {
  workspaceName?: string;
  roots: CloudSyncWorkspaceRoot[];
}

export interface CloudSyncSnapshotSummary {
  id: string;
  workspaceId: string;
  displayName: string;
  contentSha256: string;
  sizeBytes: number;
  fileCount: number;
  excludedFiles: ShareBundleExcludedFile[];
  createdAt: string;
}

export interface CloudSyncBundleSummary {
  fileCount: number;
  excludedFiles: ShareBundleExcludedFile[];
  contentSha256: string;
}

export interface CloudSyncBackupResult {
  snapshot: CloudSyncSnapshotSummary;
  bundle: CloudSyncBundleSummary;
}

export interface CloudSyncShareResult extends CloudSyncBackupResult {
  share: {
    id: string;
    shortId: string;
    url: string;
  };
}

export interface CloudSyncRestoreResult {
  snapshot: CloudSyncSnapshotSummary;
  bundle: CloudSyncBundleSummary;
  workspace: ImportManagedWorkspaceResult;
}
