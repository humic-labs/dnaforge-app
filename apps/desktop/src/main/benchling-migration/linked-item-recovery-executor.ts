import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readCurrentImportMaterialization } from './current-import-materialization';
import { readNativeSourceFolderMemberships } from './native-source-memberships';
import { sourceObjectMaterializationView } from './source-object-materialization-view';
import { sourceObjectValidationView } from './source-object-validation-view';
import { assertReviewedTableArchiveSelection } from './reviewed-table-source';
import { lstat, readdir, readFile, rm } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  BENCHLING_MIGRATION_PROJECTION_VERSION,
  isValidationReportV2,
  type LinkedItemRecoveryProgress,
  type LinkedItemRecoveryWorkProgress,
  type MigrationRun,
  type ProjectionReceipt,
  type RelationshipResolution,
  type SourceObject,
  type ValidationReport,
  type ValidationLinkedItemRecoveryAttemptEvidence,
  type ValidationLinkedItemRecoveryEvidence,
} from '../../shared/benchling-migration';
import { isSafeWorkspaceRelativePath } from '../../shared/path-boundary';
import {
  NATIVE_WORKSPACE_MANIFEST_PATH,
  parseNativeWorkspaceManifest,
} from '../../shared/native-workspace-manifest';
import {
  importDecisionAnswersPending,
  importDecisionKey,
  isProtectedImportReplacementPath,
  summarizeImportDecisions,
  type ImportDecision,
  type PendingImportDecision,
} from '../../shared/benchling-import-decision';
import { isGitRepo, listFilesAtHead, resolveHeadCommit } from '../workspace-git';
import {
  nativeCatalogRecordStateSha256,
  readNativeCatalogRecordState,
} from '../native-catalog-record-state';
import { ContentArchive, type LogicalContentManifestEntry } from './content-archive';
import { isNeedsSequenceCompletion } from './benchling-source-version';
import { nativeCollectionDocumentPath, nativeFolderPathMap } from './collection-projection-writer';
import { persistMigrationDestinationLinkIndex } from './destination-index-writer';
import { migrationEvidenceId } from './evidence-id';
import {
  ExternalZipSourceError,
  externalZipDecoderSource,
  selectExternalZipSource,
  verifyExternalZipSource,
  type SelectedExternalZipSource,
} from './external-zip-source';
import {
  scientificSourceObjectSha256,
  type LinkedItemRecoveryDecodedObject,
} from './linked-item-recovery-decoder';
import {
  buildLinkedItemRecoveryEvidence,
  resolveLinkedItemRecoveryLocation,
} from './linked-item-recovery-plan';
import {
  persistOfflineResolutions,
  projectLocalCollections,
  projectionLinksBySourceObjectId,
  readLocalCollectionEvidence,
  collectionProjectionLayoutForRun,
  verifyLocalSnapshotArchiveIntegrity,
  type LocalBundleRenderValidationInput,
} from './local-bundle-executor';
import {
  createLocalBenchlingExportIntakeDescriptor,
  intakeLocalBenchlingExportBundle,
  LocalBenchlingExportIntakeError,
  type VerifiedLocalBenchlingZipExport,
} from './local-export-bundle';
import { buildProjectionPlan, hashProjectionFiles, type ProjectionPlan } from './projection';
import {
  projectionReceiptForPlan,
  verifyProjectionReceiptIntegrity,
  writeProjectionPlan,
} from './projection-writer';
import { persistMigrationWorkspaceReport } from './staging-workspace';
import {
  RecoveredSourceObjectContentConflictError,
  linkedItemRecoveryArtifactDisplayName,
  linkedItemRecoveryArtifactSha256,
  linkedItemRecoveryArtifactSizeBytes,
  type LinkedItemRecoveryArtifact,
  type LinkedItemRecoveryAttempt,
  type LinkedItemBestEffortFallbackSource,
  type LinkedItemRecoveryAttemptMode,
  type LinkedItemRecoveryVersionConflict,
  type LinkedItemRecoveryCapture,
  type LinkedItemRecoveryFileResult,
  type LinkedItemRecoverySafeFailure,
  type MigrationStore,
  type RecoveredSourceObjectVersionPolicy,
  type WorkspaceAppendHierarchyCapture,
} from './store';
import { selectBestEffortRenderFallbackPaths } from './best-effort-render-fallback';
import { inspectNativeExportArchive } from './native-export-archive';
import {
  decodeWorkspaceAppendExport,
  WorkspaceAppendDecodeError,
  type WorkspaceAppendDecodeResult,
} from './workspace-append-decoder';
import { generateValidationReport } from './validation';
import {
  advancePersistedBenchlingMigrationAllocation,
  reserveBenchlingMigrationAction,
  readBenchlingMigrationActionJournal,
  summarizeActionDestinationChanges,
} from './action-journal';
import {
  prepareStructuralParentReplacements,
  restoreStructuralParentReplacements,
} from './structural-displacement';
import { BenchlingMigrationActionRecoveryError } from './action-recovery';
import type { Sha256Digest } from '../../shared/benchling-import-decision';
import type Database from 'better-sqlite3';
import {
  buildDestinationInventory,
  type DestinationInventoryLocation,
} from './destination-inventory';
import {
  DestinationAllocationCancelledError,
  DestinationStructuralConflictError,
} from './destination-name-allocator';
import { scopedProjectionId, stripWorkspaceScope } from '../../shared/workspace-scoped-identity';

export type LinkedItemRecoveryExecutorDeps = Readonly<{
  store: MigrationStore;
  archive: ContentArchive;
  renderValidator: (
    input: LocalBundleRenderValidationInput
  ) => Promise<Array<{ sourceObjectId: string; passed: boolean; message?: string }>>;
  now?: () => string;
  progressNow?: () => string;
  onRunUpdated?: (run: MigrationRun, message?: string) => void;
  persistPassedReport?: typeof persistMigrationWorkspaceReport;
  finalizeUnlockedRecovery?: (
    run: MigrationRun,
    report: ValidationReport,
    sourceObjects: readonly SourceObject[],
    receipts: readonly ProjectionReceipt[],
    resolutions: readonly RelationshipResolution[],
    actionId: string
  ) => Promise<void>;
  planLocalExport?: typeof createLocalBenchlingExportIntakeDescriptor;
  intakeLocalExport?: typeof intakeLocalBenchlingExportBundle;
  selectExternalZip?: typeof selectExternalZipSource;
  reviewedTables?: readonly import('../../shared/benchling-registry-table-review').RegistryTableMappingDecision[];
  bestEffortFallback?: LinkedItemRecoveryAttempt['bestEffortFallback'];
  decodeAppendExport?: typeof decodeWorkspaceAppendExport;
  listFilesAtHead?: typeof listFilesAtHead;
  destinationDb?: Database.Database;
  assertMutationLeaseHeld?: () => void;
  resolveImportDecision?: (
    input: Readonly<{
      runId: string;
      attemptId: string;
      pending: PendingImportDecision;
    }>
  ) => Promise<ImportDecision>;
}>;

const LOCAL_EXPORT_PROJECTION_WRITE_CONCURRENCY = 16;
const RECOVERED_OBJECT_MANIFEST_WRITE_CONCURRENCY = 256;
const TRANSIENT_PROGRESS_MIN_INTERVAL_MS = 250;

export function createThrottledWorkProgressPublisher(
  publish: (work: LinkedItemRecoveryWorkProgress) => void,
  nowMs: () => number = () => performance.now()
): (work: LinkedItemRecoveryWorkProgress) => void {
  let lastPublishedAt = Number.NEGATIVE_INFINITY;
  let lastPublished: LinkedItemRecoveryWorkProgress | null = null;
  return (work) => {
    const sameExactProgress =
      lastPublished?.kind === work.kind &&
      lastPublished.total === work.total &&
      lastPublished.completed === work.completed;
    if (sameExactProgress) return;

    const phaseChanged = lastPublished?.kind !== work.kind || lastPublished?.total !== work.total;
    const isBoundary = work.completed <= 0 || work.completed >= work.total;
    const currentTime = nowMs();
    const elapsed = currentTime - lastPublishedAt;
    if (!phaseChanged && !isBoundary && elapsed < TRANSIENT_PROGRESS_MIN_INTERVAL_MS) return;

    publish(work);
    lastPublished = work;
    lastPublishedAt = currentTime;
  };
}

export class LinkedItemRecoveryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = true,
    readonly bestEffortFallbackSources?: readonly LinkedItemBestEffortFallbackSource[]
  ) {
    super(message);
    this.name = 'LinkedItemRecoveryError';
  }
}

export async function rollbackFailedAppendForBestEffort(
  run: MigrationRun,
  failed: LinkedItemRecoveryAttempt,
  deps: Pick<LinkedItemRecoveryExecutorDeps, 'store' | 'destinationDb' | 'assertMutationLeaseHeld'>
): Promise<void> {
  const journal = await readBenchlingMigrationActionJournal(run.workspacePath, failed.id);
  if (!journal) return;
  deps.assertMutationLeaseHeld?.();
  if (
    failed.state !== 'failed' ||
    journal.actionId !== failed.id ||
    journal.runId !== run.id ||
    journal.durability.kind !== 'managed_git' ||
    journal.durability.committedHead !== null ||
    journal.completedAt !== undefined ||
    (journal.retainedClaims?.length ?? 0) > 0 ||
    !deps.destinationDb ||
    !run.workspaceDbId ||
    !journal.allocations.every(
      (allocation) =>
        allocation.writeDisposition === 'create' &&
        allocation.rollback.kind === 'none' &&
        allocation.expectedPriorImportedHash === null &&
        ['reserved', 'staged', 'installed'].includes(allocation.installState)
    )
  ) {
    throw new LinkedItemRecoveryError(
      'linked_item_recovery_fallback_rollback_unsafe',
      'This failed import changed an existing destination and cannot be retried automatically.',
      false
    );
  }
  const receipts = new Map(
    deps.store.listProjectionReceipts(run.id).map((receipt) => [receipt.sourceObjectId, receipt])
  );
  const fileDestinations: Array<{ path: string; isPackage: boolean }> = [];
  for (const allocation of journal.allocations) {
    const databaseId = scopedProjectionId(run.projectionScopeId, allocation.destinationEntityId);
    const present = deps.destinationDb
      .prepare('SELECT 1 FROM catalog_entities WHERE id=? AND workspace_id=?')
      .get(databaseId, run.workspaceDbId);
    if (present) {
      throw new LinkedItemRecoveryError(
        'linked_item_recovery_fallback_already_committed',
        'An imported destination already exists; automatic rollback stopped.',
        false
      );
    }
    const receipt = receipts.get(allocation.sourceObjectId);
    if (receipt && !isDeepStrictEqual(receipt.destination, allocation.destination)) {
      throw new Error('The failed append receipt no longer matches its reserved destination.');
    }
    if (allocation.destination.kind === 'catalog-record') continue;
    const relativePath =
      allocation.destination.kind === 'package'
        ? allocation.destination.rootRelativePath
        : allocation.destination.relativePath;
    if (!isSafeWorkspaceRelativePath(relativePath)) throw new Error('Unsafe failed destination.');
    const destinationPath = join(run.workspacePath, relativePath);
    const existing = await lstat(destinationPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!receipt && existing) {
      throw new Error('A failed append destination exists without its projection receipt.');
    }
    if (!existing) continue;
    if (!receipt) throw new Error('A failed append receipt disappeared during rollback.');
    const integrity = await verifyProjectionReceiptIntegrity({
      workspacePath: run.workspacePath,
      receipts: [receipt],
    });
    if (integrity.failures.length > 0) {
      throw new Error('A staged import file changed before best-effort rollback.');
    }
    fileDestinations.push({
      path: destinationPath,
      isPackage: allocation.destination.kind === 'package',
    });
  }
  for (const destination of fileDestinations) {
    deps.assertMutationLeaseHeld?.();
    await rm(destination.path, { recursive: destination.isPackage });
  }
  deps.store.forgetFailedAppendProjectionReceipts(
    run.id,
    failed.id,
    journal.allocations.map((allocation) => allocation.sourceObjectId)
  );
}

export async function recoverLinkedItemsFromLocalExports(
  requestedRun: MigrationRun,
  sourcePaths: readonly string[],
  deps: LinkedItemRecoveryExecutorDeps
): Promise<MigrationRun> {
  return runLocalExportAttempt(requestedRun, sourcePaths, deps, 'linked_item_recovery');
}

