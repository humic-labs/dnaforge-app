import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SequenceRestoreApplyRequest } from '../../shared/sequence-package-revision';
import { applySequencePackageRestoreWithDelivery } from './apply-sequence-package-restore';

const h = vi.hoisted(() => ({
  dirty: false,
  assertEditors: vi.fn(),
  mutation: vi.fn(),
  readIndex: vi.fn(),
  apply: vi.fn(),
  reconcile: vi.fn(),
  repoRoot: vi.fn(),
  commit: vi.fn(),
}));
vi.mock('../../db/sequence-package-history-io', () => ({
  readSequencePackageHistoryIndex: h.readIndex,
}));
vi.mock('../../platform', () => ({
  platform: () => ({ fs: { applySequenceRestore: h.apply } }),
}));
vi.mock('../../services/workspace-editor-mutation-state', () => ({
  assertWorkspaceEditorsSettled: h.assertEditors,
}));
vi.mock('../../services/workspace-mutation-transaction', () => ({
  withRendererWorkspaceMutation: h.mutation,
}));
vi.mock('../../services/workspace-operations', () => ({
  runWorkspaceReconcileOperation: h.reconcile,
}));
vi.mock('../canvas/public/store', () => ({
  useCanvasStore: { getState: () => ({ panels: {} }) },
}));
vi.mock('./public/store', () => ({
  useSequenceStore: { getState: () => ({ isDirty: () => h.dirty }) },
}));
vi.mock('../workspace/public/git', () => ({
  gitRepoRoot: h.repoRoot,
  gitCommitPaths: h.commit,
}));

const request: SequenceRestoreApplyRequest = {
  workspaceRoot: '/workspace',
  packageRoot: '/workspace/sample.seqpkg',
  packageId: 'package-1',
  operationId: 'operation-1',
  previewFingerprint: 'sha256:' + 'a'.repeat(64),
  selections: [{ itemId: 'product.bases', revisionId: 'version-1' }],
};

describe('shared sequence Restore delivery', () => {
  beforeEach(() => {
    h.dirty = false;
    for (const mock of [
      h.assertEditors,
      h.mutation,
      h.readIndex,
      h.apply,
      h.reconcile,
      h.repoRoot,
      h.commit,
    ])
      mock.mockReset();
    h.mutation.mockImplementation(async (_root, operation: (token: string) => Promise<unknown>) =>
      operation('token-1')
    );
    h.readIndex.mockResolvedValue({ productPath: '/workspace/sample.seqpkg/sample.gb' });
    h.apply.mockResolvedValue({
      revisionId: 'restore:operation-1',
      alreadyPublished: false,
      markerContent: '{}',
      snapshotPaths: [],
    });
    h.reconcile.mockResolvedValue({});
    h.repoRoot.mockResolvedValue(null);
  });

  it('refuses unsaved editor state before native Apply', async () => {
    h.dirty = true;
    await expect(applySequencePackageRestoreWithDelivery(request)).rejects.toThrow(
      /sequence edits before Restore/i
    );
    expect(h.apply).not.toHaveBeenCalled();
  });

  it('rechecks the editor after waiting for the workspace lease', async () => {
    h.mutation.mockImplementation(async (_root, operation: (token: string) => Promise<unknown>) => {
      h.dirty = true;
      return operation('token-1');
    });
    await expect(applySequencePackageRestoreWithDelivery(request)).rejects.toThrow(
      /sequence edits before Restore/i
    );
    expect(h.apply).not.toHaveBeenCalled();
  });

  it('surfaces failed Registry projection and repairs it on an exact native replay', async () => {
    h.reconcile.mockRejectedValueOnce(new Error('Registry unavailable'));
    await expect(applySequencePackageRestoreWithDelivery(request)).rejects.toThrow(
      'Registry unavailable'
    );
    h.apply.mockResolvedValue({
      revisionId: 'restore:operation-1',
      alreadyPublished: true,
      markerContent: '{}',
      snapshotPaths: [],
    });
    const replay = await applySequencePackageRestoreWithDelivery(request);
    expect(replay.delivery).toEqual({
      registry: 'completed',
      git: 'not-a-repository',
      gitError: undefined,
    });
    expect(h.reconcile).toHaveBeenCalledTimes(2);
  });

  it('does not stage a Git commit on an old replay and reports unverified delivery', async () => {
    h.repoRoot.mockResolvedValue('/workspace');
    h.apply.mockResolvedValue({
      revisionId: 'restore:operation-1',
      alreadyPublished: true,
      markerContent: '{}',
      snapshotPaths: [],
    });
    const replay = await applySequencePackageRestoreWithDelivery(request);
    expect(replay.delivery.git).toBe('unverified-replay');
    expect(h.commit).not.toHaveBeenCalled();
  });

  it('leaves the new Restore revision for its one explicit Git commit', async () => {
    h.repoRoot.mockResolvedValue('/workspace');
    const published = await applySequencePackageRestoreWithDelivery(request);
    expect(h.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ healManagedHead: false, mutationToken: 'token-1' })
    );
    expect(h.commit).toHaveBeenCalledTimes(1);
    expect(published.delivery.git).toBe('committed');
  });
});
