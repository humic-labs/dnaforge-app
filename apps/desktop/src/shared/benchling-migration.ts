export const BENCHLING_MIGRATION_CONTRACT_VERSION = 1 as const;
export const BENCHLING_MIGRATION_LEGACY_REPORT_VERSION = 1 as const;
export const BENCHLING_MIGRATION_REPORT_VERSION = 2 as const;
export const BENCHLING_MIGRATION_BUNDLE_VERSION = 'benchling-migration-bundle-v1' as const;
export const BENCHLING_MIGRATION_PROJECTION_VERSION = 'benchling-migration-v3' as const;
export const BENCHLING_MIGRATION_DESTINATION_INTEGRITY_VERSION =
  'destination-integrity-v1' as const;

export type BenchlingSourceRef = {
  id: string;
  url: string;
  objectType?: string;
};

export const LOCAL_EXPORT_FOLDER_SELECTION_URL_PREFIX =
  'urn:dnaforge:benchling-local-export:pending:' as const;
const LOCAL_EXPORT_FOLDER_SELECTION_ID_PREFIX = 'local-export-folder-' as const;
const LOCAL_EXPORT_SELECTION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function localExportFolderSourceRef(selectionId: string): BenchlingSourceRef {
  return {
    id: `${LOCAL_EXPORT_FOLDER_SELECTION_ID_PREFIX}${selectionId}`,
    url: `${LOCAL_EXPORT_FOLDER_SELECTION_URL_PREFIX}${selectionId}`,
    objectType: 'folder',
  };
}

export function isLocalExportFolderSourceRef(ref: BenchlingSourceRef): boolean {
  if (!ref.url.startsWith(LOCAL_EXPORT_FOLDER_SELECTION_URL_PREFIX)) return false;
  const selectionId = ref.url.slice(LOCAL_EXPORT_FOLDER_SELECTION_URL_PREFIX.length);
  if (!LOCAL_EXPORT_SELECTION_ID_PATTERN.test(selectionId)) return false;
  return ref.id === `${LOCAL_EXPORT_FOLDER_SELECTION_ID_PREFIX}${selectionId}`;
}

export function isLocalExportNamespaceUrl(value: string): boolean {
  return value.startsWith(LOCAL_EXPORT_FOLDER_SELECTION_URL_PREFIX);
}

export function localExportNamespacedUrl(rootUrl: string, sourceId: string): string {
  return `${rootUrl}:item:${encodeURIComponent(sourceId)}`;
}

export function localExportNamespaceRoot(value: string): string {
  const itemMarker = value.indexOf(':item:');
  return itemMarker === -1 ? value : value.slice(0, itemMarker);
}

export type FileMigrationScope = {
  version: typeof BENCHLING_MIGRATION_CONTRACT_VERSION;
  kind: 'file';
  source: BenchlingSourceRef;
  acquisition?: 'local_bundle';
};

export type FolderMigrationScope = {
  version: typeof BENCHLING_MIGRATION_CONTRACT_VERSION;
  kind: 'folder';
  folder: BenchlingSourceRef;
  includeChildren: false;
  includeArchived?: boolean;
  acquisition?: 'local_bundle';
};

export type FolderTreeMigrationScope = {
  version: typeof BENCHLING_MIGRATION_CONTRACT_VERSION;
  kind: 'folder_tree';
  roots: BenchlingSourceRef[];
  includeChildren: true;
  includeArchived?: boolean;
  acquisition?: 'local_bundle';
};

export type MigrationScope = FileMigrationScope | FolderMigrationScope | FolderTreeMigrationScope;

export type SourceBinding = {
  version: typeof BENCHLING_MIGRATION_CONTRACT_VERSION;
  benchlingOrigin: string;
  benchlingOrganizationBaseUrl?: string;
  benchlingAccountId: string;
  benchlingAccountEmail: string;
  benchlingOrganizationId: string;
  benchlingOrganizationName: string;
  chromePairingId: string;
  gmailMailbox?: string;
  accountHash: string;
  confirmedAt: string;
  gmailMismatchConfirmedAt?: string;
};

export type ActiveMigrationState =
  | 'draft'
  | 'identity_confirmation'
  | 'scope_planning'
  | 'export_pending'
  | 'downloading'
  | 'parsing'
  | 'offline_resolution'
  | 'targeted_reads'
  | 'projecting'
  | 'validating'
  | 'ready_to_unlock';

export type InterruptedMigrationState = 'paused' | 'action_required' | 'cancelled_preserved';

export type TerminalMigrationState = 'unlocked' | 'failed' | 'discarded';

export type MigrationState =
  | ActiveMigrationState
  | InterruptedMigrationState
  | TerminalMigrationState;

export type LocalBenchlingExportArtifact = Readonly<{
  schema: 'dnaforge.benchling.local-export-artifact.v1';
  format: 'zip' | 'html';
  logicalFilename: string;
  sha256: `sha256:${string}`;
  sizeBytes: number;
  immutableLocalPath: string;
  capturedAt: string;
  archive: Readonly<{
    entryCount: number;
    totalCompressedEntryBytes: number;
    totalUncompressedEntryBytes: number;
  }> | null;
  resources: readonly LocalBenchlingExportResource[];
}>;

export type LocalBenchlingExportResource = Readonly<{
  sourceRef: string;
  relativePath: string;
  logicalFilename: string;
  sha256: `sha256:${string}`;
  sizeBytes: number;
  mediaType: string;
  immutableLocalPath: string;
}>;

export type LocalBenchlingExportSourceFileIdentity = Readonly<{
  deviceId: string;
  inode: string;
  sizeBytes: number;
  modifiedTimeNs: string;
  changedTimeNs: string;
}>;

export type LocalBenchlingExportPlannedResource = Readonly<{
  sourceRef: string;
  sourcePath: string;
  relativePath: string;
  logicalFilename: string;
  mediaType: string;
  identity: LocalBenchlingExportSourceFileIdentity;
}>;

export type LocalBenchlingExportIntakeDescriptor = Readonly<{
  schema: 'dnaforge.benchling.local-export-intake.v1';
  sourcePath: string;
  logicalFilename: string;
  format: 'zip' | 'html';
  selectedAt: string;
  sourceIdentity: LocalBenchlingExportSourceFileIdentity;
  plannedResources: readonly LocalBenchlingExportPlannedResource[];
  plannedCopyBytes: number;
}>;

export type ExternalZipSource = Readonly<{
  schema: 'dnaforge.benchling.external-zip-source.v1';
  sourceId: string;
  originalPath: string;
  displayName: string;
  zipSha256: `sha256:${string}`;
  sizeBytes: number;
  selectedAt: string;
}>;

export type ExternalZipEntryEvidence = Readonly<{
  schema: 'dnaforge.benchling.external-zip-entry.v1';
  sourceId: string;
  sourceObjectId: string;
  entryPath: string;
  entrySha256: `sha256:${string}`;
  sizeBytes: number;
  mediaType: string | null;
  role: 'source-record' | 'attachment';
}>;

export type LinkedItemRecoveryState =
  | 'copying'
  | 'parsing'
  | 'awaiting_conflict_resolution'
  | 'reconciling'
  | 'validating'
  | 'completed'
  | 'failed';

export type LinkedItemRecoveryVersionConflictPolicy = 'keep_existing' | 'use_incoming';

