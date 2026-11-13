import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { SequenceHistoryNotice } from './SequenceHistoryNotice';
import {
  useSequenceHistoryRecovery,
  recordSequenceHistoryResult,
} from '../sequence-history-recovery';
const mocks = vi.hoisted(() => ({ commit: vi.fn(), refresh: vi.fn() }));
vi.mock('../../../services/sequence-document-save-completion', () => ({
  refreshSavedSequenceSession: mocks.refresh,
}));
vi.mock('../../../platform', () => ({
  platform: () => ({ fs: { commitSequenceDocumentHistory: mocks.commit } }),
}));
vi.mock('../../../lib/workflow-telemetry', () => ({
  beginWorkflowAction: () => ({ complete: vi.fn(), fail: vi.fn() }),
  observeWorkflowAction: vi.fn(),
}));
const input = {
  documentId: 'notice-document',
  sourcePath: '/private/source.gb',
  message: 'Save',
  nativeActionId: '550e8400-e29b-41d4-a716-446655440001',
  revisionId: 'private-revision',
  contentSha256: 'a'.repeat(64),
  wrote: true,
};
describe('saved history recovery notice', () => {
  beforeEach(() => {
    useSequenceHistoryRecovery.setState({ documents: {} });
    vi.clearAllMocks();
    mocks.refresh.mockResolvedValue(undefined);
  });
  it('shows history-only failure and clears it after native retry without a Save control', async () => {
    recordSequenceHistoryResult(input, {
      status: 'commit-failed',
      error: new Error('private details'),
    });
    render(<SequenceHistoryNotice documentId={input.documentId} />);
    expect(screen.getByRole('status').textContent).toContain(
      'Sequence saved. Its Git history needs a retry.'
    );
    expect(screen.getByRole('status').textContent).not.toContain(input.sourcePath);
    mocks.commit.mockResolvedValue({
      status: 'committed',
      nativeActionId: '550e8400-e29b-41d4-a716-446655440002',
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry history' }));
    });
    expect(mocks.commit).toHaveBeenCalledExactlyOnceWith(input);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('keeps a confirmed commit distinct and refreshes its view without a write', async () => {
    recordSequenceHistoryResult(input, {
      status: 'committed',
      repositoryRoot: '/private',
      delivery: 'pending',
    });
    render(<SequenceHistoryNotice documentId={input.documentId} />);
    expect(screen.getByRole('status').textContent).toContain('Its view needs to refresh.');
    expect(screen.queryByRole('button', { name: 'Retry history' })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Refresh view' })));
    expect(screen.queryByRole('status')).toBeNull();
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith(input);
    expect(mocks.commit).not.toHaveBeenCalled();
  });
});
