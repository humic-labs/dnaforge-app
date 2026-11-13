import { createHash } from 'node:crypto';
import {
  readNativeSourceFolderMemberships,
  validateNativeSourceFolderMemberships,
} from './native-source-memberships';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import Database from 'better-sqlite3';
import { projectionSourceHash } from './projection';
import { parseRegistryTableMappingDecision } from '../../shared/benchling-registry-table-review';
import {
  importDecisionKey,
  isPendingImportDecision,
  type ExistingPathFingerprint,
  type ImportDecision,
  type PendingImportDecision,
} from '../../shared/benchling-import-decision';
import type {
  ExternalZipEntryEvidence,
  ExternalZipSource,
  ExportJob,
  GmailReceiptConfirmationEvidence,
  GmailReceiptInferenceEvidence,
  LinkedItemRecoveryState,
  LinkedItemRecoveryVersionConflictPolicy,
  LocalBenchlingExportArtifact,
  LocalBenchlingExportIntakeDescriptor,
  MigrationRun,
  NativeExportDownloadAcceptanceEvidence,
  NativeExportSubmissionReconciliationEvidence,
  ProjectionReceipt,
  ProviderActivityBundle,
  ProviderActivityOperationKind,
  ProviderCommandJournalEntry,
  ProviderTaskGmailRescanAuthorization,
  ProviderTaskEvidence,
  RelationshipResolution,
  SourceObject,
  SourceSnapshot,
  SourceSnapshotPart,
  ScopedFolderCommandCorrelation,
  ValidationLinkedItemRecoveryEvidence,
  ValidationReport,
} from '../../shared/benchling-migration';
import {
  isLocalNativeFolderZipInventory,
  migrationRunSourceIdentityHash,
} from '../../shared/benchling-migration';
import { isSafeWorkspaceRelativePath } from '../../shared/path-boundary';
import {
  assertExactScopedFolderPreDispatchActivity,
  assertExactScopedFolderSuccessActivity,
  validateBridgeProviderActivityBundle,
} from './provider-activity-evidence';
import {
  assertDirectFolderCapturePlanMatchesJournal,
  directFolderInitialExportJobIdentityIndex,
  directFolderTraversalJournalDigest,
  validateDirectFolderCapturePlan,
  type DirectFolderCapturePlanV1,
} from './direct-folder-capture-plan';
import {
  assertFolderTreeCapturePlanMatchesJournal,
  folderTreeInitialExportJobIdentityIndex,
  folderTreeTraversalJournalDigest,
  validateFolderTreeCapturePlan,
  type FolderTreeCapturePlanV1,
} from './folder-tree-capture-plan';
import { isNeedsSequenceCompletion } from './benchling-source-version';
import { scientificSourceObjectSha256 } from './linked-item-recovery-decoder';
import { localBenchlingExportDescendantFolderId } from './local-export-hierarchy';
import { observableReceiptMatchKey } from './receipt-match-key';
import {
  createNativeExportDownloadAcceptanceEvidence,
  isExactSuccessfulNativeExportDownloadActivity,
  validateNativeExportDownloadAcceptanceEvidence,
} from './native-export-download-acceptance';
import { providerTaskHandleHash, providerTaskReceiptId } from './provider-task-handle';
import { makeReplacementExportJob } from './scope-planner';
import {
  SCOPED_FOLDER_MAX_PAGES,
  appendDurableScopedFolderTraversalCheckpointEntry,
  canonicalScopedFolderTraversalJson,
  createDurableScopedFolderTraversalCheckpoint,
  createScopedFolderTraversalJournal,
  durableScopedFolderTraversalCheckpointCursor,
  invalidateDurableScopedFolderTraversalCheckpoint,
  scopedFolderTraversalPageRequestSha256,
  validateAndNormalizeDurableScopedFolderTraversalJournal,
  verifyDurableScopedFolderTraversalCheckpointReplayEntry,
  type DurableScopedFolderTraversalCheckpoint,
  type ScopedFolderTraversalJournal,
  type ScopedFolderTraversalJournalEntry,
  type ScopedFolderTraversalPageRequest,
  type ScopedFolderTraversalScopeKind,
} from './scoped-folder-traversal-journal';
import { canTransitionMigrationRun, isTerminalMigrationState } from './state-machine';
import { sourceObjectMaterializationView } from './source-object-materialization-view';
import { sourceObjectValidationView } from './source-object-validation-view';
import { assertValidationReportRendererPrivacySafe } from './validation-report-privacy';
import type {
  WorkspaceAppendHierarchyCapture,
  WorkspaceAppendHierarchyFolder,
  WorkspaceAppendHierarchyMembership,
} from './workspace-append-hierarchy-capture';
import {
  createBenchlingMigrationAttemptIdentity,
  createBenchlingMigrationTelemetryAcceptance,
  parseBenchlingMigrationTelemetryAcceptance,
  benchlingMigrationAttemptReceiptIdentity,
  projectBenchlingMigrationTerminal,
  terminalOutcomeForLinkedAttempt,
  terminalOutcomeForRun,
  terminalStageForLinkedAttempt,
  terminalStageForRunState,
  type BenchlingMigrationAttemptIdentity,
  type BenchlingMigrationAttemptTerminalReceipt,
  type BenchlingMigrationOperation,
  type BenchlingMigrationTelemetry,
  type BenchlingMigrationTelemetryAcceptance,
} from './telemetry';

export type {
  WorkspaceAppendHierarchyCapture,
  WorkspaceAppendHierarchyFolder,
  WorkspaceAppendHierarchyMembership,
} from './workspace-append-hierarchy-capture';

export const MIGRATION_DATA_DIR = '.dnaforge/migration';
export const MIGRATION_DATABASE_NAME = 'migration.sqlite';
const MIGRATION_SCHEMA_VERSION = 3;
const PROVIDER_TASK_PRIVACY_SCHEMA_VERSION = 2;
const PROVIDER_TASK_PRIVACY_MIGRATION_MARKER_KEY = 'provider_task_privacy_v2';
const PROVIDER_TASK_PRIVACY_MIGRATION_MARKER_VALUE = 'completed';
const MACHINE_VALIDATION_REPORT_NAME = 'validation-report.json';
export const LEGACY_SCOPED_ITEM_URL_AUTHORITY_UNAVAILABLE_REASON =
  'legacy_scoped_item_url_authority_unavailable' as const;
export const LEGACY_PROVIDER_TASK_SESSION_LOCATOR_UNAVAILABLE_REASON =
  'legacy_provider_task_session_locator_unavailable' as const;
const LEGACY_PROVIDER_TASK_PRIVATE_DETAIL_REDACTED =
  'Legacy provider task details were removed during the privacy migration.';
const PROVIDER_TASK_PRIVACY_BODY_TABLES = [
  {
    table: 'migration_run',
    scanQuery: 'SELECT body_json FROM migration_run ORDER BY rowid',
    migrationQuery:
      'SELECT rowid AS migration_rowid, id AS run_id, NULL AS job_id, body_json FROM migration_run ORDER BY rowid',
    updateQuery: 'UPDATE migration_run SET body_json = ? WHERE rowid = ?',
  },
  {
    table: 'snapshot_part',
    scanQuery: 'SELECT body_json FROM snapshot_part ORDER BY rowid',
    migrationQuery:
      'SELECT rowid, run_id, NULL AS job_id, body_json FROM snapshot_part ORDER BY rowid',
    updateQuery: 'UPDATE snapshot_part SET body_json = ? WHERE rowid = ?',
  },
  {
    table: 'source_snapshot',
    scanQuery: 'SELECT body_json FROM source_snapshot ORDER BY rowid',
    migrationQuery:
      'SELECT rowid, run_id, NULL AS job_id, body_json FROM source_snapshot ORDER BY rowid',
    updateQuery: 'UPDATE source_snapshot SET body_json = ? WHERE rowid = ?',
  },
  {
    table: 'export_job',
    scanQuery: 'SELECT body_json FROM export_job ORDER BY rowid',
    migrationQuery: 'SELECT rowid, run_id, id AS job_id, body_json FROM export_job ORDER BY rowid',
    updateQuery: 'UPDATE export_job SET body_json = ? WHERE rowid = ?',
  },
  {
    table: 'gmail_receipt_inference',
    scanQuery: 'SELECT body_json FROM gmail_receipt_inference ORDER BY rowid',
    migrationQuery:
      "SELECT rowid, run_id, json_extract(body_json, '$.jobId') AS job_id, body_json FROM gmail_receipt_inference ORDER BY rowid",
    updateQuery: 'UPDATE gmail_receipt_inference SET body_json = ? WHERE rowid = ?',
  },
  {
    table: 'gmail_receipt_confirmation',
    scanQuery: 'SELECT body_json FROM gmail_receipt_confirmation ORDER BY rowid',
    migrationQuery:
      "SELECT rowid, run_id, json_extract(body_json, '$.jobId') AS job_id, body_json FROM gmail_receipt_confirmation ORDER BY rowid",
    updateQuery: 'UPDATE gmail_receipt_confirmation SET body_json = ? WHERE rowid = ?',
  },
  {
    table: 'export_capture',
    scanQuery: 'SELECT body_json FROM export_capture ORDER BY rowid',
    migrationQuery:
      'SELECT rowid, run_id, NULL AS job_id, body_json FROM export_capture ORDER BY rowid',
    updateQuery: 'UPDATE export_capture SET body_json = ? WHERE rowid = ?',
  },
  {
    table: 'export_inspection',
    scanQuery: 'SELECT body_json FROM export_inspection ORDER BY rowid',
    migrationQuery:
      'SELECT rowid, run_id, NULL AS job_id, body_json FROM export_inspection ORDER BY rowid',
    updateQuery: 'UPDATE export_inspection SET body_json = ? WHERE rowid = ?',
  },
  {
    table: 'export_job_replacement',
    scanQuery: 'SELECT body_json FROM export_job_replacement ORDER BY rowid',
    migrationQuery:
      'SELECT rowid, run_id, NULL AS job_id, body_json FROM export_job_replacement ORDER BY rowid',
    updateQuery: 'UPDATE export_job_replacement SET body_json = ? WHERE rowid = ?',
  },
  {
    table: 'export_job_failure',
    scanQuery: 'SELECT body_json FROM export_job_failure ORDER BY rowid',
    migrationQuery:
      'SELECT rowid, run_id, NULL AS job_id, body_json FROM export_job_failure ORDER BY rowid',
    updateQuery: 'UPDATE export_job_failure SET body_json = ? WHERE rowid = ?',
  },
  {
    table: 'relationship_resolution',
    scanQuery: 'SELECT body_json FROM relationship_resolution ORDER BY rowid',
    migrationQuery:
      'SELECT rowid, run_id, NULL AS job_id, body_json FROM relationship_resolution ORDER BY rowid',
    updateQuery: 'UPDATE relationship_resolution SET body_json = ? WHERE rowid = ?',
  },
  {
    table: 'projection_receipt',
    scanQuery: 'SELECT body_json FROM projection_receipt ORDER BY rowid',
    migrationQuery:
      'SELECT rowid, run_id, NULL AS job_id, body_json FROM projection_receipt ORDER BY rowid',
    updateQuery: 'UPDATE projection_receipt SET body_json = ? WHERE rowid = ?',
  },
  {
    table: 'validation_report',
    scanQuery: 'SELECT body_json FROM validation_report ORDER BY rowid',
    migrationQuery:
      'SELECT rowid, run_id, NULL AS job_id, body_json FROM validation_report ORDER BY rowid',
    updateQuery: 'UPDATE validation_report SET body_json = ? WHERE rowid = ?',
  },
  {
    table: 'request_ledger',
    scanQuery: 'SELECT body_json FROM request_ledger ORDER BY rowid',
    migrationQuery:
      'SELECT rowid, run_id, NULL AS job_id, body_json FROM request_ledger ORDER BY rowid',
    updateQuery: 'UPDATE request_ledger SET body_json = ? WHERE rowid = ?',
  },
  {
    table: 'provider_task_evidence',
    scanQuery: 'SELECT body_json FROM provider_task_evidence ORDER BY rowid',
    migrationQuery:
      "SELECT rowid, run_id, json_extract(body_json, '$.jobId') AS job_id, body_json FROM provider_task_evidence ORDER BY rowid",
    updateQuery: 'UPDATE provider_task_evidence SET body_json = ? WHERE rowid = ?',
  },
  {
    table: 'provider_activity_evidence',
    scanQuery: 'SELECT body_json FROM provider_activity_evidence ORDER BY rowid',
    migrationQuery:
      'SELECT rowid, run_id, NULL AS job_id, body_json FROM provider_activity_evidence ORDER BY rowid',
    updateQuery: 'UPDATE provider_activity_evidence SET body_json = ? WHERE rowid = ?',
  },
  {
    table: 'provider_command_journal',
    scanQuery: 'SELECT body_json FROM provider_command_journal ORDER BY rowid',
    migrationQuery:
      "SELECT rowid, run_id, json_extract(body_json, '$.exportJobId') AS job_id, body_json FROM provider_command_journal ORDER BY rowid",
    updateQuery: 'UPDATE provider_command_journal SET body_json = ? WHERE rowid = ?',
  },
  {
    table: 'native_export_reconciliation',
    scanQuery: 'SELECT body_json FROM native_export_reconciliation ORDER BY rowid',
    migrationQuery:
      "SELECT rowid, run_id, json_extract(body_json, '$.exportJobId') AS job_id, body_json FROM native_export_reconciliation ORDER BY rowid",
    updateQuery: 'UPDATE native_export_reconciliation SET body_json = ? WHERE rowid = ?',
  },
  {
    table: 'native_export_download_acceptance',
    scanQuery: 'SELECT body_json FROM native_export_download_acceptance ORDER BY rowid',
    migrationQuery:
      "SELECT rowid, run_id, json_extract(body_json, '$.exportJobId') AS job_id, body_json FROM native_export_download_acceptance ORDER BY rowid",
    updateQuery:
      'UPDATE native_export_download_acceptance SET id = ?, body_json = ? WHERE rowid = ?',
    rehashDownloadAcceptance: true,
  },
  {
    table: 'scoped_folder_traversal_header',
    scanQuery: 'SELECT body_json FROM scoped_folder_traversal_header ORDER BY rowid',
    migrationQuery:
      'SELECT rowid, run_id, NULL AS job_id, body_json FROM scoped_folder_traversal_header ORDER BY rowid',
    updateQuery: 'UPDATE scoped_folder_traversal_header SET body_json = ? WHERE rowid = ?',
  },
  {
    table: 'scoped_folder_traversal_page',
    scanQuery: 'SELECT body_json FROM scoped_folder_traversal_page ORDER BY rowid',
    migrationQuery:
      'SELECT rowid, run_id, NULL AS job_id, body_json FROM scoped_folder_traversal_page ORDER BY rowid',
    updateQuery: 'UPDATE scoped_folder_traversal_page SET body_json = ? WHERE rowid = ?',
  },
  {
    table: 'direct_folder_capture_plan',
    scanQuery: 'SELECT body_json FROM direct_folder_capture_plan ORDER BY rowid',
    migrationQuery:
      'SELECT rowid, run_id, NULL AS job_id, body_json FROM direct_folder_capture_plan ORDER BY rowid',
    updateQuery: 'UPDATE direct_folder_capture_plan SET body_json = ? WHERE rowid = ?',
  },
  {
    table: 'folder_tree_capture_plan',
    scanQuery: 'SELECT body_json FROM folder_tree_capture_plan ORDER BY rowid',
    migrationQuery:
      'SELECT rowid, run_id, NULL AS job_id, body_json FROM folder_tree_capture_plan ORDER BY rowid',
    updateQuery: 'UPDATE folder_tree_capture_plan SET body_json = ? WHERE rowid = ?',
  },
] as const;
type ProviderTaskPrivacyMigratableTable =
  (typeof PROVIDER_TASK_PRIVACY_BODY_TABLES)[number]['table'];
type ProviderTaskPrivacyTableDescriptor = (typeof PROVIDER_TASK_PRIVACY_BODY_TABLES)[number];

function providerTaskPrivacyTableDescriptor(
  table: ProviderTaskPrivacyMigratableTable
): ProviderTaskPrivacyTableDescriptor {
  const descriptor = PROVIDER_TASK_PRIVACY_BODY_TABLES.find(
    (candidate) => candidate.table === table
  );
  if (!descriptor) {
    throw new Error(`Provider-task privacy table ${table} is not declared.`);
  }
  return descriptor;
}
const SCOPED_FOLDER_TRAVERSAL_SQLITE_HEADER_SCHEMA =
  'dnaforge.scoped-folder-traversal-sqlite-header.v1' as const;
const SCOPED_FOLDER_TRAVERSAL_SQLITE_PAGE_SCHEMA =
  'dnaforge.scoped-folder-traversal-sqlite-page.v1' as const;
const SHA256_REF = /^sha256:[a-f0-9]{64}$/u;
const SCOPED_FOLDER_COMMAND_HISTORY_SCHEMA =
  'dnaforge.benchling.scoped-folder-command-history-chain.v1';
const SCOPED_FOLDER_COMMAND_HISTORY_EMPTY_DIGEST = `sha256:${createHash('sha256')
  .update(`${SCOPED_FOLDER_COMMAND_HISTORY_SCHEMA}\0empty`, 'utf8')
  .digest('hex')}`;
const SCOPED_FOLDER_ACTIVITY_HISTORY_SCHEMA =
  'dnaforge.benchling.scoped-folder-activity-history-chain.v1';
const SCOPED_FOLDER_ACTIVITY_HISTORY_EMPTY_DIGEST = `sha256:${createHash('sha256')
  .update(`${SCOPED_FOLDER_ACTIVITY_HISTORY_SCHEMA}\0empty`, 'utf8')
  .digest('hex')}`;
const SCOPED_FOLDER_REQUEST_LEDGER_HISTORY_SCHEMA =
  'dnaforge.benchling.scoped-folder-request-ledger-history-chain.v1';
const SCOPED_FOLDER_REQUEST_LEDGER_HISTORY_EMPTY_DIGEST = `sha256:${createHash('sha256')
  .update(`${SCOPED_FOLDER_REQUEST_LEDGER_HISTORY_SCHEMA}\0empty`, 'utf8')
  .digest('hex')}`;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const SCOPED_FOLDER_RECEIPT_EPOCH = /^receipt-epoch:[a-f0-9]{32}$/u;
const NATIVE_EXPORT_LEDGER_EPOCH = /^native-ledger-epoch:[a-f0-9]{32}$/u;
const LEGACY_PROVIDER_TASK_RECEIPT = /^task:/u;
const PROVIDER_TASK_RECEIPT = /^provider-task:[a-f0-9]{64}$/u;
const EMBEDDED_LEGACY_PROVIDER_TASK_RECEIPT =
  /(?:^|[^A-Za-z0-9._:-])task:[A-Za-z0-9][A-Za-z0-9._:-]{0,199}(?:$|[^A-Za-z0-9._:-])/u;
const EMBEDDED_PROVIDER_TASK_STATUS_PATH =
  /(?:^|["'\s])\/(?:1\/)?api\/(?:v[0-9]+\/)?(?:tasks|exports)\/[A-Za-z0-9]/u;
const EMBEDDED_PROVIDER_TASK_PRIVATE_FIELD =
  /(?:^|[{"\\])(?:providerTaskId|statusPath)(?:"|\\")?\s*:/u;
const SCOPED_FOLDER_COMMAND_SCHEMA = 'dnaforge.benchling.scoped-folder-command.v1' as const;
const PROVIDER_ACTIVITY_OPERATION_KINDS = new Set<ProviderActivityOperationKind>([
  'submit_export',
  'reconcile_export_submission',
  'poll_export_receipts',
  'recover_export_receipt',
  'inspect_export',
  'inspect_export_range',
  'discover_failed_export_split',
  'discover_scoped_folder_page',
  'download_export',
  'targeted_read',
]);

const PENDING_EXPORT_JOB_STATES = new Set<ExportJob['state']>([
  'submitted',
  'receipt_pending',
  'receipt_matched',
  'downloading',
]);

const EXPORT_JOB_TRANSITIONS: Record<ExportJob['state'], ReadonlySet<ExportJob['state']>> = {
  planned: new Set(['planned', 'submitted', 'failed']),
  submitted: new Set(['submitted', 'receipt_pending', 'receipt_matched', 'failed']),
  receipt_pending: new Set(['receipt_pending', 'receipt_matched', 'failed']),
  receipt_matched: new Set(['receipt_matched', 'downloading', 'failed']),
  downloading: new Set(['downloading', 'captured', 'failed']),
  captured: new Set(['captured']),
  failed: new Set(['failed', 'submitted']),
};

type SourceSnapshotMetadata = Omit<SourceSnapshot, 'parts'>;

type ProviderTaskPrivacyMigrationContext = Readonly<{
  runsById: ReadonlyMap<string, MigrationRun>;
  jobsByRunAndId: ReadonlyMap<string, ExportJob>;
  authorityDigestHints: ReadonlyMap<string, string>;
  handlesByRunJobAndRawTask: ReadonlyMap<string, string>;
  uniqueHandlesByRunAndRawTask: ReadonlyMap<string, string | null>;
  nonResumableRunIds: Set<string>;
}>;

type ProviderTaskPrivacyJsonRow = Readonly<{
  rowid: number;
  runId: string;
  jobId: string | null;
  bodyJson: string;
}>;

export type MigrationRequestLedgerEntry = {
  id: string;
  runId: string;
  commandRequestId?: string;
  requestKind:
    | 'export_submit'
    | 'export_submit_reconcile'
    | 'gmail_poll'
    | 'export_split_discovery'
    | 'export_inspect'
    | 'export_download'
    | 'folder_discovery'
    | 'targeted_read';
  requestKey: string;
  outcome: 'success' | 'cache_hit' | 'transient_failure' | 'permanent_failure';
  startedAt: string;
  finishedAt: string;
  attempt: number;
};

export type MigrationRequestCounts = {
  total: number;
  cacheHits: number;
  byKind: Record<MigrationRequestLedgerEntry['requestKind'], number>;
};

export type ScopedFolderTraversalJournalHead = Readonly<{
  pageCount: number;
  recordHash: string;
}>;

export type InitializeScopedFolderTraversalJournalInput = Readonly<{
  runId: string;
  scopeKind: ScopedFolderTraversalScopeKind;
  selectedRootIds: string[];
  includeArchived?: boolean;
}>;

export type AppendScopedFolderTraversalJournalEntryInput = Readonly<{
  runId: string;
  sourceCommandRequestId: string;
  expectedHead: ScopedFolderTraversalJournalHead;
  entry: unknown;
}>;

export type ScopedFolderDiscoverySettlementPage =
  | Readonly<{
      mode: 'append';
      expectedHead: ScopedFolderTraversalJournalHead;
      entry: unknown;
    }>
  | Readonly<{
      mode: 'replay';
      expectedHead: ScopedFolderTraversalJournalHead;
      entry: unknown;
    }>
  | Readonly<{
      mode: 'none';
      expectedHead: ScopedFolderTraversalJournalHead;
    }>;

export type SettleScopedFolderDiscoveryInput = Readonly<{
  runId: string;
  commandRequestId: string;
  pageRequest: ScopedFolderTraversalPageRequest;
  activity: ProviderActivityBundle;
  requestLedgerEntry: MigrationRequestLedgerEntry;
  page: ScopedFolderDiscoverySettlementPage;
}>;

export type ScopedFolderDiscoverySettlementResult = Readonly<{
  head: ScopedFolderTraversalJournalHead;
  pageDisposition: 'appended' | 'replay_verified' | 'none';
  alreadySettled: boolean;
}>;

export type UnsettledScopedFolderCommand = ProviderCommandJournalEntry & {
  operationKind: 'discover_scoped_folder_page';
  scopedFolderCorrelation: ScopedFolderCommandCorrelation;
};

function isScopedFolderCommand(
  command: ProviderCommandJournalEntry
): command is UnsettledScopedFolderCommand {
  return (
    command.operationKind === 'discover_scoped_folder_page' &&
    command.scopedFolderCorrelation !== undefined
  );
}

export type ScopedFolderSettlementStep = 'after_activity' | 'after_request_ledger' | 'after_page';

export type MigrationStoreInstrumentation = Readonly<{
  onScopedFolderTraversalSemanticReplay?: () => void;
  onScopedFolderTraversalIncrementalPageValidation?: () => void;
  onScopedFolderSettlementStep?: (step: ScopedFolderSettlementStep) => void;
  onFileBackedPeerAdoptionAudit?: () => void;
  onExportJobValidationContextBuild?: (jobCount: number) => void;
  onCapturePersistenceQuery?: (kind: CapturePersistenceQueryKind, returnedRowCount: number) => void;
}>;

export type ScopedFolderTraversalLiveCursor = Readonly<{
  head: ScopedFolderTraversalJournalHead;
  nextRequest: ScopedFolderTraversalPageRequest | null;
}>;

export type CapturePersistenceQueryKind =
  | 'export_capture_by_job'
  | 'snapshot_part_by_id'
  | 'snapshot_part_successors'
  | 'snapshot_parts_by_export_job'
  | 'source_version_by_id'
  | 'source_versions_by_export_job'
  | 'source_versions_by_source_object'
  | 'export_replacements_by_failed_job'
  | 'export_replacement_parent_by_job';

export type PersistedExportCapture = {
  jobId: string;
  runId: string;
  snapshotId: string;
  capturedAt: string;
  archiveManifestId: string;
  sourceObjectIds: string[];
  attachmentReferences: Array<{ sourceObjectId: string; sha256: string }>;
  membershipReferences: Array<{ sourceObjectId: string; collectionId: string }>;
};

export type PersistedExportInspection = {
  jobId: string;
  runId: string;
  receiptId: string;
  downloadUrlHash: string;
  inspectedAt: string;
  compressedArchiveBytes: number;
  declaredCompressedEntryBytes: number;
  declaredUncompressedBytes: number;
  largestUncompressedEntryBytes: number;
  entryCount: number;
  centralDirectoryBytes: number;
  zip64: boolean;
  rangeRequestCount: number;
  rangeBytesRead: number;
};

export type ExportJobReplacementReason = 'export_timed_out' | 'download_link_expired';

const EXPORT_JOB_FAILURE_MESSAGES: Readonly<Record<ExportJobReplacementReason, string>> =
  Object.freeze({
    export_timed_out: 'The Benchling export timed out.',
    download_link_expired: 'The Benchling download link expired.',
  });

export function canonicalExportJobFailureMessage(code: ExportJobReplacementReason): string {
  return EXPORT_JOB_FAILURE_MESSAGES[code];
}

export type PersistedExportJobReplacement = {
  failedJobId: string;
  runId: string;
  reason: ExportJobReplacementReason;
  createdAt: string;
  replacementJobIds: string[];
};

export function activeExportLeafJobIds(
  candidateJobIds: Iterable<string>,
  replacements: readonly PersistedExportJobReplacement[]
): Set<string> {
  const active = new Set(candidateJobIds);
  for (const replacement of replacements) active.delete(replacement.failedJobId);
  return active;
}

export type PersistedExportJobFailure = {
  jobId: string;
  runId: string;
  code: ExportJobReplacementReason;
  failedAt: string;
  message: string;
};

type ExportJobSqliteRow = {
  id: string;
  run_id: string;
  match_signature: string;
  state: string;
  submitted_at: string | null;
  attempts: number;
  body_json: string;
};

type ExportJobReplacementSqliteRow = {
  id: string;
  run_id: string;
  body_json: string;
};

type ImmutableJsonSqliteRow = {
  id: string;
  run_id: string;
  body_json: string;
};

type LinkedItemRecoveryAttemptSqliteRow = {
  id: string;
  run_id: string;
  state: string;
  updated_at: string;
  body_json: string;
};

type LinkedItemRecoveryArtifactSqliteRow = {
  id: string;
  run_id: string;
  attempt_id: string;
  sha256: string;
  body_json: string;
};

type LinkedItemRecoveryCaptureSqliteRow = {
  id: string;
  run_id: string;
  attempt_id: string;
  artifact_id: string;
  source_object_id: string;
  snapshot_part_id: string;
  body_json: string;
};

type WorkspaceAppendHierarchyCaptureSqliteRow = {
  id: string;
  run_id: string;
  attempt_id: string;
  artifact_id: string;
  artifact_sha256: string;
  body_json: string;
};

type ProjectionReceiptSqliteRow = {
  id: string;
  run_id: string;
  source_object_id: string;
  destination_object_id: string;
  body_json: string;
};

type ProjectionReceiptRevisionSqliteRow = ProjectionReceiptSqliteRow & {
  supersedes_receipt_id: string;
};

type ExportJobReplacementEdgeSqliteRow = {
  run_id: string;
  replacement_job_id: string;
  failed_job_id: string;
};

type ExportJobValidationContext = {
  run: MigrationRun;
  plan: DirectFolderCapturePlanV1 | null;
  folderTreePlan: FolderTreeCapturePlanV1 | null;
  jobsById: Map<string, ExportJob>;
  failuresByJobId: Map<string, PersistedExportJobFailure>;
  directFolderPlanItemsById: ReadonlyMap<string, DirectFolderCapturePlanV1['items'][number]>;
  directFolderInitialIdentities: ReturnType<typeof directFolderInitialExportJobIdentityIndex>;
  directFolderAuthorizedJobIds: Set<string>;
  directFolderExpectedSuccessorsById: Map<string, ExportJob[]>;
  folderTreePlanItemsById: ReadonlyMap<string, FolderTreeCapturePlanV1['items'][number]>;
  folderTreeInitialIdentities: ReturnType<typeof folderTreeInitialExportJobIdentityIndex>;
  folderTreeAuthorizedJobIds: Set<string>;
  folderTreeExpectedSuccessorsById: Map<string, ExportJob[]>;
};

type ExportJobWriteIndex = {
  runId: string;
  context: ExportJobValidationContext;
  pendingJobIds: Set<string>;
  pendingJobIdBySignature: Map<string, string>;
  pendingJobIdByReceiptKey: Map<string, string>;
};

type ScopedFolderTraversalReplayCache = {
  runId: string;
  head: ScopedFolderTraversalJournalHead;
  mutationGeneration: number;
  dataVersion: number;
  checkpoint: DurableScopedFolderTraversalCheckpoint;
};

type ScopedFolderCommandAuditCache = {
  runId: string;
  mutationGeneration: number;
  dataVersion: number;
  unsettledCommandRequestId: string | null;
  commandRowCount: number;
  commandHistoryDigest: string;
  lastCommandRowId: number | null;
  activityRowCount: number;
  activityHistoryDigest: string;
  lastActivityRowId: number | null;
  requestLedgerRowCount: number;
  requestLedgerHistoryDigest: string;
  lastRequestLedgerRowId: number | null;
};

type ScopedFolderCommandAuditFingerprint = Omit<ScopedFolderCommandAuditCache, 'dataVersion'>;

type ScopedFolderExternalCommandAdoption = Readonly<{
  commandRequestId: string;
  mutationGeneration: number;
  dataVersion: number;
}>;

type ScopedFolderCommandHistoryRow = Readonly<{
  rowid: number;
  id: string;
  run_id: string;
  body_json: string;
}>;

type ScopedFolderCommandHistoryAudit = Readonly<{
  unsettledCommandRequestId: string | null;
  commandRowCount: number;
  commandHistoryDigest: string;
  commandHistoryPrefixDigest: string;
  lastCommandRowId: number | null;
  lastCommandRequestId: string | null;
  activityRowCount: number;
  activityHistoryDigest: string;
  activityHistoryPrefixDigest: string;
  lastActivityRowId: number | null;
  lastActivityCommandRequestId: string | null;
  requestLedgerRowCount: number;
  requestLedgerHistoryDigest: string;
  requestLedgerHistoryPrefixDigest: string;
  lastRequestLedgerRowId: number | null;
  lastRequestLedgerCommandRequestId: string | null;
}>;

type ScopedFolderProtectedHistoryAdvance = Readonly<{
  rowCount: number;
  historyDigest: string;
  lastRowId: number;
}>;

function scopedFolderCommandAuditFingerprint(
  cache: ScopedFolderCommandAuditCache
): ScopedFolderCommandAuditFingerprint {
  const { dataVersion: _dataVersion, ...fingerprint } = cache;
  return fingerprint;
}

function scopedFolderCommandAuditMatchesCache(
  audit: ScopedFolderCommandHistoryAudit,
  cache: ScopedFolderCommandAuditCache
): boolean {
  return (
    audit.unsettledCommandRequestId === cache.unsettledCommandRequestId &&
    audit.commandRowCount === cache.commandRowCount &&
    audit.commandHistoryDigest === cache.commandHistoryDigest &&
    audit.lastCommandRowId === cache.lastCommandRowId &&
    audit.activityRowCount === cache.activityRowCount &&
    audit.activityHistoryDigest === cache.activityHistoryDigest &&
    audit.lastActivityRowId === cache.lastActivityRowId &&
    audit.requestLedgerRowCount === cache.requestLedgerRowCount &&
    audit.requestLedgerHistoryDigest === cache.requestLedgerHistoryDigest &&
    audit.lastRequestLedgerRowId === cache.lastRequestLedgerRowId
  );
}

export type PersistedSourceObjectVersion = {
  id: string;
  runId: string;
  sourceObjectId: string;
  sourceJobId: string;
  sourceSnapshotId: string;
  capturedAt: string;
  supersedesVersionId: string | null;
  sourceObject: SourceObject;
};

export type PersistedExportCaptureEvidence = Readonly<{
  capture: PersistedExportCapture | null;
  archiveParts: readonly SourceSnapshotPart[];
  sourceObjectVersions: readonly PersistedSourceObjectVersion[];
}>;

export type LinkedItemRecoveryAttemptState = LinkedItemRecoveryState;

export type LinkedItemRecoverySafeFailure = Readonly<{
  code:
    | 'copy_failed'
    | 'source_unavailable'
    | 'unsafe_archive'
    | 'decode_failed'
    | 'target_mismatch'
    | 'projection_failed'
    | 'validation_failed'
    | 'internal';
  message: string;
  retryable: boolean;
  bestEffortFallbackSources?: readonly LinkedItemBestEffortFallbackSource[];
}>;

export type LinkedItemBestEffortFallbackSource = Readonly<{
  zipSha256: `sha256:${string}`;
  entryPaths: readonly string[];
}>;

export type LinkedItemRecoveryFileResult = Readonly<{
  fileIndex: number;
  outcome: 'accepted' | 'duplicate' | 'rejected';
  artifactId: string | null;
  failure: LinkedItemRecoverySafeFailure | null;
}>;

export type LinkedItemRecoveryAttemptMode = 'linked_item_recovery' | 'workspace_append';

export type LinkedItemRecoveryVersionConflict = Readonly<{
  sourceObjectId: string;
  stableId: string;
  name: string;
  expectedPriorScientificContentSha256: `sha256:${string}` | null;
}>;

export type LinkedItemRecoveryVersionConflictResolution =
  | Readonly<{ kind: 'none' }>
  | Readonly<{
      kind: 'awaiting_choice';
      firstConflict: LinkedItemRecoveryVersionConflict;
    }>
  | Readonly<{
      kind: 'resolved';
      policy: LinkedItemRecoveryVersionConflictPolicy;
      conflicts: readonly LinkedItemRecoveryVersionConflict[];
    }>;

export type LinkedItemRecoveryAttempt = Readonly<{
  schema: 'dnaforge.benchling.linked-item-recovery-attempt.v1';
  id: string;
  runId: string;
  mode: LinkedItemRecoveryAttemptMode;
  bestEffortFallback?: Readonly<{
    priorAttemptId: string;
    sources: readonly LinkedItemBestEffortFallbackSource[];
  }>;
  state: LinkedItemRecoveryAttemptState;
  resumeState: Exclude<LinkedItemRecoveryAttemptState, 'completed' | 'failed'> | null;
  recoveryPlan: ValidationLinkedItemRecoveryEvidence | null;
  intakeDescriptors: readonly LocalBenchlingExportIntakeDescriptor[];
  fileResults: readonly LinkedItemRecoveryFileResult[];
  artifactIds: readonly string[];
  sourceClaimsSha256?: string;
  selectedFileCount: number;
  processedFileCount: number;
  recoveredUniqueObjectCount: number;
  repairedRelationshipCount: number;
  retainedExistingObjectCount: number;
  retainedExistingObjects: readonly { stableId: string; name: string }[];
  corroboratedExistingObjectCount: number;
  pendingImportDecision: PendingImportDecision | null;
  pendingImportDecisionResumeState: 'parsing' | 'reconciling' | null;
  versionConflictResolution: LinkedItemRecoveryVersionConflictResolution;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  safeFailure: LinkedItemRecoverySafeFailure | null;
}>;

export type LinkedItemRecoveryArtifact =
  | Readonly<{
      schema: 'dnaforge.benchling.linked-item-recovery-artifact.v1';
      id: string;
      runId: string;
      attemptId: string;
      fileIndex: number;
      artifact: LocalBenchlingExportArtifact;
    }>
  | Readonly<{
      schema: 'dnaforge.benchling.linked-item-recovery-source.v2';
      id: string;
      runId: string;
      attemptId: string;
      fileIndex: number;
      externalZipSource: ExternalZipSource;
      externalZipEntries: readonly ExternalZipEntryEvidence[];
    }>;

export function linkedItemRecoveryArtifactSha256(
  artifact: LinkedItemRecoveryArtifact
): `sha256:${string}` {
  return artifact.schema === 'dnaforge.benchling.linked-item-recovery-source.v2'
    ? artifact.externalZipSource.zipSha256
    : artifact.artifact.sha256;
}

export function linkedItemRecoveryArtifactSizeBytes(artifact: LinkedItemRecoveryArtifact): number {
  return artifact.schema === 'dnaforge.benchling.linked-item-recovery-source.v2'
    ? artifact.externalZipSource.sizeBytes
    : artifact.artifact.sizeBytes;
}

export function linkedItemRecoveryArtifactDisplayName(
  artifact: LinkedItemRecoveryArtifact
): string {
  return artifact.schema === 'dnaforge.benchling.linked-item-recovery-source.v2'
    ? artifact.externalZipSource.displayName
    : artifact.artifact.logicalFilename;
}

export type LinkedItemRecoveryCapture = Readonly<{
  schema: 'dnaforge.benchling.linked-item-recovery-capture.v1';
  id: string;
  runId: string;
  attemptId: string;
  artifactId: string;
  sourceObjectId: string;
  sourceStableId: string;
  sourceScientificContentSha256: `sha256:${string}`;
  snapshotPartId: string;
  capturedAt: string;
  sourceFolderMemberships?: ReturnType<typeof readNativeSourceFolderMemberships>;
}>;

export type ProjectionReceiptHistoryEntry = Readonly<{
  receipt: ProjectionReceipt;
  supersedesReceiptId: string | null;
}>;

export type ProjectionReceiptRevisionInput = Readonly<{
  sourceSnapshot?: SourceObject;
  receipt: ProjectionReceipt;
  supersedesReceiptId: string;
}>;

export class SourceObjectContentConflictError extends Error {
  readonly activeSourceJobIds: string[];

  constructor(
    readonly runId: string,
    readonly sourceObjectId: string,
    activeSourceJobIds: Iterable<string>
  ) {
    const sortedJobIds = [...new Set(activeSourceJobIds)].sort();
    super(
      `Source object ${sourceObjectId} has conflicting non-membership content across active export leaves: ${sortedJobIds.join(', ')}.`
    );
    this.name = 'SourceObjectContentConflictError';
    this.activeSourceJobIds = sortedJobIds;
  }
}

export class RecoveredSourceObjectContentConflictError extends Error {
  constructor(
    readonly runId: string,
    readonly sourceObjectId: string,
    readonly existingScientificContentSha256: string,
    readonly candidateScientificContentSha256: string
  ) {
    super(
      `Recovered source object ${sourceObjectId} conflicts with the persisted scientific content.`
    );
    this.name = 'RecoveredSourceObjectContentConflictError';
  }
}

export type RecoveredSourceObjectVersionPolicy =
  | Readonly<{ kind: 'exact' }>
  | Readonly<{
      kind: 'replace_existing';
      expectedExistingScientificContentSha256: `sha256:${string}`;
    }>
  | Readonly<{
      kind: 'complete_needs_sequence';
      expectedExistingScientificContentSha256: `sha256:${string}`;
    }>;

function isNeedsSequenceReceiptCompletion(
  predecessor: ProjectionReceipt,
  candidate: ProjectionReceipt
): boolean {
  return (
    predecessor.projection === 'native' &&
    candidate.projection === 'native' &&
    predecessor.nativeRepresentation === 'dna_sequence_needs_sequence' &&
    candidate.nativeRepresentation === 'dna_sequence' &&
    projectionPackageDirectory(predecessor.destinationPath) ===
      projectionPackageDirectory(candidate.destinationPath)
  );
}

function projectionPackageDirectory(destinationPath: string): string {
  const forgeSegment = destinationPath.indexOf('/.forge/');
  return forgeSegment >= 0 ? destinationPath.slice(0, forgeSegment) : dirname(destinationPath);
}

export function migrationDataPath(workspacePath: string): string {
  return join(workspacePath, MIGRATION_DATA_DIR);
}

export function migrationDatabasePath(workspacePath: string): string {
  return join(migrationDataPath(workspacePath), MIGRATION_DATABASE_NAME);
}

export function openWorkspaceMigrationStore(
  workspacePath: string,
  telemetry: Pick<BenchlingMigrationTelemetry, 'captureOrigin'> | null = null
): MigrationStore {
  const dataPath = migrationDataPath(workspacePath);
  mkdirSync(dataPath, { recursive: true });
  const database = new Database(join(dataPath, MIGRATION_DATABASE_NAME));
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = FULL');
  database.pragma('foreign_keys = ON');
  return new MigrationStore(database, true, {}, telemetry);
}

export class MigrationStore {
  private static readonly fileBackedPeers = new Map<string, Set<MigrationStore>>();

  private exportJobWriteIndex: ExportJobWriteIndex | null = null;
  private scopedFolderTraversalReplayCache: ScopedFolderTraversalReplayCache | null = null;
  private scopedFolderCommandAuditCache: ScopedFolderCommandAuditCache | null = null;
  private scopedFolderCommandIntegrityFailure: Error | null = null;
  private scopedFolderTraversalIntegrityFailure: Error | null = null;
  private readonly fileBackedPeerKey: string | null;

  constructor(
    private readonly db: Database.Database,
    private readonly ownsDatabase = false,
    private readonly instrumentation: MigrationStoreInstrumentation = {},
    private readonly telemetry: Pick<BenchlingMigrationTelemetry, 'captureOrigin'> | null = null
  ) {
    this.fileBackedPeerKey = this.db.name === ':memory:' ? null : resolve(this.db.name);
    if (this.db.name !== ':memory:') this.db.pragma('synchronous = FULL');
    this.db.pragma('recursive_triggers = ON');
    if (this.db.pragma('recursive_triggers', { simple: true }) !== 1) {
      throw new Error('Benchling migration SQLite recursive triggers are required.');
    }
    this.initialize();
    this.migrateRecoveryCaptureOccurrences();
    this.registerFileBackedPeer();
  }

  private migrateRecoveryCaptureOccurrences(): void {
    const definition = this.db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='linked_item_recovery_capture'"
      )
      .get() as { sql: string };
    if (!/UNIQUE\s*\(\s*run_id\s*,\s*snapshot_part_id\s*\)/iu.test(definition.sql)) return;
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE linked_item_recovery_capture_action_scoped (
          id TEXT PRIMARY KEY, run_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
          artifact_id TEXT NOT NULL, source_object_id TEXT NOT NULL,
          snapshot_part_id TEXT NOT NULL, body_json TEXT NOT NULL CHECK(json_valid(body_json)),
          FOREIGN KEY(run_id) REFERENCES migration_run(id),
          FOREIGN KEY(attempt_id) REFERENCES linked_item_recovery_attempt(id),
          FOREIGN KEY(artifact_id) REFERENCES linked_item_recovery_artifact(id),
          UNIQUE(run_id,attempt_id,artifact_id,source_object_id),
          UNIQUE(run_id,attempt_id,snapshot_part_id)
        );
        INSERT INTO linked_item_recovery_capture_action_scoped
          SELECT id,run_id,attempt_id,artifact_id,source_object_id,snapshot_part_id,body_json
          FROM linked_item_recovery_capture;
        DROP TABLE linked_item_recovery_capture;
        ALTER TABLE linked_item_recovery_capture_action_scoped RENAME TO linked_item_recovery_capture;
        CREATE INDEX idx_linked_item_recovery_capture_attempt ON linked_item_recovery_capture(run_id,attempt_id);
      `);
    })();
  }

  close(): void {
    this.unregisterFileBackedPeer();
    if (this.ownsDatabase && this.db.open) this.db.close();
  }
  saveRun(run: MigrationRun): void {
    const existing = this.getRun();
    if (existing) {
      if (existing.id !== run.id) {
        throw new Error('A migration workspace may contain exactly one run.');
      }
      assertImmutableRunFields(existing, run);
      if (!canTransitionMigrationRun(existing, run.state, run.lastError)) {
        throw new Error(`Cannot persist illegal run transition ${existing.state} -> ${run.state}.`);
      }
    }
    assertExternalZipRunEvidence(run);
    assertProviderTaskPrivacySafe(run, 'migration run');
    const persist = () => {
      this.db
        .prepare(
          `INSERT INTO migration_run (singleton, id, state, body_json, updated_at)
           VALUES (1, ?, ?, ?, ?)
           ON CONFLICT(singleton) DO UPDATE SET
             state = excluded.state,
             body_json = excluded.body_json,
             updated_at = excluded.updated_at`
        )
        .run(run.id, run.state, JSON.stringify(run), run.updatedAt);
      this.db
        .prepare(
          `INSERT INTO scoped_folder_command_mutation_clock (run_id, generation)
           VALUES (?, 0)
           ON CONFLICT(run_id) DO NOTHING`
        )
        .run(run.id);
      this.updateInitialImportTelemetry(existing, run);
    };
    if (this.db.inTransaction) persist();
    else this.db.transaction(persist)();
  }

  private updateInitialImportTelemetry(existing: MigrationRun | null, run: MigrationRun): void {
    if (run.workspaceOrigin?.kind === 'adopted_existing') return;
    let attempt = this.getActiveMigrationTelemetryAttempt(run.id, 'initial_import');
    const terminalOutcome = terminalOutcomeForRun(run);
    if (!attempt && !terminalOutcome) {
      attempt = this.ensureMigrationTelemetryAttempt({
        runId: run.id,
        sourceAttemptReference: `initial_import:${run.attempt}`,
        operation: 'initial_import',
        startedAt: run.startedAt ?? run.createdAt,
        accepted: existing === null || run.attempt > existing.attempt,
      });
    }
    if (!terminalOutcome) return;
    if (!attempt) {
      const currentIdentity = this.getMigrationTelemetryAttemptBySourceReference(
        run.id,
        `initial_import:${run.attempt}`
      );
      if (!currentIdentity && existing) return;
      attempt =
        currentIdentity ??
        this.ensureMigrationTelemetryAttempt({
          runId: run.id,
          sourceAttemptReference: `initial_import:${run.attempt}`,
          operation: 'initial_import',
          startedAt: run.startedAt ?? run.createdAt,
          accepted: existing === null || run.attempt > existing.attempt,
        });
    }
    if (this.hasMigrationTelemetryTerminalReceipt(attempt.attemptId)) return;
    this.putMigrationTelemetryTerminalReceipt(
      projectBenchlingMigrationTerminal({
        identity: attempt,
        run,
        outcome: terminalOutcome,
        terminalStage: terminalStageForRunState(run.resumeState ?? existing?.state ?? run.state),
        terminalAt: run.updatedAt,
        report: this.getValidationReport(run.id),
      })
    );
  }

  ensureMigrationTelemetryAttempt(input: {
    runId: string;
    sourceAttemptReference: string;
    operation: BenchlingMigrationOperation;
    startedAt: string;
    accepted?: boolean;
  }): BenchlingMigrationAttemptIdentity {
    if (!this.db.inTransaction) {
      return this.db.transaction(() => this.ensureMigrationTelemetryAttempt(input))();
    }
    const existing = this.db
      .prepare(
        `SELECT body_json FROM migration_telemetry_attempt
          WHERE run_id = ? AND source_attempt_reference = ?`
      )
      .get(input.runId, input.sourceAttemptReference) as { body_json: string } | undefined;
    if (existing) return parseMigrationTelemetryAttempt(existing.body_json);
    const predecessor = this.db
      .prepare(
        `SELECT a.attempt_id, t.body_json AS terminal_json
           FROM migration_telemetry_attempt a
           LEFT JOIN migration_telemetry_terminal_receipt t ON t.attempt_id = a.attempt_id
          WHERE a.run_id = ? AND a.operation = ?
          ORDER BY a.attempt_sequence DESC LIMIT 1`
      )
      .get(input.runId, input.operation) as
      | { attempt_id: string; terminal_json: string | null }
      | undefined;
    const predecessorSucceeded =
      predecessor?.terminal_json !== null && predecessor?.terminal_json !== undefined
        ? parseMigrationTelemetryTerminalReceipt(predecessor.terminal_json).outcome === 'succeeded'
        : false;
    const sequenceRow = this.db
      .prepare(
        `SELECT COALESCE(MAX(attempt_sequence), 0) + 1 AS next_sequence
           FROM migration_telemetry_attempt WHERE run_id = ?`
      )
      .get(input.runId) as { next_sequence: number };
    const identity = createBenchlingMigrationAttemptIdentity({
      ...input,
      attemptSequence: sequenceRow.next_sequence,
    });
    this.db
      .prepare(
        `INSERT INTO migration_telemetry_attempt
           (attempt_id, terminal_event_id, run_id, source_attempt_reference,
            attempt_sequence, operation, started_at, body_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        identity.attemptId,
        identity.terminalEventId,
        identity.runId,
        identity.sourceAttemptReference,
        identity.attemptSequence,
        identity.operation,
        identity.startedAt,
        JSON.stringify(identity)
      );
    if (input.accepted !== false && this.telemetry) {
      const run = this.getRun();
      if (!run || run.id !== input.runId) {
        throw new Error('Accepted migration telemetry lost its owning run.');
      }
      const acceptance = createBenchlingMigrationTelemetryAcceptance({
        identity,
        run,
        origin: this.telemetry?.captureOrigin() ?? null,
        parentAttemptId: predecessor && !predecessorSucceeded ? predecessor.attempt_id : null,
      });
      this.db
        .prepare(
          `INSERT INTO migration_telemetry_acceptance (attempt_id, body_json)
           VALUES (?, ?)`
        )
        .run(identity.attemptId, JSON.stringify(acceptance));
    }
    return identity;
  }

  getMigrationTelemetryAcceptance(attemptId: string): BenchlingMigrationTelemetryAcceptance | null {
    if (this.db.inTransaction) return null;
    const row = this.db
      .prepare('SELECT body_json FROM migration_telemetry_acceptance WHERE attempt_id = ?')
      .get(attemptId) as { body_json: string } | undefined;
    if (!row) return null;
    const acceptance = parseBenchlingMigrationTelemetryAcceptance(row.body_json);
    if (acceptance.attemptId !== attemptId) {
      throw new Error('Migration telemetry acceptance identity changed.');
    }
    return acceptance;
  }

  listMigrationTelemetryAcceptances(runId: string): BenchlingMigrationTelemetryAcceptance[] {
    if (this.db.inTransaction) return [];
    const rows = this.db
      .prepare(
        `SELECT attempt_id FROM migration_telemetry_attempt
          WHERE run_id = ? ORDER BY attempt_sequence`
      )
      .all(runId) as Array<{ attempt_id: string }>;
    return rows.flatMap(({ attempt_id }) => {
      const acceptance = this.getMigrationTelemetryAcceptance(attempt_id);
      return acceptance ? [acceptance] : [];
    });
  }

  getActiveMigrationTelemetryAttempt(
    runId: string,
    operation?: BenchlingMigrationOperation
  ): BenchlingMigrationAttemptIdentity | null {
    const row = this.db
      .prepare(
        `SELECT a.body_json
           FROM migration_telemetry_attempt a
           LEFT JOIN migration_telemetry_terminal_receipt r ON r.attempt_id = a.attempt_id
          WHERE a.run_id = ? AND r.attempt_id IS NULL
            AND (? IS NULL OR a.operation = ?)
          ORDER BY a.attempt_sequence DESC
          LIMIT 1`
      )
      .get(runId, operation ?? null, operation ?? null) as { body_json: string } | undefined;
    return row ? parseMigrationTelemetryAttempt(row.body_json) : null;
  }

  private getMigrationTelemetryAttemptBySourceReference(
    runId: string,
    sourceAttemptReference: string
  ): BenchlingMigrationAttemptIdentity | null {
    const row = this.db
      .prepare(
        `SELECT body_json FROM migration_telemetry_attempt
          WHERE run_id = ? AND source_attempt_reference = ?`
      )
      .get(runId, sourceAttemptReference) as { body_json: string } | undefined;
    return row ? parseMigrationTelemetryAttempt(row.body_json) : null;
  }

  putMigrationTelemetryTerminalReceipt(receipt: BenchlingMigrationAttemptTerminalReceipt): void {
    const body = JSON.stringify(receipt);
    const existing = this.db
      .prepare('SELECT body_json FROM migration_telemetry_terminal_receipt WHERE attempt_id = ?')
      .get(receipt.identity.attemptId) as { body_json: string } | undefined;
    if (existing) {
      if (existing.body_json !== body) {
        throw new Error(`Migration telemetry terminal ${receipt.identity.attemptId} is immutable.`);
      }
      return;
    }
    const attemptRow = this.db
      .prepare('SELECT body_json FROM migration_telemetry_attempt WHERE attempt_id = ?')
      .get(receipt.identity.attemptId) as { body_json: string } | undefined;
    const attempt = attemptRow ? parseMigrationTelemetryAttempt(attemptRow.body_json) : null;
    if (
      !attempt ||
      JSON.stringify(benchlingMigrationAttemptReceiptIdentity(attempt)) !==
        JSON.stringify(receipt.identity)
    ) {
      throw new Error('Migration telemetry terminal does not match its durable attempt identity.');
    }
    this.db
      .prepare(
        `INSERT INTO migration_telemetry_terminal_receipt
           (attempt_id, run_id, terminal_event_id, terminal_at, body_json)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        receipt.identity.attemptId,
        attempt.runId,
        receipt.identity.terminalEventId,
        receipt.terminalAt,
        body
      );
  }

  private hasMigrationTelemetryTerminalReceipt(attemptId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          'SELECT 1 AS present FROM migration_telemetry_terminal_receipt WHERE attempt_id = ?'
        )
        .get(attemptId)
    );
  }

  listMigrationTelemetryTerminalReceipts(
    runId: string
  ): BenchlingMigrationAttemptTerminalReceipt[] {
    const rows = this.db
      .prepare(
        `SELECT body_json FROM migration_telemetry_terminal_receipt
          WHERE run_id = ? ORDER BY rowid`
      )
      .all(runId) as Array<{ body_json: string }>;
    return rows.map((row) => parseMigrationTelemetryTerminalReceipt(row.body_json));
  }

  getCommittedMigrationTelemetryTerminal(
    attemptId: string
  ): BenchlingMigrationAttemptTerminalReceipt | null {
    if (this.db.inTransaction) return null;
    const row = this.db
      .prepare('SELECT body_json FROM migration_telemetry_terminal_receipt WHERE attempt_id = ?')
      .get(attemptId) as { body_json: string } | undefined;
    if (!row) return null;
    const receipt = parseMigrationTelemetryTerminalReceipt(row.body_json);
    if (receipt.identity.attemptId !== attemptId) {
      throw new Error('Migration telemetry terminal identity changed.');
    }
    return receipt;
  }

  saveRuns(runs: readonly MigrationRun[]): void {
    this.db.transaction(() => {
      for (const run of runs) this.saveRun(run);
    })();
  }

  saveRunWithImportDecisions(run: MigrationRun, decisions: readonly ImportDecision[]): void {
    this.db.transaction(() => {
      this.saveRun(run);
      for (const decision of decisions) this.putImportDecision(run.id, run.id, decision);
    })();
  }

  restoreReadyRunAfterFailedUnlock(input: {
    unlockedRun: MigrationRun;
    readyRun: MigrationRun;
  }): void {
    if (input.unlockedRun.state !== 'unlocked' || input.readyRun.state !== 'ready_to_unlock') {
      throw new Error('Failed-unlock recovery requires unlocked and ready-to-unlock run states.');
    }
    if (input.unlockedRun.id !== input.readyRun.id) {
      throw new Error('Failed-unlock recovery run identity does not match.');
    }
    assertImmutableRunFields(input.unlockedRun, input.readyRun);
    assertProviderTaskPrivacySafe(input.readyRun, 'migration run');
    const restored = this.db
      .prepare(
        `UPDATE migration_run
           SET state = ?, body_json = ?, updated_at = ?
         WHERE singleton = 1 AND id = ? AND state = ? AND body_json = ?`
      )
      .run(
        input.readyRun.state,
        JSON.stringify(input.readyRun),
        input.readyRun.updatedAt,
        input.readyRun.id,
        input.unlockedRun.state,
        JSON.stringify(input.unlockedRun)
      );
    if (restored.changes !== 1) {
      throw new Error('Failed-unlock recovery lost its unlocked-run compare-and-set.');
    }
  }

  restoreFailedLocalRunForRetry(input: { failedRun: MigrationRun; retryRun: MigrationRun }): void {
    const { failedRun, retryRun } = input;
    if (
      failedRun.state !== 'failed' ||
      failedRun.lastError?.code !== 'internal_invariant' ||
      failedRun.scope.acquisition !== 'local_bundle' ||
      failedRun.localExportArtifact?.format !== 'zip' ||
      retryRun.state !== 'parsing' ||
      retryRun.resumeState !== null ||
      retryRun.lastError !== null ||
      retryRun.attempt !== failedRun.attempt ||
      retryRun.unlockedAt !== null
    ) {
      throw new Error('Failed migration retry requires one preserved local ZIP invariant failure.');
    }
    assertImmutableRunFields(failedRun, retryRun);
    assertProviderTaskPrivacySafe(retryRun, 'migration run');
    const restored = this.db
      .prepare(
        `UPDATE migration_run
           SET state = ?, body_json = ?, updated_at = ?
         WHERE singleton = 1 AND id = ? AND state = ? AND body_json = ?`
      )
      .run(
        retryRun.state,
        JSON.stringify(retryRun),
        retryRun.updatedAt,
        retryRun.id,
        failedRun.state,
        JSON.stringify(failedRun)
      );
    if (restored.changes !== 1) {
      throw new Error('Failed migration retry lost its failed-run compare-and-set.');
    }
  }

  getRun(): MigrationRun | null {
    const row = this.db.prepare('SELECT body_json FROM migration_run WHERE singleton = 1').get() as
      | { body_json: string }
      | undefined;
    return row ? (JSON.parse(row.body_json) as MigrationRun) : null;
  }

  initializeScopedFolderTraversalJournal(
    input: InitializeScopedFolderTraversalJournalInput
  ): ScopedFolderTraversalJournalHead {
    const runId = requireScopedFolderTraversalRunId(input.runId);
    const journal = createScopedFolderTraversalJournal({
      scopeKind: input.scopeKind,
      selectedRootIds: input.selectedRootIds,
      includeArchived: input.includeArchived ?? false,
    });
    const bodyJson = canonicalScopedFolderTraversalJson(journal);
    const headerHash = scopedFolderTraversalPersistenceHash({
      schema: SCOPED_FOLDER_TRAVERSAL_SQLITE_HEADER_SCHEMA,
      runId,
      journal,
    });

    const initialize = this.db.transaction(() => {
      const run = this.requireScopedFolderTraversalRun(runId);
      assertScopedFolderTraversalJournalMatchesRunScope(run, journal);
      const existing = this.db
        .prepare(
          `SELECT 1
           FROM scoped_folder_traversal_header
           WHERE run_id = ?`
        )
        .get(runId);
      if (existing) {
        const persisted = this.readScopedFolderTraversalState(runId);
        if (!persisted) throw new Error('Scoped Folder traversal header disappeared.');
        const persistedHeader = {
          ...persisted.journal,
          entries: [],
        } satisfies ScopedFolderTraversalJournal;
        if (
          canonicalScopedFolderTraversalJson(persistedHeader) !==
          canonicalScopedFolderTraversalJson(journal)
        ) {
          throw new Error(`Scoped Folder traversal journal for run ${runId} already exists.`);
        }
        return Object.freeze({
          head: persisted.head,
          mutationGeneration: this.readScopedFolderTraversalMutationGeneration(runId),
        });
      }

      const priorMutationClock = this.db
        .prepare(
          `SELECT generation
           FROM scoped_folder_traversal_mutation_clock
           WHERE run_id = ?`
        )
        .get(runId);
      if (priorMutationClock) {
        throw new Error(
          `Scoped Folder traversal header for run ${runId} is missing after prior persistence.`
        );
      }

      this.db
        .prepare(
          `INSERT INTO scoped_folder_traversal_header
             (run_id, body_json, header_hash, page_count, head_record_hash)
           VALUES (?, ?, ?, 0, ?)`
        )
        .run(runId, bodyJson, headerHash, headerHash);
      const mutationGeneration = this.readScopedFolderTraversalMutationGeneration(runId);
      if (mutationGeneration !== 1) {
        throw new Error('Scoped Folder traversal initialization mutation clock is invalid.');
      }
      return Object.freeze({
        head: Object.freeze({ pageCount: 0, recordHash: headerHash }),
        mutationGeneration,
      });
    });
    const initialized = initialize.immediate();
    const head = initialized.head;
    if (head.pageCount === 0) {
      this.scopedFolderTraversalReplayCache = {
        runId,
        head,
        mutationGeneration: initialized.mutationGeneration,
        dataVersion: this.readSqliteDataVersion(),
        checkpoint: createDurableScopedFolderTraversalCheckpoint(journal),
      };
    }
    return head;
  }

  appendScopedFolderTraversalJournalEntry(
    input: AppendScopedFolderTraversalJournalEntryInput
  ): ScopedFolderTraversalJournalHead {
    const runId = requireScopedFolderTraversalRunId(input.runId);
    const sourceCommandRequestId = requireOpaqueId(
      input.sourceCommandRequestId,
      'Scoped Folder source command request ID'
    );
    const expectedHead = normalizeScopedFolderTraversalHead(input.expectedHead);
    let advancedCheckpoint: DurableScopedFolderTraversalCheckpoint | null = null;
    const append = this.db.transaction(() => {
      this.requireScopedFolderTraversalRun(runId);
      const persisted = this.requireScopedFolderTraversalReplayCache(runId);
      if (
        persisted.head.pageCount !== expectedHead.pageCount ||
        persisted.head.recordHash !== expectedHead.recordHash
      ) {
        throw new Error(`Scoped Folder traversal journal head for run ${runId} is stale.`);
      }

      advancedCheckpoint = persisted.checkpoint;
      const entry = appendDurableScopedFolderTraversalCheckpointEntry(
        persisted.checkpoint,
        input.entry
      );
      this.instrumentation.onScopedFolderTraversalIncrementalPageValidation?.();
      if (
        canonicalScopedFolderTraversalJson(input.entry) !==
        canonicalScopedFolderTraversalJson(entry)
      ) {
        throw new Error('Scoped Folder traversal persisted page entry is not canonical.');
      }
      const ordinal = persisted.head.pageCount;
      const bodyJson = canonicalScopedFolderTraversalJson(entry);
      const recordHash = scopedFolderTraversalPersistenceHash({
        schema: SCOPED_FOLDER_TRAVERSAL_SQLITE_PAGE_SCHEMA,
        runId,
        ordinal,
        previousRecordHash: persisted.head.recordHash,
        sourceCommandRequestId,
        entry,
      });
      this.db
        .prepare(
          `INSERT INTO scoped_folder_traversal_page
             (run_id, ordinal, source_command_request_id, previous_record_hash, record_hash, body_json)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          runId,
          ordinal,
          sourceCommandRequestId,
          persisted.head.recordHash,
          recordHash,
          bodyJson
        );
      const advanced = this.db
        .prepare(
          `UPDATE scoped_folder_traversal_header
           SET page_count = ?, head_record_hash = ?
           WHERE run_id = ? AND page_count = ? AND head_record_hash = ?`
        )
        .run(ordinal + 1, recordHash, runId, ordinal, persisted.head.recordHash);
      if (advanced.changes !== 1) {
        throw new Error(`Scoped Folder traversal journal head for run ${runId} changed.`);
      }
      return Object.freeze({
        head: Object.freeze({ pageCount: ordinal + 1, recordHash }),
        mutationGeneration: this.requireOwnedScopedFolderMutationAdvance(
          runId,
          persisted.mutationGeneration,
          2
        ),
      });
    });
    try {
      const committed = append.immediate();
      const head = committed.head;
      const cache = this.scopedFolderTraversalReplayCache;
      if (cache && cache.runId === runId && cache.checkpoint === advancedCheckpoint) {
        cache.head = head;
        cache.mutationGeneration = committed.mutationGeneration;
      }
      return head;
    } catch (error) {
      if (advancedCheckpoint) {
        invalidateDurableScopedFolderTraversalCheckpoint(advancedCheckpoint);
        this.clearScopedFolderTraversalReplayCache();
      }
      throw error;
    }
  }

  settleScopedFolderDiscovery(
    input: SettleScopedFolderDiscoveryInput
  ): ScopedFolderDiscoverySettlementResult {
    assertExactRecordKeys(
      requireRecord(input, 'Scoped Folder settlement'),
      ['runId', 'commandRequestId', 'pageRequest', 'activity', 'requestLedgerEntry', 'page'],
      'Scoped Folder settlement'
    );
    const runId = requireScopedFolderTraversalRunId(input.runId);
    const commandRequestId = requireOpaqueId(
      input.commandRequestId,
      'Scoped Folder settlement command request ID'
    );
    const pageRequestSha256 = scopedFolderTraversalPageRequestSha256(input.pageRequest);
    const page = normalizeScopedFolderSettlementPage(input.page);
    const activity = validateScopedFolderSettlementActivity(
      input.activity,
      runId,
      commandRequestId
    );
    const requestLedgerEntry = validateScopedFolderSettlementRequestLedgerEntry(
      input.requestLedgerEntry,
      runId,
      commandRequestId,
      pageRequestSha256
    );

    let advancedCheckpoint: DurableScopedFolderTraversalCheckpoint | null = null;
    const settle = this.db.transaction(() => {
      const run = this.requireScopedFolderTraversalRun(runId);
      const command = this.requireScopedFolderCommand(run, commandRequestId);
      assertScopedFolderCommandMatchesRequest(command, input.pageRequest, pageRequestSha256);
      assertScopedFolderSettlementMode(command.scopedFolderCorrelation, page.mode);
      const priorCommandAudit =
        this.scopedFolderCommandAuditCache?.runId === runId
          ? Object.freeze({
              cache: this.scopedFolderCommandAuditCache,
              mutationGeneration: this.scopedFolderCommandAuditCache.mutationGeneration,
              dataVersion: this.scopedFolderCommandAuditCache.dataVersion,
              unsettledCommandRequestId:
                this.scopedFolderCommandAuditCache.unsettledCommandRequestId,
            })
          : null;
      const commandAudit = this.requireScopedFolderCommandAuditCache(runId, {
        adoptExternalUnsettledCommandRequestId: commandRequestId,
      });
      const priorCommandAuditFingerprint = scopedFolderCommandAuditFingerprint(commandAudit);
      this.requireFileBackedPeersAlignedWithScopedFolderHistory(priorCommandAuditFingerprint);
      const externalCommandAdoption: ScopedFolderExternalCommandAdoption | null =
        priorCommandAudit &&
        priorCommandAudit.cache === commandAudit &&
        priorCommandAudit.unsettledCommandRequestId === null &&
        commandAudit.unsettledCommandRequestId === commandRequestId &&
        commandAudit.mutationGeneration === priorCommandAudit.mutationGeneration + 1 &&
        commandAudit.dataVersion !== priorCommandAudit.dataVersion
          ? Object.freeze({
              commandRequestId,
              mutationGeneration: commandAudit.mutationGeneration,
              dataVersion: commandAudit.dataVersion,
            })
          : null;
      const persisted = this.requireScopedFolderTraversalReplayCache(runId, undefined, undefined, {
        externalCommandAdoption,
      });

      const activityExists = this.assertScopedFolderSettlementRecordState(
        'provider_activity_evidence',
        activity.id,
        runId,
        commandRequestId,
        activity
      );
      const requestLedgerExists = this.assertScopedFolderSettlementRecordState(
        'request_ledger',
        requestLedgerEntry.id,
        runId,
        commandRequestId,
        requestLedgerEntry
      );
      if (activityExists !== requestLedgerExists) {
        throw new Error('Scoped Folder command has a partial durable settlement.');
      }
      const alreadySettled = activityExists;
      let settlementHistoryAdvances: ReturnType<
        MigrationStore['requireOwnedScopedFolderSettlementHistoryAdvances']
      > | null = null;
      if (!alreadySettled && commandAudit.unsettledCommandRequestId !== commandRequestId) {
        throw new Error(
          `Scoped Folder settlement ${commandRequestId} does not match the sole unsettled command tail.`
        );
      }
      const sourcePage = this.db
        .prepare(
          `SELECT ordinal, source_command_request_id, previous_record_hash, record_hash, body_json
           FROM scoped_folder_traversal_page
           WHERE run_id = ? AND source_command_request_id = ?`
        )
        .get(runId, commandRequestId) as ScopedFolderPersistedPageRow | undefined;

      if (page.mode === 'append') {
        const expectedHead = page.expectedHead;
        if (sourcePage) {
          if (!alreadySettled) {
            throw new Error('Scoped Folder command has a page without its atomic settlement.');
          }
          if (
            sourcePage.ordinal !== expectedHead.pageCount ||
            sourcePage.previous_record_hash !== expectedHead.recordHash
          ) {
            throw new Error('Scoped Folder append retry has the wrong original journal head.');
          }
          const verified = verifyDurableScopedFolderTraversalCheckpointReplayEntry(
            persisted.checkpoint,
            input.pageRequest,
            page.entry
          );
          if (
            canonicalScopedFolderTraversalJson(verified) !== sourcePage.body_json ||
            sourcePage.source_command_request_id !== commandRequestId
          ) {
            throw new Error('Scoped Folder append retry conflicts with its persisted page.');
          }
          return Object.freeze({
            result: Object.freeze({
              head: persisted.head,
              pageDisposition: 'replay_verified' as const,
              alreadySettled: true,
            }),
            mutationGeneration: this.requireOwnedScopedFolderMutationAdvance(
              runId,
              persisted.mutationGeneration,
              0
            ),
            commandMutationGeneration: this.requireOwnedScopedFolderCommandMutationAdvance(
              runId,
              commandAudit.mutationGeneration,
              0
            ),
            commandAudit,
            priorCommandAuditFingerprint,
            settlementHistoryAdvances,
          });
        }
        if (alreadySettled) {
          throw new Error('Scoped Folder advance settlement is missing its persisted page.');
        }
        assertScopedFolderHeadMatches(persisted.head, expectedHead, runId);
        advancedCheckpoint = persisted.checkpoint;
        const entry = appendDurableScopedFolderTraversalCheckpointEntry(
          persisted.checkpoint,
          page.entry
        );
        this.instrumentation.onScopedFolderTraversalIncrementalPageValidation?.();
        if (
          canonicalScopedFolderTraversalJson(page.entry) !==
          canonicalScopedFolderTraversalJson(entry)
        ) {
          throw new Error('Scoped Folder traversal persisted page entry is not canonical.');
        }
        assertScopedFolderEntryMatchesRequest(entry, input.pageRequest);
        assertSuccessfulScopedFolderSettlement(activity, requestLedgerEntry, page.mode);

        this.appendImmutableJson('provider_activity_evidence', activity.id, runId, activity);
        this.instrumentation.onScopedFolderSettlementStep?.('after_activity');
        this.appendImmutableJson(
          'request_ledger',
          requestLedgerEntry.id,
          runId,
          requestLedgerEntry
        );
        this.instrumentation.onScopedFolderSettlementStep?.('after_request_ledger');
        settlementHistoryAdvances = this.requireOwnedScopedFolderSettlementHistoryAdvances(
          commandAudit,
          activity.id,
          requestLedgerEntry.id
        );

        const ordinal = persisted.head.pageCount;
        const bodyJson = canonicalScopedFolderTraversalJson(entry);
        const recordHash = scopedFolderTraversalPersistenceHash({
          schema: SCOPED_FOLDER_TRAVERSAL_SQLITE_PAGE_SCHEMA,
          runId,
          ordinal,
          previousRecordHash: persisted.head.recordHash,
          sourceCommandRequestId: commandRequestId,
          entry,
        });
        this.db
          .prepare(
            `INSERT INTO scoped_folder_traversal_page
               (run_id, ordinal, source_command_request_id, previous_record_hash, record_hash, body_json)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(runId, ordinal, commandRequestId, persisted.head.recordHash, recordHash, bodyJson);
        const advanced = this.db
          .prepare(
            `UPDATE scoped_folder_traversal_header
             SET page_count = ?, head_record_hash = ?
             WHERE run_id = ? AND page_count = ? AND head_record_hash = ?`
          )
          .run(ordinal + 1, recordHash, runId, ordinal, persisted.head.recordHash);
        if (advanced.changes !== 1) {
          throw new Error(`Scoped Folder traversal journal head for run ${runId} changed.`);
        }
        this.instrumentation.onScopedFolderSettlementStep?.('after_page');
        return Object.freeze({
          result: Object.freeze({
            head: Object.freeze({ pageCount: ordinal + 1, recordHash }),
            pageDisposition: 'appended' as const,
            alreadySettled: false,
          }),
          mutationGeneration: this.requireOwnedScopedFolderMutationAdvance(
            runId,
            persisted.mutationGeneration,
            2
          ),
          commandMutationGeneration: this.requireOwnedScopedFolderCommandMutationAdvance(
            runId,
            commandAudit.mutationGeneration,
            2
          ),
          commandAudit,
          priorCommandAuditFingerprint,
          settlementHistoryAdvances,
        });
      }

      if (sourcePage) {
        throw new Error('Scoped Folder rehydrate command cannot own a traversal page.');
      }
      assertScopedFolderHeadMatches(persisted.head, page.expectedHead, runId);
      if (page.mode === 'replay') {
        verifyDurableScopedFolderTraversalCheckpointReplayEntry(
          persisted.checkpoint,
          input.pageRequest,
          page.entry
        );
        assertSuccessfulScopedFolderSettlement(activity, requestLedgerEntry, page.mode);
      } else {
        assertFailedScopedFolderSettlement(activity, requestLedgerEntry);
      }
      if (!alreadySettled) {
        this.appendImmutableJson('provider_activity_evidence', activity.id, runId, activity);
        this.instrumentation.onScopedFolderSettlementStep?.('after_activity');
        this.appendImmutableJson(
          'request_ledger',
          requestLedgerEntry.id,
          runId,
          requestLedgerEntry
        );
        this.instrumentation.onScopedFolderSettlementStep?.('after_request_ledger');
        settlementHistoryAdvances = this.requireOwnedScopedFolderSettlementHistoryAdvances(
          commandAudit,
          activity.id,
          requestLedgerEntry.id
        );
        this.instrumentation.onScopedFolderSettlementStep?.('after_page');
      }
      return Object.freeze({
        result: Object.freeze({
          head: persisted.head,
          pageDisposition:
            page.mode === 'replay' ? ('replay_verified' as const) : ('none' as const),
          alreadySettled,
        }),
        mutationGeneration: this.requireOwnedScopedFolderMutationAdvance(
          runId,
          persisted.mutationGeneration,
          0
        ),
        commandMutationGeneration: this.requireOwnedScopedFolderCommandMutationAdvance(
          runId,
          commandAudit.mutationGeneration,
          alreadySettled ? 0 : 2
        ),
        commandAudit,
        priorCommandAuditFingerprint,
        settlementHistoryAdvances,
      });
    });
    try {
      const committed = settle.immediate();
      const result = committed.result;
      const cache = this.scopedFolderTraversalReplayCache;
      if (cache && cache.runId === runId && cache.checkpoint === advancedCheckpoint) {
        cache.head = result.head;
        cache.mutationGeneration = committed.mutationGeneration;
      }
      if (this.scopedFolderCommandAuditCache === committed.commandAudit) {
        committed.commandAudit.mutationGeneration = committed.commandMutationGeneration;
        if (!result.alreadySettled) {
          committed.commandAudit.unsettledCommandRequestId = null;
        }
        if (committed.settlementHistoryAdvances) {
          committed.commandAudit.activityRowCount =
            committed.settlementHistoryAdvances.activity.rowCount;
          committed.commandAudit.activityHistoryDigest =
            committed.settlementHistoryAdvances.activity.historyDigest;
          committed.commandAudit.lastActivityRowId =
            committed.settlementHistoryAdvances.activity.lastRowId;
          committed.commandAudit.requestLedgerRowCount =
            committed.settlementHistoryAdvances.requestLedger.rowCount;
          committed.commandAudit.requestLedgerHistoryDigest =
            committed.settlementHistoryAdvances.requestLedger.historyDigest;
          committed.commandAudit.lastRequestLedgerRowId =
            committed.settlementHistoryAdvances.requestLedger.lastRowId;
        }
        this.notifyFileBackedPeersOfOwnedScopedFolderHistoryCommit(
          committed.priorCommandAuditFingerprint,
          scopedFolderCommandAuditFingerprint(committed.commandAudit)
        );
      }
      return result;
    } catch (error) {
      if (advancedCheckpoint) {
        invalidateDurableScopedFolderTraversalCheckpoint(advancedCheckpoint);
        this.clearScopedFolderTraversalReplayCache();
      }
      throw error;
    }
  }

  listUnsettledScopedFolderCommands(runId: string): UnsettledScopedFolderCommand[] {
    const normalizedRunId = requireScopedFolderTraversalRunId(runId);
    this.requireScopedFolderCommandAuditCache(normalizedRunId);
    const run = this.requireScopedFolderTraversalRun(normalizedRunId);
    const rows = this.db
      .prepare(
        `SELECT body_json
         FROM provider_command_journal
         WHERE run_id = ?
           AND json_extract(body_json, '$.operationKind') = 'discover_scoped_folder_page'
         ORDER BY rowid`
      )
      .all(normalizedRunId) as Array<{ body_json: string }>;
    const unsettled: UnsettledScopedFolderCommand[] = [];
    for (const row of rows) {
      const command = validateProviderCommandJournalEntry(
        JSON.parse(row.body_json) as unknown,
        run
      );
      if (!isScopedFolderCommand(command)) {
        throw new Error('Scoped Folder command query returned a different operation.');
      }
      const commandRequestId = command.commandRequestId;
      const activityCount = countScopedFolderSettlementRows(
        this.db,
        'provider_activity_evidence',
        normalizedRunId,
        commandRequestId
      );
      const ledgerCount = countScopedFolderSettlementRows(
        this.db,
        'request_ledger',
        normalizedRunId,
        commandRequestId
      );
      const pageCount = (
        this.db
          .prepare(
            `SELECT count(*) AS count
             FROM scoped_folder_traversal_page
             WHERE run_id = ? AND source_command_request_id = ?`
          )
          .get(normalizedRunId, commandRequestId) as { count: number }
      ).count;
      if (activityCount > 1 || ledgerCount > 1 || pageCount > 1) {
        throw new Error('Scoped Folder command has duplicate durable settlement records.');
      }
      if (activityCount !== ledgerCount) {
        throw new Error('Scoped Folder command has a partial durable settlement.');
      }
      if (activityCount === 0) {
        if (pageCount !== 0) {
          throw new Error('Scoped Folder command has a page without its atomic settlement.');
        }
        unsettled.push(command);
        continue;
      }
      const settledAdvanceWithoutPage =
        command.scopedFolderCorrelation.purpose === 'advance' &&
        pageCount === 0 &&
        this.isPersistedScopedFolderFailure(command);
      const expectedPageCount = command.scopedFolderCorrelation.purpose === 'advance' ? 1 : 0;
      if (pageCount !== expectedPageCount && !settledAdvanceWithoutPage) {
        throw new Error('Scoped Folder command settlement contradicts its recovery purpose.');
      }
    }
    return unsettled;
  }

  getScopedFolderRequestLedgerEntry(
    runId: string,
    commandRequestId: string
  ): MigrationRequestLedgerEntry | null {
    const normalizedRunId = requireScopedFolderTraversalRunId(runId);
    this.requireScopedFolderCommandAuditCache(normalizedRunId);
    const normalizedCommandRequestId = requireOpaqueId(
      commandRequestId,
      'Scoped Folder request-ledger command request ID'
    );
    const run = this.requireScopedFolderTraversalRun(normalizedRunId);
    const command = this.requireScopedFolderCommand(run, normalizedCommandRequestId);
    const rows = this.db
      .prepare(
        `SELECT body_json
         FROM request_ledger
         WHERE run_id = ?
           AND json_extract(body_json, '$.commandRequestId') = ?`
      )
      .all(normalizedRunId, normalizedCommandRequestId) as Array<{ body_json: string }>;
    if (rows.length > 1) {
      throw new Error('Scoped Folder command has duplicate request_ledger records.');
    }
    const row = rows[0];
    if (!row) return null;
    return validateScopedFolderSettlementRequestLedgerEntry(
      JSON.parse(row.body_json) as unknown,
      normalizedRunId,
      normalizedCommandRequestId,
      command.scopedFolderCorrelation.pageRequestSha256
    );
  }

  countScopedFolderTransientFailures(
    runId: string,
    purpose: 'advance' | 'rehydrate',
    pageRequestSha256: string
  ): number {
    const normalizedRunId = requireScopedFolderTraversalRunId(runId);
    if (purpose !== 'advance' && purpose !== 'rehydrate') {
      throw new Error('Scoped Folder retry purpose is invalid.');
    }
    if (!SHA256_REF.test(pageRequestSha256)) {
      throw new Error('Scoped Folder retry page-request digest is invalid.');
    }
    const run = this.requireScopedFolderTraversalRun(normalizedRunId);
    this.requireScopedFolderCommandAuditCache(normalizedRunId);
    const rows = this.db
      .prepare(
        `SELECT command.body_json AS command_body,
                ledger.body_json AS ledger_body,
                activity.body_json AS activity_body
         FROM provider_command_journal AS command
         LEFT JOIN request_ledger AS ledger
           ON ledger.run_id = command.run_id
          AND json_extract(ledger.body_json, '$.commandRequestId') =
              json_extract(command.body_json, '$.commandRequestId')
         LEFT JOIN provider_activity_evidence AS activity
           ON activity.run_id = command.run_id
          AND json_extract(activity.body_json, '$.commandRequestId') =
              json_extract(command.body_json, '$.commandRequestId')
         WHERE command.run_id = ?
           AND json_extract(command.body_json, '$.operationKind') =
               'discover_scoped_folder_page'
           AND json_extract(command.body_json, '$.scopedFolderCorrelation.purpose') = ?
           AND json_extract(command.body_json, '$.scopedFolderCorrelation.pageRequestSha256') = ?
         ORDER BY command.rowid`
      )
      .all(normalizedRunId, purpose, pageRequestSha256) as Array<{
      command_body: string;
      ledger_body: string | null;
      activity_body: string | null;
    }>;
    let count = 0;
    for (const row of rows) {
      const command = validateProviderCommandJournalEntry(
        JSON.parse(row.command_body) as unknown,
        run
      );
      if (
        !isScopedFolderCommand(command) ||
        command.scopedFolderCorrelation.purpose !== purpose ||
        command.scopedFolderCorrelation.pageRequestSha256 !== pageRequestSha256
      ) {
        throw new Error('Scoped Folder retry query returned a different command correlation.');
      }
      if ((row.ledger_body === null) !== (row.activity_body === null)) {
        throw new Error('Scoped Folder retry history contains a partial durable settlement.');
      }
      if (row.ledger_body === null || row.activity_body === null) continue;
      const ledger = validateScopedFolderSettlementRequestLedgerEntry(
        JSON.parse(row.ledger_body) as unknown,
        normalizedRunId,
        command.commandRequestId,
        pageRequestSha256
      );
      const activity = validateScopedFolderSettlementActivity(
        JSON.parse(row.activity_body) as unknown,
        normalizedRunId,
        command.commandRequestId
      );
      if (ledger.outcome === 'success') {
        assertSuccessfulScopedFolderSettlement(
          activity,
          ledger,
          purpose === 'advance' ? 'append' : 'replay'
        );
      } else {
        assertFailedScopedFolderSettlement(activity, ledger);
        if (
          ledger.outcome === 'transient_failure' &&
          !isExactTraversalAuthorityMiss(activity, ledger) &&
          !isExactProviderPreDispatchMiss(activity, ledger)
        ) {
          count += 1;
        }
      }
    }
    return count;
  }

  getLatestSettledScopedFolderCommandId(
    runId: string,
    receiptEpoch: string | null,
    beforeCommandRequestId: string | null
  ): string | null {
    const normalizedRunId = requireScopedFolderTraversalRunId(runId);
    this.requireScopedFolderCommandAuditCache(normalizedRunId);
    if (receiptEpoch === null) return null;
    const normalizedEpoch = requireScopedFolderReceiptEpoch(receiptEpoch);
    const run = this.requireScopedFolderTraversalRun(normalizedRunId);
    let beforeRowId = Number.MAX_SAFE_INTEGER;
    if (beforeCommandRequestId !== null) {
      const normalizedBeforeId = requireOpaqueId(
        beforeCommandRequestId,
        'Scoped Folder prior-command boundary ID'
      );
      const before = this.db
        .prepare(
          `SELECT rowid, body_json
           FROM provider_command_journal
           WHERE run_id = ? AND json_extract(body_json, '$.commandRequestId') = ?`
        )
        .get(normalizedRunId, normalizedBeforeId) as
        | { rowid: number; body_json: string }
        | undefined;
      if (!before) throw new Error('Scoped Folder recovery command is absent from the journal.');
      const command = validateProviderCommandJournalEntry(
        JSON.parse(before.body_json) as unknown,
        run
      );
      if (command.operationKind !== 'discover_scoped_folder_page') {
        throw new Error('Scoped Folder prior-command boundary has the wrong operation.');
      }
      beforeRowId = before.rowid;
    }
    const row = this.db
      .prepare(
        `SELECT command.body_json AS command_body,
                activity.body_json AS activity_body,
                ledger.body_json AS ledger_body
         FROM provider_command_journal AS command
         LEFT JOIN provider_activity_evidence AS activity
           ON activity.run_id = command.run_id
          AND json_extract(activity.body_json, '$.commandRequestId') =
              json_extract(command.body_json, '$.commandRequestId')
         LEFT JOIN request_ledger AS ledger
           ON ledger.run_id = command.run_id
          AND json_extract(ledger.body_json, '$.commandRequestId') =
              json_extract(command.body_json, '$.commandRequestId')
         WHERE command.run_id = ?
           AND command.rowid < ?
           AND json_extract(command.body_json, '$.operationKind') =
               'discover_scoped_folder_page'
           AND json_extract(command.body_json, '$.scopedFolderCorrelation.receiptEpoch') = ?
         ORDER BY command.rowid DESC
         LIMIT 1`
      )
      .get(normalizedRunId, beforeRowId, normalizedEpoch) as
      | { command_body: string; activity_body: string | null; ledger_body: string | null }
      | undefined;
    if (!row) return null;
    const command = validateProviderCommandJournalEntry(
      JSON.parse(row.command_body) as unknown,
      run
    );
    if (
      !isScopedFolderCommand(command) ||
      command.scopedFolderCorrelation.receiptEpoch !== normalizedEpoch
    ) {
      throw new Error('Scoped Folder acknowledged-command query returned the wrong correlation.');
    }
    if (row.activity_body === null || row.ledger_body === null) {
      throw new Error('Scoped Folder acknowledgement candidate lacks an atomic settlement.');
    }
    const activity = validateScopedFolderSettlementActivity(
      JSON.parse(row.activity_body) as unknown,
      normalizedRunId,
      command.commandRequestId
    );
    const ledger = validateScopedFolderSettlementRequestLedgerEntry(
      JSON.parse(row.ledger_body) as unknown,
      normalizedRunId,
      command.commandRequestId,
      command.scopedFolderCorrelation.pageRequestSha256
    );
    if (ledger.outcome === 'success') {
      assertSuccessfulScopedFolderSettlement(
        activity,
        ledger,
        command.scopedFolderCorrelation.purpose === 'advance' ? 'append' : 'replay'
      );
    } else {
      assertFailedScopedFolderSettlement(activity, ledger);
    }
    return command.commandRequestId;
  }

  getScopedFolderTraversalJournal(runId: string): ScopedFolderTraversalJournal | null {
    try {
      return (
        this.readScopedFolderTraversalState(requireScopedFolderTraversalRunId(runId))?.journal ??
        null
      );
    } catch (error) {
      this.clearScopedFolderTraversalReplayCache();
      this.scopedFolderTraversalIntegrityFailure = asError(error);
      throw error;
    }
  }

  getScopedFolderTraversalJournalHead(runId: string): ScopedFolderTraversalJournalHead | null {
    try {
      return (
        this.readScopedFolderTraversalState(requireScopedFolderTraversalRunId(runId))?.head ?? null
      );
    } catch (error) {
      this.clearScopedFolderTraversalReplayCache();
      this.scopedFolderTraversalIntegrityFailure = asError(error);
      throw error;
    }
  }

  getScopedFolderTraversalLiveCursor(runId: string): ScopedFolderTraversalLiveCursor | null {
    const normalizedRunId = requireScopedFolderTraversalRunId(runId);
    const readCursor = this.db.transaction(() => {
      this.requireScopedFolderCommandAuditCache(normalizedRunId);
      const header = this.readScopedFolderTraversalHeader(normalizedRunId);
      if (!header) {
        if (
          this.scopedFolderTraversalReplayCache?.runId === normalizedRunId ||
          this.hasOrphanedScopedFolderTraversalState(normalizedRunId)
        ) {
          throw new Error(
            `Scoped Folder traversal for run ${normalizedRunId} changed outside the owned write set.`
          );
        }
        this.clearScopedFolderTraversalReplayCache();
        return null;
      }
      const mutationGeneration = this.readScopedFolderTraversalMutationGeneration(normalizedRunId);
      const cache = this.requireScopedFolderTraversalReplayCache(
        normalizedRunId,
        header,
        mutationGeneration
      );
      const cursor = durableScopedFolderTraversalCheckpointCursor(cache.checkpoint);
      if (cursor.pageCount !== cache.head.pageCount) {
        this.clearScopedFolderTraversalReplayCache();
        throw new Error('Scoped Folder traversal checkpoint page count drifted from SQLite.');
      }
      return Object.freeze({
        head: cache.head,
        nextRequest: cursor.nextRequest,
      });
    });
    try {
      return readCursor.deferred();
    } catch (error) {
      this.clearScopedFolderTraversalReplayCache();
      this.scopedFolderTraversalIntegrityFailure ??= asError(error);
      throw error;
    }
  }

  saveDirectFolderCapturePlan(value: DirectFolderCapturePlanV1): void {
    let plan = validateDirectFolderCapturePlan(value);
    const run = this.getRun();
    if (!run || run.id !== plan.runId || run.scope.kind !== 'folder') {
      throw new Error('Direct Folder capture plan does not match this migration run.');
    }
    if (
      run.scope.folder.id !== plan.selectedRootId ||
      !run.binding ||
      run.binding.accountHash !== plan.sourceAccountHash
    ) {
      throw new Error('Direct Folder capture plan escaped the immutable root or account binding.');
    }
    const journal = this.getScopedFolderTraversalJournal(run.id);
    if (!journal || directFolderTraversalJournalDigest(journal) !== plan.traversalJournalDigest) {
      throw new Error('Direct Folder capture plan does not match the persisted traversal journal.');
    }
    plan = assertDirectFolderCapturePlanMatchesJournal(plan, journal);
    const bodyJson = JSON.stringify(plan);
    const existing = this.db
      .prepare('SELECT body_json FROM direct_folder_capture_plan WHERE run_id = ?')
      .get(run.id) as { body_json: string } | undefined;
    if (existing) {
      const existingPlan = validateDirectFolderCapturePlan(JSON.parse(existing.body_json));
      if (JSON.stringify(existingPlan) !== bodyJson) {
        throw new Error('Direct Folder capture plan is immutable after persistence.');
      }
      return;
    }
    this.db
      .prepare(
        `INSERT INTO direct_folder_capture_plan
           (run_id, plan_digest, traversal_journal_digest, body_json)
         VALUES (?, ?, ?, ?)`
      )
      .run(run.id, plan.planDigest, plan.traversalJournalDigest, bodyJson);
    this.exportJobWriteIndex = null;
  }

  getDirectFolderCapturePlan(runId: string): DirectFolderCapturePlanV1 | null {
    return this.readDirectFolderCapturePlanForRun(runId, this.getRun());
  }

  private readDirectFolderCapturePlanForRun(
    runId: string,
    run: MigrationRun | null
  ): DirectFolderCapturePlanV1 | null {
    const row = this.db
      .prepare(
        `SELECT plan_digest, traversal_journal_digest, body_json
         FROM direct_folder_capture_plan
         WHERE run_id = ?`
      )
      .get(runId) as
      | { plan_digest: string; traversal_journal_digest: string; body_json: string }
      | undefined;
    if (!row) return null;
    const plan = validateDirectFolderCapturePlan(JSON.parse(row.body_json));
    if (
      plan.runId !== runId ||
      row.plan_digest !== plan.planDigest ||
      row.traversal_journal_digest !== plan.traversalJournalDigest
    ) {
      throw new Error('Direct Folder capture plan SQLite correlation is invalid.');
    }
    if (
      !run ||
      run.id !== plan.runId ||
      run.scope.kind !== 'folder' ||
      run.scope.folder.id !== plan.selectedRootId ||
      !run.binding ||
      run.binding.accountHash !== plan.sourceAccountHash
    ) {
      throw new Error('Direct Folder capture plan no longer matches its immutable run binding.');
    }
    const journal = this.getScopedFolderTraversalJournal(runId);
    if (!journal || directFolderTraversalJournalDigest(journal) !== plan.traversalJournalDigest) {
      throw new Error('Direct Folder capture plan traversal digest is invalid.');
    }
    return assertDirectFolderCapturePlanMatchesJournal(plan, journal);
  }

  saveFolderTreeCapturePlan(value: FolderTreeCapturePlanV1): void {
    let plan = validateFolderTreeCapturePlan(value);
    const run = this.getRun();
    if (
      !run ||
      run.id !== plan.runId ||
      run.scope.kind !== 'folder_tree' ||
      run.scope.roots.length !== 1
    ) {
      throw new Error('Folder Tree capture plan does not match this migration run.');
    }
    if (
      run.scope.roots[0]?.id !== plan.selectedRootId ||
      !run.binding ||
      run.binding.accountHash !== plan.sourceAccountHash
    ) {
      throw new Error('Folder Tree capture plan escaped the immutable root or account binding.');
    }
    const journal = this.getScopedFolderTraversalJournal(run.id);
    if (!journal || folderTreeTraversalJournalDigest(journal) !== plan.traversalJournalDigest) {
      throw new Error('Folder Tree capture plan does not match the persisted traversal journal.');
    }
    plan = assertFolderTreeCapturePlanMatchesJournal(plan, journal);
    const bodyJson = JSON.stringify(plan);
    const existing = this.db
      .prepare('SELECT body_json FROM folder_tree_capture_plan WHERE run_id = ?')
      .get(run.id) as { body_json: string } | undefined;
    if (existing) {
      const persisted = validateFolderTreeCapturePlan(JSON.parse(existing.body_json));
      if (JSON.stringify(persisted) !== bodyJson) {
        throw new Error('Folder Tree capture plan is immutable after persistence.');
      }
      return;
    }
    this.db
      .prepare(
        `INSERT INTO folder_tree_capture_plan
           (run_id, plan_digest, traversal_journal_digest, body_json)
         VALUES (?, ?, ?, ?)`
      )
      .run(run.id, plan.planDigest, plan.traversalJournalDigest, bodyJson);
    this.exportJobWriteIndex = null;
  }

  getFolderTreeCapturePlan(runId: string): FolderTreeCapturePlanV1 | null {
    return this.readFolderTreeCapturePlanForRun(runId, this.getRun());
  }

  private readFolderTreeCapturePlanForRun(
    runId: string,
    run: MigrationRun | null
  ): FolderTreeCapturePlanV1 | null {
    const row = this.db
      .prepare(
        `SELECT plan_digest, traversal_journal_digest, body_json
         FROM folder_tree_capture_plan
         WHERE run_id = ?`
      )
      .get(runId) as
      | { plan_digest: string; traversal_journal_digest: string; body_json: string }
      | undefined;
    if (!row) return null;
    const plan = validateFolderTreeCapturePlan(JSON.parse(row.body_json));
    if (
      plan.runId !== runId ||
      row.plan_digest !== plan.planDigest ||
      row.traversal_journal_digest !== plan.traversalJournalDigest
    ) {
      throw new Error('Folder Tree capture plan SQLite correlation is invalid.');
    }
    if (
      !run ||
      run.id !== plan.runId ||
      run.scope.kind !== 'folder_tree' ||
      run.scope.roots.length !== 1 ||
      run.scope.roots[0]?.id !== plan.selectedRootId ||
      !run.binding ||
      run.binding.accountHash !== plan.sourceAccountHash
    ) {
      throw new Error('Folder Tree capture plan no longer matches its immutable run binding.');
    }
    const journal = this.getScopedFolderTraversalJournal(runId);
    if (!journal || folderTreeTraversalJournalDigest(journal) !== plan.traversalJournalDigest) {
      throw new Error('Folder Tree capture plan traversal digest is invalid.');
    }
    return assertFolderTreeCapturePlanMatchesJournal(plan, journal);
  }

  saveSourceSnapshot(snapshot: SourceSnapshot): void {
    assertValidSourceSnapshotMetadata(snapshot);
    const metadata = snapshotMetadata(snapshot);
    this.db.transaction(() => {
      const run = this.getRun();
      if (!run || run.id !== snapshot.runId) {
        throw new Error(`Source snapshot ${snapshot.id} is not bound to this migration run.`);
      }
      const sourceIdentityHash = migrationRunSourceIdentityHash(run);
      const firstAdoptedSource =
        run.baseline?.kind === 'adopted_workspace'
          ? this.listLinkedItemRecoveryArtifacts(run.id)[0]
          : undefined;
      const adoptedSourceHash = firstAdoptedSource
        ? linkedItemRecoveryArtifactSha256(firstAdoptedSource)
        : null;
      if ((sourceIdentityHash ?? adoptedSourceHash) !== snapshot.accountHash) {
        throw new Error(
          `Source snapshot ${snapshot.id} does not match the run's immutable source identity.`
        );
      }

      const existing = this.db
        .prepare('SELECT body_json FROM source_snapshot WHERE run_id = ?')
        .get(snapshot.runId) as { body_json: string } | undefined;
      const body = JSON.stringify(metadata);
      if (existing && existing.body_json !== body) {
        throw new Error(`Source snapshot metadata for run ${snapshot.runId} is immutable.`);
      }
      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO source_snapshot (id, run_id, account_hash, created_at, body_json)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(snapshot.id, snapshot.runId, snapshot.accountHash, snapshot.createdAt, body);
      }
      for (const part of snapshot.parts) this.appendSnapshotPart(snapshot.runId, part);
    })();
  }

  initializeAdoptedSourceSnapshot(runId: string): void {
    if (this.getSourceSnapshot(runId)) return;
    const run = this.getRun();
    assertLinkedItemRecoveryRun(run, runId);
    if (run.baseline?.kind !== 'adopted_workspace') {
      throw new Error('Only an adopted workspace can start without an initial snapshot.');
    }
    const artifact = this.listLinkedItemRecoveryArtifacts(runId)[0];
    if (!artifact || artifact.schema !== 'dnaforge.benchling.linked-item-recovery-source.v2') {
      throw new Error('An adopted workspace snapshot requires an accepted external ZIP.');
    }
    this.saveSourceSnapshot({
      version: 1,
      id: `snapshot-${runId}`,
      runId,
      accountHash: artifact.externalZipSource.zipSha256,
      createdAt: artifact.externalZipSource.selectedAt,
      archiveManifestId: `external-source-${artifact.externalZipSource.sourceId}`,
      initialSourceObjectIds: [],
      expectedSourceObjectCount: 0,
      expectedAttachmentCount: 0,
      expectedMembershipCount: 0,
      parts: [],
    });
  }

  commitLocalSourceCapture(input: {
    sourceObjects: readonly SourceObject[];
    snapshot: SourceSnapshot;
    run: MigrationRun;
  }): void {
    this.db.transaction(() => {
      this.putSourceObjectsInCurrentTransaction(input.snapshot.runId, input.sourceObjects);
      this.saveSourceSnapshot(input.snapshot);
      this.saveRun(input.run);
    })();
  }

  getSourceSnapshot(runId: string): SourceSnapshot | null {
    const row = this.db
      .prepare('SELECT body_json FROM source_snapshot WHERE run_id = ?')
      .get(runId) as { body_json: string } | undefined;
    if (!row) return null;
    return {
      ...(JSON.parse(row.body_json) as SourceSnapshotMetadata),
      parts: this.listSnapshotParts(runId),
    };
  }

  appendSnapshotPart(runId: string, part: SourceSnapshotPart): void {
    assertValidSnapshotPart(part);
    const existing = this.getSnapshotPart(runId, part.id);
    if (!existing && part.supersedesPartId) {
      const superseded = this.getSnapshotPart(runId, part.supersedesPartId);
      if (!superseded) {
        throw new Error(
          `Snapshot part ${part.id} cannot supersede missing part ${part.supersedesPartId}.`
        );
      }
      if (superseded.kind !== part.kind) {
        throw new Error(
          `Snapshot part ${part.id} cannot supersede a different snapshot part kind.`
        );
      }
      if (
        (part.kind === 'targeted_read' || part.kind === 'supplemental_local_export') &&
        superseded.sourceObjectId !== part.sourceObjectId
      ) {
        throw new Error(
          `Object-scoped snapshot part ${part.id} cannot supersede a different source object.`
        );
      }
      if (Date.parse(part.capturedAt) <= Date.parse(superseded.capturedAt)) {
        throw new Error(
          `Snapshot part ${part.id} must be captured after ${part.supersedesPartId}.`
        );
      }
      const existingSuccessors = this.listSnapshotPartSuccessors(runId, part.supersedesPartId);
      if (existingSuccessors.length > 0) {
        throw new Error(
          `Snapshot part ${part.supersedesPartId} is already superseded by ${existingSuccessors[0].id}.`
        );
      }
    }
    this.appendImmutableJson('snapshot_part', part.id, runId, part);
  }

  listSnapshotParts(runId: string): SourceSnapshotPart[] {
    return this.listJson<SourceSnapshotPart>('snapshot_part', runId);
  }

  getSnapshotPart(runId: string, partId: string): SourceSnapshotPart | null {
    const row = this.db
      .prepare(
        `SELECT id, run_id, body_json
         FROM snapshot_part
         WHERE id = ?`
      )
      .get(partId) as ImmutableJsonSqliteRow | undefined;
    this.recordCapturePersistenceQuery('snapshot_part_by_id', row ? 1 : 0);
    if (!row) return null;
    return this.parseCorrelatedSnapshotPartRow(row, runId);
  }

  listSnapshotPartsForExportJob(runId: string, jobId: string): SourceSnapshotPart[] {
    const rows = this.db
      .prepare(
        `SELECT id, run_id, body_json
         FROM snapshot_part
         WHERE run_id = ?
           AND json_extract(body_json, '$.kind') = 'export_archive'
           AND json_type(body_json, '$.sourceJobId') = 'text'
           AND json_extract(body_json, '$.sourceJobId') = ?
         ORDER BY rowid`
      )
      .all(runId, jobId) as ImmutableJsonSqliteRow[];
    this.recordCapturePersistenceQuery('snapshot_parts_by_export_job', rows.length);
    return rows.map((row) => this.parseCorrelatedSnapshotPartRow(row, runId, jobId));
  }

  private listSnapshotPartSuccessors(
    runId: string,
    supersededPartId: string
  ): SourceSnapshotPart[] {
    const rows = this.db
      .prepare(
        `SELECT id, run_id, body_json
         FROM snapshot_part
         WHERE run_id = ?
           AND json_type(body_json, '$.supersedesPartId') = 'text'
           AND json_extract(body_json, '$.supersedesPartId') = ?
         ORDER BY rowid
         LIMIT 2`
      )
      .all(runId, supersededPartId) as ImmutableJsonSqliteRow[];
    this.recordCapturePersistenceQuery('snapshot_part_successors', rows.length);
    return rows.map((row) => {
      const successor = this.parseCorrelatedSnapshotPartRow(row, runId);
      if (successor.supersedesPartId !== supersededPartId) {
        throw new Error(`Snapshot part ${successor.id} has invalid supersession correlation.`);
      }
      return successor;
    });
  }

  upsertExportJob(job: ExportJob): void {
    const run = this.getRun();
    if (!run || run.id !== job.runId) {
      throw new Error(`Export job ${job.id} is not bound to this migration run.`);
    }
    assertValidExportJob(job);
    const index = this.requireExportJobWriteIndex(run);
    this.assertExportJobTargetRowMatchesIndex(index, job.id);
    this.assertDirectFolderExportAuthority(job, index.context);

    const existing = index.context.jobsById.get(job.id);
    if (existing) assertLegalExportJobUpdate(existing, job);
    this.assertPendingExportJobIndexConstraints(job, index);

    this.writeExportJobRow(job);
    this.updateExportJobWriteIndex(index, job);
  }

  reconcilePlannedExportJobs(runId: string, plannedJobs: readonly ExportJob[]): ExportJob[] {
    const run = this.getRun();
    if (!run || run.id !== runId) {
      throw new Error(`Planned export jobs are not bound to migration run ${runId}.`);
    }
    const candidatesById = new Map<string, ExportJob>();
    const candidateIdBySignature = new Map<string, string>();
    for (const candidate of plannedJobs) {
      assertValidExportJob(candidate);
      if (candidate.runId !== runId || candidate.state !== 'planned') {
        throw new Error(`Export job ${candidate.id} is not a planned job for this migration run.`);
      }
      if (candidatesById.has(candidate.id)) {
        throw new Error(`Provider plan contains duplicate export job ${candidate.id}.`);
      }
      const signatureOwner = candidateIdBySignature.get(candidate.matchSignature);
      if (signatureOwner) {
        throw new Error(
          `Provider plan export jobs ${signatureOwner} and ${candidate.id} share one match signature.`
        );
      }
      candidatesById.set(candidate.id, candidate);
      candidateIdBySignature.set(candidate.matchSignature, candidate.id);
    }

    const persistedJobs = this.listRawExportJobs(runId);
    const persistedById = new Map(persistedJobs.map((job) => [job.id, job] as const));
    const persistedIdBySignature = new Map(
      persistedJobs.map((job) => [job.matchSignature, job.id] as const)
    );
    const missing: ExportJob[] = [];
    for (const candidate of candidatesById.values()) {
      const existing = persistedById.get(candidate.id);
      if (existing) {
        if (!exactExportJobPlanningIdentity(existing, candidate)) {
          throw new Error(
            `Persisted export job ${candidate.id} does not match the current provider plan.`
          );
        }
        continue;
      }
      const signatureOwner = persistedIdBySignature.get(candidate.matchSignature);
      if (signatureOwner) {
        throw new Error(
          `Provider plan export job ${candidate.id} conflicts with persisted signature owner ${signatureOwner}.`
        );
      }
      missing.push(candidate);
    }

    const combinedJobs = [...persistedJobs, ...missing].sort((left, right) =>
      left.id.localeCompare(right.id)
    );
    const validationContext = this.createExportJobValidationContext(run, combinedJobs);
    for (const job of combinedJobs) {
      this.assertDirectFolderExportAuthority(job, validationContext);
    }
    const writeIndex = this.buildExportJobWriteIndex(validationContext);
    this.db.transaction(() => {
      for (const job of missing) this.writeExportJobRow(job);
    })();
    this.exportJobWriteIndex = writeIndex;
    return plannedJobs.map((candidate) => {
      const reconciled = validationContext.jobsById.get(candidate.id);
      if (!reconciled) {
        throw new Error(`Reconciled export job ${candidate.id} disappeared from its plan.`);
      }
      return reconciled;
    });
  }

  getExportJob(jobId: string): ExportJob | null {
    const row = this.db
      .prepare(
        `SELECT id, run_id, match_signature, state, submitted_at, attempts, body_json
         FROM export_job
         WHERE id = ?`
      )
      .get(jobId) as ExportJobSqliteRow | undefined;
    if (!row) return null;
    const job = this.parseCorrelatedExportJobRow(row);
    const run = this.getRun();
    if (!run || run.id !== job.runId) {
      throw new Error(`Persisted export job ${row.id} is not bound to this migration run.`);
    }
    let index = this.requireExportJobWriteIndex(run);
    const cached = index.context.jobsById.get(job.id);
    if (!cached || !isDeepStrictEqual(cached, job)) {
      this.exportJobWriteIndex = null;
      index = this.requireExportJobWriteIndex(run);
    }
    this.assertDirectFolderExportAuthority(job, index.context);
    return job;
  }

  listExportJobs(runId: string): ExportJob[] {
    const rows = this.db
      .prepare(
        `SELECT id, run_id, match_signature, state, submitted_at, attempts, body_json
         FROM export_job
         WHERE run_id = ?
         ORDER BY id`
      )
      .all(runId) as ExportJobSqliteRow[];
    if (rows.length === 0) {
      const run = this.getRun();
      if (run?.id === runId) {
        this.installExportJobWriteIndex(this.createExportJobValidationContext(run, []));
      } else if (this.exportJobWriteIndex?.runId === runId) {
        this.exportJobWriteIndex = null;
      }
      return [];
    }
    const jobs = rows.map((row) => this.parseCorrelatedExportJobRow(row));
    const run = this.getRun();
    if (!run || run.id !== runId) {
      throw new Error(`Persisted export jobs are not bound to migration run ${runId}.`);
    }
    const validationContext = this.createExportJobValidationContext(run, jobs);
    for (const job of jobs) this.assertDirectFolderExportAuthority(job, validationContext);
    this.installExportJobWriteIndex(validationContext);
    return jobs;
  }

  saveGmailReceiptInference(evidence: GmailReceiptInferenceEvidence): void {
    assertValidGmailReceiptInference(evidence);
    const job = this.getExportJob(evidence.jobId);
    if (
      !job ||
      job.runId !== evidence.runId ||
      job.state !== 'receipt_pending' ||
      job.matchSignature !== evidence.plannedMatchSignature ||
      job.contentFamily !== evidence.contentFamily ||
      !isDeepStrictEqual(
        job.sourceRoots.map((root) => root.id),
        evidence.sourceRootIds
      )
    ) {
      throw new Error(
        `Gmail receipt inference ${evidence.id} is not bound to one pending export job.`
      );
    }
    this.appendImmutableJson('gmail_receipt_inference', evidence.id, evidence.runId, evidence);
  }

  getGmailReceiptInference(inferenceId: string): GmailReceiptInferenceEvidence | null {
    const row = this.db
      .prepare('SELECT body_json FROM gmail_receipt_inference WHERE id = ?')
      .get(inferenceId) as { body_json: string } | undefined;
    if (!row) return null;
    const evidence: unknown = JSON.parse(row.body_json);
    assertValidGmailReceiptInference(evidence);
    return evidence;
  }

  listGmailReceiptInferences(runId: string): GmailReceiptInferenceEvidence[] {
    return this.listJson<unknown>('gmail_receipt_inference', runId).map((evidence) => {
      assertValidGmailReceiptInference(evidence);
      return evidence;
    });
  }

  confirmGmailReceiptInference(confirmation: GmailReceiptConfirmationEvidence): ExportJob {
    assertValidGmailReceiptConfirmation(confirmation);
    return this.runExportJobIndexedTransaction(() => {
      const inference = this.getGmailReceiptInference(confirmation.inferenceId);
      const job = this.getExportJob(confirmation.jobId);
      if (
        !inference ||
        inference.runId !== confirmation.runId ||
        inference.jobId !== confirmation.jobId ||
        inference.receiptId !== confirmation.receiptId ||
        inference.plannedMatchSignature !== confirmation.matchSignature ||
        inference.downloadUrlHash !== confirmation.downloadUrlHash ||
        !job ||
        job.runId !== confirmation.runId ||
        job.state !== 'receipt_pending' ||
        job.matchSignature !== confirmation.matchSignature
      ) {
        throw new Error(
          `Gmail receipt confirmation ${confirmation.id} does not match one pending inference.`
        );
      }
      const existingForInference = this.listGmailReceiptConfirmations(confirmation.runId).find(
        (candidate) => candidate.inferenceId === confirmation.inferenceId
      );
      if (existingForInference) {
        if (!isDeepStrictEqual(existingForInference, confirmation)) {
          throw new Error(
            `Gmail receipt inference ${confirmation.inferenceId} already has immutable confirmation.`
          );
        }
        return job;
      }
      if (
        this.listGmailReceiptConfirmations(confirmation.runId).some(
          (candidate) =>
            candidate.jobId === confirmation.jobId || candidate.receiptId === confirmation.receiptId
        )
      ) {
        throw new Error('A Gmail export job or receipt cannot be confirmed more than once.');
      }
      this.appendImmutableJson(
        'gmail_receipt_confirmation',
        confirmation.id,
        confirmation.runId,
        confirmation
      );
      const confirmedJob: ExportJob = {
        ...job,
        state: 'receipt_matched',
        receiptId: confirmation.receiptId,
        receiptSource: 'gmail',
        downloadUrlHash: confirmation.downloadUrlHash,
        receiptConfirmationId: confirmation.id,
      };
      this.upsertExportJob(confirmedJob);
      return confirmedJob;
    });
  }

  listGmailReceiptConfirmations(runId: string): GmailReceiptConfirmationEvidence[] {
    return this.listJson<unknown>('gmail_receipt_confirmation', runId).map((evidence) => {
      assertValidGmailReceiptConfirmation(evidence);
      return evidence;
    });
  }

  getGmailReceiptConfirmationForJob(jobId: string): GmailReceiptConfirmationEvidence | null {
    const job = this.getExportJob(jobId);
    if (!job?.receiptConfirmationId) return null;
    const row = this.db
      .prepare('SELECT body_json FROM gmail_receipt_confirmation WHERE id = ?')
      .get(job.receiptConfirmationId) as { body_json: string } | undefined;
    if (!row) return null;
    const evidence: unknown = JSON.parse(row.body_json);
    assertValidGmailReceiptConfirmation(evidence);
    if (evidence.jobId !== jobId) {
      throw new Error(`Gmail receipt confirmation ${evidence.id} is bound to another export job.`);
    }
    return evidence;
  }

  saveExportCapture(capture: PersistedExportCapture): void {
    assertValidExportCapture(capture);
    const job = this.getExportJob(capture.jobId);
    if (!job || job.runId !== capture.runId) {
      throw new Error(`Export capture ${capture.jobId} is not bound to this migration run.`);
    }
    this.appendImmutableJson('export_capture', capture.jobId, capture.runId, capture);
  }

  getExportCapture(runId: string, jobId: string): PersistedExportCapture | null {
    const row = this.db
      .prepare(
        `SELECT id, run_id, body_json
         FROM export_capture
         WHERE id = ?`
      )
      .get(jobId) as ImmutableJsonSqliteRow | undefined;
    this.recordCapturePersistenceQuery('export_capture_by_job', row ? 1 : 0);
    if (!row) return null;
    const capture = JSON.parse(row.body_json) as PersistedExportCapture;
    assertValidExportCapture(capture);
    if (
      row.id !== jobId ||
      row.id !== capture.jobId ||
      row.run_id !== runId ||
      capture.runId !== runId
    ) {
      throw new Error(`Export capture ${jobId} SQLite correlation is invalid.`);
    }
    return capture;
  }

  readExportCaptureEvidence(runId: string, jobId: string): PersistedExportCaptureEvidence {
    return Object.freeze({
      capture: this.getExportCapture(runId, jobId),
      archiveParts: Object.freeze(this.listSnapshotPartsForExportJob(runId, jobId)),
      sourceObjectVersions: Object.freeze(this.listSourceObjectVersionsForExportJob(runId, jobId)),
    });
  }

  listExportCaptures(runId: string): PersistedExportCapture[] {
    return this.listJson<PersistedExportCapture>('export_capture', runId);
  }

  saveExportInspection(inspection: PersistedExportInspection): void {
    const job = this.getExportJob(inspection.jobId);
    if (!job || job.runId !== inspection.runId) {
      throw new Error(`Export inspection ${inspection.jobId} is not bound to this migration run.`);
    }
    if (
      job.receiptId !== inspection.receiptId ||
      job.downloadUrlHash !== inspection.downloadUrlHash
    ) {
      throw new Error(
        `Export inspection ${inspection.jobId} does not match its protected receipt.`
      );
    }
    assertValidExportInspection(inspection);
    this.appendImmutableJson('export_inspection', inspection.jobId, inspection.runId, inspection);
  }

  getExportInspection(jobId: string): PersistedExportInspection | null {
    const row = this.db
      .prepare('SELECT body_json FROM export_inspection WHERE id = ?')
      .get(jobId) as { body_json: string } | undefined;
    return row ? (JSON.parse(row.body_json) as PersistedExportInspection) : null;
  }

  listExportInspections(runId: string): PersistedExportInspection[] {
    return this.listJson<PersistedExportInspection>('export_inspection', runId);
  }

  saveExportJobReplacement(replacement: PersistedExportJobReplacement): void {
    assertValidExportJobReplacement(replacement);
    const run = this.getRun();
    if (!run || run.id !== replacement.runId) {
      throw new Error(
        `Export replacement ${replacement.failedJobId} is not bound to this migration run.`
      );
    }
    const index = this.requireExportJobWriteIndex(run);
    this.assertExportJobReplacementAuthority(replacement, index.context);
    this.db.transaction(() => {
      this.appendImmutableJson(
        'export_job_replacement',
        replacement.failedJobId,
        replacement.runId,
        replacement
      );
      this.appendExportJobReplacementEdges(replacement);
      const affectedSourceObjectIds = new Set(
        this.listSourceObjectVersionsForExportJob(replacement.runId, replacement.failedJobId).map(
          (version) => version.sourceObjectId
        )
      );
      for (const sourceObjectId of affectedSourceObjectIds) {
        this.rebuildCurrentSourceObject(replacement.runId, sourceObjectId);
      }
    })();
  }

  getExportJobReplacement(failedJobId: string): PersistedExportJobReplacement | null {
    const row = this.db
      .prepare('SELECT id, run_id, body_json FROM export_job_replacement WHERE id = ?')
      .get(failedJobId) as ExportJobReplacementSqliteRow | undefined;
    if (!row) return null;
    const replacement = this.parseCorrelatedExportJobReplacementRow(row);
    const run = this.getRun();
    if (!run || run.id !== replacement.runId) {
      throw new Error(
        `Export replacement ${replacement.failedJobId} is not bound to this migration run.`
      );
    }
    const index = this.requireExportJobWriteIndex(run);
    this.assertExportJobReplacementAuthority(replacement, index.context);
    return replacement;
  }

  getExportJobReplacementParent(
    runId: string,
    replacementJobId: string
  ): PersistedExportJobReplacement | null {
    const row = this.db
      .prepare(
        `SELECT run_id, replacement_job_id, failed_job_id
         FROM export_job_replacement_edge
         WHERE run_id = ? AND replacement_job_id = ?`
      )
      .get(runId, replacementJobId) as ExportJobReplacementEdgeSqliteRow | undefined;
    this.recordCapturePersistenceQuery('export_replacement_parent_by_job', row ? 1 : 0);
    if (!row) return null;
    if (row.run_id !== runId || row.replacement_job_id !== replacementJobId) {
      throw new Error(`Export replacement edge ${replacementJobId} SQLite correlation is invalid.`);
    }
    const replacement = this.getExportJobReplacement(row.failed_job_id);
    if (
      !replacement ||
      replacement.runId !== runId ||
      !replacement.replacementJobIds.includes(replacementJobId)
    ) {
      throw new Error(`Export replacement edge ${replacementJobId} is not authoritative.`);
    }
    return replacement;
  }

  listExportJobReplacements(runId: string): PersistedExportJobReplacement[] {
    const rows = this.db
      .prepare(
        `SELECT id, run_id, body_json
         FROM export_job_replacement
         WHERE run_id = ?
         ORDER BY rowid`
      )
      .all(runId) as ExportJobReplacementSqliteRow[];
    if (rows.length === 0) return [];
    const run = this.getRun();
    if (!run || run.id !== runId) {
      throw new Error(`Export replacements are not bound to migration run ${runId}.`);
    }
    const index = this.requireExportJobWriteIndex(run);
    return rows.map((row) => {
      const replacement = this.parseCorrelatedExportJobReplacementRow(row);
      this.assertExportJobReplacementAuthority(replacement, index.context);
      return replacement;
    });
  }

  saveExportJobFailure(failure: PersistedExportJobFailure): void {
    assertValidExportJobFailure(failure);
    this.runExportJobIndexedTransaction(() => {
      const job = this.getExportJob(failure.jobId);
      if (!job || job.runId !== failure.runId) {
        throw new Error(`Export failure ${failure.jobId} is not bound to this migration run.`);
      }

      const existing = this.getExportJobFailure(failure.jobId);
      if (existing) {
        if (
          existing.jobId !== failure.jobId ||
          existing.runId !== failure.runId ||
          existing.code !== failure.code
        ) {
          throw new Error(`Export failure ${failure.jobId} conflicts with immutable evidence.`);
        }
      } else {
        this.appendImmutableJson('export_job_failure', failure.jobId, failure.runId, failure);
      }

      if (job.state !== 'failed') this.upsertExportJob({ ...job, state: 'failed' });
    });
    this.updateExportJobFailureWriteIndex(failure);
  }

  reconcileExportJobFailures(runId: string): number {
    return this.runExportJobIndexedTransaction(() => {
      let reconciled = 0;
      for (const failure of this.listJson<unknown>('export_job_failure', runId)) {
        assertValidExportJobFailure(failure);
        const job = this.getExportJob(failure.jobId);
        if (!job || job.runId !== runId || failure.runId !== runId) {
          throw new Error(`Export failure ${failure.jobId} is not bound to this migration run.`);
        }
        if (job.state !== 'failed') {
          this.upsertExportJob({ ...job, state: 'failed' });
          reconciled += 1;
        }
        this.updateExportJobFailureWriteIndex(failure);
      }
      return reconciled;
    });
  }

  getExportJobFailure(jobId: string): PersistedExportJobFailure | null {
    const row = this.db
      .prepare('SELECT body_json FROM export_job_failure WHERE id = ?')
      .get(jobId) as { body_json: string } | undefined;
    if (!row) return null;
    const failure: unknown = JSON.parse(row.body_json);
    assertValidExportJobFailure(failure);
    return failure;
  }

  saveSourceObjectVersion(version: PersistedSourceObjectVersion): void {
    assertValidPersistedSourceObjectVersion(version);
    const job = this.getExportJob(version.sourceJobId);
    if (!job || job.runId !== version.runId) {
      throw new Error(`Source object version ${version.id} is not bound to an export job.`);
    }
    this.db.transaction(() => {
      const existing = this.getSourceObjectVersion(version.runId, version.id);
      if (
        existing &&
        JSON.stringify(immutableSourceObjectVersion(existing)) !==
          JSON.stringify(immutableSourceObjectVersion(version))
      ) {
        throw new Error(`Source object version ${version.id} content is immutable.`);
      }

      const sourceObjectVersions = this.listSourceObjectVersionsForSourceObject(
        version.runId,
        version.sourceObjectId
      );
      const versions = existing
        ? sourceObjectVersions
        : [...sourceObjectVersions, { ...version, supersedesVersionId: null }];
      for (const candidate of versions) {
        if (
          candidate.sourceObject.stableId !== version.sourceObject.stableId ||
          candidate.sourceObject.sourceType !== version.sourceObject.sourceType ||
          candidate.sourceObject.sourceUrl !== version.sourceObject.sourceUrl
        ) {
          throw new Error(
            `Source object ${version.sourceObjectId} has conflicting stable identity evidence.`
          );
        }
      }

      const ordered = versions.sort(compareSourceObjectVersions);
      if (!existing) {
        this.db
          .prepare(`INSERT INTO source_object_version (id, run_id, body_json) VALUES (?, ?, ?)`)
          .run(
            version.id,
            version.runId,
            JSON.stringify({ ...version, supersedesVersionId: null })
          );
      }

      const reconciledVersions: PersistedSourceObjectVersion[] = [];
      for (const [index, candidate] of ordered.entries()) {
        const reconciled: PersistedSourceObjectVersion = {
          ...candidate,
          supersedesVersionId: index === 0 ? null : ordered[index - 1].id,
        };
        reconciledVersions.push(reconciled);
        if (reconciled.supersedesVersionId !== candidate.supersedesVersionId) {
          this.db
            .prepare(`UPDATE source_object_version SET body_json = ? WHERE id = ? AND run_id = ?`)
            .run(JSON.stringify(reconciled), reconciled.id, reconciled.runId);
        }
      }

      this.rebuildCurrentSourceObject(version.runId, version.sourceObjectId, reconciledVersions);
    })();
  }

  listSourceObjectVersions(runId: string): PersistedSourceObjectVersion[] {
    return this.listJson<PersistedSourceObjectVersion>('source_object_version', runId).sort(
      compareSourceObjectVersions
    );
  }

  getSourceObjectVersion(runId: string, versionId: string): PersistedSourceObjectVersion | null {
    const row = this.db
      .prepare(
        `SELECT id, run_id, body_json
         FROM source_object_version
         WHERE id = ?`
      )
      .get(versionId) as ImmutableJsonSqliteRow | undefined;
    this.recordCapturePersistenceQuery('source_version_by_id', row ? 1 : 0);
    if (!row) return null;
    return this.parseCorrelatedSourceObjectVersionRow(row, runId);
  }

  listSourceObjectVersionsForExportJob(
    runId: string,
    sourceJobId: string
  ): PersistedSourceObjectVersion[] {
    return this.readSourceObjectVersionsByJsonIdentity(
      runId,
      '$.sourceJobId',
      sourceJobId,
      'source_versions_by_export_job'
    );
  }

  listSourceObjectVersionsForSourceObject(
    runId: string,
    sourceObjectId: string
  ): PersistedSourceObjectVersion[] {
    return this.readSourceObjectVersionsByJsonIdentity(
      runId,
      '$.sourceObjectId',
      sourceObjectId,
      'source_versions_by_source_object'
    );
  }

  private rebuildCurrentSourceObject(
    runId: string,
    sourceObjectId: string,
    persistedVersions?: readonly PersistedSourceObjectVersion[]
  ): void {
    const versions = persistedVersions
      ? [...persistedVersions]
      : this.listSourceObjectVersionsForSourceObject(runId, sourceObjectId);
    const activeJobIds = activeExportLeafJobIds(
      versions.map((version) => version.sourceJobId),
      this.listExportJobReplacementsForFailedJobIds(
        runId,
        versions.map((version) => version.sourceJobId)
      )
    );
    const activeVersions = versions
      .filter((version) => activeJobIds.has(version.sourceJobId))
      .sort(compareSourceObjectVersions);
    const latest = activeVersions.at(-1);
    if (!latest) {
      this.db
        .prepare('DELETE FROM source_object WHERE run_id = ? AND source_object_id = ?')
        .run(runId, sourceObjectId);
      return;
    }
    const canonicalContent = sourceObjectWithoutMemberships(latest.sourceObject);
    if (
      activeVersions.some(
        (version) =>
          !isDeepStrictEqual(sourceObjectWithoutMemberships(version.sourceObject), canonicalContent)
      )
    ) {
      throw new SourceObjectContentConflictError(
        runId,
        sourceObjectId,
        activeVersions.map((version) => version.sourceJobId)
      );
    }
    this.putSourceObject(runId, {
      ...latest.sourceObject,
      memberships: [
        ...new Set(activeVersions.flatMap((version) => version.sourceObject.memberships)),
      ].sort(),
    });
  }

  putSourceObject(runId: string, object: SourceObject): void {
    const existing = this.db
      .prepare('SELECT body_json FROM source_object WHERE run_id = ? AND source_object_id = ?')
      .get(runId, object.id) as { body_json: string } | undefined;
    if (existing && existing.body_json === JSON.stringify(object)) return;
    this.db
      .prepare(
        `INSERT INTO source_object (run_id, source_object_id, body_json)
         VALUES (?, ?, ?)
         ON CONFLICT(run_id, source_object_id) DO UPDATE SET body_json = excluded.body_json`
      )
      .run(runId, object.id, JSON.stringify(object));
  }

  putSourceObjects(runId: string, objects: readonly SourceObject[]): void {
    this.db.transaction(() => {
      this.putSourceObjectsInCurrentTransaction(runId, objects);
    })();
  }

  private putSourceObjectsInCurrentTransaction(
    runId: string,
    objects: readonly SourceObject[]
  ): void {
    const existingRows = this.db
      .prepare('SELECT source_object_id, body_json FROM source_object WHERE run_id = ?')
      .all(runId) as Array<{ source_object_id: string; body_json: string }>;
    const existingById = new Map(
      existingRows.map((row) => [row.source_object_id, row.body_json] as const)
    );
    const upsert = this.db.prepare(
      `INSERT INTO source_object (run_id, source_object_id, body_json)
       VALUES (?, ?, ?)
       ON CONFLICT(run_id, source_object_id) DO UPDATE SET body_json = excluded.body_json`
    );
    for (const object of objects) {
      const body = JSON.stringify(object);
      if (existingById.get(object.id) === body) continue;
      upsert.run(runId, object.id, body);
      existingById.set(object.id, body);
    }
  }

  listSourceObjects(runId: string): SourceObject[] {
    return this.listJson<SourceObject>('source_object', runId);
  }

  getSourceObject(runId: string, sourceObjectId: string): SourceObject | null {
    const row = this.db
      .prepare('SELECT body_json FROM source_object WHERE run_id = ? AND source_object_id = ?')
      .get(runId, sourceObjectId) as { body_json: string } | undefined;
    return row ? (JSON.parse(row.body_json) as SourceObject) : null;
  }

  async listSourceObjectsCooperatively(
    runId: string,
    options: Readonly<{
      batchSize?: number;
      yieldToEventLoop?: () => Promise<void>;
    }> = {}
  ): Promise<SourceObject[]> {
    return this.listSourceObjectsCooperativelyMapped(
      runId,
      (sourceObject) => sourceObject,
      options
    );
  }

  async listSourceObjectValidationViewsCooperatively(
    runId: string,
    options: Readonly<{
      batchSize?: number;
      yieldToEventLoop?: () => Promise<void>;
    }> = {}
  ): Promise<SourceObject[]> {
    return this.listSourceObjectsCooperativelyMapped(runId, sourceObjectValidationView, options);
  }

  async listSourceObjectMaterializationViewsCooperatively(
    runId: string,
    options: Readonly<{
      batchSize?: number;
      yieldToEventLoop?: () => Promise<void>;
      retainContentForSourceObjectIds?: ReadonlySet<string>;
    }> = {}
  ): Promise<SourceObject[]> {
    return this.listSourceObjectsCooperativelyMapped(
      runId,
      (source) =>
        options.retainContentForSourceObjectIds?.has(source.id)
          ? source
          : sourceObjectMaterializationView(source),
      options
    );
  }

  private async listSourceObjectsCooperativelyMapped<T>(
    runId: string,
    map: (sourceObject: SourceObject) => T,
    options: Readonly<{
      batchSize?: number;
      yieldToEventLoop?: () => Promise<void>;
    }>
  ): Promise<T[]> {
    const batchSize = options.batchSize ?? 128;
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
      throw new Error('Source-object read batch size must be a positive safe integer.');
    }
    const yieldToEventLoop =
      options.yieldToEventLoop ??
      (() => new Promise<void>((resolvePromise) => setImmediate(resolvePromise)));
    const selectBatch = this.db.prepare(
      `SELECT rowid AS source_rowid, source_object_id, body_json
       FROM source_object
       WHERE run_id = ? AND source_object_id > ?
       ORDER BY source_object_id
       LIMIT ?`
    );
    const objects: Array<{ sourceRowId: number; value: T }> = [];
    let lastSourceObjectId = '';
    for (;;) {
      const rows = selectBatch.all(runId, lastSourceObjectId, batchSize) as Array<{
        source_rowid: number;
        source_object_id: string;
        body_json: string;
      }>;
      if (rows.length === 0) break;
      for (const row of rows) {
        objects.push({
          sourceRowId: row.source_rowid,
          value: map(JSON.parse(row.body_json) as SourceObject),
        });
        lastSourceObjectId = row.source_object_id;
      }
      if (rows.length < batchSize) break;
      await yieldToEventLoop();
    }
    return objects
      .sort((left, right) => left.sourceRowId - right.sourceRowId)
      .map(({ value }) => value);
  }

  putRecoveredSourceObjectExact(
    runId: string,
    sourceObject: SourceObject
  ): 'inserted' | 'unchanged' {
    const result = this.putRecoveredSourceObjectForSupplementalImport(runId, sourceObject, {
      kind: 'exact',
    });
    if (result === 'completed_needs_sequence' || result === 'replaced_existing') {
      throw new Error('Exact recovered-source persistence changed an existing source object.');
    }
    return result;
  }

  putRecoveredSourceObjectForSupplementalImport(
    runId: string,
    sourceObject: SourceObject,
    policy: RecoveredSourceObjectVersionPolicy
  ): 'inserted' | 'unchanged' | 'completed_needs_sequence' | 'replaced_existing' {
    assertValidRecoveredSourceObject(sourceObject);
    const run = this.getRun();
    assertLinkedItemRecoveryRun(run, runId);
    const candidateHash = scientificSourceObjectSha256(sourceObject);
    const existing = this.db
      .prepare('SELECT body_json FROM source_object WHERE run_id = ? AND source_object_id = ?')
      .get(runId, sourceObject.id) as { body_json: string } | undefined;
    if (existing) {
      const existingObject = JSON.parse(existing.body_json) as SourceObject;
      assertValidRecoveredSourceObject(existingObject);
      const existingHash = scientificSourceObjectSha256(existingObject);
      if (existingHash === candidateHash) return 'unchanged';
      if (
        policy.kind === 'complete_needs_sequence' &&
        existingHash === policy.expectedExistingScientificContentSha256 &&
        isNeedsSequenceCompletion(existingObject, sourceObject)
      ) {
        this.db
          .prepare(
            `UPDATE source_object
             SET body_json = ?
             WHERE run_id = ? AND source_object_id = ?`
          )
          .run(JSON.stringify(sourceObject), runId, sourceObject.id);
        return 'completed_needs_sequence';
      }
      if (
        policy.kind === 'replace_existing' &&
        existingHash === policy.expectedExistingScientificContentSha256
      ) {
        this.db
          .prepare(
            `UPDATE source_object
             SET body_json = ?
             WHERE run_id = ? AND source_object_id = ?`
          )
          .run(JSON.stringify(sourceObject), runId, sourceObject.id);
        return 'replaced_existing';
      }
      throw new RecoveredSourceObjectContentConflictError(
        runId,
        sourceObject.id,
        existingHash,
        candidateHash
      );
    }
    this.db
      .prepare(
        `INSERT INTO source_object (run_id, source_object_id, body_json)
         VALUES (?, ?, ?)`
      )
      .run(runId, sourceObject.id, JSON.stringify(sourceObject));
    return 'inserted';
  }

  getPersistedScientificContentSha256(
    runId: string,
    sourceObjectId: string
  ): `sha256:${string}` | null {
    const existing = this.db
      .prepare('SELECT body_json FROM source_object WHERE run_id = ? AND source_object_id = ?')
      .get(runId, sourceObjectId) as { body_json: string } | undefined;
    if (!existing) return null;
    const sourceObject = JSON.parse(existing.body_json) as SourceObject;
    return scientificSourceObjectSha256(sourceObject);
  }

  putImportDecision(runId: string, actionId: string, decision: ImportDecision): void {
    assertValidImportDecision(decision);
    const run = this.getRun();
    if (!run || run.id !== runId) {
      throw new Error(`Import decision action ${actionId} has no matching migration run.`);
    }
    if (!stableNonemptyString(actionId)) {
      throw new Error('Import decision action ID is invalid.');
    }
    const decisionKey = importDecisionKey(decision);
    const existing = this.db
      .prepare(
        `SELECT body_json
           FROM import_decision
          WHERE run_id = ? AND action_id = ? AND decision_key = ?`
      )
      .get(runId, actionId, decisionKey) as { body_json: string } | undefined;
    const bodyJson = JSON.stringify(
      decision.kind === 'registry_table_mapping'
        ? parseRegistryTableMappingDecision(decision)
        : decision
    );
    if (existing) {
      if (existing.body_json !== bodyJson) {
        throw new Error(`Import decision ${decisionKey} changed its persisted answer.`);
      }
      return;
    }
    this.db
      .prepare(
        `INSERT INTO import_decision
           (run_id, action_id, decision_key, kind, body_json)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(runId, actionId, decisionKey, decision.kind, bodyJson);
  }

  listImportDecisions(runId: string, actionId: string): ImportDecision[] {
    const rows = this.db
      .prepare(
        `SELECT body_json
           FROM import_decision
          WHERE run_id = ? AND action_id = ?
          ORDER BY CASE kind
                     WHEN 'provider_version_conflict' THEN 0
                     WHEN 'unbound_exact_match' THEN 1
                     WHEN 'structural_path_conflict' THEN 2
                     ELSE 3
                   END,
                   decision_key`
      )
      .all(runId, actionId) as Array<{ body_json: string }>;
    return rows.map((row) => parseImportDecision(row.body_json));
  }

  putLinkedItemRecoveryAttempt(candidate: LinkedItemRecoveryAttempt): void {
    if (!this.db.inTransaction) {
      this.db.transaction((value: LinkedItemRecoveryAttempt) => {
        this.putLinkedItemRecoveryAttempt(value);
      })(candidate);
      return;
    }
    const attempt = withLinkedItemRecoveryAttemptDefaults(candidate);
    assertValidLinkedItemRecoveryAttempt(attempt);
    const run = this.getRun();
    assertLinkedItemRecoveryRun(run, attempt.runId);
    const existing = this.getLinkedItemRecoveryAttempt(attempt.runId, attempt.id);
    if (existing) assertLinkedItemRecoveryAttemptUpdate(existing, attempt);
    else if (attempt.state !== 'copying') {
      throw new Error(`Linked-item recovery attempt ${attempt.id} must start while copying.`);
    }
    for (const artifactId of attempt.artifactIds) {
      const artifact = this.getLinkedItemRecoveryArtifact(attempt.runId, artifactId);
      if (!artifact) {
        throw new Error(
          `Linked-item recovery attempt ${attempt.id} references a missing artifact ${artifactId}.`
        );
      }
    }
    this.db
      .prepare(
        `INSERT INTO linked_item_recovery_attempt
           (id, run_id, state, updated_at, body_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           state = excluded.state,
           updated_at = excluded.updated_at,
           body_json = excluded.body_json`
      )
      .run(attempt.id, attempt.runId, attempt.state, attempt.updatedAt, JSON.stringify(attempt));
    const telemetryAttempt = this.ensureMigrationTelemetryAttempt({
      runId: attempt.runId,
      sourceAttemptReference: attempt.id,
      operation: attempt.mode,
      startedAt: attempt.createdAt,
      accepted: existing === null,
    });
    const telemetryOutcome = terminalOutcomeForLinkedAttempt(attempt);
    if (telemetryOutcome) {
      const runAfterAttempt = this.getRun();
      if (!runAfterAttempt || runAfterAttempt.id !== attempt.runId) {
        throw new Error('Linked-item telemetry attempt lost its migration run.');
      }
      if (this.hasMigrationTelemetryTerminalReceipt(telemetryAttempt.attemptId)) return;
      this.putMigrationTelemetryTerminalReceipt(
        projectBenchlingMigrationTerminal({
          identity: telemetryAttempt,
          run: runAfterAttempt,
          outcome: telemetryOutcome,
          terminalStage: terminalStageForLinkedAttempt(
            attempt.state === 'failed' ? attempt.resumeState : attempt.state
          ),
          terminalAt: attempt.completedAt ?? attempt.updatedAt,
          report: this.getValidationReport(attempt.runId),
          linkedAttempt: attempt,
        })
      );
    }
  }

  putLinkedItemRecoveryAttemptWithImportDecisions(
    attempt: LinkedItemRecoveryAttempt,
    decisions: readonly ImportDecision[]
  ): void {
    this.db.transaction(() => {
      this.putLinkedItemRecoveryAttempt(attempt);
      for (const decision of decisions) this.putImportDecision(attempt.runId, attempt.id, decision);
    })();
  }

  commitLinkedItemRecoveryCompletion(input: {
    attempt: LinkedItemRecoveryAttempt;
    report: ValidationReport;
    run: MigrationRun;
  }): void {
    const { attempt, report, run } = input;
    const progress = run.linkedItemRecovery;
    if (
      attempt.state !== 'completed' ||
      !report.passed ||
      report.runId !== attempt.runId ||
      run.id !== attempt.runId ||
      (run.state !== 'ready_to_unlock' && run.state !== 'unlocked') ||
      !progress ||
      progress.attemptId !== attempt.id ||
      progress.state !== 'completed' ||
      progress.selectedFileCount !== attempt.selectedFileCount ||
      progress.processedFileCount !== attempt.processedFileCount ||
      progress.recoveredUniqueObjectCount !== attempt.recoveredUniqueObjectCount ||
      progress.repairedRelationshipCount !== attempt.repairedRelationshipCount ||
      progress.retainedExistingObjectCount !== attempt.retainedExistingObjectCount ||
      progress.corroboratedExistingObjectCount !== attempt.corroboratedExistingObjectCount ||
      progress.updatedAt !== attempt.updatedAt ||
      run.updatedAt !== attempt.updatedAt ||
      report.generatedAt !== attempt.completedAt
    ) {
      throw new Error('Linked-item recovery completion is inconsistent.');
    }
    this.db.transaction(() => {
      this.writeValidationReport(report);
      this.putLinkedItemRecoveryAttempt(attempt);
      this.saveRun(run);
    })();
  }

  getLinkedItemRecoveryAttempt(runId: string, attemptId: string): LinkedItemRecoveryAttempt | null {
    const row = this.db
      .prepare(
        `SELECT id, run_id, state, updated_at, body_json
         FROM linked_item_recovery_attempt
         WHERE run_id = ? AND id = ?`
      )
      .get(runId, attemptId) as LinkedItemRecoveryAttemptSqliteRow | undefined;
    return row ? parseLinkedItemRecoveryAttemptRow(row) : null;
  }

  listLinkedItemRecoveryAttempts(runId: string): LinkedItemRecoveryAttempt[] {
    const rows = this.db
      .prepare(
        `SELECT id, run_id, state, updated_at, body_json
         FROM linked_item_recovery_attempt
         WHERE run_id = ?
         ORDER BY rowid`
      )
      .all(runId) as LinkedItemRecoveryAttemptSqliteRow[];
    return rows.map(parseLinkedItemRecoveryAttemptRow);
  }

  getActiveLinkedItemRecoveryAttempt(runId: string): LinkedItemRecoveryAttempt | null {
    const rows = this.db
      .prepare(
        `SELECT id, run_id, state, updated_at, body_json
         FROM linked_item_recovery_attempt
         WHERE run_id = ?
           AND state IN (
             'copying',
             'parsing',
             'awaiting_conflict_resolution',
             'reconciling',
             'validating'
           )
         ORDER BY rowid`
      )
      .all(runId) as LinkedItemRecoveryAttemptSqliteRow[];
    if (rows.length > 1) {
      throw new Error(`Migration ${runId} has more than one active linked-item recovery attempt.`);
    }
    return rows[0] ? parseLinkedItemRecoveryAttemptRow(rows[0]) : null;
  }

  appendLinkedItemRecoveryArtifact(artifact: LinkedItemRecoveryArtifact): void {
    assertValidLinkedItemRecoveryArtifact(artifact);
    const run = this.getRun();
    assertLinkedItemRecoveryRun(run, artifact.runId);
    const attempt = this.getLinkedItemRecoveryAttempt(artifact.runId, artifact.attemptId);
    if (!attempt) {
      throw new Error(
        `Linked-item recovery artifact ${artifact.id} has no persisted attempt ${artifact.attemptId}.`
      );
    }
    if (attempt.state === 'completed') {
      throw new Error(`Completed linked-item recovery attempt ${attempt.id} is immutable.`);
    }
    const body = JSON.stringify(artifact);
    const existing = this.db
      .prepare('SELECT body_json FROM linked_item_recovery_artifact WHERE id = ?')
      .get(artifact.id) as { body_json: string } | undefined;
    if (existing) {
      if (existing.body_json === body) return;
      throw new Error(`Linked-item recovery artifact ${artifact.id} is immutable.`);
    }
    this.db
      .prepare(
        `INSERT INTO linked_item_recovery_artifact
           (id, run_id, attempt_id, sha256, body_json)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        artifact.id,
        artifact.runId,
        artifact.attemptId,
        linkedItemRecoveryArtifactSha256(artifact),
        body
      );
  }

  getLinkedItemRecoveryArtifact(
    runId: string,
    artifactId: string
  ): LinkedItemRecoveryArtifact | null {
    const row = this.db
      .prepare(
        `SELECT id, run_id, attempt_id, sha256, body_json
         FROM linked_item_recovery_artifact
         WHERE run_id = ? AND id = ?`
      )
      .get(runId, artifactId) as LinkedItemRecoveryArtifactSqliteRow | undefined;
    return row ? parseLinkedItemRecoveryArtifactRow(row) : null;
  }

  getLinkedItemRecoveryArtifactBySha256(
    runId: string,
    sha256: `sha256:${string}`
  ): LinkedItemRecoveryArtifact | null {
    if (!SHA256_REF.test(sha256)) {
      throw new Error('Linked-item recovery artifact SHA-256 is invalid.');
    }
    const row = this.db
      .prepare(
        `SELECT id, run_id, attempt_id, sha256, body_json
         FROM linked_item_recovery_artifact
         WHERE run_id = ? AND sha256 = ?`
      )
      .get(runId, sha256) as LinkedItemRecoveryArtifactSqliteRow | undefined;
    return row ? parseLinkedItemRecoveryArtifactRow(row) : null;
  }

  listLinkedItemRecoveryArtifacts(runId: string, attemptId?: string): LinkedItemRecoveryArtifact[] {
    if (attemptId !== undefined) {
      const attempt = this.getLinkedItemRecoveryAttempt(runId, attemptId);
      if (!attempt) return [];
      return attempt.artifactIds.map((artifactId) => {
        const artifact = this.getLinkedItemRecoveryArtifact(runId, artifactId);
        if (!artifact) {
          throw new Error(`Linked-item recovery attempt ${attemptId} lost artifact ${artifactId}.`);
        }
        return artifact;
      });
    }
    const rows = this.db
      .prepare(
        `SELECT id, run_id, attempt_id, sha256, body_json
         FROM linked_item_recovery_artifact
         WHERE run_id = ?
         ORDER BY rowid`
      )
      .all(runId) as LinkedItemRecoveryArtifactSqliteRow[];
    return rows.map(parseLinkedItemRecoveryArtifactRow);
  }

  commitLinkedItemRecoveryCapture(input: {
    capture: LinkedItemRecoveryCapture;
    snapshotPart: SourceSnapshotPart;
    sourceObject: SourceObject;
    sourceVersionPolicy?: RecoveredSourceObjectVersionPolicy;
  }): { sourceObjectInserted: boolean } {
    const { capture, snapshotPart, sourceObject } = input;
    assertValidLinkedItemRecoveryCapture(capture);
    assertValidRecoveredSourceObject(sourceObject);
    assertValidSnapshotPart(snapshotPart);
    const run = this.getRun();
    assertLinkedItemRecoveryRun(run, capture.runId);
    const attempt = this.getLinkedItemRecoveryAttempt(capture.runId, capture.attemptId);
    const artifact = this.getLinkedItemRecoveryArtifact(capture.runId, capture.artifactId);
    if (!attempt || !artifact) {
      throw new Error(`Linked-item recovery capture ${capture.id} has invalid attempt evidence.`);
    }
    if (!attempt.artifactIds.includes(artifact.id)) {
      throw new Error(
        `Linked-item recovery capture ${capture.id} uses an artifact not accepted by its attempt.`
      );
    }
    const snapshot = this.getSourceSnapshot(capture.runId);
    if (!snapshot) {
      throw new Error(`Linked-item recovery capture ${capture.id} has no source snapshot.`);
    }
    const artifactHash = linkedItemRecoveryArtifactSha256(artifact).slice('sha256:'.length);
    if (
      snapshotPart.id !== capture.snapshotPartId ||
      snapshotPart.kind !== 'supplemental_local_export' ||
      snapshotPart.sha256 !== artifactHash ||
      snapshotPart.sizeBytes !== linkedItemRecoveryArtifactSizeBytes(artifact) ||
      snapshotPart.sourceJobId !== null ||
      snapshotPart.sourceObjectId !== sourceObject.id ||
      snapshotPart.supersedesPartId !== null ||
      snapshotPart.capturedAt !== capture.capturedAt ||
      capture.sourceObjectId !== sourceObject.id ||
      (capture.sourceFolderMemberships !== undefined &&
        !isDeepStrictEqual(
          capture.sourceFolderMemberships,
          readNativeSourceFolderMemberships(sourceObject, capture.runId)
        )) ||
      capture.sourceStableId !== sourceObject.stableId ||
      capture.sourceScientificContentSha256 !== scientificSourceObjectSha256(sourceObject)
    ) {
      throw new Error(`Linked-item recovery capture ${capture.id} correlation is invalid.`);
    }
    return this.db.transaction(() => {
      const result = this.putRecoveredSourceObjectForSupplementalImport(
        capture.runId,
        sourceObject,
        input.sourceVersionPolicy ?? { kind: 'exact' }
      );
      this.appendSnapshotPart(capture.runId, snapshotPart);
      const body = JSON.stringify(capture);
      const existing = this.db
        .prepare('SELECT body_json FROM linked_item_recovery_capture WHERE id = ?')
        .get(capture.id) as { body_json: string } | undefined;
      if (existing && existing.body_json !== body) {
        throw new Error(`Linked-item recovery capture ${capture.id} is immutable.`);
      }
      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO linked_item_recovery_capture
               (id, run_id, attempt_id, artifact_id, source_object_id, snapshot_part_id, body_json)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            capture.id,
            capture.runId,
            capture.attemptId,
            capture.artifactId,
            capture.sourceObjectId,
            capture.snapshotPartId,
            body
          );
      }
      return { sourceObjectInserted: result === 'inserted' };
    })();
  }

  getLinkedItemRecoveryCapture(runId: string, captureId: string): LinkedItemRecoveryCapture | null {
    const row = this.db
      .prepare(
        `SELECT id, run_id, attempt_id, artifact_id, source_object_id, snapshot_part_id, body_json
         FROM linked_item_recovery_capture
         WHERE run_id = ? AND id = ?`
      )
      .get(runId, captureId) as LinkedItemRecoveryCaptureSqliteRow | undefined;
    return row ? parseLinkedItemRecoveryCaptureRow(row) : null;
  }

  listLinkedItemRecoveryCaptures(runId: string, attemptId?: string): LinkedItemRecoveryCapture[] {
    const rows = (
      attemptId === undefined
        ? this.db
            .prepare(
              `SELECT id, run_id, attempt_id, artifact_id, source_object_id, snapshot_part_id, body_json
             FROM linked_item_recovery_capture
             WHERE run_id = ?
             ORDER BY rowid`
            )
            .all(runId)
        : this.db
            .prepare(
              `SELECT id, run_id, attempt_id, artifact_id, source_object_id, snapshot_part_id, body_json
             FROM linked_item_recovery_capture
             WHERE run_id = ? AND attempt_id = ?
             ORDER BY rowid`
            )
            .all(runId, attemptId)
    ) as LinkedItemRecoveryCaptureSqliteRow[];
    return rows.map(parseLinkedItemRecoveryCaptureRow);
  }

  appendWorkspaceAppendHierarchyCapture(
    capture: WorkspaceAppendHierarchyCapture
  ): WorkspaceAppendHierarchyCapture {
    assertValidWorkspaceAppendHierarchyCapture(capture);
    const run = this.getRun();
    assertLinkedItemRecoveryRun(run, capture.runId);
    const attempt = this.getLinkedItemRecoveryAttempt(capture.runId, capture.attemptId);
    if (!attempt) {
      throw new Error(`Supplemental import hierarchy ${capture.id} has invalid attempt evidence.`);
    }
    const artifact = this.getLinkedItemRecoveryArtifact(capture.runId, capture.artifactId);
    if (!artifact) {
      throw new Error(`Workspace append hierarchy ${capture.id} has invalid artifact evidence.`);
    }
    if (!attempt.artifactIds.includes(artifact.id)) {
      throw new Error(
        `Workspace append hierarchy ${capture.id} uses an artifact not accepted by its attempt.`
      );
    }
    if (capture.artifactSha256 !== linkedItemRecoveryArtifactSha256(artifact)) {
      throw new Error(`Workspace append hierarchy ${capture.id} artifact SHA-256 is invalid.`);
    }
    const destinationRootSourceId =
      run.scope.kind === 'folder'
        ? run.scope.folder.id
        : run.scope.kind === 'folder_tree' && run.scope.roots.length === 1
          ? run.scope.roots[0].id
          : null;
    if (capture.destinationRootSourceId !== destinationRootSourceId) {
      throw new Error(`Workspace append hierarchy ${capture.id} destination root is invalid.`);
    }
    const body = JSON.stringify(capture);
    const existing = this.db
      .prepare(
        `SELECT id, run_id, attempt_id, artifact_id, artifact_sha256, body_json
         FROM workspace_append_hierarchy_capture
         WHERE run_id = ? AND artifact_id = ?`
      )
      .get(capture.runId, capture.artifactId) as
      | WorkspaceAppendHierarchyCaptureSqliteRow
      | undefined;
    if (existing && existing.body_json !== body) {
      parseWorkspaceAppendHierarchyCaptureRow(existing);
      throw new Error(`Workspace append hierarchy ${capture.id} is immutable.`);
    }
    if (!existing && (attempt.state === 'completed' || attempt.state === 'failed')) {
      throw new Error(
        `Terminal workspace append attempt ${attempt.id} cannot gain hierarchy evidence.`
      );
    }
    return this.db.transaction(() => {
      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO workspace_append_hierarchy_capture
               (id, run_id, attempt_id, artifact_id, artifact_sha256, body_json)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(
            capture.id,
            capture.runId,
            capture.attemptId,
            capture.artifactId,
            capture.artifactSha256,
            body
          );
      }

      const incomingMembershipsByObject = new Map<string, string[]>();
      for (const membership of capture.memberships) {
        const memberships = incomingMembershipsByObject.get(membership.sourceObjectId) ?? [];
        memberships.push(membership.folderSourceId);
        incomingMembershipsByObject.set(membership.sourceObjectId, memberships);
      }
      const persistedRows = this.db
        .prepare(
          `SELECT source_object_id, body_json
           FROM source_object
           WHERE run_id = ?
           ORDER BY source_object_id`
        )
        .all(capture.runId) as Array<{ source_object_id: string; body_json: string }>;
      const update = this.db.prepare(
        `UPDATE source_object SET body_json = ?
         WHERE run_id = ? AND source_object_id = ?`
      );
      for (const row of persistedRows) {
        const incomingMemberships = incomingMembershipsByObject.get(row.source_object_id);
        if (!incomingMemberships) continue;
        const sourceObject = JSON.parse(row.body_json) as SourceObject;
        if (
          sourceObject.id !== row.source_object_id ||
          sourceObject.stableId !== row.source_object_id
        ) {
          throw new Error(
            `Workspace append source object ${row.source_object_id} SQLite correlation is invalid.`
          );
        }
        const memberships = [
          ...new Set([...sourceObject.memberships, ...incomingMemberships]),
        ].sort();
        if (isDeepStrictEqual(memberships, sourceObject.memberships)) continue;
        update.run(
          JSON.stringify({ ...sourceObject, memberships }),
          capture.runId,
          sourceObject.id
        );
      }
      return existing ? parseWorkspaceAppendHierarchyCaptureRow(existing) : capture;
    })();
  }

  getWorkspaceAppendHierarchyCapture(
    runId: string,
    artifactId: string
  ): WorkspaceAppendHierarchyCapture | null {
    const row = this.db
      .prepare(
        `SELECT id, run_id, attempt_id, artifact_id, artifact_sha256, body_json
         FROM workspace_append_hierarchy_capture
         WHERE run_id = ? AND artifact_id = ?`
      )
      .get(runId, artifactId) as WorkspaceAppendHierarchyCaptureSqliteRow | undefined;
    return row ? parseWorkspaceAppendHierarchyCaptureRow(row) : null;
  }

  listWorkspaceAppendHierarchyCaptures(runId: string): WorkspaceAppendHierarchyCapture[] {
    const rows = this.db
      .prepare(
        `SELECT id, run_id, attempt_id, artifact_id, artifact_sha256, body_json
         FROM workspace_append_hierarchy_capture
         WHERE run_id = ?
         ORDER BY artifact_id`
      )
      .all(runId) as WorkspaceAppendHierarchyCaptureSqliteRow[];
    return rows.map(parseWorkspaceAppendHierarchyCaptureRow);
  }

  putRelationshipResolution(runId: string, resolution: RelationshipResolution): void {
    assertProviderTaskPrivacySafe(resolution, 'relationship resolution');
    this.db
      .prepare(
        `INSERT INTO relationship_resolution (run_id, relationship_id, body_json)
         VALUES (?, ?, ?)
         ON CONFLICT(run_id, relationship_id) DO UPDATE SET body_json = excluded.body_json`
      )
      .run(runId, resolution.relationshipId, JSON.stringify(resolution));
  }

  putRelationshipResolutions(runId: string, resolutions: readonly RelationshipResolution[]): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM relationship_resolution WHERE run_id = ?').run(runId);
      for (const resolution of resolutions) this.putRelationshipResolution(runId, resolution);
    })();
  }

  commitLocalOfflineResolution(input: {
    runId: string;
    resolutions: readonly RelationshipResolution[];
    runs: readonly MigrationRun[];
  }): void {
    this.db.transaction(() => {
      this.putRelationshipResolutions(input.runId, input.resolutions);
      for (const run of input.runs) this.saveRun(run);
    })();
  }

  listRelationshipResolutions(runId: string): RelationshipResolution[] {
    return this.listJson<RelationshipResolution>('relationship_resolution', runId);
  }

  appendProjectionReceipt(receipt: ProjectionReceipt, sourceSnapshot?: SourceObject): void {
    this.db.transaction(() =>
      this.appendProjectionReceiptInsideTransaction(receipt, sourceSnapshot)
    )();
  }

  private appendProjectionReceiptInsideTransaction(
    receipt: ProjectionReceipt,
    sourceSnapshot?: SourceObject
  ): void {
    assertProviderTaskPrivacySafe(receipt, 'projection receipt');
    const revisionWithSameId = this.db
      .prepare('SELECT id FROM projection_receipt_revision WHERE id = ?')
      .get(receipt.id) as { id: string } | undefined;
    if (revisionWithSameId) {
      throw new Error(`Projection receipt ID ${receipt.id} already belongs to a revision.`);
    }
    const existing = this.db
      .prepare(
        `SELECT body_json FROM projection_receipt
         WHERE run_id = ? AND source_object_id = ?`
      )
      .get(receipt.runId, receipt.sourceObjectId) as { body_json: string } | undefined;
    const body = JSON.stringify(receipt);
    if (existing) {
      if (existing.body_json === body) return;
      throw new Error(
        `Source object ${receipt.sourceObjectId} already has a different projection receipt.`
      );
    }
    this.db
      .prepare(
        `INSERT INTO projection_receipt
           (id, run_id, source_object_id, destination_object_id, body_json)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(receipt.id, receipt.runId, receipt.sourceObjectId, receipt.destinationObjectId, body);
    this.pinProjectionReceiptSource(receipt, sourceSnapshot);
  }

  private pinProjectionReceiptSource(
    receipt: ProjectionReceipt,
    sourceSnapshot?: SourceObject
  ): void {
    const source = sourceSnapshot
      ? { body_json: JSON.stringify(sourceSnapshot) }
      : (this.db
          .prepare('SELECT body_json FROM source_object WHERE run_id=? AND source_object_id=?')
          .get(receipt.runId, receipt.sourceObjectId) as { body_json: string } | undefined);
    if (!source) return;
    const parsed: unknown = JSON.parse(source.body_json);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('id' in parsed) ||
      parsed.id !== receipt.sourceObjectId ||
      projectionSourceHash(parsed) !== receipt.sourceHash.replace(/^sha256:/u, '')
    )
      throw new Error('Projection receipt does not match its source snapshot.');
    this.db
      .prepare('INSERT OR IGNORE INTO projection_source_blob(sha256,body_json) VALUES(?,?)')
      .run(receipt.sourceHash, source.body_json);
    this.db
      .prepare(
        'INSERT INTO projection_receipt_source(receipt_id,run_id,source_object_id,sha256) VALUES(?,?,?,?)'
      )
      .run(receipt.id, receipt.runId, receipt.sourceObjectId, receipt.sourceHash);
    this.getProjectionReceiptSource(receipt.runId, receipt.id);
  }

  pinAvailableProjectionReceiptSources(runId: string): void {
    this.db.transaction(() => {
      const missing = this.db
        .prepare(
          `SELECT receipt.id FROM (
        SELECT id,run_id FROM projection_receipt
        UNION ALL SELECT id,run_id FROM projection_receipt_revision
      ) AS receipt LEFT JOIN projection_receipt_source AS source ON source.receipt_id=receipt.id AND source.run_id=receipt.run_id
      WHERE receipt.run_id=? AND source.receipt_id IS NULL`
        )
        .all(runId) as { id: string }[];
      if (!missing.length) return;
      const missingIds = new Set(missing.map((receipt) => receipt.id));
      const available = new Map(
        this.listSourceObjects(runId).map((source) => [
          source.id,
          { source, hash: projectionSourceHash(source) },
        ])
      );
      for (const { receipt } of this.listProjectionReceiptHistory(runId)) {
        if (!missingIds.has(receipt.id)) continue;
        const candidate = available.get(receipt.sourceObjectId);
        if (candidate?.hash === receipt.sourceHash.replace(/^sha256:/u, ''))
          this.pinProjectionReceiptSource(receipt, candidate.source);
      }
    })();
  }

  getProjectionReceiptSource(runId: string, receiptId: string): SourceObject | null {
    const row = this.db
      .prepare(
        `SELECT source.source_object_id,source.sha256,blob.body_json,
         receipt.body_json AS receipt_json,receipt.source_object_id AS receipt_source_object_id
       FROM projection_receipt_source AS source
       JOIN projection_source_blob AS blob ON blob.sha256=source.sha256
       LEFT JOIN (
         SELECT id,run_id,source_object_id,body_json FROM projection_receipt
         UNION ALL
         SELECT id,run_id,source_object_id,body_json FROM projection_receipt_revision
       ) AS receipt ON receipt.id=source.receipt_id AND receipt.run_id=source.run_id
       WHERE source.run_id=? AND source.receipt_id=?`
      )
      .get(runId, receiptId) as
      | {
          source_object_id: string;
          sha256: string;
          body_json: string;
          receipt_json: string | null;
          receipt_source_object_id: string | null;
        }
      | undefined;
    if (!row) return null;
    const receipt = row.receipt_json ? JSON.parse(row.receipt_json) : null;
    if (receipt?.sourceHash !== row.sha256 || row.receipt_source_object_id !== row.source_object_id)
      throw new Error('Projection source snapshot integrity mismatch.');
    const source: unknown = JSON.parse(row.body_json);
    if (
      !source ||
      typeof source !== 'object' ||
      !('id' in source) ||
      source.id !== row.source_object_id ||
      projectionSourceHash(source) !== row.sha256.replace(/^sha256:/u, '')
    )
      throw new Error('Projection source snapshot integrity mismatch.');
    return source as SourceObject;
  }

  appendProjectionReceipts(receipts: readonly ProjectionReceipt[]): void {
    this.db.transaction(() => {
      for (const receipt of receipts) this.appendProjectionReceipt(receipt);
    })();
  }

  commitLocalProjection(input: {
    receipts: readonly ProjectionReceipt[];
    runs: readonly MigrationRun[];
  }): void {
    this.db.transaction(() => {
      for (const receipt of input.receipts) this.appendProjectionReceipt(receipt);
      for (const run of input.runs) this.saveRun(run);
    })();
  }

  listProjectionReceipts(runId: string): ProjectionReceipt[] {
    const history = this.listProjectionReceiptHistory(runId);
    const superseded = new Set(
      history.flatMap((entry) =>
        entry.supersedesReceiptId === null ? [] : [entry.supersedesReceiptId]
      )
    );
    return history
      .filter((entry) => !superseded.has(entry.receipt.id))
      .map((entry) => entry.receipt);
  }

  forgetFailedAppendProjectionReceipts(
    runId: string,
    attemptId: string,
    sourceObjectIds: readonly string[]
  ): void {
    this.db.transaction(() => {
      const attempt = this.getLinkedItemRecoveryAttempt(runId, attemptId);
      const run = this.getRun();
      if (!run || run.id !== runId || !attempt || attempt.state !== 'failed') {
        throw new Error('Only a failed append can release unpublished projection receipts.');
      }
      const selected = new Set(sourceObjectIds);
      const captured = new Set(
        this.listLinkedItemRecoveryCaptures(runId, attemptId).map(
          (capture) => capture.sourceObjectId
        )
      );
      const original = new Set(this.getSourceSnapshot(runId)?.initialSourceObjectIds ?? []);
      const completed = new Set(
        this.listLinkedItemRecoveryAttempts(runId)
          .filter((previous) => previous.state === 'completed')
          .flatMap((previous) =>
            this.listLinkedItemRecoveryCaptures(runId, previous.id).map(
              (capture) => capture.sourceObjectId
            )
          )
      );
      if (
        selected.size !== sourceObjectIds.length ||
        [...selected].some((id) => !captured.has(id) || original.has(id) || completed.has(id))
      ) {
        throw new Error('A failed append cannot release a prior installed source.');
      }
      const history = this.listProjectionReceiptHistory(runId);
      for (const sourceObjectId of selected) {
        const entries = history.filter((entry) => entry.receipt.sourceObjectId === sourceObjectId);
        if (entries.length > 1 || entries.some((entry) => entry.supersedesReceiptId !== null)) {
          throw new Error('A failed append cannot release a revised projection receipt.');
        }
      }
      for (const sourceObjectId of selected) {
        const receipt = history.find(
          (entry) => entry.receipt.sourceObjectId === sourceObjectId
        )?.receipt;
        if (!receipt) continue;
        this.db
          .prepare('DELETE FROM projection_receipt_source WHERE receipt_id=? AND run_id=?')
          .run(receipt.id, runId);
        this.db
          .prepare('DELETE FROM projection_receipt WHERE id=? AND run_id=? AND source_object_id=?')
          .run(receipt.id, runId, sourceObjectId);
      }
    })();
  }

  listNeedsSequenceProjectionSourceIds(runId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT source_object_id
         FROM (
           SELECT source_object_id, body_json
           FROM projection_receipt
           WHERE run_id = ?
           UNION ALL
           SELECT source_object_id, body_json
           FROM projection_receipt_revision
           WHERE run_id = ?
         )
         WHERE json_extract(body_json, '$.nativeRepresentation') = 'dna_sequence_needs_sequence'
         ORDER BY source_object_id`
      )
      .all(runId, runId) as Array<{ source_object_id: string }>;
    return rows.map((row) => row.source_object_id);
  }

  appendProjectionReceiptRevision(input: ProjectionReceiptRevisionInput): void {
    const { receipt, supersedesReceiptId } = input;
    assertProviderTaskPrivacySafe(receipt, 'projection receipt revision');
    if (!stableNonemptyString(supersedesReceiptId) || receipt.id === supersedesReceiptId) {
      throw new Error('Projection receipt revision predecessor is invalid.');
    }
    this.db.transaction(() => {
      const existing = this.db
        .prepare(
          `SELECT supersedes_receipt_id, body_json
           FROM projection_receipt_revision
           WHERE id = ?`
        )
        .get(receipt.id) as { supersedes_receipt_id: string; body_json: string } | undefined;
      const body = JSON.stringify(receipt);
      if (existing) {
        if (existing.supersedes_receipt_id === supersedesReceiptId && existing.body_json === body) {
          return;
        }
        throw new Error(`Projection receipt revision ${receipt.id} is immutable.`);
      }
      const history = this.listProjectionReceiptHistory(receipt.runId);
      if (history.some((entry) => entry.receipt.id === receipt.id)) {
        throw new Error(`Projection receipt ID ${receipt.id} is already in use.`);
      }
      const predecessor = history.find(
        (entry) => entry.receipt.id === supersedesReceiptId
      )?.receipt;
      const active = this.listProjectionReceipts(receipt.runId).find(
        (candidate) => candidate.id === supersedesReceiptId
      );
      if (!predecessor || !active) {
        throw new Error(
          `Projection receipt revision ${receipt.id} must supersede the active receipt ${supersedesReceiptId}.`
        );
      }
      if (
        receipt.runId !== predecessor.runId ||
        receipt.sourceObjectId !== predecessor.sourceObjectId ||
        receipt.destinationObjectId !== predecessor.destinationObjectId ||
        (receipt.destinationPath !== predecessor.destinationPath &&
          !isNeedsSequenceReceiptCompletion(predecessor, receipt))
      ) {
        throw new Error(
          `Projection receipt revision ${receipt.id} must preserve its run, source, destination ID, and destination path.`
        );
      }
      if (
        !Number.isFinite(Date.parse(receipt.createdAt)) ||
        Date.parse(receipt.createdAt) <= Date.parse(predecessor.createdAt)
      ) {
        throw new Error(
          `Projection receipt revision ${receipt.id} must be created after ${supersedesReceiptId}.`
        );
      }
      this.db
        .prepare(
          `INSERT INTO projection_receipt_revision
             (id, run_id, source_object_id, destination_object_id,
              supersedes_receipt_id, body_json)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          receipt.id,
          receipt.runId,
          receipt.sourceObjectId,
          receipt.destinationObjectId,
          supersedesReceiptId,
          body
        );
      this.pinProjectionReceiptSource(receipt, input.sourceSnapshot);
    })();
  }

  listProjectionReceiptHistory(runId: string): ProjectionReceiptHistoryEntry[] {
    const baseRows = this.db
      .prepare(
        `SELECT id, run_id, source_object_id, destination_object_id, body_json
         FROM projection_receipt
         WHERE run_id = ?
         ORDER BY rowid`
      )
      .all(runId) as ProjectionReceiptSqliteRow[];
    const revisionRows = this.db
      .prepare(
        `SELECT id, run_id, source_object_id, destination_object_id,
                supersedes_receipt_id, body_json
         FROM projection_receipt_revision
         WHERE run_id = ?
         ORDER BY rowid`
      )
      .all(runId) as ProjectionReceiptRevisionSqliteRow[];
    const base = baseRows.map((row) => ({
      receipt: parseProjectionReceiptRow(row),
      supersedesReceiptId: null,
    }));
    const revisions = revisionRows.map((row) => ({
      receipt: parseProjectionReceiptRow(row),
      supersedesReceiptId: row.supersedes_receipt_id,
    }));
    const byId = new Map<string, ProjectionReceiptHistoryEntry>();
    for (const entry of [...base, ...revisions]) {
      if (byId.has(entry.receipt.id)) {
        throw new Error(`Projection receipt history contains duplicate ID ${entry.receipt.id}.`);
      }
      byId.set(entry.receipt.id, entry);
    }
    const successorById = new Map<string, ProjectionReceiptHistoryEntry>();
    for (const revision of revisions) {
      const predecessor = byId.get(revision.supersedesReceiptId!);
      if (
        !predecessor ||
        predecessor.receipt.runId !== revision.receipt.runId ||
        predecessor.receipt.sourceObjectId !== revision.receipt.sourceObjectId ||
        predecessor.receipt.destinationObjectId !== revision.receipt.destinationObjectId ||
        (predecessor.receipt.destinationPath !== revision.receipt.destinationPath &&
          !isNeedsSequenceReceiptCompletion(predecessor.receipt, revision.receipt)) ||
        successorById.has(predecessor.receipt.id)
      ) {
        throw new Error(
          `Projection receipt revision ${revision.receipt.id} has invalid supersession lineage.`
        );
      }
      successorById.set(predecessor.receipt.id, revision);
    }
    const ordered: ProjectionReceiptHistoryEntry[] = [];
    const visited = new Set<string>();
    for (const root of base) {
      let current: ProjectionReceiptHistoryEntry | undefined = root;
      while (current) {
        if (visited.has(current.receipt.id)) {
          throw new Error('Projection receipt history contains a cycle.');
        }
        visited.add(current.receipt.id);
        ordered.push(current);
        current = successorById.get(current.receipt.id);
      }
    }
    if (visited.size !== byId.size) {
      throw new Error('Projection receipt history contains an orphaned revision.');
    }
    return ordered;
  }

  appendProviderTaskEvidence(evidence: ProviderTaskEvidence): void {
    assertValidProviderTaskEvidence(evidence);
    const job = this.getExportJob(evidence.jobId);
    if (!job || job.runId !== evidence.runId || job.matchSignature !== evidence.matchSignature) {
      throw new Error(
        `Provider task evidence ${evidence.id} does not match export job ${evidence.jobId}.`
      );
    }
    this.appendImmutableJson('provider_task_evidence', evidence.id, evidence.runId, evidence);
  }

  listProviderTaskEvidence(runId: string): ProviderTaskEvidence[] {
    return this.listJson<ProviderTaskEvidence>('provider_task_evidence', runId);
  }

  appendProviderActivityEvidence(evidence: ProviderActivityBundle): void {
    const run = this.getRun();
    if (!run || run.id !== evidence.runId) {
      throw new Error(
        `Provider activity evidence ${evidence.id} does not match this migration run.`
      );
    }
    const normalized = validateProviderActivityEvidence(evidence, run.id);
    const existingForCommand = this.db
      .prepare(
        `SELECT body_json FROM provider_activity_evidence
         WHERE run_id = ? AND json_extract(body_json, '$.commandRequestId') = ?`
      )
      .get(run.id, normalized.commandRequestId) as { body_json: string } | undefined;
    if (existingForCommand) {
      if (existingForCommand.body_json === JSON.stringify(normalized)) return;
      throw new Error(
        `Provider command ${normalized.commandRequestId} already has a different immutable migration record for provider activity.`
      );
    }
    if (
      normalized.operationKind !== 'discover_scoped_folder_page' &&
      this.hasScopedFolderTraversalHeader(normalized.runId)
    ) {
      this.appendOwnedScopedFolderHistoryRecord(
        'provider_activity_evidence',
        normalized.id,
        normalized.runId,
        normalized
      );
      return;
    }
    this.appendImmutableJson(
      'provider_activity_evidence',
      normalized.id,
      normalized.runId,
      normalized
    );
  }

  listProviderActivityEvidence(runId: string): ProviderActivityBundle[] {
    const seenCommandRequestIds = new Set<string>();
    return this.listJson<unknown>('provider_activity_evidence', runId).map((candidate) => {
      const normalized = validateProviderActivityEvidence(candidate, runId);
      if (seenCommandRequestIds.has(normalized.commandRequestId)) {
        throw new Error(
          `Provider command ${normalized.commandRequestId} has duplicate immutable activity evidence.`
        );
      }
      seenCommandRequestIds.add(normalized.commandRequestId);
      return normalized;
    });
  }

  appendProviderCommandJournalEntry(entry: ProviderCommandJournalEntry): void {
    const run = this.getRun();
    if (!run || run.id !== entry.runId) {
      throw new Error(`Provider command ${entry.id} does not match this migration run.`);
    }
    const normalized = validateProviderCommandJournalEntry(entry, run);
    if (normalized.operationKind !== 'discover_scoped_folder_page') {
      if (this.hasScopedFolderTraversalHeader(normalized.runId)) {
        this.appendOwnedScopedFolderHistoryRecord(
          'provider_command_journal',
          normalized.id,
          normalized.runId,
          normalized
        );
      } else {
        this.appendImmutableJson(
          'provider_command_journal',
          normalized.id,
          normalized.runId,
          normalized
        );
      }
      return;
    }
    const append = this.db.transaction(() => {
      const cache = this.requireScopedFolderCommandAuditCache(normalized.runId, {
        adoptExternalSettlementBeforeScopedCommandAppend: true,
      });
      const priorCacheFingerprint = scopedFolderCommandAuditFingerprint(cache);
      this.requireFileBackedPeersAlignedWithScopedFolderHistory(priorCacheFingerprint);
      const existing = this.db
        .prepare(
          `SELECT rowid, id, run_id, body_json
           FROM provider_command_journal
           WHERE id = ?`
        )
        .get(normalized.id) as ScopedFolderCommandHistoryRow | undefined;
      if (!existing && cache.unsettledCommandRequestId !== null) {
        throw new Error(
          `Scoped Folder command ${cache.unsettledCommandRequestId} is already the unsettled tail.`
        );
      }
      this.appendImmutableJson(
        'provider_command_journal',
        normalized.id,
        normalized.runId,
        normalized
      );
      const mutationGeneration = this.requireOwnedScopedFolderCommandMutationAdvance(
        normalized.runId,
        cache.mutationGeneration,
        existing ? 0 : 1
      );
      const insertedRow = existing
        ? null
        : (this.db
            .prepare(
              `SELECT rowid, id, run_id, body_json
               FROM provider_command_journal
               WHERE id = ?`
            )
            .get(normalized.id) as ScopedFolderCommandHistoryRow | undefined);
      if (!existing && !insertedRow) {
        throw new Error('Scoped Folder command append was not durably visible.');
      }
      const commandHistoryAdvance = insertedRow
        ? advanceScopedFolderCommandHistoryCache(cache, insertedRow)
        : null;
      return {
        cache,
        priorCacheFingerprint,
        mutationGeneration,
        inserted: !existing,
        commandHistoryAdvance,
      };
    });
    const committed = append.immediate();
    if (this.scopedFolderCommandAuditCache === committed.cache) {
      committed.cache.mutationGeneration = committed.mutationGeneration;
      if (committed.inserted) {
        committed.cache.unsettledCommandRequestId = normalized.commandRequestId;
      }
      if (committed.commandHistoryAdvance) {
        committed.cache.commandRowCount = committed.commandHistoryAdvance.commandRowCount;
        committed.cache.commandHistoryDigest = committed.commandHistoryAdvance.commandHistoryDigest;
        committed.cache.lastCommandRowId = committed.commandHistoryAdvance.lastCommandRowId;
      }
      this.notifyFileBackedPeersOfOwnedScopedFolderHistoryCommit(
        committed.priorCacheFingerprint,
        scopedFolderCommandAuditFingerprint(committed.cache)
      );
    }
  }

  listProviderCommandJournal(runId: string): ProviderCommandJournalEntry[] {
    return this.listJson<ProviderCommandJournalEntry>('provider_command_journal', runId);
  }

  getProviderCommandJournalEntry(
    runId: string,
    commandRequestId: string
  ): ProviderCommandJournalEntry | null {
    requireOpaqueId(commandRequestId, 'Provider command request ID');
    const matches = this.listProviderCommandJournal(runId).filter(
      (candidate) => candidate.commandRequestId === commandRequestId
    );
    if (matches.length > 1) {
      throw new Error(
        `Provider command ${commandRequestId} has duplicate immutable command evidence.`
      );
    }
    return matches[0] ? structuredClone(matches[0]) : null;
  }

  appendNativeExportReconciliation(evidence: NativeExportSubmissionReconciliationEvidence): void {
    const run = this.getRun();
    if (!run || run.id !== evidence.runId) {
      throw new Error(`Native export reconciliation ${evidence.id} does not match this run.`);
    }
    const normalized = validateNativeExportReconciliation(evidence, run);
    const commands = this.listProviderCommandJournal(run.id);
    const original = commands.find(
      (candidate) => candidate.commandRequestId === normalized.originalCommandRequestId
    );
    const reconciliation = commands.find(
      (candidate) => candidate.commandRequestId === normalized.reconciliationCommandRequestId
    );
    const job = this.getExportJob(normalized.exportJobId);
    if (
      job?.runId !== run.id ||
      job.matchSignature !== normalized.matchSignature ||
      original?.operationKind !== 'submit_export' ||
      original.exportJobId !== normalized.exportJobId ||
      original.nativeExportLedgerEpoch !== normalized.nativeExportLedgerEpoch ||
      reconciliation?.operationKind !== 'reconcile_export_submission' ||
      reconciliation.exportJobId !== normalized.exportJobId ||
      reconciliation.reconcilesCommandRequestId !== normalized.originalCommandRequestId ||
      reconciliation.nativeExportLedgerEpoch !== normalized.nativeExportLedgerEpoch ||
      reconciliation.explicitResumeAttempt !== normalized.explicitResumeAttempt ||
      reconciliation.interventionSha256 !== normalized.interventionSha256
    ) {
      throw new Error(
        `Native export reconciliation ${normalized.id} does not match its durable commands.`
      );
    }
    this.appendImmutableJson(
      'native_export_reconciliation',
      normalized.id,
      normalized.runId,
      normalized
    );
  }

  listNativeExportReconciliations(runId: string): NativeExportSubmissionReconciliationEvidence[] {
    const run = this.getRun();
    if (!run || run.id !== runId) return [];
    return this.listJson<NativeExportSubmissionReconciliationEvidence>(
      'native_export_reconciliation',
      runId
    ).map((candidate) => validateNativeExportReconciliation(candidate, run));
  }

  appendNativeExportDownloadAcceptance(evidence: NativeExportDownloadAcceptanceEvidence): void {
    const run = this.getRun();
    if (!run || run.id !== evidence.runId) {
      throw new Error(`Native export download acceptance ${evidence.id} does not match this run.`);
    }
    const normalized = validateNativeExportDownloadAcceptanceEvidence(evidence, run.id);
    const job = this.getExportJob(normalized.exportJobId);
    const commands = this.listProviderCommandJournal(run.id).filter(
      (candidate) => candidate.commandRequestId === normalized.downloadCommandRequestId
    );
    const activities = this.listProviderActivityEvidence(run.id).filter(
      (candidate) => candidate.commandRequestId === normalized.downloadCommandRequestId
    );
    const [command] = commands;
    const [activity] = activities;
    if (
      !job ||
      job.runId !== run.id ||
      job.id !== normalized.exportJobId ||
      job.matchSignature !== normalized.matchSignature ||
      job.receiptId !== normalized.receiptId ||
      job.downloadUrlHash !== normalized.downloadUrlHash ||
      commands.length !== 1 ||
      command?.operationKind !== 'download_export' ||
      command.exportJobId !== normalized.exportJobId ||
      command.nativeExportLedgerEpoch !== normalized.nativeExportLedgerEpoch ||
      activities.length !== 1 ||
      !activity ||
      activity.operationKind !== 'download_export' ||
      activity.observedAt !== normalized.acceptedAt ||
      Date.parse(command.issuedAt) > Date.parse(normalized.acceptedAt) ||
      !isExactSuccessfulNativeExportDownloadActivity(activity)
    ) {
      throw new Error(
        `Native export download acceptance ${normalized.id} does not match its durable command and activity.`
      );
    }
    this.appendImmutableJson(
      'native_export_download_acceptance',
      normalized.id,
      normalized.runId,
      normalized
    );
  }

  listNativeExportDownloadAcceptances(runId: string): NativeExportDownloadAcceptanceEvidence[] {
    const run = this.getRun();
    if (!run || run.id !== runId) return [];
    return this.listJson<NativeExportDownloadAcceptanceEvidence>(
      'native_export_download_acceptance',
      runId
    ).map((candidate) => validateNativeExportDownloadAcceptanceEvidence(candidate, run.id));
  }

  saveValidationReport(report: ValidationReport): void {
    const run = this.getRun();
    if (!run || run.id !== report.runId) throw new Error('Validation report run does not exist.');
    if (run.state === 'unlocked') {
      const existing = this.getValidationReport(report.runId);
      if (existing && JSON.stringify(existing) !== JSON.stringify(report)) {
        throw new Error('An unlocked migration report is immutable.');
      }
    }
    this.writeValidationReport(report);
  }

  private writeValidationReport(report: ValidationReport): void {
    assertProviderTaskPrivacySafe(report, 'validation report');
    assertValidationReportRendererPrivacySafe(report);
    this.db
      .prepare(
        `INSERT INTO validation_report (run_id, passed, body_json, generated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           passed = excluded.passed,
           body_json = excluded.body_json,
           generated_at = excluded.generated_at`
      )
      .run(report.runId, report.passed ? 1 : 0, JSON.stringify(report), report.generatedAt);
  }

  commitLocalValidation(report: ValidationReport, run: MigrationRun): void {
    this.db.transaction(() => {
      this.saveValidationReport(report);
      this.saveRun(run);
    })();
  }

  getValidationReport(runId: string): ValidationReport | null {
    const row = this.db
      .prepare('SELECT body_json FROM validation_report WHERE run_id = ?')
      .get(runId) as { body_json: string } | undefined;
    if (!row) return null;
    const report: unknown = JSON.parse(row.body_json);
    assertValidationReportRendererPrivacySafe(report);
    return report;
  }

  appendRequestLedgerEntry(entry: MigrationRequestLedgerEntry): void {
    if (
      entry.requestKind !== 'folder_discovery' &&
      this.hasScopedFolderTraversalHeader(entry.runId)
    ) {
      this.appendOwnedScopedFolderHistoryRecord('request_ledger', entry.id, entry.runId, entry);
      return;
    }
    this.appendImmutableJson('request_ledger', entry.id, entry.runId, entry);
  }

  listRequestLedgerEntries(runId: string): MigrationRequestLedgerEntry[] {
    return this.listJson<unknown>('request_ledger', runId).map((candidate) =>
      validateMigrationRequestLedgerEntry(candidate, runId)
    );
  }

  requestCounts(runId: string): MigrationRequestCounts {
    const entries = this.listRequestLedgerEntries(runId);
    const byKind: MigrationRequestCounts['byKind'] = {
      export_submit: 0,
      export_submit_reconcile: 0,
      gmail_poll: 0,
      export_split_discovery: 0,
      export_inspect: 0,
      export_download: 0,
      folder_discovery: 0,
      targeted_read: 0,
    };
    for (const entry of entries) byKind[entry.requestKind] += 1;
    return {
      total: entries.length,
      cacheHits: entries.filter((entry) => entry.outcome === 'cache_hit').length,
      byKind,
    };
  }

  private requireScopedFolderTraversalRun(runId: string): MigrationRun {
    const run = this.getRun();
    if (!run || run.id !== runId) {
      throw new Error(`Scoped Folder traversal run ${runId} is not bound to this workspace.`);
    }
    return run;
  }

  private requireScopedFolderCommand(
    run: MigrationRun,
    commandRequestId: string
  ): UnsettledScopedFolderCommand {
    const row = this.db
      .prepare(
        `SELECT body_json
         FROM provider_command_journal
         WHERE run_id = ? AND json_extract(body_json, '$.commandRequestId') = ?`
      )
      .get(run.id, commandRequestId) as { body_json: string } | undefined;
    if (!row) {
      throw new Error(
        `Scoped Folder command ${commandRequestId} was not durably journaled before dispatch.`
      );
    }
    const command = validateProviderCommandJournalEntry(JSON.parse(row.body_json) as unknown, run);
    if (!isScopedFolderCommand(command)) {
      throw new Error(`Provider command ${commandRequestId} is not a scoped Folder discovery.`);
    }
    return command;
  }

  private isPersistedScopedFolderFailure(command: UnsettledScopedFolderCommand): boolean {
    const activityRow = this.db
      .prepare(
        `SELECT body_json
         FROM provider_activity_evidence
         WHERE run_id = ? AND json_extract(body_json, '$.commandRequestId') = ?`
      )
      .get(command.runId, command.commandRequestId) as { body_json: string } | undefined;
    const ledgerRow = this.db
      .prepare(
        `SELECT body_json
         FROM request_ledger
         WHERE run_id = ? AND json_extract(body_json, '$.commandRequestId') = ?`
      )
      .get(command.runId, command.commandRequestId) as { body_json: string } | undefined;
    if (!activityRow || !ledgerRow) return false;
    const activity = validateScopedFolderSettlementActivity(
      JSON.parse(activityRow.body_json) as unknown,
      command.runId,
      command.commandRequestId
    );
    const requestLedgerEntry = validateScopedFolderSettlementRequestLedgerEntry(
      JSON.parse(ledgerRow.body_json) as unknown,
      command.runId,
      command.commandRequestId,
      command.scopedFolderCorrelation.pageRequestSha256
    );
    assertFailedScopedFolderSettlement(activity, requestLedgerEntry);
    return true;
  }

  private assertScopedFolderSettlementRecordState(
    table: 'provider_activity_evidence' | 'request_ledger',
    id: string,
    runId: string,
    commandRequestId: string,
    value: unknown
  ): boolean {
    const expectedBody = JSON.stringify(value);
    const byId = this.db.prepare(`SELECT run_id, body_json FROM ${table} WHERE id = ?`).get(id) as
      | { run_id: string; body_json: string }
      | undefined;
    const byCommand = this.db
      .prepare(
        `SELECT id, run_id, body_json
         FROM ${table}
         WHERE run_id = ? AND json_extract(body_json, '$.commandRequestId') = ?`
      )
      .all(runId, commandRequestId) as Array<{
      id: string;
      run_id: string;
      body_json: string;
    }>;
    if (byCommand.length > 1) {
      throw new Error(`Scoped Folder command has duplicate ${table} records.`);
    }
    const correlated = byCommand[0];
    if (byId) {
      if (byId.run_id !== runId || byId.body_json !== expectedBody) {
        throw new Error(`Immutable migration record ${table}/${id} already exists.`);
      }
      if (!correlated || correlated.id !== id || correlated.body_json !== expectedBody) {
        throw new Error(`Scoped Folder command has conflicting ${table} correlation.`);
      }
      return true;
    }
    if (correlated) {
      throw new Error(`Scoped Folder command already has a different ${table} record.`);
    }
    return false;
  }

  private requireOwnedScopedFolderSettlementHistoryAdvances(
    cache: ScopedFolderCommandAuditCache,
    activityId: string,
    requestLedgerId: string
  ): Readonly<{
    activity: ScopedFolderProtectedHistoryAdvance;
    requestLedger: ScopedFolderProtectedHistoryAdvance;
  }> {
    const activityRow = this.db
      .prepare(
        `SELECT rowid, id, run_id, body_json
         FROM provider_activity_evidence
         WHERE id = ?`
      )
      .get(activityId) as ScopedFolderCommandHistoryRow | undefined;
    const requestLedgerRow = this.db
      .prepare(
        `SELECT rowid, id, run_id, body_json
         FROM request_ledger
         WHERE id = ?`
      )
      .get(requestLedgerId) as ScopedFolderCommandHistoryRow | undefined;
    if (!activityRow || !requestLedgerRow) {
      throw new Error('Scoped Folder settlement history was not durably visible.');
    }
    return Object.freeze({
      activity: advanceScopedFolderProtectedHistoryCache({
        schema: SCOPED_FOLDER_ACTIVITY_HISTORY_SCHEMA,
        runId: cache.runId,
        rowCount: cache.activityRowCount,
        historyDigest: cache.activityHistoryDigest,
        lastRowId: cache.lastActivityRowId,
        row: activityRow,
      }),
      requestLedger: advanceScopedFolderProtectedHistoryCache({
        schema: SCOPED_FOLDER_REQUEST_LEDGER_HISTORY_SCHEMA,
        runId: cache.runId,
        rowCount: cache.requestLedgerRowCount,
        historyDigest: cache.requestLedgerHistoryDigest,
        lastRowId: cache.lastRequestLedgerRowId,
        row: requestLedgerRow,
      }),
    });
  }

  private requireScopedFolderTraversalReplayCache(
    runId: string,
    currentHeader: Readonly<{
      journal: ScopedFolderTraversalJournal;
      head: ScopedFolderTraversalJournalHead;
    }> | null = this.readScopedFolderTraversalHeader(runId),
    currentMutationGeneration: number | null = currentHeader
      ? this.readScopedFolderTraversalMutationGeneration(runId)
      : null,
    options: Readonly<{
      externalCommandAdoption?: ScopedFolderExternalCommandAdoption | null;
    }> = {}
  ): ScopedFolderTraversalReplayCache {
    if (this.scopedFolderTraversalIntegrityFailure) {
      throw this.scopedFolderTraversalIntegrityFailure;
    }
    if (!currentHeader) {
      throw new Error(`Scoped Folder traversal journal for run ${runId} is not initialized.`);
    }
    if (currentMutationGeneration === null) {
      throw new Error(`Scoped Folder traversal mutation clock for run ${runId} is missing.`);
    }
    const dataVersion = this.readSqliteDataVersion();
    const cached = this.scopedFolderTraversalReplayCache;
    if (cached?.runId === runId) {
      const headAndMutationClockAreUnchanged =
        cached.head.pageCount === currentHeader.head.pageCount &&
        cached.head.recordHash === currentHeader.head.recordHash &&
        cached.mutationGeneration === currentMutationGeneration;
      if (headAndMutationClockAreUnchanged && cached.dataVersion === dataVersion) {
        return cached;
      }
      let auditedCheckpoint: DurableScopedFolderTraversalCheckpoint | null = null;
      try {
        const persisted = this.readScopedFolderTraversalRows(runId);
        if (!persisted) {
          throw new Error(`Scoped Folder traversal journal for run ${runId} is not initialized.`);
        }
        auditedCheckpoint = createDurableScopedFolderTraversalCheckpoint(persisted.journal);
        if (
          headAndMutationClockAreUnchanged &&
          persisted.head.pageCount === cached.head.pageCount &&
          persisted.head.recordHash === cached.head.recordHash
        ) {
          invalidateDurableScopedFolderTraversalCheckpoint(cached.checkpoint);
          cached.checkpoint = auditedCheckpoint;
          cached.dataVersion = dataVersion;
          return cached;
        }
        const externalCommandAdoption = options.externalCommandAdoption;
        const adoptedExpectedExternalCommand =
          externalCommandAdoption !== null &&
          externalCommandAdoption !== undefined &&
          externalCommandAdoption.dataVersion === dataVersion &&
          this.scopedFolderCommandAuditCache?.runId === runId &&
          this.scopedFolderCommandAuditCache.dataVersion === dataVersion &&
          this.scopedFolderCommandAuditCache.mutationGeneration ===
            externalCommandAdoption.mutationGeneration &&
          this.scopedFolderCommandAuditCache.unsettledCommandRequestId ===
            externalCommandAdoption.commandRequestId;
        if (
          adoptedExpectedExternalCommand &&
          headAndMutationClockAreUnchanged &&
          persisted.head.pageCount === cached.head.pageCount &&
          persisted.head.recordHash === cached.head.recordHash
        ) {
          invalidateDurableScopedFolderTraversalCheckpoint(cached.checkpoint);
          cached.checkpoint = auditedCheckpoint;
          cached.dataVersion = dataVersion;
          return cached;
        }
      } catch (error) {
        this.scopedFolderTraversalIntegrityFailure = asError(error);
        this.clearScopedFolderTraversalReplayCache();
        throw error;
      }
      if (auditedCheckpoint) {
        invalidateDurableScopedFolderTraversalCheckpoint(auditedCheckpoint);
      }
      const error = new Error(
        `Scoped Folder traversal for run ${runId} changed outside the owned write set.`
      );
      this.scopedFolderTraversalIntegrityFailure = error;
      this.clearScopedFolderTraversalReplayCache();
      throw error;
    }
    this.clearScopedFolderTraversalReplayCache();
    try {
      const persisted = this.readScopedFolderTraversalRows(runId);
      if (!persisted) {
        throw new Error(`Scoped Folder traversal journal for run ${runId} is not initialized.`);
      }
      const verifiedGeneration = this.readScopedFolderTraversalMutationGeneration(runId);
      const verifiedDataVersion = this.readSqliteDataVersion();
      if (verifiedGeneration !== currentMutationGeneration || verifiedDataVersion !== dataVersion) {
        throw new Error(`Scoped Folder traversal for run ${runId} changed during its audit.`);
      }
      this.instrumentation.onScopedFolderTraversalSemanticReplay?.();
      const rebuilt: ScopedFolderTraversalReplayCache = {
        runId,
        head: persisted.head,
        mutationGeneration: currentMutationGeneration,
        dataVersion,
        checkpoint: createDurableScopedFolderTraversalCheckpoint(persisted.journal),
      };
      this.scopedFolderTraversalReplayCache = rebuilt;
      return rebuilt;
    } catch (error) {
      this.scopedFolderTraversalIntegrityFailure = asError(error);
      throw error;
    }
  }

  private clearScopedFolderTraversalReplayCache(): void {
    const cached = this.scopedFolderTraversalReplayCache;
    if (cached) invalidateDurableScopedFolderTraversalCheckpoint(cached.checkpoint);
    this.scopedFolderTraversalReplayCache = null;
  }

  private readScopedFolderTraversalMutationGeneration(runId: string): number {
    const row = this.db
      .prepare(
        `SELECT generation
         FROM scoped_folder_traversal_mutation_clock
         WHERE run_id = ?`
      )
      .get(runId) as { generation: number } | undefined;
    if (!row || !Number.isSafeInteger(row.generation) || row.generation < 0) {
      throw new Error(`Scoped Folder traversal mutation clock for run ${runId} is invalid.`);
    }
    return row.generation;
  }

  private requireOwnedScopedFolderMutationAdvance(
    runId: string,
    priorGeneration: number,
    expectedDelta: number
  ): number {
    const nextGeneration = this.readScopedFolderTraversalMutationGeneration(runId);
    const expectedGeneration = priorGeneration + expectedDelta;
    if (
      !Number.isSafeInteger(expectedDelta) ||
      expectedDelta < 0 ||
      !Number.isSafeInteger(expectedGeneration) ||
      nextGeneration !== expectedGeneration
    ) {
      throw new Error(
        `Scoped Folder traversal mutation clock for run ${runId} changed outside the owned write set.`
      );
    }
    return nextGeneration;
  }

  private readScopedFolderCommandMutationGeneration(runId: string): number {
    const row = this.db
      .prepare(
        `SELECT generation
         FROM scoped_folder_command_mutation_clock
         WHERE run_id = ?`
      )
      .get(runId) as { generation: number } | undefined;
    if (!row || !Number.isSafeInteger(row.generation) || row.generation < 0) {
      throw new Error(`Scoped Folder command mutation clock for run ${runId} is invalid.`);
    }
    return row.generation;
  }

  private readSqliteDataVersion(): number {
    const dataVersion = this.db.pragma('data_version', { simple: true });
    if (!Number.isSafeInteger(dataVersion) || Number(dataVersion) < 0) {
      throw new Error('Benchling migration SQLite data version is invalid.');
    }
    return Number(dataVersion);
  }

  private requireOwnedScopedFolderCommandMutationAdvance(
    runId: string,
    priorGeneration: number,
    expectedDelta: number
  ): number {
    const nextGeneration = this.readScopedFolderCommandMutationGeneration(runId);
    const expectedGeneration = priorGeneration + expectedDelta;
    if (
      !Number.isSafeInteger(expectedDelta) ||
      expectedDelta < 0 ||
      !Number.isSafeInteger(expectedGeneration) ||
      nextGeneration !== expectedGeneration
    ) {
      throw new Error(
        `Scoped Folder command mutation clock for run ${runId} changed outside the owned write set.`
      );
    }
    return nextGeneration;
  }

  private requireScopedFolderCommandAuditCache(
    runId: string,
    options: Readonly<{
      adoptExternalUnsettledCommandRequestId?: string;
      adoptExternalSettlementBeforeScopedCommandAppend?: true;
    }> = {}
  ): ScopedFolderCommandAuditCache {
    if (this.scopedFolderCommandIntegrityFailure) {
      throw this.scopedFolderCommandIntegrityFailure;
    }
    const mutationGeneration = this.readScopedFolderCommandMutationGeneration(runId);
    const dataVersion = this.readSqliteDataVersion();
    const cached = this.scopedFolderCommandAuditCache;
    if (cached?.runId === runId) {
      if (cached.mutationGeneration === mutationGeneration && cached.dataVersion === dataVersion) {
        return cached;
      }
      try {
        const audit = this.auditScopedFolderCommandSettlementHistory(runId);
        const verifiedMutationGeneration = this.readScopedFolderCommandMutationGeneration(runId);
        const verifiedDataVersion = this.readSqliteDataVersion();
        if (
          verifiedMutationGeneration !== mutationGeneration ||
          verifiedDataVersion !== dataVersion
        ) {
          throw new Error(
            `Scoped Folder command history for run ${runId} changed during its audit.`
          );
        }
        if (
          cached.dataVersion !== dataVersion &&
          mutationGeneration === cached.mutationGeneration &&
          scopedFolderCommandAuditMatchesCache(audit, cached)
        ) {
          cached.dataVersion = dataVersion;
          return cached;
        }
        if (
          options.adoptExternalUnsettledCommandRequestId !== undefined &&
          cached.unsettledCommandRequestId === null &&
          cached.dataVersion !== dataVersion &&
          mutationGeneration === cached.mutationGeneration + 1 &&
          audit.unsettledCommandRequestId === options.adoptExternalUnsettledCommandRequestId &&
          audit.commandRowCount === cached.commandRowCount + 1 &&
          audit.commandHistoryPrefixDigest === cached.commandHistoryDigest &&
          audit.lastCommandRowId !== null &&
          (cached.lastCommandRowId === null || audit.lastCommandRowId > cached.lastCommandRowId) &&
          audit.lastCommandRequestId === options.adoptExternalUnsettledCommandRequestId &&
          audit.activityRowCount === cached.activityRowCount &&
          audit.activityHistoryDigest === cached.activityHistoryDigest &&
          audit.lastActivityRowId === cached.lastActivityRowId &&
          audit.requestLedgerRowCount === cached.requestLedgerRowCount &&
          audit.requestLedgerHistoryDigest === cached.requestLedgerHistoryDigest &&
          audit.lastRequestLedgerRowId === cached.lastRequestLedgerRowId
        ) {
          cached.mutationGeneration = mutationGeneration;
          cached.dataVersion = dataVersion;
          cached.unsettledCommandRequestId = audit.unsettledCommandRequestId;
          cached.commandRowCount = audit.commandRowCount;
          cached.commandHistoryDigest = audit.commandHistoryDigest;
          cached.lastCommandRowId = audit.lastCommandRowId;
          cached.activityRowCount = audit.activityRowCount;
          cached.activityHistoryDigest = audit.activityHistoryDigest;
          cached.lastActivityRowId = audit.lastActivityRowId;
          cached.requestLedgerRowCount = audit.requestLedgerRowCount;
          cached.requestLedgerHistoryDigest = audit.requestLedgerHistoryDigest;
          cached.lastRequestLedgerRowId = audit.lastRequestLedgerRowId;
          return cached;
        }
        const externallySettledCommandRequestId =
          options.adoptExternalSettlementBeforeScopedCommandAppend === true
            ? cached.unsettledCommandRequestId
            : null;
        if (
          externallySettledCommandRequestId !== null &&
          cached.dataVersion !== dataVersion &&
          mutationGeneration === cached.mutationGeneration + 2 &&
          audit.unsettledCommandRequestId === null &&
          audit.commandRowCount === cached.commandRowCount &&
          audit.commandHistoryDigest === cached.commandHistoryDigest &&
          audit.lastCommandRowId === cached.lastCommandRowId &&
          audit.activityRowCount === cached.activityRowCount + 1 &&
          audit.activityHistoryPrefixDigest === cached.activityHistoryDigest &&
          audit.lastActivityRowId !== null &&
          (cached.lastActivityRowId === null ||
            audit.lastActivityRowId > cached.lastActivityRowId) &&
          audit.lastActivityCommandRequestId === externallySettledCommandRequestId &&
          audit.requestLedgerRowCount === cached.requestLedgerRowCount + 1 &&
          audit.requestLedgerHistoryPrefixDigest === cached.requestLedgerHistoryDigest &&
          audit.lastRequestLedgerRowId !== null &&
          (cached.lastRequestLedgerRowId === null ||
            audit.lastRequestLedgerRowId > cached.lastRequestLedgerRowId) &&
          audit.lastRequestLedgerCommandRequestId === externallySettledCommandRequestId
        ) {
          cached.mutationGeneration = mutationGeneration;
          cached.dataVersion = dataVersion;
          cached.unsettledCommandRequestId = null;
          cached.activityRowCount = audit.activityRowCount;
          cached.activityHistoryDigest = audit.activityHistoryDigest;
          cached.lastActivityRowId = audit.lastActivityRowId;
          cached.requestLedgerRowCount = audit.requestLedgerRowCount;
          cached.requestLedgerHistoryDigest = audit.requestLedgerHistoryDigest;
          cached.lastRequestLedgerRowId = audit.lastRequestLedgerRowId;
          return cached;
        }
      } catch (error) {
        this.scopedFolderCommandIntegrityFailure = asError(error);
        throw error;
      }
      const error = new Error(
        `Scoped Folder command history for run ${runId} changed outside the owned write set.`
      );
      this.scopedFolderCommandIntegrityFailure = error;
      throw error;
    }
    try {
      const audit = this.auditScopedFolderCommandSettlementHistory(runId);
      const verifiedGeneration = this.readScopedFolderCommandMutationGeneration(runId);
      const verifiedDataVersion = this.readSqliteDataVersion();
      if (verifiedGeneration !== mutationGeneration || verifiedDataVersion !== dataVersion) {
        throw new Error(`Scoped Folder command history for run ${runId} changed during its audit.`);
      }
      const rebuilt = {
        runId,
        mutationGeneration,
        dataVersion,
        unsettledCommandRequestId: audit.unsettledCommandRequestId,
        commandRowCount: audit.commandRowCount,
        commandHistoryDigest: audit.commandHistoryDigest,
        lastCommandRowId: audit.lastCommandRowId,
        activityRowCount: audit.activityRowCount,
        activityHistoryDigest: audit.activityHistoryDigest,
        lastActivityRowId: audit.lastActivityRowId,
        requestLedgerRowCount: audit.requestLedgerRowCount,
        requestLedgerHistoryDigest: audit.requestLedgerHistoryDigest,
        lastRequestLedgerRowId: audit.lastRequestLedgerRowId,
      };
      this.scopedFolderCommandAuditCache = rebuilt;
      return rebuilt;
    } catch (error) {
      this.scopedFolderCommandIntegrityFailure = asError(error);
      throw error;
    }
  }

  private auditScopedFolderCommandSettlementHistory(
    runId: string
  ): ScopedFolderCommandHistoryAudit {
    const run = this.requireScopedFolderTraversalRun(runId);
    const commandRows = this.db
      .prepare(
        `SELECT rowid, id, run_id, body_json
         FROM provider_command_journal
         WHERE run_id = ?
         ORDER BY rowid`
      )
      .all(runId) as ScopedFolderCommandHistoryRow[];
    const scopedCommands: Array<{
      rowid: number;
      command: UnsettledScopedFolderCommand;
    }> = [];
    const scopedByRequestId = new Map<string, UnsettledScopedFolderCommand>();
    let commandHistoryDigest = SCOPED_FOLDER_COMMAND_HISTORY_EMPTY_DIGEST;
    let commandHistoryPrefixDigest = SCOPED_FOLDER_COMMAND_HISTORY_EMPTY_DIGEST;
    let lastCommandRequestId: string | null = null;
    for (const [index, row] of commandRows.entries()) {
      const command = validateProviderCommandJournalEntry(
        JSON.parse(row.body_json) as unknown,
        run
      );
      if (row.id !== command.id || row.run_id !== command.runId) {
        throw new Error(`Provider command ${row.id} SQLite correlation is invalid.`);
      }
      if (index === commandRows.length - 1) {
        commandHistoryPrefixDigest = commandHistoryDigest;
        lastCommandRequestId = command.commandRequestId;
      }
      commandHistoryDigest = advanceScopedFolderCommandHistoryDigest(commandHistoryDigest, row);
      if (!isScopedFolderCommand(command)) continue;
      if (scopedByRequestId.has(command.commandRequestId)) {
        throw new Error(`Scoped Folder command ${command.commandRequestId} is duplicated.`);
      }
      scopedByRequestId.set(command.commandRequestId, command);
      scopedCommands.push({ rowid: row.rowid, command });
    }

    const activities = new Map<string, ProviderActivityBundle>();
    const activityRows = this.db
      .prepare(
        `SELECT rowid, id, run_id, body_json
         FROM provider_activity_evidence
         WHERE run_id = ?
         ORDER BY rowid`
      )
      .all(runId) as ScopedFolderCommandHistoryRow[];
    let activityHistoryDigest = SCOPED_FOLDER_ACTIVITY_HISTORY_EMPTY_DIGEST;
    let activityHistoryPrefixDigest = SCOPED_FOLDER_ACTIVITY_HISTORY_EMPTY_DIGEST;
    let lastActivityCommandRequestId: string | null = null;
    for (const [index, row] of activityRows.entries()) {
      const candidate = JSON.parse(row.body_json) as unknown;
      const record = candidate as Partial<ProviderActivityBundle> | null;
      const commandRequestId =
        record && typeof record === 'object' && typeof record.commandRequestId === 'string'
          ? record.commandRequestId
          : null;
      if (index === activityRows.length - 1) {
        activityHistoryPrefixDigest = activityHistoryDigest;
        lastActivityCommandRequestId = commandRequestId;
      }
      activityHistoryDigest = advanceScopedFolderProtectedHistoryDigest(
        SCOPED_FOLDER_ACTIVITY_HISTORY_SCHEMA,
        activityHistoryDigest,
        row
      );
      if (
        record?.operationKind !== 'discover_scoped_folder_page' &&
        (!commandRequestId || !scopedByRequestId.has(commandRequestId))
      ) {
        continue;
      }
      if (!commandRequestId || !scopedByRequestId.has(commandRequestId)) {
        throw new Error('Scoped Folder activity evidence has no durable command correlation.');
      }
      const activity = validateScopedFolderSettlementActivity(candidate, runId, commandRequestId);
      if (row.id !== activity.id || row.run_id !== activity.runId) {
        throw new Error(`Scoped Folder activity ${row.id} SQLite correlation is invalid.`);
      }
      if (activities.has(commandRequestId)) {
        throw new Error(
          `Scoped Folder command ${commandRequestId} has duplicate activity evidence.`
        );
      }
      activities.set(commandRequestId, activity);
    }

    const ledgers = new Map<string, MigrationRequestLedgerEntry>();
    const ledgerRows = this.db
      .prepare(
        `SELECT rowid, id, run_id, body_json
         FROM request_ledger
         WHERE run_id = ?
         ORDER BY rowid`
      )
      .all(runId) as ScopedFolderCommandHistoryRow[];
    let requestLedgerHistoryDigest = SCOPED_FOLDER_REQUEST_LEDGER_HISTORY_EMPTY_DIGEST;
    let requestLedgerHistoryPrefixDigest = SCOPED_FOLDER_REQUEST_LEDGER_HISTORY_EMPTY_DIGEST;
    let lastRequestLedgerCommandRequestId: string | null = null;
    for (const [index, row] of ledgerRows.entries()) {
      const candidate = JSON.parse(row.body_json) as unknown;
      const record = candidate as Partial<MigrationRequestLedgerEntry> | null;
      const commandRequestId =
        record && typeof record === 'object' && typeof record.commandRequestId === 'string'
          ? record.commandRequestId
          : null;
      if (index === ledgerRows.length - 1) {
        requestLedgerHistoryPrefixDigest = requestLedgerHistoryDigest;
        lastRequestLedgerCommandRequestId = commandRequestId;
      }
      requestLedgerHistoryDigest = advanceScopedFolderProtectedHistoryDigest(
        SCOPED_FOLDER_REQUEST_LEDGER_HISTORY_SCHEMA,
        requestLedgerHistoryDigest,
        row
      );
      if (
        record?.requestKind !== 'folder_discovery' &&
        (!commandRequestId || !scopedByRequestId.has(commandRequestId))
      ) {
        continue;
      }
      const command = commandRequestId ? scopedByRequestId.get(commandRequestId) : undefined;
      if (!commandRequestId || !command) {
        throw new Error('Scoped Folder request ledger has no durable command correlation.');
      }
      const ledger = validateScopedFolderSettlementRequestLedgerEntry(
        candidate,
        runId,
        commandRequestId,
        command.scopedFolderCorrelation.pageRequestSha256
      );
      if (row.id !== ledger.id || row.run_id !== ledger.runId) {
        throw new Error(`Scoped Folder request ledger ${row.id} SQLite correlation is invalid.`);
      }
      if (ledgers.has(commandRequestId)) {
        throw new Error(`Scoped Folder command ${commandRequestId} has duplicate request ledgers.`);
      }
      ledgers.set(commandRequestId, ledger);
    }

    let unsettledCommandRequestId: string | null = null;
    for (const { command } of scopedCommands) {
      const activity = activities.get(command.commandRequestId);
      const ledger = ledgers.get(command.commandRequestId);
      if (Boolean(activity) !== Boolean(ledger)) {
        throw new Error('Scoped Folder command history contains a partial durable settlement.');
      }
      if (!activity || !ledger) {
        if (unsettledCommandRequestId !== null) {
          throw new Error('Scoped Folder command history contains multiple unsettled commands.');
        }
        unsettledCommandRequestId = command.commandRequestId;
        continue;
      }
      if (unsettledCommandRequestId !== null) {
        throw new Error(
          `Scoped Folder command ${unsettledCommandRequestId} is not the sole unsettled tail.`
        );
      }
      if (ledger.outcome === 'success') {
        assertSuccessfulScopedFolderSettlement(
          activity,
          ledger,
          command.scopedFolderCorrelation.purpose === 'advance' ? 'append' : 'replay'
        );
      } else {
        assertFailedScopedFolderSettlement(activity, ledger);
      }
    }
    return Object.freeze({
      unsettledCommandRequestId,
      commandRowCount: commandRows.length,
      commandHistoryDigest,
      commandHistoryPrefixDigest,
      lastCommandRowId: commandRows.at(-1)?.rowid ?? null,
      lastCommandRequestId,
      activityRowCount: activityRows.length,
      activityHistoryDigest,
      activityHistoryPrefixDigest,
      lastActivityRowId: activityRows.at(-1)?.rowid ?? null,
      lastActivityCommandRequestId,
      requestLedgerRowCount: ledgerRows.length,
      requestLedgerHistoryDigest,
      requestLedgerHistoryPrefixDigest,
      lastRequestLedgerRowId: ledgerRows.at(-1)?.rowid ?? null,
      lastRequestLedgerCommandRequestId,
    });
  }

  private readScopedFolderTraversalHeader(runId: string): Readonly<{
    journal: ScopedFolderTraversalJournal;
    head: ScopedFolderTraversalJournalHead;
  }> | null {
    const header = this.db
      .prepare(
        `SELECT body_json, header_hash, page_count, head_record_hash
         FROM scoped_folder_traversal_header
         WHERE run_id = ?`
      )
      .get(runId) as
      | {
          body_json: string;
          header_hash: string;
          page_count: number;
          head_record_hash: string;
        }
      | undefined;
    if (!header) return null;
    const run = this.requireScopedFolderTraversalRun(runId);
    const parsedHeader = parseCanonicalScopedFolderTraversalJson(
      header.body_json,
      'header body'
    ) as Partial<ScopedFolderTraversalJournal>;
    const journal = createScopedFolderTraversalJournal({
      scopeKind: parsedHeader.scopeKind as ScopedFolderTraversalScopeKind,
      selectedRootIds: parsedHeader.selectedRootIds as string[],
    });
    if (
      canonicalScopedFolderTraversalJson(parsedHeader) !==
      canonicalScopedFolderTraversalJson(journal)
    ) {
      throw new Error('Scoped Folder traversal header body is not canonical.');
    }
    assertScopedFolderTraversalJournalMatchesRunScope(run, journal);
    const expectedHeaderHash = scopedFolderTraversalPersistenceHash({
      schema: SCOPED_FOLDER_TRAVERSAL_SQLITE_HEADER_SCHEMA,
      runId,
      journal,
    });
    if (header.header_hash !== expectedHeaderHash) {
      throw new Error('Scoped Folder traversal header hash is invalid.');
    }
    if (
      !Number.isSafeInteger(header.page_count) ||
      header.page_count < 0 ||
      header.page_count > SCOPED_FOLDER_MAX_PAGES ||
      !SHA256_REF.test(header.head_record_hash)
    ) {
      throw new Error('Scoped Folder traversal persisted head is invalid.');
    }
    if (header.page_count === 0 && header.head_record_hash !== expectedHeaderHash) {
      throw new Error('Scoped Folder traversal empty head hash is invalid.');
    }
    return Object.freeze({
      journal,
      head: Object.freeze({
        pageCount: header.page_count,
        recordHash: header.head_record_hash,
      }),
    });
  }

  private readScopedFolderTraversalState(runId: string): {
    journal: ScopedFolderTraversalJournal;
    head: ScopedFolderTraversalJournalHead;
  } | null {
    const persisted = this.readScopedFolderTraversalRows(runId);
    if (!persisted) {
      if (
        this.scopedFolderTraversalReplayCache?.runId === runId ||
        this.hasOrphanedScopedFolderTraversalState(runId)
      ) {
        throw new Error(
          `Scoped Folder traversal for run ${runId} changed outside the owned write set.`
        );
      }
      return null;
    }
    return {
      journal: this.semanticReplayScopedFolderTraversalJournal(persisted.journal),
      head: persisted.head,
    };
  }

  private readScopedFolderTraversalRows(runId: string): {
    journal: ScopedFolderTraversalJournal;
    head: ScopedFolderTraversalJournalHead;
  } | null {
    const header = this.db
      .prepare(
        `SELECT body_json, header_hash, page_count, head_record_hash
         FROM scoped_folder_traversal_header
         WHERE run_id = ?`
      )
      .get(runId) as
      | {
          body_json: string;
          header_hash: string;
          page_count: number;
          head_record_hash: string;
        }
      | undefined;
    if (!header) return null;

    const run = this.requireScopedFolderTraversalRun(runId);

    const parsedHeader = parseCanonicalScopedFolderTraversalJson(
      header.body_json,
      'header body'
    ) as Partial<ScopedFolderTraversalJournal>;
    const normalizedHeader = createScopedFolderTraversalJournal({
      scopeKind: parsedHeader.scopeKind as ScopedFolderTraversalScopeKind,
      selectedRootIds: parsedHeader.selectedRootIds as string[],
    });
    if (
      canonicalScopedFolderTraversalJson(parsedHeader) !==
      canonicalScopedFolderTraversalJson(normalizedHeader)
    ) {
      throw new Error('Scoped Folder traversal header body is not canonical.');
    }
    assertScopedFolderTraversalJournalMatchesRunScope(run, normalizedHeader);
    const expectedHeaderHash = scopedFolderTraversalPersistenceHash({
      schema: SCOPED_FOLDER_TRAVERSAL_SQLITE_HEADER_SCHEMA,
      runId,
      journal: normalizedHeader,
    });
    if (header.header_hash !== expectedHeaderHash) {
      throw new Error('Scoped Folder traversal header hash is invalid.');
    }
    if (
      !Number.isSafeInteger(header.page_count) ||
      header.page_count < 0 ||
      header.page_count > SCOPED_FOLDER_MAX_PAGES
    ) {
      throw new Error('Scoped Folder traversal persisted page count is invalid.');
    }

    const rows = this.db
      .prepare(
        `SELECT ordinal, source_command_request_id, previous_record_hash, record_hash, body_json
         FROM scoped_folder_traversal_page
         WHERE run_id = ?
         ORDER BY ordinal`
      )
      .all(runId) as ScopedFolderPersistedPageRow[];
    if (rows.length !== header.page_count) {
      throw new Error('Scoped Folder traversal persisted page count does not match its rows.');
    }

    const entries: unknown[] = [];
    let previousRecordHash = expectedHeaderHash;
    for (const [expectedOrdinal, row] of rows.entries()) {
      if (!Number.isSafeInteger(row.ordinal) || row.ordinal !== expectedOrdinal) {
        throw new Error('Scoped Folder traversal page ordinal is not contiguous.');
      }
      if (!SHA256_REF.test(row.previous_record_hash) || !SHA256_REF.test(row.record_hash)) {
        throw new Error('Scoped Folder traversal persisted page hash is malformed.');
      }
      const sourceCommandRequestId = requireOpaqueId(
        row.source_command_request_id,
        `Scoped Folder traversal page ${expectedOrdinal} source command request ID`
      );
      if (row.previous_record_hash !== previousRecordHash) {
        throw new Error('Scoped Folder traversal previous page hash is invalid.');
      }
      const parsedEntry = parseCanonicalScopedFolderTraversalJson(
        row.body_json,
        `page ${expectedOrdinal} body`
      );
      const expectedRecordHash = scopedFolderTraversalPersistenceHash({
        schema: SCOPED_FOLDER_TRAVERSAL_SQLITE_PAGE_SCHEMA,
        runId,
        ordinal: expectedOrdinal,
        previousRecordHash,
        sourceCommandRequestId,
        entry: parsedEntry,
      });
      if (row.record_hash !== expectedRecordHash) {
        throw new Error(`Scoped Folder traversal page ${expectedOrdinal} record hash is invalid.`);
      }
      entries.push(parsedEntry);
      previousRecordHash = row.record_hash;
    }
    if (
      !SHA256_REF.test(header.head_record_hash) ||
      header.head_record_hash !== previousRecordHash
    ) {
      throw new Error('Scoped Folder traversal persisted head hash is invalid.');
    }
    return {
      journal: {
        ...normalizedHeader,
        entries,
      } as ScopedFolderTraversalJournal,
      head: Object.freeze({ pageCount: rows.length, recordHash: previousRecordHash }),
    };
  }

  private semanticReplayScopedFolderTraversalJournal(
    journal: ScopedFolderTraversalJournal | unknown
  ): ScopedFolderTraversalJournal {
    this.instrumentation.onScopedFolderTraversalSemanticReplay?.();
    return validateAndNormalizeDurableScopedFolderTraversalJournal(journal);
  }

  private initialize(): void {
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS migration_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS migration_run (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL,
        body_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS migration_telemetry_attempt (
        attempt_id TEXT PRIMARY KEY,
        terminal_event_id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL,
        source_attempt_reference TEXT NOT NULL,
        attempt_sequence INTEGER NOT NULL CHECK (attempt_sequence > 0),
        operation TEXT NOT NULL CHECK (
          operation IN ('initial_import', 'linked_item_recovery', 'workspace_append')
        ),
        started_at TEXT NOT NULL,
        body_json TEXT NOT NULL CHECK (json_valid(body_json)),
        FOREIGN KEY (run_id) REFERENCES migration_run(id),
        UNIQUE (run_id, source_attempt_reference),
        UNIQUE (run_id, attempt_sequence)
      );

      CREATE INDEX IF NOT EXISTS idx_migration_telemetry_attempt_run_operation
        ON migration_telemetry_attempt(run_id, operation, attempt_sequence);

      CREATE TABLE IF NOT EXISTS migration_telemetry_acceptance (
        attempt_id TEXT PRIMARY KEY,
        body_json TEXT NOT NULL CHECK (json_valid(body_json)),
        FOREIGN KEY (attempt_id) REFERENCES migration_telemetry_attempt(attempt_id)
      );

      CREATE TABLE IF NOT EXISTS migration_telemetry_terminal_receipt (
        attempt_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        terminal_event_id TEXT NOT NULL UNIQUE,
        terminal_at TEXT NOT NULL,
        body_json TEXT NOT NULL CHECK (json_valid(body_json)),
        FOREIGN KEY (attempt_id) REFERENCES migration_telemetry_attempt(attempt_id),
        FOREIGN KEY (run_id) REFERENCES migration_run(id)
      );

      CREATE INDEX IF NOT EXISTS idx_migration_telemetry_terminal_run
        ON migration_telemetry_terminal_receipt(run_id, terminal_at);

      CREATE TABLE IF NOT EXISTS snapshot_part (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        body_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_snapshot_part_run_source_job
        ON snapshot_part (run_id, json_extract(body_json, '$.sourceJobId'))
        WHERE json_type(body_json, '$.sourceJobId') = 'text';

      CREATE INDEX IF NOT EXISTS idx_snapshot_part_run_supersedes
        ON snapshot_part (run_id, json_extract(body_json, '$.supersedesPartId'))
        WHERE json_type(body_json, '$.supersedesPartId') = 'text';

      CREATE TABLE IF NOT EXISTS source_snapshot (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE,
        account_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        body_json TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES migration_run(id)
      );

      CREATE TABLE IF NOT EXISTS export_job (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        match_signature TEXT NOT NULL,
        state TEXT NOT NULL,
        submitted_at TEXT,
        attempts INTEGER NOT NULL,
        body_json TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES migration_run(id)
      );

      CREATE INDEX IF NOT EXISTS idx_export_job_run_signature_state
        ON export_job (run_id, match_signature, state);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_export_job_unique_pending_signature
        ON export_job (run_id, match_signature)
        WHERE state IN ('submitted', 'receipt_pending', 'receipt_matched', 'downloading');

      CREATE TABLE IF NOT EXISTS gmail_receipt_inference (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        body_json TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES migration_run(id)
      );

      CREATE TABLE IF NOT EXISTS gmail_receipt_confirmation (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        body_json TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES migration_run(id)
      );

      CREATE TABLE IF NOT EXISTS source_object (
        run_id TEXT NOT NULL,
        source_object_id TEXT NOT NULL,
        body_json TEXT NOT NULL,
        PRIMARY KEY (run_id, source_object_id)
      );

      CREATE TABLE IF NOT EXISTS import_decision (
        run_id TEXT NOT NULL,
        action_id TEXT NOT NULL,
        decision_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (
          kind IN (
            'provider_version_conflict',
            'unbound_exact_match',
            'structural_path_conflict',
            'registry_table_mapping'
          )
        ),
        body_json TEXT NOT NULL CHECK (json_valid(body_json)),
        PRIMARY KEY (run_id, action_id, decision_key),
        FOREIGN KEY (run_id) REFERENCES migration_run(id)
      );

      CREATE INDEX IF NOT EXISTS idx_import_decision_action
        ON import_decision (run_id, action_id, kind, decision_key);

      CREATE TABLE IF NOT EXISTS linked_item_recovery_attempt (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        body_json TEXT NOT NULL CHECK (json_valid(body_json)),
        FOREIGN KEY (run_id) REFERENCES migration_run(id)
      );

      CREATE INDEX IF NOT EXISTS idx_linked_item_recovery_attempt_run
        ON linked_item_recovery_attempt (run_id);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_linked_item_recovery_one_active_attempt
        ON linked_item_recovery_attempt (run_id)
        WHERE state IN (
          'copying',
          'parsing',
          'awaiting_conflict_resolution',
          'reconciling',
          'validating'
        );

      CREATE TABLE IF NOT EXISTS linked_item_recovery_artifact (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        body_json TEXT NOT NULL CHECK (json_valid(body_json)),
        FOREIGN KEY (run_id) REFERENCES migration_run(id),
        FOREIGN KEY (attempt_id) REFERENCES linked_item_recovery_attempt(id),
        UNIQUE (run_id, sha256)
      );

      CREATE INDEX IF NOT EXISTS idx_linked_item_recovery_artifact_attempt
        ON linked_item_recovery_artifact (run_id, attempt_id);

      CREATE TABLE IF NOT EXISTS linked_item_recovery_capture (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        source_object_id TEXT NOT NULL,
        snapshot_part_id TEXT NOT NULL,
        body_json TEXT NOT NULL CHECK (json_valid(body_json)),
        FOREIGN KEY (run_id) REFERENCES migration_run(id),
        FOREIGN KEY (attempt_id) REFERENCES linked_item_recovery_attempt(id),
        FOREIGN KEY (artifact_id) REFERENCES linked_item_recovery_artifact(id),
        UNIQUE (run_id, attempt_id, artifact_id, source_object_id),
        UNIQUE (run_id, attempt_id, snapshot_part_id)
      );

      CREATE INDEX IF NOT EXISTS idx_linked_item_recovery_capture_attempt
        ON linked_item_recovery_capture (run_id, attempt_id);

      CREATE TABLE IF NOT EXISTS workspace_append_hierarchy_capture (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        artifact_sha256 TEXT NOT NULL,
        body_json TEXT NOT NULL CHECK (json_valid(body_json)),
        FOREIGN KEY (run_id) REFERENCES migration_run(id),
        FOREIGN KEY (attempt_id) REFERENCES linked_item_recovery_attempt(id),
        FOREIGN KEY (artifact_id) REFERENCES linked_item_recovery_artifact(id),
        UNIQUE (run_id, artifact_id)
      );

      CREATE INDEX IF NOT EXISTS idx_workspace_append_hierarchy_attempt
        ON workspace_append_hierarchy_capture (run_id, attempt_id);

      CREATE TABLE IF NOT EXISTS export_capture (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        body_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS export_inspection (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        body_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS export_job_replacement (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        body_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS export_job_replacement_edge (
        run_id TEXT NOT NULL,
        replacement_job_id TEXT NOT NULL,
        failed_job_id TEXT NOT NULL,
        PRIMARY KEY (run_id, replacement_job_id)
      );

      CREATE INDEX IF NOT EXISTS idx_export_job_replacement_edge_failed
        ON export_job_replacement_edge (run_id, failed_job_id);

      CREATE TABLE IF NOT EXISTS export_job_failure (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        body_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS source_object_version (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        body_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_source_object_version_run_source_job
        ON source_object_version (run_id, json_extract(body_json, '$.sourceJobId'))
        WHERE json_type(body_json, '$.sourceJobId') = 'text';

      CREATE INDEX IF NOT EXISTS idx_source_object_version_run_source_object
        ON source_object_version (run_id, json_extract(body_json, '$.sourceObjectId'))
        WHERE json_type(body_json, '$.sourceObjectId') = 'text';

      CREATE TABLE IF NOT EXISTS relationship_resolution (
        run_id TEXT NOT NULL,
        relationship_id TEXT NOT NULL,
        body_json TEXT NOT NULL,
        PRIMARY KEY (run_id, relationship_id)
      );

      CREATE TABLE IF NOT EXISTS projection_receipt (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        source_object_id TEXT NOT NULL,
        destination_object_id TEXT NOT NULL,
        body_json TEXT NOT NULL,
        UNIQUE (run_id, source_object_id)
      );

      CREATE TABLE IF NOT EXISTS projection_receipt_revision (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        source_object_id TEXT NOT NULL,
        destination_object_id TEXT NOT NULL,
        supersedes_receipt_id TEXT NOT NULL UNIQUE,
        body_json TEXT NOT NULL CHECK (json_valid(body_json))
      );

      CREATE INDEX IF NOT EXISTS idx_projection_receipt_revision_run_source
        ON projection_receipt_revision (run_id, source_object_id);

      CREATE TABLE IF NOT EXISTS projection_source_blob (
        sha256 TEXT PRIMARY KEY,
        body_json TEXT NOT NULL CHECK(json_valid(body_json))
      );
      CREATE TABLE IF NOT EXISTS projection_receipt_source (
        receipt_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        source_object_id TEXT NOT NULL,
        sha256 TEXT NOT NULL REFERENCES projection_source_blob(sha256)
      );

      CREATE TABLE IF NOT EXISTS validation_report (
        run_id TEXT PRIMARY KEY,
        passed INTEGER NOT NULL,
        body_json TEXT NOT NULL,
        generated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS request_ledger (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        body_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS provider_task_evidence (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        body_json TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES migration_run(id)
      );

      CREATE INDEX IF NOT EXISTS idx_provider_task_evidence_run
        ON provider_task_evidence (run_id);

      CREATE TABLE IF NOT EXISTS provider_activity_evidence (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        body_json TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES migration_run(id)
      );

      CREATE INDEX IF NOT EXISTS idx_provider_activity_evidence_run
        ON provider_activity_evidence (run_id);

      CREATE TABLE IF NOT EXISTS provider_command_journal (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        body_json TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES migration_run(id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_command_journal_request
        ON provider_command_journal (run_id, json_extract(body_json, '$.commandRequestId'));

      CREATE TABLE IF NOT EXISTS scoped_folder_command_mutation_clock (
        run_id TEXT PRIMARY KEY,
        generation INTEGER NOT NULL CHECK (generation >= 0)
      );

      CREATE TABLE IF NOT EXISTS native_export_reconciliation (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        body_json TEXT NOT NULL CHECK (json_valid(body_json)),
        FOREIGN KEY (run_id) REFERENCES migration_run(id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_native_export_reconciliation_command
        ON native_export_reconciliation
          (run_id, json_extract(body_json, '$.reconciliationCommandRequestId'));

      CREATE TABLE IF NOT EXISTS native_export_download_acceptance (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        body_json TEXT NOT NULL CHECK (json_valid(body_json)),
        FOREIGN KEY (run_id) REFERENCES migration_run(id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_native_export_download_acceptance_command
        ON native_export_download_acceptance
          (run_id, json_extract(body_json, '$.downloadCommandRequestId'));

      CREATE TABLE IF NOT EXISTS scoped_folder_traversal_header (
        run_id TEXT PRIMARY KEY,
        body_json TEXT NOT NULL CHECK (json_valid(body_json)),
        header_hash TEXT NOT NULL,
        page_count INTEGER NOT NULL CHECK (page_count >= 0),
        head_record_hash TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES migration_run(id)
      );

      CREATE TABLE IF NOT EXISTS scoped_folder_traversal_mutation_clock (
        run_id TEXT PRIMARY KEY,
        generation INTEGER NOT NULL CHECK (generation >= 0)
      );

      CREATE TABLE IF NOT EXISTS scoped_folder_traversal_page (
        run_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        source_command_request_id TEXT NOT NULL,
        previous_record_hash TEXT NOT NULL,
        record_hash TEXT NOT NULL,
        body_json TEXT NOT NULL CHECK (json_valid(body_json)),
        PRIMARY KEY (run_id, ordinal),
        UNIQUE (run_id, record_hash),
        UNIQUE (run_id, source_command_request_id),
        FOREIGN KEY (run_id) REFERENCES scoped_folder_traversal_header(run_id)
      );

      CREATE TABLE IF NOT EXISTS direct_folder_capture_plan (
        run_id TEXT PRIMARY KEY,
        plan_digest TEXT NOT NULL UNIQUE,
        traversal_journal_digest TEXT NOT NULL,
        body_json TEXT NOT NULL CHECK (json_valid(body_json)),
        FOREIGN KEY (run_id) REFERENCES migration_run(id)
      );

      CREATE TABLE IF NOT EXISTS folder_tree_capture_plan (
        run_id TEXT PRIMARY KEY,
        plan_digest TEXT NOT NULL UNIQUE,
        traversal_journal_digest TEXT NOT NULL,
        body_json TEXT NOT NULL CHECK (json_valid(body_json)),
        FOREIGN KEY (run_id) REFERENCES migration_run(id)
      );
    `);
    const decisionTable = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'import_decision'")
      .get() as { sql: string };
    if (!decisionTable.sql.includes("'registry_table_mapping'")) {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE import_decision_v2 (
            run_id TEXT NOT NULL, action_id TEXT NOT NULL, decision_key TEXT NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN (
              'provider_version_conflict', 'unbound_exact_match', 'structural_path_conflict', 'registry_table_mapping'
            )),
            body_json TEXT NOT NULL CHECK(json_valid(body_json)),
            PRIMARY KEY(run_id, action_id, decision_key),
            FOREIGN KEY(run_id) REFERENCES migration_run(id)
          );
          INSERT INTO import_decision_v2 (run_id, action_id, decision_key, kind, body_json)
            SELECT run_id, action_id, decision_key, kind, body_json FROM import_decision;
          DROP TABLE import_decision;
          ALTER TABLE import_decision_v2 RENAME TO import_decision;
          CREATE INDEX idx_import_decision_action
            ON import_decision (run_id, action_id, kind, decision_key);
        `);
        const violations = this.db.pragma('foreign_key_check(import_decision)');
        if (!Array.isArray(violations) || violations.length !== 0) {
          throw new Error('Import decision upgrade failed its reference check.');
        }
      })();
    }
    const scopedPageColumns = this.db
      .prepare('PRAGMA table_info(scoped_folder_traversal_page)')
      .all() as Array<{ name: string }>;
    if (!scopedPageColumns.some(({ name }) => name === 'source_command_request_id')) {
      this.db.exec(
        'ALTER TABLE scoped_folder_traversal_page ADD COLUMN source_command_request_id TEXT'
      );
    }
    for (const indexName of [
      'idx_provider_activity_command_request',
      'idx_request_ledger_command_request',
    ]) {
      const existing = this.db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get(indexName) as { sql: string | null } | undefined;
      if (existing?.sql && /\bWHERE\b/u.test(existing.sql)) {
        this.db.exec(`DROP INDEX ${indexName}`);
      }
    }
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS scoped_folder_command_clock_nondecreasing
      BEFORE UPDATE ON scoped_folder_command_mutation_clock
      WHEN NEW.run_id <> OLD.run_id OR NEW.generation <= OLD.generation
      BEGIN
        SELECT RAISE(ABORT, 'Scoped Folder command mutation clock must increase monotonically.');
      END;

      CREATE TRIGGER IF NOT EXISTS scoped_folder_command_clock_no_delete
      BEFORE DELETE ON scoped_folder_command_mutation_clock
      BEGIN
        SELECT RAISE(ABORT, 'Scoped Folder command mutation clock is append-only.');
      END;

      CREATE TRIGGER IF NOT EXISTS scoped_folder_command_insert_clock
      AFTER INSERT ON provider_command_journal
      WHEN EXISTS (
        SELECT 1 FROM scoped_folder_traversal_header WHERE run_id = NEW.run_id
      )
      BEGIN
        INSERT INTO scoped_folder_command_mutation_clock (run_id, generation)
        VALUES (NEW.run_id, 1)
        ON CONFLICT(run_id) DO UPDATE SET generation = generation + 1;
      END;

      CREATE TRIGGER IF NOT EXISTS scoped_folder_command_update_clock
      AFTER UPDATE ON provider_command_journal
      WHEN EXISTS (
        SELECT 1 FROM scoped_folder_traversal_header
        WHERE run_id = OLD.run_id OR run_id = NEW.run_id
      )
      BEGIN
        INSERT INTO scoped_folder_command_mutation_clock (run_id, generation)
        VALUES (OLD.run_id, 1)
        ON CONFLICT(run_id) DO UPDATE SET generation = generation + 1;
        INSERT INTO scoped_folder_command_mutation_clock (run_id, generation)
        SELECT NEW.run_id, 1
        WHERE NEW.run_id <> OLD.run_id
        ON CONFLICT(run_id) DO UPDATE SET generation = generation + 1;
      END;

      CREATE TRIGGER IF NOT EXISTS scoped_folder_command_delete_clock
      AFTER DELETE ON provider_command_journal
      WHEN EXISTS (
        SELECT 1 FROM scoped_folder_traversal_header WHERE run_id = OLD.run_id
      )
      BEGIN
        INSERT INTO scoped_folder_command_mutation_clock (run_id, generation)
        VALUES (OLD.run_id, 1)
        ON CONFLICT(run_id) DO UPDATE SET generation = generation + 1;
      END;

      CREATE TRIGGER IF NOT EXISTS scoped_folder_activity_insert_clock
      AFTER INSERT ON provider_activity_evidence
      WHEN EXISTS (
        SELECT 1 FROM scoped_folder_traversal_header WHERE run_id = NEW.run_id
      )
      BEGIN
        INSERT INTO scoped_folder_command_mutation_clock (run_id, generation)
        VALUES (NEW.run_id, 1)
        ON CONFLICT(run_id) DO UPDATE SET generation = generation + 1;
      END;

      CREATE TRIGGER IF NOT EXISTS scoped_folder_activity_update_clock
      AFTER UPDATE ON provider_activity_evidence
      WHEN EXISTS (
        SELECT 1 FROM scoped_folder_traversal_header
        WHERE run_id = OLD.run_id OR run_id = NEW.run_id
      )
      BEGIN
        INSERT INTO scoped_folder_command_mutation_clock (run_id, generation)
        VALUES (OLD.run_id, 1)
        ON CONFLICT(run_id) DO UPDATE SET generation = generation + 1;
        INSERT INTO scoped_folder_command_mutation_clock (run_id, generation)
        SELECT NEW.run_id, 1
        WHERE NEW.run_id <> OLD.run_id
        ON CONFLICT(run_id) DO UPDATE SET generation = generation + 1;
      END;

      CREATE TRIGGER IF NOT EXISTS scoped_folder_activity_delete_clock
      AFTER DELETE ON provider_activity_evidence
      WHEN EXISTS (
        SELECT 1 FROM scoped_folder_traversal_header WHERE run_id = OLD.run_id
      )
      BEGIN
        INSERT INTO scoped_folder_command_mutation_clock (run_id, generation)
        VALUES (OLD.run_id, 1)
        ON CONFLICT(run_id) DO UPDATE SET generation = generation + 1;
      END;

      CREATE TRIGGER IF NOT EXISTS scoped_folder_ledger_insert_clock
      AFTER INSERT ON request_ledger
      WHEN EXISTS (
        SELECT 1 FROM scoped_folder_traversal_header WHERE run_id = NEW.run_id
      )
      BEGIN
        INSERT INTO scoped_folder_command_mutation_clock (run_id, generation)
        VALUES (NEW.run_id, 1)
        ON CONFLICT(run_id) DO UPDATE SET generation = generation + 1;
      END;

      CREATE TRIGGER IF NOT EXISTS scoped_folder_ledger_update_clock
      AFTER UPDATE ON request_ledger
      WHEN EXISTS (
        SELECT 1 FROM scoped_folder_traversal_header
        WHERE run_id = OLD.run_id OR run_id = NEW.run_id
      )
      BEGIN
        INSERT INTO scoped_folder_command_mutation_clock (run_id, generation)
        VALUES (OLD.run_id, 1)
        ON CONFLICT(run_id) DO UPDATE SET generation = generation + 1;
        INSERT INTO scoped_folder_command_mutation_clock (run_id, generation)
        SELECT NEW.run_id, 1
        WHERE NEW.run_id <> OLD.run_id
        ON CONFLICT(run_id) DO UPDATE SET generation = generation + 1;
      END;

      CREATE TRIGGER IF NOT EXISTS scoped_folder_ledger_delete_clock
      AFTER DELETE ON request_ledger
      WHEN EXISTS (
        SELECT 1 FROM scoped_folder_traversal_header WHERE run_id = OLD.run_id
      )
      BEGIN
        INSERT INTO scoped_folder_command_mutation_clock (run_id, generation)
        VALUES (OLD.run_id, 1)
        ON CONFLICT(run_id) DO UPDATE SET generation = generation + 1;
      END;

      CREATE TRIGGER IF NOT EXISTS scoped_folder_traversal_clock_nondecreasing
      BEFORE UPDATE ON scoped_folder_traversal_mutation_clock
      WHEN NEW.run_id <> OLD.run_id OR NEW.generation <= OLD.generation
      BEGIN
        SELECT RAISE(ABORT, 'Scoped Folder traversal mutation clock must increase monotonically.');
      END;

      CREATE TRIGGER IF NOT EXISTS scoped_folder_traversal_clock_no_delete
      BEFORE DELETE ON scoped_folder_traversal_mutation_clock
      BEGIN
        SELECT RAISE(ABORT, 'Scoped Folder traversal mutation clock is append-only.');
      END;

      CREATE TRIGGER IF NOT EXISTS scoped_folder_header_insert_clock
      AFTER INSERT ON scoped_folder_traversal_header
      BEGIN
        INSERT INTO scoped_folder_traversal_mutation_clock (run_id, generation)
        VALUES (NEW.run_id, 1)
        ON CONFLICT(run_id) DO UPDATE SET generation = generation + 1;
      END;

      CREATE TRIGGER IF NOT EXISTS scoped_folder_header_update_clock
      AFTER UPDATE ON scoped_folder_traversal_header
      BEGIN
        INSERT INTO scoped_folder_traversal_mutation_clock (run_id, generation)
        VALUES (NEW.run_id, 1)
        ON CONFLICT(run_id) DO UPDATE SET generation = generation + 1;
      END;

      CREATE TRIGGER IF NOT EXISTS scoped_folder_header_update_old_run_clock
      AFTER UPDATE OF run_id ON scoped_folder_traversal_header
      WHEN OLD.run_id <> NEW.run_id
      BEGIN
        INSERT INTO scoped_folder_traversal_mutation_clock (run_id, generation)
        VALUES (OLD.run_id, 1)
        ON CONFLICT(run_id) DO UPDATE SET generation = generation + 1;
      END;

      CREATE TRIGGER IF NOT EXISTS scoped_folder_header_delete_clock
      AFTER DELETE ON scoped_folder_traversal_header
      BEGIN
        INSERT INTO scoped_folder_traversal_mutation_clock (run_id, generation)
        VALUES (OLD.run_id, 1)
        ON CONFLICT(run_id) DO UPDATE SET generation = generation + 1;
      END;

      CREATE TRIGGER IF NOT EXISTS scoped_folder_page_insert_clock
      AFTER INSERT ON scoped_folder_traversal_page
      BEGIN
        INSERT INTO scoped_folder_traversal_mutation_clock (run_id, generation)
        VALUES (NEW.run_id, 1)
        ON CONFLICT(run_id) DO UPDATE SET generation = generation + 1;
      END;

      CREATE TRIGGER IF NOT EXISTS scoped_folder_page_update_clock
      AFTER UPDATE ON scoped_folder_traversal_page
      BEGIN
        INSERT INTO scoped_folder_traversal_mutation_clock (run_id, generation)
        VALUES (NEW.run_id, 1)
        ON CONFLICT(run_id) DO UPDATE SET generation = generation + 1;
      END;

      CREATE TRIGGER IF NOT EXISTS scoped_folder_page_update_old_run_clock
      AFTER UPDATE OF run_id ON scoped_folder_traversal_page
      WHEN OLD.run_id <> NEW.run_id
      BEGIN
        INSERT INTO scoped_folder_traversal_mutation_clock (run_id, generation)
        VALUES (OLD.run_id, 1)
        ON CONFLICT(run_id) DO UPDATE SET generation = generation + 1;
      END;

      CREATE TRIGGER IF NOT EXISTS scoped_folder_page_delete_clock
      AFTER DELETE ON scoped_folder_traversal_page
      BEGIN
        INSERT INTO scoped_folder_traversal_mutation_clock (run_id, generation)
        VALUES (OLD.run_id, 1)
        ON CONFLICT(run_id) DO UPDATE SET generation = generation + 1;
      END;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_scoped_folder_page_source_command
        ON scoped_folder_traversal_page (run_id, source_command_request_id)
        WHERE source_command_request_id IS NOT NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_activity_command_request
        ON provider_activity_evidence
          (run_id, json_extract(body_json, '$.commandRequestId'));

      CREATE UNIQUE INDEX IF NOT EXISTS idx_request_ledger_command_request
        ON request_ledger
          (run_id, json_extract(body_json, '$.commandRequestId'));

      CREATE INDEX IF NOT EXISTS idx_provider_command_scoped_retry
        ON provider_command_journal
          (run_id,
           json_extract(body_json, '$.operationKind'),
           json_extract(body_json, '$.scopedFolderCorrelation.purpose'),
           json_extract(body_json, '$.scopedFolderCorrelation.pageRequestSha256'));

      CREATE INDEX IF NOT EXISTS idx_provider_command_scoped_epoch
        ON provider_command_journal
          (run_id,
           json_extract(body_json, '$.operationKind'),
           json_extract(body_json, '$.scopedFolderCorrelation.receiptEpoch'));
    `);
    this.db.exec(`
      DROP INDEX IF EXISTS idx_linked_item_recovery_one_active_attempt;
      CREATE UNIQUE INDEX idx_linked_item_recovery_one_active_attempt
        ON linked_item_recovery_attempt (run_id)
        WHERE state IN (
          'copying',
          'parsing',
          'awaiting_conflict_resolution',
          'reconciling',
          'validating'
        );

      INSERT INTO scoped_folder_command_mutation_clock (run_id, generation)
      SELECT id, 0
      FROM migration_run
      WHERE true
      ON CONFLICT(run_id) DO NOTHING;

      INSERT INTO scoped_folder_traversal_mutation_clock (run_id, generation)
      SELECT run_id, 0
      FROM scoped_folder_traversal_header
      WHERE true
      ON CONFLICT(run_id) DO NOTHING;
    `);
    const version = this.db
      .prepare("SELECT value FROM migration_meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    const parsedVersion = version === undefined ? null : Number(version.value);
    if (
      parsedVersion !== null &&
      parsedVersion !== 1 &&
      parsedVersion !== PROVIDER_TASK_PRIVACY_SCHEMA_VERSION &&
      parsedVersion !== MIGRATION_SCHEMA_VERSION
    ) {
      throw new Error(
        `Unsupported Benchling migration schema version ${version?.value ?? 'missing'}.`
      );
    }
    const privacyContext = this.buildProviderTaskPrivacyMigrationContext();
    this.sanitizeLegacyMachineValidationReport(privacyContext);
    if (parsedVersion === 1) {
      this.migrateProviderTaskPrivacyV1ToV2(privacyContext);
    } else {
      this.assertPersistedProviderTaskPrivacySafe();
    }
    this.db.transaction(() => {
      const preUpgradeVersion = this.db
        .prepare("SELECT value FROM migration_meta WHERE key = 'schema_version'")
        .get() as { value: string } | undefined;
      if (
        preUpgradeVersion !== undefined &&
        preUpgradeVersion.value !== String(PROVIDER_TASK_PRIVACY_SCHEMA_VERSION) &&
        preUpgradeVersion.value !== String(MIGRATION_SCHEMA_VERSION)
      ) {
        throw new Error(
          `Benchling migration schema v3 cannot upgrade version ${preUpgradeVersion.value}.`
        );
      }
      this.db
        .prepare(
          `INSERT INTO migration_meta (key, value) VALUES ('schema_version', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`
        )
        .run(String(MIGRATION_SCHEMA_VERSION));
      this.db
        .prepare(
          `INSERT INTO migration_meta (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`
        )
        .run(
          PROVIDER_TASK_PRIVACY_MIGRATION_MARKER_KEY,
          PROVIDER_TASK_PRIVACY_MIGRATION_MARKER_VALUE
        );
    })();
    const persistedVersion = this.db
      .prepare("SELECT value FROM migration_meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    const privacyMarker = this.db
      .prepare('SELECT value FROM migration_meta WHERE key = ?')
      .get(PROVIDER_TASK_PRIVACY_MIGRATION_MARKER_KEY) as { value: string } | undefined;
    if (
      persistedVersion?.value !== String(MIGRATION_SCHEMA_VERSION) ||
      privacyMarker?.value !== PROVIDER_TASK_PRIVACY_MIGRATION_MARKER_VALUE
    ) {
      throw new Error('Benchling provider-task privacy migration marker is invalid.');
    }
    this.reconcileExportJobReplacementEdgeIndex();
  }

  private buildProviderTaskPrivacyMigrationContext(): ProviderTaskPrivacyMigrationContext {
    const runs = this.db
      .prepare('SELECT id, body_json FROM migration_run ORDER BY rowid')
      .all() as Array<{ id: string; body_json: string }>;
    const runsById = new Map<string, MigrationRun>();
    for (const row of runs) {
      const run = JSON.parse(row.body_json) as MigrationRun;
      if (run.id !== row.id) {
        throw new Error('Legacy provider-task privacy migration found a mismatched run row.');
      }
      runsById.set(run.id, run);
    }

    const jobs = this.db
      .prepare('SELECT id, run_id, body_json FROM export_job ORDER BY rowid')
      .all() as Array<{ id: string; run_id: string; body_json: string }>;
    const jobsByRunAndId = new Map<string, ExportJob>();
    for (const row of jobs) {
      const job = JSON.parse(row.body_json) as ExportJob;
      if (job.id !== row.id || job.runId !== row.run_id) {
        throw new Error(
          'Legacy provider-task privacy migration found a mismatched export job row.'
        );
      }
      jobsByRunAndId.set(providerTaskPrivacyJobKey(job.runId, job.id), job);
    }

    const authorityDigestHints = new Map<string, string>();
    const nonResumableRunIds = new Set<string>();
    const commandRows = this.providerTaskPrivacyRows(
      providerTaskPrivacyTableDescriptor('provider_command_journal')
    );
    for (const row of commandRows) {
      try {
        collectLegacyProviderTaskAuthorityDigestHints(
          JSON.parse(row.bodyJson),
          row.runId,
          authorityDigestHints
        );
      } catch {
        nonResumableRunIds.add(row.runId);
      }
    }

    const handlesByRunJobAndRawTask = new Map<string, string>();
    const uniqueHandlesByRunAndRawTask = new Map<string, string | null>();
    for (const row of this.providerTaskPrivacyRows(
      providerTaskPrivacyTableDescriptor('provider_task_evidence')
    )) {
      try {
        const record = requireRecord(
          JSON.parse(row.bodyJson),
          'Legacy provider-task privacy evidence'
        );
        if (!Object.prototype.hasOwnProperty.call(record, 'providerTaskId')) continue;
        const rawTask = record.providerTaskId;
        if (rawTask === null) continue;
        if (typeof rawTask !== 'string') {
          throw new Error('Legacy provider-task ID is invalid.');
        }
        const runId = requireProviderTaskPrivacyOpaqueId(record.runId, 'run');
        const jobId = requireProviderTaskPrivacyOpaqueId(record.jobId, 'job');
        const matchSignature = requireProviderTaskPrivacyMatchSignature(record.matchSignature);
        const handle = deriveLegacyProviderTaskHandle({
          rawTask,
          runId,
          jobId,
          matchSignature,
          runsById,
          jobsByRunAndId,
          authorityDigestHints,
        });
        const exactKey = providerTaskPrivacyExactKey(runId, jobId, rawTask);
        const existingExact = handlesByRunJobAndRawTask.get(exactKey);
        if (existingExact !== undefined && existingExact !== handle) {
          throw new Error(
            'Legacy provider-task privacy migration found conflicting exact handles.'
          );
        }
        handlesByRunJobAndRawTask.set(exactKey, handle);
        const rawKey = providerTaskPrivacyRawKey(runId, rawTask);
        const existingUnique = uniqueHandlesByRunAndRawTask.get(rawKey);
        uniqueHandlesByRunAndRawTask.set(
          rawKey,
          existingUnique === undefined || existingUnique === handle ? handle : null
        );
      } catch {
        nonResumableRunIds.add(row.runId);
      }
    }
    return {
      runsById,
      jobsByRunAndId,
      authorityDigestHints,
      handlesByRunJobAndRawTask,
      uniqueHandlesByRunAndRawTask,
      nonResumableRunIds,
    };
  }

  private migrateProviderTaskPrivacyV1ToV2(context: ProviderTaskPrivacyMigrationContext): void {
    const updates = PROVIDER_TASK_PRIVACY_BODY_TABLES.flatMap((descriptor) =>
      this.providerTaskPrivacyRows(descriptor).flatMap((row) => {
        const parsed = JSON.parse(row.bodyJson);
        const migrated = migrateLegacyProviderTaskPrivacyValue(parsed, {
          context,
          runId: row.runId,
          jobId: row.jobId,
        });
        assertProviderTaskPrivacySafe(migrated, `${descriptor.table} migrated record`);
        let bodyJson = JSON.stringify(migrated);
        if (bodyJson === row.bodyJson) return [];
        let replacementId: string | null = null;
        if ('rehashDownloadAcceptance' in descriptor) {
          const rehashed = rehashLegacyNativeExportDownloadAcceptance(migrated);
          assertProviderTaskPrivacySafe(rehashed, `${descriptor.table} migrated record`);
          bodyJson = JSON.stringify(rehashed);
          replacementId = rehashed.id;
        }
        return [{ descriptor, row, bodyJson, replacementId }];
      })
    );
    const nonResumableRuns = [...context.runsById.values()].flatMap((run) => {
      const lacksScopedItemUrlAuthority = legacyRunHasUrlFreeScopedExportAuthority(
        run,
        context.jobsByRunAndId
      );
      if (
        isTerminalMigrationState(run.state) ||
        (!lacksScopedItemUrlAuthority && !context.nonResumableRunIds.has(run.id))
      ) {
        return [];
      }
      const sanitizedRun = migrateLegacyProviderTaskPrivacyValue(run, {
        context,
        runId: run.id,
        jobId: null,
      }) as MigrationRun;
      const privacyCorrelationUnavailable = context.nonResumableRunIds.has(run.id);
      const migrated: MigrationRun = {
        ...sanitizedRun,
        state: 'action_required',
        resumeState: null,
        lastError: {
          code: privacyCorrelationUnavailable
            ? 'provider_retry_exhausted'
            : 'scope_plan_incomplete',
          message: privacyCorrelationUnavailable
            ? 'This preserved migration no longer has a private Chrome task locator that can be resumed safely. Start a new migration run.'
            : 'This preserved migration predates exact item URL authority. Start a new migration run before contacting Benchling again.',
          blocking: true,
          details: {
            reason: privacyCorrelationUnavailable
              ? LEGACY_PROVIDER_TASK_SESSION_LOCATOR_UNAVAILABLE_REASON
              : LEGACY_SCOPED_ITEM_URL_AUTHORITY_UNAVAILABLE_REASON,
            ...(privacyCorrelationUnavailable
              ? {
                  actionRequiredCode: 'provider_task_session_locator_unavailable',
                }
              : {}),
            newRunRequired: true,
          },
        },
      };
      assertProviderTaskPrivacySafe(migrated, 'legacy non-resumable migration run');
      return [migrated];
    });
    this.db.transaction(() => {
      for (const update of updates) {
        const result =
          'rehashDownloadAcceptance' in update.descriptor
            ? this.db
                .prepare(update.descriptor.updateQuery)
                .run(update.replacementId, update.bodyJson, update.row.rowid)
            : this.db.prepare(update.descriptor.updateQuery).run(update.bodyJson, update.row.rowid);
        if (result.changes !== 1) {
          throw new Error(
            `Legacy provider-task privacy migration lost a ${update.descriptor.table} row update.`
          );
        }
      }
      for (const run of nonResumableRuns) {
        const result = this.db
          .prepare(
            `UPDATE migration_run
             SET state = ?, body_json = ?, updated_at = ?
             WHERE singleton = 1 AND id = ?`
          )
          .run(run.state, JSON.stringify(run), run.updatedAt, run.id);
        if (result.changes !== 1) {
          throw new Error('Legacy provider-task privacy migration lost its run update.');
        }
      }
      this.assertPersistedProviderTaskPrivacySafe();
      this.db
        .prepare(
          `UPDATE migration_meta
           SET value = ?
           WHERE key = 'schema_version' AND value = '1'`
        )
        .run(String(PROVIDER_TASK_PRIVACY_SCHEMA_VERSION));
      const version = this.db
        .prepare("SELECT value FROM migration_meta WHERE key = 'schema_version'")
        .get() as { value: string } | undefined;
      if (version?.value !== String(PROVIDER_TASK_PRIVACY_SCHEMA_VERSION)) {
        throw new Error('Legacy provider-task privacy migration version update failed.');
      }
      this.db
        .prepare(
          `INSERT INTO migration_meta (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`
        )
        .run(
          PROVIDER_TASK_PRIVACY_MIGRATION_MARKER_KEY,
          PROVIDER_TASK_PRIVACY_MIGRATION_MARKER_VALUE
        );
    })();
  }

  private sanitizeLegacyMachineValidationReport(
    context: ProviderTaskPrivacyMigrationContext
  ): void {
    if (this.fileBackedPeerKey === null) return;
    const reportPath = join(dirname(this.fileBackedPeerKey), MACHINE_VALIDATION_REPORT_NAME);
    if (!existsSync(reportPath)) return;
    const raw = readFileSync(reportPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    const runId =
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>).runId === 'string'
        ? ((parsed as Record<string, unknown>).runId as string)
        : null;
    const migrated = migrateLegacyProviderTaskPrivacyValue(parsed, {
      context,
      runId,
      jobId: null,
    });
    assertProviderTaskPrivacySafe(migrated, 'machine validation report');
    if (isDeepStrictEqual(parsed, migrated)) return;
    const sanitized = `${JSON.stringify(migrated, null, 2)}\n`;
    if (sanitized === raw) return;
    const temporaryPath = `${reportPath}.provider-task-privacy-v2-${process.pid}.tmp`;
    rmSync(temporaryPath, { force: true });
    try {
      writeFileSync(temporaryPath, sanitized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      renameSync(temporaryPath, reportPath);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }

  private assertPersistedProviderTaskPrivacySafe(): void {
    for (const descriptor of PROVIDER_TASK_PRIVACY_BODY_TABLES) {
      const rows = this.db.prepare(descriptor.scanQuery).all() as Array<{
        body_json: string;
      }>;
      for (const row of rows) {
        assertProviderTaskPrivacySafe(
          JSON.parse(row.body_json),
          `${descriptor.table} persisted record`
        );
      }
    }
  }

  private providerTaskPrivacyRows(
    descriptor: ProviderTaskPrivacyTableDescriptor
  ): ProviderTaskPrivacyJsonRow[] {
    return (
      this.db.prepare(descriptor.migrationQuery).all() as Array<{
        rowid?: number;
        migration_rowid?: number;
        run_id: string;
        job_id: string | null;
        body_json: string;
      }>
    ).map((row) => ({
      rowid: row.migration_rowid ?? row.rowid!,
      runId: row.run_id,
      jobId: row.job_id,
      bodyJson: row.body_json,
    }));
  }

  private hasScopedFolderTraversalHeader(runId: string): boolean {
    return Boolean(
      this.db.prepare('SELECT 1 FROM scoped_folder_traversal_header WHERE run_id = ?').get(runId)
    );
  }

  private hasOrphanedScopedFolderTraversalState(runId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1
           FROM scoped_folder_traversal_mutation_clock
           WHERE run_id = ?
           UNION ALL
           SELECT 1
           FROM scoped_folder_traversal_page
           WHERE run_id = ?
           LIMIT 1`
        )
        .get(runId, runId)
    );
  }

  private registerFileBackedPeer(): void {
    if (!this.fileBackedPeerKey) return;
    const peers = MigrationStore.fileBackedPeers.get(this.fileBackedPeerKey) ?? new Set();
    peers.add(this);
    MigrationStore.fileBackedPeers.set(this.fileBackedPeerKey, peers);
  }

  private unregisterFileBackedPeer(): void {
    if (!this.fileBackedPeerKey) return;
    const peers = MigrationStore.fileBackedPeers.get(this.fileBackedPeerKey);
    if (!peers) return;
    peers.delete(this);
    if (peers.size === 0) MigrationStore.fileBackedPeers.delete(this.fileBackedPeerKey);
  }

  private requireFileBackedPeersAlignedWithScopedFolderHistory(
    prior: ScopedFolderCommandAuditFingerprint
  ): void {
    if (!this.fileBackedPeerKey) return;
    const peers = MigrationStore.fileBackedPeers.get(this.fileBackedPeerKey);
    if (!peers) return;
    for (const peer of peers) {
      if (peer === this || !peer.db.open) continue;
      if (peer.scopedFolderCommandIntegrityFailure) {
        this.scopedFolderCommandIntegrityFailure ??= peer.scopedFolderCommandIntegrityFailure;
        throw this.scopedFolderCommandIntegrityFailure;
      }
      const peerCache = peer.scopedFolderCommandAuditCache;
      if (!peerCache || peerCache.runId !== prior.runId) continue;
      if (!isDeepStrictEqual(scopedFolderCommandAuditFingerprint(peerCache), prior)) {
        const error = new Error(
          `Scoped Folder command history for run ${prior.runId} changed outside the owned write set.`
        );
        peer.scopedFolderCommandIntegrityFailure = error;
        this.scopedFolderCommandIntegrityFailure = error;
        throw error;
      }
    }
  }

  private notifyFileBackedPeersOfOwnedScopedFolderHistoryCommit(
    prior: ScopedFolderCommandAuditFingerprint,
    post: ScopedFolderCommandAuditFingerprint
  ): void {
    if (!this.fileBackedPeerKey || isDeepStrictEqual(prior, post)) return;
    const peers = MigrationStore.fileBackedPeers.get(this.fileBackedPeerKey);
    if (!peers) return;
    for (const peer of peers) {
      if (peer === this || !peer.db.open) continue;
      const peerFailure = peer.adoptFileBackedPeerOwnedScopedFolderHistoryCommit(prior, post);
      if (peerFailure) {
        this.scopedFolderCommandIntegrityFailure ??= peerFailure;
      }
    }
    if (this.scopedFolderCommandIntegrityFailure) {
      throw this.scopedFolderCommandIntegrityFailure;
    }
  }

  private adoptFileBackedPeerOwnedScopedFolderHistoryCommit(
    prior: ScopedFolderCommandAuditFingerprint,
    post: ScopedFolderCommandAuditFingerprint
  ): Error | null {
    if (this.scopedFolderCommandIntegrityFailure) {
      return this.scopedFolderCommandIntegrityFailure;
    }
    const cache = this.scopedFolderCommandAuditCache;
    if (!cache || cache.runId !== prior.runId) return null;
    const cachedFingerprint = scopedFolderCommandAuditFingerprint(cache);
    if (!isDeepStrictEqual(cachedFingerprint, prior)) {
      this.scopedFolderCommandIntegrityFailure = new Error(
        `Scoped Folder command history for run ${prior.runId} changed outside the owned write set.`
      );
      return this.scopedFolderCommandIntegrityFailure;
    }
    try {
      this.instrumentation.onFileBackedPeerAdoptionAudit?.();
      const auditedDataVersion = this.db
        .transaction(() => {
          const mutationGeneration = this.readScopedFolderCommandMutationGeneration(prior.runId);
          const dataVersion = this.readSqliteDataVersion();
          const audit = this.auditScopedFolderCommandSettlementHistory(prior.runId);
          const verifiedMutationGeneration = this.readScopedFolderCommandMutationGeneration(
            prior.runId
          );
          const verifiedDataVersion = this.readSqliteDataVersion();
          if (
            mutationGeneration !== post.mutationGeneration ||
            dataVersion === cache.dataVersion ||
            verifiedMutationGeneration !== mutationGeneration ||
            verifiedDataVersion !== dataVersion ||
            !scopedFolderCommandAuditMatchesCache(audit, {
              ...post,
              dataVersion,
            })
          ) {
            throw new Error(
              `Scoped Folder command history for run ${prior.runId} changed outside the owned write set.`
            );
          }
          return verifiedDataVersion;
        })
        .immediate();
      Object.assign(cache, post, { dataVersion: auditedDataVersion });
    } catch (error) {
      this.scopedFolderCommandIntegrityFailure = asError(error);
    }
    return this.scopedFolderCommandIntegrityFailure;
  }

  private appendOwnedScopedFolderHistoryRecord(
    table: 'provider_command_journal' | 'provider_activity_evidence' | 'request_ledger',
    id: string,
    runId: string,
    value: unknown
  ): void {
    const append = this.db.transaction(() => {
      const cache = this.requireScopedFolderCommandAuditCache(runId);
      const priorCacheFingerprint = scopedFolderCommandAuditFingerprint(cache);
      this.requireFileBackedPeersAlignedWithScopedFolderHistory(priorCacheFingerprint);
      const existing = this.db
        .prepare(
          `SELECT rowid, id, run_id, body_json
           FROM ${table}
           WHERE id = ?`
        )
        .get(id) as ScopedFolderCommandHistoryRow | undefined;
      this.appendImmutableJson(table, id, runId, value);
      const mutationGeneration = this.requireOwnedScopedFolderCommandMutationAdvance(
        runId,
        cache.mutationGeneration,
        existing ? 0 : 1
      );
      const insertedRow = !existing
        ? (this.db
            .prepare(
              `SELECT rowid, id, run_id, body_json
                 FROM ${table}
                 WHERE id = ?`
            )
            .get(id) as ScopedFolderCommandHistoryRow | undefined)
        : null;
      if (!existing && !insertedRow) {
        throw new Error('Owned protected-history append was not durably visible.');
      }
      const commandHistoryAdvance =
        table === 'provider_command_journal' && insertedRow
          ? advanceScopedFolderCommandHistoryCache(cache, insertedRow)
          : null;
      const activityHistoryAdvance =
        table === 'provider_activity_evidence' && insertedRow
          ? advanceScopedFolderProtectedHistoryCache({
              schema: SCOPED_FOLDER_ACTIVITY_HISTORY_SCHEMA,
              runId: cache.runId,
              rowCount: cache.activityRowCount,
              historyDigest: cache.activityHistoryDigest,
              lastRowId: cache.lastActivityRowId,
              row: insertedRow,
            })
          : null;
      const requestLedgerHistoryAdvance =
        table === 'request_ledger' && insertedRow
          ? advanceScopedFolderProtectedHistoryCache({
              schema: SCOPED_FOLDER_REQUEST_LEDGER_HISTORY_SCHEMA,
              runId: cache.runId,
              rowCount: cache.requestLedgerRowCount,
              historyDigest: cache.requestLedgerHistoryDigest,
              lastRowId: cache.lastRequestLedgerRowId,
              row: insertedRow,
            })
          : null;
      return {
        cache,
        priorCacheFingerprint,
        mutationGeneration,
        commandHistoryAdvance,
        activityHistoryAdvance,
        requestLedgerHistoryAdvance,
      };
    });
    const committed = append.immediate();
    if (this.scopedFolderCommandAuditCache === committed.cache) {
      committed.cache.mutationGeneration = committed.mutationGeneration;
      if (committed.commandHistoryAdvance) {
        committed.cache.commandRowCount = committed.commandHistoryAdvance.commandRowCount;
        committed.cache.commandHistoryDigest = committed.commandHistoryAdvance.commandHistoryDigest;
        committed.cache.lastCommandRowId = committed.commandHistoryAdvance.lastCommandRowId;
      }
      if (committed.activityHistoryAdvance) {
        committed.cache.activityRowCount = committed.activityHistoryAdvance.rowCount;
        committed.cache.activityHistoryDigest = committed.activityHistoryAdvance.historyDigest;
        committed.cache.lastActivityRowId = committed.activityHistoryAdvance.lastRowId;
      }
      if (committed.requestLedgerHistoryAdvance) {
        committed.cache.requestLedgerRowCount = committed.requestLedgerHistoryAdvance.rowCount;
        committed.cache.requestLedgerHistoryDigest =
          committed.requestLedgerHistoryAdvance.historyDigest;
        committed.cache.lastRequestLedgerRowId = committed.requestLedgerHistoryAdvance.lastRowId;
      }
      this.notifyFileBackedPeersOfOwnedScopedFolderHistoryCommit(
        committed.priorCacheFingerprint,
        scopedFolderCommandAuditFingerprint(committed.cache)
      );
    }
  }

  private appendImmutableJson(table: string, id: string, runId: string, value: unknown): void {
    if (table !== 'source_object' && table !== 'source_object_version') {
      assertProviderTaskPrivacySafe(value, `${table} record`);
    }
    const body = JSON.stringify(value);
    const existing = this.db.prepare(`SELECT body_json FROM ${table} WHERE id = ?`).get(id) as
      | { body_json: string }
      | undefined;
    if (existing) {
      if (existing.body_json === body) return;
      throw new Error(`Immutable migration record ${table}/${id} already exists.`);
    }
    this.db
      .prepare(`INSERT INTO ${table} (id, run_id, body_json) VALUES (?, ?, ?)`)
      .run(id, runId, body);
  }

  private listJson<T>(table: string, runId: string): T[] {
    const rows = this.db
      .prepare(`SELECT body_json FROM ${table} WHERE run_id = ? ORDER BY rowid`)
      .all(runId) as Array<{ body_json: string }>;
    return rows.map((row) => JSON.parse(row.body_json) as T);
  }

  private appendExportJobReplacementEdges(replacement: PersistedExportJobReplacement): void {
    for (const replacementJobId of replacement.replacementJobIds) {
      const existing = this.db
        .prepare(
          `SELECT run_id, replacement_job_id, failed_job_id
           FROM export_job_replacement_edge
           WHERE run_id = ? AND replacement_job_id = ?`
        )
        .get(replacement.runId, replacementJobId) as ExportJobReplacementEdgeSqliteRow | undefined;
      if (existing) {
        if (
          existing.run_id !== replacement.runId ||
          existing.replacement_job_id !== replacementJobId ||
          existing.failed_job_id !== replacement.failedJobId
        ) {
          throw new Error(`Export replacement edge ${replacementJobId} conflicts with its parent.`);
        }
        continue;
      }
      this.db
        .prepare(
          `INSERT INTO export_job_replacement_edge
             (run_id, replacement_job_id, failed_job_id)
           VALUES (?, ?, ?)`
        )
        .run(replacement.runId, replacementJobId, replacement.failedJobId);
    }
  }

  private reconcileExportJobReplacementEdgeIndex(): void {
    const reconcile = this.db.transaction(() => {
      const replacementRows = this.db
        .prepare(
          `SELECT id, run_id, body_json
           FROM export_job_replacement
           ORDER BY rowid`
        )
        .all() as ExportJobReplacementSqliteRow[];
      const expectedParentByEdge = new Map<string, string>();
      const replacements: PersistedExportJobReplacement[] = [];
      for (const row of replacementRows) {
        const replacement = this.parseCorrelatedExportJobReplacementRow(row);
        replacements.push(replacement);
        for (const replacementJobId of replacement.replacementJobIds) {
          const key = `${replacement.runId}\0${replacementJobId}`;
          const existingParent = expectedParentByEdge.get(key);
          if (existingParent && existingParent !== replacement.failedJobId) {
            throw new Error(`Export replacement edge ${replacementJobId} has multiple parents.`);
          }
          expectedParentByEdge.set(key, replacement.failedJobId);
        }
      }

      const edgeRows = this.db
        .prepare(
          `SELECT run_id, replacement_job_id, failed_job_id
           FROM export_job_replacement_edge
           ORDER BY run_id, replacement_job_id`
        )
        .all() as ExportJobReplacementEdgeSqliteRow[];
      for (const edge of edgeRows) {
        const expectedParent = expectedParentByEdge.get(
          `${edge.run_id}\0${edge.replacement_job_id}`
        );
        if (!expectedParent || expectedParent !== edge.failed_job_id) {
          throw new Error(
            `Export replacement edge ${edge.replacement_job_id} is not backed by immutable lineage.`
          );
        }
      }
      for (const replacement of replacements) {
        this.appendExportJobReplacementEdges(replacement);
      }
    });
    reconcile.immediate();
  }

  private recordCapturePersistenceQuery(
    kind: CapturePersistenceQueryKind,
    returnedRowCount: number
  ): void {
    this.instrumentation.onCapturePersistenceQuery?.(kind, returnedRowCount);
  }

  private parseCorrelatedSnapshotPartRow(
    row: ImmutableJsonSqliteRow,
    expectedRunId: string,
    expectedSourceJobId?: string
  ): SourceSnapshotPart {
    const part = JSON.parse(row.body_json) as SourceSnapshotPart;
    assertValidSnapshotPart(part);
    if (
      row.id !== part.id ||
      row.run_id !== expectedRunId ||
      (expectedSourceJobId !== undefined && part.sourceJobId !== expectedSourceJobId)
    ) {
      throw new Error(`Snapshot part ${row.id} SQLite correlation is invalid.`);
    }
    return part;
  }

  private parseCorrelatedSourceObjectVersionRow(
    row: ImmutableJsonSqliteRow,
    expectedRunId: string
  ): PersistedSourceObjectVersion {
    const version: unknown = JSON.parse(row.body_json);
    assertValidPersistedSourceObjectVersion(version);
    if (row.id !== version.id || row.run_id !== expectedRunId || version.runId !== expectedRunId) {
      throw new Error(`Source object version ${row.id} SQLite correlation is invalid.`);
    }
    return version;
  }

  private readSourceObjectVersionsByJsonIdentity(
    runId: string,
    jsonPath: '$.sourceJobId' | '$.sourceObjectId',
    identity: string,
    queryKind: 'source_versions_by_export_job' | 'source_versions_by_source_object'
  ): PersistedSourceObjectVersion[] {
    const rows = this.db
      .prepare(
        `SELECT id, run_id, body_json
         FROM source_object_version
         WHERE run_id = ?
           AND json_type(body_json, '${jsonPath}') = 'text'
           AND json_extract(body_json, '${jsonPath}') = ?
         ORDER BY rowid`
      )
      .all(runId, identity) as ImmutableJsonSqliteRow[];
    this.recordCapturePersistenceQuery(queryKind, rows.length);
    return rows
      .map((row) => this.parseCorrelatedSourceObjectVersionRow(row, runId))
      .map((version) => {
        const persistedIdentity =
          jsonPath === '$.sourceJobId' ? version.sourceJobId : version.sourceObjectId;
        if (persistedIdentity !== identity) {
          throw new Error(`Source object version ${version.id} indexed identity is invalid.`);
        }
        return version;
      })
      .sort(compareSourceObjectVersions);
  }

  private listExportJobReplacementsForFailedJobIds(
    runId: string,
    failedJobIds: readonly string[]
  ): PersistedExportJobReplacement[] {
    const uniqueIds = [...new Set(failedJobIds)].sort();
    if (uniqueIds.length === 0) {
      this.recordCapturePersistenceQuery('export_replacements_by_failed_job', 0);
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT id, run_id, body_json
         FROM export_job_replacement
         WHERE run_id = ?
           AND id IN (SELECT value FROM json_each(?))
         ORDER BY rowid`
      )
      .all(runId, JSON.stringify(uniqueIds)) as ExportJobReplacementSqliteRow[];
    this.recordCapturePersistenceQuery('export_replacements_by_failed_job', rows.length);
    if (rows.length === 0) return [];
    const run = this.getRun();
    if (!run || run.id !== runId) {
      throw new Error(`Export replacements are not bound to migration run ${runId}.`);
    }
    const index = this.requireExportJobWriteIndex(run);
    const allowedIds = new Set(uniqueIds);
    return rows.map((row) => {
      const replacement = this.parseCorrelatedExportJobReplacementRow(row);
      if (!allowedIds.has(replacement.failedJobId)) {
        throw new Error(
          `Export replacement ${replacement.failedJobId} indexed identity is invalid.`
        );
      }
      this.assertExportJobReplacementAuthority(replacement, index.context);
      return replacement;
    });
  }

  private requireExportJobWriteIndex(run: MigrationRun): ExportJobWriteIndex {
    if (this.exportJobWriteIndex?.runId === run.id) return this.exportJobWriteIndex;
    const jobs = this.listRawExportJobs(run.id);
    const context = this.createExportJobValidationContext(run, jobs);
    for (const job of jobs) this.assertDirectFolderExportAuthority(job, context);
    return this.installExportJobWriteIndex(context);
  }

  private installExportJobWriteIndex(context: ExportJobValidationContext): ExportJobWriteIndex {
    const index = this.buildExportJobWriteIndex(context);
    this.exportJobWriteIndex = index;
    return index;
  }

  private buildExportJobWriteIndex(context: ExportJobValidationContext): ExportJobWriteIndex {
    const index: ExportJobWriteIndex = {
      runId: context.run.id,
      context,
      pendingJobIds: new Set(),
      pendingJobIdBySignature: new Map(),
      pendingJobIdByReceiptKey: new Map(),
    };
    for (const job of context.jobsById.values()) {
      if (!PENDING_EXPORT_JOB_STATES.has(job.state)) continue;
      const signatureOwner = index.pendingJobIdBySignature.get(job.matchSignature);
      if (signatureOwner) {
        throw new Error(
          `Export job ${signatureOwner} already has pending match signature ${job.matchSignature}.`
        );
      }
      const receiptKey = observableReceiptMatchKey(job);
      const receiptKeyOwner = index.pendingJobIdByReceiptKey.get(receiptKey);
      if (receiptKeyOwner) {
        throw new Error(
          `Export job ${receiptKeyOwner} already has pending observable receipt match key ${receiptKey}.`
        );
      }
      index.pendingJobIds.add(job.id);
      index.pendingJobIdBySignature.set(job.matchSignature, job.id);
      index.pendingJobIdByReceiptKey.set(receiptKey, job.id);
    }
    if (index.pendingJobIds.size > 2) {
      throw new Error('A migration run may persist at most two pending remote export jobs.');
    }
    return index;
  }

  private assertPendingExportJobIndexConstraints(job: ExportJob, index: ExportJobWriteIndex): void {
    if (!PENDING_EXPORT_JOB_STATES.has(job.state)) return;
    const signatureOwner = index.pendingJobIdBySignature.get(job.matchSignature);
    if (signatureOwner && signatureOwner !== job.id) {
      throw new Error(
        `Export job ${signatureOwner} already has pending match signature ${job.matchSignature}.`
      );
    }
    const receiptKey = observableReceiptMatchKey(job);
    const receiptKeyOwner = index.pendingJobIdByReceiptKey.get(receiptKey);
    if (receiptKeyOwner && receiptKeyOwner !== job.id) {
      throw new Error(
        `Export job ${receiptKeyOwner} already has pending observable receipt match key ${receiptKey}.`
      );
    }
    const existing = index.context.jobsById.get(job.id);
    const pendingOtherCount =
      index.pendingJobIds.size -
      (existing && PENDING_EXPORT_JOB_STATES.has(existing.state) ? 1 : 0);
    if (pendingOtherCount >= 2) {
      throw new Error('A migration run may persist at most two pending remote export jobs.');
    }
  }

  private assertExportJobTargetRowMatchesIndex(index: ExportJobWriteIndex, jobId: string): void {
    const row = this.db
      .prepare(
        `SELECT id, run_id, match_signature, state, submitted_at, attempts, body_json
         FROM export_job
         WHERE id = ?`
      )
      .get(jobId) as ExportJobSqliteRow | undefined;
    const cached = index.context.jobsById.get(jobId);
    if (!row && !cached) return;
    if (!row || !cached) {
      this.exportJobWriteIndex = null;
      throw new Error(`Export job ${jobId} changed after inventory validation.`);
    }
    const persisted = this.parseCorrelatedExportJobRow(row);
    if (!isDeepStrictEqual(persisted, cached)) {
      this.exportJobWriteIndex = null;
      throw new Error(`Export job ${jobId} changed after inventory validation.`);
    }
  }

  private updateExportJobWriteIndex(index: ExportJobWriteIndex, job: ExportJob): void {
    const existing = index.context.jobsById.get(job.id);
    if (existing && PENDING_EXPORT_JOB_STATES.has(existing.state)) {
      index.pendingJobIds.delete(existing.id);
      if (index.pendingJobIdBySignature.get(existing.matchSignature) === existing.id) {
        index.pendingJobIdBySignature.delete(existing.matchSignature);
      }
      const existingReceiptKey = observableReceiptMatchKey(existing);
      if (index.pendingJobIdByReceiptKey.get(existingReceiptKey) === existing.id) {
        index.pendingJobIdByReceiptKey.delete(existingReceiptKey);
      }
    }

    index.context.jobsById.set(job.id, job);
    if (job.directFolderAuthority) index.context.directFolderAuthorizedJobIds.add(job.id);
    if (job.folderTreeAuthority) index.context.folderTreeAuthorizedJobIds.add(job.id);
    if (!PENDING_EXPORT_JOB_STATES.has(job.state)) return;
    index.pendingJobIds.add(job.id);
    index.pendingJobIdBySignature.set(job.matchSignature, job.id);
    index.pendingJobIdByReceiptKey.set(observableReceiptMatchKey(job), job.id);
  }

  private updateExportJobFailureWriteIndex(failure: PersistedExportJobFailure): void {
    const index = this.exportJobWriteIndex;
    if (!index || index.runId !== failure.runId) return;
    index.context.failuresByJobId.set(failure.jobId, failure);
    const failed = index.context.jobsById.get(failure.jobId);
    const directFolderAuthorized = Boolean(
      failed?.directFolderAuthority && index.context.directFolderAuthorizedJobIds.has(failed.id)
    );
    const folderTreeAuthorized = Boolean(
      failed?.folderTreeAuthority && index.context.folderTreeAuthorizedJobIds.has(failed.id)
    );
    if (
      !failed ||
      (!directFolderAuthorized && !folderTreeAuthorized) ||
      failed.state !== 'failed' ||
      failure.code !== 'download_link_expired'
    ) {
      return;
    }
    const expected = makeReplacementExportJob({
      failedJob: failed,
      sourceRoots: failed.sourceRoots,
      reason: 'download_link_expired',
      ordinal: 0,
    });
    const expectedById = directFolderAuthorized
      ? index.context.directFolderExpectedSuccessorsById
      : index.context.folderTreeExpectedSuccessorsById;
    const candidates = expectedById.get(expected.id) ?? [];
    if (!candidates.some((candidate) => exactExportJobPlanningIdentity(candidate, expected))) {
      candidates.push(expected);
      expectedById.set(expected.id, candidates);
    }
  }

  private runExportJobIndexedTransaction<T>(operation: () => T): T {
    try {
      return this.db.transaction(operation)();
    } catch (error) {
      this.exportJobWriteIndex = null;
      throw error;
    }
  }

  private writeExportJobRow(job: ExportJob): void {
    assertProviderTaskPrivacySafe(job, 'export job');
    this.db
      .prepare(
        `INSERT INTO export_job
           (id, run_id, match_signature, state, submitted_at, attempts, body_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           state = excluded.state,
           submitted_at = excluded.submitted_at,
           attempts = excluded.attempts,
           body_json = excluded.body_json`
      )
      .run(
        job.id,
        job.runId,
        job.matchSignature,
        job.state,
        job.submittedAt,
        job.attempts,
        JSON.stringify(job)
      );
  }

  private parseCorrelatedExportJobRow(row: ExportJobSqliteRow): ExportJob {
    const record = requireRecord(JSON.parse(row.body_json), `Export job ${row.id}`);
    const job = record as Partial<ExportJob>;
    if (
      typeof job.id !== 'string' ||
      typeof job.runId !== 'string' ||
      typeof job.contentFamily !== 'string' ||
      typeof job.matchSignature !== 'string' ||
      !Array.isArray(job.sourceRoots) ||
      typeof job.state !== 'string' ||
      !Object.prototype.hasOwnProperty.call(EXPORT_JOB_TRANSITIONS, job.state) ||
      (job.submittedAt !== null && typeof job.submittedAt !== 'string') ||
      typeof job.attempts !== 'number' ||
      (job.receiptId !== null && typeof job.receiptId !== 'string') ||
      (job.downloadUrlHash !== null && typeof job.downloadUrlHash !== 'string') ||
      (job.snapshotPartId !== null && typeof job.snapshotPartId !== 'string') ||
      job.sourceRoots.some((sourceRoot) => {
        if (typeof sourceRoot !== 'object' || sourceRoot === null) return true;
        return (
          typeof sourceRoot.id !== 'string' ||
          typeof sourceRoot.url !== 'string' ||
          (sourceRoot.objectType !== undefined && typeof sourceRoot.objectType !== 'string')
        );
      })
    ) {
      throw new Error(`Persisted export job ${row.id} body is invalid.`);
    }
    const validatedJob = job as ExportJob;
    if (
      row.id !== validatedJob.id ||
      row.run_id !== validatedJob.runId ||
      row.match_signature !== validatedJob.matchSignature ||
      row.state !== validatedJob.state ||
      row.submitted_at !== validatedJob.submittedAt ||
      row.attempts !== validatedJob.attempts
    ) {
      throw new Error(`Persisted export job ${row.id} SQLite correlation is invalid.`);
    }
    assertValidExportJob(validatedJob);
    return validatedJob;
  }

  private parseCorrelatedExportJobReplacementRow(
    row: ExportJobReplacementSqliteRow
  ): PersistedExportJobReplacement {
    const replacement: unknown = JSON.parse(row.body_json);
    assertValidExportJobReplacement(replacement);
    if (row.id !== replacement.failedJobId || row.run_id !== replacement.runId) {
      throw new Error(`Export replacement ${row.id} SQLite correlation is invalid.`);
    }
    return replacement;
  }

  private assertExportJobReplacementAuthority(
    replacement: PersistedExportJobReplacement,
    context: ExportJobValidationContext
  ): void {
    const failed = context.jobsById.get(replacement.failedJobId);
    if (!failed || failed.runId !== replacement.runId || failed.state !== 'failed') {
      throw new Error(
        `Export replacement ${replacement.failedJobId} requires a failed job in this run.`
      );
    }
    const successors = replacement.replacementJobIds.map((replacementJobId) => {
      const successor = context.jobsById.get(replacementJobId);
      if (!successor || successor.runId !== replacement.runId) {
        throw new Error(`Export replacement references missing successor ${replacementJobId}.`);
      }
      return successor;
    });
    const failedAuthorityKind = failed.directFolderAuthority
      ? failed.folderTreeAuthority
        ? 'invalid'
        : 'Direct Folder'
      : failed.folderTreeAuthority
        ? 'Folder Tree'
        : null;
    const crossesSelectedFolderAuthority =
      failedAuthorityKind !== null ||
      successors.some(
        (successor) => successor.directFolderAuthority || successor.folderTreeAuthority
      );
    if (!crossesSelectedFolderAuthority) return;
    if (!failedAuthorityKind || failedAuthorityKind === 'invalid') {
      throw new Error(
        `Selected-folder replacement ${replacement.failedJobId} has a non-authorized parent.`
      );
    }
    const failure = context.failuresByJobId.get(failed.id);
    if (
      !failure ||
      failure.jobId !== failed.id ||
      failure.runId !== replacement.runId ||
      failure.code !== replacement.reason
    ) {
      throw new Error(
        `${failedAuthorityKind} replacement ${replacement.failedJobId} conflicts with immutable failure evidence.`
      );
    }

    if (replacement.replacementJobIds.length === 0) {
      if (replacement.reason === 'export_timed_out') return;
      throw new Error(
        `${failedAuthorityKind} replacement ${replacement.failedJobId} requires its exact expired-link successor.`
      );
    }
    if (replacement.reason !== 'download_link_expired') {
      throw new Error(
        `${failedAuthorityKind} replacement ${replacement.failedJobId} may replace only an expired download link.`
      );
    }
    const expected = makeReplacementExportJob({
      failedJob: failed,
      sourceRoots: failed.sourceRoots,
      reason: 'download_link_expired',
      ordinal: 0,
    });
    const successor = successors[0];
    if (
      replacement.replacementJobIds.length !== 1 ||
      replacement.replacementJobIds[0] !== expected.id ||
      !successor ||
      !exactExportJobPlanningIdentity(successor, expected)
    ) {
      throw new Error(
        `${failedAuthorityKind} replacement ${replacement.failedJobId} does not name its exact expired-link successor.`
      );
    }
  }

  private listRawExportJobs(runId: string): ExportJob[] {
    const rows = this.db
      .prepare(
        `SELECT id, run_id, match_signature, state, submitted_at, attempts, body_json
         FROM export_job
         WHERE run_id = ?
         ORDER BY id`
      )
      .all(runId) as ExportJobSqliteRow[];
    return rows.map((row) => this.parseCorrelatedExportJobRow(row));
  }

  private listRawExportJobFailures(runId: string): Map<string, PersistedExportJobFailure> {
    const rows = this.db
      .prepare(
        `SELECT id, run_id, body_json
         FROM export_job_failure
         WHERE run_id = ?
         ORDER BY id`
      )
      .all(runId) as ExportJobReplacementSqliteRow[];
    const failures = new Map<string, PersistedExportJobFailure>();
    for (const row of rows) {
      const failure: unknown = JSON.parse(row.body_json);
      assertValidExportJobFailure(failure);
      if (row.id !== failure.jobId || row.run_id !== failure.runId || failure.runId !== runId) {
        throw new Error(`Export failure ${row.id} SQLite correlation is invalid.`);
      }
      failures.set(failure.jobId, failure);
    }
    return failures;
  }

  private createExportJobValidationContext(
    run: MigrationRun,
    jobs: readonly ExportJob[]
  ): ExportJobValidationContext {
    this.instrumentation.onExportJobValidationContextBuild?.(jobs.length);
    const jobsById = new Map(jobs.map((job) => [job.id, job]));
    const plan =
      run.scope.kind === 'folder' ? this.readDirectFolderCapturePlanForRun(run.id, run) : null;
    const folderTreePlan =
      run.scope.kind === 'folder_tree' ? this.readFolderTreeCapturePlanForRun(run.id, run) : null;
    const failuresByJobId =
      plan ||
      folderTreePlan ||
      jobs.some((job) => job.directFolderAuthority || job.folderTreeAuthority)
        ? this.listRawExportJobFailures(run.id)
        : new Map<string, PersistedExportJobFailure>();
    const directFolderPlanItemsById = new Map(
      plan?.items.map((item) => [item.sourceId, item] as const) ?? []
    );
    const directFolderInitialIdentities = plan
      ? directFolderInitialExportJobIdentityIndex(plan)
      : new Map();
    const directFolderAuthorizedJobIds = new Set<string>();
    const directFolderExpectedSuccessorsById = new Map<string, ExportJob[]>();
    const folderTreePlanItemsById = new Map(
      folderTreePlan?.items.map((item) => [item.sourceId, item] as const) ?? []
    );
    const folderTreeInitialIdentities = folderTreePlan
      ? folderTreeInitialExportJobIdentityIndex(folderTreePlan)
      : new Map();
    const folderTreeAuthorizedJobIds = new Set<string>();
    const folderTreeExpectedSuccessorsById = new Map<string, ExportJob[]>();

    if (run.scope.kind === 'folder' && plan?.startAllowed) {
      const shapedJobs = new Set<string>();
      const pending: string[] = [];
      for (const job of jobs) {
        if (!job.directFolderAuthority) continue;
        try {
          const initialIdentity = this.assertDirectFolderJobShape(
            { ...run, scope: run.scope },
            job,
            directFolderPlanItemsById,
            directFolderInitialIdentities
          );
          shapedJobs.add(job.id);
          if (
            job.id === initialIdentity.id &&
            job.matchSignature === initialIdentity.matchSignature
          ) {
            directFolderAuthorizedJobIds.add(job.id);
            pending.push(job.id);
          }
        } catch {}
      }

      for (let index = 0; index < pending.length; index += 1) {
        const parent = jobsById.get(pending[index]);
        if (!parent || parent.state !== 'failed') continue;
        const failure = failuresByJobId.get(parent.id);
        if (!failure || failure.runId !== run.id || failure.code !== 'download_link_expired') {
          continue;
        }
        const expected = makeReplacementExportJob({
          failedJob: parent,
          sourceRoots: parent.sourceRoots,
          reason: 'download_link_expired',
          ordinal: 0,
        });
        const candidates = directFolderExpectedSuccessorsById.get(expected.id) ?? [];
        candidates.push(expected);
        directFolderExpectedSuccessorsById.set(expected.id, candidates);

        const successor = jobsById.get(expected.id);
        if (
          successor &&
          shapedJobs.has(successor.id) &&
          exactExportJobPlanningIdentity(successor, expected) &&
          !directFolderAuthorizedJobIds.has(successor.id)
        ) {
          directFolderAuthorizedJobIds.add(successor.id);
          pending.push(successor.id);
        }
      }
    }

    if (run.scope.kind === 'folder_tree' && folderTreePlan?.startAllowed) {
      const shapedJobs = new Set<string>();
      const pending: string[] = [];
      for (const job of jobs) {
        if (!job.folderTreeAuthority) continue;
        try {
          const initialIdentity = this.assertFolderTreeJobShape(
            { ...run, scope: run.scope },
            job,
            folderTreePlanItemsById,
            folderTreeInitialIdentities
          );
          shapedJobs.add(job.id);
          if (
            job.id === initialIdentity.id &&
            job.matchSignature === initialIdentity.matchSignature
          ) {
            folderTreeAuthorizedJobIds.add(job.id);
            pending.push(job.id);
          }
        } catch {}
      }

      for (let index = 0; index < pending.length; index += 1) {
        const parent = jobsById.get(pending[index]);
        if (!parent || parent.state !== 'failed') continue;
        const failure = failuresByJobId.get(parent.id);
        if (!failure || failure.runId !== run.id || failure.code !== 'download_link_expired') {
          continue;
        }
        const expected = makeReplacementExportJob({
          failedJob: parent,
          sourceRoots: parent.sourceRoots,
          reason: 'download_link_expired',
          ordinal: 0,
        });
        const candidates = folderTreeExpectedSuccessorsById.get(expected.id) ?? [];
        candidates.push(expected);
        folderTreeExpectedSuccessorsById.set(expected.id, candidates);

        const successor = jobsById.get(expected.id);
        if (
          successor &&
          shapedJobs.has(successor.id) &&
          exactExportJobPlanningIdentity(successor, expected) &&
          !folderTreeAuthorizedJobIds.has(successor.id)
        ) {
          folderTreeAuthorizedJobIds.add(successor.id);
          pending.push(successor.id);
        }
      }
    }

    return {
      run,
      plan,
      folderTreePlan,
      jobsById,
      failuresByJobId,
      directFolderPlanItemsById,
      directFolderInitialIdentities,
      directFolderAuthorizedJobIds,
      directFolderExpectedSuccessorsById,
      folderTreePlanItemsById,
      folderTreeInitialIdentities,
      folderTreeAuthorizedJobIds,
      folderTreeExpectedSuccessorsById,
    };
  }

  private assertDirectFolderExportAuthority(
    job: ExportJob,
    context: ExportJobValidationContext
  ): void {
    const { run, plan, folderTreePlan } = context;
    const authority = job.directFolderAuthority;
    const treeAuthority = job.folderTreeAuthority;
    if (authority && treeAuthority) {
      throw new Error(`Export job ${job.id} cannot carry two selected-scope authorities.`);
    }
    if (treeAuthority) {
      if (run.scope.kind !== 'folder_tree' || !folderTreePlan?.startAllowed) {
        throw new Error(`Folder Tree export job ${job.id} is not bound to a runnable plan.`);
      }
      const initialIdentity = this.assertFolderTreeJobShape(
        { ...run, scope: run.scope },
        job,
        context.folderTreePlanItemsById,
        context.folderTreeInitialIdentities
      );
      if (job.id === initialIdentity.id && job.matchSignature === initialIdentity.matchSignature) {
        return;
      }
      const persisted = context.jobsById.get(job.id);
      if (
        persisted &&
        exactExportJobPlanningIdentity(job, persisted) &&
        context.folderTreeAuthorizedJobIds.has(job.id)
      ) {
        return;
      }
      const expected = context.folderTreeExpectedSuccessorsById.get(job.id) ?? [];
      if (expected.some((candidate) => exactExportJobPlanningIdentity(job, candidate))) return;
      throw new Error(
        `Folder Tree export job ${job.id} is neither canonical nor an authorized expired-link replacement.`
      );
    }
    if (run.scope.kind === 'folder_tree' && folderTreePlan) {
      throw new Error(`Folder Tree export job ${job.id} has no capture-plan authority.`);
    }
    if (!authority) {
      if (run.scope.kind === 'folder' && plan) {
        throw new Error(`Direct Folder export job ${job.id} has no capture-plan authority.`);
      }
      return;
    }
    if (run.scope.kind !== 'folder') {
      throw new Error(`Direct Folder export job ${job.id} has invalid item authority.`);
    }
    if (!plan || !plan.startAllowed) {
      throw new Error(`Direct Folder export job ${job.id} is not bound to a runnable plan.`);
    }
    const initialIdentity = this.assertDirectFolderJobShape(
      { ...run, scope: run.scope },
      job,
      context.directFolderPlanItemsById,
      context.directFolderInitialIdentities
    );
    if (job.id === initialIdentity.id && job.matchSignature === initialIdentity.matchSignature) {
      return;
    }
    const persisted = context.jobsById.get(job.id);
    if (
      persisted &&
      exactExportJobPlanningIdentity(job, persisted) &&
      context.directFolderAuthorizedJobIds.has(job.id)
    ) {
      return;
    }
    const expected = context.directFolderExpectedSuccessorsById.get(job.id) ?? [];
    if (expected.some((candidate) => exactExportJobPlanningIdentity(job, candidate))) return;
    throw new Error(
      `Direct Folder export job ${job.id} is neither canonical nor an authorized expired-link replacement.`
    );
  }

  private assertFolderTreeJobShape(
    run: MigrationRun & { scope: Extract<MigrationRun['scope'], { kind: 'folder_tree' }> },
    job: ExportJob,
    planItemsById: ReadonlyMap<string, FolderTreeCapturePlanV1['items'][number]>,
    initialIdentities: ReturnType<typeof folderTreeInitialExportJobIdentityIndex>
  ): { id: string; matchSignature: string } {
    const authority = job.folderTreeAuthority;
    if (!authority) {
      throw new Error(`Folder Tree export job ${job.id} has no item authority.`);
    }
    const initialIdentity = initialIdentities.get(authority.sourceItemId);
    if (!initialIdentity || !isDeepStrictEqual(authority, initialIdentity.authority)) {
      throw new Error(`Folder Tree export job ${job.id} has invalid item authority.`);
    }
    if (
      job.id === initialIdentity.id &&
      job.matchSignature === initialIdentity.matchSignature &&
      job.folderTreeReplacementLineage !== undefined
    ) {
      throw new Error(`Initial Folder Tree export job ${job.id} cannot claim replacement lineage.`);
    }
    const item = planItemsById.get(authority.sourceItemId);
    const sourceRoot = job.sourceRoots[0];
    if (
      !item ||
      item.requestCapability.state !== 'ready' ||
      job.contentFamily !== (item.sourceType === 'sequence' ? 'dna_rna' : 'notebook') ||
      job.sourceRoots.length !== 1 ||
      !sourceRoot ||
      sourceRoot.id !== item.sourceId ||
      authority.selectedRootId !== run.scope.roots[0]?.id ||
      typeof item.sourceUrl !== 'string' ||
      authority.sourceItemUrl !== item.sourceUrl ||
      sourceRoot.url !== item.sourceUrl ||
      sourceRoot.objectType !== item.sourceType
    ) {
      throw new Error(`Folder Tree export job ${job.id} conflicts with its capture plan.`);
    }
    return { id: initialIdentity.id, matchSignature: initialIdentity.matchSignature };
  }

  private assertDirectFolderJobShape(
    run: MigrationRun & { scope: Extract<MigrationRun['scope'], { kind: 'folder' }> },
    job: ExportJob,
    planItemsById: ReadonlyMap<string, DirectFolderCapturePlanV1['items'][number]>,
    initialIdentities: ReturnType<typeof directFolderInitialExportJobIdentityIndex>
  ): { id: string; matchSignature: string } {
    const authority = job.directFolderAuthority;
    if (!authority) {
      throw new Error(`Direct Folder export job ${job.id} has no item authority.`);
    }
    const initialIdentity = initialIdentities.get(authority.sourceItemId);
    if (!initialIdentity || !isDeepStrictEqual(authority, initialIdentity.authority)) {
      throw new Error(`Direct Folder export job ${job.id} has invalid item authority.`);
    }
    const item = planItemsById.get(authority.sourceItemId);
    const sourceRoot = job.sourceRoots[0];
    if (
      !item ||
      item.requestCapability.state !== 'ready' ||
      item.contentFamily !== job.contentFamily ||
      job.sourceRoots.length !== 1 ||
      !sourceRoot ||
      sourceRoot.id !== item.sourceId ||
      authority.selectedRootId !== run.scope.folder.id ||
      typeof item.sourceUrl !== 'string' ||
      authority.sourceItemUrl !== item.sourceUrl ||
      sourceRoot.url !== item.sourceUrl ||
      sourceRoot.objectType !== item.sourceType
    ) {
      throw new Error(`Direct Folder export job ${job.id} conflicts with its capture-plan item.`);
    }
    return { id: initialIdentity.id, matchSignature: initialIdentity.matchSignature };
  }
}

type ScopedFolderPersistedPageRow = {
  ordinal: number;
  source_command_request_id: string;
  previous_record_hash: string;
  record_hash: string;
  body_json: string;
};

function validateProviderActivityEvidence(
  value: ProviderActivityBundle | unknown,
  runId: string
): ProviderActivityBundle {
  const record = requireRecord(value, 'Provider activity evidence');
  assertExactRecordKeys(
    record,
    [
      'id',
      'runId',
      'commandRequestId',
      'operationKind',
      'observedAt',
      'schema',
      'complete',
      'observations',
    ],
    'Provider activity evidence'
  );
  const id = requireOpaqueId(record.id, 'Provider activity evidence ID');
  const commandRequestId = requireOpaqueId(
    record.commandRequestId,
    'Provider activity command request ID'
  );
  if (record.runId !== runId) {
    throw new Error(`Provider activity evidence ${id} does not match migration run ${runId}.`);
  }
  if (
    typeof record.operationKind !== 'string' ||
    !PROVIDER_ACTIVITY_OPERATION_KINDS.has(record.operationKind as ProviderActivityOperationKind)
  ) {
    throw new Error(`Provider activity evidence ${id} has an invalid operation.`);
  }
  if (typeof record.observedAt !== 'string' || !Number.isFinite(Date.parse(record.observedAt))) {
    throw new Error(`Provider activity evidence ${id} has an invalid timestamp.`);
  }
  const operationKind = record.operationKind as ProviderActivityOperationKind;
  const bridge = validateBridgeProviderActivityBundle(
    {
      schema: record.schema,
      complete: record.complete,
      observations: record.observations,
    },
    operationKind
  );
  return {
    id,
    runId,
    commandRequestId,
    operationKind,
    observedAt: record.observedAt,
    ...bridge,
  };
}

function normalizeScopedFolderSettlementPage(
  value: ScopedFolderDiscoverySettlementPage | unknown
): ScopedFolderDiscoverySettlementPage {
  const record = requireRecord(value, 'Scoped Folder settlement page');
  if (record.mode === 'append' || record.mode === 'replay') {
    assertExactRecordKeys(
      record,
      ['mode', 'expectedHead', 'entry'],
      'Scoped Folder settlement page'
    );
    return Object.freeze({
      mode: record.mode,
      expectedHead: normalizeScopedFolderTraversalHead(record.expectedHead),
      entry: record.entry,
    });
  }
  if (record.mode === 'none') {
    assertExactRecordKeys(record, ['mode', 'expectedHead'], 'Scoped Folder settlement page');
    return Object.freeze({
      mode: record.mode,
      expectedHead: normalizeScopedFolderTraversalHead(record.expectedHead),
    });
  }
  throw new Error('Scoped Folder settlement page mode is invalid.');
}

function validateScopedFolderSettlementActivity(
  value: ProviderActivityBundle | unknown,
  runId: string,
  commandRequestId: string
): ProviderActivityBundle {
  const record = requireRecord(value, 'Scoped Folder settlement activity');
  assertExactRecordKeys(
    record,
    [
      'id',
      'runId',
      'commandRequestId',
      'operationKind',
      'observedAt',
      'schema',
      'complete',
      'observations',
    ],
    'Scoped Folder settlement activity'
  );
  const id = requireOpaqueId(record.id, 'Scoped Folder settlement activity ID');
  if (record.runId !== runId || record.commandRequestId !== commandRequestId) {
    throw new Error('Scoped Folder settlement activity has the wrong run or command request ID.');
  }
  if (record.operationKind !== 'discover_scoped_folder_page') {
    throw new Error('Scoped Folder settlement activity has the wrong operation.');
  }
  if (typeof record.observedAt !== 'string' || !Number.isFinite(Date.parse(record.observedAt))) {
    throw new Error('Scoped Folder settlement activity timestamp is invalid.');
  }
  const bridge = validateBridgeProviderActivityBundle(
    {
      schema: record.schema,
      complete: record.complete,
      observations: record.observations,
    },
    'discover_scoped_folder_page'
  );
  if (!bridge.complete) {
    throw new Error('Scoped Folder settlement requires complete provider activity.');
  }
  return {
    id,
    runId,
    commandRequestId,
    operationKind: 'discover_scoped_folder_page',
    observedAt: record.observedAt,
    ...bridge,
  };
}

function validateScopedFolderSettlementRequestLedgerEntry(
  value: MigrationRequestLedgerEntry | unknown,
  runId: string,
  commandRequestId: string,
  pageRequestSha256: string
): MigrationRequestLedgerEntry {
  const record = requireRecord(value, 'Scoped Folder settlement request ledger entry');
  assertExactRecordKeys(
    record,
    [
      'id',
      'runId',
      'commandRequestId',
      'requestKind',
      'requestKey',
      'outcome',
      'startedAt',
      'finishedAt',
      'attempt',
    ],
    'Scoped Folder settlement request ledger entry'
  );
  const id = requireOpaqueId(record.id, 'Scoped Folder settlement request ledger ID');
  if (record.runId !== runId || record.commandRequestId !== commandRequestId) {
    throw new Error(
      'Scoped Folder settlement request ledger has the wrong run or command request ID.'
    );
  }
  if (record.requestKind !== 'folder_discovery' || record.requestKey !== pageRequestSha256) {
    throw new Error('Scoped Folder settlement request ledger has the wrong request correlation.');
  }
  if (
    record.outcome !== 'success' &&
    record.outcome !== 'transient_failure' &&
    record.outcome !== 'permanent_failure'
  ) {
    throw new Error('Scoped Folder settlement request ledger outcome is invalid.');
  }
  if (
    typeof record.startedAt !== 'string' ||
    typeof record.finishedAt !== 'string' ||
    !Number.isFinite(Date.parse(record.startedAt)) ||
    !Number.isFinite(Date.parse(record.finishedAt)) ||
    Date.parse(record.finishedAt) < Date.parse(record.startedAt)
  ) {
    throw new Error('Scoped Folder settlement request ledger timestamps are invalid.');
  }
  if (!Number.isSafeInteger(record.attempt) || Number(record.attempt) < 1) {
    throw new Error('Scoped Folder settlement request ledger attempt is invalid.');
  }
  return {
    id,
    runId,
    commandRequestId,
    requestKind: 'folder_discovery',
    requestKey: pageRequestSha256,
    outcome: record.outcome,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    attempt: Number(record.attempt),
  };
}

function assertSuccessfulScopedFolderSettlement(
  activity: ProviderActivityBundle,
  requestLedgerEntry: MigrationRequestLedgerEntry,
  mode: 'append' | 'replay'
): void {
  if (requestLedgerEntry.outcome !== 'success') {
    throw new Error(`Scoped Folder ${mode} settlement requires a successful request outcome.`);
  }
  assertExactScopedFolderSuccessActivity({
    schema: activity.schema,
    complete: activity.complete,
    observations: activity.observations,
  });
}

function assertFailedScopedFolderSettlement(
  activity: ProviderActivityBundle,
  requestLedgerEntry: MigrationRequestLedgerEntry
): void {
  if (
    requestLedgerEntry.outcome !== 'transient_failure' &&
    requestLedgerEntry.outcome !== 'permanent_failure'
  ) {
    throw new Error('Scoped Folder no-page settlement requires a failed request outcome.');
  }
  const observation = activity.observations[0];
  const exactFailedNetworkRequest =
    observation?.kind === 'network_request' &&
    observation.requestClass === 'folder_scope_discovery' &&
    observation.providerSurface === 'benchling_tenant' &&
    observation.method === 'POST';
  const exactTraversalAuthorityMiss = isExactTraversalAuthorityMiss(activity, requestLedgerEntry);
  const exactProviderPreDispatchMiss = isExactProviderPreDispatchMiss(activity, requestLedgerEntry);
  if (
    activity.observations.length !== 1 ||
    (!exactFailedNetworkRequest && !exactTraversalAuthorityMiss && !exactProviderPreDispatchMiss)
  ) {
    throw new Error(
      'Scoped Folder no-page settlement requires one failed tenant discovery request or exact provider-free local miss.'
    );
  }
}

function validateMigrationRequestLedgerEntry(
  value: unknown,
  expectedRunId: string
): MigrationRequestLedgerEntry {
  const record = requireRecord(value, 'Migration request ledger entry');
  const allowedKeys = new Set([
    'id',
    'runId',
    'commandRequestId',
    'requestKind',
    'requestKey',
    'outcome',
    'startedAt',
    'finishedAt',
    'attempt',
  ]);
  const requiredKeys = [
    'id',
    'runId',
    'requestKind',
    'requestKey',
    'outcome',
    'startedAt',
    'finishedAt',
    'attempt',
  ];
  if (
    Object.keys(record).some((key) => !allowedKeys.has(key)) ||
    requiredKeys.some((key) => !Object.hasOwn(record, key))
  ) {
    throw new Error('Migration request ledger entry is malformed.');
  }
  const id = requireOpaqueId(record.id, 'Migration request ledger entry ID');
  if (record.runId !== expectedRunId) {
    throw new Error(`Migration request ledger entry ${id} does not match this run.`);
  }
  const requestKinds: MigrationRequestLedgerEntry['requestKind'][] = [
    'export_submit',
    'export_submit_reconcile',
    'gmail_poll',
    'export_split_discovery',
    'export_inspect',
    'export_download',
    'folder_discovery',
    'targeted_read',
  ];
  const outcomes: MigrationRequestLedgerEntry['outcome'][] = [
    'success',
    'cache_hit',
    'transient_failure',
    'permanent_failure',
  ];
  if (
    !requestKinds.includes(record.requestKind as MigrationRequestLedgerEntry['requestKind']) ||
    typeof record.requestKey !== 'string' ||
    record.requestKey.length < 1 ||
    record.requestKey.length > 4_096 ||
    record.requestKey.trim() !== record.requestKey ||
    !outcomes.includes(record.outcome as MigrationRequestLedgerEntry['outcome']) ||
    typeof record.startedAt !== 'string' ||
    !Number.isFinite(Date.parse(record.startedAt)) ||
    typeof record.finishedAt !== 'string' ||
    !Number.isFinite(Date.parse(record.finishedAt)) ||
    Date.parse(record.startedAt) > Date.parse(record.finishedAt) ||
    !Number.isSafeInteger(record.attempt) ||
    Number(record.attempt) < 1
  ) {
    throw new Error(`Migration request ledger entry ${id} is malformed.`);
  }
  const commandRequestId =
    record.commandRequestId === undefined
      ? undefined
      : requireOpaqueId(record.commandRequestId, 'Migration request ledger command request ID');
  return {
    id,
    runId: expectedRunId,
    ...(commandRequestId === undefined ? {} : { commandRequestId }),
    requestKind: record.requestKind as MigrationRequestLedgerEntry['requestKind'],
    requestKey: record.requestKey,
    outcome: record.outcome as MigrationRequestLedgerEntry['outcome'],
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    attempt: Number(record.attempt),
  };
}

function validateProviderCommandJournalEntry(
  value: ProviderCommandJournalEntry | unknown,
  run: MigrationRun
): ProviderCommandJournalEntry {
  const record = requireRecord(value, 'Provider command');
  const allowedKeys = new Set([
    'id',
    'runId',
    'commandRequestId',
    'operationKind',
    'exportJobId',
    'nativeExportLedgerEpoch',
    'reconcilesCommandRequestId',
    'explicitResumeAttempt',
    'interventionSha256',
    'scopedFolderCorrelation',
    'directFolderGmailRescan',
    'issuedAt',
  ]);
  const requiredKeys = ['id', 'runId', 'commandRequestId', 'operationKind', 'issuedAt'];
  if (
    Object.keys(record).some((key) => !allowedKeys.has(key)) ||
    requiredKeys.some((key) => !Object.hasOwn(record, key))
  ) {
    throw new Error(`Provider command ${String(record.id)} is malformed.`);
  }
  const id = requireOpaqueId(record.id, 'Provider command ID');
  const commandRequestId = requireOpaqueId(record.commandRequestId, 'Provider command request ID');
  if (record.runId !== run.id) {
    throw new Error(`Provider command ${id} does not match this migration run.`);
  }
  if (
    typeof record.issuedAt !== 'string' ||
    !Number.isFinite(Date.parse(record.issuedAt)) ||
    ![
      'submit_export',
      'reconcile_export_submission',
      'poll_export_receipts',
      'recover_export_receipt',
      'inspect_export',
      'inspect_export_range',
      'discover_failed_export_split',
      'discover_scoped_folder_page',
      'download_export',
      'targeted_read',
    ].includes(String(record.operationKind))
  ) {
    throw new Error(`Provider command ${id} is malformed.`);
  }
  const operationKind = record.operationKind as ProviderCommandJournalEntry['operationKind'];
  let exportJobId: string | undefined;
  if (record.exportJobId !== undefined) {
    exportJobId = requireOpaqueId(record.exportJobId, 'Provider command export job ID');
    if (
      operationKind !== 'submit_export' &&
      operationKind !== 'reconcile_export_submission' &&
      operationKind !== 'download_export'
    ) {
      throw new Error(`Provider command ${id} has invalid export-job correlation.`);
    }
  }
  let nativeExportLedgerEpoch: string | undefined;
  if (record.nativeExportLedgerEpoch !== undefined) {
    if (
      typeof record.nativeExportLedgerEpoch !== 'string' ||
      !NATIVE_EXPORT_LEDGER_EPOCH.test(record.nativeExportLedgerEpoch) ||
      (operationKind !== 'submit_export' &&
        operationKind !== 'reconcile_export_submission' &&
        operationKind !== 'download_export')
    ) {
      throw new Error(`Provider command ${id} has invalid native-export ledger continuity.`);
    }
    nativeExportLedgerEpoch = record.nativeExportLedgerEpoch;
  }
  if (
    operationKind === 'download_export' &&
    (exportJobId === undefined) !== (nativeExportLedgerEpoch === undefined)
  ) {
    throw new Error(`Provider command ${id} has partial protected-download correlation.`);
  }
  let reconcilesCommandRequestId: string | undefined;
  let explicitResumeAttempt: number | undefined;
  let interventionSha256: string | undefined;
  if (operationKind === 'reconcile_export_submission') {
    if (
      exportJobId === undefined ||
      nativeExportLedgerEpoch === undefined ||
      record.reconcilesCommandRequestId === undefined ||
      !Number.isSafeInteger(record.explicitResumeAttempt) ||
      Number(record.explicitResumeAttempt) < 1 ||
      typeof record.interventionSha256 !== 'string' ||
      !SHA256_REF.test(record.interventionSha256)
    ) {
      throw new Error(`Provider command ${id} has invalid reconciliation correlation.`);
    }
    reconcilesCommandRequestId = requireOpaqueId(
      record.reconcilesCommandRequestId,
      'Provider command original request ID'
    );
    explicitResumeAttempt = Number(record.explicitResumeAttempt);
    interventionSha256 = record.interventionSha256;
  } else if (
    record.reconcilesCommandRequestId !== undefined ||
    record.explicitResumeAttempt !== undefined ||
    record.interventionSha256 !== undefined
  ) {
    throw new Error(`Provider command ${id} has invalid reconciliation correlation.`);
  }
  let scopedFolderCorrelation: ScopedFolderCommandCorrelation | undefined;
  if (operationKind === 'discover_scoped_folder_page') {
    if (
      record.exportJobId !== undefined ||
      record.nativeExportLedgerEpoch !== undefined ||
      record.scopedFolderCorrelation === undefined
    ) {
      throw new Error(`Provider command ${id} has invalid scoped Folder correlation.`);
    }
    scopedFolderCorrelation = validateScopedFolderCommandCorrelation(
      record.scopedFolderCorrelation,
      run
    );
  } else if (record.scopedFolderCorrelation !== undefined) {
    throw new Error(`Provider command ${id} has invalid scoped Folder correlation.`);
  }
  let directFolderGmailRescan:
    | Extract<ProviderTaskGmailRescanAuthorization, { scopeKind: 'folder' }>
    | undefined;
  if (record.directFolderGmailRescan !== undefined) {
    if (operationKind !== 'poll_export_receipts') {
      throw new Error(`Provider command ${id} has invalid Direct Folder rescan correlation.`);
    }
    directFolderGmailRescan = validateDirectFolderGmailRescanCommandCorrelation(
      record.directFolderGmailRescan,
      run
    );
  }
  return {
    id,
    runId: run.id,
    commandRequestId,
    operationKind,
    ...(exportJobId === undefined ? {} : { exportJobId }),
    ...(nativeExportLedgerEpoch === undefined ? {} : { nativeExportLedgerEpoch }),
    ...(reconcilesCommandRequestId === undefined ? {} : { reconcilesCommandRequestId }),
    ...(explicitResumeAttempt === undefined ? {} : { explicitResumeAttempt }),
    ...(interventionSha256 === undefined ? {} : { interventionSha256 }),
    ...(scopedFolderCorrelation === undefined ? {} : { scopedFolderCorrelation }),
    ...(directFolderGmailRescan === undefined ? {} : { directFolderGmailRescan }),
    issuedAt: record.issuedAt,
  };
}

function validateDirectFolderGmailRescanCommandCorrelation(
  value: unknown,
  run: MigrationRun
): Extract<ProviderTaskGmailRescanAuthorization, { scopeKind: 'folder' }> {
  const record = requireRecord(value, 'Direct Folder Gmail rescan command correlation');
  const succeededRecovery =
    record.schema === 'dnaforge.benchling.provider-task-direct-folder-succeeded-gmail-recovery.v1';
  if (succeededRecovery) {
    assertExactRecordKeys(
      record,
      [
        'schema',
        'scopeKind',
        'dispatchMode',
        'runId',
        'jobId',
        'matchSignature',
        'runAttempt',
        'priorCapabilityRunAttempt',
        'recoveryOrdinal',
        'pageReadOrdinal',
        'pageReadLimit',
        'requiredProviderTaskStatus',
        'interventionSha256',
        'directFolderAuthorityDigest',
        'directFolderSourceItemNameSha256',
        'nativeExportLedgerEpoch',
        'originalCommandRequestId',
        'providerTaskHandleSha256',
        'rootSucceededCommandRequestId',
        'rootSucceededActivitySha256',
        'priorRecoveryCommandRequestId',
        'priorRecoveryActivitySha256',
      ],
      'Direct Folder succeeded-task Gmail recovery command correlation'
    );
    if (
      record.scopeKind !== 'folder' ||
      record.dispatchMode !== 'gmail_page_only' ||
      record.runId !== run.id ||
      run.scope.kind !== 'folder' ||
      !Number.isSafeInteger(record.runAttempt) ||
      !Number.isSafeInteger(record.priorCapabilityRunAttempt) ||
      Number(record.runAttempt) < 2 ||
      Number(record.priorCapabilityRunAttempt) !== Number(record.runAttempt) - 1 ||
      !Number.isSafeInteger(record.recoveryOrdinal) ||
      Number(record.recoveryOrdinal) < 1 ||
      record.pageReadOrdinal !== 1 ||
      record.pageReadLimit !== 1 ||
      record.requiredProviderTaskStatus !== 'SUCCEEDED' ||
      typeof record.matchSignature !== 'string' ||
      record.matchSignature.length < 1 ||
      !SHA256_REF.test(String(record.interventionSha256)) ||
      !SHA256_REF.test(String(record.directFolderAuthorityDigest)) ||
      !SHA256_REF.test(String(record.directFolderSourceItemNameSha256)) ||
      !SHA256_REF.test(String(record.providerTaskHandleSha256)) ||
      !SHA256_REF.test(String(record.rootSucceededActivitySha256)) ||
      !SHA256_REF.test(String(record.priorRecoveryActivitySha256)) ||
      !NATIVE_EXPORT_LEDGER_EPOCH.test(String(record.nativeExportLedgerEpoch)) ||
      (record.recoveryOrdinal === 1 &&
        (record.priorRecoveryCommandRequestId !== record.rootSucceededCommandRequestId ||
          record.priorRecoveryActivitySha256 !== record.rootSucceededActivitySha256))
    ) {
      throw new Error(
        'Direct Folder succeeded-task Gmail recovery command correlation is malformed.'
      );
    }
    for (const [opaqueValue, label] of [
      [record.jobId, 'job ID'],
      [record.originalCommandRequestId, 'original command request ID'],
      [record.rootSucceededCommandRequestId, 'root succeeded command request ID'],
      [record.priorRecoveryCommandRequestId, 'prior recovery command request ID'],
    ] as const) {
      requireOpaqueId(opaqueValue, `Direct Folder succeeded-task Gmail recovery ${label}`);
    }
    return structuredClone(record) as Extract<
      ProviderTaskGmailRescanAuthorization,
      { scopeKind: 'folder' }
    >;
  }
  const sequenceRecovery =
    record.schema === 'dnaforge.benchling.provider-task-direct-folder-sequence-gmail-recovery.v1';
  if (sequenceRecovery) {
    assertExactRecordKeys(
      record,
      [
        'schema',
        'scopeKind',
        'dispatchMode',
        'runId',
        'jobId',
        'matchSignature',
        'runAttempt',
        'priorCapabilityRunAttempt',
        'pageReadOrdinal',
        'pageReadLimit',
        'requiredProviderTaskStatus',
        'priorActionRequiredCode',
        'priorDiagnostic',
        'interventionSha256',
        'directFolderAuthorityDigest',
        'directFolderSourceItemNameSha256',
        'nativeExportLedgerEpoch',
        'originalCommandRequestId',
        'providerTaskHandleSha256',
      ],
      'Direct Folder sequence Gmail recovery command correlation'
    );
    if (
      record.scopeKind !== 'folder' ||
      record.dispatchMode !== 'gmail_page_only' ||
      record.runId !== run.id ||
      run.scope.kind !== 'folder' ||
      !Number.isSafeInteger(record.runAttempt) ||
      !Number.isSafeInteger(record.priorCapabilityRunAttempt) ||
      !(
        (record.runAttempt === 2 && record.priorCapabilityRunAttempt === 1) ||
        (record.runAttempt === 3 && record.priorCapabilityRunAttempt === 2)
      ) ||
      record.pageReadOrdinal !== 1 ||
      record.pageReadLimit !== 1 ||
      record.requiredProviderTaskStatus !== 'ACTION_REQUIRED' ||
      record.priorActionRequiredCode !== 'provider_task_status_undocumented' ||
      record.priorDiagnostic !== 'unrecognized_status' ||
      typeof record.matchSignature !== 'string' ||
      record.matchSignature.length < 1 ||
      !SHA256_REF.test(String(record.interventionSha256)) ||
      !SHA256_REF.test(String(record.directFolderAuthorityDigest)) ||
      !SHA256_REF.test(String(record.directFolderSourceItemNameSha256)) ||
      !SHA256_REF.test(String(record.providerTaskHandleSha256)) ||
      !NATIVE_EXPORT_LEDGER_EPOCH.test(String(record.nativeExportLedgerEpoch))
    ) {
      throw new Error('Direct Folder sequence Gmail recovery command correlation is malformed.');
    }
    requireOpaqueId(record.jobId, 'Direct Folder sequence Gmail recovery job ID');
    requireOpaqueId(
      record.originalCommandRequestId,
      'Direct Folder sequence Gmail recovery original command request ID'
    );
    return structuredClone(record) as Extract<
      ProviderTaskGmailRescanAuthorization,
      { scopeKind: 'folder' }
    >;
  }
  const pageOnly =
    record.schema === 'dnaforge.benchling.provider-task-direct-folder-gmail-rescan.v2';
  const expectedKeys = [
    'schema',
    'scopeKind',
    ...(pageOnly ? ['dispatchMode'] : []),
    'runId',
    'jobId',
    'matchSignature',
    'runAttempt',
    'priorCapabilityRunAttempt',
    ...(pageOnly
      ? ['rescanOrdinal', 'pageReadOrdinal', 'pageReadLimit']
      : ['requestOrdinal', 'requestLimit']),
    'requiredProviderTaskStatus',
    'interventionSha256',
    'directFolderAuthorityDigest',
    'directFolderSourceItemNameSha256',
    'nativeExportLedgerEpoch',
    'originalCommandRequestId',
    'providerTaskHandleSha256',
    'priorFallbackCommandRequestId',
    'priorFallbackActivitySha256',
    ...(pageOnly
      ? [
          'rootRescanCommandRequestId',
          'rootRescanActivitySha256',
          'priorRescanCommandRequestId',
          'priorRescanActivitySha256',
        ]
      : []),
  ].sort();
  const actualKeys = Object.keys(record).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    (record.schema !== 'dnaforge.benchling.provider-task-direct-folder-gmail-rescan.v1' &&
      !pageOnly) ||
    record.scopeKind !== 'folder' ||
    record.runId !== run.id ||
    run.scope.kind !== 'folder' ||
    !Number.isSafeInteger(record.runAttempt) ||
    !Number.isSafeInteger(record.priorCapabilityRunAttempt) ||
    Number(record.runAttempt) < 2 ||
    Number(record.priorCapabilityRunAttempt) !== Number(record.runAttempt) - 1 ||
    (pageOnly
      ? record.dispatchMode !== 'gmail_page_only' ||
        record.pageReadOrdinal !== 1 ||
        record.pageReadLimit !== 1 ||
        !Number.isSafeInteger(record.rescanOrdinal) ||
        Number(record.rescanOrdinal) < 2 ||
        (Number(record.rescanOrdinal) === 2 &&
          (record.priorRescanCommandRequestId !== record.rootRescanCommandRequestId ||
            record.priorRescanActivitySha256 !== record.rootRescanActivitySha256))
      : record.requestOrdinal !== 1 || record.requestLimit !== 1) ||
    record.requiredProviderTaskStatus !== 'RUNNING' ||
    typeof record.matchSignature !== 'string' ||
    record.matchSignature.length < 1 ||
    !SHA256_REF.test(String(record.interventionSha256)) ||
    !SHA256_REF.test(String(record.directFolderAuthorityDigest)) ||
    !SHA256_REF.test(String(record.directFolderSourceItemNameSha256)) ||
    !SHA256_REF.test(String(record.providerTaskHandleSha256)) ||
    !SHA256_REF.test(String(record.priorFallbackActivitySha256)) ||
    (pageOnly &&
      (!SHA256_REF.test(String(record.rootRescanActivitySha256)) ||
        !SHA256_REF.test(String(record.priorRescanActivitySha256)))) ||
    !NATIVE_EXPORT_LEDGER_EPOCH.test(String(record.nativeExportLedgerEpoch))
  ) {
    throw new Error('Direct Folder Gmail rescan command correlation is malformed.');
  }
  for (const [value, label] of [
    [record.jobId, 'job ID'],
    [record.originalCommandRequestId, 'original command request ID'],
    [record.priorFallbackCommandRequestId, 'prior fallback command request ID'],
    ...(pageOnly
      ? ([
          [record.rootRescanCommandRequestId, 'root rescan command request ID'],
          [record.priorRescanCommandRequestId, 'prior rescan command request ID'],
        ] as const)
      : []),
  ] as const) {
    requireOpaqueId(value, `Direct Folder Gmail rescan ${label}`);
  }
  return structuredClone(record) as Extract<
    ProviderTaskGmailRescanAuthorization,
    { scopeKind: 'folder' }
  >;
}

function validateNativeExportReconciliation(
  value: NativeExportSubmissionReconciliationEvidence | unknown,
  run: MigrationRun
): NativeExportSubmissionReconciliationEvidence {
  const record = requireRecord(value, 'Native export reconciliation');
  assertExactRecordKeys(
    record,
    [
      'schema',
      'id',
      'runId',
      'exportJobId',
      'matchSignature',
      'originalCommandRequestId',
      'reconciliationCommandRequestId',
      'nativeExportLedgerEpoch',
      'explicitResumeAttempt',
      'interventionSha256',
      'priorLedgerState',
      'disposition',
      'accepted',
      'observedAt',
    ],
    'Native export reconciliation'
  );
  const id = requireOpaqueId(record.id, 'Native export reconciliation ID');
  if (
    record.schema !== 'dnaforge.benchling.native-export-reconciliation.v1' ||
    record.runId !== run.id ||
    typeof record.matchSignature !== 'string' ||
    record.matchSignature.length < 1 ||
    record.matchSignature.length > 500 ||
    typeof record.nativeExportLedgerEpoch !== 'string' ||
    !NATIVE_EXPORT_LEDGER_EPOCH.test(record.nativeExportLedgerEpoch) ||
    !Number.isSafeInteger(record.explicitResumeAttempt) ||
    Number(record.explicitResumeAttempt) < 1 ||
    typeof record.interventionSha256 !== 'string' ||
    !SHA256_REF.test(record.interventionSha256) ||
    ![
      'absent',
      'dispatching',
      'accepted',
      'polling',
      'succeeded',
      'action_required',
      'ambiguous',
      'rejected',
    ].includes(String(record.priorLedgerState)) ||
    !['dispatched', 'cache_hit', 'blocked'].includes(String(record.disposition)) ||
    typeof record.accepted !== 'boolean' ||
    !Number.isFinite(Date.parse(String(record.observedAt))) ||
    (record.accepted === true && record.disposition === 'blocked') ||
    (record.accepted === false && record.disposition !== 'blocked')
  ) {
    throw new Error(`Native export reconciliation ${id} is malformed.`);
  }
  return {
    schema: 'dnaforge.benchling.native-export-reconciliation.v1',
    id,
    runId: run.id,
    exportJobId: requireOpaqueId(record.exportJobId, 'Native export reconciliation job ID'),
    matchSignature: record.matchSignature,
    originalCommandRequestId: requireOpaqueId(
      record.originalCommandRequestId,
      'Native export original command request ID'
    ),
    reconciliationCommandRequestId: requireOpaqueId(
      record.reconciliationCommandRequestId,
      'Native export reconciliation command request ID'
    ),
    nativeExportLedgerEpoch: record.nativeExportLedgerEpoch,
    explicitResumeAttempt: Number(record.explicitResumeAttempt),
    interventionSha256: record.interventionSha256,
    priorLedgerState:
      record.priorLedgerState as NativeExportSubmissionReconciliationEvidence['priorLedgerState'],
    disposition: record.disposition as NativeExportSubmissionReconciliationEvidence['disposition'],
    accepted: record.accepted,
    observedAt: record.observedAt as string,
  };
}

function validateScopedFolderCommandCorrelation(
  value: unknown,
  run: MigrationRun
): ScopedFolderCommandCorrelation {
  const record = requireRecord(value, 'Scoped Folder command correlation');
  assertExactRecordKeys(
    record,
    [
      'schema',
      'purpose',
      'scopeKind',
      ...(record.includeArchived === undefined ? [] : ['includeArchived']),
      'selectedRootId',
      'folderId',
      'pageIndex',
      'pageRequestSha256',
      'restartTraversal',
      'receiptEpoch',
    ],
    'Scoped Folder command correlation'
  );
  if (record.schema !== SCOPED_FOLDER_COMMAND_SCHEMA) {
    throw new Error('Scoped Folder command correlation schema is invalid.');
  }
  if (record.purpose !== 'advance' && record.purpose !== 'rehydrate') {
    throw new Error('Scoped Folder command correlation purpose is invalid.');
  }
  if (record.scopeKind !== 'folder' && record.scopeKind !== 'folder_tree') {
    throw new Error('Scoped Folder command correlation scope is invalid.');
  }
  if (record.includeArchived !== undefined && typeof record.includeArchived !== 'boolean') {
    throw new Error('Scoped Folder command correlation archived-item authority is invalid.');
  }
  const selectedRootId = requireScopedFolderId(
    record.selectedRootId,
    'Scoped Folder command selected root ID'
  );
  const folderId = requireScopedFolderId(record.folderId, 'Scoped Folder command folder ID');
  if (
    !Number.isSafeInteger(record.pageIndex) ||
    Number(record.pageIndex) < 0 ||
    Number(record.pageIndex) >= SCOPED_FOLDER_MAX_PAGES ||
    typeof record.pageRequestSha256 !== 'string' ||
    !SHA256_REF.test(record.pageRequestSha256) ||
    typeof record.restartTraversal !== 'boolean'
  ) {
    throw new Error('Scoped Folder command correlation page metadata is invalid.');
  }
  const receiptEpoch = requireScopedFolderReceiptEpoch(record.receiptEpoch);
  if (run.scope.kind === 'file' || record.scopeKind !== run.scope.kind) {
    throw new Error('Scoped Folder command correlation does not match the immutable run scope.');
  }
  if ((record.includeArchived === true) !== (run.scope.includeArchived === true)) {
    throw new Error(
      'Scoped Folder command correlation has different archived-item authority than the run.'
    );
  }
  const selectedRootIds =
    run.scope.kind === 'folder' ? [run.scope.folder.id] : run.scope.roots.map(({ id }) => id);
  if (!selectedRootIds.includes(selectedRootId)) {
    throw new Error('Scoped Folder command selected root is outside the immutable run scope.');
  }
  if (run.scope.kind === 'folder' && folderId !== selectedRootId) {
    throw new Error('Direct Folder commands cannot enumerate a child folder.');
  }
  if (
    record.restartTraversal &&
    (record.purpose !== 'rehydrate' ||
      selectedRootId !== folderId ||
      Number(record.pageIndex) !== 0)
  ) {
    throw new Error('Scoped Folder traversal restart is restricted to rehydrating root page zero.');
  }
  if (record.purpose === 'advance' && record.restartTraversal) {
    throw new Error('Scoped Folder advance commands cannot restart traversal.');
  }
  return {
    schema: SCOPED_FOLDER_COMMAND_SCHEMA,
    purpose: record.purpose,
    scopeKind: record.scopeKind,
    ...(record.includeArchived === undefined
      ? {}
      : { includeArchived: record.includeArchived as boolean }),
    selectedRootId,
    folderId,
    pageIndex: Number(record.pageIndex),
    pageRequestSha256: record.pageRequestSha256,
    restartTraversal: record.restartTraversal,
    receiptEpoch,
  };
}

function assertScopedFolderCommandMatchesRequest(
  command: UnsettledScopedFolderCommand,
  request: ScopedFolderTraversalPageRequest,
  pageRequestSha256: string
): void {
  const correlation = command.scopedFolderCorrelation;
  if (
    correlation.selectedRootId !== request.selectedRootId ||
    correlation.folderId !== request.folderId ||
    correlation.pageIndex !== request.pageIndex ||
    correlation.pageRequestSha256 !== pageRequestSha256
  ) {
    throw new Error('Scoped Folder command correlation does not match the settled page request.');
  }
  if (
    correlation.restartTraversal &&
    (request.continuation !== null || request.parentAuthority !== null)
  ) {
    throw new Error('Scoped Folder traversal restart requires an uncontinued root page request.');
  }
}

function assertScopedFolderSettlementMode(
  correlation: ScopedFolderCommandCorrelation,
  mode: ScopedFolderDiscoverySettlementPage['mode']
): void {
  const validAdvanceMode = mode === 'append' || mode === 'none';
  if (
    (correlation.purpose === 'advance' && !validAdvanceMode) ||
    (correlation.purpose === 'rehydrate' && mode === 'append')
  ) {
    throw new Error('Scoped Folder settlement mode contradicts its command purpose.');
  }
}

function isExactTraversalAuthorityMiss(
  activity: ProviderActivityBundle,
  requestLedgerEntry: MigrationRequestLedgerEntry
): boolean {
  const observation = activity.observations[0];
  return (
    activity.observations.length === 1 &&
    requestLedgerEntry.outcome === 'transient_failure' &&
    observation?.kind === 'local_miss' &&
    observation.requestClass === 'folder_scope_discovery' &&
    observation.providerSurface === 'benchling_tenant' &&
    observation.method === 'POST' &&
    observation.reason === 'traversal_authority_missing'
  );
}

function isExactProviderPreDispatchMiss(
  activity: ProviderActivityBundle,
  requestLedgerEntry: MigrationRequestLedgerEntry
): boolean {
  if (requestLedgerEntry.outcome !== 'transient_failure') return false;
  try {
    assertExactScopedFolderPreDispatchActivity({
      schema: activity.schema,
      complete: activity.complete,
      observations: activity.observations,
    });
    return true;
  } catch {
    return false;
  }
}

function assertScopedFolderEntryMatchesRequest(
  entry: ScopedFolderTraversalJournalEntry,
  request: ScopedFolderTraversalPageRequest
): void {
  const entryRequest: ScopedFolderTraversalPageRequest = {
    selectedRootId: entry.selectedRootId,
    folderId: entry.folderId,
    pageIndex: entry.pageIndex,
    continuation: entry.requestContinuation,
    parentAuthority: entry.parentAuthority,
  };
  if (
    canonicalScopedFolderTraversalJson(entryRequest) !== canonicalScopedFolderTraversalJson(request)
  ) {
    throw new Error('Scoped Folder traversal entry does not match its correlated page request.');
  }
}

function assertScopedFolderHeadMatches(
  actual: ScopedFolderTraversalJournalHead,
  expected: ScopedFolderTraversalJournalHead,
  runId: string
): void {
  if (actual.pageCount !== expected.pageCount || actual.recordHash !== expected.recordHash) {
    throw new Error(`Scoped Folder traversal journal head for run ${runId} is stale.`);
  }
}

function advanceScopedFolderCommandHistoryDigest(
  previousDigest: string,
  row: ScopedFolderCommandHistoryRow
): string {
  return advanceScopedFolderProtectedHistoryDigest(
    SCOPED_FOLDER_COMMAND_HISTORY_SCHEMA,
    previousDigest,
    row
  );
}

function advanceScopedFolderProtectedHistoryDigest(
  schema:
    | typeof SCOPED_FOLDER_COMMAND_HISTORY_SCHEMA
    | typeof SCOPED_FOLDER_ACTIVITY_HISTORY_SCHEMA
    | typeof SCOPED_FOLDER_REQUEST_LEDGER_HISTORY_SCHEMA,
  previousDigest: string,
  row: ScopedFolderCommandHistoryRow
): string {
  if (!SHA256_REF.test(previousDigest) || !Number.isSafeInteger(row.rowid) || row.rowid < 1) {
    throw new Error('Scoped Folder protected history chain input is invalid.');
  }
  const canonicalRow = JSON.stringify([
    schema,
    previousDigest,
    row.rowid,
    row.id,
    row.run_id,
    row.body_json,
  ]);
  return `sha256:${createHash('sha256').update(canonicalRow, 'utf8').digest('hex')}`;
}

function advanceScopedFolderCommandHistoryCache(
  cache: ScopedFolderCommandAuditCache,
  row: ScopedFolderCommandHistoryRow
): Readonly<{
  commandRowCount: number;
  commandHistoryDigest: string;
  lastCommandRowId: number;
}> {
  const advanced = advanceScopedFolderProtectedHistoryCache({
    schema: SCOPED_FOLDER_COMMAND_HISTORY_SCHEMA,
    runId: cache.runId,
    rowCount: cache.commandRowCount,
    historyDigest: cache.commandHistoryDigest,
    lastRowId: cache.lastCommandRowId,
    row,
  });
  return Object.freeze({
    commandRowCount: advanced.rowCount,
    commandHistoryDigest: advanced.historyDigest,
    lastCommandRowId: advanced.lastRowId,
  });
}

function advanceScopedFolderProtectedHistoryCache(
  input: Readonly<{
    schema:
      | typeof SCOPED_FOLDER_COMMAND_HISTORY_SCHEMA
      | typeof SCOPED_FOLDER_ACTIVITY_HISTORY_SCHEMA
      | typeof SCOPED_FOLDER_REQUEST_LEDGER_HISTORY_SCHEMA;
    runId: string;
    rowCount: number;
    historyDigest: string;
    lastRowId: number | null;
    row: ScopedFolderCommandHistoryRow;
  }>
): ScopedFolderProtectedHistoryAdvance {
  if (
    input.row.run_id !== input.runId ||
    (input.lastRowId !== null && input.row.rowid <= input.lastRowId)
  ) {
    throw new Error('Owned protected-history append is not the next immutable history row.');
  }
  return Object.freeze({
    rowCount: input.rowCount + 1,
    historyDigest: advanceScopedFolderProtectedHistoryDigest(
      input.schema,
      input.historyDigest,
      input.row
    ),
    lastRowId: input.row.rowid,
  });
}

function countScopedFolderSettlementRows(
  db: Database.Database,
  table: 'provider_activity_evidence' | 'request_ledger',
  runId: string,
  commandRequestId: string
): number {
  return (
    db
      .prepare(
        `SELECT count(*) AS count
         FROM ${table}
         WHERE run_id = ? AND json_extract(body_json, '$.commandRequestId') = ?`
      )
      .get(runId, commandRequestId) as { count: number }
  ).count;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertExactRecordKeys(
  record: Record<string, unknown>,
  expected: string[],
  label: string
): void {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(`${label} contains non-allowlisted fields.`);
  }
}

function requireOpaqueId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !OPAQUE_ID.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function requireScopedFolderReceiptEpoch(value: unknown): string {
  if (typeof value !== 'string' || !SCOPED_FOLDER_RECEIPT_EPOCH.test(value)) {
    throw new Error('Scoped Folder command receipt epoch is invalid.');
  }
  return value;
}

function requireScopedFolderId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^(?:fld|lib|src)_[A-Za-z0-9]+$/u.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function assertScopedFolderTraversalJournalMatchesRunScope(
  run: MigrationRun,
  journal: ScopedFolderTraversalJournal
): void {
  if (run.scope.kind === 'file') {
    throw new Error('Scoped Folder traversal requires Folder or Folder Tree migration scope.');
  }
  const expected = createScopedFolderTraversalJournal({
    scopeKind: run.scope.kind,
    includeArchived: run.scope.includeArchived === true,
    selectedRootIds:
      run.scope.kind === 'folder' ? [run.scope.folder.id] : run.scope.roots.map(({ id }) => id),
  });
  const actualHeader = {
    ...journal,
    includeArchived: journal.includeArchived === true,
    entries: [],
  } satisfies ScopedFolderTraversalJournal;
  if (
    canonicalScopedFolderTraversalJson(actualHeader) !==
    canonicalScopedFolderTraversalJson(expected)
  ) {
    throw new Error(
      'Scoped Folder traversal journal does not match the immutable migration run scope.'
    );
  }
}

function requireScopedFolderTraversalRunId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 200 ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new Error('Scoped Folder traversal run ID is invalid.');
  }
  return value;
}

function normalizeScopedFolderTraversalHead(
  value: ScopedFolderTraversalJournalHead | unknown
): ScopedFolderTraversalJournalHead {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Scoped Folder traversal expected head is invalid.');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== 'pageCount' || keys[1] !== 'recordHash') {
    throw new Error('Scoped Folder traversal expected head is not canonical.');
  }
  if (
    !Number.isSafeInteger(record.pageCount) ||
    Number(record.pageCount) < 0 ||
    Number(record.pageCount) > SCOPED_FOLDER_MAX_PAGES ||
    typeof record.recordHash !== 'string' ||
    !SHA256_REF.test(record.recordHash)
  ) {
    throw new Error('Scoped Folder traversal expected head is invalid.');
  }
  return Object.freeze({
    pageCount: Number(record.pageCount),
    recordHash: record.recordHash,
  });
}

function scopedFolderTraversalPersistenceHash(value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(canonicalScopedFolderTraversalJson(value))
    .digest('hex')}`;
}

function parseCanonicalScopedFolderTraversalJson(body: string, label: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new Error(`Scoped Folder traversal ${label} is invalid JSON.`);
  }
  if (canonicalScopedFolderTraversalJson(parsed) !== body) {
    throw new Error(`Scoped Folder traversal ${label} is not canonical JSON.`);
  }
  return parsed;
}

function assertImmutableRunFields(existing: MigrationRun, next: MigrationRun): void {
  if (!isDeepStrictEqual(existing.localRetryExclusion, next.localRetryExclusion)) {
    throw new Error('Local retry exclusions are immutable after run creation.');
  }
  if (!isDeepStrictEqual(existing.localBestEffortFallback, next.localBestEffortFallback)) {
    throw new Error('Local best-effort fallback entries are immutable after run creation.');
  }
  const completingInitialFileLocalSourceIntake =
    existing.state === 'draft' &&
    existing.scope.kind === 'file' &&
    existing.scope.acquisition === 'local_bundle' &&
    existing.scope.source.id.startsWith('local-export-pending-') &&
    existing.localExportIntake?.schema === 'dnaforge.benchling.local-export-intake.v1' &&
    !existing.localExportArtifact &&
    !existing.externalZipSource &&
    next.scope.kind === 'file' &&
    next.scope.acquisition === 'local_bundle' &&
    next.scope.source.id.startsWith('local-export-') &&
    !next.localExportIntake &&
    (next.localExportArtifact?.schema === 'dnaforge.benchling.local-export-artifact.v1' ||
      next.externalZipSource?.schema === 'dnaforge.benchling.external-zip-source.v1');
  const attachingFolderLocalIntake =
    existing.scope.kind !== 'file' &&
    existing.scope.acquisition === 'local_bundle' &&
    existing.binding === null &&
    !existing.localExportIntake &&
    !existing.localExportArtifact &&
    !existing.externalZipSource &&
    (existing.state === 'scope_planning' ||
      ((existing.state === 'action_required' || existing.state === 'cancelled_preserved') &&
        existing.resumeState === 'scope_planning')) &&
    next.state === 'scope_planning' &&
    next.binding === null &&
    next.localExportIntake?.schema === 'dnaforge.benchling.local-export-intake.v1' &&
    !next.localExportArtifact &&
    !next.externalZipSource &&
    samePersistedValue(existing.scope, next.scope);
  const completingAttachedFolderLocalSourceIntake =
    existing.scope.kind !== 'file' &&
    existing.scope.acquisition === 'local_bundle' &&
    existing.state === 'scope_planning' &&
    existing.binding === null &&
    existing.localExportIntake?.schema === 'dnaforge.benchling.local-export-intake.v1' &&
    !existing.localExportArtifact &&
    !existing.externalZipSource &&
    next.state === 'scope_planning' &&
    next.binding === null &&
    !next.localExportIntake &&
    (next.localExportArtifact?.schema === 'dnaforge.benchling.local-export-artifact.v1' ||
      next.externalZipSource?.schema === 'dnaforge.benchling.external-zip-source.v1') &&
    samePersistedValue(existing.scope, next.scope);
  const completingLocalSourceIntake =
    completingInitialFileLocalSourceIntake || completingAttachedFolderLocalSourceIntake;
  const abandoningLocalIntake =
    existing.localExportIntake?.schema === 'dnaforge.benchling.local-export-intake.v1' &&
    !existing.localExportArtifact &&
    !existing.externalZipSource &&
    (next.state === 'failed' || next.state === 'action_required') &&
    !next.localExportIntake &&
    !next.localExportArtifact &&
    !next.externalZipSource &&
    samePersistedValue(existing.scope, next.scope);
  if (
    existing.workspaceId !== next.workspaceId ||
    existing.workspacePath !== next.workspacePath ||
    (JSON.stringify(existing.scope) !== JSON.stringify(next.scope) &&
      !completingInitialFileLocalSourceIntake)
  ) {
    throw new Error('Migration workspace and scope are immutable after run creation.');
  }
  if (
    existing.localExportIntake &&
    !completingLocalSourceIntake &&
    !abandoningLocalIntake &&
    !samePersistedValue(existing.localExportIntake, next.localExportIntake)
  ) {
    throw new Error('Local export intake restart authority is immutable after selection.');
  }
  if (!existing.localExportIntake && next.localExportIntake && !attachingFolderLocalIntake) {
    throw new Error('Local export intake restart authority must exist in the initial draft save.');
  }
  if (
    existing.localExportArtifact &&
    !samePersistedValue(existing.localExportArtifact, next.localExportArtifact)
  ) {
    throw new Error('Local export artifact identity is immutable after intake.');
  }
  if (!existing.localExportArtifact && next.localExportArtifact && !completingLocalSourceIntake) {
    throw new Error('Local export artifact may be attached only during initial intake.');
  }
  if (
    existing.externalZipSource &&
    (!samePersistedValue(existing.externalZipSource, next.externalZipSource) ||
      !samePersistedValue(existing.externalZipEntries, next.externalZipEntries))
  ) {
    throw new Error('External ZIP source evidence is immutable after selection.');
  }
  if (!existing.externalZipSource && next.externalZipSource && !completingLocalSourceIntake) {
    throw new Error('External ZIP source may be attached only during initial intake.');
  }
  if (existing.binding && !samePersistedValue(existing.binding, next.binding)) {
    throw new Error('Migration source binding is immutable after confirmation.');
  }
}

function assertExternalZipRunEvidence(run: MigrationRun): void {
  const fallback = run.localBestEffortFallback;
  if (fallback) {
    if (
      run.scope.kind !== 'file' ||
      run.scope.acquisition !== 'local_bundle' ||
      !SHA256_REF.test(fallback.zipSha256) ||
      !stableNonemptyString(fallback.priorRunId) ||
      fallback.priorRunId === run.id ||
      (fallback.rootRunId !== undefined &&
        (!stableNonemptyString(fallback.rootRunId) || fallback.rootRunId === run.id)) ||
      !Array.isArray(fallback.entryPaths) ||
      fallback.entryPaths.length === 0 ||
      new Set(fallback.entryPaths).size !== fallback.entryPaths.length ||
      fallback.entryPaths.some(
        (entryPath) =>
          !stableNonemptyString(entryPath) ||
          entryPath.startsWith('/') ||
          entryPath.includes('\\') ||
          entryPath
            .split('/')
            .some((segment) => segment === '..' || segment === '.' || segment === '')
      )
    ) {
      throw new Error('Local best-effort fallback evidence is invalid.');
    }
    if (run.externalZipSource) {
      if (
        run.externalZipSource.zipSha256 !== fallback.zipSha256 ||
        fallback.entryPaths.some(
          (entryPath) =>
            !run.externalZipEntries?.some(
              (entry) => entry.entryPath === entryPath && entry.role === 'source-record'
            )
        )
      ) {
        throw new Error('Local best-effort fallback does not match the selected ZIP.');
      }
    } else if (!run.localExportIntake && run.state !== 'failed') {
      throw new Error('Local best-effort fallback requires a pending or selected ZIP.');
    }
  }
  const exclusion = run.localRetryExclusion;
  if (exclusion) {
    if (
      run.scope.kind !== 'file' ||
      run.scope.acquisition !== 'local_bundle' ||
      !SHA256_REF.test(exclusion.zipSha256) ||
      !Array.isArray(exclusion.entryPaths) ||
      exclusion.entryPaths.length === 0 ||
      new Set(exclusion.entryPaths).size !== exclusion.entryPaths.length ||
      exclusion.entryPaths.some(
        (entryPath) =>
          !stableNonemptyString(entryPath) ||
          entryPath.startsWith('/') ||
          entryPath.includes('\\') ||
          entryPath
            .split('/')
            .some((segment) => segment === '..' || segment === '.' || segment === '')
      )
    ) {
      throw new Error('Local retry exclusion evidence is invalid.');
    }
    if (run.externalZipSource) {
      if (
        run.externalZipSource.zipSha256 !== exclusion.zipSha256 ||
        exclusion.entryPaths.some(
          (entryPath) =>
            !run.externalZipEntries?.some(
              (entry) => entry.entryPath === entryPath && entry.role === 'source-record'
            )
        )
      ) {
        throw new Error('Local retry exclusion does not match the selected ZIP.');
      }
    } else if (!run.localExportIntake && run.state !== 'failed') {
      throw new Error('Local retry exclusion requires a pending or selected ZIP.');
    }
  }
  if (!run.externalZipSource) {
    if (run.externalZipEntries !== undefined) {
      throw new Error('External ZIP entry evidence requires its source record.');
    }
    return;
  }
  if (run.localExportArtifact || run.localExportIntake) {
    throw new Error('External ZIP source cannot coexist with legacy local source state.');
  }
  const source = run.externalZipSource;
  const entries = run.externalZipEntries;
  if (
    source.schema !== 'dnaforge.benchling.external-zip-source.v1' ||
    !stableNonemptyString(source.sourceId) ||
    !isAbsolute(source.originalPath) ||
    !stableNonemptyString(source.displayName) ||
    !SHA256_REF.test(source.zipSha256) ||
    !nonnegativeSafeInteger(source.sizeBytes) ||
    !Number.isFinite(Date.parse(source.selectedAt)) ||
    !Array.isArray(entries)
  ) {
    throw new Error('External ZIP source evidence is invalid.');
  }
  const entryPaths = new Set<string>();
  for (const entry of entries) {
    if (
      entry.schema !== 'dnaforge.benchling.external-zip-entry.v1' ||
      entry.sourceId !== source.sourceId ||
      !stableNonemptyString(entry.sourceObjectId) ||
      !stableNonemptyString(entry.entryPath) ||
      entryPaths.has(entry.entryPath) ||
      !SHA256_REF.test(entry.entrySha256) ||
      !nonnegativeSafeInteger(entry.sizeBytes) ||
      !(entry.mediaType === null || stableNonemptyString(entry.mediaType)) ||
      !['source-record', 'attachment'].includes(entry.role)
    ) {
      throw new Error('External ZIP entry evidence is invalid.');
    }
    entryPaths.add(entry.entryPath);
  }
}

function samePersistedValue(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(
    JSON.parse(JSON.stringify(left)) as unknown,
    JSON.parse(JSON.stringify(right)) as unknown
  );
}

function snapshotMetadata(snapshot: SourceSnapshot): SourceSnapshotMetadata {
  return {
    version: snapshot.version,
    id: snapshot.id,
    runId: snapshot.runId,
    accountHash: snapshot.accountHash,
    createdAt: snapshot.createdAt,
    archiveManifestId: snapshot.archiveManifestId,
    initialSourceObjectIds: [...snapshot.initialSourceObjectIds],
    expectedSourceObjectCount: snapshot.expectedSourceObjectCount,
    expectedAttachmentCount: snapshot.expectedAttachmentCount,
    expectedMembershipCount: snapshot.expectedMembershipCount,
    ...(snapshot.localExportWarnings === undefined
      ? {}
      : { localExportWarnings: [...snapshot.localExportWarnings] }),
    ...(snapshot.localNativeFolderZipInventory === undefined
      ? {}
      : {
          localNativeFolderZipInventory: JSON.parse(
            JSON.stringify(snapshot.localNativeFolderZipInventory)
          ),
        }),
  };
}

function assertValidSourceSnapshotMetadata(snapshot: SourceSnapshot): void {
  if (snapshot.archiveManifestId.trim() === '') {
    throw new Error(`Source snapshot ${snapshot.id} requires an archive manifest ID.`);
  }
  for (const [label, value] of [
    ['source object', snapshot.expectedSourceObjectCount],
    ['attachment', snapshot.expectedAttachmentCount],
    ['membership', snapshot.expectedMembershipCount],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(
        `Source snapshot ${snapshot.id} expected ${label} count must be non-negative.`
      );
    }
  }
  if (
    !Array.isArray(snapshot.initialSourceObjectIds) ||
    snapshot.initialSourceObjectIds.length !== snapshot.expectedSourceObjectCount ||
    snapshot.initialSourceObjectIds.some(
      (sourceObjectId) => typeof sourceObjectId !== 'string' || sourceObjectId.trim().length === 0
    ) ||
    new Set(snapshot.initialSourceObjectIds).size !== snapshot.initialSourceObjectIds.length ||
    snapshot.initialSourceObjectIds.some(
      (sourceObjectId, index) =>
        index > 0 && snapshot.initialSourceObjectIds[index - 1]! >= sourceObjectId
    )
  ) {
    throw new Error(`Source snapshot ${snapshot.id} initial source identities are invalid.`);
  }
  if (snapshot.localExportWarnings !== undefined) {
    if (
      !Array.isArray(snapshot.localExportWarnings) ||
      snapshot.localExportWarnings.length > 10_000 ||
      snapshot.localExportWarnings.some(
        (warning) =>
          typeof warning !== 'string' || warning.trim().length === 0 || warning.length > 2_048
      ) ||
      new Set(snapshot.localExportWarnings).size !== snapshot.localExportWarnings.length
    ) {
      throw new Error(`Source snapshot ${snapshot.id} local export warnings are invalid.`);
    }
  }
  if (
    snapshot.localNativeFolderZipInventory !== undefined &&
    !isLocalNativeFolderZipInventory(snapshot.localNativeFolderZipInventory)
  ) {
    throw new Error(`Source snapshot ${snapshot.id} local Folder ZIP inventory is invalid.`);
  }
}

function assertLinkedItemRecoveryRun(
  run: MigrationRun | null,
  runId: string
): asserts run is MigrationRun {
  if (
    !run ||
    run.id !== runId ||
    (run.state !== 'ready_to_unlock' && run.state !== 'unlocked') ||
    run.binding !== null ||
    run.scope.acquisition !== 'local_bundle' ||
    !(
      run.baseline?.kind === 'adopted_workspace' ||
      run.externalZipSource?.schema === 'dnaforge.benchling.external-zip-source.v1' ||
      run.localExportArtifact?.schema === 'dnaforge.benchling.local-export-artifact.v1'
    )
  ) {
    throw new Error(
      `Linked-item recovery requires a validated local-bundle migration run ${runId}.`
    );
  }
}

const LINKED_ITEM_RECOVERY_STATES = new Set<LinkedItemRecoveryAttemptState>([
  'copying',
  'parsing',
  'awaiting_conflict_resolution',
  'reconciling',
  'validating',
  'completed',
  'failed',
]);

const LINKED_ITEM_RECOVERY_TRANSITIONS: Readonly<
  Record<
    Exclude<LinkedItemRecoveryAttemptState, 'failed'>,
    ReadonlySet<LinkedItemRecoveryAttemptState>
  >
> = {
  copying: new Set(['copying', 'parsing', 'failed']),
  parsing: new Set(['parsing', 'awaiting_conflict_resolution', 'reconciling', 'failed']),
  awaiting_conflict_resolution: new Set([
    'awaiting_conflict_resolution',
    'parsing',
    'reconciling',
    'failed',
  ]),
  reconciling: new Set(['reconciling', 'awaiting_conflict_resolution', 'validating', 'failed']),
  validating: new Set(['validating', 'completed', 'failed']),
  completed: new Set(['completed']),
};

const LINKED_ITEM_RECOVERY_ATTEMPT_MODES: ReadonlySet<string> = new Set([
  'linked_item_recovery',
  'workspace_append',
]);

function assertValidLinkedItemRecoveryAttempt(
  candidate: unknown
): asserts candidate is LinkedItemRecoveryAttempt {
  const record = requireRecord(candidate, 'Linked-item recovery attempt');
  assertExactRecordKeys(
    record,
    [
      'artifactIds',
      ...(record.bestEffortFallback === undefined ? [] : ['bestEffortFallback']),
      ...(record.sourceClaimsSha256 === undefined ? [] : ['sourceClaimsSha256']),
      'completedAt',
      'corroboratedExistingObjectCount',
      'createdAt',
      'fileResults',
      'id',
      'intakeDescriptors',
      'mode',
      'pendingImportDecision',
      'pendingImportDecisionResumeState',
      'processedFileCount',
      'recoveryPlan',
      'recoveredUniqueObjectCount',
      'repairedRelationshipCount',
      'resumeState',
      'retainedExistingObjectCount',
      'retainedExistingObjects',
      'runId',
      'safeFailure',
      'schema',
      'selectedFileCount',
      'state',
      'updatedAt',
      'versionConflictResolution',
    ],
    'Linked-item recovery attempt'
  );
  const attempt = record as LinkedItemRecoveryAttempt;
  if (attempt.bestEffortFallback !== undefined) {
    const fallback = requireRecord(attempt.bestEffortFallback, 'Linked-item fallback authority');
    assertExactRecordKeys(
      fallback,
      ['priorAttemptId', 'sources'],
      'Linked-item fallback authority'
    );
    if (
      !stableNonemptyString(fallback.priorAttemptId) ||
      !validLinkedItemFallbackSources(fallback.sources)
    ) {
      throw new Error('Linked-item fallback authority is invalid.');
    }
  }
  if (
    attempt.sourceClaimsSha256 !== undefined &&
    !/^sha256:[a-f0-9]{64}$/u.test(attempt.sourceClaimsSha256)
  )
    throw new Error('Linked-item recovery source claims digest is invalid.');
  if (
    attempt.schema !== 'dnaforge.benchling.linked-item-recovery-attempt.v1' ||
    !stableNonemptyString(attempt.id) ||
    !stableNonemptyString(attempt.runId) ||
    !LINKED_ITEM_RECOVERY_ATTEMPT_MODES.has(attempt.mode) ||
    !LINKED_ITEM_RECOVERY_STATES.has(attempt.state) ||
    !Array.isArray(attempt.intakeDescriptors) ||
    !Array.isArray(attempt.fileResults) ||
    attempt.intakeDescriptors.length === 0 ||
    !Array.isArray(attempt.artifactIds) ||
    attempt.artifactIds.some((id) => !stableNonemptyString(id)) ||
    new Set(attempt.artifactIds).size !== attempt.artifactIds.length ||
    !Number.isSafeInteger(attempt.selectedFileCount) ||
    attempt.selectedFileCount !== attempt.intakeDescriptors.length ||
    !Number.isSafeInteger(attempt.processedFileCount) ||
    attempt.processedFileCount < 0 ||
    attempt.processedFileCount !== attempt.fileResults.length ||
    attempt.processedFileCount > attempt.selectedFileCount ||
    attempt.artifactIds.length > attempt.selectedFileCount ||
    !Number.isSafeInteger(attempt.recoveredUniqueObjectCount) ||
    attempt.recoveredUniqueObjectCount < 0 ||
    !Number.isSafeInteger(attempt.repairedRelationshipCount) ||
    attempt.repairedRelationshipCount < 0 ||
    !Number.isSafeInteger(attempt.retainedExistingObjectCount) ||
    attempt.retainedExistingObjectCount < 0 ||
    !Number.isSafeInteger(attempt.corroboratedExistingObjectCount) ||
    attempt.corroboratedExistingObjectCount < 0 ||
    !Array.isArray(attempt.retainedExistingObjects) ||
    attempt.retainedExistingObjects.length !== attempt.retainedExistingObjectCount ||
    attempt.retainedExistingObjects.some(
      (entry) =>
        !entry ||
        typeof entry !== 'object' ||
        !stableNonemptyString((entry as { stableId?: unknown }).stableId) ||
        typeof (entry as { name?: unknown }).name !== 'string'
    ) ||
    new Set(attempt.retainedExistingObjects.map((entry) => entry.stableId)).size !==
      attempt.retainedExistingObjects.length ||
    !isValidVersionConflictResolution(attempt.versionConflictResolution) ||
    (attempt.pendingImportDecision !== null &&
      !isPendingImportDecision(attempt.pendingImportDecision)) ||
    (attempt.state === 'awaiting_conflict_resolution' ||
      (attempt.state === 'failed' && attempt.resumeState === 'awaiting_conflict_resolution')) !==
      (attempt.pendingImportDecision !== null) ||
    (attempt.pendingImportDecision === null) !==
      (attempt.pendingImportDecisionResumeState === null) ||
    (attempt.pendingImportDecision?.kind === 'provider_version_conflict') !==
      (attempt.versionConflictResolution.kind === 'awaiting_choice') ||
    !Number.isFinite(Date.parse(attempt.createdAt)) ||
    !Number.isFinite(Date.parse(attempt.updatedAt)) ||
    Date.parse(attempt.updatedAt) < Date.parse(attempt.createdAt)
  ) {
    throw new Error('Linked-item recovery attempt is invalid.');
  }
  const resultArtifactIds = new Set<string>();
  for (const [index, result] of attempt.fileResults.entries()) {
    const record = requireRecord(result, 'Linked-item recovery file result');
    assertExactRecordKeys(
      record,
      ['artifactId', 'failure', 'fileIndex', 'outcome'],
      'Linked-item recovery file result'
    );
    if (
      result.fileIndex !== index ||
      !['accepted', 'duplicate', 'rejected'].includes(result.outcome)
    ) {
      throw new Error('Linked-item recovery file result is invalid.');
    }
    if (result.outcome === 'rejected') {
      if (result.artifactId !== null || result.failure === null) {
        throw new Error('Rejected linked-item recovery file result is invalid.');
      }
      assertValidLinkedItemRecoverySafeFailure(result.failure);
    } else {
      if (!stableNonemptyString(result.artifactId) || result.failure !== null) {
        throw new Error('Accepted linked-item recovery file result is invalid.');
      }
      resultArtifactIds.add(result.artifactId);
    }
  }
  if (
    resultArtifactIds.size !== attempt.artifactIds.length ||
    attempt.artifactIds.some((artifactId) => !resultArtifactIds.has(artifactId))
  ) {
    throw new Error('Linked-item recovery file results do not match accepted artifacts.');
  }
  if (attempt.recoveryPlan === null) {
    if (attempt.mode !== 'workspace_append') {
      throw new Error('A linked-item recovery attempt requires a recovery plan.');
    }
  } else {
    assertValidLinkedItemRecoveryPlan(attempt.recoveryPlan);
  }
  for (const descriptor of attempt.intakeDescriptors) {
    assertValidLinkedItemRecoveryIntakeDescriptor(descriptor);
  }
  if (attempt.state === 'failed') {
    if (!attempt.resumeState || !attempt.safeFailure || attempt.completedAt !== null) {
      throw new Error(`Failed linked-item recovery attempt ${attempt.id} is not resumable.`);
    }
    assertValidLinkedItemRecoverySafeFailure(attempt.safeFailure);
    return;
  }
  if (attempt.resumeState !== null || attempt.safeFailure !== null) {
    throw new Error(`Active linked-item recovery attempt ${attempt.id} contains failure state.`);
  }
  if (attempt.state === 'completed') {
    if (
      attempt.completedAt === null ||
      !Number.isFinite(Date.parse(attempt.completedAt)) ||
      Date.parse(attempt.completedAt) !== Date.parse(attempt.updatedAt) ||
      attempt.processedFileCount !== attempt.selectedFileCount
    ) {
      throw new Error(`Completed linked-item recovery attempt ${attempt.id} is invalid.`);
    }
  } else if (attempt.completedAt !== null) {
    throw new Error(`Active linked-item recovery attempt ${attempt.id} cannot be completed.`);
  }
}

function isValidVersionConflictResolution(
  candidate: unknown
): candidate is LinkedItemRecoveryVersionConflictResolution {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
  const resolution = candidate as Record<string, unknown>;
  if (resolution.kind === 'none') {
    return Object.keys(resolution).length === 1;
  }
  if (resolution.kind === 'awaiting_choice') {
    return Object.keys(resolution).length === 2 && isValidVersionConflict(resolution.firstConflict);
  }
  if (resolution.kind !== 'resolved') return false;
  if (
    Object.keys(resolution).length !== 3 ||
    (resolution.policy !== 'keep_existing' && resolution.policy !== 'use_incoming') ||
    !Array.isArray(resolution.conflicts) ||
    resolution.conflicts.length === 0 ||
    resolution.conflicts.some((conflict) => !isValidVersionConflict(conflict))
  ) {
    return false;
  }
  const conflicts = resolution.conflicts as readonly LinkedItemRecoveryVersionConflict[];
  return (
    new Set(conflicts.map((conflict) => conflict.sourceObjectId)).size === conflicts.length &&
    new Set(conflicts.map((conflict) => conflict.stableId)).size === conflicts.length
  );
}

function isValidVersionConflict(
  candidate: unknown
): candidate is LinkedItemRecoveryVersionConflict {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
  const conflict = candidate as Record<string, unknown>;
  return (
    Object.keys(conflict).length === 4 &&
    stableNonemptyString(conflict.sourceObjectId) &&
    stableNonemptyString(conflict.stableId) &&
    typeof conflict.name === 'string' &&
    (conflict.expectedPriorScientificContentSha256 === null ||
      (typeof conflict.expectedPriorScientificContentSha256 === 'string' &&
        SHA256_REF.test(conflict.expectedPriorScientificContentSha256)))
  );
}

function assertLinkedItemRecoveryAttemptUpdate(
  existing: LinkedItemRecoveryAttempt,
  next: LinkedItemRecoveryAttempt
): void {
  if (JSON.stringify(existing) === JSON.stringify(next)) return;
  if (
    existing.id !== next.id ||
    existing.runId !== next.runId ||
    existing.schema !== next.schema ||
    existing.createdAt !== next.createdAt ||
    existing.selectedFileCount !== next.selectedFileCount ||
    existing.mode !== next.mode ||
    !isDeepStrictEqual(existing.bestEffortFallback, next.bestEffortFallback) ||
    (existing.sourceClaimsSha256 !== undefined &&
      existing.sourceClaimsSha256 !== next.sourceClaimsSha256) ||
    !isDeepStrictEqual(existing.recoveryPlan, next.recoveryPlan) ||
    JSON.stringify(existing.intakeDescriptors) !== JSON.stringify(next.intakeDescriptors)
  ) {
    throw new Error(`Linked-item recovery attempt ${existing.id} changed immutable authority.`);
  }
  if (
    Date.parse(next.updatedAt) <= Date.parse(existing.updatedAt) ||
    next.processedFileCount < existing.processedFileCount ||
    next.recoveredUniqueObjectCount < existing.recoveredUniqueObjectCount ||
    next.repairedRelationshipCount < existing.repairedRelationshipCount ||
    next.retainedExistingObjectCount < existing.retainedExistingObjectCount ||
    next.corroboratedExistingObjectCount < existing.corroboratedExistingObjectCount ||
    next.retainedExistingObjects.length < existing.retainedExistingObjects.length ||
    existing.artifactIds.some((id, index) => next.artifactIds[index] !== id) ||
    existing.fileResults.some(
      (result, index) => !isDeepStrictEqual(result, next.fileResults[index])
    )
  ) {
    throw new Error(`Linked-item recovery attempt ${existing.id} did not advance monotonically.`);
  }
  if (existing.state === 'completed' || existing.state === 'failed') {
    throw new Error(`Terminal linked-item recovery attempt ${existing.id} is immutable.`);
  }
  const stateAllowed = LINKED_ITEM_RECOVERY_TRANSITIONS[existing.state].has(next.state);
  if (!stateAllowed) {
    throw new Error(
      `Linked-item recovery attempt ${existing.id} cannot transition from ${existing.state} to ${next.state}.`
    );
  }
  assertVersionConflictResolutionUpdate(
    existing.id,
    existing.versionConflictResolution,
    next.versionConflictResolution
  );
  assertPendingImportDecisionUpdate(existing, next);
}

function assertPendingImportDecisionUpdate(
  existing: LinkedItemRecoveryAttempt,
  next: LinkedItemRecoveryAttempt
): void {
  const previous = existing.pendingImportDecision;
  const current = next.pendingImportDecision;
  if (previous === null && current === null) return;
  if (previous === null && current !== null) {
    if (next.state === 'awaiting_conflict_resolution') return;
  } else if (previous !== null && current !== null) {
    if (
      isDeepStrictEqual(previous, current) &&
      existing.pendingImportDecisionResumeState === next.pendingImportDecisionResumeState
    ) {
      return;
    }
  } else if (
    previous !== null &&
    current === null &&
    next.state === existing.pendingImportDecisionResumeState
  ) {
    return;
  }
  throw new Error(
    `Linked-item recovery attempt ${existing.id} changed its pending import decision.`
  );
}

function assertVersionConflictResolutionUpdate(
  attemptId: string,
  existing: LinkedItemRecoveryVersionConflictResolution,
  next: LinkedItemRecoveryVersionConflictResolution
): void {
  if (existing.kind === 'none') {
    if (next.kind === 'none' || next.kind === 'awaiting_choice') return;
  } else if (existing.kind === 'awaiting_choice') {
    if (
      (next.kind === 'awaiting_choice' &&
        isDeepStrictEqual(existing.firstConflict, next.firstConflict)) ||
      (next.kind === 'resolved' && isDeepStrictEqual(existing.firstConflict, next.conflicts[0]))
    ) {
      return;
    }
  } else if (
    next.kind === 'resolved' &&
    next.policy === existing.policy &&
    existing.conflicts.every((conflict, index) =>
      isDeepStrictEqual(conflict, next.conflicts[index])
    )
  ) {
    return;
  }
  throw new Error(
    `Linked-item recovery attempt ${attemptId} changed its version-conflict decision.`
  );
}

function assertValidLinkedItemRecoveryPlan(plan: ValidationLinkedItemRecoveryEvidence): void {
  const record = requireRecord(plan, 'Linked-item recovery plan');
  assertExactRecordKeys(
    record,
    [
      'attempts',
      'folderCount',
      'folders',
      'organizationBaseUrl',
      'recoveredUniqueObjectCount',
      'relationshipCount',
      'remainingRelationshipCount',
      'remainingUniqueObjectCount',
      'repairedRelationshipCount',
      'schema',
      'targets',
      'uniqueTargetCount',
    ],
    'Linked-item recovery plan'
  );
  if (
    plan.schema !== 'dnaforge.benchling.linked-item-recovery-validation.v1' ||
    !safeRecoveryUrl(plan.organizationBaseUrl) ||
    !Array.isArray(plan.folders) ||
    !Array.isArray(plan.targets) ||
    !Array.isArray(plan.attempts) ||
    !nonnegativeSafeInteger(plan.relationshipCount) ||
    !nonnegativeSafeInteger(plan.uniqueTargetCount) ||
    !nonnegativeSafeInteger(plan.folderCount) ||
    !nonnegativeSafeInteger(plan.recoveredUniqueObjectCount) ||
    !nonnegativeSafeInteger(plan.remainingUniqueObjectCount) ||
    !nonnegativeSafeInteger(plan.repairedRelationshipCount) ||
    !nonnegativeSafeInteger(plan.remainingRelationshipCount) ||
    plan.uniqueTargetCount !== plan.targets.length ||
    plan.folderCount !== plan.folders.length ||
    plan.recoveredUniqueObjectCount + plan.remainingUniqueObjectCount !== plan.uniqueTargetCount ||
    plan.repairedRelationshipCount + plan.remainingRelationshipCount !== plan.relationshipCount
  ) {
    throw new Error('Linked-item recovery plan is invalid.');
  }

  const folderIds = new Set<string>();
  for (const folder of plan.folders) {
    const folderRecord = requireRecord(folder, 'Linked-item recovery folder');
    assertExactRecordKeys(
      folderRecord,
      [
        'countsByType',
        'name',
        'recoveredTargetCount',
        'relationshipCount',
        'sourceId',
        'sourceUrl',
        'targetCount',
      ],
      'Linked-item recovery folder'
    );
    const counts = requireRecord(folder.countsByType, 'Linked-item recovery folder counts');
    assertExactRecordKeys(
      counts,
      ['dna_rna_sequence', 'other', 'protein', 'protocol'],
      'Linked-item recovery folder counts'
    );
    const countValues = [
      folder.countsByType.dna_rna_sequence,
      folder.countsByType.other,
      folder.countsByType.protein,
      folder.countsByType.protocol,
    ];
    if (
      !stableNonemptyString(folder.sourceId) ||
      folderIds.has(folder.sourceId) ||
      !stableNonemptyString(folder.name) ||
      !safeRecoveryUrl(folder.sourceUrl) ||
      !nonnegativeSafeInteger(folder.targetCount) ||
      !nonnegativeSafeInteger(folder.relationshipCount) ||
      !nonnegativeSafeInteger(folder.recoveredTargetCount) ||
      folder.recoveredTargetCount > folder.targetCount ||
      !countValues.every(nonnegativeSafeInteger) ||
      countValues.reduce((sum, value) => sum + value, 0) !== folder.targetCount
    ) {
      throw new Error('Linked-item recovery folder is invalid.');
    }
    folderIds.add(folder.sourceId);
  }

  const targetIds = new Set<string>();
  const relationshipIds = new Set<string>();
  for (const target of plan.targets) {
    const targetRecord = requireRecord(target, 'Linked-item recovery target');
    assertExactRecordKeys(
      targetRecord,
      [
        'folderId',
        'name',
        'objectType',
        'recovered',
        'relationshipCount',
        'relationshipIds',
        'sourceId',
        'sourceUrl',
      ],
      'Linked-item recovery target'
    );
    if (
      !stableNonemptyString(target.sourceId) ||
      targetIds.has(target.sourceId) ||
      !stableNonemptyString(target.name) ||
      !safeRecoveryUrl(target.sourceUrl) ||
      !['dna_rna_sequence', 'protein', 'protocol', 'other'].includes(target.objectType) ||
      !stableNonemptyString(target.folderId) ||
      !folderIds.has(target.folderId) ||
      !Array.isArray(target.relationshipIds) ||
      !nonnegativeSafeInteger(target.relationshipCount) ||
      target.relationshipCount !== target.relationshipIds.length ||
      typeof target.recovered !== 'boolean' ||
      target.relationshipIds.some(
        (relationshipId: string) =>
          !stableNonemptyString(relationshipId) || relationshipIds.has(relationshipId)
      )
    ) {
      throw new Error('Linked-item recovery target is invalid.');
    }
    targetIds.add(target.sourceId);
    for (const relationshipId of target.relationshipIds as readonly string[]) {
      relationshipIds.add(relationshipId);
    }
  }
  if (
    relationshipIds.size !== plan.relationshipCount ||
    [...targetIds].filter(
      (targetId) => plan.targets.find((target) => target.sourceId === targetId)?.recovered
    ).length !== plan.recoveredUniqueObjectCount
  ) {
    throw new Error('Linked-item recovery target counts are invalid.');
  }

  const attemptIds = new Set<string>();
  for (const attempt of plan.attempts) {
    const attemptRecord = requireRecord(attempt, 'Linked-item recovery plan attempt');
    assertExactRecordKeys(
      attemptRecord,
      [
        'acceptedFileCount',
        'attemptId',
        'completedAt',
        'duplicateFileCount',
        'outcome',
        'rejectedFileCount',
        'recoveredTargetCount',
        'repairedRelationshipCount',
        'selectedFileCount',
      ],
      'Linked-item recovery plan attempt'
    );
    if (
      !stableNonemptyString(attempt.attemptId) ||
      attemptIds.has(attempt.attemptId) ||
      !nonnegativeSafeInteger(attempt.selectedFileCount) ||
      !nonnegativeSafeInteger(attempt.acceptedFileCount) ||
      !nonnegativeSafeInteger(attempt.duplicateFileCount) ||
      !nonnegativeSafeInteger(attempt.rejectedFileCount) ||
      attempt.acceptedFileCount > attempt.selectedFileCount ||
      attempt.duplicateFileCount > attempt.selectedFileCount ||
      attempt.rejectedFileCount > attempt.selectedFileCount ||
      attempt.acceptedFileCount + attempt.duplicateFileCount + attempt.rejectedFileCount !==
        attempt.selectedFileCount ||
      !nonnegativeSafeInteger(attempt.recoveredTargetCount) ||
      !nonnegativeSafeInteger(attempt.repairedRelationshipCount) ||
      !['completed', 'partial', 'failed'].includes(attempt.outcome) ||
      !Number.isFinite(Date.parse(attempt.completedAt))
    ) {
      throw new Error('Linked-item recovery plan attempt is invalid.');
    }
    attemptIds.add(attempt.attemptId);
  }
}

function safeRecoveryUrl(value: unknown): value is string {
  if (!stableNonemptyString(value)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

function nonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function assertValidLinkedItemRecoverySafeFailure(failure: LinkedItemRecoverySafeFailure): void {
  const record = requireRecord(failure, 'Linked-item recovery safe failure');
  assertExactRecordKeys(
    record,
    [
      'code',
      'message',
      'retryable',
      ...(record.bestEffortFallbackSources === undefined ? [] : ['bestEffortFallbackSources']),
    ],
    'Linked-item recovery safe failure'
  );
  if (
    ![
      'copy_failed',
      'source_unavailable',
      'unsafe_archive',
      'decode_failed',
      'target_mismatch',
      'projection_failed',
      'validation_failed',
      'internal',
    ].includes(failure.code) ||
    !stableNonemptyString(failure.message) ||
    failure.message.length > 1_024 ||
    typeof failure.retryable !== 'boolean' ||
    (failure.bestEffortFallbackSources !== undefined &&
      !validLinkedItemFallbackSources(failure.bestEffortFallbackSources))
  ) {
    throw new Error('Linked-item recovery safe failure is invalid.');
  }
}

function validLinkedItemFallbackSources(
  candidate: unknown
): candidate is readonly LinkedItemBestEffortFallbackSource[] {
  if (!Array.isArray(candidate) || candidate.length === 0) return false;
  const seenSha = new Set<string>();
  for (const value of candidate) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(',') !== 'entryPaths,zipSha256' ||
      typeof record.zipSha256 !== 'string' ||
      !SHA256_REF.test(record.zipSha256) ||
      seenSha.has(record.zipSha256) ||
      !Array.isArray(record.entryPaths) ||
      record.entryPaths.length === 0 ||
      record.entryPaths.some(
        (path: unknown) => typeof path !== 'string' || !isSafeWorkspaceRelativePath(path)
      ) ||
      new Set(record.entryPaths).size !== record.entryPaths.length
    )
      return false;
    seenSha.add(record.zipSha256);
  }
  return true;
}

function parseImportDecision(bodyJson: string): ImportDecision {
  const candidate = JSON.parse(bodyJson) as unknown;
  assertValidImportDecision(candidate);
  return candidate;
}

function assertValidImportDecision(candidate: unknown): asserts candidate is ImportDecision {
  const decision = requireRecord(candidate, 'Import decision');
  if (decision.kind === 'registry_table_mapping') {
    parseRegistryTableMappingDecision(decision);
    return;
  }
  if (decision.kind === 'provider_version_conflict') {
    assertExactRecordKeys(decision, ['kind', 'policy'], 'Provider version conflict decision');
    if (decision.policy !== 'keep_existing' && decision.policy !== 'use_incoming') {
      throw new Error('Provider version conflict decision policy is invalid.');
    }
    return;
  }
  if (decision.kind === 'unbound_exact_match') {
    assertExactRecordKeys(
      decision,
      [
        'candidateEntityId',
        'expectedBindingState',
        'expectedCandidateScientificSha256',
        'kind',
        'policy',
        'sourceObjectId',
      ],
      'Unbound exact-match decision'
    );
    if (
      !stableNonemptyString(decision.sourceObjectId) ||
      !stableNonemptyString(decision.candidateEntityId) ||
      !SHA256_REF.test(String(decision.expectedCandidateScientificSha256)) ||
      decision.expectedBindingState !== 'unbound' ||
      (decision.policy !== 'link_existing' && decision.policy !== 'import_separate')
    ) {
      throw new Error('Unbound exact-match decision is invalid.');
    }
    return;
  }
  if (decision.kind === 'structural_path_conflict') {
    assertExactRecordKeys(
      decision,
      ['expectedExistingState', 'kind', 'policy', 'relativePath'],
      'Structural path conflict decision'
    );
    if (
      !stableNonemptyString(decision.relativePath) ||
      !isSafeWorkspaceRelativePath(decision.relativePath)
    ) {
      throw new Error('Structural path conflict decision relative path is invalid.');
    }
    assertValidExistingPathFingerprint(decision.expectedExistingState);
    if (
      decision.policy !== 'rename_incoming' &&
      decision.policy !== 'replace_existing' &&
      decision.policy !== 'cancel_import'
    ) {
      throw new Error('Structural path conflict decision policy is invalid.');
    }
    return;
  }
  throw new Error('Import decision kind is invalid.');
}

function assertValidExistingPathFingerprint(
  candidate: unknown
): asserts candidate is ExistingPathFingerprint {
  const fingerprint = requireRecord(candidate, 'Existing path fingerprint');
  if (fingerprint.kind === 'file') {
    assertExactRecordKeys(
      fingerprint,
      ['kind', 'sha256', 'sizeBytes'],
      'Existing file fingerprint'
    );
    if (
      !SHA256_REF.test(String(fingerprint.sha256)) ||
      !nonnegativeSafeInteger(fingerprint.sizeBytes)
    ) {
      throw new Error('Existing file fingerprint is invalid.');
    }
    return;
  }
  if (fingerprint.kind === 'directory') {
    assertExactRecordKeys(fingerprint, ['kind', 'treeSha256'], 'Existing directory fingerprint');
    if (!SHA256_REF.test(String(fingerprint.treeSha256))) {
      throw new Error('Existing directory fingerprint is invalid.');
    }
    return;
  }
  throw new Error('Existing path fingerprint kind is invalid.');
}

function assertValidLinkedItemRecoveryIntakeDescriptor(
  descriptor: LocalBenchlingExportIntakeDescriptor
): void {
  if (
    !descriptor ||
    descriptor.schema !== 'dnaforge.benchling.local-export-intake.v1' ||
    descriptor.format !== 'zip' ||
    !stableNonemptyString(descriptor.sourcePath) ||
    !stableNonemptyString(descriptor.logicalFilename) ||
    !Number.isFinite(Date.parse(descriptor.selectedAt)) ||
    !Number.isSafeInteger(descriptor.plannedCopyBytes) ||
    descriptor.plannedCopyBytes < 0 ||
    !Array.isArray(descriptor.plannedResources) ||
    descriptor.plannedResources.length !== 0 ||
    !descriptor.sourceIdentity ||
    !stableNonemptyString(descriptor.sourceIdentity.deviceId) ||
    !stableNonemptyString(descriptor.sourceIdentity.inode) ||
    !Number.isSafeInteger(descriptor.sourceIdentity.sizeBytes) ||
    descriptor.sourceIdentity.sizeBytes < 0 ||
    !stableNonemptyString(descriptor.sourceIdentity.modifiedTimeNs) ||
    !stableNonemptyString(descriptor.sourceIdentity.changedTimeNs)
  ) {
    throw new Error('Linked-item recovery intake descriptor is invalid.');
  }
}

function withLinkedItemRecoveryAttemptDefaults(candidate: unknown): unknown {
  const record = requireRecord(candidate, 'Linked-item recovery attempt');
  const withMode = record.mode === undefined ? { ...record, mode: 'linked_item_recovery' } : record;
  const withRetained =
    withMode.retainedExistingObjectCount === undefined
      ? { ...withMode, retainedExistingObjectCount: 0 }
      : withMode;
  const withObjects =
    withRetained.retainedExistingObjects === undefined
      ? { ...withRetained, retainedExistingObjects: [] }
      : withRetained;
  const withCorroborated =
    withObjects.corroboratedExistingObjectCount === undefined
      ? { ...withObjects, corroboratedExistingObjectCount: 0 }
      : withObjects;
  const withPending =
    withCorroborated.pendingImportDecision === undefined
      ? {
          ...withCorroborated,
          pendingImportDecision:
            withCorroborated.versionConflictResolution &&
            typeof withCorroborated.versionConflictResolution === 'object' &&
            !Array.isArray(withCorroborated.versionConflictResolution) &&
            (withCorroborated.versionConflictResolution as Record<string, unknown>).kind ===
              'awaiting_choice'
              ? legacyProviderPendingImportDecision(withCorroborated.versionConflictResolution)
              : null,
        }
      : withCorroborated;
  const withPendingResume =
    withPending.pendingImportDecisionResumeState === undefined
      ? {
          ...withPending,
          pendingImportDecisionResumeState:
            withPending.pendingImportDecision === null ? null : 'parsing',
        }
      : withPending;
  return {
    ...withPendingResume,
    versionConflictResolution:
      withPendingResume.versionConflictResolution === undefined
        ? { kind: 'none' }
        : withVersionConflictHashDefaults(withPendingResume.versionConflictResolution),
  };
}

function withVersionConflictHashDefaults(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const resolution = value as Record<string, unknown>;
  if (resolution.kind === 'awaiting_choice') {
    return {
      ...resolution,
      firstConflict: withVersionConflictHashDefault(resolution.firstConflict),
    };
  }
  if (resolution.kind === 'resolved' && Array.isArray(resolution.conflicts)) {
    return {
      ...resolution,
      conflicts: resolution.conflicts.map(withVersionConflictHashDefault),
    };
  }
  return value;
}

function withVersionConflictHashDefault(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const conflict = value as Record<string, unknown>;
  return conflict.expectedPriorScientificContentSha256 === undefined
    ? { ...conflict, expectedPriorScientificContentSha256: null }
    : conflict;
}

function legacyProviderPendingImportDecision(value: unknown): PendingImportDecision | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const firstConflict = (value as { firstConflict?: unknown }).firstConflict;
  if (!firstConflict || typeof firstConflict !== 'object' || Array.isArray(firstConflict)) {
    return null;
  }
  const conflict = firstConflict as Record<string, unknown>;
  if (
    !stableNonemptyString(conflict.sourceObjectId) ||
    !stableNonemptyString(conflict.stableId) ||
    typeof conflict.name !== 'string'
  ) {
    return null;
  }
  return {
    kind: 'provider_version_conflict',
    conflicts: [
      {
        sourceObjectId: conflict.sourceObjectId,
        stableId: conflict.stableId,
        displayName: conflict.name,
      },
    ],
  };
}

function parseLinkedItemRecoveryAttemptRow(
  row: LinkedItemRecoveryAttemptSqliteRow
): LinkedItemRecoveryAttempt {
  const attempt = withLinkedItemRecoveryAttemptDefaults(JSON.parse(row.body_json));
  assertValidLinkedItemRecoveryAttempt(attempt);
  if (
    row.id !== attempt.id ||
    row.run_id !== attempt.runId ||
    row.state !== attempt.state ||
    row.updated_at !== attempt.updatedAt
  ) {
    throw new Error(`Linked-item recovery attempt ${row.id} SQLite correlation is invalid.`);
  }
  return attempt;
}

function assertValidLinkedItemRecoveryArtifact(
  candidate: unknown
): asserts candidate is LinkedItemRecoveryArtifact {
  const record = requireRecord(candidate, 'Linked-item recovery artifact');
  const commonValid =
    stableNonemptyString(record.id) &&
    stableNonemptyString(record.runId) &&
    stableNonemptyString(record.attemptId) &&
    Number.isSafeInteger(record.fileIndex) &&
    Number(record.fileIndex) >= 0;
  if (!commonValid) throw new Error('Linked-item recovery artifact is invalid.');
  if (record.schema === 'dnaforge.benchling.linked-item-recovery-source.v2') {
    assertExactRecordKeys(
      record,
      [
        'attemptId',
        'externalZipEntries',
        'externalZipSource',
        'fileIndex',
        'id',
        'runId',
        'schema',
      ],
      'Linked-item recovery external source'
    );
    const source = requireRecord(record.externalZipSource, 'Linked-item recovery ZIP source');
    if (
      source.schema !== 'dnaforge.benchling.external-zip-source.v1' ||
      !stableNonemptyString(source.sourceId) ||
      !stableNonemptyString(source.originalPath) ||
      !stableNonemptyString(source.displayName) ||
      !SHA256_REF.test(String(source.zipSha256)) ||
      !nonnegativeSafeInteger(source.sizeBytes) ||
      !Number.isFinite(Date.parse(String(source.selectedAt))) ||
      !Array.isArray(record.externalZipEntries)
    ) {
      throw new Error('Linked-item recovery external source is invalid.');
    }
    for (const candidateEntry of record.externalZipEntries) {
      const entry = requireRecord(candidateEntry, 'Linked-item recovery ZIP entry');
      if (
        entry.schema !== 'dnaforge.benchling.external-zip-entry.v1' ||
        entry.sourceId !== source.sourceId ||
        !stableNonemptyString(entry.sourceObjectId) ||
        !stableNonemptyString(entry.entryPath) ||
        !SHA256_REF.test(String(entry.entrySha256)) ||
        !nonnegativeSafeInteger(entry.sizeBytes) ||
        !(entry.mediaType === null || stableNonemptyString(entry.mediaType)) ||
        !['source-record', 'attachment'].includes(String(entry.role))
      ) {
        throw new Error('Linked-item recovery external ZIP entry is invalid.');
      }
    }
    return;
  }
  assertExactRecordKeys(
    record,
    ['artifact', 'attemptId', 'fileIndex', 'id', 'runId', 'schema'],
    'Linked-item recovery artifact'
  );
  const value = record as Extract<
    LinkedItemRecoveryArtifact,
    { schema: 'dnaforge.benchling.linked-item-recovery-artifact.v1' }
  >;
  const artifact = value.artifact;
  if (
    value.schema !== 'dnaforge.benchling.linked-item-recovery-artifact.v1' ||
    !artifact ||
    artifact.schema !== 'dnaforge.benchling.local-export-artifact.v1' ||
    artifact.format !== 'zip' ||
    !stableNonemptyString(artifact.logicalFilename) ||
    !SHA256_REF.test(artifact.sha256) ||
    !Number.isSafeInteger(artifact.sizeBytes) ||
    artifact.sizeBytes < 0 ||
    !stableNonemptyString(artifact.immutableLocalPath) ||
    !Number.isFinite(Date.parse(artifact.capturedAt)) ||
    !artifact.archive ||
    !Array.isArray(artifact.resources) ||
    artifact.resources.length !== 0
  ) {
    throw new Error('Linked-item recovery artifact is invalid.');
  }
  for (const count of [
    artifact.archive.entryCount,
    artifact.archive.totalCompressedEntryBytes,
    artifact.archive.totalUncompressedEntryBytes,
  ]) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`Linked-item recovery artifact ${value.id} archive counts are invalid.`);
    }
  }
}

function parseLinkedItemRecoveryArtifactRow(
  row: LinkedItemRecoveryArtifactSqliteRow
): LinkedItemRecoveryArtifact {
  const artifact = JSON.parse(row.body_json) as LinkedItemRecoveryArtifact;
  assertValidLinkedItemRecoveryArtifact(artifact);
  if (
    row.id !== artifact.id ||
    row.run_id !== artifact.runId ||
    row.attempt_id !== artifact.attemptId ||
    row.sha256 !== linkedItemRecoveryArtifactSha256(artifact)
  ) {
    throw new Error(`Linked-item recovery artifact ${row.id} SQLite correlation is invalid.`);
  }
  return artifact;
}

function assertValidLinkedItemRecoveryCapture(
  candidate: unknown
): asserts candidate is LinkedItemRecoveryCapture {
  const record = requireRecord(candidate, 'Linked-item recovery capture');
  assertExactRecordKeys(
    record,
    [
      'artifactId',
      'attemptId',
      'capturedAt',
      'id',
      'runId',
      'schema',
      'snapshotPartId',
      'sourceObjectId',
      'sourceScientificContentSha256',
      'sourceStableId',
      ...(record.sourceFolderMemberships === undefined ? [] : ['sourceFolderMemberships']),
    ],
    'Linked-item recovery capture'
  );
  const capture = record as LinkedItemRecoveryCapture;
  if (capture.sourceFolderMemberships !== undefined)
    validateNativeSourceFolderMemberships(capture.sourceFolderMemberships, capture.runId);
  if (
    capture.schema !== 'dnaforge.benchling.linked-item-recovery-capture.v1' ||
    !stableNonemptyString(capture.id) ||
    !stableNonemptyString(capture.runId) ||
    !stableNonemptyString(capture.attemptId) ||
    !stableNonemptyString(capture.artifactId) ||
    !stableNonemptyString(capture.sourceObjectId) ||
    !stableNonemptyString(capture.sourceStableId) ||
    !SHA256_REF.test(capture.sourceScientificContentSha256) ||
    !stableNonemptyString(capture.snapshotPartId) ||
    !Number.isFinite(Date.parse(capture.capturedAt))
  ) {
    throw new Error('Linked-item recovery capture is invalid.');
  }
}

function parseLinkedItemRecoveryCaptureRow(
  row: LinkedItemRecoveryCaptureSqliteRow
): LinkedItemRecoveryCapture {
  const capture = JSON.parse(row.body_json) as LinkedItemRecoveryCapture;
  assertValidLinkedItemRecoveryCapture(capture);
  if (
    row.id !== capture.id ||
    row.run_id !== capture.runId ||
    row.attempt_id !== capture.attemptId ||
    row.artifact_id !== capture.artifactId ||
    row.source_object_id !== capture.sourceObjectId ||
    row.snapshot_part_id !== capture.snapshotPartId
  ) {
    throw new Error(`Linked-item recovery capture ${row.id} SQLite correlation is invalid.`);
  }
  return capture;
}

function assertValidWorkspaceAppendHierarchyCapture(
  candidate: unknown
): asserts candidate is WorkspaceAppendHierarchyCapture {
  const record = requireRecord(candidate, 'Workspace append hierarchy capture');
  assertExactRecordKeys(
    record,
    [
      'artifactId',
      'artifactSha256',
      'attemptId',
      'capturedAt',
      'destinationRootSourceId',
      'folders',
      'id',
      'memberships',
      'runId',
      'schema',
      'zipRootName',
    ],
    'Workspace append hierarchy capture'
  );
  const capture = record as WorkspaceAppendHierarchyCapture;
  if (
    capture.schema !== 'dnaforge.benchling.workspace-append-hierarchy-capture.v1' ||
    !stableNonemptyString(capture.id) ||
    !stableNonemptyString(capture.runId) ||
    !stableNonemptyString(capture.attemptId) ||
    !stableNonemptyString(capture.artifactId) ||
    !SHA256_REF.test(capture.artifactSha256) ||
    !stableNonemptyString(capture.destinationRootSourceId) ||
    !safeNormalizedFolderSegment(capture.zipRootName) ||
    !Array.isArray(capture.folders) ||
    !Array.isArray(capture.memberships) ||
    !Number.isFinite(Date.parse(capture.capturedAt))
  ) {
    throw new Error('Workspace append hierarchy capture is invalid.');
  }

  const folderIds = new Set<string>();
  const folderPaths = new Set<string>();
  let priorFolderPath = '';
  for (const candidateFolder of capture.folders) {
    const folderRecord = requireRecord(candidateFolder, 'Workspace append hierarchy folder');
    assertExactRecordKeys(
      folderRecord,
      ['archiveRelativePath', 'name', 'parentSourceId', 'sourceId'],
      'Workspace append hierarchy folder'
    );
    const folder = folderRecord as WorkspaceAppendHierarchyFolder;
    const segments = validRelativeFolderPath(folder.archiveRelativePath);
    const parentRelativePath = segments.slice(0, -1).join('/');
    const expectedParentSourceId = parentRelativePath
      ? localBenchlingExportDescendantFolderId(
          capture.destinationRootSourceId,
          `${capture.zipRootName}/${parentRelativePath}`
        )
      : capture.destinationRootSourceId;
    if (
      !stableNonemptyString(folder.sourceId) ||
      !safeNormalizedFolderSegment(folder.name) ||
      folder.name !== segments[segments.length - 1] ||
      !stableNonemptyString(folder.parentSourceId) ||
      folder.parentSourceId !== expectedParentSourceId ||
      folder.sourceId !==
        localBenchlingExportDescendantFolderId(
          capture.destinationRootSourceId,
          `${capture.zipRootName}/${folder.archiveRelativePath}`
        ) ||
      folderIds.has(folder.sourceId) ||
      folderPaths.has(folder.archiveRelativePath) ||
      (priorFolderPath !== '' && priorFolderPath >= folder.archiveRelativePath)
    ) {
      throw new Error('Workspace append hierarchy folder evidence is invalid.');
    }
    folderIds.add(folder.sourceId);
    folderPaths.add(folder.archiveRelativePath);
    priorFolderPath = folder.archiveRelativePath;
  }

  const authorizedFolderIds = new Set([capture.destinationRootSourceId, ...folderIds]);
  const membershipKeys = new Set<string>();
  let priorMembershipKey = '';
  for (const candidateMembership of capture.memberships) {
    const membershipRecord = requireRecord(
      candidateMembership,
      'Workspace append hierarchy membership'
    );
    assertExactRecordKeys(
      membershipRecord,
      ['folderSourceId', 'sourceObjectId'],
      'Workspace append hierarchy membership'
    );
    const membership = membershipRecord as WorkspaceAppendHierarchyMembership;
    const key = `${membership.sourceObjectId}\0${membership.folderSourceId}`;
    if (
      !/^(?:bfi|etr|seq|prtn|prt)_[A-Za-z0-9]+$/u.test(membership.sourceObjectId) ||
      !authorizedFolderIds.has(membership.folderSourceId) ||
      membershipKeys.has(key) ||
      (priorMembershipKey !== '' && priorMembershipKey >= key)
    ) {
      throw new Error('Workspace append hierarchy membership evidence is invalid.');
    }
    membershipKeys.add(key);
    priorMembershipKey = key;
  }
}

function parseWorkspaceAppendHierarchyCaptureRow(
  row: WorkspaceAppendHierarchyCaptureSqliteRow
): WorkspaceAppendHierarchyCapture {
  const capture = JSON.parse(row.body_json) as WorkspaceAppendHierarchyCapture;
  assertValidWorkspaceAppendHierarchyCapture(capture);
  if (
    row.id !== capture.id ||
    row.run_id !== capture.runId ||
    row.attempt_id !== capture.attemptId ||
    row.artifact_id !== capture.artifactId ||
    row.artifact_sha256 !== capture.artifactSha256
  ) {
    throw new Error(`Workspace append hierarchy ${row.id} SQLite correlation is invalid.`);
  }
  return capture;
}

function validRelativeFolderPath(value: unknown): string[] {
  if (typeof value !== 'string' || value !== value.normalize('NFC') || value.startsWith('/')) {
    throw new Error('Workspace append hierarchy folder path is invalid.');
  }
  const segments = value.split('/');
  if (segments.length === 0 || segments.some((segment) => !safeNormalizedFolderSegment(segment))) {
    throw new Error('Workspace append hierarchy folder path is invalid.');
  }
  return segments;
}

function safeNormalizedFolderSegment(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.normalize('NFC') &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\0')
  );
}

function assertValidRecoveredSourceObject(sourceObject: SourceObject): void {
  if (
    !sourceObject ||
    !stableNonemptyString(sourceObject.id) ||
    !stableNonemptyString(sourceObject.stableId) ||
    sourceObject.id !== sourceObject.stableId ||
    !stableNonemptyString(sourceObject.sourceType) ||
    !stableNonemptyString(sourceObject.name) ||
    !stableNonemptyString(sourceObject.sourceUrl) ||
    !Array.isArray(sourceObject.aliases) ||
    sourceObject.aliases.some((value) => typeof value !== 'string') ||
    !Array.isArray(sourceObject.attachmentHashes) ||
    sourceObject.attachmentHashes.some(
      (value) => typeof value !== 'string' || !SHA256_REF.test(value)
    ) ||
    !Array.isArray(sourceObject.memberships) ||
    sourceObject.memberships.some((value) => typeof value !== 'string') ||
    !Array.isArray(sourceObject.relationships) ||
    !sourceObject.metadata ||
    typeof sourceObject.metadata !== 'object' ||
    Array.isArray(sourceObject.metadata) ||
    JSON.stringify(sourceObject) === undefined
  ) {
    throw new Error(`Recovered source object ${String(sourceObject?.id)} is invalid.`);
  }
}

function parseProjectionReceiptRow(row: ProjectionReceiptSqliteRow): ProjectionReceipt {
  const receipt = JSON.parse(row.body_json) as ProjectionReceipt;
  assertProviderTaskPrivacySafe(receipt, `projection receipt ${row.id}`);
  if (
    !stableNonemptyString(receipt.id) ||
    !stableNonemptyString(receipt.runId) ||
    !stableNonemptyString(receipt.sourceObjectId) ||
    !stableNonemptyString(receipt.destinationObjectId) ||
    (receipt.destination?.kind === 'catalog-record'
      ? receipt.destinationPath !== ''
      : !stableNonemptyString(receipt.destinationPath)) ||
    !Number.isFinite(Date.parse(receipt.createdAt)) ||
    row.id !== receipt.id ||
    row.run_id !== receipt.runId ||
    row.source_object_id !== receipt.sourceObjectId ||
    row.destination_object_id !== receipt.destinationObjectId
  ) {
    throw new Error(`Projection receipt ${row.id} SQLite correlation is invalid.`);
  }
  return receipt;
}

function assertValidSnapshotPart(part: SourceSnapshotPart): void {
  if (!part || typeof part !== 'object' || typeof part.id !== 'string' || !part.id.trim()) {
    throw new Error('Snapshot part ID is required.');
  }
  if (typeof part.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(part.sha256)) {
    throw new Error(`Snapshot part ${part.id} requires a lowercase SHA-256 hash.`);
  }
  if (!Number.isSafeInteger(part.sizeBytes) || part.sizeBytes < 0) {
    throw new Error(`Snapshot part ${part.id} size must be a non-negative safe integer.`);
  }
  if (!Number.isFinite(Date.parse(part.capturedAt))) {
    throw new Error(`Snapshot part ${part.id} requires a valid capture timestamp.`);
  }
  if (
    part.supersedesPartId !== null &&
    (typeof part.supersedesPartId !== 'string' || part.supersedesPartId.trim() === '')
  ) {
    throw new Error(`Snapshot part ${part.id} has an invalid superseded part ID.`);
  }
  if (part.supersedesPartId === part.id) {
    throw new Error(`Snapshot part ${part.id} cannot supersede itself.`);
  }
  if (
    part.kind !== 'export_archive' &&
    part.kind !== 'targeted_read' &&
    part.kind !== 'local_export' &&
    part.kind !== 'supplemental_local_export'
  ) {
    throw new Error(`Snapshot part ${part.id} has an invalid kind.`);
  }
  if (part.kind === 'local_export') {
    if (part.sourceJobId !== null || part.sourceObjectId !== null) {
      throw new Error(
        `Local export snapshot part ${part.id} cannot claim a provider job or source object.`
      );
    }
    return;
  }
  if (part.kind === 'export_archive') {
    if (!part.sourceJobId?.trim() || part.sourceObjectId !== null) {
      throw new Error(
        `Export snapshot part ${part.id} requires one source job and no source object.`
      );
    }
    return;
  }
  if (part.sourceJobId !== null || !part.sourceObjectId?.trim()) {
    throw new Error(
      `Object-scoped snapshot part ${part.id} requires one source object and no source job.`
    );
  }
}

function assertValidExportCapture(input: unknown): asserts input is PersistedExportCapture {
  const record = requireRecord(input, 'Export capture');
  assertExactRecordKeys(
    record,
    [
      'jobId',
      'runId',
      'snapshotId',
      'capturedAt',
      'archiveManifestId',
      'sourceObjectIds',
      'attachmentReferences',
      'membershipReferences',
    ],
    'Export capture'
  );
  const capture = record as PersistedExportCapture;
  if (
    !stableNonemptyString(capture.jobId) ||
    !stableNonemptyString(capture.runId) ||
    !stableNonemptyString(capture.snapshotId) ||
    !stableNonemptyString(capture.archiveManifestId) ||
    !Number.isFinite(Date.parse(capture.capturedAt)) ||
    !Array.isArray(capture.sourceObjectIds) ||
    capture.sourceObjectIds.some((value) => !stableNonemptyString(value)) ||
    !Array.isArray(capture.attachmentReferences) ||
    capture.attachmentReferences.some(
      (reference) =>
        !reference ||
        !stableNonemptyString(reference.sourceObjectId) ||
        typeof reference.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(reference.sha256)
    ) ||
    !Array.isArray(capture.membershipReferences) ||
    capture.membershipReferences.some(
      (reference) =>
        !reference ||
        !stableNonemptyString(reference.sourceObjectId) ||
        !stableNonemptyString(reference.collectionId)
    )
  ) {
    throw new Error('Export capture evidence is invalid.');
  }
}

function assertValidPersistedSourceObjectVersion(
  input: unknown
): asserts input is PersistedSourceObjectVersion {
  const record = requireRecord(input, 'Source object version');
  assertExactRecordKeys(
    record,
    [
      'id',
      'runId',
      'sourceObjectId',
      'sourceJobId',
      'sourceSnapshotId',
      'capturedAt',
      'supersedesVersionId',
      'sourceObject',
    ],
    'Source object version'
  );
  const version = record as PersistedSourceObjectVersion;
  const sourceObject = version.sourceObject;
  if (
    !stableNonemptyString(version.id) ||
    !stableNonemptyString(version.runId) ||
    !stableNonemptyString(version.sourceObjectId) ||
    !stableNonemptyString(version.sourceJobId) ||
    !stableNonemptyString(version.sourceSnapshotId) ||
    !Number.isFinite(Date.parse(version.capturedAt)) ||
    (version.supersedesVersionId !== null && !stableNonemptyString(version.supersedesVersionId)) ||
    version.supersedesVersionId === version.id ||
    !sourceObject ||
    typeof sourceObject !== 'object' ||
    sourceObject.id !== version.sourceObjectId ||
    !stableNonemptyString(sourceObject.stableId) ||
    !stableNonemptyString(sourceObject.sourceType) ||
    !stableNonemptyString(sourceObject.sourceUrl) ||
    !Array.isArray(sourceObject.aliases) ||
    !Array.isArray(sourceObject.attachmentHashes) ||
    !Array.isArray(sourceObject.memberships) ||
    !Array.isArray(sourceObject.relationships) ||
    !sourceObject.metadata ||
    typeof sourceObject.metadata !== 'object' ||
    Array.isArray(sourceObject.metadata)
  ) {
    throw new Error(`Source object version ${String(record.id)} evidence is invalid.`);
  }
}

function stableNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function assertValidExportJob(job: ExportJob): void {
  const replacementLineage = job.folderTreeReplacementLineage;
  if (replacementLineage !== undefined) {
    const expectedKeys = [
      'ordinal',
      'predecessorJobId',
      'predecessorMatchSignature',
      'reason',
      'schema',
    ];
    const actualKeys =
      replacementLineage && typeof replacementLineage === 'object'
        ? Object.keys(replacementLineage).sort()
        : [];
    if (
      !job.folderTreeAuthority ||
      job.directFolderAuthority ||
      actualKeys.length !== expectedKeys.length ||
      actualKeys.some((key, index) => key !== expectedKeys[index]) ||
      replacementLineage.schema !==
        'dnaforge.benchling.folder-tree-export-replacement-lineage.v1' ||
      !stableNonemptyString(replacementLineage.predecessorJobId) ||
      replacementLineage.predecessorJobId === job.id ||
      !stableNonemptyString(replacementLineage.predecessorMatchSignature) ||
      replacementLineage.reason !== 'download_link_expired' ||
      replacementLineage.ordinal !== 0
    ) {
      throw new Error(`Folder Tree export job ${job.id} has invalid replacement lineage.`);
    }
  }
  if (!Number.isInteger(job.attempts) || job.attempts < 0) {
    throw new Error(`Export job ${job.id} attempts must be a non-negative integer.`);
  }
  if (job.submittedAt !== null && !Number.isFinite(Date.parse(job.submittedAt))) {
    throw new Error(`Export job ${job.id} submission time is invalid.`);
  }
  if (job.state === 'planned') {
    if (
      job.submittedAt !== null ||
      job.attempts !== 0 ||
      job.receiptId !== null ||
      (job.receiptSource ?? null) !== null ||
      job.downloadUrlHash !== null ||
      (job.receiptConfirmationId ?? null) !== null ||
      job.snapshotPartId !== null
    ) {
      throw new Error(`Planned export job ${job.id} cannot contain remote execution state.`);
    }
    return;
  }
  if (job.state !== 'failed' && (job.submittedAt === null || job.attempts < 1)) {
    throw new Error(`Export job ${job.id} must record its submission time and attempt count.`);
  }
  if (
    ['receipt_matched', 'downloading', 'captured'].includes(job.state) &&
    job.receiptId === null
  ) {
    throw new Error(`Export job ${job.id} must record its matched receipt.`);
  }
  if (['downloading', 'captured'].includes(job.state) && job.downloadUrlHash === null) {
    throw new Error(`Export job ${job.id} must record its protected download URL hash.`);
  }
  if (job.receiptConfirmationId && job.receiptSource !== 'gmail') {
    throw new Error(
      `Export job ${job.id} can reference receipt confirmation only for Gmail evidence.`
    );
  }
  if (job.state === 'captured' && job.snapshotPartId === null) {
    throw new Error(`Captured export job ${job.id} must reference a snapshot part.`);
  }
}

function assertLegalExportJobUpdate(existing: ExportJob, next: ExportJob): void {
  if (
    existing.id !== next.id ||
    existing.runId !== next.runId ||
    existing.contentFamily !== next.contentFamily ||
    existing.matchSignature !== next.matchSignature ||
    JSON.stringify(existing.sourceRoots) !== JSON.stringify(next.sourceRoots) ||
    JSON.stringify(existing.directFolderAuthority ?? null) !==
      JSON.stringify(next.directFolderAuthority ?? null) ||
    JSON.stringify(existing.folderTreeAuthority ?? null) !==
      JSON.stringify(next.folderTreeAuthority ?? null) ||
    JSON.stringify(existing.folderTreeReplacementLineage ?? null) !==
      JSON.stringify(next.folderTreeReplacementLineage ?? null)
  ) {
    throw new Error(`Export job ${existing.id} identity and planning fields are immutable.`);
  }
  if (!EXPORT_JOB_TRANSITIONS[existing.state].has(next.state)) {
    throw new Error(
      `Cannot persist illegal export job transition ${existing.state} -> ${next.state}.`
    );
  }
  assertSetOnceField(existing, next, 'submittedAt');
  assertSetOnceField(existing, next, 'receiptId');
  assertSetOnceField(existing, next, 'receiptSource');
  assertSetOnceField(existing, next, 'downloadUrlHash');
  assertSetOnceField(existing, next, 'receiptConfirmationId');
  assertSetOnceField(existing, next, 'snapshotPartId');

  const isNewAttempt =
    next.state === 'submitted' && (existing.state === 'planned' || existing.state === 'failed');
  const expectedAttempts = isNewAttempt ? existing.attempts + 1 : existing.attempts;
  if (next.attempts !== expectedAttempts) {
    throw new Error(
      `Export job ${existing.id} attempt count must ${
        isNewAttempt ? 'increase by one on submission' : 'remain unchanged'
      }.`
    );
  }
}

function exactExportJobPlanningIdentity(actual: ExportJob, expected: ExportJob): boolean {
  return (
    actual.id === expected.id &&
    actual.runId === expected.runId &&
    actual.contentFamily === expected.contentFamily &&
    actual.matchSignature === expected.matchSignature &&
    isDeepStrictEqual(actual.sourceRoots, expected.sourceRoots) &&
    isDeepStrictEqual(
      actual.directFolderAuthority ?? null,
      expected.directFolderAuthority ?? null
    ) &&
    isDeepStrictEqual(actual.folderTreeAuthority ?? null, expected.folderTreeAuthority ?? null) &&
    isDeepStrictEqual(
      actual.folderTreeReplacementLineage ?? null,
      expected.folderTreeReplacementLineage ?? null
    )
  );
}

function assertSetOnceField<
  K extends
    | 'submittedAt'
    | 'receiptId'
    | 'receiptSource'
    | 'downloadUrlHash'
    | 'receiptConfirmationId'
    | 'snapshotPartId',
>(existing: ExportJob, next: ExportJob, field: K): void {
  if (existing[field] != null && existing[field] !== next[field]) {
    throw new Error(`Export job ${existing.id} ${field} is immutable once recorded.`);
  }
}

function assertValidGmailReceiptInference(
  input: unknown
): asserts input is GmailReceiptInferenceEvidence {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Gmail receipt inference evidence must be an object.');
  }
  assertExactEvidenceKeys(
    input,
    [
      'schema',
      'id',
      'runId',
      'jobId',
      'receiptId',
      'plannedMatchSignature',
      'downloadUrlHash',
      'matchConfidence',
      'contentFamily',
      'sourceRootIds',
      'observedAt',
    ],
    'Gmail receipt inference'
  );
  const evidence = input as Partial<GmailReceiptInferenceEvidence>;
  if (
    evidence.schema !== 'dnaforge.benchling.gmail-receipt-inference.v1' ||
    (evidence.matchConfidence !== 'inferred' && evidence.matchConfidence !== 'ambiguous') ||
    !stableEvidenceString(evidence.id) ||
    !stableEvidenceString(evidence.runId) ||
    !stableEvidenceString(evidence.jobId) ||
    !stableEvidenceString(evidence.receiptId) ||
    !stableEvidenceString(evidence.plannedMatchSignature) ||
    !stableEvidenceString(evidence.contentFamily) ||
    !isSha256Evidence(evidence.downloadUrlHash) ||
    !Array.isArray(evidence.sourceRootIds) ||
    evidence.sourceRootIds.some((value) => !stableEvidenceString(value)) ||
    new Set(evidence.sourceRootIds).size !== evidence.sourceRootIds.length ||
    !isCanonicalGmailUtcTimestamp(evidence.observedAt)
  ) {
    throw new Error('Gmail receipt inference evidence is invalid.');
  }
}

function assertValidGmailReceiptConfirmation(
  input: unknown
): asserts input is GmailReceiptConfirmationEvidence {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Gmail receipt confirmation evidence must be an object.');
  }
  assertExactEvidenceKeys(
    input,
    [
      'schema',
      'id',
      'runId',
      'inferenceId',
      'jobId',
      'receiptId',
      'matchSignature',
      'downloadUrlHash',
      'confirmedAt',
      'basis',
    ],
    'Gmail receipt confirmation'
  );
  const evidence = input as Partial<GmailReceiptConfirmationEvidence>;
  if (
    evidence.schema !== 'dnaforge.benchling.gmail-receipt-confirmation.v1' ||
    evidence.basis !== 'explicit_user_confirmation' ||
    !stableEvidenceString(evidence.id) ||
    !stableEvidenceString(evidence.runId) ||
    !stableEvidenceString(evidence.inferenceId) ||
    !stableEvidenceString(evidence.jobId) ||
    !stableEvidenceString(evidence.receiptId) ||
    !stableEvidenceString(evidence.matchSignature) ||
    !isSha256Evidence(evidence.downloadUrlHash) ||
    !isCanonicalGmailUtcTimestamp(evidence.confirmedAt)
  ) {
    throw new Error('Gmail receipt confirmation evidence is invalid.');
  }
}

function assertExactEvidenceKeys(input: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(input).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    throw new Error(`${label} evidence must contain only canonical fields.`);
  }
}

function stableEvidenceString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 1_000 &&
    !hasAsciiControlCharacter(value) &&
    !/https?:\/\//iu.test(value)
  );
}

function hasAsciiControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function isSha256Evidence(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isCanonicalGmailUtcTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function assertValidExportJobReplacement(
  input: unknown
): asserts input is PersistedExportJobReplacement {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Export replacement must be an object.');
  }
  const expectedKeys = ['createdAt', 'failedJobId', 'reason', 'replacementJobIds', 'runId'];
  const actualKeys = Object.keys(input).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error('Export replacement must contain only canonical fields.');
  }
  const replacement = input as Partial<PersistedExportJobReplacement>;
  if (
    typeof replacement.failedJobId !== 'string' ||
    replacement.failedJobId.trim() === '' ||
    typeof replacement.runId !== 'string' ||
    replacement.runId.trim() === '' ||
    (replacement.reason !== 'export_timed_out' && replacement.reason !== 'download_link_expired') ||
    !isCanonicalUtcTimestamp(replacement.createdAt) ||
    !Array.isArray(replacement.replacementJobIds) ||
    replacement.replacementJobIds.some(
      (replacementJobId) => typeof replacementJobId !== 'string' || replacementJobId.trim() === ''
    ) ||
    new Set(replacement.replacementJobIds).size !== replacement.replacementJobIds.length ||
    replacement.replacementJobIds.includes(replacement.failedJobId)
  ) {
    throw new Error(
      `Export replacement ${replacement.failedJobId ?? '<unknown>'} requires canonical unique successor identities.`
    );
  }
}

function assertValidExportJobFailure(input: unknown): asserts input is PersistedExportJobFailure {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Export failure evidence must be an object.');
  }
  const expectedKeys = ['code', 'failedAt', 'jobId', 'message', 'runId'];
  const actualKeys = Object.keys(input).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error('Export failure evidence must contain only canonical fields.');
  }
  const failure = input as Partial<PersistedExportJobFailure>;
  if (
    typeof failure.jobId !== 'string' ||
    failure.jobId.trim() === '' ||
    typeof failure.runId !== 'string' ||
    failure.runId.trim() === ''
  ) {
    throw new Error('Export failure evidence requires stable job and run identities.');
  }
  if (failure.code !== 'export_timed_out' && failure.code !== 'download_link_expired') {
    throw new Error(`Export failure ${failure.jobId} has an unsupported structural failure code.`);
  }
  if (
    !isCanonicalUtcTimestamp(failure.failedAt) ||
    failure.message !== canonicalExportJobFailureMessage(failure.code)
  ) {
    throw new Error(`Export failure ${failure.jobId} requires canonical timestamped evidence.`);
  }
}

function isCanonicalUtcTimestamp(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
  ) {
    return false;
  }
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return false;
  const canonical = new Date(epoch).toISOString();
  return value === canonical || value === canonical.replace(/\.000Z$/u, 'Z');
}

function assertValidExportInspection(inspection: PersistedExportInspection): void {
  if (!Number.isFinite(Date.parse(inspection.inspectedAt))) {
    throw new Error(`Export inspection ${inspection.jobId} requires a valid timestamp.`);
  }
  for (const [label, value] of [
    ['compressed archive bytes', inspection.compressedArchiveBytes],
    ['declared compressed entry bytes', inspection.declaredCompressedEntryBytes],
    ['declared uncompressed bytes', inspection.declaredUncompressedBytes],
    ['largest uncompressed entry bytes', inspection.largestUncompressedEntryBytes],
    ['entry count', inspection.entryCount],
    ['central directory bytes', inspection.centralDirectoryBytes],
    ['range request count', inspection.rangeRequestCount],
    ['range bytes read', inspection.rangeBytesRead],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Export inspection ${inspection.jobId} ${label} must be non-negative.`);
    }
  }
  if (inspection.largestUncompressedEntryBytes > inspection.declaredUncompressedBytes) {
    throw new Error(
      `Export inspection ${inspection.jobId} largest entry exceeds the declared total.`
    );
  }
}

function assertValidProviderTaskEvidence(evidence: ProviderTaskEvidence): void {
  const allowedKeys = new Set([
    'id',
    'runId',
    'jobId',
    'matchSignature',
    'providerTaskHandleSha256',
    'status',
    'actionRequired',
    'observedAt',
  ]);
  if (Object.keys(evidence).some((key) => !allowedKeys.has(key))) {
    throw new Error('Provider task evidence contains a non-allowlisted field.');
  }
  for (const [label, value] of [
    ['evidence ID', evidence.id],
    ['run ID', evidence.runId],
    ['job ID', evidence.jobId],
  ] as const) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value)) {
      throw new Error(`Provider task ${label} is invalid.`);
    }
  }
  if (
    typeof evidence.matchSignature !== 'string' ||
    evidence.matchSignature.length < 1 ||
    evidence.matchSignature.length > 1_000 ||
    hasControlCharacter(evidence.matchSignature)
  ) {
    throw new Error('Provider task match signature is invalid.');
  }
  if (!['RUNNING', 'SUCCEEDED', 'FAILED', 'ACTION_REQUIRED'].includes(evidence.status)) {
    throw new Error('Provider task status is invalid.');
  }
  if (!Number.isFinite(Date.parse(evidence.observedAt))) {
    throw new Error('Provider task observation timestamp is invalid.');
  }
  if (evidence.actionRequired === null) {
    if (evidence.status === 'FAILED' || evidence.status === 'ACTION_REQUIRED') {
      throw new Error('Terminal provider task evidence requires action-required details.');
    }
    assertProviderTaskHandle(evidence.providerTaskHandleSha256);
    return;
  }
  if (evidence.status !== 'FAILED' && evidence.status !== 'ACTION_REQUIRED') {
    throw new Error('Non-terminal provider task evidence cannot contain action-required details.');
  }
  const action = evidence.actionRequired;
  const allowedActionKeys = new Set([
    'schema',
    'code',
    'providerStatus',
    'recordedAt',
    'diagnostic',
  ]);
  if (
    Object.keys(action).some((key) => !allowedActionKeys.has(key)) ||
    action.schema !== 'dnaforge.benchling.native-export-action-required.v1' ||
    ![
      'provider_task_identity_invalid',
      'provider_task_failed',
      'provider_task_download_url_not_allowlisted',
      'provider_task_unavailable',
      'provider_task_session_locator_unavailable',
      'provider_task_status_not_dispatched',
      'provider_task_status_invalid_json',
      'provider_task_status_invalid_response',
      'provider_task_status_undocumented',
    ].includes(action.code) ||
    !['FAILED', 'SUCCEEDED', null].includes(action.providerStatus) ||
    (action.diagnostic !== undefined &&
      ![
        'unrecognized_status',
        'unexpected_fields',
        'pending_result_non_null',
        'success_result_not_null',
      ].includes(action.diagnostic)) ||
    !Number.isFinite(Date.parse(action.recordedAt))
  ) {
    throw new Error('Provider task action-required evidence is invalid.');
  }
  if (evidence.providerTaskHandleSha256 === null) {
    if (evidence.status !== 'ACTION_REQUIRED' || action.code !== 'provider_task_identity_invalid') {
      throw new Error('Provider task evidence is missing its task identity.');
    }
  } else {
    assertProviderTaskHandle(evidence.providerTaskHandleSha256);
  }
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

function assertProviderTaskHandle(
  providerTaskHandleSha256: string | null
): asserts providerTaskHandleSha256 is string {
  if (typeof providerTaskHandleSha256 !== 'string' || !SHA256_REF.test(providerTaskHandleSha256)) {
    throw new Error('Provider task handle digest is invalid.');
  }
}

export function assertProviderTaskPrivacySafe(value: unknown, context: string): void {
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown, key: string | null): void => {
    if (typeof candidate === 'string') {
      if (key === 'providerTaskHandleSha256' && !SHA256_REF.test(candidate)) {
        throw new Error(`${context} contains an invalid provider task handle.`);
      }
      if (key === 'receiptId' && LEGACY_PROVIDER_TASK_RECEIPT.test(candidate)) {
        throw new Error(`${context} contains a legacy raw provider task receipt.`);
      }
      if (
        key === 'receiptId' &&
        candidate.startsWith('provider-task:') &&
        !PROVIDER_TASK_RECEIPT.test(candidate)
      ) {
        throw new Error(`${context} contains an invalid provider task receipt.`);
      }
      if (EMBEDDED_PROVIDER_TASK_PRIVATE_FIELD.test(candidate)) {
        throw new Error(`${context} embeds private provider task fields.`);
      }
      if (EMBEDDED_LEGACY_PROVIDER_TASK_RECEIPT.test(candidate)) {
        throw new Error(`${context} embeds a legacy raw provider task receipt.`);
      }
      if (EMBEDDED_PROVIDER_TASK_STATUS_PATH.test(candidate)) {
        throw new Error(`${context} embeds a provider task status path.`);
      }
      return;
    }
    if (!candidate || typeof candidate !== 'object') return;
    if (seen.has(candidate)) throw new Error(`${context} is cyclic.`);
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, null);
      seen.delete(candidate);
      return;
    }
    for (const [nestedKey, nestedValue] of Object.entries(candidate)) {
      if (nestedKey === 'providerTaskId' || nestedKey === 'statusPath') {
        throw new Error(`${context} contains a private provider task field.`);
      }
      visit(nestedValue, nestedKey);
    }
    seen.delete(candidate);
  };
  visit(value, null);
}

function providerTaskPrivacyJobKey(runId: string, jobId: string): string {
  return `${runId}\0${jobId}`;
}

function providerTaskPrivacyExactKey(runId: string, jobId: string, rawTask: string): string {
  return `${runId}\0${jobId}\0${rawTask}`;
}

function providerTaskPrivacyRawKey(runId: string, rawTask: string): string {
  return `${runId}\0${rawTask}`;
}

function requireProviderTaskPrivacyOpaqueId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !OPAQUE_ID.test(value)) {
    throw new Error(`Legacy provider-task privacy migration ${label} identity is invalid.`);
  }
  return value;
}

function requireProviderTaskPrivacyMatchSignature(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 1_000 ||
    hasControlCharacter(value)
  ) {
    throw new Error('Legacy provider-task privacy migration match signature is invalid.');
  }
  return value;
}

function collectLegacyProviderTaskAuthorityDigestHints(
  value: unknown,
  inheritedRunId: string,
  hints: Map<string, string>,
  inheritedJobId: string | null = null
): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) {
      collectLegacyProviderTaskAuthorityDigestHints(item, inheritedRunId, hints, inheritedJobId);
    }
    return;
  }
  const record = value as Record<string, unknown>;
  const runId = typeof record.runId === 'string' ? record.runId : inheritedRunId;
  const jobId =
    typeof record.jobId === 'string'
      ? record.jobId
      : typeof record.exportJobId === 'string'
        ? record.exportJobId
        : inheritedJobId;
  if (typeof record.providerTaskId === 'string' && jobId !== null) {
    const digest =
      typeof record.directFolderAuthorityDigest === 'string'
        ? record.directFolderAuthorityDigest
        : typeof record.folderTreeAuthorityDigest === 'string'
          ? record.folderTreeAuthorityDigest
          : null;
    if (digest !== null) {
      if (!SHA256_REF.test(digest)) {
        throw new Error('Legacy provider-task privacy migration authority digest is invalid.');
      }
      const key = providerTaskPrivacyExactKey(runId, jobId, record.providerTaskId);
      const existing = hints.get(key);
      if (existing !== undefined && existing !== digest) {
        throw new Error('Legacy provider-task privacy migration authority digest is ambiguous.');
      }
      hints.set(key, digest);
    }
  }
  for (const nested of Object.values(record)) {
    collectLegacyProviderTaskAuthorityDigestHints(nested, runId, hints, jobId);
  }
}

function deriveLegacyProviderTaskHandle(input: {
  rawTask: unknown;
  runId: string;
  jobId: string;
  matchSignature: string;
  runsById: ReadonlyMap<string, MigrationRun>;
  jobsByRunAndId: ReadonlyMap<string, ExportJob>;
  authorityDigestHints: ReadonlyMap<string, string>;
}): string {
  const rawTask = requireProviderTaskPrivacyOpaqueId(input.rawTask, 'task');
  const run = input.runsById.get(input.runId);
  const job = input.jobsByRunAndId.get(providerTaskPrivacyJobKey(input.runId, input.jobId));
  if (
    !run?.binding ||
    !job ||
    job.runId !== run.id ||
    job.matchSignature !== input.matchSignature
  ) {
    throw new Error('Legacy provider-task privacy migration correlation is incomplete.');
  }
  let directFolderDigest: string | null = null;
  let folderTreeDigest: string | null = null;
  if (job.directFolderAuthority !== undefined) {
    directFolderDigest = legacyDirectFolderAuthorityDigest(job.directFolderAuthority);
  }
  if (job.folderTreeAuthority !== undefined) {
    folderTreeDigest = legacyFolderTreeAuthorityDigest(job.folderTreeAuthority);
  }
  const hint = input.authorityDigestHints.get(
    providerTaskPrivacyExactKey(input.runId, input.jobId, rawTask)
  );
  const expectedAuthorityDigest = directFolderDigest ?? folderTreeDigest;
  if (
    hint !== undefined &&
    (expectedAuthorityDigest === null || hint !== expectedAuthorityDigest)
  ) {
    throw new Error('Legacy provider-task privacy migration authority does not match its journal.');
  }
  return providerTaskHandleHash({
    binding: run.binding,
    providerTaskId: rawTask,
    jobId: job.id,
    matchSignature: job.matchSignature,
    directFolderAuthorityDigest: directFolderDigest,
    folderTreeAuthorityDigest: folderTreeDigest,
  });
}

function legacyDirectFolderAuthorityDigest(
  authority: NonNullable<ExportJob['directFolderAuthority']>
): string {
  const canonical = JSON.stringify({
    schema: 'dnaforge.benchling.direct-folder-export-authority-digest.v1',
    authority: {
      schema: authority.schema,
      capturePlanDigest: authority.capturePlanDigest,
      traversalJournalDigest: authority.traversalJournalDigest,
      selectedRootId: authority.selectedRootId,
      sourceItemId: authority.sourceItemId,
      sourceItemType: authority.sourceItemType,
      sourceFolderIds: [authority.selectedRootId],
      requestCapabilityId: authority.requestCapabilityId,
    },
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function legacyFolderTreeAuthorityDigest(
  authority: NonNullable<ExportJob['folderTreeAuthority']>
): string {
  const canonical = JSON.stringify({
    schema: 'dnaforge.benchling.folder-tree-export-authority-digest.v1',
    authority: {
      schema: authority.schema,
      capturePlanDigest: authority.capturePlanDigest,
      traversalJournalDigest: authority.traversalJournalDigest,
      selectedRootId: authority.selectedRootId,
      sourceItemId: authority.sourceItemId,
      sourceItemType: authority.sourceItemType,
      sourceFolderIds: authority.sourceFolderIds,
      maximumFolderDepth: authority.maximumFolderDepth,
      requestCapabilityId: authority.requestCapabilityId,
    },
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function providerTaskPrivacyHandleForRawTask(input: {
  context: ProviderTaskPrivacyMigrationContext;
  runId: string | null;
  jobId: string | null;
  rawTask: unknown;
  matchSignature?: unknown;
}): string | null {
  try {
    const rawTask = requireProviderTaskPrivacyOpaqueId(input.rawTask, 'task');
    if (input.runId === null) return null;
    if (input.jobId !== null) {
      const exact = input.context.handlesByRunJobAndRawTask.get(
        providerTaskPrivacyExactKey(input.runId, input.jobId, rawTask)
      );
      if (exact !== undefined) return exact;
      const job = input.context.jobsByRunAndId.get(
        providerTaskPrivacyJobKey(input.runId, input.jobId)
      );
      if (job) {
        return deriveLegacyProviderTaskHandle({
          rawTask,
          runId: input.runId,
          jobId: input.jobId,
          matchSignature:
            input.matchSignature === undefined
              ? job.matchSignature
              : requireProviderTaskPrivacyMatchSignature(input.matchSignature),
          runsById: input.context.runsById,
          jobsByRunAndId: input.context.jobsByRunAndId,
          authorityDigestHints: input.context.authorityDigestHints,
        });
      }
    }
    return (
      input.context.uniqueHandlesByRunAndRawTask.get(
        providerTaskPrivacyRawKey(input.runId, rawTask)
      ) ?? null
    );
  } catch {
    return null;
  }
}

const LEGACY_PROVIDER_TASK_HANDLE_CARRIER_SCHEMAS = new Set([
  'dnaforge.benchling.provider-task-direct-folder-gmail-fallback.v1',
  'dnaforge.benchling.provider-task-direct-folder-gmail-rescan.v1',
  'dnaforge.benchling.provider-task-direct-folder-gmail-rescan.v2',
  'dnaforge.benchling.provider-task-direct-folder-succeeded-gmail-recovery.v1',
]);

function markLegacyProviderTaskRunNonResumable(
  context: ProviderTaskPrivacyMigrationContext,
  runId: string | null
): void {
  if (runId !== null) context.nonResumableRunIds.add(runId);
}

function legacyProviderTaskPrivacyTombstoneHandle(
  runId: string | null,
  jobId: string | null
): string {
  const canonical = JSON.stringify({
    schema: 'dnaforge.benchling.legacy-provider-task-privacy-tombstone.v1',
    runId: runId ?? 'unavailable',
    jobId: jobId ?? 'unavailable',
  });
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

function rehashLegacyNativeExportDownloadAcceptance(
  value: unknown
): NativeExportDownloadAcceptanceEvidence {
  const record = requireRecord(value, 'Legacy native export download acceptance');
  const {
    schema: _legacySchema,
    id: _legacyId,
    evidenceSha256: _legacyEvidenceSha256,
    ...input
  } = record;
  return createNativeExportDownloadAcceptanceEvidence(
    input as Omit<NativeExportDownloadAcceptanceEvidence, 'schema' | 'id' | 'evidenceSha256'>
  );
}

function looksLikeProviderTaskEvidence(record: Record<string, unknown>): boolean {
  return (
    typeof record.jobId === 'string' &&
    typeof record.matchSignature === 'string' &&
    typeof record.observedAt === 'string' &&
    typeof record.status === 'string' &&
    Object.prototype.hasOwnProperty.call(record, 'actionRequired')
  );
}

function providerTaskPrivacyRecordedAt(
  record: Record<string, unknown>,
  context: ProviderTaskPrivacyMigrationContext,
  runId: string | null
): string {
  if (typeof record.observedAt === 'string' && Number.isFinite(Date.parse(record.observedAt))) {
    return record.observedAt;
  }
  const updatedAt = runId === null ? undefined : context.runsById.get(runId)?.updatedAt;
  return updatedAt && Number.isFinite(Date.parse(updatedAt))
    ? updatedAt
    : '1970-01-01T00:00:00.000Z';
}

function migrateLegacyProviderTaskPrivacyValue(
  value: unknown,
  input: {
    context: ProviderTaskPrivacyMigrationContext;
    runId: string | null;
    jobId: string | null;
    fieldName?: string | null;
  }
): unknown {
  if (typeof value === 'string') {
    if (LEGACY_PROVIDER_TASK_RECEIPT.test(value)) {
      if (input.fieldName !== 'receiptId') {
        markLegacyProviderTaskRunNonResumable(input.context, input.runId);
        return LEGACY_PROVIDER_TASK_PRIVATE_DETAIL_REDACTED;
      }
      const rawTask = value.slice('task:'.length);
      const handle = providerTaskPrivacyHandleForRawTask({
        ...input,
        rawTask,
      });
      if (handle !== null) return providerTaskReceiptId(handle);
      markLegacyProviderTaskRunNonResumable(input.context, input.runId);
      return providerTaskReceiptId(
        legacyProviderTaskPrivacyTombstoneHandle(input.runId, input.jobId)
      );
    }
    if (
      EMBEDDED_PROVIDER_TASK_PRIVATE_FIELD.test(value) ||
      EMBEDDED_LEGACY_PROVIDER_TASK_RECEIPT.test(value) ||
      EMBEDDED_PROVIDER_TASK_STATUS_PATH.test(value)
    ) {
      markLegacyProviderTaskRunNonResumable(input.context, input.runId);
      return LEGACY_PROVIDER_TASK_PRIVATE_DETAIL_REDACTED;
    }
    return value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) =>
      migrateLegacyProviderTaskPrivacyValue(item, {
        ...input,
        fieldName: null,
      })
    );
  }
  const record = value as Record<string, unknown>;
  const runId = typeof record.runId === 'string' ? record.runId : input.runId;
  const jobId =
    typeof record.jobId === 'string'
      ? record.jobId
      : typeof record.exportJobId === 'string'
        ? record.exportJobId
        : input.jobId;
  const isProviderTaskEvidence = looksLikeProviderTaskEvidence(record);
  const hasLegacyTaskId = Object.prototype.hasOwnProperty.call(record, 'providerTaskId');
  const existingHandle = record.providerTaskHandleSha256;
  const isProviderTaskHandleCarrier =
    (hasLegacyTaskId || existingHandle !== undefined) &&
    ((typeof record.schema === 'string' &&
      LEGACY_PROVIDER_TASK_HANDLE_CARRIER_SCHEMAS.has(record.schema)) ||
      (typeof record.jobId === 'string' && typeof record.matchSignature === 'string'));
  let migratedHandle: string | null | undefined;
  if (hasLegacyTaskId) {
    migratedHandle =
      record.providerTaskId === null
        ? null
        : providerTaskPrivacyHandleForRawTask({
            context: input.context,
            runId,
            jobId,
            rawTask: record.providerTaskId,
            matchSignature: record.matchSignature,
          });
  } else if (
    existingHandle === null ||
    (typeof existingHandle === 'string' && SHA256_REF.test(existingHandle))
  ) {
    migratedHandle = existingHandle;
  }
  const handleConflict =
    hasLegacyTaskId && existingHandle !== undefined && existingHandle !== migratedHandle;

  const migrated: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(record)) {
    if (key === 'statusPath') {
      if (!hasLegacyTaskId && migratedHandle === undefined) {
        markLegacyProviderTaskRunNonResumable(input.context, runId);
      }
      continue;
    }
    if (key === 'providerTaskId' || key === 'providerTaskHandleSha256') continue;
    if (isProviderTaskEvidence && (key === 'status' || key === 'actionRequired')) continue;
    migrated[key] = migrateLegacyProviderTaskPrivacyValue(nested, {
      context: input.context,
      runId,
      jobId,
      fieldName: key,
    });
  }
  if (isProviderTaskEvidence) {
    const identityUnavailable =
      migratedHandle === undefined ||
      migratedHandle === null ||
      handleConflict ||
      (typeof migratedHandle === 'string' && !SHA256_REF.test(migratedHandle));
    if (identityUnavailable) {
      markLegacyProviderTaskRunNonResumable(input.context, runId);
      migrated.providerTaskHandleSha256 = null;
      migrated.status = 'ACTION_REQUIRED';
      migrated.actionRequired = {
        schema: 'dnaforge.benchling.native-export-action-required.v1',
        code: 'provider_task_identity_invalid',
        providerStatus: null,
        recordedAt: providerTaskPrivacyRecordedAt(record, input.context, runId),
      };
    } else {
      migrated.providerTaskHandleSha256 = migratedHandle;
      migrated.status = migrateLegacyProviderTaskPrivacyValue(record.status, {
        context: input.context,
        runId,
        jobId,
        fieldName: 'status',
      });
      migrated.actionRequired = migrateLegacyProviderTaskPrivacyValue(record.actionRequired, {
        context: input.context,
        runId,
        jobId,
        fieldName: 'actionRequired',
      });
    }
  } else if (isProviderTaskHandleCarrier) {
    if (
      migratedHandle === undefined ||
      migratedHandle === null ||
      handleConflict ||
      !SHA256_REF.test(migratedHandle)
    ) {
      markLegacyProviderTaskRunNonResumable(input.context, runId);
      migrated.providerTaskHandleSha256 = legacyProviderTaskPrivacyTombstoneHandle(runId, jobId);
    } else {
      migrated.providerTaskHandleSha256 = migratedHandle;
    }
  } else if (hasLegacyTaskId) {
    markLegacyProviderTaskRunNonResumable(input.context, runId);
    if (typeof existingHandle === 'string' && SHA256_REF.test(existingHandle)) {
      migrated.providerTaskHandleSha256 = existingHandle;
    }
  } else if (typeof existingHandle === 'string' && SHA256_REF.test(existingHandle)) {
    migrated.providerTaskHandleSha256 = existingHandle;
  } else if (existingHandle !== undefined && existingHandle !== null) {
    markLegacyProviderTaskRunNonResumable(input.context, runId);
  } else if (existingHandle === null) {
    migrated.providerTaskHandleSha256 = null;
  }
  return migrated;
}

function legacyRunHasUrlFreeScopedExportAuthority(
  run: MigrationRun,
  jobsByRunAndId: ReadonlyMap<string, ExportJob>
): boolean {
  if (run.scope.kind !== 'folder' && run.scope.kind !== 'folder_tree') return false;
  for (const job of jobsByRunAndId.values()) {
    if (job.runId !== run.id) continue;
    if (
      (job.directFolderAuthority !== undefined &&
        job.directFolderAuthority.sourceItemUrl === undefined) ||
      (job.folderTreeAuthority !== undefined && job.folderTreeAuthority.sourceItemUrl === undefined)
    ) {
      return true;
    }
  }
  return false;
}

function compareSourceObjectVersions(
  left: Pick<
    PersistedSourceObjectVersion,
    'capturedAt' | 'sourceSnapshotId' | 'sourceJobId' | 'id'
  >,
  right: Pick<
    PersistedSourceObjectVersion,
    'capturedAt' | 'sourceSnapshotId' | 'sourceJobId' | 'id'
  >
): number {
  return (
    Date.parse(left.capturedAt) - Date.parse(right.capturedAt) ||
    left.sourceJobId.localeCompare(right.sourceJobId) ||
    left.sourceSnapshotId.localeCompare(right.sourceSnapshotId) ||
    left.id.localeCompare(right.id)
  );
}

function immutableSourceObjectVersion(
  version: PersistedSourceObjectVersion
): Omit<PersistedSourceObjectVersion, 'supersedesVersionId'> {
  const { supersedesVersionId: _derivedLink, ...immutable } = version;
  return immutable;
}

function sourceObjectWithoutMemberships(
  sourceObject: SourceObject
): Omit<SourceObject, 'memberships'> {
  const { memberships: _memberships, ...content } = sourceObject;
  return content;
}

function parseMigrationTelemetryAttempt(bodyJson: string): BenchlingMigrationAttemptIdentity {
  const value = JSON.parse(bodyJson) as Partial<BenchlingMigrationAttemptIdentity>;
  if (
    value.schema !== 'dnaforge.benchling.telemetry-attempt.v1' ||
    typeof value.attemptId !== 'string' ||
    typeof value.terminalEventId !== 'string' ||
    typeof value.runId !== 'string' ||
    typeof value.sourceAttemptReference !== 'string' ||
    !Number.isSafeInteger(value.attemptSequence) ||
    (value.attemptSequence ?? 0) < 1 ||
    !['initial_import', 'linked_item_recovery', 'workspace_append'].includes(
      value.operation ?? ''
    ) ||
    typeof value.startedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.startedAt))
  ) {
    throw new Error('Persisted migration telemetry attempt is invalid.');
  }
  return value as BenchlingMigrationAttemptIdentity;
}

function parseMigrationTelemetryTerminalReceipt(
  bodyJson: string
): BenchlingMigrationAttemptTerminalReceipt {
  const value = JSON.parse(bodyJson) as Partial<BenchlingMigrationAttemptTerminalReceipt>;
  const identity = value.identity as
    | Partial<BenchlingMigrationAttemptTerminalReceipt['identity']>
    | undefined;
  if (
    value.schema !== 'dnaforge.benchling.telemetry-terminal.v1' ||
    !identity ||
    identity.schema !== 'dnaforge.benchling.telemetry-attempt.v1' ||
    typeof identity.attemptId !== 'string' ||
    typeof identity.terminalEventId !== 'string' ||
    !MIGRATION_TELEMETRY_UUID_RE.test(identity.attemptId) ||
    !MIGRATION_TELEMETRY_UUID_RE.test(identity.terminalEventId) ||
    !Number.isSafeInteger(identity.attemptSequence) ||
    (identity.attemptSequence ?? 0) < 1 ||
    !['initial_import', 'linked_item_recovery', 'workspace_append'].includes(
      identity.operation ?? ''
    ) ||
    typeof identity.startedAt !== 'string' ||
    !Number.isFinite(Date.parse(identity.startedAt)) ||
    !['succeeded', 'failed', 'cancelled_preserved', 'needs_action'].includes(value.outcome ?? '') ||
    typeof value.terminalAt !== 'string' ||
    !Number.isFinite(Date.parse(value.terminalAt)) ||
    !value.counts ||
    !Array.isArray(value.issues)
  ) {
    throw new Error('Persisted migration telemetry terminal receipt is invalid.');
  }
  return value as BenchlingMigrationAttemptTerminalReceipt;
}

const MIGRATION_TELEMETRY_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
