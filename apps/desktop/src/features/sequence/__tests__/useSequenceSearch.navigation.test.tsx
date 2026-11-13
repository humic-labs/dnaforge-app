import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSequenceSearch } from '@waypoint/workspace-editor';
import { sanitizeSdkEvent } from '@waypoint/analytics-policy';
import * as correlation from '../../../lib/telemetry-correlation';
import { abandonOpenWorkflowActions } from '../../../lib/workflow-telemetry';
import { sanitizeClosedBetaProperties } from '../../../shared/analytics-allowlist';
import {
  CLOSED_BETA_EVENT_PROPERTIES,
  CLOSED_BETA_EVENT_VERSIONS,
} from '../../../shared/analytics-registry.generated';
import { createSequenceSearchObserver } from '../sequence-search-telemetry';

const capture = vi.hoisted(() => ({ generation: 0 }));
vi.mock('../../../lib/analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/analytics')>()),
  getAnalyticsCaptureGeneration: () => capture.generation,
}));
const APP = '550e8400-e29b-41d4-a716-446655440001';
const A = '550e8400-e29b-41d4-a716-446655440002';
const B = '550e8400-e29b-41d4-a716-446655440003';
const annotations: [] = [];
const EVENT = 'sequence_search_navigation_observed';

function setup(sequence = 'GGGATGACCC') {
  let id = 10;
  const track = vi.fn((_event: string, _properties: Record<string, unknown>) => true);
  const storePending = vi.fn(async () => undefined);
  const observer = createSequenceSearchObserver({
    track,
    storePending,
    createId: () => `550e8400-e29b-41d4-a716-${String(++id).padStart(12, '0')}`,
    now: () => Date.now(),
    isIdentified: () => true,
  });
  const hook = renderHook(
    ({ sequence }) => useSequenceSearch({ sequence, annotations, onSearchStart: observer }),
    { initialProps: { sequence } }
  );
  act(() => hook.result.current.openInMode('nucleotide'));
  function query(value = 'ATGA') {
    act(() => hook.result.current.setQuery(value));
    act(() => vi.advanceTimersByTime(150));
  }
  function request() {
    const value = hook.result.current.navigationRequest;
    expect(value).toBeDefined();
    if (!value) throw new Error('Expected a current navigation request');
    return value;
  }
  function observe() {
    const value = request().observe();
    expect(value).toBeDefined();
    if (!value) throw new Error('Expected an accepted navigation observation');
    return value;
  }
  const events = () =>
    track.mock.calls.filter(([event]) => event === EVENT).map(([, properties]) => properties);
  return { ...hook, query, request, observe, events, track, storePending };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  capture.generation = 0;
  sessionStorage.clear();
  sessionStorage.setItem('dnaforge_telemetry_app_session_id', APP);
  sessionStorage.setItem('dnaforge_telemetry_episode_correlation_id', A);
  correlation.__resetTelemetryCorrelationForTests();
});
afterEach(() => {
  abandonOpenWorkflowActions();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Find result navigation ownership and accepted query joins', () => {
  it('keeps computation separate from one accepted presentation terminal', () => {
    const o = setup();
    o.query();
    expect(o.events()).toEqual([]);
    const request = o.request();
    expect(request).toMatchObject({ position: 4, range: { start: 3, end: 6 } });
    o.rerender({ sequence: 'GGGATGACCC' });
    expect(o.request()).toBe(request);
    const observation = o.observe();
    expect(request.observe()).toBeUndefined();
    expect(o.events().map((p) => p.action_phase)).toEqual(['start']);
    vi.setSystemTime(1550);
    expect(observation.presented()).toBe(true);
    expect(observation.presented()).toBe(false);
    observation.cancel();
    const [start, terminal] = o.events();
    expect(terminal).toMatchObject({
      action_id: start.action_id,
      parent_action_id: o.track.mock.calls[0][1].action_id,
      workflow_action: 'view',
      action_phase: 'result',
      workflow_status: 'viewed',
      sequence_search_navigation_result: 'presented',
      sequence_search_navigation_surface: 'sequence_canvas',
      duration_ms: 400,
      app_session_id: APP,
      episode_correlation_id: A,
    });
    expect(start.action_id).not.toBe(terminal.parent_action_id);
    expect(o.events()).toHaveLength(2);
    expect(o.storePending).not.toHaveBeenCalled();
  });

  it('creates distinct same-target owners for single-match next, previous and activation', () => {
    const o = setup();
    o.query();
    const requests = [o.request()];
    const first = o.observe();
    act(() => o.result.current.next());
    requests.push(o.request());
    expect(first.presented()).toBe(false);
    o.observe().presented();
    act(() => o.result.current.prev());
    requests.push(o.request());
    o.observe().presented();
    act(() => {
      o.result.current.goToMatch(0);
      o.result.current.releaseActiveHighlight();
    });
    requests.push(o.request());
    expect(o.result.current.scrollToPosition).toBeNull();
    o.observe().presented();
    expect(new Set(requests).size).toBe(4);
    expect(requests.map((r) => r.position)).toEqual([4, 4, 4, 4]);
    expect(o.events().map((p) => p.action_phase)).toEqual([
      'start',
      'cancel',
      'start',
      'result',
      'start',
      'result',
      'start',
      'result',
    ]);
    expect(
      new Set(
        o
          .events()
          .filter((p) => p.action_phase === 'start')
          .map((p) => p.action_id)
      ).size
    ).toBe(4);
  });

  it.each(['query', 'close', 'mode', 'unmount'] as const)(
    'retires a held navigation on %s and refuses late presentation',
    (change) => {
      const o = setup();
      o.query();
      const request = o.request();
      const pending = o.observe();
      act(() => {
        if (change === 'query') o.result.current.setQuery('CCCC');
        if (change === 'close') o.result.current.close();
        if (change === 'mode') o.result.current.setMode('aminoAcid');
      });
      if (change === 'unmount') o.unmount();
      expect(pending.presented()).toBe(false);
      expect(request.observe()).toBeUndefined();
      expect(o.events().map((p) => p.action_phase)).toEqual(['start', 'cancel']);
    }
  );

  it('retires the old-source packet even when the replacement has the same target', () => {
    const o = setup();
    o.query();
    const old = o.observe();
    const request = o.request();
    o.rerender({ sequence: 'GGGATGACCCC' });
    expect(o.request()).not.toBe(request);
    expect(o.request().position).toBe(request.position);
    expect(old.presented()).toBe(false);
    o.observe().presented();
    expect(o.events().map((p) => p.action_phase)).toEqual(['start', 'cancel', 'start', 'result']);
    expect(o.events()[2].parent_action_id).not.toBe(o.events()[0].parent_action_id);
  });

  it('preserves batched navigation order and rejects a callback retained from older results', () => {
    const o = setup('ATGACCATGACCATGACCCCC');
    o.query();
    const oldNext = o.result.current.next;
    act(() => {
      o.result.current.next();
      o.result.current.next();
    });
    expect(o.result.current.activeIndex).toBe(2);
    expect(o.request().position).toBe(13);
    o.query('CCC');
    const replacement = o.request();
    act(() => oldNext());
    expect(o.request()).toBe(replacement);
    expect(o.result.current.activeIndex).toBe(0);
  });

  it.each(['start', 'result'] as const)('admits no child after refused query %s', (phase) => {
    const o = setup();
    o.track.mockImplementation((_event, properties) => properties.action_phase !== phase);
    o.query();
    expect(o.result.current.matchCount).toBe(1);
    expect(o.request().observe()).toBeUndefined();
    expect(o.events()).toEqual([]);
  });

  it('consumes a refused child start without a later terminal', () => {
    const o = setup();
    o.query();
    o.track.mockImplementation((event) => event !== EVENT);
    expect(o.request().observe()).toBeUndefined();
    expect(o.request().observe()).toBeUndefined();
    expect(o.events().map((p) => p.action_phase)).toEqual(['start']);
    expect(abandonOpenWorkflowActions()).toBe(0);
  });

  it.each(['consent', 'episode_round_trip', 'session'] as const)(
    'fences both a held child and later child admission across %s',
    (change) => {
      const o = setup();
      o.query();
      const pending = o.observe();
      if (change === 'consent') capture.generation += 2;
      if (change === 'episode_round_trip') {
        correlation.setEpisodeCorrelationId(B);
        correlation.setEpisodeCorrelationId(A);
      }
      if (change === 'session') {
        sessionStorage.setItem('dnaforge_telemetry_app_session_id', B);
        correlation.__resetTelemetryCorrelationForTests();
      }
      expect(pending.presented()).toBe(false);
      act(() => o.result.current.next());
      expect(o.request().observe()).toBeUndefined();
      expect(o.events().map((p) => p.action_phase)).toEqual(['start']);
      expect(abandonOpenWorkflowActions()).toBe(0);
    }
  );

  it('creates no navigation request for an empty or invalid result', () => {
    const o = setup();
    o.query('TTTT');
    expect(o.result.current.navigationRequest).toBeNull();
    o.query('PRIVATE_NEVER_SENT');
    expect(o.result.current.navigationRequest).toBeNull();
    expect(o.events()).toEqual([]);
    expect(JSON.stringify(o.track.mock.calls)).not.toContain('PRIVATE_NEVER_SENT');
  });

  it('retains only finite navigation categories and opaque joins through both production sanitizers', () => {
    const o = setup();
    o.query();
    o.observe().presented();
    for (const properties of o.events()) {
      const safe = sanitizeSdkEvent(
        {
          event: EVENT,
          properties: sanitizeClosedBetaProperties({
            ...properties,
            sequence: 'PRIVATE_FIND_SEQUENCE',
            query: 'PRIVATE_FIND_QUERY',
            position: 4,
            result_count: 1,
            path: 'PRIVATE_FIND_PATH',
          }),
        },
        'desktop',
        'unknown',
        CLOSED_BETA_EVENT_PROPERTIES,
        undefined,
        CLOSED_BETA_EVENT_VERSIONS
      );
      expect(safe?.properties).toMatchObject(properties);
      expect(safe?.properties.event_version).toBe(1);
      for (const key of [
        'query',
        'sequence',
        'position',
        'result_count',
        'path',
        'value_delivered',
        'usable_result',
      ])
        expect(safe?.properties).not.toHaveProperty(key);
      expect(JSON.stringify(safe)).not.toContain('PRIVATE_FIND');
    }
    expect(o.storePending).not.toHaveBeenCalled();
  });
});
