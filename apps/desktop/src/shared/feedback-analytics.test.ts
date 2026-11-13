import { describe, expect, it } from 'vitest';
import { sanitizeSdkEvent } from '@waypoint/analytics-policy';
import { sanitizeClosedBetaProperties } from './analytics-allowlist';
import {
  CLOSED_BETA_EVENT_PROPERTIES,
  CLOSED_BETA_EVENT_VERSIONS,
} from './analytics-registry.generated';

describe('feedback closed egress contract', () => {
  it('retains stage/correlation/clocks and strips body, keys, paths and unknown content', () => {
    const sanitized = sanitizeSdkEvent(
      {
        event: 'feedback_stage',
        properties: sanitizeClosedBetaProperties({
          feature_area: 'settings',
          feedback_stage: 'backend_accepted',
          feedback_reason: 'none',
          feedback_origin: 'restored',
          feedback_origin_class: 'synthetic',
          feedback_attempt_bucket: 'retry',
          operation_id: '33690000-0000-4000-8000-000000000001',
          origin_started_at_ms: 1000,
          occurred_at_ms: 2000,
          emitted_at_ms: 2100,
          message: 'harmless forbidden message decoy',
          target_text: 'harmless forbidden text decoy',
          key: 'z',
          source_path: '/private/harmless-decoy',
          channels: [1, 2, 3, 4],
          consentScope: 'harmless forbidden nonce',
        }),
      },
      'desktop',
      'unknown',
      CLOSED_BETA_EVENT_PROPERTIES,
      undefined,
      CLOSED_BETA_EVENT_VERSIONS
    );
    expect(sanitized?.properties).toMatchObject({
      feedback_stage: 'backend_accepted',
      feedback_origin: 'restored',
      operation_id: '33690000-0000-4000-8000-000000000001',
      origin_started_at_ms: 1000,
      occurred_at_ms: 2000,
      emitted_at_ms: 2100,
    });
    for (const key of ['message', 'target_text', 'key', 'source_path', 'channels', 'consentScope'])
      expect(sanitized?.properties).not.toHaveProperty(key);
    expect(JSON.stringify(sanitized)).not.toContain('harmless');
  });
});
