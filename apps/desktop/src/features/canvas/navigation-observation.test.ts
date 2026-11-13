// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sanitizeClosedBetaProperties } from '../../shared/analytics-allowlist';
import { MEANINGFUL_ACTIVITY_COMPLETED } from '../../shared/meaningful-activity.generated';
import { WORKFLOW_ACTION_OBSERVED } from '../../lib/workflow-telemetry';
import { sanitizeSdkEvent } from '@waypoint/analytics-policy';
import {
  CLOSED_BETA_EVENT_PROPERTIES,
  CLOSED_BETA_EVENT_VERSIONS,
} from '../../shared/analytics-registry.generated';
import {
  newCanvasNavigationOperation,
  observeCanvasNavigation,
  observeCanvasReadableGeneration,
  observeCanvasLayout,
  observeCanvasClose,
  type CanvasNavigationOutcome,
} from './navigation-observation';

type Dependencies = NonNullable<Parameters<typeof observeCanvasNavigation>[2]>;
type Track = NonNullable<Dependencies['track']>;
const ACTION = '550e8400-e29b-41d4-a716-446655440005';
const EFFECT = '550e8400-e29b-41d4-a716-446655440006';
const operation = { id: ACTION, initiatedAtMs: 100 };
const outcomes: readonly CanvasNavigationOutcome[] = [
  'accepted',
  'noop',
  'refused',
  'superseded',
  'unmounted',
  'placed',
];

function collector() {
  const track = vi.fn<Track>(() => true);
  const dependencies: Dependencies = {
    track,
    now: () => 200,
    createId: () => EFFECT,
    isIdentified: () => true,
    activityAuthority: () => ({
      actorKind: 'external',
      executionMode: 'interactive',
      impersonated: false,
    }),
  };
  return { track, dependencies };
}

afterEach(() => vi.restoreAllMocks());

