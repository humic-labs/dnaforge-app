import { describe, expect, it } from 'vitest';
import { parseNotebookMarkdown } from '../../../db/notebook-markdown-codec';
import { sanitizeClosedBetaProperties } from '../../../shared/analytics-allowlist';
import { notebookReloadResultProperties } from './notebook-reload-result';

describe('notebook reload failure classification', () => {
  it('does not claim an unknown reload failure was invalid Markdown', () => {
    expect(notebookReloadResultProperties('failed')).toMatchObject({ error_class: 'unknown' });
  });
});

it('keeps the safe parser code for malformed notebook Markdown', () => {
  const markdown = '<!-- dnaforge:notebook {not-json} -->\n';
  try {
    parseNotebookMarkdown({ markdown });
  } catch (error) {
    const operationId = '12345678-1234-4234-8234-123456789abc';
    const properties = notebookReloadResultProperties('failed', {
      error,
      stage: 'external-change',
      operationId,
    });
    expect(sanitizeClosedBetaProperties(properties)).toEqual({
      feature_area: 'reliability',
      workflow_status: 'failed',
      version: 2,
      outcome: 'failed',
      success: false,
      error_class: 'notebook_markdown_invalid',
      reload_stage: 'external-change',
      reload_reason: 'NOTEBOOK_MARKDOWN_INVALID',
      operation_id: operationId,
    });
    return;
  }
  expect.unreachable('Malformed notebook Markdown unexpectedly parsed');
});