export type LinkedItemRecoveryVersionConflictSummary =
  | Readonly<{ kind: 'none' }>
  | Readonly<{
      kind: 'awaiting_choice';
      firstConflict: Readonly<{ stableId: string; name: string }>;
    }>
  | Readonly<{
      kind: 'resolved';
      policy: LinkedItemRecoveryVersionConflictPolicy;
      conflictCount: number;
    }>;

export type LinkedItemRecoveryWorkProgress = Readonly<{
  kind:
    | 'copy_bytes'
    | 'read_and_classify_objects'
    | 'write_objects'
    | 'resolve_links'
    | 'validate_saved_objects'
    | 'validate_objects'
    | 'persist_source_files'
    | 'validate_source_files'
    | 'finalize_workspace';
  completed: number;
  total: number;
}>;

export type LinkedItemRecoveryProgress = Readonly<{
  schema: 'dnaforge.benchling.linked-item-recovery-progress.v1';
  mode?: 'linked_item_recovery' | 'workspace_append';
  attemptId: string;
  state: LinkedItemRecoveryState;
  selectedFileCount: number;
  processedFileCount: number;
  recoveredUniqueObjectCount: number;
  repairedRelationshipCount: number;
  retainedExistingObjectCount: number;
  retainedExistingObjects: readonly { stableId: string; name: string }[];
  corroboratedExistingObjectCount: number;
  versionConflictResolution?: LinkedItemRecoveryVersionConflictSummary;
  pendingImportDecision?: import('./benchling-import-decision').PendingImportDecision;
  importDecisionSummary?: import('./benchling-import-decision').ImportDecisionSummary;
  startedAt?: string;
  work?: LinkedItemRecoveryWorkProgress;
  updatedAt: string;
  errorMessage?: string;
}>;

export type MigrationRun = {
  version: typeof BENCHLING_MIGRATION_CONTRACT_VERSION;
  id: string;
  workspaceId: string;
  workspaceDbId?: number;
  repoUuid?: string | null;
  projectionScopeId?: string;
  workspaceOrigin?: MigrationWorkspaceOrigin;
  baseline?: MigrationBaseline;
  workspacePath: string;
  displayName: string;
  scope: MigrationScope;
  binding: SourceBinding | null;
  state: MigrationState;
  resumeState: ActiveMigrationState | null;
  attempt: number;
  converterVersions: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  unlockedAt: string | null;
  lastError: MigrationIssue | null;
  localExportIntake?: LocalBenchlingExportIntakeDescriptor;
  localExportArtifact?: LocalBenchlingExportArtifact;
  externalZipSource?: ExternalZipSource;
  externalZipEntries?: readonly ExternalZipEntryEvidence[];
  localRetryExclusion?: Readonly<{
    zipSha256: `sha256:${string}`;
    entryPaths: readonly string[];
  }>;
  localBestEffortFallback?: Readonly<{
    zipSha256: `sha256:${string}`;
    entryPaths: readonly string[];
    priorRunId: string;
    rootRunId?: string;
  }>;
  linkedItemRecovery?: LinkedItemRecoveryProgress;
};

export type MigrationWorkspaceOrigin =
  | Readonly<{ kind: 'migration_created' }>
  | Readonly<{ kind: 'adopted_existing'; workspaceDbId: number }>;

export type MigrationBaseline =
  | Readonly<{ kind: 'initial_import'; sourceArtifactId: string }>
  | Readonly<{
      kind: 'adopted_workspace';
      adoptedAt: string;
      existingManifestSha256: `sha256:${string}` | null;
    }>;

export function migrationRunSourceIdentityHash(run: MigrationRun): string | null {
  if (run.binding) return run.binding.accountHash;
  if (
    run.scope.acquisition === 'local_bundle' &&
    run.externalZipSource?.schema === 'dnaforge.benchling.external-zip-source.v1'
  ) {
    return run.externalZipSource.zipSha256;
  }
  if (
    run.scope.acquisition === 'local_bundle' &&
    run.localExportArtifact?.schema === 'dnaforge.benchling.local-export-artifact.v1'
  ) {
    return run.localExportArtifact.sha256;
  }
  return null;
}

export type ExportJobState =
  | 'planned'
  | 'submitted'
  | 'receipt_pending'
  | 'receipt_matched'
  | 'downloading'
  | 'captured'
  | 'failed';

export type ExportReceiptSource = 'gmail' | 'provider_task';

type DirectFolderExportAuthorityBase = {
  schema: 'dnaforge.benchling.direct-folder-export-authority.v1';
  capturePlanDigest: string;
  traversalJournalDigest: string;
  selectedRootId: string;
  sourceItemId: string;
  sourceItemUrl?: string;
  sourceFolderIds: [string];
};

export type DirectFolderExportAuthority = DirectFolderExportAuthorityBase &
  (
    | {
        sourceItemType: 'entry';
        requestCapabilityId: 'benchling.notebook-entry-html-export.v1';
      }
    | {
        sourceItemType: 'sequence';
        requestCapabilityId: 'benchling.sequence-single-file-export.v1';
      }
  );

type FolderTreeExportAuthorityBase = {
  schema: 'dnaforge.benchling.folder-tree-export-authority.v1';
  capturePlanDigest: string;
  traversalJournalDigest: string;
  selectedRootId: string;
  sourceItemId: string;
  sourceItemUrl?: string;
  sourceFolderIds: string[];
  maximumFolderDepth: number;
};

export type FolderTreeExportAuthority = FolderTreeExportAuthorityBase &
  (
    | {
        sourceItemType: 'entry';
        requestCapabilityId: 'benchling.notebook-entry-html-export.v1';
      }
    | {
        sourceItemType: 'sequence';
        requestCapabilityId: 'benchling.sequence-single-file-export.v1';
      }
  );

export type FolderTreeExportReplacementLineage = {
  schema: 'dnaforge.benchling.folder-tree-export-replacement-lineage.v1';
  predecessorJobId: string;
  predecessorMatchSignature: string;
  reason: 'download_link_expired';
  ordinal: 0;
};

export type GmailReceiptInferenceEvidence = {
  schema: 'dnaforge.benchling.gmail-receipt-inference.v1';
  id: string;
  runId: string;
  jobId: string;
  receiptId: string;
  plannedMatchSignature: string;
  downloadUrlHash: string;
  matchConfidence: 'inferred' | 'ambiguous';
  contentFamily: string;
  sourceRootIds: string[];
  observedAt: string;
};

export type GmailReceiptConfirmationEvidence = {
  schema: 'dnaforge.benchling.gmail-receipt-confirmation.v1';
  id: string;
  runId: string;
  inferenceId: string;
  jobId: string;
  receiptId: string;
  matchSignature: string;
  downloadUrlHash: string;
  confirmedAt: string;
  basis: 'explicit_user_confirmation';
};

export type ProviderTaskStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'ACTION_REQUIRED';

export type ProviderTaskActionRequiredCode =
  | 'provider_task_identity_invalid'
  | 'provider_task_failed'
  | 'provider_task_download_url_not_allowlisted'
  | 'provider_task_unavailable'
  | 'provider_task_session_locator_unavailable'
  | 'provider_task_status_not_dispatched'
  | 'provider_task_status_invalid_json'
  | 'provider_task_status_invalid_response'
  | 'provider_task_status_undocumented';

