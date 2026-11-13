import type { BlobRef } from '@waypoint/workspace-revisions';
import type { ScientificCloudHistoryV1 } from '@waypoint/scientific-objects';
import type { WorkspaceSyncManifestV1 } from '@waypoint/share-bundle';
import type { ValidatedDesktopSyncLatestBundleEnvelope } from './workspace-sync-bundle-integrity';

export interface DesktopSyncWorkspaceAccessResponse {
  role: 'viewer' | 'editor' | 'manager' | 'owner';
  source: 'owner' | 'org_admin' | 'direct' | 'org_audience';
  orgId: string | null;
}

export interface DesktopSyncWorkspaceSummaryResponse {
  workspaceId: string;
  clientWorkspaceId: string;
  displayName: string;
  owner: { kind: 'personal'; accountId: string } | { kind: 'org'; orgId: string };

  ownerDisplayName?: string;
  access?: DesktopSyncWorkspaceAccessResponse;
  latest: {
    versionId: string | null;
    versionNumber: number;
    contentSha256: string | null;
  };
  storageBytesUsed: number;
  versionCount: number;
  updatedAt: string;
  lastSeenAt: string;
  deviceId: string;
}

export type DesktopSyncLatestVersionResponse = ValidatedDesktopSyncLatestBundleEnvelope;

export interface DesktopSyncManifestVersionResponse {
  workspaceId: string;
  version: DesktopSyncLatestVersionResponse['version'] & {
    representation: 'manifest_v1' | 'scientific_manifest_v1';
    fileManifestSha256?: string;
    manifestSchemaVersion: 1;
    finalizedAt: string;
  };
  manifest: WorkspaceSyncManifestV1;
  resourceIdentities: Array<{ path: string; resourceId: string }>;
  scientificHistory?: ScientificCloudHistoryV1;
  scientificBlobRefs?: readonly BlobRef[];
}

export type DesktopSyncMaterializableVersion =
  | DesktopSyncLatestVersionResponse
  | DesktopSyncManifestVersionResponse;
