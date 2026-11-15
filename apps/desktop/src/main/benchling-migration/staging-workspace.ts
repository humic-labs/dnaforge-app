import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import Database from 'better-sqlite3';
import { migrationSourceForObject } from './reviewed-table-source';
import type { RegistryTableMappingDecision } from '../../shared/benchling-registry-table-review';
import {
  BENCHLING_MIGRATION_BUNDLE_VERSION,
  BENCHLING_MIGRATION_DESTINATION_INTEGRITY_VERSION,
  BENCHLING_MIGRATION_PROJECTION_VERSION,
  isValidationReportV2,
  isLocalNativeFolderZipInventory,
  migrationRunSourceIdentityHash,
  type LocalBenchlingExportIntakeDescriptor,
  type MigrationRun,
  type MigrationScope,
  type ProjectionReceipt,
  type RelationshipResolution,
  type SourceObject,
  type SourceSnapshot,
  type SourceBinding,
  type ValidationReport,
} from '../../shared/benchling-migration';
import {
  commitAllIfDirty,
  initManagedRepo,
  readFileAtHead,
  resolveHeadCommit,
} from '../workspace-git';
import { materializeLimsGitExportForWorkspaceIds } from '../lims-export-sync';
import {
  materializeNativeWorkspaceInsideTx,
  type NativeWorkspaceMaterializationPlan,
  type NativeExistingEntityReplacement,
} from '../native-workspace-materializer';
import {
  nativeWorkspaceManifestFromPlan,
  writeNativeWorkspaceManifest,
  writeNativeWorkspaceManifestDocument,
} from '../native-workspace-manifest';
import {
  NATIVE_WORKSPACE_MANIFEST_PATH,
  NATIVE_WORKSPACE_MANIFEST_SCHEMA,
  NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA,
  nativeWorkspaceEntityPhysicalRoot,
  parseNativeWorkspaceManifest,
  serializeNativeWorkspaceManifest,
  type NativeWorkspaceManifest,
  type NativeWorkspaceMigrationSourceRef,
} from '../../shared/native-workspace-manifest';
import { MIGRATION_DESTINATION_LINK_INDEX_RELATIVE_PATH } from '../../shared/benchling-migration-destination-index';
import { parseBenchlingMigrationActionJournal } from '../../shared/benchling-migration-action-journal';
import { scopedProjectionId } from '../../shared/workspace-scoped-identity';
import { workspaceScopeKey } from '../../shared/workspace-scoped-identity';
import { materializeBenchlingRegistryProjectionInsideTx } from './registry-materializer';
import { assertScopedFolderBoundary, type ScopedFolderMetadata } from './collection-projection';
import { collectionDestinationId } from './collection-projection';
import { readScopedFolderBoundary } from './collection-projection-writer';
import {
  COLLECTION_PROJECTION_MANIFEST_PATH,
  readCollectionProjection,
} from './collection-projection-writer';
import {
  assertProjectionIntegrityMatchesEvidence,
  assertProjectionReceiptIntegrity,
} from './projection-writer';
import { readBenchlingRegistryProjectionDocuments } from './registry-projection-store';
import { readScopedBoundaryEvidence } from './collection-projection-writer';
import {
  assertScopedBoundaryAttestationMatchesEvidence,
  type ScopedBoundaryEvidenceV1,
} from './scoped-boundary-evidence';
import { transitionMigrationRun } from './state-machine';
import { ContentArchive } from './content-archive';
import { migrationEvidenceId } from './evidence-id';
import { verifyExternalZipSource } from './external-zip-source';
import { buildNativeMigrationMaterializationPlan } from './native-materialization';
import {
  addNativeRegistryRelationshipRepairs,
  planNativeRegistryRelationshipRemovals,
  withoutRemovedNativeRelationships,
} from './native-registry-relationship-repair';
import {
  assertNativeCatalogCommitRecordsUnchanged,
  readNativeCatalogCommit,
  recordNativeCatalogCommit,
} from './native-catalog-commit';
import { readNativeCatalogPublicationBase } from '../native-catalog-publication';
import {
  addNativeSourceFolderMemberships,
  capturedNativeFolderHierarchy,
} from './native-source-memberships';
import { SCOPED_BOUNDARY_EVIDENCE_PATH } from './scoped-boundary-evidence';
import {
  BENCHLING_MIGRATION_ACTIONS_RELATIVE_PATH,
  readBenchlingMigrationActionJournal,
} from './action-journal';
import { allocationCollisionKey, safeDestinationSegment } from './destination-name-allocator';
import {
  BenchlingMigrationActionRecoveryError,
  recoverBenchlingMigrationAction,
} from './action-recovery';
import {
  readReviewedNativeLink,
  readRetainedNativeEntity,
  type ReviewedNativeLink,
} from './reviewed-native-link';
import { linkReviewedExactNativeMatch } from './destination-inventory';
import { assertNativeActionCatalogIntegrity } from './native-action-integrity';
import { publishActionLimsExport } from './generated-lims-publication';
import {
  assertProviderTaskPrivacySafe,
  MIGRATION_DATA_DIR,
  MigrationStore,
  openWorkspaceMigrationStore,
} from './store';
import {
  validateDirectFolderCaptureAttestation,
  validateFolderTreeCaptureAttestation,
} from './validation';

const STAGING_MARKER_PATH = '.dnaforge/migration/workspace.json';
const MACHINE_REPORT_PATH = '.dnaforge/migration/validation-report.json';
const SOURCE_BINDING_PATH = '.dnaforge/migration/source-binding.json';
const SOURCE_ARTIFACT_PATH = '.dnaforge/migration/source-artifact.json';
const NATIVE_REPORT_PATH = 'Benchling Migration Report.md';

function migrationReportPath(run: MigrationRun): string {
  return run.externalZipSource || run.baseline?.kind === 'adopted_workspace'
    ? '.dnaforge/migration/report.md'
    : NATIVE_REPORT_PATH;
}

export type MigrationStagingWorkspaceDeps = {
  managedRootDir: string;
  globalDb: Database.Database;
  appVersion?: string;
  createWorkspaceId?: () => string;
  now?: () => string;
  openStore?: (workspacePath: string) => MigrationStore;
};

export type UnlockedMigrationWorkspace = {
  workspaceId: string;
  workspaceDbId: number;
  repoPath: string;
  displayName: string;
  headCommit: string | null;
  reportPath: string;
};

type MigrationUnlockFinalizationDeps = {
  writeStagingMarker?: typeof writeStagingMarker;
  commitAllIfDirty?: typeof commitAllIfDirty;
  resolveHeadCommit?: typeof resolveHeadCommit;
  openTransactionDb?: (globalDb: Database.Database) => {
    db: Database.Database;
    close: () => void;
  };
};

export async function createMigrationStagingWorkspace(input: {
  scope: MigrationScope;
  displayName: string;
  localExportIntake?: LocalBenchlingExportIntakeDescriptor;
  localRetryExclusion?: MigrationRun['localRetryExclusion'];
  localBestEffortFallback?: MigrationRun['localBestEffortFallback'];
  reviewedTables?: readonly RegistryTableMappingDecision[];
  deps: MigrationStagingWorkspaceDeps;
}): Promise<MigrationRun> {
  if (
    input.localExportIntake &&
    (input.localExportIntake.schema !== 'dnaforge.benchling.local-export-intake.v1' ||
      input.scope.kind !== 'file' ||
      input.scope.acquisition !== 'local_bundle' ||
      !input.scope.source.id.startsWith('local-export-pending-'))
  ) {
    throw new Error('Local export intake authority requires an exact provisional File scope.');
  }
  const workspaceId = (input.deps.createWorkspaceId ?? randomUUID)();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(workspaceId)) {
    throw new Error('Migration workspace ID contains unsupported characters.');
  }
  const workspacePath = join(resolve(input.deps.managedRootDir), workspaceId, 'repo');
  if (existsSync(workspacePath))
    throw new Error(`Migration workspace already exists: ${workspaceId}`);
  const now = (input.deps.now ?? (() => new Date().toISOString()))();
  const appVersion = safeVersionLabel(input.deps.appVersion ?? 'test');
  const run: MigrationRun = {
    version: 1,
    id: `migration-${workspaceId}`,
    workspaceId,
    repoUuid: workspaceId,
    projectionScopeId: workspaceId,
    workspaceOrigin: { kind: 'migration_created' },
    workspacePath,
    displayName: sanitizeDisplayName(input.displayName),
    scope: input.scope,
    binding: null,
    state: 'draft',
    resumeState: null,
    attempt: 0,
    converterVersions: {
      app: appVersion,
      bundle: BENCHLING_MIGRATION_BUNDLE_VERSION,
      projection: BENCHLING_MIGRATION_PROJECTION_VERSION,
    },
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    unlockedAt: null,
    lastError: null,
    ...(input.localExportIntake ? { localExportIntake: input.localExportIntake } : {}),
    ...(input.localRetryExclusion ? { localRetryExclusion: input.localRetryExclusion } : {}),
    ...(input.localBestEffortFallback
      ? { localBestEffortFallback: input.localBestEffortFallback }
      : {}),
  };

  await mkdir(join(workspacePath, '.dnaforge', 'migration'), { recursive: true });
  await atomicWriteText(
    join(workspacePath, '.gitignore'),
    [
      '.dnaforge/migration/archive/blobs/',
      '.dnaforge/migration/archive/incoming/',
      '.dnaforge/migration/projection-staging/',
      '.dnaforge/migration/migration.sqlite*',
      '',
    ].join('\n')
  );
  await writeStagingMarker(run, 'locked');
  await initManagedRepo(workspacePath);
  await commitAllIfDirty(workspacePath, 'Initialize locked Benchling migration workspace');

  const store = (input.deps.openStore ?? openWorkspaceMigrationStore)(workspacePath);
  try {
    store.saveRunWithImportDecisions(run, input.reviewedTables ?? []);
  } finally {
    store.close();
  }
  return run;
}

export async function persistConfirmedSourceBinding(input: {
  run: MigrationRun;
  binding: SourceBinding;
  updatedAt: string;
  openStore?: (workspacePath: string) => MigrationStore;
}): Promise<MigrationRun> {
  if (input.run.binding && !samePersistedValue(input.run.binding, input.binding)) {
    throw new Error('A migration workspace source binding is immutable after confirmation.');
  }
  const nextRun: MigrationRun = {
    ...input.run,
    binding: input.binding,
    updatedAt: input.updatedAt,
  };
  const store = (input.openStore ?? openWorkspaceMigrationStore)(input.run.workspacePath);
  try {
    store.saveRun(nextRun);
  } finally {
    store.close();
  }
  return nextRun;
}

function samePersistedValue(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(
    JSON.parse(JSON.stringify(left)) as unknown,
    JSON.parse(JSON.stringify(right)) as unknown
  );
}

