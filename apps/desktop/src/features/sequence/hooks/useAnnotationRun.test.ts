import { userMessage } from '@waypoint/user-messages';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { OperationSnapshot } from '@waypoint/api-client';
import type { ManagedOperationsSnapshot } from '../../../services/managed-operations';

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  result: vi.fn(),
  cancel: vi.fn(),
  beginWorkflow: vi.fn(),
  completeActivity: vi.fn(),
  failActivity: vi.fn(),
  cancelActivity: vi.fn(),
  listeners: new Set<() => void>(),
  snapshot: null as unknown,
}));
vi.mock('../../../services/managed-operations', () => ({
  managedOperations: {
    subscribe: (listener: () => void) => {
      mocks.listeners.add(listener);
      return () => {
        mocks.listeners.delete(listener);
      };
    },
    getSnapshot: () => mocks.snapshot,
    startAnnotation: mocks.start,
    getResult: mocks.result,
    requestCancel: mocks.cancel,
  },
}));
vi.mock('../store', () => ({ useSequenceStore: { getState: () => ({ getVersion: () => 7 }) } }));
vi.mock('../../../lib/workflow-telemetry', () => ({
  beginWorkflowAction: mocks.beginWorkflow,
}));

import { useAnnotationOperationState } from '../annotation-operation-state';
import { useAnnotationRun } from './useAnnotationRun';

function operation(
  id = 'operation-a',
  state: OperationSnapshot['state'] = 'running'
): OperationSnapshot {
  return {
    id,
    state,
    kind: 'annotation',
    kind_contract_version: 1,
    subject: { scope_id: 'scope', subject_id: 'document-a', input_revision: 'revision-a' },
    actor_kind: 'human',
    actor_id: 'local-human',
    channel: 'desktop_ui',
    owner_instance_id: 'owner',
    version: state === 'running' ? 1 : 2,
    created_at: 1,
    updated_at: 2,
    cancellation_mode: 'queued_only',
    cancellation_availability: 'unavailable',
    result_status: state === 'succeeded' ? 'available' : 'none',
  };
}
function observe(operations: OperationSnapshot[], stale = false): void {
  mocks.snapshot = {
    status: stale ? 'stale' : 'connected',
    scopeId: 'scope',
    ownerId: 'local-human',
    ownerInstanceId: 'owner',
    historySummary: null,
    supportedActionsByKind: { annotation: ['start'] },
    kindCatalogByKind: {},
    reconnectAvailable: stale,
    records: operations.map((snapshot) => ({
      snapshot,
      observation: { freshness: stale ? 'stale' : 'current', observedAtMs: 2 },
    })),
  } satisfies ManagedOperationsSnapshot;
  mocks.listeners.forEach((listener) => listener());
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listeners.clear();
  observe([]);
  useAnnotationOperationState.setState({
    selectedByDocument: {},
    submittedVersions: {},
    presentationRequests: {},
  });
  mocks.beginWorkflow.mockReturnValue({
    actionId: 'activity-a',
    consumed: false,
    complete: mocks.completeActivity,
    fail: mocks.failActivity,
    cancel: mocks.cancelActivity,
  });
  mocks.start.mockImplementation(async () => {
    const value = operation();
    observe([value]);
    return value;
  });
  mocks.result.mockResolvedValue({
    operation_id: 'operation-a',
    kind: 'annotation',
    status: 'available',
    result: { features: [], sequence_length: 4 },
  });
});

