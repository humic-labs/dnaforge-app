import type { MigrationRun } from '../../shared/benchling-migration';
import {
  runLocalExportAttempt,
  type LinkedItemRecoveryExecutorDeps,
} from './linked-item-recovery-executor';

export type WorkspaceAppendExecutorDeps = LinkedItemRecoveryExecutorDeps;

export async function appendBenchlingExportsToWorkspace(
  run: MigrationRun,
  sourcePaths: readonly string[],
  deps: WorkspaceAppendExecutorDeps
): Promise<MigrationRun> {
  return runLocalExportAttempt(run, Object.freeze([...sourcePaths]), deps, 'workspace_append');
}