export async function runLocalExportAttempt(
  requestedRun: MigrationRun,
  sourcePaths: readonly string[],
  deps: LinkedItemRecoveryExecutorDeps,
  mode: LinkedItemRecoveryAttemptMode
): Promise<MigrationRun> {
  const now = deps.now ?? (() => new Date().toISOString());
  const progressStartedAt = (deps.progressNow ?? (() => new Date().toISOString()))();
  await deps.archive.cleanupTemporaryManifests();
  let run = requireReadyLocalZipRun(requestedRun, deps.store);
  const priorReport = deps.store.getValidationReport(run.id);
  const priorEvidence =
    priorReport && isValidationReportV2(priorReport)
      ? (priorReport.linkedItemRecovery?.evidence ?? null)
      : null;
  const activeAttempt = deps.store.getActiveLinkedItemRecoveryAttempt(run.id);
  const latestAttempt = deps.store.listLinkedItemRecoveryAttempts(run.id).at(-1) ?? null;
  const priorPlan = priorEvidence ?? latestAttempt?.recoveryPlan ?? null;
  let attempt: LinkedItemRecoveryAttempt;
  if (sourcePaths.length === 0) {
    if (!activeAttempt) {
      throw new LinkedItemRecoveryError(
        'linked_item_recovery_restart_not_available',
        'There is no active linked-item recovery checkpoint to resume.',
        false
      );
    }
    attempt = activeAttempt;
    run = publishProgress(
      run,
      attempt,
      deps,
      attempt.mode === 'workspace_append'
        ? 'Resuming the Benchling export…'
        : 'Resuming linked-item recovery…',
      progressStartedAt
    );
  } else {
    if (activeAttempt) {
      throw new LinkedItemRecoveryError(
        'linked_item_recovery_already_active',
        'Linked-item recovery is already in progress for this migration.'
      );
    }
    const initialPlan =
      mode === 'workspace_append' ? null : await recoveryPlan(run, deps.store, priorPlan);
    if (mode === 'linked_item_recovery') {
      if (!initialPlan) {
        throw new LinkedItemRecoveryError(
          'linked_item_recovery_not_needed',
          'This migration has no recoverable linked items.'
        );
      }
      if (initialPlan.remainingUniqueObjectCount === 0 && latestAttempt?.state !== 'failed') {
        throw new LinkedItemRecoveryError(
          'linked_item_recovery_not_needed',
          'This migration has no recoverable linked items.'
        );
      }
    }
    const selectedAt = now();
    const planLocalExport = deps.planLocalExport ?? createLocalBenchlingExportIntakeDescriptor;
    const descriptors = await Promise.all(
      sourcePaths.map((sourcePath) => planLocalExport({ sourcePath, selectedAt }))
    );
    attempt = {
      schema: 'dnaforge.benchling.linked-item-recovery-attempt.v1',
      id: `${mode === 'workspace_append' ? 'workspace-append' : 'linked-recovery'}-${randomUUID()}`,
      runId: run.id,
      mode,
      ...(deps.bestEffortFallback ? { bestEffortFallback: deps.bestEffortFallback } : {}),
      state: 'copying',
      resumeState: null,
      recoveryPlan: initialPlan,
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
      createdAt: selectedAt,
      updatedAt: selectedAt,
      completedAt: null,
      safeFailure: null,
    };
    deps.store.putLinkedItemRecoveryAttemptWithImportDecisions(attempt, deps.reviewedTables ?? []);
    run = publishProgress(run, attempt, deps, 'Reading linked-item exports…', progressStartedAt);
  }

  const publishMeasuredProgress = createThrottledWorkProgressPublisher((work) =>
    publishTransientProgress(run, attempt, deps, work, progressStartedAt)
  );

  try {
    deps.store.pinAvailableProjectionReceiptSources(run.id);
    if (attempt.state === 'copying') {
      const intakeLocalExport = deps.intakeLocalExport ?? intakeLocalBenchlingExportBundle;
      const selectExternalZip = deps.selectExternalZip ?? selectExternalZipSource;
      const totalCopyBytes = sumPlannedCopyBytes(attempt.intakeDescriptors);
      for (
        let index = attempt.processedFileCount;
        index < attempt.intakeDescriptors.length;
        index += 1
      ) {
        const descriptor = attempt.intakeDescriptors[index];
        const completedBeforeThisFile = sumPlannedCopyBytes(
          attempt.intakeDescriptors.slice(0, index)
        );
        let nextArtifactIds = [...attempt.artifactIds];
        let fileResult: LinkedItemRecoveryFileResult;
        try {
          const externalSelection =
            run.workspaceOrigin === undefined
              ? undefined
              : await selectExternalZip({
                  sourcePath: descriptor.sourcePath,
                  selectedAt: descriptor.selectedAt,
                });
          const artifact = externalSelection
            ? undefined
            : await intakeLocalExport({
                workspacePath: run.workspacePath,
                sourcePath: descriptor.sourcePath,
                expectedDescriptor: descriptor,
                onProgress: ({ copiedBytes }) => {
                  const completed = completedBeforeThisFile + copiedBytes;
                  publishMeasuredProgress({
                    kind: 'copy_bytes',
                    completed,
                    total: totalCopyBytes,
                  });
                },
              });
          if (artifact?.format === 'html') {
            throw new LinkedItemRecoveryError(
              'linked_item_recovery_zip_required',
              'Linked-item recovery accepts Benchling ZIP exports only.'
            );
          }
          const sourceSha256 = externalSelection?.source.zipSha256 ?? artifact?.sha256;
          if (!sourceSha256) throw new Error('Linked-item ZIP source evidence is missing.');
          const existing = deps.store.getLinkedItemRecoveryArtifactBySha256(run.id, sourceSha256);
          let artifactId: string;
          let outcome: LinkedItemRecoveryFileResult['outcome'];
          if (existing) {
            if (existing.schema === 'dnaforge.benchling.linked-item-recovery-source.v2') {
              await verifyExternalZipSource(existing.externalZipSource);
            }
            artifactId = existing.id;
            outcome = 'duplicate';
            nextArtifactIds = appendUnique(nextArtifactIds, existing.id);
          } else {
            const record = linkedItemRecoveryArtifactRecord({
              run,
              attempt,
              fileIndex: index,
              sourceSha256,
              externalSelection,
              artifact,
              capturedAt: nextTimestamp(attempt.updatedAt, now()),
            });
            deps.store.appendLinkedItemRecoveryArtifact(record);
            artifactId = record.id;
            outcome = 'accepted';
            nextArtifactIds = appendUnique(nextArtifactIds, record.id);
          }
          fileResult = {
            fileIndex: index,
            outcome,
            artifactId,
            failure: null,
          };
        } catch (error) {
          console.error('[benchling-migration] linked-item ZIP rejected', error);
          fileResult = {
            fileIndex: index,
            outcome: 'rejected',
            artifactId: null,
            failure: rejectedFileFailure(error),
          };
        }
        attempt = advanceAttempt(attempt, {
          artifactIds: nextArtifactIds,
          fileResults: [...attempt.fileResults, fileResult],
          processedFileCount: index + 1,
          updatedAt: nextTimestamp(attempt.updatedAt, now()),
        });
        deps.store.putLinkedItemRecoveryAttempt(attempt);
        run = publishProgress(run, attempt, deps, undefined, progressStartedAt);
      }
      attempt = transitionAttempt(attempt, 'parsing', now);
      deps.store.putLinkedItemRecoveryAttempt(attempt);
      run = publishProgress(
        run,
        attempt,
        deps,
        'Reading linked-item exports locally…',
        progressStartedAt
      );
    }

    if (attempt.state === 'awaiting_conflict_resolution') {
      attempt = await resolveAwaitingImportDecision(attempt, deps, now);
      run = publishProgress(run, attempt, deps, 'Applying your import choice…', progressStartedAt);
    }

    if (attempt.state === 'parsing') {
      if (attempt.bestEffortFallback) {
        const selectedSha = new Set(
          deps.store
            .listLinkedItemRecoveryArtifacts(run.id, attempt.id)
            .map((artifact) => linkedItemRecoveryArtifactSha256(artifact))
        );
        if (
          attempt.bestEffortFallback.sources.some((source) => !selectedSha.has(source.zipSha256))
        ) {
          throw new LinkedItemRecoveryError(
            'linked_item_recovery_source_changed',
            'The original ZIP changed before file fallback.',
            false
          );
        }
      }
      assertReviewedTableArchiveSelection(
        deps.store
          .listImportDecisions(run.id, attempt.id)
          .filter((decision) => decision.kind === 'registry_table_mapping'),
        deps.store
          .listLinkedItemRecoveryArtifacts(run.id, attempt.id)
          .map((artifact) => verifiedZipArtifact(artifact).sha256)
      );
      if (run.baseline?.kind === 'adopted_workspace') {
        deps.store.initializeAdoptedSourceSnapshot(run.id);
      }
      const decodeAppendExport = deps.decodeAppendExport ?? decodeWorkspaceAppendExport;
      const retainedExistingStableIds = new Map<string, string>();
      const corroboratedExistingStableIds = new Set<string>();
      const corroboratedPriorStableIds = new Set<string>();
      const historicalSources = await deps.store.listSourceObjectsCooperatively(run.id);
      const priorSourceObjects = (
        await readCurrentImportMaterialization({
          db: deps.destinationDb,
          run,
          store: deps.store,
          sources: historicalSources,
        })
      ).sources;
      const priorSourcesByStableId = new Map(
        priorSourceObjects.map((sourceObject) => [sourceObject.stableId, sourceObject] as const)
      );
      const completedActionIds = new Set(
        deps.store
          .listLinkedItemRecoveryAttempts(run.id)
          .filter((previous) => previous.state === 'completed')
          .map((previous) => previous.id)
      );
      const installedReceiptSourceIds = new Set([
        ...(deps.store.getSourceSnapshot(run.id)?.initialSourceObjectIds ?? []),
        ...deps.store
          .listLinkedItemRecoveryCaptures(run.id)
          .filter((capture) => completedActionIds.has(capture.attemptId))
          .map((capture) => capture.sourceObjectId),
      ]);
      const priorFingerprints = new Map<string, `sha256:${string}`>(
        priorSourceObjects.map(
          (sourceObject) =>
            [sourceObject.stableId, scientificSourceObjectSha256(sourceObject)] as const
        )
      );
      for (const capture of deps.store.listLinkedItemRecoveryCaptures(run.id)) {
        if (
          !priorFingerprints.has(capture.sourceStableId) &&
          !historicalSources.some((source) => source.stableId === capture.sourceStableId)
        ) {
          priorFingerprints.set(capture.sourceStableId, capture.sourceScientificContentSha256);
        }
      }
      const batchFingerprints = new Map<string, `sha256:${string}`>();
      for (const artifactRecord of deps.store.listLinkedItemRecoveryArtifacts(run.id, attempt.id)) {
        const pendingRecoveredObjects: RecoveredObjectPersistenceInput[] = [];
        let decoded: WorkspaceAppendDecodeResult;
        try {
          decoded = await decodeAppendExport({
            artifact: verifiedZipArtifact(artifactRecord),
            reviewedTables: deps.store
              .listImportDecisions(run.id, attempt.id)
              .filter((decision) => decision.kind === 'registry_table_mapping')
              .filter(
                (decision) =>
                  decision.source.archiveSha256 ===
                  verifiedZipArtifact(artifactRecord).sha256.replace(/^sha256:/u, '')
              ),
            archive: deps.archive,
            ...(artifactRecord.schema === 'dnaforge.benchling.linked-item-recovery-source.v2'
              ? { externalZipEntries: artifactRecord.externalZipEntries }
              : {}),
            capturedAt: nextTimestamp(attempt.updatedAt, now()),
            runId: run.id,
            attemptId: attempt.id,
            artifactId: artifactRecord.id,
            destinationFolderId: appendDestinationFolderId(run),
            fallbackEntryPaths: attempt.bestEffortFallback?.sources.find(
              (source) => source.zipSha256 === linkedItemRecoveryArtifactSha256(artifactRecord)
            )?.entryPaths,
            onProgress: ({ completed, total }) =>
              publishMeasuredProgress({
                kind: 'read_and_classify_objects',
                completed,
                total,
              }),
          });
        } catch (error) {
          if (
            error instanceof WorkspaceAppendDecodeError &&
            error.code === 'workspace_append_conflicting_representations'
          ) {
            throw error;
          }
          console.error('[benchling-migration] linked-item ZIP could not be decoded', error);
          continue;
        }
        if (decoded.hierarchyCapture) {
          const existingHierarchy = deps.store.getWorkspaceAppendHierarchyCapture(
            run.id,
            artifactRecord.id
          );
          if (existingHierarchy) {
            if (
              workspaceAppendHierarchyAuthority(existingHierarchy) !==
              workspaceAppendHierarchyAuthority(decoded.hierarchyCapture)
            ) {
              throw new Error(
                `Workspace append artifact ${artifactRecord.id} decoded to different hierarchy evidence on replay.`
              );
            }
          } else {
            deps.store.appendWorkspaceAppendHierarchyCapture(decoded.hierarchyCapture);
          }
        }
        for (const recovered of decoded.matched) {
          const sourceStableId = recovered.sourceObject.stableId;
          if (retainedExistingStableIds.has(sourceStableId)) continue;
          const batchFingerprint = batchFingerprints.get(sourceStableId);
          if (batchFingerprint) {
            if (batchFingerprint !== recovered.sourceContentSha256) {
              throw new RecoveredSourceObjectContentConflictError(
                run.id,
                recovered.sourceObject.id,
                batchFingerprint,
                recovered.sourceContentSha256
              );
            }
            corroboratedExistingStableIds.add(sourceStableId);
            if (readNativeSourceFolderMemberships(recovered.sourceObject, run.id).length > 0)
              pendingRecoveredObjects.push({
                run,
                attempt,
                artifact: artifactRecord,
                recovered,
                archive: deps.archive,
                store: deps.store,
                capturedAt: nextTimestamp(attempt.updatedAt, now()),
                sourceVersionPolicy: { kind: 'exact' },
              });
            continue;
          }
          const replacesFailedCapture =
            run.baseline?.kind !== 'adopted_workspace' &&
            !installedReceiptSourceIds.has(recovered.sourceObject.id) &&
            attempt.bestEffortFallback?.sources.some(
              (source) =>
                source.zipSha256 === linkedItemRecoveryArtifactSha256(artifactRecord) &&
                recovered.sourceObject.sourcePath !== undefined &&
                source.entryPaths.includes(recovered.sourceObject.sourcePath)
            ) === true &&
            deps.store
              .listLinkedItemRecoveryCaptures(run.id, attempt.bestEffortFallback.priorAttemptId)
              .some(
                (capture) =>
                  capture.sourceStableId === sourceStableId &&
                  capture.artifactId === artifactRecord.id
              );
          const priorFingerprint = replacesFailedCapture
            ? undefined
            : priorFingerprints.get(sourceStableId);
          const storedSource = historicalSources.find(
            (source) => source.stableId === sourceStableId
          );
          const storedFingerprint = storedSource
            ? scientificSourceObjectSha256(storedSource)
            : undefined;
          if (priorFingerprint) {
            if (priorFingerprint === recovered.sourceContentSha256) {
              corroboratedExistingStableIds.add(sourceStableId);
              if (readNativeSourceFolderMemberships(recovered.sourceObject, run.id).length > 0) {
                corroboratedPriorStableIds.add(sourceStableId);
                pendingRecoveredObjects.push({
                  run,
                  attempt,
                  artifact: artifactRecord,
                  recovered,
                  archive: deps.archive,
                  store: deps.store,
                  capturedAt: nextTimestamp(attempt.updatedAt, now()),
                  sourceVersionPolicy:
                    storedFingerprint && storedFingerprint !== priorFingerprint
                      ? {
                          kind: 'replace_existing',
                          expectedExistingScientificContentSha256: storedFingerprint,
                        }
                      : { kind: 'exact' },
                });
              }
              batchFingerprints.set(sourceStableId, recovered.sourceContentSha256);
              continue;
            }
            const priorSource = priorSourcesByStableId.get(sourceStableId);
            if (priorSource && isNeedsSequenceCompletion(priorSource, recovered.sourceObject)) {
              pendingRecoveredObjects.push({
                run,
                attempt,
                artifact: artifactRecord,
                recovered,
                archive: deps.archive,
                store: deps.store,
                capturedAt: nextTimestamp(attempt.updatedAt, now()),
                sourceVersionPolicy: {
                  kind: 'complete_needs_sequence',
                  expectedExistingScientificContentSha256: priorFingerprint,
                },
              });
              batchFingerprints.set(sourceStableId, recovered.sourceContentSha256);
              continue;
            }
            const conflict: LinkedItemRecoveryVersionConflict = {
              sourceObjectId: recovered.sourceObject.id,
              stableId: sourceStableId,
              name: recovered.sourceObject.name,
              expectedPriorScientificContentSha256: sourceObjectDestinationPrecondition({
                source: recovered.sourceObject,
                run,
                deps,
                fallback: priorFingerprint,
              }),
            };
            if (attempt.versionConflictResolution.kind === 'none') {
              const pendingImportDecision: PendingImportDecision = {
                kind: 'provider_version_conflict',
                conflicts: [
                  {
                    sourceObjectId: conflict.sourceObjectId,
                    stableId: conflict.stableId,
                    displayName: conflict.name,
                  },
                ],
              };
              attempt = advanceAttempt(attempt, {
                state: 'awaiting_conflict_resolution',
                pendingImportDecision,
                pendingImportDecisionResumeState: 'parsing',
                versionConflictResolution: { kind: 'awaiting_choice', firstConflict: conflict },
                updatedAt: nextTimestamp(attempt.updatedAt, now()),
              });
              deps.store.putLinkedItemRecoveryAttempt(attempt);
              run = publishProgress(
                run,
                attempt,
                deps,
                'Choose which versions to use…',
                progressStartedAt
              );
              attempt = await resolveAwaitingImportDecision(attempt, deps, now);
              run = publishProgress(
                run,
                attempt,
                deps,
                'Applying your version choice…',
                progressStartedAt
              );
            }
            if (attempt.versionConflictResolution.kind !== 'resolved') {
              throw new Error('The import version-conflict policy was not resolved.');
            }
            const conflictPolicy = attempt.versionConflictResolution.policy;
            if (
              !attempt.versionConflictResolution.conflicts.some(
                (existingConflict) => existingConflict.stableId === conflict.stableId
              )
            ) {
              attempt = advanceAttempt(attempt, {
                versionConflictResolution: {
                  ...attempt.versionConflictResolution,
                  conflicts: [...attempt.versionConflictResolution.conflicts, conflict],
                },
                updatedAt: nextTimestamp(attempt.updatedAt, now()),
              });
              deps.store.putLinkedItemRecoveryAttempt(attempt);
            }
            if (conflictPolicy === 'keep_existing') {
              retainedExistingStableIds.set(sourceStableId, recovered.sourceObject.name);
              continue;
            }
            pendingRecoveredObjects.push({
              run,
              attempt,
              artifact: artifactRecord,
              recovered,
              archive: deps.archive,
              store: deps.store,
              capturedAt: nextTimestamp(attempt.updatedAt, now()),
              sourceVersionPolicy: {
                kind: 'replace_existing',
                expectedExistingScientificContentSha256: storedFingerprint ?? priorFingerprint,
              },
            });
            batchFingerprints.set(sourceStableId, recovered.sourceContentSha256);
            continue;
          }
          pendingRecoveredObjects.push({
            run,
            attempt,
            artifact: artifactRecord,
            recovered,
            archive: deps.archive,
            store: deps.store,
            capturedAt: nextTimestamp(attempt.updatedAt, now()),
            sourceVersionPolicy: storedFingerprint
              ? {
                  kind: 'replace_existing',
                  expectedExistingScientificContentSha256: storedFingerprint,
                }
              : { kind: 'exact' },
          });
          batchFingerprints.set(sourceStableId, recovered.sourceContentSha256);
        }
        if (pendingRecoveredObjects.length > 0) {
          publishMeasuredProgress({
            kind: 'write_objects',
            completed: 0,
            total: pendingRecoveredObjects.length,
          });
          await persistRecoveredObjects(pendingRecoveredObjects, ({ completed, total }) =>
            publishMeasuredProgress({ kind: 'write_objects', completed, total })
          );
        }
      }
      const incomingConflictCount =
        attempt.versionConflictResolution.kind === 'resolved' &&
        attempt.versionConflictResolution.policy === 'use_incoming'
          ? attempt.versionConflictResolution.conflicts.length
          : 0;
      const recoveredUniqueObjectCount = Math.max(
        0,
        recoveredTargetCount(run.id, deps.store, attempt.id) -
          incomingConflictCount -
          corroboratedPriorStableIds.size
      );
      for (const stableId of retainedExistingStableIds.keys()) {
        corroboratedExistingStableIds.delete(stableId);
      }
      attempt = transitionAttempt(attempt, 'reconciling', now, {
        recoveredUniqueObjectCount,
        retainedExistingObjectCount: Math.max(
          attempt.retainedExistingObjectCount,
          retainedExistingStableIds.size
        ),
        retainedExistingObjects:
          retainedExistingStableIds.size >= attempt.retainedExistingObjects.length
            ? [...retainedExistingStableIds].map(([stableId, name]) => ({ stableId, name }))
            : attempt.retainedExistingObjects,
        corroboratedExistingObjectCount: Math.max(
          attempt.corroboratedExistingObjectCount,
          corroboratedExistingStableIds.size
        ),
      });
      if (retainedExistingStableIds.size > 0) {
        console.warn(
          `[benchling-migration] kept the existing copy of ${retainedExistingStableIds.size} object(s) already in this workspace with different bytes`
        );
      }
      deps.store.putLinkedItemRecoveryAttempt(attempt);
      run = publishProgress(
        run,
        attempt,
        deps,
        'Repairing local notebook links…',
        progressStartedAt
      );
    }

    if (attempt.state === 'reconciling') {
      // global origin inference would otherwise become ambiguous and leave
      const currentMaterialization = await readCurrentImportMaterialization({
        db: deps.destinationDb,
        run,
        store: deps.store,
        actionId: attempt.id,
        sources: await deps.store.listSourceObjectsCooperatively(run.id),
      });
      const sourceObjects = sortedSourceObjects(currentMaterialization.sources);
      const relationshipTotal = sourceObjects.reduce(
        (total, sourceObject) => total + sourceObject.relationships.length,
        0
      );
      publishMeasuredProgress({ kind: 'resolve_links', completed: 0, total: relationshipTotal });
      persistOfflineResolutions(
        run,
        deps.store,
        attempt.recoveryPlan?.organizationBaseUrl,
        sourceObjects
      );
      publishMeasuredProgress({
        kind: 'resolve_links',
        completed: relationshipTotal,
        total: relationshipTotal,
      });
      const resolutions = deps.store.listRelationshipResolutions(run.id);
      const relationshipIds = new Set(
        (attempt.recoveryPlan?.targets ?? []).flatMap((target) => target.relationshipIds)
      );
      const changedSourceIds = new Set(
        resolutions
          .filter(
            (resolution) =>
              relationshipIds.has(resolution.relationshipId) &&
              resolution.classification === 'exact'
          )
          .map((resolution) => resolution.sourceObjectId)
      );
      const incomingReplacementSourceIds = new Set(
        attempt.versionConflictResolution.kind === 'resolved' &&
          attempt.versionConflictResolution.policy === 'use_incoming'
          ? attempt.versionConflictResolution.conflicts.map((conflict) => conflict.sourceObjectId)
          : []
      );
      const snapshot = requireSnapshot(run.id, deps.store);
      let receipts = currentMaterialization.receipts;
      const fallbackSourceIds = new Set(
        deps.store
          .listLinkedItemRecoveryCaptures(run.id, attempt.id)
          .filter((capture) => {
            const artifact = deps.store.getLinkedItemRecoveryArtifact(run.id, capture.artifactId);
            const source = sourceObjects.find(
              (candidate) => candidate.id === capture.sourceObjectId
            );
            const sourcePath = source?.sourcePath;
            return (
              artifact !== null &&
              artifact !== undefined &&
              sourcePath !== undefined &&
              attempt.bestEffortFallback?.sources.some(
                (fallback) =>
                  fallback.zipSha256 === linkedItemRecoveryArtifactSha256(artifact) &&
                  fallback.entryPaths.includes(sourcePath)
              ) === true &&
              !currentMaterialization.materializedSourceIds.has(capture.sourceObjectId) &&
              run.baseline?.kind !== 'adopted_workspace'
            );
          })
          .map((capture) => capture.sourceObjectId)
      );
      const readCurrentReceipts = async () =>
        (
          await readCurrentImportMaterialization({
            db: deps.destinationDb,
            run,
            store: deps.store,
            actionId: attempt.id,
            sources: [],
          })
        ).receipts;
      const linksBySourceObjectId = projectionLinksBySourceObjectId(
        sourceObjects,
        resolutions,
        receipts
      );
      const existingBySourceId = new Map(
        receipts.map((receipt) => [receipt.sourceObjectId, receipt])
      );
      const historicalHeadBySourceId = new Map(
        currentMaterialization.historicalHeads.map((receipt) => [receipt.sourceObjectId, receipt])
      );
      const fixedDestinations = new Map<
        string,
        {
          destinationEntityId: string;
          destination: import('../../shared/benchling-migration').ProjectionDestination;
          expectedPriorImportedHash: Sha256Digest;
        }
      >();
      const reusedDestinationSourceIds = new Set<string>();
      for (const receipt of receipts) {
        if (receipt.retainedDestination?.actionId !== attempt.id || !receipt.destination) continue;
        reusedDestinationSourceIds.add(receipt.sourceObjectId);
        fixedDestinations.set(receipt.sourceObjectId, {
          destinationEntityId: receipt.destinationObjectId,
          destination: receipt.destination,
          expectedPriorImportedHash: receipt.retainedDestination.expectedScientificSha256,
        });
      }
      for (const decision of deps.store.listImportDecisions(run.id, attempt.id)) {
        if (decision.kind !== 'unbound_exact_match' || decision.policy !== 'link_existing')
          continue;
        const receipt = existingBySourceId.get(decision.sourceObjectId);
        if (!receipt?.destination) continue;
        if (
          receipt.destinationObjectId !==
          portableDestinationEntityId(run, decision.candidateEntityId)
        ) {
          throw new Error('The resumed exact-native receipt changed its reviewed identity.');
        }
        reusedDestinationSourceIds.add(decision.sourceObjectId);
        fixedDestinations.set(decision.sourceObjectId, {
          destinationEntityId: receipt.destinationObjectId,
          destination: receipt.destination,
          expectedPriorImportedHash: decision.expectedCandidateScientificSha256,
        });
      }
      if (deps.destinationDb && run.workspaceDbId) {
        const assertMutationLeaseHeld = deps.assertMutationLeaseHeld ?? (() => undefined);
        const inventorySources = sourceObjects.filter(
          (sourceObject) => !existingBySourceId.has(sourceObject.id)
        );
        const inventory = await buildDestinationInventory({
          db: deps.destinationDb,
          workspaceDbId: run.workspaceDbId,
          workspacePath: run.workspacePath,
          sourceObjects: inventorySources,
          assertMutationLeaseHeld,
        });
        const exactBySourceId = new Map(
          inventory.nativeExactMatches.map((match) => [match.sourceObjectId, match.result] as const)
        );
        for (const providerMatch of inventory.providerMatches) {
          const sourceObject = inventorySources.find(
            (candidate) => candidate.id === providerMatch.sourceObjectId
          );
          if (!sourceObject) throw new Error('Destination inventory source object disappeared.');
          if (providerMatch.state === 'ambiguous') {
            throw new LinkedItemRecoveryError(
              'workspace_destination_provider_ambiguous',
              `More than one workspace item is bound to ${sourceObject.name}. Resolve the duplicate identity before importing.`,
              false
            );
          }
          if (providerMatch.state === 'stale') {
            throw new LinkedItemRecoveryError(
              'workspace_destination_provider_stale',
              `The saved workspace identity for ${sourceObject.name} no longer points to an active item.`,
              false
            );
          }
          if (providerMatch.state === 'matched') {
            let reuseExisting = providerMatch.scientificComparison === 'equal';
            if (!reuseExisting) {
              const conflict: LinkedItemRecoveryVersionConflict = {
                sourceObjectId: sourceObject.id,
                stableId: sourceObject.stableId,
                name: sourceObject.name,
                expectedPriorScientificContentSha256: providerMatch.destination.scientificSha256,
              };
              attempt = await resolveProviderDestinationConflict({
                attempt,
                conflict,
                deps,
                now,
                onPending: (waiting) => {
                  run = publishProgress(
                    run,
                    waiting,
                    deps,
                    'Choose which versions to use…',
                    progressStartedAt
                  );
                },
              });
              reuseExisting =
                attempt.versionConflictResolution.kind === 'resolved' &&
                attempt.versionConflictResolution.policy === 'keep_existing';
            }
            if (reuseExisting) {
              const receipt = await receiptForReusedDestination({
                run,
                actionId: attempt.id,
                sourceObject,
                location: providerMatch.destination,
                snapshotCreatedAt: snapshot.createdAt,
                createdAt: nextTimestamp(attempt.updatedAt, now()),
              });
              deps.store.appendProjectionReceipt(receipt);
              existingBySourceId.set(sourceObject.id, receipt);
              reusedDestinationSourceIds.add(sourceObject.id);
              fixedDestinations.set(
                sourceObject.id,
                fixedDestinationForExisting(run, providerMatch.destination)
              );
              continue;
            }
            if (!providerMatch.destination.scientificSha256) {
              throw new LinkedItemRecoveryError(
                'workspace_destination_science_unavailable',
                `DNAForge cannot safely replace ${sourceObject.name} because its current scientific fingerprint is unavailable.`,
                false
              );
            }
            fixedDestinations.set(
              sourceObject.id,
              fixedDestinationForExisting(run, providerMatch.destination)
            );
            continue;
          }
          const exact = exactBySourceId.get(sourceObject.id);
          if (!exact || exact.kind === 'none') continue;
          if (exact.kind === 'ambiguous') {
            throw new LinkedItemRecoveryError(
              'workspace_destination_exact_match_ambiguous',
              `More than one unlinked workspace item has the exact science for ${sourceObject.name}. Link one identity before importing.`,
              false
            );
          }
          const candidate = exact.candidate;
          const pending: PendingImportDecision = {
            kind: 'unbound_exact_match',
            sourceObjectId: sourceObject.id,
            sourceDisplayName: sourceObject.name,
            candidateEntityId: candidate.entityId,
            candidateDisplayName: candidate.displayName,
            expectedCandidateScientificSha256: candidate.scientificSha256,
          };
          attempt = await persistAndResolveImportPrompt({
            attempt,
            pending,
            resumeState: 'reconciling',
            deps,
            now,
            onPending: (waiting) => {
              run = publishProgress(
                run,
                waiting,
                deps,
                'Choose whether to link the exact workspace match…',
                progressStartedAt
              );
            },
          });
          const decision = deps.store
            .listImportDecisions(run.id, attempt.id)
            .find((candidateDecision) => importDecisionAnswersPending(candidateDecision, pending));
          if (!decision || decision.kind !== 'unbound_exact_match') {
            throw new Error('Exact-native destination decision was not persisted.');
          }
          if (decision.policy === 'import_separate') continue;
          assertMutationLeaseHeld();
          const candidateLocation: DestinationInventoryLocation = {
            ...candidate.location,
            entityId: candidate.entityId,
            displayName: candidate.displayName,
            scientificSha256: candidate.scientificSha256,
          };
          const receipt = await receiptForReusedDestination({
            run,
            actionId: attempt.id,
            sourceObject,
            location: candidateLocation,
            snapshotCreatedAt: snapshot.createdAt,
            createdAt: nextTimestamp(attempt.updatedAt, now()),
          });
          deps.store.appendProjectionReceipt(receipt, sourceObject);
          existingBySourceId.set(sourceObject.id, receipt);
          reusedDestinationSourceIds.add(sourceObject.id);
          fixedDestinations.set(
            sourceObject.id,
            fixedDestinationForExisting(run, candidateLocation)
          );
        }
        receipts = await readCurrentReceipts();
      }
      const pendingProjectionWrites: Array<{
        sourceObject: SourceObject;
        existing: ProjectionReceipt | undefined;
        createdAt: string;
        completesNeedsSequence: boolean;
      }> = [];
      for (const sourceObject of sourceObjects) {
        const existing = existingBySourceId.get(sourceObject.id);
        if (reusedDestinationSourceIds.has(sourceObject.id)) continue;
        const completesNeedsSequence =
          existing?.nativeRepresentation === 'dna_sequence_needs_sequence' &&
          isCompleteDnaSource(sourceObject);
        if (
          existing &&
          !completesNeedsSequence &&
          !incomingReplacementSourceIds.has(sourceObject.id) &&
          !fallbackSourceIds.has(sourceObject.id) &&
          (run.state === 'unlocked' || !changedSourceIds.has(sourceObject.id))
        ) {
          continue;
        }
        const createdAt = nextTimestamp(
          historicalHeadBySourceId.get(sourceObject.id)?.createdAt ??
            existing?.createdAt ??
            attempt.updatedAt,
          now()
        );
        pendingProjectionWrites.push({
          sourceObject,
          existing,
          createdAt,
          completesNeedsSequence,
        });
      }
      const newLayoutSource = deps.store
        .listLinkedItemRecoveryArtifacts(run.id, attempt.id)
        .find(
          (
            artifact
          ): artifact is Extract<
            LinkedItemRecoveryArtifact,
            { schema: 'dnaforge.benchling.linked-item-recovery-source.v2' }
          > => artifact.schema === 'dnaforge.benchling.linked-item-recovery-source.v2'
        )?.externalZipSource;
      for (const { sourceObject, existing } of pendingProjectionWrites) {
        if (!existing) continue;
        if (fixedDestinations.has(sourceObject.id)) continue;
        const replacementConflict =
          attempt.versionConflictResolution.kind === 'resolved'
            ? attempt.versionConflictResolution.conflicts.find(
                (conflict) => conflict.sourceObjectId === sourceObject.id
              )
            : undefined;
        fixedDestinations.set(sourceObject.id, {
          destinationEntityId: existing.destinationObjectId,
          destination:
            existing.destination ??
            ({
              kind: 'package',
              rootRelativePath: projectionPackageDirectory(existing.destinationPath),
              primaryRelativePath: existing.destinationPath,
            } as const),
          expectedPriorImportedHash:
            !existing.destination || existing.destination.kind === 'package'
              ? projectionHashDigest(existing.destinationHash)
              : (replacementConflict?.expectedPriorScientificContentSha256 ??
                projectionHashDigest(existing.destinationHash)),
        });
      }
      let actionAllocations: Awaited<
        ReturnType<typeof reserveBenchlingMigrationAction>
      >['allocations'] = [];
      if (newLayoutSource) {
        const existingJournal = await readBenchlingMigrationActionJournal(
          run.workspacePath,
          attempt.id
        );
        const allocationSourceIds = new Set([
          ...pendingProjectionWrites.map(({ sourceObject }) => sourceObject.id),
          ...reusedDestinationSourceIds,
          ...(existingJournal?.allocations.map((allocation) => allocation.sourceObjectId) ?? []),
        ]);
        for (;;) {
          try {
            actionAllocations = (
              await reserveBenchlingMigrationAction({
                run: { ...run, externalZipSource: newLayoutSource },
                actionId: attempt.id,
                sourceObjects: sourceObjects.filter((source) => allocationSourceIds.has(source.id)),
                decisions: deps.store.listImportDecisions(run.id, attempt.id),
                reuseExistingSourceObjectIds: reusedDestinationSourceIds,
                destinationDb: deps.destinationDb,
                fixedDestinationsBySourceObjectId: fixedDestinations,
                now: attempt.createdAt,
              })
            ).allocations;
            break;
          } catch (error) {
            if (error instanceof DestinationAllocationCancelledError) {
              throw new LinkedItemRecoveryError(
                'workspace_append_cancelled',
                'This Benchling import was cancelled before it changed the workspace.',
                false
              );
            }
            if (!(error instanceof DestinationStructuralConflictError)) throw error;
            const pending: PendingImportDecision = {
              kind: 'structural_path_conflict',
              relativePath: error.relativePath,
              incomingKind: error.incomingKind,
              expectedExistingState: error.expectedExistingState,
              replaceAllowed: !isProtectedImportReplacementPath(error.relativePath),
            };
            attempt = await persistAndResolveImportPrompt({
              attempt,
              pending,
              resumeState: 'reconciling',
              deps,
              now,
              onPending: (waiting) => {
                run = publishProgress(
                  run,
                  waiting,
                  deps,
                  'Choose how to handle an existing workspace path…',
                  progressStartedAt
                );
              },
            });
            run = publishProgress(
              run,
              attempt,
              deps,
              'Applying your destination choice…',
              progressStartedAt
            );
          }
        }
      }
      const allocationBySourceObjectId = new Map(
        actionAllocations.map((allocation) => [allocation.sourceObjectId, allocation])
      );
      deps.assertMutationLeaseHeld?.();
      await prepareStructuralParentReplacements(run.workspacePath, actionAllocations);
      const externalAssetSources = [
        ...(run.externalZipSource
          ? [{ source: run.externalZipSource, entries: run.externalZipEntries ?? [] }]
          : []),
        ...deps.store
          .listLinkedItemRecoveryArtifacts(run.id)
          .flatMap((artifact) =>
            artifact.schema === 'dnaforge.benchling.linked-item-recovery-source.v2'
              ? [{ source: artifact.externalZipSource, entries: artifact.externalZipEntries }]
              : []
          ),
      ];
      publishMeasuredProgress({
        kind: 'write_objects',
        completed: 0,
        total: pendingProjectionWrites.length,
      });
      for (
        let offset = 0;
        offset < pendingProjectionWrites.length;
        offset += LOCAL_EXPORT_PROJECTION_WRITE_CONCURRENCY
      ) {
        const chunk = pendingProjectionWrites.slice(
          offset,
          offset + LOCAL_EXPORT_PROJECTION_WRITE_CONCURRENCY
        );
        const writeResults = await Promise.allSettled(
          chunk.map(async ({ sourceObject, existing, createdAt, completesNeedsSequence }) => ({
            sourceObject,
            existing,
            allocation: allocationBySourceObjectId.get(sourceObject.id),
            receipt: await writeProjectionPlan({
              workspacePath: run.workspacePath,
              runId: run.id,
              actionId: attempt.id,
              sourceObjectId: sourceObject.id,
              allocation: allocationBySourceObjectId.get(sourceObject.id),
              ...(externalAssetSources.length ? { externalAssetSources } : {}),
              plan: preserveFailedAppendRawFile(
                buildProjectionPlan(sourceObject, {
                  runId: run.id,
                  capturedAt: snapshot.createdAt,
                  converterVersion: BENCHLING_MIGRATION_PROJECTION_VERSION,
                  links: linksBySourceObjectId.get(sourceObject.id),
                  ...(() => {
                    const allocated = allocationBySourceObjectId.get(sourceObject.id);
                    if (allocated) {
                      return {
                        destination: allocated.destination,
                        destinationEntityId: allocated.destinationEntityId,
                      };
                    }
                    if (completesNeedsSequence && existing) {
                      return {
                        destinationDirectory: projectionPackageDirectory(existing.destinationPath),
                      };
                    }
                    return {};
                  })(),
                }),
                sourceObject,
                fallbackSourceIds.has(sourceObject.id) ? existing : undefined
              ),
              createdAt,
              deferReadbackUntilValidation: existing === undefined,
              ...(allocationBySourceObjectId.has(sourceObject.id)
                ? {
                    onInstallState: (nextState: 'staged' | 'installed') =>
                      advancePersistedBenchlingMigrationAllocation({
                        workspacePath: run.workspacePath,
                        actionId: attempt.id,
                        sourceObjectId: sourceObject.id,
                        nextState,
                        updatedAt: now(),
                      }).then(() => undefined),
                  }
                : {}),
            }),
          }))
        );
        for (const result of writeResults) {
          if (result.status !== 'fulfilled') continue;
          const { existing, receipt, sourceObject } = result.value;
          if (existing) {
            if (
              receipt.destinationObjectId !== existing.destinationObjectId ||
              (receipt.destinationPath !== existing.destinationPath &&
                !(
                  existing.nativeRepresentation === 'dna_sequence_needs_sequence' &&
                  receipt.nativeRepresentation === 'dna_sequence' &&
                  projectionPackageDirectory(receipt.destinationPath) ===
                    projectionPackageDirectory(existing.destinationPath)
                ))
            ) {
              throw new Error('Linked-item recovery changed a stable destination identity.');
            }
          }
          const historicalHead = historicalHeadBySourceId.get(receipt.sourceObjectId);
          if (historicalHead?.id === receipt.id) {
            const { createdAt: _priorTime, ...priorFacts } = historicalHead;
            const { createdAt: _newTime, ...newFacts } = receipt;
            if (!isDeepStrictEqual(priorFacts, newFacts))
              throw new Error(
                `Reinstalled projection differs from its immutable receipt: ${Object.keys(newFacts)
                  .filter(
                    (key) =>
                      !isDeepStrictEqual(Reflect.get(priorFacts, key), Reflect.get(newFacts, key))
                  )
                  .join(', ')}.`
              );
          } else if (historicalHead) {
            deps.store.appendProjectionReceiptRevision({
              receipt,
              sourceSnapshot: sourceObject,
              supersedesReceiptId: historicalHead.id,
            });
          } else deps.store.appendProjectionReceipt(receipt, sourceObject);
        }
        const failedWrite = writeResults.find((result) => result.status === 'rejected');
        if (failedWrite?.status === 'rejected') throw failedWrite.reason;
        publishMeasuredProgress({
          kind: 'write_objects',
          completed: Math.min(
            offset + LOCAL_EXPORT_PROJECTION_WRITE_CONCURRENCY,
            pendingProjectionWrites.length
          ),
          total: pendingProjectionWrites.length,
        });
      }
      receipts = await readCurrentReceipts();

      const collectionProjection = await projectLocalCollections({
        run,
        actionId: attempt.id,
        materializedSourceIds: currentMaterialization.materializedSourceIds,
        selectedFolderIds: currentMaterialization.selectedFolderIds,
        snapshot,
        sourceObjects,
        receipts,
        resolutions,
        relationshipBenchlingOrigin: attempt.recoveryPlan?.organizationBaseUrl,
        workspaceAppendHierarchyCaptures: authorizedSupplementalHierarchyCaptures(
          deps.store,
          run.id,
          attempt.id
        ),
      });
      await persistMigrationDestinationLinkIndex({
        workspacePath: run.workspacePath,
        sourceObjects,
        receipts,
        collectionProjection,
        collectionLayout: collectionProjectionLayoutForRun(run),
      });
      attempt = transitionAttempt(attempt, 'validating', now, {
        repairedRelationshipCount: attempt.recoveryPlan
          ? countRepairedRelationships(resolutions, attempt.recoveryPlan)
          : attempt.repairedRelationshipCount,
      });
      deps.store.putLinkedItemRecoveryAttempt(attempt);
      run = publishProgress(
        run,
        attempt,
        deps,
        'Checking the recovered notebook…',
        progressStartedAt
      );
    }

    if (attempt.state !== 'validating') {
      throw new Error(`Linked-item recovery cannot resume from ${attempt.state}.`);
    }
    return await validateAndCompleteAttempt(
      run,
      attempt,
      deps,
      now,
      progressStartedAt,
      publishMeasuredProgress
    );
  } catch (caughtError) {
    let error = caughtError;
    const journal = await readBenchlingMigrationActionJournal(run.workspacePath, attempt.id);
    if (
      journal &&
      !(
        error instanceof BenchlingMigrationActionRecoveryError &&
        error.code === 'catalog_commit_uncertain'
      ) &&
      journal.allocations.every((allocation) =>
        ['reserved', 'staged', 'installed'].includes(allocation.installState)
      )
    ) {
      try {
        deps.assertMutationLeaseHeld?.();
        await restoreStructuralParentReplacements(
          run.workspacePath,
          journal.allocations,
          deps.store.listProjectionReceipts(run.id)
        );
      } catch (rollbackError) {
        error = new AggregateError(
          [error, rollbackError],
          'Import failed and structural rollback needs attention. Original data remains in the recorded backup.'
        );
      }
    }
    const durableAttempt = deps.store.getLinkedItemRecoveryAttempt(run.id, attempt.id);
    if (durableAttempt?.state === 'completed' || durableAttempt?.state === 'failed') {
      throw error;
    }
    if (durableAttempt) attempt = durableAttempt;
    if (attempt.state === 'completed' || attempt.state === 'failed') throw error;
    const safeMessage =
      error instanceof LinkedItemRecoveryError
        ? error.message
        : 'DNAForge could not finish this linked-item export batch. You can retry it.';
    const failed = advanceAttempt(attempt, {
      state: 'failed',
      resumeState: attempt.state,
      safeFailure: {
        code: safeFailureCode(attempt.state),
        message: safeMessage,
        retryable: error instanceof LinkedItemRecoveryError ? error.retryable : true,
        ...(error instanceof LinkedItemRecoveryError && error.bestEffortFallbackSources
          ? { bestEffortFallbackSources: error.bestEffortFallbackSources }
          : {}),
      },
      updatedAt: nextTimestamp(attempt.updatedAt, now()),
    });
    deps.store.putLinkedItemRecoveryAttempt(failed);
    try {
      run = publishProgress(run, failed, deps, safeMessage);
    } catch (progressError) {
      console.error('[benchling-migration] failed to publish linked-item failure', progressError);
    }
    throw error;
  }
}

