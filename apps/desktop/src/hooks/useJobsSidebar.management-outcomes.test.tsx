import { userMessage } from '@waypoint/user-messages';
// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  OperationSnapshot,
  OperationCancelResponse,
  OperationReleaseResponse,
} from '@waypoint/api-client';
import type { ManagedOperationsSnapshot } from '../services/managed-operations';
import type { ComputeJobRecord } from '../shared/compute-jobs-ipc';
import type { DocumentOpenResult } from '../features/canvas/document-presentation';
const mock = vi.hoisted(() => ({
  hosted: false,
  track: vi.fn((_event: string, _properties?: Record<string, unknown>) => true),
  confirm: vi.fn(),
  toast: vi.fn(),
  presenter: vi.fn(),
  cancelHosted: vi.fn(),
  importHosted: vi.fn(),
  openHosted: vi.fn(),
  recordReceipt: vi.fn(),
  providersRefresh: vi.fn(),
  sequence: {
    sequences: {},
    savedSequences: {} as Record<
      string,
      { annotations: Array<{ qualifiers: { dnaforge_operation_id: string[] } }> }
    >,
  },
}));
vi.mock('../lib/telemetry-correlation', () => ({
  getTelemetryCorrelationContext: () => ({
    appSessionId: '10000000-0000-4000-8000-000000000001',
    episodeCorrelationId: '10000000-0000-4000-8000-000000000002',
  }),
}));
vi.mock('../lib/analytics', () => ({
  trackRendererEvent: mock.track,
  isAnalyticsCaptureReady: () => true,
  getAnalyticsIdentifiedAccountId: () => 'private-original-account',
}));
vi.mock('../components/confirm-dialog-store', () => ({ confirmDialog: mock.confirm }));
vi.mock('../features/compute/job-actions', () => ({
  cancelHostedComputeJob: mock.cancelHosted,
  importHostedComputeJob: mock.importHosted,
  openHostedComputeResult: mock.openHosted,
}));
vi.mock('../features/canvas', () => ({
  useCanvasStore: (selector: (state: { panels: object }) => unknown) => selector({ panels: {} }),
}));
vi.mock('../features/sequence', () => ({
  useSequenceStore: (selector: (state: typeof mock.sequence) => unknown) => selector(mock.sequence),
}));
vi.mock('../features/sequence/annotation-review-store', () => ({
  useAnnotationReviewStore: (selector: (state: { sessions: object }) => unknown) =>
    selector({ sessions: {} }),
}));
vi.mock('../features/sequence/annotation-operation-presenter', () => ({
  annotationOperationPresenters: (options: {
    reviewByOperationId: Record<string, { state: string }>;
  }) => ({
    annotation: {
      title: () => 'PRIVATE-title',
      targetLabel: () => 'PRIVATE-path',
      review: (operation: { id: string }) =>
        options.reviewByOperationId[operation.id] ?? { state: 'not-required' },
      canOpenResult: () => true,
      openResult: mock.presenter,
    },
  }),
}));
vi.mock('../features/sequence/alignment-coverage-operation-presenter', () => ({
  alignmentCoverageOperationPresenters: () => ({}),
}));
vi.mock('../features/sequence/alignment-index-operation-presenter', () => ({
  alignmentIndexOperationPresenters: () => ({}),
}));
vi.mock('../features/sequence/genome-index-operation-presenter', () => ({
  genomeIndexOperationPresenters: () => ({}),
}));
vi.mock('../features/sequence/variant-source-operation-presenter', () => ({
  variantSourceOperationPresenters: () => ({}),
}));
vi.mock('../features/alignment-manager', () => ({ alignmentOperationPresenters: () => ({}) }));
vi.mock('../features/sequence/record-annotation-receipt', () => ({
  recordedReceiptDependencies: vi.fn(() => ({})),
  recordSelectedAnnotationReceipt: mock.recordReceipt,
}));
vi.mock('../features/compute/store', () => ({
  useComputeStore: (
    selector: (state: { providers: object[]; refresh: typeof mock.providersRefresh }) => unknown
  ) =>
    selector({
      providers: [
        { id: 'PRIVATE-provider', cancellationMode: 'provider', cancellationNote: 'PRIVATE-note' },
      ],
      refresh: mock.providersRefresh,
    }),
}));
vi.mock('../utils/environment', () => ({
  isDesktopRuntime: () => false,
  isHostedBrowserRuntime: () => mock.hosted,
}));
vi.mock('../stores/toast-store', () => ({
  useToastStore: { getState: () => ({ addToast: mock.toast }) },
}));
import { useJobsSidebar } from './useJobsSidebar';
import { managedOperations } from '../services/managed-operations';
import { useComputeJobsStore } from '../features/compute/jobs-store';
import { useAgentJobsStore } from '../features/jobs/agent-jobs-store';
import { useWorkspaceStore } from '../stores/workspaceStore';
const owner = { kind: 'managed-operation' as const, nativeId: 'PRIVATE-native-operation' };
let live: ManagedOperationsSnapshot;
function operation(patch: Partial<OperationSnapshot> = {}): OperationSnapshot {
  return {
    id: owner.nativeId,
    kind: 'annotation',
    kind_contract_version: 1,
    origin: 'managed',
    subject: {
      scope_id: 'PRIVATE-scope',
      subject_id: 'PRIVATE-document',
      input_revision: 'PRIVATE-revision',
    },
    state: 'running',
    actor_kind: 'human',
    actor_id: 'PRIVATE-actor',
    channel: 'desktop_ui',
    owner_instance_id: 'PRIVATE-instance',
    version: 1,
    created_at: 1,
    updated_at: 2,
    started_at: 1,
    settled_at: null,
    cancel_requested_at: null,
    cancellation_mode: 'cooperative',
    cancellation_availability: 'available',
    result_status: 'none',
    provenance: null,
    error: null,
    ...patch,
  };
}
function managed(
  value = operation(),
  freshness: 'current' | 'stale' = 'current'
): ManagedOperationsSnapshot {
  return {
    status: freshness === 'current' ? 'connected' : 'stale',
    scopeId: 'PRIVATE-scope',
    ownerId: 'PRIVATE-owner',
    ownerInstanceId: 'PRIVATE-instance',
    records: [{ snapshot: value, observation: { freshness, observedAtMs: 100 } }],
    historySummary: null,
    supportedActionsByKind: {},
    kindCatalogByKind: {},
    reconnectAvailable: true,
  };
}
function compute(patch: Partial<ComputeJobRecord> = {}): ComputeJobRecord {
  return {
    id: 'PRIVATE-compute',
    provider: 'PRIVATE-provider',
    toolId: 'PRIVATE-tool',
    label: 'PRIVATE-label',
    settingsHash: 'PRIVATE-hash',
    settings: {},
    remoteId: 'PRIVATE-provider-job',
    state: 'running',
    providerState: 'Running',
    costEstimate: null,
    costEstimateUnit: null,
    costActual: null,
    costActualUnit: null,
    workspaceRoot: '/PRIVATE-root',
    importedPaths: [],
    lastError: null,
    pollCount: 1,
    nextPollAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:01Z',
    ...patch,
  };
}
function held<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const events = (action: string, stage = 'request') =>
  mock.track.mock.calls
    .filter(([, props]) => props?.jobs_action === action && props.jobs_stage === stage)
    .map(([, props]) => props!);
