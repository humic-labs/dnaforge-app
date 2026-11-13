import { createHash } from 'node:crypto';
import { basename, extname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import {
  NATIVE_WORKSPACE_MANIFEST_PATH,
  parseNativeWorkspaceManifest,
} from '../../shared/native-workspace-manifest';
import { readBoundedWorkspaceFile } from './bounded-workspace-file';

import {
  BENCHLING_MIGRATION_DESTINATION_INTEGRITY_VERSION,
  BENCHLING_MIGRATION_PROJECTION_VERSION,
  isValidationReportV2,
  migrationRunSourceIdentityHash,
  type BenchlingSourceRef,
  type ExternalZipEntryEvidence,
  type MigrationIssue,
  type MigrationResult,
  type MigrationRun,
  type ProjectionReceipt,
  type RelationshipResolution,
  type SourceObject,
  type SourceSnapshot,
  type ValidationDestinationArtifactEvidence,
  type ValidationReport,
} from '../../shared/benchling-migration';
import { buildMigrationDestinationLinkIndexWriterPayload } from '../../shared/benchling-migration-destination-index';
import {
  buildCollectionProjection,
  collectionDestinationId,
  mergeWorkspaceAppendFolderAuthority,
  serializeCollectionProjection,
  type CollectionProjection,
  type ScopedFolderMetadata,
} from './collection-projection';
import {
  nativeCollectionDocumentPath,
  nativeFolderPathMap,
  preserveNativeFolderPlacements,
  persistScopedFolderBoundary,
  readCollectionProjection,
  readScopedFolderBoundary,
  writeCollectionProjection,
  type CollectionProjectionLayout,
} from './collection-projection-writer';
import { ContentArchive, type LogicalContentManifestEntry } from './content-archive';
import {
  buildMigrationDestinationIndexEntries,
  persistMigrationDestinationLinkIndex,
} from './destination-index-writer';
import { migrationEvidenceId } from './evidence-id';
import { externalZipDecoderSource, verifyExternalZipSource } from './external-zip-source';
import {
  decodeLocalBenchlingExportBundle,
  type LocalBenchlingExportCapture,
  type PreparedLocalBenchlingExportZip,
} from './local-export-decoder';
import type { VerifiedLocalBenchlingExportArtifact } from './local-export-bundle';
import {
  inspectNativeExportArchive,
  persistNativeExportArchiveEntries,
} from './native-export-archive';
import { buildProjectionPlan, projectionDestinationObjectId } from './projection';
import {
  assertProjectionContractResumeSafe,
  ProjectionContractRestartRequiredError,
  projectionContractRestartIssue,
} from './projection-contract';
import {
  verifyProjectionReceiptIntegrity,
  writeFreshProjectionBatch,
  writeProjectionPlan,
} from './projection-writer';
import { buildOutboundLocalLinkMap } from './relationship-link-map';
import { resolveOfflineRelationships } from './relationship-resolver';
import { benchlingOrganizationBaseUrlFromSourceRef } from './source-identity';
import {
  isLocalExportNamespaceUrl,
  localExportNamespacedUrl,
} from '../../shared/benchling-migration';
import {
  advanceMigrationRun,
  isTerminalMigrationState,
  transitionMigrationRun,
} from './state-machine';
import type { MigrationStore, WorkspaceAppendHierarchyCapture } from './store';
import type { LocalBundlePhaseTiming, LocalBundleTimedPhase } from './local-bundle-performance';
import { buildLocalProjectionPlansInDedicatedWorker } from './local-projection-worker-client';
import { selectBestEffortRenderFallbackPaths } from './best-effort-render-fallback';
import { LOCAL_PROJECTION_WORKER_JOB_SCHEMA } from './local-projection-worker-job';
import {
  advancePersistedBenchlingMigrationAllocation,
  reserveBenchlingMigrationAction,
  readBenchlingMigrationActionJournal,
  summarizeActionDestinationChanges,
} from './action-journal';
import type { BenchlingMigrationActionAllocation } from '../../shared/benchling-migration-action-journal';
import {
  generateValidationReport,
  type ArchiveIntegrityEvidence,
  type MigrationRenderCheck,
} from './validation';

export type LocalBundleControlDecision = 'continue' | 'pause' | 'cancel_preserved';

const LOCAL_PROJECTION_CONCURRENCY = 12;
const ARCHIVE_BLOB_VERIFY_CONCURRENCY = 16;

export type LocalArchiveIntegrityProgress = Readonly<{
  phase: 'persisting_source_files' | 'validating_source_files';
  completed: number;
  total: number;
}>;

export type ExternalSupplementalZipEvidence = Readonly<{
  source: NonNullable<MigrationRun['externalZipSource']>;
  entries: readonly ExternalZipEntryEvidence[];
}>;

export type LocalBundleRenderValidationInput = Readonly<{
  run: MigrationRun;
  sourceObjects: SourceObject[];
  receipts: ProjectionReceipt[];
  resolutions: RelationshipResolution[];
  selectedSourceObjectIds: string[];
  onProgress?: (progress: Readonly<{ completed: number; total: number }>) => void;
}>;

export type LocalBundleExecutorDeps = Readonly<{
  store: MigrationStore;
  archive: ContentArchive;
  destinationDb?: import('better-sqlite3').Database;
  renderValidator: (input: LocalBundleRenderValidationInput) => Promise<MigrationRenderCheck[]>;
  now?: () => string;
  checkpoint?: () => LocalBundleControlDecision | Promise<LocalBundleControlDecision>;
  onRunUpdated?: (run: MigrationRun) => void;
  persistPassedReport?: (run: MigrationRun, report: ValidationReport) => Promise<void>;
  decode?: typeof decodeLocalBenchlingExportBundle;
  preparedZip?: PreparedLocalBenchlingExportZip;
  projectionPlanner?: typeof buildLocalProjectionPlansInDedicatedWorker;
  writeProjection?: typeof writeProjectionPlan;
  monotonicNow?: () => number;
  onPhaseTiming?: (timing: LocalBundlePhaseTiming) => void;
}>;

export class LocalBundleMigrationFailedError extends Error {
  constructor(readonly run: MigrationRun) {
    super(run.lastError?.message ?? 'Benchling import failed.');
    this.name = 'LocalBundleMigrationFailedError';
  }
}

export class LocalBundleMigrationInterruptedError extends Error {
  constructor(readonly run: MigrationRun) {
    super(`Local Benchling export import is ${run.state}.`);
    this.name = 'LocalBundleMigrationInterruptedError';
  }
}

export async function executeLocalBundleMigration(
  requestedRun: MigrationRun,
  deps: LocalBundleExecutorDeps
): Promise<MigrationResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  const decode = deps.decode ?? decodeLocalBenchlingExportBundle;
  const projectionPlanner = deps.projectionPlanner ?? buildLocalProjectionPlansInDedicatedWorker;
  const usesDefaultProjectionWriter = deps.writeProjection === undefined;
  const writeProjection = deps.writeProjection ?? writeProjectionPlan;
  const monotonicNow = deps.monotonicNow ?? performance.now.bind(performance);
  let run = requireCurrentLocalRun(requestedRun, deps.store);

  if (run.state === 'unlocked') return completedResult(run, deps.store);
  if (isTerminalMigrationState(run.state)) {
    throw new Error(`Local export run ${run.id} cannot execute from ${run.state}.`);
  }

  const projectionReceipts = deps.store.listProjectionReceipts(run.id);
  let cachedSourceObjects: SourceObject[] | undefined;
  let cachedResolutions: RelationshipResolution[] | undefined;
  let cachedReceipts: ProjectionReceipt[] = projectionReceipts;
  let cachedProjectionPlans:
    | ReadonlyMap<string, ReturnType<typeof buildProjectionPlan>>
    | undefined;
  let cachedAllocations: readonly BenchlingMigrationActionAllocation[] | undefined;
  const provenZeroSourceProjection =
    projectionReceipts.length === 0
      ? await proveZeroSourceProjectionResumeSafe(run, deps.store)
      : undefined;
  try {
    assertProjectionContractResumeSafe({
      run,
      receipts: projectionReceipts,
      expectedVersion: BENCHLING_MIGRATION_PROJECTION_VERSION,
      provenZeroSourceProjection:
        projectionReceipts.length === 0 ? provenZeroSourceProjection : undefined,
    });
  } catch (error) {
    if (error instanceof ProjectionContractRestartRequiredError) {
      const issue = projectionContractRestartIssue(error);
      run = transitionMigrationRun(run, 'failed', now(), issue);
      persistRun(run, deps);
      throw new LocalBundleMigrationFailedError(run);
    }
    throw error;
  }

  if (run.state === 'ready_to_unlock') {
    return completedResult(run, deps.store);
  }
  if (run.state === 'draft' || run.state === 'identity_confirmation') {
    throw new Error('Local export execution requires a completed offline preflight.');
  }

  run = { ...run, attempt: run.attempt + 1, updatedAt: now() };
  const prePhaseRuns: MigrationRun[] = [run];
  if (
    run.state === 'paused' ||
    run.state === 'cancelled_preserved' ||
    run.state === 'action_required'
  ) {
    run = advanceMigrationRun(run, now());
    prePhaseRuns.push(run);
  }

  while (
    run.state === 'scope_planning' ||
    run.state === 'export_pending' ||
    run.state === 'downloading'
  ) {
    await enforceCheckpoint(run, deps, now);
    run = advanceMigrationRun(run, now());
    prePhaseRuns.push(run);
  }
  deps.store.saveRuns(prePhaseRuns);
  deps.onRunUpdated?.(run);

  if (run.state === 'parsing') {
    const phaseStartedAt = monotonicNow();
    await enforceCheckpoint(run, deps, now);
    if (!deps.store.getSourceSnapshot(run.id)) {
      const artifact = verifiedArtifactFromRun(run);
      const decodeStartedAt = monotonicNow();
      const capturePromise = decode({
        artifact,
        reviewedTables: deps.store
          .listImportDecisions(run.id, run.id)
          .filter((decision) => decision.kind === 'registry_table_mapping'),
        excludedEntryPaths: run.localRetryExclusion?.entryPaths,
        fallbackEntryPaths: run.localBestEffortFallback?.entryPaths,
        archive: deps.archive,
        ...(run.externalZipSource
          ? {
              externalZipSource: run.externalZipSource,
              externalZipEntries: run.externalZipEntries,
              ...(run.scope.kind === 'file' ? { nativeWorkspaceRunId: run.id } : {}),
            }
          : {}),
        capturedAt: artifactTime(run),
        scope: run.scope,
      });
      const preparedWorkPromise = deps.preparedZip
        ? prepareProjectionWorkWhileMaterializing(
            run,
            deps.preparedZip,
            projectionPlanner,
            deps,
            monotonicNow
          )
        : undefined;
      const capture = await capturePromise;
      emitPhaseTiming(
        deps,
        'parsing_decode',
        decodeStartedAt,
        monotonicNow,
        capture.sourceObjects.length
      );
      const completedParsingRun = advanceMigrationRun(run, now());
      const parsingCommitStartedAt = monotonicNow();
      const persistPromise = persistCapture(
        run,
        capture,
        deps.archive,
        deps.store,
        completedParsingRun
      );
      const [, preparedWork] = await Promise.all([persistPromise, preparedWorkPromise]);
      emitPhaseTiming(
        deps,
        'parsing_commit',
        parsingCommitStartedAt,
        monotonicNow,
        capture.sourceObjects.length
      );
      run = completedParsingRun;
      cachedSourceObjects = sortedSourceObjects(capture.sourceObjects);
      if (preparedWork) {
        if (!isDeepStrictEqual(preparedWork.sourceObjects, cachedSourceObjects)) {
          throw new Error('Prepared projection work no longer matches the captured ZIP objects.');
        }
        cachedResolutions = preparedWork.resolutions;
        cachedProjectionPlans = preparedWork.plansBySourceObjectId;
        cachedAllocations = preparedWork.allocations;
      }
      deps.onRunUpdated?.(run);
    } else {
      run = advanceMigrationRun(run, now());
      persistRun(run, deps);
    }
    emitPhaseTiming(
      deps,
      'parsing',
      phaseStartedAt,
      monotonicNow,
      cachedSourceObjects?.length ?? requireSnapshot(run.id, deps.store).expectedSourceObjectCount
    );
  }

  if (run.state === 'offline_resolution') {
    const phaseStartedAt = monotonicNow();
    await enforceCheckpoint(run, deps, now);
    cachedSourceObjects ??= sortedSourceObjects(deps.store.listSourceObjects(run.id));
    const resolutions =
      cachedResolutions ?? resolveLocalOfflineRelationships(run, deps.store, cachedSourceObjects);
    const targetedReadsRun = advanceMigrationRun(run, now());
    const projectingRun = advanceMigrationRun(targetedReadsRun, now());
    deps.store.commitLocalOfflineResolution({
      runId: run.id,
      resolutions,
      runs: [targetedReadsRun, projectingRun],
    });
    run = projectingRun;
    cachedResolutions = resolutions;
    deps.onRunUpdated?.(run);
    emitPhaseTiming(deps, 'offline_resolution', phaseStartedAt, monotonicNow, resolutions.length);
    const targetedPhaseStartedAt = monotonicNow();
    emitPhaseTiming(deps, 'targeted_reads', targetedPhaseStartedAt, monotonicNow, 0);
  }

  if (run.state === 'targeted_reads') {
    const phaseStartedAt = monotonicNow();
    await enforceCheckpoint(run, deps, now);
    run = advanceMigrationRun(run, now());
    persistRun(run, deps);
    emitPhaseTiming(deps, 'targeted_reads', phaseStartedAt, monotonicNow, 0);
  }

  if (run.state === 'projecting') {
    const phaseStartedAt = monotonicNow();
    await enforceCheckpoint(run, deps, now);
    const projectionStateUpdates: MigrationRun[] = [];
    if (run.converterVersions.projection !== BENCHLING_MIGRATION_PROJECTION_VERSION) {
      run = {
        ...run,
        converterVersions: {
          ...run.converterVersions,
          projection: BENCHLING_MIGRATION_PROJECTION_VERSION,
        },
        updatedAt: now(),
      };
      projectionStateUpdates.push(run);
    }
    const snapshot = requireSnapshot(run.id, deps.store);
    const sourceObjects = (cachedSourceObjects ??= sortedSourceObjects(
      deps.store.listSourceObjects(run.id)
    ));
    const resolutions = (cachedResolutions ??= deps.store.listRelationshipResolutions(run.id));
    const existingReceipts = cachedReceipts;
    const receipted = new Set(existingReceipts.map((receipt) => receipt.sourceObjectId));
    const linksBySourceObjectId = projectionLinksBySourceObjectId(
      sourceObjects,
      resolutions,
      existingReceipts
    );
    const pendingSourceObjects = sourceObjects.filter(
      (sourceObject) => !receipted.has(sourceObject.id)
    );
    if (run.externalZipSource) {
      cachedAllocations ??= (
        await reserveBenchlingMigrationAction({
          run,
          actionId: run.id,
          sourceObjects,
          decisions: deps.store.listImportDecisions(run.id, run.id),
          destinationDb: deps.destinationDb,
          now: snapshot.createdAt,
        })
      ).allocations;
    }
    const allocationBySourceObjectId = new Map(
      cachedAllocations?.map((allocation) => [allocation.sourceObjectId, allocation]) ?? []
    );
    const newReceipts: ProjectionReceipt[] = [];
    const projectionObjectsStartedAt = monotonicNow();
    const projectionPlanStartedAt = monotonicNow();
    const preparedProjectionPlans = cachedProjectionPlans;
    const usePreparedProjectionPlans =
      preparedProjectionPlans !== undefined &&
      pendingSourceObjects.every((sourceObject) => preparedProjectionPlans.has(sourceObject.id));
    const pendingProjectionItems = pendingSourceObjects.map((sourceObject) => {
      const allocation = allocationBySourceObjectId.get(sourceObject.id);
      return {
        allocation,
        workspacePath: run.workspacePath,
        runId: run.id,
        sourceObjectId: sourceObject.id,
        ...(run.externalZipSource
          ? {
              externalAssetSources: [
                { source: run.externalZipSource, entries: run.externalZipEntries ?? [] },
              ],
            }
          : {}),
        plan:
          preparedProjectionPlans?.get(sourceObject.id) ??
          buildProjectionPlan(sourceObject, {
            runId: run.id,
            capturedAt: snapshot.createdAt,
            converterVersion: BENCHLING_MIGRATION_PROJECTION_VERSION,
            links: linksBySourceObjectId.get(sourceObject.id),
            ...(allocation
              ? {
                  destination: allocation.destination,
                  destinationEntityId: allocation.destinationEntityId,
                }
              : {}),
          }),
        createdAt: now(),
        deferReadbackUntilValidation: true,
        ...(allocation
          ? {
              onInstallState: (nextState: 'staged' | 'installed') =>
                advancePersistedBenchlingMigrationAllocation({
                  workspacePath: run.workspacePath,
                  actionId: run.id,
                  sourceObjectId: sourceObject.id,
                  nextState,
                  updatedAt: now(),
                }).then(() => undefined),
            }
          : {}),
      };
    });
    if (!usePreparedProjectionPlans) {
      emitPhaseTiming(
        deps,
        'projection_plan_build',
        projectionPlanStartedAt,
        monotonicNow,
        pendingProjectionItems.length
      );
    }
    const canInstallFreshBatch =
      usesDefaultProjectionWriter &&
      !run.externalZipSource &&
      existingReceipts.length === 0 &&
      pendingSourceObjects.length === sourceObjects.length &&
      pendingProjectionItems.length > 0;
    if (canInstallFreshBatch) {
      for (const _item of pendingProjectionItems) await enforceCheckpoint(run, deps, now);
      const projectionInstallStartedAt = monotonicNow();
      newReceipts.push(
        ...(await writeFreshProjectionBatch({
          workspacePath: run.workspacePath,
          items: pendingProjectionItems,
        }))
      );
      emitPhaseTiming(
        deps,
        'projection_install',
        projectionInstallStartedAt,
        monotonicNow,
        pendingProjectionItems.length
      );
    } else {
      const projectionInstallStartedAt = monotonicNow();
      for (
        let offset = 0;
        offset < pendingProjectionItems.length;
        offset += LOCAL_PROJECTION_CONCURRENCY
      ) {
        const chunk = pendingProjectionItems.slice(offset, offset + LOCAL_PROJECTION_CONCURRENCY);
        for (const _item of chunk) await enforceCheckpoint(run, deps, now);
        const results = await Promise.allSettled(chunk.map((item) => writeProjection(item)));
        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
        const chunkReceipts = results.flatMap((result) =>
          result.status === 'fulfilled' ? [result.value] : []
        );
        newReceipts.push(...chunkReceipts);
      }
      emitPhaseTiming(
        deps,
        'projection_install',
        projectionInstallStartedAt,
        monotonicNow,
        pendingProjectionItems.length
      );
    }
    for (const receipt of newReceipts) receipted.add(receipt.sourceObjectId);
    emitPhaseTiming(
      deps,
      'projection_objects',
      projectionObjectsStartedAt,
      monotonicNow,
      pendingSourceObjects.length
    );
    const receipts = [...existingReceipts, ...newReceipts];
    const projectionCollectionsStartedAt = monotonicNow();
    const collectionProjection = await projectLocalCollections({
      run,
      snapshot,
      sourceObjects,
      receipts,
      resolutions,
    });
    await persistMigrationDestinationLinkIndex({
      workspacePath: run.workspacePath,
      sourceObjects,
      receipts,
      collectionProjection,
      collectionLayout: collectionProjectionLayoutForRun(run),
    });
    emitPhaseTiming(
      deps,
      'projection_collections',
      projectionCollectionsStartedAt,
      monotonicNow,
      collectionProjection?.collections.length ?? 0
    );
    run = advanceMigrationRun(run, now());
    projectionStateUpdates.push(run);
    const projectionCommitStartedAt = monotonicNow();
    deps.store.commitLocalProjection({ receipts: newReceipts, runs: projectionStateUpdates });
    cachedReceipts = receipts;
    emitPhaseTiming(
      deps,
      'projection_commit',
      projectionCommitStartedAt,
      monotonicNow,
      newReceipts.length
    );
    deps.onRunUpdated?.(run);
    emitPhaseTiming(deps, 'projecting', phaseStartedAt, monotonicNow, receipts.length);
  }

  if (run.state === 'validating') {
    const phaseStartedAt = monotonicNow();
    await enforceCheckpoint(run, deps, now);
    if (
      run.converterVersions.destinationIntegrity !==
      BENCHLING_MIGRATION_DESTINATION_INTEGRITY_VERSION
    ) {
      run = {
        ...run,
        converterVersions: {
          ...run.converterVersions,
          destinationIntegrity: BENCHLING_MIGRATION_DESTINATION_INTEGRITY_VERSION,
        },
        updatedAt: now(),
      };
    }
    const snapshot = requireSnapshot(run.id, deps.store);
    cachedSourceObjects = undefined;
    cachedProjectionPlans = undefined;
    const sourceObjects = sortedSourceObjects(
      await deps.store.listSourceObjectValidationViewsCooperatively(run.id)
    );
    const resolutions = (cachedResolutions ??= deps.store.listRelationshipResolutions(run.id));
    const receipts = cachedReceipts;
    const selectedSourceObjectIds = sourceObjects.map((sourceObject) => sourceObject.id).sort();
    const { collectionProjection, scopedFolders } = await readLocalCollectionEvidence(run);
    const collectionLayout = collectionProjectionLayoutForRun(run);
    const projectionIntegrity = await verifyProjectionReceiptIntegrity({
      workspacePath: run.workspacePath,
      receipts,
      destinationArtifacts: {
        collectionDocumentPaths:
          collectionProjection?.collections.map((collection) =>
            nativeCollectionDocumentPath(collection, collectionLayout)
          ) ?? [],
        nativeFolderPaths: collectionProjection
          ? [...nativeFolderPathMap(collectionProjection, collectionLayout).values()]
          : [],
      },
    });
    const renderChecks =
      projectionIntegrity.failures.length === 0
        ? await deps.renderValidator({
            run,
            sourceObjects,
            receipts,
            resolutions,
            selectedSourceObjectIds,
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
      undefined,
      run.externalZipSource,
      run.externalZipEntries
    );
    const report = generateValidationReport({
      run,
      ...(run.externalZipSource
        ? {
            nativeImportAction: {
              actionId: run.id,
              selectedSourceObjectIds: sourceObjects.map((sourceObject) => sourceObject.id),
              destinationChanges: summarizeActionDestinationChanges(
                await readBenchlingMigrationActionJournal(run.workspacePath, run.id)
              ),
              history: 'new_workspace' as const,
              decisions: [],
              providerVersionConflictCount: 0,
              externalSourceIds: [run.externalZipSource.sourceId],
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
      collectionProjection,
      scopedFolders,
      expectedRenderObjectIds: selectedSourceObjectIds,
      renderChecks,
      resolutions,
      receipts,
      projectionIntegrity,
      generatedAt: now(),
    });
    if (!report.passed) {
      const blocking = report.issues.filter((candidate) => candidate.blocking);
      const fallbackEntryPaths =
        run.externalZipSource &&
        run.scope.kind === 'file' &&
        run.workspaceOrigin?.kind === 'migration_created'
          ? selectBestEffortRenderFallbackPaths({
              expectedSourceObjectIds: selectedSourceObjectIds,
              renderChecks,
              blockingIssues: blocking,
              sourceObjects,
              sourceEntries: run.externalZipEntries ?? [],
              alreadyFallbackEntryPaths: run.localBestEffortFallback?.entryPaths,
            })
          : [];
      const sourceById = new Map(sourceObjects.map((source) => [source.id, source]));
      const specific = blocking.find(
        (candidate) =>
          candidate.sourceObjectId && sourceById.get(candidate.sourceObjectId)?.sourcePath
      );
      const first = specific ?? blocking[0];
      const sourcePath = first?.sourceObjectId
        ? sourceById.get(first.sourceObjectId)?.sourcePath
        : undefined;
      const sourceFileName = sourcePath ? basename(sourcePath.replaceAll('\\', '/')) : undefined;
      const issue: MigrationIssue = {
        code: 'validation_failed',
        message: first?.message ?? 'DNAForge could not verify this Benchling export.',
        blocking: true,
        ...(first?.sourceObjectId ? { sourceObjectId: first.sourceObjectId } : {}),
        ...(sourceFileName ? { sourceFileName } : {}),
        ...(fallbackEntryPaths.length > 0
          ? { details: { bestEffortFallbackEntryPaths: fallbackEntryPaths } }
          : {}),
      };
      run = transitionMigrationRun(run, 'failed', now(), issue);
      deps.store.commitLocalValidation(report, run);
      deps.onRunUpdated?.(run);
      throw new LocalBundleMigrationFailedError(run);
    }
    const readyRun = advanceMigrationRun(run, now());
    await deps.persistPassedReport?.(readyRun, report);
    run = readyRun;
    deps.store.commitLocalValidation(report, run);
    deps.onRunUpdated?.(run);
    emitPhaseTiming(deps, 'validating', phaseStartedAt, monotonicNow, sourceObjects.length);
  }

  if (run.state !== 'ready_to_unlock') {
    throw new Error(`Local export run stopped unexpectedly in state ${run.state}.`);
  }
  return completedResult(run, deps.store);
}

function provenCompletedZeroSourceProjection(
  run: MigrationRun,
  store: MigrationStore
):
  | {
      sourceObjectCount: 0;
      destinationArtifacts: ValidationDestinationArtifactEvidence[];
    }
  | undefined {
  if (run.state !== 'ready_to_unlock') return undefined;
  const snapshot = store.getSourceSnapshot(run.id);
  const report = store.getValidationReport(run.id);
  if (
    !snapshot ||
    !report?.passed ||
    !isValidationReportV2(report) ||
    !report.destinationIntegrity ||
    report.destinationIntegrity.receiptCount !== 0 ||
    report.converterVersions?.projection !== run.converterVersions.projection
  ) {
    return undefined;
  }
  const persistedCount = store.listSourceObjects(run.id).length;
  return persistedCount === 0 &&
    snapshot.expectedSourceObjectCount === persistedCount &&
    report.sourceObjects.expected === persistedCount &&
    report.sourceObjects.actual === persistedCount &&
    report.sourceObjects.passed
    ? {
        sourceObjectCount: 0,
        destinationArtifacts: report.destinationIntegrity.artifacts.map((artifact) => ({
          ...artifact,
        })),
      }
    : undefined;
}

async function proveZeroSourceProjectionResumeSafe(
  run: MigrationRun,
  store: MigrationStore
): Promise<
  | {
      sourceObjectCount: 0;
      destinationArtifacts: ValidationDestinationArtifactEvidence[];
    }
  | undefined
> {
  const completedProof = provenCompletedZeroSourceProjection(run, store);
  if (completedProof) return completedProof;

  const durablePhase =
    run.state === 'paused' || run.state === 'cancelled_preserved' || run.state === 'action_required'
      ? run.resumeState
      : run.state;
  if (
    (durablePhase !== 'projecting' && durablePhase !== 'validating') ||
    run.scope.kind === 'file' ||
    run.scope.acquisition !== 'local_bundle' ||
    run.converterVersions.projection !== BENCHLING_MIGRATION_PROJECTION_VERSION
  ) {
    return undefined;
  }

  const snapshot = store.getSourceSnapshot(run.id);
  const sourceObjects = store.listSourceObjects(run.id);
  if (
    !snapshot ||
    snapshot.expectedSourceObjectCount !== 0 ||
    snapshot.expectedAttachmentCount !== 0 ||
    snapshot.expectedMembershipCount !== 0 ||
    sourceObjects.length !== 0 ||
    store.listRelationshipResolutions(run.id).length !== 0
  ) {
    return undefined;
  }

  try {
    const collectionProjection = await buildLocalCollectionProjection({
      run,
      snapshot,
      sourceObjects: [],
      receipts: [],
      resolutions: [],
    });
    if (!collectionProjection || collectionProjection.collections.length === 0) return undefined;
    const destinationIndex = buildMigrationDestinationLinkIndexWriterPayload(
      buildMigrationDestinationIndexEntries({
        sourceObjects: [],
        receipts: [],
        collectionProjection,
        collectionLayout: collectionProjectionLayoutForRun(run),
      })
    );
    const artifacts: ValidationDestinationArtifactEvidence[] = [
      expectedArtifact(
        'collection_projection_manifest',
        '.dnaforge/migration/collection-projection.json',
        serializeCollectionProjection(collectionProjection)
      ),
      expectedArtifact(
        'destination_link_index',
        destinationIndex.relativePath,
        destinationIndex.text
      ),
      ...collectionProjection.collections.map((collection) =>
        expectedArtifact(
          'native_collection',
          nativeCollectionDocumentPath(collection, collectionProjectionLayoutForRun(run)),
          `${JSON.stringify(collection, null, 2)}\n`
        )
      ),
      ...[
        ...nativeFolderPathMap(
          collectionProjection,
          collectionProjectionLayoutForRun(run)
        ).values(),
      ].map((path) => expectedArtifact('native_folder', `${path}/.gitkeep`, '')),
    ];
    return { sourceObjectCount: 0, destinationArtifacts: artifacts };
  } catch {
    return undefined;
  }
}

function expectedArtifact(
  kind: ValidationDestinationArtifactEvidence['kind'],
  path: string,
  contents: string
): ValidationDestinationArtifactEvidence {
  return {
    kind,
    path,
    sha256: createHash('sha256').update(contents).digest('hex'),
  };
}

function requireCurrentLocalRun(requestedRun: MigrationRun, store: MigrationStore): MigrationRun {
  const current = store.getRun();
  if (!current || current.id !== requestedRun.id) {
    throw new Error('The persisted local export run does not match the requested run.');
  }
  if (
    current.workspacePath !== requestedRun.workspacePath ||
    JSON.stringify(current.scope) !== JSON.stringify(requestedRun.scope) ||
    current.scope.acquisition !== 'local_bundle' ||
    current.binding !== null ||
    !(current.localExportArtifact || current.externalZipSource)
  ) {
    throw new Error('The migration run is not an exact provider-free local export run.');
  }
  return current;
}

function verifiedArtifactFromRun(run: MigrationRun): VerifiedLocalBenchlingExportArtifact {
  if (run.externalZipSource) {
    const source = run.externalZipSource;
    return {
      schema: 'dnaforge.benchling.local-export-artifact.v1',
      logicalFilename: source.displayName,
      sha256: source.zipSha256,
      sizeBytes: source.sizeBytes,
      immutableLocalPath: source.originalPath,
      format: 'zip',
      resources: [],
      nativeExportDecoderSource: externalZipDecoderSource(source),
      archive: {
        entryCount: run.externalZipEntries?.length ?? 0,
        totalCompressedEntryBytes: source.sizeBytes,
        totalUncompressedEntryBytes: (run.externalZipEntries ?? []).reduce(
          (total, entry) => total + entry.sizeBytes,
          0
        ),
      },
    };
  }
  const artifact = run.localExportArtifact;
  if (!artifact) throw new Error('Local export artifact metadata is missing.');
  const base = {
    schema: artifact.schema,
    logicalFilename: artifact.logicalFilename,
    sha256: artifact.sha256,
    sizeBytes: artifact.sizeBytes,
    immutableLocalPath: artifact.immutableLocalPath,
  } as const;
  if (artifact.format === 'html') {
    if (artifact.archive !== null) throw new Error('Local HTML artifact has ZIP metadata.');
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

function artifactTime(run: MigrationRun): string {
  const value = run.externalZipSource?.selectedAt ?? run.localExportArtifact?.capturedAt;
  if (!value || !Number.isFinite(Date.parse(value))) {
    throw new Error('Local export capture time is invalid.');
  }
  return new Date(value).toISOString();
}

async function persistCapture(
  run: MigrationRun,
  capture: LocalBenchlingExportCapture,
  archive: ContentArchive,
  store: MigrationStore,
  completedParsingRun: MigrationRun
): Promise<void> {
  const artifact = verifiedArtifactFromRun(run);
  if (
    capture.localArtifact.sha256 !== artifact.sha256 ||
    capture.localArtifact.sizeBytes !== artifact.sizeBytes ||
    capture.localArtifact.logicalFilename !== artifact.logicalFilename ||
    capture.localArtifact.format !== artifact.format ||
    capture.capturedAt !== artifactTime(run)
  ) {
    throw new Error('Decoded local export capture does not match the immutable run artifact.');
  }
  const localParts = capture.rawParts.filter((part) => part.kind === 'local_export');
  if (localParts.length !== 1) {
    throw new Error('Local export capture requires exactly one immutable top-level part.');
  }
  const [archivePart] = localParts;
  const sourceIds = new Set(capture.sourceObjects.map((sourceObject) => sourceObject.id));
  if (
    sourceIds.size !== capture.sourceObjects.length ||
    (run.scope.kind !== 'folder' && sourceIds.size === 0) ||
    new Set(capture.manifest.sourceObjectIds).size !== sourceIds.size ||
    capture.manifest.sourceObjectIds.some((sourceObjectId) => !sourceIds.has(sourceObjectId))
  ) {
    throw new Error('Local export capture has inconsistent source-object evidence.');
  }

  const entries: LogicalContentManifestEntry[] = [];
  for (const [index, rawPart] of capture.rawParts.entries()) {
    if (run.externalZipSource) {
      if (rawPart.kind === 'local_export') continue;
      if (!rawPart.sourceObjectId) {
        throw new Error(`External source entry ${rawPart.id} has no decoded owner.`);
      }
      const evidence = run.externalZipEntries?.find(
        (entry) =>
          entry.entryPath === rawPart.sourceArchivePath &&
          entry.entrySha256 === `sha256:${rawPart.expectedSha256}` &&
          entry.sizeBytes === rawPart.expectedSizeBytes
      );
      if (!evidence) {
        throw new Error(`External source entry ${rawPart.id} has no exact persisted evidence.`);
      }
      entries.push({
        logicalFilename: rawPart.logicalFilename,
        sourceArchivePath: rawPart.sourceArchivePath,
        sha256: rawPart.expectedSha256,
        size: rawPart.expectedSizeBytes,
        archivePartId: archivePart.id,
        sourceObjectId: rawPart.sourceObjectId,
      });
      continue;
    }
    const blob = await archive.assertBlobPresent(rawPart.expectedSha256, rawPart.expectedSizeBytes);
    if (resolve(blob.path) !== resolve(rawPart.localPath)) {
      throw new Error(`Local raw part ${rawPart.id} is outside the immutable content archive.`);
    }
    if (rawPart.kind !== 'local_export' && !rawPart.sourceObjectId) {
      throw new Error(`Local retained entry ${rawPart.id} has no decoded owner.`);
    }
    entries.push({
      logicalFilename: rawPart.logicalFilename,
      sourceArchivePath:
        rawPart.kind === 'source_record'
          ? rawPart.sourceArchivePath
          : `local-bundle/part-${index + 1}-${rawPart.kind}${safeEvidenceExtension(rawPart.logicalFilename)}`,
      sha256: blob.sha256,
      size: blob.size,
      archivePartId: archivePart.id,
      sourceObjectId: rawPart.kind === 'local_export' ? null : rawPart.sourceObjectId,
    });
  }
  const manifestId = run.externalZipSource
    ? migrationEvidenceId('external-source', run.externalZipSource.sourceId)
    : migrationEvidenceId('snapshot', capture.snapshotId);
  if (!run.externalZipSource) {
    await archive.writeManifest(manifestId, { version: 1, entries });
  }
  const snapshot: SourceSnapshot = {
    version: run.version,
    id: capture.snapshotId,
    runId: run.id,
    accountHash: artifact.sha256,
    createdAt: capture.capturedAt,
    archiveManifestId: manifestId,
    initialSourceObjectIds: [...sourceIds].sort(),
    expectedSourceObjectCount: sourceIds.size,
    expectedAttachmentCount: new Set(
      capture.manifest.attachmentReferences.map(
        (reference) => `${reference.sourceObjectId}\0${reference.sha256}`
      )
    ).size,
    expectedMembershipCount: new Set(
      capture.manifest.membershipReferences.map(
        (reference) => `${reference.sourceObjectId}\0${reference.collectionId}`
      )
    ).size,
    ...(capture.warnings.length > 0 ? { localExportWarnings: [...capture.warnings] } : {}),
    ...(capture.nativeFolderZipInventory
      ? { localNativeFolderZipInventory: capture.nativeFolderZipInventory }
      : {}),
    parts: [
      {
        id: archivePart.id,
        kind: 'local_export',
        sha256: archivePart.expectedSha256,
        sizeBytes: archivePart.expectedSizeBytes,
        capturedAt: capture.capturedAt,
        sourceJobId: null,
        sourceObjectId: null,
        supersedesPartId: null,
      },
    ],
  };
  await persistLocalScopedBoundary(run, capture);
  store.commitLocalSourceCapture({
    sourceObjects: capture.sourceObjects,
    snapshot,
    run: completedParsingRun,
  });
}

async function persistLocalScopedBoundary(
  run: MigrationRun,
  capture: LocalBenchlingExportCapture
): Promise<void> {
  if (run.scope.kind === 'file') {
    if (capture.hierarchy !== null) {
      throw new Error('A local File export unexpectedly decoded Folder hierarchy evidence.');
    }
    return;
  }
  const scopedRun = { ...run, scope: run.scope };
  const sourceIdentityHash = requireLocalSourceIdentityHash(run);
  const folders = localScopedFolders(scopedRun, capture, sourceIdentityHash);
  await persistScopedFolderBoundary({
    workspacePath: run.workspacePath,
    runId: run.id,
    scope: scopedRun.scope,
    sourceAccountHash: sourceIdentityHash,
    folders,
  });
}

function localScopedFolders(
  run: MigrationRun & { scope: Exclude<MigrationRun['scope'], { kind: 'file' }> },
  capture: LocalBenchlingExportCapture,
  sourceIdentityHash: string
): ScopedFolderMetadata[] {
  const hierarchy = capture.hierarchy;
  const selectedRoot = run.scope.kind === 'folder' ? run.scope.folder : run.scope.roots[0];
  if (
    !hierarchy ||
    hierarchy.scopeKind !== run.scope.kind ||
    (run.scope.kind === 'folder_tree' && run.scope.roots.length !== 1) ||
    !selectedRoot ||
    hierarchy.rootFolderId !== selectedRoot.id ||
    hierarchy.selectedSourceObjectCount !== capture.sourceObjects.length
  ) {
    throw new Error('Decoded local export hierarchy does not match the selected Folder scope.');
  }

  const folderById = new Map(hierarchy.folders.map((folder) => [folder.id, folder]));
  if (folderById.size !== hierarchy.folders.length) {
    throw new Error('Decoded local export hierarchy contains duplicate folder identities.');
  }
  const root = folderById.get(hierarchy.rootFolderId);
  if (!root || root.depth !== 0 || root.parentId !== null || !root.included) {
    throw new Error('Decoded local export hierarchy has no exact selected root.');
  }

  const includedFolderIds = new Set(
    hierarchy.folders.filter((folder) => folder.included).map((folder) => folder.id)
  );
  const selectedSourceObjects = capture.sourceObjects.filter((sourceObject) =>
    sourceObject.memberships.some((membership) => includedFolderIds.has(membership))
  );
  const exactOneHopDependencyIds =
    run.scope.kind === 'folder'
      ? new Set(
          resolveOfflineRelationships({
            sourceObjects: capture.sourceObjects,
            relationships: selectedSourceObjects.flatMap(
              (sourceObject) => sourceObject.relationships
            ),
            benchlingOrigin: benchlingOrganizationBaseUrlFromSourceRef(selectedRoot) ?? undefined,
            selectedSnapshotStableIdsAreAuthoritative: true,
          }).resolutions.flatMap((resolution) =>
            resolution.classification === 'exact' && resolution.targetSourceId
              ? [resolution.targetSourceId]
              : []
          )
        )
      : new Set<string>();
  for (const sourceObject of capture.sourceObjects) {
    const memberships = [...new Set(sourceObject.memberships)].sort();
    const directFolderSelected =
      run.scope.kind === 'folder' &&
      memberships.length === 1 &&
      memberships[0] === hierarchy.rootFolderId;
    const directFolderDependency =
      run.scope.kind === 'folder' &&
      memberships.length === 0 &&
      exactOneHopDependencyIds.has(sourceObject.id) &&
      sourceObject.relationships.length === 0;
    const validCardinality =
      run.scope.kind === 'folder'
        ? directFolderSelected || directFolderDependency
        : memberships.length > 0;
    if (
      memberships.length !== sourceObject.memberships.length ||
      !validCardinality ||
      memberships.some((membership) => !includedFolderIds.has(membership)) ||
      (run.scope.kind === 'folder' &&
        memberships.length > 0 &&
        memberships[0] !== hierarchy.rootFolderId)
    ) {
      throw new Error(
        `Decoded local source object ${sourceObject.id} has invalid folder membership.`
      );
    }
  }

  if (run.scope.kind === 'folder') {
    const directChildren = hierarchy.folders.filter((folder) => folder.depth === 1);
    const excludedByPath = new Map(
      hierarchy.excludedChildFolders.map((folder) => [folder.relativePath, folder])
    );
    if (
      includedFolderIds.size !== 1 ||
      !includedFolderIds.has(hierarchy.rootFolderId) ||
      hierarchy.excludedChildFolderCount !== directChildren.length ||
      hierarchy.excludedChildFolderCount !== hierarchy.excludedChildFolders.length ||
      !Number.isSafeInteger(hierarchy.excludedSourceObjectCount) ||
      hierarchy.excludedSourceObjectCount < 0 ||
      hierarchy.excludedSourceObjectCount >
        hierarchy.excludedChildFolders.reduce(
          (count, folder) => count + folder.sourceObjectCount,
          0
        ) ||
      directChildren.some((folder) => {
        const excluded = excludedByPath.get(folder.relativePath);
        return (
          folder.included ||
          folder.parentId !== hierarchy.rootFolderId ||
          !excluded ||
          excluded.name !== folder.name ||
          !Number.isSafeInteger(excluded.sourceObjectCount) ||
          excluded.sourceObjectCount < 0
        );
      })
    ) {
      throw new Error('Decoded Direct Folder hierarchy has incomplete excluded-child evidence.');
    }
  } else if (
    hierarchy.folders.some((folder) => !folder.included) ||
    hierarchy.excludedChildFolderCount !== 0 ||
    hierarchy.excludedChildFolders.length !== 0 ||
    hierarchy.excludedSourceObjectCount !== 0
  ) {
    throw new Error('Decoded Folder Tree hierarchy contains excluded descendant evidence.');
  }

  const persistedFolders = hierarchy.folders.filter(
    (folder) => run.scope.kind === 'folder_tree' || folder.depth <= 1
  );
  return persistedFolders
    .map(
      (folder): ScopedFolderMetadata => ({
        ref: {
          id: folder.id,
          url:
            folder.id === hierarchy.rootFolderId
              ? selectedRoot.url
              : localHierarchySourceUrl(selectedRoot, folder.id),
          objectType: 'folder',
        },
        name: folder.name,
        parentFolderId: folder.parentId,
        childrenEnumerated: true,
        sourceAccountHash: sourceIdentityHash,
      })
    )
    .sort((left, right) => left.ref.id.localeCompare(right.ref.id));
}

export async function projectLocalCollections(input: {
  run: MigrationRun;
  actionId?: string;
  snapshot: SourceSnapshot;
  sourceObjects: SourceObject[];
  receipts: ProjectionReceipt[];
  resolutions: RelationshipResolution[];
  relationshipBenchlingOrigin?: string;
  workspaceAppendHierarchyCaptures?: readonly WorkspaceAppendHierarchyCapture[];
  materializedSourceIds?: ReadonlySet<string>;
  selectedFolderIds?: ReadonlySet<string>;
}): Promise<CollectionProjection | null> {
  const projection = await buildLocalCollectionProjection(input);
  if (projection) {
    await writeCollectionProjection({
      workspacePath: input.run.workspacePath,
      projection,
      layout: collectionProjectionLayoutForRun(input.run),
    });
  }
  return projection;
}

export function collectionProjectionLayoutForRun(run: MigrationRun): CollectionProjectionLayout {
  return run.externalZipSource || run.baseline?.kind === 'adopted_workspace'
    ? 'native-v2'
    : 'legacy-v1';
}

async function buildLocalCollectionProjection(input: {
  run: MigrationRun;
  snapshot: SourceSnapshot;
  sourceObjects: SourceObject[];
  receipts: ProjectionReceipt[];
  resolutions: RelationshipResolution[];
  relationshipBenchlingOrigin?: string;
  workspaceAppendHierarchyCaptures?: readonly WorkspaceAppendHierarchyCapture[];
  materializedSourceIds?: ReadonlySet<string>;
}): Promise<CollectionProjection | null> {
  if (input.run.scope.kind === 'file') return null;
  const sourceIdentityHash = requireLocalSourceIdentityHash(input.run);
  const folders = await readScopedFolderBoundary({
    workspacePath: input.run.workspacePath,
    runId: input.run.id,
    scope: input.run.scope,
    sourceAccountHash: sourceIdentityHash,
  });
  const root =
    input.run.scope.kind === 'folder' ? input.run.scope.folder : input.run.scope.roots[0];
  if (!root) throw new Error('Local Folder Tree projection requires exactly one selected root.');
  const folderAuthority = mergeWorkspaceAppendFolderAuthority({
    scope: input.run.scope,
    sourceAccountHash: sourceIdentityHash,
    scopedFolders: folders,
    captures: input.workspaceAppendHierarchyCaptures ?? [],
  });
  const includedFolderIds =
    input.run.scope.kind === 'folder'
      ? [input.run.scope.folder.id, ...folderAuthority.appendedFolderIds]
      : folderAuthority.folders.map((folder) => folder.ref.id);
  const projection = buildCollectionProjection({
    scope: input.run.scope,
    sourceAccountHash: sourceIdentityHash,
    capturedAt: input.snapshot.createdAt,
    folders,
    workspaceAppendHierarchyCaptures: input.workspaceAppendHierarchyCaptures,
    sourceObjects: input.sourceObjects.map((sourceObject) => ({
      ...sourceObject,
      sourceUrl: localHierarchySourceUrl(root, `item-${sourceObject.id}`),
    })),
    relationshipResolutions: input.resolutions,
    selectedSnapshotStableIdsAreAuthoritative: true,
    materializedSourceIds: input.materializedSourceIds,
    relationshipBenchlingOrigin: input.relationshipBenchlingOrigin,
    destinationCollectionIds: Object.fromEntries(
      includedFolderIds.map((sourceFolderId) => [
        sourceFolderId,
        collectionDestinationId(sourceFolderId),
      ])
    ),
    destinationObjectIds: Object.fromEntries(
      input.receipts.map((receipt) => [receipt.sourceObjectId, receipt.destinationObjectId])
    ),
  });
  if (input.run.state !== 'unlocked' || collectionProjectionLayoutForRun(input.run) !== 'native-v2')
    return projection;
  const manifest = parseNativeWorkspaceManifest(
    (
      await readBoundedWorkspaceFile(input.run.workspacePath, NATIVE_WORKSPACE_MANIFEST_PATH)
    ).toString('utf8')
  );
  return preserveNativeFolderPlacements(projection, manifest.entities);
}

export async function readLocalCollectionEvidence(run: MigrationRun): Promise<{
  collectionProjection: CollectionProjection | null;
  scopedFolders: ScopedFolderMetadata[];
}> {
  if (run.scope.kind === 'file') {
    return { collectionProjection: null, scopedFolders: [] };
  }
  const sourceIdentityHash = requireLocalSourceIdentityHash(run);
  let scopedFolders: ScopedFolderMetadata[] = [];
  let collectionProjection: CollectionProjection | null = null;
  try {
    scopedFolders = await readScopedFolderBoundary({
      workspacePath: run.workspacePath,
      runId: run.id,
      scope: run.scope,
      sourceAccountHash: sourceIdentityHash,
    });
  } catch {}
  try {
    collectionProjection = await readCollectionProjection(run.workspacePath);
  } catch {}
  return { collectionProjection, scopedFolders };
}

function requireLocalSourceIdentityHash(run: MigrationRun): string {
  const sourceIdentityHash = migrationRunSourceIdentityHash(run);
  if (!sourceIdentityHash) {
    throw new Error('Local export run has no immutable artifact source identity.');
  }
  return sourceIdentityHash;
}

function localHierarchySourceUrl(root: BenchlingSourceRef, sourceId: string): string {
  if (isLocalExportNamespaceUrl(root.url)) return localExportNamespacedUrl(root.url, sourceId);
  const url = new URL(root.url);
  url.search = '';
  url.hash = '';
  const basePath = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  url.pathname = `${basePath}_dnaforge-local-export/${encodeURIComponent(sourceId)}`;
  return url.toString();
}

function safeEvidenceExtension(logicalFilename: string): string {
  const extension = extname(logicalFilename).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/u.test(extension) ? extension : '.bin';
}

export function persistOfflineResolutions(
  run: MigrationRun,
  store: MigrationStore,
  benchlingOrigin?: string,
  cachedSourceObjects?: readonly SourceObject[]
): void {
  store.putRelationshipResolutions(
    run.id,
    resolveLocalOfflineRelationships(run, store, cachedSourceObjects, benchlingOrigin)
  );
}

function resolveLocalOfflineRelationships(
  run: MigrationRun,
  store: MigrationStore,
  cachedSourceObjects?: readonly SourceObject[],
  authoritativeBenchlingOrigin?: string
): RelationshipResolution[] {
  const sourceObjects = cachedSourceObjects
    ? sortedSourceObjects(cachedSourceObjects)
    : sortedSourceObjects(store.listSourceObjects(run.id));
  const organizationBaseUrl = authoritativeBenchlingOrigin ?? localSnapshotOrganizationBaseUrl(run);
  const result = resolveOfflineRelationships({
    sourceObjects,
    relationships: sourceObjects.flatMap((sourceObject) => sourceObject.relationships),
    ...(organizationBaseUrl ? { benchlingOrigin: organizationBaseUrl } : {}),
    selectedSnapshotStableIdsAreAuthoritative: true,
  });
  return result.resolutions;
}

async function prepareProjectionWorkWhileMaterializing(
  run: MigrationRun,
  preparedZip: PreparedLocalBenchlingExportZip,
  projectionPlanner: typeof buildLocalProjectionPlansInDedicatedWorker,
  deps: LocalBundleExecutorDeps,
  monotonicNow: () => number
): Promise<{
  sourceObjects: SourceObject[];
  resolutions: RelationshipResolution[];
  plansBySourceObjectId: ReadonlyMap<string, ReturnType<typeof buildProjectionPlan>>;
  allocations: readonly BenchlingMigrationActionAllocation[];
}> {
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  const sourceObjects = sortedSourceObjects(preparedZip.sourceObjects);
  const resolutionStartedAt = monotonicNow();
  const organizationBaseUrl = localSnapshotOrganizationBaseUrl(run);
  const resolutions = resolveOfflineRelationships({
    sourceObjects,
    relationships: sourceObjects.flatMap((sourceObject) => sourceObject.relationships),
    ...(organizationBaseUrl ? { benchlingOrigin: organizationBaseUrl } : {}),
    selectedSnapshotStableIdsAreAuthoritative: true,
  }).resolutions;
  emitPhaseTiming(
    deps,
    'offline_resolution_compute',
    resolutionStartedAt,
    monotonicNow,
    resolutions.length
  );
  const projectionPlanStartedAt = monotonicNow();
  const actionJournal = await reserveBenchlingMigrationAction({
    run,
    actionId: run.id,
    sourceObjects,
    decisions: deps.store.listImportDecisions(run.id, run.id),
    destinationDb: deps.destinationDb,
    now: preparedZip.capturedAt,
  });
  const plansBySourceObjectId = new Map<string, ReturnType<typeof buildProjectionPlan>>();
  const planned = await projectionPlanner({
    schema: LOCAL_PROJECTION_WORKER_JOB_SCHEMA,
    runId: run.id,
    capturedAt: preparedZip.capturedAt,
    converterVersion: BENCHLING_MIGRATION_PROJECTION_VERSION,
    sourceObjects,
    resolutions,
    allocations: actionJournal.allocations,
  });
  const expectedIds = new Set(sourceObjects.map((sourceObject) => sourceObject.id));
  for (const entry of planned.plans) {
    if (!expectedIds.has(entry.sourceObjectId) || plansBySourceObjectId.has(entry.sourceObjectId)) {
      throw new Error('Local projection worker returned an unexpected or duplicate object plan.');
    }
    plansBySourceObjectId.set(entry.sourceObjectId, entry.plan);
  }
  if (plansBySourceObjectId.size !== sourceObjects.length) {
    throw new Error('Local projection worker did not return every selected object plan.');
  }
  emitPhaseTiming(
    deps,
    'projection_plan_build',
    projectionPlanStartedAt,
    monotonicNow,
    plansBySourceObjectId.size
  );
  return {
    sourceObjects,
    resolutions,
    plansBySourceObjectId,
    allocations: actionJournal.allocations,
  };
}

function emitPhaseTiming(
  deps: LocalBundleExecutorDeps,
  phase: LocalBundleTimedPhase,
  startedAt: number,
  monotonicNow: () => number,
  itemCount: number
): void {
  const durationMs = Math.max(0, monotonicNow() - startedAt);
  try {
    deps.onPhaseTiming?.({ phase, durationMs, itemCount });
  } catch {}
}

export function localSnapshotOrganizationBaseUrl(run: MigrationRun): string | null {
  if (run.scope.kind === 'file') return null;
  const root = run.scope.kind === 'folder' ? run.scope.folder : run.scope.roots[0];
  if (!root) throw new Error('Local Folder export has no selected root authority.');
  return benchlingOrganizationBaseUrlFromSourceRef(root);
}

export function projectionLinksBySourceObjectId(
  sourceObjects: SourceObject[],
  resolutions: RelationshipResolution[],
  receipts: ProjectionReceipt[]
) {
  const destinationIdBySource = new Map(
    receipts.map((receipt) => [receipt.sourceObjectId, receipt.destinationObjectId])
  );
  return buildOutboundLocalLinkMap({
    resolutions,
    sourceObjects,
    receipts: sourceObjects.map((sourceObject) => {
      const destinationObjectId =
        destinationIdBySource.get(sourceObject.id) ?? projectionDestinationObjectId(sourceObject);
      return {
        sourceObjectId: sourceObject.id,
        destinationObjectId,
        destinationPath: `entity://migration/${destinationObjectId}`,
      };
    }),
  });
}

export async function verifyLocalSnapshotArchiveIntegrity(
  snapshot: SourceSnapshot,
  archive: ContentArchive,
  sourceObjects: readonly SourceObject[] = [],
  onProgress?: (progress: LocalArchiveIntegrityProgress) => void,
  externalZipSource?: MigrationRun['externalZipSource'],
  externalZipEntries?: readonly ExternalZipEntryEvidence[],
  externalSupplementalZips: readonly ExternalSupplementalZipEvidence[] = [],
  adoptedWorkspaceBaseline = false
): Promise<{
  evidence: ArchiveIntegrityEvidence;
  failures: Array<{ evidenceId: string; message: string }>;
}> {
  const evidence: ArchiveIntegrityEvidence = { manifestEntries: [], snapshotParts: [] };
  const failures: Array<{ evidenceId: string; message: string }> = [];
  const verifiedExternalZips = new Map<string, Promise<string>>();
  const verifyExternalZipOnce = (source: NonNullable<MigrationRun['externalZipSource']>) => {
    const key = JSON.stringify([source.originalPath, source.zipSha256, source.sizeBytes]);
    let pending = verifiedExternalZips.get(key);
    if (!pending) {
      pending = verifyExternalZipSource(source);
      verifiedExternalZips.set(key, pending);
    }
    return pending;
  };
  const verifiedBlobs = new Map<
    string,
    Promise<Awaited<ReturnType<ContentArchive['verifyBlob']>>>
  >();
  const verifyBlobOnce = async (sha256: string, sizeBytes: number) => {
    const key = `${sha256}\0${sizeBytes}`;
    const existing = verifiedBlobs.get(key);
    if (existing) return existing;
    const pending = archive.verifyBlob(sha256, sizeBytes);
    verifiedBlobs.set(key, pending);
    return pending;
  };
  const verifyManifestOnce = async (
    manifestId: string,
    onEntryVerified?: (progress: Readonly<{ completed: number; total: number }>) => void
  ) => {
    const verified = await archive.readManifest(manifestId);
    let completed = 0;
    onEntryVerified?.({ completed, total: verified.entries.length });
    await forEachAtFixedConcurrency(
      verified.entries,
      ARCHIVE_BLOB_VERIFY_CONCURRENCY,
      async (entry) => {
        await verifyBlobOnce(entry.sha256, entry.size);
        completed += 1;
        onEntryVerified?.({ completed, total: verified.entries.length });
      }
    );
    return verified;
  };
  let manifest: Awaited<ReturnType<ContentArchive['verifyManifest']>> | null = null;
  const externalSupplementalBySha256 = new Map(
    externalSupplementalZips.map((record) => [
      record.source.zipSha256.slice('sha256:'.length),
      record,
    ])
  );
  try {
    if (externalZipSource) {
      await verifyExternalZipOnce(externalZipSource);
      if (!externalZipEntries) {
        throw new Error('External ZIP entry evidence is missing.');
      }
      const localPart = snapshot.parts.find(
        (part) => part.kind === 'local_export' && part.sourceObjectId === null
      );
      if (!localPart) throw new Error('External ZIP snapshot part is missing.');
      const objectIdByStableId = new Map(
        sourceObjects.map((sourceObject) => [sourceObject.stableId, sourceObject.id] as const)
      );
      manifest = {
        version: 1,
        entries: externalZipEntries.map((entry) => ({
          logicalFilename: basename(entry.entryPath),
          sourceArchivePath: entry.entryPath,
          sha256: entry.entrySha256.slice('sha256:'.length),
          size: entry.sizeBytes,
          archivePartId: localPart.id,
          sourceObjectId: objectIdByStableId.get(entry.sourceObjectId) ?? null,
        })),
      };
    } else if (adoptedWorkspaceBaseline) {
      if (
        snapshot.initialSourceObjectIds.length !== 0 ||
        snapshot.parts.some((part) => part.kind !== 'supplemental_local_export') ||
        !externalSupplementalZips.some((record) => record.source.zipSha256 === snapshot.accountHash)
      ) {
        throw new Error('Adopted workspace evidence must come from accepted supplemental ZIPs.');
      }
      manifest = { version: 1, entries: [] };
    } else {
      manifest = await verifyManifestOnce(snapshot.archiveManifestId);
    }
    const partById = new Map(snapshot.parts.map((part) => [part.id, part]));
    evidence.manifestEntries = manifest.entries.map((entry) => {
      const container = entry.archivePartId ? partById.get(entry.archivePartId) : undefined;
      return {
        manifestId: snapshot.archiveManifestId,
        archivePartId: entry.archivePartId ?? null,
        sourceObjectId: entry.sourceObjectId ?? null,
        entryPath: entry.sourceArchivePath,
        sha256: entry.sha256,
        sizeBytes: entry.size,
        ...(container?.kind === 'local_export'
          ? {
              containerSha256: container.sha256,
              containerSizeBytes: container.sizeBytes,
              containerPartId: container.id,
            }
          : {}),
      };
    });
  } catch {
    failures.push({
      evidenceId: `manifest:${snapshot.archiveManifestId}`,
      message: 'The immutable local export manifest failed SHA-256 or size verification.',
    });
  }
  for (const part of snapshot.parts) {
    const isExternalTopLevelPart = Boolean(
      externalZipSource &&
      part.kind === 'local_export' &&
      part.sourceObjectId === null &&
      part.sha256 === externalZipSource.zipSha256.slice('sha256:'.length) &&
      part.sizeBytes === externalZipSource.sizeBytes
    );
    const externalSupplemental =
      part.kind === 'supplemental_local_export'
        ? externalSupplementalBySha256.get(part.sha256)
        : undefined;
    const primaryExactAssociations =
      manifest?.entries.filter(
        (entry) =>
          entry.archivePartId === part.id &&
          (entry.sourceObjectId ?? null) === part.sourceObjectId &&
          entry.sha256 === part.sha256 &&
          entry.size === part.sizeBytes
      ) ?? [];
    try {
      if (isExternalTopLevelPart) {
        if (!externalZipSource) {
          throw new Error('External ZIP source evidence is missing.');
        }
        await verifyExternalZipOnce(externalZipSource);
      } else if (externalSupplemental) {
        await verifyExternalZipOnce(externalSupplemental.source);
      } else if (primaryExactAssociations.length !== 1) {
        await verifyBlobOnce(part.sha256, part.sizeBytes);
      }
      evidence.snapshotParts.push({
        partId: part.id,
        kind: part.kind,
        sourceJobId: part.sourceJobId,
        sourceObjectId: part.sourceObjectId,
        sha256: part.sha256,
        sizeBytes: part.sizeBytes,
      });
    } catch {
      failures.push({
        evidenceId: `snapshot-part:${part.id}`,
        message: `Immutable local export part ${part.id} failed SHA-256 or size verification.`,
      });
    }
    let associationManifest = manifest;
    let associationManifestId = snapshot.archiveManifestId;
    if (
      primaryExactAssociations.length === 0 &&
      (part.kind === 'targeted_read' || part.kind === 'supplemental_local_export')
    ) {
      associationManifestId = migrationEvidenceId(
        part.kind === 'targeted_read' ? 'targeted' : 'supplemental',
        part.id
      );
      try {
        associationManifest = externalSupplemental
          ? externalSupplementalManifest(part, externalSupplemental)
          : await verifyManifestOnce(associationManifestId);
        evidence.manifestEntries.push(
          ...associationManifest.entries.map((entry) => ({
            manifestId: associationManifestId,
            archivePartId: entry.archivePartId ?? null,
            sourceObjectId: entry.sourceObjectId ?? null,
            entryPath: entry.sourceArchivePath,
            sha256: entry.sha256,
            sizeBytes: entry.size,
          }))
        );
      } catch {
        associationManifest = null;
        failures.push({
          evidenceId: `manifest:${associationManifestId}`,
          message: `The immutable supplementary manifest for ${part.id} failed SHA-256 or size verification.`,
        });
      }
    }
    const exactAssociations =
      associationManifest?.entries.filter(
        (entry) =>
          entry.archivePartId === part.id &&
          (entry.sourceObjectId ?? null) === part.sourceObjectId &&
          entry.sha256 === part.sha256 &&
          entry.size === part.sizeBytes
      ) ?? [];
    if (!isExternalTopLevelPart && exactAssociations.length !== 1) {
      failures.push({
        evidenceId: `snapshot-part:${part.id}:manifest-association`,
        message: `Immutable local export part ${part.id} has no exact manifest association.`,
      });
    }
  }
  await verifySupplementalRawEntries({
    snapshot,
    sourceObjects,
    archive,
    evidence,
    failures,
    verifyBlobOnce,
    verifyManifestOnce,
    verifyExternalZipOnce,
    externalSupplementalBySha256,
    onProgress,
  });
  return { evidence, failures };
}

function externalSupplementalManifest(
  part: SourceSnapshot['parts'][number],
  evidence: ExternalSupplementalZipEvidence
): Awaited<ReturnType<ContentArchive['readManifest']>> {
  return {
    version: 1,
    entries: [
      {
        logicalFilename: evidence.source.displayName,
        sourceArchivePath: evidence.source.displayName,
        sha256: evidence.source.zipSha256.slice('sha256:'.length),
        size: evidence.source.sizeBytes,
        archivePartId: part.id,
        sourceObjectId: part.sourceObjectId,
      },
      ...evidence.entries
        .filter((entry) => entry.sourceObjectId === part.sourceObjectId)
        .map((entry) => ({
          logicalFilename: basename(entry.entryPath),
          sourceArchivePath: entry.entryPath,
          sha256: entry.entrySha256.slice('sha256:'.length),
          size: entry.sizeBytes,
          archivePartId: part.id,
          sourceObjectId: part.sourceObjectId,
        })),
    ],
  };
}

async function forEachAtFixedConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  async function runWorker(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker()));
}

type SupplementalRawReference = Readonly<{
  sourceObjectId: string;
  archivePartId: string;
  containerPartId: string;
  entryPath: string;
  sha256: string;
  sizeBytes: number;
}>;

async function verifySupplementalRawEntries(
  input: Readonly<{
    snapshot: SourceSnapshot;
    sourceObjects: readonly SourceObject[];
    archive: ContentArchive;
    evidence: ArchiveIntegrityEvidence;
    failures: Array<{ evidenceId: string; message: string }>;
    verifyBlobOnce: (
      sha256: string,
      sizeBytes: number
    ) => Promise<Awaited<ReturnType<ContentArchive['verifyBlob']>>>;
    verifyManifestOnce: (
      manifestId: string,
      onEntryVerified?: (progress: Readonly<{ completed: number; total: number }>) => void
    ) => Promise<Awaited<ReturnType<ContentArchive['readManifest']>>>;
    externalSupplementalBySha256: ReadonlyMap<string, ExternalSupplementalZipEvidence>;
    verifyExternalZipOnce: (
      source: NonNullable<MigrationRun['externalZipSource']>
    ) => Promise<string>;
    onProgress?: (progress: LocalArchiveIntegrityProgress) => void;
  }>
): Promise<void> {
  const supplementalPartsBySourceObjectId = new Map<string, SourceSnapshot['parts'][number][]>();
  for (const part of input.snapshot.parts) {
    if (part.kind !== 'supplemental_local_export' || part.sourceObjectId === null) continue;
    const parts = supplementalPartsBySourceObjectId.get(part.sourceObjectId) ?? [];
    parts.push(part);
    supplementalPartsBySourceObjectId.set(part.sourceObjectId, parts);
  }
  const referencesByContainer = new Map<
    string,
    { sha256: string; sizeBytes: number; references: SupplementalRawReference[] }
  >();

  for (const sourceObject of input.sourceObjects) {
    if (!sourceObject.content || typeof sourceObject.content !== 'object') continue;
    const content = sourceObject.content as Record<string, unknown>;
    const rawAccess = content.rawAccess;
    if (!rawAccess || typeof rawAccess !== 'object') continue;
    const raw = rawAccess as Record<string, unknown>;
    if (
      typeof raw.archivePartId !== 'string' ||
      typeof raw.entryPath !== 'string' ||
      typeof content.sha256 !== 'string' ||
      !Number.isSafeInteger(content.sizeBytes) ||
      (content.sizeBytes as number) < 0
    ) {
      continue;
    }
    const candidateParts = (supplementalPartsBySourceObjectId.get(sourceObject.id) ?? []).filter(
      (candidate) => raw.archivePartId === `supplemental-local-export:${candidate.sha256}`
    );
    const initialPart = input.snapshot.parts.find(
      (part) =>
        part.kind === 'local_export' &&
        part.id === raw.archivePartId &&
        part.sourceObjectId === null
    );
    const rawSourceHash = content.sha256.replace(/^sha256:/u, '');
    if (
      initialPart &&
      input.evidence.manifestEntries.some(
        (entry) =>
          entry.archivePartId === initialPart.id &&
          entry.containerPartId === initialPart.id &&
          entry.sourceObjectId === sourceObject.id &&
          entry.entryPath === raw.entryPath &&
          entry.sha256 === rawSourceHash &&
          entry.sizeBytes === content.sizeBytes &&
          entry.containerSha256 === initialPart.sha256 &&
          entry.containerSizeBytes === initialPart.sizeBytes
      )
    )
      continue;
    if (candidateParts.length !== 1) continue;
    const part = candidateParts[0];
    const normalizedSha256 = content.sha256
      .trim()
      .toLowerCase()
      .replace(/^sha256:/u, '');
    if (!/^[a-f0-9]{64}$/u.test(normalizedSha256) || raw.entryPath.length === 0) continue;
    const key = `${part.sha256}\0${part.sizeBytes}`;
    const group = referencesByContainer.get(key) ?? {
      sha256: part.sha256,
      sizeBytes: part.sizeBytes,
      references: [],
    };
    group.references.push({
      sourceObjectId: sourceObject.id,
      archivePartId: raw.archivePartId,
      containerPartId: part.id,
      entryPath: raw.entryPath,
      sha256: normalizedSha256,
      sizeBytes: content.sizeBytes as number,
    });
    referencesByContainer.set(key, group);
  }

  const totalReferences = [...referencesByContainer.values()].reduce(
    (total, group) => total + group.references.length,
    0
  );
  let persistedBeforeGroup = 0;
  let verifiedBeforeGroup = 0;
  if (totalReferences > 0) {
    input.onProgress?.({
      phase: 'persisting_source_files',
      completed: 0,
      total: totalReferences,
    });
  }

  for (const group of referencesByContainer.values()) {
    const references = [...group.references].sort((left, right) =>
      `${left.entryPath}\0${left.sourceObjectId}\0${left.archivePartId}\0${left.containerPartId}`.localeCompare(
        `${right.entryPath}\0${right.sourceObjectId}\0${right.archivePartId}\0${right.containerPartId}`
      )
    );
    const evidenceId = `supplemental-raw:${group.sha256}`;
    try {
      const uniquePaths = new Set(references.map((reference) => reference.entryPath));
      if (uniquePaths.size !== references.length) {
        throw new Error('Supplemental raw source paths are not uniquely associated.');
      }
      const external = input.externalSupplementalBySha256.get(group.sha256);
      if (external) {
        await input.verifyExternalZipOnce(external.source);
        for (const reference of references) {
          const entry = external.entries.find(
            (candidate) =>
              candidate.entryPath === reference.entryPath &&
              candidate.entrySha256 === `sha256:${reference.sha256}` &&
              candidate.sizeBytes === reference.sizeBytes &&
              candidate.sourceObjectId === reference.sourceObjectId
          );
          if (!entry) {
            throw new Error(`External source entry ${reference.entryPath} does not match.`);
          }
          input.evidence.manifestEntries.push({
            manifestId: migrationEvidenceId('external-source', external.source.sourceId),
            archivePartId: reference.archivePartId,
            sourceObjectId: reference.sourceObjectId,
            entryPath: reference.entryPath,
            sha256: reference.sha256,
            sizeBytes: reference.sizeBytes,
            containerSha256: group.sha256,
            containerSizeBytes: group.sizeBytes,
            containerPartId: reference.containerPartId,
          });
        }
        persistedBeforeGroup += references.length;
        verifiedBeforeGroup += references.length;
        input.onProgress?.({
          phase: 'persisting_source_files',
          completed: persistedBeforeGroup,
          total: totalReferences,
        });
        input.onProgress?.({
          phase: 'validating_source_files',
          completed: verifiedBeforeGroup,
          total: totalReferences,
        });
        continue;
      }
      const container = await input.verifyBlobOnce(group.sha256, group.sizeBytes);
      const inspected = await inspectNativeExportArchive({
        kind: 'local_path',
        logicalFilename: `supplemental-${group.sha256}.zip`,
        localPath: container.path,
        expectedSha256: `sha256:${group.sha256}`,
        expectedSizeBytes: group.sizeBytes,
        duplicateSupportEntryPolicy: 'identical_root_benchling_css',
      });
      const persisted = await persistNativeExportArchiveEntries(
        inspected,
        references.map((reference) => ({
          entryPath: reference.entryPath,
          expectedSha256: reference.sha256,
        })),
        input.archive,
        {
          sourceAlreadyVerified: true,
          reuseExistingExpectedBlobs: true,
          onProgress: ({ completed }) =>
            input.onProgress?.({
              phase: 'persisting_source_files',
              completed: persistedBeforeGroup + completed,
              total: totalReferences,
            }),
        }
      );
      persistedBeforeGroup += references.length;
      const persistedByPath = new Map(persisted.map((entry) => [entry.evidence.path, entry]));
      const manifestId = migrationEvidenceId(
        'supplemental-raw',
        `${group.sha256}\0${group.sizeBytes}\0${references
          .map(
            (reference) =>
              `${reference.entryPath}\0${reference.sourceObjectId}\0${reference.archivePartId}\0${reference.containerPartId}\0${reference.sha256}\0${reference.sizeBytes}`
          )
          .join('\n')}`
      );
      await input.archive.writeManifest(manifestId, {
        version: 1,
        entries: references.map((reference) => {
          const entry = persistedByPath.get(reference.entryPath);
          if (
            !entry ||
            entry.blob.sha256 !== reference.sha256 ||
            entry.blob.size !== reference.sizeBytes
          ) {
            throw new Error(`Supplemental raw source ${reference.entryPath} was not preserved.`);
          }
          return {
            logicalFilename: basename(reference.entryPath),
            sourceArchivePath: reference.entryPath,
            sha256: entry.blob.sha256,
            size: entry.blob.size,
            archivePartId: reference.archivePartId,
            sourceObjectId: reference.sourceObjectId,
          };
        }),
      });
      const manifest = await input.verifyManifestOnce(manifestId, ({ completed }) =>
        input.onProgress?.({
          phase: 'validating_source_files',
          completed: verifiedBeforeGroup + completed,
          total: totalReferences,
        })
      );
      verifiedBeforeGroup += references.length;
      const referenceByAssociation = new Map(
        references.map((reference) => [
          rawReferenceAssociationKey(
            reference.archivePartId,
            reference.sourceObjectId,
            reference.entryPath
          ),
          reference,
        ])
      );
      input.evidence.manifestEntries.push(
        ...manifest.entries.map((entry) => {
          const reference = referenceByAssociation.get(
            rawReferenceAssociationKey(
              entry.archivePartId ?? '',
              entry.sourceObjectId ?? '',
              entry.sourceArchivePath
            )
          );
          if (!reference) {
            throw new Error(
              `Supplemental raw manifest entry ${entry.sourceArchivePath} is unbound.`
            );
          }
          return {
            manifestId,
            archivePartId: entry.archivePartId ?? null,
            sourceObjectId: entry.sourceObjectId ?? null,
            entryPath: entry.sourceArchivePath,
            sha256: entry.sha256,
            sizeBytes: entry.size,
            containerSha256: group.sha256,
            containerSizeBytes: group.sizeBytes,
            containerPartId: reference.containerPartId,
          };
        })
      );
    } catch (error) {
      console.error('[benchling-migration] supplemental raw integrity failed', error);
      input.failures.push({
        evidenceId,
        message:
          'One or more preserved raw sources could not be verified inside the immutable supplementary ZIP.',
      });
    }
  }
}

function rawReferenceAssociationKey(
  archivePartId: string,
  sourceObjectId: string,
  entryPath: string
): string {
  return JSON.stringify([archivePartId, sourceObjectId, entryPath]);
}

async function enforceCheckpoint(
  run: MigrationRun,
  deps: LocalBundleExecutorDeps,
  now: () => string
): Promise<void> {
  const decision = (await deps.checkpoint?.()) ?? 'continue';
  if (decision === 'continue') return;
  const interrupted = transitionMigrationRun(
    run,
    decision === 'pause' ? 'paused' : 'cancelled_preserved',
    now()
  );
  persistRun(interrupted, deps);
  throw new LocalBundleMigrationInterruptedError(interrupted);
}

function persistRun(
  run: MigrationRun,
  deps: Pick<LocalBundleExecutorDeps, 'store' | 'onRunUpdated'>
): void {
  deps.store.saveRun(run);
  deps.onRunUpdated?.(run);
}

function requireSnapshot(runId: string, store: MigrationStore): SourceSnapshot {
  const snapshot = store.getSourceSnapshot(runId);
  if (!snapshot) throw new Error(`Local export run ${runId} has no source snapshot.`);
  return snapshot;
}

function completedResult(run: MigrationRun, store: MigrationStore): MigrationResult {
  const snapshot = requireSnapshot(run.id, store);
  const report = store.getValidationReport(run.id);
  if (!report?.passed) throw new Error('Completed local export import has no passing report.');
  return {
    run,
    snapshot,
    resolutions: store.listRelationshipResolutions(run.id),
    receipts: store.listProjectionReceipts(run.id),
    report,
  };
}

function sortedSourceObjects(values: readonly SourceObject[]): SourceObject[] {
  return [...values].sort(
    (left, right) => left.stableId.localeCompare(right.stableId) || left.id.localeCompare(right.id)
  );
}