async function validateAndCompleteAttempt(
  run: MigrationRun,
  attempt: LinkedItemRecoveryAttempt,
  deps: LinkedItemRecoveryExecutorDeps,
  now: () => string,
  progressStartedAt: string,
  publishMeasuredProgress: (work: LinkedItemRecoveryWorkProgress) => void
): Promise<MigrationRun> {
  const snapshot = requireSnapshot(run.id, deps.store);
  const currentMaterialization = await readCurrentImportMaterialization({
    db: deps.destinationDb,
    run,
    store: deps.store,
    actionId: attempt.id,
    sources: await deps.store.listSourceObjectValidationViewsCooperatively(run.id),
    mapSource: sourceObjectValidationView,
  });
  const sourceObjects = sortedSourceObjects(currentMaterialization.sources);
  persistOfflineResolutions(
    run,
    deps.store,
    attempt.recoveryPlan?.organizationBaseUrl,
    sourceObjects
  );
  const resolutions = deps.store.listRelationshipResolutions(run.id);
  const receipts = currentMaterialization.receipts;
  const attempts = deps.store.listLinkedItemRecoveryAttempts(run.id);
  const currentAttemptIndex = attempts.findIndex((candidate) => candidate.id === attempt.id);
  if (currentAttemptIndex < 0) {
    throw new Error(`Linked-item recovery attempt ${attempt.id} is not persisted.`);
  }
  const unfinalizedFailedAttemptIds = new Set<string>();
  for (let index = currentAttemptIndex - 1; index >= 0; index -= 1) {
    const candidate = attempts[index];
    if (candidate.state === 'completed') break;
    if (candidate.state === 'failed') {
      unfinalizedFailedAttemptIds.add(candidate.id);
    }
  }
  const recoveryCaptures = deps.store.listLinkedItemRecoveryCaptures(run.id);
  const selectedArtifactIds = new Set(attempt.artifactIds);
  const selectedFailedCaptures = recoveryCaptures.filter(
    (capture) =>
      unfinalizedFailedAttemptIds.has(capture.attemptId) &&
      selectedArtifactIds.has(capture.artifactId)
  );
  const recoveredSourceIds = new Set(
    [
      ...recoveryCaptures.filter((capture) => capture.attemptId === attempt.id),
      ...selectedFailedCaptures,
    ].map((capture) => capture.sourceObjectId)
  );
  const actionJournal = await readBenchlingMigrationActionJournal(run.workspacePath, attempt.id);
  const shouldFinalizeUnlockedRecovery =
    Boolean(actionJournal) ||
    attempt.fileResults.some((result) => result.outcome === 'accepted') ||
    recoveryCaptures.some((capture) => capture.attemptId === attempt.id) ||
    selectedFailedCaptures.length > 0;
  const integrityReceipts =
    run.state === 'unlocked'
      ? receipts.filter(
          (receipt) =>
            recoveredSourceIds.has(receipt.sourceObjectId) &&
            !(actionJournal?.retainedClaims ?? []).some(
              (claim) => claim.sourceObjectId === receipt.sourceObjectId
            ) &&
            !(actionJournal?.allocations ?? []).some(
              (allocation) =>
                allocation.sourceObjectId === receipt.sourceObjectId &&
                allocation.writeDisposition === 'retain'
            )
        )
      : receipts;
  const preservedDestinationPaths =
    run.state === 'unlocked'
      ? await readUnlockedNativeDestinations(
          run.workspacePath,
          deps.listFilesAtHead,
          integrityReceipts
        )
      : undefined;
  const { collectionProjection: persistedCollections, scopedFolders } =
    await readLocalCollectionEvidence(run);
  await persistMigrationDestinationLinkIndex({
    workspacePath: run.workspacePath,
    sourceObjects,
    receipts,
    collectionProjection: persistedCollections,
    collectionLayout: collectionProjectionLayoutForRun(run),
  });
  const projectionIntegrity = await verifyProjectionReceiptIntegrity({
    workspacePath: run.workspacePath,
    receipts: integrityReceipts,
    preservedDestinationPaths,
    destinationArtifacts: {
      collectionDocumentPaths:
        persistedCollections?.collections.map((collection) =>
          nativeCollectionDocumentPath(collection, collectionProjectionLayoutForRun(run))
        ) ?? [],
      nativeFolderPaths: persistedCollections
        ? [
            ...nativeFolderPathMap(
              persistedCollections,
              collectionProjectionLayoutForRun(run)
            ).values(),
          ]
        : [],
    },
    onProgress: ({ completed, total }) =>
      publishMeasuredProgress({
        kind: 'validate_saved_objects',
        completed,
        total,
      }),
  });
  const selectedSourceObjectIds = sourceObjects.map((sourceObject) => sourceObject.id).sort();
  if (projectionIntegrity.failures.length === 0) {
    publishMeasuredProgress({
      kind: 'validate_objects',
      completed: 0,
      total: selectedSourceObjectIds.length,
    });
  }
  const renderChecks =
    projectionIntegrity.failures.length === 0
      ? await deps.renderValidator({
          run,
          sourceObjects,
          receipts,
          resolutions,
          selectedSourceObjectIds,
          onProgress: ({ completed, total }) =>
            publishMeasuredProgress({
              kind: 'validate_objects',
              completed,
              total,
            }),
        })
      : selectedSourceObjectIds.map((sourceObjectId) => ({
          sourceObjectId,
          passed: false,
          message: 'Projection integrity failed before render validation.',
        }));
  const archiveIntegrity = await verifyLocalSnapshotArchiveIntegrity(
    snapshot,
    deps.archive,
    sourceObjects,
    ({ phase, completed, total }) =>
      publishMeasuredProgress({
        kind:
          phase === 'persisting_source_files' ? 'persist_source_files' : 'validate_source_files',
        completed,
        total,
      }),
    run.externalZipSource,
    run.externalZipEntries,
    deps.store
      .listLinkedItemRecoveryArtifacts(run.id)
      .flatMap((record) =>
        record.schema === 'dnaforge.benchling.linked-item-recovery-source.v2'
          ? [{ source: record.externalZipSource, entries: record.externalZipEntries }]
          : []
      ),
    run.baseline?.kind === 'adopted_workspace'
  );
  const attemptEvidence = completedAttemptEvidence(
    attempt,
    attempt.recoveryPlan,
    resolutions,
    now()
  );
  const report = generateValidationReport({
    run,
    uninstalledSupplementalSourceIds: currentMaterialization.uninstalledCapturedSourceIds,
    ...((run.externalZipSource || run.baseline?.kind === 'adopted_workspace') &&
    currentMaterialization.nativeMembershipAuthority
      ? {
          nativeMembershipAuthority: currentMaterialization.nativeMembershipAuthority,
          materializedSourceIds: currentMaterialization.materializedSourceIds,
        }
      : {}),
    ...(run.externalZipSource || run.baseline?.kind === 'adopted_workspace'
      ? {
          nativeImportAction: {
            actionId: attempt.id,
            selectedSourceObjectIds: [...recoveredSourceIds],
            failedFiles: attempt.fileResults.flatMap((result) =>
              result.outcome === 'rejected'
                ? [
                    {
                      fileName: basename(
                        attempt.intakeDescriptors[result.fileIndex]?.sourcePath ??
                          'Benchling export'
                      ),
                      reason: result.failure?.message ?? 'Could not read this export.',
                    },
                  ]
                : []
            ),
            destinationChanges: summarizeActionDestinationChanges(
              await readBenchlingMigrationActionJournal(run.workspacePath, attempt.id)
            ),
            history: (run.baseline?.kind === 'adopted_workspace' &&
            !attempts.some((previous) => previous.state === 'completed')
              ? 'adopted_history_created'
              : 'existing_history') as 'adopted_history_created' | 'existing_history',
            decisions: deps.store.listImportDecisions(run.id, attempt.id),
            providerVersionConflictCount:
              attempt.versionConflictResolution.kind === 'resolved'
                ? attempt.versionConflictResolution.conflicts.length
                : 0,
            externalSourceIds: deps.store
              .listLinkedItemRecoveryArtifacts(run.id, attempt.id)
              .flatMap((artifact) =>
                artifact.schema === 'dnaforge.benchling.linked-item-recovery-source.v2'
                  ? [artifact.externalZipSource.sourceId]
                  : []
              ),
          },
        }
      : {}),
    snapshot,
    sourceObjects,
    archiveIntegrity: archiveIntegrity.evidence,
    archiveIntegrityFailures: archiveIntegrity.failures,
    exportJobs: deps.store.listExportJobs(run.id),
    exportCaptures: deps.store.listExportCaptures(run.id),
    exportInspections: deps.store.listExportInspections(run.id),
    exportJobReplacements: deps.store.listExportJobReplacements(run.id),
    gmailReceiptConfirmations: deps.store.listGmailReceiptConfirmations(run.id),
    providerTaskEvidence: deps.store.listProviderTaskEvidence(run.id),
    providerActivityEvidence: deps.store.listProviderActivityEvidence(run.id),
    providerCommandJournal: deps.store.listProviderCommandJournal(run.id),
    requestLedgerEntries: deps.store.listRequestLedgerEntries(run.id),
    nativeExportReconciliations: deps.store.listNativeExportReconciliations(run.id),
    providerActivityRequired: false,
    collectionProjection: persistedCollections,
    scopedFolders,
    workspaceAppendHierarchyCaptures: authorizedSupplementalHierarchyCaptures(
      deps.store,
      run.id,
      attempt.id
    ),
    expectedRenderObjectIds: selectedSourceObjectIds,
    renderChecks,
    resolutions,
    receipts,
    projectionIntegrity,
    priorLinkedItemRecoveryEvidence: attempt.recoveryPlan,
    linkedItemRecoveryAttempts: [attemptEvidence],
    generatedAt: attemptEvidence.completedAt,
  });
  if (!report.passed) {
    console.error(
      '[benchling-migration] linked-item recovery validation did not pass',
      report.issues.map((issue) => ({
        code: issue.code,
        message: issue.message,
        details: issue.details,
      }))
    );
    if (run.state !== 'unlocked') deps.store.saveValidationReport(report);
    const selectedArtifacts = deps.store.listLinkedItemRecoveryArtifacts(run.id, attempt.id);
    const entriesByArtifact = new Map<
      string,
      Array<{ entryPath: string; sourceObjectId: string; role: 'source-record' }>
    >();
    for (const artifact of selectedArtifacts) {
      if (artifact.schema === 'dnaforge.benchling.linked-item-recovery-source.v2') {
        entriesByArtifact.set(
          artifact.id,
          artifact.externalZipEntries
            .filter((entry) => entry.role === 'source-record')
            .map((entry) => ({
              entryPath: entry.entryPath,
              sourceObjectId: entry.sourceObjectId,
              role: 'source-record',
            }))
        );
      } else {
        const inspected = await inspectNativeExportArchive(
          verifiedZipArtifact(artifact).nativeExportDecoderSource
        );
        entriesByArtifact.set(
          artifact.id,
          inspected.entries
            .filter((entry) => !entry.isDirectory)
            .flatMap((entry) => {
              const matches = sourceObjects.filter((source) => source.sourcePath === entry.path);
              return matches.length === 1
                ? [
                    {
                      entryPath: entry.path,
                      sourceObjectId: matches[0].id,
                      role: 'source-record' as const,
                    },
                  ]
                : [];
            })
        );
      }
    }
    const sourceEntries = [...entriesByArtifact.values()].flat();
    const fallbackPaths = selectBestEffortRenderFallbackPaths({
      expectedSourceObjectIds: selectedSourceObjectIds,
      renderChecks,
      blockingIssues: report.issues.filter((issue) => issue.blocking),
      sourceObjects,
      sourceEntries,
      alreadyFallbackEntryPaths: attempt.bestEffortFallback?.sources.flatMap(
        (source) => source.entryPaths
      ),
    });
    const previousSources = attempt.bestEffortFallback?.sources ?? [];
    const sourcePathsBySha = new Map(
      previousSources.map((source) => [source.zipSha256, [...source.entryPaths]] as const)
    );
    for (const entryPath of fallbackPaths) {
      const matches = selectedArtifacts.filter((artifact) =>
        entriesByArtifact.get(artifact.id)?.some((entry) => entry.entryPath === entryPath)
      );
      if (matches.length !== 1) {
        sourcePathsBySha.clear();
        break;
      }
      const sha = linkedItemRecoveryArtifactSha256(matches[0]);
      sourcePathsBySha.set(
        sha,
        [...new Set([...(sourcePathsBySha.get(sha) ?? []), entryPath])].sort()
      );
    }
    const fallbackSources =
      fallbackPaths.length > 0 && sourcePathsBySha.size > 0
        ? [...sourcePathsBySha].map(([zipSha256, entryPaths]) => ({ zipSha256, entryPaths }))
        : undefined;
    throw new LinkedItemRecoveryError(
      'linked_item_recovery_validation_failed',
      'The linked-item exports were kept safely, but the notebook did not pass validation.',
      true,
      fallbackSources
    );
  }
  if (run.externalZipSource) await verifyExternalZipSource(run.externalZipSource);
  for (const artifact of deps.store.listLinkedItemRecoveryArtifacts(run.id, attempt.id)) {
    if (artifact.schema === 'dnaforge.benchling.linked-item-recovery-source.v2') {
      await verifyExternalZipSource(artifact.externalZipSource);
    }
  }
  if (run.state === 'unlocked') {
    if (shouldFinalizeUnlockedRecovery) {
      if (!deps.finalizeUnlockedRecovery) {
        throw new LinkedItemRecoveryError(
          'linked_item_recovery_native_finalizer_missing',
          'DNAForge cannot safely add linked items to this unlocked workspace.',
          false
        );
      }
      const materializationSourceObjects = sortedSourceObjects(
        (
          await readCurrentImportMaterialization({
            db: deps.destinationDb,
            run,
            store: deps.store,
            actionId: attempt.id,
            mapSource: (source) =>
              receipts.some(
                (receipt) =>
                  receipt.sourceObjectId === source.id &&
                  receipt.destination?.kind === 'catalog-record'
              )
                ? source
                : sourceObjectMaterializationView(source),
            sources: await deps.store.listSourceObjectMaterializationViewsCooperatively(run.id, {
              retainContentForSourceObjectIds: new Set(
                receipts
                  .filter((receipt) => receipt.destination?.kind === 'catalog-record')
                  .map((receipt) => receipt.sourceObjectId)
              ),
            }),
          })
        ).sources
      );
      publishMeasuredProgress({ kind: 'finalize_workspace', completed: 0, total: 0 });
      await deps.finalizeUnlockedRecovery(
        run,
        report,
        materializationSourceObjects,
        receipts,
        resolutions,
        attempt.id
      );
    }
  } else {
    await (deps.persistPassedReport ?? persistMigrationWorkspaceReport)(run, report);
  }
  const completedAttempt = advanceAttempt(attempt, {
    state: 'completed',
    updatedAt: attemptEvidence.completedAt,
    completedAt: attemptEvidence.completedAt,
  });
  const progress = linkedItemRecoveryProgressForAttempt(
    completedAttempt,
    deps.store.listImportDecisions(completedAttempt.runId, completedAttempt.id)
  );
  const completedRun = {
    ...run,
    linkedItemRecovery: progress,
    updatedAt: completedAttempt.updatedAt,
  };
  deps.store.commitLinkedItemRecoveryCompletion({
    attempt: completedAttempt,
    report,
    run: completedRun,
  });
  deps.onRunUpdated?.(
    completedRun,
    completedAttempt.recoveredUniqueObjectCount === 0
      ? 'No matching linked items were found. The original notebook remains ready.'
      : 'Linked items recovered.'
  );
  return completedRun;
}

