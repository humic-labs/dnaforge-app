import { createHash } from 'node:crypto';
import { basename } from 'node:path';

import {
  BENCHLING_MIGRATION_REPORT_VERSION,
  isLocalNativeFolderZipInventory,
  migrationRunSourceIdentityHash,
  type ExportJob,
  type GmailReceiptConfirmationEvidence,
  type MigrationIssue,
  type MigrationRun,
  type NativeExportSubmissionReconciliationEvidence,
  type ProjectionReceipt,
  type ProviderActivityBundle,
  type ProviderActivityOperationKind,
  type ProviderCommandJournalEntry,
  type ProviderRequestClass,
  type ProviderTaskEvidence,
  type RelationshipResolution,
  type RelationshipResolutionClass,
  type SourceObject,
  type SourceSnapshot,
  type ValidationReportV2,
  type ValidationDirectFolderCaptureItemEvidence,
  type ValidationDirectFolderImportScopeEvidence,
  type ValidationFolderTreeCaptureItemEvidence,
  type ValidationLinkedItemRecoveryAttemptEvidence,
  type ValidationLinkedItemRecoveryEvidence,
  type ValidationProviderActivityReadOnlyCountUncertainty,
  type ValidationScopedBoundarySourceIdMode,
  type ValidationSection,
} from '../../shared/benchling-migration';
import {
  assertScopedFolderBoundary,
  mergeWorkspaceAppendFolderAuthority,
  type CollectionProjection,
  type ScopedFolderMetadata,
} from './collection-projection';
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
import { collectProjectionFormulaEvidence } from './formula-evidence';
import {
  exactRelationshipResolutionCaptureConflict,
  inferredSelectedSnapshotOrganizationBaseUrl,
} from './relationship-resolver';
import { buildLinkedItemRecoveryEvidence } from './linked-item-recovery-plan';
import { summarizeProviderReferenceOutcomes } from './provider-reference-report';
import {
  benchlingOrganizationBaseUrlFromSourceUrl,
  sourceBindingOrganizationBaseUrl,
} from './source-identity';
import {
  activeExportLeafJobIds,
  type MigrationRequestLedgerEntry,
  type PersistedExportCapture,
  type PersistedExportInspection,
  type PersistedExportJobReplacement,
  type WorkspaceAppendHierarchyCapture,
} from './store';
import type { ProjectionIntegrityEvidence } from './projection-writer';
import { isSafeWorkspaceRelativePath } from './safe-workspace-path';
export { isSafeWorkspaceRelativePath } from './safe-workspace-path';
import { directFolderAuthorityDigest, providerTaskReceiptId } from './provider-task-handle';
import { makeReplacementExportJob } from './scope-planner';
import {
  replayScopedFolderTraversalJournalSync,
  type ScopedFolderTraversalJournal,
} from './scoped-folder-traversal-journal';
import {
  createScopedBoundaryAttestation,
  scopedItemMembershipEvidence,
  type ScopedBoundaryEvidenceV1,
} from './scoped-boundary-evidence';

export type MigrationRenderCheck = {
  sourceObjectId: string;
  passed: boolean;
  message?: string;
};

export type ArchiveIntegrityEvidence = {
  manifestEntries: Array<{
    manifestId: string;
    archivePartId: string | null;
    sourceObjectId: string | null;
    entryPath: string;
    sha256: string;
    sizeBytes: number;
    containerSha256?: string;
    containerSizeBytes?: number;
    containerPartId?: string;
  }>;
  snapshotParts: Array<{
    partId: string;
    kind: SourceSnapshot['parts'][number]['kind'];
    sourceJobId: string | null;
    sourceObjectId: string | null;
    sha256: string;
    sizeBytes: number;
  }>;
};

export type GenerateValidationReportInput = {
  run: MigrationRun;
  snapshot: SourceSnapshot;
  sourceObjects: SourceObject[];
  archiveIntegrity: ArchiveIntegrityEvidence;
  archiveIntegrityFailures?: Array<{
    evidenceId: string;
    message: string;
  }>;
  exportJobs: ExportJob[];
  exportCaptures: PersistedExportCapture[];
  exportInspections: PersistedExportInspection[];
  exportJobReplacements: PersistedExportJobReplacement[];
  gmailReceiptConfirmations?: GmailReceiptConfirmationEvidence[];
  providerTaskEvidence?: ProviderTaskEvidence[];
  providerActivityEvidence?: ProviderActivityBundle[];
  providerCommandJournal?: ProviderCommandJournalEntry[];
  requestLedgerEntries?: MigrationRequestLedgerEntry[];
  nativeExportReconciliations?: NativeExportSubmissionReconciliationEvidence[];
  providerActivityRequired?: boolean;
  scopedBoundaryEvidence?: ScopedBoundaryEvidenceV1 | null;
  scopedBoundarySourceIdMode?: ValidationScopedBoundarySourceIdMode;
  directFolderCapturePlan?: DirectFolderCapturePlanV1 | null;
  directFolderTraversalJournal?: ScopedFolderTraversalJournal | null;
  folderTreeCapturePlan?: FolderTreeCapturePlanV1 | null;
  folderTreeTraversalJournal?: ScopedFolderTraversalJournal | null;
  collectionProjection: CollectionProjection | null;
  scopedFolders: ScopedFolderMetadata[];
  workspaceAppendHierarchyCaptures?: readonly WorkspaceAppendHierarchyCapture[];
  expectedRenderObjectIds: string[];
  renderChecks: MigrationRenderCheck[];
  resolutions: RelationshipResolution[];
  receipts: ProjectionReceipt[];
  projectionIntegrity?: ProjectionIntegrityEvidence;
  priorLinkedItemRecoveryEvidence?: ValidationLinkedItemRecoveryEvidence | null;
  linkedItemRecoveryAttempts?: readonly ValidationLinkedItemRecoveryAttemptEvidence[];
  nativeImportAction?: {
    actionId: string;
    destinationChanges?: import('../../shared/benchling-migration').NativeImportReceipt['destinationChanges'];
    selectedSourceObjectIds?: readonly string[];
    failedFiles?: readonly Readonly<{ fileName: string; reason: string }>[];
    history: import('../../shared/benchling-migration').NativeImportReceipt['history'];
    decisions: readonly import('../../shared/benchling-import-decision').ImportDecision[];
    providerVersionConflictCount: number;
    externalSourceIds: readonly string[];
  };
  uninstalledSupplementalSourceIds?: ReadonlySet<string>;
  materializedSourceIds?: ReadonlySet<string>;
  nativeMembershipAuthority?: readonly {
    sourceObjectId: string;
    folderSourceIds: readonly string[];
  }[];
  generatedAt?: string;
};

const SHA256_HEX = /^[0-9a-f]{64}$/i;
const SHA256_EVIDENCE = /^(?:sha256:)?[0-9a-f]{64}$/i;

const RESOLUTION_CLASSES: RelationshipResolutionClass[] = [
  'exact',
  'heuristic',
  'ambiguous',
  'unresolved',
  'external',
  'source_broken',
];

const PROVIDER_TASK_ACTION_CODES = new Set([
  'provider_task_identity_invalid',
  'provider_task_failed',
  'provider_task_download_url_not_allowlisted',
  'provider_task_unavailable',
  'provider_task_session_locator_unavailable',
  'provider_task_status_not_dispatched',
  'provider_task_status_invalid_json',
  'provider_task_status_invalid_response',
  'provider_task_status_undocumented',
]);

const PROVIDER_REQUEST_CLASSES: ProviderRequestClass[] = [
  'export_submit',
  'export_task_status',
  'gmail_receipt_page',
  'export_archive_metadata',
  'export_archive_range',
  'export_archive_download',
  'folder_scope_discovery',
  'targeted_read',
];

