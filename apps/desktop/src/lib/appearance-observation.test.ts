// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { sanitizeClosedBetaProperties } from '../shared/analytics-allowlist';
import { sanitizeSdkEvent } from '@waypoint/analytics-policy';
import {
  CLOSED_BETA_EVENT_PROPERTIES,
  CLOSED_BETA_EVENT_VERSIONS,
} from '../shared/analytics-registry.generated';
import { beginAppearanceObservation, observeAppearanceDecision } from './appearance-observation';
import { beginTelemetryEpisode } from './telemetry-correlation';
const authority = vi.hoisted(() => {
  const context: { ready: boolean; account: string | null } = { ready: true, account: null };
  return {
    ...context,
    capture: vi.fn<(event: string, properties: Record<string, unknown>) => boolean>(() => true),
    listeners: new Set<() => void>(),
  };
});
vi.mock('./analytics', () => ({
  trackRendererEvent: authority.capture,
  isAnalyticsCaptureReady: () => authority.ready,
  getAnalyticsIdentifiedAccountId: () => authority.account,
  subscribeAnalyticsCaptureReady: (listener: () => void) => {
    authority.listeners.add(listener);
    return () => {
      authority.listeners.delete(listener);
    };
  },
  isAnalyticsIdentityIdentified: () => false,
  getMeaningfulActivityAuthority: () => ({
    actorKind: 'test',
    executionMode: 'automated',
    impersonated: false,
  }),
}));
beforeEach(() => {
  authority.ready = true;
  authority.account = null;
  authority.capture.mockReset().mockReturnValue(true);
  authority.listeners.clear();
});
afterEach(() => {
  expect(authority.listeners.size).toBe(0);
});
describe('real appearance/workflow producer and app/SDK policy', () => {
  it.each([
    'appearance_theme',
    'appearance_display',
    'appearance_webgl',
    'appearance_palette',
  ] as const)(
    'admits bounded %s lifecycle stages with one terminal and no meaningful scientific qualification',
    (category) => {
      const operation = beginAppearanceObservation(category);
      operation.stage('preference_accepted');
      operation.stage('preference_applied');
      operation.end('preference_persisted');
      operation.end('preference_recovered');
      operation.stage('preference_applied');
      const calls = authority.capture.mock.calls;
      expect(calls.filter(([, p]) => p.action_phase === 'result')).toHaveLength(1);
      expect(calls.filter(([event]) => event === 'meaningful_activity_completed')).toHaveLength(0);
      expect(new Set(calls.map(([, p]) => p.action_id)).size).toBe(1);
      for (const [event, properties] of calls) {
        const safe = sanitizeClosedBetaProperties(properties);
        expect(safe).toEqual(properties);
        expect(
          sanitizeSdkEvent(
            { event, properties: safe },
            'desktop',
            'unknown',
            CLOSED_BETA_EVENT_PROPERTIES,
            undefined,
            CLOSED_BETA_EVENT_VERSIONS
          )?.properties
        ).toMatchObject(safe);
        for (const key of [
          'value',
          'choice',
          'storage_key',
          'preference_value',
          'path',
          'key',
          'keystrokes',
          'raw_error',
        ])
          expect(properties).not.toHaveProperty(key);
      }
    }
  );
  it.each(['capture', 'account', 'episode'] as const)(
    'revokes old projections on %s change before later completion',
    (boundary) => {
      const operation = beginAppearanceObservation('appearance_display');
      authority.capture.mockClear();
      if (boundary === 'capture') {
        authority.ready = false;
        for (const notify of authority.listeners) notify();
        authority.ready = true;
      } else if (boundary === 'account') authority.account = '550e8400-e29b-41d4-a716-446655440000';
      else beginTelemetryEpisode();
      operation.stage('preference_applied');
      operation.end('preference_persisted');
      expect(authority.capture).not.toHaveBeenCalled();
    }
  );
  it.each([
    ['user', 'update', 'direct'],
    ['retry', 'run', 'direct'],
    ['system', 'update', 'projection'],
    ['restore', 'restore', 'projection'],
  ] as const)(
    'keeps %s origin separate from a fixed user change',
    (origin, action, workflowOrigin) => {
      const operation = beginAppearanceObservation('appearance_theme', origin);
      operation.stage('preference_applied');
      operation.end(origin === 'restore' ? 'preference_restored' : 'preference_system_applied');
      expect(
        authority.capture.mock.calls.every(
          ([, properties]) =>
            properties.workflow_action === action && properties.workflow_origin === workflowOrigin
        )
      ).toBe(true);
    }
  );
  it('does not promote refused starts, contains throwing collectors and separates no-op/refusal from accepted change', () => {
    authority.capture.mockReturnValueOnce(false);
    const operation = beginAppearanceObservation('appearance_theme');
    operation.stage('preference_accepted');
    operation.end('preference_persisted');
    expect(authority.capture).toHaveBeenCalledTimes(1);
    authority.capture.mockImplementation(() => {
      throw new Error('sender unavailable');
    });
    const failedCollector = beginAppearanceObservation('appearance_theme');
    expect(() => {
      failedCollector.stage('preference_applied');
      failedCollector.end('preference_persisted');
    }).not.toThrow();
    authority.capture.mockReset().mockReturnValue(true);
    observeAppearanceDecision('appearance_theme', 'preference_noop');
    observeAppearanceDecision('appearance_theme', 'preference_refused');
    expect(authority.capture.mock.calls.every(([, p]) => p.action_phase === 'commit')).toBe(true);
    expect(
      authority.capture.mock.calls.some(([, p]) => p.outcome_kind === 'preference_accepted')
    ).toBe(false);
  });
});
