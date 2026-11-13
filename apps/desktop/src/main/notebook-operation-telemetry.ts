import { randomUUID } from 'node:crypto';
import { trackEvent } from './analytics';
import { NOTEBOOK_OPERATION_KINDS, notebookErrorCode } from '../shared/desktop-failure-telemetry';
import { NativeDocumentCommandError } from '../shared/native-document-error';
import type { NotebookDocumentSnapshot } from '../shared/notebook-document';

const operations = new Set<string>(NOTEBOOK_OPERATION_KINDS);
const lifecycle = new Set([
  'inspect-copy',
  'create',
  'capture-save',
  'await-save',
  'save',
  'discard',
  'reload',
  'restore-recovery',
  'retain-legacy-recovery',
  'keep-local',
]);

export async function observeNotebookCommand(
  requestedOperation: string,
  run: () => Promise<NotebookDocumentSnapshot>
): Promise<NotebookDocumentSnapshot> {
  const operation = operations.has(requestedOperation) ? requestedOperation : 'unknown';
  const operationId = randomUUID();
  const emit = (properties: Record<string, unknown>) => {
    try {
      trackEvent('notebook_operation_observed', {
        feature_area: 'reliability',
        operation_id: operationId,
        occurred_at_ms: Date.now(),
        notebook_operation: operation,
        ...properties,
      });
    } catch {}
  };
  if (lifecycle.has(operation)) emit({ notebook_phase: 'started' });
  try {
    const snapshot = await run();
    if (lifecycle.has(operation))
      emit({
        notebook_phase: 'completed',
        notebook_error_code: 'none',
        notebook_dirty: snapshot.dirty,
        notebook_saving: snapshot.saving,
        notebook_recovery: Boolean(snapshot.recovery),
        notebook_read_only: snapshot.readOnly,
      });
    return snapshot;
  } catch (error) {
    emit({
      notebook_phase: 'failed',
      notebook_error_code: notebookErrorCode(error),
      notebook_state_changed:
        error instanceof NativeDocumentCommandError
          ? error.stateChanged === true
            ? 'yes'
            : error.stateChanged === false
              ? 'no'
              : 'unknown'
          : 'unknown',
    });
    throw error;
  }
}
