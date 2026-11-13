import type {
  BenchlingMigrationHistorySummaryView,
  BenchlingMigrationRunView,
} from '../../shared/benchling-migration-ipc';
import type { MigrationSettingsView, MigrationTone } from '../../shared/migration-settings';
import {
  isCoordinatorDrivenLocalImport,
  isFinalizingNativeZipImport,
  isLocalBundleRunView,
  migrationProgressForRun,
} from './migration-progress';
import type { BenchlingMigrationStatusSnapshot } from './useBenchlingMigrationStatus';

type BuildBenchlingMigrationSettingsViewOptions = Readonly<{
  snapshot: BenchlingMigrationStatusSnapshot;
  history: readonly BenchlingMigrationHistorySummaryView[];
  historyError: string | null;
  onStart(): void;
  onOpenActive(): void;
  onOpenHistory(runId: string): void;
  onOpenWorkspace(workspaceId: string): void;
  onImportMissingDependencies(runId: string): void;
}>;

const RUNNING_STATES = new Set<BenchlingMigrationRunView['state']>([
  'export_pending',
  'downloading',
  'parsing',
  'offline_resolution',
  'targeted_reads',
  'projecting',
  'validating',
]);

export function buildBenchlingMigrationSettingsView({
  snapshot,
  history,
  historyError,
  onStart,
  onOpenActive,
  onOpenHistory,
  onOpenWorkspace,
  onImportMissingDependencies,
}: BuildBenchlingMigrationSettingsViewOptions): MigrationSettingsView {
  const activeRun = snapshot.run?.state === 'unlocked' ? null : snapshot.run;
  return {
    sources: [
      {
        id: 'benchling',
        name: 'Benchling',
        description: 'Import notebooks and their linked scientific entities from a Benchling ZIP.',
        actionLabel: 'Migrate from Benchling',
        onStart,
      },
    ],
    activeMigration:
      activeRun || snapshot.error
        ? {
            id: activeRun?.id ?? 'benchling-status-error',
            sourceId: 'benchling',
            sourceName: 'Benchling',
            phase: statusLabel(snapshot),
            completed: completedText(snapshot),
            eta: etaText(snapshot),
            warnings: visibleWarnings(snapshot),
            message: snapshot.message,
            tone: statusTone(snapshot),
            onOpen: activeRun ? () => onOpenHistory(activeRun.id) : onOpenActive,
          }
        : null,
    history: history
      .filter((entry) => entry.run.id !== activeRun?.id)
      .map((entry) => ({
        id: entry.run.id,
        sourceId: 'benchling',
        sourceName: 'Benchling',
        title: entry.run.sourceArtifact?.fileName ?? entry.run.displayName,
        occurredAt: entry.run.unlockedAt ?? entry.run.updatedAt,
        stateLabel: historyStateLabel(entry.run),
        createdObjectCount: entry.createdObjectCount,
        workspaceAction:
          entry.run.state === 'unlocked'
            ? { kind: 'available' as const, onOpen: () => onOpenWorkspace(entry.run.workspaceId) }
            : { kind: 'unavailable' as const },
        missingDependencies:
          entry.missingDependencyCount <= 0
            ? { kind: 'none' as const }
            : entry.run.state === 'unlocked'
              ? {
                  kind: 'available' as const,
                  count: entry.missingDependencyCount,
                  onImport: () => onImportMissingDependencies(entry.run.id),
                }
              : {
                  kind: 'unavailable' as const,
                  count: entry.missingDependencyCount,
                },
        onOpenDetails: () => onOpenHistory(entry.run.id),
      })),
    historyError,
  };
}

