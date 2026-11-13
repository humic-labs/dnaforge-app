import { describe, expect, it } from 'vitest';
import { sanitizeSdkEvent } from '@waypoint/analytics-policy';
import { sanitizeClosedBetaProperties } from './analytics-allowlist';
import {
  CLOSED_BETA_EVENT_PROPERTIES,
  CLOSED_BETA_EVENT_VERSIONS,
} from './analytics-registry.generated';

describe('Benchling origin and delivery clocks at SDK egress', () => {
  it.each([
    'benchling_migration_attempt_started',
    'benchling_migration_attempt_finished',
    'benchling_migration_issue_summary',
  ])('retains the independent delivery clock for %s without content', (event) => {
    const result = sanitizeSdkEvent(
      {
        event,
        properties: sanitizeClosedBetaProperties({
          feature_area: 'import',
          operation: 'workspace_append',
          attempt_correlation_id: '33640000-0000-4000-8000-000000000001',
          emitted_at_ms: 2100,
          message: 'PRIVATE_BENCHLING_BODY_902',
          source_path: '/private/benchling-902',
          consentScope: 'PRIVATE_ORIGIN_902',
        }),
      },
      'desktop',
      'unknown',
      CLOSED_BETA_EVENT_PROPERTIES,
      undefined,
      CLOSED_BETA_EVENT_VERSIONS
    );
    expect(result?.properties.emitted_at_ms).toBe(2100);
    expect(result?.properties.attempt_correlation_id).toBe('33640000-0000-4000-8000-000000000001');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_BENCHLING_BODY_902');
    expect(JSON.stringify(result)).not.toContain('/private/benchling-902');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_ORIGIN_902');
  });
});
