import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useSequenceHistoryRecovery,
  recordSequenceHistoryResult,
  retrySequenceHistory,
  refreshSequenceHistoryDisplay,
} from './sequence-history-recovery';
import { canReadAcknowledgedSequence } from '../../services/acknowledged-sequence-read';
const mocks = vi.hoisted(() => ({
  commit: vi.fn(),
  begin: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  refresh: vi.fn(),
  hash: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock('../../services/sequence-document-save-completion', () => ({
  refreshSavedSequenceSession: mocks.refresh,
}));
vi.mock('../../platform', () => ({
  platform: () => ({
    fs: {
      commitSequenceDocumentHistory: mocks.commit,
      canonicalPath: async (path: string) => path,
      sha256File: mocks.hash,
    },
  }),
}));
vi.mock('./sequence-document-repository', () => ({ resolveSequenceDocumentById: mocks.resolve }));
vi.mock('../../lib/workflow-telemetry', () => ({ beginWorkflowAction: mocks.begin }));
const input = {
  documentId: 'private-record-id',
  sourcePath: '/private/project/sequence.gb',
  message: 'Save private record',
  nativeActionId: '550e8400-e29b-41d4-a716-446655440001',
  revisionId: 'private-revision',
  contentSha256: 'a'.repeat(64),
  wrote: true,
};
describe('written history recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.refresh.mockResolvedValue(undefined);
    useSequenceHistoryRecovery.setState({ documents: {} });
    mocks.begin.mockReturnValue({
      actionId: '550e8400-e29b-41d4-a716-446655440009',
      complete: mocks.complete,
      fail: mocks.fail,
    });
  });
  it('retains a failed history context and joins concurrent retries without rewriting sequence content', async () => {
    recordSequenceHistoryResult(input, {
      status: 'commit-failed',
      error: new Error('private native details'),
    });
    expect(useSequenceHistoryRecovery.getState().documents[input.documentId]?.status).toBe(
      'pending'
    );
    let settle!: (value: { status: string; nativeActionId: string }) => void;
    mocks.commit.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        })
    );
    const first = retrySequenceHistory(input.documentId);
    const second = retrySequenceHistory(input.documentId);
    expect(mocks.commit).toHaveBeenCalledExactlyOnceWith(input);
    settle({ status: 'committed', nativeActionId: '550e8400-e29b-41d4-a716-446655440010' });
    await Promise.all([first, second]);
    expect(useSequenceHistoryRecovery.getState().documents[input.documentId]).toBeUndefined();
    expect(mocks.complete).toHaveBeenCalledOnce();
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith(input);
    const metadata =
      JSON.stringify(mocks.begin.mock.calls) + JSON.stringify(mocks.complete.mock.calls);
    expect(metadata).not.toContain(input.documentId);
    expect(metadata).not.toContain(input.sourcePath);
    expect(metadata).not.toContain(input.revisionId);
    expect(metadata).not.toContain(input.contentSha256);
  });
  it('keeps a revision-change refusal visible and does not replace its captured context', async () => {
    recordSequenceHistoryResult(input, { status: 'commit-failed', error: new Error() });
    mocks.commit.mockResolvedValue({
      status: 'revision-changed',
      nativeActionId: '550e8400-e29b-41d4-a716-446655440010',
    });
    await retrySequenceHistory(input.documentId);
    expect(useSequenceHistoryRecovery.getState().documents[input.documentId]).toMatchObject({
      status: 'revision-changed',
      input,
    });
    expect(mocks.fail).toHaveBeenCalledOnce();
  });
  it('does not clear a newer pending saved revision when an older retry completes', async () => {
    recordSequenceHistoryResult(input, { status: 'commit-failed', error: new Error() });
    let settle!: (value: { status: string; nativeActionId: string }) => void;
    mocks.commit.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        })
    );
    const retry = retrySequenceHistory(input.documentId);
    const newer = {
      ...input,
      nativeActionId: '550e8400-e29b-41d4-a716-446655440002',
      contentSha256: 'b'.repeat(64),
    };
    recordSequenceHistoryResult(newer, { status: 'commit-failed', error: new Error() });
    settle({ status: 'committed', nativeActionId: '550e8400-e29b-41d4-a716-446655440010' });
    await retry;
    expect(useSequenceHistoryRecovery.getState().documents[input.documentId]?.input).toEqual(newer);
  });

  it('retains a confirmed history result without re-committing after session refresh fails', async () => {
    recordSequenceHistoryResult(input, { status: 'commit-failed', error: new Error() });
    mocks.commit.mockResolvedValue({ status: 'committed', nativeActionId: input.nativeActionId });
    mocks.refresh.mockRejectedValueOnce(new Error('Read snapshot unavailable'));
    await retrySequenceHistory(input.documentId);
    expect(useSequenceHistoryRecovery.getState().documents[input.documentId]?.status).toBe(
      'delivery-pending'
    );
    expect(mocks.complete).toHaveBeenCalledOnce();
    expect(mocks.fail).not.toHaveBeenCalled();
    await retrySequenceHistory(input.documentId);
    expect(mocks.commit).toHaveBeenCalledOnce();
    await refreshSequenceHistoryDisplay(input.documentId);
    expect(useSequenceHistoryRecovery.getState().documents[input.documentId]).toBeUndefined();
    expect(mocks.commit).toHaveBeenCalledOnce();
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
  });

  it('admits pending saved bytes for read only with the same current binding and exact native hash', async () => {
    recordSequenceHistoryResult(input, { status: 'commit-failed', error: new Error() });
    mocks.resolve.mockResolvedValue({
      documentId: input.documentId,
      sourcePath: '/different/source.gb',
    });
    mocks.hash.mockResolvedValue(`sha256:${input.contentSha256}`);
    expect(await canReadAcknowledgedSequence(input.sourcePath)).toBe(false);
    mocks.resolve.mockResolvedValue({ documentId: input.documentId, sourcePath: input.sourcePath });
    mocks.hash.mockResolvedValue(`sha256:${'b'.repeat(64)}`);
    expect(await canReadAcknowledgedSequence(input.sourcePath)).toBe(false);
    mocks.hash.mockResolvedValue(`sha256:${input.contentSha256}`);
    expect(await canReadAcknowledgedSequence(input.sourcePath)).toBe(true);
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(useSequenceHistoryRecovery.getState().documents[input.documentId]?.status).toBe(
      'pending'
    );
  });
});
