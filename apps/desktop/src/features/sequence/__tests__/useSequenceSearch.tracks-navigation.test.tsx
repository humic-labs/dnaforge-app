import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSequenceSearch } from '@waypoint/workspace-editor';
import { sanitizeSdkEvent } from '@waypoint/analytics-policy';
import { __resetTelemetryCorrelationForTests } from '../../../lib/telemetry-correlation';
import { abandonOpenWorkflowActions } from '../../../lib/workflow-telemetry';
import { sanitizeClosedBetaProperties } from '../../../shared/analytics-allowlist';
import {
  CLOSED_BETA_EVENT_PROPERTIES,
  CLOSED_BETA_EVENT_VERSIONS,
} from '../../../shared/analytics-registry.generated';
import { createSequenceSearchObserver } from '../sequence-search-telemetry';

beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
  sessionStorage.setItem(
    'dnaforge_telemetry_app_session_id',
    '550e8400-e29b-41d4-a716-446655440001'
  );
  sessionStorage.setItem(
    'dnaforge_telemetry_episode_correlation_id',
    '550e8400-e29b-41d4-a716-446655440002'
  );
  __resetTelemetryCorrelationForTests();
});

afterEach(() => {
  cleanup();
  abandonOpenWorkflowActions();
  vi.useRealTimers();
});

function setup() {
  let id = 10;
  const track = vi.fn((_event: string, _properties: Record<string, unknown>) => true);
  const annotations: [] = [];
  const observer = createSequenceSearchObserver({
    track,
    storePending: async () => undefined,
    createId: () => `550e8400-e29b-41d4-a716-${String(++id).padStart(12, '0')}`,
    isIdentified: () => true,
  });
  const hook = renderHook(() =>
    useSequenceSearch({ sequence: 'GGGATGACCC', annotations, onSearchStart: observer })
  );
  act(() => hook.result.current.openInMode('nucleotide'));
  act(() => hook.result.current.setQuery('ATGA'));
  act(() => vi.advanceTimersByTime(150));
  const observation = hook.result.current.navigationRequest?.observe();
  if (!observation) throw new Error('current accepted query navigation missing');
  const events = () =>
    track.mock.calls
      .filter(([name]) => name === 'sequence_search_navigation_observed')
      .map(([, properties]) => properties);
  return { ...hook, observation, events };
}

it('retains the actual Tracks arrival category and opaque parent through both production sanitizers', () => {
  const { observation, events } = setup();
  expect(observation.presented('sequence_tracks')).toBe(true);
  expect(observation.presented('sequence_tracks')).toBe(false);
  const [start, terminal] = events();
  expect(events()).toHaveLength(2);
  expect(start.sequence_search_navigation_surface).toBe('pending');
  expect(terminal).toMatchObject({
    action_id: start.action_id,
    parent_action_id: start.parent_action_id,
    action_phase: 'result',
    workflow_status: 'viewed',
    sequence_search_navigation_result: 'presented',
    sequence_search_navigation_surface: 'sequence_tracks',
  });
  const safe = sanitizeSdkEvent(
    {
      event: 'sequence_search_navigation_observed',
      properties: sanitizeClosedBetaProperties({
        ...terminal,
        query: 'PRIVATE_TRACKS_QUERY',
        position: 4,
      }),
    },
    'desktop',
    'unknown',
    CLOSED_BETA_EVENT_PROPERTIES,
    undefined,
    CLOSED_BETA_EVENT_VERSIONS
  );
  expect(safe?.properties).toMatchObject(terminal);
  expect(safe?.properties).not.toHaveProperty('query');
  expect(safe?.properties).not.toHaveProperty('position');
  expect(safe?.properties).not.toHaveProperty('value_delivered');
  expect(safe?.properties).not.toHaveProperty('usable_result');
});

it('refuses late Tracks arrival after query ownership changes', () => {
  const { result, observation, events } = setup();
  act(() => result.current.setQuery('CCCC'));
  expect(observation.presented('sequence_tracks')).toBe(false);
  expect(events().map((event) => event.action_phase)).toEqual(['start', 'cancel']);
  expect(events().at(-1)?.sequence_search_navigation_surface).toBe('pending');
});
