import { createHash, randomUUID } from 'node:crypto';
import { access, lstat, readFile, readdir } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import type { RegistryTableMappingDecision } from '../../shared/benchling-registry-table-review';
import type Database from 'better-sqlite3';
import { recoverNativeCatalogRecordsWithDatabaseFence } from '../native-catalog-record-mutations';
import type {
  LocalBenchlingExportIntakeDescriptor,
  MigrationPreflight,
  MigrationRun,
  ValidationReport,
} from '../../shared/benchling-migration';
import {
  importDecisionAnswersPending,
  type ImportDecision,
} from '../../shared/benchling-import-decision';
import { isLocalExportFolderSourceRef } from '../../shared/benchling-migration';
import type { BenchlingMigrationCoordinatorProgress } from '../ipc/benchling-migration';
import { ContentArchive } from './content-archive';
import {
  checkMigrationStorageGate,
  evaluateMigrationStorageGate,
  type MigrationStorageGate,
} from './disk-space';
import { isTerminalMigrationState, transitionMigrationRun } from './state-machine';
import {
  createMigrationStagingWorkspace,
  finalizeUnlockedMigrationRecovery,
  persistMigrationWorkspaceReport,
  unlockMigrationWorkspace,
} from './staging-workspace';
import {
  activeExportLeafJobIds,
  MIGRATION_DATA_DIR,
  migrationDatabasePath,
  openWorkspaceMigrationStore,
  type LinkedItemRecoveryAttemptMode,
  type LinkedItemRecoveryAttempt,
  type MigrationStore,
} from './store';
import type { MigrationRenderCheck } from './validation';
import {
  createLocalBenchlingExportIntakeDescriptor,
  intakeLocalBenchlingExportBundle,
  LocalBenchlingExportIntakeError,
  verifyLocalBenchlingExportIntakeDescriptor,
  type VerifiedLocalBenchlingExportArtifact,
} from './local-export-bundle';
import {
  decodeLocalBenchlingExportBundle,
  prepareLocalBenchlingExportZip,
  type PreparedLocalBenchlingExportZip,
} from './local-export-decoder';
import {
  executeLocalBundleMigration,
  LocalBundleMigrationFailedError,
  LocalBundleMigrationInterruptedError,
  type LocalBundleControlDecision,
  type LocalBundleRenderValidationInput,
} from './local-bundle-executor';
import { traceLocalBundlePhaseTiming } from './local-bundle-performance';
import { buildLocalProjectionPlansInDedicatedWorker } from './local-projection-worker-client';
import {
  linkedItemRecoveryProgressForAttempt,
  recoverLinkedItemsFromLocalExports,
  rollbackFailedAppendForBestEffort,
  resolveRecoveryLocationForRun,
} from './linked-item-recovery-executor';
import { inspectNativeExportArchive } from './native-export-archive';
import { appendBenchlingExportsToWorkspace } from './workspace-append-executor';
import {
  acquireEligibleMigrationWorkspace,
  adoptWorkspaceHistory,
} from './adopt-workspace-history';
import {
  ExternalZipSourceError,
  externalZipDecoderSource,
  selectExternalZipSource,
  verifyExternalZipSource,
  type SelectedExternalZipSource,
} from './external-zip-source';
import {
  acquireWorkspaceMutationShared,
  tryAcquireWorkspaceMutationShared,
} from '../workspace-sync-mutation-lease';
import { drainMainAnalyticsOutbox } from '../analytics';
import {
  enqueueBenchlingMigrationDiscardDisposition,
  reconcileBenchlingMigrationTelemetryOutbox,
} from './telemetry-outbox';

const AUTO_RESUME_RETRY_DELAY_MS = 1_000;
const PROJECTION_CONTRACT_START_OVER_DISPOSITION =
  'start_new_migration_select_original_export' as const;
const RESTART_RECOVERABLE_STATES = new Set<MigrationRun['state']>([
  'export_pending',
  'downloading',
  'parsing',
  'offline_resolution',
  'targeted_reads',
  'projecting',
  'validating',
]);

export type BenchlingMigrationCoordinatorDeps = {
  globalDb: Database.Database;
  managedRootDir: string;
  appVersion?: string;
  telemetry?: import('./telemetry').BenchlingMigrationTelemetry;
  renderValidator: (input: LocalBundleRenderValidationInput) => Promise<MigrationRenderCheck[]>;
  availableBytes?: number | (() => Promise<number>);
  now?: () => string;
  nowMs?: () => number;
  openStore?: (workspacePath: string) => MigrationStore;
  discardWorkspace: (workspaceContainerPath: string) => Promise<void>;
  autoResumeRetryDelayMs?: number;
  intakeLocalBundle?: typeof intakeLocalBenchlingExportBundle;
  selectExternalZip?: typeof selectExternalZipSource;
  planLocalBundle?: typeof createLocalBenchlingExportIntakeDescriptor;
  prepareLocalBundleZip?: typeof prepareLocalBenchlingExportZip;
  buildLocalProjectionPlans?: typeof buildLocalProjectionPlansInDedicatedWorker;
  decodeLocalBundle?: typeof decodeLocalBenchlingExportBundle;
  recoverLinkedItems?: typeof recoverLinkedItemsFromLocalExports;
  appendWorkspaceExports?: typeof appendBenchlingExportsToWorkspace;
};

export class LocalBenchlingMigrationCoordinator {
  private readonly runPaths = new Map<string, string>();
  private readonly controls = new Map<string, LocalBundleControlDecision>();
  private readonly starting = new Map<string, Promise<MigrationRun>>();
  private readonly running = new Map<string, Promise<MigrationRun>>();
  private readonly unlocking = new Map<string, Promise<MigrationRun>>();
  private readonly recoveringLinkedItems = new Map<string, Promise<MigrationRun>>();
  private readonly pendingImportDecisionResolutions = new Map<
    string,
    {
      runId: string;
      resolve: (decision: ImportDecision) => void;
    }
  >();
  private readonly queuedLocalExportOperations = new Set<string>();
  private readonly autoResuming = new Map<string, Promise<void>>();
  private readonly bestEffortRecovering = new Map<string, Promise<MigrationRun>>();
  private readonly heldMigrationMutationLeases = new Set<string>();
  private readonly preparedLocalBundleZips = new Map<
    string,
    {
      identity: string;
      prepared: Promise<PreparedLocalBenchlingExportZip>;
    }
  >();
  private workspaceCreation: Promise<MigrationRun> | null = null;
  private localBundleIntake: Promise<MigrationRun> | null = null;
  private readonly autoResumeSuppressed = new Set<string>();
  private readonly listeners = new Map<
    string,
    Set<(progress: BenchlingMigrationCoordinatorProgress) => void>
  >();

  constructor(private readonly deps: BenchlingMigrationCoordinatorDeps) {}

  async getActiveRun(): Promise<MigrationRun | null> {
    const scannedRuns = await this.scanRuns();
    const discoveredRuns = scannedRuns;
    const anotherImportIsActive = discoveredRuns.some(isCoordinatorActiveRunCandidate);
    for (const candidate of discoveredRuns) {
      if (
        !anotherImportIsActive &&
        hasPendingBestEffortFallback(candidate) &&
        !discoveredRuns.some((run) => run.localBestEffortFallback?.priorRunId === candidate.id)
      ) {
        void this.continueBestEffortImport(candidate).catch((error) => {
          console.error('[benchling-migration] best-effort restart failed', error);
        });
      }
      if (candidate.linkedItemRecovery?.state === 'failed') {
        this.scheduleFailedBestEffortAppendRestart(candidate);
      }
    }
    const runs = discoveredRuns.filter(isCoordinatorActiveRunCandidate);
    if (runs.length > 1) {
      throw new Error(
        'More than one active Benchling migration exists; manual recovery is required.'
      );
    }
    let run = runs[0] ?? discoveredRuns.find(isVisibleNonBlockingLeftover) ?? null;
    if (run?.state === 'draft') run = this.recoverDraftRun(run);
    if (run && !isLocalBundleRun(run) && run.state !== 'ready_to_unlock') {
      run = this.retireUnsupportedProviderRun(run);
    }
    if (run && isPendingLocalBundleIntakeRun(run)) {
      this.scheduleLocalBundleIntakeRecovery(run);
      return run;
    }
    if (run && isActiveLinkedItemRecovery(run)) {
      this.scheduleLinkedItemRecoveryRestart(run);
      return run;
    }
    if (!run || this.running.has(run.id)) return run;

    if (isAutomaticRestartResume(run)) {
      this.scheduleAutomaticRestartResume(run);
      return run;
    }
    if (!RESTART_RECOVERABLE_STATES.has(run.state)) return run;

    const store = this.openStore(run.workspacePath);
    let recovered: MigrationRun;
    let shouldSchedule = false;
    let didPersistRecovery = false;
    try {
      const durable = store.getRun();
      if (!durable) return run;
      if (this.running.has(durable.id)) return durable;
      if (isAutomaticRestartResume(durable)) {
        recovered = durable;
        shouldSchedule = true;
      } else if (!RESTART_RECOVERABLE_STATES.has(durable.state)) {
        recovered = durable;
      } else {
        recovered = transitionMigrationRun(durable, 'paused', this.now(), {
          code: 'migration_interrupted',
          message:
            'DNAForge closed during migration. Reconnecting and resuming from the last durable checkpoint.',
          blocking: false,
        });
        store.saveRun(recovered);
        shouldSchedule = true;
        didPersistRecovery = true;
      }
    } finally {
      store.close();
    }
    if (didPersistRecovery) {
      this.publish(
        recovered,
        'Migration recovered after DNAForge restarted. Reconnecting to resume.'
      );
    }
    if (shouldSchedule) {
      this.scheduleAutomaticRestartResume(recovered);
    }
    return recovered;
  }

  async listRuns(): Promise<MigrationRun[]> {
    return this.scanRuns();
  }

  publishTelemetry(): void {
    for (const [runId, workspacePath] of this.runPaths) {
      let store: MigrationStore | null = null;
      try {
        store = this.openStore(workspacePath);
        reconcileBenchlingMigrationTelemetryOutbox(
          store,
          this.deps.globalDb,
          runId,
          this.deps.telemetry
        );
      } catch (error) {
        console.warn('[benchling-migration] committed telemetry recovery deferred', error);
      } finally {
        store?.close();
      }
    }
    void drainMainAnalyticsOutbox(this.deps.globalDb);
  }

  async getRun(runId: string): Promise<MigrationRun> {
    return this.requireRun(runId);
  }

  importLocalBundle(
    sourcePath: string,
    runId?: string,
    workspaceName?: string,
    reviewedTables?: readonly RegistryTableMappingDecision[],
    localRetryExclusion?: MigrationRun['localRetryExclusion'],
    localBestEffortFallback?: MigrationRun['localBestEffortFallback']
  ): Promise<MigrationRun> {
    if (this.localBundleIntake) {
      return Promise.reject(new Error('A local Benchling export is already being read.'));
    }
    const intakeStartedAt = performance.now();
    const provisional = (
      runId
        ? this.attachLocalBundleIntake(runId, sourcePath, reviewedTables)
        : this.createProvisionalLocalBundleRun(
            sourcePath,
            workspaceName,
            reviewedTables,
            localRetryExclusion,
            localBestEffortFallback
          )
    ).catch((error: unknown) => {
      console.error('[benchling-migration] local export intake failed', error);
      throw new Error(safeLocalIntakeFailureMessage(error));
    });
    const operation = provisional.then(async (run) => {
      const completed = await this.completeLocalBundleIntake(run, false);
      traceLocalBundlePhaseTiming({
        phase: 'intake',
        durationMs: performance.now() - intakeStartedAt,
        itemCount: 1,
      });
      return completed;
    });
    this.localBundleIntake = operation;
    void operation.then(
      () => {
        if (this.localBundleIntake === operation) this.localBundleIntake = null;
      },
      () => {
        if (this.localBundleIntake === operation) this.localBundleIntake = null;
      }
    );
    return provisional;
  }

