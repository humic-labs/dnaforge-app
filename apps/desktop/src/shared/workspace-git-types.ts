import type { UserMessagePayload } from '@waypoint/user-messages';
import type { NucleicAcid } from '@waypoint/sequence-utils';
import type { WorkspaceAccess } from './workspace-access';

export const MANAGED_WORKSPACE_MARKER = '.dnaforge-workspace.json';

export const BENCHLING_MIGRATION_WORKSPACE_MARKER = '.dnaforge/migration/workspace.json';

export const LARGE_MANAGED_IMPORT_FILE_THRESHOLD_BYTES = 1024 ** 3;

export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface PurgeTrashedWorkspaceResult {
  purged: boolean;
}

export type ManagedWorkspaceLifecycleRequest =
  | { action: 'archive-by-uuid'; repoUuid: string }
  | { action: 'archive-by-path'; repoPath: string }
  | { action: 'trash-by-path'; repoPath: string }
  | { action: 'restore-archive-by-uuid'; repoUuid: string }
  | { action: 'restore-trash-by-uuid'; repoUuid: string }
  | { action: 'restore-archive-by-path'; repoPath: string }
  | { action: 'restore-trash-by-path'; repoPath: string };

export interface ManagedWorkspaceLifecycleResult {
  changed: number;
}

export const MAX_MANAGED_WORKSPACE_NAME_LENGTH = 120;

export interface ManagedWorkspaceRenameRequest {
  repoPath: string;
  name: string;
}

export interface ManagedWorkspaceRenameResult {
  changed: number;
}

export interface CreateEmptyWorkspaceRequest {
  name?: string;

  originalDefaultProject?: true;
}

export interface CreateEmptyWorkspaceResult {
  rootPath: string;
  displayName: string;
  createdAt: number;
}

export interface ResolveProjectRootRequest {
  path: string;
  access?: WorkspaceAccess;
  name?: string;
}

export interface ResolvedProjectRoot {
  workspaceId: number;
  rootPath: string;
  displayName: string;
  repoUuid: string | null;
  access: WorkspaceAccess;
}

export type ManagedWorkspaceLargeFilePolicy = 'copy' | 'symlink';

export interface ManagedWorkspaceLargeFile {
  relPath: string;

  sourcePath: string;
  sizeBytes: number;
}

export interface ManagedWorkspaceSymlinkedFile extends ManagedWorkspaceLargeFile {
  repoPath: string;
}

export interface ImportManagedWorkspaceRequest {
  sourcePath: string;

  largeFilePolicy?: ManagedWorkspaceLargeFilePolicy;

  importId?: string;

  displayName?: string;
}

export type ImportDedupMode = 'skip' | 'replace' | 'keep-both';

export interface ImportFileDedup {
  mode: ImportDedupMode;

  expectedRelPath?: string;
}

export interface ImportFileRequest {
  targetRoot: string;

  sourcePath: string;

  confirmedDnaSourceSha256?: string;
  confirmedNucleicAcid?: NucleicAcid;

  dedup?: ImportFileDedup;

  expectedSourceSha256?: string;
}

export interface ImportFileResult {
  destPath: string;

  relPath: string;

  committed: boolean;

  skipped?: boolean;

  replaced?: boolean;

  packageProductPaths?: string[];
}

export type SequenceContentImportCollisionPolicy = 'refuse' | 'replace';

export interface ImportSequenceContentRequest {
  targetRoot: string;

  relativePath: string;

  content: string;
  collisionPolicy: SequenceContentImportCollisionPolicy;
}

export type ImportSequenceContentPartialEffect =
  | {
      kind: 'sequence-packages-created';
      count: number;
    }
  | {
      kind: 'sequence-import-recovery-retained';
      note: string;
    };

interface ImportSequenceContentFailureBase {
  error: string;
  retriable: boolean;
  stateChanged: boolean | 'unknown';
  partialEffects: ImportSequenceContentPartialEffect[];
}

export type ImportSequenceContentResult =
  | {
      kind: 'imported';
      destPath: string;
      relPath: string;
      packageRoots: string[];
      packageProductPaths: string[];
      committed: boolean;
      replaced: boolean;
      stateChanged: true;
      partialEffects: [];
    }
  | (ImportSequenceContentFailureBase & {
      kind: 'refused';
      code:
        | 'IMPORT_INVALID_DESTINATION'
        | 'IMPORT_TARGET_EXISTS'
        | 'IMPORT_DUPLICATE_TARGET'
        | 'IMPORT_INVALID_PACKAGE'
        | 'IMPORT_PRODUCT_MISMATCH'
        | 'IMPORT_PRODUCT_MISSING'
        | 'IMPORT_CONVERSION_REQUIRED';
    })
  | (ImportSequenceContentFailureBase & {
      kind: 'failed';
      code: 'IMPORT_COMMIT_FAILED' | 'IMPORT_FAILED';
      packageRoots?: string[];
      packageProductPaths?: string[];
    });

export interface SequenceImportPreviewPackage {
  name: string;

  recordIndex: number;

  recordCount: number;
}

export interface SequenceImportPreviewRequest {
  sourcePath: string;