export type ProviderTaskGmailRescanAuthorization =
  | Readonly<{
      schema: 'dnaforge.benchling.provider-task-gmail-rescan.v1';
      scopeKind: 'file';
      runId: string;
      jobId: string;
      matchSignature: string;
      runAttempt: number;
      priorCapabilityRunAttempt: number;
      requestOrdinal: 1;
      requestLimit: 1;
      requiredProviderTaskStatus: 'RUNNING';
      interventionSha256: string;
    }>
  | Readonly<{
      schema: 'dnaforge.benchling.provider-task-direct-folder-gmail-rescan.v1';
      scopeKind: 'folder';
      runId: string;
      jobId: string;
      matchSignature: string;
      runAttempt: number;
      priorCapabilityRunAttempt: number;
      requestOrdinal: 1;
      requestLimit: 1;
      requiredProviderTaskStatus: 'RUNNING';
      interventionSha256: string;
      directFolderAuthorityDigest: string;
      directFolderSourceItemNameSha256: string;
      nativeExportLedgerEpoch: string;
      originalCommandRequestId: string;
      providerTaskHandleSha256: string;
      priorFallbackCommandRequestId: string;
      priorFallbackActivitySha256: string;
    }>
  | Readonly<{
      schema: 'dnaforge.benchling.provider-task-direct-folder-gmail-rescan.v2';
      scopeKind: 'folder';
      dispatchMode: 'gmail_page_only';
      runId: string;
      jobId: string;
      matchSignature: string;
      runAttempt: number;
      priorCapabilityRunAttempt: number;
      rescanOrdinal: number;
      pageReadOrdinal: 1;
      pageReadLimit: 1;
      requiredProviderTaskStatus: 'RUNNING';
      interventionSha256: string;
      directFolderAuthorityDigest: string;
      directFolderSourceItemNameSha256: string;
      nativeExportLedgerEpoch: string;
      originalCommandRequestId: string;
      providerTaskHandleSha256: string;
      priorFallbackCommandRequestId: string;
      priorFallbackActivitySha256: string;
      rootRescanCommandRequestId: string;
      rootRescanActivitySha256: string;
      priorRescanCommandRequestId: string;
      priorRescanActivitySha256: string;
    }>
  | Readonly<{
      schema: 'dnaforge.benchling.provider-task-direct-folder-sequence-gmail-recovery.v1';
      scopeKind: 'folder';
      dispatchMode: 'gmail_page_only';
      runId: string;
      jobId: string;
      matchSignature: string;
      runAttempt: number;
      priorCapabilityRunAttempt: number;
      pageReadOrdinal: 1;
      pageReadLimit: 1;
      requiredProviderTaskStatus: 'ACTION_REQUIRED';
      priorActionRequiredCode: 'provider_task_status_undocumented';
      priorDiagnostic: 'unrecognized_status';
      interventionSha256: string;
      directFolderAuthorityDigest: string;
      directFolderSourceItemNameSha256: string;
      nativeExportLedgerEpoch: string;
      originalCommandRequestId: string;
      providerTaskHandleSha256: string;
    }>
  | Readonly<{
      schema: 'dnaforge.benchling.provider-task-direct-folder-succeeded-gmail-recovery.v1';
      scopeKind: 'folder';
      dispatchMode: 'gmail_page_only';
      runId: string;
      jobId: string;
      matchSignature: string;
      runAttempt: number;
      priorCapabilityRunAttempt: number;
      recoveryOrdinal: number;
      pageReadOrdinal: 1;
      pageReadLimit: 1;
      requiredProviderTaskStatus: 'SUCCEEDED';
      interventionSha256: string;
      directFolderAuthorityDigest: string;
      directFolderSourceItemNameSha256: string;
      nativeExportLedgerEpoch: string;
      originalCommandRequestId: string;
      providerTaskHandleSha256: string;
      rootSucceededCommandRequestId: string;
      rootSucceededActivitySha256: string;
      priorRecoveryCommandRequestId: string;
      priorRecoveryActivitySha256: string;
    }>;

export type ProviderTaskActionRequiredEvidence = {
  schema: 'dnaforge.benchling.native-export-action-required.v1';
  code: ProviderTaskActionRequiredCode;
  providerStatus: 'FAILED' | 'SUCCEEDED' | null;
  recordedAt: string;
  diagnostic?:
    | 'unrecognized_status'
    | 'unexpected_fields'
    | 'pending_result_non_null'
    | 'success_result_not_null';
};

export type ProviderTaskEvidence = {
  id: string;
  runId: string;
  jobId: string;
  matchSignature: string;
  providerTaskHandleSha256: string | null;
  status: ProviderTaskStatus;
  actionRequired: ProviderTaskActionRequiredEvidence | null;
  observedAt: string;
};

export type ProviderRequestClass =
  | 'export_submit'
  | 'export_task_status'
  | 'gmail_receipt_page'
  | 'export_archive_metadata'
  | 'export_archive_range'
  | 'export_archive_download'
  | 'folder_scope_discovery'
  | 'targeted_read';

export type ProviderActivityOperationKind =
  | 'submit_export'
  | 'reconcile_export_submission'
  | 'poll_export_receipts'
  | 'recover_export_receipt'
  | 'inspect_export'
  | 'inspect_export_range'
  | 'discover_failed_export_split'
  | 'discover_scoped_folder_page'
  | 'download_export'
  | 'targeted_read';

export type GmailReceiptFilterSummary = {
  schema: 'dnaforge.benchling.gmail-receipt-filter-summary.v1';
  rejected: {
    sender: number;
    date: number;
    family: number;
    time: number;
    excluded: number;
  };
  countsAreExact: boolean;
};

export type ProviderActivityObservation =
  | {
      ordinal: number;
      kind: 'network_request';
      requestClass: ProviderRequestClass;
      providerSurface: 'benchling_tenant' | 'benchling_temp_storage' | 'gmail_web';
      method: 'GET' | 'HEAD' | 'POST' | 'READ';
      result: 'response' | 'transport_error';
      statusClass: '2xx' | '3xx' | '4xx' | '5xx' | null;
    }
  | {
      ordinal: number;
      kind: 'cache_hit';
      requestClass: ProviderRequestClass;
      providerSurface: 'benchling_tenant' | 'benchling_temp_storage' | 'gmail_web';
      method: 'GET' | 'HEAD' | 'POST' | 'READ';
      cacheLayer: 'extension_memory' | 'extension_session' | 'main_process_memory' | 'browser_page';
      filterSummary?: GmailReceiptFilterSummary;
    }
  | {
      ordinal: number;
      kind: 'local_miss';
      requestClass: 'gmail_receipt_page';
      providerSurface: 'gmail_web';
      method: 'READ';
      reason: 'receipt_not_open';
    }
  | {
      ordinal: number;
      kind: 'local_miss';
      requestClass: 'folder_scope_discovery';
      providerSurface: 'benchling_tenant';
      method: 'POST';
      reason: 'traversal_authority_missing' | 'provider_pre_dispatch_blocked';
    };

export type ProviderActivityBundle = {
  id: string;
  runId: string;
  commandRequestId: string;
  operationKind: ProviderActivityOperationKind;
  observedAt: string;
  schema: 'dnaforge.benchling.provider-activity-bundle.v1';
  complete: boolean;
  observations: ProviderActivityObservation[];
};