  async retryLocalBundleWithoutFailedFile(failedRunId: string): Promise<MigrationRun> {
    const failed = await this.requireRun(failedRunId);
    const source = failed.externalZipSource;
    const issue = failed.lastError;
    if (
      failed.state !== 'failed' ||
      failed.scope.kind !== 'file' ||
      failed.workspaceOrigin?.kind !== 'migration_created' ||
      !source ||
      issue?.code !== 'validation_failed' ||
      !issue.sourceObjectId ||
      !issue.sourceFileName
    ) {
      throw new Error('This import has no file-specific retry available.');
    }
    const store = this.openStore(failed.workspacePath);
    let failedEntryPath: string;
    let reviewedTables: RegistryTableMappingDecision[];
    try {
      const object = store.getSourceObject(failed.id, issue.sourceObjectId);
      const entryPath = object?.sourcePath;
      if (
        !entryPath ||
        basename(entryPath.replaceAll('\\', '/')) !== issue.sourceFileName ||
        !failed.externalZipEntries?.some(
          (entry) =>
            entry.entryPath === entryPath &&
            entry.sourceObjectId === issue.sourceObjectId &&
            entry.role === 'source-record'
        )
      ) {
        throw new Error('The failed file cannot be matched to this ZIP.');
      }
      failedEntryPath = entryPath;
      reviewedTables = store
        .listImportDecisions(failed.id, failed.id)
        .filter((decision) => decision.kind === 'registry_table_mapping');
    } finally {
      store.close();
    }
    await verifyExternalZipSource(source);
    const entryPaths = [...(failed.localRetryExclusion?.entryPaths ?? []), failedEntryPath];
    if (new Set(entryPaths).size !== entryPaths.length) {
      throw new Error('This file was already excluded from the prior attempt.');
    }
    if (
      !failed.externalZipEntries?.some(
        (entry) => entry.role === 'source-record' && !entryPaths.includes(entry.entryPath)
      )
    ) {
      throw new Error('There are no other files in this ZIP to import.');
    }
    return this.importLocalBundle(
      source.originalPath,
      undefined,
      failed.displayName,
      reviewedTables,
      {
        zipSha256: source.zipSha256,
        entryPaths,
      }
    );
  }

  async importLocalBundleToWorkspace(
    sourcePath: string,
    workspaceDbId: number,
    reviewedTables?: readonly RegistryTableMappingDecision[],
    options: {
      signal?: AbortSignal;
      assertCurrent?: () => void;
      assertCanWait?: (rootIdentity: string) => void;
    } = {}
  ): Promise<MigrationRun> {
    options.signal?.throwIfAborted();
    if (!/\.zip$/iu.test(sourcePath)) {
      throw new LocalBenchlingExportIntakeError(
        'local_export_unsupported_extension',
        'Benchling migration requires one original ZIP export.'
      );
    }
    const selected = await (this.deps.selectExternalZip ?? selectExternalZipSource)({
      sourcePath,
      selectedAt: this.now(),
    });
    options.signal?.throwIfAborted();
    const acquired = await acquireEligibleMigrationWorkspace(this.deps.globalDb, workspaceDbId, {
      waitForAvailability: true,
      signal: options.signal,
      assertCanWait: options.assertCanWait,
    });
    let releaseTransferred = false;
    try {
      options.signal?.throwIfAborted();
      await verifyExternalZipSource(selected.source);
      acquired.assertCurrent();
      options.signal?.throwIfAborted();
      options.assertCurrent?.();
      const run = await adoptWorkspaceHistory({
        binding: acquired.binding,
        now: this.now,
        appVersion: this.deps.appVersion,
        openStore: this.openStore,
      });
      this.runPaths.set(run.id, run.workspacePath);
      if (this.recoveringLinkedItems.has(run.id)) {
        throw new Error('Benchling exports are already being processed for this migration.');
      }
      const importing = this.trackLocalExportOperation(
        run.id,
        'workspace_append',
        [sourcePath],
        acquired.release,
        true,
        reviewedTables
      );
      releaseTransferred = true;
      return await importing;
    } finally {
      if (!releaseTransferred) acquired.release();
    }
  }

  addLinkedItemExports(
    runId: string,
    sourcePaths: readonly string[],
    reviewedTables?: readonly RegistryTableMappingDecision[]
  ): Promise<MigrationRun> {
    if (sourcePaths.length === 0) {
      return Promise.reject(new Error('Choose at least one Benchling linked-item ZIP export.'));
    }
    if (this.recoveringLinkedItems.has(runId)) {
      return Promise.reject(
        new Error('Linked-item exports are already being processed for this migration.')
      );
    }
    return this.trackLocalExportOperation(
      runId,
      'linked_item_recovery',
      sourcePaths,
      undefined,
      false,
      reviewedTables
    );
  }

  private trackLocalExportOperation(
    runId: string,
    mode: LinkedItemRecoveryAttemptMode,
    sourcePaths: readonly string[],
    onSettled?: () => void,
    mutationLeaseAlreadyHeld = false,
    reviewedTables?: readonly RegistryTableMappingDecision[],
    initialBestEffortFallback?: LinkedItemRecoveryAttempt['bestEffortFallback']
  ): Promise<MigrationRun> {
    let resolveFirstProgress!: (run: MigrationRun) => void;
    const firstProgress = new Promise<MigrationRun>((resolveProgress) => {
      resolveFirstProgress = resolveProgress;
    });
    let observedProgress = false;
    const startAttempt = () => {
      this.queuedLocalExportOperations.delete(runId);
      return this.performLocalExportAttempt(
        runId,
        sourcePaths,
        mode,
        (updated) => {
          if (observedProgress) return;
          observedProgress = true;
          resolveFirstProgress(updated);
        },
        mutationLeaseAlreadyHeld,
        reviewedTables,
        initialBestEffortFallback
      );
    };
    const waitForPrimaryOperation = async (): Promise<void> => {
      const starting = this.starting.get(runId);
      if (starting) await starting;
      const running = this.running.get(runId);
      if (running) await running;
    };
    const waitsForPrimaryOperation = this.starting.has(runId) || this.running.has(runId);
    if (waitsForPrimaryOperation) this.queuedLocalExportOperations.add(runId);
    const rawOperation = waitsForPrimaryOperation
      ? waitForPrimaryOperation().then(startAttempt, (error: unknown) => {
          this.queuedLocalExportOperations.delete(runId);
          throw error;
        })
      : startAttempt();
    const operation = rawOperation.catch(async (error: unknown) => {
      console.error(`[benchling-migration] ${mode} failed`, error);
      return this.requireRun(runId);
    });
    this.recoveringLinkedItems.set(runId, operation);
    const clear = () => {
      this.queuedLocalExportOperations.delete(runId);
      for (const [attemptId, pending] of this.pendingImportDecisionResolutions) {
        if (pending.runId === runId) this.pendingImportDecisionResolutions.delete(attemptId);
      }
      if (this.recoveringLinkedItems.get(runId) === operation) {
        this.recoveringLinkedItems.delete(runId);
      }
      onSettled?.();
    };
    void operation.then(clear, clear);
    return Promise.race([firstProgress, rawOperation]);
  }

  appendWorkspaceExports(
    runId: string,
    sourcePaths: readonly string[],
    reviewedTables?: readonly RegistryTableMappingDecision[]
  ): Promise<MigrationRun> {
    if (sourcePaths.length === 0) {
      return Promise.reject(new Error('Choose at least one Benchling ZIP export to add.'));
    }
    if (this.recoveringLinkedItems.has(runId)) {
      return Promise.reject(
        new Error('Benchling exports are already being processed for this migration.')
      );
    }
    return this.trackLocalExportOperation(
      runId,
      'workspace_append',
      sourcePaths,
      undefined,
      false,
      reviewedTables
    );
  }

  async resolveImportDecision(
    runId: string,
    attemptId: string,
    decision: ImportDecision
  ): Promise<MigrationRun> {
    const run = await this.requireRun(runId);
    const store = this.openStore(run.workspacePath);
    let restartMode: LinkedItemRecoveryAttemptMode | null = null;
    try {
      const attempt = store.getLinkedItemRecoveryAttempt(runId, attemptId);
      if (
        !attempt ||
        attempt.state !== 'awaiting_conflict_resolution' ||
        !attempt.pendingImportDecision ||
        !importDecisionAnswersPending(decision, attempt.pendingImportDecision)
      ) {
        throw new Error('This import is not waiting for that destination choice.');
      }
      store.putImportDecision(runId, attemptId, decision);
      const pending = this.pendingImportDecisionResolutions.get(attemptId);
      if (pending && pending.runId === runId) {
        this.pendingImportDecisionResolutions.delete(attemptId);
        pending.resolve(decision);
      } else {
        restartMode = attempt.mode;
      }
    } finally {
      store.close();
    }
    return restartMode ? this.trackLocalExportOperation(runId, restartMode, []) : run;
  }

  async resolveLinkedItemRecoveryLocation(
    runId: string,
    kind: 'folder' | 'target',
    sourceId: string
  ): Promise<string> {
    const run = await this.requireRun(runId);
    const store = this.openStore(run.workspacePath);
    try {
      return resolveRecoveryLocationForRun(run, store, kind, sourceId);
    } finally {
      store.close();
    }
  }

