import { describe, expect, it } from 'vitest';
import { sanitizeClosedBetaProperties } from './analytics-allowlist';
import { notebookErrorCode } from './desktop-failure-telemetry';
import { notebookReloadResultProperties } from '../features/page/hooks/notebook-reload-result';

describe('desktop failure telemetry privacy', () => {
  it('retains renderer publication as a distinct authentication stage', () => {
    expect(
      sanitizeClosedBetaProperties({
        auth_stage: 'renderer_published',
        auth_outcome: 'failed',
        auth_reason: 'auth_not_detected',
      })
    ).toMatchObject({
      auth_stage: 'renderer_published',
      auth_outcome: 'failed',
      auth_reason: 'auth_not_detected',
    });
  });

  it('retains approved diagnostic vocabularies and excludes untrusted strings', () => {
    const safe = sanitizeClosedBetaProperties({
      notification_definition: 'native-notebook-load-failed',
      notification_variant: 'default',
      notebook_operation: 'capture-save',
      notebook_error_code: 'NOTEBOOK_EXTERNAL_CONFLICT',
      auth_vendor: 'claude',
      auth_stage: 'renderer_accepted',
      auth_reason: 'model_enrichment_failed',
      preference_stage: 'discovery',
      preference_failure_code: 'catalog-omitted',
    });
    expect(safe).toMatchObject({
      notification_definition: 'native-notebook-load-failed',
      notebook_error_code: 'NOTEBOOK_EXTERNAL_CONFLICT',
      auth_vendor: 'claude',
      preference_failure_code: 'catalog-omitted',
    });
    for (const key of Object.keys(safe)) {
      const rejected = sanitizeClosedBetaProperties({ [key]: 'PRIVATE_NOTEBOOK_PATH_OR_TOKEN' });
      expect(rejected).not.toHaveProperty(key);
    }
  });

  it('reads only a safe data code and never an exception message or accessor', () => {
    const failure = Object.defineProperties(
      {},
      {
        code: {
          get: () => {
            throw new Error('PRIVATE_CODE_ACCESS');
          },
        },
        message: {
          get: () => {
            throw new Error('PRIVATE_MESSAGE_ACCESS');
          },
        },
      }
    );
    expect(notebookErrorCode(failure)).toBe('unknown');
    expect(notebookErrorCode({ code: 'PRIVATE_PATH' })).toBe('unknown');
    expect(notebookErrorCode({ code: 'EACCES' })).toBe('EACCES');
  });

  it('distinguishes a permission failure from malformed Markdown and joins recovery', () => {
    const operationId = '3218e7ea-0afd-4fe6-a6de-a45099f3a170';
    const failed = notebookReloadResultProperties('failed', {
      error: { code: 'EACCES', message: 'PRIVATE_PATH' },
      stage: 'watch',
      operationId,
    });
    const recovered = notebookReloadResultProperties('recovered', { stage: 'reload', operationId });
    expect(failed).toMatchObject({
      error_class: 'eacces',
      reload_reason: 'EACCES',
      reload_stage: 'watch',
      operation_id: operationId,
    });
    expect(recovered).toMatchObject({
      error_class: 'none',
      reload_reason: 'none',
      operation_id: operationId,
    });
    expect(JSON.stringify([failed, recovered])).not.toContain('PRIVATE_PATH');
  });
});