const PROVIDER_ACTIVITY_OPERATION_KINDS = new Set([
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
const NETWORK_BACKED_PROVIDER_ACTIVITY_OPERATION_KINDS = new Set([
  'submit_export',
  'reconcile_export_submission',
  'poll_export_receipts',
  'recover_export_receipt',
  'inspect_export',
  'inspect_export_range',
  'discover_scoped_folder_page',
  'download_export',
  'targeted_read',
]);

const PROVIDER_ACTIVITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const PROVIDER_ACTIVITY_SURFACES = new Set([
  'benchling_tenant',
  'benchling_temp_storage',
  'gmail_web',
]);
const PROVIDER_ACTIVITY_METHODS = new Set(['GET', 'HEAD', 'POST', 'READ']);
const PROVIDER_ACTIVITY_STATUS_CLASSES = new Set(['2xx', '3xx', '4xx', '5xx']);
const PROVIDER_ACTIVITY_CACHE_LAYERS = new Set([
  'extension_memory',
  'extension_session',
  'main_process_memory',
  'browser_page',
]);
const MAX_PROVIDER_ACTIVITY_OBSERVATIONS = 16;
const MAX_PROTECTED_EXPORT_REDIRECTS = 3;
const MAX_HISTORICAL_METADATA_HEAD_GAPS = 1;
const MAX_HISTORICAL_METADATA_GET_GAPS = 3;
const MAX_BOUNDED_FILE_TASK_POLL_GAPS = 3;
const GMAIL_RECEIPT_FILTER_SUMMARY_SCHEMA = 'dnaforge.benchling.gmail-receipt-filter-summary.v1';
const MAX_GMAIL_RECEIPT_FILTER_COUNT = 32;
const GMAIL_RECEIPT_FILTER_STAGES = ['sender', 'date', 'family', 'time', 'excluded'] as const;

const PROVIDER_ACTIVITY_CLASSES_BY_OPERATION: Record<
  ProviderActivityOperationKind,
  ReadonlySet<ProviderRequestClass>
> = {
  submit_export: new Set(['export_submit']),
  reconcile_export_submission: new Set(['export_submit']),
  poll_export_receipts: new Set(['export_task_status', 'gmail_receipt_page']),
  recover_export_receipt: new Set(['gmail_receipt_page']),
  inspect_export: new Set(['export_task_status', 'export_archive_metadata']),
  inspect_export_range: new Set(['export_task_status', 'export_archive_range']),
  discover_failed_export_split: new Set(),
  discover_scoped_folder_page: new Set(['folder_scope_discovery']),
  download_export: new Set(['export_task_status', 'export_archive_download']),
  targeted_read: new Set(['targeted_read']),
};

const PROVIDER_ACTIVITY_REQUEST_SHAPES: Record<ProviderRequestClass, ReadonlySet<string>> = {
  export_submit: new Set(['benchling_tenant:POST']),
  export_task_status: new Set(['benchling_tenant:GET']),
  gmail_receipt_page: new Set(['gmail_web:READ']),
  export_archive_metadata: new Set([
    'benchling_tenant:HEAD',
    'benchling_tenant:GET',
    'benchling_temp_storage:HEAD',
    'benchling_temp_storage:GET',
  ]),
  export_archive_range: new Set(['benchling_tenant:GET', 'benchling_temp_storage:GET']),
  export_archive_download: new Set(['benchling_tenant:GET', 'benchling_temp_storage:GET']),
  folder_scope_discovery: new Set(['benchling_tenant:POST']),
  targeted_read: new Set(['benchling_tenant:GET']),
};

export function generateValidationReport(input: GenerateValidationReportInput): ValidationReportV2 {
  const localBundle = isLocalBundleRun(input.run);
  const sourceObjects = [...input.sourceObjects].sort(compareSourceObjects);
  const stableIdentityById = new Map(
    sourceObjects.map((sourceObject) => [sourceObject.id, sourceObject.stableId])
  );
  const sourceObjectIds = new Set(sourceObjects.map((sourceObject) => sourceObject.id));
  const receipts = [...input.receipts].sort((left, right) =>
    compareBySourceIdentity(left, right, stableIdentityById, 'id')
  );
  const resolutions = [...input.resolutions].sort((left, right) =>
    compareBySourceIdentity(left, right, stableIdentityById, 'relationshipId')
  );
  const linkedItemRecoveryEvidence = buildLinkedItemRecoveryEvidence({
    run: input.run,
    sourceObjects,
    resolutions,
    priorEvidence: input.priorLinkedItemRecoveryEvidence,
    attempts: input.linkedItemRecoveryAttempts,
  });
  const benchlingOrigin =
    linkedItemRecoveryEvidence?.organizationBaseUrl ??
    immutableRelationshipBenchlingOrigin(input.run) ??
    (localBundle
      ? inferredSelectedSnapshotOrganizationBaseUrl(
          sourceObjects.flatMap((source) => source.relationships)
        )
      : undefined);
  const renderChecks = [...input.renderChecks].sort((left, right) =>
    compareBySourceIdentity(left, right, stableIdentityById, 'message')
  );

  const globalIssues: MigrationIssue[] = [];
  validateRunAndSnapshot(input.run, input.snapshot, globalIssues);
  for (const failure of input.archiveIntegrityFailures ?? []) {
    globalIssues.push({
      code: 'hash_mismatch',
      message: failure.message,
      blocking: true,
      details: { evidenceId: failure.evidenceId },
    });
  }

  const sourceObjectIssues = validateUniqueSourceObjects(sourceObjects);
  const projectionIssues = validateProjections(input.run, sourceObjects, sourceObjectIds, receipts);
  const selectedFileIdentity = validateSelectedFileExportIdentity(input, sourceObjects, receipts);
  sourceObjectIssues.push(...selectedFileIdentity.captureIssues);
  projectionIssues.push(...selectedFileIdentity.projectionIssues);
  const htmlOnlyNotebooks = validateHtmlOnlyNotebookSources(sourceObjects, receipts);
  sourceObjectIssues.push(...htmlOnlyNotebooks.captureIssues);
  projectionIssues.push(...htmlOnlyNotebooks.projectionIssues);

  const attachmentReferences = new Set(
    sourceObjects.flatMap((sourceObject) =>
      sourceObject.attachmentHashes.map(
        (hash) => `${sourceObject.id}\0${canonicalSha256Hex(hash) ?? `invalid:${hash}`}`
      )
    )
  );
  const attachmentActual = attachmentReferences.size;
  const supplementalLocalObjectIds = new Set(
    input.snapshot.parts
      .filter((part) => part.kind === 'supplemental_local_export' && part.sourceObjectId !== null)
      .map((part) => part.sourceObjectId as string)
  );
  const initialSourceObjectIds = new Set(input.snapshot.initialSourceObjectIds);
  const uninstalledSupplementalIds = input.uninstalledSupplementalSourceIds ?? new Set<string>();
  if (
    uninstalledSupplementalIds.size > 0 &&
    (!localBundle ||
      [...uninstalledSupplementalIds].some(
        (id) =>
          initialSourceObjectIds.has(id) ||
          !supplementalLocalObjectIds.has(id) ||
          sourceObjectIds.has(id) ||
          receipts.some((receipt) => receipt.sourceObjectId === id)
      ))
  )
    throw new Error('Uninstalled supplemental source identity is invalid.');
  if (
    (input.materializedSourceIds?.size || input.nativeMembershipAuthority !== undefined) &&
    (!localBundle || input.run.state !== 'unlocked' || !input.nativeImportAction)
  )
    throw new Error('Current memberships require a completed local import action.');
  const currentInitialCount = input.snapshot.expectedSourceObjectCount;
  const supplementalNewObjectIds = new Set(
    [...supplementalLocalObjectIds].filter(
      (sourceObjectId) =>
        !initialSourceObjectIds.has(sourceObjectId) &&
        !uninstalledSupplementalIds.has(sourceObjectId)
    )
  );
  const supplementalAttachmentCount = new Set(
    sourceObjects
      .filter((sourceObject) => supplementalNewObjectIds.has(sourceObject.id))
      .flatMap((sourceObject) =>
        sourceObject.attachmentHashes.map(
          (hash) => `${sourceObject.id}\0${canonicalSha256Hex(hash) ?? `invalid:${hash}`}`
        )
      )
  ).size;
  const expectedAttachmentCount =
    input.snapshot.expectedAttachmentCount + supplementalAttachmentCount;
  const attachmentIssues = countIssues('attachments', expectedAttachmentCount, attachmentActual);
  const captureOwnership = validateExportCaptureOwnership(
    input.exportCaptures,
    input.exportJobReplacements,
    sourceObjects
  );
  attachmentIssues.push(...captureOwnership.attachmentIssues);
  const archivedBlobHashes = new Set(
    input.archiveIntegrity.manifestEntries
      .map((entry) => canonicalSha256Hex(entry.sha256))
      .filter((hash): hash is string => hash !== null)
  );
  for (const sourceObject of sourceObjects) {
    for (const attachmentHash of sourceObject.attachmentHashes) {
      const normalizedAttachmentHash = canonicalSha256Hex(attachmentHash);
      if (!normalizedAttachmentHash || !archivedBlobHashes.has(normalizedAttachmentHash)) {
        attachmentIssues.push({
          code: 'hash_mismatch',
          message: `Attachment ${attachmentHash} on ${sourceObject.stableId} is absent from the immutable archive.`,
          blocking: true,
          sourceObjectId: sourceObject.id,
          details: { attachmentHash },
        });
      }
    }
  }

  const membershipActual = new Set(
    sourceObjects.flatMap((sourceObject) =>
      sourceObject.memberships.map((membership) => `${sourceObject.id}\0${membership}`)
    )
  );
  const supplementalMembershipCount = new Set(
    sourceObjects
      .filter((sourceObject) => supplementalNewObjectIds.has(sourceObject.id))
      .flatMap((sourceObject) =>
        sourceObject.memberships.map((membership) => `${sourceObject.id}\0${membership}`)
      )
  ).size;
  const expectedMembershipCount = input.nativeMembershipAuthority
    ? new Set(
        input.nativeMembershipAuthority.flatMap((source) =>
          source.folderSourceIds.map((folder) => `${source.sourceObjectId}\0${folder}`)
        )
      ).size
    : (input.workspaceAppendHierarchyCaptures?.length ?? 0) > 0
      ? membershipActual.size
      : input.snapshot.expectedMembershipCount + supplementalMembershipCount;
  const membershipIssues = countIssues(
    'memberships',
    expectedMembershipCount,
    membershipActual.size
  );
  if (input.nativeMembershipAuthority) {
    const expectedSources = new Set(
      input.nativeMembershipAuthority.map((source) => source.sourceObjectId)
    );
    const expectedPairs = new Set(
      input.nativeMembershipAuthority.flatMap((source) =>
        source.folderSourceIds.map((folder) => `${source.sourceObjectId}\0${folder}`)
      )
    );
    if (
      expectedSources.size !== input.nativeMembershipAuthority.length ||
      expectedSources.size !== sourceObjectIds.size ||
      [...sourceObjectIds].some((id) => !expectedSources.has(id)) ||
      [...membershipActual].some((pair) => !expectedPairs.has(pair)) ||
      [...expectedPairs].some((pair) => !membershipActual.has(pair))
    )
      throw new Error('Current native memberships do not match the action authority.');
  }
  membershipIssues.push(...captureOwnership.membershipIssues);

  const targetedReadObjectIds = new Set(
    input.snapshot.parts
      .filter((part) => part.kind === 'targeted_read' && part.sourceObjectId !== null)
      .map((part) => part.sourceObjectId)
  );
  const additiveOneHopObjectIds = new Set([...targetedReadObjectIds, ...supplementalNewObjectIds]);
  const selectedFileSourceId = input.run.scope.kind === 'file' ? input.run.scope.source.id : null;
  const selectedFileSourceObjectIds = new Set(
    localBundle
      ? sourceObjects.map((sourceObject) => sourceObject.id)
      : selectedFileSourceId
        ? sourceObjects
            .filter(
              (sourceObject) =>
                sourceObject.id === selectedFileSourceId ||
                sourceObject.stableId === selectedFileSourceId
            )
            .map((sourceObject) => sourceObject.id)
        : []
  );
  const relationshipValidatedSourceObjects = sourceObjects.filter((sourceObject) =>
    input.run.scope.kind === 'file'
      ? selectedFileSourceObjectIds.has(sourceObject.id) &&
        !supplementalNewObjectIds.has(sourceObject.id)
      : !additiveOneHopObjectIds.has(sourceObject.id)
  );
  const relationshipValidatedSourceObjectIds = new Set(
    relationshipValidatedSourceObjects.map((sourceObject) => sourceObject.id)
  );
  const relationshipValidation = validateRelationships(
    relationshipValidatedSourceObjects,
    resolutions.filter((resolution) =>
      relationshipValidatedSourceObjectIds.has(resolution.sourceObjectId)
    ),
    {
      targetSourceObjects: sourceObjects,
      allowUnresolvedPlaceholders: localBundle,
      benchlingOrigin,
      selectedSnapshotStableIdsAreAuthoritative: localBundle,
    }
  );
  const hashValidation = validateHashes(
    input.snapshot,
    sourceObjects,
    receipts,
    input.archiveIntegrity,
    input.projectionIntegrity
  );
  const renderValidation = validateRendering(
    renderChecks,
    sourceObjectIds,
    input.expectedRenderObjectIds
  );

  const capturedSourceObjectIds = new Set(
    input.exportCaptures.flatMap((capture) => capture.sourceObjectIds)
  );
  const targetedReadSourceObjectIds = new Set(
    input.snapshot.parts
      .filter((part) => part.kind === 'targeted_read' && part.sourceObjectId !== null)
      .map((part) => part.sourceObjectId as string)
  );
  const capturedScopeSourceObjectIds = localBundle
    ? new Set(
        sourceObjects
          .filter((sourceObject) => initialSourceObjectIds.has(sourceObject.id))
          .map((sourceObject) => sourceObject.id)
      )
    : new Set([
        ...capturedSourceObjectIds,
        ...[...targetedReadSourceObjectIds].filter((sourceObjectId) =>
          selectedFileSourceObjectIds.has(sourceObjectId)
        ),
      ]);
  if (currentInitialCount !== capturedScopeSourceObjectIds.size) {
    sourceObjectIssues.push({
      code: 'validation_failed',
      message: `Snapshot expected ${currentInitialCount} current scoped source objects, but durable captures enumerate ${capturedScopeSourceObjectIds.size}.`,
      blocking: true,
      details: {
        snapshotExpected: currentInitialCount,
        capturedExpected: capturedScopeSourceObjectIds.size,
      },
    });
  }
  const expectedSourceObjectCount = localBundle
    ? currentInitialCount + supplementalNewObjectIds.size
    : new Set([...capturedSourceObjectIds, ...targetedReadSourceObjectIds]).size;
  sourceObjectIssues.push(
    ...countIssues('source objects', expectedSourceObjectCount, sourceObjects.length)
  );
  const sourceObjectsSection = section(
    expectedSourceObjectCount,
    sourceObjects.length,
    sortIssues(sourceObjectIssues, stableIdentityById)
  );
  const attachmentsSection = section(
    expectedAttachmentCount,
    attachmentActual,
    sortIssues(attachmentIssues, stableIdentityById)
  );
  const membershipsSection = section(
    expectedMembershipCount,
    membershipActual.size,
    sortIssues(membershipIssues, stableIdentityById)
  );
  const relationshipsSection = {
    ...section(
      relationshipValidation.expected,
      relationshipValidation.actual,
      sortIssues(relationshipValidation.issues, stableIdentityById)
    ),
    countsByClass: relationshipValidation.countsByClass,
  };
  const projectionsSection = {
    ...section(
      sourceObjects.length,
      receipts.length,
      sortIssues(projectionIssues, stableIdentityById)
    ),
    native: receipts.filter((receipt) => receipt.projection === 'native').length,
    nativeRepresentations: {
      dnaSequence: receipts.filter((receipt) => receipt.nativeRepresentation === 'dna_sequence')
        .length,
      strain: receipts.filter((receipt) => receipt.nativeRepresentation === 'strain').length,
      needsSequence: receipts.filter(
        (receipt) => receipt.nativeRepresentation === 'dna_sequence_needs_sequence'
      ).length,
    },
    portableFile: receipts.filter((receipt) => receipt.projection === 'portable_file').length,
    adapterStaging: input.collectionProjection?.collections.length ?? 0,
    fallback: receipts.filter(
      (receipt) => receipt.projection === 'fallback' || receipt.projection === 'artifact'
    ).length,
    artifact: receipts.filter(
      (receipt) => receipt.projection === 'artifact' || receipt.projection === 'fallback'
    ).length,
    exceptions: receipts.filter((receipt) => receipt.exception !== null).length,
  };
  const hashesSection = section(
    hashValidation.expectedCount,
    hashValidation.validCount,
    sortIssues(hashValidation.issues, stableIdentityById)
  );
  const renderingSection = section(
    new Set(input.expectedRenderObjectIds).size,
    renderValidation.passedCount,
    sortIssues(renderValidation.issues, stableIdentityById)
  );

  const exportJobsSection = validateExportJobs(input);
  const gmailReceiptConfirmationsSection = validateGmailReceiptConfirmations(input);
  const providerTasksSection = validateProviderTasks(input);
  const providerActivitySection = validateProviderActivity(input);
  const snapshotPartsSection = validateSnapshotParts(input);
  const formulaSection = validateFormulas(sourceObjects, receipts);
  const exceptionSection = validateNativeConversionExceptions(receipts);
  const collectionSection = validateCollections(
    input.run,
    sourceObjects,
    receipts,
    input.scopedFolders,
    input.collectionProjection,
    input.resolutions,
    benchlingOrigin,
    input.workspaceAppendHierarchyCaptures ?? [],
    input.materializedSourceIds ?? new Set()
  );
  const directFolderImportScopeSection = validateDirectFolderImportScope({
    run: input.run,
    sourceObjects,
    receipts,
    resolutions,
    collectionProjection: input.collectionProjection,
    benchlingOrigin,
    workspaceAppendHierarchyCaptures: input.workspaceAppendHierarchyCaptures ?? [],
  });
  const scopedBoundarySection = validateScopedBoundary(input);
  const directFolderCaptureSection = validateDirectFolderCaptureAttestation(input);
  const folderTreeCaptureSection = validateFolderTreeCaptureAttestation(input);
  const localExportSection = validateLocalExport(input);
  const linkedItemRecoverySection = linkedItemRecoveryEvidence
    ? {
        ...section(
          linkedItemRecoveryEvidence.relationshipCount,
          linkedItemRecoveryEvidence.targets.reduce(
            (total, target) => total + target.relationshipCount,
            0
          ),
          []
        ),
        evidence: linkedItemRecoveryEvidence,
      }
    : null;

  const issues = sortIssues(
    [
      ...globalIssues,
      ...sourceObjectsSection.issues,
      ...attachmentsSection.issues,
      ...membershipsSection.issues,
      ...relationshipsSection.issues,
      ...projectionsSection.issues,
      ...hashesSection.issues,
      ...renderingSection.issues,
      ...exportJobsSection.issues,
      ...gmailReceiptConfirmationsSection.issues,
      ...providerTasksSection.issues,
      ...providerActivitySection.issues,
      ...snapshotPartsSection.issues,
      ...formulaSection.issues,
      ...exceptionSection.issues,
      ...collectionSection.issues,
      ...(directFolderImportScopeSection?.issues ?? []),
      ...scopedBoundarySection.issues,
      ...(directFolderCaptureSection?.issues ?? []),
      ...(folderTreeCaptureSection?.issues ?? []),
      ...(localExportSection?.issues ?? []),
    ],
    stableIdentityById
  );

  return {
    version: BENCHLING_MIGRATION_REPORT_VERSION,
    ...(input.nativeImportAction ? { nativeImport: nativeImportReceipt(input) } : {}),
    converterVersions: { ...input.run.converterVersions },
    runId: input.run.id,
    scope: input.run.scope,
    snapshotId: input.snapshot.id,
    accountHash: input.snapshot.accountHash,
    generatedAt: input.generatedAt ?? input.run.updatedAt,
    passed: !issues.some((issue) => issue.blocking),
    sourceObjects: sourceObjectsSection,
    attachments: attachmentsSection,
    memberships: membershipsSection,
    relationships: relationshipsSection,
    projections: projectionsSection,
    hashes: hashesSection,
    rendering: renderingSection,
    exportJobs: exportJobsSection,
    gmailReceiptConfirmations: gmailReceiptConfirmationsSection,
    providerTasks: providerTasksSection,
    providerActivity: providerActivitySection,
    snapshotParts: snapshotPartsSection,
    formulas: formulaSection,
    nativeConversionExceptions: exceptionSection,
    collections: collectionSection,
    ...(directFolderImportScopeSection
      ? { directFolderImportScope: directFolderImportScopeSection }
      : {}),
    scopedBoundary: scopedBoundarySection,
    ...(directFolderCaptureSection ? { directFolderCapture: directFolderCaptureSection } : {}),
    ...(folderTreeCaptureSection ? { folderTreeCapture: folderTreeCaptureSection } : {}),
    ...(localExportSection ? { localExport: localExportSection } : {}),
    ...(linkedItemRecoverySection ? { linkedItemRecovery: linkedItemRecoverySection } : {}),
    providerReferences: summarizeProviderReferenceOutcomes({ sourceObjects, resolutions }),
    ...(input.projectionIntegrity?.destinationIntegrity
      ? { destinationIntegrity: input.projectionIntegrity.destinationIntegrity }
      : {}),
    issues,
  };
}

function nativeImportReceipt(
  input: GenerateValidationReportInput
): import('../../shared/benchling-migration').NativeImportReceipt {
  const action = input.nativeImportAction;
  if (!action) throw new Error('Native import receipt requires a durable action.');
  const versionChoice = action.decisions.find(
    (decision) => decision.kind === 'provider_version_conflict'
  );
  const selectedIds = new Set(
    action.selectedSourceObjectIds ?? input.sourceObjects.map((sourceObject) => sourceObject.id)
  );
  const selectedSources = new Map(
    input.sourceObjects
      .filter((sourceObject) => selectedIds.has(sourceObject.id))
      .map((sourceObject) => [sourceObject.id, sourceObject] as const)
  );
  const preserved = input.receipts
    .filter(
      (receipt) =>
        selectedIds.has(receipt.sourceObjectId) &&
        (receipt.projection === 'fallback' || receipt.projection === 'artifact')
    )
    .flatMap((receipt) => {
      const source = selectedSources.get(receipt.sourceObjectId);
      if (!source) return [];
      const fileName = basename((source.sourcePath ?? source.name).replaceAll('\\', '/'));
      return [{ fileName, reason: 'Could not become an editable record.' }];
    });
  return {
    actionId: action.actionId,
    ...(action.destinationChanges ? { destinationChanges: action.destinationChanges } : {}),
    fileOutcomes: {
      preserved,
      failed: action.failedFiles ?? [],
    },
    history: action.history,
    providerVersions: versionChoice
      ? { policy: versionChoice.policy, affectedCount: action.providerVersionConflictCount }
      : null,
    exactNativeMatches: action.decisions.flatMap((decision) =>
      decision.kind === 'unbound_exact_match'
        ? [
            {
              sourceObjectId: decision.sourceObjectId,
              candidateEntityId: decision.candidateEntityId,
              choice: decision.policy,
            },
          ]
        : []
    ),
    structuralDecisions: action.decisions.flatMap((decision) =>
      decision.kind === 'structural_path_conflict'
        ? [{ relativePath: decision.relativePath, choice: decision.policy }]
        : []
    ),
    externalSources: [...new Set(action.externalSourceIds)].sort().map((sourceId) => ({
      sourceId,
      state:
        (input.archiveIntegrityFailures?.length ?? 0) === 0
          ? 'verified_at_import'
          : 'verification_failed',
      checkedAt: input.generatedAt ?? input.run.updatedAt,
    })),
  };
}

function canonicalSha256Hex(value: string): string | null {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^sha256:/u, '');
  return /^[a-f0-9]{64}$/u.test(normalized) ? normalized : null;
}

function validateRunAndSnapshot(
  run: MigrationRun,
  snapshot: SourceSnapshot,
  issues: MigrationIssue[]
): void {
  if (snapshot.runId !== run.id) {
    issues.push({
      code: 'internal_invariant',
      message: `Snapshot ${snapshot.id} belongs to run ${snapshot.runId}, not ${run.id}.`,
      blocking: true,
      details: { snapshotId: snapshot.id, snapshotRunId: snapshot.runId, runId: run.id },
    });
  }

  const localBundle = isLocalBundleRun(run);
  const sourceIdentityHash = migrationRunSourceIdentityHash(run);
  if (run.binding === null && !localBundle) {
    issues.push({
      code: 'identity_unverified',
      message: 'The migration run has no confirmed Benchling source binding.',
      blocking: true,
    });
    return;
  }
  if (localBundle && run.binding !== null) {
    issues.push({
      code: 'identity_mismatch',
      message: 'A provider-free local export cannot carry a Benchling account binding.',
      blocking: true,
    });
  }
  if (!sourceIdentityHash) {
    if (
      run.baseline?.kind === 'adopted_workspace' &&
      run.workspaceOrigin?.kind === 'adopted_existing' &&
      localBundle &&
      run.binding === null &&
      snapshot.initialSourceObjectIds.length === 0 &&
      snapshot.parts.length > 0 &&
      snapshot.parts.every((part) => part.kind === 'supplemental_local_export') &&
      snapshot.parts.some((part) => `sha256:${part.sha256}` === snapshot.accountHash)
    ) {
      return;
    }
    issues.push({
      code: 'identity_unverified',
      message: localBundle
        ? 'The local export run has no verified immutable artifact identity.'
        : 'The migration run has no immutable source identity.',
      blocking: true,
    });
    return;
  }
  if (snapshot.accountHash !== sourceIdentityHash) {
    issues.push({
      code: 'identity_mismatch',
      message: 'The source snapshot does not match the immutable migration source identity.',
      blocking: true,
      details: {
        expectedAccountHash: sourceIdentityHash,
        snapshotAccountHash: snapshot.accountHash,
      },
    });
  }
}

function isLocalBundleRun(run: MigrationRun): boolean {
  return run.scope.acquisition === 'local_bundle';
}

function immutableRelationshipBenchlingOrigin(run: MigrationRun): string | undefined {
  if (run.binding) {
    try {
      return sourceBindingOrganizationBaseUrl(run.binding);
    } catch {
      return undefined;
    }
  }

  const refs =
    run.scope.kind === 'file'
      ? [run.scope.source]
      : run.scope.kind === 'folder'
        ? [run.scope.folder]
        : run.scope.roots;
  const organizationBaseUrls = new Set<string>();
  for (const ref of refs) {
    try {
      organizationBaseUrls.add(benchlingOrganizationBaseUrlFromSourceUrl(ref.url));
    } catch {
      return undefined;
    }
  }
  return organizationBaseUrls.size === 1 ? [...organizationBaseUrls][0] : undefined;
}

function validateUniqueSourceObjects(sourceObjects: SourceObject[]): MigrationIssue[] {
  const issues: MigrationIssue[] = [];
  const idCounts = countValues(sourceObjects.map((sourceObject) => sourceObject.id));
  const stableIdCounts = countValues(sourceObjects.map((sourceObject) => sourceObject.stableId));

  for (const sourceObject of sourceObjects) {
    if (idCounts.get(sourceObject.id) !== 1) {
      issues.push({
        code: 'internal_invariant',
        message: `Source object ID ${sourceObject.id} appears more than once in the snapshot.`,
        blocking: true,
        sourceObjectId: sourceObject.id,
      });
    }
    if (stableIdCounts.get(sourceObject.stableId) !== 1) {
      issues.push({
        code: 'internal_invariant',
        message: `Stable source identity ${sourceObject.stableId} appears more than once.`,
        blocking: true,
        sourceObjectId: sourceObject.id,
      });
    }
  }

  return deduplicateIssues(issues);
}

function validateSelectedFileExportIdentity(
  input: GenerateValidationReportInput,
  sourceObjects: SourceObject[],
  receipts: ProjectionReceipt[]
): { captureIssues: MigrationIssue[]; projectionIssues: MigrationIssue[] } {
  const captureIssues: MigrationIssue[] = [];
  const projectionIssues: MigrationIssue[] = [];
  if (input.run.scope.kind !== 'file') return { captureIssues, projectionIssues };

  const hasExportEvidence =
    input.exportJobs.length > 0 ||
    input.exportCaptures.length > 0 ||
    input.snapshot.parts.some((part) => part.kind === 'export_archive');
  if (!hasExportEvidence) return { captureIssues, projectionIssues };

  const selected = input.run.scope.source;
  const selectedUrl = canonicalEvidenceUrl(selected.url);
  const mismatchedJobIds = input.exportJobs
    .filter((job) => {
      if (job.contentFamily !== 'notebook' || job.sourceRoots.length !== 1) return true;
      const root = job.sourceRoots[0];
      const rootUrl = canonicalEvidenceUrl(root.url);
      return (
        selectedUrl === null ||
        rootUrl === null ||
        root.id !== selected.id ||
        rootUrl !== selectedUrl
      );
    })
    .map((job) => job.id)
    .sort();
  if (input.exportJobs.length === 0 || mismatchedJobIds.length > 0) {
    captureIssues.push({
      code: 'identity_mismatch',
      message: `File export evidence is not bound exclusively to selected source ${selected.id}.`,
      blocking: true,
      sourceObjectId: selected.id,
      details: {
        exportJobCount: input.exportJobs.length,
        mismatchedJobIds,
      },
    });
  }

  const selectedObjects = sourceObjects.filter(
    (sourceObject) => sourceObject.id === selected.id || sourceObject.stableId === selected.id
  );
  const selectedObject = selectedObjects.length === 1 ? selectedObjects[0] : undefined;
  const selectedContent = recordValue(selectedObject?.content);
  const selectedObjectValid =
    selectedObject?.id === selected.id &&
    selectedObject.stableId === selected.id &&
    selectedObject.sourceType === 'notebook_entry' &&
    typeof selectedContent?.html === 'string' &&
    Array.isArray(selectedContent.attachments);
  if (!selectedObjectValid) {
    captureIssues.push({
      code: 'identity_mismatch',
      message: `Selected File source ${selected.id} does not exactly preserve the selected notebook identity and native HTML content.`,
      blocking: true,
      sourceObjectId: selected.id,
      details: {
        matchingSourceObjectIds: selectedObjects.map((sourceObject) => sourceObject.id).sort(),
        matchingStableIds: selectedObjects.map((sourceObject) => sourceObject.stableId).sort(),
        matchingSourceTypes: selectedObjects.map((sourceObject) => sourceObject.sourceType).sort(),
      },
    });
  }

  const effectiveCapturedJobs = input.exportJobs.filter((job) => job.state === 'captured');
  const captureByJobId = new Map(
    input.exportCaptures.map((capture) => [capture.jobId, capture] as const)
  );
  const capturesMissingSelectedIdentity = effectiveCapturedJobs
    .filter((job) => !captureByJobId.get(job.id)?.sourceObjectIds.includes(selected.id))
    .map((job) => job.id)
    .sort();
  if (effectiveCapturedJobs.length === 0 || capturesMissingSelectedIdentity.length > 0) {
    captureIssues.push({
      code: 'identity_mismatch',
      message: `Every effective File export capture must contain selected source ${selected.id}.`,
      blocking: true,
      sourceObjectId: selected.id,
      details: {
        effectiveCaptureCount: effectiveCapturedJobs.length,
        capturesMissingSelectedIdentity,
      },
    });
  }

  const nativeExport = selectedObject ? recordValue(selectedObject.metadata.nativeExport) : null;
  const provenance = nativeExport ? recordValue(nativeExport.selectedFileRootEvidence) : null;
  const provenanceJobId = typeof provenance?.jobId === 'string' ? provenance.jobId : null;
  const provenanceJob = provenanceJobId
    ? effectiveCapturedJobs.find((job) => job.id === provenanceJobId)
    : undefined;
  const provenanceRoot = provenanceJob?.sourceRoots[0];
  const allowedEvidence = new Set(['archive_identity', 'provider_single_entry_primary_mapping']);
  const provenanceEvidence = typeof provenance?.evidence === 'string' ? provenance.evidence : null;
  const provenanceReceiptSource = provenance?.receiptSource ?? null;
  const jobReceiptSource = provenanceJob?.receiptSource ?? null;
  const exactConfirmedGmailAuthority =
    provenanceJob !== undefined &&
    jobReceiptSource === 'gmail' &&
    provenanceReceiptSource === 'gmail' &&
    hasExactlyOneExactGmailReceiptConfirmation(input, provenanceJob);
  const providerMappingAuthorityValid =
    provenanceEvidence !== 'provider_single_entry_primary_mapping' ||
    (jobReceiptSource === 'provider_task' && provenanceReceiptSource === 'provider_task') ||
    exactConfirmedGmailAuthority;
  const provenanceValid =
    nativeExport?.identityMethod === 'selected_file_export_root' &&
    provenance?.version === 1 &&
    provenance?.sourceId === selected.id &&
    canonicalEvidenceUrl(String(provenance?.sourceUrl ?? '')) === selectedUrl &&
    typeof provenance?.matchSignature === 'string' &&
    provenance?.matchSignature === provenanceJob?.matchSignature &&
    provenance?.objectType === 'notebook_entry' &&
    provenanceEvidence !== null &&
    allowedEvidence.has(provenanceEvidence) &&
    providerMappingAuthorityValid &&
    provenanceRoot?.id === selected.id &&
    canonicalEvidenceUrl(provenanceRoot?.url ?? '') === selectedUrl &&
    captureByJobId.get(provenanceJobId ?? '')?.sourceObjectIds.includes(selected.id) === true &&
    canonicalEvidenceUrl(selectedObject?.sourceUrl ?? '') === selectedUrl;
  if (!provenanceValid) {
    captureIssues.push({
      code: 'identity_mismatch',
      message: `Selected File source ${selected.id} lacks export-root provenance correlated to an effective capture.`,
      blocking: true,
      sourceObjectId: selected.id,
      details: {
        provenanceJobId,
      },
    });
  }

  const selectedReceipts = receipts.filter((receipt) => receipt.sourceObjectId === selected.id);
  if (selectedReceipts.length !== 1) {
    projectionIssues.push({
      code: 'projection_failed',
      message: `Selected File source ${selected.id} requires exactly one projection receipt, but found ${selectedReceipts.length}.`,
      blocking: true,
      sourceObjectId: selected.id,
      details: {
        receiptIds: selectedReceipts.map((receipt) => receipt.id).sort(),
      },
    });
  }

  return { captureIssues, projectionIssues };
}

function validateHtmlOnlyNotebookSources(
  sourceObjects: SourceObject[],
  receipts: ProjectionReceipt[]
): { captureIssues: MigrationIssue[]; projectionIssues: MigrationIssue[] } {
  const captureIssues: MigrationIssue[] = [];
  const projectionIssues: MigrationIssue[] = [];

  for (const sourceObject of sourceObjects) {
    const nativeExport = recordValue(sourceObject.metadata.nativeExport);
    const notebookAuthority = [
      nativeExport?.selectedFileRootEvidence,
      nativeExport?.directFolderItemEvidence,
      nativeExport?.folderTreeItemEvidence,
    ]
      .map(recordValue)
      .find((evidence) => evidence?.objectType === 'notebook_entry');
    if (!nativeExport || !notebookAuthority) continue;
    const content = recordValue(sourceObject.content);
    const isPdfBackedNotebook =
      nativeExport.primaryRepresentation === 'pdf' ||
      notebookAuthority.primaryRepresentation === 'pdf' ||
      (sourceObject.sourceType === 'unsupported_object' &&
        content?.mediaType === 'application/pdf');
    if (!isPdfBackedNotebook) continue;

    captureIssues.push({
      code: 'required_target_missing',
      message: `Notebook ${sourceObject.id} is PDF-backed; HTML is required for import.`,
      blocking: true,
      sourceObjectId: sourceObject.id,
      details: {
        reason: 'notebook_html_required',
        receivedRepresentation: 'pdf',
        preservedSourceRetained: true,
      },
    });

    const sourceReceipts = receipts.filter((receipt) => receipt.sourceObjectId === sourceObject.id);
    for (const receipt of sourceReceipts) {
      projectionIssues.push({
        code: 'projection_failed',
        message: `PDF-backed notebook ${sourceObject.id} must not have a destination projection.`,
        blocking: true,
        sourceObjectId: sourceObject.id,
        details: {
          reason: 'notebook_html_required',
          receiptId: receipt.id,
          projection: receipt.projection,
        },
      });
    }
  }

  return { captureIssues, projectionIssues };
}

function canonicalEvidenceUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validateExportCaptureOwnership(
  captures: PersistedExportCapture[],
  replacements: PersistedExportJobReplacement[],
  sourceObjects: SourceObject[]
): { attachmentIssues: MigrationIssue[]; membershipIssues: MigrationIssue[] } {
  const attachmentIssues: MigrationIssue[] = [];
  const membershipIssues: MigrationIssue[] = [];
  if (captures.length === 0) return { attachmentIssues, membershipIssues };

  const sourceObjectById = new Map(
    sourceObjects.map((sourceObject) => [sourceObject.id, sourceObject])
  );
  const capturedSourceObjectIds = new Set(captures.flatMap((capture) => capture.sourceObjectIds));
  const finalAttachmentPairs = new Set(
    sourceObjects
      .filter((sourceObject) => capturedSourceObjectIds.has(sourceObject.id))
      .flatMap((sourceObject) =>
        sourceObject.attachmentHashes.map(
          (hash) => `${sourceObject.id}\0${canonicalSha256Hex(hash) ?? `invalid:${hash}`}`
        )
      )
  );
  const finalMembershipPairs = new Set(
    sourceObjects
      .filter((sourceObject) => capturedSourceObjectIds.has(sourceObject.id))
      .flatMap((sourceObject) =>
        sourceObject.memberships.map((collectionId) => `${sourceObject.id}\0${collectionId}`)
      )
  );
  const captureAttachmentPairs = new Set<string>();
  const captureMembershipPairs = new Set<string>();
  const invalidAttachmentOwners: Array<Record<string, unknown>> = [];
  const invalidMembershipOwners: Array<Record<string, unknown>> = [];
  const invalidAttachmentHashes: Array<Record<string, unknown>> = [];
  const latestCaptureJobBySourceObjectId = new Map<string, string>();
  const activeCaptureJobIds = activeExportLeafJobIds(
    captures.map((capture) => capture.jobId),
    replacements
  );
  const orderedCaptures = [...captures].sort(compareExportCaptureChronology);
  for (const capture of orderedCaptures) {
    if (!activeCaptureJobIds.has(capture.jobId)) continue;
    for (const sourceObjectId of capture.sourceObjectIds) {
      latestCaptureJobBySourceObjectId.set(sourceObjectId, capture.jobId);
    }
  }

  for (const capture of orderedCaptures) {
    const activeLeaf = activeCaptureJobIds.has(capture.jobId);
    const declaredSourceObjectIds = new Set(capture.sourceObjectIds);
    for (const reference of capture.attachmentReferences) {
      const normalizedHash = canonicalSha256Hex(reference.sha256);
      if (latestCaptureJobBySourceObjectId.get(reference.sourceObjectId) === capture.jobId) {
        captureAttachmentPairs.add(
          `${reference.sourceObjectId}\0${normalizedHash ?? `invalid:${reference.sha256}`}`
        );
      }
      if (!normalizedHash) {
        invalidAttachmentHashes.push({
          jobId: capture.jobId,
          sourceObjectId: reference.sourceObjectId,
          sha256: reference.sha256,
        });
      }
      if (
        !declaredSourceObjectIds.has(reference.sourceObjectId) ||
        (activeLeaf && !sourceObjectById.has(reference.sourceObjectId))
      ) {
        invalidAttachmentOwners.push({
          jobId: capture.jobId,
          sourceObjectId: reference.sourceObjectId,
          declaredByCapture: declaredSourceObjectIds.has(reference.sourceObjectId),
          presentInFinalSourceObjects: sourceObjectById.has(reference.sourceObjectId),
        });
      }
    }
    for (const reference of capture.membershipReferences) {
      if (activeLeaf) {
        captureMembershipPairs.add(`${reference.sourceObjectId}\0${reference.collectionId}`);
      }
      if (
        !declaredSourceObjectIds.has(reference.sourceObjectId) ||
        (activeLeaf && !sourceObjectById.has(reference.sourceObjectId))
      ) {
        invalidMembershipOwners.push({
          jobId: capture.jobId,
          sourceObjectId: reference.sourceObjectId,
          declaredByCapture: declaredSourceObjectIds.has(reference.sourceObjectId),
          presentInFinalSourceObjects: sourceObjectById.has(reference.sourceObjectId),
        });
      }
    }
  }
  for (const references of [
    invalidAttachmentHashes,
    invalidAttachmentOwners,
    invalidMembershipOwners,
  ]) {
    references.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }

  if (invalidAttachmentHashes.length > 0) {
    attachmentIssues.push({
      code: 'hash_mismatch',
      message: 'Persisted export captures contain invalid attachment hashes.',
      blocking: true,
      details: { references: invalidAttachmentHashes },
    });
  }
  if (invalidAttachmentOwners.length > 0) {
    attachmentIssues.push({
      code: 'validation_failed',
      message: 'Persisted export captures contain invalid attachment owner identities.',
      blocking: true,
      details: { references: invalidAttachmentOwners },
    });
  }
  if (invalidMembershipOwners.length > 0) {
    membershipIssues.push({
      code: 'validation_failed',
      message: 'Persisted export captures contain invalid membership owner identities.',
      blocking: true,
      details: { references: invalidMembershipOwners },
    });
  }

  const missingAttachmentPairs = setDifference(finalAttachmentPairs, captureAttachmentPairs);
  const unexpectedAttachmentPairs = setDifference(captureAttachmentPairs, finalAttachmentPairs);
  if (missingAttachmentPairs.length > 0 || unexpectedAttachmentPairs.length > 0) {
    attachmentIssues.push({
      code: 'validation_failed',
      message:
        'Persisted export-capture attachment ownership does not exactly match final source objects.',
      blocking: true,
      details: {
        missingCapturePairs: ownershipPairDetails(missingAttachmentPairs, 'sha256'),
        unexpectedCapturePairs: ownershipPairDetails(unexpectedAttachmentPairs, 'sha256'),
      },
    });
  }

  const missingMembershipPairs = setDifference(finalMembershipPairs, captureMembershipPairs);
  const unexpectedMembershipPairs = setDifference(captureMembershipPairs, finalMembershipPairs);
  if (missingMembershipPairs.length > 0 || unexpectedMembershipPairs.length > 0) {
    membershipIssues.push({
      code: 'validation_failed',
      message:
        'Persisted export-capture membership ownership does not exactly match final source objects.',
      blocking: true,
      details: {
        missingCapturePairs: ownershipPairDetails(missingMembershipPairs, 'collectionId'),
        unexpectedCapturePairs: ownershipPairDetails(unexpectedMembershipPairs, 'collectionId'),
      },
    });
  }

  return { attachmentIssues, membershipIssues };
}

function compareExportCaptureChronology(
  left: PersistedExportCapture,
  right: PersistedExportCapture
): number {
  return (
    Date.parse(left.capturedAt) - Date.parse(right.capturedAt) ||
    left.jobId.localeCompare(right.jobId) ||
    left.snapshotId.localeCompare(right.snapshotId)
  );
}

function setDifference(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  return [...left].filter((entry) => !right.has(entry)).sort();
}

function ownershipPairDetails(
  pairs: string[],
  valueLabel: 'sha256' | 'collectionId'
): Array<Record<string, string>> {
  return pairs.map((pair) => {
    const separator = pair.indexOf('\0');
    return {
      sourceObjectId: pair.slice(0, separator),
      [valueLabel]: pair.slice(separator + 1),
    };
  });
}

function validateProjections(
  run: MigrationRun,
  sourceObjects: SourceObject[],
  sourceObjectIds: Set<string>,
  receipts: ProjectionReceipt[]
): MigrationIssue[] {
  const issues: MigrationIssue[] = [];
  const receiptsBySource = new Map<string, ProjectionReceipt[]>();
  for (const receipt of receipts) {
    const sourceReceipts = receiptsBySource.get(receipt.sourceObjectId) ?? [];
    sourceReceipts.push(receipt);
    receiptsBySource.set(receipt.sourceObjectId, sourceReceipts);

    if (receipt.runId !== run.id) {
      issues.push({
        code: 'internal_invariant',
        message: `Projection receipt ${receipt.id} belongs to run ${receipt.runId}, not ${run.id}.`,
        blocking: true,
        sourceObjectId: receipt.sourceObjectId,
        details: { receiptId: receipt.id, receiptRunId: receipt.runId, runId: run.id },
      });
    }

    if (!sourceObjectIds.has(receipt.sourceObjectId)) {
      issues.push({
        code: 'projection_failed',
        message: `Projection receipt ${receipt.id} references an object outside the captured snapshot.`,
        blocking: true,
        sourceObjectId: receipt.sourceObjectId,
        details: { receiptId: receipt.id },
      });
    }

    const physicalDestinationPath = receiptPhysicalDestinationPath(receipt);
    const destinationIsSafe =
      receipt.destination?.kind === 'catalog-record'
        ? receipt.destination.parentRelativePath === '' ||
          isSafeWorkspaceRelativePath(receipt.destination.parentRelativePath)
        : physicalDestinationPath !== null && isSafeWorkspaceRelativePath(physicalDestinationPath);
    if (!destinationIsSafe) {
      issues.push({
        code: 'projection_failed',
        message: `Projection destination for ${receipt.sourceObjectId} escapes the staging workspace.`,
        blocking: true,
        sourceObjectId: receipt.sourceObjectId,
        details: { destinationPath: physicalDestinationPath, receiptId: receipt.id },
      });
    }

    if (receipt.exception !== null) {
      issues.push({
        code: 'projection_failed',
        message: `Native conversion exception: ${receipt.exception}`,
        blocking: false,
        sourceObjectId: receipt.sourceObjectId,
        details: {
          converterId: receipt.converterId,
          projection: receipt.projection,
          receiptId: receipt.id,
        },
      });
    }
  }

  for (const sourceObject of sourceObjects) {
    const receiptCount = receiptsBySource.get(sourceObject.id)?.length ?? 0;
    if (receiptCount !== 1) {
      issues.push({
        code: 'projection_failed',
        message:
          receiptCount === 0
            ? `Source object ${sourceObject.stableId} has no projection receipt.`
            : `Source object ${sourceObject.stableId} has ${receiptCount} projection receipts; exactly one is required.`,
        blocking: true,
        sourceObjectId: sourceObject.id,
        details: { receiptCount },
      });
    }
  }

  return issues;
}

function receiptPhysicalDestinationPath(receipt: ProjectionReceipt): string | null {
  switch (receipt.destination?.kind) {
    case 'file':
      return receipt.destination.relativePath;
    case 'package':
      return receipt.destination.primaryRelativePath;
    case 'catalog-record':
      return null;
    default:
      return receipt.destinationPath;
  }
}

function validateExportJobs(
  input: GenerateValidationReportInput
): ValidationReportV2['exportJobs'] {
  const jobs = [...input.exportJobs].sort((left, right) => left.id.localeCompare(right.id));
  const jobsById = uniqueMap(jobs, (job) => job.id);
  const capturesByJob = uniqueMap(input.exportCaptures, (capture) => capture.jobId);
  const inspectionsByJob = uniqueMap(input.exportInspections, (inspection) => inspection.jobId);
  const replacementsByJob = uniqueMap(
    input.exportJobReplacements,
    (replacement) => replacement.failedJobId
  );
  const snapshotPartById = uniqueMap(input.snapshot.parts, (part) => part.id);
  const issues: MigrationIssue[] = [];
  const evidence: ValidationReportV2['exportJobs']['jobs'] = [];
  let validCount = 0;
  let capturedCount = 0;
  let replacementCount = 0;
  const selectedFileSourceId = input.run.scope.kind === 'file' ? input.run.scope.source.id : null;
  const selectedFileRead =
    selectedFileSourceId !== null &&
    input.snapshot.parts.some(
      (part) => part.kind === 'targeted_read' && part.sourceObjectId === selectedFileSourceId
    );
  if (
    jobs.length === 0 &&
    !selectedFileRead &&
    !isLocalBundleRun(input.run) &&
    !hasValidEmptyScopedFolderBoundary(input)
  ) {
    issues.push(blockingValidation('Migration validation has no persisted export jobs.'));
  }
  const receiptCounts = countValues(
    jobs.map((job) => job.receiptId).filter((receiptId): receiptId is string => receiptId !== null)
  );

  for (const job of jobs) {
    const jobIssues: MigrationIssue[] = [];
    const replacement = replacementsByJob.get(job.id) ?? null;
    const inspection = inspectionsByJob.get(job.id) ?? null;
    let outcome: ValidationReportV2['exportJobs']['jobs'][number]['outcome'] = 'incomplete';

    if (job.runId !== input.run.id) {
      jobIssues.push(
        blockingInvariant(`Export job ${job.id} belongs to another migration run.`, {
          jobId: job.id,
          jobRunId: job.runId,
        })
      );
    }

    if (job.state === 'captured') {
      capturedCount += 1;
      outcome = 'captured';
      const capture = capturesByJob.get(job.id);
      if (
        !job.receiptId ||
        !job.downloadUrlHash ||
        !SHA256_EVIDENCE.test(job.downloadUrlHash) ||
        (receiptCounts.get(job.receiptId) ?? 0) !== 1
      ) {
        jobIssues.push(
          blockingValidation(`Captured export ${job.id} is missing exact receipt evidence.`, {
            jobId: job.id,
          })
        );
      }
      if (!inspection) {
        jobIssues.push(
          blockingValidation(
            `Captured export ${job.id} is missing bounded ZIP inspection evidence.`,
            {
              jobId: job.id,
            }
          )
        );
      } else {
        if (
          inspection.runId !== input.run.id ||
          inspection.receiptId !== job.receiptId ||
          inspection.downloadUrlHash !== job.downloadUrlHash
        ) {
          jobIssues.push(
            blockingValidation(
              `Export inspection for ${job.id} does not match its protected receipt.`,
              { jobId: job.id }
            )
          );
        }
        if (
          !Number.isFinite(Date.parse(inspection.inspectedAt)) ||
          [
            inspection.compressedArchiveBytes,
            inspection.declaredUncompressedBytes,
            inspection.entryCount,
            inspection.rangeRequestCount,
            inspection.rangeBytesRead,
          ].some((value) => !Number.isSafeInteger(value) || value < 0)
        ) {
          jobIssues.push(
            blockingValidation(
              `Export inspection for ${job.id} has invalid bounded-read evidence.`,
              { jobId: job.id }
            )
          );
        }
      }
      if (!capture || capture.runId !== input.run.id) {
        jobIssues.push(
          blockingValidation(
            `Captured export ${job.id} is missing durable parsed-capture evidence.`,
            {
              jobId: job.id,
            }
          )
        );
      }
      const part = job.snapshotPartId ? snapshotPartById.get(job.snapshotPartId) : undefined;
      if (
        !part ||
        part.kind !== 'export_archive' ||
        part.sourceJobId !== job.id ||
        capture?.archiveManifestId.trim() === ''
      ) {
        jobIssues.push(
          blockingValidation(
            `Captured export ${job.id} is not bound to one durable archive part.`,
            {
              jobId: job.id,
              snapshotPartId: job.snapshotPartId,
            }
          )
        );
      }
    } else if (job.state === 'failed') {
      const successful = replacementLineageSucceeded(job.id, jobsById, replacementsByJob);
      if (replacement && successful) {
        replacementCount += 1;
        outcome = 'failed_with_successful_replacement';
      } else {
        jobIssues.push(
          blockingValidation(`Failed export ${job.id} has no fully captured replacement lineage.`, {
            jobId: job.id,
            replacementJobIds: replacement?.replacementJobIds ?? [],
          })
        );
      }
    } else {
      jobIssues.push(
        blockingValidation(`Export job ${job.id} is still ${job.state} during validation.`, {
          jobId: job.id,
          state: job.state,
        })
      );
    }

    if (!jobIssues.some((issue) => issue.blocking)) validCount += 1;
    issues.push(...jobIssues);
    evidence.push({
      jobId: job.id,
      contentFamily: job.contentFamily,
      sourceRootIds: job.sourceRoots.map((root) => root.id).sort(),
      outcome,
      receiptId: job.receiptId,
      receiptSource: job.receiptSource ?? null,
      downloadUrlHash: job.downloadUrlHash,
      receiptConfirmationId: job.receiptConfirmationId ?? null,
      inspection: inspection
        ? {
            inspectedAt: inspection.inspectedAt,
            compressedArchiveBytes: inspection.compressedArchiveBytes,
            declaredUncompressedBytes: inspection.declaredUncompressedBytes,
            entryCount: inspection.entryCount,
            rangeRequestCount: inspection.rangeRequestCount,
            rangeBytesRead: inspection.rangeBytesRead,
          }
        : null,
      snapshotPartId: job.snapshotPartId,
      replacementJobIds: replacement ? [...replacement.replacementJobIds].sort() : [],
    });
  }

  for (const capture of input.exportCaptures) {
    if (!jobsById.has(capture.jobId)) {
      issues.push(blockingInvariant(`Export capture references unknown job ${capture.jobId}.`));
    }
  }
  for (const inspection of input.exportInspections) {
    if (!jobsById.has(inspection.jobId)) {
      issues.push(
        blockingInvariant(`Export inspection references unknown job ${inspection.jobId}.`)
      );
    }
  }
  for (const replacement of input.exportJobReplacements) {
    if (!jobsById.has(replacement.failedJobId)) {
      issues.push(
        blockingInvariant(`Export replacement references unknown job ${replacement.failedJobId}.`)
      );
    }
  }

  return {
    ...section(jobs.length, validCount, deduplicateIssues(issues)),
    planned: jobs.length,
    captured: capturedCount,
    failedWithSuccessfulReplacement: replacementCount,
    jobs: evidence,
  };
}

function validateGmailReceiptConfirmations(
  input: GenerateValidationReportInput
): NonNullable<ValidationReportV2['gmailReceiptConfirmations']> {
  const confirmations = [...(input.gmailReceiptConfirmations ?? [])].sort((left, right) =>
    left.id.localeCompare(right.id)
  );
  const jobsById = new Map(input.exportJobs.map((job) => [job.id, job]));
  const confirmationCountByJob = countValues(confirmations.map((evidence) => evidence.jobId));
  const confirmationCountByReceipt = countValues(
    confirmations.map((evidence) => evidence.receiptId)
  );
  const issues: MigrationIssue[] = [];
  let validCount = 0;

  for (const evidence of confirmations) {
    const job = jobsById.get(evidence.jobId);
    const valid = Boolean(
      job &&
      isExactGmailReceiptConfirmationBinding(
        input,
        evidence,
        job,
        confirmationCountByJob,
        confirmationCountByReceipt
      )
    );
    if (valid) {
      validCount += 1;
    } else {
      issues.push(
        blockingValidation(
          `Gmail receipt confirmation ${evidence.id} is not one exact immutable job binding.`,
          { confirmationId: evidence.id, jobId: evidence.jobId, receiptId: evidence.receiptId }
        )
      );
    }
  }

  const requiredJobs = input.providerActivityRequired
    ? input.exportJobs.filter((job) => job.state === 'captured' && job.receiptSource === 'gmail')
    : [];
  for (const job of requiredJobs) {
    if ((confirmationCountByJob.get(job.id) ?? 0) !== 1 || !job.receiptConfirmationId) {
      issues.push(
        blockingValidation(
          `Live Gmail export ${job.id} has no explicit receipt confirmation evidence.`,
          { jobId: job.id, receiptId: job.receiptId }
        )
      );
    }
  }
  for (const job of input.exportJobs) {
    if (job.receiptSource !== 'gmail' && job.receiptConfirmationId) {
      issues.push(
        blockingInvariant(`Non-Gmail export ${job.id} references Gmail confirmation evidence.`, {
          jobId: job.id,
          confirmationId: job.receiptConfirmationId,
        })
      );
    }
  }

  const expected = input.providerActivityRequired ? requiredJobs.length : confirmations.length;
  return {
    ...section(expected, validCount, deduplicateIssues(issues)),
    evidence: confirmations.map((evidence) => structuredClone(evidence)),
  };
}

function isExactGmailReceiptConfirmationBinding(
  input: GenerateValidationReportInput,
  evidence: GmailReceiptConfirmationEvidence,
  job: ExportJob,
  confirmationCountByJob: ReadonlyMap<string, number>,
  confirmationCountByReceipt: ReadonlyMap<string, number>
): boolean {
  return (
    evidence.schema === 'dnaforge.benchling.gmail-receipt-confirmation.v1' &&
    evidence.basis === 'explicit_user_confirmation' &&
    evidence.runId === input.run.id &&
    evidence.jobId === job.id &&
    isCanonicalUtcTimestamp(evidence.confirmedAt) &&
    SHA256_EVIDENCE.test(evidence.downloadUrlHash) &&
    job.receiptSource === 'gmail' &&
    job.receiptConfirmationId === evidence.id &&
    job.receiptId === evidence.receiptId &&
    job.matchSignature === evidence.matchSignature &&
    job.downloadUrlHash === evidence.downloadUrlHash &&
    (confirmationCountByJob.get(evidence.jobId) ?? 0) === 1 &&
    (confirmationCountByReceipt.get(evidence.receiptId) ?? 0) === 1
  );
}

function hasExactlyOneExactGmailReceiptConfirmation(
  input: GenerateValidationReportInput,
  job: ExportJob
): boolean {
  const confirmations = [...(input.gmailReceiptConfirmations ?? [])];
  const confirmationCountByJob = countValues(confirmations.map((evidence) => evidence.jobId));
  const confirmationCountByReceipt = countValues(
    confirmations.map((evidence) => evidence.receiptId)
  );
  return (
    confirmations.filter((evidence) =>
      isExactGmailReceiptConfirmationBinding(
        input,
        evidence,
        job,
        confirmationCountByJob,
        confirmationCountByReceipt
      )
    ).length === 1
  );
}

function hasValidEmptyScopedFolderBoundary(input: GenerateValidationReportInput): boolean {
  const evidence = input.scopedBoundaryEvidence ?? null;
  if (input.run.scope.kind === 'file' || !evidence) return false;
  if (
    evidence.runId !== input.run.id ||
    evidence.sourceAccountHash !== input.run.binding?.accountHash ||
    JSON.stringify(evidence.scope) !== JSON.stringify(input.run.scope)
  ) {
    return false;
  }
  try {
    const memberships = scopedItemMembershipEvidence(evidence, true, {
      sourceIdMode: input.scopedBoundarySourceIdMode ?? 'benchling',
    });
    if (memberships.length === 0) return true;
    const plan =
      input.run.scope.kind === 'folder'
        ? validateDirectFolderCapturePlan(input.directFolderCapturePlan)
        : validateFolderTreeCapturePlan(input.folderTreeCapturePlan);
    if (!plan.startAllowed) return false;
    const explicitSkipIds = new Set(plan.blockers.map(({ sourceId }) => sourceId));
    return memberships.every(({ sourceObjectId }) => explicitSkipIds.has(sourceObjectId));
  } catch {
    return false;
  }
}

function validateProviderTasks(
  input: GenerateValidationReportInput
): NonNullable<ValidationReportV2['providerTasks']> {
  const observations = [...(input.providerTaskEvidence ?? [])].sort(
    (left, right) =>
      Date.parse(left.observedAt) - Date.parse(right.observedAt) || left.id.localeCompare(right.id)
  );
  const jobsById = new Map(input.exportJobs.map((job) => [job.id, job]));
  const evidence: ProviderTaskEvidence[] = [];
  const issues: MigrationIssue[] = [];
  const seenIds = new Set<string>();
  const taskIdsByJob = new Map<string, Set<string>>();
  const latestByJob = new Map<string, ProviderTaskEvidence>();
  let validCount = 0;

  for (const observation of observations) {
    const job = jobsById.get(observation.jobId);
    const observationIssues: MigrationIssue[] = [];
    if (seenIds.has(observation.id)) {
      observationIssues.push(
        blockingInvariant(`Provider task evidence ${observation.id} is duplicated.`, {
          evidenceId: observation.id,
        })
      );
    }
    seenIds.add(observation.id);
    if (
      !job ||
      observation.runId !== input.run.id ||
      job.runId !== observation.runId ||
      job.matchSignature !== observation.matchSignature
    ) {
      observationIssues.push(
        blockingInvariant(
          `Provider task evidence ${observation.id} does not match export job ${observation.jobId}.`,
          { evidenceId: observation.id, jobId: observation.jobId }
        )
      );
    }
    if (
      !validProviderTaskHandle(observation) ||
      !Number.isFinite(Date.parse(observation.observedAt)) ||
      !['RUNNING', 'SUCCEEDED', 'FAILED', 'ACTION_REQUIRED'].includes(observation.status) ||
      !validProviderTaskAction(observation)
    ) {
      observationIssues.push(
        blockingInvariant(`Provider task evidence ${observation.id} is malformed.`, {
          evidenceId: observation.id,
          jobId: observation.jobId,
        })
      );
    }
    if (observationIssues.length === 0) validCount += 1;
    issues.push(...observationIssues);

    const sanitized: ProviderTaskEvidence = {
      id: observation.id,
      runId: observation.runId,
      jobId: observation.jobId,
      matchSignature: observation.matchSignature,
      providerTaskHandleSha256: observation.providerTaskHandleSha256,
      status: observation.status,
      actionRequired: observation.actionRequired
        ? {
            schema: observation.actionRequired.schema,
            code: observation.actionRequired.code,
            providerStatus: observation.actionRequired.providerStatus,
            recordedAt: observation.actionRequired.recordedAt,
            ...(observation.actionRequired.diagnostic
              ? { diagnostic: observation.actionRequired.diagnostic }
              : {}),
          }
        : null,
      observedAt: observation.observedAt,
    };
    evidence.push(sanitized);
    if (job && job.matchSignature === observation.matchSignature) {
      const taskIds = taskIdsByJob.get(job.id) ?? new Set<string>();
      if (observation.providerTaskHandleSha256 !== null)
        taskIds.add(observation.providerTaskHandleSha256);
      taskIdsByJob.set(job.id, taskIds);
      const prior = latestByJob.get(job.id);
      if (!prior || compareProviderTaskEvidence(prior, observation) < 0) {
        latestByJob.set(job.id, sanitized);
      }
    }
  }

  for (const [jobId, taskIds] of taskIdsByJob) {
    if (taskIds.size > 1) {
      issues.push(
        blockingInvariant(`Export job ${jobId} has conflicting provider task identities.`, {
          jobId,
          providerTaskCount: taskIds.size,
        })
      );
    }
  }

  for (const job of input.exportJobs.filter(
    (candidate) => (candidate.receiptSource ?? null) === 'provider_task'
  )) {
    const latest = latestByJob.get(job.id);
    if (!latest) {
      issues.push(
        blockingValidation(`Provider-task export ${job.id} has no durable task evidence.`, {
          jobId: job.id,
        })
      );
      continue;
    }
    const expectedHandle = latest.providerTaskHandleSha256;
    if (
      latest.status !== 'SUCCEEDED' ||
      latest.actionRequired !== null ||
      latest.providerTaskHandleSha256 === null ||
      job.receiptId !== providerTaskReceiptId(latest.providerTaskHandleSha256) ||
      job.downloadUrlHash !== expectedHandle
    ) {
      issues.push(
        blockingValidation(
          `Provider-task export ${job.id} does not end in one successful correlated task receipt.`,
          { jobId: job.id, latestStatus: latest.status }
        )
      );
    }
  }

  for (const [jobId, latest] of latestByJob) {
    if (
      latest.status === 'FAILED' ||
      (latest.status === 'ACTION_REQUIRED' &&
        !hasExactRunningTaskGmailFallbackEvidence(input, jobsById.get(jobId), latest)) ||
      (latest.status === 'RUNNING' &&
        !hasExactRunningTaskGmailFallbackEvidence(input, jobsById.get(jobId), latest))
    ) {
      issues.push(
        blockingValidation(`Provider task for export ${jobId} is still ${latest.status}.`, {
          jobId,
          latestStatus: latest.status,
          actionRequiredCode: latest.actionRequired?.code,
        })
      );
    }
  }

  const statuses = countValues(evidence.map((entry) => entry.status));
  return {
    ...section(observations.length, validCount, deduplicateIssues(issues)),
    observations: evidence.length,
    jobs: taskIdsByJob.size,
    running: statuses.get('RUNNING') ?? 0,
    succeeded: statuses.get('SUCCEEDED') ?? 0,
    failed: statuses.get('FAILED') ?? 0,
    actionRequired: statuses.get('ACTION_REQUIRED') ?? 0,
    evidence,
  };
}

function hasExactRunningTaskGmailFallbackEvidence(
  input: GenerateValidationReportInput,
  job: ExportJob | undefined,
  latest: ProviderTaskEvidence
): boolean {
  const exactFileJob =
    input.run.scope.kind === 'file' &&
    input.exportJobs.length === 1 &&
    input.exportJobs[0]?.id === job?.id &&
    job?.directFolderAuthority === undefined &&
    job?.folderTreeAuthority === undefined &&
    job?.folderTreeReplacementLineage === undefined;
  const exactDirectFolderJob = isExactDirectFolderRunningTaskGmailFallbackJob(input, job);
  const exactSequenceRecoveryTerminal =
    exactDirectFolderJob &&
    job?.contentFamily === 'dna_rna' &&
    job.directFolderAuthority?.sourceItemType === 'sequence' &&
    job.directFolderAuthority.requestCapabilityId === 'benchling.sequence-single-file-export.v1' &&
    latest.status === 'ACTION_REQUIRED' &&
    latest.actionRequired?.code === 'provider_task_status_undocumented' &&
    latest.actionRequired.providerStatus === null &&
    latest.actionRequired.diagnostic === 'unrecognized_status';
  const exactSucceededRecoveryTerminal =
    exactDirectFolderJob &&
    job?.contentFamily === 'notebook' &&
    job.directFolderAuthority?.sourceItemType === 'entry' &&
    job.directFolderAuthority.requestCapabilityId === 'benchling.notebook-entry-html-export.v1' &&
    latest.status === 'ACTION_REQUIRED' &&
    latest.actionRequired?.code === 'provider_task_session_locator_unavailable' &&
    latest.actionRequired.providerStatus === null &&
    latest.actionRequired.diagnostic === undefined;
  const hasSucceededRecoveryCommand = (input.providerCommandJournal ?? []).some(
    (command) =>
      command.runId === input.run.id &&
      command.operationKind === 'poll_export_receipts' &&
      command.directFolderGmailRescan?.schema ===
        'dnaforge.benchling.provider-task-direct-folder-succeeded-gmail-recovery.v1' &&
      command.directFolderGmailRescan.jobId === job?.id &&
      command.directFolderGmailRescan.matchSignature === job?.matchSignature
  );
  const exactSucceededRecoveryTaskLineage =
    hasSucceededRecoveryCommand &&
    exactDirectFolderJob &&
    job?.contentFamily === 'notebook' &&
    job.directFolderAuthority?.sourceItemType === 'entry' &&
    job.directFolderAuthority.requestCapabilityId === 'benchling.notebook-entry-html-export.v1' &&
    ((latest.status === 'SUCCEEDED' && latest.actionRequired === null) ||
      exactSucceededRecoveryTerminal);
  if (
    !job ||
    input.providerActivityRequired !== true ||
    (!exactFileJob && !exactDirectFolderJob) ||
    job.state !== 'captured' ||
    job.receiptSource !== 'gmail' ||
    (!exactSequenceRecoveryTerminal &&
      !exactSucceededRecoveryTaskLineage &&
      (latest.status !== 'RUNNING' || latest.actionRequired !== null)) ||
    latest.providerTaskHandleSha256 === null
  ) {
    return false;
  }
  if (exactDirectFolderJob) {
    const targetTaskEvidence = (input.providerTaskEvidence ?? []).filter(
      (candidate) =>
        candidate.runId === input.run.id &&
        candidate.jobId === job.id &&
        candidate.matchSignature === job.matchSignature
    );
    const taskEvidenceAtFallback = (input.providerTaskEvidence ?? []).filter(
      (candidate) => candidate.runId === input.run.id && candidate.observedAt === latest.observedAt
    );
    if (
      targetTaskEvidence.length === 0 ||
      targetTaskEvidence.some(
        (candidate) =>
          (exactSequenceRecoveryTerminal
            ? candidate.status !== 'ACTION_REQUIRED' ||
              candidate.actionRequired?.code !== 'provider_task_status_undocumented' ||
              candidate.actionRequired.providerStatus !== null ||
              candidate.actionRequired.diagnostic !== 'unrecognized_status'
            : exactSucceededRecoveryTaskLineage
              ? !(
                  (candidate.status === 'SUCCEEDED' && candidate.actionRequired === null) ||
                  (candidate.status === 'ACTION_REQUIRED' &&
                    candidate.actionRequired?.code ===
                      'provider_task_session_locator_unavailable' &&
                    candidate.actionRequired.providerStatus === null &&
                    candidate.actionRequired.diagnostic === undefined)
                )
              : candidate.status !== 'RUNNING' || candidate.actionRequired !== null) ||
          candidate.providerTaskHandleSha256 !== latest.providerTaskHandleSha256
      ) ||
      (exactSucceededRecoveryTerminal &&
        targetTaskEvidence.filter(
          (candidate) =>
            candidate.actionRequired?.code === 'provider_task_session_locator_unavailable'
        ).length !== 1) ||
      taskEvidenceAtFallback.length !== 1 ||
      taskEvidenceAtFallback[0]?.id !== latest.id
    ) {
      return false;
    }
  }

  const confirmations = [...(input.gmailReceiptConfirmations ?? [])];
  const confirmationCountByJob = countValues(confirmations.map((evidence) => evidence.jobId));
  const confirmationCountByReceipt = countValues(
    confirmations.map((evidence) => evidence.receiptId)
  );
  const exactConfirmations = confirmations.filter((evidence) =>
    isExactGmailReceiptConfirmationBinding(
      input,
      evidence,
      job,
      confirmationCountByJob,
      confirmationCountByReceipt
    )
  );
  if (
    exactConfirmations.length !== 1 ||
    Date.parse(exactConfirmations[0]?.confirmedAt ?? '') < Date.parse(latest.observedAt)
  ) {
    return false;
  }
  if (exactDirectFolderJob) {
    return hasExactDirectFolderRunningTaskGmailEvidence(input, job, latest, exactConfirmations[0]!);
  }

  const activities = (input.providerActivityEvidence ?? []).filter(
    (activity) =>
      activity.runId === input.run.id &&
      activity.operationKind === 'poll_export_receipts' &&
      activity.observedAt === latest.observedAt
  );
  if (activities.length !== 1 || !isExactRunningTaskGmailFallbackActivity(activities[0])) {
    return false;
  }
  const matchingCommands = (input.providerCommandJournal ?? []).filter(
    (command) =>
      command.runId === input.run.id &&
      command.operationKind === 'poll_export_receipts' &&
      command.commandRequestId === activities[0]?.commandRequestId
  );
  return (
    matchingCommands.length === 1 &&
    Date.parse(matchingCommands[0]?.issuedAt ?? '') <= Date.parse(activities[0]?.observedAt ?? '')
  );
}

function hasExactDirectFolderRunningTaskGmailEvidence(
  input: GenerateValidationReportInput,
  job: ExportJob,
  latest: ProviderTaskEvidence,
  confirmation: GmailReceiptConfirmationEvidence
): boolean {
  const pollActivities = (input.providerActivityEvidence ?? []).filter(
    (activity) =>
      activity.runId === input.run.id && activity.operationKind === 'poll_export_receipts'
  );
  const pollCommands = (input.providerCommandJournal ?? []).filter(
    (command) => command.runId === input.run.id && command.operationKind === 'poll_export_receipts'
  );
  const exactCommandFor = (
    activity: ProviderActivityBundle
  ): ProviderCommandJournalEntry | null => {
    const matches = pollCommands.filter(
      (command) => command.commandRequestId === activity.commandRequestId
    );
    return matches.length === 1 &&
      Date.parse(matches[0]!.issuedAt) <= Date.parse(activity.observedAt)
      ? matches[0]!
      : null;
  };
  const targetTaskEvidence = (input.providerTaskEvidence ?? []).filter(
    (candidate) =>
      candidate.runId === input.run.id &&
      candidate.jobId === job.id &&
      candidate.matchSignature === job.matchSignature
  );
  const siblingTaskEvidence = (input.providerTaskEvidence ?? []).filter(
    (candidate) =>
      candidate.runId === input.run.id &&
      (candidate.jobId !== job.id || candidate.matchSignature !== job.matchSignature)
  );
  const targetTaskEvidenceTimes = new Set(
    targetTaskEvidence.map((candidate) => candidate.observedAt)
  );
  const uniquelyTargetedLegacyHits = pollActivities.filter((activity) => {
    const command = exactCommandFor(activity);
    return (
      isExactRunningTaskGmailFallbackActivity(activity) &&
      command?.directFolderGmailRescan === undefined &&
      targetTaskEvidenceTimes.has(activity.observedAt) &&
      !siblingTaskEvidence.some((candidate) => candidate.observedAt === activity.observedAt)
    );
  });
  const targetRescanCommands = pollCommands.filter(
    (command) =>
      command.directFolderGmailRescan?.runId === input.run.id &&
      command.directFolderGmailRescan.jobId === job.id &&
      command.directFolderGmailRescan.matchSignature === job.matchSignature
  );
  if (targetRescanCommands.length === 0) {
    return (
      uniquelyTargetedLegacyHits.length === 1 &&
      uniquelyTargetedLegacyHits[0]?.observedAt === latest.observedAt &&
      Date.parse(confirmation.confirmedAt) >=
        Date.parse(uniquelyTargetedLegacyHits[0]?.observedAt ?? '')
    );
  }
  if (uniquelyTargetedLegacyHits.length !== 0) return false;

  const succeededRecoveryCommands = targetRescanCommands
    .flatMap((command) => {
      const authorization = command.directFolderGmailRescan;
      return authorization?.schema ===
        'dnaforge.benchling.provider-task-direct-folder-succeeded-gmail-recovery.v1'
        ? [{ command, authorization }]
        : [];
    })
    .sort(
      (left, right) => left.authorization.recoveryOrdinal - right.authorization.recoveryOrdinal
    );
  if (succeededRecoveryCommands.length > 0) {
    if (
      targetRescanCommands.length !== succeededRecoveryCommands.length ||
      targetTaskEvidence.length < 1 ||
      targetTaskEvidence.some(
        (candidate) =>
          candidate.providerTaskHandleSha256 === null ||
          !(
            (candidate.status === 'SUCCEEDED' && candidate.actionRequired === null) ||
            (candidate.status === 'ACTION_REQUIRED' &&
              candidate.actionRequired?.code === 'provider_task_session_locator_unavailable' &&
              candidate.actionRequired.providerStatus === null &&
              candidate.actionRequired.diagnostic === undefined)
          )
      ) ||
      new Set(targetTaskEvidence.map((candidate) => candidate.providerTaskHandleSha256)).size !==
        1 ||
      targetTaskEvidence.filter(
        (candidate) =>
          candidate.actionRequired?.code === 'provider_task_session_locator_unavailable'
      ).length > 1
    ) {
      return false;
    }
    const rootAuthorization = succeededRecoveryCommands[0]!.authorization;
    if (
      rootAuthorization.schema !==
        'dnaforge.benchling.provider-task-direct-folder-succeeded-gmail-recovery.v1' ||
      rootAuthorization.recoveryOrdinal !== 1 ||
      !isExactDirectFolderGmailRescanCommandCorrelation(input, rootAuthorization)
    ) {
      return false;
    }
    const rootCommands = pollCommands.filter(
      (command) =>
        command.commandRequestId === rootAuthorization.rootSucceededCommandRequestId &&
        command.directFolderGmailRescan === undefined
    );
    const rootActivities = pollActivities.filter(
      (activity) => activity.commandRequestId === rootAuthorization.rootSucceededCommandRequestId
    );
    if (rootCommands.length !== 1 || rootActivities.length !== 1) return false;
    const rootCommand = rootCommands[0]!;
    const rootActivity = rootActivities[0]!;
    const [rootTaskRead, rootGmailRead] = rootActivity.observations;
    const exactRootTaskRead =
      rootTaskRead?.ordinal === 0 &&
      rootTaskRead.requestClass === 'export_task_status' &&
      rootTaskRead.providerSurface === 'benchling_tenant' &&
      rootTaskRead.method === 'GET' &&
      ((rootTaskRead.kind === 'network_request' &&
        rootTaskRead.result === 'response' &&
        rootTaskRead.statusClass === '2xx') ||
        (rootTaskRead.kind === 'cache_hit' && rootTaskRead.cacheLayer === 'extension_session'));
    const exactRootGmailMiss =
      rootGmailRead?.ordinal === 1 &&
      rootGmailRead.kind === 'local_miss' &&
      rootGmailRead.requestClass === 'gmail_receipt_page' &&
      rootGmailRead.providerSurface === 'gmail_web' &&
      rootGmailRead.method === 'READ' &&
      rootGmailRead.reason === 'receipt_not_open';
    const rootTasks = targetTaskEvidence.filter(
      (candidate) =>
        candidate.observedAt === rootActivity.observedAt &&
        candidate.status === 'SUCCEEDED' &&
        candidate.actionRequired === null &&
        candidate.providerTaskHandleSha256 === rootAuthorization.providerTaskHandleSha256
    );
    if (
      rootActivity.complete !== true ||
      rootActivity.observations.length !== 2 ||
      !exactRootTaskRead ||
      !exactRootGmailMiss ||
      rootTasks.length !== 1 ||
      targetTaskEvidenceTimes.has(rootActivity.observedAt) === false ||
      siblingTaskEvidence.some((candidate) => candidate.observedAt === rootActivity.observedAt) ||
      Date.parse(rootCommand.issuedAt) > Date.parse(rootActivity.observedAt)
    ) {
      return false;
    }
    const rootTask = rootTasks[0]!;
    const rootActivitySha256 = `sha256:${createHash('sha256')
      .update(
        canonicalValidationJson({
          schema: 'dnaforge.benchling.succeeded-task-gmail-activity-correlation.v1',
          runId: input.run.id,
          jobId: job.id,
          matchSignature: job.matchSignature,
          command: rootCommand,
          activity: rootActivity,
          task: rootTask,
        })
      )
      .digest('hex')}`;
    const originalCommands = (input.providerCommandJournal ?? []).filter(
      (candidate) =>
        candidate.runId === input.run.id &&
        candidate.operationKind === 'submit_export' &&
        candidate.exportJobId === job.id &&
        candidate.commandRequestId === rootAuthorization.originalCommandRequestId &&
        candidate.nativeExportLedgerEpoch === rootAuthorization.nativeExportLedgerEpoch
    );
    const originalActivities = (input.providerActivityEvidence ?? []).filter(
      (activity) =>
        activity.runId === input.run.id &&
        activity.operationKind === 'submit_export' &&
        activity.commandRequestId === rootAuthorization.originalCommandRequestId
    );
    const originalObservation = originalActivities[0]?.observations[0];
    if (
      rootAuthorization.rootSucceededActivitySha256 !== rootActivitySha256 ||
      rootAuthorization.providerTaskHandleSha256 !== rootTask.providerTaskHandleSha256 ||
      originalCommands.length !== 1 ||
      originalActivities.length !== 1 ||
      originalActivities[0]?.complete !== true ||
      originalActivities[0]?.observations.length !== 1 ||
      originalObservation?.ordinal !== 0 ||
      !(
        (originalObservation.kind === 'network_request' &&
          originalObservation.requestClass === 'export_submit' &&
          originalObservation.providerSurface === 'benchling_tenant' &&
          originalObservation.method === 'POST' &&
          originalObservation.result === 'response' &&
          originalObservation.statusClass === '2xx') ||
        (originalObservation.kind === 'cache_hit' &&
          originalObservation.requestClass === 'export_submit' &&
          originalObservation.providerSurface === 'benchling_tenant' &&
          originalObservation.method === 'POST' &&
          originalObservation.cacheLayer === 'extension_session')
      ) ||
      Date.parse(originalCommands[0]!.issuedAt) > Date.parse(originalActivities[0]!.observedAt) ||
      Date.parse(originalActivities[0]!.observedAt) > Date.parse(rootTask.observedAt)
    ) {
      return false;
    }

    let priorCommandRequestId = rootCommand.commandRequestId;
    let priorActivitySha256 = rootActivitySha256;
    let priorActivity = rootActivity;
    let priorRunAttempt: number | null = null;
    const expectedActivityIds = new Set([rootActivity.id]);
    const interventionDigests = new Set<string>();
    for (const [index, recovery] of succeededRecoveryCommands.entries()) {
      const { command, authorization } = recovery;
      if (!isExactDirectFolderGmailRescanCommandCorrelation(input, authorization)) {
        return false;
      }
      const activities = pollActivities.filter(
        (activity) => activity.commandRequestId === command.commandRequestId
      );
      if (
        activities.length !== 1 ||
        (!isExactDirectFolderGmailPageReadActivity(activities[0]) &&
          !isExactDirectFolderGmailPageMissActivity(activities[0])) ||
        exactCommandFor(activities[0]!) !== command
      ) {
        return false;
      }
      const activity = activities[0]!;
      const activitySha256 = `sha256:${createHash('sha256')
        .update(
          canonicalValidationJson({
            schema: 'dnaforge.benchling.gmail-page-only-rescan-activity-correlation.v1',
            runId: input.run.id,
            jobId: job.id,
            matchSignature: job.matchSignature,
            command,
            activity,
          })
        )
        .digest('hex')}`;
      if (
        authorization.recoveryOrdinal !== index + 1 ||
        authorization.rootSucceededCommandRequestId !== rootCommand.commandRequestId ||
        authorization.rootSucceededActivitySha256 !== rootActivitySha256 ||
        authorization.priorRecoveryCommandRequestId !== priorCommandRequestId ||
        authorization.priorRecoveryActivitySha256 !== priorActivitySha256 ||
        authorization.providerTaskHandleSha256 !== rootTask.providerTaskHandleSha256 ||
        authorization.directFolderAuthorityDigest !==
          rootAuthorization.directFolderAuthorityDigest ||
        authorization.directFolderSourceItemNameSha256 !==
          rootAuthorization.directFolderSourceItemNameSha256 ||
        authorization.nativeExportLedgerEpoch !== rootAuthorization.nativeExportLedgerEpoch ||
        authorization.originalCommandRequestId !== rootAuthorization.originalCommandRequestId ||
        interventionDigests.has(authorization.interventionSha256) ||
        (priorRunAttempt !== null &&
          (authorization.runAttempt !== priorRunAttempt + 1 ||
            authorization.priorCapabilityRunAttempt !== priorRunAttempt)) ||
        authorization.priorCapabilityRunAttempt !== authorization.runAttempt - 1 ||
        Date.parse(priorActivity.observedAt) > Date.parse(command.issuedAt) ||
        Date.parse(command.issuedAt) > Date.parse(activity.observedAt) ||
        [...targetTaskEvidence, ...siblingTaskEvidence].some(
          (candidate) => candidate.observedAt === activity.observedAt
        )
      ) {
        return false;
      }
      interventionDigests.add(authorization.interventionSha256);
      priorCommandRequestId = command.commandRequestId;
      priorActivitySha256 = activitySha256;
      priorActivity = activity;
      priorRunAttempt = authorization.runAttempt;
      expectedActivityIds.add(activity.id);
    }
    const locatorEvidence = targetTaskEvidence.filter(
      (candidate) => candidate.actionRequired?.code === 'provider_task_session_locator_unavailable'
    );
    if (locatorEvidence.length === 1) {
      const locator = locatorEvidence[0]!;
      const locatorActivities = pollActivities.filter(
        (activity) => activity.observedAt === locator.observedAt
      );
      const locatorActivity = locatorActivities[0];
      const locatorCommand = locatorActivity ? exactCommandFor(locatorActivity) : null;
      const [locatorRead] = locatorActivity?.observations ?? [];
      if (
        locatorActivities.length !== 1 ||
        !locatorActivity ||
        !locatorCommand ||
        locatorCommand.directFolderGmailRescan !== undefined ||
        locatorActivity.complete !== true ||
        locatorActivity.observations.length !== 1 ||
        locatorRead?.ordinal !== 0 ||
        locatorRead.kind !== 'cache_hit' ||
        locatorRead.requestClass !== 'export_task_status' ||
        locatorRead.providerSurface !== 'benchling_tenant' ||
        locatorRead.method !== 'GET' ||
        locatorRead.cacheLayer !== 'extension_session' ||
        Date.parse(rootActivity.observedAt) > Date.parse(locatorCommand.issuedAt) ||
        Date.parse(locatorCommand.issuedAt) > Date.parse(locator.actionRequired!.recordedAt) ||
        Date.parse(locator.actionRequired!.recordedAt) > Date.parse(locator.observedAt) ||
        Date.parse(locator.observedAt) > Date.parse(succeededRecoveryCommands[0]!.command.issuedAt)
      ) {
        return false;
      }
      expectedActivityIds.add(locatorActivity.id);
    }
    const chainStartAt = Date.parse(rootActivity.observedAt);
    const chainEndAt = Date.parse(priorActivity.observedAt);
    return (
      isExactDirectFolderGmailPageReadActivity(priorActivity) &&
      Date.parse(confirmation.confirmedAt) >= chainEndAt &&
      Number.isFinite(chainStartAt) &&
      Number.isFinite(chainEndAt) &&
      chainStartAt < chainEndAt &&
      !pollActivities.some(
        (activity) =>
          !expectedActivityIds.has(activity.id) &&
          Date.parse(activity.observedAt) >= chainStartAt &&
          Date.parse(activity.observedAt) <= chainEndAt
      )
    );
  }

  const sequenceRecoveryCommands = targetRescanCommands.filter(
    (command) =>
      command.directFolderGmailRescan?.schema ===
      'dnaforge.benchling.provider-task-direct-folder-sequence-gmail-recovery.v1'
  );
  if (sequenceRecoveryCommands.length > 0) {
    if (
      targetRescanCommands.length !== 1 ||
      sequenceRecoveryCommands.length !== 1 ||
      targetTaskEvidence.length < 1 ||
      targetTaskEvidence.length > 2 ||
      siblingTaskEvidence.some((candidate) => targetTaskEvidenceTimes.has(candidate.observedAt))
    ) {
      return false;
    }
    const command = sequenceRecoveryCommands[0]!;
    const authorization = command.directFolderGmailRescan!;
    if (
      authorization.schema !==
        'dnaforge.benchling.provider-task-direct-folder-sequence-gmail-recovery.v1' ||
      !isExactDirectFolderGmailRescanCommandCorrelation(input, authorization) ||
      authorization.runAttempt !== targetTaskEvidence.length + 1 ||
      authorization.priorCapabilityRunAttempt !== targetTaskEvidence.length ||
      targetTaskEvidence.some(
        (candidate) =>
          candidate.status !== 'ACTION_REQUIRED' ||
          candidate.providerTaskHandleSha256 !== authorization.providerTaskHandleSha256 ||
          candidate.actionRequired?.code !== 'provider_task_status_undocumented' ||
          candidate.actionRequired.providerStatus !== null ||
          candidate.actionRequired.diagnostic !== 'unrecognized_status'
      ) ||
      latest.providerTaskHandleSha256 !== authorization.providerTaskHandleSha256 ||
      latest.status !== 'ACTION_REQUIRED' ||
      latest.actionRequired?.code !== 'provider_task_status_undocumented' ||
      latest.actionRequired.providerStatus !== null ||
      latest.actionRequired.diagnostic !== 'unrecognized_status'
    ) {
      return false;
    }
    const activities = pollActivities.filter(
      (activity) => activity.commandRequestId === command.commandRequestId
    );
    const originalCommands = (input.providerCommandJournal ?? []).filter(
      (candidate) =>
        candidate.runId === input.run.id &&
        candidate.operationKind === 'submit_export' &&
        candidate.exportJobId === job.id &&
        candidate.commandRequestId === authorization.originalCommandRequestId &&
        candidate.nativeExportLedgerEpoch === authorization.nativeExportLedgerEpoch
    );
    const originalActivities = (input.providerActivityEvidence ?? []).filter(
      (activity) =>
        activity.runId === input.run.id &&
        activity.operationKind === 'submit_export' &&
        activity.commandRequestId === authorization.originalCommandRequestId
    );
    const originalObservation = originalActivities[0]?.observations[0];
    return (
      activities.length === 1 &&
      isExactDirectFolderGmailPageReadActivity(activities[0]) &&
      exactCommandFor(activities[0]!) === command &&
      originalCommands.length === 1 &&
      originalActivities.length === 1 &&
      originalActivities[0]?.complete === true &&
      originalActivities[0]?.observations.length === 1 &&
      originalObservation?.ordinal === 0 &&
      originalObservation.kind === 'network_request' &&
      originalObservation.requestClass === 'export_submit' &&
      originalObservation.providerSurface === 'benchling_tenant' &&
      originalObservation.method === 'POST' &&
      originalObservation.result === 'response' &&
      originalObservation.statusClass === '2xx' &&
      Date.parse(originalCommands[0]!.issuedAt) <= Date.parse(originalActivities[0]!.observedAt) &&
      Date.parse(originalActivities[0]!.observedAt) <=
        Date.parse(targetTaskEvidence[0]!.observedAt) &&
      Date.parse(latest.observedAt) <= Date.parse(command.issuedAt) &&
      Date.parse(command.issuedAt) <= Date.parse(activities[0]!.observedAt) &&
      Date.parse(confirmation.confirmedAt) >= Date.parse(activities[0]!.observedAt)
    );
  }

  const roots = targetRescanCommands.filter(
    (command) =>
      command.directFolderGmailRescan?.schema ===
      'dnaforge.benchling.provider-task-direct-folder-gmail-rescan.v1'
  );
  if (roots.length !== 1) return false;
  const rootCommand = roots[0]!;
  const rootAuthorization = rootCommand.directFolderGmailRescan!;
  if (
    rootAuthorization.schema !== 'dnaforge.benchling.provider-task-direct-folder-gmail-rescan.v1' ||
    !isExactDirectFolderGmailRescanCommandCorrelation(input, rootAuthorization)
  ) {
    return false;
  }
  const fallbackCommands = pollCommands.filter(
    (command) =>
      command.commandRequestId === rootAuthorization.priorFallbackCommandRequestId &&
      command.directFolderGmailRescan === undefined
  );
  const fallbackActivities = pollActivities.filter(
    (activity) =>
      activity.commandRequestId === rootAuthorization.priorFallbackCommandRequestId &&
      isExactRunningTaskGmailMissActivity(activity)
  );
  if (fallbackCommands.length !== 1 || fallbackActivities.length !== 1) return false;
  const fallbackCommand = fallbackCommands[0]!;
  const fallbackActivity = fallbackActivities[0]!;
  const fallbackTask = [...targetTaskEvidence]
    .filter((candidate) => Date.parse(candidate.observedAt) <= Date.parse(fallbackCommand.issuedAt))
    .sort(compareProviderTaskEvidence)
    .at(-1);
  if (
    !fallbackTask ||
    fallbackTask.providerTaskHandleSha256 !== latest.providerTaskHandleSha256 ||
    fallbackTask.status !== 'RUNNING' ||
    fallbackTask.actionRequired !== null ||
    exactCommandFor(fallbackActivity) !== fallbackCommand
  ) {
    return false;
  }
  const fallbackActivitySha256 = `sha256:${createHash('sha256')
    .update(
      canonicalValidationJson({
        schema: 'dnaforge.benchling.running-task-gmail-activity-correlation.v1',
        runId: input.run.id,
        jobId: job.id,
        matchSignature: job.matchSignature,
        command: fallbackCommand,
        activity: fallbackActivity,
        task: fallbackTask,
      })
    )
    .digest('hex')}`;
  const exactOriginalSubmissions = (input.providerCommandJournal ?? []).filter(
    (command) =>
      command.operationKind === 'submit_export' &&
      command.exportJobId === job.id &&
      command.commandRequestId === rootAuthorization.originalCommandRequestId &&
      command.nativeExportLedgerEpoch === rootAuthorization.nativeExportLedgerEpoch
  );
  if (
    rootAuthorization.providerTaskHandleSha256 !== latest.providerTaskHandleSha256 ||
    rootAuthorization.priorFallbackCommandRequestId !== fallbackCommand.commandRequestId ||
    rootAuthorization.priorFallbackActivitySha256 !== fallbackActivitySha256 ||
    rootAuthorization.priorCapabilityRunAttempt !== rootAuthorization.runAttempt - 1 ||
    exactOriginalSubmissions.length !== 1 ||
    Date.parse(fallbackActivity.observedAt) > Date.parse(rootCommand.issuedAt)
  ) {
    return false;
  }
  const rootActivities = pollActivities.filter(
    (activity) => activity.commandRequestId === rootCommand.commandRequestId
  );
  if (
    rootActivities.length !== 1 ||
    (!isExactRunningTaskGmailFallbackActivity(rootActivities[0]) &&
      !isExactRunningTaskGmailMissActivity(rootActivities[0])) ||
    exactCommandFor(rootActivities[0]!) !== rootCommand
  ) {
    return false;
  }
  const rootActivity = rootActivities[0]!;
  const rootTask = isExactRunningTaskGmailFallbackActivity(rootActivity)
    ? targetTaskEvidence.filter(
        (candidate) =>
          candidate.observedAt === rootActivity.observedAt &&
          candidate.providerTaskHandleSha256 === rootAuthorization.providerTaskHandleSha256
      )[0]
    : [...targetTaskEvidence]
        .filter((candidate) => Date.parse(candidate.observedAt) <= Date.parse(rootCommand.issuedAt))
        .sort(compareProviderTaskEvidence)
        .at(-1);
  if (
    !rootTask ||
    rootTask.providerTaskHandleSha256 !== rootAuthorization.providerTaskHandleSha256 ||
    rootTask.status !== 'RUNNING' ||
    rootTask.actionRequired !== null
  ) {
    return false;
  }
  const rootActivitySha256 = `sha256:${createHash('sha256')
    .update(
      canonicalValidationJson({
        schema: 'dnaforge.benchling.running-task-gmail-activity-correlation.v1',
        runId: input.run.id,
        jobId: job.id,
        matchSignature: job.matchSignature,
        command: rootCommand,
        activity: rootActivity,
        task: rootTask,
      })
    )
    .digest('hex')}`;
  const v2Commands = targetRescanCommands
    .filter(
      (command) =>
        command.directFolderGmailRescan?.schema ===
        'dnaforge.benchling.provider-task-direct-folder-gmail-rescan.v2'
    )
    .sort((left, right) => {
      const leftAuthorization = left.directFolderGmailRescan;
      const rightAuthorization = right.directFolderGmailRescan;
      return leftAuthorization!.runAttempt - rightAuthorization!.runAttempt;
    });
  if (targetRescanCommands.length !== v2Commands.length + 1) return false;
  let priorCommand = rootCommand;
  let priorActivity = rootActivity;
  let priorActivitySha256 = rootActivitySha256;
  let finalActivity = rootActivity;
  const expectedActivityIds = new Set([fallbackActivity.id, rootActivity.id]);
  const interventionDigests = new Set([rootAuthorization.interventionSha256]);
  for (let index = 0; index < v2Commands.length; index += 1) {
    const command = v2Commands[index]!;
    const authorization = command.directFolderGmailRescan!;
    if (
      authorization.schema !== 'dnaforge.benchling.provider-task-direct-folder-gmail-rescan.v2' ||
      !isExactDirectFolderGmailRescanCommandCorrelation(input, authorization)
    ) {
      return false;
    }
    const activities = pollActivities.filter(
      (activity) => activity.commandRequestId === command.commandRequestId
    );
    if (
      activities.length !== 1 ||
      (!isExactDirectFolderGmailPageReadActivity(activities[0]) &&
        !isExactDirectFolderGmailPageMissActivity(activities[0])) ||
      exactCommandFor(activities[0]!) !== command
    ) {
      return false;
    }
    const activity = activities[0]!;
    const ordinal = index + 2;
    if (
      interventionDigests.has(authorization.interventionSha256) ||
      [...targetTaskEvidence, ...siblingTaskEvidence].some(
        (candidate) => candidate.observedAt === activity.observedAt
      ) ||
      authorization.rescanOrdinal !== ordinal ||
      authorization.runAttempt !== rootAuthorization.runAttempt + ordinal - 1 ||
      authorization.priorCapabilityRunAttempt !== authorization.runAttempt - 1 ||
      authorization.providerTaskHandleSha256 !== rootAuthorization.providerTaskHandleSha256 ||
      authorization.directFolderAuthorityDigest !== rootAuthorization.directFolderAuthorityDigest ||
      authorization.directFolderSourceItemNameSha256 !==
        rootAuthorization.directFolderSourceItemNameSha256 ||
      authorization.nativeExportLedgerEpoch !== rootAuthorization.nativeExportLedgerEpoch ||
      authorization.originalCommandRequestId !== rootAuthorization.originalCommandRequestId ||
      authorization.priorFallbackCommandRequestId !==
        rootAuthorization.priorFallbackCommandRequestId ||
      authorization.priorFallbackActivitySha256 !== rootAuthorization.priorFallbackActivitySha256 ||
      authorization.rootRescanCommandRequestId !== rootCommand.commandRequestId ||
      authorization.rootRescanActivitySha256 !== rootActivitySha256 ||
      authorization.priorRescanCommandRequestId !== priorCommand.commandRequestId ||
      authorization.priorRescanActivitySha256 !== priorActivitySha256 ||
      Date.parse(priorActivity.observedAt) > Date.parse(command.issuedAt)
    ) {
      return false;
    }
    interventionDigests.add(authorization.interventionSha256);
    priorCommand = command;
    priorActivity = activity;
    priorActivitySha256 = `sha256:${createHash('sha256')
      .update(
        canonicalValidationJson({
          schema: 'dnaforge.benchling.gmail-page-only-rescan-activity-correlation.v1',
          runId: input.run.id,
          jobId: job.id,
          matchSignature: job.matchSignature,
          command,
          activity,
        })
      )
      .digest('hex')}`;
    finalActivity = activity;
    expectedActivityIds.add(activity.id);
  }
  const chainStartAt = Date.parse(fallbackActivity.observedAt);
  const chainEndAt = Date.parse(finalActivity.observedAt);
  const siblingTaskAmbiguity = siblingTaskEvidence.some(
    (candidate) =>
      candidate.observedAt === fallbackTask.observedAt ||
      candidate.observedAt === rootTask.observedAt
  );
  const interveningPollAmbiguity = pollActivities.some(
    (activity) =>
      !expectedActivityIds.has(activity.id) &&
      Date.parse(activity.observedAt) >= chainStartAt &&
      Date.parse(activity.observedAt) <= chainEndAt
  );
  return (
    (isExactRunningTaskGmailFallbackActivity(finalActivity) ||
      isExactDirectFolderGmailPageReadActivity(finalActivity)) &&
    Date.parse(confirmation.confirmedAt) >= chainEndAt &&
    Number.isFinite(chainStartAt) &&
    Number.isFinite(chainEndAt) &&
    chainStartAt < chainEndAt &&
    !siblingTaskAmbiguity &&
    !interveningPollAmbiguity
  );
}

function isExactDirectFolderGmailRescanCommandCorrelation(
  input: GenerateValidationReportInput,
  authorization: NonNullable<ProviderCommandJournalEntry['directFolderGmailRescan']>
): boolean {
  const succeededRecovery =
    authorization.schema ===
    'dnaforge.benchling.provider-task-direct-folder-succeeded-gmail-recovery.v1';
  if (succeededRecovery) {
    if (
      !hasExactKeys(authorization, [
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
      ]) ||
      authorization.scopeKind !== 'folder' ||
      authorization.dispatchMode !== 'gmail_page_only' ||
      authorization.runId !== input.run.id ||
      input.run.scope.kind !== 'folder' ||
      !Number.isSafeInteger(authorization.runAttempt) ||
      authorization.runAttempt < 2 ||
      !Number.isSafeInteger(authorization.priorCapabilityRunAttempt) ||
      authorization.priorCapabilityRunAttempt !== authorization.runAttempt - 1 ||
      !Number.isSafeInteger(authorization.recoveryOrdinal) ||
      authorization.recoveryOrdinal < 1 ||
      authorization.pageReadOrdinal !== 1 ||
      authorization.pageReadLimit !== 1 ||
      authorization.requiredProviderTaskStatus !== 'SUCCEEDED' ||
      !/^sha256:[a-f0-9]{64}$/u.test(authorization.interventionSha256) ||
      !/^sha256:[a-f0-9]{64}$/u.test(authorization.directFolderAuthorityDigest) ||
      !/^sha256:[a-f0-9]{64}$/u.test(authorization.directFolderSourceItemNameSha256) ||
      !/^sha256:[a-f0-9]{64}$/u.test(authorization.providerTaskHandleSha256) ||
      !/^sha256:[a-f0-9]{64}$/u.test(authorization.rootSucceededActivitySha256) ||
      !/^sha256:[a-f0-9]{64}$/u.test(authorization.priorRecoveryActivitySha256) ||
      !/^native-ledger-epoch:[a-f0-9]{32}$/u.test(authorization.nativeExportLedgerEpoch) ||
      (authorization.recoveryOrdinal === 1 &&
        (authorization.priorRecoveryCommandRequestId !==
          authorization.rootSucceededCommandRequestId ||
          authorization.priorRecoveryActivitySha256 !== authorization.rootSucceededActivitySha256))
    ) {
      return false;
    }
    const job = input.exportJobs.find(
      (candidate) =>
        candidate.id === authorization.jobId &&
        candidate.matchSignature === authorization.matchSignature
    );
    return Boolean(
      job?.contentFamily === 'notebook' &&
      job.directFolderAuthority?.sourceItemType === 'entry' &&
      job.directFolderAuthority.requestCapabilityId === 'benchling.notebook-entry-html-export.v1' &&
      job.folderTreeAuthority === undefined &&
      job.folderTreeReplacementLineage === undefined &&
      directFolderAuthorityDigest(job.directFolderAuthority) ===
        authorization.directFolderAuthorityDigest &&
      validationDirectFolderSourceItemNameSha256(input, job) ===
        authorization.directFolderSourceItemNameSha256
    );
  }
  const sequenceRecovery =
    authorization.schema ===
    'dnaforge.benchling.provider-task-direct-folder-sequence-gmail-recovery.v1';
  if (sequenceRecovery) {
    if (
      !hasExactKeys(authorization, [
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
      ]) ||
      authorization.scopeKind !== 'folder' ||
      authorization.dispatchMode !== 'gmail_page_only' ||
      authorization.runId !== input.run.id ||
      input.run.scope.kind !== 'folder' ||
      !(
        (authorization.runAttempt === 2 && authorization.priorCapabilityRunAttempt === 1) ||
        (authorization.runAttempt === 3 && authorization.priorCapabilityRunAttempt === 2)
      ) ||
      authorization.pageReadOrdinal !== 1 ||
      authorization.pageReadLimit !== 1 ||
      authorization.requiredProviderTaskStatus !== 'ACTION_REQUIRED' ||
      authorization.priorActionRequiredCode !== 'provider_task_status_undocumented' ||
      authorization.priorDiagnostic !== 'unrecognized_status' ||
      !/^sha256:[a-f0-9]{64}$/u.test(authorization.interventionSha256) ||
      !/^sha256:[a-f0-9]{64}$/u.test(authorization.directFolderAuthorityDigest) ||
      !/^sha256:[a-f0-9]{64}$/u.test(authorization.directFolderSourceItemNameSha256) ||
      !/^sha256:[a-f0-9]{64}$/u.test(authorization.providerTaskHandleSha256) ||
      !/^native-ledger-epoch:[a-f0-9]{32}$/u.test(authorization.nativeExportLedgerEpoch)
    ) {
      return false;
    }
    const job = input.exportJobs.find(
      (candidate) =>
        candidate.id === authorization.jobId &&
        candidate.matchSignature === authorization.matchSignature
    );
    return Boolean(
      job?.contentFamily === 'dna_rna' &&
      job.directFolderAuthority?.sourceItemType === 'sequence' &&
      job.directFolderAuthority.requestCapabilityId ===
        'benchling.sequence-single-file-export.v1' &&
      job.folderTreeAuthority === undefined &&
      job.folderTreeReplacementLineage === undefined &&
      directFolderAuthorityDigest(job.directFolderAuthority) ===
        authorization.directFolderAuthorityDigest &&
      validationDirectFolderSourceItemNameSha256(input, job) ===
        authorization.directFolderSourceItemNameSha256
    );
  }
  const pageOnly =
    authorization.schema === 'dnaforge.benchling.provider-task-direct-folder-gmail-rescan.v2';
  if (
    !hasExactKeys(authorization, [
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
    ]) ||
    (authorization.schema !== 'dnaforge.benchling.provider-task-direct-folder-gmail-rescan.v1' &&
      !pageOnly) ||
    authorization.scopeKind !== 'folder' ||
    authorization.runId !== input.run.id ||
    input.run.scope.kind !== 'folder' ||
    authorization.runAttempt < 2 ||
    authorization.priorCapabilityRunAttempt !== authorization.runAttempt - 1 ||
    (pageOnly
      ? authorization.dispatchMode !== 'gmail_page_only' ||
        authorization.pageReadOrdinal !== 1 ||
        authorization.pageReadLimit !== 1 ||
        !Number.isSafeInteger(authorization.rescanOrdinal) ||
        authorization.rescanOrdinal < 2
      : authorization.requestOrdinal !== 1 || authorization.requestLimit !== 1) ||
    authorization.requiredProviderTaskStatus !== 'RUNNING' ||
    !/^sha256:[a-f0-9]{64}$/u.test(authorization.interventionSha256) ||
    !/^sha256:[a-f0-9]{64}$/u.test(authorization.directFolderAuthorityDigest) ||
    !/^sha256:[a-f0-9]{64}$/u.test(authorization.directFolderSourceItemNameSha256) ||
    !/^sha256:[a-f0-9]{64}$/u.test(authorization.providerTaskHandleSha256) ||
    !/^sha256:[a-f0-9]{64}$/u.test(authorization.priorFallbackActivitySha256) ||
    (pageOnly &&
      (!/^sha256:[a-f0-9]{64}$/u.test(authorization.rootRescanActivitySha256) ||
        !/^sha256:[a-f0-9]{64}$/u.test(authorization.priorRescanActivitySha256))) ||
    !/^native-ledger-epoch:[a-f0-9]{32}$/u.test(authorization.nativeExportLedgerEpoch)
  ) {
    return false;
  }
  const job = input.exportJobs.find(
    (candidate) =>
      candidate.id === authorization.jobId &&
      candidate.matchSignature === authorization.matchSignature
  );
  if (
    !job?.directFolderAuthority ||
    job.folderTreeAuthority !== undefined ||
    job.folderTreeReplacementLineage !== undefined ||
    directFolderAuthorityDigest(job.directFolderAuthority) !==
      authorization.directFolderAuthorityDigest
  ) {
    return false;
  }
  return (
    validationDirectFolderSourceItemNameSha256(input, job) ===
    authorization.directFolderSourceItemNameSha256
  );
}

function validationDirectFolderSourceItemNameSha256(
  input: GenerateValidationReportInput,
  job: ExportJob
): string | null {
  const authority = job.directFolderAuthority;
  if (!authority || !input.directFolderTraversalJournal) return null;
  try {
    const replay = replayScopedFolderTraversalJournalSync(input.directFolderTraversalJournal);
    const selectedItems = replay.terminalEvidence?.selectedItems ?? [];
    const exact = selectedItems.filter(
      (item) =>
        item.id === authority.sourceItemId &&
        item.type === authority.sourceItemType &&
        item.sourceFolderIds.length === 1 &&
        input.run.scope.kind === 'folder' &&
        item.sourceFolderIds[0] === input.run.scope.folder.id
    );
    const terminal = replay.terminalEvidence;
    if (exact.length !== 1 || !terminal) {
      return null;
    }
    const observedNames = [
      ...selectedItems.map((item) => item.name),
      ...terminal.folderFacts
        .filter(
          (folder) =>
            !input.directFolderTraversalJournal!.selectedRootIds.includes(folder.id) &&
            typeof folder.name === 'string'
        )
        .map((folder) => folder.name as string),
    ];
    const targetName = exact[0]!.name;
    const canonicalTargetName = targetName.trim().normalize('NFC');
    if (
      observedNames.filter((name) => name === targetName).length !== 1 ||
      observedNames.filter((name) => name.trim().normalize('NFC') === canonicalTargetName)
        .length !== 1
    ) {
      return null;
    }
    return `sha256:${createHash('sha256')
      .update(
        JSON.stringify({
          name: targetName,
          schema: 'dnaforge.benchling.direct-folder-source-item-name.v1',
        })
      )
      .digest('hex')}`;
  } catch {
    return null;
  }
}

function isExactDirectFolderRunningTaskGmailFallbackJob(
  input: GenerateValidationReportInput,
  job: ExportJob | undefined
): boolean {
  if (
    !job ||
    input.run.scope.kind !== 'folder' ||
    job.runId !== input.run.id ||
    job.directFolderAuthority === undefined ||
    job.folderTreeAuthority !== undefined ||
    job.folderTreeReplacementLineage !== undefined
  ) {
    return false;
  }
  const authority = job.directFolderAuthority;
  const [sourceRoot] = job.sourceRoots;
  if (
    job.sourceRoots.length !== 1 ||
    sourceRoot?.id !== authority.sourceItemId ||
    sourceRoot?.url !== authority.sourceItemUrl ||
    authority.selectedRootId !== input.run.scope.folder.id ||
    authority.sourceFolderIds.length !== 1 ||
    authority.sourceFolderIds[0] !== input.run.scope.folder.id ||
    (authority.sourceItemType === 'entry' &&
      (job.contentFamily !== 'notebook' ||
        authority.requestCapabilityId !== 'benchling.notebook-entry-html-export.v1')) ||
    (authority.sourceItemType === 'sequence' &&
      (job.contentFamily !== 'dna_rna' ||
        authority.requestCapabilityId !== 'benchling.sequence-single-file-export.v1'))
  ) {
    return false;
  }

  try {
    const plan = validateDirectFolderCapturePlan(input.directFolderCapturePlan);
    if (!input.directFolderTraversalJournal) return false;
    assertDirectFolderCapturePlanMatchesJournal(plan, input.directFolderTraversalJournal);
    const plannedItem = plan.items.find(
      (candidate) => candidate.sourceId === authority.sourceItemId
    );
    return (
      plan.runId === input.run.id &&
      plan.selectedRootId === input.run.scope.folder.id &&
      plan.sourceAccountHash === input.run.binding?.accountHash &&
      plan.startAllowed === true &&
      plan.blockers.length === 0 &&
      plan.planDigest === authority.capturePlanDigest &&
      plan.traversalJournalDigest === authority.traversalJournalDigest &&
      directFolderTraversalJournalDigest(input.directFolderTraversalJournal) ===
        authority.traversalJournalDigest &&
      plannedItem?.sourceType === authority.sourceItemType &&
      plannedItem.sourceUrl === authority.sourceItemUrl &&
      plannedItem.requestCapability.state === 'ready' &&
      plannedItem.requestCapability.id === authority.requestCapabilityId
    );
  } catch {
    return false;
  }
}

function isExactRunningTaskGmailFallbackActivity(
  activity: ProviderActivityBundle | undefined
): boolean {
  if (!activity) return false;
  const [taskRead, gmailRead] = activity.observations;
  return (
    activity.schema === 'dnaforge.benchling.provider-activity-bundle.v1' &&
    activity.complete === true &&
    activity.observations.length === 2 &&
    taskRead?.ordinal === 0 &&
    taskRead.kind === 'network_request' &&
    taskRead.requestClass === 'export_task_status' &&
    taskRead.providerSurface === 'benchling_tenant' &&
    taskRead.method === 'GET' &&
    taskRead.result === 'response' &&
    taskRead.statusClass === '2xx' &&
    gmailRead?.ordinal === 1 &&
    gmailRead.kind === 'cache_hit' &&
    gmailRead.requestClass === 'gmail_receipt_page' &&
    gmailRead.providerSurface === 'gmail_web' &&
    gmailRead.method === 'READ' &&
    gmailRead.cacheLayer === 'browser_page'
  );
}

function isExactRunningTaskGmailMissActivity(
  activity: ProviderActivityBundle | undefined
): boolean {
  if (!activity) return false;
  const [taskRead, gmailRead] = activity.observations;
  return (
    activity.schema === 'dnaforge.benchling.provider-activity-bundle.v1' &&
    activity.complete === true &&
    activity.observations.length === 2 &&
    taskRead?.ordinal === 0 &&
    taskRead.kind === 'network_request' &&
    taskRead.requestClass === 'export_task_status' &&
    taskRead.providerSurface === 'benchling_tenant' &&
    taskRead.method === 'GET' &&
    taskRead.result === 'response' &&
    taskRead.statusClass === '2xx' &&
    gmailRead?.ordinal === 1 &&
    gmailRead.kind === 'local_miss' &&
    gmailRead.requestClass === 'gmail_receipt_page' &&
    gmailRead.providerSurface === 'gmail_web' &&
    gmailRead.method === 'READ' &&
    gmailRead.reason === 'receipt_not_open'
  );
}

function isExactDirectFolderGmailPageReadActivity(
  activity: ProviderActivityBundle | undefined
): boolean {
  if (!activity) return false;
  const [gmailRead] = activity.observations;
  return (
    activity.schema === 'dnaforge.benchling.provider-activity-bundle.v1' &&
    activity.complete === true &&
    activity.observations.length === 1 &&
    gmailRead?.ordinal === 0 &&
    gmailRead.kind === 'cache_hit' &&
    gmailRead.requestClass === 'gmail_receipt_page' &&
    gmailRead.providerSurface === 'gmail_web' &&
    gmailRead.method === 'READ' &&
    gmailRead.cacheLayer === 'browser_page'
  );
}

function isExactDirectFolderGmailPageMissActivity(
  activity: ProviderActivityBundle | undefined
): boolean {
  if (!activity) return false;
  const [gmailRead] = activity.observations;
  return (
    activity.schema === 'dnaforge.benchling.provider-activity-bundle.v1' &&
    activity.complete === true &&
    activity.observations.length === 1 &&
    gmailRead?.ordinal === 0 &&
    gmailRead.kind === 'local_miss' &&
    gmailRead.requestClass === 'gmail_receipt_page' &&
    gmailRead.providerSurface === 'gmail_web' &&
    gmailRead.method === 'READ' &&
    gmailRead.reason === 'receipt_not_open'
  );
}

function isCanonicalUtcTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return false;
  }
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return false;
  return new Date(epoch).toISOString() === value;
}

