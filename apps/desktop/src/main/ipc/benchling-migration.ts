import { handleGroup, mainIpc, sendRendererIpc } from '../../shared/ipc-contract';
import type { RegistryTableMappingDecision } from '../../shared/benchling-registry-table-review';
import {
  BrowserWindow,
  dialog,
  Notification,
  shell,
  type OpenDialogOptions,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';
import { RendererOwnerLifecycle } from '../renderer-owner-lifecycle';
import { getCurrentRendererLoad } from './shell-readiness';
import { workspaceMutationCapabilities } from './workspace-mutation-capability';
import { readFile, stat, unlink } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { assertSafePath } from './path-allowlist';
import { getDb } from './database';
import {
  isValidationReportV2,
  type MigrationIssue,
  type MigrationRun,
  type MigrationState,
  type SourceBinding,
  type ValidationReport,
} from '../../shared/benchling-migration';
import { isVisibleMigrationHistoryRun } from '../benchling-migration/adopt-workspace-history';
import { nativeWorkspaceEntityDisplayPath } from '../../shared/native-workspace-manifest';
import {
  parseBenchlingMigrationResolveProviderReferenceRequest,
  parseBenchlingMigrationSurveyImportDestinationsRequest,
  type BenchlingMigrationSurveyImportDestinationsRequest,
  type BenchlingMigrationImportDestinationSurveyView,
  type BenchlingMigrationResolveProviderReferenceRequest,
  type BenchlingMigrationResolveProviderReferenceResult,
  BENCHLING_MIGRATION_MAX_LINKED_ITEM_EXPORT_FILES,
  BENCHLING_MIGRATION_SUBSCRIBE_PROGRESS_CHANNEL,
  BENCHLING_MIGRATION_UNSUBSCRIBE_PROGRESS_CHANNEL,
  BENCHLING_MIGRATION_PROGRESS_CHANGED_CHANNEL,
  parseBenchlingMigrationImportLocalBundleRequest,
  parseBenchlingMigrationAddLinkedItemExportsRequest,
  parseBenchlingMigrationAppendWorkspaceExportsRequest,
  parseBenchlingMigrationResolveImportDecisionRequest,
  parseBenchlingMigrationOpenLinkedItemRecoveryLocationRequest,
  parseBenchlingMigrationOpaqueId,
  parseBenchlingMigrationRunId,
  parseBenchlingMigrationSubscribeProgressRequest,
  parseBenchlingMigrationSubscriptionId,
  type BenchlingMigrationBindingView,
  type BenchlingMigrationCreatedObjectView,
  type BenchlingMigrationImportLocalBundleResult,
  type BenchlingMigrationHistoryDetailView,
  type BenchlingMigrationHistorySummaryView,
  type BenchlingMigrationAddLinkedItemExportsResult,
  type BenchlingMigrationAppendWorkspaceExportsResult,
  type BenchlingMigrationResolveImportDecisionResult,
  type BenchlingMigrationLinkedItemRecoveryLocationKind,
  type BenchlingMigrationOpenLinkedItemRecoveryLocationResult,
  type BenchlingMigrationProgressEvent,
  type BenchlingMigrationRecoveryAction,
  type BenchlingMigrationReportView,
  type BenchlingMigrationRunIssueView,
  type BenchlingMigrationRunView,
  type BenchlingMigrationSourceArtifactView,
} from '../../shared/benchling-migration-ipc';
import {
  parseExternalProviderSourceRequest,
  type ExternalProviderSourceRequest,
  type ExternalProviderSourceResult,
} from '../../shared/benchling-migration-raw-source';
import {
  NATIVE_WORKSPACE_MANIFEST_PATH,
  parseNativeWorkspaceManifest,
} from '../../shared/native-workspace-manifest';
import {
  assertValidationReportIssueDetailsRedacted,
  assertValidationReportRendererPrivacySafe,
} from '../benchling-migration/validation-report-privacy';
import type { PreparedLocalBenchlingExportSource } from '../benchling-migration/local-export-source-preparation';
import { viewExternalProviderSource } from '../benchling-migration/external-source-viewer';
import { benchlingMigrationContract } from '../../shared/ipc/benchling-migration.contract';

export type BenchlingMigrationCoordinatorProgress = {
  run: MigrationRun;
  message?: string;
  completedItems?: number | null;
  totalItems?: number | null;
  warnings?: readonly string[];
};

export interface BenchlingMigrationCoordinator {
  getActiveRun(): Promise<MigrationRun | null>;
  listRuns(): Promise<MigrationRun[]>;
  getRun(runId: string): Promise<MigrationRun>;
  importLocalBundle(
    sourcePath: string,
    runId?: string,
    workspaceName?: string,
    reviewedTables?: readonly RegistryTableMappingDecision[]
  ): Promise<MigrationRun>;
  retryLocalBundleWithoutFailedFile(failedRunId: string): Promise<MigrationRun>;
  importLocalBundleToWorkspace(
    sourcePath: string,
    workspaceDbId: number,
    reviewedTables?: readonly RegistryTableMappingDecision[],
    options?: {
      signal?: AbortSignal;
      assertCurrent?: () => void;
      assertCanWait?: (rootIdentity: string) => void;
    }
  ): Promise<MigrationRun>;
  addLinkedItemExports(
    runId: string,
    sourcePaths: readonly string[],
    reviewedTables?: readonly RegistryTableMappingDecision[]
  ): Promise<MigrationRun>;
  appendWorkspaceExports(
    runId: string,
    sourcePaths: readonly string[],
    reviewedTables?: readonly RegistryTableMappingDecision[]
  ): Promise<MigrationRun>;
  resolveImportDecision(
    runId: string,
    attemptId: string,
    decision: import('../../shared/benchling-import-decision').ImportDecision
  ): Promise<MigrationRun>;
  resolveLinkedItemRecoveryLocation(
    runId: string,
    kind: BenchlingMigrationLinkedItemRecoveryLocationKind,
    sourceId: string
  ): Promise<string>;
  start(runId: string): Promise<MigrationRun>;
  pause(runId: string): Promise<MigrationRun>;
  resume(runId: string): Promise<MigrationRun>;
  cancelPreserved(runId: string): Promise<MigrationRun>;
  startOverPreserved(runId: string): Promise<MigrationRun>;
  getReport(
    runId: string,
    options?: { preserveRunState?: boolean }
  ): Promise<ValidationReport | null>;
  unlock(runId: string): Promise<MigrationRun>;
  discard(runId: string): Promise<void>;
  subscribeProgress(
    runId: string,
    listener: (progress: BenchlingMigrationCoordinatorProgress) => void
  ): () => void;
}

export interface RegisterBenchlingMigrationHandlersDeps {
  coordinator: BenchlingMigrationCoordinator;
  getMainWindow?: () => BrowserWindow | null;

  resolveProviderReference?: (
    request: BenchlingMigrationResolveProviderReferenceRequest
  ) => BenchlingMigrationResolveProviderReferenceResult;

  surveyImportDestinations?: (
    request: BenchlingMigrationSurveyImportDestinationsRequest
  ) => Promise<
    Pick<
      BenchlingMigrationImportDestinationSurveyView,
      'archiveObjectCount' | 'candidates' | 'registryTables'
    >
  >;
  prepareLocalExportSource?: (sourcePath: string) => Promise<PreparedLocalBenchlingExportSource>;
  openExternal?: (url: string) => Promise<void>;
  showSystemNotification?: (notification: { title: string; body: string }) => void;
  viewExternalSource?: (
    request: ExternalProviderSourceRequest
  ) => Promise<ExternalProviderSourceResult>;
}

type Subscription = {
  unsubscribe: () => void;
};

const LOCAL_BENCHLING_EXPORT_DIALOG_OPTIONS: OpenDialogOptions = {
  title: 'Choose a Benchling export',
  properties: ['openFile', 'openDirectory'],
  filters: [{ name: 'Benchling ZIP exports', extensions: ['zip'] }],
};

const LOCAL_BENCHLING_FOLDER_ZIP_DIALOG_OPTIONS: OpenDialogOptions = {
  title: 'Choose the downloaded Benchling export',
  properties: ['openFile', 'openDirectory'],
  filters: [{ name: 'Benchling folder ZIP exports', extensions: ['zip'] }],
};

const LINKED_ITEM_EXPORTS_DIALOG_OPTIONS: OpenDialogOptions = {
  title: 'Add linked-item exports',
  properties: ['openFile', 'openDirectory', 'multiSelections'],
  filters: [{ name: 'Benchling folder ZIP exports', extensions: ['zip'] }],
};

const APPEND_WORKSPACE_EXPORTS_DIALOG_OPTIONS: OpenDialogOptions = {
  title: 'Add another Benchling export to this project',
  properties: ['openFile', 'openDirectory', 'multiSelections'],
  filters: [{ name: 'Benchling folder ZIP exports', extensions: ['zip'] }],
};
const MAX_SYSTEM_NOTIFICATION_RUNS = 128;
export const MAX_BENCHLING_PROGRESS_SUBSCRIPTIONS_PER_RENDERER = 8;
export const MAX_BENCHLING_PROGRESS_SUBSCRIPTIONS = 64;

export function registerBenchlingMigrationHandlers({
  coordinator,
  getMainWindow,
  resolveProviderReference,
  surveyImportDestinations,
  prepareLocalExportSource,
  openExternal = (url) => shell.openExternal(url),
  showSystemNotification = showBenchlingMigrationSystemNotification,
  viewExternalSource = (request) => viewExternalProviderSource(getDb(), request),
}: RegisterBenchlingMigrationHandlersDeps): void {
  const subscriptions = new Map<string, Subscription>();
  const subscriptionCountsBySender = new Map<number, number>();
  const managedPreparedArchives = new Set<string>();
  const unclaimedPreparedArchives = new Set<string>();
  const lastSystemNotificationByRun = new Map<string, string>();
  let progressSequence = 0;
  const pendingAdmissions = new WeakMap<WebContents, Set<AbortController>>();
  const admissionLifecycle = new RendererOwnerLifecycle((sender) => {
    for (const controller of pendingAdmissions.get(sender) ?? []) controller.abort();
    pendingAdmissions.delete(sender);
  });
  function captureAppendAdmission(event: IpcMainInvokeEvent) {
    const sender = event.sender;
    const owner = getMainWindow?.();
    const load = getCurrentRendererLoad(event);
    if (
      !owner ||
      owner.isDestroyed() ||
      owner.webContents !== sender ||
      BrowserWindow.fromWebContents(sender) !== owner ||
      !load
    ) {
      throw new Error('Benchling import requires the current app document.');
    }
    const frame = event.senderFrame;
    const generation = admissionLifecycle.register(sender);
    const controller = new AbortController();
    const pending = pendingAdmissions.get(sender) ?? new Set<AbortController>();
    pending.add(controller);
    pendingAdmissions.set(sender, pending);
    const assertCurrent = () => {
      controller.signal.throwIfAborted();
      admissionLifecycle.assertCurrent(sender, generation);
      if (
        getMainWindow?.() !== owner ||
        owner.isDestroyed() ||
        owner.webContents !== sender ||
        BrowserWindow.fromWebContents(sender) !== owner ||
        sender.mainFrame !== frame ||
        getCurrentRendererLoad(event)?.loadId !== load.loadId
      ) {
        throw new Error('Benchling import requires the current app document.');
      }
    };
    return {
      signal: controller.signal,
      assertCurrent,
      assertCanWait(rootIdentity: string) {
        assertCurrent();
        if (workspaceMutationCapabilities.hasActiveOwnerSession(sender.id, rootIdentity)) {
          throw new Error('workspace_busy');
        }
      },
      dispose() {
        pending.delete(controller);
        if (pending.size === 0 && pendingAdmissions.get(sender) === pending)
          pendingAdmissions.delete(sender);
      },
    };
  }
  handleGroup(benchlingMigrationContract, {
    getActiveRun: async () => {
      const run = await coordinator.getActiveRun();
      if (!run) return null;
      const runView = toBenchlingMigrationRunView(run);
      maybeShowSystemNotification(runView);
      return runView;
    },
    getHistory: async (): Promise<BenchlingMigrationHistorySummaryView[]> => {
      const runs = (await coordinator.listRuns()).filter(
        (run) => run.state !== 'discarded' && isVisibleMigrationHistoryRun(run)
      );
      const history = await Promise.all(
        runs.map(async (run) => {
          const [report, createdObjects] = await Promise.all([
            coordinator.getReport(run.id, { preserveRunState: true }).catch(() => null),
            readCreatedObjects(run),
          ]);
          return {
            run: toBenchlingMigrationRunView(run),
            createdObjectCount: historyEntityCount(report, createdObjects),
            missingDependencyCount: missingDependencyCount(report),
          };
        })
      );
      return history.sort((left, right) => {
        const leftTime = Date.parse(left.run.unlockedAt ?? left.run.updatedAt);
        const rightTime = Date.parse(right.run.unlockedAt ?? right.run.updatedAt);
        const safeLeftTime = Number.isFinite(leftTime) ? leftTime : Number.NEGATIVE_INFINITY;
        const safeRightTime = Number.isFinite(rightTime) ? rightTime : Number.NEGATIVE_INFINITY;
        return safeRightTime - safeLeftTime || left.run.id.localeCompare(right.run.id);
      });
    },
    getHistoryDetail: async (
      _event,
      runId: unknown
    ): Promise<BenchlingMigrationHistoryDetailView> => {
      const parsedRunId = parseBenchlingMigrationRunId(runId);
      const runs = await coordinator.listRuns();

      const run =
        runs.find(
          (candidate) =>
            candidate.localBestEffortFallback?.priorRunId === parsedRunId ||
            candidate.localBestEffortFallback?.rootRunId === parsedRunId
        ) ?? runs.find((candidate) => candidate.id === parsedRunId);
      if (!run) throw new Error(`Benchling migration ${parsedRunId} does not exist.`);

      const [report, createdObjects] = await Promise.all([
        coordinator.getReport(run.id, { preserveRunState: true }),
        run.localExportArtifact ? Promise.resolve([]) : readCreatedObjects(run),
      ]);
      return {
        run: toBenchlingMigrationRunView(run),
        report: report ? toBenchlingMigrationReportView(report) : null,
        createdObjects,
      };
    },
    viewExternalSource: async (_event, request: unknown): Promise<ExternalProviderSourceResult> =>
      viewExternalSource(parseExternalProviderSourceRequest(request)),
    importLocalBundle: async (
      event,
      request: unknown
    ): Promise<BenchlingMigrationImportLocalBundleResult> => {
      const parsed = parseBenchlingMigrationImportLocalBundleRequest(request);
      const admission =
        parsed.workspaceDbId !== undefined ? captureAppendAdmission(event) : undefined;
      try {
        if (parsed.retryFailedRunId) {
          return {
            run: toBenchlingMigrationRunView(
              await coordinator.retryLocalBundleWithoutFailedFile(parsed.retryFailedRunId)
            ),
          };
        }
        if (parsed.sourcePath !== undefined) {
          const droppedPath = await canonicalizeRendererExportPath(
            parsed.sourcePath,
            'benchling-migration'
          );
          admission?.assertCurrent();
          const prepared = await prepareSource(droppedPath);
          admission?.assertCurrent();
          return await importPreparedSource(
            prepared.archivePath,
            parsed.runId,
            parsed.workspaceName,
            parsed.workspaceDbId,
            parsed.reviewedTables,
            admission
          );
        }
        const owner = BrowserWindow.fromWebContents(event.sender);
        if (!owner) throw new Error('The Benchling export picker requires an owning app window.');
        const selection = await dialog.showOpenDialog(
          owner,
          parsed.runId
            ? LOCAL_BENCHLING_FOLDER_ZIP_DIALOG_OPTIONS
            : LOCAL_BENCHLING_EXPORT_DIALOG_OPTIONS
        );
        admission?.assertCurrent();
        if (selection.canceled) return { run: null };
        if (selection.filePaths.length !== 1) {
          throw new Error('Choose one Benchling ZIP export or unzipped export folder.');
        }
        const [sourcePath] = selection.filePaths;
        if (
          !isAbsolute(sourcePath) ||
          sourcePath.length > 4096 ||
          hasControlCharacters(sourcePath)
        ) {
          throw new Error('The native picker returned an unsupported Benchling export path.');
        }
        const prepared = await prepareSource(sourcePath);
        admission?.assertCurrent();
        return await importPreparedSource(
          prepared.archivePath,
          parsed.runId,
          parsed.workspaceName,
          parsed.workspaceDbId,
          parsed.reviewedTables,
          admission
        );
      } finally {
        admission?.dispose();
      }
    },
    resolveProviderReference: async (
      _event,
      request: unknown
    ): Promise<BenchlingMigrationResolveProviderReferenceResult> => {
      const parsed = parseBenchlingMigrationResolveProviderReferenceRequest(request);
      if (!resolveProviderReference) {
        throw new Error('Provider reference resolution is unavailable in this build.');
      }
      return resolveProviderReference(parsed);
    },
    surveyImportDestinations: async (
      _event,
      request: unknown
    ): Promise<BenchlingMigrationImportDestinationSurveyView> => {
      const parsed = parseBenchlingMigrationSurveyImportDestinationsRequest(request);
      if (!surveyImportDestinations) {
        throw new Error('Import destination survey is unavailable in this build.');
      }

      const archivePath = await assertSafePath(parsed.archivePath, {
        requireAbsolute: true,
        errorPrefix: 'benchling-migration import destination survey',
      });
      await cleanupUnclaimedPreparedArchives();

      const prepared = await prepareSource(archivePath);
      const survey = await surveyImportDestinations({ archivePath: prepared.archivePath });
      return {
        ...survey,
        preparedArchivePath: prepared.archivePath,
        sourceDisplayName: prepared.sourceDisplayName,
      };
    },
    addLinkedItemExports: async (
      event,
      request: unknown
    ): Promise<BenchlingMigrationAddLinkedItemExportsResult> => {
      const parsed = parseBenchlingMigrationAddLinkedItemExportsRequest(request);
      let sourcePaths: string[];
      if (parsed.sourcePaths) {
        const canonicalPaths = await Promise.all(
          parsed.sourcePaths.map((sourcePath) =>
            canonicalizeRendererExportPath(sourcePath, 'benchling-migration linked-item export')
          )
        );
        sourcePaths = await prepareSources([...new Set(canonicalPaths)]);
      } else {
        const owner = BrowserWindow.fromWebContents(event.sender);
        if (!owner) {
          throw new Error('The linked-item export picker requires an owning app window.');
        }
        const selection = await dialog.showOpenDialog(owner, LINKED_ITEM_EXPORTS_DIALOG_OPTIONS);
        if (selection.canceled) return { run: null };
        await cleanupUnclaimedPreparedArchives();
        sourcePaths = await prepareSources([...new Set(selection.filePaths)]);
      }
      await assertLinkedItemExportFiles(sourcePaths);
      const run = await coordinator.addLinkedItemExports(
        parsed.runId,
        sourcePaths,
        ...(parsed.reviewedTables ? [parsed.reviewedTables] : [])
      );
      watchPreparedArchivesUntilAttemptFinishes(sourcePaths, run);
      return {
        run: toBenchlingMigrationRunView(run),
      };
    },
    appendWorkspaceExports: async (
      event,
      request: unknown
    ): Promise<BenchlingMigrationAppendWorkspaceExportsResult> => {
      const parsed = parseBenchlingMigrationAppendWorkspaceExportsRequest(request);
      let sourcePaths: string[];
      if (parsed.sourcePaths) {
        const canonicalPaths = await Promise.all(
          parsed.sourcePaths.map((sourcePath) =>
            canonicalizeRendererExportPath(sourcePath, 'benchling-migration appended export')
          )
        );
        sourcePaths = await prepareSources([...new Set(canonicalPaths)]);
      } else {
        const owner = BrowserWindow.fromWebContents(event.sender);
        if (!owner) {
          throw new Error('The Benchling export picker requires an owning app window.');
        }
        const selection = await dialog.showOpenDialog(
          owner,
          APPEND_WORKSPACE_EXPORTS_DIALOG_OPTIONS
        );
        if (selection.canceled) return { run: null };
        await cleanupUnclaimedPreparedArchives();
        sourcePaths = await prepareSources([...new Set(selection.filePaths)]);
      }
      await assertLinkedItemExportFiles(sourcePaths);
      const run = await coordinator.appendWorkspaceExports(
        parsed.runId,
        sourcePaths,
        ...(parsed.reviewedTables ? [parsed.reviewedTables] : [])
      );
      watchPreparedArchivesUntilAttemptFinishes(sourcePaths, run);
      return {
        run: toBenchlingMigrationRunView(run),
      };
    },
    resolveImportDecision: async (
      _event,
      request: unknown
    ): Promise<BenchlingMigrationResolveImportDecisionResult> => {
      const parsed = parseBenchlingMigrationResolveImportDecisionRequest(request);
      return {
        run: toBenchlingMigrationRunView(
          await coordinator.resolveImportDecision(parsed.runId, parsed.attemptId, parsed.decision)
        ),
      };
    },
    openLinkedItemRecoveryLocation: async (
      _event,
      request: unknown
    ): Promise<BenchlingMigrationOpenLinkedItemRecoveryLocationResult> => {
      const parsed = parseBenchlingMigrationOpenLinkedItemRecoveryLocationRequest(request);
      const url = assertSafeLinkedItemRecoveryUrl(
        await coordinator.resolveLinkedItemRecoveryLocation(
          parsed.runId,
          parsed.kind,
          parsed.sourceId
        )
      );
      await openExternal(url);
      return { opened: true };
    },
    start: runAction(coordinator.start.bind(coordinator)),
    pause: runAction(coordinator.pause.bind(coordinator)),
    resume: runAction(coordinator.resume.bind(coordinator)),
    cancelPreserved: runAction(coordinator.cancelPreserved.bind(coordinator)),
    startOverPreserved: runAction(coordinator.startOverPreserved.bind(coordinator)),
    getReport: async (_event, runId: unknown) => {
      const report = await coordinator.getReport(parseBenchlingMigrationRunId(runId));
      return report ? toBenchlingMigrationReportView(report) : null;
    },
    unlock: async (_event, runId: unknown) => {
      const run = await coordinator.unlock(parseBenchlingMigrationRunId(runId));
      const runView = toBenchlingMigrationRunView(run);
      return { run: runView, workspaceId: runView.workspaceId };
    },
    discard: async (_event, runId: unknown) => {
      const parsedRunId = parseBenchlingMigrationRunId(runId);
      await coordinator.discard(parsedRunId);
      return { runId: parsedRunId, discarded: true as const };
    },
  });

  mainIpc.handle(
    BENCHLING_MIGRATION_SUBSCRIBE_PROGRESS_CHANNEL,
    async (event, request: unknown) => {
      const parsed = parseBenchlingMigrationSubscribeProgressRequest(request);
      const senderId = event.sender.id;
      const subscriptionKey = `${senderId}:${parsed.subscriptionId}`;
      subscriptions.get(subscriptionKey)?.unsubscribe();
      const senderSubscriptionCount = subscriptionCountsBySender.get(senderId) ?? 0;
      if (senderSubscriptionCount >= MAX_BENCHLING_PROGRESS_SUBSCRIPTIONS_PER_RENDERER) {
        throw new Error('Benchling progress subscription capacity is full for this renderer.');
      }
      if (subscriptions.size >= MAX_BENCHLING_PROGRESS_SUBSCRIPTIONS) {
        throw new Error('Benchling progress subscription capacity is full.');
      }

      const unsubscribeFromCoordinator = coordinator.subscribeProgress(parsed.runId, (progress) => {
        if (event.sender.isDestroyed() || progress.run.id !== parsed.runId) return;
        const run = toBenchlingMigrationRunView(progress.run);
        const payload: BenchlingMigrationProgressEvent = {
          runId: parsed.runId,
          run,
          message: normalizeProgressMessage(progress.message, run.state),
          completedItems: normalizeProgressCount(progress.completedItems),
          totalItems: normalizeProgressCount(progress.totalItems),
          warnings: normalizeProgressWarnings(progress.warnings, run),
          sequence: ++progressSequence,
          emittedAt: Date.now(),
        };
        maybeShowSystemNotification(run);
        sendRendererIpc(event.sender, BENCHLING_MIGRATION_PROGRESS_CHANGED_CHANNEL, payload);
      });
      const owner = event.sender;
      const release = () => {
        if (subscriptions.get(subscriptionKey) !== subscription) return;
        subscriptions.delete(subscriptionKey);
        const currentCount = subscriptionCountsBySender.get(senderId) ?? 0;
        if (currentCount <= 1) subscriptionCountsBySender.delete(senderId);
        else subscriptionCountsBySender.set(senderId, currentCount - 1);
        owner.removeListener('destroyed', releaseOnOwnerDestroyed);
        unsubscribeFromCoordinator();
      };
      const releaseOnOwnerDestroyed = () => {
        release();
      };
      const subscription: Subscription = { unsubscribe: release };
      owner.once('destroyed', releaseOnOwnerDestroyed);
      subscriptions.set(subscriptionKey, subscription);
      subscriptionCountsBySender.set(senderId, senderSubscriptionCount + 1);
      return { ok: true as const, subscriptionId: parsed.subscriptionId };
    }
  );

  mainIpc.handle(
    BENCHLING_MIGRATION_UNSUBSCRIBE_PROGRESS_CHANNEL,
    async (event, subscriptionId: unknown) => {
      const parsedSubscriptionId = parseBenchlingMigrationSubscriptionId(subscriptionId);
      const subscriptionKey = `${event.sender.id}:${parsedSubscriptionId}`;
      subscriptions.get(subscriptionKey)?.unsubscribe();
      return { ok: true as const };
    }
  );

  function runAction(action: (runId: string) => Promise<MigrationRun>) {
    return async (_event: unknown, runId: unknown): Promise<BenchlingMigrationRunView> =>
      toBenchlingMigrationRunView(await action(parseBenchlingMigrationRunId(runId)));
  }

  function maybeShowSystemNotification(run: BenchlingMigrationRunView): void {
    const content =
      run.state === 'unlocked' &&
      (!run.linkedItemRecovery || run.linkedItemRecovery.state === 'completed')
        ? {
            title: 'Benchling migration completed',
            body: 'Your migration is ready to open in DNAForge.',
          }
        : run.state === 'action_required'
          ? {
              title: 'Benchling migration needs attention',
              body: 'Open Settings → Migrations in DNAForge to review the warning and continue.',
            }
          : null;
    if (!content) return;
    const notificationKey =
      run.state === 'unlocked'
        ? `${run.state}:${run.linkedItemRecovery?.attemptId ?? 'initial'}`
        : `${run.state}:${run.updatedAt}`;
    if (lastSystemNotificationByRun.get(run.id) === notificationKey) return;
    lastSystemNotificationByRun.delete(run.id);
    lastSystemNotificationByRun.set(run.id, notificationKey);
    if (lastSystemNotificationByRun.size > MAX_SYSTEM_NOTIFICATION_RUNS) {
      const oldestRunId = lastSystemNotificationByRun.keys().next().value;
      if (oldestRunId !== undefined) lastSystemNotificationByRun.delete(oldestRunId);
    }
    showSystemNotification(content);
  }

  async function prepareSource(sourcePath: string): Promise<PreparedLocalBenchlingExportSource> {
    const prepared = prepareLocalExportSource
      ? await prepareLocalExportSource(sourcePath)
      : { archivePath: sourcePath, sourceDisplayName: basename(sourcePath), managed: false };
    if (prepared.managed) {
      managedPreparedArchives.add(prepared.archivePath);
      unclaimedPreparedArchives.add(prepared.archivePath);
    }
    return prepared;
  }

  async function prepareSources(sourcePaths: readonly string[]): Promise<string[]> {
    const archivePaths: string[] = [];
    const preparedDuringThisCall: string[] = [];
    try {
      for (const sourcePath of sourcePaths) {
        const prepared = await prepareSource(sourcePath);
        archivePaths.push(prepared.archivePath);
        if (prepared.managed) preparedDuringThisCall.push(prepared.archivePath);
      }
    } catch (error) {
      await Promise.all(preparedDuringThisCall.map(releasePreparedArchive));
      throw error;
    }
    return archivePaths;
  }

  async function importPreparedSource(
    archivePath: string,
    runId?: string,
    workspaceName?: string,
    workspaceDbId?: number,
    reviewedTables?: readonly RegistryTableMappingDecision[],
    admission?: {
      signal: AbortSignal;
      assertCurrent: () => void;
      assertCanWait: (rootIdentity: string) => void;
    }
  ): Promise<BenchlingMigrationImportLocalBundleResult> {
    const run = reviewedTables
      ? workspaceDbId !== undefined
        ? await coordinator.importLocalBundleToWorkspace(
            archivePath,
            workspaceDbId,
            reviewedTables,
            admission
          )
        : await coordinator.importLocalBundle(archivePath, runId, workspaceName, reviewedTables)
      : runId
        ? await coordinator.importLocalBundle(archivePath, runId)
        : workspaceDbId !== undefined
          ? await coordinator.importLocalBundleToWorkspace(
              archivePath,
              workspaceDbId,
              undefined,
              admission
            )
          : workspaceName
            ? await coordinator.importLocalBundle(archivePath, undefined, workspaceName)
            : await coordinator.importLocalBundle(archivePath);
    watchPreparedArchiveUntilConsumed(archivePath, run);
    return { run: toBenchlingMigrationRunView(run) };
  }

  function watchPreparedArchiveUntilConsumed(archivePath: string, initialRun: MigrationRun): void {
    if (!managedPreparedArchives.has(archivePath)) return;
    unclaimedPreparedArchives.delete(archivePath);
    let unsubscribe: (() => void) | null = null;
    let fallbackPoll: NodeJS.Timeout | null = null;
    let released = false;
    const hasPendingFallback = (run: MigrationRun) =>
      run.state === 'failed' &&
      Array.isArray(run.lastError?.details?.bestEffortFallbackEntryPaths) &&
      run.lastError.details.bestEffortFallbackEntryPaths.length > 0;
    const release = () => {
      if (released) return;
      released = true;
      if (fallbackPoll) clearInterval(fallbackPoll);
      unsubscribe?.();
      unsubscribe = null;
      void releasePreparedArchive(archivePath);
    };
    const inspectDurableResult = async () => {
      if (released) return;
      const runs = await coordinator.listRuns();
      const successor = runs.find(
        (run) =>
          run.localBestEffortFallback?.rootRunId === initialRun.id ||
          run.localBestEffortFallback?.priorRunId === initialRun.id
      );
      if (successor) {
        if (
          successor.state === 'unlocked' ||
          (successor.state === 'failed' && !hasPendingFallback(successor))
        ) {
          release();
        }
      } else {
        const original = runs.find((run) => run.id === initialRun.id);
        if (original) inspect(original);
        else release();
      }
    };
    const inspect = (run: MigrationRun) => {
      if (run.localExportArtifact || (run.externalZipSource && run.state === 'unlocked')) {
        release();
      } else if (run.state === 'failed') {
        if (!hasPendingFallback(run)) release();
      }
    };
    inspect(initialRun);
    if (!managedPreparedArchives.has(archivePath)) return;
    unsubscribe = coordinator.subscribeProgress(initialRun.id, ({ run }) => inspect(run));
    void coordinator.getRun(initialRun.id).then(inspect, () => undefined);
    fallbackPoll = setInterval(() => {
      void inspectDurableResult().catch((error) => {
        console.warn('[benchling-migration] prepared folder cleanup deferred', error);
      });
    }, 1_000);
    fallbackPoll.unref();
  }

  function watchPreparedArchivesUntilAttemptFinishes(
    archivePaths: readonly string[],
    initialRun: MigrationRun
  ): void {
    const managedPaths = archivePaths.filter((path) => managedPreparedArchives.has(path));
    if (managedPaths.length === 0) return;
    managedPaths.forEach((path) => unclaimedPreparedArchives.delete(path));
    let unsubscribe: (() => void) | null = null;
    const inspect = (run: MigrationRun) => {
      const state = run.linkedItemRecovery?.state;
      if (state !== 'completed' && state !== 'failed') return;
      unsubscribe?.();
      unsubscribe = null;
      void Promise.all(managedPaths.map(releasePreparedArchive));
    };
    inspect(initialRun);
    if (!managedPaths.some((path) => managedPreparedArchives.has(path))) return;
    unsubscribe = coordinator.subscribeProgress(initialRun.id, ({ run }) => inspect(run));
    void coordinator.getRun(initialRun.id).then(inspect, () => undefined);
  }

  async function cleanupUnclaimedPreparedArchives(): Promise<void> {
    await Promise.all([...unclaimedPreparedArchives].map(releasePreparedArchive));
  }

  function canonicalizeRendererExportPath(sourcePath: string, errorPrefix: string) {
    if (managedPreparedArchives.has(sourcePath)) return Promise.resolve(sourcePath);
    return assertSafePath(sourcePath, { requireAbsolute: true, errorPrefix });
  }

  async function releasePreparedArchive(archivePath: string): Promise<void> {
    unclaimedPreparedArchives.delete(archivePath);
    if (!managedPreparedArchives.delete(archivePath)) return;
    await unlink(archivePath).catch(() => undefined);
  }
}

export function toBenchlingMigrationRunView(run: MigrationRun): BenchlingMigrationRunView {
  const sourceArtifact = toBenchlingMigrationSourceArtifactView(run);
  return {
    version: run.version,
    id: parseBenchlingMigrationRunId(run.id),
    workspaceId: parseBenchlingMigrationOpaqueId(
      run.projectionScopeId ?? run.workspaceId,
      'workspaceId'
    ),
    displayName: run.displayName,
    ...(run.workspaceOrigin ? { workspaceOrigin: run.workspaceOrigin.kind } : {}),
    scope: structuredClone(run.scope),
    binding: run.binding ? toBenchlingMigrationBindingView(run.binding) : null,
    state: run.state,
    resumeState: run.resumeState,
    attempt: run.attempt,
    converterVersions: { ...run.converterVersions },
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    startedAt: run.startedAt,
    unlockedAt: run.unlockedAt,
    lastError: run.lastError ? toBenchlingMigrationIssueView(run.lastError) : null,
    recoveryAction: toBenchlingMigrationRecoveryAction(run),
    localBundleState: toBenchlingMigrationLocalBundleState(run),
    ...(run.scope.acquisition === 'local_bundle'
      ? {
          localBundleMode: run.workspaceOrigin
            ? ('external_zip' as const)
            : ('copied_artifact' as const),
        }
      : {}),
    ...(canRetryWithoutFailedFile(run) ? { retryWithoutFileAvailable: true } : {}),
    ...(run.state === 'failed' &&
    Array.isArray(run.lastError?.details?.bestEffortFallbackEntryPaths) &&
    run.lastError.details.bestEffortFallbackEntryPaths.length > 0
      ? { bestEffortRecoveryPending: true }
      : {}),
    linkedItemRecovery: run.linkedItemRecovery ? structuredClone(run.linkedItemRecovery) : null,
    ...(sourceArtifact ? { sourceArtifact } : {}),
  };
}

function canRetryWithoutFailedFile(run: MigrationRun): boolean {
  const issue = run.lastError;
  const entries = run.externalZipEntries?.filter((entry) => entry.role === 'source-record') ?? [];
  if (
    run.state !== 'failed' ||
    run.scope.kind !== 'file' ||
    run.workspaceOrigin?.kind !== 'migration_created' ||
    !run.externalZipSource ||
    issue?.code !== 'validation_failed' ||
    !issue.sourceObjectId ||
    !issue.sourceFileName
  ) {
    return false;
  }
  const matches = entries.filter(
    (entry) =>
      entry.sourceObjectId === issue.sourceObjectId &&
      basename(entry.entryPath) === issue.sourceFileName
  );
  if (matches.length !== 1) return false;
  const excluded = new Set([...(run.localRetryExclusion?.entryPaths ?? []), matches[0].entryPath]);
  return entries.some((entry) => !excluded.has(entry.entryPath));
}

function toBenchlingMigrationLocalBundleState(
  run: MigrationRun
): BenchlingMigrationRunView['localBundleState'] {
  if (run.scope.acquisition !== 'local_bundle') return null;
  if (run.workspaceOrigin?.kind === 'adopted_existing') return null;
  if (run.localExportArtifact || run.externalZipSource) return 'ready';
  if (run.localExportIntake) return 'copying';
  return 'waiting_for_selection';
}

function toBenchlingMigrationSourceArtifactView(
  run: MigrationRun
): BenchlingMigrationSourceArtifactView | null {
  const localExportArtifact = run.localExportArtifact;
  if (!localExportArtifact) return null;
  const fileName = localExportArtifact.logicalFilename;
  if (
    (localExportArtifact.format !== 'zip' && localExportArtifact.format !== 'html') ||
    typeof fileName !== 'string' ||
    fileName.length === 0 ||
    fileName.length > 255 ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    hasControlCharacters(fileName) ||
    typeof localExportArtifact.sha256 !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/u.test(localExportArtifact.sha256) ||
    !Number.isSafeInteger(localExportArtifact.sizeBytes) ||
    (localExportArtifact.sizeBytes as number) <= 0
  ) {
    throw new Error('The local Benchling export artifact metadata is invalid.');
  }
  return {
    kind: 'local_bundle',
    format: localExportArtifact.format,
    fileName,
    sha256: localExportArtifact.sha256,
    sizeBytes: localExportArtifact.sizeBytes as number,
  };
}

function toBenchlingMigrationRecoveryAction(
  run: MigrationRun
): BenchlingMigrationRecoveryAction | null {
  if (
    run.state === 'action_required' &&
    run.lastError?.code === 'projection_contract_restart_required'
  ) {
    return 'start_new_migration_select_original_export';
  }
  return null;
}

export function toBenchlingMigrationReportView(
  report: ValidationReport
): BenchlingMigrationReportView {
  assertValidationReportRendererPrivacySafe(report);
  const cloned = redactValidationReportHashes(report);
  cloned.sourceObjects.issues = cloned.sourceObjects.issues.map(toBenchlingMigrationIssueView);
  cloned.attachments.issues = cloned.attachments.issues.map(toBenchlingMigrationIssueView);
  cloned.memberships.issues = cloned.memberships.issues.map(toBenchlingMigrationIssueView);
  cloned.relationships.issues = cloned.relationships.issues.map(toBenchlingMigrationIssueView);
  cloned.projections.issues = cloned.projections.issues.map(toBenchlingMigrationIssueView);
  cloned.hashes.issues = cloned.hashes.issues.map(toBenchlingMigrationIssueView);
  cloned.rendering.issues = cloned.rendering.issues.map(toBenchlingMigrationIssueView);
  if (isValidationReportV2(report) && cloned.version === 2) {
    cloned.exportJobs.issues = cloned.exportJobs.issues.map(toBenchlingMigrationIssueView);
    cloned.snapshotParts.issues = cloned.snapshotParts.issues.map(toBenchlingMigrationIssueView);
    cloned.formulas.issues = cloned.formulas.issues.map(toBenchlingMigrationIssueView);
    cloned.nativeConversionExceptions.issues = cloned.nativeConversionExceptions.issues.map(
      toBenchlingMigrationIssueView
    );
    cloned.collections.issues = cloned.collections.issues.map(toBenchlingMigrationIssueView);
    if (cloned.scopedBoundary) {
      cloned.scopedBoundary.issues = cloned.scopedBoundary.issues.map(
        toBenchlingMigrationIssueView
      );
    }
    if (cloned.directFolderCapture) {
      cloned.directFolderCapture.issues = cloned.directFolderCapture.issues.map(
        toBenchlingMigrationIssueView
      );
    }
    if (cloned.directFolderImportScope) {
      cloned.directFolderImportScope.issues = cloned.directFolderImportScope.issues.map(
        toBenchlingMigrationIssueView
      );
    }
    if (cloned.linkedItemRecovery) {
      cloned.linkedItemRecovery.issues = cloned.linkedItemRecovery.issues.map(
        toBenchlingMigrationIssueView
      );
    }
    if (cloned.folderTreeCapture) {
      cloned.folderTreeCapture.issues = cloned.folderTreeCapture.issues.map(
        toBenchlingMigrationIssueView
      );
    }
    if (cloned.providerTasks) {
      cloned.providerTasks.issues = cloned.providerTasks.issues.map(toBenchlingMigrationIssueView);
    }
    if (cloned.providerActivity) {
      cloned.providerActivity.issues = cloned.providerActivity.issues.map(
        toBenchlingMigrationIssueView
      );
    }
    if (cloned.gmailReceiptConfirmations) {
      cloned.gmailReceiptConfirmations.issues = cloned.gmailReceiptConfirmations.issues.map(
        toBenchlingMigrationIssueView
      );
    }
    if (cloned.localExport) {
      cloned.localExport.issues = cloned.localExport.issues.map(toBenchlingMigrationIssueView);
    }
  }
  cloned.issues = cloned.issues.map(toBenchlingMigrationIssueView);
  assertValidationReportIssueDetailsRedacted(cloned);
  return cloned;
}

function redactValidationReportHashes(report: ValidationReport): BenchlingMigrationReportView {
  const redact = (value: unknown): unknown => {
    if (typeof value === 'string') return redactProviderTaskText(value);
    if (Array.isArray(value)) return value.map(redact);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            key !== 'accountHash' &&
            key !== 'sourceAccountHash' &&
            key !== 'providerTaskId' &&
            key !== 'providerTaskHandleSha256' &&
            key !== 'receiptId'
        )
        .map(([key, nested]) => [key, redact(nested)])
    );
  };
  return redact(structuredClone(report)) as BenchlingMigrationReportView;
}

