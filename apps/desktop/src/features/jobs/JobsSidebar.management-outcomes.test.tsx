// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
import { JobsSidebar } from './JobsSidebar';
import type { JobsSidebarJob, JobsSidebarSnapshot, JobsSidebarActionHistory } from './presentation';
const row = (patch: Partial<JobsSidebarJob> = {}): JobsSidebarJob => ({
  id: 'PRIVATE-row',
  title: 'PRIVATE-title',
  actorLabel: 'PRIVATE-actor',
  owner: { kind: 'managed-operation', nativeId: 'PRIVATE-native' },
  state: 'running',
  observation: { freshness: 'current', observedAtMs: 100 },
  result: { availability: 'none' },
  review: { state: 'not-required' },
  executionContext: { mode: 'managed' },
  createdAtMs: 1,
  canStop: true,
  canLoadActions: true,
  ...patch,
});
const value = (jobs: JobsSidebarJob[]): JobsSidebarSnapshot => ({
  jobs,
  nowMs: 100,
  collectionObservation: { state: 'current', observedAtMs: 100 },
});
const handlers = () => ({
  onStop: vi.fn(),
  onImportResult: vi.fn(),
  onOpenResult: vi.fn(),
  onReleaseResult: vi.fn(),
  onScopeChange: vi.fn(),
});
const events = (action: string, stage = 'request') =>
  track.mock.calls
    .filter(
      ([, properties]) => properties?.jobs_action === action && properties.jobs_stage === stage
    )
    .map(([, properties]) => properties!);
