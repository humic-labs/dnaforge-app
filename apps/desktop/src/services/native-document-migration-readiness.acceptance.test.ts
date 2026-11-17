import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  folders: [] as Array<{ path: string; name: string; pinned?: boolean }>,
  listeners: new Set<() => void>(),
  send: vi.fn(),
  readiness: vi.fn(),
  fileDrafts: vi.fn(),
  sequenceDrafts: vi.fn(),
  notebookDrafts: vi.fn(),
  reconcile: vi.fn(),
  completed: [] as string[],
  candidates: null as ((event: { workspaceRoot: string }) => void) | null,
  subscribeCandidates: vi.fn(),
  stopCandidates: vi.fn(),
}));
vi.mock('../features/workspace/public/file-document-client', () => ({
  installFileDocumentClientSync: () => () => {},
  setNativeFileDocumentReadiness: mocks.readiness,
}));
vi.mock('../features/workspace/file-document-legacy-client', () => ({
  migrateLegacyFileDrafts: mocks.fileDrafts,
}));
vi.mock('../features/sequence/sequence-document-client', () => ({
  installNativeSequenceDocumentClient: () => () => {},
  getNativeSequenceDocumentClient: () => ({ refreshAvailableDocuments() {} }),
}));
vi.mock('../features/sequence/store', () => ({ sequenceDocumentModel: {} }));
vi.mock('../features/sequence/legacy-sequence-recovery-client', () => ({
  migrateLegacySequenceDrafts: mocks.sequenceDrafts,
}));
vi.mock('../features/page/notebook-document-client', () => ({
  migrateLegacyNotebookDrafts: mocks.notebookDrafts,
}));
vi.mock('./native-notebook-catalog-publisher', () => ({
  installNativeNotebookCatalogPublisher: () => () => {},
}));
vi.mock('./workspace-operations', () => ({ reconcileWorkspaceAfterFilesChanged: mocks.reconcile }));
vi.mock('../platform', () => ({
  platform: () => ({
    workspace: {
      setDocumentCommandRoots: mocks.send,
      onMigrationCandidatesChanged: mocks.subscribeCandidates,
    },
  }),
}));
vi.mock('../stores/workspaceStore', () => ({
  useWorkspaceStore: {
    getState: () => ({ folders: mocks.folders }),
    subscribe: (listener: () => void) => {
      mocks.listeners.add(listener);
      return () => mocks.listeners.delete(listener);
    },
  },
}));

import { installNativeDocumentWorkspacePublisher } from './native-document-workspaces';

const disposals: Array<() => void> = [];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.folders = [];
  mocks.listeners.clear();
  mocks.completed.length = 0;
  mocks.candidates = null;
  mocks.subscribeCandidates.mockImplementation(
    (listener: (event: { workspaceRoot: string }) => void) => {
      mocks.candidates = listener;
      return mocks.stopCandidates;
    }
  );
  mocks.send.mockResolvedValue(true);
  mocks.fileDrafts.mockResolvedValue(undefined);
  mocks.sequenceDrafts.mockResolvedValue(undefined);
  mocks.notebookDrafts.mockResolvedValue(undefined);
  mocks.reconcile.mockImplementation(async ({ workspaceRoot }: { workspaceRoot: string }) => {
    await mocks.readiness.mock.calls.at(-1)![0];
    mocks.completed.push(workspaceRoot);
  });
});
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});

