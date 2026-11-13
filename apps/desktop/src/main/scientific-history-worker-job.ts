import type { BlobRef, WorkspaceVersionId } from '@waypoint/workspace-revisions';
import type { ScientificCloudHistoryV1 } from '@waypoint/scientific-objects';
import type { WorkspaceSyncManifestV1 } from '@waypoint/share-bundle';
import type { ScientificHistoryCurrentFile } from '@waypoint/scientific-artifacts';
import type { ScientificHistoryInstallationResult } from './scientific-object-store';
import type { ScientificCloudReplicaCommit } from './workspace-sync-scientific-commit';

interface OwnedScientificDatabase {
  readonly databasePath: string;
  readonly workspaceId: number;
}

export type ScientificHistoryWorkerJob =
  | (OwnedScientificDatabase & {
      readonly kind: 'export';
      readonly manifest?: WorkspaceSyncManifestV1;

      readonly purpose?: 'recovery';
    })
  | (OwnedScientificDatabase & {
      readonly kind: 'install';
      readonly descriptor: ScientificCloudHistoryV1;
      readonly archive: Uint8Array;
      readonly sources: readonly { readonly blob: BlobRef; readonly sourcePath: string }[];
      readonly manifest?: WorkspaceSyncManifestV1;
      readonly blobRefs?: readonly BlobRef[];
      readonly expectedHead: WorkspaceVersionId | null;
      readonly remoteWorkspaceId?: string;
      readonly binding?: {
        readonly ownerAccountId: string;
        readonly remoteWorkspaceId: string;
        readonly baseVersionId: string | null;
      };
      readonly resolution?: 'fast-forward' | 'replace-and-retain' | 'retain-only';
      readonly replicaCommit?: ScientificCloudReplicaCommit;
      readonly localRecovery?: {
        readonly workspaceUuid: string;
        readonly repoPath: string;
        readonly receiptJson: string;
      };
    });

export interface ScientificHistoryWorkerExport {
  readonly kind: 'exported';
  readonly descriptor: ScientificCloudHistoryV1;
  readonly archive: Uint8Array;
  readonly blobs: readonly BlobRef[];
  readonly files: readonly ScientificHistoryCurrentFile[];
}
export type ScientificHistoryWorkerResult =
  | ScientificHistoryWorkerExport
  | { readonly kind: 'installed'; readonly installation: ScientificHistoryInstallationResult };

export type ScientificHistoryWorkerResponse =
  | { readonly type: 'prepared'; readonly challenge: string }
  | { readonly type: 'result'; readonly result: ScientificHistoryWorkerResult }
  | { readonly type: 'error'; readonly error: { readonly name: string; readonly message: string } };