function validProviderTaskAction(observation: ProviderTaskEvidence): boolean {
  if (observation.actionRequired === null) {
    return observation.status !== 'FAILED' && observation.status !== 'ACTION_REQUIRED';
  }
  return (
    (observation.status === 'FAILED' || observation.status === 'ACTION_REQUIRED') &&
    observation.actionRequired.schema === 'dnaforge.benchling.native-export-action-required.v1' &&
    PROVIDER_TASK_ACTION_CODES.has(observation.actionRequired.code) &&
    ['FAILED', 'SUCCEEDED', null].includes(observation.actionRequired.providerStatus) &&
    (observation.actionRequired.diagnostic === undefined ||
      [
        'unrecognized_status',
        'unexpected_fields',
        'pending_result_non_null',
        'success_result_not_null',
      ].includes(observation.actionRequired.diagnostic)) &&
    Number.isFinite(Date.parse(observation.actionRequired.recordedAt))
  );
}

function validProviderTaskHandle(observation: ProviderTaskEvidence): boolean {
  if (observation.providerTaskHandleSha256 !== null) {
    return /^sha256:[a-f0-9]{64}$/u.test(observation.providerTaskHandleSha256);
  }
  return (
    observation.status === 'ACTION_REQUIRED' &&
    observation.actionRequired?.code === 'provider_task_identity_invalid'
  );
}