  private async performLocalExportAttempt(
    runId: string,
    sourcePaths: readonly string[],
    mode: LinkedItemRecoveryAttemptMode,
    onFirstDurableUpdate?: (run: MigrationRun) => void,
    mutationLeaseAlreadyHeld = false,
    reviewedTables?: readonly RegistryTableMappingDecision[],
    initialBestEffortFallback?: LinkedItemRecoveryAttempt['bestEffortFallback']
  ): Promise<MigrationRun> {
    const run = await this.requireRun(runId);
    if (this.running.has(runId) || this.starting.has(runId)) {
      throw new Error('Wait for the current migration phase before adding Benchling exports.');
    }
    const releaseMutation = mutationLeaseAlreadyHeld
      ? null
      : tryAcquireWorkspaceMutationShared(run.workspacePath);
    if (!mutationLeaseAlreadyHeld && !releaseMutation) throw new Error('workspace_busy');
    this.heldMigrationMutationLeases.add(runId);
    const execute =
      mode === 'workspace_append'
        ? (this.deps.appendWorkspaceExports ?? appendBenchlingExportsToWorkspace)
        : (this.deps.recoverLinkedItems ?? recoverLinkedItemsFromLocalExports);
    const store = this.openStore(run.workspacePath);
    try {
      await recoverNativeCatalogRecordsWithDatabaseFence(this.deps.globalDb, run.workspacePath);
      if (initialBestEffortFallback) {
        const prior = store.getLinkedItemRecoveryAttempt(
          runId,
          initialBestEffortFallback.priorAttemptId
        );
        if (
          !prior ||
          prior.state !== 'failed' ||
          store.getActiveLinkedItemRecoveryAttempt(runId) ||
          store.listLinkedItemRecoveryAttempts(runId).at(-1)?.id !== prior.id
        ) {
          throw new Error('The pending file fallback no longer owns this import.');
        }
        await rollbackFailedAppendForBestEffort(run, prior, {
          store,
          destinationDb: this.deps.globalDb,
          assertMutationLeaseHeld: () => {
            if (!this.heldMigrationMutationLeases.has(runId)) {
              throw new Error('workspace_mutation_lease_lost');
            }
          },
        });
      }
      const executeOnce = (bestEffortFallback?: LinkedItemRecoveryAttempt['bestEffortFallback']) =>
        execute(run, sourcePaths, {
          store,
          reviewedTables,
          ...(bestEffortFallback ? { bestEffortFallback } : {}),
          archive: new ContentArchive(join(run.workspacePath, MIGRATION_DATA_DIR, 'archive')),
          now: this.now,
          renderValidator: this.deps.renderValidator,
          persistPassedReport: persistMigrationWorkspaceReport,
          finalizeUnlockedRecovery:
            run.state === 'unlocked'
              ? (updatedRun, report, sourceObjects, receipts, resolutions, actionId) =>
                  finalizeUnlockedMigrationRecovery({
                    run: updatedRun,
                    report,
                    store,
                    sourceObjects,
                    projectionReceipts: receipts,
                    relationshipResolutions: resolutions,
                    actionId,
                    globalDb: this.deps.globalDb,
                    now: this.now,
                    assertMutationLeaseHeld: () => {
                      if (!this.heldMigrationMutationLeases.has(runId)) {
                        throw new Error('workspace_mutation_lease_lost');
                      }
                    },
                  })
              : undefined,
          onRunUpdated: (updated, message) => {
            if (
              updated.linkedItemRecovery?.state === 'failed' &&
              store.listLinkedItemRecoveryAttempts(runId).at(-1)?.safeFailure
                ?.bestEffortFallbackSources
            ) {
              return;
            }
            this.publish(updated, message, store);
            onFirstDurableUpdate?.(updated);
          },
          destinationDb: this.deps.globalDb,
          assertMutationLeaseHeld: () => {
            if (!this.heldMigrationMutationLeases.has(runId)) {
              throw new Error('workspace_mutation_lease_lost');
            }
          },
          resolveImportDecision: ({ runId: conflictRunId, attemptId }) =>
            new Promise<ImportDecision>((resolveDecision, rejectDecision) => {
              if (this.pendingImportDecisionResolutions.has(attemptId)) {
                rejectDecision(
                  new Error('An import-choice prompt is already waiting for this import.')
                );
                return;
              }
              this.pendingImportDecisionResolutions.set(attemptId, {
                runId: conflictRunId,
                resolve: resolveDecision,
              });
            }),
        });
      let bestEffortFallback = initialBestEffortFallback;
      const attemptedIds = new Set<string>();
      for (;;) {
        try {
          return await executeOnce(bestEffortFallback);
        } catch (error) {
          const failed = store.listLinkedItemRecoveryAttempts(runId).at(-1);
          const sources = failed?.safeFailure?.bestEffortFallbackSources;
          if (
            sourcePaths.length === 0 ||
            !failed ||
            failed.state !== 'failed' ||
            !sources ||
            attemptedIds.has(failed.id) ||
            (bestEffortFallback &&
              sources.reduce((total, source) => total + source.entryPaths.length, 0) <=
                bestEffortFallback.sources.reduce(
                  (total, source) => total + source.entryPaths.length,
                  0
                ))
          ) {
            throw error;
          }
          attemptedIds.add(failed.id);
          await rollbackFailedAppendForBestEffort(run, failed, {
            store,
            destinationDb: this.deps.globalDb,
            assertMutationLeaseHeld: () => {
              if (!this.heldMigrationMutationLeases.has(runId)) {
                throw new Error('workspace_mutation_lease_lost');
              }
            },
          });
          bestEffortFallback = { priorAttemptId: failed.id, sources };
        }
      }
    } finally {
      this.heldMigrationMutationLeases.delete(runId);
      store.close();
      releaseMutation?.();
    }
  }

  private async attachLocalBundleIntake(
    runId: string,
    sourcePath: string,
    reviewedTables?: readonly RegistryTableMappingDecision[]
  ): Promise<MigrationRun> {
    if (!/\.zip$/iu.test(sourcePath)) {
      throw new LocalBenchlingExportIntakeError(
        'local_export_unsupported_extension',
        'Folder and Folder Tree migration requires one Benchling ZIP export.'
      );
    }
    const selectedAt = this.now();
    const intakeDescriptor = await (
      this.deps.planLocalBundle ?? createLocalBenchlingExportIntakeDescriptor
    )({ sourcePath, selectedAt });
    if (intakeDescriptor.format !== 'zip') {
      throw new Error('Folder and Folder Tree migration accepts only a Benchling ZIP export.');
    }
    return this.persistLocalBundleIntake(runId, intakeDescriptor, reviewedTables);
  }

  private async persistLocalBundleIntake(
    runId: string,
    intakeDescriptor: LocalBenchlingExportIntakeDescriptor,
    reviewedTables?: readonly RegistryTableMappingDecision[]
  ): Promise<MigrationRun> {
    const requested = await this.requireRun(runId);
    const effectiveState = interruptedResumeState(requested);
    if (
      !isLocalBundleFolderScope(requested.scope) ||
      requested.binding !== null ||
      effectiveState !== 'scope_planning'
    ) {
      throw new Error(
        'Choose a ZIP only for an existing provider-free Folder or Folder Tree run that is waiting for selection.'
      );
    }
    if (hasCompletedLocalSource(requested) || requested.localExportIntake) {
      throw new Error('This migration already accepted a local Benchling export.');
    }

    if (intakeDescriptor.format !== 'zip') {
      throw new Error('Folder and Folder Tree migration accepts only a Benchling ZIP export.');
    }
    const selectedAt = intakeDescriptor.selectedAt;

    const store = this.openStore(requested.workspacePath);
    let provisional: MigrationRun;
    try {
      const durable = store.getRun();
      if (
        !durable ||
        durable.id !== requested.id ||
        !isDeepStrictEqual(durable.scope, requested.scope) ||
        durable.binding !== null ||
        interruptedResumeState(durable) !== 'scope_planning' ||
        durable.localExportIntake ||
        hasCompletedLocalSource(durable)
      ) {
        throw new Error('The folder migration changed before the selected ZIP could be accepted.');
      }
      const planning =
        durable.state === 'scope_planning'
          ? durable
          : transitionMigrationRun(durable, 'scope_planning', selectedAt);
      provisional = {
        ...planning,
        localExportIntake: intakeDescriptor,
        updatedAt: selectedAt,
        lastError: null,
      };
      store.saveRunWithImportDecisions(provisional, reviewedTables ?? []);
    } finally {
      store.close();
    }
    this.publishLocalBundleIntakeProgress(provisional, 0, intakeDescriptor.plannedCopyBytes);
    return provisional;
  }

  private createProvisionalLocalBundleRun(
    sourcePath: string,
    workspaceName?: string,
    reviewedTables?: readonly RegistryTableMappingDecision[],
    localRetryExclusion?: MigrationRun['localRetryExclusion'],
    localBestEffortFallback?: MigrationRun['localBestEffortFallback']
  ): Promise<MigrationRun> {
    return this.reserveWorkspaceCreation(() =>
      this.createProvisionalLocalBundleRunUnreserved(
        sourcePath,
        workspaceName,
        reviewedTables,
        localRetryExclusion,
        localBestEffortFallback
      )
    );
  }

  private async createProvisionalLocalBundleRunUnreserved(
    sourcePath: string,
    workspaceName?: string,
    reviewedTables?: readonly RegistryTableMappingDecision[],
    localRetryExclusion?: MigrationRun['localRetryExclusion'],
    localBestEffortFallback?: MigrationRun['localBestEffortFallback']
  ): Promise<MigrationRun> {
    if (!/\.zip$/iu.test(sourcePath)) {
      throw new LocalBenchlingExportIntakeError(
        'local_export_unsupported_extension',
        'Benchling migration requires one original ZIP export.'
      );
    }
    return this.createProvisionalLocalWorkspaceRunFromZip(
      sourcePath,
      workspaceName,
      reviewedTables,
      localRetryExclusion,
      localBestEffortFallback
    );
  }

  private async createProvisionalLocalWorkspaceRunFromZip(
    sourcePath: string,
    workspaceName?: string,
    reviewedTables?: readonly RegistryTableMappingDecision[],
    localRetryExclusion?: MigrationRun['localRetryExclusion'],
    localBestEffortFallback?: MigrationRun['localBestEffortFallback']
  ): Promise<MigrationRun> {
    const existing = await this.getActiveRun();
    if (existing && isCoordinatorActiveRunCandidate(existing)) {
      throw new LocalBenchlingExportIntakeError(
        'local_export_migration_already_active',
        `Migration ${existing.id} is already active.`
      );
    }

    const provisionalScope: MigrationRun['scope'] = {
      version: 1,
      kind: 'file',
      acquisition: 'local_bundle',
      source: {
        id: `local-export-pending-${randomUUID()}`,
        url: 'urn:dnaforge:benchling-local-export:pending',
        objectType: 'notebook',
      },
    };
    const extension = extname(sourcePath);
    const displayName =
      workspaceName ?? (basename(sourcePath, extension) || 'Benchling notebook import');
    const selectedAt = this.now();
    const intakeDescriptor = await (
      this.deps.planLocalBundle ?? createLocalBenchlingExportIntakeDescriptor
    )({ sourcePath, selectedAt });
    if (intakeDescriptor.format !== 'zip') {
      throw new Error('Folder and Folder Tree migration accepts only a Benchling ZIP export.');
    }
    const created = await createMigrationStagingWorkspace({
      scope: provisionalScope,
      displayName,
      localExportIntake: intakeDescriptor,
      localRetryExclusion,
      localBestEffortFallback,
      reviewedTables,
      deps: {
        managedRootDir: this.deps.managedRootDir,
        globalDb: this.deps.globalDb,
        appVersion: this.deps.appVersion,
        now: this.now,
        openStore: this.openStore,
      },
    });
    this.runPaths.set(created.id, created.workspacePath);

    return created;
  }

  private async completeLocalBundleIntake(
    provisional: MigrationRun,
    restarting: boolean
  ): Promise<MigrationRun> {
    const descriptor = provisional.localExportIntake;
    if (!isPendingLocalBundleIntakeRun(provisional) || !descriptor) {
      return this.failLocalBundleIntake(
        provisional,
        'The provisional local export restart authority is missing or invalid.'
      );
    }
    try {
      const newLayout = provisional.workspaceOrigin !== undefined;
      if (restarting && !newLayout) {
        await new ContentArchive(
          join(provisional.workspacePath, MIGRATION_DATA_DIR, 'archive')
        ).cleanupIncomingBlobs();
      }
      await verifyLocalBenchlingExportIntakeDescriptor(descriptor);
      let externalSelection: SelectedExternalZipSource | undefined;
      let verified: VerifiedLocalBenchlingExportArtifact | undefined;
      if (newLayout) {
        externalSelection = await (this.deps.selectExternalZip ?? selectExternalZipSource)({
          sourcePath: descriptor.sourcePath,
          selectedAt: descriptor.selectedAt,
        });
      } else {
        const gate = await this.evaluateLocalStorageGate(provisional.workspacePath, {
          compressedArchiveBytes: descriptor.plannedCopyBytes,
          declaredUncompressedBytes: 0,
          projectedObjectBytes: 0,
          largestTemporaryBytes: descriptor.plannedCopyBytes,
        });
        if (!gate.allowed) {
          return this.failLocalBundleIntake(
            provisional,
            'The destination does not have enough free space to copy this local export.',
            'insufficient_storage'
          );
        }
        verified = await (this.deps.intakeLocalBundle ?? intakeLocalBenchlingExportBundle)({
          workspacePath: provisional.workspacePath,
          sourcePath: descriptor.sourcePath,
          expectedDescriptor: descriptor,
          onProgress: ({ copiedBytes, totalBytes }) =>
            this.publishLocalBundleIntakeProgress(provisional, copiedBytes, totalBytes),
        });
      }
      const capturedAt = this.now();
      if (isLocalBundleFolderScope(provisional.scope) && verified?.format === 'html') {
        throw new Error('Folder and Folder Tree migration accepts only a Benchling ZIP export.');
      }
      const sourceSha256 = externalSelection?.source.zipSha256 ?? verified?.sha256;
      if (!sourceSha256) throw new Error('Local ZIP source evidence is missing.');
      if (
        provisional.localRetryExclusion &&
        sourceSha256 !== provisional.localRetryExclusion.zipSha256
      ) {
        throw new Error('The original ZIP changed before the retry could start.');
      }
      if (
        provisional.localBestEffortFallback &&
        sourceSha256 !== provisional.localBestEffortFallback.zipSha256
      ) {
        throw new Error('The original ZIP changed before best-effort import could continue.');
      }
      const digest = sourceSha256.slice('sha256:'.length);
      const scope: MigrationRun['scope'] =
        provisional.scope.kind === 'file'
          ? {
              version: 1,
              kind: 'file',
              acquisition: 'local_bundle',
              source: {
                id: `local-export-${digest}`,
                url: `urn:dnaforge:benchling-local-export:sha256:${digest}`,
                objectType: 'notebook',
              },
            }
          : provisional.scope;
      const store = this.openStore(provisional.workspacePath);
      let completed: MigrationRun;
      try {
        const durable = store.getRun();
        if (
          !durable ||
          !isPendingLocalBundleIntakeRun(durable) ||
          !isDeepStrictEqual(durable.localExportIntake, descriptor)
        ) {
          throw new Error('The provisional local export changed while its copy was running.');
        }
        const { localExportIntake: _completedIntake, ...withoutIntake } = durable;
        completed = {
          ...withoutIntake,
          scope,
          baseline: {
            kind: 'initial_import',
            sourceArtifactId: sourceSha256,
          },
          ...(externalSelection
            ? {
                externalZipSource: externalSelection.source,
                externalZipEntries: externalSelection.entries,
              }
            : verified
              ? {
                  localExportArtifact: {
                    schema: verified.schema,
                    format: verified.format,
                    logicalFilename: verified.logicalFilename,
                    sha256: verified.sha256,
                    sizeBytes: verified.sizeBytes,
                    immutableLocalPath: verified.immutableLocalPath,
                    capturedAt,
                    archive: verified.archive,
                    resources: verified.resources,
                  },
                }
              : {}),
          updatedAt: capturedAt,
        };
        if (completed.scope.kind === 'file') {
          completed = transitionMigrationRun(completed, 'identity_confirmation', capturedAt);
          store.saveRun(completed);
          completed = transitionMigrationRun(completed, 'scope_planning', capturedAt);
          store.saveRun(completed);
        } else {
          store.saveRun(completed);
        }
      } finally {
        store.close();
      }
      this.publish(completed, 'Local Benchling export verified. Importing.');
      this.autoRunVerifiedLocalExport(completed);
      return completed;
    } catch (error) {
      return this.failLocalBundleIntake(
        provisional,
        safeLocalIntakeFailureMessage(error),
        error instanceof ExternalZipSourceError ? 'source_unavailable' : 'migration_interrupted'
      );
    }
  }