export async function unlockMigrationWorkspace(input: {
  workspacePath: string;
  globalDb: Database.Database;
  now?: () => string;
  openStore?: (workspacePath: string) => MigrationStore;
  finalizationDeps?: MigrationUnlockFinalizationDeps;
  assertMutationLeaseHeld?: () => void;
}): Promise<UnlockedMigrationWorkspace> {
  const store = (input.openStore ?? openWorkspaceMigrationStore)(input.workspacePath);
  try {
    const run = store.getRun();
    if (!run) throw new Error('Migration run does not exist.');
    const report = store.getValidationReport(run.id);
    if (!report?.passed) throw new Error('Migration validation has not passed.');
    const sourceIdentityHash = migrationRunSourceIdentityHash(run);
    if (!sourceIdentityHash || report.accountHash !== sourceIdentityHash) {
      throw new Error('Migration report does not match the immutable source identity.');
    }
    if (run.state !== 'ready_to_unlock' && run.state !== 'unlocked') {
      throw new Error(`Migration workspace cannot unlock from state ${run.state}.`);
    }
    const latestRecoveryAttempt = store.listLinkedItemRecoveryAttempts(run.id).at(-1);
    if (
      (run.linkedItemRecovery && run.linkedItemRecovery.state !== 'completed') ||
      (latestRecoveryAttempt && latestRecoveryAttempt.state !== 'completed')
    ) {
      throw new Error('Linked-item recovery must finish before this notebook can unlock.');
    }

    if (run.state === 'unlocked') {
      const workspace = input.globalDb
        .prepare('SELECT id, repo_uuid FROM workspaces WHERE path = ?')
        .get(run.workspacePath) as { id: number; repo_uuid: string | null } | undefined;
      const expectedRepoUuid = migrationRunRepoUuid(run);
      if (!workspace || workspace.repo_uuid !== expectedRepoUuid) {
        throw new Error('Unlocked workspace registration is incomplete.');
      }
      const resolveWorkspaceHead = input.finalizationDeps?.resolveHeadCommit ?? resolveHeadCommit;
      const headCommit = await resolveWorkspaceHead(run.workspacePath);
      if (!headCommit) throw new Error('Unlocked workspace registration is incomplete.');
      return {
        workspaceId: run.projectionScopeId ?? run.workspaceId,
        workspaceDbId: workspace.id,
        repoPath: run.workspacePath,
        displayName: run.displayName,
        headCommit,
        reportPath: join(run.workspacePath, migrationReportPath(run)),
      };
    }

    await verifyImmutableSourceBeforeUnlock(run, report, store);
    const receipts = store.listProjectionReceipts(run.id);
    const reportRequiresDestinationIntegrity =
      run.converterVersions.destinationIntegrity ===
        BENCHLING_MIGRATION_DESTINATION_INTEGRITY_VERSION ||
      (isValidationReportV2(report) &&
        report.converterVersions?.destinationIntegrity ===
          BENCHLING_MIGRATION_DESTINATION_INTEGRITY_VERSION);
    if (
      reportRequiresDestinationIntegrity &&
      (!isValidationReportV2(report) || !report.destinationIntegrity)
    ) {
      throw new Error(
        'The passing migration report is missing its required destination-integrity evidence.'
      );
    }
    if (isValidationReportV2(report) && report.destinationIntegrity) {
      await assertProjectionIntegrityMatchesEvidence({
        workspacePath: run.workspacePath,
        receipts,
        expected: report.destinationIntegrity,
      });
    } else {
      await assertProjectionReceiptIntegrity({ workspacePath: run.workspacePath, receipts });
    }
    await persistMigrationWorkspaceReport(run, report);

    const registryDocuments = await readBenchlingRegistryProjectionDocuments(run.workspacePath);
    const sourceObjects = await store.listSourceObjectMaterializationViewsCooperatively(run.id);
    const projectionReceipts = store.listProjectionReceipts(run.id);
    const relationshipResolutions = store.listRelationshipResolutions(run.id);
    const folderProjection = existsSync(
      join(run.workspacePath, COLLECTION_PROJECTION_MANIFEST_PATH)
    )
      ? await readCollectionProjection(run.workspacePath)
      : null;
    const baseNativePlan = await buildNativeMigrationMaterializationPlan({
      run,
      sourceObjects,
      receipts: projectionReceipts,
      resolutions: relationshipResolutions,
      folderProjection,
    });
    const recoveredNativePlan = addRecoveredNativeFolderMemberships({
      plan: baseNativePlan,
      report,
      receipts: projectionReceipts,
      layout: run.externalZipSource ? 'native-v2' : 'legacy-v1',
    });
    const nativePlan = run.externalZipSource
      ? addNativeSourceFolderMemberships({
          scopeId: run.id,
          plan: recoveredNativePlan,
          sourceObjects,
          receipts: projectionReceipts,
          currentManifest: nativeWorkspaceManifestFromPlan({
            workspacePath: run.workspacePath,
            plan: { ...recoveredNativePlan, entities: [], links: [] },
            manifestVersion: 2,
          }),
        })
      : recoveredNativePlan;

    if (run.externalZipSource) {
      return await finalizeNativeV2MigrationAction({
        input,
        run,
        report,
        store,
        registryDocuments,
        projectionReceipts,
        nativePlan,
      });
    }

    const resolveWorkspaceHead = input.finalizationDeps?.resolveHeadCommit ?? resolveHeadCommit;
    const preUnlockHead = await resolveWorkspaceHead(run.workspacePath);
    if (!preUnlockHead) throw new Error('Unlocked workspace registration is incomplete.');

    const now = (input.now ?? (() => new Date().toISOString()))();
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs)) throw new Error('Unlock timestamp must be an ISO date.');

    const openTransactionDb =
      input.finalizationDeps?.openTransactionDb ?? openIsolatedUnlockTransactionDb;
    const transactionHandle = openTransactionDb(input.globalDb);
    const transactionDb = transactionHandle.db;
    let limsSnapshot: LimsWorkspaceSnapshot | null = null;
    let priorGlobalBusyTimeout: number | null = null;
    let globalBusyTimeoutOverridden = false;
    let transactionStarted = false;
    let transactionCommitted = false;
    let unlockedRunSaved = false;
    let unlockedRun: MigrationRun | null = null;
    let previousNativeManifest: Buffer | null = null;
    let nativeManifestWritten = false;
    let previousDestinationIndex: Buffer | null = null;
    let destinationIndexRemoved = false;
    let collectionProjectionSnapshot: CollectionProjectionSnapshot | null = null;
    let createdNativeFolderPaths: string[] = [];
    try {
      const writesLimsState =
        registryDocuments.length > 0 || (nativePlan.limsEntities?.length ?? 0) > 0;
      limsSnapshot = writesLimsState ? await snapshotLimsWorkspace(run.workspacePath) : null;
      if (run.state === 'ready_to_unlock') {
        createdNativeFolderPaths = await materializeNewNativeFolderPaths(
          run.workspacePath,
          nativePlan
        );
        const nativeManifestPath = join(run.workspacePath, NATIVE_WORKSPACE_MANIFEST_PATH);
        previousNativeManifest = existsSync(nativeManifestPath)
          ? await readFile(nativeManifestPath)
          : null;
        await writeNativeWorkspaceManifest({
          workspacePath: run.workspacePath,
          plan: nativePlan,
          manifestVersion: run.externalZipSource ? 2 : undefined,
        });
        nativeManifestWritten = true;
        const destinationIndexPath = join(
          run.workspacePath,
          MIGRATION_DESTINATION_LINK_INDEX_RELATIVE_PATH
        );
        previousDestinationIndex = existsSync(destinationIndexPath)
          ? await readFile(destinationIndexPath)
          : null;
        await rm(destinationIndexPath, { force: true });
        destinationIndexRemoved = true;
        collectionProjectionSnapshot = await snapshotCollectionProjection(run.workspacePath);
        await removeCollectionProjection(run.workspacePath);
      }
      if (transactionDb !== input.globalDb) {
        const configuredBusyTimeout = input.globalDb.pragma('busy_timeout', {
          simple: true,
        }) as unknown;
        if (
          typeof configuredBusyTimeout !== 'number' ||
          !Number.isSafeInteger(configuredBusyTimeout) ||
          configuredBusyTimeout < 0
        ) {
          throw new Error('Global database busy timeout is invalid.');
        }
        priorGlobalBusyTimeout = configuredBusyTimeout;
        input.globalDb.pragma('busy_timeout = 0');
        globalBusyTimeoutOverridden = true;
      }
      transactionDb.exec('BEGIN IMMEDIATE');
      transactionStarted = true;
      const nativeMaterialization = materializeNativeWorkspaceInsideTx(transactionDb, {
        workspace: {
          name: benchlingWorkspaceName(run),
          path: run.workspacePath,
          repoUuid: migrationRunRepoUuid(run),
          createdAt: Date.parse(run.createdAt),
          lastOpenedAt: nowMs,
        },
        plan: nativePlan,
      });
      const registeredWorkspaceId = nativeMaterialization.workspaceId;
      for (const document of registryDocuments) {
        materializeBenchlingRegistryProjectionInsideTx(transactionDb, {
          document,
          workspaceId: registeredWorkspaceId,
        });
      }
      if (writesLimsState) {
        materializeLimsGitExportForWorkspaceIds(transactionDb, [registeredWorkspaceId]);
      }

      let headCommit = preUnlockHead;
      if (run.state === 'ready_to_unlock') {
        const writeWorkspaceMarker =
          input.finalizationDeps?.writeStagingMarker ?? writeStagingMarker;
        const commitWorkspace = input.finalizationDeps?.commitAllIfDirty ?? commitAllIfDirty;
        await writeWorkspaceMarker(run, 'unlocked');
        const forceInclude = await generatedWorkspaceFilesForCommit(run.workspacePath);
        headCommit =
          (await commitWorkspace(run.workspacePath, 'Complete validated Benchling migration', {
            forceInclude,
          })) ?? preUnlockHead;
      }

      unlockedRun = {
        ...transitionMigrationRun(run, 'unlocked', now),
        workspaceDbId: registeredWorkspaceId,
        repoUuid: migrationRunRepoUuid(run),
        projectionScopeId:
          run.projectionScopeId ??
          workspaceScopeKey(migrationRunRepoUuid(run), registeredWorkspaceId) ??
          run.workspaceId,
      };
      store.saveRun(unlockedRun);
      unlockedRunSaved = true;

      transactionDb.exec('COMMIT');
      transactionCommitted = true;
      await discardLimsSnapshot(limsSnapshot).catch((error: unknown) => {
        console.warn('[Benchling migration] Failed to remove unlock staging backup:', error);
      });
      await discardCollectionProjectionSnapshot(collectionProjectionSnapshot).catch(
        (error: unknown) => {
          console.warn('[Benchling migration] Failed to remove collection staging backup:', error);
        }
      );
      return {
        workspaceId: unlockedRun.projectionScopeId ?? run.workspaceId,
        workspaceDbId: registeredWorkspaceId,
        repoPath: run.workspacePath,
        displayName: run.displayName,
        headCommit,
        reportPath: join(run.workspacePath, migrationReportPath(run)),
      };
    } catch (error) {
      if (transactionStarted && !transactionCommitted && transactionDb.inTransaction) {
        transactionDb.exec('ROLLBACK');
      }
      if (unlockedRunSaved && unlockedRun) {
        store.recoverRun(unlockedRun, { type: 'rollback_failed_unlock', readyRun: run });
      }
      if (run.state === 'ready_to_unlock') {
        await restoreLockedWorkspaceAfterFailedUnlock(run, limsSnapshot);
        if (nativeManifestWritten) {
          await restoreNativeWorkspaceManifest(run.workspacePath, previousNativeManifest);
        }
        if (destinationIndexRemoved) {
          await restoreFileSnapshot(
            join(run.workspacePath, MIGRATION_DESTINATION_LINK_INDEX_RELATIVE_PATH),
            previousDestinationIndex
          );
        }
        await restoreCollectionProjectionSnapshot(collectionProjectionSnapshot);
        await removeNewNativeFolderPaths(run.workspacePath, createdNativeFolderPaths);
      } else {
        await restoreLimsSnapshot(limsSnapshot);
      }
      throw error;
    } finally {
      try {
        transactionHandle.close();
      } finally {
        if (globalBusyTimeoutOverridden && priorGlobalBusyTimeout !== null) {
          input.globalDb.pragma(`busy_timeout = ${priorGlobalBusyTimeout}`);
        }
      }
    }
  } finally {
    store.close();
  }
}

async function finalizeNativeV2MigrationAction(input: {
  input: Parameters<typeof unlockMigrationWorkspace>[0];
  run: MigrationRun;
  report: ValidationReport;
  store: MigrationStore;
  registryDocuments: Awaited<ReturnType<typeof readBenchlingRegistryProjectionDocuments>>;
  projectionReceipts: readonly ProjectionReceipt[];
  nativePlan: NativeWorkspaceMaterializationPlan;
}): Promise<UnlockedMigrationWorkspace> {
  const { run, store, nativePlan, registryDocuments, projectionReceipts } = input;
  const assertMutationLeaseHeld = input.input.assertMutationLeaseHeld ?? (() => undefined);
  assertMutationLeaseHeld();
  const now = (input.input.now ?? (() => new Date().toISOString()))();
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error('Unlock timestamp must be an ISO date.');

  let registeredWorkspaceId: number | null = null;
  const recovery = await recoverBenchlingMigrationAction(run.workspacePath, run.id, {
    receipts: projectionReceipts,
    assertMutationLeaseHeld,
    now: () => now,
    completeCatalog: async () => {
      assertMutationLeaseHeld();
      const committed = readNativeCatalogCommit(
        input.input.globalDb,
        run.projectionScopeId ?? run.workspaceId,
        run.id
      );
      if (committed) {
        registeredWorkspaceId = committed.workspaceId;
        return;
      }
      const openTransactionDb =
        input.input.finalizationDeps?.openTransactionDb ?? openIsolatedUnlockTransactionDb;
      const transactionHandle = openTransactionDb(input.input.globalDb);
      const transactionDb = transactionHandle.db;
      let priorGlobalBusyTimeout: number | null = null;
      let globalBusyTimeoutOverridden = false;
      let transactionStarted = false;
      try {
        if (transactionDb !== input.input.globalDb) {
          const configuredBusyTimeout = input.input.globalDb.pragma('busy_timeout', {
            simple: true,
          }) as unknown;
          if (
            typeof configuredBusyTimeout !== 'number' ||
            !Number.isSafeInteger(configuredBusyTimeout) ||
            configuredBusyTimeout < 0
          ) {
            throw new Error('Global database busy timeout is invalid.');
          }
          priorGlobalBusyTimeout = configuredBusyTimeout;
          input.input.globalDb.pragma('busy_timeout = 0');
          globalBusyTimeoutOverridden = true;
        }
        transactionDb.exec('BEGIN IMMEDIATE');
        transactionStarted = true;
        const materialized = materializeNativeWorkspaceInsideTx(transactionDb, {
          workspace: {
            name: benchlingWorkspaceName(run),
            path: run.workspacePath,
            repoUuid: migrationRunRepoUuid(run),
            createdAt: Date.parse(run.createdAt),
            lastOpenedAt: nowMs,
          },
          plan: nativePlan,
        });
        registeredWorkspaceId = materialized.workspaceId;
        for (const document of registryDocuments) {
          materializeBenchlingRegistryProjectionInsideTx(transactionDb, {
            document,
            workspaceId: materialized.workspaceId,
          });
        }
        const manifestAfter = nativeWorkspaceManifestFromPlan({
          workspacePath: run.workspacePath,
          plan: nativePlan,
          manifestVersion: 2,
        });
        recordNativeCatalogCommit(transactionDb, run.projectionScopeId ?? run.workspaceId, run.id, {
          workspaceId: materialized.workspaceId,
          manifest: manifestAfter,
          replacedEntityIds: [],
          existingEntityIds: [],
          publishLims: true,
        });
        transactionDb.exec('COMMIT');
        transactionStarted = false;
      } catch (error) {
        if (transactionStarted && transactionDb.inTransaction) transactionDb.exec('ROLLBACK');
        throw error;
      } finally {
        try {
          transactionHandle.close();
        } finally {
          if (globalBusyTimeoutOverridden && priorGlobalBusyTimeout !== null) {
            input.input.globalDb.pragma(`busy_timeout = ${priorGlobalBusyTimeout}`);
          }
        }
      }
    },
    mergeManifest: async () => {
      assertMutationLeaseHeld();
      const committed = readNativeCatalogCommit(
        input.input.globalDb,
        run.projectionScopeId ?? run.workspaceId,
        run.id
      );
      const beforeBytes = await readNativeCatalogPublicationBase({
        workspacePath: run.workspacePath,
        operationId: run.id,
      });
      if (committed)
        assertNativeCatalogCommitRecordsUnchanged({
          db: input.input.globalDb,
          scopeId: run.projectionScopeId ?? run.workspaceId,
          commit: committed,
          currentManifest:
            beforeBytes === null
              ? null
              : parseNativeWorkspaceManifest(beforeBytes.toString('utf8')),
        });
      await materializeNewNativeFolderPaths(run.workspacePath, nativePlan);
      await writeNativeWorkspaceManifestDocument({
        workspacePath: run.workspacePath,
        publication: { operationId: run.id, beforeBytes },
        manifest:
          committed?.manifest ??
          nativeWorkspaceManifestFromPlan({
            workspacePath: run.workspacePath,
            plan: nativePlan,
            manifestVersion: 2,
          }),
      });
      if (committed?.publishLims)
        await publishActionLimsExport({
          db: input.input.globalDb,
          workspaceDbId: committed.workspaceId,
          workspacePath: run.workspacePath,
          actionId: run.id,
        });
      await rm(join(run.workspacePath, MIGRATION_DESTINATION_LINK_INDEX_RELATIVE_PATH), {
        force: true,
      });
      await removeCollectionProjection(run.workspacePath);
    },
    verifyCatalogManifestAgreement: async (journal) => {
      assertMutationLeaseHeld();
      const manifest = parseNativeWorkspaceManifest(
        await readFile(join(run.workspacePath, NATIVE_WORKSPACE_MANIFEST_PATH), 'utf8')
      );
      if (!nativeManifestIsRegistered(input.input.globalDb, run, manifest)) {
        throw new Error('The native workspace manifest is not registered in the catalog.');
      }
      assertNativeActionCatalogIntegrity({
        db: input.input.globalDb,
        workspacePath: run.workspacePath,
        journal,
        manifest,
      });
    },
  });
  if (recovery.kind !== 'complete') {
    throw new Error('Migration action requires projection resume before unlock.');
  }

  const workspace = input.input.globalDb
    .prepare('SELECT id, repo_uuid FROM workspaces WHERE path = ?')
    .get(run.workspacePath) as { id: number; repo_uuid: string | null } | undefined;
  registeredWorkspaceId ??= workspace?.id ?? null;
  if (
    registeredWorkspaceId === null ||
    !workspace ||
    workspace.repo_uuid !== migrationRunRepoUuid(run)
  ) {
    throw new Error('Unlocked workspace registration is incomplete.');
  }

  const writeWorkspaceMarker =
    input.input.finalizationDeps?.writeStagingMarker ?? writeStagingMarker;
  await writeWorkspaceMarker(run, 'unlocked');
  const unlockedRun: MigrationRun = {
    ...transitionMigrationRun(run, 'unlocked', now),
    workspaceDbId: registeredWorkspaceId,
    repoUuid: migrationRunRepoUuid(run),
    projectionScopeId:
      run.projectionScopeId ??
      workspaceScopeKey(migrationRunRepoUuid(run), registeredWorkspaceId) ??
      run.workspaceId,
  };
  store.saveRun(unlockedRun);
  const headCommit = await (input.input.finalizationDeps?.resolveHeadCommit ?? resolveHeadCommit)(
    run.workspacePath
  );
  return {
    workspaceId: unlockedRun.projectionScopeId ?? run.workspaceId,
    workspaceDbId: registeredWorkspaceId,
    repoPath: run.workspacePath,
    displayName: run.displayName,
    headCommit,
    reportPath: join(run.workspacePath, migrationReportPath(run)),
  };
}