describe('automatic migration after native draft transfer readiness', () => {
  it('retains pre-ready native arrival events for the current writable root and coalesces them with startup', async () => {
    let finish!: () => void;
    mocks.notebookDrafts.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    mocks.folders = [
      { path: '/writable', name: 'Writable' },
      { path: '/reference', name: 'Reference', pinned: true },
    ];
    disposals.push(installNativeDocumentWorkspacePublisher('native-arrivals-before-ready'));
    expect(mocks.subscribeCandidates).toHaveBeenCalledOnce();
    const fire = mocks.candidates!;
    fire({ workspaceRoot: '/writable' });
    fire({ workspaceRoot: '/writable' });
    fire({ workspaceRoot: '/reference' });
    fire({ workspaceRoot: '/foreign' });
    await vi.waitFor(() => expect(mocks.notebookDrafts).toHaveBeenCalledOnce());
    expect(mocks.reconcile).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(mocks.completed).toEqual(['/writable']));
    expect(mocks.reconcile).toHaveBeenCalledOnce();
  });

  it('coalesces changes during a migration and reruns after each changed in-flight pass without losing the last arrival', async () => {
    const releases: Array<() => void> = [];
    mocks.reconcile.mockImplementation(async ({ workspaceRoot }: { workspaceRoot: string }) => {
      await mocks.readiness.mock.calls.at(-1)![0];
      await new Promise<void>((resolve) => releases.push(resolve));
      mocks.completed.push(workspaceRoot);
    });
    mocks.folders = [{ path: '/writable', name: 'Writable' }];
    disposals.push(installNativeDocumentWorkspacePublisher('native-arrival-coalescing'));
    expect(mocks.subscribeCandidates).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const fire = mocks.candidates!;
    fire({ workspaceRoot: '/writable' });
    fire({ workspaceRoot: '/writable' });
    expect(mocks.reconcile).toHaveBeenCalledOnce();
    releases[0]();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    fire({ workspaceRoot: '/writable' });
    fire({ workspaceRoot: '/writable' });
    releases[1]();
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    releases[2]();
    await vi.waitFor(() =>
      expect(mocks.completed).toEqual(['/writable', '/writable', '/writable'])
    );
    expect(mocks.reconcile).toHaveBeenCalledTimes(3);
  });

  it('detaches native arrival events and ignores a captured callback after disposal', async () => {
    mocks.folders = [{ path: '/writable', name: 'Writable' }];
    const stop = installNativeDocumentWorkspacePublisher('native-arrival-disposal');
    disposals.push(stop);
    expect(mocks.subscribeCandidates).toHaveBeenCalledOnce();
    const fire = mocks.candidates!;
    await vi.waitFor(() => expect(mocks.completed).toEqual(['/writable']));
    mocks.reconcile.mockClear();
    stop();
    expect(mocks.stopCandidates).toHaveBeenCalledOnce();
    fire({ workspaceRoot: '/writable' });
    await Promise.resolve();
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it('waits for all transferred drafts, then reconciles writable current roots outside the readiness promise', async () => {
    let finish!: () => void;
    mocks.notebookDrafts.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    mocks.folders = [
      { path: '/writable', name: 'Writable' },
      { path: '/reference', name: 'Reference', pinned: true },
    ];
    disposals.push(installNativeDocumentWorkspacePublisher('draft-transfer-load'));
    await vi.waitFor(() => expect(mocks.notebookDrafts).toHaveBeenCalledOnce());
    expect(mocks.reconcile).not.toHaveBeenCalled();
    finish();
    let ready = false;
    void (mocks.readiness.mock.calls.at(-1)![0] as Promise<void>).then(() => {
      ready = true;
    });
    await vi.waitFor(() =>
      expect(ready, 'migration cannot make renderer readiness await its own flush').toBe(true)
    );
    await vi.waitFor(() => expect(mocks.completed).toEqual(['/writable']));
    expect(mocks.reconcile).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ workspaceRoot: '/writable' })
    );
  });

  it.each(['superseded', 'disposed'] as const)(
    'does not migrate a %s root after an old enrollment resolves',
    async (state) => {
      let finish!: (value: boolean) => void;
      mocks.send.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            finish = resolve;
          })
      );
      mocks.folders = [{ path: '/old', name: 'Old' }];
      const stop = installNativeDocumentWorkspacePublisher('changing-load');
      disposals.push(stop);
      const firstReady = mocks.readiness.mock.calls.at(-1)![0] as Promise<void>;
      if (state === 'disposed') stop();
      else {
        mocks.folders = [{ path: '/current', name: 'Current' }];
        for (const listener of mocks.listeners) listener();
      }
      finish(true);
      await firstReady;
      if (state === 'superseded') {
        await vi.waitFor(() => expect(mocks.completed).toEqual(['/current']));
        expect(mocks.reconcile).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ workspaceRoot: '/current' })
        );
      } else {
        await Promise.resolve();
        expect(mocks.reconcile).not.toHaveBeenCalled();
      }
    }
  );
});