export type ScopedFolderCommandCorrelation = {
  schema: 'dnaforge.benchling.scoped-folder-command.v1';
  purpose: 'advance' | 'rehydrate';
  scopeKind: 'folder' | 'folder_tree';
  includeArchived?: boolean;
  selectedRootId: string;
  folderId: string;
  pageIndex: number;
  pageRequestSha256: string;
  restartTraversal: boolean;
  receiptEpoch: string;
};

export type ProviderCommandJournalEntry = {
  id: string;
  runId: string;
  commandRequestId: string;
  operationKind: ProviderActivityOperationKind;
  exportJobId?: string;
  nativeExportLedgerEpoch?: string;
  reconcilesCommandRequestId?: string;
  explicitResumeAttempt?: number;
  interventionSha256?: string;
  scopedFolderCorrelation?: ScopedFolderCommandCorrelation;
  directFolderGmailRescan?: Extract<ProviderTaskGmailRescanAuthorization, { scopeKind: 'folder' }>;
  issuedAt: string;
};

export type NativeExportDownloadAcceptanceEvidence = Readonly<{
  schema: 'dnaforge.benchling.native-export-download-acceptance.v1';
  id: string;
  runId: string;
  exportJobId: string;
  matchSignature: string;
  receiptId: string;
  downloadUrlHash: string;
  nativeExportLedgerEpoch: string;
  downloadCommandRequestId: string;
  acceptedAt: string;
  evidenceSha256: string;
}>;

export type NativeExportLedgerState =
  | 'absent'
  | 'dispatching'
  | 'accepted'
  | 'polling'
  | 'succeeded'
  | 'action_required'
  | 'ambiguous'
  | 'rejected';

export type NativeExportSubmissionReconciliationEvidence = {
  schema: 'dnaforge.benchling.native-export-reconciliation.v1';
  id: string;
  runId: string;
  exportJobId: string;
  matchSignature: string;
  originalCommandRequestId: string;
  reconciliationCommandRequestId: string;
  nativeExportLedgerEpoch: string;
  explicitResumeAttempt: number;
  interventionSha256: string;
  priorLedgerState: NativeExportLedgerState;
  disposition: 'dispatched' | 'cache_hit' | 'blocked';
  accepted: boolean;
  observedAt: string;
};

export type ExportJob = {
  id: string;
  runId: string;
  contentFamily: string;
  sourceRoots: BenchlingSourceRef[];
  matchSignature: string;
  directFolderAuthority?: DirectFolderExportAuthority;
  folderTreeAuthority?: FolderTreeExportAuthority;
  folderTreeReplacementLineage?: FolderTreeExportReplacementLineage;
  state: ExportJobState;
  submittedAt: string | null;
  attempts: number;
  receiptId: string | null;
  receiptSource?: ExportReceiptSource | null;
  downloadUrlHash: string | null;
  receiptConfirmationId?: string | null;
  snapshotPartId: string | null;
};

export type SnapshotPartKind =
  | 'export_archive'
  | 'targeted_read'
  | 'local_export'
  | 'supplemental_local_export';

export type SourceSnapshotPart = {
  id: string;
  kind: SnapshotPartKind;
  sha256: string;
  sizeBytes: number;
  capturedAt: string;
  sourceJobId: string | null;
  sourceObjectId: string | null;
  supersedesPartId: string | null;
};

export type LocalNativeFolderZipCanonicalClass = 'notebook' | 'dna_rna' | 'protein';

export type LocalNativeFolderZipAttachmentClass =
  | 'png'
  | 'jpg'
  | 'pdf'
  | 'ab1'
  | 'gbk'
  | 'seq'
  | 'other';

export type LocalNativeFolderZipRepresentationClass =
  | 'sequence_txt'
  | 'sequence_html'
  | 'protein_txt'
  | 'protein_gp'
  | 'protein_html'
  | 'benchling_css';

export type LocalNativeFolderZipInventory = Readonly<{
  schema: 'dnaforge.benchling.local-native-folder-zip-inventory.v1';
  catalog: Readonly<{
    physicalEntryCount: number;
    uniqueEntryCount: number;
  }>;
  canonicalObjects: Readonly<{
    archiveTotal: number;
    archiveByClass: Readonly<Record<LocalNativeFolderZipCanonicalClass, number>>;
    selectedTotal: number;
    selectedByClass: Readonly<Record<LocalNativeFolderZipCanonicalClass, number>>;
    importedTotal: number;
    importedByClass: Readonly<Record<LocalNativeFolderZipCanonicalClass, number>>;
    excludedByScopeTotal: number;
    archiveMembershipTotal: number;
    selectedMembershipTotal: number;
    importedMembershipTotal: number;
    skipped: readonly Readonly<{
      sourceObjectId: string;
      canonicalClass: LocalNativeFolderZipCanonicalClass;
      reasonCode: 'empty_sequence' | 'unsupported_content';
      reason: string;
    }>[];
  }>;
  selectedAttachments: Readonly<{
    total: number;
    uniqueOwnerContentTotal?: number;
    byClass: Readonly<Record<LocalNativeFolderZipAttachmentClass, number>>;
  }>;
  archiveRepresentations: Readonly<{
    alternateTotal: number;
    alternateByClass: Readonly<
      Record<
        Exclude<LocalNativeFolderZipRepresentationClass, 'benchling_css' | 'other_support'>,
        number
      >
    >;
    supportTotal: number;
    supportByClass: Readonly<
      Record<
        Extract<LocalNativeFolderZipRepresentationClass, 'benchling_css' | 'other_support'>,
        number
      >
    >;
    collapsedIdenticalSupportDuplicateCount: number;
  }>;
  folders: Readonly<{
    inferredCount: number;
    explicitDirectoryEntryCount: number;
    emptyFoldersNotPreservableBecauseArchiveOmitsDirectoryEntries: boolean;
  }>;
  rootBinding: Readonly<{
    archiveDisplayRoot: string;
    selectedStableFolderId: string;
    selectedStableFolderIdSource: 'pasted_projects_route_or_user_selection';
    archiveContainsSelectedStableFolderId: boolean;
    associationVerification: 'user_asserted_not_archive_verified';
  }>;
}>;

