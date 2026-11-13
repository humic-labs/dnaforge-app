import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFileTestDb, createTestDb, openFileTestDb } from '../__tests__/test-db';
import {
  isValidationReportV2,
  type ExportJob,
  type MigrationRun,
  type ProjectionReceipt,
  type ProviderActivityBundle,
  type ProviderCommandJournalEntry,
  type ProviderTaskGmailRescanAuthorization,
  type ProviderTaskEvidence,
  type RelationshipResolution,
  type SourceSnapshot,
  type MigrationScope,
  type SourceSnapshotPart,
  type SourceObject,
  type ValidationReport,
} from '../../shared/benchling-migration';
import { transitionMigrationRun } from './state-machine';
import { createNativeExportDownloadAcceptanceEvidence } from './native-export-download-acceptance';
import { providerTaskHandleHash, providerTaskReceiptId } from './provider-task-handle';
import { scientificSourceObjectSha256 } from './linked-item-recovery-decoder';
import { projectionSourceHash } from './projection';
import {
  buildDirectFolderCapturePlan,
  directFolderProviderPreflightFromPlan,
} from './direct-folder-capture-plan';
import {
  appendScopedFolderTraversalPage,
  createScopedFolderTraversalJournal,
  nextScopedFolderTraversalPage,
  scopedFolderTraversalPageDigest,
  scopedFolderTraversalPageRequestSha256,
} from './scoped-folder-traversal-journal';
import {
  LEGACY_PROVIDER_TASK_SESSION_LOCATOR_UNAVAILABLE_REASON,
  LEGACY_SCOPED_ITEM_URL_AUTHORITY_UNAVAILABLE_REASON,
  MigrationStore,
  RecoveredSourceObjectContentConflictError,
  SourceObjectContentConflictError,
  type LinkedItemRecoveryArtifact,
  type LinkedItemRecoveryAttempt,
  type LinkedItemRecoveryCapture,
  type PersistedExportCapture,
  type PersistedSourceObjectVersion,
  type WorkspaceAppendHierarchyCapture,
} from './store';

function makeRun(overrides: Partial<MigrationRun> = {}): MigrationRun {
  return {
    version: 1,
    id: 'run-1',
    workspaceId: 'workspace-1',
    workspacePath: '/tmp/workspace-1/repo',
    displayName: 'Benchling import',
    scope: {
      version: 1,
      kind: 'file',
      source: {
        id: 'seq_1',
        url: 'https://example.benchling.com/example/seq_1',
        objectType: 'dna_sequence',
      },
    },
    binding: null,
    state: 'draft',
    resumeState: null,
    attempt: 0,
    converterVersions: { artifact: '1' },
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
    startedAt: null,
    unlockedAt: null,
    lastError: null,
    ...overrides,
  };
}

function makeReceipt(
  overrides: Partial<Extract<ProjectionReceipt, { destination?: undefined }>> = {}
): ProjectionReceipt {
  return {
    id: 'receipt-1',
    runId: 'run-1',
    sourceObjectId: 'seq_1',
    destinationObjectId: 'sequence/seq_1',
    destinationPath: 'Benchling Imports/sequence__seq_1.gb',
    projection: 'native',
    converterId: 'genbank',
    converterVersion: '1',
    sourceHash: 'a'.repeat(64),
    destinationHash: 'b'.repeat(64),
    warnings: [],
    exception: null,
    createdAt: '2026-07-17T00:00:01.000Z',
    ...overrides,
  };
}

function makeReadyLocalRecoveryRun(): MigrationRun {
  return makeRun({
    scope: {
      version: 1,
      kind: 'folder',
      folder: {
        id: 'lib_local_recovery',
        url: 'https://benchling.com/example/f_/lib_local_recovery/',
        objectType: 'folder',
      },
      includeChildren: false,
      includeArchived: false,
      acquisition: 'local_bundle',
    },
    binding: null,
    state: 'ready_to_unlock',
    startedAt: '2026-08-13T10:00:00.000Z',
    updatedAt: '2026-08-13T10:00:05.000Z',
    localExportArtifact: {
      schema: 'dnaforge.benchling.local-export-artifact.v1',
      format: 'zip',
      logicalFilename: 'original.zip',
      sha256: `sha256:${'1'.repeat(64)}`,
      sizeBytes: 1_000,
      immutableLocalPath: '/private/archive/original',
      capturedAt: '2026-08-13T10:00:01.000Z',
      archive: {
        entryCount: 10,
        totalCompressedEntryBytes: 800,
        totalUncompressedEntryBytes: 1_600,
      },
      resources: [],
    },
  });
}

function makeRecoveryIntake(index: number) {
  return {
    schema: 'dnaforge.benchling.local-export-intake.v1',
    sourcePath: `/Users/scientist/Downloads/supplement-${index}.zip`,
    logicalFilename: `supplement-${index}.zip`,
    format: 'zip',
    selectedAt: `2026-08-13T10:01:0${index}.000Z`,
    sourceIdentity: {
      deviceId: '1',
      inode: String(100 + index),
      sizeBytes: 100 + index,
      modifiedTimeNs: String(1_000 + index),
      changedTimeNs: String(2_000 + index),
    },
    plannedResources: [],
    plannedCopyBytes: 100 + index,
  } as const;
}

function makeRecoveryAttempt(
  overrides: Partial<LinkedItemRecoveryAttempt> = {}
): LinkedItemRecoveryAttempt {
  const descriptors = [makeRecoveryIntake(1), makeRecoveryIntake(2)];
  return {
    schema: 'dnaforge.benchling.linked-item-recovery-attempt.v1',
    id: 'linked-recovery-attempt-1',
    runId: 'run-1',
    mode: 'linked_item_recovery',
    state: 'copying',
    resumeState: null,
    recoveryPlan: {
      schema: 'dnaforge.benchling.linked-item-recovery-validation.v1',
      organizationBaseUrl: 'https://benchling.com/example',
      relationshipCount: 1,
      uniqueTargetCount: 1,
      folderCount: 1,
      recoveredUniqueObjectCount: 0,
      remainingUniqueObjectCount: 1,
      repairedRelationshipCount: 0,
      remainingRelationshipCount: 1,
      folders: [
        {
          sourceId: 'lib_EXAMPLE1',
          name: 'Example folder',
          sourceUrl: 'https://benchling.com/example/f/lib_EXAMPLE1-example-folder',
          targetCount: 1,
          relationshipCount: 1,
          countsByType: {
            dna_rna_sequence: 1,
            protein: 0,
            protocol: 0,
            other: 0,
          },
          recoveredTargetCount: 0,
        },
      ],
      targets: [
        {
          sourceId: 'seq_EXAMPLE1',
          name: 'Example sequence',
          sourceUrl:
            'https://benchling.com/example/f/lib_EXAMPLE1-example-folder/seq_EXAMPLE1-example-sequence',
          objectType: 'dna_rna_sequence',
          folderId: 'lib_EXAMPLE1',
          relationshipCount: 1,
          relationshipIds: ['rel_EXAMPLE1'],
          recovered: false,
        },
      ],
      attempts: [],
    },
    intakeDescriptors: descriptors,
    fileResults: [],
    artifactIds: [],
    selectedFileCount: descriptors.length,
    processedFileCount: 0,
    recoveredUniqueObjectCount: 0,
    repairedRelationshipCount: 0,
    retainedExistingObjectCount: 0,
    retainedExistingObjects: [],
    corroboratedExistingObjectCount: 0,
    pendingImportDecision: null,
    pendingImportDecisionResumeState: null,
    versionConflictResolution: { kind: 'none' },
    createdAt: '2026-08-13T10:01:00.000Z',
    updatedAt: '2026-08-13T10:01:00.000Z',
    completedAt: null,
    safeFailure: null,
    ...overrides,
  };
}

function makeRecoveryArtifact(
  overrides: Partial<
    Extract<
      LinkedItemRecoveryArtifact,
      { schema: 'dnaforge.benchling.linked-item-recovery-artifact.v1' }
    >
  > = {}
): Extract<
  LinkedItemRecoveryArtifact,
  { schema: 'dnaforge.benchling.linked-item-recovery-artifact.v1' }
> {
  return {
    schema: 'dnaforge.benchling.linked-item-recovery-artifact.v1',
    id: 'linked-recovery-artifact-1',
    runId: 'run-1',
    attemptId: 'linked-recovery-attempt-1',
    fileIndex: 0,
    artifact: {
      schema: 'dnaforge.benchling.local-export-artifact.v1',
      format: 'zip',
      logicalFilename: 'supplement-1.zip',
      sha256: `sha256:${'2'.repeat(64)}`,
      sizeBytes: 101,
      immutableLocalPath: '/private/archive/supplement-1',
      capturedAt: '2026-08-13T10:01:02.000Z',
      archive: {
        entryCount: 2,
        totalCompressedEntryBytes: 80,
        totalUncompressedEntryBytes: 160,
      },
      resources: [],
    },
    ...overrides,
  };
}

function makeAppendHierarchyCapture(
  overrides: Partial<WorkspaceAppendHierarchyCapture> = {}
): WorkspaceAppendHierarchyCapture {
  return {
    schema: 'dnaforge.benchling.workspace-append-hierarchy-capture.v1',
    id: 'workspace-append-hierarchy-capture-1',
    runId: 'run-1',
    attemptId: 'linked-recovery-attempt-1',
    artifactId: 'linked-recovery-artifact-1',
    artifactSha256: `sha256:${'2'.repeat(64)}`,
    destinationRootSourceId: 'lib_local_recovery',
    zipRootName: 'Selected Root',
    folders: [
      {
        sourceId: 'local_folder_dfa1f4dc02a6b986cfb6e54c',
        name: 'Alpha',
        parentSourceId: 'lib_local_recovery',
        archiveRelativePath: 'Alpha',
      },
    ],
    memberships: [
      {
        sourceObjectId: 'bfi_APPENDREGISTRY',
        folderSourceId: 'local_folder_dfa1f4dc02a6b986cfb6e54c',
      },
      {
        sourceObjectId: 'seq_APPEND',
        folderSourceId: 'local_folder_dfa1f4dc02a6b986cfb6e54c',
      },
    ],
    capturedAt: '2026-08-13T10:01:04.000Z',
    ...overrides,
  };
}

function makeRecoveredSourceObject(overrides: Partial<SourceObject> = {}): SourceObject {
  return {
    id: 'seq_recovered',
    stableId: 'seq_recovered',
    sourceType: 'dna_sequence',
    name: 'Recovered plasmid',
    aliases: [],
    sourceUrl: 'https://benchling.com/example/seq_recovered',
    sourcePath: 'Recovered plasmid (seq_recovered).gb',
    attachmentHashes: [],
    memberships: [],
    metadata: {
      nativeExport: { entryPath: 'Recovered plasmid (seq_recovered).gb' },
      linkedItemRecovery: { supplementaryExportSha256: `sha256:${'2'.repeat(64)}` },
    },
    content: { sequence: 'ATGC' },
    relationships: [],
    ...overrides,
  };
}

function makeBoundRun(overrides: Partial<MigrationRun> = {}): MigrationRun {
  return makeRun({
    binding: {
      version: 1,
      benchlingOrigin: 'https://example.benchling.com',
      benchlingAccountId: 'usr_1',
      benchlingAccountEmail: 'scientist@example.edu',
      benchlingOrganizationId: 'wrk_1',
      benchlingOrganizationName: 'Example Lab',
      chromePairingId: 'pairing-1',
      accountHash: 'sha256:account',
      confirmedAt: '2026-07-17T00:00:00Z',
    },
    ...overrides,
  });
}

function makeExportJob(overrides: Partial<ExportJob> = {}): ExportJob {
  return {
    id: 'export-job-1',
    runId: 'run-1',
    contentFamily: 'notebook',
    sourceRoots: [
      {
        id: 'fld_1',
        url: 'https://example.benchling.com/example/folders/fld_1',
        objectType: 'folder',
      },
    ],
    matchSignature: 'benchling-export:exact-signature',
    state: 'planned',
    submittedAt: null,
    attempts: 0,
    receiptId: null,
    downloadUrlHash: null,
    snapshotPartId: null,
    ...overrides,
  };
}

function makeProviderTaskEvidence(
  overrides: Partial<ProviderTaskEvidence> = {}
): ProviderTaskEvidence {
  return {
    id: 'provider-task:evidence-1',
    runId: 'run-1',
    jobId: 'export-job-1',
    matchSignature: 'benchling-export:exact-signature',
    providerTaskHandleSha256:
      'sha256:123e4567e89b12d3a456426614174000123e4567e89b12d3a456426614174000',
    status: 'RUNNING',
    actionRequired: null,
    observedAt: '2026-07-17T00:00:02.000Z',
    ...overrides,
  };
}

type DirectFolderGmailPageRescanAuthorization = Extract<
  ProviderTaskGmailRescanAuthorization,
  { schema: 'dnaforge.benchling.provider-task-direct-folder-gmail-rescan.v2' }
>;

type DirectFolderSequenceGmailRecoveryAuthorization = Extract<
  ProviderTaskGmailRescanAuthorization,
  {
    schema: 'dnaforge.benchling.provider-task-direct-folder-sequence-gmail-recovery.v1';
  }
>;

type DirectFolderSucceededGmailRecoveryAuthorization = Extract<
  ProviderTaskGmailRescanAuthorization,
  {
    schema: 'dnaforge.benchling.provider-task-direct-folder-succeeded-gmail-recovery.v1';
  }
>;

function makeDirectFolderSequenceGmailRecoveryCommand(
  runAttempt: number,
  priorCapabilityRunAttempt: number
): ProviderCommandJournalEntry {
  const directFolderGmailRescan: DirectFolderSequenceGmailRecoveryAuthorization = {
    schema: 'dnaforge.benchling.provider-task-direct-folder-sequence-gmail-recovery.v1',
    scopeKind: 'folder',
    dispatchMode: 'gmail_page_only',
    runId: 'run-1',
    jobId: 'export-job-1',
    matchSignature: 'benchling-export:exact-signature',
    runAttempt,
    priorCapabilityRunAttempt,
    pageReadOrdinal: 1,
    pageReadLimit: 1,
    requiredProviderTaskStatus: 'ACTION_REQUIRED',
    priorActionRequiredCode: 'provider_task_status_undocumented',
    priorDiagnostic: 'unrecognized_status',
    interventionSha256: `sha256:${String(runAttempt).repeat(64)}`,
    directFolderAuthorityDigest: `sha256:${'2'.repeat(64)}`,
    directFolderSourceItemNameSha256: `sha256:${'3'.repeat(64)}`,
    nativeExportLedgerEpoch: 'native-ledger-epoch:11111111111111111111111111111111',
    originalCommandRequestId: 'command:direct-folder-sequence-submit',
    providerTaskHandleSha256: `sha256:${'6'.repeat(64)}`,
  };
  return {
    id: `provider-command-direct-folder-sequence-recovery-${runAttempt}`,
    runId: 'run-1',
    commandRequestId: `command:direct-folder-sequence-recovery-${runAttempt}`,
    operationKind: 'poll_export_receipts',
    directFolderGmailRescan,
    issuedAt: `2026-07-17T00:00:0${runAttempt}.000Z`,
  };
}

function makeDirectFolderSucceededGmailRecoveryCommand(): ProviderCommandJournalEntry {
  const directFolderGmailRescan: DirectFolderSucceededGmailRecoveryAuthorization = {
    schema: 'dnaforge.benchling.provider-task-direct-folder-succeeded-gmail-recovery.v1',
    scopeKind: 'folder',
    dispatchMode: 'gmail_page_only',
    runId: 'run-1',
    jobId: 'export-job-1',
    matchSignature: 'benchling-export:exact-signature',
    runAttempt: 4,
    priorCapabilityRunAttempt: 3,
    recoveryOrdinal: 1,
    pageReadOrdinal: 1,
    pageReadLimit: 1,
    requiredProviderTaskStatus: 'SUCCEEDED',
    interventionSha256: `sha256:${'1'.repeat(64)}`,
    directFolderAuthorityDigest: `sha256:${'2'.repeat(64)}`,
    directFolderSourceItemNameSha256: `sha256:${'3'.repeat(64)}`,
    nativeExportLedgerEpoch: 'native-ledger-epoch:11111111111111111111111111111111',
    originalCommandRequestId: 'command:direct-folder-notebook-submit',
    providerTaskHandleSha256: `sha256:${'6'.repeat(64)}`,
    rootSucceededCommandRequestId: 'command:direct-folder-notebook-succeeded-root',
    rootSucceededActivitySha256: `sha256:${'4'.repeat(64)}`,
    priorRecoveryCommandRequestId: 'command:direct-folder-notebook-succeeded-root',
    priorRecoveryActivitySha256: `sha256:${'4'.repeat(64)}`,
  };
  return {
    id: 'provider-command-direct-folder-succeeded-recovery-1',
    runId: 'run-1',
    commandRequestId: 'command:direct-folder-succeeded-recovery-1',
    operationKind: 'poll_export_receipts',
    directFolderGmailRescan,
    issuedAt: '2026-07-17T00:00:04.000Z',
  };
}

function makeDirectFolderGmailPageRescanCommand(): ProviderCommandJournalEntry {
  const directFolderGmailRescan: DirectFolderGmailPageRescanAuthorization = {
    schema: 'dnaforge.benchling.provider-task-direct-folder-gmail-rescan.v2',
    scopeKind: 'folder',
    dispatchMode: 'gmail_page_only',
    runId: 'run-1',
    jobId: 'export-job-1',
    matchSignature: 'benchling-export:exact-signature',
    runAttempt: 3,
    priorCapabilityRunAttempt: 2,
    rescanOrdinal: 2,
    pageReadOrdinal: 1,
    pageReadLimit: 1,
    requiredProviderTaskStatus: 'RUNNING',
    interventionSha256: `sha256:${'1'.repeat(64)}`,
    directFolderAuthorityDigest: `sha256:${'2'.repeat(64)}`,
    directFolderSourceItemNameSha256: `sha256:${'3'.repeat(64)}`,
    nativeExportLedgerEpoch: 'native-ledger-epoch:11111111111111111111111111111111',
    originalCommandRequestId: 'command:direct-folder-submit',
    providerTaskHandleSha256: `sha256:${'6'.repeat(64)}`,
    priorFallbackCommandRequestId: 'command:direct-folder-request-40-miss',
    priorFallbackActivitySha256: `sha256:${'4'.repeat(64)}`,
    rootRescanCommandRequestId: 'command:direct-folder-root-rescan',
    rootRescanActivitySha256: `sha256:${'5'.repeat(64)}`,
    priorRescanCommandRequestId: 'command:direct-folder-root-rescan',
    priorRescanActivitySha256: `sha256:${'5'.repeat(64)}`,
  };
  return {
    id: 'provider-command-direct-folder-page-rescan-2',
    runId: 'run-1',
    commandRequestId: 'command:direct-folder-page-rescan-2',
    operationKind: 'poll_export_receipts',
    directFolderGmailRescan,
    issuedAt: '2026-07-17T00:00:03.000Z',
  };
}

const LEGACY_PROVIDER_TASK_ID = '123e4567-e89b-12d3-a456-426614174000';

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