  private autoRunVerifiedLocalExport(run: MigrationRun): void {
    if (!(run.externalZipSource && run.scope.kind === 'file')) {
      if (!isLocalBundleFolderScope(run.scope)) return;
      const root = run.scope.kind === 'folder' ? run.scope.folder : run.scope.roots[0];
      if (!root || !isLocalExportFolderSourceRef(root)) return;
    }
    if (interruptedResumeState(run) !== 'scope_planning') return;
    void (async () => {
      try {
        const preflightStartedAt = performance.now();
        await this.preflight(run.id);
        traceLocalBundlePhaseTiming({
          phase: 'preflight',
          durationMs: performance.now() - preflightStartedAt,
          itemCount: 1,
        });
        await this.start(run.id);
      } catch (error) {
        console.error('[benchling-migration] automatic local import failed', error);
      }
    })();
  }

  private failLocalBundleIntake(
    provisional: MigrationRun,
    message: string,
    code:
      | 'migration_interrupted'
      | 'insufficient_storage'
      | 'source_unavailable' = 'migration_interrupted'
  ): MigrationRun {
    const store = this.openStore(provisional.workspacePath);
    try {
      const durable = store.getRun();
      if (!durable || durable.id !== provisional.id) {
        throw new Error(`Benchling migration ${provisional.id} does not exist.`);
      }
      if (!isPendingLocalBundleIntakeRun(durable)) return durable;
      const { localExportIntake: _abandonedIntake, ...withoutIntake } = durable;
      const failed = transitionMigrationRun(withoutIntake, 'failed', this.now(), {
        code,
        message,
        blocking: true,
      });
      store.saveRun(failed);
      this.publish(failed, failed.lastError?.message);
      return failed;
    } finally {
      store.close();
    }
  }

  private publishLocalBundleIntakeProgress(
    run: MigrationRun,
    copiedBytes: number,
    totalBytes: number
  ): void {
    const progress: BenchlingMigrationCoordinatorProgress = {
      run,
      message: `Copying selected export: ${copiedBytes} of ${totalBytes} bytes.`,
      completedItems: copiedBytes,
      totalItems: totalBytes,
      warnings: [],
    };
    for (const listener of this.listeners.get(run.id) ?? []) {
      try {
        listener(progress);
      } catch {}
    }
  }

  async preflight(runId: string): Promise<MigrationPreflight> {
    return this.preflightLocalBundle(await this.requireRun(runId));
  }

  private async preflightLocalBundle(run: MigrationRun): Promise<MigrationPreflight> {
    if (run.externalZipSource) await verifyExternalZipSource(run.externalZipSource);
    const artifact = verifiedLocalBundleArtifact(run);
    const effectiveState =
      run.state === 'paused' ||
      run.state === 'action_required' ||
      run.state === 'cancelled_preserved'
        ? run.resumeState
        : run.state;
    if (effectiveState !== 'scope_planning') {
      throw new Error(
        `Local export preflight requires scope_planning; current state is ${run.state}.`
      );
    }
    const resourceBytes = artifact.resources.reduce((total, resource) => {
      const next = total + resource.sizeBytes;
      if (!Number.isSafeInteger(next)) throw new Error('Local export resource size is too large.');
      return next;
    }, 0);
    const declaredBytes = run.externalZipSource
      ? externalEntryBytes(run)
      : (artifact.archive?.totalUncompressedEntryBytes ?? artifact.sizeBytes + resourceBytes);
    const gate = await this.evaluateLocalStorageGate(run.workspacePath, {
      compressedArchiveBytes: run.externalZipSource ? 0 : artifact.sizeBytes,
      declaredUncompressedBytes: declaredBytes,
      projectedObjectBytes: declaredBytes,
      largestTemporaryBytes: Math.max(artifact.sizeBytes, declaredBytes),
    });
    const preparedZip =
      run.scope.kind === 'folder' ? await this.prepareLocalBundleZipReview(run) : undefined;
    const contentPlan = await plannedLocalBundleContentPlan(run, preparedZip);
    return {
      runId: run.id,
      binding: null,
      scope: run.scope,
      plannedActions: [],
      plannedContentFamilies: contentPlan.plannedContentFamilies,
      oneHopDisclosure: contentPlan.oneHopDisclosure,
      selectedRootIds:
        run.scope.kind === 'file'
          ? [run.scope.source.id]
          : run.scope.kind === 'folder'
            ? [run.scope.folder.id]
            : run.scope.roots.map((root) => root.id),
      includedFolderIds:
        run.scope.kind === 'folder'
          ? [run.scope.folder.id]
          : run.scope.kind === 'folder_tree'
            ? run.scope.roots.map((root) => root.id)
            : [],
      excludedDirectChildFolderIds: [],
      requiredBytes: gate.requiredBytes,
      availableBytes: gate.availableBytes,
      storageAllowed: gate.allowed,
      issue: gate.issue,
    };
  }

  private prepareLocalBundleZipReview(run: MigrationRun): Promise<PreparedLocalBenchlingExportZip> {
    const artifact = verifiedLocalBundleArtifact(run);
    if (artifact.format !== 'zip' || run.scope.kind !== 'folder') {
      return Promise.reject(
        new Error('A reusable local ZIP review requires one Direct Folder ZIP run.')
      );
    }
    const identity = localBundlePreparationIdentity(run);
    const cached = this.preparedLocalBundleZips.get(run.id);
    if (cached?.identity === identity) return cached.prepared;
    const prepare = this.deps.prepareLocalBundleZip ?? prepareLocalBenchlingExportZip;
    const prepared = prepare({
      artifact,
      archive: new ContentArchive(join(run.workspacePath, MIGRATION_DATA_DIR, 'archive')),
      ...(run.externalZipSource
        ? {
            externalZipSource: run.externalZipSource,
            externalZipEntries: run.externalZipEntries,
          }
        : {}),
      capturedAt: localSourceTimestamp(run),
      scope: run.scope,
    });
    this.preparedLocalBundleZips.set(run.id, { identity, prepared });
    void prepared.catch(() => {
      const current = this.preparedLocalBundleZips.get(run.id);
      if (current?.prepared === prepared) this.preparedLocalBundleZips.delete(run.id);
    });
    return prepared;
  }

  private cachedLocalBundleZipReview(
    run: MigrationRun
  ): Promise<PreparedLocalBenchlingExportZip> | undefined {
    const cached = this.preparedLocalBundleZips.get(run.id);
    return cached?.identity === localBundlePreparationIdentity(run) ? cached.prepared : undefined;
  }

  private async evaluateLocalStorageGate(
    workspacePath: string,
    estimate: Parameters<typeof evaluateMigrationStorageGate>[0]
  ): Promise<MigrationStorageGate> {
    const availableBytes = this.deps.availableBytes;
    if (typeof availableBytes === 'number') {
      return evaluateMigrationStorageGate(estimate, availableBytes);
    }
    if (typeof availableBytes === 'function') {
      return evaluateMigrationStorageGate(estimate, await availableBytes());
    }
    return checkMigrationStorageGate(workspacePath, estimate);
  }

  start(runId: string): Promise<MigrationRun> {
    return this.startAuthorized(runId, false);
  }

  private startAuthorized(runId: string, allowInterrupted: boolean): Promise<MigrationRun> {
    const pendingStart = this.starting.get(runId);
    if (pendingStart) return pendingStart;
    if (this.running.has(runId)) return this.requireRun(runId);

    const pending = this.startSingleFlight(runId, allowInterrupted);
    this.starting.set(runId, pending);
    void pending.then(
      () => {
        if (this.starting.get(runId) === pending) this.starting.delete(runId);
      },
      () => {
        if (this.starting.get(runId) === pending) this.starting.delete(runId);
      }
    );
    return pending;
  }

  private async startSingleFlight(runId: string, allowInterrupted: boolean): Promise<MigrationRun> {
    const startingRun = await this.requireRun(runId);
    if (
      !allowInterrupted &&
      (startingRun.state === 'paused' ||
        startingRun.state === 'cancelled_preserved' ||
        startingRun.state === 'action_required')
    ) {
      throw new Error('Interrupted migrations must continue through the explicit Resume action.');
    }
    let resolveStarted!: (run: MigrationRun) => void;
    const started = new Promise<MigrationRun>((resolve) => {
      resolveStarted = resolve;
    });
    let observedFirstTransition = false;
    const operation = this.execute(runId, (updated) => {
      if (observedFirstTransition || updated.state === startingRun.state) return;
      observedFirstTransition = true;
      resolveStarted(updated);
    })
      .then((completed) => this.continueBestEffortImport(completed))
      .catch(async (error: unknown) => {
        console.error('[benchling-migration] execution failed', error);
        const current = await this.requireRun(runId);
        if (isTerminalMigrationState(current.state)) {
          return current;
        }
        const failed = transitionMigrationRun(current, 'failed', this.now(), {
          code: 'internal_invariant',
          message: 'Migration execution failed internally.',
          blocking: true,
        });
        const store = this.openStore(current.workspacePath);
        try {
          store.saveRun(failed);
        } finally {
          store.close();
        }
        this.publish(failed, 'Migration failed because an internal invariant was violated.');
        return failed;
      });
    this.running.set(runId, operation);
    void operation.finally(() => {
      this.running.delete(runId);
      this.controls.delete(runId);
    });
    return Promise.race([started, operation]);
  }