describe('CV1 governed canvas selection and placement observations', () => {
  it('joins accepted intent and placement with an opaque operation without claiming readable content', () => {
    const { track, dependencies } = collector();
    observeCanvasNavigation(operation, 'accepted', dependencies);
    observeCanvasNavigation(operation, 'placed', dependencies);
    const receipts = track.mock.calls.filter(([event]) => event === WORKFLOW_ACTION_OBSERVED);
    expect(receipts).toHaveLength(2);
    expect(receipts[0][1]).toMatchObject({
      workflow: 'navigation',
      workflow_action: 'select',
      action_phase: 'result',
      workflow_status: 'selected',
      result_count: 1,
      action_id: ACTION,
      operation_id: ACTION,
    });
    expect(receipts[1][1]).toMatchObject({
      workflow: 'navigation',
      workflow_action: 'switch_tab',
      action_phase: 'commit',
      workflow_status: 'completed',
      action_id: ACTION,
      operation_id: ACTION,
    });
    expect(receipts.every(([, properties]) => !('usable_result' in properties))).toBe(true);
    expect(receipts.every(([, properties]) => !('value_delivered' in properties))).toBe(true);
  });

  it('records every canvas outcome without counting layout navigation as meaningful activity', () => {
    const { track, dependencies } = collector();
    for (const outcome of outcomes.filter((outcome) => outcome !== 'placed')) {
      expect(observeCanvasNavigation(operation, outcome, dependencies)).toBe(true);
    }
    expect(track.mock.calls.every(([event]) => event === WORKFLOW_ACTION_OBSERVED)).toBe(true);
    expect(track.mock.calls[1][1]).toMatchObject({
      workflow_action: 'select',
      workflow_status: 'completed',
      result_count: 0,
      cached: true,
    });
    expect(observeCanvasNavigation(operation, 'placed', dependencies)).toBe(true);
    expect(
      track.mock.calls.filter(([event]) => event === MEANINGFUL_ACTIVITY_COMPLETED)
    ).toHaveLength(0);
  });

  it('uses only closed fields that survive the current real sanitizer for every outcome', () => {
    const { track, dependencies } = collector();
    const localOperation = {
      ...operation,
      tabId: 'private-tab',
      paneId: 'private-pane',
      label: 'private-label',
      entityId: '/private/source.txt',
      content: 'private-content',
      layout: { private: true },
    };
    for (const outcome of outcomes) observeCanvasNavigation(localOperation, outcome, dependencies);
    for (const [, properties] of track.mock.calls) {
      expect(sanitizeClosedBetaProperties(properties)).toEqual(properties);
      expect(JSON.stringify(properties)).not.toContain('private');
      expect(
        Object.keys(properties).some((key) =>
          /(?:^|_)(?:tab|pane|entity|label|content|layout|path)(?:_|$)/.test(key)
        )
      ).toBe(false);
    }
  });

  it('does not forward malformed local correlation or fall back to a product identity', () => {
    const { track, dependencies } = collector();
    expect(observeCanvasNavigation(null, 'accepted', dependencies)).toBe(false);
    expect(
      observeCanvasNavigation({ ...operation, id: '/private/source.txt' }, 'placed', dependencies)
    ).toBe(false);
    expect(track).not.toHaveBeenCalled();
    vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
      throw new Error('unavailable');
    });
    expect(newCanvasNavigationOperation()).toBeNull();
  });

  it('contains collector refusal and exceptions at the observation boundary', () => {
    const { track, dependencies } = collector();
    track.mockReturnValue(false);
    expect(observeCanvasNavigation(operation, 'accepted', dependencies)).toBe(false);
    track.mockImplementation(() => {
      throw new Error('collector unavailable');
    });
    for (const outcome of outcomes) {
      expect(observeCanvasNavigation(operation, outcome, dependencies)).toBe(false);
    }
  });

  it.each(['readable', 'failed'] as const)(
    'joins the actual %s viewer generation through real sanitized egress without another meaningful action',
    (outcome) => {
      const { track, dependencies } = collector();
      expect(observeCanvasReadableGeneration(operation, EFFECT, outcome, dependencies)).toBe(true);
      expect(track).toHaveBeenCalledTimes(1);
      const [event, properties] = track.mock.calls[0];
      expect(event).toBe(WORKFLOW_ACTION_OBSERVED);
      expect(properties).toMatchObject({
        workflow: 'content',
        workflow_action: 'view',
        action_phase: 'result',
        workflow_status: outcome === 'readable' ? 'viewed' : 'failed',
        action_id: EFFECT,
        operation_id: ACTION,
        success: outcome === 'readable',
      });
      expect(sanitizeClosedBetaProperties(properties)).toEqual(properties);
      expect(properties).not.toHaveProperty('usable_result');
      expect(properties).not.toHaveProperty('value_delivered');
    }
  );

  it('refuses product identities as generation IDs and contains readiness collector failure', () => {
    const { track, dependencies } = collector();
    expect(
      observeCanvasReadableGeneration(operation, '/private/source.txt', 'readable', dependencies)
    ).toBe(false);
    expect(track).not.toHaveBeenCalled();
    track.mockImplementation(() => {
      throw new Error('collector unavailable');
    });
    expect(observeCanvasReadableGeneration(operation, EFFECT, 'readable', dependencies)).toBe(
      false
    );
  });

  it.each(['move', 'reorder', 'split', 'merge', 'reopen'] as const)(
    'keeps %s intent/no-op/refusal/placement closed and outside scientific or readable success',
    (kind) => {
      const { track, dependencies } = collector();
      for (const outcome of ['accepted', 'committed', 'noop', 'refused'] as const) {
        expect(observeCanvasLayout(operation, kind, outcome, dependencies)).toBe(true);
      }
      expect(track.mock.calls.every(([event]) => event === WORKFLOW_ACTION_OBSERVED)).toBe(true);
      for (const [, properties] of track.mock.calls) {
        expect(properties).toMatchObject({
          workflow: 'navigation',
          operation_id: ACTION,
          outcome_kind: `canvas_${kind}`,
        });
        expect(sanitizeClosedBetaProperties(properties)).toEqual(properties);
        expect(properties).not.toHaveProperty('usable_result');
        expect(properties).not.toHaveProperty('value_delivered');
      }
      expect(track.mock.calls[1][1]).toMatchObject({
        action_phase: 'commit',
        workflow_status: 'completed',
        result_count: 1,
      });
      expect(track.mock.calls[2][1]).toMatchObject({ cached: true, result_count: 0 });
      expect(track.mock.calls[3][1]).toMatchObject({ workflow_status: 'blocked', success: false });
    }
  );

  it('separates close choice/removal and never projects a native Save or scientific success', () => {
    const { track, dependencies } = collector();
    for (const outcome of [
      'requested',
      'save_requested',
      'discard_confirmed',
      'closed',
      'cancelled',
      'refused',
      'unmounted',
    ] as const) {
      expect(observeCanvasClose(operation, outcome, dependencies)).toBe(true);
    }
    expect(track.mock.calls).toHaveLength(7);
    expect(track.mock.calls.every(([event]) => event === WORKFLOW_ACTION_OBSERVED)).toBe(true);
    for (const [, properties] of track.mock.calls) {
      expect(sanitizeClosedBetaProperties(properties)).toEqual(properties);
      expect(properties).toMatchObject({ workflow: 'navigation', operation_id: ACTION });
      expect(properties.workflow_status).not.toBe('saved');
    }
    expect(track.mock.calls[1][1]).toMatchObject({
      outcome_kind: 'canvas_close_save',
      workflow_status: 'needs_action',
      result_count: 0,
    });
    expect(track.mock.calls[2][1]).toMatchObject({
      outcome_kind: 'canvas_close_discard',
      action_phase: 'result',
      result_count: 0,
    });
    expect(track.mock.calls[3][1]).toMatchObject({
      outcome_kind: 'canvas_close',
      action_phase: 'commit',
      result_count: 1,
    });
    expect(track.mock.calls[4][1]).toMatchObject({ workflow_status: 'cancelled', success: false });
    expect(track.mock.calls[5][1]).toMatchObject({ workflow_status: 'blocked', success: false });
    expect(track.mock.calls[6][1]).toMatchObject({
      workflow_status: 'cancelled',
      error_class: 'close_owner_unmounted',
    });
  });

  it('retains only governed fields through the actual app and shared SDK property policies', () => {
    const { track, dependencies } = collector();
    for (const outcome of outcomes) observeCanvasNavigation(operation, outcome, dependencies);
    observeCanvasReadableGeneration(operation, EFFECT, 'readable', dependencies);
    for (const kind of ['move', 'reorder', 'split', 'merge', 'reopen'] as const) {
      observeCanvasLayout(operation, kind, 'committed', dependencies);
    }
    observeCanvasClose(operation, 'save_requested', dependencies);
    observeCanvasClose(operation, 'closed', dependencies);
    for (const [event, properties] of track.mock.calls) {
      const sanitized = sanitizeClosedBetaProperties(properties);
      const egress = sanitizeSdkEvent(
        { event, properties: sanitized },
        'desktop',
        'unknown',
        CLOSED_BETA_EVENT_PROPERTIES,
        undefined,
        CLOSED_BETA_EVENT_VERSIONS
      );
      expect(egress).not.toBeNull();
      expect(egress?.properties).toMatchObject(sanitized);
      expect(JSON.stringify(egress)).not.toContain('/synthetic');
    }
  });
});