function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
describe('Jobs UI history/scope and existing capability boundaries', () => {
  beforeEach(() => track.mockReset().mockReturnValue(true));
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });
  it('retains current/stale/recorded capability gates and exact callback arguments', () => {
    const h = handlers();
    render(
      <JobsSidebar
        snapshot={value([
          row(),
          row({
            id: 'stale',
            title: 'Stale',
            owner: { kind: 'managed-operation', nativeId: 'stale' },
            observation: { freshness: 'stale' },
          }),
          row({
            id: 'recorded',
            title: 'Recorded',
            owner: { kind: 'managed-operation', nativeId: 'recorded' },
            executionContext: { mode: 'recorded' },
          }),
        ])}
        {...h}
      />
    );
    expect(screen.getAllByRole('button', { name: 'Stop', exact: true })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Stop', exact: true }));
    expect(h.onStop).toHaveBeenCalledExactlyOnceWith(row().owner);
    expect(screen.queryByRole('button', { name: 'Retry', exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dismiss', exact: true })).not.toBeInTheDocument();

    expect(events('stop')).toEqual([]);
  });
  it('records actual history return and coverage without exporting action labels or IDs, then admits Refresh', async () => {
    const h = handlers();
    const history: JobsSidebarActionHistory = {
      actions: [{ id: 'PRIVATE-history-id', label: 'PRIVATE-history-label' }],
      total: 3,
      truncated: true,
      historyComplete: false,
    };
    const onLoadActions = vi.fn(async () => history);
    render(<JobsSidebar snapshot={value([row()])} {...h} onLoadActions={onLoadActions} />);
    fireEvent.click(screen.getByRole('button', { name: /Show details/ }));
    await waitFor(() => expect(screen.getByText('PRIVATE-history-label')).toBeVisible());
    expect(onLoadActions).toHaveBeenCalledExactlyOnceWith(row().owner);
    expect(events('history')[0]).toMatchObject({
      jobs_result: 'history_returned',
      jobs_authority: 'owner_history_return',
      jobs_history_coverage: 'limited',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh history' }));
    await waitFor(() => expect(events('history')).toHaveLength(2));
    expect(onLoadActions).toHaveBeenCalledTimes(2);
    expect(events('history')[0]?.operation_id).not.toBe(events('history')[1]?.operation_id);
    expect(JSON.stringify(track.mock.calls)).not.toContain('PRIVATE');
  });
  it('retires a history response after its real row unmount without calling it a loaded current history', async () => {
    const h = handlers();
    const pending = held<JobsSidebarActionHistory>();
    const view = render(
      <JobsSidebar snapshot={value([row()])} {...h} onLoadActions={() => pending.promise} />
    );
    fireEvent.click(screen.getByRole('button', { name: /Show details/ }));
    view.unmount();
    await act(async () => {
      pending.resolve({ actions: [], total: 0, truncated: false, historyComplete: true });
      await pending.promise;
    });
    expect(events('history')).toHaveLength(1);
    expect(events('history')[0]).toMatchObject({
      jobs_phase: 'cancelled',
      jobs_result: 'superseded',
      jobs_freshness: 'superseded',
    });
  });
  it('keeps a rejected history read distinct from confirmed empty history and allows its existing Retry', async () => {
    const h = handlers();
    const onLoadActions = vi
      .fn()
      .mockRejectedValueOnce(new Error('PRIVATE-history-error'))
      .mockResolvedValueOnce({ actions: [], total: 0, truncated: false, historyComplete: true });
    render(<JobsSidebar snapshot={value([row()])} {...h} onLoadActions={onLoadActions} />);
    fireEvent.click(screen.getByRole('button', { name: /Show details/ }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('History unavailable'));
    expect(events('history')[0]).toMatchObject({
      jobs_phase: 'error',
      jobs_result: 'request_rejected',
    });
    expect(screen.queryByText('No retained actions.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh history' }));
    await waitFor(() => expect(screen.getByText('No retained actions.')).toBeVisible());
    expect(events('history').at(-1)).toMatchObject({
      jobs_result: 'history_returned',
      jobs_history_coverage: 'complete',
    });
    expect(JSON.stringify(track.mock.calls)).not.toContain('PRIVATE');
  });
  it('separates a scope request from its actual committed selection with no raw scope ID', async () => {
    const h = handlers();
    const original = {
      ...value([]),
      scopes: [
        { id: 'PRIVATE-scope-a', label: 'A' },
        { id: 'PRIVATE-scope-b', label: 'B' },
      ],
      selectedScopeId: 'PRIVATE-scope-a',
    };
    const view = render(<JobsSidebar snapshot={original} {...h} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Job scope' }), {
      target: { value: 'PRIVATE-scope-b' },
    });
    expect(h.onScopeChange).toHaveBeenCalledExactlyOnceWith('PRIVATE-scope-b');
    expect(events('scope')[0]?.jobs_result).toBe('scope_requested');
    expect(events('scope', 'record')).toEqual([]);
    view.rerender(
      <JobsSidebar snapshot={{ ...original, selectedScopeId: 'PRIVATE-scope-b' }} {...h} />
    );
    await waitFor(() => expect(events('scope', 'record')).toHaveLength(1));
    expect(events('scope', 'record')[0]).toMatchObject({
      jobs_result: 'scope_applied',
      jobs_scope: 'scoped',
      operation_id: events('scope')[0]?.operation_id,
    });
    expect(JSON.stringify(track.mock.calls)).not.toContain('PRIVATE');
  });
  it('cancels an uncommitted scope request on unmount and optional sink failure leaves the callback exact', () => {
    const h = handlers();
    track.mockImplementation(() => {
      throw new Error('optional capture');
    });
    const snapshot = {
      ...value([]),
      scopes: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
    };
    const view = render(<JobsSidebar snapshot={snapshot} {...h} />);
    expect(() =>
      fireEvent.change(screen.getByRole('combobox', { name: 'Job scope' }), {
        target: { value: 'b' },
      })
    ).not.toThrow();
    expect(h.onScopeChange).toHaveBeenCalledExactlyOnceWith('b');
    view.unmount();
    expect(events('scope', 'record')[0]?.jobs_result).toBe('surface_closed');
  });
});