  async pause(runId: string): Promise<MigrationRun> {
    const run = await this.requireRun(runId);
    if (!this.running.has(runId) && !this.starting.has(runId)) {
      throw new Error('Migration is not currently running.');
    }
    this.controls.set(runId, 'pause');
    this.publish(run, 'Pause requested. Finishing the current atomic operation.');
    return run;
  }

  async resume(runId: string): Promise<MigrationRun> {
    const run = await this.requireRun(runId);
    if (run.state === 'failed') {
      if (
        run.lastError?.code !== 'internal_invariant' ||
        run.scope.acquisition !== 'local_bundle' ||
        !migrationRunHasZipSource(run)
      ) {
        throw new Error('This failed migration cannot retry from preserved local evidence.');
      }
      const retryRun: MigrationRun = {
        ...run,
        state: 'parsing',
        resumeState: null,
        updatedAt: this.now(),
        unlockedAt: null,
        lastError: null,
      };
      const store = this.openStore(run.workspacePath);
      try {
        store.restoreFailedLocalRunForRetry({ failedRun: run, retryRun });
      } finally {
        store.close();
      }
      this.publish(retryRun, 'Retrying from the preserved ZIP and verified migration evidence.');
      return this.startAuthorized(runId, false);
    }
    if (
      run.state !== 'paused' &&
      run.state !== 'cancelled_preserved' &&
      run.state !== 'action_required'
    ) {
      throw new Error(`Migration cannot resume from state ${run.state}.`);
    }
    if (
      run.state === 'action_required' &&
      run.lastError?.code === 'projection_contract_restart_required'
    ) {
      throw new Error(run.lastError.message);
    }
    return this.startAuthorized(runId, true);
  }

  async cancelPreserved(runId: string): Promise<MigrationRun> {
    const run = await this.requireRun(runId);
    if (this.running.has(runId) || this.starting.has(runId)) {
      this.controls.set(runId, 'cancel_preserved');
      this.publish(run, 'Cancel requested. Captured evidence will be retained.');
      return run;
    }
    if (run.state === 'cancelled_preserved') return run;
    if (run.state !== 'paused' && run.state !== 'action_required') {
      throw new Error('Migration is not running or durably interrupted.');
    }
    const cancelled = transitionMigrationRun(run, 'cancelled_preserved', this.now(), run.lastError);
    const store = this.openStore(run.workspacePath);
    try {
      store.saveRun(cancelled);
    } finally {
      store.close();
    }
    this.publish(cancelled, 'Migration cancelled with captured evidence preserved.');
    return cancelled;
  }

  async startOverPreserved(runId: string): Promise<MigrationRun> {
    const run = await this.requireRun(runId);
    if (
      run.state !== 'action_required' ||
      run.lastError?.code !== 'projection_contract_restart_required'
    ) {
      throw new Error('Only an incompatible projection-contract run can start over this way.');
    }
    if (this.running.has(runId) || this.starting.has(runId)) {
      throw new Error('Migration execution must stop before starting a new migration.');
    }
    const reason = run.lastError.details?.reason;
    const failed = transitionMigrationRun(run, 'failed', this.now(), {
      code: 'projection_contract_restart_required',
      message:
        'This locked migration was preserved and ended. Start a new migration and select the same original Benchling export again.',
      blocking: true,
      details: {
        ...(typeof reason === 'string' ? { reason } : {}),
        recoveryDisposition: PROJECTION_CONTRACT_START_OVER_DISPOSITION,
      },
    });
    const store = this.openStore(run.workspacePath);
    try {
      store.saveRun(failed);
    } finally {
      store.close();
    }
    this.autoResumeSuppressed.add(runId);
    this.publish(
      failed,
      'Locked migration preserved. Select the same original export in a new migration.'
    );
    return failed;
  }

  async getReport(
    runId: string,
    options: { preserveRunState?: boolean } = {}
  ): Promise<ValidationReport | null> {
    const run = options.preserveRunState
      ? (await this.scanRuns()).find((candidate) => candidate.id === runId)
      : await this.requireRun(runId);
    if (!run) throw new Error(`Benchling migration ${runId} does not exist.`);
    const store = this.openStore(run.workspacePath);
    try {
      return store.getValidationReport(runId);
    } finally {
      store.close();
    }
  }

  unlock(runId: string): Promise<MigrationRun> {
    const activeUnlock = this.unlocking.get(runId);
    if (activeUnlock) return activeUnlock;

    const operation = this.unlockSingleFlight(runId);
    this.unlocking.set(runId, operation);
    void operation.then(
      () => {
        if (this.unlocking.get(runId) === operation) this.unlocking.delete(runId);
      },
      () => {
        if (this.unlocking.get(runId) === operation) this.unlocking.delete(runId);
      }
    );
    return operation;
  }

  private async unlockSingleFlight(runId: string): Promise<MigrationRun> {
    if (this.recoveringLinkedItems.has(runId) && !this.queuedLocalExportOperations.has(runId)) {
      throw new Error('Wait for linked-item recovery to finish before opening the notebook.');
    }
    const run = await this.requireRun(runId);
    const alreadyHeld = this.heldMigrationMutationLeases.has(runId);
    const releaseMutation = alreadyHeld
      ? null
      : tryAcquireWorkspaceMutationShared(run.workspacePath);
    if (!alreadyHeld && !releaseMutation) throw new Error('workspace_busy');
    if (!alreadyHeld) this.heldMigrationMutationLeases.add(runId);
    try {
      await unlockMigrationWorkspace({
        workspacePath: run.workspacePath,
        globalDb: this.deps.globalDb,
        now: this.now,
        openStore: this.openStore,
        assertMutationLeaseHeld: () => {
          if (!this.heldMigrationMutationLeases.has(runId)) {
            throw new Error('workspace_mutation_lease_lost');
          }
        },
      });
    } finally {
      if (!alreadyHeld) this.heldMigrationMutationLeases.delete(runId);
      releaseMutation?.();
    }
    const unlocked = await this.requireRun(runId);
    this.publish(unlocked, 'Migration validated and project unlocked.');
    return unlocked;
  }

  async discard(runId: string): Promise<void> {
    if (
      this.running.has(runId) ||
      this.starting.has(runId) ||
      this.unlocking.has(runId) ||
      this.recoveringLinkedItems.has(runId) ||
      this.localBundleIntake
    ) {
      throw new Error('Cancel the active migration before discarding it.');
    }
    const run = await this.requireRun(runId);
    if (run.workspaceOrigin?.kind === 'adopted_existing') {
      throw new Error('Adopted workspace history cannot discard its owning workspace.');
    }
    const expectedPath = resolve(this.deps.managedRootDir, run.workspaceId, 'repo');
    if (resolve(run.workspacePath) !== expectedPath) {
      throw new Error('Migration workspace is outside the managed migration root.');
    }
    const store = this.openStore(run.workspacePath);
    let priorOutcome: import('./telemetry').BenchlingMigrationOutcome | null = null;
    try {
      const receipts = store.listMigrationTelemetryTerminalReceipts(run.id);
      priorOutcome = receipts.at(-1)?.outcome ?? null;
      try {
        reconcileBenchlingMigrationTelemetryOutbox(
          store,
          this.deps.globalDb,
          run.id,
          this.deps.telemetry
        );
      } catch (error) {
        console.warn('[benchling-migration] telemetry outbox reconciliation deferred', error);
      }
    } finally {
      store.close();
    }
    await this.deps.discardWorkspace(dirname(expectedPath));
    if (priorOutcome) {
      enqueueBenchlingMigrationDiscardDisposition(this.deps.globalDb, priorOutcome, this.nowMs);
      drainMainAnalyticsOutbox(this.deps.globalDb);
    }
    this.runPaths.delete(runId);
    this.preparedLocalBundleZips.delete(runId);
    this.controls.delete(runId);
    this.autoResumeSuppressed.add(runId);
    this.listeners.delete(runId);
  }

