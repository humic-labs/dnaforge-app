import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  reconcileWorkspaceAfterFilesChanged: vi.fn(),
  browserOnly: false,
}));

vi.mock('./workspace-operations', async () => {
  const { useWorkspaceStore } = await import('../stores/workspaceStore');
  return {
    reconcileWorkspaceAfterFilesChanged: mocks.reconcileWorkspaceAfterFilesChanged,
    resolveReconcileWorkspaceRoot: (root: string | null | undefined, path: string | null) => {
      const store = useWorkspaceStore.getState();
      const resolved =
        root ?? store.folders.find((folder) => path?.startsWith(`${folder.path}/`))?.path ?? null;
      if (!resolved) {
        store.bumpFileTreeRefresh();
        return null;
      }
      return mocks.browserOnly ? null : resolved;
    },
  };
});

import { useWorkspaceStore } from '../stores/workspaceStore';
import {
  installWorkspaceFilesChangedAdapter,
  WORKSPACE_FILES_CHANGED_EVENT,
  type WorkspaceFilesChangedDetail,
} from './workspace-files-changed-adapter';

const ROOT = '/Users/test/lab-workspace';

function notify(detail: WorkspaceFilesChangedDetail): void {
  window.dispatchEvent(new CustomEvent(WORKSPACE_FILES_CHANGED_EVENT, { detail }));
}