export async function finalizeUnlockedMigrationRecovery(input: {
  run: MigrationRun;
  report: ValidationReport;
  store: MigrationStore;
  sourceObjects?: readonly SourceObject[];
  projectionReceipts?: readonly ProjectionReceipt[];
  relationshipResolutions?: readonly RelationshipResolution[];
  actionId?: string;
  globalDb: Database.Database;
  now?: () => string;
  assertMutationLeaseHeld?: () => void;
  finalizationDeps?: Pick<
    MigrationUnlockFinalizationDeps,
    'commitAllIfDirty' | 'resolveHeadCommit' | 'openTransactionDb'
  >;
}): Promise<void> {
  const { run, report, store } = input;
  if (run.state !== 'unlocked') {
    throw new Error(
      `Additive migration recovery requires an unlocked workspace, not ${run.state}.`
    );
  }
  if (!report.passed || report.runId !== run.id) {
    throw new Error("Additive migration recovery requires this run's passing report.");
  }

  const manifestPath = join(run.workspacePath, NATIVE_WORKSPACE_MANIFEST_PATH);
  let previousManifest: Buffer;
  let priorManifestBytes: Buffer | null = null;
  try {
    priorManifestBytes = input.actionId
      ? await readNativeCatalogPublicationBase({
          workspacePath: run.workspacePath,
          operationId: input.actionId,
        })
      : await readFile(manifestPath);
    if (priorManifestBytes === null)
      throw Object.assign(new Error('Native catalog is missing.'), { code: 'ENOENT' });
    previousManifest = priorManifestBytes;
  } catch (error) {
    if (
      !(error instanceof Error && 'code' in error && error.code === 'ENOENT') ||
      run.baseline?.kind !== 'adopted_workspace' ||
      run.baseline.existingManifestSha256 !== null ||
      store.listLinkedItemRecoveryAttempts(run.id).some((attempt) => attempt.state === 'completed')
    )
      throw error;
    previousManifest = Buffer.from(
      serializeNativeWorkspaceManifest({
        schema: NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA,
        entities: [],
        links: [],
      })
    );
  }
  let currentManifest = parseNativeWorkspaceManifest(previousManifest.toString('utf8'));
  const committedAction = input.actionId
    ? readNativeCatalogCommit(
        input.globalDb,
        run.projectionScopeId ?? run.workspaceId,
        input.actionId
      )
    : null;
  if (committedAction)
    assertNativeCatalogCommitRecordsUnchanged({
      db: input.globalDb,
      scopeId: run.projectionScopeId ?? run.workspaceId,
      commit: committedAction,
      currentManifest,
    });
  if (!nativeManifestIsRegistered(input.globalDb, run, currentManifest)) {
    const committedManifest = await readFileAtHead(
      run.workspacePath,
      NATIVE_WORKSPACE_MANIFEST_PATH
    );
    const parsedCommittedManifest = parseNativeWorkspaceManifest(
      committedManifest.toString('utf8')
    );
    if (!nativeManifestIsRegistered(input.globalDb, run, parsedCommittedManifest)) {
      throw new Error('The committed native workspace catalog is not registered.');
    }
    await writeFile(manifestPath, committedManifest);
    previousManifest = committedManifest;
    currentManifest = parsedCommittedManifest;
  }
  const mergedCollectionProjection =
    run.scope.kind === 'file' ? null : await readCollectionProjection(run.workspacePath);
  const sourceObjects =
    input.sourceObjects ??
    (await store.listSourceObjectMaterializationViewsCooperatively(run.id, {
      retainContentForSourceObjectIds: new Set(
        (input.projectionReceipts ?? store.listProjectionReceipts(run.id))
          .filter((receipt) => receipt.destination?.kind === 'catalog-record')
          .map((receipt) => receipt.sourceObjectId)
      ),
    }));
  const projectionReceipts = input.projectionReceipts ?? store.listProjectionReceipts(run.id);
  const relationshipResolutions =
    input.relationshipResolutions ?? store.listRelationshipResolutions(run.id);
  const migrationSourcesByObjectId = new Map<string, NativeWorkspaceMigrationSourceRef>();
  for (const capture of store.listLinkedItemRecoveryCaptures(run.id)) {
    const artifact = store.getLinkedItemRecoveryArtifact(run.id, capture.artifactId);
    if (artifact?.schema !== 'dnaforge.benchling.linked-item-recovery-source.v2') continue;
    const capturedSource = sourceObjects.find((source) => source.id === capture.sourceObjectId);
    const migrationSource = capturedSource
      ? migrationSourceForObject(capturedSource, run.id, artifact.externalZipSource.sourceId)
      : {
          historyRunId: run.id,
          sourceId: artifact.externalZipSource.sourceId,
          sourceObjectId: capture.sourceStableId,
        };
    if (migrationSource) migrationSourcesByObjectId.set(capture.sourceObjectId, migrationSource);
  }
  const reviewedNativeLinks: ReviewedNativeLink[] = [];
  for (const decision of input.actionId ? store.listImportDecisions(run.id, input.actionId) : []) {
    if (decision.kind !== 'unbound_exact_match' || decision.policy !== 'link_existing') continue;
    const sourceObject = sourceObjects.find((source) => source.id === decision.sourceObjectId);
    const receipt = projectionReceipts.find(
      (entry) => entry.sourceObjectId === decision.sourceObjectId
    );
    const migrationSource = migrationSourcesByObjectId.get(decision.sourceObjectId);
    if (
      !sourceObject ||
      !receipt ||
      !migrationSource ||
      !run.workspaceDbId ||
      currentManifest.schema !== NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA
    ) {
      throw new Error('Reviewed native link is missing its durable source or receipt.');
    }
    const link = readReviewedNativeLink({
      db: input.globalDb,
      workspaceDbId: run.workspaceDbId,
      workspacePath: run.workspacePath,
      decision,
      sourceObject,
      receipt,
      migrationSource,
    });
    reviewedNativeLinks.push(link);
    const existing = currentManifest.entities.find((entity) => entity.id === link.entity.id);
    const linkedEntity = existing
      ? { ...existing, sourceIdentities: link.entity.sourceIdentities, migrationSource }
      : link.entity;
    currentManifest = {
      ...currentManifest,
      entities: [
        ...currentManifest.entities.filter((entity) => entity.id !== link.entity.id),
        linkedEntity,
      ],
    };
  }
  const actionJournal = input.actionId
    ? await readBenchlingMigrationActionJournal(run.workspacePath, input.actionId)
    : null;
  if (currentManifest.schema === NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA && run.workspaceDbId) {
    const retainedEntities = [];
    for (const allocation of actionJournal?.allocations ?? []) {
      if (allocation.writeDisposition !== 'retain') continue;
      if (reviewedNativeLinks.some((link) => link.entity.id === allocation.destinationEntityId))
        continue;
      const receipt = projectionReceipts.find(
        (entry) => entry.sourceObjectId === allocation.sourceObjectId
      );
      const migrationSource = migrationSourcesByObjectId.get(allocation.sourceObjectId);
      if (!receipt || !migrationSource)
        throw new Error('Retained destination is missing its source or receipt.');
      const existing = currentManifest.entities.find(
        (entity) => entity.id === allocation.destinationEntityId
      );
      retainedEntities.push({
        ...existing,
        ...readRetainedNativeEntity({
          db: input.globalDb,
          workspaceDbId: run.workspaceDbId,
          workspacePath: run.workspacePath,
          entityId: `${actionJournal?.workspace.projectionScopeId}::${allocation.destinationEntityId}`,
          receipt,
          migrationSource,
        }),
      });
    }
    const retainedIds = new Set(retainedEntities.map((entity) => entity.id));
    currentManifest = {
      ...currentManifest,
      entities: [
        ...currentManifest.entities.filter((entity) => !retainedIds.has(entity.id)),
        ...retainedEntities,
      ],
    };
  }
  const currentManifestEntityById = new Map(
    currentManifest.entities.map((entity) => [entity.id, entity])
  );
  const currentEntityIds = new Set(currentManifestEntityById.keys());
  const currentLimsEntityIds = new Set(
    currentManifest.entities
      .filter((entity) => entity.lims !== undefined)
      .map((entity) => entity.id)
  );
  const priorNeedsSequenceSourceIds = new Set(store.listNeedsSequenceProjectionSourceIds(run.id));
  const needsSequenceCompletionRawIds = new Set(
    projectionReceipts
      .filter(
        (receipt) =>
          receipt.nativeRepresentation === 'dna_sequence' &&
          priorNeedsSequenceSourceIds.has(receipt.sourceObjectId)
      )
      .map((receipt) => receipt.destinationObjectId)
  );
  const existingEntityReplacements = new Map<string, NativeExistingEntityReplacement>();
  const versionResolution = input.actionId
    ? store.getLinkedItemRecoveryAttempt(run.id, input.actionId)?.versionConflictResolution
    : undefined;
  for (const allocation of actionJournal?.allocations ?? []) {
    if (
      allocation.expectedPriorImportedHash &&
      !needsSequenceCompletionRawIds.has(allocation.destinationEntityId)
    ) {
      const existingType = currentManifestEntityById.get(allocation.destinationEntityId)?.type;
      const layout =
        currentManifest.schema === NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA ? 'native' : 'legacy';
      let replacement: NativeExistingEntityReplacement;
      if (allocation.destination.kind === 'package' && existingType === 'notebook') {
        replacement = {
          entityRawId: allocation.destinationEntityId,
          kind: 'notebook_package',
          layout,
          expectedPlacement: { ...allocation.destination, fileKind: 'waypoint-notebook' },
        };
      } else if (
        allocation.destination.kind === 'package' &&
        (existingType === 'protocol' || existingType === 'protocol_run')
      ) {
        replacement = {
          entityRawId: allocation.destinationEntityId,
          kind: 'protocol_package',
          layout,
          expectedType: existingType,
          expectedPlacement: {
            ...allocation.destination,
            fileKind: existingType === 'protocol' ? 'waypoint-protocol' : 'waypoint-protocol-run',
          },
        };
      } else {
        const scientificConflict =
          versionResolution?.kind === 'resolved' && versionResolution.policy === 'use_incoming'
            ? versionResolution.conflicts.find(
                (conflict) => conflict.sourceObjectId === allocation.sourceObjectId
              )
            : undefined;
        const expectedScientificSha256 =
          allocation.destination.kind === 'package'
            ? scientificConflict?.expectedPriorScientificContentSha256
            : allocation.expectedPriorImportedHash;
        if (!expectedScientificSha256)
          throw new Error('Native scientific replacement has no reviewed scientific precondition.');
        replacement = {
          entityRawId: allocation.destinationEntityId,
          kind: 'scientific',
          expectedScientificSha256,
        };
      }
      existingEntityReplacements.set(allocation.destinationEntityId, replacement);
    }
  }
  const newObjectsPlan = await buildNativeMigrationMaterializationPlan({
    run,
    sourceObjects,
    receipts: projectionReceipts,
    resolutions: relationshipResolutions,
    folderProjection: mergedCollectionProjection,
    existingEntityRawIds: currentEntityIds,
    existingLimsEntityRawIds: currentLimsEntityIds,
    needsSequenceCompletionRawIds,
    existingEntityReplacements,
    migrationSourcesByObjectId,
  });
  for (const entity of newObjectsPlan.entities) {
    const existing = currentManifestEntityById.get(entity.rawId);
    if (!existing?.sourceIdentities?.length) continue;
    const incoming = entity.sourceIdentities ?? [];
    entity.sourceIdentities = [
      ...existing.sourceIdentities,
      ...incoming.filter(
        (identity) =>
          !existing.sourceIdentities?.some(
            (prior) =>
              prior.provider === identity.provider &&
              prior.stableObjectId === identity.stableObjectId &&
              prior.objectClass === identity.objectClass
          )
      ),
    ];
  }
  if (run.workspaceDbId && run.projectionScopeId) {
    addNativeRegistryRelationshipRepairs({
      db: input.globalDb,
      workspaceId: run.workspaceDbId,
      scopeId: run.projectionScopeId,
      currentManifest,
      plan: newObjectsPlan,
    });
    planNativeRegistryRelationshipRemovals({
      db: input.globalDb,
      scopeId: run.projectionScopeId,
      currentManifest,
      plan: newObjectsPlan,
    });
  }
  const recoveredPlan = addRecoveredNativeFolderMemberships({
    plan: newObjectsPlan,
    report,
    receipts: projectionReceipts,
    currentManifest,
    layout:
      currentManifest.schema === NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA ? 'native-v2' : 'legacy-v1',
  });
  const appendedPlan = addAppendedNativeFolderMemberships({
    plan: recoveredPlan,
    sourceObjects,
    receipts: projectionReceipts,
    currentManifest,
  });
  const selectedArtifacts = new Set(
    input.actionId
      ? (store.getLinkedItemRecoveryAttempt(run.id, input.actionId)?.artifactIds ?? [])
      : []
  );
  const incomingFolderHierarchy = capturedNativeFolderHierarchy(
    run.id,
    (input.actionId ? store.listLinkedItemRecoveryCaptures(run.id, input.actionId) : []).flatMap(
      (capture) => capture.sourceFolderMemberships ?? []
    ),
    store
      .listWorkspaceAppendHierarchyCaptures(run.id)
      .filter((capture) => selectedArtifacts.has(capture.artifactId))
  );
  const fullPlan =
    currentManifest.schema === NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA
      ? addNativeSourceFolderMemberships({
          scopeId: run.id,
          plan: appendedPlan,
          sourceObjects,
          receipts: projectionReceipts,
          currentManifest,
          incomingFolderHierarchy,
        })
      : appendedPlan;
  const fullManifest = nativeWorkspaceManifestFromPlan({
    workspacePath: run.workspacePath,
    plan: fullPlan,
    manifestVersion: currentManifest.schema === NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA ? 2 : undefined,
  });
  const newEntityIds = new Set(
    fullPlan.entities
      .filter((entity) => !currentEntityIds.has(entity.rawId))
      .map((entity) => entity.rawId)
  );
  const completionEntityIds = new Set(fullPlan.needsSequenceCompletionRawIds ?? []);
  const replacementEntityIds = new Set(
    (fullPlan.existingEntityReplacements ?? []).map((entry) => entry.entityRawId)
  );
  const mutableExistingEntityIds = new Set([...completionEntityIds, ...replacementEntityIds]);
  const currentLinkKeys = new Set(
    currentManifest.links.map((link) =>
      nativeManifestLinkKey(link.sourceId, link.relation, link.targetId)
    )
  );
  const currentEventIds = new Set((currentManifest.events ?? []).map((event) => event.id));
  const currentLimsLinkIds = new Set((currentManifest.limsLinks ?? []).map((link) => link.id));
  const additivePlan = {
    ...fullPlan,
    existingEntityRawIds: [...currentEntityIds].filter(
      (rawId) => !mutableExistingEntityIds.has(rawId)
    ),
    entities: fullPlan.entities.filter(
      (entity) => newEntityIds.has(entity.rawId) || mutableExistingEntityIds.has(entity.rawId)
    ),
    links: fullPlan.links.filter(
      (link) =>
        !currentLinkKeys.has(
          nativeManifestLinkKey(link.sourceRawId, link.relation, link.targetRawId)
        )
    ),
    events: fullPlan.events.filter(
      (event) => newEntityIds.has(event.entityRawId) && !currentEventIds.has(event.id)
    ),
    limsEntities: (fullPlan.limsEntities ?? []).filter(
      (entry) =>
        newEntityIds.has(entry.entityRawId) || mutableExistingEntityIds.has(entry.entityRawId)
    ),
    limsLinks: (fullPlan.limsLinks ?? []).filter((link) => !currentLimsLinkIds.has(link.id)),
  };
  const now = (input.now ?? (() => new Date().toISOString()))();
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error('Recovery timestamp must be an ISO date.');
  if (currentManifest.schema === NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA && input.actionId) {
    await finalizeNativeV2UnlockedRecoveryAction({
      input,
      priorManifestBytes,
      priorManifest: parseNativeWorkspaceManifest(previousManifest.toString('utf8')),
      currentManifest,
      fullManifest,
      additivePlan,
      projectionReceipts,
      reviewedNativeLinks,
      now,
      nowMs,
    });
    return;
  }
  const preRecoveryHead = await (input.finalizationDeps?.resolveHeadCommit ?? resolveHeadCommit)(
    run.workspacePath
  );
  if (!preRecoveryHead) throw new Error('Unlocked workspace Git history is incomplete.');

  const previousMachineReport = existsSync(join(run.workspacePath, MACHINE_REPORT_PATH))
    ? await readFile(join(run.workspacePath, MACHINE_REPORT_PATH))
    : null;
  const previousNativeReport = existsSync(join(run.workspacePath, NATIVE_REPORT_PATH))
    ? await readFile(join(run.workspacePath, NATIVE_REPORT_PATH))
    : null;
  const destinationIndexPath = join(
    run.workspacePath,
    MIGRATION_DESTINATION_LINK_INDEX_RELATIVE_PATH
  );
  const previousDestinationIndex = existsSync(destinationIndexPath)
    ? await readFile(destinationIndexPath)
    : null;
  const collectionProjectionSnapshot = await snapshotCollectionProjection(run.workspacePath);
  const limsSnapshot = await snapshotLimsWorkspace(run.workspacePath);
  const transactionHandle = (
    input.finalizationDeps?.openTransactionDb ?? openIsolatedUnlockTransactionDb
  )(input.globalDb);
  const transactionDb = transactionHandle.db;
  let priorGlobalBusyTimeout: number | null = null;
  let globalBusyTimeoutOverridden = false;
  let transactionStarted = false;
  let transactionCommitted = false;
  let createdNativeFolderPaths: string[] = [];
  try {
    createdNativeFolderPaths = await materializeNewNativeFolderPaths(
      run.workspacePath,
      additivePlan
    );
    await persistMigrationWorkspaceReport(run, report);
    await rm(destinationIndexPath, { force: true });

    if (transactionDb !== input.globalDb) {
      const configuredBusyTimeout = input.globalDb.pragma('busy_timeout', {
        simple: true,
      }) as unknown;
      if (
        typeof configuredBusyTimeout !== 'number' ||
        !Number.isSafeInteger(configuredBusyTimeout) ||
        configuredBusyTimeout < 0
      ) {
        throw new Error('Global database busy timeout is invalid.');
      }
      priorGlobalBusyTimeout = configuredBusyTimeout;
      input.globalDb.pragma('busy_timeout = 0');
      globalBusyTimeoutOverridden = true;
    }
    transactionDb.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    const materialized = materializeNativeWorkspaceInsideTx(transactionDb, {
      workspace: {
        name: benchlingWorkspaceName(run),
        path: run.workspacePath,
        repoUuid: migrationRunRepoUuid(run),
        createdAt: Date.parse(run.createdAt),
        lastOpenedAt: nowMs,
      },
      plan: additivePlan,
    });
    const mergedManifest = mergeNativeWorkspaceManifests(
      withoutRemovedNativeRelationships(
        currentManifest,
        additivePlan.removedRelationships
          ? {
              schema: NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA,
              entities: [],
              links: additivePlan.removedRelationships.catalog.map((link) => ({
                sourceId: link.sourceRawId,
                targetId: link.targetRawId,
                relation: link.relation,
              })),
              limsLinks: additivePlan.removedRelationships.lims.map((link) => ({
                id: link.id,
                fromEntityId: link.fromEntityRawId,
                toEntityId: link.toEntityRawId,
                type: link.type,
              })),
            }
          : undefined
      ),
      fullManifest,
      new Set([
        ...materialized.needsSequenceCompletionsAdopted,
        ...materialized.needsSequenceCompletionsCorroborated,
        ...(additivePlan.existingEntityReplacements ?? []).map((entry) => entry.entityRawId),
      ])
    );
    await writeNativeWorkspaceManifestDocument({
      workspacePath: run.workspacePath,
      manifest: mergedManifest,
    });
    if ((additivePlan.limsEntities?.length ?? 0) > 0) {
      materializeLimsGitExportForWorkspaceIds(transactionDb, [materialized.workspaceId]);
    }
    const forceInclude = await generatedWorkspaceFilesForCommit(run.workspacePath);
    await (input.finalizationDeps?.commitAllIfDirty ?? commitAllIfDirty)(
      run.workspacePath,
      'Add recovered Benchling dependencies',
      { forceInclude }
    );
    transactionDb.exec('COMMIT');
    transactionCommitted = true;
    await discardLimsSnapshot(limsSnapshot).catch((error: unknown) => {
      console.warn('[Benchling migration] Failed to remove recovery staging backup:', error);
    });
    await discardCollectionProjectionSnapshot(collectionProjectionSnapshot).catch(
      (error: unknown) => {
        console.warn('[Benchling migration] Failed to remove collection staging backup:', error);
      }
    );
  } catch (error) {
    if (transactionStarted && !transactionCommitted && transactionDb.inTransaction) {
      transactionDb.exec('ROLLBACK');
    }
    await restoreFileSnapshot(manifestPath, previousManifest);
    await restoreFileSnapshot(join(run.workspacePath, MACHINE_REPORT_PATH), previousMachineReport);
    await restoreFileSnapshot(join(run.workspacePath, NATIVE_REPORT_PATH), previousNativeReport);
    await restoreFileSnapshot(destinationIndexPath, previousDestinationIndex);
    await restoreCollectionProjectionSnapshot(collectionProjectionSnapshot);
    await restoreLimsSnapshot(limsSnapshot);
    await removeNewNativeFolderPaths(run.workspacePath, createdNativeFolderPaths);
    throw error;
  } finally {
    try {
      transactionHandle.close();
    } finally {
      if (globalBusyTimeoutOverridden && priorGlobalBusyTimeout !== null) {
        input.globalDb.pragma(`busy_timeout = ${priorGlobalBusyTimeout}`);
      }
    }
  }
}