function seedLegacyDirectProviderTaskPrivacyDatabase(db: ReturnType<typeof createTestDb>): {
  run: MigrationRun;
  job: ExportJob;
  expectedHandle: string;
  evidenceIds: string[];
  commandId: string;
} {
  new MigrationStore(db).close();
  const run = makeBoundRun({
    scope: {
      version: 1,
      kind: 'folder',
      folder: {
        id: 'lib_ROOT',
        url: 'https://example.benchling.com/example/f_/lib_ROOT-direct-folder',
        objectType: 'folder',
      },
      includeChildren: false,
    },
    state: 'downloading',
    resumeState: null,
    attempt: 1,
    startedAt: '2026-07-17T00:00:00.000Z',
  });
  const authority: NonNullable<ExportJob['directFolderAuthority']> = {
    schema: 'dnaforge.benchling.direct-folder-export-authority.v1',
    capturePlanDigest: `sha256:${'a'.repeat(64)}`,
    traversalJournalDigest: `sha256:${'b'.repeat(64)}`,
    selectedRootId: 'lib_ROOT',
    sourceItemId: 'etr_LegacyNotebook',
    sourceItemType: 'entry',
    sourceFolderIds: ['lib_ROOT'],
    requestCapabilityId: 'benchling.notebook-entry-html-export.v1',
  };
  const job = makeExportJob({
    id: 'export-job-legacy-direct',
    sourceRoots: [
      {
        id: authority.sourceItemId,
        url: run.scope.kind === 'folder' ? run.scope.folder.url : '',
        objectType: 'entry',
      },
    ],
    directFolderAuthority: authority,
    state: 'receipt_pending',
    submittedAt: '2026-07-17T00:00:01.000Z',
    attempts: 1,
  });
  const authorityDigest = legacyDirectFolderAuthorityDigest(authority);
  const expectedHandle = providerTaskHandleHash({
    binding: run.binding!,
    providerTaskId: LEGACY_PROVIDER_TASK_ID,
    jobId: job.id,
    matchSignature: job.matchSignature,
    directFolderAuthorityDigest: authorityDigest,
  });
  db.prepare(
    `INSERT INTO migration_run (singleton, id, state, body_json, updated_at)
     VALUES (1, ?, ?, ?, ?)`
  ).run(run.id, run.state, JSON.stringify(run), run.updatedAt);
  db.prepare(
    `INSERT INTO export_job
       (id, run_id, match_signature, state, submitted_at, attempts, body_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    job.id,
    job.runId,
    job.matchSignature,
    job.state,
    job.submittedAt,
    job.attempts,
    JSON.stringify(job)
  );
  const evidenceIds = [`provider-task:${'c'.repeat(64)}`, `provider-task:${'d'.repeat(64)}`];
  for (const [index, evidenceId] of evidenceIds.entries()) {
    const legacyEvidence = {
      id: evidenceId,
      runId: run.id,
      jobId: job.id,
      matchSignature: job.matchSignature,
      providerTaskId: LEGACY_PROVIDER_TASK_ID,
      statusPath: `/1/api/tasks/${LEGACY_PROVIDER_TASK_ID}`,
      status: index === 0 ? 'RUNNING' : 'SUCCEEDED',
      actionRequired: null,
      observedAt: `2026-07-17T00:00:0${index + 2}.000Z`,
    };
    db.prepare(
      `INSERT INTO provider_task_evidence (id, run_id, body_json)
       VALUES (?, ?, ?)`
    ).run(evidenceId, run.id, JSON.stringify(legacyEvidence));
  }
  const currentCommand = makeDirectFolderGmailPageRescanCommand();
  const currentAuthorization = currentCommand.directFolderGmailRescan!;
  const {
    providerTaskHandleSha256: _discardedHandle,
    directFolderAuthorityDigest: _discardedDigest,
    ...authorizationWithoutHandle
  } = currentAuthorization;
  const commandId = currentCommand.id;
  const legacyCommand = {
    ...currentCommand,
    runId: run.id,
    directFolderGmailRescan: {
      ...authorizationWithoutHandle,
      runId: run.id,
      jobId: job.id,
      matchSignature: job.matchSignature,
      directFolderAuthorityDigest: authorityDigest,
      providerTaskId: LEGACY_PROVIDER_TASK_ID,
      statusPath: `/1/api/tasks/${LEGACY_PROVIDER_TASK_ID}`,
    },
  };
  db.prepare(
    `INSERT INTO provider_command_journal (id, run_id, body_json)
     VALUES (?, ?, ?)`
  ).run(commandId, run.id, JSON.stringify(legacyCommand));
  db.prepare("UPDATE migration_meta SET value = '1' WHERE key = 'schema_version'").run();
  db.prepare('DELETE FROM migration_meta WHERE key = ?').run('provider_task_privacy_v2');
  return { run, job, expectedHandle, evidenceIds, commandId };
}

function makeVersion(input: {
  id: string;
  jobId: string;
  snapshotId: string;
  capturedAt: string;
  name: string;
  memberships: string[];
  sourceObjectId?: string;
}): PersistedSourceObjectVersion {
  const sourceObjectId = input.sourceObjectId ?? 'etr_shared';
  const sourceObject: SourceObject = {
    id: sourceObjectId,
    stableId: sourceObjectId,
    sourceType: 'generic',
    name: input.name,
    aliases: [],
    sourceUrl: `https://example.benchling.com/example/${sourceObjectId}`,
    sourcePath: `Objects/${sourceObjectId}.json`,
    attachmentHashes: [],
    memberships: input.memberships,
    metadata: { revision: input.name },
    content: { text: input.name },
    relationships: [],
  };
  return {
    id: input.id,
    runId: 'run-1',
    sourceObjectId: sourceObject.id,
    sourceJobId: input.jobId,
    sourceSnapshotId: input.snapshotId,
    capturedAt: input.capturedAt,
    supersedesVersionId: null,
    sourceObject,
  };
}

function makeReport(): ValidationReport {
  const section = { expected: 1, actual: 1, passed: true, issues: [] };
  return {
    version: 1,
    runId: 'run-1',
    scope: makeRun().scope,
    snapshotId: 'snapshot-1',
    accountHash: 'sha256:account',
    generatedAt: '2026-07-17T00:00:02.000Z',
    passed: true,
    sourceObjects: section,
    attachments: { ...section, expected: 0, actual: 0 },
    memberships: { ...section, expected: 0, actual: 0 },
    relationships: {
      ...section,
      expected: 0,
      actual: 0,
      countsByClass: {
        exact: 0,
        heuristic: 0,
        ambiguous: 0,
        unresolved: 0,
        external: 0,
        source_broken: 0,
      },
    },
    projections: {
      ...section,
      native: 1,
      nativeRepresentations: { dnaSequence: 1, strain: 0, needsSequence: 0 },
      artifact: 0,
      exceptions: 0,
    },
    hashes: section,
    rendering: section,
    issues: [],
  };
}

