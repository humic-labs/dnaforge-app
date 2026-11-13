import type { ImportFileResult } from '../../shared/workspace-git-types';
import {
  createImportAttemptId,
  importElapsedMs,
  importStartMark,
  trackImportCompleted,
  trackImportFailed,
  trackImportStarted,
} from './import-telemetry';

interface SingleFileImportWriteInput {
  targetRoot: string;
  sourcePath: string;
  importFile: (request: { targetRoot: string; sourcePath: string }) => Promise<ImportFileResult>;
}

export interface SingleFileImportWriteOutcome {
  readonly result: ImportFileResult;
  readonly operationId: string;
}

export async function runSingleFileImportWrite(
  input: SingleFileImportWriteInput
): Promise<SingleFileImportWriteOutcome> {
  const operationId = createImportAttemptId();
  trackImportStarted([input.sourcePath], operationId);
  const startedAt = importStartMark();

  let result: ImportFileResult;
  try {
    result = await input.importFile({
      targetRoot: input.targetRoot,
      sourcePath: input.sourcePath,
    });
  } catch (error) {
    trackImportFailed({ operationId, stage: 'write', errorClass: 'import_write_failed' });
    throw error;
  }

  trackImportCompleted({
    operationId,
    sourcePaths: [input.sourcePath],
    importedCount: result.packageProductPaths?.length || 1,
    durationMs: importElapsedMs(startedAt),
  });
  return { result, operationId };
}

export function trackSingleFileImportProjectionFailed(operationId: string): void {
  trackImportFailed({ operationId, stage: 'unknown', errorClass: 'projection' });
}
