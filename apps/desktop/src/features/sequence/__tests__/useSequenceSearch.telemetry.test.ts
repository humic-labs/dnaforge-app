import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSequenceSearch } from '@waypoint/workspace-editor';
import { createSequenceSearchObserver } from '../sequence-search-telemetry';
import { sanitizeClosedBetaProperties } from '../../../shared/analytics-allowlist';

const annotations: [] = [];
const sequence = 'ATGATGATGATGATGATGATG';

function observation(accepted = true) {
  const track = vi.fn((_event: string, _properties: Record<string, unknown>) => accepted);
  let id = 0;
  const onSearchStart = createSequenceSearchObserver({
    track,
    createId: () => `550e8400-e29b-41d4-a716-${String(++id).padStart(12, '0')}`,
    now: () => Date.now(),
    isIdentified: () => false,
  });
  return {
    track,
    onSearchStart,
    properties: () => track.mock.calls.map(([, properties]) => properties),
  };
}

describe('sequence query generation telemetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('joins one accepted query generation to one computed result without content or raw counts', () => {
    const observed = observation();
    const { result } = renderHook(() =>
      useSequenceSearch({ sequence, annotations, onSearchStart: observed.onSearchStart })
    );
    act(() => result.current.openInMode('nucleotide'));
    act(() => result.current.setQuery('ATG'));
    expect(observed.track).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(150));
    const [start, terminal] = observed.properties();
    expect(observed.track).toHaveBeenCalledTimes(2);
    expect(start.action_phase).toBe('start');
    expect(terminal).toMatchObject({
      action_phase: 'result',
      action_id: start.action_id,
      sequence_search_result: 'matches',
      sequence_search_match_count_bucket: '2_10',
    });
    expect(terminal.effect_id).not.toBe(start.action_id);
    expect(JSON.stringify(observed.properties())).not.toContain('ATG');
    for (const properties of observed.properties()) {
      expect(properties).not.toHaveProperty('result_count');
      expect(properties).not.toHaveProperty('query');
      expect(properties).not.toHaveProperty('sequence');
      expect(properties).not.toHaveProperty('start');
      expect(properties).not.toHaveProperty('end');
    }
  });

  it('preserves query-generation joins through the production property sanitizer', () => {
    const observed = observation();
    const { result } = renderHook(() =>
      useSequenceSearch({ sequence, annotations, onSearchStart: observed.onSearchStart })
    );
    act(() => result.current.openInMode('nucleotide'));
    act(() => result.current.setQuery('ATG'));
    act(() => vi.advanceTimersByTime(150));
    const [start, terminal] = observed.properties().map(sanitizeClosedBetaProperties);
    expect(start).toMatchObject({
      action_phase: 'start',
      sequence_search_result: 'pending',
      sequence_search_query_length_bucket: '2_10',
      sequence_search_sequence_length_bucket: '11_100',
    });
    expect(terminal).toMatchObject({
      action_phase: 'result',
      action_id: start.action_id,
      sequence_search_source: 'in_memory',
      sequence_search_mode: 'nucleotide',
      sequence_search_topology: 'linear',
      sequence_search_result: 'matches',
      sequence_search_match_count_bucket: '2_10',
    });
    expect(start.action_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(terminal.effect_id).toMatch(/^[0-9a-f-]{36}$/);
    for (const properties of [start, terminal]) {
      expect(properties).not.toHaveProperty('result_count');
      expect(properties).not.toHaveProperty('queryLength');
      expect(properties).not.toHaveProperty('sequenceLength');
    }
  });

  it('settles a superseded query before the replacement starts and never revives it', () => {
    const observed = observation();
    const { result } = renderHook(() =>
      useSequenceSearch({ sequence, annotations, onSearchStart: observed.onSearchStart })
    );
    act(() => result.current.openInMode('nucleotide'));
    act(() => result.current.setQuery('ATG'));
    act(() => result.current.setQuery('CCCC'));
    act(() => vi.advanceTimersByTime(150));
    const properties = observed.properties();
    expect(properties.map((p) => p.action_phase)).toEqual(['start', 'cancel', 'start', 'result']);
    expect(properties[1]).toMatchObject({
      action_id: properties[0].action_id,
      sequence_search_result: 'superseded',
    });
    expect(properties[2].action_id).not.toBe(properties[0].action_id);
    expect(properties[3]).toMatchObject({
      action_id: properties[2].action_id,
      sequence_search_result: 'empty',
      sequence_search_match_count_bucket: '0',
    });
  });

  it('clears resolved navigation while measuring the replacement query', () => {
    const observed = observation();
    const { result } = renderHook(() =>
      useSequenceSearch({ sequence, annotations, onSearchStart: observed.onSearchStart })
    );
    act(() => result.current.openInMode('nucleotide'));
    act(() => result.current.setQuery('ATG'));
    act(() => vi.advanceTimersByTime(150));
    expect(result.current.matchCount).toBeGreaterThan(0);
    expect(result.current.scrollToPosition).not.toBeNull();

    act(() => result.current.setQuery('CCCC'));
    act(() => {
      result.current.next();
      result.current.prev();
      result.current.goToMatch(0);
    });
    expect(result.current.matches).toEqual([]);
    expect(result.current.activeHighlightRange).toBeNull();
    expect(result.current.scrollToPosition).toBeNull();
    expect(observed.properties().map((p) => p.action_phase)).toEqual(['start', 'result', 'start']);

    act(() => vi.advanceTimersByTime(150));
    const properties = observed.properties();
    expect(properties.map((p) => p.action_phase)).toEqual(['start', 'result', 'start', 'result']);
    expect(properties[3]).toMatchObject({
      action_id: properties[2].action_id,
      sequence_search_result: 'empty',
    });
    expect(result.current.matches).toEqual([]);
    expect(result.current.scrollToPosition).toBeNull();
  });

  it('cancels the pending linear generation when topology changes without reviving its timer', () => {
    const observed = observation();
    const { result, rerender } = renderHook(
      ({ circular }) =>
        useSequenceSearch({
          sequence,
          annotations,
          circular,
          onSearchStart: observed.onSearchStart,
        }),
      { initialProps: { circular: false } }
    );
    act(() => result.current.openInMode('nucleotide'));
    act(() => result.current.setQuery('ATG'));
    rerender({ circular: true });
    act(() => vi.advanceTimersByTime(150));
    const properties = observed.properties();
    expect(properties.map((p) => p.action_phase)).toEqual(['start', 'cancel', 'start', 'result']);
    expect(properties[1]).toMatchObject({
      action_id: properties[0].action_id,
      sequence_search_topology: 'linear',
      sequence_search_result: 'source_changed',
    });
    expect(properties[3]).toMatchObject({
      action_id: properties[2].action_id,
      sequence_search_topology: 'circular',
      sequence_search_result: 'matches',
    });
    expect(result.current.matchCount).toBeGreaterThan(0);
  });

  it('does not publish a pending old-source completion after an input revision', () => {
    const observed = observation();
    const { result, rerender } = renderHook(
      ({ sequence }) =>
        useSequenceSearch({ sequence, annotations, onSearchStart: observed.onSearchStart }),
      { initialProps: { sequence } }
    );
    act(() => result.current.openInMode('nucleotide'));
    act(() => result.current.setQuery('ATG'));
    rerender({ sequence: 'CCCCCCCCCCCCCCCCCCCCC' });
    act(() => vi.advanceTimersByTime(150));
    const properties = observed.properties();
    expect(properties.map((p) => p.action_phase)).toEqual(['start', 'cancel', 'start', 'result']);
    expect(properties[1]).toMatchObject({
      action_id: properties[0].action_id,
      sequence_search_result: 'source_changed',
    });
    expect(properties[3]).toMatchObject({
      action_id: properties[2].action_id,
      sequence_search_result: 'empty',
    });
    expect(result.current.matches).toEqual([]);
    expect(result.current.activeHighlightRange).toBeNull();
    expect(result.current.scrollToPosition).toBeNull();
  });

  it('settles close once without claiming a result or subsequent unmount', () => {
    const observed = observation();
    const { result, unmount } = renderHook(() =>
      useSequenceSearch({ sequence, annotations, onSearchStart: observed.onSearchStart })
    );
    act(() => result.current.openInMode('nucleotide'));
    act(() => result.current.setQuery('ATG'));
    act(() => result.current.close());
    unmount();
    act(() => vi.advanceTimersByTime(150));
    expect(observed.properties().map((p) => p.action_phase)).toEqual(['start', 'cancel']);
    expect(observed.properties()[1].sequence_search_result).toBe('closed');
  });

  it('emits no terminal after the transport refuses the start', () => {
    const observed = observation(false);
    const { result } = renderHook(() =>
      useSequenceSearch({ sequence, annotations, onSearchStart: observed.onSearchStart })
    );
    act(() => result.current.openInMode('nucleotide'));
    act(() => result.current.setQuery('ATG'));
    act(() => vi.advanceTimersByTime(150));
    expect(observed.properties().map((p) => p.action_phase)).toEqual(['start']);
  });

  it('reports a bounded invalid-pattern outcome without exporting the rejected query', () => {
    const observed = observation();
    const { result } = renderHook(() =>
      useSequenceSearch({ sequence, annotations, onSearchStart: observed.onSearchStart })
    );
    act(() => result.current.openInMode('nucleotide'));
    act(() => result.current.setQuery('PRIVATE_NEVER_SENT'));
    act(() => vi.advanceTimersByTime(150));
    expect(observed.properties().map((p) => p.action_phase)).toEqual(['start', 'error']);
    expect(observed.properties()[1]).toMatchObject({
      sequence_search_result: 'invalid_pattern',
      error_class: 'invalid_pattern',
    });
    expect(JSON.stringify(observed.properties())).not.toContain('PRIVATE_NEVER_SENT');
  });
});
