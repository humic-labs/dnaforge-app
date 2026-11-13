// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { track } = vi.hoisted(() => ({
  track: vi.fn((_event: string, _properties?: Record<string, unknown>) => true),
}));
vi.mock('../../lib/telemetry-correlation', () => ({
  getTelemetryCorrelationContext: () => ({
    appSessionId: '10000000-0000-4000-8000-000000000001',
    episodeCorrelationId: '10000000-0000-4000-8000-000000000002',
  }),
}));
vi.mock('../../lib/analytics', () => ({
  trackRendererEvent: track,
  isAnalyticsCaptureReady: () => true,
  getAnalyticsIdentifiedAccountId: () => 'private-original-account',
}));
import { useHistoryPaneObservation } from './useHistoryPaneObservation';
import { beginHistoryObservation } from '../../lib/chat-history-telemetry';
const options = () => ({
  conversationId: 'private-a' as string | null,
  known: true,
  hasState: false,
  isOpen: true,
  scoped: false,
  switchConversation: vi.fn((_id: string): unknown => Promise.resolve('applied')),
  hydrateConversation: vi.fn((_id: string): unknown => Promise.resolve()),
  onConversationIdChange: vi.fn((_id: string) => undefined),
});
const panes = () =>
  track.mock.calls
    .filter(([, props]) => props?.history_stage === 'pane')
    .map(([, props]) => props!);
