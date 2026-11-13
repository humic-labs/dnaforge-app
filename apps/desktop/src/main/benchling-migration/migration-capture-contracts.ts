import type {
  BenchlingSourceRef,
  DirectFolderExportAuthority,
  ExportReceiptSource,
  FolderTreeExportAuthority,
  MigrationNetworkAction,
  MigrationScope,
  SourceObject,
} from '../../shared/benchling-migration';
import type { ScopedFolderMetadata } from './collection-projection';

export type MigrationCapturePreflight = {
  scope: MigrationScope;
  plannedContentFamilies?: string[];
  scopedFolders?: ScopedFolderMetadata[];
  exportJobs: Array<{
    id: string;
    contentFamily: string;
    sourceRoots: BenchlingSourceRef[];
    matchSignature: string;
    directFolderAuthority?: DirectFolderExportAuthority;
    folderTreeAuthority?: FolderTreeExportAuthority;
  }>;
  plannedActions: MigrationNetworkAction[];
  compressedArchiveBytes: number | null;
  declaredUncompressedBytes: number | null;
  projectedObjectBytes: number | null;
  largestTemporaryBytes: number | null;
};
export type NativeExportRawPart = {
  id: string;
  kind: 'export_archive' | 'attachment' | 'preserved_source' | 'targeted_read';
  logicalFilename: string;
  sourceArchivePath: string;
  sourceObjectId: string | null;
  capturedAt: string;
} & (
  | { bytes: Uint8Array; localPath?: never; expectedSha256?: never; expectedSizeBytes?: never }
  | {
      bytes?: never;
      localPath: string;
      expectedSha256: string;
      expectedSizeBytes: number;
      cleanupAfterPersist?: boolean;
    }
);

export type NativeExportDownload = {
  snapshotId: string;
  capturedAt: string;
  result: {
    jobId: string;
    matchSignature: string;
    receiptId: string;
    receiptSource?: ExportReceiptSource;
    downloadUrlHash: string;
    rawPartId: string;
  };
  sourceObjects: SourceObject[];
  rawParts: NativeExportRawPart[];
  manifest: {
    sourceObjectIds: string[];
    attachmentReferences: Array<{ sourceObjectId: string; sha256: string }>;
    membershipReferences: Array<{ sourceObjectId: string; collectionId: string }>;
  };
};
