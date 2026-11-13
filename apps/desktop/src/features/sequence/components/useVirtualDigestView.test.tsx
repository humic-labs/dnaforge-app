// @vitest-environment jsdom
import { useState } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import type { CutSitesState } from '@waypoint/workspace-editor';
import type { TabViewState } from '../../canvas/public/types';
import type { SelectionRange } from '../selection-state';
import { digestEnzyme } from '../../../test/fixtures/digest-workflow';
import { useVirtualDigestView } from './useVirtualDigestView';

const capture = vi.hoisted(() => ({
  ready: true,
  generation: 1,
  sinkThrows: false,
  events: [] as Array<Record<string, unknown>>,
}));
vi.mock('../../../lib/analytics', () => ({
  getAnalyticsCaptureGeneration: () => capture.generation,
  isAnalyticsCaptureReady: () => capture.ready,
  isAnalyticsIdentityIdentified: () => false,
  getMeaningfulActivityAuthority: () => ({
    actorKind: 'test',
    executionMode: 'automated',
    impersonated: false,
  }),
  getAnalyticsIdentifiedAccountId: () => null,
  subscribeAnalyticsCaptureReady: () => () => {},
  trackRendererEvent: (_event: string, properties: Record<string, unknown>) => {
    if (capture.sinkThrows) throw new Error('optional sink');
    if (!capture.ready) return false;
    capture.events.push(properties);
    return true;
  },
}));

const eco = digestEnzyme();
const other = digestEnzyme('SecondI', 'TTAA');
const source = (overrides: Partial<AnnotatedSequence> = {}): AnnotatedSequence => ({
  id: 'private-document',
  name: 'Private document',
  sequence: 'AAAAGAATTCTTAATTTT',
  length: 18,
  circular: true,
  annotations: [],
  ...overrides,
});
function mount(
  initial = source(),
  initialState: TabViewState = {},
  acceptSelection = true,
  selectionFailure?: Error
) {
  const select = vi.fn();
  let acceptDigestUpdates = true;
  const initialEnzymes = [eco, other];
  const hook = renderHook(
    ({ sequence, ownerKey, enzymes }) => {
      const [state, setState] = useState<TabViewState>(initialState);
      const [selectedRange, setSelectedRange] = useState<SelectionRange | null>(null);
      const digest = useVirtualDigestView({
        ownerKey,
        sourceIdentity: sequence.name,
        sequence,
        viewState: state,
        setViewState: (update) => {
          if (acceptDigestUpdates) setState((previous) => ({ ...previous, ...update }));
        },
        cutSitesState: { activeEnzymes: enzymes } as CutSitesState,
        selectedRange,
        onFragmentSelect: (range, scroll) => {
          select(range, scroll);
          if (selectionFailure) throw selectionFailure;
          if (acceptSelection) setSelectedRange(range);
        },
      });
      return { ...digest, applyExternalState: setState };
    },
    { initialProps: { sequence: initial, ownerKey: 'owner-a', enzymes: initialEnzymes } }
  );
  return {
    ...hook,
    select,
    initialEnzymes,
    refuseDigestUpdates: () => {
      acceptDigestUpdates = false;
    },
  };
}
const results = (action: string) =>
  capture.events.filter(
    (event) => event.workflow_action === action && event.action_phase !== 'start'
  );
beforeEach(() => {
  capture.ready = true;
  capture.generation = 1;
  capture.sinkThrows = false;
  capture.events = [];
});
afterEach(cleanup);

