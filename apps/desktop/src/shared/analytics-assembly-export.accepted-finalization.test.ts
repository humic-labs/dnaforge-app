import { describe, expect, it } from 'vitest';
import { sanitizeClosedBetaProperties } from './analytics-allowlist';
import { CLOSED_BETA_EVENT_PROPERTIES } from './analytics-registry.generated';

describe(' assembly export telemetry contract', () => {
  it('registers the bounded tool_error reason property', () => {
    expect(CLOSED_BETA_EVENT_PROPERTIES.tool_error).toContain('reason_code');
  });

  it.each([
    'stale_design', 'draft_required', 'output_exists', 'precondition_failed',
    'filesystem_error', 'projection_failed', 'export_failed',
  ])('retains the allowlisted reason %s', (reason) => {
    expect(sanitizeClosedBetaProperties({ reason_code: reason })).toEqual({ reason_code: reason });
  });

  it.each(['/Users/private/project.gb', 'EACCES: private path', 'unexpected_reason'])('drops private or unregistered reason %s', (reason) => {
    expect(sanitizeClosedBetaProperties({ reason_code: reason })).toEqual({});
  });
});