describe('MigrationStore', () => {
  it('uses stable indexed keys between bounded batches while preserving durable order', async () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    const run = makeReadyLocalRecoveryRun();
    store.saveRun(run);
    const objects = [3, 1, 5, 2, 4].map((index) =>
      makeRecoveredSourceObject({
        id: `seq_recovered_${index}`,
        stableId: `seq_recovered_${index}`,
        name: `Recovered plasmid ${index}`,
      })
    );
    for (const sourceObject of objects) store.putSourceObject(run.id, sourceObject);
    let yieldCount = 0;

    await expect(
      store.listSourceObjectsCooperatively(run.id, {
        batchSize: 2,
        yieldToEventLoop: async () => {
          yieldCount += 1;
        },
      })
    ).resolves.toEqual(objects);
    expect(yieldCount).toBe(2);

    await expect(store.listSourceObjectsCooperatively(run.id, { batchSize: 0 })).rejects.toThrow(
      'positive safe integer'
    );
    db.close();
  });

  it('reopens only a preserved local ZIP invariant failure for retry', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    const failedRun = makeReadyLocalRecoveryRun();
    const failed: MigrationRun = {
      ...failedRun,
      state: 'failed',
      lastError: {
        code: 'internal_invariant',
        message: 'Migration execution failed internally.',
        blocking: true,
      },
    };
    store.saveRun(failed);
    const retry: MigrationRun = {
      ...failed,
      state: 'parsing',
      updatedAt: '2026-08-13T10:00:06.000Z',
      lastError: null,
    };

    store.restoreFailedLocalRunForRetry({ failedRun: failed, retryRun: retry });

    expect(store.getRun()).toEqual(retry);
    expect(() =>
      store.restoreFailedLocalRunForRetry({ failedRun: failed, retryRun: retry })
    ).toThrow('compare-and-set');
    db.close();
  });

  it('rejects private provider locators embedded inside arbitrary persisted issue text', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    for (const message of [
      '{"providerTaskId":"123e4567-e89b-12d3-a456-426614174000"}',
      'Provider failed at /1/api/tasks/123e4567-e89b-12d3-a456-426614174000.',
      'Legacy receipt task:123e4567-e89b-12d3-a456-426614174000 was unavailable.',
    ]) {
      expect(() =>
        store.saveRun(
          makeRun({
            state: 'action_required',
            lastError: {
              code: 'internal_invariant',
              message,
              blocking: true,
            },
          })
        )
      ).toThrow(/provider task|provider-task|provider locator|provider/i);
    }
    expect(store.getRun()).toBeNull();
    db.close();
  });

  it('rejects a non-digest provider-task receipt at the export-job write boundary', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    store.saveRun(makeRun());
    expect(() =>
      store.upsertExportJob(
        makeExportJob({
          state: 'receipt_pending',
          submittedAt: '2026-07-17T00:00:01.000Z',
          attempts: 1,
          receiptId: 'provider-task:not-a-sha256-handle',
          receiptSource: 'provider_task',
        })
      )
    ).toThrow(/provider task receipt/iu);
    expect(store.listExportJobs('run-1')).toEqual([]);
    db.close();
  });

  it('atomically replaces a complete offline resolution set without changing another run', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    const resolution = (id: string): RelationshipResolution => ({
      relationshipId: id,
      sourceObjectId: 'etr_SOURCE01',
      targetSourceId: null,
      relationType: 'references',
      classification: 'unresolved',
      evidence: [],
      candidateSourceIds: [],
      requiresTargetedRead: false,
      reason: 'Not imported',
    });
    store.putRelationshipResolutions('run-1', [resolution('old'), resolution('retained')]);
    store.putRelationshipResolution('run-2', resolution('other'));
    store.putRelationshipResolutions('run-1', [resolution('retained'), resolution('new')]);
    expect(
      store
        .listRelationshipResolutions('run-1')
        .map((entry) => entry.relationshipId)
        .sort()
    ).toEqual(['new', 'retained']);
    db.exec(
      "CREATE TRIGGER fail_test_resolution BEFORE INSERT ON relationship_resolution WHEN NEW.relationship_id='stop' BEGIN SELECT RAISE(ABORT, 'test interruption'); END"
    );
    expect(() =>
      store.putRelationshipResolutions('run-1', [resolution('partial'), resolution('stop')])
    ).toThrow('test interruption');
    expect(
      store
        .listRelationshipResolutions('run-1')
        .map((entry) => entry.relationshipId)
        .sort()
    ).toEqual(['new', 'retained']);
    store.commitLocalOfflineResolution({ runId: 'run-1', resolutions: [], runs: [] });
    expect(store.listRelationshipResolutions('run-1')).toEqual([]);
    expect(store.listRelationshipResolutions('run-2')).toEqual([resolution('other')]);
    db.close();
  });

  it('rejects private provider locators in relationship resolution evidence and reason', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    const statusPath = '/1/api/tasks/123e4567-e89b-12d3-a456-426614174000';
    const resolution: RelationshipResolution = {
      relationshipId: 'relationship-1',
      sourceObjectId: 'seq_1',
      targetSourceId: null,
      relationType: 'references',
      classification: 'unresolved',
      evidence: [],
      candidateSourceIds: [],
      requiresTargetedRead: false,
      reason: 'No stable target identity is available.',
    };

    for (const unsafeResolution of [
      {
        ...resolution,
        evidence: [{ kind: 'url' as const, value: statusPath }],
      },
      {
        ...resolution,
        reason: `Provider lookup failed at ${statusPath}.`,
      },
    ]) {
      expect(() => store.putRelationshipResolution('run-1', unsafeResolution)).toThrow(
        /provider task status path/iu
      );
    }
    expect(store.listRelationshipResolutions('run-1')).toEqual([]);
    db.close();
  });

  it('rejects private provider locators in projection receipt warnings and exceptions', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    const statusPath = '/1/api/tasks/123e4567-e89b-12d3-a456-426614174000';

    for (const unsafeReceipt of [
      makeReceipt({ warnings: [`Provider lookup failed at ${statusPath}.`] }),
      makeReceipt({ exception: `Provider lookup failed at ${statusPath}.` }),
    ]) {
      expect(() => store.appendProjectionReceipt(unsafeReceipt)).toThrow(
        /provider task status path/iu
      );
    }
    expect(store.listProjectionReceipts('run-1')).toEqual([]);
    db.close();
  });

  it('persists one run and enforces legal durable transitions', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    const run = makeRun();
    store.saveRun(run);
    expect(store.getRun()).toEqual(run);

    const confirmed = transitionMigrationRun(run, 'identity_confirmation', '2026-07-17T00:00:01Z');
    store.saveRun(confirmed);
    expect(store.getRun()?.state).toBe('identity_confirmation');

    expect(() => store.saveRun({ ...confirmed, state: 'unlocked' })).toThrow(
      /illegal run transition/i
    );
    expect(() => store.saveRun({ ...confirmed, id: 'run-2' })).toThrow(/exactly one run/i);
    db.close();
  });

  it.each(['draft', 'ready_to_unlock'] as const)(
    'persists only projection-contract action-required recovery from %s',
    (state) => {
      const db = createTestDb();
      const store = new MigrationStore(db);
      const run = makeRun({ state });
      store.saveRun(run);

      expect(() =>
        store.saveRun({
          ...run,
          state: 'action_required',
          resumeState: state,
          updatedAt: '2026-07-17T00:00:01.000Z',
          lastError: {
            code: 'validation_failed',
            message: 'Validation did not pass.',
            blocking: true,
          },
        })
      ).toThrow(/illegal run transition/i);

      const recovery = transitionMigrationRun(run, 'action_required', '2026-07-17T00:00:02.000Z', {
        code: 'projection_contract_restart_required',
        message: 'Select the same original export again in a new migration.',
        blocking: true,
      });
      store.saveRun(recovery);
      expect(store.getRun()).toEqual(recovery);
      db.close();
    }
  );

  it('makes scope and the complete confirmed source binding immutable', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    const run = makeRun({
      binding: {
        version: 1,
        benchlingOrigin: 'https://example.benchling.com',
        benchlingAccountId: 'usr_1',
        benchlingAccountEmail: 'scientist@example.edu',
        benchlingOrganizationId: 'wrk_1',
        benchlingOrganizationName: 'Example Lab',
        chromePairingId: 'pairing-1',
        gmailMailbox: 'scientist@example.edu',
        accountHash: 'sha256:one',
        confirmedAt: '2026-07-17T00:00:00Z',
      },
    });
    store.saveRun(run);
    expect(() =>
      store.saveRun({
        ...run,
        scope: { ...run.scope, source: { id: 'seq_2', url: 'https://x/seq_2' } },
      } as MigrationRun)
    ).toThrow(/scope.*immutable/i);
    expect(() =>
      store.saveRun({ ...run, binding: { ...run.binding!, accountHash: 'sha256:two' } })
    ).toThrow(/binding.*immutable/i);
    for (const binding of [
      { ...run.binding!, gmailMailbox: 'receipts@example.com' },
      { ...run.binding!, chromePairingId: 'pairing-2' },
      { ...run.binding!, benchlingOrganizationName: 'Renamed organization' },
      { ...run.binding!, confirmedAt: '2026-07-17T00:00:01Z' },
    ]) {
      expect(() => store.saveRun({ ...run, binding })).toThrow(/binding.*immutable/i);
    }
    expect(store.getRun()).toEqual(run);
    db.close();
  });

  it('makes provisional local intake authority immutable and erases it on terminal failure', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    const scope = {
      version: 1,
      kind: 'file',
      acquisition: 'local_bundle',
      source: {
        id: 'local-export-pending-11111111-1111-4111-8111-111111111111',
        url: 'urn:dnaforge:benchling-local-export:pending:11111111-1111-4111-8111-111111111111',
        objectType: 'notebook',
      },
    } as const;
    const descriptor = {
      schema: 'dnaforge.benchling.local-export-intake.v1',
      sourcePath: '/Users/secret/Downloads/export.html',
      logicalFilename: 'export.html',
      format: 'html',
      selectedAt: '2026-08-03T12:00:00.000Z',
      sourceIdentity: {
        deviceId: '1',
        inode: '2',
        sizeBytes: 10,
        modifiedTimeNs: '3',
        changedTimeNs: '4',
      },
      plannedResources: [],
      plannedCopyBytes: 10,
    } as const;
    const provisional = makeRun({ scope, localExportIntake: descriptor });
    store.saveRun(provisional);

    expect(() =>
      store.saveRun({
        ...provisional,
        localExportIntake: { ...descriptor, sourcePath: '/Users/secret/Downloads/other.html' },
      })
    ).toThrow(/restart authority is immutable/iu);

    const { localExportIntake: _removed, ...withoutIntake } = provisional;
    const failed = transitionMigrationRun(withoutIntake, 'failed', '2026-08-03T12:00:01.000Z', {
      code: 'migration_interrupted',
      message: 'The selected local export changed before copying completed.',
      blocking: true,
    });
    store.saveRun(failed);
    expect(store.getRun()).toEqual(failed);
    expect(JSON.stringify(store.getRun())).not.toContain('/Users/secret/Downloads');
    db.close();
  });

  it('CASes one selected Folder ZIP descriptor to one immutable artifact without changing scope', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    const scope = {
      version: 1,
      kind: 'folder',
      folder: {
        id: 'lib_DemoFold',
        url: 'https://benchling.com/exampleuser/f_/DemoFold-arbr-lab-work/',
        objectType: 'folder',
      },
      includeChildren: false,
      includeArchived: false,
      acquisition: 'local_bundle',
    } as const;
    const descriptor = {
      schema: 'dnaforge.benchling.local-export-intake.v1',
      sourcePath: '/Users/secret/Downloads/arbr-lab-work.zip',
      logicalFilename: 'arbr-lab-work.zip',
      format: 'zip',
      selectedAt: '2026-08-03T12:00:00.000Z',
      sourceIdentity: {
        deviceId: '1',
        inode: '2',
        sizeBytes: 100,
        modifiedTimeNs: '3',
        changedTimeNs: '4',
      },
      plannedResources: [],
      plannedCopyBytes: 100,
    } as const;
    const planning = makeRun({ state: 'scope_planning', scope });
    store.saveRun(planning);
    const copying = { ...planning, localExportIntake: descriptor };
    store.saveRun(copying);
    expect(() =>
      store.saveRun({
        ...copying,
        localExportIntake: { ...descriptor, sourcePath: '/Users/secret/Downloads/other.zip' },
      })
    ).toThrow(/restart authority is immutable/iu);

    const artifact = {
      schema: 'dnaforge.benchling.local-export-artifact.v1',
      format: 'zip',
      logicalFilename: 'arbr-lab-work.zip',
      sha256: `sha256:${'a'.repeat(64)}`,
      sizeBytes: 100,
      immutableLocalPath: '/private/archive/a',
      capturedAt: '2026-08-03T12:00:01.000Z',
      archive: {
        entryCount: 2,
        totalCompressedEntryBytes: 50,
        totalUncompressedEntryBytes: 100,
      },
      resources: [],
    } as const;
    const { localExportIntake: _intake, ...withoutIntake } = copying;
    const accepted = { ...withoutIntake, localExportArtifact: artifact };
    store.saveRun(accepted);
    expect(store.getRun()).toEqual(accepted);
    expect(store.getRun()?.scope).toEqual(scope);
    expect(() =>
      store.saveRun({
        ...accepted,
        localExportArtifact: { ...artifact, sha256: `sha256:${'b'.repeat(64)}` },
      })
    ).toThrow(/artifact identity is immutable/iu);
    expect(() => store.saveRun({ ...accepted, localExportIntake: descriptor })).toThrow(
      /restart authority/iu
    );
    expect(store.getRun()).toEqual(accepted);
    db.close();
  });

  it('CASes one selected Folder ZIP descriptor to immutable external source evidence', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    const scope: MigrationScope = {
      version: 1,
      kind: 'folder_tree',
      roots: [
        {
          id: 'local-export-folder-11111111-1111-4111-8111-111111111111',
          url: 'urn:dnaforge:benchling-local-export:pending:11111111-1111-4111-8111-111111111111',
          objectType: 'folder',
        },
      ],
      includeChildren: true,
      includeArchived: false,
      acquisition: 'local_bundle',
    } as const;
    const descriptor = {
      schema: 'dnaforge.benchling.local-export-intake.v1',
      sourcePath: '/Users/secret/Downloads/export.zip',
      logicalFilename: 'export.zip',
      format: 'zip',
      selectedAt: '2026-08-29T12:00:00.000Z',
      sourceIdentity: {
        deviceId: '1',
        inode: '2',
        sizeBytes: 100,
        modifiedTimeNs: '3',
        changedTimeNs: '4',
      },
      plannedResources: [],
      plannedCopyBytes: 100,
    } as const;
    const planning = makeRun({ state: 'scope_planning', scope });
    store.saveRun(planning);
    const copying = { ...planning, localExportIntake: descriptor };
    store.saveRun(copying);
    const source = {
      schema: 'dnaforge.benchling.external-zip-source.v1',
      sourceId: 'external-zip-aaaaaaaaaaaaaaaaaaaaaaaa',
      originalPath: descriptor.sourcePath,
      displayName: descriptor.logicalFilename,
      zipSha256: `sha256:${'a'.repeat(64)}`,
      sizeBytes: 100,
      selectedAt: descriptor.selectedAt,
    } as const;
    const entries = [
      {
        schema: 'dnaforge.benchling.external-zip-entry.v1',
        sourceId: source.sourceId,
        sourceObjectId: 'seq_EXTERNAL1',
        entryPath: 'Sequence (seq_EXTERNAL1).gb',
        entrySha256: `sha256:${'b'.repeat(64)}`,
        sizeBytes: 50,
        mediaType: 'chemical/x-genbank',
        role: 'source-record',
      },
    ] as const;
    const { localExportIntake: _intake, ...withoutIntake } = copying;
    const accepted = { ...withoutIntake, externalZipSource: source, externalZipEntries: entries };

    store.saveRun(accepted);

    expect(store.getRun()).toEqual(accepted);
    expect(() =>
      store.saveRun({
        ...accepted,
        externalZipSource: { ...source, originalPath: '/Users/secret/Downloads/other.zip' },
      })
    ).toThrow(/external ZIP source evidence is immutable/iu);
    expect(() => store.saveRun({ ...accepted, externalZipEntries: [] })).toThrow(
      /external ZIP source evidence is immutable/iu
    );
    db.close();
  });

  it('appends immutable snapshot parts idempotently', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    const part: SourceSnapshotPart = {
      id: 'part-1',
      kind: 'export_archive',
      sha256: 'a'.repeat(64),
      sizeBytes: 10,
      capturedAt: '2026-07-17T00:00:00Z',
      sourceJobId: 'job-1',
      sourceObjectId: null,
      supersedesPartId: null,
    };
    store.appendSnapshotPart('run-1', part);
    store.appendSnapshotPart('run-1', part);
    expect(store.listSnapshotParts('run-1')).toEqual([part]);
    expect(() => store.appendSnapshotPart('run-1', { ...part, sizeBytes: 11 })).toThrow(
      /immutable migration record/i
    );
    db.close();
  });

  it('records a deterministic, non-forking snapshot supersession chain', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    const original: SourceSnapshotPart = {
      id: 'target-v1',
      kind: 'targeted_read',
      sha256: 'a'.repeat(64),
      sizeBytes: 10,
      capturedAt: '2026-07-17T00:00:00Z',
      sourceJobId: null,
      sourceObjectId: 'seq_1',
      supersedesPartId: null,
    };
    const replacement: SourceSnapshotPart = {
      ...original,
      id: 'target-v2',
      sha256: 'b'.repeat(64),
      capturedAt: '2026-07-17T00:00:01Z',
      supersedesPartId: original.id,
    };
    const latest: SourceSnapshotPart = {
      ...replacement,
      id: 'target-v3',
      sha256: 'c'.repeat(64),
      capturedAt: '2026-07-17T00:00:02Z',
      supersedesPartId: replacement.id,
    };

    store.appendSnapshotPart('run-1', original);
    store.appendSnapshotPart('run-1', replacement);
    store.appendSnapshotPart('run-1', latest);
    expect(store.listSnapshotParts('run-1')).toEqual([original, replacement, latest]);

    expect(() =>
      store.appendSnapshotPart('run-1', {
        ...replacement,
        id: 'target-fork',
        sha256: 'd'.repeat(64),
      })
    ).toThrow(/already superseded/i);
    db.close();
  });

  it.each([
    {
      name: 'missing predecessor',
      replacement: { supersedesPartId: 'missing-part' },
      error: /cannot supersede missing part/i,
    },
    {
      name: 'different source object',
      replacement: { sourceObjectId: 'seq_2' },
      error: /different source object/i,
    },
    {
      name: 'non-increasing capture time',
      replacement: { capturedAt: '2026-07-17T00:00:00Z' },
      error: /must be captured after/i,
    },
  ])('rejects supersession with $name', ({ replacement, error }) => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    const original: SourceSnapshotPart = {
      id: 'target-v1',
      kind: 'targeted_read',
      sha256: 'a'.repeat(64),
      sizeBytes: 10,
      capturedAt: '2026-07-17T00:00:00Z',
      sourceJobId: null,
      sourceObjectId: 'seq_1',
      supersedesPartId: null,
    };
    store.appendSnapshotPart('run-1', original);
    expect(() =>
      store.appendSnapshotPart('run-1', {
        ...original,
        id: 'target-v2',
        sha256: 'b'.repeat(64),
        capturedAt: '2026-07-17T00:00:01Z',
        supersedesPartId: original.id,
        ...replacement,
      })
    ).toThrow(error);
    db.close();
  });

  it('rejects cross-kind supersession and malformed snapshot parts', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    const original: SourceSnapshotPart = {
      id: 'export-v1',
      kind: 'export_archive',
      sha256: 'a'.repeat(64),
      sizeBytes: 10,
      capturedAt: '2026-07-17T00:00:00Z',
      sourceJobId: 'job-1',
      sourceObjectId: null,
      supersedesPartId: null,
    };
    store.appendSnapshotPart('run-1', original);
    expect(() =>
      store.appendSnapshotPart('run-1', {
        id: 'target-v2',
        kind: 'targeted_read',
        sha256: 'b'.repeat(64),
        sizeBytes: 10,
        capturedAt: '2026-07-17T00:00:01Z',
        sourceJobId: null,
        sourceObjectId: 'seq_1',
        supersedesPartId: original.id,
      })
    ).toThrow(/different snapshot part kind/i);
    expect(() =>
      store.appendSnapshotPart('run-1', { ...original, id: 'bad-hash', sha256: 'not-a-hash' })
    ).toThrow(/SHA-256/i);
    expect(() =>
      store.appendSnapshotPart('run-1', {
        ...original,
        id: 'wrong-shape',
        sourceObjectId: 'seq_1',
      })
    ).toThrow(/one source job and no source object/i);
    db.close();
  });

  it('persists immutable source snapshot metadata and appends durable parts', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    store.saveRun(makeBoundRun());
    const firstPart: SourceSnapshotPart = {
      id: 'part-1',
      kind: 'export_archive',
      sha256: 'a'.repeat(64),
      sizeBytes: 10,
      capturedAt: '2026-07-17T00:00:01Z',
      sourceJobId: 'job-1',
      sourceObjectId: null,
      supersedesPartId: null,
    };
    const snapshot: SourceSnapshot = {
      version: 1,
      id: 'snapshot-1',
      runId: 'run-1',
      accountHash: 'sha256:account',
      createdAt: '2026-07-17T00:00:00Z',
      archiveManifestId: 'snapshot-1',
      initialSourceObjectIds: ['seq_1', 'seq_2'],
      expectedSourceObjectCount: 2,
      expectedAttachmentCount: 1,
      expectedMembershipCount: 1,
      localExportWarnings: ['Skipped one unsupported local export object.'],
      parts: [firstPart],
    };

    store.saveSourceSnapshot(snapshot);
    store.saveSourceSnapshot(snapshot);
    expect(store.getSourceSnapshot('run-1')).toEqual(snapshot);

    const secondPart: SourceSnapshotPart = {
      ...firstPart,
      id: 'part-2',
      kind: 'targeted_read',
      sha256: 'b'.repeat(64),
      capturedAt: '2026-07-17T00:00:02Z',
      sourceJobId: null,
      sourceObjectId: 'seq_2',
    };
    store.saveSourceSnapshot({ ...snapshot, parts: [firstPart, secondPart] });
    expect(store.getSourceSnapshot('run-1')?.parts).toEqual([firstPart, secondPart]);

    expect(() =>
      store.saveSourceSnapshot({
        ...snapshot,
        createdAt: '2026-07-17T00:00:03Z',
        parts: [firstPart, secondPart],
      })
    ).toThrow(/snapshot metadata.*immutable/i);
    expect(() =>
      store.saveSourceSnapshot({ ...snapshot, accountHash: 'sha256:different' })
    ).toThrow(/immutable source identity/i);
    expect(() => store.saveSourceSnapshot({ ...snapshot, expectedAttachmentCount: -1 })).toThrow(
      /attachment count must be non-negative/i
    );
    expect(() => store.saveSourceSnapshot({ ...snapshot, localExportWarnings: [''] })).toThrow(
      /local export warnings are invalid/i
    );
    db.close();
  });

  it('persists export jobs through legal transitions without inventing timestamps', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    store.saveRun(makeBoundRun());
    const planned = makeExportJob();
    store.upsertExportJob(planned);
    expect(store.getExportJob(planned.id)).toEqual(planned);

    const submitted = {
      ...planned,
      state: 'submitted' as const,
      submittedAt: '2026-07-17T00:00:01.123Z',
      attempts: 1,
    };
    store.upsertExportJob(submitted);
    store.upsertExportJob({ ...submitted, state: 'receipt_pending' });
    store.upsertExportJob({
      ...submitted,
      state: 'receipt_matched',
      receiptId: 'gmail-message-1',
      receiptSource: 'gmail' as const,
    });
    store.upsertExportJob({
      ...submitted,
      state: 'downloading',
      receiptId: 'gmail-message-1',
      receiptSource: 'gmail' as const,
      downloadUrlHash: 'sha256:download-url',
    });
    const captured = {
      ...submitted,
      state: 'captured' as const,
      receiptId: 'gmail-message-1',
      receiptSource: 'gmail' as const,
      downloadUrlHash: 'sha256:download-url',
      snapshotPartId: 'part-1',
    };
    store.upsertExportJob(captured);
    store.upsertExportJob(captured);

    expect(store.listExportJobs('run-1')).toEqual([captured]);
    expect(store.getExportJob(planned.id)?.submittedAt).toBe('2026-07-17T00:00:01.123Z');
    expect(() => store.upsertExportJob({ ...captured, state: 'downloading' })).toThrow(
      /illegal export job transition/i
    );
    expect(() => store.upsertExportJob({ ...captured, contentFamily: 'protein' })).toThrow(
      /planning fields are immutable/i
    );
    expect(() =>
      store.upsertExportJob({ ...captured, submittedAt: '2026-07-17T00:00:09Z' })
    ).toThrow(/submittedAt is immutable/i);
    expect(() => store.upsertExportJob({ ...captured, receiptSource: 'provider_task' })).toThrow(
      /receiptSource is immutable/i
    );
    db.close();
  });

  it('rejects a non-timestamp submittedAt before persisting an export job', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    store.saveRun(makeBoundRun());
    const planned = makeExportJob();
    store.upsertExportJob(planned);

    expect(() =>
      store.upsertExportJob({
        ...planned,
        state: 'submitted',
        submittedAt: 'not-a-timestamp',
        attempts: 1,
      })
    ).toThrow(/submission time is invalid/i);
    expect(store.getExportJob(planned.id)).toEqual(planned);
    db.close();
  });

  it('retains one immutable Gmail inference-to-confirmation binding across database reopen', () => {
    const fileDb = createFileTestDb('benchling-gmail-receipt-confirmation');
    let resumedDb: ReturnType<typeof openFileTestDb> | null = null;
    try {
      let store = new MigrationStore(fileDb.db);
      store.saveRun(makeBoundRun());
      const planned = makeExportJob();
      const pending = {
        ...planned,
        state: 'receipt_pending' as const,
        submittedAt: '2026-07-17T00:00:01.000Z',
        attempts: 1,
      };
      store.upsertExportJob(planned);
      store.upsertExportJob({ ...pending, state: 'submitted' });
      store.upsertExportJob(pending);
      const inference = {
        schema: 'dnaforge.benchling.gmail-receipt-inference.v1' as const,
        id: 'gmail-inference-1',
        runId: pending.runId,
        jobId: pending.id,
        receiptId: 'gmail-message-1',
        plannedMatchSignature: pending.matchSignature,
        downloadUrlHash: `sha256:${'1'.repeat(64)}`,
        matchConfidence: 'inferred' as const,
        contentFamily: pending.contentFamily,
        sourceRootIds: pending.sourceRoots.map((root) => root.id),
        observedAt: '2026-07-17T00:00:02.000Z',
      };
      for (const observedAt of [
        '2026-07-17T00:00:02Z',
        '2026-07-17T00:00:02+00:00',
        'Fri, 17 Jul 2026 00:00:02 GMT (https://attacker.invalid/token)',
      ]) {
        expect(() => store.saveGmailReceiptInference({ ...inference, observedAt })).toThrow(
          /inference evidence is invalid/i
        );
      }
      expect(store.listGmailReceiptInferences(pending.runId)).toEqual([]);
      store.saveGmailReceiptInference(inference);
      expect(() =>
        store.saveGmailReceiptInference({
          ...inference,
          downloadUrlHash: `sha256:${'2'.repeat(64)}`,
        })
      ).toThrow(/immutable migration record/i);

      const confirmation = {
        schema: 'dnaforge.benchling.gmail-receipt-confirmation.v1' as const,
        id: 'gmail-confirmation-1',
        runId: pending.runId,
        inferenceId: inference.id,
        jobId: pending.id,
        receiptId: inference.receiptId,
        matchSignature: pending.matchSignature,
        downloadUrlHash: inference.downloadUrlHash,
        confirmedAt: '2026-07-17T00:00:03.000Z',
        basis: 'explicit_user_confirmation' as const,
      };
      expect(() =>
        store.confirmGmailReceiptInference({
          ...confirmation,
          downloadUrlHash: `sha256:${'3'.repeat(64)}`,
        })
      ).toThrow(/does not match one pending inference/i);
      for (const confirmedAt of [
        '2026-07-17T00:00:03Z',
        '2026-07-17T00:00:03+00:00',
        'Fri, 17 Jul 2026 00:00:03 GMT (https://attacker.invalid/token)',
      ]) {
        expect(() => store.confirmGmailReceiptInference({ ...confirmation, confirmedAt })).toThrow(
          /confirmation evidence is invalid/i
        );
      }
      expect(store.listGmailReceiptConfirmations(pending.runId)).toEqual([]);
      expect(store.getExportJob(pending.id)?.state).toBe('receipt_pending');

      expect(store.confirmGmailReceiptInference(confirmation)).toMatchObject({
        state: 'receipt_matched',
        receiptId: inference.receiptId,
        receiptSource: 'gmail',
        downloadUrlHash: inference.downloadUrlHash,
        receiptConfirmationId: confirmation.id,
      });
      fileDb.db.close();

      resumedDb = openFileTestDb(fileDb.dbPath);
      store = new MigrationStore(resumedDb);
      expect(store.getGmailReceiptInference(inference.id)).toEqual(inference);
      expect(store.getGmailReceiptConfirmationForJob(pending.id)).toEqual(confirmation);
      expect(store.listGmailReceiptConfirmations(pending.runId)).toEqual([confirmation]);
      expect(JSON.stringify(store.listGmailReceiptConfirmations(pending.runId))).not.toMatch(
        /https?:\/\/|messageBody|protectedUrl|downloadUrl"/iu
      );
    } finally {
      if (fileDb.db.open) fileDb.db.close();
      if (resumedDb?.open) resumedDb.close();
      fileDb.cleanup();
    }
  });

  it('atomically persists structural failure evidence with the failed job transition', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    store.saveRun(makeBoundRun());
    const submitted = {
      ...makeExportJob(),
      state: 'submitted' as const,
      submittedAt: '2026-07-17T00:00:01Z',
      attempts: 1,
    };
    store.upsertExportJob(makeExportJob());
    store.upsertExportJob(submitted);

    const originalFailure = {
      jobId: submitted.id,
      runId: submitted.runId,
      code: 'export_timed_out' as const,
      failedAt: '2026-07-17T00:00:02Z',
      message: 'The Benchling export timed out.',
    };
    store.saveExportJobFailure(originalFailure);
    expect(store.getExportJob(submitted.id)?.state).toBe('failed');
    expect(store.getExportJobFailure(submitted.id)).toEqual(originalFailure);

    store.saveExportJobFailure({
      ...originalFailure,
      failedAt: '2026-07-17T00:00:03Z',
      message: 'The Benchling export timed out.',
    });
    expect(store.getExportJobFailure(submitted.id)).toEqual(originalFailure);

    const capturedPlan = makeExportJob({
      id: 'export-job-captured',
      matchSignature: 'benchling-export:captured-signature',
    });
    store.upsertExportJob(capturedPlan);
    const capturedSubmission = {
      ...capturedPlan,
      state: 'submitted' as const,
      submittedAt: '2026-07-17T00:00:04Z',
      attempts: 1,
    };
    store.upsertExportJob(capturedSubmission);
    store.upsertExportJob({
      ...capturedSubmission,
      state: 'receipt_matched',
      receiptId: 'gmail-message-captured',
      receiptSource: 'gmail',
      downloadUrlHash: 'sha256:captured-download-url',
    });
    store.upsertExportJob({
      ...capturedSubmission,
      state: 'downloading',
      receiptId: 'gmail-message-captured',
      receiptSource: 'gmail',
      downloadUrlHash: 'sha256:captured-download-url',
    });
    store.upsertExportJob({
      ...capturedSubmission,
      state: 'captured',
      receiptId: 'gmail-message-captured',
      receiptSource: 'gmail',
      downloadUrlHash: 'sha256:captured-download-url',
      snapshotPartId: 'snapshot-part-captured',
    });

    expect(() =>
      store.saveExportJobFailure({
        jobId: capturedPlan.id,
        runId: capturedPlan.runId,
        code: 'download_link_expired',
        failedAt: '2026-07-17T00:00:05Z',
        message: 'The Benchling download link expired.',
      })
    ).toThrow(/illegal export job transition/i);
    expect(store.getExportJobFailure(capturedPlan.id)).toBeNull();
    expect(store.getExportJob(capturedPlan.id)?.state).toBe('captured');

    const impossibleLegacyFailure = {
      jobId: capturedPlan.id,
      runId: capturedPlan.runId,
      code: 'download_link_expired',
      failedAt: '2026-07-17T00:00:06Z',
      message: 'The Benchling download link expired.',
    };
    db.prepare('INSERT INTO export_job_failure (id, run_id, body_json) VALUES (?, ?, ?)').run(
      capturedPlan.id,
      capturedPlan.runId,
      JSON.stringify(impossibleLegacyFailure)
    );
    expect(() => store.reconcileExportJobFailures(capturedPlan.runId)).toThrow(
      /illegal export job transition/i
    );
    expect(store.getExportJob(capturedPlan.id)?.state).toBe('captured');
    db.close();
  });

  it('rejects non-structural codes in legacy persisted failure evidence', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    store.saveRun(makeBoundRun());
    const planned = makeExportJob();
    const submitted = {
      ...planned,
      state: 'submitted' as const,
      submittedAt: '2026-07-17T00:00:01Z',
      attempts: 1,
    };
    store.upsertExportJob(planned);
    store.upsertExportJob(submitted);
    db.prepare('INSERT INTO export_job_failure (id, run_id, body_json) VALUES (?, ?, ?)').run(
      submitted.id,
      submitted.runId,
      JSON.stringify({
        jobId: submitted.id,
        runId: submitted.runId,
        code: 'provider_failed',
        failedAt: '2026-07-17T00:00:02Z',
        message: 'This is not deterministic structural failure evidence.',
      })
    );

    expect(() => store.reconcileExportJobFailures(submitted.runId)).toThrow(
      /unsupported structural failure code/i
    );
    expect(store.getExportJob(submitted.id)?.state).toBe('submitted');
    expect(() => store.getExportJobFailure(submitted.id)).toThrow(
      /unsupported structural failure code/i
    );
    db.close();
  });

  it('rejects non-canonical structural failure rows without changing job state', () => {
    const variants = [
      {
        message:
          'The export timed out at https://benchling-temp.example/archive.zip?X-Amz-Signature=secret.',
      },
      {
        message: 'The Benchling export timed out.',
        protectedUrl: 'https://benchling-temp.example/archive.zip?X-Amz-Signature=secret',
      },
      {
        message: 'The Benchling export timed out.',
        messageBody: 'Your export is ready. Download it using the private link.',
      },
      {
        message: 'The Benchling export timed out.',
        failedAt: 'Thu, 17 Jul 2026 00:00:02 GMT (secret-token)',
      },
    ];

    for (const [index, variant] of variants.entries()) {
      const db = createTestDb();
      const store = new MigrationStore(db);
      store.saveRun(makeBoundRun());
      const planned = makeExportJob({
        id: `export-job-invalid-failure-${index}`,
        matchSignature: `benchling-export:invalid-failure-${index}`,
      });
      const submitted = {
        ...planned,
        state: 'submitted' as const,
        submittedAt: '2026-07-17T00:00:01Z',
        attempts: 1,
      };
      store.upsertExportJob(planned);
      store.upsertExportJob(submitted);
      db.prepare('INSERT INTO export_job_failure (id, run_id, body_json) VALUES (?, ?, ?)').run(
        submitted.id,
        submitted.runId,
        JSON.stringify({
          jobId: submitted.id,
          runId: submitted.runId,
          code: 'export_timed_out',
          failedAt: '2026-07-17T00:00:02Z',
          ...variant,
        })
      );

      expect(() => store.reconcileExportJobFailures(submitted.runId)).toThrow(
        /canonical (?:fields|timestamped evidence)/i
      );
      expect(store.getExportJob(submitted.id)?.state).toBe('submitted');
      expect(() => store.getExportJobFailure(submitted.id)).toThrow(
        /canonical (?:fields|timestamped evidence)/i
      );
      db.close();
    }
  });

  it('requires one attempt and rejects pending jobs that receipts cannot distinguish', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    store.saveRun(makeBoundRun());
    const planned = makeExportJob();
    store.upsertExportJob(planned);
    expect(() =>
      store.upsertExportJob({
        ...planned,
        state: 'submitted',
        submittedAt: '2026-07-17T00:00:01Z',
        attempts: 2,
      })
    ).toThrow(/increase by one/i);

    const submitted = {
      ...planned,
      state: 'submitted' as const,
      submittedAt: '2026-07-17T00:00:01Z',
      attempts: 1,
    };
    store.upsertExportJob(submitted);
    const duplicatePlanned = makeExportJob({ id: 'export-job-2' });
    store.upsertExportJob(duplicatePlanned);
    expect(() =>
      store.upsertExportJob({
        ...duplicatePlanned,
        state: 'submitted',
        submittedAt: '2026-07-17T00:00:02Z',
        attempts: 1,
      })
    ).toThrow(/pending match signature/i);

    store.upsertExportJob({ ...submitted, state: 'failed' });
    const duplicateSubmitted = {
      ...duplicatePlanned,
      state: 'submitted' as const,
      submittedAt: '2026-07-17T00:00:02Z',
      attempts: 1,
    };
    store.upsertExportJob(duplicateSubmitted);
    expect(store.listExportJobs('run-1').map((job) => job.id)).toEqual([
      'export-job-1',
      'export-job-2',
    ]);

    store.upsertExportJob({ ...duplicateSubmitted, state: 'failed' });
    store.upsertExportJob({ ...duplicateSubmitted, state: 'submitted', attempts: 2 });
    expect(store.getExportJob('export-job-2')?.attempts).toBe(2);

    const sameFamily = makeExportJob({
      id: 'export-job-3',
      matchSignature: 'benchling-export:third-signature',
    });
    store.upsertExportJob(sameFamily);
    expect(() =>
      store.upsertExportJob({
        ...sameFamily,
        state: 'submitted',
        submittedAt: '2026-07-17T00:00:03Z',
        attempts: 1,
      })
    ).toThrow(/observable receipt match key notebook/i);

    const distinguishable = makeExportJob({
      id: 'export-job-4',
      matchSignature: 'benchling-export:fourth-signature',
      contentFamily: 'protein',
    });
    store.upsertExportJob(distinguishable);
    store.upsertExportJob({
      ...distinguishable,
      state: 'submitted',
      submittedAt: '2026-07-17T00:00:03Z',
      attempts: 1,
    });
    const beyondLimit = makeExportJob({
      id: 'export-job-5',
      matchSignature: 'benchling-export:fifth-signature',
      contentFamily: 'dna_rna',
    });
    store.upsertExportJob(beyondLimit);
    expect(() =>
      store.upsertExportJob({
        ...beyondLimit,
        state: 'submitted',
        submittedAt: '2026-07-17T00:00:04Z',
        attempts: 1,
      })
    ).toThrow(/at most two pending/i);
    db.close();
  });

  it('persists immutable per-job capture evidence before snapshot finalization', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    store.saveRun(makeBoundRun());
    store.upsertExportJob(makeExportJob());
    const capture: PersistedExportCapture = {
      jobId: 'export-job-1',
      runId: 'run-1',
      snapshotId: 'snapshot-1',
      capturedAt: '2026-07-17T00:00:02Z',
      archiveManifestId: 'export-manifest-1',
      sourceObjectIds: ['etr_1'],
      attachmentReferences: [{ sourceObjectId: 'etr_1', sha256: 'a'.repeat(64) }],
      membershipReferences: [{ sourceObjectId: 'etr_1', collectionId: 'fld_1' }],
    };

    store.saveExportCapture(capture);
    store.saveExportCapture(capture);
    expect(store.listExportCaptures('run-1')).toEqual([capture]);
    expect(() => store.saveExportCapture({ ...capture, snapshotId: 'snapshot-different' })).toThrow(
      /immutable migration record/i
    );
    db.close();
  });

  it('keeps 96 independent capture-persistence writes and reads on targeted indexed queries', () => {
    const db = createTestDb();
    const queryCounts = new Map<string, number>();
    let largestTargetedResult = 0;
    const store = new MigrationStore(db, false, {
      onCapturePersistenceQuery: (kind, returnedRowCount) => {
        queryCounts.set(kind, (queryCounts.get(kind) ?? 0) + 1);
        largestTargetedResult = Math.max(largestTargetedResult, returnedRowCount);
      },
    });
    store.saveRun(makeBoundRun());
    const itemCount = 96;

    for (let index = 0; index < itemCount; index += 1) {
      const suffix = String(index).padStart(3, '0');
      const jobId = `export-scale-${suffix}`;
      const sourceObjectId = `etr_scale_${suffix}`;
      const snapshotId = `snapshot-scale-${suffix}`;
      const capturedAt = `2026-07-17T00:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`;
      store.upsertExportJob(
        makeExportJob({
          id: jobId,
          matchSignature: `benchling-export:scale:${suffix}`,
        })
      );
      store.saveSourceObjectVersion(
        makeVersion({
          id: `version-scale-${suffix}`,
          jobId,
          snapshotId,
          capturedAt,
          name: `Scale object ${suffix}`,
          memberships: [`fld_scale_${suffix}`],
          sourceObjectId,
        })
      );
      store.appendSnapshotPart('run-1', {
        id: `part-scale-${suffix}`,
        kind: 'export_archive',
        sha256: index.toString(16).padStart(64, '0'),
        sizeBytes: index + 1,
        capturedAt,
        sourceJobId: jobId,
        sourceObjectId: null,
        supersedesPartId: null,
      });
      store.saveExportCapture({
        jobId,
        runId: 'run-1',
        snapshotId,
        capturedAt,
        archiveManifestId: `manifest-scale-${suffix}`,
        sourceObjectIds: [sourceObjectId],
        attachmentReferences: [],
        membershipReferences: [{ sourceObjectId, collectionId: `fld_scale_${suffix}` }],
      });
      expect(store.readExportCaptureEvidence('run-1', jobId)).toMatchObject({
        capture: { jobId, snapshotId },
        archiveParts: [{ id: `part-scale-${suffix}`, sourceJobId: jobId }],
        sourceObjectVersions: [{ id: `version-scale-${suffix}`, sourceObjectId }],
      });
    }

    expect(queryCounts).toEqual(
      new Map([
        ['source_version_by_id', itemCount],
        ['source_versions_by_source_object', itemCount],
        ['export_replacements_by_failed_job', itemCount],
        ['snapshot_part_by_id', itemCount],
        ['export_capture_by_job', itemCount],
        ['snapshot_parts_by_export_job', itemCount],
        ['source_versions_by_export_job', itemCount],
      ])
    );
    expect(largestTargetedResult).toBe(1);
    expect(store.listSourceObjectVersions('run-1')).toHaveLength(itemCount);
    expect(store.listSnapshotParts('run-1')).toHaveLength(itemCount);

    const sourceObjectPlan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id FROM source_object_version
         WHERE run_id = ?
           AND json_type(body_json, '$.sourceObjectId') = 'text'
           AND json_extract(body_json, '$.sourceObjectId') = ?`
      )
      .all('run-1', 'etr_scale_000') as Array<{ detail: string }>;
    const snapshotJobPlan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id FROM snapshot_part
         WHERE run_id = ?
           AND json_type(body_json, '$.sourceJobId') = 'text'
           AND json_extract(body_json, '$.sourceJobId') = ?`
      )
      .all('run-1', 'export-scale-000') as Array<{ detail: string }>;
    expect(sourceObjectPlan.map(({ detail }) => detail).join('\n')).toContain(
      'idx_source_object_version_run_source_object'
    );
    expect(snapshotJobPlan.map(({ detail }) => detail).join('\n')).toContain(
      'idx_snapshot_part_run_source_job'
    );
    db.close();
  });

  it('recovers a partial capture after restart without duplicating immutable evidence', () => {
    const fileDb = createFileTestDb('benchling-partial-capture-restart');
    let resumedDb: ReturnType<typeof openFileTestDb> | null = null;
    const job = makeExportJob({
      id: 'export-restart',
      matchSignature: 'benchling-export:restart',
    });
    const version = makeVersion({
      id: 'version-restart',
      jobId: job.id,
      snapshotId: 'snapshot-restart',
      capturedAt: '2026-07-17T00:00:02.000Z',
      name: 'Restarted capture',
      memberships: ['fld_restart'],
      sourceObjectId: 'etr_restart',
    });
    const part: SourceSnapshotPart = {
      id: 'part-restart',
      kind: 'export_archive',
      sha256: 'a'.repeat(64),
      sizeBytes: 128,
      capturedAt: version.capturedAt,
      sourceJobId: job.id,
      sourceObjectId: null,
      supersedesPartId: null,
    };
    const capture: PersistedExportCapture = {
      jobId: job.id,
      runId: 'run-1',
      snapshotId: version.sourceSnapshotId,
      capturedAt: version.capturedAt,
      archiveManifestId: 'manifest-restart',
      sourceObjectIds: [version.sourceObjectId],
      attachmentReferences: [],
      membershipReferences: [
        { sourceObjectId: version.sourceObjectId, collectionId: 'fld_restart' },
      ],
    };

    try {
      let store = new MigrationStore(fileDb.db);
      store.saveRun(makeBoundRun());
      store.upsertExportJob(job);
      store.saveSourceObjectVersion(version);
      fileDb.db.close();

      resumedDb = openFileTestDb(fileDb.dbPath);
      store = new MigrationStore(resumedDb);
      expect(store.readExportCaptureEvidence('run-1', job.id)).toEqual({
        capture: null,
        archiveParts: [],
        sourceObjectVersions: [version],
      });
      store.saveSourceObjectVersion(version);
      store.appendSnapshotPart('run-1', part);
      store.saveExportCapture(capture);
      store.appendSnapshotPart('run-1', part);
      store.saveExportCapture(capture);

      expect(store.readExportCaptureEvidence('run-1', job.id)).toEqual({
        capture,
        archiveParts: [part],
        sourceObjectVersions: [version],
      });
      expect(store.listSourceObjects('run-1')).toEqual([version.sourceObject]);
    } finally {
      resumedDb?.close();
      fileDb.cleanup();
    }
  });

  it('rejects targeted capture rows whose SQLite identity no longer matches their body', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    store.saveRun(makeBoundRun());
    const job = makeExportJob({
      id: 'export-correlated',
      matchSignature: 'benchling-export:correlated',
    });
    const version = makeVersion({
      id: 'version-correlated',
      jobId: job.id,
      snapshotId: 'snapshot-correlated',
      capturedAt: '2026-07-17T00:00:02.000Z',
      name: 'Correlated capture',
      memberships: [],
      sourceObjectId: 'etr_correlated',
    });
    const part: SourceSnapshotPart = {
      id: 'part-correlated',
      kind: 'export_archive',
      sha256: 'b'.repeat(64),
      sizeBytes: 64,
      capturedAt: version.capturedAt,
      sourceJobId: job.id,
      sourceObjectId: null,
      supersedesPartId: null,
    };
    const capture: PersistedExportCapture = {
      jobId: job.id,
      runId: 'run-1',
      snapshotId: version.sourceSnapshotId,
      capturedAt: version.capturedAt,
      archiveManifestId: 'manifest-correlated',
      sourceObjectIds: [version.sourceObjectId],
      attachmentReferences: [],
      membershipReferences: [],
    };
    store.upsertExportJob(job);
    store.saveSourceObjectVersion(version);
    store.appendSnapshotPart('run-1', part);
    store.saveExportCapture(capture);

    db.prepare('UPDATE export_capture SET body_json = ? WHERE id = ?').run(
      JSON.stringify({ ...capture, jobId: 'export-other' }),
      job.id
    );
    expect(() => store.getExportCapture('run-1', job.id)).toThrow(/SQLite correlation/i);
    db.prepare('UPDATE export_capture SET body_json = ? WHERE id = ?').run(
      JSON.stringify(capture),
      job.id
    );

    db.prepare('UPDATE snapshot_part SET body_json = ? WHERE id = ?').run(
      JSON.stringify({ ...part, id: 'part-other' }),
      part.id
    );
    expect(() => store.listSnapshotPartsForExportJob('run-1', job.id)).toThrow(
      /SQLite correlation/i
    );
    db.prepare('UPDATE snapshot_part SET body_json = ? WHERE id = ?').run(
      JSON.stringify(part),
      part.id
    );

    db.prepare('UPDATE source_object_version SET body_json = ? WHERE id = ?').run(
      JSON.stringify({ ...version, id: 'version-other' }),
      version.id
    );
    expect(() => store.listSourceObjectVersionsForExportJob('run-1', job.id)).toThrow(
      /SQLite correlation/i
    );
    db.prepare('UPDATE source_object_version SET body_json = ?, run_id = ? WHERE id = ?').run(
      JSON.stringify(version),
      'run-other',
      version.id
    );
    expect(() => store.getSourceObjectVersion('run-1', version.id)).toThrow(/SQLite correlation/i);
    db.close();
  });

  it('retains append-only provider task provenance across restart and rejects unsafe evidence', () => {
    const fileDb = createFileTestDb('benchling-provider-task-evidence');
    let resumedDb: ReturnType<typeof openFileTestDb> | null = null;
    try {
      let store = new MigrationStore(fileDb.db);
      store.saveRun(makeBoundRun());
      const planned = makeExportJob();
      store.upsertExportJob(planned);
      const submitted = {
        ...planned,
        state: 'submitted' as const,
        submittedAt: '2026-07-17T00:00:01.000Z',
        attempts: 1,
      };
      store.upsertExportJob(submitted);
      store.upsertExportJob({ ...submitted, state: 'receipt_pending' });
      const running = makeProviderTaskEvidence();
      store.appendProviderTaskEvidence(running);
      store.appendProviderTaskEvidence(running);

      expect(() =>
        store.appendProviderTaskEvidence({
          ...running,
          id: 'provider-task:wrong-signature',
          matchSignature: 'benchling-export:wrong',
        })
      ).toThrow(/does not match export job/i);
      expect(() =>
        store.appendProviderTaskEvidence({
          ...running,
          id: 'provider-task:unsafe-extra',
          signedUrl: 'https://benchling-temp.s3.amazonaws.com/private?token=secret',
        } as ProviderTaskEvidence)
      ).toThrow(/non-allowlisted field/i);

      fileDb.db.close();
      resumedDb = openFileTestDb(fileDb.dbPath);
      store = new MigrationStore(resumedDb);
      expect(store.listProviderTaskEvidence('run-1')).toEqual([running]);

      const identityMissing = makeProviderTaskEvidence({
        id: 'provider-task:evidence-identity-missing',
        providerTaskHandleSha256: null,
        status: 'ACTION_REQUIRED',
        actionRequired: {
          schema: 'dnaforge.benchling.native-export-action-required.v1',
          code: 'provider_task_identity_invalid',
          providerStatus: null,
          recordedAt: '2026-07-17T00:00:02.500Z',
        },
        observedAt: '2026-07-17T00:00:02.500Z',
      });
      store.appendProviderTaskEvidence(identityMissing);

      const failed = makeProviderTaskEvidence({
        id: 'provider-task:evidence-2',
        status: 'FAILED',
        actionRequired: {
          schema: 'dnaforge.benchling.native-export-action-required.v1',
          code: 'provider_task_failed',
          providerStatus: 'FAILED',
          recordedAt: '2026-07-17T00:00:03.000Z',
        },
        observedAt: '2026-07-17T00:00:03.000Z',
      });
      store.appendProviderTaskEvidence(failed);
      expect(store.listProviderTaskEvidence('run-1')).toEqual([running, identityMissing, failed]);
    } finally {
      resumedDb?.close();
      fileDb.cleanup();
    }
  });

  it('resolves 96 replacement parents through one-row indexed edge lookups', () => {
    const db = createTestDb();
    const parentLookupRows: number[] = [];
    const store = new MigrationStore(db, false, {
      onCapturePersistenceQuery: (kind, returnedRowCount) => {
        if (kind === 'export_replacement_parent_by_job') {
          parentLookupRows.push(returnedRowCount);
        }
      },
    });
    store.saveRun(makeBoundRun());
    const itemCount = 96;

    for (let index = 0; index < itemCount; index += 1) {
      const suffix = String(index).padStart(3, '0');
      const failedJob = makeExportJob({
        id: `failed-edge-${suffix}`,
        matchSignature: `benchling-export:failed-edge:${suffix}`,
        state: 'failed',
      });
      const replacementJob = makeExportJob({
        id: `replacement-edge-${suffix}`,
        matchSignature: `benchling-export:replacement-edge:${suffix}`,
      });
      store.upsertExportJob(failedJob);
      store.upsertExportJob(replacementJob);
      const replacement = {
        failedJobId: failedJob.id,
        runId: 'run-1',
        reason: 'download_link_expired' as const,
        createdAt: `2026-07-18T11:00:${String(index % 60).padStart(2, '0')}.000Z`,
        replacementJobIds: [replacementJob.id],
      };
      store.saveExportJobReplacement(replacement);
      expect(store.getExportJobReplacementParent('run-1', replacementJob.id)).toEqual(replacement);
    }

    expect(parentLookupRows).toEqual(Array(itemCount).fill(1));
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT failed_job_id
         FROM export_job_replacement_edge
         WHERE run_id = ? AND replacement_job_id = ?`
      )
      .all('run-1', 'replacement-edge-000') as Array<{ detail: string }>;
    expect(plan.map(({ detail }) => detail).join('\n')).toMatch(
      /SEARCH export_job_replacement_edge USING INDEX/i
    );
    db.close();
  });

  it('backfills replacement edges on restart and rejects a corrupted edge parent', () => {
    const fileDb = createFileTestDb('benchling-replacement-edge-restart');
    let resumedDb: ReturnType<typeof openFileTestDb> | null = null;
    try {
      let store = new MigrationStore(fileDb.db);
      const failedJob = makeExportJob({
        id: 'failed-edge-restart',
        matchSignature: 'benchling-export:failed-edge-restart',
        state: 'failed',
      });
      const replacementJob = makeExportJob({
        id: 'replacement-edge-restart',
        matchSignature: 'benchling-export:replacement-edge-restart',
      });
      const replacement = {
        failedJobId: failedJob.id,
        runId: 'run-1',
        reason: 'download_link_expired' as const,
        createdAt: '2026-07-18T11:00:00.000Z',
        replacementJobIds: [replacementJob.id],
      };
      store.saveRun(makeBoundRun());
      store.upsertExportJob(failedJob);
      store.upsertExportJob(replacementJob);
      store.saveExportJobReplacement(replacement);
      fileDb.db.prepare('DELETE FROM export_job_replacement_edge').run();
      fileDb.db.close();

      resumedDb = openFileTestDb(fileDb.dbPath);
      store = new MigrationStore(resumedDb);
      expect(store.getExportJobReplacementParent('run-1', replacementJob.id)).toEqual(replacement);

      resumedDb
        .prepare(
          `UPDATE export_job_replacement_edge
           SET failed_job_id = ?
           WHERE run_id = ? AND replacement_job_id = ?`
        )
        .run('missing-parent', 'run-1', replacementJob.id);
      expect(() => store.getExportJobReplacementParent('run-1', replacementJob.id)).toThrow(
        /not authoritative/i
      );
    } finally {
      resumedDb?.close();
      fileDb.cleanup();
    }
  });

  it('rebuilds replacement supersession deterministically across reverse-order restart and resume', () => {
    const chronologicalDb = createFileTestDb('benchling-versions-chronological');
    const resumedDb = createFileTestDb('benchling-versions-resumed');
    const early = makeVersion({
      id: 'version-early',
      jobId: 'export-a',
      snapshotId: 'snapshot-early',
      capturedAt: '2026-07-18T11:00:00.000Z',
      name: 'Earlier',
      memberships: ['fld_early'],
    });
    const late = makeVersion({
      id: 'version-late',
      jobId: 'export-b',
      snapshotId: 'snapshot-late',
      capturedAt: '2026-07-18T11:30:00.000Z',
      name: 'Later',
      memberships: ['fld_late'],
    });
    const prepare = (store: MigrationStore) => {
      store.saveRun(makeBoundRun());
      store.upsertExportJob(
        makeExportJob({
          id: 'export-a',
          matchSignature: 'benchling-export:a',
          state: 'failed',
        })
      );
      store.upsertExportJob(
        makeExportJob({ id: 'export-b', matchSignature: 'benchling-export:b' })
      );
      store.saveExportJobReplacement({
        failedJobId: 'export-a',
        runId: 'run-1',
        reason: 'export_timed_out',
        createdAt: '2026-07-18T11:15:00.000Z',
        replacementJobIds: ['export-b'],
      });
    };

    let resumedFileDb: ReturnType<typeof openFileTestDb> | null = null;
    try {
      const chronological = new MigrationStore(chronologicalDb.db);
      prepare(chronological);
      chronological.saveSourceObjectVersion(early);
      chronological.saveSourceObjectVersion(late);
      const expectedVersions = chronological.listSourceObjectVersions('run-1');
      const expectedCurrent = chronological.listSourceObjects('run-1');

      let resumed = new MigrationStore(resumedDb.db);
      prepare(resumed);
      resumed.saveSourceObjectVersion(late);
      resumedDb.db.close();

      resumedFileDb = openFileTestDb(resumedDb.dbPath);
      resumed = new MigrationStore(resumedFileDb);
      resumed.saveSourceObjectVersion(early);

      expect(resumed.listSourceObjectVersions('run-1')).toEqual(expectedVersions);
      expect(resumed.listSourceObjects('run-1')).toEqual(expectedCurrent);
      expect(expectedVersions.map((version) => version.supersedesVersionId)).toEqual([
        null,
        'version-early',
      ]);
      expect(expectedVersions.map((version) => version.sourceObject.memberships)).toEqual([
        ['fld_early'],
        ['fld_late'],
      ]);
      expect(expectedCurrent).toEqual([
        expect.objectContaining({
          name: 'Later',
          metadata: { revision: 'Later' },
          memberships: ['fld_late'],
        }),
      ]);

      expect(() =>
        resumed.saveSourceObjectVersion({
          ...early,
          sourceObject: { ...early.sourceObject, name: 'Mutated' },
        })
      ).toThrow(/content is immutable/i);
    } finally {
      resumedFileDb?.close();
      chronologicalDb.cleanup();
      resumedDb.cleanup();
    }
  });

  it('rejects conflicting content across unrelated active leaves transactionally', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    store.saveRun(makeBoundRun());
    store.upsertExportJob(makeExportJob({ id: 'export-a', matchSignature: 'benchling-export:a' }));
    store.upsertExportJob(makeExportJob({ id: 'export-b', matchSignature: 'benchling-export:b' }));
    const first = makeVersion({
      id: 'version-active-a',
      jobId: 'export-a',
      snapshotId: 'snapshot-export-a',
      capturedAt: '2026-07-18T11:00:00.000Z',
      name: 'Scientific state A',
      memberships: ['fld_alpha'],
    });
    const conflicting = makeVersion({
      id: 'version-active-b',
      jobId: 'export-b',
      snapshotId: 'snapshot-export-b',
      capturedAt: '2026-07-18T11:05:00.000Z',
      name: 'Scientific state B',
      memberships: ['fld_beta'],
    });

    store.saveSourceObjectVersion(first);
    let conflict: unknown;
    try {
      store.saveSourceObjectVersion(conflicting);
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(SourceObjectContentConflictError);
    expect(conflict).toMatchObject({
      name: 'SourceObjectContentConflictError',
      runId: 'run-1',
      sourceObjectId: 'etr_shared',
      activeSourceJobIds: ['export-a', 'export-b'],
      message:
        'Source object etr_shared has conflicting non-membership content across active export leaves: export-a, export-b.',
    });

    expect(store.listSourceObjectVersions('run-1')).toEqual([
      expect.objectContaining({ id: first.id, supersedesVersionId: null }),
    ]);
    expect(store.listSourceObjects('run-1')).toEqual([
      expect.objectContaining({
        name: 'Scientific state A',
        memberships: ['fld_alpha'],
      }),
    ]);
    db.close();
  });

  it('supersedes only a replaced branch while retaining unrelated active memberships', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    store.saveRun(makeBoundRun());
    store.upsertExportJob(
      makeExportJob({
        id: 'export-a',
        matchSignature: 'benchling-export:a',
        state: 'failed',
      })
    );
    store.upsertExportJob(makeExportJob({ id: 'export-b', matchSignature: 'benchling-export:b' }));
    store.upsertExportJob(
      makeExportJob({ id: 'export-a2', matchSignature: 'benchling-export:a2' })
    );

    const replacedBranch = makeVersion({
      id: 'version-replaced-a',
      jobId: 'export-a',
      snapshotId: 'snapshot-export-a',
      capturedAt: '2026-07-18T11:00:00.000Z',
      name: 'Shared active content',
      memberships: ['fld_alpha_stale'],
    });
    const unrelatedBranch = makeVersion({
      id: 'version-unrelated-b',
      jobId: 'export-b',
      snapshotId: 'snapshot-export-b',
      capturedAt: '2026-07-18T11:05:00.000Z',
      name: 'Shared active content',
      memberships: ['fld_beta'],
    });

    store.saveSourceObjectVersion(unrelatedBranch);
    store.saveSourceObjectVersion(replacedBranch);
    expect(store.listSourceObjects('run-1')).toEqual([
      expect.objectContaining({
        name: 'Shared active content',
        memberships: ['fld_alpha_stale', 'fld_beta'],
      }),
    ]);

    store.saveExportJobReplacement({
      failedJobId: 'export-a',
      runId: 'run-1',
      reason: 'export_timed_out',
      createdAt: '2026-07-18T11:06:00.000Z',
      replacementJobIds: ['export-a2'],
    });
    expect(store.listSourceObjects('run-1')).toEqual([
      expect.objectContaining({
        name: 'Shared active content',
        memberships: ['fld_beta'],
      }),
    ]);

    const replacementBranch = makeVersion({
      id: 'version-replacement-a2',
      jobId: 'export-a2',
      snapshotId: 'snapshot-export-a2',
      capturedAt: '2026-07-18T11:10:00.000Z',
      name: 'Shared active content',
      memberships: ['fld_alpha_current'],
    });
    store.saveSourceObjectVersion(replacementBranch);
    expect(store.listSourceObjects('run-1')).toEqual([
      expect.objectContaining({
        name: 'Shared active content',
        metadata: { revision: 'Shared active content' },
        memberships: ['fld_alpha_current', 'fld_beta'],
      }),
    ]);
    expect(
      store.listSourceObjectVersions('run-1').map((version) => version.sourceObject.memberships)
    ).toEqual([['fld_alpha_stale'], ['fld_beta'], ['fld_alpha_current']]);

    store.saveSourceObjectVersion(
      makeVersion({
        id: 'version-removed-a2',
        jobId: 'export-a2',
        snapshotId: 'snapshot-export-a2',
        capturedAt: '2026-07-18T11:10:00.000Z',
        name: 'Removed in nested replacement',
        memberships: ['fld_removed'],
        sourceObjectId: 'etr_removed',
      })
    );
    expect(
      store
        .listSourceObjects('run-1')
        .map((object) => object.id)
        .sort()
    ).toEqual(['etr_removed', 'etr_shared']);

    const failedA2 = store.getExportJob('export-a2');
    if (!failedA2) throw new Error('Missing nested replacement parent.');
    store.upsertExportJob({ ...failedA2, state: 'failed' });
    store.upsertExportJob(
      makeExportJob({ id: 'export-a3', matchSignature: 'benchling-export:a3' })
    );
    store.saveExportJobReplacement({
      failedJobId: 'export-a2',
      runId: 'run-1',
      reason: 'export_timed_out',
      createdAt: '2026-07-18T11:11:00.000Z',
      replacementJobIds: ['export-a3'],
    });
    expect(store.listSourceObjects('run-1')).toEqual([
      expect.objectContaining({
        id: 'etr_shared',
        name: 'Shared active content',
        memberships: ['fld_beta'],
      }),
    ]);

    store.saveSourceObjectVersion(
      makeVersion({
        id: 'version-replacement-a3',
        jobId: 'export-a3',
        snapshotId: 'snapshot-export-a3',
        capturedAt: '2026-07-18T11:15:00.000Z',
        name: 'Shared active content',
        memberships: ['fld_alpha_nested'],
      })
    );
    expect(store.listSourceObjects('run-1')).toEqual([
      expect.objectContaining({
        id: 'etr_shared',
        name: 'Shared active content',
        memberships: ['fld_alpha_nested', 'fld_beta'],
      }),
    ]);

    store.saveExportJobReplacement({
      failedJobId: 'export-a',
      runId: 'run-1',
      reason: 'export_timed_out',
      createdAt: '2026-07-18T11:06:00.000Z',
      replacementJobIds: ['export-a2'],
    });
    expect(store.listSourceObjects('run-1')).toEqual([
      expect.objectContaining({
        name: 'Shared active content',
        memberships: ['fld_alpha_nested', 'fld_beta'],
      }),
    ]);
    db.close();
  });

  it('upgrades an intact schema-v2 database to v3 and creates recovery tables', () => {
    const db = createTestDb();
    const original = new MigrationStore(db);
    const run = makeRun();
    original.saveRun(run);
    original.close();
    db.exec(`
      DROP TABLE workspace_append_hierarchy_capture;
      DROP TABLE linked_item_recovery_capture;
      DROP TABLE linked_item_recovery_artifact;
      DROP TABLE linked_item_recovery_attempt;
      DROP TABLE projection_receipt_revision;
      UPDATE migration_meta SET value = '2' WHERE key = 'schema_version';
    `);

    const upgraded = new MigrationStore(db);
    expect(upgraded.getRun()).toEqual(run);
    expect(
      db.prepare("SELECT value FROM migration_meta WHERE key = 'schema_version'").get()
    ).toEqual({ value: '3' });
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table'
             AND name IN (
               'linked_item_recovery_attempt',
               'linked_item_recovery_artifact',
               'linked_item_recovery_capture',
               'projection_receipt_revision',
               'workspace_append_hierarchy_capture'
             )
           ORDER BY name`
        )
        .all()
    ).toEqual([
      { name: 'linked_item_recovery_artifact' },
      { name: 'linked_item_recovery_attempt' },
      { name: 'linked_item_recovery_capture' },
      { name: 'projection_receipt_revision' },
      { name: 'workspace_append_hierarchy_capture' },
    ]);
    db.close();
  });

  it('reads an attempt written before append existed as a linked-item recovery', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    store.saveRun(makeReadyLocalRecoveryRun());
    const attempt = makeRecoveryAttempt();
    store.putLinkedItemRecoveryAttempt(attempt);
    const {
      mode: _omittedMode,
      versionConflictResolution: _omittedVersionConflictResolution,
      ...legacyAttempt
    } = attempt;
    db.prepare('UPDATE linked_item_recovery_attempt SET body_json = ? WHERE id = ?').run(
      JSON.stringify(legacyAttempt),
      attempt.id
    );

    expect(store.getLinkedItemRecoveryAttempt('run-1', attempt.id)).toEqual({
      ...attempt,
      mode: 'linked_item_recovery',
    });
    store.close();
  });

  it('refuses an append-shaped attempt that claims to be a recovery without a plan', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    store.saveRun(makeReadyLocalRecoveryRun());

    expect(() =>
      store.putLinkedItemRecoveryAttempt(makeRecoveryAttempt({ recoveryPlan: null }))
    ).toThrow(/requires a recovery plan/);
    expect(() =>
      store.putLinkedItemRecoveryAttempt(
        makeRecoveryAttempt({ mode: 'workspace_append', recoveryPlan: null })
      )
    ).not.toThrow();
    store.close();
  });

  it('persists restartable multi-file recovery attempts with rejected files counted as processed', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    store.saveRun(makeReadyLocalRecoveryRun());
    const initial = makeRecoveryAttempt();
    const artifact = makeRecoveryArtifact();
    store.putLinkedItemRecoveryAttempt(initial);
    store.appendLinkedItemRecoveryArtifact(artifact);
    const parsing: LinkedItemRecoveryAttempt = {
      ...initial,
      state: 'parsing',
      artifactIds: [artifact.id],
      fileResults: [
        { fileIndex: 0, outcome: 'accepted', artifactId: artifact.id, failure: null },
        {
          fileIndex: 1,
          outcome: 'rejected',
          artifactId: null,
          failure: {
            code: 'unsafe_archive',
            message: 'One selected ZIP was not a safe archive.',
            retryable: true,
          },
        },
      ],
      processedFileCount: 2,
      updatedAt: '2026-08-13T10:01:03.000Z',
    };
    store.putLinkedItemRecoveryAttempt(parsing);
    const reconciling = {
      ...parsing,
      state: 'reconciling' as const,
      recoveredUniqueObjectCount: 1,
      updatedAt: '2026-08-13T10:01:04.000Z',
    };
    store.putLinkedItemRecoveryAttempt(reconciling);
    const validating = {
      ...reconciling,
      state: 'validating' as const,
      repairedRelationshipCount: 2,
      updatedAt: '2026-08-13T10:01:05.000Z',
    };
    store.putLinkedItemRecoveryAttempt(validating);
    const completed = {
      ...validating,
      state: 'completed' as const,
      updatedAt: '2026-08-13T10:01:06.000Z',
      completedAt: '2026-08-13T10:01:06.000Z',
    };
    store.putLinkedItemRecoveryAttempt(completed);
    store.close();

    const reopened = new MigrationStore(db);
    expect(reopened.getLinkedItemRecoveryAttempt('run-1', initial.id)).toEqual(completed);
    expect(reopened.listLinkedItemRecoveryAttempts('run-1')).toEqual([completed]);
    expect(
      reopened.getLinkedItemRecoveryArtifactBySha256('run-1', artifact.artifact.sha256)
    ).toEqual(artifact);
    expect(reopened.listLinkedItemRecoveryArtifacts('run-1', initial.id)).toEqual([artifact]);
    const retry = makeRecoveryAttempt({
      id: 'linked-recovery-attempt-2',
      createdAt: '2026-08-13T10:02:00.000Z',
      updatedAt: '2026-08-13T10:02:00.000Z',
    });
    reopened.putLinkedItemRecoveryAttempt(retry);
    reopened.putLinkedItemRecoveryAttempt({
      ...retry,
      artifactIds: [artifact.id],
      fileResults: [{ fileIndex: 0, outcome: 'accepted', artifactId: artifact.id, failure: null }],
      processedFileCount: 1,
      updatedAt: '2026-08-13T10:02:01.000Z',
    });
    expect(reopened.listLinkedItemRecoveryArtifacts('run-1', retry.id)).toEqual([artifact]);
    expect(reopened.getActiveLinkedItemRecoveryAttempt('run-1')).toMatchObject({ id: retry.id });
    const failedRetry: LinkedItemRecoveryAttempt = {
      ...retry,
      artifactIds: [artifact.id],
      fileResults: [{ fileIndex: 0, outcome: 'accepted', artifactId: artifact.id, failure: null }],
      processedFileCount: 1,
      state: 'failed',
      resumeState: 'copying',
      safeFailure: {
        code: 'copy_failed',
        message: 'One selected ZIP could not be copied.',
        retryable: true,
      },
      updatedAt: '2026-08-13T10:02:02.000Z',
    };
    reopened.putLinkedItemRecoveryAttempt(failedRetry);
    expect(reopened.getActiveLinkedItemRecoveryAttempt('run-1')).toBeNull();
    expect(() =>
      reopened.putLinkedItemRecoveryAttempt({
        ...failedRetry,
        state: 'copying',
        resumeState: null,
        safeFailure: null,
        updatedAt: '2026-08-13T10:02:03.000Z',
      })
    ).toThrow(/terminal.*immutable/iu);
    expect(() =>
      reopened.putLinkedItemRecoveryAttempt({
        ...completed,
        state: 'validating',
        completedAt: null,
        updatedAt: '2026-08-13T10:01:07.000Z',
      })
    ).toThrow(/terminal.*immutable/iu);
    db.close();
  });

  it('round-trips one immutable append hierarchy tied to its accepted artifact', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    store.saveRun(makeReadyLocalRecoveryRun());
    const initial = makeRecoveryAttempt({ mode: 'workspace_append', recoveryPlan: null });
    const artifact = makeRecoveryArtifact();
    store.putLinkedItemRecoveryAttempt(initial);
    store.appendLinkedItemRecoveryArtifact(artifact);
    store.putLinkedItemRecoveryAttempt({
      ...initial,
      state: 'parsing',
      artifactIds: [artifact.id],
      fileResults: [{ fileIndex: 0, outcome: 'accepted', artifactId: artifact.id, failure: null }],
      processedFileCount: 1,
      updatedAt: '2026-08-13T10:01:03.000Z',
    });
    const existingObject = makeRecoveredSourceObject({
      id: 'seq_APPEND',
      stableId: 'seq_APPEND',
      memberships: ['lib_local_recovery'],
    });
    const existingRegistryObject = makeRecoveredSourceObject({
      id: 'bfi_APPENDREGISTRY',
      stableId: 'bfi_APPENDREGISTRY',
      sourceType: 'notebook_entry',
      memberships: ['lib_local_recovery'],
    });
    store.putSourceObject('run-1', existingRegistryObject);
    store.putSourceObject('run-1', existingObject);
    const scientificHashBefore = scientificSourceObjectSha256(existingObject);
    const capture = makeAppendHierarchyCapture();

    expect(store.appendWorkspaceAppendHierarchyCapture(capture)).toEqual(capture);
    expect(store.appendWorkspaceAppendHierarchyCapture(capture)).toEqual(capture);
    expect(store.getWorkspaceAppendHierarchyCapture(capture.runId, capture.artifactId)).toEqual(
      capture
    );
    expect(store.listWorkspaceAppendHierarchyCaptures(capture.runId)).toEqual([capture]);
    expect(store.listSourceObjects(capture.runId)).toEqual([
      {
        ...existingRegistryObject,
        memberships: ['lib_local_recovery', 'local_folder_dfa1f4dc02a6b986cfb6e54c'],
      },
      {
        ...existingObject,
        memberships: ['lib_local_recovery', 'local_folder_dfa1f4dc02a6b986cfb6e54c'],
      },
    ]);
    expect(
      scientificSourceObjectSha256(
        store
          .listSourceObjects(capture.runId)
          .find((sourceObject) => sourceObject.id === existingObject.id)!
      )
    ).toBe(scientificHashBefore);
    expect(() =>
      store.appendWorkspaceAppendHierarchyCapture({
        ...capture,
        capturedAt: '2026-08-13T10:01:05.000Z',
      })
    ).toThrow(/immutable/i);
    expect(() =>
      store.appendWorkspaceAppendHierarchyCapture({
        ...capture,
        id: 'workspace-append-hierarchy-wrong-attempt',
        attemptId: 'missing-attempt',
      })
    ).toThrow(/attempt evidence/i);
    expect(() =>
      store.appendWorkspaceAppendHierarchyCapture({
        ...capture,
        id: 'workspace-append-hierarchy-wrong-artifact',
        artifactId: 'missing-artifact',
      })
    ).toThrow(/artifact evidence/i);

    store.close();
    const reopened = new MigrationStore(db);
    expect(reopened.listWorkspaceAppendHierarchyCaptures(capture.runId)).toEqual([capture]);
    reopened.close();
    const corrupted = {
      ...capture,
      folders: [{ ...capture.folders[0], parentSourceId: 'missing-parent' }],
    };
    db.prepare('UPDATE workspace_append_hierarchy_capture SET body_json = ? WHERE id = ?').run(
      JSON.stringify(corrupted),
      capture.id
    );
    const corruptReopen = new MigrationStore(db);
    expect(() => corruptReopen.listWorkspaceAppendHierarchyCaptures(capture.runId)).toThrow(
      /folder evidence is invalid/i
    );
    corruptReopen.close();
  });

  it.each(['memory', 'legacy-reopen'] as const)(
    'atomically adds exact recovered scientific content without changing snapshot metadata in %s',
    (persistence) => {
      const file =
        persistence === 'legacy-reopen' ? createFileTestDb('legacy-capture-upgrade') : null;
      let db = file?.db ?? createTestDb();
      let store = new MigrationStore(db);
      if (file) {
        const definition = db
          .prepare("SELECT sql FROM sqlite_master WHERE name='linked_item_recovery_capture'")
          .get();
        if (
          !definition ||
          typeof definition !== 'object' ||
          !('sql' in definition) ||
          typeof definition.sql !== 'string'
        )
          throw new Error('Missing capture schema');
        const oldSchema = definition.sql
          .replace(
            'UNIQUE (run_id, attempt_id, artifact_id, source_object_id)',
            'UNIQUE (run_id, artifact_id, source_object_id)'
          )
          .replace(
            'UNIQUE (run_id, attempt_id, snapshot_part_id)',
            'UNIQUE (run_id, snapshot_part_id)'
          );
        expect(oldSchema).not.toBe(definition.sql);
        expect(
          db.prepare('SELECT count(*) AS count FROM linked_item_recovery_capture').get()
        ).toEqual({ count: 0 });
        db.exec('DROP TABLE linked_item_recovery_capture');
        db.exec(oldSchema);
      }
      const run = makeReadyLocalRecoveryRun();
      store.saveRun(run);
      const originalPart: SourceSnapshotPart = {
        id: 'local-export-original',
        kind: 'local_export',
        sha256: '1'.repeat(64),
        sizeBytes: run.localExportArtifact!.sizeBytes,
        capturedAt: run.localExportArtifact!.capturedAt,
        sourceJobId: null,
        sourceObjectId: null,
        supersedesPartId: null,
      };
      const snapshot: SourceSnapshot = {
        version: 1,
        id: 'snapshot-1',
        runId: run.id,
        accountHash: run.localExportArtifact!.sha256,
        createdAt: run.localExportArtifact!.capturedAt,
        archiveManifestId: 'snapshot-1',
        initialSourceObjectIds: ['seq_1'],
        expectedSourceObjectCount: 1,
        expectedAttachmentCount: 0,
        expectedMembershipCount: 0,
        parts: [originalPart],
      };
      store.saveSourceSnapshot(snapshot);
      const attempt = makeRecoveryAttempt({
        selectedFileCount: 1,
        intakeDescriptors: [makeRecoveryIntake(1)],
      });
      const artifact = makeRecoveryArtifact();
      store.putLinkedItemRecoveryAttempt(attempt);
      store.appendLinkedItemRecoveryArtifact(artifact);
      store.putLinkedItemRecoveryAttempt({
        ...attempt,
        state: 'parsing',
        artifactIds: [artifact.id],
        fileResults: [
          { fileIndex: 0, outcome: 'accepted', artifactId: artifact.id, failure: null },
        ],
        processedFileCount: 1,
        updatedAt: '2026-08-13T10:01:03.000Z',
      });
      const sourceObject = makeRecoveredSourceObject();
      const capture: LinkedItemRecoveryCapture = {
        schema: 'dnaforge.benchling.linked-item-recovery-capture.v1',
        id: 'linked-recovery-capture-1',
        runId: run.id,
        attemptId: attempt.id,
        artifactId: artifact.id,
        sourceObjectId: sourceObject.id,
        sourceStableId: sourceObject.stableId,
        sourceScientificContentSha256: scientificSourceObjectSha256(sourceObject),
        snapshotPartId: 'supplemental-local-export-1',
        capturedAt: '2026-08-13T10:01:04.000Z',
      };
      const supplementalPart: SourceSnapshotPart = {
        id: capture.snapshotPartId,
        kind: 'supplemental_local_export',
        sha256: artifact.artifact.sha256.slice('sha256:'.length),
        sizeBytes: artifact.artifact.sizeBytes,
        capturedAt: capture.capturedAt,
        sourceJobId: null,
        sourceObjectId: sourceObject.id,
        supersedesPartId: null,
      };
      const { parts: _originalParts, ...metadataBefore } = store.getSourceSnapshot(run.id)!;

      expect(
        store.commitLinkedItemRecoveryCapture({
          capture,
          snapshotPart: supplementalPart,
          sourceObject,
        })
      ).toEqual({ sourceObjectInserted: true });
      expect(
        store.commitLinkedItemRecoveryCapture({
          capture,
          snapshotPart: supplementalPart,
          sourceObject,
        })
      ).toEqual({ sourceObjectInserted: false });
      const restoredSnapshot = store.getSourceSnapshot(run.id)!;
      const { parts: restoredParts, ...metadataAfter } = restoredSnapshot;
      expect(metadataAfter).toEqual(metadataBefore);
      expect(restoredParts).toEqual([originalPart, supplementalPart]);
      expect(store.listLinkedItemRecoveryCaptures(run.id, attempt.id)).toEqual([capture]);
      expect(store.listSourceObjects(run.id)).toContainEqual(sourceObject);

      expect(
        store.putRecoveredSourceObjectExact(run.id, {
          ...sourceObject,
          sourceUrl: 'https://benchling.com/example/another-route/seq_recovered',
          sourcePath: 'another/path.gb',
          metadata: {
            nativeExport: { entryPath: 'another/path.gb' },
            linkedItemRecovery: { supplementaryExportSha256: `sha256:${'3'.repeat(64)}` },
          },
        })
      ).toBe('unchanged');
      expect(() =>
        store.putRecoveredSourceObjectExact(run.id, {
          ...sourceObject,
          content: { sequence: 'ATGA' },
        })
      ).toThrow(RecoveredSourceObjectContentConflictError);
      expect(store.listSnapshotParts(run.id)).toEqual([originalPart, supplementalPart]);
      expect(store.listLinkedItemRecoveryCaptures(run.id)).toEqual([capture]);
      if (file) {
        const firstAttempt = store.getLinkedItemRecoveryAttempt(run.id, attempt.id)!;
        store.putLinkedItemRecoveryAttempt({
          ...firstAttempt,
          state: 'reconciling',
          updatedAt: '2026-08-13T10:01:04.000Z',
        });
        store.putLinkedItemRecoveryAttempt({
          ...firstAttempt,
          state: 'validating',
          updatedAt: '2026-08-13T10:01:05.000Z',
        });
        store.putLinkedItemRecoveryAttempt({
          ...firstAttempt,
          state: 'completed',
          updatedAt: '2026-08-13T10:01:06.000Z',
          completedAt: '2026-08-13T10:01:06.000Z',
        });
        const secondAttempt = makeRecoveryAttempt({ id: 'linked-recovery-attempt-2' });
        store.putLinkedItemRecoveryAttempt(secondAttempt);
        store.putLinkedItemRecoveryAttempt({
          ...secondAttempt,
          state: 'parsing',
          artifactIds: [artifact.id],
          fileResults: [
            { fileIndex: 0, outcome: 'duplicate', artifactId: artifact.id, failure: null },
          ],
          processedFileCount: 1,
          updatedAt: '2026-08-13T10:01:03.000Z',
        });
        const secondCapture = {
          ...capture,
          id: 'capture-second-occurrence',
          attemptId: secondAttempt.id,
        };
        const firstBody = db
          .prepare('SELECT body_json FROM linked_item_recovery_capture WHERE id=?')
          .get(capture.id);
        expect(() =>
          store.commitLinkedItemRecoveryCapture({
            capture: secondCapture,
            snapshotPart: supplementalPart,
            sourceObject,
          })
        ).toThrow(/UNIQUE constraint/);
        store.close();
        db.close();
        db = openFileTestDb(file.dbPath);
        store = new MigrationStore(db);
        expect(
          db
            .prepare('SELECT body_json FROM linked_item_recovery_capture WHERE id=?')
            .get(capture.id)
        ).toEqual(firstBody);
        expect(store.getSourceSnapshot(run.id)).toEqual(restoredSnapshot);
        expect(store.listLinkedItemRecoveryCaptures(run.id)).toEqual([capture]);
        for (let retry = 0; retry < 2; retry++)
          expect(
            store.commitLinkedItemRecoveryCapture({
              capture: secondCapture,
              snapshotPart: supplementalPart,
              sourceObject,
            })
          ).toEqual({ sourceObjectInserted: false });
        expect(store.listLinkedItemRecoveryCaptures(run.id)).toEqual([capture, secondCapture]);
        expect(store.listSnapshotParts(run.id)).toEqual([originalPart, supplementalPart]);
        expect(() =>
          store.commitLinkedItemRecoveryCapture({
            capture: { ...secondCapture, id: 'conflicting-capture' },
            snapshotPart: supplementalPart,
            sourceObject,
          })
        ).toThrow(/UNIQUE constraint/);
        expect(db.pragma('foreign_key_check')).toEqual([]);
        expect(
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_linked_item_recovery_capture_attempt'"
            )
            .get()
        ).toEqual({ name: 'idx_linked_item_recovery_capture_attempt' });
        store.close();
        db.close();
        db = openFileTestDb(file.dbPath);
        store = new MigrationStore(db);
        expect(store.listLinkedItemRecoveryCaptures(run.id)).toEqual([capture, secondCapture]);
        expect(store.getSourceSnapshot(run.id)).toEqual(restoredSnapshot);
      }
      store.close();
      db.close();
      file?.cleanup();
    }
  );

  it('completes only an unresolved zero-base sequence and rejects every other changed source', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    const run = makeReadyLocalRecoveryRun();
    store.saveRun(run);
    const unresolved = makeRecoveredSourceObject({
      content: {
        kind: 'dna_sequence_needs_sequence',
        moleculeType: 'DNA',
        bases: '',
        topology: 'linear',
        annotations: [],
        genbankMetadata: { sourceFields: [] },
      },
    });
    const complete = makeRecoveredSourceObject({
      content: {
        moleculeType: 'DNA',
        bases: 'ATGC',
        topology: 'linear',
        annotations: [],
      },
    });
    store.putSourceObject(run.id, unresolved);

    expect(
      store.putRecoveredSourceObjectForSupplementalImport(run.id, complete, {
        kind: 'complete_needs_sequence',
        expectedExistingScientificContentSha256: scientificSourceObjectSha256(unresolved),
      })
    ).toBe('completed_needs_sequence');
    expect(store.listSourceObjects(run.id)).toContainEqual(complete);
    expect(
      store.putRecoveredSourceObjectForSupplementalImport(run.id, complete, { kind: 'exact' })
    ).toBe('unchanged');
    expect(() =>
      store.putRecoveredSourceObjectForSupplementalImport(
        run.id,
        {
          ...complete,
          content: { ...(complete.content as Record<string, unknown>), bases: 'TTTT' },
        },
        {
          kind: 'complete_needs_sequence',
          expectedExistingScientificContentSha256: scientificSourceObjectSha256(unresolved),
        }
      )
    ).toThrow(RecoveredSourceObjectContentConflictError);
    db.close();
  });

  it('pins each receipt to its original source through replacement and restart', () => {
    const file = createFileTestDb('projection-source-snapshots');
    let db = file.db;
    let store = new MigrationStore(db);
    store.saveRun(makeRun());
    const first = makeRecoveredSourceObject({ id: 'seq_1' });
    const second = { ...first, name: 'Changed source', content: { bases: 'TTTT' } };
    const receipt = makeReceipt({ sourceHash: projectionSourceHash(first) });
    store.putSourceObject(receipt.runId, first);
    store.appendProjectionReceipt(receipt);
    store.putSourceObject(receipt.runId, second);
    const revision = makeReceipt({
      id: 'receipt-2',
      sourceHash: projectionSourceHash(second),
      createdAt: '2026-08-31T01:00:00.000Z',
    });
    store.appendProjectionReceiptRevision({ receipt: revision, supersedesReceiptId: receipt.id });
    store.appendProjectionReceipt(receipt);
    store.close();
    db.close();
    db = openFileTestDb(file.dbPath);
    store = new MigrationStore(db);
    expect(store.getProjectionReceiptSource(receipt.runId, receipt.id)).toEqual(first);
    expect(store.getProjectionReceiptSource(receipt.runId, revision.id)).toEqual(second);
    expect(store.getProjectionReceiptSource('other-run', receipt.id)).toBeNull();
    store.close();
    db.close();
    file.cleanup();
  });

  it('upgrades only exact available legacy receipt sources and preserves existing pins', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    const first = makeRecoveredSourceObject({ id: 'seq_1' });
    const second = { ...first, content: { bases: 'TTTT' } };
    const base = makeReceipt({ sourceHash: projectionSourceHash(first) });
    store.putSourceObject(base.runId, first);
    store.appendProjectionReceipt(base);
    const revision = {
      ...base,
      id: 'receipt-2',
      sourceHash: projectionSourceHash(second),
      createdAt: '2026-08-31T01:00:00.000Z',
    };
    store.putSourceObject(base.runId, second);
    store.appendProjectionReceiptRevision({ receipt: revision, supersedesReceiptId: base.id });
    db.exec('DELETE FROM projection_receipt_source; DELETE FROM projection_source_blob');
    store.pinAvailableProjectionReceiptSources('other-run');
    expect(store.getProjectionReceiptSource(base.runId, revision.id)).toBeNull();
    store.pinAvailableProjectionReceiptSources(base.runId);
    expect(store.getProjectionReceiptSource(base.runId, base.id)).toBeNull();
    expect(store.getProjectionReceiptSource(base.runId, revision.id)).toEqual(second);
    store.putSourceObject(base.runId, first);
    store.pinAvailableProjectionReceiptSources(base.runId);
    expect(store.getProjectionReceiptSource(base.runId, base.id)).toEqual(first);
    expect(store.getProjectionReceiptSource(base.runId, revision.id)).toEqual(second);
    const rereadSources = vi.spyOn(store, 'listSourceObjects');
    store.pinAvailableProjectionReceiptSources(base.runId);
    expect(rereadSources).not.toHaveBeenCalled();
    rereadSources.mockRestore();
    expect(db.prepare('SELECT count(*) AS count FROM projection_receipt_source').get()).toEqual({
      count: 2,
    });
    store.close();
    db.close();
  });

  it('rejects a source pin reassigned to a different valid generation', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    const first = makeRecoveredSourceObject({ id: 'seq_1' });
    const receipt = makeReceipt({ sourceHash: projectionSourceHash(first) });
    store.putSourceObject(receipt.runId, first);
    store.appendProjectionReceipt(receipt);
    const second = { ...first, content: { bases: 'TTTT' } };
    store.putSourceObject(receipt.runId, second);
    const revision = makeReceipt({
      id: 'receipt-2',
      sourceHash: projectionSourceHash(second),
      createdAt: '2026-08-31T01:00:00.000Z',
    });
    store.appendProjectionReceiptRevision({ receipt: revision, supersedesReceiptId: receipt.id });
    db.prepare('UPDATE projection_receipt_source SET sha256=? WHERE receipt_id=?').run(
      revision.sourceHash,
      receipt.id
    );
    expect(() => store.getProjectionReceiptSource(receipt.runId, receipt.id)).toThrow(
      /snapshot.*integrity/i
    );
    expect(store.getProjectionReceiptSource(receipt.runId, revision.id)).toEqual(second);
    db.close();
  });

  it('rejects corrupted shared source bytes before committing a second receipt', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    const source = makeRecoveredSourceObject({ id: 'seq_1' });
    const receipt = makeReceipt({ sourceHash: projectionSourceHash(source) });
    store.putSourceObject(receipt.runId, source);
    store.appendProjectionReceipt(receipt);
    db.prepare('UPDATE projection_source_blob SET body_json=? WHERE sha256=?').run(
      JSON.stringify({ ...source, name: 'Changed bytes' }),
      receipt.sourceHash
    );
    const revision = {
      ...receipt,
      id: 'receipt-2',
      createdAt: '2026-08-31T01:00:00.000Z',
    };
    expect(() =>
      store.appendProjectionReceiptRevision({
        receipt: revision,
        supersedesReceiptId: receipt.id,
        sourceSnapshot: source,
      })
    ).toThrow(/snapshot.*integrity/i);
    expect(store.listProjectionReceipts(receipt.runId)).toEqual([receipt]);
    expect(db.prepare('SELECT count(*) AS count FROM projection_receipt_source').get()).toEqual({
      count: 1,
    });
    db.close();
  });

  it('rolls back a receipt and revision when their source snapshot does not match', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    const source = makeRecoveredSourceObject({ id: 'seq_1' });
    store.putSourceObject('run-1', source);
    expect(() => store.appendProjectionReceipt(makeReceipt())).toThrow(/source snapshot/);
    expect(store.listProjectionReceiptHistory('run-1')).toEqual([]);
    const receipt = makeReceipt({ sourceHash: projectionSourceHash(source) });
    store.appendProjectionReceipt(receipt);
    const revision = makeReceipt({ id: 'receipt-2', createdAt: '2026-08-31T01:00:00.000Z' });
    expect(() =>
      store.appendProjectionReceiptRevision({ receipt: revision, supersedesReceiptId: receipt.id })
    ).toThrow(/source snapshot/);
    expect(store.listProjectionReceipts('run-1')).toEqual([receipt]);
    expect(db.prepare('SELECT count(*) AS count FROM projection_source_blob').get()).toEqual({
      count: 1,
    });
    db.close();
  });

  it('keeps projection revisions append-only while returning only active receipts', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    const base = makeReceipt();
    const other = makeReceipt({
      id: 'receipt-other',
      sourceObjectId: 'seq_other',
      destinationObjectId: 'sequence/seq_other',
      destinationPath: 'Benchling Imports/sequence__seq_other.gb',
    });
    store.appendProjectionReceipt(base);
    store.appendProjectionReceipt(other);
    const persistedBaseBody = (
      db.prepare('SELECT body_json FROM projection_receipt WHERE id = ?').get(base.id) as {
        body_json: string;
      }
    ).body_json;
    const revision = makeReceipt({
      id: 'receipt-1-revision-1',
      sourceHash: 'c'.repeat(64),
      destinationHash: 'd'.repeat(64),
      warnings: ['Recovered linked object.'],
      createdAt: '2026-08-13T10:02:00.000Z',
    });
    store.appendProjectionReceiptRevision({
      receipt: revision,
      supersedesReceiptId: base.id,
    });
    store.appendProjectionReceiptRevision({
      receipt: revision,
      supersedesReceiptId: base.id,
    });

    expect(store.listProjectionReceiptHistory('run-1')).toEqual([
      { receipt: base, supersedesReceiptId: null },
      { receipt: revision, supersedesReceiptId: base.id },
      { receipt: other, supersedesReceiptId: null },
    ]);
    expect(store.listProjectionReceipts('run-1')).toEqual([revision, other]);
    expect(
      (
        db.prepare('SELECT body_json FROM projection_receipt WHERE id = ?').get(base.id) as {
          body_json: string;
        }
      ).body_json
    ).toBe(persistedBaseBody);
    expect(() =>
      store.appendProjectionReceiptRevision({
        receipt: makeReceipt({
          id: 'receipt-bad-destination',
          destinationPath: 'changed/path.gb',
          createdAt: '2026-08-13T10:03:00.000Z',
        }),
        supersedesReceiptId: revision.id,
      })
    ).toThrow(/destination ID, and destination path/iu);
    expect(() =>
      store.appendProjectionReceiptRevision({
        receipt: makeReceipt({
          id: 'receipt-fork',
          createdAt: '2026-08-13T10:03:00.000Z',
        }),
        supersedesReceiptId: base.id,
      })
    ).toThrow(/active receipt/iu);
    store.close();
    const reopened = new MigrationStore(db);
    expect(reopened.listProjectionReceipts('run-1')).toEqual([revision, other]);
    db.close();
  });

  it('enforces one immutable base projection receipt per source object', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    const receipt = makeReceipt();
    store.appendProjectionReceipt(receipt);
    store.appendProjectionReceipt(receipt);
    expect(store.listProjectionReceipts('run-1')).toEqual([receipt]);
    expect(() =>
      store.appendProjectionReceipt(
        makeReceipt({ id: 'receipt-2', destinationObjectId: 'different' })
      )
    ).toThrow(/different projection receipt/i);
    db.close();
  });

  it('allows only a Needs sequence receipt to advance to native DNA at the same identity', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    const unresolved = makeReceipt({
      id: 'receipt-unresolved',
      destinationObjectId: 'sequence-provider-identity',
      destinationPath: 'Benchling Imports/Empty DNA__identity/.forge/benchling-native-record.json',
      nativeRepresentation: 'dna_sequence_needs_sequence',
    });
    const complete = makeReceipt({
      id: 'receipt-complete',
      destinationObjectId: unresolved.destinationObjectId,
      destinationPath: 'Benchling Imports/Empty DNA__identity/Empty DNA__identity.gb',
      nativeRepresentation: 'dna_sequence',
      createdAt: '2026-08-13T10:02:00.000Z',
    });
    store.appendProjectionReceipt(unresolved);

    expect(() =>
      store.appendProjectionReceiptRevision({
        receipt: complete,
        supersedesReceiptId: unresolved.id,
      })
    ).not.toThrow();
    expect(store.listProjectionReceipts('run-1')).toEqual([complete]);
    expect(() =>
      store.appendProjectionReceiptRevision({
        receipt: {
          ...complete,
          id: 'receipt-invalid-path-change',
          destinationPath: 'Benchling Imports/elsewhere/changed.gb',
          createdAt: '2026-08-13T10:03:00.000Z',
        },
        supersedesReceiptId: complete.id,
      })
    ).toThrow(/destination ID, and destination path/iu);
    db.close();
  });

  it('persists validation and counts provider requests and cache hits', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    store.saveRun(makeRun());
    const report = makeReport();
    store.saveValidationReport(report);
    expect(store.getValidationReport('run-1')).toEqual(report);

    store.appendRequestLedgerEntry({
      id: 'request-1',
      runId: 'run-1',
      requestKind: 'targeted_read',
      requestKey: 'seq_2',
      outcome: 'success',
      startedAt: '2026-07-17T00:00:00Z',
      finishedAt: '2026-07-17T00:00:01Z',
      attempt: 1,
    });
    store.appendRequestLedgerEntry({
      id: 'request-2',
      runId: 'run-1',
      requestKind: 'targeted_read',
      requestKey: 'seq_2',
      outcome: 'cache_hit',
      startedAt: '2026-07-17T00:00:02Z',
      finishedAt: '2026-07-17T00:00:02Z',
      attempt: 1,
    });
    store.appendRequestLedgerEntry({
      id: 'request-3',
      runId: 'run-1',
      requestKind: 'folder_discovery',
      requestKey: 'folder:lib_ROOT:page:0',
      outcome: 'success',
      startedAt: '2026-07-17T00:00:03Z',
      finishedAt: '2026-07-17T00:00:04Z',
      attempt: 1,
    });
    expect(store.requestCounts('run-1')).toEqual({
      total: 3,
      cacheHits: 1,
      byKind: {
        export_submit: 0,
        export_submit_reconcile: 0,
        gmail_poll: 0,
        export_split_discovery: 0,
        export_inspect: 0,
        export_download: 0,
        folder_discovery: 1,
        targeted_read: 2,
      },
    });
    db.close();
  });

  it('rejects main-only paths on validation-report write and reopen boundaries', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    store.saveRun(makeRun());
    const sentinel = '/Users/private/must-not-cross-validation-report-store/export.html';
    expect(() =>
      store.saveValidationReport({
        ...makeReport(),
        sourcePath: sentinel,
      } as unknown as ValidationReport)
    ).toThrow('renderer privacy boundary');

    const report = makeReport();
    store.saveValidationReport(report);
    db.prepare('UPDATE validation_report SET body_json = ? WHERE run_id = ?').run(
      JSON.stringify({
        ...report,
        sourceObjects: {
          ...report.sourceObjects,
          evidence: { immutableLocalPath: sentinel },
        },
      }),
      report.runId
    );
    expect(() => store.getValidationReport(report.runId)).toThrow('renderer privacy boundary');
    db.close();
  });

  it('retains append-only provider activity evidence idempotently across restart', () => {
    const fileDb = createFileTestDb('benchling-provider-activity-evidence');
    let resumedDb: ReturnType<typeof openFileTestDb> | null = null;
    const evidence: ProviderActivityBundle = {
      id: 'provider-activity-1',
      runId: 'run-1',
      commandRequestId: 'command-1',
      operationKind: 'inspect_export',
      observedAt: '2026-07-17T00:00:01Z',
      schema: 'dnaforge.benchling.provider-activity-bundle.v1',
      complete: true,
      observations: [
        {
          ordinal: 0,
          kind: 'network_request',
          requestClass: 'export_archive_metadata',
          providerSurface: 'benchling_temp_storage',
          method: 'GET',
          result: 'response',
          statusClass: '2xx',
        },
      ],
    };
    try {
      let store = new MigrationStore(fileDb.db);
      store.saveRun(makeRun());
      store.appendProviderActivityEvidence(evidence);
      store.appendProviderActivityEvidence(evidence);
      fileDb.db.close();

      resumedDb = openFileTestDb(fileDb.dbPath);
      store = new MigrationStore(resumedDb);
      expect(store.listProviderActivityEvidence('run-1')).toEqual([evidence]);
      expect(() => store.appendProviderActivityEvidence({ ...evidence, complete: false })).toThrow(
        /immutable migration record/i
      );
      expect(() =>
        store.appendProviderActivityEvidence({ ...evidence, id: 'provider-activity-duplicate' })
      ).toThrow(/immutable migration record/i);

      resumedDb.exec('DROP INDEX idx_provider_activity_command_request');
      const duplicate = {
        ...evidence,
        id: 'provider-activity-duplicate',
        observedAt: '2026-07-17T00:00:02Z',
      };
      resumedDb
        .prepare(
          `INSERT INTO provider_activity_evidence (id, run_id, body_json)
           VALUES (?, ?, ?)`
        )
        .run(duplicate.id, duplicate.runId, JSON.stringify(duplicate));
      expect(() => store.listProviderActivityEvidence('run-1')).toThrow(
        /duplicate immutable activity evidence/i
      );
    } finally {
      if (fileDb.db.open) fileDb.db.close();
      if (resumedDb?.open) resumedDb.close();
      fileDb.cleanup();
    }
  });

  it('journals provider command intent idempotently before activity evidence exists', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    store.saveRun(makeRun());
    const command = {
      id: 'provider-command-1',
      runId: 'run-1',
      commandRequestId: 'command-1',
      operationKind: 'targeted_read' as const,
      issuedAt: '2026-07-17T00:00:00Z',
    };

    store.appendProviderCommandJournalEntry(command);
    store.appendProviderCommandJournalEntry(command);

    expect(store.listProviderCommandJournal('run-1')).toEqual([command]);
    expect(store.getProviderCommandJournalEntry('run-1', command.commandRequestId)).toEqual(
      command
    );
    expect(store.getProviderCommandJournalEntry('run-1', 'command-missing')).toBeNull();
    expect(() =>
      store.appendProviderCommandJournalEntry({ ...command, issuedAt: '2026-07-17T00:00:01Z' })
    ).toThrow(/immutable migration record/i);

    const planned = makeExportJob();
    store.upsertExportJob(planned);
    store.upsertExportJob({
      ...planned,
      state: 'submitted',
      submittedAt: '2026-07-17T00:00:02Z',
      attempts: 1,
    });
    const correlated = {
      id: 'provider-command-submit-1',
      runId: 'run-1',
      commandRequestId: 'command-submit-1',
      operationKind: 'submit_export' as const,
      exportJobId: planned.id,
      nativeExportLedgerEpoch: 'native-ledger-epoch:11111111111111111111111111111111',
      issuedAt: '2026-07-17T00:00:03Z',
    };
    store.appendProviderCommandJournalEntry(correlated);
    expect(store.listProviderCommandJournal('run-1')).toEqual([command, correlated]);
    expect(() =>
      store.appendProviderCommandJournalEntry({
        ...correlated,
        id: 'provider-command-wrong-operation',
        commandRequestId: 'command-wrong-operation',
        operationKind: 'targeted_read',
      })
    ).toThrow(/invalid export-job correlation/i);
    expect(() =>
      store.appendProviderCommandJournalEntry({
        ...correlated,
        id: 'provider-command-secret',
        commandRequestId: 'command-secret',
        signedUrl: 'https://example.invalid/private?token=secret',
      } as typeof correlated)
    ).toThrow(/malformed/i);

    store.upsertExportJob({
      ...planned,
      state: 'receipt_pending',
      submittedAt: '2026-07-17T00:00:02Z',
      attempts: 1,
    });
    const reconciliationCommand = {
      id: 'provider-command-reconcile-1',
      runId: 'run-1',
      commandRequestId: 'command-reconcile-1',
      operationKind: 'reconcile_export_submission' as const,
      exportJobId: planned.id,
      nativeExportLedgerEpoch: correlated.nativeExportLedgerEpoch,
      reconcilesCommandRequestId: correlated.commandRequestId,
      explicitResumeAttempt: 2,
      interventionSha256: `sha256:${'2'.repeat(64)}`,
      issuedAt: '2026-07-17T00:00:04Z',
    };
    store.appendProviderCommandJournalEntry(reconciliationCommand);
    const settlement = {
      schema: 'dnaforge.benchling.native-export-reconciliation.v1' as const,
      id: 'native-reconciliation-store-1',
      runId: 'run-1',
      exportJobId: planned.id,
      matchSignature: planned.matchSignature,
      originalCommandRequestId: correlated.commandRequestId,
      reconciliationCommandRequestId: reconciliationCommand.commandRequestId,
      nativeExportLedgerEpoch: correlated.nativeExportLedgerEpoch,
      explicitResumeAttempt: 2,
      interventionSha256: reconciliationCommand.interventionSha256,
      priorLedgerState: 'absent' as const,
      disposition: 'dispatched' as const,
      accepted: true,
      observedAt: '2026-07-17T00:00:05Z',
    };
    store.appendNativeExportReconciliation(settlement);
    store.appendNativeExportReconciliation(settlement);
    expect(store.listNativeExportReconciliations('run-1')).toEqual([settlement]);
    expect(() =>
      store.appendNativeExportReconciliation({
        ...settlement,
        id: 'native-reconciliation-store-mismatch',
        nativeExportLedgerEpoch: 'native-ledger-epoch:33333333333333333333333333333333',
      })
    ).toThrow(/does not match its durable commands/i);
    db.close();
  });

  it('round-trips one immutable Direct Folder Gmail-page-only rescan command across reopen', () => {
    const fileDb = createFileTestDb('benchling-direct-folder-gmail-page-rescan-command');
    let resumedDb: ReturnType<typeof openFileTestDb> | null = null;
    const command = makeDirectFolderGmailPageRescanCommand();
    try {
      let store = new MigrationStore(fileDb.db);
      store.saveRun(
        makeBoundRun({
          scope: {
            version: 1,
            kind: 'folder',
            folder: {
              id: 'lib_ROOT',
              url: 'https://example.benchling.com/example/f_/lib_ROOT-direct-folder',
              objectType: 'folder',
            },
            includeChildren: false,
          },
        })
      );

      store.appendProviderCommandJournalEntry(command);
      store.appendProviderCommandJournalEntry(command);
      expect(store.listProviderCommandJournal('run-1')).toEqual([command]);
      fileDb.db.close();

      resumedDb = openFileTestDb(fileDb.dbPath);
      store = new MigrationStore(resumedDb);
      expect(store.listProviderCommandJournal('run-1')).toEqual([command]);
      expect(() =>
        store.appendProviderCommandJournalEntry({
          ...command,
          issuedAt: '2026-07-17T00:00:04.000Z',
        })
      ).toThrow(/immutable migration record/i);
    } finally {
      if (fileDb.db.open) fileDb.db.close();
      if (resumedDb?.open) resumedDb.close();
      fileDb.cleanup();
    }
  });

  it('persists only the two permitted Direct Folder sequence recovery attempt pairs', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    store.saveRun(
      makeBoundRun({
        scope: {
          version: 1,
          kind: 'folder',
          folder: {
            id: 'lib_ROOT',
            url: 'https://example.benchling.com/example/f_/lib_ROOT-direct-folder',
            objectType: 'folder',
          },
          includeChildren: false,
        },
      })
    );
    const fresh = makeDirectFolderSequenceGmailRecoveryCommand(2, 1);
    const preserved = makeDirectFolderSequenceGmailRecoveryCommand(3, 2);
    store.appendProviderCommandJournalEntry(fresh);
    store.appendProviderCommandJournalEntry(preserved);
    expect(store.listProviderCommandJournal('run-1')).toEqual([fresh, preserved]);

    expect(() =>
      store.appendProviderCommandJournalEntry(makeDirectFolderSequenceGmailRecoveryCommand(4, 3))
    ).toThrow(/correlation is malformed/i);
    expect(store.listProviderCommandJournal('run-1')).toEqual([fresh, preserved]);
    db.close();
  });

  it('persists an exact SUCCEEDED notebook Gmail recovery and rejects an attempt-gap tamper', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    store.saveRun(
      makeBoundRun({
        scope: {
          version: 1,
          kind: 'folder',
          folder: {
            id: 'lib_ROOT',
            url: 'https://example.benchling.com/example/f_/lib_ROOT-direct-folder',
            objectType: 'folder',
          },
          includeChildren: false,
        },
      })
    );
    const command = makeDirectFolderSucceededGmailRecoveryCommand();
    store.appendProviderCommandJournalEntry(command);
    expect(store.listProviderCommandJournal('run-1')).toEqual([command]);
    const authorization = command.directFolderGmailRescan;
    if (
      authorization?.schema !==
      'dnaforge.benchling.provider-task-direct-folder-succeeded-gmail-recovery.v1'
    ) {
      throw new Error('Expected the succeeded-task Gmail recovery test command.');
    }
    expect(() =>
      store.appendProviderCommandJournalEntry({
        ...command,
        id: 'provider-command-direct-folder-succeeded-recovery-tampered',
        commandRequestId: 'command:direct-folder-succeeded-recovery-tampered',
        directFolderGmailRescan: {
          ...authorization,
          priorCapabilityRunAttempt: 2,
        },
      })
    ).toThrow(/correlation is malformed/i);
    expect(store.listProviderCommandJournal('run-1')).toEqual([command]);
    db.close();
  });

  it.each([
    {
      name: 'an ordinal below the first page-only rescan',
      mutate: (authorization: DirectFolderGmailPageRescanAuthorization) => ({
        ...authorization,
        rescanOrdinal: 1,
      }),
      error: /correlation is malformed/i,
    },
    {
      name: 'a non-integer rescan ordinal',
      mutate: (authorization: DirectFolderGmailPageRescanAuthorization) => ({
        ...authorization,
        rescanOrdinal: 2.5,
      }),
      error: /correlation is malformed/i,
    },
    {
      name: 'a gapped ordinal-two predecessor command',
      mutate: (authorization: DirectFolderGmailPageRescanAuthorization) => ({
        ...authorization,
        priorRescanCommandRequestId: 'command:direct-folder-unrelated-rescan',
      }),
      error: /correlation is malformed/i,
    },
    {
      name: 'a gapped ordinal-two predecessor activity',
      mutate: (authorization: DirectFolderGmailPageRescanAuthorization) => ({
        ...authorization,
        priorRescanActivitySha256: `sha256:${'6'.repeat(64)}`,
      }),
      error: /correlation is malformed/i,
    },
    {
      name: 'a provider-poll dispatch mode',
      mutate: (authorization: DirectFolderGmailPageRescanAuthorization) => ({
        ...authorization,
        dispatchMode: 'provider_poll',
      }),
      error: /correlation is malformed/i,
    },
    {
      name: 'a second Gmail page read',
      mutate: (authorization: DirectFolderGmailPageRescanAuthorization) => ({
        ...authorization,
        pageReadOrdinal: 2,
      }),
      error: /correlation is malformed/i,
    },
    {
      name: 'a widened Gmail page-read limit',
      mutate: (authorization: DirectFolderGmailPageRescanAuthorization) => ({
        ...authorization,
        pageReadLimit: 2,
      }),
      error: /correlation is malformed/i,
    },
    {
      name: 'an invalid root rescan command ID',
      mutate: (authorization: DirectFolderGmailPageRescanAuthorization) => ({
        ...authorization,
        rootRescanCommandRequestId: 'not an opaque id',
        priorRescanCommandRequestId: 'not an opaque id',
      }),
      error: /root rescan command request ID is invalid/i,
    },
    {
      name: 'an invalid prior rescan command ID',
      mutate: (authorization: DirectFolderGmailPageRescanAuthorization) => ({
        ...authorization,
        rescanOrdinal: 3,
        priorRescanCommandRequestId: 'not an opaque id',
      }),
      error: /prior rescan command request ID is invalid/i,
    },
    {
      name: 'an invalid root rescan activity hash',
      mutate: (authorization: DirectFolderGmailPageRescanAuthorization) => ({
        ...authorization,
        rootRescanActivitySha256: 'sha256:not-a-digest',
      }),
      error: /correlation is malformed/i,
    },
    {
      name: 'an invalid prior rescan activity hash',
      mutate: (authorization: DirectFolderGmailPageRescanAuthorization) => ({
        ...authorization,
        priorRescanActivitySha256: 'sha256:not-a-digest',
      }),
      error: /correlation is malformed/i,
    },
    {
      name: 'an invalid export job ID',
      mutate: (authorization: DirectFolderGmailPageRescanAuthorization) => ({
        ...authorization,
        jobId: 'not an opaque id',
      }),
      error: /job ID is invalid/i,
    },
    {
      name: 'an invalid Direct Folder authority digest',
      mutate: (authorization: DirectFolderGmailPageRescanAuthorization) => ({
        ...authorization,
        directFolderAuthorityDigest: 'sha256:not-a-digest',
      }),
      error: /correlation is malformed/i,
    },
  ])('rejects Direct Folder Gmail-page-only correlation with $name', ({ mutate, error }) => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    store.saveRun(
      makeBoundRun({
        scope: {
          version: 1,
          kind: 'folder',
          folder: {
            id: 'lib_ROOT',
            url: 'https://example.benchling.com/example/f_/lib_ROOT-direct-folder',
            objectType: 'folder',
          },
          includeChildren: false,
        },
      })
    );
    const command = makeDirectFolderGmailPageRescanCommand();
    const authorization = command.directFolderGmailRescan;
    if (
      authorization?.schema !== 'dnaforge.benchling.provider-task-direct-folder-gmail-rescan.v2'
    ) {
      throw new Error('Expected a Direct Folder Gmail-page-only test command.');
    }

    expect(() =>
      store.appendProviderCommandJournalEntry({
        ...command,
        directFolderGmailRescan: mutate(authorization) as DirectFolderGmailPageRescanAuthorization,
      })
    ).toThrow(error);
    expect(store.listProviderCommandJournal('run-1')).toEqual([]);
    db.close();
  });

  it('rejects a Direct Folder Gmail-page-only rescan command outside Folder scope', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    store.saveRun(makeBoundRun());
    expect(() =>
      store.appendProviderCommandJournalEntry(makeDirectFolderGmailPageRescanCommand())
    ).toThrow(/correlation is malformed/i);
    expect(store.listProviderCommandJournal('run-1')).toEqual([]);
    db.close();
  });

  it('persists a job-and-epoch-correlated download acceptance before decode', () => {
    const fileDb = createFileTestDb('benchling-native-export-download-acceptance');
    let resumedDb: ReturnType<typeof openFileTestDb> | null = null;
    try {
      let store = new MigrationStore(fileDb.db);
      store.saveRun(makeRun());
      const planned = makeExportJob();
      store.upsertExportJob(planned);
      const submitted = {
        ...planned,
        state: 'submitted' as const,
        submittedAt: '2026-07-17T00:00:01.000Z',
        attempts: 1,
      };
      store.upsertExportJob(submitted);
      store.upsertExportJob({ ...submitted, state: 'receipt_pending' });
      const matched = {
        ...submitted,
        state: 'receipt_matched' as const,
        receiptId: 'receipt-download-1',
        receiptSource: 'gmail' as const,
        downloadUrlHash: `sha256:${'d'.repeat(64)}`,
        receiptConfirmationId: 'confirmation-download-1',
      };
      store.upsertExportJob(matched);
      store.upsertExportJob({ ...matched, state: 'downloading' });

      const nativeExportLedgerEpoch = 'native-ledger-epoch:11111111111111111111111111111111';
      const command = {
        id: 'provider-command-download-1',
        runId: 'run-1',
        commandRequestId: 'command-download-1',
        operationKind: 'download_export' as const,
        exportJobId: planned.id,
        nativeExportLedgerEpoch,
        issuedAt: '2026-07-17T00:00:02.000Z',
      };
      store.appendProviderCommandJournalEntry(command);
      store.appendProviderActivityEvidence({
        id: 'provider-activity-download-1',
        runId: 'run-1',
        commandRequestId: command.commandRequestId,
        operationKind: 'download_export',
        observedAt: '2026-07-17T00:00:03.000Z',
        schema: 'dnaforge.benchling.provider-activity-bundle.v1',
        complete: true,
        observations: [
          {
            ordinal: 0,
            kind: 'network_request',
            requestClass: 'export_archive_download',
            providerSurface: 'benchling_temp_storage',
            method: 'GET',
            result: 'response',
            statusClass: '2xx',
          },
        ],
      });
      const acceptance = createNativeExportDownloadAcceptanceEvidence({
        runId: 'run-1',
        exportJobId: planned.id,
        matchSignature: planned.matchSignature,
        receiptId: matched.receiptId,
        downloadUrlHash: matched.downloadUrlHash,
        nativeExportLedgerEpoch,
        downloadCommandRequestId: command.commandRequestId,
        acceptedAt: '2026-07-17T00:00:03.000Z',
      });

      store.appendNativeExportDownloadAcceptance(acceptance);
      store.appendNativeExportDownloadAcceptance(acceptance);
      expect(store.listNativeExportDownloadAcceptances('run-1')).toEqual([acceptance]);
      expect(() =>
        store.appendNativeExportDownloadAcceptance({
          ...acceptance,
          acceptedAt: '2026-07-17T00:00:04.000Z',
        })
      ).toThrow(/digest is invalid/i);

      fileDb.db.close();
      resumedDb = openFileTestDb(fileDb.dbPath);
      store = new MigrationStore(resumedDb);
      expect(store.listNativeExportDownloadAcceptances('run-1')).toEqual([acceptance]);

      resumedDb
        .prepare(
          `UPDATE native_export_download_acceptance
           SET body_json = ?
           WHERE id = ?`
        )
        .run(
          JSON.stringify({
            ...acceptance,
            evidenceSha256: `sha256:${'f'.repeat(64)}`,
          }),
          acceptance.id
        );
      expect(() => store.listNativeExportDownloadAcceptances('run-1')).toThrow(
        /digest is invalid/i
      );
    } finally {
      if (fileDb.db.open) fileDb.db.close();
      if (resumedDb?.open) resumedDb.close();
      fileDb.cleanup();
    }
  });

  it('migrates legacy provider-task rows to stable handles while preserving row identity and order', () => {
    const fileDb = createFileTestDb('benchling-provider-task-privacy-v2');
    try {
      const fixture = seedLegacyDirectProviderTaskPrivacyDatabase(fileDb.db);
      const beforeEvidence = fileDb.db
        .prepare('SELECT rowid, id FROM provider_task_evidence ORDER BY rowid')
        .all();
      const beforeCommands = fileDb.db
        .prepare('SELECT rowid, id FROM provider_command_journal ORDER BY rowid')
        .all();

      const store = new MigrationStore(fileDb.db);

      expect(store.listProviderTaskEvidence(fixture.run.id)).toEqual([
        expect.objectContaining({
          id: fixture.evidenceIds[0],
          providerTaskHandleSha256: fixture.expectedHandle,
          status: 'RUNNING',
        }),
        expect.objectContaining({
          id: fixture.evidenceIds[1],
          providerTaskHandleSha256: fixture.expectedHandle,
          status: 'SUCCEEDED',
        }),
      ]);
      expect(
        fileDb.db.prepare('SELECT rowid, id FROM provider_task_evidence ORDER BY rowid').all()
      ).toEqual(beforeEvidence);
      expect(
        fileDb.db.prepare('SELECT rowid, id FROM provider_command_journal ORDER BY rowid').all()
      ).toEqual(beforeCommands);
      const commandBody = JSON.parse(
        (
          fileDb.db
            .prepare('SELECT body_json FROM provider_command_journal WHERE id = ?')
            .get(fixture.commandId) as { body_json: string }
        ).body_json
      ) as Record<string, unknown>;
      expect(commandBody).toMatchObject({
        directFolderGmailRescan: {
          providerTaskHandleSha256: fixture.expectedHandle,
        },
      });
      const serializedRows = [
        ...fileDb.db.prepare('SELECT body_json FROM provider_task_evidence').all(),
        ...fileDb.db.prepare('SELECT body_json FROM provider_command_journal').all(),
      ] as Array<{ body_json: string }>;
      expect(
        serializedRows.some(
          ({ body_json }) =>
            body_json.includes('"providerTaskId"') ||
            body_json.includes('"statusPath"') ||
            body_json.includes(LEGACY_PROVIDER_TASK_ID)
        )
      ).toBe(false);
      expect(
        fileDb.db.prepare("SELECT value FROM migration_meta WHERE key = 'schema_version'").get()
      ).toEqual({ value: '3' });
      expect(
        fileDb.db
          .prepare("SELECT value FROM migration_meta WHERE key = 'provider_task_privacy_v2'")
          .get()
      ).toEqual({ value: 'completed' });
      expect(store.getRun()).toMatchObject({
        state: 'action_required',
        resumeState: null,
        updatedAt: fixture.run.updatedAt,
        lastError: {
          code: 'scope_plan_incomplete',
          details: {
            reason: LEGACY_SCOPED_ITEM_URL_AUTHORITY_UNAVAILABLE_REASON,
            newRunRequired: true,
          },
        },
      });
      store.close();
    } finally {
      fileDb.cleanup();
    }
  });

  it('migrates legacy task receipts through export jobs and downstream immutable evidence', () => {
    const db = createTestDb();
    const fixture = seedLegacyDirectProviderTaskPrivacyDatabase(db);
    const legacyReceiptId = `task:${LEGACY_PROVIDER_TASK_ID}`;
    const downloadUrlHash = `sha256:${'9'.repeat(64)}`;
    const legacyJob: ExportJob = {
      ...fixture.job,
      state: 'receipt_matched',
      receiptId: legacyReceiptId,
      receiptSource: 'provider_task',
      downloadUrlHash,
    };
    db.prepare(
      `UPDATE export_job
       SET state = ?, body_json = ?
       WHERE id = ?`
    ).run(legacyJob.state, JSON.stringify(legacyJob), legacyJob.id);
    const inspection = {
      jobId: legacyJob.id,
      runId: legacyJob.runId,
      receiptId: legacyReceiptId,
      downloadUrlHash,
      inspectedAt: '2026-07-17T00:00:05.000Z',
      compressedArchiveBytes: 100,
      declaredCompressedEntryBytes: 80,
      declaredUncompressedBytes: 200,
      largestUncompressedEntryBytes: 120,
      entryCount: 2,
      centralDirectoryBytes: 20,
      zip64: false,
      rangeRequestCount: 1,
      rangeBytesRead: 100,
    };
    db.prepare(
      `INSERT INTO export_inspection (id, run_id, body_json)
       VALUES (?, ?, ?)`
    ).run(legacyJob.id, legacyJob.runId, JSON.stringify(inspection));
    const legacyAcceptance = createNativeExportDownloadAcceptanceEvidence({
      runId: legacyJob.runId,
      exportJobId: legacyJob.id,
      matchSignature: legacyJob.matchSignature,
      receiptId: legacyReceiptId,
      downloadUrlHash,
      nativeExportLedgerEpoch: 'native-ledger-epoch:11111111111111111111111111111111',
      downloadCommandRequestId: 'command-download-legacy-task',
      acceptedAt: '2026-07-17T00:00:06.000Z',
    });
    db.prepare(
      `INSERT INTO native_export_download_acceptance (id, run_id, body_json)
       VALUES (?, ?, ?)`
    ).run(legacyAcceptance.id, legacyJob.runId, JSON.stringify(legacyAcceptance));

    const store = new MigrationStore(db);
    const migratedReceiptId = providerTaskReceiptId(fixture.expectedHandle);
    const migratedJob = JSON.parse(
      (
        db.prepare('SELECT body_json FROM export_job WHERE id = ?').get(legacyJob.id) as {
          body_json: string;
        }
      ).body_json
    ) as ExportJob;
    expect(migratedJob).toMatchObject({
      receiptId: migratedReceiptId,
      receiptSource: 'provider_task',
    });
    expect(store.getExportInspection(legacyJob.id)).toMatchObject({
      receiptId: migratedReceiptId,
    });
    const [migratedAcceptance] = store.listNativeExportDownloadAcceptances(legacyJob.runId);
    expect(migratedAcceptance).toMatchObject({
      receiptId: migratedReceiptId,
    });
    expect(migratedAcceptance.id).not.toBe(legacyAcceptance.id);
    expect(migratedAcceptance.evidenceSha256).not.toBe(legacyAcceptance.evidenceSha256);
    expect(db.prepare('SELECT id FROM native_export_download_acceptance').get()).toEqual({
      id: migratedAcceptance.id,
    });
    const serialized = [
      ...db.prepare('SELECT body_json FROM export_job').all(),
      ...db.prepare('SELECT body_json FROM export_inspection').all(),
      ...db.prepare('SELECT body_json FROM native_export_download_acceptance').all(),
    ] as Array<{ body_json: string }>;
    expect(serialized.some(({ body_json }) => body_json.includes(legacyReceiptId))).toBe(false);
    store.close();
  });

  it('preserves clean v1 Gmail evidence byte-for-byte without inventing a provider task handle', () => {
    const db = createTestDb();
    new MigrationStore(db).close();
    const run = makeBoundRun({
      state: 'downloading',
      attempt: 1,
      startedAt: '2026-07-17T00:00:00.000Z',
    });
    const job = makeExportJob({
      state: 'receipt_matched',
      submittedAt: '2026-07-17T00:00:01.000Z',
      attempts: 1,
      receiptId: 'gmail-receipt-clean-v1',
      receiptSource: 'gmail',
      downloadUrlHash: `sha256:${'8'.repeat(64)}`,
      receiptConfirmationId: 'gmail-confirmation-clean-v1',
    });
    const confirmation = {
      schema: 'dnaforge.benchling.gmail-receipt-confirmation.v1' as const,
      id: 'gmail-confirmation-clean-v1',
      runId: run.id,
      inferenceId: 'gmail-inference-clean-v1',
      jobId: job.id,
      receiptId: job.receiptId,
      matchSignature: job.matchSignature,
      downloadUrlHash: job.downloadUrlHash,
      confirmedAt: '2026-07-17T00:00:02.000Z',
      basis: 'explicit_user_confirmation' as const,
    };
    db.prepare(
      `INSERT INTO migration_run (singleton, id, state, body_json, updated_at)
       VALUES (1, ?, ?, ?, ?)`
    ).run(run.id, run.state, JSON.stringify(run), run.updatedAt);
    db.prepare(
      `INSERT INTO export_job
         (id, run_id, match_signature, state, submitted_at, attempts, body_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      job.id,
      job.runId,
      job.matchSignature,
      job.state,
      job.submittedAt,
      job.attempts,
      JSON.stringify(job)
    );
    const confirmationBody = JSON.stringify(confirmation);
    db.prepare(
      `INSERT INTO gmail_receipt_confirmation (id, run_id, body_json)
       VALUES (?, ?, ?)`
    ).run(confirmation.id, confirmation.runId, confirmationBody);
    db.prepare("UPDATE migration_meta SET value = '1' WHERE key = 'schema_version'").run();
    db.prepare('DELETE FROM migration_meta WHERE key = ?').run('provider_task_privacy_v2');

    const store = new MigrationStore(db);
    expect(
      (
        db
          .prepare('SELECT body_json FROM gmail_receipt_confirmation WHERE id = ?')
          .get(confirmation.id) as { body_json: string }
      ).body_json
    ).toBe(confirmationBody);
    expect(store.getRun()).toEqual(run);
    expect(store.listGmailReceiptConfirmations(run.id)).toEqual([confirmation]);
    expect(
      (
        db
          .prepare('SELECT body_json FROM gmail_receipt_confirmation WHERE id = ?')
          .get(confirmation.id) as { body_json: string }
      ).body_json
    ).not.toContain('providerTaskHandleSha256');
    expect(
      db.prepare("SELECT value FROM migration_meta WHERE key = 'schema_version'").get()
    ).toEqual({ value: '3' });
    store.close();
  });

  it('replaces private task prose in migration_run with a fixed nonresumable issue', () => {
    const db = createTestDb();
    const fixture = seedLegacyDirectProviderTaskPrivacyDatabase(db);
    const legacyRun: MigrationRun = {
      ...fixture.run,
      state: 'action_required',
      resumeState: 'downloading',
      lastError: {
        code: 'provider_retry_exhausted',
        message: `task:${LEGACY_PROVIDER_TASK_ID}`,
        blocking: true,
        details: {
          providerFailure: `{"providerTaskId":"${LEGACY_PROVIDER_TASK_ID}"}`,
          providerRoute: `/1/api/tasks/${LEGACY_PROVIDER_TASK_ID}`,
        },
      },
    };
    db.prepare(
      `UPDATE migration_run
       SET state = ?, body_json = ?
       WHERE id = ?`
    ).run(legacyRun.state, JSON.stringify(legacyRun), legacyRun.id);

    const store = new MigrationStore(db);
    const migrated = store.getRun();
    expect(migrated).toMatchObject({
      state: 'action_required',
      resumeState: null,
      updatedAt: legacyRun.updatedAt,
      lastError: {
        code: 'provider_retry_exhausted',
        message:
          'This preserved migration no longer has a private Chrome task locator that can be resumed safely. Start a new migration run.',
        details: {
          reason: LEGACY_PROVIDER_TASK_SESSION_LOCATOR_UNAVAILABLE_REASON,
          actionRequiredCode: 'provider_task_session_locator_unavailable',
          newRunRequired: true,
        },
      },
    });
    const body = (
      db.prepare('SELECT body_json FROM migration_run WHERE id = ?').get(legacyRun.id) as {
        body_json: string;
      }
    ).body_json;
    expect(
      body.includes(LEGACY_PROVIDER_TASK_ID) ||
        body.includes('"providerTaskId"') ||
        body.includes('"statusPath"') ||
        body.includes(`task:${LEGACY_PROVIDER_TASK_ID}`)
    ).toBe(false);
    store.close();
  });

  it('sanitizes the machine report before a failed DB commit and completes idempotently on reopen', () => {
    const fileDb = createFileTestDb('benchling-provider-task-privacy-crash');
    try {
      const fixture = seedLegacyDirectProviderTaskPrivacyDatabase(fileDb.db);
      const reportPath = join(fileDb.tmpDir, 'validation-report.json');
      writeFileSync(
        reportPath,
        JSON.stringify({
          runId: fixture.run.id,
          providerTasks: {
            evidence: [
              {
                runId: fixture.run.id,
                jobId: fixture.job.id,
                matchSignature: fixture.job.matchSignature,
                providerTaskId: LEGACY_PROVIDER_TASK_ID,
                statusPath: `/1/api/tasks/${LEGACY_PROVIDER_TASK_ID}`,
              },
            ],
          },
        })
      );
      fileDb.db.exec(`
        CREATE TRIGGER fail_provider_task_privacy_version
        BEFORE UPDATE OF value ON migration_meta
        WHEN OLD.key = 'schema_version' AND NEW.value = '2'
        BEGIN
          SELECT RAISE(ABORT, 'synthetic privacy migration commit failure');
        END;
      `);

      expect(() => new MigrationStore(fileDb.db)).toThrow(/synthetic privacy migration/iu);
      const sanitizedAfterFailure = readFileSync(reportPath, 'utf8');
      expect(
        sanitizedAfterFailure.includes('"providerTaskId"') ||
          sanitizedAfterFailure.includes('"statusPath"') ||
          sanitizedAfterFailure.includes(LEGACY_PROVIDER_TASK_ID)
      ).toBe(false);
      expect(sanitizedAfterFailure).toContain(fixture.expectedHandle);
      expect(
        fileDb.db.prepare("SELECT value FROM migration_meta WHERE key = 'schema_version'").get()
      ).toEqual({ value: '1' });
      expect(
        (
          fileDb.db.prepare('SELECT body_json FROM provider_task_evidence LIMIT 1').get() as {
            body_json: string;
          }
        ).body_json.includes('"providerTaskId"')
      ).toBe(true);

      fileDb.db.exec('DROP TRIGGER fail_provider_task_privacy_version');
      const reopened = new MigrationStore(fileDb.db);
      expect(reopened.listProviderTaskEvidence(fixture.run.id)).toHaveLength(2);
      expect(
        fileDb.db.prepare("SELECT value FROM migration_meta WHERE key = 'schema_version'").get()
      ).toEqual({ value: '3' });
      expect(readFileSync(reportPath, 'utf8')).toBe(sanitizedAfterFailure);
      reopened.close();
    } finally {
      fileDb.cleanup();
    }
  });

  it('sanitizes a stale legacy machine report even after the DB is already privacy-v2', () => {
    const fileDb = createFileTestDb('benchling-provider-task-privacy-report-reopen');
    try {
      const fixture = seedLegacyDirectProviderTaskPrivacyDatabase(fileDb.db);
      new MigrationStore(fileDb.db).close();
      const reportPath = join(fileDb.tmpDir, 'validation-report.json');
      writeFileSync(
        reportPath,
        JSON.stringify({
          runId: fixture.run.id,
          providerTasks: {
            evidence: [
              {
                runId: fixture.run.id,
                jobId: fixture.job.id,
                matchSignature: fixture.job.matchSignature,
                providerTaskId: LEGACY_PROVIDER_TASK_ID,
                statusPath: `/1/api/tasks/${LEGACY_PROVIDER_TASK_ID}`,
              },
            ],
          },
        })
      );

      new MigrationStore(fileDb.db).close();

      const sanitized = readFileSync(reportPath, 'utf8');
      expect(
        sanitized.includes('"providerTaskId"') ||
          sanitized.includes('"statusPath"') ||
          sanitized.includes(LEGACY_PROVIDER_TASK_ID)
      ).toBe(false);
      expect(sanitized).toContain(fixture.expectedHandle);
      expect(
        fileDb.db
          .prepare("SELECT value FROM migration_meta WHERE key = 'provider_task_privacy_v2'")
          .get()
      ).toEqual({ value: 'completed' });
    } finally {
      fileDb.cleanup();
    }
  });

  it('preserves the bytes of an already privacy-safe machine report on reopen', () => {
    const fileDb = createFileTestDb('benchling-provider-task-privacy-report-byte-stability');
    try {
      new MigrationStore(fileDb.db).close();
      const reportPath = join(fileDb.tmpDir, 'validation-report.json');
      const report = {
        runId: 'run-1',
        providerTasks: {
          evidence: [makeProviderTaskEvidence({ status: 'SUCCEEDED' })],
        },
      };
      const original = `${JSON.stringify(report, null, 2)}\n`;
      writeFileSync(reportPath, original);

      new MigrationStore(fileDb.db).close();

      expect(readFileSync(reportPath, 'utf8')).toBe(original);
    } finally {
      fileDb.cleanup();
    }
  });

  it('commits privacy v2 and makes the run nonresumable when a raw task has ambiguous job correlation', () => {
    const db = createTestDb();
    const fixture = seedLegacyDirectProviderTaskPrivacyDatabase(db);
    const secondJob = {
      ...fixture.job,
      id: 'export-job-legacy-direct-2',
      matchSignature: 'benchling-export:second-exact-signature',
    };
    db.prepare(
      `INSERT INTO export_job
         (id, run_id, match_signature, state, submitted_at, attempts, body_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      secondJob.id,
      secondJob.runId,
      secondJob.matchSignature,
      secondJob.state,
      secondJob.submittedAt,
      secondJob.attempts,
      JSON.stringify(secondJob)
    );
    db.prepare(
      `INSERT INTO provider_task_evidence (id, run_id, body_json)
       VALUES (?, ?, ?)`
    ).run(
      `provider-task:${'e'.repeat(64)}`,
      fixture.run.id,
      JSON.stringify({
        id: `provider-task:${'e'.repeat(64)}`,
        runId: fixture.run.id,
        jobId: secondJob.id,
        matchSignature: secondJob.matchSignature,
        providerTaskId: LEGACY_PROVIDER_TASK_ID,
        status: 'RUNNING',
        actionRequired: null,
        observedAt: '2026-07-17T00:00:04.000Z',
      })
    );
    db.prepare(
      `INSERT INTO provider_command_journal (id, run_id, body_json)
       VALUES (?, ?, ?)`
    ).run(
      'provider-command-ambiguous-legacy-task',
      fixture.run.id,
      JSON.stringify({
        id: 'provider-command-ambiguous-legacy-task',
        runId: fixture.run.id,
        commandRequestId: 'command-ambiguous-legacy-task',
        operationKind: 'poll_export_receipts',
        providerTaskId: LEGACY_PROVIDER_TASK_ID,
        issuedAt: '2026-07-17T00:00:05.000Z',
      })
    );

    const store = new MigrationStore(db);
    expect(
      db.prepare("SELECT value FROM migration_meta WHERE key = 'schema_version'").get()
    ).toEqual({ value: '3' });
    expect(
      db.prepare("SELECT value FROM migration_meta WHERE key = 'provider_task_privacy_v2'").get()
    ).toEqual({ value: 'completed' });
    expect(store.getRun()).toMatchObject({
      state: 'action_required',
      resumeState: null,
      lastError: {
        code: 'provider_retry_exhausted',
        details: {
          reason: LEGACY_PROVIDER_TASK_SESSION_LOCATOR_UNAVAILABLE_REASON,
          actionRequiredCode: 'provider_task_session_locator_unavailable',
          newRunRequired: true,
        },
      },
    });
    expect(store.listProviderTaskEvidence(fixture.run.id)).toHaveLength(3);
    expect(store.listProviderCommandJournal(fixture.run.id)).toHaveLength(2);
    const serialized = [
      ...(db.prepare('SELECT body_json FROM migration_run').all() as Array<{
        body_json: string;
      }>),
      ...(db.prepare('SELECT body_json FROM provider_task_evidence').all() as Array<{
        body_json: string;
      }>),
      ...(db.prepare('SELECT body_json FROM provider_command_journal').all() as Array<{
        body_json: string;
      }>),
    ]
      .map(({ body_json }) => body_json)
      .join('\n');
    expect(
      serialized.includes('"providerTaskId"') ||
        serialized.includes('"statusPath"') ||
        serialized.includes(LEGACY_PROVIDER_TASK_ID) ||
        serialized.includes(`task:${LEGACY_PROVIDER_TASK_ID}`)
    ).toBe(false);
    store.close();
    const reopened = new MigrationStore(db);
    expect(reopened.getRun()?.lastError?.details?.reason).toBe(
      LEGACY_PROVIDER_TASK_SESSION_LOCATOR_UNAVAILABLE_REASON
    );
    reopened.close();
  });

  it('keeps a version-choice checkpoint active and makes its policy immutable', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    store.saveRun(makeReadyLocalRecoveryRun());
    const initial = makeRecoveryAttempt();
    store.putLinkedItemRecoveryAttempt(initial);
    const parsing: LinkedItemRecoveryAttempt = {
      ...initial,
      state: 'parsing',
      updatedAt: '2026-08-13T10:01:01.000Z',
    };
    store.putLinkedItemRecoveryAttempt(parsing);
    const firstConflict = {
      sourceObjectId: 'seq_EXAMPLE1',
      stableId: 'seq_EXAMPLE1',
      name: 'Example sequence',
      expectedPriorScientificContentSha256: null,
    };
    const awaiting: LinkedItemRecoveryAttempt = {
      ...parsing,
      state: 'awaiting_conflict_resolution',
      pendingImportDecision: {
        kind: 'provider_version_conflict',
        conflicts: [
          {
            sourceObjectId: firstConflict.sourceObjectId,
            stableId: firstConflict.stableId,
            displayName: firstConflict.name,
          },
        ],
      },
      pendingImportDecisionResumeState: 'parsing',
      versionConflictResolution: { kind: 'awaiting_choice', firstConflict },
      updatedAt: '2026-08-13T10:01:02.000Z',
    };
    store.putLinkedItemRecoveryAttempt(awaiting);

    expect(store.getActiveLinkedItemRecoveryAttempt('run-1')).toEqual(awaiting);
    expect(() =>
      store.putLinkedItemRecoveryAttempt(
        makeRecoveryAttempt({
          id: 'second-active-attempt',
          createdAt: '2026-08-13T10:01:03.000Z',
          updatedAt: '2026-08-13T10:01:03.000Z',
        })
      )
    ).toThrow();

    const resolved: LinkedItemRecoveryAttempt = {
      ...awaiting,
      state: 'parsing',
      pendingImportDecision: null,
      pendingImportDecisionResumeState: null,
      versionConflictResolution: {
        kind: 'resolved',
        policy: 'use_incoming',
        conflicts: [firstConflict],
      },
      updatedAt: '2026-08-13T10:01:05.000Z',
    };
    store.putLinkedItemRecoveryAttempt(resolved);
    expect(() =>
      store.putLinkedItemRecoveryAttempt({
        ...resolved,
        versionConflictResolution: {
          kind: 'resolved',
          policy: 'keep_existing',
          conflicts: [firstConflict],
        },
        updatedAt: '2026-08-13T10:01:06.000Z',
      })
    ).toThrow('changed its version-conflict decision');
    store.close();

    const failedDb = createTestDb();
    const failedStore = new MigrationStore(failedDb);
    failedStore.saveRun(makeReadyLocalRecoveryRun());
    failedStore.putLinkedItemRecoveryAttempt(initial);
    failedStore.putLinkedItemRecoveryAttempt(parsing);
    failedStore.putLinkedItemRecoveryAttempt(awaiting);
    expect(() =>
      failedStore.putLinkedItemRecoveryAttempt({
        ...awaiting,
        state: 'failed',
        resumeState: 'awaiting_conflict_resolution',
        safeFailure: {
          code: 'decode_failed',
          message: 'DNAForge could not finish this linked-item export batch. You can retry it.',
          retryable: true,
        },
        updatedAt: '2026-08-13T10:01:04.000Z',
      })
    ).not.toThrow();
    failedStore.close();
  });

  it.each(['missing export job', 'mismatched authority hint'] as const)(
    'scrubs legacy provider-task evidence with %s and commits a nonresumable v2 database',
    (failureMode) => {
      const db = createTestDb();
      const fixture = seedLegacyDirectProviderTaskPrivacyDatabase(db);
      if (failureMode === 'missing export job') {
        db.prepare('DELETE FROM provider_task_evidence WHERE id = ?').run(fixture.evidenceIds[1]);
        const row = db
          .prepare('SELECT body_json FROM provider_task_evidence WHERE id = ?')
          .get(fixture.evidenceIds[0]) as { body_json: string };
        const evidence = JSON.parse(row.body_json) as Record<string, unknown>;
        evidence.jobId = 'export-job-missing-from-legacy-db';
        db.prepare('UPDATE provider_task_evidence SET body_json = ? WHERE id = ?').run(
          JSON.stringify(evidence),
          fixture.evidenceIds[0]
        );
      } else {
        const row = db
          .prepare('SELECT body_json FROM provider_command_journal WHERE id = ?')
          .get(fixture.commandId) as { body_json: string };
        const command = JSON.parse(row.body_json) as {
          directFolderGmailRescan: Record<string, unknown>;
        };
        command.directFolderGmailRescan.directFolderAuthorityDigest = `sha256:${'7'.repeat(64)}`;
        db.prepare('UPDATE provider_command_journal SET body_json = ? WHERE id = ?').run(
          JSON.stringify(command),
          fixture.commandId
        );
      }

      const store = new MigrationStore(db);
      expect(
        db.prepare("SELECT value FROM migration_meta WHERE key = 'schema_version'").get()
      ).toEqual({ value: '3' });
      expect(
        db.prepare("SELECT value FROM migration_meta WHERE key = 'provider_task_privacy_v2'").get()
      ).toEqual({ value: 'completed' });
      expect(store.getRun()).toMatchObject({
        state: 'action_required',
        resumeState: null,
        lastError: {
          details: {
            reason: LEGACY_PROVIDER_TASK_SESSION_LOCATOR_UNAVAILABLE_REASON,
            newRunRequired: true,
          },
        },
      });
      expect(store.listProviderTaskEvidence(fixture.run.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            providerTaskHandleSha256: null,
            status: 'ACTION_REQUIRED',
            actionRequired: expect.objectContaining({
              code: 'provider_task_identity_invalid',
            }),
          }),
        ])
      );
      const serialized = [
        ...db.prepare('SELECT body_json FROM migration_run').all(),
        ...db.prepare('SELECT body_json FROM provider_task_evidence').all(),
        ...db.prepare('SELECT body_json FROM provider_command_journal').all(),
      ] as Array<{ body_json: string }>;
      expect(
        serialized.some(
          ({ body_json }) =>
            body_json.includes('"providerTaskId"') ||
            body_json.includes('"statusPath"') ||
            body_json.includes(LEGACY_PROVIDER_TASK_ID) ||
            body_json.includes(`task:${LEGACY_PROVIDER_TASK_ID}`)
        )
      ).toBe(false);
      store.close();
      const reopened = new MigrationStore(db);
      expect(reopened.getRun()?.lastError?.details?.reason).toBe(
        LEGACY_PROVIDER_TASK_SESSION_LOCATOR_UNAVAILABLE_REASON
      );
      reopened.close();
    }
  );

  it('reads a persisted legacy v1 validation report unchanged', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    store.saveRun(makeRun());
    const legacy = makeReport();

    store.saveValidationReport(legacy);

    const restored = store.getValidationReport('run-1');
    expect(restored).toEqual(legacy);
    expect(isValidationReportV2(restored!)).toBe(false);
    db.close();
  });
});