export async function readUnlockedNativeDestinations(
  workspacePath: string,
  readTrackedFiles: typeof listFilesAtHead = readLegacyNativeFiles,
  replacingReceipts: readonly ProjectionReceipt[] = []
): Promise<Array<{ path: string; kind: 'file' | 'directory' }>> {
  const replacingRoots = new Set(
    replacingReceipts.flatMap((receipt) => {
      const destination = receipt.destination;
      if (!destination) return [projectionPackageDirectory(receipt.destinationPath)];
      switch (destination.kind) {
        case 'file':
          return [destination.relativePath];
        case 'package':
          return [destination.rootRelativePath];
        case 'catalog-record':
          return [];
      }
    })
  );
  const authoritativeRoots = await nativeManifestPhysicalRoots(workspacePath);
  const replacingRootList = [...replacingRoots];
  const isInside = (path: string, directory: string): boolean =>
    path === directory || path.startsWith(`${directory}/`);
  const trackedPaths =
    authoritativeRoots === null
      ? await readTrackedFiles(workspacePath)
      : await readNativePhysicalFiles(
          workspacePath,
          authoritativeRoots.filter(
            (root) => !replacingRootList.some((replacing) => isInside(root, replacing))
          )
        );
  return trackedPaths
    .map((path) => path.replaceAll('\\', '/'))
    .filter((path) => isSafeWorkspaceRelativePath(path))
    .filter((path) => {
      if (authoritativeRoots === null) {
        return path.startsWith('Benchling Imports/');
      }
      return authoritativeRoots.some((root) => isInside(path, root));
    })
    .filter((path) => !replacingRootList.some((root) => isInside(path, root)))
    .sort()
    .map((path) => ({ path, kind: 'file' as const }));
}

