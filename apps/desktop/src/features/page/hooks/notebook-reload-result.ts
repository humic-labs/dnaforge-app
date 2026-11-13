import {
  notebookErrorCode,
  type NOTEBOOK_RELOAD_STAGES,
} from '../../../shared/desktop-failure-telemetry';

export function notebookReloadResultProperties(
  outcome: 'failed' | 'recovered',
  observation: {
    error?: unknown;
    stage?: (typeof NOTEBOOK_RELOAD_STAGES)[number];
    operationId?: string;
  } = {}
) {
  const failed = outcome === 'failed';
  const reason = failed ? notebookErrorCode(observation.error) : 'none';
  return {
    feature_area: 'reliability',
    workflow_status: failed ? 'failed' : 'completed',
    version: 2,
    outcome,
    success: !failed,
    error_class: reason.toLowerCase(),
    reload_stage: observation.stage ?? 'unknown',
    reload_reason: reason,
    ...(observation.operationId ? { operation_id: observation.operationId } : {}),
  };
}
