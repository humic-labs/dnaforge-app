import { beforeEach, expect, it, vi } from 'vitest';
import { useSequenceStore } from './store';
import {
  saveSequenceDocumentWithCompletion,
  completeSequenceDocumentSave,
} from './complete-sequence-document-save';
import {
  useSequenceHistoryRecovery,
  retrySequenceHistory,
  refreshSequenceHistoryDisplay,
} from './sequence-history-recovery';
import { SequenceDocumentSaveProjectionError } from '../../services/sequence-document-save-completion';
import type { SequenceDocumentSavePublication } from '../../shared/sequence-edit-lineage';
const mocks = vi.hoisted(() => ({
  nativeSave: vi.fn(),
  commit: vi.fn(),
  rawCommit: vi.fn(),
  repo: vi.fn(),
  refresh: vi.fn(),
  stale: vi.fn(),
  lims: vi.fn(),
  begin: vi.fn(),
  completed: vi.fn(),
  failed: vi.fn(),
}));
vi.mock('./sequence-document-client', () => ({
  getNativeSequenceDocumentClient: () => ({ save: mocks.nativeSave }),
}));
vi.mock('../../platform', () => ({
  platform: () => ({ fs: { commitSequenceDocumentHistory: mocks.commit } }),
}));
vi.mock('../workspace/public/git', () => ({
  gitRepoRoot: mocks.repo,
  isGitRepo: vi.fn().mockResolvedValue(false),
  gitStatus: vi.fn().mockResolvedValue(new Map()),
  gitCommitFile: mocks.rawCommit,
  gitCommitPaths: mocks.rawCommit,
}));
vi.mock('../alignment-manager/public/store', () => ({
  useVerificationStore: { getState: () => ({ checkStaleness: mocks.stale }) },
}));
vi.mock('../lims/public/events', () => ({ emitLimsRegistrationChanged: mocks.lims }));
vi.mock('../workspace-session/public/electron-session', () => ({
  refreshElectronWorkspaceSessionForPath: mocks.refresh,
}));
vi.mock('../../lib/workflow-telemetry', () => ({
  beginWorkflowAction: mocks.begin,
  observeWorkflowAction: vi.fn(),
  workflowCountBucket: () => '0',
}));
const document = {
  documentId: 'private-history-document',
  sourcePath: '/private/project/sequence.gb',
};
const receipt = {
  nativeActionId: '550e8400-e29b-41d4-a716-446655440001',
  revisionId: 'private-native-revision',
  contentSha256: 'a'.repeat(64),
  wrote: true,
};
const failedPublication = (
  kind: SequenceDocumentSavePublication['kind']
): SequenceDocumentSavePublication => ({
  kind,
  repositoryRoot: '/private/project',
  history: { receipt, result: { status: 'failed', nativeActionId: receipt.nativeActionId } },
});
beforeEach(() => {
  vi.clearAllMocks();
  useSequenceHistoryRecovery.setState({ documents: {} });
  useSequenceStore.getState().clearAll();
  useSequenceStore.getState().setSequence(document.documentId, {
    id: document.documentId,
    name: 'Private sequence',
    sequence: 'AACC',
    length: 4,
    circular: false,
    annotations: [],
  });
  mocks.begin.mockReturnValue({ complete: mocks.completed, fail: mocks.failed });
  mocks.repo.mockResolvedValue('/private/project');
  mocks.refresh.mockResolvedValue(undefined);
  mocks.stale.mockResolvedValue(undefined);
  mocks.commit.mockResolvedValue({
    status: 'committed',
    nativeActionId: '550e8400-e29b-41d4-a716-446655440002',
  });
});