async function finalizeNativeV2UnlockedRecoveryAction(input: {
  input: Parameters<typeof finalizeUnlockedMigrationRecovery>[0];
  priorManifestBytes: Buffer | null;
  priorManifest: NativeWorkspaceManifest;
  currentManifest: NativeWorkspaceManifest;
  fullManifest: NativeWorkspaceManifest;
  additivePlan: NativeWorkspaceMaterializationPlan;
  projectionReceipts: readonly ProjectionReceipt[];
  reviewedNativeLinks: readonly ReviewedNativeLink[];
  now: string;
  nowMs: number;
}): Promise<void> {
  const { run } = input.input;
  const actionId = input.input.actionId;
  if (!actionId) throw new Error('Native-v2 recovery action ID is missing.');
  const assertMutationLeaseHeld = input.input.assertMutationLeaseHeld ?? (() => undefined);
  assertMutationLeaseHeld();
  let needsSequenceCompletionsAdopted = new Set<string>();
  let needsSequenceCompletionsCorroborated = new Set<string>();

  await recoverBenchlingMigrationAction(run.workspacePath, actionId, {
    receipts: input.projectionReceipts,
    assertMutationLeaseHeld,
    now: () => input.now,
    completeCatalog: async (journal) => {
      assertMutationLeaseHeld();
      if (
        readNativeCatalogCommit(
          input.input.globalDb,
          run.projectionScopeId ?? run.workspaceId,
          actionId
        )
      )
        return;
      const transactionHandle = (
        input.input.finalizationDeps?.openTransactionDb ?? openIsolatedUnlockTransactionDb
      )(input.input.globalDb);
      const transactionDb = transactionHandle.db;
      let priorGlobalBusyTimeout: number | null = null;
      let globalBusyTimeoutOverridden = false;
      let transactionStarted = false;
      let catalogCommitted = false;
      let cleanupFailure: unknown = null;
      try {
        if (transactionDb !== input.input.globalDb) {
          const configuredBusyTimeout = input.input.globalDb.pragma('busy_timeout', {
            simple: true,
          }) as unknown;
          if (
            typeof configuredBusyTimeout !== 'number' ||
            !Number.isSafeInteger(configuredBusyTimeout) ||
            configuredBusyTimeout < 0
          ) {
            throw new Error('Global database busy timeout is invalid.');
          }
          priorGlobalBusyTimeout = configuredBusyTimeout;
          input.input.globalDb.pragma('busy_timeout = 0');
          globalBusyTimeoutOverridden = true;
        }
        transactionDb.exec('BEGIN IMMEDIATE');
        transactionStarted = true;
        const retainedIds = new Set(
          journal.allocations
            .filter((allocation) => allocation.writeDisposition === 'retain')
            .map((allocation) => allocation.destinationEntityId)
        );
        for (const entity of input.currentManifest.entities) {
          if (
            !retainedIds.has(entity.id) ||
            !('migrationSource' in entity) ||
            !entity.migrationSource
          )
            continue;
          transactionDb
            .prepare(
              `UPDATE catalog_entities SET metadata = json_patch(COALESCE(metadata, '{}'), ?) WHERE id = ? AND workspace_id = ?`
            )
            .run(
              JSON.stringify({ migrationSource: entity.migrationSource }),
              scopedProjectionId(journal.workspace.projectionScopeId, entity.id),
              journal.workspace.workspaceDbId
            );
        }
        for (const link of input.reviewedNativeLinks) {
          if (!run.workspaceDbId) throw new Error('Reviewed native link requires a workspace row.');
          linkReviewedExactNativeMatch({
            db: transactionDb,
            workspaceDbId: run.workspaceDbId,
            runId: run.id,
            sourceObject: link.sourceObject,
            candidateEntityId: link.decision.candidateEntityId,
            expectedCandidateScientificSha256: link.decision.expectedCandidateScientificSha256,
          });
          transactionDb
            .prepare(
              `UPDATE catalog_entities SET metadata = json_patch(COALESCE(metadata, '{}'), ?) WHERE id = ?`
            )
            .run(
              JSON.stringify({ migrationSource: link.entity.migrationSource }),
              link.decision.candidateEntityId
            );
        }
        const materialized = materializeNativeWorkspaceInsideTx(transactionDb, {
          workspace: {
            name: benchlingWorkspaceName(run),
            path: run.workspacePath,
            repoUuid: migrationRunRepoUuid(run),
            createdAt: Date.parse(run.createdAt),
            lastOpenedAt: input.nowMs,
          },
          plan: input.additivePlan,
        });
        needsSequenceCompletionsAdopted = new Set(materialized.needsSequenceCompletionsAdopted);
        needsSequenceCompletionsCorroborated = new Set(
          materialized.needsSequenceCompletionsCorroborated
        );
        recordNativeCatalogCommit(
          transactionDb,
          run.projectionScopeId ?? run.workspaceId,
          actionId,
          {
            workspaceId: materialized.workspaceId,
            manifest: input.fullManifest,
            replacedEntityIds: [
              ...needsSequenceCompletionsAdopted,
              ...needsSequenceCompletionsCorroborated,
              ...(input.additivePlan.existingEntityReplacements ?? []).map(
                (entry) => entry.entityRawId
              ),
            ],
            existingEntityIds: input.currentManifest.entities.map((entity) => entity.id),
            publishLims: true,
            ...(input.additivePlan.removedRelationships
              ? {
                  removedRelationships: {
                    schema: NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA,
                    entities: [],
                    links: input.additivePlan.removedRelationships.catalog.map((link) => ({
                      sourceId: link.sourceRawId,
                      targetId: link.targetRawId,
                      relation: link.relation,
                    })),
                    limsLinks: input.additivePlan.removedRelationships.lims.map((link) => ({
                      id: link.id,
                      fromEntityId: link.fromEntityRawId,
                      toEntityId: link.toEntityRawId,
                      type: link.type,
                    })),
                  },
                }
              : {}),
          },
          input.priorManifest
        );
        const committed = readNativeCatalogCommit(
          transactionDb,
          run.projectionScopeId ?? run.workspaceId,
          actionId
        );
        if (!committed)
          throw new Error('Import catalog receipt is missing inside its transaction.');
        transactionDb.exec('COMMIT');
        transactionStarted = false;
        catalogCommitted = true;
      } catch (error) {
        if (transactionStarted && transactionDb.inTransaction) transactionDb.exec('ROLLBACK');
        throw error;
      } finally {
        try {
          try {
            transactionHandle.close();
          } finally {
            if (globalBusyTimeoutOverridden && priorGlobalBusyTimeout !== null) {
              input.input.globalDb.pragma(`busy_timeout = ${priorGlobalBusyTimeout}`);
            }
          }
        } catch (error) {
          cleanupFailure = error;
        }
      }
      if (cleanupFailure) {
        if (catalogCommitted)
          throw new BenchlingMigrationActionRecoveryError(
            'catalog_commit_uncertain',
            'Catalog committed but transaction cleanup failed. Resume without restoring displaced paths.',
            cleanupFailure
          );
        throw cleanupFailure;
      }
    },
    mergeManifest: async () => {
      assertMutationLeaseHeld();
      const committed = readNativeCatalogCommit(
        input.input.globalDb,
        run.projectionScopeId ?? run.workspaceId,
        actionId
      );
      const currentBytes = await readNativeCatalogPublicationBase({
        workspacePath: run.workspacePath,
        operationId: actionId,
      });
      if (
        !(currentBytes === null
          ? input.priorManifestBytes === null
          : input.priorManifestBytes?.equals(currentBytes))
      )
        throw new Error(
          'Native catalog changed after finalization began; preserve the later edit before resuming.'
        );
      const currentManifest =
        currentBytes === null ? null : parseNativeWorkspaceManifest(currentBytes.toString('utf8'));
      if (committed)
        assertNativeCatalogCommitRecordsUnchanged({
          db: input.input.globalDb,
          scopeId: run.projectionScopeId ?? run.workspaceId,
          commit: committed,
          currentManifest,
        });
      const mergedManifest = mergeNativeWorkspaceManifests(
        withoutRemovedNativeRelationships(input.currentManifest, committed?.removedRelationships),
        committed?.manifest ?? input.fullManifest,
        new Set(
          committed?.replacedEntityIds ?? [
            ...needsSequenceCompletionsAdopted,
            ...needsSequenceCompletionsCorroborated,
            ...(input.additivePlan.existingEntityReplacements ?? []).map(
              (replacement) => replacement.entityRawId
            ),
          ]
        )
      );
      await materializeNewNativeFolderPaths(run.workspacePath, input.additivePlan);
      await writeNativeWorkspaceManifestDocument({
        workspacePath: run.workspacePath,
        publication: { operationId: actionId, beforeBytes: input.priorManifestBytes },
        manifest: mergedManifest,
      });
      if (committed?.publishLims)
        await publishActionLimsExport({
          db: input.input.globalDb,
          workspaceDbId: committed.workspaceId,
          workspacePath: run.workspacePath,
          actionId,
        });
      await persistMigrationWorkspaceReport(
        run,
        input.input.report,
        input.input.store.getSourceSnapshot(run.id) ?? undefined
      );
      await rm(join(run.workspacePath, MIGRATION_DESTINATION_LINK_INDEX_RELATIVE_PATH), {
        force: true,
      });
      await removeCollectionProjection(run.workspacePath);
    },
    verifyCatalogManifestAgreement: async (journal) => {
      assertMutationLeaseHeld();
      const manifest = parseNativeWorkspaceManifest(
        await readFile(join(run.workspacePath, NATIVE_WORKSPACE_MANIFEST_PATH), 'utf8')
      );
      if (!nativeManifestIsRegistered(input.input.globalDb, run, manifest)) {
        throw new Error('The additive native workspace manifest is not registered.');
      }
      assertNativeActionCatalogIntegrity({
        db: input.input.globalDb,
        workspacePath: run.workspacePath,
        journal,
        manifest,
      });
    },
  });
}