  subscribeProgress(
    runId: string,
    listener: (progress: BenchlingMigrationCoordinatorProgress) => void
  ): () => void {
    const listeners = this.listeners.get(runId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(runId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(runId);
    };
  }

  private async execute(
    runId: string,
    onRunUpdated?: (run: MigrationRun) => void
  ): Promise<MigrationRun> {
    const run = await this.requireRun(runId);
    const releaseMutation = tryAcquireWorkspaceMutationShared(run.workspacePath);
    if (!releaseMutation) throw new Error('workspace_busy');
    this.heldMigrationMutationLeases.add(runId);
    try {
      await recoverNativeCatalogRecordsWithDatabaseFence(this.deps.globalDb, run.workspacePath);
      return await this.executeWithHeldMutationLease(run, onRunUpdated);
    } finally {
      this.heldMigrationMutationLeases.delete(runId);
      releaseMutation();
    }
  }

  private async executeWithHeldMutationLease(
    run: MigrationRun,
    onRunUpdated?: (run: MigrationRun) => void
  ): Promise<MigrationRun> {
    const runId = run.id;
    if (!isLocalBundleRun(run)) {
      throw new Error('Only local Benchling export runs are supported.');
    }
    {
      const effectiveState =
        run.state === 'paused' ||
        run.state === 'action_required' ||
        run.state === 'cancelled_preserved'
          ? run.resumeState
          : run.state;
      if (effectiveState === 'scope_planning') {
        const preflight = await this.preflightLocalBundle(run);
        if (!preflight.storageAllowed) {
          const issue =
            preflight.issue ??
            ({
              code: 'insufficient_storage',
              message: 'There is not enough free space to import this local Benchling export.',
              blocking: true,
            } satisfies NonNullable<MigrationPreflight['issue']>);
          const failed = transitionMigrationRun(run, 'failed', this.now(), issue);
          const store = this.openStore(run.workspacePath);
          try {
            store.saveRun(failed);
            this.publish(failed, issue.message, store);
          } finally {
            store.close();
          }
          onRunUpdated?.(failed);
          return failed;
        }
      }
      const preparedZip =
        run.scope.kind === 'folder' ? await this.cachedLocalBundleZipReview(run) : undefined;
      const decodeLocalBundle = this.deps.decodeLocalBundle ?? decodeLocalBenchlingExportBundle;
      const store = this.openStore(run.workspacePath);
      let unlockOnPass = false;
      const completed = await (async () => {
        try {
          const result = await executeLocalBundleMigration(run, {
            store,
            destinationDb: this.deps.globalDb,
            archive: new ContentArchive(join(run.workspacePath, MIGRATION_DATA_DIR, 'archive')),
            now: this.now,
            checkpoint: () => this.controls.get(runId) ?? 'continue',
            renderValidator: this.deps.renderValidator,
            persistPassedReport: persistMigrationWorkspaceReport,
            onPhaseTiming: traceLocalBundlePhaseTiming,
            ...(preparedZip
              ? {
                  decode: (input) => decodeLocalBundle({ ...input, preparedZip }),
                  preparedZip,
                  projectionPlanner:
                    this.deps.buildLocalProjectionPlans ??
                    buildLocalProjectionPlansInDedicatedWorker,
                }
              : {}),
            onRunUpdated: (updated) => {
              if (!hasPendingBestEffortFallback(updated)) {
                this.publish(updated, undefined, store);
              }
              onRunUpdated?.(updated);
            },
          });
          unlockOnPass = result.report.passed && result.run.state === 'ready_to_unlock';
          return result.run;
        } catch (error) {
          if (
            error instanceof LocalBundleMigrationFailedError ||
            error instanceof LocalBundleMigrationInterruptedError
          ) {
            return error.run;
          }
          throw error;
        } finally {
          store.close();
          this.preparedLocalBundleZips.delete(runId);
        }
      })();
      if (!unlockOnPass) return completed;
      const unlocked = await this.unlock(runId);
      onRunUpdated?.(unlocked);
      return unlocked;
    }
  }

  private continueBestEffortImport(failed: MigrationRun): Promise<MigrationRun> {
    if (!hasPendingBestEffortFallback(failed)) return Promise.resolve(failed);
    const existing = this.bestEffortRecovering.get(failed.id);
    if (existing) return existing;
    const operation = this.continueBestEffortImportOnce(failed);
    this.bestEffortRecovering.set(failed.id, operation);
    const clear = () => {
      if (this.bestEffortRecovering.get(failed.id) === operation) {
        this.bestEffortRecovering.delete(failed.id);
      }
    };
    void operation.then(clear, clear);
    return operation;
  }

  private async continueBestEffortImportOnce(failed: MigrationRun): Promise<MigrationRun> {
    const pendingPaths = pendingBestEffortEntryPaths(failed);
    if (pendingPaths.length === 0) return failed;
    try {
      const source = failed.externalZipSource;
      if (
        failed.state !== 'failed' ||
        failed.scope.kind !== 'file' ||
        failed.workspaceOrigin?.kind !== 'migration_created' ||
        !source ||
        pendingPaths.some(
          (entryPath) =>
            !failed.externalZipEntries?.some(
              (entry) => entry.entryPath === entryPath && entry.role === 'source-record'
            )
        )
      ) {
        throw new Error('File-local fallback evidence no longer matches this import.');
      }
      await verifyExternalZipSource(source);
      const priorPaths = failed.localBestEffortFallback?.entryPaths ?? [];
      if (
        failed.localBestEffortFallback?.zipSha256 !== undefined &&
        failed.localBestEffortFallback.zipSha256 !== source.zipSha256
      ) {
        throw new Error('The original ZIP changed before file fallback.');
      }
      const entryPaths = [...new Set([...priorPaths, ...pendingPaths])].sort();
      if (entryPaths.length !== priorPaths.length + pendingPaths.length) {
        throw new Error('A fallback file failed validation again.');
      }
      const store = this.openStore(failed.workspacePath);
      let reviewedTables: RegistryTableMappingDecision[];
      try {
        reviewedTables = store
          .listImportDecisions(failed.id, failed.id)
          .filter((decision) => decision.kind === 'registry_table_mapping');
      } finally {
        store.close();
      }
      const next = await this.importLocalBundle(
        source.originalPath,
        undefined,
        failed.displayName,
        reviewedTables,
        failed.localRetryExclusion,
        {
          zipSha256: source.zipSha256,
          entryPaths,
          priorRunId: failed.id,
          rootRunId: failed.localBestEffortFallback?.rootRunId ?? failed.id,
        }
      );
      this.scheduleBestEffortStagingCleanup(failed.id, next.id);
      return next;
    } catch (error) {
      console.error('[benchling-migration] best-effort file fallback could not start', error);
      const { bestEffortFallbackEntryPaths: _pending, ...remainingDetails } =
        failed.lastError?.details ?? {};
      const terminal: MigrationRun = {
        ...failed,
        updatedAt: this.now(),
        lastError: failed.lastError
          ? {
              ...failed.lastError,
              ...(Object.keys(remainingDetails).length > 0
                ? { details: remainingDetails }
                : { details: undefined }),
            }
          : null,
      };
      const store = this.openStore(failed.workspacePath);
      try {
        store.saveRun(terminal);
      } finally {
        store.close();
      }
      this.publish(terminal, terminal.lastError?.message);
      return terminal;
    }
  }

  private scheduleBestEffortStagingCleanup(failedRunId: string, nextRunId: string): void {
    const unsubscribe = this.subscribeProgress(nextRunId, ({ run }) => {
      if (run.state !== 'unlocked') return;
      unsubscribe();
      void this.discardBestEffortPredecessors(run, failedRunId).catch((error) => {
        console.warn('[benchling-migration] superseded staging cleanup deferred', error);
      });
    });
  }

  private async discardBestEffortPredecessors(
    successor: MigrationRun,
    firstPriorRunId: string
  ): Promise<void> {
    let current = successor;
    const visited = new Set<string>();
    while (current.localBestEffortFallback?.priorRunId === firstPriorRunId) {
      if (visited.has(firstPriorRunId)) throw new Error('Cyclic best-effort import lineage.');
      visited.add(firstPriorRunId);
      const prior = await this.requireRun(firstPriorRunId);
      if (
        prior.state !== 'failed' ||
        prior.workspaceOrigin?.kind !== 'migration_created' ||
        prior.externalZipSource?.zipSha256 !== current.localBestEffortFallback.zipSha256
      ) {
        throw new Error('Best-effort predecessor no longer matches its successor.');
      }
      await this.discard(firstPriorRunId);
      current = prior;
      firstPriorRunId = prior.localBestEffortFallback?.priorRunId ?? '';
    }
  }

  private scheduleAutomaticRestartResume(run: MigrationRun): void {
    if (
      !isAutomaticRestartResume(run) ||
      this.autoResumeSuppressed.has(run.id) ||
      this.autoResuming.has(run.id)
    ) {
      return;
    }
    const operation = this.automaticallyResumeInterruptedRun(run.id);
    this.autoResuming.set(run.id, operation);
    void operation.finally(() => {
      if (this.autoResuming.get(run.id) === operation) this.autoResuming.delete(run.id);
    });
  }

  private async automaticallyResumeInterruptedRun(runId: string): Promise<void> {
    while (!this.autoResumeSuppressed.has(runId)) {
      const run = await this.requireRun(runId).catch(() => null);
      if (!run || !isAutomaticRestartResume(run)) return;

      const authorized = await this.requireRun(runId).catch(() => null);
      if (
        !authorized ||
        !isAutomaticRestartResume(authorized) ||
        this.autoResumeSuppressed.has(runId)
      ) {
        return;
      }
      try {
        await this.startAuthorized(runId, true);
        return;
      } catch {
        const durable = await this.requireRun(runId).catch(() => null);
        if (!durable || !isAutomaticRestartResume(durable)) return;
        await this.waitForAutomaticResumeRetry();
      }
    }
  }

  private waitForAutomaticResumeRetry(): Promise<void> {
    const delayMs = Math.max(1, this.deps.autoResumeRetryDelayMs ?? AUTO_RESUME_RETRY_DELAY_MS);
    return new Promise((resolveRetry) => {
      const timer = setTimeout(resolveRetry, delayMs);
      timer.unref?.();
    });
  }

  private reserveWorkspaceCreation(start: () => Promise<MigrationRun>): Promise<MigrationRun> {
    if (this.workspaceCreation) {
      return Promise.reject(new Error('A Benchling migration is already being created.'));
    }
    const operation = start();
    this.workspaceCreation = operation;
    const clear = () => {
      if (this.workspaceCreation === operation) this.workspaceCreation = null;
    };
    void operation.then(clear, clear);
    return operation;
  }

  private async requireRun(runId: string): Promise<MigrationRun> {
    const knownPath = this.runPaths.get(runId);
    if (knownPath) {
      const store = this.openStore(knownPath);
      let run: MigrationRun | null;
      try {
        run = store.getRun();
      } finally {
        store.close();
      }
      if (run?.id === runId) {
        const recovered = run.state === 'draft' ? this.recoverDraftRun(run) : run;
        return !isLocalBundleRun(recovered) && recovered.state !== 'ready_to_unlock'
          ? this.retireUnsupportedProviderRun(recovered)
          : recovered;
      }
      this.runPaths.delete(runId);
    }
    const runs = await this.scanRuns();
    const run = runs.find((candidate) => candidate.id === runId);
    if (!run) throw new Error(`Benchling migration ${runId} does not exist.`);
    const recovered = run.state === 'draft' ? this.recoverDraftRun(run) : run;
    return !isLocalBundleRun(recovered) && recovered.state !== 'ready_to_unlock'
      ? this.retireUnsupportedProviderRun(recovered)
      : recovered;
  }

  private recoverDraftRun(candidate: MigrationRun): MigrationRun {
    const store = this.openStore(candidate.workspacePath);
    try {
      const durable = store.getRun();
      if (!durable || durable.id !== candidate.id) {
        throw new Error(`Benchling migration ${candidate.id} does not exist.`);
      }
      if (durable.state !== 'draft') return durable;
      if (
        durable.scope.kind === 'file' &&
        durable.scope.acquisition === 'local_bundle' &&
        !hasCompletedLocalSource(durable)
      ) {
        if (!isProvisionalLocalBundleRun(durable) || !durable.localExportIntake) {
          const interrupted = transitionMigrationRun(durable, 'failed', this.now(), {
            code: 'migration_interrupted',
            message:
              'DNAForge cannot safely resume this local export because its persisted source identity is missing. Choose the original ZIP export again.',
            blocking: true,
          });
          store.saveRun(interrupted);
          this.publish(interrupted, interrupted.lastError?.message);
          return interrupted;
        }
        this.scheduleLocalBundleIntakeRecovery(durable);
        return durable;
      }
      if (isLocalBundleFolderScope(durable.scope) && !hasCompletedLocalSource(durable)) {
        const confirmed = transitionMigrationRun(durable, 'identity_confirmation', this.now());
        store.saveRun(confirmed);
        const recovered = transitionMigrationRun(confirmed, 'scope_planning', this.now());
        store.saveRun(recovered);
        this.publish(recovered, 'Migration setup recovered. Choose the same folder ZIP again.');
        return recovered;
      }
      return this.retireUnsupportedProviderRun(durable, store);
    } finally {
      store.close();
    }
  }

  private retireUnsupportedProviderRun(
    candidate: MigrationRun,
    existingStore?: MigrationStore
  ): MigrationRun {
    if (
      isLocalBundleRun(candidate) ||
      candidate.state === 'ready_to_unlock' ||
      isTerminalMigrationState(candidate.state)
    ) {
      return candidate;
    }
    const failed = transitionMigrationRun(candidate, 'failed', this.now(), {
      code: 'migration_interrupted',
      message:
        'This migration used a retired provider-based flow. Start a new migration and choose the original Benchling export ZIP.',
      blocking: true,
    });
    const store = existingStore ?? this.openStore(candidate.workspacePath);
    try {
      store.saveRun(failed);
    } finally {
      if (!existingStore) store.close();
    }
    this.autoResumeSuppressed.add(candidate.id);
    this.publish(failed, failed.lastError?.message);
    return failed;
  }

  private scheduleLocalBundleIntakeRecovery(run: MigrationRun): void {
    if (this.localBundleIntake || !isPendingLocalBundleIntakeRun(run)) return;
    const operation = this.completeLocalBundleIntake(run, true);
    this.localBundleIntake = operation;
    void operation.then(
      () => {
        if (this.localBundleIntake === operation) this.localBundleIntake = null;
      },
      () => {
        if (this.localBundleIntake === operation) this.localBundleIntake = null;
      }
    );
    this.publishLocalBundleIntakeProgress(run, 0, run.localExportIntake!.plannedCopyBytes);
  }

  private scheduleLinkedItemRecoveryRestart(run: MigrationRun): void {
    if (!isActiveLinkedItemRecovery(run) || this.recoveringLinkedItems.has(run.id)) return;
    const rawOperation = (async () => {
      const release = await acquireWorkspaceMutationShared(run.workspacePath);
      try {
        const current = await this.requireRun(run.id);
        if (!isActiveLinkedItemRecovery(current)) return current;
        return await this.performLocalExportAttempt(
          run.id,
          [],
          'linked_item_recovery',
          undefined,
          true
        );
      } finally {
        release();
      }
    })();
    const operation = rawOperation.catch(async (error: unknown) => {
      console.error('[benchling-migration] linked-item recovery restart failed', error);
      return this.requireRun(run.id);
    });
    this.recoveringLinkedItems.set(run.id, operation);
    const clear = () => {
      if (this.recoveringLinkedItems.get(run.id) === operation) {
        this.recoveringLinkedItems.delete(run.id);
      }
    };
    void operation.then(clear, clear);
  }

  private scheduleFailedBestEffortAppendRestart(run: MigrationRun): void {
    if (
      (run.state !== 'unlocked' && run.state !== 'ready_to_unlock') ||
      this.recoveringLinkedItems.has(run.id)
    )
      return;
    const store = this.openStore(run.workspacePath);
    let failed: LinkedItemRecoveryAttempt | undefined;
    let reviewedTables: RegistryTableMappingDecision[] = [];
    try {
      const attempts = store.listLinkedItemRecoveryAttempts(run.id);
      failed = attempts.at(-1);
      if (
        !failed ||
        failed.state !== 'failed' ||
        !failed.safeFailure?.bestEffortFallbackSources ||
        attempts.some((attempt) => attempt.bestEffortFallback?.priorAttemptId === failed?.id)
      )
        return;
      reviewedTables = store
        .listImportDecisions(run.id, failed.id)
        .filter((decision) => decision.kind === 'registry_table_mapping');
    } finally {
      store.close();
    }
    const sourcePaths = failed.intakeDescriptors.map((descriptor) => descriptor.sourcePath);
    void this.trackLocalExportOperation(
      run.id,
      failed.mode,
      sourcePaths,
      undefined,
      false,
      reviewedTables,
      { priorAttemptId: failed.id, sources: failed.safeFailure!.bestEffortFallbackSources! }
    ).catch((error) => {
      console.error('[benchling-migration] best-effort append restart failed', error);
    });
  }

  private async scanRuns(): Promise<MigrationRun[]> {
    const entries = await readdir(this.deps.managedRootDir, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
    );
    const workspacePaths = new Set<string>();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      workspacePaths.add(join(this.deps.managedRootDir, entry.name, 'repo'));
    }
    const workspaceColumns = new Set(
      (
        this.deps.globalDb
          .prepare("SELECT name FROM pragma_table_info('workspaces')")
          .all() as Array<{
          name: string;
        }>
      ).map(({ name }) => name)
    );
    const livePredicates = [
      ...(workspaceColumns.has('archived_at') ? ['archived_at IS NULL'] : []),
      ...(workspaceColumns.has('trashed_at') ? ['trashed_at IS NULL'] : []),
    ];
    const registeredRows = this.deps.globalDb
      .prepare(
        `SELECT path
           FROM workspaces${livePredicates.length > 0 ? ` WHERE ${livePredicates.join(' AND ')}` : ''}`
      )
      .all() as Array<{ path: string }>;
    for (const row of registeredRows) workspacePaths.add(row.path);

    const runs: MigrationRun[] = [];
    for (const workspacePath of workspacePaths) {
      try {
        await access(migrationDatabasePath(workspacePath));
      } catch {
        continue;
      }
      const store = this.openStore(workspacePath);
      try {
        let run = store.getRun();
        if (!run) continue;
        const latestRecoveryAttempt = store.listLinkedItemRecoveryAttempts(run.id).at(-1);
        if (latestRecoveryAttempt) {
          const linkedItemRecovery = linkedItemRecoveryProgressForAttempt(latestRecoveryAttempt);
          if (!isDeepStrictEqual(run.linkedItemRecovery, linkedItemRecovery)) {
            run = {
              ...run,
              linkedItemRecovery,
              updatedAt:
                Date.parse(linkedItemRecovery.updatedAt) > Date.parse(run.updatedAt)
                  ? linkedItemRecovery.updatedAt
                  : run.updatedAt,
            };
            store.saveRun(run);
          }
        } else if (run.linkedItemRecovery) {
          throw new Error(
            `Migration ${run.id} has linked-item progress without its private durable attempt.`
          );
        }
        if (
          run.scope.acquisition === 'local_bundle' &&
          run.state === 'action_required' &&
          run.lastError?.blocking === true &&
          !this.running.has(run.id) &&
          !this.starting.has(run.id)
        ) {
          run = transitionMigrationRun(run, 'failed', this.now(), run.lastError);
          store.saveRun(run);
          this.autoResumeSuppressed.add(run.id);
        }
        this.runPaths.set(run.id, run.workspacePath);
        try {
          reconcileBenchlingMigrationTelemetryOutbox(
            store,
            this.deps.globalDb,
            run.id,
            this.deps.telemetry
          );
        } catch (error) {
          console.warn('[benchling-migration] telemetry outbox reconciliation deferred', error);
        }
        runs.push(run);
      } finally {
        store.close();
      }
    }
    drainMainAnalyticsOutbox(this.deps.globalDb);
    return runs.sort(
      (left, right) =>
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.id.localeCompare(right.id)
    );
  }

