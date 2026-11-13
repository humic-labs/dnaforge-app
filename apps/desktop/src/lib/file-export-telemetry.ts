import { getAnalyticsCaptureGeneration } from './analytics';
import { getTelemetryCorrelationContext } from './telemetry-correlation';
import { beginWorkflowAction, type WorkflowOperation } from './workflow-telemetry';
import type { ExportFormat } from '../shared/scientific-workflow-vocab';

export function beginFileExport(
  exportFormat?: ExportFormat
): Pick<WorkflowOperation, 'complete' | 'fail' | 'cancel'> | undefined {
  try {
    const generation = getAnalyticsCaptureGeneration();
    const context = getTelemetryCorrelationContext();
    const operation = beginWorkflowAction({
      workflow: 'file',
      action: 'export',
      ...(exportFormat ? { exportFormat } : {}),
    });
    const observe = (emit: () => boolean): boolean => {
      try {
        const current = getTelemetryCorrelationContext();
        if (
          generation !== getAnalyticsCaptureGeneration() ||
          context.appSessionId !== current.appSessionId ||
          context.episodeCorrelationId !== current.episodeCorrelationId
        )
          return false;
        return emit();
      } catch {
        return false;
      }
    };
    return {
      complete: (...args: Parameters<WorkflowOperation['complete']>) =>
        observe(() => operation.complete(...args)),
      fail: (...args: Parameters<WorkflowOperation['fail']>) =>
        observe(() => operation.fail(...args)),
      cancel: (...args: Parameters<WorkflowOperation['cancel']>) =>
        observe(() => operation.cancel(...args)),
    };
  } catch {
    return undefined;
  }
}
