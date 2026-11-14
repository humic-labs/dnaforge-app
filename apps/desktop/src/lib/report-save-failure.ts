import { trackRendererEvent } from './analytics';
import { saveFailureProperties } from '../shared/save-failure-diagnostics';

export function reportSaveFailure(
  prefix: string,
  context: Record<string, unknown>,
  error: unknown,
  options?: { notebookPhase: 'autosave' | 'manual' | 'flush' }
): void {
  try {
    console.error(prefix, context, error);
  } catch {}
  try {
    const properties = saveFailureProperties(error, crypto.randomUUID());
    trackRendererEvent('workflow_action_observed', {
      ...properties,
      ...(options
        ? {
            workflow: 'content',
            outcome_kind: 'notebook_save_failed',
            error_class: `notebook_${options.notebookPhase}_${properties.error_class}`,
          }
        : {}),
    });
  } catch {}
}