  private publish(run: MigrationRun, message?: string, store?: MigrationStore): void {
    let ownedStore: MigrationStore | null = null;
    try {
      const telemetryStore = store ?? (ownedStore = this.openStore(run.workspacePath));
      reconcileBenchlingMigrationTelemetryOutbox(
        telemetryStore,
        this.deps.globalDb,
        run.id,
        this.deps.telemetry
      );
      drainMainAnalyticsOutbox(this.deps.globalDb);
    } catch (error) {
      console.warn('[benchling-migration] telemetry outbox reconciliation deferred', error);
    } finally {
      ownedStore?.close();
    }
    const progress = {
      run,
      message,
      ...(store ? safeMigrationProgressFacts(run, store) : {}),
    };
    for (const listener of this.listeners.get(run.id) ?? []) {
      try {
        listener(progress);
      } catch {}
    }
  }

  private readonly now = (): string => (this.deps.now ?? (() => new Date().toISOString()))();
  private readonly nowMs = (): number => (this.deps.nowMs ?? Date.now)();
  private readonly openStore = (workspacePath: string): MigrationStore =>
    this.deps.openStore
      ? this.deps.openStore(workspacePath)
      : openWorkspaceMigrationStore(workspacePath, this.deps.telemetry ?? null);
}

export function isCoordinatorActiveRunCandidate(run: MigrationRun): boolean {
  return (
    (!isTerminalMigrationState(run.state) && run.state !== 'action_required') ||
    isActiveLinkedItemRecovery(run)
  );
}

function pendingBestEffortEntryPaths(run: MigrationRun): string[] {
  const value = run.lastError?.details?.bestEffortFallbackEntryPaths;
  return Array.isArray(value) && value.length > 0 && value.every((path) => typeof path === 'string')
    ? value
    : [];
}

function hasPendingBestEffortFallback(run: MigrationRun): boolean {
  return run.state === 'failed' && pendingBestEffortEntryPaths(run).length > 0;
}

function isVisibleNonBlockingLeftover(run: MigrationRun): boolean {
  if (isProjectionContractStartOverFailure(run)) return false;
  if (run.state === 'failed' && run.scope.acquisition === 'local_bundle') return false;
  return run.state === 'failed' || run.state === 'action_required';
}

type MigrationProgressFacts = Pick<
  BenchlingMigrationCoordinatorProgress,
  'completedItems' | 'totalItems' | 'warnings'
>;

const CAPTURE_PROGRESS_STATES = new Set<MigrationRun['state']>([
  'export_pending',
  'downloading',
  'parsing',
]);
const RELATIONSHIP_PROGRESS_STATES = new Set<MigrationRun['state']>([
  'offline_resolution',
  'targeted_reads',
]);

function safeMigrationProgressFacts(
  run: MigrationRun,
  store: MigrationStore
): MigrationProgressFacts {
  try {
    return deriveMigrationProgressFacts(run, store);
  } catch {
    return { completedItems: null, totalItems: null, warnings: [] };
  }
}

function isProjectionContractStartOverFailure(run: MigrationRun): boolean {
  return (
    run.state === 'failed' &&
    run.lastError?.code === 'projection_contract_restart_required' &&
    run.lastError.details?.recoveryDisposition === PROJECTION_CONTRACT_START_OVER_DISPOSITION
  );
}

export function deriveMigrationProgressFacts(
  run: MigrationRun,
  store: MigrationStore
): MigrationProgressFacts {
  const phase =
    (run.state === 'paused' ||
      run.state === 'action_required' ||
      run.state === 'cancelled_preserved') &&
    run.resumeState
      ? run.resumeState
      : run.state;
  const warnings = scopedSkipWarnings(run, store);

  if (CAPTURE_PROGRESS_STATES.has(phase)) {
    return { ...captureProgress(run.id, store), warnings };
  }
  if (RELATIONSHIP_PROGRESS_STATES.has(phase)) {
    return { ...relationshipProgress(run.id, store), warnings };
  }
  if (phase === 'projecting') {
    return { ...projectionProgress(run.id, store), warnings };
  }
  if (phase === 'validating' || phase === 'ready_to_unlock' || phase === 'unlocked') {
    return {
      completedItems: store.getValidationReport(run.id) ? 1 : 0,
      totalItems: 1,
      warnings,
    };
  }
  return { completedItems: null, totalItems: null, warnings };
}

function captureProgress(
  runId: string,
  store: MigrationStore
): Pick<MigrationProgressFacts, 'completedItems' | 'totalItems'> {
  const jobs = store.listExportJobs(runId);
  if (jobs.length === 0) return { completedItems: null, totalItems: null };
  const activeJobIds = activeExportLeafJobIds(
    jobs.map((job) => job.id),
    store.listExportJobReplacements(runId)
  );
  const activeStatesBySourceItem = new Map<string, Array<(typeof jobs)[number]['state']>>();
  const allSourceItems = new Set<string>();

  for (const job of jobs) {
    const sourceItemIds = exportJobSourceItemIds(job);
    for (const sourceItemId of sourceItemIds) allSourceItems.add(sourceItemId);
    if (!activeJobIds.has(job.id)) continue;
    for (const sourceItemId of sourceItemIds) {
      const states = activeStatesBySourceItem.get(sourceItemId) ?? [];
      states.push(job.state);
      activeStatesBySourceItem.set(sourceItemId, states);
    }
  }

  const completedItems = [...allSourceItems].filter((sourceItemId) => {
    const states = activeStatesBySourceItem.get(sourceItemId);
    return (
      states !== undefined && states.length > 0 && states.every((state) => state === 'captured')
    );
  }).length;
  return { completedItems, totalItems: allSourceItems.size };
}

function exportJobSourceItemIds(
  job: ReturnType<MigrationStore['listExportJobs']>[number]
): string[] {
  const authorizedSourceItemId =
    job.directFolderAuthority?.sourceItemId ?? job.folderTreeAuthority?.sourceItemId;
  return authorizedSourceItemId
    ? [authorizedSourceItemId]
    : [...new Set(job.sourceRoots.map((sourceRoot) => sourceRoot.id))];
}

function relationshipProgress(
  runId: string,
  store: MigrationStore
): Pick<MigrationProgressFacts, 'completedItems' | 'totalItems'> {
  const relationshipIds = new Set(
    store
      .listSourceObjects(runId)
      .flatMap((sourceObject) => sourceObject.relationships.map((relationship) => relationship.id))
  );
  const completedItems = new Set(
    store
      .listRelationshipResolutions(runId)
      .map((resolution) => resolution.relationshipId)
      .filter((relationshipId) => relationshipIds.has(relationshipId))
  ).size;
  return { completedItems, totalItems: relationshipIds.size };
}

function projectionProgress(
  runId: string,
  store: MigrationStore
): Pick<MigrationProgressFacts, 'completedItems' | 'totalItems'> {
  const sourceObjectIds = new Set(
    store.listSourceObjects(runId).map((sourceObject) => sourceObject.id)
  );
  const completedItems = new Set(
    store
      .listProjectionReceipts(runId)
      .map((receipt) => receipt.sourceObjectId)
      .filter((sourceObjectId) => sourceObjectIds.has(sourceObjectId))
  ).size;
  return { completedItems, totalItems: sourceObjectIds.size };
}

function scopedSkipWarnings(run: MigrationRun, store: MigrationStore): string[] {
  if (run.scope.kind === 'file') return [];
  const plan =
    run.scope.kind === 'folder'
      ? store.getDirectFolderCapturePlan(run.id)
      : store.getFolderTreeCapturePlan(run.id);
  if (!plan) return [];
  const skippedItemCount = plan.blockers.length;
  if (skippedItemCount === 0) return [];
  return [
    `${skippedItemCount} unsupported source item${skippedItemCount === 1 ? '' : 's'} will be skipped and listed in the migration report.`,
  ];
}