export function isLocalNativeFolderZipInventory(
  value: unknown
): value is LocalNativeFolderZipInventory {
  if (
    !isPlainRecord(value) ||
    value.schema !== 'dnaforge.benchling.local-native-folder-zip-inventory.v1'
  ) {
    return false;
  }
  const catalog = value.catalog;
  const canonical = value.canonicalObjects;
  const attachments = value.selectedAttachments;
  const representations = value.archiveRepresentations;
  const folders = value.folders;
  const root = value.rootBinding;
  if (
    !isPlainRecord(catalog) ||
    !isPlainRecord(canonical) ||
    !isPlainRecord(attachments) ||
    !isPlainRecord(representations) ||
    !isPlainRecord(folders) ||
    !isPlainRecord(root) ||
    !hasNonNegativeIntegerFields(catalog, ['physicalEntryCount', 'uniqueEntryCount']) ||
    Number(catalog.uniqueEntryCount) > Number(catalog.physicalEntryCount) ||
    !hasNonNegativeIntegerFields(canonical, [
      'archiveTotal',
      'selectedTotal',
      'importedTotal',
      'excludedByScopeTotal',
      'archiveMembershipTotal',
      'selectedMembershipTotal',
      'importedMembershipTotal',
    ]) ||
    !hasExactCountRecord(canonical.archiveByClass, ['notebook', 'dna_rna', 'protein']) ||
    !hasExactCountRecord(canonical.selectedByClass, ['notebook', 'dna_rna', 'protein']) ||
    !hasExactCountRecord(canonical.importedByClass, ['notebook', 'dna_rna', 'protein']) ||
    !Array.isArray(canonical.skipped) ||
    !hasNonNegativeIntegerFields(attachments, ['total']) ||
    (attachments.uniqueOwnerContentTotal !== undefined &&
      (!Number.isSafeInteger(attachments.uniqueOwnerContentTotal) ||
        Number(attachments.uniqueOwnerContentTotal) < 0 ||
        Number(attachments.uniqueOwnerContentTotal) > Number(attachments.total))) ||
    !hasExactCountRecord(attachments.byClass, [
      'png',
      'jpg',
      'pdf',
      'ab1',
      'gbk',
      'seq',
      'other',
    ]) ||
    !hasNonNegativeIntegerFields(representations, [
      'alternateTotal',
      'supportTotal',
      'collapsedIdenticalSupportDuplicateCount',
    ]) ||
    !hasExactCountRecord(representations.alternateByClass, [
      'sequence_txt',
      'sequence_html',
      'protein_txt',
      'protein_gp',
      'protein_html',
    ]) ||
    !hasExactCountRecord(representations.supportByClass, ['benchling_css']) ||
    !hasNonNegativeIntegerFields(folders, ['inferredCount', 'explicitDirectoryEntryCount']) ||
    typeof folders.emptyFoldersNotPreservableBecauseArchiveOmitsDirectoryEntries !== 'boolean'
  ) {
    return false;
  }
  const selectedByClass = canonical.selectedByClass as Record<
    LocalNativeFolderZipCanonicalClass,
    number
  >;
  const importedByClass = canonical.importedByClass as Record<
    LocalNativeFolderZipCanonicalClass,
    number
  >;
  const skippedIds = new Set<string>();
  const skippedByClass: Record<LocalNativeFolderZipCanonicalClass, number> = {
    notebook: 0,
    dna_rna: 0,
    protein: 0,
  };
  for (const skipped of canonical.skipped) {
    if (
      !isPlainRecord(skipped) ||
      typeof skipped.sourceObjectId !== 'string' ||
      !/^(?:etr|seq|prtn)_[A-Za-z0-9]+$/u.test(skipped.sourceObjectId) ||
      skippedIds.has(skipped.sourceObjectId) ||
      !['notebook', 'dna_rna', 'protein'].includes(String(skipped.canonicalClass)) ||
      !['empty_sequence', 'unsupported_content'].includes(String(skipped.reasonCode)) ||
      !['Canonical sequence is empty.', 'Canonical content is unsupported.'].includes(
        String(skipped.reason)
      )
    ) {
      return false;
    }
    skippedIds.add(skipped.sourceObjectId);
    skippedByClass[skipped.canonicalClass as LocalNativeFolderZipCanonicalClass] += 1;
  }
  if (
    typeof root.archiveDisplayRoot !== 'string' ||
    root.archiveDisplayRoot.trim() !== root.archiveDisplayRoot ||
    root.archiveDisplayRoot.length === 0 ||
    root.archiveDisplayRoot.length > 256 ||
    hasUnsafeInventoryIdentifierCharacter(root.archiveDisplayRoot) ||
    typeof root.selectedStableFolderId !== 'string' ||
    root.selectedStableFolderId.trim() !== root.selectedStableFolderId ||
    root.selectedStableFolderId.length === 0 ||
    root.selectedStableFolderId.length > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(root.selectedStableFolderId) ||
    root.selectedStableFolderIdSource !== 'pasted_projects_route_or_user_selection' ||
    typeof root.archiveContainsSelectedStableFolderId !== 'boolean' ||
    root.associationVerification !== 'user_asserted_not_archive_verified'
  ) {
    return false;
  }
  return (
    Number(catalog.physicalEntryCount) ===
      Number(catalog.uniqueEntryCount) +
        Number(representations.collapsedIdenticalSupportDuplicateCount) &&
    canonical.archiveTotal === sumCountRecord(canonical.archiveByClass) &&
    canonical.selectedTotal === sumCountRecord(canonical.selectedByClass) &&
    canonical.importedTotal === sumCountRecord(canonical.importedByClass) &&
    canonical.archiveTotal ===
      Number(canonical.selectedTotal) + Number(canonical.excludedByScopeTotal) &&
    canonical.selectedTotal === canonical.importedTotal + canonical.skipped.length &&
    (['notebook', 'dna_rna', 'protein'] as const).every(
      (canonicalClass) =>
        selectedByClass[canonicalClass] ===
        importedByClass[canonicalClass] + skippedByClass[canonicalClass]
    ) &&
    Number(canonical.archiveMembershipTotal) >= Number(canonical.archiveTotal) &&
    Number(canonical.archiveMembershipTotal) >= Number(canonical.selectedMembershipTotal) &&
    Number(canonical.selectedMembershipTotal) >= Number(canonical.importedMembershipTotal) &&
    attachments.total === sumCountRecord(attachments.byClass) &&
    representations.alternateTotal === sumCountRecord(representations.alternateByClass) &&
    representations.supportTotal === sumCountRecord(representations.supportByClass) &&
    folders.emptyFoldersNotPreservableBecauseArchiveOmitsDirectoryEntries ===
      (folders.explicitDirectoryEntryCount === 0)
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasUnsafeInventoryIdentifierCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (character === '/' || character === '\\' || codePoint <= 0x1f || codePoint === 0x7f) {
      return true;
    }
  }
  return false;
}

function hasNonNegativeIntegerFields(
  value: Record<string, unknown>,
  fields: readonly string[]
): boolean {
  return fields.every((field) => Number.isSafeInteger(value[field]) && Number(value[field]) >= 0);
}

function hasExactCountRecord(value: unknown, fields: readonly string[]): boolean {
  return (
    isPlainRecord(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Number.isSafeInteger(value[field]) && Number(value[field]) >= 0)
  );
}

function sumCountRecord(value: unknown): number {
  return isPlainRecord(value)
    ? Object.values(value).reduce<number>((total, count) => total + Number(count), 0)
    : Number.NaN;
}

export type SourceSnapshot = {
  version: typeof BENCHLING_MIGRATION_CONTRACT_VERSION;
  id: string;
  runId: string;
  accountHash: string;
  createdAt: string;
  archiveManifestId: string;
  initialSourceObjectIds: string[];
  expectedSourceObjectCount: number;
  expectedAttachmentCount: number;
  expectedMembershipCount: number;
  localExportWarnings?: string[];
  localNativeFolderZipInventory?: LocalNativeFolderZipInventory;
  parts: SourceSnapshotPart[];
};

export type RelationshipEvidenceKind =
  | 'stable_id'
  | 'url'
  | 'registry_id'
  | 'archive_path'
  | 'attachment_hash'
  | 'alias'
  | 'name'
  | 'timestamp'
  | 'source_type'
  | 'sequence_identity';