async function readLegacyNativeFiles(workspacePath: string): Promise<string[]> {
  if (isGitRepo(workspacePath) && (await resolveHeadCommit(workspacePath)))
    return listFilesAtHead(workspacePath);
  try {
    await lstat(join(workspacePath, 'Benchling Imports'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  return readNativePhysicalFiles(workspacePath, ['Benchling Imports']);
}

async function readNativePhysicalFiles(
  workspacePath: string,
  roots: readonly string[]
): Promise<string[]> {
  const files = new Set<string>();
  const visited = new Set<string>();
  const visit = async (relativePath: string): Promise<void> => {
    if (visited.has(relativePath)) return;
    visited.add(relativePath);
    if (!isSafeWorkspaceRelativePath(relativePath))
      throw new Error('Native inventory path is unsafe.');
    const absolutePath = join(workspacePath, relativePath);
    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink()) throw new Error('Native inventory cannot follow a symbolic link.');
    if (stats.isFile()) {
      files.add(relativePath);
      return;
    }
    if (!stats.isDirectory())
      throw new Error('Native inventory contains an unsupported filesystem entry.');
    for (const child of await readdir(absolutePath)) await visit(`${relativePath}/${child}`);
  };
  for (const root of roots) {
    const segments = root.split('/');
    for (let end = 1; end < segments.length; end += 1) {
      const parent = await lstat(join(workspacePath, ...segments.slice(0, end)));
      if (!parent.isDirectory() || parent.isSymbolicLink())
        throw new Error('Native inventory parent is not a regular directory.');
    }
    await visit(root);
  }
  return [...files].sort();
}

async function nativeManifestPhysicalRoots(workspacePath: string): Promise<string[] | null> {
  try {
    const manifest = parseNativeWorkspaceManifest(
      await readFile(join(workspacePath, NATIVE_WORKSPACE_MANIFEST_PATH), 'utf8')
    );
    if (manifest.schema === 'dnaforge.native-workspace-manifest.v1') return null;
    return manifest.entities
      .flatMap((entity) => {
        const placement = entity.placement;
        switch (placement.kind) {
          case 'file':
            return [placement.relativePath];
          case 'package':
            return [placement.rootRelativePath];
          case 'catalog-record':
            return [];
        }
      })
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function resolveRecoveryLocationForRun(
  run: MigrationRun,
  store: MigrationStore,
  kind: 'folder' | 'target',
  sourceId: string
): string {
  const report = store.getValidationReport(run.id);
  const evidence =
    report && isValidationReportV2(report) ? report.linkedItemRecovery?.evidence : undefined;
  const url = evidence ? resolveLinkedItemRecoveryLocation(evidence, kind, sourceId) : null;
  if (!url) throw new Error('This linked-item recovery location is not in the durable plan.');
  return url;
}

function requireReadyLocalZipRun(run: MigrationRun, store: MigrationStore): MigrationRun {
  const persisted = store.getRun();
  const hasAppendBaseline =
    persisted?.baseline?.kind === 'adopted_workspace' ||
    persisted?.externalZipSource !== undefined ||
    persisted?.localExportArtifact?.format === 'zip';
  if (
    !persisted ||
    persisted.id !== run.id ||
    (persisted.state !== 'ready_to_unlock' && persisted.state !== 'unlocked') ||
    persisted.binding !== null ||
    persisted.scope.acquisition !== 'local_bundle' ||
    !hasAppendBaseline
  ) {
    throw new LinkedItemRecoveryError(
      'linked_item_recovery_run_invalid',
      'Linked-item recovery requires a validated local ZIP migration.'
    );
  }
  return persisted;
}

function appendDestinationFolderId(run: MigrationRun): string | null {
  if (run.scope.kind === 'folder') return run.scope.folder.id;
  if (run.scope.kind === 'folder_tree') return run.scope.roots[0]?.id ?? null;
  return null;
}

function preserveFailedAppendRawFile(
  plan: ProjectionPlan,
  sourceObject: SourceObject,
  failedReceipt: ProjectionReceipt | undefined
): ProjectionPlan {
  if (!failedReceipt) return plan;
  if (plan.projection !== 'fallback' || sourceObject.sourceType !== 'unsupported_object') {
    throw new LinkedItemRecoveryError(
      'linked_item_recovery_fallback_invalid',
      'The failed source no longer matches its file fallback.',
      false
    );
  }
  const content = sourceObject.content;
  const sha256 =
    content &&
    typeof content === 'object' &&
    !Array.isArray(content) &&
    'sha256' in content &&
    typeof content.sha256 === 'string'
      ? content.sha256.replace(/^sha256:/u, '')
      : '';
  if (
    !/^[a-f0-9]{64}$/u.test(sha256) ||
    !failedReceipt.destination ||
    failedReceipt.destination.kind === 'catalog-record'
  ) {
    throw new LinkedItemRecoveryError(
      'linked_item_recovery_fallback_destination_invalid',
      'The failed file cannot safely reuse its staged destination.',
      false
    );
  }
  return {
    ...plan,
    files: [],
    attachmentAssets: [{ relativePath: failedReceipt.destinationPath, archiveSha256: sha256 }],
    destination: failedReceipt.destination,
    destinationObjectId: failedReceipt.destinationObjectId,
    converterId: 'benchling-preserved-raw-file',
  };
}

async function recoveryPlan(
  run: MigrationRun,
  store: MigrationStore,
  priorEvidence: ValidationLinkedItemRecoveryEvidence | null
): Promise<ValidationLinkedItemRecoveryEvidence | null> {
  return buildLinkedItemRecoveryEvidence({
    run,
    sourceObjects: await store.listSourceObjectsCooperatively(run.id),
    resolutions: store.listRelationshipResolutions(run.id),
    priorEvidence,
  });
}

type RecoveredObjectPersistenceInput = {
  run: MigrationRun;
  attempt: LinkedItemRecoveryAttempt;
  artifact: LinkedItemRecoveryArtifact;
  recovered: LinkedItemRecoveryDecodedObject;
  archive: ContentArchive;
  store: MigrationStore;
  capturedAt: string;
  sourceVersionPolicy: RecoveredSourceObjectVersionPolicy;
};

type PreparedRecoveredObjectPersistence = Readonly<{
  input: RecoveredObjectPersistenceInput;
  manifestId: string;
  manifestEntries: LogicalContentManifestEntry[];
  capture: LinkedItemRecoveryCapture;
  snapshotPart: {
    id: string;
    kind: 'supplemental_local_export';
    sha256: string;
    sizeBytes: number;
    capturedAt: string;
    sourceJobId: null;
    sourceObjectId: string;
    supersedesPartId: null;
  };
}>;

async function persistRecoveredObjects(
  inputs: readonly RecoveredObjectPersistenceInput[],
  onProgress?: (progress: Readonly<{ completed: number; total: number }>) => void
): Promise<void> {
  for (
    let offset = 0;
    offset < inputs.length;
    offset += RECOVERED_OBJECT_MANIFEST_WRITE_CONCURRENCY
  ) {
    const prepared = inputs
      .slice(offset, offset + RECOVERED_OBJECT_MANIFEST_WRITE_CONCURRENCY)
      .map(prepareRecoveredObjectPersistence);
    await Promise.all(
      prepared.map(({ input, manifestId, manifestEntries }) =>
        input.artifact.schema === 'dnaforge.benchling.linked-item-recovery-source.v2'
          ? Promise.resolve()
          : input.archive.writeManifest(manifestId, { version: 1, entries: manifestEntries })
      )
    );
    for (const item of prepared) {
      item.input.store.commitLinkedItemRecoveryCapture({
        capture: item.capture,
        sourceObject: item.input.recovered.sourceObject,
        snapshotPart: item.snapshotPart,
        sourceVersionPolicy: item.input.sourceVersionPolicy,
      });
    }
    onProgress?.({
      completed: Math.min(offset + RECOVERED_OBJECT_MANIFEST_WRITE_CONCURRENCY, inputs.length),
      total: inputs.length,
    });
  }
}

function prepareRecoveredObjectPersistence(
  input: RecoveredObjectPersistenceInput
): PreparedRecoveredObjectPersistence {
  const sourceObjectId = input.recovered.sourceObject.id;
  const artifactSha256 = linkedItemRecoveryArtifactSha256(input.artifact);
  const artifactDisplayName = linkedItemRecoveryArtifactDisplayName(input.artifact);
  const artifactSizeBytes = linkedItemRecoveryArtifactSizeBytes(input.artifact);
  const partId = migrationEvidenceId(
    'supplemental-part',
    `${input.run.id}\0${sourceObjectId}\0${artifactSha256}`
  );
  const capturedAt =
    input.store.getSnapshotPart(input.run.id, partId)?.capturedAt ?? input.capturedAt;
  const manifestEntries: LogicalContentManifestEntry[] = [
    {
      logicalFilename: artifactDisplayName,
      sourceArchivePath: `supplementary/${safeEvidenceName(artifactDisplayName)}`,
      sha256: plainSha256(artifactSha256),
      size: artifactSizeBytes,
      archivePartId: partId,
      sourceObjectId,
    },
    ...input.recovered.attachments.map((attachment) => {
      const sha256 =
        attachment.kind === 'archived'
          ? attachment.blob.sha256
          : plainSha256(attachment.entry.entrySha256);
      const size =
        attachment.kind === 'archived' ? attachment.blob.size : attachment.entry.sizeBytes;
      return {
        logicalFilename: attachment.evidence.logicalFilename,
        sourceArchivePath: attachment.evidence.entryPath,
        sha256,
        size,
        archivePartId: partId,
        sourceObjectId,
      };
    }),
  ];
  const capture: LinkedItemRecoveryCapture = {
    schema: 'dnaforge.benchling.linked-item-recovery-capture.v1',
    id: migrationEvidenceId(
      'supplemental-capture',
      `${input.run.id}\0${input.attempt.id}\0${input.artifact.id}\0${sourceObjectId}\0${input.recovered.sourceContentSha256}`
    ),
    runId: input.run.id,
    attemptId: input.attempt.id,
    artifactId: input.artifact.id,
    sourceObjectId,
    sourceStableId: input.recovered.sourceObject.stableId,
    sourceScientificContentSha256: input.recovered.sourceContentSha256,
    snapshotPartId: partId,
    capturedAt,
    sourceFolderMemberships: readNativeSourceFolderMemberships(
      input.recovered.sourceObject,
      input.run.id
    ),
  };
  return {
    input,
    manifestId: migrationEvidenceId('supplemental', partId),
    manifestEntries,
    capture,
    snapshotPart: {
      id: partId,
      kind: 'supplemental_local_export',
      sha256: plainSha256(artifactSha256),
      sizeBytes: artifactSizeBytes,
      capturedAt,
      sourceJobId: null,
      sourceObjectId,
      supersedesPartId: null,
    },
  };
}

function isCompleteDnaSource(sourceObject: SourceObject): boolean {
  if (
    sourceObject.sourceType
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/gu, '_') !== 'dna_sequence'
  ) {
    return false;
  }
  const content = sourceObject.content;
  return (
    content !== null &&
    typeof content === 'object' &&
    !Array.isArray(content) &&
    (content as Record<string, unknown>).kind !== 'dna_sequence_needs_sequence' &&
    typeof (content as Record<string, unknown>).bases === 'string' &&
    ((content as Record<string, unknown>).bases as string).length > 0
  );
}

function projectionPackageDirectory(destinationPath: string): string {
  const forgeSegment = destinationPath.indexOf('/.forge/');
  const directory =
    forgeSegment >= 0
      ? destinationPath.slice(0, forgeSegment)
      : destinationPath.slice(0, destinationPath.lastIndexOf('/'));
  if (!isSafeWorkspaceRelativePath(directory)) {
    throw new Error('Existing linked-item projection package path is unsafe.');
  }
  const topLevel = directory.split('/')[0]?.normalize('NFC').toLowerCase();
  if (topLevel && ['.git', '.dnaforge', '.forge', '.waypoint'].includes(topLevel)) {
    throw new Error('Existing linked-item projection package path uses a protected root.');
  }
  return directory;
}

function projectionHashDigest(value: string): Sha256Digest {
  const digest = value.replace(/^sha256:/u, '').toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new Error('Existing projection destination hash is invalid.');
  }
  return `sha256:${digest}`;
}

function publishProgress(
  run: MigrationRun,
  attempt: LinkedItemRecoveryAttempt,
  deps: LinkedItemRecoveryExecutorDeps,
  message?: string,
  startedAt?: string
): MigrationRun {
  const progress = linkedItemRecoveryProgressForAttempt(
    attempt,
    deps.store.listImportDecisions(attempt.runId, attempt.id)
  );
  const updatedAt =
    Date.parse(attempt.updatedAt) > Date.parse(run.updatedAt) ? attempt.updatedAt : run.updatedAt;
  const updated = { ...run, linkedItemRecovery: progress, updatedAt };
  deps.store.saveRun(updated);
  deps.onRunUpdated?.(
    startedAt ? { ...updated, linkedItemRecovery: { ...progress, startedAt } } : updated,
    message
  );
  return updated;
}

function publishTransientProgress(
  run: MigrationRun,
  attempt: LinkedItemRecoveryAttempt,
  deps: LinkedItemRecoveryExecutorDeps,
  work: LinkedItemRecoveryWorkProgress,
  startedAt: string
): void {
  const progress = {
    ...linkedItemRecoveryProgressForAttempt(
      attempt,
      deps.store.listImportDecisions(attempt.runId, attempt.id)
    ),
    startedAt,
    work,
  };
  deps.onRunUpdated?.({ ...run, linkedItemRecovery: progress });
}

function workspaceAppendHierarchyAuthority(capture: WorkspaceAppendHierarchyCapture): string {
  return JSON.stringify({
    artifactId: capture.artifactId,
    artifactSha256: capture.artifactSha256,
    destinationRootSourceId: capture.destinationRootSourceId,
    zipRootName: capture.zipRootName,
    folders: capture.folders,
    memberships: capture.memberships,
  });
}

function authorizedSupplementalHierarchyCaptures(
  store: MigrationStore,
  runId: string,
  currentAttemptId: string
): WorkspaceAppendHierarchyCapture[] {
  const authorizedArtifactIds = new Set(
    store
      .listLinkedItemRecoveryAttempts(runId)
      .filter((attempt) => attempt.state === 'completed' || attempt.id === currentAttemptId)
      .flatMap((attempt) => attempt.artifactIds)
  );
  return store
    .listWorkspaceAppendHierarchyCaptures(runId)
    .filter((capture) => authorizedArtifactIds.has(capture.artifactId));
}

async function resolveAwaitingImportDecision(
  attempt: LinkedItemRecoveryAttempt,
  deps: LinkedItemRecoveryExecutorDeps,
  now: () => string
): Promise<LinkedItemRecoveryAttempt> {
  const pending = attempt.pendingImportDecision;
  const resumeState = attempt.pendingImportDecisionResumeState;
  if (!pending || !resumeState) {
    throw new Error(
      `Linked-item recovery attempt ${attempt.id} is awaiting a choice without durable prompt authority.`
    );
  }
  const savedDecision = deps.store
    .listImportDecisions(attempt.runId, attempt.id)
    .find((decision) => importDecisionKey(decision) === importDecisionKeyForPending(pending));
  let decision: ImportDecision;
  if (savedDecision) {
    decision = savedDecision;
  } else {
    if (!deps.resolveImportDecision) {
      throw new LinkedItemRecoveryError(
        'linked_item_recovery_import_choice_unavailable',
        'DNAForge cannot ask for the destination choice required by this import.',
        false
      );
    }
    decision = await deps.resolveImportDecision({
      runId: attempt.runId,
      attemptId: attempt.id,
      pending,
    });
  }
  if (!importDecisionAnswersPending(decision, pending)) {
    throw new Error(
      `Linked-item recovery attempt ${attempt.id} received an answer for a different import prompt.`
    );
  }
  if (!savedDecision) {
    deps.store.putImportDecision(attempt.runId, attempt.id, decision);
  }
  let versionConflictResolution = attempt.versionConflictResolution;
  if (pending.kind === 'provider_version_conflict') {
    if (
      decision.kind !== 'provider_version_conflict' ||
      attempt.versionConflictResolution.kind !== 'awaiting_choice'
    ) {
      throw new Error('Provider-version prompt state is inconsistent.');
    }
    versionConflictResolution = {
      kind: 'resolved',
      policy: decision.policy,
      conflicts: [attempt.versionConflictResolution.firstConflict],
    };
  }
  const resolved = advanceAttempt(attempt, {
    state: resumeState,
    pendingImportDecision: null,
    pendingImportDecisionResumeState: null,
    versionConflictResolution,
    updatedAt: nextTimestamp(attempt.updatedAt, now()),
  });
  deps.store.putLinkedItemRecoveryAttempt(resolved);
  return resolved;
}

function importDecisionKeyForPending(pending: PendingImportDecision): string {
  switch (pending.kind) {
    case 'provider_version_conflict':
      return 'provider_version_conflict';
    case 'unbound_exact_match':
      return `unbound_exact_match:${pending.sourceObjectId}`;
    case 'structural_path_conflict':
      return `structural_path_conflict:${pending.relativePath}`;
  }
}

async function persistAndResolveImportPrompt(input: {
  attempt: LinkedItemRecoveryAttempt;
  pending: PendingImportDecision;
  resumeState: 'parsing' | 'reconciling';
  deps: LinkedItemRecoveryExecutorDeps;
  now: () => string;
  onPending?: (attempt: LinkedItemRecoveryAttempt) => void;
}): Promise<LinkedItemRecoveryAttempt> {
  const answered = input.deps.store
    .listImportDecisions(input.attempt.runId, input.attempt.id)
    .find((decision) => importDecisionAnswersPending(decision, input.pending));
  if (answered) return input.attempt;
  const waiting = advanceAttempt(input.attempt, {
    state: 'awaiting_conflict_resolution',
    pendingImportDecision: input.pending,
    pendingImportDecisionResumeState: input.resumeState,
    updatedAt: nextTimestamp(input.attempt.updatedAt, input.now()),
  });
  input.deps.store.putLinkedItemRecoveryAttempt(waiting);
  input.onPending?.(waiting);
  return resolveAwaitingImportDecision(waiting, input.deps, input.now);
}

async function resolveProviderDestinationConflict(input: {
  attempt: LinkedItemRecoveryAttempt;
  conflict: LinkedItemRecoveryVersionConflict;
  deps: LinkedItemRecoveryExecutorDeps;
  now: () => string;
  onPending?: (attempt: LinkedItemRecoveryAttempt) => void;
}): Promise<LinkedItemRecoveryAttempt> {
  if (input.attempt.versionConflictResolution.kind === 'resolved') {
    if (
      input.attempt.versionConflictResolution.conflicts.some(
        (conflict) => conflict.stableId === input.conflict.stableId
      )
    ) {
      return input.attempt;
    }
    const updated = advanceAttempt(input.attempt, {
      versionConflictResolution: {
        ...input.attempt.versionConflictResolution,
        conflicts: [...input.attempt.versionConflictResolution.conflicts, input.conflict],
      },
      updatedAt: nextTimestamp(input.attempt.updatedAt, input.now()),
    });
    input.deps.store.putLinkedItemRecoveryAttempt(updated);
    return updated;
  }
  if (input.attempt.versionConflictResolution.kind !== 'none') {
    throw new Error('Provider-version conflict is already waiting for a different prompt.');
  }
  const pending: PendingImportDecision = {
    kind: 'provider_version_conflict',
    conflicts: [
      {
        sourceObjectId: input.conflict.sourceObjectId,
        stableId: input.conflict.stableId,
        displayName: input.conflict.name,
      },
    ],
  };
  const waiting = advanceAttempt(input.attempt, {
    state: 'awaiting_conflict_resolution',
    pendingImportDecision: pending,
    pendingImportDecisionResumeState: 'reconciling',
    versionConflictResolution: { kind: 'awaiting_choice', firstConflict: input.conflict },
    updatedAt: nextTimestamp(input.attempt.updatedAt, input.now()),
  });
  input.deps.store.putLinkedItemRecoveryAttempt(waiting);
  input.onPending?.(waiting);
  return resolveAwaitingImportDecision(waiting, input.deps, input.now);
}

function sourceObjectDestinationPrecondition(input: {
  source: SourceObject;
  run: MigrationRun;
  deps: LinkedItemRecoveryExecutorDeps;
  fallback: Sha256Digest;
}): Sha256Digest {
  if (
    input.source.sourceType !== 'registry_record' ||
    !input.deps.destinationDb ||
    !input.run.workspaceDbId
  )
    return input.fallback;
  const receipt = input.deps.store
    .listProjectionReceipts(input.run.id)
    .find((entry) => entry.sourceObjectId === input.source.id);
  if (!receipt) return input.fallback;
  const state = readNativeCatalogRecordState(
    input.deps.destinationDb,
    scopedProjectionId(input.run.projectionScopeId, receipt.destinationObjectId)
  );
  if (!state || state.workspaceId !== input.run.workspaceDbId)
    throw new Error('The native registry record is no longer active in this workspace.');
  return nativeCatalogRecordStateSha256(state);
}

function fixedDestinationForExisting(
  run: MigrationRun,
  location: DestinationInventoryLocation
): {
  destinationEntityId: string;
  destination: import('../../shared/benchling-migration').ProjectionDestination;
  expectedPriorImportedHash: Sha256Digest;
} {
  if (!location.scientificSha256) {
    throw new Error('Existing destination has no scientific replacement precondition.');
  }
  const destinationEntityId = portableDestinationEntityId(run, location.entityId);
  return {
    destinationEntityId,
    destination:
      location.kind === 'file'
        ? { kind: 'file', relativePath: location.relativePath }
        : {
            kind: 'catalog-record',
            parentRelativePath: location.parentRelativePath,
            displayName: location.displayName,
            catalogType: location.catalogType,
            presentationKind: location.presentationKind,
          },
    expectedPriorImportedHash: location.scientificSha256,
  };
}

async function receiptForReusedDestination(input: {
  run: MigrationRun;
  actionId: string;
  sourceObject: SourceObject;
  location: DestinationInventoryLocation;
  snapshotCreatedAt: string;
  createdAt: string;
}): Promise<ProjectionReceipt> {
  const fixed = fixedDestinationForExisting(input.run, input.location);
  const plan = buildProjectionPlan(input.sourceObject, {
    runId: input.run.id,
    capturedAt: input.snapshotCreatedAt,
    converterVersion: BENCHLING_MIGRATION_PROJECTION_VERSION,
    destination: fixed.destination,
    destinationEntityId: fixed.destinationEntityId,
  });
  const destinationHash =
    input.location.kind === 'file'
      ? hashProjectionFiles([
          {
            relativePath: input.location.relativePath,
            bytes: await readFile(join(input.run.workspacePath, input.location.relativePath)),
          },
        ])
      : input.location.scientificSha256.slice('sha256:'.length);
  const receipt = projectionReceiptForPlan({
    runId: input.run.id,
    sourceObjectId: input.sourceObject.id,
    plan: {
      ...plan,
      destinationObjectId: fixed.destinationEntityId,
      destinationHash,
    },
    createdAt: input.createdAt,
  });
  return {
    ...receipt,
    retainedDestination: {
      actionId: input.actionId,
      expectedScientificSha256: fixed.expectedPriorImportedHash,
    },
  };
}

function portableDestinationEntityId(run: MigrationRun, databaseEntityId: string): string {
  const rawId = stripWorkspaceScope(databaseEntityId);
  if (scopedProjectionId(run.projectionScopeId, rawId) !== databaseEntityId) {
    throw new Error('Existing destination identity is not scoped to this workspace.');
  }
  return rawId;
}

export function linkedItemRecoveryProgressForAttempt(
  attempt: LinkedItemRecoveryAttempt,
  importDecisions: readonly ImportDecision[] = []
): LinkedItemRecoveryProgress {
  return {
    schema: 'dnaforge.benchling.linked-item-recovery-progress.v1',
    mode: attempt.mode,
    attemptId: attempt.id,
    state: attempt.state,
    selectedFileCount: attempt.selectedFileCount,
    processedFileCount: attempt.processedFileCount,
    recoveredUniqueObjectCount: attempt.recoveredUniqueObjectCount,
    repairedRelationshipCount: attempt.repairedRelationshipCount,
    retainedExistingObjectCount: attempt.retainedExistingObjectCount,
    retainedExistingObjects: attempt.retainedExistingObjects,
    corroboratedExistingObjectCount: attempt.corroboratedExistingObjectCount,
    versionConflictResolution:
      attempt.versionConflictResolution.kind === 'none'
        ? { kind: 'none' }
        : attempt.versionConflictResolution.kind === 'awaiting_choice'
          ? {
              kind: 'awaiting_choice',
              firstConflict: {
                stableId: attempt.versionConflictResolution.firstConflict.stableId,
                name: attempt.versionConflictResolution.firstConflict.name,
              },
            }
          : {
              kind: 'resolved',
              policy: attempt.versionConflictResolution.policy,
              conflictCount: attempt.versionConflictResolution.conflicts.length,
            },
    ...(attempt.pendingImportDecision
      ? { pendingImportDecision: attempt.pendingImportDecision }
      : {}),
    importDecisionSummary: summarizeImportDecisions(importDecisions),
    updatedAt: attempt.updatedAt,
    ...(attempt.safeFailure ? { errorMessage: attempt.safeFailure.message } : {}),
  };
}

function sumPlannedCopyBytes(descriptors: LinkedItemRecoveryAttempt['intakeDescriptors']): number {
  const total = descriptors.reduce((sum, descriptor) => sum + descriptor.plannedCopyBytes, 0);
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error('Linked-item recovery copy size exceeds the safe progress range.');
  }
  return total;
}

function advanceAttempt(
  attempt: LinkedItemRecoveryAttempt,
  changes: Partial<LinkedItemRecoveryAttempt>
): LinkedItemRecoveryAttempt {
  return { ...attempt, ...changes };
}

function transitionAttempt(
  attempt: LinkedItemRecoveryAttempt,
  state: 'parsing' | 'reconciling' | 'validating',
  now: () => string,
  changes: Partial<LinkedItemRecoveryAttempt> = {}
): LinkedItemRecoveryAttempt {
  return advanceAttempt(attempt, {
    ...changes,
    state,
    updatedAt: nextTimestamp(attempt.updatedAt, now()),
  });
}

function requireSnapshot(runId: string, store: MigrationStore) {
  const snapshot = store.getSourceSnapshot(runId);
  if (!snapshot) throw new Error('Linked-item recovery source snapshot is missing.');
  return snapshot;
}

function sortedSourceObjects(objects: ReturnType<MigrationStore['listSourceObjects']>) {
  return [...objects].sort(
    (left, right) => left.stableId.localeCompare(right.stableId) || left.id.localeCompare(right.id)
  );
}

function safeFailureCode(
  state: Exclude<LinkedItemRecoveryAttempt['state'], 'completed' | 'failed'>
): NonNullable<LinkedItemRecoveryAttempt['safeFailure']>['code'] {
  return state === 'copying'
    ? 'copy_failed'
    : state === 'parsing' || state === 'awaiting_conflict_resolution'
      ? 'decode_failed'
      : state === 'reconciling'
        ? 'projection_failed'
        : 'validation_failed';
}

function rejectedFileFailure(error: unknown): LinkedItemRecoverySafeFailure {
  const externalSourceFailure = error instanceof ExternalZipSourceError;
  const copyFailure =
    error instanceof LocalBenchlingExportIntakeError &&
    [
      'local_export_invalid_source_path',
      'local_export_not_regular_file',
      'local_export_source_changed',
      'local_export_too_large',
    ].includes(error.code);
  return {
    code: externalSourceFailure
      ? 'source_unavailable'
      : copyFailure
        ? 'copy_failed'
        : 'unsafe_archive',
    message: externalSourceFailure
      ? 'One selected ZIP is no longer available at its original location or has changed.'
      : copyFailure
        ? 'One selected ZIP could not be copied from its original bytes.'
        : 'One selected file was not accepted as a safe Benchling ZIP export.',
    retryable: true,
  };
}

function countRepairedRelationships(
  resolutions: readonly { relationshipId: string; classification: string }[],
  plan: ValidationLinkedItemRecoveryEvidence
): number {
  const exact = new Set(
    resolutions
      .filter((resolution) => resolution.classification === 'exact')
      .map((resolution) => resolution.relationshipId)
  );
  return plan.targets.reduce(
    (total, target) =>
      total + target.relationshipIds.filter((relationshipId) => exact.has(relationshipId)).length,
    0
  );
}

function completedAttemptEvidence(
  attempt: LinkedItemRecoveryAttempt,
  plan: ValidationLinkedItemRecoveryEvidence | null,
  resolutions: readonly { relationshipId: string; classification: string }[],
  completedAt: string
): ValidationLinkedItemRecoveryAttemptEvidence {
  const recoveredTargetCount = plan
    ? countNewlyRecoveredTargets(resolutions, plan)
    : attempt.recoveredUniqueObjectCount;
  const repairedRelationshipCount = plan
    ? countRepairedRelationships(resolutions, plan)
    : attempt.repairedRelationshipCount;
  const rejectedFileCount = attempt.fileResults.filter(
    (result) => result.outcome === 'rejected'
  ).length;
  return {
    attemptId: attempt.id,
    selectedFileCount: attempt.selectedFileCount,
    acceptedFileCount: attempt.fileResults.filter((result) => result.outcome === 'accepted').length,
    duplicateFileCount: attempt.fileResults.filter((result) => result.outcome === 'duplicate')
      .length,
    rejectedFileCount,
    recoveredTargetCount,
    repairedRelationshipCount,
    outcome: plan
      ? recoveredTargetCount === 0
        ? 'failed'
        : recoveredTargetCount < plan.remainingUniqueObjectCount
          ? 'partial'
          : 'completed'
      : rejectedFileCount === 0
        ? 'completed'
        : rejectedFileCount < attempt.selectedFileCount
          ? 'partial'
          : 'failed',
    completedAt: nextTimestamp(attempt.updatedAt, completedAt),
  };
}

function countNewlyRecoveredTargets(
  resolutions: readonly { relationshipId: string; classification: string }[],
  plan: ValidationLinkedItemRecoveryEvidence
): number {
  const exactRelationshipIds = new Set(
    resolutions
      .filter((resolution) => resolution.classification === 'exact')
      .map((resolution) => resolution.relationshipId)
  );
  return plan.targets.filter(
    (target) =>
      !target.recovered &&
      target.relationshipIds.length > 0 &&
      target.relationshipIds.every((relationshipId) => exactRelationshipIds.has(relationshipId))
  ).length;
}

function recoveredTargetCount(runId: string, store: MigrationStore, attemptId?: string): number {
  return new Set(
    store.listLinkedItemRecoveryCaptures(runId, attemptId).map((capture) => capture.sourceStableId)
  ).size;
}

function linkedItemRecoveryArtifactRecord(input: {
  run: MigrationRun;
  attempt: LinkedItemRecoveryAttempt;
  fileIndex: number;
  sourceSha256: `sha256:${string}`;
  externalSelection?: SelectedExternalZipSource;
  artifact?: VerifiedLocalBenchlingZipExport;
  capturedAt: string;
}): LinkedItemRecoveryArtifact {
  const id = `linked-artifact-${plainSha256(input.sourceSha256).slice(0, 24)}`;
  if (input.externalSelection) {
    return {
      schema: 'dnaforge.benchling.linked-item-recovery-source.v2',
      id,
      runId: input.run.id,
      attemptId: input.attempt.id,
      fileIndex: input.fileIndex,
      externalZipSource: input.externalSelection.source,
      externalZipEntries: input.externalSelection.entries,
    };
  }
  if (!input.artifact) throw new Error('Legacy linked-item ZIP artifact is missing.');
  return {
    schema: 'dnaforge.benchling.linked-item-recovery-artifact.v1',
    id,
    runId: input.run.id,
    attemptId: input.attempt.id,
    fileIndex: input.fileIndex,
    artifact: {
      schema: input.artifact.schema,
      format: 'zip',
      logicalFilename: input.artifact.logicalFilename,
      sha256: input.artifact.sha256,
      sizeBytes: input.artifact.sizeBytes,
      immutableLocalPath: input.artifact.immutableLocalPath,
      capturedAt: input.capturedAt,
      archive: input.artifact.archive,
      resources: [],
    },
  };
}

function verifiedZipArtifact(record: LinkedItemRecoveryArtifact): VerifiedLocalBenchlingZipExport {
  if (record.schema === 'dnaforge.benchling.linked-item-recovery-source.v2') {
    const source = record.externalZipSource;
    return {
      schema: 'dnaforge.benchling.local-export-artifact.v1',
      format: 'zip',
      logicalFilename: source.displayName,
      sha256: source.zipSha256,
      sizeBytes: source.sizeBytes,
      immutableLocalPath: source.originalPath,
      resources: [],
      nativeExportDecoderSource: externalZipDecoderSource(source),
      archive: {
        entryCount: record.externalZipEntries.length,
        totalCompressedEntryBytes: source.sizeBytes,
        totalUncompressedEntryBytes: record.externalZipEntries.reduce(
          (total, entry) => total + entry.sizeBytes,
          0
        ),
      },
    };
  }
  const artifact = record.artifact;
  if (artifact.format !== 'zip' || !artifact.archive) {
    throw new Error('Linked-item recovery artifact is not a verified ZIP.');
  }
  return {
    ...artifact,
    format: 'zip',
    resources: [],
    nativeExportDecoderSource: {
      kind: 'local_path',
      logicalFilename: artifact.logicalFilename,
      localPath: artifact.immutableLocalPath,
      expectedSha256: artifact.sha256,
      expectedSizeBytes: artifact.sizeBytes,
      duplicateSupportEntryPolicy: 'identical_root_benchling_css',
    },
    archive: { ...artifact.archive },
  };
}

function appendUnique(values: readonly string[], value: string): string[] {
  return values.includes(value) ? [...values] : [...values, value];
}

function plainSha256(value: string): string {
  const normalized = value.replace(/^sha256:/u, '').toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw new Error('Invalid SHA-256 evidence.');
  return normalized;
}

function safeEvidenceName(value: string): string {
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 24);
  const extension = extname(value).toLowerCase();
  return `${digest}${/^\.[a-z0-9]{1,10}$/u.test(extension) ? extension : '.bin'}`;
}

function nextTimestamp(previous: string, candidate: string): string {
  const previousMs = Date.parse(previous);
  const candidateMs = Date.parse(candidate);
  if (!Number.isFinite(previousMs) || !Number.isFinite(candidateMs)) {
    throw new Error('Linked-item recovery timestamp is invalid.');
  }
  return new Date(Math.max(candidateMs, previousMs + 1)).toISOString();
}