function isAutomaticRestartResume(run: MigrationRun): boolean {
  if (
    run.state === 'ready_to_unlock' &&
    run.workspaceOrigin?.kind === 'migration_created' &&
    run.externalZipSource &&
    isLocalBundleRun(run)
  )
    return true;
  return (
    run.state === 'paused' &&
    run.lastError?.code === 'migration_interrupted' &&
    run.resumeState !== null &&
    RESTART_RECOVERABLE_STATES.has(run.resumeState)
  );
}

function isActiveLinkedItemRecovery(run: MigrationRun): boolean {
  return Boolean(
    run.linkedItemRecovery &&
    ['copying', 'parsing', 'awaiting_conflict_resolution', 'reconciling', 'validating'].includes(
      run.linkedItemRecovery.state
    )
  );
}

function isLocalBundleScope(scope: MigrationRun['scope']): boolean {
  return scope.acquisition === 'local_bundle';
}

async function plannedLocalBundleContentPlan(
  run: MigrationRun,
  preparedZip?: PreparedLocalBenchlingExportZip
): Promise<{
  plannedContentFamilies: string[];
  oneHopDisclosure: MigrationPreflight['oneHopDisclosure'];
}> {
  if (run.scope.kind === 'file' && !run.externalZipSource) {
    return {
      plannedContentFamilies: ['notebook'],
      oneHopDisclosure: { status: 'not_applicable', dependencies: [] },
    };
  }
  if (!migrationRunHasZipSource(run)) {
    return {
      plannedContentFamilies: [],
      oneHopDisclosure: { status: 'not_applicable', dependencies: [] },
    };
  }

  if (run.scope.kind === 'folder') {
    if (!preparedZip) {
      throw new Error('Direct Folder preflight is missing its read-only ZIP review.');
    }
    const dependencies = preparedZip.sourceObjects
      .filter((sourceObject) => sourceObject.memberships.length === 0)
      .map((sourceObject) => ({
        sourceObjectId: sourceObject.id,
        contentFamily: localSourceObjectContentFamily(sourceObject.sourceType),
      }))
      .sort((left, right) => left.sourceObjectId.localeCompare(right.sourceObjectId));
    return {
      plannedContentFamilies: [
        ...new Set(
          preparedZip.sourceObjects.map((sourceObject) =>
            localSourceObjectContentFamily(sourceObject.sourceType)
          )
        ),
      ].sort(),
      oneHopDisclosure: { status: 'exact', dependencies },
    };
  }

  if (run.externalZipSource) {
    await verifyExternalZipSource(run.externalZipSource);
  }
  const archive = await inspectNativeExportArchive(
    verifiedLocalBundleArtifact(run).nativeExportDecoderSource!
  );
  const families = new Set<string>();
  for (const entry of archive.entries) {
    if (entry.isDirectory) continue;
    const segments = entry.path.split('/');
    const filename = segments.at(-1) ?? '';
    if (/\(etr_[A-Za-z0-9]+\)\.html?$/iu.test(filename)) {
      families.add('notebook');
    } else if (/\(seq_[A-Za-z0-9]+\)\.(?:gb|gbk|genbank)$/iu.test(filename)) {
      families.add('dna_rna');
    } else if (/\(prtn_[A-Za-z0-9]+\)\.fasta$/iu.test(filename)) {
      families.add('protein');
    }
  }
  return {
    plannedContentFamilies: [...families].sort(),
    oneHopDisclosure: { status: 'not_applicable', dependencies: [] },
  };
}

function localBundlePreparationIdentity(run: MigrationRun): string {
  const artifact = verifiedLocalBundleArtifact(run);
  return createHash('sha256')
    .update(
      JSON.stringify({
        runId: run.id,
        artifact: {
          logicalFilename: artifact.logicalFilename,
          sha256: artifact.sha256,
          sizeBytes: artifact.sizeBytes,
          immutableLocalPath: artifact.immutableLocalPath,
          capturedAt: localSourceTimestamp(run),
        },
        scope: run.scope,
      })
    )
    .digest('hex');
}

function verifiedLocalBundleArtifact(run: MigrationRun): VerifiedLocalBenchlingExportArtifact {
  const external = run.externalZipSource;
  if (external) {
    return {
      schema: 'dnaforge.benchling.local-export-artifact.v1',
      logicalFilename: external.displayName,
      sha256: external.zipSha256,
      sizeBytes: external.sizeBytes,
      immutableLocalPath: external.originalPath,
      format: 'zip',
      resources: [],
      nativeExportDecoderSource: externalZipDecoderSource(external),
      archive: {
        entryCount: run.externalZipEntries?.length ?? 0,
        totalCompressedEntryBytes: external.sizeBytes,
        totalUncompressedEntryBytes: externalEntryBytes(run),
      },
    };
  }
  const artifact = run.localExportArtifact;
  if (!artifact) throw new Error('Local export metadata is missing from this migration run.');
  const base = {
    schema: artifact.schema,
    logicalFilename: artifact.logicalFilename,
    sha256: artifact.sha256,
    sizeBytes: artifact.sizeBytes,
    immutableLocalPath: artifact.immutableLocalPath,
  };
  if (artifact.format === 'html') {
    return {
      ...base,
      format: 'html',
      mediaType: 'text/html',
      resources: artifact.resources.map((resource) => ({ ...resource })),
      nativeExportDecoderSource: null,
      archive: null,
    };
  }
  if (!artifact.archive || artifact.resources.length !== 0) {
    throw new Error('Local ZIP artifact metadata is incomplete.');
  }
  return {
    ...base,
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

function localArtifactCapturedAt(value: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error('Local export capture time is invalid.');
  }
  return new Date(value).toISOString();
}

function localSourceTimestamp(run: MigrationRun): string {
  return run.externalZipSource
    ? localArtifactCapturedAt(run.externalZipSource.selectedAt)
    : localArtifactCapturedAt(run.localExportArtifact?.capturedAt ?? '');
}

function externalEntryBytes(run: MigrationRun): number {
  let total = 0;
  for (const entry of run.externalZipEntries ?? []) {
    total += entry.sizeBytes;
    if (!Number.isSafeInteger(total)) throw new Error('External ZIP entry bytes are too large.');
  }
  return total;
}

function migrationRunHasZipSource(run: MigrationRun): boolean {
  return Boolean(run.externalZipSource || run.localExportArtifact?.format === 'zip');
}

function hasCompletedLocalSource(run: MigrationRun): boolean {
  return Boolean(run.externalZipSource || run.localExportArtifact);
}

function localSourceObjectContentFamily(sourceType: string): string {
  if (sourceType === 'notebook_entry' || sourceType === 'entry') return 'notebook';
  if (
    ['bulk_assembly', 'dna_sequence', 'oligo', 'rna_oligo', 'rna_sequence', 'sequence'].includes(
      sourceType
    )
  ) {
    return 'dna_rna';
  }
  if (sourceType === 'protein' || sourceType === 'aa_sequence') return 'protein';
  if (sourceType === 'protocol' || sourceType === 'protocol_execution') return 'protocol';
  if (sourceType === 'registry_record' || sourceType === 'registry_entity') return 'registry';
  if (sourceType === 'attachment' || sourceType === 'file') return 'attachment';
  return 'generic';
}

function isLocalBundleFolderScope(scope: MigrationRun['scope']): scope is Extract<
  MigrationRun['scope'],
  { kind: 'folder' | 'folder_tree' }
> & {
  acquisition: 'local_bundle';
} {
  return scope.kind !== 'file' && scope.acquisition === 'local_bundle';
}

function isLocalBundleRun(run: MigrationRun): boolean {
  return isLocalBundleScope(run.scope);
}

function isProvisionalLocalBundleRun(run: MigrationRun): boolean {
  return (
    run.state === 'draft' &&
    run.scope.kind === 'file' &&
    run.scope.acquisition === 'local_bundle' &&
    run.scope.source.id.startsWith('local-export-pending-') &&
    !hasCompletedLocalSource(run)
  );
}

function isPendingLocalBundleIntakeRun(run: MigrationRun): boolean {
  if (
    !isLocalBundleScope(run.scope) ||
    run.binding !== null ||
    hasCompletedLocalSource(run) ||
    !run.localExportIntake
  ) {
    return false;
  }
  return run.scope.kind === 'file'
    ? isProvisionalLocalBundleRun(run)
    : interruptedResumeState(run) === 'scope_planning';
}

function interruptedResumeState(run: MigrationRun): MigrationRun['state'] {
  return run.state === 'paused' ||
    run.state === 'action_required' ||
    run.state === 'cancelled_preserved'
    ? (run.resumeState ?? run.state)
    : run.state;
}

function safeLocalIntakeFailureMessage(error: unknown): string {
  if (error instanceof ExternalZipSourceError) {
    return error.code === 'source_changed'
      ? 'The selected Benchling ZIP changed after it was selected.'
      : 'The selected Benchling ZIP is no longer available at its original location.';
  }
  if (!(error instanceof LocalBenchlingExportIntakeError)) {
    return 'The selected local export could not be read safely.';
  }
  return (
    {
      local_export_invalid_workspace_path:
        'The locked migration project is unavailable for local import.',
      local_export_invalid_source_path: 'The selected local export is missing or cannot be read.',
      local_export_unsupported_extension: 'Select one original Benchling ZIP export.',
      local_export_not_regular_file: 'The selected local export is no longer a regular file.',
      local_export_empty: 'The selected local export is empty.',
      local_export_content_mismatch:
        'The selected file does not contain a supported Benchling export.',
      local_export_resource_path_invalid:
        'The HTML export contains an unsafe local raster reference.',
      local_export_resource_ambiguous: 'The HTML export has ambiguous local raster resources.',
      local_export_resource_not_regular_file:
        'A referenced local raster is missing, changed, or unsafe.',
      local_export_resources_too_large:
        'The HTML export raster resources exceed the supported import limit.',
      local_export_invalid_size_limit: 'The configured local export size limit is invalid.',
      local_export_too_large: 'The selected local export exceeds the supported import limit.',
      local_export_source_changed:
        'The selected local export or one of its raster resources changed before copying completed.',
      local_export_acquisition_disabled:
        'Benchling export import is turned off in this build of DNAForge.',
      local_export_migration_already_active:
        'A Benchling migration is already running. Finish or discard it before importing another export.',
    } as const
  )[error.code];
}

export async function validateProjectedFilesStructurally(
  input: LocalBundleRenderValidationInput
): Promise<MigrationRenderCheck[]> {
  const receiptBySource = new Map(
    input.receipts.map((receipt) => [receipt.sourceObjectId, receipt])
  );
  return Promise.all(
    input.selectedSourceObjectIds.map(async (sourceObjectId) => {
      const receipt = receiptBySource.get(sourceObjectId);
      if (!receipt) {
        return { sourceObjectId, passed: false, message: 'Projection receipt is missing.' };
      }
      const destinationPath = resolve(input.run.workspacePath, receipt.destinationPath);
      const relativeDestination = relative(resolve(input.run.workspacePath), destinationPath);
      if (
        relativeDestination.length === 0 ||
        relativeDestination === '..' ||
        relativeDestination.startsWith(`..${sep}`) ||
        isAbsolute(relativeDestination)
      ) {
        return { sourceObjectId, passed: false, message: 'Projection path escaped the workspace.' };
      }
      try {
        const stats = await lstat(destinationPath);
        if (!stats.isFile() || stats.isSymbolicLink() || stats.size === 0) {
          return {
            sourceObjectId,
            passed: false,
            message: 'Projected content is not a non-empty file.',
          };
        }
        const bytes = await readFile(destinationPath);
        return {
          sourceObjectId,
          passed: bytes.byteLength > 0,
          ...(bytes.byteLength > 0 ? {} : { message: 'Projected content is empty.' }),
        };
      } catch (error) {
        return {
          sourceObjectId,
          passed: false,
          message:
            error instanceof Error ? error.message : 'Projected content could not be opened.',
        };
      }
    })
  );
}
