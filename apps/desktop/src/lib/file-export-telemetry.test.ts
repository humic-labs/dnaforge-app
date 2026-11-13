import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sanitizeClosedBetaProperties } from '../shared/analytics-allowlist';

const capture = vi.hoisted(() => ({
  generation: 1,
  session: '550e8400-e29b-41d4-a716-446655440001',
  episode: '550e8400-e29b-41d4-a716-446655440002',
  ready: true,
  throws: false,
  events: [] as Array<{ event: string; properties: Record<string, unknown> }>,
}));
vi.mock('./analytics', () => ({
  getAnalyticsCaptureGeneration: () => capture.generation,
  trackRendererEvent: (event: string, properties: Record<string, unknown>) => {
    if (capture.throws) throw new Error('PRIVATE_OBSERVER_FAILURE');
    if (!capture.ready) return false;
    capture.events.push({ event, properties });
    return true;
  },
  isAnalyticsIdentityIdentified: () => true,
  getMeaningfulActivityAuthority: () => ({
    actorKind: 'external',
    executionMode: 'interactive',
    impersonated: false,
  }),
  getAnalyticsIdentifiedAccountId: () => null,
  subscribeAnalyticsCaptureReady: () => () => {},
}));
vi.mock('./telemetry-correlation', () => ({
  getTelemetryCorrelationContext: () => ({
    appSessionId: capture.session,
    episodeCorrelationId: capture.episode,
  }),
}));

import { beginFileExport } from './file-export-telemetry';

function begin() {
  const operation = beginFileExport();
  if (!operation) throw new Error('Expected an export operation');
  return operation;
}
const workflows = () => capture.events.filter(({ event }) => event === 'workflow_action_observed');
const activities = () =>
  capture.events.filter(({ event }) => event === 'meaningful_activity_completed');

describe('file export handler telemetry', () => {
  beforeEach(() => {
    capture.generation = 1;
    capture.session = '550e8400-e29b-41d4-a716-446655440001';
    capture.episode = '550e8400-e29b-41d4-a716-446655440002';
    capture.ready = true;
    capture.throws = false;
    capture.events = [];
  });

  it('stamps the export format on both ends of the export', () => {
    const operation = beginFileExport('markdown');
    expect(operation?.complete({ status: 'completed' })).toBe(true);
    expect(workflows().map(({ properties }) => properties.export_format)).toEqual([
      'markdown',
      'markdown',
    ]);
    for (const { properties } of workflows()) {
      expect(sanitizeClosedBetaProperties(properties)).toMatchObject({ export_format: 'markdown' });
    }
  });

  it('joins cancellation to its handler and admits only one terminal', () => {
    const operation = begin();
    expect(operation.cancel({ status: 'cancelled' })).toBe(true);
    expect(operation.complete({ status: 'saved' })).toBe(false);
    expect(workflows()).toHaveLength(2);
    expect(workflows()[1].properties).toMatchObject({
      action_phase: 'cancel',
      workflow_status: 'cancelled',
      success: false,
      action_id: workflows()[0].properties.action_id,
    });
    expect(activities()).toEqual([]);
  });

  it('retains a positive saved-result control through the actual workflow publisher and policy', () => {
    const operation = begin();
    expect(operation.complete({ status: 'saved' })).toBe(true);
    expect(workflows()).toHaveLength(2);
    expect(activities()).toHaveLength(1);
    for (const { properties } of capture.events) {
      expect(sanitizeClosedBetaProperties(properties)).toMatchObject(properties);
    }
  });

  it.each([
    'export_browser_requested_after_dialog_failure',
    'export_browser_requested_after_write_failure',
  ] as const)('retains %s as a request without qualifying completed activity', (outcomeKind) => {
    const operation = begin();
    expect(
      operation.complete({
        status: 'needs_action',
        outcomeKind,
        valueDelivered: false,
        usableResult: false,
      })
    ).toBe(true);
    expect(workflows()).toHaveLength(2);
    expect(workflows()[1].properties).toMatchObject({
      workflow_status: 'needs_action',
      outcome_kind: outcomeKind,
      value_delivered: false,
      usable_result: false,
    });
    expect(sanitizeClosedBetaProperties(workflows()[1].properties)).toMatchObject(
      workflows()[1].properties
    );
    expect(activities()).toEqual([]);
  });

  it('never backfills a start refused before capture becomes available', () => {
    capture.ready = false;
    const operation = begin();
    capture.ready = true;
    expect(operation.complete({ status: 'saved' })).toBe(false);
    expect(capture.events).toEqual([]);
  });

  it.each(['generation', 'session', 'episode'] as const)(
    'retires a late export result after %s changes',
    (kind) => {
      const operation = begin();
      if (kind === 'generation') capture.generation += 1;
      else capture[kind] = '550e8400-e29b-41d4-a716-446655440003';
      expect(operation.complete({ status: 'saved' })).toBe(false);
      expect(workflows()).toHaveLength(1);
      expect(activities()).toEqual([]);
    }
  );

  it('contains observer failure at handler admission', () => {
    capture.throws = true;
    expect(beginFileExport()).toBeUndefined();
  });

  it('contains observer failure at completion without a second result', () => {
    const operation = begin();
    capture.throws = true;
    expect(operation.complete({ status: 'saved' })).toBe(false);
    capture.throws = false;
    expect(operation.complete({ status: 'saved' })).toBe(false);
    expect(workflows()).toHaveLength(1);
  });
});
