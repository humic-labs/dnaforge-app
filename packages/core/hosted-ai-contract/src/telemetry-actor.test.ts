import { describe, expect, it } from 'vitest';
import {
  encodeHostedTelemetryActorContext,
  parseHostedTelemetryActorContext,
} from '@waypoint/hosted-ai-contract/telemetry-actor';

describe('bounded optional actor transport', () => {
  it('preserves the explicit runtime tuple outside strict generation JSON', () => {
    const context = {
      actor: 'ci',
      appVersion: '0.9.18',
      buildTag: 'v0.9.18',
      releaseChannel: 'prod',
      ciRunId: '40641437342',
      assertion: 'dfactor2.payload.signature',
    };
    expect(parseHostedTelemetryActorContext(encodeHostedTelemetryActorContext(context))).toEqual(
      context
    );
  });

  it.each([
    undefined,
    '',
    'not-json',
    'null',
    '[]',
    '{}',
    '{"actor":"user","prompt":"private"}',
    JSON.stringify({ actor: 'ci', assertion: 'a'.repeat(2049) }),
    JSON.stringify({ actor: 'user\ncanary' }),
    'x'.repeat(3073),
  ])('omits malformed or unbounded context %j', (value) => {
    expect(parseHostedTelemetryActorContext(value)).toBeNull();
  });
});