it('keeps the native Save acknowledged after History fails and retries the original commit once without another Save action', async () => {
  useSequenceStore.getState().replaceBases(document.documentId, 2, 2, 'TT');
  const capture = useSequenceStore.getState().captureForSave(document.documentId);
  if (!capture) throw new Error('A Save capture is required.');
  mocks.nativeSave.mockImplementation(async () => {
    useSequenceStore.getState().acknowledgeSaved(document.documentId, capture);
    return {
      saved: true,
      dirty: false,
      workspaceRoot: '/private/project',
      history: { status: 'failed', error: 'index.lock' },
      saveResult: {
        status: 'saved',
        fileSha256: `sha256:${receipt.contentSha256}`,
        eventId: receipt.revisionId,
        lineage: 'recorded',
        writeReceipt: receipt,
      },
    };
  });
  const result = await saveSequenceDocumentWithCompletion({
    kind: 'write',
    document,
    complete: (publication) =>
      completeSequenceDocumentSave(document, 'Save intended private revision', publication),
  });
  expect(result.persistence).toMatchObject({ ok: true, wrote: true, outcome: 'saved' });
  expect(useSequenceStore.getState().isDirty(document.documentId)).toBe(false);
  expect(useSequenceHistoryRecovery.getState().documents[document.documentId]).toMatchObject({
    status: 'pending',
    input: { ...document, ...receipt, message: 'Save intended private revision' },
  });
  expect(mocks.commit).not.toHaveBeenCalled();
  expect(mocks.rawCommit).not.toHaveBeenCalled();
  expect(
    mocks.begin.mock.calls.filter(
      ([action]) => action.workflow === 'content' && action.action === 'save'
    )
  ).toHaveLength(1);
  expect(mocks.begin.mock.calls.filter(([action]) => action.action === 'commit')).toHaveLength(0);
  await retrySequenceHistory(document.documentId);
  expect(mocks.commit).toHaveBeenCalledExactlyOnceWith({
    ...document,
    ...receipt,
    message: 'Save intended private revision',
  });
  expect(mocks.nativeSave).toHaveBeenCalledOnce();
  expect(useSequenceHistoryRecovery.getState().documents[document.documentId]).toBeUndefined();
  const telemetry = JSON.stringify([
    mocks.begin.mock.calls,
    mocks.completed.mock.calls,
    mocks.failed.mock.calls,
  ]);
  for (const secret of [
    document.documentId,
    document.sourcePath,
    receipt.contentSha256,
    receipt.revisionId,
    'AATTCC',
  ])
    expect(telemetry).not.toContain(secret);
});

it.each(['native-capture', 'accepted-object'] as const)(
  'consumes a failed %s publication without a second initial commit',
  async (kind) => {
    expect(
      await completeSequenceDocumentSave(
        document,
        'Save intended private revision',
        failedPublication(kind)
      )
    ).toMatchObject({ status: 'commit-failed', historyStatus: 'failed' });
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.rawCommit).not.toHaveBeenCalled();
    expect(useSequenceHistoryRecovery.getState().documents[document.documentId]?.input).toEqual({
      ...document,
      ...receipt,
      message: 'Save intended private revision',
    });
  }
);

it('retains a committed receipt through a projection error and refreshes only the read snapshot', async () => {
  mocks.stale.mockRejectedValueOnce(new Error('projection unavailable'));
  const publication: SequenceDocumentSavePublication = {
    kind: 'accepted-object',
    repositoryRoot: '/private/project',
    history: { receipt, result: { status: 'committed', nativeActionId: receipt.nativeActionId } },
  };
  await expect(
    completeSequenceDocumentSave(document, 'Save private revision', publication)
  ).rejects.toBeInstanceOf(SequenceDocumentSaveProjectionError);
  expect(useSequenceHistoryRecovery.getState().documents[document.documentId]?.status).toBe(
    'delivery-pending'
  );
  await refreshSequenceHistoryDisplay(document.documentId);
  expect(mocks.commit).not.toHaveBeenCalled();
  expect(mocks.nativeSave).not.toHaveBeenCalled();
  expect(mocks.rawCommit).not.toHaveBeenCalled();
  expect(useSequenceHistoryRecovery.getState().documents[document.documentId]).toBeUndefined();
});
