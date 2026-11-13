import type { BenchlingMigrationRunView } from '../../shared/benchling-migration-ipc';
import { isLocalExportFolderSourceRef } from '../../shared/benchling-migration';

export type BenchlingMigrationPhase = {
  state: BenchlingMigrationRunView['state'];
  label: string;
};

export const ACTIVE_MIGRATION_PHASES: readonly BenchlingMigrationPhase[] = [
  { state: 'export_pending', label: 'Requesting exports' },
  { state: 'downloading', label: 'Capturing source archive' },
  { state: 'parsing', label: 'Reading and classifying objects' },
  { state: 'offline_resolution', label: 'Resolving links' },
  { state: 'targeted_reads', label: 'Reading required one-hop targets' },
  { state: 'projecting', label: 'Converting and writing native objects' },
  { state: 'validating', label: 'Checking imported objects' },
];

const LOCAL_BUNDLE_PHASE_LABELS: Readonly<
  Partial<Record<BenchlingMigrationRunView['state'], string>>
> = {
  draft: 'Copying selected export',
  scope_planning: 'Preparing selected export',
  export_pending: 'Copying selected export',
  downloading: 'Copying selected export',
  parsing: 'Reading and classifying objects',
  offline_resolution: 'Resolving links',
  targeted_reads: 'Finalizing link placeholders',
  projecting: 'Converting and writing native objects',
  validating: 'Checking imported objects',
};

export function isLocalBundleRunView(run: BenchlingMigrationRunView): boolean {
  return run.scope.acquisition === 'local_bundle';
}

export function isFinalizingNativeZipImport(run: BenchlingMigrationRunView): boolean {
  return (
    run.state === 'ready_to_unlock' &&
    run.workspaceOrigin === 'migration_created' &&
    run.localBundleMode === 'external_zip' &&
    isLocalBundleRunView(run)
  );
}

export function isCoordinatorDrivenLocalImport(run: BenchlingMigrationRunView): boolean {
  if (
    run.state !== 'scope_planning' ||
    run.localBundleState !== 'ready' ||
    !isLocalBundleRunView(run)
  ) {
    return false;
  }
  if (run.scope.kind === 'file' && run.localBundleMode === 'external_zip') return true;
  const root =
    run.scope.kind === 'folder'
      ? run.scope.folder
      : run.scope.kind === 'folder_tree'
        ? run.scope.roots[0]
        : null;
  return root !== null && root !== undefined && isLocalExportFolderSourceRef(root);
}

export function migrationProgressForState(
  state: BenchlingMigrationRunView['state']
): { label: string } | null {
  const phase = ACTIVE_MIGRATION_PHASES.find((candidate) => candidate.state === state);
  return phase ? { label: phase.label } : null;
}

export function migrationProgressForRun(run: BenchlingMigrationRunView): { label: string } | null {
  if (isLocalBundleRunView(run)) {
    if (run.localBundleState === 'waiting_for_selection') {
      return { label: run.scope.kind === 'file' ? 'Waiting for export' : 'Waiting for folder ZIP' };
    }
    if (run.localBundleState === 'copying')
      return {
        label:
          run.localBundleMode === 'external_zip'
            ? 'Verifying selected export'
            : 'Copying selected export',
      };
    const label = LOCAL_BUNDLE_PHASE_LABELS[run.state];
    if (label) return { label };
  }
  return migrationProgressForState(run.state);
}