function compareProviderTaskEvidence(
  left: ProviderTaskEvidence,
  right: ProviderTaskEvidence
): number {
  return (
    Date.parse(left.observedAt) - Date.parse(right.observedAt) || left.id.localeCompare(right.id)
  );
}

function validateProviderActivity(
  input: GenerateValidationReportInput
): NonNullable<ValidationReportV2['providerActivity']> {
  const candidates = [...(input.providerActivityEvidence ?? [])].sort(
    (left, right) =>
      Date.parse(String(left.observedAt)) - Date.parse(String(right.observedAt)) ||
      String(left.commandRequestId).localeCompare(String(right.commandRequestId)) ||
      String(left.id).localeCompare(String(right.id))
  );
  const issues: MigrationIssue[] = [];
  const evidence: ProviderActivityBundle[] = [];
  const commandJournal: ProviderCommandJournalEntry[] = [];
  const seenIds = new Set<string>();
  const seenCommandRequestIds = new Set<string>();
  let validCompleteCount = 0;
  const commandCandidates = [...(input.providerCommandJournal ?? [])].sort(
    (left, right) =>
      Date.parse(String(left.issuedAt)) - Date.parse(String(right.issuedAt)) ||
      String(left.commandRequestId).localeCompare(String(right.commandRequestId)) ||
      String(left.id).localeCompare(String(right.id))
  );
  const missingRequiredEvidence =
    input.providerActivityRequired === true && candidates.length === 0;
  if (missingRequiredEvidence) {
    issues.push(
      blockingValidation(
        'Live migration has no durable provider-activity evidence; request counts are unavailable.'
      )
    );
  }
  const seenCommandIds = new Set<string>();
  const seenJournalRequestIds = new Set<string>();
  if (input.providerActivityRequired === true && commandCandidates.length === 0) {
    issues.push(
      blockingValidation(
        'Live migration has no durable pre-dispatch provider command journal; request coverage cannot be proven.'
      )
    );
  }
  for (const [commandIndex, command] of commandCandidates.entries()) {
    const exactCommandKeys = [
      'id',
      'runId',
      'commandRequestId',
      'operationKind',
      ...(command.exportJobId === undefined ? [] : ['exportJobId']),
      ...(command.nativeExportLedgerEpoch === undefined ? [] : ['nativeExportLedgerEpoch']),
      ...(command.reconcilesCommandRequestId === undefined ? [] : ['reconcilesCommandRequestId']),
      ...(command.explicitResumeAttempt === undefined ? [] : ['explicitResumeAttempt']),
      ...(command.interventionSha256 === undefined ? [] : ['interventionSha256']),
      ...(command.scopedFolderCorrelation === undefined ? [] : ['scopedFolderCorrelation']),
      ...(command.directFolderGmailRescan === undefined ? [] : ['directFolderGmailRescan']),
      'issuedAt',
    ];
    const correlatedJob =
      command.exportJobId === undefined
        ? null
        : input.exportJobs.find((job) => job.id === command.exportJobId);
    const valid =
      PROVIDER_ACTIVITY_ID.test(command.id) &&
      PROVIDER_ACTIVITY_ID.test(command.commandRequestId) &&
      command.runId === input.run.id &&
      PROVIDER_ACTIVITY_OPERATION_KINDS.has(command.operationKind) &&
      Number.isFinite(Date.parse(command.issuedAt)) &&
      !seenCommandIds.has(command.id) &&
      !seenJournalRequestIds.has(command.commandRequestId) &&
      hasExactKeys(command, exactCommandKeys) &&
      (command.exportJobId === undefined ||
        ((command.operationKind === 'submit_export' ||
          command.operationKind === 'reconcile_export_submission' ||
          command.operationKind === 'download_export') &&
          correlatedJob?.runId === input.run.id)) &&
      (command.nativeExportLedgerEpoch === undefined ||
        ((command.operationKind === 'submit_export' ||
          command.operationKind === 'reconcile_export_submission' ||
          command.operationKind === 'download_export') &&
          /^native-ledger-epoch:[a-f0-9]{32}$/u.test(command.nativeExportLedgerEpoch))) &&
      (input.providerActivityRequired !== true ||
        command.operationKind !== 'submit_export' ||
        (command.exportJobId !== undefined && command.nativeExportLedgerEpoch !== undefined)) &&
      (command.operationKind !== 'download_export' ||
        (command.exportJobId === undefined && command.nativeExportLedgerEpoch === undefined) ||
        (command.exportJobId !== undefined && command.nativeExportLedgerEpoch !== undefined)) &&
      (command.operationKind === 'reconcile_export_submission'
        ? command.exportJobId !== undefined &&
          command.nativeExportLedgerEpoch !== undefined &&
          typeof command.reconcilesCommandRequestId === 'string' &&
          PROVIDER_ACTIVITY_ID.test(command.reconcilesCommandRequestId) &&
          Number.isSafeInteger(command.explicitResumeAttempt) &&
          Number(command.explicitResumeAttempt) >= 1 &&
          /^sha256:[a-f0-9]{64}$/u.test(String(command.interventionSha256))
        : command.reconcilesCommandRequestId === undefined &&
          command.explicitResumeAttempt === undefined &&
          command.interventionSha256 === undefined) &&
      (command.directFolderGmailRescan === undefined ||
        (command.operationKind === 'poll_export_receipts' &&
          isExactDirectFolderGmailRescanCommandCorrelation(
            input,
            command.directFolderGmailRescan
          )));
    seenCommandIds.add(command.id);
    seenJournalRequestIds.add(command.commandRequestId);
    if (!valid) {
      issues.push(
        blockingInvariant(`Provider command journal record ${commandIndex + 1} is malformed.`)
      );
      continue;
    }
    commandJournal.push({
      id: command.id,
      runId: command.runId,
      commandRequestId: command.commandRequestId,
      operationKind: command.operationKind,
      ...(command.exportJobId === undefined ? {} : { exportJobId: command.exportJobId }),
      ...(command.nativeExportLedgerEpoch === undefined
        ? {}
        : { nativeExportLedgerEpoch: command.nativeExportLedgerEpoch }),
      ...(command.reconcilesCommandRequestId === undefined
        ? {}
        : { reconcilesCommandRequestId: command.reconcilesCommandRequestId }),
      ...(command.explicitResumeAttempt === undefined
        ? {}
        : { explicitResumeAttempt: command.explicitResumeAttempt }),
      ...(command.interventionSha256 === undefined
        ? {}
        : { interventionSha256: command.interventionSha256 }),
      ...(command.scopedFolderCorrelation === undefined
        ? {}
        : { scopedFolderCorrelation: command.scopedFolderCorrelation }),
      ...(command.directFolderGmailRescan === undefined
        ? {}
        : { directFolderGmailRescan: command.directFolderGmailRescan }),
      issuedAt: command.issuedAt,
    });
  }

  for (const [candidateIndex, candidate] of candidates.entries()) {
    let valid = true;
    const recordNumber = candidateIndex + 1;
    if (
      !PROVIDER_ACTIVITY_ID.test(candidate.id) ||
      !PROVIDER_ACTIVITY_ID.test(candidate.commandRequestId) ||
      candidate.runId !== input.run.id ||
      candidate.schema !== 'dnaforge.benchling.provider-activity-bundle.v1' ||
      typeof candidate.complete !== 'boolean' ||
      !PROVIDER_ACTIVITY_OPERATION_KINDS.has(candidate.operationKind) ||
      !Number.isFinite(Date.parse(candidate.observedAt)) ||
      !Array.isArray(candidate.observations) ||
      candidate.observations.length > MAX_PROVIDER_ACTIVITY_OBSERVATIONS ||
      !hasExactKeys(candidate, [
        'id',
        'runId',
        'commandRequestId',
        'operationKind',
        'observedAt',
        'schema',
        'complete',
        'observations',
      ])
    ) {
      valid = false;
    }
    if (seenIds.has(candidate.id) || seenCommandRequestIds.has(candidate.commandRequestId)) {
      valid = false;
    }
    if (
      candidate.complete === true &&
      Array.isArray(candidate.observations) &&
      candidate.observations.length === 0 &&
      NETWORK_BACKED_PROVIDER_ACTIVITY_OPERATION_KINDS.has(candidate.operationKind)
    ) {
      valid = false;
    }
    const scopedProviderFreeMisses = Array.isArray(candidate.observations)
      ? candidate.observations.filter(
          (observation) =>
            observation.kind === 'local_miss' &&
            (observation.reason === 'traversal_authority_missing' ||
              observation.reason === 'provider_pre_dispatch_blocked')
        )
      : [];
    if (
      scopedProviderFreeMisses.length > 0 &&
      (candidate.complete !== true ||
        candidate.operationKind !== 'discover_scoped_folder_page' ||
        candidate.observations.length !== 1 ||
        scopedProviderFreeMisses.length !== 1)
    ) {
      valid = false;
    }
    seenIds.add(candidate.id);
    seenCommandRequestIds.add(candidate.commandRequestId);

    const observations = Array.isArray(candidate.observations)
      ? candidate.observations.map((observation, observationIndex) => {
          if (
            !validProviderActivityObservation(
              observation,
              observationIndex,
              candidate.operationKind
            )
          ) {
            valid = false;
          }
          return sanitizeProviderActivityObservation(observation);
        })
      : [];

    if (!valid || observations.some((observation) => observation === null)) {
      issues.push(
        blockingInvariant(`Provider activity evidence record ${recordNumber} is malformed.`)
      );
      continue;
    }

    const sanitized: ProviderActivityBundle = {
      id: candidate.id,
      runId: candidate.runId,
      commandRequestId: candidate.commandRequestId,
      operationKind: candidate.operationKind,
      observedAt: candidate.observedAt,
      schema: candidate.schema,
      complete: candidate.complete,
      observations: observations.filter(
        (observation): observation is ProviderActivityBundle['observations'][number] =>
          observation !== null
      ),
    };
    evidence.push(sanitized);
    if (sanitized.complete) {
      validCompleteCount += 1;
    }
  }

  const exportSubmitPostsByJob = new Map<string, number>();
  if (input.providerActivityRequired === true) {
    const commandByRequestId = new Map(
      commandJournal.map((command) => [command.commandRequestId, command] as const)
    );
    for (const bundle of evidence) {
      const command = commandByRequestId.get(bundle.commandRequestId);
      if (
        !command?.exportJobId ||
        (command.operationKind !== 'submit_export' &&
          command.operationKind !== 'reconcile_export_submission')
      ) {
        continue;
      }
      const postCount = bundle.observations.filter(
        (observation) =>
          observation.kind === 'network_request' &&
          observation.requestClass === 'export_submit' &&
          observation.method === 'POST'
      ).length;
      if (postCount > 0) {
        exportSubmitPostsByJob.set(
          command.exportJobId,
          (exportSubmitPostsByJob.get(command.exportJobId) ?? 0) + postCount
        );
      }
    }
  }

  const reconciliationResolution = validateNativeExportReconciliationResolutions({
    input,
    commandJournal,
    evidence,
    issues,
  });
  const resolvedIncompleteCommandIds = new Set(
    reconciliationResolution.resolvedIncompleteCommandIds
  );
  const opaqueRedirectResolution = resolveOpaqueRedirectMetadataRead({
    input,
    commandJournal,
    evidence,
  });
  for (const commandRequestId of opaqueRedirectResolution.resolvedIncompleteCommandIds) {
    resolvedIncompleteCommandIds.add(commandRequestId);
  }
  const boundedReadOnlyResolution = resolveBoundedReadOnlyFilePollUncertainty({
    input,
    commandJournal,
    evidence,
  });
  const boundedReadOnlyCommandIds = new Set(
    boundedReadOnlyResolution.uncertainties.map((uncertainty) => uncertainty.commandRequestId)
  );
  for (const bundle of evidence) {
    if (bundle.complete || resolvedIncompleteCommandIds.has(bundle.commandRequestId)) {
      continue;
    }
    if (boundedReadOnlyCommandIds.has(bundle.commandRequestId)) {
      issues.push({
        code: 'validation_failed',
        blocking: false,
        message: `Read-only File task activity ${bundle.commandRequestId} is bounded to 0–1 network requests and 0–2 cache hits; the exact historical counts are unavailable.`,
        details: {
          evidenceId: bundle.id,
          commandRequestId: bundle.commandRequestId,
          operationKind: bundle.operationKind,
          minimumNetworkRequests: 0,
          maximumNetworkRequests: 1,
          minimumCacheHits: 0,
          maximumCacheHits: 2,
        },
      });
    } else {
      issues.push(
        blockingValidation(
          `Provider activity evidence for ${bundle.operationKind} is incomplete; request counts are only a lower bound.`,
          { evidenceId: bundle.id, commandRequestId: bundle.commandRequestId }
        )
      );
    }
  }

  const networkRequestsByClass = emptyProviderRequestClassCounts();
  const cacheHitsByClass = emptyProviderRequestClassCounts();
  let networkRequests = 0;
  let cacheHits = 0;
  for (const bundle of evidence) {
    for (const observation of bundle.observations) {
      if (observation.kind === 'network_request') {
        networkRequests += 1;
        networkRequestsByClass[observation.requestClass] += 1;
      } else if (observation.kind === 'cache_hit') {
        cacheHits += 1;
        cacheHitsByClass[observation.requestClass] += 1;
      }
    }
  }
  for (const resolution of reconciliationResolution.resolutions) {
    if (!resolution.addsHistoricalExportSubmit) continue;
    networkRequests += 1;
    networkRequestsByClass.export_submit += 1;
    exportSubmitPostsByJob.set(
      resolution.exportJobId,
      (exportSubmitPostsByJob.get(resolution.exportJobId) ?? 0) + 1
    );
  }
  if (input.providerActivityRequired === true) {
    for (const [exportJobId, postCount] of exportSubmitPostsByJob) {
      if (postCount > 1) {
        issues.push(
          blockingInvariant(
            `Export job ${exportJobId} has ${postCount} native export submission POSTs across observed and reconciled evidence; at most one is permitted.`
          )
        );
      }
    }
  }
  const networkRequestUpperBoundsByClass = { ...networkRequestsByClass };
  const cacheHitUpperBoundsByClass = { ...cacheHitsByClass };
  let networkRequestUpperBound = networkRequests;
  let cacheHitUpperBound = cacheHits;
  for (const uncertainty of boundedReadOnlyResolution.uncertainties) {
    networkRequestUpperBound += uncertainty.maximumNetworkRequests;
    cacheHitUpperBound += uncertainty.maximumCacheHits;
    networkRequestUpperBoundsByClass[uncertainty.requestClass] +=
      uncertainty.maximumNetworkRequests;
    cacheHitUpperBoundsByClass.export_task_status +=
      uncertainty.maximumCacheHitsByClass.export_task_status;
    cacheHitUpperBoundsByClass.gmail_receipt_page +=
      uncertainty.maximumCacheHitsByClass.gmail_receipt_page;
  }
  let matchedCompleteCommands = validCompleteCount;
  let unmatchedCommands = 0;
  if (input.providerActivityRequired === true) {
    matchedCompleteCommands = 0;
    const evidenceByRequestId = new Map(
      evidence.map((bundle) => [bundle.commandRequestId, bundle])
    );
    const commandsByRequestId = new Map(
      commandJournal.map((command) => [command.commandRequestId, command])
    );
    for (const command of commandJournal) {
      const bundle = evidenceByRequestId.get(command.commandRequestId);
      if (
        !bundle ||
        bundle.operationKind !== command.operationKind ||
        (!bundle.complete &&
          !resolvedIncompleteCommandIds.has(command.commandRequestId) &&
          !boundedReadOnlyCommandIds.has(command.commandRequestId))
      ) {
        unmatchedCommands += 1;
        issues.push(
          blockingValidation(
            `Provider command ${command.commandRequestId} has no complete matching activity evidence.`,
            {
              commandRequestId: command.commandRequestId,
              operationKind: command.operationKind,
            }
          )
        );
      } else {
        matchedCompleteCommands += 1;
      }
    }
    for (const bundle of evidence) {
      if (!commandsByRequestId.has(bundle.commandRequestId)) {
        issues.push(
          blockingValidation(
            `Provider activity ${bundle.commandRequestId} has no durable pre-dispatch command record.`,
            { commandRequestId: bundle.commandRequestId, operationKind: bundle.operationKind }
          )
        );
      }
    }
  }

  const expectedEvidence =
    input.providerActivityRequired === true
      ? Math.max(commandCandidates.length, candidates.length, 1)
      : candidates.length + (missingRequiredEvidence ? 1 : 0);
  const actualEvidence =
    input.providerActivityRequired === true ? matchedCompleteCommands : validCompleteCount;
  const deduplicatedIssues = deduplicateIssues(issues);
  const unboundedCoverageGaps = deduplicatedIssues.filter((issue) => issue.blocking).length;
  const coverageGaps = unboundedCoverageGaps + boundedReadOnlyResolution.uncertainties.length;
  return {
    ...section(expectedEvidence, actualEvidence, deduplicatedIssues),
    issuedCommands: commandJournal.length,
    unmatchedCommands,
    networkRequests,
    cacheHits,
    coverageGaps,
    countsAreExact: coverageGaps === 0,
    countsAreBounded: unboundedCoverageGaps === 0,
    networkRequestUpperBound,
    cacheHitUpperBound,
    unboundedCoverageGaps,
    networkRequestsByClass,
    cacheHitsByClass,
    networkRequestUpperBoundsByClass,
    cacheHitUpperBoundsByClass,
    evidence,
    commandJournal,
    reconciliationResolutions: reconciliationResolution.resolutions.map((resolution) => ({
      exportJobId: resolution.exportJobId,
      originalCommandRequestId: resolution.originalCommandRequestId,
      reconciliationCommandRequestId: resolution.reconciliationCommandRequestId,
      settlementId: resolution.settlementId,
      basis: resolution.basis,
      accountedHistoricalExportSubmitRequests: resolution.addsHistoricalExportSubmit ? 1 : 0,
    })),
    opaqueRedirectResolutions: opaqueRedirectResolution.resolutions,
    readOnlyCountUncertainties: boundedReadOnlyResolution.uncertainties,
  };
}