function statusLabel(snapshot: BenchlingMigrationStatusSnapshot): string {
  const run = snapshot.run;
  if (snapshot.error) return 'Status unavailable';
  if (!run) return 'Migration';
  const progress = migrationProgressForRun(run);
  if (isFinalizingNativeZipImport(run)) return 'Finishing up';
  if (isCoordinatorDrivenLocalImport(run)) return 'Preparing notebook';
  if (run.state === 'ready_to_unlock') return 'Ready to unlock';
  if (run.state === 'action_required') return 'Action required';
  if (run.state === 'failed') return 'Migration failed';
  if (run.localBundleState === 'waiting_for_selection') {
    return progress?.label ?? 'Waiting for export';
  }
  if (run.state === 'scope_planning') return 'Review scope';
  if (RUNNING_STATES.has(run.state) || run.localBundleState === 'copying') {
    return progress?.label ?? 'Migration in progress';
  }
  return 'Setup';
}

function statusTone(snapshot: BenchlingMigrationStatusSnapshot): MigrationTone {
  const run = snapshot.run;
  if (snapshot.error || run?.state === 'action_required' || run?.state === 'failed') return 'error';
  if (run && isFinalizingNativeZipImport(run)) return 'progress';
  if (run?.state === 'ready_to_unlock') return 'success';
  if (run?.localBundleState === 'waiting_for_selection') {
    return 'warning';
  }
  if (
    run &&
    (RUNNING_STATES.has(run.state) ||
      run.localBundleState === 'copying' ||
      isCoordinatorDrivenLocalImport(run))
  ) {
    return 'progress';
  }
  return 'neutral';
}

function completedText(snapshot: BenchlingMigrationStatusSnapshot): string {
  if (snapshot.completedItems === null || snapshot.totalItems === null) {
    return 'Not available yet';
  }
  if (
    snapshot.run &&
    isLocalBundleRunView(snapshot.run) &&
    snapshot.run.localBundleState === 'copying'
  ) {
    return formatByteProgress(snapshot.completedItems, snapshot.totalItems);
  }
  return `${snapshot.completedItems} of ${snapshot.totalItems}`;
}

function formatByteProgress(completedBytes: number, totalBytes: number): string {
  const units = [
    { threshold: 1024 ** 3, divisor: 1024 ** 3, label: 'GB' },
    { threshold: 1024 ** 2, divisor: 1024 ** 2, label: 'MB' },
    { threshold: 1024, divisor: 1024, label: 'KB' },
  ];
  const unit = units.find((candidate) => totalBytes >= candidate.threshold) ?? {
    threshold: 0,
    divisor: 1,
    label: 'B',
  };
  const format = (bytes: number) =>
    new Intl.NumberFormat('en-US', {
      maximumFractionDigits: unit.divisor === 1 ? 0 : 1,
    }).format(bytes / unit.divisor);
  return `${format(completedBytes)} ${unit.label} of ${format(totalBytes)} ${unit.label}`;
}

function etaText(snapshot: BenchlingMigrationStatusSnapshot): string {
  const run = snapshot.run;
  if (run && isFinalizingNativeZipImport(run)) return 'No time estimate';
  if (run?.state === 'ready_to_unlock') return 'Complete';
  if (run?.localBundleState === 'waiting_for_selection') return 'Waiting for ZIP';
  if (run?.state === 'action_required') return 'Waiting for action';
  if (run?.state === 'failed') return 'Not available';
  return snapshot.completedItems === null || snapshot.totalItems === null
    ? 'Waiting for item count'
    : 'No time estimate';
}

function visibleWarnings(snapshot: BenchlingMigrationStatusSnapshot): string[] {
  return [...new Set([...(snapshot.error ? [snapshot.error] : []), ...snapshot.warnings])];
}

function historyStateLabel(run: BenchlingMigrationRunView): string {
  if (isFinalizingNativeZipImport(run)) return 'Finishing up';
  const state = run.state;
  if (state === 'unlocked') return 'Completed';
  if (state === 'failed') return 'Failed';
  if (state === 'discarded') return 'Discarded';
  if (state === 'ready_to_unlock') return 'Ready to open';
  return 'In progress';
}