describe('real viewer digest state and result ownership', () => {
  it('accepts single and ordered multi activation, and toggles the identical set off', () => {
    const h = mount();
    act(() => h.result.current.handleVirtualDigest('EcoRI'));
    expect(h.result.current.activeVirtualDigestEnzymeNames).toEqual(['EcoRI']);
    expect(results('compute')).toHaveLength(1);
    act(() => h.result.current.handleVirtualDigest(['SecondI', 'EcoRI']));
    expect(h.result.current.activeVirtualDigestEnzymeNames).toEqual(['SecondI', 'EcoRI']);
    expect(results('compute').at(-1)).toMatchObject({
      digest_enzyme_count: 2,
      digest_trigger: 'activation',
    });
    act(() => h.result.current.handleVirtualDigest(['SecondI', 'EcoRI']));
    expect(h.result.current.virtualDigestResult).toBeNull();
    expect(results('compute')).toHaveLength(2);
    expect(results('deactivate')).toHaveLength(1);
  });

  it('preserves enzyme ordering rather than treating reversed keys as the same toggle', () => {
    const h = mount();
    act(() => h.result.current.handleVirtualDigest(['EcoRI', 'SecondI']));
    act(() => h.result.current.handleVirtualDigest(['SecondI', 'EcoRI']));
    expect(h.result.current.activeVirtualDigestEnzymeNames).toEqual(['SecondI', 'EcoRI']);
    expect(results('deactivate')).toHaveLength(0);
    expect(results('compute')).toHaveLength(2);
  });

  it('recomputes from real source/topology and excludes old fragment callbacks', () => {
    const original = source();
    const h = mount(original);
    act(() => h.result.current.handleVirtualDigest('EcoRI'));
    const oldClick = h.result.current.handleDigestFragmentClick;
    const oldFragment = h.result.current.virtualDigestResult!.fragments[0];
    h.rerender({
      sequence: { ...original, circular: false },
      ownerKey: 'owner-a',
      enzymes: [eco, other],
    });
    expect(h.result.current.virtualDigestResult!.fragments).toHaveLength(2);
    expect(results('compute').at(-1)).toMatchObject({
      digest_trigger: 'recompute',
      digest_topology: 'linear',
      result_count: 2,
    });
    act(() => oldClick(oldFragment));
    expect(h.select).not.toHaveBeenCalled();
    h.rerender({
      sequence: source({ sequence: 'AAAAAAAAAAAAAAAAAA' }),
      ownerKey: 'owner-a',
      enzymes: [eco, other],
    });
    expect(results('compute').at(-1)).toMatchObject({
      outcome_kind: 'digest_no_cuts',
      success: true,
    });
  });

  it('retires a changed viewer owner without attributing a restored state as new activation', () => {
    const h = mount();
    act(() => h.result.current.handleVirtualDigest('EcoRI'));
    const oldClick = h.result.current.handleDigestFragmentClick;
    const fragment = h.result.current.virtualDigestResult!.fragments[0];
    h.rerender({ sequence: source(), ownerKey: 'owner-b', enzymes: [eco, other] });
    act(() => oldClick(fragment));
    expect(h.select).not.toHaveBeenCalled();
    expect(results('compute')).toHaveLength(1);
  });

  it('clears removed enzymes instead of accepting a partial selected set', () => {
    const h = mount();
    act(() => h.result.current.handleVirtualDigest(['EcoRI', 'SecondI']));
    h.rerender({ sequence: source(), ownerKey: 'owner-a', enzymes: [eco] });
    expect(h.result.current.activeVirtualDigestEnzymeNames).toEqual([]);
    expect(
      results('compute').filter((event) => event.outcome_kind === 'digest_fragments')
    ).toHaveLength(1);
  });

  it('waits for the owning selected range and ignores hover/collapse observations', () => {
    const h = mount();
    act(() => h.result.current.handleVirtualDigest('EcoRI'));
    const fragment = h.result.current.virtualDigestResult!.fragments[0];
    act(() => {
      h.result.current.handleDigestFragmentHover(fragment);
      h.result.current.handleDigestCollapsedChange(false);
      h.result.current.handleEnzymesCollapsedChange(false);
    });
    expect(results('select')).toHaveLength(0);
    expect(results('compute')).toHaveLength(1);
    act(() => h.result.current.handleDigestFragmentClick(fragment));
    expect(h.select).toHaveBeenCalledWith(
      expect.objectContaining({ start: fragment.startPosition }),
      fragment.startPosition + 1
    );
    expect(results('select')).toHaveLength(1);
  });

  it('does not turn a no-op selection callback into accepted selection', () => {
    const h = mount(source(), {}, false);
    act(() => h.result.current.handleVirtualDigest('EcoRI'));
    act(() =>
      h.result.current.handleDigestFragmentClick(h.result.current.virtualDigestResult!.fragments[0])
    );
    expect(h.select).toHaveBeenCalledTimes(1);
    expect(results('select')).toHaveLength(1);
    expect(results('select')[0]).toMatchObject({
      success: false,
      workflow_status: 'blocked',
      outcome_kind: 'digest_use_refused',
    });
  });

  it('keeps restored/disabled views outside activation metrics and preserves operations on sink failure', () => {
    const restored = mount(source(), { virtualDigestEnzymes: ['EcoRI'] });
    expect(restored.result.current.virtualDigestResult).not.toBeNull();
    expect(capture.events).toEqual([]);
    restored.unmount();
    capture.ready = false;
    const disabled = mount();
    act(() => disabled.result.current.handleVirtualDigest('EcoRI'));
    expect(disabled.result.current.virtualDigestResult).not.toBeNull();
    expect(capture.events).toEqual([]);
    disabled.unmount();
    capture.ready = true;
    capture.sinkThrows = true;
    const failing = mount();
    act(() => failing.result.current.handleVirtualDigest('EcoRI'));
    expect(failing.result.current.virtualDigestResult!.cutSiteCount).toBe(1);
  });

  it('records actual unavailable input and calculation errors as closed non-success outcomes', () => {
    const h = mount();
    act(() => h.result.current.handleVirtualDigest('NotAnActiveEnzyme'));
    expect(results('compute').at(-1)).toMatchObject({
      workflow_status: 'blocked',
      outcome_kind: 'digest_input_missing',
    });
    const bad = { ...eco };
    Object.defineProperty(bad, 'recognition_sequence', {
      get: () => {
        throw new Error('Private engine detail');
      },
    });
    h.rerender({ sequence: source(), ownerKey: 'owner-a', enzymes: [bad] });
    act(() => h.result.current.handleVirtualDigest('EcoRI'));
    expect(h.result.current.virtualDigestResult).toBeNull();
    expect(h.result.current.virtualDigestError).toBe('unknown');
    expect(results('compute').at(-1)).toMatchObject({
      success: false,
      error_class: 'unknown',
      outcome_kind: 'digest_error',
    });
    expect(JSON.stringify(capture.events)).not.toContain('Private engine detail');
  });

  it('preserves a real selection failure and emits only its closed error class', () => {
    const failure = new Error('Private selection detail');
    const h = mount(source(), {}, true, failure);
    act(() => h.result.current.handleVirtualDigest('EcoRI'));
    act(() => {
      expect(() =>
        h.result.current.handleDigestFragmentClick(
          h.result.current.virtualDigestResult!.fragments[0]
        )
      ).toThrow(failure);
    });
    expect(results('select')[0]).toMatchObject({
      success: false,
      error_class: 'unknown',
      outcome_kind: 'digest_use_refused',
    });
    expect(JSON.stringify(capture.events)).not.toContain(failure.message);
  });

  it('excludes an old source callback even when identical bases reuse the exact calculation object', () => {
    const original = source();
    const h = mount(original);
    act(() => h.result.current.handleVirtualDigest('EcoRI'));
    const oldResult = h.result.current.virtualDigestResult!;
    const oldClick = h.result.current.handleDigestFragmentClick;
    h.rerender({
      sequence: { ...original, id: 'different-private-source' },
      ownerKey: 'owner-a',
      enzymes: h.initialEnzymes,
    });
    expect(h.result.current.virtualDigestResult).toBe(oldResult);
    act(() => oldClick(oldResult.fragments[0]));
    expect(h.select).not.toHaveBeenCalled();
    expect(results('select')).toHaveLength(0);
  });

  it('does not treat a returned no-op activation setter or later restored state as accepted activation', () => {
    const h = mount();
    h.refuseDigestUpdates();
    act(() => h.result.current.handleVirtualDigest('EcoRI'));
    expect(h.result.current.activeVirtualDigestEnzymeNames).toEqual([]);
    expect(capture.events).toEqual([]);
    act(() => h.result.current.applyExternalState({ virtualDigestEnzymes: ['EcoRI'] }));
    expect(h.result.current.virtualDigestResult).not.toBeNull();
    expect(capture.events).toEqual([]);
  });

  it('does not claim same-set deactivation when the real view-state owner refuses it', () => {
    const h = mount();
    act(() => h.result.current.handleVirtualDigest('EcoRI'));
    h.refuseDigestUpdates();
    act(() => h.result.current.handleVirtualDigest('EcoRI'));
    expect(h.result.current.activeVirtualDigestEnzymeNames).toEqual(['EcoRI']);
    expect(results('compute')).toHaveLength(1);
    expect(results('deactivate')).toHaveLength(0);
  });
});