const LEGACY_GENERATED_WORKSPACE_COMMIT_ROOTS = [
  'Benchling Imports',
  '.forge',
  '.waypoint/lims',
] as const;

async function generatedWorkspaceFilesForCommit(workspacePath: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (relativePath: string): Promise<void> => {
    const absolutePath = join(workspacePath, relativePath);
    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`Generated migration path contains a symbolic link: ${relativePath}`);
    }
    if (stats.isFile()) {
      files.push(relativePath.replaceAll('\\', '/'));
      return;
    }
    if (!stats.isDirectory()) {
      throw new Error(
        `Generated migration path is not a regular file or directory: ${relativePath}`
      );
    }
    const entries = await readdir(absolutePath, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Generated migration path contains a symbolic link: ${relativePath}/${entry.name}`
        );
      }
      await visit(`${relativePath}/${entry.name}`);
    }
  };
  const journalOwnedRoots = await actionOwnedVisibleRoots(workspacePath);
  const roots =
    journalOwnedRoots.length > 0
      ? [...journalOwnedRoots, '.forge', '.waypoint/lims']
      : [...LEGACY_GENERATED_WORKSPACE_COMMIT_ROOTS];
  for (const root of [...new Set(roots)].sort()) await visit(root);
  return files.sort();
}

async function actionOwnedVisibleRoots(workspacePath: string): Promise<string[]> {
  const actionsPath = join(workspacePath, BENCHLING_MIGRATION_ACTIONS_RELATIVE_PATH);
  let entries;
  try {
    entries = await readdir(actionsPath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const roots = new Set<string>();
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const journal = parseBenchlingMigrationActionJournal(
      JSON.parse(await readFile(join(actionsPath, entry.name), 'utf8'))
    );
    for (const allocation of journal.allocations) {
      for (const path of allocation.actionOwnedPaths) {
        if (!path.toLowerCase().startsWith('.dnaforge/')) roots.add(path);
      }
    }
  }
  return [...roots].sort();
}

function nativeManifestIsRegistered(
  db: Database.Database,
  run: MigrationRun,
  manifest: NativeWorkspaceManifest
): boolean {
  const workspace = db
    .prepare('SELECT id, repo_uuid FROM workspaces WHERE path = ?')
    .get(run.workspacePath) as { id: number; repo_uuid: string | null } | undefined;
  if (!workspace || workspace.repo_uuid !== migrationRunRepoUuid(run)) return false;
  const expectedIds = manifest.entities.map((entity) =>
    scopedProjectionId(
      run.projectionScopeId ??
        workspaceScopeKey(migrationRunRepoUuid(run), workspace.id) ??
        run.workspaceId,
      entity.id
    )
  );
  const row = db
    .prepare(
      `SELECT COUNT(*) AS missing_count
       FROM json_each(?) AS expected
       LEFT JOIN catalog_entities AS entity
         ON entity.id = expected.value AND entity.workspace_id = ?
       WHERE entity.id IS NULL`
    )
    .get(JSON.stringify(expectedIds), workspace.id) as { missing_count: number };
  if (row.missing_count !== 0) return false;
  if (manifest.schema !== NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA) return true;
  const virtualPlacements = manifest.entities.flatMap((entity) => {
    if (entity.placement.kind !== 'catalog-record') return [];
    return [
      {
        entityId: scopedProjectionId(
          run.projectionScopeId ??
            workspaceScopeKey(migrationRunRepoUuid(run), workspace.id) ??
            run.workspaceId,
          entity.id
        ),
        parentRelativePath: entity.placement.parentRelativePath,
        displayName: entity.placement.displayName,
        presentationKind: entity.placement.presentationKind,
      },
    ];
  });
  const placementRow = db
    .prepare(
      `SELECT COUNT(*) AS missing_count
       FROM json_each(?) AS expected
       LEFT JOIN catalog_workspace_placements AS placement
         ON placement.entity_id = json_extract(expected.value, '$.entityId')
        AND placement.workspace_id = ?
        AND placement.parent_relative_path = json_extract(expected.value, '$.parentRelativePath')
        AND placement.display_name = json_extract(expected.value, '$.displayName')
        AND placement.presentation_kind = json_extract(expected.value, '$.presentationKind')
        AND placement.status = 'active'
       WHERE placement.entity_id IS NULL`
    )
    .get(JSON.stringify(virtualPlacements), workspace.id) as { missing_count: number };
  return placementRow.missing_count === 0;
}

function migrationRunRepoUuid(run: MigrationRun): string | null {
  return run.repoUuid === undefined ? run.workspaceId : run.repoUuid;
}

function mergeNativeWorkspaceManifests(
  current: NativeWorkspaceManifest,
  complete: NativeWorkspaceManifest,
  replaceEntityIds: ReadonlySet<string> = new Set()
): NativeWorkspaceManifest {
  const linkKeys = new Set(
    current.links.map((link) => nativeManifestLinkKey(link.sourceId, link.relation, link.targetId))
  );
  const eventIds = new Set((current.events ?? []).map((event) => event.id));
  const limsLinkIds = new Set((current.limsLinks ?? []).map((link) => link.id));
  const events = [
    ...(current.events ?? []),
    ...(complete.events ?? []).filter((event) => !eventIds.has(event.id)),
  ];
  const limsLinks = [
    ...(current.limsLinks ?? []),
    ...(complete.limsLinks ?? []).filter((link) => !limsLinkIds.has(link.id)),
  ];
  const shared = {
    links: [
      ...current.links,
      ...complete.links.filter(
        (link) => !linkKeys.has(nativeManifestLinkKey(link.sourceId, link.relation, link.targetId))
      ),
    ],
    ...(events.length > 0 ? { events } : {}),
    ...(limsLinks.length > 0 ? { limsLinks } : {}),
  };
  if (current.schema === NATIVE_WORKSPACE_MANIFEST_SCHEMA) {
    if (complete.schema !== NATIVE_WORKSPACE_MANIFEST_SCHEMA) {
      throw new Error('Native workspace manifest versions cannot be merged.');
    }
    return {
      schema: NATIVE_WORKSPACE_MANIFEST_SCHEMA,
      entities: mergeNativeWorkspaceManifestEntities(
        current.entities,
        complete.entities,
        replaceEntityIds
      ),
      ...shared,
    };
  }
  if (complete.schema !== NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA) {
    throw new Error('Native workspace manifest versions cannot be merged.');
  }
  return {
    schema: NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA,
    entities: mergeNativeWorkspaceManifestEntities(
      current.entities,
      complete.entities,
      replaceEntityIds
    ),
    ...shared,
  };
}

function mergeNativeWorkspaceManifestEntities<Entity extends { id: string }>(
  current: readonly Entity[],
  complete: readonly Entity[],
  replaceEntityIds: ReadonlySet<string>
): Entity[] {
  const entityIds = new Set(current.map((entity) => entity.id));
  const completeEntityById = new Map(complete.map((entity) => [entity.id, entity]));
  const retainedOrReplaced = current.map((entity) => {
    if (!replaceEntityIds.has(entity.id)) return entity;
    const replacement = completeEntityById.get(entity.id);
    if (!replacement) {
      throw new Error(`Native manifest replacement is missing entity ${entity.id}.`);
    }
    return replacement;
  });
  return [...retainedOrReplaced, ...complete.filter((entity) => !entityIds.has(entity.id))];
}

function addRecoveredNativeFolderMemberships(input: {
  plan: NativeWorkspaceMaterializationPlan;
  report: ValidationReport;
  receipts: readonly ProjectionReceipt[];
  currentManifest?: NativeWorkspaceManifest;
  layout: 'legacy-v1' | 'native-v2';
}): NativeWorkspaceMaterializationPlan {
  if (!isValidationReportV2(input.report) || !input.report.linkedItemRecovery?.evidence) {
    return input.plan;
  }
  const evidence = input.report.linkedItemRecovery.evidence;
  const receiptBySourceId = new Map(
    input.receipts.map((receipt) => [receipt.sourceObjectId, receipt])
  );
  const existingFolders = [
    ...input.plan.entities
      .filter((entity) => entity.type === 'folder')
      .map((entity) => ({
        id: entity.rawId,
        path:
          entity.placement?.kind === 'file' ? entity.placement.relativePath : entity.relativePath,
        sourceFolderId:
          typeof entity.metadata?.sourceFolderIdentity === 'string'
            ? entity.metadata.sourceFolderIdentity
            : null,
      })),
    ...(input.currentManifest?.entities ?? [])
      .filter((entity) => entity.type === 'folder')
      .map((entity) => ({
        id: entity.id,
        path: nativeWorkspaceEntityPhysicalRoot(entity),
        sourceFolderId:
          typeof entity.metadata?.sourceFolderIdentity === 'string'
            ? entity.metadata.sourceFolderIdentity
            : null,
      }))
      .filter((entity): entity is typeof entity & { path: string } => entity.path !== null),
  ];
  const folderBySourceId = new Map<string, (typeof existingFolders)[number]>();
  for (const folder of existingFolders) {
    if (folder.sourceFolderId) folderBySourceId.set(folder.sourceFolderId, folder);
  }
  const folderById = new Map(existingFolders.map((folder) => [folder.id, folder]));
  const occupiedPaths = new Set(
    [
      ...input.plan.entities.flatMap((entity) =>
        entity.placement?.kind === 'file'
          ? [entity.placement.relativePath]
          : entity.placement?.kind === 'package'
            ? [entity.placement.rootRelativePath]
            : entity.relativePath
              ? [entity.relativePath]
              : []
      ),
      ...(input.currentManifest?.entities ?? []).flatMap((entity) => {
        const path = nativeWorkspaceEntityPhysicalRoot(entity);
        return path ? [path] : [];
      }),
    ].map(allocationCollisionKey)
  );
  const entities = [...input.plan.entities];
  const links = [...input.plan.links];
  const events = [...input.plan.events];
  const linkKeys = new Set(
    links.map((link) => nativeManifestLinkKey(link.sourceRawId, link.relation, link.targetRawId))
  );
  const importedAt = Date.parse(input.report.generatedAt);
  if (!Number.isFinite(importedAt)) {
    throw new Error('Linked-item recovery report timestamp is invalid.');
  }

  for (const folder of [...evidence.folders].sort((left, right) =>
    left.sourceId.localeCompare(right.sourceId)
  )) {
    const deterministicId = collectionDestinationId(folder.sourceId);
    const existing = folderBySourceId.get(folder.sourceId) ?? folderById.get(deterministicId);
    const folderId = existing?.id ?? deterministicId;
    if (!existing) {
      const relativePath = allocateRecoveredFolderPath(
        folder.name,
        deterministicId,
        occupiedPaths,
        input.layout
      );
      entities.push({
        rawId: deterministicId,
        type: 'folder',
        name: folder.name,
        locator: { kind: 'file' },
        storageType: 'file',
        ...(input.layout === 'native-v2'
          ? {
              placement: {
                kind: 'file' as const,
                relativePath,
                fileKind: 'folder',
              },
            }
          : { relativePath, fileKind: 'folder' }),
        metadata: {
          imported: true,
          sourceFolderIdentity: folder.sourceId,
          sourceProvider: 'benchling',
          selectedRoot: false,
          recoveredAfterMigration: true,
        },
      });
      events.push({
        id: migrationEvidenceId('import', `${folder.sourceId}:folder`),
        entityRawId: deterministicId,
        eventType: 'imported',
        actor: 'migration',
        summary: 'Imported linked-item folder into DNAForge',
        payload: { source: 'external_migration' },
        createdAt: importedAt,
      });
      folderBySourceId.set(folder.sourceId, {
        id: deterministicId,
        path: relativePath,
        sourceFolderId: folder.sourceId,
      });
      folderById.set(deterministicId, {
        id: deterministicId,
        path: relativePath,
        sourceFolderId: folder.sourceId,
      });
    }

    for (const target of evidence.targets.filter(
      (target) => target.folderId === folder.sourceId && target.recovered
    )) {
      const receipt = receiptBySourceId.get(target.sourceId);
      if (!receipt) {
        throw new Error(`Recovered linked item ${target.sourceId} has no native receipt.`);
      }
      const key = nativeManifestLinkKey(folderId, 'contains', receipt.destinationObjectId);
      if (linkKeys.has(key)) continue;
      links.push({
        sourceRawId: folderId,
        relation: 'contains',
        targetRawId: receipt.destinationObjectId,
        evidence: { kind: 'linked_item_recovery_folder_membership' },
      });
      linkKeys.add(key);
    }
  }
  return { ...input.plan, entities, links, events };
}

function addAppendedNativeFolderMemberships(input: {
  plan: NativeWorkspaceMaterializationPlan;
  sourceObjects: readonly SourceObject[];
  receipts: readonly ProjectionReceipt[];
  currentManifest?: NativeWorkspaceManifest;
}): NativeWorkspaceMaterializationPlan {
  const folderIdBySourceFolderId = new Map<string, string>();
  const knownFolderIds = new Set<string>();
  for (const entity of input.plan.entities) {
    if (entity.type !== 'folder') continue;
    knownFolderIds.add(entity.rawId);
    if (typeof entity.metadata?.sourceFolderIdentity === 'string') {
      folderIdBySourceFolderId.set(entity.metadata.sourceFolderIdentity, entity.rawId);
    }
  }
  for (const entity of input.currentManifest?.entities ?? []) {
    if (entity.type !== 'folder') continue;
    knownFolderIds.add(entity.id);
    if (typeof entity.metadata?.sourceFolderIdentity === 'string') {
      folderIdBySourceFolderId.set(entity.metadata.sourceFolderIdentity, entity.id);
    }
  }
  if (knownFolderIds.size === 0) return input.plan;

  const receiptBySourceId = new Map(
    input.receipts.map((receipt) => [receipt.sourceObjectId, receipt])
  );
  const links = [...input.plan.links];
  const linkKeys = new Set(
    links.map((link) => nativeManifestLinkKey(link.sourceRawId, link.relation, link.targetRawId))
  );
  for (const link of input.currentManifest?.links ?? []) {
    linkKeys.add(nativeManifestLinkKey(link.sourceId, link.relation, link.targetId));
  }

  for (const sourceObject of [...input.sourceObjects].sort((left, right) =>
    left.id.localeCompare(right.id)
  )) {
    const receipt = receiptBySourceId.get(sourceObject.id);
    if (!receipt) continue;
    for (const membership of [...new Set(sourceObject.memberships)].sort()) {
      const folderId =
        folderIdBySourceFolderId.get(membership) ??
        (knownFolderIds.has(collectionDestinationId(membership))
          ? collectionDestinationId(membership)
          : null);
      if (!folderId) continue;
      const key = nativeManifestLinkKey(folderId, 'contains', receipt.destinationObjectId);
      if (linkKeys.has(key)) continue;
      links.push({
        sourceRawId: folderId,
        relation: 'contains',
        targetRawId: receipt.destinationObjectId,
        evidence: { kind: 'workspace_append_folder_membership' },
      });
      linkKeys.add(key);
    }
  }
  return { ...input.plan, links };
}

function allocateRecoveredFolderPath(
  title: string,
  folderId: string,
  occupiedPaths: Set<string>,
  layout: 'legacy-v1' | 'native-v2'
): string {
  const readable = safeDestinationSegment(title, 'Imported folder');
  const basePath = layout === 'native-v2' ? readable : `Benchling Imports/Folders/${readable}`;
  let candidate = basePath;
  let suffix = 1;
  while (occupiedPaths.has(allocationCollisionKey(candidate))) {
    candidate = `${basePath}-${folderId.slice(-8)}${suffix === 1 ? '' : `-${suffix}`}`;
    suffix += 1;
  }
  occupiedPaths.add(allocationCollisionKey(candidate));
  return candidate;
}

async function materializeNewNativeFolderPaths(
  workspacePath: string,
  plan: NativeWorkspaceMaterializationPlan
): Promise<string[]> {
  const created: string[] = [];
  for (const entity of plan.entities) {
    const relativePath =
      entity.placement?.kind === 'file' ? entity.placement.relativePath : entity.relativePath;
    if (entity.type !== 'folder' || !relativePath) continue;
    const absolutePath = join(workspacePath, relativePath);
    if (existsSync(absolutePath)) {
      const stats = await lstat(absolutePath);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error(`Native folder path is not a regular directory: ${relativePath}`);
      }
      continue;
    }
    await mkdir(absolutePath, { recursive: true });
    if (!entity.placement) await writeFile(join(absolutePath, '.gitkeep'), '', { flag: 'wx' });
    created.push(relativePath);
  }
  return created;
}

async function removeNewNativeFolderPaths(
  workspacePath: string,
  relativePaths: readonly string[]
): Promise<void> {
  for (const relativePath of [...relativePaths].reverse()) {
    await rm(join(workspacePath, relativePath), { recursive: true, force: true });
  }
}

function nativeManifestLinkKey(sourceId: string, relation: string, targetId: string): string {
  return `${sourceId}\u0000${relation}\u0000${targetId}`;
}

async function restoreNativeWorkspaceManifest(
  workspacePath: string,
  previous: Buffer | null
): Promise<void> {
  const path = join(workspacePath, NATIVE_WORKSPACE_MANIFEST_PATH);
  if (previous === null) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(join(workspacePath, '.forge'), { recursive: true });
  await writeFile(path, previous);
}

async function restoreFileSnapshot(path: string, previous: Buffer | null): Promise<void> {
  if (previous === null) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, previous);
}

type CollectionProjectionSnapshot = {
  workspacePath: string;
  backupRoot: string;
  collectionsExisted: boolean;
  v2CollectionsExisted: boolean;
  manifestExisted: boolean;
};

async function snapshotCollectionProjection(
  workspacePath: string
): Promise<CollectionProjectionSnapshot> {
  const backupRoot = join(
    workspacePath,
    '.dnaforge',
    'migration',
    'projection-staging',
    `native-folders-${randomUUID()}`
  );
  const collectionsPath = join(workspacePath, 'Benchling Imports', 'Collections');
  const v2CollectionsPath = join(workspacePath, '.dnaforge', 'migration', 'collections');
  const manifestPath = join(workspacePath, COLLECTION_PROJECTION_MANIFEST_PATH);
  const collectionsExisted = existsSync(collectionsPath);
  const v2CollectionsExisted = existsSync(v2CollectionsPath);
  const manifestExisted = existsSync(manifestPath);
  await mkdir(backupRoot, { recursive: true });
  if (collectionsExisted) {
    await cp(collectionsPath, join(backupRoot, 'Collections'), { recursive: true, force: false });
  }
  if (v2CollectionsExisted) {
    await cp(v2CollectionsPath, join(backupRoot, 'collections-v2'), {
      recursive: true,
      force: false,
    });
  }
  if (manifestExisted) {
    await cp(manifestPath, join(backupRoot, 'collection-projection.json'), { force: false });
  }
  return {
    workspacePath,
    backupRoot,
    collectionsExisted,
    v2CollectionsExisted,
    manifestExisted,
  };
}

async function removeCollectionProjection(workspacePath: string): Promise<void> {
  await rm(join(workspacePath, 'Benchling Imports', 'Collections'), {
    recursive: true,
    force: true,
  });
  await rm(join(workspacePath, '.dnaforge', 'migration', 'collections'), {
    recursive: true,
    force: true,
  });
  await rm(join(workspacePath, COLLECTION_PROJECTION_MANIFEST_PATH), { force: true });
}

async function restoreCollectionProjectionSnapshot(
  snapshot: CollectionProjectionSnapshot | null
): Promise<void> {
  if (!snapshot) return;
  await removeCollectionProjection(snapshot.workspacePath);
  if (snapshot.collectionsExisted) {
    await mkdir(join(snapshot.workspacePath, 'Benchling Imports'), { recursive: true });
    await cp(
      join(snapshot.backupRoot, 'Collections'),
      join(snapshot.workspacePath, 'Benchling Imports', 'Collections'),
      {
        recursive: true,
        force: false,
      }
    );
  }
  if (snapshot.v2CollectionsExisted) {
    const destination = join(snapshot.workspacePath, '.dnaforge', 'migration', 'collections');
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(snapshot.backupRoot, 'collections-v2'), destination, {
      recursive: true,
      force: false,
    });
  }
  if (snapshot.manifestExisted) {
    const destination = join(snapshot.workspacePath, COLLECTION_PROJECTION_MANIFEST_PATH);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(snapshot.backupRoot, 'collection-projection.json'), destination, {
      force: false,
    });
  }
  await rm(snapshot.backupRoot, { recursive: true, force: true });
}

async function discardCollectionProjectionSnapshot(
  snapshot: CollectionProjectionSnapshot | null
): Promise<void> {
  if (!snapshot) return;
  await rm(snapshot.backupRoot, { recursive: true, force: true });
}

async function verifyImmutableSourceBeforeUnlock(
  run: MigrationRun,
  report: ValidationReport,
  store: MigrationStore
): Promise<void> {
  const snapshot = store.getSourceSnapshot(run.id);
  if (!snapshot) {
    throw new Error('Immutable source evidence is missing at the unlock boundary.');
  }
  if (snapshot.id !== report.snapshotId) {
    throw new Error('Immutable source snapshot does not match the passing validation report.');
  }
  const sourceIdentityHash = migrationRunSourceIdentityHash(run);
  if (!sourceIdentityHash || snapshot.accountHash !== sourceIdentityHash) {
    throw new Error('Immutable source snapshot does not match the immutable source identity.');
  }
  const emptyScopedFolderSnapshot =
    run.scope.kind !== 'file' &&
    snapshot.expectedSourceObjectCount === 0 &&
    snapshot.expectedAttachmentCount === 0 &&
    snapshot.expectedMembershipCount === 0 &&
    store.listExportJobs(run.id).length === 0 &&
    store.listSourceObjects(run.id).length === 0;
  if (snapshot.parts.length === 0 && !emptyScopedFolderSnapshot) {
    throw new Error('Immutable source snapshot has no captured source parts.');
  }

  const archive = new ContentArchive(join(run.workspacePath, MIGRATION_DATA_DIR, 'archive'));
  let sourceManifest: Awaited<ReturnType<ContentArchive['verifyManifest']>>;
  try {
    if (run.externalZipSource) {
      await verifyExternalZipSource(run.externalZipSource);
      if (!run.externalZipEntries) {
        throw new Error('External ZIP entry evidence is missing.');
      }
      const localPart = snapshot.parts.find(
        (part) => part.kind === 'local_export' && part.sourceObjectId === null
      );
      if (!localPart) throw new Error('External ZIP snapshot part is missing.');
      const objectIdByStableId = new Map(
        store
          .listSourceObjects(run.id)
          .map((sourceObject) => [sourceObject.stableId, sourceObject.id] as const)
      );
      sourceManifest = {
        version: 1,
        entries: run.externalZipEntries.map((entry) => ({
          logicalFilename: basename(entry.entryPath),
          sourceArchivePath: entry.entryPath,
          sha256: entry.entrySha256.slice('sha256:'.length),
          size: entry.sizeBytes,
          archivePartId: localPart.id,
          sourceObjectId: objectIdByStableId.get(entry.sourceObjectId) ?? null,
        })),
      };
    } else {
      sourceManifest = await archive.verifyManifest(snapshot.archiveManifestId);
    }
    for (const part of snapshot.parts) {
      const mainExternalSource =
        run.externalZipSource &&
        part.kind === 'local_export' &&
        part.sha256 === run.externalZipSource.zipSha256.slice('sha256:'.length) &&
        part.sizeBytes === run.externalZipSource.sizeBytes
          ? run.externalZipSource
          : null;
      const supplementalExternalRecord =
        part.kind === 'supplemental_local_export'
          ? store.getLinkedItemRecoveryArtifactBySha256(run.id, `sha256:${part.sha256}`)
          : null;
      const externalSource =
        mainExternalSource ??
        (supplementalExternalRecord?.schema === 'dnaforge.benchling.linked-item-recovery-source.v2'
          ? supplementalExternalRecord.externalZipSource
          : null);
      if (externalSource) await verifyExternalZipSource(externalSource);
      else await archive.verifyBlob(part.sha256, part.sizeBytes);
      const primaryExactAssociations = sourceManifest.entries.filter(
        (entry) =>
          entry.archivePartId === part.id &&
          (entry.sourceObjectId ?? null) === part.sourceObjectId &&
          entry.sha256 === part.sha256 &&
          entry.size === part.sizeBytes
      );
      const additiveManifestKind =
        part.kind === 'targeted_read'
          ? 'targeted'
          : part.kind === 'supplemental_local_export'
            ? 'supplemental'
            : null;
      const associationManifest =
        additiveManifestKind && primaryExactAssociations.length === 0
          ? supplementalExternalRecord?.schema ===
            'dnaforge.benchling.linked-item-recovery-source.v2'
            ? {
                version: 1 as const,
                entries: [
                  {
                    logicalFilename: supplementalExternalRecord.externalZipSource.displayName,
                    sourceArchivePath: supplementalExternalRecord.externalZipSource.displayName,
                    sha256: supplementalExternalRecord.externalZipSource.zipSha256.slice(
                      'sha256:'.length
                    ),
                    size: supplementalExternalRecord.externalZipSource.sizeBytes,
                    archivePartId: part.id,
                    sourceObjectId: part.sourceObjectId,
                  },
                ],
              }
            : await archive.verifyManifest(migrationEvidenceId(additiveManifestKind, part.id))
          : sourceManifest;
      const exactAssociations = associationManifest.entries.filter(
        (entry) =>
          entry.archivePartId === part.id &&
          (entry.sourceObjectId ?? null) === part.sourceObjectId &&
          entry.sha256 === part.sha256 &&
          entry.size === part.sizeBytes
      );
      if (!externalSource && exactAssociations.length !== 1) {
        throw new Error(
          `Snapshot part ${part.id} does not have one exact immutable manifest association.`
        );
      }
    }
  } catch (cause) {
    throw new Error('Immutable source evidence failed integrity verification before unlock.', {
      cause,
    });
  }

  if (run.scope.kind !== 'file') {
    const hasLocalFolderMarker =
      run.scope.acquisition === 'local_bundle' ||
      run.localExportArtifact !== undefined ||
      (isValidationReportV2(report) && report.localExport !== undefined);
    if (hasLocalFolderMarker) {
      await verifyLocalFolderAuthorityBeforeUnlock(
        { ...run, scope: run.scope },
        report,
        snapshot,
        store
      );
      return;
    }
    if (!run.binding) {
      throw new Error('Selected Folder unlock requires a confirmed source binding.');
    }
    const sourceAccountHash = run.binding.accountHash;
    if (!isValidationReportV2(report) || !report.scopedBoundary?.evidence) {
      throw new Error('The passing report is missing selected Folder boundary evidence.');
    }
    let reopenedBoundaryEvidence: ScopedBoundaryEvidenceV1 | null = null;
    try {
      const boundaryEntries = sourceManifest.entries.filter(
        (entry) => entry.sourceArchivePath === SCOPED_BOUNDARY_EVIDENCE_PATH
      );
      if (
        boundaryEntries.length !== 1 ||
        boundaryEntries[0].logicalFilename !== 'scoped-boundary-evidence.json' ||
        boundaryEntries[0].sha256 !== report.scopedBoundary.evidence.canonicalSha256 ||
        (emptyScopedFolderSnapshot && sourceManifest.entries.length !== 1)
      ) {
        throw new Error(
          'Source snapshot manifest does not match the validated scoped boundary digest.'
        );
      }
      reopenedBoundaryEvidence = await readScopedBoundaryEvidence({
        workspacePath: run.workspacePath,
        runId: run.id,
        scope: run.scope,
        sourceAccountHash,
        sourceIdMode: report.scopedBoundary.evidence.sourceIdMode,
      });
      assertScopedBoundaryAttestationMatchesEvidence(
        report.scopedBoundary.evidence,
        reopenedBoundaryEvidence
      );
    } catch (cause) {
      throw new Error(
        'Selected Folder boundary evidence failed integrity verification before unlock.',
        {
          cause,
        }
      );
    }

    if (run.scope.kind === 'folder') {
      try {
        const directFolderPlan = store.getDirectFolderCapturePlan(run.id);
        const directFolderJournal = store.getScopedFolderTraversalJournal(run.id);
        const reportedDirectFolderCapture = report.directFolderCapture;
        const requiresDirectFolderAttestation =
          directFolderPlan !== null ||
          directFolderJournal?.scopeKind === 'folder' ||
          reportedDirectFolderCapture !== undefined ||
          report.scopedBoundary.evidence.sourceIdMode === 'benchling';
        if (requiresDirectFolderAttestation) {
          if (
            !directFolderPlan ||
            !directFolderJournal ||
            !reportedDirectFolderCapture?.passed ||
            !reportedDirectFolderCapture.evidence ||
            !reopenedBoundaryEvidence
          ) {
            throw new Error(
              'The passing report or durable store is missing required Direct Folder capture authority.'
            );
          }
          const recomputed = validateDirectFolderCaptureAttestation({
            run,
            exportJobs: store.listExportJobs(run.id),
            exportCaptures: store.listExportCaptures(run.id),
            exportJobReplacements: store.listExportJobReplacements(run.id),
            scopedBoundaryEvidence: reopenedBoundaryEvidence,
            scopedBoundarySourceIdMode: report.scopedBoundary.evidence.sourceIdMode,
            directFolderCapturePlan: directFolderPlan,
            directFolderTraversalJournal: directFolderJournal,
          });
          if (!recomputed?.passed || !samePersistedValue(recomputed, reportedDirectFolderCapture)) {
            throw new Error(
              'The passing report does not match recomputed Direct Folder authority and lineage evidence.'
            );
          }
        }
      } catch (cause) {
        throw new Error(
          'Direct Folder capture evidence failed integrity verification before unlock.',
          { cause }
        );
      }
    } else if (run.scope.kind === 'folder_tree') {
      try {
        const folderTreePlan = store.getFolderTreeCapturePlan(run.id);
        const folderTreeJournal = store.getScopedFolderTraversalJournal(run.id);
        const reportedFolderTreeCapture = report.folderTreeCapture;
        const requiresFolderTreeAttestation =
          folderTreePlan !== null ||
          folderTreeJournal?.scopeKind === 'folder_tree' ||
          reportedFolderTreeCapture !== undefined ||
          report.scopedBoundary.evidence.sourceIdMode === 'benchling';
        if (requiresFolderTreeAttestation) {
          if (
            !folderTreePlan ||
            !folderTreeJournal ||
            !reportedFolderTreeCapture?.passed ||
            !reportedFolderTreeCapture.evidence ||
            !reopenedBoundaryEvidence
          ) {
            throw new Error(
              'The passing report or durable store is missing required Folder Tree capture authority.'
            );
          }
          const recomputed = validateFolderTreeCaptureAttestation({
            run,
            exportJobs: store.listExportJobs(run.id),
            exportCaptures: store.listExportCaptures(run.id),
            exportJobReplacements: store.listExportJobReplacements(run.id),
            scopedBoundaryEvidence: reopenedBoundaryEvidence,
            scopedBoundarySourceIdMode: report.scopedBoundary.evidence.sourceIdMode,
            folderTreeCapturePlan: folderTreePlan,
            folderTreeTraversalJournal: folderTreeJournal,
          });
          if (!recomputed?.passed || !samePersistedValue(recomputed, reportedFolderTreeCapture)) {
            throw new Error(
              'The passing report does not match recomputed Folder Tree authority and lineage evidence.'
            );
          }
        }
      } catch (cause) {
        throw new Error(
          'Folder Tree capture evidence failed integrity verification before unlock.',
          { cause }
        );
      }
    }
  }
}

async function verifyLocalFolderAuthorityBeforeUnlock(
  run: MigrationRun & { scope: Exclude<MigrationScope, { kind: 'file' }> },
  report: ValidationReport,
  snapshot: NonNullable<ReturnType<MigrationStore['getSourceSnapshot']>>,
  store: MigrationStore
): Promise<void> {
  if (run.externalZipSource) await verifyExternalZipSource(run.externalZipSource);
  const artifact = run.localExportArtifact;
  const source = run.externalZipSource
    ? {
        logicalFilename: run.externalZipSource.displayName,
        sha256: run.externalZipSource.zipSha256,
        sizeBytes: run.externalZipSource.sizeBytes,
      }
    : artifact;
  const localExport = isValidationReportV2(report) ? report.localExport : undefined;
  const scopedBoundary = isValidationReportV2(report) ? report.scopedBoundary : undefined;
  const expectedLocalEvidence = source
    ? {
        schema: 'dnaforge.benchling.local-export-validation.v1' as const,
        format: 'zip' as const,
        logicalFilename: source.logicalFilename,
        sha256: source.sha256,
        sizeBytes: source.sizeBytes,
        resourceCount: 0,
        resourceBytes: 0,
        networkRequests: 0 as const,
        ...(isLocalNativeFolderZipInventory(snapshot.localNativeFolderZipInventory)
          ? { nativeFolderZipInventory: snapshot.localNativeFolderZipInventory }
          : {}),
      }
    : null;
  const providerEvidenceCounts = {
    exportJobs: store.listExportJobs(run.id).length,
    exportCaptures: store.listExportCaptures(run.id).length,
    exportInspections: store.listExportInspections(run.id).length,
    exportJobReplacements: store.listExportJobReplacements(run.id).length,
    gmailReceiptConfirmations: store.listGmailReceiptConfirmations(run.id).length,
    providerTasks: store.listProviderTaskEvidence(run.id).length,
    providerActivity: store.listProviderActivityEvidence(run.id).length,
    providerCommands: store.listProviderCommandJournal(run.id).length,
    requestLedgerEntries: store.listRequestLedgerEntries(run.id).length,
    nativeExportReconciliations: store.listNativeExportReconciliations(run.id).length,
  };

  if (
    run.scope.acquisition !== 'local_bundle' ||
    run.binding !== null ||
    !source ||
    (artifact !== undefined &&
      (artifact.format !== 'zip' ||
        artifact.archive === null ||
        artifact.resources.length !== 0)) ||
    !isLocalNativeFolderZipInventory(snapshot.localNativeFolderZipInventory) ||
    !isValidationReportV2(report) ||
    report.runId !== run.id ||
    !samePersistedValue(report.scope, run.scope) ||
    !localExport?.passed ||
    localExport.expected !== 1 ||
    localExport.actual !== 1 ||
    !expectedLocalEvidence ||
    !samePersistedValue(localExport.evidence, expectedLocalEvidence) ||
    !scopedBoundary?.passed ||
    scopedBoundary.expected !== 1 ||
    scopedBoundary.actual !== 1 ||
    scopedBoundary.evidence !== null ||
    !report.collections.passed ||
    report.directFolderCapture !== undefined ||
    report.folderTreeCapture !== undefined ||
    Object.values(providerEvidenceCounts).some((count) => count !== 0)
  ) {
    throw new Error(
      'The passing report does not contain exact provider-free local Folder authority.'
    );
  }

  const sourceIdentityHash = migrationRunSourceIdentityHash(run);
  if (!sourceIdentityHash || sourceIdentityHash !== snapshot.accountHash) {
    throw new Error('Local Folder authority does not match the immutable ZIP identity.');
  }

  let folders: ScopedFolderMetadata[];
  try {
    folders = await readScopedFolderBoundary({
      workspacePath: run.workspacePath,
      runId: run.id,
      scope: run.scope,
      sourceAccountHash: sourceIdentityHash,
    });
    assertScopedFolderBoundary({
      scope: run.scope,
      sourceAccountHash: sourceIdentityHash,
      capturedAt: snapshot.createdAt,
      folders,
    });
  } catch (cause) {
    throw new Error('Local Folder hierarchy failed integrity verification before unlock.', {
      cause,
    });
  }
}

export async function readCommittedMigrationReport(
  workspacePath: string
): Promise<ValidationReport> {
  return JSON.parse(
    await readFile(join(workspacePath, MACHINE_REPORT_PATH), 'utf8')
  ) as ValidationReport;
}

export async function persistMigrationWorkspaceReport(
  run: MigrationRun,
  report: ValidationReport,
  snapshot?: SourceSnapshot
): Promise<void> {
  if (run.state !== 'ready_to_unlock' && run.state !== 'unlocked') {
    throw new Error(`Migration report cannot be persisted from state ${run.state}.`);
  }
  if (!report.passed || report.runId !== run.id) {
    throw new Error('Only the passing report for this migration run may be persisted.');
  }
  const binding = run.binding;
  const localArtifact = run.localExportArtifact;
  const adoptedSnapshot =
    run.baseline?.kind === 'adopted_workspace' &&
    snapshot?.runId === run.id &&
    snapshot.id === report.snapshotId &&
    snapshot.initialSourceObjectIds.length === 0 &&
    snapshot.parts.length > 0 &&
    snapshot.parts.every((part) => part.kind === 'supplemental_local_export')
      ? snapshot
      : null;
  const sourceIdentityHash = migrationRunSourceIdentityHash(run) ?? adoptedSnapshot?.accountHash;
  if (!sourceIdentityHash) {
    throw new Error('Cannot persist a workspace report without an immutable source identity.');
  }
  if (report.accountHash !== sourceIdentityHash) {
    throw new Error('Migration report does not match the immutable source identity.');
  }
  assertProviderTaskPrivacySafe(report, 'machine validation report');
  await atomicWriteText(
    join(run.workspacePath, MACHINE_REPORT_PATH),
    `${JSON.stringify(report, null, 2)}\n`
  );
  if (binding) {
    await atomicWriteText(
      join(run.workspacePath, SOURCE_BINDING_PATH),
      `${JSON.stringify(
        {
          version: 1,
          benchlingOrigin: binding.benchlingOrigin,
          ...(binding.benchlingOrganizationBaseUrl
            ? { benchlingOrganizationBaseUrl: binding.benchlingOrganizationBaseUrl }
            : {}),
          benchlingAccountId: binding.benchlingAccountId,
          benchlingAccountEmail: binding.benchlingAccountEmail,
          benchlingOrganizationId: binding.benchlingOrganizationId,
          benchlingOrganizationName: binding.benchlingOrganizationName,
          accountHash: binding.accountHash,
          confirmedAt: binding.confirmedAt,
        },
        null,
        2
      )}\n`
    );
  } else if (localArtifact) {
    await atomicWriteText(
      join(run.workspacePath, SOURCE_ARTIFACT_PATH),
      `${JSON.stringify(
        {
          schema: localArtifact.schema,
          format: localArtifact.format,
          logicalFilename: localArtifact.logicalFilename,
          sha256: localArtifact.sha256,
          sizeBytes: localArtifact.sizeBytes,
          capturedAt: localArtifact.capturedAt,
          resources: localArtifact.resources.map((resource) => ({
            sourceRef: resource.sourceRef,
            relativePath: resource.relativePath,
            logicalFilename: resource.logicalFilename,
            sha256: resource.sha256,
            sizeBytes: resource.sizeBytes,
            mediaType: resource.mediaType,
          })),
        },
        null,
        2
      )}\n`
    );
  } else if (!run.externalZipSource && !adoptedSnapshot) {
    throw new Error('Cannot persist a workspace report without source provenance.');
  }
  await atomicWriteText(
    join(run.workspacePath, migrationReportPath(run)),
    renderReportMarkdown(run, report)
  );
}

async function writeStagingMarker(run: MigrationRun, status: 'locked' | 'unlocked'): Promise<void> {
  await atomicWriteText(
    join(run.workspacePath, STAGING_MARKER_PATH),
    `${JSON.stringify(
      {
        schema: 'dnaforge.benchling-migration-workspace.v1',
        workspaceId: run.workspaceId,
        runId: run.id,
        status,
        createdAt: run.createdAt,
      },
      null,
      2
    )}\n`
  );
}

function renderReportMarkdown(run: MigrationRun, report: ValidationReport): string {
  const status = report.passed ? 'Passed' : 'Failed';
  const exceptionLines = report.issues
    .filter((issue) => !issue.blocking)
    .map((issue) => `- ${issue.message}`);
  const blockingLines = report.issues
    .filter((issue) => issue.blocking)
    .map((issue) => `- ${issue.message}`);
  const extendedEvidence = isValidationReportV2(report)
    ? [
        '## Importer versions',
        '',
        `- App: ${report.converterVersions?.app ?? 'unavailable in legacy report'}`,
        `- Migration bundle: ${report.converterVersions?.bundle ?? 'unavailable in legacy report'}`,
        `- Projection converter: ${report.converterVersions?.projection ?? 'unavailable in legacy report'}`,
        `- Validation report schema: ${report.version}`,
        '',
        '## Source acquisition',
        '',
        ...(report.localExport?.evidence
          ? [
              '- Mode: User-selected local export (provider-free)',
              `- File: ${report.localExport.evidence.logicalFilename}`,
              `- Format: ${report.localExport.evidence.format.toUpperCase()}`,
              `- SHA-256: ${report.localExport.evidence.sha256}`,
              `- Size: ${report.localExport.evidence.sizeBytes} bytes`,
              ...(report.localExport.evidence.format === 'html'
                ? [`- Captured sibling resources: ${report.localExport.evidence.resourceCount}`]
                : report.localExport.evidence.nativeFolderZipInventory
                  ? [
                      `- Selected attachments: ${report.localExport.evidence.nativeFolderZipInventory.selectedAttachments.total}`,
                      `- Archive display root: ${report.localExport.evidence.nativeFolderZipInventory.rootBinding.archiveDisplayRoot}`,
                      `- Selected stable folder ID: ${report.localExport.evidence.nativeFolderZipInventory.rootBinding.selectedStableFolderId} (from the pasted Projects route or user selection; not present as archive identity authority)`,
                      `- Canonical entities: ${report.localExport.evidence.nativeFolderZipInventory.canonicalObjects.archiveTotal} in archive; ${report.localExport.evidence.nativeFolderZipInventory.canonicalObjects.importedTotal} imported; ${report.localExport.evidence.nativeFolderZipInventory.canonicalObjects.skipped.length} skipped`,
                      `- Inferred folders: ${report.localExport.evidence.nativeFolderZipInventory.folders.inferredCount}; explicit directory entries: ${report.localExport.evidence.nativeFolderZipInventory.folders.explicitDirectoryEntryCount}`,
                    ]
                  : []),
              `- Provider network requests: ${report.localExport.evidence.networkRequests}`,
            ]
          : ['- Mode: Provider/replay acquisition']),
        '',
        '## Destination integrity',
        '',
        ...(report.destinationIntegrity
          ? [
              `- Projection receipts: ${report.destinationIntegrity.receiptCount}`,
              `- Canonical receipt ledger SHA-256: ${report.destinationIntegrity.receiptLedgerSha256}`,
              `- Hash-anchored destination artifacts: ${report.destinationIntegrity.artifacts.length}`,
            ]
          : [
              '_This v2 report predates destination-integrity evidence; receipt bytes were checked at unlock without a persisted ledger anchor._',
            ]),
        '',
        '## Selected scope boundary',
        '',
        ...(report.scopedBoundary?.evidence
          ? [
              `- Canonical boundary evidence SHA-256: ${report.scopedBoundary.evidence.canonicalSha256}`,
              `- Boundary evidence path: ${report.scopedBoundary.evidence.evidencePath}`,
              `- Enumerated folders: ${report.scopedBoundary.evidence.evidence.enumerations.length}`,
            ]
          : report.scope.kind === 'file'
            ? ['_Not applicable to File migration._']
            : ['_This report predates selected Folder boundary attestation._']),
        '',
        '## Direct Folder capture authority',
        '',
        ...(report.directFolderCapture?.evidence
          ? [
              `- Capture plan digest: ${report.directFolderCapture.evidence.capturePlanDigest}`,
              `- Traversal journal digest: ${report.directFolderCapture.evidence.traversalJournalDigest}`,
              `- Planned items: ${report.directFolderCapture.evidence.plannedItemCount}`,
              `- Successful item lineages: ${report.directFolderCapture.evidence.successfulLeafCount}`,
              `- Authority manifest SHA-256: ${report.directFolderCapture.evidence.authorityManifestSha256}`,
              `- Lineage manifest SHA-256: ${report.directFolderCapture.evidence.lineageManifestSha256}`,
            ]
          : report.scope.kind === 'folder'
            ? ['_This report predates Direct Folder capture-plan attestation._']
            : ['_Not applicable to this migration scope._']),
        '',
        '## Folder Tree capture authority',
        '',
        ...(report.folderTreeCapture?.evidence
          ? [
              `- Capture plan digest: ${report.folderTreeCapture.evidence.capturePlanDigest}`,
              `- Traversal journal digest: ${report.folderTreeCapture.evidence.traversalJournalDigest}`,
              `- Maximum captured folder depth: ${report.folderTreeCapture.evidence.maximumFolderDepth}`,
              `- Included folders: ${report.folderTreeCapture.evidence.includedFolderIds.length}`,
              `- Excluded folders: ${report.folderTreeCapture.evidence.excludedFolderIds.length}`,
              `- Planned items: ${report.folderTreeCapture.evidence.plannedItemCount}`,
              `- Successful item lineages: ${report.folderTreeCapture.evidence.successfulLeafCount}`,
              `- Authority manifest SHA-256: ${report.folderTreeCapture.evidence.authorityManifestSha256}`,
              `- Lineage manifest SHA-256: ${report.folderTreeCapture.evidence.lineageManifestSha256}`,
            ]
          : report.scope.kind === 'folder_tree'
            ? ['_This report predates Folder Tree capture-plan attestation._']
            : ['_Not applicable to this migration scope._']),
        '',
        '## Export acquisition',
        '',
        `- Planned jobs: ${report.exportJobs.planned}`,
        `- Captured jobs: ${report.exportJobs.captured}`,
        `- Failed jobs with successful replacements: ${report.exportJobs.failedWithSuccessfulReplacement}`,
        `- Jobs with complete receipt, inspection, and capture evidence: ${report.exportJobs.actual}/${report.exportJobs.expected}`,
        ...report.exportJobs.jobs.map(
          (job) =>
            `- \`${job.jobId}\`: ${job.outcome}; receipt ${job.receiptId === null ? 'not confirmed' : 'confirmed'} via ${job.receiptSource ?? 'unknown legacy source'}; download URL hash ${job.downloadUrlHash ?? 'none'}; inspection ${job.inspection ? `${job.inspection.entryCount} entries, ${job.inspection.rangeBytesRead} range bytes` : 'missing'}`
        ),
        '',
        '## Provider export tasks',
        '',
        ...(report.providerTasks
          ? [
              `- Observations: ${report.providerTasks.observations}`,
              `- Jobs with task evidence: ${report.providerTasks.jobs}`,
              `- Status observations: ${report.providerTasks.running} running, ${report.providerTasks.succeeded} succeeded, ${report.providerTasks.failed} failed, ${report.providerTasks.actionRequired} action required`,
              ...report.providerTasks.evidence.map(
                (task) =>
                  `- \`${task.jobId}\` provider task: ${task.status} at ${task.observedAt}${task.actionRequired ? `; ${task.actionRequired.code} (${task.actionRequired.providerStatus ?? 'no provider status'})` : ''}`
              ),
            ]
          : [
              '_This v2 report predates durable provider-task provenance; no task ledger was emitted._',
            ]),
        '',
        '## Provider activity',
        '',
        ...(report.providerActivity
          ? [
              `- Logical provider network requests: ${formatBoundedProviderCount(
                report.providerActivity.networkRequests,
                report.providerActivity.networkRequestUpperBound
              )}`,
              `- Explicit application cache hits: ${formatBoundedProviderCount(
                report.providerActivity.cacheHits,
                report.providerActivity.cacheHitUpperBound
              )}`,
              `- Evidence coverage gaps: ${report.providerActivity.coverageGaps}`,
              `- Counts are exact: ${report.providerActivity.countsAreExact ? 'yes' : 'no'}`,
              `- Counts are bounded: ${
                (report.providerActivity.countsAreBounded ?? report.providerActivity.countsAreExact)
                  ? 'yes'
                  : 'no'
              }`,
              ...(report.providerActivity.unboundedCoverageGaps === undefined
                ? []
                : [`- Unbounded coverage gaps: ${report.providerActivity.unboundedCoverageGaps}`]),
              ...(report.providerActivity.reconciliationResolutions?.length
                ? [
                    '- Reconciled ledger links below preserve raw activity while accounting for historical native-export submission truth:',
                    ...report.providerActivity.reconciliationResolutions.map(
                      (resolution) =>
                        `- Export job \`${resolution.exportJobId}\`: original command \`${resolution.originalCommandRequestId}\` resolved by \`${resolution.reconciliationCommandRequestId}\` through settlement \`${resolution.settlementId}\` (${resolution.basis}); historical submit requests added to aggregate: ${resolution.accountedHistoricalExportSubmitRequests}`
                    ),
                  ]
                : []),
              ...(report.providerActivity.opaqueRedirectResolutions?.length
                ? [
                    '- Resolved historical metadata reads below preserve the raw incomplete activity while proving its exact request count through a later bounded inspection:',
                    ...report.providerActivity.opaqueRedirectResolutions.map(
                      (resolution) =>
                        `- Export job \`${resolution.exportJobId}\`: original metadata command \`${resolution.originalCommandRequestId}\` resolved by bounded successor \`${resolution.successorCommandRequestId}\` with explicit confirmation \`${resolution.receiptConfirmationId}\` (${resolution.basis}); historical network requests added to aggregate: ${resolution.accountedHistoricalNetworkRequests}`
                    ),
                  ]
                : []),
              ...(report.providerActivity.readOnlyCountUncertainties?.length
                ? [
                    '- Bounded read-only uncertainties below preserve raw incomplete activity while constraining the missing count to a finite range:',
                    ...report.providerActivity.readOnlyCountUncertainties.map(
                      (uncertainty) =>
                        `- Export job \`${uncertainty.exportJobId}\`: read-only receipt-poll command \`${uncertainty.commandRequestId}\` is bounded by successor \`${uncertainty.successorCommandRequestId}\` with explicit confirmation \`${uncertainty.receiptConfirmationId}\`; ${formatBoundedProviderCount(
                          uncertainty.minimumNetworkRequests,
                          uncertainty.maximumNetworkRequests
                        )} network requests and ${formatBoundedProviderCount(
                          uncertainty.minimumCacheHits,
                          uncertainty.maximumCacheHits
                        )} cache hits (one bounded File task-status read)`
                    ),
                  ]
                : []),
              ...report.providerActivity.evidence.map((bundle) => {
                const networkRequests = bundle.observations.filter(
                  (observation) => observation.kind === 'network_request'
                ).length;
                const cacheHits = bundle.observations.filter(
                  (observation) => observation.kind === 'cache_hit'
                ).length;
                const opaqueResolution =
                  report.providerActivity?.opaqueRedirectResolutions?.find(
                    (resolution) => resolution.originalCommandRequestId === bundle.commandRequestId
                  ) ?? null;
                const boundedUncertainty =
                  report.providerActivity?.readOnlyCountUncertainties?.find(
                    (uncertainty) => uncertainty.commandRequestId === bundle.commandRequestId
                  ) ?? null;
                const coverageStatus = bundle.complete
                  ? 'complete'
                  : opaqueResolution
                    ? `raw incomplete record preserved; exact count resolved by \`${opaqueResolution.successorCommandRequestId}\``
                    : boundedUncertainty
                      ? `raw incomplete record preserved; bounded count uncertainty ${formatBoundedProviderCount(
                          boundedUncertainty.minimumNetworkRequests,
                          boundedUncertainty.maximumNetworkRequests
                        )} network requests and ${formatBoundedProviderCount(
                          boundedUncertainty.minimumCacheHits,
                          boundedUncertainty.maximumCacheHits
                        )} cache hits; bounded by \`${boundedUncertainty.successorCommandRequestId}\``
                      : 'incomplete lower bound';
                return `- \`${bundle.commandRequestId}\` ${bundle.operationKind}: ${networkRequests} network request${networkRequests === 1 ? '' : 's'}, ${cacheHits} cache hit${cacheHits === 1 ? '' : 's'}; ${coverageStatus}`;
              }),
            ]
          : [
              '_This v2 report predates durable provider-activity evidence; exact network and cache totals are unavailable._',
            ]),
        '',
        '## Snapshot parts and supersession',
        '',
        `- Valid parts: ${report.snapshotParts.actual}/${report.snapshotParts.expected}`,
        `- Export archives: ${report.snapshotParts.exportArchives}`,
        `- Targeted reads: ${report.snapshotParts.targetedReads}`,
        `- Superseding parts: ${report.snapshotParts.superseded}`,
        ...report.snapshotParts.parts.map(
          (part) =>
            `- \`${part.partId}\`: ${part.kind}; SHA-256 ${part.sha256}; supersedes ${part.supersedesPartId ?? 'nothing'}`
        ),
        '',
        '## Source folder adapter evidence',
        '',
        `- Locked-staging folder adapters: ${report.collections.actual}/${report.collections.expected}`,
        `- Native folder memberships: ${report.collections.actualMemberships}/${report.collections.expectedMemberships}`,
        `- Selected roots: ${report.collections.selectedRootSourceIds.join(', ') || 'none'}`,
        ...report.collections.evidence.map(
          (collection) =>
            `- ${collection.sourceFolderId} -> \`${collection.destinationCollectionId}\`; ${collection.memberObjectIds.length} members; ${collection.excludedChildFolderIds.length} excluded direct children`
        ),
        '',
        '## Formulas',
        '',
        `- Classified formulas: ${report.formulas.actual}/${report.formulas.expected}`,
        `- Supported: ${report.formulas.supported}`,
        `- Unsupported, preserved: ${report.formulas.unsupported}`,
        `- Visibly stale: ${report.formulas.stale}`,
        ...report.formulas.evidence.map(
          (formula) =>
            `- ${formula.sourceObjectId} ${formula.locator}: ${formula.compatibility}${formula.stale ? ', stale' : ''}`
        ),
        '',
        '## Native conversion exceptions',
        '',
        `- Prominently labeled artifact exceptions: ${report.nativeConversionExceptions.actual}/${report.nativeConversionExceptions.expected}`,
        ...report.nativeConversionExceptions.evidence.map(
          (exception) =>
            `- ${exception.sourceObjectId}: ${exception.message} (${exception.preservedAs}; ${exception.prominentlyLabeled ? 'prominent label present' : 'prominent label missing'})`
        ),
        '',
      ]
    : [
        '## Extended evidence',
        '',
        '_This workspace contains a legacy v1 report. Export-job, snapshot-supersession, formula, exception, and collection sections were not emitted by that importer version._',
        '',
      ];
  return [
    '# Benchling Migration Validation Report',
    '',
    `**Status:** ${status}`,
    `**Source organization:** ${run.binding?.benchlingOrganizationName ?? 'Unconfirmed'}`,
    `**Source account:** ${run.binding?.benchlingAccountEmail ?? 'Unconfirmed'}`,
    `**Captured scope:** ${run.scope.kind}`,
    `**Snapshot:** ${report.snapshotId}`,
    `**Generated:** ${report.generatedAt}`,
    '',
    '## Reconciliation',
    '',
    `- Source entities: ${report.sourceObjects.actual}/${report.sourceObjects.expected}`,
    `- Attachments: ${report.attachments.actual}/${report.attachments.expected}`,
    `- Memberships: ${report.memberships.actual}/${report.memberships.expected}`,
    `- Relationships: ${report.relationships.actual}/${report.relationships.expected}`,
    `- Projections: ${report.projections.actual}/${report.projections.expected}`,
    `- Native projections: ${report.projections.native}`,
    `- Portable file projections: ${report.projections.portableFile ?? 0}`,
    `- Locked-staging adapter projections: ${report.projections.adapterStaging ?? 0}`,
    `- Fallback projections: ${report.projections.fallback ?? report.projections.artifact}`,
    `- Native conversion exceptions: ${report.projections.exceptions}`,
    '',
    ...extendedEvidence,
    '## Blocking issues',
    '',
    ...(blockingLines.length > 0 ? blockingLines : ['_None._']),
    '',
    '## Preserved exceptions and warnings',
    '',
    ...(exceptionLines.length > 0 ? exceptionLines : ['_None._']),
    '',
    'Machine-readable evidence is stored at `.dnaforge/migration/validation-report.json`.',
    '',
  ].join('\n');
}