function resolveOpaqueRedirectMetadataRead({
  input,
  commandJournal,
  evidence,
}: {
  input: GenerateValidationReportInput;
  commandJournal: ProviderCommandJournalEntry[];
  evidence: ProviderActivityBundle[];
}): {
  resolvedIncompleteCommandIds: Set<string>;
  resolutions: NonNullable<
    NonNullable<ValidationReportV2['providerActivity']>['opaqueRedirectResolutions']
  >;
} {
  const unresolved = () => ({
    resolvedIncompleteCommandIds: new Set<string>(),
    resolutions: [],
  });
  if (
    input.providerActivityRequired !== true ||
    input.run.scope.kind !== 'file' ||
    input.exportJobs.length !== 1
  ) {
    return unresolved();
  }
  const [job] = input.exportJobs;
  const confirmation = input.gmailReceiptConfirmations?.find(
    (candidate) =>
      candidate.id === job?.receiptConfirmationId &&
      candidate.runId === input.run.id &&
      candidate.jobId === job?.id &&
      candidate.receiptId === job?.receiptId &&
      candidate.matchSignature === job?.matchSignature &&
      candidate.downloadUrlHash === job?.downloadUrlHash &&
      candidate.basis === 'explicit_user_confirmation'
  );
  const matchingInspections = input.exportInspections.filter(
    (inspection) =>
      inspection.runId === input.run.id &&
      inspection.jobId === job?.id &&
      inspection.receiptId === job?.receiptId &&
      inspection.downloadUrlHash === job?.downloadUrlHash &&
      Number.isSafeInteger(inspection.compressedArchiveBytes) &&
      inspection.compressedArchiveBytes > 0 &&
      Number.isSafeInteger(inspection.rangeRequestCount) &&
      inspection.rangeRequestCount > 0 &&
      Number.isSafeInteger(inspection.rangeBytesRead) &&
      inspection.rangeBytesRead > 0 &&
      Number.isFinite(Date.parse(inspection.inspectedAt))
  );
  if (
    !job ||
    job.receiptSource !== 'gmail' ||
    !job.receiptId ||
    !job.downloadUrlHash ||
    !job.receiptConfirmationId ||
    !confirmation ||
    !hasExactlyOneExactGmailReceiptConfirmation(input, job) ||
    input.exportInspections.length !== 1 ||
    matchingInspections.length !== 1
  ) {
    return unresolved();
  }
  const [inspection] = matchingInspections;
  const commandByRequestId = new Map(
    commandJournal.map((command) => [command.commandRequestId, command] as const)
  );
  const successfulMetadataReads = evidence.filter((bundle) => {
    const command = commandByRequestId.get(bundle.commandRequestId);
    return (
      bundle.operationKind === 'inspect_export' &&
      bundle.complete === true &&
      exactSuccessfulMetadataGetObservations(bundle.observations) &&
      command?.operationKind === 'inspect_export' &&
      Date.parse(command.issuedAt) <= Date.parse(bundle.observedAt) &&
      Date.parse(inspection.inspectedAt) >= Date.parse(bundle.observedAt)
    );
  });
  const historicalMetadataReads = evidence.filter((bundle) => {
    const command = commandByRequestId.get(bundle.commandRequestId);
    const [observation] = bundle.observations;
    const observedAt = Date.parse(bundle.observedAt);
    return (
      bundle.operationKind === 'inspect_export' &&
      bundle.complete === false &&
      bundle.observations.length === 1 &&
      command?.operationKind === 'inspect_export' &&
      Date.parse(command.issuedAt) <= observedAt &&
      observation?.kind === 'network_request' &&
      observation.requestClass === 'export_archive_metadata' &&
      observation.providerSurface === 'benchling_tenant' &&
      (observation.method === 'HEAD' || observation.method === 'GET') &&
      observation.result === 'transport_error' &&
      observation.statusClass === null
    );
  });
  const historicalHeads = historicalMetadataReads.filter(
    (bundle) => bundle.observations[0]?.method === 'HEAD'
  );
  const historicalGets = historicalMetadataReads.filter(
    (bundle) => bundle.observations[0]?.method === 'GET'
  );
  if (
    historicalMetadataReads.length < 1 ||
    historicalHeads.length > MAX_HISTORICAL_METADATA_HEAD_GAPS ||
    historicalGets.length > MAX_HISTORICAL_METADATA_GET_GAPS ||
    successfulMetadataReads.length !== 1
  ) {
    return unresolved();
  }
  const orderedHistorical = [...historicalMetadataReads].sort(
    (left, right) =>
      Date.parse(left.observedAt) - Date.parse(right.observedAt) ||
      left.commandRequestId.localeCompare(right.commandRequestId)
  );
  const [successor] = successfulMetadataReads;
  const successorCommand = commandByRequestId.get(successor.commandRequestId);
  const lastHistorical = orderedHistorical.at(-1);
  const headIndex = orderedHistorical.findIndex(
    (bundle) => bundle.observations[0]?.method === 'HEAD'
  );
  const historicalPrefixIsSerialized = orderedHistorical.every((bundle, index) => {
    const command = commandByRequestId.get(bundle.commandRequestId);
    const previous = orderedHistorical[index - 1];
    return (
      command !== undefined &&
      Date.parse(command.issuedAt) <= Date.parse(bundle.observedAt) &&
      (previous === undefined || Date.parse(previous.observedAt) < Date.parse(command.issuedAt))
    );
  });
  if (
    !successorCommand ||
    !lastHistorical ||
    !historicalPrefixIsSerialized ||
    (headIndex > 0 && historicalHeads.length > 0) ||
    Date.parse(successorCommand.issuedAt) <= Date.parse(lastHistorical.observedAt) ||
    Date.parse(successor.observedAt) < Date.parse(successorCommand.issuedAt)
  ) {
    return unresolved();
  }
  return {
    resolvedIncompleteCommandIds: new Set(
      orderedHistorical.map((historical) => historical.commandRequestId)
    ),
    resolutions: orderedHistorical.map((historical) => ({
      exportJobId: job.id,
      originalCommandRequestId: historical.commandRequestId,
      successorCommandRequestId: successor.commandRequestId,
      receiptConfirmationId: confirmation.id,
      basis: 'confirmed_gmail_bounded_metadata_get',
      accountedHistoricalNetworkRequests: 0,
    })),
  };
}

function resolveBoundedReadOnlyFilePollUncertainty({
  input,
  commandJournal,
  evidence,
}: {
  input: GenerateValidationReportInput;
  commandJournal: ProviderCommandJournalEntry[];
  evidence: ProviderActivityBundle[];
}): {
  uncertainties: ValidationProviderActivityReadOnlyCountUncertainty[];
} {
  const unresolved = () => ({ uncertainties: [] });
  if (
    input.providerActivityRequired !== true ||
    input.run.scope.kind !== 'file' ||
    input.exportJobs.length !== 1
  ) {
    return unresolved();
  }
  const [job] = input.exportJobs;
  if (
    !job ||
    job.runId !== input.run.id ||
    job.state !== 'captured' ||
    job.receiptSource !== 'gmail' ||
    !job.receiptId ||
    !job.downloadUrlHash ||
    !job.receiptConfirmationId ||
    !job.snapshotPartId ||
    !hasExactlyOneExactGmailReceiptConfirmation(input, job)
  ) {
    return unresolved();
  }
  const matchingCaptures = input.exportCaptures.filter(
    (capture) =>
      capture.jobId === job.id &&
      capture.runId === input.run.id &&
      capture.snapshotId === input.snapshot.id &&
      capture.archiveManifestId.trim() !== ''
  );
  const matchingInspections = input.exportInspections.filter(
    (inspection) =>
      inspection.jobId === job.id &&
      inspection.runId === input.run.id &&
      inspection.receiptId === job.receiptId &&
      inspection.downloadUrlHash === job.downloadUrlHash &&
      Number.isSafeInteger(inspection.compressedArchiveBytes) &&
      inspection.compressedArchiveBytes > 0 &&
      Number.isSafeInteger(inspection.rangeRequestCount) &&
      inspection.rangeRequestCount > 0 &&
      Number.isSafeInteger(inspection.rangeBytesRead) &&
      inspection.rangeBytesRead > 0 &&
      Number.isFinite(Date.parse(inspection.inspectedAt))
  );
  const matchingSnapshotParts = input.snapshot.parts.filter(
    (part) =>
      part.id === job.snapshotPartId &&
      part.kind === 'export_archive' &&
      part.sourceJobId === job.id
  );
  if (
    input.exportCaptures.length !== 1 ||
    matchingCaptures.length !== 1 ||
    input.exportInspections.length !== 1 ||
    matchingInspections.length !== 1 ||
    matchingSnapshotParts.length !== 1
  ) {
    return unresolved();
  }

  const commandByRequestId = new Map(
    commandJournal.map((command) => [command.commandRequestId, command] as const)
  );
  const gaps = evidence
    .filter((bundle) => {
      const command = commandByRequestId.get(bundle.commandRequestId);
      return (
        bundle.operationKind === 'poll_export_receipts' &&
        bundle.complete === false &&
        bundle.observations.length === 0 &&
        command?.operationKind === 'poll_export_receipts' &&
        Date.parse(command.issuedAt) <= Date.parse(bundle.observedAt)
      );
    })
    .sort(
      (left, right) =>
        Date.parse(left.observedAt) - Date.parse(right.observedAt) ||
        left.commandRequestId.localeCompare(right.commandRequestId)
    );
  if (gaps.length < 1 || gaps.length > MAX_BOUNDED_FILE_TASK_POLL_GAPS) {
    return unresolved();
  }
  const gapsAreSerialized = gaps.every((gap, index) => {
    const command = commandByRequestId.get(gap.commandRequestId);
    const previous = gaps[index - 1];
    return (
      command !== undefined &&
      Date.parse(command.issuedAt) <= Date.parse(gap.observedAt) &&
      (previous === undefined || Date.parse(previous.observedAt) < Date.parse(command.issuedAt))
    );
  });
  if (!gapsAreSerialized) return unresolved();

  const successfulPolls = evidence
    .filter((bundle) => {
      const command = commandByRequestId.get(bundle.commandRequestId);
      return (
        bundle.operationKind === 'poll_export_receipts' &&
        bundle.complete === true &&
        hasExactSuccessfulTaskStatusGet(bundle) &&
        command?.operationKind === 'poll_export_receipts' &&
        Date.parse(command.issuedAt) <= Date.parse(bundle.observedAt)
      );
    })
    .sort(
      (left, right) =>
        Date.parse(left.observedAt) - Date.parse(right.observedAt) ||
        left.commandRequestId.localeCompare(right.commandRequestId)
    );
  const uncertainties: ValidationProviderActivityReadOnlyCountUncertainty[] = [];
  for (const gap of gaps) {
    const successor = successfulPolls.find((candidate) => {
      const command = commandByRequestId.get(candidate.commandRequestId);
      return command !== undefined && Date.parse(command.issuedAt) > Date.parse(gap.observedAt);
    });
    if (!successor) return unresolved();
    uncertainties.push({
      exportJobId: job.id,
      commandRequestId: gap.commandRequestId,
      successorCommandRequestId: successor.commandRequestId,
      receiptConfirmationId: job.receiptConfirmationId,
      operationKind: 'poll_export_receipts',
      requestClass: 'export_task_status',
      basis: 'bounded_single_file_task_status_read',
      minimumNetworkRequests: 0,
      maximumNetworkRequests: 1,
      minimumCacheHits: 0,
      maximumCacheHits: 2,
      maximumCacheHitsByClass: {
        export_task_status: 1,
        gmail_receipt_page: 1,
      },
    });
  }
  return { uncertainties };
}

function hasExactSuccessfulTaskStatusGet(bundle: ProviderActivityBundle): boolean {
  if (bundle.observations.length < 1 || bundle.observations.length > 2) return false;
  const [taskStatus, gmailRead] = bundle.observations;
  const exactTaskStatus =
    taskStatus?.ordinal === 0 &&
    taskStatus.kind === 'network_request' &&
    taskStatus.requestClass === 'export_task_status' &&
    taskStatus.providerSurface === 'benchling_tenant' &&
    taskStatus.method === 'GET' &&
    taskStatus.result === 'response' &&
    taskStatus.statusClass === '2xx';
  if (!exactTaskStatus) return false;
  if (gmailRead === undefined) return true;
  return (
    gmailRead.ordinal === 1 &&
    gmailRead.requestClass === 'gmail_receipt_page' &&
    gmailRead.providerSurface === 'gmail_web' &&
    gmailRead.method === 'READ' &&
    ((gmailRead.kind === 'cache_hit' && gmailRead.cacheLayer === 'browser_page') ||
      (gmailRead.kind === 'local_miss' && gmailRead.reason === 'receipt_not_open'))
  );
}

function exactSuccessfulMetadataGetObservations(
  observations: ProviderActivityBundle['observations']
): boolean {
  if (observations.length < 1 || observations.length > MAX_PROTECTED_EXPORT_REDIRECTS + 1) {
    return false;
  }
  return observations.every((observation, index) => {
    if (
      observation.kind !== 'network_request' ||
      observation.ordinal !== index ||
      observation.requestClass !== 'export_archive_metadata' ||
      observation.method !== 'GET' ||
      observation.result !== 'response'
    ) {
      return false;
    }
    const terminal = index === observations.length - 1;
    if (!terminal) {
      return (
        observation.providerSurface === 'benchling_tenant' && observation.statusClass === '3xx'
      );
    }
    return (
      (observation.providerSurface === 'benchling_tenant' ||
        observation.providerSurface === 'benchling_temp_storage') &&
      observation.statusClass === '2xx'
    );
  });
}

function validProviderActivityObservation(
  observation: ProviderActivityBundle['observations'][number],
  expectedOrdinal: number,
  operationKind: ProviderActivityOperationKind
): boolean {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) return false;
  if (
    observation.ordinal !== expectedOrdinal ||
    !PROVIDER_REQUEST_CLASSES.includes(observation.requestClass) ||
    !PROVIDER_ACTIVITY_SURFACES.has(observation.providerSurface) ||
    !PROVIDER_ACTIVITY_METHODS.has(observation.method) ||
    !PROVIDER_ACTIVITY_CLASSES_BY_OPERATION[operationKind]?.has(observation.requestClass) ||
    !PROVIDER_ACTIVITY_REQUEST_SHAPES[observation.requestClass]?.has(
      `${observation.providerSurface}:${observation.method}`
    )
  ) {
    return false;
  }
  const cacheLayer = observation.kind === 'cache_hit' ? observation.cacheLayer : null;
  const gmailPageShape =
    observation.kind === 'cache_hit' &&
    observation.requestClass === 'gmail_receipt_page' &&
    observation.providerSurface === 'gmail_web' &&
    observation.method === 'READ' &&
    (cacheLayer === 'browser_page' ||
      (operationKind === 'recover_export_receipt' && cacheLayer === 'extension_memory'));
  const gmailLocalMissShape =
    observation.kind === 'local_miss' &&
    ['poll_export_receipts', 'recover_export_receipt'].includes(operationKind) &&
    observation.requestClass === 'gmail_receipt_page' &&
    observation.providerSurface === 'gmail_web' &&
    observation.method === 'READ' &&
    observation.reason === 'receipt_not_open';
  const scopedProviderFreeMissShape =
    observation.kind === 'local_miss' &&
    operationKind === 'discover_scoped_folder_page' &&
    observation.requestClass === 'folder_scope_discovery' &&
    observation.providerSurface === 'benchling_tenant' &&
    observation.method === 'POST' &&
    (observation.reason === 'traversal_authority_missing' ||
      observation.reason === 'provider_pre_dispatch_blocked');
  const containsGmailPageField =
    observation.requestClass === 'gmail_receipt_page' ||
    observation.providerSurface === 'gmail_web' ||
    observation.method === 'READ' ||
    cacheLayer === 'browser_page';
  if (containsGmailPageField && !gmailPageShape && !gmailLocalMissShape) return false;
  if (observation.kind === 'network_request') {
    return (
      hasExactKeys(observation, [
        'ordinal',
        'kind',
        'requestClass',
        'providerSurface',
        'method',
        'result',
        'statusClass',
      ]) &&
      ['response', 'transport_error'].includes(observation.result) &&
      (observation.statusClass === null ||
        PROVIDER_ACTIVITY_STATUS_CLASSES.has(observation.statusClass)) &&
      ((observation.result === 'transport_error' && observation.statusClass === null) ||
        (observation.result === 'response' && observation.statusClass !== null))
    );
  }
  if (observation.kind === 'local_miss') {
    return (
      (gmailLocalMissShape || scopedProviderFreeMissShape) &&
      hasExactKeys(observation, [
        'ordinal',
        'kind',
        'requestClass',
        'providerSurface',
        'method',
        'reason',
      ])
    );
  }
  return (
    observation.kind === 'cache_hit' &&
    hasExactKeys(observation, [
      'ordinal',
      'kind',
      'requestClass',
      'providerSurface',
      'method',
      'cacheLayer',
      ...(observation.filterSummary === undefined ? [] : ['filterSummary']),
    ]) &&
    PROVIDER_ACTIVITY_CACHE_LAYERS.has(observation.cacheLayer) &&
    (observation.cacheLayer !== 'main_process_memory' ||
      observation.requestClass === 'targeted_read') &&
    (observation.cacheLayer !== 'browser_page' ||
      observation.requestClass === 'gmail_receipt_page') &&
    (observation.requestClass !== 'gmail_receipt_page' ||
      observation.cacheLayer === 'browser_page' ||
      (operationKind === 'recover_export_receipt' &&
        observation.cacheLayer === 'extension_memory')) &&
    (observation.filterSummary === undefined ||
      (observation.requestClass === 'gmail_receipt_page' &&
        observation.providerSurface === 'gmail_web' &&
        observation.method === 'READ' &&
        observation.cacheLayer === 'browser_page' &&
        validGmailReceiptFilterSummary(observation.filterSummary)))
  );
}

function validGmailReceiptFilterSummary(input: unknown): boolean {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ['schema', 'rejected', 'countsAreExact']) ||
    input.schema !== GMAIL_RECEIPT_FILTER_SUMMARY_SCHEMA ||
    typeof input.countsAreExact !== 'boolean' ||
    !isRecord(input.rejected) ||
    !hasExactKeys(input.rejected, GMAIL_RECEIPT_FILTER_STAGES)
  ) {
    return false;
  }
  const rejected = input.rejected;
  const counts = GMAIL_RECEIPT_FILTER_STAGES.map((stage) => rejected[stage]);
  return (
    counts.some((count) => count !== 0) &&
    counts.every(
      (count) =>
        Number.isSafeInteger(count) &&
        Number(count) >= 0 &&
        Number(count) <= MAX_GMAIL_RECEIPT_FILTER_COUNT
    ) &&
    (input.countsAreExact === true ||
      counts.some((count) => count === MAX_GMAIL_RECEIPT_FILTER_COUNT))
  );
}

type ValidNativeExportReconciliationResolution = {
  originalCommandRequestId: string;
  reconciliationCommandRequestId: string;
  settlementId: string;
  exportJobId: string;
  basis: 'durable_extension_ledger';
  addsHistoricalExportSubmit: boolean;
  resolvedUndispatchedReconciliationCommandIds: string[];
};

function validateNativeExportReconciliationResolutions(input: {
  input: GenerateValidationReportInput;
  commandJournal: ProviderCommandJournalEntry[];
  evidence: ProviderActivityBundle[];
  issues: MigrationIssue[];
}): {
  resolvedIncompleteCommandIds: Set<string>;
  resolutions: ValidNativeExportReconciliationResolution[];
} {
  const settlements = [...(input.input.nativeExportReconciliations ?? [])].sort(
    (left, right) =>
      Date.parse(String(left.observedAt)) - Date.parse(String(right.observedAt)) ||
      String(left.id).localeCompare(String(right.id))
  );
  const commandByRequestId = new Map(
    input.commandJournal.map((command) => [command.commandRequestId, command] as const)
  );
  const activityByRequestId = new Map(
    input.evidence.map((bundle) => [bundle.commandRequestId, bundle] as const)
  );
  const jobById = new Map(input.input.exportJobs.map((job) => [job.id, job] as const));
  const seenIds = new Set<string>();
  const seenReconciliationCommands = new Set<string>();
  const validByOriginal = new Map<string, ValidNativeExportReconciliationResolution[]>();

  for (const [index, settlement] of settlements.entries()) {
    const original = commandByRequestId.get(String(settlement.originalCommandRequestId));
    const reconciliation = commandByRequestId.get(
      String(settlement.reconciliationCommandRequestId)
    );
    const originalActivity = activityByRequestId.get(String(settlement.originalCommandRequestId));
    const reconciliationActivity = activityByRequestId.get(
      String(settlement.reconciliationCommandRequestId)
    );
    const job = jobById.get(String(settlement.exportJobId));
    const sameJobTaskEvidence = (input.input.providerTaskEvidence ?? []).filter(
      (candidate) => candidate.jobId === settlement.exportJobId
    );
    const orderedReconciliationCommands = input.commandJournal
      .filter(
        (candidate) =>
          candidate.operationKind === 'reconcile_export_submission' &&
          candidate.exportJobId === settlement.exportJobId
      )
      .sort(
        (left, right) =>
          Date.parse(left.issuedAt) - Date.parse(right.issuedAt) ||
          left.commandRequestId.localeCompare(right.commandRequestId)
      );
    const settlementCommandIndex = reconciliation
      ? orderedReconciliationCommands.findIndex(
          (candidate) => candidate.commandRequestId === reconciliation.commandRequestId
        )
      : -1;
    const undispatchedReconciliationPrefix =
      settlementCommandIndex < 0
        ? []
        : orderedReconciliationCommands.slice(0, settlementCommandIndex);
    const undispatchedReconciliationPrefixIsExact =
      originalActivity !== undefined &&
      reconciliation !== undefined &&
      settlementCommandIndex === orderedReconciliationCommands.length - 1 &&
      undispatchedReconciliationPrefix.every((candidate, prefixIndex, prefix) => {
        const activity = activityByRequestId.get(candidate.commandRequestId);
        const previous = prefix[prefixIndex - 1];
        const previousActivity = previous
          ? activityByRequestId.get(previous.commandRequestId)
          : originalActivity;
        return (
          candidate.reconcilesCommandRequestId === settlement.originalCommandRequestId &&
          candidate.nativeExportLedgerEpoch === settlement.nativeExportLedgerEpoch &&
          activity?.operationKind === 'reconcile_export_submission' &&
          activity.complete === false &&
          activity.observations.length === 0 &&
          previousActivity !== undefined &&
          Date.parse(previousActivity.observedAt) < Date.parse(candidate.issuedAt) &&
          Date.parse(candidate.issuedAt) <= Date.parse(activity.observedAt) &&
          Date.parse(activity.observedAt) < Date.parse(reconciliation.issuedAt) &&
          Number(candidate.explicitResumeAttempt) < Number(reconciliation.explicitResumeAttempt) &&
          (previous === undefined ||
            Number(previous.explicitResumeAttempt) < Number(candidate.explicitResumeAttempt))
        );
      });
    const observation = reconciliationActivity?.observations[0];
    const exactDispatch =
      settlement.disposition === 'dispatched' &&
      settlement.priorLedgerState === 'absent' &&
      sameJobTaskEvidence.every(
        (candidate) =>
          Number.isFinite(Date.parse(candidate.observedAt)) &&
          Date.parse(candidate.observedAt) >= Date.parse(String(settlement.observedAt))
      ) &&
      reconciliationActivity?.complete === true &&
      reconciliationActivity.observations.length === 1 &&
      observation?.kind === 'network_request' &&
      observation.requestClass === 'export_submit' &&
      observation.providerSurface === 'benchling_tenant' &&
      observation.method === 'POST' &&
      observation.result === 'response' &&
      observation.statusClass === '2xx';
    const exactCacheHit =
      settlement.disposition === 'cache_hit' &&
      ['accepted', 'polling', 'succeeded', 'action_required'].includes(
        String(settlement.priorLedgerState)
      ) &&
      reconciliationActivity?.complete === true &&
      reconciliationActivity.observations.length === 1 &&
      observation?.kind === 'cache_hit' &&
      observation.requestClass === 'export_submit' &&
      observation.providerSurface === 'benchling_tenant' &&
      observation.method === 'POST' &&
      observation.cacheLayer === 'extension_session' &&
      originalActivity !== undefined &&
      sameJobTaskEvidence.every(
        (candidate) =>
          Number.isFinite(Date.parse(candidate.observedAt)) &&
          Date.parse(candidate.observedAt) >= Date.parse(originalActivity.observedAt)
      );
    const exactKeys = hasExactKeys(settlement, [
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
    ]);
    const chronologyIsValid =
      original !== undefined &&
      originalActivity !== undefined &&
      reconciliation !== undefined &&
      reconciliationActivity !== undefined &&
      Date.parse(original.issuedAt) <= Date.parse(originalActivity.observedAt) &&
      Date.parse(originalActivity.observedAt) < Date.parse(reconciliation.issuedAt) &&
      Date.parse(reconciliation.issuedAt) <= Date.parse(reconciliationActivity.observedAt) &&
      Date.parse(reconciliationActivity.observedAt) <= Date.parse(String(settlement.observedAt));
    const valid =
      exactKeys &&
      settlement.schema === 'dnaforge.benchling.native-export-reconciliation.v1' &&
      PROVIDER_ACTIVITY_ID.test(String(settlement.id)) &&
      settlement.runId === input.input.run.id &&
      !seenIds.has(settlement.id) &&
      !seenReconciliationCommands.has(settlement.reconciliationCommandRequestId) &&
      Number.isFinite(Date.parse(String(settlement.observedAt))) &&
      /^native-ledger-epoch:[a-f0-9]{32}$/u.test(String(settlement.nativeExportLedgerEpoch)) &&
      Number.isSafeInteger(settlement.explicitResumeAttempt) &&
      settlement.explicitResumeAttempt >= 1 &&
      /^sha256:[a-f0-9]{64}$/u.test(String(settlement.interventionSha256)) &&
      job?.runId === input.input.run.id &&
      job.matchSignature === settlement.matchSignature &&
      original?.operationKind === 'submit_export' &&
      original.exportJobId === settlement.exportJobId &&
      original.nativeExportLedgerEpoch === settlement.nativeExportLedgerEpoch &&
      reconciliation?.operationKind === 'reconcile_export_submission' &&
      reconciliation.exportJobId === settlement.exportJobId &&
      reconciliation.reconcilesCommandRequestId === settlement.originalCommandRequestId &&
      reconciliation.nativeExportLedgerEpoch === settlement.nativeExportLedgerEpoch &&
      reconciliation.explicitResumeAttempt === settlement.explicitResumeAttempt &&
      reconciliation.interventionSha256 === settlement.interventionSha256 &&
      originalActivity?.operationKind === 'submit_export' &&
      originalActivity.complete === false &&
      originalActivity.observations.length === 0 &&
      undispatchedReconciliationPrefixIsExact &&
      chronologyIsValid &&
      settlement.accepted === true &&
      (exactDispatch || exactCacheHit);
    seenIds.add(String(settlement.id));
    seenReconciliationCommands.add(String(settlement.reconciliationCommandRequestId));
    if (!valid) {
      input.issues.push(
        blockingInvariant(`Native export reconciliation record ${index + 1} is malformed.`)
      );
      continue;
    }
    const candidates = validByOriginal.get(settlement.originalCommandRequestId) ?? [];
    candidates.push({
      originalCommandRequestId: settlement.originalCommandRequestId,
      reconciliationCommandRequestId: settlement.reconciliationCommandRequestId,
      settlementId: settlement.id,
      exportJobId: settlement.exportJobId,
      basis: 'durable_extension_ledger',
      addsHistoricalExportSubmit: exactCacheHit,
      resolvedUndispatchedReconciliationCommandIds: undispatchedReconciliationPrefix.map(
        (candidate) => candidate.commandRequestId
      ),
    });
    validByOriginal.set(settlement.originalCommandRequestId, candidates);
  }

  const resolved = new Set<string>();
  const resolutions: ValidNativeExportReconciliationResolution[] = [];
  for (const [originalCommandRequestId, candidates] of validByOriginal) {
    if (candidates.length !== 1) {
      input.issues.push(
        blockingInvariant(
          `Provider command ${originalCommandRequestId} has duplicate reconciliation settlements.`
        )
      );
      continue;
    }
    const resolution = candidates[0];
    if (!resolution) continue;
    resolved.add(originalCommandRequestId);
    for (const commandRequestId of resolution.resolvedUndispatchedReconciliationCommandIds) {
      resolved.add(commandRequestId);
    }
    resolutions.push(resolution);
  }
  return { resolvedIncompleteCommandIds: resolved, resolutions };
}