  confirmedDnaSourceSha256?: string;
  confirmedNucleicAcid?: NucleicAcid;
}

export type SequenceImportBlockCode =
  | 'unsupported_format'
  | 'unsupported_source_kind'
  | 'read_failure'
  | 'parse_failure'
  | 'unconfirmed_molecule_identity'
  | 'non_dna_content'
  | 'lossless_conversion_blocked'
  | 'source_too_large'
  | 'automatic_split_required'
  | 'record_name_conflict';

export type SequenceImportPreviewResult =
  | {
      kind: 'ready';
      sourcePath: string;

      sourceSha256: string;
      packages: SequenceImportPreviewPackage[];
    }
  | {
      kind: 'blocked';
      sourcePath: string;
      reason: string;
      reasonCode?: SequenceImportBlockCode;

      sourceSha256?: string;
      canConfirmDnaIdentity?: boolean;
      canConvertToRna?: boolean;
    };

export interface ImportContentRequest {
  targetRoot: string;

  fileName: string;

  content?: string;

  contentBytes?: ArrayBuffer;

  dedup?: ImportFileDedup;
}

export type RegisterableSequenceKind = 'sequence';

export interface RegisterImportedSequenceRequest {
  sourcePath: string;
  confirmedDnaSourceSha256?: string;
  confirmedNucleicAcid?: NucleicAcid;

  targetRoot: string;

  kind?: RegisterableSequenceKind;
  actor?: string | null;

  dedup?: ImportFileDedup;

  expectedSourceSha256?: string;

  batchId?: string;
}

export interface RegisterImportedSequenceFromContentRequest {
  content: string;

  fileName: string;

  targetRoot: string;

  kind?: RegisterableSequenceKind;
  actor?: string | null;

  dedup?: ImportFileDedup;

  expectedSourceSha256?: string;

  batchId?: string;
}

export interface RegisterImportedSequenceResult {
  destPath: string;

  packageProductPaths?: string[];

  relPath: string;

  committed: boolean;

  copySkipped: boolean;

  registered: boolean;

  batchId: string | null;

  entityIds: string[];

  reason?: string;
  userMessagePayload?: UserMessagePayload;
}

export interface ImportFolderRequest {
  targetRoot: string;
  sourcePath: string;
}

export type ImportProgressStatus = 'scanning' | 'copying' | 'finalizing';

export interface ImportProgressEvent {
  importId: string;
  status: ImportProgressStatus;
  filesCopied: number;
  totalFiles: number;
  bytesCopied: number;
  totalBytes: number;
}

export interface ImportManagedWorkspaceResult {
  workspaceUuid: string;

  repoPath: string;

  entryPath?: string;
  displayName: string;

  originPath: string;
  createdAt: number;

  reused: boolean;

  largeFilePolicy: ManagedWorkspaceLargeFilePolicy;

  largeFiles: ManagedWorkspaceLargeFile[];

  symlinkedLargeFiles: ManagedWorkspaceSymlinkedFile[];
  unconvertedSequenceFiles?: UnconvertedSequenceFile[];
}

export interface UnconvertedSequenceFile {
  relPath: string;
  reason: string;
}

export interface ManagedHeadFile {
  relPath: string;

  oid: string;
  sizeBytes: number;
  modifiedAt: number | null;
}

export interface ManagedHeadIndex {
  headCommit: string | null;
  files: ManagedHeadFile[];
  migrationIssues?: ManagedFileMigrationIssue[];
}

export interface ManagedFileMigrationIssue {
  path: string;
  reason: string;
  kind: 'refused' | 'failed';
}

export interface WorkspaceEntityMigrationResult {
  healedFileCount: number;
  migrationIssues: ManagedFileMigrationIssue[];
}

export interface ManagedCatalogHeadIndex {
  headCommit: string | null;
  files: ManagedHeadFile[];
  scannedFileCount: number;
  visibleFileCount: number;
  healedFileCount?: number;
  migrationIssues?: ManagedFileMigrationIssue[];
}

export interface ManagedCatalogHeadIndexRequest {
  repoPath: string;

  preserveRelPaths: string[];

  healWorkingTree?: boolean;

  mutationToken?: string;
}

export interface WorkspaceArtifactDiscoveryResult {
  primerArtifactPaths: string[];
  entityArtifactPaths: string[];
  scannedEntries: number;
  errors: Array<{ path: string; message: string }>;

  catalogProjection?: WorkspaceCatalogProjection;
}

export interface WorkspaceCatalogKnownFile {
  path: string;
  contentHash: string | null;
  sizeBytes: number | null;
  modifiedAt: number | null;
}

export interface WorkspaceCatalogCandidate {
  path: string;
  fileKind: string;
  sizeBytes: number;
  modifiedAt: number;
  contentHash: string | null;
}

export interface WorkspaceCatalogProjection {
  candidates: WorkspaceCatalogCandidate[];

  missingPaths: string[];

  scannedFileCount: number;
  visibleFileCount: number;
}

export interface WorkspaceArtifactDiscoveryRequest {
  rootPath: string;

  knownFiles: WorkspaceCatalogKnownFile[];
}
