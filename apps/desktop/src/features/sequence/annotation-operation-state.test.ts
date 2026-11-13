import { beforeEach, describe, expect, it, vi } from 'vitest';
import { startAnnotationOperation } from './annotation-operation-state';

const operationId = '550e8400-e29b-41d4-a716-446655440077';
const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  snapshot: vi.fn(),
  subscribe: vi.fn(),
  release: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock('../../services/managed-operations', () => ({
  managedOperations: {
    startAnnotation: mocks.start,
    getSnapshot: mocks.snapshot,
    subscribe: mocks.subscribe,
  },
}));
vi.mock('../../lib/workflow-telemetry', () => ({
  beginWorkflowAction: () => ({
    complete: mocks.complete,
    fail: mocks.fail,
    cancel: mocks.cancel,
    consumed: false,
  }),
}));
vi.mock('./store', () => ({ useSequenceStore: { getState: () => ({ getVersion: () => 7 }) } }));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.start.mockResolvedValue({ id: operationId });
  mocks.subscribe.mockReturnValue(mocks.release);
});
describe('annotation admitted operation terminal correlation', () => {
  it.each(['succeeded', 'canceled', 'failed', 'interrupted'])(
    'joins the exact admitted operation on %s',
    async (state) => {
      mocks.snapshot.mockReturnValue({
        records: [{ snapshot: { id: operationId, state }, observation: { freshness: 'current' } }],
      });
      await startAnnotationOperation('document-a', { sequence: 'ACGT', linear: false });
      if (state === 'succeeded')
        expect(mocks.complete).toHaveBeenCalledExactlyOnceWith({ status: 'success', operationId });
      else if (state === 'canceled')
        expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith({ status: 'cancelled', operationId });
      else
        expect(mocks.fail).toHaveBeenCalledExactlyOnceWith(state, {
          status: 'failed',
          operationId,
        });
      expect(mocks.release).toHaveBeenCalledOnce();
    }
  );
  it('does not treat stale or different operation receipts as this terminal', async () => {
    mocks.snapshot.mockReturnValue({
      records: [
        { snapshot: { id: operationId, state: 'succeeded' }, observation: { freshness: 'stale' } },
        {
          snapshot: { id: 'different-operation', state: 'succeeded' },
          observation: { freshness: 'current' },
        },
      ],
    });
    await startAnnotationOperation('document-a', { sequence: 'ACGT', linear: false });
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.fail).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
});