export type RelationshipEvidence = {
  kind: RelationshipEvidenceKind;
  value: string;
  sourcePath?: string;
};

export type RelationshipResolutionClass =
  | 'exact'
  | 'heuristic'
  | 'ambiguous'
  | 'unresolved'
  | 'external'
  | 'source_broken';

export const PROVIDER_REFERENCE_OUTCOMES = [
  'resolved',
  'pending',
  'ambiguous',
  'external',
  'source_broken',
] as const;

export type ValidationProviderReferenceOutcome = (typeof PROVIDER_REFERENCE_OUTCOMES)[number];

export type ValidationProviderReferenceDetail = Readonly<{
  relationshipId: string;
  targetStableObjectId: string | null;
  objectClass: string;
  outcome: ValidationProviderReferenceOutcome;
  title: string | null;
  action: 'none' | 'add_export' | 'review' | 'open_in_benchling' | 'unavailable';
}>;

export type ValidationProviderReferenceEvidence = Readonly<{
  schema: 'dnaforge.benchling.provider-reference-outcomes.v1';
  counts: Readonly<Record<ValidationProviderReferenceOutcome, number>>;
  total: number;
  details: readonly ValidationProviderReferenceDetail[];
  truncated: boolean;
}>;

export type SourceRelationship = {
  id: string;
  sourceObjectId: string;
  targetSourceId?: string;
  targetUrl?: string;
  relationType?: string;
  direction: 'outbound';
  sourceBroken?: boolean;
  evidence: RelationshipEvidence[];
};

export type RelationshipResolution = {
  relationshipId: string;
  sourceObjectId: string;
  targetSourceId: string | null;
  relationType: string;
  classification: RelationshipResolutionClass;
  evidence: RelationshipEvidence[];
  candidateSourceIds: string[];
  requiresTargetedRead: boolean;
  reason: string;
};

export type SourceObject = {
  id: string;
  stableId: string;
  sourceType: string;
  schemaId?: string;
  name: string;
  registryId?: string;
  aliases: string[];
  sourceUrl: string;
  sourcePath?: string;
  attachmentHashes: string[];
  memberships: string[];
  createdAt?: string;
  modifiedAt?: string;
  metadata: Record<string, unknown>;
  content: unknown;
  relationships: SourceRelationship[];
};

export type ProjectionKind =
  | 'native'
  | 'portable_file'
  | 'adapter_staging'
  | 'fallback'
  | 'artifact';

export type ProjectionFormulaEvidence = {
  locator: string;
  formula: string;
  compatibility: 'supported' | 'unsupported';
  stale: boolean;
};

export type NativeRepresentation = 'dna_sequence' | 'strain' | 'dna_sequence_needs_sequence';

export type ProjectionDestination =
  | Readonly<{ kind: 'file'; relativePath: string }>
  | Readonly<{
      kind: 'package';
      rootRelativePath: string;
      primaryRelativePath: string;
    }>
  | Readonly<{
      kind: 'catalog-record';
      parentRelativePath: string;
      displayName: string;
      catalogType: string;
      presentationKind: import('./catalog-entity').CatalogRecordPresentationKind;
    }>;

export type CatalogProjectionPayload = Readonly<{
  sourceObjectId: string;
  providerStableId: string;
  sourceType: string;
  name: string;
  registryId: string | null;
  metadata: Readonly<Record<string, unknown>>;
  content: unknown;
}>;

type ProjectionReceiptBody = {
  id: string;
  runId: string;
  sourceObjectId: string;
  destinationObjectId: string;
  destinationPath: string;
  projection: ProjectionKind;
  nativeRepresentation?: NativeRepresentation;
  converterId: string;
  converterVersion: string;
  sourceHash: string;
  destinationHash: string;
  warnings: string[];
  exception: string | null;
  formulaEvidence?: ProjectionFormulaEvidence[];
  retainedDestination?: { actionId: string; expectedScientificSha256: `sha256:${string}` };
  createdAt: string;
};

export type ProjectionReceipt = ProjectionReceiptBody &
  (
    | { destination?: undefined; catalogPayload?: never }
    | { destination: Extract<ProjectionDestination, { kind: 'file' }>; catalogPayload?: never }
    | { destination: Extract<ProjectionDestination, { kind: 'package' }>; catalogPayload?: never }
    | {
        destination: Extract<ProjectionDestination, { kind: 'catalog-record' }>;
        catalogPayload?: CatalogProjectionPayload;
      }
  );

export type MigrationIssueCode =
  | 'identity_unverified'
  | 'identity_mismatch'
  | 'protected_account'
  | 'scope_plan_incomplete'
  | 'unsupported_scope_item'
  | 'local_export_warning'
  | 'unsafe_archive'
  | 'insufficient_storage'
  | 'ambiguous_receipt'
  | 'provider_retry_exhausted'
  | 'required_target_missing'
  | 'hash_mismatch'
  | 'projection_failed'
  | 'projection_contract_restart_required'
  | 'validation_failed'
  | 'migration_interrupted'
  | 'source_unavailable'
  | 'internal_invariant';

export type MigrationIssue = {
  code: MigrationIssueCode;
  message: string;
  blocking: boolean;
  sourceObjectId?: string;
  sourceFileName?: string;
  relationshipId?: string;
  details?: Record<string, unknown>;
};

export type ValidationSection = {
  expected: number;
  actual: number;
  passed: boolean;
  issues: MigrationIssue[];
};

type ValidationReportBody = {
  runId: string;
  scope: MigrationScope;
  snapshotId: string;
  accountHash: string;
  generatedAt: string;
  passed: boolean;
  sourceObjects: ValidationSection;
  attachments: ValidationSection;
  memberships: ValidationSection;
  relationships: ValidationSection & {
    countsByClass: Record<RelationshipResolutionClass, number>;
  };
  projections: ValidationSection & {
    native: number;
    nativeRepresentations: {
      dnaSequence: number;
      strain: number;
      needsSequence: number;
    };
    portableFile?: number;
    adapterStaging?: number;
    fallback?: number;
    artifact: number;
    exceptions: number;
  };
  hashes: ValidationSection;
  rendering: ValidationSection;
  issues: MigrationIssue[];
};

export type ValidationExportJobEvidence = {
  jobId: string;
  contentFamily: string;
  sourceRootIds: string[];
  outcome: 'captured' | 'failed_with_successful_replacement' | 'incomplete';
  receiptId: string | null;
  receiptSource: ExportReceiptSource | null;
  downloadUrlHash: string | null;
  receiptConfirmationId: string | null;
  inspection: {
    inspectedAt: string;
    compressedArchiveBytes: number;
    declaredUncompressedBytes: number;
    entryCount: number;
    rangeRequestCount: number;
    rangeBytesRead: number;
  } | null;
  snapshotPartId: string | null;
  replacementJobIds: string[];
};

export type ValidationSnapshotPartEvidence = {
  partId: string;
  kind: SnapshotPartKind;
  sourceJobId: string | null;
  sourceObjectId: string | null;
  sha256: string;
  sizeBytes: number;
  capturedAt: string;
  supersedesPartId: string | null;
};

export type ValidationFormulaEvidence = ProjectionFormulaEvidence & {
  sourceObjectId: string;
  receiptId: string;
};