function toBenchlingMigrationBindingView(binding: SourceBinding): BenchlingMigrationBindingView {
  return {
    version: binding.version,
    benchlingOrigin: binding.benchlingOrigin,
    ...(binding.benchlingOrganizationBaseUrl
      ? { benchlingOrganizationBaseUrl: binding.benchlingOrganizationBaseUrl }
      : {}),
    benchlingAccountEmail: binding.benchlingAccountEmail,
    benchlingOrganizationId: binding.benchlingOrganizationId,
    benchlingOrganizationName: binding.benchlingOrganizationName,
    ...(binding.gmailMailbox ? { gmailMailbox: binding.gmailMailbox } : {}),
    confirmedAt: binding.confirmedAt,
    ...(binding.gmailMismatchConfirmedAt
      ? { gmailMismatchConfirmedAt: binding.gmailMismatchConfirmedAt }
      : {}),
  };
}

function normalizeProgressMessage(message: string | undefined, state: MigrationState): string {
  if (typeof message !== 'string') return state.replaceAll('_', ' ');
  const trimmed = message.trim();
  return trimmed.length > 0 && trimmed.length <= 500
    ? redactProviderTaskText(trimmed)
    : state.replaceAll('_', ' ');
}

async function readCreatedObjects(
  run: MigrationRun
): Promise<BenchlingMigrationCreatedObjectView[]> {
  try {
    const manifest = parseNativeWorkspaceManifest(
      await readFile(join(run.workspacePath, NATIVE_WORKSPACE_MANIFEST_PATH), 'utf8')
    );
    return manifest.entities
      .map((entity) => ({
        id: entity.id,
        type: entity.type,
        name: entity.name,
        path: nativeWorkspaceEntityDisplayPath(entity),
      }))
      .sort(
        (left, right) =>
          left.type.localeCompare(right.type) ||
          left.name.localeCompare(right.name) ||
          left.id.localeCompare(right.id)
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(
        '[benchling-migration] Created-object history is unavailable for one migration.'
      );
    }
    return [];
  }
}