describe('annotation view observes the application-owned run', () => {
  it('keeps starting unavailable until the execution owner connects', () => {
    mocks.snapshot = { ...(mocks.snapshot as ManagedOperationsSnapshot), status: 'connecting' };
    const { result } = renderHook(() => useAnnotationRun('document-a'));
    expect(result.current.unavailableReason).toBe('Connecting to job service…');
    act(() => observe([]));
    expect(result.current.unavailableReason).toBeUndefined();
    act(() => observe([], true));
    expect(result.current.unavailableReason).toContain('unavailable');
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it.each([null, { unexpected: true }, { features: [], sequence_length: '4' }])(
    'refuses an available result with an invalid payload: %j',
    async (payload) => {
      mocks.result.mockResolvedValue({
        operation_id: 'operation-a',
        kind: 'annotation',
        status: 'available',
        result: payload,
      });
      useAnnotationOperationState.getState().select('document-a', 'operation-a');
      observe([operation('operation-a', 'succeeded')]);
      const { result } = renderHook(() => useAnnotationRun('document-a'));
      await waitFor(() => expect(result.current.status).toBe('error'));
      expect(result.current.error).toBe(userMessage('annotation.invalidResult'));
      expect(result.current.data).toBeNull();
    }
  );

  it('refuses a valid payload returned for another operation', async () => {
    mocks.result.mockResolvedValue({
      operation_id: 'operation-b',
      kind: 'annotation',
      status: 'available',
      result: { features: [], sequence_length: 4 },
    });
    useAnnotationOperationState.getState().select('document-a', 'operation-a');
    observe([operation('operation-a', 'succeeded')]);
    const { result } = renderHook(() => useAnnotationRun('document-a'));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe(userMessage('annotation.resultMismatch'));
    expect(result.current.data).toBeNull();
  });

  it('starts idle, then keeps a stable admitted operation and submission-time version', async () => {
    const { result } = renderHook(() => useAnnotationRun('document-a'));
    expect(result.current.status).toBe('idle');
    await act(async () => {
      await result.current.execute({ sequence: 'ACGT' });
    });
    expect(result.current.status).toBe('loading');
    expect(result.current.operationId).toBe('operation-a');
    expect(useAnnotationOperationState.getState().submittedVersions['operation-a']).toBe(7);
    expect(mocks.start).toHaveBeenCalledWith(
      'document-a',
      { sequence: 'ACGT' },
      expect.any(String)
    );
  });

  it('survives view closure and restores the same result without a second execution', async () => {
    const first = renderHook(() => useAnnotationRun('document-a'));
    await act(async () => {
      await first.result.current.execute({ sequence: 'ACGT' });
    });
    first.unmount();
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.cancelActivity).not.toHaveBeenCalled();
    act(() => observe([operation('operation-a', 'succeeded')]));
    const reopened = renderHook(() => useAnnotationRun('document-a'));
    await waitFor(() => expect(reopened.result.current.status).toBe('success'));
    expect(reopened.result.current.data).toEqual({ features: [], sequence_length: 4 });
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.result).toHaveBeenCalledWith('operation-a');
    expect(mocks.beginWorkflow).toHaveBeenCalledWith({
      workflow: 'plannotate',
      action: 'run',
    });
    expect(mocks.completeActivity).toHaveBeenCalledWith({
      status: 'success',
      operationId: 'operation-a',
    });
  });

  it('reset detaches the selected presentation without requesting cancellation', async () => {
    const { result } = renderHook(() => useAnnotationRun('document-a'));
    await act(async () => {
      await result.current.execute({ sequence: 'ACGT' });
    });
    act(() => result.current.reset());
    expect(result.current.status).toBe('idle');
    expect(mocks.cancel).not.toHaveBeenCalled();
    act(() => observe([operation('operation-a', 'succeeded')]));
    expect(result.current.status).toBe('idle');
    expect(mocks.result).not.toHaveBeenCalled();
  });

  it('does not let a late admission overwrite the newer selected run', async () => {
    let admit!: (value: OperationSnapshot) => void;
    mocks.start
      .mockReturnValueOnce(
        new Promise<OperationSnapshot>((resolve) => {
          admit = resolve;
        })
      )
      .mockResolvedValueOnce(operation('operation-b'));
    const { result } = renderHook(() => useAnnotationRun('document-a'));
    let first!: Promise<void>;
    act(() => {
      first = result.current.execute({ sequence: 'ACGT' });
    });
    await act(async () => {
      await result.current.execute({ sequence: 'ACGTACGT' });
    });
    await act(async () => {
      admit(operation());
      await first;
      observe([operation(), operation('operation-b')]);
    });
    expect(result.current.operationId).toBe('operation-b');
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it('reports stale observation without claiming the worker failed', async () => {
    const { result } = renderHook(() => useAnnotationRun('document-a'));
    await act(async () => {
      await result.current.execute({ sequence: 'ACGT' });
    });
    act(() => observe([operation()], true));
    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe(userMessage('jobs.statusStale'));
    expect(result.current.operationId).toBe('operation-a');
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it('retains an uncertain submission key and does not automatically retry', async () => {
    mocks.start.mockRejectedValueOnce(new Error('The runtime did not confirm admission.'));
    const { result } = renderHook(() => useAnnotationRun('document-a'));
    await act(async () => {
      await result.current.execute({ sequence: 'ACGT' });
    });
    expect(result.current.status).toBe('error');
    expect(
      useAnnotationOperationState.getState().selectedByDocument['document-a'].submissionKey
    ).toBeTruthy();
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.failActivity).toHaveBeenCalledWith('submission_failed');
  });
});