function renderJobs(value = managed()) {
  live = value;
  const props: Parameters<typeof useJobsSidebar>[0] = {
    activeView: 'jobs',
    hostedWorkspaceId: null,
    managedOperationsSnapshot: value,
  };
  const view = renderHook(useJobsSidebar, { initialProps: props });
  return {
    ...view,
    update(next: ManagedOperationsSnapshot, patch: Partial<typeof props> = {}) {
      live = next;
      view.rerender({ ...props, ...patch, managedOperationsSnapshot: next });
    },
  };
}
describe('J1 actual Jobs owner handler boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.hosted = false;
    mock.track.mockReset().mockReturnValue(true);
    mock.confirm.mockReset().mockResolvedValue(true);
    mock.presenter.mockReset().mockResolvedValue(undefined);
    mock.cancelHosted.mockReset().mockResolvedValue(compute({ state: 'canceled' }));
    mock.importHosted.mockReset().mockResolvedValue(true);
    mock.openHosted.mockReset().mockResolvedValue({
      status: 'presented',
      tabId: 'PRIVATE-tab',
      panelId: 'PRIVATE-panel',
      tabType: 'structure',
      disposition: 'created',
      content: 'loading',
    });
    mock.recordReceipt.mockReset().mockResolvedValue({ status: 'canceled' });
    mock.providersRefresh.mockReset().mockResolvedValue(undefined);
    mock.sequence.savedSequences = {};
    useComputeJobsStore.getState().resetForTests();
    useAgentJobsStore.getState().resetForTests();
    useWorkspaceStore.setState({
      folders: [{ path: '/PRIVATE-root', name: 'PRIVATE-folder', addedAt: 1 }],
    });
    vi.spyOn(useComputeJobsStore.getState(), 'refresh').mockResolvedValue(undefined);
    vi.spyOn(useAgentJobsStore.getState(), 'refresh').mockResolvedValue(undefined);
    vi.spyOn(managedOperations, 'getSnapshot').mockImplementation(() => live);
    vi.spyOn(managedOperations, 'requestCancel').mockImplementation(async () => ({
      snapshot: operation({ state: 'stopping' }),
      disposition: 'accepted',
      reason: 'PRIVATE-reason',
    }));
    vi.spyOn(managedOperations, 'getOperation').mockImplementation(
      async () => live.records[0]!.snapshot
    );
    vi.spyOn(managedOperations, 'getActions').mockResolvedValue({
      actions: [],
      total: 0,
      next_offset: null,
      omitted_count: 0,
      history_complete: true,
    });
    vi.spyOn(managedOperations, 'releaseResult').mockResolvedValue({
      snapshot: operation({ state: 'succeeded', result_status: 'released' }),
      disposition: 'released',
      reason: 'PRIVATE-release',
    });
    vi.spyOn(managedOperations, 'reconnect').mockResolvedValue(undefined);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });
  it('separates accepted Stop from a delayed current terminal record and settles it once', async () => {
    const pending = held<OperationCancelResponse>();
    vi.mocked(managedOperations.requestCancel).mockReturnValueOnce(pending.promise);
    const view = renderJobs();
    let returned: unknown;
    act(() => {
      returned = view.result.current.handleStopWorkflow(owner);
    });
    expect(returned).toBeUndefined();
    expect(events('stop')).toEqual([]);
    expect(events('stop', 'record')).toEqual([]);
    await act(async () => {
      pending.resolve({
        snapshot: operation({ state: 'stopping' }),
        disposition: 'accepted',
        reason: 'PRIVATE-ack',
      });
      await pending.promise;
    });
    expect(events('stop')[0]).toMatchObject({
      jobs_phase: 'accepted',
      jobs_result: 'stop_accepted',
      jobs_authority: 'owner_ack',
    });
    expect(events('stop', 'record')).toEqual([]);
    view.update(managed(operation({ state: 'canceled', version: 2, result_status: 'none' })));
    expect(events('stop', 'record')).toHaveLength(1);
    expect(events('stop', 'record')[0]).toMatchObject({
      operation_id: events('stop')[0]?.operation_id,
      jobs_result: 'terminal_cancelled',
      jobs_authority: 'owner_record',
      jobs_freshness: 'current',
    });
    view.update(managed(operation({ state: 'canceled', version: 3 })));
    expect(events('stop', 'record')).toHaveLength(1);
    expect(JSON.stringify(mock.track.mock.calls)).not.toContain('PRIVATE');
  });
  it('does not relabel a late successful completion as cancellation', async () => {
    const view = renderJobs();
    act(() => view.result.current.handleStopWorkflow(owner));
    await waitFor(() => expect(events('stop')).toHaveLength(1));
    view.update(managed(operation({ state: 'succeeded', result_status: 'available', version: 2 })));
    expect(events('stop', 'record')[0]?.jobs_result).toBe('terminal_succeeded');
    expect(events('stop', 'record').some((row) => row.jobs_result === 'terminal_cancelled')).toBe(
      false
    );
  });
  it.each(['already_requested', 'already_settled', 'unavailable'] as const)(
    'keeps actual native Stop disposition %s',
    async (disposition) => {
      vi.mocked(managedOperations.requestCancel).mockResolvedValueOnce({
        snapshot: operation(),
        disposition,
        reason: 'PRIVATE-refusal',
      });
      const view = renderJobs();
      act(() => view.result.current.handleStopWorkflow(owner));
      await waitFor(() => expect(events('stop')).toHaveLength(1));
      expect(events('stop')[0]?.jobs_result).toBe(
        disposition === 'already_requested'
          ? 'stop_already_requested'
          : disposition === 'already_settled'
            ? 'stop_already_settled'
            : 'stop_unavailable'
      );
      expect(events('stop')[0]?.jobs_phase).toBe(
        disposition === 'already_requested' ? 'accepted' : 'refused'
      );
    }
  );
  it('keeps stale owner refusal and recorded history from manufacturing live cancellation', async () => {
    vi.mocked(managedOperations.requestCancel).mockResolvedValue({
      snapshot: operation(),
      disposition: 'unavailable',
      reason: 'PRIVATE-unavailable',
    });
    const view = renderJobs(managed(operation(), 'stale'));
    act(() => view.result.current.handleStopWorkflow(owner));
    await waitFor(() => expect(events('stop')[0]?.jobs_phase).toBe('refused'));
    view.update(managed(operation({ state: 'canceled' })));
    expect(events('stop', 'record').some((row) => row.jobs_result === 'terminal_cancelled')).toBe(
      false
    );

    expect(mock.track.mock.calls.every(([name]) => name === 'job_management_observed')).toBe(true);
  });
  it('supersedes duplicate Stop observation only, preserving both original native requests', async () => {
    const first = held<OperationCancelResponse>();
    vi.mocked(managedOperations.requestCancel).mockReturnValueOnce(first.promise);
    const view = renderJobs();
    act(() => {
      view.result.current.handleStopWorkflow(owner);
      view.result.current.handleStopWorkflow(owner);
    });
    await waitFor(() => expect(managedOperations.requestCancel).toHaveBeenCalledTimes(2));
    await act(async () => {
      first.resolve({ snapshot: operation(), disposition: 'accepted', reason: 'ack' });
      await first.promise;
    });
    view.update(managed(operation({ state: 'canceled' })));
    expect(
      events('stop', 'record')
        .map((row) => row.jobs_result)
        .sort()
    ).toEqual(['superseded', 'terminal_cancelled']);
  });
  it('retires pending evidence on actual scope/runtime/surface change and leaves the product request owned', async () => {
    const pending = held<OperationCancelResponse>();
    vi.mocked(managedOperations.requestCancel).mockReturnValueOnce(pending.promise);
    const view = renderJobs();
    act(() => view.result.current.handleStopWorkflow(owner));
    view.update({ ...managed(), scopeId: 'PRIVATE-other-scope' });
    await act(async () => {
      pending.resolve({ snapshot: operation(), disposition: 'accepted', reason: 'ack' });
      await pending.promise;
    });
    expect(events('stop')[0]?.jobs_freshness).toBe('superseded');
    expect(events('stop', 'record')[0]?.jobs_result).toBe('runtime_changed');
    view.update(managed(operation({ state: 'canceled' })));
    expect(events('stop', 'record').some((row) => row.jobs_result === 'terminal_cancelled')).toBe(
      false
    );
  });
  it('refuses a terminal observation from a replacement scope in the same render', async () => {
    const view = renderJobs();
    act(() => view.result.current.handleStopWorkflow(owner));
    await waitFor(() => expect(events('stop')).toHaveLength(1));
    view.update({
      ...managed(operation({ state: 'canceled', version: 2 })),
      scopeId: 'PRIVATE-replacement',
    });
    expect(events('stop', 'record')[0]?.jobs_result).toBe('runtime_changed');
    expect(events('stop', 'record').some((row) => row.jobs_result === 'terminal_cancelled')).toBe(
      false
    );
  });
  it('hosted confirmation cancel makes no native request and accepted Stop waits for a current collection', async () => {
    const job = compute();
    useComputeJobsStore.setState({
      jobs: [job],
      observedAtMs: 100,
      collectionStale: false,
      coverage: {
        jobCount: 1,
        activeCount: job.state === 'running' ? 1 : 0,
        terminalCount: job.state === 'running' ? 0 : 1,
        activeComplete: true,
        historyComplete: true,
        historyLimit: 200,
      },
    });
    const view = renderJobs();
    const hosted = { kind: 'hosted-compute' as const, nativeId: job.id };
    mock.confirm.mockResolvedValueOnce(false);
    act(() => view.result.current.handleStopWorkflow(hosted));
    await waitFor(() => expect(events('stop')).toHaveLength(1));
    expect(mock.cancelHosted).not.toHaveBeenCalled();
    expect(events('stop')[0]?.jobs_result).toBe('confirmation_cancelled');
    act(() => view.result.current.handleStopWorkflow(hosted));
    await waitFor(() => expect(mock.cancelHosted).toHaveBeenCalledExactlyOnceWith(job));
    act(() =>
      useComputeJobsStore.setState({
        jobs: [{ ...job, state: 'canceled' }],
        collectionStale: true,
        observedAtMs: 200,
      })
    );
    expect(events('stop', 'record').some((row) => row.jobs_result === 'terminal_cancelled')).toBe(
      false
    );
    act(() => useComputeJobsStore.setState({ collectionStale: false, observedAtMs: 300 }));
    expect(
      events('stop', 'record').filter((row) => row.jobs_result === 'terminal_cancelled')
    ).toHaveLength(1);
  });
  it.each([false, true])(
    'respects actual import Boolean %s and the exact retained job/workspace arguments',
    async (imported) => {
      const job = compute({ state: 'completed' });
      useComputeJobsStore.setState({
        jobs: [job],
        observedAtMs: 100,
        collectionStale: false,
        coverage: {
          jobCount: 1,
          activeCount: job.state === 'running' ? 1 : 0,
          terminalCount: job.state === 'running' ? 0 : 1,
          activeComplete: true,
          historyComplete: true,
          historyLimit: 200,
        },
      });
      mock.importHosted.mockResolvedValueOnce(imported);
      const view = renderJobs();
      act(() =>
        view.result.current.handleImportWorkflowResult({ kind: 'hosted-compute', nativeId: job.id })
      );
      await waitFor(() => expect(events('import')).toHaveLength(1));
      expect(mock.importHosted).toHaveBeenCalledExactlyOnceWith(
        job,
        useWorkspaceStore.getState().folders
      );
      expect(events('import')[0]).toMatchObject({
        jobs_phase: imported ? 'result' : 'refused',
        jobs_result: imported ? 'import_returned_true' : 'import_not_applied',
        jobs_authority: 'adapter_return',
      });
    }
  );
  it.each(['presented', 'blocked', 'cancelled'] as const)(
    'preserves declared Open disposition %s at the hook boundary without exporting document identity',
    async (status) => {
      const job = compute({ state: 'imported', importedPaths: ['/PRIVATE-root/result.pdb'] });
      useComputeJobsStore.setState({
        jobs: [job],
        observedAtMs: 100,
        collectionStale: false,
        coverage: {
          jobCount: 1,
          activeCount: job.state === 'running' ? 1 : 0,
          terminalCount: job.state === 'running' ? 0 : 1,
          activeComplete: true,
          historyComplete: true,
          historyLimit: 200,
        },
      });
      const opened: DocumentOpenResult =
        status === 'presented'
          ? {
              status,
              tabId: 'PRIVATE-open-tab',
              panelId: 'PRIVATE-panel',
              tabType: 'structure',
              disposition: 'created',
              content: 'loading',
            }
          : status === 'cancelled'
            ? { status, reason: 'PRIVATE-cancel' }
            : { status, message: 'PRIVATE-refusal' };

      mock.openHosted.mockResolvedValueOnce(opened);
      const view = renderJobs();
      act(() =>
        view.result.current.handleOpenWorkflowResult({ kind: 'hosted-compute', nativeId: job.id })
      );
      await waitFor(() => expect(events('open')).toHaveLength(1));
      expect(mock.openHosted).toHaveBeenCalledExactlyOnceWith(
        job,
        useWorkspaceStore.getState().folders
      );
      expect(events('open')[0]?.jobs_result).toBe(
        status === 'presented'
          ? 'open_presented'
          : status === 'cancelled'
            ? 'open_cancelled'
            : 'open_refused'
      );
      expect(JSON.stringify(mock.track.mock.calls)).not.toContain('PRIVATE');
    }
  );
  it('keeps a managed void presenter weaker than actual presentation and retains the exact operation argument', async () => {
    const value = operation({ state: 'succeeded', result_status: 'available' });
    const view = renderJobs(managed(value));
    act(() => view.result.current.handleOpenWorkflowResult(owner));
    await waitFor(() => expect(mock.presenter).toHaveBeenCalledExactlyOnceWith(value));
    expect(events('open')[0]).toMatchObject({
      jobs_result: 'presenter_returned_not_attested',
      jobs_authority: 'presenter_return',
    });
    expect(events('open')[0]?.jobs_result).not.toBe('open_presented');
  });
  it('release confirmation cancel preserves history/applied state and makes no native release', async () => {
    const value = operation({ state: 'succeeded', result_status: 'available' });
    mock.sequence.savedSequences[value.subject.subject_id] = {
      annotations: [{ qualifiers: { dnaforge_operation_id: [value.id] } }],
    };
    mock.confirm.mockResolvedValueOnce(false);
    const view = renderJobs(managed(value));
    const before = mock.sequence.savedSequences;
    act(() => view.result.current.handleReleaseWorkflowResult(owner));
    await waitFor(() => expect(events('release')).toHaveLength(1));
    expect(managedOperations.releaseResult).not.toHaveBeenCalled();
    expect(events('release')[0]?.jobs_result).toBe('confirmation_cancelled');
    expect(view.result.current.jobsSnapshot.jobs[0]?.review.state).toBe('applied');
    expect(mock.sequence.savedSequences).toBe(before);
  });
  it.each(['released', 'already_released', 'unavailable'] as const)(
    'retains actual native release disposition %s and history/applied work',
    async (disposition) => {
      const value = operation({ state: 'succeeded', result_status: 'available' });
      mock.sequence.savedSequences[value.subject.subject_id] = {
        annotations: [{ qualifiers: { dnaforge_operation_id: [value.id] } }],
      };
      const response: OperationReleaseResponse = {
        snapshot: {
          ...value,
          result_status: disposition === 'unavailable' ? 'available' : 'released',
        },
        disposition,
        reason: 'PRIVATE-native-release',
      };
      vi.mocked(managedOperations.releaseResult).mockResolvedValueOnce(response);
      const view = renderJobs(managed(value));
      act(() => view.result.current.handleReleaseWorkflowResult(owner));
      await waitFor(() => expect(events('release')).toHaveLength(1));
      expect(managedOperations.releaseResult).toHaveBeenCalledExactlyOnceWith(owner.nativeId);
      expect(events('release')[0]?.jobs_result).toBe(
        disposition === 'released'
          ? 'release_returned'
          : disposition === 'already_released'
            ? 'already_released'
            : 'release_unavailable'
      );
      view.update(managed(response.snapshot));
      expect(view.result.current.jobsSnapshot.jobs[0]?.review.state).toBe('applied');
      await expect(view.result.current.handleLoadWorkflowActions(owner)).resolves.toMatchObject({
        actions: [],
        total: 0,
        historyComplete: true,
      });
      expect(JSON.stringify(mock.track.mock.calls)).not.toContain('PRIVATE');
    }
  );
  it('native release rejection is an error and keeps the retained row available', async () => {
    const failure = new Error('PRIVATE-release-error');
    vi.mocked(managedOperations.releaseResult).mockRejectedValueOnce(failure);
    const view = renderJobs(managed(operation({ state: 'succeeded', result_status: 'available' })));
    act(() => view.result.current.handleReleaseWorkflowResult(owner));
    await waitFor(() => expect(events('release')[0]?.jobs_phase).toBe('error'));
    expect(view.result.current.jobsSnapshot.jobs[0]?.result.availability).toBe('available');
    expect(mock.toast).toHaveBeenCalledWith(
      userMessage('failure.could-not-release-the-job-result'),
      expect.anything()
    );
    expect(JSON.stringify(mock.track.mock.calls)).not.toContain('PRIVATE');
  });
  it('does not turn resolved reconnect requests into current collection or a new run', async () => {
    const view = renderJobs(managed(operation(), 'stale'));
    const before = useComputeJobsStore.getState().jobs;
    act(() => view.result.current.handleReconnectWorkflowOwners());
    await waitFor(() => expect(events('reconnect', 'record')).toHaveLength(1));
    expect(events('reconnect')[0]).toMatchObject({
      jobs_result: 'reconnect_returned',
      jobs_authority: 'request_return',
    });
    expect(events('reconnect', 'record')[0]).toMatchObject({
      jobs_result: 'collection_unavailable',
      jobs_freshness: 'stale',
    });
    expect(useComputeJobsStore.getState().jobs).toBe(before);
    expect(managedOperations.reconnect).toHaveBeenCalledOnce();
    expect(useComputeJobsStore.getState().refresh).toHaveBeenCalledExactlyOnceWith({ limit: 200 });
    expect(useAgentJobsStore.getState().refresh).toHaveBeenCalledOnce();
    expect(mock.providersRefresh).toHaveBeenCalledOnce();
    expect(mock.track.mock.calls.every(([name]) => name === 'job_management_observed')).toBe(true);
  });
  it('observes browser Jobs from its connected server without waiting for native histories', () => {
    mock.hosted = true;
    useComputeJobsStore.setState({ jobs: [compute()] });
    const view = renderJobs();
    expect(view.result.current.jobsSnapshot.collectionObservation.state).toBe('current');
    expect(view.result.current.jobsSnapshot.jobs.map((job) => job.owner.kind)).toEqual([
      'managed-operation',
    ]);
  });
  it('retains a real browser execution-owner failure', () => {
    mock.hosted = true;
    const view = renderJobs({ ...managed(operation(), 'stale'), reason: 'Owner unreachable' });
    expect(view.result.current.jobsSnapshot.collectionObservation).toMatchObject({
      state: 'unavailable',
      canReconnect: true,
    });
    expect(view.result.current.jobsSnapshot.collectionObservation.reason).toContain(
      'Owner unreachable'
    );
  });
  it('reconnects the browser owner without calling unavailable native job APIs', async () => {
    mock.hosted = true;
    const view = renderJobs();
    act(() => view.result.current.handleReconnectWorkflowOwners());
    await waitFor(() => expect(events('reconnect', 'record')).toHaveLength(1));
    expect(managedOperations.reconnect).toHaveBeenCalledOnce();
    expect(useComputeJobsStore.getState().refresh).not.toHaveBeenCalled();
    expect(useAgentJobsStore.getState().refresh).not.toHaveBeenCalled();
    expect(mock.providersRefresh).not.toHaveBeenCalled();
    expect(events('reconnect', 'record')[0]).toMatchObject({
      jobs_result: 'collection_current',
      jobs_freshness: 'current',
    });
  });
  it('reads native coverage after reconnect instead of accepting a successful Promise as complete coverage', async () => {
    useComputeJobsStore.setState({
      observedAtMs: 100,
      collectionStale: false,
      coverage: {
        jobCount: 0,
        activeCount: 0,
        terminalCount: 0,
        activeComplete: true,
        historyComplete: true,
        historyLimit: 200,
      },
    });
    useAgentJobsStore.setState({ observedAtMs: 100, collectionStale: false });
    const view = renderJobs();
    act(() => view.result.current.handleReconnectWorkflowOwners());
    await waitFor(() => expect(events('reconnect', 'record')).toHaveLength(1));
    expect(events('reconnect', 'record')[0]).toMatchObject({
      jobs_result: 'collection_current',
      jobs_freshness: 'current',
      jobs_observed_at_ms: 100,
    });
    act(() => useComputeJobsStore.setState({ coverage: null }));
    act(() => view.result.current.handleReconnectWorkflowOwners());
    await waitFor(() => expect(events('reconnect', 'record')).toHaveLength(2));
    expect(events('reconnect', 'record')[1]).toMatchObject({
      jobs_result: 'collection_unavailable',
      jobs_freshness: 'stale',
    });
  });
  it.each(['canceled', 'recorded'] as const)(
    'records completed-run picker outcome %s without a live computation identity',
    async (status) => {
      mock.recordReceipt.mockResolvedValueOnce(
        status === 'recorded' ? { status, operationId: 'PRIVATE-recorded-op' } : { status }
      );
      const view = renderJobs();
      act(() => view.result.current.handleImportRecordedRun());
      await waitFor(() => expect(events('record_completed')).toHaveLength(1));
      expect(events('record_completed')[0]).toMatchObject({
        jobs_origin: 'recorded',
        jobs_execution_mode: 'recorded',
        jobs_result: status === 'recorded' ? 'recorded_history_added' : 'record_picker_cancelled',
      });
      expect(JSON.stringify(mock.track.mock.calls)).not.toContain('PRIVATE-recorded-op');
    }
  );
  it('optional entropy/capture failure never blocks the original native call, void return or toast error path', async () => {
    const failure = new Error('PRIVATE-original-native');
    vi.mocked(managedOperations.requestCancel).mockRejectedValueOnce(failure);
    const view = renderJobs();
    mock.track.mockImplementation(() => {
      throw new Error('optional sink');
    });
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(() => {
      throw new Error('optional entropy');
    });
    let returned: unknown;
    act(() => {
      returned = view.result.current.handleStopWorkflow(owner);
    });
    expect(returned).toBeUndefined();
    await waitFor(() =>
      expect(mock.toast).toHaveBeenCalledWith(
        userMessage('failure.could-not-stop-the-job'),
        expect.anything()
      )
    );
    expect(managedOperations.requestCancel).toHaveBeenCalledExactlyOnceWith(owner.nativeId);
  });
  it('contains capture failure after valid entropy while preserving native acceptance and later outcome', async () => {
    const view = renderJobs();
    mock.track.mockImplementation(() => {
      throw new Error('optional SDK');
    });
    act(() => view.result.current.handleStopWorkflow(owner));
    await waitFor(() =>
      expect(managedOperations.requestCancel).toHaveBeenCalledExactlyOnceWith(owner.nativeId)
    );
    view.update(managed(operation({ state: 'canceled', version: 2 })));
    expect(mock.track).toHaveBeenCalled();
    expect(mock.toast).not.toHaveBeenCalled();
  });
  it('keeps malformed optional owner metadata from adding a product rejection or toast', async () => {
    vi.mocked(managedOperations.requestCancel).mockResolvedValueOnce(JSON.parse('null'));
    const view = renderJobs();
    act(() => view.result.current.handleStopWorkflow(owner));
    await waitFor(() => expect(events('stop')).toHaveLength(1));
    expect(events('stop')[0]).toMatchObject({
      jobs_result: 'terminal_not_attested',
      jobs_authority: 'not_attested',
    });
    expect(mock.toast).not.toHaveBeenCalled();
  });
  it('preserves an original synchronous owner exception rather than converting it into a Promise or toast', () => {
    const failure = new Error('PRIVATE-sync');
    vi.mocked(managedOperations.requestCancel).mockImplementationOnce(() => {
      throw failure;
    });
    const view = renderJobs();
    let caught: unknown;
    try {
      view.result.current.handleStopWorkflow(owner);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(mock.toast).not.toHaveBeenCalled();
    expect(events('stop')[0]).toMatchObject({
      jobs_phase: 'error',
      jobs_result: 'request_rejected',
    });
  });
});
