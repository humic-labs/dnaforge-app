import {
  importItemSourcePath,
  type ImportWizardState,
} from '../workspace-loader/public/import-wizard-state';
import type { ImportWizardOutcome } from './import-wizard-store';
import {
  executeImportOutcome,
  type ImportExecDeps,
  type ImportExecResult,
} from './execute-import-outcome';
import {
  createImportAttemptId,
  importElapsedMs,
  importFailureStage,
  importStartMark,
  trackImportCompleted,
  trackImportFailed,
  trackImportStarted,
  trackImportWizardDismissed,
} from './import-telemetry';
import { trackWorkspaceCreated } from '../workspace-loader/public/workspace-created-telemetry';

export interface ImportFlowDeps {
  buildState: (paths: string[]) => Promise<ImportWizardState>;
  openWizard: (state: ImportWizardState) => Promise<ImportWizardOutcome | null>;
  execDeps: ImportExecDeps;
  onComplete?: (result: ImportExecResult) => void;
  onAgentFile?: (importedPaths: string[]) => void;
}

export async function runImportFlow(
  paths: string[],
  deps: ImportFlowDeps
): Promise<ImportExecResult | null> {
  if (paths.length === 0) return null;

  const state = await deps.buildState(paths);
  if (state.items.length === 0) return null;

  const wizardOpenedAt = importStartMark();
  const outcome = await deps.openWizard(state);
  if (!outcome) {
    trackImportWizardDismissed({
      sourcePaths: [...new Set(state.items.map(importItemSourcePath))],
      openDurationMs: importElapsedMs(wizardOpenedAt),
    });
    return null;
  }

  const confirmedPaths = [...new Set(outcome.items.map(importItemSourcePath))];
  const operationId = createImportAttemptId();
  trackImportStarted(confirmedPaths, operationId);
  const startMark = importStartMark();

  let result: ImportExecResult;
  try {
    result = await executeImportOutcome(outcome, deps.execDeps);
  } catch (error) {
    trackImportFailed({
      operationId,
      stage: importFailureStage(null),
      errorClass: 'import_execution_threw',
    });
    throw error;
  }

  if (result.imported === 0) {
    const everythingFailed = result.failed > 0;
    trackImportFailed({
      operationId,
      stage: everythingFailed ? importFailureStage(result) : 'validate',
      errorClass: everythingFailed ? 'import_write_failed' : 'import_nothing_written',
    });
  } else {
    trackImportCompleted({
      operationId,
      sourcePaths: confirmedPaths,
      importedCount: result.imported,
      durationMs: importElapsedMs(startMark),
    });
    if (result.failed > 0) {
      trackImportFailed({
        operationId,
        stage: importFailureStage(result),
        errorClass: 'import_item_write_failed',
      });
    }
  }
  if (result.createdNewWorkspace) trackWorkspaceCreated();

  deps.onComplete?.(result);

  if (outcome.agentRequested && result.written.length > 0) {
    deps.onAgentFile?.(result.written.map((w) => w.destPath));
  }
  return result;
}