export type ValidationProjectionExceptionEvidence = {
  sourceObjectId: string;
  receiptId: string;
  converterId: string;
  message: string;
  preservedAs: ProjectionKind;
  prominentlyLabeled: boolean;
};

export type ValidationCollectionEvidence = {
  sourceFolderId: string;
  destinationCollectionId: string;
  parentCollectionId: string | null;
  childCollectionIds: string[];
  memberObjectIds: string[];
  excludedChildFolderIds: string[];
};

export type ValidationScopedBoundarySourceIdMode = 'benchling' | 'replay_fixture';

export type ValidationScopedBoundaryPageEvidence = {
  pageIndex: number;
  requestCursorHash: string | null;
  nextCursorHash: string | null;
  responseSha256: string;
  sourceIds: string[];
};

export type ValidationScopedBoundaryFolderEvidence = {
  ref: BenchlingSourceRef;
  name: string;
  parentFolderId: string | null;
  childrenEnumerated: boolean;
  sourceAccountHash: string;
};

export type ValidationScopedBoundaryEvidenceBody = {
  schema: 'dnaforge.scoped-boundary-evidence.v1';
  runId: string;
  scope: Exclude<MigrationScope, { kind: 'file' }>;
  sourceAccountHash: string;
  capturedAt: string;
  folders: ValidationScopedBoundaryFolderEvidence[];
  enumerations: Array<{
    sourceFolderId: string;
    childFolderPages: ValidationScopedBoundaryPageEvidence[];
    directItemPages: ValidationScopedBoundaryPageEvidence[];
  }>;
};

export type ValidationScopedBoundaryEvidence = {
  schema: 'dnaforge.migration.scoped-boundary-attestation.v1';
  evidencePath: '.dnaforge/migration/scoped-boundary-evidence.json';
  canonicalSha256: string;
  sourceIdMode: ValidationScopedBoundarySourceIdMode;
  evidence: ValidationScopedBoundaryEvidenceBody;
};

export type ValidationDirectFolderCaptureItemEvidence = {
  sourceItemId: string;
  initialJobId: string;
  successfulLeafJobId: string;
  chainJobIds: string[];
  authority: DirectFolderExportAuthority;
  authoritySha256: string;
};

export type ValidationScopedCaptureSkippedItemEvidence = {
  sourceItemId: string;
  sourceType: string;
  reason: 'archived_item_unproven' | 'unknown_item_type' | 'unproven_item_request';
  sourceFolderIds: string[];
};

export type ValidationDirectFolderCaptureEvidence = {
  schema: 'dnaforge.migration.direct-folder-capture-attestation.v1';
  capturePlanDigest: string;
  traversalJournalDigest: string;
  sourceAccountHash: string;
  selectedRootId: string;
  boundaryCanonicalSha256: string;
  authorityManifestSha256: string;
  lineageManifestSha256: string;
  plannedItemCount: number;
  successfulLeafCount: number;
  items: ValidationDirectFolderCaptureItemEvidence[];
  skippedItemCount?: number;
  skippedItems?: ValidationScopedCaptureSkippedItemEvidence[];
};

export type ValidationFolderTreeCaptureItemEvidence = {
  sourceItemId: string;
  sourceFolderIds: string[];
  initialJobId: string;
  successfulLeafJobId: string;
  chainJobIds: string[];
  authority: FolderTreeExportAuthority;
  authoritySha256: string;
};

export type ValidationFolderTreeCaptureEvidence = {
  schema: 'dnaforge.migration.folder-tree-capture-attestation.v1';
  capturePlanDigest: string;
  traversalJournalDigest: string;
  sourceAccountHash: string;
  selectedRootId: string;
  boundaryCanonicalSha256: string;
  authorityManifestSha256: string;
  lineageManifestSha256: string;
  maximumFolderDepth: number;
  includedFolderIds: string[];
  excludedFolderIds: string[];
  plannedItemCount: number;
  successfulLeafCount: number;
  items: ValidationFolderTreeCaptureItemEvidence[];
  skippedItemCount?: number;
  skippedItems?: ValidationScopedCaptureSkippedItemEvidence[];
};

export type ValidationDestinationArtifactKind =
  | 'projection_bundle'
  | 'registry_projection'
  | 'destination_link_index'
  | 'collection_projection_manifest'
  | 'native_collection'
  | 'native_folder';

export type ValidationDestinationArtifactEvidence = {
  kind: ValidationDestinationArtifactKind;
  path: string;
  sha256: string;
};

export type ValidationDestinationIntegrityEvidence = {
  schema: 'dnaforge.migration.destination-integrity.v1';
  receiptCount: number;
  receiptLedgerSha256: string;
  artifacts: ValidationDestinationArtifactEvidence[];
};

export type ValidationDirectFolderImportScopeEvidence = {
  schema: 'dnaforge.migration.direct-folder-import-scope.v1';
  selectedSourceObjectIds: string[];
  approvedOneHopDependencySourceObjectIds: string[];
  importedOneHopDependencySourceObjectIds: string[];
};

export type LinkedItemRecoveryObjectType = 'dna_rna_sequence' | 'protein' | 'protocol' | 'other';

export type ValidationLinkedItemRecoveryTargetEvidence = Readonly<{
  sourceId: string;
  name: string;
  sourceUrl: string;
  objectType: LinkedItemRecoveryObjectType;
  folderId: string;
  relationshipCount: number;
  relationshipIds: readonly string[];
  recovered: boolean;
}>;

export type ValidationLinkedItemRecoveryFolderEvidence = Readonly<{
  sourceId: string;
  name: string;
  sourceUrl: string;
  targetCount: number;
  relationshipCount: number;
  countsByType: Readonly<Record<LinkedItemRecoveryObjectType, number>>;
  recoveredTargetCount: number;
}>;

export type ValidationLinkedItemRecoveryAttemptEvidence = Readonly<{
  attemptId: string;
  selectedFileCount: number;
  acceptedFileCount: number;
  duplicateFileCount: number;
  rejectedFileCount: number;
  recoveredTargetCount: number;
  repairedRelationshipCount: number;
  outcome: 'completed' | 'partial' | 'failed';
  completedAt: string;
}>;

export type ValidationLinkedItemRecoveryEvidence = Readonly<{
  schema: 'dnaforge.benchling.linked-item-recovery-validation.v1';
  organizationBaseUrl: string;
  relationshipCount: number;
  uniqueTargetCount: number;
  folderCount: number;
  recoveredUniqueObjectCount: number;
  remainingUniqueObjectCount: number;
  repairedRelationshipCount: number;
  remainingRelationshipCount: number;
  folders: readonly ValidationLinkedItemRecoveryFolderEvidence[];
  targets: readonly ValidationLinkedItemRecoveryTargetEvidence[];
  attempts: readonly ValidationLinkedItemRecoveryAttemptEvidence[];
}>;

export type ValidationReportV1 = ValidationReportBody & {
  version: typeof BENCHLING_MIGRATION_LEGACY_REPORT_VERSION;
};

export type ValidationProviderActivityReconciliationResolution = {
  exportJobId: string;
  originalCommandRequestId: string;
  reconciliationCommandRequestId: string;
  settlementId: string;
  basis: 'durable_extension_ledger';
  accountedHistoricalExportSubmitRequests: 0 | 1;
};