describe('workspace files-changed notification adapter', () => {
  let uninstall: (() => void) | undefined;
  let revealPath: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.browserOnly = false;
    mocks.reconcileWorkspaceAfterFilesChanged.mockResolvedValue(undefined);
    revealPath = vi.fn();
    useWorkspaceStore.setState({
      folders: [{ path: ROOT, name: 'lab-workspace', addedAt: 1 }],
      fileTreeRefreshToken: 0,
      revealPath: revealPath as unknown as (path: string) => void,
    });
    uninstall = installWorkspaceFilesChangedAdapter();
  });

  afterEach(() => {
    uninstall?.();
    useWorkspaceStore.setState({ folders: [], fileTreeRefreshToken: 0 });
  });

  it('forwards a rooted notification to the owner as a best-effort rebuild with reveal and Git status', async () => {
    notify({
      path: `${ROOT}/plasmids/pUC19.gb`,
      revealPath: `${ROOT}/plasmids/pUC19.gb`,
    });
    await vi.waitFor(() =>
      expect(mocks.reconcileWorkspaceAfterFilesChanged).toHaveBeenCalledOnce()
    );
    const input = mocks.reconcileWorkspaceAfterFilesChanged.mock.calls[0][0];
    expect(input).toMatchObject({
      workspaceRoot: ROOT,
      revealPath: `${ROOT}/plasmids/pUC19.gb`,
      notifyGitStatus: true,
    });
    expect(input.strict).toBeUndefined();
    expect(input.mutationToken).toBeUndefined();
    expect(input.assertCurrent).toBeTypeOf('function');
    expect(() => input.assertCurrent()).not.toThrow();
  });

  it('waits for every affected project before revealing the complete batch once', async () => {
    const secondRoot = '/Users/test/yeast';
    useWorkspaceStore.setState({
      folders: [
        { path: ROOT, name: 'Cloning', addedAt: 0 },
        { path: secondRoot, name: 'Yeast', addedAt: 1 },
      ],
    });
    let finishSecond!: () => void;
    mocks.reconcileWorkspaceAfterFilesChanged.mockImplementation(({ workspaceRoot }) =>
      workspaceRoot === secondRoot
        ? new Promise<void>((resolve) => {
            finishSecond = resolve;
          })
        : Promise.resolve()
    );
    const revealPaths = vi.spyOn(useWorkspaceStore.getState(), 'revealPaths');
    const paths = [`${ROOT}/imports/pUC19`, `${secondRoot}/experiments/CDC28`];
    notify({ workspaceRoot: ROOT, workspaceRoots: [ROOT, secondRoot], revealPaths: paths });
    await vi.waitFor(() =>
      expect(mocks.reconcileWorkspaceAfterFilesChanged).toHaveBeenCalledTimes(2)
    );
    expect(revealPaths).not.toHaveBeenCalled();
    finishSecond();
    await vi.waitFor(() => expect(revealPaths).toHaveBeenCalledWith(paths));
    expect(revealPaths).toHaveBeenCalledOnce();
    expect(revealPath).not.toHaveBeenCalled();
    revealPaths.mockRestore();
  });

  it('refuses late publication into a workspace that was retired mid-operation', async () => {
    notify({ workspaceRoot: ROOT });
    await vi.waitFor(() =>
      expect(mocks.reconcileWorkspaceAfterFilesChanged).toHaveBeenCalledOnce()
    );
    const { assertCurrent } = mocks.reconcileWorkspaceAfterFilesChanged.mock.calls[0][0];
    useWorkspaceStore.setState({ folders: [] });
    expect(() => assertCurrent()).toThrow(/removed during reconciliation/);
  });

  it('matches a mounted root written with a trailing separator and skips the guard for an unmounted root', async () => {
    notify({ workspaceRoot: `${ROOT}/` });
    notify({ workspaceRoot: '/Users/test/not-mounted' });
    await vi.waitFor(() =>
      expect(mocks.reconcileWorkspaceAfterFilesChanged).toHaveBeenCalledTimes(2)
    );
    const [mounted, unmounted] = mocks.reconcileWorkspaceAfterFilesChanged.mock.calls.map(
      (call) => call[0]
    );
    expect(mounted.assertCurrent).toBeTypeOf('function');
    expect(() => mounted.assertCurrent()).not.toThrow();
    expect(unmounted.workspaceRoot).toBe('/Users/test/not-mounted');
    expect(unmounted.assertCurrent).toBeUndefined();
  });

  it('only refreshes the tree when no mounted root contains the changed path', async () => {
    notify({ path: '/elsewhere/unmounted.gb' });
    expect(useWorkspaceStore.getState().fileTreeRefreshToken).toBe(1);
    await Promise.resolve();
    expect(mocks.reconcileWorkspaceAfterFilesChanged).not.toHaveBeenCalled();
  });

  it('leaves a brand-new workspace to the mount listener', async () => {
    notify({ workspaceRoot: '/Users/test/new-one', createdNewWorkspace: true });
    await Promise.resolve();
    expect(mocks.reconcileWorkspaceAfterFilesChanged).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().fileTreeRefreshToken).toBe(0);
  });

  it('does not reach the desktop-only owner in browser-only mode', async () => {
    mocks.browserOnly = true;
    notify({ workspaceRoot: ROOT });
    await Promise.resolve();
    expect(mocks.reconcileWorkspaceAfterFilesChanged).not.toHaveBeenCalled();
  });

  it('logs an owner failure and still reveals the changed path, as the former screen listener did', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.reconcileWorkspaceAfterFilesChanged.mockRejectedValueOnce(new Error('projection failed'));
    notify({ workspaceRoot: ROOT, revealPath: `${ROOT}/imported.gb` });
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        '[WorkspaceOperations] Failed to reconcile workspace root after a file change:',
        expect.any(Error)
      )
    );
    expect(revealPath).toHaveBeenCalledWith(`${ROOT}/imported.gb`);
    warn.mockRestore();
  });

  it('does not reveal into a workspace that was retired before the failed rebuild settled', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const rejection = Promise.withResolvers<void>();
    mocks.reconcileWorkspaceAfterFilesChanged.mockReturnValueOnce(rejection.promise);
    notify({ workspaceRoot: ROOT, revealPath: `${ROOT}/imported.gb` });
    await vi.waitFor(() =>
      expect(mocks.reconcileWorkspaceAfterFilesChanged).toHaveBeenCalledOnce()
    );
    useWorkspaceStore.setState({ folders: [] });
    rejection.reject(new Error('projection failed'));
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalled());
    expect(revealPath).not.toHaveBeenCalled();
  });
});
