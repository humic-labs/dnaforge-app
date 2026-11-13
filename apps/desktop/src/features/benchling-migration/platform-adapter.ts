import type { PlatformBridge } from '../../platform';
import type {
  BenchlingMigrationReportView,
  BenchlingMigrationRunView,
} from '../../shared/benchling-migration-ipc';
import type { BenchlingMigrationWizardBridge, BenchlingMigrationWizardView } from './types';
import { isFinalizingNativeZipImport } from './migration-progress';
import { observeWorkflowAction } from '../../lib/workflow-telemetry';

type MigrationPlatform = PlatformBridge['benchlingMigration'];

const REPORT_STATES = new Set<BenchlingMigrationRunView['state']>([
  'action_required',
  'cancelled_preserved',
  'ready_to_unlock',
  'unlocked',
  'failed',
]);

export interface BenchlingMigrationWizardBridgeDependencies {
  openDialog?: PlatformBridge['dialog']['open'];
  existingWorkspaceReadiness: {
    getWorkspaceRootById(id: number): Promise<string | null>;
    waitForWorkspaceReconcileIdle(workspaceRoot: string): Promise<void>;
  };
}

export function createBenchlingMigrationWizardBridge(
  platform: MigrationPlatform,
  dependencies: BenchlingMigrationWizardBridgeDependencies
): BenchlingMigrationWizardBridge {
  const { openDialog, existingWorkspaceReadiness } = dependencies;
  const reports = new Map<string, BenchlingMigrationReportView>();
  const observedMeaningfulReceipts = new Set<string>();

  const observeCompletedUserMigration = (view: BenchlingMigrationWizardView) => {
    const run = view.run;
    const status =
      run?.state === 'unlocked'
        ? 'completed'
        : run?.state === 'action_required'
          ? 'needs_action'
          : run?.state === 'failed'
            ? 'failed'
            : null;
    if (!run || !status) return view;
    const importedObjectCount =
      run.state === 'unlocked'
        ? view.createdObjects.length
        : (view.report?.projections.actual ?? 0);
    if (status === 'completed' && importedObjectCount === 0) return view;

    const receiptKey = `${run.id}:${run.updatedAt}`;
    if (observedMeaningfulReceipts.has(receiptKey)) return view;

    observedMeaningfulReceipts.add(receiptKey);
    observeWorkflowAction({
      workflow: 'benchling_migration',
      action: 'import',
      status,
      resultCount: importedObjectCount,
      usableResult: importedObjectCount > 0 && status !== 'failed',
      success: status !== 'failed',
      initiatedAtMs: Date.parse(run.startedAt ?? run.createdAt),
    });
    return view;
  };

  const viewForRun = async (
    run: BenchlingMigrationRunView
  ): Promise<BenchlingMigrationWizardView> => {
    if (run.state === 'unlocked') {
      if (isActiveLinkedItemImport(run)) {
        let report = reports.get(run.id) ?? null;
        if (!report) {
          const persisted = await platform.getReport(run.id);
          if (persisted) {
            reports.set(run.id, persisted);
            report = persisted;
          }
        }
        return { run, report, createdObjects: [] };
      }
      const detail = await platform.getHistoryDetail(run.id);
      if (detail.report) reports.set(run.id, detail.report);
      return detail;
    }
    let report = reports.get(run.id) ?? null;
    if (REPORT_STATES.has(run.state)) {
      const persisted = await platform.getReport(run.id);
      if (persisted) {
        reports.set(run.id, persisted);
        report = persisted;
      }
    }
    return { run, report, createdObjects: [] };
  };

  const runAction = async (
    runId: string,
    action: (runId: string) => Promise<BenchlingMigrationRunView>
  ) => observeCompletedUserMigration(await viewForRun(await action(runId)));

  const clear = (runId: string) => {
    reports.delete(runId);
  };

  return {
    subscribeProgress: (runId, callback, onStatus) =>
      platform.subscribeProgress(runId, callback, onStatus),

    async load(runId) {
      if (runId) {
        const detail = await platform.getHistoryDetail(runId);
        if (detail.report) reports.set(runId, detail.report);
        if (isFinalizingNativeZipImport(detail.run)) {
          await platform.getActiveRun();
        }
        return detail;
      }
      const run = await platform.getActiveRun();
      return run ? viewForRun(run) : emptyView();
    },

    async importLocalBundle(runId) {
      const { run } = await (runId
        ? platform.importLocalBundle({ runId })
        : platform.importLocalBundle());
      if (!run) {
        return runId ? viewForRun(await requireActiveRun(platform, runId)) : emptyView();
      }
      return observeCompletedUserMigration(await viewForRun(run));
    },

    async retryWithoutFailedFile(runId) {
      const { run } = await platform.importLocalBundle({ retryFailedRunId: runId });
      if (!run) throw new Error('The failed-file retry did not create a new import.');
      return observeCompletedUserMigration(await viewForRun(run));
    },

    async chooseLocalBundle() {
      if (!openDialog) throw new Error('The Benchling export picker is unavailable.');
      const selected = await openDialog({
        title: 'Choose a Benchling export',
        fileOrDirectory: true,
        filters: [{ name: 'Benchling ZIP exports', extensions: ['zip'] }],
      });
      if (selected === null) return null;
      if (typeof selected !== 'string') {
        throw new Error('Choose one Benchling ZIP export or unzipped export folder.');
      }
      return selected;
    },

    async prepareLocalBundle(sourcePath) {
      const survey = await platform.surveyImportDestinations({ archivePath: sourcePath });
      return {
        sourcePath: survey.preparedArchivePath,
        archiveName: survey.sourceDisplayName,
        archiveObjectCount: survey.archiveObjectCount,
        candidates: survey.candidates,
        ...(survey.registryTables?.length ? { registryTables: survey.registryTables } : {}),
      };
    },

    async importPreparedLocalBundle(selection, destination) {
      if (destination.kind === 'new_workspace') {
        const { run } = await platform.importLocalBundle({
          sourcePath: selection.sourcePath,
          workspaceName: destination.workspaceName,
          ...(destination.reviewedTables ? { reviewedTables: destination.reviewedTables } : {}),
        });
        return run ? observeCompletedUserMigration(await viewForRun(run)) : emptyView();
      }
      if (!existingWorkspaceReadiness) throw new Error('Workspace readiness is unavailable.');
      const workspaceRoot = await existingWorkspaceReadiness.getWorkspaceRootById(
        destination.workspaceDbId
      );
      if (!workspaceRoot) throw new Error('The selected project is unavailable.');
      await existingWorkspaceReadiness.waitForWorkspaceReconcileIdle(workspaceRoot);
      const currentRoot = await existingWorkspaceReadiness.getWorkspaceRootById(
        destination.workspaceDbId
      );
      if (currentRoot !== workspaceRoot)
        throw new Error('The selected project changed before import.');
      const { run } = await platform.importLocalBundle({
        sourcePath: selection.sourcePath,
        workspaceDbId: destination.workspaceDbId,
        ...(destination.reviewedTables ? { reviewedTables: destination.reviewedTables } : {}),
      });
      if (!run) throw new Error('The selected Benchling export was not imported.');
      reports.delete(run.id);
      return observeCompletedUserMigration(await viewForRun(run));
    },

    async importDroppedLocalBundle(sourcePath, runId) {
      const { run } = await platform.importLocalBundle({
        sourcePath,
        ...(runId ? { runId } : {}),
      });
      return run ? observeCompletedUserMigration(await viewForRun(run)) : emptyView();
    },

    async appendWorkspaceExports(runId, sourcePaths) {
      const { run } = await platform.appendWorkspaceExports({
        runId,
        ...(sourcePaths ? { sourcePaths } : {}),
      });
      if (!run) {
        const detail = await platform.getHistoryDetail(runId);
        if (detail.report) reports.set(runId, detail.report);
        return detail;
      }
      reports.delete(runId);
      if (run.state === 'unlocked') {
        const detail = await platform.getHistoryDetail(runId);
        if (detail.report) reports.set(runId, detail.report);
        return observeCompletedUserMigration(detail);
      }
      return observeCompletedUserMigration(await viewForRun(run));
    },

    async resolveImportDecision(runId, attemptId, decision) {
      const { run } = await platform.resolveImportDecision({ runId, attemptId, decision });
      return observeCompletedUserMigration(await viewForRun(run));
    },

    async addLinkedItemExports(runId, sourcePaths) {
      const { run } = await platform.addLinkedItemExports({
        runId,
        ...(sourcePaths ? { sourcePaths } : {}),
      });
      if (!run) {
        const detail = await platform.getHistoryDetail(runId);
        if (detail.report) reports.set(runId, detail.report);
        return detail;
      }
      reports.delete(runId);
      if (run.state === 'unlocked') {
        const detail = await platform.getHistoryDetail(runId);
        if (detail.report) reports.set(runId, detail.report);
        return observeCompletedUserMigration(detail);
      }
      return observeCompletedUserMigration(await viewForRun(run));
    },

    async openLinkedItemRecoveryLocation(runId, kind, sourceId) {
      await platform.openLinkedItemRecoveryLocation({ runId, kind, sourceId });
    },

    start: (runId) => runAction(runId, (id) => platform.start(id)),
    pause: (runId) => runAction(runId, (id) => platform.pause(id)),
    cancelPreserved: (runId) => runAction(runId, (id) => platform.cancelPreserved(id)),
    async startOverPreserved(runId) {
      await platform.startOverPreserved(runId);
      clear(runId);
      return emptyView();
    },
    async startNewMigration(runId) {
      const detail = await platform.getHistoryDetail(runId);
      if (detail.run.state === 'ready_to_unlock') {
        await platform.unlock(runId);
      } else if (detail.run.state !== 'unlocked') {
        throw new Error('Only a completed migration can start a new migration.');
      }
      clear(runId);
      return emptyView();
    },
    async discard(runId) {
      await platform.discard(runId);
      clear(runId);
      return emptyView();
    },
    resume: (runId) => runAction(runId, (id) => platform.resume(id)),
    async unlock(runId) {
      const result = await platform.unlock(runId);
      return observeCompletedUserMigration(await viewForRun(result.run));
    },
  };
}

function isActiveLinkedItemImport(run: BenchlingMigrationRunView): boolean {
  const recovery = run.linkedItemRecovery;
  return (
    recovery !== null &&
    recovery !== undefined &&
    recovery.state !== 'completed' &&
    recovery.state !== 'failed'
  );
}

async function requireActiveRun(
  platform: MigrationPlatform,
  runId: string
): Promise<BenchlingMigrationRunView> {
  const run = await platform.getActiveRun();
  if (!run || run.id !== runId) throw new Error(`Benchling migration ${runId} is not active.`);
  return run;
}

function emptyView(): BenchlingMigrationWizardView {
  return { run: null, report: null, createdObjects: [] };
}