function sanitizeProviderActivityObservation(
  observation: ProviderActivityBundle['observations'][number]
): ProviderActivityBundle['observations'][number] | null {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) return null;
  if (observation.kind === 'network_request') {
    return {
      ordinal: observation.ordinal,
      kind: observation.kind,
      requestClass: observation.requestClass,
      providerSurface: observation.providerSurface,
      method: observation.method,
      result: observation.result,
      statusClass: observation.statusClass,
    };
  }
  if (observation.kind === 'cache_hit') {
    return {
      ordinal: observation.ordinal,
      kind: observation.kind,
      requestClass: observation.requestClass,
      providerSurface: observation.providerSurface,
      method: observation.method,
      cacheLayer: observation.cacheLayer,
      ...(observation.filterSummary === undefined
        ? {}
        : {
            filterSummary: {
              schema: observation.filterSummary.schema,
              rejected: { ...observation.filterSummary.rejected },
              countsAreExact: observation.filterSummary.countsAreExact,
            },
          }),
    };
  }
  if (observation.kind === 'local_miss') {
    if (observation.requestClass === 'gmail_receipt_page') {
      return {
        ordinal: observation.ordinal,
        kind: observation.kind,
        requestClass: observation.requestClass,
        providerSurface: 'gmail_web',
        method: 'READ',
        reason: 'receipt_not_open',
      };
    }
    return {
      ordinal: observation.ordinal,
      kind: observation.kind,
      requestClass: observation.requestClass,
      providerSurface: 'benchling_tenant',
      method: 'POST',
      reason: observation.reason,
    };
  }
  return null;
}

function emptyProviderRequestClassCounts(): Record<ProviderRequestClass, number> {
  return Object.fromEntries(
    PROVIDER_REQUEST_CLASSES.map((requestClass) => [requestClass, 0])
  ) as Record<ProviderRequestClass, number>;
}

function hasExactKeys(value: object, expectedKeys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function replacementLineageSucceeded(
  failedJobId: string,
  jobsById: ReadonlyMap<string, ExportJob>,
  replacementsByJob: ReadonlyMap<string, PersistedExportJobReplacement>,
  visiting = new Set<string>()
): boolean {
  if (visiting.has(failedJobId)) return false;
  const replacement = replacementsByJob.get(failedJobId);
  if (!replacement || replacement.replacementJobIds.length === 0) return false;
  const nextVisiting = new Set(visiting).add(failedJobId);
  return replacement.replacementJobIds.every((replacementJobId) => {
    const replacementJob = jobsById.get(replacementJobId);
    if (!replacementJob) return false;
    if (replacementJob.state === 'captured') return true;
    if (replacementJob.state !== 'failed') return false;
    return replacementLineageSucceeded(
      replacementJob.id,
      jobsById,
      replacementsByJob,
      nextVisiting
    );
  });
}

function validateSnapshotParts(
  input: GenerateValidationReportInput
): ValidationReportV2['snapshotParts'] {
  const parts = [...input.snapshot.parts].sort((left, right) => left.id.localeCompare(right.id));
  const partsById = uniqueMap(parts, (part) => part.id);
  const jobsById = uniqueMap(input.exportJobs, (job) => job.id);
  const sourceObjectIds = new Set(input.sourceObjects.map((sourceObject) => sourceObject.id));
  const successorCounts = countValues(
    parts.map((part) => part.supersedesPartId).filter((partId): partId is string => partId !== null)
  );
  const issues: MigrationIssue[] = [];
  let validCount = 0;

  for (const part of parts) {
    const partIssues: MigrationIssue[] = [];
    if (!SHA256_HEX.test(part.sha256) || part.sizeBytes < 0 || !Number.isInteger(part.sizeBytes)) {
      partIssues.push(
        blockingValidation(`Snapshot part ${part.id} has invalid immutable blob evidence.`, {
          partId: part.id,
        })
      );
    }
    if (!Number.isFinite(Date.parse(part.capturedAt))) {
      partIssues.push(blockingValidation(`Snapshot part ${part.id} has no valid capture time.`));
    }
    if (part.kind === 'local_export') {
      const artifact = localExportValidationArtifact(input.run);
      const artifactHash = artifact ? canonicalSha256Hex(artifact.sha256) : null;
      if (
        !isLocalBundleRun(input.run) ||
        !artifact ||
        part.sourceJobId !== null ||
        part.sourceObjectId !== null ||
        part.sha256 !== artifactHash ||
        part.sizeBytes !== artifact.sizeBytes
      ) {
        partIssues.push(
          blockingValidation(
            `Local export part ${part.id} does not match its immutable local artifact.`,
            { partId: part.id }
          )
        );
      }
    } else if (part.kind === 'export_archive') {
      const job = part.sourceJobId ? jobsById.get(part.sourceJobId) : undefined;
      if (!job || job.snapshotPartId !== part.id) {
        partIssues.push(
          blockingValidation(`Archive part ${part.id} is not bound to its export job.`, {
            partId: part.id,
            sourceJobId: part.sourceJobId,
          })
        );
      }
    } else if (part.kind === 'supplemental_local_export') {
      if (
        !isLocalBundleRun(input.run) ||
        part.sourceJobId !== null ||
        !part.sourceObjectId ||
        (!sourceObjectIds.has(part.sourceObjectId) &&
          !input.uninstalledSupplementalSourceIds?.has(part.sourceObjectId))
      ) {
        partIssues.push(
          blockingValidation(
            `Supplementary local-export part ${part.id} is not bound to one captured local object.`,
            { partId: part.id, sourceObjectId: part.sourceObjectId }
          )
        );
      }
    } else if (!part.sourceObjectId || !sourceObjectIds.has(part.sourceObjectId)) {
      partIssues.push(
        blockingValidation(`Targeted-read part ${part.id} has no captured source object.`, {
          partId: part.id,
          sourceObjectId: part.sourceObjectId,
        })
      );
    }
    if (part.supersedesPartId) {
      const predecessor = partsById.get(part.supersedesPartId);
      if (
        !predecessor ||
        predecessor.kind !== part.kind ||
        Date.parse(predecessor.capturedAt) >= Date.parse(part.capturedAt) ||
        (successorCounts.get(predecessor.id) ?? 0) !== 1
      ) {
        partIssues.push(
          blockingValidation(
            `Snapshot supersession ${part.id} -> ${part.supersedesPartId} is invalid.`,
            {
              partId: part.id,
              supersedesPartId: part.supersedesPartId,
            }
          )
        );
      }
    }
    if (!partIssues.some((issue) => issue.blocking)) validCount += 1;
    issues.push(...partIssues);
  }

  const capturedJobs = input.exportJobs.filter((job) => job.state === 'captured');
  for (const job of capturedJobs) {
    if (
      parts.filter((part) => part.kind === 'export_archive' && part.sourceJobId === job.id)
        .length !== 1
    ) {
      issues.push(
        blockingValidation(`Captured export ${job.id} must contribute exactly one snapshot part.`, {
          jobId: job.id,
        })
      );
    }
  }

  return {
    ...section(parts.length, validCount, deduplicateIssues(issues)),
    exportArchives: parts.filter((part) => part.kind === 'export_archive').length,
    targetedReads: parts.filter((part) => part.kind === 'targeted_read').length,
    localExports: parts.filter((part) => part.kind === 'local_export').length,
    supplementalLocalExports: parts.filter((part) => part.kind === 'supplemental_local_export')
      .length,
    superseded: parts.filter((part) => part.supersedesPartId !== null).length,
    parts: parts.map((part) => ({
      partId: part.id,
      kind: part.kind,
      sourceJobId: part.sourceJobId,
      sourceObjectId: part.sourceObjectId,
      sha256: part.sha256,
      sizeBytes: part.sizeBytes,
      capturedAt: part.capturedAt,
      supersedesPartId: part.supersedesPartId,
    })),
  };
}

function validateLocalExport(
  input: GenerateValidationReportInput
): NonNullable<ValidationReportV2['localExport']> | null {
  if (!isLocalBundleRun(input.run)) return null;
  const artifact = localExportValidationArtifact(input.run);
  if (!artifact) return null;

  const issues: MigrationIssue[] = [];
  const digest = canonicalSha256Hex(artifact.sha256);
  const localParts = input.snapshot.parts.filter((part) => part.kind === 'local_export');
  const providerEvidenceCounts = {
    exportJobs: input.exportJobs.length,
    exportCaptures: input.exportCaptures.length,
    exportInspections: input.exportInspections.length,
    exportJobReplacements: input.exportJobReplacements.length,
    gmailReceiptConfirmations: input.gmailReceiptConfirmations?.length ?? 0,
    providerTasks: input.providerTaskEvidence?.length ?? 0,
    providerActivity: input.providerActivityEvidence?.length ?? 0,
    providerCommands: input.providerCommandJournal?.length ?? 0,
    requestLedgerEntries: input.requestLedgerEntries?.length ?? 0,
    nativeExportReconciliations: input.nativeExportReconciliations?.length ?? 0,
  };
  let resourceBytes = 0;
  let resourcesValid = true;
  const resourceKeys = new Set<string>();
  for (const resource of artifact.resources) {
    const key = `${resource.sourceRef}\0${resource.relativePath}`;
    if (
      resourceKeys.has(key) ||
      !resource.sourceRef.trim() ||
      !resource.relativePath.trim() ||
      resource.relativePath.includes('\\') ||
      resource.relativePath.split('/').some((segment) => segment === '..') ||
      !resource.logicalFilename.trim() ||
      canonicalSha256Hex(resource.sha256) === null ||
      !Number.isSafeInteger(resource.sizeBytes) ||
      resource.sizeBytes < 0 ||
      !resource.mediaType.trim() ||
      !resource.immutableLocalPath.trim() ||
      resource.sizeBytes > Number.MAX_SAFE_INTEGER - resourceBytes
    ) {
      resourcesValid = false;
      continue;
    }
    resourceKeys.add(key);
    resourceBytes += resource.sizeBytes;
  }

  const artifactShapeValid =
    artifact.schema === 'dnaforge.benchling.local-export-artifact.v1' &&
    (artifact.format === 'zip' || artifact.format === 'html') &&
    artifact.logicalFilename.trim().length > 0 &&
    !/[\\/]/u.test(artifact.logicalFilename) &&
    !artifact.logicalFilename.includes('\0') &&
    digest !== null &&
    artifact.sha256 === `sha256:${digest}` &&
    Number.isSafeInteger(artifact.sizeBytes) &&
    artifact.sizeBytes > 0 &&
    Number.isFinite(Date.parse(artifact.capturedAt)) &&
    artifact.immutableLocalPath.trim().length > 0 &&
    ((artifact.format === 'zip' && artifact.archive !== null && artifact.resources.length === 0) ||
      (artifact.format === 'html' && artifact.archive === null));
  if (!artifactShapeValid || !resourcesValid) {
    issues.push(
      blockingValidation('The local export artifact metadata is malformed or incomplete.')
    );
  }

  const expectedSourceId = digest ? `local-export-${digest}` : null;
  const expectedSourceUrl = digest ? `urn:dnaforge:benchling-local-export:sha256:${digest}` : null;
  const scopeMatchesLocalArtifact =
    input.run.binding === null &&
    migrationRunSourceIdentityHash(input.run) === artifact.sha256 &&
    (input.run.scope.kind === 'file'
      ? input.run.scope.source.id === expectedSourceId &&
        input.run.scope.source.url === expectedSourceUrl
      : artifact.format === 'zip' &&
        (input.run.scope.kind === 'folder'
          ? input.run.scope.includeChildren === false
          : input.run.scope.includeChildren === true && input.run.scope.roots.length === 1));
  if (!scopeMatchesLocalArtifact) {
    issues.push(blockingValidation('The local export does not match its provider-free scope.'));
  }
  if (
    localParts.length !== 1 ||
    !digest ||
    localParts[0]?.sha256 !== digest ||
    localParts[0]?.sizeBytes !== artifact.sizeBytes ||
    localParts[0]?.sourceJobId !== null ||
    localParts[0]?.sourceObjectId !== null
  ) {
    issues.push(
      blockingValidation('The local export requires one exact immutable local snapshot part.')
    );
  }
  if (Object.values(providerEvidenceCounts).some((count) => count !== 0)) {
    issues.push(
      blockingInvariant('Provider-free local export contains provider acquisition evidence.', {
        ...providerEvidenceCounts,
      })
    );
  }
  if (input.providerActivityRequired === true) {
    issues.push(
      blockingInvariant('Provider activity cannot be required for a local export import.')
    );
  }
  for (const warning of input.snapshot.localExportWarnings ?? []) {
    issues.push({
      code: 'local_export_warning',
      message: warning,
      blocking: false,
    });
  }
  const inventory = input.snapshot.localNativeFolderZipInventory;
  const folderScope = input.run.scope.kind === 'folder' || input.run.scope.kind === 'folder_tree';
  if (folderScope) {
    const originalLocalPartIds = new Set(
      input.snapshot.parts.filter((part) => part.kind === 'local_export').map((part) => part.id)
    );
    const persistedLocalAttachmentEntryCount = input.archiveIntegrity.manifestEntries.filter(
      (entry) =>
        entry.sourceObjectId !== null &&
        entry.archivePartId !== null &&
        entry.entryPath.startsWith('local-bundle/') &&
        originalLocalPartIds.has(entry.archivePartId)
    ).length;
    const scope = input.run.scope;
    const expectedRootId =
      scope.kind === 'folder'
        ? scope.folder.id
        : scope.kind === 'folder_tree' && scope.roots.length === 1
          ? scope.roots[0]?.id
          : null;
    if (
      !isLocalNativeFolderZipInventory(inventory) ||
      inventory.canonicalObjects.importedTotal !== input.snapshot.expectedSourceObjectCount ||
      inventory.selectedAttachments.total !== persistedLocalAttachmentEntryCount ||
      (inventory.selectedAttachments.uniqueOwnerContentTotal !== undefined &&
        inventory.selectedAttachments.uniqueOwnerContentTotal !==
          input.snapshot.expectedAttachmentCount) ||
      inventory.canonicalObjects.importedMembershipTotal !==
        input.snapshot.expectedMembershipCount ||
      inventory.rootBinding.selectedStableFolderId !== expectedRootId
    ) {
      issues.push(
        blockingValidation(
          'The native Folder ZIP inventory does not match the persisted scope and snapshot counts.'
        )
      );
    }
  } else if (inventory !== undefined) {
    issues.push(blockingValidation('A File import cannot contain Folder ZIP inventory evidence.'));
  }

  return {
    ...section(1, issues.some((issue) => issue.blocking) ? 0 : 1, deduplicateIssues(issues)),
    evidence: {
      schema: 'dnaforge.benchling.local-export-validation.v1',
      format: artifact.format,
      logicalFilename: artifact.logicalFilename,
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
      resourceCount: artifact.resources.length,
      resourceBytes,
      networkRequests: 0,
      ...(folderScope && isLocalNativeFolderZipInventory(inventory)
        ? { nativeFolderZipInventory: inventory }
        : {}),
    },
  };
}

function localExportValidationArtifact(run: MigrationRun): MigrationRun['localExportArtifact'] {
  if (run.externalZipSource) {
    const source = run.externalZipSource;
    return {
      schema: 'dnaforge.benchling.local-export-artifact.v1',
      format: 'zip',
      logicalFilename: source.displayName,
      sha256: source.zipSha256,
      sizeBytes: source.sizeBytes,
      immutableLocalPath: source.originalPath,
      capturedAt: source.selectedAt,
      archive: {
        entryCount: run.externalZipEntries?.length ?? 0,
        totalCompressedEntryBytes: source.sizeBytes,
        totalUncompressedEntryBytes: (run.externalZipEntries ?? []).reduce(
          (total, entry) => total + entry.sizeBytes,
          0
        ),
      },
      resources: [],
    };
  }
  return run.localExportArtifact;
}

function validateFormulas(
  sourceObjects: readonly SourceObject[],
  receipts: readonly ProjectionReceipt[]
): ValidationReportV2['formulas'] {
  const expected = sourceObjects.flatMap((sourceObject) =>
    collectProjectionFormulaEvidence(sourceObject).map((entry) => ({
      sourceObjectId: sourceObject.id,
      ...entry,
    }))
  );
  const expectedByKey = uniqueMap(expected, formulaEvidenceKey);
  const evidence = receipts.flatMap((receipt) =>
    (receipt.formulaEvidence ?? []).map((entry) => ({
      sourceObjectId: receipt.sourceObjectId,
      receiptId: receipt.id,
      ...entry,
    }))
  );
  const evidenceCounts = countValues(evidence.map(formulaEvidenceKey));
  const issues: MigrationIssue[] = [];
  let validCount = 0;

  for (const expectedEntry of expected) {
    const key = formulaEvidenceKey(expectedEntry);
    const matching = evidence.filter((entry) => formulaEvidenceKey(entry) === key);
    if (matching.length !== 1) {
      issues.push({
        code: 'validation_failed',
        message: `Formula ${expectedEntry.locator} on ${expectedEntry.sourceObjectId} has ${matching.length} projection evidence records; exactly one is required.`,
        blocking: true,
        sourceObjectId: expectedEntry.sourceObjectId,
        details: { locator: expectedEntry.locator, formula: expectedEntry.formula },
      });
      continue;
    }
    const projected = matching[0];
    if (
      projected.compatibility !== expectedEntry.compatibility ||
      projected.stale !== expectedEntry.stale ||
      (projected.compatibility === 'supported' && projected.stale)
    ) {
      issues.push({
        code: 'validation_failed',
        message: `Formula ${expectedEntry.locator} has inconsistent compatibility evidence.`,
        blocking: true,
        sourceObjectId: expectedEntry.sourceObjectId,
      });
      continue;
    }
    validCount += 1;
  }
  for (const projected of evidence) {
    const key = formulaEvidenceKey(projected);
    if (!expectedByKey.has(key)) {
      issues.push({
        code: 'internal_invariant',
        message: `Formula evidence ${projected.locator} has no durable source formula.`,
        blocking: true,
        sourceObjectId: projected.sourceObjectId,
      });
    } else if ((evidenceCounts.get(key) ?? 0) > 1) {
      issues.push({
        code: 'internal_invariant',
        message: `Formula evidence ${projected.locator} is duplicated.`,
        blocking: true,
        sourceObjectId: projected.sourceObjectId,
      });
    }
  }

  for (const projected of evidence) {
    if (projected.compatibility === 'unsupported') {
      issues.push({
        code: 'validation_failed',
        message: `Unsupported formula ${projected.formula} is preserved without native recalculation.`,
        blocking: false,
        sourceObjectId: projected.sourceObjectId,
        details: { locator: projected.locator, stale: projected.stale },
      });
    }
    if (projected.stale) {
      issues.push({
        code: 'validation_failed',
        message: `Formula result at ${projected.locator} is preserved and visibly stale.`,
        blocking: false,
        sourceObjectId: projected.sourceObjectId,
        details: { formula: projected.formula },
      });
    }
  }

  return {
    ...section(expected.length, validCount, deduplicateIssues(issues)),
    supported: evidence.filter((entry) => entry.compatibility === 'supported').length,
    unsupported: evidence.filter((entry) => entry.compatibility === 'unsupported').length,
    stale: evidence.filter((entry) => entry.stale).length,
    evidence: [...evidence].sort(
      (left, right) =>
        left.sourceObjectId.localeCompare(right.sourceObjectId) ||
        left.locator.localeCompare(right.locator)
    ),
  };
}

function validateNativeConversionExceptions(
  receipts: readonly ProjectionReceipt[]
): ValidationReportV2['nativeConversionExceptions'] {
  const evidence = receipts
    .filter((receipt) => receipt.exception !== null)
    .map((receipt) => {
      const prominentlyLabeled = receipt.warnings.some((warning) =>
        warning.startsWith('Native conversion exception:')
      );
      return {
        sourceObjectId: receipt.sourceObjectId,
        receiptId: receipt.id,
        converterId: receipt.converterId,
        message: receipt.exception as string,
        preservedAs: receipt.projection,
        prominentlyLabeled,
      };
    })
    .sort((left, right) => left.sourceObjectId.localeCompare(right.sourceObjectId));
  const issues: MigrationIssue[] = [];
  let validCount = 0;
  for (const exception of evidence) {
    if (
      (exception.preservedAs !== 'artifact' && exception.preservedAs !== 'fallback') ||
      !exception.prominentlyLabeled
    ) {
      issues.push({
        code: 'projection_failed',
        message: `Native conversion exception for ${exception.sourceObjectId} is not a prominently labeled artifact.`,
        blocking: true,
        sourceObjectId: exception.sourceObjectId,
        details: { receiptId: exception.receiptId },
      });
    } else {
      validCount += 1;
    }
  }
  return {
    ...section(evidence.length, validCount, issues),
    evidence,
  };
}

function validateScopedBoundary(
  input: GenerateValidationReportInput
): NonNullable<ValidationReportV2['scopedBoundary']> {
  const evidence = input.scopedBoundaryEvidence ?? null;
  if (input.run.scope.kind === 'file') {
    const issues = evidence
      ? [blockingValidation('File migration unexpectedly contains scoped Folder evidence.')]
      : [];
    return { ...section(0, evidence ? 1 : 0, issues), evidence: null };
  }

  if (isLocalBundleRun(input.run)) {
    try {
      if (evidence) {
        throw new Error('Local Folder imports cannot contain provider pagination evidence.');
      }
      const sourceIdentityHash = migrationRunSourceIdentityHash(input.run);
      if (!sourceIdentityHash) {
        throw new Error('Local Folder import has no immutable artifact source identity.');
      }
      assertScopedFolderBoundary({
        scope: input.run.scope,
        sourceAccountHash: sourceIdentityHash,
        capturedAt: input.snapshot.createdAt,
        folders: input.scopedFolders,
      });
      return { ...section(1, 1, []), evidence: null };
    } catch (error) {
      return {
        ...section(1, 0, [
          blockingValidation('Local Folder hierarchy failed final validation.', {
            evidenceError: error instanceof Error ? error.message : 'Unknown hierarchy error.',
          }),
        ]),
        evidence: null,
      };
    }
  }

  if (!evidence) {
    return {
      ...section(1, 0, [blockingValidation('Selected Folder scope is missing boundary evidence.')]),
      evidence: null,
    };
  }

  try {
    if (
      evidence.runId !== input.run.id ||
      evidence.sourceAccountHash !== input.run.binding?.accountHash ||
      JSON.stringify(evidence.scope) !== JSON.stringify(input.run.scope)
    ) {
      throw new Error('Scoped boundary evidence does not match the confirmed migration run.');
    }
    const attestation = createScopedBoundaryAttestation(evidence, {
      sourceIdMode: input.scopedBoundarySourceIdMode ?? 'benchling',
    });
    return { ...section(1, 1, []), evidence: attestation };
  } catch (error) {
    return {
      ...section(1, 0, [
        blockingValidation('Selected Folder boundary evidence failed final attestation.', {
          evidenceError: error instanceof Error ? error.message : 'Unknown boundary error.',
        }),
      ]),
      evidence: null,
    };
  }
}

export type DirectFolderCaptureAttestationInput = Pick<
  GenerateValidationReportInput,
  | 'run'
  | 'exportJobs'
  | 'exportCaptures'
  | 'exportJobReplacements'
  | 'scopedBoundaryEvidence'
  | 'scopedBoundarySourceIdMode'
  | 'directFolderCapturePlan'
  | 'directFolderTraversalJournal'
>;

export function validateDirectFolderCaptureAttestation(
  input: DirectFolderCaptureAttestationInput
): NonNullable<ValidationReportV2['directFolderCapture']> | null {
  const planFieldPresent = Object.prototype.hasOwnProperty.call(input, 'directFolderCapturePlan');
  const journalFieldPresent = Object.prototype.hasOwnProperty.call(
    input,
    'directFolderTraversalJournal'
  );
  const jobsWithAuthority = input.exportJobs.filter(
    (job) => job.directFolderAuthority !== undefined
  );
  const directFolderScope = input.run.scope.kind === 'folder';

  if (!directFolderScope) {
    if (
      input.directFolderCapturePlan == null &&
      input.directFolderTraversalJournal == null &&
      jobsWithAuthority.length === 0
    ) {
      return null;
    }
    return {
      ...section(0, 1, [
        blockingInvariant(
          'Non-Direct Folder validation unexpectedly contains Direct Folder capture authority.'
        ),
      ]),
      evidence: null,
    };
  }
  const directFolderScopeValue = input.run.scope;
  if (directFolderScopeValue.kind !== 'folder') {
    throw new Error('Direct Folder attestation scope narrowing failed.');
  }
  if (!planFieldPresent && !journalFieldPresent && jobsWithAuthority.length === 0) return null;

  const issues: MigrationIssue[] = [];
  const suppliedPlan = input.directFolderCapturePlan ?? null;
  if (!suppliedPlan) {
    return {
      ...section(1, 0, [
        blockingValidation('Direct Folder validation is missing its persisted capture plan.'),
      ]),
      evidence: null,
    };
  }

  let plan: DirectFolderCapturePlanV1;
  try {
    plan = validateDirectFolderCapturePlan(suppliedPlan);
  } catch (error) {
    return {
      ...section(1, 0, [
        blockingValidation('Direct Folder capture plan failed final attestation.', {
          planError: error instanceof Error ? error.message : 'Unknown capture-plan error.',
        }),
      ]),
      evidence: null,
    };
  }
  const traversalJournal = input.directFolderTraversalJournal ?? null;
  if (!traversalJournal) {
    issues.push(
      blockingValidation(
        'Direct Folder validation is missing its persisted terminal traversal journal.'
      )
    );
  } else {
    try {
      plan = assertDirectFolderCapturePlanMatchesJournal(plan, traversalJournal);
      const recomputedTraversalJournalDigest = directFolderTraversalJournalDigest(traversalJournal);
      if (recomputedTraversalJournalDigest !== plan.traversalJournalDigest) {
        throw new Error('Recomputed traversal journal digest does not match the capture plan.');
      }
    } catch (error) {
      issues.push(
        blockingValidation(
          'Direct Folder capture plan does not match its persisted traversal journal.',
          {
            journalError:
              error instanceof Error ? error.message : 'Unknown traversal-journal error.',
          }
        )
      );
    }
  }

  const binding = input.run.binding;
  if (
    plan.runId !== input.run.id ||
    plan.sourceAccountHash !== binding?.accountHash ||
    plan.selectedRootId !== directFolderScopeValue.folder.id
  ) {
    issues.push(
      blockingValidation('Direct Folder capture plan does not match the confirmed migration run.', {
        planRunId: plan.runId,
        planSelectedRootId: plan.selectedRootId,
      })
    );
  }
  if (!plan.startAllowed) {
    issues.push(
      blockingValidation('Direct Folder capture plan is not authorized to start.', {
        blockerCount: plan.blockers.length,
      })
    );
  }
  const explicitSkips = plan.blockers;
  issues.push(
    ...explicitSkips.map((skipped) => ({
      code: 'unsupported_scope_item' as const,
      message: `Direct Folder item ${skipped.sourceId} was skipped (${skipped.code}).`,
      blocking: false,
      sourceObjectId: skipped.sourceId,
      details: {
        reason: skipped.code,
        sourceType: skipped.sourceType,
        disposition: 'skipped',
      },
    }))
  );

  let boundaryCanonicalSha256: string | null = null;
  const boundary = input.scopedBoundaryEvidence ?? null;
  if (!boundary) {
    issues.push(blockingValidation('Direct Folder capture plan has no scoped boundary evidence.'));
  } else {
    try {
      if (
        boundary.runId !== plan.runId ||
        boundary.sourceAccountHash !== plan.sourceAccountHash ||
        boundary.capturedAt !== plan.capturedAt ||
        canonicalValidationJson(boundary.scope) !== canonicalValidationJson(input.run.scope)
      ) {
        throw new Error('Capture plan and boundary headers do not match.');
      }
      const memberships = scopedItemMembershipEvidence(boundary, true, {
        sourceIdMode: input.scopedBoundarySourceIdMode ?? 'benchling',
      });
      const plannedMemberships = plan.items.map((item) => ({
        sourceObjectId: item.sourceId,
        sourceFolderIds: [...item.sourceFolderIds],
      }));
      if (canonicalValidationJson(memberships) !== canonicalValidationJson(plannedMemberships)) {
        throw new Error('Capture-plan items do not exactly match scoped boundary membership.');
      }
      boundaryCanonicalSha256 = createScopedBoundaryAttestation(boundary, {
        sourceIdMode: input.scopedBoundarySourceIdMode ?? 'benchling',
      }).canonicalSha256;
    } catch (error) {
      issues.push(
        blockingValidation('Direct Folder capture plan does not match scoped boundary evidence.', {
          boundaryError: error instanceof Error ? error.message : 'Unknown boundary error.',
        })
      );
    }
  }

  const itemById = new Map(plan.items.map((item) => [item.sourceId, item] as const));
  const runnableItems = plan.items.filter(
    (item) => item.requestCapability.state === 'ready' && item.contentFamily !== null
  );
  let initialIdentityByItemId = new Map<
    string,
    ReturnType<typeof directFolderInitialExportJobIdentityIndex> extends ReadonlyMap<
      string,
      infer T
    >
      ? T
      : never
  >();
  try {
    initialIdentityByItemId = new Map(directFolderInitialExportJobIdentityIndex(plan));
  } catch (error) {
    issues.push(
      blockingValidation(
        'Direct Folder capture plan requires a new URL-authorized discovery run.',
        {
          authorityError: error instanceof Error ? error.message : 'Unknown item authority error.',
        }
      )
    );
  }
  if (initialIdentityByItemId.size !== runnableItems.length) {
    issues.push(
      blockingValidation(
        'Direct Folder capture plan contains items without runnable export authority.',
        {
          plannedItems: runnableItems.length,
          runnableItems: initialIdentityByItemId.size,
        }
      )
    );
  }

  const jobsById = new Map<string, ExportJob>();
  for (const job of input.exportJobs) {
    if (jobsById.has(job.id)) {
      issues.push(blockingInvariant(`Direct Folder export job ${job.id} is duplicated.`));
    } else {
      jobsById.set(job.id, job);
    }
  }
  const replacementsByFailedJobId = new Map<string, PersistedExportJobReplacement>();
  for (const replacement of input.exportJobReplacements) {
    if (replacementsByFailedJobId.has(replacement.failedJobId)) {
      issues.push(
        blockingInvariant(
          `Direct Folder replacement lineage for ${replacement.failedJobId} is duplicated.`
        )
      );
    } else {
      replacementsByFailedJobId.set(replacement.failedJobId, replacement);
    }
  }
  const capturesByJobId = groupBy(input.exportCaptures, (capture) => capture.jobId);

  for (const job of input.exportJobs) {
    const sourceItemId = job.directFolderAuthority?.sourceItemId;
    const identity = sourceItemId ? initialIdentityByItemId.get(sourceItemId) : undefined;
    const item = sourceItemId ? itemById.get(sourceItemId) : undefined;
    if (
      !identity ||
      !item ||
      job.runId !== input.run.id ||
      job.contentFamily !== item.contentFamily ||
      canonicalValidationJson(job.directFolderAuthority) !==
        canonicalValidationJson(identity.authority) ||
      job.sourceRoots.length !== 1 ||
      job.sourceRoots[0]?.id !== sourceItemId ||
      job.sourceRoots[0]?.url !== item.sourceUrl ||
      job.sourceRoots[0]?.objectType !== item.sourceType
    ) {
      issues.push(
        blockingValidation(
          `Direct Folder export job ${job.id} has unplanned or cross-item authority.`,
          {
            jobId: job.id,
            sourceItemId: sourceItemId ?? null,
          }
        )
      );
    }
  }

  const visitedJobOwner = new Map<string, string>();
  const successfulLeafJobIds = new Set<string>();
  const itemEvidence: ValidationDirectFolderCaptureItemEvidence[] = [];
  let successfulLeafCount = 0;

  for (const item of runnableItems) {
    const identity = initialIdentityByItemId.get(item.sourceId);
    let itemValid = true;
    const addItemIssue = (message: string, details?: Record<string, unknown>): void => {
      itemValid = false;
      issues.push(blockingValidation(message, details));
    };
    if (!identity || item.contentFamily === null) {
      addItemIssue(`Direct Folder item ${item.sourceId} has no runnable initial export job.`);
      continue;
    }
    let current = jobsById.get(identity.id);
    if (!current) {
      addItemIssue(`Direct Folder item ${item.sourceId} is missing its canonical initial job.`, {
        expectedInitialJobId: identity.id,
      });
      continue;
    }
    if (
      !sameDirectFolderPlanningIdentity(current, {
        id: identity.id,
        runId: input.run.id,
        contentFamily: item.contentFamily,
        sourceRoots: [
          {
            id: item.sourceId,
            url: item.sourceUrl ?? '',
            objectType: item.sourceType,
          },
        ],
        matchSignature: identity.matchSignature,
        directFolderAuthority: identity.authority,
      })
    ) {
      addItemIssue(`Direct Folder item ${item.sourceId} has a tampered initial job identity.`, {
        expectedInitialJobId: identity.id,
      });
    }

    const chainJobIds: string[] = [];
    const itemVisited = new Set<string>();
    let successfulLeafJobId: string | null = null;
    while (current) {
      if (itemVisited.has(current.id)) {
        addItemIssue(`Direct Folder item ${item.sourceId} contains a replacement cycle.`, {
          jobId: current.id,
        });
        break;
      }
      itemVisited.add(current.id);
      chainJobIds.push(current.id);
      const existingOwner = visitedJobOwner.get(current.id);
      if (existingOwner && existingOwner !== item.sourceId) {
        addItemIssue(`Direct Folder export job ${current.id} is shared across item lineages.`, {
          sourceItemIds: [existingOwner, item.sourceId].sort(),
        });
        break;
      }
      visitedJobOwner.set(current.id, item.sourceId);

      if (
        canonicalValidationJson(current.directFolderAuthority) !==
        canonicalValidationJson(identity.authority)
      ) {
        addItemIssue(`Direct Folder lineage for ${item.sourceId} changes export authority.`, {
          jobId: current.id,
        });
      }

      if (current.state === 'captured') {
        if (replacementsByFailedJobId.has(current.id)) {
          addItemIssue(`Captured Direct Folder leaf ${current.id} unexpectedly has a replacement.`);
        }
        const captures = capturesByJobId.get(current.id) ?? [];
        const capture = captures.length === 1 ? captures[0] : null;
        const crossItemIds = capture
          ? capture.sourceObjectIds
              .filter(
                (sourceObjectId) => sourceObjectId !== item.sourceId && itemById.has(sourceObjectId)
              )
              .sort()
          : [];
        if (
          !capture ||
          capture.runId !== input.run.id ||
          !capture.sourceObjectIds.includes(item.sourceId) ||
          crossItemIds.length > 0
        ) {
          addItemIssue(
            `Captured Direct Folder leaf ${current.id} does not contain exactly its authorized planned item.`,
            {
              captureCount: captures.length,
              sourceItemId: item.sourceId,
              crossItemIds,
            }
          );
        }
        successfulLeafJobId = current.id;
        break;
      }
      if (current.state !== 'failed') {
        addItemIssue(`Direct Folder export job ${current.id} is still ${current.state}.`, {
          jobId: current.id,
        });
        break;
      }

      const replacement = replacementsByFailedJobId.get(current.id);
      if (
        !replacement ||
        replacement.runId !== input.run.id ||
        replacement.reason !== 'download_link_expired' ||
        replacement.replacementJobIds.length !== 1
      ) {
        addItemIssue(
          `Failed Direct Folder export ${current.id} has no exact replacement lineage.`,
          {
            replacementJobIds: replacement?.replacementJobIds ?? [],
            replacementReason: replacement?.reason ?? null,
          }
        );
        break;
      }
      const successor = jobsById.get(replacement.replacementJobIds[0]);
      let expectedSuccessor: ExportJob;
      try {
        expectedSuccessor = makeReplacementExportJob({
          failedJob: current,
          sourceRoots: current.sourceRoots,
          reason: 'download_link_expired',
          ordinal: 0,
        });
      } catch (error) {
        addItemIssue(`Direct Folder replacement for ${current.id} cannot be reproduced.`, {
          replacementError: error instanceof Error ? error.message : 'Unknown replacement error.',
        });
        break;
      }
      if (!successor || !sameDirectFolderPlanningIdentity(successor, expectedSuccessor)) {
        addItemIssue(
          `Direct Folder replacement for ${current.id} is not its canonical successor.`,
          {
            expectedSuccessorJobId: expectedSuccessor.id,
            actualSuccessorJobId: successor?.id ?? null,
          }
        );
        break;
      }
      current = successor;
    }

    if (successfulLeafJobId && itemValid) {
      successfulLeafCount += 1;
      successfulLeafJobIds.add(successfulLeafJobId);
      itemEvidence.push({
        sourceItemId: item.sourceId,
        initialJobId: identity.id,
        successfulLeafJobId,
        chainJobIds,
        authority: structuredClone(identity.authority),
        authoritySha256: canonicalValidationSha256(identity.authority),
      });
    }
  }

  const unvisitedJobIds = input.exportJobs
    .map((job) => job.id)
    .filter((jobId) => !visitedJobOwner.has(jobId))
    .sort();
  if (unvisitedJobIds.length > 0) {
    issues.push(
      blockingValidation('Direct Folder validation contains jobs outside every planned lineage.', {
        unvisitedJobIds,
      })
    );
  }
  const invalidReplacementParents = input.exportJobReplacements
    .filter((replacement) => {
      const failed = jobsById.get(replacement.failedJobId);
      return !failed || failed.state !== 'failed' || !visitedJobOwner.has(replacement.failedJobId);
    })
    .map((replacement) => replacement.failedJobId)
    .sort();
  if (invalidReplacementParents.length > 0) {
    issues.push(
      blockingValidation('Direct Folder validation contains unbound replacement lineages.', {
        failedJobIds: invalidReplacementParents,
      })
    );
  }
  const nonLeafCaptureJobIds = input.exportCaptures
    .map((capture) => capture.jobId)
    .filter((jobId) => jobsById.has(jobId) && !successfulLeafJobIds.has(jobId))
    .sort();
  if (nonLeafCaptureJobIds.length > 0) {
    issues.push(
      blockingValidation(
        'Direct Folder capture evidence belongs to a non-successful lineage job.',
        {
          jobIds: nonLeafCaptureJobIds,
        }
      )
    );
  }

  const sortedItemEvidence = itemEvidence.sort((left, right) =>
    compareValidationCodeUnits(left.sourceItemId, right.sourceItemId)
  );
  const blocking = issues.some((issue) => issue.blocking);
  const evidence =
    !blocking && boundaryCanonicalSha256
      ? {
          schema: 'dnaforge.migration.direct-folder-capture-attestation.v1' as const,
          capturePlanDigest: plan.planDigest,
          traversalJournalDigest: plan.traversalJournalDigest,
          sourceAccountHash: plan.sourceAccountHash,
          selectedRootId: plan.selectedRootId,
          boundaryCanonicalSha256,
          authorityManifestSha256: canonicalValidationSha256({
            schema: 'dnaforge.migration.direct-folder-authority-manifest.v1',
            capturePlanDigest: plan.planDigest,
            traversalJournalDigest: plan.traversalJournalDigest,
            items: sortedItemEvidence.map((item) => ({
              sourceItemId: item.sourceItemId,
              authority: item.authority,
              authoritySha256: item.authoritySha256,
            })),
          }),
          lineageManifestSha256: canonicalValidationSha256({
            schema: 'dnaforge.migration.direct-folder-lineage-manifest.v1',
            capturePlanDigest: plan.planDigest,
            items: sortedItemEvidence.map((item) => ({
              sourceItemId: item.sourceItemId,
              initialJobId: item.initialJobId,
              chainJobIds: item.chainJobIds,
              successfulLeafJobId: item.successfulLeafJobId,
            })),
          }),
          plannedItemCount: runnableItems.length,
          successfulLeafCount,
          items: sortedItemEvidence,
          skippedItemCount: explicitSkips.length,
          skippedItems: explicitSkips.map((skipped) => ({
            sourceItemId: skipped.sourceId,
            sourceType: skipped.sourceType,
            reason: skipped.code,
            sourceFolderIds: [...(itemById.get(skipped.sourceId)?.sourceFolderIds ?? [])],
          })),
        }
      : null;

  return {
    ...section(runnableItems.length, successfulLeafCount, deduplicateIssues(issues)),
    evidence,
  };
}

export type FolderTreeCaptureAttestationInput = Pick<
  GenerateValidationReportInput,
  | 'run'
  | 'exportJobs'
  | 'exportCaptures'
  | 'exportJobReplacements'
  | 'scopedBoundaryEvidence'
  | 'scopedBoundarySourceIdMode'
  | 'folderTreeCapturePlan'
  | 'folderTreeTraversalJournal'
>;

export function validateFolderTreeCaptureAttestation(
  input: FolderTreeCaptureAttestationInput
): NonNullable<ValidationReportV2['folderTreeCapture']> | null {
  const planFieldPresent = Object.prototype.hasOwnProperty.call(input, 'folderTreeCapturePlan');
  const journalFieldPresent = Object.prototype.hasOwnProperty.call(
    input,
    'folderTreeTraversalJournal'
  );
  const jobsWithAuthority = input.exportJobs.filter((job) => job.folderTreeAuthority !== undefined);
  const treeScope = input.run.scope.kind === 'folder_tree';

  if (!treeScope) {
    if (
      input.folderTreeCapturePlan == null &&
      input.folderTreeTraversalJournal == null &&
      jobsWithAuthority.length === 0
    ) {
      return null;
    }
    return {
      ...section(0, 1, [
        blockingInvariant(
          'Non-Tree validation unexpectedly contains Folder Tree capture authority.'
        ),
      ]),
      evidence: null,
    };
  }
  const treeScopeValue = input.run.scope;
  if (treeScopeValue.kind !== 'folder_tree') {
    throw new Error('Folder Tree attestation scope narrowing failed.');
  }
  if (!planFieldPresent && !journalFieldPresent && jobsWithAuthority.length === 0) return null;

  const suppliedPlan = input.folderTreeCapturePlan ?? null;
  if (!suppliedPlan) {
    return {
      ...section(1, 0, [
        blockingValidation('Folder Tree validation is missing its persisted capture plan.'),
      ]),
      evidence: null,
    };
  }

  let plan: FolderTreeCapturePlanV1;
  try {
    plan = validateFolderTreeCapturePlan(suppliedPlan);
  } catch (error) {
    return {
      ...section(1, 0, [
        blockingValidation('Folder Tree capture plan failed final attestation.', {
          planError: error instanceof Error ? error.message : 'Unknown capture-plan error.',
        }),
      ]),
      evidence: null,
    };
  }

  const issues: MigrationIssue[] = [];
  const traversalJournal = input.folderTreeTraversalJournal ?? null;
  if (!traversalJournal) {
    issues.push(
      blockingValidation(
        'Folder Tree validation is missing its persisted terminal traversal journal.'
      )
    );
  } else {
    try {
      plan = assertFolderTreeCapturePlanMatchesJournal(plan, traversalJournal);
      if (folderTreeTraversalJournalDigest(traversalJournal) !== plan.traversalJournalDigest) {
        throw new Error('Recomputed traversal journal digest does not match the capture plan.');
      }
    } catch (error) {
      issues.push(
        blockingValidation(
          'Folder Tree capture plan does not match its persisted traversal journal.',
          {
            journalError:
              error instanceof Error ? error.message : 'Unknown traversal-journal error.',
          }
        )
      );
    }
  }

  const root = treeScopeValue.roots[0];
  if (
    treeScopeValue.roots.length !== 1 ||
    plan.runId !== input.run.id ||
    plan.sourceAccountHash !== input.run.binding?.accountHash ||
    plan.selectedRootId !== root?.id
  ) {
    issues.push(
      blockingValidation('Folder Tree capture plan does not match the confirmed migration run.', {
        planRunId: plan.runId,
        planSelectedRootId: plan.selectedRootId,
      })
    );
  }
  if (!plan.startAllowed) {
    issues.push(
      blockingValidation('Folder Tree capture plan is not authorized to start.', {
        blockerCount: plan.blockers.length,
      })
    );
  }
  const explicitSkips = plan.blockers;
  issues.push(
    ...explicitSkips.map((skipped) => ({
      code: 'unsupported_scope_item' as const,
      message: `Folder Tree item ${skipped.sourceId} was skipped (${skipped.code}).`,
      blocking: false,
      sourceObjectId: skipped.sourceId,
      details: {
        reason: skipped.code,
        sourceType: skipped.sourceType,
        disposition: 'skipped',
      },
    }))
  );

  let boundaryCanonicalSha256: string | null = null;
  const boundary = input.scopedBoundaryEvidence ?? null;
  if (!boundary) {
    issues.push(blockingValidation('Folder Tree capture plan has no scoped boundary evidence.'));
  } else {
    try {
      if (
        boundary.runId !== plan.runId ||
        boundary.sourceAccountHash !== plan.sourceAccountHash ||
        boundary.capturedAt !== plan.capturedAt ||
        canonicalValidationJson(boundary.scope) !== canonicalValidationJson(input.run.scope)
      ) {
        throw new Error('Capture plan and boundary headers do not match.');
      }
      const includedFolderIds = boundary.folders.map((folder) => folder.ref.id).sort();
      const includedFolderSet = new Set(includedFolderIds);
      const excludedFolderIds = [
        ...new Set(
          boundary.enumerations.flatMap((enumeration) =>
            enumeration.childFolderPages.flatMap((page) => page.sourceIds)
          )
        ),
      ]
        .filter((folderId) => !includedFolderSet.has(folderId))
        .sort();
      if (
        canonicalValidationJson(includedFolderIds) !==
          canonicalValidationJson(plan.includedFolderIds) ||
        canonicalValidationJson(excludedFolderIds) !==
          canonicalValidationJson(plan.excludedFolderIds)
      ) {
        throw new Error('Capture-plan folder inclusion does not match scoped boundary evidence.');
      }
      const memberships = scopedItemMembershipEvidence(boundary, true, {
        sourceIdMode: input.scopedBoundarySourceIdMode ?? 'benchling',
      });
      const plannedMemberships = plan.items.map((item) => ({
        sourceObjectId: item.sourceId,
        sourceFolderIds: [...item.sourceFolderIds],
      }));
      if (canonicalValidationJson(memberships) !== canonicalValidationJson(plannedMemberships)) {
        throw new Error('Capture-plan items do not exactly match scoped boundary membership.');
      }
      boundaryCanonicalSha256 = createScopedBoundaryAttestation(boundary, {
        sourceIdMode: input.scopedBoundarySourceIdMode ?? 'benchling',
      }).canonicalSha256;
    } catch (error) {
      issues.push(
        blockingValidation('Folder Tree capture plan does not match scoped boundary evidence.', {
          boundaryError: error instanceof Error ? error.message : 'Unknown boundary error.',
        })
      );
    }
  }

  const itemById = new Map(plan.items.map((item) => [item.sourceId, item] as const));
  const runnableItems = plan.items.filter((item) => item.requestCapability.state === 'ready');
  let initialIdentityByItemId = new Map<
    string,
    ReturnType<typeof folderTreeInitialExportJobIdentityIndex> extends ReadonlyMap<string, infer T>
      ? T
      : never
  >();
  try {
    initialIdentityByItemId = new Map(folderTreeInitialExportJobIdentityIndex(plan));
  } catch (error) {
    issues.push(
      blockingValidation('Folder Tree capture plan requires a new URL-authorized discovery run.', {
        authorityError: error instanceof Error ? error.message : 'Unknown item authority error.',
      })
    );
  }
  if (initialIdentityByItemId.size !== runnableItems.length) {
    issues.push(
      blockingValidation('Folder Tree plan contains items without runnable export authority.', {
        plannedItems: runnableItems.length,
        runnableItems: initialIdentityByItemId.size,
      })
    );
  }

  const jobsById = new Map<string, ExportJob>();
  for (const job of input.exportJobs) {
    if (jobsById.has(job.id)) {
      issues.push(blockingInvariant(`Folder Tree export job ${job.id} is duplicated.`));
    } else {
      jobsById.set(job.id, job);
    }
  }
  const replacementsByFailedJobId = new Map<string, PersistedExportJobReplacement>();
  for (const replacement of input.exportJobReplacements) {
    if (replacementsByFailedJobId.has(replacement.failedJobId)) {
      issues.push(
        blockingInvariant(
          `Folder Tree replacement lineage for ${replacement.failedJobId} is duplicated.`
        )
      );
    } else {
      replacementsByFailedJobId.set(replacement.failedJobId, replacement);
    }
  }
  const capturesByJobId = groupBy(input.exportCaptures, (capture) => capture.jobId);

  for (const job of input.exportJobs) {
    const sourceItemId = job.folderTreeAuthority?.sourceItemId;
    const identity = sourceItemId ? initialIdentityByItemId.get(sourceItemId) : undefined;
    const item = sourceItemId ? itemById.get(sourceItemId) : undefined;
    if (
      !identity ||
      !item ||
      job.runId !== input.run.id ||
      job.contentFamily !== folderTreeItemContentFamily(item) ||
      canonicalValidationJson(job.folderTreeAuthority) !==
        canonicalValidationJson(identity.authority) ||
      job.directFolderAuthority !== undefined ||
      job.sourceRoots.length !== 1 ||
      job.sourceRoots[0]?.id !== sourceItemId ||
      job.sourceRoots[0]?.url !== item.sourceUrl ||
      job.sourceRoots[0]?.objectType !== item.sourceType
    ) {
      issues.push(
        blockingValidation(`Folder Tree export job ${job.id} has unplanned authority.`, {
          jobId: job.id,
          sourceItemId: sourceItemId ?? null,
        })
      );
    }
  }

  const visitedJobOwner = new Map<string, string>();
  const successfulLeafJobIds = new Set<string>();
  const itemEvidence: ValidationFolderTreeCaptureItemEvidence[] = [];
  let successfulLeafCount = 0;

  for (const item of runnableItems) {
    const identity = initialIdentityByItemId.get(item.sourceId);
    let itemValid = true;
    const addItemIssue = (message: string, details?: Record<string, unknown>): void => {
      itemValid = false;
      issues.push(blockingValidation(message, details));
    };
    if (!identity || item.requestCapability.state !== 'ready') {
      addItemIssue(`Folder Tree item ${item.sourceId} has no runnable initial export job.`);
      continue;
    }
    let current = jobsById.get(identity.id);
    if (!current) {
      addItemIssue(`Folder Tree item ${item.sourceId} is missing its canonical initial job.`, {
        expectedInitialJobId: identity.id,
      });
      continue;
    }
    if (
      !sameFolderTreePlanningIdentity(current, {
        id: identity.id,
        runId: input.run.id,
        contentFamily: folderTreeItemContentFamily(item),
        sourceRoots: [
          {
            id: item.sourceId,
            url: item.sourceUrl ?? '',
            objectType: item.sourceType,
          },
        ],
        matchSignature: identity.matchSignature,
        folderTreeAuthority: identity.authority,
      })
    ) {
      addItemIssue(`Folder Tree item ${item.sourceId} has a tampered initial job identity.`, {
        expectedInitialJobId: identity.id,
      });
    }

    const chainJobIds: string[] = [];
    const itemVisited = new Set<string>();
    let successfulLeafJobId: string | null = null;
    while (current) {
      if (itemVisited.has(current.id)) {
        addItemIssue(`Folder Tree item ${item.sourceId} contains a replacement cycle.`, {
          jobId: current.id,
        });
        break;
      }
      itemVisited.add(current.id);
      chainJobIds.push(current.id);
      const existingOwner = visitedJobOwner.get(current.id);
      if (existingOwner && existingOwner !== item.sourceId) {
        addItemIssue(`Folder Tree job ${current.id} is shared across item lineages.`);
        break;
      }
      visitedJobOwner.set(current.id, item.sourceId);
      if (
        canonicalValidationJson(current.folderTreeAuthority) !==
        canonicalValidationJson(identity.authority)
      ) {
        addItemIssue(`Folder Tree lineage for ${item.sourceId} changes export authority.`, {
          jobId: current.id,
        });
      }

      if (current.state === 'captured') {
        if (replacementsByFailedJobId.has(current.id)) {
          addItemIssue(`Captured Folder Tree leaf ${current.id} unexpectedly has a replacement.`);
        }
        const captures = capturesByJobId.get(current.id) ?? [];
        const capture = captures.length === 1 ? captures[0] : null;
        const crossItemIds = capture
          ? capture.sourceObjectIds
              .filter(
                (sourceObjectId) => sourceObjectId !== item.sourceId && itemById.has(sourceObjectId)
              )
              .sort()
          : [];
        if (
          !capture ||
          capture.runId !== input.run.id ||
          !capture.sourceObjectIds.includes(item.sourceId) ||
          crossItemIds.length > 0
        ) {
          addItemIssue(
            `Captured Folder Tree leaf ${current.id} does not contain exactly its authorized planned item.`,
            { captureCount: captures.length, sourceItemId: item.sourceId, crossItemIds }
          );
        }
        successfulLeafJobId = current.id;
        break;
      }
      if (current.state !== 'failed') {
        addItemIssue(`Folder Tree export job ${current.id} is still ${current.state}.`, {
          jobId: current.id,
        });
        break;
      }

      const replacement = replacementsByFailedJobId.get(current.id);
      if (
        !replacement ||
        replacement.runId !== input.run.id ||
        replacement.reason !== 'download_link_expired' ||
        replacement.replacementJobIds.length !== 1
      ) {
        addItemIssue(`Failed Folder Tree export ${current.id} has no exact replacement lineage.`);
        break;
      }
      const successor = jobsById.get(replacement.replacementJobIds[0]);
      let expectedSuccessor: ExportJob;
      try {
        expectedSuccessor = makeReplacementExportJob({
          failedJob: current,
          sourceRoots: current.sourceRoots,
          reason: 'download_link_expired',
          ordinal: 0,
        });
      } catch (error) {
        addItemIssue(`Folder Tree replacement for ${current.id} cannot be reproduced.`, {
          replacementError: error instanceof Error ? error.message : 'Unknown replacement error.',
        });
        break;
      }
      if (!successor || !sameFolderTreePlanningIdentity(successor, expectedSuccessor)) {
        addItemIssue(`Folder Tree replacement for ${current.id} is not its canonical successor.`, {
          expectedSuccessorJobId: expectedSuccessor.id,
          actualSuccessorJobId: successor?.id ?? null,
        });
        break;
      }
      current = successor;
    }

    if (successfulLeafJobId && itemValid) {
      successfulLeafCount += 1;
      successfulLeafJobIds.add(successfulLeafJobId);
      itemEvidence.push({
        sourceItemId: item.sourceId,
        sourceFolderIds: [...item.sourceFolderIds],
        initialJobId: identity.id,
        successfulLeafJobId,
        chainJobIds,
        authority: structuredClone(identity.authority),
        authoritySha256: canonicalValidationSha256(identity.authority),
      });
    }
  }

  const unvisitedJobIds = input.exportJobs
    .map((job) => job.id)
    .filter((jobId) => !visitedJobOwner.has(jobId))
    .sort();
  if (unvisitedJobIds.length > 0) {
    issues.push(
      blockingValidation('Folder Tree validation contains jobs outside every planned lineage.', {
        unvisitedJobIds,
      })
    );
  }
  const invalidReplacementParents = input.exportJobReplacements
    .filter((replacement) => {
      const failed = jobsById.get(replacement.failedJobId);
      return !failed || failed.state !== 'failed' || !visitedJobOwner.has(replacement.failedJobId);
    })
    .map((replacement) => replacement.failedJobId)
    .sort();
  if (invalidReplacementParents.length > 0) {
    issues.push(
      blockingValidation('Folder Tree validation contains unbound replacement lineages.', {
        failedJobIds: invalidReplacementParents,
      })
    );
  }
  const nonLeafCaptureJobIds = input.exportCaptures
    .map((capture) => capture.jobId)
    .filter((jobId) => jobsById.has(jobId) && !successfulLeafJobIds.has(jobId))
    .sort();
  if (nonLeafCaptureJobIds.length > 0) {
    issues.push(
      blockingValidation('Folder Tree capture evidence belongs to a non-successful lineage job.', {
        jobIds: nonLeafCaptureJobIds,
      })
    );
  }

  const sortedItemEvidence = itemEvidence.sort((left, right) =>
    compareValidationCodeUnits(left.sourceItemId, right.sourceItemId)
  );
  const blocking = issues.some((issue) => issue.blocking);
  const evidence =
    !blocking && boundaryCanonicalSha256
      ? {
          schema: 'dnaforge.migration.folder-tree-capture-attestation.v1' as const,
          capturePlanDigest: plan.planDigest,
          traversalJournalDigest: plan.traversalJournalDigest,
          sourceAccountHash: plan.sourceAccountHash,
          selectedRootId: plan.selectedRootId,
          boundaryCanonicalSha256,
          authorityManifestSha256: canonicalValidationSha256({
            schema: 'dnaforge.migration.folder-tree-authority-manifest.v1',
            capturePlanDigest: plan.planDigest,
            traversalJournalDigest: plan.traversalJournalDigest,
            items: sortedItemEvidence.map((item) => ({
              sourceItemId: item.sourceItemId,
              sourceFolderIds: item.sourceFolderIds,
              authority: item.authority,
              authoritySha256: item.authoritySha256,
            })),
          }),
          lineageManifestSha256: canonicalValidationSha256({
            schema: 'dnaforge.migration.folder-tree-lineage-manifest.v1',
            capturePlanDigest: plan.planDigest,
            items: sortedItemEvidence.map((item) => ({
              sourceItemId: item.sourceItemId,
              initialJobId: item.initialJobId,
              chainJobIds: item.chainJobIds,
              successfulLeafJobId: item.successfulLeafJobId,
            })),
          }),
          maximumFolderDepth: plan.maximumFolderDepth,
          includedFolderIds: [...plan.includedFolderIds],
          excludedFolderIds: [...plan.excludedFolderIds],
          plannedItemCount: runnableItems.length,
          successfulLeafCount,
          items: sortedItemEvidence,
          skippedItemCount: explicitSkips.length,
          skippedItems: explicitSkips.map((skipped) => ({
            sourceItemId: skipped.sourceId,
            sourceType: skipped.sourceType,
            reason: skipped.code,
            sourceFolderIds: [...(itemById.get(skipped.sourceId)?.sourceFolderIds ?? [])],
          })),
        }
      : null;

  return {
    ...section(runnableItems.length, successfulLeafCount, deduplicateIssues(issues)),
    evidence,
  };
}

function folderTreeItemContentFamily(
  item: FolderTreeCapturePlanV1['items'][number]
): 'notebook' | 'dna_rna' {
  return item.sourceType === 'sequence' ? 'dna_rna' : 'notebook';
}

function sameDirectFolderPlanningIdentity(
  actual: ExportJob,
  expected: Pick<
    ExportJob,
    'id' | 'runId' | 'contentFamily' | 'sourceRoots' | 'matchSignature' | 'directFolderAuthority'
  >
): boolean {
  return (
    actual.id === expected.id &&
    actual.runId === expected.runId &&
    actual.contentFamily === expected.contentFamily &&
    actual.matchSignature === expected.matchSignature &&
    canonicalValidationJson(actual.sourceRoots) === canonicalValidationJson(expected.sourceRoots) &&
    canonicalValidationJson(actual.directFolderAuthority) ===
      canonicalValidationJson(expected.directFolderAuthority)
  );
}

function sameFolderTreePlanningIdentity(
  actual: ExportJob,
  expected: Pick<
    ExportJob,
    | 'id'
    | 'runId'
    | 'contentFamily'
    | 'sourceRoots'
    | 'matchSignature'
    | 'folderTreeAuthority'
    | 'folderTreeReplacementLineage'
  >
): boolean {
  return (
    actual.id === expected.id &&
    actual.runId === expected.runId &&
    actual.contentFamily === expected.contentFamily &&
    actual.matchSignature === expected.matchSignature &&
    canonicalValidationJson(actual.sourceRoots) === canonicalValidationJson(expected.sourceRoots) &&
    canonicalValidationJson(actual.folderTreeAuthority) ===
      canonicalValidationJson(expected.folderTreeAuthority) &&
    canonicalValidationJson(actual.folderTreeReplacementLineage ?? null) ===
      canonicalValidationJson(expected.folderTreeReplacementLineage ?? null)
  );
}

function groupBy<T>(values: readonly T[], key: (value: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const itemKey = key(value);
    const group = grouped.get(itemKey) ?? [];
    group.push(value);
    grouped.set(itemKey, group);
  }
  return grouped;
}

function canonicalValidationSha256(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalValidationJson(value)).digest('hex')}`;
}

function canonicalValidationJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalValidationJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareValidationCodeUnits(left, right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalValidationJson(nested)}`)
      .join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('Direct Folder validation evidence is not canonical JSON.');
  }
  return serialized;
}

function compareValidationCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function validateDirectFolderImportScope(input: {
  run: MigrationRun;
  sourceObjects: readonly SourceObject[];
  receipts: readonly ProjectionReceipt[];
  resolutions: readonly RelationshipResolution[];
  collectionProjection: CollectionProjection | null;
  benchlingOrigin: string | undefined;
  workspaceAppendHierarchyCaptures: readonly WorkspaceAppendHierarchyCapture[];
}): NonNullable<ValidationReportV2['directFolderImportScope']> | undefined {
  if (input.run.scope.kind !== 'folder') return undefined;

  const selectedRootId = input.run.scope.folder.id;
  const appendedSelectedSourceIds = new Set(
    input.workspaceAppendHierarchyCaptures.flatMap((capture) =>
      capture.memberships.map((membership) => membership.sourceObjectId)
    )
  );
  const selectedSourceObjects = input.sourceObjects.filter(
    (sourceObject) =>
      sourceObject.memberships.includes(selectedRootId) ||
      appendedSelectedSourceIds.has(sourceObject.id)
  );
  const selectedSourceObjectIds = sortedUniqueSourceIds(
    selectedSourceObjects.map((sourceObject) => sourceObject.id)
  );
  const selectedIdentityIds = new Set(
    selectedSourceObjects.flatMap((sourceObject) => [sourceObject.id, sourceObject.stableId])
  );
  const selectedRelationships = new Map(
    selectedSourceObjects.flatMap((sourceObject) =>
      sourceObject.relationships.map((relationship) => [relationship.id, relationship] as const)
    )
  );

  const approvedDependencyIds = new Set<string>();
  for (const resolution of input.resolutions) {
    const relationship = selectedRelationships.get(resolution.relationshipId);
    const targetIdentity = resolution.targetSourceId?.trim();
    if (
      !relationship ||
      resolution.classification !== 'exact' ||
      !targetIdentity ||
      selectedIdentityIds.has(targetIdentity) ||
      exactRelationshipResolutionCaptureConflict({
        relationship,
        resolution,
        sourceObjects: input.sourceObjects,
        benchlingOrigin: input.benchlingOrigin,
        selectedSnapshotStableIdsAreAuthoritative: isLocalBundleRun(input.run),
      }) !== null
    ) {
      continue;
    }
    const targets = input.sourceObjects.filter(
      (sourceObject) =>
        sourceObject.id === targetIdentity || sourceObject.stableId === targetIdentity
    );
    if (targets.length === 1 && !selectedIdentityIds.has(targets[0].id)) {
      approvedDependencyIds.add(targets[0].id);
    }
  }
  const approvedOneHopDependencySourceObjectIds = sortedUniqueSourceIds([...approvedDependencyIds]);

  const issues: MigrationIssue[] = [];
  const projection = input.collectionProjection;
  const importedDependencyIds = new Set<string>();
  if (!projection) {
    issues.push(
      blockingValidation('Direct Folder import scope is missing its native collection projection.')
    );
  } else {
    const receiptsBySourceObjectId = groupBy(input.receipts, (receipt) => receipt.sourceObjectId);
    const dependencyMemberships = projection.objectMemberships.filter(
      (membership) => membership.scopeRole === 'one_hop_dependency'
    );
    for (const membership of dependencyMemberships) {
      const matchingReceipts = receiptsBySourceObjectId.get(membership.sourceObjectId) ?? [];
      if (
        matchingReceipts.length === 1 &&
        matchingReceipts[0].destinationObjectId === membership.destinationObjectId
      ) {
        importedDependencyIds.add(membership.sourceObjectId);
      }
    }

    const projectedSelectedIds = sortedUniqueSourceIds(projection.selectedSourceObjectIds);
    const projectedDependencyIds = sortedUniqueSourceIds(
      projection.oneHopDependencySourceObjectIds
    );
    const dependencyMembershipIds = sortedUniqueSourceIds(
      dependencyMemberships.map((membership) => membership.sourceObjectId)
    );
    const projectionListsAreCanonical =
      canonicalValidationJson(projection.selectedSourceObjectIds) ===
        canonicalValidationJson(projectedSelectedIds) &&
      canonicalValidationJson(projection.oneHopDependencySourceObjectIds) ===
        canonicalValidationJson(projectedDependencyIds);
    if (
      !projectionListsAreCanonical ||
      canonicalStrings(projectedSelectedIds) !== canonicalStrings(selectedSourceObjectIds) ||
      canonicalStrings(projectedDependencyIds) !==
        canonicalStrings(approvedOneHopDependencySourceObjectIds) ||
      canonicalStrings(dependencyMembershipIds) !== canonicalStrings(projectedDependencyIds)
    ) {
      issues.push(
        blockingValidation(
          'Direct Folder projected scope does not match the exact reviewed one-hop authority.',
          {
            selectedSourceObjectIds,
            projectedSelectedSourceObjectIds: projectedSelectedIds,
            approvedOneHopDependencySourceObjectIds,
            projectedOneHopDependencySourceObjectIds: projectedDependencyIds,
            dependencyMembershipSourceObjectIds: dependencyMembershipIds,
          }
        )
      );
    }
  }

  const importedOneHopDependencySourceObjectIds = sortedUniqueSourceIds([...importedDependencyIds]);
  if (
    canonicalStrings(importedOneHopDependencySourceObjectIds) !==
    canonicalStrings(approvedOneHopDependencySourceObjectIds)
  ) {
    issues.push(
      blockingValidation(
        'Direct Folder imported one-hop dependencies do not exactly match the approved dependency set.',
        {
          approvedOneHopDependencySourceObjectIds,
          importedOneHopDependencySourceObjectIds,
        }
      )
    );
  }

  const evidence: ValidationDirectFolderImportScopeEvidence = {
    schema: 'dnaforge.migration.direct-folder-import-scope.v1',
    selectedSourceObjectIds,
    approvedOneHopDependencySourceObjectIds,
    importedOneHopDependencySourceObjectIds,
  };
  return {
    ...section(
      approvedOneHopDependencySourceObjectIds.length,
      importedOneHopDependencySourceObjectIds.length,
      deduplicateIssues(issues)
    ),
    evidence,
  };
}