function formatBoundedProviderCount(lowerBound: number, upperBound?: number): string {
  const inclusiveUpperBound = upperBound ?? lowerBound;
  return inclusiveUpperBound === lowerBound
    ? String(lowerBound)
    : `${lowerBound}\u2013${inclusiveUpperBound}`;
}

const MANAGED_CONTAINER_DIRECTORY_NAME = 'repo';

export function benchlingWorkspaceName(run: {
  displayName?: string;
  localExportArtifact?: { logicalFilename?: string };
  externalZipSource?: { displayName?: string };
}): string {
  const fromExport = (
    run.externalZipSource?.displayName ??
    run.localExportArtifact?.logicalFilename ??
    ''
  ).replace(/\.[^.]+$/u, '');
  for (const candidate of [run.displayName ?? '', fromExport]) {
    const sanitized = sanitizeDisplayName(candidate);
    if (!sanitized) continue;
    if (sanitized === MANAGED_CONTAINER_DIRECTORY_NAME) continue;
    if (sanitized === 'Benchling migration') continue;
    return sanitized;
  }
  return 'Benchling import';
}

function sanitizeDisplayName(value: string): string {
  const sanitized = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || character === '/' || character === '\\' ? ' ' : character;
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return sanitized.slice(0, 120) || 'Benchling migration';
}