function held() {
  let resolve!: (value?: unknown) => void;
  const promise = new Promise<unknown>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
describe('passive actual pane commitment', () => {
  beforeEach(() => {
    track.mockReset().mockReturnValue(true);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });
  it('forwards exactly one argument and returns the identical original promise; a pointer alone is not presentation', async () => {
    const props = options();
    const pending = held();
    props.hydrateConversation.mockReturnValue(pending.promise);
    const { result, rerender } = renderHook(useHistoryPaneObservation, { initialProps: props });
    let returned: unknown;
    act(() => {
      returned = result.current.hydrateForOwnership('private-a');
    });
    expect(returned).toBe(pending.promise);
    expect(props.hydrateConversation).toHaveBeenCalledExactlyOnceWith('private-a');
    await act(async () => {
      pending.resolve();
      await pending.promise;
    });
    expect(panes()).toEqual([]);
    rerender({ ...props, hasState: true });
    await waitFor(() => expect(panes()).toHaveLength(1));
    expect(panes()[0]).toMatchObject({
      history_result: 'pane_presented',
      history_authority: 'pane_commit',
      history_pane_role: 'current_pane',
    });
    rerender({ ...props, hasState: true });
    expect(panes()).toHaveLength(1);
  });
  it('separates background/scoped availability from current-pane presentation', async () => {
    const props = { ...options(), scoped: true, isOpen: false, hasState: true };
    const { result } = renderHook(useHistoryPaneObservation, { initialProps: props });
    await act(async () => {
      await result.current.hydrateForOwnership('private-a');
    });
    expect(panes()[0]).toMatchObject({
      history_result: 'background_available',
      history_authority: 'keyed_state',
      history_pane_role: 'background',
    });
    expect(panes()[0]).not.toHaveProperty('history_presented_generation_id');
    expect(props.switchConversation).not.toHaveBeenCalled();
  });
  it('retires late completions after a binding changes, including away-and-back', async () => {
    const props = options();
    const pending = held();
    props.hydrateConversation.mockReturnValue(pending.promise);
    const { result, rerender } = renderHook(useHistoryPaneObservation, { initialProps: props });
    act(() => {
      result.current.hydrateForOwnership('private-a');
    });
    rerender({ ...props, conversationId: 'private-b', hasState: true });
    rerender({ ...props, hasState: true });
    await act(async () => {
      pending.resolve();
      await pending.promise;
    });
    expect(panes()).toHaveLength(1);
    expect(panes()[0]).toMatchObject({ history_phase: 'cancelled', history_result: 'superseded' });
  });
  it('still retires binding changes when pane entropy fails but the operation has an ID', async () => {
    const nativeRandom = crypto.getRandomValues.bind(crypto);
    vi.spyOn(crypto, 'getRandomValues')
      .mockImplementation(() => {
        throw new Error('optional pane entropy unavailable');
      })
      .mockImplementationOnce(() => {
        throw new Error('first pane unavailable');
      })
      .mockImplementationOnce(nativeRandom);
    const props = options();
    const pending = held();
    props.hydrateConversation.mockReturnValue(pending.promise);
    const view = renderHook(useHistoryPaneObservation, { initialProps: props });
    expect(view.result.current.paneGenerationId).toBeNull();
    act(() => {
      view.result.current.hydrateForOwnership('private-a');
    });
    view.rerender({ ...props, conversationId: 'private-b', hasState: true });
    view.rerender({ ...props, hasState: true });
    await act(async () => {
      pending.resolve();
      await pending.promise;
    });
    expect(panes()).toHaveLength(1);
    expect(panes()[0]).toMatchObject({ history_result: 'superseded', history_phase: 'cancelled' });
    expect(panes()[0]?.operation_id).toMatch(/^[0-9a-f-]{36}$/u);
  });
  it('settles unmount and rejected/stale original operations without converting their result', async () => {
    const props = options();
    const pending = held();
    props.switchConversation.mockReturnValue(pending.promise);
    const view = renderHook(useHistoryPaneObservation, { initialProps: props });
    act(() => {
      expect(view.result.current.switchForOwnership('private-a')).toBe(pending.promise);
    });
    view.unmount();
    await act(async () => {
      pending.resolve('applied');
      await pending.promise;
    });
    expect(panes()).toHaveLength(1);
    expect(panes()[0]?.history_result).toBe('surface_closed');
    const failure = new Error('PRIVATE-native');
    const rejected = Promise.reject(failure);
    props.hydrateConversation.mockReturnValue(rejected);
    const second = renderHook(useHistoryPaneObservation, { initialProps: props });
    let returned: unknown;
    act(() => {
      returned = second.result.current.hydrateForOwnership('private-a');
    });
    await expect(returned).rejects.toBe(failure);
    await waitFor(() => expect(panes().at(-1)?.history_phase).toBe('error'));
    props.switchConversation.mockReturnValue(Promise.resolve('stale'));
    await act(async () => {
      await second.result.current.switchForOwnership('private-a');
    });
    expect(panes().at(-1)?.history_phase).toBe('refused');
  });
  it('shares an explicit navigation operation and observes a placeholder only after retarget commits', async () => {
    const props = options();
    const { result, rerender } = renderHook(useHistoryPaneObservation, { initialProps: props });
    const operation = beginHistoryObservation(
      'delete',
      'history_surface',
      result.current.paneGenerationId
    );
    operation.store({
      result: 'delete_returned',
      authority: 'sqlite_return',
      availability: 'placeholder',
      replacement: 'read_failed_placeholder',
    });
    act(() => {
      result.current.retarget('private-b', operation);
    });
    expect(props.onConversationIdChange).toHaveBeenCalledExactlyOnceWith('private-b');
    expect(panes()).toEqual([]);
    rerender({ ...props, conversationId: 'private-b', hasState: true });
    expect(panes()[0]).toMatchObject({
      operation_id: operation.id,
      history_result: 'placeholder_presented',
      history_availability: 'placeholder',
      history_replacement: 'read_failed_placeholder',
    });
    expect(JSON.stringify(track.mock.calls)).not.toMatch(/private-[ab]/);
  });
  it('retains the original retarget callback after unmount but cancels late observation without a new state update', () => {
    const props = options();
    const view = renderHook(useHistoryPaneObservation, { initialProps: props });
    const retarget = view.result.current.retarget;
    const operation = beginHistoryObservation('new', 'history_surface');
    view.unmount();
    retarget('late-private-id', operation);
    expect(props.onConversationIdChange).toHaveBeenCalledExactlyOnceWith('late-private-id');
    expect(panes()).toHaveLength(1);
    expect(panes()[0]).toMatchObject({
      history_phase: 'cancelled',
      history_result: 'surface_closed',
    });
  });
  it('supersedes a pending pane once and tolerates StrictMode cleanup without starting product work', () => {
    const props = options();
    const { result, unmount } = renderHook(useHistoryPaneObservation, {
      initialProps: props,
      wrapper: StrictMode,
    });
    const a = beginHistoryObservation('resume', 'history_surface');
    const b = beginHistoryObservation('resume', 'history_surface');
    act(() => {
      result.current.retarget('b', a);
      result.current.retarget('c', b);
    });
    unmount();
    expect(panes().filter((row) => row.operation_id === a.id)).toHaveLength(1);
    expect(panes().find((row) => row.operation_id === a.id)?.history_result).toBe('superseded');
    expect(panes().filter((row) => row.operation_id === b.id)).toHaveLength(1);
    expect(props.switchConversation).not.toHaveBeenCalled();
    expect(props.hydrateConversation).not.toHaveBeenCalled();
  });
});
