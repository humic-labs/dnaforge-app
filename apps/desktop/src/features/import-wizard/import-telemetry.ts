import { trackRendererEvent } from '../../lib/analytics';
import { observeWorkflowAction } from '../../lib/workflow-telemetry';
import { fileTypeCategory } from '../sequence/public/file-open-telemetry';
import type { SafeFileTypeCategory } from '@waypoint/analytics-policy';
import type { ImportExecResult } from './execute-import-outcome';

export type ImportRecordCountBucket =
  | '0'
  | '1'
  | '2_5'
  | '6_20'
  | '21_100'
  | '100_plus'
  | 'unknown';
export type ImportDurationBucket = 'lt_1s' | '1_5s' | '5_30s' | '30s_plus' | 'unknown';
export type ImportFailureStage = 'parse' | 'validate' | 'normalize' | 'write' | 'unknown';

const FEATURE_AREA = 'import';
const SOURCE_SYSTEM_TYPE = 'file';

function safeTrack(event: string, properties: Record<string, unknown>): void {
  try {
    trackRendererEvent(event, properties);
  } catch {}
}

export function importRecordCountBucket(count: number): ImportRecordCountBucket {
  if (!Number.isFinite(count) || count < 0) return 'unknown';
  if (count === 0) return '0';
  if (count === 1) return '1';
  if (count <= 5) return '2_5';
  if (count <= 20) return '6_20';
  if (count <= 100) return '21_100';
  return '100_plus';
}

export function importDurationBucket(durationMs: number): ImportDurationBucket {
  if (!Number.isFinite(durationMs) || durationMs < 0) return 'unknown';
  if (durationMs < 1000) return 'lt_1s';
  if (durationMs < 5000) return '1_5s';
  if (durationMs < 30000) return '5_30s';
  return '30s_plus';
}

export function importElapsedMs(startedAt: number): number {
  return performance.now() - startedAt;
}

export function importStartMark(): number {
  return performance.now();
}

export function createImportAttemptId(): string {
  return globalThis.crypto.randomUUID();
}

export function dominantFileTypeCategory(paths: readonly string[]): SafeFileTypeCategory {
  if (paths.length === 0) return 'unknown';
  const counts = new Map<SafeFileTypeCategory, number>();
  for (const path of paths) {
    const category = fileTypeCategory(path);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  let winner: SafeFileTypeCategory = 'unknown';
  let best = 0;
  let tied = false;
  for (const [category, count] of counts) {
    if (count > best) {
      winner = category;
      best = count;
      tied = false;
    } else if (count === best) {
      tied = true;
    }
  }
  return tied ? 'unknown' : winner;
}

export function importFailureStage(result: ImportExecResult | null): ImportFailureStage {
  if (!result) return 'unknown';
  return result.failed > 0 ? 'write' : 'unknown';
}

export function trackImportStarted(sourcePaths: readonly string[], operationId: string): void {
  safeTrack('import_started', {
    feature_area: FEATURE_AREA,
    source_system_type: SOURCE_SYSTEM_TYPE,
    file_type_category: dominantFileTypeCategory(sourcePaths),
    operation_id: operationId,
  });
}

export function trackImportCompleted(input: {
  operationId: string;
  sourcePaths: readonly string[];
  importedCount: number;
  durationMs: number;
}): void {
  safeTrack('import_completed', {
    feature_area: FEATURE_AREA,
    source_system_type: SOURCE_SYSTEM_TYPE,
    file_type_category: dominantFileTypeCategory(input.sourcePaths),
    record_count_bucket: importRecordCountBucket(input.importedCount),
    import_duration_bucket: importDurationBucket(input.durationMs),
    operation_id: input.operationId,
  });
  try {
    observeWorkflowAction({
      workflow: 'file',
      action: 'import',
      status: 'completed',
      resultCount: input.importedCount,
    });
  } catch {}
}

export function trackImportFailed(input: {
  operationId: string;
  stage: ImportFailureStage;
  errorClass: string;
}): void {
  safeTrack('import_failed', {
    feature_area: FEATURE_AREA,
    source_system_type: SOURCE_SYSTEM_TYPE,
    failure_stage: input.stage,
    error_class: input.errorClass,
    operation_id: input.operationId,
  });
}

export function trackImportWizardDismissed(input: {
  sourcePaths: readonly string[];
  openDurationMs: number;
}): void {
  safeTrack('import_wizard_dismissed', {
    feature_area: FEATURE_AREA,
    source_system_type: SOURCE_SYSTEM_TYPE,
    file_type_category: dominantFileTypeCategory(input.sourcePaths),
    record_count_bucket: importRecordCountBucket(input.sourcePaths.length),
    import_duration_bucket: importDurationBucket(input.openDurationMs),
  });
}