function sortedUniqueSourceIds(sourceObjectIds: readonly string[]): string[] {
  return [...new Set(sourceObjectIds)].sort(compareValidationCodeUnits);
}

function validateCollections(
  run: MigrationRun,
  sourceObjects: readonly SourceObject[],
  receipts: readonly ProjectionReceipt[],
  scopedFolders: readonly ScopedFolderMetadata[],
  projection: CollectionProjection | null,
  resolutions: readonly RelationshipResolution[],
  benchlingOrigin: string | undefined,
  workspaceAppendHierarchyCaptures: readonly WorkspaceAppendHierarchyCapture[],
  materializedSourceIds: ReadonlySet<string>
): ValidationReportV2['collections'] {
  const issues: MigrationIssue[] = [];
  const selectedRootSourceIds = scopeRootIds(run);
  const sourceIdentityHash = migrationRunSourceIdentityHash(run);
  if (run.scope.kind === 'file') {
    if (projection || scopedFolders.length > 0 || workspaceAppendHierarchyCaptures.length > 0) {
      issues.push(
        blockingValidation('File migration unexpectedly contains folder collection evidence.')
      );
    }
    return {
      ...section(0, projection?.collections.length ?? 0, issues),
      expectedMemberships: 0,
      actualMemberships: 0,
      selectedRootSourceIds: [],
      evidence: [],
    };
  }

  let folderAuthority;
  try {
    folderAuthority = mergeWorkspaceAppendFolderAuthority({
      scope: run.scope,
      sourceAccountHash: migrationRunSourceIdentityHash(run) ?? '',
      scopedFolders,
      captures: workspaceAppendHierarchyCaptures,
    });
  } catch (error) {
    issues.push(
      blockingValidation(
        error instanceof Error
          ? `Workspace append folder authority is invalid: ${error.message}`
          : 'Workspace append folder authority is invalid.'
      )
    );
    folderAuthority = { folders: scopedFolders, appendedFolderIds: new Set<string>() };
  }
  const authorizedFolders = folderAuthority.folders;
  const folderById = uniqueMap(authorizedFolders, (folder) => folder.ref.id);
  const expectedFolderIds = expectedCollectionFolderIds(
    run,
    folderById,
    folderAuthority.appendedFolderIds,
    issues
  );
  if (!projection) {
    issues.push(blockingValidation('Selected folder scope is missing native collection evidence.'));
    return {
      ...section(expectedFolderIds.size, 0, issues),
      expectedMemberships: expectedCollectionMemberships(sourceObjects, expectedFolderIds).length,
      actualMemberships: 0,
      selectedRootSourceIds,
      evidence: [],
    };
  }

  if (
    projection.scopeKind !== run.scope.kind ||
    projection.sourceAccountHash !== sourceIdentityHash ||
    canonicalStrings(projection.selectedRootSourceIds) !== canonicalStrings(selectedRootSourceIds)
  ) {
    issues.push(
      blockingValidation('Collection projection does not match the confirmed scope binding.')
    );
  }

  const receiptBySourceId = uniqueMap(receipts, (receipt) => receipt.sourceObjectId);
  const collectionsBySourceId = uniqueMap(
    projection.collections,
    (collection) => collection.provenance.sourceFolderId
  );
  const destinationCollectionIds = new Set(
    projection.collections.map((collection) => collection.id)
  );
  let validCollections = 0;
  for (const folderId of expectedFolderIds) {
    const folder = folderById.get(folderId);
    const collection = collectionsBySourceId.get(folderId);
    if (
      !folder ||
      !folder.childrenEnumerated ||
      folder.sourceAccountHash !== sourceIdentityHash ||
      !collection ||
      collection.provenance.sourceAccountHash !== sourceIdentityHash
    ) {
      issues.push(
        blockingValidation(`Folder ${folderId} is missing complete native collection evidence.`, {
          sourceFolderId: folderId,
        })
      );
    } else {
      const expectedParentId =
        folder.parentFolderId && expectedFolderIds.has(folder.parentFolderId)
          ? (collectionsBySourceId.get(folder.parentFolderId)?.id ?? null)
          : null;
      const expectedChildIds = authorizedFolders
        .filter(
          (candidate) =>
            candidate.parentFolderId === folderId && expectedFolderIds.has(candidate.ref.id)
        )
        .map((candidate) => collectionsBySourceId.get(candidate.ref.id)?.id)
        .filter((id): id is string => id !== undefined)
        .sort();
      const expectedExcludedIds =
        run.scope.kind === 'folder'
          ? authorizedFolders
              .filter(
                (candidate) =>
                  candidate.parentFolderId === folderId && !expectedFolderIds.has(candidate.ref.id)
              )
              .map((candidate) => candidate.ref.id)
              .sort()
          : [];
      if (
        collection.parentCollectionId !== expectedParentId ||
        canonicalStrings(collection.childCollectionIds) !== canonicalStrings(expectedChildIds) ||
        canonicalStrings(
          collection.excludedChildFolders.map((candidate) => candidate.sourceFolderId)
        ) !== canonicalStrings(expectedExcludedIds)
      ) {
        issues.push(
          blockingValidation(
            `Collection ${collection.id} does not reproduce its folder boundary.`,
            {
              sourceFolderId: folderId,
            }
          )
        );
      } else {
        validCollections += 1;
      }
    }
  }
  for (const sourceFolderId of collectionsBySourceId.keys()) {
    if (!expectedFolderIds.has(sourceFolderId)) {
      issues.push(
        blockingValidation(`Collection evidence escaped selected scope at ${sourceFolderId}.`, {
          sourceFolderId,
        })
      );
    }
  }

  const expectedMembershipPairs = expectedCollectionMemberships(sourceObjects, expectedFolderIds);
  let validMemberships = 0;
  const membershipBySourceId = uniqueMap(
    projection.objectMemberships,
    (membership) => membership.sourceObjectId
  );
  if (isLocalBundleRun(run)) {
    const selectedLocalObjects = sourceObjects.filter(
      (sourceObject) =>
        materializedSourceIds.has(sourceObject.id) ||
        sourceObject.memberships.some((membership) => expectedFolderIds.has(membership))
    );
    const selectedRelationships = new Map<string, SourceObject['relationships'][number]>();
    for (const sourceObject of selectedLocalObjects) {
      for (const relationship of sourceObject.relationships) {
        selectedRelationships.set(relationship.id, relationship);
      }
    }
    const exactDirectTargetIdentities = new Set(
      resolutions.flatMap((resolution) => {
        const selectedRelationship = selectedRelationships.get(resolution.relationshipId);
        return selectedRelationship?.sourceObjectId === resolution.sourceObjectId &&
          resolution.classification === 'exact' &&
          !resolution.requiresTargetedRead &&
          resolution.targetSourceId?.trim() &&
          exactRelationshipResolutionCaptureConflict({
            relationship: selectedRelationship,
            resolution,
            sourceObjects,
            benchlingOrigin,
            selectedSnapshotStableIdsAreAuthoritative: true,
          }) === null
          ? [resolution.targetSourceId.trim()]
          : [];
      })
    );
    const dependencyLocalObjects = sourceObjects.filter(
      (sourceObject) =>
        !selectedLocalObjects.includes(sourceObject) &&
        (exactDirectTargetIdentities.has(sourceObject.id) ||
          exactDirectTargetIdentities.has(sourceObject.stableId))
    );
    const expectedSelectedSourceObjectIds = selectedLocalObjects.map(
      (sourceObject) => sourceObject.id
    );
    const expectedDependencySourceObjectIds = dependencyLocalObjects.map(
      (sourceObject) => sourceObject.id
    );
    if (
      canonicalStrings(projection.selectedSourceObjectIds) !==
        canonicalStrings(expectedSelectedSourceObjectIds) ||
      canonicalStrings(projection.oneHopDependencySourceObjectIds) !==
        canonicalStrings(expectedDependencySourceObjectIds) ||
      membershipBySourceId.size !== sourceObjects.length ||
      selectedLocalObjects.length + dependencyLocalObjects.length !== sourceObjects.length
    ) {
      issues.push(
        blockingValidation(
          'Local Folder collection projection does not exactly cover its decoded source objects.'
        )
      );
    }
    for (const sourceObject of sourceObjects) {
      const sourceMembershipIds = [...new Set(sourceObject.memberships)].sort();
      const membership = membershipBySourceId.get(sourceObject.id);
      const dependency = dependencyLocalObjects.includes(sourceObject);
      const validMembershipCardinality = dependency
        ? sourceMembershipIds.length === 0 && sourceObject.relationships.length === 0
        : materializedSourceIds.has(sourceObject.id) || sourceMembershipIds.length > 0;
      if (
        sourceMembershipIds.length !== sourceObject.memberships.length ||
        !validMembershipCardinality ||
        !sourceMembershipIds.every((sourceFolderId) => expectedFolderIds.has(sourceFolderId)) ||
        !membership ||
        canonicalStrings(membership.sourceMembershipIds) !==
          canonicalStrings(sourceMembershipIds) ||
        membership.omittedSourceMembershipIds.length !== 0 ||
        membership.destinationCollectionIds.length !== sourceMembershipIds.length ||
        membership.scopeRole !== (dependency ? 'one_hop_dependency' : 'selected')
      ) {
        issues.push({
          code: 'validation_failed',
          message: `Local source object ${sourceObject.id} does not have the exact selected-scope memberships.`,
          blocking: true,
          sourceObjectId: sourceObject.id,
        });
      }
    }
  }
  const actualMemberships = projection.objectMemberships.reduce(
    (count, membership) => count + membership.destinationCollectionIds.length,
    0
  );
  for (const pair of expectedMembershipPairs) {
    const membership = membershipBySourceId.get(pair.sourceObjectId);
    const receipt = receiptBySourceId.get(pair.sourceObjectId);
    const collection = collectionsBySourceId.get(pair.sourceFolderId);
    if (
      !membership ||
      !receipt ||
      membership.destinationObjectId !== receipt.destinationObjectId ||
      !membership.sourceMembershipIds.includes(pair.sourceFolderId) ||
      !collection ||
      !membership.destinationCollectionIds.includes(collection.id) ||
      !collection.memberObjectIds.includes(receipt.destinationObjectId)
    ) {
      issues.push({
        code: 'validation_failed',
        message: `Collection membership ${pair.sourceObjectId} -> ${pair.sourceFolderId} is missing durable projection evidence.`,
        blocking: true,
        sourceObjectId: pair.sourceObjectId,
        details: { sourceFolderId: pair.sourceFolderId },
      });
    } else {
      validMemberships += 1;
    }
  }
  for (const collection of projection.collections) {
    for (const childId of collection.childCollectionIds) {
      if (!destinationCollectionIds.has(childId)) {
        issues.push(
          blockingValidation(`Collection ${collection.id} references missing child ${childId}.`)
        );
      }
    }
    if (
      collection.parentCollectionId &&
      !destinationCollectionIds.has(collection.parentCollectionId)
    ) {
      issues.push(
        blockingValidation(
          `Collection ${collection.id} references missing parent ${collection.parentCollectionId}.`
        )
      );
    }
  }
  issues.push(
    ...countIssues('collection memberships', expectedMembershipPairs.length, actualMemberships)
  );
  if (validMemberships !== expectedMembershipPairs.length) {
    issues.push(
      blockingValidation(
        `Only ${validMemberships} of ${expectedMembershipPairs.length} collection memberships have complete bidirectional evidence.`
      )
    );
  }

  return {
    ...section(expectedFolderIds.size, validCollections, deduplicateIssues(issues)),
    expectedMemberships: expectedMembershipPairs.length,
    actualMemberships,
    selectedRootSourceIds,
    evidence: projection.collections
      .map((collection) => ({
        sourceFolderId: collection.provenance.sourceFolderId,
        destinationCollectionId: collection.id,
        parentCollectionId: collection.parentCollectionId,
        childCollectionIds: [...collection.childCollectionIds].sort(),
        memberObjectIds: [...collection.memberObjectIds].sort(),
        excludedChildFolderIds: collection.excludedChildFolders
          .map((folder) => folder.sourceFolderId)
          .sort(),
      }))
      .sort((left, right) => left.sourceFolderId.localeCompare(right.sourceFolderId)),
  };
}

function validateRelationships(
  sourceObjects: SourceObject[],
  resolutions: RelationshipResolution[],
  options: Readonly<{
    targetSourceObjects: readonly SourceObject[];
    allowUnresolvedPlaceholders?: boolean;
    benchlingOrigin: string | undefined;
    selectedSnapshotStableIdsAreAuthoritative?: boolean;
  }>
): {
  expected: number;
  actual: number;
  countsByClass: Record<RelationshipResolutionClass, number>;
  issues: MigrationIssue[];
} {
  const relationships = sourceObjects.flatMap((sourceObject) => sourceObject.relationships);
  const relationshipsById = new Map(
    relationships.map((relationship) => [relationship.id, relationship] as const)
  );
  const relationshipIds = new Set(relationshipsById.keys());
  const resolutionCounts = countValues(resolutions.map((resolution) => resolution.relationshipId));
  const issues: MigrationIssue[] = [];
  const countsByClass = Object.fromEntries(
    RESOLUTION_CLASSES.map((classification) => [classification, 0])
  ) as Record<RelationshipResolutionClass, number>;

  for (const resolution of resolutions) {
    countsByClass[resolution.classification] += 1;

    if (!relationshipIds.has(resolution.relationshipId)) {
      issues.push({
        code: 'internal_invariant',
        message: `Relationship resolution ${resolution.relationshipId} has no captured source relationship.`,
        blocking: true,
        sourceObjectId: resolution.sourceObjectId,
        relationshipId: resolution.relationshipId,
      });
    }

    const capturedRelationship = relationshipsById.get(resolution.relationshipId);
    if (capturedRelationship) {
      const captureConflict = exactRelationshipResolutionCaptureConflict({
        relationship: capturedRelationship,
        resolution,
        sourceObjects: options.targetSourceObjects,
        benchlingOrigin: options.benchlingOrigin,
        selectedSnapshotStableIdsAreAuthoritative:
          options.selectedSnapshotStableIdsAreAuthoritative,
      });
      if (captureConflict) {
        issues.push({
          code: 'internal_invariant',
          message: `Exact relationship resolution ${resolution.relationshipId} conflicts with its immutable source capture: ${captureConflict}.`,
          blocking: true,
          sourceObjectId: resolution.sourceObjectId,
          relationshipId: resolution.relationshipId,
        });
      }
    }

    if ((resolutionCounts.get(resolution.relationshipId) ?? 0) !== 1) {
      issues.push({
        code: 'internal_invariant',
        message: `Relationship ${resolution.relationshipId} has multiple resolution records.`,
        blocking: true,
        sourceObjectId: resolution.sourceObjectId,
        relationshipId: resolution.relationshipId,
      });
    }

    if (resolution.classification === 'heuristic' || resolution.classification === 'ambiguous') {
      issues.push({
        code: 'validation_failed',
        message: `Internal relationship ${resolution.relationshipId} is ${resolution.classification}; exact evidence or explicit source-broken evidence is required.`,
        blocking: true,
        sourceObjectId: resolution.sourceObjectId,
        relationshipId: resolution.relationshipId,
        details: {
          classification: resolution.classification,
          candidateSourceIds: resolution.candidateSourceIds,
          reason: resolution.reason,
        },
      });
    }

    if (resolution.classification === 'unresolved') {
      issues.push({
        code: 'required_target_missing',
        message: options.allowUnresolvedPlaceholders
          ? `Relationship ${resolution.relationshipId} is retained as an offline placeholder; the selected local export did not include its target.`
          : resolution.requiresTargetedRead
            ? `Readable Benchling target for relationship ${resolution.relationshipId} was not acquired.`
            : `Internal relationship ${resolution.relationshipId} remains unresolved.`,
        blocking: !options.allowUnresolvedPlaceholders,
        sourceObjectId: resolution.sourceObjectId,
        relationshipId: resolution.relationshipId,
        details: {
          reason: resolution.reason,
          ...(options.allowUnresolvedPlaceholders ? { preservedAsPlaceholder: true } : {}),
        },
      });
    }
  }

  for (const relationship of relationships) {
    if (!resolutionCounts.has(relationship.id)) {
      issues.push({
        code: 'required_target_missing',
        message: `Relationship ${relationship.id} has no resolution evidence.`,
        blocking: true,
        sourceObjectId: relationship.sourceObjectId,
        relationshipId: relationship.id,
      });
    }
  }

  return {
    expected: relationships.length,
    actual: resolutions.length,
    countsByClass,
    issues: deduplicateIssues(issues),
  };
}

function validateHashes(
  snapshot: SourceSnapshot,
  sourceObjects: SourceObject[],
  receipts: ProjectionReceipt[],
  archiveIntegrity: ArchiveIntegrityEvidence,
  projectionIntegrity?: ProjectionIntegrityEvidence
): { expectedCount: number; validCount: number; issues: MigrationIssue[] } {
  const preservedRawSources = sourceObjects.flatMap((sourceObject) => {
    if (!isRecord(sourceObject.content)) return [];
    const rawAccess = sourceObject.content.rawAccess;
    if (!Object.prototype.hasOwnProperty.call(sourceObject.content, 'rawAccess')) return [];
    const value = sourceObject.content.sha256;
    const sizeBytes = sourceObject.content.sizeBytes;
    return [
      {
        value: typeof value === 'string' ? value : '',
        label: `preserved raw source on ${sourceObject.stableId}`,
        sourceObjectId: sourceObject.id,
        stableId: sourceObject.stableId,
        archivePartId:
          isRecord(rawAccess) && typeof rawAccess.archivePartId === 'string'
            ? rawAccess.archivePartId
            : '',
        entryPath:
          isRecord(rawAccess) && typeof rawAccess.entryPath === 'string' ? rawAccess.entryPath : '',
        sizeBytes: Number.isSafeInteger(sizeBytes) && (sizeBytes as number) >= 0 ? sizeBytes : -1,
      },
    ];
  });
  const hashes: Array<{ value: string; label: string; sourceObjectId?: string }> = [
    ...[...snapshot.parts]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((part) => ({
        value: part.sha256,
        label: `snapshot part ${part.id}`,
        sourceObjectId: part.sourceObjectId ?? undefined,
      })),
    ...sourceObjects.flatMap((sourceObject) =>
      sourceObject.attachmentHashes.map((value, index) => ({
        value: canonicalSha256Hex(value) ?? value,
        label: `attachment ${index + 1} on ${sourceObject.stableId}`,
        sourceObjectId: sourceObject.id,
      }))
    ),
    ...preservedRawSources.map(({ value, label, sourceObjectId }) => ({
      value: canonicalSha256Hex(value) ?? value,
      label,
      sourceObjectId,
    })),
    ...receipts.flatMap((receipt) => [
      {
        value: receipt.sourceHash,
        label: `source hash on receipt ${receipt.id}`,
        sourceObjectId: receipt.sourceObjectId,
      },
      {
        value: receipt.destinationHash,
        label: `destination hash on receipt ${receipt.id}`,
        sourceObjectId: receipt.sourceObjectId,
      },
    ]),
    ...(projectionIntegrity?.destinationIntegrity
      ? [
          {
            value: projectionIntegrity.destinationIntegrity.receiptLedgerSha256,
            label: 'canonical projection receipt ledger hash',
          },
          ...projectionIntegrity.destinationIntegrity.artifacts.map((artifact) => ({
            value: artifact.sha256,
            label: `destination artifact hash for ${artifact.path}`,
          })),
        ]
      : []),
  ];

  const issues: MigrationIssue[] = [];
  let validCount = 0;
  for (const hash of hashes) {
    if (SHA256_HEX.test(hash.value)) {
      validCount += 1;
    } else {
      issues.push({
        code: 'hash_mismatch',
        message: `Invalid SHA-256 for ${hash.label}.`,
        blocking: true,
        sourceObjectId: hash.sourceObjectId,
        details: { value: hash.value },
      });
    }
  }

  const manifestEntriesByRawSource = new Map<string, ArchiveIntegrityEvidence['manifestEntries']>();
  for (const entry of archiveIntegrity.manifestEntries) {
    const key = rawManifestAssociationKey(
      entry.sourceObjectId,
      entry.archivePartId,
      entry.entryPath,
      canonicalSha256Hex(entry.sha256),
      entry.sizeBytes
    );
    const entries = manifestEntriesByRawSource.get(key) ?? [];
    entries.push(entry);
    manifestEntriesByRawSource.set(key, entries);
  }
  const snapshotPartById = new Map(
    archiveIntegrity.snapshotParts.map((part) => [part.partId, part])
  );
  for (const preserved of preservedRawSources) {
    const normalized = canonicalSha256Hex(preserved.value);
    const preservedSizeBytes = typeof preserved.sizeBytes === 'number' ? preserved.sizeBytes : null;
    const manifestMatches =
      manifestEntriesByRawSource.get(
        rawManifestAssociationKey(
          preserved.sourceObjectId,
          preserved.archivePartId,
          preserved.entryPath,
          normalized,
          preservedSizeBytes
        )
      ) ?? [];
    const manifestMatch = manifestMatches.length === 1 ? manifestMatches[0] : null;
    const candidatePartIds = new Set([
      preserved.archivePartId,
      ...(manifestMatch?.containerPartId ? [manifestMatch.containerPartId] : []),
    ]);
    const partMatches = [...candidatePartIds]
      .map((partId) => snapshotPartById.get(partId))
      .filter(
        (part): part is ArchiveIntegrityEvidence['snapshotParts'][number] => part !== undefined
      );
    const part = partMatches.length === 1 ? partMatches[0] : null;
    const nestedSupplementalAssociationValid =
      part !== null &&
      manifestMatch !== null &&
      part.kind === 'supplemental_local_export' &&
      part.partId === manifestMatch.containerPartId &&
      part.sourceObjectId === preserved.sourceObjectId &&
      canonicalSha256Hex(part.sha256) === canonicalSha256Hex(manifestMatch.containerSha256 ?? '') &&
      part.sizeBytes === manifestMatch.containerSizeBytes;
    const nestedLocalExportAssociationValid =
      part !== null &&
      manifestMatch !== null &&
      part.kind === 'local_export' &&
      part.partId === manifestMatch.containerPartId &&
      part.sourceObjectId === null &&
      canonicalSha256Hex(part.sha256) === canonicalSha256Hex(manifestMatch.containerSha256 ?? '') &&
      part.sizeBytes === manifestMatch.containerSizeBytes;
    const directPartAssociationValid =
      part !== null &&
      (part.kind === 'export_archive'
        ? part.sourceObjectId === null
        : part.sourceObjectId === preserved.sourceObjectId &&
          canonicalSha256Hex(part.sha256) === normalized &&
          part.sizeBytes === preservedSizeBytes);
    const partAssociationValid =
      nestedSupplementalAssociationValid ||
      nestedLocalExportAssociationValid ||
      directPartAssociationValid;
    if (
      !normalized ||
      preserved.archivePartId.length === 0 ||
      preserved.entryPath.length === 0 ||
      preservedSizeBytes === null ||
      preservedSizeBytes < 0 ||
      manifestMatches.length !== 1 ||
      !partAssociationValid
    ) {
      issues.push({
        code: 'hash_mismatch',
        message: `Preserved raw source ${preserved.entryPath || '(missing path)'} on ${preserved.stableId} is not exactly linked to one verified archive manifest entry and parent part.`,
        blocking: true,
        sourceObjectId: preserved.sourceObjectId,
        details: {
          archivePartId: preserved.archivePartId,
          entryPath: preserved.entryPath,
          sha256: preserved.value,
          sizeBytes: preservedSizeBytes,
          manifestMatchCount: manifestMatches.length,
          snapshotPartMatchCount: partMatches.length,
          manifestContainerPartId: manifestMatch?.containerPartId ?? null,
          manifestContainerSha256: manifestMatch?.containerSha256 ?? null,
          manifestContainerSizeBytes: manifestMatch?.containerSizeBytes ?? null,
          snapshotPartKind: part?.kind ?? null,
          snapshotPartSha256: part?.sha256 ?? null,
          snapshotPartSizeBytes: part?.sizeBytes ?? null,
        },
      });
    }
  }

  for (const failure of projectionIntegrity?.failures ?? []) {
    issues.push({
      code: 'hash_mismatch',
      message: failure.message,
      blocking: true,
      ...(failure.sourceObjectId ? { sourceObjectId: failure.sourceObjectId } : {}),
      details: {
        receiptId: failure.receiptId,
        destinationPath: failure.destinationPath,
      },
    });
  }
  issues.push(...countIssues('hashes', hashes.length, validCount, 'hash_mismatch'));
  return { expectedCount: hashes.length, validCount, issues };
}

function rawManifestAssociationKey(
  sourceObjectId: string | null,
  archivePartId: string | null,
  entryPath: string,
  sha256: string | null,
  sizeBytes: number | null
): string {
  return JSON.stringify([sourceObjectId, archivePartId, entryPath, sha256, sizeBytes]);
}

function validateRendering(
  renderChecks: MigrationRenderCheck[],
  sourceObjectIds: Set<string>,
  expectedRenderObjectIds: string[]
): { passedCount: number; issues: MigrationIssue[] } {
  const issues: MigrationIssue[] = [];
  let passedCount = 0;
  const expectedIds = new Set(expectedRenderObjectIds);
  const checkCounts = countValues(renderChecks.map((check) => check.sourceObjectId));

  for (const sourceObjectId of expectedIds) {
    if (!sourceObjectIds.has(sourceObjectId)) {
      issues.push({
        code: 'validation_failed',
        message: `Required render target ${sourceObjectId} is outside the captured snapshot.`,
        blocking: true,
        sourceObjectId,
      });
    } else if ((checkCounts.get(sourceObjectId) ?? 0) !== 1) {
      issues.push({
        code: 'validation_failed',
        message: `Required render target ${sourceObjectId} has ${checkCounts.get(sourceObjectId) ?? 0} checks; exactly one is required.`,
        blocking: true,
        sourceObjectId,
      });
    }
  }

  for (const check of renderChecks) {
    const referencesCapturedObject = sourceObjectIds.has(check.sourceObjectId);
    const wasExpected = expectedIds.has(check.sourceObjectId);
    if (
      check.passed &&
      referencesCapturedObject &&
      wasExpected &&
      checkCounts.get(check.sourceObjectId) === 1
    ) {
      passedCount += 1;
    }
    if (!referencesCapturedObject) {
      issues.push({
        code: 'validation_failed',
        message: `Render check references unknown source object ${check.sourceObjectId}.`,
        blocking: true,
        sourceObjectId: check.sourceObjectId,
      });
    } else if (!wasExpected) {
      issues.push({
        code: 'validation_failed',
        message: `Render check for ${check.sourceObjectId} was not in the deterministic validation sample.`,
        blocking: true,
        sourceObjectId: check.sourceObjectId,
      });
    } else if (!check.passed) {
      issues.push({
        code: 'validation_failed',
        message: check.message ?? `Destination render failed for ${check.sourceObjectId}.`,
        blocking: true,
        sourceObjectId: check.sourceObjectId,
      });
    }
  }

  return { passedCount, issues };
}

function expectedCollectionFolderIds(
  run: MigrationRun,
  folderById: ReadonlyMap<string, ScopedFolderMetadata>,
  appendedFolderIds: ReadonlySet<string>,
  issues: MigrationIssue[]
): Set<string> {
  const rootIds = scopeRootIds(run);
  for (const rootId of rootIds) {
    if (!folderById.has(rootId)) {
      issues.push(
        blockingValidation(`Selected folder ${rootId} is absent from the persisted scope boundary.`)
      );
    }
  }
  if (run.scope.kind === 'folder') return new Set([...rootIds, ...appendedFolderIds]);
  if (run.scope.kind === 'file') return new Set();

  const roots = new Set(rootIds);
  const included = new Set<string>();
  for (const folder of folderById.values()) {
    let current: ScopedFolderMetadata | undefined = folder;
    const visited = new Set<string>();
    while (current) {
      if (visited.has(current.ref.id)) {
        issues.push(blockingValidation(`Folder boundary contains a cycle at ${current.ref.id}.`));
        break;
      }
      visited.add(current.ref.id);
      if (roots.has(current.ref.id)) {
        included.add(folder.ref.id);
        break;
      }
      current = current.parentFolderId ? folderById.get(current.parentFolderId) : undefined;
    }
  }
  return included;
}

function scopeRootIds(run: MigrationRun): string[] {
  if (run.scope.kind === 'file') return [];
  if (run.scope.kind === 'folder') return [run.scope.folder.id];
  return [...new Set(run.scope.roots.map((root) => root.id))].sort();
}

function expectedCollectionMemberships(
  sourceObjects: readonly SourceObject[],
  expectedFolderIds: ReadonlySet<string>
): Array<{ sourceObjectId: string; sourceFolderId: string }> {
  return sourceObjects
    .flatMap((sourceObject) =>
      [...new Set(sourceObject.memberships)]
        .filter((sourceFolderId) => expectedFolderIds.has(sourceFolderId))
        .map((sourceFolderId) => ({ sourceObjectId: sourceObject.id, sourceFolderId }))
    )
    .sort(
      (left, right) =>
        left.sourceObjectId.localeCompare(right.sourceObjectId) ||
        left.sourceFolderId.localeCompare(right.sourceFolderId)
    );
}

function formulaEvidenceKey(entry: {
  sourceObjectId: string;
  locator: string;
  formula: string;
}): string {
  return `${entry.sourceObjectId}\0${entry.locator}\0${entry.formula}`;
}

function canonicalStrings(values: readonly string[]): string {
  return JSON.stringify([...new Set(values)].sort());
}

function uniqueMap<T>(values: readonly T[], key: (value: T) => string): Map<string, T> {
  return new Map(values.map((value) => [key(value), value]));
}

function blockingValidation(message: string, details?: Record<string, unknown>): MigrationIssue {
  return {
    code: 'validation_failed',
    message,
    blocking: true,
    ...(details ? { details } : {}),
  };
}

function blockingInvariant(message: string, details?: Record<string, unknown>): MigrationIssue {
  return {
    code: 'internal_invariant',
    message,
    blocking: true,
    ...(details ? { details } : {}),
  };
}

function section(expected: number, actual: number, issues: MigrationIssue[]): ValidationSection {
  return {
    expected,
    actual,
    passed: expected === actual && !issues.some((issue) => issue.blocking),
    issues: [...issues],
  };
}

function countIssues(
  label: string,
  expected: number,
  actual: number,
  code: MigrationIssue['code'] = 'validation_failed'
): MigrationIssue[] {
  if (expected === actual) return [];
  return [
    {
      code,
      message: `Expected ${expected} ${label}, but validated ${actual}.`,
      blocking: true,
      details: { expected, actual },
    },
  ];
}

function countValues(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function compareSourceObjects(left: SourceObject, right: SourceObject): number {
  return left.stableId.localeCompare(right.stableId) || left.id.localeCompare(right.id);
}

function compareBySourceIdentity<T extends { sourceObjectId: string }>(
  left: T,
  right: T,
  stableIdentityById: Map<string, string>,
  tieBreaker: keyof T
): number {
  const leftIdentity = stableIdentityById.get(left.sourceObjectId) ?? left.sourceObjectId;
  const rightIdentity = stableIdentityById.get(right.sourceObjectId) ?? right.sourceObjectId;
  return (
    leftIdentity.localeCompare(rightIdentity) ||
    String(left[tieBreaker] ?? '').localeCompare(String(right[tieBreaker] ?? ''))
  );
}

function sortIssues(
  issues: MigrationIssue[],
  stableIdentityById: Map<string, string>
): MigrationIssue[] {
  return [...issues].sort((left, right) => {
    const leftIdentity = left.sourceObjectId
      ? (stableIdentityById.get(left.sourceObjectId) ?? left.sourceObjectId)
      : '';
    const rightIdentity = right.sourceObjectId
      ? (stableIdentityById.get(right.sourceObjectId) ?? right.sourceObjectId)
      : '';
    return (
      leftIdentity.localeCompare(rightIdentity) ||
      (left.relationshipId ?? '').localeCompare(right.relationshipId ?? '') ||
      left.code.localeCompare(right.code) ||
      left.message.localeCompare(right.message)
    );
  });
}

function deduplicateIssues(issues: MigrationIssue[]): MigrationIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = [issue.code, issue.sourceObjectId, issue.relationshipId, issue.message].join('\0');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