function historyEntityCount(
  report: ValidationReport | null,
  createdObjects: readonly BenchlingMigrationCreatedObjectView[]
): number {
  if (report && isValidationReportV2(report)) {
    const sourceEntityCount = report.sourceObjects.actual;
    if (Number.isSafeInteger(sourceEntityCount) && sourceEntityCount >= 0) {
      return sourceEntityCount;
    }
  }
  return createdObjects.length;
}

function missingDependencyCount(report: ValidationReport | null): number {
  return report && isValidationReportV2(report)
    ? (report.linkedItemRecovery?.evidence.remainingUniqueObjectCount ?? 0)
    : 0;
}

function toBenchlingMigrationIssueView(issue: MigrationIssue): BenchlingMigrationRunIssueView {
  return {
    code: issue.code,
    message: redactProviderTaskText(issue.message),
    blocking: issue.blocking,
    ...(issue.sourceObjectId ? { sourceObjectId: issue.sourceObjectId } : {}),
    ...(issue.sourceFileName
      ? { sourceFileName: redactProviderTaskText(issue.sourceFileName) }
      : {}),
    ...(issue.relationshipId ? { relationshipId: issue.relationshipId } : {}),
  };
}

function normalizeProgressCount(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

async function assertLinkedItemExportFiles(sourcePaths: readonly string[]): Promise<void> {
  if (
    sourcePaths.length === 0 ||
    sourcePaths.length > BENCHLING_MIGRATION_MAX_LINKED_ITEM_EXPORT_FILES
  ) {
    throw new Error(
      `Choose 1 to ${BENCHLING_MIGRATION_MAX_LINKED_ITEM_EXPORT_FILES} Benchling ZIP exports.`
    );
  }
  await Promise.all(
    sourcePaths.map(async (sourcePath) => {
      if (
        !isAbsolute(sourcePath) ||
        sourcePath.length > 4096 ||
        hasControlCharacters(sourcePath) ||
        !/\.zip$/iu.test(sourcePath)
      ) {
        throw new Error('The selected linked-item export is not an absolute Benchling ZIP path.');
      }
      const file = await stat(sourcePath);
      if (!file.isFile()) {
        throw new Error('Each linked-item export must be a regular ZIP file.');
      }
    })
  );
}

function assertSafeLinkedItemRecoveryUrl(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 8192 ||
    hasControlCharacters(value)
  ) {
    throw new Error('The linked-item recovery location is invalid.');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('The linked-item recovery location is invalid.');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    (hostname !== 'benchling.com' && !hostname.endsWith('.benchling.com'))
  ) {
    throw new Error('The linked-item recovery location must be an exact HTTPS Benchling URL.');
  }
  return value;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function normalizeProgressWarnings(
  warnings: readonly string[] | undefined,
  run: BenchlingMigrationRunView
): string[] {
  const normalized = new Set<string>();
  for (const warning of warnings ?? []) {
    const trimmed = warning.trim();
    if (trimmed.length > 0 && trimmed.length <= 500) {
      normalized.add(redactProviderTaskText(trimmed));
    }
  }
  if (run.lastError?.message) normalized.add(redactProviderTaskText(run.lastError.message));
  return [...normalized];
}

function redactProviderTaskText(value: string): string {
  return value
    .replace(
      /\/(?:api\/v2\/tasks|1\/api\/(?:exports|tasks))\/[A-Za-z0-9][A-Za-z0-9_-]{0,199}\/?/giu,
      '/provider-task/[redacted]'
    )
    .replace(/\btask:[A-Za-z0-9][A-Za-z0-9._:-]{0,199}\b/giu, '[provider-task]')
    .replace(
      /\b(provider task(?: id| identity)?(?:\s+is|:)?\s+)[A-Za-z0-9][A-Za-z0-9._:-]{0,199}\b/giu,
      '$1[redacted]'
    );
}

function showBenchlingMigrationSystemNotification(notification: {
  title: string;
  body: string;
}): void {
  try {
    if (!Notification.isSupported()) return;
    new Notification(notification).show();
  } catch {}
}