export type ValidationProviderActivityOpaqueRedirectResolution = {
  exportJobId: string;
  originalCommandRequestId: string;
  successorCommandRequestId: string;
  receiptConfirmationId: string;
  basis: 'confirmed_gmail_bounded_metadata_get';
  accountedHistoricalNetworkRequests: 0;
};

export type ValidationProviderActivityReadOnlyCountUncertainty = {
  exportJobId: string;
  commandRequestId: string;
  successorCommandRequestId: string;
  receiptConfirmationId: string;
  operationKind: 'poll_export_receipts';
  requestClass: 'export_task_status';
  basis: 'bounded_single_file_task_status_read';
  minimumNetworkRequests: 0;
  maximumNetworkRequests: 1;
  minimumCacheHits: 0;
  maximumCacheHits: 2;
  maximumCacheHitsByClass: {
    export_task_status: 1;
    gmail_receipt_page: 1;
  };
};

export type NativeImportReceipt = Readonly<{
  actionId: string;
  destinationChanges?: Readonly<{ added: number; updated: number; retained: number }>;
  fileOutcomes?: Readonly<{
    preserved: readonly Readonly<{ fileName: string; reason: string }>[];
    failed: readonly Readonly<{ fileName: string; reason: string }>[];
  }>;
  history: 'new_workspace' | 'adopted_history_created' | 'existing_history';
  providerVersions: Readonly<{
    policy: LinkedItemRecoveryVersionConflictPolicy;
    affectedCount: number;
  }> | null;
  exactNativeMatches: readonly Readonly<{
    sourceObjectId: string;
    candidateEntityId: string;
    choice: 'link_existing' | 'import_separate';
  }>[];
  structuralDecisions: readonly Readonly<{
    relativePath: string;
    choice: 'rename_incoming' | 'replace_existing' | 'cancel_import';
  }>[];
  externalSources: readonly Readonly<{
    sourceId: string;
    state: 'verified_at_import' | 'verification_failed';
    checkedAt: string;
  }>[];
}>;

export type ValidationReportV2 = ValidationReportBody & {
  version: typeof BENCHLING_MIGRATION_REPORT_VERSION;
  nativeImport?: NativeImportReceipt;
  converterVersions?: Record<string, string>;
  exportJobs: ValidationSection & {
    planned: number;
    captured: number;
    failedWithSuccessfulReplacement: number;
    jobs: ValidationExportJobEvidence[];
  };
  snapshotParts: ValidationSection & {
    exportArchives: number;
    targetedReads: number;
    localExports?: number;
    supplementalLocalExports?: number;
    superseded: number;
    parts: ValidationSnapshotPartEvidence[];
  };
  formulas: ValidationSection & {
    supported: number;
    unsupported: number;
    stale: number;
    evidence: ValidationFormulaEvidence[];
  };
  nativeConversionExceptions: ValidationSection & {
    evidence: ValidationProjectionExceptionEvidence[];
  };
  collections: ValidationSection & {
    expectedMemberships: number;
    actualMemberships: number;
    selectedRootSourceIds: string[];
    evidence: ValidationCollectionEvidence[];
  };
  scopedBoundary?: ValidationSection & {
    evidence: ValidationScopedBoundaryEvidence | null;
  };
  directFolderCapture?: ValidationSection & {
    evidence: ValidationDirectFolderCaptureEvidence | null;
  };
  directFolderImportScope?: ValidationSection & {
    evidence: ValidationDirectFolderImportScopeEvidence | null;
  };
  linkedItemRecovery?: ValidationSection & {
    evidence: ValidationLinkedItemRecoveryEvidence;
  };
  folderTreeCapture?: ValidationSection & {
    evidence: ValidationFolderTreeCaptureEvidence | null;
  };
  destinationIntegrity?: ValidationDestinationIntegrityEvidence;
  providerReferences?: ValidationProviderReferenceEvidence;
  providerTasks?: ValidationSection & {
    observations: number;
    jobs: number;
    running: number;
    succeeded: number;
    failed: number;
    actionRequired: number;
    evidence: ProviderTaskEvidence[];
  };
  providerActivity?: ValidationSection & {
    issuedCommands?: number;
    unmatchedCommands?: number;
    networkRequests: number;
    cacheHits: number;
    coverageGaps: number;
    countsAreExact: boolean;
    countsAreBounded?: boolean;
    networkRequestUpperBound?: number;
    cacheHitUpperBound?: number;
    unboundedCoverageGaps?: number;
    networkRequestsByClass: Record<ProviderRequestClass, number>;
    cacheHitsByClass: Record<ProviderRequestClass, number>;
    networkRequestUpperBoundsByClass?: Record<ProviderRequestClass, number>;
    cacheHitUpperBoundsByClass?: Record<ProviderRequestClass, number>;
    evidence: ProviderActivityBundle[];
    commandJournal?: ProviderCommandJournalEntry[];
    reconciliationResolutions?: ValidationProviderActivityReconciliationResolution[];
    opaqueRedirectResolutions?: ValidationProviderActivityOpaqueRedirectResolution[];
    readOnlyCountUncertainties?: ValidationProviderActivityReadOnlyCountUncertainty[];
  };
  gmailReceiptConfirmations?: ValidationSection & {
    evidence: GmailReceiptConfirmationEvidence[];
  };
  localExport?: ValidationSection & {
    evidence: {
      schema: 'dnaforge.benchling.local-export-validation.v1';
      format: 'zip' | 'html';
      logicalFilename: string;
      sha256: `sha256:${string}`;
      sizeBytes: number;
      resourceCount: number;
      resourceBytes: number;
      networkRequests: 0;
      nativeFolderZipInventory?: LocalNativeFolderZipInventory;
    };
  };
};

export type ValidationReport = ValidationReportV1 | ValidationReportV2;

export function isValidationReportV2(report: ValidationReport): report is ValidationReportV2 {
  return report.version === BENCHLING_MIGRATION_REPORT_VERSION;
}

export type MigrationNetworkAction = {
  id: string;
  kind: 'folder_discovery' | 'export_submit' | 'gmail_poll' | 'export_download' | 'targeted_read';
  description: string;
  sourceIds: string[];
};

export type MigrationPreflightOneHopDependency = Readonly<{
  sourceObjectId: string;
  contentFamily: string;
}>;

export type MigrationPreflightOneHopDisclosure =
  | Readonly<{ status: 'not_applicable'; dependencies: readonly [] }>
  | Readonly<{ status: 'pending_capture'; dependencies: readonly [] }>
  | Readonly<{
      status: 'exact';
      dependencies: readonly MigrationPreflightOneHopDependency[];
    }>;

export type MigrationPreflight = {
  runId: string;
  binding: SourceBinding | null;
  scope: MigrationScope;
  plannedActions: MigrationNetworkAction[];
  plannedContentFamilies: string[];
  oneHopDisclosure: MigrationPreflightOneHopDisclosure;
  selectedRootIds: string[];
  includedFolderIds: string[];
  excludedDirectChildFolderIds: string[];
  requiredBytes: number | null;
  availableBytes: number;
  storageAllowed: boolean;
  issue: MigrationIssue | null;
};

export type MigrationResult = {
  run: MigrationRun;
  snapshot: SourceSnapshot;
  resolutions: RelationshipResolution[];
  receipts: ProjectionReceipt[];
  report: ValidationReport;
};