function safeVersionLabel(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(normalized)) {
    throw new Error('Migration app version contains unsupported characters.');
  }
  return normalized;
}

async function atomicWriteText(path: string, content: string): Promise<void> {
  await mkdir(resolve(path, '..'), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(temporaryPath, path);
}

type LimsWorkspaceSnapshot = {
  limsPath: string;
  backupRoot: string;
  backupPath: string;
  existed: boolean;
};

function openIsolatedUnlockTransactionDb(globalDb: Database.Database): {
  db: Database.Database;
  close: () => void;
} {
  if (!globalDb.name || globalDb.name === ':memory:') {
    if (globalDb.inTransaction) {
      throw new Error('Migration unlock cannot start inside another database transaction.');
    }
    return { db: globalDb, close: () => undefined };
  }
  const transactionDb = new Database(globalDb.name);
  transactionDb.pragma('foreign_keys = ON');
  transactionDb.pragma('busy_timeout = 5000');
  return {
    db: transactionDb,
    close: () => transactionDb.close(),
  };
}

async function snapshotLimsWorkspace(workspacePath: string): Promise<LimsWorkspaceSnapshot> {
  const backupRoot = join(
    workspacePath,
    '.dnaforge',
    'migration',
    'projection-staging',
    `unlock-${randomUUID()}`
  );
  const backupPath = join(backupRoot, 'lims');
  const limsPath = join(workspacePath, '.waypoint', 'lims');
  const existed = existsSync(limsPath);
  await mkdir(backupRoot, { recursive: true });
  if (existed) await cp(limsPath, backupPath, { recursive: true, force: false });
  return { limsPath, backupRoot, backupPath, existed };
}

async function restoreLockedWorkspaceAfterFailedUnlock(
  run: MigrationRun,
  limsSnapshot: LimsWorkspaceSnapshot | null
): Promise<void> {
  await writeStagingMarker(run, 'locked');
  await restoreLimsSnapshot(limsSnapshot);
}

async function restoreLimsSnapshot(snapshot: LimsWorkspaceSnapshot | null): Promise<void> {
  if (!snapshot) return;
  await rm(snapshot.limsPath, { recursive: true, force: true });
  if (snapshot.existed) {
    await mkdir(resolve(snapshot.limsPath, '..'), { recursive: true });
    await rename(snapshot.backupPath, snapshot.limsPath);
  }
  await rm(snapshot.backupRoot, { recursive: true, force: true });
}

async function discardLimsSnapshot(snapshot: LimsWorkspaceSnapshot | null): Promise<void> {
  if (!snapshot) return;
  await rm(snapshot.backupRoot, { recursive: true, force: true });
}
